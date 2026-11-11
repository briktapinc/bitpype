'use strict';

/**
 * Full product API — mirrors Electron app features (not Electron shell).
 * Muse agents: prefer this surface; MCP is the transport fallback (same core handlers).
 */

const express = require('express');
const domain = require('../domain');
const idempotency = require('../idempotency');
const partners = require('../partners');
const {
  requireRole,
  requireTokenLeadScope,
  denyLeadScopedToken,
  pinTokenLeadFilter,
  requireSuperAdmin,
} = require('../middleware');
const apiErrors = require('../apiErrors');

const router = express.Router();
// Workspace auth is applied at mount time in server.js (before paywall).

function ok(res, data) {
  res.json({ ok: true, data });
}
function fail(res, e, status = 400) {
  const code = e && e.code;
  let http = status;
  if (code === 'INSUFFICIENT_CREDITS') http = 402;
  else if (code === 'NOT_FOUND' || e.message === 'NOT_FOUND') http = 404;
  else if (code === 'FORBIDDEN' || code === 'LEAD_SCOPE') http = 403;
  else if (code === 'VALIDATION' || code === 'INVALID' || code === 'INVALID_PAGES' || code === 'SECTION_SCRIPT')
    http = 422;
  else if (code === 'CONFLICT' || code === 'FK_CONFLICT' || code === 'IDEMPOTENCY_CONFLICT') http = 409;
  else if (typeof e.status === 'number') http = e.status;
  else if (typeof code === 'number') http = code;
  const msg = (e && (e.message || e.detail)) || String(e);
  // FK / constraint → machine-readable 409 naming the referencing type when available.
  if (/FOREIGN KEY|SQLITE_CONSTRAINT/i.test(msg) && http < 400) http = 409;
  const errCode =
    typeof code === 'string' && code
      ? code
      : /FOREIGN KEY/i.test(msg)
        ? 'FK_CONFLICT'
        : http === 404
          ? 'NOT_FOUND'
          : 'ERROR';
  let message = msg;
  if (errCode === 'FK_CONFLICT' || /FOREIGN KEY/i.test(msg)) {
    const ref = e && e.references ? String(e.references) : null;
    message = ref
      ? `Delete blocked: referenced by ${ref}`
      : msg.includes('referenced')
        ? msg
        : 'Delete blocked by a related record (foreign key)';
  }
  let error = { code: errCode, message };
  // Structured extras (e.g. DUPLICATE_EMAIL names the existing lead so
  // agent callers can update it instead of retrying the create).
  if (e && e.details && typeof e.details === 'object') error.details = e.details;
  let ref;
  if (http >= 500 && errCode === 'ERROR') {
    // Batch 54: an uncoded 5xx is unexpected — log the real error with a
    // reference id and answer generically (server/apiErrors contract).
    ref = apiErrors.logError('domainApi', e);
    error = { code: 'INTERNAL', message: apiErrors.GENERIC_MESSAGE, ref };
  }
  const body = { ok: false, error };
  if (ref) body.ref = ref;
  res.status(http >= 400 && http < 600 ? http : 400).json(body);
}

/** Compact deliver receipt — never echo the full payload. */
function deliverReceipt(job) {
  if (!job) return { job_id: null, status: null, website_id: null, qa: { passed: false, checks_failed: [] } };
  const qaRaw = job.qa || job.qa_result || job.qaResult || null;
  let checksFailed = [];
  let passed = true;
  if (qaRaw && typeof qaRaw === 'object') {
    passed = qaRaw.passed !== false && qaRaw.ok !== false;
    const fails = qaRaw.checks_failed || qaRaw.failed || qaRaw.failures || [];
    if (Array.isArray(fails)) {
      checksFailed = fails
        .map((f) => (typeof f === 'string' ? f : (f && (f.name || f.check || f.message)) || String(f)))
        .slice(0, 40);
    }
  } else if (Array.isArray(job.warnings) && job.warnings.length) {
    passed = true;
    checksFailed = [];
  }
  return {
    job_id: job.id != null ? Number(job.id) : null,
    status: job.status || null,
    website_id: job.website_id != null ? Number(job.website_id) : null,
    qa: { passed: !!passed, checks_failed: checksFailed },
    replayed: !!job._idempotency_replayed,
  };
}

async function withIdempotency(req, operation, body, run) {
  const key = idempotency.extractKey(req);
  if (!key) return run();
  const { openWorkspaceDb } = require('../workspaceDb');
  const db = openWorkspaceDb(req.auth.workspaceId);
  return idempotency.once(db, operation, key, body, run);
}

function numLead(...vals) {
  for (const v of vals) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

// Batch 53 (review E-2): bulk lead DELETE is the same destructive
// operation as DELETE /leads/:id, so it carries the same owner/admin
// gate — applied conditionally so the non-destructive bulk actions
// (status / tag / research / …) keep their existing access.
const gateBulkLeadDelete = (req, res, next) => {
  if (String((req.body || {}).action || '') === 'delete') {
    return requireRole('owner', 'admin')(req, res, next);
  }
  return next();
};
const scopeLeadParam = requireTokenLeadScope((req) => numLead(req.params.id));
const scopeLeadIdParam = requireTokenLeadScope((req) => numLead(req.params.leadId));
const scopeBodyLead = requireTokenLeadScope((req) => numLead(req.body && req.body.leadId));
const scopeQueryLead = requireTokenLeadScope((req) => numLead(req.query && req.query.leadId));

function scopeWebsite(req, res, next) {
  if (!req.auth || req.auth.via !== 'token' || !req.auth.leadId) return next();
  try {
    const site = domain.sitesGet(req.auth.workspaceId, Number(req.params.id));
    if (!site || Number(site.lead_id) !== Number(req.auth.leadId)) {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN', code: 'LEAD_SCOPE' });
    }
    return next();
  } catch (e) {
    return fail(res, e);
  }
}

function scopeDesign(req, res, next) {
  if (!req.auth || req.auth.via !== 'token' || !req.auth.leadId) return next();
  try {
    const job = domain.designGet(req.auth.workspaceId, Number(req.params.id));
    const leadId = job && (job.lead_id != null ? job.lead_id : job.leadId);
    if (!job || Number(leadId) !== Number(req.auth.leadId)) {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN', code: 'LEAD_SCOPE' });
    }
    return next();
  } catch (e) {
    return fail(res, e);
  }
}

function scopeSocialCampaign(req, res, next) {
  if (!req.auth || req.auth.via !== 'token' || !req.auth.leadId) return next();
  try {
    const c = domain.socialCampaignGet(req.auth.workspaceId, Number(req.params.id));
    const leadId = c && (c.lead_id != null ? c.lead_id : c.leadId);
    if (!c || Number(leadId) !== Number(req.auth.leadId)) {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN', code: 'LEAD_SCOPE' });
    }
    return next();
  } catch (e) {
    return fail(res, e);
  }
}

function scopeSocialPost(req, res, next) {
  if (!req.auth || req.auth.via !== 'token' || !req.auth.leadId) return next();
  try {
    const db = require('../workspaceDb').openWorkspaceDb(req.auth.workspaceId);
    const row = db.prepare('SELECT lead_id FROM social_posts WHERE id = ?').get(Number(req.params.id));
    if (!row || Number(row.lead_id) !== Number(req.auth.leadId)) {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN', code: 'LEAD_SCOPE' });
    }
    return next();
  } catch (e) {
    return fail(res, e);
  }
}

function scopeSocialAccount(req, res, next) {
  if (!req.auth || req.auth.via !== 'token' || !req.auth.leadId) return next();
  try {
    const db = require('../workspaceDb').openWorkspaceDb(req.auth.workspaceId);
    const row = db.prepare('SELECT lead_id FROM social_accounts WHERE id = ?').get(Number(req.params.id));
    if (!row || Number(row.lead_id) !== Number(req.auth.leadId)) {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN', code: 'LEAD_SCOPE' });
    }
    return next();
  } catch (e) {
    return fail(res, e);
  }
}

// Dashboard
router.get('/dashboard/stats', denyLeadScopedToken, (req, res) => {
  try {
    const stats = domain.dashboardStats(req.auth.workspaceId);
    ok(res, {
      ...stats,
      workspace: {
        id: req.auth.workspaceId,
        name: req.auth.workspace.name,
        slug: req.auth.workspace.slug,
        role: req.auth.role,
      },
    });
  } catch (e) {
    fail(res, e, 500);
  }
});

// Leads
router.get('/leads', pinTokenLeadFilter, (req, res) => {
  try {
    ok(res, domain.leadsList(req.auth.workspaceId, req.query));
  } catch (e) {
    fail(res, e);
  }
});
router.get('/leads/facets', denyLeadScopedToken, (req, res) => {
  try {
    ok(res, { facets: domain.leadsFacets(req.auth.workspaceId) });
  } catch (e) {
    fail(res, e);
  }
});
router.get('/leads/:id', scopeLeadParam, (req, res) => {
  try {
    const data = domain.leadsGet(req.auth.workspaceId, Number(req.params.id));
    if (!data) return fail(res, Object.assign(new Error('NOT_FOUND'), { code: 404 }), 404);
    ok(res, data);
  } catch (e) {
    fail(res, e);
  }
});
router.post('/leads', denyLeadScopedToken, async (req, res) => {
  try {
    const body = req.body || {};
    const data = await withIdempotency(req, 'leads.create', body, async () => ({
      lead: domain.leadsCreate(req.auth.workspaceId, body),
    }));
    ok(res, data);
  } catch (e) {
    fail(res, e);
  }
});
router.patch('/leads/:id', scopeLeadParam, (req, res) => {
  try {
    ok(res, { lead: domain.leadsUpdate(req.auth.workspaceId, Number(req.params.id), req.body || {}) });
  } catch (e) {
    fail(res, e);
  }
});
// Batch 45 (B1): pre-flight reference summary for the delete confirm.
// Batch 85: async — the summary now merges platform portal accounts.
router.get('/leads/:id/references', scopeLeadParam, async (req, res) => {
  try {
    ok(res, { references: await domain.leadsReferences(req.auth.workspaceId, Number(req.params.id)) });
  } catch (e) {
    fail(res, e);
  }
});
router.delete('/leads/:id', requireRole('owner', 'admin'), scopeLeadParam, async (req, res) => {
  try {
    // Batch 45 (B1): return the full outcome (reference summary + which
    // websites were archive-firsted) instead of a bare id.
    // Batch 85: awaited — the delete also sweeps attached portal
    // accounts + member data in the same operation.
    const result = await domain.leadsDelete(req.auth.workspaceId, Number(req.params.id));
    ok(res, result && typeof result === 'object' ? result : { id: Number(req.params.id) });
  } catch (e) {
    if (/FOREIGN KEY|SQLITE_CONSTRAINT/i.test(String((e && e.message) || ''))) {
      e.code = e.code || 'FK_CONFLICT';
      e.status = 409;
      e.references = e.references || 'websites_or_design_jobs';
    }
    fail(res, e);
  }
});
router.post('/leads/:id/score', scopeLeadParam, (req, res) => {
  try {
    ok(res, domain.leadsScore(req.auth.workspaceId, Number(req.params.id)));
  } catch (e) {
    fail(res, e);
  }
});
router.post('/leads/:id/qualify', scopeLeadParam, (req, res) => {
  try {
    ok(res, { lead: domain.leadsQualify(req.auth.workspaceId, Number(req.params.id), req.body && req.body.note) });
  } catch (e) {
    fail(res, e);
  }
});
router.post('/leads/:id/research', scopeLeadParam, async (req, res) => {
  try {
    ok(res, await domain.leadsResearch(req.auth.workspaceId, Number(req.params.id)));
  } catch (e) {
    fail(res, e, 500);
  }
});
router.post('/leads/:id/facts', scopeLeadParam, (req, res) => {
  try {
    ok(res, { fact: domain.leadsAddFact(req.auth.workspaceId, Number(req.params.id), req.body || {}) });
  } catch (e) {
    fail(res, e);
  }
});
router.get('/leads/:id/timeline', scopeLeadParam, (req, res) => {
  try {
    ok(res, {
      timeline: domain.leadsTimeline(req.auth.workspaceId, Number(req.params.id), { limit: req.query.limit }),
    });
  } catch (e) {
    fail(res, e);
  }
});
router.get('/leads/:id/prospect-score', scopeLeadParam, (req, res) => {
  try {
    ok(res, domain.prospectScore(req.auth.workspaceId, Number(req.params.id)));
  } catch (e) {
    fail(res, e);
  }
});
router.get('/leads/:id/duplicates', scopeLeadParam, (req, res) => {
  try {
    ok(res, { duplicates: domain.leadsDuplicates(req.auth.workspaceId, Number(req.params.id)) });
  } catch (e) {
    fail(res, e);
  }
});
/** Lead claim kit (URLs + QR). Pass ?pdf=1 to download postcard PDF when a site URL exists. */
router.get('/leads/:id/claim-kit', scopeLeadParam, async (req, res) => {
  try {
    const wantPdf = String(req.query.pdf || '') === '1' || String(req.query.pdf || '').toLowerCase() === 'true';
    const kit = await domain.leadsClaimKit(req.auth.workspaceId, Number(req.params.id), {
      websiteId: req.query.websiteId ? Number(req.query.websiteId) : undefined,
      includePdf: wantPdf,
    });
    if (wantPdf && kit.pdf) {
      const safeName = String(kit.filename || 'bitpype-postcard.pdf').replace(/[^\w.\-]+/g, '_');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
      res.setHeader('Content-Length', String(kit.pdf.length));
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).end(kit.pdf);
    }
    const { pdf, ...rest } = kit;
    ok(res, rest);
  } catch (e) {
    fail(res, e, 500);
  }
});
/* Batch 74 — per-lead onboarding checklist (staff only). Reads and
 * writes alike carry the admin-area guard chain (owner/admin session,
 * lead-scoped tokens denied): the checklist is internal ops state, and
 * portal/lead tokens must never tick it. All items are OPTIONAL —
 * these routes only record ticks; nothing anywhere gates on them. */
