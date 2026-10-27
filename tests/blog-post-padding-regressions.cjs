/**
 * Blog post edge padding (Batch 33) regressions.
 *
 * The Batch 32 static blog stylesheet (BLOG_POST_CSS in src/websiteEngine.js,
 * injected inline by blogArticleHtml) shipped `.bp-post` with ZERO horizontal
 * padding, so every site's blog post pages rendered flush to the screen edges
 * (caught live on Berks Roll-Off, 2026-10-27). The shared template now carries
 * the platform-standard inset: 28px horizontal on desktop, 22px at ≤700px,
 * with box-sizing:border-box so the 760px column does not widen.
 *
 * Checks: (A) the BLOG_POST_CSS constant in the engine source carries the
 * inset at both widths, (B) an exported static blog post page's inline blog
 * stylesheet carries the same inset — so the padding ships in the artifact,
 * not just the source.
 *
 * Run via tests/run-regressions.cjs (DB_DRIVER=sqlite).
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DB_DRIVER = process.env.DB_DRIVER || 'sqlite';

const engine = require('../src/websiteEngine');

const checks = [];
function check(name, fn) {
  checks.push([name, fn]);
}

/* ------------------------------------------------------------------ */
/* Tiny CSS reader — just enough to read .bp-post rules + media blocks */
/* ------------------------------------------------------------------ */

function extractMediaBlock(css, query) {
  const start = css.indexOf(query);
  if (start === -1) return null;
  const open = css.indexOf('{', start);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') {
      depth--;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  return null;
}

function stripMediaBlocks(css) {
  let out = '';
  let i = 0;
  while (i < css.length) {
    const at = css.indexOf('@media', i);
    if (at === -1) {
      out += css.slice(i);
      break;
    }
    out += css.slice(i, at);
    const open = css.indexOf('{', at);
    let depth = 0;
    let j = open;
    for (; j < css.length; j++) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    i = j + 1;
  }
  return out;
}

function ruleBody(css, selector) {
  // Matches `.bp-post{...}` but not `.bp-post-back{...}` / `.bp-post h1{...}`.
  const re = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}');
  const m = css.match(re);
  return m ? m[1] : null;
}

function px(value) {
  const v = String(value || '').trim();
  if (v === '0') return 0;
  const m = v.match(/^(\d+(?:\.\d+)?)px$/);
  return m ? Number(m[1]) : NaN;
}

/** Effective horizontal padding (left/right in px) from one rule body,
 *  honouring in-rule cascade order (shorthand, then longhands). */
function horizontalPadding(body) {
  let left = null;
  let right = null;
  for (const decl of String(body || '').split(';')) {
    const idx = decl.indexOf(':');
    if (idx === -1) continue;
    const prop = decl.slice(0, idx).trim();
    const value = decl.slice(idx + 1).trim();
    if (prop === 'padding') {
      const parts = value.split(/\s+/);
      const h = parts.length === 1 ? parts[0] : parts.length === 4 ? null : parts[1];
      if (parts.length === 4) {
        right = px(parts[1]);
        left = px(parts[3]);
      } else {
        left = px(h);
        right = px(h);
      }
    } else if (prop === 'padding-left') {
      left = px(value);
    } else if (prop === 'padding-right') {
      right = px(value);
    }
  }
  return { left, right };
}

function assertPostInset(css, label) {
  const baseCss = stripMediaBlocks(css);
  const base = ruleBody(baseCss, '.bp-post');
  assert.ok(base, `${label}: .bp-post base rule present`);
  assert.ok(
    /box-sizing\s*:\s*border-box/.test(base),
    `${label}: .bp-post carries box-sizing:border-box (got: ${base})`
  );
  const desk = horizontalPadding(base);
  assert.ok(desk.left > 0 && desk.right > 0, `${label}: desktop horizontal inset is non-zero (got ${JSON.stringify(desk)})`);
  assert.equal(desk.left, 28, `${label}: desktop padding-left is 28px`);
  assert.equal(desk.right, 28, `${label}: desktop padding-right is 28px`);

  const media = extractMediaBlock(css, '@media(max-width:700px)');
  assert.ok(media, `${label}: @media(max-width:700px) block present`);
  const mobile = ruleBody(media, '.bp-post');
  assert.ok(mobile, `${label}: .bp-post rule inside the ≤700px media block`);
  const mob = horizontalPadding(mobile);
  assert.ok(mob.left > 0 && mob.right > 0, `${label}: mobile horizontal inset is non-zero (got ${JSON.stringify(mob)})`);
  assert.equal(mob.left, 22, `${label}: mobile padding-left is 22px`);
  assert.equal(mob.right, 22, `${label}: mobile padding-right is 22px`);
}

