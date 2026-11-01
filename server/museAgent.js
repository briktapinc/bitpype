'use strict';

/**
 * Meta Muse Model API agent loop for Hands-off mode.
 * OpenAI-compatible chat/completions + tools → server/mcp.js callTool (workspace scope).
 *
 * Batch 111 (consolidation step 4): the tool catalogues, provider
 * plumbing, intent classifier and planner now live in focused
 * modules (museAgentTools / museAgentCore / museAgentClassifier /
 * museAgentPlanner) — pure code motion, verified byte-for-byte;
 * the two agent loops and their system-prompt builders stay here,
 * and every original export is re-exported below.
 */

const { defaultWebsiteInstructions } = require('../src/defaultDesignInstructions');
const chatPlanner = require('./siteChatPlanner');
const { portalCapabilityText } = require('./portalCapabilities');
const museAgentTools = require('./museAgentTools');
const museAgentCore = require('./museAgentCore');
const museAgentClassifier = require('./museAgentClassifier');
const museAgentPlanner = require('./museAgentPlanner');
const { MAX_STEPS, MAX_PORTAL_STEPS, PORTAL_MUTATE_TOOLS, DENY_TOOLS, PORTAL_READONLY_TOOLS, PORTAL_MODE_STEPS, portalModeAllowsTool } = museAgentTools;
const { fail, getDbSetting, resolveMuseConfig, museConfigured, todaySpendUsd, providerForConfig, logUsage, mcpToolsToOpenAi, chatCompletions } = museAgentCore;

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

/**
 * @param {any} workspaceId
 * @param {any} job
 * @param {{ db?: any, maxSteps?: number }} [opts]
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
      /** @type {Record<string, any>} */
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
 * @param {any} workspaceId
 * @param {any} leadId
 * @param {{ db?: any, message?: string, history?: any[], pageSlug?: string, images?: any[], mode?: string, clarifyAbout?: string, clarifyKind?: string, clarifySettled?: any[], clarifyPriorQa?: any, clarifyRound?: number, siteContext?: string, maxSteps?: number, plan?: any }} [opts]
 * @returns {Promise<{ ok: any, reply: any, steps: any, toolCalls: any, mutated: any, published: any, error?: any, costUsd: any, model: any, mode?: any, attachments?: any, imagesSent?: any, imagesDropped?: any, stepResults?: any }>}
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
  /** @type {Array<{ role: string, content: any, tool_calls?: any, tool_call_id?: string }>} */
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
      /** @type {Record<string, any>} */
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
  resolveMuseConfig: museAgentCore.resolveMuseConfig,
  museConfigured: museAgentCore.museConfigured,
  runJobLoop,
  runPortalImproveLoop,
  classifyPortalChatIntent: museAgentClassifier.classifyPortalChatIntent,
  planPortalChange: museAgentPlanner.planPortalChange,
  buildPlannerSystemPrompt: museAgentPlanner.buildPlannerSystemPrompt,
  PORTAL_DESIGN_TOOLS: museAgentTools.PORTAL_DESIGN_TOOLS,
  PORTAL_DESIGN_WRITE_TOOLS: museAgentTools.PORTAL_DESIGN_WRITE_TOOLS,
  buildClassifierSystemPrompt: museAgentClassifier.buildClassifierSystemPrompt,
  normalizePortalHistory,
  portalModeAllowsTool: museAgentTools.portalModeAllowsTool,
  PORTAL_READONLY_TOOLS: museAgentTools.PORTAL_READONLY_TOOLS,
  PORTAL_MUTATE_TOOLS: museAgentTools.PORTAL_MUTATE_TOOLS,
  DENY_TOOLS: museAgentTools.DENY_TOOLS,
  MAX_STEPS: museAgentTools.MAX_STEPS,
  MAX_PORTAL_STEPS: museAgentTools.MAX_PORTAL_STEPS,
};
