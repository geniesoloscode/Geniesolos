/* Tests for the order-notification webhook Lambda. deps.publish is stubbed,
   so nothing reaches SNS or the network; the sign() helper signs bodies
   exactly as Stripe does (HMAC-SHA256 of `${t}.${rawBody}` with the whsec_
   secret). Env is set before the dynamic import; the handler reads it per
   call. */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

const SECRET = 'whsec_suite_secret';
const TOPIC = 'arn:aws:sns:us-east-1:000000000000:orders-test';
process.env.STRIPE_WEBHOOK_SECRET = SECRET;
process.env.ORDERS_TOPIC_ARN = TOPIC;

const { handler, deps } = await import('../api/webhook/index.mjs');

const now = () => Math.floor(Date.now() / 1000);

const sign = (rawBody, { secret = SECRET, ts = now() } = {}) =>
  `t=${ts},v1=${createHmac('sha256', secret).update(`${ts}.${rawBody}`, 'utf8').digest('hex')}`;

const ev = (rawBody, extra = {}) => ({
  requestContext: { http: { method: 'POST', path: '/' } },
  headers: { 'stripe-signature': sign(rawBody) },
  body: rawBody,
  isBase64Encoded: false,
  ...extra,
});

const completed = ({ livemode = false, order = 'storefront-build x1, server-care x3' } = {}) =>
  JSON.stringify({
    id: 'evt_test_1',
    type: 'checkout.session.completed',
    livemode,
    data: {
      object: {
        id: 'cs_abc123',
        customer: 'cus_abc123',
        customer_details: { name: 'Ada Lovelace', email: 'ada@example.com' },
        metadata: {
          order,
          order_json: JSON.stringify([
            { key: 'storefront-build', qty: 1 },
            { key: 'server-care', qty: 3 },
          ]),
        },
      },
    },
  });

let published;
let logs;
const realLog = console.log;
const realError = console.error;

beforeEach(() => {
  published = [];
  logs = [];
  console.log = (...a) => logs.push(a.join(' '));
  console.error = (...a) => logs.push(a.join(' '));
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;
  process.env.ORDERS_TOPIC_ARN = TOPIC;
  deps.publish = async (input) => { published.push(input); };
});

after(() => {
  console.log = realLog;
  console.error = realError;
});

test('a signed completed event becomes one SNS publish and a 200', async () => {
  const res = await handler(ev(completed()));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { received: true });

  assert.equal(published.length, 1);
  const { topicArn, subject, message } = published[0];
  assert.equal(topicArn, TOPIC);
  assert.equal(subject, 'New store order: storefront-build x1, server-care x3');
  assert.match(message, /storefront-build x1, server-care x3/);
  assert.match(message, /storefront-build x1/);
  assert.match(message, /server-care x3/);
  assert.match(message, /Ada Lovelace/);
  assert.match(message, /ada@example\.com/);
  assert.match(message, /cs_abc123/);
  assert.match(message, /cus_abc123/);
  /* No invented amounts: prices live in Stripe, never in this email. */
  assert.doesNotMatch(message, /\$\s?\d/);
});

test('livemode=false links into /test/ on the dashboard', async () => {
  await handler(ev(completed({ livemode: false })));
  assert.match(published[0].message, /https:\/\/dashboard\.stripe\.com\/test\/customers\/cus_abc123/);
});

test('livemode=true links without /test/', async () => {
  await handler(ev(completed({ livemode: true })));
  assert.match(published[0].message, /https:\/\/dashboard\.stripe\.com\/customers\/cus_abc123/);
  assert.doesNotMatch(published[0].message, /dashboard\.stripe\.com\/test\//);
});

test('the log carries event id and type and never the secret', async () => {
  await handler(ev(completed()));
  const line = logs.join('\n');
  assert.match(line, /evt_test_1/);
  assert.match(line, /checkout\.session\.completed/);
  assert.doesNotMatch(line, new RegExp(SECRET));
});

test('a wrong signature is a 400 and nothing publishes', async () => {
  const body = completed();
  const res = await handler(ev(body, {
    headers: { 'stripe-signature': sign(body, { secret: 'whsec_wrong' }) },
  }));
  assert.equal(res.statusCode, 400);
  assert.equal(published.length, 0);
  /* Terse: the payload never echoes back. */
  assert.doesNotMatch(res.body, /storefront-build|ada@example\.com/);
});

test('a missing signature header is a 400 and nothing publishes', async () => {
  const res = await handler(ev(completed(), { headers: {} }));
  assert.equal(res.statusCode, 400);
  assert.equal(published.length, 0);
});

test('a stale timestamp is a 400 even with a valid v1', async () => {
  const body = completed();
  for (const ts of [now() - 400, now() + 400]) {
    const res = await handler(ev(body, { headers: { 'stripe-signature': sign(body, { ts }) } }));
    assert.equal(res.statusCode, 400);
  }
  assert.equal(published.length, 0);
});

test('anything other than POST is refused', async () => {
  for (const method of ['GET', 'PUT', 'OPTIONS']) {
    const res = await handler(ev(completed(), {
      requestContext: { http: { method, path: '/' } },
    }));
    assert.equal(res.statusCode, 405);
    assert.equal(res.headers.allow, 'POST');
  }
  assert.equal(published.length, 0);
});

test('a verified event of any other type is a 200 without a publish', async () => {
  const body = JSON.stringify({ id: 'evt_other', type: 'payment_intent.succeeded', data: { object: {} } });
  const res = await handler(ev(body));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { received: true });
  assert.equal(published.length, 0);
});

test('a base64-encoded body verifies against the decoded bytes', async () => {
  const raw = completed();
  const res = await handler({
    requestContext: { http: { method: 'POST', path: '/' } },
    headers: { 'Stripe-Signature': sign(raw) },
    body: Buffer.from(raw, 'utf8').toString('base64'),
    isBase64Encoded: true,
  });
  assert.equal(res.statusCode, 200);
  assert.equal(published.length, 1);
  assert.match(published[0].message, /cus_abc123/);
});

test('an SNS publish rejection is a 500, so Stripe retries', async () => {
  deps.publish = async () => { throw new Error('sns is down'); };
  const res = await handler(ev(completed()));
  assert.equal(res.statusCode, 500);
  assert.match(logs.join('\n'), /sns publish failed/);
  assert.doesNotMatch(res.body, /storefront-build/);
});

test('an oversized order still publishes, with the subject clamped for SNS', async () => {
  const order = Array.from({ length: 12 }, (_, i) => `storefront-build-${i} x1`).join(', ');
  const res = await handler(ev(completed({ order })));
  assert.equal(res.statusCode, 200);
  assert.equal(published.length, 1);
  assert.ok(published[0].subject.length <= 99);
});

test('a subject with newlines and non-ASCII is sanitized to printable ASCII', async () => {
  const res = await handler(ev(completed({ order: 'lifeline x1\nplusé ☃ extras' })));
  assert.equal(res.statusCode, 200);
  assert.equal(published.length, 1);
  assert.match(published[0].subject, /^[\x20-\x7E]+$/);
  assert.ok(!published[0].subject.includes('\n'));
});
