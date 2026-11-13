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

/* ------------------------------------------------------------------ */
/* Batch 185 — GEOMETRY AUDIT. Batch 135's measurement was blind to   */
/* the three defect classes Ely screen-recorded on website 52         */
/* (2026-11-13): (a) fixed-height boxes whose text spills past the    */
/* border or is clipped inside it, (b) a heading overlapping its own  */
/* body text and a card overlapping the band above it, (c) FAQ items  */
/* stacked into each other. None of those move a glyph near the       */
/* viewport edge, none involve a .card, and the section inset was     */
/* fine — so 135 reported the page clean. measureGeometryInPage is    */
/* the superset: every 135 check (card selectors widened to the       */
/* platform's module card classes) PLUS content-clip, text-spill,     */
/* sibling-overlap and text-overlap. measureSpacingInPage above is    */
/* kept byte-stable for the 135 pins and the in-suite legacy-         */
/* blindness proof.                                                   */
/* ------------------------------------------------------------------ */

const GEOMETRY_CARD_SELECTOR =
  '.card, .review-card, .bp-mod-card, .bp-mod-dt-card, .bp-mod-gr-card, .bp-mod-member-card, .bp-mod-price-card, .bp-mod-social-card, .bp-mod-empty-card, .bp-mod-news-card';

