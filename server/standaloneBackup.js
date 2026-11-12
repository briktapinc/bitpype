'use strict';

/**
 * Batch 155 — STANDALONE SITE BACKUP GENERATOR (clone model).
 *
 * Assembles the package defined in
 * ~/workspace/website-scout/standalone-site-backup-spec.md §2:
 *
 *   <slug>-standalone-backup/
 *     manifest.json     format version, source ids, app git sha,
 *                       feature flags, per-file sha256
 *     site/             the fully baked static site (exportStatic +
 *                       FULL detail-content bake, every endpoint
 *                       repointed at the clone's own origin)
 *     seed/
 *       platform.sqlite a fresh central DB (the app's own sqlite
 *                       migrate) holding ONLY the target workspace's
 *                       rows, selected through the live DB facade
 *       tenant.sqlite   the workspace's tenant DB (better-sqlite3
 *                       backup of the live handle — consistent copy)
 *       exports/        the site's export folders (asset binaries)
 *     app/              the application tree, exactly the paths the
 *                       production Dockerfile ships
 *     docker-compose.yml / Caddyfile / install.sh / uninstall.sh
 *
 * Guarantees pinned by tests/batch155-single-site-backup.cjs:
 *   - NO platform secrets: platform_settings is never copied (it
 *     holds the platform's encrypted keys); workspace bearer tokens,
 *     sessions, OAuth grants and billing rows never travel either —
 *     see SEED_EXCLUDE. Tenant-DB settings encrypted under the
 *     platform key become inert on the clone (they cannot decrypt
 *     under the clone's fresh key) and the installer wizard supplies
 *     the owner's own keys instead.
 *   - NO second workspace: seed rows are selected with the target
 *     workspace id as the only predicate; the suite's census scans
 *     every package file for a decoy workspace's marker strings.
 *   - NO platform-host references survive in site/: the bake
 *     repoints every platform-origin URL to a relative path and
 *     the build FAILS if the scan still finds one.
 *   - Idempotent content: generating twice from unchanged state
 *     yields identical files except manifest.json timestamps (the
 *     export's own preview_path write is restored afterwards).
 *
 * The detail bake renders item content server-side from the SAME
 * payload the public item API serves (siteModules.getPublicModuleItem
 * — the exact object module-embed.js renderItem consumes). renderItem
 * itself is closure-private client code with no server export, so the
 * bake uses the tolerant renderer below with renderItem's class
 * vocabulary; on the live clone, module-embed.js still re-renders
 * every detail page exactly as on the platform — the baked copy is
 * the zero-dependency guarantee when the app container is stopped.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const FORMAT_VERSION = 1;

/* Batch 177: the demo portal account a package seed gains when the
 * target lead has no portal account of its own (see the seed block
 * in buildSeedPlatformDb). The .invalid domain makes the identity
 * unmistakable and guarantees it can never be a real client's
 * credential or collide with a deliverable mailbox. */
const DEMO_PORTAL_EMAIL = 'demo-owner@standalone.invalid';

/* The application tree, exactly as the production Dockerfile COPYs
 * it (plus standalone/, which the Dockerfile also carries so this
 * generator's installer assets exist inside the image). */
const APP_TREE_PATHS = [
  'package.json',
  'package-lock.json',
  'Dockerfile',
  'server.js',
  'vendor',
  'server',
  'src',
  'sql',
  'public',
  'scripts',
  'integrations',
  'standalone',
];

/* Client scripts the baked site loads from the app origin; copied
 * into site/js/ so the static copy is self-contained. */
const EMBED_JS = [
  'module-embed.js',
  'form-embed.js',
  'chat-embed.js',
  'captcha.js',
  'fonts.js',
  'cookie-bar.js',
  'site-analytics.js',
  'webinar-embed.js',
];

/* Central-DB tables that NEVER travel, even when they carry a
 * workspace_id column: platform secrets/config, credentials,
 * ephemeral auth state, platform billing and platform programs. */
const SEED_EXCLUDE = new Set([
  'platform_settings',
  'platform_audit',
  'sessions',
  'workspace_tokens',
  'workspace_invites',
  'password_reset_tokens',
  'payments',
  'refunds',
  'stripe_events',
  'credit_balances',
  'credit_ledger',
  'portal_referrals',
  'partner_earnings',
  'partner_payouts',
  'partner_approval_requests',
  'mailing_list_subscribers',
  'mailing_list_sends',
  'mcp_oauth_auth_codes',
  'mcp_oauth_refresh_tokens',
  'mcp_oauth_clients',
  'rate_limit_hits',
  'deployments',
  'signup_plan_choices',
  'upsell_tips',
  'upsell_tip_impressions',
  'client_portal_login_tokens',
  'client_portal_password_tokens',
  'subscription_suspensions',
  'subscription_suspension_workspaces',
]);

function fail(code, message, status) {
  const e = new Error(message);
  e.code = code;
  if (status) e.status = status;
  return e;
}

function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function sha256File(abs) {
  return sha256Buffer(fs.readFileSync(abs));
}

function walkFiles(dir, base) {
  const out = [];
  const root = base || dir;
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir).sort()) {
    const abs = path.join(dir, name);
    const st = fs.statSync(abs);
    if (st.isDirectory()) out.push(...walkFiles(abs, root));
    else if (st.isFile()) out.push(path.relative(root, abs).split(path.sep).join('/'));
  }
  return out;
}

