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
 *                 inset floor for the viewport width. Batch 187: the
 *                 platform WRAPPER roots (ws-nav-chrome /
 *                 ws-footer-chrome / ws-html-block) are exempt — by
 *                 law they carry no padding so the band inside them
 *                 reaches the screen edges; that band's own inset is
 *                 what text-edge / card-text measure.
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
    // Batch 187: platform WRAPPER roots carry no horizontal padding
    // by law — the band inside them owns the inset (the guard CSS
    // zeroes the wrapper so band backgrounds reach the screen edges;
    // the guard script's measured top-up enforces the band itself).
    // A wrapper's own padding is not a spacing signal; band text is
    // policed by the text-edge / card-text geometry below.
    if (
      sec.classList &&
      (sec.classList.contains('ws-nav-chrome') ||
        sec.classList.contains('ws-footer-chrome') ||
        sec.classList.contains('ws-html-block'))
    )
      return;
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
    // Batch 187: platform WRAPPER roots carry no horizontal padding
    // by law — the band inside them owns the inset (the guard CSS
    // zeroes the wrapper so band backgrounds reach the screen edges;
    // the guard script's measured top-up enforces the band itself).
    // A wrapper's own padding is not a spacing signal; band text is
    // policed by the text-edge / card-text geometry below.
    if (
      sec.classList &&
      (sec.classList.contains('ws-nav-chrome') ||
        sec.classList.contains('ws-footer-chrome') ||
        sec.classList.contains('ws-html-block'))
    )
      return;
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
    /* The audit browser must never consume the HOST process's shutdown
       signals. With puppeteer's defaults (handleSIG* = true) a live shared
       browser swallows the first SIGTERM: puppeteer kills the Chrome
       process group as cleanup but leaves the host alive, so a host that
       relies on default signal termination (e.g. a spawned server child)
       hangs forever. Batch 185 keeps the browser alive across audits, so
       this matters now and did not when each audit closed its own browser.
       The host's own signal semantics apply instead; spacingQa closes the
       browser itself (idle close + deadline force-close). */
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
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
// The shared browser must also never hold a SHORT-LIVED process open
// (gate suites, one-shot callers): when the last in-flight audit
// finishes, the browser closes after a short idle grace — an audit
// starting inside the grace reuses it, so server bursts keep the
// sharing benefit while drained processes exit on their own.
let sharedAuditBrowser = null;
let sharedAuditBrowserPromise = null;
let auditsInFlight = 0;
let auditIdleTimer = null;
const AUDIT_IDLE_CLOSE_MS = 2000;
function noteAuditStart() {
  auditsInFlight += 1;
  if (auditIdleTimer) {
    clearTimeout(auditIdleTimer);
    auditIdleTimer = null;
  }
}
function noteAuditEnd() {
  auditsInFlight = Math.max(0, auditsInFlight - 1);
  if (auditsInFlight === 0 && !auditIdleTimer) {
    auditIdleTimer = setTimeout(() => {
      auditIdleTimer = null;
      dropAuditBrowser().catch(() => {});
    }, AUDIT_IDLE_CLOSE_MS);
    if (auditIdleTimer.unref) auditIdleTimer.unref();
  }
}
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
  noteAuditStart();
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
    noteAuditEnd();
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

