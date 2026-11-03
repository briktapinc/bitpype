// @ts-check
'use strict';

/**
 * Batch 111 (consolidation step 4) — the design-chat planner (Batch 98): prompt builder + planPortalChange.
 * PURE code motion from server/museAgent.js (no logic edits, no
 * prompt-text changes); server/museAgent.js re-exports the full
 * original surface.
 */

const chatPlanner = require('./siteChatPlanner');
const { PORTAL_DESIGN_WRITE_TOOLS, PORTAL_DESIGN_TOOLS } = require('./museAgentTools');
const { fail, getDbSetting, resolveAgentConfig, museConfigured, todaySpendUsd, servedProviderFor, servedModelFor, withFailoverNote, logUsage, chatCompletionsRouted } = require('./museAgentCore');

/**
 * @param {{ settled?: any, hasImages?: boolean, rework?: any }} [opts]
 */
function buildPlannerSystemPrompt({ settled, hasImages, rework } = {}) {
  const lines = [
    'You are the PLANNER in a four-role website design system (Planner → Implementor → Critic → Reviewer). You never edit anything yourself. You read the owner\'s request, the settled facts, and the whole-site context — which includes the site\'s CURRENT computed styles — and you emit ONE explicit plan as JSON. An implementor will execute exactly your steps, no more and no less, and a critic will then mechanically verify your verify checks against the rendered site.',
    'Reply with ONLY a JSON object (no prose, no code fences): {"scope":{"pages":["all"],"sections":null},"settled":["dimension: value"],"defaultsApplied":["..."],"steps":[{"tool":"theme.styleRule","args":{"selector":"h3","property":"color","value":"#444444"},"expect":"every H3 computes to #444444 on light sections"}],"verify":[{"kind":"computedStyle","selector":"h3","property":"color","equals":"#444444","where":"light"}],"size":"small"}',
    '',
    ...chatPlanner.CLASSIFIER_DOCTRINE_LINES,
    '',
    'STEP RULES:',
    `- Steps may use ONLY these tools: ${[...PORTAL_DESIGN_WRITE_TOOLS].join(', ')}. Read tools (site.get, site.render, theme.get, pages.structure and the content list/get tools) are always available to the implementor for grounding — do not spend steps on them.`,
    '- Keep steps minimal, ordered and complete: one step per tool action. A whole-site element style change is ONE theme.styleRule step. A new page is a pages.structure.update step; a module is a modules.attach step.',
    '- Resolve everything to concrete values inside the steps: named colours become hexes (per the doctrine), replacement text is written out in full. For site.editText use args {"text": "<the exact new text>", "target": "<the current text or a precise description of the element>"} — the implementor grounds the exact edit id from the render.',
    '- expect: the observable outcome of the step, one short phrase.',
    '',
    'VERIFY RULES — the critic checks these mechanically against the rendered site, so write checks that can genuinely pass or fail:',
    '- For a colour/style change: one computedStyle check per distinct outcome — selector + property + the EXACT equals value (a hex for colours), with "where": "light" or "dark" when the contrast rule splits the outcome (dark headings on light sections AND the site\'s light tone kept on dark sections = TWO checks).',
    '- For a text/content change: a presence check carrying the exact new text.',
    '- Never write a check for something your steps do not change.',
    '',
    'SIZE: "small" = one spot, or one global style value applied in one place (a per-element style rule is always small). "big" = spans multiple sections or pages, restructures a layout, adds a new page, sets up a new module or feature, or is a broad redesign.',
    'SETTLED (output): carry through every settled fact you are given, plus any new fact this request settles, as "dimension: value" strings.',
    'DEFAULTS APPLIED (output): name every default you used to fill a gap — the owner reads these afterwards and can correct them.',
  ];
  const settledList = Array.isArray(settled) ? settled.filter(Boolean) : [];
  if (settledList.length) {
    lines.push(
      '',
      `SETTLED FACTS — already decided by the owner; binding, never re-decide them: ${settledList.map((s) => `"${String(s).slice(0, 200)}"`).join(' · ')}`
    );
  }
  if (rework && Array.isArray(rework.failures) && rework.failures.length) {
    lines.push(
      '',
      'REWORK: a previous attempt at this change FAILED verification. The critic measured the rendered site — its findings are ground truth, not opinion:',
      ...rework.failures.map((f) => `- ${String(f).slice(0, 300)}`),
      'Write a CORRECTED plan that makes the verify checks pass this time. Do not repeat a step that already produced the wrong result unchanged.'
    );
  }
  if (hasImages) {
    lines.push(
      '',
      'The owner attached image(s) to this request — they are part of the user message. Plan from what they show (a photo to place, colours/branding to match, a logo to set) using the tools above.'
    );
  }
  return lines.join('\n');
}

/**
 * Run the planner for one READY portal chat change. Returns
 * { plan } with the validated plan object (server/siteChatPlan
 * semantics: any step outside the design allowlist invalidates
 * the whole plan), { plan: null } when the model produced no
 * usable plan (the caller falls back to an unplanned — but
 * still allowlist-sandboxed — implementation), or
 * { error: 'muse_not_configured' | 'budget_exceeded' }.
 * The token-budget loop mirrors the classifier's pinned
 * discipline: the model reasons, so a truncated first attempt
 * retries once at the larger budget.
 */
