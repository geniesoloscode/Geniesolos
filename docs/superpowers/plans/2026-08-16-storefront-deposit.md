# Storefront Deposit Split — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sell Storefront (build + care) as $2,250 deposit + $2,250 on completion + $149/month starting at completion, instead of $4,500 once + $149/month starting at approval.

**Architecture:** The checkout Lambda is untouched — it runs `mode=setup`, charges nothing, and only validates that `PRICE_MAP` can serve the cart. The split is expressed in three places: the browser catalog (`js/store-cart.js`) which drives display, the Stripe price catalog (`scripts/setup-stripe.ps1`) which the owner invoices from by hand, and the service terms, which must be re-cut as a new immutable version because the pricing text changes.

**Tech Stack:** Static HTML/CSS/ES5-style JS (no bundler, no `package.json`), Node 22 ESM Lambdas, `node --test`, PowerShell 7 for Stripe/AWS setup, Stripe REST API over `Invoke-RestMethod`.

**Spec:** `docs/superpowers/specs/2026-08-16-storefront-deposit-design.md`

## Global Constraints

- **No dependencies.** No `package.json`, no `node_modules`, no bundler. `api/*/index.mjs` are single files.
- **CSP.** CloudFront serves `style-src 'self'` and `script-src 'self' 'sha256-…'`. No inline `<style>` or `<script>` in any page. Styles go in `css/*.css`, behaviour in `js/*.js`. The one hashed inline theme snippet must stay byte-identical to `index.html`'s.
- **Deployment is default-DENY.** `aws s3 sync` filters must stay identical between `scripts/deploy.ps1` and `.github/workflows/deploy.yml`, in the same order.
- **`.gitattributes` sets `* text=auto eol=lf`.** Do not change it — the terms document hash depends on LF bytes being identical on Windows, on CI, and on the CDN.
- **Never edit a file under `terms/`.** Those are archived documents. Changing the terms means cutting a new version.
- **Setup mode.** Checkout charges nothing. Do not touch `mode`, `PRICE_MAP` handling, the catalog rules, or the origin check.
- **Amounts are integer cents.** `once: 450000`, `deposit: 225000`, `monthly: 14900`.
- **Terms version this plan lands on:** `2026-09`. Plate reads `GS-SERVICE-TERMS v2026-09`, revised `August 2026`.
- **Run the full suite with:** `node --test "tests/*.test.mjs"`. Baseline is 95 passing.
- **Branch:** `storefront-deposit`. Do not merge to `main` until Task 7 — merging deploys.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `js/store-cart.js` | Catalog amounts, `totals()`, `startsAfterBuild()`, `TERMS_VERSION` | 2, 5 |
| `tests/store-cart.test.mjs` | Rules and amounts | 2 |
| `store.html` | Card copy, drawer totals markup | 3 |
| `js/store.js` | Renders totals rows and line meta | 3 |
| `css/store.css` | (no change expected; rows reuse `.totals__row`) | 3 |
| `terms/manifest.json` | version → SHA-256 of every archived document | 4 |
| `tests/terms-version.test.mjs` | Version pin, archive integrity, manifest | 4, 5 |
| `terms.html` | The live document | 5 |
| `terms/v2026-09.html` | The new immutable archive | 5 |
| `api/checkout/index.mjs` | `CURRENT_TERMS_VERSION`, `TERMS_DOC_SHA256` | 5 |
| `tests/checkout.test.mjs` | Consent fixture version | 5 |
| `scripts/setup-stripe.ps1` | Price catalog + nickname-aware reconciliation | 6 |
| `scripts/price-map.test.json` | Generated output | 6 |
| `api/README.md` | Approval runbook, price-map positions | 7 |

---

### Task 1: Prove the Stripe milestone behavior in test mode

The runbook is about to tell a human that creating a pending invoice item and
then a subscription produces **one** invoice containing both. Per the spec that
has never actually been exercised. Prove it before writing it down as fact.

No repository code changes. The deliverable is a recorded finding.

**Files:**
- Create: scratchpad only — `dry-run.ps1` in the session scratchpad, never in the repo
- Modify: `docs/superpowers/specs/2026-08-16-storefront-deposit-design.md` (append findings)

**Interfaces:**
- Consumes: nothing
- Produces: a go/no-go on the two-invoice-item flow that Task 7's runbook describes

- [ ] **Step 1: Read the test key without printing it**

The key lives at `scripts/.secrets/stripe-test.key` (git-ignored). Load it into
a variable. Never echo it, never put it in a log line, never paste it into the
spec.

```powershell
$key = (Get-Content 'scripts\.secrets\stripe-test.key' -Raw).Trim()
if (-not $key.StartsWith('sk_test_')) { throw "not a test-mode key - refusing to continue" }
$H = @{ Authorization = "Bearer $key" }
```

The `sk_test_` guard is mandatory. If this is ever run with a live key it must
abort, not create live objects.

- [ ] **Step 2: Create a throwaway customer with a saved card**

```powershell
$cust = Invoke-RestMethod -Method Post -Uri 'https://api.stripe.com/v1/customers' -Headers $H `
  -Body @{ name = 'DRY RUN - delete me'; description = 'storefront-deposit plan Task 1' } `
  -ContentType 'application/x-www-form-urlencoded'

$pm = Invoke-RestMethod -Method Post -Uri 'https://api.stripe.com/v1/payment_methods' -Headers $H `
  -Body @{ type = 'card'; 'card[token]' = 'tok_visa' } -ContentType 'application/x-www-form-urlencoded'

