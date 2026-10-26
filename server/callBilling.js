'use strict';

/**
 * Call Tracking billing (Batch 21, addendum #3 — Ely's approved model:
 * the subscription carries call tracking; credits meter the extras.
 * SOFT CAPS ONLY — nothing here ever blocks, cuts off, or un-forwards
 * a call; billing settles after the fact, in the background).
 *
 * The seam: the platform credits engine is async and WORKSPACE-scoped
 * (server/credits.js — spend() debits atomically, throws
 * INSUFFICIENT_CREDITS, and is idempotent per reason/refType/refId),
 * while the call bookkeeping is sync per-workspace SQLite in
 * server/siteModules.js (call_logs.counted, calls_billing). This
 * module is the async bridge the webhooks call fire-and-forget; every
 * entry point catches and logs — a billing failure must never break a
 * Twilio webhook.
 *
 * Plans resolve via billing.effectivePlan(workspaceId, { email }) —
 * the same call other entitlements make (server/clientPortal.js) —
 * with the lead's own email so a client's subscription counts.
 */

const domain = require('./domain');
const modules = require('./siteModules');
const credits = require('./credits');
const billing = require('./billing');
const twilioClient = require('./twilioClient');

function readLeadEmail(workspaceId, leadId) {
  try {
    return domain.withDb(workspaceId, (db) => {
      const row = db.prepare('SELECT email FROM leads WHERE id = ?').get(Number(leadId));
      return row ? String(row.email || '') : '';
    });
  } catch {
    return '';
  }
}

async function planForLead(workspaceId, leadId) {
  const email = readLeadEmail(workspaceId, leadId);
  return billing.effectivePlan(workspaceId, email ? { email } : {});
}

/**
 * After a call reaches a terminal state: if it counted toward the
 * monthly answered allowance, work out which overage thresholds the
 * lead's month total has crossed and settle each newly crossed one —
 * 1 credit via the credits engine, or +1 overage_due_credits when the
 * balance can't cover it. Thresholds are consumed either way (a due
 * credit is never re-attempted as a debit), and the spend itself is
 * idempotent per lead/month/threshold, so a lost state write can
 * never double-charge.
 */
async function settleCallBilling(workspaceId, leadId, callSid) {
  try {
    const snapshot = domain.withDb(workspaceId, (db) => {
      const call = modules.getCallLogBySid(db, String(callSid || ''));
      if (!call || !call.counted) return null;
      const month = String(call.created_at || '').slice(0, 7) || modules.currentCallMonth();
      return {
        month,
        count: modules.countCountedCalls(db, Number(leadId), month),
        state: modules.getCallBillingState(db, Number(leadId), month),
      };
    });
    if (!snapshot) return { settled: false, reason: 'not_counted' };
    const plan = await planForLead(workspaceId, leadId);
    const allowance = modules.callAllowanceForPlan(plan);
    const { month, count } = snapshot;
    const thresholds = count > allowance ? Math.floor((count - allowance) / modules.CALL_OVERAGE_BLOCK) : 0;
    let last = snapshot.state.last_billed_threshold;
    let due = snapshot.state.overage_due_credits;
    let debited = 0;
    while (last < thresholds) {
      const t = last + 1;
      try {
        await credits.spend(workspaceId, 1, {
          reason: 'Call tracking overage',
          refType: 'call_overage',
          refId: `${Number(leadId)}:${month}:${t}`,
        });
        debited += 1;
        last = t;
      } catch (e) {
        if (e && e.code === 'INSUFFICIENT_CREDITS') {
          due += 1;
          last = t;
        } else {
          console.error('[callBilling] overage debit failed:', e && e.message);
          break; // leave the threshold unconsumed — a later call retries it
        }
      }
    }
    if (last !== snapshot.state.last_billed_threshold || due !== snapshot.state.overage_due_credits) {
      domain.withDb(workspaceId, (db) =>
        modules.setCallBillingState(db, Number(leadId), month, {
          lastBilledThreshold: last,
          overageDueCredits: due,
        })
      );
    }
    return { settled: true, month, count, allowance, thresholds, debited, overage_due_credits: due };
  } catch (e) {
    console.error('[callBilling] settle failed:', e && e.message);
    return { settled: false, reason: 'error' };
  }
}

/**
 * Transcribe a recorded call (fire-and-forget from the webhooks).
 * Premium: included. Below premium: 1 credit per produced transcript,
 * debited once per call (call_logs.transcription_billed + the spend's
 * own idempotency key); a zero balance skips transcription entirely
 * with transcript_status 'skipped_no_credits'. No STT key on the
 * platform → 'unavailable', exactly as before — the fee flags simply
 * never fire.
 */
async function transcribeCallRecording(workspaceId, leadId, callSid) {
  try {
    const call = domain.withDb(workspaceId, (db) => modules.getCallLogBySid(db, String(callSid || '')));
    if (!call || !call.recording_url || call.transcript) {
      return { ok: false, reason: 'nothing_to_transcribe' };
    }
    const plan = await planForLead(workspaceId, leadId);
    const premium = String(plan || '').toLowerCase() === 'premium';
    if (!premium && !call.transcription_billed) {
      const balance = await credits.getBalance(workspaceId);
      if (balance < 1) {
        domain.withDb(workspaceId, (db) => modules.setCallTranscript(db, callSid, { status: 'skipped_no_credits' }));
        return { ok: false, reason: 'skipped_no_credits' };
      }
    }
    const result = await twilioClient.transcribeRecording(call.recording_url);
    if (!result.ok) {
      const status = result.reason === 'no_stt_key' ? 'unavailable' : 'failed';
      domain.withDb(workspaceId, (db) => modules.setCallTranscript(db, callSid, { status }));
      return { ok: false, reason: result.reason };
    }
    domain.withDb(workspaceId, (db) => modules.setCallTranscript(db, callSid, { status: 'done', text: result.text }));
    if (!premium && !call.transcription_billed) {
      try {
        await credits.spend(workspaceId, 1, {
          reason: 'Call transcription',
          refType: 'call_transcription',
          refId: String(callSid),
        });
        domain.withDb(workspaceId, (db) => modules.markTranscriptionBilled(db, callSid));
      } catch (e) {
        // The transcript is produced and kept; a failed debit (balance
        // raced to zero) is logged, never retried into a double charge.
        console.error('[callBilling] transcription debit failed:', e && e.message);
      }
    }
    return { ok: true };
  } catch (e) {
    console.error('[callBilling] transcription failed:', e && e.message);
    try {
      domain.withDb(workspaceId, (db) => {
        const row = modules.getCallLogBySid(db, String(callSid || ''));
        if (row && row.transcript_status === 'pending') {
          modules.setCallTranscript(db, callSid, { status: 'failed' });
        }
      });
    } catch {
      /* ignore */
    }
    return { ok: false, reason: 'error' };
  }
}

module.exports = { settleCallBilling, transcribeCallRecording, planForLead };