function onboardingActor(req) {
  return {
    id: req.auth && req.auth.userId != null ? Number(req.auth.userId) : null,
    email: (req.sessionUser && req.sessionUser.email) || null,
  };
}
router.get(
  '/leads/:id/onboarding',
  requireRole('owner', 'admin'),
  denyLeadScopedToken,
  (req, res) => {
    try {
      ok(res, domain.leadOnboardingGet(req.auth.workspaceId, Number(req.params.id)));
    } catch (e) {
      fail(res, e);
    }
  }
);
router.put(
  '/leads/:id/onboarding/:key',
  requireRole('owner', 'admin'),
  denyLeadScopedToken,
  (req, res) => {
    try {
      const done = !!(req.body && req.body.done);
      ok(
        res,
        domain.leadOnboardingSet(req.auth.workspaceId, Number(req.params.id), req.params.key, done, onboardingActor(req))
      );
    } catch (e) {
      fail(res, e);
    }
  }
);
router.post(
  '/leads/:id/onboarding/run',
  requireRole('owner', 'admin'),
  denyLeadScopedToken,
  async (req, res) => {
    try {
      ok(res, await domain.leadOnboardingRun(req.auth.workspaceId, Number(req.params.id)));
    } catch (e) {
      fail(res, e);
    }
  }
);
router.post(
  '/leads/:id/onboarding/confirm',
  requireRole('owner', 'admin'),
  denyLeadScopedToken,
  async (req, res) => {
    try {
      ok(res, await domain.leadOnboardingConfirm(req.auth.workspaceId, Number(req.params.id), onboardingActor(req)));
    } catch (e) {
      fail(res, e);
    }
  }
);
router.post('/leads/merge', requireRole('owner', 'admin'), denyLeadScopedToken, (req, res) => {
  try {
    ok(res, { lead: domain.leadsMerge(req.auth.workspaceId, req.body.keepId, req.body.dropIds) });
  } catch (e) {
    fail(res, e);
  }
});
router.post('/leads/import', denyLeadScopedToken, (req, res) => {
  try {
    ok(res, domain.leadsImportCsv(req.auth.workspaceId, req.body.text, req.body));
  } catch (e) {
    fail(res, e);
  }
});
router.post('/leads/bulk', denyLeadScopedToken, gateBulkLeadDelete, async (req, res) => {
  try {
    ok(res, { bulk: await domain.leadsBulk(req.auth.workspaceId, req.body || {}) });
  } catch (e) {
    fail(res, e);
  }
});
router.post('/leads/discover', denyLeadScopedToken, async (req, res) => {
  try {
    ok(res, await domain.leadsDiscover(req.auth.workspaceId, req.body || {}));
  } catch (e) {
    fail(res, e, 500);
  }
});

// Providers / discovery schedule
router.get('/providers', denyLeadScopedToken, (req, res) => {
  try {
    ok(res, { providers: domain.providersList(req.auth.workspaceId) });
  } catch (e) {
    fail(res, e);
  }
});
router.post('/providers/search', denyLeadScopedToken, async (req, res) => {
  try {
    ok(res, await domain.providersSearch(req.auth.workspaceId, req.body || {}));
  } catch (e) {
    fail(res, e, 500);
  }
});
router.get('/discovery/schedule', denyLeadScopedToken, (req, res) => {
  try {
    ok(res, domain.discoveryGet(req.auth.workspaceId));
  } catch (e) {
    fail(res, e);
  }
});
router.put('/discovery/schedule', requireRole('owner', 'admin'), partners.denyPartnerSettings, (req, res) => {
  try {
    ok(res, { schedule: domain.discoverySet(req.auth.workspaceId, req.body || {}) });
  } catch (e) {
    fail(res, e);
  }
});
router.post('/discovery/run', requireRole('owner', 'admin', 'member'), denyLeadScopedToken, async (req, res) => {
  try {
    ok(res, await domain.discoveryRunNow(req.auth.workspaceId));
  } catch (e) {
    fail(res, e, 500);
  }
});

// Hands-off Muse mode
router.get('/hands-off', denyLeadScopedToken, async (req, res) => {
  try {
    ok(res, await domain.handsOffStatus(req.auth.workspaceId));
  } catch (e) {
    fail(res, e, 500);
  }
});
router.post('/hands-off/run', requireRole('owner', 'admin'), denyLeadScopedToken, async (req, res) => {
  try {
    const paused = domain.withDb(req.auth.workspaceId, (db) => domain.getSetting(db, 'automation_paused', '0')) === '1';
    if (paused) return ok(res, { skipped: true, reason: 'automation_paused' });
    ok(res, await domain.handsOffRunNow(req.auth.workspaceId, { force: !!(req.body && req.body.force) }));
  } catch (e) {
    fail(res, e, 500);
  }
});
router.post('/hands-off/digest', requireRole('owner', 'admin'), denyLeadScopedToken, async (req, res) => {
  try {
    ok(res, await domain.handsOffDigestNow(req.auth.workspaceId, { force: !!(req.body && req.body.force) }));
  } catch (e) {
    fail(res, e, 500);
  }
});

// Design
router.get('/design/pending', pinTokenLeadFilter, (req, res) => {
  try {
    ok(res, domain.designPending(req.auth.workspaceId, req.query));
  } catch (e) {
    fail(res, e);
  }
});
router.get('/design', pinTokenLeadFilter, (req, res) => {
  try {
    ok(res, domain.designList(req.auth.workspaceId, req.query));
  } catch (e) {
    fail(res, e);
  }
});
router.get('/design/default-instructions', (req, res) => {
  try {
    ok(res, domain.designDefaultInstructions());
  } catch (e) {
    fail(res, e);
  }
});

// Muse aliases: /design/jobs* (same handlers as /design*)
router.get('/design/jobs', pinTokenLeadFilter, (req, res) => {
  try {
    ok(res, domain.designList(req.auth.workspaceId, req.query));
  } catch (e) {
    fail(res, e);
  }
});
router.post('/design/jobs', pinTokenLeadFilter, scopeBodyLead, async (req, res) => {
  try {
    const body = req.body || {};
    const data = await withIdempotency(req, 'design.jobs.create', body, async () => ({
      job: domain.designCreate(req.auth.workspaceId, body),
    }));
    ok(res, data);
  } catch (e) {
    fail(res, e);
  }
});
router.get('/design/jobs/:id', scopeDesign, (req, res) => {
  try {
    ok(res, { job: domain.designGet(req.auth.workspaceId, Number(req.params.id)) });
  } catch (e) {
    fail(res, e);
  }
});
router.post('/design/jobs/:id/deliver', scopeDesign, async (req, res) => {
  try {
    const b = req.body || {};
    const idemBody = { id: Number(req.params.id), payload: b.payload, claims: b.claims };
    const receipt = await withIdempotency(req, 'design.deliver', idemBody, async () => {
      const job = await domain.designDeliver(req.auth.workspaceId, Number(req.params.id), b.payload, b.claims, b);
      return deliverReceipt(job);
    });
    ok(res, receipt);
  } catch (e) {
    fail(res, e);
  }
});

// Design — inbound email redesign requests (also mounted at /email-redesign)
const ER = ['/design/email-redesign', '/email-redesign'];
const erPaths = (suffix = '') => ER.map((p) => `${p}${suffix}`);
router.get(erPaths(), denyLeadScopedToken, (req, res) => {
  try {
    const args = { ...req.query };
    if (args.pendingOnly != null) args.pendingOnly = args.pendingOnly === '1' || args.pendingOnly === 'true';
    if (args.includeAll != null) args.includeAll = args.includeAll === '1' || args.includeAll === 'true';
    ok(res, domain.emailRedesignList(req.auth.workspaceId, args));
  } catch (e) {
    fail(res, e);
  }
});
router.post(erPaths('/ingest'), denyLeadScopedToken, (req, res) => {
  try {
    ok(res, domain.emailRedesignIngest(req.auth.workspaceId, req.body || {}));
  } catch (e) {
    fail(res, e);
  }
});
router.post(erPaths('/scan'), denyLeadScopedToken, (req, res) => {
  try {
    ok(res, domain.emailRedesignScan(req.auth.workspaceId));
  } catch (e) {
    fail(res, e);
  }
});
router.post(erPaths('/imap-poll'), denyLeadScopedToken, async (req, res) => {
  try {
    ok(res, await domain.imapPoll(req.auth.workspaceId, { force: true, ...(req.body || {}) }));
  } catch (e) {
    fail(res, e, 500);
  }
});
router.get(erPaths('/:id'), denyLeadScopedToken, (req, res) => {
  try {
    ok(res, domain.emailRedesignGet(req.auth.workspaceId, Number(req.params.id)));
  } catch (e) {
    fail(res, e);
  }
});
router.post(erPaths('/:id/submit'), denyLeadScopedToken, async (req, res) => {
  try {
    ok(res, await domain.emailRedesignSubmit(req.auth.workspaceId, Number(req.params.id), req.body || {}));
  } catch (e) {
    fail(res, e, 500);
  }
});
router.post(erPaths('/:id/dismiss'), denyLeadScopedToken, (req, res) => {
  try {
    ok(res, domain.emailRedesignDismiss(req.auth.workspaceId, Number(req.params.id)));
  } catch (e) {
    fail(res, e);
  }
});

// Design — learning playbook (also mounted at /design-learning)
const DL = ['/design/learning', '/design-learning'];
const dlPaths = (suffix = '') => DL.map((p) => `${p}${suffix}`);
router.get(dlPaths('/status'), denyLeadScopedToken, (req, res) => {
  try {
    ok(res, domain.learningStatus(req.auth.workspaceId));
  } catch (e) {
    fail(res, e);
  }
});
router.get(dlPaths('/playbook'), denyLeadScopedToken, (req, res) => {
  try {
    ok(res, domain.learningPlaybook(req.auth.workspaceId));
  } catch (e) {
    fail(res, e);
  }
});
router.get(dlPaths('/events'), denyLeadScopedToken, (req, res) => {
  try {
    ok(res, domain.learningEvents(req.auth.workspaceId, req.query));
  } catch (e) {
    fail(res, e);
  }
});
router.post(dlPaths('/clear'), requireRole('owner', 'admin'), (req, res) => {
  try {
    ok(res, domain.learningClear(req.auth.workspaceId, (req.body && req.body.what) || 'all'));
  } catch (e) {
    fail(res, e);
  }
});
router.post(dlPaths('/distill'), denyLeadScopedToken, async (req, res) => {
  try {
    ok(res, await domain.learningDistill(req.auth.workspaceId, req.body || {}));
  } catch (e) {
    fail(res, e, 500);
  }
});

