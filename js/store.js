/* Store page behavior: theme toggle, reveal-on-scroll, the cart drawer, and
   the call to /api/checkout. External rather than inline because the
   CloudFront CSP is script-src 'self' plus exactly one hash, and that hash
   belongs to the theme snippet in the document head.

   All cart RULES live in js/store-cart.js (window.GSCart), which is loaded
   first and is the same file the unit tests run. This file only moves state
   between localStorage, the DOM, and the checkout API. */
(function () {
  'use strict';

  var $  = function (sel, ctx) { return (ctx || document).querySelector(sel); };
  var $$ = function (sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); };

  /* ─────────────────────────────────────────────────────────────
     0. THEME
     Same standalone logic as js/terms.js: this page has no other
     script, and the pre-paint snippet in <head> only sets the
     attribute, it does not wire the control.
     ───────────────────────────────────────────────────────────── */
  (function theme() {
    var btn = document.getElementById('themeToggle');
    if (!btn) return;

    var meta = document.getElementById('themeColor');
    var root = document.documentElement;

    function apply(name, persist) {
      if (name === 'dark') root.setAttribute('data-theme', 'dark');
      else root.removeAttribute('data-theme');

      btn.setAttribute('aria-checked', String(name === 'dark'));
      btn.setAttribute('aria-label', name === 'dark' ? 'Light theme' : 'Dark theme');
      if (meta) meta.setAttribute('content', name === 'dark' ? '#060807' : '#FAF5EC');

      if (persist) {
        try { localStorage.setItem('gs-theme', name); } catch (e) { /* private mode */ }
      }
    }

    function current() {
      return root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    }

    apply(current(), false);
    btn.addEventListener('click', function () {
      apply(current() === 'dark' ? 'light' : 'dark', true);
    });

    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    var onSystem = function (e) {
      var chosen = null;
      try { chosen = localStorage.getItem('gs-theme'); } catch (err) { /* ignore */ }
      if (!chosen) apply(e.matches ? 'dark' : 'light', false);
    };
    if (mq.addEventListener) mq.addEventListener('change', onSystem);
    else if (mq.addListener) mq.addListener(onSystem);
  })();

  /* ?still=1: the screenshot mode the homepage uses. Everything settled,
     nothing looping, all reveals already in. */
  var still = /(^|[?&])still=1\b/.test(location.search);
  if (still) document.documentElement.classList.add('still');

  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ─────────────────────────────────────────────────────────────
     1. REVEAL ON SCROLL
     Its own observer: this page never loads js/main.js.
     ───────────────────────────────────────────────────────────── */
  (function reveals() {
    var targets = $$('[data-reveal]');
    if (!targets.length) return;

    if (still || reduced || !('IntersectionObserver' in window)) {
      targets.forEach(function (el) { el.classList.add('in'); });
      return;
    }

    var io = new IntersectionObserver(function (entries, obs) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        en.target.classList.add('in');
        obs.unobserve(en.target);
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -60px' });

    targets.forEach(function (el) {
      var sibs = Array.prototype.filter.call(el.parentNode.children, function (n) {
        return n.hasAttribute('data-reveal');
      });
      el.style.transitionDelay = Math.min(sibs.indexOf(el), 5) * 70 + 'ms';
      io.observe(el);
    });
  })();

  /* ─────────────────────────────────────────────────────────────
     2. CART
     ───────────────────────────────────────────────────────────── */
  var Cart = window.GSCart;
  if (!Cart) return;                     /* rules missing: leave a static page */

  var STORE_KEY = 'gs-cart';
  var API = '/api/checkout';
  var FALLBACK_ERR = 'Checkout is unavailable right now. Nothing was charged. ' +
                     'Please try again in a moment, or email geniesolostech@gmail.com.';

  var items = [];

  var fab        = $('#cartFab');
  var badge      = $('#cartBadge');
  var live       = $('#cartLive');
  var toastsEl   = $('#toasts');
  var drawer     = $('#cartDrawer');
  var panel      = $('.drawer__panel', drawer);
  var linesEl    = $('#cartLines');
  var emptyEl    = $('#cartEmpty');
  var monthlyEl  = $('#totalMonthly');
  var onceEl     = $('#totalOnce');
  var onceRow    = $('#onceRow');
  var errEl      = $('#cartError');
  var goBtn      = $('#checkoutBtn');
  var goLabel    = $('.drawer__go-label', goBtn);

  /* ── storage ─────────────────────────────────────────────── */
  function load() {
    var raw = null;
    try { raw = localStorage.getItem(STORE_KEY); } catch (e) { return []; }
    if (!raw) return [];

    var parsed = null;
    try { parsed = JSON.parse(raw); } catch (e) { return []; }   /* bad JSON: start clean */
    if (!parsed || parsed.v !== 1 || !Array.isArray(parsed.items)) return [];

    var out = [];
    for (var i = 0; i < parsed.items.length; i++) {
      var it = parsed.items[i] || {};
      if (!Object.prototype.hasOwnProperty.call(Cart.CATALOG, it.key)) continue;
      var qty = Math.floor(Number(it.qty));
      if (!isFinite(qty) || qty < 1) qty = 1;
      out.push({ key: it.key, qty: Math.min(qty, Cart.CATALOG[it.key].maxQty) });
    }
    /* A stored cart can violate the rules if the catalog changed under it;
       setQty is a no-op filter here, so lean on validate at checkout time. */
    return out;
  }

  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ v: 1, items: items }));
    } catch (e) { /* private mode: the cart lives for this page view only */ }
  }

  /* ── formatting ──────────────────────────────────────────── */
  function money(cents) {
    var whole = Math.floor(Math.abs(cents) / 100);
    var rest = Math.abs(cents) % 100;
    var out = '$' + String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    if (rest) out += '.' + (rest < 10 ? '0' + rest : String(rest));
    return (cents < 0 ? '-' : '') + out;
  }

  function names(list) {
    if (list.length === 1) return list[0];
    return list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1];
  }

  /* ── cart lookups ────────────────────────────────────────── */
  function lineFor(key) {
    for (var i = 0; i < items.length; i++) if (items[i].key === key) return items[i];
    return null;
  }

  /* The rules clamp on the way in; the page clamps on the way out so a
     display can never show a number the cart would refuse. */
  function clampQty(key, qty) {
    var p = Cart.CATALOG[key];
    var max = p ? p.maxQty : 1;
    var n = Math.floor(Number(qty));
    if (!isFinite(n)) n = 1;
    return Math.min(max, Math.max(1, n));
  }

  /* Never say "Server Care" when the visitor is buying three of them. */
  function withQty(key, qty) {
    var p = Cart.CATALOG[key];
    return p.maxQty > 1 ? p.name + ' ×' + qty : p.name;
  }

  /* ── toasts ──────────────────────────────────────────────── */
  function toast(msg, kind) {
    if (!toastsEl) return;

    while (toastsEl.children.length > 2) toastsEl.removeChild(toastsEl.firstChild);

    var el = document.createElement('p');
    el.className = 'toast' + (kind ? ' toast--' + kind : '');
    el.textContent = msg;
    toastsEl.appendChild(el);

    setTimeout(function () {
      el.classList.add('is-going');
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 320);
    }, 4600);
  }

  /* ── stepper widget (shared by the cards and the drawer) ─── */
  /* Static markup, so the same glyphs as the cards' hand-written steppers
     rather than a text hyphen that sits half a pixel off centre. */
  var ICON_MINUS = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">' +
    '<path d="M5 12h14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';
  var ICON_PLUS = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">' +
    '<path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';
  /* Smaller than the minus on purpose: at quantity one the minus becomes a
     remove control, and the size shift plus the red tint mark the change. */
  var ICON_X = '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">' +
    '<path d="M7 7l10 10M17 7 7 17" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';

  function makeStepper(key, qty, label, fidPrefix) {
    var max = Cart.CATALOG[key].maxQty;
    var wrap = document.createElement('div');
    wrap.className = 'stepper';

    /* A disabled minus at quantity one is a dead end; instead it stays live
       and removes the line, which is what "one fewer than one" means. */
    var minus = document.createElement('button');
    minus.type = 'button';
    minus.className = 'stepper__btn' + (qty <= 1 ? ' stepper__btn--rm' : '');
    minus.setAttribute('aria-label', qty <= 1 ? 'Remove ' + label + ' from the cart'
                                              : 'One fewer ' + label);
    minus.setAttribute('data-fid', fidPrefix + '-minus-' + key);
    minus.innerHTML = qty <= 1 ? ICON_X : ICON_MINUS;

    var val = document.createElement('output');
    val.className = 'stepper__val';
    val.textContent = String(qty);
    val.setAttribute('aria-label', label + ' quantity');

    var plus = document.createElement('button');
    plus.type = 'button';
    plus.className = 'stepper__btn';
    plus.setAttribute('aria-label', 'One more ' + label);
    plus.setAttribute('data-fid', fidPrefix + '-plus-' + key);
    plus.innerHTML = ICON_PLUS;
    plus.disabled = qty >= max;

    wrap.appendChild(minus);
    wrap.appendChild(val);
    wrap.appendChild(plus);

    minus.addEventListener('click', function () {
      if (qty <= 1) removeKey(key);
      else setQty(key, qty - 1);
    });
    plus.addEventListener('click', function () { setQty(key, qty + 1); });
    return wrap;
  }

  /* ── drawer line items ───────────────────────────────────── */
  function lineNode(item) {
    var p = Cart.CATALOG[item.key];

    var li = document.createElement('li');
    li.className = 'line';

    var name = document.createElement('p');
    name.className = 'line__name';
    name.textContent = p.name;

    var sum = document.createElement('p');
    sum.className = 'line__sum';
    sum.textContent = money(p.monthly * item.qty) + '/mo';

    li.appendChild(name);
    li.appendChild(sum);

    var bits = [];
    if (p.maxQty > 1) bits.push(money(p.monthly) + '/month each');
    if (p.once) bits.push(money(p.once * item.qty) + ' due today');
    if (bits.length) {
      var meta = document.createElement('p');
      meta.className = 'line__meta';
      meta.textContent = bits.join('  ·  ');
      li.appendChild(meta);
    }

    var ctl = document.createElement('div');
    ctl.className = 'line__ctl';
    if (p.maxQty > 1) ctl.appendChild(makeStepper(item.key, item.qty, p.name, 'line'));

    var rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'line__rm';
    rm.innerHTML = ICON_X + '<span>Remove</span>';
    rm.setAttribute('aria-label', 'Remove ' + p.name + ' from the cart');
    rm.setAttribute('data-fid', 'line-rm-' + item.key);
    rm.addEventListener('click', function () { removeKey(item.key); });
    ctl.appendChild(rm);

    li.appendChild(ctl);
    return li;
  }

  /* ── render ──────────────────────────────────────────────── */
  function render() {
    /* Rebuilding the list throws away focus, so remember which control had
       it and hand it back to the control with the same identity. */
    var active = document.activeElement;
    var fid = active && active.getAttribute ? active.getAttribute('data-fid') : null;
    /* When a removal takes the whole line with it, remember where that line
       sat so focus can land on the neighbour that slides into its place. */
    var lineAt = -1;
    if (fid && active.closest) {
      var lineEl = active.closest('.line');
      if (lineEl) lineAt = $$('.line', linesEl).indexOf(lineEl);
    }

    while (linesEl.firstChild) linesEl.removeChild(linesEl.firstChild);
    items.forEach(function (item) { linesEl.appendChild(lineNode(item)); });

    emptyEl.hidden = items.length > 0;

    var t = Cart.totals(items);
    monthlyEl.textContent = money(t.monthly);
    onceEl.textContent = money(t.once);
    onceRow.hidden = t.once === 0;

    var count = items.length;
    badge.textContent = String(count);
    fab.classList.toggle('is-empty', count === 0);
    fab.setAttribute('aria-label', count === 0
      ? 'Cart, empty'
      : 'Cart, ' + count + (count === 1 ? ' item' : ' items'));

    live.textContent = count === 0
      ? 'Cart is empty.'
      : 'Cart: ' + count + (count === 1 ? ' item, ' : ' items, ') + money(t.monthly) + ' per month' +
        (t.once ? ', ' + money(t.once) + ' due today' : '') + '.';

    /* `busy` guards the button too: a storage event from another tab can
       re-render mid-checkout and must not resurrect a live Checkout. */
    goBtn.disabled = busy || count === 0;
    syncCards();

    if (fid) {
      var back = linesEl.querySelector('[data-fid="' + fid + '"]');
      if (back && !back.disabled) back.focus();
      else if (drawer.classList.contains('is-open')) {
        if (back) {
          $('#drawerClose').focus();       /* still present, just disabled */
        } else {
          /* the control left with its line: aim at the line now in that
             slot, the last line if it was last, or the empty state */
          var linesNow = $$('.line', linesEl);
          if (linesNow.length) {
            var at = Math.max(0, Math.min(lineAt, linesNow.length - 1));
            var rmNext = $('.line__rm', linesNow[at]);
            if (rmNext) rmNext.focus();
            else $('#drawerClose').focus();
          } else {
            emptyEl.focus();
          }
        }
      }
    }
  }

  /* Card buttons follow the same prerequisites the rules enforce, so a
     disabled button is never the only thing standing between a visitor and
     an error message: the hint says why. */
  function syncCards() {
    var hasBase = false;
    var hasStorefront = false;
    items.forEach(function (it) {
      var kind = Cart.CATALOG[it.key].kind;
      if (kind === 'base' || kind === 'storefront-base') hasBase = true;
      if (kind === 'storefront-base') hasStorefront = true;
    });

    $$('.add').forEach(function (btn) {
      var key = btn.getAttribute('data-key');
      var p = Cart.CATALOG[key];
      if (!p) return;

      var card = btn.closest('.card');
      var line = lineFor(key);
      var inCart = !!line;
      if (card) card.classList.toggle('is-in', inCart);

      var locked = (p.kind === 'addon' && !hasBase) ||
                   (p.kind === 'storefront-addon' && !hasStorefront);
      btn.disabled = locked;
      if (card) card.classList.toggle('is-locked', locked);

      /* The card's stepper is the cart line whenever there is one, so the
         number on the card is the number on the invoice. With nothing in the
         cart it goes back to being a chooser for the next add. */
      var stepper = card ? $('.stepper[data-stepper]', card) : null;
      var shown = 1;
      if (stepper) {
        var out = $('[data-qty]', stepper);
        if (out) {
          shown = clampQty(key, inCart ? line.qty : out.textContent);
          out.textContent = String(shown);
        }
        $$('.stepper__btn', stepper).forEach(function (b) {
          var step = Number(b.getAttribute('data-step'));
          if (step < 0) {
            /* On an in-cart card the minus never dead-ends: at one it
               becomes the remove control. As a plain chooser (nothing in
               the cart yet) it still stops at one. */
            var asRemove = inCart && shown <= 1;
            b.disabled = locked || (!inCart && shown <= 1);
            if (b.classList.contains('stepper__btn--rm') !== asRemove) {
              b.classList.toggle('stepper__btn--rm', asRemove);
              b.innerHTML = asRemove ? ICON_X : ICON_MINUS;
              b.setAttribute('aria-label', asRemove
                ? 'Remove ' + p.name + ' from the cart'
                : b.getAttribute('data-label-default') || 'One fewer ' + p.name);
            }
          } else {
            b.disabled = locked || shown >= p.maxQty;
          }
        });
      }

      var hint = card ? $('.card__hint', card) : null;
      if (hint) {
        hint.classList.toggle('is-lit', locked);
        var inCartText = p.maxQty > 1 ? '×' + shown + ' in your cart' : 'In your cart';
        hint.textContent = locked ? hint.getAttribute('data-locked')
                                  : (inCart ? inCartText : 'Ready to add');
      }

      /* the card-level exit only shows while there is something to exit */
      var rmLink = card ? $('.card__rm', card) : null;
      if (rmLink) rmLink.hidden = !inCart;
    });
  }

  /* ── mutations ───────────────────────────────────────────── */
  /* The card stepper is an absolute quantity, not an increment, so a second
     Add on a line the cart already holds SETS that number. Routing it through
     Cart.add would add the picked quantity to the quantity already there and
     charge for a number nobody chose. */
  function addKey(key, qty, btn) {
    if (!Object.prototype.hasOwnProperty.call(Cart.CATALOG, key)) return;

    var before = JSON.stringify(items);
    var wanted = clampQty(key, qty);
    var held = lineFor(key);

    if (held) {
      items = Cart.setQty(items, key, wanted);
      save();
      toast(JSON.stringify(items) === before
        ? withQty(key, wanted) + (Cart.CATALOG[key].maxQty > 1 ? ' is already your cart quantity.'
                                                              : ' is already in your cart.')
        : withQty(key, wanted) + ' in your cart.');
    } else {
      var result;
      try {
        result = Cart.add(items, key, wanted);
      } catch (e) {
        toast(e.message, 'warn');
        return;
      }

      items = result.items;
      save();

      if (result.replaced) {
        toast('Swapped ' + result.replaced + ' for ' + Cart.CATALOG[key].name + '. One plan at a time.', 'warn');
      }
      if (result.dropped && result.dropped.length) {
        toast('Removed ' + names(result.dropped) + ': it needs a Storefront plan.', 'warn');
      }
      if (!result.replaced && (!result.dropped || !result.dropped.length)) {
        /* Read the quantity back off the cart rather than off the click: the
           rules clamp, and a toast that overstates it is the same lie. */
        var landed = lineFor(key);
        toast('Added ' + withQty(key, landed ? landed.qty : wanted) + ' to your cart.');
      }
    }

    if (btn) {
      var label = $('.add__label', btn);
      if (label) {
        btn.classList.add('is-added');
        label.textContent = !held ? 'Added'
                          : (JSON.stringify(items) === before ? 'In cart' : 'Updated');
        setTimeout(function () {
          btn.classList.remove('is-added');
          label.textContent = 'Add to cart';
        }, 1500);
      }
    }

    fab.classList.remove('is-bumped');
    void fab.offsetWidth;                 /* restart the bump animation */
    fab.classList.add('is-bumped');

    hideError();
    render();
  }

  function removeKey(key) {
    var name = Cart.CATALOG[key].name;
    var out = Cart.remove(items, key);
    items = out.items;
    save();

    if (out.dropped && out.dropped.length) {
      toast('Removed ' + name + ', and ' + names(out.dropped) + ' with it.', 'warn');
    } else {
      toast('Removed ' + name + '.');
    }
    hideError();
    render();
  }

  function setQty(key, qty) {
    items = Cart.setQty(items, key, qty);
    save();
    hideError();
    render();
  }

  /* Another tab can rewrite the cart at any moment, and acting on a stale
     copy here would resurrect lines the visitor already removed there. The
     storage event fires only in the tabs that did NOT write, so re-loading
     and re-rendering can never feed back. A null key is a wholesale clear. */
  window.addEventListener('storage', function (e) {
    if (e.key !== null && e.key !== STORE_KEY) return;
    items = load();
    render();
  });

  /* ── drawer ──────────────────────────────────────────────── */
  var lastFocus = null;

  function focusables() {
    return $$('button, [href], input, select, textarea, output[tabindex]', panel)
      .filter(function (el) { return !el.disabled && el.offsetParent !== null; });
  }

  function openDrawer() {
    if (drawer.classList.contains('is-open')) return;
    lastFocus = document.activeElement;
    drawer.classList.add('is-open');
    fab.setAttribute('aria-expanded', 'true');
    var close = $('#drawerClose');
    if (close) close.focus();
  }

  function closeDrawer() {
    if (!drawer.classList.contains('is-open')) return;
    drawer.classList.remove('is-open');
    fab.setAttribute('aria-expanded', 'false');
    if (lastFocus && lastFocus.focus) lastFocus.focus();
    else fab.focus();
    lastFocus = null;
  }

  fab.addEventListener('click', openDrawer);
  $('#drawerClose').addEventListener('click', closeDrawer);
  $('#drawerScrim').addEventListener('click', closeDrawer);

  document.addEventListener('keydown', function (e) {
    if (!drawer.classList.contains('is-open')) return;

    if (e.key === 'Escape') { e.preventDefault(); closeDrawer(); return; }
    if (e.key !== 'Tab') return;

    /* keep Tab inside the dialog while it is modal */
    var list = focusables();
    if (!list.length) return;
    var first = list[0];
    var last = list[list.length - 1];

    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    else if (!panel.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
  });

  /* ── errors in the drawer ────────────────────────────────── */
  function showError(msg) {
    errEl.textContent = msg;
    errEl.hidden = false;
  }
  function hideError() {
    errEl.textContent = '';
    errEl.hidden = true;
  }

  /* ── checkout ────────────────────────────────────────────── */
  var busy = false;

  function setBusy(state) {
    busy = state;
    goBtn.disabled = state || items.length === 0;
    goLabel.textContent = state ? 'Redirecting…' : 'Checkout';
  }

  /* CloudFront's origin access control signs the request to the Lambda function
     URL with sigv4, but it does NOT hash the body: it forwards whatever
     x-amz-content-sha256 the viewer sent and signs that value. Lambda function
     URLs reject UNSIGNED-PAYLOAD, so a POST with no such header is a 403 that
     never reaches the handler. The header is same-origin and on the sigv4
     safelist, so it triggers no preflight.

     Insecure origins have no crypto.subtle. There the header is omitted rather
     than thrown: local http:// testing hits a dev server, not OAC, and the
     shipped site is https where the digest always exists. */
  function bodyHash(body) {
    var subtle = window.crypto && window.crypto.subtle;
    if (!subtle || typeof window.TextEncoder !== 'function') return Promise.resolve(null);

    var digest;
    try {
      digest = subtle.digest('SHA-256', new TextEncoder().encode(body));
    } catch (e) {
      return Promise.resolve(null);
    }
    if (!digest || typeof digest.then !== 'function') return Promise.resolve(null);

    return digest.then(function (buf) {
      var bytes = new Uint8Array(buf);
      var hex = '';
      for (var i = 0; i < bytes.length; i++) {
        hex += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
      }
      return hex;
    }, function () { return null; });
  }

  function checkout() {
    if (busy) return;
    hideError();

    var check = Cart.validate(items);
    if (!check.ok) { showError(check.error); return; }

    setBusy(true);

    var payload = { items: items.map(function (it) { return { key: it.key, qty: it.qty }; }) };
    var body = JSON.stringify(payload);

    /* The hash must cover the exact bytes sent, so hash `body` and post `body`. */
    bodyHash(body).then(function (hash) {
      var headers = { 'content-type': 'application/json' };
      if (hash) headers['x-amz-content-sha256'] = hash;
      return fetch(API, { method: 'POST', headers: headers, body: body });
    }).then(function (res) {
      return res.json().then(function (data) { return { ok: res.ok, data: data }; },
                             function () { return { ok: res.ok, data: {} }; });
    }).then(function (out) {
      /* Any non-200 is the same story to the visitor: the body carries a
         friendly sentence, and if it does not, ours does. */
      if (out.ok && out.data && out.data.url) {
        location.assign(out.data.url);
        return;                            /* stay disabled through the redirect */
      }
      showError((out.data && out.data.error) || FALLBACK_ERR);
      setBusy(false);
    }).catch(function () {
      showError(FALLBACK_ERR);
      setBusy(false);
    });
  }

  goBtn.addEventListener('click', checkout);

  /* Leaving for Stripe deliberately leaves the button disabled and reading
     "Redirecting…". Coming back with the browser's Back button can restore this
     page from the bfcache with that state frozen in place and no script rerun,
     which would strand the visitor at a dead Checkout button. A persisted
     pageshow is the one signal for that, so undo the redirect state there. */
  window.addEventListener('pageshow', function (e) {
    if (!e.persisted) return;
    hideError();
    setBusy(false);
  });

  /* ── card wiring ─────────────────────────────────────────── */
  $$('.card__hint').forEach(function (h) { h.setAttribute('data-locked', h.textContent.trim()); });

  /* Once a line is in the cart its card stepper edits the cart directly, the
     same as the stepper in the drawer. Before that it is a chooser for the
     quantity the next Add will use. Either way the card and the cart show one
     number, because syncCards writes the cart's quantity back here. */
  $$('.stepper[data-stepper]').forEach(function (st) {
    var key = st.getAttribute('data-stepper');
    var out = $('[data-qty]', st);
    if (!Cart.CATALOG[key] || !out) return;

    $$('.stepper__btn', st).forEach(function (btn) {
      /* syncCards swaps the minus into a remove control at quantity one;
         keep the words it needs to put back afterwards. */
      btn.setAttribute('data-label-default', btn.getAttribute('aria-label'));
      btn.addEventListener('click', function () {
        var step = Number(btn.getAttribute('data-step'));
        var line = lineFor(key);
        if (line && line.qty <= 1 && step < 0) {
          /* at one, the in-cart card's minus removes, same as the drawer;
             afterwards the stepper is a chooser again, back at one */
          removeKey(key);
        } else if (line) {
          setQty(key, clampQty(key, Number(out.textContent) + step));
        } else {
          out.textContent = String(clampQty(key, Number(out.textContent) + step));
          syncCards();
        }
        /* Hitting a bound disables the button under the pointer; keyboard
           focus must not fall off the page with it. */
        if (btn.disabled) {
          var other = $$('.stepper__btn', st).filter(function (b) { return b !== btn && !b.disabled; })[0];
          if (other) other.focus();
        }
      });
    });
  });

  $$('.add').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var key = btn.getAttribute('data-key');
      var card = btn.closest('.card');
      var st = card ? $('.stepper[data-stepper]', card) : null;
      var qty = st ? Number($('[data-qty]', st).textContent) : 1;
      addKey(key, qty, btn);
    });
  });

  /* Every in-cart card carries its own way out, next to Add. A separate
     control rather than a toggle on Add itself: an accidental double-click
     on Add must never turn into a removal. syncCards shows and hides it. */
  $$('.add').forEach(function (btn) {
    var key = btn.getAttribute('data-key');
    if (!Object.prototype.hasOwnProperty.call(Cart.CATALOG, key)) return;
    var card = btn.closest('.card');
    if (!card) return;

    var rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'card__rm';
    rm.innerHTML = ICON_X + '<span>Remove from cart</span>';
    rm.setAttribute('aria-label', 'Remove ' + Cart.CATALOG[key].name + ' from the cart');
    rm.hidden = true;
    rm.addEventListener('click', function () {
      removeKey(key);
      /* the link hides itself with the removal; keyboard focus must not
         fall off the page with it */
      if (rm.hidden && !btn.disabled) btn.focus();
    });
    btn.parentNode.insertBefore(rm, btn.nextSibling);
  });

  /* ─────────────────────────────────────────────────────────────
     3. RETURN FROM STRIPE
     ───────────────────────────────────────────────────────────── */
  function stateParam(name) {
    var m = new RegExp('[?&]' + name + '=([^&#]*)').exec(location.search);
    return m ? decodeURIComponent(m[1]) : null;
  }

  function stripParam(name) {
    var search = location.search
      .replace(new RegExp('([?&])' + name + '=[^&#]*(&|$)'), '$1')
      .replace(/[?&]$/, '');
    if (search === '?') search = '';
    try {
      history.replaceState(null, '', location.pathname + search + location.hash);
    } catch (e) { /* file:// and old browsers: leave the URL alone */ }
  }

  function showState(kind) {
    var wrap = $('#checkoutState');
    var panelEl = $('#statePanel');

    if (kind === 'success') {
      panelEl.classList.remove('state--cancel');
      $('#stateMark').textContent = 'Order received';
      $('#stateTitle').textContent = 'You are in. Welcome aboard.';
      $('#stateText').textContent =
        'Stripe has your subscription and the receipt is on its way to your inbox. ' +
        'I will email you within one business day to schedule onboarding and collect the access I need. ' +
        'You can cancel or update your card any time from the billing portal link in that receipt.';
    } else {
      panelEl.classList.add('state--cancel');
      $('#stateMark').textContent = 'Checkout cancelled';
      $('#stateTitle').textContent = 'No charge was made.';
      $('#stateText').textContent =
        'Your cart is exactly where you left it, so you can pick up where you stopped. ' +
        'If something in the pricing did not fit, tell me what you need and I will quote it.';
    }

    wrap.hidden = false;
    document.body.classList.add('has-state');
  }

  /* ─────────────────────────────────────────────────────────────
     4. BOOT
     ───────────────────────────────────────────────────────────── */

  /* Screenshot helper: seeds a demo cart so the drawer can be captured with
     real content. Local files only, so it can never fire on the live site. */
  var seeded = location.protocol === 'file:' && /(^|[?&])seed=demo\b/.test(location.search);

  items = seeded
    ? [{ key: 'storefront-build', qty: 1 }, { key: 'server-care', qty: 2 }, { key: 'workspace-admin', qty: 1 }]
    : load();

  (function returnState() {
    var state = stateParam('checkout');
    if (state !== 'success' && state !== 'cancelled') return;

    if (state === 'success') {
      items = [];                    /* paid for: the cart's work is done */
      save();
    }
    showState(state);
    stripParam('checkout');          /* a refresh must not repeat the message */
  })();

  render();

  if (seeded) {
    drawer.classList.add('is-open');
    fab.setAttribute('aria-expanded', 'true');
  }
})();
