'use strict';

/**
 * Voicemail email notifications (Batch 26c — Ely 2026-10-26).
 *
 * When an unanswered tracked call ends in a voicemail (the greeting +
 * <Record> flow in server/siteModules.js buildVoicemailTwiml), the
 * business gets ONE email: subject "New voicemail from {caller}",
 * carrying the transcript when one could be produced, a link to the
 * authenticated recording playback route, and a portal CTA.
 *
 * Flow (fired fire-and-forget from the recording webhook):
 *   1. Claim the send exactly once (call_logs.voicemail_notify_status
 *      'none' → 'pending' via siteModules.claimVoicemailNotify) — the
 *      <Record> action post and the recording status callback can both
 *      land; only the claim winner transcribes + emails.
 *   2. Transcribe through the EXISTING billing-aware path
 *      (server/callBilling.js transcribeCallRecording): Premium
 *      included, below Premium 1 credit per transcript, zero balance →
 *      skipped — the voicemail itself is kept and still emailed,
 *      just without a transcript.
 *   3. Email via the platform mailer to the same recipient chain as
 *      the missed-call alert (server/callNotify.js
 *      resolveNotifyRecipient): for a rented site the TENANT's chain
 *      (the call row's tenant stamp), falling back to the site owner.
 *
 * The owner's notify_email preference gates this email too ('off'),
 * exactly like the per-call alert. Nothing here throws into a webhook.
 */

const domain = require('./domain');
const modules = require('./siteModules');
const mailer = require('./mailer');
const callBilling = require('./callBilling');
const { resolveNotifyRecipient } = require('./callNotify');
const { appUrl } = require('./stripeClient');

function durationLabel(sec) {
  if (sec == null || sec === '' || !Number.isFinite(Number(sec))) return '—';
  const n = Math.max(0, Math.round(Number(sec)));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
}

function voicemailSubject(call) {
  return `New voicemail from ${(call && call.from_number) || 'Unknown number'}`;
}

async function notifyVoicemailByEmail(workspaceId, leadId, callSid) {
  try {
    const prep = domain.withDb(workspaceId, (db) => {
      const call = modules.getCallLogBySid(db, String(callSid || ''));
      if (!call || !call.is_voicemail || !call.recording_url) return null;
      const config = modules.getCallTrackingConfig(db, Number(leadId));
      if (!config.notify_email) {
        if (call.voicemail_notify_status === 'none') {
          modules.setVoicemailNotifyStatus(db, callSid, 'off');
        }
        return null;
      }
      if (!modules.claimVoicemailNotify(db, callSid)) return null; // already claimed / done
      let recipient = '';
      if (call.tenant_lead_id) recipient = resolveNotifyRecipient(db, Number(call.tenant_lead_id));
      if (!recipient) recipient = resolveNotifyRecipient(db, Number(leadId));
      return { recipient };
    });
    if (!prep) return { sent: false, reason: 'not_claimed' };
    const finish = (status) => {
      try {
        domain.withDb(workspaceId, (db) => modules.setVoicemailNotifyStatus(db, callSid, status));
      } catch {
        /* ignore */
      }
    };

    // Transcribe BEFORE composing so the email can carry the text.
    // transcribeCallRecording applies the plan/credit rules itself and
    // is a no-op when a transcript already exists. A skipped/failed
    // transcription never blocks the email.
    let call = domain.withDb(workspaceId, (db) => modules.getCallLogBySid(db, String(callSid || '')));
    if (call && !call.transcript && call.transcript_status !== 'skipped_no_credits') {
      try {
        domain.withDb(workspaceId, (db) => modules.setCallTranscript(db, callSid, { status: 'pending' }));
      } catch {
        /* ignore */
      }
      await callBilling.transcribeCallRecording(workspaceId, leadId, callSid).catch(() => {});
      call = domain.withDb(workspaceId, (db) => modules.getCallLogBySid(db, String(callSid || '')));
    }
    if (!call) {
      finish('failed');
      return { sent: false, reason: 'call_missing' };
    }
    if (!prep.recipient) {
      finish('skipped');
      return { sent: false, reason: 'no_recipient' };
    }

    const base = String(appUrl() || '').replace(/\/$/, '');
    const subject = voicemailSubject(call);
    const paragraphs = [
      'A caller left a voicemail on your website number.',
      `Caller: ${call.from_number || 'Unknown number'}`,
      `Time: ${call.created_at || ''} (UTC)`,
      `Message length: ${durationLabel(call.recording_duration)}`,
    ];
    if (call.transcript) {
      paragraphs.push(`Transcript:\n${call.transcript}`);
    } else if (call.transcript_status === 'skipped_no_credits') {
      paragraphs.push('No transcript was made (no credits available) — listen to the recording in your portal.');
    } else {
      paragraphs.push('Listen to the recording in your portal.');
    }
    paragraphs.push(
      `Recording playback (sign-in required): ${base}/api/v1/calls/recording-file/${Number(workspaceId)}/${encodeURIComponent(String(callSid))}`
    );
    try {
      await mailer.sendPlatformMail({
        to: prep.recipient,
        subject,
        title: subject,
        paragraphs,
        text: paragraphs.join('\n'),
        cta: {
          label: 'Listen in your portal',
          url: `${base}/portal`,
        },
      });
      finish('sent');
      return { sent: true };
    } catch (e) {
      if (e && e.code === 'SMTP_NOT_CONFIGURED') {
        finish('skipped');
        return { sent: false, reason: 'mail_not_configured' };
      }
      console.warn('[voicemailNotify] send failed:', e && e.message);
      finish('failed');
      return { sent: false, reason: 'send_failed' };
    }
  } catch (e) {
    console.warn('[voicemailNotify] failed:', e && e.message);
    return { sent: false, reason: 'error' };
  }
}

module.exports = { notifyVoicemailByEmail, voicemailSubject };
