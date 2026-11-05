'use strict';

/**
 * Batch 119 — subscription suspension for failed payment (Ely's order
 * 2026-11-02: "If user fails to pay monthly subscription suspend
 * account and send them email every week with link and instructions
 * to renew"; refinement the same day: "Suspended account means
 * website produces an error").
 *
 * Lifecycle:
 *   - TRIGGER (in billing.js webhook dispatch): Stripe's automatic
 *     retries are exhausted — the subscription lands on status
 *     'unpaid', or the final invoice.payment_failed arrives with
 *     next_payment_attempt null while the subscription still exists
 *     in a failed state. A first decline NEVER suspends: past_due
 *     with retries pending keeps full access (Batch 63 copy says
 *     exactly that). If the Stripe account is configured to cancel
 *     instead of marking unpaid, customer.subscription.deleted owns
 *     the account via the pre-existing Batch 37/63 termination path
 *     and no suspension episode opens.
 *   - SUSPEND: a subscription_suspensions row (status 'active') is
 *     the auditable episode record; the user's websites are gated at
 *     SERVE time (workspace-layer subscription_site_suspensions
 *     marker rows → HTTP 503 on the public site path + public module
 *     payloads). Site content is never archived, unlinked or touched,
 *     so restoration is instant and exact. Portal access narrows to
 *     the billing panel; product-API writes are blocked.
 *   - WEEKLY EMAIL: one renewal email per 7 days for as long as the
 *     episode stays active — the first at suspension, the rest from
 *     the lifecycle sweep. Exactly-once rides the lifecycle_comms
 *     claim table (refKey suspension_weekly:<episode>:<n>) plus the
 *     episode's own counter; sends go through the platform mail layer
 *     and are transactional only (renewal link + instructions).
 *   - RESTORE: payment success (invoice.paid, or the subscription
 *     returning to an active status after a Stripe-portal fix) ends
 *     the episode ('restored'), deletes the serve markers and stops
 *     the weekly emails. Deliberately distinct from cancellation:
 *     subscription.deleted marks the episode 'terminated' and the
 *     existing no-auto-reenable termination path owns the account.
 *
 * Isolation: every row, marker and email is keyed to ONE billing
 * user and the workspaces/sites that user owns (the Batch 37
 * resolution grain). Nothing here reads or writes another account's
 * state.
 */

const { query, driver } = require('./db');
const platform = require('./platform');
const plans = require('./plans');
const { invoiceSubscriptionId, invoiceSubscriptionMetadata } = require('./stripeShapes');

const WEEK_MS = 7 * 86400000;
const ACTIVE_SUB_STATUSES = new Set(['active', 'trialing', 'past_due']);
const USER_COLS =
  'id, email, name, status, is_super_admin, account_type, stripe_customer_id, stripe_subscription_id, subscription_status, subscription_price_id, billing_plan, current_period_end, deleted_at';

/* ------------------------------ DDL ------------------------------- */

