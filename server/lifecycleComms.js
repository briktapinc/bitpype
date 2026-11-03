'use strict';

/**
 * Batch 63 — lifecycle comms pack (Ely, 2026-10-29: "Build the full
 * comms pack"). Closes the gaps found by the 2026-10-29 renewal-comms
 * census: until now the ONLY lifecycle email was Batch 37's post-charge
 * renewal receipt (plus the domain flow's first-payment email and the
 * rental activation/ended pair). Everything here is a WARNING or a
 * CONFIRMATION around a charge or a state change:
 *
 *   1. Pre-renewal reminder — hourly sweep, T-7 before a paid
 *      subscription's period end (amount from the live Stripe price).
 *   2. Domain pack — auto-renew advance notice (T-30), mode-flip
 *      notice (auto → manual when the owner unsubscribes), lapse
 *      warnings for manual domains (T-30 + T-7), manual-renewal
 *      confirmation. Flip/renewed events arrive from the Batch 60
 *      reconcile (deps.notifyDomainEvent, wired by default in
 *      domainRenewals.reconcileWorkspaces); the sweep ALSO diffs a
 *      persisted per-domain state snapshot so a flip is caught even
 *      if a reconcile ran without the notifier attached.
 *   3. Cancel pack — confirmation when a cancel is scheduled (in-app
 *      route + subscription.updated sync path), T-3 "goes offline"
 *      reminder from the sweep, post-termination notice after
 *      customer.subscription.deleted has archived the sites.
 *   4. Failed-payment email on invoice.payment_failed (access
 *      continues while Stripe retries — past_due is an ACTIVE status
 *      in billing.js — and the copy says exactly that).
 *   5. Plan-only first-payment receipt for subscription_create
 *      invoices, cross-checked against the domain flow so a signup
 *      with a domain never gets two payment emails.
 *   6. Rental monthly statement — prior calendar month's settled
 *      charges per rental, one email per rental per month.
 *   7. Package-contents change notice — fired by the admin route ONLY
 *      when the "Email this change to current subscribers" checkbox
 *      was checked (Batch 57 panel, Batch 63 addition).
 *
 * Contract (the app's existing style, Batch 36/37): every send goes
 * through sendPlatformMail, is BEST-EFFORT (a mail failure never fails
 * the webhook / sweep / route that triggered it) and EXACTLY-ONCE —
 * each send first claims a unique ref_key row in
 * lifecycle_comms_sends (platform DB); a failed send releases the
 * claim so the next sweep retries, a successful one keeps the row,
 * which doubles as the send log (alongside platform_audit +
 * workspace activity_log rows). Copy carries real data only: a send
 * whose amount/date cannot be resolved is skipped and logged, never
 * sent with a placeholder.
 */

const crypto = require('node:crypto');
const { query } = require('./db');
const platform = require('./platform');
const plans = require('./plans');

const DAY_MS = 86400000;
const USER_COLS =
  'id, email, name, status, is_super_admin, stripe_customer_id, stripe_subscription_id, subscription_status, subscription_price_id, billing_plan, current_period_end, deleted_at';

/* ---------------------------- formatting ---------------------------- */

/** "$99.00" for USD; "99.00 EUR" otherwise. (Same shape as billing.js.) */
function formatMoney(cents, currency) {
  const amount = (Number(cents) || 0) / 100;
  const cur = String(currency || 'usd').toLowerCase();
  return cur === 'usd' ? `$${amount.toFixed(2)}` : `${amount.toFixed(2)} ${cur.toUpperCase()}`;
}

/** "November 27, 2026" from unix seconds, an ISO string, or a Date. */
function formatDateLong(value) {
  if (value == null || value === '') return null;
  const d =
    value instanceof Date
      ? value
      : typeof value === 'number'
        ? new Date(value * 1000)
        : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' });
}

