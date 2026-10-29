'use strict';

/**
 * Batch 61 — signup plan step + welcome email.
 *
 * Registration used to create the account and stop: the new owner landed
 * on Free by default with no plan moment and no word from us. Now the
 * register payload may carry a plan choice (from the Register tab's plan
 * step, fed by GET /auth/plans = billing.catalogForApi verbatim, so
 * Batch 57 contents + Batch 24 pricing edits flow through untouched):
 *
 *   - no plan / 'free'  → the choice is persisted as Free (the no-card
 *     default; Free always has core access) and nothing else happens.
 *   - a paid plan       → the choice is persisted as checkout_pending and
 *     a Stripe Checkout session is created immediately through the
 *     existing billing.createCheckoutSession (same price ids from
 *     settings, same success/cancel URLs). The register response carries
 *     the checkout URL; the client redirects to it once the Batch 53
 *     MFA enrollment completes. Checkout is NEVER a gate on workspace
 *     access — if Stripe is unconfigured or errors, the choice is
 *     recorded as checkout_unavailable and registration proceeds; the
 *     owner can upgrade later from Billing exactly as before.
 *
 * The welcome email is exactly-once per account, riding an atomic claim
 * on the signup row (welcome_status pending → claimed) the way Batch
 * 36's payment-received email rides the markPaid transition: creation
 * is the only path here, a replayed register is refused as a duplicate
 * before it can reach this module, and even a direct second call loses
 * the claim. A mail failure is recorded (status 'failed' + platform
 * audit row) and never fails registration.
 *
 * Admin-created users do NOT pass through here — their invite flow is
 * the existing one and must not double-send.
 */

const { query } = require('./db');
const { PLAN_FREE, isPaidPlan, normalizePlanId, getPlan } = require('./plans');

function nowSql() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function affected(r) {
  if (!r) return 0;
  return Number(r.affectedRows != null ? r.affectedRows : r.changes) || 0;
}

async function defaultCatalog() {
  return require('./billing').catalogForApi();
}

async function defaultCreateCheckout(userId, planId) {
  return require('./billing').createCheckoutSession(userId, planId);
}

async function defaultSendMail(mail) {
  const { sendPlatformMail } = require('./mailer');
  return sendPlatformMail(mail);
}

async function defaultGetSetting(key, fallback) {
  return require('./platform').getPlatformSetting(key, fallback);
}

async function defaultAudit(userId, action, detail) {
  try {
    await require('./platform').audit(userId, action, detail);
  } catch {
    /* audit is best-effort */
  }
}

function depsOf(deps = {}) {
  return {
    query: deps.query || query,
    catalog: deps.catalog || defaultCatalog,
    createCheckout: deps.createCheckout || defaultCreateCheckout,
    sendMail: deps.sendMail || defaultSendMail,
    getSetting: deps.getSetting || defaultGetSetting,
    audit: deps.audit || defaultAudit,
    claimWelcome: deps.claimWelcome || null,
  };
}

/** The catalog entry for a requested plan id, or null when unknown. */
async function findCatalogEntry(planId, deps = {}) {
  const d = depsOf(deps);
  const catalog = await d.catalog();
  return (catalog || []).find((p) => p && p.id === planId) || null;
}

async function getChoice(userId, deps = {}) {
  const d = depsOf(deps);
  const rows = await d.query('SELECT * FROM signup_plan_choices WHERE user_id = :uid LIMIT 1', {
    uid: Number(userId),
  });
  return rows[0] || null;
}

async function insertChoice(d, { userId, workspaceId, planId, status }) {
  try {
    await d.query(
      `INSERT INTO signup_plan_choices (user_id, workspace_id, plan_id, status, welcome_status)
       VALUES (:uid, :ws, :plan, :status, 'pending')`,
      { uid: Number(userId), ws: workspaceId != null ? Number(workspaceId) : null, plan: planId, status }
    );
  } catch (e) {
    // One row per user (UNIQUE user_id): a repeat insert is the replay
    // guard doing its job — the original row stands.
    const msg = String((e && e.message) || e);
    if (!/UNIQUE|Duplicate|ER_DUP_ENTRY/i.test(msg)) throw e;
  }
}