async function ensureSuspensionTables(q) {
  const useQuery = q || query;
  if (driver() === 'sqlite') {
    await useQuery(
      `CREATE TABLE IF NOT EXISTS subscription_suspensions (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         user_id INTEGER NOT NULL,
         subscription_id TEXT,
         status TEXT NOT NULL DEFAULT 'active',
         reason TEXT NOT NULL DEFAULT 'payment_failed_unpaid',
         stripe_status TEXT,
         suspended_at TEXT NOT NULL DEFAULT (datetime('now')),
         restored_at TEXT,
         terminated_at TEXT,
         last_weekly_email_at TEXT,
         weekly_email_count INTEGER NOT NULL DEFAULT 0,
         created_at TEXT NOT NULL DEFAULT (datetime('now')),
         updated_at TEXT NOT NULL DEFAULT (datetime('now'))
       )`
    );
    await useQuery(
      `CREATE INDEX IF NOT EXISTS idx_suspensions_user_status ON subscription_suspensions (user_id, status)`
    );
    await useQuery(
      `CREATE TABLE IF NOT EXISTS subscription_suspension_workspaces (
         suspension_id INTEGER NOT NULL,
         workspace_id INTEGER NOT NULL,
         PRIMARY KEY (suspension_id, workspace_id)
       )`
    );
    return;
  }
  await useQuery(
    `CREATE TABLE IF NOT EXISTS subscription_suspensions (
       id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
       user_id BIGINT UNSIGNED NOT NULL,
       subscription_id VARCHAR(120) NULL,
       status VARCHAR(16) NOT NULL DEFAULT 'active',
       reason VARCHAR(48) NOT NULL DEFAULT 'payment_failed_unpaid',
       stripe_status VARCHAR(32) NULL,
       suspended_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       restored_at DATETIME NULL,
       terminated_at DATETIME NULL,
       last_weekly_email_at DATETIME NULL,
       weekly_email_count INT NOT NULL DEFAULT 0,
       created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       KEY idx_suspensions_user_status (user_id, status),
       KEY idx_suspensions_status (status, id)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
  await useQuery(
    `CREATE TABLE IF NOT EXISTS subscription_suspension_workspaces (
       suspension_id BIGINT UNSIGNED NOT NULL,
       workspace_id BIGINT UNSIGNED NOT NULL,
       PRIMARY KEY (suspension_id, workspace_id),
       KEY idx_suspension_ws (workspace_id, suspension_id)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
}

function ensureSiteSuspensionTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS subscription_site_suspensions (
    website_id INTEGER PRIMARY KEY,
    workspace_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    subscription_id TEXT,
    suspension_id INTEGER,
    suspended_at TEXT DEFAULT (datetime('now'))
  )`);
}

/* ---------------------------- helpers ----------------------------- */

function nowIso(deps = {}) {
  // SQL datetime format (UTC), NOT full ISO: MySQL DATETIME rejects
  // '2026-11-03T02:53:25.949Z' under strict mode (Batch 119 gate, MySQL leg).
  // Matches the codebase convention (billing.js, lifecycleComms.js, ...).
  return new Date(deps.now ? deps.now() : Date.now()).toISOString().slice(0, 19).replace('T', ' ');
}

function parseTime(value) {
  if (value == null || value === '') return NaN;
  const t = new Date(String(value).replace(' ', 'T')).getTime();
  return Number.isNaN(t) ? NaN : t;
}

async function userById(q, id) {
  if (!id) return null;
  const rows = await q(`SELECT ${USER_COLS} FROM users WHERE id = :id LIMIT 1`, { id: Number(id) });
  return rows[0] || null;
}

/** Resolve a Stripe subscription/invoice to a users-row id — metadata
 *  first, then customer, then the tracked subscription id (mirrors
 *  lifecycleComms.resolveUserId). */
async function resolveUserId(q, obj) {
  if (!obj) return null;
  // Batch 145 (external review F17): subscription metadata and the
  // subscription reference itself live under parent.* on modern
  // invoice shapes — resolve via the shared helpers.
  const subMeta = invoiceSubscriptionMetadata(obj);
  const meta = (obj.metadata && obj.metadata.user_id) || (subMeta && subMeta.user_id);
  if (meta && Number(meta)) return Number(meta);
  if (obj.customer) {
    const rows = await q('SELECT id FROM users WHERE stripe_customer_id = :cid LIMIT 1', {
      cid: String(obj.customer),
    });
    if (rows[0]) return rows[0].id;
  }
  const subId =
    invoiceSubscriptionId(obj) || (obj.id && String(obj.id).startsWith('sub_') ? obj.id : null);
  if (subId) {
    const rows = await q('SELECT id FROM users WHERE stripe_subscription_id = :sid LIMIT 1', { sid: subId });
    if (rows[0]) return rows[0].id;
  }
  return null;
}

async function getActiveSuspensionForUser(userId, deps = {}) {
  if (!userId) return null;
  const q = deps.query || query;
  await ensureSuspensionTables(q);
  const rows = await q(
    `SELECT * FROM subscription_suspensions
      WHERE user_id = :uid AND status = 'active'
      ORDER BY id DESC LIMIT 1`,
    { uid: Number(userId) }
  );
  return rows[0] || null;
}

async function getActiveSuspensionForWorkspace(workspaceId, deps = {}) {
  if (!workspaceId) return null;
  const q = deps.query || query;
  await ensureSuspensionTables(q);
  const rows = await q(
    `SELECT s.* FROM subscription_suspensions s
       JOIN subscription_suspension_workspaces w ON w.suspension_id = s.id
      WHERE w.workspace_id = :ws AND s.status = 'active'
      ORDER BY s.id DESC LIMIT 1`,
    { ws: Number(workspaceId) }
  );
  return rows[0] || null;
}

async function userIsSuspended(userId, deps = {}) {
  return !!(await getActiveSuspensionForUser(userId, deps));
}

async function memberWorkspaceIds(q, userId) {
  const rows = await q('SELECT workspace_id FROM workspace_members WHERE user_id = :uid', {
    uid: Number(userId),
  });
  return [...new Set((rows || []).map((r) => Number(r.workspace_id)).filter(Boolean))];
}

/* --------------------- serve-marker write/clear -------------------- */

function openWorkspaceDb(deps, workspaceId) {
  const openDb = deps.openDb || ((ws) => require('./workspaceDb').openWorkspaceDb(ws));
  return openDb(workspaceId);
}

/** Write the serve-time 503 markers for every site the user owns
 *  (Batch 37's resolveUserSites grain). Returns the marked sites. */
async function writeSiteMarkers(user, suspension, deps = {}) {
  const billing = require('./billing');
  const sites = await billing.resolveUserSites(user, deps);
  const marked = [];
  const byWorkspace = new Map();
  for (const entry of sites) {
    if (!byWorkspace.has(entry.workspaceId)) byWorkspace.set(entry.workspaceId, []);
    byWorkspace.get(entry.workspaceId).push(entry);
  }
  for (const [workspaceId, entries] of byWorkspace) {
    let db;
    try {
      db = openWorkspaceDb(deps, workspaceId);
    } catch (e) {
      console.warn('[suspension] marker openDb:', workspaceId, e.message);
      continue;
    }
    if (!db) continue;
    ensureSiteSuspensionTable(db);
    for (const { site } of entries) {
      db.prepare(
        `INSERT INTO subscription_site_suspensions
           (website_id, workspace_id, user_id, subscription_id, suspension_id)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(website_id) DO UPDATE SET
           workspace_id = excluded.workspace_id,
           user_id = excluded.user_id,
           subscription_id = excluded.subscription_id,
           suspension_id = excluded.suspension_id,
           suspended_at = datetime('now')`
      ).run(
        site.id,
        workspaceId,
        Number(user.id),
        suspension.subscription_id || null,
        suspension.id != null ? Number(suspension.id) : null
      );
      marked.push({ workspaceId, websiteId: site.id });
    }
  }
  return marked;
}

/** Delete this user's serve markers from every workspace they belong
 *  to (plus any workspace the episode recorded). Restoration is
 *  exact: markers are the ONLY site-level change a suspension makes. */
async function clearSiteMarkers(user, suspension, deps = {}) {
  const q = deps.query || query;
  const wsIds = new Set(await memberWorkspaceIds(q, user.id));
  if (suspension && suspension.id) {
    try {
      const rows = await q('SELECT workspace_id FROM subscription_suspension_workspaces WHERE suspension_id = :sid', {
        sid: Number(suspension.id),
      });
      for (const r of rows || []) wsIds.add(Number(r.workspace_id));
    } catch {
      /* link rows are bookkeeping; memberships carry the clear */
    }
  }
  let cleared = 0;
  for (const workspaceId of wsIds) {
    let db;
    try {
      db = openWorkspaceDb(deps, workspaceId);
    } catch {
      continue;
    }
    if (!db) continue;
    try {
      ensureSiteSuspensionTable(db);
      const res = db.prepare('DELETE FROM subscription_site_suspensions WHERE user_id = ?').run(Number(user.id));
      cleared += Number(res.changes || 0);
    } catch {
      /* workspace without the table — nothing was ever marked */
    }
  }
  return cleared;
}

function logWorkspaceActivity(deps, workspaceId, message) {
  try {
    const db = openWorkspaceDb(deps, workspaceId);
    if (!db) return;
    db.prepare('INSERT INTO activity_log (area, message) VALUES (?, ?)').run('billing', message);
  } catch {
    /* activity log is best-effort */
  }
}

/* --------------------------- weekly email -------------------------- */

function manageUrl(deps = {}) {
  let raw = '';
  try {
    raw = (deps.appUrl || (() => require('./stripeClient').appUrl()))() || '';
  } catch {
    raw = '';
  }
  return `${String(raw || '').replace(/\/$/, '')}/portal?panel=billing`;
}

async function planNameFor(user, subscription) {
  try {
    const billing = require('./billing');
    // This email is about the plan the customer is failing to pay for.
    // planOfUser / billing_plan report Free once the stored status has
    // flipped to unpaid (that is access semantics, by design), so
    // resolve the tier from the price on the failed subscription,
    // then from the price recorded on the account.
    const priceId =
      (subscription &&
        subscription.items &&
        subscription.items.data &&
        subscription.items.data[0] &&
        subscription.items.data[0].price &&
        subscription.items.data[0].price.id) ||
      (user && user.subscription_price_id) ||
      null;
    let planId = null;
    if (priceId) {
      const { planIdFromPriceId } = require('./stripeClient');
      planId = await planIdFromPriceId(priceId);
    }
    if (!planId || String(planId) === 'free') planId = billing.planOfUser(user);
    const p = plans.getPlan(planId);
    return (p && p.name) || 'Bitpype';
  } catch {
    return 'Bitpype';
  }
}

/**
 * Send the next weekly renewal email for an episode. Exactly-once:
 * the lifecycle claim key carries the episode id + send index, and
 * the episode counter only advances after a confirmed send (a failed
 * send releases the claim inside sendClaimed and the sweep retries).
 */
async function sendWeeklyRenewalEmail(suspension, user, deps = {}, subscription = null) {
  const q = deps.query || query;
  if (!suspension || !user || !String(user.email || '').trim()) {
    return { sent: false, reason: 'no_recipient' };
  }
  if (String(user.status || 'active') === 'disabled' || user.deleted_at) {
    return { sent: false, reason: 'user_disabled' };
  }
  const index = Number(suspension.weekly_email_count || 0) + 1;
  const name = await planNameFor(user, subscription);
  const first = index <= 1;
  const paragraphs = [
    first
      ? `We couldn't collect the payment for your ${name} plan, and our automatic retries have finished — so your Bitpype account is now suspended.`
      : `Your ${name} plan payment still hasn't gone through, so your Bitpype account is still suspended.`,
    'While your account is suspended, your website is unavailable: anyone who visits it sees an error instead of your site, and your account is limited to the billing page until you renew.',
    'To renew and bring your website back, open your billing page (button below) and update your payment method or pay the outstanding invoice. The moment your payment goes through, your suspension lifts automatically — your website comes back online exactly as it was, and these weekly reminders stop.',
    'If you would rather close the account, you can cancel from the same billing page instead — cancelling ends these reminders too.',
    'Questions about the charge? Just reply to this email.',
  ];
  const subject = first
    ? `Your Bitpype ${name} plan is suspended — renew to bring your website back`
    : `Your Bitpype ${name} plan is still suspended — renew to bring your website back`;
  const renewUrl = manageUrl(deps);
  const lifecycle = require('./lifecycleComms');
  const res = await lifecycle.sendClaimed(deps, {
    refKey: `suspension_weekly:${Number(suspension.id)}:${index}`,
    kind: 'suspension_weekly',
    userId: user.id,
    mail: {
      to: user.email,
      subject,
      title: subject,
      preheader: `Your ${name} plan is suspended and your website is unavailable until you renew.`,
      paragraphs,
      text: [...paragraphs, `Renew your plan: ${renewUrl}`].join('\n\n'),
      cta: { url: renewUrl, label: 'Renew your plan' },
      footerNote:
        "You're receiving this because a payment for your BitPype subscription didn't go through. One reminder a week while the account is suspended — they stop the moment you renew or cancel.",
    },
  });
  if (res && res.sent) {
    await q(
      `UPDATE subscription_suspensions
          SET weekly_email_count = :n, last_weekly_email_at = :at, updated_at = :at
        WHERE id = :id`,
      { n: index, at: nowIso(deps), id: Number(suspension.id) }
    );
    suspension.weekly_email_count = index;
    suspension.last_weekly_email_at = nowIso(deps);
  }
  return res;
}