router.post('/design/render', denyLeadScopedToken, (req, res) => {
  try {
    ok(res, domain.designRenderHtml(req.auth.workspaceId, req.body || {}));
  } catch (e) {
    fail(res, e);
  }
});
router.get('/design/:id/answers', scopeDesign, (req, res) => {
  try {
    ok(res, domain.designListAnswers(req.auth.workspaceId, Number(req.params.id)));
  } catch (e) {
    fail(res, e);
  }
});
router.post('/design/:id/contact', scopeDesign, (req, res) => {
  try {
    ok(res, { job: domain.designSetContact(req.auth.workspaceId, Number(req.params.id), req.body || {}) });
  } catch (e) {
    fail(res, e);
  }
});
router.post('/design/:id/email-questions', scopeDesign, async (req, res) => {
  try {
    ok(res, await domain.designEmailQuestions(req.auth.workspaceId, Number(req.params.id)));
  } catch (e) {
    fail(res, e, e.code === 'SEND_FAILED' ? 502 : 400);
  }
});
router.post('/design/:id/email-delivery', scopeDesign, async (req, res) => {
  try {
    ok(res, await domain.designEmailDelivery(req.auth.workspaceId, Number(req.params.id)));
  } catch (e) {
    fail(res, e, e.code === 'SEND_FAILED' ? 502 : 400);
  }
});
router.get('/design/:id/client-form', scopeDesign, (req, res) => {
  try {
    ok(res, domain.designClientFormLink(req.auth.workspaceId, Number(req.params.id)));
  } catch (e) {
    fail(res, e);
  }
});
router.post('/design/:id/reply', scopeDesign, (req, res) => {
  try {
    ok(res, {
      job: domain.designRecordReply(
        req.auth.workspaceId,
        Number(req.params.id),
        req.body && req.body.reply,
        req.body && req.body.fromEmail
      ),
    });
  } catch (e) {
    fail(res, e);
  }
});
router.put('/design/:id/website', scopeDesign, (req, res) => {
  try {
    ok(res, {
      job: domain.designSaveWebsite(
        req.auth.workspaceId,
        Number(req.params.id),
        req.body && req.body.pages,
        req.body && req.body.theme
      ),
    });
  } catch (e) {
    fail(res, e);
  }
});
router.post('/design/:id/render', scopeDesign, (req, res) => {
  try {
    ok(res, domain.designRenderHtml(req.auth.workspaceId, { ...(req.body || {}), id: Number(req.params.id) }));
  } catch (e) {
    fail(res, e);
  }
});
router.get('/design/:id/asset-base', scopeDesign, async (req, res) => {
  try {
    ok(res, await domain.designAssetBase(req.auth.workspaceId, Number(req.params.id)));
  } catch (e) {
    fail(res, e, 500);
  }
});
router.post('/design/:id/remove-delivery', requireRole('owner', 'admin'), scopeDesign, (req, res) => {
  try {
    ok(res, {
      job: domain.designRemoveDelivery(req.auth.workspaceId, Number(req.params.id), req.body && req.body.path),
    });
  } catch (e) {
    fail(res, e);
  }
});
router.delete('/design/:id/delivery', requireRole('owner', 'admin'), scopeDesign, (req, res) => {
  try {
    ok(res, {
      job: domain.designRemoveDelivery(
        req.auth.workspaceId,
        Number(req.params.id),
        (req.body && req.body.path) || req.query.path
      ),
    });
  } catch (e) {
    fail(res, e);
  }
});
router.get('/design/:id', scopeDesign, (req, res) => {
  try {
    ok(res, { job: domain.designGet(req.auth.workspaceId, Number(req.params.id)) });
  } catch (e) {
    fail(res, e);
  }
});
router.post('/design', pinTokenLeadFilter, scopeBodyLead, async (req, res) => {
  try {
    const body = req.body || {};
    const data = await withIdempotency(req, 'design.jobs.create', body, async () => ({
      job: domain.designCreate(req.auth.workspaceId, body),
    }));
    ok(res, data);
  } catch (e) {
    fail(res, e);
  }
});
router.patch('/design/:id', scopeDesign, (req, res) => {
  try {
    ok(res, { job: domain.designUpdate(req.auth.workspaceId, Number(req.params.id), req.body || {}) });
  } catch (e) {
    fail(res, e);
  }
});
router.delete('/design/:id', requireRole('owner', 'admin'), scopeDesign, (req, res) => {
  try {
    ok(res, domain.designDelete(req.auth.workspaceId, Number(req.params.id)));
  } catch (e) {
    fail(res, e);
  }
});
router.post('/design/next', denyLeadScopedToken, (req, res) => {
  try {
    ok(res, { job: domain.designNext(req.auth.workspaceId) });
  } catch (e) {
    fail(res, e);
  }
});
router.post('/design/:id/deliver', scopeDesign, async (req, res) => {
  try {
    const b = req.body || {};
    const idemBody = { id: Number(req.params.id), payload: b.payload, claims: b.claims };
    const receipt = await withIdempotency(req, 'design.deliver', idemBody, async () => {
      const job = await domain.designDeliver(req.auth.workspaceId, Number(req.params.id), b.payload, b.claims, b);
      return deliverReceipt(job);
    });
    ok(res, receipt);
  } catch (e) {
    fail(res, e);
  }
});
router.post('/design/:id/ask', scopeDesign, (req, res) => {
  try {
    ok(
      res,
      domain.designAsk(req.auth.workspaceId, Number(req.params.id), req.body.question, {
        internal: !!(req.body && req.body.internal),
      })
    );
  } catch (e) {
    fail(res, e);
  }
});
router.post('/design/answer', denyLeadScopedToken, (req, res) => {
  try {
    ok(res, {
      job: domain.designAnswer(
        req.auth.workspaceId,
        req.body.questionId || req.body.id,
        req.body.answer,
        req.body.fromEmail
      ),
    });
  } catch (e) {
    fail(res, e);
  }
});
router.post('/design/:id/review', scopeDesign, async (req, res) => {
  try {
    ok(res, await domain.designReview(req.auth.workspaceId, Number(req.params.id), req.body || {}));
  } catch (e) {
    fail(res, e, 500);
  }
});
router.post('/design/:id/redesign', scopeDesign, async (req, res) => {
  try {
    ok(res, await domain.designRedesign(req.auth.workspaceId, Number(req.params.id), req.body || {}));
  } catch (e) {
    fail(res, e, 500);
  }
});
router.post('/design/:id/improve', scopeDesign, async (req, res) => {
  try {
    ok(res, await domain.designImprove(req.auth.workspaceId, Number(req.params.id), req.body || {}));
  } catch (e) {
    fail(res, e, 500);
  }
});
router.post('/design/:id/preview', scopeDesign, async (req, res) => {
  try {
    ok(res, await domain.designPreviewUrl(req.auth.workspaceId, Number(req.params.id), !!(req.body && req.body.open)));
  } catch (e) {
    fail(res, e, 500);
  }
});
router.post('/design/:id/images', scopeDesign, async (req, res) => {
  try {
    ok(res, await domain.designAddImages(req.auth.workspaceId, Number(req.params.id), req.body || {}));
  } catch (e) {
    fail(res, e, 500);
  }
});
router.post('/design/:id/generate-images', scopeDesign, async (req, res) => {
  try {
    ok(res, await domain.designGenerateImages(req.auth.workspaceId, Number(req.params.id), req.body || {}));
  } catch (e) {
    fail(res, e, 500);
  }
});
router.post('/design/:id/generate-logo', scopeDesign, async (req, res) => {
  try {
    ok(res, await domain.designGenerateLogo(req.auth.workspaceId, Number(req.params.id), req.body || {}));
  } catch (e) {
    fail(res, e, 500);
  }
});

// Websites
router.get('/websites', pinTokenLeadFilter, (req, res) => {
  try {
    ok(res, domain.sitesList(req.auth.workspaceId, req.query));
  } catch (e) {
    fail(res, e);
  }
});
// Batch 27: staff Archives list (registered before /websites/:id so
// 'archives' is never captured as an id).
router.get('/websites/archives', denyLeadScopedToken, (req, res) => {
  try {
    ok(res, domain.sitesArchivedList(req.auth.workspaceId));
  } catch (e) {
    fail(res, e);
  }
});
router.get('/websites/by-lead/:leadId', scopeLeadIdParam, (req, res) => {
  try {
    ok(res, domain.sitesForLead(req.auth.workspaceId, Number(req.params.leadId)));
  } catch (e) {
    fail(res, e);
  }
});
router.post('/websites/render', denyLeadScopedToken, (req, res) => {
  try {
    ok(res, domain.sitesRenderHtml(req.auth.workspaceId, null, req.body || {}));
  } catch (e) {
    fail(res, e);
  }
});
router.put('/websites/:id', scopeWebsite, (req, res) => {
  try {
    ok(res, domain.sitesSave(req.auth.workspaceId, Number(req.params.id), req.body || {}));
  } catch (e) {
    fail(res, e);
  }
});
router.post('/websites/:id/structure', scopeWebsite, (req, res) => {
  try {
    ok(res, domain.sitesReorderStructure(req.auth.workspaceId, Number(req.params.id), req.body || {}));
  } catch (e) {
    fail(res, e);
  }
});
router.get('/websites/:id/structure', scopeWebsite, (req, res) => {
  try {
    ok(res, domain.sitesGetStructure(req.auth.workspaceId, Number(req.params.id)));
  } catch (e) {
    fail(res, e);
  }
});
router.post('/websites/:id/render', scopeWebsite, (req, res) => {
  try {
    ok(res, domain.sitesRenderHtml(req.auth.workspaceId, Number(req.params.id), req.body || {}));
  } catch (e) {
    fail(res, e);
  }
});
router.get('/websites/:id/screenshots', scopeWebsite, async (req, res) => {
  try {
    ok(
      res,
      await domain.sitesScreenshotsList(req.auth.workspaceId, {
        websiteId: Number(req.params.id),
        currentOnly: req.query.current !== '0',
        checkReady: req.query.ready === '1',
        kind: req.query.kind || undefined,
      })
    );
  } catch (e) {
    fail(res, e);
  }
});
router.get('/screenshots', denyLeadScopedToken, async (req, res) => {
  try {
    ok(
      res,
      await domain.sitesScreenshotsList(req.auth.workspaceId, {
        websiteId: req.query.websiteId ? Number(req.query.websiteId) : undefined,
        leadId: req.query.leadId ? Number(req.query.leadId) : undefined,
        currentOnly: req.query.current !== '0',
        checkReady: req.query.ready === '1',
        kind: req.query.kind || undefined,
      })
    );
  } catch (e) {
    fail(res, e);
  }
});
router.post('/websites/:id/screenshots/capture', scopeWebsite, async (req, res) => {
  try {
    ok(
      res,
      await domain.sitesScreenshotsCapture(
        req.auth.workspaceId,
        Number(req.params.id),
        Object.assign({}, req.body || {}, { forcePreview: !!(req.body && req.body.forcePreview) })
      )
    );
  } catch (e) {
    fail(res, e, 500);
  }
});
router.post('/websites/:id/preview', scopeWebsite, async (req, res) => {
  try {
    ok(res, await domain.sitesPreview(req.auth.workspaceId, Number(req.params.id), req.body || {}));
  } catch (e) {
    fail(res, e, e.code === 'PREVIEW_NOT_CONFIGURED' ? 400 : 500);
  }
});
// Batch 155: staff-side standalone backup download (same archive the
// portal endpoint serves; the portal is the client-facing surface,
// this covers staff/support generating one on a client's behalf).
// Unreachable in single-site mode — the whole catch-all router is
// unmounted there (server/singleSite.js census).
router.post('/websites/:id/standalone-backup', scopeWebsite, async (req, res) => {
  try {
    await require('../standaloneBackup').sendBackupArchive(res, {
      workspaceId: req.auth.workspaceId,
      websiteId: Number(req.params.id),
    });
  } catch (e) {
    if (!res.headersSent) fail(res, e, (e && e.status) || 500);
  }
});
// Batch 156: site fingerprint — this site's two halves plus every
// similarity pair it participates in (report mode; spec §4a).
router.get('/websites/:id/fingerprint', scopeWebsite, async (req, res) => {
  try {
    ok(res, await domain.siteFingerprintGet(req.auth.workspaceId, Number(req.params.id)));
  } catch (e) {
    fail(res, e);
  }
});
// Batch 156: the platform-wide fingerprint ledger + similarity report.
// Super-admin only: the ledger spans every client's sites by design.
router.get('/fingerprints', requireSuperAdmin, async (req, res) => {
  try {
    ok(res, await domain.sitesFingerprintLedger());
  } catch (e) {
    fail(res, e);
  }
});
router.get('/websites/:id', scopeWebsite, (req, res) => {
  try {
    ok(res, { site: domain.sitesGet(req.auth.workspaceId, Number(req.params.id)) });
  } catch (e) {
    fail(res, e);
  }
});
router.delete('/websites/:id', requireRole('owner', 'admin'), scopeWebsite, (req, res) => {
  try {
    ok(res, domain.sitesDelete(req.auth.workspaceId, Number(req.params.id)));
  } catch (e) {
    fail(res, e);
  }
});
// Batch 27: restore an archived (soft-deleted) website.
router.post('/websites/:id/restore', scopeWebsite, (req, res) => {
  try {
    ok(res, domain.sitesRestoreSite(req.auth.workspaceId, Number(req.params.id)));
  } catch (e) {
    fail(res, e);
  }
});
// Batch 45: PERMANENT purge of an archived website (staff only; the body
// must carry the exact site name — type-to-confirm enforced server-side).
router.delete('/websites/:id/purge', requireRole('owner', 'admin'), denyLeadScopedToken, async (req, res) => {
  try {
    ok(
      res,
      await domain.sitesPurgeSite(req.auth.workspaceId, Number(req.params.id), (req.body || {}).confirmName)
    );
  } catch (e) {
    fail(res, e, e.status || (e.code === 'SITE_NOT_FOUND' ? 404 : 400));
  }
});
router.post('/websites/generate', pinTokenLeadFilter, scopeBodyLead, async (req, res) => {
  try {
    ok(res, await domain.sitesGenerate(req.auth.workspaceId, Number(req.body.leadId), req.body || {}));
  } catch (e) {
    fail(res, e, 500);
  }
});
router.post('/websites/:id/qa', scopeWebsite, async (req, res) => {
  try {
    ok(res, await domain.sitesQa(req.auth.workspaceId, Number(req.params.id)));
  } catch (e) {
    fail(res, e, 500);
  }
});
router.post('/websites/:id/export', scopeWebsite, async (req, res) => {
  try {
    ok(res, await domain.sitesExport(req.auth.workspaceId, Number(req.params.id)));
  } catch (e) {
    fail(res, e);
  }
});
router.get('/websites/:id/export-zip', scopeWebsite, async (req, res) => {
  try {
    const zipped = await domain.sitesExportZip(req.auth.workspaceId, Number(req.params.id));
    const safeName = String(zipped.filename || 'website.zip').replace(/[^\w.\-]+/g, '_');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    res.setHeader('Content-Length', String(zipped.buffer.length));
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).end(zipped.buffer);
  } catch (e) {
    fail(res, e, 500);
  }
});
router.post('/websites/:id/export-zip', scopeWebsite, async (req, res) => {
  try {
    const zipped = await domain.sitesExportZip(req.auth.workspaceId, Number(req.params.id));
    const safeName = String(zipped.filename || 'website.zip').replace(/[^\w.\-]+/g, '_');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    res.setHeader('Content-Length', String(zipped.buffer.length));
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).end(zipped.buffer);
  } catch (e) {
    fail(res, e, 500);
  }
});
/** Site + claim URLs with QR data-URLs (JSON). Works while automation is paused. */
router.get('/websites/:id/claim-kit', scopeWebsite, async (req, res) => {
  try {
    ok(res, await domain.sitesClaimKit(req.auth.workspaceId, Number(req.params.id)));
  } catch (e) {
    fail(res, e, 500);
  }
});
/** Postcard PDF (4×6) with site + claim QRs. */
router.get('/websites/:id/postcard', scopeWebsite, async (req, res) => {
  try {
    const kit = await domain.sitesPostcard(req.auth.workspaceId, Number(req.params.id));
    const safeName = String(kit.filename || 'bitpype-postcard.pdf').replace(/[^\w.\-]+/g, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    res.setHeader('Content-Length', String(kit.pdf.length));
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).end(kit.pdf);
  } catch (e) {
    fail(res, e, 500);
  }
});
/** Business card PDF (3.5×2, Batch 157) — name, stored address, logo, one site QR. */
router.get('/websites/:id/business-card', scopeWebsite, async (req, res) => {
  try {
    const card = await domain.sitesBusinessCard(req.auth.workspaceId, Number(req.params.id));
    const safeName = String(card.filename || 'bitpype-businesscard.pdf').replace(/[^\w.\-]+/g, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    res.setHeader('Content-Length', String(card.pdf.length));
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).end(card.pdf);
  } catch (e) {
    fail(res, e, 500);
  }
});
/** Business card PDF by lead (Batch 157) — mirrors the website route. */
router.get('/leads/:id/business-card', scopeLeadParam, async (req, res) => {
  try {
    const card = await domain.leadsBusinessCard(req.auth.workspaceId, Number(req.params.id));
    const safeName = String(card.filename || 'bitpype-businesscard.pdf').replace(/[^\w.\-]+/g, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    res.setHeader('Content-Length', String(card.pdf.length));
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).end(card.pdf);
  } catch (e) {
    fail(res, e, 500);
  }
});
router.post('/websites/:id/optimize-images', scopeWebsite, async (req, res) => {
  try {
    ok(res, await domain.sitesOptimizeImages(req.auth.workspaceId, Number(req.params.id), req.body || {}));
  } catch (e) {
    fail(res, e, 500);
  }
});
router.post('/websites/:id/images', scopeWebsite, async (req, res) => {
  try {
    ok(res, await domain.sitesAddImages(req.auth.workspaceId, Number(req.params.id), req.body || {}));
  } catch (e) {
    fail(res, e, 500);
  }
});
router.post('/websites/:id/logo', scopeWebsite, async (req, res) => {
  try {
    const body = req.body || {};
    const mode = String(body.mode || (body.data ? 'image' : 'text')).toLowerCase();
    if (mode === 'text') {
      ok(
        res,
        await domain.sitesSetLogo(req.auth.workspaceId, Number(req.params.id), {
          mode: 'text',
          brandName: body.brandName,
          note: 'Staff logo → text',
        })
      );
      return;
    }
    const dataB64 = String(body.data || body.base64 || '')
      .replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '')
      .replace(/\s+/g, '');
    if (!dataB64) {
      const e = new Error('data (base64 image) is required for image logos');
      e.code = 'EMPTY';
      throw e;
    }
    ok(
      res,
      await domain.sitesSetLogo(req.auth.workspaceId, Number(req.params.id), {
        mode: 'image',
        buffer: Buffer.from(dataB64, 'base64'),
        brandName: body.brandName,
        note: 'Staff logo upload',
      })
    );
  } catch (e) {
    fail(res, e, 500);
  }
});
router.get('/websites/:id/versions', scopeWebsite, (req, res) => {
  try {
    ok(res, domain.sitesVersions(req.auth.workspaceId, Number(req.params.id), req.query));
  } catch (e) {
    fail(res, e);
  }
});
router.post('/websites/restore', denyLeadScopedToken, (req, res) => {
  try {
    ok(res, { site: domain.sitesRestore(req.auth.workspaceId, Number(req.body.versionId)) });
  } catch (e) {
    fail(res, e);
  }
});

