'use strict';
/**
 * Batch 161 — Assistant chat (portal + staff) with metered billing.
 *
 * Ely's order: an "Assistant" link BEFORE Dashboard in both the
 * client portal and the staff app, opening a full-page chat with
 * attachments (files / images / video / camera). Usage is metered
 * per call from an admin-editable price table and billed to portal
 * clients SEPARATELY at raw cost + margin (ai.assistant.margin_pct,
 * seeded 20, admin-adjustable; changes apply to future calls only).
 * Staff usage is recorded at raw cost, margin 0, never billed.
 *
 * Part 1 — source pins: nav order on both surfaces (Assistant
 *   immediately before Dashboard / Website-home), portal tab
 *   factory (owners + partners get it, renters do not), routing row.
 * Part 2 — service level (in-process, model stubbed at
 *   global.fetch): failover, metering math at margin 20 and after a
 *   margin change, custom price-table rates, staff rows unbilled,
 *   actor + workspace isolation, attachment validation (type /
 *   spoof / size / video stored), vision parts reaching the model,
 *   monthly soft cap, billing rollup (one row per workspace-month,
 *   frozen once queued, accrued with reason when no Stripe
 *   customer).
 * Part 3 — HTTP over the real server: anonymous refusals, portal +
 *   staff conversation CRUD, cross-user isolation 404s, attachment
 *   upload + owner-only download, SSE turn plumbing, the Admin
 *   settings round-trip (margin editable), usage views, rollup
 *   endpoints.
 */
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'batch161-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
if (process.env.DB_DRIVER === 'sqlite') {
  process.env.SQLITE_PATH = path.join(tmpRoot, 'platform.db');
  process.env.PLATFORM_DB_PATH = path.join(tmpRoot, 'platform.db');
}
process.env.WORKSPACE_DATA_DIR = path.join(tmpRoot, 'workspaces');
process.env.EXPORT_ROOT = path.join(tmpRoot, 'exports');
process.env.APP_URL = 'https://example.invalid';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env.SESSION_SECRET = ['batch161', 'regression', 'secret'].join('-');
process.env.BOOTSTRAP_EMAIL = 'root161@example.invalid';
process.env.BOOTSTRAP_PASSWORD = ['Root', '161', 'Pass'].join('-');
process.env.BOOTSTRAP_WORKSPACE = 'B161 Fixture';
process.env.BOOTSTRAP_SUPER_ADMIN = '1';
process.env.MAIL_DRY_RUN = 'true';
process.env.STRIPE_SECRET_KEY = '';
delete process.env.HTTPS_PROXY;
delete process.env.HTTP_PROXY;
delete process.env.https_proxy;
delete process.env.http_proxy;

const PORT = 3461;
const BASE = `http://127.0.0.1:${PORT}`;
const results = [];
function group(name, count) {
  results.push(`${name}: ${count} checks`);
  console.log(`  ok ${name} (${count})`);
}
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

function makeJar() {
  const cookies = new Map();
  return {
    async fetch(url, opts = {}) {
      const headers = { 'x-forwarded-proto': 'https', ...(opts.headers || {}) };
      if (cookies.size) headers.cookie = [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
      if (opts.body && !headers['content-type']) headers['content-type'] = 'application/json';
      const res = await fetch(url, { ...opts, headers, redirect: 'manual' });
      const set = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
      for (const c of set) {
        const pair = String(c).split(';')[0];
        const i = pair.indexOf('=');
        if (i > 0) cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
      }
      return res;
    },
  };
}
async function json(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);
const MP4_HEAD = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(64, 7)]);

