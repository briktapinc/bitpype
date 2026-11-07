'use strict';

/**
 * Batch 155 — SINGLE-SITE MODE (Standalone Site Backup, clone model).
 *
 * A boot-time mode of the real app, switched by ONE env flag read in
 * this module and nowhere else:
 *
 *     BITPYPE_SINGLE_SITE=1
 *
 * A standalone backup package (server/standaloneBackup.js) carries this
 * codebase seeded with exactly ONE workspace; the installer starts it
 * with the flag on so the client gets their site + their portal back
 * on their own server, with zero connection back to BitPype.
 *
 * When the flag is ON, server.js does not mount the staff/platform
 * surface at all (the routes are ABSENT — they answer 404, they are
 * not hidden behind a check):
 *   - staff sign-in + registration + workspace creation
 *     (/api/v1/auth/*, incl. POST /api/v1/auth/workspace)
 *   - the staff REST API (/api/v1 catch-all), /api/v1/admin,
 *     /api/v1/jobs, /api/v1/mcp (admin), /mcp + /ws, MCP OAuth
 *     (/authorize, /oauth, /token, /register)
 *   - platform billing (/api/v1/billing + its Stripe webhook),
 *     invites, GBP manager, partner/Solo/deployer surfaces,
 *     BitPype marketing lead forms (/landing, /website-promo,
 *     /creator), staff outreach + mailing-list endpoints
 *   - the staff SPA (/app) and the BitPype marketing pages
 *   - background platform tickers + the job scheduler (design queue /
 *     hands-off processing has no staff to serve on a clone)
 *
 * What keeps working is the client's own world, unchanged: the public
 * site surface (modules/forms/chat public APIs + webhooks for the
 * site's own Stripe), the client portal, and the baked site itself
 * (served at / when SINGLE_SITE_SITE_DIR points at it).
 *
 * When the flag is OFF (the default) nothing in this module is
 * consulted beyond the boolean, and behaviour is byte-for-byte the
 * platform's.
 *
 * CONFIG COLLAPSE — platform-level settings on a clone are owned by
 * the installer's .env (there is no staff admin to edit them), so
 * applyBootDefaults() re-applies the SSB_* env values at every boot:
 *   SSB_OPENAI_KEY            → platform ai.api_key (AI routing's
 *                               OpenAI provider resolves from it)
 *   SSB_GOOGLE_PLACES_KEY     → platform google.places_api_key
 *   SSB_TURNSTILE_SITE_KEY / SSB_TURNSTILE_SECRET → captcha keys;
 *                               absent keys → CAPTCHA_OPTIONAL=1 for
 *                               this process (forms stay rate-limited;
 *                               the clone never pretends Turnstile is
 *                               enforcing when no keys exist)
 *   SSB_SMTP_HOST/PORT/SECURE/USER/PASS/FROM_EMAIL → smtp.* settings
 *                               + mail.provider 'custom'
 *   SSB_TWILIO_ACCOUNT_SID / SSB_TWILIO_AUTH_TOKEN / SSB_TWILIO_FROM_NUMBER
 *                             → sms.* settings (call tracking still
 *                               needs a provisioned number per site;
 *                               without owner credentials the module
 *                               reports unavailable, as it does for any
 *                               unconfigured workspace)
 * Tenant-level money config is different: the portal owns it (Shop →
 * Payments), so the wizard's Stripe keys are only a BOOTSTRAP —
 * written through paymentsConfig.saveCredentials when the seeded
 * lead has no working config yet, never over a portal-saved one.
 */

const fs = require('fs');
const path = require('path');

const SINGLE_SITE = String(process.env.BITPYPE_SINGLE_SITE || '').trim() === '1';

function isSingleSite() {
  return SINGLE_SITE;
}

/* API prefixes never mounted in single-site mode. The suite's route
 * census boots a clone and probes every entry (plus the staff pages)
 * for a 404, and boots the platform to prove the same paths are NOT
 * 404 with the mode off. */