Invoke-RestMethod -Method Post -Uri "https://api.stripe.com/v1/payment_methods/$($pm.id)/attach" -Headers $H `
  -Body @{ customer = $cust.id } -ContentType 'application/x-www-form-urlencoded' | Out-Null

Invoke-RestMethod -Method Post -Uri "https://api.stripe.com/v1/customers/$($cust.id)" -Headers $H `
  -Body @{ 'invoice_settings[default_payment_method]' = $pm.id } -ContentType 'application/x-www-form-urlencoded' | Out-Null
```

- [ ] **Step 3: Milestone one — invoice a one-time price on its own, and pay it**

Use the existing `$4,500` one-time price from `scripts/price-map.test.json`
(the second id under `storefront-build`) as a stand-in for the deposit. The
amount is irrelevant; the mechanism is what is being tested.

```powershell
$map = Get-Content 'scripts\price-map.test.json' -Raw | ConvertFrom-Json
$oneTime  = $map.'storefront-build'[1]
$recurring = $map.'storefront-build'[0]

Invoke-RestMethod -Method Post -Uri 'https://api.stripe.com/v1/invoiceitems' -Headers $H `
  -Body @{ customer = $cust.id; price = $oneTime; description = 'DRY RUN deposit (1 of 2)' } `
  -ContentType 'application/x-www-form-urlencoded' | Out-Null

$inv1 = Invoke-RestMethod -Method Post -Uri 'https://api.stripe.com/v1/invoices' -Headers $H `
  -Body @{ customer = $cust.id; collection_method = 'charge_automatically' } -ContentType 'application/x-www-form-urlencoded'
$inv1 = Invoke-RestMethod -Method Post -Uri "https://api.stripe.com/v1/invoices/$($inv1.id)/finalize" -Headers $H -Body @{} -ContentType 'application/x-www-form-urlencoded'
"milestone 1 invoice: $($inv1.id)  status=$($inv1.status)  total=$($inv1.total)  lines=$($inv1.lines.data.Count)"
```

Expected: one line, total `450000`.

- [ ] **Step 4: Milestone two — pending invoice item, THEN subscription**

This is the claim under test.

```powershell
Invoke-RestMethod -Method Post -Uri 'https://api.stripe.com/v1/invoiceitems' -Headers $H `
  -Body @{ customer = $cust.id; price = $oneTime; description = 'DRY RUN balance (2 of 2)' } `
  -ContentType 'application/x-www-form-urlencoded' | Out-Null

$sub = Invoke-RestMethod -Method Post -Uri 'https://api.stripe.com/v1/subscriptions' -Headers $H `
  -Body @{ customer = $cust.id; 'items[0][price]' = $recurring } -ContentType 'application/x-www-form-urlencoded'

$inv2 = Invoke-RestMethod -Method Get -Uri "https://api.stripe.com/v1/invoices/$($sub.latest_invoice)" -Headers $H
"milestone 2 invoice: $($inv2.id)  total=$($inv2.total)  lines=$($inv2.lines.data.Count)"
$inv2.lines.data | ForEach-Object { "   - $($_.description)  $($_.amount)" }
```

Expected if the claim holds: **one** invoice, **two** lines, total `450000 + 14900 = 464900`.

- [ ] **Step 5: Record the actual result, whatever it was**

Append a `## Findings — Task 1 dry run (2026-08-16)` section to the spec stating
what the API actually did, with the real invoice ids and totals. If the merge
did **not** happen, say so plainly and stop: Task 7's runbook must then describe
two separate invoices at completion instead of one, and the spec's §6 needs
rewriting before anyone relies on it.

Do not paste the key, the customer id is fine.

- [ ] **Step 6: Delete the throwaway customer**

Deleting a customer removes its subscriptions and draft invoices with it.

```powershell
Invoke-RestMethod -Method Delete -Uri "https://api.stripe.com/v1/customers/$($cust.id)" -Headers $H
```

Verify it is gone before moving on:

```powershell
try { Invoke-RestMethod -Uri "https://api.stripe.com/v1/customers/$($cust.id)" -Headers $H | Out-Null; 'STILL PRESENT - delete by hand' }
catch { 'deleted' }
```

- [ ] **Step 7: Commit the findings**

```bash
git add docs/superpowers/specs/2026-08-16-storefront-deposit-design.md
git commit -m "Record what Stripe actually does with a pending invoice item and a new subscription"
```

---

### Task 2: Catalog amounts and totals

**Files:**
- Modify: `js/store-cart.js` (CATALOG entry, `totals()`, new `startsAfterBuild()`, exports)
- Test: `tests/store-cart.test.mjs`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `GSCart.CATALOG['storefront-build'].deposit` → `225000` (Number, integer cents)
  - `GSCart.totals(items)` → `{ monthly: Number, once: Number, deposit: Number }`
  - `GSCart.startsAfterBuild(items)` → `Boolean`

- [ ] **Step 1: Write the failing tests**

Append to `tests/store-cart.test.mjs`:

```js
/* ── Split build fee ───────────────────────────────────────────
   The Storefront build fee is billed in two equal parts, so the cart has to
   say what is due when rather than showing one lump nobody is ever invoiced. */

test('the storefront build fee is half at approval and half on completion', () => {
  const p = GSCart.CATALOG['storefront-build'];
  assert.equal(p.once, 450000);
  assert.equal(p.deposit, 225000);
  /* The balance is derived, never stored, so the two halves cannot drift. */
  assert.equal(p.once - p.deposit, 225000);
});

test('totals report the deposit alongside the one-time total', () => {
  const t = GSCart.totals([{ key: 'storefront-build', qty: 1 }]);
  assert.equal(t.monthly, 14900);
  assert.equal(t.once, 450000);
  assert.equal(t.deposit, 225000);
});

test('a product with no split owes its whole one-time fee at approval', () => {
  /* deposit === once is the uniform rule, so nothing downstream has to know
     which products are split. */
  const t = GSCart.totals([{ key: 'lifeline', qty: 1 }]);
  assert.equal(t.once, 0);
  assert.equal(t.deposit, 0);

  for (const key of Object.keys(GSCart.CATALOG)) {
    const p = GSCart.CATALOG[key];
    if (typeof p.deposit !== 'number') {
      const one = GSCart.totals([{ key, qty: 1 }]);
      assert.equal(one.deposit, one.once, `${key} should owe its whole once up front`);
    }
  }
});

test('a split line moves the whole subscription start to completion', () => {
  /* Add-ons ride the same subscription, so one split line defers everything. */
  assert.equal(GSCart.startsAfterBuild([{ key: 'storefront-build', qty: 1 }]), true);
  assert.equal(GSCart.startsAfterBuild([
    { key: 'storefront-build', qty: 1 },
    { key: 'server-care', qty: 2 }
  ]), true);
  assert.equal(GSCart.startsAfterBuild([{ key: 'storefront-zero', qty: 1 }]), false);
  assert.equal(GSCart.startsAfterBuild([{ key: 'lifeline', qty: 1 }]), false);
  assert.equal(GSCart.startsAfterBuild([]), false);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test "tests/store-cart.test.mjs"`
Expected: 4 failures. `p.deposit` is `undefined`, `t.deposit` is `undefined`, and `GSCart.startsAfterBuild is not a function`.

- [ ] **Step 3: Add the deposit to the catalog**

In `js/store-cart.js`, replace the `storefront-build` line:

```js
    'storefront-build':  { name: 'Storefront (build + care)', monthly: 14900, once: 450000, deposit: 225000, kind: 'storefront-base',  maxQty: 1 },
```

Add a note above the CATALOG explaining `deposit`:

```js
  /* monthly and once are integer cents. kind decides what a line needs in the
     cart beside it: 'addon' needs any plan, 'storefront-addon' needs one of
     the two Storefront plans. deposit, where present, is the part of `once`
     invoiced at approval; the balance is always `once - deposit` so the two
     halves cannot drift apart. Absent deposit means the whole one-time fee is
     due at approval. */
```

- [ ] **Step 4: Teach totals about the deposit**

Replace the body of `totals()`:

```js
  function totals(items) {
    var monthly = 0;
    var once = 0;
    var deposit = 0;
    var list = items || [];

    for (var i = 0; i < list.length; i++) {
      var p = product(list[i].key);
      if (!p) continue;
      var qty = clampQty(list[i].key, list[i].qty);
      monthly += p.monthly * qty;
      once += p.once * qty;
      /* No split means the whole one-time fee is the deposit, so callers
         never have to ask which products are split. */
      deposit += (typeof p.deposit === 'number' ? p.deposit : p.once) * qty;
    }
    return { monthly: monthly, once: once, deposit: deposit };
  }
```

- [ ] **Step 5: Add startsAfterBuild**

Directly after `totals()`:

```js
  /* True when any line's one-time fee is split, which is what defers the
     subscription: the monthly does not begin until the build is delivered,
     and add-ons ride that same subscription, so one split line defers the
     whole cart. */
  function startsAfterBuild(items) {
    var list = items || [];
    for (var i = 0; i < list.length; i++) {
      var p = product(list[i].key);
      if (p && typeof p.deposit === 'number' && p.deposit < p.once) return true;
    }
    return false;
  }
```

Add both to the returned object, beside `totals`:

```js
    totals: totals,
    startsAfterBuild: startsAfterBuild,
```

- [ ] **Step 6: Run the tests**

Run: `node --test "tests/*.test.mjs"`
Expected: PASS, 99 tests, 0 failures.

- [ ] **Step 7: Commit**

```bash
git add js/store-cart.js tests/store-cart.test.mjs
git commit -m "Split the Storefront build fee into a deposit and a balance"
```

---

### Task 3: Drawer and card

**Files:**
- Modify: `store.html` (totals markup ~line 492, Storefront card ~lines 275-285)
- Modify: `js/store.js` (`render()`, `lineNode()`, element lookups, live-region text)
- Test: browser verification (no DOM test harness exists; the rules are already covered by Task 2)

**Interfaces:**
- Consumes: `GSCart.totals(items).deposit`, `GSCart.startsAfterBuild(items)` from Task 2
- Produces: nothing consumed by later tasks

- [ ] **Step 1: Replace the totals markup**

In `store.html`, replace the `<dl class="totals">` block:

```html
      <dl class="totals">
        <div class="totals__row">
          <dt id="monthlyLabel">Monthly, after approval</dt>
          <dd id="totalMonthly">$0</dd>
        </div>
        <!-- Two rows rather than one "one-time" row: the Storefront build fee
             is invoiced in halves, and a single $4,500 figure would name an
             amount nobody is ever charged in one go. Each hides at zero. -->
        <div class="totals__row totals__row--once" id="depositRow" hidden>
          <dt>Due at approval</dt>
          <dd id="totalDeposit">$0</dd>
        </div>
        <div class="totals__row totals__row--once" id="balanceRow" hidden>
          <dt>Due on completion</dt>
          <dd id="totalBalance">$0</dd>
        </div>
      </dl>
```

- [ ] **Step 2: Update the element lookups in `js/store.js`**

Replace the `onceEl` / `onceRow` lookups:

```js
  var monthlyEl  = $('#totalMonthly');
  var monthlyLbl = $('#monthlyLabel');
  var depositEl  = $('#totalDeposit');
  var balanceEl  = $('#totalBalance');
  var depositRow = $('#depositRow');
  var balanceRow = $('#balanceRow');
```

- [ ] **Step 3: Update `render()`**