// Outreach
router.get('/campaigns', denyLeadScopedToken, (req, res) => {
  try {
    ok(res, domain.campaignsList(req.auth.workspaceId, req.query));
  } catch (e) {
    fail(res, e);
  }
});
router.post('/campaigns', denyLeadScopedToken, (req, res) => {
  try {
    ok(res, domain.campaignsCreate(req.auth.workspaceId, req.body || {}));
  } catch (e) {
    fail(res, e);
  }
});
router.post('/campaigns/:id/status', denyLeadScopedToken, (req, res) => {
  try {
    ok(res, domain.campaignsSetStatus(req.auth.workspaceId, Number(req.params.id), req.body.status));
  } catch (e) {
    fail(res, e);
  }
});
router.post('/campaigns/:id/cancel', denyLeadScopedToken, (req, res) => {
  try {
    ok(res, domain.campaignsCancel(req.auth.workspaceId, Number(req.params.id)));
  } catch (e) {
    fail(res, e);
  }
});
router.delete('/campaigns/:id', requireRole('owner', 'admin'), denyLeadScopedToken, (req, res) => {
  try {
    ok(res, domain.campaignsDelete(req.auth.workspaceId, Number(req.params.id)));
  } catch (e) {
    fail(res, e);
  }
});
router.get('/campaigns/:id/messages', denyLeadScopedToken, (req, res) => {
  try {
    ok(res, domain.campaignsMessages(req.auth.workspaceId, Number(req.params.id), req.query));
  } catch (e) {
    fail(res, e);
  }
});
router.get('/templates', denyLeadScopedToken, (req, res) => {
  try {
    ok(res, { templates: domain.templatesList(req.auth.workspaceId, req.query || {}) });
  } catch (e) {
    fail(res, e);
  }
});
router.post('/templates', denyLeadScopedToken, (req, res) => {
  try {
    ok(res, domain.templatesSave(req.auth.workspaceId, req.body || {}));
  } catch (e) {
    fail(res, e);
  }
});
router.delete('/templates/:id', requireRole('owner', 'admin'), denyLeadScopedToken, (req, res) => {
  try {
    ok(res, domain.templatesDelete(req.auth.workspaceId, Number(req.params.id)));
  } catch (e) {
    fail(res, e);
  }
});
router.post('/outreach/process', requireRole('owner', 'admin'), async (req, res) => {
  try {
    ok(res, await domain.outreachProcessQueue(req.auth.workspaceId));
  } catch (e) {
    fail(res, e, 500);
  }
});
router.get('/outreach/stats', denyLeadScopedToken, (req, res) => {
  try {
    ok(res, domain.outreachStats(req.auth.workspaceId));
  } catch (e) {
    fail(res, e);
  }
});
router.get('/suppression', denyLeadScopedToken, (req, res) => {
  try {
    ok(res, domain.suppressionList(req.auth.workspaceId, req.query));
  } catch (e) {
    fail(res, e);
  }
});
router.post('/suppression', denyLeadScopedToken, (req, res) => {
  try {
    ok(res, domain.suppressionAdd(req.auth.workspaceId, req.body.email, req.body.reason));
  } catch (e) {
    fail(res, e);
  }
});
router.delete('/suppression/:id', requireRole('owner', 'admin'), denyLeadScopedToken, (req, res) => {
  try {
    ok(res, domain.suppressionRemove(req.auth.workspaceId, Number(req.params.id)));
  } catch (e) {
    fail(res, e);
  }
});
router.get('/pipeline', denyLeadScopedToken, (req, res) => {
  try {
    ok(res, domain.pipelineBoard(req.auth.workspaceId, req.query));
  } catch (e) {
    fail(res, e);
  }
});
router.get('/intent/:leadId', scopeLeadIdParam, (req, res) => {
  try {
    ok(res, domain.intentGet(req.auth.workspaceId, Number(req.params.leadId)));
  } catch (e) {
    fail(res, e);
  }
});
router.post('/intent/:leadId', scopeLeadIdParam, (req, res) => {
  try {
    ok(res, domain.intentRecord(req.auth.workspaceId, Number(req.params.leadId), req.body.event, req.body.note));
  } catch (e) {
    fail(res, e);
  }
});
/* Lead calling (Batch 162) — the pipeline Contact page. Session-only:
 * placing calls spends money on the workspace's Twilio account, so no
 * bearer token (lead-scoped or workspace) may use these routes. The
 * workspace comes from requireWorkspace, so a staff user can only
 * ever reach leads in a workspace they belong to. */
const outboundCalls = () => require('../outboundCalls'); // lazy accessor (Batch 162 finisher): VM-loading suites (idempotency) stub relative requires — a top-level require here breaks them, same fix as Batch 161's assistant requires
function staffActor(req) {
  const u = req.sessionUser || {};
  return {
    userId: req.auth && req.auth.userId != null ? Number(req.auth.userId) : null,
    role: (req.auth && req.auth.role) || '',
    name: String(u.name || u.full_name || u.email || 'Staff'),
  };
}
function sessionOnly(req, res, next) {
  if (!req.auth || req.auth.via !== 'session') {
    return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Staff session required' } });
  }
  return next();
}
router.get('/leads/:leadId/contact', sessionOnly, denyLeadScopedToken, async (req, res) => {
  try {
    ok(res, await outboundCalls().getContactData(req.auth.workspaceId, Number(req.params.leadId)));
  } catch (e) {
    fail(res, e);
  }
});
router.post('/leads/:leadId/contact/token', sessionOnly, denyLeadScopedToken, async (req, res) => {
  try {
    ok(res, await outboundCalls().mintSoftphoneToken(req.auth.workspaceId, staffActor(req).userId));
  } catch (e) {
    fail(res, e);
  }
});
router.post('/leads/:leadId/contact/start', sessionOnly, denyLeadScopedToken, (req, res) => {
  try {
    ok(res, outboundCalls().startOutboundCall(req.auth.workspaceId, Number(req.params.leadId), staffActor(req)));
  } catch (e) {
    fail(res, e);
  }
});
router.post('/leads/:leadId/contact/:callRef/dial', sessionOnly, denyLeadScopedToken, async (req, res) => {
  try {
    ok(res, await outboundCalls().dialLeadLeg(req.auth.workspaceId, Number(req.params.leadId), req.params.callRef));
  } catch (e) {
    fail(res, e);
  }
});
router.get('/leads/:leadId/contact/:callRef', sessionOnly, denyLeadScopedToken, (req, res) => {
  try {
    const call = outboundCalls().getOutboundCall(req.auth.workspaceId, Number(req.params.leadId), req.params.callRef);
    if (!call) return fail(res, Object.assign(new Error('Call not found'), { code: 'NOT_FOUND' }));
    ok(res, call);
  } catch (e) {
    fail(res, e);
  }
});
router.put('/leads/:leadId/contact/:callRef/transcript', sessionOnly, denyLeadScopedToken, (req, res) => {
  try {
    ok(
      res,
      outboundCalls().saveTranscriptEdit(
        req.auth.workspaceId,
        Number(req.params.leadId),
        req.params.callRef,
        req.body && req.body.text
      )
    );
  } catch (e) {
    fail(res, e);
  }
});
router.post('/leads/:leadId/contact/notes', sessionOnly, denyLeadScopedToken, (req, res) => {
  try {
    ok(res, outboundCalls().addNote(req.auth.workspaceId, Number(req.params.leadId), staffActor(req), req.body && req.body.body));
  } catch (e) {
    fail(res, e);
  }
});
router.patch('/leads/:leadId/contact/notes/:noteId', sessionOnly, denyLeadScopedToken, (req, res) => {
  try {
    ok(
      res,
      outboundCalls().editNote(
        req.auth.workspaceId,
        Number(req.params.leadId),
        Number(req.params.noteId),
        staffActor(req),
        req.body && req.body.body
      )
    );
  } catch (e) {
    fail(res, e);
  }
});
router.delete('/leads/:leadId/contact/notes/:noteId', sessionOnly, denyLeadScopedToken, (req, res) => {
  try {
    ok(
      res,
      outboundCalls().removeNote(req.auth.workspaceId, Number(req.params.leadId), Number(req.params.noteId), staffActor(req))
    );
  } catch (e) {
    fail(res, e);
  }
});
router.post('/email/compose', pinTokenLeadFilter, scopeBodyLead, (req, res) => {
  try {
    ok(
      res,
      domain.emailCompose(req.auth.workspaceId, req.body.leadId, req.body.templateId, {
        queue: !!req.body.queue,
        channel: req.body.channel,
      })
    );
  } catch (e) {
    fail(res, e);
  }
});
router.post('/email/send', requireRole('owner', 'admin'), async (req, res) => {
  try {
    ok(res, await domain.emailSend(req.auth.workspaceId, Number(req.body && req.body.messageId)));
  } catch (e) {
    fail(res, e, e.code === 'SEND_FAILED' ? 502 : 400);
  }
});
router.post('/sms/queue', pinTokenLeadFilter, (req, res) => {
  try {
    ok(res, domain.smsQueue(req.auth.workspaceId, req.body || {}));
  } catch (e) {
    fail(res, e);
  }
});
router.post('/email/draft', pinTokenLeadFilter, async (req, res) => {
  try {
    ok(res, await domain.emailDraft(req.auth.workspaceId, req.body || {}));
  } catch (e) {
    fail(
      res,
      e,
      e.code === 'AI_NOT_CONFIGURED' || e.code === 'AUTOMATION_PAUSED' || e.code === 'BUDGET_EXCEEDED' ? 400 : 500
    );
  }
});
router.post('/email/assets', denyLeadScopedToken, async (req, res) => {
  try {
    ok(res, await domain.emailUploadAsset(req.auth.workspaceId, req.body || {}));
  } catch (e) {
    fail(res, e);
  }
});

