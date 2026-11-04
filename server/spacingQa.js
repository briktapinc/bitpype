'use strict';

/**
 * Batch 135 — SPACING GUARANTEE (geometry QA).
 *
 * Ely's standing rules, measured instead of eyeballed: text never
 * touches container edges (2026-10-15); cards never touch — one
 * uniform gap standard, verified by measurement (2026-10-31). This is
 * the edge-proximity QA drafted as Cursor prompt #6 (2026-10-20) and
 * never shipped; it joins module-fit / flows-live in website.qa.
 *
 * The floor NUMBERS live only in public/css/tokens.css (the Batch 111
 * single source): spacingTokens() parses that file at runtime and both
 * this check and the export engine's spacing guard consume the parsed
 * values. No second copy of the numbers exists in code.
 *
 * assessSpacing({ pages, theme, renderPage }) renders every page via
 * the caller's renderPage (websiteEngine passes its own — no circular
 * require), loads each render in headless Chromium at 390 / 980 /
 * 1440 (the 980 width caught what 1440 missed on 2026-10-18), and
 * measures REAL geometry with text-node Ranges:
 *   - text-edge:  a text glyph box sits < --bp-space-text-inset from
 *                 a viewport edge (selector + px + width reported);
 *   - overflow:   document scrollWidth exceeds clientWidth;
 *   - card-text:  text inside a .card sits < --bp-space-card-pad from
 *                 the card's padding-box edge;
 *   - card-gap:   sibling cards in one parent touch or sit
 *                 < --bp-space-card-gap apart;
 *   - section-pad: a [data-ws-section-type] band — nav/footer chrome
 *                 INCLUDED (finisher scope: the 2026-11-04 audit found
 *                 chrome outside the spacing system on every export
 *                 site, 288 of 459 section entries at 0px) — whose
 *                 computed horizontal padding sits below the section
 *                 inset floor for the viewport width.
 * Browser unavailable -> throws err.code 'PUPPETEER_MISSING' (or the
 * launch error) so qaSite can record the established skip-pass, the
 * same contract as checkMobileOverflow.
 */

const fs = require('node:fs');
const path = require('node:path');

const TOKENS_PATH = path.join(__dirname, '..', 'public', 'css', 'tokens.css');
const TOKEN_KEYS = ['section-inset', 'section-inset-mobile', 'container-inset', 'card-pad', 'card-gap', 'text-inset'];

let tokenCache = null;

/** Parse the Batch 135 spacing tokens out of tokens.css. Null when the
 * file or any token is missing (callers degrade to skip, never guess). */
function spacingTokens() {
  if (tokenCache) return tokenCache;
  let css;
  try {
    css = fs.readFileSync(TOKENS_PATH, 'utf8');
  } catch {
    return null;
  }
  const found = {};
  const re = /--bp-space-([a-z-]+)\s*:\s*([0-9]+(?:\.[0-9]+)?)px/g;
  let m;
  while ((m = re.exec(css))) found[m[1]] = Number(m[2]);
  for (const k of TOKEN_KEYS) {
    if (!Number.isFinite(found[k])) return null;
  }
  tokenCache = {
    sectionInset: found['section-inset'],
    sectionInsetMobile: found['section-inset-mobile'],
    containerInset: found['container-inset'],
    cardPad: found['card-pad'],
    cardGap: found['card-gap'],
    textInset: found['text-inset'],
  };
  return tokenCache;
}

/** Test hook: drop the parse cache (suite points TOKENS at fixtures
 * only via the real file; the cache matters across qaSite calls). */
function _resetTokenCache() {
  tokenCache = null;
}

/**
 * In-page measurement. Self-contained (puppeteer serializes it): takes
 * the parsed floors, returns { clientWidth, violations: [...] }.
 * Text is measured by glyph box (Range.getClientRects), so a centered
 * full-width heading — whose BLOCK spans the container — is judged by
 * where its letters actually sit, not by its box.
 */
