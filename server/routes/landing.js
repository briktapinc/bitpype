'use strict';

/**
 * Batch 58 — public interest form for /landing (the page that sells the
 * BitPype SOFTWARE to prospective agency owners).
 *
 * Same capture machinery as the /website-promo form: Turnstile captcha,
 * the shared per-IP rate limiter, and a lead created through
 * domain.leadsCreate (the lead engine's single funnel) in Ely's
 * workspace — LANDING_WORKSPACE_ID, default 1 (ws1), the same
 * convention as WEBSITE_PROMO_WORKSPACE_ID.
 *
 * How a software-interest lead is marked (all existing lead fields):
 *   source      'landing-software'      — the distinguishing marker
 *   source_ref  'landing'
 *   lead_group  'Software interest'
 *   category    'Software interest'
 *   tags        ['landing-software', 'software-interest']
 *   notes       the interest note below (plus the submitted contact line)
 * The lead's business_name carries the visitor's full name — the lead
 * model requires a name and this prospect IS a person, not a business.
 *
 * One email = one lead (the platform rule): a repeat submission for an
 * email that already owns a lead folds into that lead and the interest
 * is recorded as a `landing_software_interest` lead event. Batch 68
 * (review M-5): the marker-carrying fold (tags unioned, empty fields
 * filled, nothing overwritten) applies only when /landing created
 * that lead; a fold into a lead from any other source records the
 * event ONLY, so a submission can never make a foreign lead
 * deploy-eligible. The visitor gets the same polite success either way.
 *
 * Batch 70: a successful submission (either path) also sends the
 * submitter a thank-you email via server/landingThankYou.js
 * (best-effort — a mail failure never fails the submission) and the
 * success response carries redirectUrl '/thankyou', where the page
 * sends the visitor next.
 *
 * Batch 75: demo-source marking. The Solo Agency playbook (/solo)
 * points its "Book a demo" CTAs at /landing?ref=solo-demo; the page
 * mirrors that exact value into a hidden demo_source field. Here it is
 * validated against a one-value allowlist — only the literal
 * 'solo-demo' has any effect; anything else is ignored and never
 * stored. A marked submission gets, on BOTH the create and fold
 * paths: the 'solo-demo' tag unioned onto the lead (tags only — the
 * marker never touches source/category/lead_group, and Hostinger
 * deploy eligibility keys off lead.source alone, so the tag cannot
 * make any lead deploy-eligible) and ONE deduped
 * `landing_solo_demo_interest` lead event, so staff see the solo demo
 * interest on the lead in admin without repeat submissions stacking
 * duplicates.
 */

const express = require('express');
const domain = require('../domain');
const { requireCaptcha, getCaptchaConfig } = require('../captcha');
const { rateLimit } = require('../rateLimit');
const { assertWorkspaceExists } = require('../workspaceExists');
const apiErrors = require('../apiErrors');
const landingThankYou = require('../landingThankYou');

const router = express.Router();
const submitLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });
const captcha = requireCaptcha();

const INTEREST_NOTE = 'Interested in the BitPype software / agency license — submitted via /landing';

// Batch 75: the one accepted demo_source value, its tag, its event.
const SOLO_DEMO_VALUE = 'solo-demo';
const SOLO_DEMO_TAG = 'solo-demo';
const SOLO_DEMO_EVENT = 'landing_solo_demo_interest';
const SOLO_DEMO_EVENT_DETAIL =
  'Interested in a demo — arrived from the Solo Agency playbook (/solo) "Book a demo" CTA and submitted the /landing interest form.';
const SOLO_DEMO_NOTE_LINE = 'Source: Solo Agency playbook demo CTA (/solo, Book a demo)';

/**
 * Batch 75: apply the solo-demo mark to a lead — the 'solo-demo' tag
 * (unioned; nothing else on the lead changes) plus the solo event,
 * inserted only if the lead does not already carry one, so repeat
 * submissions never stack duplicates. Best-effort in the fold style:
 * a marking failure is logged and never fails the visitor's
 * submission.
 */
