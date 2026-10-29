'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const cors = require('cors');

const { migrate, ping } = require('./server/db');
const { MySQLSessionStore } = require('./server/sessionStore');
const { findWorkspaceByToken } = require('./server/workspace');
const { handleJsonRpc, SERVER_INFO } = require('./server/mcp');
const apiErrors = require('./server/apiErrors');
const { startScheduler } = require('./server/jobs');

const authRoutes = require('./server/routes/auth');
const domainApi = require('./server/routes/domainApi');
const jobsRoutes = require('./server/routes/jobs');
const mcpAdminRoutes = require('./server/routes/mcpAdmin');
const adminRoutes = require('./server/routes/admin');
const billingRoutes = require('./server/routes/billing');
const inviteRoutes = require('./server/routes/invites');
const socialPublicRoutes = require('./server/routes/socialPublic');
const designPublicRoutes = require('./server/routes/designPublic');
const formsPublicRoutes = require('./server/routes/formsPublic');
const modulesPublicRoutes = require('./server/routes/modulesPublic');
const chatbotPublicRoutes = require('./server/routes/chatbotPublic');
const outreachPublicRoutes = require('./server/routes/outreachPublic');
const websitePromoRoutes = require('./server/routes/websitePromo');
const landingRoutes = require('./server/routes/landing');
// Batch 59: public install-script callback + bundle download.
const hostingerCallbackRoutes = require('./server/routes/hostingerCallback');
const { rateLimit: rateLimitFactory } = require('./server/rateLimit');
const hostingerDeployLimit = rateLimitFactory({ name: 'hostinger-deploy', windowMs: 15 * 60 * 1000, max: 40 });
// Batch 59: deployment ticker (provisioning/install watchdog).
const hostingerDeploy = require('./server/hostingerDeploy');
const portalRoutes = require('./server/routes/portal');
const { publicRouter: mcpOAuthPublic, sessionRouter: mcpOAuthSession } = require('./server/routes/mcpOAuth');
const mcpOAuth = require('./server/mcpOAuth');

const PORT = Number(process.env.PORT || 3000);
const IS_PROD = process.env.NODE_ENV === 'production';

if (IS_PROD) {
  const secret = String(process.env.SESSION_SECRET || '');
  if (!secret || secret === 'dev-change-me' || secret.length < 24) {
    console.error('[boot] SESSION_SECRET must be set to a strong value (≥24 chars) in production');
    process.exit(1);
  }
  const appUrlRaw = String(process.env.APP_URL || '').trim();
  if (!appUrlRaw) {
    console.error('[boot] APP_URL must be set in production (e.g. https://bitpype.com)');
    process.exit(1);
  }
  if (!/^https:\/\//i.test(appUrlRaw) && String(process.env.ALLOW_INSECURE_APP_URL || '') !== '1') {
    console.error('[boot] APP_URL must be https in production (set ALLOW_INSECURE_APP_URL=1 only for emergency HTTP)');
    process.exit(1);
  }
}

const app = express();

app.set('trust proxy', 1);
// Batch 47: the header policy lives in server/securityHeaders.js — helmet
// (CSP + baseline headers) plus a fill-only-when-absent middleware that
// adds Permissions-Policy and guarantees HSTS on HTTPS responses. The
// /embed override below still widens framing for published-site embeds.
const securityHeaders = require('./server/securityHeaders');
app.use(helmet(securityHeaders.helmetOptions()));
app.use(securityHeaders.securityHeaders());
// Published sites (CF Pages / client domains) iframe /embed/form.html — the
// app CSP's frame-ancestors 'self' would block that, so embeds widen it here.
// (The X-Frame-Options removal is a no-op since Batch 47 disabled helmet's
// frameguard; kept so a future helmet change can't silently re-break embeds.)
app.use('/embed', (req, res, next) => {
  res.removeHeader('X-Frame-Options');
  res.setHeader(
    'Content-Security-Policy',
    req.path === '/captcha.html' ? require('./server/previewSecurity').CAPTCHA_CSP : 'frame-ancestors *'
  );
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  next();
});
app.use(compression());
const appOrigin = (() => {
  try {
    const raw = String(process.env.APP_URL || '').trim();
    if (!raw) return null;
    return new URL(raw).origin;
  } catch {
    return null;
  }
})();
app.use(require('./server/previewSecurity').rejectOpaqueAppRequests);
app.use(
  cors({
    origin(origin, cb) {
      // Non-browser / same-origin tools send no Origin.
      if (!origin) return cb(null, true);
      // When APP_URL is unset, never reflect arbitrary browser Origins.
      if (!appOrigin) return cb(null, false);
      if (origin === appOrigin) return cb(null, true);
      return cb(null, false);
    },
    credentials: true,
  })
);

