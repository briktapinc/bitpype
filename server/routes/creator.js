'use strict';

/**
 * Batch 79 — public application form for /creator (the page that
 * pitches the BitPype SOLO license to content creators).
 *
 * Same capture machinery as the /landing interest form (Batch 58):
 * Turnstile captcha, the shared per-IP rate limiter, and a lead
 * created through domain.leadsCreate (the lead engine's single
 * funnel) in Ely's workspace — LANDING_WORKSPACE_ID convention,
 * default 1 (ws1).
 *
 * How a creator-solo application lead is marked (all existing lead
 * fields):
 *   source      'creator-solo'          — the distinguishing marker
 *   source_ref  'creator'
 *   lead_group  'Creator Solo'
 *   category    'Creator Solo'
 *   tags        ['creator-solo']
 *   notes       the application note + every qualifier answer
 * The lead's business_name carries the applicant's full name — the
 * lead model requires a name and this prospect IS a person.
 *
 * One email = one lead (the platform rule): a repeat application for
 * an email that already owns a lead folds into that lead and the
 * application is recorded as a `creator_solo_application` lead event.
 * The fold follows the Batch 68 rule (final review M-5): the
 * marker-carrying fold (tags unioned, empty fields filled, nothing
 * overwritten) applies only when /creator created that lead; a fold
 * into a lead from any other source records the event ONLY.
 *
 * Deploy eligibility (Batch 59/68): hostingerDeploy
 * .isSoftwareInterestLead keys off source === 'landing-software'
 * ONLY, so a 'creator-solo' lead is never one-click-deploy-eligible,
 * and nothing in this route can change that — the fold never touches
 * a foreign lead's source, tags or group.
 *
 * This is an APPLICATION, not a checkout: nothing here sells, charges
 * or quotes beyond the Solo license price printed on the page.
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

const INTEREST_NOTE = 'Applied for the BitPype Solo license (creator path) — submitted via /creator';

// Closed qualifier vocabularies. Anything outside these is rejected
// as garbage rather than stored (the page's <select>s only ever send
// these values).
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

function creatorWorkspaceId() {
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
  apiErrors.sendError(res, e, http, { area: 'creator', mask5xx: true });
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
 * Fold a creator application into the lead that already owns the
 * email. Batch 68 split, mirrored from the landing fold: /creator's
 * own leads (source 'creator-solo') get the historical fold (fill
 * only empty scalar fields, union the tags, never overwrite); a lead
 * from ANYWHERE else gets the application recorded as an EVENT ONLY —
 * no field fills, no tag/group union, and above all no source change,
 * so a submission can never alter a foreign lead's deploy posture.
 */
function foldCreatorIntoExistingLead(workspaceId, existingLeadId, payload, noteParts) {
  const got = domain.leadsGet(workspaceId, existingLeadId);
  const existing = got && got.lead ? got.lead : null;
  const leadId = existing ? existing.id : existingLeadId;

  const createdByCreator = !!existing && String(existing.source || '') === 'creator-solo';
  if (createdByCreator) {
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
        console.warn(`creator: fold field-fill failed for lead ${leadId}:`, e && e.message);
      }
    }
  }
  try {
    domain.withDb(workspaceId, (db) => {
      db.prepare('INSERT INTO lead_events (lead_id, type, detail) VALUES (?, ?, ?)').run(
        leadId,
        'creator_solo_application',
        noteParts.join('\n').slice(0, 2000)
      );
    });
  } catch (e) {
    console.warn(`creator: fold event log failed for lead ${leadId}:`, e && e.message);
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
    const workspaceId = creatorWorkspaceId();
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
      throw validation('Please choose your follower range');
    }
    if (!niche) throw validation('Please tell us your niche or category');
    if (!audience) throw validation('Please tell us about your audience');
    // Phone is optional on this form; when given it still has to look
    // like a phone number rather than free-form garbage.
    if (phone && !/^[+\d][\d\s().-]{5,}$/.test(phone)) throw validation('That phone number does not look right');

    const platformLabel = PLATFORMS[platformKey];
    const rangeLabel = FOLLOWER_RANGES[rangeKey];

    const noteParts = [
      INTEREST_NOTE,
      `Platform: ${platformLabel} · Followers: ${rangeLabel} · Niche: ${niche}`,
      `About their audience: ${audience}`,
      `Contact: ${fullName} · ${email}${phone ? ` · ${phone}` : ''}`,
    ];

    let lead;
    let folded = false;
    const payload = {
      business_name: fullName,
      category: 'Creator Solo',
      phone,
      email,
      source: 'creator-solo',
      source_ref: 'creator',
      status: 'new',
      tags: ['creator-solo'],
      lead_group: 'Creator Solo',
      notes: noteParts.join('\n'),
      description: `Creator Solo application — ${fullName} (${platformLabel}, ${rangeLabel} followers) via /creator`,
    };
    try {
      lead = domain.leadsCreate(workspaceId, payload);
    } catch (e) {
      if (!e || e.code !== 'DUPLICATE_EMAIL' || !e.existingLeadId) throw e;
      folded = true;
      lead = foldCreatorIntoExistingLead(workspaceId, e.existingLeadId, payload, noteParts);
    }

    try {
      domain.withDb(workspaceId, (db) => {
        db.prepare('INSERT INTO activity_log (area, message) VALUES (?, ?)').run(
          'leads',
          folded
            ? `Creator Solo application folded into lead #${lead.id}: ${fullName} (${email})`
            : `Creator Solo application lead #${lead.id}: ${fullName} (${email})`
        );
      });
    } catch {
      /* ignore */
    }

    res.json({
      ok: true,
      data: {
        id: lead.id,
        message: 'Thanks — your application is in. We review creator applications personally and will be in touch.',
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
