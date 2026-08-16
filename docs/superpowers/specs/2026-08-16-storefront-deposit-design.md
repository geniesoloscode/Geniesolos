# Storefront build fee, split into deposit and balance — Design Spec

**Date:** 2026-08-16
**Status:** Approved 2026-08-16 — terms wording signed off, plate date settled
at August, archive manifest included
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

### Plate

Document `GS-SERVICE-TERMS v2026-09`, revised `August 2026`.

**Decided 2026-08-16.** The identifier and the Revised field disagree by a
month, deliberately. §13 promises each version carries an identifier *and* an
effective date, and the Revised field states a fact about the document's
history rather than a prediction about when it will first be relied on: it was
revised on 2026-08-16, so it says August. The identifier is a label, and
labelling the next revision `2026-09` while still testing in August costs
nothing, because nothing is live and no consent record can exist yet.

Rejected: dating it `September 2026` to match the identifier. That would put a
date on the document that is not the date it was written, which is a bad
property for a document whose whole job is to be produced later and believed.

Both v2026-08 and v2026-09 were written on 2026-08-16; v2026-08 was live for a
few hours and nobody subscribed under it. It is still kept and still served,
because a truthful record of what the site served costs nothing and deleting
archives is the opposite of the discipline the drift test exists to enforce.

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

**Included**, since this is the moment the archive becomes plural: a small
`terms/manifest.json` mapping each version to its SHA-256, with the drift test
verifying **every** entry on every run. It makes "the archive is intact" a
build-time fact instead of an audit task, and it is far cheaper to add now
than once there are five versions and a paying customer behind one of them.

Isolated by design — one JSON file and one test — so it can be dropped later
without touching anything else.

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

## Findings — Task 1 dry run (2026-08-16)

**Go/no-go: NO-GO on §6 as written.** The runbook's exact snippets do not do
what §6 claims, for a reason unrelated to the merge question they were meant
to test. Ran against the test-mode account (API version `2026-07-29.dahlia`,
customer `cus_V5LgyPxkMvmtyZ`, deleted and deletion confirmed afterward — see
below), using the brief's Steps 1–4 with one forced correction.

**Correction forced before anything would run.** `POST /v1/invoiceitems` with
a bare `price=<id>` param — exactly what §6 and the brief's snippet both use —
fails on this account's current API version: `"Received unknown parameter:
price. Did you mean pricing?"`. The working shape is `pricing[price]=<id>`.
A first throwaway customer (`cus_V5Le7tayGRXdwH`) was created to isolate this,
then deleted (confirmed deleted=true) before the real run below, which used a
fresh customer. **§6's snippets need this param rename regardless of anything
else in this section.**

**Milestone 1 (on approval) — did not invoice the deposit.** Created invoice
item "DRY RUN deposit (1 of 2)" (450000), then `POST /v1/invoices
customer=... collection_method=charge_automatically`, then finalized.
Expected one line, total `450000`. Actual: invoice `in_1U5AyyEEEbkqqitbOZaoXhX9`,
status `paid`, **total `0`, `0` lines**. The pending item was never attached.
No error was raised anywhere in this sequence — the empty invoice finalizes
and reports "paid" like a real success.