/* ----------------------------- suspend ----------------------------- */

/**
 * Open a suspension episode for the user behind a Stripe
 * subscription. Idempotent: an already-active episode for the same
 * user + subscription is returned unchanged. Guards mirror Batch 37:
 * super admins are never suspended, disabled/deleted users are
 * skipped, and an event for a subscription the user no longer tracks
 * (orphan/duplicate) suspends nothing.
 */
async function suspendForSubscription(subscription, deps = {}) {
  const q = deps.query || query;
  if (!subscription || !subscription.id) return { suspended: false, reason: 'no_subscription' };
  await ensureSuspensionTables(q);
  const userId = await resolveUserId(q, subscription);
  const user = userId ? await userById(q, userId) : null;
  if (!user) return { suspended: false, reason: 'no_user' };
  if (Number(user.is_super_admin) === 1) return { suspended: false, reason: 'super_admin' };
  if (String(user.status || 'active') === 'disabled' || user.deleted_at) {
    return { suspended: false, reason: 'user_disabled' };
  }
  if (
    user.stripe_subscription_id &&
    String(user.stripe_subscription_id) !== String(subscription.id) &&
    ACTIVE_SUB_STATUSES.has(String(user.subscription_status || ''))
  ) {
    return { suspended: false, reason: 'other_subscription_tracked', userId: user.id };
  }

  const existing = await getActiveSuspensionForUser(user.id, deps);
  if (existing) {
    if (String(existing.subscription_id || '') === String(subscription.id)) {
      return { suspended: true, alreadyActive: true, suspension: existing, userId: user.id };
    }
    // A stale episode for a previous subscription: close it as
    // restored-by-supersession before opening the new one, so a user
    // never carries two active episodes.
    await q(
      `UPDATE subscription_suspensions SET status = 'restored', restored_at = :at, updated_at = :at WHERE id = :id`,
      { at: nowIso(deps), id: Number(existing.id) }
    );
  }

  const at = nowIso(deps);
  const inserted = await q(
    `INSERT INTO subscription_suspensions
       (user_id, subscription_id, status, reason, stripe_status, suspended_at, created_at, updated_at)
     VALUES (:uid, :sub, 'active', :reason, :stripeStatus, :at, :at, :at)`,
    {
      uid: Number(user.id),
      sub: String(subscription.id),
      reason: deps.reason || 'payment_failed_unpaid',
      stripeStatus: subscription.status || null,
      at,
    }
  );
  let suspension = null;
  if (inserted && inserted.insertId) {
    const rows = await q('SELECT * FROM subscription_suspensions WHERE id = :id LIMIT 1', {
      id: Number(inserted.insertId),
    });
    suspension = rows[0] || null;
  }
  if (!suspension) suspension = await getActiveSuspensionForUser(user.id, deps);
  if (!suspension) return { suspended: false, reason: 'insert_failed', userId: user.id };

  const workspaceIds = await memberWorkspaceIds(q, user.id);
  for (const ws of workspaceIds) {
    try {
      await q(
        `INSERT INTO subscription_suspension_workspaces (suspension_id, workspace_id)
         VALUES (:sid, :ws)`,
        { sid: Number(suspension.id), ws }
      );
    } catch (e) {
      if (!/unique|duplicate/i.test(String((e && e.message) || ''))) throw e;
    }
  }

  let marked = [];
  try {
    marked = await writeSiteMarkers(user, suspension, deps);
  } catch (e) {
    console.warn('[suspension] site markers:', e.message);
  }
  try {
    await platform.audit(
      user.id,
      'subscription.suspended',
      `sub ${subscription.id} (${subscription.status || 'unpaid'}) — ${marked.length} site(s) gated, workspaces ${workspaceIds.join(', ') || 'none'}`
    );
  } catch {
    /* audit is best-effort */
  }
  for (const ws of workspaceIds) {
    logWorkspaceActivity(
      deps,
      ws,
      `Account suspended (subscription payment failed, sub ${subscription.id}); ${marked.filter((m) => m.workspaceId === ws).length} website(s) now return an error until renewal.`
    );
  }

  // First weekly email goes out at suspension; a mail failure never
  // fails the caller (the claim releases and the sweep retries).
  let email = null;
  try {
    email = await sendWeeklyRenewalEmail(suspension, user, deps, subscription);
  } catch (e) {
    console.warn('[suspension] first weekly email:', e.message);
  }
  return { suspended: true, suspension, userId: user.id, sites: marked, email };
}

