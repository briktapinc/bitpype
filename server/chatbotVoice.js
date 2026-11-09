// Batch 168: guarded timeout signal — some VM-sandboxed test hosts
// lack the AbortSignal global; production Node always has it.
const abortAfter = (ms) =>
  typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(ms)
    : undefined;

'use strict';

/**
 * Batch 138 — AI VOICE AGENT for client sites (Ely, 2026-11-04: "Add an
 * AI voice agent that can be activated, works exactly like the chat but
 * uses OpenAI Realtime stream. It can be placed on the site as a bubble.
 * Allow the user in the portal to upload an image that appears in that
 * bubble. Once the bubble is clicked, the voice agent authorizes the
 * microphone and begins the chat.").
 *
 * Shape of the feature:
 * - Voice is part of the existing chatbot module — no new module type,
 *   no new entitlement: it rides plans' `chatbot` entitlement exactly
 *   like text chat. Settings (on/off, voice, bubble image) live in the
 *   chatbot settings store (settings_json extras).
 * - The browser NEVER sees the platform OpenAI key. This module mints
 *   a short-lived Realtime client secret server-side
 *   (POST /v1/realtime/client_secrets) with the full session config
 *   (instructions + tools) baked in, and returns only the ephemeral
 *   credential. The browser then exchanges SDP directly with OpenAI
 *   (POST /v1/realtime/calls) over WebRTC.
 * - The session config's instructions come from the SAME context
 *   assembly as the text AI fallback (chatbot.buildAssistantContext),
 *   with Batch 136's booking pitch and Batch 137's qualifying
 *   questions composed in through marked seams.
 * - Actions over voice are Realtime function calls. They arrive at the
 *   browser over the data channel and are relayed to this module,
 *   which executes the SAME server functions the text chat uses
 *   (chatbot.captureLead / chatbot.escalateSession) — no second
 *   implementation. The relay is authorized by a per-session relay
 *   secret (only its sha256 hash is stored) bound to the session row
 *   and the embed token's lead.
 * - EVERY voice conversation is saved (Ely's standing requirement):
 *   the client relays both sides' transcripts (Realtime transcription
 *   events) to this module, which appends them as message rows on a
 *   chatbot_sessions row with channel='voice', in conversation order,
 *   with outcomes (capture / escalation / qualification) attached
 *   through the same paths as text chat. The owner reviews them in the
 *   same portal inbox / session surfaces as text chats.
 * - NO AUDIO IS RECORDED OR RETAINED in v1 — transcript text only.
 *   (Audio retention is an open product/legal call for Ely: storage
 *   growth per minute of audio, and recording-consent law varies by
 *   state — PA is two-party consent — so it stays OFF.)
 * - Metering: a completed session writes one ai_usage row
 *   (task 'chatbot.voice', provider 'openai') with cost estimated from
 *   duration at the documented per-token audio rates (constants
 *   below). A session that never connects writes nothing.
 *
 * OpenAI Realtime facts verified against developers.openai.com
 * (API reference + Realtime guides) and openai.com/api/pricing on
 * 2026-11-04:
 * - Mint: POST /v1/realtime/client_secrets { expires_after:
 *   { anchor:'created_at', seconds: 10..7200 }, session: {...} }
 *   → { value: 'ek_…', expires_at, session }. (The legacy beta
 *   POST /v1/realtime/sessions shape is superseded.)
 * - Browser connect: RTCPeerConnection + 'oai-events' data channel,
 *   SDP offer POSTed to /v1/realtime/calls with the ephemeral key.
 * - GA session shape nests audio config: audio.input.{format,
 *   turn_detection, transcription, noise_reduction} and
 *   audio.output.{format, voice}; instructions/tools stay top-level.
 * - Voices: alloy, ash, ballad, coral, echo, sage, shimmer, verse,
 *   marin, cedar (marin/cedar recommended).
 * - Max session duration: 60 minutes.
 * - Transcript events: conversation.item.input_audio_transcription
 *   .completed (visitor), response.output_audio_transcript.done
 *   (agent); tool calls: response.function_call_arguments.done,
 *   answered with conversation.item.create { type:
 *   'function_call_output' } + response.create.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const chatbot = require('./chatbot');
const attachments = require('./siteChatAttachments');

/* ── Documented constants ─────────────────────────────────────────── */

const REALTIME_MODEL = 'gpt-realtime-2.1';
const CLIENT_SECRETS_PATH = '/realtime/client_secrets';
const REALTIME_CALLS_URL = 'https://api.openai.com/v1/realtime/calls';
/** The secret only has to live until the browser connects. */
const EPHEMERAL_TTL_SEC = 120;
/**
 * Platform session cap: 10 minutes. OpenAI's hard session limit is 60
 * minutes (Realtime guides, checked 2026-11-04); the platform cap is a
 * cost/abuse control well under it. FLAGGED as Ely's product call —
 * raise/lower this one constant to change it.
 */
