'use strict';

const SECRET_KEYS = [
  'ai.api_key',
  'smtp.pass',
  'mail.imap.pass',
  'cf.api_token',
  'pexels.api_key',
  'providers.tavily.api_key',
  'fal.api_key',
  'meta.app_secret',
  'design.agent_webhook_secret',
  'sms.auth_token',
  'sms.api_key',
  'mcp.http_token',
  'shop.stripe.secret_key',
  'shop.stripe.webhook_secret',
];

const SETTING_SEEDS = [
  ['ai.api_key', ''],
  ['ai.base_url', 'https://api.openai.com/v1'],
  ['ai.model.default', 'gpt-4o-mini'],
  ['ai.model.research', ''],
  ['ai.model.generation', ''],
  ['ai.model.scoring', ''],
  ['ai.model.email', ''],
  ['ai.model.qa', ''],
  ['ai.model.editor', ''],
  ['ai.model.followup', ''],
  ['ai.model.image', 'gpt-image-2.5-sunburst'],
  ['ai.model.vision', ''],
  ['cost.daily_budget_usd', '10'],
  ['cost.max_websites_per_day', '25'],
  ['cost.max_outreach_per_day', '200'],
  ['cost.per_1k_prompt', '0.0015'],
  ['cost.per_1k_completion', '0.002'],
  ['automation_paused', '0'],
  ['design.agent_notify', '1'],
  ['design.agent_trigger_command', ''],
  ['design.agent_trigger_file', ''],
  ['design.agent_webhook_url', ''],
  ['design.agent_webhook_secret', ''],
  ['design.learning.enabled', '1'],
  ['providers.tavily.search_depth', 'advanced'],
  ['smtp.host', 'in-v3.mailjet.com'],
  ['smtp.port', '587'],
  ['smtp.secure', '0'],
  ['smtp.user', ''],
  ['smtp.from_name', 'Bitpype'],
  ['smtp.from_email', 'team@bitpype.com'],
  ['mail.footer', 'Reply STOP to opt out of future messages.'],
  ['mail.inbound_drop_dir', ''],
  ['mail.imap.enabled', '1'],
  ['mail.imap.host', ''],
  ['mail.imap.port', '993'],
  ['mail.imap.secure', '1'],
  ['mail.imap.user', ''],
  ['mail.imap.pass', ''],
  ['mail.imap.mailbox', 'INBOX'],
  ['mail.imap.auto_submit', '0'],
  ['score.threshold_qualified', '50'],
  ['score.threshold_hot', '70'],
  ['app.name', 'Bitpype'],
  ['cf.account_id', '2b529c9c689b4e139de72bba42d7148b'],
  ['cf.project', ''],
  ['cf.preview_domain', 'briktapinc.workers.dev'],
  ['meta.app_id', ''],
  ['meta.app_secret', ''],
  ['social.image_price_usd', '1'],
  ['hands_off.enabled', '0'],
  ['hands_off.min_score', '50'],
  ['hands_off.max_sites_per_day', '5'],
  ['hands_off.report_email', ''],
  ['hands_off.followup_days', '3'],
  ['hands_off.template_id', ''],
  ['hands_off.channel', 'both'],
  ['design.learning.playbook', '[]'],
  ['design.learning.last_learned_at', ''],
  ['design.learning.max_playbook', '24'],
  ['discovery.schedule.enabled', '0'],
  ['discovery.schedule.mode', 'interval'],
  ['discovery.schedule.interval_hours', '6'],
  ['discovery.schedule.daily_time', '09:00'],
  ['discovery.schedule.provider', 'tavily'],
  ['discovery.schedule.category', '*'],
  ['discovery.schedule.location', '19510'],
  ['discovery.schedule.limit', '8'],
  ['discovery.schedule.score', '1'],
  ['discovery.schedule.group', ''],
  ['discovery.schedule.website_presence', 'no'],
  ['discovery.schedule.last_run', ''],
  ['discovery.schedule.next_run', ''],
  ['discovery.schedule.last_status', ''],
  ['discovery.schedule.last_error', ''],
  ['discovery.schedule.last_result', ''],
  ['smtp.pass', ''],
  ['sms.enabled', '0'],
  ['sms.provider', 'twilio'],
  ['sms.account_sid', ''],
  ['sms.auth_token', ''],
  ['sms.api_key', ''],
  ['sms.from_number', ''],
  ['sms.webhook_url', ''],
  ['cf.api_token', ''],
  ['mcp.public_url', ''],
  ['mcp.http_port', ''],
  ['shop.stripe.publishable_key', ''],
  ['shop.stripe.secret_key', ''],
  ['shop.stripe.webhook_secret', ''],
];
// Keys writable via the settings API (secrets and automation_paused
// excluded, except design.agent_webhook_secret which is settable
// but masked on read). Canonical list — port of audit D3.
const SETTABLE_KEYS = [
  'ai.base_url',
  'ai.model.default',
  'ai.model.research',
  'ai.model.generation',
  'ai.model.scoring',
  'ai.model.email',
  'ai.model.qa',
  'ai.model.editor',
  'ai.model.followup',
  'ai.model.image',
  'ai.model.vision',
  'cost.daily_budget_usd',
  'cost.per_1k_prompt',
  'cost.per_1k_completion',
  'cost.max_websites_per_day',
  'cost.max_outreach_per_day',
  'smtp.host',
  'smtp.port',
  'smtp.secure',
  'smtp.user',
  'smtp.from_name',
  'smtp.from_email',
  'mail.footer',
  'mail.inbound_drop_dir',
  'mail.imap.enabled',
  'mail.imap.host',
  'mail.imap.port',
  'mail.imap.secure',
  'mail.imap.user',
  'mail.imap.mailbox',
  'mail.imap.auto_submit',
  'score.threshold_qualified',
  'score.threshold_hot',
  'app.name',
  'shop.stripe.publishable_key',
  'shop.stripe.secret_key',
  'shop.stripe.webhook_secret',
  'cf.account_id',
  'cf.project',
  'cf.preview_domain',
  'mcp.public_url',
  'mcp.http_port',
  'providers.tavily.search_depth',
  'design.agent_notify',
  'design.agent_trigger_command',
  'design.agent_trigger_file',
  'design.agent_webhook_url',
  'design.agent_webhook_secret',
  'design.learning.enabled',
  'design.learning.max_playbook',
  'meta.app_id',
  'social.image_price_usd',
  'sms.enabled',
  'sms.provider',
  'sms.account_sid',
  'sms.from_number',
  'sms.webhook_url',
  'hands_off.enabled',
  'hands_off.min_score',
  'hands_off.max_sites_per_day',
  'hands_off.report_email',
  'hands_off.followup_days',
  'hands_off.template_id',
  'hands_off.channel',
];

