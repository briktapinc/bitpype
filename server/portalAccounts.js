// @ts-check
'use strict';

/**
 * Batch 111 (consolidation step 4) — portal accounts: identity, access requests, magic-token + password login, portal user admin, access defaults, lead context.
 * PURE code motion from server/clientPortal.js (no logic edits);
 * server/clientPortal.js re-exports the full original surface.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { query, driver } = require('./db');
const portalTabs = require('./portalTabs');
const { sendPlatformMail } = require('./mailer');
const { appUrl } = require('./stripeClient');
const { openWorkspaceDb, dataRoot } = require('./workspaceDb');
const { resolvePreviewUrl } = require('./portalShared');

function normalizeEmail(email) {
  return String(email || '')
    .trim()
    .toLowerCase();
}

function generatePassword() {
  // 12 chars, URL-safe, easy to copy from email
  return crypto.randomBytes(9).toString('base64url');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function nowSql() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

/** Per-email rate limit for requestAccess (in addition to IP limiter on the route).
 *
 * Batch 143 (full review): the counter now lives in the durable
 * Batch 55 store (rateLimitStore) like every other limiter. It was
 * the one throttle left on a per-process Map — the exact pre-55
 * defect class — so any restart/redeploy handed every email a
 * fresh 3/hour budget in front of magic-link issuance and portal
 * set-password-by-email. The Map survives below ONLY as the
 * store-outage fallback (with a warning), mirroring rateLimit.js.
 * Semantics: 3 hits per sliding hour, same as the middleware. */
const rateLimitStore = require('./rateLimitStore');
const ACCESS_EMAIL_BUCKET = 'portal-access-email';
const ACCESS_EMAIL_WINDOW_MS = 60 * 60 * 1000;
const ACCESS_EMAIL_MAX = 3;
const accessEmailHits = new Map(); // fallback only: email -> { n, resetAt }
let accessEmailFallbackWarnedAt = 0;
function allowAccessEmailMemory(email) {
  const key = String(email || '');
  const now = Date.now();
  let row = accessEmailHits.get(key);
  if (!row || now >= row.resetAt) {
    row = { n: 0, resetAt: now + ACCESS_EMAIL_WINDOW_MS };
    accessEmailHits.set(key, row);
  }
  if (row.n >= ACCESS_EMAIL_MAX) return false;
  row.n += 1;
  if (accessEmailHits.size > 5000) {
    for (const [k, v] of accessEmailHits) {
      if (now >= v.resetAt) accessEmailHits.delete(k);
    }
  }
  return true;
}
async function allowAccessEmail(email) {
  const key = String(email || '');
  try {
    const count = await rateLimitStore.recordHit(ACCESS_EMAIL_BUCKET, key, ACCESS_EMAIL_WINDOW_MS, Date.now());
    return count <= ACCESS_EMAIL_MAX;
  } catch (e) {
    const now = Date.now();
    if (now - accessEmailFallbackWarnedAt > 60 * 1000) {
      accessEmailFallbackWarnedAt = now;
      console.warn(
        `[portalAccounts] access-email counter store unavailable (${e && e.message ? e.message : e}) — counted in-memory only`
      );
    }
    return allowAccessEmailMemory(key);
  }
}

async function findById(id) {
  const rows = await query(
    `SELECT id, email, password_hash, workspace_id, lead_id, business_name, status,
            user_type, nav_overrides, module_overrides, totp_enabled,
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
            user_type, nav_overrides, module_overrides, totp_enabled,
            last_login_at, created_at, updated_at
     FROM client_portal_users WHERE email = :email LIMIT 1`,
    { email: e }
  );
  return rows[0] || null;
}

/** Active portal login email for a lead — platform DB only (never workspace SQLite). */
async function activeEmailForLead(workspaceId, leadId) {
  const ws = Number(workspaceId);
  const lid = Number(leadId);
  if (!ws || !lid) return '';
  try {
    const rows = await query(
      `SELECT email FROM client_portal_users
       WHERE workspace_id = :ws AND lead_id = :lead AND status = 'active'
       ORDER BY id DESC LIMIT 1`,
      { ws, lead: lid }
    );
    return rows[0] ? normalizeEmail(rows[0].email) : '';
  } catch (e) {
    console.warn('[clientPortal] activeEmailForLead:', e.message || e);
    return '';
  }
}

