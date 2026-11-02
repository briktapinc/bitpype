/**
 * Static blog pages (Batch 32 — C6) regressions.
 *
 * Blog posts used to exist only as a client-side module payload on one
 * shared ?bpItem= URL — no indexable post URLs. The exporter now
 * server-renders a static card snapshot into the blog mount and one
 * static page per PUBLISHED post at blog/<post-slug> with BlogPosting
 * JSON-LD; the sitemap carries each post with its own lastmod; drafts
 * never appear. Fixtures: (A) pure writeStaticPages with a threaded
 * seo.blog context, (B) a full DB site (posts + published blog embed)
 * through buildSeoExportContext + export + website.qa, (C) a DB site
 * with published posts but no blog page — website.qa must FAIL.
 *
 * Run via tests/run-regressions.cjs (DB_DRIVER=sqlite).
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || process.env.DB_DRIVER || 'sqlite';

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch {
  DatabaseSync = null;
}
let BetterSqlite3 = null;
if (!DatabaseSync) {
  try {
    BetterSqlite3 = require('better-sqlite3');
  } catch {
    BetterSqlite3 = null;
  }
}
function openDb(file) {
  if (DatabaseSync) return new DatabaseSync(file);
  if (BetterSqlite3) return new BetterSqlite3(file);
  throw new Error('No sqlite driver available (node:sqlite or better-sqlite3).');
}

const engine = require('../src/websiteEngine');
const siteModules = require('../server/siteModules');

const checks = [];
function check(name, fn) {
  checks.push([name, fn]);
}
function acheck(name, cond, msg) {
  checks.push([name, () => assert.ok(cond, msg || name)]);
}

const EXPORT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-blog-static-'));
const BASE = 'https://fixtureplumbing.example';

const NAV = {
  type: 'nav',
  content: { brand: 'Fixture Plumbing', links: [{ label: 'Home', href: '/' }, { label: 'Blog', href: '/blog' }] },
};
const FOOT = { type: 'footer', content: { text: '© 2026 Fixture Plumbing LLC' } };

function ldBlocks(html, type) {
  const out = [];
  const re = /<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(String(html || '')))) {
    try {
      const parsed = JSON.parse(m[1]);
      if (!type || parsed['@type'] === type) out.push(parsed);
    } catch {
      /* ignore unparsable blocks */
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Fixture A — pure export with a threaded seo.blog context            */
/* ------------------------------------------------------------------ */

const POST_A = {
  slug: 'fix-a-leaky-faucet',
  title: 'How to Fix a Leaky Faucet',
  excerpt: 'A dripping faucet wastes gallons a week — here is the 20-minute fix.',
  bodyHtml:
    '<p>A dripping faucet is more than an annoyance. It can waste hundreds of gallons of water a year and stain your sink.</p><p>Start by shutting off the water supply valves under the sink, then open the faucet to drain the lines.</p><p>Remove the handle, pull the cartridge, and match the replacement at the hardware store.</p>',
  coverImage: 'images/faucet.webp',
  publishedAt: '2026-10-20 14:00:00',
  updatedAt: '2026-10-24 09:30:00',
};
const POST_B = {
  slug: 'water-heater-maintenance',
  title: 'Water Heater Maintenance Basics',
  excerpt: '',
  bodyHtml:
    '<p>Your water heater works quietly in the corner until the day it does not. A yearly flush clears the sediment that shortens its life and drives up your energy bill.</p><p>Drain two gallons from the relief valve every spring and test the temperature pressure valve.</p>',
  coverImage: '',
  publishedAt: '2026-10-25 08:15:00',
  updatedAt: '2026-10-25 08:15:00',
};
const DRAFT_POST = {
  slug: 'secret-draft-post',
  title: 'Secret Draft Post',
  excerpt: 'This draft must never be exported.',
  bodyHtml: '<p>Draft body that must not ship.</p>',
  coverImage: '',
  publishedAt: '',
  updatedAt: '2026-10-26 10:00:00',
};

