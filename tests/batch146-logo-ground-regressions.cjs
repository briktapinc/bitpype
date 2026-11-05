'use strict';
/**
 * Batch 146 — WHITE LOGO ON DARK GROUNDS, marketing surfaces
 * (Ely, 2026-11-05, from his phone with a screenshot: the marketing
 * header renders on the DARK ground but served the BLACK lockup —
 * "BITPYPE" read black-on-dark-brown).
 *
 * Ely's standing rule (2026-10-30): the WHITE lockup goes on dark
 * backgrounds, the BLACK lockup on light ones. Batch 144 restored
 * the rule on the staff auth gates; the marketing surfaces were
 * never audited BY GROUND. Batch 86 had classified the marketing
 * pages as "light surfaces" by their cream page body — but the
 * logo in question does not sit on the body, it sits in the header
 * chrome, and that chrome is a DARK band on every marketing page:
 *
 *   .nav (home / landing / how-it-works / creator / partner /
 *         thankyou / work-with-us)  background: rgba(28,20,15,.97)
 *   .nav (how.html, on a #120e0c page) rgba(18,14,12,.72–.94)
 *   .nav (website-promo)            background: var(--sidebar)
 *   .legal-nav (legal x2, sms)      background: var(--sidebar)
 *
 * Variant selection in this codebase IS the canonical URL: server.js
 * intercepts /brand/logo-white.png with serveCustomBrandLogo('dark')
 * and /brand/logo-black.png + /brand/logo-email.png with ('light'),
 * so the URL a surface references selects the Admin → Settings →
 * Branding slot (branding.logo_dark / branding.logo_light) for its
 * ground — the same mechanism the staff sidebar, portal sidenav and
 * auth gates already use. Batch 146 points the twelve dark-ground
 * header/nav lockups at the dark variant; every light-ground
 * placement (the shared pages' footers on the cream body, the
 * transactional brand lines, the portal gate, the solo/onboarding
 * light headers) keeps the black lockup, and the already-correct
 * dark surfaces (staff + portal sidebars, auth gates, the
 * solo/onboarding/how dark footers) are pinned unchanged.
 *
 * Emails (Ely scope addition, 2026-11-05): every platform email
 * rides server/mailer.js → src/emailTemplate.js — a single logo
 * selection point (logoUrl() → /brand/logo-email.png, the LIGHT
 * variant) rendering on the template's light grounds (body
 * #f3f0ea, card #fffcf8). Audited: no mismatch, nothing to change;
 * M8 pins the mechanism so a future dark mail band cannot silently
 * inherit the light lockup.
 *
 * This suite pins the GROUND -> LOCKUP mapping per surface: it
 * parses each surface's own CSS, resolves its ground colour and
 * computes WCAG luminance, then asserts the lockup its header /
 * footer markup references. A ground that drifts light, or a
 * lockup swapped back, goes red.
 *
 *   M1 the canonical URLs are the branding slots (mechanism).
 *   M2 shared marketing pages: dark .nav header -> white lockup;
 *      light cream footer -> black lockup (exactly one each).
 *   M3 how.html: dark page, dark nav -> white header + white
 *      footer, no black lockup anywhere.
 *   M4 website-promo: --sidebar nav -> white, no black lockup.
 *   M5 legal + sms pages: --sidebar .legal-nav -> white lockup.
 *   M6 light surfaces keep the black lockup (transactional pages;
 *      solo/onboarding light header black + dark footer white).
 *   M7 already-correct dark surfaces unchanged (staff sidebar,
 *      portal sidenav + light portal gate, auth gates).
 *   M8 emails: single selection point, light grounds, light
 *      variant; no per-template hardcoded platform lockup.
 *
 * Static suite: boots no server, touches no database.
 * Run via tests/run-regressions.cjs.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const count = (s, sub) => String(s).split(sub).length - 1;

const results = [];
function check(name, fn) {
  fn();
  results.push(name);
}

/* ---------------- CSS parsing helpers (Batch 144 pattern) ---------------- */

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

function declsOf(body) {
  const out = {};
  for (const part of String(body).split(';')) {
    const i = part.indexOf(':');
    if (i < 0) continue;
    const prop = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (prop) out[prop] = value;
  }
  return out;
}

function ruleBody(css, re, label) {
  const m = css.match(re);
  assert.ok(m, `${label} rule exists`);
  return m[1];
}

