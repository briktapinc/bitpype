// @ts-check
'use strict';

/**
 * Batch 111 (consolidation step 4) — portal billing + change requests: billing view, checkout, plan changes, credits.
 * PURE code motion from server/clientPortal.js (no logic edits);
 * server/clientPortal.js re-exports the full original surface.
 */

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { query, driver } = require('./db');
const { appUrl } = require('./stripeClient');
const { normalizeEmail, findByEmail, login } = require('./portalAccounts');

async function submitChangeRequest(workspaceId, leadId, clientEmail, body = {}) {
  const domain = require('./domain');
  const designJobs = require('../src/designJobs');
  const message = String(body.message || body.instructions || '').trim();
  const kind = String(body.kind || 'improvements').toLowerCase() === 'redesign' ? 'redesign' : 'improvements';

  if (!message) {
    throw Object.assign(new Error('Describe the changes you need'), { code: 'EMPTY' });
  }

  return domain.withDb(workspaceId, async (db) => {
    designJobs.ensureTables(db);
    let job = db.prepare(`SELECT * FROM design_jobs WHERE lead_id = ? ORDER BY id DESC LIMIT 1`).get(Number(leadId));

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
    const result = await query(`INSERT INTO users (email, password_hash, name) VALUES (:email, :hash, :name)`, {
      email: e,
      hash,
      name: name.slice(0, 120),
    });
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
  // Billing linkage only — never promote portal clients to owner/admin.
  if (!members[0]) {
    await query(
      `INSERT IGNORE INTO workspace_members (workspace_id, user_id, role)
       VALUES (:ws, :uid, 'member')`,
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
  const workspacePlanId = await billing.workspacePlan(workspaceId);

  let selfBilling = null;
  const e = normalizeEmail(clientEmail);
  if (e) {
    const rows = await query(
      `SELECT id, email, subscription_status, billing_plan, current_period_end,
              stripe_customer_id, stripe_subscription_id,
              is_super_admin, status, deleted_at
       FROM users WHERE email = :email LIMIT 1`,
      { email: e }
    );
    if (rows[0]) selfBilling = rows[0];
  }

  const statusSource = selfBilling || subscribedOwner;
  const selfPlan = selfBilling ? billing.planOfUser(selfBilling) : workspacePlanId;
  const selfSubscribed = !!(selfBilling && billing.isSubscribed(selfBilling));
  // Agency-covered workspace (someone else's paid plan) — contact us to change.
  // Free / self-owned billing — client can subscribe or manage via Stripe.
  const coveredByOthers = workspaceSubscribed && !selfSubscribed;
  const canSelfServe = !coveredByOthers;

  let cancelAtPeriodEnd = false;
  if (selfSubscribed && selfBilling && selfBilling.stripe_customer_id) {
    const live = await billing.getLiveSubscription(selfBilling);
    cancelAtPeriodEnd = !!(live && live.cancel_at_period_end);
  }

  const creditInfo = await require('./credits').summaryForWorkspace(workspaceId);

  // Batch 119: an active suspension episode surfaces on the portal
  // Billing payload — the one panel a suspended owner can still use.
  // Resolution is by the client's own billing user only; a workspace
  // covered by someone else's plan never shows their suspension.
  let suspension = null;
  if (selfBilling) {
    try {
      const ep = await require('./subscriptionSuspension').getActiveSuspensionForUser(selfBilling.id);
      if (ep) {
        suspension = {
          suspended: true,
          suspendedAt: ep.suspended_at || null,
          reason: ep.reason || null,
          selfServe: canSelfServe,
        };
      }
    } catch {
      suspension = null;
    }
  }

  // Entitlements: max(workspace owners, self). Display: self when self-serve, else workspace.
  const planId = await billing.effectivePlan(workspaceId, { email: clientEmail });
  const displayPlan = canSelfServe && selfBilling ? selfPlan : workspacePlanId;
  const displayPlanObj = getPlan(displayPlan);

  const entitlementPlan = getPlan(planId);
  return {
    workspaceSubscribed,
    plan: displayPlan,
    planName: displayPlanObj.name,
    entitlements: { ...entitlementPlan.entitlements },
    entitlementPlan: planId,
    plans: await billing.catalogForApi(),
    subscriptionStatus: statusSource
      ? statusSource.subscription_status || (workspaceSubscribed ? 'active' : displayPlan === 'free' ? 'free' : 'none')
      : workspaceSubscribed
        ? 'active'
        : displayPlan === 'free'
          ? 'free'
          : 'none',
    currentPeriodEnd: statusSource ? statusSource.current_period_end : null,
    cancelAtPeriodEnd,
    canManage: canSelfServe,
    canSelfServe,
    hasCustomer: !!(selfBilling && selfBilling.stripe_customer_id),
    hasActiveSubscription: selfSubscribed,
    billingUserId: selfBilling ? selfBilling.id : null,
    selfPlan,
    amountLabel: await require('./platform').getPlatformSetting('billing.amount_label', 'Bitpype plans'),
    suspension,
    notice: suspension
      ? 'This account is suspended because a subscription payment failed, and your website is currently unavailable to visitors. Renew below to bring everything back — your site returns exactly as it was.'
      : coveredByOthers
        ? 'Your service is active under your Bitpype plan. Contact us to change billing.'
        : cancelAtPeriodEnd
          ? 'Cancellation scheduled — you keep access until the period ends, then move to Free.'
          : null,
    credits: creditInfo,
  };
}

async function openBillingPortal(workspaceId, clientEmail) {
  const info = await billingForClient(workspaceId, clientEmail);
  if (!info.canSelfServe) {
    throw Object.assign(new Error(info.notice || 'Billing is managed by your Bitpype account manager'), {
      code: 'NO_SELF_BILLING',
    });
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
      forceCheckout: true,
      successUrl: `${base()}/portal?checkout=success&plan=standard`,
      cancelUrl: `${base()}/portal?checkout=cancel`,
    });
  }
  const stripe = await getStripe();
  const session = await stripe.billingPortal.sessions.create(
    {
      customer: user.stripe_customer_id,
      return_url: `${base()}/portal`,
    },
    // Batch 154 (§9): deterministic idempotency key (customer + destination).
    {
      idempotencyKey: require('./stripeIdempotency').stripeIdempotencyKey('billing-portal', user.stripe_customer_id, 'portal'),
    }
  );
  return { url: session.url };
}

async function openCheckout(workspaceId, clientEmail, planId = 'standard') {
  const info = await billingForClient(workspaceId, clientEmail);
  if (!info.canSelfServe) {
    throw Object.assign(new Error(info.notice || 'Billing is managed by your Bitpype account manager'), {
      code: 'NO_SELF_BILLING',
    });
  }
  const portalUser = await findByEmail(clientEmail);
  const userId = await ensureBillingUserForPortalClient(
    workspaceId,
    clientEmail,
    portalUser && portalUser.business_name
  );
  const { appUrl: base } = require('./stripeClient');
  const plan = planId || 'standard';
  // First subscribe → Checkout; already subscribed → proration update (no second Checkout).
  return require('./billing').startOrChangePlan(userId, plan, {
    successUrl: `${base()}/portal?checkout=success&plan=${encodeURIComponent(plan)}`,
    cancelUrl: `${base()}/portal?checkout=cancel`,
  });
}

async function changePlan(workspaceId, clientEmail, planId) {
  const info = await billingForClient(workspaceId, clientEmail);
  if (!info.canSelfServe) {
    throw Object.assign(new Error(info.notice || 'Billing is managed by your Bitpype account manager'), {
      code: 'NO_SELF_BILLING',
    });
  }
  const portalUser = await findByEmail(clientEmail);
  const userId = await ensureBillingUserForPortalClient(
    workspaceId,
    clientEmail,
    portalUser && portalUser.business_name
  );
  const { appUrl: base } = require('./stripeClient');
  const plan = planId || 'standard';
  return require('./billing').startOrChangePlan(userId, plan, {
    successUrl: `${base()}/portal?checkout=success&plan=${encodeURIComponent(plan)}`,
    cancelUrl: `${base()}/portal?checkout=cancel`,
  });
}

async function cancelToFree(workspaceId, clientEmail) {
  return changePlan(workspaceId, clientEmail, 'free');
}

async function resumeBilling(workspaceId, clientEmail) {
  const info = await billingForClient(workspaceId, clientEmail);
  if (!info.canSelfServe) {
    throw Object.assign(new Error(info.notice || 'Billing is managed by your Bitpype account manager'), {
      code: 'NO_SELF_BILLING',
    });
  }
  const portalUser = await findByEmail(clientEmail);
  const userId = await ensureBillingUserForPortalClient(
    workspaceId,
    clientEmail,
    portalUser && portalUser.business_name
  );
  return require('./billing').resumeSubscription(userId);
}

async function openCreditsCheckout(workspaceId, clientEmail, quantity = 1) {
  const info = await billingForClient(workspaceId, clientEmail);
  if (!info.canSelfServe) {
    throw Object.assign(new Error(info.notice || 'Billing is managed by your Bitpype account manager'), {
      code: 'NO_SELF_BILLING',
    });
  }
  const portalUser = await findByEmail(clientEmail);
  const userId = await ensureBillingUserForPortalClient(
    workspaceId,
    clientEmail,
    portalUser && portalUser.business_name
  );
  const { appUrl: base } = require('./stripeClient');
  return require('./billing').createCreditsCheckoutSession(userId, workspaceId, {
    quantity,
    successUrl: `${base()}/portal?checkout=credits_success`,
    cancelUrl: `${base()}/portal?checkout=cancel`,
  });
}


module.exports = {
  submitChangeRequest,
  ensureBillingUserForPortalClient,
  billingForClient,
  openBillingPortal,
  openCheckout,
  changePlan,
  cancelToFree,
  resumeBilling,
  openCreditsCheckout,
};