/**
 * @param {any} workspaceId
 * @param {any} leadId
 * @param {{ db?: any, message?: string, specText?: string, history?: any[], settled?: any, siteContext?: string, images?: any[], rework?: any }} [opts]
 */
async function planPortalChange(
  workspaceId,
  leadId,
  { db, message, specText, history, settled, siteContext, images, rework } = {}
) {
  const domain = require('./domain');
  const chatPlan = require('./siteChatPlan');
  const lid = Number(leadId);
  const config = await domain.withDb(workspaceId, async (d) => resolveAgentConfig(db || d, 'design_chat'));
  if (!museConfigured(config)) return { error: 'muse_not_configured', plan: null };
  const { budget, spent } = domain.withDb(workspaceId, (d) => {
    const use = db || d;
    return {
      budget: parseFloat(getDbSetting(use, 'cost.daily_budget_usd', '10')) || 0,
      spent: todaySpendUsd(use),
    };
  });
  if (budget > 0 && spent >= budget) return { error: 'budget_exceeded', plan: null };

  const convo = [];
  const list = Array.isArray(history) ? history.slice(-6) : [];
  for (const row of list) {
    if (!row || (row.role !== 'user' && row.role !== 'assistant')) continue;
    const content = String(row.content || '').trim();
    if (content) convo.push({ role: row.role, content: content.slice(0, 1500) });
  }
  const spec = String(specText || message || '').trim();
  const imgs = (Array.isArray(images) ? images : []).filter((im) => im && im.dataUrl);
  const requestText =
    spec || '(The owner attached image(s) with no written message — plan what the image(s) most clearly call for.)';
  convo.push({
    role: 'user',
    content: imgs.length
      ? [
          { type: 'text', text: `${requestText}\n\n[Attached image(s) are part of this request.]` },
          ...imgs.map((im) => ({ type: 'image_url', image_url: { url: im.dataUrl } })),
        ]
      : requestText,
  });

  /** @type {Array<{ role: string, content: any }>} */
  const planMessages = [
    { role: 'system', content: buildPlannerSystemPrompt({ settled, hasImages: imgs.length > 0, rework }) },
  ];
  if (siteContext) {
    planMessages.push({
      role: 'system',
      content: `SITE CONTEXT (the owner's whole site, including current computed styles):\n${String(siteContext).slice(0, 8000)}`,
    });
  }
  planMessages.push(...convo);

  let plan = null;
  // The planner's ladder is deliberately larger than the
  // classifier's pinned [1200, 2400]: a plan is a much bigger
  // emission (steps with full args + verify + settled +
  // defaults), and the reasoning model spends heavily before
  // writing. Measured live (2026-10-31): the wedding-tastings
  // plan burned 1200 AND 2400 entirely on reasoning with an
  // empty completion; at [2400, 4800] it landed only sometimes
  // (3225 completion tokens on a short-history turn) and still
  // truncated at 4800 when the turn carried a longer history —
  // reasoning spend is stochastic and grows with context. The
  // ladder is [4800, 8000]: ~2.5x headroom over the worst
  // observed completion. A too-small ladder silently degrades
  // every non-trivial change to unplanned.
  for (const maxTokens of [4800, 8000]) {
    let data = null;
    let raw = '';
    let finishReason = '';
    try {
      data = await chatCompletionsRouted(config, {
        model: config.model,
        messages: planMessages,
        max_tokens: maxTokens,
      });
    } catch {
      return { plan: null, error: 'request_failed' };
    }
    try {
      const usage = (data && data.usage) || {};
      domain.withDb(workspaceId, (d) => {
        const use = db || d;
        const promptTokens = Number(usage.prompt_tokens) || 0;
        const completionTokens = Number(usage.completion_tokens) || 0;
        const per1kPrompt = parseFloat(getDbSetting(use, 'cost.per_1k_prompt', '0.0015')) || 0;
        const per1kCompletion = parseFloat(getDbSetting(use, 'cost.per_1k_completion', '0.002')) || 0;
        logUsage(use, {
          task: 'portal_agent',
          provider: servedProviderFor(config),
          model: servedModelFor(config),
          promptTokens,
          completionTokens,
          costUsd: (promptTokens / 1000) * per1kPrompt + (completionTokens / 1000) * per1kCompletion,
          leadId: lid,
          note: withFailoverNote(config, 'portal plan'),
        });
      });
    } catch {
      /* usage logging must never break planning */
    }
    try {
      const choice = data && data.choices && data.choices[0];
      raw = String((choice && choice.message && choice.message.content) || '');
      finishReason = String((choice && choice.finish_reason) || '');
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        plan = chatPlan.validatePlan(parsed, PORTAL_DESIGN_TOOLS);
      }
    } catch {
      plan = null;
    }
    if (plan) break;
    // Retry only when the answer never really arrived (reasoning
    // ate the budget); a complete-but-invalid plan is a planning
    // miss, not a truncation — the caller falls back.
    if (finishReason !== 'length' && raw.trim()) break;
    plan = null;
  }
  return { plan };
}


module.exports = {
  buildPlannerSystemPrompt,
  planPortalChange,
};
