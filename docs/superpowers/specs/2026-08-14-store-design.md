# GenieSolos Store — Design Spec

**Date:** 2026-08-14
**Status:** Approved design, pending implementation
**Owner:** Gene Garland (geniesolostech)

## Overview

A store at `geniesolos.com/store` where clients assemble a cart of GenieSolos
managed-service plans and add-ons, then pay through Stripe Checkout in a single
transaction. The site is static (S3 + CloudFront); the only server-side piece
is one AWS Lambda that creates Stripe Checkout Sessions, exposed same-origin
through the existing CloudFront distribution at `/api/checkout`.

## Goals

- Multi-item cart, one Stripe payment, one receipt.
- Visual identity: homepage energy (sunroom palette, gradient blobs, reveal
  animations, mono craft labels), with the dark terminal theme via existing tokens.
- Zero CSP changes: external CSS/JS only; the API is same-origin; the head
  theme snippet is the byte-identical hash-allowed copy (see
  `cloudfront-csp-blocks-inline` constraint in css/terms.css comments).
- Stripe checkout requires acceptance of `geniesolos.com/terms`.
- Test-mode first; live cutover is a config change, not a code change.

## Non-goals

- No webhooks / automated fulfillment (services are fulfilled manually).
- No self-serve seat-overage purchasing (per-user overage is billed by monthly
  review per the terms).
- No Stripe-enforced 12-month schedules; term commitment is contractual.
- No customer accounts on the site; Stripe hosts checkout and the billing portal.

## Catalog

Product keys are the API contract between `js/store.js` and the Lambda. The
client sends only `{key, qty}`; prices live exclusively in Stripe, mapped
server-side.

| Key | Product | Price | Kind | Cart rules |
|---|---|---|---|---|
| `lifeline` | Lifeline plan | $299/mo | recurring | base plan, exclusive |
| `presence` | Presence plan | $649/mo | recurring | base plan, exclusive |
| `transformation` | Transformation plan | $999/mo | recurring | base plan, exclusive; card flags 12-mo term |
| `storefront-zero` | Storefront (zero-down) | $499/mo | recurring | base plan, exclusive; card flags 12-mo term |
| `storefront-build` | Storefront (build + care) | $4,500 once + $149/mo | one-time + recurring | base plan, exclusive |
| `server-care` | Server Care | $225/mo each | recurring, qty 1–20 | requires any base plan |
| `db-care` | Database Care | $175/mo each | recurring, qty 1–20 | requires any base plan |
| `workspace-admin` | Workspace Admin | $199/mo | recurring | requires a Storefront base plan |

Non-purchasable cards (same design, "Email me for a quote" CTA via mailto):
Migration projects; Microsoft 365 / Google Workspace licenses.

"Exclusive" = at most one base plan in the cart; adding another replaces it
with a toast ("Replaced Lifeline with Presence"). Add-on buttons are disabled
with a hint until their prerequisite is in the cart. The Lambda re-validates
all rules; the client rules are UX only.

## Store page (`store.html`, `css/store.css`, `js/store.js`)

- Same fixed nav as terms.html (brand mark → home, theme toggle) plus a link
  to `/terms`. Head theme snippet byte-identical to index.html (CSP hash).
- Hero: mono eyebrow (`GENIESOLOS STORE`), Fraunces headline with gradient em,
  one-line pitch, gradient blob backdrop.
- Sections: Plans (3 tier cards) → Storefront (2 cards) → Add-ons (3 cards
  with qty steppers where applicable) → Quoted work (2 contact cards).
  Reveal-on-scroll animations, respectful of `prefers-reduced-motion`.
- Cards: paper surface, shadow tokens, price in JetBrains Mono, feature list
  drawn from terms.html content, "Add to cart" button with a satisfying
  micro-interaction; deep link to the relevant `/terms` section.
- Cart: floating button (item-count badge) opening a slide-over drawer.
  Line items with qty steppers/remove, subtotal split into "monthly" and
  "due today" (one-time), terms note, Checkout button.
- Cart state in `localStorage` key `gs-cart` (versioned JSON `{v:1, items:[]}`).
- Return states read from query string: `?checkout=success` → clear cart, show
  confirmation panel (what happens next + contact); `?checkout=cancelled` →
  keep cart, show "no charge was made" note. Both replace the URL via
  `history.replaceState` so refresh doesn't repeat the message.