// Stripe webhooks need the raw body for signature verification — mount before JSON parser.
const stripeWebhook = require('./server/routes/stripeWebhook');
app.use('/api/v1/billing/webhook', express.raw({ type: 'application/json' }), stripeWebhook);
const shopWebhook = require('./server/routes/shopWebhook');
app.use('/api/v1/shop/webhook', express.raw({ type: 'application/json' }), shopWebhook);
const membershipWebhook = require('./server/routes/membershipWebhook');
app.use('/api/v1/membership/webhook', express.raw({ type: 'application/json' }), membershipWebhook);

// Smaller default JSON; design/portal/website payloads need more room.
// website-promo gets 12mb: its brochure upload rides base64-in-JSON
// (~4/3 inflation), so an 8mb JSON cap would reject the documented 8MB
// brochure before the route's own size check ever runs.
app.use((req, res, next) => {
  const large = /^\/api\/v1\/(design|portal|websites|mcp|website-promo)/i.test(req.path || '');
  const promo = /^\/api\/v1\/website-promo/i.test(req.path || '');
  const analytics = req.path.startsWith('/api/v1/site-analytics/public/');
  return express.json({ limit: analytics ? '1kb' : promo ? '12mb' : large ? '8mb' : process.env.JSON_BODY_LIMIT || '1mb' })(
    req,
    res,
    next
  );
});
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

// Secure cookies only when APP_URL is https (or COOKIE_SECURE=1).
// HTTP IP deploys must keep secure:false or the browser drops the session.
const cookieSecure = (() => {
  if (process.env.COOKIE_SECURE === '1' || process.env.COOKIE_SECURE === 'true') return true;
  if (process.env.COOKIE_SECURE === '0' || process.env.COOKIE_SECURE === 'false') return false;
  const appUrl = String(process.env.APP_URL || '');
  return /^https:/i.test(appUrl);
})();

// Share the session cookie across apex + www (host-only cookies do not).
// Override with COOKIE_DOMAIN=.example.com, or COOKIE_DOMAIN=0 to disable.
const cookieDomain = (() => {
  const raw = String(process.env.COOKIE_DOMAIN || '').trim();
  if (raw === '0' || raw === 'false') return undefined;
  if (raw) return raw.startsWith('.') ? raw : `.${raw}`;
  try {
    const host = new URL(String(process.env.APP_URL || '')).hostname;
    if (!host || host === 'localhost' || host.endsWith('.local')) return undefined;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return undefined;
    // Strip leading www. so Domain=.bitpype.com covers both hosts.
    const apex = host.replace(/^www\./i, '');
    if (!apex.includes('.')) return undefined;
    return `.${apex}`;
  } catch {
    return undefined;
  }
})();

const sessionCookie = {
  httpOnly: true,
  sameSite: 'lax',
  secure: cookieSecure,
  path: '/',
  maxAge: 14 * 24 * 60 * 60 * 1000,
};
if (cookieDomain) sessionCookie.domain = cookieDomain;

// Portal idle timeout: rolling cookie + server-side last-activity check.
// No portal API activity for this long → session is destroyed (sign-out).
const PORTAL_IDLE_MS = Math.max(60 * 60 * 1000, Number(process.env.PORTAL_IDLE_MS) || 30 * 60 * 60 * 1000);
const portalSessionCookie = {
  ...sessionCookie,
  maxAge: PORTAL_IDLE_MS,
};

