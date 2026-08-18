/* The two deploy paths - scripts/deploy.ps1 and .github/workflows/deploy.yml -
   must publish the same set of pages. deploy.ps1 already guards $SyncFilters
   against drift at runtime, but NOTHING guards the HTML page list or the
   extensionless clean-URL copies, and those are the parts that decide whether
   a page exists at its public URL at all.

   S3 has no rewrite rules: the object key IS the URL. /privacy only resolves
   because an object literally named "privacy" exists, uploaded as a second
   copy of privacy.html. Miss that copy in one path and the page 404s; miss it
   in the other and whichever deploy ran last decides, because both run
   --delete. This test pins both lists in both files. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ps1 = readFileSync(join(ROOT, 'scripts', 'deploy.ps1'), 'utf8');
const yml = readFileSync(join(ROOT, '.github', 'workflows', 'deploy.yml'), 'utf8');

/* Every page the site publishes, and the clean URL it must also answer on.
   A page with no clean URL (404.html is served by CloudFront's error pages,
   not by a path visitors type) maps to null. */
const PAGES = {
  'index.html': null,
  '404.html': null,
  'terms.html': 'terms',
  'store.html': 'store',
  'privacy.html': 'privacy',
};

function ps1HtmlFiles() {
  const m = /\$HtmlFiles\s*=\s*@\(([^)]*)\)/.exec(ps1);
  assert.ok(m, 'could not find $HtmlFiles in scripts/deploy.ps1');
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

function ymlHtmlFiles() {
  const m = /for\s+f\s+in\s+([^;]+);\s*do/.exec(yml);
  assert.ok(m, 'could not find the HTML upload loop in the workflow');
  return m[1].trim().split(/\s+/);
}

/* Both files write the extensionless copy with the bucket in a variable, so
   the only stable difference between them is the variable's name. */
const ps1CleanUrls = () =>
  [...ps1.matchAll(/'s3',\s*'cp',\s*'([\w.-]+\.html)',\s*"s3:\/\/\$Bucket\/([\w-]+)"/g)]
    .map((m) => [m[1], m[2]]);

const ymlCleanUrls = () =>
  [...yml.matchAll(/aws s3 cp ([\w.-]+\.html) "s3:\/\/\$BUCKET\/([\w-]+)"/g)]
    .map((m) => [m[1], m[2]]);

test('both deploy paths upload exactly the expected pages', () => {
  const expected = Object.keys(PAGES).sort();
  assert.deepEqual(ps1HtmlFiles().sort(), expected, 'scripts/deploy.ps1 $HtmlFiles');
  assert.deepEqual(ymlHtmlFiles().sort(), expected, 'workflow HTML upload loop');
});

test('both deploy paths write the same clean-URL copies', () => {
  const expected = Object.entries(PAGES)
    .filter(([, url]) => url !== null)
    .map(([file, url]) => `${file} -> ${url}`)
    .sort();

  const fmt = (pairs) => pairs.map(([f, u]) => `${f} -> ${u}`).sort();
  assert.deepEqual(fmt(ps1CleanUrls()), expected, 'scripts/deploy.ps1 clean URLs');
  assert.deepEqual(fmt(ymlCleanUrls()), expected, 'workflow clean URLs');
});

test('every published page exists on disk', () => {
  for (const file of Object.keys(PAGES)) {
    assert.doesNotThrow(
      () => readFileSync(join(ROOT, file)),
      `${file} is in the deploy list but missing from the repo`,
    );
  }
});

/* The CSP allows inline scripts by hash, and that hash covers exactly one
   block: the pre-paint theme snippet. Every themed page carries a
   byte-identical copy, so a page that retypes it - even reformatted, even
   with the same behavior - gets its script blocked and flashes the wrong
   theme on load. Compare the real bytes, not a regex.

   Every page carries it, 404.html included - it is CloudFront's error
   document, and a visitor who lands there with the dark theme saved should
   not eat a cream flash on the way. */