// Settings (workspace SQLite — same keys as desktop)
// Batch 62 (review E-3): the domain-registrant block is personal data
// (name, organisation, email, phone, street address) that token-driven
// jobs (lead hunting, site builds) never need. It is returned only to
// interactive sessions; token callers get every other setting (secrets
// stay masked by settingsGetAll either way). The MCP facade reads the
// engine directly and is unaffected.
router.get('/settings', denyLeadScopedToken, (req, res) => {
  try {
    const settings = domain.settingsGetAll(req.auth.workspaceId);
    if (req.auth && req.auth.via === 'token' && settings && typeof settings === 'object') {
      for (const k of Object.keys(settings)) {
        if (k.startsWith('domain.registrant_')) delete settings[k];
      }
    }
    ok(res, { settings });
  } catch (e) {
    fail(res, e);
  }
});
router.put('/settings', requireRole('owner', 'admin'), partners.denyPartnerSettings, (req, res) => {
  try {
    ok(res, domain.settingsSet(req.auth.workspaceId, req.body.key, req.body.value));
  } catch (e) {
    fail(res, e);
  }
});
router.put('/settings/secret', requireRole('owner', 'admin'), partners.denyPartnerSettings, (req, res) => {
  try {
    ok(res, domain.settingsSetSecret(req.auth.workspaceId, req.body.key, req.body.value));
  } catch (e) {
    fail(res, e);
  }
});
router.post('/settings/automation', requireRole('owner', 'admin'), partners.denyPartnerSettings, (req, res) => {
  try {
    ok(res, domain.automationSet(req.auth.workspaceId, !!(req.body && req.body.paused)));
  } catch (e) {
    fail(res, e);
  }
});
router.get('/prompts', denyLeadScopedToken, (req, res) => {
  try {
    ok(res, { prompts: domain.promptsList(req.auth.workspaceId) });
  } catch (e) {
    fail(res, e);
  }
});
router.put('/prompts/:key', requireRole('owner', 'admin'), partners.denyPartnerSettings, (req, res) => {
  try {
    ok(res, domain.promptsSave(req.auth.workspaceId, req.params.key, req.body.body));
  } catch (e) {
    fail(res, e);
  }
});
router.post('/prompts/:key/reset', requireRole('owner', 'admin'), partners.denyPartnerSettings, (req, res) => {
  try {
    ok(res, domain.promptsReset(req.auth.workspaceId, req.params.key));
  } catch (e) {
    fail(res, e);
  }
});
router.get('/activity', denyLeadScopedToken, (req, res) => {
  try {
    ok(res, domain.activityRecent(req.auth.workspaceId, req.query));
  } catch (e) {
    fail(res, e);
  }
});
router.get('/ai/usage', denyLeadScopedToken, (req, res) => {
  try {
    ok(res, domain.aiUsage(req.auth.workspaceId, Number(req.query.days) || 30));
  } catch (e) {
    fail(res, e);
  }
});
router.get('/ai/status', denyLeadScopedToken, (req, res) => {
  try {
    ok(res, domain.aiStatus(req.auth.workspaceId));
  } catch (e) {
    fail(res, e);
  }
});

// Cloudflare
router.get('/cloudflare', denyLeadScopedToken, (req, res) => {
  try {
    ok(res, domain.cfGetConfig(req.auth.workspaceId));
  } catch (e) {
    fail(res, e);
  }
});
router.put('/cloudflare', requireRole('owner', 'admin'), partners.denyPartnerSettings, (req, res) => {
  try {
    ok(res, domain.cfSaveConfig(req.auth.workspaceId, req.body || {}));
  } catch (e) {
    fail(res, e);
  }
});
router.post('/cloudflare/test', requireRole('owner', 'admin'), async (req, res) => {
  try {
    ok(res, await domain.cfTest(req.auth.workspaceId));
  } catch (e) {
    fail(res, e, 500);
  }
});
// Batch 48: test-send through the workspace's selected mail provider.
router.post('/settings/mail-test', requireRole('owner', 'admin'), partners.denyPartnerSettings, async (req, res) => {
  try {
    ok(res, await domain.mailTestSend(req.auth.workspaceId, req.body || {}));
  } catch (e) {
    fail(res, e, 500);
  }
});
router.post('/cloudflare/publish', requireRole('owner', 'admin'), async (req, res) => {
  try {
    ok(res, await domain.cfPublish(req.auth.workspaceId, Number(req.body.websiteId)));
  } catch (e) {
    fail(res, e, 500);
  }
});

// Domains — Cloudflare Registrar search/purchase + Pages custom-domain link
router.get('/domains', denyLeadScopedToken, (req, res) => {
  try {
    ok(
      res,
      domain.domainsList(req.auth.workspaceId, {
        websiteId: req.query.websiteId ? Number(req.query.websiteId) : undefined,
        leadId: req.query.leadId ? Number(req.query.leadId) : undefined,
        status: req.query.status || undefined,
      })
    );
  } catch (e) {
    fail(res, e);
  }
});
router.get('/domains/owned', denyLeadScopedToken, async (req, res) => {
  try {
    ok(res, await domain.domainsOwned(req.auth.workspaceId));
  } catch (e) {
    fail(res, e, 500);
  }
});
router.get('/domains/search', denyLeadScopedToken, async (req, res) => {
  try {
    ok(
      res,
      await domain.domainsSearch(req.auth.workspaceId, req.query.q || req.query.query, {
        leadId: req.query.leadId ? Number(req.query.leadId) : undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      })
    );
  } catch (e) {
    fail(res, e, 500);
  }
});
router.post('/domains/check', denyLeadScopedToken, async (req, res) => {
  try {
    const names = (req.body && (req.body.domains || req.body.names)) || [req.body && req.body.domain];
    ok(res, await domain.domainsCheck(req.auth.workspaceId, names));
  } catch (e) {
    fail(res, e, 500);
  }
});
router.post('/domains/register', requireRole('owner', 'admin', 'member'), denyLeadScopedToken, async (req, res) => {
  try {
    // Batch 80: partner purchase gate — a partner's registration
    // becomes an approval request; nothing is charged or registered.
    // Batch 102 (SEC-18): token callers gate on the workspace — the
    // userId gate silently no-oped for bearer tokens (Audit 2 §B-1).
    const gate = await partners.gatePurchaseForRequest({
      auth: req.auth,
      workspaceId: req.auth.workspaceId,
      actionKind: 'domain_register',
      payload: req.body || {},
    });
    if (gate) return res.status(202).json({ ok: true, data: gate });
    ok(res, await domain.domainsRegister(req.auth.workspaceId, req.body || {}));
  } catch (e) {
    fail(res, e, 500);
  }
});
router.get('/domains/:domain/status', denyLeadScopedToken, async (req, res) => {
  try {
    ok(res, await domain.domainsRegistrationStatus(req.auth.workspaceId, req.params.domain));
  } catch (e) {
    fail(res, e, 500);
  }
});
router.post('/domains/link', requireRole('owner', 'admin', 'member'), denyLeadScopedToken, async (req, res) => {
  try {
    ok(res, await domain.domainsLink(req.auth.workspaceId, req.body || {}));
  } catch (e) {
    fail(res, e, 500);
  }
});
router.post('/domains/unlink', requireRole('owner', 'admin', 'member'), denyLeadScopedToken, async (req, res) => {
  try {
    ok(res, await domain.domainsUnlink(req.auth.workspaceId, req.body || {}));
  } catch (e) {
    fail(res, e, 500);
  }
});

// Social — Facebook + Instagram (images optional)
router.get('/social/overview', denyLeadScopedToken, (req, res) => {
  try {
    ok(res, domain.socialOverview(req.auth.workspaceId));
  } catch (e) {
    fail(res, e);
  }
});
router.get('/social/accounts/:leadId', scopeLeadIdParam, (req, res) => {
  try {
    ok(res, domain.socialAccounts(req.auth.workspaceId, Number(req.params.leadId)));
  } catch (e) {
    fail(res, e);
  }
});
router.delete('/social/accounts/:id', requireRole('owner', 'admin', 'member'), scopeSocialAccount, (req, res) => {
  try {
    ok(res, domain.socialDisconnect(req.auth.workspaceId, Number(req.params.id)));
  } catch (e) {
    fail(res, e);
  }
});
router.get('/social/oauth/start', pinTokenLeadFilter, scopeQueryLead, (req, res) => {
  try {
    ok(res, domain.socialOauthStart(req.auth.workspaceId, Number(req.query.leadId), req.query.returnTo));
  } catch (e) {
    fail(res, e);
  }
});
router.get('/social/campaigns', pinTokenLeadFilter, (req, res) => {
  try {
    ok(
      res,
      domain.socialCampaigns(req.auth.workspaceId, { leadId: req.query.leadId ? Number(req.query.leadId) : null })
    );
  } catch (e) {
    fail(res, e);
  }
});
router.get('/social/campaigns/:id', scopeSocialCampaign, (req, res) => {
  try {
    ok(res, domain.socialCampaignGet(req.auth.workspaceId, Number(req.params.id)));
  } catch (e) {
    fail(res, e);
  }
});
router.post('/social/campaigns/generate', pinTokenLeadFilter, scopeBodyLead, async (req, res) => {
  try {
    ok(res, await domain.socialGenerateMonth(req.auth.workspaceId, req.body || {}));
  } catch (e) {
    fail(res, e, 500);
  }
});
router.post('/social/campaigns/:id/status', scopeSocialCampaign, (req, res) => {
  try {
    ok(res, domain.socialSetCampaignStatus(req.auth.workspaceId, Number(req.params.id), req.body && req.body.status));
  } catch (e) {
    fail(res, e);
  }
});
router.post('/social/campaigns/:id/send-week', scopeSocialCampaign, async (req, res) => {
  try {
    ok(res, await domain.socialSendWeekly(req.auth.workspaceId, Number(req.params.id), !!(req.body && req.body.force)));
  } catch (e) {
    fail(res, e, 500);
  }
});
router.patch('/social/posts/:id', scopeSocialPost, (req, res) => {
  try {
    ok(res, { post: domain.socialUpdatePost(req.auth.workspaceId, Number(req.params.id), req.body || {}) });
  } catch (e) {
    fail(res, e);
  }
});
router.post('/social/posts/approve', denyLeadScopedToken, (req, res) => {
  try {
    ok(res, domain.socialApproveAgency(req.auth.workspaceId, (req.body && req.body.postIds) || []));
  } catch (e) {
    fail(res, e);
  }
});
router.post('/social/posts/:id/publish', requireRole('owner', 'admin'), async (req, res) => {
  try {
    ok(res, await domain.socialPublishPost(req.auth.workspaceId, Number(req.params.id)));
  } catch (e) {
    fail(res, e, 500);
  }
});
router.post('/social/publish-due', requireRole('owner', 'admin'), async (req, res) => {
  try {
    ok(res, await domain.socialPublishDue(req.auth.workspaceId, req.body || {}));
  } catch (e) {
    fail(res, e, 500);
  }
});
router.post('/social/weekly-tick', requireRole('owner', 'admin'), async (req, res) => {
  try {
    ok(res, await domain.socialWeeklyTick(req.auth.workspaceId));
  } catch (e) {
    fail(res, e, 500);
  }
});

