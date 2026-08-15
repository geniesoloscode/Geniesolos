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

const rawEv = (body, extra = {}) => ({
  requestContext: { http: { method: 'POST', path: '/api/checkout' } },
  headers: { origin: 'https://geniesolos.com' },
  body, isBase64Encoded: false, ...extra,
});
const ev = (body, extra = {}) => rawEv(JSON.stringify(body), extra);
const cart = (...items) => ({ items });
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
  assert.equal(p.get('success_url'), 'https://geniesolos.com/store?checkout=success');
  assert.equal(p.get('cancel_url'), 'https://geniesolos.com/store?checkout=cancelled');
  assert.equal(p.get('managed_payments[enabled]'), 'false');
  assert.equal(p.get('metadata[order]'), 'storefront-build x1, server-care x3');
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
