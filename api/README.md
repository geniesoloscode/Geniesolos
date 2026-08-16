# api/: the checkout Lambda

`checkout/index.mjs` and `webhook/index.mjs` (see "Order notifications" below) are the
only server-side code on geniesolos.com. Everything else is static files on S3 behind
CloudFront. The function takes a cart from the store drawer,
revalidates it, creates a Stripe Checkout Session **in setup mode** and returns the URL
the browser navigates to. Setup mode saves the customer's card and charges **nothing**;
the owner reviews each order and starts billing by hand from the dashboard. See
"Approving an order" below.

One file, zero dependencies, Node.js 22 ESM. There is no `package.json` and no build
step: the deploy zips this single file.

```
POST https://geniesolos.com/api/checkout
{ "items": [ { "key": "storefront-build", "qty": 1 }, { "key": "server-care", "qty": 3 } ],
  "phone": "+1 (240) 321-9004",
  "termsAccepted": true, "termsVersion": "2026-08" }

200 { "url": "https://checkout.stripe.com/c/pay/cs_live_..." }
400 { "error": "Pick one plan, not several." }        cart the customer can fix
400 { "error": "Add a phone number so I can reach you before billing starts." }
400 { "error": "Agree to the Service Terms before checking out." }
       (the drawer also refuses locally, before this, until the terms link is opened)
400 { "error": "Your page is out of date. Reload the store ..." }   stale terms version
403 { "error": "Checkout only answers requests from https://geniesolos.com." }
405 { "error": "Use POST to start checkout." }
500 { "error": "Payment setup failed. ..." }          our misconfiguration
502 { "error": "Payment setup failed. ..." }          Stripe was unreachable or refused
```

## Why the drawer collects the phone

The owner calls every customer before billing starts, so checkout must not finish
without a number. Stripe cannot ask for it in setup mode; both of its collection
features were tried against the real test-mode API on 2026-08-15 and rejected:

- `phone_number_collection[enabled]=true`: **"You can only enable phone number
  collection in payment and subscription mode."**
- `custom_fields`: **"&#96;custom_fields&#96; is not supported when
  &#96;mode=setup&#96;."** (the backticks are Stripe's own)

So the cart drawer has its own labeled `tel` input, `js/store.js` validates it and
sends it as `phone` beside `items`, and this function stores it in the session and
SetupIntent metadata (see "Session parameters").

`phone` is required: a string that, after trimming and stripping the separators
people type (spaces, `(`, `)`, `-`, `.`, `+`), leaves 7 to 15 digits. Anything else
is the 400 above, with the same words the drawer shows. Validation order is cart
rules first, then the phone; the tests pin that order. What is stored is the
trimmed original as the customer wrote it, never the bare digit string, capped at
40 characters.

## `x-amz-content-sha256` is required on every POST

The function URL is reachable only through CloudFront, whose origin access control signs
each request to it with sigv4. OAC signs the headers it forwards; it does **not** hash the
request body, and Lambda function URLs reject `UNSIGNED-PAYLOAD`. So the *viewer* has to
supply the payload hash:

```
x-amz-content-sha256: <lowercase hex SHA-256 of the exact request body bytes>
```

A POST without it is a **403 from AWS** that never reaches `index.mjs`, so it carries none
of the JSON errors above. The store page does this for you: `checkout()` in `js/store.js`
digests the exact body string with `crypto.subtle.digest('SHA-256', ...)` and sets the
header before `fetch`. Anything hand-rolled must send it too.

```bash
BODY='{"items":[{"key":"storefront-build","qty":1}]}'
curl -sS https://geniesolos.com/api/checkout \
  -H 'content-type: application/json' \
  -H "x-amz-content-sha256: $(printf %s "$BODY" | openssl dgst -sha256 -r | cut -d' ' -f1)" \
  -d "$BODY"
```

The empty body's hash is the constant
`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`, which is what the
smoke tests in `scripts/setup-aws.ps1` send. Hash the bytes you actually send: a body and a
header that disagree fail the same way as a missing header.

