'use strict';

/**
 * SMS opt-in for visitor forms (Batch 25).
 *
 * Ely's rule: every web form that collects a phone number lets the
 * visitor opt in to texts by entering their number and checking a
 * consent checkbox; on submission the customer gets one confirmation
 * text welcoming them to the business's program.
 *
 * This module is the ONE shared implementation every visitor path
 * uses:
 *   - contact forms (server/contactForms.js acceptSubmission),
 *   - bookings + instant estimate (server/routes/modulesPublic.js),
 *   - chatbot lead capture (server/routes/chatbotPublic.js).
 * The renderers (form-embed.js / module-embed.js / chat-embed.js) draw
 * the same unchecked-by-default checkbox from the `sms_optin` block
 * the public payloads carry ({ consent_key, label }), and submit the
 * consent back under CONSENT_KEY.
 *
 * Recording: portalContacts.recordSmsOptIn flags the LeadScout contact
 * (sms_opted_in + consent timestamp + source) — the proof of consent.
 * Sending: the platform's existing SMS seam (src/sms.js) with its own
 * config resolution — workspace settings filled from the sms.*
 * platform settings (Admin → SMS), sent from sms.from_number.
 *
 * Contracts (mirroring ownerNotify, Batch 21b):
 *   - No consent or no plausible phone → nothing recorded, no text.
 *   - SMS disabled/unconfigured → opt-in still recorded, the send is
 *     skipped with a logged reason; the submission NEVER fails.
 *   - Sender errors are caught and stamped on the contact; nothing
 *     here throws or rejects into a visitor request.
 *   - One confirmation per enrollment: a repeat submission by an
 *     already-enrolled contact refreshes the consent record but does
 *     not re-text (unless they opted out in between).
 */

const sms = require('../src/sms');
const portalContacts = require('./portalContacts');

const CONSENT_KEY = 'sms_optin_consent';

function cleanBiz(businessName) {
  return String(businessName || '')
    .trim()
    .slice(0, 200);
}

/** Consent checkbox copy — always names the business when known. */
function consentLabel(businessName) {
  const biz = cleanBiz(businessName);
  return biz ? `Text me updates & offers from ${biz}` : 'Text me updates & offers';
}

/** The confirmation text (exact template; business name interpolated). */
function confirmationBody(businessName) {
  const biz = cleanBiz(businessName) || 'us';
  return `Welcome to ${biz} texts — you're enrolled! Msg & data rates may apply. Reply STOP to end, HELP for help.`;
}

/** The sms_optin block module/chat payloads carry (fixed phone input). */
function optInBlock(businessName) {
  return { consent_key: CONSENT_KEY, label: consentLabel(businessName) };
}

/** First field that collects a phone: tel/phone type, else a phone-ish key. */
function phoneFieldKeyFor(fields) {
  const list = Array.isArray(fields) ? fields : [];
  const byType = list.find((f) => f && (f.field_type === 'tel' || f.field_type === 'phone'));
  if (byType) return byType.field_key;
  const byKey = list.find((f) => f && /phone|tel|mobile/i.test(String(f.field_key || '')));
  return byKey ? byKey.field_key : '';
}

/** sms_optin block for a contact form, or null when it collects no phone. */
function optInBlockForForm(fields, businessName) {
  const key = phoneFieldKeyFor(fields);
  if (!key) return null;
  return { ...optInBlock(businessName), phone_field_key: key };
}

function truthyConsent(value) {
  if (value === true || value === 1) return true;
  if (typeof value === 'string') return /^(1|true|on|yes)$/i.test(value.trim());
  return false;
}

function businessNameForLead(db, leadId) {
  try {
    const lead = db.prepare('SELECT business_name FROM leads WHERE id = ?').get(Number(leadId));
    return String((lead && lead.business_name) || '').trim();
  } catch {
    return '';
  }
}

/**
 * Workspace settings map — MUST go through the shared decrypting reader
 * in src/sms.js (Batch 25b): sms.* secrets are secretBox-encrypted at
 * rest, and a raw settings read would hand Twilio ciphertext.
 */