function measureSpacingInPage(floors) {
  var EDGE = floors.textInset;
  var CARD = floors.cardPad;
  var GAP = floors.cardGap;
  var EPS = 0.6;
  var vw = document.documentElement.clientWidth || window.innerWidth;
  var violations = [];

  function describe(el) {
    if (!el || !el.tagName) return 'unknown';
    var s = el.tagName.toLowerCase();
    var st = el.getAttribute && el.getAttribute('data-ws-section-type');
    if (st) s += '[data-ws-section-type="' + st + '"]';
    if (el.id) s += '#' + el.id;
    if (typeof el.className === 'string' && el.className.trim()) {
      s += '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.');
    }
    return s;
  }
  function visible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    var cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function inScroller(el) {
    for (var n = el; n && n !== document.body; n = n.parentElement) {
      if (/(auto|scroll)/.test(getComputedStyle(n).overflowX || '')) return true;
    }
    return false;
  }
  function round1(v) {
    return Math.round(v * 10) / 10;
  }

  var docEl = document.documentElement;
  var scrollW = Math.max(docEl.scrollWidth, document.body ? document.body.scrollWidth : 0);
  if (scrollW - vw > 1) {
    violations.push({ kind: 'overflow', selector: 'document', px: round1(scrollW - vw) });
  }

  var secFloor = vw <= 700 ? floors.sectionInsetMobile : floors.sectionInset;
  var seenSec = {};
  document.querySelectorAll('[data-ws-section-type]').forEach(function (sec) {
    if (!visible(sec)) return;
    if (sec.getAttribute('data-bp-spacing') === 'off') return;
    var cs = getComputedStyle(sec);
    var minPad = Math.min(parseFloat(cs.paddingLeft) || 0, parseFloat(cs.paddingRight) || 0);
    if (minPad < secFloor - EPS) {
      var sk = 's|' + describe(sec);
      if (!seenSec[sk]) {
        seenSec[sk] = 1;
        violations.push({ kind: 'section-pad', selector: describe(sec), px: round1(Math.max(0, minPad)) });
      }
    }
  });

  var seenEdge = {};
  var seenCard = {};
  var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode: function (node) {
      if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      var p = node.parentElement;
      if (!p) return NodeFilter.FILTER_REJECT;
      var tag = p.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TITLE') {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  var node;
  while ((node = walker.nextNode())) {
    var parent = node.parentElement;
    if (!visible(parent) || inScroller(parent)) continue;
    var card = parent.closest ? parent.closest('.card, .review-card') : null;
    var padBox = null;
    if (card && visible(card)) {
      var cr = card.getBoundingClientRect();
      var ccs = getComputedStyle(card);
      padBox = {
        l: cr.left + (parseFloat(ccs.borderLeftWidth) || 0),
        r: cr.right - (parseFloat(ccs.borderRightWidth) || 0),
        t: cr.top + (parseFloat(ccs.borderTopWidth) || 0),
        b: cr.bottom - (parseFloat(ccs.borderBottomWidth) || 0),
        el: card,
      };
    }
    var range = document.createRange();
    range.selectNodeContents(node);
    var rects = range.getClientRects();
    for (var i = 0; i < rects.length; i++) {
      var r = rects[i];
      if (r.width === 0 || r.height === 0) continue;
      if (r.left >= -0.5 && r.right <= vw + 0.5) {
        var d = Math.min(r.left, vw - r.right);
        if (d < EDGE - EPS) {
          var key = 'e|' + describe(parent);
          if (!seenEdge[key]) {
            seenEdge[key] = 1;
            violations.push({
              kind: 'text-edge',
              selector: describe(parent),
              px: round1(Math.max(0, d)),
              text: node.nodeValue.trim().slice(0, 24),
            });
          }
        }
      }
      if (padBox) {
        var cd = Math.min(r.left - padBox.l, padBox.r - r.right, r.top - padBox.t, padBox.b - r.bottom);
        if (cd < CARD - EPS) {
          var ck = 'c|' + describe(padBox.el);
          if (!seenCard[ck]) {
            seenCard[ck] = 1;
            violations.push({ kind: 'card-text', selector: describe(padBox.el), px: round1(Math.max(0, cd)) });
          }
        }
      }
    }
    if (range.detach) range.detach();
  }

  var byParent = {};
  document.querySelectorAll('.card, .review-card').forEach(function (c) {
    if (!visible(c)) return;
    var p = c.parentElement;
    if (!p) return;
    var k = describe(p);
    if (!byParent[k]) byParent[k] = { parent: p, kids: [] };
    byParent[k].kids.push(c);
  });
  Object.keys(byParent).forEach(function (k) {
    var kids = byParent[k].kids;
    if (kids.length < 2) return;
    var rects = kids.map(function (c) {
      return c.getBoundingClientRect();
    });
    var seenGap = {};
    for (var i = 0; i < rects.length; i++) {
      for (var j = i + 1; j < rects.length; j++) {
        var a = rects[i];
        var b = rects[j];
        var vOverlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        var hOverlap = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        var gap = null;
        if (vOverlap > 4) {
          gap = a.left <= b.left ? b.left - a.right : a.left - b.right;
        } else if (hOverlap > 4) {
          gap = a.top <= b.top ? b.top - a.bottom : a.top - b.bottom;
        }
        if (gap !== null && gap < GAP - EPS) {
          var gk = 'g|' + Math.round(gap);
          if (!seenGap[gk]) {
            seenGap[gk] = 1;
            violations.push({ kind: 'card-gap', selector: describe(byParent[k].parent), px: round1(Math.max(0, gap)) });
          }
        }
      }
    }
  });

  return { clientWidth: vw, violations: violations.slice(0, 60) };
}