/**
 * Portal entitlement: lead must already have a website and/or design job.
 * Random outreach leads without a project must not self-provision portal access.
 */
function leadHasPortalEntitlement(db, leadId) {
  const id = Number(leadId);
  if (!id) return false;
  try {
    const site = db.prepare('SELECT id FROM websites WHERE lead_id = ? LIMIT 1').get(id);
    if (site) return true;
  } catch {
    /* optional table */
  }
  try {
    const job = db.prepare('SELECT id FROM design_jobs WHERE lead_id = ? LIMIT 1').get(id);
    if (job) return true;
  } catch {
    /* optional table */
  }
  return false;
}

/** Scan workspace SQLite DBs for an entitled lead/contact matching this email. */
function findLeadMatches(email) {
  const e = normalizeEmail(email);
  if (!e) return [];
  const root = dataRoot();
  if (!fs.existsSync(root)) return [];

  const matches = [];
  let dirs = [];
  try {
    dirs = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^\d+$/.test(d.name))
      .map((d) => Number(d.name));
  } catch (e) {
    console.warn('[clientPortal] findLeadMatches readdir:', e.message || e);
    return [];
  }

  for (const workspaceId of dirs) {
    const dbFile = path.join(root, String(workspaceId), 'websitescout.db');
    if (!fs.existsSync(dbFile)) continue;
    let db;
    try {
      db = openWorkspaceDb(workspaceId);
    } catch (e) {
      console.warn('[clientPortal] findLeadMatches openWorkspaceDb:', e.message || e);
      continue;
    }

    const seenLead = new Set();
    const pushMatch = (leadId, businessName, source) => {
      const id = Number(leadId);
      if (!id || seenLead.has(id)) return;
      if (!leadHasPortalEntitlement(db, id)) return;
      seenLead.add(id);
      matches.push({
        workspaceId,
        leadId: id,
        businessName: businessName || '',
        source,
      });
    };

    try {
      const byLead = db
        .prepare(
          `SELECT id, business_name, email, city, state, status
         FROM leads WHERE lower(trim(email)) = ? LIMIT 20`
        )
        .all(e);
      for (const lead of byLead) {
        pushMatch(lead.id, lead.business_name || '', 'lead');
      }
    } catch {
      /* table missing */
    }

    try {
      const byJob = db
        .prepare(
          `SELECT j.id AS job_id, j.lead_id, j.contact_email, j.title,
                l.business_name
         FROM design_jobs j
         LEFT JOIN leads l ON l.id = j.lead_id
         WHERE lower(trim(j.contact_email)) = ? AND j.lead_id IS NOT NULL
         ORDER BY j.id DESC LIMIT 20`
        )
        .all(e);
      for (const row of byJob) {
        pushMatch(row.lead_id, row.business_name || row.title || '', 'design_job');
      }
    } catch {
      /* optional */
    }

    try {
      const bySocial = db
        .prepare(
          `SELECT c.lead_id, c.client_email, l.business_name
         FROM social_campaigns c
         LEFT JOIN leads l ON l.id = c.lead_id
         WHERE lower(trim(c.client_email)) = ? AND c.lead_id IS NOT NULL
         ORDER BY c.id DESC LIMIT 20`
        )
        .all(e);
      for (const row of bySocial) {
        pushMatch(row.lead_id, row.business_name || '', 'social');
      }
    } catch {
      /* optional */
    }
  }

  return matches;
}

/**
 * Request access: only for existing portal users or a uniquely matched entitled lead.
 * Sends a one-time magic sign-in link (never invents/emails a password).
 * Always returns a generic { ok: true } — no enumeration of whether the email exists.
 */
