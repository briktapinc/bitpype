'use strict';

/**
 * Domain Purchase → Live flow (Batch 15).
 *
 * An interested client opens a tokenized picker page (HMAC interest token,
 * action 'd' — same trust pattern as the claim page), picks a domain whose
 * registration price fits the included cap (platform setting
 * domain_flow.included_max_usd, default $25), chooses a plan, and checks out
 * through the EXISTING plan billing path. The domain is included in the first
 * plan payment — there is no separate domain charge. Stripe metadata
 * (domain_transaction_id / domain_workspace_id) lets the billing webhook find
 * the transaction: on paid, the admin gets ONE email deep-linking the
 * transaction in the staff Domains page, where "Complete registration & go
 * live" runs registerDomain → linkDomainToWebsite (which publishes) → live,
 * then emails the client.
 *
 * Registrar prices come from src/cfDomains (Cloudflare bills the platform's
 * Cloudflare account at registration time — the admin always sees the true
 * registrar cost on the transaction; premium domains above the cap are shown
 * to the client but are NOT selectable, so BitPype never silently eats one).
 */

const cfDomains = require('../src/cfDomains');
const outreach = require('../src/outreach');
const claimKit = require('../src/claimKit');
const { getPlan, normalizePlanId, isPaidPlan } = require('./plans');
const { staffUrl } = require('./appUrls');

const DEFAULT_INCLUDED_MAX_USD = 25;
const STALE_PENDING_HOURS = 72;
const STATUSES = ['pending_payment', 'paid', 'registering', 'live', 'failed'];

function fail(code, message, extra) {
  const e = new Error(message);
  e.code = code;
  if (extra && typeof extra === 'object') Object.assign(e, extra);
  return e;
}

// ---------------------------------------------------------------------------
// Tables + row helpers
// ---------------------------------------------------------------------------

function ensureTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS domain_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      website_id INTEGER,
      domain TEXT NOT NULL,
      registrar_price_cents INTEGER,
      registrar_currency TEXT DEFAULT 'USD',
      plan_id TEXT NOT NULL,
      billing_user_id INTEGER,
      stripe_session_id TEXT,
      stripe_subscription_id TEXT,
      stripe_customer_id TEXT,
      amount_paid_cents INTEGER,
      status TEXT NOT NULL DEFAULT 'pending_payment',
      error TEXT,
      steps_json TEXT DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      paid_at TEXT,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_domain_txn_lead ON domain_transactions(lead_id);
    CREATE INDEX IF NOT EXISTS idx_domain_txn_status ON domain_transactions(status);
  `);
}

function parseSteps(row) {
  try {
    const s = JSON.parse((row && row.steps_json) || '[]');
    return Array.isArray(s) ? s : [];
  } catch {
    return [];
  }
}

function displayStatus(row) {
  if (!row) return '';
  if (row.status === 'pending_payment' && row.created_at) {
    const t = Date.parse(String(row.created_at).replace(' ', 'T') + 'Z');
    if (Number.isFinite(t) && Date.now() - t > STALE_PENDING_HOURS * 3600 * 1000) return 'abandoned';
  }
  return row.status;
}

function publicTxn(row) {
  if (!row) return null;
  return {
    id: row.id,
    leadId: row.lead_id,
    websiteId: row.website_id,
    domain: row.domain,
    registrarPriceCents: row.registrar_price_cents,
    registrarCurrency: row.registrar_currency || 'USD',
    planId: row.plan_id,
    planName: (getPlan(normalizePlanId(row.plan_id)) || {}).name || row.plan_id,
    billingUserId: row.billing_user_id,
    stripeSessionId: row.stripe_session_id || null,
    stripeSubscriptionId: row.stripe_subscription_id || null,
    stripeCustomerId: row.stripe_customer_id || null,
    amountPaidCents: row.amount_paid_cents,
    status: row.status,
    displayStatus: displayStatus(row),
    error: row.error || null,
    steps: parseSteps(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    paidAt: row.paid_at,
    completedAt: row.completed_at,
    leadName: row.lead_name != null ? row.lead_name : undefined,
    leadEmail: row.lead_email != null ? row.lead_email : undefined,
    websiteName: row.website_name != null ? row.website_name : undefined,
  };
}

function getTransaction(db, id) {
  ensureTables(db);
  const row = db.prepare('SELECT * FROM domain_transactions WHERE id = ?').get(Number(id));
  return row || null;
}

function createTransaction(db, { leadId, websiteId, domain, registrarPriceCents, registrarCurrency, planId }) {
  ensureTables(db);
  const lid = Number(leadId);
  if (!Number.isInteger(lid) || lid <= 0) throw fail('INVALID', 'leadId is required');
  const normalized = cfDomains.normalizeDomain(domain);
  if (!normalized) throw fail('INVALID', 'Invalid domain name.');
  const plan = normalizePlanId(planId);
  if (!isPaidPlan(plan)) throw fail('INVALID_PLAN', 'Choose Standard, Pro, or Premium');
  const res = db
    .prepare(
      `INSERT INTO domain_transactions
         (lead_id, website_id, domain, registrar_price_cents, registrar_currency, plan_id, steps_json)
       VALUES (?, ?, ?, ?, ?, ?, '[]')`
    )
    .run(
      lid,
      websiteId != null ? Number(websiteId) : null,
      normalized,
      registrarPriceCents != null ? Math.round(Number(registrarPriceCents)) : null,
      String(registrarCurrency || 'USD').toUpperCase().slice(0, 8),
      plan
    );
  appendStep(db, res.lastInsertRowid, 'created', true, `Transaction created for ${normalized} (${plan})`);
  return getTransaction(db, res.lastInsertRowid);
}

function patchTransaction(db, id, patch) {
  ensureTables(db);
  const cols = [];
  const vals = [];
  const allowed = {
    website_id: 'website_id',
    billing_user_id: 'billing_user_id',
    stripe_session_id: 'stripe_session_id',
    stripe_subscription_id: 'stripe_subscription_id',
    stripe_customer_id: 'stripe_customer_id',
    amount_paid_cents: 'amount_paid_cents',
    status: 'status',
    error: 'error',
    paid_at: 'paid_at',
    completed_at: 'completed_at',
  };
  for (const [k, col] of Object.entries(allowed)) {
    if (patch[k] !== undefined) {
      cols.push(`${col} = ?`);
      vals.push(patch[k]);
    }
  }
  if (!cols.length) return getTransaction(db, id);
  db.prepare(
    `UPDATE domain_transactions SET ${cols.join(', ')}, updated_at = datetime('now') WHERE id = ?`
  ).run(...vals, Number(id));
  return getTransaction(db, id);
}

function appendStep(db, id, step, ok, detail) {
  ensureTables(db);
  const row = getTransaction(db, id);
  if (!row) return null;
  const steps = parseSteps(row);
  steps.push({ step: String(step), ok: !!ok, detail: detail ? String(detail).slice(0, 500) : '', at: new Date().toISOString() });
  db.prepare(
    `UPDATE domain_transactions SET steps_json = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(JSON.stringify(steps), Number(id));
  return getTransaction(db, id);
}

/** pending_payment → paid. Idempotent: a second paid signal changes nothing. */
function markPaid(db, id, { subscriptionId, customerId, amountCents } = {}) {
  ensureTables(db);
  const row = getTransaction(db, id);
  if (!row) throw fail('NOT_FOUND', 'Domain transaction not found');
  if (row.status !== 'pending_payment') return { txn: row, changed: false };
  const updated = patchTransaction(db, id, {
    status: 'paid',
    stripe_subscription_id: subscriptionId || row.stripe_subscription_id || null,
    stripe_customer_id: customerId || row.stripe_customer_id || null,
    amount_paid_cents: amountCents != null ? Math.round(Number(amountCents)) : row.amount_paid_cents,
    error: null,
  });
  db.prepare(`UPDATE domain_transactions SET paid_at = datetime('now') WHERE id = ?`).run(Number(id));
  appendStep(db, id, 'payment', true, 'Plan payment received (Stripe webhook)');
  return { txn: getTransaction(db, id), changed: true };
}