function slugFor(name, websiteId) {
  const s = String(name || 'site')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `${s || 'site'}-${websiteId}`;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function moneyLabel(it) {
  if (it == null) return '';
  if (typeof it.price_label === 'string' && it.price_label) return it.price_label;
  if (typeof it.display_price === 'string' && it.display_price) return it.display_price;
  const cents = it.price_cents != null ? it.price_cents : it.price != null ? Math.round(Number(it.price) * 100) : null;
  if (cents != null && Number.isFinite(cents)) return `$${(Number(cents) / 100).toFixed(2)}`;
  return '';
}

/* The moduleShare uniform primary photo, mirroring siteModules'
 * detailItemPhoto (Batch 141): blog/courses cover first, gallery
 * first album image, video thumbnail, else image_url. */
function detailItemPhoto(type, it) {
  if (!it) return '';
  let url = '';
  if (type === 'blog' || type === 'courses') url = it.cover_image || it.image_url || '';
  else if (type === 'gallery') {
    const first = Array.isArray(it.images) ? it.images[0] : null;
    url = (first && first.image_url) || it.cover_image || it.image_url || '';
  } else if (type === 'video') url = it.thumbnail_url || it.image_url || '';
  else url = it.image_url || it.cover_image || '';
  return String(url || '').trim();
}

/**
 * Server-side detail renderer for the static bake. Consumes the
 * public item payload ({ module_type, item, ... }) and emits the
 * detail article with renderItem's class vocabulary (bp-mod-detail,
 * bp-mod-hero, bp-mod-content, bp-mod-meta). Tolerant by design: an
 * unfamiliar field is skipped, never fatal — the bake must not break
 * a backup over one module's shape.
 */
function renderDetailItemHtml(type, payload, backHref) {
  const it = (payload && payload.item) || {};
  const title = it.title || it.name || it.question || '';
  const photo = detailItemPhoto(type, it);
  const parts = [];
  if (backHref) parts.push(`<a class="bp-mod-back" href="${esc(backHref)}">← Back</a>`);
  parts.push('<article class="bp-mod-detail">');
  if (photo) parts.push(`<img class="bp-mod-hero" src="${esc(photo)}" alt="" />`);
  if (title) parts.push(`<h1>${esc(title)}</h1>`);

  const meta = [];
  if (type === 'blog' && (it.published_at || it.created_at)) meta.push(String(it.published_at || it.created_at));
  if (type === 'careers') {
    if (it.employment_type) meta.push(String(it.employment_type));
    if (it.location) meta.push(String(it.location));
  }
  if (type === 'events') {
    if (it.starts_at) meta.push(String(it.starts_at));
    if (it.location) meta.push(String(it.location));
  }
  if (type === 'categories' && it.scope_label) meta.push(String(it.scope_label));
  if (type === 'directory') {
    if (it.category_name) meta.push(String(it.category_name));
    if (it.city) meta.push(String(it.city));
  }
  if (meta.length) parts.push(`<p class="bp-mod-meta">${esc(meta.join(' · '))}</p>`);

  const price = moneyLabel(it);
  if (price && ['ecommerce', 'bookings', 'courses', 'menu'].includes(type)) {
    parts.push(`<p class="bp-mod-price">${esc(price)}</p>`);
  }
  if (type === 'bookings' && it.duration_minutes) {
    parts.push(`<p class="bp-mod-meta">${esc(it.duration_minutes)} min</p>`);
  }

  if (type === 'blog' && it.body_html) {
    parts.push(`<div class="bp-mod-content">${it.body_html}</div>`);
  } else if (it.description) {
    parts.push(`<div class="bp-mod-content"><p>${esc(it.description)}</p></div>`);
  } else if (it.body) {
    parts.push(`<div class="bp-mod-content"><p>${esc(it.body)}</p></div>`);
  }

  if (type === 'faq' && it.answer) {
    parts.push(`<div class="bp-mod-content"><p>${esc(it.answer)}</p></div>`);
  }
  if (type === 'testimonials') {
    if (it.quote) parts.push(`<blockquote class="bp-mod-quote">${esc(it.quote)}</blockquote>`);
    const who = [it.author, it.role].filter(Boolean).join(' · ');
    if (who) parts.push(`<p class="bp-mod-meta">${esc(who)}</p>`);
  }
  if (type === 'team' && it.role) {
    parts.push(`<p class="bp-mod-meta">${esc(it.role)}</p>`);
  }
  if (type === 'offers') {
    if (it.code) parts.push(`<p style="margin-top:14px"><span class="bp-mod-offer-code">${esc(it.code)}</span></p>`);
    if (it.expires_at) parts.push(`<p class="bp-mod-meta" style="margin-top:10px">Expires ${esc(it.expires_at)}</p>`);
    if (it.terms) parts.push(`<p class="bp-mod-offer-terms" style="margin-top:8px">${esc(it.terms)}</p>`);
  }
  if (type === 'ecommerce' && Array.isArray(it.variants) && it.variants.length) {
    const rows = it.variants
      .filter((v) => v && (v.label || v.price_label))
      .map(
        (v) =>
          `<li>${esc(v.label || '')}${v.price_label ? ` — ${esc(v.price_label)}` : ''}${
            v.available === false ? ' (unavailable)' : ''
          }</li>`
      )
      .join('');
    if (rows) parts.push(`<ul class="bp-mod-variants">${rows}</ul>`);
  }
  if (type === 'gallery' && Array.isArray(it.images) && it.images.length) {
    const imgs = it.images
      .filter((im) => im && im.image_url)
      .map((im) => `<img src="${esc(im.image_url)}" alt="${esc(im.caption || '')}" />`)
      .join('');
    if (imgs) parts.push(`<div class="bp-mod-gallery">${imgs}</div>`);
  }
  if (type === 'directory') {
    const lines = [];
    if (it.address) lines.push(esc(it.address));
    if (it.phone) lines.push(esc(it.phone));
    if (it.website) lines.push(`<a href="${esc(it.website)}">${esc(it.website)}</a>`);
    if (lines.length) parts.push(`<p class="bp-mod-meta">${lines.join('<br />')}</p>`);
  }
  if (type === 'video' && it.video_url) {
    parts.push(`<p class="bp-mod-meta"><a href="${esc(it.video_url)}">Watch video</a></p>`);
  }
  if (type === 'categories' && Array.isArray(payload.category_items) && payload.category_items.length) {
    const cards = payload.category_items
      .map((ci) => {
        const t = ci && (ci.title || ci.name);
        if (!t) return '';
        const href = ci.link_url || ci.url || '';
        return href ? `<li><a href="${esc(href)}">${esc(t)}</a></li>` : `<li>${esc(t)}</li>`;
      })
      .filter(Boolean)
      .join('');
    if (cards) parts.push(`<ul class="bp-mod-grid">${cards}</ul>`);
  }
  parts.push('</article>');
  return parts.join('\n');
}

/* ------------------------------------------------------------------ */
/* Full detail-content bake: replace each per-item shell's detail     */
/* root (Batch 141's photo + "Loading…") with the item's rendered     */
/* article, retitle the document and drop the shell's noindex.        */
/* ------------------------------------------------------------------ */

function bakeDetailPages(siteDir, tenantDb, leadId) {
  const sm = require('./siteModules');
  const ctx = sm.detailExportContext(tenantDb, leadId);
  const types = (ctx && ctx.types) || {};
  let baked = 0;
  const skipped = [];
  for (const [type, info] of Object.entries(types)) {
    const items = Array.isArray(info.items) ? info.items : [];
    for (const key of items) {
      const shellPath = path.join(siteDir, 'detail', type, `${key}.html`);
      if (!fs.existsSync(shellPath)) {
        skipped.push(`${type}/${key} (no shell)`);
        continue;
      }
      let payload = null;
      try {
        payload = sm.getPublicModuleItem(tenantDb, info.token, key, {});
      } catch (e) {
        skipped.push(`${type}/${key} (${e.code || e.message})`);
        continue;
      }
      if (!payload || !payload.item) {
        skipped.push(`${type}/${key} (no item)`);
        continue;
      }
      const page = String(info.page || '').replace(/^\/+/, '');
      const backHref = page ? `../../${page}.html` : '../../index.html';
      const article = renderDetailItemHtml(type, payload, backHref);
      let html = fs.readFileSync(shellPath, 'utf8');
      const rootIdx = html.indexOf('data-bitpype-detail-root="1"');
      if (rootIdx < 0) {
        skipped.push(`${type}/${key} (no detail root)`);
        continue;
      }
      const openEnd = html.indexOf('>', rootIdx);
      const closeIdx = html.indexOf('</div>', openEnd);
      if (openEnd < 0 || closeIdx < 0) {
        skipped.push(`${type}/${key} (malformed shell)`);
        continue;
      }
      html = html.slice(0, openEnd + 1) + '\n' + article + '\n' + html.slice(closeIdx);
      const itemTitle = payload.item.title || payload.item.name || '';
      if (itemTitle) {
        html = html.replace(/<title>[^<]*<\/title>/i, `<title>${esc(itemTitle)}</title>`);
      }
      html = html.replace(/<meta name="robots" content="noindex[^"]*">/i, '');
      fs.writeFileSync(shellPath, html);
      baked++;
    }
  }
  return { baked, skipped };
}

/* ------------------------------------------------------------------ */
/* Endpoint repointing + the zero-reference scan. Every absolute      */
/* platform-origin URL in the baked copy becomes origin-relative so   */
/* the site talks to the clone it ships with. The scan then FAILS     */
/* the build if any platform host survives anywhere in site/.         */
/* ------------------------------------------------------------------ */

const TEXT_EXTS = new Set(['.html', '.htm', '.js', '.json', '.xml', '.txt', '.css', '.svg', '.webmanifest']);

/* The platform's canonical origin, derived from the ONE place the
 * literal may live: the general.public_url default in
 * server/platform.js PLATFORM_SETTING_DEFS (batch56 pins exactly one
 * literal in the tree — this module must not add another). */
function platformDefaultOrigin() {
  try {
    const defs = require('./platform').PLATFORM_SETTING_DEFS || [];
    const def = defs.find((d) => d.key === 'general.public_url');
    return def && def.default ? String(def.default).replace(/\/+$/, '') : '';
  } catch {
    return '';
  }
}

function platformBases() {
  const bases = new Set();
  try {
    const u = require('./stripeClient').appUrl();
    if (u) bases.add(String(u).replace(/\/+$/, ''));
  } catch {
    /* APP_URL fallback below */
  }
  if (process.env.APP_URL) bases.add(String(process.env.APP_URL).replace(/\/+$/, ''));
  const origin = platformDefaultOrigin();
  if (origin) {
    bases.add(origin);
    try {
      const u = new URL(origin);
      if (!u.host.startsWith('www.')) bases.add(`${u.protocol}//www.${u.host}`);
    } catch {
      /* default origin unparsable — the scan still covers its host */
    }
  }
  return [...bases].filter(Boolean).sort((a, b) => b.length - a.length);
}

function repointSiteDir(siteDir) {
  const bases = platformBases();
  let filesChanged = 0;
  for (const rel of walkFiles(siteDir)) {
    if (!TEXT_EXTS.has(path.extname(rel).toLowerCase())) continue;
    const abs = path.join(siteDir, rel);
    let text = fs.readFileSync(abs, 'utf8');
    let next = text;
    for (const base of bases) {
      if (next.includes(base)) next = next.split(base).join('');
    }
    if (next !== text) {
      fs.writeFileSync(abs, next);
      filesChanged++;
    }
  }
  return { filesChanged, bases };
}

function scanSiteDir(siteDir, extraHosts) {
  const hosts = new Set();
  const origin = platformDefaultOrigin();
  if (origin) {
    try {
      hosts.add(new URL(origin).host);
    } catch {
      /* unparsable default — extraHosts still apply */
    }
  }
  for (const h of extraHosts || []) {
    try {
      hosts.add(new URL(h).host);
    } catch {
      /* ignore malformed base */
    }
  }
  const violations = [];
  for (const rel of walkFiles(siteDir)) {
    if (!TEXT_EXTS.has(path.extname(rel).toLowerCase())) continue;
    const text = fs.readFileSync(path.join(siteDir, rel), 'utf8');
    for (const host of hosts) {
      const idx = text.toLowerCase().indexOf(host.toLowerCase());
      if (idx >= 0) {
        violations.push({ file: rel, host, snippet: text.slice(Math.max(0, idx - 40), idx + host.length + 40) });
      }
    }
  }
  return violations;
}

/* ------------------------------------------------------------------ */
/* Seed platform DB: a FRESH central DB created by the app's own      */
/* sqlite migrate in a child process (so the schema is exactly the    */
/* app's, in both dialect worlds), then filled with ONLY the target   */
/* workspace's rows, selected through the live DB facade — the same   */
/* read path every other surface uses.                                */
/* ------------------------------------------------------------------ */

function createEmptyPlatformDb(repoRoot, destPath, tmpDir) {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
  // The db module is passed by ABSOLUTE path through the env (the
  // child runs with cwd=repoRoot today, but the seed must not depend
  // on it — and a relative require literal here would read as a
  // phantom edge in the batch55 require graph).
  const script = [
    'require(process.env.SSB_SEED_DB_MODULE).migrate()',
    '.then(() => process.exit(0))',
    '.catch((e) => { console.error(e && e.message ? e.message : e); process.exit(1); });',
  ].join('');
  execFileSync(process.execPath, ['-e', script], {
    cwd: repoRoot,
    env: {
      ...process.env,
      SSB_SEED_DB_MODULE: path.join(repoRoot, 'server', 'db.js'),
      DB_DRIVER: 'sqlite',
      SQLITE_PATH: destPath,
      WORKSPACE_DATA_DIR: path.join(tmpDir, 'child-workspaces'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (!fs.existsSync(destPath)) throw fail('SEED_FAILED', 'seed platform DB was not created');
}

/* Spec §6: settings rows carrying PLATFORM-scope keys never travel.
 * Workspaces inherit platform values for these keys at seed time
 * (platform.js WORKSPACE_SEED_KEYS), so a target workspace's
 * workspace_settings can hold snapshots of the platform's own AI /
 * mail / SMS / Cloudflare / Stripe-platform credentials. The clone
 * re-supplies its own through the installer wizard (SSB_* env ->
 * singleSite.applyBootDefaults), so dropping them loses nothing the
 * client owns. Suite-pinned (batch155 package census). */
const SEED_DROP_SETTING_PREFIXES = [
  'ai.',
  'openrouter.',
  'muse.',
  'cf.',
  'sms.',
  'mail.',
  'smtp.',
  'meta.',
  'providers.',
  'cost.',
  'design.agent_',
  'hands_off.',
  'discovery.',
  'shop.stripe.',
];
const SEED_DROP_SETTING_KEYS = new Set(['pexels.api_key', 'fal.api_key', 'general.public_url', 'registration.open']);

function isPlatformScopeSettingKey(key) {
  const k = String(key || '');
  if (SEED_DROP_SETTING_KEYS.has(k)) return true;
  return SEED_DROP_SETTING_PREFIXES.some((p) => k.startsWith(p));
}

async function buildSeedPlatformDb({ repoRoot, workspaceId, destPath, tmpDir, leadId, businessName }) {
  createEmptyPlatformDb(repoRoot, destPath, tmpDir);
  const Database = require('better-sqlite3');
  const seed = new Database(destPath);
  const facade = require('./db');
  const tables = seed
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name);
  const counts = {};
  try {
    // Workspace-scoped rows can reference platform parents that are
    // copied later (or never — platform-ephemeral rows are inert in a
    // clone). Load with enforcement off, then count any orphans into
    // the manifest so the package says exactly what it carries.
    seed.exec('PRAGMA foreign_keys = OFF');
    seed.exec('BEGIN');
    for (const table of tables) {
      if (SEED_EXCLUDE.has(table)) continue;
      const cols = seed
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((c) => c.name);
      if (!cols.length) continue;
      let rows = null;
      try {
        if (table === 'workspaces') {
          rows = await facade.query('SELECT * FROM workspaces WHERE id = :ws', { ws: workspaceId });
        } else if (table === 'users') {
          rows = await facade.query(
            'SELECT * FROM users WHERE id IN (SELECT user_id FROM workspace_members WHERE workspace_id = :ws)',
            { ws: workspaceId }
          );
          /* Batch 168 (S5#1): staff password hashes must not travel
           * in a client-downloadable package — a hash arms offline
           * cracking against accounts that also exist on the real
           * platform. Portal login on a clone needs the CLIENT's own
           * account (client_portal_users, lead-scoped below); staff
           * access on a clone is (re)created by its operator. Blank
           * the credential columns, keep the rows so memberships and
           * created-by references stay intact. */
          rows = rows.map((r) => ({
            ...r,
            password_hash: '',
            totp_secret: null,
            totp_recovery_hashes: null,
          }));
        } else if (table === 'client_portal_users' && leadId != null) {
          /* Batch 168 (S5#1): the workspace filter alone shipped
           * EVERY client's portal account — including bcrypt
           * password hashes — in one client's backup. A standalone
           * package is for ONE site: only the target lead's portal
           * users travel (email uniqueness is global, so a second
           * client's row could never even log in on the clone). */
          rows = await facade.query('SELECT * FROM client_portal_users WHERE workspace_id = :ws AND lead_id = :lead', {
            ws: workspaceId,
            lead: Number(leadId),
          });
        } else if (cols.includes('workspace_id')) {
          rows = await facade.query(`SELECT * FROM ${table} WHERE workspace_id = :ws`, { ws: workspaceId });
        } else {
          continue;
        }
      } catch {
        rows = null; // table absent on the live dialect — nothing to carry
      }
      if (!Array.isArray(rows) || !rows.length) {
        counts[table] = 0;
        continue;
      }
      if (table === 'workspace_settings') {
        const before = rows.length;
        rows = rows.filter((r) => !isPlatformScopeSettingKey(r.key));
        if (rows.length < before) counts.workspace_settings_dropped_platform_scope = before - rows.length;
      }
      let inserted = 0;
      for (const row of rows) {
        const keys = Object.keys(row).filter((k) => cols.includes(k));
        if (!keys.length) continue;
        const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map((k) => `@${k}`).join(', ')})`;
        const params = {};
        for (const k of keys) params[k] = row[k];
        try {
          seed.prepare(sql).run(params);
          inserted++;
        } catch (e) {
          throw fail('SEED_FAILED', `seed insert into ${table} failed: ${e.message}`);
        }
      }
      counts[table] = inserted;
    }
    // Batch 165: only the target site's MODULE webinars travel with
    // a clone. Platform webinars (lead_id NULL) are the agency's own
    // — for a workspace-1 backup they pass the workspace filter, so
    // drop them here, with their registrations and messages (other
    // workspaces' webinars never passed the filter at all).
    try {
      const before = seed.prepare('SELECT COUNT(*) AS c FROM webinars').get().c;
      seed.exec('DELETE FROM webinars WHERE lead_id IS NULL');
      seed.exec('DELETE FROM webinar_registrations WHERE webinar_id NOT IN (SELECT id FROM webinars)');
      seed.exec('DELETE FROM webinar_messages WHERE webinar_id NOT IN (SELECT id FROM webinars)');
      const after = seed.prepare('SELECT COUNT(*) AS c FROM webinars').get().c;
      if (before !== after) counts.webinars_platform_dropped = before - after;
      counts.webinars = after;
      counts.webinar_registrations = seed.prepare('SELECT COUNT(*) AS c FROM webinar_registrations').get().c;
      counts.webinar_messages = seed.prepare('SELECT COUNT(*) AS c FROM webinar_messages').get().c;
    } catch {
      /* webinar tables may not exist on an older source schema */
    }
    /* Batch 177: if the target lead has NO portal account in the
     * seed, the clone boots with zero portal accounts and the
     * installer's "log in with the portal account from your BitPype
     * site" summary strands the owner — exactly what the Victoria
     * review install found (her lead never had an account). Ely's
     * ruling: "In the case where no account exists create a demo
     * account." So the seed gains a DEMO portal account for the
     * target lead, shaped like a real one (active, owner, the lead's
     * business name). Its password hash is bcrypt over a throwaway
     * random value whose plaintext is discarded in this process and
     * exists NOWHERE — not in the package, not in any log or
     * manifest. The usable password is generated on the owner's own
     * server at install time (standalone/set-demo-password.js, run
     * by install.sh) and shown once in the installer's completion
     * summary. A lead WITH an account is untouched: no demo row, and
     * the census is exactly what it was before this batch. */
    let demoPortalAccount = null;
    const leadNum = Number(leadId);
    if (Number.isInteger(leadNum) && leadNum > 0) {
      const have = seed.prepare('SELECT COUNT(*) AS c FROM client_portal_users WHERE lead_id = ?').get(leadNum).c;
      const clash = seed
        .prepare('SELECT COUNT(*) AS c FROM client_portal_users WHERE email = ?')
        .get(DEMO_PORTAL_EMAIL).c;
      if (Number(have) === 0 && Number(clash) === 0) {
        const bcrypt = require('bcryptjs');
        const throwawayHash = bcrypt.hashSync(crypto.randomBytes(24).toString('hex'), 12);
        seed
          .prepare(
            `INSERT INTO client_portal_users
               (email, password_hash, workspace_id, lead_id, business_name, status, user_type)
             VALUES (?, ?, ?, ?, ?, 'active', 'owner')`
          )
          .run(DEMO_PORTAL_EMAIL, throwawayHash, workspaceId, leadNum, businessName || '');
        demoPortalAccount = DEMO_PORTAL_EMAIL;
        counts.client_portal_users = (counts.client_portal_users || 0) + 1;
      }
    }
    if (demoPortalAccount) counts._demo_portal_account = demoPortalAccount;
    seed.exec('COMMIT');
    try {
      const orphans = seed.prepare('PRAGMA foreign_key_check').all();
      if (orphans.length) counts._fk_orphans = orphans.length;
    } catch {
      /* foreign_key_check is diagnostic only */
    }
  } catch (e) {
    try {
      seed.exec('ROLLBACK');
    } catch {
      /* nothing to roll back */
    }
    throw e;
  } finally {
    try {
      seed.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      /* checkpoint is best-effort; the package sweep removes sidecars */
    }
    seed.close();
  }
  return counts;
}

/* ------------------------------------------------------------------ */
/* Tenant DB + exports + app tree copies.                             */
/* ------------------------------------------------------------------ */

async function copyTenantDb(workspaceId, destPath) {
  const { openWorkspaceDb } = require('./workspaceDb');
  const tdb = openWorkspaceDb(workspaceId, { create: false });
  if (!tdb) throw fail('TENANT_NOT_FOUND', `no tenant DB for workspace ${workspaceId}`, 404);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
  await tdb.backup(destPath);
  return destPath;
}

/* Batch 168 (S5#1): the tenant copy above is a VERBATIM backup of
 * the whole workspace DB, but a backup is generated FOR ONE SITE and
 * any portal client of that site can download it. In the agency's
 * shared workspace the tenant DB holds EVERY client's leads, sites,
 * orders, contacts and chat transcripts — shipping it whole hands
 * one client every other client's business data. So the packaged
 * copy (never the live DB) is scrubbed down to the target lead:
 *
 *   - every table carrying a lead_id column keeps only that lead's
 *     rows, and the same for the alternate linkage columns
 *     (claimed_by_lead_id / scope_lead_id — Batch 178 router tables,
 *     Batch 180 M2);
 *   - `leads` itself keeps only the target row;
 *   - `websites` keeps only the target website's row (other sites of
 *     the same lead are separate deliverables with their own backup);
 *   - the settings table's `lead_id.<id>.*` namespaced keys (the
 *     per-lead settings convention used by payments/chatbot/etc.)
 *     keep only the target lead's keys;
 *   - child rows that reference a deleted parent (embed rows, order
 *     lines, messages…) are swept by the tables' own parent columns
 *     (embed_id / order_id / conversation_id / form_id), iterated to
 *     a fixpoint.
 *
 * A table with no lead column and no parent column (global pricing,
 * module catalogs, design system rows) is shared reference data and
 * travels as-is — the same judgement the platform seed makes for
 * workspace-less tables. Returns per-table kept/total counts so the
 * manifest records exactly what the scrub dropped. */
function scrubTenantDbForLead(destPath, { leadId, websiteId }) {
  const Database = require('better-sqlite3');
  const db = new Database(destPath);
  const counts = {};
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((r) => r.name);
    const colsOf = {};
    for (const t of tables) {
      colsOf[t] = db
        .prepare(`PRAGMA table_info(${t})`)
        .all()
        .map((c) => c.name);
    }
    const count = (t) => {
      try {
        return db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;
      } catch {
        return 0;
      }
    };
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    try {
      const before = {};
      for (const t of tables) before[t] = count(t);
      // 1 — direct lead scoping.
      for (const t of tables) {
        if (t === 'leads') {
          db.prepare('DELETE FROM leads WHERE id <> ?').run(Number(leadId));
        } else if (t === 'websites') {
          db.prepare('DELETE FROM websites WHERE id <> ?').run(Number(websiteId));
        } else if (colsOf[t].includes('lead_id')) {
          db.prepare(`DELETE FROM ${t} WHERE lead_id IS NULL OR lead_id <> ?`).run(Number(leadId));
        }
      }
      // 1b — Batch 180 (M2): alternate lead-linkage columns. Batch
      // 178's router tables carry no `lead_id` column, so step 1 left
      // them whole: `router_leads` links to a lead only through
      // `claimed_by_lead_id` (an unclaimed row belongs to the shared
      // demand pool, not to this tenant) and `router_sweeps` only
      // through `scope_lead_id` (NULL = a workspace-wide sweep).
      // Scope any table carrying one of these columns the same way.
      // `router_leads.sweep_run_id` is deliberately NOT a parent
      // sweep column below: a lead this tenant claimed legitimately
      // came from a workspace-wide sweep, and the dangling sweep id
      // alone carries no other tenant's data.
      const ALT_LEAD_COLS = ['claimed_by_lead_id', 'scope_lead_id'];
      for (const t of tables) {
        for (const col of ALT_LEAD_COLS) {
          if (!colsOf[t].includes(col)) continue;
          db.prepare(`DELETE FROM ${t} WHERE ${col} IS NULL OR ${col} <> ?`).run(Number(leadId));
        }
      }
      // 2 — per-lead namespaced settings keys: `lead_id.<id>.<rest>`.
      if (colsOf.settings && colsOf.settings.includes('key')) {
        const rows = db.prepare("SELECT key FROM settings WHERE key LIKE 'lead_id.%'").all();
        for (const r of rows) {
          const m = /^lead_id\.(\d+)\./.exec(String(r.key || ''));
          if (m && Number(m[1]) !== Number(leadId)) {
            db.prepare('DELETE FROM settings WHERE key = ?').run(r.key);
          }
        }
      }
      // 3 — child sweeps to a fixpoint: a row whose parent column
      // points at a parent row that no longer exists is an orphan of
      // a deleted lead/site and goes too. Parent table names are the
      // platform's stable conventions; a column only sweeps when its
      // parent table exists in this DB.
      const PARENT_COLS = [
        ['embed_id', 'site_module_embeds'],
        ['order_id', 'module_orders'],
        ['conversation_id', 'site_chat_conversations'],
        ['form_id', 'contact_forms'],
        ['website_id', 'websites'],
        ['webinar_id', 'webinars'],
        ['product_id', 'module_products'],
        ['tier_id', 'module_membership_tiers'],
      ];
      let changed = true;
      let guard = 0;
      while (changed && guard++ < 8) {
        changed = false;
        for (const t of tables) {
          for (const [col, parent] of PARENT_COLS) {
            if (!tables.includes(parent) || parent === t) continue;
            if (!colsOf[t].includes(col)) continue;
            const info = db
              .prepare(`DELETE FROM ${t} WHERE ${col} IS NOT NULL AND ${col} NOT IN (SELECT id FROM ${parent})`)
              .run();
            if (info.changes > 0) changed = true;
          }
        }
      }
      // 4 — fail closed on residue: after scoping, no row anywhere
      // may still name another lead. A table shape the scrub doesn't
      // understand must stop the backup, not leak silently.
      for (const t of tables) {
        for (const col of ['lead_id', ...ALT_LEAD_COLS]) {
          if (!colsOf[t].includes(col)) continue;
          const stray = db
            .prepare(`SELECT COUNT(*) AS c FROM ${t} WHERE ${col} IS NOT NULL AND ${col} <> ?`)
            .get(Number(leadId)).c;
          if (stray > 0) {
            throw fail('SEED_FAILED', `tenant scrub left ${stray} foreign-lead row(s) in ${t}`);
          }
        }
      }
      for (const t of tables) {
        const after = count(t);
        if (before[t] !== after) counts[t] = { kept: after, dropped: before[t] - after };
      }
      db.exec('COMMIT');
    } catch (e) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* nothing to roll back */
      }
      throw e;
    }
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      /* best-effort, like the seed */
    }
  } finally {
    db.close();
  }
  return counts;
}

function copySiteExports({ tenantDb, websiteId, workspaceId, siteName, destDir }) {
  const engine = require('../src/websiteEngine');
  const { exportRoot } = require('../src/openPreview');
  const root = exportRoot();
  const names = new Set(engine.collectSiteExportFolders(websiteId, { workspaceId, siteName }));
  try {
    const assetValidation = require('../src/assetValidation');
    for (const f of assetValidation.siteStorageFoldersForDb(tenantDb, websiteId)) names.add(f);
  } catch {
    /* staging folders are additive */
  }
  const copied = [];
  fs.mkdirSync(destDir, { recursive: true });
  for (const name of names) {
    if (!name || name.includes('..') || name.includes('/')) continue;
    const src = path.join(root, name);
    if (fs.existsSync(src) && fs.statSync(src).isDirectory()) {
      fs.cpSync(src, path.join(destDir, name), { recursive: true });
      copied.push(name);
    }
  }
  return copied;
}

function copyAppTree(repoRoot, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const skip = (src) => {
    const base = path.basename(src);
    if (base === 'node_modules' || base === '.git' || base === 'data') return false;
    if (/\.sqlite(-wal|-shm)?$/.test(base)) return false;
    if (/^\.env/.test(base)) return false;
    return true;
  };
  for (const rel of APP_TREE_PATHS) {
    const src = path.join(repoRoot, rel);
    /* Batch 168 (external review F13): EVERY app-tree path is a
     * required asset. The silent skip shipped production packages
     * without a Dockerfile (the release image didn't carry its own,
     * so the generator found nothing and said nothing) and the
     * clone could not build. Fail before streaming an incomplete
     * package — the same discipline copyInstallerAssets applies. */
    if (!fs.existsSync(src)) {
      throw fail('APP_TREE_INCOMPLETE', `required app-tree asset is missing from the tree: ${rel}`);
    }
    const dest = path.join(destDir, rel);
    if (fs.statSync(src).isDirectory()) fs.cpSync(src, dest, { recursive: true, filter: skip });
    else fs.copyFileSync(src, dest);
  }
}

function copyInstallerAssets(repoRoot, pkgDir) {
  const srcDir = path.join(repoRoot, 'standalone');
  for (const name of ['install.sh', 'uninstall.sh', 'docker-compose.yml', 'Caddyfile']) {
    const src = path.join(srcDir, name);
    if (!fs.existsSync(src)) throw fail('INSTALLER_ASSETS_MISSING', `standalone/${name} is missing from the tree`);
    const dest = path.join(pkgDir, name);
    fs.copyFileSync(src, dest);
    if (name.endsWith('.sh')) fs.chmodSync(dest, 0o755);
  }
}

function featureFlags(tenantDb, leadId) {
  const sm = require('./siteModules');
  const active = (type) => {
    try {
      const row = sm.getEmbedRow(tenantDb, leadId, type);
      return !!(row && Number(row.published) === 1 && Number(row.embed_enabled) === 1);
    } catch {
      return false;
    }
  };
  let hasForms = false;
  try {
    const row = tenantDb.prepare('SELECT COUNT(*) AS c FROM contact_forms WHERE lead_id = ?').get(Number(leadId));
    hasForms = !!row && Number(row.c) > 0;
  } catch {
    hasForms = false;
  }
  let hasVoice = false;
  try {
    const bot = require('./chatbot');
    const s = bot.getSettings(tenantDb, leadId);
    hasVoice = !!(s && (s.voice_enabled === 1 || s.voice_enabled === true || s.voice === 'on'));
  } catch {
    hasVoice = false;
  }
  return {
    hasShop: active('ecommerce'),
    hasBookings: active('bookings'),
    hasChat: active('chatbot'),
    hasVoice,
    hasForms,
    hasCheckout: active('checkout'),
  };
}

function appGitSha(repoRoot) {
  // Production trees are extracted from payload tars and carry no
  // .git — the finisher stamps the tree's tip into BUILD_SHA before
  // the image build, and the app's own env may carry it too. The git
  // call remains for dev/sandbox trees. Anything else yields ''.
  const fromEnv = String(process.env.APP_GIT_SHA || '').trim();
  if (/^[0-9a-f]{7,40}$/i.test(fromEnv)) return fromEnv;
  try {
    const fromFile = fs.readFileSync(path.join(repoRoot, 'BUILD_SHA'), 'utf8').trim();
    if (/^[0-9a-f]{7,40}$/i.test(fromFile)) return fromFile;
  } catch {
    /* no stamp — fall through to git */
  }
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return '';
  }
}

/* ------------------------------------------------------------------ */
/* Assembly.                                                          */
/* ------------------------------------------------------------------ */

async function generateStandaloneBackup({ workspaceId, websiteId, workDir, repoRoot }) {
  const root = repoRoot || path.join(__dirname, '..');
  const wsId = Number(workspaceId);
  const siteId = Number(websiteId);
  if (!Number.isInteger(wsId) || wsId <= 0) throw fail('BAD_WORKSPACE', 'workspaceId is required', 400);
  if (!Number.isInteger(siteId) || siteId <= 0) throw fail('BAD_WEBSITE', 'websiteId is required', 400);

  const { openWorkspaceDb } = require('./workspaceDb');
  const tenantDb = openWorkspaceDb(wsId, { create: false });
  if (!tenantDb) throw fail('WORKSPACE_NOT_FOUND', `workspace ${wsId} has no tenant DB`, 404);
  const site = tenantDb.prepare('SELECT * FROM websites WHERE id = ?').get(siteId);
  if (!site) throw fail('WEBSITE_NOT_FOUND', `website ${siteId} not found in workspace ${wsId}`, 404);
  const leadId = Number(site.lead_id);

  const slug = slugFor(site.name, siteId);
  const packageName = `${slug}-standalone-backup`;
  const pkgDir = path.join(workDir, packageName);
  fs.mkdirSync(path.join(pkgDir, 'site'), { recursive: true });
  fs.mkdirSync(path.join(pkgDir, 'seed', 'exports'), { recursive: true });

  /* 1 — the baked site: a FRESH exportStatic into site/, with the
   * export's preview_path side effect on the live tenant row
   * restored afterwards (a backup must not move the site's preview). */
  const engine = require('../src/websiteEngine');
  const siteDir = path.join(pkgDir, 'site');
  const prevPreviewPath = site.preview_path || null;
  const prevUpdatedAt = site.updated_at || null;
  engine.exportStatic(tenantDb, siteId, siteDir);
  try {
    // The export bumps preview_path AND updated_at on the live row;
    // a backup must leave the site's record exactly as it found it.
    tenantDb
      .prepare('UPDATE websites SET preview_path = ?, updated_at = ? WHERE id = ?')
      .run(prevPreviewPath, prevUpdatedAt, siteId);
  } catch {
    /* preview_path restore is best-effort */
  }

  /* The embed scripts the baked pages load from the app origin ride
   * inside site/js/ so the static copy is self-contained. */
  const jsDir = path.join(siteDir, 'js');
  fs.mkdirSync(jsDir, { recursive: true });
  for (const name of EMBED_JS) {
    const src = path.join(root, 'public', 'js', name);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(jsDir, name));
  }

  /* Batch 165 — webinar gate/room shells for the baked site (the
   * same per-webinar shells domain.materializeWebsiteExport writes;
   * the list rides the engine's per-site settings cache). Additive:
   * the clone's own app route serves the same pages server-side. */
  try {
    const sm = require('./siteModules');
    const wrow = sm.getEmbedRow(tenantDb, leadId, 'webinar');
    if (wrow && sm.moduleEmbedActive(wrow)) {
      const cacheRow = tenantDb
        .prepare('SELECT value FROM settings WHERE key = ?')
        .get(`webinar_shells.${Number(siteId)}`);
      let shells = [];
      try {
        shells = cacheRow ? JSON.parse(cacheRow.value || '[]') : [];
      } catch {
        shells = [];
      }
      const wPages = JSON.parse(site.pages || '[]');
      const wTheme = JSON.parse(site.theme || '{}');
      for (const sh of Array.isArray(shells) ? shells : []) {
        const slug = String((sh && sh.slug) || '');
        if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) continue;
        const html = engine.buildWebinarPage(wPages, wTheme, {
          token: wrow.public_token,
          slug,
          title: (sh && sh.title) || 'Webinar',
        });
        const wDir = path.join(siteDir, 'webinar');
        fs.mkdirSync(wDir, { recursive: true });
        fs.writeFileSync(path.join(wDir, `${slug}.html`), html, 'utf8');
      }
    }
  } catch {
    /* shells are additive — never fail a backup over them */
  }

  /* 2 — full detail-content bake, then repointing, then the scan
   * that fails the build if any platform host survives. */
  const bake = bakeDetailPages(siteDir, tenantDb, leadId);
  const repoint = repointSiteDir(siteDir);
  const violations = scanSiteDir(siteDir, repoint.bases);
  if (violations.length) {
    throw fail(
      'BAKE_SCAN_FAILED',
      `baked site still references the platform in ${violations.length} place(s): ` +
        violations.map((v) => `${v.file} (${v.host})`).join(', ')
    );
  }

  /* 3 — seeds + exports + app + installer. */
  let leadBusinessName = site.name || '';
  try {
    const leadRow = tenantDb.prepare('SELECT business_name FROM leads WHERE id = ?').get(leadId);
    if (leadRow && leadRow.business_name) leadBusinessName = leadRow.business_name;
  } catch {
    /* the site name already stands in for the business name */
  }
  const seedCounts = await buildSeedPlatformDb({
    repoRoot: root,
    workspaceId: wsId,
    destPath: path.join(pkgDir, 'seed', 'platform.sqlite'),
    tmpDir: workDir,
    leadId,
    businessName: leadBusinessName,
  });
  /* Batch 177: lifted out of the table counts into its own manifest
   * field — the email (or null) is all install.sh needs to print the
   * right closing summary; it is not a secret. */
  const demoPortalAccount = seedCounts._demo_portal_account || null;
  delete seedCounts._demo_portal_account;
  await copyTenantDb(wsId, path.join(pkgDir, 'seed', 'tenant.sqlite'));
  /* Batch 168 (S5#1): the verbatim tenant copy carries the whole
   * workspace — every other client's data included. Scrub the
   * PACKAGED copy down to this site's lead before anything else
   * reads it (the live tenant DB is never touched). */
  const tenantScrub = scrubTenantDbForLead(path.join(pkgDir, 'seed', 'tenant.sqlite'), {
    leadId,
    websiteId: siteId,
  });
  /* SQLite sidecars (-wal/-shm) are live-connection artifacts, not
   * package content — checkpoint the seeds closed and sweep any
   * sidecar out before the manifest walk hashes the tree. */
  for (const seedFile of ['seed/platform.sqlite', 'seed/tenant.sqlite']) {
    for (const suffix of ['-wal', '-shm', '-journal']) {
      const p = path.join(pkgDir, seedFile + suffix);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  }
  const exportFolders = copySiteExports({
    tenantDb,
    websiteId: siteId,
    workspaceId: wsId,
    siteName: site.name,
    destDir: path.join(pkgDir, 'seed', 'exports'),
  });
  copyAppTree(root, path.join(pkgDir, 'app'));
  copyInstallerAssets(root, pkgDir);

  /* 4 — manifest LAST (its hashes cover everything but itself). */
  const files = {};
  for (const rel of walkFiles(pkgDir)) {
    if (rel === 'manifest.json') continue;
    files[rel] = sha256File(path.join(pkgDir, rel));
  }
  let version = '';
  try {
    version = require(path.join(root, 'package.json')).version || '';
  } catch {
    version = '';
  }
  const manifest = {
    format: 'bitpype-standalone-backup',
    formatVersion: FORMAT_VERSION,
    generatedAt: new Date().toISOString(),
    source: { workspaceId: wsId, websiteId: siteId, leadId, siteName: site.name || '' },
    app: { gitSha: appGitSha(root), version },
    features: featureFlags(tenantDb, leadId),
    seed: { platformTables: seedCounts, demoPortalAccount, exportFolders, tenantScrub },
    bake: { detailPages: bake.baked, skipped: bake.skipped },
    files,
  };
  fs.writeFileSync(path.join(pkgDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return { packageDir: pkgDir, packageName, manifest };
}

function archivePackage(packageDir, outPath) {
  const parent = path.dirname(packageDir);
  const base = path.basename(packageDir);
  if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
  execFileSync('tar', ['-czf', outPath, '-C', parent, base], { stdio: ['ignore', 'pipe', 'pipe'] });
  const buf = fs.readFileSync(outPath);
  return { archivePath: outPath, bytes: buf.length, sha256: sha256Buffer(buf) };
}

/* Generate + archive + stream a backup as an HTTP attachment. The
 * temp workdir is removed when the response closes (or on error). */
async function sendBackupArchive(res, { workspaceId, websiteId }) {
  const os = require('os');
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-standalone-'));
  try {
    const { packageDir, packageName } = await generateStandaloneBackup({ workspaceId, websiteId, workDir });
    const archivePath = path.join(workDir, `${packageName}.tar.gz`);
    const arch = archivePackage(packageDir, archivePath);
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="${packageName}.tar.gz"`);
    res.setHeader('X-Backup-Sha256', arch.sha256);
    res.setHeader('Content-Length', String(arch.bytes));
    res.on('close', () => {
      try {
        fs.rmSync(workDir, { recursive: true, force: true });
      } catch {
        /* temp cleanup is best-effort */
      }
    });
    fs.createReadStream(archivePath).pipe(res);
  } catch (e) {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* temp cleanup is best-effort */
    }
    throw e;
  }
}

module.exports = {
  FORMAT_VERSION,
  DEMO_PORTAL_EMAIL,
  APP_TREE_PATHS,
  SEED_EXCLUDE,
  SEED_DROP_SETTING_PREFIXES,
  SEED_DROP_SETTING_KEYS,
  isPlatformScopeSettingKey,
  generateStandaloneBackup,
  scrubTenantDbForLead,
  archivePackage,
  sendBackupArchive,
  renderDetailItemHtml,
  bakeDetailPages,
  repointSiteDir,
  scanSiteDir,
  buildSeedPlatformDb,
  slugFor,
};
