'use strict';

/**
 * Batch 60 (renewals policy — Ely, 2026-10-29): domain renewal mode is
 * DERIVED from the site owner's subscription state and enforced at
 * Cloudflare Registrar.
 *
 *   - Owner subscribed (an owner/admin of the workspace holding an
 *     active paid subscription — billing.workspaceHasSubscription —
 *     or the domain transaction's billing user being subscribed):
 *     renewal mode 'auto', registrar auto_renew ON. Cloudflare charges
 *     the account's default payment method up to 30 days before expiry.
 *   - Owner NOT subscribed (canceled-and-ended, deleted, never
 *     subscribed, Free): renewal mode 'manual'. The domain is MARKED
 *     in admin ("Manual renewal only — owner not subscribed") and
 *     registrar auto_renew is forced OFF so it can never silently
 *     charge or renew. Renewal is then a manual dashboard action —
 *     Cloudflare's API has NO renew/extend endpoint ("Renewals are
 *     not yet available through the API", Registrar API docs), so
 *     requestManualRenewal records the intent, hands back the
 *     dashboard link, and the sweep observes the new expiry.
 *
 * Enforcement points: this reconcile (idempotent — a second pass over
 * an unchanged world makes zero registrar calls), the Stripe webhook
 * lifecycle hooks in billing.js (activation / renewal / reactivation
 * via invoice.paid + customer.subscription.*, with
 * customer.subscription.deleted the flip-to-manual point), an hourly
 * sweep ticker (startRenewalTicker, started from server.js), and an
 * explicit deploy-time/admin-triggered reconcileAll.
 *
 * How renewals worked BEFORE this module: they didn't. Registrations
 * were created without an auto_renew value, and Cloudflare's Create
 * Registration default is auto_renew=false; no app code read or wrote
 * renewal state after purchase (only display mappings existed).
 *
 * All Cloudflare HTTP lives in src/cfDomains.js (listRegistrations /
 * setRegistrationAutoRenew); everything here is injectable via deps
 * so tests run with ZERO live Cloudflare calls.
 */

const { query } = require('./db');

function fail(code, message, extra) {
  const e = new Error(message);
  e.code = code;
  if (extra && typeof extra === 'object') Object.assign(e, extra);
  return e;
}

function billing() {
  return require('./billing');
}

function cfDomains() {
  return require('../src/cfDomains');
}

function ensureRenewalSchema(db) {
  cfDomains().ensureTables(db);
}

