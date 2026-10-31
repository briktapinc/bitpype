'use strict';

/**
 * Bitpype subscription plan catalog.
 * Stripe Price IDs live in platform settings (stripe.price_id_standard / pro / premium).
 * Users without an active paid sub are on Free.
 */

const PLAN_FREE = 'free';
const PLAN_STANDARD = 'standard';
const PLAN_PRO = 'pro';
const PLAN_PREMIUM = 'premium';

const PAID_PLANS = [PLAN_STANDARD, PLAN_PRO, PLAN_PREMIUM];

const PLANS = {
  [PLAN_FREE]: {
    id: PLAN_FREE,
    name: 'Free',
    tagline: 'Launch a site and edit it yourself.',
    priceLabel: 'Free',
    interval: null,
    chatRequestsPerDay: 5,
    features: [
      'Free website',
      'Inline edits',
      'Preview hosting',
      'Design change requests',
      'Contact form builder — results emailed only',
      'No included support',
      'Social media images — use credits',
    ],
    entitlements: {
      website: true,
      inlineEdits: true,
      previewHosting: true,
      designChangeRequests: true,
      supportCadence: 'none',
      socialImagesIncluded: false,
      socialImagesPaid: true,
      formBuilder: true,
      formInbox: false,
      formMcp: false,
      formMuseEncrypt: false,
      socialMcpSchedule: false,
      siteModules: false,
      chatbot: false,
    },
  },
  [PLAN_STANDARD]: {
    id: PLAN_STANDARD,
    name: 'Standard',
    tagline: 'Monthly support with credit-based social ads.',
    priceLabel: 'Monthly',
    interval: 'month',
    chatRequestsPerDay: 20,
    features: [
      'Free website',
      'Inline edits',
      'Preview hosting',
      'Design change requests',
      'Contact form inbox in the portal',
      'Site modules — blog, shop, courses, gallery, directory, chatbot',
      'AI site chatbot (portal client MCP agent)',
      'Monthly support',
      'Social media images — use credits',
    ],
    entitlements: {
      website: true,
      inlineEdits: true,
      previewHosting: true,
      designChangeRequests: true,
      supportCadence: 'monthly',
      socialImagesIncluded: false,
      socialImagesPaid: true,
      formBuilder: true,
      formInbox: true,
      formMcp: false,
      formMuseEncrypt: false,
      socialMcpSchedule: false,
      siteModules: true,
      chatbot: true,
    },
  },
  [PLAN_PRO]: {
    id: PLAN_PRO,
    name: 'Pro',
    tagline: 'Monthly support with social images included.',
    priceLabel: 'Monthly',
    interval: 'month',
    chatRequestsPerDay: 50,
    features: [
      'Free website',
      'Inline edits',
      'Preview hosting',
      'Design change requests',
      'Contact form inbox in the portal',
      'Site modules — blog, shop, courses, gallery, directory, chatbot',
      'AI site chatbot (portal client MCP agent)',
      'Monthly support',
      'Social media images included (no credit charge for images)',
    ],
    entitlements: {
      website: true,
      inlineEdits: true,
      previewHosting: true,
      designChangeRequests: true,
      supportCadence: 'monthly',
      socialImagesIncluded: true,
      socialImagesPaid: false,
      formBuilder: true,
      formInbox: true,
      formMcp: false,
      formMuseEncrypt: false,
      socialMcpSchedule: false,
      siteModules: true,
      chatbot: true,
    },
  },
  [PLAN_PREMIUM]: {
    id: PLAN_PREMIUM,
    name: 'Premium',
    tagline: 'All features included, plus a monthly support call.',
    priceLabel: 'Monthly',
    interval: 'month',
    chatRequestsPerDay: 150,
    features: [
      'Free website',
      'Inline edits',
      'Preview hosting',
      'Design change requests',
      'Encrypted form submissions + Muse + MCP',
      'Site modules — blog, shop, courses, gallery, directory, chatbot',
      'AI site chatbot (portal client MCP agent)',
      'MCP social post scheduling',
      'Monthly support call',
      'Social media images included (no credit charge for images)',
    ],
    entitlements: {
      website: true,
      inlineEdits: true,
      previewHosting: true,
      designChangeRequests: true,
      supportCadence: 'weekly',
      socialImagesIncluded: true,
      socialImagesPaid: false,
      formBuilder: true,
      formInbox: true,
      formMcp: true,
      formMuseEncrypt: true,
      socialMcpSchedule: true,
      siteModules: true,
      chatbot: true,
    },
  },
};

const PLAN_RANK = {
  [PLAN_FREE]: 0,
  [PLAN_STANDARD]: 1,
  [PLAN_PRO]: 2,
  [PLAN_PREMIUM]: 3,
};

