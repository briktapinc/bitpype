'use strict';

/**
 * Meta Muse Model API agent loop for Hands-off mode.
 * OpenAI-compatible chat/completions + tools → server/mcp.js callTool (workspace scope).
 */

const platform = require('./platform');
const crypto = require('node:crypto');
const { defaultWebsiteInstructions } = require('../src/defaultDesignInstructions');
// Batch 94: the PLANNER module owns the defaults doctrine +
// convergence policy as data (server/siteChatPlanner.js), and the
// capability registry (server/portalCapabilities.js) derives what
// the agent may claim it can do from the tools it actually has.
// Prompts below CONSUME both — they keep no private copies, so
// the four-role rebuild can lift the policy without the prompts.
const chatPlanner = require('./siteChatPlanner');
const { portalCapabilityText } = require('./portalCapabilities');

const MAX_STEPS = 36;
const MAX_PORTAL_STEPS = 20;
const REQUEST_TIMEOUT_MS = 180000;

/** Mutating client tools — after any of these, portal chat refreshes the preview. */
const PORTAL_MUTATE_TOOLS = new Set([
  'site.editText',
  'site.editListItem',
  'site.replaceImage',
  'site.generateImage',
  'site.setLogo',
  'theme.set',
  'theme.styleRule',
  'pages.structure.update',
  'modules.attach',
  'modules.detach',
  'modules.uploadImage',
  'site.publish',
  'site.canvasBlock',
  'website.addModule',
]);

/** Tools Muse must not call in Hands-off (destructive / meta / job control). */
const DENY_TOOLS = new Set([
  'lead.delete',
  'website.delete',
  'jobs.delete',
  'jobs.create',
  'jobs.update',
  'jobs.runNow',
  'automation.pause',
  'automation.resume',
  'settings.set',
  'prompts.save',
  'handsOff.runNow',
  'handsOff.status',
]);

/**
 * Batch 93 — the portal chat is a design AGENT, not a build pipe:
 * a message may be a question, an underspecified change (clarify
 * first), a specific change (implement), or off-topic (decline).
 * Question / clarification turns run READ-ONLY. PORTAL_MUTATE_TOOLS
 * is NOT the fence — it only lists the tools after which the preview
 * refreshes, while the client-scoped catalog carries many more
 * mutating tools (blog.create, datatables.addRow, …). The fence is
 * this explicit ALLOWLIST of pure reads (get / list / preview /
 * render), applied through the single seam portalModeAllowsTool():
 * read-only modes never OFFER a tool outside the list, and the
 * dispatch refuses one even if a wire name somehow resolves.
 */
const PORTAL_READONLY_TOOLS = new Set([
  'site.get',
  'site.render',
  'theme.get',
  'pages.structure',
  'modules.list',
  'blog.list',
  'careers.list',
  'courses.list',
  'datatables.get',
  'charts.get',
  'directory.list',
  'ecommerce.list',
  'ecommerce.listOrders',
  'events.list',
  'faq.list',
  'forms.get',
  'forms.list',
  'gallery.list',
  'menu.list',
  'offers.list',
  'team.list',
  'testimonials.list',
  'video.list',
  'bookings.list',
  'bookings.services',
  'bookings.getHours',
  'bookings.slots',
  'estimate.getConfig',
  'estimate.listOptions',
  'estimate.listRequests',
  'members.getConfig',
  'members.listTiers',
  'members.listMembers',
  'members.listSubscriptions',
  'calls.list',
  'calls.getSettings',
  'googlereviews.getConfig',
  'googlereviews.preview',
  'socialfeed.getConfig',
  'socialfeed.preview',
  'social.accounts.list',
  'social.calendar',
  'social.posts.list',
  'fonts.list',
]);

/** Step caps per chat mode — Q&A / clarification turns stay cheap. */
const PORTAL_MODE_STEPS = { build: MAX_PORTAL_STEPS, answer: 6, clarify: 5 };

/**
 * Batch 98 (SEC-06) — build mode's POSITIVE allowlist. Until now
 * build mode could use the whole client-scoped catalog minus a
 * 12-tool deny list (review finding M2: billing.*, social.*,
 * chatbot.*, members.grantComp, datatables.clear and more were
 * reachable from a chat turn). The fence is now default-deny:
 * build mode may use ONLY the read allowlist plus the design /
 * content writes below — the tools that design or author the
 * owner's OWN site. Money (billing.*), outbound channels
 * (social.*, email/sms/outreach), the visitor chatbot's
 * conversation tools, member comp grants, bulk clears
 * (datatables.clear, charts.clear) and every workspace/admin
 * surface are simply not in the set, so they are never offered
 * and refused again at dispatch.
 */