const THEMED = ['index.html', 'terms.html', 'store.html', 'privacy.html', '404.html'];

test('the pre-paint theme script is byte-identical on every themed page', () => {
  const snippet = (html) => {
    const a = html.indexOf('<script>');
    const b = html.indexOf('</script>', a);
    assert.ok(a >= 0 && b > a, 'no inline script found');
    return html.slice(a, b + '</script>'.length);
  };

  const baseline = snippet(readFileSync(join(ROOT, 'index.html'), 'utf8'));
  for (const file of THEMED) {
    assert.equal(
      snippet(readFileSync(join(ROOT, file), 'utf8')),
      baseline,
      `${file}'s inline theme script differs from index.html - the CSP hash will not match it`,
    );
  }
});

/* The CSP carries exactly ONE script hash. A second inline block on any page
   - however small - has no hash of its own and is blocked outright. */
test('no page carries a second inline script', () => {
  for (const file of Object.keys(PAGES)) {
    const html = readFileSync(join(ROOT, file), 'utf8');
    assert.equal(html.split('<script>').length - 1, 1,
      file + ' should have exactly one inline <script> block; the CSP hashes only one');
  }
});

test('every themed page is also a published page', () => {
  for (const file of THEMED) {
    assert.ok(file in PAGES, `${file} is themed but missing from the deploy list`);
  }
});

test('the sitemap lists every clean URL', () => {
  const sitemap = readFileSync(join(ROOT, 'sitemap.xml'), 'utf8');
  for (const url of Object.values(PAGES)) {
    if (url === null) continue;
    assert.ok(
      sitemap.includes(`https://geniesolos.com/${url}`),
      `sitemap.xml is missing https://geniesolos.com/${url}`,
    );
  }
});

/* ---- self-hosted fonts -------------------------------------------------
   Live pages must not call Google. terms/v2026-10.html is the deliberate
   exception: it is the archived consent document whose SHA-256 is pinned in
   api/checkout/index.mjs, so its bytes cannot change and it keeps its
   original Google Fonts link. That is why the CSP still allows Google. */
test('no live page requests a third-party font', () => {
  for (const file of Object.keys(PAGES)) {
    const html = readFileSync(join(ROOT, file), 'utf8');
    for (const host of ['fonts.googleapis.com', 'fonts.gstatic.com']) {
      assert.ok(!html.includes(host), file + ' still references ' + host);
    }
  }
});

test('every font the stylesheet declares is actually on disk', () => {
  const css = readFileSync(join(ROOT, 'css', 'fonts.css'), 'utf8');
  const files = css.split("url('../").slice(1).map((chunk) => chunk.split("')")[0]);
  assert.ok(files.length > 0, 'css/fonts.css declares no font files');
  for (const rel of files) {
    assert.doesNotThrow(() => readFileSync(join(ROOT, rel)),
      'css/fonts.css points at ' + rel + ', which does not exist');
  }
});

/* unicode-range is what lets a browser skip a subset it does not need.
   Strip it and every visitor downloads all 22 files instead of two. */
test('every @font-face keeps its unicode-range', () => {
  const css = readFileSync(join(ROOT, 'css', 'fonts.css'), 'utf8');
  const faces = css.split('@font-face').length - 1;
  const ranges = css.split('unicode-range:').length - 1;
  assert.equal(ranges, faces, 'some @font-face lost its unicode-range');
});

test('the font licence ships with the fonts', () => {
  const txt = readFileSync(join(ROOT, 'assets', 'fonts', 'LICENSE.txt'), 'utf8');
  assert.ok(txt.includes('SIL OPEN FONT LICENSE'), 'LICENSE.txt is not the OFL');
  for (const fam of ['Fraunces', 'JetBrains Mono', 'Space Grotesk']) {
    assert.ok(txt.includes(fam), 'LICENSE.txt does not name ' + fam);
  }
});
