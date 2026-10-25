'use strict';

/**
 * Interested follow-up email (hands-off mode).
 *
 * When a lead signals "interested" — via the outreach email {{interested}}
 * link OR the preview claim popup / claim page — both paths funnel into
 * src/outreach.applyInterestResponse, which invokes the listener registered
 * here (see outreach.setInterestedListener). The lead then receives ONE
 * follow-up email covering: (1) customizations, (2) the live plan catalog
 * pricing, (3) client-portal access, (4) available domain names with real
 * registrar prices — and the workspace owner gets ONE short notification.
 *
 * Idempotency: the listener runs synchronously inside the click's tick and
 * claims a durable marker — a 0-point `email.followup_dispatched` prospect
 * event — BEFORE any await, so repeat clicks (either path, double-clicks)
 * can never dispatch twice. The listener is invoked on every interested
 * click; the marker is the single guard.
 *
 * Gates (checked before the marker is claimed, so a blocked click does not
 * burn the one shot): hands_off.enabled = 1 AND
 * hands_off.followup_interested_email !== 0 (default ON — the follow-up is
 * part of hands-off mode) AND automation not paused.
 *
 * Failure policy: everything after the marker claim runs fire-and-forget on
 * a tracked promise. An email or domain-search failure NEVER breaks the
 * click response or the status flip to `engaged`; failures are recorded as
 * `email.failed` prospect events and activity-log lines, the way outreach
 * and handsOff log theirs. Unconfigured SMTP yields the stub provider
 * (records the send, delivers nothing) — exactly like the rest of the
 * system. The campaign daily cap (cost.max_outreach_per_day) is deliberately
 * NOT applied: this is a single transactional reply to the lead's own click,
 * not a campaign blast. Suppression IS honored (outreach's standing rule).
 */

const outreach = require('../src/outreach');
const emailLib = require('../src/email');
const { renderBrandedEmail } = require('../src/emailTemplate');

const MARKER_TYPE = 'email.followup_dispatched';
const DOMAIN_SEARCH_TIMEOUT_MS = 15000;
const DOMAIN_OPTION_LIMIT = 5;

const pending = new Set();

function track(promise) {
  pending.add(promise);
  const done = () => pending.delete(promise);
  promise.then(done, done);
  return promise;
}

/** Test/shutdown helper: resolves when every dispatched follow-up settled. */
async function drainInterestedFollowups() {
  while (pending.size) await Promise.allSettled([...pending]);
}