/* ------------------------------------------------------------------ */
/* Batch 197 — custom-template hook audit (in-page, self-contained).   */
/*                                                                     */
/* A section that rendered through its custom template carries         */
/* data-template="custom" on its root (websiteEngine stamps it). For   */
/* each such root, assert the type's DOM hooks from the manifest       */
/* (src/sectionTemplates.js domHooksByType — e.g. contact_form must    */
/* contain a <form> with fields named name/email/message). Types      */
/* without DOM hooks get the generic non-empty check: a template       */
/* whose substitution produced an empty section fails here, in QA —    */
/* never in the visitor's browser. Returns [{ kind:'template-hook',    */
/* selector, px:0, text }].                                            */
/* ------------------------------------------------------------------ */
function measureTemplateHooksInPage(specs) {
  var out = [];
  var roots = document.querySelectorAll('[data-template="custom"][data-ws-section-type]');
  roots.forEach(function (root) {
    var type = root.getAttribute('data-ws-section-type') || '';
    var selectors = (specs && specs[type]) || [];
    if (!selectors.length) {
      var empty = !root.querySelector('*') && !(root.textContent || '').trim();
      if (empty) {
        out.push({
          kind: 'template-hook',
          selector: '[data-ws-section-type="' + type + '"]',
          px: 0,
          text: 'custom-template section rendered empty',
        });
      }
      return;
    }
    for (var i = 0; i < selectors.length; i++) {
      var sel = selectors[i];
      var found = false;
      try {
        found = root.matches(sel) || !!root.querySelector(sel);
      } catch (e) {
        found = false;
      }
      if (!found) {
        out.push({
          kind: 'template-hook',
          selector: type + ': ' + sel,
          px: 0,
          text: 'custom template is missing required hook ' + sel,
        });
      }
    }
  });
  return out;
}

/* ------------------------------------------------------------------ */
/* Batch 199 — SCRIPT PASS (Part D1 export QA, spec §7.2).             */
/*                                                                     */
/* A separate pass on a FRESH load, after geometry, so animation       */
/* state can never contaminate spacing measurements. Scope: only       */
/* files carrying script markers (section scripts, registry libs,      */
/* theme/page JS). Listeners observe pageerror / console / requests;   */
/* the load waits for networkidle2 plus a bounded settle and one       */
/* scroll-through (IntersectionObserver-driven 3D must start), all     */
/* inside the shared-browser + hard-deadline discipline above.         */
/*                                                                     */
/* FAILS (kind 'script'): a section script that threw (its root        */
/* carries data-bp-js-error), a lib-missing skip or a failed registry  */
/* library (data-bp-js-skipped / data-bp-lib-error / failed request),  */
/* an uncaught pageerror on a scripted page, a SCRIPT request to a     */
/* non-allowlisted host (allowlist = registry hosts + hosts the page   */
/* itself declares in src/href), a missing/invisible/zero-size         */
/* jsExpect target, Part A template hooks eaten after scripts ran,     */
/* or script transfer over the fail budget. WARNS: console errors      */
/* and transfer over the warn budget.                                  */
/* ------------------------------------------------------------------ */
function measureSectionScriptsInPage() {
  var out = [];
  var html = document.documentElement;
  if (html.hasAttribute('data-bp-lib-error')) {
    out.push({
      kind: 'script',
      selector: 'html',
      px: 0,
      text: 'registry library failed to load: ' + html.getAttribute('data-bp-lib-error'),
    });
  }
  document.querySelectorAll('[data-bp-sec]').forEach(function (root) {
    var type = root.getAttribute('data-ws-section-type') || '';
    var key = root.getAttribute('data-bp-sec') || '';
    var sel = '[data-bp-sec="' + key + '"]';
    if (root.hasAttribute('data-bp-js-error')) {
      out.push({ kind: 'script', selector: sel, px: 0, text: 'section script (' + type + ') threw at runtime' });
    }
    if (root.hasAttribute('data-bp-js-skipped')) {
      out.push({
        kind: 'script',
        selector: sel,
        px: 0,
        text: 'section script (' + type + ') skipped: ' + root.getAttribute('data-bp-js-skipped'),
      });
    }
    var expect = root.getAttribute('data-bp-js-expect');
    if (expect) {
      var found = null;
      try {
        found = root.matches(expect) ? root : root.querySelector(expect);
      } catch (e) {
        found = null;
      }
      if (!found) {
        out.push({
          kind: 'script',
          selector: sel,
          px: 0,
          text: 'jsExpect target missing after script run: ' + expect,
        });
      } else {
        var r = found.getBoundingClientRect();
        var cs = getComputedStyle(found);
        if (cs.display === 'none' || cs.visibility === 'hidden' || r.width === 0 || r.height === 0) {
          out.push({
            kind: 'script',
            selector: sel,
            px: 0,
            text: 'jsExpect target is not visible/sized: ' + expect,
          });
        } else if (found.tagName === 'CANVAS' && (found.width === 0 || found.height === 0)) {
          out.push({
            kind: 'script',
            selector: sel,
            px: 0,
            text: 'jsExpect canvas has a zero-size drawing buffer: ' + expect,
          });
        }
      }
    }
  });
  return out;
}

