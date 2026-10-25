'use strict';

/**
 * Google AdSense on customer sites — platform monetization of Free-plan sites.
 *
 * Ely's rules:
 *  - Settings are PLATFORM-level (his own AdSense account): adsense.enabled,
 *    adsense.publisher_id, adsense.slot_id (see PLATFORM_SETTING_DEFS).
 *  - Ads render ONLY on sites whose customer is on the Free plan — every page.
 *  - Paid plans (standard / pro / premium) NEVER get ads.
 *
 * Injection rides the platform export path (same family as the cookie bar,
 * site analytics and the claim popup in domain.materializeWebsiteExport):
 * the exported folder's HTML is post-processed. Authored <script> in page
 * content is stripped at publish, so ads must never be authored content.
 *
 * Plan chain for a site — deliberately NOT billing.effectivePlan(), which
 * maxes in the workspace owner's plan (the workspace owner is the agency,
 * not the customer; in ws1 that would mark every customer site Premium):
 *   websites.lead_id
 *     -> client_portal_users (workspace_id + lead_id, active) -> email
 *        (clientPortal.activeEmailForLead)
 *     -> users row by email -> billing.planOfUser(user)
 *        (portal checkout creates that row via ensureBillingUserForPortalClient;
 *         subscription_status + billing_plan live on it)
 *   No portal user / no billing user / not subscribed -> PLAN_FREE.
 */

const fs = require('fs');
const path = require('path');

const MARK = 'bitpype-adsense';
const PUBLISHER_RE = /^ca-pub-\d{10,24}$/;
const SLOT_RE = /^[A-Za-z0-9_-]{1,32}$/;
const STRIP_RE = /\n?<!-- bitpype-adsense -->[\s\S]*?<!-- \/bitpype-adsense -->\n?/g;

function cleanPublisherId(v) {
  const s = String(v == null ? '' : v).trim();
  return PUBLISHER_RE.test(s) ? s : '';
}

function cleanSlotId(v) {
  const s = String(v == null ? '' : v).trim();
  return SLOT_RE.test(s) ? s : '';
}

/** Pure gate: ads render only when enabled + valid publisher + Free plan. */
function gate({ enabled, publisherId, plan } = {}) {
  if (String(enabled) !== '1') return false;
  if (!cleanPublisherId(publisherId)) return false;
  return String(plan || 'free') === 'free';
}

function buildConfig({ enabled, publisherId, slotId, plan } = {}) {
  const pub = cleanPublisherId(publisherId);
  return {
    active: gate({ enabled, publisherId: pub, plan }),
    publisherId: pub,
    slotId: cleanSlotId(slotId),
    plan: String(plan || 'free'),
  };
}

function headSnippet(publisherId) {
  return (
    `<!-- ${MARK} -->\n` +
    `<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${publisherId}" crossorigin="anonymous"></script>\n` +
    `<!-- /${MARK} -->`
  );
}

/** One responsive unit; empty string when no slot (Auto Ads decides placement). */
function bodySnippet(publisherId, slotId) {
  if (!publisherId || !slotId) return '';
  return (
    `<!-- ${MARK} -->\n` +
    `<div class="${MARK}" data-bitpype-adsense="1" style="display:block;margin:24px auto;max-width:970px;padding:0 16px;box-sizing:border-box">\n` +
    `<ins class="adsbygoogle" style="display:block" data-ad-client="${publisherId}" data-ad-slot="${slotId}" data-ad-format="auto" data-full-width-responsive="true"></ins>\n` +
    `<script>(adsbygoogle = window.adsbygoogle || []).push({});</script>\n` +
    `</div>\n` +
    `<!-- /${MARK} -->`
  );
}

/**
 * Strip-then-inject a single exported page. Always strips prior AdSense
 * blocks first, so re-export/republish is idempotent and a site that leaves
 * the Free plan (or an admin disable) comes out clean on its next export.
 */
function applyToHtml(html, cfg) {
  let doc = String(html || '');
  doc = doc.replace(STRIP_RE, '');
  if (!cfg || !cfg.active || !cfg.publisherId) return doc;
  const head = headSnippet(cfg.publisherId);
  if (/<\/head>/i.test(doc)) doc = doc.replace(/<\/head>/i, `${head}\n</head>`);
  else if (/<head\b[^>]*>/i.test(doc)) doc = doc.replace(/<head\b[^>]*>/i, (m) => `${m}\n${head}`);
  else if (/<html\b[^>]*>/i.test(doc)) doc = doc.replace(/<html\b[^>]*>/i, (m) => `${m}\n<head>${head}</head>`);
  else doc = `${head}\n${doc}`;
  const unit = bodySnippet(cfg.publisherId, cfg.slotId);
  if (unit) {
    const footerAt = doc.lastIndexOf('<footer');
    if (footerAt >= 0) doc = `${doc.slice(0, footerAt)}${unit}\n${doc.slice(footerAt)}`;
    else if (/<\/body>/i.test(doc)) doc = doc.replace(/<\/body>/i, `${unit}\n</body>`);
    else doc = `${doc}\n${unit}`;
  }
  return doc;
}