/** 'YYYY-MM-DD' (UTC) for dedupe keys, from seconds/ISO/Date. */
function dateKey(value) {
  if (value == null || value === '') return '';
  const d =
    value instanceof Date
      ? value
      : typeof value === 'number'
        ? new Date(value * 1000)
        : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

/** Whole days from `now` until `when` (negative when past). */
function daysUntil(when, now) {
  const t = when instanceof Date ? when.getTime() : new Date(when).getTime();
  if (Number.isNaN(t)) return null;
  return Math.floor((t - now.getTime()) / DAY_MS);
}

/** Durable manage/cancel link (same target Batch 37's receipt uses). */
function manageUrl(deps = {}) {
  let raw = '';
  try {
    raw = (deps.appUrl || (() => require('./stripeClient').appUrl()))() || '';
  } catch {
    raw = '';
  }
  return `${String(raw || '').replace(/\/$/, '')}/portal?panel=billing`;
}

function portalUrl(deps = {}) {
  let raw = '';
  try {
    raw = (deps.appUrl || (() => require('./stripeClient').appUrl()))() || '';
  } catch {
    raw = '';
  }
  return `${String(raw || '').replace(/\/$/, '')}/portal`;
}

/* ------------------------- dedupe / send log ------------------------ */

async function ensureCommsTables(q) {
  await q(
    `CREATE TABLE IF NOT EXISTS lifecycle_comms_sends (
       ref_key VARCHAR(255) PRIMARY KEY,
       kind VARCHAR(48) NOT NULL DEFAULT '',
       workspace_id INTEGER,
       user_id INTEGER,
       recipient VARCHAR(255),
       subject VARCHAR(255),
       sent_at VARCHAR(32)
     )`
  );
  await q(
    `CREATE TABLE IF NOT EXISTS lifecycle_domain_state (
       domain VARCHAR(255) PRIMARY KEY,
       workspace_id INTEGER,
       mode VARCHAR(16),
       expires_at VARCHAR(32),
       updated_at VARCHAR(32)
     )`
  );
}

function isDupError(e) {
  return !!e && (e.code === 'ER_DUP_ENTRY' || /unique|duplicate/i.test(String(e.message || '')));
}

/**
 * Claim-then-send: insert the ref_key row first (unique — a replay or
 * a second sweep finds it and stops), then send. On send failure the
 * claim is released so the next run retries. Returns a result object;
 * NEVER throws for a mail failure.
 */
async function sendClaimed(deps, spec) {
  const q = deps.query || query;
  const sendMail = deps.sendMail || (async (mail) => require('./mailer').sendPlatformMail(mail));
  if (deps.dryRun) {
    return { sent: false, dryRun: true, wouldSend: { to: spec.mail.to, subject: spec.mail.subject, kind: spec.kind } };
  }
  await ensureCommsTables(q);
  try {
    await q(
      `INSERT INTO lifecycle_comms_sends (ref_key, kind, workspace_id, user_id, recipient, subject, sent_at)
       VALUES (:refKey, :kind, :ws, :uid, :to, :subject, :sentAt)`,
      {
        refKey: spec.refKey,
        kind: spec.kind,
        ws: spec.workspaceId != null ? Number(spec.workspaceId) : null,
        uid: spec.userId != null ? Number(spec.userId) : null,
        to: String(spec.mail.to || '').slice(0, 255),
        subject: String(spec.mail.subject || '').slice(0, 255),
        sentAt: new Date().toISOString(),
      }
    );
  } catch (e) {
    if (isDupError(e)) return { sent: false, reason: 'already_sent' };
    throw e;
  }
  try {
    await sendMail(spec.mail);
  } catch (e) {
    try {
      await q('DELETE FROM lifecycle_comms_sends WHERE ref_key = :refKey', { refKey: spec.refKey });
    } catch {
      /* claim release is best-effort; the warn below is the record */
    }
    console.warn('[lifecycleComms] send failed (claim released for retry):', spec.refKey, e && e.message);
    return { sent: false, reason: 'send_failed', error: (e && e.message) || String(e) };
  }
  try {
    await platform.audit(
      spec.userId != null ? Number(spec.userId) : null,
      'lifecycle.email',
      `${spec.kind} → ${spec.mail.to}: ${spec.mail.subject} [${spec.refKey}]`
    );
  } catch {
    /* audit is best-effort */
  }
  if (spec.db) {
    try {
      spec.db
        .prepare('INSERT INTO activity_log (area, message) VALUES (?, ?)')
        .run('billing', `Lifecycle email (${spec.kind}) sent to ${spec.mail.to}: ${spec.mail.subject}`);
    } catch {
      /* workspace activity log is best-effort */
    }
  }
  return { sent: true, to: spec.mail.to, subject: spec.mail.subject };
}

/* --------------------------- user helpers --------------------------- */

async function userById(q, id) {
  if (!id) return null;
  const rows = await q(`SELECT ${USER_COLS} FROM users WHERE id = :id LIMIT 1`, { id: Number(id) });
  return rows[0] || null;
}

function emailable(user) {
  return (
    !!user &&
    !!String(user.email || '').trim() &&
    String(user.status || 'active') !== 'disabled' &&
    !user.deleted_at
  );
}

/** Resolve a Stripe object (subscription/invoice) to a users-row id —
 *  metadata first, then the customer id, then the tracked sub id.
 *  Mirrors billing.js's resolution order. */
async function resolveUserId(q, obj) {
  if (!obj) return null;
  const meta =
    (obj.metadata && obj.metadata.user_id) ||
    (obj.subscription_details && obj.subscription_details.metadata && obj.subscription_details.metadata.user_id);
  if (meta && Number(meta)) return Number(meta);
  if (obj.customer) {
    const rows = await q('SELECT id FROM users WHERE stripe_customer_id = :cid LIMIT 1', {
      cid: String(obj.customer),
    });
    if (rows[0]) return rows[0].id;
  }
  const subId =
    typeof obj.subscription === 'string'
      ? obj.subscription
      : obj.subscription && obj.subscription.id
        ? obj.subscription.id
        : obj.id && String(obj.id).startsWith('sub_')
          ? obj.id
          : null;
  if (subId) {
    const rows = await q('SELECT id FROM users WHERE stripe_subscription_id = :sid LIMIT 1', { sid: subId });
    if (rows[0]) return rows[0].id;
  }
  return null;
}

/** Effective plan id for a user — billing.planOfUser when loadable,
 *  with a stored-plan fallback so this module never hard-depends on
 *  billing's internals. */
function planOfUser(user, deps = {}) {
  try {
    const b = deps.billing || require('./billing');
    if (b && typeof b.planOfUser === 'function') return b.planOfUser(user);
  } catch {
    /* fall through to the stored-plan fallback */
  }
  if (!user) return plans.PLAN_FREE;
  const stored = plans.normalizePlanId(user.billing_plan);
  const active = ['active', 'trialing', 'past_due'].includes(String(user.subscription_status || ''));
  if (active && plans.isPaidPlan(stored)) return stored;
  if (active) return plans.PLAN_STANDARD;
  return plans.PLAN_FREE;
}

function planName(planId) {
  const p = plans.getPlan(planId);
  return (p && p.name) || 'Bitpype';
}

async function fetchLiveSubscription(deps, subId) {
  if (typeof deps.getSubscription === 'function') return deps.getSubscription(subId);
  const stripe = await require('./stripeClient').getStripe();
  return stripe.subscriptions.retrieve(subId);
}

/* =================== 3a. cancel confirmation ====================== */

async function sendCancelConfirmation(subscription, deps = {}) {
  const q = deps.query || query;
  if (!subscription || !subscription.id) return { sent: false, reason: 'no_subscription' };
  if (!subscription.cancel_at_period_end) return { sent: false, reason: 'not_cancelling' };
  const periodEndSec = Number(subscription.current_period_end) || null;
  if (!periodEndSec) {
    console.warn('[lifecycleComms] cancel confirmation skipped — no period end on', subscription.id);
    return { sent: false, reason: 'no_period_end' };
  }
  const userId = await resolveUserId(q, subscription);
  const user = userId ? await userById(q, userId) : null;
  if (!emailable(user)) return { sent: false, reason: 'no_billing_user' };
  const name = planName(planOfUser(user, deps));
  const endLabel = formatDateLong(periodEndSec);
  const paragraphs = [
    `You've scheduled your ${name} plan to cancel. Nothing changes today — your plan stays active until ${endLabel}, and your website stays live until then too.`,
    `On ${endLabel} your plan moves to Free, your website comes offline, and any domains on your account stop renewing automatically (they're marked for manual renewal instead, so keep an eye on their expiry dates).`,
    'Changed your mind? You can undo this any time before that date from your billing page — the button below opens it.',
    'Questions? Just reply to this email.',
  ];
  const subject = `Your Bitpype ${name} plan is set to end on ${endLabel}`;
  return sendClaimed(deps, {
    refKey: `cancel_confirm:${subscription.id}:${dateKey(periodEndSec)}`,
    kind: 'cancel_confirm',
    userId: user.id,
    mail: {
      to: user.email,
      subject,
      title: subject,
      preheader: `Your ${name} plan stays active until ${endLabel}.`,
      paragraphs,
      text: paragraphs.join('\n\n'),
      cta: { url: manageUrl(deps), label: 'Undo or manage your plan' },
    },
  });
}

/** A resumed subscription may be cancelled again later in the SAME
 *  period — clear its cancel claims so the new cancel notifies again. */
async function clearCancelClaims(subscriptionId, deps = {}) {
  if (!subscriptionId) return { cleared: 0 };
  const q = deps.query || query;
  await ensureCommsTables(q);
  const needle = `:${String(subscriptionId)}:`;
  const res = await q('DELETE FROM lifecycle_comms_sends WHERE instr(ref_key, :needle) > 0', { needle });
  return { cleared: res && typeof res.affectedRows === 'number' ? res.affectedRows : 0 };
}

/* ================== 3c. post-termination notice =================== */

async function sendTerminationNotice(subscription, disableResult, deps = {}) {
  const q = deps.query || query;
  if (!subscription || !subscription.id) return { sent: false, reason: 'no_subscription' };
  if (!disableResult || disableResult.skipped === 'other_subscription_tracked' || !disableResult.userId) {
    return { sent: false, reason: 'not_applicable' };
  }
  const user = await userById(q, Number(disableResult.userId));
  if (!emailable(user)) return { sent: false, reason: 'no_billing_user' };
  const metaPlan = subscription.metadata && subscription.metadata.plan;
  const name = metaPlan ? planName(plans.normalizePlanId(metaPlan)) : null;
  const disabled = Array.isArray(disableResult.disabled) ? disableResult.disabled : [];
  const unlinked = [...new Set(disabled.flatMap((d) => d.unlinked || []))];
  const paragraphs = [
    name
      ? `Your ${name} plan has ended, and your account is now on the Free plan.`
      : 'Your paid plan has ended, and your account is now on the Free plan.',
    ...(disabled.length
      ? [
          `We took ${disabled.length === 1 ? 'your website' : `your ${disabled.length} websites`} offline${unlinked.length ? ` and unlinked ${unlinked.join(', ')}` : ''}. The site${disabled.length === 1 ? ' is' : 's are'} archived — not deleted.`,
        ]
      : []),
    'Nothing has been deleted: your account, your leads and your website content are all still here. Your domains stay registered in your name, but they no longer renew automatically — if you want to keep a domain, renew it manually before it expires or restart your plan.',
    'Want to come back? Restart your plan from the billing page (button below) and reply to this email — we\u2019ll restore your website for you.',
  ];
  const subject = name ? `Your Bitpype ${name} plan has ended` : 'Your Bitpype plan has ended';
  return sendClaimed(deps, {
    refKey: `terminated:${subscription.id}`,
    kind: 'terminated',
    userId: user.id,
    mail: {
      to: user.email,
      subject,
      title: subject,
      preheader: 'Your account is on the Free plan now. Nothing was deleted.',
      paragraphs,
      text: paragraphs.join('\n\n'),
      cta: { url: manageUrl(deps), label: 'Restart your plan' },
    },
  });
}

/* ==================== 4. failed-payment email ===================== */

async function sendPaymentFailedEmail(invoice, deps = {}) {
  const q = deps.query || query;
  if (!invoice || !invoice.id) return { sent: false, reason: 'no_invoice' };
  const amount = Number(invoice.amount_due != null ? invoice.amount_due : 0) || 0;
  if (!(amount > 0)) return { sent: false, reason: 'no_amount_due' };
  const userId = await resolveUserId(q, invoice);
  const user = userId ? await userById(q, userId) : null;
  if (!emailable(user)) return { sent: false, reason: 'no_billing_user' };
  const name = planName(planOfUser(user, deps));
  const amountLabel = formatMoney(amount, invoice.currency);
  const paragraphs = [
    `We tried to charge ${amountLabel} for your ${name} plan and the payment didn't go through.`,
    'Your plan stays active while the payment is retried — your website is not affected right now. If the payment keeps failing, the plan will eventually end and the website will come offline at that point.',
    'To sort it out now, update your card from your billing page — the button below opens it.',
  ];
  const subject = `Your Bitpype ${name} payment of ${amountLabel} didn't go through`;
  return sendClaimed(deps, {
    refKey: `payment_failed:${invoice.id}`,
    kind: 'payment_failed',
    userId: user.id,
    mail: {
      to: user.email,
      subject,
      title: subject,
      preheader: `Payment of ${amountLabel} failed — your plan stays active while it's retried.`,
      paragraphs,
      text: paragraphs.join('\n\n'),
      cta: { url: manageUrl(deps), label: 'Update your payment method' },
    },
  });
}

/* ================ 5. plan-only first-payment receipt =============== */

async function signupHadDomainPurchase(q, deps, user, subId) {
  if (!user || !subId) return false;
  const openDb = deps.openDb || ((ws) => require('./workspaceDb').openWorkspaceDb(ws));
  let workspaceIds = [];
  try {
    const rows = await q('SELECT workspace_id FROM workspace_members WHERE user_id = :uid', { uid: Number(user.id) });
    workspaceIds = [...new Set((rows || []).map((r) => Number(r.workspace_id)).filter(Boolean))];
  } catch {
    workspaceIds = [];
  }
  for (const ws of workspaceIds) {
    let db;
    try {
      db = openDb(ws);
    } catch {
      continue;
    }
    if (!db) continue;
    try {
      const has = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'domain_transactions'")
        .get();
      if (!has) continue;
      const row = db
        .prepare(
          `SELECT id FROM domain_transactions
            WHERE stripe_subscription_id = ? AND status IN ('paid','registering','live') LIMIT 1`
        )
        .get(String(subId));
      if (row) return true;
    } catch {
      /* domain flow not installed in this workspace db */
    }
  }
  return false;
}

async function sendFirstPaymentReceipt(invoice, opts = {}) {
  const deps = opts.deps || {};
  const q = deps.query || query;
  if (!invoice || String(invoice.billing_reason || '') !== 'subscription_create') {
    return { sent: false, reason: 'not_first_payment' };
  }
  const amount = Number(invoice.amount_paid != null ? invoice.amount_paid : 0) || 0;
  if (!(amount > 0)) return { sent: false, reason: 'no_amount_paid' };
  const userId = await resolveUserId(q, invoice);
  const user = userId ? await userById(q, userId) : null;
  if (!emailable(user)) return { sent: false, reason: 'no_billing_user' };
  const subId =
    typeof invoice.subscription === 'string'
      ? invoice.subscription
      : invoice.subscription && invoice.subscription.id
        ? invoice.subscription.id
        : null;
  // The domain flow already emailed this client its "Payment received
  // for <domain>" — a signup carrying a domain must never get two
  // payment emails for the same purchase.
  if (await signupHadDomainPurchase(q, deps, user, subId)) {
    return { sent: false, reason: 'domain_flow_emailed' };
  }
  const subscription = opts.subscription || null;
  const linePeriod =
    invoice.lines && invoice.lines.data && invoice.lines.data[0] && invoice.lines.data[0].period
      ? invoice.lines.data[0].period.end
      : null;
  const periodEndSec =
    (subscription && subscription.current_period_end) || invoice.period_end || linePeriod || null;
  const paidThrough = periodEndSec ? formatDateLong(periodEndSec) : null;
  const name = planName(planOfUser(user, deps));
  const amountLabel = formatMoney(amount, invoice.currency);
  const paragraphs = [
    `Thank you — your payment is confirmed. We charged ${amountLabel} to the card on file, and you're on the ${name} plan${paidThrough ? `, paid up through ${paidThrough}` : ''}.`,
    'There\u2019s nothing else you need to do. You can update your card, switch plans, or cancel any time from your billing page — the button below opens it.',
    'Just reply to this email if you have any questions.',
  ];
  const subject = `Payment received for your Bitpype ${name} plan`;
  return sendClaimed(deps, {
    refKey: `first_payment:${user.id}:${subId || invoice.id}`,
    kind: 'first_payment',
    userId: user.id,
    mail: {
      to: user.email,
      subject,
      title: 'Payment received — thank you!',
      preheader: `${name} plan active — ${amountLabel}${paidThrough ? `, paid through ${paidThrough}` : ''}.`,
      paragraphs,
      text: paragraphs.join('\n\n'),
      cta: { url: manageUrl(deps), label: 'Manage your plan' },
    },
  });
}

/* ======================= domain pack (item 2) ===================== */

/** The recipient for a domain's notices: the domain transaction's
 *  billing user first (they paid for the domain), then the workspace's
 *  owner member — the same owner resolution the Batch 60 mode
 *  derivation is based on. */
async function resolveDomainRecipient(q, db, workspaceId, row) {
  try {
    const txn = db
      .prepare(
        `SELECT billing_user_id FROM domain_transactions
          WHERE domain = ? AND billing_user_id IS NOT NULL
            AND status IN ('paid','registering','live')
          ORDER BY id DESC LIMIT 1`
      )
      .get(row.domain_name);
    if (txn && txn.billing_user_id) {
      const u = await userById(q, txn.billing_user_id);
      if (emailable(u)) return u;
    }
  } catch {
    /* domain flow tables not present in every workspace */
  }
  const memberSets = [
    `SELECT u.id FROM workspace_members m JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id = :ws AND m.role = 'owner' ORDER BY u.id ASC`,
    `SELECT u.id FROM workspace_members m JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id = :ws AND m.role IN ('owner','admin') ORDER BY u.id ASC`,
  ];
  for (const sql of memberSets) {
    let rows = [];
    try {
      rows = await q(sql, { ws: Number(workspaceId) });
    } catch {
      rows = [];
    }
    for (const r of rows || []) {
      const u = await userById(q, r.id);
      if (emailable(u)) return u;
    }
  }
  return null;
}

function domainCostLine(row) {
  const cents = row && row.renewal_cost != null ? Number(row.renewal_cost) : NaN;
  if (Number.isFinite(cents) && cents > 0) return ` The renewal cost is ${formatMoney(cents, 'usd')}.`;
  return '';
}

async function sendDomainNotice(deps, ctx) {
  const q = deps.query || query;
  const { db, workspaceId, row } = ctx;
  const domain = String(row.domain_name || '').toLowerCase();
  const expiryLabel = formatDateLong(row.expires_at);
  if (!domain || !expiryLabel) return { sent: false, reason: 'no_domain_or_expiry' };
  const user = await resolveDomainRecipient(q, db, workspaceId, row);
  if (!user) return { sent: false, reason: 'no_recipient' };
  const steps =
    'To renew it yourself: open the Cloudflare dashboard, go to Manage domains, pick ' +
    `${domain}, then Registration → Renew/Extend Domain.`;
  let refKey;
  let kind;
  let subject;
  let paragraphs;
  if (ctx.notice === 'auto_notice') {
    kind = 'domain_auto_notice';
    refKey = `domain_auto_notice:${domain}:${dateKey(row.expires_at)}`;
    subject = `${domain} renews automatically — no action needed`;
    paragraphs = [
      `Your domain ${domain} is set to renew automatically because your BitPype plan is active.${domainCostLine(row)}`,
      `It expires on ${expiryLabel}. Cloudflare (the registrar) charges the payment method on the account up to 30 days before that date, so you may see the charge ahead of the expiry itself.`,
      'You don\u2019t need to do anything. If you cancel your plan, the domain stops renewing automatically and we\u2019ll email you about that when it happens.',
    ];
  } else if (ctx.notice === 'flip') {
    kind = 'domain_flip_manual';
    refKey = `domain_flip:${domain}:${dateKey(row.expires_at)}`;
    subject = `${domain} will no longer renew automatically`;
    paragraphs = [
      `Your BitPype plan is no longer active, so your domain ${domain} has been marked "Manual renewal only" and its automatic renewal has been switched off.`,
      `The domain itself is still yours and stays registered until ${expiryLabel}. If it isn't renewed before then, it will expire — and an expired domain can be registered by somebody else. As set out in the Terms, that loss is not something BitPype can undo or cover.`,
      steps,
      'Or restart your plan (button below) and automatic renewal switches back on.',
    ];
  } else if (ctx.notice === 'lapse') {
    kind = ctx.window === 7 ? 'domain_lapse_7' : 'domain_lapse_30';
    refKey = `${kind}:${domain}:${dateKey(row.expires_at)}`;
    subject =
      ctx.window === 7
        ? `${domain} expires in 7 days — renew it now to keep it`
        : `${domain} expires on ${expiryLabel} — renew it to keep it`;
    paragraphs = [
      `Your domain ${domain} is on manual renewal (it isn't covered by an active plan), and it expires on ${expiryLabel}${ctx.window === 7 ? ' — that\u2019s 7 days away' : ''}.`,
      'If it isn\u2019t renewed before then, the domain lapses: your website\u2019s address stops working, and the domain can be registered by somebody else.',
      steps,
      'Or restart your plan (button below) and automatic renewal switches back on.',
    ];
  } else if (ctx.notice === 'renewed') {
    kind = 'domain_renewed';
    refKey = `domain_renewed:${domain}:${dateKey(row.expires_at)}`;
    subject = `${domain} has been renewed — new expiry ${expiryLabel}`;
    paragraphs = [
      `Good news — the renewal of ${domain} has gone through. Its new expiry date is ${expiryLabel}.`,
      'The domain is still on manual renewal while your plan is inactive, so the same applies next time — unless you restart your plan, in which case it renews automatically again.',
    ];
  } else {
    return { sent: false, reason: 'unknown_notice' };
  }
  return sendClaimed(deps, {
    refKey,
    kind,
    workspaceId,
    userId: user.id,
    db,
    mail: {
      to: user.email,
      subject,
      title: subject,
      preheader: paragraphs[0],
      paragraphs,
      text: paragraphs.join('\n\n'),
      cta: { url: manageUrl(deps), label: 'Manage your plan' },
    },
  });
}

/**
 * Entry point wired into the Batch 60 reconcile (domainRenewals calls
 * this through deps.notifyDomainEvent): a domain flipped auto→manual,
 * or a requested manual renewal was observed complete. Best-effort —
 * the wrapper here never throws into the reconcile.
 */
async function notifyDomainEvent(db, workspaceId, event, deps = {}) {
  try {
    if (!event || !event.domain) return { sent: false, reason: 'no_event' };
    const domain = String(event.domain).toLowerCase();
    let row = null;
    try {
      row = db
        .prepare(
          `SELECT * FROM site_domains WHERE domain_name = ? AND status IN ('linked','registered') ORDER BY id DESC LIMIT 1`
        )
        .get(domain);
    } catch {
      row = null;
    }
    if (!row) {
      row = { domain_name: domain, expires_at: event.expiresAt || null, website_id: event.websiteId || null };
    }
    if (event.type === 'flip') {
      return await sendDomainNotice(deps, { db, workspaceId, row, notice: 'flip' });
    }
    if (event.type === 'manual_renewed') {
      return await sendDomainNotice(deps, { db, workspaceId, row, notice: 'renewed' });
    }
    return { sent: false, reason: 'unknown_event' };
  } catch (e) {
    console.warn('[lifecycleComms] notifyDomainEvent:', e && e.message);
    return { sent: false, reason: 'error', error: (e && e.message) || String(e) };
  }
}

/* ============================ sweeps ============================== */

async function runSubscriptionSweep(deps = {}) {
  const q = deps.query || query;
  const now = deps.now ? new Date(deps.now) : new Date();
  const horizon = new Date(now.getTime() + 7 * DAY_MS).toISOString().slice(0, 19).replace('T', ' ');
  const floor = new Date(now.getTime() - DAY_MS).toISOString().slice(0, 19).replace('T', ' ');
  const rows = await q(
    `SELECT ${USER_COLS} FROM users
      WHERE stripe_subscription_id IS NOT NULL AND stripe_subscription_id <> ''
        AND subscription_status IN ('active','trialing','past_due')
        AND current_period_end IS NOT NULL
        AND current_period_end <= :horizon AND current_period_end >= :floor
      ORDER BY id ASC`,
    { horizon, floor }
  );
  const out = { scanned: (rows || []).length, sent: [], skipped: [] };
  for (const user of rows || []) {
    if (!emailable(user)) {
      out.skipped.push({ userId: user.id, reason: 'not_emailable' });
      continue;
    }
    if (String(user.subscription_status) === 'past_due') {
      out.skipped.push({ userId: user.id, reason: 'past_due' });
      continue;
    }
    let live = null;
    try {
      live = await fetchLiveSubscription(deps, user.stripe_subscription_id);
    } catch (e) {
      console.warn('[lifecycleComms] live subscription fetch:', user.stripe_subscription_id, e && e.message);
      out.skipped.push({ userId: user.id, reason: 'stripe_fetch_failed' });
      continue;
    }
    if (!live) {
      out.skipped.push({ userId: user.id, reason: 'no_live_subscription' });
      continue;
    }
    const periodEndSec = Number(live.current_period_end) || null;
    if (!periodEndSec) {
      out.skipped.push({ userId: user.id, reason: 'no_period_end' });
      continue;
    }
    const days = daysUntil(periodEndSec * 1000, now);
    if (days == null || days < 0) {
      out.skipped.push({ userId: user.id, reason: 'period_passed' });
      continue;
    }
    const name = planName(planOfUser(user, deps));
    if (live.cancel_at_period_end) {
      // Item 3b — T-3 "goes offline" reminder.
      if (days > 3) {
        out.skipped.push({ userId: user.id, reason: 'cancel_reminder_not_due' });
        continue;
      }
      const endLabel = formatDateLong(periodEndSec);
      const paragraphs = [
        `Your ${name} plan ends on ${endLabel} — that\u2019s in ${days === 0 ? 'less than a day' : days === 1 ? '1 day' : `${days} days`}.`,
        'When it ends, your plan moves to Free, your website comes offline, and your domains stop renewing automatically (they\u2019re marked for manual renewal instead).',
        'Want to stay live? Undo the cancellation from your billing page before that date — the button below opens it. Nothing about your site or your data is deleted either way.',
      ];
      const subject = `Your Bitpype ${name} plan ends on ${endLabel} — your website goes offline then`;
      const res = await sendClaimed(deps, {
        refKey: `cancel_reminder:${live.id}:${dateKey(periodEndSec)}`,
        kind: 'cancel_reminder',
        userId: user.id,
        mail: {
          to: user.email,
          subject,
          title: subject,
          preheader: `Your ${name} plan ends ${endLabel}.`,
          paragraphs,
          text: paragraphs.join('\n\n'),
          cta: { url: manageUrl(deps), label: 'Keep my plan' },
        },
      });
      if (res.sent || res.dryRun) out.sent.push({ kind: 'cancel_reminder', userId: user.id, ...res });
      continue;
    }
    // Item 1 — pre-renewal reminder (window: first day days ≤ 7).
    if (days > 7) {
      out.skipped.push({ userId: user.id, reason: 'not_due' });
      continue;
    }
    const item = live.items && live.items.data && live.items.data[0];
    const price = item && item.price;
    const unitAmount = price && price.unit_amount != null ? Number(price.unit_amount) : null;
    if (unitAmount == null || !(unitAmount > 0)) {
      console.warn('[lifecycleComms] pre-renewal skipped — no resolvable amount for', live.id);
      out.skipped.push({ userId: user.id, reason: 'no_amount' });
      continue;
    }
    const quantity = item && item.quantity ? Number(item.quantity) : 1;
    const amountLabel = formatMoney(unitAmount * quantity, price.currency);
    const renewLabel = formatDateLong(periodEndSec);
    const paragraphs = [
      `Your ${name} plan renews on ${renewLabel}. We'll charge ${amountLabel} to the card on file — no action needed if you're happy to continue.`,
      'If you cancel before then, nothing switches off straight away: your plan and your website stay live until the end of the period you\u2019ve paid for.',
      'You can update your card, switch plans, or cancel any time from your billing page — the button below opens it.',
    ];
    const subject = `Your Bitpype ${name} plan renews on ${renewLabel} — ${amountLabel}`;
    const res = await sendClaimed(deps, {
      refKey: `pre_renewal:${live.id}:${dateKey(periodEndSec)}`,
      kind: 'pre_renewal',
      userId: user.id,
      mail: {
        to: user.email,
        subject,
        title: subject,
        preheader: `${name} renews ${renewLabel} at ${amountLabel}.`,
        paragraphs,
        text: paragraphs.join('\n\n'),
        cta: { url: manageUrl(deps), label: 'Manage or cancel your plan' },
      },
    });
    if (res.sent || res.dryRun) out.sent.push({ kind: 'pre_renewal', userId: user.id, ...res });
  }
  return out;
}

/** Live site_domains rows (latest per domain) — the Batch 60 shape. */
function liveDomainRowsForComms(db) {
  const has = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'site_domains'").get();
  if (!has) return [];
  const cols = db.prepare('PRAGMA table_info(site_domains)').all().map((c) => c.name);
  if (!cols.includes('renewal_mode') || !cols.includes('expires_at')) return [];
  const rows = db
    .prepare(`SELECT * FROM site_domains WHERE status IN ('linked','registered') ORDER BY id DESC`)
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

async function runDomainSweep(deps = {}) {
  const q = deps.query || query;
  const now = deps.now ? new Date(deps.now) : new Date();
  await ensureCommsTables(q);
  let workspaceIds;
  if (typeof deps.listWorkspaceIds === 'function') {
    workspaceIds = await deps.listWorkspaceIds();
  } else {
    const rows = await q('SELECT id FROM workspaces ORDER BY id ASC');
    workspaceIds = (rows || []).map((r) => Number(r.id));
  }
  const openDb = deps.openDb || ((ws) => require('./workspaceDb').openWorkspaceDb(ws));
  const out = { workspaces: 0, domains: 0, sent: [], skipped: [] };
  for (const ws of [...new Set((workspaceIds || []).map(Number).filter(Boolean))]) {
    let db;
    try {
      db = openDb(ws);
    } catch {
      continue;
    }
    if (!db) continue;
    out.workspaces++;
    let rows = [];
    try {
      rows = liveDomainRowsForComms(db);
    } catch {
      rows = [];
    }
    for (const row of rows) {
      const domain = String(row.domain_name || '').toLowerCase();
      if (!domain || !row.expires_at || !row.renewal_mode) continue;
      out.domains++;
      const stateRows = await q('SELECT * FROM lifecycle_domain_state WHERE domain = :domain', { domain });
      const state = stateRows[0] || null;
      const days = daysUntil(row.expires_at, now);
      // Transition notices (state-diffed; the reconcile hook normally
      // beats the sweep to these — same dedupe keys, so no doubles).
      if (state && state.mode === 'auto' && row.renewal_mode === 'manual') {
        const res = await sendDomainNotice(deps, { db, workspaceId: ws, row, notice: 'flip' });
        if (res.sent || res.dryRun) out.sent.push({ kind: 'domain_flip_manual', domain, ...res });
      }
      if (
        state &&
        state.mode === 'manual' &&
        row.renewal_mode === 'manual' &&
        state.expires_at &&
        new Date(row.expires_at).getTime() > new Date(state.expires_at).getTime() + 30 * DAY_MS
      ) {
        const res = await sendDomainNotice(deps, { db, workspaceId: ws, row, notice: 'renewed' });
        if (res.sent || res.dryRun) out.sent.push({ kind: 'domain_renewed', domain, ...res });
      }
      // Window notices.
      if (days != null && days >= 0 && days <= 30) {
        if (row.renewal_mode === 'auto') {
          const res = await sendDomainNotice(deps, { db, workspaceId: ws, row, notice: 'auto_notice' });
          if (res.sent || res.dryRun) out.sent.push({ kind: 'domain_auto_notice', domain, ...res });
        } else if (row.renewal_mode === 'manual') {
          // The T-30 warning belongs to the T-30..T-8 window; inside
          // the final week only the T-7 warning fires, so a domain
          // first seen at T-5 gets one warning, not two at once.
          if (days > 7) {
            const res30 = await sendDomainNotice(deps, { db, workspaceId: ws, row, notice: 'lapse', window: 30 });
            if (res30.sent || res30.dryRun) out.sent.push({ kind: 'domain_lapse_30', domain, ...res30 });
          }
          if (days <= 7) {
            const res7 = await sendDomainNotice(deps, { db, workspaceId: ws, row, notice: 'lapse', window: 7 });
            if (res7.sent || res7.dryRun) out.sent.push({ kind: 'domain_lapse_7', domain, ...res7 });
          }
        }
      }
      if (!deps.dryRun) {
        await q(
          `INSERT INTO lifecycle_domain_state (domain, workspace_id, mode, expires_at, updated_at)
           VALUES (:domain, :ws, :mode, :exp, :upd)
           ON DUPLICATE KEY UPDATE workspace_id = :ws, mode = :mode, expires_at = :exp, updated_at = :upd`,
          {
            domain,
            ws: Number(ws),
            mode: row.renewal_mode,
            exp: row.expires_at || null,
            upd: new Date().toISOString(),
          }
        );
      }
    }
  }
  return out;
}

async function runRentalStatements(deps = {}) {
  const q = deps.query || query;
  const now = deps.now ? new Date(deps.now) : new Date();
  // Prior calendar month (UTC), complete by construction.
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const startSql = monthStart.toISOString().slice(0, 19).replace('T', ' ');
  const endSql = monthEnd.toISOString().slice(0, 19).replace('T', ' ');
  const monthKey = monthStart.toISOString().slice(0, 7);
  const monthLabel = monthStart.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', year: 'numeric' });
  let workspaceIds;
  if (typeof deps.listWorkspaceIds === 'function') {
    workspaceIds = await deps.listWorkspaceIds();
  } else {
    const rows = await q('SELECT id FROM workspaces ORDER BY id ASC');
    workspaceIds = (rows || []).map((r) => Number(r.id));
  }
  const openDb = deps.openDb || ((ws) => require('./workspaceDb').openWorkspaceDb(ws));
  const out = { month: monthKey, sent: [], skipped: [] };
  for (const ws of [...new Set((workspaceIds || []).map(Number).filter(Boolean))]) {
    let db;
    try {
      db = openDb(ws);
    } catch {
      continue;
    }
    if (!db) continue;
    let has = null;
    try {
      has = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'site_rental_charges'").get();
    } catch {
      has = null;
    }
    if (!has) continue;
    const agg = db
      .prepare(
        `SELECT rental_id,
                COUNT(*) AS n,
                COALESCE(SUM(credits_debited), 0) AS credits,
                COALESCE(SUM(amount_due_cents), 0) AS due_cents
           FROM site_rental_charges
          WHERE status IN ('charged','due') AND settled_at >= ? AND settled_at < ?
          GROUP BY rental_id`
      )
      .all(startSql, endSql);
    for (const a of agg) {
      let rental = null;
      let tenant = null;
      let siteName = 'your rented site';
      try {
        rental = db.prepare('SELECT * FROM site_rentals WHERE id = ?').get(a.rental_id);
        if (rental) {
          tenant = db.prepare('SELECT * FROM leads WHERE id = ?').get(rental.tenant_lead_id);
          const site = db.prepare('SELECT name FROM websites WHERE id = ?').get(rental.website_id);
          if (site && site.name) siteName = site.name;
        }
      } catch {
        /* fall through with defaults */
      }
      const to = tenant ? String(tenant.email || '').trim() : '';
      if (!rental || !to) {
        out.skipped.push({ workspaceId: ws, rentalId: a.rental_id, reason: 'no_tenant_email' });
        continue;
      }
      const credits = Number(a.credits) || 0;
      const due = Number(a.due_cents) || 0;
      const paragraphs = [
        `Your rental statement for ${monthLabel} — ${siteName}: ${a.n} charge${a.n === 1 ? '' : 's'} settled, ${credits} credit${credits === 1 ? '' : 's'} used${due > 0 ? `, and ${formatMoney(due, 'usd')} still due` : ''}.`,
        'The full breakdown — every lead, call and charge — is in your portal under your rented site.',
        'Questions about a charge? Just reply to this email.',
      ];
      const subject = `Your ${siteName} rental statement for ${monthLabel}`;
      const res = await sendClaimed(deps, {
        refKey: `rental_statement:${ws}:${a.rental_id}:${monthKey}`,
        kind: 'rental_statement',
        workspaceId: ws,
        db,
        mail: {
          to,
          subject,
          title: subject,
          preheader: `${a.n} settled charge${a.n === 1 ? '' : 's'} in ${monthLabel}.`,
          paragraphs,
          text: paragraphs.join('\n\n'),
          cta: { url: portalUrl(deps), label: 'View your rental in your portal' },
        },
      });
      if (res.sent || res.dryRun) out.sent.push({ kind: 'rental_statement', workspaceId: ws, rentalId: a.rental_id, ...res });
    }
  }
  return out;
}

async function runSweep(deps = {}) {
  const out = {};
  try {
    out.subscriptions = await runSubscriptionSweep(deps);
  } catch (e) {
    console.warn('[lifecycleComms] subscription sweep:', e && e.message);
    out.subscriptions = { error: (e && e.message) || String(e) };
  }
  try {
    out.domains = await runDomainSweep(deps);
  } catch (e) {
    console.warn('[lifecycleComms] domain sweep:', e && e.message);
    out.domains = { error: (e && e.message) || String(e) };
  }
  try {
    out.rentals = await runRentalStatements(deps);
  } catch (e) {
    console.warn('[lifecycleComms] rental statements:', e && e.message);
    out.rentals = { error: (e && e.message) || String(e) };
  }
  // Batch 119: weekly suspension renewal emails + episode self-healing
  // (server/subscriptionSuspension.js). Same isolation contract as the
  // sections above: a failure here never breaks the other sweeps.
  try {
    out.suspensions = await require('./subscriptionSuspension').runSuspensionSweep(deps);
  } catch (e) {
    console.warn('[lifecycleComms] suspension sweep:', e && e.message);
    out.suspensions = { error: (e && e.message) || String(e) };
  }
  return out;
}

/* ============ 7. package-contents change notice (opt-in) ========== */

async function sendPlanContentsNotice(planIdInput, deps = {}) {
  const q = deps.query || query;
  const planId = plans.normalizePlanId(planIdInput);
  const ALL_PLANS = [plans.PLAN_FREE, plans.PLAN_STANDARD, plans.PLAN_PRO, plans.PLAN_PREMIUM];
  if (!ALL_PLANS.includes(planId) || String(planIdInput || '').trim().toLowerCase() !== planId) {
    return { sent: 0, reason: 'unknown_plan' };
  }
  const resolved = plans.getPlan(planId);
  const features = Array.isArray(resolved.features) ? resolved.features.slice() : [];
  const hash = crypto
    .createHash('sha1')
    .update(JSON.stringify({ name: resolved.name, tagline: resolved.tagline, features, entitlements: resolved.entitlements }))
    .digest('hex')
    .slice(0, 12);
  const ownerRows = await q(
    `SELECT DISTINCT u.id FROM workspace_members m JOIN users u ON u.id = m.user_id
      WHERE m.role = 'owner' ORDER BY u.id ASC`
  );
  let sent = 0;
  let considered = 0;
  for (const r of ownerRows || []) {
    const user = await userById(q, r.id);
    if (!emailable(user)) continue;
    if (planOfUser(user, deps) !== planId) continue;
    considered++;
    const paragraphs = [
      `We've updated what's included in your ${resolved.name} plan${resolved.tagline ? ` — ${resolved.tagline}` : ''}. The updated package now includes:`,
      ...features.map((f) => `• ${f}`),
      'Your price has not changed — this is only about what\u2019s included. The update is already in effect on your account.',
    ];
    const subject = `Your Bitpype ${resolved.name} plan — what's included has been updated`;
    const res = await sendClaimed(deps, {
      refKey: `contents_notice:${planId}:${hash}:${user.id}`,
      kind: 'contents_notice',
      userId: user.id,
      mail: {
        to: user.email,
        subject,
        title: subject,
        preheader: `The ${resolved.name} package contents have been updated.`,
        paragraphs,
        text: paragraphs.join('\n\n'),
        cta: { url: manageUrl(deps), label: 'View your plan' },
      },
    });
    if (res.sent) sent++;
  }
  return { sent, considered, plan: planId, hash };
}

/* ------------------------------ ticker ----------------------------- */

let sweepStarted = false;
function startLifecycleTicker() {
  if (sweepStarted) return;
  sweepStarted = true;
  const ms = Math.max(60000, Number(process.env.LIFECYCLE_COMMS_SWEEP_MS || 3600000));
  const run = () =>
    runSweep().catch((e) => console.warn('[lifecycleComms] sweep:', e && e.message));
  const first = setTimeout(run, Math.max(30000, Number(process.env.LIFECYCLE_COMMS_FIRST_SWEEP_MS || 240000)));
  if (first.unref) first.unref();
  const timer = setInterval(run, ms);
  if (timer.unref) timer.unref();
  console.log('[lifecycleComms] sweep ticker started (hourly; first pass in ~4 min)');
}

module.exports = {
  ensureCommsTables,
  sendClaimed,
  formatMoney,
  formatDateLong,
  sendCancelConfirmation,
  clearCancelClaims,
  sendTerminationNotice,
  sendPaymentFailedEmail,
  sendFirstPaymentReceipt,
  notifyDomainEvent,
  runSubscriptionSweep,
  runDomainSweep,
  runRentalStatements,
  runSweep,
  sendPlanContentsNotice,
  startLifecycleTicker,
};
