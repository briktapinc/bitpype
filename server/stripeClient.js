'use strict';

const Stripe = require('stripe');
const platform = require('./platform');
const { PLAN_STANDARD, PLAN_PRO, PLAN_PREMIUM, normalizePlanId } = require('./plans');

let cached = { key: null, client: null };

async function getSecretKey() {
  const fromEnv = process.env.STRIPE_SECRET_KEY || '';
  if (fromEnv) return fromEnv;
  return platform.getPlatformSetting('stripe.secret_key', '');
}

async function getStripe() {
  const key = String((await getSecretKey()) || '').trim();
  if (!key) {
    const e = new Error('Stripe is not configured (stripe.secret_key / STRIPE_SECRET_KEY)');
    e.code = 'STRIPE_NOT_CONFIGURED';
    throw e;
  }
  if (cached.client && cached.key === key) return cached.client;
  // StripeClient pattern (not deprecated global apiKey)
  // Use the SDK's bundled API version (keep Stripe Node current).
  const client = new Stripe(key);
  cached = { key, client };
  return client;
}

async function getWebhookSecret() {
  return process.env.STRIPE_WEBHOOK_SECRET || (await platform.getPlatformSetting('stripe.webhook_secret', ''));
}

async function getPublishableKey() {
  return process.env.STRIPE_PUBLISHABLE_KEY || (await platform.getPlatformSetting('stripe.publishable_key', ''));
}

/** @deprecated Prefer getPriceIdForPlan — kept for one-price legacy installs. */
/**
 * Resolve Stripe Price ID for a paid plan.
 * Env: STRIPE_PRICE_ID_STANDARD / STRIPE_PRICE_ID_PRO / STRIPE_PRICE_ID_PREMIUM
 * Legacy: STRIPE_PRICE_ID or stripe.price_id maps to Standard.
 */
async function getPriceIdForPlan(planId) {
  const plan = normalizePlanId(planId);
  if (plan === PLAN_PREMIUM) {
    const fromEnv = process.env.STRIPE_PRICE_ID_PREMIUM || '';
    if (fromEnv) return String(fromEnv).trim();
    return String((await platform.getPlatformSetting('stripe.price_id_premium', '')) || '').trim();
  }
  if (plan === PLAN_PRO) {
    const fromEnv = process.env.STRIPE_PRICE_ID_PRO || '';
    if (fromEnv) return String(fromEnv).trim();
    return String((await platform.getPlatformSetting('stripe.price_id_pro', '')) || '').trim();
  }
  if (plan === PLAN_STANDARD) {
    const fromEnv = process.env.STRIPE_PRICE_ID_STANDARD || process.env.STRIPE_PRICE_ID || '';
    if (fromEnv) return String(fromEnv).trim();
    const dedicated = String((await platform.getPlatformSetting('stripe.price_id_standard', '')) || '').trim();
    if (dedicated) return dedicated;
    return String((await platform.getPlatformSetting('stripe.price_id', '')) || '').trim();
  }
  return '';
}

async function getConfiguredPriceIds() {
  const standard = await getPriceIdForPlan(PLAN_STANDARD);
  const pro = await getPriceIdForPlan(PLAN_PRO);
  const premium = await getPriceIdForPlan(PLAN_PREMIUM);
  return { standard, pro, premium };
}

/** Map a Stripe price_… id back to a plan tier. */
async function planIdFromPriceId(priceId) {
  const pid = String(priceId || '').trim();
  if (!pid) return null;
  const { standard, pro, premium } = await getConfiguredPriceIds();
  if (premium && pid === premium) return PLAN_PREMIUM;
  if (pro && pid === pro) return PLAN_PRO;
  if (standard && pid === standard) return PLAN_STANDARD;
  return null;
}

/* ------------------------------------------------------------------ */
/* Public URL resolver (Batch 56)                                      */
/*                                                                     */
/* appUrl() is THE resolver for the app's public base URL — every      */
/* first-party absolute link (claim/billing/portal emails, OAuth       */
/* callbacks, staff/portal links, og tags) is built from it. Do not    */
/* read APP_URL or the setting anywhere else.                          */
/*                                                                     */
/* Resolution order:                                                   */
/*   1. the stored platform setting `general.public_url`               */
/*      (Admin → Settings → General), cached here and refreshed at     */
/*      boot (refreshPublicUrl, called by server.js) and on every      */
/*      save (platform.setPlatformSetting calls setPublicUrlCache);    */
/*   2. the APP_URL env var;                                           */
/*   3. the setting's def default in PLATFORM_SETTING_DEFS — the only  */
/*      place the production domain literal lives in shipped code.     */
/*                                                                     */
/* The value can only come back empty if all three are somehow blank,  */
/* so the loud APP_URL_REQUIRED throw stays for that case: a silent    */
/* localhost fallback in production would send real customers broken   */
/* links. (In non-production the def default now answers instead of    */
/* the old localhost guess — set APP_URL or the setting for local      */
/* link building.)                                                     */
/* ------------------------------------------------------------------ */
let cachedPublicUrl = '';

function normalizePublicUrl(raw) {
  return String(raw == null ? '' : raw)
    .trim()
    .replace(/\/+$/, '');
}

function publicUrlDefDefault() {
  try {
    const def = (platform.PLATFORM_SETTING_DEFS || []).find((d) => d.key === 'general.public_url');
    return def ? normalizePublicUrl(def.default) : '';
  } catch {
    return '';
  }
}

/** Called by platform.setPlatformSetting after a successful save. */
function setPublicUrlCache(value) {
  cachedPublicUrl = normalizePublicUrl(value);
}

/** Boot hook (server.js): prime the cache from the stored setting row. */
async function refreshPublicUrl() {
  try {
    const stored = await platform.getStoredPlatformSetting('general.public_url');
    if (stored && /^https?:\/\//i.test(String(stored).trim())) setPublicUrlCache(stored);
  } catch {
    /* cache stays empty — env/default resolution still applies */
  }
  return cachedPublicUrl;
}

/**
 * The explicitly CONFIGURED public URL — stored setting or APP_URL env —
 * WITHOUT the def-default fallback. For callers that must distinguish
 * "configured" from "defaulted" (the interest-link secret guard refuses
 * its dev fallback on configured public hosts). Not a second resolver:
 * appUrl() remains the single source for link building.
 */
function configuredPublicUrl() {
  return cachedPublicUrl || normalizePublicUrl(process.env.APP_URL);
}

function appUrl() {
  const raw = cachedPublicUrl || normalizePublicUrl(process.env.APP_URL) || publicUrlDefDefault();
  if (!raw) {
    throw Object.assign(
      new Error('Public URL is not configured: set "Public URL" in Admin → Settings → General (or the APP_URL env var).'),
      { code: 'APP_URL_REQUIRED' }
    );
  }
  return raw;
}

function integrationId(label = 'billing-checkout') {
  const suffix = Array.from({ length: 8 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('');
  return `${label}-${suffix}`;
}

module.exports = {
  getStripe,
  getWebhookSecret,
  getPublishableKey,
  getPriceIdForPlan,
  getConfiguredPriceIds,
  planIdFromPriceId,
  getSecretKey,
  appUrl,
  configuredPublicUrl,
  setPublicUrlCache,
  refreshPublicUrl,
  normalizePublicUrl,
  integrationId,
};