Replace the totals block inside `render()`:

```js
    var t = Cart.totals(items);
    var balance = t.once - t.deposit;
    monthlyEl.textContent = money(t.monthly);
    depositEl.textContent = money(t.deposit);
    balanceEl.textContent = money(balance);
    depositRow.hidden = t.deposit === 0;
    balanceRow.hidden = balance === 0;
    /* Add-ons ride the build's subscription, so when a split line is present
       the whole monthly figure starts at completion, not at approval. */
    monthlyLbl.textContent = Cart.startsAfterBuild(items)
      ? 'Monthly, after the build'
      : 'Monthly, after approval';
```

- [ ] **Step 4: Update the screen-reader live text in `render()`**

It currently says "monthly after approval" unconditionally. Replace it:

```js
    var when = Cart.startsAfterBuild(items) ? 'monthly after the build' : 'monthly after approval';
    live.textContent = count === 0
      ? 'Cart is empty.'
      : 'Cart: ' + count + (count === 1 ? ' item, ' : ' items, ') + money(t.monthly) + ' ' + when +
        (t.deposit ? ', ' + money(t.deposit) + ' due at approval' : '') +
        (balance ? ', ' + money(balance) + ' due on completion' : '') + '.';
```

- [ ] **Step 5: Update the cart line meta in `lineNode()`**

Replace the `bits` block:

```js
    var bits = [];
    if (p.maxQty > 1) bits.push(money(p.monthly) + '/month each');
    if (typeof p.deposit === 'number' && p.deposit < p.once) {
      bits.push(money(p.deposit * item.qty) + ' deposit');
      bits.push(money((p.once - p.deposit) * item.qty) + ' on completion');
    } else if (p.once) {
      bits.push(money(p.once * item.qty) + ' one-time');
    }
```

- [ ] **Step 6: Update the Storefront card**

In `store.html`, replace the card's badge, price, meta and first feature bullet:

```html
        <span class="card__badge card__badge--sun">$2,250 to start</span>
        <p class="card__kicker">Build + care</p>
        <h3 class="card__name">Storefront</h3>
        <p class="card__price"><b>$2,250</b><span>deposit, then $2,250 on completion, then $149/month</span></p>
        <p class="card__meta">$4,500 build total &middot; month-to-month after</p>
        <ul class="feats">
          <li>Half the build fee to start, half when the build is delivered</li>
          <li>Hosting, maintenance, and support included</li>
          <li>4-business-hour initial response</li>
          <li>Website ownership transfers when the build fee is paid in full</li>
        </ul>
```

- [ ] **Step 7: Bump the cache-busting tokens**

In `store.html`, `js/store.js` and `css/store.css` changed, so both query strings move together:

```bash
sed -i 's|css/store.css?v=20260816c|css/store.css?v=20260816d|; s|js/store.js?v=20260816c|js/store.js?v=20260816d|; s|js/store-cart.js?v=20260816|js/store-cart.js?v=20260816d|' store.html
grep -n "?v=" store.html
```

`js/store-cart.js` changed in Task 2, so its token moves too. Without this, a
returning visitor can pair new HTML with a cached old script for up to five
minutes.

- [ ] **Step 8: Verify in a real browser**

Serve the repo root and screenshot the drawer with a Storefront cart. There is
no DOM test harness in this repo, so this is the verification.

```bash
node --check js/store.js
node --test "tests/*.test.mjs"
```

Then serve on `127.0.0.1:8129`, open `/store`, click Add on `storefront-build`,
open the cart, and confirm by screenshot:

- "Monthly, after the build   $149"
- "Due at approval          $2,250"
- "Due on completion        $2,250"
- the line meta reads "$2,250 deposit · $2,250 on completion"
- a cart with only `lifeline` shows "Monthly, after approval" and **no** deposit or balance row

- [ ] **Step 9: Commit**

```bash
git add store.html js/store.js
git commit -m "Show the deposit and the balance in the drawer, and lead the card with $2,250"
```

---

### Task 4: Archive manifest

Guards every archived terms document, not just the current one. Landed before
the new version is cut so it is proven against the existing archive first.

**Files:**
- Create: `terms/manifest.json`
- Modify: `tests/terms-version.test.mjs`

**Interfaces:**
- Consumes: nothing
- Produces: `terms/manifest.json` — a flat object of `{ "<version>": "<sha256 hex>" }`, which Task 5 adds one entry to

- [ ] **Step 1: Write the failing tests**

Add to `tests/terms-version.test.mjs`, and extend the `node:fs` import to
include `readdirSync`:

```js
/* ── Archive integrity ─────────────────────────────────────────
   The drift test above only ever watches the CURRENT version. Once the
   archive goes plural, nothing else stops an older document — one customers
   have already consented to — from being edited. The manifest is what makes
   "the archive is intact" a build-time fact instead of an audit task. */

test('every archived document still hashes to what the manifest recorded', () => {
  const manifest = JSON.parse(read('terms/manifest.json'));
  const entries = Object.entries(manifest);
  assert.ok(entries.length > 0, 'the manifest is empty');

  for (const [version, expected] of entries) {
    const file = `terms/v${version}.html`;
    assert.ok(existsSync(root + file), `${file} is in the manifest but not on disk`);
    const actual = createHash('sha256').update(readFileSync(root + file)).digest('hex');
    assert.equal(actual, expected, `${file} has changed since it was archived`);
  }
});

test('no archived document is missing from the manifest', () => {
  /* The other direction: a new version cut without a manifest entry would
     otherwise be silently unguarded. */
  const manifest = JSON.parse(read('terms/manifest.json'));
  const archived = readdirSync(root + 'terms').filter((f) => /^v.+\.html$/.test(f));
  assert.ok(archived.length > 0);

  for (const file of archived) {
    const version = file.replace(/^v/, '').replace(/\.html$/, '');
    assert.ok(version in manifest, `terms/${file} is not listed in terms/manifest.json`);
  }
});

test('the manifest agrees with the hash the Lambda pins for the current version', () => {
  const manifest = JSON.parse(read('terms/manifest.json'));
  const pinned = /const TERMS_DOC_SHA256 = '([^']+)'/.exec(read('api/checkout/index.mjs'));
  assert.ok(pinned);
  assert.equal(manifest[VERSION], pinned[1]);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test "tests/terms-version.test.mjs"`