## Checkout API

`POST /api/checkout` (same origin, fetch from js/store.js)

Request: `{ "items": [ { "key": "presence", "qty": 1 }, ... ] }`

Validation (server-side, authoritative): known keys; integer qty 1–20 (qty 1
forced for non-quantity items); exactly one base plan; `workspace-admin` only
with a Storefront base; reject empty carts. Errors → `400 {"error": "..."}`;
the drawer shows the message.

Success → `200 {"url": "https://checkout.stripe.com/..."}`; client navigates.

Lambda (Node.js 22, zero dependencies, calls Stripe REST via fetch with
form-encoded bodies):

- `mode=subscription`; all recurring prices are monthly so they share one
  subscription; `storefront-build`'s $4,500 rides as a one-time line item.
- `success_url=https://geniesolos.com/store?checkout=success`
  `cancel_url=https://geniesolos.com/store?checkout=cancelled`
- `consent_collection[terms_of_service]=required` (Stripe dashboard must have
  the ToS URL set to `https://geniesolos.com/terms`).
- `billing_address_collection=auto`, `allow_promotion_codes=true`.
- Env config: `STRIPE_SECRET_KEY`, `PRICE_MAP` (JSON `key→price_id`),
  `ALLOWED_ORIGIN=https://geniesolos.com` (basic Origin check; OAC is the
  real gate). 10s timeout on the Stripe call; 502 with a friendly error on
  failure. Never logs the secret; logs session IDs only.

## Infrastructure

- Lambda `geniesolos-checkout` + execution role (logs-only policy).
- Lambda function URL, auth type `AWS_IAM`, fronted by a CloudFront **Origin
  Access Control** so only the distribution can invoke it.
- New behavior on distribution `E13HIX0DOKUMO1`: path `/api/*` → that origin,
  POST allowed, caching disabled, origin request policy forwarding body.
- CSP, bucket, and existing behaviors untouched.

## Repo & deploy changes

- New: `store.html`, `css/store.css`, `js/store.js`, `api/checkout/index.mjs`
  (+ small README), `scripts/setup-stripe.ps1`, `scripts/setup-aws.ps1`,
  this spec.
- `scripts/setup-stripe.ps1`: prompts for a Stripe key (never stored in repo),
  creates/reconciles the 8 products + prices **by product name**, prints and
  saves the price map JSON to a git-ignored file. Same script for test & live.
- `scripts/setup-aws.ps1`: idempotent creation of role, Lambda, function URL,
  OAC, CloudFront behavior; `-PriceMapPath` and key prompt update Lambda env.
- Deployers (`deploy.yml` + `deploy.ps1`): add `store.html` to the HTML list
  and an extensionless `store` object (same pattern as `terms`). Sync
  whitelist already covers css/js; `api/`, `docs/`, `scripts/` stay excluded
  by default-deny.
- `index.html`: `Store` in nav links and footer; sitemap gains `/store`;
  terms.html nav gains a Store link; `?v=` bumps where css/js change.

## Rollout

1. **Build + test mode:** run setup-stripe with the test key, setup-aws with
   test env; deploy the page; verify end-to-end with card `4242 4242 4242 4242`
   (success, cancel, decline `4000 0000 0000 0002`, add-on rules, both themes,
   mobile, reduced motion).
2. **Live cutover:** run setup-stripe with the live key (reconciles the
   partially-existing live products), update Lambda env to live key + live
   price map. Set the ToS URL in the live Stripe dashboard. Optional real
   purchase + refund as a smoke test.
3. Stripe dashboard settings to confirm (runbook in api/README): branding
   (icon/logo/colors from brand/), customer emails for successful payments,
   billing portal enabled for self-serve cancellation.

## Risks / notes

- CloudFront distribution edits are global config; setup-aws.ps1 fetches the
  current config, patches only the new behavior, and shows a diff before
  applying (same care as the deploy script's drift checks).
- OAC for Lambda URLs requires sigv4; if the AWS CLI version on this machine
  lacks it, fallback is auth NONE + a shared secret header injected by
  CloudFront origin custom headers and checked in the Lambda.
- If a future page needs Stripe.js embedded (not planned), the CSP response
  headers policy must change; current design avoids that entirely.