const PORTAL_DESIGN_WRITE_TOOLS = new Set([
  ...PORTAL_MUTATE_TOOLS,
  'blog.create', 'blog.update', 'blog.delete',
  'faq.create', 'faq.update', 'faq.delete',
  'gallery.addImage', 'gallery.create', 'gallery.update', 'gallery.delete',
  'menu.addCategory', 'menu.create', 'menu.delete', 'menu.deleteCategory', 'menu.update', 'menu.updateCategory',
  'team.create', 'team.update', 'team.delete',
  'testimonials.create', 'testimonials.update', 'testimonials.delete',
  'events.create', 'events.update', 'events.delete',
  'careers.create', 'careers.update', 'careers.delete',
  'courses.addLesson', 'courses.create', 'courses.update', 'courses.delete',
  'video.create', 'video.update', 'video.delete',
  'directory.create', 'directory.update', 'directory.delete',
  'offers.create', 'offers.update', 'offers.delete',
  'charts.create', 'charts.update', 'charts.delete',
  'datatables.addRow', 'datatables.addRows', 'datatables.updateRow', 'datatables.deleteRow',
  'datatables.setColumns', 'datatables.setDisplay',
  'forms.create', 'forms.update', 'forms.delete', 'forms.suggestFields',
  'bookings.createService', 'bookings.updateService', 'bookings.deleteService',
  'bookings.setHours', 'bookings.setSettings',
  'estimate.createOption', 'estimate.updateOption', 'estimate.deleteOption', 'estimate.updateConfig',
  'members.createTier', 'members.updateTier', 'members.updateConfig',
  'ecommerce.create', 'ecommerce.update', 'ecommerce.delete',
  'googlereviews.updateConfig', 'googlereviews.refresh',
  'socialfeed.updateConfig',
]);

/** Everything build mode may touch: reads ∪ design/content writes. */
const PORTAL_DESIGN_TOOLS = new Set([...PORTAL_READONLY_TOOLS, ...PORTAL_DESIGN_WRITE_TOOLS]);

/**
 * THE fence (Batch 93, rebuilt Batch 98). Build mode is a
 * POSITIVE allowlist (PORTAL_DESIGN_TOOLS — SEC-06); answer /
 * clarify modes may use ONLY the read allowlist.
 */
function portalModeAllowsTool(mode, name) {
  if (mode === 'build') return PORTAL_DESIGN_TOOLS.has(name);
  return PORTAL_READONLY_TOOLS.has(name);
}

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function getDbSetting(db, key, def = '') {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    // SECRET_KEYS (incl. muse.model_api_key) are secretBox-encrypted at
    // rest — decrypt on read like every other sanctioned reader, or the
    // workspace fallback hands the API ciphertext as its key.
    return row && row.value != null ? String(require('../src/secretBox').decryptSetting(key, row.value)) : def;
  } catch {
    return def;
  }
}

async function resolveMuseConfig(db) {
  let apiKey = '';
  let baseUrl = 'https://api.meta.ai/v1';
  let model = 'muse-spark-1.3';
  try {
    apiKey = String((await platform.getPlatformSetting('muse.model_api_key', '')) || '').trim();
    baseUrl = String((await platform.getPlatformSetting('muse.model_base_url', baseUrl)) || baseUrl).trim();
    model = String((await platform.getPlatformSetting('muse.model_default', model)) || model).trim();
  } catch {
    /* platform DB unavailable — fall through to workspace */
  }
  if (!apiKey && db) {
    apiKey = String(getDbSetting(db, 'muse.model_api_key', '') || '').trim();
    const b = String(getDbSetting(db, 'muse.model_base_url', '') || '').trim();
    const m = String(getDbSetting(db, 'muse.model_default', '') || '').trim();
    if (b) baseUrl = b;
    if (m) model = m;
  }
  baseUrl = baseUrl.replace(/\/+$/, '');
  return { apiKey, baseUrl, model };
}

