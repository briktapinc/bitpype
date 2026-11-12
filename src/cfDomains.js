'use strict';

/**
 * Cloudflare Registrar (search / check / purchase) + Pages custom-domain linking.
 * Credentials reuse Settings → Cloudflare (cf.api_token / cf.account_id).
 * Purchase bills the Cloudflare account payment method — not Bitpype Stripe.
 */

const https = require('node:https');
const cf = require('./cloudflare');

const API_HOST = 'api.cloudflare.com';
const API_BASE = '/client/v4';
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
const ACCOUNT_ID_RE = /^[0-9a-f]{32}$/i;

function fail(code, message, extra) {
  const e = new Error(message);
  e.code = code;
  if (extra && typeof extra === 'object') Object.assign(e, extra);
  return e;
}

function normalizeDomain(name) {
  const d = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');
  if (!DOMAIN_RE.test(d)) return null;
  return d;
}

function ensureTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS site_domains (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      website_id INTEGER,
      lead_id INTEGER,
      domain_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      source TEXT NOT NULL DEFAULT 'registrar',
      years INTEGER,
      price TEXT,
      currency TEXT,
      pages_project TEXT,
      public_url TEXT,
      registration_state TEXT,
      error TEXT,
      meta TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_site_domains_name ON site_domains(domain_name);
    CREATE INDEX IF NOT EXISTS idx_site_domains_website ON site_domains(website_id);
    CREATE INDEX IF NOT EXISTS idx_site_domains_status ON site_domains(status);
  `);
  try {
    const cols = db.prepare('PRAGMA table_info(websites)').all();
    if (!cols.some((c) => c && c.name === 'custom_domain')) {
      db.exec('ALTER TABLE websites ADD COLUMN custom_domain TEXT');
    }
  } catch {
    /* */
  }
  // Batch 60 (renewals policy): per-domain renewal bookkeeping on
  // site_domains. renewal_mode is DERIVED from the workspace owner's
  // subscription state by server/domainRenewals.js ('auto' while an
  // owner/admin is subscribed, else 'manual'); renewal_auto_renew is
  // the last auto_renew state observed/applied at Cloudflare Registrar.
  try {
    const cols = db.prepare('PRAGMA table_info(site_domains)').all();
    const have = new Set(cols.map((c) => c && c.name));
    const add = (name, type) => {
      if (!have.has(name)) db.exec(`ALTER TABLE site_domains ADD COLUMN ${name} ${type}`);
    };
    add('expires_at', 'TEXT');
    add('renewal_mode', 'TEXT');
    add('renewal_auto_renew', 'INTEGER');
    add('renewal_checked_at', 'TEXT');
    add('renewal_error', 'TEXT');
    add('manual_renew_requested_at', 'TEXT');
    add('manual_renew_requested_by', 'INTEGER');
    add('manual_renew_from_expiry', 'TEXT');
  } catch {
    /* */
  }
}

function apiRequest({ method, apiPath, token, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const bodyBuf = body != null ? Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)) : null;
    if (bodyBuf) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = bodyBuf.length;
    }
    const req = https.request(
      { host: API_HOST, path: apiPath, method, timeout: timeoutMs || 45000, headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = null;
          }
          resolve({ statusCode: res.statusCode, json, text });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('REQUEST_TIMEOUT')));
    req.on('error', reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

function cfError(resp, fallback) {
  let msg = '';
  if (resp && resp.json && Array.isArray(resp.json.errors) && resp.json.errors.length) {
    const e = resp.json.errors[0];
    if (e && e.message) msg = String(e.message);
  }
  if (!msg && resp && resp.json && resp.json.error && resp.json.error.message) {
    msg = String(resp.json.error.message);
  }
  if (!msg) msg = `${fallback || 'Cloudflare request failed'} (HTTP ${resp ? resp.statusCode : '?'})`;
  // Cloudflare returns generic "Authentication error" (code 10000) when the
  // token lacks Registrar scope — Pages can still work with the same token.
  if (resp && (resp.statusCode === 401 || resp.statusCode === 403) && /authentication error/i.test(msg)) {
    return 'Cloudflare rejected this Registrar call. Edit your API token (Settings → Cloudflare) and add Account → Registrar → Edit (keep Pages → Edit). Then save and retry.';
  }
  return msg;
}

async function creds(db) {
  const c = await cf.resolveCfCredentials(db);
  if (!c.token || !ACCOUNT_ID_RE.test(c.accountId || '')) {
    throw fail(
      'NOT_CONFIGURED',
      'Cloudflare is not configured. Add API token + Account ID in Settings → Cloudflare (token needs Registrar + Pages permissions).'
    );
  }
  return c;
}

// ---------- Registrant contact (Batch 38, wire shape fixed Batch 41) ----------
/**
 * The platform's default registrant contact, sent with EVERY Cloudflare
 * Registrar purchase inside the Create Registration body as
 * `contacts: { registrant: … }`. Before Batch 38 no contact was ever
 * sent, so registration depended on the Cloudflare account having a
 * default address-book entry — when it doesn't, Cloudflare fails the
 * purchase with "No registrant contact provided and no default address
 * book entry found for this account."
 *
 * Settings live in PLATFORM_SETTING_DEFS (group 'domains', Admin →
 * Settings → Domains) and resolve workspace-first, platform-fallback per
 * field — the same order cf.resolveCfCredentials uses for the token /
 * account. Organization is the only optional field.
 *
 * WIRE SHAPE — read this before touching the builder (Batch 41 hotfix):
 * the Create Registration endpoint (POST /accounts/{id}/registrar/
 * registrations) takes `contacts.registrant` holding `email`, a dotted
 * E.164 `phone` (+1.6105550123), and `postal_info` whose `name` is ONE
 * string — separate first/last name fields are NOT accepted — with a
 * nested `postal_info.address` using `street` / `city` / `state` /
 * `postal_code` / `country_code`. Only the registrant role is sent;
 * omitted roles derive from it. Sources: the Registrar API guide's
 * worked example (developers.cloudflare.com/registrar/registrar-api/)
 * + the Create Registration API reference (fetched 2026-10-28).
 *
 * TRAP (how Batch 38 went wrong): the flat snake_case `registrant_contact`
 * object (first_name / last_name / … / zip / country) is the shape of the
 * domain RESOURCE's contact representation (DomainRegistrantContact in
 * the API reference / cloudflare-go) — the create endpoint IGNORES that
 * key entirely. Batch 38 shipped exactly that shape; a live registration
 * on 2026-10-28 with all ten settings saved still failed code-10000
 * "No registrant contact provided…", which is how the trap was found.
 * Do not re-derive the create body from the resource shape.
 *
 * The REGISTRANT_FIELDS table below maps the SETTINGS (unchanged since
 * Batch 38 — saved admin values stay valid) to the resolved values the
 * builder maps onto the wire shape: the two name settings combine into
 * postal_info.name; domain.registrant_postal_code lands in the address's
 * `postal_code`; the country becomes `country_code` (uppercased).
 */
const REGISTRANT_FIELDS = [
  { setting: 'domain.registrant_first_name', field: 'first_name', label: 'First name', required: true },
  { setting: 'domain.registrant_last_name', field: 'last_name', label: 'Last name', required: true },
  { setting: 'domain.registrant_organization', field: 'organization', label: 'Organization', required: false },
  { setting: 'domain.registrant_email', field: 'email', label: 'Email', required: true },
  { setting: 'domain.registrant_phone', field: 'phone', label: 'Phone', required: true },
  { setting: 'domain.registrant_address', field: 'address', label: 'Street address', required: true },
  { setting: 'domain.registrant_city', field: 'city', label: 'City', required: true },
  { setting: 'domain.registrant_state', field: 'state', label: 'State / province', required: true },
  { setting: 'domain.registrant_postal_code', field: 'zip', label: 'Postal code', required: true },
  { setting: 'domain.registrant_country', field: 'country', label: 'Country', required: true },
];

function readWorkspaceSetting(db, key) {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    if (!row || typeof row.value !== 'string') return '';
    try {
      return String(require('./secretBox').decryptSetting(key, row.value) || '');
    } catch {
      return row.value;
    }
  } catch {
    return '';
  }
}

async function resolveRegistrantSetting(db, key) {
  const local = readWorkspaceSetting(db, key).trim();
  if (local) return local;
  try {
    const platform = require('../server/platform');
    return String((await platform.getPlatformSetting(key, '')) || '').trim();
  } catch {
    return '';
  }
}

/**
 * Normalize a stored registrant phone to the shape the Create
 * Registration schema wants: E.164 with a DOT between the country code
 * and the national number ("+1.6105550123"). The settings UI stores
 * whatever the admin typed ("+1 610 555 0123", "(610) 555-0123", …), so
 * normalization happens here, at build time.
 *
 * Rules:
 *   - Already dotted ("+1.6105550123", any country code): kept as-is —
 *     it is already in the endpoint's documented shape.
 *   - NANP numbers become "+1.<10 digits>": "+1" + 10 digits (the shape
 *     actually stored in production), a bare 11-digit 1…, or a bare
 *     10-digit number when the registrant country is US.
 *   - Any other country code ("+<digits>", no dot): passed through
 *     UNDOTTED. There is no safe way to split an arbitrary international
 *     number into country code + national number, and guessing the split
 *     would silently corrupt the contact — the stored value must then
 *     already be the full international number.
 *   - Anything else (letters, extensions, a second '+', fewer than 7 or
 *     more than 15 digits) returns null, and the builder treats that as
 *     a pre-flight failure — a malformed contact is never sent.
 * Exported for unit tests.
 */
function normalizeRegistrantPhone(raw, country) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const compact = s.replace(/[\s()\-]/g, '');
  if (/^\+\d{1,3}\.\d{5,}$/.test(compact)) return compact; // already CF-shaped
  if (!compact.startsWith('+') && compact.includes('+')) return null;
  const digits = compact.replace(/^\+/, '');
  if (!/^\d{7,15}$/.test(digits)) return null;
  if (/^1\d{10}$/.test(digits)) return '+1.' + digits.slice(1);
  if (!compact.startsWith('+') && /^\d{10}$/.test(digits) && String(country || '').toUpperCase() === 'US') {
    return '+1.' + digits;
  }
  if (compact.startsWith('+')) return '+' + digits; // non-NANP: cannot split the country code safely
  return null;
}

/**
 * Build the `contacts.registrant` object for the Create Registration
 * body from settings. `resolveSetting(key)` may be sync or async and
 * returns the raw value. Settings resolution + the missing-field
 * pre-flight are unchanged from Batch 38 (same keys, same typed
 * REGISTRANT_INCOMPLETE error naming every missing required setting and
 * where to fill it in); only the returned SHAPE is the documented
 * create-endpoint structure (Batch 41 — see the header block above).
 * Exported for unit tests.
 */
async function buildRegistrantContact(resolveSetting) {
  const values = {};
  const missing = [];
  for (const f of REGISTRANT_FIELDS) {
    let v = '';
    try {
      v = String((await resolveSetting(f.setting)) || '').trim();
    } catch {
      v = '';
    }
    if (f.field === 'country' && v) v = v.toUpperCase();
    if (v) values[f.field] = v;
    else if (f.required) missing.push(`${f.label} (${f.setting})`);
  }
  if (missing.length) {
    throw fail(
      'REGISTRANT_INCOMPLETE',
      `Domain registrant contact is incomplete — missing: ${missing.join(', ')}. ` +
        'Fill in the registrant contact under Admin → Settings → Domains, then retry. No domain was registered.',
      { missing }
    );
  }
  const phone = normalizeRegistrantPhone(values.phone, values.country);
  if (!phone) {
    throw fail(
      'REGISTRANT_INCOMPLETE',
      `Domain registrant phone is not a usable number — "${values.phone}" (domain.registrant_phone). ` +
        'Enter the full international number (e.g. +1 610 555 0123) under Admin → Settings → Domains, then retry. No domain was registered.',
      { missing: ['Phone (domain.registrant_phone)'] }
    );
  }
  const postalInfo = { name: `${values.first_name} ${values.last_name}`.trim() };
  if (values.organization) postalInfo.organization = values.organization;
  postalInfo.address = {
    street: values.address,
    city: values.city,
    state: values.state,
    postal_code: values.zip,
    country_code: values.country,
  };
  return { email: values.email, phone, postal_info: postalInfo };
}

function mapSearchDomain(row) {
  if (!row || typeof row !== 'object') return null;
  const name = normalizeDomain(row.name || row.domain_name || row.domain);
  if (!name) return null;
  const pricing = row.pricing || {};
  const registrationCost = pricing.registration_cost || pricing.registrationCost || row.registration_cost || null;
  // Batch 182 (fix 4): an explicit availability flag + a first-year
  // TOTAL. Cloudflare's registration_cost is the full first-year price
  // for standard names; when the pricing payload carries separate fee
  // components, they are added so the total is what the buyer pays.
  const feeRaw = pricing.fee != null ? pricing.fee : pricing.icann_fee != null ? pricing.icann_fee : pricing.additional_cost;
  const regNum =
    registrationCost == null || registrationCost === '' ? NaN : Number(registrationCost);
  const feeNum = feeRaw == null || feeRaw === '' ? 0 : Number(feeRaw);
  const firstYearTotal = Number.isFinite(regNum)
    ? Math.round((regNum + (Number.isFinite(feeNum) ? feeNum : 0)) * 100) / 100
    : null;
  return {
    domain: name,
    registrable: !!row.registrable,
    available: !!row.registrable,
    reason: row.reason || null,
    tier: row.tier || pricing.tier || null,
    currency: pricing.currency || row.currency || null,
    registrationCost,
    renewalCost: pricing.renewal_cost || pricing.renewalCost || row.renewal_cost || null,
    firstYearTotal,
    total: firstYearTotal,
  };
}

async function searchDomains(db, query, opts = {}) {
  const { token, accountId } = await creds(db);
  const q = String(query || '').trim();
  if (q.length < 2) throw fail('INVALID', 'Enter at least 2 characters to search.');
  const params = new URLSearchParams({ q });
  if (opts.limit) params.set('limit', String(Math.min(50, Number(opts.limit) || 20)));
  const resp = await apiRequest({
    method: 'GET',
    apiPath: `${API_BASE}/accounts/${accountId}/registrar/domain-search?${params}`,
    token,
  });
  if (resp.statusCode !== 200 || !(resp.json && resp.json.success !== false)) {
    // Some CF betas omit success:true; accept 200 with result.
    if (resp.statusCode !== 200) throw fail('CF_ERROR', cfError(resp, 'Domain search failed'));
  }
  const result = (resp.json && resp.json.result) || {};
  const list = Array.isArray(result.domains) ? result.domains : Array.isArray(resp.json.result) ? resp.json.result : [];
  const domains = list.map(mapSearchDomain).filter(Boolean);
  try {
    db.prepare('INSERT INTO activity_log (area, message) VALUES (?, ?)').run(
      'domains',
      `Domain search: "${q.slice(0, 80)}" → ${domains.length} result(s)`
    );
  } catch {
    /* */
  }
  return { query: q, domains };
}

async function checkDomains(db, names) {
  const { token, accountId } = await creds(db);
  const domains = (Array.isArray(names) ? names : [names]).map(normalizeDomain).filter(Boolean);
  if (!domains.length) throw fail('INVALID', 'Provide at least one valid domain name.');
  const resp = await apiRequest({
    method: 'POST',
    apiPath: `${API_BASE}/accounts/${accountId}/registrar/domain-check`,
    token,
    body: { domains },
  });
  if (resp.statusCode !== 200) throw fail('CF_ERROR', cfError(resp, 'Domain check failed'));
  const result = (resp.json && resp.json.result) || {};
  const list = Array.isArray(result.domains) ? result.domains : Array.isArray(resp.json.result) ? resp.json.result : [];
  return { domains: list.map(mapSearchDomain).filter(Boolean) };
}

/**
 * The DEPRECATED legacy registrar list (GET /registrar/domains).
 * Batch 69 proved it returns EMPTY live while domains exist — it is
 * kept ONLY as listRegistrations' last-resort fallback (whose callers
 * treat a legacy-sourced answer as degraded, never as truth). Never
 * expose it directly as an ownership answer (Batch 182, fix 1).
 */
async function listLegacyDomains(db) {
  const { token, accountId } = await creds(db);
  const resp = await apiRequest({
    method: 'GET',
    apiPath: `${API_BASE}/accounts/${accountId}/registrar/domains?page=1&per_page=50`,
    token,
  });
  if (resp.statusCode !== 200) throw fail('CF_ERROR', cfError(resp, 'Could not list registrar domains'));
  const list = Array.isArray(resp.json && resp.json.result) ? resp.json.result : [];
  return {
    domains: list
      .map((row) => ({
        domain: normalizeDomain(row.name || row.domain_name) || String(row.name || ''),
        status: row.status || row.state || null,
        expiresAt: row.expires_at || row.expiresAt || null,
        autoRenew: row.auto_renew != null ? !!row.auto_renew : null,
      }))
      .filter((d) => d.domain),
  };
}

/** Statuses that mean "this workspace owns / is acquiring this name". */
const OWNED_STATUSES = ['linked', 'registered', 'registering', 'pending'];

/**
 * Batch 182 (fix 2) — cached registrar-fact refresh for the read
 * paths (owned / list / status). When every live local row carries a
 * renewal_checked_at younger than the TTL, the stored facts are
 * served as-is and NO registrar call is made. Otherwise the
 * registrations list is read ONCE and the observed facts (expiry,
 * registrar auto_renew state, check stamp) are written back onto the
 * matched site_domains rows, so every view (owned, list, admin,
 * portal) reads the same populated record. Renewal MODE derivation
 * stays with server/domainRenewals (billing-aware); this refresh
 * only mirrors registrar facts. Best-effort: a registrar failure
 * returns { refreshed:false, error } and stamps nothing, so the next
 * read retries instead of caching a failure.
 */
const DOMAIN_FACTS_TTL_MIN = 15;
async function refreshDomainFacts(db) {
  ensureTables(db);
  let rows;
  try {
    rows = db
      .prepare(
        `SELECT id, domain_name, renewal_checked_at FROM site_domains
         WHERE status IN ('linked','registered','registering','pending')`
      )
      .all();
  } catch {
    return { refreshed: false, error: 'site_domains unavailable' };
  }
  if (!rows.length) return { refreshed: false, reason: 'no_domains' };
  let stale = false;
  try {
    const fresh = db
      .prepare(
        `SELECT COUNT(*) AS c FROM site_domains
         WHERE status IN ('linked','registered','registering','pending')
           AND renewal_checked_at IS NOT NULL
           AND renewal_checked_at > datetime('now', ?)`
      )
      .get(`-${DOMAIN_FACTS_TTL_MIN} minutes`);
    stale = !fresh || Number(fresh.c) < rows.length;
  } catch {
    stale = true;
  }
  if (!stale) return { refreshed: false, reason: 'fresh' };
  let regs;
  try {
    regs = await listRegistrations(db);
  } catch (e) {
    return { refreshed: false, error: (e && e.message) || 'registrar list failed' };
  }
  if (!regs || regs.registrarError) {
    return {
      refreshed: false,
      error: regs ? `registrations list degraded (legacy fallback): ${regs.registrarError}` : 'registrar list failed',
    };
  }
  const regMap = new Map();
  for (const d of regs.domains || []) regMap.set(String(d.domain || '').toLowerCase(), d);
  let updated = 0;
  for (const row of rows) {
    const reg = regMap.get(String(row.domain_name || '').toLowerCase());
    try {
      db.prepare(
        `UPDATE site_domains
         SET expires_at = COALESCE(?, expires_at),
             renewal_auto_renew = CASE WHEN ? IS NULL THEN renewal_auto_renew ELSE ? END,
             renewal_checked_at = datetime('now')
         WHERE id = ?`
      ).run(
        reg && reg.expiresAt ? reg.expiresAt : null,
        reg && reg.autoRenew != null ? 1 : null,
        reg && reg.autoRenew != null ? (reg.autoRenew ? 1 : 0) : null,
        row.id
      );
      updated++;
    } catch {
      /* a single row write failure must not fail the read */
    }
  }
  return { refreshed: true, updated, registrarDomains: regMap.size };
}

/**
 * Batch 182 (fix 1) — domains.owned LIED BY OMISSION: it read the
 * deprecated legacy registrar list (proven to answer empty while
 * domains exist), so a customer who had just paid saw
 * {"domains":[]} — their purchase appeared to vanish — while
 * domains.list (the local records) showed the domain correctly.
 *
 * Owned is now scoped to THIS workspace's own ownership records
 * (site_domains — the same source domains.list reads, so the two can
 * never disagree), enriched with live registrar facts via
 * refreshDomainFacts. Ownership NEVER comes from the raw account
 * list: another workspace's domains live in another workspace's DB,
 * so nothing can leak in either direction, even on a shared
 * Cloudflare account.
 */
async function listOwnedDomains(db) {
  ensureTables(db);
  await creds(db); // NOT_CONFIGURED surfaces exactly as before
  await refreshDomainFacts(db).catch(() => null);
  const rows = db
    .prepare(
      `SELECT * FROM site_domains WHERE status IN ('linked','registered','registering','pending')
       ORDER BY updated_at DESC, id DESC`
    )
    .all();
  const seen = new Set();
  const domains = [];
  for (const row of rows) {
    const name = normalizeDomain(row.domain_name);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    domains.push({
      domain: name,
      status: row.status,
      expiresAt: row.expires_at || null,
      autoRenew: row.renewal_auto_renew != null ? !!row.renewal_auto_renew : null,
      renewalMode: row.renewal_mode || null,
      renewalAutoRenew: row.renewal_auto_renew != null ? !!row.renewal_auto_renew : null,
      renewalCheckedAt: row.renewal_checked_at || null,
      websiteId: row.website_id != null ? Number(row.website_id) : null,
      leadId: row.lead_id != null ? Number(row.lead_id) : null,
      source: row.source || null,
    });
  }
  return { domains };
}

/**
 * Batch 60 — read the account's registrations from the CURRENT Registrar
 * API (GET /accounts/{id}/registrar/registrations, cursor-paginated;
 * each registration resource carries auto_renew + expires_at). The
 * legacy GET /registrar/domains list (used by listOwnedDomains above)
 * is deprecated by Cloudflare, so on any failure of the new list we
 * fall back to it and say which source answered.
 *
 * Batch 69 (final-review M-3): the fallback return carries
 * `registrarError` — the registrations failure is NEVER swallowed
 * silently. The legacy list was proven live to return empty while
 * domains exist, so callers that enforce state from this list (the
 * renewal reconcile) must treat a legacy-sourced answer as a FAILED
 * list, not a successful empty one.
 */
async function listRegistrations(db) {
  const { token, accountId } = await creds(db);
  try {
    const domains = [];
    let cursor = null;
    for (let page = 0; page < 10; page++) {
      // Cloudflare caps per_page at 50 on this endpoint (a 100 ask is
      // a 400 — found live at the Batch 60 deploy reconcile).
      const params = new URLSearchParams({ per_page: '50' });
      if (cursor) params.set('cursor', cursor);
      const resp = await apiRequest({
        method: 'GET',
        apiPath: `${API_BASE}/accounts/${accountId}/registrar/registrations?${params}`,
        token,
      });
      if (resp.statusCode !== 200) throw fail('CF_ERROR', cfError(resp, 'Could not list registrar registrations'));
      const result = resp.json && resp.json.result;
      const list = Array.isArray(result)
        ? result
        : (result && (result.registrations || result.domains)) || [];
      for (const row of list) {
        const name = normalizeDomain(row.domain_name || row.name);
        if (!name) continue;
        domains.push({
          domain: name,
          status: row.status || null,
          expiresAt: row.expires_at || null,
          autoRenew: row.auto_renew != null ? !!row.auto_renew : null,
        });
      }
      const next =
        (resp.json && resp.json.result_info && resp.json.result_info.cursor) ||
        (result && !Array.isArray(result) && result.cursor) ||
        null;
      if (!next || next === cursor) break;
      cursor = next;
    }
    return { domains, source: 'registrations' };
  } catch (e) {
    const legacy = await listLegacyDomains(db);
    return {
      domains: legacy.domains,
      source: 'legacy',
      registrarError: (e && e.message) || 'registrations list failed',
    };
  }
}

/**
 * Batch 60 — toggle a registration's auto_renew at Cloudflare.
 * PATCH /accounts/{id}/registrar/registrations/{domain} is documented
 * to support updating auto_renew ONLY (developers.cloudflare.com →
 * Registrar API → Update Registration). The endpoint answers a
 * workflow object: 200 with a terminal state, or 202 while it runs —
 * poll links.self a few times; a still-running workflow is reported
 * as pending (the renewal sweep confirms the end state later) rather
 * than treated as a failure. A terminal 'failed' state IS a failure.
 * NOTE: Cloudflare offers NO renew/extend endpoint — manual renewal
 * is a dashboard action (see server/domainRenewals.requestManualRenewal).
 */
/**
 * Batch 69 (final-review Low #8): a workflow's links.self is normally
 * an ABSOLUTE URL (https://api.cloudflare.com/client/v4/...).
 * Prefixing API_BASE onto it produced a malformed path and every
 * poll 404'd (reported as pending forever). Absolute → use its path
 * as-is; already-based path → as-is; bare path → prefix API_BASE
 * (the historical relative form).
 */
function workflowSelfPath(self) {
  const s = String(self || '');
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      return u.pathname + u.search;
    } catch {
      return s;
    }
  }
  if (s.startsWith(API_BASE)) return s;
  return `${API_BASE}${s.startsWith('/') ? '' : '/'}${s}`;
}

async function setRegistrationAutoRenew(db, domainName, autoRenew) {
  const domain = normalizeDomain(domainName);
  if (!domain) throw fail('INVALID', 'Invalid domain name.');
  const { token, accountId } = await creds(db);
  const resp = await apiRequest({
    method: 'PATCH',
    apiPath: `${API_BASE}/accounts/${accountId}/registrar/registrations/${encodeURIComponent(domain)}`,
    token,
    body: { auto_renew: !!autoRenew },
    timeoutMs: 60000,
  });
  if (resp.statusCode !== 200 && resp.statusCode !== 202) {
    throw fail('CF_ERROR', cfError(resp, `Could not update auto-renew for ${domain}`));
  }
  let result = (resp.json && resp.json.result) || {};
  let state = result.state || (result.completed ? 'succeeded' : null);
  if (state === 'failed') {
    throw fail('CF_ERROR', (result.error && result.error.message) || `Auto-renew update failed for ${domain}`);
  }
  let polls = 0;
  while (state && state !== 'succeeded' && result.links && result.links.self && polls < 5) {
    polls++;
    await new Promise((r) => setTimeout(r, 1200));
    try {
      const poll = await apiRequest({
        method: 'GET',
        apiPath: workflowSelfPath(result.links.self),
        token,
        timeoutMs: 30000,
      });
      if (poll.statusCode === 200 && poll.json && poll.json.result) {
        result = poll.json.result;
        state = result.state || state;
        if (state === 'failed') {
          throw fail('CF_ERROR', (result.error && result.error.message) || `Auto-renew update failed for ${domain}`);
        }
      } else break;
    } catch (e) {
      if (e && e.code === 'CF_ERROR') throw e;
      break;
    }
  }
  const reg = (result.context && result.context.registration) || null;
  return {
    domain,
    autoRenew: reg && reg.auto_renew != null ? !!reg.auto_renew : !!autoRenew,
    expiresAt: (reg && reg.expires_at) || null,
    state: state || 'succeeded',
    pending: state !== 'succeeded',
  };
}

async function registerDomain(db, domainName, opts = {}) {
  ensureTables(db);
  const domain = normalizeDomain(domainName);
  if (!domain) throw fail('INVALID', 'Invalid domain name.');
  const years = Math.min(10, Math.max(1, Number(opts.years) || 1));
  const websiteId = opts.websiteId != null ? Number(opts.websiteId) : null;
  const leadId = opts.leadId != null ? Number(opts.leadId) : null;

  // Batch 102 (SEC-05): registration is SPEND — it must run on the
  // workspace's OWN Cloudflare credentials, enforced FIRST, before any
  // Cloudflare call is made on anyone's account. The platform fallback
  // keeps serving previews/publish, but a workspace without its own
  // token can no longer register domains against the platform
  // operator's account.
  const cred = await creds(db);
  if (cred.via !== 'workspace') {
    throw fail(
      'CF_WORKSPACE_TOKEN_REQUIRED',
      'Domain registration requires this workspace\u2019s own Cloudflare API token (Settings \u2192 Cloudflare). The platform fallback covers previews and publishing only.'
    );
  }

  // Batch 38/41: pre-flight the registrant contact BEFORE any Cloudflare
  // call — a partial or malformed contact must never reach the registrar
  // (it fails there with the raw "No registrant contact provided…" error,
  // after a billable attempt has already been made).
  const registrant = await buildRegistrantContact((key) => resolveRegistrantSetting(db, key));

  // Real-time check before billable register
  const checked = await checkDomains(db, [domain]);
  const hit = (checked.domains || []).find((d) => d.domain === domain);
  if (!hit || !hit.registrable) {
    throw fail(
      'NOT_REGISTRABLE',
      hit && hit.reason
        ? `Cannot register ${domain}: ${hit.reason}`
        : `${domain} is not available for registration via Cloudflare Registrar.`
    );
  }

  // Batch 102 (SEC-02): the same price cap the guided domain flow
  // enforces (domain_flow.included_max_usd, default $25) applies here —
  // registerDomain is the one choke point every registration path
  // (guided flow completion, MCP, REST, IPC) funnels through, so the
  // cap + the own-token rule hold uniformly. Premium names stay on the
  // guided "contact us" path, exactly as the client flow presents them.
  const capRaw = await resolveRegistrantSetting(db, 'domain_flow.included_max_usd');
  const capUsd = Number(capRaw) > 0 ? Number(capRaw) : 25;
  const capCents = Math.round(capUsd * 100);
  const priceCents =
    hit.registrationCost == null || hit.registrationCost === '' || !Number.isFinite(Number(hit.registrationCost))
      ? null
      : Math.round(Number(hit.registrationCost) * 100);
  const currency = String(hit.currency || 'USD').toUpperCase();
  if (priceCents == null || currency !== 'USD' || priceCents > capCents) {
    throw fail(
      'DOMAIN_OVER_CAP',
      priceCents == null
        ? `Cannot register ${domain}: its price could not be verified at or under the $${capUsd} registration cap. Premium or unpriced domains go through the guided domain flow.`
        : `Cannot register ${domain}: price ${currency} ${(priceCents / 100).toFixed(2)} exceeds the $${capUsd} registration cap. Premium domains go through the guided domain flow.`
    );
  }
  const { token, accountId } = cred;
  const body = { domain_name: domain, years, contacts: { registrant } };
  const resp = await apiRequest({
    method: 'POST',
    apiPath: `${API_BASE}/accounts/${accountId}/registrar/registrations`,
    token,
    body,
    timeoutMs: 90000,
  });
  if (resp.statusCode !== 200 && resp.statusCode !== 201 && resp.statusCode !== 202) {
    throw fail('CF_ERROR', cfError(resp, 'Domain registration failed'));
  }

  const result = (resp.json && resp.json.result) || resp.json || {};
  const state = result.state || (result.completed ? 'succeeded' : 'in_progress');
  const row = db
    .prepare(
      `
    INSERT INTO site_domains
      (website_id, lead_id, domain_name, status, source, years, price, currency, registration_state, meta, updated_at)
    VALUES (?, ?, ?, ?, 'registrar', ?, ?, ?, ?, ?, datetime('now'))
  `
    )
    .run(
      Number.isInteger(websiteId) ? websiteId : null,
      Number.isInteger(leadId) ? leadId : null,
      domain,
      state === 'succeeded' ? 'registered' : 'registering',
      years,
      hit.registrationCost || null,
      hit.currency || null,
      state,
      JSON.stringify({ check: hit, workflow: result })
    );

  // Batch 182 (fix 2): capture the expiry the registrar reports on
  // the create workflow NOW, at registration completion — previously
  // expires_at stayed NULL on the record until some later sweep
  // happened to run, so the buyer could never see when their domain
  // expires or confirm its renewal state. The renewal reconcile
  // (server/domainRenewals, invoked by the server wrapper right
  // after this returns) derives renewal_mode + enforces auto_renew
  // from the same registrar data.
  const regCtx = (result.context && result.context.registration) || null;
  const workflowExpiresAt = (regCtx && regCtx.expires_at) || result.expires_at || null;
  if (workflowExpiresAt) {
    try {
      db.prepare(
        `UPDATE site_domains SET expires_at = ?, renewal_checked_at = datetime('now') WHERE id = ?`
      ).run(String(workflowExpiresAt), row.lastInsertRowid);
    } catch {
      /* expiry capture is best-effort; the read-path refresh heals it */
    }
  }

  if (Number.isInteger(leadId) && leadId > 0) {
    try {
      const outreach = require('./outreach');
      if (typeof outreach.recordIntent === 'function') {
        outreach.recordIntent(db, leadId, 'domain.purchased', `Registered ${domain} via Cloudflare`);
      } else {
        db.prepare('INSERT INTO lead_events (lead_id, type, detail) VALUES (?, ?, ?)').run(
          leadId,
          'domain.purchased',
          `Registered ${domain}`
        );
      }
    } catch {
      try {
        db.prepare('INSERT INTO lead_events (lead_id, type, detail) VALUES (?, ?, ?)').run(
          leadId,
          'domain.purchased',
          `Registered ${domain}`
        );
      } catch {
        /* */
      }
    }
  }

  try {
    db.prepare('INSERT INTO activity_log (area, message) VALUES (?, ?)').run(
      'domains',
      `Domain register started: ${domain} (state=${state})`
    );
  } catch {
    /* */
  }

  return {
    id: row.lastInsertRowid,
    domain,
    status: state === 'succeeded' ? 'registered' : 'registering',
    registrationState: state,
    price: hit.registrationCost || null,
    currency: hit.currency || null,
    years,
    expiresAt: workflowExpiresAt || null,
    workflow: result,
  };
}

async function registrationStatus(db, domainName) {
  ensureTables(db);
  const domain = normalizeDomain(domainName);
  if (!domain) throw fail('INVALID', 'Invalid domain name.');
  const { token, accountId } = await creds(db);
  const resp = await apiRequest({
    method: 'GET',
    apiPath: `${API_BASE}/accounts/${accountId}/registrar/registrations/${encodeURIComponent(domain)}/registration-status`,
    token,
  });
  if (resp.statusCode !== 200) throw fail('CF_ERROR', cfError(resp, 'Could not get registration status'));
  const result = (resp.json && resp.json.result) || {};
  const state = result.state || null;
  const local = db.prepare('SELECT * FROM site_domains WHERE domain_name = ? ORDER BY id DESC LIMIT 1').get(domain);
  if (local) {
    let status = local.status;
    if (state === 'succeeded')
      status = local.website_id ? (local.status === 'linked' ? 'linked' : 'registered') : 'registered';
    if (state === 'failed') status = 'failed';
    db.prepare(
      `
      UPDATE site_domains SET status = ?, registration_state = ?, error = ?, updated_at = datetime('now')
      WHERE id = ?
    `
    ).run(
      status,
      state,
      state === 'failed' ? (result.error && result.error.message) || 'Registration failed' : null,
      local.id
    );
  }
  // Batch 182 (fix 2): status used to return ONLY the workflow state,
  // so a buyer could not see the domain's expiry or renewal state
  // anywhere. On success, refresh the registrar facts onto the local
  // record (cached — see refreshDomainFacts) and return them.
  let after = local
    ? db.prepare('SELECT * FROM site_domains WHERE id = ?').get(local.id)
    : null;
  if (state === 'succeeded') {
    await refreshDomainFacts(db).catch(() => null);
    if (local) after = db.prepare('SELECT * FROM site_domains WHERE id = ?').get(local.id);
  }
  return {
    domain,
    state,
    completed: !!result.completed,
    workflow: result,
    status: after ? after.status : null,
    expiresAt: after ? after.expires_at || null : null,
    renewalMode: after ? after.renewal_mode || null : null,
    renewalAutoRenew: after && after.renewal_auto_renew != null ? !!after.renewal_auto_renew : null,
    renewalCheckedAt: after ? after.renewal_checked_at || null : null,
  };
}

/**
 * Batch 47: does this Cloudflare error mean "the domain is already on the
 * project"? Live proof (Berks repair, 2026-10-28): re-attaching an attached
 * domain fails the POST with "You have already added this custom domain",
 * which made the app's link non-idempotent and forced a detach→link dance.
 * Match on the error text (the errors[] entries and the raw body), never on
 * status alone — a 400 can equally be a genuine configuration failure.
 */
function isAlreadyAddedError(resp) {
  const texts = [];
  if (resp && resp.json && Array.isArray(resp.json.errors)) {
    for (const e of resp.json.errors) if (e && e.message) texts.push(String(e.message));
  }
  if (resp && resp.json && resp.json.error && resp.json.error.message) {
    texts.push(String(resp.json.error.message));
  }
  if (resp && resp.text) texts.push(String(resp.text).slice(0, 1000));
  return texts.some((t) => /already\s+(added|exists|attached)/i.test(t) || /has already been added/i.test(t));
}

async function pagesAddDomain(db, projectName, domainName) {
  const { token, accountId } = await creds(db);
  const project = String(projectName || '')
    .trim()
    .toLowerCase();
  const domain = normalizeDomain(domainName);
  if (!project) throw fail('INVALID', 'Pages project name is required.');
  if (!domain) throw fail('INVALID', 'Invalid domain name.');

  // Batch 47: already-attached tolerance. If the domain is already on the
  // project, the attach is satisfied — report it as pre-existing instead
  // of failing the whole link. The list is advisory: if it errors, the
  // POST below stays authoritative and its result decides.
  const findAttached = async () => {
    const listed = await pagesListDomains(db, project);
    return (
      (listed.domains || []).find((d) => String((d && d.name) || '').toLowerCase() === domain) || null
    );
  };
  try {
    const hit = await findAttached();
    if (hit) return { name: domain, status: hit.status || null, preExisting: true };
  } catch {
    /* list failed — fall through to the authoritative POST */
  }

  const resp = await apiRequest({
    method: 'POST',
    apiPath: `${API_BASE}/accounts/${accountId}/pages/projects/${encodeURIComponent(project)}/domains`,
    token,
    body: { name: domain },
  });
  if (resp.statusCode !== 200 && resp.statusCode !== 201) {
    // The list may have raced a concurrent attach: on the specific
    // already-added refusal, confirm against the project before believing
    // either way. Confirmed → pre-existing success; anything else → the
    // original error stands and the link fails honestly (Batch 42/43).
    if (isAlreadyAddedError(resp)) {
      try {
        const hit = await findAttached();
        if (hit) return { name: domain, status: hit.status || null, preExisting: true };
      } catch {
        /* confirmation failed — the original error stands */
      }
    }
    throw fail('CF_ERROR', cfError(resp, 'Could not attach domain to Pages project'));
  }
  return (resp.json && resp.json.result) || { name: domain };
}

/**
 * Batch 102 (SEC-19) — delete a Pages project outright. Used by the
 * permanent-purge teardown only, and only for the site's own auto
 * project (bp-w{ws}-s{id}); shared/custom projects are never deleted.
 */
async function pagesDeleteProject(db, projectName) {
  const { token, accountId } = await creds(db);
  const project = String(projectName || '')
    .trim()
    .toLowerCase();
  if (!project) throw fail('INVALID', 'Pages project name is required.');
  const resp = await apiRequest({
    method: 'DELETE',
    apiPath: `${API_BASE}/accounts/${accountId}/pages/projects/${encodeURIComponent(project)}`,
    token,
  });
  if (resp.statusCode !== 200 && resp.statusCode !== 204) {
    throw fail('CF_ERROR', cfError(resp, 'Could not delete Pages project'));
  }
  return { ok: true, project };
}

/**
 * Batch 102 (SEC-19) — remove the apex CNAME(s) the link path created
 * for a Pages project (<domain> → <project>.pages.dev). Mirrors the
 * ensure-side rule: only records pointing at THIS site's project are
 * deleted — DNS pointing anywhere else is not ours to remove.
 */
async function removePagesDnsRecord(db, domainName, projectName) {
  const domain = normalizeDomain(domainName);
  const project = String(projectName || '')
    .trim()
    .toLowerCase();
  if (!domain || !project) throw fail('INVALID', 'Domain and project are required.');
  const { token, accountId } = await creds(db);
  const zoneId = await findZoneId(token, accountId, domain);
  const target = `${project}.pages.dev`;
  const apex = await listApexDnsRecords(token, zoneId, domain);
  const mine = apex.filter(
    (r) => String(r.type || '').toUpperCase() === 'CNAME' && sameDnsTarget(r.content, target)
  );
  let removed = 0;
  for (const rec of mine) {
    const resp = await apiRequest({
      method: 'DELETE',
      apiPath: `${API_BASE}/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(rec.id)}`,
      token,
    });
    if (resp.statusCode !== 200 && resp.statusCode !== 204) {
      throw fail('CF_ERROR', dnsCfError(resp, `Could not remove the DNS record for ${domain}`));
    }
    removed++;
  }
  return { ok: true, domain, project, removed };
}

/**
 * Batch 102 (SEC-19) — Cloudflare teardown for a PERMANENT website
 * purge. The caller (domain.sitesPurgeSite) invokes this BEFORE the
 * local destroy nulls site_domains.website_id. Per linked domain:
 * detach it from the Pages project + remove the apex CNAME the link
 * path created. Then the Pages project itself is deleted — but only
 * when it is the site's own auto-named project (bp-w{ws}-s{id}); a
 * shared or custom cf.project may serve other sites and is left alone.
 * Never throws: per-step failures are collected into `errors` and
 * surfaced by the caller (purge result + activity log) — a broken CF
 * token must not make a purge impossible, but it must never be silent
 * either (Audit 2 §M: "permanently deleted" sites kept serving).
 */
async function teardownWebsiteCloudflare(db, { websiteId, workspaceId } = {}) {
  const out = { domains: [], dnsRemoved: 0, project: null, projectDeleted: false, errors: [] };
  let rows = [];
  try {
    rows = db.prepare('SELECT domain_name FROM site_domains WHERE website_id = ?').all(Number(websiteId));
  } catch {
    rows = [];
  }
  const project = cf.resolveProjectName(db, Number(websiteId), null, workspaceId);
  out.project = project || null;
  for (const row of rows) {
    const domain = normalizeDomain(row && row.domain_name);
    if (!domain) continue;
    const entry = { domain, detached: false, dnsRemoved: 0 };
    if (project) {
      try {
        await pagesDeleteDomain(db, project, domain);
        entry.detached = true;
      } catch (e) {
        out.errors.push(`detach ${domain}: ${(e && e.message) || e}`);
      }
      try {
        const dns = await removePagesDnsRecord(db, domain, project);
        entry.dnsRemoved = dns.removed || 0;
        out.dnsRemoved += entry.dnsRemoved;
      } catch (e) {
        out.errors.push(`dns ${domain}: ${(e && e.message) || e}`);
      }
    }
    out.domains.push(entry);
  }
  const autoProject = cf.defaultProjectForWebsite(Number(websiteId), workspaceId);
  if (project && autoProject && project === autoProject) {
    try {
      await pagesDeleteProject(db, project);
      out.projectDeleted = true;
    } catch (e) {
      out.errors.push(`project ${project}: ${(e && e.message) || e}`);
    }
  }
  return out;
}

async function pagesListDomains(db, projectName) {
  const { token, accountId } = await creds(db);
  const project = String(projectName || '')
    .trim()
    .toLowerCase();
  if (!project) throw fail('INVALID', 'Pages project name is required.');
  const resp = await apiRequest({
    method: 'GET',
    apiPath: `${API_BASE}/accounts/${accountId}/pages/projects/${encodeURIComponent(project)}/domains`,
    token,
  });
  if (resp.statusCode !== 200) throw fail('CF_ERROR', cfError(resp, 'Could not list Pages domains'));
  const list = Array.isArray(resp.json && resp.json.result) ? resp.json.result : [];
  return {
    project,
    domains: list.map((d) => ({
      name: d.name || d,
      status: d.status || null,
      verificationData: d.verification_data || d.verificationData || null,
    })),
  };
}

async function pagesDeleteDomain(db, projectName, domainName) {
  const { token, accountId } = await creds(db);
  const project = String(projectName || '')
    .trim()
    .toLowerCase();
  const domain = normalizeDomain(domainName);
  if (!project || !domain) throw fail('INVALID', 'Project and domain are required.');
  const resp = await apiRequest({
    method: 'DELETE',
    apiPath: `${API_BASE}/accounts/${accountId}/pages/projects/${encodeURIComponent(project)}/domains/${encodeURIComponent(domain)}`,
    token,
  });
  if (resp.statusCode !== 200 && resp.statusCode !== 204) {
    throw fail('CF_ERROR', cfError(resp, 'Could not remove Pages domain'));
  }
  return { ok: true, project, domain };
}

// ---------- DNS for Pages custom domains (Batch 42) ----------
/**
 * Attaching a custom domain to a Pages project does NOT create the DNS
 * record the name needs — the dashboard flow creates it interactively,
 * the API flow must do it explicitly. Batch 41's first live registration
 * proved it: the domain registered, attached to the project and the
 * transaction went "live", but the zone had ZERO records, the Pages
 * custom domain sat at status "pending" and the site never resolved.
 *
 * ensurePagesDnsRecord guarantees the apex CNAME (<domain> →
 * <project>.pages.dev, proxied) exists in the domain's zone:
 *   - zone looked up by name in the connected account;
 *   - an existing CNAME with the right target is success (idempotent);
 *   - an apex A/AAAA record (or a CNAME pointing somewhere else) is a
 *     CONFLICT — fail naming it, never delete or overwrite DNS we did
 *     not create;
 *   - otherwise the CNAME is created, then READ BACK before the link
 *     may call itself done. Any failure throws, so a flow can never
 *     report a site live on a name that does not resolve.
 *
 * The DNS calls need Zone → DNS → Edit on the API token. Registrar +
 * Pages scopes are NOT enough — Cloudflare answers 403 code 10000
 * "Authentication error", which dnsCfError translates into the same
 * actionable token guidance cfError gives for Registrar calls.
 */
function dnsCfError(resp, fallback) {
  let msg = '';
  if (resp && resp.json && Array.isArray(resp.json.errors) && resp.json.errors.length) {
    const e = resp.json.errors[0];
    if (e && e.message) msg = String(e.message);
  }
  if (!msg && resp && resp.json && resp.json.error && resp.json.error.message) {
    msg = String(resp.json.error.message);
  }
  if (!msg) msg = `${fallback || 'Cloudflare request failed'} (HTTP ${resp ? resp.statusCode : '?'})`;
  const firstCode =
    resp && resp.json && Array.isArray(resp.json.errors) && resp.json.errors.length
      ? resp.json.errors[0] && resp.json.errors[0].code
      : null;
  if (
    resp &&
    (resp.statusCode === 401 || resp.statusCode === 403) &&
    (/authentication error/i.test(msg) || Number(firstCode) === 10000)
  ) {
    return 'Cloudflare rejected this DNS call — the API token is missing the DNS permission. Edit your API token (Settings → Cloudflare) and add Zone → DNS → Edit (keep Account → Registrar → Edit and Pages → Edit). Then save and retry.';
  }
  return msg;
}

function sameDnsTarget(content, expected) {
  return (
    String(content || '')
      .trim()
      .toLowerCase()
      .replace(/\.$/, '') === expected
  );
}

/**
 * Batch 182 (fix 3a): zone candidates for a name, longest first —
 * the name itself, then each parent up to the registrable domain
 * (last two labels). A zone is hosted under its registrable name, so
 * looking up a subdomain (www.example.com) must WALK UP to
 * example.com. The old lookup queried the full subdomain as the zone
 * name, found nothing, and reported — wrongly — that no zone existed
 * in the account at all.
 */
function zoneCandidates(domain) {
  const labels = String(domain || '').split('.').filter(Boolean);
  const out = [];
  for (let i = 0; i + 2 <= labels.length; i++) out.push(labels.slice(i).join('.'));
  return out;
}

async function findZoneId(token, accountId, domain) {
  const candidates = zoneCandidates(domain);
  for (const candidate of candidates) {
    const resp = await apiRequest({
      method: 'GET',
      apiPath: `${API_BASE}/zones?name=${encodeURIComponent(candidate)}&account.id=${encodeURIComponent(accountId)}`,
      token,
    });
    if (resp.statusCode !== 200) {
      throw fail('CF_ERROR', dnsCfError(resp, `Could not look up the DNS zone for ${candidate}`));
    }
    const list = Array.isArray(resp.json && resp.json.result) ? resp.json.result : [];
    const zone = list.find((z) => z && String(z.name || '').toLowerCase() === candidate);
    if (zone && zone.id) return zone.id;
  }
  const registrable = candidates.length ? candidates[candidates.length - 1] : domain;
  throw fail(
    'ZONE_NOT_FOUND',
    `No DNS zone for ${registrable} was found in the connected Cloudflare account (the zone that ${domain} belongs to) — the domain's DNS must be hosted on this Cloudflare account before BitPype can point it at the site. If the domain was just registered, wait a moment and retry.`
  );
}

