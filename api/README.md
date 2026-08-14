# api/: the checkout Lambda

`checkout/index.mjs` is the only server-side code on geniesolos.com. Everything else is
static files on S3 behind CloudFront. The function takes a cart from the store drawer,
revalidates it, creates a Stripe Checkout Session and returns the URL the browser
navigates to.

One file, zero dependencies, Node.js 22 ESM. There is no `package.json` and no build
step: the deploy zips this single file.

```
POST https://geniesolos.com/api/checkout
{ "items": [ { "key": "storefront-build", "qty": 1 }, { "key": "server-care", "qty": 3 } ] }

200 { "url": "https://checkout.stripe.com/c/pay/cs_live_..." }
400 { "error": "Pick one plan, not several." }        cart the customer can fix
403 { "error": "Checkout only answers requests from https://geniesolos.com." }
405 { "error": "Use POST to start checkout." }
500 { "error": "Payment setup failed. ..." }          our misconfiguration
502 { "error": "Payment setup failed. ..." }          Stripe was unreachable or refused
```

The client never sends prices, and this function never reads them from the request. Only
`key` and `qty` are taken from each item; every other field, at the top level or inside an
item, is dropped. Amounts live in Stripe and are reached through `PRICE_MAP` alone.

## Environment

| Variable | Value | Notes |
|---|---|---|
| `STRIPE_SECRET_KEY` | `sk_test_...` / `sk_live_...` | Travels only in the `Authorization` header. Never logged. |
| `PRICE_MAP` | JSON `{ "key": ["price_id", ...] }` | One entry per catalog key. `storefront-build` has **two** IDs: **recurring first, one-time second**. |
| `ALLOWED_ORIGIN` | `https://geniesolos.com` | Origin check. Requests with no `Origin` header pass, because the signed CloudFront origin access is the real gate. |

Read on every invocation, not at cold start, so a console edit takes effect immediately.
`scripts/setup-aws.ps1` writes all three; `scripts/price-map.<mode>.json` holds the map.

## Validation

Mirrors `GSCart.validate` in `js/store-cart.js` word for word. Anything the drawer
refuses, this refuses, with the same message.

- 1 to 10 lines, no key twice
- known keys only: `lifeline`, `presence`, `transformation`, `storefront-zero`,
  `storefront-build`, `server-care`, `db-care`, `workspace-admin`
- exactly one base plan (the first five)
- `workspace-admin` only alongside a Storefront base
- `qty` is a whole number, 1 to 20 for `server-care` and `db-care`, exactly 1 for
  everything else

The catalog is duplicated here rather than imported. That is deliberate: the function
ships alone. Prices are not duplicated, because Stripe holds them.

## Session parameters

`mode=subscription` (every plan is monthly, so one subscription covers the cart, and
`storefront-build`'s one-time build fee rides along as a second line item),
`success_url=https://geniesolos.com/store?checkout=success`,
`cancel_url=https://geniesolos.com/store?checkout=cancelled`,
`consent_collection[terms_of_service]=required`, `billing_address_collection=auto`,
`allow_promotion_codes=true`. The Stripe call is form encoded, over `fetch`, with a
10 second `AbortSignal.timeout`.

Logs carry the session ID and Stripe's error message. They never carry the secret key or
customer details.

## Stripe dashboard runbook

Four settings that this function depends on or that customers see. Confirm them in **both**
test and live mode; dashboard settings do not carry across.

**1. Terms of service URL (required, or checkout breaks).**
`consent_collection[terms_of_service]=required` fails with an error unless Stripe has a ToS
URL on file. Settings → Business → Public details (`dashboard.stripe.com/settings/public`):
set **Terms of service** to `https://geniesolos.com/terms`. Also set the privacy policy URL
if it is blank. Without this the session is never created and the customer sees the 502.

**2. Branding.** Settings → Branding (`dashboard.stripe.com/settings/branding`), files from
`brand/`:

| Field | Value |
|---|---|
| Icon | `brand/stripe-icon-512.png` |
| Logo | `brand/stripe-logo-1024x208.png` |
| Brand color | `#7C3AED` |
| Accent color | `#FAF5EC` |

The icon appears on every Stripe surface; the logo only overrides it on Checkout and
invoice PDFs. See `brand/README.md` for why those two colors.

**3. Customer emails for successful payments.** Settings → Customer emails
(`dashboard.stripe.com/settings/emails`): turn on **Successful payments**, and
**Refunds** while you are there. This is the only receipt a customer gets; the site sends
no email of its own.

**4. Billing portal.** Settings → Billing → Customer portal
(`dashboard.stripe.com/settings/billing/portal`): activate the portal and allow customers
to **cancel subscriptions** and **update payment methods**. Cancellation is self-serve by
design, which is what the terms page promises. Link customers to the portal from the
address in their receipt.

## Tests

```
node --test "tests/*.test.mjs"
```

`tests/checkout.test.mjs` stubs `globalThis.fetch`, so it exercises the real handler and
asserts on the exact parameters sent to Stripe. Nothing reaches the network.