The client never sends prices, and this function never reads them from the request. Only
`key` and `qty` are taken from each item, plus the top-level `phone`; every other field,
at the top level or inside an item, is dropped. Amounts live in Stripe. `PRICE_MAP` is still validated (a cart key it
cannot serve is a 500 before Stripe is called) but nothing from it is sent: in setup mode
no price is involved until the owner bills.

## Environment

| Variable | Value | Notes |
|---|---|---|
| `STRIPE_SECRET_KEY` | `sk_test_...` / `sk_live_...` | Travels only in the `Authorization` header. Never logged. |
| `PRICE_MAP` | JSON `{ "key": ["price_id", ...] }` | One entry per catalog key. `storefront-build` has **two** IDs: **recurring first, one-time second**. Validated on every request so catalog drift fails loudly, but never sent to Stripe; these are the IDs the owner bills with in the dashboard. |
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
- after the cart passes, `phone` must trim and strip to 7 to 15 digits (see "Why the
  drawer collects the phone")
- after the phone passes, `termsAccepted` must be boolean `true` and `termsVersion`
  must equal `CURRENT_TERMS_VERSION` (see "Clickwrap consent")

Cart rules first, then the phone, then consent. The tests pin that order, because the
drawer surfaces problems in the same sequence and a customer should only ever be told
about the next thing they can fix.

The catalog is duplicated here rather than imported. That is deliberate: the function
ships alone. Prices are not duplicated, because Stripe holds them.

## Clickwrap consent

Month-to-month clients never sign the Master Service Agreement, so the ticked box in
the drawer is the entire agreement. It is only evidence if we can say **which document**
was agreed to, **when**, and **from where**, and if none of that came from the party it
would be used against.

So the split is: the browser asserts the tick and names the version it displayed; the
handler observes everything else.

| Field | Source | Notes |
|---|---|---|
| `termsAccepted` | client | Must be boolean `true`. `'true'`, `1` and `'on'` are refused: a checkbox hands over a real boolean, so anything else came from storage, an attribute, or a hand-built body. |
| `termsVersion` | client | Must equal `CURRENT_TERMS_VERSION`. A mismatch is a 400, never a silent accept, because it means the visitor was shown a page that is not the one live now. |
| document hash | **handler** | `TERMS_DOC_SHA256`, the SHA-256 of `terms/v<version>.html`. See below. |
| timestamp | **handler** | `new Date().toISOString()`. A client-supplied one is ignored, not echoed. |
| IP | **handler** | `event.requestContext.http.sourceIp`, or `(unavailable)` when absent. |
| user agent | **handler** | Request header, truncated to 500 chars, or `(none sent)`. Truncated rather than refused: a clipped agent is still useful and the visitor cannot change their browser's header. |

**Why the hash.** Naming a version only helps if everyone agrees what that version said, which is a claim about this repository. The fingerprint removes that dependency: a copy of the document produced years later either hashes to what Stripe recorded at the moment of consent or it is not the document that was agreed to. It is derived server side from a constant, never sent by the browser, so it sits with the timestamp and the IP among the fields the customer had no hand in.

The constant is pinned rather than computed because this function ships as its own zip and cannot read the archive at runtime. `.gitattributes` sets `* text=auto eol=lf`, so the bytes are identical on a Windows checkout, on the Linux CI runner and in what CloudFront serves — verified against the live URL. `tests/terms-version.test.mjs` recomputes the hash from the file on every run.

**The drawer also gates the box on the link.** The checkbox ships `disabled` in `store.html` and `js/store.js` enables it only once the Service Terms link has been opened, so nobody can agree to a document that was never put in front of them. Two things follow:

- **Nothing about the gate is sent here, and nothing is recorded.** The server cannot verify that a link was opened, and a field it cannot check would be the only soft claim in a record whose whole value is that every other field is either observed or validated. Worse, recording it would mean writing down a `false` for every customer who did not open it — evidence against ourselves, produced at scale. What the gate leaves behind is the page itself, which is in git and deployed from it.
- **It is a client-side affordance, not a security control.** A hand-built request bypasses it, exactly as it bypasses the drawer entirely. The server-side story is unchanged: `termsAccepted === true` and a known `termsVersion`.

A locked box refuses checkout with its own wording, *"Open the Service Terms first, then tick the box to agree."*, which has no counterpart here because it never reaches the server. Opening the terms from the context menu fires no click event, so the gate stays shut; that is why the refusal says what to do rather than leaving a dead end.

**One version string, four places.** `TERMS_VERSION` in `js/store-cart.js` is where the
browser reads it. `CURRENT_TERMS_VERSION` here is the copy this function ships with.
The plate in `terms.html` carries it, and `terms/v<version>.html` is the immutable copy
of the document itself. Nothing imports anything, the same way the catalog is
duplicated, so `tests/terms-version.test.mjs` fails the build if any of them drift, and
it also compares the archived copy against `terms.html` word for word.

**Cutting a new version** — the only correct way to change the terms:

1. Edit `terms.html`.
2. Bump `TERMS_VERSION` in `js/store-cart.js` and `CURRENT_TERMS_VERSION` here.
3. Update the plate's `GS-SERVICE-TERMS v...` line in `terms.html`.
4. `cp terms.html terms/v<new>.html`, then in the copy: make the asset paths
   root-relative, set the canonical and the archive notice to the new version, and keep
   `noindex`.
5. Update `TERMS_DOC_SHA256` here to the hash of the file you just cut:
   `sha256sum terms/v<new>.html`. Do this **last**, after the copy is final — any later
   edit to it, down to a comment, changes the hash.
6. Run the tests. `tests/terms-version.test.mjs` is what tells you whether you missed a
   step; it prints the expected hash when that is the one you missed.

Never edit a file under `terms/`. Customers have already agreed to those words.

The archive ships because `terms/*` is on the sync whitelist in **both**
`scripts/deploy.ps1` and `.github/workflows/deploy.yml`; deployment is default-deny, so
a new directory that is not listed there exists in the repo and nowhere else.

## Session parameters

`mode=setup`: no line items, no charge. Stripe saves the card, attaches it to a new
Customer, and the order travels in the session metadata for the approval runbook. Every
parameter below was verified against the real test-mode API on 2026-08-15.

| Parameter | Value | Why |
|---|---|---|
| `mode` | `setup` | Save the card, charge nothing. |
| `currency` | `usd` | Required by the API in setup mode, even with no amount. |
| `customer_creation` | `always` | One Customer per order to bill or delete. |
| `success_url` | `https://geniesolos.com/store?checkout=success` | Unchanged. |
| `cancel_url` | `https://geniesolos.com/store?checkout=cancelled` | Unchanged. |
| `consent_collection[terms_of_service]` | `required` | Supported in setup mode; needs the ToS URL from the dashboard runbook. |
| `managed_payments[enabled]` | `false` | Managed Payments rejects `mode=setup` outright ("Invalid mode: setup"). |
| `metadata[order]` | e.g. `lifeline x1, server-care x3` | Human summary of the order. |
| `metadata[order_json]` | compact JSON of `{key, qty}` lines | Exact order. Metadata values cap at 500 chars; a 10 line cart fits. |
| `metadata[phone]` | the trimmed `phone` from the request, first 40 chars | The number the drawer collected, as the customer wrote it. The webhook email reads it from here. |
| `setup_intent_data[metadata][order]` | same string as `metadata[order]` | Puts the order text on the SetupIntent itself, so the dashboard customer view shows it without opening the session. Verified against the real test-mode API on 2026-08-15. |
| `setup_intent_data[metadata][phone]` | same string as `metadata[phone]` | The phone on the SetupIntent too, same reason. |
| `metadata[terms_version]` | e.g. `2026-08` | Which document was agreed to. `terms/v2026-08.html` is that document. |
| `metadata[terms_doc_sha256]` | 64 hex chars | SHA-256 of that document's exact bytes. Server side, from `TERMS_DOC_SHA256`. |
| `metadata[terms_accepted_at]` | ISO 8601 UTC | Generated in the handler. Never read from the request body. |
| `metadata[terms_accepted_ip]` | e.g. `198.51.100.7` | From `requestContext.http.sourceIp`, or `(unavailable)`. |
| `metadata[terms_user_agent]` | request header, first 500 chars | Or `(none sent)`. |
| `setup_intent_data[metadata][terms_*]` | same four values | Written in the same pass as the session copy, so the two cannot drift. |

Eight metadata keys on the session and seven on the SetupIntent, well inside Stripe's
limit of 50 per object, and every value inside the 500-character cap. The consent
record is five separate keys rather than one packed JSON blob so each reads on its own
in the dashboard.

The Stripe call is form encoded, over `fetch`, with a 10 second `AbortSignal.timeout`.

Logs carry the session ID and Stripe's error message. They never carry the secret key or
customer details.

## Order notifications

`webhook/index.mjs` is a second, separate Lambda whose only job is to email the owner
the moment an order completes:

```
Stripe -> webhook Lambda (public function URL) -> signature check -> SNS topic -> email
```

Stripe POSTs the `checkout.session.completed` event straight to the function URL. The
handler verifies the `Stripe-Signature` header (HMAC-SHA256 of `<t>.<raw body>` with the
endpoint's `whsec_` secret, every `v1` entry compared timing-safe, timestamps more than
300 seconds off rejected), then publishes a plain-text order summary to an SNS topic.
The topic's confirmed email subscription is what lands in the inbox: the order lines,
the customer's name, email and phone (from `metadata[phone]`, the number the drawer
collected, falling back to Stripe's `customer_details.phone`, then "(none given)"),
and a deep link to the customer in the dashboard. Prices are never in the email; they live in Stripe. Any
other verified event type is answered `200 {"received":true}` and dropped. An SNS
failure returns 500 on purpose, because Stripe retries failed deliveries.

**Why this bypasses CloudFront.** Every POST through the CloudFront OAC path must carry
`x-amz-content-sha256` (see above), and Stripe's webhook sender cannot be told to add
that header. So this Lambda has its own PUBLIC function URL outside CloudFront, and its
front door is the webhook signature instead: a request not signed with this endpoint's
secret is a terse 400 that touches nothing.

### Environment

| Variable | Value | Notes |
|---|---|---|
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` | Signing secret of the webhook endpoint (dashboard, Developers -> Webhooks). Never logged. |
| `ORDERS_TOPIC_ARN` | `arn:aws:sns:...` | SNS topic with a confirmed email subscription to the owner's inbox. |

Test and live mode are TWO webhook endpoints in Stripe with TWO different signing
secrets. The `whsec_` in this Lambda's env must match the mode of the events sent to
it; a live event arriving at a function holding the test secret is a 400, not an email.

### If the emails stop

1. **Is the SNS subscription still confirmed?** SNS console -> the topic ->
   Subscriptions. A deleted or unconfirmed email subscription publishes into the void
   with no error anywhere.
2. **Does the signing secret still match?** Rolling the secret in the Stripe dashboard
   silently turns every delivery into a 400 until `STRIPE_WEBHOOK_SECRET` is updated
   to the new value.
3. **What does Stripe see?** Dashboard -> Developers -> Webhooks -> the endpoint lists
   every delivery attempt with status codes and pending retries. A wall of 400s is the
   secret; 500s are SNS (CloudWatch logs will show `sns publish failed`); no attempts
   at all means the endpoint URL or its subscribed event types are wrong.

## Approving an order

Checkout now ends with a saved card and an open order, not a payment. Each completed
session leaves one new Customer in Stripe. Nothing bills until you act.

**1. Find the order.** Dashboard, Customers, newest first. The saved card is on the
customer page under **Payment methods**. The order is in the Checkout Session's metadata:
`metadata[order]` is the human summary (`lifeline x1, server-care x3`) and
`metadata[order_json]` the exact `{key, qty}` lines. Read it from the
`checkout.session.completed` event listed on the customer page (Events, at the bottom),
or from the CLI: `stripe checkout sessions list --limit 5`.

The same metadata carries the consent record: `metadata[terms_version]`,
`terms_doc_sha256`, `terms_accepted_at`, `terms_accepted_ip` and `terms_user_agent`. The
order email repeats all five. That record plus `terms/v<version>.html` is the whole
agreement for a month-to-month client who never signed an MSA, so if you ever have to
produce it, those two things together are what you send.

**Proving the document is the right one.** Download the archive and hash it; it must
equal the `terms_doc_sha256` on that customer's session:

```bash
curl -s https://geniesolos.com/terms/v2026-08.html | sha256sum
# 9fe0494dbbba9f098c4f1fda3d5800e531972450399b307515a4eb7ae126bec7
```

Anyone can run that check against a copy you hand them, which is the point: it does not
require trusting you, this repository, or the archive still being online. A completed session with no consent fields
predates this feature (the email says `Terms accepted: (no record)`); that customer
agreed to nothing in writing and should be asked to before service continues.

**2. Approve: create the subscription by hand.** On the customer page choose **Create
subscription**:

- Add one subscription line per order key, with the order's quantity, using the price IDs
  from `scripts/price-map.<mode>.json` (the same map the Lambda validated).
- A `storefront-build` order also owes the one-time $4,500 build fee: while creating the
  subscription, add it as a one-time invoice item using the one-time price (the second ID
  under `storefront-build` in the map).
- Bill the saved card; it is the customer's only payment method, so make it the default.
- The receipt comes from Stripe's customer emails (dashboard runbook item 3).

If the dashboard blocks the subscription on missing product tax codes, that is Managed
Payments applying to dashboard billing. Either disable Managed Payments for that
subscription, or add eligible tax codes to all eight products. The Lambda is unaffected
either way: in setup mode there is no payment, and the session already opts out because
Managed Payments does not support `mode=setup` at all.

**3. Decline.** Email the customer from geniesolostech@gmail.com that the order was not
accepted and nothing was charged (no email is automatic), then **delete the customer**,
which discards the saved card.

**4. Keep the promises.** The ToS consent checkbox on Checkout and the no-charge promise
("your card is saved, nothing is charged until your order is approved") are part of the
store UI and the terms page. If this approval flow changes, change that copy too.

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

`tests/terms-version.test.mjs` is the one to watch when editing the service terms: it
pins the version string across `js/store-cart.js`, `api/checkout/index.mjs`, `terms.html`
and `terms/`, checks the archived copy still matches the live document word for word,
and checks both deploy paths still publish the archive.

---

## Two lessons the first deployment paid for (2026-08-15)

**1. New function URLs need TWO permissions.** Function URLs created after
October 2025 authorize `lambda:InvokeFunctionUrl` at the front door AND
`lambda:InvokeFunction` at invocation. Granting only the first produces
`403 AccessDeniedException` on every CloudFront request while direct
same-account signed calls still work (identity permissions cover them),
which points the investigation everywhere except the real cause.
setup-aws.ps1 grants both.

**2. Stripe Managed Payments is on by default for this account.** In the
original subscription-mode flow it rejected sessions whose products lack a
`tax_code`; since the move to setup mode it rejects the session earlier and
harder ("Invalid mode: setup. Managed Payments ... only supports mode:
subscription or mode: payment"). Either way the Lambda must pass
`managed_payments[enabled]=false` on every session. Managed Payments can
still apply to the subscriptions created by hand in the dashboard; see
"Approving an order" for what to do when it blocks on tax codes.
