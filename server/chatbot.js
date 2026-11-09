'use strict';

/**
 * Site Chatbot module (Standard + Premium).
 *
 * Boundary (enforced):
 * - Visitor traffic uses public token APIs only (no workspace/admin tokens).
 * - Client agent replies via portal/client-scoped MCP (chatbot.* on lead tokens).
 * - Module actions use public module/form endpoints — never admin MCP (lead.*, design.*, …).
 * - Escalations + knowledge CRUD go through portal APIs / client entitlements.
 */

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const CHAT_SCRIPT_VER = 'chat8';
const CHAT_ATTR = 'data-bitpype-chat';
const CHAT_TOKEN_ATTR = 'data-bitpype-chat-token';
const CHAT_SCRIPT_ATTR = 'data-bitpype-chat-script';

const DEFAULT_SETTINGS = {
  greeting: 'Hi! How can we help?',
  bubble_label: 'Chat',
  primary_color: '',
  position: 'bottom-right',
  escalate_email: '',
  escalate_notify_portal: true,
  suggest_lead_capture: true,
  agent_timeout_hint_sec: 90,
  /** When no live client MCP agent replies, ChatGPT answers as business CS from knowledge. */
  ai_fallback: true,
  /**
   * Batch 137 — owner-set qualifying questions. The owner writes
   * their own questions in the portal; the chat weaves them into
   * the conversation and records the answers on the session. Both
   * fields ride settings_json (the ai_fallback extras store) — no
   * parallel settings system. Default OFF. Batch 140: when the
   * switch is ON and the owner's list is empty, the EFFECTIVE
   * questions are the industry defaults — deterministic platform
   * templates keyed to the business's category (see
   * INDUSTRY_QUESTION_TEMPLATES below); defaults are industry
   * templates, owner edits override. getSettings returns the
   * effective list plus qualifying_questions_source provenance;
   * the stored list itself is never rewritten by resolution.
   */
  qualifying_enabled: false,
  qualifying_questions: [],
  /**
   * Batch 138 — AI voice agent (OpenAI Realtime). Voice rides the
   * chatbot entitlement; all three fields live in settings_json extras
   * so no new columns are needed. voice_bubble_image holds the stored
   * relative path of the owner's bubble image ('' = default mic glyph).
   */
  voice_enabled: false,
  voice_name: 'marin',
  voice_bubble_image: '',
  /**
   * Batch 151 — owner-selected AI knowledge sources. The owner picks
   * which MODULES, which PAGES and which KNOWLEDGE-BASE documents
   * may provide answers (portal Chatbot → Settings → Knowledge
   * sources). Stored as ONE settings_json extras object:
   *   { groups: { modules, pages, knowledge },
   *     modules: { <module type>: bool }, pages: { <slug>: bool },
   *     knowledge: { <doc id>: bool } }
   * Only explicit entries are stored; an ABSENT entry means ON, and
   * a null/absent knowledge_sources (every legacy row) means
   * everything ON — an owner who never opens the panel gets the KB
   * behaviour they always had PLUS the module/page digests.
   */
  knowledge_sources: null,
};

/** Batch 137 — qualifying-question caps (validated on save). */
const QUALIFYING_MAX_QUESTIONS = 6;
const QUALIFYING_MAX_CHARS = 200;
const QUALIFYING_ANSWER_MAX_CHARS = 2000;
/** Recorded per-question states. Terminal states are sticky. */
const QUALIFYING_TERMINAL_STATUSES = ['answered', 'answered_from_conversation', 'declined'];

/**
 * Batch 138 — OpenAI Realtime built-in voices (developers.openai.com
 * Realtime API reference, checked 2026-11-04): alloy, ash, ballad,
 * coral, echo, sage, shimmer, verse, marin, cedar. OpenAI recommends
 * marin and cedar for best quality. The portal voice picker and the
 * Realtime session config both draw from this one list.
 */
const REALTIME_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar'];

const AI_FALLBACK_DELAY_MS = 2000;
/** Minimum visitor turns before we may open the contact form (greetings alone never count). */
const MIN_VISITOR_TURNS_BEFORE_CAPTURE = 2;

const LEAD_CAPTURE_THANKS =
  'Thanks for sharing that. Our team can’t reply in this chat right away — ' +
  'tap “Leave your details” below (or the Details tab) so we can call or email you back.';
const LEAD_CAPTURE_SYSTEM =
  'Use the “Leave your details” button below, or open the Details tab, to share your contact info.';
const LEAD_CAPTURE_FORM_META = { source: 'ai_fallback', open_lead_form: true };

/** Debounced AI fallback timers keyed by workspaceId:sessionId */
const _aiFallbackTimers = new Map();

function formatHoursForSupport(hours) {
  if (hours == null || hours === '') return '';
  if (typeof hours === 'string') return hours.trim();
  if (Array.isArray(hours)) {
    return hours
      .map((h) => {
        if (typeof h === 'string') return h.trim();
        if (h && typeof h === 'object') {
          const day = h.day || h.name || h.label || '';
          const open = h.open || h.opens || h.from || '';
          const close = h.close || h.closes || h.to || '';
          if (day && open && close) return `${day}: ${open}–${close}`;
          if (day && (open || close)) return `${day}: ${open || close}`;
          try {
            return JSON.stringify(h);
          } catch {
            return '';
          }
        }
        return String(h || '').trim();
      })
      .filter(Boolean)
      .join('; ');
  }
  if (typeof hours === 'object') {
    try {
      return JSON.stringify(hours);
    } catch {
      return '';
    }
  }
  return String(hours).trim();
}

/**
 * Profile for ChatGPT fallback: act as this business's customer support.
 * Lead columns + verified facts + website theme brandName.
 */
function loadBusinessSupportContext(db, leadId) {
  const lid = Number(leadId);
  let lead = null;
  try {
    const engine = require('../src/leadEngine');
    if (typeof engine.getLead === 'function') lead = engine.getLead(db, lid);
  } catch {
    /* ignore */
  }
  if (!lead) {
    try {
      lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(lid) || null;
    } catch {
      lead = null;
    }
  }

  let brandName = '';
  let siteName = '';
  try {
    const site = db.prepare('SELECT name, theme FROM websites WHERE lead_id = ? ORDER BY id DESC LIMIT 1').get(lid);
    if (site) {
      siteName = String(site.name || '').trim();
      let theme = {};
      try {
        theme = typeof site.theme === 'string' ? JSON.parse(site.theme || '{}') : site.theme || {};
      } catch {
        theme = {};
      }
      brandName = String((theme && theme.brandName) || '').trim();
    }
  } catch {
    /* ignore */
  }

  const factPick = {};
  try {
    const rows = db
      .prepare(
        `
      SELECT fact_key, value FROM business_facts
      WHERE lead_id = ?
        AND UPPER(COALESCE(claim_class, '')) IN ('VERIFIED', 'OWNER_PROVIDED')
        AND fact_key IN ('address', 'phone', 'email', 'hours', 'description', 'site.about', 'category')
      ORDER BY id DESC
    `
      )
      .all(lid);
    for (const r of rows) {
      const key = String(r.fact_key || '');
      const val = String(r.value || '').trim();
      if (!val || factPick[key]) continue;
      factPick[key] = val;
    }
  } catch {
    /* ignore */
  }

  const businessName = brandName || (lead && lead.business_name) || siteName || 'our business';
  const category = (lead && lead.category) || factPick.category || '';
  const phone = (lead && lead.phone) || factPick.phone || '';
  const email = (lead && lead.email) || factPick.email || '';
  const address =
    (lead && lead.address) ||
    factPick.address ||
    [lead && lead.city, lead && lead.state, lead && lead.postal_code].filter(Boolean).join(', ');
  const city = (lead && lead.city) || '';
  const state = (lead && lead.state) || '';
  const hours = formatHoursForSupport(lead && lead.hours) || factPick.hours || '';
  const about = String((lead && lead.description) || factPick.description || factPick['site.about'] || '')
    .trim()
    .slice(0, 800);
  const website = (lead && lead.website) || '';
  const services = Array.isArray(lead && lead.services)
    ? lead.services
        .map((s) => (typeof s === 'string' ? s : (s && s.name) || ''))
        .filter(Boolean)
        .slice(0, 12)
    : [];

  const lines = [
    `Business name: ${businessName}`,
    category ? `Industry / category: ${category}` : '',
    phone ? `Phone: ${phone}` : '',
    email ? `Email: ${email}` : '',
    address ? `Address: ${address}` : '',
    (city || state) && !address ? `Location: ${[city, state].filter(Boolean).join(', ')}` : '',
    hours ? `Hours: ${hours}` : '',
    website ? `Website: ${website}` : '',
    services.length ? `Services (labels only — verify details in knowledge): ${services.join(', ')}` : '',
    about ? `About: ${about}` : '',
  ].filter(Boolean);

  return {
    businessName: String(businessName).slice(0, 200),
    category: String(category || '').slice(0, 120),
    phone: String(phone || '').slice(0, 64),
    email: String(email || '').slice(0, 200),
    address: String(address || '').slice(0, 300),
    city: String(city || '').slice(0, 80),
    state: String(state || '').slice(0, 40),
    hours: String(hours || '').slice(0, 500),
    about,
    website: String(website || '').slice(0, 300),
    services,
    text: lines.join('\n'),
  };
}

/**
 * THE shared assistant-context assembly (Batch 138 seam). Every
 * surface that speaks for the business — the text AI fallback today,
 * the Batch 138 voice agent's Realtime instructions, and (after their
 * rebases) Batch 136's booking pitch + Batch 137's qualifying
 * questions, which compose ON TOP of these blocks — reads the business
 * profile, knowledge excerpts and settings from here, never from
 * ad-hoc re-reads, so all channels brief the model identically.
 */
function buildAssistantContext(db, leadId, { query = '' } = {}) {
  ensureTables(db);
  const settings = getSettings(db, leadId);
  // Batch 151: the owner's knowledge-source selection gates ALL
  // three diets here — KB documents (per-doc toggles + group switch)
  // and the module/page digests. A legacy/absent selection behaves
  // all-ON. This object is the one brain: text chat and voice both
  // read it, so both surfaces answer (and refuse) identically.
  const resolver = knowledgeSourcesFromSettings(settings);
  const kbIncludeIds = knowledgeIncludeIdsFor(resolver, db, leadId);
  return {
    business: loadBusinessSupportContext(db, leadId),
    knowledge: knowledgeSnippets(db, leadId, {
      query: String(query || ''),
      limit: 12,
      maxChars: 8000,
      includeIds: kbIncludeIds,
    }),
    settings,
    sources: buildKnowledgeDigests(db, leadId, resolver, query),
  };
}

function leadCaptureThanksFor(businessName) {
  const name = String(businessName || '').trim();
  if (name && !/^our business$/i.test(name)) {
    return (
      `Thanks for sharing that with ${name}. Our team can’t reply in this chat right away — ` +
      'tap “Leave your details” below (or the Details tab) so we can call or email you back.'
    );
  }
  return LEAD_CAPTURE_THANKS;
}

function isGreetingOnly(text) {
  const t = String(text || '')
    .trim()
    .toLowerCase();
  if (!t || t.length > 40) return false;
  return /^(hi|hello|hey|howdy|yo|sup|good\s*(morning|afternoon|evening)|hiya|hola)[\s!.?]*$/i.test(t);
}

function visitorStatedNeed(messages) {
  const visitor = (messages || []).filter((m) => m && m.role === 'visitor');
  if (visitor.length < MIN_VISITOR_TURNS_BEFORE_CAPTURE) return false;
  const substantive = visitor.filter((m) => !isGreetingOnly(m.body));
  return substantive.length >= 1 && visitor.length >= MIN_VISITOR_TURNS_BEFORE_CAPTURE;
}

function heuristicSupportReply(latestVisitor, businessName, messages) {
  const name = String(businessName || '').trim() || 'our team';
  const latest = String(latestVisitor || '').trim();
  if (isGreetingOnly(latest) || !latest) {
    return {
      action: 'chat',
      reply: `Hi! Thanks for reaching out to ${name}. What can we help you with today?`,
    };
  }
  if (!visitorStatedNeed(messages)) {
    return {
      action: 'chat',
      reply: `Got it — thanks. Could you share a bit more about what you need (for example the issue, location, or timing) so we can help?`,
    };
  }
  return {
    action: 'capture',
    reply: leadCaptureThanksFor(businessName),
  };
}

function fail(code, message, status) {
  const err = new Error(message);
  err.code = code;
  if (status) err.status = status;
  return err;
}

function appBaseUrl() {
  // Batch 56: resolve from the canonical public URL (stripeClient.appUrl);
  // the env read remains only as a fallback if the resolver cannot load.
  try {
    return require('./stripeClient').appUrl();
  } catch {
    return String(process.env.APP_URL || '').replace(/\/+$/, '');
  }
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, '&#39;');
}

function ensureTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chatbot_settings (
      lead_id INTEGER PRIMARY KEY,
      greeting TEXT NOT NULL DEFAULT '',
      bubble_label TEXT NOT NULL DEFAULT 'Chat',
      primary_color TEXT NOT NULL DEFAULT '',
      position TEXT NOT NULL DEFAULT 'bottom-right',
      escalate_email TEXT NOT NULL DEFAULT '',
      escalate_notify_portal INTEGER NOT NULL DEFAULT 1,
      suggest_lead_capture INTEGER NOT NULL DEFAULT 1,
      agent_timeout_hint_sec INTEGER NOT NULL DEFAULT 90,
      settings_json TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS chatbot_knowledge (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      kind TEXT NOT NULL DEFAULT 'link',
      title TEXT NOT NULL DEFAULT '',
      url TEXT NOT NULL DEFAULT '',
      content_text TEXT NOT NULL DEFAULT '',
      file_name TEXT NOT NULL DEFAULT '',
      file_path TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS chatbot_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      session_token TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'open',
      needs_agent INTEGER NOT NULL DEFAULT 0,
      visitor_meta_json TEXT,
      last_visitor_at TEXT,
      last_agent_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS chatbot_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      lead_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      body TEXT NOT NULL,
      meta_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS chatbot_leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      session_id INTEGER,
      name TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      message TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'new',
      website_id INTEGER,
      tenant_lead_id INTEGER,
      rental_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS chatbot_escalations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      session_id INTEGER,
      message TEXT NOT NULL DEFAULT '',
      reason TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_chatbot_knowledge_lead ON chatbot_knowledge(lead_id);
    CREATE INDEX IF NOT EXISTS idx_chatbot_sessions_lead ON chatbot_sessions(lead_id, needs_agent);
    CREATE INDEX IF NOT EXISTS idx_chatbot_messages_session ON chatbot_messages(session_id, id);
    CREATE INDEX IF NOT EXISTS idx_chatbot_leads_lead ON chatbot_leads(lead_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_chatbot_escalations_lead ON chatbot_escalations(lead_id, status);
  `);
  // Site Rentals stamp (Batch 26) for databases created before it.
  try {
    const cols = db
      .prepare('PRAGMA table_info(chatbot_leads)')
      .all()
      .map((c) => String(c.name || ''));
    for (const col of ['website_id', 'tenant_lead_id', 'rental_id']) {
      if (cols.length && !cols.includes(col)) {
        db.exec(`ALTER TABLE chatbot_leads ADD COLUMN ${col} INTEGER`);
      }
    }
  } catch {
    /* race / exists */
  }
  // Batch 137 — the per-session qualifying record (owner's questions
  // snapshotted + per-question answer state) and its snapshot on a
  // captured chat lead, for databases created before this batch.
  try {
    const sCols = db
      .prepare('PRAGMA table_info(chatbot_sessions)')
      .all()
      .map((c) => String(c.name || ''));
    if (sCols.length && !sCols.includes('qualification_json')) {
      db.exec('ALTER TABLE chatbot_sessions ADD COLUMN qualification_json TEXT');
    }
    const lCols = db
      .prepare('PRAGMA table_info(chatbot_leads)')
      .all()
      .map((c) => String(c.name || ''));
    if (lCols.length && !lCols.includes('qualification_json')) {
      db.exec('ALTER TABLE chatbot_leads ADD COLUMN qualification_json TEXT');
    }
  } catch {
    /* race / exists */
  }
  // Batch 167 (chat redesign port — YWL Rules A–K) — per-session chat
  // state for the AI fallback engine: consecutive-miss streak,
  // answered-turn count, price fact-check blocks, the visitor-handoff
  // flag, the suppress flags the harness sets on a cancel, and the
  // provisional honest outcome (Rule G). Additive JSON, same pattern
  // as qualification_json; rows that predate the batch simply have
  // no state and behave exactly as before.
  try {
    const cols = db
      .prepare('PRAGMA table_info(chatbot_sessions)')
      .all()
      .map((c) => String(c.name || ''));
    if (cols.length && !cols.includes('chat_state_json')) {
      db.exec('ALTER TABLE chatbot_sessions ADD COLUMN chat_state_json TEXT');
    }
  } catch {
    /* race / exists */
  }
  // Batch 138 — voice sessions share the text-chat session store.
  // channel distinguishes them; the voice_* columns carry the Realtime
  // session lifecycle (relay-secret hash only — the secret itself is
  // never stored), timing and close state for the portal inbox.
  try {
    const cols = db
      .prepare('PRAGMA table_info(chatbot_sessions)')
      .all()
      .map((c) => String(c.name || ''));
    const voiceCols = [
      ['channel', "TEXT NOT NULL DEFAULT 'text'"],
      ['voice_state', 'TEXT'],
      ['voice_started_at', 'TEXT'],
      ['voice_ended_at', 'TEXT'],
      ['voice_duration_sec', 'INTEGER'],
      ['voice_close_state', 'TEXT'],
      ['voice_relay_hash', 'TEXT'],
      ['voice_openai_session_id', 'TEXT'],
      ['voice_model', 'TEXT'],
      ['voice_voice_name', 'TEXT'],
    ];
    for (const [col, def] of voiceCols) {
      if (cols.length && !cols.includes(col)) {
        db.exec(`ALTER TABLE chatbot_sessions ADD COLUMN ${col} ${def}`);
      }
    }
  } catch {
    /* race / exists */
  }
}

/**
 * Batch 137 — validate an owner-supplied qualifying-question list
 * for SAVE. Refuses (never silently rewrites): non-array input,
 * more than QUALIFYING_MAX_QUESTIONS entries, non-string entries,
 * blank entries, entries over QUALIFYING_MAX_CHARS. Returns the
 * trimmed questions in the owner's order — the exact strings the
 * chat will ask, byte-for-byte.
 */
function normalizeQualifyingQuestions(input) {
  if (!Array.isArray(input)) {
    throw fail('VALIDATION', 'qualifying_questions must be a list of questions', 400);
  }
  if (input.length > QUALIFYING_MAX_QUESTIONS) {
    throw fail('VALIDATION', `At most ${QUALIFYING_MAX_QUESTIONS} qualifying questions`, 400);
  }
  return input.map((q, i) => {
    if (typeof q !== 'string') {
      throw fail('VALIDATION', `Qualifying question ${i + 1} must be plain text`, 400);
    }
    const text = q.trim();
    if (!text) {
      throw fail('VALIDATION', `Qualifying question ${i + 1} is blank — remove it or write the question`, 400);
    }
    if (text.length > QUALIFYING_MAX_CHARS) {
      throw fail(
        'VALIDATION',
        `Qualifying question ${i + 1} is over ${QUALIFYING_MAX_CHARS} characters`,
        400
      );
    }
    return text;
  });
}

/** Lenient read-side sanitize (stored data was validated on save). */
function sanitizeQualifyingQuestions(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((q) => typeof q === 'string')
    .map((q) => q.trim().slice(0, QUALIFYING_MAX_CHARS))
    .filter(Boolean)
    .slice(0, QUALIFYING_MAX_QUESTIONS);
}


/* ── Batch 140: industry default qualifying questions ──────────────
 * Ely's order (2026-11-04): "The default questions for the chat and
 * voice should be top five questions to prove to that particular
 * business that the feature works. It's unique based on industry.
 * Every business questions will vary."
 *
 * Doctrine:
 *   - Defaults are DETERMINISTIC platform templates (platform
 *     AI_COPY), resolved server-side from the lead's category —
 *     never generated by a model at chat time, never invented.
 *   - Exactly FIVE per business, structured: (1) what they need,
 *     (2) the scope/detail that determines fit and price,
 *     (3) timing/urgency, (4) location/access, (5) the decision
 *     factor that completes a qualified-lead picture. No contact
 *     details (lead capture handles those) and no sensitive
 *     personal/health/financial specifics.
 *   - ONE resolver serves every surface: getSettings returns the
 *     EFFECTIVE list, and the AI fallback, the live-agent context
 *     and Batch 138's voice context (which reads
 *     buildAssistantContext().settings) all consume getSettings —
 *     so chat and voice always ask the same five.
 *   - The owner's own list always wins, byte-for-byte. Stored
 *     settings are NEVER rewritten by resolution: an unsaved
 *     default tracks the lead's category; once the owner saves a
 *     list it is frozen as owner questions even if the category
 *     later changes.
 *   - Batch 140 supersedes Batch 137's "on + empty behaves as
 *     off": enabled + empty owner list now resolves to the
 *     industry defaults. Enabled=false still yields no questions.
 * A question may be a plain string or { q, alt }: q may carry
 * {service} / {services} / {city} tokens interpolated from the
 * business's own profile; alt is the uninterpolated fallback used
 * when a token has no value or the result would exceed the cap.
 */
const INDUSTRY_QUESTION_TEMPLATES = {
  plumbing: {
    label: 'Plumbing',
    keywords: ['plumb'],
    questions: [
      'What plumbing problem can we help with — a leak, a clog, a water heater, or something else?',
      'Where is the problem — kitchen, bathroom, basement — and how many fixtures are affected?',
      'Is water actively leaking or backed up right now, or can it wait for a scheduled visit?',
      'Is this for a home or a business property, and what town is it in?',
      'Have you had this same problem before, or is this the first time?',
    ],
  },
  hvac: {
    label: 'HVAC',
    keywords: ['hvac', 'heating and cooling', 'heating & cooling', 'furnace', 'air conditioning', 'ac repair', 'heating'],
    questions: [
      'Is this about heating, cooling, or both?',
      'What is happening — no heat or cooling, weak airflow, strange noises, or a new system quote?',
      'How urgent is it — is the system completely down right now?',
      'How big is the home or space the system serves, roughly?',
      'How old is the current system, if you know?',
    ],
  },
  electrical: {
    label: 'Electrical',
    keywords: ['electric'],
    questions: [
      'What electrical work do you need — a repair, new lighting, a panel upgrade, or something else?',
      'Is anything sparking, flickering, or tripping a breaker right now?',
      'How soon do you need an electrician — is anything unsafe or without power?',
      'Which rooms or areas are involved?',
      'Is this for your home or a business property?',
    ],
  },
  roofing: {
    label: 'Roofing',
    keywords: ['roof'],
    questions: [
      'Do you need a roof repair, a full replacement, or an inspection?',
      'Is the roof leaking right now, and where are you seeing water inside?',
      'Roughly how big is the roof, and is the building one story or more?',
      'How old is the roof, if you know?',
      'Is this urgent because of storm damage, or are you planning ahead?',
    ],
  },
  contracting: {
    label: 'General contracting / remodeling',
    keywords: ['general contract', 'remodel', 'renovation', 'construction', 'home improvement', 'handyman', 'kitchen and bath', 'contractor'],
    questions: [
      'What kind of project are you planning — a remodel, an addition, or a repair?',
      'Which rooms or areas are involved, and roughly how big is the space?',
      'When are you hoping to start, and is there a date you need it finished by?',
      'Where is the property, and will you be living there during the work?',
      'Do you already have plans or designs, or are you starting from ideas?',
    ],
  },
  landscaping: {
    label: 'Landscaping / lawn care',
    keywords: ['landscap', 'lawn', 'yard care', 'garden service'],
    questions: [
      'What can we help with — regular lawn care, a cleanup, planting, or a full landscape project?',
      'How big is the yard or property, roughly?',
      'How often would you like service — one-time, or on a regular schedule?',
      'When are you hoping to get started?',
      'Is there anything tricky about access, like gates, slopes, or pets in the yard?',
    ],
  },
  tree: {
    label: 'Tree service',
    keywords: ['tree service', 'tree removal', 'arborist', 'stump'],
    questions: [
      'Do you need a tree removed, trimmed, or assessed for safety?',
      'How many trees are involved, and roughly how tall are they?',
      'Is any tree leaning, damaged, or close to the house or power lines?',
      'When would you like the work done — is any of it urgent?',
      'Is there clear access for equipment, or is the tree in a tight spot?',
    ],
  },
  house_cleaning: {
    label: 'House cleaning',
    keywords: ['house cleaning', 'home cleaning', 'maid', 'residential cleaning', 'cleaning'],
    questions: [
      'What kind of cleaning do you need — a one-time deep clean, regular upkeep, or a move-in/move-out clean?',
      'How many bedrooms and bathrooms is the home?',
      'How often would you like cleaning — weekly, every two weeks, monthly, or just once?',
      'When are you hoping for the first clean?',
      'Are there pets in the home, or anything we should be careful with?',
    ],
  },
  commercial_cleaning: {
    label: 'Commercial cleaning',
    keywords: ['commercial cleaning', 'janitorial', 'office cleaning'],
    questions: [
      'What kind of facility needs cleaning — office, retail, medical, or something else?',
      'Roughly how large is the space, and how many rooms or floors?',
      'How often do you need service, and during business hours or after hours?',
      'When would you like service to start?',
      'Are there areas that need special attention, or should supplies be included?',
    ],
  },
  pest: {
    label: 'Pest control',
    keywords: ['pest', 'exterminator', 'termite'],
    questions: [
      'What pest are you dealing with — insects, rodents, wildlife, or not sure yet?',
      'Where are you seeing them, and how bad does it seem?',
      'How soon do you need someone out — is it getting worse?',
      'Is this a home or a business property, and roughly how large?',
      'Have you tried any treatments already, or had service before?',
    ],
  },
  dumpster: {
    label: 'Dumpster rental / junk removal',
    keywords: ['dumpster', 'junk removal', 'roll-off', 'roll off', 'debris removal', 'waste removal'],
    questions: [
      'Do you need a dumpster rental, junk removal, or both?',
      'What are you clearing out — household items, construction debris, yard waste, or something else?',
      'Roughly how much is there — a few items, a room, or a whole property?',
      'When do you need the dumpster delivered, or the pickup scheduled?',
      'Where will it be placed — driveway, street, or somewhere else?',
    ],
  },
  moving: {
    label: 'Moving / storage',
    keywords: ['moving', 'movers', 'storage', 'relocation'],
    questions: [
      'Are you moving out, moving in, or do you need storage as well?',
      'How big is the move — a few items, an apartment, or a full house?',
      'What date are you moving, and how flexible is it?',
      'Where are you moving from and to — and are there stairs or elevators involved?',
      'Do you need packing help, or will everything be boxed and ready?',
    ],
  },
  painting: {
    label: 'Painting',
    keywords: ['paint'],
    questions: [
      'What needs painting — inside, outside, or both?',
      'Which rooms or areas, and roughly how large are they?',
      'When are you hoping to have it done?',
      'Do you already have colors picked out, or would you like help choosing?',
      'Is any repair work needed first, like drywall patches or peeling paint?',
    ],
  },
  flooring: {
    label: 'Flooring',
    keywords: ['flooring', 'hardwood floor', 'floor install', 'carpet install'],
    questions: [
      'What flooring are you interested in — hardwood, laminate, vinyl, tile, or carpet?',
      'Which rooms, and roughly how many square feet in total?',
      'When are you hoping to have it installed?',
      'Is old flooring being removed, and what is underneath it now?',
      'Will the rooms be emptied, or do you need help moving furniture?',
    ],
  },
  concrete: {
    label: 'Concrete / masonry',
    keywords: ['concrete', 'masonry', 'paving', 'asphalt', 'stonework', 'brickwork'],
    questions: [
      'What do you need built or repaired — a driveway, patio, walkway, wall, or something else?',
      'Roughly how large is the area, or how long is the section involved?',
      'Is this new work, or repairing damage like cracks or settling?',
      'When are you hoping to get it done?',
      'Is there good access for equipment and materials at the site?',
    ],
  },
  garage_door: {
    label: 'Garage door',
    keywords: ['garage door'],
    questions: [
      'Is this a repair, a new door, or an opener issue?',
      'What is happening — will the door not open, is it noisy, or is a panel or spring damaged?',
      'Is your car stuck inside, or is the door a safety concern right now?',
      'Is it a single or double door, and do you know the rough size?',
      'When would you like someone to come out?',
    ],
  },
  locksmith: {
    label: 'Locksmith',
    keywords: ['locksmith', 'lock and key'],
    questions: [
      'What do you need — are you locked out, changing locks, or installing new hardware?',
      'Is this for a home, a business, or a vehicle?',
      'How many locks or doors are involved?',
      'How urgent is it — are you locked out right now?',
      'What town is the property in, so we can gauge how quickly we can reach you?',
    ],
  },
  towing: {
    label: 'Towing',
    keywords: ['towing', 'tow truck', 'roadside'],
    questions: [
      'Do you need a tow right now, or are you scheduling one?',
      'What kind of vehicle is it — car, SUV, truck, or something larger?',
      'Where is the vehicle now, and where does it need to go?',
      'Is the vehicle able to roll and steer, or is it damaged or stuck?',
      'Is anyone waiting with the vehicle, and is it in a safe spot?',
    ],
  },
  auto_repair: {
    label: 'Auto repair',
    keywords: ['auto repair', 'mechanic', 'car repair', 'auto shop', 'brake service'],
    questions: [
      'What is going on with the vehicle — a noise, a warning light, or it will not start?',
      'What is the year, make, and model of the vehicle?',
      'When did the problem start, and is the vehicle still drivable?',
      'How soon do you need it looked at?',
      'Has anyone looked at it already, or had this repaired before?',
    ],
  },
  auto_detailing: {
    label: 'Auto detailing',
    keywords: ['auto detail', 'car detail', 'detailing'],
    questions: [
      'What detailing are you looking for — a full detail, interior only, or exterior polish?',
      'What kind of vehicle is it, and what condition is the interior in?',
      'Are there specific concerns — pet hair, stains, odors, or scratches?',
      'When would you like it done, and how soon do you need the vehicle back?',
      'Will you drop the vehicle off, or are you asking about mobile service?',
    ],
  },

  dental: {
    label: 'Dental',
    keywords: ['dental', 'dentist', 'orthodont'],
    questions: [
      'What brings you in — a checkup and cleaning, a specific concern, or a cosmetic treatment?',
      'Is anything bothering you right now, like pain or sensitivity?',
      'Are you a new patient, or have you visited us before?',
      'When are you hoping to be seen — is it urgent?',
      'Do mornings, afternoons, or evenings usually work best for appointments?',
    ],
  },
  medical: {
    label: 'Medical / clinic',
    keywords: ['medical', 'clinic', 'doctor', 'healthcare', 'chiropract', 'physical therapy', 'urgent care', 'therapy', 'counseling'],
    questions: [
      'What kind of appointment are you looking for — a first visit, a follow-up, or a specific service?',
      'Is this for you, or are you booking for a family member?',
      'How soon are you hoping to be seen — is it urgent?',
      'Have you been seen at our clinic before?',
      'Do mornings, afternoons, or evenings usually work best for appointments?',
    ],
  },
  salon: {
    label: 'Salon / barber',
    keywords: ['salon', 'barber', 'hair', 'beauty', 'nail'],
    questions: [
      'What service are you booking — a cut, color, styling, or something else?',
      'Is this for you, or for a child or someone else as well?',
      'Do you have a stylist or barber you prefer, or is first available fine?',
      'When are you hoping to come in — is it for a special occasion?',
      'Is your hair long, medium, or short, so we allow the right amount of time?',
    ],
  },
  spa: {
    label: 'Spa / massage',
    keywords: ['spa', 'massage'],
    questions: [
      'What are you booking — a massage, a facial, or another treatment?',
      'Is this for relaxation, a special occasion, or a specific area of tension?',
      'Is the appointment just for you, or for two or more people?',
      'When are you hoping to come in?',
      'Have you visited us before, or will this be your first time?',
    ],
  },
  fitness: {
    label: 'Fitness / personal training',
    keywords: ['fitness', 'personal train', 'gym', 'yoga', 'pilates'],
    questions: [
      'What is your main goal — building strength, improving fitness, or staying active?',
      'Have you trained with a coach before, or would this be your first time?',
      'How many sessions a week are you thinking about?',
      'When are you hoping to get started?',
      'Do mornings, afternoons, or evenings work best for your schedule?',
    ],
  },
  restaurant: {
    label: 'Restaurant',
    keywords: ['restaurant', 'cafe', 'coffee shop', 'diner', 'pizzeria', 'bistro', 'food truck', 'eatery'],
    questions: [
      'Are you booking a table, ordering food, or planning something else?',
      'How many people will be in your party?',
      'What date and time are you hoping for?',
      'Is it a special occasion we should know about?',
      'Would you prefer indoor or outdoor seating, if available?',
    ],
  },
  catering: {
    label: 'Catering',
    keywords: ['catering', 'caterer'],
    questions: [
      'What kind of event are you planning?',
      'How many guests are you expecting?',
      'What date is the event, and when do you need a decision by?',
      'Where will the event be held — a venue, a home, or a workplace?',
      'Do you have a style in mind — buffet, plated, or casual stations?',
    ],
  },
  bakery: {
    label: 'Bakery',
    keywords: ['bakery', 'bake shop', 'pastry', 'cake shop'],
    questions: [
      'What can we bake for you — a cake, pastries, bread, or a larger order?',
      'Is it for a special occasion? What are you celebrating?',
      'How many people should it serve?',
      'What date do you need it ready by?',
      'Do you have flavors or a design in mind already?',
    ],
  },
  florist: {
    label: 'Florist / plant shop / garden retail',
    keywords: ['florist', 'flower', 'plant shop', 'garden center', 'garden centre', 'plant nursery', 'plants', 'garden retail'],
    questions: [
      'Are you looking for fresh flowers, a plant for your home, or supplies for your garden?',
      'Is it for an occasion — a birthday, sympathy, a wedding, or just because?',
      'Do you need delivery, or will you pick it up in the shop?',
      'When do you need it by?',
      'Is there a plant you have in mind, or would you like a suggestion based on your light and space?',
    ],
  },
  retail: {
    label: 'Retail / ecommerce',
    keywords: ['retail', 'ecommerce', 'e-commerce', 'boutique', 'gift shop', 'shop', 'store'],
    questions: [
      'What are you shopping for today?',
      'Is it for yourself, or a gift for someone else?',
      'Do you need it by a certain date?',
      'Are you looking for a specific size, color, or style?',
      'Would delivery work, or would you rather pick it up in store?',
    ],
  },
  real_estate: {
    label: 'Real estate',
    keywords: ['real estate', 'realtor', 'realty', 'property management'],
    questions: [
      'Are you looking to buy, sell, or just explore your options?',
      'Which area is the home in, or where are you hoping to move?',
      'What is your rough timeline — soon, or a few months out?',
      'How many bedrooms do you need, or is there a must-have feature?',
      'Is this your first time buying or selling, or have you done it before?',
    ],
  },
  law: {
    label: 'Law',
    keywords: ['law', 'attorney', 'legal', 'lawyer'],
    questions: [
      'What kind of legal matter can we help with — family, business, real estate, or something else?',
      'Is this a new matter, or is something already in progress?',
      'Are there any upcoming dates or deadlines we should know about?',
      'Is the matter just for you, or does it involve a business or family members?',
      'Would you prefer a phone consultation or an in-person meeting to start?',
    ],
  },
  accounting: {
    label: 'Accounting / bookkeeping',
    keywords: ['account', 'bookkeep', 'tax service', 'cpa'],
    questions: [
      'What do you need help with — taxes, bookkeeping, payroll, or general advice?',
      'Is this for you personally, or for a business?',
      'How soon is it needed — is there a deadline coming up?',
      'Are your records already organized, or do you need help getting them together?',
      'Have you worked with an accountant before, or would this be a first time?',
    ],
  },
  insurance: {
    label: 'Insurance',
    keywords: ['insurance'],
    questions: [
      'What kind of coverage are you asking about — home, auto, business, or something else?',
      'Is this a new policy, or a change to one you already have?',
      'When do you need the coverage to start?',
      'Is this just for you, or for a family or a business as well?',
      'Have you compared quotes already, or is this your first stop?',
    ],
  },
  photography: {
    label: 'Photography / videography',
    keywords: ['photograph', 'videograph'],
    questions: [
      'What kind of session or coverage are you looking for — portraits, an event, or something else?',
      'What is the date of the event or session?',
      'Where will it take place?',
      'How many people will be photographed, roughly?',
      'Do you have a style you love, or examples you can share?',
    ],
  },
  events: {
    label: 'Events / weddings',
    keywords: ['event plan', 'wedding plan', 'party rental', 'event venue', 'wedding venue', 'wedding', 'events'],
    questions: [
      'What are you celebrating, and what kind of event are you planning?',
      'What date are you hoping for, and how set is it?',
      'How many guests are you expecting?',
      'Do you have a venue booked, or are you still looking?',
      'What parts do you need help with — planning, coordination, rentals, or the full day?',
    ],
  },
  pet: {
    label: 'Pet grooming / boarding',
    keywords: ['pet groom', 'pet board', 'dog groom', 'pet care', 'kennel', 'pet'],
    questions: [
      'What does your pet need — grooming, boarding, daycare, or a combination?',
      'What kind of pet is it, and roughly how big?',
      'What dates are you looking at?',
      'Has your pet been groomed or boarded with us before?',
      'Is there anything about your pet we should know to keep them comfortable?',
    ],
  },
  veterinary: {
    label: 'Veterinary',
    keywords: ['veterinar', 'vet clinic', 'animal clinic', 'animal hospital', 'animal'],
    questions: [
      'What does your pet need — a checkup, vaccinations, or a specific concern?',
      'What kind of pet is it, and how old are they, roughly?',
      'Is anything worrying you about them right now?',
      'How soon are you hoping to be seen — is it urgent?',
      'Has your pet been seen at our clinic before?',
    ],
  },
  education: {
    label: 'Childcare / tutoring / education',
    keywords: ['childcare', 'daycare', 'tutoring', 'tutor', 'preschool', 'after school', 'music lessons', 'education', 'learning center'],
    questions: [
      'What are you looking for — childcare, tutoring, lessons, or an after-school program?',
      'How old is the student, and what grade or level are they at?',
      'Which subjects need the most help, or what kind of care routine do you need?',
      'What days and times work best for your family?',
      'When are you hoping to get started?',
    ],
  },
  web_services: {
    label: 'Web / design / marketing services',
    keywords: ['web design', 'website design', 'marketing', 'seo', 'graphic design', 'branding', 'digital agency', 'social media', 'web'],
    questions: [
      'What do you need — a new website, a redesign, branding, or marketing help?',
      'Is this for a new business, or an existing one?',
      'What should the project mainly do — get calls, sell online, or showcase your work?',
      'What is your rough timeline for launching?',
      'Do you already have a logo, photos, and text, or do you need help creating them?',
    ],
  },
  generic: {
    label: 'General local services',
    keywords: [],
    questions: [
      {
        q: 'Which of our services can we help you with — {services} — or something else?',
        alt: 'What can we help you with today?',
      },
      'Can you tell us a little more about what you need, so we point you to the right person?',
      'When are you hoping to have this done — is any of it urgent?',
      {
        q: 'Are you in or near {city}, or somewhere else?',
        alt: 'What area are you in, so we can confirm we serve it?',
      },
      'Is there anything else about the job or visit that would help us prepare?',
    ],
  },
};

/**
 * Classifier priority: specific families before general ones, so
 * e.g. "Commercial Cleaning" never lands on house cleaning,
 * "Dental" never lands on medical, "Auto Detailing" never lands
 * on auto repair, and "Garden Center" (florist/retail) never
 * lands on landscaping. The generic fallback is not in this list.
 */
const INDUSTRY_CLASSIFY_ORDER = [
  'dental', 'veterinary', 'garage_door', 'locksmith', 'towing',
  'commercial_cleaning', 'auto_detailing', 'florist', 'catering',
  'bakery', 'spa', 'tree', 'pest', 'dumpster', 'education', 'events',
  'photography', 'real_estate', 'insurance', 'accounting', 'law',
  'pet', 'hvac', 'plumbing', 'electrical', 'roofing', 'concrete',
  'flooring', 'painting', 'contracting', 'landscaping',
  'house_cleaning', 'moving', 'auto_repair', 'salon', 'fitness',
  'restaurant', 'medical', 'web_services', 'retail',
];

function normalizeIndustryCategory(category) {
  return String(category || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Map a lead category string to a template family (specific → general). */
function classifyIndustry(category) {
  const norm = normalizeIndustryCategory(category);
  if (!norm) return 'generic';
  const padded = ` ${norm} `;
  for (const key of INDUSTRY_CLASSIFY_ORDER) {
    const fam = INDUSTRY_QUESTION_TEMPLATES[key];
    if (!fam) continue;
    for (const kw of fam.keywords) {
      const k = normalizeIndustryCategory(kw);
      if (k && (padded.includes(` ${k} `) || norm.includes(k))) return key;
    }
  }
  return 'generic';
}

function interpolateIndustryQuestion(entry, ctx) {
  const raw = entry && typeof entry === 'object' ? entry.q : entry;
  const alt = entry && typeof entry === 'object' ? entry.alt : null;
  const text = String(raw || '');
  if (!text.includes('{')) return text.slice(0, QUALIFYING_MAX_CHARS);
  const services = (ctx.services || []).filter(Boolean);
  const values = {
    service: services[0] || '',
    services: services.slice(0, 3).join(', '),
    city: ctx.city || '',
  };
  let missing = false;
  const out = text.replace(/\{(service|services|city)\}/g, (m, name) => {
    if (!values[name]) missing = true;
    return values[name] || m;
  });
  if (missing || out.length > QUALIFYING_MAX_CHARS) {
    return String(alt || 'What can we help you with today?').slice(0, QUALIFYING_MAX_CHARS);
  }
  return out;
}

/**
 * Batch 140 — the industry defaults for one lead, resolved from
 * its business profile (category + services + city, via
 * loadBusinessSupportContext, which already merges the lead row
 * with verified business_facts). Deterministic: same profile in,
 * same five out. Returns { family, industry, questions }.
 */
function getIndustryDefaultQuestions(db, leadId, business) {
  const biz = business || loadBusinessSupportContext(db, leadId);
  const family = classifyIndustry(biz.category);
  const fam = INDUSTRY_QUESTION_TEMPLATES[family] || INDUSTRY_QUESTION_TEMPLATES.generic;
  const ctx = { services: biz.services || [], city: biz.city || '' };
  // A named family can still use the business's own service list in
  // its first question when the template carries the token; the
  // shipped named templates are token-free, so this is the generic
  // family's personalization path plus any future token use.
  const questions = fam.questions.map((entry) => interpolateIndustryQuestion(entry, ctx));
  return {
    family,
    industry: fam.label,
    category: String(biz.category || ''),
    questions: sanitizeQualifyingQuestions(questions).slice(0, 5),
  };
}

/**
 * Batch 140 — THE resolver (single source for chat + voice).
 * Owner's stored list wins byte-for-byte; an empty stored list
 * resolves to the industry defaults. Stored settings are read,
 * never rewritten, here.
 */
function resolveQualifyingQuestions(db, leadId, storedQuestions, business) {
  const stored = sanitizeQualifyingQuestions(storedQuestions);
  if (stored.length) {
    const biz = business || loadBusinessSupportContext(db, leadId);
    const fam = INDUSTRY_QUESTION_TEMPLATES[classifyIndustry(biz.category)];
    return {
      questions: stored,
      source: 'owner',
      industry: fam ? fam.label : INDUSTRY_QUESTION_TEMPLATES.generic.label,
    };
  }
  const dflt = getIndustryDefaultQuestions(db, leadId, business);
  return { questions: dflt.questions, source: 'industry_default', industry: dflt.industry };
}

/**
 * The effective qualifying config from a settings object (as
 * returned by getSettings, i.e. already resolved by Batch 140):
 * the feature is ACTIVE only when the switch is on AND the
 * effective list is non-empty. Since Batch 140 the effective
 * list is the owner's list when they saved one, otherwise the
 * industry defaults — so on + empty STORED list is active with
 * the defaults; only the switch being off yields no questions.
 */
function qualifyingFromSettings(settings) {
  const s = settings || {};
  const questions = sanitizeQualifyingQuestions(s.qualifying_questions);
  const enabled = !!s.qualifying_enabled;
  return {
    enabled,
    questions,
    active: enabled && questions.length > 0,
    source: questions.length ? s.qualifying_questions_source || 'industry_default' : null,
    industry: s.qualifying_industry || null,
  };
}

/**
 * Batch 137 — the chat-context reader, mirroring Batch 136's
 * bookingPitchFor: returns the owner's questions when the feature
 * is active for this lead, else null (no block anywhere).
 */
function qualifyingFor(db, leadId) {
  const cfg = qualifyingFromSettings(getSettings(db, leadId));
  if (!cfg.active) return null;
  return { questions: cfg.questions.slice() };
}

/* ------------------------------------------------------------------ */
/* Batch 151 — AI knowledge sources (owner-selected).                  */
/*                                                                     */
/* The assistant's factual diet used to be the business profile +    */
/* the chatbot's own KB only — module content (the shop's products,  */
/* booking services, the price book…) was never read in, which is    */
/* why Victoria's agent could not say what plants she sells. Now     */
/* buildAssistantContext also composes BOUNDED, query-scored,        */
/* source-labelled digests from the Batch 122 SHARED LAYER (never a  */
/* per-module silo read), the site's own pages, and the KB — and     */
/* the owner controls every source from Chatbot → Settings →         */
/* Knowledge sources. Chat and voice read the SAME assembly          */
/* (buildAssistantContext), so a toggle behaves identically on       */
/* both surfaces.                                                      */
/* ------------------------------------------------------------------ */

/** Module types whose published content can brief the assistant.
 *  Every entry is a shared-layer PROVIDER; the provider types NOT
 *  listed are excluded deliberately:
 *   - socialfeed / googlereviews — third-party text (other people's
 *     posts and reviews, names included), transient and noisy;
 *   - categories — taxonomy labels only; the items themselves
 *     already arrive through their own scope provider;
 *   - photocapture — visitor-submitted names/messages (visitor
 *     content, even once approved);
 *   - qrcode — payloads are URLs / WiFi identifiers, not answers
 *     (and WiFi payload discipline from Batch 134). */
const ANSWERABLE_MODULE_TYPES = [
  'ecommerce',
  'bookings',
  'pricing',
  'faq',
  'menu',
  'courses',
  'events',
  'offers',
  'blog',
  'gallery',
  'testimonials',
  'team',
  'directory',
  'careers',
  'video',
];

/** Digest budget — every family is capped, so the composed context
 *  stays bounded no matter how much content a site carries. The KB
 *  keeps its existing discipline (12 docs / 8000 chars). */
const SOURCE_ITEMS_PER_MODULE = 10;
const SOURCE_MODULE_CHARS = 2400;
const SOURCE_MODULES_TOTAL_CHARS = 9000;
const SOURCE_PAGE_CHARS = 1500;
const SOURCE_PAGES_MAX = 6;
const SOURCE_PAGES_TOTAL_CHARS = 6000;

const KNOWLEDGE_SOURCE_GROUPS = ['modules', 'pages', 'knowledge'];
/** Page slugs that are pure transaction shells, never answer
 *  content — excluded from page digests AND from the settings list. */
const KNOWLEDGE_SHELL_SLUGS = new Set(['checkout', 'cart']);

/** Lenient read-side sanitize (stored data was validated on save).
 *  Returns null when nothing usable is stored — null means all-on. */
function sanitizeKnowledgeSources(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out = { groups: {}, modules: {}, pages: {}, knowledge: {} };
  const groups = value.groups && typeof value.groups === 'object' ? value.groups : {};
  for (const g of KNOWLEDGE_SOURCE_GROUPS) {
    if (groups[g] != null) out.groups[g] = !!groups[g];
  }
  const mods = value.modules && typeof value.modules === 'object' ? value.modules : {};
  for (const [k, v] of Object.entries(mods)) {
    const t = String(k).trim().toLowerCase();
    if (t && v != null) out.modules[t] = !!v;
  }
  const pages = value.pages && typeof value.pages === 'object' ? value.pages : {};
  for (const [k, v] of Object.entries(pages)) {
    const s = String(k).trim().toLowerCase().slice(0, 120);
    if (s && v != null) out.pages[s] = !!v;
  }
  const docs = value.knowledge && typeof value.knowledge === 'object' ? value.knowledge : {};
  for (const [k, v] of Object.entries(docs)) {
    const id = Number(k);
    if (Number.isInteger(id) && id > 0 && v != null) out.knowledge[String(id)] = !!v;
  }
  return out;
}

/**
 * The effective source resolver for a settings object. Absent config
 * (null — every legacy row) and absent entries both mean ON; only an
 * explicit stored `false` (or a group switched off) removes a
 * source. This is the ONE gate every digest/KB read goes through.
 */
function knowledgeSourcesFromSettings(settings) {
  const cfg = sanitizeKnowledgeSources(settings && settings.knowledge_sources);
  const groups = (cfg && cfg.groups) || {};
  const modulesMap = (cfg && cfg.modules) || {};
  const pagesMap = (cfg && cfg.pages) || {};
  const docsMap = (cfg && cfg.knowledge) || {};
  return {
    config: cfg,
    groupOn(group) {
      return groups[group] !== false;
    },
    moduleOn(type) {
      if (groups.modules === false) return false;
      return modulesMap[String(type || '').trim().toLowerCase()] !== false;
    },
    pageOn(slug) {
      if (groups.pages === false) return false;
      return pagesMap[String(slug || '').trim().toLowerCase()] !== false;
    },
    docOn(id) {
      if (groups.knowledge === false) return false;
      return docsMap[String(Number(id))] !== false;
    },
  };
}

/**
 * The KB doc-id diet for a resolver: the exact set buildAssistantContext
 * feeds knowledgeSnippets. Batch 151 finisher (fence ruling): the
 * client MCP agent surface (server/clientMcp.js) must honour the same
 * toggles, so its KB reads go through knowledgeIncludeIds() below —
 * ONE filtered path for every agent-facing knowledge read. The portal
 * inbox preview (listPendingSessions) deliberately keeps the all-docs
 * behaviour: the owner sees everything.
 */
function knowledgeIncludeIdsFor(resolver, db, leadId) {
  if (!resolver.groupOn('knowledge')) return new Set();
  return new Set(
    listKnowledge(db, leadId)
      .filter((d) => resolver.docOn(d.id))
      .map((d) => Number(d.id))
  );
}

function knowledgeIncludeIds(db, leadId) {
  return knowledgeIncludeIdsFor(knowledgeSourcesFromSettings(getSettings(db, leadId)), db, leadId);
}

/**
 * Save-side validation for knowledge_sources. Unknown MODULE TYPES
 * are refused (the type list is static — a bad key can only be a
 * client bug, and the settings row is left untouched). Page slugs /
 * KB ids that no longer exist for this lead are dropped safely (a
 * toggle for deleted content is meaningless), never corrupting the
 * row. Sizes are capped so settings_json stays bounded.
 */
function normalizeKnowledgeSources(input, db, leadId) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw fail('VALIDATION', 'knowledge_sources must be an object', 400);
  }
  const modules = require('./siteModules');
  const out = { groups: {}, modules: {}, pages: {}, knowledge: {} };
  const groups = input.groups && typeof input.groups === 'object' ? input.groups : {};
  for (const g of KNOWLEDGE_SOURCE_GROUPS) {
    if (groups[g] != null) out.groups[g] = !!groups[g];
  }
  const mods = input.modules && typeof input.modules === 'object' ? input.modules : {};
  for (const [k, v] of Object.entries(mods)) {
    const t = String(k).trim().toLowerCase();
    if (!modules.MODULE_TYPES.includes(t)) {
      throw fail('VALIDATION', `Unknown module type in knowledge sources: ${k}`, 400);
    }
    if (v != null) out.modules[t] = !!v;
  }
  const pageSlugs = new Set(sitePages(db, leadId).map((p) => p.slug));
  const pages = input.pages && typeof input.pages === 'object' ? input.pages : {};
  for (const [k, v] of Object.entries(pages)) {
    const s = String(k).trim().toLowerCase().slice(0, 120);
    if (s && v != null && pageSlugs.has(s)) out.pages[s] = !!v;
    if (Object.keys(out.pages).length >= 300) break;
  }
  let docIds = new Set();
  try {
    docIds = new Set(
      db
        .prepare('SELECT id FROM chatbot_knowledge WHERE lead_id = ?')
        .all(Number(leadId))
        .map((r) => Number(r.id))
    );
  } catch {
    docIds = new Set();
  }
  const docs = input.knowledge && typeof input.knowledge === 'object' ? input.knowledge : {};
  for (const [k, v] of Object.entries(docs)) {
    const id = Number(k);
    if (Number.isInteger(id) && id > 0 && v != null && docIds.has(id)) out.knowledge[String(id)] = !!v;
    if (Object.keys(out.knowledge).length >= 1000) break;
  }
  return out;
}

function parseSettingsRow(row) {
  const base = { ...DEFAULT_SETTINGS };
  if (!row) return base;
  let extra = {};
  try {
    extra = JSON.parse(row.settings_json || '{}') || {};
  } catch {
    extra = {};
  }
  return {
    ...base,
    ...extra,
    greeting: row.greeting != null && String(row.greeting) !== '' ? String(row.greeting) : base.greeting,
    bubble_label:
      row.bubble_label != null && String(row.bubble_label) !== ''
        ? String(row.bubble_label).slice(0, 40)
        : base.bubble_label,
    primary_color: String(row.primary_color || ''),
    position: String(row.position || 'bottom-right'),
    escalate_email: String(row.escalate_email || ''),
    escalate_notify_portal: row.escalate_notify_portal == null ? true : !!row.escalate_notify_portal,
    suggest_lead_capture: row.suggest_lead_capture == null ? true : !!row.suggest_lead_capture,
    agent_timeout_hint_sec: Number(row.agent_timeout_hint_sec) || 90,
    ai_fallback: extra.ai_fallback == null ? base.ai_fallback : !!extra.ai_fallback,
    qualifying_enabled: extra.qualifying_enabled == null ? base.qualifying_enabled : !!extra.qualifying_enabled,
    qualifying_questions: sanitizeQualifyingQuestions(extra.qualifying_questions),
    voice_enabled: extra.voice_enabled == null ? base.voice_enabled : !!extra.voice_enabled,
    voice_name: REALTIME_VOICES.includes(String(extra.voice_name || ''))
      ? String(extra.voice_name)
      : base.voice_name,
    voice_bubble_image: String(extra.voice_bubble_image || ''),
    knowledge_sources: sanitizeKnowledgeSources(extra.knowledge_sources),
  };
}

function getRawSettings(db, leadId) {
  ensureTables(db);
  const row = db.prepare('SELECT * FROM chatbot_settings WHERE lead_id = ?').get(Number(leadId));
  return parseSettingsRow(row);
}

/**
 * Batch 140 — getSettings returns the EFFECTIVE settings: the
 * qualifying list is resolved through resolveQualifyingQuestions
 * (owner's stored list wins byte-for-byte; empty stored list ->
 * the industry defaults for the lead's category). Provenance
 * rides along: qualifying_questions_source ('owner' |
 * 'industry_default'), qualifying_industry (the resolved family
 * label) and qualifying_questions_stored (the raw stored list).
 * Every context builder — AI fallback, live-agent context, and
 * Batch 138's voice context via buildAssistantContext — reads
 * settings through here, so chat and voice share one resolver.
 */
function getSettings(db, leadId) {
  const raw = getRawSettings(db, leadId);
  const resolved = resolveQualifyingQuestions(db, leadId, raw.qualifying_questions);
  return {
    ...raw,
    qualifying_questions: resolved.questions,
    qualifying_questions_stored: sanitizeQualifyingQuestions(raw.qualifying_questions),
    qualifying_questions_source: resolved.source,
    qualifying_industry: resolved.industry,
  };
}

function saveSettings(db, leadId, data = {}) {
  ensureTables(db);
  // Batch 140: fallbacks read the RAW stored settings — a partial
  // save must never freeze the resolved industry defaults into
  // the owner's stored list.
  const cur = getRawSettings(db, leadId);
  const next = {
    greeting: data.greeting != null ? String(data.greeting).slice(0, 500) : cur.greeting,
    bubble_label: data.bubble_label != null ? String(data.bubble_label).slice(0, 40) : cur.bubble_label,
    primary_color: data.primary_color != null ? String(data.primary_color).slice(0, 32) : cur.primary_color,
    position: data.position != null ? String(data.position).slice(0, 32) : cur.position,
    escalate_email: data.escalate_email != null ? String(data.escalate_email).slice(0, 200) : cur.escalate_email,
    escalate_notify_portal:
      data.escalate_notify_portal != null ? !!data.escalate_notify_portal : cur.escalate_notify_portal,
    suggest_lead_capture: data.suggest_lead_capture != null ? !!data.suggest_lead_capture : cur.suggest_lead_capture,
    agent_timeout_hint_sec:
      data.agent_timeout_hint_sec != null
        ? Math.min(600, Math.max(15, Number(data.agent_timeout_hint_sec) || 90))
        : cur.agent_timeout_hint_sec,
    ai_fallback: data.ai_fallback != null ? !!data.ai_fallback : cur.ai_fallback,
    qualifying_enabled: data.qualifying_enabled != null ? !!data.qualifying_enabled : cur.qualifying_enabled,
    qualifying_questions:
      data.qualifying_questions != null
        ? normalizeQualifyingQuestions(data.qualifying_questions)
        : cur.qualifying_questions,
    voice_enabled: data.voice_enabled != null ? !!data.voice_enabled : cur.voice_enabled,
    voice_name:
      data.voice_name != null
        ? REALTIME_VOICES.includes(String(data.voice_name))
          ? String(data.voice_name)
          : (() => {
              throw fail('VALIDATION', `voice_name must be one of: ${REALTIME_VOICES.join(', ')}`, 400);
            })()
        : cur.voice_name,
    // voice_bubble_image is written ONLY by the upload/remove path in
    // chatbotVoice.js (it validates + stores the file first); a plain
    // settings save always preserves the current value.
    voice_bubble_image: cur.voice_bubble_image,
    // Batch 151: the knowledge-source selection is replaced wholesale
    // when the panel saves it (validated against this lead's real
    // modules/pages/docs); an unrelated settings save preserves it.
    knowledge_sources:
      data.knowledge_sources != null
        ? normalizeKnowledgeSources(data.knowledge_sources, db, leadId)
        : cur.knowledge_sources,
  };
  // Preserve settings_json extras this build does not own (Batch 136
  // booking-pitch + Batch 137 qualifying-questions keys land here after
  // the rebase) — a chatbot settings save must never wipe a sibling
  // feature's extras.
  let prevExtras = {};
  try {
    const row = db.prepare('SELECT settings_json FROM chatbot_settings WHERE lead_id = ?').get(Number(leadId));
    prevExtras = JSON.parse((row && row.settings_json) || '{}') || {};
  } catch {
    prevExtras = {};
  }
  const extras = {
    ...prevExtras,
    ai_fallback: next.ai_fallback,
    qualifying_enabled: next.qualifying_enabled,
    qualifying_questions: next.qualifying_questions,
    voice_enabled: next.voice_enabled,
    voice_name: next.voice_name,
    voice_bubble_image: next.voice_bubble_image,
    knowledge_sources: next.knowledge_sources,
  };
  db.prepare(
    `
    INSERT INTO chatbot_settings (
      lead_id, greeting, bubble_label, primary_color, position, escalate_email,
      escalate_notify_portal, suggest_lead_capture, agent_timeout_hint_sec, settings_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(lead_id) DO UPDATE SET
      greeting=excluded.greeting,
      bubble_label=excluded.bubble_label,
      primary_color=excluded.primary_color,
      position=excluded.position,
      escalate_email=excluded.escalate_email,
      escalate_notify_portal=excluded.escalate_notify_portal,
      suggest_lead_capture=excluded.suggest_lead_capture,
      agent_timeout_hint_sec=excluded.agent_timeout_hint_sec,
      settings_json=excluded.settings_json,
      updated_at=datetime('now')
  `
  ).run(
    Number(leadId),
    next.greeting,
    next.bubble_label,
    next.primary_color,
    next.position,
    next.escalate_email,
    next.escalate_notify_portal ? 1 : 0,
    next.suggest_lead_capture ? 1 : 0,
    next.agent_timeout_hint_sec,
    JSON.stringify(extras)
  );
  return getSettings(db, leadId);
}

function publicKnowledge(row) {
  if (!row) return null;
  return {
    id: row.id,
    lead_id: row.lead_id,
    kind: row.kind,
    title: row.title,
    url: row.url,
    content_text: row.content_text,
    file_name: row.file_name,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    has_file: !!row.file_path,
  };
}

function listKnowledge(db, leadId, { includeInactive = false } = {}) {
  ensureTables(db);
  let sql = 'SELECT * FROM chatbot_knowledge WHERE lead_id = ?';
  if (!includeInactive) sql += " AND status = 'active'";
  sql += ' ORDER BY id DESC';
  return db.prepare(sql).all(Number(leadId)).map(publicKnowledge);
}

function getKnowledge(db, leadId, id) {
  ensureTables(db);
  return publicKnowledge(
    db.prepare('SELECT * FROM chatbot_knowledge WHERE lead_id = ? AND id = ?').get(Number(leadId), Number(id))
  );
}

function addKnowledge(db, leadId, data = {}) {
  ensureTables(db);
  const kind = String(data.kind || (data.url ? 'link' : 'doc')).toLowerCase() === 'doc' ? 'doc' : 'link';
  const title = String(data.title || data.url || data.file_name || 'Knowledge')
    .trim()
    .slice(0, 200);
  const url = String(data.url || '')
    .trim()
    .slice(0, 2000);
  const content = String(data.content_text || data.content || data.body || '').slice(0, 200000);
  const fileName = String(data.file_name || data.fileName || '').slice(0, 200);
  const filePath = String(data.file_path || data.filePath || '').slice(0, 500);
  if (kind === 'link' && !url && !content) {
    throw fail('VALIDATION', 'url or content_text required for knowledge link', 400);
  }
  if (kind === 'doc' && !content && !filePath) {
    throw fail('VALIDATION', 'content_text or uploaded file required for knowledge doc', 400);
  }
  const info = db
    .prepare(
      `
    INSERT INTO chatbot_knowledge
      (lead_id, kind, title, url, content_text, file_name, file_path, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active')
  `
    )
    .run(Number(leadId), kind, title || (kind === 'link' ? url : 'Document'), url, content, fileName, filePath);
  return getKnowledge(db, leadId, info.lastInsertRowid);
}

function updateKnowledge(db, leadId, id, data = {}) {
  ensureTables(db);
  const row = db
    .prepare('SELECT * FROM chatbot_knowledge WHERE lead_id = ? AND id = ?')
    .get(Number(leadId), Number(id));
  if (!row) throw fail('NOT_FOUND', 'Knowledge item not found', 404);
  const kind = data.kind != null ? (String(data.kind).toLowerCase() === 'doc' ? 'doc' : 'link') : row.kind;
  const title = data.title != null ? String(data.title).trim().slice(0, 200) : row.title;
  const url = data.url != null ? String(data.url).trim().slice(0, 2000) : row.url;
  const content =
    data.content_text != null || data.content != null || data.body != null
      ? String(data.content_text != null ? data.content_text : data.content != null ? data.content : data.body).slice(
          0,
          200000
        )
      : row.content_text;
  const status =
    data.status != null ? (String(data.status).toLowerCase() === 'inactive' ? 'inactive' : 'active') : row.status;
  db.prepare(
    `
    UPDATE chatbot_knowledge SET kind=?, title=?, url=?, content_text=?, status=?,
      updated_at=datetime('now') WHERE id=? AND lead_id=?
  `
  ).run(kind, title, url, content, status, row.id, Number(leadId));
  return getKnowledge(db, leadId, row.id);
}

function deleteKnowledge(db, leadId, id) {
  ensureTables(db);
  const row = db
    .prepare('SELECT * FROM chatbot_knowledge WHERE lead_id = ? AND id = ?')
    .get(Number(leadId), Number(id));
  if (!row) throw fail('NOT_FOUND', 'Knowledge item not found', 404);
  if (row.file_path) {
    try {
      const abs = path.isAbsolute(row.file_path) ? row.file_path : path.join(process.cwd(), row.file_path);
      if (fs.existsSync(abs)) fs.unlinkSync(abs);
    } catch {
      /* ignore */
    }
  }
  db.prepare('DELETE FROM chatbot_knowledge WHERE id = ? AND lead_id = ?').run(row.id, Number(leadId));
  return { deleted: true, id: row.id };
}

/** Snippets for agent prompt (client MCP chatbot.knowledge / reply context).
 *  Batch 151: opts.includeIds (a Set of doc ids) restricts the diet
 *  to the owner's selected KB documents — buildAssistantContext
 *  passes the allowed set; other callers omit it and keep the
 *  historical all-active-docs behaviour. */
function knowledgeSnippets(db, leadId, { limit = 12, maxChars = 6000, query = '', includeIds = null } = {}) {
  const extract = require('./chatbotKnowledgeExtract');
  let all = listKnowledge(db, leadId, { includeInactive: false });
  if (includeIds) all = all.filter((it) => includeIds.has(Number(it.id)));
  const q = String(query || '').trim();
  let items = all.slice();
  if (q) {
    items = items
      .map((it) => ({
        it,
        score: extract.scoreText(`${it.title}\n${it.content_text || ''}\n${it.url || ''}`, q),
      }))
      .sort((a, b) => b.score - a.score || b.it.id - a.it.id)
      .map((x) => x.it);
  }
  items = items.slice(0, limit);
  const perDoc = Math.max(400, Math.floor(maxChars / Math.max(1, Math.min(items.length, 6))));
  const chunks = [];
  let used = 0;
  for (const it of items) {
    const head = `[${it.kind}] ${it.title}${it.url ? ` (${it.url})` : ''}${it.file_name ? ` «${it.file_name}»` : ''}`;
    const raw = String(it.content_text || '').trim();
    const body = q && raw.length > perDoc ? extract.searchWindows(raw, q, { maxChars: perDoc }) : raw.slice(0, perDoc);
    const piece = body ? `${head}\n${body}` : head;
    if (used + piece.length > maxChars) {
      const remain = Math.max(0, maxChars - used - 20);
      if (remain > 40) chunks.push(`${piece.slice(0, remain)}…`);
      break;
    }
    chunks.push(piece);
    used += piece.length + 2;
  }
  return {
    count: all.length,
    matched: items.length,
    query: q || undefined,
    snippets: chunks,
    text: chunks.join('\n\n---\n\n'),
    supported_types: extract.SUPPORTED_LABEL,
  };
}

/* ------------------------------------------------------------------ */
/* Batch 151 — digests: shared-layer modules + site pages, composed  */
/* into ONE labelled text block by buildAssistantContext.            */
/* ------------------------------------------------------------------ */

/** The lead's site pages (latest websites row), parsed. [] when the
 *  lead has no site — page digests simply have nothing to read. */
function sitePageRows(db, leadId) {
  try {
    const site = db.prepare('SELECT pages FROM websites WHERE lead_id = ? ORDER BY id DESC LIMIT 1').get(Number(leadId));
    if (!site || !site.pages) return [];
    const pages = typeof site.pages === 'string' ? JSON.parse(site.pages || '[]') : site.pages;
    return Array.isArray(pages) ? pages.filter((p) => p && typeof p === 'object') : [];
  } catch {
    return [];
  }
}

/** Owner-facing page list (shell pages excluded — they can never be
 *  answer sources, so they never get a toggle either). */
function sitePages(db, leadId) {
  return sitePageRows(db, leadId)
    .map((p) => ({
      slug: String(p.slug || '').trim().toLowerCase(),
      title: String(p.title || p.slug || '').trim().slice(0, 120),
    }))
    .filter((p) => p.slug && !KNOWLEDGE_SHELL_SLUGS.has(p.slug));
}

function digestStripText(v, max = 400) {
  return String(v == null ? '' : v)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

const SECTION_TEXT_SKIP_KEY =
  /^(id|slug|type|layout|width|height|align|position|style|class|classname|target|rel|icon|image|img|src|href|url|key|file|file_path|public_token|form_token|module_type|token)$/i;

function collectStrings(value, out, depth) {
  if (depth > 6 || out.length > 220) return;
  if (typeof value === 'string') {
    const s = value.trim();
    if (!s) return;
    if (/^(https?:)?\/\//i.test(s) || s.startsWith('data:') || s.startsWith('#')) return;
    if (/^#[0-9a-f]{3,8}$/i.test(s)) return;
    if (!/\s/.test(s) && s.length > 80) return; // opaque id/token material
    out.push(digestStripText(s, 500));
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out, depth + 1);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (SECTION_TEXT_SKIP_KEY.test(k) || /token/i.test(k) || /_url$/i.test(k)) continue;
      if (k === 'html' && typeof v === 'string') {
        const t = digestStripText(v, 4000);
        if (t) out.push(t);
        continue;
      }
      collectStrings(v, out, depth + 1);
    }
  }
}

/** Plain text of one page model: section content strings with tags
 *  stripped. Chrome sections (nav/footer), module mounts (their
 *  content arrives via the module digests) and the chat embed are
 *  skipped; a freeform page.html is read the same way. */
function pagePlainText(page) {
  const chunks = [];
  if (page && Array.isArray(page.sections)) {
    for (const sec of page.sections) {
      if (!sec || typeof sec !== 'object') continue;
      const t = String(sec.type || '').toLowerCase();
      if (t === 'nav' || t === 'footer' || t === 'site_module' || t === 'module') continue;
      if (sec.content && sec.content.bitpype_chat_managed) continue;
      collectStrings(sec.content || {}, chunks, 0);
    }
  }
  if (page && typeof page.html === 'string') {
    const t = digestStripText(page.html, 8000);
    if (t) chunks.push(t);
  }
  return chunks.filter(Boolean).join('\n').slice(0, 20000);
}

/** Best-effort product → category names, resolved through the
 *  categories service's own assignments (Batch 124) — failure
 *  isolated: no categories simply means no category hints. */
function productCategoryMap(db, leadId) {
  const map = new Map();
  try {
    const cats = require('./categories').listCategories(db, Number(leadId), {
      scope: 'ecommerce',
      includeDrafts: false,
    });
    const share = require('./moduleShare');
    for (const c of cats || []) {
      let items = [];
      try {
        items = share.listSharedItemsByCategory(db, Number(leadId), c.id, { limit: 200 }).items || [];
      } catch {
        items = [];
      }
      for (const it of items) {
        if (it.source_type !== 'ecommerce') continue;
        const id = Number(it.source_id);
        if (!map.has(id)) map.set(id, []);
        map.get(id).push(String(c.name || '').trim());
      }
    }
  } catch {
    /* categories unavailable — digests carry names/prices/descriptions */
  }
  return map;
}

/** Digest scoring query: the visitor's words minus stopwords, fed
 *  to the SAME scorer the KB uses (chatbotKnowledgeExtract
 *  scoreText). Without this, "what type of plants do you sell"
 *  ranks a delivery FAQ ("do you… of…") above the shop itself —
 *  with it, the content terms (type / plants / sell) decide. An
 *  all-stopword query yields '' → every score 0 → natural order. */
const DIGEST_STOPWORDS = new Set([
  'what', 'which', 'do', 'does', 'did', 'you', 'your', 'yours', 'of', 'the', 'a', 'an',
  'is', 'are', 'was', 'were', 'can', 'could', 'i', 'me', 'my', 'we', 'our', 'it', 'its',
  'in', 'on', 'for', 'to', 'and', 'or', 'at', 'by', 'with', 'have', 'has', 'how', 'much',
  'many', 'there', 'here', 'please', 'tell', 'about', 'any',
]);
function digestScoringQuery(query) {
  return String(query || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !DIGEST_STOPWORDS.has(w))
    .join(' ');
}

const MODULE_SOURCE_LABELS = {
  ecommerce: 'From the shop',
  bookings: 'From the booking services',
  pricing: 'From the price list',
  faq: 'From the frequently asked questions',
  menu: 'From the menu',
  courses: 'From the courses',
  events: 'From the events',
  offers: 'From the current offers',
  blog: 'From the blog',
  gallery: 'From the photo galleries',
  testimonials: 'From customer testimonials',
  team: 'From the team page',
  directory: 'From the directory',
  careers: 'From the careers page',
  video: 'From the videos',
};

/** One digest line for one shared-layer item (uniform shape in,
 *  attributed text out). */
function moduleItemLine(type, it, catMap) {
  const meta = it.meta || {};
  const desc = it.description ? digestStripText(it.description, type === 'faq' ? 260 : 200) : '';
  if (type === 'faq') return desc ? `Q: ${it.title}\nA: ${desc}` : `Q: ${it.title}`;
  let line = String(it.title || '').trim();
  if (type === 'ecommerce') {
    const cats = catMap && catMap.get(Number(it.source_id));
    if (cats && cats.length) line += ` (${cats.join(', ')})`;
    const price = String(meta.price_label || '').trim();
    if (price) line += ` — ${price}`;
  } else if (type === 'bookings') {
    const bits = [String(meta.price_label || '').trim(), meta.duration_minutes ? `${meta.duration_minutes} min` : '']
      .filter(Boolean)
      .join(' · ');
    if (bits) line += ` — ${bits}`;
  } else if (type === 'menu') {
    if (meta.price_text) line += ` — ${meta.price_text}`;
  } else if (type === 'events') {
    if (it.date) line += ` — ${String(it.date).slice(0, 10)}`;
    if (meta.location) line += ` (${meta.location})`;
  } else if (type === 'gallery') {
    const caps = (Array.isArray(meta.images) ? meta.images : [])
      .map((im) => digestStripText((im && im.caption) || '', 80))
      .filter(Boolean)
      .slice(0, 5);
    if (caps.length) line += ` — photos: ${caps.join('; ')}`;
  } else if (type === 'testimonials') {
    const who = [it.title, meta.author_company || ''].filter(Boolean).join(', ');
    return desc ? `- “${desc}” — ${who}` : `- ${who}`;
  } else if (type === 'team') {
    if (meta.role_title) line += ` — ${meta.role_title}`;
  } else if (type === 'careers') {
    const bits = [meta.location || '', meta.employment_type || ''].filter(Boolean).join(' · ');
    if (bits) line += ` — ${bits}`;
  }
  if (desc && type !== 'gallery') line += ` — ${desc}`;
  return `- ${line}`;
}

/** Score + cap one module's items into a labelled block. */
function moduleSourceBlock(db, leadId, type, query, catMap) {
  const share = require('./moduleShare');
  const items = share.readProviderItems(db, Number(leadId), type);
  if (!items.length) return null;
  const extract = require('./chatbotKnowledgeExtract');
  const lines = items.map((it, idx) => {
    const line = moduleItemLine(type, it, catMap);
    return { line, idx, score: query ? extract.scoreText(line, query) : 0 };
  });
  lines.sort((a, b) => b.score - a.score || a.idx - b.idx);
  const picked = [];
  let used = 0;
  for (const l of lines) {
    if (picked.length >= SOURCE_ITEMS_PER_MODULE) break;
    if (used + l.line.length > SOURCE_MODULE_CHARS && picked.length) break;
    picked.push(l.line);
    used += l.line.length + 1;
  }
  if (!picked.length) return null;
  const label = MODULE_SOURCE_LABELS[type] || `From the ${type} module`;
  return {
    key: `module:${type}`,
    label,
    count: picked.length,
    topScore: lines.length ? Math.max(...lines.map((l) => l.score)) : 0,
    text: `${label}:\n${picked.join('\n')}`,
  };
}

/** Score + cap the site's pages into labelled blocks. */
function pageSourceBlocks(db, leadId, resolver, query) {
  const extract = require('./chatbotKnowledgeExtract');
  const rows = sitePageRows(db, leadId);
  const candidates = [];
  rows.forEach((page, idx) => {
    const slug = String(page.slug || '').trim().toLowerCase();
    if (!slug || KNOWLEDGE_SHELL_SLUGS.has(slug)) return;
    if (!resolver.pageOn(slug)) return;
    const text = pagePlainText(page);
    if (!text) return;
    const title = String(page.title || slug).trim().slice(0, 120);
    candidates.push({
      slug,
      title,
      idx,
      text,
      score: query ? extract.scoreText(`${title}\n${text}`, query) : 0,
    });
  });
  candidates.sort((a, b) => b.score - a.score || a.idx - b.idx);
  const blocks = [];
  let total = 0;
  for (const c of candidates) {
    if (blocks.length >= SOURCE_PAGES_MAX) break;
    const body = c.text.slice(0, SOURCE_PAGE_CHARS);
    const text = `[Page: ${c.title} (/${c.slug})]\n${body}`;
    if (total + text.length > SOURCE_PAGES_TOTAL_CHARS && blocks.length) break;
    blocks.push({ key: `page:${c.slug}`, label: `From the ${c.title} page`, slug: c.slug, title: c.title, text });
    total += text.length;
  }
  return blocks;
}

/**
 * The Batch 151 digest assembly — called ONLY from
 * buildAssistantContext, so text chat and voice brief identically.
 * Returns the composed, source-labelled text plus the per-source
 * inventory (also what the settings summary reports).
 */
function buildKnowledgeDigests(db, leadId, resolver, query = '') {
  const q = digestScoringQuery(query);
  const moduleBlocks = [];
  const moduleCounts = [];
  let includesPricing = false;
  if (resolver.groupOn('modules')) {
    let catMap = null;
    for (const type of ANSWERABLE_MODULE_TYPES) {
      if (!resolver.moduleOn(type)) continue;
      if (type === 'pricing') {
        // The price book rides its Batch 139 block VERBATIM (header
        // discipline included) — the same figures, the same wording,
        // now behind the owner's pricing toggle.
        try {
          const book = require('./moduleShare').getPriceBook(db, Number(leadId));
          if (book && Array.isArray(book.entries) && book.entries.length) {
            const text = require('./pricing').priceBookChatText(book);
            if (text) {
              moduleBlocks.push({
                key: 'module:pricing',
                label: 'From the price list',
                count: book.entries.length,
                topScore: q ? require('./chatbotKnowledgeExtract').scoreText(text, q) : 0,
                text,
              });
              moduleCounts.push({ type, count: book.entries.length });
              includesPricing = true;
            }
          }
        } catch {
          /* dormant — no book, no block */
        }
        continue;
      }
      if (type === 'ecommerce') catMap = productCategoryMap(db, leadId);
      let block = null;
      try {
        block = moduleSourceBlock(db, leadId, type, q, catMap);
      } catch {
        block = null;
      }
      if (block) {
        moduleBlocks.push(block);
        moduleCounts.push({ type, count: block.count });
      }
    }
  }
  // With a visitor query, the best-matching source leads the digest
  // (a "what plants" question puts the shop block first); with no
  // query the canonical module order stands. Stable sort — ties keep
  // the ANSWERABLE order.
  if (q) moduleBlocks.sort((a, b) => (b.topScore || 0) - (a.topScore || 0));
  // Module budget: whole blocks in order (a partial source is worse
  // than an absent one); a single oversized first block is truncated
  // to the cap rather than dropped.
  const cappedModules = [];
  let moduleTotal = 0;
  for (const b of moduleBlocks) {
    if (moduleTotal + b.text.length > SOURCE_MODULES_TOTAL_CHARS && cappedModules.length) break;
    cappedModules.push(b);
    moduleTotal += b.text.length + 2;
  }
  if (cappedModules.length === 1 && cappedModules[0].text.length > SOURCE_MODULES_TOTAL_CHARS) {
    cappedModules[0] = { ...cappedModules[0], text: cappedModules[0].text.slice(0, SOURCE_MODULES_TOTAL_CHARS) };
  }
  let pageBlocks = [];
  if (resolver.groupOn('pages')) {
    try {
      pageBlocks = pageSourceBlocks(db, leadId, resolver, q);
    } catch {
      pageBlocks = [];
    }
  }
  const blocks = [...cappedModules, ...pageBlocks];
  return {
    text: blocks.map((b) => b.text).join('\n\n'),
    blocks,
    includesPricing,
    modules: moduleCounts,
    pages: pageBlocks.map((b) => ({ slug: b.slug, title: b.title })),
  };
}

/**
 * The owner's Knowledge-sources panel data: every selectable source
 * with its live count and effective on/off state. Owner-facing only
 * (portal summary) — never part of the public widget config.
 */
function knowledgeSourcesFor(db, leadId) {
  const resolver = knowledgeSourcesFromSettings(getSettings(db, leadId));
  const modules = require('./siteModules');
  let embeds = [];
  try {
    embeds = modules.listEmbeds(db, Number(leadId));
  } catch {
    embeds = [];
  }
  const attached = new Set(embeds.map((e) => e.module_type));
  const share = require('./moduleShare');
  const moduleRows = [];
  for (const type of ANSWERABLE_MODULE_TYPES) {
    let count = 0;
    try {
      count =
        type === 'pricing'
          ? (share.getPriceBook(db, Number(leadId)).entries || []).length
          : share.readProviderItems(db, Number(leadId), type).length;
    } catch {
      count = 0;
    }
    if (!attached.has(type) && count === 0) continue;
    moduleRows.push({
      type,
      label: (modules.MODULE_META[type] && modules.MODULE_META[type].label) || type,
      count,
      enabled: resolver.moduleOn(type),
    });
  }
  return {
    config: resolver.config,
    groups: {
      modules: resolver.groupOn('modules'),
      pages: resolver.groupOn('pages'),
      knowledge: resolver.groupOn('knowledge'),
    },
    modules: moduleRows,
    pages: sitePages(db, leadId).map((p) => ({ ...p, enabled: resolver.pageOn(p.slug) })),
    knowledge: listKnowledge(db, leadId, { includeInactive: true }).map((d) => ({
      id: d.id,
      title: d.title,
      kind: d.kind,
      status: d.status,
      enabled: resolver.docOn(d.id),
    })),
  };
}

function makeSessionToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function publicMessage(row) {
  if (!row) return null;
  let meta = null;
  try {
    meta = row.meta_json ? JSON.parse(row.meta_json) : null;
  } catch {
    meta = null;
  }
  return {
    id: row.id,
    session_id: row.session_id,
    role: row.role,
    body: row.body,
    meta,
    created_at: row.created_at,
  };
}

function publicSession(row, { withMessages = false, messages = null } = {}) {
  if (!row) return null;
  let visitor = null;
  try {
    visitor = row.visitor_meta_json ? JSON.parse(row.visitor_meta_json) : null;
  } catch {
    visitor = null;
  }
  const out = {
    id: row.id,
    lead_id: row.lead_id,
    session_token: row.session_token,
    status: row.status,
    needs_agent: !!row.needs_agent,
    visitor,
    // Batch 137: the session's qualifying record (owner's questions
    // snapshotted + answer state), null when the feature never
    // engaged for this session.
    qualification: row.qualification_json ? parseQualificationRecord(row.qualification_json) : null,
    channel: row.channel || 'text',
    last_visitor_at: row.last_visitor_at,
    last_agent_at: row.last_agent_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  // Batch 167: the honest outcome + chat counters ride the session
  // ONLY when a chat state exists (sessions the redesigned fallback
  // engine has touched) — legacy and voice rows stay byte-identical.
  const chatState = row.chat_state_json ? parseChatState(row.chat_state_json) : null;
  if (chatState) {
    out.outcome = chatState.outcome;
    out.chat_state = {
      answered_count: chatState.answered_count,
      miss_streak: chatState.miss_streak,
      miss_total: chatState.miss_total,
      fact_check_blocks: chatState.fact_check_blocks,
      handoff_requested: chatState.handoff_requested,
    };
  }
  if ((row.channel || 'text') === 'voice') out.voice = publicVoiceBlock(row);
  if (withMessages) out.messages = Array.isArray(messages) ? messages : [];
  return out;
}

/* ── Batch 137: qualifying-question records ────────────────────────
 * One record per chat session, stored on chatbot_sessions as
 * qualification_json:
 *   { v: 1, questions: [owner texts, snapshotted],
 *     items: [{ question, answer, status, updated_at }],
 *     updated_at }
 * The question TEXT is snapshotted when the record is created, so
 * an owner editing the list later never rewrites a past session's
 * history — and update indexes always refer to the snapshot.
 * Statuses: pending → asked → answered | answered_from_conversation
 * | declined. The three end states are terminal/sticky: a later
 * "asked" report never erases an answer, and a declined question is
 * never re-asked. Recording is model-REPORTED (the fallback's JSON
 * or chatbot.reply's qualification param) but server-VALIDATED
 * here: unknown indexes/statuses are skipped, never stored raw.
 */

const QUALIFYING_STATUS_ALIASES = {
  asked: 'asked',
  answered: 'answered',
  answered_from_conversation: 'answered_from_conversation',
  'answered-from-conversation': 'answered_from_conversation',
  answered_from_convo: 'answered_from_conversation',
  mentioned: 'answered_from_conversation',
  declined: 'declined',
  skipped: 'declined',
  skipped_declined: 'declined',
  'skipped-declined': 'declined',
  passed: 'declined',
};

function normalizeQualifyingStatus(value) {
  return QUALIFYING_STATUS_ALIASES[String(value || '').trim().toLowerCase()] || null;
}

function emptyQualificationRecord(questions) {
  const now = new Date().toISOString();
  const qs = sanitizeQualifyingQuestions(questions);
  return {
    v: 1,
    questions: qs,
    items: qs.map((q) => ({ question: q, answer: null, status: 'pending', updated_at: null })),
    updated_at: now,
  };
}

function parseQualificationRecord(raw) {
  let obj = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw || '');
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.items)) return null;
  const items = obj.items
    .filter((it) => it && typeof it.question === 'string' && it.question.trim())
    .map((it) => {
      const item = {
        question: String(it.question).slice(0, QUALIFYING_MAX_CHARS),
        answer: it.answer != null ? String(it.answer).slice(0, QUALIFYING_ANSWER_MAX_CHARS) : null,
        status: normalizeQualifyingStatus(it.status) || 'pending',
        updated_at: it.updated_at != null ? String(it.updated_at) : null,
      };
      // Batch 167: re-ask bookkeeping rides the item ONLY when
      // non-default, so records written before this batch (and fresh
      // records) stay byte-identical to the Batch 137 shape.
      const reasks = Number(it.reasks) || 0;
      if (reasks > 0) item.reasks = reasks;
      if (it.muted) item.muted = true;
      return item;
    });
  if (!items.length) return null;
  const record = {
    v: 1,
    questions: items.map((it) => it.question),
    items,
    updated_at: obj.updated_at != null ? String(obj.updated_at) : null,
  };
  // Batch 167 (Rule C): qualification "starts" only after the first
  // substantive answered turn. The flag rides the record only once
  // true — absent means not started, exactly like pre-167 records.
  if (obj.started) record.started = true;
  return record;
}

function getSessionQualification(db, sessionId) {
  ensureTables(db);
  const row = db.prepare('SELECT qualification_json FROM chatbot_sessions WHERE id = ?').get(Number(sessionId));
  return row ? parseQualificationRecord(row.qualification_json) : null;
}

function saveSessionQualification(db, sessionId, record) {
  record.updated_at = new Date().toISOString();
  db.prepare("UPDATE chatbot_sessions SET qualification_json = ?, updated_at = datetime('now') WHERE id = ?").run(
    JSON.stringify(record),
    Number(sessionId)
  );
  return record;
}

/**
 * Return the session's record, creating it from the CURRENT owner
 * list when the feature is active and none exists yet. Returns
 * null when the feature is off/empty and no record exists. Once
 * created, the snapshot is frozen — later config edits never
 * touch it.
 */
function ensureSessionQualification(db, leadId, sessionId) {
  ensureTables(db);
  const existing = getSessionQualification(db, sessionId);
  if (existing) return existing;
  const cfg = qualifyingFor(db, leadId);
  if (!cfg) return null;
  return saveSessionQualification(db, sessionId, emptyQualificationRecord(cfg.questions));
}

/**
 * Apply model-reported state changes to a session's record.
 * updates: [{ index, status, answer? }] — index into the
 * SNAPSHOT list. Invalid entries are skipped (counted), never
 * thrown: a bad report must not break the visitor's reply flow.
 */
function recordQualificationUpdates(db, leadId, sessionId, updates, opts = {}) {
  ensureTables(db);
  const session = getSessionById(db, leadId, sessionId);
  if (!session) throw fail('NOT_FOUND', 'Session not found', 404);
  const list = Array.isArray(updates) ? updates : [];
  const record = ensureSessionQualification(db, leadId, session.id);
  if (!record) return { record: null, applied: 0, skipped: list.length, gated: 0, reason: 'not_configured' };
  // Batch 167: the visitor cancelled the questions outright (harness)
  // — nothing is recorded against them for the rest of the session.
  if (opts.suppressQual) return { record, applied: 0, skipped: 0, gated: list.length };
  let applied = 0;
  let skipped = 0;
  let gated = 0;
  for (const u of list) {
    let idx = u && u.index != null && Number.isInteger(Number(u.index)) ? Number(u.index) : -1;
    // Fallback: an update that names the question TEXT (exact
    // snapshot match) still lands on the right item.
    if ((idx < 0 || !record.items[idx]) && u && typeof u.question === 'string') {
      idx = record.items.findIndex((it) => it.question === u.question.trim());
    }
    const status = u ? normalizeQualifyingStatus(u.status) : null;
    const item = idx >= 0 ? record.items[idx] : null;
    if (!item || !status) {
      skipped += 1;
      continue;
    }
    const terminal = QUALIFYING_TERMINAL_STATUSES.includes(item.status);
    if (terminal && status !== item.status) {
      skipped += 1;
      continue;
    }
    // Batch 167 gates — AI-fallback path only (opts-gated, so
    // human-agent reports via chatbot.reply and direct callers keep
    // the exact Batch 137 semantics):
    if (status === 'asked') {
      // Rule C start gate: no question may be marked asked before
      // qualification has started (first substantive answered turn;
      // opts.startedThisTurn covers an answer+ask in the same reply).
      if (opts.enforceStartGate && !record.started && !opts.startedThisTurn) {
        gated += 1;
        continue;
      }
      // Rule C re-ask budget: re-asking the waiting question counts
      // against the platform-set budget; past it the item is muted
      // and the prompt stops offering it as askable.
      if (item.status === 'asked') {
        const reasks = (Number(item.reasks) || 0) + 1;
        item.reasks = reasks;
        const budget =
          Number.isInteger(opts.reaskBudget) && opts.reaskBudget >= 0
            ? opts.reaskBudget
            : CHAT_QUAL_REASK_BUDGET_DEFAULT;
        if (reasks > budget) item.muted = true;
      }
    }
    if (
      (status === 'answered' || status === 'answered_from_conversation') &&
      opts.guardMiscapture &&
      opts.latestVisitorText
    ) {
      // Rule C anti-miscapture gate: a visitor QUESTION (or request)
      // is never the answer to a pending question. The YWL failure
      // stored "what do you do" as the visitor's website address.
      // Blocked shapes: no answer text at all, the answer IS the
      // visitor's question verbatim (normalised), or the answer is
      // an echo of the question's own text. A genuine value embedded
      // in a longer message is NOT equal to the message, so real
      // answers still record.
      const msgText = String(opts.latestVisitorText || '');
      if (looksLikeQuestion(msgText) || looksLikeRequest(msgText)) {
        const ans = chatNormText(u && typeof u.answer === 'string' ? u.answer : '');
        if (!ans || ans === chatNormText(msgText) || ans === chatNormText(item.question)) {
          gated += 1;
          continue;
        }
      }
    }
    item.status = status;
    if (u.answer != null && typeof u.answer === 'string') {
      item.answer = u.answer.slice(0, QUALIFYING_ANSWER_MAX_CHARS) || null;
    }
    item.updated_at = new Date().toISOString();
    applied += 1;
  }
  if (applied > 0) saveSessionQualification(db, session.id, record);
  return { record, applied, skipped, gated };
}

/** Owner-facing status words — descriptive only, never pass/fail. */
const QUALIFYING_STATUS_LABELS = {
  answered: 'Answered',
  answered_from_conversation: 'Visitor mentioned it themselves',
  asked: 'Asked — no answer yet',
  declined: 'Visitor passed on this one',
  pending: 'Not asked yet',
};

function qualificationSummaryLines(record) {
  const rec = parseQualificationRecord(record);
  if (!rec) return [];
  const lines = [];
  for (const it of rec.items) {
    lines.push(`Q: ${it.question}`);
    lines.push(
      `A: ${it.answer ? it.answer : '—'} (${QUALIFYING_STATUS_LABELS[it.status] || it.status})`
    );
  }
  return lines;
}

function qualificationSummaryText(record) {
  const lines = qualificationSummaryLines(record);
  return lines.length ? `Qualifying questions:\n${lines.join('\n')}` : '';
}

/**
 * The fallback-prompt block for a session record. Questions are
 * interpolated byte-for-byte from the snapshot; the block exists
 * only when a record exists (feature active), so with the feature
 * off the prompt is exactly what it was before this batch.
 */
function qualifyingPromptLines(record) {
  const rec = parseQualificationRecord(record);
  if (!rec) return [];
  const state = (it) => {
    switch (it.status) {
      case 'answered':
        return `already answered: "${it.answer || ''}" — do NOT ask it again`;
      case 'answered_from_conversation':
        return `the visitor already mentioned this themselves: "${it.answer || ''}" — do NOT ask it`;
      case 'asked':
        // Batch 167: a question re-asked past its budget is muted —
        // the prompt must stop offering it as askable, or the model
        // keeps pumping it (YWL Rule C / E7).
        if (it.muted)
          return 'asked, then re-asked without an answer — do NOT ask it again this session; only record it if the visitor volunteers the answer';
        if (Number(it.reasks) > 0)
          return 'asked — waiting for their answer (already re-asked — if they dodge it again, let it go and report declined)';
        return 'asked — waiting for their answer';
      case 'declined':
        return 'the visitor passed on this one — do NOT ask it again';
      default:
        return 'not asked yet';
    }
  };
  // Batch 167 (Rule C): qualification starts only after the first
  // substantive ANSWERED turn. Before that the block is dormant —
  // the questions are listed so volunteered answers can still be
  // recognised, but the model is told plainly not to ask any of
  // them yet. (The YWL failure mode: the agent interrogated the
  // visitor before it had answered anything at all.)
  if (!rec.started) {
    return [
      'Qualifying questions from the business owner (NOT STARTED — do not ask any of them yet):',
      'These questions begin only after you have given this visitor a substantive answer of your own. Until then, just help them with what they asked. When they do start, ask them ONE at a time, exactly as written, woven naturally into the conversation — never as a list, never glued onto an unrelated reply.',
      ...rec.items.map((it, i) => `${i + 1}. "${it.question}" — ${state(it)}`),
      '- If the visitor volunteers an answer to one of these before they start, do not ask it — report it in your JSON "qualification" array as answered_from_conversation with the answer you found.',
      '',
    ];
  }
  return [
    'Qualifying questions from the business owner (ask them EXACTLY as written, word for word — never invent, add, or rephrase screening questions):',
    ...rec.items.map((it, i) => `${i + 1}. "${it.question}" — ${state(it)}`),
    'How to ask them:',
    '- Weave them into the conversation naturally, ONE at a time, as it progresses — a conversation, never a form or an interrogation.',
    "- If the visitor's own messages already answer a question, do not ask it — report it as answered_from_conversation with the answer you found.",
    '- Never ask a question that is already answered, and never re-ask one the visitor passed on.',
    '- If the visitor declines or deflects, drop it gracefully, report it as declined, and keep helping them.',
    '- Answering is always optional: never block help, information, lead capture, or booking on any of these questions, and never tell the visitor they passed or failed anything — there is no pass or fail.',
    '- In your JSON, also report state changes in a "qualification" array: [{"index":0,"status":"answered","answer":"..."}] — index is the question number above minus 1; statuses: asked, answered, answered_from_conversation, declined. Omit the array when nothing changed.',
    '',
  ];
}

/**
 * Batch 138 — the owner-facing voice block on a session. Never exposes
 * the relay-secret hash or the OpenAI session id. A voice session with
 * no recorded end long after it started reads as 'abrupt' (the browser
 * died mid-call) rather than pretending the conversation completed —
 * whatever transcript was relayed before the drop stays on the record.
 */
const VOICE_STALE_AFTER_MS = 65 * 60 * 1000; // OpenAI caps sessions at 60 min.
function publicVoiceBlock(row) {
  let closeState = row.voice_close_state || null;
  if (!closeState) {
    if (row.voice_ended_at) closeState = 'clean';
    else if (row.voice_started_at) {
      const started = Date.parse(String(row.voice_started_at).replace(' ', 'T') + 'Z');
      closeState = Number.isFinite(started) && Date.now() - started > VOICE_STALE_AFTER_MS ? 'abrupt' : 'open';
    } else {
      closeState = 'open';
    }
  }
  return {
    state: row.voice_state || null,
    started_at: row.voice_started_at || null,
    ended_at: row.voice_ended_at || null,
    duration_sec: row.voice_duration_sec != null ? Number(row.voice_duration_sec) : null,
    close_state: closeState,
    model: row.voice_model || null,
    voice: row.voice_voice_name || null,
  };
}

function getSessionByToken(db, token) {
  ensureTables(db);
  return db.prepare('SELECT * FROM chatbot_sessions WHERE session_token = ?').get(String(token || ''));
}

function getSessionById(db, leadId, id) {
  ensureTables(db);
  return db.prepare('SELECT * FROM chatbot_sessions WHERE lead_id = ? AND id = ?').get(Number(leadId), Number(id));
}

function listMessages(db, sessionId, { afterId = 0, limit = 100 } = {}) {
  ensureTables(db);
  const lim = Math.min(200, Math.max(1, Number(limit) || 100));
  const after = Number(afterId) || 0;
  return db
    .prepare(
      `
    SELECT * FROM chatbot_messages
    WHERE session_id = ? AND id > ?
    ORDER BY id ASC LIMIT ?
  `
    )
    .all(Number(sessionId), after, lim)
    .map(publicMessage);
}

function addMessage(db, sessionId, leadId, role, body, meta = null) {
  const text = String(body || '')
    .trim()
    .slice(0, 8000);
  if (!text) throw fail('VALIDATION', 'message body required', 400);
  const r = String(role || '').toLowerCase();
  if (!['visitor', 'agent', 'system'].includes(r)) {
    throw fail('VALIDATION', 'role must be visitor|agent|system', 400);
  }
  const info = db
    .prepare(
      `
    INSERT INTO chatbot_messages (session_id, lead_id, role, body, meta_json)
    VALUES (?, ?, ?, ?, ?)
  `
    )
    .run(Number(sessionId), Number(leadId), r, text, meta != null ? JSON.stringify(meta) : null);
  return publicMessage(db.prepare('SELECT * FROM chatbot_messages WHERE id = ?').get(info.lastInsertRowid));
}


function getPublicConfigByToken(db, token) {
  ensureTables(db);
  const modules = require('./siteModules');
  modules.ensureTables(db);
  const row = db
    .prepare("SELECT * FROM site_module_embeds WHERE public_token = ? AND module_type = 'chatbot' AND published = 1")
    .get(String(token || ''));
  if (!row || !row.embed_enabled) throw fail('NOT_FOUND', 'Chatbot not found', 404);
  // Review fix: an archived (soft-deleted) site's chatbot stops
  // serving — every public chat flow funnels through this config
  // read. Leads with no website are never blocked.
  try {
    const site = db
      .prepare('SELECT archived_at FROM websites WHERE lead_id = ?')
      .get(Number(row.lead_id));
    if (site && site.archived_at) throw fail('SITE_ARCHIVED', 'This site is no longer available', 410);
  } catch (e) {
    if (!e || e.code !== 'SITE_ARCHIVED') {
      /* minimal db without a websites table — nothing to gate on */
    } else throw e;
  }
  const settings = getSettings(db, row.lead_id);
  // SMS opt-in (Batch 25): the lead-capture form collects a phone, so it
  // offers the consent checkbox from this block.
  let smsOptInBlock = null;
  try {
    const smsOptIn = require('./smsOptIn');
    smsOptInBlock = smsOptIn.optInBlock(smsOptIn.businessNameForLead(db, row.lead_id));
  } catch {
    smsOptInBlock = null;
  }
  // Batch 77: the SMS-policy consent line rides with the opt-in block
  // (the chat lead-capture form collects a phone number).
  let smsPolicyBlock = null;
  try {
    smsPolicyBlock = require('./smsPolicy').policyBlock();
  } catch {
    smsPolicyBlock = null;
  }
  // Batch 139: the price book rides the public config too, so the
  // client agent answering through portal MCP quotes the same exact
  // figures as the AI fallback — one book, every surface. Null when
  // the owner has published no pricing entries.
  let priceBookBlock = null;
  try {
    priceBookBlock = priceBookFor(db, row.lead_id);
  } catch {
    priceBookBlock = null;
  }
  return {
    embed: modules.publicEmbed(row),
    module_type: 'chatbot',
    sms_optin: smsOptInBlock,
    sms_policy: smsPolicyBlock,
    price_book: priceBookBlock,
    settings: {
      greeting: settings.greeting,
      bubble_label: settings.bubble_label,
      primary_color: settings.primary_color,
      position: settings.position,
      suggest_lead_capture: settings.suggest_lead_capture,
      agent_timeout_hint_sec: settings.agent_timeout_hint_sec,
    },
    allowed_actions: listAllowedActions(db, row.lead_id),
    // Batch 136: the module-state booking pitch for this site's chat
    // context (null when bookings are not live on the site).
    booking_pitch: bookingPitchFor(db, row.lead_id),
    agent_path: {
      mode: 'portal_client_mcp',
      note: 'Visitor messages notify the client agent via portal MCP (chatbot.pending / chatbot.reply). No admin/workspace tools.',
    },
  };
}

/**
 * Batch 136 — the bookings module's declared pitch, read through
 * the ONE shared layer (moduleShare). Presence is MODULE STATE
 * ONLY: bookings live → a pitch exists; discount on → the pitch
 * carries the exact templated discount fact; discount off → pitch
 * with discount: null. Nothing here inspects the conversation.
 */
function bookingPitchFor(db, leadId) {
  try {
    return require('./moduleShare').getBookingPitch(db, Number(leadId));
  } catch {
    return null;
  }
}

function listAllowedActions(db, leadId) {
  const modules = require('./siteModules');
  modules.ensureTables(db);
  const embeds = modules.listEmbeds(db, Number(leadId)).filter((e) => e.published && e.embed_enabled);
  const byType = new Set(embeds.map((e) => e.module_type));
  const actions = [
    {
      id: 'lead_capture',
      label: 'Collect visitor contact details',
      via: 'public',
      endpoint: 'POST /api/v1/chat/public/:token/lead',
    },
    {
      id: 'escalate',
      label: 'Escalate to business (portal inbox)',
      via: 'client_mcp',
      tool: 'chatbot.escalate',
    },
  ];
  if (byType.has('bookings')) {
    const emb = embeds.find((e) => e.module_type === 'bookings');
    actions.push({
      id: 'bookings.slots',
      label: 'List available appointment slots',
      via: 'public',
      endpoint: `GET /api/v1/modules/public/${emb.public_token}/slots?date=YYYY-MM-DD`,
      capability: 'bookings',
    });
    actions.push({
      id: 'bookings.book',
      label: 'Book an appointment',
      via: 'public',
      endpoint: `POST /api/v1/modules/public/${emb.public_token}/book`,
      capability: 'bookings',
    });
    // Batch 136: the declared booking pitch rides the same action
    // list the chat agent already consumes — proactively offer the
    // booking route; include the discount line only when present.
    const pitch = bookingPitchFor(db, leadId);
    if (pitch) {
      actions.push({
        id: 'bookings.pitch',
        label: 'Offer online booking',
        via: 'shared_layer',
        capability: 'bookings',
        booking_path: pitch.booking_path,
        pitch_text: pitch.pitch_text,
        discount: pitch.discount,
        guidance: pitch.guidance,
      });
    }
  }
  try {
    const forms = require('./contactForms');
    forms.ensureTables(db);
    const formRows = db
      .prepare(
        "SELECT id, name, public_token FROM contact_forms WHERE lead_id = ? AND status = 'published' AND public_token IS NOT NULL AND public_token != '' LIMIT 20"
      )
      .all(Number(leadId));
    for (const f of formRows) {
      actions.push({
        id: `form.submit.${f.id}`,
        label: `Submit form: ${f.name || f.id}`,
        via: 'public',
        endpoint: `POST /api/v1/forms/public/${f.public_token}/submit`,
        formId: f.id,
        capability: 'forms',
      });
    }
  } catch {
    /* forms optional */
  }
  if (byType.has('ecommerce')) {
    const emb = embeds.find((e) => e.module_type === 'ecommerce');
    actions.push({
      id: 'ecommerce.list',
      label: 'List shop products',
      via: 'public',
      endpoint: `GET /api/v1/modules/public/${emb.public_token}`,
      capability: 'ecommerce',
      note: 'Show products from public module JSON; checkout links when present.',
    });
  }
  return actions;
}

function notifyClientAgent(db, message, meta = {}) {
  try {
    if (typeof process !== 'undefined' && process.stderr && process.stderr.write) {
      process.stderr.write(`[chatbot-agent] ${message}\n`);
    }
  } catch {
    /* ignore */
  }
  try {
    const { fireAgentTriggers } = require('../src/designAgentTrigger');
    fireAgentTriggers(db, {
      jobId: meta.sessionId || meta.jobId || null,
      reason: 'chatbot',
      status: 'waiting_on_agent',
      message,
      leadId: meta.leadId,
      sessionId: meta.sessionId,
      mcpHint:
        'Client MCP only: chatbot.pending / chatbot.next / chatbot.reply / chatbot.escalate. Do not use admin design.* or lead.* tools.',
    });
  } catch {
    /* ignore */
  }
}

function startOrGetSession(db, leadId, { sessionToken, visitor } = {}) {
  ensureTables(db);
  let row = null;
  if (sessionToken) row = getSessionByToken(db, sessionToken);
  if (row && Number(row.lead_id) !== Number(leadId)) {
    throw fail('FORBIDDEN', 'Session does not match chatbot', 403);
  }
  if (!row) {
    const token = makeSessionToken();
    const info = db
      .prepare(
        `
      INSERT INTO chatbot_sessions (lead_id, session_token, status, needs_agent, visitor_meta_json)
      VALUES (?, ?, 'open', 0, ?)
    `
      )
      .run(Number(leadId), token, visitor != null ? JSON.stringify(visitor) : null);
    row = db.prepare('SELECT * FROM chatbot_sessions WHERE id = ?').get(info.lastInsertRowid);
  }
  return row;
}

function postVisitorMessage(db, token, { sessionToken, message, visitor, workspaceId } = {}) {
  ensureTables(db);
  const cfg = getPublicConfigByToken(db, token);
  const leadId = cfg.embed.lead_id;
  const session = startOrGetSession(db, leadId, { sessionToken, visitor });
  const msg = addMessage(db, session.id, leadId, 'visitor', message);
  db.prepare(
    `
    UPDATE chatbot_sessions
    SET needs_agent = 1, last_visitor_at = datetime('now'), updated_at = datetime('now'),
        visitor_meta_json = COALESCE(?, visitor_meta_json)
    WHERE id = ?
  `
  ).run(visitor != null ? JSON.stringify(visitor) : null, session.id);

  notifyClientAgent(
    db,
    `Chatbot session #${session.id} needs a reply (lead ${leadId}). Client MCP: chatbot.next or chatbot.pending.`,
    { leadId, sessionId: session.id }
  );

  const settings = getSettings(db, leadId);
  if (settings.ai_fallback !== false && workspaceId) {
    scheduleAiFallbackReply({
      workspaceId: Number(workspaceId),
      leadId: Number(leadId),
      sessionId: Number(session.id),
    });
  }

  return {
    session: publicSession(getSessionByToken(db, session.session_token)),
    message: msg,
    poll_hint: 'GET /api/v1/chat/public/:token/messages?session=…&after=messageId',
    agent_boundary: 'portal_client_mcp_only',
    ai_fallback_scheduled: !!(settings.ai_fallback !== false && workspaceId),
  };
}

/**
 * Parse ChatGPT fallback output into { action: 'chat'|'answer'|'capture', reply }.
 * Accepts JSON (preferred), FOUND:/REPLY: markers, or ACTION: markers.
 * @param {string} raw
 * @param {{ businessName?: string, allowCapture?: boolean }} [opts]
 */
function parseAiFallbackResponse(raw, opts = {}) {
  const thanks = leadCaptureThanksFor(opts.businessName);
  const allowCapture = opts.allowCapture !== false;
  const text = String(raw || '').trim();
  if (!text) {
    return {
      action: allowCapture ? 'capture' : 'chat',
      found: false,
      reply: allowCapture ? thanks : 'What can we help you with today?',
    };
  }

  const normalize = (action, reply) => {
    let act = String(action || 'chat').toLowerCase();
    if (act === 'answer' || act === 'found' || act === 'yes') act = 'answer';
    if (act === 'capture' || act === 'lead' || act === 'escalate' || act === 'no' || act === 'false') act = 'capture';
    if (act !== 'answer' && act !== 'capture') act = 'chat';
    if (act === 'capture' && !allowCapture) act = 'chat';
    const body = String(reply || '').trim();
    if (act === 'capture' && !body) {
      return { action: 'capture', found: false, reply: thanks };
    }
    if (!body) {
      return { action: 'chat', found: false, reply: 'What can we help you with today?' };
    }
    return {
      action: act,
      found: act === 'answer',
      reply: body.slice(0, 4000),
    };
  };

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const obj = JSON.parse(jsonMatch[0]);
      if (obj && typeof obj === 'object') {
        // Batch 137: the model's qualifying-question state reports
        // ride the same JSON — raw here; recordQualificationUpdates
        // validates them against the session snapshot at write time.
        const qual = Array.isArray(obj.qualification) ? obj.qualification : null;
        const withQual = (r) => {
          if (qual) r.qualification = qual;
          return r;
        };
        const reply = String(obj.reply || obj.message || obj.answer || '').trim();
        if (obj.action != null) return withQual(normalize(obj.action, reply));
        // Legacy found:true|false
        const found =
          obj.found === true || obj.found === 'true' || obj.found === 1 || /^yes$/i.test(String(obj.found || ''));
        if (found) return withQual(normalize('answer', reply));
        return withQual(normalize(allowCapture ? 'capture' : 'chat', reply || (allowCapture ? thanks : '')));
      }
    } catch {
      /* fall through */
    }
  }

  const actionLine = text.match(/^\s*ACTION\s*:\s*(chat|answer|capture|lead)\s*$/im);
  const foundLine = text.match(/^\s*FOUND\s*:\s*(yes|no|true|false)\s*$/im);
  const replyBlock = text.match(/REPLY\s*:\s*([\s\S]+)/i);
  const reply = replyBlock ? String(replyBlock[1]).trim() : '';
  if (actionLine) return normalize(actionLine[1], reply);
  if (foundLine) {
    const found = /^(yes|true)$/i.test(foundLine[1]);
    return normalize(found ? 'answer' : allowCapture ? 'capture' : 'chat', reply);
  }

  if (/contact form is about to appear|opening a short contact form/i.test(text)) {
    return normalize(allowCapture ? 'capture' : 'chat', text);
  }
  return normalize('chat', text);
}

function postChatFallback(db, leadId, sessionId, replyText) {
  const msg = addMessage(
    db,
    sessionId,
    leadId,
    'agent',
    String(replyText || '')
      .trim()
      .slice(0, 4000),
    {
      source: 'ai_fallback',
      action: 'chat',
    }
  );
  // needs_agent cleared by claimNeedsAgent before applyFallbackAction.
  db.prepare(
    `
    UPDATE chatbot_sessions
    SET last_agent_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ?
  `
  ).run(Number(sessionId));
  return msg;
}

function postLeadCaptureFallback(db, leadId, sessionId, replyText, businessName) {
  const body = String(replyText || leadCaptureThanksFor(businessName)).trim() || leadCaptureThanksFor(businessName);
  // Agent warning first; client shows an in-chat button (Details tab) — never overlays messages.
  addMessage(db, sessionId, leadId, 'agent', body, {
    source: 'ai_fallback',
    action: 'capture',
    found: false,
  });
  const msg = addMessage(db, sessionId, leadId, 'system', LEAD_CAPTURE_SYSTEM, LEAD_CAPTURE_FORM_META);
  db.prepare(
    `
    UPDATE chatbot_sessions
    SET last_agent_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ?
  `
  ).run(Number(sessionId));
  return msg;
}

function aiFallbackTimerKey(workspaceId, sessionId) {
  return `${Number(workspaceId)}:${Number(sessionId)}`;
}

function cancelAiFallbackReply(workspaceId, sessionId) {
  const key = aiFallbackTimerKey(workspaceId, sessionId);
  if (!_aiFallbackTimers.has(key)) return false;
  clearTimeout(_aiFallbackTimers.get(key));
  _aiFallbackTimers.delete(key);
  return true;
}

function scheduleAiFallbackReply({ workspaceId, leadId, sessionId }) {
  const ws = Number(workspaceId);
  const lid = Number(leadId);
  const sid = Number(sessionId);
  if (!Number.isInteger(ws) || ws <= 0 || !Number.isInteger(lid) || !Number.isInteger(sid)) return;
  const key = aiFallbackTimerKey(ws, sid);
  if (_aiFallbackTimers.has(key)) clearTimeout(_aiFallbackTimers.get(key));
  const timer = setTimeout(() => {
    _aiFallbackTimers.delete(key);
    runAiFallbackReply(ws, lid, sid).catch((err) => {
      try {
        process.stderr.write(`[chatbot-ai] fallback failed session=${sid}: ${err && err.message}\n`);
      } catch {
        /* ignore */
      }
    });
  }, AI_FALLBACK_DELAY_MS);
  if (typeof timer.unref === 'function') timer.unref();
  _aiFallbackTimers.set(key, timer);
}

/* ================================================================== */
/* Batch 167 — chat redesign port (YWL Rules A–K). BitPype's chat has */
/* no deterministic flow engine: the routed model IS the brain, the   */
/* only "flows" are the owner's qualifying questions (137/140), the   */
/* lead-capture offer and the booking pitch fact. The port therefore  */
/* lands as (a) a deterministic harness evaluated in the AI fallback  */
/* turn before the model runs, (b) server-side gates on model-        */
/* reported qualification state, (c) per-session chat state with a    */
/* consecutive-miss ladder and honest outcomes, and (d) a price       */
/* fact-check on answered replies. Voice shares buildAssistantContext */
/* and is deliberately untouched (procedure parity out of scope).     */
/* ================================================================== */

// Sync fallbacks mirroring the platform setting defaults
// (server/platform.js PLATFORM_SETTING_DEFS: chat.qual_reask_budget,
// chat.fallback_handoff_at). Used only where the async platform read
// is unavailable (sync agent-reply path) — the fallback turn itself
// always reads the live settings.
const CHAT_QUAL_REASK_BUDGET_DEFAULT = 1;
const CHAT_FALLBACK_HANDOFF_AT_DEFAULT = 3;

const CHAT_STATE_DEFAULTS = {
  v: 1,
  answered_count: 0,
  miss_streak: 0,
  miss_total: 0,
  fact_check_blocks: 0,
  had_ai_unavailable: false,
  handoff_requested: false,
  suppress_qual: false,
  suppress_capture: false,
  suppress_booking: false,
  outcome: null,
  updated_at: null,
};

function parseChatState(raw) {
  let obj = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw || '');
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== 'object') return null;
  return {
    v: 1,
    answered_count: Number(obj.answered_count) || 0,
    miss_streak: Number(obj.miss_streak) || 0,
    miss_total: Number(obj.miss_total) || 0,
    fact_check_blocks: Number(obj.fact_check_blocks) || 0,
    had_ai_unavailable: !!obj.had_ai_unavailable,
    handoff_requested: !!obj.handoff_requested,
    suppress_qual: !!obj.suppress_qual,
    suppress_capture: !!obj.suppress_capture,
    suppress_booking: !!obj.suppress_booking,
    outcome: obj.outcome != null ? String(obj.outcome) : null,
    updated_at: obj.updated_at != null ? String(obj.updated_at) : null,
  };
}

