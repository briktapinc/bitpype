// @ts-check
'use strict';

/**
 * Batch 117 — WordPress design chat: the four-role flow, keyed to
 * ONE wp_site_links registration.
 *
 *   PLANNER     — classifies the turn from the site census:
 *                 a question (answered read-only, planner only),
 *                 ONE clarification round at most, or a change plan.
 *   IMPLEMENTOR — turns a plan into ops from the allowlist in
 *                 server/wpDesignOps.js, and nothing else. Ops are
 *                 validated mechanically; model-invented ops are
 *                 dropped WITH disclosure, never silently staged.
 *   CRITIC      — verifies the STAGED PREVIEW, never the
 *                 implementor's say-so: it fetches the preview URL
 *                 (staged state) and the public page (live state)
 *                 and checks the staged CSS/zones are present in
 *                 the preview and absent from the public page.
 *                 One bounded rework is allowed when the critic
 *                 checked and failed.
 *   REVIEWER    — gates the outgoing reply: the change list in the
 *                 reply is rendered from the ops ACTUALLY staged
 *                 (describeOp), the critic's verdict is disclosed
 *                 verbatim in substance, and the reply always says
 *                 nothing is live until the owner approves.
 *
 * Approve-first is absolute: a chat turn can only STAGE a proposal
 * (wpDesign.stageProposal). Applying happens solely through the
 * owner's Approve click + the plugin's own apply/report cycle.
 *
 * Model failure at any step fails the whole turn gracefully with
 * the same words the BitPype-site chat uses; no proposal is
 * staged and no transcript entry is written for the failed turn.
 */

const wpPlugin = require('./wpPlugin');
const wpDesign = require('./wpDesign');
const ops = require('./wpDesignOps');
const core = require('./museAgentCore');

const MODEL_FAIL_TEXT = 'The AI could not answer just now. No website changes were saved.';
const MAX_MESSAGE = 4000;

function fail(code, message, status) {
  const e = /** @type {Error & { code?: string, status?: number }} */ (new Error(message));
  e.code = code;
  if (status) e.status = status;
  return e;
}

const PLANNER_SYSTEM = [
  'You are the planner for the BitPype design chat of ONE WordPress website.',
  "You never edit anything yourself. You classify the owner's message into exactly one kind:",
  '- "question": a question about the site. Answer it from the site map only, in the "answer" field. Never invent facts the map does not contain.',
  '- "clarify": a design request too ambiguous to plan safely. Ask ONE short question in the "question" field. Clarifying is allowed at most once in a row; if "clarification already asked" is true, you must NOT clarify again — produce a change plan using the settled facts.',
  '- "change": a design request you can plan. Fill "plan.summary" (one sentence) and "plan.details" (the concrete design decisions: which tokens/zones change, to what).',
  'What design changes can ever do on this site (v1): change the global look (colors, fonts, base font size, corner radius) and add/update/remove BitPype sections (banner, hero, call-to-action) that the BitPype plugin renders. They can NEVER edit page content, posts, menus, theme files, other plugins, or checkout/shop pages. If the owner asks for something outside that list, classify as "question" and explain the limit honestly in "answer", offering the closest in-scope alternative when one exists.',
  'Every approved change is a PROPOSAL the owner previews and approves before anything goes live — word your plan accordingly (never promise instant changes).',
  'Respond with ONE JSON object only: {"kind":"question","answer":"..."} or {"kind":"clarify","question":"..."} or {"kind":"change","plan":{"summary":"...","details":"..."}}.',
].join('\n');

function implementorSystem() {
  return [
    'You are the implementor for the BitPype design chat of ONE WordPress website.',
    'Turn the given plan into a list of machine ops. Output ONE JSON object only: {"ops":[...],"summary":"one plain sentence for the owner"}.',
    'Allowed ops — anything else is refused by the system:',
    '- {"type":"set_token","token":<token>,"value":<value>} and {"type":"remove_token","token":<token>} (remove = back to the theme default).',
    `  Color tokens (value = #rrggbb hex): ${ops.COLOR_TOKENS.join(', ')}.`,
    `  Font tokens (value = one of: ${Object.keys(ops.FONT_STACKS).join(', ')}): ${ops.FONT_TOKENS.join(', ')}.`,
    '  Scale tokens (value = whole number): base_font_size 14-20, border_radius 0-24.',
    '- {"type":"zone_create","zone":{"id":<short slug>,"type":"banner"|"hero"|"cta","fields":{"headline":..., "subtext":..., "button_text":..., "button_url":..., "accent":"primary"|"dark"|"light", "align":"left"|"center"}}} — a BitPype section the plugin renders; the owner places it with a shortcode/block, so mention the placement in the summary when you create one.',
    '- {"type":"zone_update","zoneId":<id>,"fields":{...same fields, partial}} and {"type":"zone_remove","zoneId":<id>}.',
    'Change ONLY what the plan asks for. A color request changes colors only. Keep ops minimal and exact.',
  ].join('\n');
}

