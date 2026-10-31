'use strict';

/**
 * PLANNER module for the portal design chat (Batch 94).
 *
 * Ely's direction (2026-10-30): the chat is being rebuilt as a
 * four-role system — planner / implementor / critic / reviewer.
 * This module is the planner's policy core, kept free of the chat
 * loop so the rebuild can lift it whole:
 *  - the DEFAULTS DOCTRINE as canonical text (the classifier,
 *    clarify and build prompts all consume these constants —
 *    they do not own their own copies);
 *  - named-colour resolution ("dark grey" → the site's dark
 *    neutral or a standard hex — never a question to the owner);
 *  - the CONVERGENCE policy (shouldForceReady): after ONE
 *    clarification round, a substantive answer implements with
 *    defaults — a second round exists only for a genuinely NEW
 *    ambiguity the answer itself introduced.
 * Settled-dimension STATE lives in server/siteChatPending.js
 * (the planner's store); the style capability the planner routes
 * small jobs to lives in server/styleRules.js (implementor).
 */

const { normalizeHex } = require('./styleRules');

/** Clarification rounds a change gets before answers implement. */
const CONVERGENCE_ROUNDS = 1;

/** Reply intents that count as "answering the pending change". */
const FORCE_READY_INTENTS = new Set(['clarify_answer', 'change', 'ambiguous']);

/**
 * The convergence seam's policy: a pending clarification that has
 * already used its round budget ends NOW — the latest reply is
 * treated as the answer, remaining gaps take defaults — unless
 * the classifier flagged a genuinely new ambiguity that the
 * answer introduced (newAmbiguity), in which case ONE more round
 * may ask about that new thing only.
 *
 * Either/or pendings are covered from the start: the either/or
 * question ("change it, or just asking?") IS the one round, so
 * any substantive reply resolves it. (Caught live in the Batch 94
 * proof: an either/or pending for "change all h3 to dark grey"
 * converted into an open clarify round, and the owner's NEXT,
 * unrelated request was then absorbed into the stuck pending.)
 * Questions, cancels and off-topic replies never force — those
 * branches run before the seam and are not in the intent set.
 */
function shouldForceReady(pending, cls) {
  if (!pending || !cls || cls.newAmbiguity) return false;
  if (!FORCE_READY_INTENTS.has(cls.intent)) return false;
  if (pending.kind === 'either_or') return true;
  return pending.kind === 'clarify' && Number(pending.rounds || 0) >= CONVERGENCE_ROUNDS;
}

const CLASSIFIER_DOCTRINE_LINES = [
  'DEFAULTS DOCTRINE — the agent is a designer, not a form. It applies sensible defaults instead of interrogating the owner, and states them afterwards:',
  '- Scope the owner stated is SETTLED: "entire site" means all pages, "on the homepage" means the homepage. Stated scope never blocks readiness and is never asked about again.',
  '- A colour-only request changes only the colour. Font, size, and weight staying the same is the DEFAULT — never a question, never a blocker.',
  '- Contrast is a RULE, never a question: headings and text on dark sections always stay light enough to read. Never ask whether dark-section headings should also go dark.',
  '- "black" or "darker" for headings/text on light backgrounds means pure black #000000 by default.',
  '- A named colour is a COMPLETE instruction: "dark grey" resolves to the site\'s own dark neutral tone (its ink/secondary in the site context) or standard dark grey #444444; "cream" is the site\'s paper tone. Never ask the owner which hex they want, and never treat a named colour as underspecified.',
  '- When any other tone is needed (e.g. a cream for dark sections), the agent uses the site\'s OWN existing tone from the site context (its paper / cream colour). Never ask the owner to choose between hex codes — picking the exact tone is the agent\'s job.',
  '- Any remaining matter of taste or polish (exact spacing, shade nuance) is the designer\'s call and does NOT block readiness.',
];