function museConfigured(config) {
  return !!(config && config.apiKey && /^https?:\/\//i.test(config.baseUrl));
}

function todaySpendUsd(db) {
  try {
    const row = db
      .prepare("SELECT COALESCE(SUM(cost_usd), 0) AS spent FROM ai_usage WHERE date(at) = date('now')")
      .get();
    return Number(row.spent) || 0;
  } catch {
    return 0;
  }
}

// Batch 106: the provider that served a museAgent call is the host
// its configured base URL points at (api.meta.ai → 'muse' today).
function providerForConfig(config) {
  try {
    return require('../src/aiProvider').providerFromBaseUrl(config && config.baseUrl);
  } catch {
    return 'unknown';
  }
}

function logUsage(db, { task, provider, model, promptTokens, completionTokens, costUsd, leadId, note }) {
  try {
    db.prepare(
      `INSERT INTO ai_usage (task, provider, model, prompt_tokens, completion_tokens, cost_usd, lead_id, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      task || 'hands_off',
      provider || 'unknown',
      model || '',
      promptTokens || 0,
      completionTokens || 0,
      costUsd || 0,
      leadId || null,
      note ? String(note).slice(0, 500) : null
    );
  } catch (e) {
    console.warn('[museAgent] ai_usage log failed:', e.message);
  }
}

function mcpToolsToOpenAi(toolDefs) {
  const toolNames = new Map();
  const tools = (toolDefs || [])
    .filter((t) => t && t.name && !DENY_TOOLS.has(t.name))
    .map((t) => {
      // Providers have different namespace rules. Keep wire names portable, short,
      // and unambiguous; dispatch only through this advertised catalog map.
      const name =
        String(t.name)
          .replace(/[^a-zA-Z0-9_-]/g, '_')
          .slice(0, 48) +
        '_' +
        crypto.createHash('sha256').update(t.name).digest('hex').slice(0, 12);
      if (toolNames.has(name)) throw fail('TOOL_CATALOG_INVALID', 'Duplicate AI tool alias');
      toolNames.set(name, t.name);
      return {
        type: 'function',
        function: {
          name,
          description: String(t.description || '').slice(0, 1024),
          parameters:
            t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object', properties: {} },
        },
      };
    });
  return { tools, toolNames };
}

function buildSystemPrompt(job) {
  const brief =
    job && job.brief ? (typeof job.brief === 'string' ? job.brief : JSON.stringify(job.brief, null, 0)) : '';
  const parts = [
    defaultWebsiteInstructions(),
    '',
    '═══ HANDS-OFF SESSION ═══',
    'You are running unattended inside BitPype Hands-off. Use only the tools provided.',
    'Claim/work this design job, deliver a complete modular site with design.deliver, then website.preview or cloudflare.publish.',
    'Do not ask the human; use design.ask only if a missing fact blocks an accurate build — then stop.',
    `Job id: ${job && job.id != null ? job.id : '(unknown)'}`,
    `Title: ${job && job.title ? job.title : ''}`,
    job && job.lead_id != null ? `Lead id: ${job.lead_id}` : '',
    job && job.instructions ? `Job instructions:\n${String(job.instructions).slice(0, 8000)}` : '',
    brief ? `Brief JSON:\n${String(brief).slice(0, 12000)}` : '',
  ];
  return parts.filter(Boolean).join('\n');
}

function deliveredOk(toolName, outcome) {
  if (toolName !== 'design.deliver') return false;
  if (!outcome || outcome.ok === false) return false;
  const data = outcome.data;
  if (!data) return true;
  const job = data.job || data;
  if (job && job.status === 'delivered') return true;
  if (data.status === 'delivered') return true;
  return outcome.ok === true;
}

async function chatCompletions(config, body) {
  const url = `${config.baseUrl}/chat/completions`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    throw fail('MUSE_NETWORK', `Muse request failed: ${e.message || 'network error'}`);
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    throw fail('MUSE_BAD_RESPONSE', `Muse returned non-JSON (HTTP ${res.status})`);
  }
  if (!res.ok) {
    const providerMsg =
      data && data.error && data.error.message ? String(data.error.message).slice(0, 200) : `HTTP ${res.status}`;
    throw fail('MUSE_REQUEST_FAILED', `Muse request failed: ${providerMsg}`);
  }
  return data;
}

/**
 * Run the Muse tool loop for one design job.
 * @returns {{ ok, delivered, steps, toolCalls, error?, costUsd, model }}
 */
async function runJobLoop(workspaceId, job, { db, maxSteps = MAX_STEPS } = {}) {
  if (!job || job.id == null) throw fail('INVALID_JOB', 'design job required');
  const domain = require('./domain');
  const mcp = require('./mcp');

  if (domain.withDb(workspaceId, (d) => domain.getSetting(d, 'automation_paused', '0')) === '1') {
    return { ok: false, delivered: false, steps: 0, toolCalls: 0, error: 'automation_paused', costUsd: 0 };
  }

  const config = await resolveMuseConfig(db);
  if (!museConfigured(config)) {
    return { ok: false, delivered: false, steps: 0, toolCalls: 0, error: 'muse_not_configured', costUsd: 0 };
  }

  const budget = parseFloat(getDbSetting(db, 'cost.daily_budget_usd', '10')) || 0;
  if (budget > 0 && todaySpendUsd(db) >= budget) {
    return { ok: false, delivered: false, steps: 0, toolCalls: 0, error: 'budget_exceeded', costUsd: 0 };
  }

  const { tools, toolNames } = mcpToolsToOpenAi(mcp.toolDefs({ clientScoped: false }));
  const messages = [
    { role: 'system', content: buildSystemPrompt(job) },
    {
      role: 'user',
      content: `Build and deliver design job #${job.id} for this business. Use tools only. Call design.next if needed, then design.get, then design.deliver, then publish/preview.`,
    },
  ];

  let steps = 0;
  let toolCalls = 0;
  let totalCost = 0;
  let delivered = false;
  let lastError = null;
  const consecutiveToolErrors = { n: 0 };

  while (steps < maxSteps) {
    if (domain.withDb(workspaceId, (d) => domain.getSetting(d, 'automation_paused', '0')) === '1') {
      return {
        ok: false,
        delivered,
        steps,
        toolCalls,
        error: 'automation_paused',
        costUsd: totalCost,
        model: config.model,
      };
    }
    if (budget > 0 && todaySpendUsd(db) >= budget) {
      return {
        ok: false,
        delivered,
        steps,
        toolCalls,
        error: 'budget_exceeded',
        costUsd: totalCost,
        model: config.model,
      };
    }

    steps++;
    let data;
    try {
      data = await chatCompletions(config, {
        model: config.model,
        messages,
        tools,
        tool_choice: 'auto',
        max_tokens: 4096,
      });
    } catch (e) {
      lastError = e.code || 'MUSE_REQUEST_FAILED';
      break;
    }

    const usage = (data && data.usage) || {};
    const promptTokens = Number(usage.prompt_tokens) || 0;
    const completionTokens = Number(usage.completion_tokens) || 0;
    const per1kPrompt = parseFloat(getDbSetting(db, 'cost.per_1k_prompt', '0.0015')) || 0;
    const per1kCompletion = parseFloat(getDbSetting(db, 'cost.per_1k_completion', '0.002')) || 0;
    const costUsd = (promptTokens / 1000) * per1kPrompt + (completionTokens / 1000) * per1kCompletion;
    totalCost += costUsd;
    logUsage(db, {
      task: 'hands_off',
      provider: providerForConfig(config),
      model: config.model,
      promptTokens,
      completionTokens,
      costUsd,
      leadId: job.lead_id || null,
      note: `muse job #${job.id} step ${steps}`,
    });

    const choice = data.choices && data.choices[0];
    const msg = (choice && choice.message) || {};
    const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];

    if (!calls.length) {
      messages.push({
        role: 'assistant',
        content: msg.content != null ? String(msg.content) : '',
      });
      // Model stopped without tools — if not delivered, nudge once then exit
      if (!delivered && steps < maxSteps) {
        messages.push({
          role: 'user',
          content:
            'Continue with tools. You must call design.deliver (then publish) to finish. If blocked, explain the gap in one short sentence and stop.',
        });
        continue;
      }
      break;
    }

    messages.push({
      role: 'assistant',
      content: msg.content != null ? msg.content : null,
      tool_calls: calls,
    });

    for (const tc of calls) {
      const wireName = String((tc.function && tc.function.name) || '').trim();
      const name = toolNames.get(wireName);
      let args = {};
      try {
        args = JSON.parse((tc.function && tc.function.arguments) || '{}');
      } catch {
        args = {};
      }
      if (!name || DENY_TOOLS.has(name)) {
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify({ ok: false, error: `Tool ${name} is not allowed in Hands-off.` }),
        });
        consecutiveToolErrors.n++;
        continue;
      }

      toolCalls++;
      let outcome;
      try {
        outcome = await mcp.callTool(workspaceId, name, args, {});
      } catch (e) {
        outcome = { ok: false, error: e.message || String(e) };
      }

      if (!outcome || outcome.ok === false) {
        consecutiveToolErrors.n++;
      } else {
        consecutiveToolErrors.n = 0;
      }

      if (deliveredOk(name, outcome)) {
        delivered = true;
      }

      const compact = JSON.stringify(outcome);
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: compact.length > 24000 ? compact.slice(0, 24000) + '…[truncated]' : compact,
      });
    }

    if (delivered) break;
    if (consecutiveToolErrors.n >= 8) {
      lastError = 'repeated_tool_errors';
      break;
    }
  }

  return {
    ok: delivered,
    delivered,
    steps,
    toolCalls,
    error: delivered ? null : lastError || (steps >= maxSteps ? 'max_steps' : 'not_delivered'),
    costUsd: totalCost,
    model: config.model,
    jobId: job.id,
  };
}

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
async function planPortalChange(
  workspaceId,
  leadId,
  { db, message, specText, history, settled, siteContext, images, rework } = {}
) {
  const domain = require('./domain');
  const chatPlan = require('./siteChatPlan');
  const lid = Number(leadId);
  const config = await domain.withDb(workspaceId, async (d) => resolveMuseConfig(db || d));
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
      data = await chatCompletions(config, {
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
          provider: providerForConfig(config),
          model: config.model,
          promptTokens,
          completionTokens,
          costUsd: (promptTokens / 1000) * per1kPrompt + (completionTokens / 1000) * per1kCompletion,
          leadId: lid,
          note: 'portal plan',
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

function buildPortalSystemPrompt(leadId, pageSlug, mode = 'build', ctx = {}) {
  const pageHint = pageSlug
    ? `Focus on page slug "${String(pageSlug).slice(0, 80)}" when using site.render / edits unless the user asks for another page.`
    : 'Use site.render to inspect the current page before editing.';
  if (mode === 'answer') {
    return [
      'You are BitPype’s site co-pilot inside the client portal — the design agent for this business’s website.',
      'The owner is asking a QUESTION about their site, its design or content, or asking for design advice for the site. Answer it directly and conversationally, grounded in the actual site.',
      `Lead id is ${Number(leadId)}. Always pass leadId on tools that accept it.`,
      'You may inspect the site with the read-only tools provided (site.get, site.render, and the content list/get tools) so your answer reflects what is really on the site. This turn is READ-ONLY: you have no editing tools and must not change anything, and you must not claim to have changed anything.',
      'If the owner attached image(s), they are part of the question — assess them in relation to the site (branding, colours, quality, fit) as asked.',
      'Keep the answer focused and practical: a short paragraph, or a few short bullets when listing. If the owner actually wants a change made, they can just say so and you will apply it.',
      // Batch 94: capability claims come from the registry, so a
      // "what changes can you make" answer can never contradict
      // what the build mode would do with the same request.
      ...(ctx.capabilities
        ? [
            'If the owner asks what changes you can make, answer from the capabilities list below — exactly those, no more and no less. Never tell the owner you cannot do something that is listed there.',
            ctx.capabilities,
          ]
        : []),
    ].join('\n');
  }
  if (mode === 'clarify') {
    const about = String(ctx.clarifyAbout || '').slice(0, 600);
    const lines = [
      'You are BitPype’s site co-pilot inside the client portal — the design agent for this business’s website.',
      `Lead id is ${Number(leadId)}. Always pass leadId on tools that accept it.`,
      'This turn is READ-ONLY: you have no editing tools and must not change anything, and you must not claim to have changed anything. You may inspect the site with the read-only tools provided so your questions are informed by what is actually on the site.',
    ];
    if (ctx.clarifyKind === 'either_or') {
      lines.push(
        `The owner's message could be a comment or a question, or a request to change something: "${about}".`,
        'Ask ONE short question: do they want you to change it, or were they just asking / commenting? One or two sentences total — the single either/or question and nothing else.'
      );
    } else {
      // Batch 94: ONE round only, and only about decisions that are
      // genuinely open — never about settled facts, never about
      // anything the defaults cover. The owner was driven through
      // four rounds of near-identical checklists before this fix.
      const settled = Array.isArray(ctx.clarifySettled) ? ctx.clarifySettled : [];
      const prior = ctx.clarifyPriorQa && typeof ctx.clarifyPriorQa === 'object' ? ctx.clarifyPriorQa : null;
      const round = Number(ctx.clarifyRound) || 1;
      lines.push(
        `The owner asked for a change that is missing a decision you cannot default: "${about}".`,
        `This is clarification round ${round} for this change — and the LAST round of questions. After the owner answers, every remaining gap is filled with the defaults below and the change is implemented. Ask AT MOST 3 questions, numbered plainly, and ONLY about decisions that are (a) not already settled, (b) not already answered, and (c) not covered by a default. Keep the whole reply short and friendly, and end with the questions. Do not implement anything yet.`
      );
      if (settled.length) {
        lines.push(
          `Already settled — do NOT ask about these again: ${settled.map((s) => `"${String(s).slice(0, 200)}"`).join(' · ')}`
        );
      }
      if (prior && (prior.questionsText || (Array.isArray(prior.answers) && prior.answers.length))) {
        lines.push(
          `You already asked: "${String(prior.questionsText || '').slice(0, 700)}"${
            Array.isArray(prior.answers) && prior.answers.length
              ? ` — the owner answered: ${prior.answers.map((a) => `"${String(a).slice(0, 300)}"`).join(' | ')}`
              : ''
          } Do not repeat any of those questions; ask only about the NEW decision the latest answer opened up.`
        );
      }
      lines.push(
        chatPlanner.CLARIFY_DEFAULTS_LINE,
        'If the owner attached image(s) with no clear instruction, ask what they would like done with them (use them on the site, match their colours/branding, or something else) — that counts as one of the questions.'
      );
    }
    return lines.join('\n');
  }
  return [
    'You are BitPype’s site co-pilot inside the client portal.',
    'The business owner describes improvements in plain language. You apply them with tools only — no admin/workspace tools.',
    `Lead id is ${Number(leadId)}. Always pass leadId on tools that accept it.`,
    pageHint,
    'Workflow: site.get → site.render (includeHtml false unless you need HTML) → mutate with site.editText / theme.set / theme.styleRule / pages.structure.update / etc. → site.publish so the preview updates.',
    'For text changes, use exact ids from site.render textTargets. Never invent edit ids. If the target is absent, inspect site.render with includeHtml:true. Tool wire aliases must be used exactly as advertised.',
    'Prefer small, accurate edits. Do not invent phone/email/address. Do not delete the whole site.',
    // Batch 94: capabilities are registry-derived (one source of
    // truth) — the agent must never refuse a listed capability
    // (the H3 refusal + queue) nor promise an unlisted one.
    ...(ctx.capabilities ? [ctx.capabilities] : []),
    'Per-element styling is a SMALL in-chat job you do on the spot with theme.styleRule: selector "h3" + property "color" + a concrete hex recolours EVERY H3 through the site stylesheet; scope a rule with section[data-ws-section-type="<type>"] when the owner names a part of the site (e.g. dark sections). Never say your tools only change overall text colours, and never queue a style-sized job for lack of tools.',
    // Batch 94 defaults doctrine (implementation side) lives in
    // the PLANNER module: decide the polish yourself, then
    // DISCLOSE the defaults in the summary — correction-after
    // replaces questions-before.
    chatPlanner.BUILD_DEFAULTS_LINE,
    chatPlanner.BUILD_DISCLOSURE_LINE,
  ].join('\n');
}

function normalizePortalHistory(history, userMessage, images, imagesMode = 'build') {
  const out = [];
  const list = Array.isArray(history) ? history.slice(-10) : [];
  for (const row of list) {
    if (!row || (row.role !== 'user' && row.role !== 'assistant')) continue;
    const content = String(row.content || '').trim();
    if (!content) continue;
    out.push({ role: row.role, content: content.slice(0, 4000) });
  }
  const msg = String(userMessage || '').trim();
  // Batch 89: images attached to this chat turn ride the final user
  // message as OpenAI-style vision parts so the design loop can analyze
  // them (colors, layout, photo content) while applying the change. An
  // image-only message (no text) is valid when images are present.
  // Batch 93: in read-only modes (answer / clarify) the framing must
  // not instruct the model to apply changes — the images are the
  // subject of the question or of the clarification.
  const imgs = (Array.isArray(images) ? images : []).filter((im) => im && im.dataUrl);
  if (!msg && !imgs.length) throw fail('EMPTY', 'Message is required.');
  if (msg.length > 4000) throw fail('TOO_LONG', 'Message is too long (max 4000 characters).');
  if (!imgs.length) {
    out.push({ role: 'user', content: msg });
    return out;
  }
  const names = imgs.map((im) => String(im.name || 'image').slice(0, 120)).join(', ');
  const text =
    imagesMode === 'discuss'
      ? (msg ||
          'I attached image(s) with no written message. Look at them carefully — I want to talk about them in relation to my site.') +
        `\n\n[Attached image(s): ${names}. Look at them carefully — colors, layout, branding, photo content and quality — they are part of what I am asking about.]`
      : (msg ||
          'I attached image(s) with no written message. Analyze them and apply the improvement they most clearly suggest for my site (for example matching their colors or branding, or using the photo where it fits), then tell me what you did.') +
        `\n\n[Attached image(s) for analysis: ${names}. Look at them carefully and use what you see — colors, layout, branding, photo content and quality — to guide the changes you make.]`;
  out.push({
    role: 'user',
    content: [
      { type: 'text', text },
      ...imgs.map((im) => ({ type: 'image_url', image_url: { url: im.dataUrl } })),
    ],
  });
  return out;
}

/**
 * Muse tool loop for portal Website chat (client-scoped MCP only).
 * @returns {{ ok, reply, steps, toolCalls, mutated, published, error?, costUsd, model }}
 */
async function runPortalImproveLoop(
  workspaceId,
  leadId,
  { db, message, history, pageSlug, images, mode = 'build', clarifyAbout = '', clarifyKind = '', clarifySettled = [], clarifyPriorQa = null, clarifyRound = 1, siteContext = '', maxSteps, plan = null } = {}
) {
  const domain = require('./domain');
  const mcp = require('./mcp');
  const lid = Number(leadId);
  if (!Number.isInteger(lid) || lid < 1) throw fail('INVALID', 'leadId required');
  // Batch 93: chat modes — 'build' implements a change with the full
  // tool catalog; 'answer' and 'clarify' are READ-ONLY turns (question
  // answering / clarification questions) fenced to PORTAL_READONLY_TOOLS.
  const runMode = mode === 'answer' || mode === 'clarify' ? mode : 'build';
  const stepCap =
    Number.isInteger(maxSteps) && maxSteps > 0 ? maxSteps : PORTAL_MODE_STEPS[runMode] || MAX_PORTAL_STEPS;

  const config = await domain.withDb(workspaceId, async (d) => resolveMuseConfig(db || d));
  if (!museConfigured(config)) {
    return {
      ok: false,
      reply: '',
      steps: 0,
      toolCalls: 0,
      mutated: false,
      published: false,
      error: 'muse_not_configured',
      costUsd: 0,
      model: config.model,
    };
  }

  const { budget, spent } = domain.withDb(workspaceId, (d) => {
    const use = db || d;
    return {
      budget: parseFloat(getDbSetting(use, 'cost.daily_budget_usd', '10')) || 0,
      spent: todaySpendUsd(use),
    };
  });
  if (budget > 0 && spent >= budget) {
    return {
      ok: false,
      reply: '',
      steps: 0,
      toolCalls: 0,
      mutated: false,
      published: false,
      error: 'budget_exceeded',
      costUsd: 0,
      model: config.model,
    };
  }

  // Batch 93: the fence is structural — in read-only modes the write
  // tools are never even OFFERED to the model (portalModeAllowsTool),
  // and the dispatch below refuses them a second time.
  // Batch 98: THE IMPLEMENTOR sandbox. In build mode with a plan,
  // the offered catalog narrows further — read tools (for grounding)
  // plus exactly the tools the plan's steps name (and site.publish,
  // the system act that makes an implemented change visible). A
  // mutating tool outside the plan is refused at dispatch with a
  // structured NOT_IN_PLAN error: the implementor executes the
  // plan, it does not improvise a different change.
  const activePlan = runMode === 'build' && plan && Array.isArray(plan.steps) && plan.steps.length ? plan : null;
  const planToolSet = activePlan ? new Set(activePlan.steps.map((s) => s.tool)) : null;
  if (planToolSet) planToolSet.add('site.publish');
  const scopedDefs = mcp
    .toolDefs({ clientScoped: true })
    .filter((t) => t && portalModeAllowsTool(runMode, t.name))
    .filter((t) => !planToolSet || PORTAL_READONLY_TOOLS.has(t.name) || planToolSet.has(t.name));
  const { tools, toolNames } = mcpToolsToOpenAi(scopedDefs);
  const stepResults = activePlan
    ? activePlan.steps.map((s) => ({ tool: s.tool, status: 'pending', error: null }))
    : [];
  let planViolations = 0;
  const recordStepResult = (name, ok, errorText) => {
    if (!activePlan || PORTAL_READONLY_TOOLS.has(name) || name === 'site.publish') return;
    const idx = stepResults.findIndex((r) => r.tool === name && r.status === 'pending');
    if (idx < 0) return;
    stepResults[idx].status = ok ? 'done' : 'failed';
    stepResults[idx].error = ok ? null : String(errorText || 'tool failed').slice(0, 300);
  };
  const modelImages = (Array.isArray(images) ? images : []).filter((im) => im && im.dataUrl);
  const messages = [
    {
      role: 'system',
      content: buildPortalSystemPrompt(lid, pageSlug, runMode, {
        clarifyAbout,
        clarifyKind,
        clarifySettled,
        clarifyPriorQa,
        clarifyRound,
        // Batch 94: capability text derived from the BUILD catalog
        // (what the agent can do when asked to make a change) —
        // injected into answer + build prompts alike so capability
        // claims can never contradict behaviour.
        capabilities: portalCapabilityText(
          mcp.toolDefs({ clientScoped: true }).filter((t) => t && portalModeAllowsTool('build', t.name)).map((t) => t.name)
        ),
      }),
    },
    ...(activePlan
      ? [
          {
            role: 'system',
            content: [
              'THE PLAN — the planner has already decided this change. Execute exactly these steps, in order, and nothing else:',
              ...activePlan.steps.map(
                (s, i) =>
                  `${i + 1}. ${s.tool}${s.args && Object.keys(s.args).length ? ` ${JSON.stringify(s.args).slice(0, 600)}` : ''}${s.expect ? ` — expect: ${s.expect}` : ''}`
              ),
              'RULES: any tool outside this plan is refused by the system — do not attempt one. Read tools stay available to ground exact ids and current content before you edit. If a step cannot be executed, STOP and reply naming the step number and the reason — never improvise a different change.',
              ...(Array.isArray(activePlan.settled) && activePlan.settled.length
                ? [`Settled facts (binding): ${activePlan.settled.map((s) => `"${String(s).slice(0, 200)}"`).join(' · ')}`]
                : []),
              ...(Array.isArray(activePlan.defaultsApplied) && activePlan.defaultsApplied.length
                ? [`Defaults the planner applied: ${activePlan.defaultsApplied.join('; ')}`]
                : []),
            ].join('\n'),
          },
        ]
      : []),
    // Tier 1 whole-site context: the agent's standing knowledge of
    // the ENTIRE site, loaded every turn in every mode. Tier 2 is
    // the read/inspect tools, used when a question or edit needs
    // full detail beyond the map.
    ...(siteContext
      ? [
          {
            role: 'system',
            content: `WHOLE-SITE CONTEXT — Tier 1 map of this site (your standing knowledge; it covers every page, the current design/styles, modules and their key content, and the business basics):\n${String(siteContext).slice(0, 8000)}\nGround what you say about the site in this context or in what the read tools return — never invent content, prices, or details. If neither covers something, fetch it with the tools or say you don't see it on the site.`,
          },
        ]
      : []),
    ...normalizePortalHistory(history, message, modelImages, runMode === 'build' ? 'build' : 'discuss'),
  ];

  let steps = 0;
  let toolCalls = 0;
  let totalCost = 0;
  let mutated = false;
  let published = false;
  let lastError = null;
  let finalReply = '';
  const consecutiveToolErrors = { n: 0 };
  let nudged = false;
  // Batch 89: if the model endpoint rejects the vision parts, the turn
  // retries ONCE with the images stripped and a note saying the files are
  // saved with the conversation — the design work continues instead of
  // the whole chat failing, and the result reports imagesDropped so the
  // caller never claims the model saw images it did not.
  let visionDropped = false;
  const stripImageParts = () => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === 'user' && Array.isArray(m.content)) {
        const textPart = m.content.find((p) => p && p.type === 'text');
        m.content =
          (textPart ? String(textPart.text) : '') +
          '\n\n[Note: the attached image(s) could not be shown to you directly. They are saved with this conversation as design-chat attachments — staff can open them from the lead record. Work from the written description.]';
        break;
      }
    }
  };

  const logStep = (promptTokens, completionTokens, step) => {
    domain.withDb(workspaceId, (d) => {
      const use = db || d;
      const per1kPrompt = parseFloat(getDbSetting(use, 'cost.per_1k_prompt', '0.0015')) || 0;
      const per1kCompletion = parseFloat(getDbSetting(use, 'cost.per_1k_completion', '0.002')) || 0;
      const costUsd = (promptTokens / 1000) * per1kPrompt + (completionTokens / 1000) * per1kCompletion;
      totalCost += costUsd;
      logUsage(use, {
        task: 'portal_agent',
        provider: providerForConfig(config),
        model: config.model,
        promptTokens,
        completionTokens,
        costUsd,
        leadId: lid,
        note: `portal muse step ${step}`,
      });
    });
  };

  while (steps < stepCap) {
    if (budget > 0) {
      const nowSpent = domain.withDb(workspaceId, (d) => todaySpendUsd(db || d));
      if (nowSpent >= budget) {
        lastError = 'budget_exceeded';
        break;
      }
    }

    steps++;
    let data;
    try {
      data = await chatCompletions(config, {
        model: config.model,
        messages,
        tools,
        tool_choice: 'auto',
        max_tokens: 4096,
      });
    } catch (e) {
      if (modelImages.length && !visionDropped) {
        visionDropped = true;
        stripImageParts();
        try {
          data = await chatCompletions(config, {
            model: config.model,
            messages,
            tools,
            tool_choice: 'auto',
            max_tokens: 4096,
          });
        } catch (e2) {
          lastError = e2.code || 'MUSE_REQUEST_FAILED';
          break;
        }
      } else {
        lastError = e.code || 'MUSE_REQUEST_FAILED';
        break;
      }
    }

    const usage = (data && data.usage) || {};
    logStep(Number(usage.prompt_tokens) || 0, Number(usage.completion_tokens) || 0, steps);

    const choice = data.choices && data.choices[0];
    const msg = (choice && choice.message) || {};
    const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];

    if (!calls.length) {
      finalReply = msg.content != null ? String(msg.content).trim() : '';
      messages.push({ role: 'assistant', content: finalReply });
      // Batch 93: the apply-the-change nudge exists only in build
      // mode — in answer / clarify modes a plain reply IS the goal.
      if (runMode === 'build' && !mutated && !nudged && steps < stepCap) {
        nudged = true;
        messages.push({
          role: 'user',
          content: 'Use tools to apply the change (or explain briefly if you cannot). Call site.publish after edits.',
        });
        continue;
      }
      break;
    }

    messages.push({
      role: 'assistant',
      content: msg.content != null ? msg.content : null,
      tool_calls: calls,
    });

    for (const tc of calls) {
      const wireName = String((tc.function && tc.function.name) || '').trim();
      const name = toolNames.get(wireName);
      let args = {};
      try {
        args = JSON.parse((tc.function && tc.function.arguments) || '{}');
      } catch {
        args = {};
      }
      if (!args.leadId) args.leadId = lid;
      else args.leadId = lid; // pin to session lead

      if (!name || DENY_TOOLS.has(name)) {
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify({ ok: false, error: `Tool ${name} is not allowed in portal chat.` }),
        });
        consecutiveToolErrors.n++;
        continue;
      }

      // Batch 93: second fence layer — even if a write tool's wire
      // name somehow resolves in a read-only mode, it is refused here
      // and never reaches mcp.callTool.
      if (!portalModeAllowsTool(runMode, name)) {
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify({
            ok: false,
            error: 'That tool is not available on this turn — this chat turn is read-only and cannot change the site.',
          }),
        });
        consecutiveToolErrors.n++;
        continue;
      }

      // Batch 98: the plan sandbox at dispatch — a mutating tool
      // the plan does not name is refused with a structured
      // NOT_IN_PLAN error and never reaches mcp.callTool, even if
      // its wire name somehow resolved into the offered catalog.
      if (planToolSet && !PORTAL_READONLY_TOOLS.has(name) && !planToolSet.has(name)) {
        planViolations++;
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify({
            ok: false,
            error: `NOT_IN_PLAN: ${name} is not one of this change's planned steps. Execute only the plan's steps, in order.`,
          }),
        });
        consecutiveToolErrors.n++;
        continue;
      }

      toolCalls++;
      let outcome;
      try {
        outcome = await mcp.callTool(workspaceId, name, args, { leadId: lid });
      } catch (e) {
        outcome = { ok: false, error: e.message || String(e) };
      }

      if (!outcome || outcome.ok === false) {
        consecutiveToolErrors.n++;
        recordStepResult(name, false, outcome && outcome.error ? outcome.error : 'tool failed');
      } else {
        consecutiveToolErrors.n = 0;
        if (PORTAL_MUTATE_TOOLS.has(name)) mutated = true;
        if (name === 'site.publish') published = true;
        recordStepResult(name, true, null);
      }

      const compact = JSON.stringify(outcome);
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: compact.length > 24000 ? compact.slice(0, 24000) + '…[truncated]' : compact,
      });
    }

    if (consecutiveToolErrors.n >= 8) {
      lastError = 'repeated_tool_errors';
      break;
    }
  }

  if (mutated && !published) {
    try {
      const pub = await mcp.callTool(workspaceId, 'site.publish', { leadId: lid }, { leadId: lid });
      if (pub && pub.ok !== false) published = true;
    } catch (e) {
      console.warn('[museAgent] portal auto-publish:', e.message || e);
    }
  }

  if (!finalReply) {
    if (runMode === 'answer') {
      finalReply = lastError
        ? 'I could not pull an answer together for that just now — please try asking again.'
        : 'I looked at your site but could not form an answer — try asking a different way.';
    } else if (runMode === 'clarify') {
      finalReply =
        'Before I change anything, tell me a little more about what you would like — what should change, and where on the site?';
    } else {
      finalReply = mutated
        ? 'Done — I updated your site. Check the preview on the right.'
        : lastError
          ? 'I could not finish that change. Try rephrasing, or use Edit for a quick text tweak.'
          : 'I looked at your site but did not apply a change. Try a more specific request.';
    }
  }

  return {
    ok: !lastError || mutated,
    reply: finalReply.slice(0, 4000),
    steps,
    toolCalls,
    mutated,
    published,
    mode: runMode,
    error: lastError,
    costUsd: totalCost,
    model: config.model,
    // Batch 89: honest accounting of the attached images — the caller
    // (and the report) can tell whether the model actually received them.
    attachments: modelImages.length,
    imagesSent: modelImages.length > 0 && !visionDropped,
    imagesDropped: visionDropped,
    // Batch 98: the implementor's account of the plan — per-step
    // outcomes the reviewer (Batch 99) and the transcript can
    // rely on structurally, not from the reply prose.
    stepResults: activePlan ? stepResults : null,
    planComplete: activePlan ? stepResults.every((r) => r.status === 'done') : null,
    planViolations,
  };
}

module.exports = {
  resolveMuseConfig,
  museConfigured,
  runJobLoop,
  runPortalImproveLoop,
  classifyPortalChatIntent,
  planPortalChange,
  buildPlannerSystemPrompt,
  PORTAL_DESIGN_TOOLS,
  PORTAL_DESIGN_WRITE_TOOLS,
  buildClassifierSystemPrompt,
  normalizePortalHistory,
  portalModeAllowsTool,
  PORTAL_READONLY_TOOLS,
  PORTAL_MUTATE_TOOLS,
  DENY_TOOLS,
  MAX_STEPS,
  MAX_PORTAL_STEPS,
};
