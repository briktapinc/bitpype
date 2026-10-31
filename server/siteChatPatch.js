'use strict';

/**
 * Batch 104 — OPTIMISTIC PREVIEW patch derivation for the portal
 * design chat.
 *
 * Ely's ask (2026-10-31): when a design-chat change is accepted,
 * it should appear INSTANTLY in the preview he is looking at; if
 * the verified build confirms it, the preview patch stays; if
 * verification fails, the patch reverts and he gets a
 * plain-language notice.
 *
 * This module is the server half: a DETERMINISTIC derivation
 * from the turn's already-validated plan (Batch 98) to a small
 * patch spec the portal client applies to the preview iframe
 * through the bridge (public/js/preview-bridge.js). No model
 * calls, no new authority: the spec is built only from plan
 * steps the planner already wrote and the validator already
 * fenced to the design allowlist.
 *
 * The allowlist is the whole security story. A patch op is one
 * of exactly three kinds:
 *   { op: 'text',  from, to }                    — a quoted text swap
 *   { op: 'style', selector, property, value }   — one CSS declaration
 *   { op: 'vars',  vars: { '--ws-primary': … } } — theme colour vars
 * There is NO html op, and there never will be: raw markup is
 * not patchable. The bridge re-validates every field before it
 * touches the DOM (defence in depth), and applies text through
 * textContent only.
 *
 * Tiering (the client renders the treatment):
 *   tier 2 — at least one op derived: the patchable part of the
 *            change previews instantly, badged as unverified.
 *   tier 3 — the plan changes the site but nothing in it is
 *            patchable (new pages, modules, images, structure):
 *            the client shows a skeleton treatment instead of
 *            fake content.
 * A plan with no write steps at all derives null — there is
 * nothing to preview.
 *
 * TRUTH RULE: a patch is a PREVIEW-ONLY provisional render. The
 * real site changes solely through the existing verified paths
 * (in-chat build + Batch 99 reviewer, deliverJob + critic). The
 * verified render always wins any disagreement with the patch.
 */

const MAX_OPS = 12;
const MAX_TEXT_FROM = 240;
const MAX_TEXT_TO = 400;

/** CSS properties a style op may set — the theme.styleRule tool's own list. */
const STYLE_PROPERTIES = new Set([
  'color',
  'background-color',
  'border-color',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'letter-spacing',
  'line-height',
  'text-transform',
  'text-decoration',
  'margin-top',
  'margin-bottom',
  'padding-top',
  'padding-bottom',
]);

/** Theme colour keys a theme.set step may preview as CSS vars. */
const THEME_VAR_BY_KEY = {
  primary: '--ws-primary',
  secondary: '--ws-secondary',
  bg: '--ws-bg',
  text: '--ws-text',
};

const HEX_RE = /^#[\da-f]{6}$/i;
const DANGEROUS_VALUE_RE = /[<>{};]|url\s*\(|expression|javascript:|@import/i;

/**
 * Read-only tool names never make a plan structural. The live
 * set comes from museAgent (single source of truth); the local
 * fallback covers the module being loaded standalone (tests).
 */
const FALLBACK_READONLY = new Set([
  'site.get',
  'site.render',
  'theme.get',
  'pages.structure',
  'modules.list',
  'fonts.list',
]);
function readonlyTools() {
  try {
    const m = require('./museAgent');
    if (m && m.PORTAL_READONLY_TOOLS && m.PORTAL_READONLY_TOOLS.size) return m.PORTAL_READONLY_TOOLS;
  } catch {
    /* standalone load — fallback set */
  }
  return FALLBACK_READONLY;
}

function cleanText(v, cap) {
  const s = String(v == null ? '' : v).trim();
  return s.length <= cap ? s : null;
}

/** Same selector grammar the plan validator enforces (siteChatPlan.cleanSelector). */
function cleanSelector(raw) {
  const s = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!s || /[{}<>;]/.test(s)) return null;
  return s;
}

function cleanStyleValue(raw) {
  const s = String(raw == null ? '' : raw).trim().slice(0, 120);
  if (!s || DANGEROUS_VALUE_RE.test(s)) return null;
  return s;
}

function textOp(step) {
  const args = step.args || {};
  const from = cleanText(args.target, MAX_TEXT_FROM);
  const to = cleanText(args.text, MAX_TEXT_TO);
  if (!from || !to || from === to) return null;
  return { op: 'text', from, to };
}

function styleOp(step) {
  const args = step.args || {};
  if (args.remove) return null; // a removal cannot be previewed by adding a rule
  const selector = cleanSelector(args.selector);
  const property = String(args.property == null ? '' : args.property).trim().toLowerCase();
  const value = cleanStyleValue(args.value);
  if (!selector || !STYLE_PROPERTIES.has(property) || !value) return null;
  return { op: 'style', selector, property, value };
}

function varsOp(step) {
  const args = step.args || {};
  const vars = {};
  for (const [key, varName] of Object.entries(THEME_VAR_BY_KEY)) {
    const v = args[key];
    if (typeof v === 'string' && HEX_RE.test(v.trim())) vars[varName] = v.trim().toLowerCase();
  }
  return Object.keys(vars).length ? { op: 'vars', vars } : null;
}

/**
 * Derive the optimistic patch spec for a validated plan.
 * Returns { v: 1, tier: 2|3, ops: [...], jobId } or null when
 * the plan performs no write at all.
 */
function deriveOptimisticPatch(plan, { jobId = null } = {}) {
  if (!plan || typeof plan !== 'object' || !Array.isArray(plan.steps) || !plan.steps.length) return null;
  const readonly = readonlyTools();
  const ops = [];
  const seenText = new Set();
  let sawWrite = false;
  let sawStructural = false;
  for (const step of plan.steps) {
    if (!step || typeof step !== 'object') continue;
    const tool = String(step.tool || '');
    if (!tool) continue;
    if (tool === 'site.editText') {
      sawWrite = true;
      const op = textOp(step);
      if (op) {
        const key = `${op.from}\n${op.to}`;
        if (!seenText.has(key)) {
          seenText.add(key);
          ops.push(op);
        }
      } else {
        // An editText whose target is a description (not exact
        // text) cannot be grounded in the preview — the change
        // is real but not patchable.
        sawStructural = true;
      }
      continue;
    }
    if (tool === 'theme.styleRule') {
      sawWrite = true;
      const op = styleOp(step);
      if (op) ops.push(op);
      else sawStructural = true;
      continue;
    }
    if (tool === 'theme.set') {
      sawWrite = true;
      const op = varsOp(step);
      if (op) ops.push(op);
      // A fonts-only theme.set previews nothing here; the
      // verified render brings the font. Not structural — the
      // step is still a write, so a colours-less plan of only
      // theme.set steps lands on tier 3 via sawWrite below.
      continue;
    }
    if (readonly.has(tool)) continue;
    // Any other write (structure, modules, images, content
    // collections, logo, publish): real, but not patchable.
    sawWrite = true;
    sawStructural = true;
  }
  if (!sawWrite) return null;
  const capped = ops.slice(0, MAX_OPS);
  return {
    v: 1,
    tier: capped.length ? 2 : 3,
    ops: capped,
    jobId: jobId != null ? Number(jobId) : null,
    // True when part of the change could not be previewed —
    // the client keeps the "verifying" badge until resolution
    // either way; this flag is for honest copy/debugging.
    partial: sawStructural && capped.length > 0,
  };
}

module.exports = { deriveOptimisticPatch, STYLE_PROPERTIES, THEME_VAR_BY_KEY };
