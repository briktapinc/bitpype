'use strict';
/**
 * Batch 174 — the "Improve with AI" design chat works exactly like
 * the Assistant chat (Ely 2026-11-09: "improve with AI chat should
 * work exactly like the assistant chat. redesign it.").
 *
 * WHAT CHANGED (chat layer only — the design doctrine, per-site
 * isolation, the collapsible fixed-height panel, the 150/day
 * counter and design_chat routing are untouched):
 *   - Transport: POST /site/agent-chat/stream answers SSE
 *     status/delta/done, the Assistant chat's protocol
 *     (server/assistantChat.js runAssistantTurn). The pipeline
 *     emits stage statuses and streams the finished reply in the
 *     same word-chunks; the JSON route keeps working and both
 *     routes share ONE turn implementation
 *     (runSiteChatTurnForPortal) so gate/record/summary happen
 *     exactly once per turn.
 *   - Rendering: assistant replies render through the SAME
 *     escape-first markdown renderer (assistantMd) inside .md-body;
 *     the client creates a live bubble at send and finalizes it
 *     from the done payload.
 *   - Attachments: the full Assistant kind set via the shared
 *     sniffer (images, MP4/MOV/WebM video, PDF, text files) with
 *     the Assistant's caps and refusal copy; images reach the
 *     model as vision parts, text files are inlined, other kinds
 *     are described by metadata. Composer gains the Camera button
 *     + capture input, identical accept list.
 *
 * PROVEN HERE:
 *   Part 1 — source pins for every parity wire + the SEC-13
 *     census delta (503 -> 506: exactly +3 IDENT assistantMd
 *     writes in portal.js, multiset-pinned).
 *   Part 2 — attachment engine units: buildTurnAttachments
 *     (vision / inline / note), kind + cap + refusal parity.
 *   Part 3 — real server + stubbed model over HTTP: streaming
 *     question turn (≥2 deltas concatenating to the persisted
 *     reply, zero design-tool calls), history persistence, the
 *     JSON route returning the same shape, a streamed build turn
 *     (tool call lands, theme changes, preview html returned),
 *     image → vision, text file → inlined, invalid file refused
 *     with the Assistant's message, the daily counter + limit
 *     turn over SSE, and cross-site isolation.
 *   Part 4 — real Chromium against a stub API: the streamed
 *     reply renders as markdown in the live bubble, the composer
 *     carries Attach + Camera with the Assistant's accept list,
 *     and the panel stays fixed-height with internal scroll.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b174-'));
// Batch 168 finisher fixture (added at the 174 rebase, 2026-11-09):
// S1#3 made the server refuse to boot in production without
// SETTINGS_ENCRYPTION_KEY; this suite spawns the real server —
// same synthetic fixture as oauth-token/isolated-startup.
process.env.SETTINGS_ENCRYPTION_KEY =
  process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 23).toString('base64');
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.PLATFORM_DB_PATH = process.env.SQLITE_PATH;
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://example.invalid';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch174', 'test', 'session', 'secret'].join('-');
process.env.BOOTSTRAP_EMAIL = 'root@b174.invalid';
process.env.BOOTSTRAP_PASSWORD = ['Root', '174', 'Pass'].join('-');
process.env.BOOTSTRAP_NAME = 'B174 Root';
process.env.MAIL_DRY_RUN = '1';
process.env.ALLOW_LOCAL_AI = '1';
delete process.env.http_proxy;
delete process.env.https_proxy;
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;

const PORT = 31474;
const STUB_PORT = 31475;
const BASE = `http://127.0.0.1:${PORT}`;
const groups = [];
function group(name, n) {
  groups.push(`${name} (${n})`);
  console.log(`  ok ${name} — ${n} checks`);
}
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

(async () => {
  // ---------------------------------------------------------------
  // Part 1 — source pins: the parity wires exist, doctrine intact
  // ---------------------------------------------------------------
  {
    let n = 0;
    const psc = read('server/portalSiteChat.js');
    assert.ok(psc.includes('opts = {}'), 'pipeline accepts an options arg');
    assert.ok(psc.includes("typeof opts.onEvent === 'function'"), 'event sink is opt-in');
    assert.ok(psc.includes('function streamReplyText(onEvent, text)'), 'reply chunker present');
    assert.ok(psc.includes("onEvent('delta', { text: acc })"), 'deltas emitted in >=48-char chunks');
    for (const label of ['Reading your site…', 'Planning the change…', 'Updating your site…', 'Looking into that…', 'Checking the result…']) {
      assert.ok(psc.includes(`'${label}'`), `stage status emitted: ${label}`);
      n += 1;
    }
    assert.ok(psc.includes('chatAtt.buildTurnAttachments(attachmentRows)'), 'turn attachments prepared the Assistant way');
    assert.ok(psc.includes('message: withAtt(message)'), 'attachment context rides the classifier message');
    assert.ok(psc.includes('message: withAtt(loopOpts && loopOpts.message)'), 'attachment context rides the loop message');
    n += 9;

    const att = read('server/siteChatAttachments.js');
    assert.ok(att.includes("require('./assistantChat').sniffAttachment(buffer, originalName)"), 'validation delegates to the Assistant sniffer');
    assert.ok(att.includes('MAX_VIDEO_BYTES = 50 * 1024 * 1024'), 'video cap matches the Assistant (50 MB)');
    assert.ok(att.includes('MAX_FILE_BYTES = 10 * 1024 * 1024'), 'file cap matches the Assistant (10 MB)');
    assert.ok(att.includes('function buildTurnAttachments(rows)'), 'buildTurnAttachments present');
    assert.ok(att.includes('kind: kindForMime(row.mime)'), 'public rows carry the kind');
    n += 5;

    const routes = read('server/routes/portal.js');
    assert.ok(routes.includes("router.post('/site/agent-chat/stream'"), 'SSE route registered');
    assert.ok(routes.includes("router.post('/site/agent-chat',"), 'JSON route kept');
    assert.ok(routes.includes("'Content-Type': 'text/event-stream'"), 'SSE content type set');
    assert.equal(routes.split('await runSiteChatTurnForPortal(req,').length - 1, 2, 'both transports share one turn implementation');
    assert.ok(routes.includes("send('done', data)"), 'stream ends with the full payload as done');
    n += 5;

    const html = read('public/portal.html');
    assert.ok(html.includes('id="agent-chat-camera"'), 'composer has the Camera button');
    assert.ok(html.includes('id="agent-chat-camera-file"'), 'composer has the capture input');
    assert.ok(html.includes('capture="environment"'), 'capture input uses the environment camera');
    assert.ok(
      html.includes('accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/quicktime,video/webm,application/pdf,.txt,.md,.csv,.json"'),
      'file input accept list identical to the Assistant composer'
    );
    assert.ok(!html.includes('>Attach image<'), 'attach label shortened to match the Assistant');
    // The Batch 110 panel contract is untouched.
    assert.ok(html.includes('id="agent-chat-messages"'), 'message list present');
    assert.ok(html.includes('id="agent-chat-toggle"'), 'collapse toggle present');
    n += 7;

    const js = read('public/js/portal.js');
    assert.ok(js.includes('async function streamAgentChatTurn('), 'client SSE transport present');
    assert.ok(js.includes("'/api/v1/portal/site/agent-chat/stream'"), 'client posts to the stream route');
    assert.ok(js.includes("appendAgentBubble('assistant', '', null, 'force')"), 'live bubble created at send');
    assert.ok(js.includes('liveBody.innerHTML = assistantMd(acc);'), 'deltas render through assistantMd');
    assert.ok(js.includes('liveBody.innerHTML = assistantMd(reply);'), 'done payload finalizes the bubble');
    assert.ok(js.includes("body.className = 'md-body';"), 'assistant bubbles carry a .md-body');
    assert.ok(js.includes("getElementById('agent-chat-camera')"), 'camera button wired');
    assert.ok(!js.includes('Images only — PNG, JPG, WebP or GIF.'), 'images-only client gate removed');
    assert.ok(js.includes('Up to 4 attachments per message.'), 'per-message cap copy matches the Assistant');
    assert.ok(js.includes('That file is over the 50 MB limit.'), 'client size pre-check matches the Assistant');
    assert.ok(js.includes("localStorage.getItem('portal.agentChatCollapsed') === '1'"), 'collapse persistence intact');
    n += 11;

    // SEC-13 census: the batch's whole delta, pinned.
    const { census } = require(path.join(root, 'scripts/xss-census.cjs'));
    const cz = census();
    assert.deepEqual(
      cz.summary,
      { total: 507, STATIC: 187, ESCAPED: 48, SAFE: 81, BUILDER: 64, IDENT: 41, RAW: 86 },
      'census on the merged 168+174 tree: 507 (Batch 174 adds +3 IDENT over the Batch 168 tree at 504; RAW unchanged; safe classes 380)'
    );
    const multi = cz.sinks.map((s) => `${s.file}|${s.kind}|${s.snippet}`).sort();
    const sha = crypto.createHash('sha256').update(multi.join('\n')).digest('hex');
    assert.equal(sha, 'a4884d2d227651d4f741bb6f7df5a15c90ff874e9186b63caf4e9a248b81a3fb', 'census multiset pinned');
    const identSnippets = cz.sinks.filter((s) => s.file === 'public/js/portal.js' && s.kind === 'IDENT').map((s) => s.snippet);
    for (const snip of ["assistantMd(text || '')", 'assistantMd(acc)', 'assistantMd(reply)']) {
      assert.ok(identSnippets.includes(snip), `new IDENT sink present: ${snip}`);
      n += 1;
    }
    n += 2;
    group('Part 1 — source pins + census', n);
  }

  // ---------------------------------------------------------------
  // Part 2 — attachment engine units (Assistant parity)
  // ---------------------------------------------------------------
  {
    let n = 0;
    await require(path.join(root, 'server', 'db.js')).migrate();
    const domain = require(path.join(root, 'server', 'domain.js'));
    const chatAtt = require(path.join(root, 'server', 'siteChatAttachments.js'));
    const sharp = require(path.join(root, 'node_modules', 'sharp'));
    const pngBuf = await sharp({ create: { width: 24, height: 24, channels: 3, background: { r: 20, g: 120, b: 90 } } }).png().toBuffer();
    const seed = domain.withDb(1, (db) => {
      const lead = db.prepare('INSERT INTO leads (business_name) VALUES (?)').run('ZZ B174 Fixture');
      return Number(lead.lastInsertRowid);
    });
    const save = (buffer, originalName) =>
      domain.withDb(1, (db) => chatAtt.saveAttachment(db, { workspaceId: 1, leadId: seed, buffer, originalName }));

    const img = await save(pngBuf, 'palette.png');
    assert.equal(img.kind, 'image');
    assert.ok(img.thumbUrl, 'image keeps its thumbnail');
    n += 2;

    const mp4 = Buffer.alloc(32);
    mp4.writeUInt32BE(24, 0);
    mp4.write('ftyp', 4, 'ascii');
    mp4.write('isom', 8, 'ascii');
    const vid = await save(mp4, 'walkthrough.mp4');
    assert.equal(vid.kind, 'video');
    assert.equal(vid.thumbUrl, null, 'video carries no thumbnail');
    n += 2;

    const txt = await save(Buffer.from('We open at 6am on Saturdays.'), 'hours.txt');
    // Assistant parity: text files carry kind 'file' there too —
    // the inlining is mime-driven (buildTurnAttachments below).
    assert.equal(txt.kind, 'file');
    assert.equal(txt.mime, 'text/plain');
    n += 2;

    const pdf = await save(Buffer.from('%PDF-1.4\n%fixture\n'), 'menu.pdf');
    assert.equal(pdf.kind, 'file');
    n += 1;

    const rows = domain.withDb(1, (db) => chatAtt.loadForChat(db, { leadId: seed, ids: [img.id, vid.id, txt.id, pdf.id] }));
    const turn = await chatAtt.buildTurnAttachments(rows);
    assert.equal(turn.modelImages.length, 1, 'only the image becomes a vision part');
    assert.ok(turn.modelImages[0].dataUrl.startsWith('data:image/jpeg;base64,'), 'vision part is the downscaled copy');
    assert.ok(turn.texts.some((t) => t.includes('--- attached file "hours.txt" ---') && t.includes('We open at 6am')), 'text file inlined with the Assistant framing');
    assert.ok(turn.notes.some((t) => t.includes('[Attached video: "walkthrough.mp4"')), 'video described by metadata note');
    assert.ok(turn.notes.some((t) => t.includes('[Attached file: "menu.pdf"')), 'pdf described by metadata note');
    n += 5;

    await assert.rejects(save(Buffer.from('definitely not a png'), 'fake.png'), (e) => {
      assert.equal(e.code, 'INVALID_FILE');
      assert.equal(
        e.message,
        'That file type is not supported. Attach images (PNG, JPG, WebP, GIF), videos (MP4, MOV, WebM), PDFs, or text files (TXT, MD, CSV, JSON).'
      );
      return true;
    });
    n += 1;
    const bigVideo = Buffer.alloc(chatAtt.MAX_VIDEO_BYTES + 1);
    mp4.copy(bigVideo, 0, 0, 16);
    await assert.rejects(save(bigVideo, 'huge.mp4'), (e) => e.code === 'TOO_LARGE' && e.message === 'That video is too large — the limit is 50 MB.');
    n += 1;
    assert.equal(chatAtt.kindForMime('video/quicktime'), 'video');
    assert.equal(chatAtt.kindForMime('text/csv'), 'file');
    assert.equal(chatAtt.kindForMime('application/pdf'), 'file');
    n += 3;
    group('Part 2 — attachment engine parity units', n);
  }

  // ---------------------------------------------------------------
  // Part 3 — real server + stubbed model: the streamed turn
  // ---------------------------------------------------------------
  {
    let n = 0;
    const domain = require(path.join(root, 'server', 'domain.js'));
    const platform = require(path.join(root, 'server', 'platform.js'));
    const { query } = require(path.join(root, 'server', 'db.js'));
    const bcrypt = require(path.join(root, 'node_modules', 'bcryptjs'));

    // --- Stub model (OpenAI-compatible chat/completions) ---
    const stubLog = [];
    const themeAlias = 'theme_set_' + crypto.createHash('sha256').update('theme.set').digest('hex').slice(0, 12);
    const stub = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const body = JSON.parse(raw || '{}');
        const msgs = Array.isArray(body.messages) ? body.messages : [];
        const textOf = (m) =>
          typeof m.content === 'string'
            ? m.content
            : Array.isArray(m.content)
              ? m.content.map((p) => (p && p.type === 'text' ? p.text : '')).join('\n')
              : '';
        const system = msgs.filter((m) => m.role === 'system').map(textOf).join('\n');
        const allText = msgs.map(textOf).join('\n');
        const userMsgs = msgs.filter((m) => m.role === 'user');
        const lastUser = userMsgs.length ? textOf(userMsgs[userMsgs.length - 1]) : '';
        const sawImage = msgs.some(
          (m) => Array.isArray(m.content) && m.content.some((p) => p && (p.type === 'image_url' || p.type === 'input_image'))
        );
        const entry = { system, allText, sawImage, tools: Array.isArray(body.tools) ? body.tools.length : 0, toolResult: msgs.some((m) => m.role === 'tool'), repliedToolCall: false };
        stubLog.push(entry);
        const reply = (message, finish) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 'chatcmpl-b174',
              object: 'chat.completion',
              choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: finish || 'stop' }],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            })
          );
        };
        if (system.includes('router for a website design agent chat')) {
          const change = /teal/i.test(lastUser);
          return reply({
            content: JSON.stringify(
              change
                ? { intent: 'change', ready: true, settled: [], signals: { wantsChange: true } }
                : { intent: 'question', ready: false, settled: [], signals: { wantsChange: false } }
            ),
          });
        }
        if (system.includes('You are the PLANNER')) {
          return reply({ content: 'no plan from the stub' });
        }
        if (system.includes('site co-pilot inside the client portal')) {
          if (entry.toolResult) return reply({ content: 'Done — I switched your palette to teal.' });
          if (entry.tools > 0 && /teal/i.test(lastUser)) {
            entry.repliedToolCall = true;
            return reply(
              { content: null, tool_calls: [{ id: 'call_b174_1', type: 'function', function: { name: themeAlias, arguments: JSON.stringify({ primary: '#0f766e' }) } }] },
              'tool_calls'
            );
          }
          const headline = allText.includes('Precision Cuts Daily') ? 'Precision Cuts Daily' : 'Fresh Bread Every Morning';
          return reply({
            content: `Your homepage headline says "${headline}" — it is the first thing visitors see at the top of the page, above your introduction.`,
          });
        }
        return reply({ content: '{}' });
      });
    });
    await new Promise((r) => stub.listen(STUB_PORT, '127.0.0.1', r));
    await platform.setPlatformSetting('muse.model_base_url', `http://127.0.0.1:${STUB_PORT}`);
    await platform.setPlatformSetting('muse.model_api_key', 'b174-stub-key');

    // --- Fixtures: two sites in one workspace, one owner each ---
    const seedSite = (business, headline) =>
      domain.withDb(1, (db) => {
        const lead = db.prepare('INSERT INTO leads (business_name) VALUES (?)').run(business);
        const leadId = Number(lead.lastInsertRowid);
        const pages = JSON.stringify([
          { slug: 'index', title: 'Home', sections: [{ type: 'hero', content: { headline, sub: 'Fixture sub.' } }] },
        ]);
        const site = db.prepare("INSERT INTO websites (lead_id, name, status, pages, theme) VALUES (?, ?, 'draft', ?, '{}')").run(leadId, business + ' Site', pages);
        return { leadId, siteId: Number(site.lastInsertRowid) };
      });
    const A = seedSite('ZZ B174 Bakery', 'Fresh Bread Every Morning');
    const B = seedSite('ZZ B174 Barbers', 'Precision Cuts Daily');
    const hash = await bcrypt.hash('Batch174-Test-Pass!', 10);
    for (const [email, lead, name] of [
      ['b174-a@test.invalid', A.leadId, 'ZZ B174 Bakery'],
      ['b174-b@test.invalid', B.leadId, 'ZZ B174 Barbers'],
    ]) {
      await query(
        `INSERT INTO client_portal_users (email, password_hash, workspace_id, lead_id, business_name, status)
         VALUES (:email, :hash, 1, :lead, :name, 'active')`,
        { email, hash, lead, name }
      );
    }
    n += 3;

    const child = spawn(process.execPath, [path.join(root, 'server.js')], {
      cwd: root,
      env: { ...process.env, PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let childLog = '';
    child.stdout.on('data', (d) => (childLog += d));
    child.stderr.on('data', (d) => (childLog += d));
    const closed = new Promise((resolve) => child.once('close', resolve));
    try {
      let up = false;
      for (let i = 0; i < 120 && !up; i++) {
        await new Promise((r) => setTimeout(r, 500));
        try {
          const res = await fetch(`${BASE}/api/v1/health`);
          up = res.status === 200;
        } catch {
          up = false;
        }
      }
      assert.ok(up, 'server booted: ' + childLog.slice(-400));
      n += 1;

      function req(method, p, { body, cookie } = {}) {
        return new Promise((resolve, reject) => {
          const data = body != null ? Buffer.from(JSON.stringify(body)) : null;
          const r = http.request(
            {
              host: '127.0.0.1',
              port: PORT,
              path: p,
              method,
              headers: {
                'X-Forwarded-Proto': 'https',
                ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}),
                ...(cookie ? { Cookie: cookie } : {}),
              },
            },
            (res) => {
              const chunks = [];
              res.on('data', (c) => chunks.push(c));
              res.on('end', () => {
                const buf = Buffer.concat(chunks);
                let json = null;
                try {
                  json = JSON.parse(buf.toString('utf8'));
                } catch {
                  json = null;
                }
                resolve({ status: res.statusCode, headers: res.headers, buf, json });
              });
            }
          );
          r.on('error', reject);
          if (data) r.write(data);
          r.end();
        });
      }
      async function login(email) {
        const res = await req('POST', '/api/v1/portal/login', { body: { email, password: 'Batch174-Test-Pass!' } });
        assert.equal(res.status, 200, `login ${email}: ${res.buf.toString('utf8').slice(0, 200)}`);
        return (res.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
      }
      const cookieA = await login('b174-a@test.invalid');
      const cookieB = await login('b174-b@test.invalid');
      n += 2;

      const parseSse = (buf) => {
        const events = [];
        for (const block of buf.toString('utf8').split('\n\n')) {
          const ev = /^event: (\w+)$/m.exec(block);
          const da = /^data: (.*)$/m.exec(block);
          if (ev && da) events.push({ type: ev[1], data: JSON.parse(da[1]) });
        }
        return events;
      };
      const streamTurn = async (cookie, body) => {
        const res = await req('POST', '/api/v1/portal/site/agent-chat/stream', { cookie, body });
        assert.equal(res.status, 200, res.buf.toString('utf8').slice(0, 200));
        assert.match(String(res.headers['content-type']), /text\/event-stream/, 'stream answers SSE');
        const events = parseSse(res.buf);
        const done = events.filter((e) => e.type === 'done').pop();
        assert.ok(done, 'stream ends with a done event');
        return { events, done: done.data };
      };

      // Turn 1 (A) — a question, streamed: status + >=2 deltas
      // concatenating to the done reply; NO design tool invoked.
      let mark = stubLog.length;
      const t1 = await streamTurn(cookieA, { message: 'What does my homepage headline say?' });
      const t1Log = stubLog.slice(mark);
      assert.ok(t1.events.some((e) => e.type === 'status'), 'status events stream during the turn');
      const deltas = t1.events.filter((e) => e.type === 'delta').map((e) => e.data.text);
      assert.ok(deltas.length >= 2, `reply streamed in chunks (got ${deltas.length})`);
      assert.equal(deltas.join(''), t1.done.reply, 'delta concatenation equals the done reply');
      assert.equal(
        t1.done.reply,
        'Your homepage headline says "Fresh Bread Every Morning" — it is the first thing visitors see at the top of the page, above your introduction.'
      );
      assert.equal(t1.done.mode, 'answer', 'a question is answered, not built');
      assert.ok(!t1Log.some((e) => e.repliedToolCall || e.toolResult), 'question turn invoked zero design tools');
      assert.deepEqual(t1.done.chatUsage, { used: 1, limit: 5 }, 'counter rides the done payload (used counts this turn)');
      n += 7;

      // History: the turn persisted to THIS site's thread.
      const histA1 = await req('GET', '/api/v1/portal/site/agent-chat/history', { cookie: cookieA });
      const msgsA = histA1.json.data.messages;
      assert.equal(msgsA.length, 2, 'one turn persisted (user + assistant)');
      assert.equal(msgsA[0].content, 'What does my homepage headline say?');
      assert.equal(msgsA[1].content, t1.done.reply, 'persisted reply equals the streamed reply');
      n += 3;

      // Turn 2 (A) — the JSON route still answers the same shape.
      const t2 = await req('POST', '/api/v1/portal/site/agent-chat', { cookie: cookieA, body: { message: 'And the headline again?' } });
      assert.equal(t2.status, 200);
      assert.equal(t2.json.data.mode, 'answer');
      assert.equal(t2.json.data.reply, t1.done.reply, 'JSON route returns the same reply');
      n += 3;

      // Turn 3 (A) — a change, streamed: the tool call lands, the
      // theme actually changes, preview html comes back.
      mark = stubLog.length;
      const t3 = await streamTurn(cookieA, { message: 'Make the site teal' });
      const t3Log = stubLog.slice(mark);
      assert.ok(t3Log.some((e) => e.repliedToolCall), 'the model issued the theme tool call');
      assert.equal(t3.done.mode, 'build');
      assert.equal(t3.done.mutated, true, 'the change was applied');
      assert.ok(typeof t3.done.html === 'string' && t3.done.html.length > 0, 'done payload carries fresh preview html');
      const themeRow = domain.withDb(1, (db) => db.prepare('SELECT theme FROM websites WHERE id = ?').get(A.siteId));
      assert.ok(String(themeRow.theme).includes('0f766e'), 'theme persisted with the new primary');
      n += 5;

      // Turn 4 (A) — an image rides to the model as a vision part.
      const sharp = require(path.join(root, 'node_modules', 'sharp'));
      const pngBuf = await sharp({ create: { width: 24, height: 24, channels: 3, background: { r: 20, g: 120, b: 90 } } }).png().toBuffer();
      const upImg = await req('POST', '/api/v1/portal/site/agent-chat/attachments', {
        cookie: cookieA,
        body: { data: 'data:image/png;base64,' + pngBuf.toString('base64'), name: 'palette.png' },
      });
      assert.equal(upImg.status, 200, upImg.buf.toString('utf8').slice(0, 200));
      assert.equal(upImg.json.data.kind, 'image');
      assert.ok(upImg.json.data.thumbUrl, 'image upload returns a thumbnail');
      mark = stubLog.length;
      const t4 = await streamTurn(cookieA, { message: 'What colours are in this picture?', attachmentIds: [upImg.json.data.id] });
      assert.equal(t4.done.mode, 'answer');
      assert.ok(stubLog.slice(mark).some((e) => e.sawImage), 'the model received the image as a vision part');
      n += 5;

      // Turn 5 (A) — a text file is inlined into the model message.
      const upTxt = await req('POST', '/api/v1/portal/site/agent-chat/attachments', {
        cookie: cookieA,
        body: { data: 'data:text/plain;base64,' + Buffer.from('We open at 6am on Saturdays.').toString('base64'), name: 'hours.txt' },
      });
      assert.equal(upTxt.status, 200, upTxt.buf.toString('utf8').slice(0, 200));
      assert.equal(upTxt.json.data.kind, 'file');
      assert.equal(upTxt.json.data.mime, 'text/plain');
      assert.equal(upTxt.json.data.thumbUrl, null, 'text files carry no thumbnail');
      mark = stubLog.length;
      const t5 = await streamTurn(cookieA, { message: 'When do we open on Saturdays?', attachmentIds: [upTxt.json.data.id] });
      assert.equal(t5.done.mode, 'answer');
      assert.ok(stubLog.slice(mark).some((e) => e.allText.includes('We open at 6am on Saturdays.')), 'the file content reached the model inlined');
      n += 5;

      // Turn 6 (A) — the daily cap (Free plan: 5) refuses over SSE,
      // with the streamed limit reply and the counter at the cap.
      const t6 = await streamTurn(cookieA, { message: 'One more question?' });
      assert.equal(t6.done.mode, 'limit', 'the sixth turn is refused by the daily cap');
      assert.ok(t6.done.reply.includes('5 of 5'), 'limit reply states the count');
      assert.ok(t6.done.reply.includes('Nothing was changed'), 'limit reply is honest');
      assert.deepEqual(t6.done.chatUsage, { used: 5, limit: 5 }, 'a refused turn reports the standing count (gate semantics unchanged)');
      const t6Deltas = t6.events.filter((e) => e.type === 'delta').map((e) => e.data.text).join('');
      assert.equal(t6Deltas, t6.done.reply, 'the limit reply streams too');
      n += 5;

      // Refusals carry the Assistant's copy + code.
      const fake = await req('POST', '/api/v1/portal/site/agent-chat/attachments', {
        cookie: cookieA,
        body: { data: 'data:image/png;base64,' + Buffer.from('definitely not an image').toString('base64'), name: 'fake.png' },
      });
      assert.equal(fake.status, 400);
      assert.equal(fake.json.code, 'INVALID_FILE');
      assert.equal(
        fake.json.error,
        'That file type is not supported. Attach images (PNG, JPG, WebP, GIF), videos (MP4, MOV, WebM), PDFs, or text files (TXT, MD, CSV, JSON).'
      );
      n += 3;

      // Site B — a video uploads as kind video; B's own streamed
      // question is answered from B's site only; A's attachment id
      // is unusable from B's session.
      const mp4 = Buffer.alloc(32);
      mp4.writeUInt32BE(24, 0);
      mp4.write('ftyp', 4, 'ascii');
      mp4.write('isom', 8, 'ascii');
      const upVid = await req('POST', '/api/v1/portal/site/agent-chat/attachments', {
        cookie: cookieB,
        body: { data: 'data:video/mp4;base64,' + mp4.toString('base64'), name: 'walkthrough.mp4' },
      });
      assert.equal(upVid.status, 200, upVid.buf.toString('utf8').slice(0, 200));
      assert.equal(upVid.json.data.kind, 'video');
      assert.equal(upVid.json.data.thumbUrl, null);
      const tB = await streamTurn(cookieB, { message: 'What does my homepage headline say?' });
      assert.equal(
        tB.done.reply,
        'Your homepage headline says "Precision Cuts Daily" — it is the first thing visitors see at the top of the page, above your introduction.',
        "B's answer comes from B's site"
      );
      const histB = await req('GET', '/api/v1/portal/site/agent-chat/history', { cookie: cookieB });
      const bText = histB.json.data.messages.map((m) => m.content).join('\n');
      assert.ok(bText.includes('Precision Cuts Daily'));
      assert.ok(!bText.includes('Fresh Bread'), "B's thread holds nothing of A's site");
      const cross = await req('POST', '/api/v1/portal/site/agent-chat', {
        cookie: cookieB,
        body: { message: 'use this', attachmentIds: [upImg.json.data.id] },
      });
      assert.equal(cross.status, 400, "A's attachment is refused from B's session");
      assert.equal(cross.json.code, 'INVALID');
      n += 8;
    } finally {
      child.kill('SIGKILL');
      await closed.catch(() => {});
      stub.close();
    }
    group('Part 3 — HTTP: streaming, doctrine, attachments, cap, isolation', n);
  }

  // ---------------------------------------------------------------
  // Part 4 — real Chromium, stub API: streamed markdown in the
  // live bubble; composer parity; the panel contract intact
  // ---------------------------------------------------------------
  if (process.env.B174_SKIP_BROWSER === '1') {
    console.log('  skip Part 4 browser (B174_SKIP_BROWSER=1 — local iteration only)');
  } else {
    let n = 0;
    const puppeteer = require('puppeteer');
    const express = require('express');
    const HISTORY = Array.from({ length: 30 }, (_, i) => ({
      id: 2000 + i,
      role: i % 2 ? 'assistant' : 'user',
      content: `Saved message ${i + 1} about the bakery site design and colours.`,
    }));
    const app = express();
    app.use(express.json());
    app.get('/api/v1/captcha/config', (_q, r) => r.json({ ok: true, data: { enabled: false } }));
    app.get('/api/v1/portal/me', (_q, r) =>
      r.json({
        ok: true,
        data: {
          client: { id: 1, email: 'owner@b174.fixture', businessName: 'ZZ B174 Bakery' },
          lead: { business_name: 'ZZ B174 Bakery', city: 'Blandon', state: 'PA' },
          site: { id: 1, name: 'ZZ B174 Bakery' },
          previewUrl: null,
        },
      })
    );
    app.get('/api/v1/portal/site/agent-chat/history', (_q, r) =>
      r.json({ ok: true, data: { messages: HISTORY, chatUsage: null, queue: null, summary: null } })
    );
    app.get('/api/v1/portal/site/agent-chat/updates', (_q, r) => r.json({ ok: true, data: { messages: [], queue: null } }));
    app.post('/api/v1/portal/site/agent-chat/stream', (_q, r) => {
      r.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      r.write('event: status\ndata: {"text":"Updating your site…"}\n\n');
      setTimeout(() => {
        r.write('event: delta\ndata: {"text":"**Done** — "}\n\n');
        setTimeout(() => {
          r.write('event: delta\ndata: {"text":"palette updated."}\n\n');
          r.write('event: done\ndata: {"reply":"**Done** — palette updated.","mutated":false}\n\n');
          r.end();
        }, 60);
      }, 60);
    });
    app.use('/api/v1/portal', (_q, r) =>
      r.json({ ok: true, data: { plan: 'standard', plans: [], forms: [], modules: [], contacts: [], accounts: [], previewUrl: null } })
    );
    app.get('/portal', (_q, r) => r.sendFile(path.join(root, 'public', 'portal.html')));
    app.use(express.static(path.join(root, 'public'), { index: false }));
    const stubServer = http.createServer(app);
    await new Promise((r) => stubServer.listen(0, '127.0.0.1', r));
    const stubBase = `http://127.0.0.1:${stubServer.address().port}`;
    const browser = await puppeteer.launch({
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    try {
      for (const w of [1440, 390]) {
        const page = await browser.newPage();
        await page.setViewport({ width: w, height: 900 });
        await page.goto(stubBase + '/portal#/website', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForSelector('#sec-preview:not([hidden])', { timeout: 15000 });
        await page.waitForFunction(() => document.querySelectorAll('#agent-chat-messages .agent-bubble').length === 30, { timeout: 15000 });
        const before = await page.evaluate(() => {
          const list = document.getElementById('agent-chat-messages');
          const panel = document.getElementById('agent-chat');
          const file = document.getElementById('agent-chat-file');
          const camFile = document.getElementById('agent-chat-camera-file');
          return {
            panelH: Math.round(panel.getBoundingClientRect().height),
            listClientH: list.clientHeight,
            listScrollH: list.scrollHeight,
            accept: file.getAttribute('accept'),
            hasCameraBtn: !!document.getElementById('agent-chat-camera'),
            camAccept: camFile.getAttribute('accept'),
            camCapture: camFile.getAttribute('capture'),
            historyMd: !!document.querySelector('#agent-chat-messages .agent-bubble.assistant .md-body'),
          };
        });
        assert.equal(before.accept, 'image/png,image/jpeg,image/webp,image/gif,video/mp4,video/quicktime,video/webm,application/pdf,.txt,.md,.csv,.json', `@${w}: accept list matches the Assistant composer`);
        assert.ok(before.hasCameraBtn, `@${w}: Camera button present`);
        assert.equal(before.camAccept, 'image/*,video/*', `@${w}: camera input accepts photo + video`);
        assert.equal(before.camCapture, 'environment', `@${w}: camera input captures`);
        assert.ok(before.listScrollH > before.listClientH, `@${w}: message list scrolls internally`);
        assert.ok(before.historyMd, `@${w}: history replies render in .md-body`);
        n += 6;

        await page.type('#agent-chat-input', 'Make it teal');
        await page.click('#agent-chat-send');
        await page.waitForFunction(
          () => {
            const bodies = document.querySelectorAll('#agent-chat-messages .agent-bubble.assistant .md-body');
            const last = bodies[bodies.length - 1];
            return last && last.querySelector('strong') && last.textContent.includes('palette updated.');
          },
          { timeout: 15000 }
        );
        const after = await page.evaluate(() => {
          const panel = document.getElementById('agent-chat');
          const bodies = document.querySelectorAll('#agent-chat-messages .agent-bubble.assistant .md-body');
          const last = bodies[bodies.length - 1];
          return {
            panelH: Math.round(panel.getBoundingClientRect().height),
            bubbles: document.querySelectorAll('#agent-chat-messages .agent-bubble').length,
            strongText: last.querySelector('strong').textContent,
            rawMd: last.textContent.includes('**'),
          };
        });
        assert.equal(after.bubbles, 32, `@${w}: user + assistant bubbles appended`);
        assert.equal(after.strongText, 'Done', `@${w}: streamed markdown rendered as HTML`);
        assert.ok(!after.rawMd, `@${w}: no raw markdown markers left visible`);
        assert.ok(Math.abs(after.panelH - before.panelH) <= 2, `@${w}: panel height fixed across the turn`);
        n += 4;
        await page.close();
      }
    } finally {
      await browser.close();
      stubServer.close();
    }
    group('Part 4 — browser: streaming render, composer, panel', n);
  }

  console.log(`BATCH174 SUITE: ${groups.length} groups — ALL PASS`);
  console.log(JSON.stringify({ passed: true, groups }));
})().catch((e) => {
  console.error('BATCH174 SUITE FAIL:', e);
  process.exitCode = 1;
});