Expected: 3 failures, all `ENOENT` on `terms/manifest.json`.

- [ ] **Step 3: Create the manifest**

Compute the hash rather than copying it from anywhere:

```bash
sha256sum terms/v2026-08.html
```

Write `terms/manifest.json` with the value that prints:

```json
{
  "2026-08": "9fe0494dbbba9f098c4f1fda3d5800e531972450399b307515a4eb7ae126bec7"
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test "tests/*.test.mjs"`
Expected: PASS, 102 tests, 0 failures.

- [ ] **Step 5: Prove the guard actually catches tampering**

A test that passed on first run has not been shown to work. Break it, watch it
fail, restore it:

```bash
printf '\n<!-- tampered -->\n' >> terms/v2026-08.html
node --test "tests/terms-version.test.mjs" 2>&1 | grep -E "^ℹ (pass|fail)"   # expect 1 failure
git checkout terms/v2026-08.html
sha256sum terms/v2026-08.html   # must print the manifest value again
node --test "tests/*.test.mjs" 2>&1 | grep -E "^ℹ (tests|pass|fail)"          # back to 102/102
```

- [ ] **Step 6: Publish the manifest**

`terms/*` is already on both sync whitelists, so `manifest.json` ships with the
archive automatically. Confirm no deploy change is needed:

```bash
grep -n "terms/\*" scripts/deploy.ps1 .github/workflows/deploy.yml
```

Expected: one match in each. If either is missing, stop — the archive is not
being published.

- [ ] **Step 7: Commit**

```bash
git add terms/manifest.json tests/terms-version.test.mjs
git commit -m "Hash every archived terms version, not just the current one"
```

---

### Task 5: Cut terms v2026-09

Every part of this task must land in one commit: the drift test compares the
live document to the current archive, so the suite is red at every intermediate
point.

**Files:**
- Modify: `terms.html` (§01 table row, §04 new paragraph, §05 new paragraph + note, §06 clause, plate)
- Create: `terms/v2026-09.html`
- Modify: `terms/manifest.json`, `js/store-cart.js`, `api/checkout/index.mjs`, `tests/checkout.test.mjs`

**Interfaces:**
- Consumes: `terms/manifest.json` shape from Task 4
- Produces: `GSCart.TERMS_VERSION === '2026-09'`, `CURRENT_TERMS_VERSION === '2026-09'`, `TERMS_DOC_SHA256` = hash of `terms/v2026-09.html`

- [ ] **Step 1: Edit §01's pricing row in `terms.html`**

Replace the Storefront (build + care) row:

```html
            <tr><td>Storefront (build&nbsp;+&nbsp;care)</td><td class="num">$2,250 deposit, $2,250 on completion, then $149</td><td>n/a</td><td>n/a</td></tr>
```

- [ ] **Step 2: Add the milestone paragraph to §04 Billing**

Insert immediately after the first paragraph of §04 (the one beginning
"Checkout stores your payment method"):

```html
      <p>
        <b>Storefront build milestones.</b> The $4,500 build fee for Storefront
        (build&nbsp;+&nbsp;care) is billed in two equal parts: $2,250 when we confirm your order
        and begin work, and $2,250 when the build is complete and delivered to you. Monthly fees
        for this plan begin on completion and are billed with the second part. You are not billed
        monthly while the build is in progress.
      </p>
```

- [ ] **Step 3: Add the deposit paragraph to §05 Cancellation**

Insert after the "If we are at fault" paragraph and before the "In short"
note. Placement matters: the "If we are at fault" paragraph opens with "the
paragraph above," which must keep referring to the "Term plans" paragraph
immediately preceding it. Inserting the new paragraph between them would
shift that back-reference onto the new paragraph instead — do not put
anything between "Term plans" and "If we are at fault".

```html
      <p>
        <b>The Storefront build deposit.</b> The first $2,250 is non-refundable once we begin
        work. It reserves your build slot and pays for work performed before completion. If you
        cancel before the build is complete, you owe nothing further: the second $2,250 does not
        become due, no monthly fees have begun, and ownership of the website does not transfer.
      </p>
```

- [ ] **Step 4: Amend the §05 "In short" note**

The current note folds the build fee into a "once delivered" rule, but a
deposit is taken *before* delivery, so the two clauses contradict. Replace it:

```html
      <div class="note">
        <b>In short:</b> setup fees and completed one-time project work are non-refundable once
        the work is delivered, and the Storefront build deposit is non-refundable once work
        begins.
      </div>
```

- [ ] **Step 5: Clarify §06 Ownership**

In the "Website ownership" paragraph, replace the Storefront build + care
sentence:

```html
        For
        Storefront build&nbsp;+&nbsp;care, ownership transfers when the build fee is paid in full,
        meaning both parts of the $4,500 build fee.
```

- [ ] **Step 6: Update the plate**

```html
      <dd>GS&#8209;SERVICE&#8209;TERMS v2026&#8209;09</dd>
```

Leave **Revised** as `August 2026`. The identifier is a forward label; the
Revised field states when the document was actually written. This disagreement
is deliberate and is recorded in the spec.

