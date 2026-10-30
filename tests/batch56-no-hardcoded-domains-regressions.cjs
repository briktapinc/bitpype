'use strict';
/**
 * Batch 56 — no hardcoded domains/links.
 *
 * Ely's order: check if any domain name or link is hard coded and add it
 * to Settings → General so nothing is hard coded, including bitpype.com.
 *
 * What shipped:
 *   - ONE canonical platform setting, general.public_url
 *     (Admin → Settings → General), validated + normalized at BOTH write
 *     choke points (platform.setPlatformSetting and
 *     settingsKeys.validateSetting): required, https only, site root
 *     only, trailing slash normalized to the URL origin.
 *   - ONE resolver, stripeClient.appUrl(), resolution order:
 *     stored setting → APP_URL env → the setting's def default in
 *     PLATFORM_SETTING_DEFS. That def line is the ONLY place the
 *     production domain literal may appear in shipped code (src/,
 *     server/, public/) — pinned by the census below.
 *   - Every first-party link builder (claim kit, interest anchors,
 *     branded email logo/site URL, OAuth callbacks, MCP issuer, GBP)
 *     routes through the resolver; the marketing/legal pages carry
 *     {{PUBLIC_URL}} / {{SUPPORT_EMAIL}} tokens substituted at serve
 *     time by server.js.
 *   - mcp.public_url (per-workspace MCP remote base, src/mcpRemote.js)
 *     is a DIFFERENT setting and stays untouched — pinned below so the
 *     two are never conflated.
 *   - smtp.from_email no longer seeds a hardcoded first-party address
 *     (fresh installs start unconfigured; stored values never change).
 *
 * Day-one contract: with production-shaped configuration (APP_URL set,
 * no stored override) every generated link is byte-identical to the
 * pre-batch output — the prod-shaped checks below pin the hosts.
 */
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'batch56-test-secret';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const checks = [];
function check(name, fn) {
  checks.push([name, fn]);
}

/* ------------------------------------------------------------------ */
/* Census pin — the literal may exist ONLY at the def site             */
/* ------------------------------------------------------------------ */

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (/\.(js|html)$/.test(ent.name)) out.push(p);
  }
  return out;
}

check('census: exactly one bitpype.com literal in shipped code, at the general.public_url def', () => {
  const hits = [];
  for (const tree of ['src', 'server', 'public']) {
    for (const file of walk(path.join(root, tree))) {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        const m = line.match(/bitpype\.com/g);
        if (m) hits.push({ file: path.relative(root, file), line: i + 1, count: m.length, text: line });
      });
    }
  }
  const total = hits.reduce((n, h) => n + h.count, 0);
  assert.equal(total, 1, `expected exactly 1 occurrence, found ${total}: ${JSON.stringify(hits)}`);
  assert.equal(hits[0].file, path.join('server', 'platform.js'));
  assert.ok(hits[0].text.includes("key: 'general.public_url'"), 'the one literal must sit on the def line');
  assert.ok(hits[0].text.includes("default: 'https://bitpype.com'"), 'the def default carries the literal');
});

check('census: marketing/legal pages carry serve-time tokens (no baked domain)', () => {
  const home = fs.readFileSync(path.join(root, 'public', 'home.html'), 'utf8');
  const hiw = fs.readFileSync(path.join(root, 'public', 'how-it-works.html'), 'utf8');
  const privacy = fs.readFileSync(path.join(root, 'public', 'legal', 'privacy.html'), 'utf8');
  assert.ok(home.includes('{{SUPPORT_EMAIL}}'), 'home.html support email is a token');
  assert.ok(hiw.includes('{{PUBLIC_URL}}'), 'how-it-works.html public URL is a token');
  assert.ok(privacy.includes('{{SUPPORT_EMAIL}}'), 'privacy.html support email is a token');
  const serverSrc = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.ok(serverSrc.includes('sendTemplatedPage'), 'server.js substitutes tokens at serve time');
  assert.ok(serverSrc.includes("'/legal/privacy.html'"), 'direct legal paths are intercepted before static');
});

check('settings UI: Admin → Settings renders the Public URL field with its warning hint', () => {
  const appSrc = fs.readFileSync(path.join(root, 'public', 'js', 'app.js'), 'utf8');
  assert.ok(appSrc.includes("d.key === 'general.public_url'"), 'special render block for general.public_url');
  assert.ok(appSrc.includes('Links in emails and pages are built from this address'), 'hint text present');
});

/* ------------------------------------------------------------------ */
/* Resolver matrix                                                     */
/* ------------------------------------------------------------------ */