async function requestAccess(email) {
  const e = normalizeEmail(email);
  if (!e || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
    throw Object.assign(new Error('Enter a valid email address'), { code: 'INVALID_EMAIL' });
  }

  // Uniform ok for rate-limited / unknown / disabled / not entitled — no enumeration.
  if (!(await allowAccessEmail(e))) {
    return { ok: true };
  }

  let existing = await findByEmail(e);
  let match = null;

  // Admin-disabled accounts must not self-reactivate via "request access".
  if (existing && String(existing.status || '') === 'disabled') {
    return { ok: true };
  }

  if (existing && existing.workspace_id && existing.lead_id) {
    // Already provisioned portal user — entitled by prior binding.
    match = {
      workspaceId: existing.workspace_id,
      leadId: existing.lead_id,
      businessName: existing.business_name || '',
    };
  } else {
    const matches = findLeadMatches(e);
    // Unknown / not entitled / ambiguous: do nothing (still generic ok).
    if (!matches.length || matches.length > 1) {
      return { ok: true };
    }
    match = matches[0];
  }

  const businessName = match.businessName || (existing && existing.business_name) || '';
  let portalUserId = existing ? existing.id : null;

  if (!existing) {
    // Unusable random hash only — never emailed. Sign-in is via magic link.
    const passwordHash = await bcrypt.hash(generatePassword(), 12);
    // Batch 29: a lead who is the tenant of a LIVE site rental starts as
    // a 'renter' (Website / Modules / Rentals tabs); everyone else 'owner'.
    const userType = defaultUserTypeForLead(match.workspaceId, match.leadId);
    await query(
      `INSERT INTO client_portal_users
        (email, password_hash, workspace_id, lead_id, business_name, status, user_type)
       VALUES (:email, :hash, :ws, :lead, :name, 'active', :userType)`,
      {
        email: e,
        hash: passwordHash,
        ws: match.workspaceId,
        lead: match.leadId,
        name: businessName,
        userType,
      }
    );
    existing = await findByEmail(e);
    portalUserId = existing && existing.id;
  }
  // Existing users: never rotate password on access request (prevents lockout attacks).

  if (!portalUserId) return { ok: true };

  const raw = crypto.randomBytes(24).toString('hex');
  const tokenHash = hashToken(raw);
  const expires = new Date(Date.now() + 30 * 60 * 1000);
  const expiresSql = expires.toISOString().slice(0, 19).replace('T', ' ');
  await query('DELETE FROM client_portal_login_tokens WHERE portal_user_id = :uid', { uid: portalUserId });
  await query(
    `INSERT INTO client_portal_login_tokens (portal_user_id, token_hash, expires_at)
     VALUES (:uid, :tokenHash, :expiresAt)`,
    { uid: portalUserId, tokenHash, expiresAt: expiresSql }
  );

  const magicUrl = `${appUrl()}/portal?magic=${encodeURIComponent(raw)}`;
  const safeName = businessName ? ` for ${businessName}` : '';
  try {
    await sendPlatformMail({
      to: e,
      subject: 'Your Bitpype client portal sign-in link',
      title: 'Client portal access',
      paragraphs: [
        `Use this link to sign in to the Bitpype client portal${safeName}.`,
        'This link expires in 30 minutes and can only be used once.',
        'If you did not request this, you can ignore this email. No password was created or changed.',
      ],
      cta: { url: magicUrl, label: 'Sign in to the portal' },
      text: `Bitpype client portal${safeName}\nSign in: ${magicUrl}\nExpires in 30 minutes.\n`,
    });
  } catch (err) {
    // Never put magic links or passwords in the HTTP response body.
    if (err.code === 'SMTP_NOT_CONFIGURED' && process.env.NODE_ENV !== 'production') {
      console.warn('[clientPortal] SMTP not configured — magic link (dev console only):', magicUrl);
    } else {
      console.warn('[clientPortal] email send failed:', err.message);
    }
  }

  return { ok: true };
}

