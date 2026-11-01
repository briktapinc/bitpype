'use strict';

/**
 * Batch 111 (consolidation step 4) — the design-chat intent classifier (Batch 98): prompt builder, keyword fallback, classifyPortalChatIntent.
 * PURE code motion from server/museAgent.js (no logic edits, no
 * prompt-text changes); server/museAgent.js re-exports the full
 * original surface.
 */

const chatPlanner = require('./siteChatPlanner');
const { getDbSetting, resolveMuseConfig, museConfigured, todaySpendUsd, providerForConfig, logUsage, chatCompletions } = require('./museAgentCore');

const PORTAL_INTENTS = new Set(['question', 'change', 'offtopic', 'ambiguous', 'clarify_answer', 'cancel']);

function portalIntentFallback(pending) {
  // Classification failed (endpoint error / unparseable reply). Never
  // fall back to editing: with a pending change, treat the message as
  // another clarification answer that is not yet sufficient; without
  // one, ask the either/or question. Both paths are read-only.
  return {
    intent: pending ? 'clarify_answer' : 'ambiguous',
    ready: false,
    size: 'small',
    borderline: false,
    settled: [],
    newAmbiguity: false,
    fallback: true,
  };
}

function buildClassifierSystemPrompt(pending, hasImages) {
  const lines = [
    'You are the router for a website design agent chat. The speaker is a business owner talking to the design agent that maintains THEIR OWN website inside their site builder. Decide what their latest message is, so the agent can respond correctly.',
    'Reply with ONLY a JSON object (no prose, no code fences): {"intent": "...", "ready": true|false, "size": "small"|"big", "borderline": true|false, "settled": ["..."], "new_ambiguity": true|false}',
    '',
    'INTENTS:',
    '- "question" — the owner asks something about their website, its design or content, or asks for design advice for the site ("why does my header look empty?", "what colours suit a bakery?", "what does my services page say?", "what do you think of this logo?"). No change is being requested.',
    '- "change" — the owner asks for a modification to the site.',
    '- "ambiguous" — the message could be a comment/question OR a change request; it is genuinely unclear whether they want anything done ("the blue looks bad", "the header feels empty").',
    '- "offtopic" — unrelated to their website, its content, or design (weather, news, trivia, jokes, other topics). Questions about what their site should SAY or how it should look are "question", never offtopic.',
    '',
    'PRIORITY RULES:',
    '- A message phrased as a question seeking information about the site (what / why / which / how / when / is there / can you tell me, or ending in "?") is ALWAYS "question" — never "ambiguous", never "change" — unless it explicitly asks for something to be changed ("can you change…", "could you make…", "please add…"). Asking what the headline IS is a question; asking to change it is a change.',
    '- "ambiguous" is ONLY for short statements of opinion or feeling about the site that neither ask a question nor request anything ("the blue looks bad", "the header feels empty", "not sure about the font"). If they asked something, it is a question; if they asked FOR something, it is a change.',
    '',
    // The doctrine itself lives in the PLANNER module
    // (server/siteChatPlanner.js) as data — this prompt consumes
    // it verbatim so the rebuild's planner keeps one copy.
    ...chatPlanner.CLASSIFIER_DOCTRINE_LINES,
  ];
  if (pending) {
    lines.push(
      '- "clarify_answer" — a change is pending clarification (below) and this message answers those questions or adds detail to that pending change.',
      '- "cancel" — the owner wants to drop the pending change and do nothing else.',
      'When a change is pending, a reply that answers the agent\'s questions or adds detail to that pending change is "clarify_answer". A message that clearly starts a DIFFERENT new change is "change" (it replaces the pending one). A side question while one is pending is "question".',
      'EXCEPTION: if the pending "original request" was itself a question or a comment rather than a change request, it is not a real pending change — judge this message on its own: a concrete change instruction is a fresh "change", a question is a "question".',
      'READINESS WITH A PENDING OPEN: judge readiness against the most concrete instruction on the table, NOT against the pending questions. If the latest message — alone or with the earlier answers — contains a complete instruction (a named target plus the new value or change to make), ready=true, even if the pending clarification asked different questions that remain unanswered. An unanswered goal question ("what is the main goal?", "who is it for?") NEVER blocks a concrete edit the owner has spelled out.',
      'TERSE REPLIES ARE ANSWERS: short imperatives and confirmations ("just make them black", "yes", "do it", "go ahead", "the darker one") are the owner being satisfied — they settle the dimension(s) they address, and with the defaults covering the rest that is "clarify_answer" with ready=true. Short assertions about the current state ("they are not", "still not black", "it didn\'t change") are corrections meaning "proceed / fix it" — also "clarify_answer" with ready=true for the pending change, not a new vague request.',
      '',
      'PENDING CHANGE awaiting clarification:',
      `Original request: "${String(pending.requestText || '').slice(0, 600)}"`
    );
    if (pending.kind === 'either_or') {
      lines.push(
        'The agent asked ONE question: do they want that changed, or were they just asking/commenting? This message is their response — if they confirm the change, that is "clarify_answer" (judge ready/size for the original request); if they were just asking, that is "question".'
      );
    } else if (pending.questionsText) {
      lines.push(`Questions the agent asked: "${String(pending.questionsText).slice(0, 900)}"`);
    }
    const answers = Array.isArray(pending.answers) ? pending.answers : [];
    if (answers.length) {
      lines.push(`Owner's answers so far: ${answers.map((a) => `"${String(a).slice(0, 300)}"`).join(' | ')}`);
    }
    const settled = Array.isArray(pending.settled) ? pending.settled : [];
    if (settled.length) {
      lines.push(
        `SETTLED for this change — already decided by the owner; treat as final, never as still open: ${settled
          .map((s) => `"${String(s).slice(0, 200)}"`)
          .join(' · ')}`
      );
    }
    const rounds = Number(pending.rounds) || 0;
    if (rounds > 0) {
      lines.push(
        `Clarification rounds already used for this change: ${rounds}. Policy: ONE round is the budget — after it, gaps are filled by the defaults and the change is implemented. So a reply that answers the questions AT ALL is ready=true, unless it introduces a genuinely new decision that has no default (then ready=false and new_ambiguity=true).`
      );
    }
  }
  lines.push(
    '',
    'READY (only meaningful for intent "change" and "clarify_answer"): true when a competent designer who can see the whole site could implement the request — together with any pending request, settled facts, and earlier answers — without guessing a decision that changes WHAT gets built. The DEFAULTS DOCTRINE covers the rest: exact shade, scope already stated, font preservation on a colour change, dark-section readability, and palette tones are NEVER reasons for ready=false. A concrete target plus a concrete new value (a replacement headline, a colour, a phone number, a specific instruction about a named element) is ALWAYS ready=true, and so is a named property plus a direction ("entire site, H3s darker" — the defaults pin the shade). ready=false is ONLY for a genuinely missing decision with no default: which page or section when it is unstated AND matters, what brand-new content should say, which of several materially different directions, or what a new element should do / where it goes ("add a booking button" with no hint of where or what it books). Vague directions with no specifics at all ("make it pop", "improve the homepage", "make it more professional") are ready=false. Once the owner has supplied the missing specifics in a follow-up, ready=true — do not keep a clarification alive out of caution. For BIG jobs the bar is lower, not higher: the design agent refines details in the queue, so once the scope is named (which pages or areas, what to add or restructure) ready=true even if style details are still open — do not hold a big job in clarification over taste details the design agent can decide.',
    '',
    'SETTLED (output): list the short facts THIS message settles for the change, as "dimension: value" strings — including anything the owner states outright (stated scope, a chosen colour, a page named). Examples: "scope: entire site", "H3 colour: black #000000", "target page: services". Empty array when the message settles nothing new.',
    'NEW_AMBIGUITY (output): true ONLY when this message introduces a brand-new material decision that was not part of the request so far and has no default (rare). Changing one\'s mind, answering tersely, or correcting the current state is NOT new ambiguity.',
    '',
    'SIZE (judge only when ready=true, and judge the FINAL clarified request):',
    '- "small": a single spot, well-scoped — one text/copy edit, swapping one image, changing one link, a colour or style tweak on one element, one heading or button. A single global style value (one heading colour for the whole site) is still "small" — one tweak, applied in one place. A per-element style rule (e.g. "change all H3s to dark grey") is "small" too — the style-rule tool applies it in-chat; never size it "big" and never treat it as undoable for lack of tools.',
    '- "big": spans multiple sections or pages, restructures a layout, adds a new page, sets up a new module or feature, or is a broad redesign ("redo the homepage", "give the site a modern look").',
    '- "borderline": true when the size call is genuinely debatable; otherwise false.'
  );
  if (hasImages) {
    lines.push(
      '',
      'The owner attached image(s) to this message. If there is no text, the message is only about the image(s): with no instruction at all it is "change" with ready=false (the agent will ask what to do with them). Text asking for an opinion of an image ("what do you think of this logo?") is a "question".'
    );
  }
  return lines.join('\n');
}

