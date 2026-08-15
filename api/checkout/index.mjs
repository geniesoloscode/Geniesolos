/* Checkout session Lambda for geniesolos.com.
 *
 * One file, no dependencies, Node 22 ESM. It takes a cart and a phone number
 * from the store drawer, revalidates both under the same rules the browser
 * enforces and opens a Stripe Checkout Session in setup mode: Stripe saves
 * the customer's card and charges nothing. The order and the phone ride
 * along in the session metadata, and the owner starts billing by hand from
 * the dashboard after reviewing it and calling the customer (see "Approving
 * an order" in api/README.md).
 *
 * The client never sends prices. PRICE_MAP still names every sellable key
 * and a cart it cannot serve still fails loudly, but nothing from it is sent
 * to Stripe: no amount is involved here at all.
 *
 * Env:
 *   STRIPE_SECRET_KEY  sk_test_... or sk_live_...
 *   PRICE_MAP          JSON {key: [priceId, ...]}, recurring id first;
 *                      validated here, billed with in the dashboard
 *   ALLOWED_ORIGIN     https://geniesolos.com
 */

const STRIPE_SESSIONS_URL = 'https://api.stripe.com/v1/checkout/sessions';
const STRIPE_TIMEOUT_MS = 10000;
const MAX_LINES = 10;

const SUCCESS_URL = 'https://geniesolos.com/store?checkout=success';
const CANCEL_URL = 'https://geniesolos.com/store?checkout=cancelled';

const PAYMENT_FAILED =
  'Payment setup failed. Nothing was charged. Email geniesolostech@gmail.com if this keeps happening.';

const PHONE_ERROR = 'Add a phone number so I can reach you before billing starts.';
/* Metadata values cap at 500 characters, but a phone has no business being
   long; 40 fits any 15 digit number with punctuation to spare. */
const PHONE_MAX = 40;

/* The rule table, duplicated from js/store-cart.js on purpose: this function
   ships alone, with no bundler and no shared module. Prices are deliberately
   absent, because Stripe holds them and PRICE_MAP points at them. kind decides
   what a line needs beside it: 'addon' needs any plan, 'storefront-addon'
   needs one of the two Storefront plans. */
const CATALOG = {
  'lifeline':          { name: 'Lifeline',                  kind: 'base',             maxQty: 1 },
  'presence':          { name: 'Presence',                  kind: 'base',             maxQty: 1 },
  'transformation':    { name: 'Transformation',            kind: 'base',             maxQty: 1 },
  'storefront-zero':   { name: 'Storefront (zero-down)',    kind: 'storefront-base',  maxQty: 1 },
  'storefront-build':  { name: 'Storefront (build + care)', kind: 'storefront-base',  maxQty: 1 },
  'server-care':       { name: 'Server Care',               kind: 'addon',            maxQty: 20 },
  'db-care':           { name: 'Database Care',             kind: 'addon',            maxQty: 20 },
  'workspace-admin':   { name: 'Workspace Admin',           kind: 'storefront-addon', maxQty: 1 },
};

const owns = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/* Own properties only: a key of 'constructor' would otherwise find one. */
function product(key) {
  return typeof key === 'string' && owns(CATALOG, key) ? CATALOG[key] : null;
}

function isBase(key) {
  const p = product(key);
  return !!p && (p.kind === 'base' || p.kind === 'storefront-base');
}

function isStorefrontBase(key) {
  const p = product(key);
  return !!p && p.kind === 'storefront-base';
}

const fail = (error) => ({ ok: false, error });

/* Kept in step with GSCart.validate in js/store-cart.js: anything the drawer
   refuses, this refuses, with the same words. */