- [ ] **Step 7: Cut the archive**

```bash
cp terms.html terms/v2026-09.html
```

Then make exactly the adaptations `terms/v2026-08.html` already carries — read
that file side by side and mirror it:

1. `<title>` → `Service Terms v2026-09 (archived) | GenieSolos Tech`
2. the archive header comment, with `v2026-09` and the new-version instructions
3. `<link rel="canonical" href="https://geniesolos.com/terms/v2026-09.html">`
4. `<meta name="robots" content="noindex, follow">`
5. og:title / og:description / og:url updated to v2026-09
6. **every** asset path root-relative: `/assets/favicon.svg`, `/css/terms.css?v=20260816`, `/js/terms.js?v=20260814`
7. nav: `href="/"` on the brand, links to `/terms` ("Current terms") and `/` ("Back to site")
8. the `<aside class="archived">` notice above `<section class="plate">`, naming `2026&#8209;09`
9. footer: `Service Terms &middot; archived version 2026&#8209;09`, `href="/"` on the home link

Nothing from `<section class="plate">` down may differ from `terms.html` — the
drift test compares that span byte for byte.

- [ ] **Step 8: Move the three version constants**

`js/store-cart.js`:

```js
  var TERMS_VERSION = '2026-09';
```

`api/checkout/index.mjs`:

```js
const CURRENT_TERMS_VERSION = '2026-09';
```

`tests/checkout.test.mjs`:

```js
const TERMS_VERSION = '2026-09';
```

- [ ] **Step 9: Hash the archive, last**

Only now that the copy is final:

```bash
sha256sum terms/v2026-09.html
```

Put that value in **both** places — `TERMS_DOC_SHA256` in
`api/checkout/index.mjs`, and a new `"2026-09"` entry in `terms/manifest.json`
alongside the existing `"2026-08"` one. Do not remove the 2026-08 entry.

- [ ] **Step 10: Run the full suite**

Run: `node --test "tests/*.test.mjs"`
Expected: PASS, 102 tests, 0 failures.

If `the archived copy is the live terms word for word` fails, the archive's
plate-down span differs from `terms.html` — diff them:

```bash
diff <(sed -n '/<section class="plate">/,/<\/main>/p' terms.html) \
     <(sed -n '/<section class="plate">/,/<\/main>/p' terms/v2026-09.html)
```

- [ ] **Step 11: Verify the archive renders**

Root-relative paths cannot resolve over `file://`. Serve the repo root and load
`/terms/v2026-09.html`, confirming the stylesheet applies, the amber archived
notice shows `2026-09`, and the plate reads `GS-SERVICE-TERMS v2026-09` with
`Revised August 2026`.

- [ ] **Step 12: Commit**

```bash
git add terms.html terms/v2026-09.html terms/manifest.json js/store-cart.js api/checkout/index.mjs tests/checkout.test.mjs
git commit -m "Cut service terms v2026-09 with the split build fee"
```

---

### Task 6: Stripe prices — deposit and balance

**Files:**
- Modify: `scripts/setup-stripe.ps1` (catalog entry, `Get-OrCreatePrice`, call site, report line, header comment)
- Modify: `scripts/price-map.test.json` (generated — do not hand-edit)

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces: `price-map.test.json` with `storefront-build: [recurring_149, deposit_2250, balance_2250]`, in that order, which Task 7's runbook names by position

- [ ] **Step 1: Make the price match nickname-aware**

Two one-time prices at $2,250 are indistinguishable under the current rule, so
the second lookup would find the first and write the same id twice. Adding
nickname naively breaks every existing price, which all have `nickname: null`.
Coercing both sides is what keeps today's prices matching themselves.

Replace `Get-OrCreatePrice`:

```powershell
    # A price is reused when it matches on amount + currency + cadence +
    # nickname. Nickname is in the rule because storefront-build now has TWO
    # one-time prices at the same amount - deposit and balance - which are
    # otherwise indistinguishable, and the second lookup would find the first
    # and write one id twice.
    #
    # Both sides are cast to [string] so an absent nickname compares equal to
    # Stripe's null. Every price created before nicknames existed has a null
    # nickname, and without the cast each would stop matching itself and be
    # duplicated on the next run.
    function Get-OrCreatePrice {
        param([string]$ProductId, [int]$Amount, [bool]$IsRecurring, [string]$Nickname, $Existing)
        $match = $Existing | Where-Object {
            $_.unit_amount -eq $Amount -and $_.currency -eq 'usd' -and
            ([string]$_.nickname -eq [string]$Nickname) -and (
                ($IsRecurring -and $_.recurring -and $_.recurring.interval -eq 'month') -or
                ((-not $IsRecurring) -and (-not $_.recurring))
            )
        } | Select-Object -First 1
        if ($match) { return @{ Price = $match; Created = $false } }

        $body = @{ product = $ProductId; unit_amount = "$Amount"; currency = 'usd' }
        if ($IsRecurring) { $body['recurring[interval]'] = 'month' }
        if ($Nickname) { $body['nickname'] = $Nickname }
        $created = Invoke-Stripe -Method POST -Path '/v1/prices' -Body $body
        return @{ Price = $created; Created = $true }
    }
```

- [ ] **Step 2: Pass the nickname at the call site**

```powershell
            $priceResult = Get-OrCreatePrice -ProductId $product.id -Amount $priceSpec.Amount -IsRecurring $priceSpec.Recurring -Nickname $priceSpec.Nickname -Existing $existingPrices
```

- [ ] **Step 3: Show the nickname in the report line**

Otherwise the run prints two identical `$2250.00 one-time` rows.

