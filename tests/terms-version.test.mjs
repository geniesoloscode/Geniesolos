/* The version pin for the clickwrap consent record.
 *
 * A consent record is only worth keeping if we can still produce the document
 * it names. Four places have to agree on one string, and none of them can
 * import from any of the others: the drawer's rules file loads in a browser,
 * the checkout Lambda ships alone in a zip, and the two HTML files are static.
 * So they are duplicated on purpose, the same way the CATALOG is, and this
 * file is what makes the duplication safe: if any of them drifts, the suite
 * fails here instead of the site recording consent to a document nobody
 * serves.
 *
 * It also compares the archived copy against the live terms word for word, so
 * editing terms.html without cutting a new version is a failing test rather
 * than a silent rewrite of what past customers agreed to. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const GSCart = require('../js/store-cart.js');

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => readFileSync(root + rel, 'utf8');

const VERSION = GSCart.TERMS_VERSION;
const ARCHIVE = `terms/v${VERSION}.html`;

/* terms.html writes the version with non-breaking hyphens so the plate never
   wraps mid-identifier; compare on the plain text it stands for. */
const plateVersion = (html) => {
  const m = /GS(?:&#8209;|-)SERVICE(?:&#8209;|-)TERMS v(\d{4})(?:&#8209;|-)(\d{2})/.exec(html);
  return m ? `${m[1]}-${m[2]}` : null;
};

/* The legal document itself: the plate that dates and identifies it, through
   the end of the body. Everything outside it (head, nav, footer) differs
   between the live page and the archive by design, because the archive sits a
   directory down and has to reach its assets from the root. */
const documentBody = (html) => {
  const start = html.indexOf('<section class="plate">');
  const end = html.indexOf('</main>');
  assert.ok(start > 0 && end > start, 'could not find the document body');
  return html.slice(start, end);
};

test('the drawer and the checkout Lambda agree on the terms version', () => {
  const lambda = /const CURRENT_TERMS_VERSION = '([^']+)'/.exec(read('api/checkout/index.mjs'));
  assert.ok(lambda, 'CURRENT_TERMS_VERSION is missing from api/checkout/index.mjs');
  assert.equal(lambda[1], VERSION);
});

test('terms.html is the version the drawer asks people to agree to', () => {
  assert.equal(plateVersion(read('terms.html')), VERSION);
});

test('the archived copy of that version exists at a stable path', () => {
  assert.ok(existsSync(root + ARCHIVE), `${ARCHIVE} is missing: the consent record would name a document we do not serve`);
  assert.equal(plateVersion(read(ARCHIVE)), VERSION);
});

test('the archived copy is the live terms word for word', () => {
  /* Editing terms.html is fine; editing it without cutting a new version is
     not, because customers already consented to the old words. */
  assert.equal(documentBody(read(ARCHIVE)), documentBody(read('terms.html')));
});

test('the archive stays out of the index so it cannot outrank /terms', () => {
  assert.match(read(ARCHIVE), /<meta name="robots" content="noindex[^"]*">/);
});

test('the archive reaches its assets from the root, not from terms/', () => {
  const html = read(ARCHIVE);
  /* A directory down, href="css/terms.css" would resolve to /terms/css/... */
  assert.doesNotMatch(html, /(href|src)="(css|js|assets)\//);
  assert.match(html, /href="\/css\/terms\.css/);
});

test('the archive is published: both deploy paths carry the terms/ prefix', () => {
  /* Deployment is default-DENY in both places. Without these the file is in
     the repo and nowhere else. */
  assert.match(read('scripts/deploy.ps1'), /'--include', 'terms\/\*'/);
  assert.match(read('.github/workflows/deploy.yml'), /--include "terms\/\*"/);
});

test('the Lambda carries the hash of the archived document, byte for byte', () => {
  /* The consent record fingerprints the exact bytes of the document, so the
     evidence does not rest on anyone trusting this repository years from now:
     a downloaded copy either hashes to what Stripe recorded or it does not.
     .gitattributes forces eol=lf, so this hash is the same on a Windows
     checkout, on the Linux CI runner and in the bytes CloudFront serves. */
  const actual = createHash('sha256').update(readFileSync(root + ARCHIVE)).digest('hex');
  const pinned = /const TERMS_DOC_SHA256 = '([^']+)'/.exec(read('api/checkout/index.mjs'));
  assert.ok(pinned, 'TERMS_DOC_SHA256 is missing from api/checkout/index.mjs');
  assert.equal(pinned[1], actual);
  assert.match(pinned[1], /^[0-9a-f]{64}$/);
});

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