/* ----------------------------- restore ----------------------------- */

/**
 * End the user's active episode because payment succeeded (or staff
 * manually unsuspended). Clears the serve markers — sites return
 * exactly as they were — and stops the weekly emails. Returns the
 * closed episode, or null when the user was not suspended.
 */
async function restoreForUser(userId, deps = {}, opts = {}) {
  const q = deps.query || query;
  if (!userId) return null;
  await ensureSuspensionTables(q);
  const suspension = await getActiveSuspensionForUser(userId, deps);
  if (!suspension) return null;
  const user = await userById(q, userId);
  if (opts.subscriptionId && String(suspension.subscription_id || '') !== String(opts.subscriptionId)) {
    // The payment/event names a different subscription than the one
    // that suspended the account. Restore only when the user's tracked
    // subscription has moved on to a healthy one (they re-subscribed);
    // an unrelated still-failing subscription changes nothing. Staff
    // manual unsuspend passes force and skips this check entirely.
    const resubscribed =
      !!user &&
      String(user.stripe_subscription_id || '') !== String(suspension.subscription_id || '') &&
      (String(user.subscription_status || '') === 'active' || String(user.subscription_status || '') === 'trialing');
    if (!opts.force && !resubscribed) return null;
  }
  const at = nowIso(deps);
  await q(
    `UPDATE subscription_suspensions SET status = 'restored', restored_at = :at, updated_at = :at WHERE id = :id`,
    { at, id: Number(suspension.id) }
  );
  let cleared = 0;
  if (user) {
    try {
      cleared = await clearSiteMarkers(user, suspension, deps);
    } catch (e) {
      console.warn('[suspension] marker clear:', e.message);
    }
  }
  try {
    await platform.audit(
      Number(userId),
      'subscription.restored',
      `suspension #${suspension.id} closed (${opts.via || 'payment'}); ${cleared} site marker(s) cleared`
    );
  } catch {
    /* audit is best-effort */
  }
  if (user) {
    const workspaceIds = await memberWorkspaceIds(q, user.id);
    for (const ws of workspaceIds) {
      logWorkspaceActivity(deps, ws, 'Account suspension lifted — websites are live again.');
    }
  }
  return { ...suspension, status: 'restored', restored_at: at, clearedMarkers: cleared };
}