// Staff and client portal use separate cookies so neither login wipes the other.
const STAFF_SESSION_NAME = 'bitpype.sid';
const PORTAL_SESSION_NAME = 'bitpype.portal.sid';
const LEGACY_SESSION_NAMES = ['scout.sid', 'connect.sid'];

const sessionSecret = process.env.SESSION_SECRET || (IS_PROD ? '' : 'dev-change-me');
const sessionStore = new MySQLSessionStore();

function makeSession(name, cookie = sessionCookie) {
  return session({
    name,
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    proxy: true,
    store: sessionStore,
    cookie: { ...cookie },
  });
}

const staffSession = makeSession(STAFF_SESSION_NAME, sessionCookie);
const portalSession = makeSession(PORTAL_SESSION_NAME, portalSessionCookie);

app.locals.sessionCookie = sessionCookie;
app.locals.portalSessionCookie = portalSessionCookie;
app.locals.portalIdleMs = PORTAL_IDLE_MS;
app.locals.staffSessionName = STAFF_SESSION_NAME;
app.locals.portalSessionName = PORTAL_SESSION_NAME;
app.locals.legacySessionNames = LEGACY_SESSION_NAMES;

// Portal API gets its own cookie first (must not share staff bitpype.sid).
app.use('/api/v1/portal', portalSession, portalRoutes);

// MCP OAuth consent uses the portal cookie (Claude → /authorize → client login).
app.use(['/authorize', '/oauth'], portalSession);
app.use(mcpOAuthPublic);
app.use(mcpOAuthSession);

// Staff session for the rest of the app (skip portal — already handled above).
app.use((req, res, next) => {
  if (req.path.startsWith('/api/v1/portal')) return next();
  if (req.path.startsWith('/authorize') || req.path.startsWith('/oauth')) return next();
  return staffSession(req, res, next);
});

if (IS_PROD) {
  console.log('[session] cookies', {
    staff: STAFF_SESSION_NAME,
    portal: PORTAL_SESSION_NAME,
    secure: cookieSecure,
    domain: cookieDomain || '(host-only)',
    sameSite: 'lax',
    staffMaxAgeDays: 14,
    portalIdleHours: Math.round(PORTAL_IDLE_MS / (60 * 60 * 1000)),
    rolling: true,
    store: 'mysql/sqlite',
  });
}

app.get('/health', async (_req, res) => {
  try {
    await ping();
    if (process.env.NODE_ENV === 'production') {
      return res.json({ ok: true });
    }
    res.json({
      ok: true,
      server: SERVER_INFO,
      db: true,
      endpoints: ['/api/v1', '/mcp', '/health'],
    });
  } catch (e) {
    res.status(503).json({ ok: false, error: e.message });
  }
});

// Muse API: unauthenticated health + OpenAPI (mounted before workspace auth).
app.get('/api/v1/health', (_req, res) => {
  const ver = (SERVER_INFO && SERVER_INFO.version) || require('./package.json').version || '0.1.0';
  res.json({
    ok: true,
    version: ver,
    surface: 'api',
    access_order: 'prefer /api/v1; MCP is transport fallback',
  });
});
app.get('/api/v1/openapi.json', (_req, res) => {
  try {
    const { buildOpenApi } = require('./server/openapiV1');
    res.json(buildOpenApi());
  } catch (e) {
    apiErrors.sendError(res, e, 500, { area: 'openapi', nested: true });
  }
});

const { requireWorkspace, requireSubscription } = require('./server/middleware');

// Public captcha config (site key only) for auth + client forms (also used cross-origin by form-embed.js).
app.get('/api/v1/captcha/config', async (_req, res) => {
  try {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    const captcha = require('./server/captcha');
    res.json({ ok: true, data: await captcha.getCaptchaConfig() });
  } catch (e) {
    apiErrors.sendError(res, e, 500, { area: 'captcha' });
  }
});