/* ------------------------------------------------------------------ */
/* Batch 200 — EMBED SETTLE. Module mounts ([data-bitpype-module])    */
/* and form mounts ([data-bitpype-form-embed]) render in the browser  */
/* AFTER the static HTML lands: module-embed.js / form-embed.js       */
/* fetch their payload and replace the mount's innerHTML. Measuring   */
/* at domcontentloaded measured the EMPTY mounts, so embed content —  */
/* and any overhang it creates — was invisible to every audit in the  */
/* chain (the Victoria newsletter embed overflowed the viewport by    */
/* exactly the band inset at every width while exports shipped).      */
/* The settle poll waits until every mount carries rendered content   */
/* (anything beyond the lone .bp-mod-loading placeholder), the        */
/* loader is provably absent/blocked in this environment (gate        */
/* browsers cannot reach the module API — the mounts can never        */
/* render there, so waiting out the cap would only burn budget), or   */
/* the cap elapses. Measurement then proceeds on whatever rendered;   */
/* the audit result records what it saw.                              */
/* ------------------------------------------------------------------ */
function embedsSettledInPage() {
  var mounts = document.querySelectorAll('[data-bitpype-module], [data-bitpype-form-embed]');
  var rendered = 0;
  mounts.forEach(function (m) {
    var kids = m.children;
    var done = kids.length > 0 && !(kids.length === 1 && kids[0].classList.contains('bp-mod-loading'));
    if (done) rendered += 1;
  });
  return { mounts: mounts.length, rendered: rendered, settled: rendered === mounts.length };
}

const MOUNT_MARKER_RE = /data-bitpype-module|data-bitpype-form-embed/;