Root cause, confirmed against Stripe's current API reference for `POST
/v1/invoices`: `pending_invoice_items_behavior` now **defaults to `exclude`**
when the param is omitted — "Always create an empty invoice draft regardless
if there are pending invoice items or not." §6's "on approval" call omits this
parameter, so on this account it silently produces a $0 invoice instead of
billing the deposit. This is independent of API version quirks in the sense
that it is documented, current Stripe behavior — not a fluke of this account.

**Milestone 2 (on completion) — swept up both items, not just the balance.**
Created invoice item "DRY RUN balance (2 of 2)" (450000), then a subscription
on the recurring price. `sub.latest_invoice` came back as
`in_1U5Az2EEEbkqqitb9rGxfPbb`, status `paid`, **total `914900`, `3` lines**
(brief predicted 1 invoice / 2 lines / `464900`):

```
DRY RUN balance (2 of 2)                                   450000
DRY RUN deposit (1 of 2)                                   450000
1 × GenieSolos Storefront (build + care) (at $149.00/mo)     14900
```

The "DRY RUN deposit (1 of 2)" line traces (via the line's
`parent.invoice_item_details.invoice_item`) to the exact same invoice item
created in Milestone 1 — it never left "pending" because Milestone 1 never
consumed it, so it rode along when the subscription's invoice was built.
`GET /v1/invoices?customer=...` afterward showed exactly these two invoices
for the customer (`$0` and `$9,149.00`), and zero pending invoice items
remained. Both one-time items also stayed as two distinct 450000 lines rather
than merging into one 900000 line, despite sharing a price ID — Stripe does
not collapse same-price invoice items together.

**Does the underlying claim hold?** Partially, and the part that holds is not
the part that matters. The mechanism "a subscription's first invoice sweeps
in the customer's pending invoice items" is directly confirmed — two separate
pending items plus the recurring line all landed on one invoice together.
But the two-milestone design this spec describes does **not** work as
written: the deposit is never actually collected at approval (a $0 invoice
that reports success), and the full $9,149 — deposit, balance, and first
month together — gets charged in one shot at completion instead. That is the
opposite of what §"Decisions taken" commits to ("Keep the approval gate...the
deposit is invoiced by hand after the review call").

**What §6 must say instead**, before Task 7 writes the runbook:
1. Every `POST /v1/invoiceitems` call uses `pricing[price]=<id>`, not
   `price=<id>`.
2. The "on approval" `POST /v1/invoices` call must add
   `pending_invoice_items_behavior=include`, or it silently produces a $0
   invoice.
3. With fix (2) applied, Milestone 1 should consume the deposit item and
   leave nothing pending, so Milestone 2 should then see only the balance
   item plus the recurring line — the brief's original 1-invoice/2-line/
   `464900` prediction. **This was not independently re-run** (this task's
   scope is bounded to what the brief specifies, and a live retest is a good
   candidate for a follow-up check before Task 7's runbook ships), so it is a
   strong inference from the observed sweep-in behavior, not a directly
   confirmed number. Task 7 (or a fast follow-up) should re-run the corrected
   sequence once before the runbook is finalized.

**Customer cleanup.** `cus_V5LgyPxkMvmtyZ` (the real run) and
`cus_V5Le7tayGRXdwH` (the param-rename probe) were both deleted via `DELETE
/v1/customers/:id`; both refetches returned `deleted: true`. No Stripe test
objects from this task remain outstanding.

## Second pass — corrected sequence (2026-08-16)

Authorized because the recommended fix above was itself an unverified
assertion (a docs reading, not a live result). Ran the corrected sequence
end to end on one fresh customer, `cus_V5LnwBXhgoFadr` (deleted afterward,
confirmed — see below), applying both corrections: `pricing[price]=<id>` on
every invoice-item call, and `pending_invoice_items_behavior=include` on the
approval-time `POST /v1/invoices`. Used two throwaway one-time prices with
**distinct** amounts — deposit `225000`, balance `175000` — created under the
existing `storefront-build` product so the amount alone, not just the
description, proves which item landed where; both archived (`active=false`)
during cleanup.

**Milestone 1 (corrected).** Invoice `in_1U5B5nEEEbkqqitbGFxMR5bd`: **1 line,
total `225000`** ("DRY RUN pass2 deposit (1 of 2)") — the
`pending_invoice_items_behavior=include` fix works, confirmed. `GET
.../invoiceitems?...&pending=true` afterward returned **0** — the deposit
item was consumed, not left dangling. Both of these hold exactly as
recommended.

**But the invoice did not finalize as paid.** Status after finalize, and
again on refetch two seconds later: `open`, `amount_paid: 0`, `attempted:
false`, `attempt_count: 0`. Checked Stripe's own docs for automatic
invoice collection: `auto_advance` defaults to `false` on `POST
/v1/invoices` (confirmed via the create-invoice reference fetched during
pass 1), and per the automatic-advancement doc, "Attempting payments for
auto-charge invoices" is gated on `auto_advance: true` — with it false,
`collection_method: charge_automatically` alone does not trigger a charge
attempt. Finalize only moves the invoice `draft → open`; it does not, by
itself, charge the card. **This is a third fix §6 needs**, not just the two
already identified: the approval-time invoice create/finalize call must also
set `auto_advance=true`, or the runbook must add an explicit `POST
.../invoices/:id/pay` call, or the deposit invoice sits open and uncollected
indefinitely.

Tried `POST .../invoices/:id/pay` on this same invoice afterward, out of
sequence (after the customer had already been deleted per the cleanup step
below) — it failed: `"Invoice can't be paid: Customer deleted"`. So this
specific invoice ended up permanently stuck open. Whether an explicit `/pay`
call *before* customer deletion would have succeeded was not tested — the
customer was already gone by the time this was checked. That ordering is a
gap in this pass, not a resolved fact, and is the next thing to verify.

**Milestone 2 (corrected).** Balance item `pricing[price]`, then subscription
on the recurring price. `sub_1U5B5sEEEbkqqitbcdHH0jn7`, `latest_invoice`
`in_1U5B5sEEEbkqqitbJ3AHBPpv`: status `paid`, `amount_paid: 189900`, **exactly
2 lines**:

```
DRY RUN pass2 balance (2 of 2)                                175000
1 × GenieSolos Storefront (build + care) (at $149.00 / month)   14900
```

The deposit did **not** reappear — confirmed both by line count (2, not 3)
and by amount (no `225000` line present). This is exactly what the
coordinator's four checks asked for on this half, and it held.

**Scorecard against the four things the coordinator asked to be proven:**

| Check | Held? |
|---|---|
| Milestone 1 carries the deposit line and a non-zero total | Yes |
| Milestone 1 finalizes as genuinely paid | **No** — `open`, `amount_paid: 0`, never attempted |
| Deposit item shows consumed (0 pending) after milestone 1 | Yes |
| Milestone 2 has exactly 2 lines (balance + recurring), no deposit | Yes |

**Revised go/no-go: still NO-GO, narrower reason.** Both corrections from the
first pass are now proven live, not just docs-asserted. A third, previously
unknown gap replaces them: without `auto_advance=true` (or an explicit `/pay`
call) on the approval-time invoice, the deposit is correctly itemized but
never actually charged. §6 needs all three fixes — `pricing[price]`,
`pending_invoice_items_behavior=include`, and `auto_advance=true` (or an
explicit pay step) — and the pay-before-cleanup ordering question above
should be resolved before Task 7 treats the runbook as final.

**Cleanup.** Customer `cus_V5LnwBXhgoFadr` deleted via `DELETE
/v1/customers/:id`; refetch returned `deleted: true`. Both throwaway prices
archived via `POST /v1/prices/:id active=false`; refetch confirmed
`active: false` on both (`price_1U5B5kEEEbkqqitbvGsvWxfN`,
`price_1U5B5lEEEbkqqitbCEXDW1TN`). No product was created — both prices were
attached to the existing `storefront-build` product, which is unaffected.