function log(db, message) {
  try {
    outreach.logActivity(db, 'outreach', message);
  } catch {
    /* activity log is best-effort */
  }
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

// ---------------------------------------------------------------------------
// Synchronous entry point — called from applyInterestResponse's tick.
// ---------------------------------------------------------------------------

function onInterested({ db, leadId }) {
  // Gates first: a gated-off click must NOT claim the marker, so the
  // follow-up can still fire on a later click once the gate opens.
  if (outreach.getSetting(db, 'hands_off.enabled', '0') !== '1') return undefined;
  if (outreach.getSetting(db, 'hands_off.followup_interested_email', '1') === '0') return undefined;
  if (outreach.isAutomationPaused(db)) return undefined;

  const claimed = db
    .prepare('SELECT id FROM prospect_events WHERE lead_id = ? AND type = ? LIMIT 1')
    .get(leadId, MARKER_TYPE);
  if (claimed) return undefined;

  // Claim BEFORE any await — this row is the durable idempotency marker.
  outreach.recordIntent(db, leadId, MARKER_TYPE, 'Interested follow-up email dispatched');
  return track(runFollowup(db, leadId));
}

// ---------------------------------------------------------------------------
// Async worker — fully guarded; never throws back into the click path.
// ---------------------------------------------------------------------------

async function runFollowup(db, leadId) {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
  if (!lead) return;

  let leadResult = 'skipped';
  try {
    leadResult = await sendLeadEmail(db, lead);
  } catch (e) {
    leadResult = 'failed';
    try {
      outreach.recordIntent(db, leadId, 'email.failed', `Interested follow-up email: ${e.message}`);
    } catch {
      /* ignore */
    }
    log(db, `Interested follow-up email failed for lead #${leadId}: ${e.message}`);
  }

  // The owner note is independent of the lead email outcome.
  try {
    await sendOwnerNote(db, lead, leadResult);
  } catch (e) {
    log(db, `Interested owner notification failed for lead #${leadId}: ${e.message}`);
  }
}

async function sendLeadEmail(db, lead) {
  const to = String(lead.email || '').trim();
  if (!to || !emailLib.isValidEmail(to)) {
    log(db, `Interested follow-up skipped for lead #${lead.id}: no usable email address`);
    return 'no-email';
  }
  if (outreach.isSuppressed(db, to)) {
    log(db, `Interested follow-up skipped for lead #${lead.id}: ${to} is on the suppression list`);
    return 'suppressed';
  }

  const settings = outreach.readSettings(db);
  const built = await buildFollowupEmail(db, lead);

  // Same pre-send guard + provider stack the outreach queue uses.
  const { assertMailjetSenderActive } = require('../src/mailjetSender');
  await assertMailjetSenderActive(settings);
  const provider = emailLib.getProvider(settings, db);
  await provider.send({
    to,
    subject: built.subject,
    html: built.html,
    text: built.text,
    skipBrand: true, // body already rendered through renderBrandedEmail
  });

  outreach.recordIntent(db, lead.id, 'email.sent', 'Interested follow-up email');
  log(db, `Interested follow-up emailed: ${lead.business_name || lead.id} <${to}> via ${provider.name || 'provider'}`);
  return 'sent';
}

// ---------------------------------------------------------------------------
// Owner notification — mirrors the hands-off digest's sendPlatformMail use.
// ---------------------------------------------------------------------------

async function resolveReportEmail(db) {
  // Same chain as server/handsOff.resolveReportEmail, resolved against the
  // tenant db already in hand: hands_off.report_email → platform
  // support.email → tenant smtp.from_email.
  const fromSetting = outreach.getSetting(db, 'hands_off.report_email', '').trim();
  if (fromSetting) return fromSetting;
  try {
    const platform = require('./platform');
    const support = String((await platform.getPlatformSetting('support.email', '')) || '').trim();
    if (support) return support;
  } catch {
    /* fall through to the tenant sender */
  }
  return outreach.getSetting(db, 'smtp.from_email', '').trim();
}

async function sendOwnerNote(db, lead, leadResult) {
  const to = await resolveReportEmail(db);
  if (!to) {
    log(db, `Interested owner notification skipped for lead #${lead.id}: no report recipient configured`);
    return;
  }
  const { sendPlatformMail } = require('./mailer');
  const { staffUrl } = require('./appUrls');
  const businessName = lead.business_name || `Lead #${lead.id}`;
  const outcome =
    leadResult === 'sent'
      ? 'The follow-up email (customizations, pricing, portal access, domain options) was sent to the lead.'
      : leadResult === 'suppressed'
        ? 'The follow-up email was NOT sent: the lead address is on the suppression list.'
        : leadResult === 'no-email'
          ? 'The follow-up email was NOT sent: the lead has no usable email address.'
          : 'The follow-up email FAILED to send — see the activity log for the error.';
  const paragraphs = [
    `${businessName} just clicked "I'm interested" on their website outreach and is now marked engaged.`,
    outcome,
    `Open the lead: ${staffUrl('leads', { id: lead.id })}`,
  ];
  // sendPlatformMail throws SMTP_NOT_CONFIGURED when platform mail is unset;
  // runFollowup catches and logs it, like the hands-off digest does.
  await sendPlatformMail({
    to,
    subject: `${businessName} clicked Interested`,
    title: 'New interested lead',
    paragraphs,
    text: paragraphs.join('\n\n'),
  });
  log(db, `Interested owner notification sent to ${to} for lead #${lead.id}`);
}

// ---------------------------------------------------------------------------
// Email construction — live plans + live domain options, honest copy.
// ---------------------------------------------------------------------------

async function loadPlans() {
  try {
    const billing = require('./billing');
    const catalog = await billing.catalogForApi();
    return Array.isArray(catalog) ? catalog : [];
  } catch (e) {
    console.warn('[interestedFollowup] plan catalog unavailable:', e.message);
    return [];
  }
}

function planPriceText(plan) {
  const label = String(plan.priceLabel || '').trim();
  if (label && label.toLowerCase() !== 'monthly') return label; // 'Free', or the platform-configured label
  if (label || plan.interval === 'month') return 'Monthly';
  return '';
}

async function loadDomainOptions(db, lead) {
  const query = String(lead.business_name || '').trim();
  if (!query) return null;
  let result;
  try {
    const cf = require('../src/cfDomains');
    result = await withTimeout(
      cf.searchDomains(db, query, { limit: 12 }),
      DOMAIN_SEARCH_TIMEOUT_MS,
      'Domain search'
    );
    try {
      if (typeof cf.recordSearchIntent === 'function') cf.recordSearchIntent(db, lead.id, query);
    } catch {
      /* intent log is best-effort */
    }
  } catch (e) {
    // Registrar not configured (or search failed): omit the section cleanly.
    if (!e || e.code !== 'NOT_CONFIGURED') {
      log(db, `Domain options skipped for lead #${lead.id}: ${(e && e.message) || e}`);
    }
    return null;
  }
  const options = (Array.isArray(result && result.domains) ? result.domains : [])
    .filter((d) => d && d.registrable && d.domain)
    .slice(0, DOMAIN_OPTION_LIMIT)
    .map((d) => ({ domain: String(d.domain), price: domainPriceText(d) }));
  return options.length ? options : null;
}

function moneyText(v) {
  if (v == null || v === '') return '';
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(2) : String(v).trim();
}

function domainPriceText(d) {
  const cur = d.currency && String(d.currency).toUpperCase() !== 'USD' ? `${String(d.currency).toUpperCase()} ` : '$';
  const reg = moneyText(d.registrationCost);
  const ren = moneyText(d.renewalCost);
  if (reg && ren) return `${cur}${reg} to register, then ${cur}${ren}/yr to renew`;
  if (reg) return `${cur}${reg} to register`;
  if (ren) return `${cur}${ren}/yr`;
  return 'price on request';
}

/** Workspace id from the tenant db file path (…/workspaces/<id>/websitescout.db). */
function workspaceIdFromDb(db) {
  const name = String((db && db.name) || '');
  const m = name.match(/\/(\d+)\/websitescout\.db$/);
  return m ? Number(m[1]) : null;
}

async function buildFollowupEmail(db, lead) {
  const businessName = String(lead.business_name || 'your business').trim() || 'your business';
  const websiteLink = outreach.resolveWebsiteLink(db, lead.id);
  const appUrl = require('./stripeClient').appUrl().replace(/\/+$/, '');
  const portalUrl = `${appUrl}/portal`;
  const leadEmail = String(lead.email || '').trim();

  const [plans, domainOptions] = await Promise.all([loadPlans(), loadDomainOptions(db, lead)]);
  const allFreeBuild =
    plans.length > 0 &&
    plans.every((p) => (p.features || []).some((f) => /free website/i.test(String(f))));

  // --- HTML body (rendered inside renderBrandedEmail's branded shell) ---
  const h2 = (t) => `<h2 style="margin:26px 0 8px;font-size:17px;line-height:1.3;color:#1c2b21;">${esc(t)}</h2>`;
  const p = (html) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.55;color:#1c2b21;">${html}</p>`;
  const li = (html) => `<li style="margin:0 0 6px;font-size:15px;line-height:1.5;color:#1c2b21;">${html}</li>`;
  const ul = (items) => `<ul style="margin:0 0 14px;padding-left:20px;">${items.join('')}</ul>`;

  const htmlParts = [];
  const textParts = [];

  const intro = `Great news — the new website for <strong>${esc(businessName)}</strong> is built and ready for you to look over.`;
  htmlParts.push(p(intro));
  textParts.push(`Great news — the new website for ${businessName} is built and ready for you to look over.`);
  if (websiteLink) {
    htmlParts.push(p(`See it here: <a href="${esc(websiteLink)}">${esc(websiteLink)}</a>`));
    textParts.push(`See it here: ${websiteLink}`);
  }
  htmlParts.push(p('Here is what happens next — it is simpler than it sounds.'));
  textParts.push('Here is what happens next — it is simpler than it sounds.');

  // 1) Customizations
  htmlParts.push(h2('Make it yours'));
  htmlParts.push(
    p(
      'What you see is a starting point, not a finished product set in stone. Wording, colors, photos, pages — tell us what you would like changed and we will shape the site around your business before it goes live. Once you are set up, your client portal lets you edit text, colors and your logo yourself, or send us a change request and we will handle it for you.'
    )
  );
  textParts.push(
    'MAKE IT YOURS\nWhat you see is a starting point, not a finished product set in stone. Wording, colors, photos, pages — tell us what you would like changed and we will shape the site around your business before it goes live. Once you are set up, your client portal lets you edit text, colors and your logo yourself, or send us a change request and we will handle it for you.'
  );

  // 2) Pricing — rendered from the live plan catalog, never hardcoded.
  htmlParts.push(h2('Plans & pricing'));
  textParts.push('PLANS & PRICING');
  if (plans.length) {
    htmlParts.push(p('One simple choice — how much ongoing help you want:'));
    textParts.push('One simple choice — how much ongoing help you want:');
    const items = plans.map((plan) => {
      const price = planPriceText(plan);
      const gist = String(plan.tagline || '').trim();
      return li(
        `<strong>${esc(plan.name || plan.id)}</strong>${price ? ` — ${esc(price)}` : ''}${gist ? `. ${esc(gist)}` : ''}`
      );
    });
    htmlParts.push(ul(items));
    for (const plan of plans) {
      const price = planPriceText(plan);
      const gist = String(plan.tagline || '').trim();
      textParts.push(`- ${plan.name || plan.id}${price ? ` — ${price}` : ''}${gist ? `. ${gist}` : ''}`);
    }
    if (allFreeBuild) {
      htmlParts.push(p('Every plan includes the website itself free — you are only choosing the level of ongoing support around it.'));
      textParts.push('Every plan includes the website itself free — you are only choosing the level of ongoing support around it.');
    }
  } else {
    htmlParts.push(p('Reply to this email and we will walk you through the plan options that fit your business.'));
    textParts.push('Reply to this email and we will walk you through the plan options that fit your business.');
  }

  // 3) Domain options — only when the registrar returned registrable names.
  if (domainOptions) {
    htmlParts.push(h2('Pick your domain name'));
    htmlParts.push(
      p(
        `Right now your site sits on a preview address. These domain names are currently available for ${esc(businessName)} — reply with the one you like and we will register it and connect it to your site:`
      )
    );
    htmlParts.push(ul(domainOptions.map((d) => li(`<strong>${esc(d.domain)}</strong> — ${esc(d.price)}`))));
    textParts.push('PICK YOUR DOMAIN NAME');
    textParts.push(
      `Right now your site sits on a preview address. These domain names are currently available for ${businessName} — reply with the one you like and we will register it and connect it to your site:`
    );
    for (const d of domainOptions) textParts.push(`- ${d.domain} — ${d.price}`);
    // Domain picker CTA (Batch 15): pick + check out in one step; the domain
    // is included free with the first plan payment.
    const wsId = workspaceIdFromDb(db);
    const pickerUrl = wsId ? require('../src/claimKit').buildDomainPickerUrl(wsId, lead.id) : '';
    if (pickerUrl) {
      htmlParts.push(
        p(
          `Ready when you are: <a href="${esc(pickerUrl)}">choose your domain and check out here</a> — the domain is included free with your first plan payment, and we register it and put your site live for you.`
        )
      );
      textParts.push(
        `CHOOSE YOUR DOMAIN\nPick your domain and check out here: ${pickerUrl} — the domain is included free with your first plan payment, and we register it and put your site live for you.`
      );
    }
  }

  // 4) Client portal access
  htmlParts.push(h2('Your client access'));
  const portalCopy = `Your client portal is where your website, change requests and messages live: ${portalUrl}. Click "Request access", enter this email address${leadEmail ? ` (${leadEmail})` : ''}, and we will email you a one-time sign-in link — no password to remember.`;
  const portalHtml = `Your client portal is where your website, change requests and messages live: <a href="${esc(portalUrl)}">${esc(portalUrl)}</a>. Click &quot;Request access&quot;, enter this email address${leadEmail ? ` (${esc(leadEmail)})` : ''}, and we will email you a one-time sign-in link — no password to remember.`;
  htmlParts.push(p(portalHtml));
  textParts.push(`YOUR CLIENT ACCESS\n${portalCopy}`);

  htmlParts.push(p('Just reply to this email with the changes you would like, and we will take it from there.'));
  textParts.push('Just reply to this email with the changes you would like, and we will take it from there.');

  const rendered = renderBrandedEmail({
    title: 'Your website is ready — next steps',
    preheader: `Your website for ${businessName} is ready — customizations, pricing, your domain and client access inside.`,
    htmlBody: htmlParts.join('\n'),
    text: textParts.join('\n\n'),
    cta: websiteLink ? { url: websiteLink, label: 'View your website' } : null,
  });

  return {
    subject: `${businessName} — your website is ready: next steps`,
    html: rendered.html,
    text: rendered.text,
  };
}

// ---------------------------------------------------------------------------

let registered = false;
function registerInterestedFollowup() {
  if (registered) return false;
  outreach.setInterestedListener(onInterested);
  registered = true;
  return true;
}

module.exports = {
  registerInterestedFollowup,
  onInterested,
  buildFollowupEmail,
  drainInterestedFollowups,
  MARKER_TYPE,
};