function rootTokens(css) {
  const out = {};
  for (const m of css.matchAll(/:root\s*\{([^}]*)\}/g)) Object.assign(out, declsOf(m[1]));
  return out;
}

function resolve(value, map, depth = 0) {
  if (value == null || depth > 6) return value;
  const next = String(value).replace(/var\(\s*(--[\w-]+)\s*(?:,[^)]*)?\)/g, (all, name) =>
    Object.prototype.hasOwnProperty.call(map, name) ? map[name] : all
  );
  return next === value ? next : resolve(next, map, depth + 1);
}

/* ---------------- WCAG luminance (Batch 144 pattern) ---------------- */

function lumOfRgb(r, g, b) {
  const f = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function luminanceOfColor(value, label) {
  const s = String(value);
  const hex = s.match(/#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/);
  if (hex) {
    let h = hex[0].slice(1);
    if (h.length === 3)
      h = h
        .split('')
        .map((c) => c + c)
        .join('');
    return lumOfRgb(parseInt(h.substr(0, 2), 16), parseInt(h.substr(2, 2), 16), parseInt(h.substr(4, 2), 16));
  }
  const rgb = s.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  assert.ok(rgb, `${label} resolves to a hex or rgb() colour (got: ${value})`);
  return lumOfRgb(+rgb[1], +rgb[2], +rgb[3]);
}

function block(html, openRe, closeTag, label) {
  const start = html.search(openRe);
  assert.ok(start >= 0, `${label} block exists`);
  const end = html.indexOf(closeTag, start);
  assert.ok(end > start, `${label} block closes`);
  return html.slice(start, end);
}

const tokensCss = stripComments(read('public/css/tokens.css'));
const tokens = rootTokens(tokensCss);
const SIDEBAR_LUM = luminanceOfColor(tokens['--sidebar'], '--sidebar');

/* The seven marketing pages sharing one chrome: dark .nav header,
   cream body, footer directly on the body ground. */
const SHARED = [
  'public/home.html',
  'public/landing.html',
  'public/how-it-works.html',
  'public/creator.html',
  'public/partner.html',
  'public/thankyou.html',
  'public/work-with-us.html',
];

/* ---------------- The checks ---------------- */

check('M1 canonical brand URLs select the Admin branding slot for their ground', () => {
  const server = read('server.js');
  assert.ok(
    server.includes("app.get('/brand/logo-white.png', serveCustomBrandLogo('dark'))"),
    'logo-white.png is served by the DARK branding slot'
  );
  assert.ok(
    server.includes("app.get(['/brand/logo-black.png', '/brand/logo-email.png'], serveCustomBrandLogo('light'))"),
    'logo-black.png + logo-email.png are served by the LIGHT branding slot'
  );
  const branding = read('server/branding.js');
  assert.ok(branding.includes("logoDarkUrl: '/brand/logo-white.png'"), 'dark default is the white lockup');
  assert.ok(branding.includes("logoLightUrl: '/brand/logo-black.png'"), 'light default is the black lockup');
  assert.ok(SIDEBAR_LUM < 0.05, `--sidebar ${tokens['--sidebar']} is dark (luminance ${SIDEBAR_LUM.toFixed(4)})`);
});

check('M2 shared marketing pages: white lockup in the dark .nav header, black in the light footer', () => {
  for (const rel of SHARED) {
    const html = read(rel);
    const css = stripComments(html);
    const pageTokens = rootTokens(css);
    /* Ground 1 — the header band itself. */
    const nav = declsOf(ruleBody(css, /\.nav\s*\{([^}]*)\}/, `${rel} .nav`));
    const navLum = luminanceOfColor(nav.background, `${rel} .nav background`);
    assert.ok(navLum < 0.05, `${rel} .nav ground is dark (luminance ${navLum.toFixed(4)})`);
    /* Ground 2 — the body the footer sits on. */
    const bgLum = luminanceOfColor(resolve(pageTokens['--bg'], pageTokens), `${rel} --bg`);
    assert.ok(bgLum > 0.5, `${rel} body ground is light (luminance ${bgLum.toFixed(3)})`);
    const header = block(html, /<header class="nav">/, '</header>', `${rel} header`);
    assert.ok(header.includes('src="/brand/logo-white.png"'), `${rel} header (dark ground) uses the white lockup`);
    assert.ok(!header.includes('logo-black'), `${rel} header never uses the black lockup`);
    const footer = block(html, /<footer[\s>]/, '</footer>', `${rel} footer`);
    assert.ok(footer.includes('src="/brand/logo-black.png"'), `${rel} footer (light ground) keeps the black lockup`);
    assert.equal(count(html, '/brand/logo-white.png'), 1, `${rel} has exactly one white lockup (the header)`);
    assert.equal(count(html, '/brand/logo-black.png'), 1, `${rel} has exactly one black lockup (the footer)`);
  }
});

check('M3 how.html: dark page end to end — white header and footer, no black lockup', () => {
  const html = read('public/how.html');
  const css = stripComments(html);
  const body = declsOf(ruleBody(css, /\bbody\s*\{([^}]*)\}/, 'how.html body'));
  const bodyLum = luminanceOfColor(body.background, 'how.html body background');
  assert.ok(bodyLum < 0.05, `how.html body ground is dark (luminance ${bodyLum.toFixed(4)})`);
  const nav = declsOf(ruleBody(css, /\.nav\s*\{([^}]*)\}/, 'how.html .nav'));
  const navLum = luminanceOfColor(nav.background, 'how.html .nav background');
  assert.ok(navLum < 0.05, `how.html .nav ground is dark (luminance ${navLum.toFixed(4)})`);
  const header = block(html, /<header class="nav">/, '</header>', 'how.html header');
  assert.ok(header.includes('src="/brand/logo-white.png"'), 'how.html header uses the white lockup');
  const footer = block(html, /<footer[\s>]/, '</footer>', 'how.html footer');
  assert.ok(footer.includes('src="/brand/logo-white.png"'), 'how.html footer keeps the white lockup');
  assert.ok(!html.includes('/brand/logo-black.png'), 'how.html has no black lockup anywhere');
});