const DISABLED_API_PREFIXES = [
  '/api/v1/auth',
  '/api/v1/admin',
  '/api/v1/billing',
  '/api/v1/invites',
  '/api/v1/gbp',
  '/api/v1/social',
  '/api/v1/design/public',
  '/api/v1/outreach/public',
  '/api/v1/website-promo',
  '/api/v1/landing',
  '/api/v1/creator',
  '/api/v1/partner',
  '/api/v1/partners',
  '/api/v1/mailing-list',
  '/api/v1/hostinger-deploy',
  '/api/v1/jobs',
  '/api/v1/mcp',
  '/mcp',
  '/ws',
  '/authorize',
  '/oauth',
];

/* Staff + platform-marketing pages that answer 404 in single-site
 * mode (enforced by disabledPageGate, mounted in server.js before
 * the page senders). '/' is deliberately absent: the root belongs to
 * the baked site. '/portal' is the client's own surface and stays. */
const DISABLED_PAGES = [
  '/app',
  '/index.html',
  '/how',
  '/how-it-works',
  '/landing',
  '/creator',
  '/partner',
  '/work-with-us',
  '/thankyou',
  '/onboarding',
  '/website-promo',
  '/solo',
  '/sms-policy',
  '/home.html',
  '/how.html',
  '/how-it-works.html',
  '/landing.html',
  '/creator.html',
  '/partner.html',
  '/work-with-us.html',
  '/thankyou.html',
  '/onboarding.html',
  '/website-promo.html',
  '/solo.html',
  '/sms-policy.html',
];

function disabledPageGate(req, res, next) {
  if (!SINGLE_SITE) return next();
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const p = req.path || '';
  if (p.startsWith('/legal/')) return res.status(404).end();
  if (DISABLED_PAGES.includes(p)) return res.status(404).end();
  return next();
}

/* The baked-site directory the clone serves at / (the installer sets
 * SINGLE_SITE_SITE_DIR to the package's site/ folder). Null when
 * unset or missing — the app then simply has no root site, exactly
 * like a platform boot before any preview exists. */
function siteDir() {
  if (!SINGLE_SITE) return null;
  const raw = String(process.env.SINGLE_SITE_SITE_DIR || '').trim();
  if (!raw) return null;
  const resolved = path.resolve(raw);
  try {
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) return resolved;
  } catch {
    /* fall through */
  }
  return null;
}

/* Static-asset gate for the platform's public/ dir in single-site
 * mode: the portal shell, its scripts, the embed pages/scripts the
 * site itself loads, and shared styles stay reachable; the staff
 * SPA and every platform page stay absent. Non-matching paths fall
 * through (later mounts — the baked site, previews — may still
 * serve them; anything left reaches the 404 end of the stack). */
const PUBLIC_JS_ALLOW = new Set([
  'portal.js',
  'errorCopy.js',
  'fonts.js',
  'captcha.js',
  'moduleIcons.js',
  'form-embed.js',
  'module-embed.js',
  'chat-embed.js',
  'cookie-bar.js',
  'site-analytics.js',
  'claim-preview.js',
  'preview-bridge.js',
  'layout-bridge.js',
  'navGroups.js',
]);
const PUBLIC_HTML_ALLOW = new Set(['portal.html', 'member-reset.html']);

function isPublicAssetAllowed(p) {
  const s = String(p || '');
  if (s.startsWith('/embed/') || s.startsWith('/css/')) return true;
  if (s === '/styles.css') return true;
  if (s.startsWith('/js/')) return PUBLIC_JS_ALLOW.has(s.slice(4).split('?')[0]);
  if (s.startsWith('/')) return PUBLIC_HTML_ALLOW.has(s.slice(1));
  return false;
}

/* server.js wraps express.static(public) with isPublicAssetAllowed
 * in single-site mode: allowed paths are served from public/, the
 * rest never reach the static handler at all. */