const PROMPT_SEEDS = [
  {
    key: 'research_lead',
    name: 'Research Lead',
    body: 'Research the local business and return structured JSON facts. Never invent phone/address/hours.',
  },
  {
    key: 'score_lead',
    name: 'Score Lead',
    body: 'Score the lead 0–100 with a short breakdown of signals.',
  },
  {
    key: 'write_outreach',
    name: 'Write Outreach',
    body: 'Write a short personal outreach email. Respect opt-out language.',
  },
  {
    key: 'build_website',
    name: 'Build Website',
    body: 'Design a clean static website JSON: name, theme, pages with html.',
  },
];

// --- Setting validation (moved from src/ipc/system.js; canonical here) ---
// Returns {ok:true, value} with a normalized string, or {ok:false, error}.
function isNum(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return true;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return true;
  return false;
}
function toNum(v) {
  return Number(v);
}
function toInt(v) {
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}
function isHttpUrl(v) {
  if (typeof v !== 'string' || v.length > 500) return false;
  try {
    const u = new URL(v.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function isEmail(v) {
  return typeof v === 'string' && v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
}

// Returns {ok:true, value} with a normalized string, or {ok:false, error}.
function validateSetting(key, raw) {
  const value = raw == null ? '' : String(raw);
  if (!SETTABLE_KEYS.includes(key)) {
    return { ok: false, error: `Setting "${key}" is not writable via settings:set.` };
  }
  const fail = (why) => ({ ok: false, error: `Invalid value for ${key}: ${why}` });
  switch (key) {
    case 'ai.base_url':
      if (!isHttpUrl(value)) return fail('must be an http(s) URL');
      return { ok: true, value: value.trim() };
    case 'ai.model.default':
    case 'ai.model.research':
    case 'ai.model.generation':
    case 'ai.model.scoring':
    case 'ai.model.email':
    case 'ai.model.qa':
    case 'ai.model.editor':
    case 'ai.model.followup':
    case 'ai.model.image':
    case 'ai.model.vision':
      if (value.length > 200) return fail('must be 200 chars or fewer');
      if (key === 'ai.model.default' && value.trim() === '') return fail('default model may not be empty');
      return { ok: true, value: value.trim() };
    case 'cost.daily_budget_usd':
      if (!isNum(value)) return fail('must be a number');
      if (toNum(value) < 0 || toNum(value) > 100000) return fail('must be between 0 and 100000');
      return { ok: true, value: String(toNum(value)) };
    case 'cost.per_1k_prompt':
    case 'cost.per_1k_completion':
      if (!isNum(value)) return fail('must be a number');
      if (toNum(value) < 0 || toNum(value) > 100) return fail('must be between 0 and 100');
      return { ok: true, value: String(toNum(value)) };
    case 'cost.max_websites_per_day': {
      const n = toInt(value);
      if (n === null || n < 0 || n > 100000) return fail('must be an integer between 0 and 100000');
      return { ok: true, value: String(n) };
    }
    case 'cost.max_outreach_per_day': {
      const n = toInt(value);
      if (n === null || n < 0 || n > 1000000) return fail('must be an integer between 0 and 1000000');
      return { ok: true, value: String(n) };
    }
    case 'smtp.host':
      if (value.length > 255) return fail('must be 255 chars or fewer');
      if (value && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value.trim())) return fail('not a valid hostname');
      return { ok: true, value: value.trim() };
    case 'smtp.port': {
      const n = toInt(value);
      if (n === null || n < 1 || n > 65535) return fail('must be an integer port 1-65535');
      return { ok: true, value: String(n) };
    }
    case 'smtp.secure': {
      const v = String(value).trim().toLowerCase();
      if (['1', 'true', 'yes'].includes(v)) return { ok: true, value: '1' };
      if (['0', 'false', 'no', ''].includes(v)) return { ok: true, value: '0' };
      return fail('must be boolean-like (0/1)');
    }
    case 'smtp.user':
    case 'smtp.from_name':
      if (value.length > 255) return fail('must be 255 chars or fewer');
      return { ok: true, value: value.trim() };
    case 'smtp.from_email':
      if (value.trim() !== '' && !isEmail(value)) return fail('must be a valid email address or empty');
      return { ok: true, value: value.trim() };
    case 'mail.footer':
      if (value.length > 5000) return fail('must be 5000 chars or fewer');
      return { ok: true, value };
    case 'mail.inbound_drop_dir':
      if (value.length > 500) return fail('must be 500 chars or fewer');
      return { ok: true, value: value.trim() };
    case 'mail.imap.enabled':
    case 'mail.imap.secure':
    case 'mail.imap.auto_submit': {
      const v = String(value).trim().toLowerCase();
      if (['1', 'true', 'yes'].includes(v)) return { ok: true, value: '1' };
      if (['0', 'false', 'no', ''].includes(v)) return { ok: true, value: '0' };
      return fail('must be boolean-like (0/1)');
    }
    case 'mail.imap.host':
      if (value.length > 255) return fail('must be 255 chars or fewer');
      if (value && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value.trim())) return fail('not a valid hostname');
      return { ok: true, value: value.trim() };
    case 'mail.imap.port': {
      const n = toInt(value);
      if (n === null || n < 1 || n > 65535) return fail('must be an integer port 1-65535');
      return { ok: true, value: String(n) };
    }
    case 'mail.imap.user':
    case 'mail.imap.mailbox':
      if (value.length > 255) return fail('must be 255 chars or fewer');
      return { ok: true, value: value.trim() };
    case 'score.threshold_qualified':
    case 'score.threshold_hot': {
      const n = toInt(value);
      if (n === null || n < 0 || n > 100) return fail('must be an integer 0-100');
      return { ok: true, value: String(n) };
    }
    case 'app.name':
      if (value.length > 100) return fail('must be 100 chars or fewer');
      return { ok: true, value: value.trim() || 'Bitpype' };
    case 'cf.account_id':
      if (value.trim() !== '' && !/^[0-9a-fA-F]{32}$/.test(value.trim())) {
        return fail('must be a 32-character hex account ID or empty');
      }
      return { ok: true, value: value.trim() };
    case 'cf.project':
      if (value.trim() !== '' && !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(value.trim())) {
        return fail('must be lowercase letters, numbers, hyphens (max 63 chars) or empty');
      }
      return { ok: true, value: value.trim() };
    case 'cf.preview_domain':
      if (value.length > 253) return fail('must be 253 chars or fewer');
      if (value.trim() !== '' && !/^[a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9]$/.test(value.trim())) {
        return fail('must be a valid domain name or empty');
      }
      return { ok: true, value: value.trim() };
    case 'mcp.public_url': {
      const n = require('../mcpRemote').normalizePublicUrl(value);
      if (!n.ok) return fail(n.error);
      return { ok: true, value: n.value };
    }
    case 'mcp.http_port': {
      const n = toInt(value);
      if (n === null || n < 1 || n > 65535) return fail('must be an integer port 1-65535');
      return { ok: true, value: String(n) };
    }
    case 'providers.tavily.search_depth': {
      const v = value.trim().toLowerCase();
      if (v === 'basic' || v === 'advanced') return { ok: true, value: v };
      return fail('must be "basic" or "advanced"');
    }
    case 'design.agent_notify': {
      const v = String(value).trim().toLowerCase();
      if (['1', 'true', 'yes'].includes(v)) return { ok: true, value: '1' };
      if (['0', 'false', 'no', ''].includes(v)) return { ok: true, value: '0' };
      return fail('must be boolean-like (0/1)');
    }
    case 'design.agent_trigger_command':
      if (value.length > 2000) return fail('must be 2000 chars or fewer');
      if (value.includes('\0')) return fail('must not contain null bytes');
      return { ok: true, value };
    case 'design.agent_trigger_file':
      if (value.length > 500) return fail('must be 500 chars or fewer');
      if (value.includes('\0')) return fail('must not contain null bytes');
      return { ok: true, value: value.trim() };
    case 'design.agent_webhook_url': {
      const v = value.trim();
      if (v === '') return { ok: true, value: '' };
      if (!isHttpUrl(v)) return fail('must be an http(s) URL or empty');
      return { ok: true, value: v };
    }
    case 'design.agent_webhook_secret':
      if (value.length > 500) return fail('must be 500 chars or fewer');
      if (value.includes('\0')) return fail('must not contain null bytes');
      return { ok: true, value: value.trim() };
    case 'design.learning.enabled': {
      const v = String(value).trim().toLowerCase();
      if (['1', 'true', 'yes'].includes(v)) return { ok: true, value: '1' };
      if (['0', 'false', 'no', ''].includes(v)) return { ok: true, value: '0' };
      return fail('must be boolean-like (0/1)');
    }
    case 'design.learning.max_playbook': {
      const n = toInt(value);
      if (n === null || n < 4 || n > 60) return fail('must be an integer between 4 and 60');
      return { ok: true, value: String(n) };
    }
    case 'meta.app_id':
      if (value.length > 64) return fail('must be 64 chars or fewer');
      if (value.trim() !== '' && !/^\d+$/.test(value.trim())) return fail('must be a numeric Meta App ID or empty');
      return { ok: true, value: value.trim() };
    case 'hands_off.enabled': {
      const v = String(value).trim().toLowerCase();
      if (['1', 'true', 'yes'].includes(v)) return { ok: true, value: '1' };
      if (['0', 'false', 'no', ''].includes(v)) return { ok: true, value: '0' };
      return fail('must be boolean-like (0/1)');
    }
    case 'hands_off.min_score': {
      const n = toInt(value);
      if (n === null || n < 0 || n > 100) return fail('must be an integer 0-100');
      return { ok: true, value: String(n) };
    }
    case 'hands_off.max_sites_per_day': {
      const n = toInt(value);
      if (n === null || n < 0 || n > 1000) return fail('must be an integer between 0 and 1000');
      return { ok: true, value: String(n) };
    }
    case 'hands_off.report_email':
      if (value.trim() !== '' && !isEmail(value)) return fail('must be a valid email address or empty');
      return { ok: true, value: value.trim() };
    case 'hands_off.followup_days': {
      const n = toInt(value);
      if (n === null || n < 1 || n > 90) return fail('must be an integer between 1 and 90');
      return { ok: true, value: String(n) };
    }
    case 'hands_off.template_id': {
      if (value.trim() === '') return { ok: true, value: '' };
      const n = toInt(value);
      if (n === null || n < 1) return fail('must be a positive integer or empty');
      return { ok: true, value: String(n) };
    }
    case 'hands_off.channel': {
      const v = String(value).trim().toLowerCase();
      if (['email', 'sms', 'both', ''].includes(v)) return { ok: true, value: v || 'both' };
      return fail('must be email, sms, or both');
    }
    case 'shop.stripe.publishable_key': {
      const v = value.trim();
      if (v && !/^pk_(test|live)_/.test(v)) return fail('must be a Stripe publishable key (pk_test_… or pk_live_…)');
      if (v.length > 255) return fail('must be 255 chars or fewer');
      return { ok: true, value: v };
    }
    case 'shop.stripe.secret_key': {
      const v = value.trim();
      if (v && !/^(sk|rk)_(test|live)_/.test(v))
        return fail('must be a Stripe secret or restricted key (sk_… or rk_…)');
      if (v.length > 255) return fail('must be 255 chars or fewer');
      return { ok: true, value: v };
    }
    case 'shop.stripe.webhook_secret': {
      const v = value.trim();
      if (v && !/^whsec_/.test(v)) return fail('must be a Stripe webhook signing secret (whsec_…)');
      if (v.length > 255) return fail('must be 255 chars or fewer');
      return { ok: true, value: v };
    }
    default:
      return { ok: false, error: `No validator for setting "${key}".` };
  }
}

module.exports = { SECRET_KEYS, SETTING_SEEDS, SETTABLE_KEYS, PROMPT_SEEDS, validateSetting };
