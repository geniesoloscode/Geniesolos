import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const GSCart = createRequire(import.meta.url)('../js/store-cart.js');

const keys = (items) => items.map((i) => i.key);

test('the catalog carries the published prices in cents', () => {
  assert.equal(GSCart.CATALOG.lifeline.monthly, 29900);
  assert.equal(GSCart.CATALOG.presence.monthly, 64900);
  assert.equal(GSCart.CATALOG.transformation.monthly, 99900);
  assert.equal(GSCart.CATALOG['storefront-zero'].monthly, 49900);
  assert.equal(GSCart.CATALOG['storefront-build'].monthly, 14900);
  assert.equal(GSCart.CATALOG['storefront-build'].once, 450000);
  assert.equal(GSCart.CATALOG['server-care'].monthly, 22500);
  assert.equal(GSCart.CATALOG['db-care'].monthly, 17500);
  assert.equal(GSCart.CATALOG['workspace-admin'].monthly, 19900);

  assert.equal(GSCart.CATALOG['storefront-zero'].name, 'Storefront (zero-down)');
  assert.equal(GSCart.CATALOG['storefront-build'].name, 'Storefront (build + care)');
  assert.equal(GSCart.CATALOG['db-care'].name, 'Database Care');

  assert.equal(GSCart.CATALOG['server-care'].maxQty, 20);
  assert.equal(GSCart.CATALOG['db-care'].maxQty, 20);
  assert.equal(GSCart.CATALOG.lifeline.maxQty, 1);
});

test('adding a second base plan replaces the first', () => {
  let r = GSCart.add([], 'lifeline', 1);
  r = GSCart.add(r.items, 'presence', 1);
  assert.equal(r.replaced, 'Lifeline');
  assert.deepEqual(keys(r.items), ['presence']);
});

test('adding the base plan already in the cart changes nothing', () => {
  const r = GSCart.add([{ key: 'lifeline', qty: 1 }], 'lifeline', 1);
  assert.equal(r.replaced, null);
  assert.deepEqual(r.items, [{ key: 'lifeline', qty: 1 }]);
});

test('a replaced base keeps its place so addons stay below it', () => {
  let r = GSCart.add([], 'storefront-zero', 1);
  r = GSCart.add(r.items, 'server-care', 1);
  r = GSCart.add(r.items, 'storefront-build', 1);
  assert.equal(r.replaced, 'Storefront (zero-down)');
  assert.deepEqual(keys(r.items), ['storefront-build', 'server-care']);
});

test('workspace-admin requires a storefront base', () => {
  assert.throws(() => GSCart.add([{ key: 'lifeline', qty: 1 }], 'workspace-admin', 1), /Storefront/);
  const r = GSCart.add([{ key: 'storefront-zero', qty: 1 }], 'workspace-admin', 1);
  assert.equal(r.items.length, 2);
});

test('addons need a base plan', () => {
  assert.throws(() => GSCart.add([], 'server-care', 1), /plan/i);
});

test('swapping a storefront base for a plain plan drops workspace-admin', () => {
  let r = GSCart.add([], 'storefront-zero', 1);
  r = GSCart.add(r.items, 'workspace-admin', 1);
  r = GSCart.add(r.items, 'lifeline', 1);
  assert.equal(r.replaced, 'Storefront (zero-down)');
  assert.deepEqual(keys(r.items), ['lifeline']);
  assert.deepEqual(r.dropped, ['Workspace Admin']);
});

test('adding a quantity item again raises its quantity, up to the cap', () => {
  let r = GSCart.add([], 'lifeline', 1);
  r = GSCart.add(r.items, 'server-care', 2);
  r = GSCart.add(r.items, 'server-care', 3);
  assert.deepEqual(r.items, [{ key: 'lifeline', qty: 1 }, { key: 'server-care', qty: 5 }]);
  r = GSCart.add(r.items, 'server-care', 20);
  assert.equal(r.items[1].qty, 20);
});

test('add refuses keys we do not sell, inherited ones included', () => {
  assert.throws(() => GSCart.add([], 'nope', 1), /catalog/i);
  assert.throws(() => GSCart.add([], 'constructor', 1), /catalog/i);
});

test('removing the base drops orphaned addons', () => {
  let r = GSCart.add([], 'storefront-zero', 1);
  r = GSCart.add(r.items, 'workspace-admin', 1);
  const out = GSCart.remove(r.items, 'storefront-zero');
  assert.deepEqual(out.items, []);
  assert.deepEqual(out.dropped, ['Workspace Admin']);
});

test('removing an addon leaves the rest of the cart alone', () => {
  let r = GSCart.add([], 'lifeline', 1);
  r = GSCart.add(r.items, 'server-care', 2);
  r = GSCart.add(r.items, 'db-care', 1);
  const out = GSCart.remove(r.items, 'server-care');
  assert.deepEqual(keys(out.items), ['lifeline', 'db-care']);
  assert.deepEqual(out.dropped, []);
});

test('removing the last base takes every addon with it', () => {
  let r = GSCart.add([], 'storefront-build', 1);
  r = GSCart.add(r.items, 'server-care', 1);
  r = GSCart.add(r.items, 'workspace-admin', 1);
  const out = GSCart.remove(r.items, 'storefront-build');
  assert.deepEqual(out.items, []);
  assert.deepEqual(out.dropped, ['Server Care', 'Workspace Admin']);
});