function readWorkspaceSettings(db) {
  return sms.readWorkspaceSettings(db);
}

/**
 * Record + confirm one opt-in. Async, resolves to a result descriptor,
 * NEVER rejects. `settings` may carry the workspace settings map;
 * when omitted it is read from the workspace db (and src/sms fills any
 * gaps from the sms.* platform settings).
 */
async function handleSmsOptIn(db, opts = {}) {
  const { leadId, name, email, phone, consent, source, formId, settings } = opts;
  try {
    if (!truthyConsent(consent)) return { skipped: true, reason: 'no_consent' };
    const to = sms.normalizePhone(phone);
    if (!to) return { skipped: true, reason: 'invalid_phone' };
    const biz = cleanBiz(opts.businessName) || businessNameForLead(db, leadId);
    // Record with the phone AS GIVEN: the contact store dedupes on its
    // own normalization, so the opt-in lands on the same contact row
    // the form/booking/chat capture created. `to` (E.164) is only the
    // send target.
    const rec = portalContacts.recordSmsOptIn(db, {
      leadId,
      name,
      email,
      phone,
      source,
      formId,
    });
    if (!rec || rec.error || !rec.contact) {
      return { recorded: false, sent: false, reason: 'record_failed', error: rec && rec.error };
    }
    const base = { recorded: true, contactId: rec.contact.id, alreadyEnrolled: !!rec.alreadyEnrolled };
    if (!rec.shouldSend) return { ...base, sent: false, reason: 'already_enrolled' };

    const resolved = await sms.resolveSmsSettings(settings || readWorkspaceSettings(db));
    const cfgErrors = sms.validateSmsConfig(sms.readSmsConfig(resolved));
    if (cfgErrors.length) {
      const reason = cfgErrors.join('; ');
      try {
        portalContacts.markSmsConfirmResult(db, { contactId: rec.contact.id, status: 'skipped', error: reason });
      } catch {
        /* stamp is best-effort */
      }
      console.warn(`[smsOptIn] confirmation text skipped for lead ${leadId}: ${reason}`);
      return { ...base, sent: false, skippedSend: true, reason };
    }
    const provider = sms.getSmsProvider(resolved, db);
    try {
      const out = await provider.send({ to, body: confirmationBody(biz) });
      try {
        portalContacts.markSmsConfirmResult(db, { contactId: rec.contact.id, status: 'sent' });
      } catch {
        /* stamp is best-effort */
      }
      return { ...base, sent: true, messageId: (out && out.messageId) || null, provider: (out && out.provider) || null };
    } catch (e) {
      try {
        portalContacts.markSmsConfirmResult(db, {
          contactId: rec.contact.id,
          status: 'failed',
          error: (e && e.message) || String(e),
        });
      } catch {
        /* stamp is best-effort */
      }
      console.warn('[smsOptIn] confirmation text failed:', (e && e.message) || e);
      return { ...base, sent: false, error: (e && e.message) || String(e) };
    }
  } catch (e) {
    console.warn('[smsOptIn] opt-in handling failed:', (e && e.message) || e);
    return { recorded: false, sent: false, reason: 'error', error: (e && e.message) || String(e) };
  }
}

/** Workspace-scoped wrapper for the public routes (domain.withDb), same contract. */
async function handleSmsOptInForWorkspace(workspaceId, args = {}) {
  try {
    const domain = require('./domain');
    return await domain.withDb(workspaceId, (db) => handleSmsOptIn(db, args));
  } catch (e) {
    console.warn('[smsOptIn] workspace opt-in failed:', (e && e.message) || e);
    return { recorded: false, sent: false, reason: 'error', error: (e && e.message) || String(e) };
  }
}

module.exports = {
  CONSENT_KEY,
  consentLabel,
  confirmationBody,
  optInBlock,
  phoneFieldKeyFor,
  optInBlockForForm,
  truthyConsent,
  businessNameForLead,
  handleSmsOptIn,
  handleSmsOptInForWorkspace,
};
