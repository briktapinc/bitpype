'use strict';

/**
 * Claim kit: signed Yes/No claim page URL + site preview URL + QR codes + postcard PDF.
 * Intent on Yes/No reuses outreach.applyInterestResponse (engaged / lost + suppression).
 */

const QRCode = require('qrcode');
const PDFDocument = require('pdfkit');

const outreach = require('./outreach');

/** Token action letter for the claim page (not a direct interested/uninterested click). */
const CLAIM_ACTION = 'c';

/* ------------------------------------------------------------------ */
/* Claim hold (Batch 34): every preview claim popup carries a 7-day   */
/* hold — expiry = anchor + 7 days, shown as a date + live countdown   */
/* with a "Get it now!" CTA. The anchor is the preview's build time:    */
/* the earliest websites.created_at for the lead (the site row's       */
/* created_at is stamped by the schema default when the preview is     */
/* built), falling back to the lead's created_at, then to first        */
/* computation. On first computation the anchor is PERSISTED in the     */
/* workspace settings table and read back verbatim thereafter, so      */
/* re-exports, re-publishes, repeat visits and popup re-injections     */
/* can NEVER reset or extend the expiry — and even recreating the      */
/* site row cannot move it. One lead's preview = one expiry.           */
/* No workspace timezone setting exists in the codebase, so the date   */
/* label is formatted in America/New_York (the same default the        */
/* social calendar uses in src/socialMedia.js).                        */
/* ------------------------------------------------------------------ */

const CLAIM_HOLD_DAYS = 7;
const CLAIM_HOLD_TZ = 'America/New_York';

function claimHoldSettingKey(leadId) {
  return `claim.hold.anchor.v1.${Number(leadId)}`;
}

/** Parse a stored timestamp. SQLite datetime('now') values are UTC
 *  ('YYYY-MM-DD HH:MM:SS', no zone marker); ISO strings pass through. */
function parseClaimTimestamp(value) {
  const s = String(value || '').trim();
  if (!s) return null;
  let iso = s.includes('T') ? s : s.replace(' ', 'T');
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(iso)) iso += 'Z';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "Tuesday, Nov 3, 2026" in the hold timezone. */
function formatClaimDate(date) {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: CLAIM_HOLD_TZ,
      weekday: 'long',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/**
 * The lead's claim hold: { anchorAt, expiresAt, expiresLabel, expired,
 * secondsRemaining, daysRemaining } — or null for a bad lead id.
 * Expiry never blocks the claim: after it passes, the popup switches to
 * the expired-hold copy and the interested flow keeps working.
 */
function claimHold(db, leadId) {
  const lid = Number(leadId);
  if (!Number.isInteger(lid) || lid <= 0) return null;
  let anchor = null;
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(claimHoldSettingKey(lid));
    if (row && row.value) anchor = parseClaimTimestamp(row.value);
  } catch {
    /* settings table optional — the created_at anchor is itself stable */
  }
  if (!anchor) {
    let raw = null;
    try {
      const site = db.prepare('SELECT MIN(created_at) AS c FROM websites WHERE lead_id = ?').get(lid);
      raw = site && site.c;
    } catch {
      /* websites table optional */
    }
    if (!raw) {
      try {
        const lead = db.prepare('SELECT created_at FROM leads WHERE id = ?').get(lid);
        raw = lead && lead.created_at;
      } catch {
        /* ignore */
      }
    }
    anchor = parseClaimTimestamp(raw) || new Date();
    try {
      // First writer wins; re-read so concurrent computations agree.
      db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run(
        claimHoldSettingKey(lid),
        anchor.toISOString()
      );
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(claimHoldSettingKey(lid));
      const persisted = row && parseClaimTimestamp(row.value);
      if (persisted) anchor = persisted;
    } catch {
      /* persistence is best-effort */
    }
  }
  const expires = new Date(anchor.getTime() + CLAIM_HOLD_DAYS * 24 * 60 * 60 * 1000);
  const nowMs = Date.now();
  const secondsRemaining = Math.max(0, Math.floor((expires.getTime() - nowMs) / 1000));
  return {
    anchorAt: anchor.toISOString(),
    expiresAt: expires.toISOString(),
    expiresLabel: formatClaimDate(expires),
    expired: nowMs > expires.getTime(),
    secondsRemaining,
    daysRemaining: Math.floor(secondsRemaining / 86400),
  };
}