/**
 * Batch 93 — classify one portal chat message (question / change /
 * off-topic / ambiguous / clarification answer / cancel), with the
 * request's readiness and — once ready — its size (small = the chat
 * implements it; big = queue to the design agent). Batch 94: the
 * result also carries the dimensions this message SETTLES (short
 * "dimension: value" facts, persisted on the pending change and
 * never re-asked) and newAmbiguity (the message introduced a fresh
 * decision with no default — the only excuse for a second
 * clarification round). One tool-less model call; the caller
 * routes on the result. Returns
 * { intent, ready, size, borderline, settled, newAmbiguity,
 *   fallback } or
 * { error: 'muse_not_configured' | 'budget_exceeded' }.
 */
/**
 * @param {any} workspaceId
 * @param {any} leadId
 * @param {{ db?: any, message?: string, history?: any[], pending?: any, hasImages?: boolean, siteContext?: string }} [opts]
 */
async function classifyPortalChatIntent(
  workspaceId,
  leadId,
  { db, message, history, pending, hasImages, siteContext } = {}
) {
  const domain = require('./domain');
  const lid = Number(leadId);
  const config = await domain.withDb(workspaceId, async (d) => resolveMuseConfig(db || d));
  if (!museConfigured(config)) return { error: 'muse_not_configured', intent: null };
  const { budget, spent } = domain.withDb(workspaceId, (d) => {
    const use = db || d;
    return {
      budget: parseFloat(getDbSetting(use, 'cost.daily_budget_usd', '10')) || 0,
      spent: todaySpendUsd(use),
    };
  });
  if (budget > 0 && spent >= budget) return { error: 'budget_exceeded', intent: null };

  const convo = [];
  const list = Array.isArray(history) ? history.slice(-6) : [];
  for (const row of list) {
    if (!row || (row.role !== 'user' && row.role !== 'assistant')) continue;
    const content = String(row.content || '').trim();
    if (content) convo.push({ role: row.role, content: content.slice(0, 1500) });
  }
  const text = String(message || '').trim();
  convo.push({
    role: 'user',
    content: text || `(The owner attached image(s) with no written message.)`,
  });

  // Tier 1 site context (capped tighter here — routing needs the
  // lay of the land, not the full map) grounds intent + size calls.
  const classifyMessages = [
    { role: 'system', content: buildClassifierSystemPrompt(pending, !!hasImages) },
  ];
  if (siteContext) {
    classifyMessages.push({
      role: 'system',
      content: `SITE CONTEXT (the owner's whole site, summary):\n${String(siteContext).slice(0, 4000)}`,
    });
  }
  classifyMessages.push(...convo);

  // The live model is a reasoning model: on messages it deliberates
  // over, hidden reasoning can consume the entire token budget and
  // return finish_reason 'length' with NO content at all (proven
  // live 2026-10-30: a plain question burned 298 of 300 tokens on
  // reasoning, the JSON never arrived, and routing silently degraded
  // to the fallback — every message looked "ambiguous"). Budget for
  // reasoning + answer, and retry once, bigger, on truncation/empty.
  let data = null;
  let parsed = null;
  for (const maxTokens of [1200, 2400]) {
    data = null;
    parsed = null;
    try {
      data = await chatCompletions(config, {
        model: config.model,
        messages: classifyMessages,
        max_tokens: maxTokens,
      });
    } catch {
      return portalIntentFallback(pending);
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
        provider: providerForConfig(config),
        model: config.model,
        promptTokens,
        completionTokens,
        costUsd: (promptTokens / 1000) * per1kPrompt + (completionTokens / 1000) * per1kCompletion,
        leadId: lid,
        note: 'portal classify',
      });
    });
  } catch {
      /* usage logging must never break routing */
    }

    let raw = '';
    let finishReason = '';
    try {
      const choice = data && data.choices && data.choices[0];
      raw = String((choice && choice.message && choice.message.content) || '');
      finishReason = String((choice && choice.finish_reason) || '');
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) parsed = JSON.parse(match[0]);
    } catch {
      parsed = null;
    }
    if (parsed && PORTAL_INTENTS.has(String(parsed.intent || ''))) break;
    // Retry only when the answer never arrived (reasoning ate the
    // budget / empty content); a genuine non-JSON answer falls back.
    if (finishReason !== 'length' && raw.trim()) break;
    parsed = null;
  }
  if (!parsed || !PORTAL_INTENTS.has(String(parsed.intent || ''))) {
    return portalIntentFallback(pending);
  }
  let intent = String(parsed.intent);
  const ready = parsed.ready === true;
  // clarify_answer / cancel are meaningless with nothing pending.
  if (!pending && intent === 'clarify_answer') intent = 'change';
  if (!pending && intent === 'cancel') intent = 'ambiguous';
  const settled = Array.isArray(parsed.settled)
    ? parsed.settled
        .map((s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 200))
        .filter(Boolean)
        .slice(0, 12)
    : [];
  return {
    intent,
    ready,
    size: parsed.size === 'big' ? 'big' : 'small',
    borderline: parsed.borderline === true,
    settled,
    newAmbiguity: parsed.new_ambiguity === true,
    fallback: false,
  };
}

/**
 * Batch 98 — THE PLANNER (four-role rebuild, step 1). The
 * classifier above remains the routing front-end (intent /
 * readiness / size hypothesis, budget-pinned in Batch 96); once
 * a change is READY, this upgraded planner call writes the
 * explicit plan object the rest of the system executes and
 * verifies: scope, settled facts, defaults applied, ordered
 * steps (design-allowlist tools only), and mechanical verify[]
 * checks. The plan is persisted by the caller
 * (server/siteChatPlan.js) — for a big job it IS the queued
 * spec; for a small one it sandboxes the implementor.
 */

module.exports = {
  buildClassifierSystemPrompt,
  classifyPortalChatIntent,
};
