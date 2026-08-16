/* Tests for the checkout Lambda. The Stripe call is a stub on globalThis.fetch,
   so every assertion here is about what our handler actually sends and returns.
   Env is set before the dynamic import because the handler reads it per call. */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.STRIPE_SECRET_KEY = 'sk_test_stub';
process.env.ALLOWED_ORIGIN = 'https://geniesolos.com';
const PRICE_MAP = {
  lifeline: ['price_l'], presence: ['price_p'], transformation: ['price_t'],
  'storefront-zero': ['price_sz'], 'storefront-build': ['price_sbm', 'price_sbo'],
  'server-care': ['price_sc'], 'db-care': ['price_dc'], 'workspace-admin': ['price_wa'],
};
process.env.PRICE_MAP = JSON.stringify(PRICE_MAP);

const { handler } = await import('../api/checkout/index.mjs');

/* A real request carries a source IP and a user agent; the consent record is
   built from those, never from the body. */
const IP = '198.51.100.7';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36';
const rawEv = (body, extra = {}) => ({
  requestContext: { http: { method: 'POST', path: '/api/checkout', sourceIp: IP } },
  headers: { origin: 'https://geniesolos.com', 'user-agent': UA },
  body, isBase64Encoded: false, ...extra,
});
const ev = (body, extra = {}) => rawEv(JSON.stringify(body), extra);
/* Every cart() body carries a valid phone and a ticked consent box: the
   handler checks cart rules FIRST, the phone second and consent third, so
   rejection tests built from raw {items} bodies fail on the cart before the
   phone is ever looked at, and only the bodies meant to reach Stripe need
   the rest. That order gets its own test. */
const PHONE = '+1 (240) 321-9004';
const PHONE_ERROR = 'Add a phone number so I can reach you before billing starts.';
const TERMS_VERSION = '2026-09';
const TERMS_ERROR = 'Agree to the Service Terms before checking out.';
const STALE_ERROR = 'Your page is out of date. Reload the store and agree to the current Service Terms.';
const CONSENT = { termsAccepted: true, termsVersion: TERMS_VERSION };
const cart = (...items) => ({ items, phone: PHONE, ...CONSENT });
const paramsOf = (call) => new URLSearchParams(call.opts.body);
const orderOf = (call) => paramsOf(call).get('metadata[order]');
const orderJsonOf = (call) => JSON.parse(paramsOf(call).get('metadata[order_json]'));

let lastCall;
let logs;
const realLog = console.log;
const realError = console.error;

beforeEach(() => {
  lastCall = null;
  logs = [];
  console.log = (...a) => logs.push(a.join(' '));
  console.error = (...a) => logs.push(a.join(' '));
  process.env.STRIPE_SECRET_KEY = 'sk_test_stub';
  process.env.PRICE_MAP = JSON.stringify(PRICE_MAP);
  globalThis.fetch = async (url, opts) => {
    lastCall = { url, opts };
    return {
      ok: true, status: 200,
      json: async () => ({ id: 'cs_test_123', url: 'https://checkout.stripe.com/c/s_123' }),
    };
  };
});

after(() => {
  console.log = realLog;
  console.error = realError;
});

test('happy path returns the session url and sends the right params', async () => {
  const res = await handler(ev(cart({ key: 'storefront-build', qty: 1 }, { key: 'server-care', qty: 3 })));
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'application/json');
  assert.equal(JSON.parse(res.body).url, 'https://checkout.stripe.com/c/s_123');

  const p = paramsOf(lastCall);
  assert.equal(p.get('mode'), 'setup');
  assert.equal(p.get('currency'), 'usd');
  assert.equal(p.get('customer_creation'), 'always');
  assert.equal(p.get('consent_collection[terms_of_service]'), 'required');
  /* Stripe rejects phone_number_collection in setup mode outright, so the
     param must never come back. The drawer collects the phone instead. */
  assert.equal(p.get('phone_number_collection[enabled]'), null);
  assert.equal(p.get('success_url'), 'https://geniesolos.com/store?checkout=success');
  assert.equal(p.get('cancel_url'), 'https://geniesolos.com/store?checkout=cancelled');
  assert.equal(p.get('managed_payments[enabled]'), 'false');
  assert.equal(p.get('metadata[order]'), 'storefront-build x1, server-care x3');
  assert.equal(p.get('metadata[phone]'), PHONE);
  assert.equal(p.get('setup_intent_data[metadata][order]'), p.get('metadata[order]'));
  assert.equal(p.get('setup_intent_data[metadata][phone]'), PHONE);
  assert.deepEqual(orderJsonOf(lastCall), [
    { key: 'storefront-build', qty: 1 },
    { key: 'server-care', qty: 3 },
  ]);
});

