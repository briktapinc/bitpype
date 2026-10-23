'use strict';

/**
 * Client portal — end-customer identity (separate from staff workspace users).
 * Linked by contact email on leads / design jobs / social campaigns.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { query, driver } = require('./db');
const { sendPlatformMail } = require('./mailer');
const { appUrl } = require('./stripeClient');
const { openWorkspaceDb, dataRoot } = require('./workspaceDb');

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function generatePassword() {
  // 12 chars, URL-safe, easy to copy from email
  return crypto.randomBytes(9).toString('base64url');
}

function nowSql() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

async function findById(id) {
  const rows = await query(
    `SELECT id, email, password_hash, workspace_id, lead_id, business_name, status,
            last_login_at, created_at, updated_at
     FROM client_portal_users WHERE id = :id LIMIT 1`,
    { id: Number(id) }
  );
  return rows[0] || null;
}

async function findByEmail(email) {
  const e = normalizeEmail(email);
  if (!e) return null;
  const rows = await query(
    `SELECT id, email, password_hash, workspace_id, lead_id, business_name, status,
            last_login_at, created_at, updated_at
     FROM client_portal_users WHERE email = :email LIMIT 1`,
    { email: e }
  );
  return rows[0] || null;
}

/** Scan workspace SQLite DBs for a lead/contact matching this email. */
function findLeadMatches(email) {
  const e = normalizeEmail(email);
  if (!e) return [];
  const root = dataRoot();
  if (!fs.existsSync(root)) return [];

  const matches = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^\d+$/.test(d.name))
      .map((d) => Number(d.name));
  } catch {
    return [];
  }

  for (const workspaceId of dirs) {
    const dbFile = path.join(root, String(workspaceId), 'websitescout.db');
    if (!fs.existsSync(dbFile)) continue;
    let db;
    try {
      db = openWorkspaceDb(workspaceId);
    } catch {
      continue;
    }

    const seenLead = new Set();
    try {
      const byLead = db.prepare(
        `SELECT id, business_name, email, city, state, status
         FROM leads WHERE lower(trim(email)) = ? LIMIT 20`
      ).all(e);
      for (const lead of byLead) {
        seenLead.add(lead.id);
        matches.push({
          workspaceId,
          leadId: lead.id,
          businessName: lead.business_name || '',
          source: 'lead',
        });
      }
    } catch { /* table missing */ }

    try {
      const byJob = db.prepare(
        `SELECT j.id AS job_id, j.lead_id, j.contact_email, j.title,
                l.business_name
         FROM design_jobs j
         LEFT JOIN leads l ON l.id = j.lead_id
         WHERE lower(trim(j.contact_email)) = ? AND j.lead_id IS NOT NULL
         ORDER BY j.id DESC LIMIT 20`
      ).all(e);
      for (const row of byJob) {
        if (seenLead.has(row.lead_id)) continue;
        seenLead.add(row.lead_id);
        matches.push({
          workspaceId,
          leadId: row.lead_id,
          businessName: row.business_name || row.title || '',
          source: 'design_job',
        });
      }
    } catch { /* optional */ }

    try {
      const bySocial = db.prepare(
        `SELECT c.lead_id, c.client_email, l.business_name
         FROM social_campaigns c
         LEFT JOIN leads l ON l.id = c.lead_id
         WHERE lower(trim(c.client_email)) = ? AND c.lead_id IS NOT NULL
         ORDER BY c.id DESC LIMIT 20`
      ).all(e);
      for (const row of bySocial) {
        if (seenLead.has(row.lead_id)) continue;
        seenLead.add(row.lead_id);
        matches.push({
          workspaceId,
          leadId: row.lead_id,
          businessName: row.business_name || '',
          source: 'social',
        });
      }
    } catch { /* optional */ }
  }

  return matches;
}

/**
 * Request access: match email to a client site, reset password, email it.
 * Always returns a generic ok to reduce enumeration (except when SMTP fails hard
 * after a match — then we surface a send error).
 */
