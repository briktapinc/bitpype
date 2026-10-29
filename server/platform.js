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
];

/** Catalog of platform settings shown in the admin UI. */
const PLATFORM_SETTING_DEFS = [
  // General
  { key: 'app.name', group: 'general', label: 'App name', default: 'Bitpype' },
  { key: 'support.email', group: 'general', label: 'Support email', default: '' },
  {
    key: 'registration.open',
    group: 'general',
    label: 'Open registration — Register tab & sign-ups (bitpype.com)',
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
  { key: 'smtp.from_email', group: 'email', label: 'From email', default: 'team@bitpype.com' },
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

async function setPlatformSetting(key, value) {
  const def = PLATFORM_SETTING_DEFS.find((d) => d.key === key);
  if (!def) {
    const e = new Error(`Unknown platform setting: ${key}`);
    e.code = 'UNKNOWN_SETTING';
    throw e;
  }
  const v = value == null ? '' : String(value);
  await query(
    `INSERT INTO platform_settings (\`key\`, value)
     VALUES (:key, :value)
     ON DUPLICATE KEY UPDATE value = VALUES(value)`,
    { key, value: isPlatformSecret(key) ? secretBox.encryptValue(v) : v }
  );
  return { key, set: true };
}

async function seedPlatformDefaults() {
  const fileDefaults = loadPlatformDefaultsFile();
  for (const def of PLATFORM_SETTING_DEFS) {
    const fromFile = fileDefaults[def.key];
    const value = fromFile != null && String(fromFile) !== '' ? String(fromFile) : def.default;
    await query('INSERT IGNORE INTO platform_settings (`key`, value) VALUES (:key, :value)', { key: def.key, value });
  }
}

/** Persist current platform_settings into data/platform-defaults.json (secrets included). */
async function savePlatformDefaultsSnapshot() {
  const all = await getAllPlatformSettings({ redact: false });
  const out = {};
  for (const def of PLATFORM_SETTING_DEFS) {
    out[def.key] = all[def.key] != null ? String(all[def.key]) : def.default;
  }
  const p = platformDefaultsPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(out, null, 2));
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