/* ---------------------------- terminate ---------------------------- */

/**
 * The subscription ended outright (customer.subscription.deleted):
 * close the episode as 'terminated' and clear the serve markers —
 * from here the pre-existing termination path (Batch 37 site
 * archive + notice) owns the account, and the weekly emails stop
 * permanently.
 */
async function terminateForSubscription(subscription, deps = {}) {
  const q = deps.query || query;
  if (!subscription || !subscription.id) return { terminated: false, reason: 'no_subscription' };
  await ensureSuspensionTables(q);
  const userId = await resolveUserId(q, subscription);
  if (!userId) return { terminated: false, reason: 'no_user' };
  const suspension = await getActiveSuspensionForUser(userId, deps);
  if (!suspension) return { terminated: false, reason: 'not_suspended', userId };
  if (String(suspension.subscription_id || '') !== String(subscription.id)) {
    return { terminated: false, reason: 'other_subscription', userId };
  }
  const user = await userById(q, userId);
  const at = nowIso(deps);
  await q(
    `UPDATE subscription_suspensions SET status = 'terminated', terminated_at = :at, updated_at = :at WHERE id = :id`,
    { at, id: Number(suspension.id) }
  );
  if (user) {
    try {
      await clearSiteMarkers(user, suspension, deps);
    } catch (e) {
      console.warn('[suspension] marker clear (terminate):', e.message);
    }
  }
  try {
    await platform.audit(
      Number(userId),
      'subscription.suspension_terminated',
      `suspension #${suspension.id} terminated with subscription ${subscription.id}`
    );
  } catch {
    /* audit is best-effort */
  }
  return { terminated: true, suspensionId: Number(suspension.id), userId };
}