async function requestAccess(email) {
  const e = normalizeEmail(email);
  if (!e || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
    throw Object.assign(new Error('Enter a valid email address'), { code: 'INVALID_EMAIL' });
  }

  let existing = await findByEmail(e);
  let match = null;

  if (existing && existing.workspace_id && existing.lead_id) {
    match = {
      workspaceId: existing.workspace_id,
      leadId: existing.lead_id,
      businessName: existing.business_name || '',
    };
  } else {
    const matches = findLeadMatches(e);
    if (!matches.length) {
      // No match — still ok (anti-enumeration)
      return { ok: true, emailed: false };
    }
    match = matches[0];
  }

  const password = generatePassword();
  const passwordHash = await bcrypt.hash(password, 12);
  const businessName = match.businessName || (existing && existing.business_name) || '';

  if (existing) {
    await query(
      `UPDATE client_portal_users
       SET password_hash = :hash, workspace_id = :ws, lead_id = :lead,
           business_name = :name, status = 'active', updated_at = :now
       WHERE id = :id`,
      {
        hash: passwordHash,
        ws: match.workspaceId,
        lead: match.leadId,
        name: businessName,
        now: nowSql(),
        id: existing.id,
      }
    );
  } else {
    await query(
      `INSERT INTO client_portal_users
        (email, password_hash, workspace_id, lead_id, business_name, status)
       VALUES (:email, :hash, :ws, :lead, :name, 'active')`,
      {
        email: e,
        hash: passwordHash,
        ws: match.workspaceId,
        lead: match.leadId,
        name: businessName,
      }
    );
  }

  const loginUrl = `${appUrl()}/portal`;
  const safeName = businessName ? ` for ${businessName}` : '';
  let emailed = false;
  try {
    await sendPlatformMail({
      to: e,
      subject: 'Your Bitpype client portal password',
      title: 'Client portal access',
      paragraphs: [
        `Here is your login for the Bitpype client portal${safeName}.`,
        `Email: ${e}`,
        `Password: ${password}`,
        'If you did not request this, you can ignore this email.',
      ],
      cta: { url: loginUrl, label: 'Open the portal' },
      text: `Bitpype client portal${safeName}\nEmail: ${e}\nPassword: ${password}\nLogin: ${loginUrl}\n`,
    });
    emailed = true;
  } catch (err) {
    if (err.code === 'SMTP_NOT_CONFIGURED'
      && (process.env.NODE_ENV !== 'production' || process.env.DEV_RETURN_PORTAL_PASSWORD === '1')) {
      return { ok: true, emailed: false, devPassword: password };
    }
    console.warn('[clientPortal] email send failed:', err.message);
    throw Object.assign(new Error('Could not send login email. Try again later.'), {
      code: 'EMAIL_FAILED',
    });
  }

  // Never log or return plaintext password after send.
  return { ok: true, emailed };
}

async function login(email, password) {
  const e = normalizeEmail(email);
  const user = await findByEmail(e);
  if (!user || String(user.status) !== 'active') {
    throw Object.assign(new Error('INVALID_CREDENTIALS'), { code: 'INVALID_CREDENTIALS' });
  }
  const ok = await bcrypt.compare(String(password || ''), user.password_hash);
  if (!ok) {
    throw Object.assign(new Error('INVALID_CREDENTIALS'), { code: 'INVALID_CREDENTIALS' });
  }
  if (!user.workspace_id || !user.lead_id) {
    throw Object.assign(new Error('Portal account is not linked to a site yet'), {
      code: 'NOT_LINKED',
    });
  }

  const stamp = driver() === 'sqlite'
    ? "UPDATE client_portal_users SET last_login_at = datetime('now') WHERE id = :id"
    : 'UPDATE client_portal_users SET last_login_at = CURRENT_TIMESTAMP WHERE id = :id';
  await query(stamp, { id: user.id });

  return {
    id: user.id,
    email: user.email,
    workspaceId: user.workspace_id,
    leadId: user.lead_id,
    businessName: user.business_name || '',
  };
}

function publicClient(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    workspaceId: user.workspace_id || user.workspaceId,
    leadId: user.lead_id || user.leadId,
    businessName: user.business_name || user.businessName || '',
  };
}