function censusContext(census) {
  if (!census) return '(no site map yet)';
  const lines = [];
  lines.push(`Site: ${census.site.title || '(untitled)'} — ${census.site.tagline || ''}`.trim());
  lines.push(
    `WordPress ${census.wp_version || '?'} · Theme: ${census.theme.name || '?'} ${census.theme.version || ''}`.trim()
  );
  lines.push(`Timezone: ${census.site.timezone || 'unknown'}`);
  lines.push('Pages:');
  for (const p of (census.pages || []).slice(0, 40)) {
    lines.push(`- ${p.title || '(untitled)'} (${p.url || ''}) [built with: ${p.builder}]`);
  }
  if ((census.menus || []).length) {
    lines.push(
      `Menus: ${census.menus
        .map((m) => m.name)
        .filter(Boolean)
        .join(', ')}`
    );
  }
  const d = census.design || { tokens: {}, zones: {} };
  lines.push(`Current BitPype design state (version ${d.version || 0}):`);
  lines.push(
    `- Tokens: ${Object.keys(d.tokens || {}).length ? JSON.stringify(d.tokens) : '(none — the theme is untouched)'}`
  );
  const zoneIds = Object.keys(d.zones || {});
  lines.push(`- BitPype sections: ${zoneIds.length ? zoneIds.join(', ') : '(none)'}`);
  return lines.join('\n');
}