function validateCart(items) {
  if (!Array.isArray(items) || items.length < 1) return fail('Your cart is empty.');
  if (items.length > MAX_LINES) return fail(`A cart holds at most ${MAX_LINES} items.`);

  const seen = Object.create(null);
  let bases = 0;
  let storefront = false;

  for (const raw of items) {
    const item = raw || {};
    const p = product(item.key);
    if (!p) return fail('That item is not in the catalog.');
    if (seen[item.key]) return fail(`${p.name} is in the cart twice.`);
    seen[item.key] = true;

    if (typeof item.qty !== 'number' || !Number.isInteger(item.qty)) {
      return fail(`Choose a whole number of ${p.name}.`);
    }
    if (item.qty < 1 || item.qty > p.maxQty) {
      return fail(`${p.name} takes a quantity of 1 to ${p.maxQty}.`);
    }

    if (isBase(item.key)) bases++;
    if (isStorefrontBase(item.key)) storefront = true;
  }

  if (bases === 0) return fail('Pick a plan before checking out.');
  if (bases > 1) return fail('Pick one plan, not several.');
  if (seen['workspace-admin'] && !storefront) {
    return fail(`${CATALOG['workspace-admin'].name} is only available with a Storefront plan.`);
  }
  return { ok: true };
}

/* The drawer collects the phone itself because Stripe rejects both of its
   own collection knobs in setup mode, verified against the real test-mode
   API on 2026-08-15: phone_number_collection ("You can only enable phone
   number collection in payment and subscription mode.") and custom_fields
   ("`custom_fields` is not supported when `mode=setup`.").

   Kept in step with checkout() in js/store.js: trim, strip the separators
   people type, then require 7 to 15 digits. Returns the trimmed original,
   not the stripped digits, so the owner dials the number as the customer
   wrote it. */
function validPhone(phone) {
  if (typeof phone !== 'string') return null;
  const trimmed = phone.trim();
  /* Over the metadata cap is invalid, not truncatable: slicing a
     separator-padded phone could cut the digits off entirely. */
  if (trimmed.length > PHONE_MAX) return null;
  const digits = trimmed.replace(/[\s().+-]/g, '');
  return /^\d{7,15}$/.test(digits) ? trimmed : null;
}

/* Read per request rather than at import time, so a console env edit takes
   effect on the next invocation instead of the next cold start. */
function config() {
  let priceMap = null;
  try {
    const parsed = JSON.parse(process.env.PRICE_MAP || 'null');
    if (parsed && typeof parsed === 'object') priceMap = parsed;
  } catch {
    priceMap = null;
  }
  return {
    secret: process.env.STRIPE_SECRET_KEY || '',
    allowedOrigin: process.env.ALLOWED_ORIGIN || 'https://geniesolos.com',
    priceMap,
  };
}

function priceIdsFor(priceMap, key) {
  if (!priceMap || !owns(priceMap, key)) return null;
  const ids = priceMap[key];
  if (!Array.isArray(ids) || ids.length < 1) return null;
  if (!ids.every((id) => typeof id === 'string' && id.length > 0)) return null;
  return ids;
}

/* Setup mode takes no line items: Stripe saves the card and charges nothing.
   The cart still has to resolve through PRICE_MAP so catalog drift fails
   loudly here, as a deploy mistake, instead of surfacing when the owner
   tries to bill. The order itself travels in metadata; values cap at 500
   characters and ten short lines fit with room to spare. */