function markSoloDemoInterest(workspaceId, leadId) {
  try {
    // The tag is written with a direct single-column UPDATE, not the
    // lead engine: leadsUpdate canonicalizes sibling fields on write
    // (e.g. '' lead_group/category come back NULL), and this marker
    // must change literally nothing about the lead except its tags —
    // above all on a foreign lead (Batch 68).
    domain.withDb(workspaceId, (db) => {
      const row = db.prepare('SELECT tags FROM leads WHERE id = ?').get(leadId);
      if (!row) return;
      let tags = [];
      try {
        tags = JSON.parse(row.tags || '[]');
      } catch {
        tags = [];
      }
      if (!Array.isArray(tags)) tags = [];
      if (!tags.includes(SOLO_DEMO_TAG)) {
        db.prepare('UPDATE leads SET tags = ? WHERE id = ?').run(
          JSON.stringify([...tags, SOLO_DEMO_TAG]),
          leadId
        );
      }
    });
  } catch (e) {
    console.warn(`landing: solo-demo tag failed for lead ${leadId}:`, e && e.message);
  }
  try {
    domain.withDb(workspaceId, (db) => {
      const seen = db
        .prepare('SELECT COUNT(*) AS c FROM lead_events WHERE lead_id = ? AND type = ?')
        .get(leadId, SOLO_DEMO_EVENT);
      if (!seen || !seen.c) {
        db.prepare('INSERT INTO lead_events (lead_id, type, detail) VALUES (?, ?, ?)').run(
          leadId,
          SOLO_DEMO_EVENT,
          SOLO_DEMO_EVENT_DETAIL
        );
      }
    });
  } catch (e) {
    console.warn(`landing: solo-demo event failed for lead ${leadId}:`, e && e.message);
  }
}

function landingWorkspaceId() {
  const n = Number(process.env.LANDING_WORKSPACE_ID || 1);
  return Number.isInteger(n) && n > 0 ? n : 1;
}

function fail(res, e, status = 400) {
  const http =
    e.code === 'CAPTCHA_REQUIRED' || e.code === 'CAPTCHA_FAILED' || e.code === 'CAPTCHA_NOT_CONFIGURED'
      ? 403
      : e.code === 'VALIDATION' || e.code === 'EMPTY' || e.code === 'INVALID' || e.code === 'TOO_LARGE'
        ? 400
        : e.code === 'RATE_LIMITED'
          ? 429
          : typeof e.status === 'number'
            ? e.status
            : status;
  apiErrors.sendError(res, e, http, { area: 'landing', mask5xx: true });
}

function clip(s, max) {
  return String(s == null ? '' : s)
    .trim()
    .slice(0, max);
}

function validation(message) {
  const err = new Error(message);
  err.code = 'VALIDATION';
  return err;
}

/**
 * Fold a landing submission into the lead that already owns the email.
 *
 * Batch 68 (final review M-5): the fold splits on WHO created the
 * existing lead. If /landing created it (source 'landing-software' —
 * a repeat submission by the same prospect), the historical behavior
 * stands: fill only empty scalar fields, union the tags, never
 * overwrite. If the lead came from ANYWHERE else (a website client, an
 * import, a manual entry), the submission is recorded as an interest
 * EVENT ONLY — no field fills and no tag/group union. The old fold
 * unioned the software-interest markers onto foreign leads, which
 * silently made them one-click-deployable (deploy eligibility keyed
 * off those markers); fills could likewise change deploy behavior
 * (e.g. lead_group). The interest stays visible either way.
 */
function foldLandingIntoExistingLead(workspaceId, existingLeadId, payload, noteParts) {
  const got = domain.leadsGet(workspaceId, existingLeadId);
  const existing = got && got.lead ? got.lead : null;
  const leadId = existing ? existing.id : existingLeadId;

  const createdByLanding = !!existing && String(existing.source || '') === 'landing-software';
  if (createdByLanding) {
    const isEmpty = (v) =>
      v === null ||
      v === undefined ||
      v === '' ||
      (Array.isArray(v) && v.length === 0) ||
      (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0);
    const patch = {};
    for (const f of ['phone', 'category', 'lead_group']) {
      if (isEmpty(existing[f]) && !isEmpty(payload[f])) patch[f] = payload[f];
    }
    if (isEmpty(existing.notes)) {
      patch.notes = noteParts.join('\n').slice(0, 10000);
    }
    const existingTags = existing.tags || [];
    const tagUnion = [...new Set([...existingTags, ...(payload.tags || [])])];
    if (tagUnion.length !== existingTags.length) patch.tags = tagUnion;
    if (Object.keys(patch).length) {
      try {
        domain.leadsUpdate(workspaceId, leadId, patch);
      } catch (e) {
        // A fill failure must not fail the visitor's submission.
        console.warn(`landing: fold field-fill failed for lead ${leadId}:`, e && e.message);
      }
    }
  }
  try {
    domain.withDb(workspaceId, (db) => {
      db.prepare('INSERT INTO lead_events (lead_id, type, detail) VALUES (?, ?, ?)').run(
        leadId,
        'landing_software_interest',
        noteParts.join('\n').slice(0, 2000)
      );
    });
  } catch (e) {
    console.warn(`landing: fold event log failed for lead ${leadId}:`, e && e.message);
  }
  return { id: leadId };
}