async function loginWithMagicToken(rawToken) {
  const raw = String(rawToken || '').trim();
  if (!raw || raw.length < 16) {
    throw Object.assign(new Error('INVALID_CREDENTIALS'), { code: 'INVALID_CREDENTIALS' });
  }
  const tokenHash = hashToken(raw);
  const rows = await query(
    `SELECT t.id AS token_id, t.expires_at, t.used_at, u.id, u.email, u.workspace_id, u.lead_id,
            u.business_name, u.status, u.user_type, u.nav_overrides, u.module_overrides
     FROM client_portal_login_tokens t
     JOIN client_portal_users u ON u.id = t.portal_user_id
     WHERE t.token_hash = :tokenHash LIMIT 1`,
    { tokenHash }
  );
  const row = rows[0];
  if (!row || row.used_at || String(row.status) !== 'active') {
    throw Object.assign(new Error('INVALID_CREDENTIALS'), { code: 'INVALID_CREDENTIALS' });
  }
  const exp = new Date(String(row.expires_at).replace(' ', 'T') + 'Z');
  // Batch 143: expiry fails CLOSED (unparseable stored date = expired).
  if (!Number.isFinite(exp.getTime()) || exp.getTime() < Date.now()) {
    throw Object.assign(new Error('INVALID_CREDENTIALS'), { code: 'INVALID_CREDENTIALS' });
  }
  // Batch 143: the single-use stamp is now the atomic claim — a
  // concurrent second use of the same magic link loses the race and
  // is refused with the same enumeration-uniform error.
  const claim = await query(
    driver() === 'sqlite'
      ? "UPDATE client_portal_login_tokens SET used_at = datetime('now') WHERE id = :id AND used_at IS NULL"
      : 'UPDATE client_portal_login_tokens SET used_at = CURRENT_TIMESTAMP WHERE id = :id AND used_at IS NULL',
    { id: row.token_id }
  );
  if (!(Number(claim.affectedRows || claim.changes || 0) > 0)) {
    throw Object.assign(new Error('INVALID_CREDENTIALS'), { code: 'INVALID_CREDENTIALS' });
  }
  const stamp =
    driver() === 'sqlite'
      ? "UPDATE client_portal_users SET last_login_at = datetime('now') WHERE id = :id"
      : 'UPDATE client_portal_users SET last_login_at = CURRENT_TIMESTAMP WHERE id = :id';
  await query(stamp, { id: row.id });
  return {
    id: row.id,
    email: row.email,
    workspaceId: row.workspace_id,
    leadId: row.lead_id,
    businessName: row.business_name || '',
    userType: portalTabs.normalizeUserType(row.user_type),
    navOverrides: row.nav_overrides || null,
    moduleOverrides: row.module_overrides || null,
  };
}

const DUMMY_PORTAL_HASH = bcrypt.hashSync('timing-pad-not-a-real-password', 12);

async function login(email, password) {
  const e = normalizeEmail(email);
  const user = await findByEmail(e);
  // Batch 154 (§9): per-account login lockout — same contract as
  // the staff surface (server/routes/auth.js). The lock is checked
  // before verification can complete the flow (a locked account
  // never reaches the MFA challenge the route parks next), the
  // compare still runs for timing parity, and the outward error is
  // the SAME INVALID_CREDENTIALS as any bad password — the lock is
  // visible only server-side (login_locked_until + SEC-21 events,
  // which the portal route records from the thrown code).
  const loginLockout = require('./loginLockout');
  const lockState = user ? await loginLockout.getState('portal', user.id) : { locked: false };
  const hash = user && String(user.status) === 'active' ? user.password_hash : DUMMY_PORTAL_HASH;
  const ok = await bcrypt.compare(String(password || ''), hash);
  if (!user || String(user.status) !== 'active' || !ok || lockState.locked) {
    let justLocked = false;
    if (user && !lockState.locked) {
      justLocked = (await loginLockout.recordFailure('portal', user.id)).justLocked;
    }
    // Server-side-only markers for the route's SEC-21 event; the
    // client response is built from `code` alone and never sees them.
    // (Single Object.assign: the @ts-check scope rejects post-assign
    // property writes on the Error & { code } intersection.)
    const err = Object.assign(new Error('INVALID_CREDENTIALS'), {
      code: 'INVALID_CREDENTIALS',
      ...(lockState.locked ? { detail: 'login_locked' } : {}),
      ...(justLocked ? { justLocked: true } : {}),
    });
    throw err;
  }
  await loginLockout.recordSuccess('portal', user.id);
  if (!user.workspace_id || !user.lead_id) {
    throw Object.assign(new Error('Portal account is not linked to a site yet'), {
      code: 'NOT_LINKED',
    });
  }

  const stamp =
    driver() === 'sqlite'
      ? "UPDATE client_portal_users SET last_login_at = datetime('now') WHERE id = :id"
      : 'UPDATE client_portal_users SET last_login_at = CURRENT_TIMESTAMP WHERE id = :id';
  await query(stamp, { id: user.id });

  return {
    id: user.id,
    email: user.email,
    workspaceId: user.workspace_id,
    leadId: user.lead_id,
    businessName: user.business_name || '',
    userType: portalTabs.normalizeUserType(user.user_type),
    navOverrides: user.nav_overrides || null,
    moduleOverrides: user.module_overrides || null,
  };
}