```powershell
            $detail = if ($priceSpec.Recurring) { "`$$([math]::Round($priceSpec.Amount / 100, 2))/mo" } else { "`$$([math]::Round($priceSpec.Amount / 100, 2)) one-time" }
            if ($priceSpec.Nickname) { $detail = "$detail ($($priceSpec.Nickname))" }
```

Widen the `DETAIL` column in both the header and row format strings from
`{2,-24}` to `{2,-46}` so the nickname is not truncated.

- [ ] **Step 4: Split the catalog entry**

```powershell
    @{ Key = 'storefront-build'; Name = 'GenieSolos Storefront (build + care)'; Prices = @(
        @{ Amount = 14900;  Recurring = $true }
        @{ Amount = 225000; Recurring = $false; Nickname = 'Storefront build deposit (1 of 2)' }
        @{ Amount = 225000; Recurring = $false; Nickname = 'Storefront build balance (2 of 2)' }
    ) }
```

- [ ] **Step 5: Update the two stale comments**

The header comment says "with storefront-build's recurring price first and its
one-time build fee second". Replace with:

```
    scripts\price-map.<Mode>.json in the exact shape api/checkout/index.mjs's
    PRICE_MAP expects: { key: [priceId, ...] }, with storefront-build's
    recurring price first, its build deposit second and its build balance
    third.
```

And the catalog comment above `$Catalog`, replacing "storefront-build maps to
TWO price ids, recurring first and one-time second":

```powershell
# Catalog: name -> price(s) in cents. storefront-build maps to THREE price ids
# in a fixed order - recurring, build deposit, build balance - because the
# approval runbook names them by position. Every other key is a one-element
# array. The Lambda treats a non-array or empty value as a config error, so
# this script always writes arrays - see the @() wrapping down in the
# JSON-write step.
```

- [ ] **Step 6: Run it once against test mode**

```powershell
.\scripts\setup-stripe.ps1 -Mode test
```

Expected: the two $2,250 prices report `created`, everything else `found`.

- [ ] **Step 7: Run it again and prove idempotency**

This is the whole point of the nickname change. Capture the map, re-run, diff:

```bash
cp scripts/price-map.test.json /tmp/map-run1.json
```
```powershell
.\scripts\setup-stripe.ps1 -Mode test
```
```bash
diff /tmp/map-run1.json scripts/price-map.test.json && echo "IDEMPOTENT - identical map"
```

Expected: second run reports `0 created`, and the diff is empty. If the deposit
and balance ids are identical to each other, the nickname match is not working —
stop and fix it before continuing.

- [ ] **Step 8: Confirm the array shape the Lambda will validate**

```bash
node -e "const m=require('./scripts/price-map.test.json'); const s=m['storefront-build']; console.log(s.length, new Set(s).size, JSON.stringify(s,null,1))"
```

Expected: `3 3` — three ids, all distinct.

- [ ] **Step 9: Run the suite**

Run: `node --test "tests/*.test.mjs"`
Expected: PASS, 102 tests. Nothing here touches the Lambda, so this is a
regression check only.

- [ ] **Step 10: Commit**

```bash
git add scripts/setup-stripe.ps1 scripts/price-map.test.json
git commit -m "Give Storefront a deposit price and a balance price, told apart by nickname"
```

---

### Task 7: Runbook, old price, and merge

**Files:**
- Modify: `api/README.md` ("Approving an order", the price-map description)

**Interfaces:**
- Consumes: the price-map positions from Task 6, the Task 1 finding
- Produces: nothing

- [ ] **Step 1: Rewrite the approval step for Storefront**

In `api/README.md`, replace the `storefront-build` bullet under "**2. Approve:
create the subscription by hand**" with the milestone section below.

**This text was rewritten after Task 1.** The original draft described a
sequence that was proven to fail — and to fail *silently*, producing a $0
invoice that reports `status: paid`. Reproduce the block below verbatim; do not
"simplify" any of the three non-obvious parameters back out of it. Spec §6
carries the same text and the reasoning behind each one.

````markdown
### Storefront (build + care): two milestones, not one

The $4,500 build fee is invoiced in halves and the subscription does not start
until the build is delivered. `scripts/price-map.<mode>.json` lists
`storefront-build`'s three price ids in fixed order: **recurring, deposit,
balance**.

Every call below was verified against the real test-mode API on 2026-08-16.
Three parameters here are not optional and are not obvious — without them the
sequence fails **silently**, finalizing an empty $0 invoice that reports
`status: paid` while nothing is charged.

**On approval — invoice the deposit and charge it. Do not create the subscription.**

```
# `pricing[price]`, NOT `price` — a bare `price` is rejected outright
POST /v1/invoiceitems   customer=cus_x
                        pricing[price]=<deposit, 2nd id>
                        description=Storefront build - deposit (1 of 2)

# without pending_invoice_items_behavior=include this comes out with no lines
# and a $0 total, and still says "paid"
POST /v1/invoices       customer=cus_x
                        collection_method=charge_automatically
                        pending_invoice_items_behavior=include

# finalize only moves draft -> open. It does NOT charge.
POST /v1/invoices/in_x/finalize

# the step that actually moves money, and answers immediately
POST /v1/invoices/in_x/pay   payment_method=<pm_id>
```

Confirm `status: paid`, `amount_paid: 225000`, `attempted: true` before
starting the build. Still `open` with `amount_paid: 0` means it did not charge.

**Why explicit `/pay` and not `auto_advance=true`:** `auto_advance` works, but
schedules the attempt roughly an hour out with no interim signal — observed
`next_payment_attempt` ~59 minutes ahead with `attempted: false` throughout.
Right for automated billing, useless when you need to know now.