function normalizePlanId(raw) {
  const id = String(raw || '')
    .trim()
    .toLowerCase();
  if (id === PLAN_STANDARD || id === PLAN_PRO || id === PLAN_PREMIUM || id === PLAN_FREE) return id;
  return PLAN_FREE;
}

/* ------------------------------------------------------------------ */
/* Batch 57 — admin-editable plan CONTENTS overrides.                  */
/*                                                                     */
/* The PLANS catalog above stays the code default. An admin can        */
/* override a plan's name / tagline / feature bullets / entitlements   */
/* / design-chat daily cap (Batch 97) from Admin → Settings →          */
/* Billing → Package contents; the overrides   */
/* live in platform settings (plans.contents_<plan>, one JSON row per   */
/* plan) and are validated + owned by server/planContents.js, which    */
/* pushes the parsed overrides into this module. Resolution is         */
/* centralised HERE so every consumer of getPlan / listPlans /         */
/* publicPlan sees the same contents — nobody reads the raw catalog    */
/* for display. Merge rule: an override field replaces the default     */
/* field wholesale (features and entitlements are never merged         */
/* key-by-key — a partial entitlements merge could silently grant a   */
/* default the admin meant to revoke). id / priceLabel / interval are  */
/* never overridable: ids + rank are structural, prices live in the    */
/* pricing panel (server/pricingAdmin.js).                             */
/* ------------------------------------------------------------------ */
let contentsOverrides = {};

function resolvePlan(id) {
  const base = PLANS[id] || PLANS[PLAN_FREE];
  const o = contentsOverrides[base.id];
  if (!o) return base;
  const merged = { ...base };
  if (typeof o.name === 'string') merged.name = o.name;
  if (typeof o.tagline === 'string') merged.tagline = o.tagline;
  if (Array.isArray(o.features)) merged.features = o.features.slice();
  if (o.entitlements && typeof o.entitlements === 'object') {
    merged.entitlements = { ...o.entitlements };
  }
  // Batch 97: present-in-override wins, including an explicit null
  // (admin set the plan's design-chat cap to unlimited).
  if ('chatRequestsPerDay' in o) merged.chatRequestsPerDay = o.chatRequestsPerDay;
  return merged;
}

/** Called by server/planContents.js (boot prime + every save). */
function setContentsOverrides(map) {
  contentsOverrides = map && typeof map === 'object' ? map : {};
}

/** Test/debug view of the active overrides (parsed objects, by plan id). */
function getContentsOverrides() {
  return contentsOverrides;
}

function getPlan(planId) {
  return resolvePlan(normalizePlanId(planId));
}

/**
 * Batch 97 — the plan's daily design-chat ("Improve with AI")
 * request cap for one site, or null for unlimited. Ely's shipped
 * defaults live in the catalog above (Free 5, Standard 20, Pro 50,
 * Premium 150); admins can change or clear the cap per plan in
 * Admin → Settings → Billing → Package contents, and the value
 * follows the plan through the Batch 57 contents overrides.
 * Anything that is not a positive whole number means unlimited.
 */
function chatRequestsPerDayFor(planId) {
  const v = getPlan(planId).chatRequestsPerDay;
  return Number.isInteger(v) && v > 0 ? v : null;
}

function listPlans() {
  return [PLAN_FREE, PLAN_STANDARD, PLAN_PRO, PLAN_PREMIUM].map((id) => ({ ...resolvePlan(id) }));
}

function isPaidPlan(planId) {
  return PAID_PLANS.includes(normalizePlanId(planId));
}

function maxPlan(a, b) {
  const pa = normalizePlanId(a);
  const pb = normalizePlanId(b);
  return (PLAN_RANK[pa] || 0) >= (PLAN_RANK[pb] || 0) ? pa : pb;
}

function publicPlan(planId, extras = {}) {
  const plan = getPlan(planId);
  return {
    id: plan.id,
    name: plan.name,
    tagline: plan.tagline,
    priceLabel: extras.priceLabel || plan.priceLabel,
    interval: plan.interval,
    features: plan.features.slice(),
    entitlements: { ...plan.entitlements },
    ...extras,
  };
}

module.exports = {
  PLAN_FREE,
  PLAN_STANDARD,
  PLAN_PRO,
  PLAN_PREMIUM,
  PAID_PLANS,
  PLANS,
  PLAN_RANK,
  normalizePlanId,
  getPlan,
  chatRequestsPerDayFor,
  listPlans,
  isPaidPlan,
  maxPlan,
  publicPlan,
  setContentsOverrides,
  getContentsOverrides,
};