async function listApexDnsRecords(token, zoneId, domain) {
  const resp = await apiRequest({
    method: 'GET',
    apiPath: `${API_BASE}/zones/${encodeURIComponent(zoneId)}/dns_records?name=${encodeURIComponent(domain)}&per_page=100`,
    token,
  });
  if (resp.statusCode !== 200) {
    throw fail('CF_ERROR', dnsCfError(resp, `Could not read DNS records for ${domain}`));
  }
  const list = Array.isArray(resp.json && resp.json.result) ? resp.json.result : [];
  return list.filter(
    (r) =>
      r &&
      String(r.name || '')
        .toLowerCase()
        .replace(/\.$/, '') === domain
  );
}

async function ensurePagesDnsRecord(db, domainName, projectName) {
  return ensurePagesDnsRecordForName(db, domainName, projectName);
}

/**
 * Batch 182 (fix 3b): the ensure, generalized to any record name in
 * the domain's zone — the apex itself, or its www host. Same rules as
 * the apex path (Batch 42): correct CNAME already there = success; a
 * conflicting A/AAAA/CNAME fails naming the record; the created
 * record is read back before success is reported.
 */
async function ensurePagesDnsRecordForName(db, recordName, projectName) {
  const domain = normalizeDomain(recordName);
  const project = String(projectName || '')
    .trim()
    .toLowerCase();
  if (!domain) throw fail('INVALID', 'Invalid domain name.');
  if (!project) throw fail('INVALID', 'Pages project name is required.');
  const { token, accountId } = await creds(db);
  const target = `${project}.pages.dev`;
  const zoneId = await findZoneId(token, accountId, domain);

  const apex = await listApexDnsRecords(token, zoneId, domain);
  const isApexServer = (r) => ['A', 'AAAA', 'CNAME'].includes(String(r.type || '').toUpperCase());
  const existing = apex
    .filter(isApexServer)
    .find((r) => String(r.type || '').toUpperCase() === 'CNAME' && sameDnsTarget(r.content, target));
  let created = false;
  if (!existing) {
    const conflict = apex.filter(isApexServer)[0];
    if (conflict) {
      throw fail(
        'DNS_CONFLICT',
        `${domain} already has a ${String(conflict.type || '').toUpperCase()} record pointing to ${conflict.content} — BitPype will not overwrite or delete DNS it did not create. Change or remove that record in Cloudflare DNS for ${domain}, then retry.`
      );
    }
    const resp = await apiRequest({
      method: 'POST',
      apiPath: `${API_BASE}/zones/${encodeURIComponent(zoneId)}/dns_records`,
      token,
      body: { type: 'CNAME', name: domain, content: target, proxied: true, ttl: 1 },
    });
    if (resp.statusCode !== 200 && resp.statusCode !== 201) {
      throw fail('CF_ERROR', dnsCfError(resp, `Could not create the DNS record for ${domain}`));
    }
    created = true;
  }

  // Read-back: the link is only done when the record is actually there.
  const after = await listApexDnsRecords(token, zoneId, domain);
  const confirmed = after.some(
    (r) => String(r.type || '').toUpperCase() === 'CNAME' && sameDnsTarget(r.content, target)
  );
  if (!confirmed) {
    throw fail(
      'DNS_UNCONFIRMED',
      `The DNS record for ${domain} → ${target} could not be confirmed at Cloudflare. Retry in a moment; if it persists, check the DNS tab for ${domain} in the Cloudflare dashboard.`
    );
  }
  return { zoneId, target, created, name: domain };
}