app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/admin', adminRoutes);
// Billing stays reachable without a paid plan (checkout / portal / delete).
app.use('/api/v1/billing', billingRoutes);
app.use('/api/v1/invites', inviteRoutes);
// Google Business Profile manager (Batch 46): the router carries its
// own OAuth callback (state-signed, pre-session) + staff-session stack.
app.use('/api/v1/gbp', require('./server/routes/gbp'));
// Meta OAuth callback + client weekly approval (no session).
app.use('/api/v1/social', socialPublicRoutes);
app.use('/api/v1/site-analytics/public', require('./server/routes/siteAnalyticsPublic'));
// Call Tracking (Batch 21): Twilio webhooks are public; the recording
// playback proxy accepts the portal cookie OR the staff session, so for
// that one path we stash the staff session, run the portal session
// parser too, and let the route gate on both.
const callsRoutes = require('./server/routes/calls');
app.use(
  '/api/v1/calls',
  (req, res, next) => {
    if (!req.path.startsWith('/recording-file/')) return next();
    req.staffSession = req.session || null;
    return portalSession(req, res, () => {
      req.portalSession = req.session || null;
      req.session = req.staffSession;
      next();
    });
  },
  callsRoutes
);
// Design client change-request / Q&A form (no session).
app.use('/api/v1/design/public', designPublicRoutes);
// Public contact form schema + submit (Turnstile).
// Customer sites load form-embed.js cross-origin from CF Pages / custom domains.
app.use(
  '/api/v1/forms/public',
  (req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    return next();
  },
  formsPublicRoutes
);
// Public site-module embed payload (blog/shop/courses/gallery/directory).
// Customer sites load this cross-origin from CF Pages / custom domains.
app.use(
  '/api/v1/modules/public',
  (req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    // Member-session + page-context + owner-preview headers (Membership gating).
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, X-Bitpype-Member-Session, X-Bitpype-Page, X-Bitpype-Preview-Grant'
    );
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    return next();
  },
  modulesPublicRoutes
);
// Public site chatbot (visitor bubble → portal client MCP agent; no admin tokens).
app.use(
  '/api/v1/chat/public',
  (req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    return next();
  },
  chatbotPublicRoutes
);
// Public outreach interest / not-interested / claim APIs (HMAC token, no session).
// CORS so Cloudflare Pages previews can call claim meta from claim-preview.js.
app.use(
  '/api/v1/outreach/public',
  (req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    return next();
  },
  outreachPublicRoutes
);
// Facebook-ad website promo lead form (Turnstile + lead create).
app.use('/api/v1/website-promo', websitePromoRoutes);
// Batch 58: /landing software-interest form (Turnstile + lead create in ws1).
app.use('/api/v1/landing', landingRoutes);
// Batch 59: Hostinger one-click deploy — a customer VM's install
// script phones home here and downloads its source bundle here
// (per-deployment token auth inside the router; no session/workspace).
app.use('/api/v1/hostinger-deploy', hostingerDeployLimit, hostingerCallbackRoutes);
// Client portal routes are mounted earlier with portalSession (separate cookie).
// Resolve workspace first, then paywall (workspace owner plan covers members).
app.use('/api/v1/jobs', requireWorkspace, requireSubscription, jobsRoutes);
app.use('/api/v1/mcp', requireWorkspace, requireSubscription, mcpAdminRoutes);
app.use('/api/v1', requireWorkspace, requireSubscription, domainApi);