/* ------------------------------------------------------------------ */
/* Boot-time config collapse. Never throws: a clone must boot even    */
/* when an owner key is wrong — the affected feature reports itself   */
/* unconfigured, exactly as an unconfigured workspace does today.     */
/* ------------------------------------------------------------------ */

function envVal(name) {
  return String(process.env[name] || '').trim();
}

async function applyBootDefaults() {
  if (!SINGLE_SITE) return { applied: false };
  const log = [];
  const platform = require('./platform');

  try {
    const appUrl = envVal('APP_URL');
    if (appUrl) {
      await platform.setPlatformSetting('general.public_url', appUrl.replace(/\/+$/, ''));
      log.push('general.public_url ← APP_URL');
    }
  } catch (e) {
    console.warn('[single-site] public_url not applied:', e.message);
  }

  try {
    const aiKey = envVal('SSB_OPENAI_KEY');
    if (aiKey) {
      await platform.setPlatformSetting('ai.api_key', aiKey);
      log.push('ai.api_key ← SSB_OPENAI_KEY');
    }
  } catch (e) {
    console.warn('[single-site] ai key not applied:', e.message);
  }

  try {
    const places = envVal('SSB_GOOGLE_PLACES_KEY');
    if (places) {
      await platform.setPlatformSetting('google.places_api_key', places);
      log.push('google.places_api_key ← SSB_GOOGLE_PLACES_KEY');
    } else {
      log.push('google reviews: no owner Places key (module reports unavailable)');
    }
  } catch (e) {
    console.warn('[single-site] places key not applied:', e.message);
  }

  try {
    const siteKey = envVal('SSB_TURNSTILE_SITE_KEY');
    const secretKey = envVal('SSB_TURNSTILE_SECRET');
    if (siteKey && secretKey) {
      await platform.setPlatformSetting('captcha.site_key', siteKey);
      await platform.setPlatformSetting('captcha.secret_key', secretKey);
      log.push('captcha keys ← SSB_TURNSTILE_*');
    } else {
      const have = String((await platform.getPlatformSetting('captcha.site_key', '')) || '').trim();
      if (!have) {
        process.env.CAPTCHA_OPTIONAL = '1';
        log.push('captcha: no Turnstile keys — CAPTCHA_OPTIONAL for this process (rate limits still apply)');
      }
    }
  } catch (e) {
    console.warn('[single-site] captcha handling failed:', e.message);
  }

  try {
    const host = envVal('SSB_SMTP_HOST');
    if (host) {
      await platform.setPlatformSetting('mail.provider', 'custom');
      await platform.setPlatformSetting('smtp.host', host);
      await platform.setPlatformSetting('smtp.port', envVal('SSB_SMTP_PORT') || '587');
      await platform.setPlatformSetting('smtp.secure', envVal('SSB_SMTP_SECURE') === '1' ? '1' : '0');
      if (envVal('SSB_SMTP_USER')) await platform.setPlatformSetting('smtp.user', envVal('SSB_SMTP_USER'));
      if (envVal('SSB_SMTP_PASS')) await platform.setPlatformSetting('smtp.pass', envVal('SSB_SMTP_PASS'));
      if (envVal('SSB_SMTP_FROM_EMAIL'))
        await platform.setPlatformSetting('smtp.from_email', envVal('SSB_SMTP_FROM_EMAIL'));
      if (envVal('SSB_SMTP_FROM_NAME'))
        await platform.setPlatformSetting('smtp.from_name', envVal('SSB_SMTP_FROM_NAME'));
      log.push('smtp ← SSB_SMTP_*');
    } else {
      log.push('mail: no SSB_SMTP_HOST — outbound mail stays unconfigured (inbox/notifications degrade honestly)');
    }
  } catch (e) {
    console.warn('[single-site] smtp not applied:', e.message);
  }

  try {
    const sid = envVal('SSB_TWILIO_ACCOUNT_SID');
    const token = envVal('SSB_TWILIO_AUTH_TOKEN');
    if (sid && token) {
      await platform.setPlatformSetting('sms.enabled', '1');
      await platform.setPlatformSetting('sms.provider', 'twilio');
      await platform.setPlatformSetting('sms.account_sid', sid);
      await platform.setPlatformSetting('sms.auth_token', token);
      if (envVal('SSB_TWILIO_FROM_NUMBER'))
        await platform.setPlatformSetting('sms.from_number', envVal('SSB_TWILIO_FROM_NUMBER'));
      log.push('sms ← SSB_TWILIO_*');
    } else {
      log.push('call tracking: no owner Twilio credentials (module reports unavailable)');
    }
  } catch (e) {
    console.warn('[single-site] twilio not applied:', e.message);
  }

  /* Tenant money bootstrap: the wizard's Stripe keys land in the
   * seeded lead's unified payments config ONLY when that lead has no
   * working config yet — after the first boot the portal owns them. */
  try {
    const secret = envVal('SSB_STRIPE_SECRET');
    if (secret) {
      const { query } = require('./db');
      const wsRows = await query('SELECT id FROM workspaces ORDER BY id ASC');
      if (Array.isArray(wsRows) && wsRows.length === 1) {
        const wsId = Number(wsRows[0].id);
        const { openWorkspaceDb } = require('./workspaceDb');
        // Default open: { create: false } would return a READONLY
        // handle (workspaceDb's must-exist read mode) and the
        // payments-config write would fail on it.
        const tdb = openWorkspaceDb(wsId);
        if (tdb) {
          let leadId = null;
          try {
            const owner = tdb
              .prepare('SELECT lead_id FROM websites WHERE lead_id IS NOT NULL ORDER BY id ASC LIMIT 1')
              .get();
            if (owner) leadId = Number(owner.lead_id);
          } catch {
            /* websites table always exists on a seeded tenant db */
          }
          try {
            const portalRows = await query(
              'SELECT lead_id FROM client_portal_users WHERE workspace_id = :ws ORDER BY id ASC',
              { ws: wsId }
            );
            if (Array.isArray(portalRows) && portalRows.length && portalRows[0].lead_id) {
              leadId = Number(portalRows[0].lead_id);
            }
          } catch {
            /* fall back to the website's lead */
          }
          if (leadId) {
            const paymentsConfig = require('./paymentsConfig');
            if (!paymentsConfig.isConfigured(tdb, leadId, 'shop')) {
              paymentsConfig.saveCredentials(
                tdb,
                leadId,
                {
                  // paymentsConfig.saveCredentials reads snake_case.
                  publishable_key: envVal('SSB_STRIPE_PUBLISHABLE'),
                  secret_key: secret,
                  webhook_secret: envVal('SSB_STRIPE_WEBHOOK_SECRET'),
                },
                'shop'
              );
              if (paymentsConfig.isConfigured(tdb, leadId, 'shop')) {
                log.push(`stripe bootstrap → payments config for lead ${leadId} (portal owns it from here)`);
              } else {
                console.warn('[single-site] stripe bootstrap saved but config still reads unconfigured');
              }
            } else {
              log.push('stripe: seeded payments config already present — env keys left as fallback only');
            }
          }
        }
      } else {
        console.warn(
          `[single-site] expected exactly 1 workspace for the Stripe bootstrap, found ${wsRows && wsRows.length}`
        );
      }
    }
  } catch (e) {
    console.warn('[single-site] stripe bootstrap failed:', e.message);
  }

  console.log('[single-site] config collapse:', log.join('; ') || 'no env config supplied');
  return { applied: true, log };
}

module.exports = {
  isSingleSite,
  DISABLED_API_PREFIXES,
  DISABLED_PAGES,
  disabledPageGate,
  siteDir,
  isPublicAssetAllowed,
  applyBootDefaults,
};