const VOICE_MAX_SESSION_SEC = 600;
/** Input transcription model for the visitor-side transcript. */
const TRANSCRIPTION_MODEL = 'gpt-4o-transcribe';

/**
 * Metering rates — OpenAI pricing page (openai.com/api/pricing),
 * checked 2026-11-04: gpt-realtime-2.1 audio input $32 / 1M tokens,
 * audio output $64 / 1M tokens. OpenAI tokenizes user audio at
 * ~600 tokens/minute of speech and model audio at ~1200 tokens/minute
 * of speech. The estimate assumes an even talk split over the session
 * duration, i.e. per session-minute:
 *   0.5 × 600 × $32/1M + 0.5 × 1200 × $64/1M = $0.048/min.
 * It is an ESTIMATE for Admin spend visibility (the platform does not
 * receive per-response usage for browser-direct WebRTC sessions);
 * OpenAI's own invoice remains the billing truth.
 */
const AUDIO_INPUT_TOKENS_PER_MIN = 600;
const AUDIO_OUTPUT_TOKENS_PER_MIN = 1200;
const AUDIO_INPUT_USD_PER_1M = 32;
const AUDIO_OUTPUT_USD_PER_1M = 64;

function estimateVoiceTokens(durationSec) {
  const minutes = Math.max(0, Number(durationSec) || 0) / 60;
  return {
    promptTokens: Math.round(minutes * 0.5 * AUDIO_INPUT_TOKENS_PER_MIN),
    completionTokens: Math.round(minutes * 0.5 * AUDIO_OUTPUT_TOKENS_PER_MIN),
  };
}

function estimateVoiceCostUsd(durationSec) {
  const { promptTokens, completionTokens } = estimateVoiceTokens(durationSec);
  return (
    (promptTokens / 1_000_000) * AUDIO_INPUT_USD_PER_1M +
    (completionTokens / 1_000_000) * AUDIO_OUTPUT_USD_PER_1M
  );
}

/* ── Helpers ──────────────────────────────────────────────────────── */