async function mcpHandler(req, res) {
  try {
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ')) {
      res.setHeader('WWW-Authenticate', mcpOAuth.wwwAuthenticateHeader());
      return res.status(401).json({
        ok: false,
        error: 'Bearer token required',
        error_description: 'Authentication required',
      });
    }
    const ws = await findWorkspaceByToken(auth.slice(7).trim());
    if (!ws) {
      res.setHeader('WWW-Authenticate', mcpOAuth.wwwAuthenticateHeader());
      return res.status(401).json({ ok: false, error: 'INVALID_TOKEN' });
    }

    // Mirror product paywall for MCP bearer access (Free plan counts)
    {
      const billing = require('./server/billing');
      if (await billing.requireSubscriptionEnabled()) {
        const ok = await billing.workspaceHasProductAccess(ws.workspace_id);
        if (!ok) {
          return res.status(402).json({ ok: false, error: 'SUBSCRIPTION_REQUIRED', code: 'SUBSCRIPTION_REQUIRED' });
        }
      }
    }

    const mcpCtx = {
      tokenId: ws.token_id,
      leadId: ws.lead_id != null ? Number(ws.lead_id) : null,
    };

    if (req.method === 'GET') {
      return res.json({
        ok: true,
        server: SERVER_INFO,
        workspaceId: ws.workspace_id,
        leadId: mcpCtx.leadId,
        clientScoped: !!mcpCtx.leadId,
        transport: 'streamable-http',
      });
    }

    const body = req.body;
    if (Array.isArray(body)) {
      const MCP_BATCH_MAX = Math.min(100, Math.max(1, Number(process.env.MCP_BATCH_MAX) || 25));
      if (body.length > MCP_BATCH_MAX) {
        return res.status(400).json({
          ok: false,
          error: `MCP batch limited to ${MCP_BATCH_MAX} items`,
          code: 'BATCH_TOO_LARGE',
        });
      }
      const out = [];
      for (const item of body) {
        const r = await handleJsonRpc(ws.workspace_id, item, mcpCtx);
        if (r) out.push(r);
      }
      return res.json(out.length === 1 ? out[0] : out);
    }
    const result = await handleJsonRpc(ws.workspace_id, body, mcpCtx);
    if (result == null) return res.status(204).end();
    return res.json(result);
  } catch (e) {
    apiErrors.sendError(res, e, 500, { area: 'mcp' });
  }
}

app.post('/mcp', mcpHandler);
app.get('/mcp', mcpHandler);
app.post('/ws', mcpHandler);
app.get('/ws', mcpHandler);

// Brand assets are embedded in outbound HTML email; email proxies need cross-origin reads.
app.use(
  '/brand',
  (req, res, next) => {
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Access-Control-Allow-Origin', '*');
    next();
  },
  express.static(path.join(__dirname, 'public', 'brand'), { maxAge: '7d' })
);

// Outreach template images (workspace data dir → absolute APP_URL in HTML email).
app.get('/email-assets/:wsId/:file', (req, res) => {
  const wsId = String(req.params.wsId || '');
  const file = path.basename(String(req.params.file || ''));
  if (!/^\d+$/.test(wsId) || !/^[\w.-]+$/.test(file)) return res.status(404).end();
  const { dataRoot } = require('./server/workspaceDb');
  const root = path.resolve(dataRoot(), wsId, 'email-assets');
  const full = path.resolve(root, file);
  if (full !== root && !full.startsWith(root + path.sep)) return res.status(404).end();
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  return res.sendFile(full, (err) => {
    if (err) res.status(404).end();
  });
});

// Batch 56: the public marketing/legal pages carry NO hardcoded domain —
// they contain {{PUBLIC_URL}} / {{SUPPORT_EMAIL}} tokens filled at serve
// time from the canonical settings: general.public_url via the resolver
// (stripeClient.appUrl), and support.email — falling back to
// team@<public host> so day-one output matches the previous hardcoded
// pages byte for byte. File bodies are cached; tokens are substituted per
// request so an admin edit to the Public URL applies without a redeploy.
const fs = require('fs');
const templatedPageCache = new Map();
function readTemplatedPage(rel) {
  if (!templatedPageCache.has(rel)) {
    try {
      templatedPageCache.set(rel, fs.readFileSync(path.join(__dirname, 'public', rel), 'utf8'));
    } catch {
      templatedPageCache.set(rel, null);
    }
  }
  return templatedPageCache.get(rel);
}
async function templatedTokens() {
  let publicUrl = '';
  try {
    publicUrl = require('./server/stripeClient').appUrl();
  } catch {
    publicUrl = '';
  }
  let supportEmail = '';
  try {
    supportEmail = String((await require('./server/platform').getPlatformSetting('support.email', '')) || '').trim();
  } catch {
    supportEmail = '';
  }
  if (!supportEmail && publicUrl) {
    try {
      supportEmail = `team@${new URL(publicUrl).hostname}`;
    } catch {
      supportEmail = '';
    }
  }
  return { publicUrl, supportEmail };
}
async function sendTemplatedPage(res, rel) {
  const raw = readTemplatedPage(rel);
  if (raw == null) return res.status(404).end();
  try {
    const { publicUrl, supportEmail } = await templatedTokens();
    const html = raw.split('{{PUBLIC_URL}}').join(publicUrl).split('{{SUPPORT_EMAIL}}').join(supportEmail);
    return res.type('html').send(html);
  } catch {
    return res.sendFile(path.join(__dirname, 'public', rel));
  }
}