check('M4 website-promo: --sidebar nav ground takes the white lockup', () => {
  const html = read('public/website-promo.html');
  const css = stripComments(html);
  const pageTokens = rootTokens(css);
  const nav = declsOf(ruleBody(css, /\.nav\s*\{([^}]*)\}/, 'website-promo .nav'));
  assert.ok(/var\(\s*--sidebar\s*\)/.test(nav.background || ''), 'website-promo .nav paints var(--sidebar)');
  const navLum = luminanceOfColor(resolve(nav.background, pageTokens), 'website-promo .nav background');
  assert.ok(navLum < 0.05, `website-promo .nav ground is dark (luminance ${navLum.toFixed(4)})`);
  const navBlock = block(html, /<nav class="nav">/, '</nav>', 'website-promo nav');
  assert.ok(navBlock.includes('src="/brand/logo-white.png"'), 'website-promo nav uses the white lockup');
  assert.ok(!html.includes('/brand/logo-black.png'), 'website-promo has no black lockup');
});

check('M5 legal + sms-policy pages: --sidebar .legal-nav takes the white lockup', () => {
  for (const rel of ['public/legal/privacy.html', 'public/legal/terms.html', 'public/sms-policy.html']) {
    const html = read(rel);
    const css = stripComments(html);
    const nav = declsOf(ruleBody(css, /\.legal-nav\s*\{([^}]*)\}/, `${rel} .legal-nav`));
    assert.ok(/var\(\s*--sidebar\s*\)/.test(nav.background || ''), `${rel} .legal-nav paints var(--sidebar)`);
    const header = block(html, /<header class="legal-nav">/, '</header>', `${rel} header`);
    assert.ok(header.includes('src="/brand/logo-white.png"'), `${rel} legal nav (dark ground) uses the white lockup`);
    assert.ok(!html.includes('/brand/logo-black.png'), `${rel} has no black lockup`);
  }
});