/* --------------------- webhook-facing restores --------------------- */

/** A subscription event (updated back to active/trialing after a
 *  Stripe-portal card fix) restores the episode it belongs to. */
async function restoreForSubscriptionEvent(subscription, deps = {}) {
  const q = deps.query || query;
  if (!subscription || !subscription.id) return null;
  const userId = await resolveUserId(q, subscription);
  if (!userId) return null;
  return restoreForUser(userId, deps, { subscriptionId: String(subscription.id), via: 'subscription_active' });
}

/** A paid invoice restores the episode of the user who paid. */
async function restoreForInvoice(invoice, deps = {}) {
  const q = deps.query || query;
  if (!invoice) return null;
  const userId = await resolveUserId(q, invoice);
  if (!userId) return null;
  const subId = invoiceSubscriptionId(invoice);
  return restoreForUser(userId, deps, {
    ...(subId ? { subscriptionId: String(subId) } : {}),
    via: 'invoice_paid',
  });
}

/* ------------------------- portal resolution ----------------------- */

/**
 * Suspension state for a client-portal session. The portal client is
 * gated when THEIR OWN linked billing account (email-matched users
 * row — the portalBilling grain) is suspended, or when the workspace
 * they belong to is covered by a suspended owner's subscription.
 * selfServe mirrors portalBilling.billingForClient: the client can
 * fix it themselves only when the suspended account is their own.
 */