// ---------------------------------------------------------------------------
// Money / included-cap rules
// ---------------------------------------------------------------------------

function priceToCents(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

function moneyText(cents) {
  if (cents == null || !Number.isFinite(Number(cents))) return '—';
  return `$${(Number(cents) / 100).toFixed(2)}`;
}

/** A domain is included when it is registrable, priced, USD, and ≤ the cap. */
function isIncludedPrice(priceCents, currency, capUsd) {
  if (priceCents == null) return false;
  const cur = String(currency || 'USD').toUpperCase();
  if (cur !== 'USD') return false;
  const cap = Number(capUsd);
  const capCents = Math.round((Number.isFinite(cap) && cap > 0 ? cap : DEFAULT_INCLUDED_MAX_USD) * 100);
  return priceCents <= capCents;
}

function annotateDomain(d, capUsd) {
  const priceCents = priceToCents(d && d.registrationCost);
  const currency = String((d && d.currency) || 'USD').toUpperCase();
  const registrable = !!(d && d.registrable);
  const included = registrable && isIncludedPrice(priceCents, currency, capUsd);
  let label;
  if (!registrable) label = (d && d.reason) || 'Not available';
  else if (included) label = 'Included with your plan';
  else label = 'Premium domain — contact us';
  return {
    domain: d && d.domain,
    registrable,
    reason: (d && d.reason) || null,
    tier: (d && d.tier) || null,
    currency,
    registrationCost: d ? d.registrationCost : null,
    renewalCost: d ? d.renewalCost : null,
    priceCents,
    included,
    selectable: included,
    label,
  };
}

async function resolveIncludedCapUsd(deps = {}) {
  try {
    const platform = deps.platform || require('./platform');
    const raw = await platform.getPlatformSetting('domain_flow.included_max_usd', String(DEFAULT_INCLUDED_MAX_USD));
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  } catch {
    /* fall through to the default */
  }
  return DEFAULT_INCLUDED_MAX_USD;
}

// ---------------------------------------------------------------------------
// Tokens + picker (public, tokenized per lead — claim-page trust pattern)
// ---------------------------------------------------------------------------

function verifyDomainToken(token) {
  const verified = outreach.verifyInterestToken(token);
  if (verified.action !== 'domain') {
    throw fail('INVALID_TOKEN', 'Not a domain picker link');
  }
  return { workspaceId: verified.workspaceId, leadId: verified.leadId };
}

function buildPickerUrl(workspaceId, leadId) {
  return claimKit.buildDomainPickerUrl(workspaceId, leadId);
}

function leadRow(db, leadId) {
  return db
    .prepare('SELECT id, business_name, email, phone, status FROM leads WHERE id = ?')
    .get(Number(leadId));
}

function siteRow(db, leadId) {
  try {
    cfDomains.ensureTables(db);
  } catch {
    /* column add is best-effort on legacy DBs */
  }
  try {
    return (
      db
        .prepare(
          'SELECT id, name, preview_url, custom_domain FROM websites WHERE lead_id = ? ORDER BY id DESC LIMIT 1'
        )
        .get(Number(leadId)) || null
    );
  } catch {
    return (
      db
        .prepare('SELECT id, name, preview_url FROM websites WHERE lead_id = ? ORDER BY id DESC LIMIT 1')
        .get(Number(leadId)) || null
    );
  }
}

function pickerMeta(db, workspaceId, leadId) {
  ensureTables(db);
  const lead = leadRow(db, leadId);
  if (!lead) throw fail('NOT_FOUND', 'Lead not found');
  const site = siteRow(db, leadId);
  const siteName = (site && String(site.name || '').trim()) || '';
  const customDomain = (site && String(site.custom_domain || '').trim()) || '';
  const open =
    db
      .prepare(
        `SELECT * FROM domain_transactions WHERE lead_id = ?
          AND status IN ('pending_payment','paid','registering','failed')
          ORDER BY id DESC LIMIT 1`
      )
      .get(lead.id) || null;
  return {
    businessName: siteName || lead.business_name || 'Your business',
    leadId: lead.id,
    siteId: site ? site.id : null,
    siteName: siteName || null,
    hasEmail: !!(lead.email && String(lead.email).trim()),
    hasCustomDomain: !!customDomain,
    customDomain: customDomain || null,
    openTransaction: open ? publicTxn(open) : null,
  };
}

async function searchPicker(db, leadId, query, capUsd) {
  const result = await cfDomains.searchDomains(db, query, { limit: 20 });
  try {
    cfDomains.recordSearchIntent(db, leadId, query);
  } catch {
    /* best-effort */
  }
  return {
    query: result.query,
    capUsd,
    domains: (result.domains || []).map((d) => annotateDomain(d, capUsd)),
  };
}

/** Picker URL for a signed-in portal owner whose site has no custom domain yet. */
function pickerLinkForLead(workspaceId, leadId) {
  try {
    const { openWorkspaceDb } = require('./workspaceDb');
    const db = openWorkspaceDb(workspaceId);
    const site = siteRow(db, leadId);
    if (!site) return '';
    if (site.custom_domain && String(site.custom_domain).trim()) return '';
    return buildPickerUrl(workspaceId, leadId) || '';
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Checkout — rides the existing plan billing path
// ---------------------------------------------------------------------------

async function startCheckout(db, workspaceId, { leadId, domain, planId }, deps = {}) {
  ensureTables(db);
  const lead = leadRow(db, leadId);
  if (!lead) throw fail('NOT_FOUND', 'Lead not found');
  const normalized = cfDomains.normalizeDomain(domain);
  if (!normalized) throw fail('INVALID', 'Invalid domain name.');
  const plan = normalizePlanId(planId || 'standard');
  if (!isPaidPlan(plan)) throw fail('INVALID_PLAN', 'Choose Standard, Pro, or Premium');

  const capUsd = deps.capUsd != null ? deps.capUsd : await resolveIncludedCapUsd(deps);

  // Fresh authoritative check: availability AND the price we will be billed.
  const checked = await cfDomains.checkDomains(db, [normalized]);
  const hit = (checked.domains || []).find((d) => d.domain === normalized);
  if (!hit || !hit.registrable) {
    throw fail('NOT_AVAILABLE', `${normalized} is not available for registration right now.`);
  }
  const annotated = annotateDomain(hit, capUsd);
  if (!annotated.selectable) {
    throw fail(
      'PREMIUM_DOMAIN',
      `${normalized} is a premium domain (${moneyText(annotated.priceCents)}/yr) — contact us and we will sort it out for you.`
    );
  }

  const site = siteRow(db, leadId);
  if (!site) throw fail('NO_WEBSITE', 'No website is linked to this business yet.');
  if (site.custom_domain && String(site.custom_domain).trim()) {
    throw fail('ALREADY_LIVE', 'This site already has a domain.');
  }

  const txn = createTransaction(db, {
    leadId: lead.id,
    websiteId: site.id,
    domain: normalized,
    registrarPriceCents: annotated.priceCents,
    registrarCurrency: annotated.currency,
    planId: plan,
  });

  const email = String(lead.email || '').trim();
  if (!email) {
    appendStep(db, txn.id, 'checkout', false, 'Lead has no email address on file');
    patchTransaction(db, txn.id, { error: 'No email address on file for billing' });
    return {
      transaction: publicTxn(getTransaction(db, txn.id)),
      checkoutUrl: null,
      unavailable: true,
      message: "We don't have an email address on file for billing yet — we'll be in touch to finish setting this up.",
    };
  }

  const clientPortal = deps.clientPortal || require('./clientPortal');
  const userId = await clientPortal.ensureBillingUserForPortalClient(workspaceId, email, lead.business_name || '');
  patchTransaction(db, txn.id, { billing_user_id: Number(userId) });

  const billing = deps.billing || require('./billing');
  const appBase = String(process.env.APP_URL || '').replace(/\/$/, '');
  const pickerUrl = buildPickerUrl(workspaceId, lead.id);
  try {
    const session = await billing.createCheckoutSession(userId, plan, {
      successUrl: `${appBase}/domain-success.html?domain=${encodeURIComponent(normalized)}`,
      cancelUrl: pickerUrl || `${appBase}/`,
      metadata: {
        domain_transaction_id: String(txn.id),
        domain_workspace_id: String(workspaceId),
        domain_lead_id: String(lead.id),
        domain: normalized,
      },
    });
    patchTransaction(db, txn.id, { stripe_session_id: session.sessionId || null });
    appendStep(db, txn.id, 'checkout', true, `Plan checkout started (${plan})`);
    return { transaction: publicTxn(getTransaction(db, txn.id)), checkoutUrl: session.url, unavailable: false };
  } catch (e) {
    // Known live case: the configured stripe.price_id_* values do not resolve
    // in the platform Stripe account, so session creation throws. The client
    // gets a friendly state, the transaction stays pending_payment, and the
    // real error is kept on the transaction for the admin — never fake success.
    appendStep(db, txn.id, 'checkout', false, `Checkout unavailable: ${(e && e.message) || e}`);
    patchTransaction(db, txn.id, { error: `Checkout unavailable: ${(e && e.message) || e}` });
    return {
      transaction: publicTxn(getTransaction(db, txn.id)),
      checkoutUrl: null,
      unavailable: true,
      code: (e && e.code) || 'CHECKOUT_FAILED',
      message:
        "Checkout isn't available just yet — we've saved your domain choice and we'll be in touch to finish up.",
    };
  }
}

// ---------------------------------------------------------------------------
// Admin notification email (fired by the billing webhook on paid)
// ---------------------------------------------------------------------------

async function resolveReportEmail(db, deps = {}) {
  // Same chain as interestedFollowup/handsOff: hands_off.report_email →
  // platform support.email → tenant smtp.from_email.
  const fromSetting = outreach.getSetting(db, 'hands_off.report_email', '').trim();
  if (fromSetting) return fromSetting;
  try {
    const platform = deps.platform || require('./platform');
    const support = String((await platform.getPlatformSetting('support.email', '')) || '').trim();
    if (support) return support;
  } catch {
    /* fall through */
  }
  return outreach.getSetting(db, 'smtp.from_email', '').trim();
}

async function composeAdminPaidEmail(db, workspaceId, txnId, deps = {}) {
  const txn = getTransaction(db, txnId);
  if (!txn) throw fail('NOT_FOUND', 'Domain transaction not found');
  const lead = leadRow(db, txn.lead_id) || {};
  const site = txn.website_id
    ? db.prepare('SELECT id, name FROM websites WHERE id = ?').get(txn.website_id)
    : siteRow(db, txn.lead_id);
  const business = (site && site.name) || lead.business_name || `Lead #${txn.lead_id}`;
  const planName = (getPlan(normalizePlanId(txn.plan_id)) || {}).name || txn.plan_id;
  const to = await resolveReportEmail(db, deps);
  const link = staffUrl('domains', { txn: txn.id });
  const contact = [lead.email, lead.phone].filter(Boolean).join(' · ') || 'no contact details on file';
  const paragraphs = [
    `${business} just paid for the ${planName} plan and chose the domain ${txn.domain} (included with the plan).`,
    `Plan: ${planName} · Amount paid: ${moneyText(txn.amount_paid_cents)} · Domain registration cost: ${moneyText(txn.registrar_price_cents)}/yr (billed to the Cloudflare account when you complete the registration).`,
    `Client: ${business} — ${contact}.`,
    `Complete the registration, publish the site and make it live here: ${link}`,
  ];
  return {
    to,
    subject: `Domain purchase — ${business} chose ${txn.domain}`,
    title: 'Domain purchase — ready to complete',
    paragraphs,
    text: paragraphs.join('\n\n'),
    cta: { url: link, label: 'Open the domain transaction' },
    transactionId: txn.id,
    domain: txn.domain,
  };
}

async function defaultSendMail(mail) {
  const { sendPlatformMail } = require('./mailer');
  return sendPlatformMail(mail);
}

/**
 * Billing webhook hook: a plan checkout session carrying our metadata marks
 * the transaction paid and fires the ONE admin email. Idempotent — the
 * billing layer already claims event ids, and markPaid no-ops on repeats,
 * so the email can never fire twice for one transaction.
 */
async function onDomainCheckoutPaid(session, deps = {}) {
  const meta = (session && session.metadata) || {};
  const txnId = Number(meta.domain_transaction_id);
  const workspaceId = Number(meta.domain_workspace_id);
  if (!Number.isInteger(txnId) || txnId <= 0 || !Number.isInteger(workspaceId) || workspaceId <= 0) {
    return { skipped: true };
  }
  const openDb = deps.openDb || ((ws) => require('./workspaceDb').openWorkspaceDb(ws));
  const db = openDb(workspaceId);
  ensureTables(db);
  const subId =
    typeof session.subscription === 'string'
      ? session.subscription
      : session.subscription && session.subscription.id;
  const { changed, txn } = markPaid(db, txnId, {
    subscriptionId: subId || null,
    customerId: typeof session.customer === 'string' ? session.customer : null,
    amountCents: session.amount_total != null ? session.amount_total : null,
  });
  if (!changed) return { ok: true, duplicate: true, transactionId: txnId };
  let email = null;
  let emailError = null;
  try {
    const mail = await composeAdminPaidEmail(db, workspaceId, txnId, deps);
    if (mail.to) {
      await (deps.sendMail || defaultSendMail)(mail);
      email = { to: mail.to, subject: mail.subject };
      appendStep(db, txnId, 'admin_email', true, `Admin notified at ${mail.to}`);
    } else {
      emailError = 'No admin report recipient configured';
      appendStep(db, txnId, 'admin_email', false, emailError);
    }
  } catch (e) {
    emailError = (e && e.message) || String(e);
    try {
      appendStep(db, txnId, 'admin_email', false, emailError);
    } catch {
      /* ignore */
    }
    console.warn('[domainFlow] admin email failed for txn', txnId, emailError);
  }
  return { ok: true, transactionId: txnId, email, emailError, transaction: publicTxn(getTransaction(db, txnId)) };
}

// ---------------------------------------------------------------------------
// Admin views
// ---------------------------------------------------------------------------

function adminList(db, opts = {}) {
  ensureTables(db);
  const limit = Math.min(200, Math.max(1, Number(opts.limit) || 100));
  const rows = db
    .prepare(
      `SELECT t.*, l.business_name AS lead_name, l.email AS lead_email, w.name AS website_name
       FROM domain_transactions t
       LEFT JOIN leads l ON l.id = t.lead_id
       LEFT JOIN websites w ON w.id = t.website_id
       ORDER BY t.id DESC LIMIT ?`
    )
    .all(limit);
  return { transactions: rows.map(publicTxn) };
}

function adminDetail(db, id) {
  ensureTables(db);
  const row = db
    .prepare(
      `SELECT t.*, l.business_name AS lead_name, l.email AS lead_email, w.name AS website_name
       FROM domain_transactions t
       LEFT JOIN leads l ON l.id = t.lead_id
       LEFT JOIN websites w ON w.id = t.website_id
       WHERE t.id = ? LIMIT 1`
    )
    .get(Number(id));
  if (!row) throw fail('NOT_FOUND', 'Domain transaction not found');
  const lead = leadRow(db, row.lead_id);
  let website = null;
  if (row.website_id) {
    try {
      website =
        db
          .prepare('SELECT id, name, custom_domain, preview_url, status FROM websites WHERE id = ?')
          .get(row.website_id) || null;
    } catch {
      website = null;
    }
  }
  return {
    transaction: publicTxn(row),
    lead: lead
      ? { id: lead.id, businessName: lead.business_name, email: lead.email, phone: lead.phone, status: lead.status }
      : null,
    website: website
      ? {
          id: website.id,
          name: website.name,
          customDomain: website.custom_domain || null,
          previewUrl: website.preview_url || null,
          status: website.status,
        }
      : null,
    staffLink: staffUrl('domains', { txn: row.id }),
  };
}

// ---------------------------------------------------------------------------
// Completion — register → link (+publish) → live. Idempotent per step.
// ---------------------------------------------------------------------------

async function composeClientLiveEmail(db, txn) {
  const lead = leadRow(db, txn.lead_id) || {};
  const site = txn.website_id
    ? db.prepare('SELECT id, name FROM websites WHERE id = ?').get(txn.website_id)
    : siteRow(db, txn.lead_id);
  const business = (site && site.name) || lead.business_name || 'Your business';
  const appBase = String(process.env.APP_URL || '').replace(/\/$/, '');
  const liveUrl = `https://${txn.domain}`;
  const paragraphs = [
    `Good news — the website for ${business} is now live at ${liveUrl}.`,
    `Your domain ${txn.domain} is registered and connected, and the site is published.`,
    `Manage your site, request changes and check messages any time in your client portal: ${appBase}/portal — click "Request access", enter this email address, and we'll send you a one-time sign-in link.`,
    'Just reply to this email if you would like anything changed.',
  ];
  return {
    to: String(lead.email || '').trim(),
    subject: `Your website is live at ${txn.domain}`,
    title: 'Your website is live',
    paragraphs,
    text: paragraphs.join('\n\n'),
    cta: { url: liveUrl, label: 'Visit your website' },
    domain: txn.domain,
  };
}

async function completeTransaction(db, workspaceId, txnId, deps = {}) {
  const cf = deps.cf || cfDomains;
  ensureTables(db);
  cf.ensureTables(db);
  let txn = getTransaction(db, txnId);
  if (!txn) throw fail('NOT_FOUND', 'Domain transaction not found');
  if (txn.status === 'live') {
    return { transaction: publicTxn(txn), completed: true, already: true };
  }
  if (txn.status !== 'paid' && txn.status !== 'failed') {
    throw fail('INVALID_STATE', `Transaction is ${txn.status} — only a paid transaction can be completed.`);
  }
  patchTransaction(db, txnId, { status: 'registering', error: null });
  appendStep(db, txnId, 'complete_started', true, txn.status === 'failed' ? 'Retry started' : 'Completion started');

  const runStep = async (name, fn) => {
    try {
      const r = await fn();
      appendStep(db, txnId, name, true, (r && r.detail) || 'done');
      return r;
    } catch (e) {
      appendStep(db, txnId, name, false, (e && e.message) || String(e));
      throw e;
    }
  };

  try {
    // Step 1 — register the domain (skip when CF already has it).
    await runStep('register', async () => {
      const existing = db
        .prepare('SELECT * FROM site_domains WHERE domain_name = ? ORDER BY id DESC LIMIT 1')
        .get(txn.domain);
      if (existing && (existing.status === 'registered' || existing.status === 'linked')) {
        return { detail: `Already ${existing.status} at Cloudflare — skipped` };
      }
      if (existing && existing.status === 'registering') {
        const st = await cf.registrationStatus(db, txn.domain);
        if (st && st.state === 'succeeded') return { detail: 'Registration confirmed at Cloudflare — skipped' };
        if (st && st.state && st.state !== 'failed') {
          throw fail('IN_PROGRESS', `Registration for ${txn.domain} is still in progress at Cloudflare — retry in a few minutes.`);
        }
        // state failed → fall through and register again.
      }
      const r = await cf.registerDomain(db, txn.domain, { leadId: txn.lead_id, websiteId: txn.website_id });
      if (r && r.status !== 'registered') {
        const st = await cf.registrationStatus(db, txn.domain).catch(() => null);
        if (!st || st.state !== 'succeeded') {
          throw fail(
            'IN_PROGRESS',
            `Registration for ${txn.domain} started at Cloudflare but has not finished yet — retry in a few minutes.`
          );
        }
      }
      return { detail: `Registered ${txn.domain} (${(r && r.price) || moneyText(txn.registrar_price_cents)}/yr)` };
    });

    // Step 2 — link to the site (publishes first via the injected publishSite).
    await runStep('link', async () => {
      const site = txn.website_id
        ? db.prepare('SELECT id, custom_domain FROM websites WHERE id = ?').get(txn.website_id)
        : null;
      const domRow = db
        .prepare('SELECT * FROM site_domains WHERE domain_name = ? ORDER BY id DESC LIMIT 1')
        .get(txn.domain);
      if (site && String(site.custom_domain || '') === txn.domain && domRow && domRow.status === 'linked') {
        return { detail: 'Already linked — skipped' };
      }
      if (!txn.website_id) throw fail('NO_WEBSITE', 'Transaction has no website to link.');
      if (typeof deps.publishSite !== 'function') {
        throw fail('MISCONFIGURED', 'publishSite dependency is required to link + publish');
      }
      const r = await cf.linkDomainToWebsite(db, {
        domain: txn.domain,
        websiteId: txn.website_id,
        leadId: txn.lead_id,
        workspaceId,
        forcePublish: true,
        source: 'domain_flow',
        publishFn: (websiteId, project) => deps.publishSite(db, websiteId, project),
      });
      return { detail: `Linked ${txn.domain} → ${r.publicUrl} (project ${r.project}), site published` };
    });

    // Step 3 — live.
    patchTransaction(db, txnId, { status: 'live', error: null });
    db.prepare(`UPDATE domain_transactions SET completed_at = datetime('now') WHERE id = ?`).run(Number(txnId));
    appendStep(db, txnId, 'live', true, `Site is live at https://${txn.domain}`);
    txn = getTransaction(db, txnId);

    // Client "your site is live" email — best effort, never un-lives the site.
    let clientEmail = null;
    let clientEmailError = null;
    try {
      const mail = await composeClientLiveEmail(db, txn);
      if (mail.to) {
        await (deps.sendMail || defaultSendMail)(mail);
        clientEmail = { to: mail.to, subject: mail.subject };
        appendStep(db, txnId, 'client_email', true, `Client emailed at ${mail.to}`);
      }
    } catch (e) {
      clientEmailError = (e && e.message) || String(e);
      try {
        appendStep(db, txnId, 'client_email', false, clientEmailError);
      } catch {
        /* ignore */
      }
    }
    return {
      transaction: publicTxn(getTransaction(db, txnId)),
      completed: true,
      clientEmail,
      clientEmailError,
    };
  } catch (e) {
    patchTransaction(db, txnId, { status: 'failed', error: (e && e.message) || String(e) });
    return {
      transaction: publicTxn(getTransaction(db, txnId)),
      completed: false,
      error: (e && e.message) || String(e),
      code: (e && e.code) || undefined,
    };
  }
}

module.exports = {
  DEFAULT_INCLUDED_MAX_USD,
  STATUSES,
  ensureTables,
  createTransaction,
  getTransaction,
  patchTransaction,
  appendStep,
  markPaid,
  priceToCents,
  moneyText,
  isIncludedPrice,
  annotateDomain,
  resolveIncludedCapUsd,
  verifyDomainToken,
  buildPickerUrl,
  pickerMeta,
  searchPicker,
  pickerLinkForLead,
  startCheckout,
  resolveReportEmail,
  composeAdminPaidEmail,
  onDomainCheckoutPaid,
  composeClientLiveEmail,
  adminList,
  adminDetail,
  completeTransaction,
  publicTxn,
  displayStatus,
};