/** Latest site_domains row per domain among the live statuses. */
function liveDomainRows(db) {
  ensureRenewalSchema(db);
  const rows = db
    .prepare(
      `SELECT * FROM site_domains WHERE status IN ('linked','registered') ORDER BY id DESC`
    )
    .all();
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = String(row.domain_name || '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

async function defaultWorkspaceSubscribed(workspaceId) {
  return billing().workspaceHasSubscription(workspaceId);
}

async function defaultDomainBillingUserSubscribed(db, row) {
  try {
    const txn = db
      .prepare(
        `SELECT billing_user_id FROM domain_transactions
         WHERE domain = ? AND billing_user_id IS NOT NULL
           AND status IN ('paid','registering','live')
         ORDER BY id DESC LIMIT 1`
      )
      .get(row.domain_name);
    if (!txn || !txn.billing_user_id) return false;
    const user = await billing().getUserBilling(txn.billing_user_id);
    return billing().isSubscribed(user);
  } catch {
    return false; // domain flow tables not present in every workspace
  }
}

/**
 * The mode for one domain: 'auto' while subscribed, else 'manual'.
 * deps.workspaceSubscribed may be pre-resolved by the caller (the
 * reconcile computes it once per workspace).
 */
async function deriveDomainMode(db, workspaceId, row, deps = {}) {
  let subscribed;
  if (typeof deps.workspaceSubscribedValue === 'boolean') {
    subscribed = deps.workspaceSubscribedValue;
  } else if (typeof deps.workspaceSubscribed === 'function') {
    subscribed = !!(await deps.workspaceSubscribed(workspaceId));
  } else {
    subscribed = !!(await defaultWorkspaceSubscribed(workspaceId));
  }
  if (!subscribed) {
    const viaTxn =
      typeof deps.domainBillingUserSubscribed === 'function'
        ? !!(await deps.domainBillingUserSubscribed(db, row))
        : !!(await defaultDomainBillingUserSubscribed(db, row));
    subscribed = viaTxn;
  }
  return subscribed ? 'auto' : 'manual';
}

function logActivity(db, message) {
  try {
    db.prepare('INSERT INTO activity_log (area, message) VALUES (?, ?)').run('domains', message);
  } catch {
    /* activity log is best-effort */
  }
}

/**
 * Reconcile one workspace DB: read the registrar state once, derive
 * each live domain's mode, PATCH auto_renew only on drift, and record
 * mode/expiry/state back onto site_domains. Idempotent.
 */
async function reconcileWorkspace(db, workspaceId, deps = {}) {
  ensureRenewalSchema(db);
  const rows = liveDomainRows(db);
  if (!rows.length) return { workspaceId, domains: [] };

  const listRegs = deps.listRegistrations || ((d) => cfDomains().listRegistrations(d));
  let regs;
  try {
    regs = await listRegs(db);
  } catch (e) {
    if (e && e.code === 'NOT_CONFIGURED') return { workspaceId, skipped: 'not_configured', domains: [] };
    const message = (e && e.message) || 'registrar list failed';
    for (const row of rows) {
      try {
        db.prepare(
          `UPDATE site_domains SET renewal_error = ?, renewal_checked_at = datetime('now') WHERE id = ?`
        ).run(message.slice(0, 300), row.id);
      } catch {
        /* */
      }
    }
    return { workspaceId, error: message, domains: [] };
  }
  const regMap = new Map();
  for (const d of (regs && regs.domains) || []) regMap.set(String(d.domain || '').toLowerCase(), d);

  const wsSubscribed =
    typeof deps.workspaceSubscribed === 'function'
      ? !!(await deps.workspaceSubscribed(workspaceId))
      : !!(await defaultWorkspaceSubscribed(workspaceId));
  const setAuto = deps.setRegistrationAutoRenew || ((d, name, val) => cfDomains().setRegistrationAutoRenew(d, name, val));

  const out = [];
  let changedCount = 0;
  for (const row of rows) {
    const domain = String(row.domain_name || '').toLowerCase();
    const reg = regMap.get(domain);
    if (!reg) {
      // Not registered on the Cloudflare account this workspace
      // resolves to (e.g. an externally-registered linked domain) —
      // renewal policy does not apply to it here.
      out.push({ domain, websiteId: row.website_id, leadId: row.lead_id, inRegistrar: false });
      continue;
    }
    const mode = await deriveDomainMode(db, workspaceId, row, { ...deps, workspaceSubscribedValue: wsSubscribed });
    const subscribed = mode === 'auto';
    const desiredAuto = subscribed;
    const observed = reg.autoRenew != null ? !!reg.autoRenew : null;
    let after = observed;
    let changed = false;
    let pending = false;
    let error = null;
    if (observed !== desiredAuto) {
      try {
        const res = await setAuto(db, domain, desiredAuto);
        after = res && res.autoRenew != null ? !!res.autoRenew : desiredAuto;
        pending = !!(res && res.pending);
        changed = true;
      } catch (e) {
        error = (e && e.message) || 'auto-renew update failed';
      }
    }

    // A previously requested manual renewal is observed complete when
    // the registrar expiry has moved past the recorded pre-renewal one.
    let renewalObserved = false;
    if (
      row.manual_renew_requested_at &&
      row.manual_renew_from_expiry &&
      reg.expiresAt &&
      String(reg.expiresAt) > String(row.manual_renew_from_expiry)
    ) {
      renewalObserved = true;
    }

    const storedAuto = row.renewal_auto_renew != null ? !!row.renewal_auto_renew : null;
    const dirty =
      row.renewal_mode !== mode ||
      (row.expires_at || null) !== (reg.expiresAt || null) ||
      storedAuto !== after ||
      (row.renewal_error || null) !== error ||
      renewalObserved;
    if (dirty) {
      db.prepare(
        `UPDATE site_domains
         SET renewal_mode = ?, expires_at = ?, renewal_auto_renew = ?,
             renewal_checked_at = datetime('now'), renewal_error = ?,
             manual_renew_requested_at = ?, manual_renew_from_expiry = ?
         WHERE id = ?`
      ).run(
        mode,
        reg.expiresAt || null,
        after == null ? null : after ? 1 : 0,
        error,
        renewalObserved ? null : row.manual_renew_requested_at || null,
        renewalObserved ? null : row.manual_renew_from_expiry || null,
        row.id
      );
    }
    if (renewalObserved) {
      logActivity(
        db,
        `Manual renewal observed for ${domain}: expiry extended to ${reg.expiresAt} (was ${row.manual_renew_from_expiry})`
      );
    }
    // Batch 63: lifecycle notices — a flip auto→manual (owner
    // unsubscribed) and a completed manual renewal each email the
    // owner. Optional via deps (wired by default in
    // reconcileWorkspaces); every call is best-effort and deduped
    // inside lifecycleComms, and a notifier failure never fails the
    // reconcile.
    if (typeof deps.notifyDomainEvent === 'function') {
      if (row.renewal_mode === 'auto' && mode === 'manual') {
        try {
          await deps.notifyDomainEvent(db, workspaceId, {
            type: 'flip',
            domain,
            expiresAt: reg.expiresAt || null,
            websiteId: row.website_id,
            leadId: row.lead_id,
          });
        } catch (e) {
          console.warn('[domainRenewals] flip notice:', e && e.message);
        }
      }
      if (renewalObserved) {
        try {
          await deps.notifyDomainEvent(db, workspaceId, {
            type: 'manual_renewed',
            domain,
            expiresAt: reg.expiresAt || null,
            prevExpiry: row.manual_renew_from_expiry || null,
            websiteId: row.website_id,
            leadId: row.lead_id,
          });
        } catch (e) {
          console.warn('[domainRenewals] renewal notice:', e && e.message);
        }
      }
    }
    if (changed) changedCount++;
    out.push({
      domain,
      websiteId: row.website_id,
      leadId: row.lead_id,
      inRegistrar: true,
      subscribed,
      mode,
      registrarAutoRenewBefore: observed,
      registrarAutoRenewAfter: after,
      changed,
      pending,
      expiresAt: reg.expiresAt || null,
      error,
    });
  }
  if (changedCount || out.some((d) => d.error)) {
    const bits = out
      .filter((d) => d.inRegistrar)
      .map(
        (d) =>
          `${d.domain}=${d.mode}${d.changed ? ` (auto_renew→${d.registrarAutoRenewAfter ? 'on' : 'off'})` : ''}${d.error ? ` ERROR ${d.error}` : ''}`
      );
    logActivity(db, `Domain renewal reconcile (workspace ${workspaceId}): ${bits.join('; ')}`);
  }
  return { workspaceId, source: regs && regs.source, domains: out };
}

async function reconcileWorkspaces(workspaceIds, deps = {}) {
  const openDb = deps.openDb || ((ws) => require('./workspaceDb').openWorkspaceDb(ws));
  // Batch 63: wire the lifecycle notifier by default (production
  // paths — ticker, webhooks, admin reconcile). Callers that inject
  // their own (tests) keep theirs; the lazy require keeps this module
  // loadable in sandboxes that never wire comms, and notifyDomainEvent
  // itself never throws.
  const effectiveDeps = { ...deps };
  if (typeof effectiveDeps.notifyDomainEvent !== 'function') {
    effectiveDeps.notifyDomainEvent = async (db, ws, event) => {
      try {
        await require('./lifecycleComms').notifyDomainEvent(db, ws, event, effectiveDeps);
      } catch (e) {
        console.warn('[domainRenewals] lifecycle notice:', e && e.message);
      }
    };
  }
  const workspaces = [];
  const domains = [];
  for (const ws of [...new Set((workspaceIds || []).map(Number).filter(Boolean))]) {
    let db;
    try {
      db = openDb(ws);
    } catch (e) {
      workspaces.push({ workspaceId: ws, error: (e && e.message) || 'open failed' });
      continue;
    }
    if (!db) continue;
    try {
      const res = await reconcileWorkspace(db, ws, effectiveDeps);
      workspaces.push(res);
      for (const d of res.domains || []) domains.push({ workspaceId: ws, ...d });
    } catch (e) {
      workspaces.push({ workspaceId: ws, error: (e && e.message) || 'reconcile failed' });
    }
  }
  return { workspaces, domains };
}

/** Reconcile every workspace on the platform (deploy sweep / ticker). */
async function reconcileAll(deps = {}) {
  let ids;
  if (typeof deps.listWorkspaceIds === 'function') {
    ids = await deps.listWorkspaceIds();
  } else {
    const rows = await query('SELECT id FROM workspaces ORDER BY id ASC');
    ids = (rows || []).map((r) => Number(r.id));
  }
  return reconcileWorkspaces(ids, deps);
}

/** Reconcile just the workspaces a user belongs to (lifecycle hooks). */
async function reconcileForUser(userId, deps = {}) {
  let ids;
  if (typeof deps.listUserWorkspaceIds === 'function') {
    ids = await deps.listUserWorkspaceIds(userId);
  } else {
    const rows = await query('SELECT workspace_id FROM workspace_members WHERE user_id = :uid', {
      uid: Number(userId),
    });
    ids = (rows || []).map((r) => Number(r.workspace_id));
  }
  const out = await reconcileWorkspaces(ids, deps);
  return { userId: Number(userId), ...out };
}

/**
 * Webhook entry point (billing.js): resolve the subscription's user
 * exactly like disableSitesForEndedSubscription does, apply the same
 * orphan guard, then reconcile that user's workspaces. Runs AFTER
 * syncSubscription, so the stored subscription state already reflects
 * the event: a cancel scheduled for period end keeps status 'active'
 * (mode stays 'auto' for the whole paid period), while
 * customer.subscription.deleted lands after the plan has cleared
 * (mode flips to 'manual').
 */
async function reconcileForSubscriptionEvent(subscription, eventType, deps = {}) {
  if (!subscription || !subscription.id) return { skipped: 'no_subscription' };
  const getUserBilling = deps.getUserBilling || ((id) => billing().getUserBilling(id));
  let user = null;
  const metaUid = Number((subscription.metadata && subscription.metadata.user_id) || 0);
  if (metaUid) user = await getUserBilling(metaUid);
  if (!user && subscription.customer) {
    const findByCustomer =
      deps.findUserByCustomer ||
      (async (cid) => {
        const rows = await query('SELECT id FROM users WHERE stripe_customer_id = :cid LIMIT 1', {
          cid: String(cid),
        });
        return rows && rows[0] ? getUserBilling(rows[0].id) : null;
      });
    user = await findByCustomer(subscription.customer);
  }
  if (!user) return { skipped: 'no_user' };
  // Orphan/duplicate guard (mirrors Batch 37): a deleted subscription
  // that is not the one the user currently tracks, while another
  // subscription is still active, is not their plan ending.
  if (
    eventType === 'customer.subscription.deleted' &&
    user.stripe_subscription_id &&
    String(user.stripe_subscription_id) !== String(subscription.id) &&
    billing().ACTIVE_STATUSES.has(String(user.subscription_status || ''))
  ) {
    return { skipped: 'other_subscription_tracked', userId: user.id };
  }
  const out = await reconcileForUser(user.id, deps);
  return { eventType, ...out };
}

/**
 * Admin action on a manual-mode domain: record the renewal intent.
 * Cloudflare's Registrar API cannot renew (dashboard only —
 * Manage domains → the domain → Registration → Renew/Extend Domain),
 * so this stores who asked and the pre-renewal expiry; the sweep
 * observes completion when the expiry moves. Super-admin gating is
 * at the route (server/routes/admin.js).
 */
async function requestManualRenewal(db, workspaceId, domainName, actorUserId, deps = {}) {
  const cf = cfDomains();
  const domain = cf.normalizeDomain(domainName);
  if (!domain) throw fail('INVALID', 'Invalid domain name.');
  ensureRenewalSchema(db);
  const row = db
    .prepare(
      `SELECT * FROM site_domains WHERE domain_name = ? AND status IN ('linked','registered') ORDER BY id DESC LIMIT 1`
    )
    .get(domain);
  if (!row) throw fail('NOT_FOUND', `No live domain ${domain} in this workspace`, { status: 404 });
  if (row.renewal_mode !== 'manual') {
    throw fail(
      'NOT_MANUAL_MODE',
      row.renewal_mode === 'auto'
        ? `${domain} is on automatic renewal (its owner is subscribed) — manual renewal does not apply.`
        : `${domain} has no renewal mode yet — run the renewal reconcile first.`,
      { status: 409 }
    );
  }
  const requestedAt = new Date().toISOString();
  db.prepare(
    `UPDATE site_domains SET manual_renew_requested_at = ?, manual_renew_requested_by = ?,
       manual_renew_from_expiry = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(requestedAt, actorUserId != null ? Number(actorUserId) : null, row.expires_at || null, row.id);
  logActivity(
    db,
    `Manual renewal requested for ${domain} by user #${actorUserId || '?'} (expiry before: ${row.expires_at || 'unknown'})`
  );
  let dashboardUrl = null;
  try {
    const c = await require('../src/cloudflare').resolveCfCredentials(db);
    if (c && c.accountId) dashboardUrl = `https://dash.cloudflare.com/${c.accountId}/domains/registrations`;
  } catch {
    /* link is a convenience only */
  }
  return {
    domain,
    renewalMode: 'manual',
    expiresAt: row.expires_at || null,
    requestedAt,
    dashboardUrl,
    instructions:
      'Cloudflare does not offer domain renewal through its API. Renew in the Cloudflare dashboard: Manage domains → ' +
      `${domain} → Registration → Renew/Extend Domain. The extended expiry is picked up automatically by the renewal sweep.`,
  };
}

/* ------------------------------ ticker ------------------------------ */

let sweepStarted = false;
function startRenewalTicker() {
  if (sweepStarted) return;
  sweepStarted = true;
  const ms = Math.max(60000, Number(process.env.DOMAIN_RENEWAL_SWEEP_MS || 3600000));
  const run = () =>
    reconcileAll().catch((e) => console.warn('[domainRenewals] sweep:', e && e.message));
  const first = setTimeout(run, Math.max(30000, Number(process.env.DOMAIN_RENEWAL_FIRST_SWEEP_MS || 180000)));
  if (first.unref) first.unref();
  const timer = setInterval(run, ms);
  if (timer.unref) timer.unref();
}

module.exports = {
  ensureRenewalSchema,
  liveDomainRows,
  deriveDomainMode,
  reconcileWorkspace,
  reconcileWorkspaces,
  reconcileAll,
  reconcileForUser,
  reconcileForSubscriptionEvent,
  requestManualRenewal,
  startRenewalTicker,
};
