'use strict';

/**
 * Batch 80 — public application form for /partner (the page that
 * pitches the FREE BitPype partnership: build websites for your
 * audience on BitPype, earn a commission on every monthly payment).
 *
 * Mirror of the /creator application route (Batch 79): Turnstile
 * captcha, the shared per-IP rate limiter, and a lead created through
 * domain.leadsCreate (the lead engine's single funnel) in Ely's
 * workspace — LANDING_WORKSPACE_ID convention, default 1 (ws1).
 *
 * How a partner application lead is marked (all existing lead fields):
 *   source      'partner-app'           — the distinguishing marker
 *   source_ref  'partner'
 *   lead_group  'Partner'
 *   category    'Partner'
 *   tags        ['partner-app']
 *   notes       the application note + every qualifier answer
 * The lead's business_name carries the applicant's full name — the
 * lead model requires a name and this prospect IS a person.
 *
 * This is an APPLICATION, not an account creation: partner accounts
 * are admin-created/invite-only ("we don't want tourists"), and
 * registration stays closed. Nothing here creates a user.
 *
 * One email = one lead (the platform rule): a repeat application for
 * an email that already owns a lead folds into that lead and the
 * application is recorded as a `partner_application` lead event. The
 * fold follows the Batch 68 rule (final review M-5): the
 * marker-carrying fold (tags unioned, empty fields filled, nothing
 * overwritten) applies only when /partner created that lead; a fold
 * into a lead from any other source records the event ONLY.
 *
 * Deploy eligibility (Batch 59/68): hostingerDeploy
 * .isSoftwareInterestLead keys off source === 'landing-software'
 * ONLY, so a 'partner-app' lead is never one-click-deploy-eligible,
 * and nothing in this route can change that — the fold never touches
 * a foreign lead's source, tags or group.
 */

const express = require('express');
const domain = require('../domain');
const { requireCaptcha, getCaptchaConfig } = require('../captcha');
const { rateLimit } = require('../rateLimit');
const { assertWorkspaceExists } = require('../workspaceExists');
const apiErrors = require('../apiErrors');

const router = express.Router();
const submitLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });
const captcha = requireCaptcha();

const INTEREST_NOTE = 'Applied for the BitPype Partner program — submitted via /partner';

// Closed qualifier vocabularies (shared with /creator). Anything
// outside these is rejected as garbage rather than stored (the
// page's <select>s only ever send these values).
const PLATFORMS = {
  youtube: 'YouTube',
  instagram: 'Instagram',
  tiktok: 'TikTok',
  other: 'Other platform',
};
const FOLLOWER_RANGES = {
  'under-10k': 'Under 10,000',
  '10k-50k': '10,000 – 50,000',
  '50k-250k': '50,000 – 250,000',
  '250k-1m': '250,000 – 1 million',
  'over-1m': 'Over 1 million',
};

function partnerWorkspaceId() {
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
  apiErrors.sendError(res, e, http, { area: 'partner', mask5xx: true });
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
 * Fold a partner application into the lead that already owns the
 * email. Batch 68 split, mirrored from the creator fold: /partner's
 * own leads (source 'partner-app') get the historical fold (fill only
 * empty scalar fields, union the tags, never overwrite); a lead from
 * ANYWHERE else gets the application recorded as an EVENT ONLY — no
 * field fills, no tag/group union, and above all no source change,
 * so a submission can never alter a foreign lead's deploy posture.
 */
function foldPartnerIntoExistingLead(workspaceId, existingLeadId, payload, noteParts) {
  const got = domain.leadsGet(workspaceId, existingLeadId);
  const existing = got && got.lead ? got.lead : null;
  const leadId = existing ? existing.id : existingLeadId;

  const createdByPartner = !!existing && String(existing.source || '') === 'partner-app';
  if (createdByPartner) {
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
        console.warn(`partner: fold field-fill failed for lead ${leadId}:`, e && e.message);
      }
    }
  }
  try {
    domain.withDb(workspaceId, (db) => {
      db.prepare('INSERT INTO lead_events (lead_id, type, detail) VALUES (?, ?, ?)').run(
        leadId,
        'partner_application',
        noteParts.join('\n').slice(0, 2000)
      );
    });
  } catch (e) {
    console.warn(`partner: fold event log failed for lead ${leadId}:`, e && e.message);
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
    const workspaceId = partnerWorkspaceId();
    await assertWorkspaceExists(workspaceId);
    const body = req.body || {};

    const fullName = clip(body.fullName || body.full_name || body.name, 120);
    const email = clip(body.email, 200);
    const phone = clip(body.phone, 40);
    const platformKey = clip(body.platform, 40).toLowerCase();
    const rangeKey = clip(body.followerRange || body.follower_range, 40);
    const niche = clip(body.niche, 160);
    const audience = clip(body.audience, 4000);

    if (!fullName) throw validation('Full name is required');
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw validation('A valid email is required');
    if (!Object.prototype.hasOwnProperty.call(PLATFORMS, platformKey)) {
      throw validation('Please choose your main platform');
    }
    if (!Object.prototype.hasOwnProperty.call(FOLLOWER_RANGES, rangeKey)) {
      throw validation('Please choose your audience size range');
    }
    if (!niche) throw validation('Please tell us your niche or category');
    if (!audience) throw validation('Please tell us about your audience and the customers you would serve');
    // Phone is optional on this form; when given it still has to look
    // like a phone number rather than free-form garbage.
    if (phone && !/^[+\d][\d\s().-]{5,}$/.test(phone)) throw validation('That phone number does not look right');

    const platformLabel = PLATFORMS[platformKey];
    const rangeLabel = FOLLOWER_RANGES[rangeKey];

    const noteParts = [
      INTEREST_NOTE,
      `Platform: ${platformLabel} · Audience: ${rangeLabel} · Niche: ${niche}`,
      `About their audience/customers: ${audience}`,
      `Contact: ${fullName} · ${email}${phone ? ` · ${phone}` : ''}`,
    ];

    let lead;
    let folded = false;
    const payload = {
      business_name: fullName,
      category: 'Partner',
      phone,
      email,
      source: 'partner-app',
      source_ref: 'partner',
      status: 'new',
      tags: ['partner-app'],
      lead_group: 'Partner',
      notes: noteParts.join('\n'),
      description: `Partner application — ${fullName} (${platformLabel}, ${rangeLabel} audience) via /partner`,
    };
    try {
      lead = domain.leadsCreate(workspaceId, payload);
    } catch (e) {
      if (!e || e.code !== 'DUPLICATE_EMAIL' || !e.existingLeadId) throw e;
      folded = true;
      lead = foldPartnerIntoExistingLead(workspaceId, e.existingLeadId, payload, noteParts);
    }

    try {
      domain.withDb(workspaceId, (db) => {
        db.prepare('INSERT INTO activity_log (area, message) VALUES (?, ?)').run(
          'leads',
          folded
            ? `Partner application folded into lead #${lead.id}: ${fullName} (${email})`
            : `Partner application lead #${lead.id}: ${fullName} (${email})`
        );
      });
    } catch {
      /* ignore */
    }

    res.json({
      ok: true,
      data: {
        id: lead.id,
        message:
          'Thanks — your application is in. We review partner applications personally and will be in touch.',
      },
    });
  } catch (e) {
    fail(res, e, 500);
  }
});

module.exports = router;
module.exports.INTEREST_NOTE = INTEREST_NOTE;
module.exports.PLATFORMS = PLATFORMS;
module.exports.FOLLOWER_RANGES = FOLLOWER_RANGES;
