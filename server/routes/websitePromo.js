'use strict';

/**
 * Public Facebook-ad lead form at /website-promo.
 * Turnstile captcha + lead create in WEBSITE_PROMO_WORKSPACE_ID (default 1).
 *
 * Optional brochure upload (base64 JSON, same convention as the portal logo
 * upload): the file is content-sniffed, stored under
 * EXPORT_ROOT/website-promo/ws-<id>/, and its brand colors are extracted
 * (src/brochurePalette.js — OpenAI vision on the workspace's AI settings
 * first, deterministic histogram as fallback) onto the lead as the
 * `site.style_guide` business fact — the fact the design brief builder
 * reads — so the design step picks the palette up with no extra glue.
 * The same passes lift the business's logo and complementing brand
 * assets out of the brochure; they are stored next to the brochure and
 * referenced from the same fact (guide.logo / guide.assets, following
 * the siteIngest convention). Extraction is best-effort and never fails
 * the submission.
 */

const path = require('path');
const fs = require('fs');
const express = require('express');
const domain = require('../domain');
const { requireCaptcha, getCaptchaConfig } = require('../captcha');
const { rateLimit } = require('../rateLimit');
const { assertWorkspaceExists } = require('../workspaceExists');
const {
  sniffBrochureType,
  declaredFamily,
  DECLARED_FAMILY_KINDS,
  extractBrochurePalette,
  extractBrochureAssets,
} = require('../../src/brochurePalette');

const router = express.Router();
const submitLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });
const captcha = requireCaptcha();

const FEATURE_OPTIONS = [
  { id: 'appointment_form', label: 'Appointment / booking form' },
  { id: 'contact_form', label: 'Contact form' },
  { id: 'blog', label: 'Blog' },
  { id: 'chat', label: 'Live chat / chatbot' },
  { id: 'gallery', label: 'Photo gallery' },
  { id: 'ecommerce', label: 'Online shop' },
  { id: 'faq', label: 'FAQ' },
  { id: 'testimonials', label: 'Testimonials' },
];

function promoWorkspaceId() {
  const n = Number(process.env.WEBSITE_PROMO_WORKSPACE_ID || 1);
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
  const msg = http >= 500 ? 'Server error' : e.message || String(e);
  res.status(http).json({ ok: false, error: msg, code: e.code });
}

function clip(s, max) {
  return String(s == null ? '' : s)
    .trim()
    .slice(0, max);
}

function parseServices(raw) {
  if (Array.isArray(raw)) {
    return raw
      .map((s) => clip(s, 120))
      .filter(Boolean)
      .slice(0, 40);
  }
  return String(raw || '')
    .split(/[\n,;|]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 40)
    .map((s) => s.slice(0, 120));
}

function parseSocial(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
      const key = clip(k, 40).toLowerCase();
      const val = clip(v, 200);
      if (key && val) out[key] = val;
    }
    return out;
  }
  const text = clip(raw, 2000);
  if (!text) return {};
  const out = {};
  for (const line of text.split(/\n+/)) {
    const m = line.match(/^\s*([a-zA-Z0-9_]+)\s*[:=]\s*(.+)\s*$/);
    if (m) out[m[1].toLowerCase()] = m[2].trim().slice(0, 200);
    else if (line.trim()) {
      out[`link_${Object.keys(out).length + 1}`] = line.trim().slice(0, 200);
    }
  }
  return out;
}

function parseFeatures(raw) {
  const allowed = new Set(FEATURE_OPTIONS.map((f) => f.id));
  let list = [];
  if (Array.isArray(raw)) list = raw.map(String);
  else if (typeof raw === 'string') list = raw.split(/[\n,]+/);
  return [...new Set(list.map((s) => s.trim().toLowerCase()).filter((id) => allowed.has(id)))];
}