function claimPagePath(token) {
  return `/claim.html?t=${encodeURIComponent(token)}`;
}

/**
 * Public app base for claim / domain-picker links — the single resolver
 * (Batch 56: stripeClient.appUrl, fed by the general.public_url setting).
 * The env read remains only as a fallback for processes where the server
 * modules cannot load.
 */
function appBase() {
  try {
    return require('../server/stripeClient').appUrl();
  } catch {
    return String(process.env.APP_URL || '').replace(/\/+$/, '');
  }
}

/**
 * Stable public claim URL (HMAC token). Empty string when the workspace /
 * lead ids are invalid or token signing fails.
 */
function buildClaimUrl(workspaceId, leadId) {
  const base = appBase();
  const w = Number(workspaceId);
  const l = Number(leadId);
  if (!base || !Number.isInteger(w) || w <= 0 || !Number.isInteger(l) || l <= 0) return '';
  try {
    const token = outreach.signInterestToken({ workspaceId: w, leadId: l, action: CLAIM_ACTION });
    return `${base}${claimPagePath(token)}`;
  } catch {
    return '';
  }
}

function verifyClaimToken(token) {
  const verified = outreach.verifyInterestToken(token);
  if (verified.action !== 'claim') {
    throw Object.assign(new Error('Not a claim link'), { code: 'INVALID_TOKEN' });
  }
  return { workspaceId: verified.workspaceId, leadId: verified.leadId };
}

/** Token action letter for the domain picker page (Batch 15). */
const DOMAIN_ACTION = 'd';

function domainPickerPath(token) {
  return `/domain-picker.html?t=${encodeURIComponent(token)}`;
}

/**
 * Stable public domain-picker URL (HMAC token, action 'd').
 * Empty string when the workspace / lead ids are invalid or signing fails.
 */
function buildDomainPickerUrl(workspaceId, leadId) {
  const base = appBase();
  const w = Number(workspaceId);
  const l = Number(leadId);
  if (!base || !Number.isInteger(w) || w <= 0 || !Number.isInteger(l) || l <= 0) return '';
  try {
    const token = outreach.signInterestToken({ workspaceId: w, leadId: l, action: DOMAIN_ACTION });
    return `${base}${domainPickerPath(token)}`;
  } catch {
    return '';
  }
}

async function qrPngBuffer(url, opts = {}) {
  const text = String(url || '').trim();
  if (!text) throw new Error('URL required for QR');
  return QRCode.toBuffer(text, {
    type: 'png',
    errorCorrectionLevel: opts.errorCorrectionLevel || 'M',
    margin: opts.margin != null ? opts.margin : 1,
    width: opts.width || 280,
    color: {
      dark: opts.dark || '#0b5442',
      light: opts.light || '#ffffff',
    },
  });
}

async function qrDataUrl(url, opts = {}) {
  const buf = await qrPngBuffer(url, opts);
  return `data:image/png;base64,${buf.toString('base64')}`;
}

function slugify(name) {
  return (
    String(name || 'site')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'site'
  );
}

/**
 * Build postcard PDF (~4×6 in, landscape). Returns Buffer.
 */