// Batch 58: /landing is a templated page PLUS a serve-time videos
// section. The {{LANDING_VIDEOS}} token in public/landing.html is
// replaced with section HTML built by server/landingVideos.js from the
// canonical IDs stored in the landing.video_embeds platform setting —
// or with '' when no videos are configured, so the section does not
// render at all. A settings read failure degrades to no videos, never
// to a broken page.
async function sendLandingPage(res) {
  const raw = readTemplatedPage('landing.html');
  if (raw == null) return res.status(404).end();
  try {
    const { publicUrl, supportEmail } = await templatedTokens();
    let videosHtml = '';
    try {
      const stored = await require('./server/platform').getPlatformSetting('landing.video_embeds', '[]');
      const landingVideos = require('./server/landingVideos');
      videosHtml = landingVideos.landingVideosSectionHtml(landingVideos.parseStoredLandingVideoEmbeds(stored));
    } catch {
      videosHtml = '';
    }
    const html = raw
      .split('{{PUBLIC_URL}}')
      .join(publicUrl)
      .split('{{SUPPORT_EMAIL}}')
      .join(supportEmail)
      .split('{{LANDING_VIDEOS}}')
      .join(videosHtml);
    return res.type('html').send(html);
  } catch {
    return res.sendFile(path.join(__dirname, 'public', 'landing.html'));
  }
}

// Marketing home at `/`. Staff SPA lives at `/app` so public visitors never hit the desk UI.
// Logged-in staff hitting `/` are sent to `/app` so existing bookmarks keep working.
app.get('/', (req, res) => {
  if (req.session && req.session.userId) {
    return res.redirect(302, '/app');
  }
  return sendTemplatedPage(res, 'home.html');
});

// Widget tour lives at /how. express.static will not map /how → how.html,
// and the HTML catch-all below would otherwise send the homepage.
app.get(['/how', '/how/'], (_req, res) => {
  return sendTemplatedPage(res, 'how.html');
});

// Standalone "How it works" marketing page. Same pattern as /how: without an
// explicit route the HTML catch-all below would send the homepage.
app.get(['/how-it-works', '/how-it-works/'], (_req, res) => {
  return sendTemplatedPage(res, 'how-it-works.html');
});

// Batch 58: /landing sells the software itself to prospective agency
// owners. Same explicit-route pattern (plus the videos substitution).
app.get(['/landing', '/landing/'], (_req, res) => {
  return sendLandingPage(res);
});

// Batch 56: direct file paths for the templated pages are intercepted
// BEFORE express.static so a raw {{TOKEN}} is never served.
app.get('/home.html', (_req, res) => sendTemplatedPage(res, 'home.html'));
app.get('/how.html', (_req, res) => sendTemplatedPage(res, 'how.html'));
app.get('/how-it-works.html', (_req, res) => sendTemplatedPage(res, 'how-it-works.html'));
app.get('/landing.html', (_req, res) => sendLandingPage(res));
app.get('/legal/privacy.html', (_req, res) => sendTemplatedPage(res, 'legal/privacy.html'));
app.get('/legal/terms.html', (_req, res) => sendTemplatedPage(res, 'legal/terms.html'));

app.get(['/website-promo', '/website-promo/'], (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'website-promo.html'));
});

app.get(['/app', '/app/'], (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Legacy bookmark: staff shell used to live at /index.html
app.get('/index.html', (_req, res) => {
  res.redirect(302, '/app');
});

app.get(['/portal', '/client'], (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'portal.html'));
});