const CLARIFY_DEFAULTS_LINE =
  'DEFAULTS — never ask about these, they are already decided: a colour-only change keeps the same font, size, and weight; scope the owner already stated is the scope; headings/text on dark sections always stay light enough to read; "black"/"darker" on light backgrounds means pure black #000000; a named colour ("dark grey", "cream") resolves to the site\'s own matching tone or the standard hex — never ask the owner to pick between hex codes, and never re-ask a question from an earlier round in new words.';

const BUILD_DEFAULTS_LINE =
  'Design defaults — apply these without asking: a colour-only change touches colour only (font, size, weight unchanged); scope the owner stated ("entire site", "on the homepage") is the scope; headings and text on dark sections stay light enough to read — never darken them into a dark background; "black" / "darker" on light backgrounds means pure black #000000; a named colour resolves to a concrete hex before you apply it — "dark grey" is the site\'s dark neutral (secondary/ink from the site context or theme) or standard #444444, "cream" is the site\'s own paper tone from the site context or theme — apply the hex and NAME it in your summary (e.g. "made all H3s dark grey #444444"); when a light tone is needed on dark sections, use the site\'s own existing paper/cream colour from the site context or theme.';

const BUILD_DISCLOSURE_LINE =
  'When finished, stop calling tools and reply in 1–3 short plain-English sentences summarizing what you changed (or why you could not). When you applied any design default, end the summary with one short "Defaults applied: …" line naming them (e.g. "Defaults applied: H3s pure black on light sections across all pages; dark sections keep the site\'s light cream so they stay readable; fonts unchanged.") so the owner can correct a default afterwards if it is not what they wanted.';

function hexLuminance(hex) {
  const h = normalizeHex(hex);
  if (!h) return null;
  const chan = (i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * chan(1) + 0.7152 * chan(3) + 0.0722 * chan(5);
}

function themeTone(theme, keys) {
  if (!theme || typeof theme !== 'object') return null;
  for (const key of keys) {
    const hex = normalizeHex(theme[key]);
    if (hex) return hex;
  }
  return null;
}

/**
 * Resolve a colour the owner NAMED to a concrete hex.
 * Site tones win when they fit (a dark neutral for "dark grey",
 * a light paper for "cream"); otherwise a standard hex. Returns
 * { hex, source: 'site' | 'standard' } or null for names outside
 * the table (the caller then treats the colour as unspecified,
 * not as a question — the defaults still apply).
 */
function resolveNamedColour(rawName, theme = {}) {
  const key = String(rawName == null ? '' : rawName).toLowerCase().trim().replace(/\s+/g, ' ');
  if (!key) return null;
  if (key === 'black' || key === 'pure black') return { hex: '#000000', source: 'standard' };
  if (key === 'white' || key === 'pure white') return { hex: '#ffffff', source: 'standard' };
  if (key === 'dark grey' || key === 'dark gray') {
    const tone = themeTone(theme, ['ink', 'secondary', 'text']);
    if (tone && hexLuminance(tone) != null && hexLuminance(tone) < 0.35) return { hex: tone, source: 'site' };
    return { hex: '#444444', source: 'standard' };
  }
  if (key === 'grey' || key === 'gray') return { hex: '#808080', source: 'standard' };
  if (key === 'light grey' || key === 'light gray') return { hex: '#d9d9d9', source: 'standard' };
  if (key === 'cream' || key === 'light cream' || key === 'off-white' || key === 'off white') {
    const tone = themeTone(theme, ['paper', 'bg', 'background', 'bgColor']);
    if (tone && hexLuminance(tone) != null && hexLuminance(tone) > 0.6) return { hex: tone, source: 'site' };
    return { hex: '#f6f6f4', source: 'standard' };
  }
  return null;
}

module.exports = {
  CONVERGENCE_ROUNDS,
  FORCE_READY_INTENTS,
  shouldForceReady,
  CLASSIFIER_DOCTRINE_LINES,
  CLARIFY_DEFAULTS_LINE,
  BUILD_DEFAULTS_LINE,
  BUILD_DISCLOSURE_LINE,
  hexLuminance,
  resolveNamedColour,
};