function fail(code, message, status) {
  const err = new Error(message);
  err.code = code;
  if (status) err.status = status;
  return err;
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

/* ── OpenAI platform key / base URL ───────────────────────────────── */

/**
 * Platform-first, workspace fallback — the museAgentCore precedent:
 * Admin → API keys stores the platform `ai.api_key`; a workspace-level
 * `ai.api_key` setting is the fallback. The key is used ONLY for the
 * server-side client_secrets mint and never leaves this module.
 */
async function resolveOpenAiConfig(db) {
  let apiKey = '';
  let baseUrl = '';
  try {
    const platform = require('./platform');
    apiKey = String((await platform.getPlatformSetting('ai.api_key', '')) || '').trim();
    baseUrl = String((await platform.getPlatformSetting('ai.base_url', '')) || '').trim();
  } catch {
    /* platform store unavailable — fall through to workspace */
  }
  if (db && typeof db.prepare === 'function') {
    try {
      const ai = require('../src/ai');
      if (!apiKey) apiKey = String(ai.getSetting('ai.api_key', '', db) || '').trim();
      if (!baseUrl) baseUrl = String(ai.getSetting('ai.base_url', '', db) || '').trim();
    } catch {
      /* workspace settings unavailable */
    }
  }
  return { apiKey, baseUrl: (baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '') };
}

/** Voice rides the chatbot entitlement — no separate tier (Batch 138). */
async function planAllowsChatbot(workspaceId) {
  try {
    const billing = require('./billing');
    const { getPlan } = require('./plans');
    const planId = await billing.effectivePlan(Number(workspaceId));
    return !!getPlan(planId).entitlements.chatbot;
  } catch {
    return false;
  }
}

/**
 * The full voice gate, shared by the public advertisement and the
 * mint: embed published + enabled (via getPublicConfigByToken, which
 * also refuses archived sites), owner turned voice on, plan carries
 * the chatbot entitlement, and an OpenAI key is configured in Admin.
 */
async function voiceAvailability(workspaceId, db, token) {
  let cfg;
  try {
    cfg = chatbot.getPublicConfigByToken(db, token);
  } catch (e) {
    return { ok: false, error: e };
  }
  const leadId = Number(cfg.embed.lead_id);
  const settings = chatbot.getSettings(db, leadId);
  if (!settings.voice_enabled) {
    return { ok: false, error: fail('VOICE_DISABLED', 'Voice is not enabled for this site', 403) };
  }
  if (!(await planAllowsChatbot(workspaceId))) {
    return {
      ok: false,
      error: fail('PLAN_REQUIRED', 'Voice requires a plan with the chatbot included', 403),
    };
  }
  const { apiKey } = await resolveOpenAiConfig(db);
  if (!apiKey) {
    return { ok: false, error: fail('AI_NOT_CONFIGURED', 'Voice is not configured yet', 503) };
  }
  return { ok: true, leadId, settings, cfg };
}

/** What the public chat config advertises about voice (no internals). */
async function publicVoiceAdvertisement(workspaceId, db, token) {
  const a = await voiceAvailability(workspaceId, db, token);
  if (!a.ok) return { enabled: false };
  return {
    enabled: true,
    voice: a.settings.voice_name,
    max_duration_sec: VOICE_MAX_SESSION_SEC,
    bubble_image_url: a.settings.voice_bubble_image
      ? `/api/v1/chat/public/${encodeURIComponent(String(token))}/voice-image`
      : null,
  };
}

/* ── Instructions: the shared context + voice action guidance ────── */

/**
 * BATCH 136 SEAM — booking pitch. Batch 136 declares the pitch through
 * the shared module layer (bookings declares, chat consumes: a
 * `getBookingPitch` accessor / registry declaration on the bookings
 * entry). When it is present, its text is composed into the voice
 * instructions VERBATIM — the pitch is present by module state only,
 * never by any judgment about the visitor, and its discount wording
 * comes from the declaration itself. On the pre-136 base this returns
 * '' and voice simply has no pitch block.
 */
function bookingPitchBlock(db, leadId) {
  try {
    const share = require('./moduleShare');
    if (typeof share.getBookingPitch === 'function') {
      const pitch = share.getBookingPitch(db, Number(leadId));
      const text =
        typeof pitch === 'string'
          ? pitch
          : pitch && (pitch.text || pitch.pitch || pitch.block)
            ? String(pitch.text || pitch.pitch || pitch.block)
            : '';
      if (text.trim()) return text.trim();
    }
    const reg = share.SHARE_REGISTRY && share.SHARE_REGISTRY.bookings;
    const decl = reg && (reg.declarations || reg.declares || null);
    if (decl && typeof decl.pitch === 'function') {
      const text = decl.pitch(db, Number(leadId));
      if (text && String(text).trim()) return String(text).trim();
    }
  } catch {
    /* shared layer unavailable — no pitch block */
  }
  return '';
}

/**
 * BATCH 137 SEAM — owner qualifying questions. Batch 137 stores the
 * owner's own questions on the chatbot settings (settings_json extras,
 * surfaced by getSettings) and gates them through
 * chatbot.qualifyingFor — the SAME reader the text chat composes
 * with: the feature speaks only when the owner enabled it AND the
 * list is non-empty. When active, the questions are composed here
 * VERBATIM — the voice agent asks the owner's words, never invented
 * screening questions — and answers come back through the
 * record_qualification_answer tool.
 *
 * Finisher rebase note (Batch 149 tip): the parked build read the
 * settings leniently (questions present = on). The landed 137 gate
 * wins — voice must never ask questions the owner switched off —
 * so this block composes through qualifyingFor exactly like text.
 */
function qualifyingQuestionsBlock(db, leadId) {
  let cfg = null;
  try {
    cfg = typeof chatbot.qualifyingFor === 'function' ? chatbot.qualifyingFor(db, Number(leadId)) : null;
  } catch {
    cfg = null;
  }
  if (!cfg || !Array.isArray(cfg.questions) || !cfg.questions.length) return '';
  const questions = cfg.questions.slice(0, 6);
  return [
    'Qualifying questions from the business owner — weave these into the conversation naturally, one at a time, only when relevant; skip any the visitor already answered; never let them block help or booking:',
    ...questions.map((q, i) => `${i + 1}. ${q}`),
    'When the visitor answers one, call record_qualification_answer with the exact question text and their answer.',
  ].join('\n');
}

/**
 * The Realtime session instructions: the SAME business context the
 * text AI fallback briefs from (chatbot.buildAssistantContext), plus
 * the 136/137 composed blocks, plus voice-specific action guidance.
 */
function buildVoiceInstructions(db, leadId) {
  const ctx = chatbot.buildAssistantContext(db, Number(leadId), { query: '' });
  const bizName = (ctx.business && ctx.business.businessName) || 'this business';
  const bizBlock = (ctx.business && ctx.business.text) || `Business name: ${bizName}`;
  const knowledgeBlock =
    ctx.knowledge && ctx.knowledge.count > 0 ? ctx.knowledge.text : '(no knowledge files uploaded yet)';
  const blocks = [
    `You are the voice assistant for ${bizName}, speaking with a visitor on their website. Speak naturally and briefly, as their website support — not a generic AI. Greet the visitor first and ask how you can help.`,
    'Business profile (you may share contact/identity when asked):',
    bizBlock,
    'Knowledge excerpts — factual claims (services, pricing, policies, availability) ONLY from these excerpts, the site content excerpts below, and the business profile. Do not invent facts:',
    knowledgeBlock,
  ];
  // Batch 151: the owner's selected module + page sources — the
  // SAME digest text the text chat briefs from (one brain, one
  // buildAssistantContext), including the Batch 139 price book when
  // the Pricing source is on.
  if (ctx.sources && ctx.sources.text) {
    blocks.push(
      'Site content excerpts — also from the business’s own modules and pages, labelled by source:',
      ctx.sources.text
    );
  }
  const pitch = bookingPitchBlock(db, leadId);
  if (pitch) blocks.push(pitch);
  const qualifying = qualifyingQuestionsBlock(db, leadId);
  if (qualifying) blocks.push(qualifying);
  blocks.push(
    [
      'Actions you can take while speaking:',
      '- When the visitor wants the business to follow up, or you cannot resolve their need, collect their name and an email or phone number conversationally, then call capture_lead with what they gave you. Tell them the team will follow up.',
      '- When the visitor asks for a human, is frustrated, or the need is clearly beyond you, call escalate_to_team and reassure them a team member will follow up.',
      '- Booking: if a booking offer was described above, state its terms plainly and direct the visitor to the booking flow on this website to complete it. You never take payment or complete a booking yourself.',
      '- Keep answers short — this is a spoken conversation. Ask one question at a time.',
    ].join('\n')
  );
  return blocks.join('\n\n');
}

/* ── Realtime tools (mirrors of the text chat's real actions) ────── */

const VOICE_TOOLS = [
  {
    type: 'function',
    name: 'capture_lead',
    description:
      "Save the visitor's contact details so the business can follow up — the same lead capture as the text chat. Call once you have a name plus an email or phone number.",
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: "The visitor's name" },
        email: { type: 'string', description: "The visitor's email address" },
        phone: { type: 'string', description: "The visitor's phone number" },
        message: { type: 'string', description: 'What the visitor needs, in a sentence' },
      },
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'escalate_to_team',
    description:
      'Hand the conversation to the business team (portal inbox escalation) — the same escalation as the text chat. Use when the visitor asks for a human or the need is beyond you.',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Summary of what the visitor needs' },
        reason: { type: 'string', description: 'Short reason for the escalation' },
      },
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'record_qualification_answer',
    description:
      "Record the visitor's answer to one of the owner's qualifying questions, using the exact question text.",
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The qualifying question, exactly as written' },
        answer: { type: 'string', description: "The visitor's answer" },
      },
      required: ['question', 'answer'],
      additionalProperties: false,
    },
  },
];

