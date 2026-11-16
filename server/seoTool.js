'use strict';

/**
 * AI SEO tool (Batch 22).
 *
 * Generates a local-SEO proposal for a business's website with the
 * platform AI (src/ai.js — the same chat seam every other AI feature
 * uses, keyed by the workspace's ai.api_key / ai.base_url settings),
 * shows it for review, and applies it in one action.
 *
 * Flow:
 *   generate → deterministic walk of the site's stored pages builds a
 *              target list (per page: meta title, meta description,
 *              safe heading fields, thin/missing image alts, plus one
 *              site-wide LocalBusiness JSON-LD). The AI only fills in
 *              proposed values for those target ids; unknown ids and
 *              no-op values are dropped server-side. The proposal is
 *              persisted (seo_proposals, one pending row per website)
 *              so the staff app and the client portal show the SAME
 *              pending proposal. Re-generating replaces it wholesale;
 *              generating never applies anything.
 *   apply    → writes the approved changes back into the site's stored
 *              pages/theme in one transaction (websites.pages /
 *              websites.theme), so the next render/export/publish
 *              carries them: page.title → <title>, page.description →
 *              <meta name="description">, section heading fields → the
 *              rendered <h1>/<h2>, image alt fields → the rendered
 *              <img alt>, and the JSON-LD rides theme.customHead, which
 *              the engine injects into every page's <head>. Targets
 *              that vanished since generation are reported as skipped;
 *              a hard failure rolls the whole apply back. Every apply
 *              is recorded in seo_history with who applied it
 *              (actor + actor_kind 'staff' | 'owner').
 *
 * Dormant-safe: with no ai.api_key set, getSeoState reports
 * configured:false and generate throws AI_NOT_CONFIGURED — both
 * surfaces render a clear "AI not configured" state.
 */

const ai = require('../src/ai');
const seoSchema = require('../src/seoSchema');

const SCHEMA_OPEN = '<!--bitpype-seo-schema-->';
const SCHEMA_CLOSE = '<!--/bitpype-seo-schema-->';

const CAPS = { meta_title: 120, meta_description: 320, heading: 160, image_alt: 200, keyword: 80 };
const MAX_HEADINGS_PER_PAGE = 4;
const MAX_TARGETS = 60;

// Section types whose content.title renders as the section's <h2>.
const TITLE_HEADING_TYPES = new Set([
  'benefits',
  'services',
  'about',
  'gallery',
  'reviews',
  'faq',
  'cards',
  'cta',
  'hours',
  'testimonials',
]);

function fail(code, message, extra) {
  const e = new Error(message);
  e.code = code;
  if (extra) Object.assign(e, extra);
  return e;
}

function ensureSeoTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS seo_proposals (
      website_id INTEGER PRIMARY KEY,
      lead_id INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      proposal_json TEXT NOT NULL DEFAULT '',
      generated_by TEXT NOT NULL DEFAULT '',
      generated_at TEXT,
      applied_by TEXT NOT NULL DEFAULT '',
      applied_at TEXT
    );
    CREATE TABLE IF NOT EXISTS seo_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      website_id INTEGER NOT NULL,
      lead_id INTEGER NOT NULL DEFAULT 0,
      actor TEXT NOT NULL DEFAULT '',
      actor_kind TEXT NOT NULL DEFAULT '',
      applied_json TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_seo_history_site ON seo_history (website_id, id DESC);
  `);
}

function parseJson(text, fallback) {
  if (text == null || text === '') return fallback;
  try {
    const v = JSON.parse(text);
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}

function getWebsite(db, websiteId) {
  const id = Number(websiteId);
  if (!Number.isInteger(id) || id <= 0) throw fail('NOT_FOUND', 'Website not found.');
  const site = db.prepare('SELECT * FROM websites WHERE id = ?').get(id);
  if (!site) throw fail('NOT_FOUND', 'Website not found.');
  return site;
}

function getLead(db, leadId) {
  if (!leadId) return null;
  try {
    return db.prepare('SELECT * FROM leads WHERE id = ?').get(Number(leadId)) || null;
  } catch {
    return null;
  }
}

function parsePages(site) {
  const pages = parseJson(site.pages, []);
  if (!Array.isArray(pages)) throw fail('INVALID', 'This site has no editable pages yet.');
  return pages;
}

function parseTheme(site) {
  const theme = parseJson(site.theme, {});
  return theme && typeof theme === 'object' && !Array.isArray(theme) ? theme : {};
}

function pageDescription(page) {
  return String((page && (page.description || page.metaDescription || page.meta_description)) || '');
}

function pageLabel(page, fallback) {
  const slug = String((page && page.slug) || '').trim();
  if (!slug || slug === 'index' || slug === 'home' || slug === '/') return 'Home';
  return slug.replace(/^\/+/, '').replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) || fallback;
}

/** Business context for the AI, from the lead + website records only. */
function buildContext(db, site, lead) {
  const services = new Set();
  const fromLead = parseJson(lead && lead.services, []);
  if (Array.isArray(fromLead)) for (const s of fromLead) if (s && String(s).trim()) services.add(String(s).trim());
  try {
    const facts = db
      .prepare("SELECT value FROM business_facts WHERE lead_id = ? AND fact_key LIKE 'service:%'")
      .all(Number(site.lead_id));
    for (const f of facts) if (f.value && String(f.value).trim()) services.add(String(f.value).trim());
  } catch {
    /* business_facts is optional */
  }
  // Service names already on the site (services-section items).
  try {
    for (const page of parsePages(site)) {
      for (const s of Array.isArray(page.sections) ? page.sections : []) {
        if (s && s.type === 'services' && s.content && Array.isArray(s.content.items)) {
          for (const it of s.content.items) {
            const name = it && (it.name || it.title);
            if (name && String(name).trim()) services.add(String(name).trim());
          }
        }
      }
    }
  } catch {
    /* context stays lead-based */
  }
  // Batch 31: the context now carries everything the shared schema
  // builder can use — email, url, hours, socials, geo, service towns.
  let towns = [];
  try {
    const factRows = db
      .prepare(
        "SELECT fact_key, value FROM business_facts WHERE lead_id = ? AND claim_class IN ('VERIFIED','OWNER_PROVIDED')"
      )
      .all(Number(site.lead_id));
    towns = seoSchema.serviceAreaTowns(factRows);
  } catch {
    /* business_facts is optional */
  }
  const lat = lead && lead.latitude != null ? Number(lead.latitude) : null;
  const lng = lead && lead.longitude != null ? Number(lead.longitude) : null;
  return {
    businessName: String((lead && lead.business_name) || site.name || 'Local business').trim(),
    category: String((lead && lead.category) || site.industry || '').trim(),
    city: String((lead && lead.city) || '').trim(),
    state: String((lead && lead.state) || '').trim(),
    address: String((lead && lead.address) || '').trim(),
    postalCode: String((lead && lead.postal_code) || '').trim(),
    country: String((lead && lead.country) || 'US').trim() || 'US',
    phone: String((lead && lead.phone) || '').trim(),
    email: String((lead && lead.email) || '').trim(),
    url: String((lead && lead.website) || '').trim(),
    hours: lead && lead.hours ? String(lead.hours) : '',
    socialLinks: lead && lead.social_links ? String(lead.social_links) : '',
    latitude: Number.isFinite(lat) ? lat : null,
    longitude: Number.isFinite(lng) ? lng : null,
    towns,
    services: [...services].slice(0, 12),
  };
}

/** The heading field a section renders as its main heading, if it is a safe text field. */
function headingFieldFor(section) {
  if (!section || typeof section !== 'object') return null;
  const c = section.content && typeof section.content === 'object' ? section.content : {};
  const pick = (fields) => {
    for (const f of fields) {
      if (typeof c[f] === 'string' && c[f].trim()) return { field: f, value: c[f] };
    }
    return null;
  };
  if (section.type === 'hero') return pick(['headline']);
  if (section.type === 'heading') return pick(['heading', 'title', 'text']);
  if (section.type === 'text_image') return pick(['heading', 'title']);
  if (TITLE_HEADING_TYPES.has(section.type)) return pick(['title']);
  return null;
}

function wordCount(s) {
  return String(s || '').trim().split(/\s+/).filter(Boolean).length;
}

/** Image objects in a section whose alt text is missing or thin. */
function imageTargetsFor(section) {
  const out = [];
  const c = section && typeof section.content === 'object' && section.content ? section.content : {};
  const thin = (alt) => wordCount(alt) < 4;
  if (c.image && typeof c.image === 'object' && c.image.url && thin(c.image.alt)) {
    out.push({ path: 'image', url: String(c.image.url), current: String(c.image.alt || '') });
  }
  if (Array.isArray(c.images)) {
    c.images.forEach((im, i) => {
      if (im && typeof im === 'object' && im.url && thin(im.alt)) {
        out.push({ path: `images.${i}`, url: String(im.url), current: String(im.alt || '') });
      }
    });
  }
  // Standalone image sections keep the image at the content root when a crop is set.
  if (section.type === 'image' && typeof c.url === 'string' && c.url && c.crop && thin(c.alt)) {
    out.push({ path: 'self', url: String(c.url), current: String(c.alt || '') });
  }
  return out;
}

/** Extract the currently applied SEO schema block from theme.customHead. */
function currentSchema(theme) {
  const head = String((theme && theme.customHead) || '');
  const start = head.indexOf(SCHEMA_OPEN);
  if (start < 0) return '';
  const end = head.indexOf(SCHEMA_CLOSE, start);
  if (end < 0) return '';
  const block = head.slice(start + SCHEMA_OPEN.length, end);
  const m = block.match(/<script[^>]*>([\s\S]*?)<\/script>/i);
  return (m ? m[1] : block).trim();
}

function upsertSchemaBlock(customHead, schemaJson) {
  const block = `${SCHEMA_OPEN}\n<script type="application/ld+json">\n${schemaJson}\n</script>\n${SCHEMA_CLOSE}`;
  const head = String(customHead || '');
  const start = head.indexOf(SCHEMA_OPEN);
  if (start >= 0) {
    const end = head.indexOf(SCHEMA_CLOSE, start);
    if (end >= 0) {
      return (head.slice(0, start) + block + head.slice(end + SCHEMA_CLOSE.length)).trim();
    }
  }
  return (head.trim() ? `${head.trim()}\n${block}` : block).trim();
}

/** Deterministic target walk over the stored pages. */
function collectTargets(pages, theme) {
  const targets = [];
  for (const page of pages) {
    if (!page || typeof page !== 'object') continue;
    const slug = String(page.slug || '');
    const label = pageLabel(page, 'Page');
    targets.push({
      id: `meta_title:${slug}`,
      kind: 'meta_title',
      pageSlug: slug,
      label: `${label} — page title`,
      current: String(page.title || ''),
    });
    targets.push({
      id: `meta_desc:${slug}`,
      kind: 'meta_description',
      pageSlug: slug,
      label: `${label} — meta description`,
      current: pageDescription(page),
    });
  }
  targets.push({ id: 'schema', kind: 'schema', pageSlug: '', label: 'LocalBusiness schema (JSON-LD)', current: currentSchema(theme) });
  for (const page of pages) {
    if (!page || typeof page !== 'object') continue;
    const slug = String(page.slug || '');
    const label = pageLabel(page, 'Page');
    const sections = Array.isArray(page.sections) ? page.sections : [];
    let headings = 0;
    sections.forEach((section, si) => {
      if (!section || typeof section !== 'object') return;
      if (headings < MAX_HEADINGS_PER_PAGE) {
        const h = headingFieldFor(section);
        if (h) {
          targets.push({
            id: `heading:${slug}:${si}:${h.field}`,
            kind: 'heading',
            pageSlug: slug,
            sectionIndex: si,
            field: h.field,
            label: `${label} — ${section.type} heading`,
            current: h.value,
          });
          headings += 1;
        }
      }
      for (const im of imageTargetsFor(section)) {
        targets.push({
          id: `alt:${slug}:${si}:${im.path}`,
          kind: 'image_alt',
          pageSlug: slug,
          sectionIndex: si,
          imagePath: im.path,
          label: `${label} — image alt (${section.type})`,
          current: im.current,
        });
      }
    });
  }
  return targets.slice(0, MAX_TARGETS);
}

/**
 * LocalBusiness JSON-LD — delegated to the shared builder
 * (src/seoSchema.js, Batch 31) so the AI tool and the auto-emitted
 * export schema can never drift. The tool's manual schema still rides
 * theme.customHead; when present it WINS over the auto-emitted block
 * for its @type (the renderer's dedupe rule), so applying a proposal
 * refines the entity instead of duplicating it. Only the description
 * comes from the AI.
 */
function buildSchemaLd(context, description) {
  const ctx = Object.assign({}, context || {});
  if (description) ctx.description = description;
  return seoSchema.buildLocalBusinessLd(ctx) || { '@context': 'https://schema.org', '@type': 'LocalBusiness' };
}

function clampValue(value, kind) {
  const oneLine = String(value || '').replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ').trim();
  const cap = CAPS[kind] || 200;
  return oneLine.slice(0, cap);
}

function parseAiJson(text) {
  let s = String(text || '').trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try {
    return JSON.parse(s);
  } catch {
    /* fall through to substring extraction */
  }
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(s.slice(start, end + 1));
    } catch {
      /* give up */
    }
  }
  throw fail('AI_BAD_RESPONSE', 'The AI returned an unreadable SEO proposal. Please try again.');
}

function shapeKeywords(raw) {
  const k = raw && typeof raw === 'object' ? raw : {};
  const primary = clampValue(k.primary || '', 'keyword');
  const supporting = [];
  if (Array.isArray(k.supporting)) {
    for (const s of k.supporting) {
      const v = clampValue(s, 'keyword');
      if (v && v !== primary && !supporting.includes(v)) supporting.push(v);
      if (supporting.length >= 10) break;
    }
  }
  return { primary, supporting };
}

function buildPrompt(context, targets) {
  const targetLines = targets
    .filter((t) => t.kind !== 'schema')
    .map((t) => ({ id: t.id, kind: t.kind, label: t.label, current: t.current }));
  return [
    {
      role: 'system',
      content:
        'You are a local SEO expert for small businesses. You write natural, keyword-rich copy that a real customer would trust — never keyword-stuffed, never clickbait. Respond with ONLY a JSON object, no commentary.',
    },
    {
      role: 'user',
      content: [
        `Business: ${JSON.stringify(context)}`,
        '',
        'Editable site targets (id, kind, label, current value):',
        JSON.stringify(targetLines),
        '',
        'Return a JSON object of exactly this shape:',
        '{"keywords":{"primary":"<the single best local keyword phrase>","supporting":["<up to 8 more local keyword phrases>"]},"values":{"<target id>":"<proposed value>", ...},"schemaDescription":"<1-2 sentence factual description of the business for its LocalBusiness schema>"}',
        '',
        'Rules:',
        '- keywords: what nearby customers actually type into Google — service + city phrasing (e.g. "drain cleaning in Reading PA").',
        '- values: include an entry for as many target ids as you can genuinely improve. Rewrite meta titles (aim 50-60 characters) and meta descriptions (aim 140-160 characters) to lead with the primary keyword and the city. Improve headings only where the keyword fits naturally; keep the business\'s voice and meaning. Write image alt text that describes the image content plus the service/city where natural (never "image of").',
        '- Do not invent facts: no prices, ratings, years, guarantees, or services that are not in the business context.',
        '- Omit any target you cannot improve. Do not return the schema target id in values.',
      ].join('\n'),
    },
  ];
}

function shapeHistoryRow(row) {
  const applied = parseJson(row.applied_json, {});
  const changes = Array.isArray(applied.changes) ? applied.changes : [];
  return {
    id: row.id,
    actor: row.actor || '',
    actor_kind: row.actor_kind || '',
    applied_at: row.created_at,
    change_count: changes.length,
    applied: changes.map((c) => ({ id: c.id, kind: c.kind, label: c.label, outcome: c.outcome || 'applied' })),
    keywords: applied.keywords || { primary: '', supporting: [] },
  };
}

function getSeoState(db, websiteId) {
  ensureSeoTables(db);
  const site = getWebsite(db, websiteId);
  const lead = getLead(db, site.lead_id);
  let configured = false;
  try {
    configured = !!ai.aiConfigured(db);
  } catch {
    configured = false;
  }
  const row = db.prepare('SELECT * FROM seo_proposals WHERE website_id = ?').get(site.id);
  let pending = null;
  if (row && row.status === 'pending' && row.proposal_json) {
    pending = {
      proposal: parseJson(row.proposal_json, null),
      generated_by: row.generated_by || '',
      generated_at: row.generated_at || null,
    };
  }
  const history = db
    .prepare('SELECT * FROM seo_history WHERE website_id = ? ORDER BY id DESC LIMIT 10')
    .all(site.id)
    .map(shapeHistoryRow);
  // Batch 31 (I): the site's Google Search Console verification token
  // rides the SEO state so the portal/admin SEO surfaces can show and
  // edit it; exports emit it as a meta tag on every page.
  let gscToken = '';
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(`seo.gsc.site.${site.id}`);
    if (row && row.value) {
      gscToken = String(require('../src/secretBox').decryptSetting(`seo.gsc.site.${site.id}`, row.value) || '').trim();
    }
  } catch {
    /* settings optional */
  }
  return {
    configured,
    gscToken,
    site: {
      id: site.id,
      name: site.name,
      status: site.status,
      lead_id: site.lead_id,
      business_name: (lead && lead.business_name) || site.name,
    },
    pending,
    history,
  };
}

function listSeoSites(db) {
  ensureSeoTables(db);
  let configured = false;
  try {
    configured = !!ai.aiConfigured(db);
  } catch {
    configured = false;
  }
  const rows = db
    .prepare(
      `SELECT w.id, w.name, w.status, w.lead_id, l.business_name,
              (SELECT status FROM seo_proposals p WHERE p.website_id = w.id) AS proposal_status,
              (SELECT MAX(created_at) FROM seo_history h WHERE h.website_id = w.id) AS last_applied_at
       FROM websites w LEFT JOIN leads l ON l.id = w.lead_id
       ORDER BY w.id DESC`
    )
    .all();
  return {
    configured,
    sites: rows.map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      lead_id: r.lead_id,
      business_name: r.business_name || r.name,
      has_pending: r.proposal_status === 'pending',
      last_applied_at: r.last_applied_at || null,
    })),
  };
}

async function generateSeoProposal(db, websiteId, opts = {}) {
  ensureSeoTables(db);
  const site = getWebsite(db, websiteId);
  // Batch 192 (#12): routed gate — a platform-keyed provider routed
  // for 'editor' counts as configured, not just the legacy key.
  if (!(await ai.aiConfiguredRouted(db, 'editor'))) {
    throw fail('AI_NOT_CONFIGURED', 'AI is not configured: set ai.api_key in Settings.');
  }
  const lead = getLead(db, site.lead_id);
  const pages = parsePages(site);
  const theme = parseTheme(site);
  const context = buildContext(db, site, lead);
  const targets = collectTargets(pages, theme);
  if (!targets.length) throw fail('EMPTY', 'This site has no editable pages yet.');

  const result = await ai.chat({
    task: 'editor',
    messages: buildPrompt(context, targets),
    maxTokens: 3000,
    leadId: site.lead_id || null,
    note: `seo proposal for website ${site.id}`,
    db,
  });
  const parsed = parseAiJson(result && result.text);
  const keywords = shapeKeywords(parsed && parsed.keywords);
  const values = parsed && parsed.values && typeof parsed.values === 'object' ? parsed.values : {};

  const changes = [];
  for (const t of targets) {
    if (t.kind === 'schema') continue;
    const raw = values[t.id];
    if (typeof raw !== 'string') continue;
    const proposed = clampValue(raw, t.kind);
    if (!proposed || proposed === t.current) continue;
    const change = {
      id: t.id,
      kind: t.kind,
      label: t.label,
      pageSlug: t.pageSlug,
      current: t.current,
      proposed,
    };
    if (t.sectionIndex != null) change.sectionIndex = t.sectionIndex;
    if (t.field) change.field = t.field;
    if (t.imagePath) change.imagePath = t.imagePath;
    changes.push(change);
  }

  // The JSON-LD is assembled from lead facts (never free-invented by the
  // AI); the AI contributes only its description sentence.
  const schemaLd = buildSchemaLd(context, clampValue(parsed && parsed.schemaDescription, 'meta_description'));
  const proposedSchema = JSON.stringify(schemaLd, null, 2);
  const schemaTarget = targets.find((t) => t.kind === 'schema');
  if (schemaTarget && proposedSchema !== schemaTarget.current) {
    changes.push({
      id: 'schema',
      kind: 'schema',
      label: schemaTarget.label,
      pageSlug: '',
      current: schemaTarget.current,
      proposed: proposedSchema,
    });
  }

  const actor = String(opts.actor || 'staff');
  const proposal = { version: 1, keywords, context, changes };
  db.prepare(
    `INSERT INTO seo_proposals (website_id, lead_id, status, proposal_json, generated_by, generated_at, applied_by, applied_at)
     VALUES (?, ?, 'pending', ?, ?, datetime('now'), '', NULL)
     ON CONFLICT(website_id) DO UPDATE SET
       lead_id = excluded.lead_id, status = 'pending', proposal_json = excluded.proposal_json,
       generated_by = excluded.generated_by, generated_at = datetime('now'), applied_by = '', applied_at = NULL`
  ).run(site.id, site.lead_id || 0, JSON.stringify(proposal), actor);
  return getSeoState(db, site.id);
}

function findPage(pages, slug) {
  return pages.find((p) => p && String(p.slug || '') === String(slug || '')) || null;
}

/** Mutates pages/theme for one change. Returns false when the target is gone. */
function applyChange(pages, theme, change) {
  if (change.kind === 'schema') {
    theme.customHead = upsertSchemaBlock(theme.customHead, String(change.proposed || ''));
    return true;
  }
  const page = findPage(pages, change.pageSlug);
  if (!page) return false;
  if (change.kind === 'meta_title') {
    page.title = String(change.proposed || '');
    return true;
  }
  if (change.kind === 'meta_description') {
    page.description = String(change.proposed || '');
    return true;
  }
  const sections = Array.isArray(page.sections) ? page.sections : [];
  const section = sections[Number(change.sectionIndex)];
  if (!section || typeof section !== 'object') return false;
  if (!section.content || typeof section.content !== 'object') section.content = {};
  if (change.kind === 'heading') {
    if (!change.field || typeof section.content[change.field] !== 'string') return false;
    section.content[change.field] = String(change.proposed || '');
    return true;
  }
  if (change.kind === 'image_alt') {
    const c = section.content;
    if (change.imagePath === 'image' && c.image && typeof c.image === 'object') {
      c.image.alt = String(change.proposed || '');
      return true;
    }
    if (change.imagePath === 'self' && typeof c.url === 'string') {
      c.alt = String(change.proposed || '');
      return true;
    }
    const m = /^images\.(\d+)$/.exec(String(change.imagePath || ''));
    if (m && Array.isArray(c.images) && c.images[Number(m[1])]) {
      c.images[Number(m[1])].alt = String(change.proposed || '');
      return true;
    }
    return false;
  }
  return false;
}

function applySeoProposal(db, websiteId, opts = {}) {
  ensureSeoTables(db);
  const site = getWebsite(db, websiteId);
  const row = db.prepare('SELECT * FROM seo_proposals WHERE website_id = ?').get(site.id);
  if (!row || row.status !== 'pending' || !row.proposal_json) {
    throw fail('NO_PROPOSAL', 'No pending SEO proposal for this site — generate one first.');
  }
  const proposal = parseJson(row.proposal_json, {});
  const changes = Array.isArray(proposal.changes) ? proposal.changes : [];
  if (!changes.length) {
    throw fail('NO_CHANGES', 'The pending proposal has no changes to apply.');
  }
  const pages = parsePages(site);
  const theme = parseTheme(site);
  const actor = String(opts.actor || 'staff');
  const actorKind = String(opts.actorKind || 'staff');

  const outcomes = [];
  // One transaction: a hard failure anywhere rolls every change back.
  const run = db.transaction(() => {
    for (const change of changes) {
      const okApply = applyChange(pages, theme, change);
      outcomes.push({ ...change, outcome: okApply ? 'applied' : 'skipped' });
    }
    db.prepare("UPDATE websites SET pages = ?, theme = ?, updated_at = datetime('now') WHERE id = ?").run(
      JSON.stringify(pages),
      JSON.stringify(theme),
      site.id
    );
    const appliedOnly = outcomes.filter((o) => o.outcome === 'applied');
    db.prepare('INSERT INTO seo_history (website_id, lead_id, actor, actor_kind, applied_json) VALUES (?, ?, ?, ?, ?)').run(
      site.id,
      site.lead_id || 0,
      actor,
      actorKind,
      JSON.stringify({ keywords: proposal.keywords || { primary: '', supporting: [] }, changes: appliedOnly })
    );
    db.prepare(
      "UPDATE seo_proposals SET status = 'applied', applied_by = ?, applied_at = datetime('now') WHERE website_id = ?"
    ).run(actor, site.id);
  });
  run();

  try {
    db.prepare('INSERT INTO activity_log (area, message) VALUES (?, ?)').run(
      'seo',
      `SEO proposal applied to website ${site.id} by ${actorKind} (${outcomes.filter((o) => o.outcome === 'applied').length} changes)`
    );
  } catch {
    /* activity log is best-effort */
  }

  return {
    applied: outcomes.filter((o) => o.outcome === 'applied'),
    skipped: outcomes.filter((o) => o.outcome === 'skipped'),
    state: getSeoState(db, site.id),
  };
}

module.exports = {
  ensureSeoTables,
  getSeoState,
  listSeoSites,
  generateSeoProposal,
  applySeoProposal,
  // Exported for tests / reuse:
  collectTargets,
  buildSchemaLd,
  currentSchema,
  upsertSchemaBlock,
  SCHEMA_OPEN,
  SCHEMA_CLOSE,
};