async function suspensionForPortalClient(client, deps = {}) {
  const q = deps.query || query;
  const none = { suspended: false };
  if (!client) return none;
  await ensureSuspensionTables(q);
  const email = String(client.email || '')
    .trim()
    .toLowerCase();
  if (email) {
    const rows = await q('SELECT id FROM users WHERE email = :email LIMIT 1', { email });
    if (rows[0]) {
      const own = await getActiveSuspensionForUser(rows[0].id, deps);
      if (own) {
        return {
          suspended: true,
          suspensionId: Number(own.id),
          suspendedAt: own.suspended_at || null,
          reason: own.reason || 'payment_failed_unpaid',
          selfServe: true,
        };
      }
    }
  }
  const ws = Number(client.workspace_id || 0);
  if (ws) {
    const covered = await getActiveSuspensionForWorkspace(ws, deps);
    if (covered) {
      return {
        suspended: true,
        suspensionId: Number(covered.id),
        suspendedAt: covered.suspended_at || null,
        reason: covered.reason || 'payment_failed_unpaid',
        selfServe: false,
      };
    }
  }
  return none;
}

/* ------------------------------- sweep ------------------------------ */

/**
 * Hourly (rides the lifecycle sweep): for every active episode,
 * send the next weekly email when due — and self-heal state drift:
 * a subscription that reads active/trialing again is restored
 * instead of emailed, and an account whose subscription is gone is
 * terminated instead of emailed. Dedupe: the episode counter + the
 * lifecycle claim key make two sends in one 7-day period impossible.
 */