/**
 * Batch 43 — the completion flow's dns step needs the ensure for a
 * transaction's website, with the Pages project resolved exactly the
 * way linkDomainToWebsite resolves it (explicit project, else
 * cf.resolveProjectName). Kept here so server/domainFlow gains no new
 * module dependency. Returns the ensure summary plus the project, so
 * the caller can hand the same project to verifyDomainResolves.
 */
async function ensureDomainDnsForWebsite(db, opts = {}) {
  ensureTables(db);
  const domain = normalizeDomain(opts.domain);
  if (!domain) throw fail('INVALID', 'Invalid domain name.');
  const websiteId = Number(opts.websiteId);
  let project =
    typeof opts.project === 'string' && opts.project.trim() ? opts.project.trim().toLowerCase() : '';
  if (!project) {
    project = cf.resolveProjectName(db, websiteId, null, opts.workspaceId);
  }
  if (!project) {
    throw fail(
      'NO_PROJECT',
      'Could not resolve a Cloudflare Pages project for this site. Publish a preview first.'
    );
  }
  const dns = await ensurePagesDnsRecord(db, domain, project);
  return { ...dns, project };
}

// ---------- Resolution verification (Batch 43) ----------
/**
 * Creating the record is not the same as the name resolving. Batch 42's
 * go-live still checked "Live" on a transaction whose name did not
 * resolve anywhere, because nothing ever VERIFIED resolution. The
 * completion flow's dns step (server/domainFlow) now polls — briefly —
 * until one of two independent witnesses says the name works:
 *   - Cloudflare Pages reports the project's custom domain "active", or
 *   - a public resolver (Cloudflare's own DNS-over-HTTPS) answers an A
 *     query for the apex (a proxied CNAME answers with A records).
 * Both readers and the sleep are injectable so tests never wait on a
 * real clock or touch a real network. Reader errors count as "not yet",
 * never as success. Returns { resolved, via, pagesStatus, attempts } —
 * it does not throw on a name that simply hasn't propagated; the caller
 * decides what an unresolved name means (the flow parks the
 * transaction, resumable, instead of marking it live).
 */