const DEFAULT_WIDTHS = [390, 980, 1440];

function puppeteerLaunchOpts() {
  const launchOpts = {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  };
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome-stable',
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) {
      launchOpts.executablePath = p;
      return launchOpts;
    }
  }
  return launchOpts; // puppeteer's own bundled-Chromium resolution
}

async function loadBrowser() {
  let puppeteer;
  try {
    puppeteer = require('puppeteer');
  } catch {
    const e = new Error('puppeteer not installed');
    e.code = 'PUPPETEER_MISSING';
    throw e;
  }
  const launchOpts = puppeteerLaunchOpts();
  if (!launchOpts.executablePath) {
    try {
      const resolved = await puppeteer.executablePath();
      if (resolved && fs.existsSync(resolved)) launchOpts.executablePath = resolved;
    } catch {
      /* launch below surfaces the real error */
    }
  }
  return puppeteer.launch(launchOpts);
}

/**
 * Measure every page at every width. Returns
 * { pass, detail, violations: [{ page, width, kind, selector, px, text? }] }.
 * Throws (PUPPETEER_MISSING / launch / render errors) when the check
 * cannot run at all — qaSite records the established skip-pass.
 */
async function assessSpacing(pages, theme, opts = {}) {
  const floors = spacingTokens();
  if (!floors) {
    const e = new Error('spacing tokens missing from public/css/tokens.css');
    e.code = 'SPACING_TOKENS_MISSING';
    throw e;
  }
  const renderPage = opts.renderPage;
  if (typeof renderPage !== 'function') throw new Error('assessSpacing needs opts.renderPage');
  const widths = Array.isArray(opts.widths) && opts.widths.length ? opts.widths : DEFAULT_WIDTHS;
  const list = Array.isArray(pages) ? pages : [];
  const browser = await loadBrowser();
  const violations = [];
  try {
    const page = await browser.newPage();
    for (const p of list) {
      const html = renderPage(p, list, theme);
      const slug = String((p && p.slug) || 'page');
      for (const width of widths) {
        await page.setViewport({
          width,
          height: width <= 700 ? 844 : 960,
          deviceScaleFactor: 1,
          isMobile: width <= 700,
          hasTouch: width <= 700,
        });
        await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 30000 });
        const res = await page.evaluate(measureSpacingInPage, {
          textInset: floors.textInset,
          cardPad: floors.cardPad,
          cardGap: floors.cardGap,
          sectionInset: floors.sectionInset,
          sectionInsetMobile: floors.sectionInsetMobile,
        });
        for (const v of res.violations || []) {
          violations.push({ page: slug, width, ...v });
        }
      }
    }
  } finally {
    try {
      await browser.close();
    } catch {
      /* */
    }
  }
  const byWidth = new Map();
  for (const v of violations) {
    if (!byWidth.has(v.width)) byWidth.set(v.width, []);
    byWidth.get(v.width).push(v);
  }
  const parts = [];
  for (const width of widths) {
    const vs = byWidth.get(width) || [];
    for (const v of vs.slice(0, 6)) {
      parts.push(`@${width} ${v.page}: ${v.kind} ${v.px}px ${v.selector}${v.text ? ` "${v.text}"` : ''}`);
    }
  }
  return {
    pass: violations.length === 0,
    violations,
    detail: violations.length ? parts.join('; ').slice(0, 900) : '',
  };
}

module.exports = {
  spacingTokens,
  _resetTokenCache,
  measureSpacingInPage,
  assessSpacing,
  DEFAULT_WIDTHS,
};