async function waitForEmbedSettle(page, opts = {}) {
  const capMs = Number(opts.capMs) > 0 ? Number(opts.capMs) : 6000;
  const graceMs = 2500; // loader-absent grace before giving the mounts up as env-blocked
  const t0 = Date.now();
  let last = { mounts: 0, rendered: 0, settled: true };
  for (;;) {
    const snap = await page.evaluate(embedsSettledInPage).catch(() => null);
    if (snap) last = snap;
    if (last.settled) return { ...last, waitedMs: Date.now() - t0, timedOut: false, loaderAbsent: false };
    const elapsed = Date.now() - t0;
    if (elapsed >= capMs) return { ...last, waitedMs: elapsed, timedOut: last.mounts > 0, loaderAbsent: false };
    if (elapsed >= graceMs) {
      const booted = await page
        .evaluate(() => !!(window.BitpypeModules && window.BitpypeModules.__booted))
        .catch(() => false);
      if (!booted) return { ...last, waitedMs: elapsed, timedOut: false, loaderAbsent: true };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

const SCRIPT_MARKER_RE = /data-ws-section-js|data-bp-lib|data-ws-theme-js|data-ws-page-js/;

function hostsDeclaredInHtml(html) {
  const hosts = new Set();
  // Only real tag attributes count — a URL string inside an inline
  // script's text (s.src = "https://…") is NOT a declaration; that is
  // precisely the runtime injection the pass must catch.
  const re =
    /<(?:script|link|img|iframe|source|video|audio|a)\b[^>]*?\b(?:src|href)\s*=\s*["']https?:\/\/([^/"'\s]+)/gi;
  let m;
  while ((m = re.exec(String(html || '')))) hosts.add(m[1].toLowerCase());
  return hosts;
}

async function auditScriptPass(page, html, templateSpecs) {
  const scriptLibs = require('../src/scriptLibs');
  const violations = [];
  const warnings = [];
  const scriptRequestUrls = [];
  const failedScriptUrls = [];
  let scriptBytes = 0;
  const onRequest = (req) => {
    try {
      if (req.resourceType() === 'script') scriptRequestUrls.push(req.url());
    } catch {
      /* */
    }
  };
  const onResponse = (res) => {
    try {
      if (res.request().resourceType() !== 'script') return;
      res
        .buffer()
        .then((b) => {
          scriptBytes += b.length;
        })
        .catch(() => {});
    } catch {
      /* */
    }
  };
  const onFailed = (req) => {
    try {
      if (req.resourceType() === 'script') failedScriptUrls.push(req.url());
    } catch {
      /* */
    }
  };
  const onPageError = (e) => {
    violations.push({
      kind: 'script',
      selector: 'pageerror',
      px: 0,
      text: 'uncaught error on a scripted page: ' + String((e && e.message) || e).slice(0, 200),
    });
  };
  const onConsole = (msg) => {
    try {
      if (msg.type() === 'error') warnings.push('console error: ' + msg.text().slice(0, 200));
    } catch {
      /* */
    }
  };
  page.on('request', onRequest);
  page.on('response', onResponse);
  page.on('requestfailed', onFailed);
  page.on('pageerror', onPageError);
  page.on('console', onConsole);
  try {
    await page.setContent(html, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
    await page
      .evaluate(async () => {
        const h = document.body ? document.body.scrollHeight : 0;
        for (let y = 0; y <= h; y += 600) {
          window.scrollTo(0, y);
          await new Promise((r) => setTimeout(r, 50));
        }
        window.scrollTo(0, 0);
      })
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 700));
    const found = await page.evaluate(measureSectionScriptsInPage).catch(() => []);
    for (const v of found || []) violations.push(v);
    // Part A hooks re-asserted AFTER scripts ran and settled — a
    // script that ate a functional hook fails here (spec §6).
    const hooks = await page.evaluate(measureTemplateHooksInPage, templateSpecs).catch(() => []);
    for (const v of hooks || []) violations.push(v);
  } finally {
    page.off('request', onRequest);
    page.off('response', onResponse);
    page.off('requestfailed', onFailed);
    page.off('pageerror', onPageError);
    page.off('console', onConsole);
  }
  const registryHosts = scriptLibs.registryHosts().map((h) => h.toLowerCase());
  const ownHosts = hostsDeclaredInHtml(html);
  // Spec §5.1: external scripts the page itself declares (the
  // owner's customHead escape hatch) are allowlisted for the fail
  // rule, but anything outside the registry earns a warning.
  {
    const tagRe = /<script\b[^>]*\bsrc\s*=\s*["']https?:\/\/([^/"'\s]+)/gi;
    let m;
    const warned = new Set();
    while ((m = tagRe.exec(String(html || '')))) {
      const host = m[1].toLowerCase();
      if (!registryHosts.includes(host) && !warned.has(host)) {
        warned.add(host);
        warnings.push(`external script outside the registry: ${host} (prefer section.libs)`);
      }
    }
  }
  for (const url of scriptRequestUrls) {
    let host = '';
    try {
      host = new URL(url).host.toLowerCase();
    } catch {
      continue;
    }
    if (!host) continue;
    if (registryHosts.includes(host) || ownHosts.has(host)) continue;
    violations.push({
      kind: 'script',
      selector: host,
      px: 0,
      text: 'script loaded from a non-allowlisted host: ' + String(url).slice(0, 160),
    });
  }
  for (const url of failedScriptUrls) {
    let host = '';
    try {
      host = new URL(url).host.toLowerCase();
    } catch {
      continue;
    }
    if (registryHosts.includes(host)) {
      violations.push({
        kind: 'script',
        selector: host,
        px: 0,
        text: 'registry library request failed: ' + String(url).slice(0, 160),
      });
    }
  }
  const inlineBytes = (String(html).match(/<script\b[^>]*data-ws-section-js[\s\S]*?<\/script>/g) || []).reduce(
    (n, s) => n + s.length,
    0
  );
  const totalBytes = scriptBytes + inlineBytes;
  if (totalBytes > scriptLibs.SCRIPT_FAIL_BYTES) {
    violations.push({
      kind: 'script',
      selector: 'page',
      px: 0,
      text: `script transfer ${totalBytes} bytes exceeds the ${scriptLibs.SCRIPT_FAIL_BYTES}-byte budget`,
    });
  } else if (totalBytes > scriptLibs.SCRIPT_WARN_BYTES) {
    warnings.push(`script transfer ${totalBytes} bytes exceeds the ${scriptLibs.SCRIPT_WARN_BYTES}-byte warn budget`);
  }
  return { violations, warnings };
}

/**
 * Measure every page at every width. Returns
 * { pass, detail, violations: [{ page, width, kind, selector, px, text? }] }.
 * Throws (PUPPETEER_MISSING / launch / render errors) when the check
 * cannot run at all — qaSite records the established skip-pass.
 */
// Batch 200: load a document into an audit page, surviving ONE
// wedged page. A setContent timeout can leave the renderer wedged
// behind interception-paused requests (proven trigger: an
// unresolvable embed host stalling the guard's DNS validation) —
// every later evaluate then hangs for the full protocol timeout,
// and an audit that simply presses on burns its entire budget on a
// single page. Discarding the wedged page unwedges the audit; a
// second stall means the ENVIRONMENT cannot load these pages, so
// the audit aborts with a clear SPACING_AUDIT_ENV error and the
// caller fails closed — fast, instead of after minutes of grinding.
// Returns { page, recreated } — page may be a fresh replacement.
async function loadIntoAuditPage(browser, page, viewport, html, alreadyRecreated) {
  await page.setViewport(viewport);
  const ok = await page
    .setContent(html, { waitUntil: 'domcontentloaded', timeout: 20000 })
    .then(() => true)
    .catch(() => false);
  if (ok) return { page, recreated: alreadyRecreated };
  if (alreadyRecreated) {
    const err = new Error(
      'spacing audit aborted: the audit browser could not load the pages (repeated navigation stalls)'
    );
    err.code = 'SPACING_AUDIT_ENV';
    throw err;
  }
  try {
    await page.close();
  } catch {
    /* wedged page — closing is best-effort */
  }
  const fresh = await browser.newPage();
  await require('./browserGuard').guardBrowserPage(fresh);
  await fresh.setViewport(viewport);
  const ok2 = await fresh
    .setContent(html, { waitUntil: 'domcontentloaded', timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  if (!ok2) {
    const err = new Error(
      'spacing audit aborted: the audit browser could not load the pages (repeated navigation stalls)'
    );
    err.code = 'SPACING_AUDIT_ENV';
    throw err;
  }
  return { page: fresh, recreated: true };
}

async function assessSpacing(pages, theme, opts = {}) {
  const budget = Number(opts.budgetMs) > 0 ? Number(opts.budgetMs) : 120000;
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
  // Batch 197: DOM hooks per template-enabled type (manifest-driven).
  const templateSpecs = require('../src/sectionTemplates').domHooksByType();
  const browser = await auditBrowser();
  const violations = [];
  let page = null;
  // Batch 200: navigation stalls are handled by discarding a
  // wedged page once and aborting on a second stall (see
  // loadIntoAuditPage); once one page proves the embed loader
  // cannot boot in this environment, settle waits are skipped for
  // the rest of the audit.
  let embedsBlocked = false;
  let pageRecreated = false;
  try {
    page = await browser.newPage();
    // Batch 145 (external review F11): the spacing browser shares
    // the setContent pattern — guard its subresource requests too.
    await require('./browserGuard').guardBrowserPage(page);
    for (const p of list) {
      const html = renderPage(p, list, theme);
      const slug = String((p && p.slug) || 'page');
      // Batch 200: load once per page, measure every width by
      // resizing (see assessExportedFilesInner for the rationale).
      // The emulation flags (isMobile/hasTouch) stay OFF at every
      // width: flipping them mid-audit makes Chrome reload the
      // document for the new emulation mode, and that reload —
      // through the guard, over slow subresources — times out and
      // fails the file (proven in production). Layout width, which
      // is all the spacing law measures, follows the viewport
      // width alone.
      const firstViewport = {
        width: widths[0],
        height: widths[0] <= 700 ? 844 : 960,
        deviceScaleFactor: 1,
      };
      const loadRes = await loadIntoAuditPage(browser, page, firstViewport, html, pageRecreated);
      page = loadRes.page;
      pageRecreated = loadRes.recreated;
      if (MOUNT_MARKER_RE.test(html) && !embedsBlocked) {
        const settle = await waitForEmbedSettle(page, { capMs: 6000 });
        if (settle.loaderAbsent) embedsBlocked = true;
      }
      for (const width of widths) {
        if (width !== widths[0]) {
          await page.setViewport({
            width,
            height: width <= 700 ? 844 : 960,
            deviceScaleFactor: 1,
          });
          await new Promise((r) => setTimeout(r, 150));
        }
        const res = await page.evaluate(measureFn, floorsArg);
        for (const v of res.violations || []) {
          violations.push({ page: slug, width, ...v });
        }
        // Batch 197: custom-template DOM hooks, asserted once per
        // page (first width — DOM presence is width-independent).
        if (width === widths[0]) {
          const hooks = await page.evaluate(measureTemplateHooksInPage, templateSpecs);
          for (const v of hooks || []) {
            violations.push({ page: slug, width, ...v });
          }
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
 * Throws (PUPPETEER_MISSING etc.) when it cannot run at all, and
 * reports per-file failures in filesFailed when individual files
 * cannot be measured. Batch 200: the caller (domain's
 * attachSpacingAudit) treats ANY incompleteness — a throw, a failed
 * file, or fewer files measured than selected — as a failed export,
 * never a shipped-unaudited one.
 */
const EXPORT_AUDIT_MAX_FILES = 12;

async function assessExportedFiles(exported, opts = {}) {
  const budget = Number(opts.budgetMs) > 0 ? Number(opts.budgetMs) : 360000;
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
  // Batch 197: DOM hooks per template-enabled type (manifest-driven).
  const templateSpecs = require('../src/sectionTemplates').domHooksByType();
  const browser = await auditBrowser();
  const violations = [];
  const scriptWarnings = [];
  const filesFailed = [];
  const embeds = { mounts: 0, rendered: 0 };
  let audited = 0;
  let page = null;
  // Batch 200: the settle wait below is what lets the audit measure
  // the page AFTER module embeds render (the pre-embed DOM hid
  // every embed overhang). Navigation stalls are handled by
  // discarding a wedged page once and aborting on a second stall —
  // see loadIntoAuditPage for why.
  let embedsBlocked = false;
  let pageRecreated = false;
  try {
    page = await browser.newPage();
    await require('./browserGuard').guardBrowserPage(page);
    for (const rel of files) {
      let html;
      try {
        html = fs.readFileSync(path.join(dir, rel), 'utf8');
      } catch (e) {
        filesFailed.push({ file: rel, error: `unreadable: ${String((e && e.message) || e).slice(0, 120)}` });
        continue;
      }
      try {
        // Batch 200: load the document ONCE per file and measure
        // every width by resizing the viewport. Reloading per width
        // tripled the audit's cost in slow-subresource environments
        // (production's hairpin made a 9-file export audit exceed
        // its whole budget without measuring anything like all of
        // it); the rendered DOM — embeds included — persists across
        // a resize, and geometry reads force a live reflow at the
        // new width, so per-width measurement stays exact. The
        // emulation flags (isMobile/hasTouch) stay OFF at every
        // width — flipping them makes Chrome reload the document
        // mid-audit and the reload times out (proven in
        // production); layout width follows the viewport width.
        const firstViewport = {
          width: widths[0],
          height: widths[0] <= 700 ? 844 : 960,
          deviceScaleFactor: 1,
        };
        const loadRes = await loadIntoAuditPage(browser, page, firstViewport, html, pageRecreated);
        page = loadRes.page;
        pageRecreated = loadRes.recreated;
        if (MOUNT_MARKER_RE.test(html) && !embedsBlocked) {
          const settle = await waitForEmbedSettle(page, { capMs: 6000 });
          if (settle.loaderAbsent) embedsBlocked = true;
          embeds.mounts += settle.mounts;
          embeds.rendered += settle.rendered;
        }
        for (const width of widths) {
          if (width !== widths[0]) {
            await page.setViewport({
              width,
              height: width <= 700 ? 844 : 960,
              deviceScaleFactor: 1,
            });
            // Let resize-driven re-renders land before measuring.
            await new Promise((r) => setTimeout(r, 150));
          }
          const res = await page.evaluate(measureGeometryInPage, floorsArg);
          for (const v of res.violations || []) {
            violations.push({ page: rel, width, ...v });
          }
          // Batch 197: custom-template DOM hooks, asserted once per
          // file (first width — DOM presence is width-independent).
          if (width === widths[0]) {
            const hooks = await page.evaluate(measureTemplateHooksInPage, templateSpecs);
            for (const v of hooks || []) {
              violations.push({ page: rel, width, ...v });
            }
          }
        }
        audited += 1;
      } catch (e) {
        // An environment abort is audit-wide, not per-file: the
        // caller must fail closed, not record 12 identical failures.
        if (e && e.code === 'SPACING_AUDIT_ENV') throw e;
        filesFailed.push({ file: rel, error: String((e && e.message) || e).slice(0, 160) });
        continue;
      }
      // Batch 199: the script pass — a fresh load with listeners,
      // only for files carrying script markers (spec §7.2).
      // Batch 200: the pass runs in a FRESH browser context. On the
      // shared geometry page the pass's load is served from the
      // browser's HTTP cache, and a script fetch that failed during
      // the geometry load (negative cache) is never re-requested —
      // a dynamically injected off-allowlist script, the exact case
      // this pass exists to catch, went unobserved (proven: the
      // request event never fires on the second load of the same
      // document). A fresh context has a cold cache, so every script
      // the page loads is requested — and recorded — again.
      if (SCRIPT_MARKER_RE.test(html)) {
        const ctx = await browser.createBrowserContext();
        try {
          const spPage = await ctx.newPage();
          await require('./browserGuard').guardBrowserPage(spPage);
          await spPage.setViewport({
            width: widths[0],
            height: widths[0] <= 700 ? 844 : 960,
            deviceScaleFactor: 1,
          });
          const sp = await auditScriptPass(spPage, html, templateSpecs);
          for (const v of sp.violations || []) {
            violations.push({ page: rel, width: widths[0], ...v });
          }
          for (const w of sp.warnings || []) {
            scriptWarnings.push(`${rel}: ${w}`);
          }
        } finally {
          await ctx.close().catch(() => {});
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
    filesSelected: files.length,
    filesFailed,
    embeds,
    filesTotal: all.length,
    filesCapped: all.length > files.length,
    violations: violations.slice(0, 40),
    warnings: scriptWarnings.slice(0, 20),
    detail: violations.length ? parts.join('; ').slice(0, 900) : '',
    auditedAt: new Date().toISOString(),
  };
}

module.exports = {
  spacingTokens,
  _resetTokenCache,
  measureSpacingInPage,
  measureGeometryInPage,
  measureTemplateHooksInPage,
  measureSectionScriptsInPage,
  embedsSettledInPage,
  waitForEmbedSettle,
  assessSpacing,
  assessExportedFiles,
  GEOMETRY_CARD_SELECTOR,
  DEFAULT_WIDTHS,
};