async function updateChoice(d, userId, fields) {
  const sets = [];
  const params = { uid: Number(userId), now: nowSql() };
  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k} = :${k}`);
    params[k] = v;
  }
  sets.push('updated_at = :now');
  await d.query(`UPDATE signup_plan_choices SET ${sets.join(', ')} WHERE user_id = :uid`, params);
}

/**
 * Persist the plan choice and, for paid plans, create the checkout
 * session. Never throws for Stripe/config problems — those degrade to
 * checkout_unavailable; only programming errors propagate.
 */
async function applyPlanChoice({ userId, workspaceId, planId, catalogEntry }, deps = {}) {
  const d = depsOf(deps);
  const plan = normalizePlanId(planId || PLAN_FREE);
  if (!isPaidPlan(plan)) {
    await insertChoice(d, { userId, workspaceId, planId: PLAN_FREE, status: 'free' });
    return { plan: PLAN_FREE, status: 'free', checkoutUrl: null, checkoutError: null };
  }
  await insertChoice(d, { userId, workspaceId, planId: plan, status: 'checkout_pending' });
  const entry = catalogEntry || (await findCatalogEntry(plan, deps));
  if (!entry || !entry.checkout || !entry.priceConfigured) {
    await updateChoice(d, userId, { status: 'checkout_unavailable', checkout_error: 'PRICE_NOT_CONFIGURED' });
    return { plan, status: 'checkout_unavailable', checkoutUrl: null, checkoutError: 'PRICE_NOT_CONFIGURED' };
  }
  try {
    const session = await d.createCheckout(Number(userId), plan);
    await updateChoice(d, userId, {
      checkout_session_id: session && session.sessionId ? String(session.sessionId) : null,
      checkout_url: session && session.url ? String(session.url) : null,
    });
    return { plan, status: 'checkout_pending', checkoutUrl: session ? session.url || null : null, checkoutError: null };
  } catch (e) {
    const code = (e && e.code) || 'CHECKOUT_FAILED';
    console.warn('[signup] checkout creation failed for user', userId, plan, code, (e && e.message) || e);
    await updateChoice(d, userId, { status: 'checkout_unavailable', checkout_error: String(code) });
    return { plan, status: 'checkout_unavailable', checkoutUrl: null, checkoutError: String(code) };
  }
}

/** Atomic exactly-once claim: pending → claimed. True only for the winner. */
async function claimWelcomeRow(d, userId) {
  const r = await d.query(
    `UPDATE signup_plan_choices SET welcome_status = 'claimed', updated_at = :now
      WHERE user_id = :uid AND welcome_status = 'pending'`,
    { uid: Number(userId), now: nowSql() }
  );
  return affected(r) > 0;
}

async function composeWelcome({ name, workspaceName, planId, checkoutUrl }, deps = {}) {
  const d = depsOf(deps);
  const plan = getPlan(planId || PLAN_FREE);
  const publicUrl = String(require('./stripeClient').appUrl() || '').replace(/\/$/, '');
  const support = String((await d.getSetting('support.email', '')) || '').trim();
  const first = String(name || '').trim().split(/\s+/)[0] || 'there';
  const paragraphs = [
    `Hi ${first} — welcome to BitPype. Your workspace${workspaceName ? ` “${workspaceName}”` : ''} is ready.`,
    'BitPype is the desk for a local-business website practice: find leads, build and launch their sites, register their domains, track their calls, and follow up — all in one place.',
  ];
  if (isPaidPlan(planId)) {
    paragraphs.push(
      checkoutUrl
        ? `You picked the ${plan.name} plan. One step left: finish checkout to activate it — your workspace is already open either way, and nothing is charged until you complete it.`
        : `You picked the ${plan.name} plan. You can activate it any time from Settings → Billing inside the app — your workspace is already open on Free in the meantime.`
    );
  } else {
    paragraphs.push(
      `You're on the ${plan.name} plan — no card needed, and core access is included. You can upgrade any time from Settings → Billing.`
    );
  }
  paragraphs.push(
    support
      ? `Next steps: sign in, confirm your plan, and add your first lead. Questions any time — reply to this email or write to ${support}.`
      : 'Next steps: sign in, confirm your plan, and add your first lead. Questions any time — just reply to this email.'
  );
  return {
    subject: 'Welcome to BitPype — your workspace is ready',
    title: 'Welcome to BitPype',
    paragraphs,
    text: paragraphs.join('\n\n'),
    cta: publicUrl ? { url: publicUrl, label: 'Sign in to BitPype' } : undefined,
  };
}