function buildPostcardPdf({ businessName, pitch, siteUrl, claimUrl, siteQrPng, claimQrPng }) {
  return new Promise((resolve, reject) => {
    // 6 × 4 inches landscape postcard (print-friendly)
    const W = 6 * 72;
    const H = 4 * 72;
    const doc = new PDFDocument({
      size: [W, H],
      margin: 0,
      info: {
        Title: `BitPype postcard — ${businessName || 'website'}`,
        Author: 'BitPype',
      },
    });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Soft green wash background (no flat single fill only)
    doc.rect(0, 0, W, H).fill('#f3f7f5');
    doc.save();
    doc.path(`M 0 0 L ${W * 0.55} 0 L ${W * 0.35} ${H} L 0 ${H} Z`).fill('#e4ece8');
    doc.restore();

    const pad = 22;
    const name = String(businessName || 'Your business').slice(0, 80);
    const blurb = String(
      pitch || 'We built a website for your business. Scan to view it, or scan to claim it with a simple Yes or No.'
    ).slice(0, 220);

    doc.fillColor('#0b5442').font('Helvetica-Bold').fontSize(9).text('BITPYPE', pad, pad, { characterSpacing: 1.5 });

    doc
      .fillColor('#1a2420')
      .font('Helvetica-Bold')
      .fontSize(18)
      .text(name, pad, pad + 16, { width: W - pad * 2, lineGap: 2 });

    const titleBottom = doc.y + 6;
    doc
      .fillColor('#33443d')
      .font('Helvetica')
      .fontSize(9)
      .text(blurb, pad, titleBottom, { width: W - pad * 2, lineGap: 1.5 });

    const qrTop = Math.max(doc.y + 14, 118);
    const qrSize = 96;
    const colGap = 28;
    const totalQrBlock = qrSize * 2 + colGap;
    const leftX = (W - totalQrBlock) / 2;
    const rightX = leftX + qrSize + colGap;

    if (siteQrPng) {
      doc.image(siteQrPng, leftX, qrTop, { width: qrSize, height: qrSize });
    }
    if (claimQrPng) {
      doc.image(claimQrPng, rightX, qrTop, { width: qrSize, height: qrSize });
    }

    const labelY = qrTop + qrSize + 6;
    doc
      .fillColor('#0b5442')
      .font('Helvetica-Bold')
      .fontSize(8)
      .text('VIEW YOUR SITE', leftX, labelY, { width: qrSize, align: 'center' });
    doc.text('SCAN TO CLAIM', rightX, labelY, { width: qrSize, align: 'center' });

    doc
      .fillColor('#5a6b64')
      .font('Helvetica')
      .fontSize(6.5)
      .text(String(siteUrl || '').slice(0, 72), leftX - 8, labelY + 12, {
        width: qrSize + 16,
        align: 'center',
      });
    doc.text("Yes I'm interested · No — not interested", rightX - 8, labelY + 12, {
      width: qrSize + 16,
      align: 'center',
    });

    // Batch 56: the postcard footer shows the resolved public host, never
    // a hardcoded domain.
    let hostLabel = '';
    try {
      hostLabel = new URL(appBase()).hostname;
    } catch {
      hostLabel = '';
    }
    doc
      .fillColor('#7a8a83')
      .font('Helvetica')
      .fontSize(7)
      .text(hostLabel, pad, H - 18, { width: W - pad * 2, align: 'right' });

    doc.end();
  });
}

/**
 * Assemble claim kit for a lead (optional websiteId). Does not require automation.
 * @returns {Promise<object>}
 */