/** The GA session config baked into the client secret at mint time. */
function buildRealtimeSessionConfig(db, leadId, settings) {
  return {
    type: 'realtime',
    model: REALTIME_MODEL,
    instructions: buildVoiceInstructions(db, Number(leadId)),
    output_modalities: ['audio'],
    audio: {
      input: {
        format: { type: 'audio/pcm', rate: 24000 },
        turn_detection: {
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 700,
          create_response: true,
        },
        transcription: { model: TRANSCRIPTION_MODEL },
        noise_reduction: { type: 'near_field' },
      },
      output: {
        format: { type: 'audio/pcm', rate: 24000 },
        voice: settings.voice_name || 'marin',
      },
    },
    tools: VOICE_TOOLS,
    tool_choice: 'auto',
  };
}

/* ── Session mint ─────────────────────────────────────────────────── */

/**
 * Mint a voice session: gate → create the stored session row → call
 * OpenAI's client_secrets endpoint with the platform key → return
 * ONLY the ephemeral credential + model/voice + platform session id +
 * per-session relay secret. The platform key appears nowhere in the
 * return value (pinned by the Batch 138 suite).
 */
async function mintVoiceSession(workspaceId, db, token, { visitor } = {}) {
  const a = await voiceAvailability(workspaceId, db, token);
  if (!a.ok) throw a.error;
  /* Batch 168 (S7#1): the mint is UNAUTHENTICATED (the embed token
   * is public — it is printed in every page of the site) and it
   * spends the platform/workspace OpenAI key, yet it ran with NO
   * budget gate at all — the text path refuses at
   * cost.daily_budget_usd (default $10/day/workspace, src/ai.js).
   * A workspace 50× over budget minted unlimited sessions. Enforce
   * the same budget here, evaluated against RECORDED spend PLUS a
   * reservation for every voice session minted today whose metering
   * row has not landed yet (a client that never relays its
   * transcript writes no ai_usage row, so recorded spend alone
   * under-counts exactly the abusive case). Each open session
   * reserves its capped worst case at the metering rate
   * (VOICE_MAX_SESSION_SEC). The reservation is accounting only —
   * endVoiceSession still writes the one real usage row. */
  try {
    const core = require('./museAgentCore');
    const budget = parseFloat(core.getDbSetting(db, 'cost.daily_budget_usd', '10')) || 0;
    if (budget > 0) {
      chatbot.ensureTables(db);
      const openToday = db
        .prepare(
          `SELECT COUNT(*) AS c FROM chatbot_sessions
           WHERE channel = 'voice' AND date(created_at) = date('now') AND voice_ended_at IS NULL`
        )
        .get().c;
      const reserved = Number(openToday || 0) * estimateVoiceCostUsd(VOICE_MAX_SESSION_SEC);
      if (core.todaySpendUsd(db) + reserved >= budget) {
        throw fail('BUDGET_EXCEEDED', "Today's AI budget for this workspace has been reached. Try again tomorrow.");
      }
    }
  } catch (e) {
    if (e && e.code === 'BUDGET_EXCEEDED') throw e;
    /* budget plumbing must never take voice down with it */
  }
  const { apiKey, baseUrl } = await resolveOpenAiConfig(db);
  /* Batch 168 (S5#6): the platform key rides this request as a
   * Bearer — run the same base-URL guard every other key transport
   * runs (https + public resolution; a redirect would carry the key
   * to an unvalidated target, so redirects are refused outright). */
  try {
    await require('./urlSafety').assertAiBaseUrl(baseUrl);
  } catch {
    throw fail('VOICE_UPSTREAM', 'Voice is unavailable right now — please use the text chat instead', 502);
  }
  const sessionConfig = buildRealtimeSessionConfig(db, a.leadId, a.settings);

  chatbot.ensureTables(db);
  const relaySecret = crypto.randomBytes(24).toString('base64url');
  const sessionToken = crypto.randomBytes(24).toString('base64url');
  const info = db
    .prepare(
      `
      INSERT INTO chatbot_sessions (
        lead_id, session_token, status, needs_agent, visitor_meta_json,
        channel, voice_state, voice_started_at, voice_relay_hash, voice_model, voice_voice_name
      ) VALUES (?, ?, 'open', 0, ?, 'voice', 'minted', datetime('now'), ?, ?, ?)
    `
    )
    .run(
      a.leadId,
      sessionToken,
      visitor != null ? JSON.stringify(visitor) : null,
      sha256Hex(relaySecret),
      REALTIME_MODEL,
      a.settings.voice_name || 'marin'
    );
  const sessionId = Number(info.lastInsertRowid);

  let data = null;
  try {
    const resp = await fetch(`${baseUrl}${CLIENT_SECRETS_PATH}`, {
      method: 'POST',
      redirect: 'error',
      signal: abortAfter(30000),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        expires_after: { anchor: 'created_at', seconds: EPHEMERAL_TTL_SEC },
        session: sessionConfig,
      }),
    });
    data = await resp.json().catch(() => null);
    if (!resp.ok || !data || !data.value) {
      throw new Error(`client_secrets mint failed (HTTP ${resp.status})`);
    }
  } catch (e) {
    // No credential ever reached a browser, so no conversation can
    // exist — remove the row rather than leaving a phantom session.
    try {
      db.prepare('DELETE FROM chatbot_sessions WHERE id = ?').run(sessionId);
    } catch {
      /* best-effort */
    }
    throw fail('VOICE_UPSTREAM', 'Voice is unavailable right now — please use the text chat instead', 502);
  }

  try {
    db.prepare(
      "UPDATE chatbot_sessions SET voice_state = 'active', voice_openai_session_id = ? WHERE id = ?"
    ).run(data.session && data.session.id ? String(data.session.id) : null, sessionId);
  } catch {
    /* the session is usable without the upstream id recorded */
  }

  return {
    session: { id: sessionId, session_token: sessionToken },
    ephemeral: { value: String(data.value), expires_at: data.expires_at || null },
    model: REALTIME_MODEL,
    voice: a.settings.voice_name || 'marin',
    max_duration_sec: VOICE_MAX_SESSION_SEC,
    relay_secret: relaySecret,
    calls_url: REALTIME_CALLS_URL,
  };
}