function publicClient(user, defaults) {
  if (!user) return null;
  const userType = portalTabs.normalizeUserType(user.user_type || user.userType);
  const overridesRaw = user.nav_overrides ?? user.navOverrides;
  const overrides = portalTabs.parseNavOverrides(overridesRaw);
  const hasOverrides = overridesRaw != null && String(overridesRaw).trim() !== '';
  const moduleOverridesRaw = user.module_overrides ?? user.moduleOverrides;
  const moduleOverrides = portalTabs.parseModuleOverrides(moduleOverridesRaw);
  const hasModuleOverrides =
    moduleOverridesRaw != null && String(moduleOverridesRaw).trim() !== '';
  return {
    id: user.id,
    email: user.email,
    workspaceId: user.workspace_id || user.workspaceId,
    leadId: user.lead_id || user.leadId,
    businessName: user.business_name || user.businessName || '',
    // Batch 29: the portal frontend renders its nav from visibleTabs and
    // its module list from visibleModules; the API enforces the same
    // sets server-side (server/portalTabs.js). `defaults` is the
    // resolved type-defaults object; omitted = factory defaults.
    userType,
    navOverrides: hasOverrides ? overrides : null,
    moduleOverrides: hasModuleOverrides ? moduleOverrides : null,
    visibleTabs: portalTabs.effectiveTabs(userType, overridesRaw, defaults),
    visibleModules: portalTabs.effectiveModules(userType, moduleOverridesRaw, defaults),
  };
}

/**
 * publicClient + the admin-configured type defaults applied (async —
 * the configured defaults live in a platform setting). The portal
 * login/me payloads use this so the rendered nav always matches what
 * the API will enforce.
 */
async function publicClientWithAccess(user) {
  if (!user) return null;
  let defaults;
  try {
    defaults = await portalTabs.loadConfiguredDefaults();
  } catch {
    defaults = undefined;
  }
  return publicClient(user, defaults);
}

/**
 * Batch 29 — default user_type for a newly provisioned portal user:
 * 'renter' when the lead is the tenant of a live (trial/active) site
 * rental in its workspace DB, else 'owner'. Never throws — any lookup
 * problem (no rentals table yet, unreadable DB) falls back to 'owner'.
 */
function defaultUserTypeForLead(workspaceId, leadId) {
  try {
    const ws = Number(workspaceId);
    const lid = Number(leadId);
    if (!ws || !lid) return 'owner';
    const db = openWorkspaceDb(ws);
    const row = db
      .prepare(
        `SELECT id FROM site_rentals
          WHERE tenant_lead_id = ? AND status IN ('trial', 'active') LIMIT 1`
      )
      .get(lid);
    return row ? 'renter' : 'owner';
  } catch {
    return 'owner';
  }
}

/** Admin view of one portal user (no password hash, ever). */
function portalUserView(row, defaults) {
  if (!row) return null;
  const userType = portalTabs.normalizeUserType(row.user_type);
  const overrides = portalTabs.parseNavOverrides(row.nav_overrides);
  const hasOverrides = row.nav_overrides != null && String(row.nav_overrides).trim() !== '';
  const moduleOverrides = portalTabs.parseModuleOverrides(row.module_overrides);
  const hasModuleOverrides =
    row.module_overrides != null && String(row.module_overrides).trim() !== '';
  return {
    id: row.id,
    email: row.email,
    workspaceId: row.workspace_id,
    leadId: row.lead_id,
    businessName: row.business_name || '',
    status: row.status,
    lastLoginAt: row.last_login_at || null,
    mfaEnabled: Number(row.totp_enabled) === 1,
    createdAt: row.created_at || null,
    userType,
    navOverrides: hasOverrides ? overrides : null,
    moduleOverrides: hasModuleOverrides ? moduleOverrides : null,
    visibleTabs: portalTabs.effectiveTabs(userType, row.nav_overrides, defaults),
    visibleModules: portalTabs.effectiveModules(userType, row.module_overrides, defaults),
  };
}

