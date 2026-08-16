/* Order-notification webhook Lambda for geniesolos.com.
 *
 * One file, Node 22 ESM, no dependencies beyond the AWS SDK v3 SNS client
 * that the nodejs22.x runtime already ships. Stripe POSTs events here through
 * a PUBLIC function URL: Stripe cannot be told to send the
 * x-amz-content-sha256 header the CloudFront OAC path demands on POSTs, so
 * this function sits outside CloudFront on purpose and its front door is the
 * Stripe webhook signature instead (see "Order notifications" in
 * api/README.md).
 *
 * Only checkout.session.completed matters. A verified completed session
 * becomes a plain-text email to the owner, published to an SNS topic whose
 * email subscription is the owner's inbox. Every other verified event is
 * acknowledged with 200 and dropped.
 *
 * Env:
 *   STRIPE_WEBHOOK_SECRET  whsec_..., from the endpoint in the Stripe
 *                          dashboard; test and live each have their own
 *   ORDERS_TOPIC_ARN       SNS topic that emails the owner
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/* The SNS client comes from the Lambda runtime, not from this repo: there is
   no package.json and no node_modules. Loaded at module top with a fallback,
   so the test suite, which stubs deps.publish and never reaches SNS, runs on
   a dev machine where the SDK is absent. */
let sendToSns;
try {
  const { SNSClient, PublishCommand } = await import('@aws-sdk/client-sns');
  const client = new SNSClient({});
  sendToSns = (input) => client.send(new PublishCommand(input));
} catch {
  sendToSns = () => {
    throw new Error('@aws-sdk/client-sns is not available in this runtime');
  };
}

const TOLERANCE_SECONDS = 300;
/* SNS requires a Subject under 100 ASCII printable characters, and a refused
   publish would 500 forever through every Stripe retry. A long order loses
   its tail from the subject line only; the message body always carries the
   whole order. Sanitized because metadata written outside the checkout
   Lambda (dashboard, API) can carry newlines or non-ASCII. */
const SUBJECT_MAX = 99;

async function publish({ topicArn, subject, message }) {
  await sendToSns({ TopicArn: topicArn, Subject: subject, Message: message });
}

/* The injectable seam: the handler calls deps.publish, never publish
   directly, so tests swap in a stub without touching the SDK. */
export const deps = { publish };

/* Read per request rather than at import time, so a console env edit takes
   effect on the next invocation instead of the next cold start. */
function config() {
  return {
    secret: process.env.STRIPE_WEBHOOK_SECRET || '',
    topicArn: process.env.ORDERS_TOPIC_ARN || '',
  };
}

function headerOf(event, name) {
  const headers = (event && event.headers) || {};
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === name) return headers[key];
  }
  return undefined;
}

/* The EXACT raw body string is what Stripe signed, so the base64 a function
   URL often delivers has to be decoded back to those bytes before anything
   is verified or parsed. */
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

/* Stripe-Signature: t=<unix seconds>,v1=<hex hmac>[,v1=...][,v0=...].
   signed_payload is `${t}.${rawBody}`, HMAC-SHA256 keyed with the whsec_
   secret. Every v1 entry gets a timing-safe comparison, and a timestamp more
   than 300 seconds from now is rejected even when a v1 matches, so a captured
   request cannot be replayed later. */
