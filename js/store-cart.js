/* Cart rules for the store: the catalog, the add/remove/quantity moves, the
   totals and the same validation the checkout Lambda runs before it prices
   anything. Pure logic, no DOM, so `node --test` can load it as a module and
   the store page can load it as a plain script. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GSCart = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MAX_LINES = 10;

  /* The version of terms.html a visitor is agreeing to, and the one place it
     is written down for the browser. The drawer renders it, sends it with the
     cart, and the Lambda refuses a checkout whose version is not the one it
     knows, so a stale page cannot record consent to a document nobody is
     serving any more. CURRENT_TERMS_VERSION in api/checkout/index.mjs, the
     plate in terms.html and the archived copy under terms/ all carry the same
     string; tests/terms-version.test.mjs fails the build if they drift. */
  var TERMS_VERSION = '2026-08';
  var TERMS_ERROR = 'Agree to the Service Terms before checking out.';

  /* monthly and once are integer cents. kind decides what a line needs in the
     cart beside it: 'addon' needs any plan, 'storefront-addon' needs one of
     the two Storefront plans. */
  var CATALOG = {
    'lifeline':          { name: 'Lifeline',                  monthly: 29900, once: 0,      kind: 'base',             maxQty: 1 },
    'presence':          { name: 'Presence',                  monthly: 64900, once: 0,      kind: 'base',             maxQty: 1 },
    'transformation':    { name: 'Transformation',            monthly: 99900, once: 0,      kind: 'base',             maxQty: 1 },
    'storefront-zero':   { name: 'Storefront (zero-down)',    monthly: 49900, once: 0,      kind: 'storefront-base',  maxQty: 1 },
    'storefront-build':  { name: 'Storefront (build + care)', monthly: 14900, once: 450000, kind: 'storefront-base',  maxQty: 1 },
    'server-care':       { name: 'Server Care',               monthly: 22500, once: 0,      kind: 'addon',            maxQty: 20 },
    'db-care':           { name: 'Database Care',             monthly: 17500, once: 0,      kind: 'addon',            maxQty: 20 },
    'workspace-admin':   { name: 'Workspace Admin',           monthly: 19900, once: 0,      kind: 'storefront-addon', maxQty: 1 }
  };

  /* Own properties only: a key of 'constructor' would otherwise find one. */
  function product(key) {
    return Object.prototype.hasOwnProperty.call(CATALOG, key) ? CATALOG[key] : null;
  }

  function isBase(key) {
    var p = product(key);
    return !!p && (p.kind === 'base' || p.kind === 'storefront-base');
  }

  function isStorefrontBase(key) {
    var p = product(key);
    return !!p && p.kind === 'storefront-base';
  }

  function has(items, test) {
    for (var i = 0; i < items.length; i++) if (test(items[i].key)) return true;
    return false;
  }

  function indexOfKey(items, key) {
    for (var i = 0; i < items.length; i++) if (items[i].key === key) return i;
    return -1;
  }

  function copy(items) {
    var out = [];
    if (!items) return out;
    for (var i = 0; i < items.length; i++) out.push({ key: items[i].key, qty: items[i].qty });
    return out;
  }

  function clampQty(key, qty) {
    var p = product(key);
    var max = p ? p.maxQty : 1;
    var n = Math.floor(Number(qty));
    if (!isFinite(n)) n = 1;
    return Math.min(max, Math.max(1, n));
  }

  /* Addons whose prerequisite has left the cart. Returns the survivors and the
     display names of everything shown the door, in cart order. */
  function prune(items) {
    var base = has(items, isBase);
    var storefront = has(items, isStorefrontBase);
    var kept = [];
    var dropped = [];

    for (var i = 0; i < items.length; i++) {
      var p = product(items[i].key);
      var orphan = !!p && ((p.kind === 'addon' && !base) || (p.kind === 'storefront-addon' && !storefront));
      if (orphan) dropped.push(p.name);
      else kept.push(items[i]);
    }
    return { items: kept, dropped: dropped };
  }

  function add(items, key, qty) {
    var p = product(key);
    if (!p) throw new Error('That item is not in the catalog.');

    var next = copy(items);
    var replaced = null;
    var dropped = [];

    if (isBase(key)) {
      var at = -1;
      for (var i = 0; i < next.length && at < 0; i++) if (isBase(next[i].key)) at = i;

      if (at < 0) next.push({ key: key, qty: 1 });
      else if (next[at].key !== key) {
        replaced = CATALOG[next[at].key].name;
        next[at] = { key: key, qty: 1 };
      }

      var pruned = prune(next);
      next = pruned.items;
      dropped = pruned.dropped;
      return { items: next, replaced: replaced, dropped: dropped };
    }

    if (p.kind === 'storefront-addon' && !has(next, isStorefrontBase)) {
      throw new Error(p.name + ' is only available with a Storefront plan.');
    }
    if (p.kind === 'addon' && !has(next, isBase)) {
      throw new Error(p.name + ' needs a plan in the cart first.');
    }

    var seat = indexOfKey(next, key);
    if (seat < 0) next.push({ key: key, qty: clampQty(key, qty) });
    else next[seat].qty = clampQty(key, next[seat].qty + clampQty(key, qty));

    return { items: next, replaced: replaced, dropped: dropped };
  }

  function remove(items, key) {
    var next = [];
    var current = copy(items);
    for (var i = 0; i < current.length; i++) if (current[i].key !== key) next.push(current[i]);
    return prune(next);
  }

  function setQty(items, key, qty) {
    var next = copy(items);
    for (var i = 0; i < next.length; i++) if (next[i].key === key) next[i].qty = clampQty(key, qty);
    return next;
  }

  function totals(items) {
    var monthly = 0;
    var once = 0;
    var list = items || [];

    for (var i = 0; i < list.length; i++) {
      var p = product(list[i].key);
      if (!p) continue;
      var qty = clampQty(list[i].key, list[i].qty);
      monthly += p.monthly * qty;
      once += p.once * qty;
    }
    return { monthly: monthly, once: once };
  }

  function fail(error) {
    return { ok: false, error: error };
  }

  /* Kept in step with the Lambda: anything this rejects, checkout rejects. */
  function validate(items) {
    if (!Array.isArray(items) || items.length < 1) return fail('Your cart is empty.');
    if (items.length > MAX_LINES) return fail('A cart holds at most ' + MAX_LINES + ' items.');

    var seen = Object.create(null);
    var bases = 0;
    var storefront = false;

    for (var i = 0; i < items.length; i++) {
      var item = items[i] || {};
      var p = product(item.key);
      if (!p) return fail('That item is not in the catalog.');
      if (seen[item.key]) return fail(p.name + ' is in the cart twice.');
      seen[item.key] = true;

      if (typeof item.qty !== 'number' || !isFinite(item.qty) || Math.floor(item.qty) !== item.qty) {
        return fail('Choose a whole number of ' + p.name + '.');
      }
      if (item.qty < 1 || item.qty > p.maxQty) {
        return fail(p.name + ' takes a quantity of 1 to ' + p.maxQty + '.');
      }

      if (isBase(item.key)) bases++;
      if (isStorefrontBase(item.key)) storefront = true;
    }

    if (bases === 0) return fail('Pick a plan before checking out.');
    if (bases > 1) return fail('Pick one plan, not several.');
    if (seen['workspace-admin'] && !storefront) {
      return fail(CATALOG['workspace-admin'].name + ' is only available with a Storefront plan.');
    }
    return { ok: true };
  }

  /* Strict boolean only. A ticked checkbox hands over a real `true`; a 'true'
     or a 1 reaching here came from storage, an attribute or a hand-built
     request body, none of which is a person agreeing to anything. Kept in
     step with the Lambda, which refuses everything but `termsAccepted === true`
     for the same reason. */
  function consentOk(accepted) {
    return accepted === true;
  }

  return {
    CATALOG: CATALOG,
    TERMS_VERSION: TERMS_VERSION,
    TERMS_ERROR: TERMS_ERROR,
    consentOk: consentOk,
    add: add,
    remove: remove,
    setQty: setQty,
    totals: totals,
    validate: validate
  };
});