/** Staff (super-admin) list of client portal users, for Admin → Users. */
async function listPortalUsers({ q = '', limit = 200 } = {}) {
  const lim = Math.min(500, Math.max(1, Number(limit) || 200));
  const needle = String(q || '').trim();
  const cols = `id, email, workspace_id, lead_id, business_name, status,
                user_type, nav_overrides, module_overrides, totp_enabled, last_login_at, created_at`;
  const rows = needle
    ? await query(
        `SELECT ${cols} FROM client_portal_users
          WHERE email LIKE :like OR business_name LIKE :like
          ORDER BY id DESC LIMIT ${lim}`,
        { like: `%${needle}%` }
      )
    : await query(`SELECT ${cols} FROM client_portal_users ORDER BY id DESC LIMIT ${lim}`);
  const defaults = await portalTabs.loadConfiguredDefaults();
  return {
    users: rows.map((row) => portalUserView(row, defaults)),
    tabs: portalTabs.PORTAL_TABS.map((key) => ({ key, label: portalTabs.TAB_LABELS[key] })),
    modules: portalTabs.PORTAL_MODULES.map((key) => ({
      key,
      label: portalTabs.MODULE_LABELS[key],
    })),
    // The CURRENT configured type defaults (Admin → Portal access) —
    // the checklists pre-fill and diff against these.
    typeDefaults: defaults.tabs,
    moduleTypeDefaults: defaults.modules,
    factoryDefaults: portalTabs.FACTORY_DEFAULTS,
  };
}

/**
 * Batch 45 — staff (super-admin) hard delete of a client portal user.
 * The TOTP secret/recovery hashes live ON this row, so deleting it also
 * removes the MFA enrollment; live sessions die on their next request
 * because requireClient re-reads the user row every time. Mirrors the
 * staff-user delete posture (Admin → Users, super-admin router).
 */
async function deletePortalUser(id) {
  const uid = Number(id);
  if (!uid) throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' });
  const existing = await findById(uid);
  if (!existing) throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' });
  await query('DELETE FROM client_portal_users WHERE id = :id', { id: uid });
  return { deleted: true, id: uid, email: existing.email };
}

/**
 * Staff (super-admin) access update: set user_type and/or nav overrides.
 * patch.resetOverrides clears overrides back to the type defaults;
 * patch.navOverrides (object) replaces them — an empty/equal-to-default
 * set is stored as NULL so "no overrides" stays the canonical state.
 */
async function updatePortalUserAccess(id, patch = {}) {
  const uid = Number(id);
  if (!uid) throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' });
  const existing = await findById(uid);
  if (!existing) throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' });

  const sets = [];
  const params = { id: uid };
  const rawType = patch.user_type ?? patch.userType;
  if (rawType !== undefined) {
    const t = String(rawType || '')
      .trim()
      .toLowerCase();
    if (!portalTabs.USER_TYPES.includes(t)) {
      throw Object.assign(new Error(`Invalid user_type: ${rawType}`), { code: 'INVALID' });
    }
    sets.push('user_type = :userType');
    params.userType = t;
  }
  if (patch.reset_overrides === true || patch.resetOverrides === true) {
    sets.push('nav_overrides = NULL');
    sets.push('module_overrides = NULL');
  } else {
    if (patch.nav_overrides !== undefined || patch.navOverrides !== undefined) {
      const clean = portalTabs.sanitizeNavOverrides(patch.nav_overrides ?? patch.navOverrides);
      if (Object.keys(clean).length === 0) {
        sets.push('nav_overrides = NULL');
      } else {
        sets.push('nav_overrides = :navOverrides');
        params.navOverrides = JSON.stringify(clean);
      }
    }
    if (patch.module_overrides !== undefined || patch.moduleOverrides !== undefined) {
      const clean = portalTabs.sanitizeModuleOverrides(
        patch.module_overrides ?? patch.moduleOverrides
      );
      if (Object.keys(clean).length === 0) {
        sets.push('module_overrides = NULL');
      } else {
        sets.push('module_overrides = :moduleOverrides');
        params.moduleOverrides = JSON.stringify(clean);
      }
    }
  }
  if (sets.length) {
    sets.push(
      driver() === 'sqlite' ? "updated_at = datetime('now')" : 'updated_at = CURRENT_TIMESTAMP'
    );
    await query(`UPDATE client_portal_users SET ${sets.join(', ')} WHERE id = :id`, params);
  }
  const defaults = await portalTabs.loadConfiguredDefaults();
  return portalUserView(await findById(uid), defaults);
}

