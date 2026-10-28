'use strict';

/**
 * Batch 47 — the app's own security-header policy, in one module so the
 * wiring in server.js stays a two-liner and the policy is unit-testable.
 *
 * What already existed (Batch ≤46): helmet is mounted globally with a CSP
 * (enforced in production, report-only elsewhere) whose frame-ancestors
 * 'self' is the codebase's framing idiom — previewSecurity.js and the
 * /embed override both speak frame-ancestors, and /embed actively REMOVES
 * helmet's X-Frame-Options. What was missing: Permissions-Policy (helmet
 * has no such feature) and any guarantee that the baseline headers
 * survive a future helmet-config edit.
 *
 * Division of labor:
 *   - helmetOptions() — the helmet configuration, moved verbatim from
 *     server.js EXCEPT xFrameOptions is now disabled: framing is
 *     controlled by CSP frame-ancestors 'self' ONLY (one mechanism, not
 *     two — X-Frame-Options was redundant next to it and already had to
 *     be stripped for /embed).
 *   - securityHeaders() — middleware mounted right after helmet: always
 *     sets Permissions-Policy, and fills X-Content-Type-Options /
 *     Referrer-Policy / Strict-Transport-Security ONLY when absent, so
 *     it can never duplicate or clobber a header helmet (or a later
 *     route, e.g. the preview CSP in previewSecurity.js) sets.
 *
 * Permissions-Policy: the product uses no camera, microphone, geolocation
 * or Payment Request API anywhere (grepped public/js + renderer + src +
 * server), and Stripe runs as a hosted redirect — so those features are
 * disabled outright, along with USB and the motion sensors. Anything not
 * listed (autoplay, fullscreen, …) is deliberately left alone: exported
 * site previews embed third-party media and must not be collateral.
 */

function cspReportOnly() {
  const raw = String(process.env.CSP_REPORT_ONLY || '')
    .trim()
    .toLowerCase();
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  // Enforce in production; report-only elsewhere so local/dev shells stay flexible.
  return process.env.NODE_ENV !== 'production';
}

function cookieSecureHint() {
  if (process.env.COOKIE_SECURE === '1' || process.env.COOKIE_SECURE === 'true') {
    return { maxAge: 15552000, includeSubDomains: true, preload: false };
  }
  if (process.env.COOKIE_SECURE === '0' || process.env.COOKIE_SECURE === 'false') return false;
  if (/^https:/i.test(String(process.env.APP_URL || ''))) {
    return { maxAge: 15552000, includeSubDomains: true, preload: false };
  }
  return false;
}

function helmetOptions() {
  return {
    // Staff/portal shells; embed routes override in server.js. Set CSP_REPORT_ONLY=1 to observe only.
    contentSecurityPolicy: {
      useDefaults: true,
      reportOnly: cspReportOnly(),
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'", "'unsafe-inline'", 'https://challenges.cloudflare.com'],
        'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        'font-src': ["'self'", 'https://fonts.gstatic.com', 'data:'],
        'img-src': ["'self'", 'data:', 'blob:', 'https:'],
        'connect-src': ["'self'", 'https:'],
        'frame-src': ["'self'", 'https://challenges.cloudflare.com', 'https:'],
        'frame-ancestors': ["'self'"],
      },
    },
    // Batch 47: CSP frame-ancestors 'self' (above) is THE framing control.
    // Helmet's X-Frame-Options duplicated it and had to be removed
    // per-route for /embed — one mechanism only.
    xFrameOptions: false,
    // HSTS only meaningful behind HTTPS (trust proxy + X-Forwarded-Proto).
    hsts: cookieSecureHint(),
  };
}

const PERMISSIONS_POLICY =
  'camera=(), microphone=(), geolocation=(), payment=(), usb=(), magnetometer=(), gyroscope=(), accelerometer=(), interest-cohort=()';

const HSTS_VALUE = 'max-age=15552000; includeSubDomains';

function securityHeaders() {
  return (req, res, next) => {
    // The one header helmet cannot send. Nothing else in the app sets it,
    // so it is set unconditionally (never duplicated: setHeader replaces).
    res.setHeader('Permissions-Policy', PERMISSIONS_POLICY);
    // Baseline guarantees — fill only when absent so helmet's values (or a
    // route's own, e.g. the preview Referrer-Policy: no-referrer) always win.
    if (!res.getHeader('X-Content-Type-Options')) {
      res.setHeader('X-Content-Type-Options', 'nosniff');
    }
    if (!res.getHeader('Referrer-Policy')) {
      res.setHeader('Referrer-Policy', 'same-origin');
    }
    // The app is HTTPS-only behind Cloudflare: when this request arrived
    // over HTTPS (trust proxy honors X-Forwarded-Proto) and helmet's
    // env-gated HSTS did not already fire, the response still carries STS.
    if (req.secure && !res.getHeader('Strict-Transport-Security')) {
      res.setHeader('Strict-Transport-Security', HSTS_VALUE);
    }
    next();
  };
}

module.exports = { helmetOptions, securityHeaders, PERMISSIONS_POLICY, HSTS_VALUE, cspReportOnly, cookieSecureHint };