async function buildClaimKit(db, workspaceId, { leadId, websiteId, includePdf = false } = {}) {
  const lid = Number(leadId);
  if (!Number.isInteger(lid) || lid <= 0) throw new Error('leadId is required');

  const lead = db.prepare('SELECT id, business_name, email, status, city, category FROM leads WHERE id = ?').get(lid);
  if (!lead) throw Object.assign(new Error('Lead not found'), { code: 'NOT_FOUND' });

  let site = null;
  const wid = websiteId != null ? Number(websiteId) : null;
  if (Number.isInteger(wid) && wid > 0) {
    site = db
      .prepare(
        `SELECT id, lead_id, name, preview_url, preview_path, status
       FROM websites WHERE id = ?`
      )
      .get(wid);
    if (!site) throw Object.assign(new Error('Website not found'), { code: 'NOT_FOUND' });
    if (Number(site.lead_id) !== lid) {
      throw Object.assign(new Error('Website does not belong to this lead'), { code: 'MISMATCH' });
    }
  } else {
    try {
      site = db
        .prepare(
          `SELECT id, lead_id, name, preview_url, preview_path, status, custom_domain
         FROM websites WHERE lead_id = ? ORDER BY id DESC LIMIT 1`
        )
        .get(lid);
    } catch {
      site = db
        .prepare(
          `SELECT id, lead_id, name, preview_url, preview_path, status
         FROM websites WHERE lead_id = ? ORDER BY id DESC LIMIT 1`
        )
        .get(lid);
    }
  }

  const siteUrl =
    outreach.resolveWebsiteLink(db, lid) || (site && site.preview_url && String(site.preview_url).trim()) || '';
  const claimUrl = buildClaimUrl(workspaceId, lid);
  if (!claimUrl) {
    throw Object.assign(new Error('APP_URL and SESSION_SECRET are required to build claim links'), {
      code: 'MISCONFIGURED',
    });
  }

  const businessName = (site && site.name) || lead.business_name || 'Your business';
  const place = [lead.city, lead.category].filter(Boolean).join(' · ');
  const pitch = place
    ? `A custom website for ${businessName} (${place}). Scan left to preview, right to claim it.`
    : `A custom website for ${businessName}. Scan left to preview, right to claim it with Yes or No.`;

  let siteQrPng = null;
  let claimQrPng = null;
  let siteQrDataUrl = null;
  let claimQrDataUrl = null;

  if (siteUrl) {
    siteQrPng = await qrPngBuffer(siteUrl, { width: 320 });
    siteQrDataUrl = `data:image/png;base64,${siteQrPng.toString('base64')}`;
  }
  claimQrPng = await qrPngBuffer(claimUrl, { width: 320 });
  claimQrDataUrl = `data:image/png;base64,${claimQrPng.toString('base64')}`;

  const kit = {
    leadId: lid,
    websiteId: site ? site.id : null,
    businessName,
    status: lead.status,
    siteUrl: siteUrl || null,
    claimUrl,
    siteQrDataUrl,
    claimQrDataUrl,
    pitch,
  };

  if (includePdf) {
    if (!siteUrl) {
      throw Object.assign(new Error('No preview URL yet — publish or open Preview URL before generating a postcard.'), {
        code: 'NO_SITE_URL',
      });
    }
    const pdf = await buildPostcardPdf({
      businessName,
      pitch,
      siteUrl,
      claimUrl,
      siteQrPng,
      claimQrPng,
    });
    kit.pdf = pdf;
    kit.filename = `bitpype-postcard-${slugify(businessName)}-${lid}.pdf`;
  }

  return kit;
}

/**
 * True when the lead has already shown positive claim/engagement intent.
 * Used to suppress the preview claim popup.
 */
function isIntentPositive(db, lead) {
  if (!lead) return false;
  const status = String(lead.status || '').toLowerCase();
  if (['engaged', 'claimed', 'trial', 'customer'].includes(status)) return true;
  const interested = db
    .prepare(`SELECT id FROM prospect_events WHERE lead_id = ? AND type = 'email.interested' LIMIT 1`)
    .get(lead.id);
  if (interested) return true;
  const latest = outreach.getIntent(db, lead.id);
  const label = String((latest && latest.label) || '').toLowerCase();
  if (label === 'hot' || label === 'interested' || label === 'customer') return true;
  const score = Number(latest && latest.score) || 0;
  if (score >= 31) return true; // Interested threshold
  return false;
}

/**
 * Public claim-page meta (no session). Token must be claim action.
 */