// ---------- Staff admin area (read-only workspace-wide views) ----------
router.get('/admin-area/forms', denyLeadScopedToken, (req, res) => {
  try {
    ok(res, domain.adminFormsList(req.auth.workspaceId));
  } catch (e) {
    fail(res, e, 500);
  }
});
router.get('/admin-area/forms/:id/submissions', requireRole('owner', 'admin'), denyLeadScopedToken, (req, res) => {
  try {
    ok(
      res,
      domain.adminFormSubmissions(req.auth.workspaceId, Number(req.params.id), {
        limit: req.query.limit,
        offset: req.query.offset,
      })
    );
  } catch (e) {
    fail(res, e);
  }
});
// Batch 45 — staff submission cleanup (spam/test), single + bulk.
router.post('/admin-area/forms/:id/submissions/delete-bulk', requireRole('owner', 'admin'), denyLeadScopedToken, (req, res) => {
  try {
    ok(
      res,
      domain.adminDeleteFormSubmissions(req.auth.workspaceId, Number(req.params.id), (req.body || {}).ids || [])
    );
  } catch (e) {
    fail(res, e, e.code === 'NOT_FOUND' ? 404 : 400);
  }
});
router.delete('/admin-area/forms/:id/submissions/:submissionId', requireRole('owner', 'admin'), denyLeadScopedToken, (req, res) => {
  try {
    ok(
      res,
      domain.adminDeleteFormSubmission(req.auth.workspaceId, Number(req.params.id), Number(req.params.submissionId))
    );
  } catch (e) {
    fail(res, e, e.code === 'NOT_FOUND' ? 404 : 400);
  }
});
// Batch 62 (review E-3): LeadScout contacts are visitor PII (names,
// emails, phones) — reads now require an owner/admin session, like the
// deletes below already did. Capture itself is engine-side (forms,
// bookings) and never used this route.
router.get('/admin-area/leadscout/contacts', requireRole('owner', 'admin'), denyLeadScopedToken, (req, res) => {
  try {
    ok(
      res,
      domain.adminLeadScoutContacts(req.auth.workspaceId, {
        q: req.query.q || '',
        limit: req.query.limit,
        offset: req.query.offset,
      })
    );
  } catch (e) {
    fail(res, e, 500);
  }
});
router.get('/admin-area/leadscout/contacts/:id', requireRole('owner', 'admin'), denyLeadScopedToken, (req, res) => {
  try {
    ok(res, domain.adminLeadScoutContact(req.auth.workspaceId, Number(req.params.id)));
  } catch (e) {
    fail(res, e);
  }
});
// Batch 45 — staff LeadScout cleanup: delete a contact (charged-event
// guard in the engine) + clear resolved capture failures.
router.delete('/admin-area/leadscout/contacts/:id', requireRole('owner', 'admin'), denyLeadScopedToken, (req, res) => {
  try {
    ok(res, domain.adminDeleteLeadScoutContact(req.auth.workspaceId, Number(req.params.id)));
  } catch (e) {
    fail(res, e, e.code === 'NOT_FOUND' ? 404 : e.status || 400);
  }
});
router.post('/admin-area/leadscout/failures/clear-resolved', requireRole('owner', 'admin'), denyLeadScopedToken, (req, res) => {
  try {
    ok(res, domain.adminClearLeadScoutResolved(req.auth.workspaceId));
  } catch (e) {
    fail(res, e, 500);
  }
});
// Batch 62 (review E-3): bookings carry customer names/phones —
// owner/admin session reads only, like the other admin-area PII.
router.get('/admin-area/bookings', requireRole('owner', 'admin'), denyLeadScopedToken, (req, res) => {
  try {
    ok(res, domain.adminBookingsOverview(req.auth.workspaceId, { limit: req.query.limit }));
  } catch (e) {
    fail(res, e, 500);
  }
});
// Batch 66 — staff per-record delete of one booking service. The
// engine refuses (409 SERVICE_HAS_UPCOMING) while upcoming
// appointments reference the service; past appointments keep a
// snapshotted name. Owner/admin session only, like the other
// admin-area deletes.
router.delete('/admin-area/bookings/services/:id', requireRole('owner', 'admin'), denyLeadScopedToken, (req, res) => {
  try {
    ok(
      res,
      domain.adminDeleteBookingService(req.auth.workspaceId, Number(req.query.leadId), Number(req.params.id))
    );
  } catch (e) {
    fail(res, e, e.code === 'NOT_FOUND' ? 404 : e.status || 400);
  }
});
// Batch 62 (review E-3): shop overview carries orders (customer PII +
// money) — owner/admin session reads only.
router.get('/admin-area/shop', requireRole('owner', 'admin'), denyLeadScopedToken, (req, res) => {
  try {
    ok(res, domain.adminShopOverview(req.auth.workspaceId, { limit: req.query.limit }));
  } catch (e) {
    fail(res, e, 500);
  }
});
router.get('/admin-area/courses', denyLeadScopedToken, (req, res) => {
  try {
    ok(res, domain.adminCoursesList(req.auth.workspaceId));
  } catch (e) {
    fail(res, e, 500);
  }
});
router.get('/admin-area/modules', denyLeadScopedToken, (req, res) => {
  try {
    ok(res, domain.adminModulesOverview(req.auth.workspaceId));
  } catch (e) {
    fail(res, e, 500);
  }
});
// Batch 66 — staff per-record delete of one module install (embed +
// its content/config; detach is the non-destructive sibling and is
// untouched). Owner/admin session only, like the other deletes.
router.delete(
  '/admin-area/modules/installs/:leadId/:type',
  requireRole('owner', 'admin'),
  denyLeadScopedToken,
  (req, res) => {
    try {
      ok(
        res,
        domain.adminDeleteModuleInstall(req.auth.workspaceId, Number(req.params.leadId), String(req.params.type || ''))
      );
    } catch (e) {
      fail(res, e, e.code === 'NOT_FOUND' ? 404 : e.status || 400);
    }
  }
);
router.get('/admin-area/analytics', denyLeadScopedToken, (req, res) => {
  try {
    ok(res, domain.adminAnalyticsOverview(req.auth.workspaceId));
  } catch (e) {
    fail(res, e, 500);
  }
});

// Membership oversight (Batch 17): local rollup + live payout reads per
// site whose owner connected their own Stripe keys. Payout reads are
// cached + failure-isolated in membershipStripe — a Stripe outage can
// never break this screen. View-only: no money moves from here.
router.get('/admin-area/memberships', requireRole('owner', 'admin'), denyLeadScopedToken, async (req, res) => {
  try {
    const data = domain.adminMembershipsOverview(req.auth.workspaceId);
    const membershipStripe = require('../membershipStripe');
    await domain.withDb(req.auth.workspaceId, async (db) => {
      for (const site of data.sites) {
        if (!site.keys_connected) continue;
        try {
          site.payout = await membershipStripe.getPayoutStatus(db, site.lead_id);
        } catch {
          site.payout = { ok: false, reason: 'unavailable', as_of: new Date().toISOString() };
        }
      }
    });
    ok(res, data);
  } catch (e) {
    fail(res, e, 500);
  }
});

// Batch 51 — clear-all (bulk delete) for staff list surfaces. Every
// route runs the surface's existing single-delete engine function per
// item (see domain.adminClearAll*); items the single delete refuses
// are skipped and reported. confirm must be the literal 'DELETE'
// (type-to-confirm, enforced in the facade as well as the UI).
const clearAllRoute = (path, fn) =>
  router.post(path, requireRole('owner', 'admin'), denyLeadScopedToken, (req, res) => {
    try {
      const b = req.body || {};
      ok(res, fn(req.auth.workspaceId, { leadId: b.leadId != null ? Number(b.leadId) : null, confirm: b.confirm }));
    } catch (e) {
      fail(res, e, e.code === 'CONFIRM_REQUIRED' || e.code === 'VALIDATION' ? 400 : e.status || 400);
    }
  });
clearAllRoute('/admin-area/forms/clear-all', domain.adminClearAllForms);
clearAllRoute('/admin-area/bookings/clear-all', domain.adminClearAllBookings);
clearAllRoute('/admin-area/leadscout/contacts/clear-all', domain.adminClearAllLeadScoutContacts);
clearAllRoute('/admin-area/memberships/clear-all', domain.adminClearAllMembers);
clearAllRoute('/admin-area/rentals/clear-all', domain.adminClearAllRentals);
clearAllRoute('/admin-area/modules/clear-all', domain.adminClearAllModules);
clearAllRoute('/admin-area/courses/clear-all', domain.adminClearAllCourses);
clearAllRoute('/admin-area/calls/clear-all', domain.adminClearAllCalls);

// Batch 72 — clear-all for Recent Activity (workspace activity_log).
// Same owner/admin + no-lead-scoped-token guard as the Batch 51
// clear-alls, but async: the clear's durable record is a PLATFORM audit
// entry (platform.audit — the admin.js pattern), never an activity_log
// row, so the emptied panel does not refill with its own clear entry.
// confirm must be the literal 'DELETE' (enforced in the facade too).
router.post('/admin-area/activity/clear-all', requireRole('owner', 'admin'), denyLeadScopedToken, async (req, res) => {
  try {
    const b = req.body || {};
    const out = domain.adminClearActivity(req.auth.workspaceId, { confirm: b.confirm });
    // Lazy require (the codebase idiom): a top-level platform import
    // here breaks the VM module-loader in idempotency-regressions,
    // which only mocks this router's original require set.
    await require('../platform').audit(
      req.auth.userId,
      'activity.clear',
      `workspaceId=${req.auth.workspaceId} deleted=${out.deleted}`
    );
    ok(res, out);
  } catch (e) {
    fail(res, e, e.code === 'CONFIRM_REQUIRED' || e.code === 'VALIDATION' ? 400 : e.status || 400);
  }
});

// Call Tracking (Batch 21): every call across the workspace's sites,
// plus the Twilio number shop. Dormant-safe — with no Twilio credentials
// (platform twilio.* or the workspace's sms.* — Batch 25b) the number
// endpoints report { configured: false }.
// Batch 62 (review E-3): call logs carry caller phone numbers and the
// tracking config — owner/admin session reads only.
router.get('/admin-area/calls', requireRole('owner', 'admin'), denyLeadScopedToken, async (req, res) => {
  try {
    const data = await domain.adminCallsOverview(req.auth.workspaceId, { limit: req.query.limit, offset: req.query.offset });
    data.twilio_configured = await require('../twilioClient').isConfigured({ workspaceId: req.auth.workspaceId });
    data.workspace_id = req.auth.workspaceId;
    ok(res, data);
  } catch (e) {
    fail(res, e, 500);
  }
});
// Batch 45 — staff delete of a clean call log (engine refuses counted/billed/charged).
router.delete('/admin-area/calls/:id', requireRole('owner', 'admin'), denyLeadScopedToken, (req, res) => {
  try {
    ok(res, domain.adminDeleteCallLog(req.auth.workspaceId, Number(req.params.id)));
  } catch (e) {
    fail(res, e, e.code === 'NOT_FOUND' ? 404 : e.status || 400);
  }
});
router.get('/admin-area/calls/numbers/available', requireRole('owner', 'admin'), denyLeadScopedToken, async (req, res) => {
  try {
    ok(res, await domain.adminSearchCallNumbers(req.auth.workspaceId, { areaCode: req.query.areaCode || '' }));
  } catch (e) {
    fail(res, e, 502);
  }
});
router.post(
  '/admin-area/calls/numbers/purchase',
  requireRole('owner', 'admin'),
  denyLeadScopedToken,
  async (req, res) => {
    try {
      // Batch 80: partner purchase gate (Twilio charges the platform).
      // Batch 102 (SEC-18): token callers gate on the workspace.
      const gate = await partners.gatePurchaseForRequest({
        auth: req.auth,
        workspaceId: req.auth.workspaceId,
        actionKind: 'call_number_purchase',
        payload: req.body || {},
      });
      if (gate) return res.status(202).json({ ok: true, data: gate });
      ok(res, await domain.adminPurchaseCallNumber(req.auth.workspaceId, req.body || {}));
    } catch (e) {
      fail(res, e, e.code === 'TWILIO_ERROR' ? 502 : e.code === 'PLAN_REQUIRED' ? 402 : e.status || 400);
    }
  }
);
// Call Tracking forwarding config (Batch 25c): ADMIN-ONLY. The client
// portal accepts just the client's phone number; tracking number,
// forwarding, recording and notify are saved here by staff.
router.put(
  '/admin-area/calls/config',
  requireRole('owner', 'admin'),
  denyLeadScopedToken,
  async (req, res) => {
    try {
      ok(res, await domain.adminSaveCallTrackingConfig(req.auth.workspaceId, req.body || {}));
    } catch (e) {
      fail(res, e, e.code === 'PLAN_REQUIRED' ? 402 : e.status || 400);
    }
  }
);
// Lead calling (Batch 162): the recording disclosure every outbound
// lead call speaks before bridging/recording. Workspace-level,
// owner/admin only; blank restores the default sentence. Recording
// itself is always on for these calls — there is no off switch here.
router.put(
  '/admin-area/calls/disclosure',
  requireRole('owner', 'admin'),
  denyLeadScopedToken,
  (req, res) => {
    try {
      ok(res, outboundCalls().setDisclosure(req.auth.workspaceId, req.body && req.body.text));
    } catch (e) {
      fail(res, e);
    }
  }
);
// Twilio number pool (Batch 26d): staff register numbers the account
// owns; forwarding setups claim them (primary or rotation) with
// exclusivity. Add verifies live ownership; remove is blocked while
// a setup uses the number.
router.get('/admin-area/calls/pool', requireRole('owner', 'admin'), denyLeadScopedToken, async (req, res) => {
  try {
    const data = domain.adminListNumberPool(req.auth.workspaceId);
    data.twilio_configured = await require('../twilioClient').isConfigured({ workspaceId: req.auth.workspaceId });
    ok(res, data);
  } catch (e) {
    fail(res, e, 500);
  }
});
router.post(
  '/admin-area/calls/pool',
  requireRole('owner', 'admin'),
  denyLeadScopedToken,
  async (req, res) => {
    try {
      ok(res, await domain.adminAddPoolNumber(req.auth.workspaceId, req.body || {}));
    } catch (e) {
      fail(res, e, e.code === 'TWILIO_ERROR' ? 502 : e.status || 400);
    }
  }
);
router.delete(
  '/admin-area/calls/pool/:id',
  requireRole('owner', 'admin'),
  denyLeadScopedToken,
  async (req, res) => {
    try {
      ok(res, domain.adminRemovePoolNumber(req.auth.workspaceId, { id: Number(req.params.id) }));
    } catch (e) {
      fail(res, e, e.status || 400);
    }
  }
);