// Customer sites (CF Pages / custom domains) load these cross-origin.
// No default icon is configured. Do not serve the staff SPA as a favicon.
app.get('/favicon.ico', (_req, res) => {
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.status(204).end();
});
// Helmet defaults CORP to same-origin, which blocks <script src> from pages.dev.
app.use(
  [
    '/js/form-embed.js',
    '/js/module-embed.js',
    '/js/chat-embed.js',
    '/js/captcha.js',
    '/js/fonts.js',
    '/js/cookie-bar.js',
    '/js/site-analytics.js',
    '/js/claim-preview.js',
  ],
  (req, res, next) => {
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Access-Control-Allow-Origin', '*');
    next();
  }
);

// Do not auto-serve public/index.html for `/` (that is the staff app).
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// Public static previews (APP_URL fallback when Cloudflare is unavailable).
// Prefer CF Pages for public traffic; local path uses EXPORT_ROOT / openPreview.exportRoot().
// CORP cross-origin: pages.dev (and other origins) may embed preview images/fonts;
// helmet defaults to same-origin which blocks <img> while curl still succeeds.
{
  const { exportRoot } = require('./src/openPreview');
  app.use(
    '/site-previews',
    require('./server/previewSecurity').isolateStaticPreview,
    require('./server/previewSecurity').blockArchivedPreviews,
    (req, res, next) => {
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      res.setHeader('Access-Control-Allow-Origin', '*');
      next();
    },
    express.static(exportRoot(), {
      index: ['index.html'],
      fallthrough: true,
      redirect: true,
      extensions: ['html'],
    })
  );
  // Batch 31 (C2): unknown preview paths serve the SITE's themed
  // 404.html with a TRUE 404 status — never the home page (soft 404).
  // Batch 64: the archive gate runs here too — a missing file inside an
  // archived site's folder must not leak the site's themed 404 page.
  app.use('/site-previews', require('./server/previewSecurity').blockArchivedPreviews, (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const seg = String(req.path || '').split('/').filter(Boolean)[0];
    if (!seg) return next();
    try {
      const fsMod = require('fs');
      const pathMod = require('path');
      const notFound = pathMod.join(exportRoot(), seg, '404.html');
      if (fsMod.existsSync(notFound)) {
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        res.setHeader('Access-Control-Allow-Origin', '*');
        return res.status(404).sendFile(notFound);
      }
    } catch {
      /* fall through to the generic 404 */
    }
    return next();
  });
}

app.get('*', (req, res, next) => {
  if (
    req.path.startsWith('/api') ||
    req.path.startsWith('/mcp') ||
    req.path.startsWith('/ws') ||
    req.path.startsWith('/site-previews') ||
    req.path.startsWith('/email-assets') ||
    req.path.startsWith('/portal') ||
    req.path.startsWith('/client') ||
    req.path.startsWith('/app') ||
    req.path.startsWith('/brand') ||
    req.path.startsWith('/embed') ||
    req.path.startsWith('/legal') ||
    req.path.startsWith('/.well-known') ||
    req.path.startsWith('/authorize') ||
    req.path.startsWith('/oauth') ||
    req.path === '/token' ||
    req.path === '/register'
  ) {
    return next();
  }
  // Unknown browser paths → marketing home (APIs already handled above).
  if (req.accepts('html')) {
    return sendTemplatedPage(res, 'home.html');
  }
  return next();
});

app.use((err, _req, res, _next) => {
  if (res.headersSent) return _next(err);
  // Batch 54: every error that reaches the central handler is shaped by
  // server/apiErrors — unexpected 5xx are logged with a reference id and
  // answered generically (code INTERNAL + ref); authored errors keep
  // their code + message; body-parser failures become BAD_JSON.
  const status = err.status || err.statusCode || 500;
  const shaped = apiErrors.shapeError(err, status, 'http');
  if (!shaped.ref) console.error(err);
  const body = { ok: false, error: shaped.message, code: shaped.code };
  if (shaped.ref) body.ref = shaped.ref;
  res.status(shaped.status).json(body);
});