/* ── Relay authorization ──────────────────────────────────────────── */

/**
 * Every relay call (tool / transcript / end) funnels through here:
 * the embed token binds the lead (published + enabled + not archived,
 * via getPublicConfigByToken), the session must be that lead's voice
 * session, and the relay secret must hash-match the stored hash
 * (timing-safe). The secret itself is never stored or logged.
 */
function getVoiceSessionForRelay(db, token, sessionId, relaySecret) {
  const cfg = chatbot.getPublicConfigByToken(db, token);
  const leadId = Number(cfg.embed.lead_id);
  chatbot.ensureTables(db);
  const row = db
    .prepare('SELECT * FROM chatbot_sessions WHERE id = ?')
    .get(Number(sessionId));
  if (!row || Number(row.lead_id) !== leadId || (row.channel || 'text') !== 'voice') {
    throw fail('NOT_FOUND', 'Voice session not found', 404);
  }
  const presented = Buffer.from(sha256Hex(relaySecret || ''));
  const stored = Buffer.from(String(row.voice_relay_hash || ''));
  if (presented.length !== stored.length || !crypto.timingSafeEqual(presented, stored)) {
    throw fail('FORBIDDEN', 'Invalid voice session credential', 403);
  }
  return { cfg, leadId, row };
}

/* ── Tool relay ───────────────────────────────────────────────────── */