/** Apply a resolved config to every .html file in an export folder. */
function applyToExportDir(dir, cfg) {
  if (!dir || !cfg) return 0;
  let names;
  try {
    names = fs.readdirSync(dir).filter((x) => /\.html?$/i.test(x));
  } catch {
    return 0;
  }
  let n = 0;
  for (const name of names) {
    const f = path.join(dir, name);
    try {
      if (!fs.statSync(f).isFile()) continue;
      const before = fs.readFileSync(f, 'utf8');
      const after = applyToHtml(before, cfg);
      if (after !== before) fs.writeFileSync(f, after, 'utf8');
      n++;
    } catch {
      /* skip unreadable file */
    }
  }
  return n;
}

/* ---------------- per-site config cache (workspace settings table) -------- */
/* materializeWebsiteExport is synchronous; the resolved config is cached    */
/* per site so plain re-materializations apply the same decision, and the    */
/* async publish/export funnels refresh it (see domain.resolveAdsenseForSite). */

const cacheKey = (siteId) => `adsense.site.${Number(siteId)}`;

function readCachedConfig(db, siteId) {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(cacheKey(siteId));
    if (!row) return null;
    const raw = require('../src/secretBox').decryptSetting(cacheKey(siteId), row.value);
    const cfg = JSON.parse(raw);
    if (!cfg || typeof cfg !== 'object') return null;
    const pub = cleanPublisherId(cfg.publisherId);
    return {
      active: !!cfg.active && !!pub,
      publisherId: pub,
      slotId: cleanSlotId(cfg.slotId),
      plan: String(cfg.plan || 'free'),
    };
  } catch {
    return null;
  }
}

function writeCachedConfig(db, siteId, cfg) {
  try {
    const v = JSON.stringify({
      active: !!(cfg && cfg.active),
      publisherId: cfg ? cleanPublisherId(cfg.publisherId) : '',
      slotId: cfg ? cleanSlotId(cfg.slotId) : '',
      plan: cfg ? String(cfg.plan || 'free') : 'free',
    });
    db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run(cacheKey(siteId), require('../src/secretBox').encryptSetting(cacheKey(siteId), v));
    return true;
  } catch {
    return false;
  }
}

/* ---------------- async resolution (platform DB) -------------------------- */

async function platformConfig() {
  const platform = require('./platform');
  const [enabled, publisherId, slotId] = await Promise.all([
    platform.getPlatformSetting('adsense.enabled', '0'),
    platform.getPlatformSetting('adsense.publisher_id', ''),
    platform.getPlatformSetting('adsense.slot_id', ''),
  ]);
  return {
    enabled: String(enabled == null ? '0' : enabled),
    publisherId: String(publisherId || ''),
    slotId: String(slotId || ''),
  };
}

/** Effective plan of a SITE's customer (see chain in the header comment). */
async function planForWebsite(workspaceId, leadId) {
  const { PLAN_FREE } = require('./plans');
  const lid = Number(leadId);
  if (!Number.isInteger(lid) || lid <= 0) return PLAN_FREE;
  const portal = require('./clientPortal');
  const email = await portal.activeEmailForLead(workspaceId, lid);
  if (!email) return PLAN_FREE;
  const { query } = require('./db');
  const rows = await query(
    `SELECT id, email, name, status, is_super_admin,
            stripe_customer_id, stripe_subscription_id, subscription_status,
            subscription_price_id, billing_plan, current_period_end, deleted_at
     FROM users WHERE email = :email LIMIT 1`,
    { email }
  );
  const user = rows && rows[0];
  if (!user) return PLAN_FREE;
  return require('./billing').planOfUser(user);
}

async function configForWebsite(workspaceId, leadId) {
  const base = await platformConfig();
  const plan = await planForWebsite(workspaceId, leadId);
  return buildConfig({ ...base, plan });
}

/** Resolved state shown in the admin AdSense section. */
async function adminState() {
  const base = await platformConfig();
  const pub = cleanPublisherId(base.publisherId);
  let state;
  let detail;
  if (String(base.enabled) !== '1') {
    state = 'off';
    detail = 'AdSense is disabled. No ads render on any site.';
  } else if (!pub) {
    state = 'off_no_publisher';
    detail = 'Enabled, but no valid publisher ID (ca-pub-…) is set — no ads will render.';
  } else {
    state = 'active';
    detail = 'Active — ads render on every page of free-plan sites at publish/export.';
  }
  return { ...base, publisherId: base.publisherId, publisherValid: !!pub, state, detail };
}

module.exports = {
  MARK,
  cleanPublisherId,
  cleanSlotId,
  gate,
  buildConfig,
  headSnippet,
  bodySnippet,
  applyToHtml,
  applyToExportDir,
  readCachedConfig,
  writeCachedConfig,
  platformConfig,
  planForWebsite,
  configForWebsite,
  adminState,
};