function verifySignature(secret, header, rawBody, nowSeconds) {
  if (typeof header !== 'string' || header.length < 1) return false;

  let timestamp = null;
  const candidates = [];
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't') timestamp = value;
    else if (key === 'v1') candidates.push(value);
  }

  if (!timestamp || !/^\d+$/.test(timestamp) || candidates.length < 1) return false;
  if (Math.abs(nowSeconds - Number(timestamp)) > TOLERANCE_SECONDS) return false;

  const expected = createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`, 'utf8')
    .digest();

  let match = false;
  for (const candidate of candidates) {
    if (!/^[0-9a-f]{64}$/.test(candidate)) continue;
    const given = Buffer.from(candidate, 'hex');
    if (given.length === expected.length && timingSafeEqual(given, expected)) match = true;
  }
  return match;
}

/* metadata[order_json] holds the exact {key, qty} lines the checkout Lambda
   validated. Listed as written; prices are never invented here, they live in
   Stripe and the owner bills from the dashboard. */
function orderLines(orderJson) {
  try {
    const items = JSON.parse(orderJson);
    if (!Array.isArray(items) || items.length < 1) return null;
    const lines = [];
    for (const item of items) {
      if (!item || typeof item.key !== 'string' || typeof item.qty !== 'number') return null;
      lines.push(`  ${item.key} x${item.qty}`);
    }
    return lines;
  } catch {
    return null;
  }
}

/* The clickwrap record the checkout Lambda wrote onto the session: which
   version of terms.html the customer agreed to, when, from where, in what
   browser. Stripe holds the authoritative copy; this puts it somewhere the
   owner already reads, so the evidence is not only inside one vendor's
   dashboard.

   Every field is named even when absent. A session from before consent
   shipped has none of these, and a line that quietly disappeared would read
   as consent nobody bothered to print. */
function consentLines(metadata) {
  const field = (value, missing) =>
    typeof value === 'string' && value.length > 0 ? value : missing;

  if (typeof metadata.terms_version !== 'string' || metadata.terms_version.length < 1) {
    return ['Terms accepted: (no record)'];
  }
  return [
    `Terms accepted: v${metadata.terms_version} on ${field(metadata.terms_accepted_at, '(no timestamp)')}`,
    `  IP ${field(metadata.terms_accepted_ip, '(no address)')}`,
    `  ${field(metadata.terms_user_agent, '(no user agent)')}`,
    /* The fingerprint of the exact bytes agreed to, so this email is a
       self-contained copy of the record: which document, when, from where.
       A copy of terms/v<version>.html either hashes to this or it is not
       what was agreed to. */
    `  Document: sha256 ${field(metadata.terms_doc_sha256, '(none recorded)')}`,
  ];
}

function composeEmail(stripeEvent) {
  const session = (stripeEvent.data && stripeEvent.data.object) || {};
  const metadata = session.metadata || {};
  const details = session.customer_details || {};
  const order =
    typeof metadata.order === 'string' && metadata.order.length > 0
      ? metadata.order
      : '(no order metadata)';
  const customerId = typeof session.customer === 'string' ? session.customer : '';
  /* Test-mode objects live under /test/ in the dashboard; live ones do not. */
  const dashboard = customerId
    ? `https://dashboard.stripe.com/${stripeEvent.livemode ? '' : 'test/'}customers/${customerId}`
    : '(no customer id, no dashboard link)';

  const lines = [`Order: ${order}`];

  const monthly = orderLines(metadata.order_json);
  if (monthly) {
    lines.push('', 'Monthly lines (prices live in Stripe, bill from the dashboard):', ...monthly);
  }

  /* The phone the drawer collected travels in the session metadata, because
     Stripe cannot ask for one in setup mode; customer_details.phone stays as
     a fallback for sessions that predate the drawer field. */
  const phone =
    (typeof metadata.phone === 'string' && metadata.phone.length > 0 && metadata.phone) ||
    (typeof details.phone === 'string' && details.phone.length > 0 && details.phone) ||
    '(none given)';

  /* The dashboard link carries the customer id for anyone who needs it;
     the raw ids added noise to the email and the owner asked them gone. */
  lines.push(
    '',
    `Customer: ${details.name || '(no name)'} <${details.email || '(no email)'}>`,
    `Phone: ${phone}`,
    `Dashboard: ${dashboard}`,
    '',
    ...consentLines(metadata),
    '',
    'Approve or decline per "Approving an order" in api/README.md.'
  );

  const rawSubject = `New store order: ${order}`
    .replace(/[^\x20-\x7E]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const subject =
    rawSubject.length > SUBJECT_MAX ? `${rawSubject.slice(0, SUBJECT_MAX - 3)}...` : rawSubject;

  return { subject, message: lines.join('\n') };
}

export const handler = async (event) => {
  const method = event?.requestContext?.http?.method || '';
  if (method !== 'POST') {
    return json(405, { error: 'Use POST.' }, { allow: 'POST' });
  }

  const cfg = config();
  if (!cfg.secret || !cfg.topicArn) {
    console.error('webhook is misconfigured: STRIPE_WEBHOOK_SECRET or ORDERS_TOPIC_ARN is not set');
    return json(500, { error: 'Webhook is not configured.' });
  }

  const rawBody = bodyOf(event);
  const signature = headerOf(event, 'stripe-signature');
  if (!verifySignature(cfg.secret, signature, rawBody, Math.floor(Date.now() / 1000))) {
    /* Terse on purpose: nothing from the payload, the header or the secret
       ever echoes back. */
    return json(400, { error: 'Signature verification failed.' });
  }

  let stripeEvent;
  try {
    stripeEvent = JSON.parse(rawBody);
  } catch {
    stripeEvent = null;
  }
  if (!stripeEvent || typeof stripeEvent !== 'object') {
    return json(400, { error: 'That request was not valid JSON.' });
  }

  /* Event id and type only. Never the secret, never the payload. */
  console.log('stripe event verified:', stripeEvent.id || '(no id)', stripeEvent.type || '(no type)');

  if (stripeEvent.type !== 'checkout.session.completed') {
    return json(200, { received: true });
  }

  const { subject, message } = composeEmail(stripeEvent);
  try {
    await deps.publish({ topicArn: cfg.topicArn, subject, message });
  } catch (err) {
    /* 500 on purpose: Stripe retries failed deliveries, and a retry is
       exactly the recovery we want when SNS hiccups. */
    console.error('sns publish failed:', err.message);
    return json(500, { error: 'Notification failed.' });
  }

  return json(200, { received: true });
};