const stripeClient = require(path.join(root, 'server', 'stripeClient.js'));
const SAVED_APP_URL = process.env.APP_URL;
function setEnv(v) {
  if (v === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = v;
}
function restoreResolver() {
  stripeClient.setPublicUrlCache('');
  setEnv(SAVED_APP_URL);
}

check('resolver: stored setting beats env, trailing slash normalized', () => {
  try {
    setEnv('https://env.example');
    stripeClient.setPublicUrlCache('https://example.test/');
    assert.equal(stripeClient.appUrl(), 'https://example.test');
  } finally {
    restoreResolver();
  }
});

check('resolver: env APP_URL is second, trailing slash normalized', () => {
  try {
    stripeClient.setPublicUrlCache('');
    setEnv('https://env.example/');
    assert.equal(stripeClient.appUrl(), 'https://env.example');
  } finally {
    restoreResolver();
  }
});

check('resolver: def default is last (production domain, day-one output)', () => {
  try {
    stripeClient.setPublicUrlCache('');
    setEnv(undefined);
    assert.equal(stripeClient.appUrl(), 'https://bitpype.com');
  } finally {
    restoreResolver();
  }
});

check('resolver: configuredPublicUrl distinguishes configured from defaulted', () => {
  try {
    stripeClient.setPublicUrlCache('');
    setEnv(undefined);
    assert.equal(stripeClient.configuredPublicUrl(), '', 'nothing configured → empty (interest-link guard depends on this)');
    setEnv('https://env.example');
    assert.equal(stripeClient.configuredPublicUrl(), 'https://env.example');
    stripeClient.setPublicUrlCache('https://example.test');
    assert.equal(stripeClient.configuredPublicUrl(), 'https://example.test');
  } finally {
    restoreResolver();
  }
});

/* ------------------------------------------------------------------ */
/* Save-time validation matrix (both write choke points)               */
/* ------------------------------------------------------------------ */

const platform = require(path.join(root, 'server', 'platform.js'));
const settingsKeys = require(path.join(root, 'server', 'settingsKeys.js'));

check('validation: platform choke point accepts + normalizes root https URLs', () => {
  assert.equal(platform.validatePublicUrlSetting('https://example.com'), 'https://example.com');
  assert.equal(platform.validatePublicUrlSetting('https://example.com/'), 'https://example.com');
  assert.equal(platform.validatePublicUrlSetting('  https://example.com///  '), 'https://example.com');
  assert.equal(platform.validatePublicUrlSetting('https://example.com'), 'https://example.com');
});

check('validation: platform choke point rejects empty, http, paths, credentials, garbage', () => {
  const bad = ['', '   ', 'http://example.com', 'https://example.com/app', 'https://example.com/?x=1', 'https://user:pass@example.com', 'not a url', 'example.com'];
  for (const v of bad) {
    assert.throws(() => platform.validatePublicUrlSetting(v), (e) => e.code === 'VALIDATION', `should reject ${JSON.stringify(v)}`);
  }
});

check('validation: settings:set path enforces the identical rule (Batch 24b invariant)', () => {
  assert.ok(settingsKeys.SETTABLE_KEYS.includes('general.public_url'), 'key is writable via settings:set');
  const ok = settingsKeys.validateSetting('general.public_url', 'https://example.com/');
  assert.equal(ok.ok, true);
  assert.equal(ok.value, 'https://example.com');
  assert.equal(settingsKeys.validateSetting('general.public_url', 'http://example.com').ok, false);
  assert.equal(settingsKeys.validateSetting('general.public_url', '').ok, false);
  assert.equal(settingsKeys.validateSetting('general.public_url', 'https://example.com/path').ok, false);
});

/* ------------------------------------------------------------------ */
/* Link-generation proof                                               */
/* ------------------------------------------------------------------ */

const claimKit = require(path.join(root, 'src', 'claimKit.js'));
const outreach = require(path.join(root, 'src', 'outreach.js'));
const emailTemplate = require(path.join(root, 'src', 'emailTemplate.js'));

check('links: with public_url=https://example.test, claim + interest + email links carry example.test only', () => {
  try {
    stripeClient.setPublicUrlCache('https://example.test');
    const claim = claimKit.buildClaimUrl(1, 2);
    assert.ok(claim.startsWith('https://example.test/'), `claim URL on configured host: ${claim}`);
    assert.ok(!claim.includes('bitpype.com'), 'claim URL carries no hardcoded domain');
    const anchor = outreach.buildInterestAnchor(1, 2, 'interested');
    assert.ok(anchor.includes('https://example.test/'), 'interest anchor on configured host');
    assert.ok(!anchor.includes('bitpype.com'), 'interest anchor carries no hardcoded domain');
    assert.equal(emailTemplate.siteUrl(), 'https://example.test');
    assert.equal(emailTemplate.LOGO_URL, 'https://example.test/brand/logo-email.png');
  } finally {
    restoreResolver();
  }
});

check('links: production-shaped config reproduces todays links byte-for-byte (host level)', () => {
  try {
    stripeClient.setPublicUrlCache('');
    setEnv('https://bitpype.com');
    const claim = claimKit.buildClaimUrl(1, 2);
    assert.ok(claim.startsWith('https://bitpype.com/'), `claim URL keeps production host: ${claim}`);
    assert.equal(emailTemplate.LOGO_URL, 'https://bitpype.com/brand/logo-email.png');
  } finally {
    restoreResolver();
  }
});

/* ------------------------------------------------------------------ */
/* The two public_url settings stay distinct                          */
/* ------------------------------------------------------------------ */

check('mcp.public_url (per-workspace MCP remote base) is untouched and distinct', () => {
  assert.ok(settingsKeys.SETTING_SEEDS.some(([k]) => k === 'mcp.public_url'), 'mcp.public_url still seeded per-workspace');
  const remoteSrc = fs.readFileSync(path.join(root, 'src', 'mcpRemote.js'), 'utf8');
  assert.ok(remoteSrc.includes("getSetting(db, 'mcp.public_url'"), 'mcpRemote still reads its own setting');
  const def = platform.PLATFORM_SETTING_DEFS.find((d) => d.key === 'general.public_url');
  assert.ok(def && def.group === 'general', 'general.public_url def lives in the general group');
});

/* ------------------------------------------------------------------ */

(async () => {
  const names = [];
  for (const [name, fn] of checks) {
    await fn();
    names.push(name);
    console.log('  ok -', name);
  }
  restoreResolver();
  console.log(JSON.stringify({ file: 'batch56-no-hardcoded-domains-regressions', checks: names.length, passed: true }));
})().catch((e) => {
  restoreResolver();
  console.error(e);
  process.exit(1);
});