function dohRequest(domain) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: 'cloudflare-dns.com',
        path: `/dns-query?name=${encodeURIComponent(domain)}&type=A`,
        method: 'GET',
        timeout: 8000,
        headers: { Accept: 'application/dns-json' },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            json = null;
          }
          resolve({ statusCode: res.statusCode, json });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('REQUEST_TIMEOUT')));
    req.on('error', reject);
    req.end();
  });
}

async function defaultDohAnswer(domain) {
  const resp = await dohRequest(domain);
  const j = resp && resp.json;
  return !!(j && j.Status === 0 && Array.isArray(j.Answer) && j.Answer.length > 0);
}

async function verifyDomainResolves(db, domainName, projectName, opts = {}) {
  const domain = normalizeDomain(domainName);
  const project = String(projectName || '')
    .trim()
    .toLowerCase();
  if (!domain) throw fail('INVALID', 'Invalid domain name.');
  if (!project) throw fail('INVALID', 'Pages project name is required.');
  const attempts = Math.min(12, Math.max(1, Number(opts.attempts) || 5));
  const intervalMsRaw = Number(opts.intervalMs);
  const intervalMs = Number.isFinite(intervalMsRaw) && intervalMsRaw >= 0 ? intervalMsRaw : 4000;
  const sleep =
    typeof opts.sleep === 'function' ? opts.sleep : (ms) => new Promise((r) => setTimeout(r, ms));
  const dohLookup = typeof opts.dohLookup === 'function' ? opts.dohLookup : defaultDohAnswer;
  const readPagesStatus =
    typeof opts.pagesStatus === 'function'
      ? opts.pagesStatus
      : async () => {
          const list = await pagesListDomains(db, project);
          const hit = (list.domains || []).find(
            (d) => String((d && d.name) || '').toLowerCase() === domain
          );
          return hit ? hit.status : null;
        };
  let pagesStatus = null;
  for (let i = 0; i < attempts; i++) {
    try {
      pagesStatus = await readPagesStatus();
    } catch {
      pagesStatus = null;
    }
    if (pagesStatus && String(pagesStatus).toLowerCase() === 'active') {
      return { resolved: true, via: 'pages', pagesStatus, attempts: i + 1 };
    }
    let answered = false;
    try {
      answered = await dohLookup(domain);
    } catch {
      answered = false;
    }
    if (answered) return { resolved: true, via: 'dns', pagesStatus, attempts: i + 1 };
    if (i < attempts - 1) await sleep(intervalMs);
  }
  return { resolved: false, via: null, pagesStatus, attempts };
}