function getChatState(db, sessionId) {
  ensureTables(db);
  const row = db.prepare('SELECT chat_state_json FROM chatbot_sessions WHERE id = ?').get(Number(sessionId));
  return row ? parseChatState(row.chat_state_json) : null;
}

function saveChatState(db, sessionId, state) {
  const next = { ...CHAT_STATE_DEFAULTS, ...(state || {}), v: 1, updated_at: new Date().toISOString() };
  db.prepare("UPDATE chatbot_sessions SET chat_state_json = ?, updated_at = datetime('now') WHERE id = ?").run(
    JSON.stringify(next),
    Number(sessionId)
  );
  return next;
}

/**
 * Rule G — the honest session outcome, computed from the RESULTING
 * STATE, never from a per-turn label: a captured lead resolves; an
 * open escalation (or a visitor-requested handoff) escalates; a
 * session where the AI actually answered something resolves; one
 * with misses / AI outages and nothing achieved is unresolved;
 * anything else is still open (or unresolved once closed).
 * Vocabulary mirrors the YWL outcome set.
 */
function computeChatOutcome(db, session) {
  if (!session) return 'open';
  const sid = Number(session.id);
  const lead = db.prepare('SELECT id FROM chatbot_leads WHERE session_id = ? LIMIT 1').get(sid);
  if (lead) return 'resolved';
  const esc = db
    .prepare("SELECT id FROM chatbot_escalations WHERE session_id = ? AND status = 'open' LIMIT 1")
    .get(sid);
  if (esc) return 'escalated';
  const state = parseChatState(session.chat_state_json);
  if (state && state.handoff_requested) return 'escalated';
  if (state && state.answered_count > 0) return 'resolved';
  if (state && (state.miss_total > 0 || state.had_ai_unavailable)) return 'unresolved';
  return session.status === 'open' ? 'open' : 'unresolved';
}