const PAGES_A = [
  {
    slug: 'index',
    title: 'Fixture Plumbing | Plumber in Reading, PA',
    navVisible: false,
    sections: [
      NAV,
      { type: 'hero', content: { title: 'Fixture Plumbing', subtitle: 'Reading PA plumbers.' } },
      FOOT,
    ],
  },
  {
    slug: 'blog',
    title: 'Blog | Fixture Plumbing',
    sections: [
      NAV,
      { type: 'heading', content: { title: 'Plumbing Tips & News' } },
      { type: 'site_module', content: { module_type: 'blog', public_token: 'tok-blog-a', title: 'Blog' } },
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

const outA = engine.writeStaticPages(PAGES_A, {}, path.join(EXPORT_ROOT, 'a'), {
  seo: {
    baseUrl: BASE,
    business: BIZ,
    moduleFaqItems: [],
    blog: {
      pagePath: 'blog',
      posts: [POST_B, POST_A], // newest first, as the payload orders them
      embeds: { 'tok-blog-a': { postLimit: null, showExcerpt: true } },
    },
  },
  siteUpdatedAt: '2026-10-26 12:00:00',
});

check('A: static post pages exist for published posts only', () => {
  assert.ok(fs.existsSync(path.join(EXPORT_ROOT, 'a', 'blog', 'fix-a-leaky-faucet.html')));
  assert.ok(fs.existsSync(path.join(EXPORT_ROOT, 'a', 'blog', 'water-heater-maintenance.html')));
  assert.ok(!fs.existsSync(path.join(EXPORT_ROOT, 'a', 'blog', 'secret-draft-post.html')));
  assert.ok(outA.files.includes('blog/fix-a-leaky-faucet.html'));
});

const postHtmlA = fs.readFileSync(path.join(EXPORT_ROOT, 'a', 'blog', 'fix-a-leaky-faucet.html'), 'utf8');
const postHtmlB = fs.readFileSync(path.join(EXPORT_ROOT, 'a', 'blog', 'water-heater-maintenance.html'), 'utf8');

check('A: post page renders H1 title, publish date, cover and full body', () => {
  assert.ok(postHtmlA.includes('<h1>How to Fix a Leaky Faucet</h1>'));
  assert.ok(postHtmlA.includes('<time datetime="2026-10-20T14:00:00.000Z">Oct 20, 2026</time>'));
  assert.ok(postHtmlA.includes('class="bp-post-cover"'));
  assert.ok(postHtmlA.includes(`${BASE}/images/faucet.webp`));
  assert.ok(postHtmlA.includes('waste hundreds of gallons of water a year'));
  assert.ok(postHtmlA.includes('Fixture Plumbing'), 'site chrome (nav brand) present');
});

check('A: post head — unique title, meta description, canonical, og article + image', () => {
  assert.ok(postHtmlA.includes('<title>How to Fix a Leaky Faucet</title>'));
  assert.ok(
    postHtmlA.includes(
      '<meta name="description" content="A dripping faucet wastes gallons a week — here is the 20-minute fix.">'
    )
  );
  assert.ok(postHtmlA.includes(`<link rel="canonical" href="${BASE}/blog/fix-a-leaky-faucet">`));
  assert.ok(postHtmlA.includes('<meta property="og:type" content="article">'));
  assert.ok(postHtmlA.includes(`<meta property="og:image" content="${BASE}/images/faucet.webp">`));
});

check('A: BlogPosting JSON-LD parses with headline, dates, image, business author/publisher', () => {
  const blocks = ldBlocks(postHtmlA, 'BlogPosting');
  assert.equal(blocks.length, 1);
  const ld = blocks[0];
  assert.equal(ld.headline, 'How to Fix a Leaky Faucet');
  assert.equal(ld.datePublished, '2026-10-20T14:00:00.000Z');
  assert.equal(ld.dateModified, '2026-10-24T09:30:00.000Z');
  assert.deepEqual(ld.image, [`${BASE}/images/faucet.webp`]);
  assert.equal(ld.author['@type'], 'Organization');
  assert.equal(ld.author.name, 'Fixture Plumbing LLC');
  assert.equal(ld.publisher.name, 'Fixture Plumbing LLC');
  assert.equal(ld.url, `${BASE}/blog/fix-a-leaky-faucet`);
  assert.equal(ld.mainEntityOfPage['@id'], `${BASE}/blog/fix-a-leaky-faucet`);
});

check('A: post without excerpt/cover gets a derived description and no image', () => {
  assert.ok(postHtmlB.includes('<meta name="description" content="Your water heater works quietly'));
  assert.ok(!postHtmlB.includes('<img class="bp-post-cover"'));
  const ld = ldBlocks(postHtmlB, 'BlogPosting')[0];
  assert.ok(ld, 'BlogPosting present');
  assert.equal(ld.headline, 'Water Heater Maintenance Basics');
  assert.equal(ld.image, undefined);
  assert.equal(ld.datePublished, '2026-10-25T08:15:00.000Z');
});

const blogIndexA = fs.readFileSync(path.join(EXPORT_ROOT, 'a', 'blog.html'), 'utf8');

check('A: blog index is server-rendered with real post URLs (no ?bpItem=)', () => {
  assert.ok(blogIndexA.includes('data-bitpype-static-blog="1"'));
  assert.ok(blogIndexA.includes('href="/blog/fix-a-leaky-faucet"'));
  assert.ok(blogIndexA.includes('href="/blog/water-heater-maintenance"'));
  assert.ok(blogIndexA.includes('How to Fix a Leaky Faucet'));
  assert.ok(blogIndexA.includes('Water Heater Maintenance Basics'));
  assert.ok(blogIndexA.includes('Oct 20, 2026'));
  assert.ok(blogIndexA.includes('background-image:url('), 'cover painted on the card');
  assert.ok(!blogIndexA.includes('bpItem='), 'no client-side item pattern in exported HTML');
  assert.ok(!blogIndexA.includes('Secret Draft Post'), 'draft never rendered');
});

check('A: sitemap lists post URLs with each post\'s own lastmod', () => {
  const sm = fs.readFileSync(path.join(EXPORT_ROOT, 'a', 'sitemap.xml'), 'utf8');
  assert.ok(sm.includes(`<loc>${BASE}/blog/fix-a-leaky-faucet</loc>`));
  assert.ok(sm.includes(`<loc>${BASE}/blog/water-heater-maintenance</loc>`));
  const blockA = sm.split('<url>').find((b) => b.includes('fix-a-leaky-faucet'));
  assert.ok(blockA.includes('<lastmod>2026-10-24</lastmod>'), 'post A lastmod = its updated stamp');
  const blockB = sm.split('<url>').find((b) => b.includes('water-heater-maintenance'));
  assert.ok(blockB.includes('<lastmod>2026-10-25</lastmod>'));
  assert.ok(!sm.includes('secret-draft-post'), 'draft absent from sitemap');
});

check('A: post_limit mount setting trims the index snapshot but not the post pages', () => {
  const out = engine.writeStaticPages(PAGES_A, {}, path.join(EXPORT_ROOT, 'a-limit'), {
    seo: {
      baseUrl: BASE,
      business: BIZ,
      blog: { pagePath: 'blog', posts: [POST_B, POST_A], embeds: { 'tok-blog-a': { postLimit: 1, showExcerpt: false } } },
    },
  });
  const idx = fs.readFileSync(path.join(EXPORT_ROOT, 'a-limit', 'blog.html'), 'utf8');
  assert.ok(idx.includes('Water Heater Maintenance Basics'), 'newest post kept');
  assert.ok(!idx.includes('How to Fix a Leaky Faucet'), 'older post beyond the limit');
  assert.ok(!idx.includes('bp-mod-excerpt'), 'show_excerpt=false hides excerpts');
  assert.ok(fs.existsSync(path.join(EXPORT_ROOT, 'a-limit', 'blog', 'fix-a-leaky-faucet.html')));
  assert.ok(out.files.includes('blog/fix-a-leaky-faucet.html'));
});

/* ------------------------------------------------------------------ */
/* Fixture B — DB site: context threading + export + QA                */
/* ------------------------------------------------------------------ */

function makeSite(db, { withBlog }) {
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'src', 'schema.sql'), 'utf8'));
  engine.ensureTables(db);
  const info = db
    .prepare(
      "INSERT INTO leads (business_name, category, phone, email, city, services) VALUES (?, 'Plumber', ?, ?, 'Reading', ?)"
    )
    .run(
      'Fixture Plumbing LLC',
      '(610) 555-0134',
      `fixture-${Math.random().toString(36).slice(2, 10)}@example.com`,
      JSON.stringify(['Plumbing'])
    );
  const leadId = Number(info.lastInsertRowid);
  const pages = [
    {
      slug: 'index',
      title: 'Fixture Plumbing | Plumber in Reading, PA',
      navVisible: false,
      sections: [NAV, { type: 'hero', content: { title: 'Fixture', subtitle: 'Plumbers.' } }, FOOT],
    },
  ];
  if (withBlog) {
    pages.push({
      slug: 'blog',
      title: 'Blog | Fixture Plumbing',
      sections: [
        NAV,
        { type: 'heading', content: { title: 'Plumbing Tips & News' } },
        { type: 'site_module', content: { module_type: 'blog', public_token: 'tok-blog-b', title: 'Blog' } },
        FOOT,
      ],
    });
  }
  const site = db
    .prepare(
      "INSERT INTO websites (lead_id, name, industry, theme, pages, status) VALUES (?, 'Fixture Plumbing LLC', 'plumber', '{}', ?, 'draft')"
    )
    .run(leadId, JSON.stringify(pages));
  return { leadId, websiteId: Number(site.lastInsertRowid), pages };
}