function buildParams(items, priceMap, phone) {
  for (const item of items) {
    if (!priceIdsFor(priceMap, item.key)) {
      throw new Error(`PRICE_MAP has no usable price IDs for ${item.key}`);
    }
  }

  const params = new URLSearchParams();
  params.set('mode', 'setup');
  // Required by the API in setup mode, even though nothing is charged.
  params.set('currency', 'usd');
  // Every session leaves one Customer carrying the saved card, so the
  // dashboard has a single record per order to bill or delete.
  params.set('customer_creation', 'always');
  params.set('success_url', SUCCESS_URL);
  params.set('cancel_url', CANCEL_URL);
  params.set('consent_collection[terms_of_service]', 'required');
  // The Stripe account has Managed Payments on by default, and Managed
  // Payments rejects mode=setup outright ("Invalid mode: setup"), so every
  // session opts out. Verified against the real test-mode API.
  params.set('managed_payments[enabled]', 'false');
  const summary = items.map((i) => `${i.key} x${i.qty}`).join(', ');
  params.set('metadata[order]', summary);
  params.set('metadata[order_json]', JSON.stringify(items));
  // The phone the drawer collected, as the customer wrote it (trimmed, not
  // stripped to digits); the webhook email and the approval call both read
  // it from here.
  params.set('metadata[phone]', phone.slice(0, PHONE_MAX));
  // The same summary and phone again on the SetupIntent itself, so both show
  // directly on the SetupIntent and customer view in the dashboard instead of
  // only inside the session's metadata.
  params.set('setup_intent_data[metadata][order]', summary);
  params.set('setup_intent_data[metadata][phone]', phone.slice(0, PHONE_MAX));
  return params;
}

function headerOf(event, name) {
  const headers = (event && event.headers) || {};
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === name) return headers[key];
  }
  return undefined;
}

function bodyOf(event) {
  const body = event && event.body;
  if (typeof body !== 'string') return '';
  return event.isBase64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body;
}

const json = (statusCode, payload, headers = {}) => ({
  statusCode,
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(payload),
});

/* Stripe's own message, for the log only. Never shown to the customer and
   never carrying the key, which only ever travels in a request header. */
async function stripeErrorText(res) {
  try {
    const body = await res.json();
    const message = body && body.error && body.error.message;
    return typeof message === 'string' ? message : '';
  } catch {
    return '';
  }
}

export const handler = async (event) => {
  const method = event?.requestContext?.http?.method || '';
  if (method !== 'POST') {
    return json(405, { error: 'Use POST to start checkout.' }, { allow: 'POST' });
  }

  const cfg = config();
  const origin = headerOf(event, 'origin');
  if (origin && origin !== cfg.allowedOrigin) {
    return json(403, { error: `Checkout only answers requests from ${cfg.allowedOrigin}.` });
  }

  let payload;
  try {
    payload = JSON.parse(bodyOf(event));
  } catch {
    return json(400, { error: 'That request was not valid JSON.' });
  }

  const check = validateCart(payload && payload.items);
  if (!check.ok) return json(400, { error: check.error });

  /* Cart rules first, then the phone, the same order as the drawer: the
     store surfaces cart problems while the cart is being built, so by the
     time the phone can be wrong it is the only thing left to fix. The tests
     pin this order. */
  const phone = validPhone(payload && payload.phone);
  if (!phone) return json(400, { error: PHONE_ERROR });

  /* Rebuilt from the fields we trust. Anything else the client sent,
     price fields included, is dropped here rather than forwarded. */
  const items = payload.items.map((i) => ({ key: i.key, qty: i.qty }));

  let params;
  try {
    if (!cfg.secret) throw new Error('STRIPE_SECRET_KEY is not set');
    params = buildParams(items, cfg.priceMap, phone);
  } catch (err) {
    console.error('checkout is misconfigured:', err.message);
    return json(500, { error: PAYMENT_FAILED });
  }

  let session;
  try {
    const res = await fetch(STRIPE_SESSIONS_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${cfg.secret}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
      signal: AbortSignal.timeout(STRIPE_TIMEOUT_MS),
    });

    if (!res.ok) {
      console.error('stripe refused the session:', res.status, await stripeErrorText(res));
      return json(502, { error: PAYMENT_FAILED });
    }
    session = await res.json();
  } catch (err) {
    console.error('stripe call failed:', err.message);
    return json(502, { error: PAYMENT_FAILED });
  }

  if (!session || typeof session.url !== 'string' || session.url.length < 1) {
    console.error('stripe returned a session with no url');
    return json(502, { error: PAYMENT_FAILED });
  }

  console.log('checkout session created:', session.id || '(no id)');
  return json(200, { url: session.url });
};