/**
 * Attach a domain to a website's Pages project and store the link.
 * Publishes the site first when needed so a project exists. Batch 44:
 * the publish receives the domain being linked as its SEO base
 * override ({ seoBaseUrl }) — the stored custom_domain / site_domains
 * state below is written only after the publish, so an export that
 * derived its base from stored state would bake the stale preview
 * host into canonical / sitemap / robots. The override is scoped to
 * that one export: if the publish throws, no stored state changes and
 * the site never claims a domain it doesn't have.
 */
async function linkDomainToWebsite(db, opts = {}) {
  ensureTables(db);
  const domain = normalizeDomain(opts.domain);
  if (!domain) throw fail('INVALID', 'Invalid domain name.');
  const websiteId = Number(opts.websiteId);
  if (!Number.isInteger(websiteId) || websiteId <= 0) {
    throw fail('INVALID', 'websiteId is required.');
  }
  const engine = require('./websiteEngine');
  const site = engine.getWebsite(db, websiteId);
  const leadId = opts.leadId != null ? Number(opts.leadId) : site.lead_id != null ? Number(site.lead_id) : null;

  let project = typeof opts.project === 'string' && opts.project.trim() ? opts.project.trim().toLowerCase() : '';
  if (!project) {
    project = cf.resolveProjectName(db, websiteId, null, opts.workspaceId);
  }
  if (!project)
    throw fail('NO_PROJECT', 'Could not resolve a Cloudflare Pages project for this site. Publish a preview first.');

  const publicUrl = `https://${domain}`;

  // Ensure project exists by publishing when preview is missing/local.
  const needsPublish = !site.preview_url || cf.isLocalPreviewUrl(site.preview_url) || opts.forcePublish;
  if (needsPublish && typeof opts.publishFn === 'function') {
    await opts.publishFn(websiteId, project, { seoBaseUrl: publicUrl });
  }

  const attached = await pagesAddDomain(db, project, domain);

  // Batch 42: attaching to the Pages project does not create DNS — ensure
  // the apex CNAME exists BEFORE anything is marked linked. Any failure
  // throws (missing token scope, conflict, unconfirmed record), so the
  // caller's flow fails honestly instead of reporting a dead site live.
  const dns = await ensurePagesDnsRecord(db, domain, project);

  // Batch 182 (fix 3b): the apex was ALL a link ever set up — the www
  // host silently never resolved (found live on berksjournal.com,
  // 2026-11-11: apex live, www dead). An apex link now ALSO provisions
  // www: attached to the same Pages project as a custom domain (www
  // SERVES the site — the Pages custom-domain model; there is no
  // redirect-rule precedent in this codebase to follow) plus its
  // proxied CNAME. A www failure never un-links a working apex, but
  // it is NEVER silent either: it is reported in the link result and
  // the activity log, so it can be retried by re-linking.
  let www = null;
  if (domain.split('.').length === 2) {
    const wwwName = `www.${domain}`;
    try {
      const wwwPages = await pagesAddDomain(db, project, wwwName);
      const wwwDns = await ensurePagesDnsRecordForName(db, wwwName, project);
      www = { name: wwwName, attached: true, serves: 'pages', pages: wwwPages, dns: wwwDns };
    } catch (e) {
      www = { name: wwwName, attached: false, error: (e && e.message) || String(e) };
      try {
        db.prepare('INSERT INTO activity_log (area, message) VALUES (?, ?)').run(
          'domains',
          `www provisioning failed for ${wwwName} (apex ${domain} linked OK): ${www.error}`
        );
      } catch {
        /* */
      }
    }
  }

  db.prepare(
    `
    UPDATE websites SET custom_domain = ?, preview_url = ?, updated_at = datetime('now') WHERE id = ?
  `
  ).run(domain, publicUrl, websiteId);

  const existing = db.prepare('SELECT id FROM site_domains WHERE domain_name = ? ORDER BY id DESC LIMIT 1').get(domain);
  if (existing) {
    db.prepare(
      `
      UPDATE site_domains SET website_id = ?, lead_id = ?, status = 'linked', pages_project = ?,
        public_url = ?, source = COALESCE(source, 'link'), error = NULL, updated_at = datetime('now')
      WHERE id = ?
    `
    ).run(websiteId, leadId, project, publicUrl, existing.id);
  } else {
    db.prepare(
      `
      INSERT INTO site_domains
        (website_id, lead_id, domain_name, status, source, pages_project, public_url, updated_at)
      VALUES (?, ?, ?, 'linked', ?, ?, ?, datetime('now'))
    `
    ).run(websiteId, leadId, domain, opts.source || 'link', project, publicUrl);
  }

  try {
    db.prepare('INSERT INTO activity_log (area, message) VALUES (?, ?)').run(
      'domains',
      `Linked ${domain} → website #${websiteId} (project ${project})`
    );
  } catch {
    /* */
  }

  return {
    websiteId,
    domain,
    project,
    publicUrl,
    pages: attached,
    dns,
    www,
  };
}