async function runSuspensionSweep(deps = {}) {
  const q = deps.query || query;
  const now = deps.now ? new Date(deps.now()) : new Date();
  await ensureSuspensionTables(q);
  const out = { considered: 0, sent: [], restored: [], terminated: [], skipped: [] };
  const rows = await q(`SELECT * FROM subscription_suspensions WHERE status = 'active' ORDER BY id ASC LIMIT 500`);
  for (const suspension of rows || []) {
    out.considered++;
    const user = await userById(q, suspension.user_id);
    if (!user) {
      out.skipped.push({ suspensionId: suspension.id, reason: 'no_user' });
      continue;
    }
    const subStatus = String(user.subscription_status || '');
    if (String(user.status || 'active') === 'disabled' || user.deleted_at || !user.stripe_subscription_id) {
      await terminateForSubscription(
        { id: suspension.subscription_id, metadata: { user_id: String(user.id) }, customer: user.stripe_customer_id },
        deps
      );
      out.terminated.push({ suspensionId: suspension.id, reason: 'account_gone' });
      continue;
    }
    if (subStatus === 'active' || subStatus === 'trialing') {
      const restored = await restoreForUser(user.id, deps, { via: 'sweep_reconcile' });
      if (restored) out.restored.push({ suspensionId: suspension.id });
      continue;
    }
    if (subStatus === 'canceled' || subStatus === 'none' || subStatus === '') {
      await terminateForSubscription(
        { id: suspension.subscription_id, metadata: { user_id: String(user.id) }, customer: user.stripe_customer_id },
        deps
      );
      out.terminated.push({ suspensionId: suspension.id, reason: 'subscription_ended' });
      continue;
    }
    const last = suspension.last_weekly_email_at ? parseTime(suspension.last_weekly_email_at) : NaN;
    const due = Number.isNaN(last) || now.getTime() - last >= WEEK_MS;
    if (!due) {
      out.skipped.push({ suspensionId: suspension.id, reason: 'within_week' });
      continue;
    }
    try {
      const res = await sendWeeklyRenewalEmail(suspension, user, deps);
      if (res && res.sent) out.sent.push({ suspensionId: suspension.id, to: res.to });
      else out.skipped.push({ suspensionId: suspension.id, reason: (res && res.reason) || 'not_sent' });
    } catch (e) {
      console.warn('[suspension] weekly email:', suspension.id, e && e.message);
      out.skipped.push({ suspensionId: suspension.id, reason: 'send_error' });
    }
  }
  return out;
}

/* ------------------------------- admin ------------------------------ */

async function listActiveSuspensions(deps = {}) {
  const q = deps.query || query;
  await ensureSuspensionTables(q);
  const rows = await q(
    `SELECT s.*, u.email AS user_email, u.name AS user_name, u.billing_plan AS user_plan
       FROM subscription_suspensions s
       LEFT JOIN users u ON u.id = s.user_id
      WHERE s.status = 'active'
      ORDER BY s.suspended_at ASC, s.id ASC`
  );
  const out = [];
  for (const r of rows || []) {
    let workspaceIds = [];
    try {
      const ws = await q(
        'SELECT workspace_id FROM subscription_suspension_workspaces WHERE suspension_id = :sid ORDER BY workspace_id ASC',
        { sid: Number(r.id) }
      );
      workspaceIds = (ws || []).map((x) => Number(x.workspace_id));
    } catch {
      workspaceIds = [];
    }
    out.push({
      id: Number(r.id),
      user_id: Number(r.user_id),
      user_email: r.user_email || null,
      user_name: r.user_name || null,
      plan: r.user_plan || null,
      subscription_id: r.subscription_id || null,
      reason: r.reason || '',
      stripe_status: r.stripe_status || null,
      suspended_at: r.suspended_at || null,
      weekly_email_count: Number(r.weekly_email_count || 0),
      last_weekly_email_at: r.last_weekly_email_at || null,
      workspace_ids: workspaceIds,
    });
  }
  return out;
}

module.exports = {
  ensureSuspensionTables,
  ensureSiteSuspensionTable,
  getActiveSuspensionForUser,
  getActiveSuspensionForWorkspace,
  userIsSuspended,
  suspendForSubscription,
  restoreForUser,
  restoreForSubscriptionEvent,
  restoreForInvoice,
  terminateForSubscription,
  suspensionForPortalClient,
  sendWeeklyRenewalEmail,
  runSuspensionSweep,
  listActiveSuspensions,
  WEEK_MS,
};