test('setup mode sends no line items and no price IDs at all', async () => {
  await handler(ev(cart({ key: 'storefront-build', qty: 1 }, { key: 'server-care', qty: 3 })));
  assert.doesNotMatch(lastCall.opts.body, /line_items/);
  assert.doesNotMatch(lastCall.opts.body, /price_/);
});

test('the quantity on a care line is the one from the cart', async () => {
  await handler(ev(cart({ key: 'lifeline', qty: 1 }, { key: 'server-care', qty: 7 })));
  assert.equal(orderOf(lastCall), 'lifeline x1, server-care x7');
  assert.deepEqual(orderJsonOf(lastCall), [
    { key: 'lifeline', qty: 1 },
    { key: 'server-care', qty: 7 },
  ]);
});

test('the Stripe call is authorized, form encoded and bounded by a timeout', async () => {
  await handler(ev(cart({ key: 'lifeline', qty: 1 })));
  assert.equal(lastCall.url, 'https://api.stripe.com/v1/checkout/sessions');
  assert.equal(lastCall.opts.method, 'POST');
  assert.equal(lastCall.opts.headers.Authorization, 'Bearer sk_test_stub');
  assert.equal(lastCall.opts.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.ok(lastCall.opts.signal instanceof AbortSignal);
});

test('the log carries the session id and never the secret', async () => {
  await handler(ev(cart({ key: 'lifeline', qty: 1 })));
  const line = logs.join('\n');
  assert.match(line, /cs_test_123/);
  assert.doesNotMatch(line, /sk_test_stub/);
});

test('anything other than POST is refused', async () => {
  for (const method of ['GET', 'PUT', 'OPTIONS']) {
    const res = await handler(ev(cart({ key: 'lifeline', qty: 1 }), {
      requestContext: { http: { method, path: '/api/checkout' } },
    }));
    assert.equal(res.statusCode, 405);
    assert.equal(res.headers.allow, 'POST');
    assert.equal(lastCall, null);
  }
});

test('a body that is not JSON is refused', async () => {
  for (const body of ['not json', '', undefined]) {
    const res = await handler(rawEv(body));
    assert.equal(res.statusCode, 400);
    assert.equal(res.headers['content-type'], 'application/json');
    assert.ok(JSON.parse(res.body).error.length > 0);
    assert.equal(lastCall, null);
  }
});

test('a base64 body is decoded before it is parsed', async () => {
  const body = Buffer.from(JSON.stringify(cart({ key: 'lifeline', qty: 1 })), 'utf8').toString('base64');
  const res = await handler(rawEv(body, { isBase64Encoded: true }));
  assert.equal(res.statusCode, 200);
  assert.equal(orderOf(lastCall), 'lifeline x1');
});

test('an empty cart is refused', async () => {
  for (const body of [{ items: [] }, {}, { items: 'lifeline' }, { items: null }]) {
    const res = await handler(ev(body));
    assert.equal(res.statusCode, 400);
    assert.equal(lastCall, null);
  }
});

test('keys we do not sell are refused, inherited ones included', async () => {
  for (const key of ['nope', 'constructor', '__proto__', 'toString']) {
    const res = await handler(ev(cart({ key, qty: 1 })));
    assert.equal(res.statusCode, 400);
    assert.equal(lastCall, null);
  }
});

test('two base plans rejected', async () => {
  const res = await handler(ev(cart({ key: 'lifeline', qty: 1 }, { key: 'presence', qty: 1 })));
  assert.equal(res.statusCode, 400);
  assert.equal(lastCall, null);
});

test('workspace-admin without a storefront base is refused', async () => {
  const res = await handler(ev(cart({ key: 'lifeline', qty: 1 }, { key: 'workspace-admin', qty: 1 })));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /Storefront/);
  assert.equal(lastCall, null);
});