/** Recompute + persist the provisional outcome (and any mutation). */
function updateChatState(db, leadId, sessionId, mutator) {
  const session = getSessionById(db, leadId, sessionId);
  if (!session) return null;
  const state = parseChatState(session.chat_state_json) || { ...CHAT_STATE_DEFAULTS };
  if (typeof mutator === 'function') mutator(state);
  state.outcome = computeChatOutcome(db, { ...session, chat_state_json: JSON.stringify(state) });
  return saveChatState(db, sessionId, state);
}

/** Rule C: the first substantive answered turn starts qualification. */
function markQualificationStarted(db, leadId, sessionId) {
  const record = getSessionQualification(db, sessionId);
  if (!record || record.started) return record;
  record.started = true;
  return saveSessionQualification(db, sessionId, record);
}

/* ---- Harness predicates (Rule A) — ported semantics from the YWL
 * chatflow harness: whole-message/phrase level, evaluated BEFORE the
 * model sees the turn, and always disarmed when the reply reads as
 * an answer to the pending question itself (Rule E6 guard). ---- */
const CHAT_HARD_HUMAN_RE =
  /\b(human|real person|real human|actual person|live person|live agent|speak to someone|talk to someone|talk to a person|speak to a person|talk to the team|speak to the team|talk to a human|speak to a human|a person please|someone real|real agent|customer service|representative)\b/i;