// AI SEO tool (Batch 22): staff can generate/review/apply a local-SEO
// proposal for any site in the workspace. The same pending proposal is
// what the site owner sees in the portal. Dormant-safe — state reports
// configured:false until an AI key is set in Settings.
router.get('/admin-area/seo', denyLeadScopedToken, (req, res) => {
  try {
    ok(res, domain.seoListSites(req.auth.workspaceId));
  } catch (e) {
    fail(res, e, 500);
  }
});
router.get('/admin-area/seo/:websiteId', denyLeadScopedToken, (req, res) => {
  try {
    ok(res, domain.seoState(req.auth.workspaceId, Number(req.params.websiteId)));
  } catch (e) {
    fail(res, e, e.code === 'NOT_FOUND' ? 404 : 500);
  }
});
router.post(
  '/admin-area/seo/:websiteId/generate',
  requireRole('owner', 'admin'),
  denyLeadScopedToken,
  async (req, res) => {
    try {
      ok(res, await domain.seoGenerate(req.auth.workspaceId, Number(req.params.websiteId), 'staff'));
    } catch (e) {
      fail(res, e, e.code === 'AI_NOT_CONFIGURED' ? 403 : e.code === 'NOT_FOUND' ? 404 : e.status || 400);
    }
  }
);
router.post(
  '/admin-area/seo/:websiteId/apply',
  requireRole('owner', 'admin'),
  denyLeadScopedToken,
  (req, res) => {
    try {
      ok(res, domain.seoApply(req.auth.workspaceId, Number(req.params.websiteId), 'staff'));
    } catch (e) {
      fail(res, e, e.code === 'NOT_FOUND' ? 404 : e.status || 400);
    }
  }
);
// Batch 31 (I): per-site Google Search Console verification token.
router.post(
  '/admin-area/seo/:websiteId/gsc',
  requireRole('owner', 'admin'),
  denyLeadScopedToken,
  (req, res) => {
    try {
      ok(
        res,
        domain.seoSetGscToken(
          req.auth.workspaceId,
          Number(req.params.websiteId),
          (req.body || {}).token || (req.body || {}).gscToken || ''
        )
      );
    } catch (e) {
      fail(res, e, e.code === 'NOT_FOUND' ? 404 : e.status || 400);
    }
  }
);

// Site Rentals (Batch 26): staff rent a niche site to a tenant lead.
// Create can 409 with RENTAL_SITE_OCCUPIED (hard block) or
// RENTAL_CONFLICT (niche+town warning — resend with overrideConflict).
// Batch 62 (review E-3): rentals carry tenant + charge data —
// owner/admin session reads only.
router.get('/admin-area/rentals', requireRole('owner', 'admin'), denyLeadScopedToken, (req, res) => {
  try {
    ok(res, domain.rentalsScreen(req.auth.workspaceId));
  } catch (e) {
    fail(res, e, 500);
  }
});
router.get('/admin-area/rentals/:id', requireRole('owner', 'admin'), denyLeadScopedToken, (req, res) => {
  try {
    ok(res, domain.rentalsDetail(req.auth.workspaceId, Number(req.params.id)));
  } catch (e) {
    fail(res, e, e.code === 'NOT_FOUND' ? 404 : 500);
  }
});
router.post(
  '/admin-area/rentals',
  requireRole('owner', 'admin'),
  denyLeadScopedToken,
  async (req, res) => {
    try {
      ok(res, await domain.rentalsCreate(req.auth.workspaceId, req.body || {}, 'staff'));
    } catch (e) {
      if (e && e.code === 'RENTAL_CONFLICT') {
        return fail(res, e, 409);
      }
      fail(res, e, e.code === 'NOT_FOUND' ? 404 : e.code === 'RENTAL_SITE_OCCUPIED' ? 409 : e.status || 400);
    }
  }
);
router.post(
  '/admin-area/rentals/:id/end',
  requireRole('owner', 'admin'),
  denyLeadScopedToken,
  async (req, res) => {
    try {
      ok(res, await domain.rentalsEnd(req.auth.workspaceId, Number(req.params.id), (req.body || {}).reason || ''));
    } catch (e) {
      fail(res, e, e.code === 'NOT_FOUND' ? 404 : e.status || 400);
    }
  }
);
router.post(
  '/admin-area/rentals/:id/pause',
  requireRole('owner', 'admin'),
  denyLeadScopedToken,
  (req, res) => {
    try {
      ok(res, domain.rentalsPause(req.auth.workspaceId, Number(req.params.id)));
    } catch (e) {
      fail(res, e, e.code === 'NOT_FOUND' ? 404 : e.status || 400);
    }
  }
);
router.post(
  '/admin-area/rentals/:id/resume',
  requireRole('owner', 'admin'),
  denyLeadScopedToken,
  (req, res) => {
    try {
      ok(res, domain.rentalsResume(req.auth.workspaceId, Number(req.params.id)));
    } catch (e) {
      fail(res, e, e.code === 'NOT_FOUND' ? 404 : e.code === 'RENTAL_SITE_OCCUPIED' ? 409 : e.status || 400);
    }
  }
);
// Batch 65 — per-record rental delete (Rentals page row action). Same
// owner/admin + no-lead-token guard as every other admin delete; the
// engine refuses live rentals and any rental with money in flight.
router.delete('/admin-area/rentals/:id', requireRole('owner', 'admin'), denyLeadScopedToken, (req, res) => {
  try {
    const actor = (req.sessionUser && req.sessionUser.email) || '';
    ok(res, domain.adminDeleteRental(req.auth.workspaceId, Number(req.params.id), { actor }));
  } catch (e) {
    fail(res, e, e.code === 'NOT_FOUND' ? 404 : e.status || 400);
  }
});

// ---------- Domain purchase transactions (Batch 15) ----------
// Batch 62 (review E-3): transaction reads expose amounts + the
// billing user's identity — owner/admin session reads only.
router.get('/admin-area/domain-transactions', requireRole('owner', 'admin'), denyLeadScopedToken, (req, res) => {
  try {
    ok(res, domain.adminDomainTransactions(req.auth.workspaceId, { limit: req.query.limit, offset: req.query.offset }));
  } catch (e) {
    fail(res, e, 500);
  }
});
// Batch 45 — void a pending_payment/failed transaction (paid/live → 409 in the engine).
router.post('/admin-area/domain-transactions/:id/void', requireRole('owner', 'admin'), denyLeadScopedToken, (req, res) => {
  try {
    ok(res, domain.adminVoidDomainTransaction(req.auth.workspaceId, Number(req.params.id)));
  } catch (e) {
    fail(res, e, e.code === 'NOT_FOUND' ? 404 : e.status || 400);
  }
});
// Batch 51 — remove a voided/failed transaction (pending → void first;
// paid/registering/live → 409 in the engine, always).
router.delete('/admin-area/domain-transactions/:id', requireRole('owner', 'admin'), denyLeadScopedToken, (req, res) => {
  try {
    ok(res, domain.adminDeleteDomainTransaction(req.auth.workspaceId, Number(req.params.id)));
  } catch (e) {
    fail(res, e, e.code === 'NOT_FOUND' ? 404 : e.status || 400);
  }
});
router.get('/admin-area/domain-transactions/:id', requireRole('owner', 'admin'), denyLeadScopedToken, (req, res) => {
  try {
    ok(res, domain.adminDomainTransaction(req.auth.workspaceId, Number(req.params.id)));
  } catch (e) {
    fail(res, e);
  }
});
router.post(
  '/admin-area/domain-transactions/:id/complete',
  requireRole('owner', 'admin'),
  denyLeadScopedToken,
  async (req, res) => {
    try {
      // Batch 80: partner purchase gate — completing a paid domain
      // flow executes the registrar registration (platform spend).
      // Batch 102 (SEC-18): token callers gate on the workspace.
      const gate = await partners.gatePurchaseForRequest({
        auth: req.auth,
        workspaceId: req.auth.workspaceId,
        actionKind: 'domain_flow_complete',
        payload: { txnId: Number(req.params.id) },
      });
      if (gate) return res.status(202).json({ ok: true, data: gate });
      ok(res, await domain.domainFlowComplete(req.auth.workspaceId, Number(req.params.id)));
    } catch (e) {
      fail(res, e, 500);
    }
  }
);

// ---------- Finance dashboard (Batch 49) ----------
// Batch 62 (review E-3): the finance reads are staff money data — the
// workspace bearer token no longer reads them (its writes were already
// role-gated). Owner/admin SESSION only, via requireRole.
router.get('/admin-area/finance/summary', requireRole('owner', 'admin'), denyLeadScopedToken, (req, res) => {
  try {
    ok(res, domain.financeSummary(req.auth.workspaceId, req.query));
  } catch (e) {
    fail(res, e, e.code === 'INVALID' ? 422 : 500);
  }
});
router.get('/admin-area/finance/ledger', requireRole('owner', 'admin'), denyLeadScopedToken, (req, res) => {
  try {
    ok(res, domain.financeLedger(req.auth.workspaceId, req.query));
  } catch (e) {
    fail(res, e, e.code === 'INVALID' ? 422 : 500);
  }
});
router.get('/admin-area/finance/export.csv', requireRole('owner', 'admin'), denyLeadScopedToken, (req, res) => {
  try {
    const out = domain.financeCsv(req.auth.workspaceId, req.query);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
    res.send(out.csv);
  } catch (e) {
    fail(res, e, e.code === 'INVALID' ? 422 : 500);
  }
});
router.post('/admin-area/finance/expenses', requireRole('owner', 'admin'), denyLeadScopedToken, (req, res) => {
  try {
    ok(res, domain.financeAddExpense(req.auth.workspaceId, req.body || {}, req.auth.userId));
  } catch (e) {
    fail(res, e, e.code === 'INVALID' ? 422 : 400);
  }
});
// Batch 62 — per-workspace AI cost view: platform money visibility
// across tenants, so on top of the owner/admin session gate it is
// SUPER-ADMIN only. Read-only.
router.get('/admin-area/finance/ai-by-workspace', requireRole('owner', 'admin'), denyLeadScopedToken, async (req, res) => {
  try {
    if (!req.sessionUser || Number(req.sessionUser.is_super_admin) !== 1) {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN', code: 'SUPER_ADMIN_REQUIRED' });
    }
    ok(res, await domain.financeAiByWorkspace(req.query));
  } catch (e) {
    fail(res, e, e.code === 'INVALID' ? 422 : 500);
  }
});
router.delete(
  '/admin-area/finance/expenses/:id',
  requireRole('owner', 'admin'),
  denyLeadScopedToken,
  (req, res) => {
    try {
      ok(res, domain.financeDeleteExpense(req.auth.workspaceId, Number(req.params.id)));
    } catch (e) {
      fail(res, e, e.code === 'NOT_FOUND' ? 404 : 400);
    }
  }
);

// ---------------------------------------------------------------------------
// Batch 161 — the Assistant chat (staff/admin surface). Session-only
// (a lead-scoped MCP token never gets a general assistant); the
// conversation's lead is chosen by the staff member and validated
// inside their workspace, and tool execution is pinned to it. Staff
// usage is metered as internal platform cost (surface 'admin',
// margin 0, never billed) — see server/assistantChat.js.
// Lazy accessors (house pattern — suites VM-load route files with
// require stub maps; top-level relative requires here would
// resolve outside the routes directory there). The rate limiters
// are memoized behind middleware wrappers for the same reason.
const assistantChat = () => require('../assistantChat');
const assistantBilling = () => require('../assistantBilling');
let _assistantMsgLimit = null;
let _assistantUploadLimit = null;
const assistantMsgLimit = (req, res, next) => {
  if (!_assistantMsgLimit) _assistantMsgLimit = require('../rateLimit').rateLimit({ windowMs: 15 * 60 * 1000, max: 30 });
  return _assistantMsgLimit(req, res, next);
};
const assistantUploadLimit = (req, res, next) => {
  if (!_assistantUploadLimit) _assistantUploadLimit = require('../rateLimit').rateLimit({ windowMs: 15 * 60 * 1000, max: 40 });
  return _assistantUploadLimit(req, res, next);
};

function assistantStaffOnly(req, res, next) {
  if (!req.auth || req.auth.via !== 'session' || req.auth.userId == null) {
    return res.status(403).json({ ok: false, error: 'FORBIDDEN', code: 'FORBIDDEN' });
  }
  return next();
}

function staffLeadCheck(db, workspaceId, leadId) {
  if (leadId == null) return null;
  const row = db.prepare('SELECT id FROM leads WHERE id = ?').get(Number(leadId));
  if (!row) throw Object.assign(new Error('Lead not found in this workspace'), { code: 'NOT_FOUND' });
  return Number(leadId);
}

router.get('/assistant/conversations', assistantStaffOnly, (req, res) => {
  try {
    const data = domain.withDb(req.auth.workspaceId, (db) =>
      assistantChat().listConversations(db, { surface: 'admin', actorId: req.auth.userId })
    );
    ok(res, data);
  } catch (e) {
    fail(res, e);
  }
});