/**
 * BATCH 137 SEAM — qualification answers. When the feature is active
 * for this lead, the answer lands in Batch 137's structured record
 * (chatbot.recordQualificationUpdates — question text matched against
 * the session's snapshot, shown in the portal inbox exactly like a
 * text-chat answer). Either way the answer is ALSO preserved as a
 * system transcript note with the question + answer in meta, so the
 * saved voice conversation itself shows how the visitor qualified.
 *
 * Finisher rebase note (Batch 149 tip): the parked build probed for
 * a hypothetical chatbot.recordQualificationAnswer that the landed
 * 137 never shipped; the real recorder is recordQualificationUpdates.
 */
function recordQualificationAnswer(db, leadId, sessionRow, { question, answer } = {}) {
  const q = String(question || '').trim().slice(0, 500);
  const ans = String(answer || '').trim().slice(0, 2000);
  if (!q || !ans) return { ok: false, error: 'question and answer are required' };
  let structured = false;
  try {
    const cfg = typeof chatbot.qualifyingFor === 'function' ? chatbot.qualifyingFor(db, Number(leadId)) : null;
    if (cfg && typeof chatbot.recordQualificationUpdates === 'function') {
      const rec = chatbot.recordQualificationUpdates(db, Number(leadId), sessionRow.id, [
        { question: q, status: 'answered', answer: ans },
      ]);
      structured = !!(rec && rec.applied > 0);
    }
  } catch {
    structured = false;
  }
  chatbot.addMessage(db, sessionRow.id, Number(leadId), 'system', `Qualifying question — ${q}\nAnswer: ${ans}`, {
    source: 'voice',
    kind: 'qualification',
    question: q,
    answer: ans,
  });
  return { ok: true, recorded: true, structured };
}

/**
 * Execute one Realtime function call with the SAME server functions
 * the text chat uses. Returns { result, notify? } — `result` is what
 * the browser hands back to the model as the function_call_output;
 * `notify` is the captureLead owner-notification payload the route
 * fires exactly like the text /lead route. Unknown tools are refused
 * with a model-readable result (never executed, never thrown).
 */
function relayVoiceToolCall(db, token, sessionId, relaySecret, { name, args } = {}) {
  const { leadId, row } = getVoiceSessionForRelay(db, token, sessionId, relaySecret);
  let parsed = args;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed || '{}');
    } catch {
      throw fail('VALIDATION', 'tool arguments must be valid JSON', 400);
    }
  }
  if (!parsed || typeof parsed !== 'object') parsed = {};

  if (name === 'capture_lead') {
    const data = chatbot.captureLead(db, token, {
      name: parsed.name || '',
      email: parsed.email || '',
      phone: parsed.phone || '',
      message: parsed.message || '',
      session: row.session_token,
    });
    const notify = data && data._notify ? data._notify : null;
    return {
      result: { ok: true, captured: true, message: 'Thanks — we will follow up shortly.' },
      notify,
    };
  }
  if (name === 'escalate_to_team') {
    chatbot.escalateSession(db, leadId, {
      sessionId: row.id,
      message: parsed.message || '',
      reason: parsed.reason || 'voice_request',
    });
    return { result: { ok: true, escalated: true } };
  }
  if (name === 'record_qualification_answer') {
    return { result: recordQualificationAnswer(db, leadId, row, parsed) };
  }
  return { result: { ok: false, error: 'unknown_tool' } };
}

/* ── Transcript relay + session end (every conversation is saved) ── */

/** One ai_usage row per connected voice session (see rate constants). */
function recordVoiceUsage(db, row, durationSec) {
  const { promptTokens, completionTokens } = estimateVoiceTokens(durationSec);
  const costUsd = estimateVoiceCostUsd(durationSec);
  db.prepare(
    `
    INSERT INTO ai_usage (task, provider, model, prompt_tokens, completion_tokens, cost_usd, lead_id, note)
    VALUES ('chatbot.voice', 'openai', ?, ?, ?, ?, ?, ?)
  `
  ).run(
    row.voice_model || REALTIME_MODEL,
    promptTokens,
    completionTokens,
    costUsd,
    Number(row.lead_id),
    `voice session ${row.id} · ${durationSec}s`
  );
  return { prompt_tokens: promptTokens, completion_tokens: completionTokens, cost_usd: costUsd };
}