function claimPageMeta(db, workspaceId, leadId) {
  const lead = db.prepare('SELECT id, business_name, status FROM leads WHERE id = ?').get(Number(leadId));
  if (!lead) throw Object.assign(new Error('Lead not found'), { code: 'NOT_FOUND' });
  // Display name: the website's own brand/site name wins over the lead's
  // business_name (lead records can carry internal/QA labels the visitor
  // should never see). Fall back to the lead name only when the site has none.
  let siteName = '';
  let siteCustomDomain = '';
  let siteId = null;
  try {
    const site = db
      .prepare('SELECT id, name, custom_domain FROM websites WHERE lead_id = ? ORDER BY id DESC LIMIT 1')
      .get(lead.id);
    siteId = site ? Number(site.id) || null : null;
    siteName = (site && String(site.name || '').trim()) || '';
    siteCustomDomain = (site && String(site.custom_domain || '').trim()) || '';
  } catch {
    try {
      const site = db
        .prepare('SELECT id, name FROM websites WHERE lead_id = ? ORDER BY id DESC LIMIT 1')
        .get(lead.id);
      siteId = site ? Number(site.id) || null : null;
      siteName = (site && String(site.name || '').trim()) || '';
    } catch {
      siteName = '';
    }
  }
  const displayName = siteName || lead.business_name || '';
  const siteUrl = outreach.resolveWebsiteLink(db, lead.id) || null;
  const interested = db
    .prepare(`SELECT id FROM prospect_events WHERE lead_id = ? AND type = 'email.interested' LIMIT 1`)
    .get(lead.id);
  const uninterested = db
    .prepare(`SELECT id FROM prospect_events WHERE lead_id = ? AND type = 'email.uninterested' LIMIT 1`)
    .get(lead.id);
  const laterRow = db
    .prepare(`SELECT COUNT(*) AS c FROM prospect_events WHERE lead_id = ? AND type = 'claim.later'`)
    .get(lead.id);
  const laterCount = Number(laterRow && laterRow.c) || 0;
  const intentPositive = isIntentPositive(db, lead);
  // Batch 39 (Ely 2026-10-28): "If purchase of domain is completed and
  // site is setup, don't show the interested popup." A domain transaction
  // in status 'live' is exactly that state — completeRegistration sets it
  // only AFTER registerDomain + linkDomainToWebsite (publish) succeed, so
  // the domain is registered and the site is live on it. 'paid' alone does
  // NOT suppress (payment taken; registration can still fail or sit
  // un-completed). Scoped to THIS site — the website resolved above for
  // this lead: a live transaction for a different website of the same
  // lead must not suppress this site's popup. Like every other server-side
  // suppression this is state, not a browser memory: the popup script
  // treats showClaimPrompt=false as session-only (Batch 36), so nothing
  // is persisted client-side for this reason either.
  let purchasedTxn = null;
  if (siteId) {
    try {
      purchasedTxn = db
        .prepare(
          `SELECT id, domain FROM domain_transactions
           WHERE lead_id = ? AND website_id = ? AND status = 'live'
           ORDER BY id DESC LIMIT 1`
        )
        .get(lead.id, siteId);
    } catch {
      purchasedTxn = null; // table is created lazily by domainFlow.ensureTables
    }
  }
  const alreadyPurchased = !!purchasedTxn;
  // Hide after Yes (positive) or No (uninterested). "Later" stays showClaimPrompt so
  // a future visit can re-prompt (client may session-hide until then).
  const showClaimPrompt = !alreadyPurchased && !intentPositive && !interested && !uninterested;
  // Batch 34: the 7-day claim hold rides the same meta (popup + claim page +
  // staff claim_popup status all read it from here). Expiry never suppresses
  // the prompt — an expired hold renders the expired copy, claim still works.
  const hold = claimHold(db, lead.id);
  return {
    businessName: displayName,
    siteName,
    status: lead.status,
    siteUrl,
    claimHold: hold,
    claimExpiresAt: hold ? hold.expiresAt : null,
    claimExpiresLabel: hold ? hold.expiresLabel : null,
    claimExpired: hold ? hold.expired : false,
    claimSecondsRemaining: hold ? hold.secondsRemaining : null,
    claimDaysRemaining: hold ? hold.daysRemaining : null,
    // Domain picker CTA (Batch 15): offered while the site has no custom domain.
    domainPickerUrl: siteCustomDomain ? null : buildDomainPickerUrl(workspaceId, lead.id) || null,
    alreadyInterested: !!interested,
    alreadyUninterested: !!uninterested,
    alreadyPurchased,
    purchasedDomain: purchasedTxn ? purchasedTxn.domain || null : null,
    alreadyDeferred: laterCount > 0,
    laterCount,
    intentPositive,
    showClaimPrompt,
  };
}

/**
 * Inject claim Yes/No popup loader into exported preview HTML files.
 * Script loads from APP_URL so Cloudflare Pages previews work cross-origin.
 */
