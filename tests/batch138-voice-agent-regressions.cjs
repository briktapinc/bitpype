'use strict';
/**
 * Batch 138 — AI VOICE AGENT for client sites (Ely, 2026-11-04).
 *
 * Voice rides the existing chatbot module: portal settings (on/off,
 * voice choice, bubble image upload), a server-side Realtime
 * client-secret mint (the platform OpenAI key never reaches the
 * browser), Realtime function calls relayed to the SAME server
 * actions the text chat uses, the full transcript of both sides saved
 * on a channel='voice' row in the same session store (Ely's standing
 * requirement — every voice interaction is saved), and one ai_usage
 * metering row per connected session. No audio is recorded in v1.
 *
 * What this pins:
 *   Part 1 — source pins (pure fs; runs anywhere): the new module +
 *     its documented constants, the settings fields + CHAT_SCRIPT_VER
 *     bump, the public + portal routes, the embed client's WebRTC /
 *     transcript / tool wiring, MODULE_TYPES untouched (27 — voice is
 *     not a module type), and the context-builder seam in chatbot.js.
 *   Part 2 — settings + bubble image (in-process): voice settings
 *     round-trip, invalid voice refused never clamped, settings_json
 *     extras preserved across saves (Batch 136/137 composition), the
 *     image validation matrix (magic-byte PNG/JPG/WebP/GIF pass; SVG,
 *     garbage and >10 MB refused), store/read/remove round-trip.
 *   Part 3 — mint + relay + transcript + metering (in-process,
 *     stubbed fetch): the refusal matrix (voice off / unpublished /
 *     free plan / no key), the mint happy path (upstream request
 *     shape; the platform key appears NOWHERE in the result; session
 *     row channel='voice' with only the relay hash stored), relay
 *     auth (wrong secret / foreign lead / unknown session), the real
 *     capture + escalation paths executing, unknown tools refused,
 *     qualification answers recorded, transcript dedupe + order, the
 *     end-of-session flush closing the record, metering math + row
 *     shape, and the never-connected session writing no usage row.
 *   Part 4 — HTTP over the real server (stubbed OpenAI base URL):
 *     the public config advertises voice iff enabled+entitled+keyed,
 *     mint over HTTP (the stub sees the platform key; the visitor
 *     response never does), transcript save + read-back through the
 *     normal session history surface, portal settings toggle, and
 *     the bubble-image upload → public serve → remove flow.
 *
 * Run Part 1 only (no node_modules needed): B138_ONLY=1 node tests/…
 * Full suite runs in the gate image like its siblings.
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.REGRESSION_TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'batch138-'));
// Batch 168 finisher fixture (2026-11-09): S1#3 made the server
// refuse to boot in production without SETTINGS_ENCRYPTION_KEY;
// this suite spawns the real server and relied on ambient env —
// same synthetic fixture as oauth-token/isolated-startup.
process.env.SETTINGS_ENCRYPTION_KEY =
  process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 23).toString('base64');
process.env.PLATFORM_DB_PATH = path.join(process.env.REGRESSION_TMPDIR, 'platform.db');
process.env.WORKSPACE_DATA_DIR = path.join(process.env.REGRESSION_TMPDIR, 'workspaces');
process.env.DB_PATH = path.join(process.env.REGRESSION_TMPDIR, 'app.db');
process.env.SQLITE_PATH = process.env.DB_PATH;
['.env', 'app.db', 'data.db', 'leads.db', 'platform.db'].forEach((name) => {
  process.env[name.toUpperCase().replace(/\W/g, '_') + '_PATH'] = path.join(process.env.REGRESSION_TMPDIR, name);
});
process.env.DB_DRIVER = process.env.DB_DRIVER || 'sqlite';
process.env.APP_SECRET = ['b138', 'app', 'secret'].join('-');
process.env.SESSION_SECRET = ['batch138', 'regression', 'session', 'secret'].join('-');
// Standard sibling-suite header: the gate image boots NODE_ENV=
// production, and the spawned fixture server refuses to boot without
// this pair.
process.env.CAPTCHA_OPTIONAL = '1';
// Batch 168 (S5#6/S7#1): the voice mint now runs the platform's
// standard assertAiBaseUrl guard before sending the key, like every
// other key transport — the fixture's stub AI server is a loopback
// endpoint, which the guard admits only under the operator opt-in
// for local model servers.
process.env.ALLOW_LOCAL_AI = '1';
process.env.APP_URL = 'https://bitpype.test';
process.env.COOKIE_SECURE = 'false';
process.env.MAIL_DRY_RUN = process.env.MAIL_DRY_RUN || 'true';
process.env.MAIL_PROVIDER = process.env.MAIL_PROVIDER || 'dry';
process.env.EXPORT_ROOT = path.join(process.env.REGRESSION_TMPDIR, 'exports');

const root = path.resolve(__dirname, '..');
const PORT = 39138;
const STUB_PORT = 39139;
const BASE = `http://127.0.0.1:${PORT}`;
const LEAD_A = 13801;
const LEAD_A2 = 13803;
const LEAD_B = 13802;
const PW = ['B138', 'Portal', 'Pass', '9'].join('-') + '!';
// Fixture key material — fragment-assembled at runtime, never a
// credential literal in the file (write-path redaction hazard).
const OPENAI_KEY = ['sk', 'fixture138', 'platformkey'].join('-');
const EK_VALUE = ['ek', 'fixture138', 'ephemeral'].join('_');

const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const groups = [];
function group(name, n) {
  groups.push(`${name} (${n})`);
  console.log(`  ok ${name} — ${n} checks`);
}
async function json(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`non-JSON response ${res.status}: ${text.slice(0, 200)}`);
  }
}
function makeJar() {
  const cookies = new Map();
  return {
    async fetch(url, opts = {}) {
      const headers = { ...(opts.headers || {}) };
      if (!headers['Content-Type'] && opts.body) headers['Content-Type'] = 'application/json';
      if (cookies.size) headers.Cookie = [...cookies.values()].join('; ');
      const res = await fetch(url, { ...opts, headers, redirect: 'manual' });
      const raw = res.headers.get('set-cookie');
      if (raw) {
        for (const part of raw.split(/,(?=\s*[^;,=]+?=)/)) {
          const pair = part.trim().split(';')[0];
          const eq = pair.indexOf('=');
          if (eq > 0) cookies.set(pair.slice(0, eq), pair);
        }
      }
      return res;
    },
  };
}

(async () => {
  /* ================================================================== */
  /* Part 1 — source pins                                                */
  /* ================================================================== */
  {
    let n = 0;
    const voice = read('server/chatbotVoice.js');
    assert.ok(voice.includes("CLIENT_SECRETS_PATH = '/realtime/client_secrets'"), 'mint uses the GA client_secrets endpoint');
    n++;
    assert.ok(voice.includes("REALTIME_MODEL = 'gpt-realtime-2.1'"), 'current Realtime model pinned');
    n++;
    assert.ok(voice.includes('VOICE_MAX_SESSION_SEC = 600'), 'platform session cap constant (10 min, under the 60-min API limit)');
    n++;
    assert.ok(voice.includes("task, provider, model") && voice.includes("'chatbot.voice'"), 'metering writes ai_usage as chatbot.voice');
    n++;
    assert.ok(voice.includes('AUDIO_INPUT_USD_PER_1M = 32') && voice.includes('AUDIO_OUTPUT_USD_PER_1M = 64'), 'documented audio rates held as named constants');
    n++;
    assert.ok(voice.includes('buildAssistantContext'), 'voice instructions consume the shared context builder');
    n++;
    assert.ok(voice.includes('BATCH 136 SEAM') && voice.includes('getBookingPitch'), 'booking-pitch composition seam present');
    n++;
    assert.ok(voice.includes('BATCH 137 SEAM') && voice.includes('recordQualificationAnswer'), 'qualifying-questions composition seam present');
    n++;
    assert.ok(voice.includes('sniffImageMime') && voice.includes('MAX_IMAGE_BYTES'), 'bubble image validation reuses the attachments precedent');
    n++;
    assert.ok(!voice.includes('recordAudio') && !voice.includes('MediaRecorder'), 'no audio recording anywhere in the voice module');
    n++;

    const chat = read('server/chatbot.js');
    assert.ok(chat.includes("CHAT_SCRIPT_VER = 'chat8'"), 'chat embed cache-bust bumped for the voice client');
    n++;
    assert.ok(chat.includes('function buildAssistantContext'), 'shared context builder exists in chatbot.js');
    n++;
    assert.ok(chat.includes('voice_enabled: false'), 'voice defaults OFF in chatbot settings');
    n++;
    assert.ok(chat.includes("voice_name: 'marin'"), 'default voice is marin');
    n++;
    assert.ok(chat.includes("['channel', \"TEXT NOT NULL DEFAULT 'text'\"]"), 'sessions gain the channel column');
    n++;
    assert.ok(chat.includes('...prevExtras'), 'settings saves preserve sibling extras (136/137)');
    n++;

    const pub = read('server/routes/chatbotPublic.js');
    for (const route of ['/:token/voice/session', '/:token/voice/session/:id/tool', '/:token/voice/session/:id/transcript', '/:token/voice-image']) {
      assert.ok(pub.includes(route), `public route present: ${route}`);
      n++;
    }
    const portalRoutes = read('server/routes/portal.js');
    assert.ok(portalRoutes.includes("'/modules/chatbot/voice-image'"), 'portal voice-image routes present');
    n++;

    const embed = read('public/js/chat-embed.js');
    for (const needle of [
      'oai-events',
      'getUserMedia',
      'realtime/calls',
      'conversation.item.input_audio_transcription.completed',
      'response.output_audio_transcript.done',
      'response.function_call_arguments.done',
      'bp-chat-voice-bubble',
    ]) {
      assert.ok(embed.includes(needle), `chat embed voice wiring: ${needle}`);
      n++;
    }
    assert.ok(!embed.includes('MediaRecorder'), 'the embed never records audio');
    n++;

    const sm = read('server/siteModules.js');
    const typesBlock = sm.slice(sm.indexOf('const MODULE_TYPES = ['), sm.indexOf('];', sm.indexOf('const MODULE_TYPES = [')));
    assert.ok(!/'voice'/.test(typesBlock) && !typesBlock.includes('voiceagent'), 'MODULE_TYPES unchanged — voice adds no module type');
    n++;
    group('Part 1 source pins', n);
  }

  if (process.env.B138_ONLY === '1') {
    console.log(`\nBATCH138 PART 1 ONLY — ${groups.join(' · ')}`);
    return;
  }

  /* ================================================================== */
  /* Fixtures (in-process; Parts 2–3 share them, Part 4 reuses the DBs)  */
  /* ================================================================== */
  const platformDb = require(path.join(root, 'server/db.js'));
  await platformDb.migrate();
  const platform = require(path.join(root, 'server/platform.js'));
  const workspace = require(path.join(root, 'server/workspace.js'));
  const { openWorkspaceDb } = require(path.join(root, 'server/workspaceDb.js'));
  const sm = require(path.join(root, 'server/siteModules.js'));
  const chatbot = require(path.join(root, 'server/chatbot.js'));
  const voice = require(path.join(root, 'server/chatbotVoice.js'));

  const wsA = await workspace.createUserWithWorkspace({
    email: 'a138@example.invalid',
    password: PW,
    name: 'A138',
    workspaceName: 'Batch138 WS A',
  });
  const WS_A = Number(wsA.workspaceId);
  // Paid plan for workspace A (super-admin owner → premium entitlements).
  await platformDb.query('UPDATE users SET is_super_admin = 1 WHERE email = :e', { e: 'a138@example.invalid' });
  const wsB = await workspace.createUserWithWorkspace({
    email: 'b138@example.invalid',
    password: PW,
    name: 'B138',
    workspaceName: 'Batch138 WS B',
  });
  const WS_B = Number(wsB.workspaceId);

  const dbA = openWorkspaceDb(WS_A);
  const dbB = openWorkspaceDb(WS_B);
  for (const [db, leadId, name, email] of [
    [dbA, LEAD_A, 'B138 Voice Fixture', 'alpha138@example.invalid'],
    [dbA, LEAD_A2, 'B138 Second Site', 'second138@example.invalid'],
    [dbB, LEAD_B, 'B138 Free Fixture', 'beta138@example.invalid'],
  ]) {
    sm.ensureTables(db);
    db.prepare('INSERT INTO leads (id, business_name, email, status) VALUES (?, ?, ?, ?)').run(
      leadId,
      name,
      email,
      'customer'
    );
    db.prepare('INSERT INTO websites (lead_id, name, theme, pages, status) VALUES (?, ?, ?, ?, ?)').run(
      leadId,
      `${name} Site`,
      '{}',
      JSON.stringify([{ slug: 'home', title: 'Home', html: '<p>hi</p>' }]),
      'draft'
    );
  }
  const embA = sm.ensureEmbed(dbA, LEAD_A, 'chatbot', { workspaceId: WS_A });
  dbA.prepare('UPDATE site_module_embeds SET published = 1 WHERE id = ?').run(embA.id);
  const TOKEN_A = embA.public_token;
  const embA2 = sm.ensureEmbed(dbA, LEAD_A2, 'chatbot', { workspaceId: WS_A });
  dbA.prepare('UPDATE site_module_embeds SET published = 1 WHERE id = ?').run(embA2.id);
  const embB = sm.ensureEmbed(dbB, LEAD_B, 'chatbot', { workspaceId: WS_B });
  dbB.prepare('UPDATE site_module_embeds SET published = 1 WHERE id = ?').run(embB.id);
  const TOKEN_B = embB.public_token;
  chatbot.addKnowledge(dbA, LEAD_A, {
    kind: 'doc',
    title: 'Hours and services',
    content_text: 'We are open 9 to 5 on weekdays and we tune pianos on Tuesdays.',
  });

  /* ================================================================== */
  /* Part 2 — settings CRUD + extras preservation + bubble image         */
  /* ================================================================== */
  {
    let n = 0;
    const s0 = chatbot.getSettings(dbA, LEAD_A);
    assert.equal(s0.voice_enabled, false, 'voice defaults OFF');
    n++;
    assert.equal(s0.voice_name, 'marin', 'default voice marin');
    n++;
    const s1 = chatbot.saveSettings(dbA, LEAD_A, { voice_enabled: true, voice_name: 'cedar' });
    assert.equal(s1.voice_enabled, true, 'voice_enabled round-trips');
    n++;
    assert.equal(s1.voice_name, 'cedar', 'voice_name round-trips');
    n++;
    assert.throws(
      () => chatbot.saveSettings(dbA, LEAD_A, { voice_name: 'not-a-voice' }),
      (e) => e.code === 'VALIDATION',
      'an unknown voice is refused, never clamped'
    );
    n++;
    // Batch 137 composition: a sibling feature's extras must survive
    // both a plain settings save and the bubble-image setting write.
    {
      const row = dbA.prepare('SELECT settings_json FROM chatbot_settings WHERE lead_id = ?').get(LEAD_A);
      const extras = JSON.parse(row.settings_json || '{}');
      extras.qualifying_enabled = true;
      extras.qualifying_questions = ['What size is your piano?'];
      dbA
        .prepare("UPDATE chatbot_settings SET settings_json = ? WHERE lead_id = ?")
        .run(JSON.stringify(extras), LEAD_A);
      chatbot.saveSettings(dbA, LEAD_A, { greeting: 'Hello there' });
      const after = chatbot.getSettings(dbA, LEAD_A);
      assert.deepEqual(after.qualifying_questions, ['What size is your piano?'], 'qualifying extras survive a settings save');
      n++;
      assert.equal(after.voice_enabled, true, 'voice extras survive alongside');
      n++;
    }

    // Image validation matrix — magic bytes only (the attachments
    // precedent never decodes), SVG/garbage/oversize refused.
    const pngBuf = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
    const jpgBuf = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]);
    const gifBuf = Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.alloc(64, 7)]);
    const webpBuf = Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.alloc(4, 0), Buffer.from('WEBP', 'ascii'), Buffer.alloc(32, 7)]);
    for (const [buf, mime] of [
      [pngBuf, 'image/png'],
      [jpgBuf, 'image/jpeg'],
      [gifBuf, 'image/gif'],
      [webpBuf, 'image/webp'],
    ]) {
      const out = voice.saveVoiceBubbleImage(WS_A, dbA, LEAD_A, { data: buf.toString('base64'), fileName: 'bubble' });
      assert.equal(out.mime, mime, `magic-byte ${mime} accepted`);
      n++;
      const back = voice.readVoiceBubbleImage(dbA, LEAD_A);
      assert.ok(back && back.mime === mime && back.buffer.equals(buf), 'stored image reads back byte-identical');
      n++;
    }
    assert.throws(
      () => voice.saveVoiceBubbleImage(WS_A, dbA, LEAD_A, { data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>').toString('base64') }),
      (e) => e.code === 'INVALID_IMAGE',
      'SVG is refused'
    );
    n++;
    assert.throws(
      () => voice.saveVoiceBubbleImage(WS_A, dbA, LEAD_A, { data: Buffer.from('plain text, not an image at all').toString('base64') }),
      (e) => e.code === 'INVALID_IMAGE',
      'garbage is refused'
    );
    n++;
    const bigBuf = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(10 * 1024 * 1024, 7)]);
    assert.throws(
      () => voice.saveVoiceBubbleImage(WS_A, dbA, LEAD_A, { data: bigBuf.toString('base64') }),
      (e) => e.code === 'TOO_LARGE',
      'over the 10 MB cap is refused'
    );
    n++;
    const relBefore = chatbot.getSettings(dbA, LEAD_A).voice_bubble_image;
    assert.ok(relBefore && relBefore.startsWith('chatbot-voice'), 'bubble image path stored in settings');
    n++;
    const removed = voice.removeVoiceBubbleImage(dbA, LEAD_A);
    assert.equal(removed.removed, true, 'remove reports');
    n++;
    assert.equal(chatbot.getSettings(dbA, LEAD_A).voice_bubble_image, '', 'remove clears the setting');
    n++;
    assert.equal(voice.readVoiceBubbleImage(dbA, LEAD_A), null, 'remove clears the read');
    n++;
    assert.deepEqual(
      chatbot.getSettings(dbA, LEAD_A).qualifying_questions,
      ['What size is your piano?'],
      'sibling extras still intact after image writes'
    );
    n++;
    group('Part 2 settings + bubble image', n);
  }

  /* ================================================================== */
  /* Part 3 — mint + relay + transcript + metering (stubbed fetch)       */
  /* ================================================================== */
  {
    let n = 0;
    const realFetch = global.fetch;
    const upstream = [];
    global.fetch = async (url, opts = {}) => {
      upstream.push({ url: String(url), opts });
      return {
        ok: true,
        status: 200,
        json: async () => ({ value: EK_VALUE, expires_at: 1999999999, session: { id: 'sess_fixture_138' } }),
      };
    };
    try {
      // Refusal: voice off.
      chatbot.saveSettings(dbA, LEAD_A, { voice_enabled: false });
      await assert.rejects(
        () => voice.mintVoiceSession(WS_A, dbA, TOKEN_A, {}),
        (e) => e.code === 'VOICE_DISABLED',
        'voice off refuses the mint'
      );
      n++;
      chatbot.saveSettings(dbA, LEAD_A, { voice_enabled: true });

      // Refusal: no OpenAI key anywhere.
      await platform.setPlatformSetting('ai.api_key', '');
      await assert.rejects(
        () => voice.mintVoiceSession(WS_A, dbA, TOKEN_A, {}),
        (e) => e.code === 'AI_NOT_CONFIGURED',
        'no key refuses the mint'
      );
      n++;
      assert.deepEqual(await voice.publicVoiceAdvertisement(WS_A, dbA, TOKEN_A), { enabled: false }, 'no advertisement without a key');
      n++;
      await platform.setPlatformSetting('ai.api_key', OPENAI_KEY);

      // Advertisement: enabled + entitled + keyed → on.
      const adv = await voice.publicVoiceAdvertisement(WS_A, dbA, TOKEN_A);
      assert.equal(adv.enabled, true, 'advertised when enabled+entitled+keyed');
      n++;
      assert.equal(adv.voice, 'cedar', 'advertisement carries the chosen voice');
      n++;
      assert.equal(adv.max_duration_sec, 600, 'advertisement carries the session cap');
      n++;

      // Refusal: embed unpublished.
      dbA.prepare('UPDATE site_module_embeds SET published = 0 WHERE id = ?').run(embA.id);
      await assert.rejects(
        () => voice.mintVoiceSession(WS_A, dbA, TOKEN_A, {}),
        (e) => e.code === 'NOT_FOUND',
        'unpublished embed refuses the mint'
      );
      n++;
      dbA.prepare('UPDATE site_module_embeds SET published = 1 WHERE id = ?').run(embA.id);

      // Refusal: free plan (voice on, key set — plan is the only gap).
      chatbot.saveSettings(dbB, LEAD_B, { voice_enabled: true });
      await assert.rejects(
        () => voice.mintVoiceSession(WS_B, dbB, TOKEN_B, {}),
        (e) => e.code === 'PLAN_REQUIRED',
        'free plan refuses the mint (voice rides the chatbot entitlement)'
      );
      n++;

      // Happy path.
      const minted = await voice.mintVoiceSession(WS_A, dbA, TOKEN_A, {});
      assert.equal(upstream.length, 1, 'exactly one upstream mint call');
      n++;
      const call = upstream[0];
      assert.ok(call.url.endsWith('/realtime/client_secrets'), 'mint hits the client_secrets endpoint');
      n++;
      assert.equal(call.opts.headers.Authorization, `Bearer ${OPENAI_KEY}`, 'mint authenticates with the platform key, server-side');
      n++;
      const sentBody = JSON.parse(call.opts.body);
      assert.equal(sentBody.session.type, 'realtime', 'session type realtime');
      n++;
      assert.equal(sentBody.session.model, 'gpt-realtime-2.1', 'session model');
      n++;
      assert.equal(sentBody.session.audio.output.voice, 'cedar', 'session voice from settings');
      n++;
      assert.equal(sentBody.session.audio.input.transcription.model, 'gpt-4o-transcribe', 'input transcription on (visitor transcript)');
      n++;
      // Finisher fix (live proof, 2026-11-05): the GA client_secrets
      // endpoint rejects a pcm format without a sample rate — HTTP 400
      // missing_required_parameter session.audio.input.format.rate.
      assert.equal(sentBody.session.audio.input.format.rate, 24000, 'input pcm format carries the required sample rate');
      n++;
      assert.equal(sentBody.session.audio.output.format.rate, 24000, 'output pcm format carries the sample rate');
      n++;
      assert.deepEqual(
        sentBody.session.tools.map((t) => t.name).sort(),
        ['capture_lead', 'escalate_to_team', 'record_qualification_answer'],
        'session tools mirror the text chat actions'
      );
      n++;
      assert.ok(sentBody.session.instructions.includes('B138 Voice Fixture'), 'instructions carry the business context');
      n++;
      assert.ok(sentBody.session.instructions.includes('tune pianos on Tuesdays'), 'instructions carry the owner knowledge');
      n++;
      assert.ok(sentBody.session.instructions.includes('What size is your piano?'), 'Batch 137 seam: owner qualifying questions compose into voice instructions verbatim');
      n++;
      assert.equal(minted.ephemeral.value, EK_VALUE, 'browser receives only the ephemeral credential');
      n++;
      assert.ok(!JSON.stringify(minted).includes(OPENAI_KEY), 'the platform key appears NOWHERE in the mint result');
      n++;
      assert.ok(minted.relay_secret && minted.relay_secret.length >= 16, 'a per-session relay secret is issued');
      n++;
      const sRow = dbA.prepare('SELECT * FROM chatbot_sessions WHERE id = ?').get(minted.session.id);
      assert.equal(sRow.channel, 'voice', "session stored with channel='voice'");
      n++;
      assert.equal(sRow.voice_state, 'active', 'session active after mint');
      n++;
      assert.equal(sRow.voice_openai_session_id, 'sess_fixture_138', 'upstream session id recorded');
      n++;
      const crypto = require('node:crypto');
      const expectHash = crypto.createHash('sha256').update(minted.relay_secret).digest('hex');
      assert.equal(sRow.voice_relay_hash, expectHash, 'only the relay-secret HASH is stored');
      n++;
      assert.ok(!JSON.stringify(sRow).includes(minted.relay_secret), 'the relay secret itself is never stored');
      n++;

      const sid = minted.session.id;
      const secret = minted.relay_secret;

      // Relay auth matrix.
      assert.throws(
        () => voice.relayVoiceToolCall(dbA, TOKEN_A, sid, 'wrong-secret', { name: 'capture_lead', args: {} }),
        (e) => e.code === 'FORBIDDEN',
        'wrong relay secret refused'
      );
      n++;
      assert.throws(
        () => voice.relayVoiceToolCall(dbA, TOKEN_A, 999999, secret, { name: 'capture_lead', args: {} }),
        (e) => e.code === 'NOT_FOUND',
        'unknown session refused'
      );
      n++;
      assert.throws(
        () => voice.relayVoiceToolCall(dbA, embA2.public_token, sid, secret, { name: 'capture_lead', args: {} }),
        (e) => e.code === 'NOT_FOUND',
        "another lead's token cannot relay into this session"
      );
      n++;

      // Real actions execute through the same server functions.
      const cap = voice.relayVoiceToolCall(dbA, TOKEN_A, sid, secret, {
        name: 'capture_lead',
        args: { name: 'Vi Visitor', email: 'vi138@example.invalid', phone: '', message: 'Needs a tuning' },
      });
      assert.equal(cap.result.ok, true, 'capture_lead reports ok to the model');
      n++;
      assert.ok(cap.notify && Number(cap.notify.leadId) === LEAD_A, 'capture carries the owner-notify payload like the text route');
      n++;
      const leadRow = dbA.prepare('SELECT * FROM chatbot_leads WHERE lead_id = ? ORDER BY id DESC').get(LEAD_A);
      assert.ok(leadRow && leadRow.email === 'vi138@example.invalid' && Number(leadRow.session_id) === sid, 'capture wrote the real chatbot_leads row on the voice session');
      n++;
      const esc = voice.relayVoiceToolCall(dbA, TOKEN_A, sid, secret, {
        name: 'escalate_to_team',
        args: { message: 'Wants a human', reason: 'voice_request' },
      });
      assert.equal(esc.result.ok, true, 'escalate_to_team reports ok');
      n++;
      assert.ok(
        dbA.prepare("SELECT COUNT(*) AS c FROM chatbot_escalations WHERE lead_id = ? AND session_id = ?").get(LEAD_A, sid).c >= 1,
        'escalation wrote the real escalations row'
      );
      n++;
      const qual = voice.relayVoiceToolCall(dbA, TOKEN_A, sid, secret, {
        name: 'record_qualification_answer',
        args: { question: 'What size is your piano?', answer: 'A grand piano' },
      });
      assert.equal(qual.result.ok, true, 'qualification answer recorded');
      n++;
      const qualMsg = dbA
        .prepare('SELECT * FROM chatbot_messages WHERE session_id = ? ORDER BY id DESC')
        .get(sid);
      assert.ok(qualMsg && String(qualMsg.body).includes('A grand piano'), 'qualification answer is on the saved conversation');
      n++;
      const unknown = voice.relayVoiceToolCall(dbA, TOKEN_A, sid, secret, { name: 'delete_everything', args: {} });
      assert.deepEqual(unknown.result, { ok: false, error: 'unknown_tool' }, 'unknown tools refused, never executed');
      n++;

      // Transcript: order, dedupe, save.
      const batch = [
        { role: 'visitor', body: 'Hello, do you tune pianos?', item_id: 'it_1', at_ms: 1200 },
        { role: 'agent', body: 'We do — every Tuesday.', item_id: 'it_2', at_ms: 2400 },
      ];
      const app1 = voice.appendVoiceTranscript(dbA, TOKEN_A, sid, secret, { items: batch });
      assert.equal(app1.appended, 2, 'transcript batch appends both sides');
      n++;
      const app2 = voice.appendVoiceTranscript(dbA, TOKEN_A, sid, secret, { items: batch });
      assert.equal(app2.appended, 0, 'a re-sent batch dedupes by Realtime item id');
      n++;
      const msgs = chatbot.listMessages(dbA, sid, { limit: 50 }).filter((m) => m.meta && m.meta.voice_item_id);
      assert.deepEqual(
        msgs.map((m) => [m.role, m.body]),
        [
          ['visitor', 'Hello, do you tune pianos?'],
          ['agent', 'We do — every Tuesday.'],
        ],
        'the saved conversation holds both sides in order'
      );
      n++;
      const pub = chatbot.publicSession(sRow);
      assert.equal(pub.channel, 'voice', 'public session exposes the voice channel');
      n++;
      assert.equal(pub.voice.close_state, 'open', 'an unclosed fresh session reads as open');
      n++;

      // End of session: backdate 180s, flush a last item with final.
      dbA
        .prepare("UPDATE chatbot_sessions SET voice_started_at = datetime('now', '-180 seconds') WHERE id = ?")
        .run(sid);
      const fin = voice.appendVoiceTranscript(dbA, TOKEN_A, sid, secret, {
        items: [{ role: 'visitor', body: 'Great, see you Tuesday.', item_id: 'it_3', at_ms: 179000 }],
        final: true,
        close: 'hangup',
        connected: true,
      });
      assert.equal(fin.appended, 1, 'the final flush lands before the close');
      n++;
      assert.equal(fin.ended, true, 'final closes the session');
      n++;
      const endRow = dbA.prepare('SELECT * FROM chatbot_sessions WHERE id = ?').get(sid);
      assert.ok(endRow.voice_ended_at, 'end timestamp stamped');
      n++;
      assert.ok(Math.abs(Number(endRow.voice_duration_sec) - 180) <= 2, 'duration recorded from the session clock');
      n++;
      assert.equal(endRow.voice_close_state, 'clean', 'a hangup close reads clean');
      n++;
      const usage = dbA
        .prepare("SELECT * FROM ai_usage WHERE task = 'chatbot.voice' AND lead_id = ?")
        .all(LEAD_A);
      assert.equal(usage.length, 1, 'exactly one metering row for the connected session');
      n++;
      assert.equal(usage[0].provider, 'openai', 'metering provider is openai');
      n++;
      assert.equal(usage[0].model, 'gpt-realtime-2.1', 'metering model recorded');
      n++;
      const expectTokens = voice.estimateVoiceTokens(Number(endRow.voice_duration_sec));
      assert.equal(usage[0].prompt_tokens, expectTokens.promptTokens, 'input tokens follow the documented per-minute estimate');
      n++;
      assert.equal(usage[0].completion_tokens, expectTokens.completionTokens, 'output tokens follow the documented per-minute estimate');
      n++;
      assert.ok(
        Math.abs(Number(usage[0].cost_usd) - voice.estimateVoiceCostUsd(Number(endRow.voice_duration_sec))) < 0.0001,
        'cost = documented rates × estimated tokens'
      );
      n++;
      assert.ok(Math.abs(Number(endRow.voice_duration_sec) - 180) <= 2 && Number(usage[0].cost_usd) > 0.13, 'a ~3-minute session meters ≈ $0.144');
      n++;
      const fin2 = voice.appendVoiceTranscript(dbA, TOKEN_A, sid, secret, { items: [], final: true, close: 'hangup' });
      assert.equal(fin2.end.already, true, 'a second end is a no-op');
      n++;
      assert.equal(
        dbA.prepare("SELECT COUNT(*) AS c FROM ai_usage WHERE task = 'chatbot.voice' AND lead_id = ?").get(LEAD_A).c,
        1,
        'no double metering'
      );
      n++;

      // Never connected: mint, then an end with connected=false.
      const minted2 = await voice.mintVoiceSession(WS_A, dbA, TOKEN_A, {});
      const nc = voice.appendVoiceTranscript(dbA, TOKEN_A, minted2.session.id, minted2.relay_secret, {
        items: [],
        final: true,
        close: 'error',
        connected: false,
      });
      assert.equal(nc.ended, true, 'never-connected session still closes its record');
      n++;
      assert.equal(
        dbA.prepare("SELECT COUNT(*) AS c FROM ai_usage WHERE task = 'chatbot.voice' AND lead_id = ?").get(LEAD_A).c,
        1,
        'a session that never connects writes NO usage row'
      );
      n++;
      const ncRow = dbA.prepare('SELECT * FROM chatbot_sessions WHERE id = ?').get(minted2.session.id);
      assert.equal(ncRow.voice_close_state, 'abrupt', 'a connect failure reads as ended abruptly, not complete');
      n++;
    } finally {
      global.fetch = realFetch;
    }
    group('Part 3 mint + relay + transcript + metering', n);
  }

  /* ================================================================== */
  /* Part 4 — HTTP over the real server (stubbed OpenAI base URL)        */
  /* ================================================================== */
  {
    let n = 0;
    const http = require('node:http');
    const { spawn } = require('node:child_process');
    const EK_HTTP = ['ek', 'fixture138', 'http'].join('_');
    const stubSeen = [];
    const stub = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        stubSeen.push({ url: req.url, auth: req.headers.authorization || '', body });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ value: EK_HTTP, expires_at: 1999999999, session: { id: 'sess_http_138' } }));
      });
    });
    await new Promise((resolve) => stub.listen(STUB_PORT, '127.0.0.1', resolve));
    await platform.setPlatformSetting('ai.base_url', `http://127.0.0.1:${STUB_PORT}/v1`);

    const bcrypt = require('bcryptjs');
    const q = platformDb.query;
    await q('INSERT INTO users (email, password_hash, name, is_super_admin, status) VALUES (:e, :h, :n, 1, :s)', {
      e: 'owner138@example.invalid',
      h: bcrypt.hashSync(['Unused', 'Pass', '138'].join('') + '!', 12),
      n: 'B138 Portal Link',
      s: 'active',
    });
    await q(
      `INSERT INTO client_portal_users (email, password_hash, workspace_id, lead_id, business_name, status, user_type)
       VALUES (:e, :h, :w, :l, :b, 'active', 'owner')`,
      { e: 'owner138@example.invalid', h: bcrypt.hashSync(PW, 12), w: WS_A, l: LEAD_A, b: 'B138 Voice Fixture' }
    );

    const child = spawn(process.execPath, [path.join(root, 'server.js')], {
      cwd: root,
      env: { ...process.env, PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (b) => (output += b));
    child.stderr.on('data', (b) => (output += b));
    const closed = new Promise((resolve) => child.once('close', resolve));
    try {
      let ready = false;
      for (let i = 0; i < 300 && !ready; i++) {
        if (child.exitCode != null) throw new Error('server exited early: ' + output);
        try {
          const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(500) });
          if (r.ok) ready = true;
        } catch {}
        if (!ready) await new Promise((r) => setTimeout(r, 200));
      }
      assert.ok(ready, 'server became ready');
      n++;

      // Public config advertises voice (enabled + entitled + keyed).
      const cfgRes = await fetch(`${BASE}/api/v1/chat/public/${TOKEN_A}`);
      assert.equal(cfgRes.status, 200, 'public config loads');
      n++;
      const cfg = (await json(cfgRes)).data;
      assert.equal(cfg.voice && cfg.voice.enabled, true, 'config advertises voice');
      n++;
      assert.equal(cfg.voice.max_duration_sec, 600, 'config carries the cap');
      n++;

      // Mint over HTTP: the stub sees the platform key; the visitor never does.
      const mintRes = await fetch(`${BASE}/api/v1/chat/public/${TOKEN_A}/voice/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      assert.equal(mintRes.status, 200, 'mint succeeds over HTTP');
      n++;
      const mintText = await mintRes.text();
      assert.ok(!mintText.includes(OPENAI_KEY), 'mint response never contains the platform key');
      n++;
      const minted = JSON.parse(mintText).data;
      assert.equal(minted.ephemeral.value, EK_HTTP, 'browser gets the stub-minted ephemeral credential');
      n++;
      assert.equal(stubSeen.length, 1, 'the server minted exactly once upstream');
      n++;
      assert.equal(stubSeen[0].auth, `Bearer ${OPENAI_KEY}`, 'the upstream mint carried the platform key server-side');
      n++;
      assert.ok(stubSeen[0].url.endsWith('/realtime/client_secrets'), 'upstream URL is the client_secrets endpoint');
      n++;

      // Transcript save + read-back through the normal session surface.
      const tRes = await fetch(`${BASE}/api/v1/chat/public/${TOKEN_A}/voice/session/${minted.session.id}/transcript`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          relay_secret: minted.relay_secret,
          items: [
            { role: 'visitor', body: 'HTTP hello', item_id: 'h_1', at_ms: 500 },
            { role: 'agent', body: 'HTTP reply', item_id: 'h_2', at_ms: 900 },
          ],
        }),
      });
      assert.equal(tRes.status, 200, 'transcript relay accepts the batch');
      n++;
      assert.equal((await json(tRes)).data.appended, 2, 'both sides saved');
      n++;
      const badRes = await fetch(`${BASE}/api/v1/chat/public/${TOKEN_A}/voice/session/${minted.session.id}/transcript`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ relay_secret: 'nope', items: [] }),
      });
      assert.equal(badRes.status, 403, 'a bad relay secret is refused over HTTP');
      n++;
      const finRes = await fetch(`${BASE}/api/v1/chat/public/${TOKEN_A}/voice/session/${minted.session.id}/transcript`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ relay_secret: minted.relay_secret, items: [], final: true, close: 'hangup', connected: true }),
      });
      assert.equal((await json(finRes)).data.ended, true, 'final relay closes the session');
      n++;
      const histRes = await fetch(
        `${BASE}/api/v1/chat/public/${TOKEN_A}/messages?session=${encodeURIComponent(minted.session.session_token)}`
      );
      const hist = (await json(histRes)).data;
      const bodies = (hist.messages || []).map((m) => m.body);
      assert.ok(bodies.includes('HTTP hello') && bodies.includes('HTTP reply'), 'the saved voice conversation reads back like any chat');
      n++;
      assert.equal(hist.session.channel, 'voice', 'history marks the session as voice');
      n++;
      assert.ok(hist.session.voice && hist.session.voice.duration_sec != null, 'history carries the voice duration for the inbox');
      n++;

      // Portal: settings toggle drives the advertisement; image flow.
      const owner = makeJar();
      const login = await owner.fetch(`${BASE}/api/v1/portal/login`, {
        method: 'POST',
        body: JSON.stringify({ email: 'owner138@example.invalid', password: PW }),
      });
      assert.equal(login.status, 200, 'portal owner login');
      n++;
      const off = await owner.fetch(`${BASE}/api/v1/portal/modules/chatbot/settings`, {
        method: 'PUT',
        body: JSON.stringify({ voice_enabled: false }),
      });
      assert.equal(off.status, 200, 'portal settings save accepts voice fields');
      n++;
      const cfgOff = (await json(await fetch(`${BASE}/api/v1/chat/public/${TOKEN_A}`))).data;
      assert.equal(cfgOff.voice.enabled, false, 'turning voice off in the portal stops the advertisement');
      n++;
      await owner.fetch(`${BASE}/api/v1/portal/modules/chatbot/settings`, {
        method: 'PUT',
        body: JSON.stringify({ voice_enabled: true }),
      });
      const pngBuf = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
      const up = await owner.fetch(`${BASE}/api/v1/portal/modules/chatbot/voice-image`, {
        method: 'POST',
        body: JSON.stringify({ data: pngBuf.toString('base64'), fileName: 'bubble.png' }),
      });
      assert.equal(up.status, 200, 'portal bubble-image upload succeeds');
      n++;
      const imgRes = await fetch(`${BASE}/api/v1/chat/public/${TOKEN_A}/voice-image`);
      assert.equal(imgRes.status, 200, 'the bubble image serves publicly for the site');
      n++;
      assert.ok(String(imgRes.headers.get('content-type') || '').includes('image/png'), 'served with the sniffed mime');
      n++;
      const cfgImg = (await json(await fetch(`${BASE}/api/v1/chat/public/${TOKEN_A}`))).data;
      assert.ok(cfgImg.voice.bubble_image_url && cfgImg.voice.bubble_image_url.includes('/voice-image'), 'config now advertises the bubble image');
      n++;
      const del = await owner.fetch(`${BASE}/api/v1/portal/modules/chatbot/voice-image`, { method: 'DELETE' });
      assert.equal(del.status, 200, 'portal bubble-image remove succeeds');
      n++;
      const imgGone = await fetch(`${BASE}/api/v1/chat/public/${TOKEN_A}/voice-image`);
      assert.equal(imgGone.status, 404, 'a removed image stops serving');
      n++;
    } finally {
      child.kill('SIGTERM');
      await Promise.race([closed, new Promise((r) => setTimeout(r, 5000))]);
      stub.close();
    }
    group('Part 4 HTTP end-to-end', n);
  }

  console.log(`\nBATCH138 ALL PASS — ${groups.length} groups: ${groups.join(' · ')}`);
})().catch((e) => {
  console.error('BATCH138 FAIL:', (e && e.stack) || e);
  process.exit(1);
});