test('workspace-admin with a storefront base goes through', async () => {
  const res = await handler(ev(cart({ key: 'storefront-zero', qty: 1 }, { key: 'workspace-admin', qty: 1 })));
  assert.equal(res.statusCode, 200);
  assert.equal(orderOf(lastCall), 'storefront-zero x1, workspace-admin x1');
});

test('an addon without any plan is refused', async () => {
  const res = await handler(ev(cart({ key: 'server-care', qty: 1 })));
  assert.equal(res.statusCode, 400);
  assert.equal(lastCall, null);
});

test('quantities must be whole numbers inside the cap', async () => {
  const bad = [
    [{ key: 'lifeline', qty: 1 }, { key: 'server-care', qty: 21 }],
    [{ key: 'lifeline', qty: 1 }, { key: 'server-care', qty: 0 }],
    [{ key: 'lifeline', qty: 1 }, { key: 'server-care', qty: 1.5 }],
    [{ key: 'lifeline', qty: 1 }, { key: 'server-care', qty: '2' }],
    [{ key: 'lifeline', qty: 2 }],
    [{ key: 'lifeline', qty: 1 }, { key: 'db-care', qty: Infinity }],
  ];
  for (const items of bad) {
    const res = await handler(ev({ items }));
    assert.equal(res.statusCode, 400);
    assert.equal(lastCall, null);
  }
  const ok = await handler(ev(cart({ key: 'lifeline', qty: 1 }, { key: 'db-care', qty: 20 })));
  assert.equal(ok.statusCode, 200);
});

test('a duplicated line and an oversized cart are refused', async () => {
  const dup = await handler(ev(cart({ key: 'lifeline', qty: 1 }, { key: 'lifeline', qty: 1 })));
  assert.equal(dup.statusCode, 400);

  const many = [];
  for (let i = 0; i < 11; i++) many.push({ key: 'lifeline', qty: 1 });
  const big = await handler(ev({ items: many }));
  assert.equal(big.statusCode, 400);
  assert.match(JSON.parse(big.body).error, /10/);
  assert.equal(lastCall, null);
});

test('a missing, short, junk or non-string phone is a 400 with the drawer message', async () => {
  const bad = [
    undefined,               /* missing entirely */
    null,
    2403219004,              /* right digits, wrong type */
    '',
    '   ',
    '123456',                /* six digits: one short */
    '1234567890123456',      /* sixteen digits: one long */
    '+() -. .-',             /* separator junk only: strips to nothing */
    'call me maybe',         /* letters survive the strip and fail */
    '240-321-9004 ext 12',   /* so do extensions */
  ];
  for (const phone of bad) {
    const body = { items: [{ key: 'lifeline', qty: 1 }] };
    if (phone !== undefined) body.phone = phone;
    const res = await handler(ev(body));
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).error, PHONE_ERROR);
    assert.equal(lastCall, null);
  }
});

test('7 and 15 digits are the walls; separators people type are fine', async () => {
  for (const phone of ['1234567', '123456789012345', '+1 (240) 321-9004', '240.321.9004']) {
    const res = await handler(ev({ items: [{ key: 'lifeline', qty: 1 }], phone, ...CONSENT }));
    assert.equal(res.statusCode, 200);
  }
});

test('the phone lands in both metadata params, trimmed but never stripped', async () => {
  const res = await handler(ev({ items: [{ key: 'lifeline', qty: 1 }], phone: '  +1 (240) 321-9004  ', ...CONSENT }));
  assert.equal(res.statusCode, 200);
  const p = paramsOf(lastCall);
  /* The owner dials what the customer wrote: original punctuation, no
     surrounding whitespace, and NOT the bare digit string. */
  assert.equal(p.get('metadata[phone]'), '+1 (240) 321-9004');
  assert.equal(p.get('setup_intent_data[metadata][phone]'), '+1 (240) 321-9004');
});

test('an absurdly punctuated phone over the cap is refused, never truncated', async () => {
  const long = '+1 (240) 321-9004 . . . . . . . . . . . .';
  assert.ok(long.length > 40);
  const res = await handler(ev({ items: [{ key: 'lifeline', qty: 1 }], phone: long }));
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, PHONE_ERROR);
  assert.equal(lastCall, null);
});