/* ------------------------------------------------------------------ */
/* A — the shipped BLOG_POST_CSS constant in the engine source         */
/* ------------------------------------------------------------------ */

function blogPostCssFromSource() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'websiteEngine.js'), 'utf8');
  const start = src.indexOf('const BLOG_POST_CSS = [');
  assert.ok(start !== -1, 'BLOG_POST_CSS constant found in src/websiteEngine.js');
  const end = src.indexOf('].join', start);
  assert.ok(end !== -1, 'BLOG_POST_CSS array terminator found');
  const block = src.slice(start, end);
  const parts = [...block.matchAll(/'([^']*)'/g)].map((m) => m[1]);
  assert.ok(parts.length >= 5, 'BLOG_POST_CSS string parts extracted');
  return parts.join('\n');
}

check('A: BLOG_POST_CSS constant carries the 28px / 22px .bp-post inset', () => {
  assertPostInset(blogPostCssFromSource(), 'source');
});

/* ------------------------------------------------------------------ */
/* B — an exported static post page ships the inset in its inline CSS  */
/* ------------------------------------------------------------------ */

const EXPORT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-blog-padding-'));

const NAV = {
  type: 'nav',
  content: { brand: 'Fixture Plumbing', links: [{ label: 'Home', href: '/' }, { label: 'Blog', href: '/blog' }] },
};
const FOOT = { type: 'footer', content: { text: '© 2026 Fixture Plumbing LLC' } };

const POST = {
  slug: 'padding-check-post',
  title: 'Padding Check Post',
  excerpt: 'A post that exists to prove the blog template inset ships.',
  bodyHtml:
    '<p>Blog post pages used to render flush to the screen edges because the shared blog stylesheet carried no horizontal padding at all.</p><p>The template now insets the post column on every site.</p>',
  coverImage: '',
  publishedAt: '2026-10-26 09:00:00',
  updatedAt: '2026-10-26 09:00:00',
};

const PAGES = [
  {
    slug: 'index',
    title: 'Fixture Plumbing | Plumber in Reading, PA',
    navVisible: false,
    sections: [NAV, { type: 'hero', content: { title: 'Fixture Plumbing', subtitle: 'Reading PA plumbers.' } }, FOOT],
  },
  {
    slug: 'blog',
    title: 'Blog | Fixture Plumbing',
    sections: [
      NAV,
      { type: 'heading', content: { title: 'Plumbing Tips & News' } },
      { type: 'site_module', content: { module_type: 'blog', public_token: 'tok-blog-pad', title: 'Blog' } },
      FOOT,
    ],
  },
];

const BIZ = {
  businessName: 'Fixture Plumbing LLC',
  category: 'Plumber',
  phone: '(610) 555-0134',
  email: 'hello@fixtureplumbing.example',
  street: '12 Penn Street',
  city: 'Reading',
  state: 'PA',
  zip: '19601',
  services: ['Plumbing'],
  towns: ['Reading'],
};

engine.writeStaticPages(PAGES, {}, path.join(EXPORT_ROOT, 'b'), {
  seo: {
    baseUrl: 'https://fixtureplumbing.example',
    business: BIZ,
    moduleFaqItems: [],
    blog: { pagePath: 'blog', posts: [POST], embeds: { 'tok-blog-pad': { postLimit: null, showExcerpt: true } } },
  },
  siteUpdatedAt: '2026-10-26 12:00:00',
});

check('B: exported post page inline blog stylesheet carries the inset', () => {
  const file = path.join(EXPORT_ROOT, 'b', 'blog', 'padding-check-post.html');
  assert.ok(fs.existsSync(file), 'static post page exported');
  const html = fs.readFileSync(file, 'utf8');
  // blogArticleHtml tags the style element, but the section render pipeline
  // strips the attribute — match the first <style> inside the article.
  const m = html.match(/data-bitpype-blog-post="1"><style[^>]*>([\s\S]*?)<\/style>/);
  assert.ok(m, 'inline blog post stylesheet present in exported HTML');
  assertPostInset(m[1], 'exported');
});

/* ------------------------------------------------------------------ */

(async () => {
  const failures = [];
  for (const [name, fn] of checks) {
    try {
      await fn();
      console.log(`  ok - ${name}`);
    } catch (e) {
      failures.push([name, e]);
      console.error(`  FAIL - ${name}: ${e.message}`);
    }
  }
  try {
    fs.rmSync(EXPORT_ROOT, { recursive: true, force: true });
  } catch {
    /* temp cleanup best-effort */
  }
  if (failures.length) {
    console.error(JSON.stringify({ file: 'blog-post-padding-regressions', passed: false, failures: failures.length }));
    process.exit(1);
  }
  console.log(JSON.stringify({ file: 'blog-post-padding-regressions', passed: true, checks: checks.length }));
})();