check('M6 light surfaces keep the black lockup', () => {
  /* Transactional / standalone light pages: black lockup, never white. */
  for (const rel of [
    'public/authorize.html',
    'public/claim.html',
    'public/domain-picker.html',
    'public/domain-success.html',
    'public/member-reset.html',
  ]) {
    const html = read(rel);
    assert.ok(html.includes('/brand/logo-black.png'), `${rel} (light ground) uses the black lockup`);
    assert.ok(!html.includes('/brand/logo-white.png'), `${rel} never uses the white lockup`);
  }
  /* solo + onboarding: black brand on the light paper header,
     white brand on the dark --ink footer band. */
  for (const rel of ['public/solo.html', 'public/onboarding.html']) {
    const html = read(rel);
    const css = stripComments(html);
    const pageTokens = rootTokens(css);
    const inkLum = luminanceOfColor(pageTokens['--ink'], `${rel} --ink`);
    assert.ok(inkLum < 0.05, `${rel} footer band (--ink) is dark (luminance ${inkLum.toFixed(4)})`);
    const footerRule = declsOf(ruleBody(css, /\bfooter\s*\{([^}]*)\}/, `${rel} footer`));
    assert.ok(/var\(\s*--ink\s*\)/.test(footerRule.background || ''), `${rel} footer paints var(--ink)`);
    const header = block(html, /<header>/, '</header>', `${rel} header`);
    assert.ok(header.includes('src="/brand/logo-black.png"'), `${rel} header (light ground) uses the black lockup`);
    const footer = block(html, /<footer[\s>]/, '</footer>', `${rel} footer`);
    assert.ok(footer.includes('src="/brand/logo-white.png"'), `${rel} footer (dark ground) uses the white lockup`);
  }
});

check('M7 already-correct dark surfaces are unchanged', () => {
  const shell = read('public/index.html');
  assert.ok(
    shell.includes('<img class="brand-logo" src="/brand/logo-white.png"'),
    'staff sidebar keeps the white lockup'
  );
  const portal = read('public/portal.html');
  assert.ok(
    portal.includes('<img class="portal-brand-logo" src="/brand/logo-white.png"'),
    'portal sidenav (dark) keeps the white lockup'
  );
  assert.equal(
    count(portal, '/brand/logo-white.png'),
    1,
    'portal white lockup appears exactly once (the dark sidenav)'
  );
  assert.ok(portal.includes('/brand/logo-black.png'), 'portal gate (light ground) keeps the black lockup');
  const appNorm = read('public/js/app.js').replace(/\\/g, '');
  const blocks = appNorm.match(/<div class="auth-brand">.*?<\/div>/g) || [];
  assert.equal(blocks.length, 2, 'login + MFA screens each build an auth brand');
  for (const b of blocks) {
    assert.ok(b.includes('src="/brand/logo-white.png"'), 'auth gates keep the white lockup (Batch 144)');
    assert.ok(!b.includes('logo-black'), 'auth gates never use the black lockup');
  }
});

check('M8 emails: one selection point, light grounds, the light variant', () => {
  const tpl = read('src/emailTemplate.js');
  assert.ok(
    tpl.includes("return base ? `${base}/brand/logo-email.png` : '/brand/logo-email.png';"),
    'logoUrl() resolves the email lockup'
  );
  /* The grounds the logo actually renders on in the shared shell. */
  const bgLum = luminanceOfColor('#f3f0ea', 'email body ground');
  const surfaceLum = luminanceOfColor('#fffcf8', 'email card ground');
  assert.ok(
    tpl.includes("bg: '#f3f0ea'") && tpl.includes("surface: '#fffcf8'"),
    'email grounds are the pinned light tones'
  );
  assert.ok(
    bgLum > 0.5 && surfaceLum > 0.5,
    'email grounds are light — the light (black) lockup is the legible variant'
  );
  /* mailer.js is the single funnel: every sender's HTML is wrapped
     by this template, so this is the only logo selection in mail. */
  const mailer = read('server/mailer.js');
  assert.ok(mailer.includes("require('../src/emailTemplate')"), 'mailer wraps through the shared email template');
  assert.ok(
    mailer.includes('renderBrandedEmail') && mailer.includes('ensureBrandedEmail'),
    'both wrap paths use the shared template'
  );
  /* No mail-sending module hardcodes a platform lockup of its own. */
  const mailFiles = [
    'server/billing.js',
    'server/domain.js',
    'server/domainFlow.js',
    'server/interestedFollowup.js',
    'server/lifecycleComms.js',
    'server/mailingList.js',
    'server/newsletter.js',
    'server/signup.js',
    'server/landingThankYou.js',
    'src/email.js',
    'src/designJobs.js',
    'src/outreach.js',
    'src/socialMedia.js',
  ];
  for (const rel of mailFiles) {
    const src = read(rel);
    assert.ok(
      !src.includes('/brand/logo-white') && !src.includes('/brand/logo-black'),
      `${rel} carries no hardcoded platform lockup`
    );
  }
});

console.log(`batch146 logo-ground checks passed (${results.length}):`);
for (const r of results) console.log('  - ' + r);