/**
 * Batch 29 — admin-configured portal type defaults (Admin → Portal
 * access). Stored as one JSON platform setting; the factory defaults
 * apply wherever the stored config is absent or invalid.
 */
async function getPortalAccessDefaults() {
  const defaults = await portalTabs.loadConfiguredDefaults();
  return {
    defaults: {
      owner: { tabs: defaults.tabs.owner, modules: defaults.modules.owner },
      renter: { tabs: defaults.tabs.renter, modules: defaults.modules.renter },
    },
    factory: {
      owner: {
        tabs: portalTabs.FACTORY_DEFAULTS.tabs.owner,
        modules: portalTabs.FACTORY_DEFAULTS.modules.owner,
      },
      renter: {
        tabs: portalTabs.FACTORY_DEFAULTS.tabs.renter,
        modules: portalTabs.FACTORY_DEFAULTS.modules.renter,
      },
    },
    tabs: portalTabs.PORTAL_TABS.map((key) => ({ key, label: portalTabs.TAB_LABELS[key] })),
    modules: portalTabs.PORTAL_MODULES.map((key) => ({
      key,
      label: portalTabs.MODULE_LABELS[key],
    })),
  };
}

async function setPortalAccessDefaults(input) {
  const clean = portalTabs.sanitizeTypeDefaults(input);
  await require('./platform').setPlatformSetting(
    portalTabs.SETTINGS_KEY,
    JSON.stringify(clean)
  );
  portalTabs.invalidateDefaultsCache();
  return getPortalAccessDefaults();
}

function loadLeadContext(workspaceId, leadId) {
  const domain = require('./domain');
  return domain.withDb(workspaceId, (db) => {
    const lead = db
      .prepare(
        `SELECT id, business_name, category, email, phone, city, state, website, status
       FROM leads WHERE id = ? LIMIT 1`
      )
      .get(Number(leadId));
    if (!lead) {
      throw Object.assign(new Error('Linked business not found'), { code: 'NOT_FOUND' });
    }

    let site = null;
    try {
      site = db
        .prepare(
          `SELECT id, name, status, preview_url, preview_path, updated_at
         FROM websites WHERE lead_id = ? AND archived_at IS NULL ORDER BY id DESC LIMIT 1`
        )
        .get(lead.id);
    } catch {
      /* optional */
    }

    let designJob = null;
    try {
      designJob = db
        .prepare(
          `SELECT id, title, type, status, client_form_token, contact_email, updated_at
         FROM design_jobs WHERE lead_id = ? ORDER BY id DESC LIMIT 1`
        )
        .get(lead.id);
    } catch {
      /* optional */
    }

    const previewUrl = resolvePreviewUrl(site);
    return { lead, site, designJob, previewUrl };
  });
}


module.exports = {
  normalizeEmail,
  generatePassword,
  allowAccessEmail,
  findById,
  findByEmail,
  activeEmailForLead,
  findLeadMatches,
  requestAccess,
  loginWithMagicToken,
  login,
  publicClient,
  publicClientWithAccess,
  defaultUserTypeForLead,
  portalUserView,
  listPortalUsers,
  deletePortalUser,
  updatePortalUserAccess,
  getPortalAccessDefaults,
  setPortalAccessDefaults,
  loadLeadContext,
};
