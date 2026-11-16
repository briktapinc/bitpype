'use strict';

/**
 * Batch 192 (Greptile verification #15) — the ONE phone opt-out /
 * suppression check for outbound SMS.
 *
 * The check itself predates this batch (Batch 76, missed-call
 * rescue): a number is blocked when its LeadScout contact carries
 * sms_opted_out_at (the contact texted STOP) or when the number sits
 * on the Outreach suppression_list. But it lived inside
 * server/callRescue.js and was only ever consulted by the rescue
 * paths — outreach campaign SMS and one-off SMS never looked at it,
 * so a lead who texted STOP still received outreach texts.
 *
 * This module is the shared home for the check. callRescue re-exports
 * it (its behaviour is unchanged) and every outbound SMS path —
 * src/outreach.js processQueue + createCampaign, server/domain.js
 * emailSend — consults it before sending.
 */

const portalContacts = require('./portalContacts');

function normDigits(phone) {
  return String(phone || '').replace(/\D/g, '');
}

/** Phone-level suppression: LeadScout opt-out on the contact, or the
 *  number sitting on the Outreach suppression list. An empty /
 *  digit-less number is treated as blocked (callers surface their
 *  own no-phone handling before consulting this). */
function phoneBlocked(db, phone) {
  const digits = normDigits(phone);
  if (!digits) return true;
  try {
    portalContacts.ensureTables(db);
    const contact = db
      .prepare('SELECT sms_opted_out_at FROM leadscout_contacts WHERE phone_norm = ?')
      .get(portalContacts.normPhone(phone));
    if (contact && contact.sms_opted_out_at) return true;
  } catch {
    /* contacts table unavailable — fall through */
  }
  try {
    const row = db
      .prepare('SELECT 1 FROM suppression_list WHERE email = ? OR email = ?')
      .get(String(phone || '').trim(), digits);
    if (row) return true;
  } catch {
    /* suppression table unavailable — fall through */
  }
  return false;
}

module.exports = { phoneBlocked, normDigits };