function seedBlog(db, leadId, { withEmbed }) {
  siteModules.ensureTables(db);
  if (withEmbed) {
    db.prepare(
      "INSERT INTO site_module_embeds (lead_id, module_type, title, public_token, published, embed_enabled, target_page_slug, settings_json, created_at, updated_at) VALUES (?, 'blog', 'Blog', 'tok-blog-b', 1, 1, 'blog', '{}', datetime('now'), datetime('now'))"
    ).run(leadId);
  }
  siteModules.createBlogPost(db, leadId, {
    title: 'How to Fix a Leaky Faucet',
    body_html: POST_A.bodyHtml,
    cover_image: 'images/faucet.webp',
    excerpt: POST_A.excerpt,
    status: 'published',
    published_at: '2026-10-20 14:00:00',
  });
  siteModules.createBlogPost(db, leadId, {
    title: 'Water Heater Maintenance Basics',
    body_html: POST_B.bodyHtml,
    status: 'published',
    published_at: '2026-10-25 08:15:00',
  });
  siteModules.createBlogPost(db, leadId, {
    title: 'Secret Draft Post',
    body_html: '<p>Draft body that must not ship.</p>',
    status: 'draft',
  });
}

const dbB = openDb(':memory:');
const fixB = makeSite(dbB, { withBlog: true });
seedBlog(dbB, fixB.leadId, { withEmbed: true });