test('cart rules run before the phone: a bad cart wins the argument', async () => {
  const res = await handler(ev({ items: [], phone: 'junk' }));
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, 'Your cart is empty.');
  assert.equal(lastCall, null);
});

test('foreign origin rejected', async () => {
  const res = await handler(ev(cart({ key: 'lifeline', qty: 1 }), { headers: { origin: 'https://evil.example' } }));
  assert.equal(res.statusCode, 403);
  assert.equal(lastCall, null);
});

test('the origin header is read whatever its casing', async () => {
  const bad = await handler(ev(cart({ key: 'lifeline', qty: 1 }), { headers: { Origin: 'https://evil.example' } }));
  assert.equal(bad.statusCode, 403);
  const good = await handler(ev(cart({ key: 'lifeline', qty: 1 }), { headers: { Origin: 'https://geniesolos.com' } }));
  assert.equal(good.statusCode, 200);
});

test('a request with no Origin header is allowed, since signed access is the real gate', async () => {
  const res = await handler(ev(cart({ key: 'lifeline', qty: 1 }), { headers: {} }));
  assert.equal(res.statusCode, 200);
});

test('fields the client should not send are ignored, never priced', async () => {
  const res = await handler(ev({
    items: [{ key: 'lifeline', qty: 1, price: 'price_free', amount: 1, price_data: { unit_amount: 1 } }],
    phone: PHONE, ...CONSENT,
    coupon: 'FREE', currency: 'btc', mode: 'payment', success_url: 'https://evil.example',
  }));
  assert.equal(res.statusCode, 200);
  const p = paramsOf(lastCall);
  assert.equal(p.get('mode'), 'setup');
  assert.equal(p.get('success_url'), 'https://geniesolos.com/store?checkout=success');
  assert.deepEqual(orderJsonOf(lastCall), [{ key: 'lifeline', qty: 1 }]);
  assert.doesNotMatch(lastCall.opts.body, /price_data|unit_amount|price_free|coupon|btc|evil/);
});

test('a Stripe rejection becomes a friendly 502', async () => {
  globalThis.fetch = async (url, opts) => {
    lastCall = { url, opts };
    return { ok: false, status: 402, json: async () => ({ error: { message: 'Your card was declined.' } }) };
  };
  const res = await handler(ev(cart({ key: 'lifeline', qty: 1 })));
  assert.equal(res.statusCode, 502);
  assert.equal(res.headers['content-type'], 'application/json');
  assert.equal(
    JSON.parse(res.body).error,
    'Payment setup failed. Nothing was charged. Email geniesolostech@gmail.com if this keeps happening.'
  );
  assert.doesNotMatch(res.body, /sk_test_stub/);
  assert.match(logs.join('\n'), /402/);
});

test('a Stripe call that never lands becomes a friendly 502', async () => {
  globalThis.fetch = async () => { throw new Error('The operation was aborted due to timeout'); };
  const res = await handler(ev(cart({ key: 'lifeline', qty: 1 })));
  assert.equal(res.statusCode, 502);
  assert.match(JSON.parse(res.body).error, /Nothing was charged/);
});

test('a Stripe response without a url is a 502', async () => {
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ id: 'cs_test_123' }) });
  const res = await handler(ev(cart({ key: 'lifeline', qty: 1 })));
  assert.equal(res.statusCode, 502);
});

test('a price map that cannot serve the cart is a configuration failure, not a Stripe call', async () => {
  process.env.PRICE_MAP = JSON.stringify({ lifeline: ['price_l'] });
  const res = await handler(ev(cart({ key: 'lifeline', qty: 1 }, { key: 'server-care', qty: 1 })));
  assert.equal(res.statusCode, 500);
  assert.match(JSON.parse(res.body).error, /Nothing was charged/);
  assert.equal(lastCall, null);
  assert.match(logs.join('\n'), /server-care/);
});

test('a broken price map or a missing secret never reaches Stripe', async () => {
  process.env.PRICE_MAP = '{not json';
  const broken = await handler(ev(cart({ key: 'lifeline', qty: 1 })));
  assert.equal(broken.statusCode, 500);

  process.env.PRICE_MAP = JSON.stringify(PRICE_MAP);
  process.env.STRIPE_SECRET_KEY = '';
  const keyless = await handler(ev(cart({ key: 'lifeline', qty: 1 })));
  assert.equal(keyless.statusCode, 500);
  assert.equal(lastCall, null);
});