`payment_method` is explicit because the customer may have no
`invoice_settings[default_payment_method]` set. The bare call fails with an
error naming exactly that; the same call with `payment_method` succeeds.

**Before the subscription**, set the saved card as the customer default:

```
POST /v1/customers/cus_x  invoice_settings[default_payment_method]=<pm_id>
```

**On completion — invoice the balance, then create the subscription.** In that
order: a subscription's first invoice sweeps in pending invoice items, so the
client receives one invoice for $2,250 + $149 and the monthly cycle starts that
day. Verified three times: exactly two lines, and a deposit already collected
does not reappear.

```
POST /v1/invoiceitems   customer=cus_x
                        pricing[price]=<balance, 3rd id>
                        description=Storefront build - balance (2 of 2)

POST /v1/subscriptions  customer=cus_x
                        items[0][price]=<recurring, 1st id>
```

Nothing in the system tracks that a build is half-paid. Deposits without a
matching balance are queryable because the two halves are distinct prices —
that is the reason they are distinct.
````

- [ ] **Step 2: Fix the stale price-map sentence**

The existing text says "using the one-time price (the second ID under
`storefront-build` in the map)". The second id is now the deposit. Find and
correct every reference.

```bash
grep -n "second ID under\|one-time price\|4,500" api/README.md
```

- [ ] **Step 3: Document archiving the old $4,500 price**

Under the milestone section:

````markdown
**The old $4,500 price is archived.** It exists from before the split and is no
longer in the price map. Archiving keeps it out of the dashboard price picker,
where choosing it would silently bill a client twice what is due. Archiving is
not deletion — existing references keep resolving.

```
POST /v1/prices/<old_4500_id>  active=false
```
````

- [ ] **Step 4: Archive it for real, in test mode**

```powershell
$key = (Get-Content 'scripts\.secrets\stripe-test.key' -Raw).Trim()
if (-not $key.StartsWith('sk_test_')) { throw 'not a test key' }
$H = @{ Authorization = "Bearer $key" }
$prod = (Invoke-RestMethod -Uri 'https://api.stripe.com/v1/products?active=true&limit=100' -Headers $H).data |
        Where-Object { $_.name -eq 'GenieSolos Storefront (build + care)' }
$old = (Invoke-RestMethod -Uri "https://api.stripe.com/v1/prices?product=$($prod.id)&active=true&limit=100" -Headers $H).data |
       Where-Object { $_.unit_amount -eq 450000 }
foreach ($p in $old) {
  Invoke-RestMethod -Method Post -Uri "https://api.stripe.com/v1/prices/$($p.id)" -Headers $H `
    -Body @{ active = 'false' } -ContentType 'application/x-www-form-urlencoded' | Out-Null
  "archived $($p.id)"
}
```

Then re-run `.\scripts\setup-stripe.ps1 -Mode test` and confirm the map is
unchanged — the script only reads active prices, so archiving one it no longer
wants must be a no-op.

- [ ] **Step 5: Full verification before merging**

```bash
node --test "tests/*.test.mjs"                      # expect 102/102
node --check js/store.js && node --check js/store-cart.js
node --check api/checkout/index.mjs && node --check api/webhook/index.mjs
sha256sum terms/v2026-09.html                       # must equal TERMS_DOC_SHA256 and the manifest
grep -n "terms/\*" scripts/deploy.ps1 .github/workflows/deploy.yml
```

Confirm the sync filter sequences still match between the two deploy paths.

- [ ] **Step 6: Screenshot the drawer and the card for review**

Serve the repo root, capture the Storefront card and the drawer with a
Storefront cart, and post both before merging. This is the last point at which
the pricing copy can be changed cheaply.

- [ ] **Step 7: Commit**

```bash
git add api/README.md
git commit -m "Split the approval runbook into a deposit milestone and a completion milestone"
```

- [ ] **Step 8: Merge, which deploys**

Only after the screenshots are approved. Merging to `main` triggers the Actions
workflow and the store's pricing and `/terms` change together.

```bash
git checkout main && git merge --no-ff storefront-deposit
git push origin main
```

Watch the run to completion, then verify live:

```bash
curl -s https://geniesolos.com/terms/v2026-09.html | sha256sum   # equals TERMS_DOC_SHA256
curl -s https://geniesolos.com/store | grep -o '\$2,250 to start'
curl -s https://geniesolos.com/terms/manifest.json
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §1 Catalog and totals | 2 |
| §2 Drawer | 3 |
| §3 Store card | 3 |
| §4 Terms v2026-09 + plate | 5 |
| §5 Stripe option B + reconciliation + archiving old price | 6, 7 |
| §6 Runbook | 7 |
| §7 Tests | 2, 4, 5 |
| §8 Archive manifest | 4 |
| §9 Rollout (dry run first, hash last, screenshots, merge) | 1, 5, 7 |
| §10 Risks | carried into the runbook in 7 |

**Placeholder scan:** none. `<old_4500_id>`, `<deposit, 2nd id>` and
`<balance, 3rd id>` are runbook placeholders for a human reading the docs, and
Task 7 Step 4 resolves the first programmatically.

**Type consistency:** `deposit` is an integer-cents Number on the CATALOG entry
(Task 2) and read as `t.deposit` from `totals()` (Tasks 2, 3). `startsAfterBuild`
is named identically in Task 2's implementation and Task 3's two call sites.
`terms/manifest.json` is a flat `{version: hash}` object in Task 4 and is
extended, not reshaped, in Task 5. Price-map order — recurring, deposit,
balance — is fixed in Task 6 and referenced by position in Task 7.

**Test counts:** 95 baseline → 99 after Task 2 (+4) → 102 after Task 4 (+3).
Tasks 3, 5, 6, 7 add no tests; 5 changes an existing fixture value.