check('B: buildSeoExportContext threads published posts + mounts (draft excluded)', () => {
  const ctx = engine.buildSeoExportContext(dbB, fixB.websiteId);
  assert.ok(ctx.blog, 'blog context present');
  assert.equal(ctx.blog.pagePath, 'blog');
  assert.equal(ctx.blog.posts.length, 2);
  assert.ok(ctx.blog.posts.every((p) => p.slug !== 'secret-draft-post'));
  assert.ok(ctx.blog.embeds['tok-blog-b'], 'mount settings threaded by token');
  const faucet = ctx.blog.posts.find((p) => p.slug === 'how-to-fix-a-leaky-faucet');
  assert.ok(faucet && faucet.bodyHtml.includes('waste hundreds of gallons'));
  return ctx;
});

check('B: export through the threaded context emits static post pages', () => {
  const ctx = engine.buildSeoExportContext(dbB, fixB.websiteId);
  const outDir = path.join(EXPORT_ROOT, 'b');
  engine.writeStaticPages(fixB.pages, {}, outDir, { seo: ctx, siteUpdatedAt: ctx.siteUpdatedAt });
  assert.ok(fs.existsSync(path.join(outDir, 'blog', 'how-to-fix-a-leaky-faucet.html')));
  assert.ok(fs.existsSync(path.join(outDir, 'blog', 'water-heater-maintenance-basics.html')));
  assert.ok(!fs.existsSync(path.join(outDir, 'blog', 'secret-draft-post.html')));
  const idx = fs.readFileSync(path.join(outDir, 'blog.html'), 'utf8');
  assert.ok(idx.includes('href="/blog/how-to-fix-a-leaky-faucet"'));
  assert.ok(!idx.includes('bpItem='));
});

check('B: website.qa PASSES seo-foundations for a blogged site', async () => {
  const qa = await engine.qaSite(dbB, fixB.websiteId);
  const seo = qa.checks.find((c) => c.name === 'seo-foundations');
  assert.ok(seo, 'seo-foundations check present');
  assert.equal(seo.pass, true, seo.detail);
});

/* ------------------------------------------------------------------ */
/* Fixture C — published posts but NO blog page: QA must FAIL          */
/* ------------------------------------------------------------------ */

const dbC = openDb(':memory:');
const fixC = makeSite(dbC, { withBlog: false });
seedBlog(dbC, fixC.leadId, { withEmbed: false });

check('C: website.qa FAILS seo-foundations when posts have no static pages', async () => {
  const ctx = engine.buildSeoExportContext(dbC, fixC.websiteId);
  assert.equal(ctx.blog, null, 'no mount → no blog context');
  const qa = await engine.qaSite(dbC, fixC.websiteId);
  const seo = qa.checks.find((c) => c.name === 'seo-foundations');
  assert.ok(seo, 'seo-foundations check present');
  assert.equal(seo.pass, false, 'must fail');
  assert.ok(/blog:/.test(seo.detail), `failure names the blog gap: ${seo.detail}`);
});

/* ------------------------------------------------------------------ */
/* Client embed + script version                                       */
/* ------------------------------------------------------------------ */

check('embed script keeps static snapshots and resolves legacy ?bpItem= links', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'module-embed.js'), 'utf8');
  assert.ok(js.includes("data-bitpype-static-blog"), 'static snapshot marker handled');
  assert.ok(js.includes('staticBlogPostUrl'), 'legacy link resolver present');
  assert.ok(js.includes('location.replace(staticBlogPostUrl'), 'redirects to the static post URL');
  assert.equal(siteModules.MODULE_SCRIPT_VER, 'mod24', 'Batch 32 bumps the embed script version');
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
    console.error(JSON.stringify({ file: 'blog-static-regressions', passed: false, failures: failures.length }));
    process.exit(1);
  }
  console.log(JSON.stringify({ file: 'blog-static-regressions', passed: true, checks: checks.length }));
})();
