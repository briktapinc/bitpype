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
const { requireSuperAdmin } = require('./server/middleware');
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
const wordpressPublicRoutes = require('./server/routes/wordpressPublic');
const modulesPublicRoutes = require('./server/routes/modulesPublic');
const chatbotPublicRoutes = require('./server/routes/chatbotPublic');
const outreachPublicRoutes = require('./server/routes/outreachPublic');
const websitePromoRoutes = require('./server/routes/websitePromo');
const landingRoutes = require('./server/routes/landing');
// Batch 79: /creator Solo application form (Turnstile + lead create in ws1).
const creatorRoutes = require('./server/routes/creator');
// Batch 80: /partner application form + the partner's session API.
const partnerRoutes = require('./server/routes/partner');
const partnersRoutes = require('./server/routes/partners');
const mailingListPublicRoutes = require('./server/routes/mailingListPublic');
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
// The design-chat attachment upload gets 15mb for the same reason: its
// documented cap is a 10 MB image, which inflates to ~13.3 MB of base64
// before the route's own magic-byte + size validation runs (Batch 89).
app.use((req, res, next) => {
  const large = /^\/api\/v1\/(design|portal|websites|mcp|website-promo|admin)/i.test(req.path || '');
  const promo = /^\/api\/v1\/website-promo/i.test(req.path || '');
  const chatUpload = /^\/api\/v1\/portal\/site\/agent-chat\/attachments/i.test(req.path || '');
  const analytics = req.path.startsWith('/api/v1/site-analytics/public/');
  return express.json({
    limit: analytics ? '1kb' : chatUpload ? '15mb' : promo ? '12mb' : large ? '8mb' : process.env.JSON_BODY_LIMIT || '1mb',
  })(
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
// Batch 102 (SEC-12): the OpenAPI document is staff-only — it was
// public by design (Audit 1 Q3 #5) and maps the whole API surface
// for unauthenticated readers. Super-admin session required, same
// bar as the /api/v1/admin router.
app.get('/api/v1/openapi.json', requireSuperAdmin, (_req, res) => {
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
// Batch 114 — WordPress connector plugin API. Server-to-server only:
// callers are WordPress sites presenting the scoped site credential
// derived at registration (never a workspace bearer token).
app.use('/api/v1/wordpress', wordpressPublicRoutes);
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
// Batch 79: /creator Solo application form (Turnstile + lead create in ws1).
app.use('/api/v1/creator', creatorRoutes);
// Batch 80: /partner application form (Turnstile + lead create in ws1)
// and the signed-in partner's earnings/approvals API.
app.use('/api/v1/partner', partnerRoutes);
app.use('/api/v1/partners', partnersRoutes);
// Batch 71: public unsubscribe link for the Admin mailing list
// (HMAC token, no session — flips one subscriber, nothing else exposed).
app.use('/api/v1/mailing-list', mailingListPublicRoutes);
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
    const securityEvents = require('./server/securityEvents');
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ')) {
      // Batch 103 (SEC-21): MCP 401s leave an auth-event trace.
      await securityEvents.recordAuthEvent({
        surface: 'mcp',
        event: 'mcp_401',
        ip: req.ip,
        detail: 'missing bearer token',
      });
      res.setHeader('WWW-Authenticate', mcpOAuth.wwwAuthenticateHeader());
      return res.status(401).json({
        ok: false,
        error: 'Bearer token required',
        error_description: 'Authentication required',
      });
    }
    const presentedToken = auth.slice(7).trim();
    const ws = await findWorkspaceByToken(presentedToken);
    if (!ws) {
      await securityEvents.recordAuthEvent({
        surface: 'mcp',
        event: 'mcp_401',
        tokenPrefix: presentedToken.slice(0, 10),
        ip: req.ip,
        detail: 'invalid token',
      });
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
      // Batch 103: token identity for the SEC-09 vendor class check,
      // SEC-07 rate limiting and the SEC-08 audit log.
      tokenPrefix: ws.token_prefix || presentedToken.slice(0, 10),
      tokenClass: ws.token_class || 'standard',
    };

    // Batch 103 (SEC-07): per-token rate limits on tools/call, backed
    // by the DB limiter (Batch 55 store). General ceiling 600/min per
    // token; a tighter 60/min bucket for AI/design/image tools. A
    // store failure fails OPEN with a warning — the same DB backs
    // auth itself, so a dead store already fails the request earlier.
    const MCP_RL_WINDOW_MS = 60 * 1000;
    const MCP_RL_GENERAL_MAX = 600;
    const MCP_RL_AI_MAX = 60;
    const mcpIsAiTool = (toolName) => {
      const n = String(toolName || '');
      if (n === 'design.pending' || n === 'design.list' || n === 'design.get') return false;
      return n.startsWith('ai.') || n.startsWith('design.') || n.startsWith('image') || n.includes('generate');
    };
    const mcpRateLimited = async (item) => {
      if (!item || item.method !== 'tools/call') return false;
      try {
        const store = require('./server/rateLimitStore');
        const key = String(ws.token_id);
        const general = await store.recordHit('mcp:general', key, MCP_RL_WINDOW_MS, Date.now());
        if (general > MCP_RL_GENERAL_MAX) return true;
        if (mcpIsAiTool(item.params && item.params.name)) {
          const ai = await store.recordHit('mcp:ai', key, MCP_RL_WINDOW_MS, Date.now());
          if (ai > MCP_RL_AI_MAX) return true;
        }
      } catch (e) {
        console.warn('[mcp] rate limit store unavailable, failing open:', e.message);
      }
      return false;
    };
    const mcpRateLimitResponse = (item) => ({
      jsonrpc: '2.0',
      id: item && item.id != null ? item.id : null,
      error: { code: -32029, message: 'RATE_LIMITED: too many MCP requests for this token; slow down and retry shortly.' },
    });

    // Batch 103 (SEC-08): audit every tools/call outcome.
    const mcpAudit = async (item, result) => {
      if (!item || item.method !== 'tools/call') return;
      let ok = false;
      let error = null;
      try {
        if (result && result.error) {
          error = result.error.message || 'jsonrpc error';
        } else if (result && result.result && Array.isArray(result.result.content) && result.result.content[0]) {
          const parsed = JSON.parse(result.result.content[0].text || '{}');
          ok = parsed.ok !== false;
          if (!ok) error = parsed.error || parsed.message || 'tool error';
        }
      } catch {
        /* unparsable outcome — record as error-free unknown */
        ok = false;
        error = 'unparsable outcome';
      }
      await securityEvents.recordMcpCall({
        workspaceId: ws.workspace_id,
        tokenId: ws.token_id,
        tokenPrefix: mcpCtx.tokenPrefix,
        tool: item.params && item.params.name,
        args: (item.params && item.params.arguments) || {},
        ok,
        error,
      });
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
        if (await mcpRateLimited(item)) {
          out.push(mcpRateLimitResponse(item));
          continue;
        }
        const r = await handleJsonRpc(ws.workspace_id, item, mcpCtx);
        await mcpAudit(item, r);
        if (r) out.push(r);
      }
      return res.json(out.length === 1 ? out[0] : out);
    }
    if (await mcpRateLimited(body)) {
      return res.status(429).json({ ok: false, error: 'RATE_LIMITED', code: 'RATE_LIMITED' });
    }
    const result = await handleJsonRpc(ws.workspace_id, body, mcpCtx);
    await mcpAudit(body, result);
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

// Batch 87 — Admin-configured brand logos: when a custom logo is set
// in Admin → Settings → Branding, the canonical brand URLs serve the
// uploaded file (data volume) instead of the committed default asset.
// Every surface keeps referencing the canonical paths (staff sidebar,
// auth, portal, marketing pages, the email wrapper), so no markup
// changes when the logo changes. Unset or corrupt → fall through to
// the static default below, untouched. Headers mirror the /brand
// static mount (email proxies read these cross-origin).
function serveCustomBrandLogo(variant) {
  return async (req, res, next) => {
    let custom = null;
    try {
      const branding = require('./server/branding');
      await branding.refreshBrandingIfStale();
      custom = branding.customLogoFile(variant);
    } catch {
      custom = null;
    }
    if (!custom) return next();
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.type(custom.contentType).sendFile(custom.file);
  };
}
app.get('/brand/logo-white.png', serveCustomBrandLogo('dark'));
app.get(['/brand/logo-black.png', '/brand/logo-email.png'], serveCustomBrandLogo('light'));

// Batch 92 — serve the stored /brand-files/<filename> path itself.
// Batch 87 minted that path as "the served path" and the Admin →
// Settings → Branding previews use it as their <img> src, but no
// route ever mounted it: previews 404'd (broken-image placeholders
// under a "custom logo is in use" claim) while the canonical URLs
// above served the custom logo correctly. The filename is strictly
// validated by branding.storedLogoFile (minted names only, resolved
// inside the brand dir on the data volume); anything else 404s.
// Headers mirror serveCustomBrandLogo.
app.get('/brand-files/:name', (req, res) => {
  let stored = null;
  try {
    stored = require('./server/branding').storedLogoFile(req.params.name);
  } catch {
    stored = null;
  }
  if (!stored) return res.status(404).end();
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=300');
  return res.type(stored.contentType).sendFile(stored.file);
});

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
// Batch 75: Ely's Facebook / earnings disclaimer rides in the footer
// small print of exactly the marketing pages. The verbatim text and the
// injection live in server/marketingDisclaimer.js (single source).
// Templated pages opt in via TEMPLATED_PAGE_SCHEMES keyed by rel — the
// legal pages are absent from the map and never gain the block; the
// dedicated senders below (landing, thankyou, website-promo) inject
// explicitly. /app, /portal and the transactional flow pages use other
// senders entirely and stay untouched.
const marketingDisclaimer = require('./server/marketingDisclaimer');

async function sendTemplatedPage(res, rel) {
  const raw = readTemplatedPage(rel);
  if (raw == null) return res.status(404).end();
  try {
    const { publicUrl, supportEmail } = await templatedTokens();
    let html = raw.split('{{PUBLIC_URL}}').join(publicUrl).split('{{SUPPORT_EMAIL}}').join(supportEmail);
    html = marketingDisclaimer.injectDisclaimer(html, marketingDisclaimer.TEMPLATED_PAGE_SCHEMES[rel]);
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
    let html = raw
      .split('{{PUBLIC_URL}}')
      .join(publicUrl)
      .split('{{SUPPORT_EMAIL}}')
      .join(supportEmail)
      .split('{{LANDING_VIDEOS}}')
      .join(videosHtml);
    html = marketingDisclaimer.injectDisclaimer(html, 'light');
    return res.type('html').send(html);
  } catch {
    return res.sendFile(path.join(__dirname, 'public', 'landing.html'));
  }
}

// Batch 79: /creator pitches the Solo license to content creators.
// Same dedicated-sender pattern as /landing: Batch 56 tokens are
// substituted at serve time and the Batch 75 marketing disclaimer is
// injected (the page carries example-math about earnings, so the
// disclaimer set membership is deliberate). No serve-time sections.
async function sendCreatorPage(res) {
  const raw = readTemplatedPage('creator.html');
  if (raw == null) return res.status(404).end();
  try {
    const { publicUrl, supportEmail } = await templatedTokens();
    let html = raw.split('{{PUBLIC_URL}}').join(publicUrl).split('{{SUPPORT_EMAIL}}').join(supportEmail);
    html = marketingDisclaimer.injectDisclaimer(html, 'light');
    return res.type('html').send(html);
  } catch {
    return res.sendFile(path.join(__dirname, 'public', 'creator.html'));
  }
}

// Batch 80: /partner pitches the FREE partner program, and
// /work-with-us hubs every opportunity page. Same dedicated-sender
// pattern as /creator: Batch 56 tokens substituted at serve time and
// the Batch 75 marketing disclaimer injected (both pages talk about
// earnings, so the disclaimer set membership is deliberate).
async function sendPartnerPage(res) {
  const raw = readTemplatedPage('partner.html');
  if (raw == null) return res.status(404).end();
  try {
    const { publicUrl, supportEmail } = await templatedTokens();
    let html = raw.split('{{PUBLIC_URL}}').join(publicUrl).split('{{SUPPORT_EMAIL}}').join(supportEmail);
    html = marketingDisclaimer.injectDisclaimer(html, 'light');
    return res.type('html').send(html);
  } catch {
    return res.sendFile(path.join(__dirname, 'public', 'partner.html'));
  }
}

async function sendWorkWithUsPage(res) {
  const raw = readTemplatedPage('work-with-us.html');
  if (raw == null) return res.status(404).end();
  try {
    const { publicUrl, supportEmail } = await templatedTokens();
    let html = raw.split('{{PUBLIC_URL}}').join(publicUrl).split('{{SUPPORT_EMAIL}}').join(supportEmail);
    html = marketingDisclaimer.injectDisclaimer(html, 'light');
    return res.type('html').send(html);
  } catch {
    return res.sendFile(path.join(__dirname, 'public', 'work-with-us.html'));
  }
}

// Batch 70: /thankyou is where a successful /landing submission lands.
// A templated page like /landing, PLUS serve-time sections built by
// server/landingThankYou.js from the landing.thankyou_video +
// landing.thankyou_calendly_url platform settings — or '' for each when
// unset, so that section does not render at all. A settings read
// failure degrades to no sections, never to a broken page, and no raw
// setting value ever reaches the page (the video renders as an iframe
// built from the stored ID; the Calendly link as a validated CTA href).
async function sendThankYouPage(res) {
  const raw = readTemplatedPage('thankyou.html');
  if (raw == null) return res.status(404).end();
  try {
    const { publicUrl, supportEmail } = await templatedTokens();
    let sectionsHtml = '';
    try {
      const platform = require('./server/platform');
      const landingThankYou = require('./server/landingThankYou');
      const videoId = await platform.getPlatformSetting('landing.thankyou_video', '');
      const calendlyUrl = await platform.getPlatformSetting('landing.thankyou_calendly_url', '');
      sectionsHtml = landingThankYou.thankYouSectionsHtml({ videoId, calendlyUrl });
    } catch {
      sectionsHtml = '';
    }
    let html = raw
      .split('{{PUBLIC_URL}}')
      .join(publicUrl)
      .split('{{SUPPORT_EMAIL}}')
      .join(supportEmail)
      .split('{{THANKYOU_SECTIONS}}')
      .join(sectionsHtml);
    html = marketingDisclaimer.injectDisclaimer(html, 'light');
    return res.type('html').send(html);
  } catch {
    return res.sendFile(path.join(__dirname, 'public', 'thankyou.html'));
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

// Batch 79: /creator — the Solo license pitched to content creators.
app.get(['/creator', '/creator/'], (_req, res) => {
  return sendCreatorPage(res);
});

// Batch 80: /partner — the free partner program; /work-with-us — the
// hub listing every opportunity page.
app.get(['/partner', '/partner/'], (_req, res) => {
  return sendPartnerPage(res);
});
app.get(['/work-with-us', '/work-with-us/'], (_req, res) => {
  return sendWorkWithUsPage(res);
});

// Batch 70: /thankyou — the post-submission page (demo video + Calendly
// booking button from the Landing settings).
app.get(['/thankyou', '/thankyou/'], (_req, res) => {
  return sendThankYouPage(res);
});

// Batch 73: /onboarding — the client onboarding pack as a public page,
// linked from the domain flow's payment-received email (the moment a
// client has subscribed and their website is in progress). Client
// sections only: the pack's internal staff run sheet is never hosted.
app.get(['/onboarding', '/onboarding/'], (_req, res) => {
  return sendTemplatedPage(res, 'onboarding.html');
});

// Batch 56: direct file paths for the templated pages are intercepted
// BEFORE express.static so a raw {{TOKEN}} is never served.
app.get('/home.html', (_req, res) => sendTemplatedPage(res, 'home.html'));
app.get('/how.html', (_req, res) => sendTemplatedPage(res, 'how.html'));
app.get('/how-it-works.html', (_req, res) => sendTemplatedPage(res, 'how-it-works.html'));
app.get('/landing.html', (_req, res) => sendLandingPage(res));
app.get('/creator.html', (_req, res) => sendCreatorPage(res));
app.get('/partner.html', (_req, res) => sendPartnerPage(res));
app.get('/work-with-us.html', (_req, res) => sendWorkWithUsPage(res));
app.get('/thankyou.html', (_req, res) => sendThankYouPage(res));
app.get('/onboarding.html', (_req, res) => sendTemplatedPage(res, 'onboarding.html'));
app.get('/legal/privacy.html', (_req, res) => sendTemplatedPage(res, 'legal/privacy.html'));
app.get('/legal/terms.html', (_req, res) => sendTemplatedPage(res, 'legal/terms.html'));

// Batch 77: /sms-policy — the public text-messaging policy page (the
// URL Ely pastes into the Twilio A2P registration). A legal-family
// page served through the templated sender so its {{PUBLIC_URL}}
// contact link resolves at serve time; sms-policy.html is deliberately
// NOT in marketingDisclaimer.TEMPLATED_PAGE_SCHEMES — legal pages never
// carry the marketing disclaimer (pinned by
// tests/batch77-sms-policy-regressions.cjs).
app.get(['/sms-policy', '/sms-policy/'], (_req, res) => {
  return sendTemplatedPage(res, 'sms-policy.html');
});
app.get('/sms-policy.html', (_req, res) => sendTemplatedPage(res, 'sms-policy.html'));

// Batch 75: website-promo is a marketing page, so it goes through the
// disclaimer injection like the other marketing senders.
// Batch 77: the promo form now carries an SMS-consent line whose policy
// link is a {{PUBLIC_URL}} token — so the sender substitutes the
// standard templated tokens (same resolver as every other public page)
// before injecting the disclaimer. A token failure degrades to the raw
// file, exactly like sendTemplatedPage's fallback.
async function sendWebsitePromoPage(res) {
  const raw = readTemplatedPage('website-promo.html');
  if (raw == null) return res.status(404).end();
  try {
    const { publicUrl, supportEmail } = await templatedTokens();
    const html = raw.split('{{PUBLIC_URL}}').join(publicUrl).split('{{SUPPORT_EMAIL}}').join(supportEmail);
    return res.type('html').send(marketingDisclaimer.injectDisclaimer(html, 'light'));
  } catch {
    return res.type('html').send(marketingDisclaimer.injectDisclaimer(raw, 'light'));
  }
}

app.get(['/website-promo', '/website-promo/'], (_req, res) => {
  return sendWebsitePromoPage(res);
});
app.get('/website-promo.html', (_req, res) => sendWebsitePromoPage(res));

// Batch 75: /solo hosts the Solo Agency Playbook (Ely's standalone
// branded HTML from his files, copied to public/solo.html). It is a
// complete self-contained document — served VERBATIM: no template
// tokens, and NO disclaimer injection, because the playbook's footer
// already carries the Batch 75 disclaimer text (the hosted copy's only
// change is the six demo-CTA placeholders pointing at /landing until
// Ely supplies the real demo link). solo.html is deliberately absent
// from TEMPLATED_PAGE_SCHEMES.
function sendSoloPage(res) {
  const raw = readTemplatedPage('solo.html');
  if (raw == null) return res.status(404).end();
  return res.type('html').send(raw);
}

app.get(['/solo', '/solo/'], (_req, res) => {
  return sendSoloPage(res);
});
app.get('/solo.html', (_req, res) => sendSoloPage(res));

app.get(['/app', '/app/'], async (_req, res) => {
  // Batch 87: the sidebar brand block renders the Admin-configured
  // tagline (Admin → Settings → Branding). Serve-time substitution on
  // the cached shell file, mirroring sendTemplatedPage; any failure
  // falls back to the file as committed (default tagline baked in).
  try {
    const raw = readTemplatedPage('index.html');
    if (raw == null) throw new Error('shell unreadable');
    const branding = require('./server/branding');
    await branding.refreshBrandingIfStale();
    const tagline = branding.tagline();
    const esc = String(tagline)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
    res.type('html').send(raw.replace('<span class="brand-tag">Local business desk</span>', `<span class="brand-tag">${esc}</span>`));
  } catch {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
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

  // Batch 87: prime the branding cache (Admin → Settings → Branding
  // logos + tagline) so first paint already serves configured values.
  await require('./server/branding').refreshBranding().catch(() => {});
  console.log('[platform] branding cache primed');

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
  // Batch 63: hourly lifecycle comms sweep (pre-renewal reminders,
  // domain lapse/flip notices, cancel reminders, rental statements —
  // every send deduped in lifecycle_comms_sends).
  try {
    require('./server/lifecycleComms').startLifecycleTicker();
  } catch (e) {
    console.warn('[lifecycleComms] ticker not started:', e.message);
  }
  // Batch 76: Missed-Call Rescue sweep — 60s cadence drives the
  // ~1-minute text-back SLA, voice-escalation windows, quiet-hours
  // deferrals and the estimate follow-up sequence.
  try {
    require('./server/callRescue').startRescueTicker();
  } catch (e) {
    console.warn('[callRescue] ticker not started:', e.message);
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
