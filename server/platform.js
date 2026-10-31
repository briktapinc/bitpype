'use strict';

/**
 * Platform-wide (super-admin) settings — defaults for new workspaces,
 * global email/SMS, registration flags, etc.
 *
 * Optional `/app/data/platform-defaults.json` (volume) overrides catalog
 * defaults at seed time for secrets and site-specific values. Seed uses
 * INSERT IGNORE so already-changed DB values are never overwritten.
 */

const fs = require('fs');
const path = require('path');
const { query } = require('./db');
const secretBox = require('../src/secretBox');

function platformDefaultsPath() {
  // Prefer the mounted workspaces volume so the snapshot survives container rebuilds.
  const wsRoot =
    process.env.WORKSPACE_DATA_DIR || process.env.DATA_DIR || path.join(__dirname, '..', 'data', 'workspaces');
  return path.join(wsRoot, 'platform-defaults.json');
}

function loadPlatformDefaultsFile() {
  try {
    const p = platformDefaultsPath();
    if (!fs.existsSync(p)) return {};
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch (e) {
    console.warn('[platform] platform-defaults.json:', e.message);
    return {};
  }
}
const PLATFORM_SECRET_KEYS = [
  'ai.api_key',
  'muse.model_api_key',
  'smtp.pass',
  // Batch 48: Cloudflare Email Sending token for the native mail provider.
  'mail.cf_token',
  'cf.api_token',
  'pexels.api_key',
  'providers.tavily.api_key',
  'fal.api_key',
  'google.places_api_key',
  'sms.auth_token',
  'sms.api_key',
  'stripe.secret_key',
  'stripe.webhook_secret',
  'twilio.auth_token',
  'meta.app_secret',
  'captcha.secret_key',
  // Batch 46 (GBP manager): platform Google OAuth client secret.
  'gbp.oauth_client_secret',
  // Batch 59: Hostinger API token (buys real VPS servers — platform only).
  'hostinger.api_token',
];

/** Catalog of platform settings shown in the admin UI. */
const PLATFORM_SETTING_DEFS = [
  // General
  // Batch 56: the app's canonical public base URL. EVERY first-party
  // absolute link (claim/billing/portal emails, OAuth callbacks, og tags,
  // staff/portal links) is built from this value through the single
  // resolver, stripeClient.appUrl(). This def default is the ONLY place
  // the literal production domain may appear in shipped code — pinned by
  // tests/batch56-no-hardcoded-domains-regressions.cjs.
  { key: 'general.public_url', group: 'general', label: 'Public URL', default: 'https://bitpype.com' },
  { key: 'app.name', group: 'general', label: 'App name', default: 'Bitpype' },
  { key: 'support.email', group: 'general', label: 'Support email', default: '' },
  {
    key: 'registration.open',
    group: 'general',
    label: 'Open registration — Register tab & sign-ups',
    default: '1',
  },
  { key: 'maintenance_mode', group: 'general', label: 'Maintenance mode (1/0)', default: '0' },
  {
    key: 'default.workspace_name',
    group: 'general',
    label: 'Default workspace name pattern',
    default: "{name}'s workspace",
  },
  { key: 'captcha.enabled', group: 'general', label: 'Captcha on public forms (1/0)', default: '1' },
  {
    // Batch 29: JSON { owner: {tabs, modules}, renter: {tabs, modules} }.
    // Managed via Admin → Portal access (not the settings forms, and the
    // 'access' group keeps it out of WORKSPACE_SEED_KEYS).
    key: 'portal_access.type_defaults',
    group: 'access',
    label: 'Portal type defaults (JSON — edit via Admin → Portal access)',
    default: '',
  },
  { key: 'captcha.site_key', group: 'general', label: 'Cloudflare Turnstile site key', default: '' },
  { key: 'captcha.secret_key', group: 'general', label: 'Cloudflare Turnstile secret key', default: '', secret: true },

  // Landing page (Batch 58): YouTube videos on /landing. The stored
  // value is a canonical JSON array of YouTube video IDs — Ely pastes
  // embed codes/links in Admin → Settings → Landing and
  // server/landingVideos.js extracts the IDs at save time (both write
  // choke points); pasted HTML is never stored or rendered.
  { key: 'landing.video_embeds', group: 'landing', label: 'Landing page videos (YouTube)', default: '[]' },

  // Thank-you page (Batch 70): after a /landing submission the visitor
  // is redirected to /thankyou, which shows a demo video and a Calendly
  // booking button — both pasted here by Ely. The video stores the
  // canonical YouTube ID only (Batch 58 parser); the Calendly link must
  // be an https URL on calendly.com. Empty = that section of /thankyou
  // does not render at all.
  { key: 'landing.thankyou_video', group: 'landing', label: 'Thank-you page demo video (YouTube)', default: '' },
  { key: 'landing.thankyou_calendly_url', group: 'landing', label: 'Thank-you page Calendly link', default: '' },

  // Hostinger one-click deploys (Batch 59): platform-only — the API
  // token buys REAL VPS servers on the connected Hostinger account, so
  // it is secretBox-encrypted, never seeded into workspaces (this group
  // stays out of WORKSPACE_SEED_KEYS), and every deploy is gated behind
  // a priced confirmation in the lead drawer. The three defaults are
  // Hostinger catalog/API identifiers (NOT prices): the catalog price
  // ID of the VPS plan to buy, plus the data center and OS template IDs
  // the purchase setup requires. Live prices are always read back from
  // the Hostinger catalog at confirm time — never stored here.
  { key: 'hostinger.api_token', group: 'hostinger', label: 'Hostinger API token (hPanel → API)', default: '', secret: true },
  { key: 'hostinger.default_price_id', group: 'hostinger', label: 'Default VPS plan — catalog price ID (e.g. hostingercom-vps-kvm2-usd-1m)', default: '' },
  { key: 'hostinger.data_center_id', group: 'hostinger', label: 'Default data center ID (Hostinger API)', default: '' },
  { key: 'hostinger.template_id', group: 'hostinger', label: 'Default OS template ID — Ubuntu (Hostinger API)', default: '' },

  // Cost defaults for new workspaces
  { key: 'cost.daily_budget_usd', group: 'general', label: 'Default daily AI budget (USD)', default: '10' },
  { key: 'cost.max_websites_per_day', group: 'general', label: 'Default max websites / day', default: '25' },
  { key: 'cost.max_outreach_per_day', group: 'general', label: 'Default max outreach / day', default: '200' },

  // Email / SMTP (site defaults; secrets live in data/platform-defaults.json on the server)
  // Batch 55 (review B-1): smtp.host defaults EMPTY — the old Mailjet
  // host default made fresh installs look "configured" with no
  // credentials, so the stub never engaged and mail paths hung on real
  // outbound connections. seedPlatformDefaults uses INSERT IGNORE, so
  // existing installs keep whatever host they already have stored.
  { key: 'smtp.host', group: 'email', label: 'SMTP host', default: '' },
  { key: 'smtp.port', group: 'email', label: 'SMTP port', default: '587' },
  { key: 'smtp.secure', group: 'email', label: 'SMTP secure (1/0)', default: '0' },
  {
    key: 'smtp.require_tls',
    group: 'email',
    label: 'SMTP require TLS (1/0) — refuse to send the password over an unencrypted connection',
    default: '1',
  },
  { key: 'smtp.user', group: 'email', label: 'SMTP user', default: '' },
  { key: 'smtp.pass', group: 'email', label: 'SMTP password', default: '', secret: true },
  { key: 'smtp.from_name', group: 'email', label: 'From name', default: 'Bitpype' },
  // Batch 56: no hardcoded first-party address as a default — fresh installs
  // start unconfigured (the Batch 55 pattern); existing installs keep their
  // stored value (seed is INSERT IGNORE, saves are explicit).
  { key: 'smtp.from_email', group: 'email', label: 'From email', default: '' },
  // Batch 48: selectable mail provider. Default 'custom' = the SMTP
  // settings above (Mailjet today); 'cloudflare' = native Cloudflare
  // Email Sending. The account id falls back to the workspace/platform
  // cf.account_id when mail.cf_account_id is empty. mail.* keys in the
  // email group auto-seed into workspaces (WORKSPACE_SEED_KEYS).
  {
    key: 'mail.provider',
    group: 'email',
    label: 'Mail provider (custom = SMTP/Mailjet, cloudflare = Cloudflare Email Sending)',
    default: 'custom',
  },
  {
    key: 'mail.cf_account_id',
    group: 'email',
    label: 'Cloudflare account ID for email (blank = use the Cloudflare account ID)',
    default: '',
  },
  {
    key: 'mail.cf_token',
    group: 'email',
    label: 'Cloudflare Email Sending API token',
    default: '',
    secret: true,
  },
  {
    key: 'mail.footer',
    group: 'email',
    label: 'Default mail footer',
    default: 'Reply STOP to opt out of future messages.',
  },

  // SMS
  { key: 'sms.enabled', group: 'sms', label: 'SMS enabled (1/0)', default: '0' },
  { key: 'sms.provider', group: 'sms', label: 'Provider (twilio|vonage|custom)', default: 'twilio' },
  { key: 'sms.account_sid', group: 'sms', label: 'Account SID / key id', default: '' },
  { key: 'sms.auth_token', group: 'sms', label: 'Auth token', default: '', secret: true },
  { key: 'sms.api_key', group: 'sms', label: 'API key (alternate)', default: '', secret: true },
  { key: 'sms.from_number', group: 'sms', label: 'From number', default: '' },
  { key: 'sms.webhook_url', group: 'sms', label: 'Inbound webhook URL', default: '' },

  // Default API keys / AI (copied into new workspaces when empty)
  { key: 'ai.api_key', group: 'keys', label: 'OpenAI / AI API key', default: '', secret: true },
  { key: 'ai.base_url', group: 'keys', label: 'AI base URL', default: 'https://api.openai.com/v1' },
  { key: 'ai.model.default', group: 'keys', label: 'Default AI model', default: 'gpt-4o-mini' },
  // Meta Muse Model API (https://dev.meta.ai — keys LLM_…, OpenAI-compatible chat/completions)
  { key: 'muse.model_api_key', group: 'keys', label: 'Meta Muse Model API key (LLM_…)', default: '', secret: true },
  {
    key: 'muse.model_base_url',
    group: 'keys',
    label: 'Meta Muse Model API base URL',
    default: 'https://api.meta.ai/v1',
  },
  { key: 'muse.model_default', group: 'keys', label: 'Meta Muse default model', default: 'muse-spark-1.3' },
  { key: 'providers.tavily.api_key', group: 'keys', label: 'Tavily API key', default: '', secret: true },
  { key: 'pexels.api_key', group: 'keys', label: 'Pexels API key', default: '', secret: true },
  { key: 'fal.api_key', group: 'keys', label: 'Fal API key', default: '', secret: true },
  // Google Reviews module (Batch 30): platform-only secret — read
  // server-side by the module's fetch; excluded from WORKSPACE_SEED_KEYS
  // below so the key never lands in per-workspace storage.
  { key: 'google.places_api_key', group: 'keys', label: 'Google Places API key (Reviews module)', default: '', secret: true },
  { key: 'cf.api_token', group: 'keys', label: 'Cloudflare API token', default: '', secret: true },
  { key: 'cf.account_id', group: 'keys', label: 'Cloudflare account id (platform preview account)', default: '' },
  { key: 'cf.project', group: 'keys', label: 'Cloudflare Pages project (optional override)', default: '' },
  { key: 'cf.preview_domain', group: 'keys', label: 'Cloudflare preview domain (optional)', default: '' },
  { key: 'meta.app_id', group: 'keys', label: 'Meta App ID (Facebook/Instagram)', default: '' },
  { key: 'meta.app_secret', group: 'keys', label: 'Meta App Secret', default: '', secret: true },

  // Outbound form routing to an external Muse webhook (not the Model API key above)
  { key: 'muse.enabled', group: 'integrations', label: 'Muse form routing enabled (1/0)', default: '0' },
  {
    key: 'muse.webhook_url',
    group: 'integrations',
    label: 'Muse webhook URL (POST encrypted form payloads)',
    default: '',
  },

  // Stripe / billing
  { key: 'stripe.secret_key', group: 'billing', label: 'Stripe secret key (sk_… or rk_…)', default: '', secret: true },
  { key: 'stripe.publishable_key', group: 'billing', label: 'Stripe publishable key (pk_…)', default: '' },
  {
    key: 'stripe.webhook_secret',
    group: 'billing',
    label: 'Stripe webhook signing secret (whsec_…)',
    default: '',
    secret: true,
  },
  { key: 'stripe.price_id_standard', group: 'billing', label: 'Standard plan Price ID (price_… monthly)', default: '' },
  { key: 'stripe.price_id_pro', group: 'billing', label: 'Pro plan Price ID (price_… monthly)', default: '' },
  { key: 'stripe.price_id_premium', group: 'billing', label: 'Premium plan Price ID (price_… monthly)', default: '' },
  { key: 'stripe.price_id', group: 'billing', label: 'Legacy Price ID (fallback → Standard)', default: '' },
  // Batch 24: Products behind the plan Prices, resolved + persisted by the
  // Update pricing panel (server/pricingAdmin.js) — never pasted by hand.
  {
    key: 'stripe.product_id_standard',
    group: 'billing',
    label: 'Standard plan Product ID (prod_… — set by Update pricing)',
    default: '',
  },
  {
    key: 'stripe.product_id_pro',
    group: 'billing',
    label: 'Pro plan Product ID (prod_… — set by Update pricing)',
    default: '',
  },
  {
    key: 'stripe.product_id_premium',
    group: 'billing',
    label: 'Premium plan Product ID (prod_… — set by Update pricing)',
    default: '',
  },

  // Call Tracking (Twilio Voice) — platform account; numbers are bought
  // per lead from the staff Calls screen. Empty = module dormant.
  { key: 'twilio.account_sid', group: 'calls', label: 'Twilio Account SID (AC…)', default: '' },
  { key: 'twilio.auth_token', group: 'calls', label: 'Twilio Auth Token', default: '', secret: true },
  {
    key: 'billing.amount_label',
    group: 'billing',
    label: 'Generic billing label (fallback)',
    default: 'Bitpype plans',
  },
  {
    key: 'billing.amount_label_standard',
    group: 'billing',
    label: 'Standard plan price label (e.g. $99/mo)',
    default: 'Standard · monthly',
  },
  {
    key: 'billing.amount_label_pro',
    group: 'billing',
    label: 'Pro plan price label (e.g. $169/mo)',
    default: 'Pro · monthly',
  },
  {
    key: 'billing.amount_label_premium',
    group: 'billing',
    label: 'Premium plan price label (e.g. $499/mo)',
    default: 'Premium · monthly',
  },
  // Batch 57: per-plan CONTENTS overrides (name / tagline / features /
  // entitlements) as JSON, owned by the Package contents panel in
  // Admin → Settings → Billing (server/planContents.js). Empty = the
  // code catalog in server/plans.js. Prices are NOT here — they stay
  // with the Plan pricing panel above.
  {
    key: 'plans.contents_free',
    group: 'billing',
    label: 'Free plan contents override (JSON — set by Package contents)',
    default: '',
  },
  {
    key: 'plans.contents_standard',
    group: 'billing',
    label: 'Standard plan contents override (JSON — set by Package contents)',
    default: '',
  },
  {
    key: 'plans.contents_pro',
    group: 'billing',
    label: 'Pro plan contents override (JSON — set by Package contents)',
    default: '',
  },
  {
    key: 'plans.contents_premium',
    group: 'billing',
    label: 'Premium plan contents override (JSON — set by Package contents)',
    default: '',
  },
  {
    key: 'billing.require_subscription',
    group: 'billing',
    label: 'Enforce paid plan entitlements for gated features (1/0; Free still has core website access)',
    default: '1',
  },
  { key: 'billing.trial_days', group: 'billing', label: 'Trial days on new checkout (0 = none)', default: '0' },
  {
    key: 'social.image_price_usd',
    group: 'billing',
    label: 'Legacy branded image USD log (optional; credits preferred)',
    default: '1',
  },
  { key: 'stripe.price_id_credits', group: 'billing', label: 'Credits pack Price ID (price_… one-time)', default: '' },
  {
    key: 'stripe.product_id_credits',
    group: 'billing',
    label: 'Credits pack Product ID (prod_… — set by Update pricing)',
    default: '',
  },
  { key: 'credits.pack_amount', group: 'billing', label: 'Credits granted per pack purchase', default: '50' },
  {
    key: 'credits.pack_label',
    group: 'billing',
    label: 'Credits pack label (e.g. 50 credits · $25)',
    default: '50 credits',
  },
  { key: 'credits.per_social_image', group: 'billing', label: 'Credits per branded social image', default: '1' },
  {
    key: 'credits.per_social_content',
    group: 'billing',
    label: 'Credits per social content generation (week/month)',
    default: '1',
  },
  {
    key: 'credits.usd_per_credit',
    group: 'billing',
    label: 'USD per credit (fallback when Stripe pack price unknown; referral math)',
    default: '1',
  },
  {
    key: 'referrals.reward_percent',
    group: 'billing',
    label: 'Referral reward percent of paid plan value',
    default: '10',
  },

  // Google AdSense (platform account — ads render only on Free-plan customer sites)
  { key: 'adsense.enabled', group: 'adsense', label: 'AdSense enabled', default: '0' },
  { key: 'adsense.publisher_id', group: 'adsense', label: 'AdSense publisher ID (ca-pub-…)', default: '' },
  {
    key: 'adsense.slot_id',
    group: 'adsense',
    label: 'Ad unit slot ID (optional — blank = Auto Ads decides placement)',
    default: '',
  },

  // Domain purchase flow (Batch 15): domains at or under this registration
  // price are included free with the client's first plan payment.
  {
    key: 'domain_flow.included_max_usd',
    group: 'billing',
    label: 'Domain flow: max domain registration price (USD) included free with a plan',
    default: '25',
  },

  // Domain registration (Batch 38; wire shape corrected Batch 41): the
  // platform's default registrant contact, sent as contacts.registrant
  // with EVERY Cloudflare Registrar purchase
  // (src/cfDomains.buildRegistrantContact). Platform-owned
  // (Ely's) contact — NOT derived from lead records. Read workspace-first,
  // platform-fallback per field (same order as the CF credentials).
  // Organization is the only optional field; registrations pre-flight and
  // refuse to call Cloudflare until the rest are filled (Admin →
  // Settings → Domains). Group 'domains' keeps these OUT of
  // WORKSPACE_SEED_KEYS (platform-owned, not per-workspace defaults).
  { key: 'domain.registrant_first_name', group: 'domains', label: 'Domain registrant: first name', default: '' },
  { key: 'domain.registrant_last_name', group: 'domains', label: 'Domain registrant: last name', default: '' },
  {
    key: 'domain.registrant_organization',
    group: 'domains',
    label: 'Domain registrant: organization (optional)',
    default: '',
  },
  { key: 'domain.registrant_email', group: 'domains', label: 'Domain registrant: email', default: '' },
  { key: 'domain.registrant_phone', group: 'domains', label: 'Domain registrant: phone', default: '' },
  { key: 'domain.registrant_address', group: 'domains', label: 'Domain registrant: street address', default: '' },
  { key: 'domain.registrant_city', group: 'domains', label: 'Domain registrant: city', default: '' },
  { key: 'domain.registrant_state', group: 'domains', label: 'Domain registrant: state / province', default: '' },
  { key: 'domain.registrant_postal_code', group: 'domains', label: 'Domain registrant: postal code', default: '' },
  {
    key: 'domain.registrant_country',
    group: 'domains',
    label: 'Domain registrant: country (ISO 2-letter)',
    default: 'US',
  },

  // Google Business Profile manager (Batch 46, Phase 1): the platform's
  // Google OAuth client + Business Profile API application state. Group
  // 'gbp' keeps these OUT of WORKSPACE_SEED_KEYS (platform-owned, edited
  // in Admin → Google Business). The API stays at quota 0 until Google
  // approves the application (checklist: gbp-google-clock-checklist);
  // gbp.api_approval_state is the flag every GBP surface renders from —
  // 'pending' holds change sets at "ready", 'approved' unlocks the push
  // path. The OAuth client itself is created by Ely in Google Cloud
  // (checklist Step 4) — until client id/secret land here, the connect
  // flow renders an honest "not configured yet" state.
  {
    key: 'gbp.oauth_client_id',
    group: 'gbp',
    label: 'Google OAuth client ID (Business Profile manager)',
    default: '',
  },
  {
    key: 'gbp.oauth_client_secret',
    group: 'gbp',
    label: 'Google OAuth client secret',
    default: '',
    secret: true,
  },
  {
    key: 'gbp.cloud_project_number',
    group: 'gbp',
    label: 'Google Cloud project NUMBER (Business Profile API application)',
    default: '',
  },
  {
    key: 'gbp.api_approval_state',
    group: 'gbp',
    label: 'Business Profile API approval state (pending|approved)',
    default: 'pending',
  },
  {
    key: 'gbp.api_approved_at',
    group: 'gbp',
    label: 'Business Profile API approved date (YYYY-MM-DD)',
    default: '',
  },
  // Branding (Batch 87 — Ely 2026-10-30): the site logo for dark and
  // light screens + the brand tagline, editable in Admin → Settings →
  // Branding. Empty logo value = the committed default asset
  // (public/brand/logo-white.png / logo-black.png); uploaded files are
  // stored on the data volume by server/branding.js and the setting
  // holds their /brand-files/ path (validated at the setPlatformSetting
  // choke point). NOT workspace-seeded (group 'branding' is outside
  // WORKSPACE_SEED_KEYS) — platform surfaces only; client sites keep
  // their own branding.
  { key: 'branding.logo_dark', group: 'branding', label: 'Logo for dark screens', default: '' },
  { key: 'branding.logo_light', group: 'branding', label: 'Logo for light screens', default: '' },
  { key: 'branding.tagline', group: 'branding', label: 'Tagline', default: 'Local business desk' },
];

const WORKSPACE_SEED_KEYS = PLATFORM_SETTING_DEFS.filter(
  (d) =>
    ['email', 'sms', 'keys', 'general'].includes(d.group) ||
    d.key.startsWith('cost.') ||
    d.key.startsWith('mail.') ||
    d.key.startsWith('smtp.') ||
    d.key.startsWith('sms.') ||
    d.key.startsWith('ai.') ||
    d.key.startsWith('muse.model_') ||
    d.key.startsWith('providers.') ||
    d.key === 'pexels.api_key' ||
    d.key === 'fal.api_key'
)
  .map((d) => d.key)
  // Don't push registration/maintenance or shared CF secrets into workspace sqlite
  .filter(
    (k) =>
      ![
        'registration.open',
        'maintenance_mode',
        'support.email',
        // Batch 56: the app's public URL is platform identity, never a
        // per-workspace value (same treatment as support.email).
        'general.public_url',
        'default.workspace_name',
        'cf.api_token',
        'cf.account_id',
        'cf.preview_domain',
        'cf.project',
        'google.places_api_key',
      ].includes(k)
  );

async function ensurePlatformTables() {
  // no-op: migrate creates tables; kept for callers
}

function isPlatformSecret(key) {
  const def = PLATFORM_SETTING_DEFS.find((d) => d.key === key);
  return PLATFORM_SECRET_KEYS.includes(key) || !!(def && def.secret);
}

async function getPlatformSetting(key, fallback = '') {
  const rows = await query('SELECT value FROM platform_settings WHERE `key` = :key LIMIT 1', { key });
  if (rows && rows[0]) return isPlatformSecret(key) ? secretBox.decryptValue(rows[0].value) : rows[0].value;
  const def = PLATFORM_SETTING_DEFS.find((d) => d.key === key);
  return def ? def.default : fallback;
}

/**
 * Batch 56: general.public_url is validated + normalized at save time so
 * EVERY write path (admin batch save, single save, MCP/IPC facades) enforces
 * the same rule — the resolver (stripeClient.appUrl) builds customer-facing
 * links from this value, so an empty or malformed value must never land.
 * Rule: a valid https URL at the site root (no path, query or fragment);
 * trailing slashes are normalized away. Returns the canonical value
 * (URL origin) or throws a coded VALIDATION error with a plain message.
 */
function validatePublicUrlSetting(value) {
  const v = String(value == null ? '' : value).trim().replace(/\/+$/, '');
  const bad = (msg) => {
    const e = new Error(msg);
    e.code = 'VALIDATION';
    return e;
  };
  if (!v) {
    throw bad('Public URL is required — links in emails and pages are built from this address.');
  }
  let u;
  try {
    u = new URL(v);
  } catch {
    throw bad('Public URL must be a valid https address, like https://example.com — with no path after the domain.');
  }
  if (
    u.protocol !== 'https:' ||
    (u.pathname !== '' && u.pathname !== '/') ||
    u.search ||
    u.hash ||
    u.username ||
    u.password
  ) {
    throw bad('Public URL must be a valid https address, like https://example.com — with no path after the domain.');
  }
  return u.origin;
}

async function setPlatformSetting(key, value) {
  const def = PLATFORM_SETTING_DEFS.find((d) => d.key === key);
  if (!def) {
    const e = new Error(`Unknown platform setting: ${key}`);
    e.code = 'UNKNOWN_SETTING';
    throw e;
  }
  let v = value == null ? '' : String(value);
  // Batch 56: validate + normalize the public URL here, at the single write
  // choke point every save path funnels through.
  if (key === 'general.public_url') v = validatePublicUrlSetting(v);
  // Batch 57: same treatment for the plan-contents overrides — validate +
  // canonicalize the JSON here so no write path (admin API, generic
  // settings save, MCP/IPC facade) can land a malformed override row.
  // Lazy require: planContents requires this module at load time.
  if (key.startsWith('plans.contents_')) {
    const planId = key.slice('plans.contents_'.length);
    const normalized = require('./planContents').validatePlanContents(planId, v);
    v = normalized ? JSON.stringify(normalized) : '';
  }
  // Batch 58: landing videos canonicalize here too — whatever was pasted
  // (embed code, link, ID), only YouTube video IDs are ever stored.
  if (key === 'landing.video_embeds') {
    v = require('./landingVideos').validateLandingVideoEmbedsSetting(v);
  }
  // Batch 70: same choke-point treatment for the /thankyou settings —
  // the demo video stores a canonical YouTube ID only, and the booking
  // link must be an https calendly.com URL; anything else is a coded
  // rejection no write path can land.
  if (key === 'landing.thankyou_video') {
    v = require('./landingThankYou').validateThankYouVideoSetting(v);
  }
  if (key === 'landing.thankyou_calendly_url') {
    v = require('./landingThankYou').validateThankYouCalendlyUrl(v);
  }
  // Batch 59: Hostinger defaults are API identifiers, not free text —
  // reject anything that cannot be a catalog price id / numeric id at
  // this choke point too, so no write path can land a malformed default
  // that a later deploy would send to the Hostinger API.
  if (key === 'hostinger.default_price_id' && v !== '' && !/^[A-Za-z0-9._-]{1,120}$/.test(v)) {
    const e = new Error('hostinger.default_price_id must be a Hostinger catalog price ID (letters, digits, dot, dash, underscore)');
    e.code = 'VALIDATION';
    throw e;
  }
  if (
    (key === 'hostinger.data_center_id' || key === 'hostinger.template_id') &&
    v !== '' &&
    !/^\d{1,10}$/.test(v)
  ) {
    const e = new Error(`${key} must be a numeric Hostinger ID (digits only) or blank`);
    e.code = 'VALIDATION';
    throw e;
  }
  // Batch 87: branding values are constrained at the same choke point —
  // logo slots may only hold '' (the built-in default asset) or a
  // /brand-files/ path minted by server/branding.js's upload path, and
  // the tagline is a single short line (blank = the default text).
  if (key === 'branding.logo_dark' || key === 'branding.logo_light') {
    const variant = key === 'branding.logo_dark' ? 'dark' : 'light';
    if (v !== '' && !new RegExp(`^/brand-files/logo-${variant}-\\d+-[a-z0-9]{6}\\.(png|jpg|svg|webp)$`).test(v)) {
      const e = new Error(`${key} must be blank (built-in logo) or a logo uploaded in Admin → Settings → Branding`);
      e.code = 'VALIDATION';
      throw e;
    }
  }
  if (key === 'branding.tagline') {
    v = v.trim();
    if (v.length > 120 || /[\r\n]/.test(v)) {
      const e = new Error('branding.tagline must be a single line of at most 120 characters (blank = the default tagline)');
      e.code = 'VALIDATION';
      throw e;
    }
  }
  await query(
    `INSERT INTO platform_settings (\`key\`, value)
     VALUES (:key, :value)
     ON DUPLICATE KEY UPDATE value = VALUES(value)`,
    { key, value: isPlatformSecret(key) ? secretBox.encryptValue(v) : v }
  );
  if (key === 'general.public_url') {
    // Keep the sync resolver cache (stripeClient.appUrl) in step with the
    // save — lazy require: stripeClient requires this module at load time.
    try {
      require('./stripeClient').setPublicUrlCache(v);
    } catch {
      /* resolver falls back to env/default until the next boot refresh */
    }
  }
  if (key.startsWith('plans.contents_')) {
    // Batch 57: keep the sync plan-contents resolver (server/plans.js)
    // in step with the save — lazy require: planContents requires this
    // module at load time.
    try {
      require('./planContents').setContentsCacheForKey(key, v);
    } catch {
      /* resolver keeps the boot-primed overrides until the next boot */
    }
  }
  if (key.startsWith('branding.')) {
    // Batch 87: keep the sync branding cache (logos + tagline) in step
    // with the save — fire-and-forget refresh; the cache module reads
    // through this one, never the reverse at load time.
    try {
      require('./branding').refreshBranding().catch(() => {});
    } catch {
      /* cache keeps the boot-primed values until the next refresh */
    }
  }
  return { key, set: true };
}

/**
 * Stored row only — NO def-default fallback. The public-URL resolver needs
 * to distinguish "an admin saved a value" from "nothing stored" so its
 * resolution order can be stored → APP_URL env → def default.
 */
async function getStoredPlatformSetting(key) {
  const rows = await query('SELECT value FROM platform_settings WHERE `key` = :key LIMIT 1', { key });
  if (rows && rows[0]) return isPlatformSecret(key) ? secretBox.decryptValue(rows[0].value) : rows[0].value;
  return '';
}

async function seedPlatformDefaults() {
  const fileDefaults = loadPlatformDefaultsFile();
  for (const def of PLATFORM_SETTING_DEFS) {
    const fromFile = fileDefaults[def.key];
    const value = fromFile != null && String(fromFile) !== '' ? String(fromFile) : def.default;
    await query('INSERT IGNORE INTO platform_settings (`key`, value) VALUES (:key, :value)', { key: def.key, value });
  }
}

/**
 * Persist current platform_settings into data/platform-defaults.json.
 * Batch 102 (SEC-03): secret keys are written as EMPTY markers, never
 * values — the previous version persisted every platform secret in
 * plaintext (mode 644) and the file rode along in backup tars,
 * defeating encryption at rest (Audit 1 Q3 #6). Empty is the safe
 * marker here: seedPlatformDefaults treats '' as "absent" and falls
 * back to the def default, so a restore never seeds a fake secret.
 * The file is written mode 600 (and chmodded, since writeFileSync's
 * mode only applies at creation).
 */
async function savePlatformDefaultsSnapshot() {
  const all = await getAllPlatformSettings({ redact: false });
  const out = {};
  for (const def of PLATFORM_SETTING_DEFS) {
    out[def.key] = isPlatformSecret(def.key) ? '' : all[def.key] != null ? String(all[def.key]) : def.default;
  }
  const p = platformDefaultsPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(out, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(p, 0o600);
  } catch {
    /* best effort — content is already secret-free */
  }
  return { path: p, keys: Object.keys(out).length };
}

async function getAllPlatformSettings({ redact = true } = {}) {
  const rows = await query('SELECT `key`, value FROM platform_settings');
  const map = {};
  for (const def of PLATFORM_SETTING_DEFS) map[def.key] = def.default;
  for (const r of rows || [])
    map[r.key] = !redact && isPlatformSecret(r.key) ? secretBox.decryptValue(r.value) : r.value;
  if (redact) {
    for (const k of PLATFORM_SECRET_KEYS) {
      if (map[k]) map[k] = '***';
    }
  }
  return map;
}

async function setPlatformSettingsBatch(entries, { secretsOnly = false } = {}) {
  const out = [];
  for (const [key, value] of Object.entries(entries || {})) {
    const def = PLATFORM_SETTING_DEFS.find((d) => d.key === key);
    if (!def) continue;
    if (secretsOnly && !def.secret && !PLATFORM_SECRET_KEYS.includes(key)) continue;
    if (PLATFORM_SECRET_KEYS.includes(key) || def.secret) {
      if (value === '***' || value === '' || value == null) continue;
    }
    await setPlatformSetting(key, value);
    out.push(key);
  }
  return { updated: out };
}

/**
 * Lazy migration (port of audit M6): encrypt any platform secrets still
 * stored as plaintext. Runs at boot when an encryption key is
 * configured; idempotent (enc:v1: values are skipped).
 */
async function migratePlatformSecrets() {
  if (!secretBox.hasKey()) return { migrated: 0 };
  const rows = await query('SELECT `key`, value FROM platform_settings');
  let migrated = 0;
  for (const r of rows || []) {
    if (isPlatformSecret(r.key) && r.value && !secretBox.isEncrypted(r.value)) {
      await setPlatformSetting(r.key, r.value);
      migrated++;
    }
  }
  return { migrated };
}

async function audit(actorUserId, action, detail) {
  try {
    await query(
      `INSERT INTO platform_audit (actor_user_id, action, detail)
       VALUES (:actorUserId, :action, :detail)`,
      {
        actorUserId: actorUserId || null,
        action: String(action || '').slice(0, 80),
        detail: detail == null ? '' : String(detail).slice(0, 4000),
      }
    );
  } catch (e) {
    console.warn('[platform.audit]', e.message);
  }
}

async function listAudit({ limit = 50 } = {}) {
  const lim = Math.min(200, Math.max(1, Number(limit) || 50));
  return query(
    `SELECT a.id, a.actor_user_id, a.action, a.detail, a.at, u.email AS actor_email
     FROM platform_audit a
     LEFT JOIN users u ON u.id = a.actor_user_id
     ORDER BY a.id DESC
     LIMIT ${lim}`
  );
}

/** Keys+values from platform that should seed a workspace. */
async function workspaceSeedFromPlatform() {
  const all = await getAllPlatformSettings({ redact: false });
  const out = {};
  for (const key of WORKSPACE_SEED_KEYS) {
    if (all[key] != null && String(all[key]).trim() !== '') out[key] = String(all[key]);
  }
  return out;
}

module.exports = {
  PLATFORM_SECRET_KEYS,
  PLATFORM_SETTING_DEFS,
  WORKSPACE_SEED_KEYS,
  ensurePlatformTables,
  getPlatformSetting,
  getStoredPlatformSetting,
  validatePublicUrlSetting,
  setPlatformSetting,
  seedPlatformDefaults,
  migratePlatformSecrets,
  savePlatformDefaultsSnapshot,
  getAllPlatformSettings,
  setPlatformSettingsBatch,
  audit,
  listAudit,
  workspaceSeedFromPlatform,
};