async function unlinkDomain(db, opts = {}) {
  ensureTables(db);
  const domain = normalizeDomain(opts.domain);
  if (!domain) throw fail('INVALID', 'Invalid domain name.');
  const row = db.prepare('SELECT * FROM site_domains WHERE domain_name = ? ORDER BY id DESC LIMIT 1').get(domain);
  const project = (opts.project || (row && row.pages_project) || '').trim().toLowerCase();
  if (project && opts.removeFromPages !== false) {
    try {
      await pagesDeleteDomain(db, project, domain);
    } catch {
      /* best effort */
    }
    // Batch 182: symmetric www teardown (best effort) — detach the
    // www host the link provisioned and remove its CNAME when it
    // points at this site's project.
    if (domain.split('.').length === 2) {
      const wwwName = `www.${domain}`;
      try {
        await pagesDeleteDomain(db, project, wwwName);
      } catch {
        /* best effort */
      }
      try {
        await removePagesDnsRecord(db, wwwName, project);
      } catch {
        /* best effort */
      }
    }
  }
  if (row && row.website_id) {
    const site = db.prepare('SELECT id, custom_domain, preview_url FROM websites WHERE id = ?').get(row.website_id);
    if (site && String(site.custom_domain || '').toLowerCase() === domain) {
      db.prepare(`UPDATE websites SET custom_domain = NULL, updated_at = datetime('now') WHERE id = ?`).run(site.id);
    }
  }
  if (row) {
    db.prepare(
      `
      UPDATE site_domains SET status = 'unlinked', updated_at = datetime('now') WHERE id = ?
    `
    ).run(row.id);
  }
  return { ok: true, domain };
}