function measureGeometryInPage(floors) {
  var EDGE = floors.textInset;
  var CARD = floors.cardPad;
  var GAP = floors.cardGap;
  var EPS = 0.6;
  var vw = document.documentElement.clientWidth || window.innerWidth;
  var violations = [];
  // Inlined literally: puppeteer serializes this function's source
  // only — module-scope constants do not exist inside the page.
  var CARD_SEL =
    '.card, .review-card, .bp-mod-card, .bp-mod-dt-card, .bp-mod-gr-card, .bp-mod-member-card, .bp-mod-price-card, .bp-mod-social-card, .bp-mod-empty-card, .bp-mod-news-card';

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
  // Text inside a CLOSED <details> is not rendered, but Chromium
  // still reports phantom range rects for it at the details' origin
  // (all answers stacked on the summary) — measuring it invents
  // overlaps that no visitor can see. The summary itself renders.
  function inClosedDetails(el) {
    for (var n = el; n && n !== document.body; n = n.parentElement) {
      if (n.tagName === 'DETAILS' && !n.open) {
        var sum = n.querySelector(':scope > summary');
        if (sum && sum.contains(el)) return false;
        return true;
      }
    }
    return false;
  }
  function inScroller(el) {
    for (var n = el; n && n !== document.body; n = n.parentElement) {
      if (/(auto|scroll)/.test(getComputedStyle(n).overflowX || '')) return true;
    }
    return false;
  }
  function spacingOff(el) {
    return !!(el && el.closest && el.closest('[data-bp-spacing="off"]'));
  }
  function round1(v) {
    return Math.round(v * 10) / 10;
  }
  function boxLike(el) {
    if (!el || !el.tagName) return false;
    if (el.matches && el.matches(CARD_SEL)) return true;
    if (el.tagName === 'DETAILS') return true;
    var cs = getComputedStyle(el);
    if (
      (parseFloat(cs.borderTopWidth) || 0) > 0 ||
      (parseFloat(cs.borderBottomWidth) || 0) > 0 ||
      (parseFloat(cs.borderLeftWidth) || 0) > 0 ||
      (parseFloat(cs.borderRightWidth) || 0) > 0
    ) {
      return true;
    }
    var bg = cs.backgroundColor;
    return !!bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)';
  }
  // The nearest ancestor whose box CONSTRAINS this text: box-like and
  // with more content than its height allows (a fixed-height box).
  function constrainedBox(el) {
    for (var n = el; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      if (boxLike(n) && n.scrollHeight > n.clientHeight + 1) return n;
    }
    return null;
  }
  // Batch 185 (1HP evidence): the .card-only clearance check missed
  // every other visible box a builder ships — a freestyle band with a
  // background and zero padding, a .col-cell, a CTA band. Generalize:
  // the nearest ancestor that READS as a box (border, background, a
  // platform component class or a <details>) and is big enough to be
  // a container rather than a chip/badge sizes the text's clearance.
  // Interactive elements and table cells keep their own padding
  // conventions and are excluded; crossing a table cell aborts.
  function componentBox(el) {
    for (var n = el; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      var tag = n.tagName;
      if (tag === 'TD' || tag === 'TH' || tag === 'TABLE') return null;
      var isSection = n.hasAttribute && n.hasAttribute('data-ws-section-type');
      var candidate =
        tag !== 'BUTTON' &&
        tag !== 'A' &&
        tag !== 'LI' &&
        (boxLike(n) || (n.matches && n.matches('.col-cell,.cta-band')));
      if (candidate) {
        var cs = getComputedStyle(n);
        var r = n.getBoundingClientRect();
        if (r.width >= 120 && r.height >= 40 && !/inline/.test(cs.display) && cs.display !== 'none') {
          return n;
        }
      }
      if (isSection) return null;
    }
    return null;
  }
  function effOpacity(el) {
    var o = 1;
    for (var n = el; n && n !== document.body; n = n.parentElement) {
      var v = parseFloat(getComputedStyle(n).opacity);
      if (!isNaN(v)) o *= v;
      if (o < 0.9) break;
    }
    return o;
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
  var seenSpill = {};
  var textLeaves = [];
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
    if (!visible(parent) || inScroller(parent) || inClosedDetails(parent)) continue;
    var card = parent.closest ? parent.closest(CARD_SEL) : null;
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
    if (!padBox && !spacingOff(parent)) {
      var comp = componentBox(parent);
      if (comp && visible(comp)) {
        var kr = comp.getBoundingClientRect();
        var kcs = getComputedStyle(comp);
        padBox = {
          l: kr.left + (parseFloat(kcs.borderLeftWidth) || 0),
          r: kr.right - (parseFloat(kcs.borderRightWidth) || 0),
          t: kr.top + (parseFloat(kcs.borderTopWidth) || 0),
          b: kr.bottom - (parseFloat(kcs.borderBottomWidth) || 0),
          el: comp,
        };
      }
    }
    var box = spacingOff(parent) ? null : constrainedBox(parent);
    var boxRect = box ? box.getBoundingClientRect() : null;
    var range = document.createRange();
    range.selectNodeContents(node);
    var rects = range.getClientRects();
    var union = null;
    for (var i = 0; i < rects.length; i++) {
      var r = rects[i];
      if (r.width === 0 || r.height === 0) continue;
      if (!union) union = { l: r.left, t: r.top, r: r.right, b: r.bottom };
      else {
        union.l = Math.min(union.l, r.left);
        union.t = Math.min(union.t, r.top);
        union.r = Math.max(union.r, r.right);
        union.b = Math.max(union.b, r.bottom);
      }
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
      if (boxRect) {
        var over = Math.max(
          boxRect.bottom - r.bottom < -2 ? r.bottom - boxRect.bottom : 0,
          boxRect.right - r.right < -2 ? r.right - boxRect.right : 0
        );
        if (over > 0) {
          var pk = 'p|' + describe(box);
          if (!seenSpill[pk]) {
            seenSpill[pk] = 1;
            violations.push({
              kind: 'text-spill',
              selector: describe(box),
              px: round1(over),
              text: node.nodeValue.trim().slice(0, 24),
            });
          }
        }
      }
    }
    if (union && !spacingOff(parent)) {
      textLeaves.push({ el: parent, box: union, text: node.nodeValue.trim().slice(0, 24) });
    }
    if (range.detach) range.detach();
  }

  var byParent = {};
  document.querySelectorAll(CARD_SEL).forEach(function (c) {
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

  // Batch 185: content-clip — a box-like element whose content is
  // taller than the box itself, with the overflow hidden (the fixed-
  // height card whose last lines are simply gone). Scrollers and
  // deliberate line-clamp truncations are by design, not defects.
  var seenClip = {};
  document.querySelectorAll('body *').forEach(function (el) {
    if (!visible(el) || spacingOff(el)) return;
    if (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') return;
    if (el.scrollHeight <= el.clientHeight + 1) return;
    var cs = getComputedStyle(el);
    if (/(auto|scroll)/.test(cs.overflowX || '') || /(auto|scroll)/.test(cs.overflowY || '')) return;
    if ((cs.overflowY || '') !== 'hidden' && (cs.overflowY || '') !== 'clip') return;
    if (cs.webkitLineClamp && cs.webkitLineClamp !== 'none') return;
    if (!boxLike(el)) return;
    if (!el.textContent || !el.textContent.trim()) return;
    var dk = 'clip|' + describe(el);
    if (!seenClip[dk]) {
      seenClip[dk] = 1;
      violations.push({ kind: 'content-clip', selector: describe(el), px: round1(el.scrollHeight - el.clientHeight) });
    }
  });

  // Batch 185: sibling-overlap — in-flow visible siblings whose border
  // boxes overlap (negative margins, the 1HP band/card stack). Media
  // elements are excluded (underlays are a design pattern); absolutely
  // positioned elements are out of flow by definition.
  var MEDIA = { IMG: 1, PICTURE: 1, VIDEO: 1, SVG: 1, CANVAS: 1, BR: 1, HR: 1 };
  var seenOv = {};
  document.querySelectorAll('body *').forEach(function (p) {
    var kids = [];
    for (var i = 0; i < p.children.length; i++) {
      var k = p.children[i];
      if (!(k instanceof HTMLElement)) continue;
      if (MEDIA[k.tagName]) continue;
      if (!visible(k) || spacingOff(k)) continue;
      var pos = getComputedStyle(k).position;
      if (pos !== 'static' && pos !== 'relative') continue;
      if (!boxLike(k) && !(k.textContent && k.textContent.trim())) continue;
      kids.push(k);
    }
    // Rects are read once per kid (the pairwise loop re-read them per
    // pair — O(n^2) layout reads) and the loop is band-limited by top
    // edge: a pair can only overlap vertically when the later kid's
    // top is above the earlier kid's bottom - 4. Same pairs, same
    // verdicts, near-linear on stacked layouts.
    var rects = kids.map(function (k) {
      return k.getBoundingClientRect();
    });
    var order = kids
      .map(function (k, idx) {
        return idx;
      })
      .sort(function (x, y) {
        return rects[x].top - rects[y].top;
      });
    for (var a = 0; a < order.length; a++) {
      for (var b = a + 1; b < order.length; b++) {
        var ra = rects[order[a]];
        var rb = rects[order[b]];
        if (rb.top >= ra.bottom - 4) break;
        var ox = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
        var oy = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
        if (ox > 4 && oy > 4) {
          var ok2 = 'ov|' + describe(kids[order[a]]) + '|' + describe(kids[order[b]]);
          if (!seenOv[ok2]) {
            seenOv[ok2] = 1;
            violations.push({
              kind: 'sibling-overlap',
              selector: describe(kids[order[a]]) + ' ~ ' + describe(kids[order[b]]),
              px: round1(Math.min(ox, oy)),
            });
          }
        }
      }
    }
  });

  // Batch 185: text-overlap — glyph boxes of two different leaf
  // elements intersecting (the heading sitting on its own paragraph).
  // Elements below opacity 0.9 are exempt: the CSS-only headline
  // rotator stacks full-opacity-at-a-time spans in one grid cell.
  var buckets = {};
  textLeaves.forEach(function (t) {
    if (effOpacity(t.el) < 0.9) return;
    var sec = t.el.closest ? t.el.closest('[data-ws-section-type]') : null;
    var bk = sec ? describe(sec) : 'root';
    if (!buckets[bk]) buckets[bk] = [];
    buckets[bk].push(t);
  });
  var seenTx = {};
  Object.keys(buckets).forEach(function (bk) {
    // Band-limited by top edge (same pairs, same verdicts): a pair can
    // only intersect vertically when the later leaf's top is above the
    // earlier leaf's bottom - 2.
    var arr = buckets[bk].slice().sort(function (x, y) {
      return x.box.t - y.box.t;
    });
    for (var i = 0; i < arr.length; i++) {
      for (var j = i + 1; j < arr.length; j++) {
        var A = arr[i];
        var B = arr[j];
        if (B.box.t >= A.box.b - 2) break;
        if (A.el === B.el || A.el.contains(B.el) || B.el.contains(A.el)) continue;
        var ix = Math.min(A.box.r, B.box.r) - Math.max(A.box.l, B.box.l);
        var iy = Math.min(A.box.b, B.box.b) - Math.max(A.box.t, B.box.t);
        if (ix > 2 && iy > 2) {
          var tk = 'tx|' + describe(A.el) + '|' + describe(B.el);
          if (!seenTx[tk]) {
            seenTx[tk] = 1;
            violations.push({
              kind: 'text-overlap',
              selector: describe(A.el) + ' ~ ' + describe(B.el),
              px: round1(Math.min(ix, iy)),
              text: A.text,
            });
          }
        }
      }
    }
  });

  return { clientWidth: vw, violations: violations.slice(0, 80) };
}

const DEFAULT_WIDTHS = [390, 980, 1440];

function puppeteerLaunchOpts() {
  const launchOpts = {
    headless: true,
    protocolTimeout: 30000,
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

// Batch 185 (finisher hardening): the audits share ONE browser per
// process instead of launching per call — a launch storm under load
// made export audits stall for minutes (a wedged setContent hit the
// 180s protocol ceiling and took whole suites down with it). Every
// audit also runs under a hard deadline: on timeout the shared
// browser is force-closed (its target may be wedged) and the audit
// throws SPACING_AUDIT_TIMEOUT, which callers already record as a
// skipped audit / skip-pass. An audit must never stall an export.
let sharedAuditBrowser = null;
let sharedAuditBrowserPromise = null;
async function auditBrowser() {
  if (sharedAuditBrowser && sharedAuditBrowser.connected) return sharedAuditBrowser;
  if (!sharedAuditBrowserPromise) {
    sharedAuditBrowserPromise = loadBrowser()
      .then((b) => {
        sharedAuditBrowser = b;
        sharedAuditBrowserPromise = null;
        b.on('disconnected', () => {
          if (sharedAuditBrowser === b) sharedAuditBrowser = null;
        });
        return b;
      })
      .catch((e) => {
        sharedAuditBrowserPromise = null;
        throw e;
      });
  }
  return sharedAuditBrowserPromise;
}
async function dropAuditBrowser() {
  const b = sharedAuditBrowser;
  sharedAuditBrowser = null;
  sharedAuditBrowserPromise = null;
  if (b) {
    try {
      await b.close();
    } catch {
      /* */
    }
  }
}
async function withAuditDeadline(work, budgetMs, label) {
  let timer = null;
  const inner = Promise.resolve().then(work);
  inner.catch(() => {}); // an abandoned audit must not surface as unhandled
  try {
    return await Promise.race([
      inner,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const e = new Error(`spacing audit (${label}) exceeded its ${budgetMs}ms budget`);
          e.code = 'SPACING_AUDIT_TIMEOUT';
          reject(e);
        }, budgetMs);
      }),
    ]);
  } catch (e) {
    if (e && e.code === 'SPACING_AUDIT_TIMEOUT') await dropAuditBrowser();
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
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
  const budget = Number(opts.budgetMs) > 0 ? Number(opts.budgetMs) : 60000;
  return withAuditDeadline(() => assessSpacingInner(pages, theme, opts), budget, 'qa');
}
async function assessSpacingInner(pages, theme, opts = {}) {
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
  // Batch 185: the geometry audit (clip / spill / overlap supersets)
  // is the default measurement; opts.geometry === false pins the
  // legacy Batch 135 measurement for comparison proofs.
  const measureFn = opts.geometry === false ? measureSpacingInPage : measureGeometryInPage;
  const floorsArg = {
    textInset: floors.textInset,
    cardPad: floors.cardPad,
    cardGap: floors.cardGap,
    sectionInset: floors.sectionInset,
    sectionInsetMobile: floors.sectionInsetMobile,
  };
  const browser = await auditBrowser();
  const violations = [];
  let page = null;
  try {
    page = await browser.newPage();
    // Batch 145 (external review F11): the spacing browser shares
    // the setContent pattern — guard its subresource requests too.
    await require('./browserGuard').guardBrowserPage(page);
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
        const res = await page.evaluate(measureFn, floorsArg);
        for (const v of res.violations || []) {
          violations.push({ page: slug, width, ...v });
        }
      }
    }
  } finally {
    if (page) {
      try {
        await page.close();
      } catch {
        /* */
      }
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

/**
 * Batch 185 — EXPORT-TIME GEOMETRY AUDIT. qaSite measures the design
 * render; this measures the artifact that actually ships: the final
 * exported HTML files (post module-sync, post injectors) at
 * 390/980/1440 with the same geometry measurement. sitesExport stamps
 * the summary into the export result + settings['spacing_audit.<id>']
 * so a build's measured state travels with every publish. Index page
 * first, capped file count (detail shells share the item templates —
 * the cap keeps the audit bounded on catalogue-heavy sites).
 * Throws (PUPPETEER_MISSING etc.) when it cannot run; the caller
 * records a skipped audit rather than blocking the export.
 */
const EXPORT_AUDIT_MAX_FILES = 12;

async function assessExportedFiles(exported, opts = {}) {
  const budget = Number(opts.budgetMs) > 0 ? Number(opts.budgetMs) : 60000;
  return withAuditDeadline(() => assessExportedFilesInner(exported, opts), budget, 'export');
}
async function assessExportedFilesInner(exported, opts = {}) {
  const floors = spacingTokens();
  if (!floors) {
    const e = new Error('spacing tokens missing from public/css/tokens.css');
    e.code = 'SPACING_TOKENS_MISSING';
    throw e;
  }
  const dir = exported && (exported.dir || (exported.path ? path.dirname(exported.path) : ''));
  const all = ((exported && exported.files) || []).filter((f) => /\.html?$/i.test(String(f)));
  const sorted = all.slice().sort((a, b) => {
    const ai = /(^|\/)index\.html?$/i.test(a) ? 0 : 1;
    const bi = /(^|\/)index\.html?$/i.test(b) ? 0 : 1;
    return ai - bi || String(a).localeCompare(String(b));
  });
  const files = sorted.slice(0, EXPORT_AUDIT_MAX_FILES);
  const widths = Array.isArray(opts.widths) && opts.widths.length ? opts.widths : DEFAULT_WIDTHS;
  const floorsArg = {
    textInset: floors.textInset,
    cardPad: floors.cardPad,
    cardGap: floors.cardGap,
    sectionInset: floors.sectionInset,
    sectionInsetMobile: floors.sectionInsetMobile,
  };
  const browser = await auditBrowser();
  const violations = [];
  let audited = 0;
  let page = null;
  try {
    page = await browser.newPage();
    await require('./browserGuard').guardBrowserPage(page);
    for (const rel of files) {
      let html;
      try {
        html = fs.readFileSync(path.join(dir, rel), 'utf8');
      } catch {
        continue;
      }
      audited += 1;
      for (const width of widths) {
        await page.setViewport({
          width,
          height: width <= 700 ? 844 : 960,
          deviceScaleFactor: 1,
          isMobile: width <= 700,
          hasTouch: width <= 700,
        });
        await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 30000 });
        const res = await page.evaluate(measureGeometryInPage, floorsArg);
        for (const v of res.violations || []) {
          violations.push({ page: rel, width, ...v });
        }
      }
    }
  } finally {
    if (page) {
      try {
        await page.close();
      } catch {
        /* */
      }
    }
  }
  const byKind = {};
  for (const v of violations) byKind[v.kind] = (byKind[v.kind] || 0) + 1;
  const parts = violations
    .slice(0, 6)
    .map((v) => `@${v.width} ${v.page}: ${v.kind} ${v.px}px ${v.selector}${v.text ? ` "${v.text}"` : ''}`);
  return {
    pass: violations.length === 0,
    totalViolations: violations.length,
    byKind,
    filesAudited: audited,
    filesTotal: all.length,
    filesCapped: all.length > files.length,
    violations: violations.slice(0, 40),
    detail: violations.length ? parts.join('; ').slice(0, 900) : '',
    auditedAt: new Date().toISOString(),
  };
}

module.exports = {
  spacingTokens,
  _resetTokenCache,
  measureSpacingInPage,
  measureGeometryInPage,
  assessSpacing,
  assessExportedFiles,
  GEOMETRY_CARD_SELECTOR,
  DEFAULT_WIDTHS,
};