function loadLeadContext(workspaceId, leadId) {
  const domain = require('./domain');
  return domain.withDb(workspaceId, (db) => {
    const lead = db.prepare(
      `SELECT id, business_name, category, email, phone, city, state, website, status
       FROM leads WHERE id = ? LIMIT 1`
    ).get(Number(leadId));
    if (!lead) {
      throw Object.assign(new Error('Linked business not found'), { code: 'NOT_FOUND' });
    }

    let site = null;
    try {
      site = db.prepare(
        `SELECT id, name, status, preview_url, preview_path, updated_at
         FROM websites WHERE lead_id = ? ORDER BY id DESC LIMIT 1`
      ).get(lead.id);
    } catch { /* optional */ }

    let designJob = null;
    try {
      designJob = db.prepare(
        `SELECT id, title, type, status, client_form_token, contact_email, updated_at
         FROM design_jobs WHERE lead_id = ? ORDER BY id DESC LIMIT 1`
      ).get(lead.id);
    } catch { /* optional */ }

    const previewUrl = resolvePreviewUrl(site);
    return { lead, site, designJob, previewUrl };
  });
}

function resolvePreviewUrl(site) {
  if (!site) return null;
  if (site.preview_url && String(site.preview_url).trim()) {
    return String(site.preview_url).trim();
  }
  if (site.preview_path && String(site.preview_path).trim()) {
    const p = String(site.preview_path).replace(/\\/g, '/');
    const m = p.match(/website-scout-exports\/([^/]+)/i)
      || p.match(/\/([^/]+-site-[^/]+)\/?$/i);
    if (m) {
      return `${appUrl()}/site-previews/${m[1]}/`;
    }
    // Absolute export folder name as last path segment
    const parts = p.split('/').filter(Boolean);
    const last = parts[parts.length - 1];
    if (last && /site|ws-/i.test(last)) {
      return `${appUrl()}/site-previews/${last}/`;
    }
  }
  return null;
}

/** Paths clients must not change via inline portal edit (verified facts / URLs). */
const PORTAL_LOCKED_PATH = /(^|\.)(phone|phone_display|email|address|address_lines|hours|rating|review_count|business_name|href|cta_href|cta_secondary_href|button_href|url|photographer|photographer_url|pexels_url)$/;

function isPortalLockedPath(path) {
  return PORTAL_LOCKED_PATH.test(String(path || ''));
}

function setContentPath(obj, path, value) {
  const parts = String(path).split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = /^\d+$/.test(parts[i]) ? Number(parts[i]) : parts[i];
    if (cur[key] == null || typeof cur[key] !== 'object') {
      cur[key] = /^\d+$/.test(parts[i + 1]) ? [] : {};
    }
    cur = cur[key];
  }
  const last = parts[parts.length - 1];
  cur[/^\d+$/.test(last) ? Number(last) : last] = value;
}

function pagesHaveEditableSections(pages) {
  return Array.isArray(pages)
    && pages.some((p) => Array.isArray(p.sections) && p.sections.length > 0);
}

/** Section model or freeform page.html — both support portal inline text edit. */
function pagesSupportInlineEdit(pages) {
  return Array.isArray(pages) && pages.some((p) =>
    (Array.isArray(p.sections) && p.sections.length > 0)
    || (typeof p.html === 'string' && p.html.trim())
  );
}

function pagesHaveFreeformHtml(pages) {
  return Array.isArray(pages)
    && pages.some((p) => typeof p.html === 'string' && p.html.trim());
}