function extractJson(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function callModel(config, db, { system, user, task, linkId }) {
  const data = await core.chatCompletionsRouted(config, {
    model: config.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0.3,
  });
  const usage = (data && data.usage) || {};
  core.logUsage(db, {
    task,
    provider: core.servedProviderFor(config),
    model: core.servedModelFor(config),
    promptTokens: usage.prompt_tokens || 0,
    completionTokens: usage.completion_tokens || 0,
    costUsd: 0,
    leadId: null,
    note: core.withFailoverNote(config, `wp-design-link-${linkId}`),
  });
  const content =
    data && data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : '';
  return String(content || '');
}

async function fetchText(url, timeoutMs = 9000) {
  /* Batch 168 (S5#5): this fetch used the global fetch with
   * redirect:'follow' and an unbounded body on a URL taken from the
   * link row's site_url — which normalizeSiteUrl accepts for ANY
   * http/https origin, including localhost and private addresses.
   * A connected "WordPress site" at an internal address turned the
   * design-chat critic into an SSRF probe of the host network.
   * Route it through the platform's guarded public fetch instead
   * (public-address validation, DNS pinning, per-hop redirect
   * revalidation, size cap — the siteIngest pattern). */
  const { fetchPublic } = require('./urlSafety');
  const res = await fetchPublic(url, {
    headers: { 'User-Agent': 'BitPype-Design-Verifier/1.0' },
    timeoutMs,
    maxBytes: 2 * 1024 * 1024,
  });
  return { status: res.status, text: await res.text() };
}

/**
 * The critic: compare the staged preview against the public page.
 * Purely mechanical — it trusts rendered HTML, not the model.
 */
async function criticCheck(row, staged, appliedOps) {
  const notes = [];
  let checked = false;
  let ok = null;
  const previewUrl = staged.previewUrl;
  if (!previewUrl) {
    notes.push('No preview address is available for this site.');
    return { checked, ok, notes };
  }
  let preview = null;
  let live = null;
  try {
    preview = await fetchText(previewUrl);
  } catch (e) {
    notes.push(`The staged preview could not be reached from BitPype (${e.message || 'network error'}).`);
  }
  try {
    live = await fetchText(String(row.site_url || ''));
  } catch {
    live = null;
  }
  if (!preview || preview.status !== 200) {
    if (preview) notes.push(`The staged preview answered HTTP ${preview.status}.`);
    notes.push('Use the Preview button to check the proposal on your site before approving it.');
    return { checked, ok, notes };
  }
  checked = true;
  ok = true;
  if (!preview.text.includes('bitpype-design-preview')) {
    ok = false;
    notes.push('The preview page did not show the staged design marker.');
  }
  for (const op of appliedOps) {
    if (op.type === 'set_token' && ops.COLOR_TOKENS.includes(String(op.token))) {
      const hex = ops.normalizeColor(op.value);
      if (hex && !preview.text.toLowerCase().includes(hex)) {
        ok = false;
        notes.push(`The preview did not show the new ${String(op.token).replace(/_/g, ' ')} (${hex}).`);
      }
    }
    if (op.type === 'zone_create' && op.zone && op.zone.id) {
      // A zone renders only where the owner places it (shortcode /
      // block), so absence from the fetched page is a note, not a
      // failure — presence in the staged state is what matters.
      if (!preview.text.includes(`data-bitpype-zone="${op.zone.id}"`)) {
        notes.push(
          `The new section "${op.zone.id}" is staged and will render wherever it is placed with its shortcode or block.`
        );
      }
    }
  }
  if (live && live.status === 200) {
    if (live.text.includes('bitpype-design-preview')) {
      ok = false;
      notes.push(
        'The staged design appears to be visible on the public site — it must stay preview-only until approval.'
      );
    } else {
      notes.push('The public site is unchanged while this proposal waits.');
    }
  }
  if (ok) notes.push('Verified in the staged preview: the change renders there and nowhere else.');
  return { checked, ok, notes };
}

function digestLine(role, text) {
  return `${role}: ${String(text || '')
    .replace(/\s+/g, ' ')
    .slice(0, 220)}`;
}

async function runWpDesignChat(workspaceId, linkId, body = {}, opts = {}) {
  const domain = require('./domain');
  const link = await wpPlugin.findById(workspaceId, linkId);
  if (!link) throw fail('NOT_FOUND', 'That WordPress connection was not found', 404);
  if (link.status !== 'connected') {
    throw fail('INVALID', 'This WordPress site is not currently connected', 409);
  }
  if (!wpPlugin.designCapable(link)) {
    throw fail(
      'UPDATE_REQUIRED',
      'Design editing needs the updated BitPype plugin on this site. Download a fresh copy above and install it over the current one in WordPress — your forms keep working either way.',
      409
    );
  }
  const message = String((body && body.message) || '').trim();
  if (!message) throw fail('EMPTY', 'Message is required', 400);
  if (message.length > MAX_MESSAGE) throw fail('TOO_LONG', `Message is too long (max ${MAX_MESSAGE} characters)`, 400);

  const census = wpDesign.censusOf(link);

  // Batch 97 caps: same plan limits, pool keyed by this
  // registration; owner-tier sessions only (portalTabs doctrine).
  const portalTabs = require('./portalTabs');
  let gate = { allowed: true, used: null, limit: null, planName: null, timezone: null };
  if (portalTabs.isOwnerTier(opts.userType)) {
    const billing = require('./billing');
    const plans = require('./plans');
    const planId = await billing.workspacePlan(workspaceId);
    const limit = plans.chatRequestsPerDayFor(planId);
    const decision = await wpDesign.checkAndRecordUsage(link.id, {
      limit,
      timezone: census && census.site ? census.site.timezone : null,
    });
    gate = { ...decision, planName: plans.getPlan(planId).name };
    if (!decision.allowed) {
      return {
        limited: true,
        reply:
          `You've used all ${gate.limit} of today's design chat requests for this site ` +
          `(${gate.used} of ${gate.limit} on the ${gate.planName} plan). ` +
          `The daily counter resets at midnight (${gate.timezone || 'UTC'}). ` +
          'Nothing was changed by this message — just send it again after the reset.',
        usage: { used: gate.used, limit: gate.limit },
      };
    }
  }

  const chat = await wpDesign.getChat(workspaceId, link.id);
  const transcript = [...chat.transcript];
  const pending = chat.pending;

  const persistTurn = async (assistantText, extra = {}) => {
    const { nextPending, ...msgExtra } = extra;
    const now = new Date().toISOString();
    transcript.push({ role: 'user', text: message, at: now });
    transcript.push({ role: 'assistant', text: assistantText, at: now, ...msgExtra });
    const digest = [chat.summary || '', digestLine('Owner', message), digestLine('BitPype', assistantText)]
      .filter(Boolean)
      .join('\n')
      .slice(-3500);
    await wpDesign.saveChat(workspaceId, link.id, {
      transcript,
      summary: digest,
      pending: nextPending !== undefined ? nextPending : null,
    });
    return { reply: assistantText, usage: { used: gate.used, limit: gate.limit } };
  };

  /* Batch 168 (S5#4): model-failure turns used to return
   * { error: true } WITHOUT persisting — the owner saw the failure
   * text, but the saved transcript (the standing save-everything
   * rule for chat) silently dropped the whole turn, user message
   * included, so the next turn's context had a hole exactly where
   * the conversation broke. Failures now persist like every other
   * turn (pending clarification preserved), with the error flag
   * kept on the return value for the client's styling. */
  const failTurn = async () => {
    const out = await persistTurn(MODEL_FAIL_TEXT, { nextPending: pending });
    return { ...out, error: true };
  };

  if (!census) {
    // Batch 143: preserve any pending clarification — a turn that
    // does not resolve the clarification must not clear it (the
    // portal chat's invariant; persistTurn defaults pending to
    // null, so non-clarification branches pass it through).
    return persistTurn(
      "I can't see your WordPress site's map yet, so I can't plan changes safely. Open Settings → BitPype once in your WordPress admin — the plugin sends me the map — then ask me again.",
      { nextPending: pending }
    );
  }

  // Model plumbing: same routed config resolution + spend plumbing
  // as the BitPype-site chat (platform settings win, workspace
  // fallback; Batch 120 routes this function as wp_design_chat).
  const wdb = domain.withDb(workspaceId, (db) => db);
  const config = await core.resolveAgentConfig(wdb, 'wp_design_chat');
  if (!core.museConfigured(config)) {
    return failTurn();
  }

  const tail = transcript
    .slice(-10)
    .map((m) => `${m.role === 'user' ? 'Owner' : 'BitPype'}: ${String(m.text || '').slice(0, 600)}`)
    .join('\n');
  const plannerUser = [
    'SITE MAP:',
    censusContext(census),
    '',
    chat.summary ? `EARLIER CONVERSATION (summary):\n${String(chat.summary).slice(0, 1500)}\n` : '',
    tail ? `RECENT TURNS:\n${tail}\n` : '',
    `Clarification already asked: ${pending ? 'true' : 'false'}`,
    pending
      ? `The clarification question was: ${String(pending.question || '')}. The owner's new message answers it.`
      : '',
    `OWNER'S NEW MESSAGE: ${message}`,
  ]
    .filter(Boolean)
    .join('\n');

  let plan = null;
  try {
    const raw = await callModel(config, wdb, {
      system: PLANNER_SYSTEM,
      user: plannerUser,
      task: 'wp_design_planner',
      linkId: link.id,
    });
    plan = extractJson(raw);
  } catch {
    return failTurn();
  }
  if (!plan || !['question', 'clarify', 'change'].includes(String(plan.kind || ''))) {
    return failTurn();
  }

  if (plan.kind === 'question') {
    const answer = String(plan.answer || '').trim();
    if (!answer) return failTurn();
    // Batch 143: a side question mid-clarification is answered
    // read-only and the pending clarification SURVIVES it (portal
    // parity) — the old bare persistTurn(answer) wiped pending, so
    // the owner's next message was planned as a fresh request and
    // the settled clarification context was lost.
    return persistTurn(answer, { nextPending: pending });
  }
  if (plan.kind === 'clarify') {
    if (!pending) {
      const question =
        String(plan.question || '').trim() || 'Could you tell me a little more about what you want changed?';
      return persistTurn(question, { nextPending: { question, at: new Date().toISOString() } });
    }
    // One clarification round already happened: proceed with the
    // settled facts rather than asking again (chat doctrine).
    plan = {
      kind: 'change',
      plan: {
        summary: 'Proceed with the design request using the details now settled.',
        details: `Original request and answer, in order: ${pending.question} → ${message}`,
      },
    };
  }

  // ---- IMPLEMENTOR ----
  const design = census.design || { tokens: {}, zones: {} };
  const implementorUser = [
    `PLAN: ${String((plan.plan && plan.plan.summary) || '').slice(0, 400)}`,
    `DETAILS: ${String((plan.plan && plan.plan.details) || '').slice(0, 1200)}`,
    `CURRENT TOKENS: ${JSON.stringify(design.tokens || {})}`,
    `CURRENT SECTIONS: ${JSON.stringify(design.zones || {})}`,
  ].join('\n');

  async function implement(extraNotes) {
    const raw = await callModel(config, wdb, {
      system: implementorSystem(),
      user: extraNotes ? `${implementorUser}\nCRITIC NOTES FROM THE PREVIOUS ATTEMPT: ${extraNotes}` : implementorUser,
      task: 'wp_design_implementor',
      linkId: link.id,
    });
    return extractJson(raw);
  }

  let impl = null;
  try {
    impl = await implement('');
  } catch {
    return failTurn();
  }
  if (!impl || !Array.isArray(impl.ops)) return failTurn();

  let result = ops.applyOpsLenient(design.tokens || {}, design.zones || {}, impl.ops);
  if (!result.applied.length) {
    const why = result.dropped.length
      ? ` The specific changes suggested weren't ones I can safely make (${result.dropped
          .map((d) => d.reason)
          .slice(0, 2)
          .join('; ')}).`
      : '';
    return persistTurn(
      `I couldn't turn that into a change I can make on this site.${why} I can change the global look (colors, fonts, base size, corner radius) and add or restyle BitPype sections (banner, hero, call-to-action) — page content itself is edited in WordPress for now.`
    );
  }

  let staged = await wpDesign.stageProposal(link, {
    opsList: result.applied,
    tokens: result.tokens,
    zones: result.zones,
    summary: String(impl.summary || (plan.plan && plan.plan.summary) || 'Design change').slice(0, 500),
    verify: null,
  });

  // ---- CRITIC (one bounded rework) ----
  let verify = await criticCheck(link, staged, result.applied);
  if (verify.checked && verify.ok === false) {
    try {
      const impl2 = await implement(verify.notes.join(' '));
      if (impl2 && Array.isArray(impl2.ops)) {
        const result2 = ops.applyOpsLenient(design.tokens || {}, design.zones || {}, impl2.ops);
        if (result2.applied.length) {
          const staged2 = await wpDesign.stageProposal(link, {
            opsList: result2.applied,
            tokens: result2.tokens,
            zones: result2.zones,
            summary: String(impl2.summary || impl.summary || 'Design change').slice(0, 500),
            verify: null,
          });
          const verify2 = await criticCheck(link, staged2, result2.applied);
          if (!verify2.checked || verify2.ok !== false) {
            staged = staged2;
            result = result2;
            verify = verify2;
          }
        }
      }
    } catch {
      /* rework is best-effort; the first proposal + verdict stand */
    }
  }
  await wpDesign.updateProposalVerify(workspaceId, link.id, staged.id, verify);

  // ---- REVIEWER (the reply is built from staged facts only) ----
  const changeLines = result.applied.map((op) => `- ${ops.describeOp(op)}`);
  const parts = [
    `I've prepared a proposed change for ${link.site_name || 'your site'} — nothing is live yet.`,
    '',
    ...changeLines,
    '',
  ];
  if (verify.checked && verify.ok) {
    parts.push(
      'I checked it in a staged preview of your site: the change renders there, and your public site is unchanged.'
    );
  } else if (verify.checked && verify.ok === false) {
    parts.push(
      `I checked the staged preview and found a problem: ${verify.notes.filter(Boolean).join(' ')} Please look at the preview yourself before approving.`
    );
  } else {
    parts.push(
      `I couldn't verify the staged preview from here (${verify.notes.filter(Boolean).join(' ')}) — please use the Preview button to see it on your site before approving.`
    );
  }
  if (result.dropped.length) {
    parts.push(
      `I left out ${result.dropped.length} suggested change(s) I can't safely make: ${result.dropped
        .map((d) => d.reason)
        .slice(0, 2)
        .join('; ')}.`
    );
  }
  parts.push(
    'Use Preview to see it on your real site, then Approve to apply it or Reject to discard it. You can undo an applied change from the same list.'
  );
  const out = await persistTurn(parts.join('\n'));
  return { ...out, proposalId: staged.id, previewUrl: staged.previewUrl };
}

module.exports = { runWpDesignChat, MODEL_FAIL_TEXT, _internals: { criticCheck, censusContext, extractJson } };
