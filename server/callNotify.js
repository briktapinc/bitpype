'use strict';

/**
 * Call Tracking email notifications (Batch 21, addendum #4; subject
 * fixed verbatim by addendum #5: "Incoming call from new lead").
 *
 * When a call reaches a terminal status, the business gets ONE email:
 * caller, time, status, duration, and a portal link — plus a line
 * that a recording/transcript is available in the portal when one
 * exists. Recordings are never attached and transcript text never
 * appears in the email.
 *
 * Recipient resolution reuses the form-submission alert path exactly
 * (server/contactForms.js acceptSubmission): the lead's form
 * notify_email — the field on the lead's first contact form, itself
 * defaulted from the lead's email when the form was created — falling
 * back to the lead's email. Sending uses the platform mail helper
 * (server/mailer.js sendPlatformMail), the same one form alerts use.
 *
 * Exactly-once: siteModules.claimCallNotify flips notify_status
 * 'none' → 'pending' BEFORE the send attempt; only the claim winner
 * sends. Outcomes: 'sent' | 'failed' | 'skipped' (mail unconfigured
 * or no recipient) | 'off' (module setting disabled). Nothing here
 * throws into a webhook.
 */

const domain = require('./domain');
const modules = require('./siteModules');
const mailer = require('./mailer');
const { appUrl } = require('./stripeClient');

const CALL_NOTIFY_SUBJECT = 'Incoming call from new lead';

/** Form-alert recipient chain, read-only (never creates a form). */
function resolveNotifyRecipient(db, leadId) {
  let formEmail = '';
  try {
    const row = db
      .prepare('SELECT notify_email FROM contact_forms WHERE lead_id = ? ORDER BY sort_order ASC, id ASC LIMIT 1')
      .get(Number(leadId));
    formEmail = row ? String(row.notify_email || '').trim() : '';
  } catch {
    formEmail = '';
  }
  if (formEmail) return formEmail;
  try {
    const lead = db.prepare('SELECT email FROM leads WHERE id = ?').get(Number(leadId));
    return lead ? String(lead.email || '').trim() : '';
  } catch {
    return '';
  }
}

function durationLabel(sec) {
  if (sec == null || sec === '' || !Number.isFinite(Number(sec))) return '—';
  const n = Math.max(0, Math.round(Number(sec)));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
}

async function notifyCallByEmail(workspaceId, leadId, callSid) {
  try {
    const prep = domain.withDb(workspaceId, (db) => {
      const call = modules.getCallLogBySid(db, String(callSid || ''));
      if (!call || !modules.isTerminalCallStatus(call.status)) return null;
      const config = modules.getCallTrackingConfig(db, Number(leadId));
      if (!config.notify_email) {
        if (call.notify_status === 'none') modules.setCallNotifyStatus(db, callSid, 'off');
        return null;
      }
      if (!modules.claimCallNotify(db, callSid)) return null; // already claimed / done
      return { call, recipient: resolveNotifyRecipient(db, Number(leadId)) };
    });
    if (!prep) return { sent: false, reason: 'not_claimed' };
    const finish = (status) => {
      try {
        domain.withDb(workspaceId, (db) => modules.setCallNotifyStatus(db, callSid, status));
      } catch {
        /* ignore */
      }
    };
    if (!prep.recipient) {
      finish('skipped');
      return { sent: false, reason: 'no_recipient' };
    }
    const { call } = prep;
    const answered = String(call.status || '').toLowerCase() === 'completed';
    const extras = [];
    if (call.recording_url) extras.push('recording');
    if (call.transcript) extras.push('transcript');
    const paragraphs = [
      answered
        ? 'A new call came in on your website number and was answered.'
        : 'A new call came in on your website number and was missed.',
      `Caller: ${call.from_number || 'Unknown number'}`,
      `Time: ${call.created_at || ''} (UTC)`,
      `Status: ${call.status}`,
      `Duration: ${durationLabel(call.duration_seconds)}`,
    ];
    if (extras.length) {
      paragraphs.push(
        `A ${extras.join(' and ')} of this call ${extras.length > 1 ? 'are' : 'is'} available in your portal.`
      );
    }
    try {
      await mailer.sendPlatformMail({
        to: prep.recipient,
        subject: CALL_NOTIFY_SUBJECT,
        title: CALL_NOTIFY_SUBJECT,
        paragraphs,
        text: paragraphs.join('\n'),
        cta: {
          label: 'View calls in your portal',
          url: `${String(appUrl() || '').replace(/\/$/, '')}/portal`,
        },
      });
      finish('sent');
      return { sent: true };
    } catch (e) {
      if (e && e.code === 'SMTP_NOT_CONFIGURED') {
        finish('skipped');
        return { sent: false, reason: 'mail_not_configured' };
      }
      console.warn('[callNotify] send failed:', e && e.message);
      finish('failed');
      return { sent: false, reason: 'send_failed' };
    }
  } catch (e) {
    console.warn('[callNotify] failed:', e && e.message);
    return { sent: false, reason: 'error' };
  }
}

module.exports = { notifyCallByEmail, resolveNotifyRecipient, CALL_NOTIFY_SUBJECT };
