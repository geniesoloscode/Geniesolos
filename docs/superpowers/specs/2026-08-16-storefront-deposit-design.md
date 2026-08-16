# Storefront build fee, split into deposit and balance — Design Spec

**Date:** 2026-08-16
**Status:** Awaiting review
**Owner:** Gene Garland (geniesolostech)
**Branch:** `storefront-deposit` (nothing reaches the site until this is merged)

## Overview

Storefront (build + care) currently sells as **$4,500 once, then $149/month**.
This changes it to **$2,250 deposit, $2,250 on completion, then $149/month**,
with monthly billing starting only when the build is delivered.

Nothing else in the catalog changes. The checkout Lambda is not modified.

## Decisions taken

Answered before design, recorded here so the reasoning survives:

| Question | Decision |
|---|---|
| When is the deposit charged? | **Keep the approval gate.** Checkout still saves the card and charges nothing; the deposit is invoiced by hand after the review call. |
| When does $149/month start? | **On completion**, billed with the balance. Nothing monthly during the build. |
| Deposit if the client cancels mid-build? | **Non-refundable once work starts.** No further amount owed, no ownership transfer. |
| Card headline? | **Lead with "$2,250 to start"**, full $4,500 stated immediately beneath. |
| Terms version? | **v2026-09**, shipped now, effective on the subscriber's own subscribe date. |
| Existing orders? | **None.** No grandfathering, no migration. |
| Stripe price shape? | **Option B** — distinct deposit and balance prices. |

**Why B, recorded because it cost more than A:** distinct price IDs make
"which customers have paid a deposit but not a balance" a query rather than a
reading exercise. Stripe's `nickname` is hidden from customers, so B does *not*
self-label invoices — descriptions are typed per invoice item under either
option. B is chosen for the reporting handle, not the labelling.

## Non-goals

- No change to pricing, rules, or copy for any other plan.
- No change to `mode=setup`, the approval gate, or the checkout Lambda.
- No automation of the build-completion milestone. It stays a human step.
- No grandfathering logic. There is nobody to grandfather.

## 1. Catalog and totals — `js/store-cart.js`

`storefront-build` gains a `deposit`, with the balance always derived so the
two halves cannot drift:

```js
'storefront-build': { name: 'Storefront (build + care)', monthly: 14900,
                      once: 450000, deposit: 225000,
                      kind: 'storefront-base', maxQty: 1 }
```

`totals(items)` returns `{ monthly, once, deposit }`. Products without a split
report `deposit === once`, so the rule is uniform and nothing special-cases
this one key. Balance is `once - deposit` at the point of display.

`storefront-build` is the only product with `once > 0`, so in practice the
split rows appear for it alone.

## 2. Drawer — `js/store.js`, `css/store.css`, `store.html`

The single "One-time, after approval" row becomes two, each hidden at zero:

```
Monthly, after the build      $149
Due at approval             $2,250
Due on completion           $2,250
```

The monthly label reads **"after the build"** whenever a split product is in
the cart, and stays **"after approval"** otherwise. Add-ons ride the same
subscription, so when a Storefront build is present they also start at
completion — the label has to tell the truth for the whole cart, not just one
line.

The cart line's meta changes from `$4,500 one-time` to
`$2,250 deposit · $2,250 on completion`.

## 3. Store card — `store.html`

| | Now | After |
|---|---|---|
| badge | `One-time $4,500` | `$2,250 to start` |
| price | **$4,500** once, then $149/month | **$2,250** deposit, then $2,250 on completion, then $149/month |
| meta | Month-to-month after the build | $4,500 build total · month-to-month after |
| bullet 1 | One-time build fee, billed with your first month | Half the build fee to start, half on completion |
| bullet 4 | Website ownership transfers when the build fee is paid in full | unchanged — still accurate |

Bullet 1 is factually wrong under the new model and must change; the others
stand.

## 4. Terms — cut v2026-09

`terms.html` is edited, then copied to `terms/v2026-09.html` as the new
immutable archive. `v2026-08` stays served forever for everyone who consented
to it. `TERMS_VERSION`, `CURRENT_TERMS_VERSION` and `TERMS_DOC_SHA256` move
together; `tests/terms-version.test.mjs` is what proves none was missed.

Proposed wording, for review before it goes near the document:

### §01 Plans and pricing — table row

> Storefront (build + care) — **$2,250 deposit, $2,250 on completion, then $149**

### §04 Billing — new paragraph

> **Storefront build milestones.** The $4,500 build fee for Storefront
> (build + care) is billed in two equal parts: $2,250 when we confirm your
> order and begin work, and $2,250 when the build is complete and delivered to
> you. Monthly fees for this plan begin on completion and are billed with the
> second part. You are not billed monthly while the build is in progress.

### §05 Cancellation and refunds — new paragraph

> **The Storefront build deposit.** The first $2,250 is non-refundable once we
> begin work. It reserves your build slot and pays for work performed before
> completion. If you cancel before the build is complete, you owe nothing
> further: the second $2,250 does not become due, no monthly fees have begun,
> and ownership of the website does not transfer.

### §05 — the "In short" note, amended

> **In short:** setup fees and completed one-time project work are
> non-refundable once the work is delivered, and the Storefront build deposit
> is non-refundable once work begins.

*(Current text folds the build fee into the "once delivered" rule. A deposit is
taken before delivery, so it needs its own clause or the two contradict.)*

### §06 Ownership — one clarifying clause

> For Storefront build + care, ownership transfers when the build fee is paid
> in full, **meaning both parts of the $4,500 build fee**.

### Plate — needs your call

Document becomes `GS-SERVICE-TERMS v2026-09`. The **Revised** field is the
awkward part, and §13 of the terms promises that "each version carries a
version identifier and effective date", so it cannot just be fudged:

- **`August 2026` (proposed).** Truthful — that is when it was revised and when
  it goes live. Every statement in the document stays true; the only oddity is
  an identifier naming a later month, which you accepted knowingly.
- **`September 2026`.** Matches the identifier, but puts a future revision date
  on a document being served in August. A document that misstates its own date
  is a bad document to produce as evidence.

Proposing **August 2026**. Say if you want it the other way.

## 5. Stripe — option B

### Price shape

```
storefront-build: [ recurring_149, deposit_2250, balance_2250 ]
```

`setup-stripe.ps1`'s catalog entry becomes three prices, the two one-time ones
carrying nicknames:

```powershell
@{ Key = 'storefront-build'; Name = 'GenieSolos Storefront (build + care)'; Prices = @(
     @{ Amount = 14900;  Recurring = $true }
     @{ Amount = 225000; Recurring = $false; Nickname = 'Storefront build deposit (1 of 2)' }
     @{ Amount = 225000; Recurring = $false; Nickname = 'Storefront build balance (2 of 2)' }
) }
```

### The reconciliation hazard, and the fix

`Get-OrCreatePrice` currently matches on **amount + currency + cadence**. Two
one-time prices at $2,250 are indistinguishable to it: the second lookup would
find the first and write the same ID twice.

Naively adding nickname to the match rule breaks the *existing* prices, which
all have `nickname: null` — the $149 recurring price would stop matching itself
and be duplicated on the next run. So the comparison must treat absent as
equal to absent:

```powershell
[string]$_.nickname -eq [string]$Nickname
```

Both sides coerce, so a spec with no nickname still matches today's
null-nickname prices, exactly as it does now, while the two $2,250 prices stay
distinct from each other.

Idempotency is **proved by running the script twice** and diffing the emitted
price map, not asserted.

### The old $4,500 price

It stays active and unreferenced after the map is rewritten. Under option B the
dashboard price picker would then offer $4,500, $2,250 deposit and $2,250
balance, and the wrong pick is a plausible late-night mistake. It gets archived
explicitly:

```
POST /v1/prices/<old_4500_id>  active=false
```

Archiving is not deletion; existing references keep resolving. Documented in
the runbook rather than automated, since it happens once.

## 6. Runbook — `api/README.md`

"Approving an order" splits into two milestones for this plan:

**On approval** — invoice the deposit, and **do not create the subscription**:

```
POST /v1/invoiceitems  customer=cus_x price=<deposit_2250>
                       description="Storefront build — deposit (1 of 2)"
POST /v1/invoices      customer=cus_x collection_method=charge_automatically
POST /v1/invoices/in_x/finalize
```

**On completion** — invoice the balance, then create the subscription. Stripe
pulls pending invoice items onto a subscription's first invoice, so the client
receives one invoice for $2,250 + $149 and the monthly cycle starts that day:

```
POST /v1/invoiceitems   customer=cus_x price=<balance_2250>
                        description="Storefront build — balance (2 of 2)"
POST /v1/subscriptions  customer=cus_x items[0][price]=<recurring_149>
```

The existing sentence "the second ID under `storefront-build` in the map" is
now wrong and is rewritten to name all three positions.

## 7. Tests

- `store-cart.test.mjs` — deposit and balance amounts, `totals()` returning
  `deposit`, and `deposit === once` for every unsplit product.
- `terms-version.test.mjs` — version `2026-09`, archive present, hash matches,
  live document matches the archive word for word.
- `checkout.test.mjs` — the `CONSENT` fixture's version moves to `2026-09`.
- All 95 existing tests keep passing.

## 8. Gap this surfaces: nothing guards the older archives

Once `CURRENT_TERMS_VERSION` moves to `2026-09`, the drift test only checks
`terms/v2026-09.html`. Nothing then stops `terms/v2026-08.html` — a document
customers have already consented to — from being edited. Consent records carry
its hash in Stripe, so tampering is detectable, but only by someone who thinks
to go and look.

Proposed with this change, since it is the moment the archive becomes plural:
a small `terms/manifest.json` mapping each version to its SHA-256, with the
drift test verifying **every** entry on every run. Cheap now, and it makes
"the archive is intact" a build-time fact instead of an audit task.

Flagged rather than assumed — say if you would rather leave it.

## 9. Rollout

1. Test-mode dry run **first**: run `setup-stripe.ps1 -Mode test` twice, prove
   idempotency, then exercise deposit → balance → subscription against a
   throwaway test customer with a 4242 card, and confirm the pending invoice
   item really does merge onto the subscription's first invoice. That behavior
   is load-bearing for the runbook and has never actually been exercised —
   test-mode E2E was still pending as of 2026-08-15.
2. Implement the code changes on this branch, TDD.
3. Cut `terms/v2026-09.html` and hash it **last**, after the copy is final.
4. Full suite, plus a rendered screenshot of the card and drawer for review.
5. Merge to `main`, which deploys. Store pricing and `/terms` change together.
6. Archive the old $4,500 price.

## 10. Risks

- **Off-session charging.** The deposit is charged against a card saved by a
  SetupIntent. If the card requires authentication, the charge fails and needs
  a hosted-invoice link sent to the client. This exposure already exists for
  today's $4,500 charge; splitting it halves the amount per charge but does not
  remove the failure mode. Unchanged, noted for completeness.
- **A version named 2026-09 governing an August signup.** Accepted knowingly;
  the plate reads "effective on the date you subscribe", so the identifier is a
  label rather than a claim about when it took effect.
- **Two invoices per build means two chances to forget one.** The runbook
  carries the milestone, and nothing in the system tracks that a build is
  half-paid. Option B's distinct price IDs are what make that recoverable —
  deposits without a matching balance are queryable.