function listLinked(db, opts = {}) {
  ensureTables(db);
  const clauses = ['1=1'];
  const params = [];
  if (opts.websiteId != null) {
    clauses.push('website_id = ?');
    params.push(Number(opts.websiteId));
  }
  if (opts.leadId != null) {
    clauses.push('lead_id = ?');
    params.push(Number(opts.leadId));
  }
  if (opts.status) {
    clauses.push('status = ?');
    params.push(String(opts.status));
  } else {
    clauses.push("status IN ('linked','registered','registering','pending')");
  }
  return db
    .prepare(`SELECT * FROM site_domains WHERE ${clauses.join(' AND ')} ORDER BY updated_at DESC, id DESC LIMIT 200`)
    .all(...params)
    .map(publicRow);
}

/**
 * Batch 184: the domain system's single answer to "is this website
 * live on its own domain?" — a site_domains row bound to the website
 * in status 'linked', the state linkDomainToWebsite writes only AFTER
 * the Pages custom domain is attached and DNS is ensured (and the
 * state registrationStatus preserves across refreshes for a linked
 * site). A merely 'registered' row (bought, not yet linked) is NOT
 * live: the site still serves from its preview host. Synchronous and
 * read-only on purpose — hot read paths (the claim meta, the site
 * exporter) consult it without any Cloudflare call. Returns the raw
 * row or null; throws if site_domains does not exist yet, so callers
 * on legacy databases can fail soft.
 */