function injectClaimPreviewIntoExport(exportDir, workspaceId, leadId) {
  const fs = require('fs');
  const path = require('path');
  const dir = String(exportDir || '');
  if (!dir || !fs.existsSync(dir)) return { injected: 0 };
  const claimUrl = buildClaimUrl(workspaceId, leadId);
  if (!claimUrl) return { injected: 0, reason: 'no_claim_url' };
  let token = '';
  try {
    const u = new URL(claimUrl);
    token = u.searchParams.get('t') || '';
  } catch {
    const m = String(claimUrl).match(/[?&]t=([^&]+)/);
    token = m ? decodeURIComponent(m[1]) : '';
  }
  if (!token) return { injected: 0, reason: 'no_token' };
  const apiBase = appBase();
  if (!apiBase) return { injected: 0, reason: 'no_app_url' };

  const snippet = [
    '',
    '<!-- bitpype-claim-preview -->',
    `<script>window.BitpypeClaim=${JSON.stringify({ apiBase, token, v: 4 })};</script>`,
    `<script src="${apiBase}/js/claim-preview.js?v=8" defer></script>`,
    '<!-- /bitpype-claim-preview -->',
    '',
  ].join('\n');

  let injected = 0;
  const names = fs.readdirSync(dir).filter((n) => /\.html?$/i.test(n));
  for (const name of names) {
    const full = path.join(dir, name);
    try {
      if (!fs.statSync(full).isFile()) continue;
      let html = fs.readFileSync(full, 'utf8');
      if (/bitpype-claim-preview/i.test(html)) {
        html = html.replace(/\n?<!-- bitpype-claim-preview -->[\s\S]*?<!-- \/bitpype-claim-preview -->\n?/i, '');
      }
      if (/<\/body>/i.test(html)) {
        html = html.replace(/<\/body>/i, `${snippet}</body>`);
      } else {
        html += snippet;
      }
      fs.writeFileSync(full, html, 'utf8');
      injected++;
    } catch (e) {
      console.warn('[claimKit] inject', name, e.message || e);
    }
  }
  return { injected, token: true };
}

/**
 * Parse EXPORT_ROOT folder names → { workspaceId?, websiteId? }.
 * Supports ws-{ws}-site-{id}-… and site-{id}.
 */
function parseExportFolderName(name) {
  const n = String(name || '');
  let m = n.match(/^ws-(\d+)-site-(\d+)/i);
  if (m) return { workspaceId: Number(m[1]), websiteId: Number(m[2]) };
  m = n.match(/^site-(\d+)$/i);
  if (m) return { websiteId: Number(m[1]) };
  m = n.match(/^qa-site-(\d+)$/i);
  if (m) return { websiteId: Number(m[1]) };
  return null;
}

/**
 * Backfill claim popup into existing EXPORT_ROOT site folders.
 * Resolves lead_id from each workspace DB when possible.
 * @param {string} rootDir
 * @param {{ resolveLead?: (workspaceId:number|null, websiteId:number) => {workspaceId:number, leadId:number}|null }} [opts]
 */
function injectClaimPreviewIntoAllExports(rootDir, opts = {}) {
  const fs = require('fs');
  const path = require('path');
  const root = String(rootDir || '');
  if (!root || !fs.existsSync(root)) return { folders: 0, files: 0, skipped: 0 };
  const resolveLead = typeof opts.resolveLead === 'function' ? opts.resolveLead : null;
  let folders = 0;
  let files = 0;
  let skipped = 0;
  for (const name of fs.readdirSync(root)) {
    const full = path.join(root, name);
    try {
      if (!fs.statSync(full).isDirectory()) continue;
      const parsed = parseExportFolderName(name);
      if (!parsed || !parsed.websiteId) continue;
      let workspaceId = parsed.workspaceId || null;
      let leadId = null;
      if (resolveLead) {
        const hit = resolveLead(workspaceId, parsed.websiteId);
        if (hit) {
          workspaceId = hit.workspaceId;
          leadId = hit.leadId;
        }
      }
      if (!workspaceId || !leadId) {
        skipped++;
        continue;
      }
      const r = injectClaimPreviewIntoExport(full, workspaceId, leadId);
      if (r && r.injected > 0) {
        folders++;
        files += r.injected;
      } else {
        skipped++;
      }
    } catch (e) {
      console.warn('[claimKit] backfill', name, e.message || e);
      skipped++;
    }
  }
  return { folders, files, skipped };
}

module.exports = {
  CLAIM_ACTION,
  CLAIM_HOLD_DAYS,
  claimHold,
  claimPagePath,
  buildClaimUrl,
  verifyClaimToken,
  DOMAIN_ACTION,
  domainPickerPath,
  buildDomainPickerUrl,
  qrPngBuffer,
  qrDataUrl,
  buildPostcardPdf,
  buildClaimKit,
  claimPageMeta,
  isIntentPositive,
  injectClaimPreviewIntoExport,
  injectClaimPreviewIntoAllExports,
  parseExportFolderName,
  slugify,
};