router.post('/assistant/conversations', assistantStaffOnly, (req, res) => {
  try {
    const data = domain.withDb(req.auth.workspaceId, (db) =>
      assistantChat().createConversation(db, {
        surface: 'admin',
        actorId: req.auth.userId,
        leadId: staffLeadCheck(db, req.auth.workspaceId, (req.body && req.body.leadId) ?? null),
        title: (req.body && req.body.title) || '',
      })
    );
    ok(res, data);
  } catch (e) {
    fail(res, e);
  }
});

router.get('/assistant/conversations/:id', assistantStaffOnly, (req, res) => {
  try {
    const data = domain.withDb(req.auth.workspaceId, (db) => {
      const conv = assistantChat().getConversation(db, {
        surface: 'admin',
        actorId: req.auth.userId,
        id: Number(req.params.id),
      });
      if (!conv) return null;
      return { conversation: conv, messages: assistantChat().listMessages(db, { conversationId: conv.id }) };
    });
    if (!data) return fail(res, Object.assign(new Error('Conversation not found'), { code: 'NOT_FOUND' }));
    ok(res, data);
  } catch (e) {
    fail(res, e);
  }
});

router.post('/assistant/conversations/:id/messages', assistantStaffOnly, assistantMsgLimit, async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (type, payload) => {
    try {
      res.write(`event: ${type}\ndata: ${JSON.stringify(payload || {})}\n\n`);
    } catch {
      /* client went away */
    }
  };
  try {
    const data = await assistantChat().runAssistantTurn({
      workspaceId: req.auth.workspaceId,
      surface: 'admin',
      actorId: req.auth.userId,
      conversationId: Number(req.params.id),
      message: (req.body && req.body.message) || '',
      attachmentIds: (req.body && req.body.attachmentIds) || [],
      onEvent: send,
    });
    send('done', data);
  } catch (e) {
    send('error', { error: e.message || 'Assistant failed', code: e.code || 'ERROR' });
  } finally {
    res.end();
  }
});

router.post('/assistant/attachments', assistantStaffOnly, assistantUploadLimit, (req, res) => {
  try {
    const body = req.body || {};
    const raw = String(body.data || '');
    const b64 = raw.includes(',') ? raw.slice(raw.indexOf(',') + 1) : raw;
    const buffer = Buffer.from(b64, 'base64');
    const data = domain.withDb(req.auth.workspaceId, (db) =>
      assistantChat().saveAttachment(db, {
        workspaceId: req.auth.workspaceId,
        surface: 'admin',
        actorId: req.auth.userId,
        leadId: staffLeadCheck(db, req.auth.workspaceId, body.leadId ?? null),
        conversationId: body.conversationId != null ? Number(body.conversationId) : null,
        buffer,
        originalName: body.name || 'file',
      })
    );
    ok(res, data);
  } catch (e) {
    fail(res, e);
  }
});

router.get('/assistant/attachments/:id', assistantStaffOnly, (req, res) => {
  try {
    const found = domain.withDb(req.auth.workspaceId, (db) =>
      assistantChat().readAttachment(db, { surface: 'admin', actorId: req.auth.userId, id: Number(req.params.id) })
    );
    if (!found) return fail(res, Object.assign(new Error('Attachment not found'), { code: 'NOT_FOUND' }));
    res.setHeader('Content-Type', found.mime);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('Content-Disposition', `inline; filename="${found.fileName}"`);
    return res.send(found.buffer);
  } catch (e) {
    return fail(res, e);
  }
});

router.get('/assistant/usage', assistantStaffOnly, (req, res) => {
  try {
    const month = String(req.query.month || assistantChat().monthKey()).slice(0, 7);
    const data = domain.withDb(req.auth.workspaceId, (db) => assistantChat().usageSummary(db, { month }));
    ok(res, data);
  } catch (e) {
    fail(res, e);
  }
});

router.post('/assistant/usage/rollup', assistantStaffOnly, requireRole('owner', 'admin'), async (req, res) => {
  try {
    const month = String((req.body && req.body.month) || assistantChat().monthKey()).slice(0, 7);
    const data = domain.withDb(req.auth.workspaceId, (db) => assistantBilling().computeRollup(db, month));
    ok(res, data);
  } catch (e) {
    fail(res, e);
  }
});

router.post('/assistant/usage/queue', assistantStaffOnly, requireRole('owner', 'admin'), async (req, res) => {
  try {
    const month = String((req.body && req.body.month) || assistantChat().monthKey()).slice(0, 7);
    ok(res, await assistantBilling().queueRollupForInvoice(req.auth.workspaceId, month));
  } catch (e) {
    fail(res, e);
  }
});

// ---------------------------------------------------------------------------
// Batch 171 — Themes section + Build wizard on the STAFF Assistant
// surface (Batch 169 shipped them portal-only; Ely asked for the
// staff app too). Same single source (server/themesRegistry.js),
// same wizard semantics and error contract as the portal routes in
// server/routes/portal.js — only the auth + workspace resolution
// differ, and both mirror the neighboring staff assistant handlers
// exactly: assistantStaffOnly (session-only) and
// domain.withDb(req.auth.workspaceId, ...) as in
// GET /assistant/conversations and GET /assistant/usage above.
const themesRegistry = () => require('../themesRegistry');

/** The wizard's error contract, identical to the portal's: unknown
 * lead 404, unknown theme / validation 400, duplicate lead email
 * 409 (the lead engine's DUPLICATE_EMAIL carries err.status 409;
 * this router's fail() would map the VALIDATION code to 422, so the
 * build route maps its coded errors explicitly). */
function themesBuildFail(res, e) {
  const code = e && e.code;
  if (code === 'NOT_FOUND') {
    return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: e.message } });
  }
  if (code === 'DUPLICATE_EMAIL') {
    return res
      .status(409)
      .json({ ok: false, error: { code: 'DUPLICATE_EMAIL', message: e.message, details: e.details } });
  }
  if (code === 'VALIDATION' || code === 'VALIDATION_ERROR') {
    return res.status(400).json({ ok: false, error: { code, message: e.message } });
  }
  return fail(res, e);
}

router.get('/assistant/themes', assistantStaffOnly, (req, res) => {
  try {
    ok(res, { categories: themesRegistry().publicCatalog() });
  } catch (e) {
    fail(res, e);
  }
});

router.get('/assistant/themes/leads', assistantStaffOnly, (req, res) => {
  try {
    const q = String(req.query.q || '').trim().slice(0, 80);
    const data = domain.withDb(req.auth.workspaceId, (db) => {
      const rows = q
        ? db
            .prepare(
              `SELECT id, business_name, category, city FROM leads
                WHERE business_name LIKE ? ESCAPE '\\' ORDER BY business_name ASC LIMIT 25`
            )
            .all(`%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`)
        : db
            .prepare(
              'SELECT id, business_name, category, city FROM leads ORDER BY business_name ASC LIMIT 25'
            )
            .all();
      return { leads: rows };
    });
    ok(res, data);
  } catch (e) {
    fail(res, e);
  }
});

router.post('/assistant/themes/build', assistantStaffOnly, (req, res) => {
  try {
    const body = req.body || {};
    const data = domain.withDb(req.auth.workspaceId, (db) =>
      themesRegistry().buildWithTheme(db, {
        themeId: body.themeId,
        leadId: body.leadId,
        newLead: body.newLead,
        businessName: body.businessName,
        siteShape: body.siteShape,
        pagesWanted: body.pagesWanted,
        brandNotes: body.brandNotes,
      })
    );
    ok(res, {
      jobId: data.job.id,
      status: data.job.status,
      leadId: data.leadId,
      themeId: data.theme.id,
      themeName: data.theme.name,
    });
  } catch (e) {
    themesBuildFail(res, e);
  }
});

// ---------------------------------------------------------------------------
// Batch 178 — Leads Router (staff). The Router's staff surfaces: the
// sweep review queue, the source registry, feed oversight, and the
// sweep console. The console only RECORDS sweep runs (platform option
// specific or ALL) — it never browses a social platform; the hunt
// runs in the Muse app and checks in through these records (spec
// §15). Ingestion rides the same engine path as the MCP family.
// ---------------------------------------------------------------------------
const routerEngine178 = () => require('../leadsRouter');
const routerGuard = [denyLeadScopedToken];
const routerWriteGuard = [requireRole('owner', 'admin'), denyLeadScopedToken];

router.get('/admin-area/router/overview', ...routerGuard, (req, res) => {
  try {
    ok(
      res,
      domain.withDb(req.auth.workspaceId, (db) => {
        const eng = routerEngine178();
        return {
          oversight: eng.oversight(db),
          hunting: eng.huntingStatus(db),
          activation: eng.activationChecklist(db),
          settings: eng.getSettings(db),
          platforms: eng.platformStates(db),
        };
      })
    );
  } catch (e) {
    fail(res, e, 500);
  }
});
router.get('/admin-area/router/leads', ...routerGuard, (req, res) => {
  try {
    ok(
      res,
      domain.withDb(req.auth.workspaceId, (db) =>
        routerEngine178().listLeads(db, {
          review_state: req.query.review_state || null,
          status: req.query.status || null,
          request_kind: req.query.request_kind || null,
          platform: req.query.platform || null,
          limit: req.query.limit,
        })
      )
    );
  } catch (e) {
    fail(res, e, 500);
  }
});
router.get('/admin-area/router/candidates', ...routerGuard, (req, res) => {
  try {
    ok(res, domain.withDb(req.auth.workspaceId, (db) => routerEngine178().listCandidates(db, { limit: req.query.limit })));
  } catch (e) {
    fail(res, e, 500);
  }
});
router.post('/admin-area/router/leads', ...routerWriteGuard, (req, res) => {
  try {
    ok(
      res,
      domain.withDb(req.auth.workspaceId, (db) =>
        routerEngine178().publishLead(db, req.body || {}, { publish: !!(req.body && req.body.publish) })
      )
    );
  } catch (e) {
    fail(res, e, e.code === 'NOT_FOUND' ? 404 : 400);
  }
});
router.post('/admin-area/router/leads/:id/review', ...routerWriteGuard, (req, res) => {
  try {
    ok(
      res,
      domain.withDb(req.auth.workspaceId, (db) =>
        routerEngine178().reviewLead(db, Number(req.params.id), req.body || {})
      )
    );
  } catch (e) {
    fail(res, e, e.code === 'NOT_FOUND' ? 404 : 400);
  }
});
router.post('/admin-area/router/leads/:id/remove', ...routerWriteGuard, (req, res) => {
  try {
    ok(res, domain.withDb(req.auth.workspaceId, (db) => routerEngine178().removeLead(db, Number(req.params.id))));
  } catch (e) {
    fail(res, e, e.code === 'NOT_FOUND' ? 404 : 400);
  }
});
router.post('/admin-area/router/leads/:id/mark-stale', ...routerWriteGuard, (req, res) => {
  try {
    ok(res, domain.withDb(req.auth.workspaceId, (db) => routerEngine178().markStale(db)));
  } catch (e) {
    fail(res, e, 500);
  }
});
router.get('/admin-area/router/sources', ...routerGuard, (req, res) => {
  try {
    ok(
      res,
      domain.withDb(req.auth.workspaceId, (db) => routerEngine178().listSources(db, { platform: req.query.platform || null }))
    );
  } catch (e) {
    fail(res, e, 500);
  }
});
router.put('/admin-area/router/sources/:id', ...routerWriteGuard, (req, res) => {
  try {
    ok(
      res,
      domain.withDb(req.auth.workspaceId, (db) => routerEngine178().updateSource(db, Number(req.params.id), req.body || {}))
    );
  } catch (e) {
    fail(res, e, e.code === 'NOT_FOUND' ? 404 : 400);
  }
});
router.get('/admin-area/router/sweeps', ...routerGuard, (req, res) => {
  try {
    ok(res, domain.withDb(req.auth.workspaceId, (db) => routerEngine178().listSweeps(db, { limit: req.query.limit })));
  } catch (e) {
    fail(res, e, 500);
  }
});
router.post('/admin-area/router/sweeps', ...routerWriteGuard, (req, res) => {
  try {
    ok(
      res,
      domain.withDb(req.auth.workspaceId, (db) =>
        routerEngine178().recordSweep(db, { ...(req.body || {}), run_by: (req.body && req.body.run_by) || 'staff-console' })
      )
    );
  } catch (e) {
    fail(res, e, e.code === 'NOT_FOUND' ? 404 : 400);
  }
});
router.put('/admin-area/router/settings', ...routerWriteGuard, (req, res) => {
  try {
    ok(res, domain.withDb(req.auth.workspaceId, (db) => routerEngine178().updateSettings(db, req.body || {})));
  } catch (e) {
    fail(res, e, 400);
  }
});
router.get('/admin-area/router/follows/:leadId', ...routerGuard, (req, res) => {
  try {
    ok(res, domain.withDb(req.auth.workspaceId, (db) => routerEngine178().listFollows(db, Number(req.params.leadId))));
  } catch (e) {
    fail(res, e, 500);
  }
});
router.post('/admin-area/router/follows/:leadId', ...routerWriteGuard, (req, res) => {
  try {
    ok(
      res,
      domain.withDb(req.auth.workspaceId, (db) =>
        routerEngine178().setFollow(db, Number(req.params.leadId), req.body || {})
      )
    );
  } catch (e) {
    fail(res, e, e.code === 'NOT_FOUND' ? 404 : 400);
  }
});

module.exports = router;