router.get('/config', async (_req, res) => {
  try {
    const captchaCfg = await getCaptchaConfig();
    res.json({ ok: true, data: { captcha: captchaCfg } });
  } catch (e) {
    fail(res, e, 500);
  }
});

router.post('/submit', submitLimit, captcha, async (req, res) => {
  try {
    const workspaceId = landingWorkspaceId();
    await assertWorkspaceExists(workspaceId);
    const body = req.body || {};

    const fullName = clip(body.fullName || body.full_name || body.name, 120);
    const email = clip(body.email, 200);
    const phone = clip(body.phone, 40);

    if (!fullName) throw validation('Full name is required');
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw validation('A valid email is required');
    if (!phone) throw validation('Phone number is required');

    // Batch 75: one-value allowlist — only the exact marker counts.
    const soloDemo = clip(body.demo_source, 40) === SOLO_DEMO_VALUE;

    const noteParts = [INTEREST_NOTE, `Contact: ${fullName} · ${email} · ${phone}`];
    if (soloDemo) noteParts.push(SOLO_DEMO_NOTE_LINE);

    let lead;
    let folded = false;
    const payload = {
      business_name: fullName,
      category: 'Software interest',
      phone,
      email,
      source: 'landing-software',
      source_ref: 'landing',
      status: 'new',
      tags: ['landing-software', 'software-interest'],
      lead_group: 'Software interest',
      notes: noteParts.join('\n'),
      description: `Software interest lead — ${fullName} (via /landing)`,
    };
    try {
      lead = domain.leadsCreate(workspaceId, payload);
    } catch (e) {
      if (!e || e.code !== 'DUPLICATE_EMAIL' || !e.existingLeadId) throw e;
      folded = true;
      lead = foldLandingIntoExistingLead(workspaceId, e.existingLeadId, payload, noteParts);
    }

    // Batch 75: the solo-demo mark applies on BOTH paths (fresh lead
    // and duplicate-email fold), after the lead exists either way.
    if (soloDemo) markSoloDemoInterest(workspaceId, lead.id);

    try {
      domain.withDb(workspaceId, (db) => {
        db.prepare('INSERT INTO activity_log (area, message) VALUES (?, ?)').run(
          'leads',
          folded
            ? `Landing software-interest submission folded into lead #${lead.id}: ${fullName} (${email})`
            : `Landing software-interest lead #${lead.id}: ${fullName} (${email})`
        );
      });
    } catch {
      /* ignore */
    }

    // Batch 70: thank-you email to the submitter — on BOTH the new-lead
    // path and the duplicate-email fold path. Best-effort by design
    // (sendLandingThankYou never throws; the extra try/catch keeps that
    // guarantee even if the helper changes): a mail failure is logged
    // and the visitor still succeeds.
    try {
      const ty = await landingThankYou.sendLandingThankYou({ fullName, email });
      if (!ty.sent) {
        console.warn(`landing: thank-you email not sent for lead #${lead.id} (${ty.reason || 'unknown'})`);
      }
    } catch (e) {
      console.warn(`landing: thank-you email failed for lead #${lead.id}:`, e && e.message);
    }

    res.json({
      ok: true,
      data: {
        id: lead.id,
        message: 'Thanks — we received your details and will be in touch shortly.',
        // Batch 70: the page navigates here on success (inline success
        // block remains the fallback when this is somehow absent).
        redirectUrl: '/thankyou',
      },
    });
  } catch (e) {
    fail(res, e, 500);
  }
});

module.exports = router;
module.exports.INTEREST_NOTE = INTEREST_NOTE;
module.exports.SOLO_DEMO_VALUE = SOLO_DEMO_VALUE;
module.exports.SOLO_DEMO_TAG = SOLO_DEMO_TAG;
module.exports.SOLO_DEMO_EVENT = SOLO_DEMO_EVENT;