test('a separator-padded phone over the cap is refused, never truncated', async () => {
  const padded = '('.repeat(35) + '2403219004';
  const res = await handler(ev({ items: [{ key: 'lifeline', qty: 1 }], phone: padded }));
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, PHONE_ERROR);
  assert.equal(lastCall, null);
});

/* ── Clickwrap consent ─────────────────────────────────────────
   The drawer asserts it, this handler never trusts it, and what ends up in
   the metadata is the record we can produce later: which version, when, from
   where, in what browser. The when and the where are ours, not the client's. */

test('a missing, false or non-boolean termsAccepted is a 400 with the drawer message', async () => {
  const bad = [
    undefined,        /* missing entirely: an old page, or a hand-built body */
    false,            /* the box is there and untouched */
    null,
    'true',           /* truthy, but nobody ticked anything */
    'on',             /* what a raw form post would send */
    1,
    {},
  ];
  for (const termsAccepted of bad) {
    const body = { items: [{ key: 'lifeline', qty: 1 }], phone: PHONE, termsVersion: TERMS_VERSION };
    if (termsAccepted !== undefined) body.termsAccepted = termsAccepted;
    const res = await handler(ev(body));
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).error, TERMS_ERROR);
    assert.equal(lastCall, null);
  }
});

test('a missing, wrong or non-string termsVersion is a 400 naming the stale page', async () => {
  const bad = [
    undefined,        /* a page from before consent shipped */
    '',
    '2026-07',        /* a real version, but not the one we serve */
    '2027-01',
    'v2026-08',       /* the display form, not the identifier */
    2026,
    null,
    { version: '2026-08' },
  ];
  for (const termsVersion of bad) {
    const body = { items: [{ key: 'lifeline', qty: 1 }], phone: PHONE, termsAccepted: true };
    if (termsVersion !== undefined) body.termsVersion = termsVersion;
    const res = await handler(ev(body));
    assert.equal(res.statusCode, 400);
    /* Not the consent message: the box WAS ticked, so telling the visitor to
       tick it would be a lie. The fix is a reload. */
    assert.equal(JSON.parse(res.body).error, STALE_ERROR);
    assert.equal(lastCall, null);
  }
});