async function main() {
  /* ================================================================
   * Part 1 — source pins: nav order, tab factory, routing row.
   * ================================================================ */
  {
    let n = 0;
    const portalHtml = read('public/portal.html');
    const idxAssistant = portalHtml.indexOf('id="nav-assistant"');
    const idxWebsite = portalHtml.indexOf('id="nav-website"');
    assert.ok(idxAssistant > -1 && idxWebsite > -1 && idxAssistant < idxWebsite, 'portal nav: Assistant button renders before the Website (home) button');
    n++;
    assert.ok(portalHtml.includes('id="sec-assistant"'), 'portal has the Assistant panel section');
    assert.ok(portalHtml.includes('capture="environment"'), 'portal composer has a camera capture input');
    n += 2;

    const indexHtml = read('public/index.html');
    const sAssistant = indexHtml.indexOf('data-route="assistant"');
    const sDashboard = indexHtml.indexOf('data-route="dashboard"');
    assert.ok(sAssistant > -1 && sDashboard > -1 && sAssistant < sDashboard, 'staff sidebar: Assistant anchor immediately before Dashboard');
    n++;

    const navGroups = require(path.join(root, 'public/js/navGroups.js'));
    assert.deepEqual(navGroups.NAV_TOP_LEVEL, ['assistant', 'dashboard', 'leads', 'websites', 'fingerprints'], 'NAV_TOP_LEVEL leads with assistant');
    assert.equal(navGroups.navGroupForRoute('assistant'), null, 'assistant is top-level (joins the same nav mechanics incl. the mobile dropdown)');
    n += 2;

    const portalJs = read('public/js/portal.js');
    const panelsAt = portalJs.indexOf('const PORTAL_PANELS');
    assert.ok(portalJs.slice(panelsAt, panelsAt + 80).includes("'assistant',"), 'portal.js PORTAL_PANELS leads with assistant');
    n++;

    const tabs = require(path.join(root, 'server/portalTabs.js'));
    assert.equal(tabs.PORTAL_TABS[0], 'assistant', 'PORTAL_TABS[0] is assistant');
    assert.equal(tabs.TAB_LABELS.assistant, 'Assistant', 'tab label is Assistant');
    assert.ok(tabs.effectiveTabs('owner', null).includes('assistant'), 'owners get the assistant tab');
    assert.ok(tabs.effectiveTabs('partner', null).includes('assistant'), 'partners get the assistant tab');
    assert.ok(!tabs.effectiveTabs('renter', null).includes('assistant'), 'renters do NOT get the assistant tab (explicit factory list, soul/gbp precedent)');
    n += 5;

    const appJs = read('public/js/app.js');
    assert.ok(appJs.includes("assistant: 'Assistant'"), 'staff ROUTE_LABELS has Assistant');
    assert.ok(appJs.includes('assistant: pageAssistant'), 'staff PAGES maps the assistant route');
    n += 2;

    const aiRouting = require(path.join(root, 'server/aiRouting.js'));
    const row = aiRouting.ROUTABLE_FUNCTIONS.find((f) => f.key === 'assistant_chat');
    assert.ok(row, 'routing matrix has the assistant_chat row');
    assert.equal(row.kind, 'agent', 'assistant_chat is an agent row');
    assert.equal(row.defaultPrimary, 'muse', 'assistant_chat default primary muse');
    assert.equal(row.defaultFallback, 'openai', 'assistant_chat default fallback openai');
    const v = aiRouting.validateRoutesPayload({ assistant_chat: { primary: 'openai', fallback: 'openrouter' } });
    assert.ok(v && v['ai.route.assistant_chat.primary'] === 'openai', 'routing payload validation accepts assistant_chat');
    assert.throws(() => aiRouting.validateRoutesPayload({ assistant_chat: { primary: 'openai', fallback: 'openai' } }), /cannot be the same/, 'self-failover refused for the new row too');
    n += 5;
    group('Part 1 — nav order, tab factory, routing row', n);
  }

  /* ================================================================
   * Fixtures shared by Parts 2 + 3.
   * ================================================================ */
  const { openWorkspaceDb } = require(path.join(root, 'server/workspaceDb.js'));
  const wdb = openWorkspaceDb(1);
  wdb.prepare('INSERT INTO leads (id, business_name, email, status) VALUES (501, ?, ?, ?)').run('Fixture Plants LLC', 'owner161@example.invalid', 'customer');
  wdb.prepare('INSERT INTO leads (id, business_name, email, status) VALUES (777, ?, ?, ?)').run('Second Biz', 'second161@example.invalid', 'customer');
  wdb.prepare('INSERT INTO websites (lead_id, name, theme, pages, status) VALUES (501, ?, ?, ?, ?)').run('Fixture Site', '{}', '[]', 'draft');

  const platformDb = require(path.join(root, 'server/db.js'));
  await platformDb.migrate();
  const platform = require(path.join(root, 'server/platform.js'));
  await platform.setPlatformSetting('muse.model_api_key', 'b161-stub-muse-key');
  await platform.setPlatformSetting('ai.api_key', 'b161-stub-openai-key');

  const assistant = require(path.join(root, 'server/assistantChat.js'));
  const billing = require(path.join(root, 'server/assistantBilling.js'));

  /* ================================================================
   * Part 2 — service level with the model stubbed at global.fetch.
   * ================================================================ */
  {
    let n = 0;
    // ---- settings + price table units ----
    const def = await assistant.getAssistantSettings();
    assert.equal(def.marginPct, 20, 'margin seeds at 20 (Ely\u2019s figure)');
    assert.equal(def.monthlyCapUsd, null, 'monthly cap defaults off');
    n += 2;
    assert.equal(assistant.rateFor(def.priceTable, 'openai', 'gpt-x').promptPer1k, 0.0015, 'rateFor falls to default');
    const custom = assistant.parsePriceTable(
      JSON.stringify({
        default: { promptPer1k: 0.0015, completionPer1k: 0.002 },
        'openai|gpt-x': { promptPer1k: 0.01, completionPer1k: 0.03 },
        'openai|*': { promptPer1k: 0.005, completionPer1k: 0.006 },
        'gpt-y': { promptPer1k: 0.007, completionPer1k: 0.008 },
      })
    );
    assert.equal(assistant.rateFor(custom, 'openai', 'gpt-x').promptPer1k, 0.01, 'rateFor exact provider|model wins');
    assert.equal(assistant.rateFor(custom, 'openai', 'gpt-z').promptPer1k, 0.005, 'rateFor provider wildcard next');
    assert.equal(assistant.rateFor(custom, 'muse', 'gpt-y').promptPer1k, 0.007, 'rateFor bare model next');
    assert.throws(() => assistant.parsePriceTable('{"x":1}'), (e) => e.code === 'VALIDATION', 'malformed price table entry is refused');
    assert.throws(
      () => assistant.parsePriceTable('{"openai|gpt-x":{"promptPer1k":0.01,"completionPer1k":0.03}}'),
      /needs a "default" entry/,
      'price table without a default entry is refused'
    );
    await assert.rejects(assistant.validateAssistantSettings({ marginPct: '2000' }), /between 0 and 1000/, 'margin above 1000 refused');
    n += 6;

    // ---- stub provider plumbing ----
    const realFetch = global.fetch;
    let stubMode = 'failover';
    let lastRequestBody = null;
    let fetchCalls = 0;
    global.fetch = async (url, opts) => {
      const u = String(url || '');
      if (!u.includes('/chat/completions')) return realFetch(url, opts);
      fetchCalls++;
      lastRequestBody = JSON.parse(String((opts && opts.body) || '{}'));
      const reply = (model) =>
        new Response(
          JSON.stringify({
            model,
            choices: [{ message: { content: `Stub reply from ${model}.` } }],
            usage: { prompt_tokens: 2000, completion_tokens: 1000 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      if (u.includes('api.meta.ai')) {
        if (stubMode === 'failover')
          return new Response(JSON.stringify({ error: { message: 'invalid key' } }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          });
        return reply('muse-stub-1');
      }
      if (u.includes('api.openai.com')) return reply('gpt-stub-1');
      return realFetch(url, opts);
    };

    try {
      // ---- conversation CRUD + actor isolation ----
      const convA = await assistant.createConversation(wdb, { surface: 'portal', actorId: 11, leadId: 501, title: '' });
      const convB = await assistant.createConversation(wdb, { surface: 'portal', actorId: 22, leadId: 777, title: '' });
      assert.ok(convA.id && convB.id, 'conversations created');
      assert.equal(await assistant.getConversation(wdb, { surface: 'portal', actorId: 22, id: convA.id }), null, 'actor B cannot read actor A\u2019s conversation');
      assert.equal((await assistant.listConversations(wdb, { surface: 'portal', actorId: 11 })).length, 1, 'list is actor-scoped');
      n += 3;

      // ---- failover: muse 401 -> openai serves, row records it ----
      const turn1 = await assistant.runAssistantTurn({
        workspaceId: 1,
        surface: 'portal',
        actorId: 11,
        conversationId: convA.id,
        message: 'Hello assistant',
        attachmentIds: [],
      });
      assert.ok(turn1.ok && !turn1.capped, 'turn ran (not capped)');
      assert.ok(/Stub reply from gpt-stub-1/.test(turn1.reply), 'fallback provider served the turn');
      let rows = wdb.prepare("SELECT * FROM ai_usage WHERE task = 'assistant_chat' ORDER BY id").all();
      assert.equal(rows.length, 1, 'one usage row for the turn');
      const r1 = rows[0];
      assert.equal(r1.provider, 'openai', 'row records the provider that actually served');
      assert.ok(r1.model, 'row records the served model (the serving config\u2019s model)');
      const servedModel = r1.model;
      assert.equal(r1.surface, 'portal', 'row records the surface');
      assert.equal(r1.actor_user_id, 11, 'row records the actor');
      assert.equal(r1.conversation_id, convA.id, 'row records the conversation');
      assert.ok(Math.abs(r1.raw_cost_usd - 0.005) < 1e-9, 'raw cost from the price table (2k prompt + 1k completion at seed rates)');
      assert.equal(r1.margin_pct, 20, 'row stores the margin applied (20)');
      assert.ok(Math.abs(r1.billed_usd - 0.006) < 1e-9, 'billed = raw x 1.20');
      assert.ok(/HTTP 401/.test(String(r1.note || '')), 'the failover reason (primary HTTP 401) is noted on the row');
      n += 12;

      // ---- deterministic primary for the remaining turns ----
      await platform.setPlatformSetting('ai.route.assistant_chat.primary', 'openai');
      await platform.setPlatformSetting('ai.route.assistant_chat.fallback', 'none');
      stubMode = 'ok';

      // ---- margin change affects future rows only ----
      const turn2 = await assistant.runAssistantTurn({
        workspaceId: 1,
        surface: 'portal',
        actorId: 11,
        conversationId: convA.id,
        message: 'Second message',
        attachmentIds: [],
      });
      assert.ok(turn2.reply, 'second turn replies');
      await platform.setPlatformSetting('ai.assistant.margin_pct', '50');
      await assistant.runAssistantTurn({
        workspaceId: 1,
        surface: 'portal',
        actorId: 11,
        conversationId: convA.id,
        message: 'Third message',
        attachmentIds: [],
      });
      rows = wdb.prepare("SELECT * FROM ai_usage WHERE task = 'assistant_chat' ORDER BY id").all();
      assert.equal(rows.length, 3, 'three turns, three rows');
      assert.ok(Math.abs(rows[1].billed_usd - 0.006) < 1e-9 && rows[1].margin_pct === 20, 'row at the old margin is unchanged after the margin edit');
      assert.equal(rows[2].margin_pct, 50, 'new row stores the new margin');
      assert.ok(Math.abs(rows[2].billed_usd - 0.0075) < 1e-9, 'new billed = raw x 1.50');
      n += 5;
      await platform.setPlatformSetting('ai.assistant.margin_pct', '20');

      // ---- custom price table drives raw cost ----
      await platform.setPlatformSetting(
        'ai.assistant.price_table',
        JSON.stringify({ default: { promptPer1k: 0.0015, completionPer1k: 0.002 }, [`openai|${servedModel}`]: { promptPer1k: 0.01, completionPer1k: 0.03 } })
      );
      await assistant.runAssistantTurn({
        workspaceId: 1,
        surface: 'portal',
        actorId: 11,
        conversationId: convA.id,
        message: 'Priced message',
        attachmentIds: [],
      });
      rows = wdb.prepare("SELECT * FROM ai_usage WHERE task = 'assistant_chat' ORDER BY id").all();
      assert.ok(Math.abs(rows[3].raw_cost_usd - 0.05) < 1e-9, 'raw cost uses the admin-edited per-model rate');
      n += 1;
      await platform.setPlatformSetting('ai.assistant.price_table', '');

      // ---- staff rows: raw recorded, margin 0, never billed ----
      const convStaff = await assistant.createConversation(wdb, { surface: 'admin', actorId: 5, leadId: 501, title: '' });
      await assistant.runAssistantTurn({
        workspaceId: 1,
        surface: 'admin',
        actorId: 5,
        conversationId: convStaff.id,
        message: 'Staff question',
        attachmentIds: [],
      });
      rows = wdb.prepare("SELECT * FROM ai_usage WHERE task = 'assistant_chat' AND surface = 'admin'").all();
      assert.equal(rows.length, 1, 'staff turn recorded');
      assert.equal(rows[0].margin_pct, 0, 'staff margin 0');
      assert.equal(rows[0].billed_usd, 0, 'staff billed 0 (internal cost only)');
      assert.ok(rows[0].raw_cost_usd > 0, 'staff raw cost still recorded');
      n += 4;

      // ---- attachments: validation + storage + vision parts ----
      // (saveAttachment sniffs the BYTES — the claimed name/mime is
      // never trusted — and returns the public attachment shape.)
      const img = assistant.saveAttachment(wdb, {
        surface: 'portal',
        actorId: 11,
        workspaceId: 1,
        conversationId: convA.id,
        originalName: 'leaf.png',
        buffer: PNG_1PX,
      });
      assert.equal(img.kind, 'image', 'real PNG accepted as image');
      assert.throws(
        () => assistant.saveAttachment(wdb, { surface: 'portal', actorId: 11, workspaceId: 1, originalName: 'fake.png', buffer: Buffer.from('not an image') }),
        /not supported/,
        'spoofed image bytes refused'
      );
      assert.throws(
        () => assistant.saveAttachment(wdb, { surface: 'portal', actorId: 11, workspaceId: 1, originalName: 'tool.exe', buffer: Buffer.from([0x4d, 0x5a, 1, 2]) }),
        /not supported/,
        'executable refused'
      );
      const vid = assistant.saveAttachment(wdb, {
        surface: 'portal',
        actorId: 11,
        workspaceId: 1,
        conversationId: convA.id,
        originalName: 'tour.mp4',
        buffer: MP4_HEAD,
      });
      assert.equal(vid.kind, 'video', 'mp4 stored as a video attachment');
      assert.throws(
        () =>
          assistant.saveAttachment(wdb, {
            surface: 'portal',
            actorId: 11,
            workspaceId: 1,
            originalName: 'big.mp4',
            // Valid ftyp header + padding past the cap: the sniff
            // passes, the SIZE check is what refuses it.
            buffer: Buffer.concat([MP4_HEAD, Buffer.alloc(assistant.MAX_VIDEO_BYTES + 1 - MP4_HEAD.length, 1)]),
          }),
        /too large/,
        'oversize video refused at the 50 MB cap'
      );
      const txt = assistant.saveAttachment(wdb, {
        surface: 'portal',
        actorId: 11,
        workspaceId: 1,
        conversationId: convA.id,
        originalName: 'notes.txt',
        buffer: Buffer.from('Water the ferns twice a week.'),
      });
      assert.equal(txt.kind, 'file', 'text file accepted');
      assert.equal(txt.mime, 'text/plain', 'text file mime sniffed');
      n += 7;

      lastRequestBody = null;
      await assistant.runAssistantTurn({
        workspaceId: 1,
        surface: 'portal',
        actorId: 11,
        conversationId: convA.id,
        message: 'What is in this picture and these notes?',
        attachmentIds: [img.id, txt.id, vid.id],
      });
      const flat = JSON.stringify(lastRequestBody && lastRequestBody.messages ? lastRequestBody.messages : []);
      assert.ok(flat.includes('image_url'), 'image attachment reaches the model as an image part');
      assert.ok(flat.includes('Water the ferns'), 'text attachment content is inlined for the model');
      assert.ok(flat.includes('tour.mp4'), 'video is referenced by name/metadata (no frame extraction in the runtime image)');
      n += 3;

      // ---- monthly soft cap refuses BEFORE any model call ----
      const month = new Date().toISOString().slice(0, 7);
      const billedSoFar = assistant.monthBilledUsd(wdb, { surface: 'portal', month }).billedUsd;
      assert.ok(billedSoFar > 0, 'month billed total accumulates');
      await platform.setPlatformSetting('ai.assistant.monthly_cap_usd', '0.01');
      const callsBefore = fetchCalls;
      const capped = await assistant.runAssistantTurn({
        workspaceId: 1,
        surface: 'portal',
        actorId: 11,
        conversationId: convA.id,
        message: 'One more',
        attachmentIds: [],
      });
      assert.equal(capped.capped, true, 'cap reached -> turn refused with capped flag');
      assert.equal(fetchCalls, callsBefore, 'capped turn makes NO provider call');
      n += 3;
      await platform.setPlatformSetting('ai.assistant.monthly_cap_usd', '');

      // ---- usage summary separates portal billed vs staff internal ----
      const summary = assistant.usageSummary(wdb, { month });
      assert.ok(summary.portal.billedUsd > 0 && summary.portal.rawUsd > 0, 'summary: portal raw + billed present');
      assert.ok(summary.admin.rawUsd > 0 && summary.admin.billedUsd === 0, 'summary: staff raw present, billed zero');
      n += 2;

      // ---- billing rollup: one row per workspace-month, frozen ----
      const roll1 = await billing.computeRollup(wdb, month);
      assert.ok(roll1.billedUsd > 0, 'rollup sums the month billed total');
      assert.equal(roll1.status, 'accrued', 'rollup starts accrued');
      const queued = await billing.queueRollupForInvoice(1, month);
      assert.equal(queued.queued, false, 'no Stripe customer -> nothing queued');
      assert.equal(queued.reason, 'no_stripe_customer', 'accrued reason recorded (no_stripe_customer)');
      // Freeze semantics: once a rollup is queued it never re-sums,
      // even if late usage rows land in the month afterwards.
      wdb.prepare("UPDATE assistant_usage_rollups SET status = 'queued' WHERE month = ?").run(month);
      wdb.prepare("INSERT INTO ai_usage (task, provider, model, prompt_tokens, completion_tokens, cost_usd, surface, billed_usd) VALUES ('assistant_chat', 'openai', 'gpt-stub-1', 100, 100, 1, 'portal', 99)").run();
      const roll2 = await billing.computeRollup(wdb, month);
      assert.equal(roll2.billedUsd, roll1.billedUsd, 'a queued rollup never re-sums (frozen totals)');
      assert.equal(roll2.frozen, true, 'computeRollup reports the frozen state');
      const again = await billing.queueRollupForInvoice(1, month);
      assert.equal(again.already, true, 'double-queue is refused (already queued)');
      // Fixture reset for Part 3: back to accrued so the HTTP queue
      // leg exercises the no-customer path again.
      wdb.prepare("UPDATE assistant_usage_rollups SET status = 'accrued' WHERE month = ?").run(month);
      n += 7;
    } finally {
      global.fetch = realFetch;
    }
    group('Part 2 — failover, metering, isolation, attachments, cap, rollup', n);
  }

  /* ================================================================
   * Part 3 — HTTP over the real server.
   * ================================================================ */
  {
    let n = 0;
    const bcrypt = require('bcryptjs');
    const db = require(path.join(root, 'server/db.js'));
    const portalHash = bcrypt.hashSync(['Portal', '161', 'Pass'].join('-'), 12);
    if (db.driver() === 'mysql') {
      await db.query('INSERT INTO client_portal_users (email, password_hash, workspace_id, lead_id, business_name, status) VALUES (:e, :h, 1, 501, :b, :s)', {
        e: 'owner161@example.invalid',
        h: portalHash,
        b: 'Fixture Plants LLC',
        s: 'active',
      });
      await db.query('INSERT INTO client_portal_users (email, password_hash, workspace_id, lead_id, business_name, status) VALUES (:e, :h, 1, 777, :b, :s)', {
        e: 'second161@example.invalid',
        h: portalHash,
        b: 'Second Biz',
        s: 'active',
      });
    } else {
      const RawDb = require('better-sqlite3');
      const raw = new RawDb(process.env.SQLITE_PATH);
      raw
        .prepare('INSERT INTO client_portal_users (email, password_hash, workspace_id, lead_id, business_name, status) VALUES (?, ?, 1, 501, ?, ?)')
        .run('owner161@example.invalid', portalHash, 'Fixture Plants LLC', 'active');
      raw
        .prepare('INSERT INTO client_portal_users (email, password_hash, workspace_id, lead_id, business_name, status) VALUES (?, ?, 1, 777, ?, ?)')
        .run('second161@example.invalid', portalHash, 'Second Biz', 'active');
      raw.close();
    }

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
          const r = await fetch(`${BASE}/api/v1/health`, { signal: AbortSignal.timeout(500) });
          if (r.ok) ready = true;
        } catch {}
        if (!ready) await new Promise((r) => setTimeout(r, 200));
      }
      assert(ready, 'server did not become ready: ' + output);

      const anon = makeJar();
      let res = await anon.fetch(`${BASE}/api/v1/assistant/conversations`);
      assert.ok(res.status === 401 || res.status === 403, 'staff assistant refuses anonymous');
      res = await anon.fetch(`${BASE}/api/v1/portal/assistant/conversations`);
      assert.ok(res.status === 401 || res.status === 403, 'portal assistant refuses anonymous');
      n += 2;

      // ---- staff sign-in (+ forced MFA enrollment) ----
      const totp = require(path.join(root, 'src/totp.js'));
      const staffJar = makeJar();
      const post = (jar, p, body) => jar.fetch(BASE + p, { method: 'POST', body: JSON.stringify(body || {}) });
      const get = (jar, p) => jar.fetch(BASE + p);
      res = await post(staffJar, '/api/v1/auth/login', {
        email: process.env.BOOTSTRAP_EMAIL,
        password: ['Root', '161', 'Pass'].join('-'),
      });
      let loginBody = await json(res);
      assert.equal(res.status, 200, `staff login 200 (got ${res.status}: ${JSON.stringify(loginBody).slice(0, 200)})`);
      if (loginBody.data && loginBody.data.mfaRequired) {
        if (loginBody.data.mfaStage === 'enroll') {
          const start = await json(await post(staffJar, '/api/v1/auth/mfa/enroll/start', {}));
          const done = await post(staffJar, '/api/v1/auth/mfa/enroll/confirm', { code: totp.totp(start.data.secret) });
          loginBody = await json(done);
        }
      }
      n += 1;

      // ---- staff conversation CRUD ----
      const created = await json(await post(staffJar, '/api/v1/assistant/conversations', { leadId: 501, title: 'Staff thread' }));
      assert.ok(created.data && created.data.id, 'staff conversation created');
      const staffConvId = created.data.id;
      const list = await json(await get(staffJar, '/api/v1/assistant/conversations'));
      assert.ok((list.data || []).some((c) => c.id === staffConvId), 'staff conversation listed');
      n += 2;

      // ---- portal sign-in + CRUD + cross-user isolation ----
      const portalJar = makeJar();
      res = await post(portalJar, '/api/v1/portal/login', { email: 'owner161@example.invalid', password: ['Portal', '161', 'Pass'].join('-') });
      assert.equal(res.status, 200, 'portal login 200');
      const pCreated = await json(await post(portalJar, '/api/v1/portal/assistant/conversations', {}));
      assert.ok(pCreated.data && pCreated.data.id, 'portal conversation created');
      const portalConvId = pCreated.data.id;
      n += 2;

      const portalJar2 = makeJar();
      res = await post(portalJar2, '/api/v1/portal/login', { email: 'second161@example.invalid', password: ['Portal', '161', 'Pass'].join('-') });
      assert.equal(res.status, 200, 'second portal login 200');
      res = await get(portalJar2, `/api/v1/portal/assistant/conversations/${portalConvId}`);
      assert.equal(res.status, 404, 'another portal user cannot read the conversation (404)');
      res = await get(staffJar, `/api/v1/assistant/conversations/${portalConvId}`);
      assert.equal(res.status, 404, 'portal conversation is not visible on the staff surface either (surface + actor scoping)');
      n += 3;

      // ---- attachment upload + owner-only download ----
      const up = await json(
        await post(portalJar, '/api/v1/portal/assistant/attachments', {
          data: `data:image/png;base64,${PNG_1PX.toString('base64')}`,
          name: 'leaf.png',
          conversationId: portalConvId,
        })
      );
      assert.ok(up.data && up.data.id, 'portal image upload accepted');
      const attId = up.data.id;
      res = await get(portalJar, `/api/v1/portal/assistant/attachments/${attId}`);
      assert.equal(res.status, 200, 'owner downloads own attachment');
      res = await get(portalJar2, `/api/v1/portal/assistant/attachments/${attId}`);
      assert.equal(res.status, 404, 'other portal user cannot download the attachment');
      const badUp = await post(portalJar, '/api/v1/portal/assistant/attachments', {
        data: `data:image/png;base64,${Buffer.from('MZ not an image').toString('base64')}`,
        name: 'fake.png',
      });
      assert.equal(badUp.status, 400, 'spoofed upload refused over HTTP (house fail() maps the INVALID_FILE code to 400)');
      n += 4;

      // ---- SSE turn plumbing (provider keys are stubs: the turn
      // ends in an error event, but the stream + persistence are
      // what this leg proves; Part 2 proves successful turns) ----
      res = await post(portalJar, `/api/v1/portal/assistant/conversations/${portalConvId}/messages`, { message: 'Hello over HTTP', attachmentIds: [attId] });
      const ctype = res.headers.get('content-type') || '';
      const sseText = await res.text();
      assert.ok(ctype.includes('text/event-stream'), 'message POST streams SSE');
      assert.ok(/event: (done|error)/.test(sseText), 'SSE stream terminates with done or error');
      const thread = await json(await get(portalJar, `/api/v1/portal/assistant/conversations/${portalConvId}`));
      assert.ok((thread.data.messages || []).some((m) => m.role === 'user' && m.content === 'Hello over HTTP'), 'user turn persisted via HTTP');
      n += 3;

      // ---- usage views ----
      const usage = await json(await get(portalJar, '/api/v1/portal/assistant/usage'));
      assert.ok(usage.data && usage.data.portal && typeof usage.data.portal.billedUsd === 'number', 'portal usage view returns billed totals');
      const staffUsage = await json(await get(staffJar, '/api/v1/assistant/usage'));
      assert.ok(staffUsage.data && staffUsage.data.admin && staffUsage.data.portal, 'staff usage view separates admin (internal) from portal (billed)');
      n += 2;

      // ---- Admin settings round-trip: margin editable ----
      const settings = await json(await get(staffJar, '/api/v1/admin/settings/ai-assistant'));
      assert.ok(settings.data && settings.data.marginPct === 20, 'admin reads margin 20');
      const put = (jar, p, body) => jar.fetch(BASE + p, { method: 'PUT', body: JSON.stringify(body || {}) });
      res = await put(staffJar, '/api/v1/admin/settings/ai-assistant', { marginPct: 25 });
      assert.equal(res.status, 200, 'admin saves a new margin');
      const settings2 = await json(await get(staffJar, '/api/v1/admin/settings/ai-assistant'));
      assert.equal(settings2.data.marginPct, 25, 'margin now 25');
      res = await put(staffJar, '/api/v1/admin/settings/ai-assistant', { marginPct: 20 });
      assert.equal(res.status, 200, 'margin restored to 20');
      const overview = await json(await get(staffJar, '/api/v1/admin/settings/ai-assistant/usage'));
      assert.ok(overview.data && Array.isArray(overview.data.rows) && overview.data.totals, 'admin cross-workspace usage overview renders (rows + totals)');
      n += 5;

      // ---- rollup endpoints ----
      const month = new Date().toISOString().slice(0, 7);
      const roll = await json(await post(staffJar, '/api/v1/assistant/usage/rollup', { month }));
      assert.ok(roll.data && typeof roll.data.billedUsd === 'number', 'rollup endpoint computes the month');
      const queue = await json(await post(staffJar, '/api/v1/assistant/usage/queue', { month }));
      assert.ok(queue.data && queue.data.queued === false && queue.data.reason === 'no_stripe_customer', 'queue reports accrued/no_stripe_customer honestly');
      n += 2;
    } finally {
      child.kill('SIGKILL');
      await closed;
    }
    group('Part 3 — HTTP: auth, CRUD, isolation, SSE, settings, rollup', n);
  }

  console.log(`BATCH161 SUITE: ${results.length} groups — ALL PASS`);
  for (const r of results) console.log('  ' + r);
}

main().then(
  () => {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {}
    process.exit(0);
  },
  (err) => {
    console.error('BATCH161 SUITE FAILED:', err && err.stack ? err.stack : err);
    process.exit(1);
  }
);