const CHAT_FLOW_ABORT_RE =
  /\b(don'?t want to|do not want to|not interested|no longer interested|no thanks|no thank you|changed my mind|forget (it|this)|never ?mind|stop (this|that|it)|cancel (this|that|it|the booking)?|quit|give up)\b/i;
const CHAT_NO_ONLY_RE = /^\s*(no|nope|nah)\.?\s*$/i;
const CHAT_DECLINE_RE =
  /^\s*(no|nope|not really|rather not|rather not say|prefer not|don'?t want to|do not want to|none of your business|skip|pass|n\/a|na)\b/i;
const CHAT_HEDGE_RE = /\b(not sure|don'?t know|dont know|no idea|haven'?t decided|undecided|maybe later)\b/i;
const CHAT_REQUEST_OPENERS =
  /^(write|tell|show|give|make|create|sing|say|list|explain|describe|find|get|play|read|draw|compose|recite)\b/i;
const CHAT_REQUEST_NOUNS =
  /\b(poem|joke|song|essay|haiku|riddle|recipe|story|rap|limerick|tongue twister|weather|news|capital of|meaning of life)\b/i;
const CHAT_QUESTION_OPENERS =
  /^(what|when|where|which|who|whom|whose|why|how|can|could|do|does|did|is|are|was|were|will|would|should|have|has)\b/i;

function chatNormText(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function looksLikeQuestion(msg) {
  const m = String(msg || '').trim();
  if (!m) return false;
  if (m.includes('?')) return true;
  return CHAT_QUESTION_OPENERS.test(m);
}

function looksLikeRequest(msg) {
  const m = String(msg || '').trim();
  if (!m) return false;
  if (CHAT_REQUEST_NOUNS.test(m)) return true;
  return CHAT_REQUEST_OPENERS.test(m) && m.split(/\s+/).length >= 3;
}

function isChatDecline(msg) {
  return CHAT_DECLINE_RE.test(String(msg || ''));
}
function isChatHedge(msg) {
  return CHAT_HEDGE_RE.test(String(msg || ''));
}

/** Rule E6: a reply whose words appear inside the pending question's
 * own text is an ANSWER to it, never a new intent or an abort. */
function answerInQuestion(msg, qtext) {
  const m = chatNormText(msg);
  const q = chatNormText(qtext);
  if (!m || m.length < 4 || !q) return false;
  return (' ' + q + ' ').includes(' ' + m + ' ');
}

/** A substantive question/request — the unit the miss ladder counts. */
function isSubstantiveQuestion(msg) {
  const m = String(msg || '').trim();
  if (!m || isGreetingOnly(m)) return false;
  return looksLikeQuestion(m) || looksLikeRequest(m);
}

/* ---- Price grounding (Rule H / I4) — ported from the YWL brain:
 * every $ amount in an answered reply must trace to the price book,
 * a bookable price, or an amount stated in this turn's retrieved
 * knowledge/site text (or a sum of up to three listed prices). ---- */
function chatStatedAmounts(text) {
  const out = [];
  const re = /\$\s?(\d[\d,]*(?:\.\d{1,2})?)/g;
  let m;
  while ((m = re.exec(String(text || '')))) out.push(Number(m[1].replace(/,/g, '')));
  return out;
}

function allowedChatAmounts(baseCents, texts) {
  const base = [...new Set((baseCents || []).filter((n) => Number(n) > 0).map((n) => Math.round(Number(n))))];
  const set = new Set(base);
  set.add(0);
  const uniq = [...new Set(base.map((c) => c / 100))].slice(0, 12);
  for (let i = 0; i < uniq.length; i++)
    for (let j = i; j < uniq.length; j++) {
      set.add(Math.round((uniq[i] + uniq[j]) * 100));
      for (let k = j; k < uniq.length; k++) set.add(Math.round((uniq[i] + uniq[j] + uniq[k]) * 100));
    }
  for (const t of texts || []) for (const n of chatStatedAmounts(t)) set.add(Math.round(n * 100));
  return set;
}

function unverifiedChatAmounts(reply, allowedSet) {
  return chatStatedAmounts(reply).filter((n) => !allowedSet.has(Math.round(n * 100)));
}

const CHAT_FACT_CHECK_UNKNOWN_REPLY =
  "I don't have that price confirmed in the business's own material, so I don't want to guess at a figure. The team can give you the exact price — leave your details in the Details tab and they'll follow up, or ask me something else.";
const CHAT_CAPTURE_SUPPRESSED_REPLY =
  'Of course — happy to keep helping right here in the chat. What else would you like to know?';

/** Atomically claim needs_agent so AI fallback and live agent cannot both reply. */
function claimNeedsAgent(db, sessionId) {
  const info = db
    .prepare(
      `
    UPDATE chatbot_sessions
    SET needs_agent = 0, last_agent_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ? AND needs_agent = 1 AND status = 'open'
  `
    )
    .run(Number(sessionId));
  return Number(info && info.changes) > 0;
}

function applyFallbackAction(db, leadId, sessionId, parsed, businessName) {
  const action = parsed && parsed.action;
  if (action === 'capture') {
    return {
      ok: true,
      action: 'capture',
      found: false,
      message: postLeadCaptureFallback(db, leadId, sessionId, parsed.reply, businessName),
    };
  }
  if (action === 'answer') {
    const msg = addMessage(db, sessionId, leadId, 'agent', parsed.reply, {
      source: 'ai_fallback',
      action: 'answer',
      found: true,
    });
    db.prepare(
      `
      UPDATE chatbot_sessions
      SET last_agent_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ?
    `
    ).run(Number(sessionId));
    return { ok: true, action: 'answer', found: true, message: msg };
  }
  return {
    ok: true,
    action: 'chat',
    found: false,
    message: postChatFallback(db, leadId, sessionId, parsed.reply),
  };
}

/**
 * Batch 139 — the price-quote block for this lead, read through the
 * shared layer's price book (the owner's published Pricing entries,
 * linked prices resolved live from the source records). Returns
 * { text, count } when the book is non-empty, else null — no book,
 * no block, no prices quoted. The figures are the book's own labels,
 * byte-for-byte; the model is told to quote them exactly and never
 * net a discount itself (a Batch 136 booking discount, when on, is
 * applied by the booking system and stated by its own pitch).
 *
 * SEAM (Batch 138): the voice agent is a second surface of THIS
 * chatbot — its session context assembles from this same module, so
 * the price block joins voice sessions through this reader too; no
 * voice-side copy of the figures exists or may be built.
 */
function priceBookFor(db, leadId) {
  try {
    // Batch 151: the price list is one of the owner's knowledge
    // sources — switching the Pricing source off removes the book
    // from every surface at this one gate (default ON, as before).
    if (!knowledgeSourcesFromSettings(getSettings(db, leadId)).moduleOn('pricing')) return null;
    const book = require('./moduleShare').getPriceBook(db, Number(leadId));
    if (!book || !Array.isArray(book.entries) || !book.entries.length) return null;
    const text = require('./pricing').priceBookChatText(book);
    if (!text) return null;
    return { text, count: book.entries.length };
  } catch {
    return null;
  }
}

/**
 * ChatGPT (or heuristic) acts as business CS when no live client MCP agent has replied.
 * Brief chat to understand needs → warn → open contact form. Knowledge-only for facts.
 */
async function runAiFallbackReply(workspaceId, leadId, sessionId) {
  const domain = require('./domain');
  const { chat, aiConfigured } = require('../src/ai');

  const snapshot = domain.withDb(workspaceId, (db) => {
    const session = getSessionById(db, leadId, sessionId);
    if (!session || session.status !== 'open' || !session.needs_agent) {
      return { skip: true, reason: 'already_handled' };
    }
    const messages = listMessages(db, sessionId, { limit: 40 });
    const last = messages[messages.length - 1];
    if (last && (last.role === 'agent' || last.role === 'system')) {
      return { skip: true, reason: 'agent_already_replied' };
    }
    const visitorTexts = messages
      .filter((m) => m.role === 'visitor')
      .map((m) => m.body)
      .slice(-8);
    const latestVisitor = visitorTexts[visitorTexts.length - 1] || '';
    const { knowledge, settings, business, sources } = buildAssistantContext(db, leadId, {
      query: visitorTexts.join(' '),
    });
    const qualification = ensureSessionQualification(db, leadId, sessionId);
    return {
      skip: false,
      messages,
      visitorTexts,
      latestVisitor,
      knowledge,
      settings,
      business,
      sources,
      // Batch 136: the module-state booking pitch joins the context
      // snapshot — a function of the site's modules, never of what
      // the visitor has said in this conversation.
      bookingPitch: bookingPitchFor(db, leadId),
      qualification,
      // Batch 139: the owner's price book joins the context snapshot
      // — a fact about the business (like its hours), present only
      // when the owner has published pricing entries.
      priceBook: priceBookFor(db, leadId),
      // Batch 167: the session's chat state (miss ladder, handoff and
      // suppress flags, counters) and the grounded price amounts for
      // the Rule H fact-check — price book entries plus bookable
      // prices (booking services + shop products), in cents.
      chatState: parseChatState(session.chat_state_json),
      priceAmounts: (() => {
        try {
          const pricing = require('./pricing');
          const amounts = [];
          const book = pricing.getPriceBook(db, leadId);
          for (const e of book.entries || []) amounts.push(Number(e.price_cents) || 0);
          const links = pricing.listLinkables(db, leadId);
          for (const s of links.bookings || []) amounts.push(Number(s.price_cents) || 0);
          for (const p of links.ecommerce || []) amounts.push(Number(p.price_cents) || 0);
          return amounts;
        } catch {
          return [];
        }
      })(),
      configured: aiConfigured(db),
      allowCapture: visitorStatedNeed(messages),
    };
  });

  if (snapshot.skip) return { skipped: true, reason: snapshot.reason };

  /* ---- Batch 167 harness layer (Rule A) --------------------------
   * Evaluated on the visitor's latest message BEFORE the model runs
   * — and before the AI-ready branch, so a human request or a cancel
   * is honoured even when no AI provider is configured. Every check
   * is disarmed when the reply reads as an answer to the pending
   * qualifying question itself (Rule E6 guard). */
  const chatState0 = snapshot.chatState || { ...CHAT_STATE_DEFAULTS };
  const latestText = String(snapshot.latestVisitor || '');

  // A visitor who already asked for a person is waiting for one —
  // the AI stands down rather than jumping back in on every message.
  // (A human agent's reply clears the flag — see agentReply.)
  if (chatState0.handoff_requested) {
    return { skipped: true, reason: 'handoff_pending' };
  }

  const qualRec0 = snapshot.qualification;
  const askedIdx0 = qualRec0 ? qualRec0.items.findIndex((it) => it.status === 'asked') : -1;
  const askedItem0 = askedIdx0 >= 0 ? qualRec0.items[askedIdx0] : null;
  const answerLikely0 = !!askedItem0 && answerInQuestion(latestText, askedItem0.question);

  // (i) Human request → abort whatever was in play + handoff path.
  if (!answerLikely0 && CHAT_HARD_HUMAN_RE.test(latestText)) {
    return domain.withDb(workspaceId, (db) => {
      if (!claimNeedsAgent(db, sessionId)) return { skipped: true, reason: 'race' };
      escalateSession(db, leadId, {
        sessionId,
        message: latestText,
        reason: 'visitor_requested_human',
      });
      updateChatState(db, leadId, sessionId, (st) => {
        st.handoff_requested = true;
      });
      return { posted: true, via: 'harness_handoff' };
    });
  }

  // (ii) Cancel / stop / negation — only with something cancellable
  // in play (a waiting question, an offered capture form, or the
  // booking pitch the message names). Free-text conversation keeps
  // phrase-level exits; a bare "no" counts only at a choice point.
  const lastAgentMsg0 = [...(snapshot.messages || [])].reverse().find((m) => m.role === 'agent');
  const captureOffered0 = !!(
    lastAgentMsg0 &&
    lastAgentMsg0.meta &&
    (lastAgentMsg0.meta.action === 'capture' || lastAgentMsg0.meta.open_lead_form)
  );
  const bookingNamed0 = /\b(book|booking|appointment)\b/i.test(latestText) && !!snapshot.bookingPitch;
  let cancelTarget0 = null;
  if (
    !answerLikely0 &&
    (CHAT_FLOW_ABORT_RE.test(latestText) || (CHAT_NO_ONLY_RE.test(latestText) && (askedItem0 || captureOffered0)))
  ) {
    if (bookingNamed0) cancelTarget0 = { kind: 'booking', label: 'that booking' };
    else if (askedItem0) cancelTarget0 = { kind: 'qual', label: 'those questions' };
    else if (captureOffered0) cancelTarget0 = { kind: 'capture', label: 'asking for your details' };
  }
  if (cancelTarget0) {
    return domain.withDb(workspaceId, (db) => {
      if (!claimNeedsAgent(db, sessionId)) return { skipped: true, reason: 'race' };
      if (cancelTarget0.kind === 'qual') {
        try {
          recordQualificationUpdates(db, leadId, sessionId, [{ index: askedIdx0, status: 'declined' }]);
        } catch {
          /* recording must never break the cancel confirmation */
        }
      }
      updateChatState(db, leadId, sessionId, (st) => {
        if (cancelTarget0.kind === 'qual') st.suppress_qual = true;
        if (cancelTarget0.kind === 'capture') st.suppress_capture = true;
        if (cancelTarget0.kind === 'booking') st.suppress_booking = true;
      });
      const msg = postChatFallback(
        db,
        leadId,
        sessionId,
        `No problem — I've cancelled ${cancelTarget0.label}. Happy to keep helping here if you'd like.`
      );
      return { posted: true, via: 'harness_cancel', action: 'chat', message: msg };
    });
  }

  // Decline / hedge of the waiting question — recorded
  // deterministically (the snapshot copy is updated too, so THIS
  // turn's prompt already shows it declined) while the model keeps
  // helping as normal. Declined is terminal: never re-asked.
  let harnessDeclineIdx = -1;
  if (askedItem0 && !answerLikely0 && (isChatDecline(latestText) || isChatHedge(latestText))) {
    snapshot.qualification.items[askedIdx0] = { ...askedItem0, status: 'declined' };
    harnessDeclineIdx = askedIdx0;
  }

  const bizName = snapshot.business && snapshot.business.businessName;
  const thanks = leadCaptureThanksFor(bizName);
  const allowCapture = !!snapshot.allowCapture;

  // Batch 143 (full review): the AI gate was aiConfigured() alone —
  // the workspace's legacy ai.api_key. Since Batch 120 the send path
  // (src/ai chat(), task 'qa') resolves the PER-FUNCTION route, and
  // the Muse / OpenRouter profiles resolve platform-first: a site
  // whose qa function routes to a platform-keyed provider has
  // working AI even with no workspace key, and silently degraded to
  // canned heuristic replies here. Ask the routing layer whether
  // any routed 'qa' provider actually has a key before choosing the
  // heuristic path. (The OpenAI task-stack profile's key IS the
  // workspace ai.api_key — already known unset on this branch.)
  let aiReady = !!snapshot.configured;
  if (!aiReady) {
    try {
      aiReady = await domain.withDb(workspaceId, async (db) => {
        const { getSetting } = require('../src/ai');
        const platform = require('./platform');
        const aiRouting = require('./aiRouting');
        const [route, pMuse, pOr] = await Promise.all([
          aiRouting.getRoute('qa'),
          platform.getPlatformSetting('muse.model_api_key', ''),
          platform.getPlatformSetting('openrouter.api_key', ''),
        ]);
        const configured = {
          muse: !!String(pMuse || getSetting('muse.model_api_key', '', db) || '').trim(),
          openai: false,
          openrouter: !!String(pOr || getSetting('openrouter.api_key', '', db) || '').trim(),
        };
        return aiRouting.orderAttempts('qa', route, configured).some((a) => configured[a.provider]);
      });
    } catch {
      aiReady = false;
    }
  }

  // AI off → light heuristic conversation (never jump straight to form on "hi").
  if (!aiReady) {
    const heur = heuristicSupportReply(snapshot.latestVisitor, bizName, snapshot.messages);
    return domain.withDb(workspaceId, (db) => {
      if (!claimNeedsAgent(db, sessionId)) return { skipped: true, reason: 'race' };
      return { ...applyFallbackAction(db, leadId, sessionId, heur, bizName), via: 'heuristic' };
    });
  }

  // Batch 167: the flow budgets are platform settings (Admin →
  // Settings), never hard-coded — read them live for this turn;
  // the sync defaults apply only if the platform store is down.
  const chat167 = { reaskBudget: CHAT_QUAL_REASK_BUDGET_DEFAULT, handoffAt: CHAT_FALLBACK_HANDOFF_AT_DEFAULT };
  try {
    const platform = require('./platform');
    const [rb, ha] = await Promise.all([
      platform.getPlatformSetting('chat.qual_reask_budget', ''),
      platform.getPlatformSetting('chat.fallback_handoff_at', ''),
    ]);
    const rbn = Number.parseInt(String(rb || ''), 10);
    if (Number.isInteger(rbn) && rbn >= 0 && rbn <= 10) chat167.reaskBudget = rbn;
    const han = Number.parseInt(String(ha || ''), 10);
    if (Number.isInteger(han) && han >= 1 && han <= 10) chat167.handoffAt = han;
  } catch {
    /* defaults stand */
  }

  const historyLines = (snapshot.messages || [])
    .slice(-12)
    .map((m) => {
      const who = m.role === 'visitor' ? 'Visitor' : m.role === 'agent' ? 'Agent' : 'System';
      return `${who}: ${m.body}`;
    })
    .join('\n');

  const bizBlock = (snapshot.business && snapshot.business.text) || `Business name: ${bizName || 'our business'}`;
  const knowledgeBlock =
    snapshot.knowledge && snapshot.knowledge.count > 0 ? snapshot.knowledge.text : '(no knowledge files uploaded yet)';

  let raw = '';
  let chatMessagesRef = null; // Batch 167: kept for the fact-check regeneration.
  try {
    const result = await domain.withDb(workspaceId, async (db) =>
      chat({
        task: 'qa',
        db,
        leadId,
        note: `chatbot-fallback session=${sessionId}`,
        maxTokens: 450,
        messages: (chatMessagesRef = [
          {
            role: 'system',
            content: [
              `You are a friendly, professional customer-support agent for ${bizName || 'this business'}.`,
              'Speak as their website chat support — not a generic AI. Use the business name naturally.',
              'Goal: have a brief conversation, understand what the visitor needs, then (only when ready) hand off to a contact form because a human cannot reply in this chat immediately.',
              '',
              'Business profile (you may share contact/identity when asked):',
              bizBlock,
              '',
              // Batch 136: module-state booking pitch — an always-true
              // fact about this site (like its hours), included purely
              // because the bookings module is live. No visitor-signal
              // judgment gates it; the discount line exists only when
              // the owner has the discount on.
              ...(snapshot.bookingPitch && !chatState0.suppress_booking
                ? [
                    'Online booking (always true on this site):',
                    snapshot.bookingPitch.pitch_text,
                    snapshot.bookingPitch.guidance,
                    '',
                  ]
                : []),
              // Batch 137: the owner's qualifying questions + this
              // session's answer state. Conditional spread — with
              // the feature off the prompt is byte-identical to
              // before. (Post-rebase this block sits immediately
              // AFTER Batch 136's booking-pitch block: site fact
              // first, then the owner's questions; the two blocks
              // are independent — neither gates the other.)
              ...(chatState0.suppress_qual ? [] : qualifyingPromptLines(snapshot.qualification)),
              // Batch 139: the price book — templated exact figures
              // from the owner's Pricing module. The model quotes
              // ONLY these for prices; the header pins the discount
              // rule (list prices; never net a discount itself).
              // Batch 151: when the owner's source selection already
              // carries the book inside the site-content excerpts
              // below, the standalone block is skipped so the figures
              // appear exactly once (the sources block IS this text,
              // verbatim — see buildKnowledgeDigests).
              ...(snapshot.priceBook && !(snapshot.sources && snapshot.sources.includesPricing)
                ? [snapshot.priceBook.text, '']
                : []),
              // Batch 151: the owner's selected module + page
              // sources, each block labelled with its origin so the
              // model can attribute ("From the shop: ...").
              ...(snapshot.sources && snapshot.sources.text
                ? ['Site content excerpts (from the business’s own modules and pages):', snapshot.sources.text, '']
                : []),
              'Conversation rules:',
              '- Greetings or vague hellos → action "chat": welcome them and ask what they need. NEVER open the form yet.',
              '- If their need is unclear → action "chat": ask one short clarifying question.',
              '- If knowledge clearly answers a factual question → action "answer" with a short reply.',
              '- Factual claims (services, pricing, policies, availability) ONLY from the knowledge excerpts and site content excerpts above. Do not invent.',
              '- When you understand their need AND a human follow-up is the right next step → action "capture".',
              '- On capture, the reply MUST warn that a short contact form is about to appear (it overlays the chat) so they are not surprised, and explain the team will call/email them back.',
              allowCapture
                ? '- Capture is ALLOWED now (visitor has shared a need across at least two turns).'
                : '- Capture is NOT allowed yet — keep action "chat" until you understand their need.',
              '',
              'Respond with ONLY compact JSON:',
              '{"action":"chat"|"answer"|"capture","reply":"..."}',
              '',
              'Knowledge excerpts:',
              knowledgeBlock,
            ].join('\n'),
          },
          {
            role: 'user',
            content: `Conversation:\n${historyLines}\n\nLatest visitor message:\n${snapshot.latestVisitor}`,
          },
        ]),
      })
    );
    raw = result && result.text ? result.text : '';
  } catch (err) {
    try {
      process.stderr.write(`[chatbot-ai] ChatGPT error session=${sessionId}: ${err && err.message}\n`);
    } catch {
      /* ignore */
    }
    const heur = heuristicSupportReply(snapshot.latestVisitor, bizName, snapshot.messages);
    return domain.withDb(workspaceId, (db) => {
      if (!claimNeedsAgent(db, sessionId)) return { skipped: true, reason: 'race' };
      const appliedErr = { ...applyFallbackAction(db, leadId, sessionId, heur, bizName), via: 'ai_error' };
      // Batch 167: a provider outage is recorded on the session
      // state — it feeds the honest outcome (Rule G) exactly like
      // the YWL had_ai_unavailable flag.
      try {
        updateChatState(db, leadId, sessionId, (st) => {
          st.had_ai_unavailable = true;
        });
      } catch {
        /* state must never break the reply */
      }
      return appliedErr;
    });
  }

  let parsed = parseAiFallbackResponse(raw, { businessName: bizName, allowCapture });
  // Hard guard: never capture on greetings / too-early turns even if the model asks to.
  if (parsed.action === 'capture' && !allowCapture) {
    parsed = heuristicSupportReply(snapshot.latestVisitor, bizName, snapshot.messages);
  }
  if (parsed.action === 'capture' && !/form|appear|overlay|below/i.test(parsed.reply)) {
    parsed = { ...parsed, reply: thanks };
  }

  /* Batch 167 (Rule H / I4) — price fact-check on answered replies.
   * Every $ amount must trace to the grounded set; one regeneration
   * with the constraint; a second violation downgrades the reply to
   * an honest unknown and counts a fact-check block (which also
   * feeds the miss ladder below, exactly as in the YWL brain). */
  let factCheckBlocked = false;
  if (parsed.action === 'answer' && chatMessagesRef) {
    const allowed = allowedChatAmounts(snapshot.priceAmounts, [
      snapshot.knowledge && snapshot.knowledge.text,
      snapshot.sources && snapshot.sources.text,
    ]);
    if (unverifiedChatAmounts(parsed.reply, allowed).length) {
      try {
        const retry = await domain.withDb(workspaceId, async (db) =>
          chat({
            task: 'qa',
            db,
            leadId,
            note: `chatbot-fallback-factcheck session=${sessionId}`,
            maxTokens: 450,
            messages: [
              {
                role: 'system',
                content:
                  chatMessagesRef[0].content +
                  '\nIMPORTANT: only state prices that appear verbatim in the material above (price book, site content, knowledge excerpts). Do not state, estimate or total any other amount.',
              },
              chatMessagesRef[1],
            ],
          })
        );
        const p2 = parseAiFallbackResponse(retry && retry.text ? retry.text : '', {
          businessName: bizName,
          allowCapture,
        });
        if (p2.action === 'answer' && !unverifiedChatAmounts(p2.reply, allowed).length) {
          parsed = p2;
        }
      } catch {
        /* the downgrade below still applies */
      }
      if (unverifiedChatAmounts(parsed.reply, allowed).length) {
        parsed = { ...parsed, reply: CHAT_FACT_CHECK_UNKNOWN_REPLY };
        factCheckBlocked = true;
      }
    }
  }

  // Batch 167: a capture the visitor already cancelled stays cancelled.
  if (parsed.action === 'capture' && chatState0.suppress_capture) {
    parsed = { action: 'chat', reply: CHAT_CAPTURE_SUPPRESSED_REPLY };
  }

  /* Batch 167 turn classification (Rules C/F/G): an answered turn is
   * a grounded 'answer' to a substantive message; a miss is a
   * substantive question/request the model could only 'chat' back
   * to (or a fact-check downgrade). The ladder fires when the
   * consecutive-miss streak reaches the platform setting. */
  const answeredTurn = parsed.action === 'answer' && !factCheckBlocked && !isGreetingOnly(latestText);
  const isMiss = (parsed.action === 'chat' || factCheckBlocked) && isSubstantiveQuestion(latestText);
  const newStreak = isMiss
    ? chatState0.miss_streak + 1
    : parsed.action === 'answer' || parsed.action === 'capture'
      ? 0
      : chatState0.miss_streak;
  const ladderNow = isMiss && newStreak >= chat167.handoffAt && !chatState0.handoff_requested;

  return domain.withDb(workspaceId, (db) => {
    if (!claimNeedsAgent(db, sessionId)) return { skipped: true, reason: 'race' };
    // Rule F: at the threshold the offer becomes an explicit person
    // offer — BitPype's escalation path — instead of another guess
    // or another capture ask.
    if (ladderNow) {
      escalateSession(db, leadId, {
        sessionId,
        message: latestText,
        reason: 'repeated_unanswered',
      });
      updateChatState(db, leadId, sessionId, (st) => {
        st.handoff_requested = true;
        st.miss_streak = 0;
        st.miss_total += 1;
      });
      return { posted: true, via: 'fallback_ladder' };
    }
    const applied = { ...applyFallbackAction(db, leadId, sessionId, parsed, bizName), via: 'chatgpt' };
    // Rule C: the first substantive answered turn starts
    // qualification — marked BEFORE recording so an answer+ask in
    // the same reply is recorded, not gated.
    if (answeredTurn) {
      try {
        markQualificationStarted(db, leadId, sessionId);
      } catch {
        /* never breaks the reply */
      }
    }
    // The harness decline is recorded before the model's own reports
    // so a conflicting report this turn cannot resurrect the
    // question (declined is terminal/sticky).
    if (harnessDeclineIdx >= 0) {
      try {
        recordQualificationUpdates(db, leadId, sessionId, [{ index: harnessDeclineIdx, status: 'declined' }]);
      } catch {
        /* never breaks the reply */
      }
    }
    // Batch 137: persist the model's qualifying-question reports
    // against the session snapshot. Recording never breaks (or
    // gates) the reply that was just posted — capture and booking
    // proceed exactly as before, answered questions or not.
    // Batch 167: the fallback path records through the Rule C gates
    // (start gate, anti-miscapture, re-ask budget, suppression).
    if (Array.isArray(parsed.qualification) && parsed.qualification.length) {
      try {
        const rec = recordQualificationUpdates(db, leadId, sessionId, parsed.qualification, {
          reaskBudget: chat167.reaskBudget,
          enforceStartGate: true,
          startedThisTurn: answeredTurn,
          guardMiscapture: true,
          latestVisitorText: latestText,
          suppressQual: chatState0.suppress_qual,
        });
        applied.qualification = { applied: rec.applied, skipped: rec.skipped, gated: rec.gated };
      } catch (err) {
        try {
          process.stderr.write(
            `[chatbot-ai] qualification record failed session=${sessionId}: ${err && err.message}\n`
          );
        } catch {
          /* ignore */
        }
      }
    }
    // Batch 167: counters + provisional honest outcome (Rules F/G).
    try {
      updateChatState(db, leadId, sessionId, (st) => {
        if (answeredTurn) st.answered_count += 1;
        st.miss_streak = newStreak;
        if (isMiss) st.miss_total += 1;
        if (factCheckBlocked) st.fact_check_blocks += 1;
      });
      const stNow = getChatState(db, sessionId);
      if (stNow) applied.outcome = stNow.outcome;
    } catch {
      /* counters never break the reply */
    }
    return applied;
  });
}

function getSessionHistory(db, token, { sessionToken, afterId } = {}) {
  const cfg = getPublicConfigByToken(db, token);
  const session = getSessionByToken(db, sessionToken);
  if (!session || Number(session.lead_id) !== Number(cfg.embed.lead_id)) {
    throw fail('NOT_FOUND', 'Session not found', 404);
  }
  const messages = listMessages(db, session.id, { afterId });
  return {
    session: publicSession(session),
    messages,
  };
}

function captureLead(db, token, data = {}) {
  const cfg = getPublicConfigByToken(db, token);
  const leadId = cfg.embed.lead_id;
  let sessionId = null;
  if (data.session || data.sessionToken) {
    const session = getSessionByToken(db, data.session || data.sessionToken);
    if (session && Number(session.lead_id) === Number(leadId)) sessionId = session.id;
  }
  const name = String(data.name || '')
    .trim()
    .slice(0, 120);
  const email = String(data.email || '')
    .trim()
    .slice(0, 200);
  const phone = String(data.phone || '')
    .trim()
    .slice(0, 60);
  const message = String(data.message || '')
    .trim()
    .slice(0, 4000);
  if (!name && !email && !phone) {
    throw fail('VALIDATION', 'name, email, or phone required', 400);
  }
  // Site Rentals (Batch 26): stamp the capture with the site + tenant
  // it belongs to and record the per-lead charge when a rental is live.
  let rentalStamp = { websiteId: null, tenantLeadId: null, rentalId: null };
  try {
    rentalStamp = require('./rentals').resolveStamp(db, Number(leadId));
  } catch {
    /* stamping must never break a capture */
  }
  // Batch 137: the session's qualifying record rides the capture —
  // a snapshot on the lead row itself, so the inbox lead entry (and
  // the escalation + owner notification below) shows how this
  // visitor answered the owner's questions.
  const qualification = sessionId ? getSessionQualification(db, sessionId) : null;
  const info = db
    .prepare(
      `
    INSERT INTO chatbot_leads (lead_id, session_id, name, email, phone, message, status, website_id, tenant_lead_id, rental_id, qualification_json)
    VALUES (?, ?, ?, ?, ?, ?, 'new', ?, ?, ?, ?)
  `
    )
    .run(
      Number(leadId),
      sessionId,
      name,
      email,
      phone,
      message,
      rentalStamp.websiteId,
      rentalStamp.tenantLeadId,
      rentalStamp.rentalId,
      qualification ? JSON.stringify(qualification) : null
    );
  const chatbotLeadId = Number(info.lastInsertRowid);
  if (rentalStamp.rentalId) {
    try {
      require('./rentals').recordCaptureCharge(db, {
        ownerLeadId: Number(leadId),
        sourceKind: 'chatbot',
        chatbotLeadId,
        contactLabel: name || email || phone || '',
      });
    } catch {
      /* billing must never break a capture */
    }
  }

  if (sessionId) {
    addMessage(db, sessionId, leadId, 'system', 'Thanks — we received your contact details and will follow up.');
  }

  // Batch 167 (Rule G): a capture is the other chat "end" —
  // recompute the stored provisional outcome now that the lead row
  // exists (it reads back as 'resolved').
  if (sessionId) {
    try {
      const sessRow = getSessionById(db, leadId, sessionId);
      if (sessRow && sessRow.chat_state_json) updateChatState(db, leadId, sessionId, null);
    } catch {
      /* outcome bookkeeping never breaks a capture */
    }
  }

  const settings = getSettings(db, leadId);
  if (settings.escalate_notify_portal) {
    db.prepare(
      `
      INSERT INTO chatbot_escalations (lead_id, session_id, message, reason, status)
      VALUES (?, ?, ?, 'lead_capture', 'open')
    `
    ).run(
      Number(leadId),
      sessionId,
      [
        `Lead capture: ${[name, email, phone].filter(Boolean).join(' · ')}`,
        message,
        qualificationSummaryText(qualification),
      ]
        .filter(Boolean)
        .join('\n')
        .slice(0, 4000)
    );
  }

  notifyClientAgent(db, `Chatbot lead captured for lead ${leadId} (session ${sessionId || 'n/a'}).`, {
    leadId,
    sessionId,
  });

  const business = loadBusinessSupportContext(db, leadId);
  // Site Rentals (Batch 26): resolve the tenant's delivery contacts
  // while the stamp is fresh (alert email chain + the tenant's phone).
  let rentalDelivery = null;
  if (rentalStamp.rentalId && rentalStamp.tenantLeadId) {
    try {
      const rentals = require('./rentals');
      const tenant = rentals.leadRow(db, rentalStamp.tenantLeadId);
      rentalDelivery = {
        email: rentals.tenantAlertEmail(db, rentalStamp.tenantLeadId),
        phone: tenant ? String(tenant.phone || '').trim() : '',
      };
    } catch {
      rentalDelivery = null;
    }
  }
  let chatSummary = '';
  if (sessionId) {
    chatSummary = listMessages(db, sessionId, { limit: 30 })
      .filter((m) => m.role === 'visitor' || m.role === 'agent')
      .slice(-10)
      .map((m) => `${m.role === 'visitor' ? 'Visitor' : 'Chat'}: ${m.body}`)
      .join('\n');
  }

  return {
    lead: db
      .prepare('SELECT id, name, email, phone, message, status, created_at FROM chatbot_leads WHERE id = ?')
      .get(info.lastInsertRowid),
    message: 'Thanks — we will follow up shortly.',
    _notify: {
      leadId: Number(leadId),
      sessionId,
      name,
      email,
      phone,
      visitorMessage: message,
      chatSummary,
      // Batch 137: the qualification record + its plain-text
      // summary ride the same notification payload.
      qualification,
      qualification_summary: qualificationSummaryText(qualification),
      business,
      escalateEmail: settings.escalate_email || '',
      // Site Rentals (Batch 26): while the site is rented, the chat
      // lead is the tenant's site lead — notify the tenant instead.
      deliveryEmail: rentalDelivery ? rentalDelivery.email : '',
      deliveryPhone: rentalDelivery ? rentalDelivery.phone : '',
      tenantLeadId: rentalStamp.tenantLeadId || null,
    },
  };
}

/**
 * Email + SMS the business owner after a visitor submits the chat contact form.
 * Fire-and-forget from the public route; never throws into the visitor response.
 */
async function notifyOwnerOnChatLead(workspaceId, payload = {}) {
  const out = { email: null, sms: null };
  try {
    const biz = payload.business || {};
    const bizName = biz.businessName || 'your business';
    // Site Rentals (Batch 26): a rented site's chat leads notify the
    // tenant (their alert email + phone), not the site owner.
    const toEmail = String(payload.deliveryEmail || payload.escalateEmail || biz.email || '').trim();
    const toPhone = String(payload.deliveryPhone || biz.phone || '').trim();
    const visitorBits = [payload.name, payload.email, payload.phone].filter(Boolean).join(' · ');
    const need =
      String(payload.visitorMessage || '').trim() ||
      String(payload.chatSummary || '')
        .split('\n')
        .filter((l) => /^Visitor:/i.test(l))
        .slice(-3)
        .join(' | ') ||
      '(see chat)';

    if (toEmail) {
      try {
        const mailer = require('./mailer');
        out.email = await mailer.sendPlatformMail({
          to: toEmail,
          subject: `New website chat lead — ${bizName}`,
          title: 'Someone left details in your website chat',
          paragraphs: [
            `A visitor on ${bizName}'s site asked for follow-up.`,
            `Contact: ${visitorBits || '(none)'}`,
            `What they need: ${need.slice(0, 800)}`,
            payload.chatSummary ? `Recent chat:\n${String(payload.chatSummary).slice(0, 1200)}` : '',
            payload.qualification_summary ? String(payload.qualification_summary).slice(0, 1200) : '',
            'Please call or email them when you can — the chat bot told them a human would follow up.',
          ].filter(Boolean),
          text: [
            `New chat lead for ${bizName}`,
            `Contact: ${visitorBits}`,
            `Need: ${need}`,
            payload.chatSummary || '',
            payload.qualification_summary || '',
          ]
            .filter(Boolean)
            .join('\n\n'),
        });
      } catch (e) {
        out.email = { sent: false, error: e.message };
        try {
          process.stderr.write(`[chatbot-notify] email failed: ${e.message}\n`);
        } catch {
          /* ignore */
        }
      }
    }

    if (toPhone) {
      try {
        const sms = require('../src/sms');
        const domain = require('./domain');
        const phone = sms.normalizePhone(toPhone);
        if (phone) {
          // Decrypting reader (Batch 25b): sms.* secrets are encrypted
          // at rest; a raw settings read would hand Twilio ciphertext.
          const settings = domain.withDb(workspaceId, (db) => sms.readWorkspaceSettings(db));
          const resolved = await sms.resolveSmsSettings(settings);
          const provider = sms.getSmsProvider(resolved, null);
          const body = sms.plainSmsBody(
            `${bizName}: new website chat lead — ${visitorBits || 'details in email'}. ` +
              `Need: ${String(need).slice(0, 120)}. Please call them back.`
          );
          out.sms = await provider.send({ to: phone, body });
        }
      } catch (e) {
        out.sms = { ok: false, error: e.message };
        try {
          process.stderr.write(`[chatbot-notify] sms failed: ${e.message}\n`);
        } catch {
          /* ignore */
        }
      }
    }
  } catch (e) {
    try {
      process.stderr.write(`[chatbot-notify] ${e.message}\n`);
    } catch {
      /* ignore */
    }
  }
  return out;
}

/* ── Client MCP / portal agent surface ── */

function listPendingSessions(db, leadId, { limit = 10 } = {}) {
  ensureTables(db);
  const lim = Math.min(50, Math.max(1, Number(limit) || 10));
  const rows = db
    .prepare(
      `
    SELECT * FROM chatbot_sessions
    WHERE lead_id = ? AND needs_agent = 1 AND status = 'open'
    ORDER BY last_visitor_at ASC, id ASC
    LIMIT ?
  `
    )
    .all(Number(leadId), lim);
  // Batch 137: when the owner's qualifying questions are active,
  // each pending session's record is ensured (first context build
  // snapshots the questions) and rides its publicSession.
  const qualifying = qualifyingFor(db, leadId);
  const sessions = rows.map((r) => {
    let row = r;
    if (qualifying) {
      ensureSessionQualification(db, leadId, r.id);
      row = db.prepare('SELECT * FROM chatbot_sessions WHERE id = ?').get(r.id) || r;
    }
    const messages = listMessages(db, row.id, { limit: 40 });
    return publicSession(row, { withMessages: true, messages });
  });
  const latestVisitor = sessions
    .flatMap((s) => (s.messages || []).filter((m) => m.role === 'visitor').map((m) => m.body))
    .slice(-3)
    .join(' ');
  const bookingPitch = bookingPitchFor(db, leadId);
  return {
    total: rows.length,
    sessions,
    knowledge: knowledgeSnippets(db, leadId, { query: latestVisitor }),
    allowed_actions: listAllowedActions(db, leadId),
    // Batch 136: module-state booking pitch — present whenever
    // bookings are live on this site, whatever the visitor said.
    booking_pitch: bookingPitch,
    // Batch 137/140: the effective qualifying questions for this
    // lead (null only when the switch is off).
    qualifying,
    hint:
      'Reply with chatbot.reply (sessionId + message). Use knowledge snippets (query-ranked from uploaded docs). Escalate with chatbot.escalate when unsure. Module actions: use public bookings/forms endpoints listed in allowed_actions — never admin MCP tools.' +
      (bookingPitch ? ` Booking pitch: ${bookingPitch.pitch_text} ${bookingPitch.guidance}` : '') +
      (qualifying
        ? " Qualifying questions are ON for this business: weave the owner's questions (each session's qualification record) into the conversation naturally, one at a time, EXACTLY as written — never invent or rephrase screening questions. If the visitor already answered one in their own words, don't ask it. Pass updates with chatbot.reply's qualification param ([{index, status, answer}] — statuses asked | answered | answered_from_conversation | declined). Never block help, lead capture, or booking on an unanswered question."
        : ''),
    boundary: 'portal_client_mcp_only',
  };
}

function claimNextSession(db, leadId) {
  const pending = listPendingSessions(db, leadId, { limit: 1 });
  const session = pending.sessions[0] || null;
  return {
    session,
    knowledge: pending.knowledge,
    allowed_actions: pending.allowed_actions,
    booking_pitch: pending.booking_pitch || null,
    qualifying: pending.qualifying || null,
    hint: pending.hint,
    boundary: 'portal_client_mcp_only',
  };
}

function agentReply(db, leadId, sessionId, message, meta = null, opts = {}) {
  ensureTables(db);
  const session = getSessionById(db, leadId, sessionId);
  if (!session) throw fail('NOT_FOUND', 'Session not found', 404);
  const ws = opts && opts.workspaceId != null ? Number(opts.workspaceId) : null;
  if (Number.isInteger(ws) && ws > 0) cancelAiFallbackReply(ws, session.id);
  const msg = addMessage(db, session.id, leadId, 'agent', message, meta);
  db.prepare(
    `
    UPDATE chatbot_sessions
    SET needs_agent = 0, last_agent_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ?
  `
  ).run(session.id);
  // Batch 167: a human replying ends the visitor-requested handoff
  // stand-down — the AI fallback may answer later questions again,
  // and the miss streak resets (a person picked the conversation up).
  if (session.chat_state_json) {
    try {
      updateChatState(db, leadId, session.id, (st) => {
        st.handoff_requested = false;
        st.miss_streak = 0;
      });
    } catch {
      /* state must never break a human reply */
    }
  }
  const out = {
    session: publicSession(getSessionById(db, leadId, session.id)),
    message: msg,
    boundary: 'portal_client_mcp_only',
  };
  // Batch 137: the replying agent may report qualifying-question
  // state changes with the reply (opts.qualification — validated
  // and recorded against the session snapshot). Recording is
  // best-effort: it never fails the reply itself.
  if (opts && opts.qualification != null) {
    try {
      const rec = recordQualificationUpdates(
        db,
        leadId,
        session.id,
        Array.isArray(opts.qualification) ? opts.qualification : []
      );
      out.qualification = rec.record;
      out.qualification_applied = rec.applied;
      out.qualification_skipped = rec.skipped;
      out.session = publicSession(getSessionById(db, leadId, session.id));
    } catch {
      out.qualification = null;
    }
  }
  return out;
}

function escalateSession(db, leadId, { sessionId, message, reason } = {}) {
  ensureTables(db);
  const session = sessionId ? getSessionById(db, leadId, sessionId) : null;
  if (sessionId && !session) throw fail('NOT_FOUND', 'Session not found', 404);
  const text =
    String(message || '')
      .trim()
      .slice(0, 4000) || 'Agent requested human follow-up.';
  const why = String(reason || 'unsure').slice(0, 80);
  const info = db
    .prepare(
      `
    INSERT INTO chatbot_escalations (lead_id, session_id, message, reason, status)
    VALUES (?, ?, ?, ?, 'open')
  `
    )
    .run(Number(leadId), session ? session.id : null, text, why);

  if (session) {
    addMessage(
      db,
      session.id,
      leadId,
      'system',
      'I am connecting you with the team — feel free to leave your contact details.'
    );
    addMessage(
      db,
      session.id,
      leadId,
      'agent',
      'I want to make sure you get the right help. A team member will follow up, or you can leave your name and email below.'
    );
    db.prepare(
      `
      UPDATE chatbot_sessions SET needs_agent = 0, updated_at = datetime('now') WHERE id = ?
    `
    ).run(session.id);
  }

  // Batch 167 (Rule G): an escalation is one of the chat session's
  // "ends" — recompute the stored provisional outcome now that the
  // escalation row exists (it reads back as 'escalated').
  if (session && session.chat_state_json) {
    try {
      updateChatState(db, leadId, session.id, null);
    } catch {
      /* outcome bookkeeping never breaks an escalation */
    }
  }

  return {
    escalation: db.prepare('SELECT * FROM chatbot_escalations WHERE id = ?').get(info.lastInsertRowid),
    suggest_lead_capture: getSettings(db, leadId).suggest_lead_capture,
    // Batch 137: the session's qualifying record (if any) rides
    // the escalation — the flow itself is unchanged.
    qualification: session ? getSessionQualification(db, session.id) : null,
    boundary: 'portal_client_mcp_only',
  };
}

function listEscalations(db, leadId, { status = 'open', limit = 50 } = {}) {
  ensureTables(db);
  const lim = Math.min(100, Math.max(1, Number(limit) || 50));
  let sql = 'SELECT * FROM chatbot_escalations WHERE lead_id = ?';
  const params = [Number(leadId)];
  if (status) {
    sql += ' AND status = ?';
    params.push(String(status));
  }
  sql += ' ORDER BY id DESC LIMIT ?';
  params.push(lim);
  return db.prepare(sql).all(...params);
}

function resolveEscalation(db, leadId, id) {
  ensureTables(db);
  const row = db
    .prepare('SELECT * FROM chatbot_escalations WHERE lead_id = ? AND id = ?')
    .get(Number(leadId), Number(id));
  if (!row) throw fail('NOT_FOUND', 'Escalation not found', 404);
  db.prepare(
    `
    UPDATE chatbot_escalations SET status = 'resolved', resolved_at = datetime('now')
    WHERE id = ? AND lead_id = ?
  `
  ).run(row.id, Number(leadId));
  return db.prepare('SELECT * FROM chatbot_escalations WHERE id = ?').get(row.id);
}

function listChatLeads(db, leadId, { limit = 50 } = {}) {
  ensureTables(db);
  const lim = Math.min(200, Math.max(1, Number(limit) || 50));
  return db
    .prepare(
      `
    SELECT id, session_id, name, email, phone, message, status, created_at, qualification_json
    FROM chatbot_leads WHERE lead_id = ? ORDER BY id DESC LIMIT ?
  `
    )
    .all(Number(leadId), lim)
    .map((r) => {
      const { qualification_json, ...rest } = r;
      // Batch 137: the capture-time qualification snapshot, parsed
      // for the portal inbox (the raw JSON column stays internal).
      return { ...rest, qualification: parseQualificationRecord(qualification_json) };
    });
}

/** Batch 138 — voice block for the portal chatbot admin + inbox. */
function voiceSummary(db, leadId) {
  const s = getSettings(db, leadId);
  const recent = db
    .prepare(
      "SELECT * FROM chatbot_sessions WHERE lead_id = ? AND channel = 'voice' ORDER BY id DESC LIMIT 10"
    )
    .all(Number(leadId))
    .map((r) => {
      const p = publicSession(r);
      return { id: p.id, created_at: p.created_at, status: p.status, voice: p.voice };
    });
  return {
    enabled: !!s.voice_enabled,
    voice_name: s.voice_name,
    has_bubble_image: !!s.voice_bubble_image,
    recent_sessions: recent,
  };
}

function portalChatbotSummary(db, leadId) {
  ensureTables(db);
  const modules = require('./siteModules');
  const emb = modules.getEmbedRow(db, Number(leadId), 'chatbot');
  return {
    settings: getSettings(db, leadId),
    // Batch 151: the Knowledge-sources panel data (owner-facing
    // only — this summary never reaches the public widget config).
    knowledge_sources: knowledgeSourcesFor(db, leadId),
    knowledge: listKnowledge(db, leadId, { includeInactive: true }),
    embed: emb ? modules.publicEmbed(emb) : null,
    pending_sessions: db
      .prepare("SELECT COUNT(*) AS c FROM chatbot_sessions WHERE lead_id = ? AND needs_agent = 1 AND status = 'open'")
      .get(Number(leadId)).c,
    open_escalations: db
      .prepare("SELECT COUNT(*) AS c FROM chatbot_escalations WHERE lead_id = ? AND status = 'open'")
      .get(Number(leadId)).c,
    leads: listChatLeads(db, leadId, { limit: 20 }),
    // Batch 137: open escalations carry their session's qualifying
    // record, and recent sessions that have one are listed so the
    // inbox can show how each visitor answered.
    escalations: listEscalations(db, leadId, { status: 'open', limit: 20 }).map((e) => ({
      ...e,
      qualification: e.session_id ? getSessionQualification(db, e.session_id) : null,
    })),
    qualification_sessions: db
      .prepare(
        `
      SELECT * FROM chatbot_sessions
      WHERE lead_id = ? AND qualification_json IS NOT NULL
      ORDER BY id DESC LIMIT 20
    `
      )
      .all(Number(leadId))
      .map((r) => publicSession(r))
      .filter((s) => s && s.qualification),
    voice: voiceSummary(db, leadId),
    // Batch 167 (Rule G): honest outcome counts over recent sessions
    // that carry chat state — computed from resulting state (lead
    // rows, open escalations, counters), never from per-turn labels.
    outcomes: (() => {
      const counts = { resolved: 0, escalated: 0, unresolved: 0, open: 0 };
      try {
        const rows = db
          .prepare(
            `
          SELECT * FROM chatbot_sessions
          WHERE lead_id = ? AND chat_state_json IS NOT NULL
          ORDER BY id DESC LIMIT 200
        `
          )
          .all(Number(leadId));
        for (const r of rows) counts[computeChatOutcome(db, r)] += 1;
      } catch {
        /* counts are advisory */
      }
      return counts;
    })(),
    allowed_actions: listAllowedActions(db, leadId),
    booking_pitch: bookingPitchFor(db, leadId),
    agent_boundary: {
      mode: 'portal_client_mcp_only',
      tools: [
        'chatbot.pending',
        'chatbot.next',
        'chatbot.getSession',
        'chatbot.reply',
        'chatbot.escalate',
        'chatbot.knowledge.list',
        'chatbot.knowledge.add',
        'chatbot.actions',
      ],
      forbidden:
        'Admin MCP (lead.*, design.*, workspace tools) and workspace ws_ tokens must not be used for visitor chat.',
      actions: 'Bookings/forms/products via public module/form APIs listed in allowed_actions.',
    },
  };
}

/* ── Sitewide embed HTML ── */

function chatScriptTag(appUrl) {
  const base = String(appUrl || appBaseUrl()).replace(/\/$/, '');
  if (!base) return '';
  return (
    `<script src="${escapeAttr(base)}/js/chat-embed.js?v=${CHAT_SCRIPT_VER}" ` +
    `defer ${CHAT_SCRIPT_ATTR}="1"></script>`
  );
}

function chatEmbedBlockHtml(embed, appUrl) {
  const base = String(appUrl || appBaseUrl()).replace(/\/$/, '');
  const token = String((embed && embed.public_token) || '');
  if (!/^\d+_[A-Za-z0-9_-]+$/.test(token)) return '';
  return (
    `<div class="bitpype-chat-embed" ${CHAT_ATTR}="1" ${CHAT_TOKEN_ATTR}="${escapeAttr(token)}" ` +
    `data-bitpype-api="${escapeAttr(base)}"></div>`
  );
}

function htmlHasChatToken(html, token) {
  const t = String(token || '').trim();
  if (!t) return false;
  const esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${CHAT_TOKEN_ATTR}\\s*=\\s*["']${esc}["']`, 'i').test(String(html || ''));
}

function stripChatEmbedsFromHtml(html, { keepToken } = {}) {
  let s = String(html || '');
  s = s.replace(/<div\b[^>]*\bdata-bitpype-chat\s*=\s*["']?1["']?[^>]*>[\s\S]*?<\/div>/gi, (block) => {
    if (keepToken && htmlHasChatToken(block, keepToken)) return block;
    return '';
  });
  s = s.replace(/<div\b[^>]*\bdata-bitpype-chat\s*=\s*["']?1["']?[^>]*\/?>/gi, (block) => {
    if (keepToken && htmlHasChatToken(block, keepToken)) return block;
    return '';
  });
  if (!keepToken || !htmlHasChatToken(s, keepToken)) {
    s = s.replace(new RegExp(`<script\\b[^>]*\\b${CHAT_SCRIPT_ATTR}\\b[^>]*>\\s*<\\/script>`, 'gi'), '');
    s = s.replace(/<script\b[^>]*\/js\/chat-embed\.js[^>]*>\s*<\/script>/gi, '');
  }
  return s;
}

/**
 * Batch 149: delegate to the ONE canonical managed-script ensure
 * (src/managedScripts.ensureManagedScript) -- the per-family
 * strip/append copies were not idempotent (see managedScripts.js).
 */
function ensureChatEmbedScript(html, appUrl) {
  const tag = chatScriptTag(appUrl);
  if (!tag) return String(html || '');
  return require('../src/managedScripts').ensureManagedScript(html, 'chat-embed.js', tag);
}

function injectChatOnPageHtml(html, block, appUrl) {
  let s = String(html || '');
  const chunk = String(block || '');
  const token = (chunk.match(new RegExp(`${CHAT_TOKEN_ATTR}\\s*=\\s*["']([^"']+)["']`, 'i')) || [])[1];
  if (token && htmlHasChatToken(s, token)) {
    return ensureChatEmbedScript(s, appUrl);
  }
  if (/<\/body>/i.test(s)) {
    s = s.replace(/<\/body>/i, `${chunk}\n</body>`);
  } else {
    s = `${s}\n${chunk}`;
  }
  return ensureChatEmbedScript(s, appUrl);
}

/**
 * Inject floating chatbot widget on every page (no nav page).
 * Called from siteModules.syncSiteModuleEmbeds when chatbot embed is active.
 */
function syncChatbotSitewide(db, leadId, pages, { appUrl } = {}) {
  ensureTables(db);
  const modules = require('./siteModules');
  const emb = modules.getEmbedRow(db, Number(leadId), 'chatbot');
  const active = !!(emb && emb.published && emb.embed_enabled && emb.public_token);
  const base = appUrl || appBaseUrl();
  const block = active ? chatEmbedBlockHtml(emb, base) : '';
  const token = active ? String(emb.public_token) : '';
  let touched = 0;

  for (const page of pages || []) {
    if (page && Array.isArray(page.sections) && page.sections.length) {
      let found = false;
      for (const sec of page.sections) {
        if (!sec || !sec.content || typeof sec.content.html !== 'string') continue;
        if (token && htmlHasChatToken(sec.content.html, token)) {
          sec.content.html = ensureChatEmbedScript(
            stripChatEmbedsFromHtml(sec.content.html, { keepToken: token }),
            base
          );
          found = true;
        } else {
          sec.content.html = stripChatEmbedsFromHtml(sec.content.html);
        }
      }
      if (active && !found) {
        const footerAt = page.sections.findIndex((s) => s && s.type === 'footer');
        const embedSec = {
          type: 'html',
          content: {
            html: ensureChatEmbedScript(block, base),
            bitpype_chat_managed: 1,
          },
        };
        // Prefer injecting into an existing freestyle body/html section before footer.
        let bodySec = page.sections.find(
          (s) =>
            s &&
            s.type === 'html' &&
            s.content &&
            typeof s.content.html === 'string' &&
            !s.content.bitpype_module_managed
        );
        if (!bodySec) {
          bodySec = page.sections.find((s) => s && s.type === 'html' && s.content);
        }
        if (bodySec && bodySec.content && typeof bodySec.content.html === 'string') {
          bodySec.content.html = injectChatOnPageHtml(bodySec.content.html, block, base);
        } else if (footerAt >= 0) {
          page.sections.splice(footerAt, 0, embedSec);
        } else {
          page.sections.push(embedSec);
        }
        touched += 1;
      } else if (!active) {
        page.sections = page.sections.filter((sec) => !(sec && sec.content && sec.content.bitpype_chat_managed));
      }
      if (typeof page.html === 'string') delete page.html;
    } else if (page && typeof page.html === 'string') {
      if (active) {
        const before = page.html;
        page.html = injectChatOnPageHtml(stripChatEmbedsFromHtml(page.html, { keepToken: token }), block, base);
        if (page.html !== before) touched += 1;
      } else {
        page.html = stripChatEmbedsFromHtml(page.html);
      }
    }
  }
  return { synced: true, sitewide: true, active, pagesTouched: touched };
}

const KNOWLEDGE_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Store one knowledge file under data/workspaces/{ws}/chatbot/{leadId}/ and extract text.
 * @returns {Promise<object>}
 */
async function storeKnowledgeUpload(workspaceId, leadId, { data, mimeType, fileName, title } = {}) {
  const extract = require('./chatbotKnowledgeExtract');
  const buf = Buffer.from(String(data || ''), 'base64');
  if (!buf.length) throw fail('VALIDATION', 'file data required', 400);
  if (buf.length > KNOWLEDGE_MAX_BYTES) {
    throw fail('TOO_LARGE', 'Knowledge file max 5MB', 400);
  }
  const safeName =
    String(fileName || 'doc.txt')
      .replace(/[^a-zA-Z0-9._-]+/g, '_')
      .slice(0, 80) || 'doc.txt';
  const dir = path.join(process.cwd(), 'data', 'workspaces', String(workspaceId), 'chatbot', String(leadId));
  fs.mkdirSync(dir, { recursive: true });
  const stored = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${safeName}`;
  const abs = path.join(dir, stored);
  fs.writeFileSync(abs, buf);

  const extracted = await extract.extractKnowledgeText(buf, {
    fileName: safeName,
    mimeType: mimeType || '',
  });
  let text = String(extracted.text || '');
  if (extracted.warning && !text) {
    text = `[Extraction note: ${extracted.warning}]`;
  } else if (extracted.warning && text) {
    text = `${text}\n\n[Extraction note: ${extracted.warning}]`.slice(0, extract.MAX_TEXT);
  }

  return {
    file_path: path.relative(process.cwd(), abs).replace(/\\/g, '/'),
    file_name: safeName,
    content_text: text,
    title: title || safeName.replace(/\.[^.]+$/, '').replace(/_/g, ' ') || safeName,
    extractor: extracted.extractor || 'none',
    extract_warning: extracted.warning || null,
    bytes: buf.length,
    mime_type: String(mimeType || ''),
  };
}

/**
 * Upload one or many knowledge files. Body may be a single file or { files: [...] }.
 */
async function storeKnowledgeUploads(workspaceId, leadId, body = {}) {
  const list = Array.isArray(body.files) && body.files.length ? body.files : body.data ? [body] : [];
  if (!list.length) throw fail('VALIDATION', 'file data or files[] required', 400);
  if (list.length > 20) throw fail('VALIDATION', 'Max 20 files per upload', 400);
  const results = [];
  for (const file of list) {
    const stored = await storeKnowledgeUpload(workspaceId, leadId, {
      data: file.data,
      mimeType: file.mimeType || file.mime_type,
      fileName: file.fileName || file.file_name || file.name,
      title: file.title || body.title,
    });
    results.push(stored);
  }
  return results;
}

module.exports = {
  CHAT_SCRIPT_VER,
  REALTIME_VOICES,
  buildAssistantContext,
  CHAT_ATTR,
  CHAT_TOKEN_ATTR,
  CHAT_SCRIPT_ATTR,
  DEFAULT_SETTINGS,
  ensureTables,
  getSettings,
  saveSettings,
  listKnowledge,
  getKnowledge,
  addKnowledge,
  updateKnowledge,
  deleteKnowledge,
  knowledgeSnippets,
  priceBookFor,
  knowledgeSourcesFor,
  knowledgeSourcesFromSettings,
  knowledgeIncludeIds,
  buildKnowledgeDigests,
  ANSWERABLE_MODULE_TYPES,
  getPublicConfigByToken,
  listAllowedActions,
  bookingPitchFor,
  postVisitorMessage,
  getSessionHistory,
  captureLead,
  notifyOwnerOnChatLead,
  listPendingSessions,
  claimNextSession,
  agentReply,
  cancelAiFallbackReply,
  claimNeedsAgent,
  escalateSession,
  listEscalations,
  resolveEscalation,
  listChatLeads,
  portalChatbotSummary,
  chatScriptTag,
  chatEmbedBlockHtml,
  htmlHasChatToken,
  stripChatEmbedsFromHtml,
  ensureChatEmbedScript,
  syncChatbotSitewide,
  storeKnowledgeUpload,
  storeKnowledgeUploads,
  KNOWLEDGE_MAX_BYTES,
  notifyClientAgent,
  listMessages,
  addMessage,
  getSessionById,
  getSessionByToken,
  startOrGetSession,
  publicSession,
  scheduleAiFallbackReply,
  runAiFallbackReply,
  parseAiFallbackResponse,
  QUALIFYING_MAX_QUESTIONS,
  QUALIFYING_MAX_CHARS,
  normalizeQualifyingQuestions,
  sanitizeQualifyingQuestions,
  qualifyingFromSettings,
  qualifyingFor,
  getIndustryDefaultQuestions,
  resolveQualifyingQuestions,
  classifyIndustry,
  INDUSTRY_QUESTION_TEMPLATES,
  parseQualificationRecord,
  getSessionQualification,
  ensureSessionQualification,
  recordQualificationUpdates,
  qualificationSummaryLines,
  qualificationSummaryText,
  qualifyingPromptLines,
  normalizeQualifyingStatus,
  // Batch 167: chat-redesign state + harness + grounding surface.
  parseChatState,
  getChatState,
  computeChatOutcome,
  markQualificationStarted,
  chatNormText,
  looksLikeQuestion,
  looksLikeRequest,
  isChatDecline,
  isChatHedge,
  answerInQuestion,
  isSubstantiveQuestion,
  chatStatedAmounts,
  allowedChatAmounts,
  unverifiedChatAmounts,
  CHAT_QUAL_REASK_BUDGET_DEFAULT,
  CHAT_FALLBACK_HANDOFF_AT_DEFAULT,
  isGreetingOnly,
  visitorStatedNeed,
  loadBusinessSupportContext,
  leadCaptureThanksFor,
  LEAD_CAPTURE_THANKS,
  LEAD_CAPTURE_SYSTEM,
};
