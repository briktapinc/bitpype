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
 * email that already owns a lead folds into that lead — tags unioned,
 * empty fields filled, NO fields overwritten — and the interest is
 * recorded as a `landing_software_interest` lead event so it stays
 * visible even when the existing lead is a website client. The visitor
 * gets the same polite success either way.
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

const INTEREST_NOTE = 'Interested in the BitPype software / agency license — submitted via /landing';

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
 * Mirrors websitePromo's fold: fill only empty scalar fields, union the
 * tags, never overwrite — plus an explicit interest event, because for
 * this form the marker matters even on a fully-populated client lead.
 */
function foldLandingIntoExistingLead(workspaceId, existingLeadId, payload, noteParts) {
  const got = domain.leadsGet(workspaceId, existingLeadId);
  const existing = got && got.lead ? got.lead : null;
  const leadId = existing ? existing.id : existingLeadId;

  const isEmpty = (v) =>
    v === null ||
    v === undefined ||
    v === '' ||
    (Array.isArray(v) && v.length === 0) ||
    (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0);
  const patch = {};
  for (const f of ['phone', 'category', 'lead_group']) {
    if (existing && isEmpty(existing[f]) && !isEmpty(payload[f])) patch[f] = payload[f];
  }
  if (existing && isEmpty(existing.notes)) {
    patch.notes = noteParts.join('\n').slice(0, 10000);
  }
  const existingTags = (existing && existing.tags) || [];
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

    const noteParts = [INTEREST_NOTE, `Contact: ${fullName} · ${email} · ${phone}`];

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

    res.json({
      ok: true,
      data: {
        id: lead.id,
        message: 'Thanks — we received your details and will be in touch shortly.',
      },
    });
  } catch (e) {
    fail(res, e, 500);
  }
});

module.exports = router;
module.exports.INTEREST_NOTE = INTEREST_NOTE;