/**
 * Close a voice session: stamp end + duration + close state and write
 * the metering row. Idempotent — a second end call changes nothing.
 * A session that never connected (connected === false or zero
 * duration) writes NO ai_usage row.
 */
function endVoiceSession(db, row, { close = 'hangup', connected = true } = {}) {
  if (row.voice_ended_at) {
    return {
      ended: true,
      already: true,
      duration_sec: row.voice_duration_sec != null ? Number(row.voice_duration_sec) : null,
      close_state: row.voice_close_state || 'clean',
    };
  }
  const started = row.voice_started_at ? Date.parse(String(row.voice_started_at).replace(' ', 'T') + 'Z') : NaN;
  let durationSec = Number.isFinite(started) ? Math.max(0, Math.round((Date.now() - started) / 1000)) : 0;
  durationSec = Math.min(durationSec, VOICE_MAX_SESSION_SEC + 120);
  const closeState = close === 'cap' ? 'capped' : close === 'error' ? 'abrupt' : 'clean';
  db.prepare(
    `
    UPDATE chatbot_sessions
    SET voice_state = 'ended', voice_ended_at = datetime('now'),
        voice_duration_sec = ?, voice_close_state = ?, updated_at = datetime('now')
    WHERE id = ?
  `
  ).run(durationSec, closeState, row.id);
  let usage = null;
  if (connected !== false && durationSec > 0) {
    try {
      usage = recordVoiceUsage(db, row, durationSec);
    } catch {
      /* metering must never break the session close */
    }
  }
  return { ended: true, already: false, duration_sec: durationSec, close_state: closeState, usage };
}

/**
 * Append a relayed transcript batch to the stored conversation.
 * Items are deduped by their Realtime item id (retries and the
 * end-of-session flush can overlap safely), kept in conversation
 * order, and stamped with the client-reported offset (at_ms) where
 * the events provided one. With final:true the batch is flushed
 * BEFORE the session closes, so a completed conversation's transcript
 * is complete; if the browser dies mid-call instead, whatever was
 * relayed stays and the session reads as ended abruptly.
 */
function appendVoiceTranscript(db, token, sessionId, relaySecret, { items, final = false, close, connected } = {}) {
  const { leadId, row } = getVoiceSessionForRelay(db, token, sessionId, relaySecret);
  const list = Array.isArray(items) ? items.slice(0, 100) : [];

  const seen = new Set();
  if (list.some((it) => it && (it.item_id || it.id))) {
    for (const m of db
      .prepare('SELECT meta_json FROM chatbot_messages WHERE session_id = ?')
      .all(row.id)) {
      try {
        const meta = m.meta_json ? JSON.parse(m.meta_json) : null;
        if (meta && meta.voice_item_id) seen.add(String(meta.voice_item_id));
      } catch {
        /* unparseable meta — not a voice item */
      }
    }
  }

  let appended = 0;
  let sawVisitor = false;
  let sawAgent = false;
  for (const item of list) {
    if (!item) continue;
    const role = item.role === 'visitor' ? 'visitor' : item.role === 'agent' ? 'agent' : null;
    const body = String(item.body || '').trim();
    if (!role || !body) continue;
    const itemId = String(item.item_id || item.id || '').slice(0, 160);
    if (itemId && seen.has(itemId)) continue;
    if (itemId) seen.add(itemId);
    chatbot.addMessage(db, row.id, leadId, role, body, {
      source: 'voice',
      voice_item_id: itemId || undefined,
      at_ms: Number.isFinite(Number(item.at_ms)) && item.at_ms != null ? Number(item.at_ms) : undefined,
    });
    appended += 1;
    if (role === 'visitor') sawVisitor = true;
    if (role === 'agent') sawAgent = true;
  }
  if (appended) {
    db.prepare(
      `
      UPDATE chatbot_sessions
      SET last_visitor_at = CASE WHEN ? THEN datetime('now') ELSE last_visitor_at END,
          last_agent_at = CASE WHEN ? THEN datetime('now') ELSE last_agent_at END,
          updated_at = datetime('now')
      WHERE id = ?
    `
    ).run(sawVisitor ? 1 : 0, sawAgent ? 1 : 0, row.id);
  }

  let end = null;
  if (final) {
    const fresh = db.prepare('SELECT * FROM chatbot_sessions WHERE id = ?').get(row.id);
    end = endVoiceSession(db, fresh || row, { close: close || 'hangup', connected });
  }
  return { appended, ended: !!end, end };
}

/* ── Bubble image (portal upload; attachments-precedent validation) ─ */

const VOICE_IMAGE_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

function voiceImageRoot() {
  return process.env.EXPORT_ROOT || path.join(process.cwd(), 'exports');
}