function parseJsonSafe(raw, fallback) {
  if (raw == null) return fallback;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/**
 * Resolve the client's site for their linked lead only (workspace + lead scoped).
 */
function resolveClientSite(db, leadId) {
  const lid = Number(leadId);
  const site = db.prepare(
    `SELECT id, lead_id, name, status, pages, theme, preview_url, preview_path, updated_at
     FROM websites WHERE lead_id = ? ORDER BY id DESC LIMIT 1`
  ).get(lid);
  if (!site) return null;
  return {
    id: site.id,
    lead_id: site.lead_id,
    name: site.name,
    status: site.status,
    pages: parseJsonSafe(site.pages, []),
    theme: parseJsonSafe(site.theme, {}) || {},
    preview_url: site.preview_url,
    preview_path: site.preview_path,
    updated_at: site.updated_at,
  };
}

/**
 * Render the client's website HTML with editable markers (data-edit / ws-edit).
 * Ownership: workspaceId + leadId from the portal session only.
 */
function renderClientSite(workspaceId, leadId, opts = {}) {
  const domain = require('./domain');
  const leadOk = domain.withDb(workspaceId, (db) => {
    const lead = db.prepare('SELECT id FROM leads WHERE id = ? LIMIT 1').get(Number(leadId));
    if (!lead) {
      throw Object.assign(new Error('Linked business not found'), { code: 'NOT_FOUND' });
    }
    const site = resolveClientSite(db, leadId);
    if (!site || !Array.isArray(site.pages) || !site.pages.length) {
      throw Object.assign(new Error('No website is available to edit yet'), { code: 'NO_SITE' });
    }
    return site;
  });
  const editableWanted = opts.editable !== false;
  const canInlineEdit = editableWanted && pagesSupportInlineEdit(leadOk.pages);
  const rendered = domain.sitesRenderHtml(workspaceId, leadOk.id, {
    editable: canInlineEdit,
    pageSlug: opts.pageSlug,
    pageIndex: opts.pageIndex,
  });
  return {
    siteId: leadOk.id,
    name: leadOk.name,
    editable: canInlineEdit,
    freeform: pagesHaveFreeformHtml(leadOk.pages),
    previewUrl: resolvePreviewUrl(leadOk),
    html: rendered.html,
    pages: rendered.pages,
  };
}

/**
 * Apply text edits from portal postMessage ids (`page:section:path`).
 * Saves via sitesSave (re-materializes /site-previews) and syncs design deliverable when linked.
 */
function applyClientTextEdits(workspaceId, leadId, edits) {
  const domain = require('./domain');
  const list = Array.isArray(edits) ? edits : [];
  if (!list.length) {
    throw Object.assign(new Error('No edits to save'), { code: 'EMPTY' });
  }
  if (list.length > 80) {
    throw Object.assign(new Error('Too many edits in one save'), { code: 'TOO_MANY' });
  }

  const prepared = domain.withDb(workspaceId, (db) => {
    const lead = db.prepare('SELECT id FROM leads WHERE id = ? LIMIT 1').get(Number(leadId));
    if (!lead) {
      throw Object.assign(new Error('Linked business not found'), { code: 'NOT_FOUND' });
    }
    const site = resolveClientSite(db, leadId);
    if (!site || !Array.isArray(site.pages) || !site.pages.length) {
      throw Object.assign(new Error('No website is available to edit yet'), { code: 'NO_SITE' });
    }
    if (!pagesSupportInlineEdit(site.pages)) {
      throw Object.assign(
        new Error('This site layout does not support inline text edits. Use Request changes instead.'),
        { code: 'NOT_EDITABLE' }
      );
    }

    const engine = require('../src/websiteEngine');
    const pages = JSON.parse(JSON.stringify(site.pages));
    const theme = site.theme && typeof site.theme === 'object' ? site.theme : {};
    const applied = [];
    const skipped = [];
    /** @type {Map<number, Map<number, string>>} */
    const freeformByPage = new Map();

    for (const raw of list) {
      const id = String((raw && raw.id) || '').trim();
      const text = String((raw && raw.text) != null ? raw.text : '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 4000);

      const free = id.match(/^html:(\d+):(\d+)$/);
      if (free) {
        const pi = Number(free[1]);
        const ni = Number(free[2]);
        const page = pages[pi];
        if (!page || typeof page.html !== 'string' || !page.html.trim()) {
          skipped.push({ id, reason: 'missing' });
          continue;
        }
        if (!freeformByPage.has(pi)) freeformByPage.set(pi, new Map());
        freeformByPage.get(pi).set(ni, text);
        applied.push(id);
        continue;
      }

      const m = id.match(/^(\d+):(\d+):(.+)$/);
      if (!m) {
        skipped.push({ id, reason: 'bad_id' });
        continue;
      }
      const pi = Number(m[1]);
      const si = Number(m[2]);
      const path = m[3];
      if (isPortalLockedPath(path)) {
        skipped.push({ id, reason: 'locked' });
        continue;
      }
      const page = pages[pi];
      const section = page && Array.isArray(page.sections) ? page.sections[si] : null;
      if (!section || !section.content || typeof section.content !== 'object') {
        skipped.push({ id, reason: 'missing' });
        continue;
      }
      setContentPath(section.content, path, text);
      applied.push(id);
    }

    for (const [pi, nodeMap] of freeformByPage) {
      pages[pi].html = engine.applyFreeformTextEdits(pages[pi].html, nodeMap);
    }

    if (!applied.length) {
      throw Object.assign(
        new Error(skipped.some((s) => s.reason === 'locked')
          ? 'Those fields are locked (contact details and links). Use Request changes for those.'
          : 'No valid text edits to apply'),
        { code: 'NO_VALID_EDITS' }
      );
    }

    return {
      siteId: site.id,
      pages,
      theme,
      applied,
      skipped,
      previewFallback: resolvePreviewUrl(site),
    };
  });

  // sitesSave rematerializes public /site-previews export folder.
  const saved = domain.sitesSave(workspaceId, prepared.siteId, {
    pages: prepared.pages,
    theme: prepared.theme,
    note: 'Client portal inline edit',
  });

  domain.withDb(workspaceId, (db) => {
    try {
      const job = db.prepare(
        `SELECT id, website_id, deliverable FROM design_jobs
         WHERE lead_id = ? AND (website_id = ? OR website_id IS NULL)
         ORDER BY CASE WHEN website_id = ? THEN 0 ELSE 1 END, id DESC LIMIT 1`
      ).get(Number(leadId), prepared.siteId, prepared.siteId);
      if (job && job.deliverable) {
        const payload = parseJsonSafe(job.deliverable, null);
        if (payload && Array.isArray(payload.pages)) {
          payload.pages = prepared.pages;
          payload.theme = prepared.theme;
          db.prepare(
            `UPDATE design_jobs SET deliverable = ?, updated_at = datetime('now') WHERE id = ?`
          ).run(JSON.stringify(payload), job.id);
        }
      }
    } catch { /* optional sync */ }
  });

  const previewRow = domain.withDb(workspaceId, (db) =>
    db.prepare(`SELECT preview_url, preview_path FROM websites WHERE id = ?`).get(prepared.siteId)
  );

  return {
    siteId: prepared.siteId,
    applied: prepared.applied.length,
    skipped: prepared.skipped,
    version: saved.version,
    previewUrl: resolvePreviewUrl(previewRow) || prepared.previewFallback,
  };
}

async function calendarPosts(workspaceId, leadId, { year, month } = {}) {
  const domain = require('./domain');
  const social = require('../src/socialMedia');
  const platform = require('./platform');
  const now = new Date();
  const y = Number(year) || now.getUTCFullYear();
  const m = Number(month) || (now.getUTCMonth() + 1);
  const start = `${y}-${String(m).padStart(2, '0')}-01`;
  const endMonth = m === 12 ? 1 : m + 1;
  const endYear = m === 12 ? y + 1 : y;
  const end = `${endYear}-${String(endMonth).padStart(2, '0')}-01`;
  const billing = require('./billing');
  const { getPlan } = require('./plans');
  const platformPrice = await platform.getPlatformSetting('social.image_price_usd', '1');
  const planId = await billing.workspacePlan(workspaceId);
  const entitlements = getPlan(planId).entitlements;
  const imagesIncluded = !!entitlements.socialImagesIncluded;

  return domain.withDb(workspaceId, (db) => {
    social.ensureTables(db);
    const rows = db.prepare(
      `SELECT id, campaign_id, lead_id, day_index, scheduled_at, caption, platforms,
              image_url, status, client_notes
       FROM social_posts
       WHERE lead_id = ?
         AND scheduled_at >= ?
         AND scheduled_at < ?
       ORDER BY scheduled_at ASC, id ASC`
    ).all(Number(leadId), start, end);

    const posts = rows.map((row) => {
      let platforms = ['facebook', 'instagram'];
      try {
        const parsed = typeof row.platforms === 'string' ? JSON.parse(row.platforms || '[]') : row.platforms;
        if (Array.isArray(parsed) && parsed.length) platforms = parsed;
      } catch { /* */ }
      return {
        id: row.id,
        campaign_id: row.campaign_id,
        lead_id: row.lead_id,
        day_index: row.day_index,
        scheduled_at: row.scheduled_at,
        caption: row.caption,
        platforms,
        image_url: row.image_url,
        status: row.status,
        client_notes: row.client_notes,
        with_image: !!(row.image_url && String(row.image_url).trim()),
      };
    });

    const basePrice = social.imagePriceUsd(db, platformPrice);
    const image_price_usd = imagesIncluded ? 0 : basePrice;
    return {
      year: y,
      month: m,
      posts,
      image_price_usd,
      social_images_included: imagesIncluded,
      plan: planId,
    };
  });
}

async function generatePostBrandedImage(workspaceId, leadId, postId) {
  const domain = require('./domain');
  const social = require('../src/socialMedia');
  const billing = require('./billing');
  const platform = require('./platform');
  const { getPlan } = require('./plans');

  const requireSub = (await platform.getPlatformSetting('billing.require_subscription', '1')) === '1';
  if (requireSub) {
    const ok = await billing.workspaceHasProductAccess(workspaceId);
    if (!ok) {
      throw Object.assign(
        new Error('An active Bitpype account is required to generate branded image ads.'),
        { code: 'PAYMENT_REQUIRED', status: 402 }
      );
    }
  }

  const planId = await billing.workspacePlan(workspaceId);
  const entitlements = getPlan(planId).entitlements;
  const platformPrice = await platform.getPlatformSetting('social.image_price_usd', '1');
  const included = !!entitlements.socialImagesIncluded;
  return domain.withDb(workspaceId, async (db) => {
    social.ensureTables(db);
    return social.generateBrandedAdImage(db, {
      postId: Number(postId),
      leadId: Number(leadId),
      platformPriceFallback: platformPrice,
      chargeUsd: included ? 0 : undefined,
      includedInPlan: included,
      planId,
    });
  });
}

async function generateSocial(workspaceId, leadId, clientEmail, period) {
  const domain = require('./domain');
  const days = period === 'week' ? 7 : 30;
  const monthStart = new Date().toISOString().slice(0, 10);
  return domain.socialGenerateMonth(workspaceId, {
    leadId: Number(leadId),
    monthStart,
    days,
    withImages: false,
    clientEmail: clientEmail || '',
    requireClientApproval: true,
    activate: true,
  });
}

async function submitChangeRequest(workspaceId, leadId, clientEmail, body = {}) {
  const domain = require('./domain');
  const designJobs = require('../src/designJobs');
  const message = String(body.message || body.instructions || '').trim();
  const kind = String(body.kind || 'improvements').toLowerCase() === 'redesign'
    ? 'redesign'
    : 'improvements';

  if (!message) {
    throw Object.assign(new Error('Describe the changes you need'), { code: 'EMPTY' });
  }

  return domain.withDb(workspaceId, async (db) => {
    designJobs.ensureTables(db);
    let job = db.prepare(
      `SELECT * FROM design_jobs WHERE lead_id = ? ORDER BY id DESC LIMIT 1`
    ).get(Number(leadId));

    if (!job) {
      const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(Number(leadId));
      const created = designJobs.createJob(db, {
        leadId: Number(leadId),
        type: 'website',
        title: `${(lead && lead.business_name) || 'Client'} website`,
        instructions: 'Client portal change request — details in follow-up.',
        contactEmail: clientEmail || (lead && lead.email) || '',
      });
      job = db.prepare('SELECT * FROM design_jobs WHERE id = ?').get(created.id);
      if (!job) {
        throw Object.assign(new Error('Could not create change request'), { code: 'CREATE_FAILED' });
      }
    }

    const token = designJobs.ensureClientFormToken(db, job.id);
    return designJobs.submitClientForm(db, token, {
      message,
      kind,
      email: clientEmail || '',
      answers: body.answers || {},
    });
  });
}

/**
 * Ensure a staff `users` row + workspace membership for portal billing.
 * Stripe subscriptions attach to users; workspace plan reads owner/admin members.
 * Portal-only clients get a random password (staff login unused — they use /portal).
 */
async function ensureBillingUserForPortalClient(workspaceId, clientEmail, businessName = '') {
  const e = normalizeEmail(clientEmail);
  if (!e) {
    throw Object.assign(new Error('Email required for billing'), { code: 'EMAIL_REQUIRED' });
  }
  const ws = Number(workspaceId);
  if (!ws) {
    throw Object.assign(new Error('Workspace required for billing'), { code: 'WORKSPACE_REQUIRED' });
  }

  let rows = await query(
    `SELECT id, email, stripe_customer_id, status, deleted_at
     FROM users WHERE email = :email LIMIT 1`,
    { email: e }
  );
  let user = rows[0] || null;

  if (!user) {
    const hash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);
    const name = String(businessName || '').trim() || e.split('@')[0] || 'Client';
    const result = await query(
      `INSERT INTO users (email, password_hash, name) VALUES (:email, :hash, :name)`,
      { email: e, hash, name: name.slice(0, 120) }
    );
    let userId = result && result.insertId;
    if (!userId) {
      rows = await query(`SELECT id FROM users WHERE email = :email LIMIT 1`, { email: e });
      userId = rows[0] && rows[0].id;
    }
    if (!userId) {
      throw Object.assign(new Error('Could not create billing account'), { code: 'BILLING_USER_CREATE_FAILED' });
    }
    user = { id: userId, email: e, stripe_customer_id: null };
  }

  if (String(user.status || 'active') === 'disabled' || user.deleted_at) {
    throw Object.assign(new Error('Billing account is disabled'), { code: 'ACCOUNT_DISABLED' });
  }

  const members = await query(
    `SELECT id, role FROM workspace_members
     WHERE workspace_id = :ws AND user_id = :uid LIMIT 1`,
    { ws, uid: Number(user.id) }
  );
  if (!members[0]) {
    await query(
      `INSERT IGNORE INTO workspace_members (workspace_id, user_id, role)
       VALUES (:ws, :uid, 'owner')`,
      { ws, uid: Number(user.id) }
    );
  } else if (!['owner', 'admin'].includes(String(members[0].role))) {
    await query(
      `UPDATE workspace_members SET role = 'owner'
       WHERE workspace_id = :ws AND user_id = :uid`,
      { ws, uid: Number(user.id) }
    );
  }

  return Number(user.id);
}

async function billingForClient(workspaceId, clientEmail) {
  const billing = require('./billing');
  const { getPlan } = require('./plans');
  const owners = await query(
    `SELECT u.id, u.email, u.name, u.subscription_status, u.billing_plan, u.current_period_end,
            u.stripe_customer_id, u.is_super_admin, u.status, u.deleted_at
     FROM workspace_members m
     JOIN users u ON u.id = m.user_id
     WHERE m.workspace_id = :ws AND m.role IN ('owner','admin')
     ORDER BY CASE m.role WHEN 'owner' THEN 0 ELSE 1 END, u.id ASC`,
    { ws: Number(workspaceId) }
  );
  const subscribedOwner = (owners || []).find((u) => billing.isSubscribed(u)) || (owners || [])[0] || null;
  const workspaceSubscribed = await billing.workspaceHasSubscription(workspaceId);
  const planId = await billing.workspacePlan(workspaceId);
  const plan = getPlan(planId);

  let selfBilling = null;
  const e = normalizeEmail(clientEmail);
  if (e) {
    const rows = await query(
      `SELECT id, email, subscription_status, billing_plan, current_period_end, stripe_customer_id,
              is_super_admin, status, deleted_at
       FROM users WHERE email = :email LIMIT 1`,
      { email: e }
    );
    if (rows[0]) selfBilling = rows[0];
  }

  const statusSource = selfBilling || subscribedOwner;
  const selfPlan = selfBilling ? billing.planOfUser(selfBilling) : planId;
  const selfSubscribed = !!(selfBilling && billing.isSubscribed(selfBilling));
  // Agency-covered workspace (someone else's paid plan) — contact us to change.
  // Free / self-owned billing — client can subscribe or manage via Stripe.
  const coveredByOthers = workspaceSubscribed && !selfSubscribed;
  const canSelfServe = !coveredByOthers;

  return {
    workspaceSubscribed,
    plan: planId,
    planName: plan.name,
    entitlements: { ...plan.entitlements },
    plans: await billing.catalogForApi(),
    subscriptionStatus: statusSource
      ? (statusSource.subscription_status || (workspaceSubscribed ? 'active' : (planId === 'free' ? 'free' : 'none')))
      : (workspaceSubscribed ? 'active' : (planId === 'free' ? 'free' : 'none')),
    currentPeriodEnd: statusSource ? statusSource.current_period_end : null,
    canManage: canSelfServe,
    canSelfServe,
    hasCustomer: !!(selfBilling && selfBilling.stripe_customer_id),
    billingUserId: selfBilling ? selfBilling.id : null,
    selfPlan,
    amountLabel: await require('./platform').getPlatformSetting('billing.amount_label', 'Bitpype plans'),
    notice: coveredByOthers
      ? 'Your service is active under your Bitpype plan. Contact us to change billing.'
      : null,
  };
}

async function openBillingPortal(workspaceId, clientEmail) {
  const info = await billingForClient(workspaceId, clientEmail);
  if (!info.canSelfServe) {
    throw Object.assign(
      new Error(info.notice || 'Billing is managed by your Bitpype account manager'),
      { code: 'NO_SELF_BILLING' }
    );
  }
  const portalUser = await findByEmail(clientEmail);
  const userId = await ensureBillingUserForPortalClient(
    workspaceId,
    clientEmail,
    portalUser && portalUser.business_name
  );
  const billing = require('./billing');
  const { getStripe, appUrl: base } = require('./stripeClient');
  const user = await billing.getUserBilling(userId);
  if (!user || !user.stripe_customer_id) {
    return billing.createCheckoutSession(userId, 'standard', {
      successUrl: `${base()}/portal?checkout=success&plan=standard`,
      cancelUrl: `${base()}/portal?checkout=cancel`,
    });
  }
  const stripe = await getStripe();
  const session = await stripe.billingPortal.sessions.create({
    customer: user.stripe_customer_id,
    return_url: `${base()}/portal`,
  });
  return { url: session.url };
}

async function openCheckout(workspaceId, clientEmail, planId = 'standard') {
  const info = await billingForClient(workspaceId, clientEmail);
  if (!info.canSelfServe) {
    throw Object.assign(
      new Error(info.notice || 'Billing is managed by your Bitpype account manager'),
      { code: 'NO_SELF_BILLING' }
    );
  }
  const portalUser = await findByEmail(clientEmail);
  const userId = await ensureBillingUserForPortalClient(
    workspaceId,
    clientEmail,
    portalUser && portalUser.business_name
  );
  const { appUrl: base } = require('./stripeClient');
  const plan = planId || 'standard';
  return require('./billing').createCheckoutSession(userId, plan, {
    successUrl: `${base()}/portal?checkout=success&plan=${encodeURIComponent(plan)}`,
    cancelUrl: `${base()}/portal?checkout=cancel`,
  });
}

module.exports = {
  normalizeEmail,
  generatePassword,
  findById,
  findByEmail,
  findLeadMatches,
  requestAccess,
  login,
  publicClient,
  loadLeadContext,
  calendarPosts,
  generatePostBrandedImage,
  generateSocial,
  submitChangeRequest,
  ensureBillingUserForPortalClient,
  billingForClient,
  openBillingPortal,
  openCheckout,
  resolvePreviewUrl,
  renderClientSite,
  applyClientTextEdits,
  isPortalLockedPath,
};