/**
 * Send the welcome email exactly once. Returns a report object; never
 * throws — a mail failure is a recorded warning, not a failed signup.
 */
async function sendWelcomeEmail({ userId, workspaceId, email, name, workspaceName, planId, checkoutUrl }, deps = {}) {
  const d = depsOf(deps);
  const to = String(email || '').trim();
  if (!to) return { sent: false, reason: 'no_email' };
  const claimed = d.claimWelcome ? await d.claimWelcome(Number(userId)) : await claimWelcomeRow(d, Number(userId));
  if (!claimed) return { sent: false, reason: 'already_claimed' };
  try {
    const mail = await composeWelcome({ name, workspaceName, planId, checkoutUrl }, deps);
    await d.sendMail({ to, ...mail });
    await updateChoice(d, Number(userId), { welcome_status: 'sent', welcome_sent_at: nowSql() });
    await d.audit(Number(userId), 'signup.welcome_email', `user=${userId} ws=${workspaceId} plan=${planId || PLAN_FREE}`);
    return { sent: true };
  } catch (e) {
    const msg = String((e && e.message) || e);
    console.warn('[signup] welcome email failed for user', userId, msg);
    try {
      await updateChoice(d, Number(userId), { welcome_status: 'failed' });
    } catch {
      /* the row may not exist in a stubbed-deps test — the audit row below still records it */
    }
    await d.audit(Number(userId), 'signup.welcome_email_failed', `user=${userId} error=${msg.slice(0, 200)}`);
    return { sent: false, reason: 'send_failed', error: msg };
  }
}

/**
 * The register route's one call: persist the choice (+ checkout) and
 * fire the welcome email. Best-effort by contract — returns a report
 * and swallows its own failures so registration can never break here.
 */
async function afterSignup(input, deps = {}) {
  const planId = normalizePlanId(input.planId || PLAN_FREE);
  let planChoice;
  try {
    planChoice = await applyPlanChoice(
      { userId: input.userId, workspaceId: input.workspaceId, planId, catalogEntry: input.catalogEntry },
      deps
    );
  } catch (e) {
    console.warn('[signup] plan choice failed for user', input.userId, (e && e.message) || e);
    planChoice = { plan: planId, status: 'error', checkoutUrl: null, checkoutError: 'INTERNAL' };
  }
  let welcome;
  try {
    welcome = await sendWelcomeEmail(
      { ...input, planId, checkoutUrl: planChoice.checkoutUrl },
      deps
    );
  } catch (e) {
    console.warn('[signup] welcome step failed for user', input.userId, (e && e.message) || e);
    welcome = { sent: false, reason: 'internal_error' };
  }
  return { planChoice, welcome };
}

module.exports = {
  afterSignup,
  applyPlanChoice,
  sendWelcomeEmail,
  composeWelcome,
  findCatalogEntry,
  getChoice,
  _internals: { claimWelcomeRow, insertChoice, updateChoice },
};