function voiceImageAbs(rel) {
  const root = path.resolve(voiceImageRoot());
  const abs = path.resolve(root, String(rel || ''));
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

function decodeImageData(data) {
  const raw = String(data || '').trim();
  if (!raw) return null;
  const b64 = raw.startsWith('data:') ? raw.slice(raw.indexOf(',') + 1) : raw;
  try {
    return Buffer.from(b64, 'base64');
  } catch {
    return null;
  }
}

/** Merge one key into the chatbot settings_json extras, preserving all others. */
function setVoiceBubbleImageSetting(db, leadId, relPath) {
  chatbot.ensureTables(db);
  let row = db.prepare('SELECT settings_json FROM chatbot_settings WHERE lead_id = ?').get(Number(leadId));
  if (!row) {
    chatbot.saveSettings(db, Number(leadId), {});
    row = db.prepare('SELECT settings_json FROM chatbot_settings WHERE lead_id = ?').get(Number(leadId));
  }
  let extras = {};
  try {
    extras = JSON.parse((row && row.settings_json) || '{}') || {};
  } catch {
    extras = {};
  }
  extras.voice_bubble_image = relPath || '';
  db.prepare("UPDATE chatbot_settings SET settings_json = ?, updated_at = datetime('now') WHERE lead_id = ?").run(
    JSON.stringify(extras),
    Number(leadId)
  );
  return chatbot.getSettings(db, Number(leadId));
}

/**
 * Validate + store the owner's bubble image EXACTLY like the site-chat
 * attachments precedent: magic-byte sniff (PNG/JPG/WebP/GIF — SVG
 * refused), 10 MB cap, server-generated name under the exports root.
 */
function saveVoiceBubbleImage(workspaceId, db, leadId, { data, fileName } = {}) {
  const buffer = decodeImageData(data);
  if (!buffer || !buffer.length) throw fail('VALIDATION', 'Choose an image to upload.', 400);
  if (buffer.length > attachments.MAX_IMAGE_BYTES) {
    throw fail('TOO_LARGE', 'That image is too large — the limit is 10 MB.', 400);
  }
  const mime = attachments.sniffImageMime(buffer);
  if (!mime) {
    throw fail('INVALID_IMAGE', 'That file is not a supported image. Use a PNG, JPG, WebP or GIF.', 400);
  }
  const prev = chatbot.getSettings(db, Number(leadId)).voice_bubble_image;
  const rel = path.join(
    'chatbot-voice',
    `ws-${Number(workspaceId)}`,
    `lead-${Number(leadId)}`,
    `bubble-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${VOICE_IMAGE_EXT[mime]}`
  );
  const abs = voiceImageAbs(rel);
  if (!abs) throw fail('VALIDATION', 'Image storage is unavailable.', 400);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buffer);
  setVoiceBubbleImageSetting(db, Number(leadId), rel);
  if (prev && prev !== rel) {
    const prevAbs = voiceImageAbs(prev);
    if (prevAbs) {
      try {
        fs.unlinkSync(prevAbs);
      } catch {
        /* best-effort */
      }
    }
  }
  return { stored: true, mime, size_bytes: buffer.length, file_name: String(fileName || 'image').slice(0, 120) };
}

function removeVoiceBubbleImage(db, leadId) {
  const prev = chatbot.getSettings(db, Number(leadId)).voice_bubble_image;
  setVoiceBubbleImageSetting(db, Number(leadId), '');
  if (prev) {
    const abs = voiceImageAbs(prev);
    if (abs) {
      try {
        fs.unlinkSync(abs);
      } catch {
        /* best-effort */
      }
    }
  }
  return { removed: true };
}

/** Bytes + mime for the lead's current bubble image (public serve). */
function readVoiceBubbleImage(db, leadId) {
  const rel = chatbot.getSettings(db, Number(leadId)).voice_bubble_image;
  if (!rel) return null;
  const abs = voiceImageAbs(rel);
  if (!abs || !fs.existsSync(abs)) return null;
  const buffer = fs.readFileSync(abs);
  const mime = attachments.sniffImageMime(buffer);
  if (!mime) return null;
  return { buffer, mime };
}

module.exports = {
  REALTIME_MODEL,
  VOICE_MAX_SESSION_SEC,
  EPHEMERAL_TTL_SEC,
  TRANSCRIPTION_MODEL,
  VOICE_TOOLS,
  estimateVoiceTokens,
  estimateVoiceCostUsd,
  resolveOpenAiConfig,
  planAllowsChatbot,
  voiceAvailability,
  publicVoiceAdvertisement,
  buildVoiceInstructions,
  buildRealtimeSessionConfig,
  mintVoiceSession,
  getVoiceSessionForRelay,
  relayVoiceToolCall,
  recordQualificationAnswer,
  appendVoiceTranscript,
  endVoiceSession,
  saveVoiceBubbleImage,
  removeVoiceBubbleImage,
  readVoiceBubbleImage,
  setVoiceBubbleImageSetting,
};
