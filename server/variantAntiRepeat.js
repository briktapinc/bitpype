'use strict';

/* ------------------------------------------------------------------ */
/* Batch 190 — ANTI-REPEAT RULE (spec §4a, scoped to Ely's pick        */
/* 2026-11-14: variant waves + anti-repeat).                           */
/*                                                                     */
/* The rule runs over VARIANT SELECTIONS — the per-site ledger of     */
/* which variants each site was delivered with (sectionVariants.      */
/* variantSelectionsForPages / variantPairSet) — never through the    */
/* fingerprint double-match machinery, which treats same-workspace    */
/* sites as same-client and is therefore blind for workspace-1 staff  */
/* builds (templated-layout investigation, 2026-11-14). It applies    */
/* to EVERY workspace, workspace 1 included, and compares a new       */
/* delivery only against sites belonging to OTHER leads.              */
/*                                                                     */
/* Two repeat shapes, checked at design.deliver time on FIRST         */
/* delivery of a website job (re-deliveries and improvement jobs are  */
/* never blocked — restyling an existing site is not a new build):    */
/*                                                                     */
/*   (a) HERO RULE — the candidate's hero variant equals the hero     */
/*       variant of the MOST RECENTLY delivered other-lead site.      */
/*       "Standard" (no variant set) counts: two consecutive          */
/*       all-standard builds repeat, which is exactly the 1HP →       */
/*       Chefmom failure this rule exists to interrupt. A candidate   */
/*       with no hero section cannot fire this rule.                  */
/*   (b) MIX RULE — the candidate's non-empty (type → variant) pair   */
/*       set is exactly equal to any of the last 5 other-lead sites'  */
/*       pair sets.                                                   */
/*                                                                     */
/* A repeat is REFUSED (ANTI_REPEAT) unless the delivery carries a    */
/* recorded need justification — payload.layout_need (or layoutNeed), */
/* a real explanation of why this build needs the repeated layout:    */
/* at least 12 non-space characters and not a speed/convenience       */
/* claim ("faster", "speed", "quick", "easier", "cheaper" — spec §4a: */
/* "it was faster" is not a need). A justified repeat proceeds and    */
/* is recorded on the job's brief (layout_need + anti_repeat facts)   */
/* with a warning on the delivery result.                             */
/* ------------------------------------------------------------------ */

const sectionVariants = require('../src/sectionVariants');

const STOPLIST = ['faster', 'speed', 'quick', 'easier', 'cheaper'];
const RECENT_WINDOW = 5;

function parsePages(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function layoutNeedOf(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const raw = payload.layout_need != null ? payload.layout_need : payload.layoutNeed;
  return typeof raw === 'string' ? raw.trim() : '';
}

/** A justification is a real need: long enough, and not a speed claim. */
function justificationOk(need) {
  if (!need || need.replace(/\s/g, '').length < 12) return false;
  const low = need.toLowerCase();
  return !STOPLIST.some((w) => low.includes(w));
}

function samePairs(a, b) {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

/**
 * Check a candidate delivery against the workspace's other-lead
 * sites. Returns { repeat: null } when the way is clear, or
 * { repeat: { kind, siteId, siteName, heroVariant, mixEqual },
 *   justified, layoutNeed }.
 */
function antiRepeatCheck(db, { leadId, pages, layoutNeed } = {}) {
  const candidate = sectionVariants.variantSelectionsForPages(pages);
  const candPairs = sectionVariants.variantPairSet(pages);
  const rows = db
    .prepare(
      'SELECT id, lead_id, name, pages FROM websites WHERE lead_id IS NOT NULL AND lead_id != ? ORDER BY updated_at DESC, id DESC'
    )
    .all(Number(leadId) || 0);
  const others = rows.map((row) => {
    const otherPages = parsePages(row.pages);
    return {
      siteId: Number(row.id),
      siteName: row.name || '',
      selections: sectionVariants.variantSelectionsForPages(otherPages),
      pairs: sectionVariants.variantPairSet(otherPages),
    };
  });

  let repeat = null;
  if (candidate.heroVariant != null && others.length) {
    const latest = others[0];
    if (latest.selections.heroVariant === candidate.heroVariant) {
      repeat = {
        kind: 'hero',
        siteId: latest.siteId,
        siteName: latest.siteName,
        heroVariant: candidate.heroVariant,
        mixEqual: candPairs.length > 0 && samePairs(candPairs, latest.pairs),
      };
    }
  }
  if (!repeat && candPairs.length) {
    for (const other of others.slice(0, RECENT_WINDOW)) {
      if (samePairs(candPairs, other.pairs)) {
        repeat = {
          kind: 'mix',
          siteId: other.siteId,
          siteName: other.siteName,
          heroVariant: candidate.heroVariant,
          mixEqual: true,
        };
        break;
      }
    }
  }
  if (!repeat) return { repeat: null, justified: false, layoutNeed: '' };
  const need = typeof layoutNeed === 'string' ? layoutNeed.trim() : '';
  return { repeat, justified: justificationOk(need), layoutNeed: need };
}

/** The refusal message: names the repeat, the site, and the remedy. */
function antiRepeatMessage(repeat) {
  const what =
    repeat.kind === 'hero'
      ? `hero variant "${repeat.heroVariant}"`
      : `variant mix (${repeat.heroVariant ? `hero "${repeat.heroVariant}", ` : ''}identical (type → variant) set)`;
  return (
    `Anti-repeat: this build repeats the ${what} of the most recent comparable build — website ${repeat.siteId} ("${repeat.siteName}"). ` +
    'Pick a different hero variant (design.variants lists the registry) or a different variant mix, ' +
    'or re-deliver with layout_need explaining the genuine need for this layout (a client/brand requirement — not speed or convenience).'
  );
}

module.exports = { antiRepeatCheck, antiRepeatMessage, layoutNeedOf, justificationOk, RECENT_WINDOW };