test('totals split monthly and once', () => {
  let r = GSCart.add([], 'storefront-build', 1);
  r = GSCart.add(r.items, 'server-care', 2);
  assert.deepEqual(GSCart.totals(r.items), { monthly: 14900 + 2 * 22500, once: 450000, deposit: 225000 });
});

test('totals of an empty cart are zero', () => {
  assert.deepEqual(GSCart.totals([]), { monthly: 0, once: 0, deposit: 0 });
});

test('qty is clamped and integer', () => {
  let r = GSCart.add([], 'lifeline', 1);
  r = GSCart.add(r.items, 'server-care', 1);
  const items = GSCart.setQty(r.items, 'server-care', 99);
  assert.equal(items.find((i) => i.key === 'server-care').qty, 20);
  assert.equal(GSCart.setQty(items, 'server-care', 0)[1].qty, 1);
  assert.equal(GSCart.setQty(items, 'server-care', 3.7)[1].qty, 3);
  assert.equal(GSCart.setQty(items, 'server-care', 'x')[1].qty, 1);
});

test('nothing is mutated in place', () => {
  const items = [{ key: 'lifeline', qty: 1 }, { key: 'server-care', qty: 2 }];
  const before = JSON.parse(JSON.stringify(items));

  const added = GSCart.add(items, 'db-care', 1);
  const removed = GSCart.remove(items, 'lifeline');
  const requantified = GSCart.setQty(items, 'server-care', 9);
  GSCart.totals(items);
  GSCart.validate(items);

  assert.deepEqual(items, before);
  assert.notEqual(added.items, items);
  assert.notEqual(removed.items, items);
  assert.notEqual(requantified, items);
  assert.notEqual(requantified[1], items[1]);
});

test('validate mirrors the server rules', () => {
  assert.equal(GSCart.validate([]).ok, false);
  assert.equal(GSCart.validate([{ key: 'server-care', qty: 1 }]).ok, false);
  assert.equal(GSCart.validate([{ key: 'lifeline', qty: 1 }]).ok, true);
  assert.equal(GSCart.validate([{ key: 'nope', qty: 1 }]).ok, false);
});

test('validate rejects two base plans and accepts a full storefront cart', () => {
  assert.equal(GSCart.validate([{ key: 'lifeline', qty: 1 }, { key: 'presence', qty: 1 }]).ok, false);
  assert.equal(GSCart.validate([
    { key: 'storefront-zero', qty: 1 },
    { key: 'workspace-admin', qty: 1 },
    { key: 'server-care', qty: 20 }
  ]).ok, true);
});

test('validate rejects workspace-admin without a storefront base', () => {
  const out = GSCart.validate([{ key: 'lifeline', qty: 1 }, { key: 'workspace-admin', qty: 1 }]);
  assert.equal(out.ok, false);
  assert.match(out.error, /Storefront/);
});

test('validate rejects bad quantities, duplicates and oversized carts', () => {
  assert.equal(GSCart.validate([{ key: 'lifeline', qty: 1 }, { key: 'server-care', qty: 21 }]).ok, false);
  assert.equal(GSCart.validate([{ key: 'lifeline', qty: 1 }, { key: 'server-care', qty: 0 }]).ok, false);
  assert.equal(GSCart.validate([{ key: 'lifeline', qty: 1 }, { key: 'server-care', qty: 1.5 }]).ok, false);
  assert.equal(GSCart.validate([{ key: 'lifeline', qty: 1 }, { key: 'server-care', qty: '2' }]).ok, false);
  assert.equal(GSCart.validate([{ key: 'lifeline', qty: 1 }, { key: 'lifeline', qty: 1 }]).ok, false);
  assert.equal(GSCart.validate([{ key: 'constructor', qty: 1 }]).ok, false);
  assert.equal(GSCart.validate('lifeline').ok, false);

  const many = [];
  for (let i = 0; i < 11; i++) many.push({ key: 'lifeline', qty: 1 });
  const out = GSCart.validate(many);
  assert.equal(out.ok, false);
  assert.match(out.error, /10/);
});

test('every validation failure carries a readable message', () => {
  const out = GSCart.validate([{ key: 'server-care', qty: 1 }]);
  assert.equal(out.ok, false);
  assert.equal(typeof out.error, 'string');
  assert.ok(out.error.length > 0);
});

/* ── Clickwrap consent ─────────────────────────────────────────
   The drawer's third gate, after the cart and the phone. The rule lives here
   rather than in js/store.js so it is the same code the tests run, and the
   version string here is the one the whole system is pinned to: the drawer
   label, the Lambda constant, the plate in terms.html and the archived copy
   all have to match it (tests/terms-version.test.mjs). */

test('the terms version is a bare identifier the whole system can share', () => {
  assert.equal(GSCart.TERMS_VERSION, '2026-10');
});

test('an unticked box blocks checkout, and only a real boolean true clears it', () => {
  assert.equal(GSCart.consentOk(true), true);

  /* Everything else is a no, truthy included: a checkbox hands over a real
     boolean, so a 'true' or a 1 arriving here means the value came from
     somewhere it should not have (storage, an attribute, a hand-built body)
     and consent was never actually given. */
  for (const value of [false, undefined, null, 'true', 'on', 1, 0, {}, []]) {
    assert.equal(GSCart.consentOk(value), false);
  }
});

test('the consent refusal carries the same words the drawer shows', () => {
  assert.equal(GSCart.TERMS_ERROR, 'Agree to the Service Terms before checking out.');
});

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
