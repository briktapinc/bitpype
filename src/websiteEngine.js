'use strict';

/**
 * Website Engine — component library + site builder for Website Scout.
 *
 * One engine serves every surface of the web app (REST facade in
 * server/domain.js, the MCP server, and the design-job pipeline): each
 * function takes the workspace's better-sqlite3 db as its first argument
 * — there is no global/current db anywhere in this module.
 *
 * Data model: a website is structured JSON —
 *   pages: [{ slug, title, sections?: [...], html?: string }]
 *   theme: { primary, secondary, font, headingFont?, bg, text, customCss?, customJs?, customHead?,
 *            baseCss?, elementFonts?, logoMode?, logoUrl?, brandName? }
 * logoMode: "text" (default) | "image". When "image" and logoUrl is set,
 * built-in nav renders an <img>; otherwise business_name / brandName text.
 * Agent deliveries may use freeform page.html (body or full document) instead
 * of built-in sections. Static export writes one HTML file per page.
 *
 * Anti-hallucination (top priority):
 *  - Only facts with claim_class VERIFIED or OWNER_PROVIDED (from
 *    business_facts) — plus lead-record contact basics — are ever rendered
 *    as facts. UNKNOWN facts are never rendered.
 *  - We never invent founding years, awards, addresses, licenses, or review
 *    texts. When in doubt the claim is omitted or labelled AI_COPY
 *    (marketing tone only, no factual assertions).
 *  - Every generated site stores a claim manifest (claim_manifest table)
 *    listing each rendered claim and its class.
 */

const fs = require('fs');
const path = require('path');
const ai = require('./ai');
const googleFonts = require('../public/js/fonts.js');
const siteIcons = require('./siteIcons');
const seoSchema = require('./seoSchema');
const siteLegal = require('./siteLegal');
const { assertPublicUrl } = require('../server/urlSafety');

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Plain-text sanitizer for AI/deterministic copy: strip tags, trim, cap. */
function cleanText(s, max = 500) {
  let t = String(s ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length > max) t = t.slice(0, max).trim();
  return t;
}

function digitsOnly(s) {
  return String(s ?? '').replace(/\D/g, '');
}

/** Visible/content text for QA — strip script/style bodies before tags (avoids JS null false alarms). */
function visibleTextFromHtml(html) {
  return String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ');
}

function ensureTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS claim_manifest (
    website_id INTEGER PRIMARY KEY REFERENCES websites(id) ON DELETE CASCADE,
    manifest TEXT NOT NULL
  )`);
  const cols = db.prepare('PRAGMA table_info(websites)').all();
  if (cols.length && !cols.some((c) => c.name === 'origin')) {
    db.exec('ALTER TABLE websites ADD COLUMN origin TEXT');
  }
  if (cols.length && !cols.some((c) => c.name === 'archived_at')) {
    db.exec('ALTER TABLE websites ADD COLUMN archived_at TEXT');
  }
  const vCols = db.prepare('PRAGMA table_info(website_versions)').all();
  if (vCols.length && !vCols.some((c) => c.name === 'author')) {
    try {
      db.exec('ALTER TABLE website_versions ADD COLUMN author TEXT');
    } catch {
      /* exists */
    }
  }
}

function getSetting(db, key, def) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? require('./secretBox').decryptSetting(key, row.value) : def;
}

function logActivity(db, area, message) {
  try {
    db.prepare('INSERT INTO activity_log (area, message) VALUES (?, ?)').run(area, message);
  } catch (e) {
    /* activity logging must never break generation */
  }
}

function setLeadStatus(db, leadId, status) {
  db.prepare("UPDATE leads SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, leadId);
}

function err(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/* ------------------------------------------------------------------ */
/* theme                                                               */
/* ------------------------------------------------------------------ */

const DEFAULT_THEME = {
  primary: '#1a56db',
  secondary: '#0e2a5c',
  font: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  bg: '#ffffff',
  text: '#1f2937',
  logoMode: 'text',
  logoUrl: '',
  brandName: '',
};

function sanitizeCss(css) {
  let s = String(css == null ? '' : css);
  if (s.length > 200000) s = s.slice(0, 200000);
  // Strip anything that could break out of <style> or run script via CSS.
  s = s.replace(/<\/style/gi, '');
  s = s.replace(/<\/script/gi, '');
  // Keep only https font @imports from Google Fonts; drop every other @import.
  s = s.replace(
    /@import\s+url\(\s*['"]?(https:\/\/fonts\.googleapis\.com\/[^'")\s]+)['"]?\s*\)\s*;?/gi,
    '@import url("$1");'
  );
  s = s.replace(/@import\b(?![^;]*fonts\.googleapis\.com)[^;]*;?/gi, '');
  s = s.replace(/expression\s*\(/gi, 'expr\u200Bession(');
  // Strip IE/XUL behaviors without touching CSS properties like scroll-behavior.
  s = s.replace(/(^|[;{])\s*-moz-binding\s*:[^;}]*/gi, '$1');
  s = s.replace(/(^|[;{])\s*behavior\s*:[^;}]*/gi, '$1');
  s = s.replace(/javascript\s*:/gi, '');
  return s;
}

/**
 * Theme-level freestyle JS (motion, effects, interactivity).
 * Escapes script-tag breakouts; content is otherwise agent-authored.
 */
function sanitizeJs(js) {
  let s = String(js == null ? '' : js);
  if (s.length > 200000) s = s.slice(0, 200000);
  s = s.replace(/<\/script/gi, '<\\/script');
  return s;
}

/**
 * Theme/page customHead — static HTML injected before </head>.
 * Escapes </head breakouts; content is otherwise agent-authored (incl. third-party scripts).
 */
function sanitizeHead(html) {
  let s = String(html == null ? '' : html);
  if (s.length > 200000) s = s.slice(0, 200000);
  s = s.replace(/<\/head/gi, '<\\/head');
  return s;
}

function themeJsTag(theme) {
  const t = normalizeTheme(theme);
  const js = t.customJs && String(t.customJs).trim();
  if (!js) return '';
  return `<script data-ws-theme-js="1">${js}</script>`;
}

function themeHeadInject(theme) {
  const t = normalizeTheme(theme);
  const head = t.customHead && String(t.customHead).trim();
  if (!head) return '';
  return `<!--data-ws-theme-head-->\n${head}`;
}

function pageHeadInject(pageHead) {
  const head = pageHead && String(pageHead).trim();
  if (!head) return '';
  return `<!--data-ws-page-head-->\n${head}`;
}

/** Truncate HTML without cutting inside an open tag (avoids broken <script …>). */
function truncateHtmlSafely(html, maxLen) {
  const s = String(html == null ? '' : html);
  if (s.length <= maxLen) return s;
  let cut = maxLen;
  const lastLt = s.lastIndexOf('<', cut);
  const lastGt = s.lastIndexOf('>', cut);
  if (lastLt > lastGt) cut = lastLt;
  if (cut < 1) cut = maxLen;
  return s.slice(0, cut);
}

/** Decode the character references a browser would decode inside an
 * attribute value, for scheme-check purposes only (Batch 180, M9):
 * numeric refs (semicolon optional, as browsers accept), plus the
 * named refs that can hide a scheme separator or split a scheme name. */
function decodeAttrEntitiesForCheck(value) {
  return String(value || '')
    .replace(/&#x([0-9a-fA-F]+);?/g, (_, h) => {
      const c = parseInt(h, 16);
      return Number.isFinite(c) && c > 0 && c < 0x110000 ? String.fromCodePoint(c) : '';
    })
    .replace(/&#(\d+);?/g, (_, n) => {
      const c = Number(n);
      return Number.isFinite(c) && c > 0 && c < 0x110000 ? String.fromCodePoint(c) : '';
    })
    .replace(/&Tab;?/gi, '\t')
    .replace(/&NewLine;?/gi, '\n')
    .replace(/&colon;?/gi, ':')
    .replace(/&sol;?/gi, '/')
    .replace(/&amp;?/gi, '&');
}

/** True when an href-like attribute value is safe to keep: relative /
 * fragment / query URLs, or an http, https, mailto or tel scheme.
 * The value is entity-decoded and stripped of the ASCII tab/newline
 * characters the WHATWG URL parser removes before the scheme is read,
 * so `java&#115;cript:`, `java&Tab;script:` and `java\nscript:` are
 * judged as the `javascript:` URLs a browser would navigate to. */
function urlAttrValueAllowed(rawValue) {
  const decoded = decodeAttrEntitiesForCheck(rawValue).replace(/[\t\r\n]/g, '');
  const v = decoded.replace(/^[\u0000-\u0020]+/, '');
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(v);
  if (!m) return true;
  return /^(https?|mailto|tel)$/i.test(m[1]);
}

/**
 * Allow agent-authored markup without scripts or event handlers.
 * Safe <style> and https stylesheet/font <link> tags are kept so agents
 * can own typography and layout without the built-in component skin.
 */
function sanitizeHtml(html) {
  let s = String(html == null ? '' : html).replace(/\u0000/g, '');
  if (s.length > 800000) s = truncateHtmlSafely(s, 800000);
  const kept = [];
  const park = (chunk) => {
    const i = kept.length;
    kept.push(chunk);
    return `\u0000KEEP${i}\u0000`;
  };
  s = s.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (_, css) => park(`<style>${sanitizeCss(css)}</style>`));
  s = s.replace(/<link\b([^>]*)\/?>/gi, (_, attrs) => {
    const hrefM = /href\s*=\s*(['"])(https:\/\/[^'"]+)\1/i.exec(attrs);
    if (!hrefM) return '';
    const href = hrefM[2];
    const relM = /rel\s*=\s*(['"])([^'"]+)\1/i.exec(attrs);
    const rel = (relM ? relM[2] : 'stylesheet').toLowerCase();
    if (!/^(stylesheet|preconnect|preload)$/.test(rel)) return '';
    const cross = /\bcrossorigin\b/i.test(attrs) ? ' crossorigin' : '';
    return park(`<link rel="${rel}" href="${href}"${cross}>`);
  });
  s = s.replace(/<meta\b([^>]*)\/?>/gi, (_, attrs) => {
    if (/http-equiv/i.test(attrs)) return '';
    if (/\bcharset\b/i.test(attrs)) return park(`<meta${attrs}>`);
    if (/\bname\s*=/i.test(attrs) && /\bcontent\s*=/i.test(attrs)) return park(`<meta${attrs}>`);
    return '';
  });
  // Only exact first-party loaders survive; rebuild tags with no author body/attributes.
  const bitpypeScripts = [];
  s = s.replace(/<script\b([^>]*)>[\s\S]*?<\/script>/gi, (_, attrs) => {
    const tag = require('./managedScripts').approvedScript(attrs);
    if (!tag) return '';
    const index = bitpypeScripts.push(tag) - 1;
    return `\u0000BPSCRIPT${index}\u0000`;
  });
  s = s.replace(/<\/?script\b[^>]*>/gi, '');
  s = s.replace(/\u0000BPSCRIPT(\d+)\u0000/g, (_, i) => bitpypeScripts[Number(i)] || '');
  // Strip iframe/object/embed/base — form/module embeds are in-page JS mounts now.
  s = s.replace(/<\/?(iframe|object|embed|base)[\s\S]*?>/gi, '');
  s = s.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  // Batch 180 (M9): the whitespace-anchored strip above misses an
  // event handler that follows the solidus in a tag the HTML parser
  // recovers from, e.g. <svg/onload=alert(1)> — strip those too, on
  // every element (svg/math included, which the tag passes above
  // never exempted but the \s anchor implicitly did).
  s = s.replace(/\/on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  s = s.replace(/\s(href|src|action)\s*=\s*(['"])\s*javascript:[^'"]*\2/gi, ' $1="#"');
  s = s.replace(/\s(href|src|action)\s*=\s*javascript:[^\s>]*/gi, ' $1="#"');
  // Batch 180 (M9): judge every href-like attribute — href, src,
  // action, formaction and xlink:href, quoted or bare — by its
  // decoded scheme and keep only http/https/mailto/tel (or relative)
  // values. This closes the entity-encoded / tab-split scheme family
  // and `data:text/html` hrefs the literal `javascript:` strips miss.
  s = s.replace(
    /(\s(?:href|src|action|formaction|xlink:href)\s*=\s*)("[^"]*"|'[^']*'|[^\s>]+)/gi,
    (all, prefix, raw) => {
      const quoted = raw[0] === '"' || raw[0] === "'";
      const quote = quoted ? raw[0] : '"';
      const value = quoted ? raw.slice(1, -1) : raw;
      if (urlAttrValueAllowed(value)) return all;
      const attr = /([a-z:-]+)\s*=\s*$/.exec(prefix);
      const name = attr ? attr[1] : 'href';
      return ` ${name}=${quote}#${quote}`;
    }
  );
  s = s.replace(/\u0000KEEP(\d+)\u0000/g, (_, i) => kept[Number(i)] || '');
  // Safety net: mounts without their loader (legacy strip / hand-edited HTML).
  return ensureManagedEmbedScripts(s);
}

/**
 * Known BitPype in-page embed mounts ↔ /js/*-embed.js loaders.
 * Used by sanitizeHtml recovery and export asserts.
 */
const MANAGED_EMBED_KINDS = [
  {
    kind: 'chat',
    mountRe: /\bbitpype-chat-embed\b|\bdata-bitpype-chat\s*=/i,
    scriptRe: /\/js\/chat-embed\.js|\bdata-bitpype-chat-script\b/i,
    file: 'chat-embed.js',
    attr: 'data-bitpype-chat-script',
  },
  {
    kind: 'module',
    mountRe: /\bbitpype-module-embed\b|\bdata-bitpype-module\s*=/i,
    scriptRe: /\/js\/module-embed\.js|\bdata-bitpype-module-script\b/i,
    file: 'module-embed.js',
    attr: 'data-bitpype-module-script',
  },
  {
    kind: 'form',
    mountRe: /\bbitpype-form-embed\b|\bdata-bitpype-form-embed\s*=/i,
    scriptRe: /\/js\/form-embed\.js|\bdata-bitpype-form-script\b/i,
    file: 'form-embed.js',
    attr: 'data-bitpype-form-script',
  },
];

function defaultAppApiBase() {
  // Batch 56: the export API base resolves from the canonical public URL
  // (stripeClient.appUrl); the env read remains only as a fallback if the
  // resolver cannot load.
  try {
    return require('../server/stripeClient').appUrl();
  } catch {
    try {
      return String(process.env.APP_URL || '')
        .trim()
        .replace(/\/+$/, '');
    } catch {
      return '';
    }
  }
}

/**
 * Recover missing managed loaders from trusted APP_URL, never author API attributes.
 */
function ensureManagedEmbedScripts(html) {
  let s = String(html == null ? '' : html);
  const api = require('./managedScripts').appBase();
  for (const cfg of MANAGED_EMBED_KINDS) {
    if (!cfg.mountRe.test(s)) continue;
    if (cfg.scriptRe.test(s)) continue;
    const label = `[websiteEngine] managed embed: .bitpype-${cfg.kind}-embed without ${cfg.file}`;
    if (!api) {
      console.error(`${label} — cannot re-inject (missing trusted APP_URL)`);
      continue;
    }
    console.warn(`${label} — re-injecting ${cfg.file} via APP_URL`);
    const tag = require('./managedScripts').loaderTag(cfg.file);
    if (/<\/body>/i.test(s)) s = s.replace(/<\/body>/i, `${tag}\n</body>`);
    else s = `${s}\n${tag}`;
  }
  return s;
}

/**
 * Post-export assert: mounts must keep their loaders. Returns { ok, missing[] }.
 * Logs errors when incomplete so publish/materialize surfaces the regression.
 */
function assertManagedEmbedScripts(html, context) {
  const s = String(html == null ? '' : html);
  const missing = [];
  for (const cfg of MANAGED_EMBED_KINDS) {
    if (!cfg.mountRe.test(s)) continue;
    if (cfg.scriptRe.test(s)) continue;
    missing.push(cfg.file);
  }
  if (missing.length) {
    const where = context ? ` (${context})` : '';
    console.error(`[websiteEngine] EXPORT EMBED SCRIPT MISSING${where}: mount(s) without ${missing.join(', ')}`);
  }
  return { ok: missing.length === 0, missing };
}

function looksLikeFullDocument(html) {
  return /^\s*(<!doctype\s+html|<html[\s>])/i.test(String(html || ''));
}

/** Prefer agent-owned styling when custom CSS or an explicit opt-out is present. */
function normalizeTheme(theme) {
  const raw = theme && typeof theme === 'object' ? theme : {};
  const t = Object.assign({}, DEFAULT_THEME, raw);
  for (const k of ['primary', 'secondary', 'bg', 'text']) {
    if (typeof t[k] !== 'string' || !t[k].trim()) t[k] = DEFAULT_THEME[k];
  }
  t.font = googleFonts.safeStack(t.font);
  const headingRaw = typeof t.headingFont === 'string' ? t.headingFont.trim() : '';
  t.headingFont = headingRaw ? googleFonts.safeStack(headingRaw) : '';
  t.elementFonts = normalizeElementFonts(t.elementFonts);
  if (typeof t.customCss === 'string') t.customCss = sanitizeCss(t.customCss);
  else t.customCss = '';
  if (typeof t.customJs === 'string') t.customJs = sanitizeJs(t.customJs);
  else t.customJs = '';
  if (typeof t.customHead === 'string') t.customHead = sanitizeHead(t.customHead);
  else if (typeof t.custom_head === 'string') t.customHead = sanitizeHead(t.custom_head);
  else t.customHead = '';
  const logoMode = String(t.logoMode || 'text')
    .trim()
    .toLowerCase();
  t.logoMode = logoMode === 'image' ? 'image' : 'text';
  t.logoUrl = typeof t.logoUrl === 'string' ? t.logoUrl.trim().slice(0, 500) : '';
  if (t.logoMode === 'image' && !t.logoUrl) t.logoMode = 'text';
  t.brandName = typeof t.brandName === 'string' ? t.brandName.trim().slice(0, 120) : '';
  // Favicon: assets/… or images/… path (upload via website.uploadAsset).
  t.favicon = typeof t.favicon === 'string' ? t.favicon.trim().slice(0, 300) : '';
  if (t.favicon && !safeImageUrl(t.favicon) && !/^(?:images|assets)\//i.test(t.favicon)) t.favicon = '';
  // Shared site chrome partials (edit once via website.edit theme.partials).
  if (t.partials && typeof t.partials === 'object' && !Array.isArray(t.partials)) {
    t.partials = {
      headerHtml:
        typeof t.partials.headerHtml === 'string'
          ? sanitizeHtml(t.partials.headerHtml)
          : typeof t.partials.header === 'string'
            ? sanitizeHtml(t.partials.header)
            : '',
      footerHtml:
        typeof t.partials.footerHtml === 'string'
          ? sanitizeHtml(t.partials.footerHtml)
          : typeof t.partials.footer === 'string'
            ? sanitizeHtml(t.partials.footer)
            : '',
    };
  } else {
    t.partials = { headerHtml: '', footerHtml: '' };
  }
  const explicitOn = t.baseCss === true || t.baseCss === 1 || t.baseCss === '1';
  const explicitOff = t.baseCss === false || t.baseCss === 0 || t.baseCss === '0';
  if (explicitOff) t.baseCss = false;
  else if (explicitOn) t.baseCss = true;
  else t.baseCss = t.customCss || t.customJs || t.customHead ? false : true;
  return t;
}

function normalizeElementFonts(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const keys = Object.keys(raw).slice(0, 200);
  for (const key of keys) {
    if (!/^[\w:.-]{1,80}$/.test(key)) continue;
    const name = googleFonts.matchName(raw[key]);
    if (name) out[key] = name;
  }
  return out;
}

function brandLogoCss() {
  return (
    `.brand{display:inline-flex;align-items:center;gap:8px;text-decoration:none}` +
    `.brand img,.brand-logo,[data-ws-logo]{display:block;max-height:44px;width:auto;height:auto;max-width:min(220px,55vw);object-fit:contain}`
  );
}

/** CSS custom properties for theme colors — portal live preview + freeform sites. */
function themeRootCss(theme) {
  const t = normalizeTheme(theme);
  const heading = t.headingFont || t.font;
  return `:root{--ws-primary:${t.primary};--ws-secondary:${t.secondary};--ws-bg:${t.bg};--ws-text:${t.text};--ws-font:${t.font};--ws-heading-font:${heading}}`;
}

/** Sitewide type. Appended after customCss so a saved font wins; inline element fonts still win. */
function themeFontRules() {
  return 'body{font-family:var(--ws-font)}h1,h2,h3,h4,h5,h6{font-family:var(--ws-heading-font,var(--ws-font))}';
}

function brandLabel(c = {}, t) {
  const theme = normalizeTheme(t);
  return theme.brandName || c.business_name || 'Business';
}

function brandMarkup(c = {}, t) {
  const theme = normalizeTheme(t);
  const label = brandLabel(c, theme);
  const href = Array.isArray(c.links) && c.links[0] ? c.links[0].href : '#';
  if (theme.logoMode === 'image' && theme.logoUrl) {
    const src = theme.logoUrl;
    const safe =
      /^(images\/|\.\/images\/|\/images\/|https?:\/\/|data:image\/)/i.test(src) || /^[A-Za-z0-9._\-\/]+$/.test(src);
    if (safe) {
      return `<a class="brand" href="${esc(href)}" data-ws-brand="1"><img data-ws-logo="1" class="brand-logo" src="${esc(src)}" alt="${esc(label)}" /></a>`;
    }
  }
  return `<a class="brand" href="${esc(href)}" data-ws-brand="1">${esc(label)}</a>`;
}

/* ------------------------------------------------------------------ */
/* CSS (inline, responsive, standalone)                                 */
/* ------------------------------------------------------------------ */

/**
 * One-level submenu panel styles (menuParent / .nav-item.has-children / li.has-children).
 * Do NOT use margin-top on .nav-sub — that creates a hover dead-zone so the panel
 * closes before the pointer reaches a child link. Visual offset uses a transparent
 * ::before bridge instead.
 */
function navSubmenuCss() {
  return `
.nav-item,.nav-menu>li.has-children{position:relative;display:inline-flex;align-items:center}
.nav-item>a,.nav-menu>li>a{display:inline-block}
.nav-sub{display:none;position:absolute;top:100%;left:0;min-width:180px;padding:8px 0;margin:0;background:var(--ws-bg,#fff);border:1px solid #e5e7eb;border-radius:10px;box-shadow:0 10px 28px rgba(15,23,42,.12);flex-direction:column;align-items:stretch;z-index:60;list-style:none}
.nav-sub::before{content:"";position:absolute;left:0;right:0;top:-14px;height:14px}
.nav-item.has-children:hover>.nav-sub,.nav-item.has-children:focus-within>.nav-sub,
li.has-children:hover>.nav-sub,li.has-children:focus-within>.nav-sub{display:flex}
.nav-sub a{display:block;padding:10px 14px;white-space:nowrap}
.nav-sub a:hover{background:rgba(0,0,0,.04)}
`
    .replace(/\n/g, '')
    .trim();
}

function siteCss(t) {
  const theme = normalizeTheme(t);
  const root = themeRootCss(theme);
  const subNav = navSubmenuCss();
  const icons = siteIcons.iconCss();
  const minimal = `${root}\n*{box-sizing:border-box} img{max-width:100%;height:auto} .ws-edit{cursor:text}\n${brandLogoCss()}\n${subNav}\n${icons}`;
  const fontRules = themeFontRules();
  if (!theme.baseCss) {
    return `${minimal}\n${theme.customCss || ''}\n${fontRules}\n${spacingGuardCss()}`;
  }
  const base = `
${root}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--ws-font);color:var(--ws-text);background:var(--ws-bg);line-height:1.6}
a{color:var(--ws-primary)}
.container{max-width:1080px;margin:0 auto;padding:0 20px}
.nav{position:sticky;top:0;z-index:50;background:var(--ws-bg);border-bottom:1px solid #e5e7eb;overflow:visible}
.nav-inner{display:flex;align-items:center;justify-content:space-between;padding:14px 20px;max-width:1080px;margin:0 auto;overflow:visible}
.brand{font-weight:800;font-size:1.25rem;color:var(--ws-secondary);text-decoration:none;display:inline-flex;align-items:center;gap:8px}
.brand img,.brand-logo,[data-ws-logo]{display:block;max-height:44px;width:auto;height:auto;max-width:min(220px,55vw);object-fit:contain}
.nav-links{display:flex;gap:18px;align-items:center;flex-wrap:wrap;overflow:visible}
.nav-links a{text-decoration:none;color:var(--ws-text);font-weight:600;font-size:.95rem}
${subNav}
.nav-cta{background:var(--ws-primary);color:#fff!important;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:700}
.hero{background:linear-gradient(135deg,var(--ws-primary),var(--ws-secondary));color:#fff;padding:72px 0}
.hero h1{font-size:2.4rem;line-height:1.2;margin-bottom:14px}
.hero p{font-size:1.15rem;opacity:.95;max-width:640px;margin-bottom:24px}
.btn{display:inline-block;background:#fff;color:var(--ws-secondary);padding:13px 26px;border-radius:8px;font-weight:800;text-decoration:none;margin-right:12px}
.btn-primary{background:var(--ws-primary);color:#fff}
.btn-outline{background:transparent;color:#fff;border:2px solid #fff}
.rating-badge{display:inline-block;background:rgba(255,255,255,.18);border:1px solid rgba(255,255,255,.4);padding:6px 14px;border-radius:999px;font-size:.9rem;margin-bottom:16px}
section.block{padding:56px 0}
.block h2{font-size:1.8rem;color:var(--ws-secondary);margin-bottom:8px}
.block .lede{color:#4b5563;margin-bottom:28px;max-width:680px}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:20px}
.card{border:1px solid #e5e7eb;border-radius:12px;padding:24px;background:#fff}
.card h3{color:var(--ws-secondary);margin-bottom:8px;font-size:1.1rem}
.card p{color:#4b5563;font-size:.95rem}
.chip{display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:10px;background:linear-gradient(135deg,var(--ws-primary),var(--ws-secondary));color:#fff;font-weight:800;margin-bottom:12px}
.about p{margin-bottom:14px;color:#374151;max-width:760px}
.gallery-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
.ph{aspect-ratio:4/3;border-radius:12px;display:flex;align-items:flex-end;justify-content:center;color:#fff;font-weight:700;padding:12px;text-align:center;text-shadow:0 1px 3px rgba(0,0,0,.4);font-size:.9rem}
.stars{color:#f59e0b;letter-spacing:2px;margin-bottom:8px}
.review-card{font-style:normal}
.review-card .who{margin-top:10px;font-weight:700;color:var(--ws-secondary);font-style:normal}
.cta-band{background:var(--ws-secondary);color:#fff;text-align:center;padding:56px 20px;border-radius:16px}
.cta-band h2{color:#fff;margin-bottom:10px}
.cta-band p{opacity:.9;margin-bottom:24px}
.hours-table{width:100%;max-width:520px;border-collapse:collapse}
.hours-table td{padding:10px 4px;border-bottom:1px solid #e5e7eb}
.hours-table td:last-child{text-align:right;font-weight:600}
.faq details{border:1px solid #e5e7eb;border-radius:10px;padding:16px 18px;margin-bottom:12px;background:#fff}
.faq summary{font-weight:700;color:var(--ws-secondary);cursor:pointer}
.faq p{margin-top:8px;color:#4b5563}
.contact-grid{display:grid;grid-template-columns:1fr 1fr;gap:32px}
.field{margin-bottom:14px}
.field label{display:block;font-weight:600;margin-bottom:6px;font-size:.9rem}
.field input,.field textarea{width:100%;padding:11px 12px;border:1px solid #d1d5db;border-radius:8px;font:inherit}
.mapbox{border:2px dashed #c7d2fe;border-radius:12px;background:#eef2ff;min-height:220px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:24px;color:var(--ws-secondary)}
.mapbox .pin{font-size:2.2rem;margin-bottom:8px}
.social-row{display:flex;gap:12px;flex-wrap:wrap}
.social-row a{display:inline-block;padding:10px 18px;border:1px solid #d1d5db;border-radius:999px;text-decoration:none;color:var(--ws-secondary);font-weight:600}
.booking{text-align:center}
.booking .big-call{display:inline-block;background:var(--ws-primary);color:#fff;font-size:1.4rem;font-weight:800;padding:18px 40px;border-radius:12px;text-decoration:none}
.footer{background:var(--ws-secondary);color:#d1d5db;padding:40px 0;margin-top:0;font-size:.92rem}
.footer a{color:#fff}
.footer-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:24px;max-width:1080px;margin:0 auto;padding:0 20px}
.footer h4{color:#fff;margin-bottom:10px}
.copyright{text-align:center;margin-top:28px;opacity:.7;font-size:.85rem}
.bp-legal-links{text-align:center;margin-top:10px;font-size:.85rem}
.page-anchor{scroll-margin-top:70px}
.photo{margin:0}
.photo img,.hero-photo img{width:100%;object-fit:cover;border-radius:12px;display:block;background:#e5e7eb}
.photo img{aspect-ratio:4/3}
.hero-photo img{height:260px}
.photo-credit{font-size:.78rem;margin-top:6px;color:#6b7280}
.hero .photo-credit,.hero .photo-credit a{color:#fff}
.hero-grid{display:grid;grid-template-columns:1.25fr .75fr;gap:28px;align-items:center}
.hero-bleed{background-size:cover;background-position:center;background-repeat:no-repeat}
.custom-block .custom-body{max-width:760px;margin-bottom:12px}
.cols{display:grid;gap:24px;align-items:start;grid-template-columns:repeat(var(--ws-cols,2),minmax(0,1fr))}
.cols-1{grid-template-columns:1fr}
.cols-2{grid-template-columns:1fr 1fr}
.cols-3{grid-template-columns:repeat(3,1fr)}
.cols-4{grid-template-columns:repeat(4,1fr)}
.col-cell{min-width:0}
.col-cell h3{color:var(--ws-secondary);margin-bottom:8px;font-size:1.15rem}
.col-cell p{color:#4b5563}
.col-cell .col-html{color:#374151}
.text-block .text-body{max-width:760px;color:#374151}
.text-image-grid{display:grid;grid-template-columns:1fr 1fr;gap:32px;align-items:center}
.text-image-grid.image-left{direction:rtl}
.text-image-grid.image-left>*{direction:ltr}
.cards-grid{display:grid;gap:20px;grid-template-columns:repeat(var(--ws-cols,3),minmax(0,1fr))}
.cards-grid.cols-2{grid-template-columns:1fr 1fr}
.cards-grid.cols-3{grid-template-columns:repeat(3,1fr)}
.cards-grid.cols-4{grid-template-columns:repeat(4,1fr)}
.ws-edit{cursor:text}
${icons}
@media(max-width:760px){
  .grid,.gallery-grid,.contact-grid,.footer-grid,.hero-grid,.cols,.cols-2,.cols-3,.cols-4,.text-image-grid,.cards-grid,.cards-grid.cols-2,.cards-grid.cols-3,.cards-grid.cols-4{grid-template-columns:1fr!important}
  .hero h1{font-size:1.8rem}
  .nav-links a:not(.nav-cta){display:none}
  .nav-item{display:none}
  .nav-sub{position:static;display:none;box-shadow:none;border:0;margin:0;padding:0}
  section.block{padding:40px 0}
}`;
  return (theme.customCss ? `${base}\n${theme.customCss}` : base) + `\n${fontRules}\n${spacingGuardCss()}`;
}

/* ------------------------------------------------------------------ */
/* Batch 135 — SPACING GUARANTEE (renderer floor).                     */
/*                                                                     */
/* Ely's standing rules (text never touches edges, 2026-10-15; cards   */
/* never touch, 2026-10-31) kept regressing because every build        */
/* re-authored its spacing from scratch and nothing measured the       */
/* result. The floor moves the minimums into the platform:             */
/*                                                                     */
/* - The NUMBERS live only in public/css/tokens.css; server/           */
/*   spacingQa.js parses them and both the guard below and the         */
/*   geometry QA check consume the parsed values.                      */
/* - spacingGuardCss() is appended by siteCss AFTER authored CSS in    */
/*   every render path (docShell, injectThemeStyles, pageCombinedCss) */
/*   so the section inset wins the cascade on platform structural      */
/*   selectors — the exact mechanism of Ely's authored rule (28px      */
/*   !important on the band, 22px ≤700px), now platform-enforced on    */
/*   [data-ws-section-type] of ANY element type (the 2026-11-03 root   */
/*   cause was an inset rule that selected only <section>).            */
/*   FINISHER SCOPE (2026-11-04 spacing audit, 655 violations): nav    */
/*   and footer chrome are INSIDE the floor — the original build       */
/*   excluded them and the audit proved that exclusion was the single  */
/*   biggest violation class (288 of 459 section entries at 0px on     */
/*   every export-pipeline site). The selector keeps (0,2,0)           */
/*   specificity via the [data-bp-spacing="off"] opt-out :not, so it   */
/*   beats the authored single-attribute !important zero rules the     */
/*   audit found on real sites; anything stronger is exactly what the  */
/*   QA section-pad measurement fails loudly. Wide tables get a        */
/*   platform treatment too: the guard wraps each table in a           */
/*   .bp-table-scroll overflow-x container (script layer) so a wide    */
/*   table scrolls inside its band at 390 instead of overflowing the   */
/*   page (Berks price tables, +101px before this batch).              */
/*   Full-bleed hero MEDIA is untouched (the floor is padding; the     */
/*   background still paints the full band) — hero TEXT gets inset.    */
/* - spacingGuardScript() is the raise-only second layer for the       */
/*   surfaces CSS cannot express a MINIMUM on without also capping     */
/*   larger authored values: .container inline padding, .card         */
/*   internal padding, grid gaps. It only ever RAISES a computed       */
/*   value that sits below the floor; authored spacing at or above     */
/*   the floor is byte-identical. The one thing neither layer can      */
/*   rescue is authored !important below the floor — that is exactly   */
/*   what the spacing QA check fails loudly with measurements.         */
/*                                                                     */
/* Batch 185: the script also un-clips fixed-height platform cards     */
/*   whose content outgrows the box (unclip), and spacingQa's          */
/*   geometry audit adds content-clip / text-spill / sibling-overlap   */
/*   / text-overlap measurement — design QA (qaSite 'spacing') and an  */
/*   export-time audit of the shipped files (sitesExport stamps       */
/*   spacingAudit + settings['spacing_audit.<id>']). The 135 checks    */
/*   were blind to all three classes Ely recorded on website 52.       */
/* ------------------------------------------------------------------ */

function spacingTokens() {
  try {
    return require('../server/spacingQa').spacingTokens();
  } catch {
    return null;
  }
}

const SPACING_SECTION_SELECTOR = '[data-ws-section-type]:not([data-bp-spacing="off"])';

function spacingGuardCss() {
  const t = spacingTokens();
  if (!t) return '';
  return [
    '/* bitpype spacing guard (Batch 135) — platform minimums; values single-sourced in public/css/tokens.css */',
    `:root{--bp-space-section-inset:${t.sectionInset}px;--bp-space-section-inset-mobile:${t.sectionInsetMobile}px;--bp-space-container-inset:${t.containerInset}px;--bp-space-card-pad:${t.cardPad}px;--bp-space-card-gap:${t.cardGap}px;--bp-space-text-inset:${t.textInset}px}`,
    `${SPACING_SECTION_SELECTOR}{padding-left:var(--bp-space-section-inset)!important;padding-right:var(--bp-space-section-inset)!important}`,
    `@media (max-width:700px){${SPACING_SECTION_SELECTOR}{padding-left:var(--bp-space-section-inset-mobile)!important;padding-right:var(--bp-space-section-inset-mobile)!important}}`,
    'table{max-width:100%}',
    '.bp-table-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;max-width:100%}',
    '.bp-table-scroll>table{width:max-content!important;max-width:none!important;min-width:100%}',
    /* Batch 185 — display-mode guarantee. The renderers emit the
       platform grid containers with an inline grid-template-columns,
       but the display:grid rule lives in the base CSS, which a
       baseCss-off build drops entirely: the container then computes
       to display:block and the cards stack at gap 0 (the 1HP root
       cause, measured 2026-11-13). The guard ships in EVERY render,
       so the display mode is guaranteed here, after authored CSS. */
    '.grid,.cards-grid,.gallery-grid,.contact-grid,.footer-grid,.hero-grid,.cols,.text-image-grid{display:grid}',
    /* The base stylesheet's mobile single-column collapse for those
       same containers (mirrored verbatim) — it vanishes with the
       base CSS too, leaving 3-column grids crushed at 390px with
       card text overflowing its cell into the next card. */
    '@media (max-width:700px){.grid,.cards-grid,.gallery-grid,.contact-grid,.footer-grid,.hero-grid,.cols,.cols-2,.cols-3,.cols-4,.text-image-grid,.cards-grid.cols-2,.cards-grid.cols-3,.cards-grid.cols-4{grid-template-columns:1fr!important}}',
    /* FAQ items keep at least the standard gap under them (the base
       rule used 12px and vanishes with baseCss off; a negative
       authored margin then stacks items into each other). */
    'section[data-ws-section-type="faq"] details{margin-top:0;margin-bottom:var(--bp-space-card-gap)}',
  ].join('\n');
}

/* Batch 148 — per-page layout-knob rules (section width / hide-on-
   mobile; fields defined in src/siteStructure.js). Emitted as their
   own <style data-bp-section-layout="1"> block ONLY when at least one
   section on the page carries a knob, so a knob-free page renders
   byte-identically to the pre-148 renderer. Full-width releases the
   band's direct .container wrapper; the Batch 135 band inset lives on
   the section element itself and is untouched, so text still never
   reaches the screen edge. The release rule deliberately carries NO
   !important: wrappers with their own inline max-width (e.g. a form's
   640px container) keep it, and module internals keep theirs —
   full-width governs the band, exactly like a real full-bleed band.
   Hide-on-mobile uses the platform's 700px breakpoint (the same one
   the spacing guard switches on). */
function sectionLayoutCss(pages) {
  let full = false;
  let hidden = false;
  for (const page of Array.isArray(pages) ? pages : []) {
    for (const s of page && Array.isArray(page.sections) ? page.sections : []) {
      if (!s || typeof s !== 'object') continue;
      if (s.width === 'full') full = true;
      if (s.hideOnMobile === true) hidden = true;
    }
  }
  if (!full && !hidden) return '';
  let css = '';
  if (full) css += '.bp-sec-full>.container{max-width:none}';
  if (hidden) css += '@media (max-width:700px){.bp-sec-nomobile{display:none!important}}';
  return css;
}

function spacingGuardScript() {
  const t = spacingTokens();
  if (!t) return '';
  const body =
    '(function(){try{' +
    `var C=${t.containerInset},P=${t.cardPad},G=${t.cardGap},SI=${t.sectionInset},SIM=${t.sectionInsetMobile},LF=8;` +
    'function up(el,props,f){var cs=getComputedStyle(el);for(var i=0;i<props.length;i++){var v=parseFloat(cs[props[i]]);if(isNaN(v))v=0;if(v<f)el.style[props[i]]=f+"px";}}' +
    'function gap(el){var cs=getComputedStyle(el);if(cs.display!=="grid")return;["columnGap","rowGap"].forEach(function(p){var v=parseFloat(cs[p]);if(isNaN(v))v=0;if(v<G)el.style[p]=G+"px";});}' +
    'function wrapTables(){document.querySelectorAll("table").forEach(function(tbl){if(tbl.closest(".bp-table-scroll"))return;var p=tbl.parentElement;if(!p)return;var w=document.createElement("div");w.className="bp-table-scroll";p.insertBefore(w,tbl);w.appendChild(tbl);});}' +
    // Batch 185: fixed-height rescue — a platform card whose content
    // is taller than its box (authored height + long copy: text
    // clipped away or spilling past the border, Ely's 2026-11-13
    // recording) gets height:auto inline so the box grows to fit.
    // Grid/flex items are left alone (their height is the layout's,
    // not the card's); an authored !important height still wins over
    // the inline style — that residue is what the geometry QA fails
    // loudly with measurements.
    'function unclip(el){var p=el.parentElement;if(p){var pd=getComputedStyle(p).display;if(/grid|flex/.test(pd))return;}if(el.scrollHeight>el.clientHeight+1)el.style.height="auto";}' +
    // Batch 186: chrome floor — nav/header/footer bands. Batch 185's
    // floor covered module surfaces, but authored chrome shipped the
    // same two defects twice (1HP, then Chefmom, Ely's one-pass test):
    // the header inset sat on an inner bar while the BAND itself
    // carried none, and footer link groups were inline anchors
    // separated by <br> that wrapped into each other in the tablet
    // column. Both are fixed here by MEASURED top-up, never blind
    // addition: every text glyph inside a chrome band must clear its
    // component box (the same box spacingQa measures) by the card
    // floor on all sides, and the band root itself must clear the
    // section-inset law (28 desktop / 22 mobile) horizontally — the
    // inset ends up ON the band, per Ely's standing rule. A band
    // that already meets the law gets no inline style at all.
    // Footer (and mobile nav) inline anchor runs are stacked as
    // block lists with at least an 8px rhythm, so they cannot wrap
    // into each other at any width; a flex/grid parent (the desktop
    // header row) is never stacked.
    'function boxLike(el){var cs=getComputedStyle(el);var bg=cs.backgroundColor;var hasBg=!!bg&&bg!=="transparent"&&!/rgba\\(\\s*0,\\s*0,\\s*0,\\s*0\\s*\\)/.test(bg);var bw=Math.max(parseFloat(cs.borderTopWidth)||0,parseFloat(cs.borderRightWidth)||0,parseFloat(cs.borderBottomWidth)||0,parseFloat(cs.borderLeftWidth)||0);return hasBg||(bw>0&&cs.borderStyle!=="none"&&cs.borderStyle!=="hidden")||el.classList.contains("card")||el.classList.contains("review-card");}' +
    'function nearestBox(el,root){for(var n=el;n&&n.nodeType===1;n=n.parentElement){var tag=n.tagName;if(tag==="TD"||tag==="TH"||tag==="TABLE")return null;var cand=tag!=="BUTTON"&&tag!=="A"&&tag!=="LI"&&(boxLike(n)||n.matches("details,.col-cell,.cta-band"));if(cand){var cs=getComputedStyle(n);var r=n.getBoundingClientRect();if(r.width>=120&&r.height>=40&&cs.display.indexOf("inline")<0&&cs.display!=="none")return n;}if((n.hasAttribute&&n.hasAttribute("data-ws-section-type"))||n===root)return null;}return null;}' +
    'function chromeRoots(){var roots=[];document.querySelectorAll("[data-ws-section-type]").forEach(function(el){var k=el.getAttribute("data-ws-section-type");if(k!=="nav"&&k!=="footer")return;if(el.getAttribute("data-bp-spacing")==="off")return;roots.push({el:el,kind:k});});document.querySelectorAll("body>header,body>footer").forEach(function(el){if(el.hasAttribute("data-ws-section-type")||el.getAttribute("data-bp-spacing")==="off")return;roots.push({el:el,kind:el.tagName==="HEADER"?"nav":"footer"});});return roots;}' +
    'function topUpBox(box,e,band){var cs=getComputedStyle(box);var br=box.getBoundingClientRect();var pl=br.left+(parseFloat(cs.borderLeftWidth)||0),pr=br.right-(parseFloat(cs.borderRightWidth)||0),pt=br.top+(parseFloat(cs.borderTopWidth)||0),pb=br.bottom-(parseFloat(cs.borderBottomWidth)||0);var fH=band?(window.innerWidth>700?SI:SIM):P;var dL=fH-(e.l-pl),dR=fH-(pr-e.r),dT=P-(e.t-pt),dB=P-(pb-e.b);if(dL>0)box.style.paddingLeft=((parseFloat(cs.paddingLeft)||0)+Math.ceil(dL))+"px";if(dR>0)box.style.paddingRight=((parseFloat(cs.paddingRight)||0)+Math.ceil(dR))+"px";if(dT>0)box.style.paddingTop=((parseFloat(cs.paddingTop)||0)+Math.ceil(dT))+"px";if(dB>0)box.style.paddingBottom=((parseFloat(cs.paddingBottom)||0)+Math.ceil(dB))+"px";}' +
    'function chromeFloorPass(root){var boxes=new Map();var walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);var node;while((node=walker.nextNode())){if(!node.nodeValue||!/\\S/.test(node.nodeValue))continue;var p=node.parentElement;if(!p)continue;if(p.closest(\'details:not([open])\'))continue;if(p.closest(\'[data-bp-spacing="off"]\'))continue;var pcs=getComputedStyle(p);if(pcs.display==="none"||pcs.visibility==="hidden")continue;var box=nearestBox(p,root);if(!box)continue;var range=document.createRange();range.selectNodeContents(node);var rects=range.getClientRects();for(var i=0;i<rects.length;i++){var r=rects[i];if(!r.width||!r.height)continue;var e=boxes.get(box);if(!e){e={l:1e9,r:-1e9,t:1e9,b:-1e9};boxes.set(box,e);}if(r.left<e.l)e.l=r.left;if(r.right>e.r)e.r=r.right;if(r.top<e.t)e.t=r.top;if(r.bottom>e.b)e.b=r.bottom;}}boxes.forEach(function(e,box){topUpBox(box,e,box===root||box.parentElement===root);});}' +
    'function stackLinks(root){var parents=new Set();root.querySelectorAll("a").forEach(function(a){if(a.parentElement)parents.add(a.parentElement);});parents.forEach(function(parent){var pcs=getComputedStyle(parent);if(pcs.display==="flex"||pcs.display==="grid"||pcs.display==="inline-flex"||pcs.display==="inline-grid")return;var kids=parent.childNodes,run=[];function flush(){if(run.length>=2){var vis=run.filter(function(a){var r=a.getBoundingClientRect();return r.width>0&&r.height>0&&/\\S/.test(a.textContent);});if(vis.length>=2&&vis.every(function(a){return getComputedStyle(a).display==="inline";})){vis.forEach(function(a){a.style.display="block";});for(var i=1;i<vis.length;i++){var prev=vis[i-1].getBoundingClientRect(),cur=vis[i].getBoundingClientRect();var gp=cur.top-prev.bottom;if(gp<LF){var mt=parseFloat(getComputedStyle(vis[i]).marginTop)||0;vis[i].style.marginTop=(mt+(LF-gp))+"px";}}}}run=[];}for(var i=0;i<kids.length;i++){var k=kids[i];if(k.nodeType===1&&k.tagName==="A")run.push(k);else if(k.nodeType===1&&k.tagName==="BR")continue;else if(k.nodeType===3&&!/\\S/.test(k.nodeValue))continue;else flush();}flush();});}' +
    'function chromePass(){chromeRoots().forEach(function(root){if(root.kind==="footer"||window.innerWidth<=700)stackLinks(root.el);chromeFloorPass(root.el);chromeFloorPass(root.el);});}' +
    'function run(){' +
    'document.querySelectorAll(".container,.nav-inner,.footer-grid").forEach(function(el){up(el,["paddingLeft","paddingRight"],C);});' +
    'document.querySelectorAll(".card,.review-card,.col-cell").forEach(function(el){up(el,["paddingTop","paddingRight","paddingBottom","paddingLeft"],P);});' +
    'document.querySelectorAll(".card,.review-card").forEach(function(el){unclip(el);});' +
    'document.querySelectorAll(".grid,.cards-grid,.gallery-grid,.footer-grid,.contact-grid,.cols").forEach(gap);' +
    'chromePass();' +
    'wrapTables();' +
    '}' +
    'if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",run);else run();' +
    '}catch(e){}})();';
  return `<script data-ws-spacing-guard="1">${body}</script>`;
}

/** Add the spacing-guard script to a full document that did not pass
 * through docShell (the freeform full-document render path). */
function injectSpacingGuardScript(docHtml) {
  let doc = String(docHtml || '');
  if (!doc.trim() || /data-ws-spacing-guard\s*=\s*["']1["']/.test(doc)) return doc;
  const tag = spacingGuardScript();
  if (!tag) return doc;
  if (/<\/body>/i.test(doc)) return doc.replace(/<\/body>/i, `${tag}\n</body>`);
  return `${doc}\n${tag}`;
}

/* ------------------------------------------------------------------ */
/* component library — pure render functions                           */
/*                                                                    */
/* section = { type, content }. Every function is total: missing       */
/* content degrades to a safe fallback, never throws.                  */
/* ------------------------------------------------------------------ */

const COMPONENT_TYPES = [
  'nav',
  'hero',
  'benefits',
  'services',
  'about',
  'gallery',
  'reviews',
  'cta',
  'contact_form',
  'bitpype_form',
  'form',
  'map_placeholder',
  'hours',
  'faq',
  'footer',
  'booking_button',
  'social_links',
  'custom',
  'html',
  // Layout modules (Elementor-style composition; freeform HTML lives inside cells)
  'columns',
  'text',
  'text_image',
  'cards',
];

/** Insertable layout / content blocks for portal + MCP (excludes pinned chrome). */
const LAYOUT_SECTION_TYPES = [
  { type: 'heading', label: 'Heading' },
  { type: 'text', label: 'Text' },
  { type: 'image', label: 'Image' },
  { type: 'columns', label: 'Columns', cols: [1, 2, 3, 4, 5, 6] },
  { type: 'text_image', label: 'Text + image' },
  { type: 'cards', label: 'Cards' },
  { type: 'html', label: 'HTML block' },
  { type: 'hero', label: 'Hero' },
  { type: 'benefits', label: 'Benefits' },
  { type: 'services', label: 'Services' },
  { type: 'about', label: 'About' },
  { type: 'gallery', label: 'Gallery' },
  { type: 'reviews', label: 'Reviews' },
  { type: 'cta', label: 'CTA' },
  { type: 'faq', label: 'FAQ' },
  { type: 'custom', label: 'Custom' },
];

/** CSS / attribute markers for freeform design-module roots (edit canvas). */
const DESIGN_MODULE_CLASS_HINTS = [
  'layout-columns',
  'text-block',
  'text-image',
  'layout-cards',
  'ws-html-block',
  'ws-design-heading',
  'ws-design-image',
  'ws-design-module',
  'custom-block',
];

/** Safe link for CTAs: https, http, tel, mailto, hash, or site-relative path. */
function safeHref(url) {
  if (typeof url !== 'string') return '#';
  const u = url.trim();
  if (!u) return '#';
  if (/^(https?:|tel:|mailto:|#|\/|\.\/|\.\.\/)/i.test(u)) return u;
  return '#';
}

function editSpan(edit, path, text) {
  const raw = text == null ? '' : String(text);
  const id = edit ? `${edit.page}:${edit.section}:${path}` : '';
  const family = id && edit && edit.fonts ? edit.fonts[id] : '';
  const stack = family ? googleFonts.stackFor(family) : '';
  const style = stack ? ` style="font-family:${esc(stack)}"` : '';
  if (!edit || !edit.editing) {
    return style ? `<span${style}>${esc(raw)}</span>` : esc(raw);
  }
  return `<span class="ws-edit" data-edit="${esc(id)}"${style}>${esc(raw)}</span>`;
}

function safeHttps(url) {
  return typeof url === 'string' && url.startsWith('https://');
}

/** https or local export paths (images/… or assets/…) for photos / CSS backgrounds. */
function safeImageUrl(url) {
  if (typeof url !== 'string') return '';
  const u = url.trim().slice(0, 500);
  if (!u) return '';
  if (/^https:\/\//i.test(u)) return u;
  if (/^(?:\.\/)?(?:images|assets)\/[A-Za-z0-9._/-]+$/i.test(u)) return u.replace(/^\.\//, '');
  if (/^\/(?:images|assets)\/[A-Za-z0-9._/-]+$/i.test(u)) return u.slice(1);
  return '';
}

/** Parse "16:9" / number → CSS aspect-ratio value, or ''. */
function aspectCssValue(aspect) {
  try {
    const imageCrop = require('./imageCrop');
    const n = imageCrop.parseAspect(aspect);
    if (!n) return '';
    if (typeof aspect === 'string' && /^\d+(?:\.\d+)?\s*[:/x]\s*\d+/i.test(aspect)) {
      return String(aspect).trim().replace(/\s+/g, '').replace(/[xX/]/, ' / ');
    }
    return String(n);
  } catch {
    return '';
  }
}

function creditHtml(im) {
  if (!im || !im.photographer) return '';
  const name =
    im.photographer_url && safeHttps(im.photographer_url)
      ? `<a href="${esc(im.photographer_url)}" rel="noopener noreferrer" target="_blank">${esc(im.photographer)}</a>`
      : esc(im.photographer);
  const on =
    im.pexels_url && safeHttps(im.pexels_url)
      ? `<a href="${esc(im.pexels_url)}" rel="noopener noreferrer" target="_blank">Pexels</a>`
      : 'Pexels';
  return `<figcaption class="photo-credit">Photo by ${name} on ${on}</figcaption>`;
}

function photoFigure(im, className) {
  const src = im && safeImageUrl(im.url);
  if (!src) return '';
  const pexelsHost = /pexels\.com/i.test(src);
  const credit =
    creditHtml(im) ||
    (pexelsHost
      ? `<figcaption class="photo-credit">Photo via <a href="https://www.pexels.com" rel="noopener noreferrer" target="_blank">Pexels</a></figcaption>`
      : '');
  const crop = im && im.crop && typeof im.crop === 'object' ? im.crop : null;
  const figStyle = [];
  const imgStyle = [];
  const imgAttrs = [];
  if (crop) {
    const ar = aspectCssValue(crop.aspect);
    if (ar) figStyle.push(`aspect-ratio:${ar}`);
    const fx = crop.focalX != null ? Number(crop.focalX) : crop.focal_x != null ? Number(crop.focal_x) : 0.5;
    const fy = crop.focalY != null ? Number(crop.focalY) : crop.focal_y != null ? Number(crop.focal_y) : 0.5;
    const px = Number.isFinite(fx) ? Math.round(Math.max(0, Math.min(1, fx)) * 100) : 50;
    const py = Number.isFinite(fy) ? Math.round(Math.max(0, Math.min(1, fy)) * 100) : 50;
    imgStyle.push('width:100%', 'height:100%', 'object-fit:cover', `object-position:${px}% ${py}%`);
    if (crop.width) imgAttrs.push(`width="${esc(String(Math.round(Number(crop.width))))}"`);
    if (crop.height) imgAttrs.push(`height="${esc(String(Math.round(Number(crop.height))))}"`);
  }
  const figAttr = figStyle.length ? ` style="${figStyle.join(';')}"` : '';
  const imgStyleAttr = imgStyle.length ? ` style="${imgStyle.join(';')}"` : '';
  const extra = imgAttrs.length ? ` ${imgAttrs.join(' ')}` : '';
  return `<figure class="${className}"${figAttr}><img src="${esc(src)}" alt="${esc(im.alt || '')}"${imgStyleAttr}${extra}>${credit}</figure>`;
}

/** Resolve background image from content.backgroundImage / .background / image.url. */
function contentBackgroundImageUrl(content) {
  if (!content || typeof content !== 'object') return '';
  if (typeof content.backgroundImage === 'string') return safeImageUrl(content.backgroundImage);
  if (typeof content.background_image === 'string') return safeImageUrl(content.background_image);
  if (content.background && typeof content.background === 'object') {
    return safeImageUrl(content.background.url || content.background.src || '');
  }
  if (typeof content.background === 'string' && /\.(jpe?g|png|webp|gif)(\?|$)/i.test(content.background)) {
    return safeImageUrl(content.background);
  }
  return '';
}

function contentBackgroundColor(content) {
  if (!content || typeof content !== 'object') return '';
  const raw =
    content.backgroundColor ||
    content.background_color ||
    content.bg ||
    (typeof content.background === 'string' && !/\.(jpe?g|png|webp|gif)/i.test(content.background)
      ? content.background
      : '');
  if (typeof raw !== 'string') return '';
  const s = raw.trim().slice(0, 120);
  if (/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(s)) return s;
  if (/^(rgb|rgba|hsl|hsla)\(/i.test(s)) return s.replace(/[<>]/g, '');
  if (/^linear-gradient\(/i.test(s)) return s.replace(/[<>]/g, '').slice(0, 300);
  return '';
}

function renderNavLinkTree(links) {
  const items = Array.isArray(links) ? links : [];
  return items
    .map((l) => {
      const kids = Array.isArray(l.children) ? l.children : [];
      if (!kids.length) {
        return `<a href="${esc(l.href || '#')}">${esc(l.label || '')}</a>`;
      }
      const sub = kids.map((c) => `<a href="${esc(c.href || '#')}">${esc(c.label || '')}</a>`).join('');
      return `<span class="nav-item has-children"><a href="${esc(l.href || '#')}">${esc(l.label || '')}</a><span class="nav-sub">${sub}</span></span>`;
    })
    .join('');
}

function cNav(c = {}, t, edit) {
  // Freestyle header chrome from the agent (original branded nav / top bar).
  if (typeof c.html === 'string' && c.html.trim()) {
    return `<div class="ws-nav-chrome">${markEditableSectionHtml(c.html, edit)}</div>`;
  }
  const links = Array.isArray(c.links) ? c.links : [];
  const phone = digitsOnly(c.phone);
  return `<nav class="nav"><div class="nav-inner">
    ${brandMarkup(c, t)}
    <div class="nav-links">
      ${renderNavLinkTree(links)}
      ${phone ? `<a class="nav-cta" href="tel:${phone}">${esc(c.phone_display || c.phone)}</a>` : ''}
    </div></div></nav>`;
}

function cHero(c = {}, t, edit) {
  const rating =
    c.rating && c.review_count
      ? `<div class="rating-badge">★ ${esc(String(c.rating))} · ${esc(String(c.review_count))} customer reviews</div>`
      : '';
  const hasBg = !!contentBackgroundImageUrl(c);
  // Side photo only when not already using a full-bleed background image.
  const photo = hasBg ? '' : photoFigure(c.image, 'hero-photo');
  const bleed = hasBg ? ' hero-bleed' : '';
  return `<header class="hero${bleed}"><div class="container${photo ? ' hero-grid' : ''}"><div>
    ${rating}
    <h1>${editSpan(edit, 'headline', c.headline || 'Welcome')}</h1>
    ${c.subheadline ? `<p>${editSpan(edit, 'subheadline', c.subheadline)}</p>` : ''}
    <div>${c.cta_text ? `<a class="btn" href="${esc(safeHref(c.cta_href || '#contact'))}">${editSpan(edit, 'cta_text', c.cta_text)}</a>` : ''}
    ${c.cta_secondary_text ? `<a class="btn btn-outline" href="${esc(safeHref(c.cta_secondary_href || '#services'))}">${editSpan(edit, 'cta_secondary_text', c.cta_secondary_text)}</a>` : ''}</div>
  </div>${photo}</div></header>`;
}

function listAddButton(edit, listKey, label) {
  if (!edit || !edit.editing) return '';
  return `<button type="button" class="ws-add-item" data-ws-add="section" data-ws-page="${Number(edit.page)}" data-ws-section="${Number(edit.section)}" data-ws-list="${esc(listKey)}">${esc(label || '+ Add item')}</button>`;
}

function listDeleteButton(edit, listKey, index) {
  if (!edit || !edit.editing) return '';
  return `<button type="button" class="ws-del-item" title="Remove" aria-label="Remove item" data-ws-del="section" data-ws-page="${Number(edit.page)}" data-ws-section="${Number(edit.section)}" data-ws-list="${esc(listKey)}" data-ws-index="${Number(index)}">×</button>`;
}

function wrapListItem(edit, listKey, index, innerHtml) {
  if (!edit || !edit.editing) return innerHtml;
  return `<div class="ws-list-item" data-ws-item="${Number(index)}">${listDeleteButton(edit, listKey, index)}${innerHtml}</div>`;
}

function itemIconHtml(it, fallbackLabel) {
  const name = it && it.icon;
  if (!name || !siteIcons.isKnownIcon(name)) return '';
  const svg = siteIcons.renderIconSvg(name, { label: fallbackLabel || name });
  return svg ? `<div class="ws-icon-wrap chip ws-icon-chip">${svg}</div>` : '';
}

function cBenefits(c = {}, t, edit) {
  const items = Array.isArray(c.items) ? c.items : [];
  if (!items.length && !edit) return '';
  return `<section class="block"><div class="container">
    ${c.title ? `<h2>${editSpan(edit, 'title', c.title)}</h2>` : ''}
    ${c.subtitle ? `<p class="lede">${editSpan(edit, 'subtitle', c.subtitle)}</p>` : ''}
    <div class="grid" data-ws-list="items">${items
      .map((it, i) =>
        wrapListItem(
          edit,
          'items',
          i,
          `<div class="card">${itemIconHtml(it, it.title) || `<div class="chip">${i + 1}</div>`}<h3>${editSpan(edit, `items.${i}.title`, it.title || '')}</h3><p>${editSpan(edit, `items.${i}.text`, it.text || '')}</p></div>`
        )
      )
      .join('')}</div>${listAddButton(edit, 'items', '+ Add card')}</div></section>`;
}

function cServices(c = {}, t, edit) {
  const items = Array.isArray(c.items) ? c.items : [];
  if (!items.length && !edit) return '';
  return `<section class="block page-anchor" id="services"><div class="container">
    ${c.title ? `<h2>${editSpan(edit, 'title', c.title)}</h2>` : '<h2>Our Services</h2>'}
    ${c.subtitle ? `<p class="lede">${editSpan(edit, 'subtitle', c.subtitle)}</p>` : ''}
    <div class="grid" data-ws-list="items">${items
      .map((it, i) =>
        wrapListItem(
          edit,
          'items',
          i,
          `<div class="card">${itemIconHtml(it, it.name)}<h3>${editSpan(edit, `items.${i}.name`, it.name || '')}</h3><p>${editSpan(edit, `items.${i}.description`, it.description || '')}</p></div>`
        )
      )
      .join('')}</div>${listAddButton(edit, 'items', '+ Add service')}</div></section>`;
}

function cAbout(c = {}, t, edit) {
  const paras = Array.isArray(c.paragraphs) ? c.paragraphs : [];
  if (!c.title && !paras.length) return '';
  return `<section class="block about"><div class="container">
    ${c.title ? `<h2>${editSpan(edit, 'title', c.title)}</h2>` : ''}
    ${paras.map((p, i) => `<p>${editSpan(edit, `paragraphs.${i}`, p)}</p>`).join('')}
  </div></section>`;
}

const GALLERY_GRADIENTS = [
  'linear-gradient(135deg,#667eea,#764ba2)',
  'linear-gradient(135deg,#f093fb,#f5576c)',
  'linear-gradient(135deg,#4facfe,#00f2fe)',
  'linear-gradient(135deg,#43e97b,#38f9d7)',
  'linear-gradient(135deg,#fa709a,#fee140)',
  'linear-gradient(135deg,#30cfd0,#330867)',
];

function cGallery(c = {}, t, edit) {
  const images = (Array.isArray(c.images) ? c.images : []).slice(0, 6);
  const slots = images.length
    ? images
    : [{ caption: 'Your photo here' }, { caption: 'Your photo here' }, { caption: 'Your photo here' }];
  return `<section class="block"><div class="container">
    ${c.title ? `<h2>${editSpan(edit, 'title', c.title)}</h2>` : `<h2>${editSpan(edit, 'title', 'Gallery')}</h2>`}
    ${c.subtitle ? `<p class="lede">${editSpan(edit, 'subtitle', c.subtitle)}</p>` : ''}
    <div class="gallery-grid">${slots
      .map((im, i) => {
        const fig = photoFigure(im, 'photo');
        if (fig) return fig;
        return `<div class="ph" style="background:${GALLERY_GRADIENTS[i % GALLERY_GRADIENTS.length]}" role="img" aria-label="${esc(im.caption || 'Gallery image')}">${editSpan(edit, `images.${i}.caption`, im.caption || 'Your photo here')}</div>`;
      })
      .join('')}</div></div></section>`;
}

function cReviews(c = {}, t, edit) {
  const reviews = Array.isArray(c.reviews) ? c.reviews : [];
  if (!reviews.length && !edit) return '';
  return `<section class="block"><div class="container">
    ${c.title ? `<h2>${editSpan(edit, 'title', c.title || 'What Customers Say')}</h2>` : `<h2>${editSpan(edit, 'title', 'What Customers Say')}</h2>`}
    ${c.subtitle ? `<p class="lede">${editSpan(edit, 'subtitle', c.subtitle)}</p>` : ''}
    <div class="grid" data-ws-list="reviews">${reviews
      .map((r, i) => {
        const stars = Math.max(1, Math.min(5, Number(r.stars) || 5));
        return wrapListItem(
          edit,
          'reviews',
          i,
          `<div class="card review-card"><div class="stars">${'★'.repeat(stars)}${'☆'.repeat(5 - stars)}</div>
        <p>“${editSpan(edit, `reviews.${i}.text`, r.text || '')}”</p><div class="who">— ${editSpan(edit, `reviews.${i}.name`, r.name || 'Customer')}</div></div>`
        );
      })
      .join('')}</div>${listAddButton(edit, 'reviews', '+ Add review')}</div></section>`;
}

function cCta(c = {}, t, edit) {
  return `<section class="block"><div class="container"><div class="cta-band">
    <h2>${editSpan(edit, 'title', c.title || 'Get in touch today')}</h2>
    ${c.text ? `<p>${editSpan(edit, 'text', c.text)}</p>` : ''}
    ${c.button_text ? `<a class="btn" href="${esc(safeHref(c.button_href || '#contact'))}">${editSpan(edit, 'button_text', c.button_text)}</a>` : ''}
  </div></div></section>`;
}

function cContactForm(c = {}, t) {
  const email = String(c.email || '').trim();
  const phone = digitsOnly(c.phone);
  const formAction = String(c.form_action || '').trim();
  const formToken = String(c.form_token || '').trim();
  const embedHtml = typeof c.bitpype_embed_html === 'string' ? c.bitpype_embed_html.trim() : '';
  const suppressFields = !!c.suppress_fields || !!embedHtml;
  if (!email && !phone && !formAction && !formToken && !embedHtml) return '';
  const useBitpype = !!(formAction || formToken);
  const action = useBitpype
    ? formAction || '#'
    : email
      ? `mailto:${esc(email)}?subject=${encodeURIComponent(c.mailto_subject || 'Website inquiry')}`
      : '#';
  const method = useBitpype ? 'post' : 'post';
  const bitpypeAttrs = useBitpype
    ? ` data-bitpype-form="1" data-form-token="${esc(formToken)}" enctype="application/x-www-form-urlencoded"`
    : ' enctype="text/plain"';
  const formBlock = suppressFields
    ? embedHtml
      ? sanitizeHtml(embedHtml)
      : ''
    : `<form action="${esc(action)}" method="${method}"${bitpypeAttrs}${useBitpype ? ' onsubmit="return window.__bitpypeSubmitForm ? window.__bitpypeSubmitForm(event,this) : true"' : ''}>
        <div class="field"><label for="cf-name">Name</label><input id="cf-name" name="name" required></div>
        <div class="field"><label for="cf-phone">Phone</label><input id="cf-phone" name="phone" type="tel"></div>
        <div class="field"><label for="cf-email">Email</label><input id="cf-email" name="email" type="email" required></div>
        <div class="field"><label for="cf-msg">Message</label><textarea id="cf-msg" name="message" rows="5" required></textarea></div>
        <button class="btn btn-primary" type="submit">Send Message</button>
      </form>`;
  return `<section class="block page-anchor" id="contact"><div class="container">
    ${c.title ? `<h2>${esc(c.title)}</h2>` : '<h2>Contact Us</h2>'}
    ${c.text ? `<p class="lede">${esc(c.text)}</p>` : ''}
    <div class="contact-grid"><div>
      ${formBlock}</div>
      <div>
        ${phone ? `<p style="margin-bottom:12px"><strong>Phone:</strong> <a href="tel:${phone}">${esc(c.phone)}</a></p>` : ''}
        ${email ? `<p style="margin-bottom:12px"><strong>Email:</strong> <a href="mailto:${esc(email)}">${esc(email)}</a></p>` : ''}
        ${c.address ? `<p><strong>Address:</strong><br>${esc(c.address)}</p>` : ''}
      </div>
    </div></div></section>`;
}

function cMapPlaceholder(c = {}, t) {
  const lines = Array.isArray(c.address_lines) ? c.address_lines : c.address ? [c.address] : [];
  if (!lines.length) return '';
  return `<section class="block"><div class="container">
    ${c.title ? `<h2>${esc(c.title)}</h2>` : '<h2>Find Us</h2>'}
    <div class="mapbox"><div class="pin">📍</div>
      ${lines.map((l) => `<div><strong>${esc(l)}</strong></div>`).join('')}
    </div></div></section>`;
}

function cHours(c = {}, t) {
  const hours = Array.isArray(c.hours) ? c.hours : [];
  if (!hours.length) return '';
  return `<section class="block"><div class="container">
    ${c.title ? `<h2>${esc(c.title)}</h2>` : '<h2>Business Hours</h2>'}
    <table class="hours-table"><tbody>
      ${hours.map((h) => `<tr><td>${esc(h.day || '')}</td><td>${esc(h.open || '')} – ${esc(h.close || '')}</td></tr>`).join('')}
    </tbody></table></div></section>`;
}

function cFaq(c = {}, t, edit) {
  const items = Array.isArray(c.items) ? c.items : [];
  if (!items.length && !edit) return '';
  return `<section class="block faq"><div class="container">
    ${c.title ? `<h2>${editSpan(edit, 'title', c.title)}</h2>` : '<h2>Frequently Asked Questions</h2>'}
    <div data-ws-list="items">${items
      .map((it, i) =>
        wrapListItem(
          edit,
          'items',
          i,
          `<details><summary>${editSpan(edit, `items.${i}.q`, it.q || '')}</summary><p>${editSpan(edit, `items.${i}.a`, it.a || '')}</p></details>`
        )
      )
      .join('')}</div>${listAddButton(edit, 'items', '+ Add question')}
  </div></section>`;
}

function cFooter(c = {}, t, edit) {
  // Freestyle footer chrome from the agent (original branded footer).
  if (typeof c.html === 'string' && c.html.trim()) {
    return `<div class="ws-footer-chrome">${markEditableSectionHtml(c.html, edit)}</div>`;
  }
  const year = new Date().getFullYear();
  // Use page-slug hashes; rewriteAnchorLinksToFiles converts these to *.html on multipage export.
  return `<footer class="footer"><div class="footer-grid">
    <div><h4>${esc(c.business_name || 'Business')}</h4>
      ${c.tagline ? `<p>${esc(c.tagline)}</p>` : ''}</div>
    <div><h4>Contact</h4>
      ${c.phone ? `<p>Phone: <a href="tel:${digitsOnly(c.phone)}">${esc(c.phone)}</a></p>` : ''}
      ${c.email ? `<p>Email: <a href="mailto:${esc(c.email)}">${esc(c.email)}</a></p>` : ''}
      ${c.address ? `<p>${esc(c.address)}</p>` : ''}</div>
    <div><h4>Quick Links</h4>
      <p><a href="#home">Home</a> · <a href="#about">About</a> · <a href="#services">Services</a> · <a href="#contact">Contact</a></p></div>
  </div>
  <div class="copyright">© ${year} ${esc(c.business_name || 'Business')}. All rights reserved.</div></footer>`;
}

function cBookingButton(c = {}, t) {
  const phone = digitsOnly(c.href && String(c.href).startsWith('tel:') ? c.href : c.phone);
  const href = c.href || (phone ? `tel:${phone}` : '#contact');
  return `<section class="block booking"><div class="container">
    ${c.title ? `<h2 style="margin-bottom:16px">${esc(c.title)}</h2>` : ''}
    <a class="big-call" href="${esc(href)}">${esc(c.text || 'Call Now')}</a>
    ${c.subtext ? `<p style="margin-top:12px;color:#4b5563">${esc(c.subtext)}</p>` : ''}
  </div></section>`;
}

function cCustom(c = {}, t, edit) {
  const heading = c.heading || c.title || '';
  const body = c.body || c.text || '';
  const button = c.button && typeof c.button === 'object' ? c.button : null;
  const photo = photoFigure(c.image, 'photo');
  // Freeform HTML fragment from the agent (scripts stripped).
  if (typeof c.html === 'string' && c.html.trim()) {
    return markEditableSectionHtml(c.html, edit);
  }
  if (!heading && !body && !photo && !(button && button.text)) return '';
  const href = button ? safeHref(button.href) : '#';
  return `<section class="block custom-block"><div class="container">
    ${heading ? `<h2>${editSpan(edit, 'heading', heading)}</h2>` : ''}
    ${body ? `<p class="custom-body">${editSpan(edit, 'body', body)}</p>` : ''}
    ${photo}
    ${button && button.text ? `<p><a class="btn btn-primary" href="${esc(href)}">${editSpan(edit, 'button.text', button.text)}</a></p>` : ''}
  </div></section>`;
}

function cHtml(c = {}, t, edit) {
  const raw =
    typeof c.html === 'string' && c.html.trim()
      ? c.html
      : typeof c.markup === 'string' && c.markup.trim()
        ? c.markup
        : '';
  const inner = raw ? markEditableSectionHtml(raw, edit) : '';
  if (!inner) return '';
  // Wrapper so section className / data-ws-* decorate a stable root, not the first inner tag.
  return `<div class="ws-html-block ws-design-module" data-ws-design-module="1">${inner}</div>`;
}

/** Practical column clamp for layout grids (1–12). */
function clampCols(n, fallback = 3) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return fallback;
  return Math.max(1, Math.min(12, v));
}

/** Grid style that works for any column count (not only .cols-1..4). */
function colsGridStyle(cols) {
  const n = clampCols(cols, 2);
  return `grid-template-columns:repeat(${n},minmax(0,1fr))`;
}

/** Render one column cell: text, image, card, module/form widget, or raw html. */
function renderColCell(cell, edit, pathPrefix) {
  const c = cell && typeof cell === 'object' ? cell : {};
  const p = pathPrefix || '';
  // Native module/form-in-cell (no body CSS hacks required).
  if (c.widget && typeof c.widget === 'object') {
    const w = c.widget;
    const wt = String(w.type || w.blockType || '').toLowerCase();
    let inner = '';
    if (wt === 'form' || wt === 'bitpype_form') {
      inner = cBitpypeForm(w);
    } else if (wt === 'site_module' || wt === 'module' || wt === 'widget') {
      inner = cSiteModule(w);
    } else if (typeof w.html === 'string' && w.html.trim()) {
      inner = sanitizeHtml(w.html);
    }
    if (inner) {
      return `<div class="col-cell col-widget" data-ws-layout-cell="1" data-ws-cell-widget="${esc(wt || 'widget')}">${inner}</div>`;
    }
  }
  if (typeof c.html === 'string' && c.html.trim()) {
    // Column cells are not top-level sections — keep sanitized only (no edit ids).
    return `<div class="col-cell col-html" data-ws-layout-cell="1">${sanitizeHtml(c.html)}</div>`;
  }
  const heading = c.heading || c.title || '';
  const body = c.body || c.text || '';
  const photo = photoFigure(c.image || (c.crop ? { url: c.url, alt: c.alt, crop: c.crop } : null), 'photo');
  const button = c.button && typeof c.button === 'object' ? c.button : null;
  if (!heading && !body && !photo && !(button && button.text)) {
    return '<div class="col-cell" data-ws-layout-cell="1"></div>';
  }
  return `<div class="col-cell" data-ws-layout-cell="1">
    ${heading ? `<h3>${editSpan(edit, `${p}heading`, heading)}</h3>` : ''}
    ${body ? `<p>${editSpan(edit, `${p}body`, body)}</p>` : ''}
    ${photo}
    ${
      button && button.text
        ? `<p><a class="btn btn-primary" href="${esc(safeHref(button.href))}">${editSpan(edit, `${p}button.text`, button.text)}</a></p>`
        : ''
    }
  </div>`;
}

/** Standalone heading design module. */
function cHeading(c = {}, t, edit) {
  const text = c.heading || c.title || c.text || 'Heading';
  const level = [1, 2, 3, 4].includes(Number(c.level)) ? Number(c.level) : 2;
  const tag = `h${level}`;
  return (
    `<section class="block ws-design-heading ws-design-module" data-ws-design-module="1"><div class="container">` +
    `<${tag}>${editSpan(edit, 'heading', text)}</${tag}></div></section>`
  );
}

/** Standalone image design module. */
function cImage(c = {}, t, edit) {
  void edit;
  const photo =
    photoFigure(c.image, 'photo') ||
    '<div class="ph" style="background:linear-gradient(135deg,#e5e7eb,#d1d5db);min-height:180px;border-radius:8px" role="img" aria-label="Image"></div>';
  const caption = c.caption || c.alt || '';
  return (
    `<section class="block ws-design-image ws-design-module" data-ws-design-module="1"><div class="container">` +
    `${photo}` +
    (caption ? `<p class="lede">${esc(caption)}</p>` : '') +
    `</div></section>`
  );
}

/** Column layout module (1–12 columns via CSS grid). */
function cColumns(c = {}, t, edit) {
  const cols = clampCols(c.cols != null ? c.cols : c.columns_count, 2);
  let cells = Array.isArray(c.cells) ? c.cells : Array.isArray(c.columns) ? c.columns : [];
  if (!cells.length) {
    cells = Array.from({ length: cols }, () => ({ heading: 'Column', body: 'Add your content.' }));
  }
  while (cells.length < cols) cells.push({ heading: '', body: '' });
  cells = cells.slice(0, Math.max(cols, cells.length));
  return `<section class="block layout-columns ws-design-module" data-ws-design-module="1" data-ws-block="columns"><div class="container">
    ${c.title ? `<h2>${editSpan(edit, 'title', c.title)}</h2>` : ''}
    ${c.subtitle ? `<p class="lede">${editSpan(edit, 'subtitle', c.subtitle)}</p>` : ''}
    <div class="cols cols-${cols}" style="${colsGridStyle(cols)}">${cells.map((cell, i) => renderColCell(cell, edit, `cells.${i}.`)).join('')}</div>
  </div></section>`;
}

/** Plain text / heading module (optional html override). */
function cText(c = {}, t, edit) {
  if (typeof c.html === 'string' && c.html.trim()) {
    return `<section class="block text-block ws-design-module" data-ws-design-module="1"><div class="container">${markEditableSectionHtml(c.html, edit)}</div></section>`;
  }
  const heading = c.heading || c.title || '';
  const body = c.body || c.text || '';
  if (!heading && !body && !edit) return '';
  return `<section class="block text-block ws-design-module" data-ws-design-module="1"><div class="container">
    ${heading ? `<h2>${editSpan(edit, 'heading', heading)}</h2>` : ''}
    ${body ? `<p class="text-body">${editSpan(edit, 'body', body)}</p>` : ''}
  </div></section>`;
}

/** Text + image split (image left or right). */
function cTextImage(c = {}, t, edit) {
  const heading = c.heading || c.title || '';
  const body = c.body || c.text || '';
  const photo = photoFigure(c.image, 'photo');
  const side = String(c.image_position || c.imagePosition || 'right').toLowerCase() === 'left' ? 'left' : 'right';
  const button = c.button && typeof c.button === 'object' ? c.button : null;
  if (!heading && !body && !photo && !edit) return '';
  const textCol = `<div>
    ${heading ? `<h2>${editSpan(edit, 'heading', heading)}</h2>` : ''}
    ${body ? `<p class="lede">${editSpan(edit, 'body', body)}</p>` : ''}
    ${
      button && button.text
        ? `<p><a class="btn btn-primary" href="${esc(safeHref(button.href))}">${editSpan(edit, 'button.text', button.text)}</a></p>`
        : ''
    }
  </div>`;
  const imgCol =
    photo ||
    '<div class="ph" style="background:linear-gradient(135deg,#e5e7eb,#d1d5db)" role="img" aria-label="Image"></div>';
  return `<section class="block text-image ws-design-module" data-ws-design-module="1"><div class="container">
    <div class="text-image-grid${side === 'left' ? ' image-left' : ''}">${textCol}<div>${imgCol}</div></div>
  </div></section>`;
}

/** Generic N-column card grid. */
function cCards(c = {}, t, edit) {
  const items = Array.isArray(c.items) ? c.items : [];
  const cols = clampCols(c.cols != null ? c.cols : items.length >= 4 ? 4 : items.length || 3, 3);
  if (!items.length && !edit) return '';
  return `<section class="block layout-cards ws-design-module" data-ws-design-module="1"><div class="container">
    ${c.title ? `<h2>${editSpan(edit, 'title', c.title)}</h2>` : ''}
    ${c.subtitle ? `<p class="lede">${editSpan(edit, 'subtitle', c.subtitle)}</p>` : ''}
    <div class="cards-grid cols-${cols}" style="${colsGridStyle(cols)}" data-ws-list="items">${items
      .map((it, i) =>
        wrapListItem(
          edit,
          'items',
          i,
          `<div class="card">
          ${photoFigure(it.image, 'photo')}
          <h3>${editSpan(edit, `items.${i}.title`, it.title || it.name || '')}</h3>
          <p>${editSpan(edit, `items.${i}.text`, it.text || it.description || '')}</p>
        </div>`
        )
      )
      .join('')}</div>${listAddButton(edit, 'items', '+ Add card')}</div></section>`;
}

/** In-page site module mount (portal structure insert). */
function cSiteModule(c = {}) {
  const token = String(c.public_token || c.publicToken || '').trim();
  const moduleType = String(c.module_type || c.moduleType || '').trim();
  if (!token) return '';
  const api = String(c.api_base || c.apiBase || '').replace(/\/$/, '');
  const apiAttr = api ? ` data-bitpype-api="${esc(api)}"` : '';
  const typeAttr = moduleType ? ` data-bitpype-module-type="${esc(moduleType)}"` : '';
  const script = api
    ? `<script src="${esc(api)}/js/module-embed.js?v=mod6" defer data-bitpype-module-script="1"></script>`
    : `<script src="/js/module-embed.js?v=mod6" defer data-bitpype-module-script="1"></script>`;
  return (
    `<section class="block site-module-section"><div class="container">` +
    `<div class="bitpype-module-embed" data-bitpype-module="1"${typeAttr} ` +
    `data-bitpype-module-token="${esc(token)}"${apiAttr} data-bitpype-hide-title="1"></div>` +
    `${script}</div></section>`
  );
}

/** Portal-published contact form embed (in-page JS mount). */
function cBitpypeForm(c = {}) {
  const token = String(c.form_token || c.bitpype_form_token || '').trim();
  if (!token) return '';
  const api = String(c.api_base || c.bitpype_api || '').replace(/\/$/, '');
  const apiAttr = api ? ` data-bitpype-api="${esc(api)}"` : '';
  const script = api
    ? `<script src="${esc(api)}/js/form-embed.js?v=form1" defer data-bitpype-form-script="1"></script>`
    : `<script src="/js/form-embed.js?v=form1" defer data-bitpype-form-script="1"></script>`;
  return (
    `<!--bitpype-form:${esc(token)}--><section class="block"><div class="container" style="max-width:640px;margin:0 auto">` +
    `<div class="bitpype-form-embed" data-bitpype-managed="1" data-bitpype-form-embed="${esc(token)}"${apiAttr}></div>` +
    `${script}</div></section><!--/bitpype-form:${esc(token)}-->`
  );
}

function cSocialLinks(c = {}, t) {
  const links = Array.isArray(c.links) ? c.links : [];
  if (!links.length) return '';
  return `<section class="block"><div class="container">
    ${c.title ? `<h2>${esc(c.title)}</h2>` : '<h2>Follow Us</h2>'}
    <div class="social-row">${links
      .map((l) => {
        const network = l.network || l.icon || '';
        const iconName =
          siteIcons.iconForNetwork(network) ||
          (siteIcons.isKnownIcon(network) ? siteIcons.normalizeIconName(network) : '');
        const href = esc(safeHref(l.url || '#'));
        const label = l.label || network || l.url || 'Social';
        if (iconName) {
          return `<a class="ws-social" href="${href}" target="_blank" rel="noopener" aria-label="${esc(label)}" title="${esc(label)}">${siteIcons.renderIconSvg(iconName, { label })}</a>`;
        }
        return `<a href="${href}" target="_blank" rel="noopener">${esc(label)}</a>`;
      })
      .join('')}</div></div></section>`;
}

const RENDERERS = {
  nav: cNav,
  hero: cHero,
  benefits: cBenefits,
  services: cServices,
  about: cAbout,
  gallery: cGallery,
  reviews: cReviews,
  cta: cCta,
  contact_form: cContactForm,
  map_placeholder: cMapPlaceholder,
  hours: cHours,
  faq: cFaq,
  footer: cFooter,
  booking_button: cBookingButton,
  social_links: cSocialLinks,
  custom: cCustom,
  html: cHtml,
  bitpype_form: cBitpypeForm,
  form: cBitpypeForm,
  site_module: cSiteModule,
  columns: cColumns,
  text: cText,
  text_image: cTextImage,
  cards: cCards,
  heading: cHeading,
  image: cImage,
};

const PREVIEW_EDIT_STYLE = `<style data-ws-edit-style="1">
html.ws-editing [data-edit]{
  outline:1px dashed rgba(13,107,92,.5);
  outline-offset:2px;
  cursor:text;
  background:rgba(13,107,92,.06);
  border-radius:2px;
  transition:outline-color .15s ease,background .15s ease;
  user-select:text;
  -webkit-user-select:text;
  pointer-events:auto;
}
html.ws-editing [data-edit]:hover{
  outline-color:rgba(13,107,92,.85);
  background:rgba(13,107,92,.1);
}
html.ws-editing [data-edit]:focus{
  outline:2px solid rgba(13,107,92,.85);
  background:rgba(13,107,92,.12);
}
html.ws-editing img{
  outline:1px dashed rgba(13,107,92,.45);
  outline-offset:2px;
  cursor:pointer;
  transition:outline-color .15s ease,filter .15s ease,opacity .15s ease;
}
html.ws-editing img:hover{
  outline-color:rgba(13,107,92,.9);
  filter:brightness(0.97);
}
html.ws-editing img.ws-img-busy{
  opacity:.55;
  pointer-events:none;
}
/* Block + width:100% — never inline-block shrink-to-fit. Wrapping imgs in
   inline-block with img{max-width:100%;width:100%} collapses the box (esp.
   while lazy/broken), which looks like images "disappear" leaving only ★. */
html.ws-editing .ws-img-host{
  position:relative;
  display:block;
  width:100%;
  max-width:100%;
  line-height:0;
  vertical-align:middle;
}
html.ws-editing .ws-img-host > img{
  max-width:100%;
}
.ws-ai-img{display:none!important}
html.ws-editing .ws-ai-img{
  display:flex!important;
  align-items:center;
  justify-content:center;
  position:absolute;
  top:8px;
  right:8px;
  z-index:7;
  width:32px;
  height:32px;
  padding:0;
  border:0;
  border-radius:8px;
  background:rgba(13,107,92,.92);
  color:#fff;
  font-size:1.1rem;
  line-height:1;
  cursor:pointer;
  box-shadow:0 2px 8px rgba(0,0,0,.16);
}
html.ws-editing .ws-ai-img:hover{background:rgba(10,90,78,.98)}
html.ws-editing .ws-img-host:has(img.ws-img-busy) .ws-ai-img{
  opacity:.45;
  pointer-events:none;
}
.ws-add-item,.ws-del-item,.ws-sec-add{display:none!important}
html.ws-editing .ws-add-item{
  display:inline-flex!important;align-items:center;justify-content:center;gap:6px;
  margin:14px 0 6px;padding:10px 16px;
  border:1px dashed rgba(13,107,92,.55);border-radius:10px;
  background:rgba(13,107,92,.08);color:#0d6b5c;font:inherit;font-weight:650;
  font-size:.9rem;cursor:pointer;line-height:1.2;
  width:auto;max-width:100%;
  flex:0 0 auto;grid-column:1/-1;justify-self:start;
}
html.ws-editing .ws-add-item:hover{background:rgba(13,107,92,.14)}
html.ws-editing .ws-sec-add{
  display:flex!important;align-items:center;justify-content:center;
  width:100%;max-width:100%;box-sizing:border-box;
  margin:10px 0;padding:10px 14px;
  border:1px dashed rgba(13,107,92,.45);border-radius:10px;
  background:rgba(13,107,92,.05);color:#0d6b5c;font:inherit;font-weight:650;
  font-size:.88rem;cursor:pointer;line-height:1.2;
}
html.ws-editing .ws-sec-add:hover{background:rgba(13,107,92,.12)}
html.ws-editing .ws-list-item{position:relative}
html.ws-editing .ws-del-item{
  display:flex!important;align-items:center;justify-content:center;
  position:absolute;top:8px;right:8px;z-index:6;
  width:28px;height:28px;padding:0;border:0;border-radius:8px;
  background:rgba(155,28,28,.92);color:#fff;font-size:1.1rem;line-height:1;
  cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.12);
}
html.ws-editing .ws-ff-item{position:relative!important}
html.ws-editing details.ws-ff-item > .ws-del-item{top:10px;right:10px}
html.ws-editing .ws-embed-module,
html.ws-editing .ws-design-module,
html.ws-editing [data-ws-design-module="1"]{
  outline:1px dashed rgba(13,107,92,.45);
  border-radius:12px;
  padding:8px 10px 12px;
  margin:12px 0;
  position:relative;
}
html.ws-editing .ws-widget-host{
  outline:1px dashed rgba(13,107,92,.35);
  border-radius:10px;
  padding:6px 8px 10px;
  margin:10px 0;
  position:relative;
}
html.ws-editing .ws-embed-module .ws-sec-tools,
html.ws-editing .ws-design-module .ws-sec-tools,
html.ws-editing [data-ws-design-module="1"] .ws-sec-tools,
html.ws-editing .ws-widget-host .ws-sec-tools,
html.ws-editing [data-ws-page-section] .ws-sec-tools{margin-bottom:6px}
.ws-sec-tools{display:none!important}
html.ws-editing .ws-sec-tools{
  display:flex!important;justify-content:flex-end;flex-wrap:wrap;gap:8px;
  margin:0 0 8px;
}
html.ws-editing .ws-sec-del,
html.ws-editing .ws-sec-add-mod{
  position:static;width:auto;height:auto;padding:6px 12px;
  border-radius:8px;font:inherit;font-size:.82rem;font-weight:650;
  line-height:1.2;box-shadow:none;cursor:pointer;
}
html.ws-editing .ws-sec-add-mod{
  border:1px dashed rgba(13,107,92,.5);
  background:rgba(13,107,92,.08);color:#0d6b5c;
}
html.ws-editing .ws-sec-add-mod:hover{background:rgba(13,107,92,.14)}
html.ws-editing.ws-font-only .ws-add-item,
html.ws-editing.ws-font-only .ws-sec-add,
html.ws-editing.ws-font-only .ws-sec-tools,
html.ws-editing.ws-font-only .ws-del-item,
html.ws-editing.ws-font-only .ws-ai-img{display:none!important}
</style>`;

const PREVIEW_EDIT_SCRIPT = `<script>
(function () {
  var editOn = false;
  var fontPick = false;
  var MAX_ITEMS = 24;
  var undoStack = [];
  var MAX_UNDO = 30;

  function setEditMode(on, fontsOnly) {
    editOn = !!on;
    fontPick = editOn && !!fontsOnly;
    try {
      document.documentElement.classList.toggle('ws-editing', editOn);
      document.documentElement.classList.toggle('ws-font-only', fontPick);
    } catch (err) {}
    if (!editOn) {
      var nodes = document.querySelectorAll('[data-edit][contenteditable="true"]');
      for (var i = 0; i < nodes.length; i++) nodes[i].contentEditable = 'false';
      var busy = document.querySelectorAll('img.ws-img-busy');
      for (var j = 0; j < busy.length; j++) busy[j].classList.remove('ws-img-busy');
      clearFreeformControls();
      clearAiImageControls();
      undoStack = [];
      postUndoState();
      postSelection(null);
    } else if (!fontPick) {
      mountFreeformControls();
      mountPageSectionControls();
      mountAiImageControls();
    }
  }

  function pageRootFor(el) {
    var root = el && el.closest ? el.closest('[data-ws-page]') : null;
    return root || document.body;
  }

  function pageIndexOf(el) {
    var root = el && el.closest ? el.closest('[data-ws-page]') : null;
    if (root && root.getAttribute('data-ws-page') != null) {
      return Number(root.getAttribute('data-ws-page')) || 0;
    }
    return 0;
  }

  function sectionIndexOf(el) {
    var root = el && el.closest ? el.closest('[data-ws-section-index]') : null;
    if (root && root.getAttribute('data-ws-section-index') != null) {
      var n = Number(root.getAttribute('data-ws-section-index'));
      return Number.isFinite(n) ? n : null;
    }
    return null;
  }

  function classSig(el) {
    if (!el || !el.className || typeof el.className !== 'string') return '';
    return el.className.split(/\\s+/).filter(function (c) {
      return c && c.indexOf('ws-') !== 0 && c !== 'ws-ff-item';
    }).sort().join('.');
  }

  function isChrome(el) {
    return !!(el && el.classList && (
      el.classList.contains('ws-add-item')
      || el.classList.contains('ws-ff-add')
      || el.classList.contains('ws-sec-add')
      || el.classList.contains('ws-sec-del')
      || el.classList.contains('ws-sec-add-mod')
      || el.classList.contains('ws-sec-tools')
      || el.classList.contains('ws-del-item')
      || el.classList.contains('ws-ai-img')
      || el.classList.contains('ws-img-host')
    ));
  }

  function isModuleOrFormEmbed(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.getAttribute && (
      el.getAttribute('data-bitpype-module')
      || el.getAttribute('data-bitpype-form-embed')
      || el.getAttribute('data-bitpype-managed')
    )) return true;
    if (el.classList && (
      el.classList.contains('bitpype-module-embed')
      || el.classList.contains('bitpype-form-embed')
    )) return true;
    return false;
  }

  function isPageSection(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.classList && el.classList.contains('ws-embed-module')) return false;
    if (el.getAttribute && el.getAttribute('data-ws-page-section') === '1') return true;
    return !!(el.classList && el.classList.contains('ws-page-section'));
  }

  function isDesignModule(el) {
    if (!el || el.nodeType !== 1 || isChrome(el) || isModuleOrFormEmbed(el)) return false;
    if (isPageSection(el)) return false;
    if (el.getAttribute && el.getAttribute('data-ws-design-module') === '1') return true;
    if (el.classList && (
      el.classList.contains('ws-design-module')
      || el.classList.contains('layout-columns')
      || el.classList.contains('text-block')
      || el.classList.contains('text-image')
      || el.classList.contains('layout-cards')
      || el.classList.contains('ws-html-block')
      || el.classList.contains('ws-design-heading')
      || el.classList.contains('ws-design-image')
      || el.classList.contains('custom-block')
    )) return true;
    var st = el.getAttribute && el.getAttribute('data-ws-section-type');
    if (st && /^(heading|text|image|columns|text_image|cards|html|hero|services|benefits|about|faq|cta|reviews|gallery|custom)$/i.test(st)) {
      return true;
    }
    return false;
  }

  var canvasIdSeq = 0;
  function ensureCanvasId(el) {
    if (!el || !el.getAttribute) return '';
    var id = el.getAttribute('data-ws-canvas-id');
    if (id) return id;
    canvasIdSeq += 1;
    id = 'c' + Date.now().toString(36) + '-' + canvasIdSeq;
    el.setAttribute('data-ws-canvas-id', id);
    return id;
  }

  function findByCanvasId(id) {
    if (!id) return null;
    try {
      return document.querySelector('[data-ws-canvas-id="' + String(id).replace(/"/g, '') + '"]');
    } catch (errFind) { return null; }
  }

  function makeToolsRow(buttons) {
    var tools = document.createElement('div');
    tools.className = 'ws-sec-tools';
    for (var i = 0; i < buttons.length; i++) {
      var b = buttons[i];
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = b.className;
      btn.setAttribute(b.attr, b.mode);
      btn.textContent = b.label;
      tools.appendChild(btn);
    }
    return tools;
  }

  function clearAiImageControls() {
    var btns = document.querySelectorAll('.ws-ai-img');
    for (var i = 0; i < btns.length; i++) btns[i].remove();
    var hosts = document.querySelectorAll('.ws-img-host');
    for (var h = 0; h < hosts.length; h++) {
      var host = hosts[h];
      var img = null;
      for (var c = 0; c < host.children.length; c++) {
        if (host.children[c].tagName === 'IMG') { img = host.children[c]; break; }
      }
      if (img && host.parentNode) {
        host.parentNode.insertBefore(img, host);
        host.parentNode.removeChild(host);
      } else if (host.parentNode) {
        host.parentNode.removeChild(host);
      }
    }
  }

  function mountAiImageControls() {
    clearAiImageControls();
    var imgs = document.querySelectorAll('img');
    for (var i = 0; i < imgs.length; i++) {
      var img = imgs[i];
      if (img.getAttribute('data-ws-logo') === '1' || (img.classList && img.classList.contains('brand-logo'))) continue;
      if (img.closest && img.closest('[data-ws-brand]')) continue;
      if (img.parentElement && img.parentElement.classList
        && img.parentElement.classList.contains('ws-img-host')) continue;
      var src = img.getAttribute('src') || '';
      if (!src || /^data:/i.test(src) || /^blob:/i.test(src)) continue;
      if (!img.parentNode) continue;
      // <div> host keeps block formatting context; span+inline-block collapsed slots.
      var host = document.createElement('div');
      host.className = 'ws-img-host';
      img.parentNode.insertBefore(host, img);
      host.appendChild(img);
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ws-ai-img';
      btn.setAttribute('aria-label', 'Generate image with AI');
      btn.setAttribute('data-ws-img-src', src);
      btn.title = 'Generate with AI';
      btn.textContent = '\u2605';
      host.appendChild(btn);
    }
  }

  /** Structural fingerprint so full rows match, not inner text columns. */
  function structureSig(el) {
    if (!el || el.nodeType !== 1) return '';
    var childParts = [];
    for (var i = 0; i < el.children.length; i++) {
      var ch = el.children[i];
      if (isChrome(ch)) continue;
      childParts.push(ch.tagName + ':' + classSig(ch));
    }
    return el.tagName + ':' + classSig(el) + '>' + childParts.join('+');
  }

  function itemWeight(el) {
    var text = (el.textContent || '').replace(/\\s+/g, ' ').trim().length;
    return el.children.length * 10 + Math.min(text, 400);
  }

  function clearFreeformControls() {
    var adds = document.querySelectorAll('.ws-ff-add');
    for (var i = 0; i < adds.length; i++) adds[i].remove();
    var dels = document.querySelectorAll('.ws-del-item[data-ws-del="freeform"]');
    for (var j = 0; j < dels.length; j++) dels[j].remove();
    var items = document.querySelectorAll('.ws-ff-item');
    for (var k = 0; k < items.length; k++) items[k].classList.remove('ws-ff-item');
    clearPageSectionControls();
  }

  function clearPageSectionControls() {
    var btns = document.querySelectorAll('.ws-sec-add, .ws-sec-tools');
    for (var i = 0; i < btns.length; i++) btns[i].remove();
    var hosts = document.querySelectorAll('.ws-widget-host');
    for (var h = 0; h < hosts.length; h++) {
      var host = hosts[h];
      while (host.firstChild) host.parentNode.insertBefore(host.firstChild, host);
      if (host.parentNode) host.parentNode.removeChild(host);
    }
  }

  function postUndoState() {
    try {
      parent.postMessage({
        source: 'ws-preview',
        type: 'undo-state',
        canUndo: undoStack.length > 0
      }, '*');
    } catch (errUndo) {}
  }

  function pushUndo(el, extra) {
    var payload = serializePage(el);
    undoStack.push({
      pageIndex: payload.pageIndex,
      sectionIndex: payload.sectionIndex,
      html: payload.html,
      embedRestore: extra && extra.embedRestore ? extra.embedRestore : null
    });
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    postUndoState();
  }

  function postFreeformSave(payload) {
    try {
      var msg = {
        source: 'ws-preview',
        type: 'list-mutate',
        action: 'freeform-save',
        pageIndex: payload.pageIndex,
        sectionIndex: payload.sectionIndex,
        html: payload.html
      };
      if (payload.embedRemove) msg.embedRemove = payload.embedRemove;
      if (payload.embedRestore) msg.embedRestore = payload.embedRestore;
      parent.postMessage(msg, '*');
    } catch (errSave) {}
  }

  function remarkEditable(root) {
    if (!root) return;
    var pi = pageIndexOf(root);
    var filter = {
      acceptNode: function (node) {
        var p = node.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        if (p.closest && p.closest('script,style,noscript,svg,.bitpype-module-embed,.bitpype-form-embed,.ws-sec-tools,[data-edit]')) {
          return NodeFilter.FILTER_REJECT;
        }
        var a = p.closest ? p.closest('a') : null;
        if (a && /^(tel:|mailto:)/i.test(a.getAttribute('href') || '')) return NodeFilter.FILTER_REJECT;
        if (!String(node.nodeValue || '').trim()) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    };
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, filter);
    var nodes = [];
    var n;
    while ((n = walker.nextNode())) nodes.push(n);
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var span = document.createElement('span');
      span.className = 'ws-edit';
      span.setAttribute('data-edit', 'html:' + pi + ':' + (sectionIndexOf(root) != null ? sectionIndexOf(root) + ':' : '') + i);
      span.textContent = node.nodeValue;
      node.parentNode.replaceChild(span, node);
    }
  }

  function undoLast() {
    var snap = undoStack.pop();
    postUndoState();
    if (!snap) return;
    var selector = '[data-ws-page="' + snap.pageIndex + '"]';
    if (snap.sectionIndex != null) selector += '[data-ws-section-index="' + snap.sectionIndex + '"]';
    var root = document.querySelector(selector);
    if (!root && snap.sectionIndex != null) return;
    if (!root) root = document.body;
    root.innerHTML = snap.html;
    remarkEditable(root);
    mountFreeformControls();
    mountPageSectionControls();
    mountAiImageControls();
    var restored = serializePage(root);
    if (snap.embedRestore) restored.embedRestore = snap.embedRestore;
    postFreeformSave(restored);
  }

  function bumpEditId(id) {
    var parts = String(id || '').split(':');
    var n = Number(parts[parts.length - 1]);
    if (!isFinite(n)) n = 0;
    parts[parts.length - 1] = String(n + 1);
    return parts.join(':');
  }

  function nextFreeformEditId(root) {
    var pi = pageIndexOf(root);
    var max = -1;
    var nodes = (root || document).querySelectorAll('[data-edit]');
    for (var i = 0; i < nodes.length; i++) {
      var id = nodes[i].getAttribute('data-edit') || '';
      var bits = id.split(':');
      if (bits[0] !== 'html' || Number(bits[1]) !== pi) continue;
      var n = Number(bits[bits.length - 1]);
      if (n > max) max = n;
    }
    return 'html:' + pi + ':' + (sectionIndexOf(root) != null ? sectionIndexOf(root) + ':' : '') + (max + 1);
  }

  function buildContentSectionEl() {
    var sec = document.createElement('section');
    sec.className = 'ws-page-section';
    sec.setAttribute('data-ws-page-section', '1');
    var hint = document.createElement('p');
    hint.innerHTML = '<span class="ws-edit" data-edit="pending">Empty section — use Add block.</span>';
    sec.appendChild(hint);
    return sec;
  }

  function assignPendingEditIds(root, startId) {
    var id = startId;
    var pending = root.querySelectorAll('[data-edit="pending"]');
    for (var i = 0; i < pending.length; i++) {
      pending[i].setAttribute('data-edit', id);
      id = bumpEditId(id);
    }
    return id;
  }

  function ensureMainPageChrome(main) {
    if (!main) return;
    if (main.classList) {
      if (!main.classList.contains('bp-mod-main')) main.classList.add('bp-mod-main');
      if (!main.classList.contains('page')) main.classList.add('page');
    }
    var title = null;
    for (var i = 0; i < main.children.length; i++) {
      var ch = main.children[i];
      if (isChrome(ch) || isModuleOrFormEmbed(ch)) continue;
      if (/^H1$/i.test(ch.tagName)) { title = ch; break; }
    }
    if (title && title.classList && !title.classList.contains('bp-mod-page-title')) {
      title.classList.add('bp-mod-page-title');
    }
    var hasSection = !!main.querySelector(':scope > [data-ws-page-section], :scope > section.ws-page-section');
    if (hasSection) return;
    var loose = [];
    for (var j = 0; j < main.children.length; j++) {
      var el = main.children[j];
      if (isChrome(el) || isModuleOrFormEmbed(el)) continue;
      if (title && el === title) continue;
      if (/^(SCRIPT|STYLE|NOSCRIPT)$/i.test(el.tagName)) continue;
      loose.push(el);
    }
    if (!loose.length) return;
    var wrap = document.createElement('section');
    wrap.className = 'ws-page-section';
    wrap.setAttribute('data-ws-page-section', '1');
    loose[0].parentNode.insertBefore(wrap, loose[0]);
    for (var L = 0; L < loose.length; L++) wrap.appendChild(loose[L]);
  }

  function insertSectionAddButton(parent, beforeNode) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ws-add-item ws-sec-add';
    btn.setAttribute('data-ws-add', 'page-section');
    btn.textContent = '+ Add section';
    if (beforeNode) parent.insertBefore(btn, beforeNode);
    else parent.appendChild(btn);
    return btn;
  }

  function embedModuleMeta(el) {
    var form = el.classList && el.classList.contains('bitpype-form-embed');
    return {
      kind: form ? 'form' : 'module',
      moduleType: el.getAttribute('data-bitpype-module-type') || '',
      token: form
        ? (el.getAttribute('data-bitpype-form-embed') || '')
        : (el.getAttribute('data-bitpype-module-token') || '')
    };
  }

  function requestPickBlock(targetEl) {
    if (!targetEl) return;
    var canvasId = ensureCanvasId(targetEl);
    try {
      parent.postMessage({
        source: 'ws-preview',
        type: 'pick-block',
        mode: 'block',
        targetId: canvasId,
        pageIndex: pageIndexOf(targetEl),
        sectionIndex: sectionIndexOf(targetEl)
      }, '*');
    } catch (errPick) {}
  }

  function insertHtmlIntoTarget(targetEl, html) {
    if (!targetEl || !html) return null;
    pushUndo(pageRootFor(targetEl) || targetEl);
    var wrap = document.createElement('div');
    wrap.innerHTML = String(html);
    var inserted = [];
    while (wrap.firstChild) {
      var node = wrap.firstChild;
      targetEl.appendChild(node);
      if (node.nodeType === 1) inserted.push(node);
    }
    for (var i = 0; i < inserted.length; i++) {
      if (inserted[i].querySelectorAll) {
        assignPendingEditIds(inserted[i], nextFreeformEditId(pageRootFor(targetEl)));
      }
      remarkEditable(inserted[i]);
    }
    mountFreeformControls();
    mountPageSectionControls();
    mountAiImageControls();
    postFreeformSave(serializePage(targetEl));
    return inserted[0] || null;
  }

  function mountWidgetControls(root) {
    if (!root) return;
    var embeds = root.querySelectorAll('.bitpype-module-embed, .bitpype-form-embed');
    for (var i = 0; i < embeds.length; i++) {
      var el = embeds[i];
      if (el.closest && el.closest('.ws-widget-host')) continue;
      var meta = embedModuleMeta(el);
      var host = document.createElement('div');
      host.className = 'ws-widget-host ws-block';
      host.setAttribute('data-ws-block', meta.kind === 'form' ? 'form' : 'module');
      host.setAttribute('data-ws-embed-kind', meta.kind);
      if (meta.moduleType) host.setAttribute('data-ws-module-type', meta.moduleType);
      if (meta.token) host.setAttribute('data-ws-embed-token', meta.token);
      el.parentNode.insertBefore(host, el);
      host.appendChild(el);
      host.insertBefore(makeToolsRow([
        { className: 'ws-del-item ws-sec-del', attr: 'data-ws-del', mode: 'block', label: 'Delete block' }
      ]), host.firstChild);
    }
  }

  function mountLayoutCellControls(section) {
    if (!section) return;
    var cells = section.querySelectorAll('.col-cell, [data-ws-layout-cell]');
    for (var i = 0; i < cells.length; i++) {
      var cell = cells[i];
      if (cell.querySelector && cell.querySelector(':scope > .ws-sec-tools')) continue;
      ensureCanvasId(cell);
      if (!cell.getAttribute('data-ws-layout-cell')) cell.setAttribute('data-ws-layout-cell', '1');
      cell.insertBefore(makeToolsRow([
        { className: 'ws-sec-add-mod', attr: 'data-ws-add', mode: 'block', label: '+ Add block' }
      ]), cell.firstChild);
    }
  }

  function mountBlockControls(section) {
    if (!section) return;
    var nodes = section.querySelectorAll(
      '[data-ws-block], [data-ws-design-module="1"], .ws-design-module, .layout-columns, .text-block, .text-image, .layout-cards, .ws-html-block, .ws-design-heading, .ws-design-image, .custom-block, [data-ws-section-type]'
    );
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (!isDesignModule(el) && !(el.getAttribute && el.getAttribute('data-ws-block'))) continue;
      if (el.closest && el.closest('.ws-widget-host')) continue;
      if (el.classList && el.classList.contains('col-cell')) continue;
      if (el.querySelector && el.querySelector(':scope > .ws-sec-tools')) continue;
      ensureCanvasId(el);
      if (!el.getAttribute('data-ws-design-module')) el.setAttribute('data-ws-design-module', '1');
      if (!el.getAttribute('data-ws-block')) el.setAttribute('data-ws-block', '1');
      if (el.classList && !el.classList.contains('ws-design-module')) el.classList.add('ws-design-module');
      el.insertBefore(makeToolsRow([
        { className: 'ws-del-item ws-sec-del', attr: 'data-ws-del', mode: 'block', label: 'Delete block' }
      ]), el.firstChild);
    }
    mountLayoutCellControls(section);
    mountWidgetControls(section);
  }

  function mountPageSectionControls() {
    clearPageSectionControls();
    if (fontPick) return;
    var scopes = document.querySelectorAll('[data-ws-page]');
    if (!scopes.length) scopes = [document.body];
    for (var si = 0; si < scopes.length; si++) {
      var scope = scopes[si];
      var mains = [];
      if (scope.tagName === 'MAIN') mains = [scope];
      else {
        var found = scope.querySelectorAll('main');
        for (var fi = 0; fi < found.length; fi++) mains.push(found[fi]);
      }
      if (!mains.length && scope.tagName === 'BODY') {
        var bodyMains = document.querySelectorAll('main');
        for (var bi = 0; bi < bodyMains.length; bi++) mains.push(bodyMains[bi]);
      }
      for (var mi = 0; mi < mains.length; mi++) {
        var main = mains[mi];
        ensureMainPageChrome(main);
        var kids = [];
        for (var c = 0; c < main.children.length; c++) {
          var kid = main.children[c];
          if (isChrome(kid)) continue;
          kids.push(kid);
        }
        // Page control: Add section
        if (kids.length && /^H1$/i.test(kids[0].tagName)) {
          insertSectionAddButton(main, kids[0].nextSibling);
        } else {
          insertSectionAddButton(main, kids[0] || null);
        }
        var sections = main.querySelectorAll(':scope > [data-ws-page-section], :scope > section.ws-page-section');
        for (var s = 0; s < sections.length; s++) {
          var sec = sections[s];
          if (sec.classList && sec.classList.contains('ws-embed-module')) continue;
          ensureCanvasId(sec);
          sec.insertBefore(makeToolsRow([
            { className: 'ws-sec-add-mod', attr: 'data-ws-add', mode: 'block', label: '+ Add block' },
            { className: 'ws-del-item ws-sec-del', attr: 'data-ws-del', mode: 'page-section', label: 'Delete section' }
          ]), sec.firstChild);
          mountBlockControls(sec);
          insertSectionAddButton(main, sec.nextSibling);
        }
        // Loose widgets not inside a section still get Delete block
        mountWidgetControls(main);
      }
    }
  }

  function discoverGroups(root) {
    var candidates = [];
    var parents = root.querySelectorAll('div, ul, ol, section, main, article, nav');
    for (var pi = 0; pi < parents.length; pi++) {
      var p = parents[pi];
      if (p.closest && p.closest('[data-ws-list]')) continue;
      var kids = [];
      for (var c = 0; c < p.children.length; c++) {
        var ch = p.children[c];
        if (isChrome(ch)) continue;
        if (/^(SCRIPT|STYLE|NOSCRIPT|LINK|BR|HR|BUTTON)$/.test(ch.tagName)) continue;
        kids.push(ch);
      }
      if (kids.length < 2) continue;

      // Cluster by structure signature (full row shape)
      var buckets = {};
      for (var ki = 0; ki < kids.length; ki++) {
        var k = kids[ki];
        var sig = structureSig(k);
        if (k.tagName === 'DETAILS' || k.tagName === 'LI') {
          sig = k.tagName + ':*';
        }
        if (!buckets[sig]) buckets[sig] = [];
        buckets[sig].push(k);
      }
      var best = null;
      Object.keys(buckets).forEach(function (sig) {
        var group = buckets[sig];
        if (group.length < 2) return;
        // Skip tiny inner columns (e.g. only a heading+paragraph wrapper)
        var avg = group.reduce(function (s, el) { return s + itemWeight(el); }, 0) / group.length;
        if (avg < 25 && group[0].tagName !== 'DETAILS' && group[0].tagName !== 'LI') return;
        var score = group.length * 100 + avg;
        if (!best || score > best.score) {
          best = { parent: p, items: group, tag: group[0].tagName, sig: sig, score: score };
        }
      });
      if (best) candidates.push(best);
    }

    // Prefer outer row groups: drop groups whose parent sits inside another group's item
    return candidates.filter(function (g) {
      return !candidates.some(function (o) {
        if (o === g) return false;
        return o.items.some(function (oi) { return oi.contains(g.parent); });
      });
    });
  }

  function mountDeleteButton(item) {
    var existing = null;
    for (var i = 0; i < item.children.length; i++) {
      if (item.children[i].classList && item.children[i].classList.contains('ws-del-item')) {
        existing = item.children[i];
        break;
      }
    }
    if (existing) return;
    var del = document.createElement('button');
    del.type = 'button';
    del.className = 'ws-del-item';
    del.setAttribute('data-ws-del', 'freeform');
    del.setAttribute('aria-label', 'Remove item');
    del.title = 'Remove';
    del.textContent = '\u00d7';
    // Append (absolute) so flex/grid order of real children is unchanged
    item.appendChild(del);
  }

  function mountFreeformControls() {
    clearFreeformControls();
    var scopes = document.querySelectorAll('[data-ws-page]');
    if (!scopes.length) scopes = [document.body];
    for (var si = 0; si < scopes.length; si++) {
      var groups = discoverGroups(scopes[si]);
      for (var gi = 0; gi < groups.length; gi++) {
        var g = groups[gi];
        for (var ii = 0; ii < g.items.length; ii++) {
          var item = g.items[ii];
          item.classList.add('ws-ff-item');
          mountDeleteButton(item);
        }
        var hasAdd = false;
        for (var a = 0; a < g.parent.children.length; a++) {
          if (g.parent.children[a].classList && g.parent.children[a].classList.contains('ws-ff-add')) {
            hasAdd = true;
            break;
          }
        }
        if (hasAdd) continue;
        var add = document.createElement('button');
        add.type = 'button';
        add.className = 'ws-add-item ws-ff-add';
        add.setAttribute('data-ws-add', 'freeform');
        add.textContent = g.tag === 'DETAILS' ? '+ Add question'
          : g.tag === 'LI' ? '+ Add bullet'
          : '+ Add item';
        g.parent.appendChild(add);
      }
    }
  }

  function stripEditChrome(root) {
    var clone = root.cloneNode(true);
    var chrome = clone.querySelectorAll('.ws-add-item, .ws-ff-add, .ws-sec-add, .ws-sec-add-mod, .ws-sec-tools, .ws-del-item, .ws-ai-img');
    for (var i = 0; i < chrome.length; i++) chrome[i].remove();
    var embedWraps = clone.querySelectorAll('.ws-embed-module, .ws-widget-host');
    for (var ew = 0; ew < embedWraps.length; ew++) {
      var box = embedWraps[ew];
      while (box.firstChild) box.parentNode.insertBefore(box.firstChild, box);
      box.parentNode.removeChild(box);
    }
    var canvasIds = clone.querySelectorAll('[data-ws-canvas-id]');
    for (var ci = 0; ci < canvasIds.length; ci++) canvasIds[ci].removeAttribute('data-ws-canvas-id');
    var imgHosts = clone.querySelectorAll('.ws-img-host');
    for (var ih = 0; ih < imgHosts.length; ih++) {
      var host = imgHosts[ih];
      while (host.firstChild) host.parentNode.insertBefore(host.firstChild, host);
      host.parentNode.removeChild(host);
    }
    var wraps = clone.querySelectorAll('.ws-list-item');
    for (var w = 0; w < wraps.length; w++) {
      var wrap = wraps[w];
      while (wrap.firstChild) wrap.parentNode.insertBefore(wrap.firstChild, wrap);
      wrap.parentNode.removeChild(wrap);
    }
    var edits = clone.querySelectorAll('[data-edit]');
    for (var e = 0; e < edits.length; e++) {
      var span = edits[e];
      var fam = span.style && span.style.fontFamily;
      span.removeAttribute('data-edit');
      span.removeAttribute('contenteditable');
      if (span.classList) span.classList.remove('ws-edit');
      if (fam) {
        span.setAttribute('data-ws-font', '1');
        span.style.fontFamily = fam;
      } else if (span.parentNode) {
        var text = document.createTextNode(span.textContent || '');
        span.parentNode.replaceChild(text, span);
      }
    }
    var ff = clone.querySelectorAll('.ws-ff-item');
    for (var f = 0; f < ff.length; f++) ff[f].classList.remove('ws-ff-item');
    return clone;
  }

  function serializePage(el) {
    var sectionRoot = el && el.closest ? el.closest('[data-ws-section-index]') : null;
    var root = sectionRoot || pageRootFor(el);
    var clean = stripEditChrome(root);
    var si = sectionIndexOf(el);
    if (si == null && root && root.getAttribute
      && root.getAttribute('data-ws-section-index') != null) {
      var n = Number(root.getAttribute('data-ws-section-index'));
      if (Number.isFinite(n)) si = n;
    }
    return {
      pageIndex: pageIndexOf(el),
      sectionIndex: si,
      html: clean.innerHTML
    };
  }

  function setElText(el, value) {
    if (!el) return;
    // Prefer editing an existing ws-edit span; else replace element text cleanly
    var span = el.querySelector ? el.querySelector('[data-edit]') : null;
    if (span) {
      span.textContent = value;
      return;
    }
    if (el.childElementCount === 0) {
      el.textContent = value;
      return;
    }
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    var first = null;
    var n;
    while ((n = walker.nextNode())) {
      if (n.parentElement && /^(SCRIPT|STYLE)$/.test(n.parentElement.tagName)) continue;
      if (String(n.nodeValue || '').trim()) {
        first = n;
        break;
      }
    }
    if (first) first.nodeValue = value;
  }

  function clearCloneText(node) {
    // Strip edit chrome from the clone — keep visual structure (bars, numbers, badges)
    var chrome = node.querySelectorAll('.ws-del-item, .ws-add-item, .ws-ff-add');
    for (var c = 0; c < chrome.length; c++) chrome[c].remove();
    node.classList.remove('ws-ff-item');
    var spans = node.querySelectorAll('[data-edit]');
    for (var i = 0; i < spans.length; i++) {
      spans[i].removeAttribute('data-edit');
      spans[i].classList.remove('ws-edit');
    }
    var title = node.querySelector('h1,h2,h3,h4,h5,h6,[class*="title"],[class*="heading"],[class*="name"]');
    var body = node.querySelector('p,[class*="desc"],[class*="text"],[class*="body"],[class*="copy"],[class*="summary"]');
    if (title) setElText(title, 'New item');
    if (body && body !== title) setElText(body, 'Add your text here.');
    if (!title && !body) {
      var texts = [];
      var walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, null);
      var n;
      while ((n = walker.nextNode())) {
        if (n.parentElement && /^(SCRIPT|STYLE)$/.test(n.parentElement.tagName)) continue;
        if (String(n.nodeValue || '').trim()) texts.push(n);
      }
      if (texts[0]) texts[0].nodeValue = 'New item';
      if (texts[1]) texts[1].nodeValue = 'Add your text here.';
    }
  }

  function renumberChips(parent) {
    var chips = parent.querySelectorAll('.chip, [class*="step-num"], [data-step]');
    // Best-effort: numbered .chip in cards
    var cards = parent.querySelectorAll('.card .chip');
    for (var i = 0; i < cards.length; i++) {
      var v = String(cards[i].textContent || '').trim();
      if (/^\\d+$/.test(v) || /^0*\\d+$/.test(v)) {
        cards[i].textContent = String(i + 1).padStart(v.length >= 2 ? 2 : 1, '0').replace(/^0(\\d)$/, '$1');
        if (v.length === 2) cards[i].textContent = String(i + 1).padStart(2, '0');
        else cards[i].textContent = String(i + 1);
      }
    }
  }

  var selectedEdit = null;

  function fontHost(el) {
    var parent = el && el.parentElement;
    var textTag = /^(H1|H2|H3|H4|H5|H6|P|A|BUTTON|LI|LABEL|FIGCAPTION|TD|TH|BLOCKQUOTE|SPAN|STRONG|EM|SMALL|DT|DD)$/;
    if (!parent || parent === document.body || parent === document.documentElement) return el;
    if (parent.getAttribute && parent.getAttribute('data-edit')) return el;
    if (!textTag.test(parent.tagName)) return el;
    var only = true;
    for (var i = 0; i < parent.childNodes.length; i++) {
      var n = parent.childNodes[i];
      if (n === el) continue;
      if (n.nodeType === 3 && !String(n.nodeValue || '').trim()) continue;
      only = false;
      break;
    }
    return only ? parent : el;
  }

  function postSelection(el) {
    selectedEdit = el || null;
    var fam = '';
    try {
      var host = el ? fontHost(el) : null;
      fam = (host && host.style && host.style.fontFamily) || (el && el.style && el.style.fontFamily) || '';
      if (!fam && el) fam = window.getComputedStyle(el).fontFamily || '';
    } catch (errFam) {}
    try {
      parent.postMessage({
        source: 'ws-preview',
        type: 'element-select',
        id: el ? (el.getAttribute('data-edit') || '') : '',
        fontFamily: fam
      }, '*');
    } catch (errSel) {}
  }

  function applyElementFont(stack, name) {
    var el = selectedEdit;
    if (!el || !el.isConnected) {
      el = document.querySelector('[data-edit]:focus') || document.querySelector('[data-edit][contenteditable="true"]');
    }
    if (!el) return;
    selectedEdit = el;
    var target = fontHost(el);
    if (!stack) {
      target.style.fontFamily = '';
      if (!target.getAttribute('style')) target.removeAttribute('style');
    } else {
      target.style.fontFamily = stack;
    }
    var id = el.getAttribute('data-edit') || '';
    var payload = { pageIndex: 0, sectionIndex: null, html: '' };
    if (id.indexOf('html:') === 0) payload = serializePage(el);
    try {
      parent.postMessage({
        source: 'ws-preview',
        type: 'element-font',
        id: id,
        font: name || '',
        pageIndex: payload.pageIndex,
        sectionIndex: payload.sectionIndex,
        html: id.indexOf('html:') === 0 ? payload.html : ''
      }, '*');
    } catch (errFont) {}
  }

  window.addEventListener('message', function (e) {
    var d = e && e.data;
    if (e.source !== parent || !d || d.source !== 'ws-portal') return;
    if (d.type === 'edit-mode') setEditMode(!!d.on, !!d.fontsOnly);
    if (d.type === 'undo') undoLast();
    if (d.type === 'set-font') applyElementFont(d.family || '', d.name || '');
    if (d.type === 'insert-block') {
      var target = findByCanvasId(d.targetId);
      if (!target && d.targetId) {
        try { target = document.querySelector('[data-ws-canvas-id="' + String(d.targetId).replace(/"/g, '') + '"]'); } catch (errT) {}
      }
      if (target && d.html) insertHtmlIntoTarget(target, d.html);
      return;
    }
    if (d.type === 'image-busy') {
      try {
        var list = document.querySelectorAll('img');
        for (var i = 0; i < list.length; i++) {
          var attr = list[i].getAttribute('src') || '';
          if (attr === d.src || list[i].src === d.src) {
            list[i].classList.toggle('ws-img-busy', !!d.on);
          }
        }
      } catch (errBusy) {}
    }
  });

  document.addEventListener('click', function (e) {
    if (!editOn) return;
    if (fontPick) {
      var picked = e.target && e.target.closest ? e.target.closest('[data-edit]') : null;
      if (!picked) return;
      e.preventDefault();
      e.stopPropagation();
      postSelection(picked);
      return;
    }

    var addBtn = e.target && e.target.closest ? e.target.closest('[data-ws-add]') : null;
    if (addBtn) {
      e.preventDefault();
      e.stopPropagation();
      var mode = addBtn.getAttribute('data-ws-add');
      if (mode === 'section') {
        try {
          parent.postMessage({
            source: 'ws-preview',
            type: 'list-mutate',
            action: 'add',
            pageIndex: Number(addBtn.getAttribute('data-ws-page')) || 0,
            sectionIndex: Number(addBtn.getAttribute('data-ws-section')) || 0,
            listKey: addBtn.getAttribute('data-ws-list') || 'items'
          }, '*');
        } catch (errA) {}
        return;
      }
      if (mode === 'page-section') {
        var mainEl = addBtn.closest('main') || addBtn.parentElement;
        if (!mainEl) return;
        pushUndo(mainEl);
        ensureMainPageChrome(mainEl);
        var secEl = buildContentSectionEl();
        assignPendingEditIds(secEl, nextFreeformEditId(pageRootFor(mainEl)));
        mainEl.insertBefore(secEl, addBtn.nextSibling);
        mountFreeformControls();
        mountPageSectionControls();
        mountAiImageControls();
        postFreeformSave(serializePage(mainEl));
        return;
      }
      if (mode === 'block' || mode === 'design-module' || mode === 'widget') {
        var blockTarget = addBtn.closest('[data-ws-layout-cell], .col-cell, [data-ws-page-section], section.ws-page-section, [data-ws-design-module], .ws-design-module');
        if (!blockTarget) return;
        requestPickBlock(blockTarget);
        return;
      }
      if (mode === 'freeform') {
        var parentEl = addBtn.parentElement;
        if (!parentEl) return;
        var siblings = [];
        for (var c = 0; c < parentEl.children.length; c++) {
          var ch = parentEl.children[c];
          if (ch.classList && (ch.classList.contains('ws-add-item') || ch.classList.contains('ws-ff-add'))) continue;
          if (ch.classList && ch.classList.contains('ws-ff-item')) siblings.push(ch);
        }
        if (!siblings.length) return;
        if (siblings.length >= MAX_ITEMS) {
          try { parent.postMessage({ source: 'ws-preview', type: 'list-error', message: 'Maximum items reached' }, '*'); } catch (errM) {}
          return;
        }
        pushUndo(parentEl);
        var clone = siblings[siblings.length - 1].cloneNode(true);
        var oldDels = clone.querySelectorAll('.ws-del-item');
        for (var od = 0; od < oldDels.length; od++) oldDels[od].remove();
        clearCloneText(clone);
        clone.classList.add('ws-ff-item');
        parentEl.insertBefore(clone, addBtn);
        renumberChips(parentEl);
        // Renumber obvious step / index labels in each row
        var rows = [];
        for (var r = 0; r < parentEl.children.length; r++) {
          var row = parentEl.children[r];
          if (row.classList && row.classList.contains('ws-ff-item')) rows.push(row);
        }
        for (var ri = 0; ri < rows.length; ri++) {
          var numEl = rows[ri].querySelector('[class*="num"],[class*="index"],[class*="step"],.chip');
          if (!numEl) continue;
          var cur = String(numEl.textContent || '').trim();
          if (/^\\d{1,2}$/.test(cur)) {
            numEl.textContent = cur.length === 2
              ? String(ri + 1).padStart(2, '0')
              : String(ri + 1);
          }
        }
        mountFreeformControls();
        mountPageSectionControls();
        mountAiImageControls();
        var payload = serializePage(parentEl);
        try {
          parent.postMessage({
            source: 'ws-preview',
            type: 'list-mutate',
            action: 'freeform-save',
            pageIndex: payload.pageIndex,
            sectionIndex: payload.sectionIndex,
            html: payload.html
          }, '*');
        } catch (errF) {}
        return;
      }
    }

    var delBtn = e.target && e.target.closest ? e.target.closest('[data-ws-del]') : null;
    if (delBtn) {
      e.preventDefault();
      e.stopPropagation();
      var dmode = delBtn.getAttribute('data-ws-del');
      if (dmode === 'section') {
        try {
          parent.postMessage({
            source: 'ws-preview',
            type: 'list-mutate',
            action: 'delete',
            pageIndex: Number(delBtn.getAttribute('data-ws-page')) || 0,
            sectionIndex: Number(delBtn.getAttribute('data-ws-section')) || 0,
            listKey: delBtn.getAttribute('data-ws-list') || 'items',
            index: Number(delBtn.getAttribute('data-ws-index')) || 0
          }, '*');
        } catch (errD) {}
        return;
      }
      if (dmode === 'embed-module' || dmode === 'widget' || dmode === 'block' || dmode === 'design-module') {
        var blockNode = delBtn.closest('.ws-widget-host, .ws-embed-module, [data-ws-block], [data-ws-design-module], .ws-design-module');
        var blockRoot = blockNode && (blockNode.closest('[data-ws-section-index]') || blockNode.closest('main') || pageRootFor(blockNode) || blockNode.parentElement);
        if (!blockNode || !blockRoot) return;
        var embedRestore = null;
        if (blockNode.classList && (blockNode.classList.contains('ws-widget-host') || blockNode.classList.contains('ws-embed-module'))) {
          embedRestore = {
            kind: blockNode.getAttribute('data-ws-embed-kind') || 'module',
            moduleType: blockNode.getAttribute('data-ws-module-type') || '',
            token: blockNode.getAttribute('data-ws-embed-token') || ''
          };
        } else {
          var widgetEmbeds = blockNode.querySelectorAll('.ws-widget-host, .bitpype-module-embed, .bitpype-form-embed');
          if (widgetEmbeds.length) {
            var wEl = widgetEmbeds[0];
            if (wEl.classList && wEl.classList.contains('ws-widget-host')) {
              embedRestore = {
                kind: wEl.getAttribute('data-ws-embed-kind') || 'module',
                moduleType: wEl.getAttribute('data-ws-module-type') || '',
                token: wEl.getAttribute('data-ws-embed-token') || ''
              };
            } else {
              embedRestore = embedModuleMeta(wEl);
            }
          }
        }
        pushUndo(blockRoot, embedRestore ? { embedRestore: embedRestore } : null);
        blockNode.remove();
        mountFreeformControls();
        mountPageSectionControls();
        mountAiImageControls();
        var blockSaved = serializePage(blockRoot);
        if (embedRestore) blockSaved.embedRemove = embedRestore;
        postFreeformSave(blockSaved);
        return;
      }
      if (dmode === 'page-section') {
        var secNode = delBtn.closest('[data-ws-page-section], section.ws-page-section');
        var secMain = secNode && (secNode.closest('main') || secNode.parentElement);
        if (!secNode || !secMain) return;
        pushUndo(secMain);
        secNode.remove();
        mountFreeformControls();
        mountPageSectionControls();
        mountAiImageControls();
        postFreeformSave(serializePage(secMain));
        return;
      }
      if (dmode === 'freeform') {
        var item = delBtn.closest('.ws-ff-item');
        if (!item || !item.parentElement) return;
        var p = item.parentElement;
        var count = p.querySelectorAll(':scope > .ws-ff-item').length;
        if (count <= 1) {
          try { parent.postMessage({ source: 'ws-preview', type: 'list-error', message: 'Keep at least one item' }, '*'); } catch (err1) {}
          return;
        }
        item.remove();
        renumberChips(p);
        mountFreeformControls();
        mountPageSectionControls();
        mountAiImageControls();
        var saved = serializePage(p);
        try {
          parent.postMessage({
            source: 'ws-preview',
            type: 'list-mutate',
            action: 'freeform-save',
            pageIndex: saved.pageIndex,
            sectionIndex: saved.sectionIndex,
            html: saved.html
          }, '*');
        } catch (errS) {}
        return;
      }
    }

    var aiBtn = e.target && e.target.closest ? e.target.closest('.ws-ai-img') : null;
    if (aiBtn) {
      e.preventDefault();
      e.stopPropagation();
      var hostEl = aiBtn.closest ? aiBtn.closest('.ws-img-host') : null;
      var aiImg = hostEl ? hostEl.querySelector('img') : null;
      if (!aiImg) return;
      var aiSrc = aiImg.getAttribute('src') || '';
      try {
        parent.postMessage({
          source: 'ws-preview',
          type: 'image-ai-generate',
          src: aiSrc,
          absSrc: aiImg.currentSrc || aiImg.src || ''
        }, '*');
      } catch (errAi) {}
      return;
    }

    var img = e.target && e.target.closest ? e.target.closest('img') : null;
    if (img) {
      e.preventDefault();
      e.stopPropagation();
      var src = img.getAttribute('src') || '';
      try {
        parent.postMessage({
          source: 'ws-preview',
          type: 'image-replace',
          src: src,
          absSrc: img.currentSrc || img.src || ''
        }, '*');
      } catch (errImg) {}
      return;
    }
    var el = e.target.closest ? e.target.closest('[data-edit]') : null;
    if (!el && e.target && e.target.closest) {
      var block = e.target.closest('h1,h2,h3,h4,h5,h6,p,li,blockquote,td,th,figcaption');
      if (block && !isChrome(block) && !isModuleOrFormEmbed(block)
        && !(block.closest && block.closest('.bitpype-module-embed, .bitpype-form-embed'))) {
        var innerEdit = block.querySelector('[data-edit]');
        if (innerEdit) {
          var blockText = String(block.textContent || '').replace(/\\s+/g, ' ').trim();
          var innerText = String(innerEdit.textContent || '').replace(/\\s+/g, ' ').trim();
          if (blockText === innerText || block.querySelectorAll('[data-edit]').length === 1) {
            el = innerEdit;
          }
        }
      }
    }
    if (!el) return;
    if (el.closest && el.closest('.bitpype-module-embed, .bitpype-form-embed')) return;
    if (el.getAttribute('contenteditable') === 'true') {
      postSelection(el);
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    el.contentEditable = 'true';
    postSelection(el);
    el.focus();
    try {
      var range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      var sel = window.getSelection();
      if (sel) {
        sel.removeAllRanges();
        sel.addRange(range);
      }
    } catch (errCaret) {}
  }, true);
  document.addEventListener('focusout', function (e) {
    var el = e.target;
    if (!el || !el.getAttribute || !el.getAttribute('data-edit')) return;
    el.contentEditable = 'false';
    parent.postMessage({ source: 'ws-preview', id: el.getAttribute('data-edit'), text: el.innerText }, '*');
  });
  try { parent.postMessage({ source: 'ws-preview', type: 'ready' }, '*'); } catch (err2) {}
})();
</script>`;

/**
 * srcdoc previews inherit the parent app URL as base. Relative nav links
 * (about.html, /contact, …) would otherwise navigate the iframe into the
 * SPA shell. Keep hash/mailto/tel; intercept everything else.
 * Clicks on [data-edit] are left alone so freeform/section inline edit works.
 */
const PREVIEW_NAV_GUARD = `<script data-ws-preview-nav="1">
(function () {
  function filePart(href) {
    try {
      var raw = String(href || '').split('#')[0].split('?')[0];
      return raw.replace(/^\\.\\//, '').replace(/^\\//, '');
    } catch (e) { return ''; }
  }
  function anchorFromFile(file) {
    var f = String(file || '').replace(/\\.html$/i, '').replace(/\\/$/, '');
    if (!f || f === 'index' || f === 'home') return 'home';
    return f.replace(/[^a-z0-9-_]/gi, '_');
  }
  document.addEventListener('click', function (e) {
    // In edit mode, let [data-edit] clicks become contenteditable (not nav).
    if (document.documentElement.classList.contains('ws-editing')
      && e.target && e.target.closest && e.target.closest('[data-edit]')) {
      return;
    }
    var a = e.target && e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    var href = a.getAttribute('href') || '';
    if (!href || href.charAt(0) === '#') return;
    if (/^(mailto:|tel:|javascript:)/i.test(href)) return;
    e.preventDefault();
    e.stopPropagation();
    if (/^https?:\\/\\//i.test(href)) {
      try { parent.postMessage({ source: 'ws-preview-nav', external: true, href: href }, '*'); } catch (err) {}
      return;
    }
    var file = filePart(href);
    var id = anchorFromFile(file);
    var el = id && document.getElementById(id);
    if (el) {
      try { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (err2) { el.scrollIntoView(true); }
      try { history.replaceState({}, '', '#' + id); } catch (err3) {}
      return;
    }
    try {
      parent.postMessage({ source: 'ws-preview-nav', href: href, file: file, slug: id }, '*');
    } catch (err4) {}
  }, true);
})();
</script>`;

/* ------------------------------------------------------------------ */
/* Freeform HTML inline edit — wrap / patch visible text nodes          */
/* ------------------------------------------------------------------ */

const FREEFORM_VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);
const FREEFORM_SKIP_TAGS = new Set(['script', 'style', 'noscript', 'svg', 'template']);

/**
 * Walk HTML string; invoke onText(text, start, end) for each text run outside
 * script/style/svg and outside tel:/mailto: anchors (locked contact links).
 */
function walkFreeformTextRuns(html, onText) {
  const s = String(html || '');
  const re = /<!--[\s\S]*?-->|<\/?[a-zA-Z][^>]*>/g;
  let last = 0;
  let skip = 0;
  let lockLink = 0;
  let m;
  while ((m = re.exec(s))) {
    if (m.index > last && skip === 0 && lockLink === 0) {
      onText(s.slice(last, m.index), last, m.index);
    }
    const tag = m[0];
    if (tag.startsWith('<!--')) {
      last = m.index + tag.length;
      continue;
    }
    const open = /^<([a-zA-Z][\w:-]*)/.exec(tag);
    const close = /^<\/([a-zA-Z][\w:-]*)/.exec(tag);
    if (close) {
      const name = close[1].toLowerCase();
      if (FREEFORM_SKIP_TAGS.has(name) && skip > 0) skip -= 1;
      if (name === 'a' && lockLink > 0) lockLink -= 1;
    } else if (open) {
      const name = open[1].toLowerCase();
      const selfClosing = /\/>$/.test(tag) || FREEFORM_VOID_TAGS.has(name);
      if (!selfClosing && FREEFORM_SKIP_TAGS.has(name)) skip += 1;
      if (!selfClosing && name === 'a' && /\bhref\s*=\s*(['"])\s*(tel:|mailto:)/i.test(tag)) {
        lockLink += 1;
      }
    }
    last = m.index + tag.length;
  }
  if (last < s.length && skip === 0 && lockLink === 0) {
    onText(s.slice(last), last, s.length);
  }
}

function splitHtmlBody(html) {
  const s = String(html || '');
  const m = /(<body\b[^>]*>)([\s\S]*)(<\/body\s*>)/i.exec(s);
  if (!m) return null;
  return {
    before: s.slice(0, m.index) + m[1],
    body: m[2],
    after: m[3] + s.slice(m.index + m[0].length),
  };
}

/** Body inner HTML as used by multipage preview stacking (post-sanitize). */
/**
 * Wrap non-empty text runs with <span class="ws-edit" data-edit="…">.
 * - Legacy page.html: html:pageIndex:nodeIndex
 * - Modular section content.html: html:pageIndex:sectionIndex:nodeIndex
 * Indices match applyFreeformTextEdits on the same inner HTML.
 */
function markFreeformTextNodes(html, pageIndex, sectionIndex) {
  const s = String(html || '');
  const pi = Math.max(0, Number(pageIndex) || 0);
  const siRaw = sectionIndex != null ? Number(sectionIndex) : NaN;
  const si = Number.isInteger(siRaw) && siRaw >= 0 ? siRaw : null;
  const parts = [];
  let cursor = 0;
  let idx = 0;
  walkFreeformTextRuns(s, (text, start, end) => {
    if (start > cursor) parts.push(s.slice(cursor, start));
    if (text.trim()) {
      const id = si != null ? `html:${pi}:${si}:${idx}` : `html:${pi}:${idx}`;
      idx += 1;
      parts.push(`<span class="ws-edit" data-edit="${esc(id)}">${text}</span>`);
    } else {
      parts.push(text);
    }
    cursor = end;
  });
  if (cursor < s.length) parts.push(s.slice(cursor));
  return parts.join('');
}

/** Sanitize (+ mark when portal edit mode) freestyle HTML stored on a section. */
function markEditableSectionHtml(html, edit) {
  const cleaned = sanitizeHtml(html);
  if (!edit || !edit.editing) return cleaned;
  return markFreeformTextNodes(cleaned, edit.page, edit.section);
}

/**
 * Apply portal freeform edits (ids html:pageIndex:nodeIndex) to page HTML.
 * Uses the same sanitize + body extract path as preview marking.
 */
function applyFreeformTextEdits(pageHtml, editsByIndex) {
  const map =
    editsByIndex instanceof Map
      ? editsByIndex
      : new Map(Object.entries(editsByIndex || {}).map(([k, v]) => [Number(k), v]));
  if (!map.size) return String(pageHtml || '');

  const original = String(pageHtml || '');
  const sanitized = sanitizeHtml(original);
  const split = looksLikeFullDocument(original) || looksLikeFullDocument(sanitized) ? splitHtmlBody(sanitized) : null;
  const target = split ? split.body : sanitized;
  const parts = [];
  let cursor = 0;
  let idx = 0;
  walkFreeformTextRuns(target, (text, start, end) => {
    if (start > cursor) parts.push(target.slice(cursor, start));
    if (text.trim()) {
      if (map.has(idx)) {
        parts.push(esc(map.get(idx)));
      } else {
        parts.push(text);
      }
      idx += 1;
    } else {
      parts.push(text);
    }
    cursor = end;
  });
  if (cursor < target.length) parts.push(target.slice(cursor));
  const nextBody = parts.join('');
  if (split) return split.before + nextBody + split.after;
  return nextBody;
}

function markFreeformDocument(html, pageIndex) {
  const s = String(html || '');
  const split = splitHtmlBody(s);
  if (split) {
    return split.before + markFreeformTextNodes(split.body, pageIndex) + split.after;
  }
  return markFreeformTextNodes(s, pageIndex);
}

/**
 * Single-page freeform previews need data-ws-page so serializePage /
 * freeform-save use the real page index.
 */
function wrapBodyWithPageRoot(html, pageIndex) {
  const s = String(html || '');
  const pi = Math.max(0, Number(pageIndex) || 0);
  const split = splitHtmlBody(s);
  if (!split) {
    if (/data-ws-page\s*=/.test(s)) return s;
    return `<div data-ws-page="${pi}">${s}</div>`;
  }
  if (/data-ws-page\s*=/.test(split.body)) return s;
  return `${split.before}<div data-ws-page="${pi}">${split.body}</div>${split.after}`;
}

function appendHtmlTail(doc, snippet) {
  const s = String(doc || '');
  const bit = String(snippet || '');
  if (!bit) return s;
  if (/<\/body>/i.test(s)) return s.replace(/<\/body>/i, `${bit}</body>`);
  return s + bit;
}

/**
 * srcdoc iframes resolve relative assets against the parent origin.
 * Inject <base href="…/site-previews/folder/"> so images/… and CSS url()
 * resolve to the exported preview host (sanitizeHtml strips author <base>).
 */
function injectPreviewBaseHref(html, baseUrl) {
  let base = String(baseUrl || '').trim();
  if (!base || !/^https?:\/\//i.test(base)) return String(html || '');
  if (!base.endsWith('/')) base += '/';
  const tag = `<base href="${esc(base)}" data-ws-preview-base="1">`;
  let doc = String(html || '');
  if (/data-ws-preview-base\s*=/.test(doc)) {
    return doc.replace(/<base\b[^>]*data-ws-preview-base[^>]*>/i, tag);
  }
  if (/<head\b[^>]*>/i.test(doc)) {
    return doc.replace(/<head\b[^>]*>/i, (m) => `${m}\n${tag}`);
  }
  if (/<html\b[^>]*>/i.test(doc)) {
    return doc.replace(/<html\b[^>]*>/i, (m) => `${m}\n<head>${tag}</head>`);
  }
  return `<!DOCTYPE html><html lang="en"><head>${tag}</head><body>${doc}</body></html>`;
}

function previewScripts(opts) {
  const o = opts || {};
  let out = '';
  if (o.preview)
    out +=
      PREVIEW_NAV_GUARD +
      '<script>' +
      fs
        .readFileSync(path.join(__dirname, '../public/js/preview-bridge.js'), 'utf8')
        .replace(/<\/script/gi, '<\\/script') +
      '</script>';
  if (o.editable) out += PREVIEW_EDIT_STYLE + PREVIEW_EDIT_SCRIPT;
  // Batch 147: the portal layout editor's canvas. Same inlining pattern
  // as preview-bridge.js; only ever set on portal renders (never on
  // exports), so published sites carry no trace of the editor.
  if (o.layoutEditor)
    out +=
      LAYOUT_EDIT_STYLE +
      '<script>' +
      fs
        .readFileSync(path.join(__dirname, '../public/js/layout-bridge.js'), 'utf8')
        .replace(/<\/script/gi, '<\\/script') +
      '</script>';
  return out;
}

/* Batch 147 — canvas chrome for the layout editor: hover/selection
   outlines on section roots + the floating per-section toolbar the
   bridge builds. Scoped under [data-bp-layout-section] so it can
   never restyle the site itself. */
const LAYOUT_EDIT_STYLE = `<style>
[data-bp-layout-section]{outline:2px solid transparent;outline-offset:-2px;transition:outline-color .12s ease}
[data-bp-layout-section].bp-sec-nomobile{outline:2px dashed rgba(179,55,42,.65)}
.bp-layout-dim{opacity:.55}
.bp-layout-chip{display:inline-flex;align-items:center;background:rgba(240,180,41,.16);color:#f0b429;border:1px solid rgba(240,180,41,.45);border-radius:999px;padding:2px 8px;font-size:11px;font-weight:600;white-space:nowrap}
@media (max-width:700px){[data-bp-layout-section].bp-sec-nomobile{display:block!important}}
[data-bp-layout-section]:hover{outline-color:rgba(14,122,104,.55)}
[data-bp-layout-section][data-bp-layout-selected="1"]{outline-color:#0e7a68}
[data-bp-layout-section][data-bp-layout-drop="before"]{box-shadow:0 -4px 0 0 #0e7a68}
[data-bp-layout-section][data-bp-layout-drop="after"]{box-shadow:0 4px 0 0 #0e7a68}
.bp-layout-toolbar{position:absolute;z-index:2147483000;display:flex;gap:4px;align-items:center;background:#1c140f;color:#fffaf4;border-radius:10px;padding:6px 8px;box-shadow:0 8px 24px rgba(28,20,15,.35);font:500 13px/1.2 Figtree,'Segoe UI',Arial,sans-serif}
.bp-layout-toolbar .bp-lt-label{max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0 4px;color:#f3eadf}
.bp-layout-toolbar button{appearance:none;border:1px solid rgba(255,250,244,.25);background:rgba(255,250,244,.08);color:#fffaf4;border-radius:7px;min-width:30px;height:30px;padding:0 8px;cursor:pointer;font:inherit}
.bp-layout-toolbar button:hover:not(:disabled){background:rgba(255,250,244,.2)}
.bp-layout-toolbar button:disabled{opacity:.35;cursor:not-allowed}
.bp-layout-toolbar .bp-lt-handle{cursor:grab;touch-action:none}
.bp-layout-toolbar .bp-lt-handle:active{cursor:grabbing}
</style>`;

/**
 * Safe extra class tokens from agent section.className / content.class.
 * Lets customCss target modules without rewriting renderers.
 */
function sectionExtraClass(section, content) {
  const raw = [
    section && section.className,
    section && section.class,
    content && content.className,
    content && content.class,
  ]
    .filter((v) => typeof v === 'string' && v.trim())
    .join(' ');
  return raw
    .split(/\s+/)
    .map((c) => c.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64))
    .filter(Boolean)
    .slice(0, 12)
    .join(' ');
}

/** Safe CSS declarations for optional section/content.style + background fields. */
function sectionInlineStyle(section, content) {
  const parts = [];
  const raw = [section && section.style, content && content.style].find((v) => typeof v === 'string' && v.trim());
  if (raw) {
    let s = String(raw).slice(0, 600);
    s = s.replace(/[{}]/g, '').replace(/<\/?style/gi, '');
    s = s.replace(/expression\s*\(/gi, '').replace(/javascript:/gi, '');
    // Keep only safe url(...) — https or images/…
    s = s.replace(/url\s*\(\s*(['"]?)([^)'"]+)\1\s*\)/gi, (_, _q, inner) => {
      const ok = safeImageUrl(String(inner || '').trim());
      return ok ? `url("${ok}")` : '';
    });
    if (s.trim()) parts.push(s.trim());
  }
  const bgColor = contentBackgroundColor(content);
  if (bgColor) parts.push(`background-color:${bgColor}`);
  const bgImg = contentBackgroundImageUrl(content);
  if (bgImg) {
    parts.push(`background-image:url("${bgImg}")`);
    parts.push('background-size:cover');
    parts.push('background-position:center');
  }
  return parts.join(';');
}

/**
 * Stamp data-ws-section-* (+ optional class/style) on the section root tag
 * so theme.customCss can style modules freely while content stays structured.
 */
function decorateSectionRoot(html, section, content, edit) {
  const out = String(html || '');
  if (!out.trim()) return '';
  const type =
    String(section.type || 'custom')
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '')
      .slice(0, 40) || 'custom';
  // Batch 148: layout-knob classes, stamped ONLY when a knob is set —
  // a knob-free section's root is byte-identical to before.
  const knobClasses = [];
  if (section && section.width === 'full') knobClasses.push('bp-sec-full');
  if (section && section.hideOnMobile === true) knobClasses.push('bp-sec-nomobile');
  const extra = [sectionExtraClass(section, content), ...knobClasses].filter(Boolean).join(' ');
  const style = sectionInlineStyle(section, content);
  const sid = typeof section.id === 'string' ? section.id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) : '';
  return out.replace(/^(\s*)<([a-zA-Z][\w-]*)(\s[^>]*)?>/, (m, ws, tag, rest) => {
    let r = rest || '';
    if (!/\bdata-ws-section-type\s*=/.test(r)) {
      r += ` data-ws-section="1" data-ws-section-type="${esc(type)}"`;
    }
    if (edit && Number.isInteger(edit.page) && Number.isInteger(edit.section)) {
      if (!/\bdata-ws-page\s*=/.test(r)) r += ` data-ws-page="${Number(edit.page)}"`;
      if (!/\bdata-ws-section-index\s*=/.test(r)) r += ` data-ws-section-index="${Number(edit.section)}"`;
      // Batch 147: layout-editor canvas marker (portal renders only).
      if (edit.layout && !/\bdata-bp-layout-section\s*=/.test(r)) r += ' data-bp-layout-section="1"';
    }
    if (sid && !/\bid\s*=/.test(r)) r += ` id="${esc(sid)}"`;
    if (extra) {
      if (/\bclass\s*=\s*"/i.test(r)) {
        r = r.replace(/\bclass\s*=\s*"([^"]*)"/i, (_, c) => `class="${c} ${extra}"`);
      } else if (/\bclass\s*=\s*'/i.test(r)) {
        r = r.replace(/\bclass\s*=\s*'([^']*)'/i, (_, c) => `class='${c} ${extra}'`);
      } else {
        r += ` class="${extra}"`;
      }
    }
    if (style) {
      if (/\bstyle\s*=\s*"/i.test(r)) {
        r = r.replace(/\bstyle\s*=\s*"([^"]*)"/i, (_, s) => `style="${s};${style}"`);
      } else {
        r += ` style="${esc(style)}"`;
      }
    }
    return `${ws}<${tag}${r}>`;
  });
}

/**
 * Render one section to HTML. Unknown types use the generic custom block
 * so an agent is not stuck to the built-in list. Text is escaped.
 * Visual design is free: theme.customCss targets [data-ws-section-type="…"].
 */
function sectionToHtml(section, theme, edit) {
  const t = normalizeTheme(theme);
  try {
    if (!section || typeof section.type !== 'string') return '<!-- invalid section -->';
    const fn = RENDERERS[section.type] || cCustom;
    const content = section.content && typeof section.content === 'object' ? section.content : {};
    const body =
      fn === cCustom && !RENDERERS[section.type]
        ? Object.assign({ heading: content.heading || content.title || section.type }, content)
        : content;
    const html = fn(body, t, edit || null) || '';
    return decorateSectionRoot(html, section, content, edit || null);
  } catch (e) {
    return `<!-- section render error: ${esc(e.message || 'unknown')} -->`;
  }
}

/* ------------------------------------------------------------------ */
/* page / site rendering                                               */
/* ------------------------------------------------------------------ */

/**
 * Canonical export filename for a page slug (Batch 31 — C1 URL unification).
 * ONE canonical form everywhere: nested dash paths, e.g. slug
 * "services/20-yard-dumpster-rental" → file "services/20-yard-dumpster-rental.html",
 * served at the canonical URL "/services/20-yard-dumpster-rental".
 * The pre-Batch-31 form flattened "/" and other separators to "_"
 * (services_20-yard-dumpster-rental.html) — see legacyPageFileName, kept
 * only so exports can redirect legacy URLs and normalize legacy links.
 */
function canonicalSlugPath(slug) {
  const raw = String(slug || '/')
    .trim()
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
  if (!raw || raw === 'home' || raw === 'index' || raw === 'index.html') return '';
  return raw
    .split('/')
    .map((seg) =>
      seg
        .replace(/\.html?$/i, '')
        .toLowerCase()
        .replace(/[^a-z0-9-_]+/g, '-')
        .replace(/^-+|-+$/g, '')
    )
    .filter(Boolean)
    .join('/');
}

function pageFileName(slug) {
  const p = canonicalSlugPath(slug);
  if (!p) return 'index.html';
  return `${p}.html`;
}

/** Pre-Batch-31 filename form (separators flattened to "_"). Legacy only. */
function legacyPageFileName(slug) {
  const s = String(slug || '/')
    .replace(/^\//, '')
    .replace(/\/$/, '');
  if (!s || s === 'home' || s === 'index') return 'index.html';
  return s.replace(/[^a-z0-9-_]/gi, '_') + '.html';
}

/**
 * Canonical public URL path for a page: home → "/", others →
 * "/services/20-yard-dumpster-rental" (extensionless, dash form).
 * This is the ONLY form internal links, canonicals and sitemaps use.
 */
function pageUrlPath(slug) {
  const p = canonicalSlugPath(slug);
  return p ? `/${p}` : '/';
}

/** Map any internal href spelling (file, legacy file, canonical) to its page. */
function pageForHref(href, pages) {
  if (!Array.isArray(pages) || !pages.length) return null;
  const h = String(href || '').trim();
  if (!h || /^(mailto:|tel:|javascript:|https?:|\/\/)/i.test(h)) return null;
  const home = homePage(pages);
  let bare = h.split('#')[0].split('?')[0].replace(/^\.\//, '');
  if (bare.startsWith('/')) bare = bare.slice(1);
  bare = bare.replace(/\/$/, '');
  if (!bare || bare === 'index' || bare === 'index.html' || bare === 'home' || bare === 'home.html') return home;
  const target = bare.replace(/\.html?$/i, '').toLowerCase();
  for (const p of pages) {
    if (p === home || isHomePage(p, pages)) continue;
    const canon = canonicalSlugPath(p.slug);
    if (canon && target === canon) return p;
    const legacy = legacyPageFileName(p.slug).replace(/\.html?$/i, '').toLowerCase();
    if (legacy && target === legacy) return p;
    const flat = canon.replace(/\//g, '-');
    if (flat && target === flat) return p;
  }
  return null;
}

/**
 * Rewrite internal page links in exported HTML to the ONE canonical URL
 * form (extensionless dash path). Recognizes canonical paths, exported
 * filenames (flat + nested), legacy underscore filenames, and bare slugs.
 * External/mailto/tel/anchor-only hrefs are untouched.
 */
function normalizeInternalLinksToCanonical(html, pages) {
  let s = String(html || '');
  if (!Array.isArray(pages) || !pages.length) return s;
  s = s.replace(/\bhref\s*=\s*(["'])([^"']+)\1/gi, (whole, quote, href) => {
    const trimmed = String(href || '').trim();
    if (!trimmed || trimmed.startsWith('#')) return whole;
    const hashIdx = trimmed.indexOf('#');
    const frag = hashIdx >= 0 ? trimmed.slice(hashIdx) : '';
    const noFrag = hashIdx >= 0 ? trimmed.slice(0, hashIdx) : trimmed;
    const qIdx = noFrag.indexOf('?');
    const query = qIdx >= 0 ? noFrag.slice(qIdx) : '';
    const page = pageForHref(trimmed, pages);
    if (!page) return whole;
    return `href=${quote}${pageUrlPath(page.slug)}${query}${frag && frag !== '#' ? frag : ''}${quote}`;
  });
  return s;
}

/**
 * Canonical route key for nav / page identity comparisons.
 * "/", "/index", "index", "index.html", "/index.html", "home", "/home" → "index".
 * Leading slash, trailing slash, and .html suffix are ignored for every page.
 */
function normalizeRoute(hrefOrSlug) {
  let s = String(hrefOrSlug == null ? '' : hrefOrSlug)
    .trim()
    .toLowerCase();
  if (!s || s === '/' || s === '#') return 'index';
  if (s.charAt(0) === '#') {
    s = s.slice(1).split('?')[0];
  } else {
    s = s.split('#')[0].split('?')[0];
  }
  s = s.replace(/^(\.\.\/)+/, '').replace(/^\.\//, '');
  s = s.replace(/^\/+/, '').replace(/\/+$/, '');
  s = s.replace(/\.html?$/i, '');
  s = s.replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '');
  if (!s || s === 'home' || s === 'index') return 'index';
  return s;
}

function navAnchorLabel(innerHtml) {
  return String(innerHtml || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** True when href is a same-site page path (including bare "/"). */
function isComparableNavHref(href) {
  const h = String(href || '').trim();
  if (!h || /^(mailto:|tel:|javascript:|https?:|\/\/)/i.test(h)) return false;
  if (h.charAt(0) === '#') return /^#[A-Za-z][A-Za-z0-9_-]*$/.test(h);
  const path = h.split('#')[0].split('?')[0];
  if (path === '/' || path === '') return true;
  return /^(\.\.\/|\.\/|\/)?[A-Za-z0-9][A-Za-z0-9_-]*(\.html?)?$/i.test(path);
}

function isNavIdentitySkipAttrs(attrs) {
  const a = String(attrs || '');
  // Brand / logo share home href by design — skip so Home is not stripped as a "duplicate".
  // CTAs/buttons (nav-cta, btn, …) ARE compared by route + label so "Book Now" ×2 collapses.
  if (/\bdata-ws-brand\b/i.test(a)) return true;
  if (/\bdata-ws-logo\b/i.test(a)) return true;
  if (/\bclass\s*=\s*["'][^"']*\b(brand|logo|site-logo|navbar-brand|brand-logo)\b/i.test(a)) return true;
  return false;
}

function findNavDuplicateIssues(html) {
  const issues = [];
  const src = String(html || '');
  const navRe = /<nav\b[^>]*>[\s\S]*?<\/nav>/gi;
  let navMatch;
  let navIdx = 0;
  while ((navMatch = navRe.exec(src))) {
    navIdx += 1;
    const nav = navMatch[0];
    const seenRoutes = new Set();
    const seenLabels = new Set();
    const linkRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = linkRe.exec(nav))) {
      const attrs = m[1] || '';
      if (isNavIdentitySkipAttrs(attrs)) continue;
      const href = attrs.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>]+))/i) || [];
      const hrefVal = href[1] || href[2] || href[3] || '';
      if (!isComparableNavHref(hrefVal)) continue;
      const route = normalizeRoute(hrefVal);
      const label = navAnchorLabel(m[2]);
      if (seenRoutes.has(route)) {
        issues.push({ nav: navIdx, kind: 'route', route, label, href: hrefVal });
      }
      if (label && seenLabels.has(label)) {
        issues.push({ nav: navIdx, kind: 'label', route, label, href: hrefVal });
      }
      seenRoutes.add(route);
      if (label) seenLabels.add(label);
    }
  }
  return issues;
}

/**
 * Drop duplicate page links inside each <nav> (same normalizeRoute or same label).
 * Keeps the first occurrence so author-provided links win over later injects.
 */
function dedupeNavHtml(html) {
  const src = String(html || '');
  if (!/<nav\b/i.test(src)) return src;
  return src.replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi, (navBlock) => {
    const openEnd = navBlock.indexOf('>') + 1;
    const closeStart = navBlock.lastIndexOf('</');
    if (openEnd <= 0 || closeStart <= openEnd) return navBlock;
    const open = navBlock.slice(0, openEnd);
    const close = navBlock.slice(closeStart);
    let inner = navBlock.slice(openEnd, closeStart);
    const seenRoutes = new Set();
    const seenLabels = new Set();
    // Walk anchors back-to-front so index math stays valid while deleting.
    const hits = [];
    const linkRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = linkRe.exec(inner))) {
      const attrs = m[1] || '';
      if (isNavIdentitySkipAttrs(attrs)) continue;
      const href = attrs.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>]+))/i) || [];
      const hrefVal = href[1] || href[2] || href[3] || '';
      if (!isComparableNavHref(hrefVal)) continue;
      hits.push({
        start: m.index,
        end: m.index + m[0].length,
        route: normalizeRoute(hrefVal),
        label: navAnchorLabel(m[2]),
        html: m[0],
      });
    }
    const drop = new Set();
    for (const hit of hits) {
      const routeDup = seenRoutes.has(hit.route);
      const labelDup = !!(hit.label && seenLabels.has(hit.label));
      if (routeDup || labelDup) {
        drop.add(hit);
        continue;
      }
      seenRoutes.add(hit.route);
      if (hit.label) seenLabels.add(hit.label);
    }
    if (!drop.size) return navBlock;
    // Prefer removing the wrapping <li> when the duplicate is a list item.
    const removals = [];
    for (const hit of drop) {
      let start = hit.start;
      let end = hit.end;
      const before = inner.slice(Math.max(0, start - 80), start);
      const after = inner.slice(end, end + 12);
      const liOpen = before.match(/<li\b[^>]*>\s*$/i);
      if (liOpen && /^(\s*)<\/li>/i.test(after)) {
        start = start - liOpen[0].length;
        end = end + after.match(/^(\s*)<\/li>/i)[0].length;
      }
      removals.push({ start, end });
    }
    removals.sort((a, b) => b.start - a.start);
    for (const r of removals) {
      inner = inner.slice(0, r.start) + inner.slice(r.end);
    }
    // Collapse leftover empty list shells / double whitespace between tags.
    inner = inner.replace(/<li\b[^>]*>\s*<\/li>/gi, '');
    inner = inner.replace(/(?:\s*\n){3,}/g, '\n\n');
    return open + inner + close;
  });
}

/** Log loudly when a <nav> would contain duplicate route/label anchors, then dedupe. */
function assertAndDedupeNavHtml(html, context) {
  const issues = findNavDuplicateIssues(html);
  if (issues.length) {
    const where = context ? ` (${context})` : '';
    console.error(
      `[nav-dedupe] DUPLICATE nav anchors${where}:`,
      issues.map((i) => `${i.kind}:${i.route || ''}:${i.label || ''} href=${i.href}`).join('; ')
    );
  }
  return dedupeNavHtml(html);
}

function anchorId(slug) {
  const route = normalizeRoute(slug);
  return route === 'index' ? 'home' : route.replace(/[^a-z0-9-_]/gi, '_');
}

function isHomePage(page, pages) {
  if (!page) return false;
  const slug = String(page.slug || '');
  if (
    slug === '/' ||
    slug === 'home' ||
    slug === '/home' ||
    slug === 'index' ||
    slug === '/index' ||
    /^\/?(?:home|index)(?:\.html)?$/i.test(slug)
  )
    return true;
  return Array.isArray(pages) && pages[0] === page;
}

function pageHasHtml(page) {
  // Structured sections win — legacy page.html is ignored when sections exist.
  if (page && Array.isArray(page.sections) && page.sections.length > 0) return false;
  return !!(page && typeof page.html === 'string' && page.html.trim());
}

function homePage(pages) {
  if (!Array.isArray(pages) || !pages.length) return null;
  return pages.find((p) => isHomePage(p, pages)) || pages[0];
}

/** Map file-style / path-style nav links to #anchors so stacked iframe previews can navigate. */
function rewriteFileLinksToAnchors(html, pages) {
  let s = String(html || '');
  const home = homePage(pages);
  const escapeRe = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const p of pages || []) {
    const isHome = p === home || isHomePage(p, pages);
    const file = isHome ? 'index.html' : pageFileName(p.slug);
    const bare = file.replace(/\.html$/i, '');
    const id = anchorId(p.slug);
    const patterns = new Set([file, bare, `./${file}`, `./${bare}`, `/${file}`, `/${bare}`]);
    // Canonical URL path + legacy underscore filename forms (Batch 31).
    const canon = pageUrlPath(p.slug);
    if (canon !== '/') {
      patterns.add(canon);
      patterns.add(`${canon}.html`);
    }
    if (!isHome) {
      const legacy = legacyPageFileName(p.slug);
      const legacyBare = legacy.replace(/\.html$/i, '');
      [legacy, legacyBare, `./${legacy}`, `/${legacy}`, `/${legacyBare}`].forEach((x) => patterns.add(x));
    }
    if (isHome) {
      ['/', '/index.html', 'index.html', './index.html', 'home', '/home', 'home.html', './home.html'].forEach((x) =>
        patterns.add(x)
      );
    }
    for (const pat of patterns) {
      const re = new RegExp(`href=(["'])${escapeRe(pat)}\\1`, 'gi');
      s = s.replace(re, `href="#${id}"`);
    }
  }
  s = s.replace(/href=(["'])\/(?:index\.html)?\1/gi, 'href="#home"');
  return s;
}

/**
 * Inverse of rewriteFileLinksToAnchors for static export / Cloudflare Pages.
 * Multipage freeform HTML often uses #services / #about page hashes (works in
 * stacked preview). On real multipage hosts those hashes stay on the current
 * file and break nav — rewrite them to the exported filenames.
 * Same-page section ids that are NOT page slugs (e.g. #main) are left alone.
 * No-op for single-page / landing sites.
 */
function rewriteAnchorLinksToFiles(html, pages) {
  if (!Array.isArray(pages) || pages.length < 2) return String(html || '');
  let s = String(html || '');
  const home = homePage(pages);
  const escapeRe = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const seen = new Set();
  // Longer anchor ids first so #service-areas beats #service if both exist.
  const targets = pages
    .map((p) => {
      return {
        id: anchorId(p.slug),
        // Batch 31: hash links become the canonical URL path on export.
        file: pageUrlPath(p.slug),
      };
    })
    .filter((t) => t.id && !seen.has(t.id) && (seen.add(t.id) || true))
    .sort((a, b) => b.id.length - a.id.length);
  for (const t of targets) {
    const re = new RegExp(`href=(["'])#${escapeRe(t.id)}\\1`, 'gi');
    s = s.replace(re, `href=$1${t.file}$1`);
  }
  return s;
}

/** Persist multipage file hrefs in stored freeform HTML (source of truth). */
function normalizePagesNavLinks(pages) {
  if (!Array.isArray(pages) || pages.length < 2) return pages;
  return pages.map((p) => {
    if (!p || typeof p.html !== 'string' || !p.html.trim()) return p;
    return { ...p, html: rewriteAnchorLinksToFiles(p.html, pages) };
  });
}

/**
 * After writeStaticPages: every page-slug hash link should be a real file, and
 * relative *.html (or extensionless) nav targets should exist on disk.
 */
function validateExportNavLinks(pages, outDir) {
  if (!Array.isArray(pages) || pages.length < 2) {
    return { ok: true, danglingHashes: [], missing: [], checked: 0 };
  }
  const home = homePage(pages);
  const pageIds = new Set();
  const expectedFiles = new Set();
  for (const p of pages) {
    const isHome = p === home || isHomePage(p, pages);
    pageIds.add(anchorId(p.slug));
    expectedFiles.add(isHome ? 'index.html' : pageFileName(p.slug));
  }
  const danglingHashes = [];
  const missing = [];
  let checked = 0;
  for (const p of pages) {
    const isHome = p === home || isHomePage(p, pages);
    const file = isHome ? 'index.html' : pageFileName(p.slug);
    const abs = path.join(outDir, file);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      missing.push(file);
      continue;
    }
    const html = fs.readFileSync(abs, 'utf8');
    const hrefs = [...html.matchAll(/\bhref\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
    for (const href of hrefs) {
      if (!href || /^(mailto:|tel:|https?:|javascript:)/i.test(href)) continue;
      if (href.charAt(0) === '#') {
        const id = String(href.slice(1).split('?')[0] || '');
        if (id && pageIds.has(id)) danglingHashes.push(`${file}:${href}`);
        continue;
      }
      let bare = href.split('#')[0].split('?')[0].replace(/^\.\//, '');
      if (bare.startsWith('/')) bare = bare.slice(1);
      if (!bare) continue;
      let target = null;
      if (expectedFiles.has(bare)) target = bare;
      else if (!bare.endsWith('.html') && expectedFiles.has(`${bare}.html`)) target = `${bare}.html`;
      if (!target) {
        // Canonical URL path (/services/20-yard-…) resolves through the
        // page map (Batch 31). Any other resolvable spelling (legacy
        // underscore filename, flat-dash path) is a defect: exported
        // links must use the ONE canonical form.
        const page = pageForHref(href, pages);
        if (page) {
          target = page === home || isHomePage(page, pages) ? 'index.html' : pageFileName(page.slug);
          const canonBare = pageUrlPath(page.slug).slice(1);
          const canonicalSpellings = new Set(
            page === home || isHomePage(page, pages)
              ? ['', 'index', 'index.html', 'home', 'home.html']
              : [canonBare, `${canonBare}.html`]
          );
          if (!canonicalSpellings.has(bare.toLowerCase())) {
            missing.push(`${file}->${href} (non-canonical)`);
          }
        }
      }
      if (!target) continue;
      checked += 1;
      if (!fs.existsSync(path.join(outDir, target))) missing.push(`${file}->${href}`);
    }
  }
  return {
    ok: danglingHashes.length === 0 && missing.length === 0,
    danglingHashes,
    missing,
    checked,
  };
}

/** Batch 147: edit-shaped marker for layout-editor renders — carries
 *  page/section indexes for root stamping but editing:false, so no
 *  text-edit spans are ever emitted into the layout canvas. */
function makeLayoutEdit(pageIndex, sectionIndex) {
  return { page: pageIndex, section: sectionIndex, editing: false, fonts: null, layout: true };
}

function makeEdit(theme, pageIndex, sectionIndex, editable) {
  const fonts = theme && theme.elementFonts && typeof theme.elementFonts === 'object' ? theme.elementFonts : null;
  const hasFonts = !!(fonts && Object.keys(fonts).length);
  if (!editable && !hasFonts) return null;
  return {
    page: pageIndex,
    section: sectionIndex,
    editing: !!editable,
    fonts,
  };
}

/**
 * Google Fonts stylesheet for families used by the theme and page markup.
 * Replaces a previous data-ws-fonts link so re-renders do not stack tags.
 */
function upsertFontLinks(docHtml, theme, extraText) {
  let html = String(docHtml || '');
  const t = normalizeTheme(theme);
  const blob = [
    t.font,
    t.headingFont,
    t.elementFonts ? Object.values(t.elementFonts).join(' ') : '',
    extraText || '',
    html,
  ].join('\n');
  const href = googleFonts.hrefFor(googleFonts.namesIn(blob));
  html = html.replace(/<link\b[^>]*data-ws-fonts\s*=\s*["']1["'][^>]*>\s*/gi, '');
  if (!href) return html;
  const tag = `<link data-ws-fonts="1" rel="stylesheet" href="${esc(href)}">`;
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${tag}\n</head>`);
  if (/<head\b[^>]*>/i.test(html)) return html.replace(/<head\b[^>]*>/i, (m) => `${m}\n${tag}`);
  if (/<html\b[^>]*>/i.test(html)) return html.replace(/<html\b[^>]*>/i, (m) => `${m}\n<head>${tag}</head>`);
  return `<!DOCTYPE html><html lang="en"><head>${tag}</head><body>${html}</body></html>`;
}

function pageMetaFields(page) {
  const p = page && typeof page === 'object' ? page : {};
  const description = String(p.description || p.metaDescription || p.meta_description || '')
    .trim()
    .slice(0, 320);
  const ogImage =
    safeImageUrl(String(p.ogImage || p.og_image || p.ogImageUrl || '').trim()) ||
    String(p.ogImage || p.og_image || '')
      .trim()
      .slice(0, 500);
  const canonical = String(p.canonical || p.canonicalUrl || p.canonical_url || '')
    .trim()
    .slice(0, 500);
  const customJs =
    typeof p.customJs === 'string'
      ? sanitizeJs(p.customJs)
      : typeof p.custom_js === 'string'
        ? sanitizeJs(p.custom_js)
        : '';
  const customHead =
    typeof p.customHead === 'string'
      ? sanitizeHead(p.customHead)
      : typeof p.custom_head === 'string'
        ? sanitizeHead(p.custom_head)
        : '';
  const overrideChrome =
    p.chromeOverride === true || p.chrome_override === true || p.useSiteChrome === false || p.use_site_chrome === false;
  // Batch 31 (H): per-page noindex flag for thank-you / utility pages.
  const noindex = p.noindex === true || p.noIndex === true || p.no_index === true || p.robotsNoindex === true;
  // Batch 32: og:type override (static blog post pages ship "article").
  const ogType = String(p.ogType || p.og_type || '')
    .trim()
    .slice(0, 40);
  return { description, ogImage, canonical, customJs, customHead, overrideChrome, noindex, ogType };
}

function pageJsTag(pageJs) {
  const js = pageJs && String(pageJs).trim();
  if (!js) return '';
  return `<script data-ws-page-js="1">${js}</script>`;
}

function faviconLinkTag(theme) {
  const t = normalizeTheme(theme);
  const href = t.favicon ? safeImageUrl(t.favicon) || t.favicon : '';
  if (!href) return '';
  const type = /\.svg$/i.test(href)
    ? 'image/svg+xml'
    : /\.png$/i.test(href)
      ? 'image/png'
      : /\.ico$/i.test(href)
        ? 'image/x-icon'
        : '';
  const typeAttr = type ? ` type="${type}"` : '';
  // data-ws-favicon marks engine-injected tags so freeform re-render can replace them.
  return `<link data-ws-favicon="1" rel="icon"${typeAttr} href="${esc(href)}">`;
}

/**
 * Freeform full documents go through sanitizeHtml, which strips <link rel="icon">
 * (only https stylesheet/preconnect/preload survive). Inject theme.favicon into <head>
 * so setFavicon / theme.favicon reach exported + CF Pages HTML.
 */
function injectFaviconLink(docHtml, theme) {
  let doc = String(docHtml || '');
  if (!doc.trim()) return doc;
  doc = doc.replace(/<link\b[^>]*\bdata-ws-favicon\s*=\s*["']1["'][^>]*>\s*/gi, '');
  doc = doc.replace(/<link\b[^>]*\brel\s*=\s*["'](?:shortcut\s+)?icon["'][^>]*>\s*/gi, '');
  const tag = faviconLinkTag(theme);
  if (!tag) return doc;
  if (/<\/head>/i.test(doc)) return doc.replace(/<\/head>/i, `${tag}\n</head>`);
  if (/<head\b[^>]*>/i.test(doc)) return doc.replace(/<head\b[^>]*>/i, (m) => `${m}\n${tag}`);
  if (/<html\b[^>]*>/i.test(doc)) {
    return doc.replace(/<html\b[^>]*>/i, (m) => `${m}\n<head>${tag}</head>`);
  }
  return `<!DOCTYPE html><html lang="en"><head>${tag}</head><body>${doc}</body></html>`;
}

function docShell({
  title,
  body,
  theme,
  script,
  description,
  ogImage,
  canonical,
  pageJs,
  pageHead,
  noindex,
  seoHead,
  gscToken,
  ogType,
  sectionLayoutCss: pageSectionLayoutCss,
}) {
  const t = normalizeTheme(theme);
  const themeJs = themeJsTag(t);
  const pageJsTagHtml = pageJsTag(pageJs);
  const themeHead = themeHeadInject(t);
  const pageHeadHtml = pageHeadInject(pageHead);
  const desc = (description && String(description).trim()) || title || '';
  const fav = faviconLinkTag(t);
  const ogImg = ogImage && String(ogImage).trim() ? String(ogImage).trim() : '';
  const canon = canonical && String(canonical).trim() ? String(canonical).trim() : '';
  const gsc = gscToken && String(gscToken).trim() ? String(gscToken).trim().slice(0, 200) : '';
  const ogTags = [
    `<meta property="og:title" content="${esc(title)}">`,
    desc ? `<meta property="og:description" content="${esc(desc)}">` : '',
    ogImg ? `<meta property="og:image" content="${esc(ogImg)}">` : '',
    canon ? `<meta property="og:url" content="${esc(canon)}">` : '',
    `<meta property="og:type" content="${esc(ogType && String(ogType).trim() ? String(ogType).trim() : 'website')}">`,
    ogImg ? `<meta name="twitter:card" content="summary_large_image">` : `<meta name="twitter:card" content="summary">`,
    `<meta name="twitter:title" content="${esc(title)}">`,
    desc ? `<meta name="twitter:description" content="${esc(desc)}">` : '',
    ogImg ? `<meta name="twitter:image" content="${esc(ogImg)}">` : '',
  ]
    .filter(Boolean)
    .join('\n');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
${noindex ? '<meta name="robots" content="noindex">' : ''}
${gsc ? `<meta name="google-site-verification" content="${esc(gsc)}">` : ''}
${canon ? `<link rel="canonical" href="${esc(canon)}">` : ''}
${ogTags}
${seoHead || ''}
${fav}
<style data-ws-theme="1">${siteCss(t)}</style>${pageSectionLayoutCss ? `\n<style data-bp-section-layout="1">${pageSectionLayoutCss}</style>` : ''}
${themeHead}
${pageHeadHtml}
</head>
<body>
${body}
${themeJs}
${pageJsTagHtml}
${script || ''}
${spacingGuardScript()}
</body>
</html>`;
}

/** Inject/replace theme.customHead (+ optional page head) before </head>. */
function injectThemeHead(docHtml, theme, pageHead = '') {
  let doc = String(docHtml || '');
  if (!doc.trim()) return doc;
  doc = doc.replace(/<!--data-ws-theme-head-->[\s\S]*?(?=<\/head>)/i, '');
  doc = doc.replace(/<!--data-ws-page-head-->[\s\S]*?(?=<\/head>)/i, '');
  const chunks = [themeHeadInject(theme), pageHeadInject(pageHead)].filter(Boolean).join('\n');
  if (!chunks) return doc;
  if (/<\/head>/i.test(doc)) return doc.replace(/<\/head>/i, `${chunks}\n</head>`);
  if (/<head\b[^>]*>/i.test(doc)) return doc.replace(/<head\b[^>]*>/i, (m) => `${m}\n${chunks}`);
  if (/<html\b[^>]*>/i.test(doc)) {
    return doc.replace(/<html\b[^>]*>/i, (m) => `${m}\n<head>${chunks}</head>`);
  }
  return `<!DOCTYPE html><html lang="en"><head>${chunks}</head><body>${doc}</body></html>`;
}

/* ------------------------------------------------------------------ */
/* SEO foundations (Batch 31)                                          */
/*                                                                     */
/* opts.seo threads the site's SEO context through render/export:      */
/*   { baseUrl,            absolute site base (domain known) or ''     */
/*     business: {...},    LocalBusiness context from the lead record  */
/*     moduleFaqItems: [], published FAQ-module items for FAQPage      */
/*     gscToken: '' }      Google Search Console verification token    */
/* Dedupe rule: an explicit ld+json block in theme.customHead or the   */
/* page's customHead wins for its @type — the auto block for that      */
/* type is skipped (documented in the design prompt, §SEO).            */
/* ------------------------------------------------------------------ */

function seoContextFromOpts(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const seo = o.seo && typeof o.seo === 'object' ? o.seo : null;
  if (seo) return seo;
  // Direct opts (tests / simple callers): { seoBaseUrl, seoBusiness, … }
  if (o.seoBaseUrl != null || o.seoBusiness != null || o.gscToken != null || o.moduleFaqItems != null || o.blog != null) {
    return {
      baseUrl: o.seoBaseUrl || '',
      business: o.seoBusiness || null,
      moduleFaqItems: o.moduleFaqItems || [],
      gscToken: o.gscToken || '',
      blog: o.blog || null,
    };
  }
  return null;
}

function absoluteSeoUrl(baseUrl, urlPath) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) return '';
  const p = urlPath == null ? '/' : String(urlPath);
  return base + (p.startsWith('/') ? p : `/${p}`);
}

function absolutizeSeoUrl(baseUrl, value) {
  const v = String(value || '').trim();
  if (!v) return '';
  if (/^https?:\/\//i.test(v) || v.startsWith('data:')) return v;
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) return v;
  return base + (v.startsWith('/') ? v : `/${v}`);
}

/** First real image on a page (hero/image section, gallery, content image). */
function firstPageImage(page) {
  const sections = page && Array.isArray(page.sections) ? page.sections : [];
  for (const s of sections) {
    const c = (s && s.content) || {};
    const candidates = [
      c.backgroundImage,
      c.image && typeof c.image === 'object' ? c.image.url : c.image,
      c.url,
      Array.isArray(c.images) && c.images[0]
        ? typeof c.images[0] === 'object'
          ? c.images[0].url
          : c.images[0]
        : '',
    ];
    for (const cand of candidates) {
      const v = String(cand || '').trim();
      if (v && !v.startsWith('data:')) return v;
    }
  }
  return '';
}

/** FAQ items authored as page sections ({q, a} in faq section content). */
function faqItemsFromPage(page) {
  const items = [];
  for (const s of (page && page.sections) || []) {
    if (s && s.type === 'faq' && s.content && Array.isArray(s.content.items)) {
      for (const it of s.content.items) if (it) items.push(it);
    }
  }
  return items;
}

/**
 * Build the auto SEO head blocks for one page render: LocalBusiness
 * (home page / single-page sites only — one entity block per site is
 * enough for crawlers) + FAQPage (any page carrying FAQ content).
 * Returns '' when no SEO context is threaded.
 */
function buildSeoHeadExtras(page, pages, theme, opts) {
  const seo = seoContextFromOpts(opts);
  if (!seo) return '';
  const t = normalizeTheme(theme);
  const headHtml = `${t.customHead || ''}\n${pageMetaFields(page).customHead || ''}`;
  const existingTypes = seoSchema.ldJsonTypesIn(headHtml);
  const blocks = [];
  const home = homePage(pages);
  const isHomeRender = page === home || isHomePage(page, pages || [page]);
  if (seo.business && (isHomeRender || !pages || pages.length <= 1)) {
    if (!seoSchema.hasLocalBusinessType(existingTypes)) {
      const biz = Object.assign({}, seo.business);
      if (!biz.url && seo.baseUrl) biz.url = String(seo.baseUrl).replace(/\/+$/, '') + '/';
      if (!biz.image) {
        const img = firstPageImage(page) || (t.logoMode === 'image' ? t.logoUrl : '');
        if (img) biz.image = absolutizeSeoUrl(seo.baseUrl, img);
      }
      const ld = seoSchema.buildLocalBusinessLd(biz);
      if (ld) blocks.push(seoSchema.ldJsonScript(ld, 'localbusiness'));
    }
  }
  if (!existingTypes.has('FAQPage')) {
    // Section-authored FAQs + published FAQ-module items merge into one
    // FAQPage block (deduped by question). Module content mounts most
    // often on the home or faq-slug page.
    const slugKey = canonicalSlugPath(page && page.slug);
    const moduleApplies =
      Array.isArray(seo.moduleFaqItems) && seo.moduleFaqItems.length && (isHomeRender || /(^|\/)faq$/.test(slugKey));
    const seenQ = new Set();
    const merged = [];
    for (const it of [...faqItemsFromPage(page), ...(moduleApplies ? seo.moduleFaqItems : [])]) {
      const q = seoSchema.cleanStr((it && (it.q || it.question)) || '', 200).toLowerCase();
      if (q && seenQ.has(q)) continue;
      if (q) seenQ.add(q);
      merged.push(it);
    }
    const faqLd = seoSchema.buildFaqPageLd(merged);
    if (faqLd) blocks.push(seoSchema.ldJsonScript(faqLd, 'faqpage'));
  }
  // Batch 32 (C6): static blog post pages carry BlogPosting JSON-LD.
  // The synthetic post page rides its post data on page.blogPost; the
  // author/publisher is the site's business from the SEO context.
  const bp = page && typeof page === 'object' ? page.blogPost : null;
  if (bp && !existingTypes.has('BlogPosting')) {
    const baseUrl = String(seo.baseUrl || '').trim().replace(/\/+$/, '');
    const postPath = bp.urlPath || pageUrlPath(page && page.slug);
    const postUrl = baseUrl ? absoluteSeoUrl(baseUrl, postPath) : postPath;
    const cover = bp.coverImage ? absolutizeSeoUrl(baseUrl, bp.coverImage) : '';
    const biz = seo.business && typeof seo.business === 'object' ? seo.business : {};
    const ld = seoSchema.buildBlogPostingLd(
      {
        title: bp.title,
        description: bp.description || bp.excerpt,
        image: cover,
        datePublished: seoDateIso(bp.publishedAt),
        dateModified: seoDateIso(bp.updatedAt) || seoDateIso(bp.publishedAt),
        url: postUrl,
      },
      {
        businessName: biz.businessName || biz.name || '',
        businessUrl: baseUrl ? `${baseUrl}/` : biz.url || '',
        publisherLogo:
          t.logoMode === 'image' && t.logoUrl ? absolutizeSeoUrl(baseUrl, t.logoUrl) : '',
      }
    );
    if (ld) blocks.push(seoSchema.ldJsonScript(ld, 'blogposting'));
  }
  return blocks.join('\n');
}

/* ------------------------------------------------------------------ */
/* Static blog (Batch 32 — C6)                                         */
/*                                                                     */
/* Blog posts used to exist only as a client-side module payload on    */
/* one shared ?bpItem= URL — invisible to crawlers, no rankable URLs.  */
/* The exporter now server-renders: (1) a static card snapshot inside  */
/* every blog mount in the exported HTML (real post URLs, titles,      */
/* dates, covers in the raw HTML), and (2) one static page per         */
/* published post under the blog page's canonical path, with           */
/* BlogPosting JSON-LD (buildSeoHeadExtras) and a sitemap entry with   */
/* the post's own lastmod. The runtime module behavior (portal,        */
/* in-app previews) is untouched — module-embed.js keeps the static    */
/* snapshot on marked mounts and redirects legacy ?bpItem= links to    */
/* the static post page (Cloudflare Pages _redirects cannot match      */
/* query strings, so a server 301 for ?bpItem= is impossible; the      */
/* client redirect + static index are the least-bad landing).          */
/*                                                                     */
/* seo.blog shape (built by buildSeoExportContext):                    */
/*   { pagePath: 'blog',                    canonical blog page path   */
/*     posts: [{ slug, title, description, coverImage, bodyHtml,       */
/*               publishedAt, updatedAt }], published only, newest 1st */
/*     embeds: { <token>: { postLimit, showExcerpt } } }               */
/* ------------------------------------------------------------------ */

/** Normalize a stored date ('YYYY-MM-DD HH:MM:SS' UTC or ISO) to ISO. */
function seoDateIso(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  let s = raw;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s)) s = `${s.replace(' ', 'T')}Z`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

/** 'Oct 27, 2026' — matches the module embed's dateLabel presentation. */
function seoDateLabel(value) {
  const iso = seoDateIso(value);
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString('en-US', {
      timeZone: 'UTC',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return iso.slice(0, 10);
  }
}

/** First ~30 words of a post body as plain text (payload excerpt parity). */
function deriveBlogExcerptText(bodyHtml, wordLimit = 30) {
  const plain = seoSchema.stripHtmlToText(bodyHtml || '');
  if (!plain) return '';
  const words = plain.split(/\s+/).filter(Boolean);
  if (words.length <= wordLimit) return words.join(' ');
  return `${words.slice(0, wordLimit).join(' ')}…`;
}

/** Normalize one raw blog post row / fixture into the export shape. */
function normalizeBlogPost(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const slug = canonicalSlugPath(raw.slug || '');
  const title = seoSchema.cleanStr(raw.title, 200);
  if (!slug || !title) return null;
  const bodyHtml = String(raw.bodyHtml != null ? raw.bodyHtml : raw.body_html || '');
  const explicit = seoSchema.cleanStr(raw.description || raw.excerpt, 500);
  return {
    slug: slug.split('/').pop(),
    title,
    description: explicit || deriveBlogExcerptText(bodyHtml),
    coverImage: String(raw.coverImage != null ? raw.coverImage : raw.cover_image || '').trim(),
    bodyHtml,
    publishedAt: raw.publishedAt != null ? raw.publishedAt : raw.published_at || raw.created_at || '',
    updatedAt: raw.updatedAt != null ? raw.updatedAt : raw.updated_at || raw.published_at || raw.created_at || '',
  };
}

/** Canonical public path of one static post page: /blog/<post-slug>. */
function blogPostPath(blog, post) {
  const base = String((blog && blog.pagePath) || 'blog').replace(/^\/+|\/+$/g, '');
  return `/${base}/${post.slug}`;
}

/** Cover/asset src for static output: absolute with a base, else root-relative. */
function staticAssetSrc(value, baseUrl) {
  const v = String(value || '').trim();
  if (!v) return '';
  const abs = absolutizeSeoUrl(baseUrl, v);
  if (/^(https?:|data:|\/)/i.test(abs)) return abs;
  return `/${abs}`;
}

/**
 * Server-rendered blog card list for one mount (mirrors the module
 * embed's card markup + classes so theme/module CSS styles it the
 * same). Honors the mount's post_limit / show_excerpt settings.
 */
function buildStaticBlogCardsHtml(blog, embedCfg, baseUrl) {
  const cfg = embedCfg && typeof embedCfg === 'object' ? embedCfg : {};
  let posts = Array.isArray(blog.posts) ? blog.posts : [];
  if (cfg.postLimit != null && Number(cfg.postLimit) > 0) posts = posts.slice(0, Number(cfg.postLimit));
  if (!posts.length) return '';
  const showExcerpt = cfg.showExcerpt !== false;
  const cards = posts.map((post) => {
    const href = blogPostPath(blog, post);
    const cover = post.coverImage ? staticAssetSrc(post.coverImage, baseUrl) : '';
    const coverHtml = cover
      ? `<a class="bp-mod-cover" href="${esc(href)}" style="background-image:url('${esc(cover)}')"></a>`
      : `<a class="bp-mod-cover bp-mod-cover-fallback" href="${esc(href)}" aria-hidden="true">${esc(
          post.title.charAt(0).toUpperCase() || '?'
        )}</a>`;
    const date = seoDateLabel(post.publishedAt);
    return (
      `<article class="bp-mod-card">${coverHtml}<div class="bp-mod-body">` +
      `<h2><a href="${esc(href)}">${esc(post.title)}</a></h2>` +
      (date ? `<p class="bp-mod-meta">${esc(date)}</p>` : '') +
      (showExcerpt && post.description ? `<p class="bp-mod-excerpt">${esc(post.description)}</p>` : '') +
      `</div></article>`
    );
  });
  return `<div class="bp-mod-grid" data-bitpype-static-blog-list="1">${cards.join('')}</div>`;
}

/**
 * Inject the static snapshot into every blog mount in one exported
 * page: the mount div gains data-bitpype-static-blog="1" (the client
 * embed keeps the snapshot instead of re-rendering ?bpItem= links)
 * and the cards become its first child.
 */
function injectStaticBlogSnapshot(html, blog, baseUrl) {
  let doc = String(html || '');
  if (!blog || !Array.isArray(blog.posts) || !blog.posts.length) return doc;
  const tagRe = /<div\b[^>]*\bclass\s*=\s*["'][^"']*\bbitpype-module-embed\b[^"']*["'][^>]*>/gi;
  return doc.replace(tagRe, (tag) => {
    const token = (tag.match(/data-bitpype-module-token\s*=\s*["']([^"']+)["']/i) || [])[1] || '';
    const type = (tag.match(/data-bitpype-module-type\s*=\s*["']([^"']+)["']/i) || [])[1] || '';
    const cfg = token && blog.embeds ? blog.embeds[token] : null;
    if (!cfg && type !== 'blog') return tag;
    const cards = buildStaticBlogCardsHtml(blog, cfg || {}, baseUrl);
    if (!cards) return tag;
    const open = tag.endsWith('/>')
      ? tag
      : tag.replace(/>$/, ' data-bitpype-static-blog="1">');
    return open + cards;
  });
}

const BLOG_POST_CSS = [
  '.bp-post{box-sizing:border-box;max-width:760px;margin:0 auto;padding:12px 28px 28px}',
  '.bp-post-back{margin:0 0 18px;font-size:.95rem}',
  '.bp-post h1{margin:0 0 10px;line-height:1.18}',
  '.bp-post-meta{margin:0 0 20px;opacity:.72}',
  '.bp-post-cover{display:block;width:100%;height:auto;border-radius:12px;margin:0 0 24px}',
  '.bp-post-body{line-height:1.68}',
  '.bp-post-body img{max-width:100%;height:auto}',
  '@media(max-width:700px){.bp-post{padding-left:22px;padding-right:22px}}',
].join('\n');

/** The article body for one static post page (H1, date, cover, full body). */
function blogArticleHtml(blog, post, baseUrl) {
  const back = blogPostPath(blog, { slug: '' }).replace(/\/$/, '') || '/blog';
  const iso = seoDateIso(post.publishedAt);
  const label = seoDateLabel(post.publishedAt);
  const cover = post.coverImage ? staticAssetSrc(post.coverImage, baseUrl) : '';
  return (
    `<article class="bp-post" data-bitpype-blog-post="1">` +
    `<style data-bitpype-blog-post-css="1">${BLOG_POST_CSS}</style>` +
    `<p class="bp-post-back"><a href="${esc(back)}">← All posts</a></p>` +
    `<h1>${esc(post.title)}</h1>` +
    (label
      ? `<p class="bp-post-meta"><time datetime="${esc(iso || label)}">${esc(label)}</time></p>`
      : '') +
    (cover ? `<img class="bp-post-cover" src="${esc(cover)}" alt="${esc(post.title)}">` : '') +
    `<div class="bp-post-body">${post.bodyHtml || ''}</div>` +
    `</article>`
  );
}

/**
 * Synthetic page object for one static post page: the blog page's own
 * nav/footer sections (site chrome stays identical), the article in
 * between, and page.blogPost so buildSeoHeadExtras emits BlogPosting.
 * Rendered through renderPage like any other page.
 */
function buildBlogPostPage(blog, post, anchorPage, baseUrl) {
  const sections = [];
  const anchorSections = anchorPage && Array.isArray(anchorPage.sections) ? anchorPage.sections : [];
  const clone = (s) => JSON.parse(JSON.stringify(s));
  const navSec = anchorSections.find((s) => s && s.type === 'nav');
  const footerSec = [...anchorSections].reverse().find((s) => s && s.type === 'footer');
  if (navSec) sections.push(clone(navSec));
  sections.push({ type: 'html', content: { html: blogArticleHtml(blog, post, baseUrl) } });
  if (footerSec) sections.push(clone(footerSec));
  return {
    slug: `${String(blog.pagePath || 'blog').replace(/^\/+|\/+$/g, '')}/${post.slug}`,
    title: post.title,
    description: post.description,
    ogImage: post.coverImage ? staticAssetSrc(post.coverImage, baseUrl) : '',
    ogType: 'article',
    navVisible: false,
    blogPost: {
      title: post.title,
      description: post.description,
      coverImage: post.coverImage,
      publishedAt: post.publishedAt,
      updatedAt: post.updatedAt,
      urlPath: blogPostPath(blog, post),
    },
    sections,
    updatedAt: post.updatedAt || post.publishedAt || '',
  };
}

/** Inject auto SEO blocks into a full document's <head> (idempotent). */
function injectSeoHeadExtras(docHtml, extras) {
  let doc = String(docHtml || '');
  if (!extras || !String(extras).trim()) return doc;
  if (/data-bitpype-seo\s*=/.test(doc)) return doc;
  if (/<\/head>/i.test(doc)) return doc.replace(/<\/head>/i, `${extras}\n</head>`);
  if (/<head\b[^>]*>/i.test(doc)) return doc.replace(/<head\b[^>]*>/i, (m) => `${m}\n${extras}`);
  return doc;
}

/**
 * Resolve the render-time SEO values for one page: canonical (explicit
 * pageMeta wins; else base + canonical path), og:image (explicit wins;
 * else page image, else site logo), noindex, GSC token, schema extras.
 */
function resolvePageSeo(page, pages, theme, opts) {
  const seo = seoContextFromOpts(opts);
  const meta = pageMetaFields(page);
  const t = normalizeTheme(theme);
  const baseUrl = seo ? String(seo.baseUrl || '').trim().replace(/\/+$/, '') : '';
  let canonical = meta.canonical;
  if (!canonical && seo) {
    // Absolute when the site domain is known; root-relative canonical
    // path otherwise (upgraded to absolute on the first export after a
    // domain attaches — exports are re-materialized at publish).
    canonical = baseUrl
      ? absoluteSeoUrl(baseUrl, pageUrlPath(page && page.slug))
      : pageUrlPath(page && page.slug);
  }
  let ogImage = meta.ogImage;
  if (!ogImage) ogImage = firstPageImage(page) || (t.logoMode === 'image' ? t.logoUrl : '') || '';
  if (ogImage) ogImage = absolutizeSeoUrl(baseUrl, ogImage);
  return {
    canonical,
    ogImage,
    noindex: meta.noindex,
    gscToken: seo ? seo.gscToken || '' : '',
    seoHead: buildSeoHeadExtras(page, pages, theme, opts),
    hasSeoContext: !!seo,
  };
}

/**
 * Apply resolved SEO head values to a freeform full document: canonical
 * link, robots noindex, GSC verification, og:image fallback. Explicit
 * tags already in the document always win; auto schema extras ride
 * injectSeoHeadExtras.
 */
function applySeoHeadToDocument(docHtml, pageSeo) {
  let doc = String(docHtml || '');
  if (!pageSeo || !doc.trim()) return doc;
  const inserts = [];
  if (pageSeo.canonical && !/<link\b[^>]*rel\s*=\s*["']canonical["']/i.test(doc)) {
    inserts.push(`<link rel="canonical" href="${esc(pageSeo.canonical)}">`);
  }
  if (pageSeo.noindex && !/<meta\b[^>]*name\s*=\s*["']robots["']/i.test(doc)) {
    inserts.push('<meta name="robots" content="noindex">');
  }
  if (pageSeo.gscToken && !/google-site-verification/i.test(doc)) {
    inserts.push(`<meta name="google-site-verification" content="${esc(String(pageSeo.gscToken).trim().slice(0, 200))}">`);
  }
  if (pageSeo.ogImage && !/<meta\b[^>]*property\s*=\s*["']og:image["']/i.test(doc)) {
    inserts.push(`<meta property="og:image" content="${esc(pageSeo.ogImage)}">`);
  }
  if (inserts.length) {
    const chunk = inserts.join('\n');
    if (/<\/head>/i.test(doc)) doc = doc.replace(/<\/head>/i, `${chunk}\n</head>`);
    else if (/<head\b[^>]*>/i.test(doc)) doc = doc.replace(/<head\b[^>]*>/i, (m) => `${m}\n${chunk}`);
  }
  return injectSeoHeadExtras(doc, pageSeo.seoHead);
}

/** sitemap.xml body: indexable pages only, honest per-page lastmod. */
function buildSitemapXml(pages, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const baseUrl = String(o.baseUrl || '').trim().replace(/\/+$/, '');
  const siteUpdated = o.siteUpdatedAt ? String(o.siteUpdatedAt) : '';
  const escXml = (s) =>
    String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const urls = [];
  for (const p of Array.isArray(pages) ? pages : []) {
    if (!p) continue;
    if (pageMetaFields(p).noindex) continue;
    const loc = baseUrl
      ? absoluteSeoUrl(baseUrl, pageUrlPath(p.slug))
      : pageUrlPath(p.slug);
    const rawMod = p.updatedAt || p.updated_at || siteUpdated || '';
    const d = rawMod ? new Date(String(rawMod).replace(' ', 'T')) : null;
    const lastmod = d && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : '';
    urls.push(`  <url>\n    <loc>${escXml(loc)}</loc>${lastmod ? `\n    <lastmod>${lastmod}</lastmod>` : ''}\n  </url>`);
  }
  // Batch 32 (C6): extra URL entries (static blog post pages) with
  // their own honest lastmod (the post's updated/published stamp).
  for (const extra of Array.isArray(o.extraUrls) ? o.extraUrls : []) {
    if (!extra || !extra.path) continue;
    const loc = baseUrl ? absoluteSeoUrl(baseUrl, extra.path) : extra.path;
    const iso = seoDateIso(extra.lastmod);
    const lastmod = iso ? iso.slice(0, 10) : '';
    urls.push(
      `  <url>\n    <loc>${escXml(loc)}</loc>${lastmod ? `\n    <lastmod>${lastmod}</lastmod>` : ''}\n  </url>`
    );
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
}

/** robots.txt body: allow-all + Sitemap line when an absolute base is known. */
function buildRobotsTxt(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const baseUrl = String(o.baseUrl || '').trim().replace(/\/+$/, '');
  let txt = 'User-agent: *\nAllow: /\n';
  if (baseUrl) txt += `\nSitemap: ${baseUrl}/sitemap.xml\n`;
  return txt;
}

/**
 * Cloudflare Pages _redirects body: legacy underscore filenames → the
 * canonical dash URL for every page, so pre-Batch-31 links keep working
 * and nothing falls back to the home page.
 */
function buildRedirects(pages) {
  // Batch 133: the universal detail page — every /detail/<type>/<key>
  // URL rewrites (200, URL preserved) to the one exported detail
  // page, which reads its ONE typed target out of the path. The
  // target is the shell's own file OUTSIDE the splat tree
  // (item.html, served at /item): both in-tree targets were
  // silently ignored by Pages on the first live previews
  // (Batch 133 finisher) — /detail.html canonicalizes to /detail
  // with a 308 that rewrites do not chain through, and a target
  // under the source prefix reads as a rewrite loop. Cloudflare
  // Pages serves real files first, so authored pages and the
  // static blog post pages are never shadowed by the splat.
  const lines = ['/detail/* /item 200'];
  for (const p of Array.isArray(pages) ? pages : []) {
    if (!p || isHomePage(p, pages)) continue;
    const legacy = legacyPageFileName(p.slug);
    const canon = pageUrlPath(p.slug);
    if (legacy === 'index.html') continue;
    lines.push(`/${legacy} ${canon} 301`);
    const legacyBare = `/${legacy.replace(/\.html$/i, '')}`;
    if (legacyBare !== canon) lines.push(`${legacyBare} ${canon} 301`);
  }
  return lines.length ? lines.join('\n') + '\n' : '';
}

/**
 * Themed 404 page (site chrome + "page not found" + link home).
 * Serving layers return it with a TRUE 404 status (Cloudflare Pages
 * does this natively for 404.html; the app preview mounts serve it
 * with an explicit 404 — see server.js / previewServer.js).
 */
function build404Page(pages, theme, opts) {
  const home = homePage(pages) || (Array.isArray(pages) ? pages[0] : null);
  const t = normalizeTheme(theme);
  const bizName =
    (opts && opts.businessName) || t.brandName || (home && home.title) || 'This business';
  const main = `<main class="bp-404" style="max-width:760px;margin:0 auto;padding:64px 28px;text-align:center">
<h1>Page not found</h1>
<p>The page you are looking for is not here. It may have moved, or the link may be out of date.</p>
<p><a href="/">Back to the home page</a></p>
</main>`;
  // Batch 141: the FULL site chrome (siteChromeHtml — partials or the
  // home page's nav/footer sections, the same assembly renderPage
  // uses), so an unknown /detail/<type>/<slug> — and every other
  // missing path — lands on a not-found page that looks like the
  // site. The serving layers keep the TRUE 404 status; chrome never
  // turns this into a soft-200.
  let body = main;
  try {
    const chrome = siteChromeHtml(pages, t);
    body = [chrome.header, main, chrome.footer].filter(Boolean).join('\n');
    body = rewriteAnchorLinksToFiles(body, pages);
  } catch {
    /* chrome is best-effort */
    body = main;
  }
  const doc = docShell({
    title: `Page not found — ${bizName}`,
    body,
    theme: t,
    description: 'The requested page could not be found.',
    noindex: true,
  });
  return assertAndDedupeNavHtml(doc, 'build404Page');
}

/* ------------------------------------------------------------------ */
/* Universal detail page (Batch 133)                                   */
/*                                                                     */
/* Every export ships ONE item.html: a themed shell (site chrome     */
/* like the 404 page) carrying a detail root + a JSON config mapping   */
/* each detail-capable module type to its public embed token and its   */
/* list page. writeStaticPages ALSO ships a real copy of this shell    */
/* per published item at detail/<type>/<key>.html — the _redirects     */
/* 200-rewrite for /detail/* does not fire on the platform's Pages      */
/* deployments (Batch 133 finisher, verified live), so the rewrite     */
/* line is only a fallback for post-export items on hosts that honor   */
/* it. module-embed.js reads the ONE typed                             */
/* target out of the path, resolves it through the public item API,    */
/* and renders that type's detail layout into the root. The shell is   */
/* noindex (it is an empty template at rest); the client sets the      */
/* real title/meta/canonical from the item at render. Static/SEO       */
/* generation of detail pages is deliberately NOT v1.                  */
/*                                                                     */
/* Batch 141 — DETAIL POLISH: the shell now carries the site's FULL  */
/* chrome (siteChromeHtml: partials, or the home page's nav/footer    */
/* sections — the same assembly renderPage uses; Batch 133 only ever  */
/* applied theme.partials, so nav-section sites shipped bare shells), */
/* and each PER-ITEM shell bakes the item's primary photo (resolved   */
/* at export by detailExportContext, the moduleShare uniform primary: */
/* cover_image / image_url / album first image / video thumbnail) as  */
/* the detail root's initial hero — the same .bp-mod-hero treatment   */
/* renderItem renders at view time. The bake is the root's INITIAL    */
/* content only: the client still resolves the item live and         */
/* renderItem replaces the root wholesale, so a photo changed after   */
/* export shows the exported photo until the next export, then the   */
/* live one — content itself is never snapshotted. With chrome in    */
/* place, Batch 142's nav cart lands in the shell's nav from the      */
/* item payload exactly as on regular pages (no detail-specific cart  */
/* code exists or is needed).                                         */
/* ------------------------------------------------------------------ */
function buildDetailPage(pages, theme, opts) {
  const home = homePage(pages) || (Array.isArray(pages) ? pages[0] : null);
  const t = normalizeTheme(theme);
  const bizName =
    (opts && opts.businessName) || t.brandName || (home && home.title) || 'This business';
  const seo = seoContextFromOpts(opts || {});
  const detail = (seo && seo.detail) || (opts && opts.detail) || null;
  let appBase = '';
  try {
    appBase = String(require('../server/stripeClient').appUrl() || '').replace(/\/$/, '');
  } catch {
    appBase = '';
  }
  const config = { api: appBase, types: (detail && detail.types) || {} };
  const configJson = JSON.stringify(config).replace(/</g, '\\u003c');
  // Batch 141: the per-item photo bake (writeStaticPages passes the
  // item's primary photo for detail/<type>/<key>.html shells; the
  // generic item.html gets none — it serves items nobody exported).
  const itemImage = opts && typeof opts.detailItemImage === 'string' ? opts.detailItemImage.trim() : '';
  const heroHtml = itemImage
    ? `<article class="bp-mod-detail"><img class="bp-mod-hero" src="${esc(itemImage)}" alt="" /></article>`
    : '';
  // Batch 143: horizontal padding floor is 22px (the Batch 135
  // mobile section inset) — the old clamp(1.1rem,…) bottomed out at
  // 17.6px on phones, below the platform floor.
  const main = `<main class="bp-detail-main" style="max-width:1100px;margin:0 auto;padding:clamp(1.75rem,4vw,3.25rem) clamp(22px,3.5vw,2rem) clamp(3.5rem,8vw,5.5rem);box-sizing:border-box">
<div class="bitpype-module-embed" data-bitpype-detail-root="1"${appBase ? ` data-bitpype-api="${esc(appBase)}"` : ''}>${heroHtml}<p class="bp-mod-loading">Loading…</p></div>
</main>
<script type="application/json" id="bp-detail-config">${configJson}</script>`;
  let script = '';
  try {
    script = require('../server/siteModules').moduleScriptTag(appBase);
  } catch {
    script = '';
  }
  let body = main;
  try {
    const chrome = siteChromeHtml(pages, t);
    body = [chrome.header, main, chrome.footer].filter(Boolean).join('\n');
    body = rewriteAnchorLinksToFiles(body, pages);
  } catch {
    /* chrome is best-effort */
    body = main;
  }
  const doc = docShell({
    title: `Details — ${bizName}`,
    body,
    theme: t,
    script,
    description: 'Item details.',
    noindex: true,
  });
  return assertAndDedupeNavHtml(doc, 'buildDetailPage');
}

/* ------------------------------------------------------------------ */
/* Webinar gate/room shell (Batch 165)                                 */
/*                                                                     */
/* The Webinar module's public pages live under the site's own URL     */
/* space at webinar/<slug> — the same real-file discipline as the      */
/* detail shells (Pages ignores _redirects 200-rewrites, so the        */
/* exporter ships one real shell per webinar of the site; see           */
/* domain.materializeWebsiteExport). The shell is the site's themed     */
/* chrome + a webinar root; webinar-embed.js boots the root and        */
/* resolves EVERYTHING live through the webinar public API (gate,      */
/* room, chat) — no webinar content is ever snapshotted into the       */
/* export, so a code change, a status flip or a new message is live    */
/* without a re-export. The shell is noindex like the detail shell.    */
/* ------------------------------------------------------------------ */
function buildWebinarPage(pages, theme, opts) {
  const home = homePage(pages) || (Array.isArray(pages) ? pages[0] : null);
  const t = normalizeTheme(theme);
  const o = opts || {};
  const bizName = o.businessName || t.brandName || (home && home.title) || 'This business';
  let appBase = '';
  try {
    appBase = String((o.api || require('../server/stripeClient').appUrl() || '')).replace(/\/$/, '');
  } catch {
    appBase = '';
  }
  const token = String(o.token || '');
  const slug = String(o.slug || '');
  const title = String(o.title || 'Webinar');
  // Batch 143 discipline (as on the detail shell): the horizontal
  // padding floor never drops below the Batch 135 mobile inset.
  const main = `<main class="bp-webinar-main" style="max-width:1100px;margin:0 auto;padding:clamp(1.75rem,4vw,3.25rem) clamp(22px,3.5vw,2rem) clamp(3.5rem,8vw,5.5rem);box-sizing:border-box">
<div data-bitpype-webinar-root="1" data-token="${esc(token)}" data-slug="${esc(slug)}"${appBase ? ` data-bitpype-api="${esc(appBase)}"` : ''}><p class="bp-mod-loading">Loading…</p></div>
</main>`;
  let script = '';
  try {
    script = require('../server/siteModules').moduleScriptTag(appBase);
  } catch {
    script = '';
  }
  if (appBase) {
    script += `\n<script src="${esc(appBase)}/js/webinar-embed.js?v=webinar1" data-bitpype-webinar-script="1" defer></script>`;
  }
  let body = main;
  try {
    const chrome = siteChromeHtml(pages, t);
    body = [chrome.header, main, chrome.footer].filter(Boolean).join('\n');
    body = rewriteAnchorLinksToFiles(body, pages);
  } catch {
    /* chrome is best-effort */
    body = main;
  }
  const doc = docShell({
    title: `${title} — ${bizName}`,
    body,
    theme: t,
    script,
    description: 'Webinar registration and live room.',
    noindex: true,
  });
  return assertAndDedupeNavHtml(doc, 'buildWebinarPage');
}

/** Stamp exported pages as detail-enabled so module-embed.js points
 *  list/card item links at /detail/<type>/<key> instead of the legacy
 *  ?bpItem= pattern. Only writeStaticPages output carries the meta —
 *  in-app module surfaces (portal, standalone viewer) never see it and
 *  keep the legacy links. */
function injectDetailMeta(html) {
  const s = String(html || '');
  if (!s || s.includes('name="bitpype-detail"')) return s;
  if (/<head[^>]*>/i.test(s)) {
    return s.replace(/<head[^>]*>/i, (m) => `${m}\n<meta name="bitpype-detail" content="1">`);
  }
  return s;
}

/**
 * Stamp per-page updatedAt (Batch 31 — C3 honest sitemap lastmod).
 * Compares old vs new page lists by slug over the page content (minus
 * updatedAt itself); changed/new pages get `nowIso`, unchanged pages
 * keep their previous stamp. Pure — callers persist the result.
 */
function stampPageUpdatedAt(oldPages, newPages, nowIso) {
  const now = nowIso || new Date().toISOString();
  const oldByKey = new Map();
  for (const p of Array.isArray(oldPages) ? oldPages : []) {
    if (p) oldByKey.set(canonicalSlugPath(p.slug) || 'index', p);
  }
  const strip = (p) => {
    const c = Object.assign({}, p);
    delete c.updatedAt;
    delete c.updated_at;
    return JSON.stringify(c);
  };
  return (Array.isArray(newPages) ? newPages : []).map((p) => {
    if (!p || typeof p !== 'object') return p;
    const key = canonicalSlugPath(p.slug) || 'index';
    const old = oldByKey.get(key);
    if (!old) return Object.assign({}, p, { updatedAt: now });
    if (strip(old) === strip(p)) {
      const keep = old.updatedAt || old.updated_at || null;
      return keep ? Object.assign({}, p, { updatedAt: keep }) : Object.assign({}, p, { updatedAt: now });
    }
    return Object.assign({}, p, { updatedAt: now });
  });
}

/** Apply site-level header/footer partials unless the page opts out. */
function applySitePartials(bodyHtml, theme, page) {
  const t = normalizeTheme(theme);
  const meta = pageMetaFields(page);
  if (meta.overrideChrome) return String(bodyHtml || '');
  const header = t.partials && t.partials.headerHtml ? String(t.partials.headerHtml).trim() : '';
  const footer = t.partials && t.partials.footerHtml ? String(t.partials.footerHtml).trim() : '';
  if (!header && !footer) return String(bodyHtml || '');
  let body = String(bodyHtml || '');
  // When shared header is set, drop per-page nav sections to avoid duplicate chrome.
  if (header) {
    body = body.replace(/<nav\b[^>]*\bdata-ws-section-type\s*=\s*["']nav["'][^>]*>[\s\S]*?<\/nav>/gi, '');
    body = body.replace(/<header\b[^>]*\bdata-ws-section-type\s*=\s*["']nav["'][^>]*>[\s\S]*?<\/header>/gi, '');
    body = body.replace(/<section\b[^>]*\bdata-ws-section-type\s*=\s*["']nav["'][^>]*>[\s\S]*?<\/section>/gi, '');
    body = `${header}\n${body}`;
  }
  if (footer) {
    body = body.replace(
      /<(?:footer|section)\b[^>]*\bdata-ws-section-type\s*=\s*["']footer["'][^>]*>[\s\S]*?<\/(?:footer|section)>/gi,
      ''
    );
    body = `${body}\n${footer}`;
  }
  return body;
}

/**
 * Full-document agent pages often keep CSS in theme.customCss (baseCss:false)
 * rather than inside page.html. Export/publish must inject that CSS or the
 * live preview is unstyled. When a theme block already exists, refresh it so
 * color / :root variable changes apply on re-render.
 */
/**
 * When freeform HTML uses data-bitpype-mobile-nav, inline the shared hamburger
 * CSS so Cloudflare Pages / static export works without a remote /css host.
 */
function injectMobileNavAsset(docHtml) {
  let doc = String(docHtml || '');
  if (!/data-bitpype-mobile-nav\s*=/i.test(doc)) return doc;
  if (/data-bitpype-mobile-nav-css\s*=/i.test(doc)) return doc;
  let css = '';
  try {
    css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'mobile-nav.css'), 'utf8');
  } catch {
    return doc;
  }
  const tag = `<style data-bitpype-mobile-nav-css="1">${sanitizeCss(css)}</style>`;
  if (/<\/head>/i.test(doc)) return doc.replace(/<\/head>/i, `${tag}\n</head>`);
  if (/<head\b[^>]*>/i.test(doc)) return doc.replace(/<head\b[^>]*>/i, (m) => `${m}\n${tag}`);
  if (/<html\b[^>]*>/i.test(doc)) {
    return doc.replace(/<html\b[^>]*>/i, (m) => `${m}\n<head>${tag}</head>`);
  }
  return `${tag}\n${doc}`;
}

function injectThemeStyles(docHtml, theme) {
  let doc = String(docHtml || '');
  if (!doc.trim()) return doc;
  const css = siteCss(theme);
  if (!css || !String(css).trim()) return doc;
  const styleTag = `<style data-ws-theme="1">${css}</style>`;
  if (/data-ws-theme\s*=\s*["']1["']/.test(doc)) {
    return doc.replace(/<style\b[^>]*data-ws-theme\s*=\s*["']1["'][^>]*>[\s\S]*?<\/style>/i, styleTag);
  }
  if (/<\/head>/i.test(doc)) return doc.replace(/<\/head>/i, `${styleTag}\n</head>`);
  if (/<head\b[^>]*>/i.test(doc)) return doc.replace(/<head\b[^>]*>/i, (m) => `${m}\n${styleTag}`);
  if (/<html\b[^>]*>/i.test(doc)) {
    return doc.replace(/<html\b[^>]*>/i, (m) => `${m}\n<head>${styleTag}</head>`);
  }
  return `<!DOCTYPE html><html lang="en"><head>${styleTag}</head><body>${doc}</body></html>`;
}

/** Inject/replace theme.customJs before </body> for freestyle motion/effects. */
function injectThemeJs(docHtml, theme) {
  let doc = String(docHtml || '');
  if (!doc.trim()) return doc;
  const tag = themeJsTag(theme);
  doc = doc.replace(/<script\b[^>]*data-ws-theme-js\s*=\s*["']1["'][^>]*>[\s\S]*?<\/script>\s*/gi, '');
  if (!tag) return doc;
  if (/<\/body>/i.test(doc)) return doc.replace(/<\/body>/i, `${tag}\n</body>`);
  return `${doc}\n${tag}`;
}

/**
 * Render a single page as a full standalone HTML document.
 * Nav links point at the exported per-page filenames (unless opts.preview).
 */
/**
 * The nav links renderPage hands a page's nav section: the structured
 * buildNavLinks list with duplicate route/label entries dropped.
 * Extracted (Batch 141) so the synthetic documents that are not pages
 * (detail shell, 404 page) render the site's nav with the SAME links
 * through the same code — never a second nav-link path.
 */
function computeNavLinks(pages, preview) {
  let navLinks;
  try {
    navLinks = require('./siteStructure').buildNavLinks(pages, { preview });
  } catch {
    navLinks = (Array.isArray(pages) ? pages : []).map((p) => ({
      label: p.title || p.slug,
      href: preview ? `#${anchorId(p.slug)}` : pageUrlPath(p.slug),
    }));
  }
  // Structured nav links: drop duplicate route/label before rendering.
  const seenR = new Set();
  const seenL = new Set();
  return (navLinks || []).filter((l) => {
    const route = normalizeRoute(l && (l.slug || l.href));
    const label = String((l && l.label) || '')
      .trim()
      .toLowerCase();
    if (seenR.has(route) || (label && seenL.has(label))) return false;
    seenR.add(route);
    if (label) seenL.add(label);
    return true;
  });
}

/**
 * Batch 141 — the site's header + footer chrome for the synthetic
 * documents that are not pages (the universal detail shell and the
 * themed 404 page), assembled EXACTLY as renderPage assembles a real
 * page's chrome: theme.partials win when present (the same precedence
 * renderPage and applySitePartials use — a partial header suppresses
 * the nav section, a partial footer suppresses the footer section);
 * otherwise the home page's own nav and footer sections, rendered
 * through sectionToHtml with the same computed nav links. A page that
 * opts out of chrome (chromeOverride) and a site with no chrome at
 * all both yield empty strings — the document renders as it did
 * before this batch. Returns { header, footer }.
 */
function siteChromeHtml(pages, theme) {
  const out = { header: '', footer: '' };
  const list = Array.isArray(pages) ? pages : [];
  if (!list.length) return out;
  const home = homePage(list) || list[0];
  if (!home) return out;
  const t = normalizeTheme(theme);
  const meta = pageMetaFields(home);
  if (meta.overrideChrome) return out;
  const partials = t.partials || {};
  if (partials.headerHtml && String(partials.headerHtml).trim()) out.header = String(partials.headerHtml).trim();
  if (partials.footerHtml && String(partials.footerHtml).trim()) out.footer = String(partials.footerHtml).trim();
  const sections = Array.isArray(home.sections) ? home.sections : [];
  const pageIndex = Math.max(0, list.indexOf(home));
  if (!out.header) {
    const si = sections.findIndex((s) => s && s.type === 'nav');
    if (si >= 0) {
      const s = sections[si];
      out.header = sectionToHtml(
        { type: 'nav', content: Object.assign({}, s.content, { links: computeNavLinks(list, false) }) },
        t,
        makeEdit(t, pageIndex, si, false)
      );
    }
  }
  if (!out.footer) {
    for (let si = sections.length - 1; si >= 0; si--) {
      const s = sections[si];
      if (s && s.type === 'footer') {
        out.footer = sectionToHtml(s, t, makeEdit(t, pageIndex, si, false));
        break;
      }
    }
  }
  return out;
}

function renderPage(page, allPages, theme, opts) {
  if (!page || typeof page !== 'object') throw err('INVALID_PAGE', 'Page must be an object.');
  const t = normalizeTheme(theme);
  const o = opts || {};
  const editable = !!o.editable;
  const preview = !!o.preview;
  const pages = Array.isArray(allPages) ? allPages : [page];
  const pageIndex = Math.max(0, pages.indexOf(page));
  const scripts = previewScripts({ preview, editable, layoutEditor: !!o.layoutEditor });
  // Modular sections win when present. Legacy freeform page.html only if no sections.
  let structure;
  try {
    structure = require('./siteStructure');
  } catch {
    structure = null;
  }
  let pageForRender = page;
  if (structure && typeof structure.ensureNavFirstPage === 'function' && Array.isArray(page.sections)) {
    pageForRender = structure.ensureNavFirstPage(page);
  }
  const hasSections = Array.isArray(pageForRender.sections) && pageForRender.sections.length > 0;
  const rawHtml = typeof pageForRender.html === 'string' ? pageForRender.html.trim() : '';
  let freeHtml = !hasSections && rawHtml ? rawHtml : '';
  // Upgrade sparse client page chrome so title/body get stable edit targets.
  if (freeHtml && editable) {
    try {
      const modules = require('../server/siteModules');
      if (typeof modules.ensureClientPageChrome === 'function') {
        freeHtml = modules.ensureClientPageChrome(freeHtml);
      }
    } catch {
      /* optional */
    }
  }
  const finishPage = (html) => assertAndDedupeNavHtml(html, `renderPage:${String(pageForRender.slug || pageIndex)}`);
  const pageMeta = pageMetaFields(pageForRender);
  const pageSeo = resolvePageSeo(pageForRender, pages, t, o);
  if (freeHtml) {
    if (looksLikeFullDocument(freeHtml)) {
      // sanitizeHtml strips author <link rel="icon"> — reinject from theme.favicon.
      let doc = injectThemeHead(
        injectThemeJs(injectMobileNavAsset(injectThemeStyles(injectFaviconLink(sanitizeHtml(freeHtml), t), t)), t),
        t,
        pageMeta.customHead
      );
      // Batch 31: auto canonical / noindex / GSC / og:image / schema.
      doc = applySeoHeadToDocument(doc, pageSeo);
      // Per-page custom JS at body end (author scripts survive sanitizeJs only).
      if (pageMeta.customJs) {
        const tag = pageJsTag(pageMeta.customJs);
        doc = doc.replace(/<script\b[^>]*data-ws-page-js\s*=\s*["']1["'][^>]*>[\s\S]*?<\/script>\s*/gi, '');
        if (/<\/body>/i.test(doc)) doc = doc.replace(/<\/body>/i, `${tag}\n</body>`);
        else doc = `${doc}\n${tag}`;
      }
      if (preview) doc = rewriteFileLinksToAnchors(doc, pages);
      else doc = rewriteAnchorLinksToFiles(doc, pages);
      if (editable) {
        doc = markFreeformDocument(doc, pageIndex);
        doc = wrapBodyWithPageRoot(doc, pageIndex);
      }
      return finishPage(injectSpacingGuardScript(upsertFontLinks(appendHtmlTail(doc, scripts), t)));
    }
    let body = sanitizeHtml(freeHtml);
    body = applySitePartials(body, t, pageForRender);
    if (preview) body = rewriteFileLinksToAnchors(body, pages);
    else body = rewriteAnchorLinksToFiles(body, pages);
    if (editable) {
      body = markFreeformTextNodes(body, pageIndex);
      if (!/data-ws-page\s*=/.test(body)) {
        body = `<div data-ws-page="${pageIndex}">${body}</div>`;
      }
    }
    return finishPage(
      upsertFontLinks(
        injectMobileNavAsset(
          docShell({
            title: pageForRender.title || 'Home',
            body,
            theme: t,
            script: scripts,
            description: pageMeta.description,
            ogImage: pageSeo.ogImage,
            canonical: pageSeo.canonical,
            noindex: pageSeo.noindex,
            gscToken: pageSeo.gscToken,
            seoHead: pageSeo.seoHead,
            pageJs: pageMeta.customJs,
            pageHead: pageMeta.customHead,
            ogType: pageMeta.ogType,
          })
        ),
        t
      )
    );
  }
  const sections = Array.isArray(pageForRender.sections) ? pageForRender.sections : null;
  if (!sections) throw err('INVALID_PAGE', 'Page needs sections or html.');
  const navLinks = computeNavLinks(pages, preview);
  const useSharedHeader = !!(t.partials && t.partials.headerHtml && !pageMeta.overrideChrome);
  let body = sections
    .map((s, si) => {
      const edit = o.layoutEditor ? makeLayoutEdit(pageIndex, si) : makeEdit(t, pageIndex, si, editable);
      // Skip per-page nav when shared header partial is active.
      if (s.type === 'nav' && useSharedHeader) return '';
      if (s.type === 'footer' && t.partials && t.partials.footerHtml && !pageMeta.overrideChrome) return '';
      if (s.type === 'nav') {
        return sectionToHtml({ type: 'nav', content: Object.assign({}, s.content, { links: navLinks }) }, t, edit);
      }
      return sectionToHtml(s, t, edit);
    })
    .join('\n');
  body = applySitePartials(body, t, pageForRender);
  // Footer/CTA hashes (#services) must become *.html on static multipage hosts.
  if (!preview) body = rewriteAnchorLinksToFiles(body, pages);
  return finishPage(
    upsertFontLinks(
      docShell({
        title: pageForRender.title || 'Home',
        body,
        theme: t,
        script: scripts,
        description: pageMeta.description,
        ogImage: pageSeo.ogImage,
        canonical: pageSeo.canonical,
        noindex: pageSeo.noindex,
        gscToken: pageSeo.gscToken,
        seoHead: pageSeo.seoHead,
        pageJs: pageMeta.customJs,
        pageHead: pageMeta.customHead,
        ogType: pageMeta.ogType,
        // Batch 148: per-page layout-knob rules ('' when no knob is set).
        sectionLayoutCss: sectionLayoutCss([pageForRender]) || undefined,
      }),
      t
    )
  );
}

/**
 * Render one page (by slug or index). Used by in-app multipage preview tabs.
 */
function renderPageAt(pages, theme, opts) {
  if (!Array.isArray(pages) || !pages.length) throw err('INVALID_PAGES', 'pages must be a non-empty array.');
  const o = opts || {};
  let page = null;
  if (o.pageSlug != null && String(o.pageSlug).trim()) {
    const want = String(o.pageSlug).trim();
    page = pages.find((p) => String(p.slug) === want || pageFileName(p.slug) === want || anchorId(p.slug) === want);
  }
  if (!page && Number.isInteger(o.pageIndex)) page = pages[o.pageIndex];
  if (!page) page = homePage(pages);
  return renderPage(page, pages, theme, o);
}

/**
 * Stacked-preview only: drop the sitewide chat widget (mount + loader) from a
 * page chunk. Every stored page carries its own copy of the floating chatbot,
 * so a stacked all-pages preview would render one chat button per page. The
 * first page keeps its widget; stored pages and single-page renders are
 * untouched.
 */
function stripStackedChatWidgets(html) {
  let s = String(html || '');
  s = s.replace(/<div\b[^>]*\bdata-bitpype-chat\s*=\s*["']?1["']?[^>]*>[\s\S]*?<\/div>/gi, '');
  s = s.replace(/<div\b[^>]*\bdata-bitpype-chat\s*=\s*["']?1["']?[^>]*\/?>/gi, '');
  s = s.replace(/<div\b[^>]*\bbitpype-chat-embed\b[^>]*>[\s\S]*?<\/div>/gi, '');
  s = s.replace(/<script\b[^>]*\bdata-bitpype-chat-script\b[^>]*>\s*<\/script>/gi, '');
  s = s.replace(/<script\b[^>]*\/js\/chat-embed\.js[^>]*>\s*<\/script>/gi, '');
  return s;
}

/**
 * Render the whole site for iframe preview.
 * Freeform multipage sites stack pages and rewrite *.html nav links to #anchors.
 * Prefer renderPageAt + page tabs when browsing one page at a time.
 */
function renderSite(pages, theme, opts) {
  if (!Array.isArray(pages) || !pages.length) throw err('INVALID_PAGES', 'pages must be a non-empty array.');
  const t = normalizeTheme(theme);
  const o = Object.assign({}, opts || {}, { preview: true });
  const editable = !!o.editable;
  if (o.pageSlug != null || Number.isInteger(o.pageIndex)) {
    return renderPageAt(pages, theme, o);
  }
  let navLinks;
  try {
    navLinks = require('./siteStructure').buildNavLinks(pages, { preview: true });
  } catch {
    navLinks = pages.map((p) => ({ label: p.title || p.slug, href: '#' + anchorId(p.slug) }));
  }
  const freeform = pages.some(pageHasHtml);
  const scripts = previewScripts({ preview: true, editable, layoutEditor: !!o.layoutEditor });
  // Single freeform full document: sanitize + inject theme CSS.
  if (pages.length === 1 && pageHasHtml(pages[0]) && looksLikeFullDocument(pages[0].html)) {
    let doc = injectThemeStyles(sanitizeHtml(pages[0].html), t);
    doc = rewriteFileLinksToAnchors(doc, pages);
    if (editable) {
      doc = markFreeformDocument(doc, 0);
      doc = wrapBodyWithPageRoot(doc, 0);
    }
    // Batch 143 (full review): the Batch 135 spacing guarantee has
    // two layers — the CSS floor (present here via injectThemeStyles
    // → siteCss) and this raise-only JS guard (container/card
    // padding + wide-table wrap). Every other full-document path
    // injects it; this single-freeform path returned without it, so
    // exactly the oldest freeform sites missed layer two.
    return injectSpacingGuardScript(upsertFontLinks(appendHtmlTail(doc, scripts), t));
  }
  const headExtras = [];
  const body = pages
    .map((p, pi) => {
      if (pageHasHtml(p)) {
        const sanitized = sanitizeHtml(p.html);
        let inner = sanitized;
        if (looksLikeFullDocument(p.html)) {
          sanitized.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, (m) => {
            headExtras.push(m);
            return '';
          });
          sanitized.replace(/<link\b[^>]*>/gi, (m) => {
            headExtras.push(m);
            return '';
          });
          inner = sanitized.replace(/^[\s\S]*?<body[^>]*>/i, '').replace(/<\/body>[\s\S]*$/i, '');
        }
        if (editable) inner = markFreeformTextNodes(inner, pi);
        if (pi > 0) inner = stripStackedChatWidgets(inner);
        return `<div class="page-anchor" id="${anchorId(p.slug)}" data-ws-page="${pi}">${inner}</div>`;
      }
      const sections = (Array.isArray(p.sections) ? p.sections : [])
        .map((s, si) => {
          const edit = o.layoutEditor ? makeLayoutEdit(pi, si) : makeEdit(t, pi, si, editable);
          if (s.type === 'nav') {
            return sectionToHtml({ type: 'nav', content: Object.assign({}, s.content, { links: navLinks }) }, t, edit);
          }
          return sectionToHtml(s, t, edit);
        })
        .join('\n');
      return `<div class="page-anchor" id="${anchorId(p.slug)}">${pi > 0 ? stripStackedChatWidgets(sections) : sections}</div>`;
    })
    .join('\n');
  const title = (homePage(pages) || pages[0]).title || 'Home';
  let html = docShell({
    title,
    body: freeform ? rewriteFileLinksToAnchors(body, pages) : body,
    theme: t,
    script: scripts,
    // Batch 148: the stacked preview shows every page — the knob rule
    // block is computed across all of them.
    sectionLayoutCss: sectionLayoutCss(pages) || undefined,
  });
  if (headExtras.length) {
    const unique = [...new Set(headExtras)];
    const inject = unique.join('\n');
    if (/<\/head>/i.test(html)) html = html.replace(/<\/head>/i, `${inject}\n</head>`);
    else html = inject + html;
  }
  return upsertFontLinks(html, t);
}

/* ------------------------------------------------------------------ */
/* industry templates                                                  */
/* ------------------------------------------------------------------ */

const TEMPLATES = {
  plumber: {
    label: 'Plumber',
    theme: { primary: '#0b5fff', secondary: '#0a2a6b', font: DEFAULT_THEME.font },
    home: ['nav', 'hero', 'benefits', 'services', 'about', 'reviews', 'cta', 'booking_button', 'footer'],
    about: ['nav', 'about', 'gallery', 'footer'],
    services: ['nav', 'services', 'faq', 'cta', 'footer'],
    contact: ['nav', 'contact_form', 'hours', 'map_placeholder', 'social_links', 'footer'],
  },
  electrician: {
    label: 'Electrician',
    theme: { primary: '#d97706', secondary: '#451a03', font: DEFAULT_THEME.font },
    home: ['nav', 'hero', 'benefits', 'services', 'about', 'reviews', 'faq', 'cta', 'booking_button', 'footer'],
    about: ['nav', 'about', 'gallery', 'footer'],
    services: ['nav', 'services', 'faq', 'cta', 'footer'],
    contact: ['nav', 'contact_form', 'hours', 'map_placeholder', 'social_links', 'footer'],
  },
  restaurant: {
    label: 'Restaurant',
    theme: { primary: '#b91c1c', secondary: '#450a0a', font: 'Georgia, "Times New Roman", serif' },
    home: ['nav', 'hero', 'benefits', 'gallery', 'reviews', 'hours', 'cta', 'booking_button', 'footer'],
    about: ['nav', 'about', 'gallery', 'footer'],
    services: ['nav', 'services', 'faq', 'cta', 'footer'],
    contact: ['nav', 'contact_form', 'hours', 'map_placeholder', 'social_links', 'footer'],
  },
  salon: {
    label: 'Salon',
    theme: { primary: '#be185d', secondary: '#500f28', font: DEFAULT_THEME.font },
    home: ['nav', 'hero', 'benefits', 'services', 'gallery', 'reviews', 'booking_button', 'cta', 'footer'],
    about: ['nav', 'about', 'gallery', 'footer'],
    services: ['nav', 'services', 'faq', 'cta', 'footer'],
    contact: ['nav', 'contact_form', 'hours', 'map_placeholder', 'social_links', 'footer'],
  },
  dentist: {
    label: 'Dentist',
    theme: { primary: '#0284c7', secondary: '#0c2d48', font: DEFAULT_THEME.font },
    home: ['nav', 'hero', 'benefits', 'services', 'about', 'reviews', 'faq', 'cta', 'booking_button', 'footer'],
    about: ['nav', 'about', 'gallery', 'footer'],
    services: ['nav', 'services', 'faq', 'cta', 'footer'],
    contact: ['nav', 'contact_form', 'hours', 'map_placeholder', 'social_links', 'footer'],
  },
  law_office: {
    label: 'Law Office',
    theme: { primary: '#1e3a5f', secondary: '#0b1c33', font: 'Georgia, "Times New Roman", serif' },
    home: ['nav', 'hero', 'benefits', 'about', 'services', 'reviews', 'faq', 'cta', 'footer'],
    about: ['nav', 'about', 'gallery', 'footer'],
    services: ['nav', 'services', 'faq', 'cta', 'footer'],
    contact: ['nav', 'contact_form', 'hours', 'map_placeholder', 'social_links', 'footer'],
  },
  general: {
    label: 'Local Business',
    theme: { primary: '#1a56db', secondary: '#0e2a5c', font: DEFAULT_THEME.font },
    home: ['nav', 'hero', 'benefits', 'services', 'about', 'reviews', 'faq', 'cta', 'booking_button', 'footer'],
    about: ['nav', 'about', 'gallery', 'footer'],
    services: ['nav', 'services', 'faq', 'cta', 'footer'],
    contact: ['nav', 'contact_form', 'hours', 'map_placeholder', 'social_links', 'footer'],
  },
};

const INDUSTRY_KEYWORDS = [
  [/plumb/i, 'plumber'],
  [/electric/i, 'electrician'],
  [/restaurant|diner|cafe|caf[eé]|pizza|sushi|grill|bistro|eatery|taco|bakery|barbecue|bbq|steakhouse/i, 'restaurant'],
  [/salon|barber|spa|nails|beauty|hair/i, 'salon'],
  [/dent|orthodont/i, 'dentist'],
  [/law|attorney|legal/i, 'law_office'],
];

function detectIndustry(category) {
  const c = String(category || '');
  for (const [re, key] of INDUSTRY_KEYWORDS) {
    if (re.test(c)) return key;
  }
  return 'general';
}

/* ------------------------------------------------------------------ */
/* facts + claim manifest                                              */
/* ------------------------------------------------------------------ */

/**
 * Collect renderable facts: business_facts rows with claim_class VERIFIED or
 * OWNER_PROVIDED, plus lead-record contact basics (treated as VERIFIED from
 * the lead record). UNKNOWN facts are returned separately for QA.
 */
function collectFacts(db, lead) {
  const ok = new Map(); // fact_key -> { value, source, claim_class }
  const unknown = []; // [{ fact_key, value }]
  const rows = db
    .prepare('SELECT fact_key, value, source, claim_class FROM business_facts WHERE lead_id = ?')
    .all(lead.id);
  for (const r of rows) {
    if (r.claim_class === 'VERIFIED' || r.claim_class === 'OWNER_PROVIDED') {
      ok.set(r.fact_key, { value: r.value, source: r.source, claim_class: r.claim_class });
    } else if (r.claim_class === 'UNKNOWN') {
      unknown.push({ fact_key: r.fact_key, value: r.value });
    }
  }
  const leadFact = (key, value) => {
    if (value !== null && value !== undefined && String(value).trim() !== '' && !ok.has(key)) {
      ok.set(key, { value: String(value), source: 'lead record', claim_class: 'VERIFIED' });
    }
  };
  leadFact('business_name', lead.business_name);
  leadFact('phone', lead.phone);
  leadFact('email', lead.email);
  leadFact('category', lead.category);
  leadFact('city', lead.city);
  leadFact('state', lead.state);
  const addrParts = [lead.address, lead.city, lead.state, lead.postal_code].filter(Boolean);
  if (addrParts.length) leadFact('address', addrParts.join(', '));
  leadFact('description', lead.description);
  // hours JSON -> 'hours'
  try {
    const h = lead.hours ? JSON.parse(lead.hours) : null;
    if (Array.isArray(h) && h.length)
      ok.set('hours', { value: JSON.stringify(h), source: 'lead record', claim_class: 'VERIFIED' });
  } catch (e) {
    /* ignore malformed */
  }
  // services JSON -> service:<name> facts
  try {
    const s = lead.services ? JSON.parse(lead.services) : null;
    if (Array.isArray(s)) {
      for (const name of s) {
        const n = String(name || '').trim();
        if (n) ok.set(`service:${n.toLowerCase()}`, { value: n, source: 'lead record', claim_class: 'VERIFIED' });
      }
    }
  } catch (e) {
    /* ignore malformed */
  }
  // social links JSON -> 'social'
  try {
    const s = lead.social_links ? JSON.parse(lead.social_links) : null;
    if (Array.isArray(s) && s.length)
      ok.set('social', { value: JSON.stringify(s), source: 'lead record', claim_class: 'VERIFIED' });
  } catch (e) {
    /* ignore malformed */
  }
  return { ok, unknown };
}

function serviceNames(facts) {
  const names = [];
  for (const [k, f] of facts.ok) {
    if (k.startsWith('service:')) names.push(f.value);
  }
  return names;
}

/* ------------------------------------------------------------------ */
/* copy — deterministic fallback + AI generation                        */
/* ------------------------------------------------------------------ */

const DEFAULT_BUILD_PROMPT = `You write marketing copy for a local business website.
RULES (anti-hallucination — critical):
- Use ONLY the facts provided in the business context. Never invent founding years, awards, licenses, addresses, prices, or staff names.
- Marketing tone is welcome, but every sentence must be either (a) grounded in a provided fact, or (b) generic puffery with no factual assertion (e.g. "We treat every job with care.").
- Do not claim the business is "licensed", "insured", "award-winning", "the best", or "since YEAR" unless that fact was provided.
Return ONLY valid JSON with this shape:
{
  "hero_headline": "string (<= 90 chars)",
  "hero_subheadline": "string (<= 200 chars)",
  "benefits": [{"title": "...", "text": "..."} x4],
  "about_paragraphs": ["...", "..."],
  "faq": [{"q": "...", "a": "..."} x5],
  "cta_title": "string",
  "cta_text": "string (<= 200 chars)"
}`;

function getBuildPrompt(db) {
  const row = db.prepare('SELECT body FROM prompts WHERE key = ?').get('build_website');
  const body = row && row.body ? String(row.body).trim() : '';
  return body || DEFAULT_BUILD_PROMPT;
}

function stripCodeFences(s) {
  let t = String(s || '').trim();
  if (t.startsWith('```')) {
    t = t.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```\s*$/, '');
  }
  return t.trim();
}

function deterministicCopy(lead, industry, facts) {
  const name = lead.business_name || 'Our Business';
  const label = TEMPLATES[industry].label;
  const city = facts.ok.get('city');
  const cityBit = city ? ` in ${city.value}` : '';
  const phone = facts.ok.get('phone');
  const services = serviceNames(facts);

  const hero_headline = `${name} — Trusted ${label} Services${cityBit}`;
  const hero_subheadline = phone
    ? `Call ${phone.value} today for friendly, reliable ${label.toLowerCase()} service${cityBit}.`
    : `Friendly, reliable ${label.toLowerCase()} service${cityBit} — get in touch today.`;

  const benefits = [
    {
      title: 'Local & Friendly',
      text: `A neighborhood ${label.toLowerCase()} you can talk to directly — no call centers, no runaround.`,
    },
    { title: 'Clear Communication', text: 'We explain what we are doing in plain language before any work begins.' },
    { title: 'Respectful Service', text: 'We treat your home or business with care and clean up after ourselves.' },
    {
      title: 'Easy to Reach',
      text: phone
        ? `One call to ${phone.value} is all it takes to get started.`
        : 'Reach out by phone or through the contact form below.',
    },
  ];

  const about_paragraphs = [
    `${name} provides ${label.toLowerCase()} services${cityBit}.`,
    'We focus on honest work, clear pricing, and treating every customer like a neighbor — because you are one.',
  ];
  const desc = facts.ok.get('description');
  if (desc) about_paragraphs.unshift(desc.value);

  const faq = [
    {
      q: `How do I get started with ${name}?`,
      a: phone
        ? `Just call ${phone.value} or send a message through the contact form and we will take it from there.`
        : 'Just send a message through the contact form and we will take it from there.',
    },
    {
      q: 'Do I need an appointment?',
      a: 'It is best to reach out ahead of time so we can make sure someone is available to help you.',
    },
    {
      q: 'What areas do you serve?',
      a: city
        ? `We serve ${city.value} and the surrounding area. Contact us to confirm.`
        : 'Contact us to confirm we cover your area.',
    },
    {
      q: 'How do I get a quote?',
      a: 'Call or message us with a few details about what you need and we will walk you through the next steps.',
    },
    {
      q: 'What if I need to reschedule?',
      a: 'Life happens — just let us know as early as you can and we will find another time.',
    },
  ];

  return {
    hero_headline: cleanText(hero_headline, 90),
    hero_subheadline: cleanText(hero_subheadline, 200),
    benefits,
    about_paragraphs: about_paragraphs.map((p) => cleanText(p, 600)),
    faq: faq.map((f) => ({ q: cleanText(f.q, 160), a: cleanText(f.a, 400) })),
    cta_title: `Ready to get started with ${name}?`,
    cta_text: phone
      ? `Call ${phone.value} or send us a message — we would love to help.`
      : 'Send us a message — we would love to help.',
    services: services.map((n) => ({ name: n, description: `Professional ${n.toLowerCase()} done with care.` })),
  };
}

async function aiCopy(db, lead, industry, facts) {
  const context = {
    business_name: lead.business_name,
    industry: TEMPLATES[industry].label,
    category: lead.category || null,
    city: facts.ok.get('city')?.value || null,
    state: facts.ok.get('state')?.value || null,
    phone: facts.ok.get('phone')?.value || null,
    email: facts.ok.get('email')?.value || null,
    address: facts.ok.get('address')?.value || null,
    hours: facts.ok.get('hours') ? JSON.parse(facts.ok.get('hours').value) : null,
    services: serviceNames(facts),
    description: facts.ok.get('description')?.value || null,
    rating: lead.rating || null,
    review_count: lead.review_count || null,
  };
  const systemPrompt = getBuildPrompt(db);
  const { text } = await ai.chat({
    task: 'generation',
    db,
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: `Business context (facts only — do not invent anything else):\n${JSON.stringify(context, null, 2)}`,
      },
    ],
    maxTokens: 2000,
    leadId: lead.id,
    note: `website copy for ${lead.business_name}`,
  });
  const parsed = JSON.parse(stripCodeFences(text));
  const det = deterministicCopy(lead, industry, facts); // fallback for missing keys
  const pick = (v, fb, max) => {
    const c = cleanText(v, max);
    return c || fb;
  };
  const benefits =
    Array.isArray(parsed.benefits) && parsed.benefits.length
      ? parsed.benefits.slice(0, 4).map((b, i) => ({
          title: pick(b.title, det.benefits[i % det.benefits.length].title, 80),
          text: pick(b.text, det.benefits[i % det.benefits.length].text, 300),
        }))
      : det.benefits;
  const about_paragraphs =
    Array.isArray(parsed.about_paragraphs) && parsed.about_paragraphs.length
      ? parsed.about_paragraphs
          .slice(0, 4)
          .map((p) => cleanText(p, 600))
          .filter(Boolean)
      : det.about_paragraphs;
  const faq =
    Array.isArray(parsed.faq) && parsed.faq.length
      ? parsed.faq.slice(0, 6).map((f, i) => ({
          q: pick(f.q, det.faq[i % det.faq.length].q, 160),
          a: pick(f.a, det.faq[i % det.faq.length].a, 400),
        }))
      : det.faq;
  return {
    hero_headline: pick(parsed.hero_headline, det.hero_headline, 90),
    hero_subheadline: pick(parsed.hero_subheadline, det.hero_subheadline, 200),
    benefits,
    about_paragraphs: about_paragraphs.length ? about_paragraphs : det.about_paragraphs,
    faq,
    cta_title: pick(parsed.cta_title, det.cta_title, 90),
    cta_text: pick(parsed.cta_text, det.cta_text, 200),
    services: det.services, // service names always come from verified facts
  };
}

/* ------------------------------------------------------------------ */
/* page assembly                                                       */
/* ------------------------------------------------------------------ */

function buildSection(type, lead, facts, copy, industry) {
  const name = lead.business_name || 'Our Business';
  const phone = facts.ok.get('phone')?.value || null;
  const email = facts.ok.get('email')?.value || null;
  const address = facts.ok.get('address')?.value || null;
  const city = facts.ok.get('city')?.value || null;
  const label = TEMPLATES[industry].label;

  switch (type) {
    case 'nav':
      return { type, content: { business_name: name, phone, phone_display: phone, links: [] } };
    case 'hero': {
      const c = { headline: copy.hero_headline, subheadline: copy.hero_subheadline };
      if (phone) {
        c.cta_text = `Call ${phone}`;
        c.cta_href = `tel:${digitsOnly(phone)}`;
      }
      c.cta_secondary_text = 'Our Services';
      c.cta_secondary_href = '#services';
      if (lead.rating && lead.review_count) {
        c.rating = lead.rating;
        c.review_count = lead.review_count;
      }
      return { type, content: c };
    }
    case 'benefits':
      return { type, content: { title: `Why Choose ${name}`, items: copy.benefits } };
    case 'services': {
      const items = copy.services.length ? copy.services : [];
      if (!items.length) return null; // omit section when nothing verified
      return { type, content: { title: 'Our Services', subtitle: `What ${name} can do for you.`, items } };
    }
    case 'about':
      return { type, content: { title: `About ${name}`, paragraphs: copy.about_paragraphs } };
    case 'gallery':
      return {
        type,
        content: {
          title: 'Gallery',
          subtitle: 'A look at our work. (Photo placeholders — the owner can replace these.)',
        },
      };
    case 'reviews': {
      const items = [];
      // Only real review texts would go here; lead rating alone is shown as a badge.
      if (!items.length) return null;
      return { type, content: { title: 'Customer Reviews', reviews: items } };
    }
    case 'cta':
      return {
        type,
        content: {
          title: copy.cta_title,
          text: copy.cta_text,
          button_text: phone ? `Call ${phone}` : 'Contact Us',
          button_href: phone ? `tel:${digitsOnly(phone)}` : '#contact',
        },
      };
    case 'contact_form': {
      if (!email && !phone) return null;
      return {
        type,
        content: {
          title: 'Contact Us',
          text: `Reach out to ${name} — we will get back to you as soon as we can.`,
          email,
          phone,
          address,
          mailto_subject: `Website inquiry for ${name}`,
        },
      };
    }
    case 'map_placeholder': {
      if (!address) return null;
      return { type, content: { title: 'Find Us', address_lines: [address] } };
    }
    case 'hours': {
      const h = facts.ok.get('hours');
      if (!h) return null;
      let hours = [];
      try {
        hours = JSON.parse(h.value);
      } catch (e) {
        return null;
      }
      if (!Array.isArray(hours) || !hours.length) return null;
      return { type, content: { title: 'Business Hours', hours } };
    }
    case 'faq':
      return { type, content: { title: 'Frequently Asked Questions', items: copy.faq } };
    case 'footer':
      return {
        type,
        content: {
          business_name: name,
          phone,
          email,
          address,
          tagline: `${label} services${city ? ` in ${city}` : ''}.`,
        },
      };
    case 'booking_button': {
      if (!phone) return null;
      return {
        type,
        content: {
          title: 'Ready when you are',
          text: `Call ${phone}`,
          href: `tel:${digitsOnly(phone)}`,
          subtext: 'Tap to call now.',
        },
      };
    }
    case 'social_links': {
      const s = facts.ok.get('social');
      if (!s) return null;
      let links = [];
      try {
        links = JSON.parse(s.value);
      } catch (e) {
        return null;
      }
      if (!Array.isArray(links) || !links.length) return null;
      return { type, content: { title: 'Follow Us', links } };
    }
    default:
      return null;
  }
}

/**
 * Build pages JSON + claim manifest from template + verified facts.
 * Returns { pages, manifest } where manifest is [{claim, value, class, source}].
 */
function buildPages(lead, industry, facts, copy, aiUsed) {
  const tpl = TEMPLATES[industry];
  const manifest = [];
  const claim = (claimName, value, cls, source) => {
    manifest.push({ claim: claimName, value: String(value).slice(0, 200), class: cls, source });
  };

  // Record every rendered fact with its provenance.
  const renderedFactKeys = new Set([
    'business_name',
    'phone',
    'email',
    'address',
    'city',
    'state',
    'hours',
    'social',
    'description',
  ]);
  for (const [k, f] of facts.ok) {
    if (k.startsWith('service:') || renderedFactKeys.has(k)) {
      claim(k.startsWith('service:') ? 'service' : k, f.value, f.claim_class, f.source);
    }
  }
  if (lead.rating && lead.review_count) {
    claim('rating', `${lead.rating} (${lead.review_count} reviews)`, 'VERIFIED', 'lead record');
  }
  // Marketing copy is AI_COPY by definition (tone only, no factual assertions).
  claim(
    'marketing_copy',
    aiUsed
      ? 'AI-generated headlines, benefits, about text, FAQ'
      : 'Template-generated headlines, benefits, about text, FAQ',
    'AI_COPY',
    aiUsed ? 'ai: generation' : 'websiteEngine deterministic'
  );

  const pageDefs = [
    { slug: '/', title: 'Home', types: tpl.home },
    { slug: '/about', title: 'About', types: tpl.about },
    { slug: '/services', title: 'Services', types: tpl.services },
    { slug: '/contact', title: 'Contact', types: tpl.contact },
  ];

  const pages = pageDefs.map((pd) => {
    const sections = [];
    for (const st of pd.types) {
      const s = buildSection(st, lead, facts, copy, industry);
      if (s) sections.push(s);
    }
    // A page must never be empty: nav + footer are the floor.
    if (!sections.some((s) => s.type === 'nav')) sections.unshift(buildSection('nav', lead, facts, copy, industry));
    if (!sections.some((s) => s.type === 'footer')) sections.push(buildSection('footer', lead, facts, copy, industry));
    return { slug: pd.slug, title: pd.title, sections };
  });

  return { pages, manifest };
}

/* ------------------------------------------------------------------ */
/* public API                                                          */
/* ------------------------------------------------------------------ */

function getWebsite(db, websiteId) {
  const site = db.prepare('SELECT * FROM websites WHERE id = ?').get(websiteId);
  if (!site) throw err('SITE_NOT_FOUND', `Website #${websiteId} not found.`);
  return site;
}

function getManifest(db, websiteId) {
  ensureTables(db);
  const row = db.prepare('SELECT manifest FROM claim_manifest WHERE website_id = ?').get(websiteId);
  if (!row) return [];
  try {
    return JSON.parse(row.manifest);
  } catch (e) {
    return [];
  }
}

function slugifyExportName(s) {
  return (
    String(s || 'site')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'site'
  );
}

/**
 * True when an EXPORT_ROOT folder belongs to this website.
 * When workspaceId is set, only that workspace's ws-{ws}-site-{id}* folders
 * plus legacy site-{id} / qa-site-{id} / slug-{id} — never other workspaces.
 */
function folderBelongsToSite(name, websiteId, workspaceId, siteName) {
  const id = String(websiteId);
  if (!name || !id) return false;
  const ws =
    workspaceId != null && Number.isInteger(Number(workspaceId)) && Number(workspaceId) > 0
      ? String(Number(workspaceId))
      : null;

  if (name === `site-${id}` || name === `qa-site-${id}`) return true;
  if (siteName) {
    const slugFolder = `${slugifyExportName(siteName)}-${id}`;
    if (name === slugFolder) return true;
  }

  if (ws) {
    const wsPrefix = `ws-${ws}-site-${id}`;
    if (name === wsPrefix || name.startsWith(`${wsPrefix}-`)) return true;
    // Truncated exportPages folders (max 40 chars) may cut the slug suffix —
    // accept only when the next char is not another digit (site-5 vs site-50).
    if (name.startsWith(wsPrefix) && name.length <= 40) {
      const rest = name.slice(wsPrefix.length);
      if (!rest || rest[0] === '-' || !/^\d/.test(rest)) return true;
    }
    // Do not match ws-{other}-site-{id}*
    if (/^ws-\d+-site-/.test(name)) return false;
  }

  return folderMatchesSiteId(name, websiteId);
}

function resolveExportRootSafe() {
  try {
    return require('./openPreview').exportRoot();
  } catch {
    return null;
  }
}

function assertDirInsideExportRoot(absPath, root) {
  if (!absPath || !root) return null;
  const rootResolved = path.resolve(root);
  const dirResolved = path.resolve(absPath);
  const rel = path.relative(rootResolved, dirResolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  // Refuse deleting the export root itself.
  if (rel === '.' || rel === '') return null;
  return dirResolved;
}

/**
 * Collect EXPORT_ROOT folders owned by this site (names only, under root).
 */
function collectSiteExportFolders(websiteId, opts = {}) {
  const root = opts.exportRoot || resolveExportRootSafe();
  if (!root || !fs.existsSync(root)) return [];
  const id = Number(websiteId);
  const workspaceId = opts.workspaceId;
  const siteName = opts.siteName || '';
  const found = new Set();

  const candidates = [`site-${id}`, `qa-site-${id}`, siteName ? `${slugifyExportName(siteName)}-${id}` : null].filter(
    Boolean
  );
  if (workspaceId != null && Number(workspaceId) > 0) {
    candidates.push(`ws-${Number(workspaceId)}-site-${id}`);
  }
  for (const name of candidates) found.add(name);

  // Batch 67 (M-2): design-preview folders of jobs linked to this site
  // hold a full copy of the delivered site. On purge they must go too —
  // destroyWebsite unlinks the jobs (website_id = NULL), after which
  // the folder would be an ungated orphan. Names embed the workspace,
  // so match any ws-*-design-{jobId} for the known job ids.
  const designJobIds = (Array.isArray(opts.designJobIds) ? opts.designJobIds : [])
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);
  if (designJobIds.length && workspaceId != null && Number(workspaceId) > 0) {
    for (const jobId of designJobIds) found.add(`ws-${Number(workspaceId)}-design-${jobId}`);
  }

  try {
    for (const name of fs.readdirSync(root)) {
      if (folderBelongsToSite(name, id, workspaceId, siteName)) found.add(name);
      if (designJobIds.length) {
        const dm = name.match(/^ws-\d+-design-(\d+)$/);
        if (dm && designJobIds.includes(Number(dm[1]))) found.add(name);
      }
    }
  } catch {
    /* optional */
  }

  if (opts.previewPath) {
    try {
      const p = String(opts.previewPath).replace(/\\/g, '/');
      const m = p.match(/website-scout-exports\/([^/]+)/i) || p.match(/\/([^/]+)\/(?:index\.html)?$/i);
      if (m && m[1] && folderBelongsToSite(m[1], id, workspaceId, siteName)) {
        found.add(m[1]);
      }
    } catch {
      /* optional */
    }
  }

  return [...found];
}

function removeSiteStorageFolders(websiteId, opts = {}) {
  const root = opts.exportRoot || resolveExportRootSafe();
  const removed = [];
  const skipped = [];
  if (!root) return { removed, skipped, exportRoot: null };
  const folders = collectSiteExportFolders(websiteId, Object.assign({}, opts, { exportRoot: root }));
  for (const name of folders) {
    const abs = assertDirInsideExportRoot(path.join(root, name), root);
    if (!abs) {
      skipped.push(name);
      continue;
    }
    try {
      if (!fs.existsSync(abs)) continue;
      const st = fs.lstatSync(abs);
      if (!st.isDirectory()) {
        skipped.push(name);
        continue;
      }
      fs.rmSync(abs, { recursive: true, force: true });
      removed.push(name);
    } catch (e) {
      skipped.push(`${name}:${e.message}`);
    }
  }
  return { removed, skipped, exportRoot: root };
}

/**
 * Batch 27 — SOFT delete: archive a website. NOTHING is destroyed: the row,
 * pages/versions, design jobs, assets, export folders and all site-linked
 * data stay intact so a restore is instant and complete. The site only gets
 * websites.archived_at stamped; archived sites are excluded from public
 * rendering, published/export routes, portal and staff site lists (the list
 * queries filter on archived_at). No Cloudflare Pages teardown happens here.
 * Deleting an already-archived site is a no-op.
 *
 * @returns {{ id, archived: true, alreadyArchived: boolean, name, lead_id, archived_at }}
 */
function deleteWebsite(db, websiteId, opts = {}) {
  ensureTables(db);
  const id = Number(websiteId);
  if (!Number.isInteger(id) || id < 1) throw err('INVALID_ID', 'id must be a positive integer.');
  const site = db.prepare('SELECT * FROM websites WHERE id = ?').get(id);
  if (!site) throw err('SITE_NOT_FOUND', `Website #${id} not found.`);
  if (site.archived_at) {
    return { id, archived: true, alreadyArchived: true, name: site.name, lead_id: site.lead_id, archived_at: site.archived_at };
  }
  db.prepare("UPDATE websites SET archived_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(id);
  const row = db.prepare('SELECT archived_at FROM websites WHERE id = ?').get(id);
  logActivity(db, 'websites', `Website #${id} ("${String(site.name || '').slice(0, 80)}") archived (soft delete).`);
  return { id, archived: true, alreadyArchived: false, name: site.name, lead_id: site.lead_id, archived_at: row.archived_at };
}

/**
 * Batch 27 — restore an archived website: clears archived_at; the site
 * returns to the normal lists with pages/versions/data exactly as they were
 * and in its pre-archive publish state (nothing is auto-published).
 * Restoring a site that is not archived is a no-op.
 */
function restoreWebsite(db, websiteId) {
  ensureTables(db);
  const id = Number(websiteId);
  if (!Number.isInteger(id) || id < 1) throw err('INVALID_ID', 'id must be a positive integer.');
  const site = db.prepare('SELECT * FROM websites WHERE id = ?').get(id);
  if (!site) throw err('SITE_NOT_FOUND', `Website #${id} not found.`);
  if (!site.archived_at) {
    return { id, restored: false, archived: false, name: site.name, lead_id: site.lead_id };
  }
  db.prepare("UPDATE websites SET archived_at = NULL, updated_at = datetime('now') WHERE id = ?").run(id);
  logActivity(db, 'websites', `Website #${id} ("${String(site.name || '').slice(0, 80)}") restored from archive.`);
  return { id, restored: true, archived: false, name: site.name, lead_id: site.lead_id };
}

/** Batch 27 — archived websites for the staff Archives page (newest first). */
function listArchivedWebsites(db) {
  ensureTables(db);
  return db
    .prepare(
      `SELECT w.id, w.lead_id, w.name, w.industry, w.status, w.origin, w.archived_at, w.created_at, w.updated_at,
              l.business_name, l.category
       FROM websites w LEFT JOIN leads l ON l.id = w.lead_id
       WHERE w.archived_at IS NOT NULL
       ORDER BY w.archived_at DESC`
    )
    .all();
}

/** True when a website row is archived (soft-deleted). */
function isArchivedSite(site) {
  return !!(site && site.archived_at);
}

/**
 * PERMANENT destroy — internal cleanup only (e.g. generateSite force-rebuild).
 * Deletes the website row and all associated on-disk export/preview assets.
 * Safe across shared EXPORT_ROOT: with workspaceId, never removes another
 * workspace's ws-{other}-site-* folders. Does not delete remote Cloudflare
 * Pages projects (may be shared via cf.project). Design jobs are unlinked,
 * not deleted. Contact forms / modules stay on the lead.
 * NOT exposed as a UI/MCP delete — user-facing delete is the soft archive
 * above (deleteWebsite).
 *
 * @returns {{ id, deleted: true, removedFolders: string[], skippedFolders: string[] }}
 */
function destroyWebsite(db, websiteId, opts = {}) {
  ensureTables(db);
  const id = Number(websiteId);
  if (!Number.isInteger(id) || id < 1) throw err('INVALID_ID', 'id must be a positive integer.');
  const site = db.prepare('SELECT * FROM websites WHERE id = ?').get(id);
  if (!site) throw err('SITE_NOT_FOUND', `Website #${id} not found.`);

  const workspaceId = opts.workspaceId != null ? Number(opts.workspaceId) : null;
  // Batch 67 (M-2): capture the design jobs linked to this site BEFORE
  // the transaction unlinks them, so their design-preview folders can
  // be removed with the site's own folders below.
  let designJobIds = [];
  try {
    designJobIds = db
      .prepare('SELECT id FROM design_jobs WHERE website_id = ?')
      .all(id)
      .map((r) => r.id);
  } catch {
    /* table may be absent */
  }
  const storageOpts = {
    workspaceId: Number.isInteger(workspaceId) && workspaceId > 0 ? workspaceId : null,
    siteName: site.name,
    previewPath: site.preview_path,
    designJobIds,
  };

  // Snapshot screenshot paths before DB wipe (files usually live under site-{id}/).
  let shotPaths = [];
  try {
    shotPaths = db
      .prepare('SELECT storage_path FROM site_screenshots WHERE website_id = ?')
      .all(id)
      .map((r) => r.storage_path)
      .filter(Boolean);
  } catch {
    /* table may be absent */
  }

  const tx = db.transaction(() => {
    try {
      db.prepare('DELETE FROM site_screenshots WHERE website_id = ?').run(id);
    } catch {
      /* */
    }
    try {
      db.prepare("UPDATE site_domains SET website_id = NULL, updated_at = datetime('now') WHERE website_id = ?").run(
        id
      );
    } catch {
      /* */
    }
    try {
      db.prepare("UPDATE design_jobs SET website_id = NULL, updated_at = datetime('now') WHERE website_id = ?").run(id);
    } catch {
      /* */
    }
    try {
      db.prepare('DELETE FROM claim_manifest WHERE website_id = ?').run(id);
    } catch {
      /* */
    }
    try {
      db.prepare('DELETE FROM website_versions WHERE website_id = ?').run(id);
    } catch {
      /* */
    }
    db.prepare('DELETE FROM websites WHERE id = ?').run(id);
  });
  tx();

  const storage = removeSiteStorageFolders(id, storageOpts);

  // Remove any screenshot files that lived outside the folders we already wiped.
  const root = storage.exportRoot || resolveExportRootSafe();
  if (root && shotPaths.length) {
    for (const sp of shotPaths) {
      try {
        const abs = assertDirInsideExportRoot(path.dirname(sp), root);
        if (!abs) continue;
        // Only unlink the file if its parent folder still exists (folder wipe may have got it).
        if (fs.existsSync(sp) && fs.statSync(sp).isFile()) {
          const fileOk = assertDirInsideExportRoot(sp, root);
          if (fileOk) fs.unlinkSync(sp);
        }
      } catch {
        /* best-effort */
      }
    }
  }

  logActivity(
    db,
    'websites',
    `Website #${id} ("${String(site.name || '').slice(0, 80)}") deleted; removed ${storage.removed.length} export folder(s).`
  );
  return {
    id,
    deleted: true,
    name: site.name,
    lead_id: site.lead_id,
    removedFolders: storage.removed,
    skippedFolders: storage.skipped,
  };
}

/**
 * Generate a website for a lead.
 * - industry template + VERIFIED/OWNER_PROVIDED facts only
 * - AI marketing copy when configured, else deterministic template copy
 * - stores website row + version 1 + claim manifest; lead -> qa_pending
 */
async function generateSite(db, leadId, opts = {}) {
  ensureTables(db);
  ai.setDb(db);

  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
  if (!lead) throw err('LEAD_NOT_FOUND', `Lead #${leadId} not found.`);

  const existing = db.prepare('SELECT id FROM websites WHERE lead_id = ?').get(leadId);
  if (existing && !opts.force) return { id: existing.id, reused: true };
  if (existing && opts.force) {
    // Full rebuild: wipe DB row + export/preview storage for the previous site.
    destroyWebsite(db, existing.id, { workspaceId: opts.workspaceId });
    logActivity(
      db,
      'websites',
      `Regenerating website for "${lead.business_name}" (lead #${leadId}) — previous site replaced.`
    );
  }

  setLeadStatus(db, leadId, 'building');
  logActivity(db, 'websites', `Generating website for "${lead.business_name}" (lead #${leadId}).`);

  const industry = detectIndustry(lead.category);
  const facts = collectFacts(db, lead);

  let copy;
  let aiUsed = false;
  // Batch 143: aiConfigured() requires the workspace db — the
  // no-arg call always returned false, so this branch never ran
  // and generation always fell back to deterministic copy.
  if (ai.aiConfigured(db)) {
    try {
      copy = await aiCopy(db, lead, industry, facts);
      aiUsed = true;
    } catch (e) {
      // AI failure (incl. AI_NOT_CONFIGURED/BUDGET_EXCEEDED/AUTOMATION_PAUSED)
      // falls back to deterministic copy — generation never hard-fails on AI.
      logActivity(db, 'websites', `AI copy failed for lead #${leadId} (${e.code || e.message}); using template copy.`);
      copy = deterministicCopy(lead, industry, facts);
    }
  } else {
    copy = deterministicCopy(lead, industry, facts);
  }

  const theme = normalizeTheme(TEMPLATES[industry].theme);
  const { pages, manifest } = buildPages(lead, industry, facts, copy, aiUsed);
  require('./siteContentQuality').assertNoNewDefects(pages, [], theme);

  const info = db
    .prepare(
      `INSERT INTO websites (lead_id, name, industry, theme, pages, status)
     VALUES (?, ?, ?, ?, ?, 'draft')`
    )
    .run(leadId, lead.business_name, industry, JSON.stringify(theme), JSON.stringify(pages));
  const websiteId = Number(info.lastInsertRowid);

  db.prepare('INSERT INTO website_versions (website_id, version_no, pages, theme, note) VALUES (?, ?, ?, ?, ?)').run(
    websiteId,
    1,
    JSON.stringify(pages),
    JSON.stringify(theme),
    aiUsed ? 'Initial generation (AI copy)' : 'Initial generation (template copy)'
  );

  db.prepare('INSERT OR REPLACE INTO claim_manifest (website_id, manifest) VALUES (?, ?)').run(
    websiteId,
    JSON.stringify(manifest)
  );

  try {
    db.prepare("UPDATE websites SET origin = 'template' WHERE id = ?").run(websiteId);
  } catch (e) {
    /* origin column is added by ensureTables */
  }

  setLeadStatus(db, leadId, 'qa_pending');
  logActivity(db, 'websites', `Website #${websiteId} generated for "${lead.business_name}" — awaiting QA.`);

  return { id: websiteId, industry, aiUsed, reused: false };
}

/**
 * Batch 45 — website_versions retention: keep the newest `keep` versions
 * per site. Versions grow one row per save per site, forever; 50 is far
 * beyond any realistic restore need and bounds the table. Returns the
 * number of rows pruned. Never touches the newest `keep` rows.
 */
function pruneWebsiteVersions(db, websiteId, keep = 50) {
  ensureTables(db);
  const keepN = Math.max(1, Number(keep) || 50);
  const info = db
    .prepare(
      `DELETE FROM website_versions
       WHERE website_id = ?
         AND id NOT IN (
           SELECT id FROM website_versions
           WHERE website_id = ?
           ORDER BY version_no DESC, id DESC
           LIMIT ?
         )`
    )
    .run(Number(websiteId), Number(websiteId), keepN);
  return Number(info.changes || 0);
}

/**
 * Batch 45 — periodic retention sweep for one workspace DB (invoked by
 * the scheduler, throttled there): activity_log older than 180 days and
 * website_versions beyond the newest 50 per site. Quiet by design — a
 * single summary activity row is written ONLY when something was
 * pruned. Financial/audit tables are never touched.
 */
function runRetentionPrunes(db) {
  ensureTables(db);
  let activityPruned = 0;
  let versionsPruned = 0;
  try {
    const info = db
      .prepare("DELETE FROM activity_log WHERE at < datetime('now', '-180 days')")
      .run();
    activityPruned = Number(info.changes || 0);
  } catch {
    /* activity_log absent on a bare DB */
  }
  const sites = db.prepare('SELECT id FROM websites').all();
  for (const s of sites) versionsPruned += pruneWebsiteVersions(db, s.id, 50);
  if (activityPruned || versionsPruned) {
    logActivity(
      db,
      'retention',
      `Retention prune: removed ${activityPruned} activity rows older than 180 days and ${versionsPruned} website versions beyond the newest 50 per site.`
    );
  }
  return { activityPruned, versionsPruned };
}

/** Snapshot current pages+theme as a new version. Returns the version row. */
function saveVersion(db, websiteId, note, author) {
  ensureTables(db);
  const site = getWebsite(db, websiteId);
  const row = db
    .prepare('SELECT COALESCE(MAX(version_no), 0) AS m FROM website_versions WHERE website_id = ?')
    .get(websiteId);
  const next = Number(row.m) + 1;
  const authorVal = author != null && String(author).trim() ? String(author).trim().slice(0, 120) : null;
  const info = db
    .prepare(
      'INSERT INTO website_versions (website_id, version_no, pages, theme, note, author) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(websiteId, next, site.pages, site.theme, note ? String(note).slice(0, 500) : null, authorVal);
  // Batch 45: prune-on-save keeps the version history bounded.
  try {
    pruneWebsiteVersions(db, websiteId, 50);
  } catch {
    /* pruning must never break a save */
  }
  return db.prepare('SELECT * FROM website_versions WHERE id = ?').get(Number(info.lastInsertRowid));
}

/** Restore a version: applies its pages+theme and snapshots as a new version. */
function restoreVersion(db, versionId) {
  const v = db.prepare('SELECT * FROM website_versions WHERE id = ?').get(versionId);
  if (!v) throw err('VERSION_NOT_FOUND', `Version #${versionId} not found.`);
  // Batch 31 (C3): stamp per-page updatedAt against the pre-restore pages.
  let restoredPagesJson = v.pages;
  try {
    const current = getWebsite(db, v.website_id);
    const oldPages = typeof current.pages === 'string' ? JSON.parse(current.pages) : current.pages;
    const restored = typeof v.pages === 'string' ? JSON.parse(v.pages) : v.pages;
    if (Array.isArray(restored)) restoredPagesJson = JSON.stringify(stampPageUpdatedAt(oldPages, restored));
  } catch {
    /* stamping is best-effort; the stored pages stay valid either way */
  }
  db.prepare("UPDATE websites SET pages = ?, theme = ?, updated_at = datetime('now') WHERE id = ?").run(
    restoredPagesJson,
    v.theme,
    v.website_id
  );
  saveVersion(db, v.website_id, `Restored version ${v.version_no}`);
  return getWebsite(db, v.website_id);
}

/** Apply an edited pages/theme model (validated by the IPC layer) + version it. */
function saveSite(db, websiteId, pages, theme, note, author) {
  const site = getWebsite(db, websiteId);
  require('./siteContentQuality').assertNoNewDefects(
    pages,
    typeof site.pages === 'string' ? JSON.parse(site.pages) : site.pages,
    theme,
    typeof site.theme === 'string' ? JSON.parse(site.theme) : site.theme
  );
  // Batch 31 (C3): per-page updatedAt stamps — a page's stamp moves only
  // when THAT page's content changes, so sitemap lastmod stays honest.
  let stampedPages = pages;
  try {
    const oldPages = typeof site.pages === 'string' ? JSON.parse(site.pages) : site.pages;
    if (Array.isArray(oldPages) && Array.isArray(pages)) stampedPages = stampPageUpdatedAt(oldPages, pages);
  } catch {
    /* best-effort */
  }
  db.prepare("UPDATE websites SET pages = ?, theme = ?, updated_at = datetime('now') WHERE id = ?").run(
    JSON.stringify(stampedPages),
    JSON.stringify(normalizeTheme(theme)),
    websiteId
  );
  return saveVersion(db, websiteId, note || 'Manual edit', author);
}

/* ------------------------------------------------------------------ */
/* QA                                                                  */
/* ------------------------------------------------------------------ */

const QA_BUILD_PROMPT_FALLBACK = `You are a QA reviewer for a local business website.
Check the site for: hallucinated facts (founding years, awards, licenses not in the provided facts), placeholder text, wrong phone numbers, broken image links, spelling errors.
The business facts provided are the ONLY facts allowed. Marketing puffery without factual assertions is fine.
Reply with ONLY JSON: {"pass": true|false, "issues": ["..."]}`;

/**
 * Headless check: render home HTML and detect horizontal overflow at viewport width.
 * Uses puppeteer when available; otherwise returns ok:true with skipped note via throw.
 */
async function checkMobileOverflow(pages, theme, opts = {}) {
  const width = Math.max(320, Math.round(Number(opts.width) || 390));
  const height = Math.max(480, Math.round(Number(opts.height) || 844));
  const html = renderPage(homePage(pages) || pages[0], pages, theme);
  let puppeteer;
  try {
    puppeteer = require('puppeteer');
  } catch {
    const e = new Error('puppeteer not installed');
    e.code = 'PUPPETEER_MISSING';
    throw e;
  }
  const launchOpts = {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  };
  for (const p of [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome-stable',
  ]) {
    if (p && fs.existsSync(p)) {
      launchOpts.executablePath = p;
      break;
    }
  }
  const browser = await puppeteer.launch(launchOpts);
  try {
    const page = await browser.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    // Batch 145 (external review F11): QA renders generated HTML in
    // the same sandbox-disabled Chromium — intercept subresources
    // and abort any that fail the public-URL guard.
    await require('../server/browserGuard').guardBrowserPage(page);
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const result = await page.evaluate(() => {
      const docEl = document.documentElement;
      const body = document.body;
      const scrollW = Math.max(docEl.scrollWidth, body ? body.scrollWidth : 0);
      const clientW = docEl.clientWidth || window.innerWidth;
      const overflowing = [];
      const nodes = document.querySelectorAll('body *');
      for (let i = 0; i < Math.min(nodes.length, 400); i++) {
        const el = nodes[i];
        const rect = el.getBoundingClientRect();
        if (rect.width > clientW + 2 && rect.right > clientW + 2) {
          const tag = el.tagName.toLowerCase();
          const cls =
            el.className && typeof el.className === 'string' ? el.className.split(/\s+/).slice(0, 2).join('.') : '';
          overflowing.push(`${tag}${cls ? '.' + cls : ''}`);
          if (overflowing.length >= 4) break;
        }
      }
      return {
        ok: scrollW <= clientW + 1 && overflowing.length === 0,
        scrollWidth: scrollW,
        clientWidth: clientW,
        overflowing,
      };
    });
    return {
      ok: !!result.ok,
      width,
      detail: result.ok
        ? ''
        : `scrollWidth=${result.scrollWidth} clientWidth=${result.clientWidth}` +
          (result.overflowing.length ? `; nodes=${result.overflowing.join(',')}` : ''),
    };
  } finally {
    try {
      await browser.close();
    } catch {
      /* */
    }
  }
}

/* ------------------------------------------------------------------ */
/* CSS presence / applied-class validation (shared by QA + deliver)    */
/* ------------------------------------------------------------------ */

const CSS_MIN_CHARS = 500;

function extractInlineCss(html) {
  const parts = [];
  String(html || '').replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (_, css) => {
    parts.push(css);
    return '';
  });
  return parts.join('\n');
}

/** Class tokens from markup class="..." attributes (ignores style/script bodies). */
function extractClassNames(html) {
  const names = new Set();
  const markup = String(html || '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ');
  const re = /\bclass\s*=\s*(["'])([^"']*)\1/gi;
  let m;
  while ((m = re.exec(markup))) {
    for (const c of String(m[2] || '').split(/\s+/)) {
      if (c) names.add(c);
    }
  }
  return [...names];
}

function cssDefinesClass(css, className) {
  const escRe = String(className).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // .foo as a selector token — not a prefix of .foobar
  return new RegExp(`\\.${escRe}(?![\\w-])`).test(String(css || ''));
}

/**
 * Markup that carries agent-authored class names: legacy page.html plus
 * modular section content.html (html/nav/footer freestyle fragments).
 */
function pageMarkupForCss(page) {
  const parts = [];
  if (page && typeof page.html === 'string' && page.html.trim()) {
    parts.push(page.html);
  }
  const sections = Array.isArray(page && page.sections) ? page.sections : [];
  for (const s of sections) {
    const c = s && s.content;
    if (!c || typeof c !== 'object') continue;
    if (typeof c.html === 'string' && c.html.trim()) parts.push(c.html);
  }
  return parts.join('\n');
}

/** Shared BitPype mobile-nav CSS when markup uses data-bitpype-mobile-nav. */
function mobileNavCssForMarkup(markup) {
  if (!/data-bitpype-mobile-nav\s*=/i.test(String(markup || ''))) return '';
  try {
    return fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'mobile-nav.css'), 'utf8');
  } catch {
    return '';
  }
}

/**
 * Combined CSS that applies to a freeform/modular page: inline <style> blocks,
 * shared mobile-nav asset when used, plus theme CSS from siteCss.
 */
function pageCombinedCss(page, theme) {
  const markup = pageMarkupForCss(page);
  const inline = extractInlineCss(markup);
  const mobile = mobileNavCssForMarkup(markup);
  const themeCss = siteCss(theme);
  return `${inline}\n${mobile}\n${themeCss}`.trim();
}

/**
 * Validate that class-heavy freeform / modular-html pages ship real CSS that
 * defines those classes. Stock section-only pages (no html fragments) skip.
 * Returns { ok, failures, check: { name, pass, detail } }.
 */
function validatePagesCss(pages, theme) {
  const failures = [];
  for (const page of pages || []) {
    const markup = pageMarkupForCss(page);
    if (!markup.trim()) continue;
    const classes = extractClassNames(markup);
    if (!classes.length) continue;
    const css = pageCombinedCss(page, theme);
    const slug = String((page && page.slug) || '(unknown)');
    if (!css || css.length < CSS_MIN_CHARS) {
      const sample = classes.slice(0, 8);
      failures.push({
        slug,
        undefinedClasses: sample,
        detail: `Page "${slug}": combined CSS is ${css ? css.length : 0} chars (< ${CSS_MIN_CHARS}) but markup uses class attributes (e.g. ${sample.join(', ')}).`,
      });
      continue;
    }
    const undefinedClasses = classes.filter((c) => !cssDefinesClass(css, c));
    if (undefinedClasses.length / classes.length > 0.1) {
      const sample = undefinedClasses.slice(0, 8);
      failures.push({
        slug,
        undefinedClasses: sample,
        detail: `Page "${slug}": ${undefinedClasses.length}/${classes.length} class names not defined in CSS (e.g. ${sample.join(', ')}).`,
      });
    }
  }
  const pass = failures.length === 0;
  return {
    ok: pass,
    failures,
    check: {
      name: 'css-present-and-applied',
      pass,
      detail: pass ? 'CSS present and class selectors apply.' : failures.map((f) => f.detail).join(' '),
    },
  };
}

/** Throw INVALID_CSS if pages/theme would fail css-present-and-applied. */
function assertPagesCss(pages, theme) {
  const result = validatePagesCss(pages, theme);
  if (!result.ok) {
    const e = err('INVALID_CSS', result.check.detail || 'CSS validation failed.');
    e.failures = result.failures;
    throw e;
  }
  return result;
}

function registeredImageUrlSet(db, websiteId) {
  const urls = new Set();
  if (!db || websiteId == null) return urls;
  // Unified registry: design deliverable images + on-disk site-{id}/images|assets
  // (uploadAsset, replaceImage, addImages, deliver remote localizations).
  try {
    const rows = db.prepare('SELECT deliverable FROM design_jobs WHERE website_id = ?').all(websiteId);
    for (const row of rows || []) {
      let payload = null;
      try {
        payload = JSON.parse(row.deliverable || 'null');
      } catch {
        /* ignore */
      }
      if (!payload || !Array.isArray(payload.images)) continue;
      for (const im of payload.images) {
        if (!im) continue;
        if (im.url) urls.add(String(im.url));
        if (im.name) urls.add(`images/${im.name}`);
      }
    }
  } catch {
    /* optional */
  }
  try {
    const openPreview = require('./openPreview');
    const root = openPreview.exportRoot();
    // Batch 102 (SEC-20): include the workspace-scoped staging folder.
    const stagingFolders = require('./assetValidation').siteStorageFoldersForDb(db, websiteId);
    for (const sub of ['images', 'assets']) {
      for (const staging of stagingFolders) {
        const dir = path.join(root, staging, sub);
        if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
        for (const name of fs.readdirSync(dir)) {
          const abs = path.join(dir, name);
          if (fs.statSync(abs).isFile()) urls.add(`${sub}/${name}`);
        }
      }
    }
  } catch {
    /* optional */
  }
  try {
    for (const im of imagesForWebsite(db, websiteId) || []) {
      if (im && im.url) urls.add(String(im.url));
      if (im && im.name) urls.add(`images/${im.name}`);
    }
  } catch {
    /* optional */
  }
  return urls;
}

function isRegisteredImageSrc(src, registry) {
  const s = String(src || '').trim();
  if (!s || !registry || !registry.size) return false;
  if (registry.has(s)) return true;
  const bare = s.replace(/^\.\//, '');
  if (registry.has(bare)) return true;
  for (const u of registry) {
    if (!u) continue;
    if (s.endsWith(u) || u.endsWith(bare) || bare.endsWith(u)) return true;
  }
  return false;
}

const PLACEHOLDER_IMAGE_RE =
  /(?:via\.placeholder|placehold\.it|placekitten|picsum\.photos|dummyimage|lorempixel|placeholder\.com|lorem\.flickr|placehold\.co)/i;

/** HEAD/GET probe: URL returns image/asset bytes (status 200 + content-length or body). */
async function httpUrlHasBytes(url, opts = {}) {
  // Batch 180 (L14): this raw probe used to skip urlSafety entirely.
  // Validate scheme/host the same way fetchPublic callers are
  // validated (public http(s) only, no credentials, no private or
  // local resolution) before the probe touches the network.
  try {
    await assertPublicUrl(String(url));
  } catch {
    return false;
  }
  const timeoutMs = Math.max(2000, Number(opts.timeoutMs) || 8000);
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    let u;
    try {
      u = new URL(String(url));
    } catch {
      done(false);
      return;
    }
    const lib = u.protocol === 'https:' ? require('https') : require('http');
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: 'HEAD',
        timeout: timeoutMs,
        headers: { 'User-Agent': 'website-scout-qa/1' },
      },
      (res) => {
        const code = res.statusCode || 0;
        if (code >= 200 && code < 400) {
          const len = Number(res.headers['content-length'] || 0);
          res.resume();
          if (len > 0) {
            done(true);
            return;
          }
          // Some hosts omit content-length on HEAD — fall through to GET.
        } else {
          res.resume();
        }
        const get = lib.get(url, { timeout: timeoutMs, headers: { 'User-Agent': 'website-scout-qa/1' } }, (r2) => {
          const chunks = [];
          r2.on('data', (c) => {
            chunks.push(c);
            if (Buffer.concat(chunks).length > 64) {
              r2.destroy();
              done((r2.statusCode || 0) >= 200 && (r2.statusCode || 0) < 400);
            }
          });
          r2.on('end', () =>
            done((r2.statusCode || 0) >= 200 && (r2.statusCode || 0) < 400 && Buffer.concat(chunks).length > 0)
          );
          r2.on('error', () => done(false));
        });
        get.on('error', () => done(false));
        get.on('timeout', () => {
          try {
            get.destroy();
          } catch {
            /* */
          }
          done(false);
        });
      }
    );
    req.on('error', () => done(false));
    req.on('timeout', () => {
      try {
        req.destroy();
      } catch {
        /* */
      }
      done(false);
    });
    req.end();
  });
}

/** Probe form submit endpoint (HEAD/OPTIONS) — live if 2xx/405/415 (method not allowed still means route exists). */
function httpFormSubmitLive(url) {
  const timeoutMs = 8000;
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(String(url));
    } catch {
      resolve({ ok: false, detail: 'bad url' });
      return;
    }
    const lib = u.protocol === 'https:' ? require('https') : require('http');
    const tryMethod = (method) =>
      new Promise((res) => {
        const req = lib.request(
          {
            hostname: u.hostname,
            port: u.port || (u.protocol === 'https:' ? 443 : 80),
            path: u.pathname + u.search,
            method,
            timeout: timeoutMs,
            headers: { 'User-Agent': 'website-scout-qa/1' },
          },
          (r) => {
            const code = r.statusCode || 0;
            r.resume();
            res({ ok: code > 0 && code < 500, code, method });
          }
        );
        req.on('error', () => res({ ok: false, code: 0, method }));
        req.on('timeout', () => {
          try {
            req.destroy();
          } catch {
            /* */
          }
          res({ ok: false, code: 0, method });
        });
        req.end();
      });
    Promise.resolve()
      .then(() => tryMethod('OPTIONS'))
      .then((r) => (r.ok ? r : tryMethod('HEAD')))
      .then((r) =>
        resolve(
          r.ok ? { ok: true, detail: `${r.method} → ${r.code}` } : { ok: false, detail: `submit endpoint unreachable` }
        )
      )
      .catch(() => resolve({ ok: false, detail: 'submit probe failed' }));
  });
}

function ymdAddDays(ymd, days) {
  const m = String(ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  d.setDate(d.getDate() + Number(days || 0));
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Live flow verification for website.qa:
 * - bookings widget → ≥1 published service + slots for next open day (or documented closed)
 * - forms → published token + submit endpoint responds
 */
async function runFlowsLiveCheck(db, site, pages, html) {
  const results = [];
  let pass = true;
  const blob = String(html || '');
  const hasBookingsMount =
    /data-bitpype-module-type\s*=\s*["']bookings["']/i.test(blob) ||
    (/data-bitpype-module-token\s*=/i.test(blob) && /bookings/i.test(JSON.stringify(pages || [])));

  // Bookings
  try {
    const modules = require('../server/siteModules');
    modules.ensureTables(db);
    const emb = db
      .prepare(
        "SELECT * FROM site_module_embeds WHERE lead_id = ? AND module_type = 'bookings' AND published = 1 LIMIT 1"
      )
      .get(site.lead_id);
    const mounted = hasBookingsMount || !!emb;
    if (mounted) {
      if (!emb || !emb.embed_enabled) {
        pass = false;
        results.push('bookings: widget mounted but embed not published/enabled');
      } else {
        const services = modules.listBookingServices(db, site.lead_id, { includeDrafts: false }) || [];
        if (!services.length) {
          pass = false;
          results.push('bookings: empty widget (no published services) — FAIL');
        } else {
          const svc = services[0];
          let found = null;
          let closedDays = 0;
          const today = new Date();
          const todayYmd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
          for (let i = 0; i < 21; i++) {
            const date = ymdAddDays(todayYmd, i);
            try {
              const slots = modules.listAvailableSlots(db, site.lead_id, {
                date,
                serviceId: svc.id,
              });
              if (slots.closed) {
                closedDays += 1;
                continue;
              }
              if ((slots.slots || []).length >= 1) {
                found = { date, count: slots.slots.length, service: svc.name };
                break;
              }
            } catch {
              /* try next day */
            }
          }
          if (found) {
            results.push(`bookings: ok — ${found.count} slot(s) on ${found.date} for "${found.service}"`);
          } else if (closedDays >= 7) {
            results.push(
              `bookings: ok — documented closed (no open windows in next 21 days; ${closedDays} closed day probes)`
            );
          } else {
            pass = false;
            results.push('bookings: no slots for next open day (and not documented closed)');
          }
        }
      }
    } else {
      results.push('bookings: N/A (no bookings widget)');
    }
  } catch (e) {
    pass = false;
    results.push(`bookings: error ${e.message || e}`);
  }

  // Forms
  try {
    const forms = require('../server/contactForms');
    forms.ensureTables(db);
    const tokenRe = /data-bitpype-form-embed\s*=\s*["']([^"']+)["']/gi;
    const tokens = new Set();
    let tm;
    while ((tm = tokenRe.exec(blob))) tokens.add(tm[1]);
    const nativeTok = /data-form-token\s*=\s*["']([^"']+)["']/gi;
    while ((tm = nativeTok.exec(blob))) tokens.add(tm[1]);
    if (!tokens.size) {
      results.push('forms: N/A (no form embeds)');
    } else {
      let appBase = '';
      try {
        appBase = require('../server/stripeClient').appUrl();
      } catch {
        /* */
      }
      if (!appBase) appBase = String(process.env.APP_URL || '').replace(/\/$/, '');
      for (const token of [...tokens].slice(0, 6)) {
        const row = db.prepare('SELECT * FROM contact_forms WHERE public_token = ? LIMIT 1').get(token);
        if (!row || !row.published) {
          pass = false;
          results.push(`forms: token ${token.slice(0, 8)}… not published`);
          continue;
        }
        if (!appBase) {
          results.push(`forms: token ${token.slice(0, 8)}… published (submit probe skipped — no APP_URL)`);
          continue;
        }
        const submitUrl = `${appBase}/api/v1/forms/public/${token}/submit`;
        const live = await httpFormSubmitLive(submitUrl);
        if (live.ok) {
          results.push(`forms: token ${token.slice(0, 8)}… live submit (${live.detail})`);
        } else {
          pass = false;
          results.push(`forms: token ${token.slice(0, 8)}… ${live.detail}`);
        }
      }
    }
  } catch (e) {
    pass = false;
    results.push(`forms: error ${e.message || e}`);
  }

  return {
    pass,
    detail: results.length ? results.join(' · ') : 'No interactive flows to verify.',
    results,
  };
}

/**
 * Run the QA checklist. Returns { pass, checks: [{ name, pass, detail }] }.
 * On pass: website -> approved, lead -> ready. On fail: lead stays qa_pending.
 */
async function qaSite(db, websiteId) {
  ensureTables(db);
  ai.setDb(db);
  const site = getWebsite(db, websiteId);
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(site.lead_id);

  let pages, theme;
  try {
    pages = JSON.parse(site.pages);
    theme = JSON.parse(site.theme);
  } catch (e) {
    return {
      pass: false,
      checks: [{ name: 'valid-json', pass: false, detail: 'Stored pages/theme JSON is corrupt.' }],
    };
  }

  const checks = [];
  const check = (name, pass, detail) => checks.push({ name, pass: !!pass, detail: detail || '' });
  const contentIssues = require('./siteContentQuality').inspect(pages, theme);
  check(
    'generated-content-integrity',
    contentIssues.length === 0,
    contentIssues.length
      ? contentIssues
          .map((issue) => issue.code + ':' + issue.page + issue.path)
          .join('; ')
          .slice(0, 500)
      : 'No reproduced navigation-body or punctuation defects.'
  );

  // 1. every page renders without exception
  let html = '';
  let renderOk = true;
  let renderErr = '';
  try {
    for (const p of pages) renderPage(p, pages, theme);
    html = renderSite(pages, theme);
  } catch (e) {
    renderOk = false;
    renderErr = e.message || String(e);
  }
  check(
    'renders-without-exception',
    renderOk,
    renderOk ? `${pages.length} page(s) rendered.` : `Render failed: ${renderErr}`
  );

  // 2. no UNKNOWN-class facts rendered as fact
  const { unknown } = collectFacts(db, lead || { id: site.lead_id });
  const unknownHits = [];
  if (renderOk) {
    const lower = html.toLowerCase();
    for (const u of unknown) {
      const k = String(u.fact_key || '');
      const v = String(u.value || '').trim();
      // Skip meta/role tags and tiny tokens that collide with normal copy ("hero", "logo").
      if (/\.role$/i.test(k) || v.length < 6) continue;
      if (/^(hero|logo|gallery|team|home|true|false)$/i.test(v)) continue;
      if (lower.includes(v.toLowerCase())) unknownHits.push(`${k}="${v.slice(0, 40)}"`);
    }
  }
  check(
    'no-unknown-facts',
    unknownHits.length === 0,
    unknownHits.length
      ? `UNKNOWN facts found in output: ${unknownHits.join('; ')}`
      : `${unknown.length} UNKNOWN fact(s) on record, none rendered.`
  );

  // 3. no placeholder text (visible content only — ignore script/style)
  let placeholderHit = null;
  if (renderOk) {
    const textOnly = visibleTextFromHtml(html);
    const m = textOnly.match(/lorem ipsum|TODO|FIXME|\[insert|\[your /i);
    if (m) placeholderHit = m[0];
  }
  check(
    'no-placeholder-text',
    !placeholderHit,
    placeholderHit ? `Placeholder text found: "${placeholderHit}"` : 'No lorem/TODO placeholders.'
  );

  // 4. phone matches lead phone
  if (lead && lead.phone && digitsOnly(lead.phone).length >= 7) {
    const digits = digitsOnly(lead.phone);
    const found = renderOk && html.includes(digits);
    // also accept formatted variants by comparing digit runs
    let foundLoose = found;
    if (!found && renderOk) {
      const htmlDigits = html.replace(/\D/g, '');
      foundLoose = htmlDigits.includes(digits);
    }
    check(
      'phone-matches',
      foundLoose,
      foundLoose ? `Lead phone ${lead.phone} present.` : `Lead phone ${lead.phone} NOT found in output.`
    );
  } else {
    check('phone-matches', true, 'Lead has no phone on record; nothing to verify.');
  }

  // 5. images: registered local (images/...), https stock, or CSS-only gallery.
  // Fail only on true placeholder hosts or non-https srcs not in the deliverable registry.
  let imgOk = true;
  let imgDetail = 'Gallery uses CSS gradient placeholders; no <img> tags.';
  if (renderOk) {
    const imgs = html.match(/<img\b[^>]*>/gi) || [];
    const registry = registeredImageUrlSet(db, websiteId);
    const bad = [];
    for (const tag of imgs) {
      const src = (tag.match(/\ssrc\s*=\s*["']([^"']+)["']/i) || [])[1] || '';
      if (!src) {
        bad.push('img missing src');
        continue;
      }
      if (isRegisteredImageSrc(src, registry)) continue;
      if (PLACEHOLDER_IMAGE_RE.test(src)) {
        bad.push(`placeholder image: ${src.slice(0, 80)}`);
        continue;
      }
      if (src.startsWith('https://')) {
        if (/images\.pexels\.com/i.test(src) && !/Photo by /i.test(html)) {
          bad.push('Pexels image missing credit');
        }
        continue;
      }
      bad.push(`non-https image not in registry: ${src.slice(0, 80)}`);
    }
    imgOk = bad.length === 0;
    imgDetail = imgs.length
      ? imgOk
        ? `${imgs.length} image(s) ok (registered local, https, or credited Pexels).`
        : bad.slice(0, 6).join('; ')
      : 'Gallery uses CSS gradient placeholders; no <img> tags.';
  }
  check('images-are-placeholders', imgOk, imgDetail);

  // 6. spelling sanity: no leaked 'undefined' / 'null' in visible text
  // (never scan <script>/<style> — preview nav guard used to trip every QA run)
  let sanityOk = true;
  let sanityDetail = 'Clean.';
  if (renderOk) {
    const textOnly = visibleTextFromHtml(html);
    const bad = textOnly.match(/\b(undefined|null|NaN)\b/);
    if (bad) {
      sanityOk = false;
      sanityDetail = `Suspicious token in output: "${bad[0]}"`;
    }
  }
  check('spelling-sanity', sanityOk, sanityDetail);

  // 7. unknown section types
  const known = new Set(COMPONENT_TYPES);
  const unknownTypes = new Set();
  for (const p of pages) {
    for (const s of p.sections || []) {
      if (!known.has(s.type)) unknownTypes.add(String(s.type));
    }
  }
  check(
    'known-section-types',
    true,
    unknownTypes.size ? `Generic block used for: ${[...unknownTypes].join(', ')}` : 'All section types known.'
  );

  // 8. Custom sites: no mandatory template hero. Pass when freeform, or modular with
  // any purposeful content (columns/html/heading/image/hero/cta/contact/module…).
  let reqOk = false;
  let reqDetail = '';
  if (renderOk && pages.length) {
    if (pages.some(pageHasHtml)) {
      reqOk = true;
      reqDetail = `Freeform / custom HTML site (${pages.length} page(s)).`;
    } else {
      const homeSecs = (pages[0] && pages[0].sections) || [];
      const homeTypes = new Set(homeSecs.map((s) => s && s.type).filter(Boolean));
      const hasContent =
        homeSecs.some((s) => {
          if (!s) return false;
          const t = String(s.type || '');
          if (['nav', 'footer'].includes(t)) return false;
          return true;
        }) || homeTypes.size > 2;
      const purposeful = [
        'hero',
        'columns',
        'html',
        'custom',
        'text',
        'text_image',
        'cards',
        'heading',
        'image',
        'cta',
        'contact_form',
        'bitpype_form',
        'form',
        'site_module',
        'about',
        'services',
        'benefits',
        'gallery',
        'faq',
      ].some((t) => homeTypes.has(t));
      reqOk = !!(hasContent && purposeful);
      reqDetail = reqOk
        ? `Custom modular site ok (types: ${[...homeTypes].slice(0, 8).join(', ') || '—'}).`
        : 'Home page needs at least one content/layout section (hero not required).';
    }
  }
  check('required-sections', reqOk, reqDetail || 'Render failed.');
  // Soft alias: never fail custom sites for missing template hero specifically.
  check('no-template-conformity', true, 'Template section types (hero, etc.) are optional for custom freestyle sites.');

  // 9. class-heavy freeform pages must ship real CSS that defines those classes
  if (renderOk) {
    const cssResult = validatePagesCss(pages, theme);
    check(cssResult.check.name, cssResult.check.pass, cssResult.check.detail);
  } else {
    check('css-present-and-applied', false, 'Skipped (render failed).');
  }

  // 9b. at most one functional form/embed per page; reject action "#" / empty
  if (renderOk) {
    const formProblems = [];
    for (let pi = 0; pi < pages.length; pi++) {
      let pageHtml = '';
      try {
        pageHtml = renderPage(pages[pi], pages, theme) || '';
      } catch {
        pageHtml = '';
      }
      const formTags = pageHtml.match(/<form\b[^>]*>/gi) || [];
      const embeds = pageHtml.match(/\bdata-bitpype-form-embed\s*=/gi) || [];
      const managedNative = pageHtml.match(/\bdata-bitpype-form\s*=\s*["']?1["']?/gi) || [];
      // Native contact_form with data-bitpype-form counts as the form itself (not +embed).
      const functional = formTags.length + embeds.length;
      const slug = String((pages[pi] && pages[pi].slug) || `page-${pi}`);
      if (functional > 1) {
        formProblems.push(`${slug}: ${functional} forms/embeds (max 1)`);
      }
      for (const tag of formTags) {
        const actionM = tag.match(/\baction\s*=\s*["']([^"']*)["']/i);
        const action = actionM ? String(actionM[1] || '').trim() : '';
        if (!actionM || action === '' || action === '#') {
          formProblems.push(`${slug}: form action empty or "#"`);
        }
      }
      // Embed-only mounts are OK (JS posts to public API). Flag native forms without a real action.
      void managedNative;
    }
    check(
      'single-functional-form',
      formProblems.length === 0,
      formProblems.length
        ? formProblems.slice(0, 6).join('; ')
        : 'Each page has at most one functional form/embed with a real action.'
    );
  } else {
    check('single-functional-form', false, 'Skipped (render failed).');
  }

  // 9c. module-fit: appointment-intent pages need bookings module + published service + hours
  if (renderOk) {
    try {
      const moduleFit = require('../server/moduleFit');
      const fit = moduleFit.assessModuleFit(db, site.lead_id, pages);
      check('module-fit', fit.pass, fit.detail);
    } catch (e) {
      check('module-fit', true, `module-fit skipped (${e.message || e}).`);
    }
  } else {
    check('module-fit', false, 'Skipped (render failed).');
  }

  // 9d. structured-purpose forms should not be free-text-only (warning, not hard fail)
  if (renderOk) {
    try {
      const forms = require('../server/contactForms');
      forms.ensureTables(db);
      const formRows = forms.listFormRows(db, site.lead_id) || [];
      const purposeWarnings = [];
      for (const row of formRows) {
        const kind = row.form_kind || forms.inferFormKind(row) || null;
        const purpose =
          forms.normalizePurpose(kind) ||
          (kind === 'appointment' ? 'appointment_request' : kind === 'quote' ? 'quote_request' : null);
        if (!purpose || !forms.STRUCTURED_PURPOSES.has(purpose)) continue;
        const fields = forms.listFields(db, row.id);
        if (forms.isFreeTextOnlyFields(fields)) {
          purposeWarnings.push(
            `Form #${row.id} (${purpose}) is free-text-only — use forms.create purpose=${purpose} or forms.suggestFields for typed fields`
          );
        }
      }
      check(
        'form-purpose-fields',
        true,
        purposeWarnings.length
          ? `Warning: ${purposeWarnings.slice(0, 4).join('; ')}`
          : 'Structured-purpose forms use typed fields (or none present).'
      );
    } catch (e) {
      check('form-purpose-fields', true, `form-purpose-fields skipped (${e.message || e}).`);
    }
  } else {
    check('form-purpose-fields', true, 'Skipped (render failed).');
  }

  // 9e. flows-live: bookings slots + forms submit endpoint
  if (renderOk) {
    try {
      const flow = await runFlowsLiveCheck(db, site, pages, html);
      check('flows-live', flow.pass, flow.detail);
    } catch (e) {
      check('flows-live', false, `flows-live failed: ${e.message || e}`);
    }
  } else {
    check('flows-live', false, 'Skipped (render failed).');
  }

  // 10. materialize export and require every local asset to exist on disk;
  //     when preview_url is set, also curl DEPLOYED image bytes.
  if (renderOk) {
    try {
      const openPreviewMod = require('./openPreview');
      const exportDir = path.join(openPreviewMod.exportRoot(), `qa-site-${websiteId}`);
      const images = imagesForWebsite(db, websiteId);
      const qaSeo = buildSeoExportContext(db, websiteId);
      writeStaticPages(pages, theme, exportDir, {
        images,
        websiteId,
        seo: qaSeo,
        siteUpdatedAt: qaSeo.siteUpdatedAt,
      });
      const assetCheck = validateExportAssets(pages, theme, exportDir);
      const miss = assetCheck.missing || [];
      let deployDetail = '';
      let deployOk = true;
      const previewBase = String(site.preview_url || '').replace(/\/+$/, '');
      if (previewBase && /^https?:\/\//i.test(previewBase) && assetCheck.checked > 0) {
        const deployMiss = [];
        const refs = collectLocalAssetRefs(html).filter((r) => /^(?:images|assets)\//i.test(r));
        for (const rel of refs.slice(0, 24)) {
          const okBytes = await httpUrlHasBytes(`${previewBase}/${rel}`);
          if (!okBytes) deployMiss.push(rel);
        }
        deployOk = deployMiss.length === 0;
        deployDetail = deployOk
          ? ` Deployed URL ok (${Math.min(refs.length, 24)} image/asset curl(s)).`
          : ` Deployed missing: ${deployMiss.slice(0, 6).join(', ')}${deployMiss.length > 6 ? '…' : ''}`;
      }
      check(
        'assets-present-in-export',
        assetCheck.ok && deployOk,
        assetCheck.ok
          ? `${assetCheck.checked} local asset(s) present in export.${deployDetail}`
          : `Missing from export (${miss.length}): ${miss.slice(0, 8).join(', ')}${miss.length > 8 ? '…' : ''}${deployDetail}`
      );
      const navCheck = validateExportNavLinks(pages, exportDir);
      const navMiss = [...(navCheck.danglingHashes || []), ...(navCheck.missing || [])];
      check(
        'multipage-nav-export',
        navCheck.ok,
        navCheck.ok
          ? pages.length < 2
            ? 'Single-page site; multipage nav check skipped.'
            : `Multipage nav ok (${navCheck.checked} cross-page link(s) resolve).`
          : `Broken multipage nav (${navMiss.length}): ${navMiss.slice(0, 8).join(', ')}${navMiss.length > 8 ? '…' : ''}`
      );

      // Duplicate nav labels (case-insensitive) across rendered home nav.
      const labelDupes = [];
      try {
        const homeHtml = renderPage(pages[0], pages, theme) || '';
        const labels = [];
        const re = /<nav\b[^>]*>[\s\S]*?<\/nav>/gi;
        let nm;
        while ((nm = re.exec(homeHtml))) {
          const aRe = /<a\b[^>]*>([\s\S]*?)<\/a>/gi;
          let am;
          while ((am = aRe.exec(nm[0]))) {
            const lab = String(am[1] || '')
              .replace(/<[^>]+>/g, '')
              .trim()
              .toLowerCase();
            if (lab) labels.push(lab);
          }
        }
        const seen = new Set();
        for (const lab of labels) {
          if (seen.has(lab)) labelDupes.push(lab);
          seen.add(lab);
        }
      } catch {
        /* optional */
      }
      check(
        'nav-labels-unique',
        labelDupes.length === 0,
        labelDupes.length
          ? `Duplicate nav labels: ${[...new Set(labelDupes)].slice(0, 6).join(', ')}`
          : 'Nav labels unique.'
      );

      // Declared crop aspects: if image.crop.aspect is set, width/height should match.
      const cropProblems = [];
      const walkCrop = (node) => {
        if (!node || typeof node !== 'object') return;
        if (node.crop && typeof node.crop === 'object' && node.crop.aspect != null) {
          try {
            const imageCrop = require('./imageCrop');
            const ar = imageCrop.parseAspect(node.crop.aspect);
            const w = Number(node.crop.width);
            const h = Number(node.crop.height);
            if (ar && Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
              const got = w / h;
              if (Math.abs(got - ar) / ar > 0.05) {
                cropProblems.push(`crop ${w}x${h} ≠ aspect ${node.crop.aspect}`);
              }
            }
          } catch {
            /* skip */
          }
        }
        if (Array.isArray(node)) node.forEach(walkCrop);
        else Object.values(node).forEach(walkCrop);
      };
      walkCrop(pages);
      check(
        'images-crop-aspect',
        cropProblems.length === 0,
        cropProblems.length
          ? cropProblems.slice(0, 4).join('; ')
          : 'Cropped images match declared aspect (or no crop metadata).'
      );

      // 10b. SEO foundations (Batch 31 — REQUIRED): the export must ship
      // sitemap.xml / robots.txt / 404.html, the home page must carry the
      // auto LocalBusiness schema + a canonical, and no internal link may
      // resolve to the home-page fallback. Thin pages / missing meta
      // description / missing og:image are warnings (check passes, the
      // detail names the page + defect).
      try {
        const seoFails = [];
        const seoWarns = [];
        for (const artifact of ['sitemap.xml', 'robots.txt', '404.html', 'terms.html', 'privacy.html']) {
          if (!fs.existsSync(path.join(exportDir, artifact))) seoFails.push(`export: missing ${artifact}`);
        }
        const homeFile = path.join(exportDir, 'index.html');
        const homeHtml = fs.existsSync(homeFile) ? fs.readFileSync(homeFile, 'utf8') : '';
        const homeTypes = seoSchema.ldJsonTypesIn(homeHtml);
        if (!seoSchema.hasLocalBusinessType(homeTypes)) {
          seoFails.push('index.html (home): missing LocalBusiness schema');
        }
        const homePageObj = homePage(pages);
        for (const p of pages) {
          const isHomeP = p === homePageObj || isHomePage(p, pages);
          const file = isHomeP ? 'index.html' : pageFileName(p.slug);
          const abs = path.join(exportDir, file);
          if (!fs.existsSync(abs)) continue;
          const pageHtml = fs.readFileSync(abs, 'utf8');
          const label = `${file} (${String(p.slug || '/')})`;
          if (!/<link\b[^>]*rel\s*=\s*["']canonical["']/i.test(pageHtml)) {
            seoFails.push(`${label}: missing canonical`);
          }
          // Home-fallback detection: a link whose target page exists but
          // whose href serves the home document instead of its own file.
          const hrefs = [...pageHtml.matchAll(/\bhref\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
          for (const href of hrefs) {
            const targetPage = pageForHref(href, pages);
            if (!targetPage || targetPage === homePageObj || isHomePage(targetPage, pages)) continue;
            const targetFile = pageFileName(targetPage.slug);
            const spellings = new Set([
              pageUrlPath(targetPage.slug).slice(1),
              targetFile,
              legacyPageFileName(targetPage.slug),
              legacyPageFileName(targetPage.slug).replace(/\.html$/i, ''),
            ]);
            const bare = href.split('#')[0].split('?')[0].replace(/^\.\//, '').replace(/^\//, '');
            if (spellings.has(bare) && bare !== pageUrlPath(targetPage.slug).slice(1) && bare !== targetFile) {
              seoFails.push(`${label}: link "${href}" uses a non-canonical form (home-fallback risk)`);
            }
          }
          const meta = pageMetaFields(p);
          if (!meta.description) seoWarns.push(`${label}: missing meta description`);
          if (!/<meta\b[^>]*property\s*=\s*["']og:image["']/i.test(pageHtml)) {
            seoWarns.push(`${label}: missing og:image`);
          }
          if (!meta.noindex) {
            const words = visibleTextFromHtml(pageHtml).split(/\s+/).filter(Boolean).length;
            if (words < 600) seoWarns.push(`${label}: thin page (~${words} visible words, target 1000+)`);
          }
        }
        // Batch 32 (C6): a site with published blog posts must ship
        // static post pages + a server-rendered blog index. An export
        // that still relies on the ?bpItem= client pattern FAILS.
        try {
          let publishedSlugs = [];
          try {
            publishedSlugs = db
              .prepare("SELECT slug FROM blog_posts WHERE lead_id = ? AND status = 'published'")
              .all(site.lead_id)
              .map((r) => String(r.slug || ''))
              .filter(Boolean);
          } catch {
            publishedSlugs = [];
          }
          if (publishedSlugs.length) {
            const blogCtxQa = qaSeo && qaSeo.blog ? qaSeo.blog : null;
            if (!blogCtxQa) {
              seoFails.push(
                'blog: published posts exist but no static blog was threaded into the export (missing blog page/mount, or the blog page is member-gated)'
              );
            } else {
              const anchorObj = pages.find(
                (p) => p && canonicalSlugPath(p.slug) === String(blogCtxQa.pagePath || '')
              );
              const anchorFile = anchorObj
                ? anchorObj === homePageObj || isHomePage(anchorObj, pages)
                  ? 'index.html'
                  : pageFileName(anchorObj.slug)
                : '';
              const anchorHtml =
                anchorFile && fs.existsSync(path.join(exportDir, anchorFile))
                  ? fs.readFileSync(path.join(exportDir, anchorFile), 'utf8')
                  : '';
              if (!anchorHtml || !anchorHtml.includes('data-bitpype-static-blog')) {
                seoFails.push('blog: index page lacks the server-rendered static blog snapshot');
              } else if (/bpItem=/.test(anchorHtml)) {
                seoFails.push('blog: index still links the ?bpItem= client-side pattern');
              }
              for (const slug of publishedSlugs) {
                const postFile = pageFileName(`${blogCtxQa.pagePath}/${slug}`);
                if (!fs.existsSync(path.join(exportDir, postFile))) {
                  seoFails.push(`blog: missing static post page ${postFile}`);
                }
              }
            }
          }
        } catch (e) {
          seoFails.push(`blog: static blog check errored (${e.message || e})`);
        }
        check(
          'seo-foundations',
          seoFails.length === 0,
          seoFails.length
            ? seoFails.slice(0, 8).join('; ')
            : `SEO foundations present (LocalBusiness schema, canonical, sitemap.xml, robots.txt, 404.html).${seoWarns.length ? ` Warnings: ${seoWarns.slice(0, 6).join('; ')}` : ''}`
        );
        check(
          'seo-content-warnings',
          true,
          seoWarns.length ? seoWarns.slice(0, 8).join('; ') : 'No SEO content warnings.'
        );
      } catch (e) {
        check('seo-foundations', false, `SEO check failed: ${e.message || e}`);
        check('seo-content-warnings', true, 'SEO warnings skipped (check error).');
      }
    } catch (e) {
      check('assets-present-in-export', false, `Export asset check failed: ${e.message || e}`);
      check('multipage-nav-export', false, `Export nav check failed: ${e.message || e}`);
      check('nav-labels-unique', false, `Nav label check failed: ${e.message || e}`);
      check('images-crop-aspect', false, `Crop check failed: ${e.message || e}`);
      check('seo-foundations', false, `SEO check failed: ${e.message || e}`);
      check('seo-content-warnings', true, 'SEO warnings skipped (export failed).');
    }
  } else {
    check('assets-present-in-export', false, 'Skipped (render failed).');
    check('multipage-nav-export', false, 'Skipped (render failed).');
    check('nav-labels-unique', false, 'Skipped (render failed).');
    check('images-crop-aspect', false, 'Skipped (render failed).');
    check('seo-foundations', false, 'Skipped (render failed).');
    check('seo-content-warnings', true, 'Skipped (render failed).');
  }

  // Horizontal overflow at 390px (headless) — best-effort when puppeteer available.
  if (renderOk) {
    try {
      const overflow = await checkMobileOverflow(pages, theme, { width: 390 });
      check(
        'no-horizontal-overflow-390',
        overflow.ok,
        overflow.ok
          ? `No horizontal overflow at ${overflow.width}px.`
          : `Horizontal overflow at ${overflow.width}px: ${overflow.detail || 'scrollWidth > clientWidth'}`
      );
    } catch (e) {
      check('no-horizontal-overflow-390', true, `Overflow check skipped (${e.message || e}).`);
    }
  } else {
    check('no-horizontal-overflow-390', false, 'Skipped (render failed).');
  }

  // Batch 135: spacing geometry at 390/980/1440 (headless) — measured
  // text-edge / card-text / card-gap / overflow against the platform
  // floors (public/css/tokens.css). Best-effort like the overflow
  // check: a missing browser skips, a measured violation FAILS with
  // the exact px + selector so the design agent can fix and re-run.
  if (renderOk) {
    try {
      const spacingQa = require('../server/spacingQa');
      const sp = await spacingQa.assessSpacing(pages, theme, { renderPage });
      check(
        'spacing',
        sp.pass,
        sp.pass
          ? `Spacing floors hold at 390/980/1440 across ${pages.length} page(s).`
          : `Spacing violations: ${sp.detail}`
      );
    } catch (e) {
      check('spacing', true, `Spacing check skipped (${e.message || e}).`);
    }
  } else {
    check('spacing', false, 'Skipped (render failed).');
  }

  // 11. optional AI QA pass
  if (ai.aiConfigured(db) && renderOk) {
    try {
      const promptRow = db.prepare('SELECT body FROM prompts WHERE key = ?').get('qa_website');
      const systemPrompt =
        (promptRow && promptRow.body ? String(promptRow.body).trim() : '') || QA_BUILD_PROMPT_FALLBACK;
      const facts = collectFacts(db, lead || { id: site.lead_id });
      const factList = [...facts.ok.entries()].map(([k, f]) => `${k} = ${f.value} [${f.claim_class}]`).join('\n');
      const { text } = await ai.chat({
        task: 'qa',
        db,
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: `Allowed facts (only these may appear as facts):\n${factList || '(none)'}\n\nSite HTML to review:\n${html.slice(0, 12000)}`,
          },
        ],
        maxTokens: 800,
        leadId: site.lead_id,
        note: `QA website #${websiteId}`,
      });
      let verdict = null;
      try {
        verdict = JSON.parse(stripCodeFences(text));
      } catch (e) {
        /* unparseable */
      }
      if (verdict && typeof verdict.pass === 'boolean') {
        check('ai-qa', verdict.pass, (verdict.issues || []).join('; ').slice(0, 500) || 'AI QA verdict recorded.');
      } else {
        check('ai-qa', true, 'AI QA returned an unparseable verdict; skipped.');
      }
    } catch (e) {
      check('ai-qa', true, `AI QA skipped (${e.code || e.message}).`);
    }
  } else {
    check('ai-qa', true, ai.aiConfigured(db) ? 'Skipped (render failed).' : 'Skipped (AI not configured).');
  }

  const pass = checks.every((c) => c.pass);
  if (pass) {
    db.prepare("UPDATE websites SET status = 'approved', updated_at = datetime('now') WHERE id = ?").run(websiteId);
    if (lead) setLeadStatus(db, lead.id, 'ready');
    logActivity(db, 'websites', `Website #${websiteId} passed QA — marked ready.`);
  } else {
    const failed = checks
      .filter((c) => !c.pass)
      .map((c) => c.name)
      .join(', ');
    logActivity(db, 'websites', `Website #${websiteId} FAILED QA: ${failed}.`);
  }
  return { pass, checks };
}

/* ------------------------------------------------------------------ */
/* export                                                              */
/* ------------------------------------------------------------------ */

/** True for site-1, ws-1-site-1, ws-1-site-1-<slug> (not site-10 when id=1). */
function folderMatchesSiteId(name, websiteId) {
  const id = String(websiteId);
  if (!name || !id) return false;
  if (name === `site-${id}`) return true;
  const m = String(name).match(/(?:^|-)site-(\d+)(?:-|$)/);
  return !!(m && m[1] === id);
}

/** Export folders / design image dirs that may hold assets for a website id. */
function siteImageSearchDirs(websiteId, exportRootFn, subfolder = 'images') {
  const dirs = [];
  if (!exportRootFn || websiteId == null) return dirs;
  const sub = String(subfolder || 'images').replace(/[^a-z0-9_-]/gi, '') || 'images';
  let root;
  try {
    root = exportRootFn();
  } catch {
    return dirs;
  }
  try {
    for (const name of fs.readdirSync(root)) {
      if (!folderMatchesSiteId(name, websiteId)) continue;
      const dir = path.join(root, name, sub);
      if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) dirs.push(dir);
    }
  } catch {
    /* optional */
  }
  return dirs;
}

function resolveImageOnDisk(name, searchDirs) {
  const base = path.basename(String(name || ''));
  if (!base || base === '.' || base === '..') return null;
  for (const dir of searchDirs || []) {
    try {
      const abs = path.join(dir, base);
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs;
    } catch {
      /* skip */
    }
  }
  return null;
}

/**
 * Collect deliverable.images[] for every design job linked to a website.
 * Resolves missing/stale paths via design-{jobId}/images/<name> and sibling
 * export folders (ws-*-site-{id}*) when present — critical after export_slug
 * rematerialize creates a fresh folder that would otherwise only get logo.png.
 */
function imagesForWebsite(db, websiteId) {
  const images = [];
  if (!db || websiteId == null) return images;
  let exportRootFn = null;
  try {
    exportRootFn = () => require('./openPreview').exportRoot();
  } catch {
    /* optional */
  }
  const searchDirs = siteImageSearchDirs(websiteId, exportRootFn);
  try {
    const jobRows = db.prepare('SELECT id FROM design_jobs WHERE website_id = ?').all(websiteId);
    for (const row of jobRows || []) {
      if (!exportRootFn) break;
      const imgDir = path.join(exportRootFn(), `design-${row.id}`, 'images');
      if (fs.existsSync(imgDir) && fs.statSync(imgDir).isDirectory()) searchDirs.push(imgDir);
    }
  } catch {
    /* optional */
  }

  const seenNames = new Set();
  const pushImage = (entry) => {
    if (!entry || typeof entry !== 'object') return;
    let name = typeof entry.name === 'string' ? path.basename(entry.name) : '';
    if (!name && typeof entry.url === 'string') {
      const bare = String(entry.url).replace(/\\/g, '/').replace(/^\.\//, '');
      const m = bare.match(/(?:^|\/)([^/]+\.(?:png|jpe?g|webp|gif|svg|ico))$/i);
      if (m) name = m[1];
    }
    if (!name && typeof entry.path === 'string') name = path.basename(entry.path);
    if (!name || seenNames.has(name)) return;
    const copy = Object.assign({}, entry, { name });
    if (!copy.url) copy.url = `images/${name}`;
    const pathOk =
      typeof copy.path === 'string' && copy.path && fs.existsSync(copy.path) && fs.statSync(copy.path).isFile();
    if (!pathOk) {
      const recovered = resolveImageOnDisk(name, searchDirs);
      if (!recovered) return;
      copy.path = recovered;
      if (!copy.source) copy.source = 'recovered';
    }
    seenNames.add(name);
    images.push(copy);
  };

  // Prefer an already-materialized theme logo so rematerialize keeps images/logo.png.
  try {
    const site = db.prepare('SELECT theme FROM websites WHERE id = ?').get(websiteId);
    const theme = site ? (typeof site.theme === 'string' ? JSON.parse(site.theme || '{}') : site.theme) : null;
    const logoUrl = theme && typeof theme.logoUrl === 'string' ? theme.logoUrl.trim() : '';
    if (theme && theme.logoMode === 'image' && /^images\/logo\.png$/i.test(logoUrl)) {
      pushImage({ name: 'logo.png', url: 'images/logo.png', role: 'logo', source: 'theme' });
    }
  } catch {
    /* optional */
  }
  try {
    const rows = db.prepare('SELECT id, deliverable FROM design_jobs WHERE website_id = ?').all(websiteId);
    for (const row of rows || []) {
      let payload = null;
      try {
        payload = JSON.parse(row.deliverable || 'null');
      } catch {
        /* ignore */
      }
      if (!payload || !Array.isArray(payload.images)) continue;
      for (const im of payload.images) pushImage(im);
    }
  } catch {
    /* optional */
  }

  // Harvest any images/… referenced in page HTML that deliverable.images missed.
  try {
    const site = db.prepare('SELECT pages, theme FROM websites WHERE id = ?').get(websiteId);
    if (site) {
      const pages = typeof site.pages === 'string' ? JSON.parse(site.pages || '[]') : site.pages;
      const theme = typeof site.theme === 'string' ? JSON.parse(site.theme || '{}') : site.theme;
      const html = renderSite(pages || [], theme || {});
      for (const rel of collectLocalAssetRefs(html)) {
        if (!/^images\//i.test(rel)) continue;
        pushImage({ name: path.basename(rel), url: rel, source: 'html-ref' });
      }
    }
  } catch {
    /* optional */
  }

  return images;
}

/**
 * After export: copy any still-missing local assets from sibling site folders.
 * Returns list of recovered relative paths.
 */
function recoverMissingExportAssets(pages, theme, outDir, opts = {}) {
  const recovered = [];
  if (typeof outDir !== 'string' || !outDir.trim()) return recovered;
  let refs = [];
  try {
    refs = collectLocalAssetRefs(renderSite(pages, theme));
  } catch {
    return recovered;
  }
  const websiteId = opts && opts.websiteId != null ? opts.websiteId : null;
  let exportRootFn = null;
  try {
    exportRootFn = () => require('./openPreview').exportRoot();
  } catch {
    /* optional */
  }
  const imageDirs = siteImageSearchDirs(websiteId, exportRootFn, 'images');
  const assetDirs = siteImageSearchDirs(websiteId, exportRootFn, 'assets');
  if (opts && Array.isArray(opts.searchDirs)) {
    for (const d of opts.searchDirs) {
      if (d && !imageDirs.includes(d)) imageDirs.push(d);
    }
  }
  const outImg = path.join(outDir, 'images');
  const outAssets = path.join(outDir, 'assets');
  const imgSearch = imageDirs.filter((d) => path.resolve(d) !== path.resolve(outImg));
  const assetSearch = assetDirs.filter((d) => path.resolve(d) !== path.resolve(outAssets));

  for (const rel of refs) {
    const dest = path.join(outDir, rel);
    try {
      if (fs.existsSync(dest) && fs.statSync(dest).isFile()) continue;
    } catch {
      /* try recover */
    }
    const underAssets = /^assets\//i.test(rel);
    const abs = resolveImageOnDisk(path.basename(rel), underAssets ? assetSearch : imgSearch);
    if (!abs) continue;
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(abs, dest);
      recovered.push(rel);
    } catch {
      /* skip */
    }
  }
  return recovered;
}

/**
 * Copy deliverable.images[].path into outDir/images/<filename>.
 * Preserves registered relative URLs (images/foo.png). Re-copies every call.
 */
function copyDeliverableImages(images, outDir) {
  const written = [];
  if (!Array.isArray(images) || !images.length) return written;
  if (typeof outDir !== 'string' || !outDir.trim()) return written;
  const imgDir = path.join(outDir, 'images');
  fs.mkdirSync(imgDir, { recursive: true });
  for (const im of images) {
    if (!im || typeof im !== 'object') continue;
    let srcPath = typeof im.path === 'string' ? im.path.trim() : '';
    let name = typeof im.name === 'string' ? im.name.trim() : '';
    if (!name && typeof im.url === 'string') {
      const bare = String(im.url).replace(/\\/g, '/').replace(/^\.\//, '');
      const m = bare.match(/(?:^|\/)([^/]+\.(?:png|jpe?g|webp|gif|svg|ico))$/i);
      if (m) name = m[1];
    }
    if (!name && srcPath) name = path.basename(srcPath);
    if (!name) continue;
    name = path.basename(name);
    if (!name || name === '.' || name === '..') continue;
    try {
      if (!srcPath || !fs.existsSync(srcPath) || !fs.statSync(srcPath).isFile()) continue;
      const dest = path.join(imgDir, name);
      fs.copyFileSync(srcPath, dest);
      written.push(`images/${name}`);
    } catch {
      /* skip unreadable */
    }
  }
  return written;
}

/** Local (non-https) asset paths referenced by rendered HTML / CSS. */
function collectLocalAssetRefs(html) {
  const refs = new Set();
  const text = String(html || '');
  const consider = (raw) => {
    let u = String(raw || '').trim();
    if (!u) return;
    if (/^(https?:|data:|mailto:|tel:|javascript:|#)/i.test(u)) return;
    u = u.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
    if (!u || u.includes('..')) return;
    if (
      /^(?:images|assets)\//i.test(u) ||
      /\.(png|jpe?g|gif|webp|svg|ico|woff2?|ttf|otf|css|js|mp4|webm|pdf)$/i.test(u)
    ) {
      refs.add(u);
    }
  };
  const attrRe = /\b(?:src|href)=["']([^"']+)["']/gi;
  let m;
  while ((m = attrRe.exec(text))) consider(m[1]);
  const cssRe = /url\(\s*["']?([^"')]+)["']?\s*\)/gi;
  while ((m = cssRe.exec(text))) consider(m[1]);
  return [...refs];
}

/**
 * After materialize: every local asset referenced by pages must exist under outDir.
 * Returns { ok, missing, checked }.
 */
function validateExportAssets(pages, theme, outDir) {
  let html = '';
  try {
    html = renderSite(pages, theme);
  } catch (e) {
    return { ok: false, missing: [], checked: 0, error: e.message || String(e) };
  }
  const refs = collectLocalAssetRefs(html);
  const missing = [];
  for (const rel of refs) {
    const abs = path.join(outDir, rel);
    try {
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) missing.push(rel);
    } catch {
      missing.push(rel);
    }
  }
  return { ok: missing.length === 0, missing, checked: refs.length };
}

/**
 * Write a real multi-page static site: one HTML file per page.
 * Home (slug `/` or first page) becomes index.html; others use pageFileName.
 * When opts.images is set, copies deliverable images into images/.
 */
function writeStaticPages(pages, theme, outDir, opts) {
  if (!Array.isArray(pages) || !pages.length) throw err('INVALID_PAGES', 'pages must be a non-empty array.');
  fs.mkdirSync(outDir, { recursive: true });
  const home = homePage(pages);
  const written = [];
  // Batch 60: generated site-level legal pages (Terms + Privacy) join the
  // export here. Export-time only — never written back to websites.pages;
  // an owner-authored page at the same canonical slug always wins (see
  // src/siteLegal.js). The QA foundations check fails exports whose
  // terms.html / privacy.html are missing, so a generation failure is
  // caught rather than silently shipped.
  try {
    const seoForLegal = seoContextFromOpts(opts || {});
    const legalCtx = siteLegal.legalContextFromSeo(seoForLegal, pages);
    pages = siteLegal.withLegalPages(pages, legalCtx, { canon: canonicalSlugPath });
  } catch { /* QA foundations fails the export if the pages are missing */ }
  // Batch 32 (C6): static blog context (published posts + mounts),
  // threaded via opts.seo.blog by buildSeoExportContext.
  const seoForBlog = seoContextFromOpts(opts || {});
  const baseUrlForBlog = seoForBlog ? String(seoForBlog.baseUrl || '').trim().replace(/\/+$/, '') : '';
  const blogCtx =
    seoForBlog && seoForBlog.blog && Array.isArray(seoForBlog.blog.posts) && seoForBlog.blog.posts.length
      ? seoForBlog.blog
      : null;
  for (const p of pages) {
    const file = p === home || isHomePage(p, pages) ? 'index.html' : pageFileName(p.slug);
    let pageHtml = renderPage(p, pages, theme, opts);
    // Batch 31 (C1): every internal link in the exported HTML uses the
    // ONE canonical URL form — legacy underscore filenames, exported
    // filenames and bare slugs are all normalized here, so no exported
    // link can fall back to the home page.
    pageHtml = normalizeInternalLinksToCanonical(pageHtml, pages);
    // Batch 60: every exported page links the site's legal pages
    // (idempotent; skipped when the page already links both).
    pageHtml = siteLegal.injectLegalLinks(pageHtml, { urlFor: pageUrlPath });
    // Batch 32 (C6): server-render the blog card snapshot into any blog
    // mount on this page (real post URLs in the raw HTML).
    if (blogCtx) pageHtml = injectStaticBlogSnapshot(pageHtml, blogCtx, baseUrlForBlog);
    // Batch 133: exported pages are detail-enabled (see injectDetailMeta).
    pageHtml = injectDetailMeta(pageHtml);
    // Final guard: sanitize/render must leave managed embed loaders intact.
    pageHtml = ensureManagedEmbedScripts(pageHtml);
    const embedAssert = assertManagedEmbedScripts(pageHtml, `export ${file}`);
    if (!embedAssert.ok) {
      throw err(
        'EMBED_SCRIPT_MISSING',
        `Publish/export refused: ${file} missing managed embed scripts: ${embedAssert.missing.join(', ')}`
      );
    }
    const target = path.join(outDir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, pageHtml, 'utf8');
    written.push(file);
  }
  // Batch 32 (C6): one static page per published blog post, rendered
  // through the same pipeline (site chrome, canonical, og article,
  // BlogPosting JSON-LD). An authored page at the same canonical path
  // always wins — the post page is skipped, never overwritten.
  const blogSitemapUrls = [];
  if (blogCtx) {
    try {
      const anchorPage =
        pages.find((p) => p && canonicalSlugPath(p.slug) === String(blogCtx.pagePath || '')) || null;
      const takenPaths = new Set(pages.map((p) => canonicalSlugPath(p && p.slug)));
      for (const rawPost of blogCtx.posts) {
        const post = normalizeBlogPost(rawPost);
        if (!post) continue;
        const postPage = buildBlogPostPage(blogCtx, post, anchorPage, baseUrlForBlog);
        const postKey = canonicalSlugPath(postPage.slug);
        if (takenPaths.has(postKey)) continue;
        let postHtml = renderPage(postPage, pages, theme, opts);
        postHtml = normalizeInternalLinksToCanonical(postHtml, pages);
        postHtml = ensureManagedEmbedScripts(postHtml);
        const postAssert = assertManagedEmbedScripts(postHtml, `export blog ${post.slug}`);
        if (!postAssert.ok) {
          throw err(
            'EMBED_SCRIPT_MISSING',
            `Publish/export refused: blog post ${post.slug} missing managed embed scripts: ${postAssert.missing.join(', ')}`
          );
        }
        const postFile = pageFileName(postPage.slug);
        const postTarget = path.join(outDir, postFile);
        fs.mkdirSync(path.dirname(postTarget), { recursive: true });
        fs.writeFileSync(postTarget, postHtml, 'utf8');
        if (!written.includes(postFile)) written.push(postFile);
        blogSitemapUrls.push({
          path: blogPostPath(blogCtx, post),
          lastmod: post.updatedAt || post.publishedAt || '',
        });
      }
    } catch (e) {
      if (e && e.code === 'EMBED_SCRIPT_MISSING') throw e;
      console.warn('[websiteEngine] static blog pages emit:', e.message || e);
    }
  }
  // Batch 31 (C2/C3/C1): every export ships a themed 404.html (served
  // with a TRUE 404 status by Cloudflare Pages and the app preview
  // mounts), robots.txt, sitemap.xml with honest per-page lastmod, and
  // a _redirects map from legacy underscore URLs to canonical ones.
  const seo = seoContextFromOpts(opts || {});
  const baseUrl = seo ? String(seo.baseUrl || '').trim().replace(/\/+$/, '') : '';
  try {
    fs.writeFileSync(path.join(outDir, '404.html'), build404Page(pages, theme, opts || {}), 'utf8');
    if (!written.includes('404.html')) written.push('404.html');
  } catch (e) {
    console.warn('[websiteEngine] 404.html emit:', e.message || e);
  }
  try {
    fs.writeFileSync(path.join(outDir, 'robots.txt'), buildRobotsTxt({ baseUrl }), 'utf8');
    if (!written.includes('robots.txt')) written.push('robots.txt');
  } catch (e) {
    console.warn('[websiteEngine] robots.txt emit:', e.message || e);
  }
  // Batch 133: every export ships the universal detail page shell,
  // plus one real shell file per published item at
  // detail/<type>/<key>.html (Batch 133 finisher: the /detail/*
  // rewrite in _redirects does not fire on the platform's Pages
  // deployments — three target variants were silently ignored on
  // live previews — while real files serve at their extensionless
  // URLs on every static host; the shell still resolves the item
  // live through the public API, so content is never snapshotted).
  try {
    const shellHtml = buildDetailPage(pages, theme, opts || {});
    fs.writeFileSync(path.join(outDir, 'item.html'), shellHtml, 'utf8');
    if (!written.includes('item.html')) written.push('item.html');
    const detailTypes = (seo && seo.detail && seo.detail.types) || {};
    // Batch 141: per-item primary photos resolved at export by
    // detailExportContext ({ [type]: { [key]: url } }) — each item's
    // own shell bakes its photo as the detail root's initial hero.
    const detailPhotos = (seo && seo.detail && seo.detail.photos) || {};
    for (const dtype of Object.keys(detailTypes)) {
      const keys = (detailTypes[dtype] && detailTypes[dtype].items) || [];
      for (const key of keys) {
        // Batch 143 (full review): type/key become FILE PATH
        // segments below. detailExportContext filters its own keys,
        // but this exporter must not trust that — a key carrying a
        // separator or dot-dot would write outside the detail tree
        // (or outside the export). Skip + log anything that is not
        // a single safe segment.
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(String(dtype)) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(String(key))) {
          console.warn('[websiteEngine] detail shell skipped — unsafe type/key segment:', dtype, key);
          continue;
        }
        const rel = `detail/${dtype}/${key}.html`;
        const abs = path.join(outDir, 'detail', dtype, `${key}.html`);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        const photo = detailPhotos[dtype] && detailPhotos[dtype][key];
        const itemHtml = photo
          ? buildDetailPage(pages, theme, Object.assign({}, opts || {}, { detailItemImage: String(photo) }))
          : shellHtml;
        fs.writeFileSync(abs, itemHtml, 'utf8');
        if (!written.includes(rel)) written.push(rel);
      }
    }
  } catch (e) {
    console.warn('[websiteEngine] item.html emit:', e.message || e);
  }
  try {
    fs.writeFileSync(
      path.join(outDir, 'sitemap.xml'),
      buildSitemapXml(pages, {
        baseUrl,
        siteUpdatedAt: (opts && opts.siteUpdatedAt) || '',
        extraUrls: blogSitemapUrls,
      }),
      'utf8'
    );
    if (!written.includes('sitemap.xml')) written.push('sitemap.xml');
  } catch (e) {
    console.warn('[websiteEngine] sitemap.xml emit:', e.message || e);
  }
  try {
    const redirects = buildRedirects(pages);
    if (redirects) {
      fs.writeFileSync(path.join(outDir, '_redirects'), redirects, 'utf8');
      if (!written.includes('_redirects')) written.push('_redirects');
    }
  } catch (e) {
    console.warn('[websiteEngine] _redirects emit:', e.message || e);
  }
  const images = opts && Array.isArray(opts.images) ? opts.images : [];
  const assetFiles = copyDeliverableImages(images, outDir);
  for (const f of assetFiles) {
    if (!written.includes(f)) written.push(f);
  }
  // Copy stable website.uploadAsset files (assets/<filename> — never renamed).
  // Batch 102 (SEC-20): read the workspace-scoped staging folder too
  // (legacy first, scoped wins a clash) when the caller knows the ws.
  if (opts && opts.websiteId != null) {
    try {
      const openPreview = require('./openPreview');
      const assetFolders =
        opts.workspaceId != null
          ? require('./assetValidation').siteStorageFolders(opts.workspaceId, opts.websiteId).reverse()
          : [`site-${opts.websiteId}`];
      const destAssets = path.join(outDir, 'assets');
      for (const folder of assetFolders) {
        const srcAssets = path.join(openPreview.exportRoot(), folder, 'assets');
        if (fs.existsSync(srcAssets) && fs.statSync(srcAssets).isDirectory()) {
          fs.mkdirSync(destAssets, { recursive: true });
          for (const name of fs.readdirSync(srcAssets)) {
            const from = path.join(srcAssets, name);
            const to = path.join(destAssets, name);
            if (fs.statSync(from).isFile()) {
              fs.copyFileSync(from, to);
              const rel = `assets/${name}`;
              if (!written.includes(rel)) written.push(rel);
            }
          }
        }
      }
    } catch {
      /* optional */
    }
  }
  // List any images/ already on disk (e.g. prior stage) so preview file lists include them.
  try {
    const imgDir = path.join(outDir, 'images');
    if (fs.existsSync(imgDir)) {
      for (const name of fs.readdirSync(imgDir)) {
        const abs = path.join(imgDir, name);
        if (fs.statSync(abs).isFile()) {
          const rel = `images/${name}`;
          if (!written.includes(rel)) written.push(rel);
        }
      }
    }
  } catch {
    /* optional */
  }
  try {
    const assetsDir = path.join(outDir, 'assets');
    if (fs.existsSync(assetsDir)) {
      for (const name of fs.readdirSync(assetsDir)) {
        const abs = path.join(assetsDir, name);
        if (fs.statSync(abs).isFile()) {
          const rel = `assets/${name}`;
          if (!written.includes(rel)) written.push(rel);
        }
      }
    }
  } catch {
    /* optional */
  }
  // Batch 143 (full review): stale-export cleanup. Re-exports only
  // ever WROTE files, never removed them — a deleted page, an
  // unpublished item or a renamed slug stayed live in the output
  // tree and got published forever. Remove exporter-owned files
  // this run did not produce.
  // Batch 168 (S5#2): the 143 sweep only looked at the export ROOT
  // and the detail/ tree — nested pages (services/foo.html from a
  // two-segment slug) and blog posts (blog/<slug>.html) were never
  // pruned, so deleted content at those paths stayed live
  // indefinitely through publish. The sweep is now a full recursive
  // walk: every *.html anywhere in the tree must be in this run's
  // written set, as must the generated _redirects / sitemap.xml /
  // robots.txt at the root. NEVER touches images/ or assets/ (owner
  // uploads live there and are re-listed above, not regenerated),
  // nor any other file type anywhere. The webinar/ shells are
  // excluded: domain.materializeWebsiteExport (re)writes and prunes
  // them on every export (Batch 168) — they are live-resolved
  // shells, not exporter output. Best-effort: a cleanup failure
  // never fails the export.
  try {
    const keep = new Set(written);
    const sweepDir = (dir, prefix) => {
      for (const name of fs.readdirSync(dir)) {
        // images/ + assets/ are owner uploads; webinar/ is owned by
        // domain.materializeWebsiteExport's own write+prune step.
        if (prefix === '' && (name === 'images' || name === 'assets' || name === 'webinar')) continue;
        const abs = path.join(dir, name);
        const rel = prefix ? `${prefix}/${name}` : name;
        let st;
        try {
          st = fs.statSync(abs);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          sweepDir(abs, rel);
          try {
            if (fs.readdirSync(abs).length === 0) fs.rmdirSync(abs);
          } catch {
            /* a directory that refuses to empty is not fatal */
          }
          continue;
        }
        if (!st.isFile()) continue;
        if (/\.html?$/i.test(name)) {
          if (!keep.has(rel)) fs.unlinkSync(abs);
        } else if (
          prefix === '' &&
          (name === '_redirects' || name === 'sitemap.xml' || name === 'robots.txt')
        ) {
          if (!keep.has(name)) fs.unlinkSync(abs);
        }
      }
    };
    sweepDir(outDir, '');
  } catch (e) {
    console.warn('[websiteEngine] stale export cleanup:', e.message || e);
  }
  return { outDir, files: written };
}

/**
 * Export a website as separate HTML files (true multi-pager). Returns outDir.
 * Copies linked design-job images into images/ on every export.
 */
/**
 * Download Pexels/Unsplash hotlinks from a website's pages into
 * EXPORT_ROOT/site-{id}/images and rewrite HTML to images/….
 */
async function localizeWebsiteRemoteImages(db, websiteId) {
  ensureTables(db);
  const site = getWebsite(db, websiteId);
  let pages = JSON.parse(site.pages);
  const theme = JSON.parse(site.theme);
  const blob = JSON.stringify(pages);
  if (!/images\.pexels\.com|images\.unsplash\.com/i.test(blob)) {
    return { id: websiteId, localized: 0, pages };
  }
  const openPreview = require('./openPreview');
  const pexels = require('./pexels');
  const imgDir = path.join(
    openPreview.exportRoot(),
    require('./assetValidation').siteStorageFolderForDb(db, websiteId),
    'images'
  );
  const { pages: next, assets } = await pexels.localizeUrlsInPages(pages, imgDir, { prefix: 'pexels' });
  if (assets.length) {
    saveSite(db, websiteId, next, theme, 'Localized stock image hotlinks into app storage');
    logActivity(db, 'websites', `Website #${websiteId}: stored ${assets.length} stock image(s) in app storage.`);
  }
  return { id: websiteId, localized: assets.length, pages: next };
}

/**
 * Batch 44: collapse a per-deployment Pages host
 * (<label>.<project>.pages.dev — one label more than the project's own
 * subdomain) to the stable project subdomain (<project>.pages.dev).
 * Any other URL is returned unchanged.
 */
function collapsePagesDevDeploymentHost(url) {
  try {
    const u = new URL(url);
    const labels = u.hostname.split('.');
    if (labels.length > 3 && labels[labels.length - 2] === 'pages' && labels[labels.length - 1] === 'dev') {
      u.hostname = labels.slice(1).join('.');
      return u.origin;
    }
  } catch {
    /* unparseable — keep the raw value */
  }
  return url;
}

/**
 * Build the export-time SEO context for a stored site (Batch 31;
 * Batch 32 adds the blog): lead-derived LocalBusiness data, published
 * FAQ-module items, published blog posts + mounts (for static post
 * pages), the site's absolute base URL (custom domain → published
 * URL), and the per-site GSC verification token. Used by exportStatic
 * AND by server/domain.js materializeWebsiteExport so every export
 * funnel (preview, publish, QA) emits the same SEO foundations.
 *
 * Batch 44: opts.seoBaseUrl is an explicit base override threaded from
 * linkDomainToWebsite through the publish funnel while a domain is
 * being linked. During a link-with-publish the stored custom_domain /
 * site_domains state is written only AFTER the publish, so derivation
 * would bake the stale preview host — a per-deployment Pages subdomain
 * that trails the live deployment by one — into the canonical,
 * sitemap and robots of the export being deployed. The override wins
 * over every derived base and applies to this export only.
 */
function buildSeoExportContext(db, websiteId, opts = {}) {
  const ctx = { baseUrl: '', business: null, moduleFaqItems: [], gscToken: '', siteUpdatedAt: '', blog: null, detail: null };
  try {
    const site = getWebsite(db, websiteId);
    ctx.siteUpdatedAt = site.updated_at || '';
    ctx.siteName = site.name || '';
    const lead = site.lead_id ? db.prepare('SELECT * FROM leads WHERE id = ?').get(site.lead_id) : null;
    let seoBaseOverride = '';
    if (opts && typeof opts.seoBaseUrl === 'string' && /^https?:\/\//i.test(opts.seoBaseUrl.trim())) {
      seoBaseOverride = opts.seoBaseUrl.trim().replace(/\/+$/, '');
    }
    // Absolute base: a linked custom domain wins; else the published
    // preview URL when it is a real hosted URL (not a local path).
    if (site.custom_domain) {
      ctx.baseUrl = `https://${String(site.custom_domain).replace(/^https?:\/\//i, '').replace(/\/+$/, '')}`;
    }
    if (!ctx.baseUrl) {
      try {
        const dom = db
          .prepare(
            "SELECT domain_name, public_url FROM site_domains WHERE website_id = ? AND status NOT IN ('failed','unlinked','removed') ORDER BY id DESC LIMIT 1"
          )
          .get(websiteId);
        if (dom && dom.public_url && /^https?:\/\//i.test(dom.public_url)) {
          ctx.baseUrl = String(dom.public_url).replace(/\/+$/, '');
        } else if (dom && dom.domain_name) {
          ctx.baseUrl = `https://${String(dom.domain_name).replace(/^https?:\/\//i, '').replace(/\/+$/, '')}`;
        }
      } catch {
        /* site_domains is optional */
      }
    }
    if (!ctx.baseUrl && site.preview_url && /^https?:\/\//i.test(site.preview_url) && !/localhost|127\.0\.0\.1/i.test(site.preview_url)) {
      // Batch 44: a per-deployment preview host (<hash>.<project>
      // .pages.dev) trails the live deployment by one — collapse it to
      // the stable project subdomain so the SEO base names a host that
      // keeps serving this site.
      ctx.baseUrl = collapsePagesDevDeploymentHost(String(site.preview_url).replace(/\/+$/, ''));
    }
    if (seoBaseOverride) ctx.baseUrl = seoBaseOverride;
    if (lead) {
      let towns = [];
      try {
        const factRows = db
          .prepare(
            "SELECT fact_key, value FROM business_facts WHERE lead_id = ? AND claim_class IN ('VERIFIED','OWNER_PROVIDED')"
          )
          .all(lead.id);
        towns = seoSchema.serviceAreaTowns(factRows);
      } catch {
        /* business_facts optional */
      }
      let services = [];
      try {
        const parsed = lead.services ? JSON.parse(lead.services) : [];
        if (Array.isArray(parsed)) services = parsed.map((s) => String(s || '').trim()).filter(Boolean);
      } catch {
        /* ignore malformed */
      }
      ctx.business = {
        businessName: lead.business_name || site.name || '',
        category: lead.category || site.industry || '',
        description: lead.description || '',
        phone: lead.phone || '',
        email: lead.email || '',
        url: ctx.baseUrl ? `${ctx.baseUrl}/` : lead.website || '',
        address: lead.address || '',
        city: lead.city || '',
        state: lead.state || '',
        postalCode: lead.postal_code || '',
        country: lead.country || 'US',
        latitude: lead.latitude,
        longitude: lead.longitude,
        hours: lead.hours || '',
        socialLinks: lead.social_links || '',
        towns,
        services,
      };
      try {
        const rows = db
          .prepare("SELECT question, answer_html FROM faq_items WHERE lead_id = ? AND status = 'published' ORDER BY sort_order ASC, id ASC")
          .all(lead.id);
        ctx.moduleFaqItems = rows || [];
      } catch {
        /* faq_items optional */
      }
      // Batch 60: attached modules + analytics state drive the generated
      // site-level legal pages (module-aware clauses; truthful claims).
      try {
        const modRows = db
          .prepare('SELECT DISTINCT module_type FROM site_module_embeds WHERE lead_id = ? AND published = 1')
          .all(lead.id);
        ctx.legalModules = (modRows || []).map((r) => String(r.module_type || '')).filter(Boolean);
      } catch {
        ctx.legalModules = [];
      }
      try {
        const a = db
          .prepare('SELECT internal_enabled, google_ids FROM site_analytics_settings WHERE website_id = ?')
          .get(websiteId);
        let googleIds = [];
        try { const parsed = a && a.google_ids ? JSON.parse(a.google_ids) : []; if (Array.isArray(parsed)) googleIds = parsed.map((x) => String(x || '').trim()).filter(Boolean); } catch { /* ignore */ }
        ctx.legalAnalytics = { internal: !!(a && a.internal_enabled), googleIds };
      } catch {
        ctx.legalAnalytics = { internal: false, googleIds: [] };
      }
      // Batch 32 (C6): thread the blog through the SAME context so
      // every export funnel (exportStatic, materialize/cfPublish, QA)
      // emits static post pages + the index snapshot. Published posts
      // only; the anchor is the page carrying the blog mount (an
      // embed's target page first). A member-gated blog page keeps
      // everything behind the wall — no static blog at all.
      try {
        const embedRows = db
          .prepare(
            "SELECT public_token, target_page_slug, settings_json FROM site_module_embeds WHERE lead_id = ? AND module_type = 'blog' AND published = 1"
          )
          .all(lead.id);
        if (embedRows.length && site.pages) {
          const sitePages = JSON.parse(site.pages);
          const tokens = new Set(embedRows.map((r) => String(r.public_token || '')).filter(Boolean));
          const pageHasBlogMount = (p) => {
            if (!p || typeof p !== 'object') return false;
            if (Array.isArray(p.sections)) {
              for (const s of p.sections) {
                const c = (s && s.content) || {};
                const tok = String(c.public_token || c.publicToken || '');
                if (tok && tokens.has(tok)) return true;
              }
            }
            if (typeof p.html === 'string') {
              for (const tok of tokens) if (tok && p.html.includes(tok)) return true;
            }
            return false;
          };
          let anchor = null;
          for (const row of embedRows) {
            const target = canonicalSlugPath(row.target_page_slug || '');
            if (!target) continue;
            const cand = sitePages.find((p) => p && canonicalSlugPath(p.slug) === target);
            if (cand && pageHasBlogMount(cand)) {
              anchor = cand;
              break;
            }
          }
          if (!anchor) {
            const mounted = sitePages.filter(pageHasBlogMount);
            anchor =
              mounted.find((p) => /(^|\/)blog$/.test(canonicalSlugPath(p.slug))) || mounted[0] || null;
          }
          if (!anchor) {
            anchor = sitePages.find((p) => p && /(^|\/)blog$/.test(canonicalSlugPath(p.slug))) || null;
          }
          if (anchor) {
            let gated = false;
            try {
              const mods = require('../server/siteModules');
              if (typeof mods.memberGateCheck === 'function') {
                gated = !!mods.memberGateCheck(db, lead.id, anchor.slug).locked;
              }
            } catch {
              /* gate check is best-effort; the materialize funnel also gates */
            }
            if (!gated) {
              const postRows = db
                .prepare(
                  "SELECT slug, title, excerpt, body_html, cover_image, published_at, updated_at, created_at FROM blog_posts WHERE lead_id = ? AND status = 'published' ORDER BY COALESCE(published_at, created_at) DESC, id DESC"
                )
                .all(lead.id);
              const posts = postRows.map(normalizeBlogPost).filter(Boolean);
              if (posts.length) {
                const embeds = {};
                for (const row of embedRows) {
                  let settings = {};
                  try {
                    settings = JSON.parse(row.settings_json || '{}') || {};
                  } catch {
                    settings = {};
                  }
                  const limit = Number(settings.post_limit);
                  embeds[String(row.public_token)] = {
                    postLimit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : null,
                    showExcerpt: !(
                      settings.show_excerpt === false ||
                      settings.show_excerpt === 0 ||
                      settings.show_excerpt === 'false'
                    ),
                  };
                }
                ctx.blog = { pagePath: canonicalSlugPath(anchor.slug) || 'blog', posts, embeds };
              }
            }
          }
        }
      } catch {
        /* blog context is additive — never break an export over it */
      }
      // Batch 133: the universal detail page's context — for every
      // detail-capable module type on this lead, the public embed
      // token the exported item.html (detail shell) resolves items through and the
      // page its list lives on. Additive like the blog context.
      try {
        const mods = require('../server/siteModules');
        if (typeof mods.detailExportContext === 'function') ctx.detail = mods.detailExportContext(db, lead.id);
      } catch {
        /* detail context is additive — never break an export over it */
      }
    }
    try {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(`seo.gsc.site.${websiteId}`);
      if (row && row.value) {
        ctx.gscToken = String(require('./secretBox').decryptSetting(`seo.gsc.site.${websiteId}`, row.value) || '').trim();
      }
    } catch {
      /* settings optional */
    }
  } catch {
    /* SEO context is additive — never break an export over it */
  }
  return ctx;
}

function exportStatic(db, websiteId, outDir, opts = {}) {
  const site = getWebsite(db, websiteId);
  const pages = JSON.parse(site.pages);
  const theme = JSON.parse(site.theme);
  const images = imagesForWebsite(db, websiteId);
  // Batch 44: opts.seoBaseUrl threads the link-time base override (see
  // buildSeoExportContext) for the IPC/MCP link funnels.
  const seo = buildSeoExportContext(db, websiteId, { seoBaseUrl: opts.seoBaseUrl });
  const written = writeStaticPages(pages, theme, outDir, {
    images,
    websiteId,
    // Batch 102 (SEC-20): lets writeStaticPages find assets staged in
    // the workspace-scoped folder (derived from the DB path).
    workspaceId: require('./assetValidation').workspaceIdFromDb(db),
    seo,
    siteUpdatedAt: seo.siteUpdatedAt,
  });
  const recovered = recoverMissingExportAssets(pages, theme, outDir, { websiteId });
  for (const rel of recovered) {
    if (!written.files.includes(rel)) written.files.push(rel);
  }
  // Copy any app-storage site images + assets into this export folder.
  // Batch 102 (SEC-20): both staging folders (legacy first, scoped wins).
  try {
    const openPreview = require('./openPreview');
    const stagingFolders = require('./assetValidation').siteStorageFoldersForDb(db, websiteId).reverse();
    for (const folder of ['images', 'assets']) {
      const destDir = path.join(outDir, folder);
      for (const staging of stagingFolders) {
        const srcDir = path.join(openPreview.exportRoot(), staging, folder);
        if (fs.existsSync(srcDir)) {
          fs.mkdirSync(destDir, { recursive: true });
          for (const name of fs.readdirSync(srcDir)) {
            const from = path.join(srcDir, name);
            const to = path.join(destDir, name);
            if (fs.statSync(from).isFile()) {
              fs.copyFileSync(from, to);
              const rel = `${folder}/${name}`;
              if (!written.files.includes(rel)) written.files.push(rel);
            }
          }
        }
      }
    }
  } catch {
    /* optional */
  }
  db.prepare("UPDATE websites SET preview_path = ?, updated_at = datetime('now') WHERE id = ?").run(outDir, websiteId);
  logActivity(db, 'websites', `Website #${websiteId} exported to ${outDir} (${(written.files || []).join(', ')}).`);
  return outDir;
}

function applyImagesToPages(pages, images, opts) {
  const list = Array.isArray(images) ? images.slice(0, 6) : [];
  const hero = !!(opts && opts.heroImage);
  let galleries = 0;
  const next = (Array.isArray(pages) ? pages : []).map((page) => ({
    ...page,
    sections: (page.sections || []).map((section) => {
      const content = Object.assign({}, section.content);
      if (section.type === 'gallery') {
        galleries += 1;
        content.images = list;
        if (!content.subtitle) content.subtitle = 'Photos from Pexels. Each picture credits the photographer.';
        return { ...section, content };
      }
      if (section.type === 'hero' && hero && list[0]) {
        content.image = list[0];
        return { ...section, content };
      }
      return section;
    }),
  }));
  // Freeform agent pages (html-only): never inject a template gallery section.
  const freeformOnly =
    next.length &&
    next.every((p) => typeof p.html === 'string' && p.html.trim() && !(Array.isArray(p.sections) && p.sections.length));
  if (freeformOnly) return next;
  if (!galleries && list.length && next[0]) {
    if (!Array.isArray(next[0].sections)) next[0].sections = [];
    const gallery = {
      type: 'gallery',
      content: {
        title: 'Gallery',
        images: list,
        subtitle: 'Photos from Pexels. Each picture credits the photographer.',
      },
    };
    const footerAt = next[0].sections.findIndex((s) => s.type === 'footer');
    if (footerAt >= 0) next[0].sections.splice(footerAt, 0, gallery);
    else next[0].sections.push(gallery);
  }
  return next;
}

async function attachPexelsImages(db, websiteId, opts = {}) {
  ensureTables(db);
  const site = getWebsite(db, websiteId);
  const paused = getSetting(db, 'automation_paused', '0');
  if (String(paused) === '1') throw err('AUTOMATION_PAUSED', 'Automation is paused. Resume it before pulling photos.');
  const key = String(getSetting(db, 'pexels.api_key', '') || '').trim();
  if (!key) throw err('PEXELS_NOT_CONFIGURED', 'Pexels API key is not set. Add it in Settings.');
  const pexels = require('./pexels');
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(site.lead_id);
  const requested = pexels.cleanQuery(opts.query);
  const query =
    requested ||
    (lead && lead.category ? String(lead.category).trim().slice(0, 100) : '') ||
    site.industry ||
    'business';
  const photos = await pexels.searchPhotos(key, query, pexels.clampCount(opts.count == null ? 5 : opts.count));
  if (!photos.length) throw err('PEXELS_EMPTY', `Pexels returned no photos for "${query}".`);
  // Persist into app export storage (EXPORT_ROOT/site-{id}/images), not CDN hotlinks.
  let exportRoot;
  try {
    exportRoot = require('./openPreview').exportRoot();
  } catch {
    throw err('EXPORT_ROOT', 'App export storage is not available.');
  }
  const imgDir = path.join(
    exportRoot,
    require('./assetValidation').siteStorageFolderForDb(db, websiteId),
    'images'
  );
  const localPhotos = await pexels.localizePhotos(photos, imgDir, { prefix: 'pexels' });
  if (!localPhotos.length) throw err('PEXELS_DOWNLOAD', 'Could not store Pexels photos in app storage.');
  const industry = TEMPLATES[site.industry] ? site.industry : detectIndustry(lead && lead.category);
  const heroImage = site.origin === 'agent' || !!(TEMPLATES[industry] && TEMPLATES[industry].heroImage);
  let pages = applyImagesToPages(JSON.parse(site.pages), localPhotos, { heroImage: heroImage || true });
  // Also rewrite any existing freeform hotlinks on the site.
  try {
    const localized = await pexels.localizeUrlsInPages(pages, imgDir, { prefix: 'pexels' });
    pages = localized.pages;
  } catch {
    /* pages already local from applyImages */
  }
  const theme = JSON.parse(site.theme);
  saveSite(db, websiteId, pages, theme, `Pexels photos for "${query}"`);
  logActivity(
    db,
    'websites',
    `Attached ${localPhotos.length} Pexels photo(s) to website #${websiteId} (stored in app storage, query="${query}").`
  );
  return { id: websiteId, count: localPhotos.length, query, stored: true };
}

/* ------------------------------------------------------------------ */

module.exports = {
  // components / rendering
  COMPONENT_TYPES,
  LAYOUT_SECTION_TYPES,
  sectionToHtml,
  sectionLayoutCss,
  renderPage,
  renderPageAt,
  renderSite,
  pageFileName,
  legacyPageFileName,
  canonicalSlugPath,
  pageUrlPath,
  pageForHref,
  normalizeInternalLinksToCanonical,
  // SEO foundations (Batch 31)
  seoContextFromOpts,
  buildSeoExportContext,
  buildSeoHeadExtras,
  resolvePageSeo,
  buildSitemapXml,
  buildRobotsTxt,
  buildRedirects,
  build404Page,
  buildDetailPage,
  buildWebinarPage,
  siteChromeHtml,
  injectDetailMeta,
  // Static blog (Batch 32)
  normalizeBlogPost,
  blogPostPath,
  buildStaticBlogCardsHtml,
  injectStaticBlogSnapshot,
  buildBlogPostPage,
  seoDateIso,
  seoDateLabel,
  stampPageUpdatedAt,
  normalizeRoute,
  navAnchorLabel,
  isComparableNavHref,
  findNavDuplicateIssues,
  dedupeNavHtml,
  assertAndDedupeNavHtml,
  isHomePage,
  homePage,
  pageHasHtml,
  rewriteFileLinksToAnchors,
  rewriteAnchorLinksToFiles,
  normalizePagesNavLinks,
  validateExportNavLinks,
  markFreeformTextNodes,
  markFreeformDocument,
  applyFreeformTextEdits,
  writeStaticPages,
  copyDeliverableImages,
  imagesForWebsite,
  recoverMissingExportAssets,
  collectLocalAssetRefs,
  validateExportAssets,
  normalizeTheme,
  themeRootCss,
  injectThemeStyles,
  injectThemeJs,
  injectFaviconLink,
  faviconLinkTag,
  injectMobileNavAsset,
  sanitizeJs,
  sanitizeHead,
  injectThemeHead,
  injectPreviewBaseHref,
  siteCss,
  navSubmenuCss,
  // templates
  TEMPLATES,
  detectIndustry,
  // facts
  collectFacts,
  getManifest,
  // lifecycle
  generateSite,
  deleteWebsite,
  destroyWebsite,
  removeSiteStorageFolders,
  collectSiteExportFolders,
  restoreWebsite,
  listArchivedWebsites,
  isArchivedSite,
  buildPages,
  deterministicCopy,
  saveVersion,
  pruneWebsiteVersions,
  runRetentionPrunes,
  restoreVersion,
  saveSite,
  getWebsite,
  qaSite,
  exportStatic,
  localizeWebsiteRemoteImages,
  ensureTables,
  applyImagesToPages,
  attachPexelsImages,
  sanitizeCss,
  sanitizeHtml,
  ensureManagedEmbedScripts,
  assertManagedEmbedScripts,
  MANAGED_EMBED_KINDS,
  validatePagesCss,
  pageMarkupForCss,
  assertPagesCss,
  pageCombinedCss,
  extractClassNames,
  extractInlineCss,
  pageMetaFields,
  applySitePartials,
  checkMobileOverflow,
  spacingGuardCss,
  spacingGuardScript,
  injectSpacingGuardScript,
  // exposed for tests
  _spacingTokens: spacingTokens,
  _cleanText: cleanText,
  _deterministicCopy: deterministicCopy,
  _cssDefinesClass: cssDefinesClass,
  _registeredImageUrlSet: registeredImageUrlSet,
  _isRegisteredImageSrc: isRegisteredImageSrc,
};