function liveDomainForWebsite(db, websiteId) {
  const id = Number(websiteId);
  if (!Number.isInteger(id) || id <= 0) return null;
  return (
    db
      .prepare(
        `SELECT * FROM site_domains
         WHERE website_id = ? AND status = 'linked'
         ORDER BY id DESC LIMIT 1`
      )
      .get(id) || null
  );
}

function publicRow(row) {
  if (!row) return null;
  let meta = row.meta;
  if (typeof meta === 'string') {
    try {
      meta = JSON.parse(meta);
    } catch {
      meta = null;
    }
  }
  return {
    id: row.id,
    websiteId: row.website_id,
    leadId: row.lead_id,
    domain: row.domain_name,
    status: row.status,
    source: row.source,
    years: row.years,
    price: row.price,
    currency: row.currency,
    pagesProject: row.pages_project,
    publicUrl: row.public_url,
    registrationState: row.registration_state,
    error: row.error,
    expiresAt: row.expires_at || null,
    renewalMode: row.renewal_mode || null,
    renewalAutoRenew: row.renewal_auto_renew != null ? !!row.renewal_auto_renew : null,
    renewalCheckedAt: row.renewal_checked_at || null,
    renewalError: row.renewal_error || null,
    manualRenewRequestedAt: row.manual_renew_requested_at || null,
    meta,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function recordSearchIntent(db, leadId, query) {
  const id = Number(leadId);
  if (!Number.isInteger(id) || id <= 0) return;
  try {
    db.prepare('INSERT INTO lead_events (lead_id, type, detail) VALUES (?, ?, ?)').run(
      id,
      'domain.searched',
      `Searched domains: ${String(query || '').slice(0, 120)}`
    );
  } catch {
    /* */
  }
}

module.exports = {
  ensureTables,
  normalizeDomain,
  buildRegistrantContact,
  normalizeRegistrantPhone,
  REGISTRANT_FIELDS,
  searchDomains,
  checkDomains,
  listOwnedDomains,
  refreshDomainFacts,
  zoneCandidates,
  ensurePagesDnsRecordForName,
  listRegistrations,
  setRegistrationAutoRenew,
  workflowSelfPath,
  registerDomain,
  registrationStatus,
  pagesAddDomain,
  pagesListDomains,
  pagesDeleteDomain,
  pagesDeleteProject,
  removePagesDnsRecord,
  teardownWebsiteCloudflare,
  ensurePagesDnsRecord,
  ensureDomainDnsForWebsite,
  verifyDomainResolves,
  linkDomainToWebsite,
  unlinkDomain,
  listLinked,
  liveDomainForWebsite,
  recordSearchIntent,
  DOMAIN_RE,
};