function saveBrochure(workspaceId, brochure) {
  if (!brochure || typeof brochure !== 'object') return null;
  const data = String(brochure.data || '').replace(/^data:[^;]+;base64,/, '');
  if (!data) return null;
  const buf = Buffer.from(data, 'base64');
  if (!buf.length) return null;
  if (buf.length > 8 * 1024 * 1024) {
    const err = new Error('Brochure must be under 8MB');
    err.code = 'TOO_LARGE';
    throw err;
  }
  const mime = clip(brochure.mimeType || brochure.mime || 'application/octet-stream', 80);
  const allowed = /^(application\/pdf|image\/(jpeg|png|webp)|application\/msword|application\/vnd\.openxmlformats|application\/octet-stream)/i;
  if (!allowed.test(mime)) {
    const err = new Error('Brochure must be PDF, Word, or an image');
    err.code = 'INVALID';
    throw err;
  }
  // The declared MIME only picks the expected family; the stored type comes
  // from the sniffed magic bytes. A clear disagreement (declared PDF, bytes
  // are a PNG) means the content does not match its type — reject the file.
  const sniffed = sniffBrochureType(buf);
  if (!sniffed || !DECLARED_FAMILY_KINDS[declaredFamily(mime)].includes(sniffed.kind)) {
    const err = new Error('Brochure file content does not match its type');
    err.code = 'INVALID';
    throw err;
  }

  const root = process.env.EXPORT_ROOT || path.join(process.cwd(), 'exports');
  const dir = path.join(root, 'website-promo', `ws-${workspaceId}`);
  fs.mkdirSync(dir, { recursive: true });
  // Server-generated name only — the client's filename is never used.
  const name = `brochure-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${sniffed.ext}`;
  const full = path.join(dir, name);
  fs.writeFileSync(full, buf);
  return { path: full, fileName: name, mimeType: sniffed.mimeType, bytes: buf.length, kind: sniffed.kind, buf };
}

/**
 * Persist the logo / brand assets lifted out of a brochure (buffers from
 * src/brochurePalette.js extractBrochureAssets) next to the brochure
 * itself — same storage area, same server-generated naming. The returned
 * `file` is the EXPORT_ROOT-relative locator written onto the lead's
 * style_guide fact, the same "string that locates the image" convention
 * siteIngest uses for guide.logo (there: an absolute URL). Best-effort:
 * a failed write degrades that asset to absent, never fails the lead.
 */