async function pruneExpiredSessions() {
  try {
    const { query } = require('./server/db');
    await query('DELETE FROM sessions WHERE expires < :now', { now: Date.now() });
  } catch (e) {
    console.warn('[sessions] prune:', e.message);
  }
}

async function main() {
  await migrate();
  console.log('[db] schema ready');

  const platform = require('./server/platform');
  await platform.seedPlatformDefaults();
  // Encrypt any platform secrets still stored as plaintext (audit M6 port).
  const mig = await platform.migratePlatformSecrets().catch(() => ({ migrated: 0 }));
  if (mig.migrated) console.log(`[platform] encrypted ${mig.migrated} plaintext secret(s) at rest`);
  console.log('[platform] settings seeded');

  // Batch 56: prime the public-URL resolver cache from the stored
  // general.public_url setting (Admin → Settings → General).
  await require('./server/stripeClient').refreshPublicUrl().catch(() => '');
  console.log('[platform] public URL resolver primed');

  // Batch 57: prime the plan-contents resolver from the stored
  // plans.contents_* overrides (Admin → Settings → Billing).
  await require('./server/planContents').refreshPlanContents().catch(() => {});
  console.log('[platform] plan contents resolver primed');

  await require('./server/captcha').assertProductionReady();
  await pruneExpiredSessions();
  setInterval(
    () => {
      pruneExpiredSessions().catch(() => {});
    },
    60 * 60 * 1000
  );

  if (process.env.BOOTSTRAP_EMAIL && process.env.BOOTSTRAP_PASSWORD) {
    const { findUserByEmail, createUserWithWorkspace } = require('./server/workspace');
    const admin = require('./server/admin');
    const existing = await findUserByEmail(process.env.BOOTSTRAP_EMAIL);
    if (!existing) {
      const created = await createUserWithWorkspace({
        email: process.env.BOOTSTRAP_EMAIL,
        password: process.env.BOOTSTRAP_PASSWORD,
        name: process.env.BOOTSTRAP_NAME || 'Owner',
        workspaceName: process.env.BOOTSTRAP_WORKSPACE || 'Primary',
      });
      console.log('[bootstrap] created owner user + workspace', created.workspaceId);
      if (process.env.BOOTSTRAP_SUPER_ADMIN === '1' || process.env.BOOTSTRAP_SUPER_ADMIN === 'true') {
        await admin.setSuperAdmin(created.userId, true);
        console.log('[bootstrap] promoted bootstrap user to super admin');
      }
    } else if (process.env.BOOTSTRAP_SUPER_ADMIN === '1' || process.env.BOOTSTRAP_SUPER_ADMIN === 'true') {
      // Opt-in only — set BOOTSTRAP_SUPER_ADMIN=1 to promote bootstrap user.
      await admin.setSuperAdmin(existing.id, true);
      console.log('[bootstrap] ensured super admin for', process.env.BOOTSTRAP_EMAIL);
    }
  }

  startScheduler({ intervalMs: Number(process.env.JOB_TICK_MS || 30000) });
  // Batch 59: resume/watch Hostinger deployments left mid-flight.
  try {
    hostingerDeploy.startDeploymentTicker();
  } catch (e) {
    console.warn('[hostingerDeploy] ticker not started:', e.message);
  }
  // Batch 60: hourly domain-renewal reconcile (idempotent, PATCHes
  // the registrar only on drift; first pass a few minutes after boot).
  try {
    require('./server/domainRenewals').startRenewalTicker();
  } catch (e) {
    console.warn('[domainRenewals] ticker not started:', e.message);
  }
  try {
    require('./server/imapPoller').startImapPoller({
      intervalMs: Number(process.env.IMAP_POLL_MS || 120000),
    });
  } catch (e) {
    console.warn('[imapPoller] not started:', e.message);
  }
  app.listen(PORT, () => {
    console.log(`[website-scout-web] listening on :${PORT}`);
  });
}

main().catch((e) => {
  console.error('Failed to start:', e);
  process.exit(1);
});
