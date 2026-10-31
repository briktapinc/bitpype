'use strict';

/**
 * Batch 101 (four-role rebuild step 4) — QUEUE HONESTY helpers.
 *
 * Pure functions over design_jobs rows + their briefs. The
 * portal shows the owner a queued job's state; that state must
 * be DERIVED from the job's real status (and, since Batch 99,
 * its verification record) — never a plausible fiction:
 *
 *   waiting_on_agent            -> queued
 *   waiting_on_agent + bounced  -> in_review   (delivered once,
 *                                  sent back by the reviewer)
 *   in_progress / draft         -> building
 *   questions_pending           -> waiting_on_you
 *   delivered                   -> delivered
 *
 * Merge honesty: a new big ask may only be merged into an
 * open job nobody has started (waiting_on_agent). Once an
 * agent has claimed a job (in_progress) its instructions are
 * the agent's working spec — silently rewriting them mid-build
 * was the old behaviour; now the new ask becomes a SECOND job
 * and the portal says so.
 */

function jobChatState(jobRow, brief) {
  if (!jobRow) return null;
  const origin = (brief && typeof brief === 'object' && brief.chat_origin) || {};
  const status = String(jobRow.status || '');
  let state;
  if (status === 'delivered') state = 'delivered';
  else if (status === 'waiting_on_agent') {
    state = origin.verify && origin.verify.state === 'bounced' ? 'in_review' : 'queued';
  } else if (status === 'in_progress' || status === 'draft') state = 'building';
  else if (status === 'questions_pending') state = 'waiting_on_you';
  else state = 'queued';
  const queuedAt = origin.queuedAt || jobRow.created_at || null;
  let ageMinutes = null;
  if (queuedAt) {
    const t = Date.parse(String(queuedAt).replace(' ', 'T'));
    if (Number.isFinite(t)) ageMinutes = Math.max(0, Math.round((Date.now() - t) / 60000));
  }
  return {
    jobId: Number(jobRow.id),
    state,
    rawStatus: status,
    queuedAt,
    ageMinutes,
    verifyState: origin.verify && origin.verify.state ? String(origin.verify.state) : null,
  };
}

function shouldMergeIntoOpenJob(jobRow) {
  return !!jobRow && String(jobRow.status || '') === 'waiting_on_agent';
}

const STATE_LABELS = {
  queued: 'queued for the design agent',
  building: 'being built by the design agent',
  in_review: 'back with the design agent after verification',
  waiting_on_you: 'waiting on your answer',
  delivered: 'delivered',
};

function stateLabel(state) {
  return STATE_LABELS[state] || STATE_LABELS.queued;
}

module.exports = { jobChatState, shouldMergeIntoOpenJob, stateLabel, STATE_LABELS };