function saveBrochureAssets(workspaceId, extracted) {
  const out = { logo: null, assets: [] };
  if (!extracted) return out;
  const root = process.env.EXPORT_ROOT || path.join(process.cwd(), 'exports');
  const dir = path.join(root, 'website-promo', `ws-${workspaceId}`);
  const write = (item, prefix) => {
    const name = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${item.ext}`;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), item.buffer);
    return {
      file: `website-promo/ws-${workspaceId}/${name}`,
      fileName: name,
      mimeType: item.mimeType,
      bytes: item.buffer.length,
      kind: item.kind,
      label: item.label,
      source: item.source,
    };
  };
  try {
    if (extracted.logo) out.logo = write(extracted.logo, 'logo');
  } catch (e) {
    console.warn('website-promo: brochure logo save failed:', e && e.message);
  }
  for (const item of extracted.assets || []) {
    try {
      out.assets.push(write(item, 'asset'));
    } catch (e) {
      console.warn('website-promo: brochure asset save failed:', e && e.message);
    }
  }
  return out;
}

/**
 * Repeat promo submission for an email that already owns a lead
 * (one-email-one-lead rule): fold the submission into that lead instead
 * of creating a duplicate or erroring at a public visitor. The
 * submission is recorded on the existing lead as a `promo_resubmission`
 * lead event; scalar fields are filled ONLY where the existing lead is
 * empty (never overwritten) and tags are unioned. Returns { id } so the
 * caller responds exactly as for a fresh submission. The brochure
 * facts are attached by the caller against the returned id, same as a
 * fresh lead.
 */
function foldPromoIntoExistingLead(workspaceId, existingLeadId, payload, noteParts) {
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
  for (const f of ['category', 'phone', 'address', 'city', 'state', 'description']) {
    if (existing && isEmpty(existing[f]) && !isEmpty(payload[f])) patch[f] = payload[f];
  }
  if (existing && isEmpty(existing.services) && Array.isArray(payload.services) && payload.services.length) {
    patch.services = payload.services;
  }
  if (existing && isEmpty(existing.social_links) && !isEmpty(payload.social_links)) {
    patch.social_links = payload.social_links;
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
      console.warn(`website-promo: fold field-fill failed for lead ${leadId}:`, e && e.message);
    }
  }
  try {
    domain.withDb(workspaceId, (db) => {
      db.prepare('INSERT INTO lead_events (lead_id, type, detail) VALUES (?, ?, ?)').run(
        leadId,
        'promo_resubmission',
        noteParts.join('\n').slice(0, 2000)
      );
    });
  } catch (e) {
    console.warn(`website-promo: fold event log failed for lead ${leadId}:`, e && e.message);
  }
  return { id: leadId };
}

router.get('/config', async (_req, res) => {
  try {
    const captchaCfg = await getCaptchaConfig();
    res.json({
      ok: true,
      data: {
        features: FEATURE_OPTIONS,
        captcha: captchaCfg,
      },
    });
  } catch (e) {
    fail(res, e, 500);
  }
});

router.post('/submit', submitLimit, captcha, async (req, res) => {
  try {
    const workspaceId = promoWorkspaceId();
    await assertWorkspaceExists(workspaceId);
    const body = req.body || {};

    const contactName = clip(body.name || body.contactName, 120);
    const email = clip(body.email, 200);
    const phone = clip(body.phone, 40);
    const businessName = clip(body.businessName || body.business_name, 200);
    const category = clip(body.businessCategory || body.category, 120);
    const address = clip(body.businessAddress || body.address, 300);
    const city = clip(body.city, 100);
    const state = clip(body.state, 40);
    const services = parseServices(body.services || body.servicesList);
    const social = parseSocial(body.social || body.socialMedia || body.socialHandles);
    const features = parseFeatures(body.features || body.desiredFeatures);

    if (!contactName) {
      const err = new Error('Name is required');
      err.code = 'VALIDATION';
      throw err;
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      const err = new Error('A valid email is required');
      err.code = 'VALIDATION';
      throw err;
    }
    if (!phone) {
      const err = new Error('Phone is required');
      err.code = 'VALIDATION';
      throw err;
    }
    if (!businessName) {
      const err = new Error('Business name is required');
      err.code = 'VALIDATION';
      throw err;
    }
    if (!category) {
      const err = new Error('Business category is required');
      err.code = 'VALIDATION';
      throw err;
    }
    if (!city || !state) {
      const err = new Error('City and state are required');
      err.code = 'VALIDATION';
      throw err;
    }

    const brochureMeta = saveBrochure(workspaceId, body.brochure);
    // Brand extraction is best-effort: both passes never throw, and a
    // 'pending' palette still leaves the brochure on the lead. The
    // workspace db goes in so the palette pass can use the workspace's
    // own OpenAI settings (src/ai.js) before the histogram fallback; the
    // palette result's logo_box (image brochures) feeds the asset pass
    // so the logo usually costs no extra vision call.
    let brochurePalette = null;
    let savedAssets = { logo: null, assets: [] };
    if (brochureMeta) {
      try {
        const extracted = await domain.withDb(workspaceId, async (db) => {
          const palette = await extractBrochurePalette(brochureMeta.buf, brochureMeta.kind, { db });
          const assets = await extractBrochureAssets(brochureMeta.buf, brochureMeta.kind, {
            db,
            logoBox: palette && 'logo_box' in palette ? palette.logo_box : undefined,
          });
          return { palette, assets };
        });
        brochurePalette = extracted.palette;
        savedAssets = saveBrochureAssets(workspaceId, extracted.assets);
      } catch (e) {
        console.warn('website-promo: brochure extraction failed:', e && e.message);
      }
    }
    const featureLabels = FEATURE_OPTIONS.filter((f) => features.includes(f.id)).map((f) => f.label);

    const noteParts = [
      'Website promo form (Facebook ad)',
      `Contact name: ${contactName}`,
      features.length ? `Desired features: ${featureLabels.join(', ') || features.join(', ')}` : null,
      brochureMeta
        ? `Brochure: ${brochureMeta.fileName} (${brochureMeta.bytes} bytes)` +
          (brochurePalette && brochurePalette.status === 'extracted'
            ? ` — brand colors: ${brochurePalette.palette.join(', ')}` +
              (brochurePalette.palette_source === 'openai' ? ' (via OpenAI)' : '')
            : ' — brand colors pending')
        : null,
      savedAssets.logo ? `Logo extracted from brochure: ${savedAssets.logo.fileName}` : null,
      savedAssets.assets.length
        ? `Brand assets from brochure: ${savedAssets.assets.map((a) => a.fileName).join(', ')}`
        : null,
    ].filter(Boolean);

    // One email = one lead: a repeat submission folds into the lead
    // that already owns the email (same success response either way).
    let lead;
    let folded = false;
    const promoPayload = {
      business_name: businessName,
      category,
      phone,
      email,
      address: address || null,
      city,
      state,
      services: services.length ? services : null,
      social_links: Object.keys(social).length ? social : null,
      source: 'facebook_ad',
      source_ref: 'website-promo',
      status: 'new',
      tags: ['website-promo', 'facebook-ad', ...features.slice(0, 8)],
      lead_group: 'Website promo',
      notes: noteParts.join('\n'),
      description: contactName ? `Promo lead — contact ${contactName}` : 'Promo lead from /website-promo',
    };
    try {
      lead = domain.leadsCreate(workspaceId, promoPayload);
    } catch (e) {
      if (!e || e.code !== 'DUPLICATE_EMAIL' || !e.existingLeadId) throw e;
      folded = true;
      lead = foldPromoIntoExistingLead(workspaceId, e.existingLeadId, promoPayload, noteParts);
    }

    // Store the brochure + extracted palette where the design flow reads
    // brand cues: the `site.style_guide` business fact (same shape
    // siteIngest writes; src/designJobs.js puts it into brief.style_guide,
    // and its instruction is theme.primary = style_guide.primary). Written
    // even when extraction is 'pending' so the design step can find the
    // brochure file itself. A fact-write failure must not lose the lead.
    if (brochureMeta) {
      try {
        const guide = {
          primary: brochurePalette ? brochurePalette.primary : null,
          secondary: brochurePalette ? brochurePalette.secondary : null,
          background: null,
          ink: null,
          palette: brochurePalette ? brochurePalette.palette : [],
          fonts: [],
          // Same convention as siteIngest's guide.logo: a string that
          // locates the logo image — here the EXPORT_ROOT-relative path
          // of the logo lifted out of the brochure (null when none).
          logo: savedAssets.logo ? savedAssets.logo.file : null,
          source: 'website-promo-brochure',
          palette_source: brochurePalette ? brochurePalette.palette_source || 'pending' : 'pending',
          direction:
            'Brand colors extracted from the brochure the business uploaded with its promo form; use the palette as brand cues.',
          // Complementing brand material from the same brochure (logo
          // excluded — it is guide.logo). file is EXPORT_ROOT-relative;
          // source is 'pdf-embed' (pulled from the PDF) — image-brochure
          // logos come from a vision crop and land only in guide.logo.
          assets: savedAssets.assets.map((a) => ({
            file: a.file,
            kind: a.kind,
            label: a.label,
            source: a.source,
            mimeType: a.mimeType,
            bytes: a.bytes,
          })),
          brochure: {
            file: brochureMeta.fileName,
            mimeType: brochureMeta.mimeType,
            bytes: brochureMeta.bytes,
            palette_status: brochurePalette ? brochurePalette.status : 'pending',
          },
        };
        domain.leadsAddFact(workspaceId, lead.id, {
          fact_key: 'site.style_guide',
          value: JSON.stringify(guide),
          source: 'website-promo brochure upload',
          confidence: 'medium',
          claim_class: 'OWNER_PROVIDED',
        });
        if (brochurePalette && brochurePalette.primary) {
          domain.leadsAddFact(workspaceId, lead.id, {
            fact_key: 'site.brand.primary',
            value: brochurePalette.primary,
            source: 'website-promo brochure upload',
            confidence: 'medium',
            claim_class: 'OWNER_PROVIDED',
          });
        }
        // Mirror siteIngest's companion fact for the logo.
        if (savedAssets.logo) {
          domain.leadsAddFact(workspaceId, lead.id, {
            fact_key: 'site.brand.logo',
            value: savedAssets.logo.file,
            source: 'website-promo brochure upload',
            confidence: 'medium',
            claim_class: 'OWNER_PROVIDED',
          });
        }
      } catch (e) {
        console.warn(`website-promo: style guide save failed for lead ${lead.id}:`, e && e.message);
      }
    }

    try {
      domain.withDb(workspaceId, (db) => {
        db.prepare('INSERT INTO activity_log (area, message) VALUES (?, ?)').run(
          'leads',
          folded
            ? `Website promo repeat submission folded into lead #${lead.id}: ${businessName} (${email})`
            : `Website promo lead #${lead.id}: ${businessName} (${email})`
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
module.exports.FEATURE_OPTIONS = FEATURE_OPTIONS;