test('consent lands in the session and on the SetupIntent, all four fields', async () => {
  const before = new Date().toISOString();
  const res = await handler(ev(cart({ key: 'lifeline', qty: 1 })));
  assert.equal(res.statusCode, 200);

  const p = paramsOf(lastCall);
  assert.equal(p.get('metadata[terms_version]'), TERMS_VERSION);
  assert.equal(p.get('metadata[terms_accepted_ip]'), IP);
  assert.equal(p.get('metadata[terms_user_agent]'), UA);

  const at = p.get('metadata[terms_accepted_at]');
  assert.match(at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.ok(at >= before && at <= new Date().toISOString());

  /* Mirrored onto the SetupIntent the way the phone already is, so the record
     shows on the SetupIntent and customer views too, not only inside the
     session. */
  for (const key of ['terms_version', 'terms_accepted_at', 'terms_accepted_ip', 'terms_user_agent']) {
    assert.equal(p.get(`setup_intent_data[metadata][${key}]`), p.get(`metadata[${key}]`));
  }
});

test('the timestamp and the IP are ours: what the client sends is dropped, never echoed', async () => {
  const res = await handler(ev({
    items: [{ key: 'lifeline', qty: 1 }],
    phone: PHONE, ...CONSENT,
    /* Every shape a forged record could arrive in, camelCase and the
       metadata's own snake_case. */
    termsAcceptedAt: '1999-01-01T00:00:00.000Z',
    termsAcceptedIp: '203.0.113.9',
    termsUserAgent: 'ForgedAgent/1.0',
    terms_accepted_at: '1999-01-01T00:00:00.000Z',
    terms_accepted_ip: '203.0.113.9',
    terms_user_agent: 'ForgedAgent/1.0',
  }));
  assert.equal(res.statusCode, 200);

  const p = paramsOf(lastCall);
  assert.equal(p.get('metadata[terms_accepted_ip]'), IP);
  assert.equal(p.get('metadata[terms_user_agent]'), UA);
  assert.notEqual(p.get('metadata[terms_accepted_at]'), '1999-01-01T00:00:00.000Z');
  assert.match(p.get('metadata[terms_accepted_at]'), /^20[2-9]\d-/);

  /* The point of the feature: none of it survives anywhere in the request. */
  assert.doesNotMatch(lastCall.opts.body, /1999|203\.0\.113\.9|ForgedAgent/);
});

test('a source IP we never got is recorded as missing, not as an empty string', async () => {
  const res = await handler(ev(cart({ key: 'lifeline', qty: 1 }), {
    requestContext: { http: { method: 'POST', path: '/api/checkout' } },
  }));
  assert.equal(res.statusCode, 200);
  const p = paramsOf(lastCall);
  /* An empty value would read as "we looked and there was nothing"; this
     says we never had it, which is the honest record. */
  assert.equal(p.get('metadata[terms_accepted_ip]'), '(unavailable)');
  assert.equal(p.get('setup_intent_data[metadata][terms_accepted_ip]'), '(unavailable)');
});

test('a request with no user agent still records consent', async () => {
  const res = await handler(ev(cart({ key: 'lifeline', qty: 1 }), {
    headers: { origin: 'https://geniesolos.com' },
  }));
  assert.equal(res.statusCode, 200);
  assert.equal(paramsOf(lastCall).get('metadata[terms_user_agent]'), '(none sent)');
});

test('the user agent header is read whatever its casing', async () => {
  const res = await handler(ev(cart({ key: 'lifeline', qty: 1 }), {
    headers: { origin: 'https://geniesolos.com', 'User-Agent': UA },
  }));
  assert.equal(res.statusCode, 200);
  assert.equal(paramsOf(lastCall).get('metadata[terms_user_agent]'), UA);
});

test('an oversized user agent is truncated to the metadata cap, never refused', async () => {
  const long = 'Mozilla/5.0 ' + 'X'.repeat(900);
  assert.ok(long.length > 500);
  const res = await handler(ev(cart({ key: 'lifeline', qty: 1 }), {
    headers: { origin: 'https://geniesolos.com', 'user-agent': long },
  }));
  /* Unlike the phone, a clipped user agent is still a useful record and the
     visitor cannot do anything about their browser's header, so this
     truncates where the phone refuses. */
  assert.equal(res.statusCode, 200);
  const stored = paramsOf(lastCall).get('metadata[terms_user_agent]');
  assert.equal(stored.length, 500);
  assert.equal(stored, long.slice(0, 500));
});

test('cart rules run before the phone, and the phone before consent', async () => {
  /* All three wrong at once: the cart wins. */
  const noCart = await handler(ev({ items: [], phone: 'junk', termsAccepted: false }));
  assert.equal(JSON.parse(noCart.body).error, 'Your cart is empty.');

  /* Cart fixed, phone and consent still wrong: the phone wins. */
  const noPhone = await handler(ev({
    items: [{ key: 'lifeline', qty: 1 }], phone: 'junk', termsAccepted: false,
  }));
  assert.equal(JSON.parse(noPhone.body).error, PHONE_ERROR);

  /* Cart and phone fixed: consent is the only thing left to fix. */
  const noConsent = await handler(ev({ items: [{ key: 'lifeline', qty: 1 }], phone: PHONE }));
  assert.equal(JSON.parse(noConsent.body).error, TERMS_ERROR);

  assert.equal(lastCall, null);
});

test('the document fingerprint lands in both metadata params and is ours alone', async () => {
  const res = await handler(ev({
    items: [{ key: 'lifeline', qty: 1 }],
    phone: PHONE, ...CONSENT,
    /* The client has no say in this one either. */
    termsDocSha256: 'f'.repeat(64),
    terms_doc_sha256: 'f'.repeat(64),
  }));
  assert.equal(res.statusCode, 200);

  const p = paramsOf(lastCall);
  const hash = p.get('metadata[terms_doc_sha256]');
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.notEqual(hash, 'f'.repeat(64));
  assert.equal(p.get('setup_intent_data[metadata][terms_doc_sha256]'), hash);
  assert.doesNotMatch(lastCall.opts.body, /ffffffffff/);
});
