'use strict';
/**
 * Batch 89 — image attachments for the website designing chat
 * (Ely 2026-10-30: "Add a file attachment functionality to the website
 * designing chat. So the image can be used for analysis. And
 * improvements. During the design process.").
 *
 * SURFACE: the client portal Website editor's agent chat
 * ("Improve with AI", public/portal.html #agent-chat) — the chat where a
 * design is discussed and iterated: POST /api/v1/portal/site/agent-chat
 * → clientPortal.runSiteAgentChat → museAgent.runPortalImproveLoop (the
 * AI design loop that edits the site and republishes the preview).
 *
 * WHAT'S PROVEN HERE:
 *   A. Engine (server/siteChatAttachments.js): upload happy path (file
 *      lands under EXPORT_ROOT/site-chat/ws-<ws>/lead-<lead>/ with a
 *      server-generated name, DB record correct, thumbnail generated),
 *      magic-byte validation matrix (fake image rejected, SVG rejected,
 *      oversize rejected, declared name sanitized), per-lead scoping,
 *      turn linkage, model-image building, and the lead-delete sweep
 *      (rows dropped + files unlinked by leadEngine.deleteLead).
 *   B. AI loop (museAgent.runPortalImproveLoop, VM fixture): attached
 *      images ride the final user message as vision parts; when the
 *      model endpoint rejects them the turn retries text-only and the
 *      result honestly reports imagesDropped; image-only turns work;
 *      text-only turns are byte-for-byte the old shape.
 *   C. clientPortal.runSiteAgentChat (VM slice): image-only + mixed
 *      turns reach the loop with model images; another lead's
 *      attachment id is rejected; empty-with-nothing stays EMPTY.
 *   D. HTTP (real server booted on temp dirs): portal session upload →
 *      fetch byte-identical with safe headers; thumbnail variant;
 *      unauthenticated 401; OTHER WORKSPACE session 404 on fetch and
 *      400 on chat-use; fake/SVG uploads 400; agent-chat image-only
 *      passes validation (403 AI_NOT_CONFIGURED in this keyless env,
 *      never EMPTY); upload rate limit fires (429).
 *   E. MCP design-context surface: site.chatAttachments lists and
 *      site.chatAttachment returns base64 for the workspace's lead;
 *      wrong lead / wrong workspace → NOT_FOUND.
 *   F. Source pins for the portal UI (attach control, pending chips,
 *      attachmentIds in the send body, thumbnails in bubbles).
 *
 * NEGATIVE PROOF: B89_NEGATIVE=workspace shims the scoping predicate in
 * getAttachmentRow (`lead_id = ?` → `(lead_id = ? OR 1=1)`, same arity)
 * and the cross-lead assertions in A must FAIL (suite exits non-zero),
 * proving the predicate is the barrier.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b89-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch89', 'test', 'session', 'secret'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY =
  process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 23).toString('base64');

const NEGATIVE = process.env.B89_NEGATIVE || '';
const PORT = 31489;
const BASE = `http://127.0.0.1:${PORT}`;
const groups = [];
function group(name, n) {
  groups.push(`${name} (${n})`);
  console.log(`  ok ${name} — ${n} checks`);
}

function loadChatAtt() {
  if (NEGATIVE === 'workspace') {
    const src = fs.readFileSync(path.join(root, 'server', 'siteChatAttachments.js'), 'utf8');
    const shimmed = src.replace(
      'WHERE id = ? AND lead_id = ?',
      'WHERE id = ? AND (lead_id = ? OR 1=1)'
    );
    assert.notEqual(shimmed, src, 'negative shim must change the source');
    const m = { exports: {} };
    vm.runInNewContext(shimmed + ';module.exports = module.exports;', {
      module: m,
      exports: m.exports,
      require: (n) => require(n.startsWith('node:') ? n : path.join(root, 'node_modules', n)),
      console,
      Buffer,
      process,
    });
    return m.exports;
  }
  return require(path.join(root, 'server', 'siteChatAttachments.js'));
}

(async () => {
  const sharp = require(path.join(root, 'node_modules', 'sharp'));
  const domain = require(path.join(root, 'server', 'domain.js'));
  const chatAtt = loadChatAtt();
  // Initialize the platform schema in-process (server boot calls
  // db.migrate()) so MCP callTool's workspace checks find their tables.
  await require(path.join(root, 'server', 'db.js')).migrate();

  const pngBuf = await sharp({
    create: { width: 24, height: 24, channels: 3, background: { r: 198, g: 44, b: 44 } },
  })
    .png()
    .toBuffer();
  const jpgBuf = await sharp({
    create: { width: 24, height: 24, channels: 3, background: { r: 44, g: 90, b: 198 } },
  })
    .jpeg()
    .toBuffer();
  const webpBuf = await sharp({
    create: { width: 24, height: 24, channels: 3, background: { r: 44, g: 160, b: 90 } },
  })
    .webp()
    .toBuffer();
  const gifBuf = Buffer.from(
    'R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==',
    'base64'
  );

  function seedLead(ws, { withSite = true } = {}) {
    return domain.withDb(ws, (db) => {
      const lead = db.prepare('INSERT INTO leads (business_name) VALUES (?)').run('ZZ B89 Fixture');
      const leadId = Number(lead.lastInsertRowid);
      let siteId = null;
      if (withSite) {
        const s = db
          .prepare(
            "INSERT INTO websites (lead_id, name, status, pages, theme) VALUES (?, 'ZZ B89 Site', 'draft', ?, '{}')"
          )
          .run(leadId, JSON.stringify([{ slug: 'index', sections: [] }]));
        siteId = Number(s.lastInsertRowid);
      }
      return { leadId, siteId };
    });
  }

  const A = seedLead(1);
  const B = seedLead(1);
  const C = seedLead(2);

  // ---------------------------------------------------------------
  // A. Engine: upload, storage, validation, scoping, sweep
  // ---------------------------------------------------------------
  {
    let n = 0;
    const saved = await domain.withDb(1, (db) =>
      chatAtt.saveAttachment(db, {
        workspaceId: 1,
        leadId: A.leadId,
        websiteId: A.siteId,
        buffer: pngBuf,
        originalName: 'My Logo (final).PNG',
      })
    );
    n++;
    assert.equal(saved.leadId, A.leadId);
    assert.equal(saved.websiteId, A.siteId);
    assert.equal(saved.mime, 'image/png');
    assert.equal(saved.sizeBytes, pngBuf.length);
    assert.equal(saved.name, 'My_Logo_final_.PNG');
    assert.match(saved.url, new RegExp(`^/api/v1/portal/site/agent-chat/attachments/${saved.id}$`));
    assert.ok(saved.thumbUrl && saved.thumbUrl.includes('variant=thumb'), 'thumbnail URL present');
    n += 6;

    // File landed under the workspace/lead folder, byte-identical.
    const rowA = domain.withDb(1, (db) => chatAtt.getAttachmentRow(db, A.leadId, saved.id));
    assert.ok(rowA, 'row readable by owning lead');
    const abs = path.join(process.env.EXPORT_ROOT, rowA.stored_rel);
    assert.ok(rowA.stored_rel.startsWith(path.join('site-chat', 'ws-1', `lead-${A.leadId}`)));
    assert.ok(fs.existsSync(abs), 'stored file exists');
    assert.ok(fs.readFileSync(abs).equals(pngBuf), 'stored bytes identical');
    assert.ok(!rowA.stored_name.includes('Logo'), 'stored name is server-generated');
    n += 5;

    // Read paths: full + thumbnail variant.
    const full = domain.withDb(1, (db) => chatAtt.readAttachment(db, { leadId: A.leadId, id: saved.id }));
    assert.ok(full && full.buffer.equals(pngBuf) && full.mime === 'image/png');
    const thumb = domain.withDb(1, (db) =>
      chatAtt.readAttachment(db, { leadId: A.leadId, id: saved.id, variant: 'thumb' })
    );
    assert.ok(thumb && thumb.mime === 'image/jpeg' && thumb.buffer[0] === 0xff && thumb.buffer[1] === 0xd8);
    n += 2;

    // List scoping.
    const listA = domain.withDb(1, (db) => chatAtt.listAttachments(db, { leadId: A.leadId }));
    assert.equal(listA.length, 1);
    assert.equal(listA[0].id, saved.id);
    const listB = domain.withDb(1, (db) => chatAtt.listAttachments(db, { leadId: B.leadId }));
    assert.equal(listB.length, 0);
    n += 3;

    // CROSS-LEAD: the scoping predicate is the barrier. Under
    // B89_NEGATIVE=workspace this read SUCCEEDS and the suite goes red.
    const cross = domain.withDb(1, (db) => chatAtt.readAttachment(db, { leadId: B.leadId, id: saved.id }));
    assert.equal(cross, null, 'another lead in the same workspace must not read the attachment');
    const crossRow = domain.withDb(1, (db) => chatAtt.getAttachmentRow(db, B.leadId, saved.id));
    assert.equal(crossRow, null, 'another lead must not resolve the row');
    n += 2;

    // Magic-byte matrix: every supported family saves; content wins
    // over the declared filename.
    for (const [buf, mime, name] of [
      [jpgBuf, 'image/jpeg', 'photo.txt'],
      [webpBuf, 'image/webp', 'pic.png'],
      [gifBuf, 'image/gif', 'anim.jpg'],
    ]) {
      const r = await domain.withDb(1, (db) =>
        chatAtt.saveAttachment(db, { workspaceId: 1, leadId: B.leadId, buffer: buf, originalName: name })
      );
      assert.equal(r.mime, mime, `${name} sniffed as ${mime}`);
      n++;
    }
    // Fake image (text bytes, image name) rejected.
    await assert.rejects(
      domain.withDb(1, (db) =>
        chatAtt.saveAttachment(db, {
          workspaceId: 1,
          leadId: A.leadId,
          buffer: Buffer.from('this is not an image at all'),
          originalName: 'evil.png',
        })
      ),
      (e) => e.code === 'INVALID_IMAGE'
    );
    n++;
    // SVG rejected (script risk — excluded by design).
    await assert.rejects(
      domain.withDb(1, (db) =>
        chatAtt.saveAttachment(db, {
          workspaceId: 1,
          leadId: A.leadId,
          buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
          originalName: 'vector.svg',
        })
      ),
      (e) => e.code === 'INVALID_IMAGE'
    );
    n++;
    // Oversize rejected before sniffing matters (PNG magic + 10MB+1).
    const big = Buffer.alloc(chatAtt.MAX_IMAGE_BYTES + 1);
    pngBuf.copy(big, 0, 0, 8);
    await assert.rejects(
      domain.withDb(1, (db) =>
        chatAtt.saveAttachment(db, { workspaceId: 1, leadId: A.leadId, buffer: big, originalName: 'big.png' })
      ),
      (e) => e.code === 'TOO_LARGE'
    );
    n++;
    // Empty rejected.
    await assert.rejects(
      domain.withDb(1, (db) =>
        chatAtt.saveAttachment(db, { workspaceId: 1, leadId: A.leadId, buffer: Buffer.alloc(0), originalName: 'x.png' })
      ),
      (e) => e.code === 'INVALID'
    );
    n++;
    // Hostile filename is sanitized to a display label, never a path.
    const hostile = await domain.withDb(1, (db) =>
      chatAtt.saveAttachment(db, {
        workspaceId: 1,
        leadId: B.leadId,
        buffer: pngBuf,
        originalName: '../../../etc/passwd.png',
      })
    );
    assert.equal(hostile.name, 'passwd.png');
    const hostileRow = domain.withDb(1, (db) => chatAtt.getAttachmentRow(db, B.leadId, hostile.id));
    assert.ok(!hostileRow.stored_rel.includes('..'));
    n += 2;

    // Id-list normalization + per-message cap.
    assert.deepEqual(chatAtt.normalizeAttachmentIds([saved.id, String(saved.id), -1, 'x']), [saved.id]);
    assert.throws(
      () => chatAtt.normalizeAttachmentIds([1, 2, 3, 4, 5]),
      (e) => e.code === 'TOO_MANY'
    );
    n += 2;

    // loadForChat: own ids load; another lead's id is a coded error.
    const loaded = domain.withDb(1, (db) => chatAtt.loadForChat(db, { leadId: A.leadId, ids: [saved.id] }));
    assert.equal(loaded.length, 1);
    assert.throws(
      () => domain.withDb(1, (db) => chatAtt.loadForChat(db, { leadId: B.leadId, ids: [saved.id] })),
      (e) => e.code === 'INVALID'
    );
    n += 2;

    // Turn linkage stamps website + message ref.
    domain.withDb(1, (db) =>
      chatAtt.linkToTurn(db, { leadId: A.leadId, ids: [saved.id], websiteId: A.siteId, messageRef: 'turn-test-1' })
    );
    const linked = domain.withDb(1, (db) => chatAtt.getAttachmentRow(db, A.leadId, saved.id));
    assert.equal(linked.message_ref, 'turn-test-1');
    assert.equal(linked.website_id, A.siteId);
    n += 2;

    // Model images: downscaled JPEG data URL built from the stored file.
    const modelImgs = await chatAtt.buildModelImages([linked]);
    assert.equal(modelImgs.length, 1);
    assert.ok(modelImgs[0].dataUrl.startsWith('data:image/jpeg;base64,'));
    assert.equal(modelImgs[0].name, linked.original_name);
    n += 3;

    group('A engine: storage + validation + scoping', n);
  }

  // A2. Lead-delete sweep (rows + files follow the lead).
  {
    let n = 0;
    const D = seedLead(1);
    const saved = await domain.withDb(1, (db) =>
      chatAtt.saveAttachment(db, {
        workspaceId: 1,
        leadId: D.leadId,
        websiteId: D.siteId,
        buffer: pngBuf,
        originalName: 'doomed.png',
      })
    );
    const rowD = domain.withDb(1, (db) => chatAtt.getAttachmentRow(db, D.leadId, saved.id));
    const absD = path.join(process.env.EXPORT_ROOT, rowD.stored_rel);
    assert.ok(fs.existsSync(absD));
    n++;
    const leadEngine = require(path.join(root, 'src', 'leadEngine.js'));
    const res = domain.withDb(1, (db) => leadEngine.deleteLead(db, D.leadId));
    assert.ok(res.ok);
    assert.ok(res.removedChatAttachments >= 1, 'delete reports swept attachments');
    const after = domain.withDb(1, (db) => {
      chatAtt.ensureTable(db);
      return db
        .prepare('SELECT COUNT(*) AS c FROM site_chat_attachments WHERE lead_id = ?')
        .get(D.leadId).c;
    });
    assert.equal(after, 0, 'attachment rows dropped with the lead');
    assert.ok(!fs.existsSync(absD), 'attachment file unlinked with the lead');
    n += 4;
    group('A2 lead-delete sweep', n);
  }

  // ---------------------------------------------------------------
  // B. AI loop: vision parts, fallback, image-only, text-only shape
  // ---------------------------------------------------------------
  {
    let n = 0;
    const agentSrc = require('./lib/monolithSource.cjs').museAgentSource();
    const defs = ['site.editText', 'site.publish'].map((name) => ({
      name,
      description: name,
      inputSchema: { type: 'object', properties: {} },
    }));
    function loopFixture(handler) {
      const requests = [];
      const db = {
        prepare: (sql) => ({
          get: () => (sql.includes('SUM') ? { spent: 0 } : undefined),
          run() {},
        }),
      };
      const domainStub = { withDb: (_ws, fn) => fn(db), getSetting: () => '0' };
      const m = { exports: {} };
      vm.runInNewContext(agentSrc + ';module.exports = module.exports;', {
        module: m,
        exports: m.exports,
        console,
        Buffer,
        URL,
        AbortSignal,
        require: (name) =>
          name === './platform'
            ? { getPlatformSetting: async (k, d) => (k === 'muse.model_api_key' ? 'synthetic-key' : d) }
            : name === '../src/defaultDesignInstructions'
              ? { defaultWebsiteInstructions: () => '' }
              : name === './domain'
                ? domainStub
                : name === './mcp'
                  ? { toolDefs: () => defs, callTool: async () => ({ ok: true, data: {} }) }
                  : name === './siteChatPlanner'
                    ? require(path.join(root, 'server', 'siteChatPlanner.js'))
                    : name === './portalCapabilities'
                      ? require(path.join(root, 'server', 'portalCapabilities.js'))
                      : require(name),
        fetch: async (_url, opts) => {
          const body = JSON.parse(opts.body);
          requests.push(body);
          return handler(body, requests.length);
        },
      });
      return { agent: m.exports, requests };
    }
    const textReply = (text) => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: text } }], usage: {} }),
    });
    const errReply = {
      ok: false,
      status: 400,
      json: async () => ({ error: { message: 'image parts unsupported' } }),
    };
    const img = { name: 'brand.png', mime: 'image/png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' };
    const lastUser = (body) => [...body.messages].reverse().find((mm) => mm.role === 'user');

    // B1: images ride the final user message as vision parts.
    {
      const f = loopFixture(() => textReply('Matched your brand colors.'));
      const res = await f.agent.runPortalImproveLoop(1, 7, {
        db: { prepare: (sql) => ({ get: () => (sql.includes('SUM') ? { spent: 0 } : undefined), run() {} }) },
        message: 'Use these colors',
        images: [img],
      });
      const lu = lastUser(f.requests[0]);
      assert.ok(Array.isArray(lu.content), 'user content is a parts array when images attached');
      const textPart = lu.content.find((p) => p.type === 'text');
      const imgPart = lu.content.find((p) => p.type === 'image_url');
      assert.ok(textPart && textPart.text.includes('Use these colors'));
      assert.ok(textPart.text.includes('brand.png'), 'text part names the attachment');
      assert.ok(imgPart && imgPart.image_url.url === img.dataUrl);
      assert.equal(res.attachments, 1);
      assert.equal(res.imagesSent, true);
      assert.equal(res.imagesDropped, false);
      n += 7;
    }
    // B2: endpoint rejects vision parts → one text-only retry, honest flags.
    {
      const f = loopFixture((body) => {
        const lu = lastUser(body);
        return Array.isArray(lu.content) ? errReply : textReply('Done without the image.');
      });
      const res = await f.agent.runPortalImproveLoop(1, 7, {
        db: { prepare: (sql) => ({ get: () => (sql.includes('SUM') ? { spent: 0 } : undefined), run() {} }) },
        message: 'Copy this flyer',
        images: [img],
      });
      assert.ok(f.requests.length >= 2, 'retried after vision rejection');
      const retryUser = lastUser(f.requests[1]);
      assert.equal(typeof retryUser.content, 'string', 'retry is text-only');
      assert.ok(retryUser.content.includes('could not be shown'), 'retry explains the drop');
      assert.equal(res.imagesDropped, true);
      assert.equal(res.imagesSent, false);
      assert.equal(res.error, null);
      n += 6;
    }
    // B3: image-only turn (no text) is valid and self-describing.
    {
      const f = loopFixture(() => textReply('Applied what the photo suggested.'));
      const res = await f.agent.runPortalImproveLoop(1, 7, {
        db: { prepare: (sql) => ({ get: () => (sql.includes('SUM') ? { spent: 0 } : undefined), run() {} }) },
        message: '',
        images: [img],
      });
      const lu = lastUser(f.requests[0]);
      assert.ok(Array.isArray(lu.content));
      const textPart = lu.content.find((p) => p.type === 'text');
      assert.ok(textPart.text.includes('no written message'));
      assert.equal(res.imagesSent, true);
      n += 3;
    }
    // B4: text-only turn keeps the exact old shape.
    {
      const f = loopFixture(() => textReply('Shortened.'));
      const res = await f.agent.runPortalImproveLoop(1, 7, {
        db: { prepare: (sql) => ({ get: () => (sql.includes('SUM') ? { spent: 0 } : undefined), run() {} }) },
        message: 'Shorten the headline',
      });
      const lu = lastUser(f.requests[0]);
      assert.equal(lu.content, 'Shorten the headline');
      assert.equal(res.attachments, 0);
      assert.equal(res.imagesSent, false);
      n += 3;
    }
    // B5: empty message with no images still throws EMPTY (normalize).
    {
      const f = loopFixture(() => textReply('x'));
      await assert.rejects(
        f.agent.runPortalImproveLoop(1, 7, {
          db: { prepare: (sql) => ({ get: () => (sql.includes('SUM') ? { spent: 0 } : undefined), run() {} }) },
          message: '',
        }),
        (e) => e.code === 'EMPTY'
      );
      n++;
    }
    group('B AI loop: vision wiring + fallback', n);
  }

  // ---------------------------------------------------------------
  // C. runSiteAgentChat slice: attachments reach the loop validated
  // ---------------------------------------------------------------
  {
    let n = 0;
    const portalSrc = require('./lib/monolithSource.cjs').clientPortalSource();
    const start = portalSrc.indexOf('async function runSiteAgentChat(');
    const end = portalSrc.indexOf('\n/**', start);
    assert.ok(start > 0 && end > start, 'slice bounds found');
    const realDb = domain.withDb(1, (db) => db);
    const savedC = await chatAtt.saveAttachment(realDb, {
      workspaceId: 1,
      leadId: A.leadId,
      websiteId: A.siteId,
      buffer: pngBuf,
      originalName: 'slice.png',
    });
    let loopOpts = null;
    const m = { exports: {} };
    vm.runInNewContext(portalSrc.slice(start, end) + ';module.exports = runSiteAgentChat;', {
      module: m,
      exports: m.exports,
      console,
      resolveClientSite: () => ({ id: A.siteId, pages: [{ slug: 'index' }] }),
      publishClientSitePreview: async () => ({}),
      renderClientSite: () => ({
        html: '<html><body>preview</body></html>',
        previewUrl: 'https://bitpype.test/preview',
        editable: true,
        theme: null,
        logo: null,
        pages: [],
      }),
      require: (name) =>
        name === './museAgent'
          ? {
              runPortalImproveLoop: async (_ws, _lead, opts) => {
                loopOpts = opts;
                return {
                  reply: 'Done.',
                  steps: 1,
                  toolCalls: 0,
                  mutated: true,
                  published: true,
                  model: 'fixture-model',
                  imagesSent: (opts.images || []).length > 0,
                  imagesDropped: false,
                };
              },
              // Batch 93: the chat classifies before it loops; this
              // stub keeps the slice on the direct build path the
              // Batch 89 assertions were written against.
              classifyPortalChatIntent: async () => ({ intent: 'change', ready: true, size: 'small' }),
            }
          : name === './domain'
            ? { withDb: (_ws, fn) => fn(realDb) }
            : name === './siteChatAttachments'
              ? chatAtt
              : name === './siteChatPending'
                ? require(path.join(root, 'server', 'siteChatPending.js'))
                : name === './siteChatPlanner'
                  ? require(path.join(root, 'server', 'siteChatPlanner.js'))
                  : name === './siteChatThread'
                    ? require(path.join(root, 'server', 'siteChatThread.js'))
                    : require(name),
    });
    const runChat = m.exports;

    // C1 image-only turn reaches the loop with a model image.
    loopOpts = null;
    const r1 = await runChat(1, A.leadId, { message: '', attachmentIds: [savedC.id] });
    assert.ok(loopOpts, 'loop invoked');
    assert.equal(loopOpts.images.length, 1);
    assert.ok(loopOpts.images[0].dataUrl.startsWith('data:image/jpeg;base64,'));
    assert.equal(r1.attachments.length, 1);
    assert.equal(r1.attachments[0].id, savedC.id);
    assert.equal(r1.imagesSent, true);
    n += 6;
    // Turn linkage was stamped by the chat call.
    const stamped = chatAtt.getAttachmentRow(realDb, A.leadId, savedC.id);
    assert.ok(stamped.message_ref && stamped.message_ref.startsWith('turn-'));
    assert.equal(stamped.website_id, A.siteId);
    n += 2;

    // C2 mixed turn (text + image).
    loopOpts = null;
    const r2 = await runChat(1, A.leadId, { message: 'Match this', attachmentIds: [savedC.id] });
    assert.equal(loopOpts.message, 'Match this');
    assert.equal(loopOpts.images.length, 1);
    assert.equal(r2.attachments.length, 1);
    n += 3;

    // C3 empty turn with nothing attached stays EMPTY.
    await assert.rejects(runChat(1, A.leadId, { message: '' }), (e) => e.code === 'EMPTY');
    n++;

    // C4 another lead's attachment id is rejected before the loop.
    loopOpts = null;
    await assert.rejects(
      runChat(1, B.leadId, { message: '', attachmentIds: [savedC.id] }),
      (e) => e.code === 'INVALID'
    );
    assert.equal(loopOpts, null, 'loop never invoked with a foreign attachment');
    n += 2;

    // C5 text-only turn unchanged: no images, no attachment echo.
    loopOpts = null;
    const r5 = await runChat(1, A.leadId, { message: 'Shorten it' });
    assert.equal(loopOpts.images.length, 0);
    assert.equal(r5.attachments.length, 0);
    n += 2;

    group('C runSiteAgentChat: validated attachment flow', n);
  }

  // ---------------------------------------------------------------
  // E. MCP design-context surface (staff / design agent retrieval)
  // ---------------------------------------------------------------
  {
    let n = 0;
    const mcp = require(path.join(root, 'server', 'mcp.js'));
    const savedE = await domain.withDb(1, (db) =>
      chatAtt.saveAttachment(db, {
        workspaceId: 1,
        leadId: A.leadId,
        websiteId: A.siteId,
        buffer: jpgBuf,
        originalName: 'mood-board.jpg',
      })
    );
    const listRes = await mcp.callTool(1, 'site.chatAttachments', { leadId: A.leadId });
    assert.equal(listRes.ok, true, JSON.stringify(listRes).slice(0, 200));
    const list = listRes.data;
    assert.ok(Array.isArray(list.attachments));
    const found = list.attachments.find((x) => x.id === savedE.id);
    assert.ok(found, 'attachment listed for the design agent');
    assert.equal(found.name, 'mood-board.jpg');
    assert.equal(found.mime, 'image/jpeg');
    n += 5;
    const gotRes = await mcp.callTool(1, 'site.chatAttachment', { id: savedE.id, leadId: A.leadId });
    assert.equal(gotRes.ok, true, JSON.stringify(gotRes).slice(0, 200));
    const got = gotRes.data;
    assert.equal(got.mime, 'image/jpeg');
    assert.ok(Buffer.from(got.base64, 'base64').equals(jpgBuf), 'MCP fetch returns the exact bytes');
    assert.ok(got.dataUrl.startsWith('data:image/jpeg;base64,'));
    n += 4;
    // Wrong lead (same workspace) and wrong workspace both fail closed
    // (callTool surfaces tool errors as { ok:false, error }).
    const wrongLead = await mcp.callTool(1, 'site.chatAttachment', { id: savedE.id, leadId: B.leadId });
    assert.equal(wrongLead.ok, false);
    assert.match(wrongLead.error, /not found/i);
    const wrongWs = await mcp.callTool(2, 'site.chatAttachment', { id: savedE.id, leadId: A.leadId });
    assert.equal(wrongWs.ok, false);
    assert.match(wrongWs.error, /not found/i);
    const listC = await mcp.callTool(2, 'site.chatAttachments', { leadId: C.leadId });
    assert.equal(listC.ok, true);
    assert.deepEqual(listC.data.attachments, []);
    n += 5;
    group('E MCP design-context retrieval', n);
  }

  // ---------------------------------------------------------------
  // D. HTTP: real server, portal sessions, auth + rate-limit matrix
  // ---------------------------------------------------------------
  {
    let n = 0;
    const { query } = require(path.join(root, 'server', 'db.js'));
    const bcrypt = require(path.join(root, 'node_modules', 'bcryptjs'));
    await require(path.join(root, 'server', 'db.js')).migrate();
    const hash = await bcrypt.hash('Batch89-Test-Pass!', 10);
    await query(
      `INSERT INTO client_portal_users (email, password_hash, workspace_id, lead_id, business_name, status)
       VALUES (:email, :hash, :ws, :lead, 'ZZ B89', 'active')`,
      { email: 'b89-one@test.invalid', hash, ws: 1, lead: A.leadId }
    );
    await query(
      `INSERT INTO client_portal_users (email, password_hash, workspace_id, lead_id, business_name, status)
       VALUES (:email, :hash, :ws, :lead, 'ZZ B89 Two', 'active')`,
      { email: 'b89-two@test.invalid', hash, ws: 2, lead: C.leadId }
    );
    n += 2;

    const child = spawn(process.execPath, [path.join(root, 'server.js')], {
      cwd: root,
      env: { ...process.env, PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let childLog = '';
    child.stdout.on('data', (d) => (childLog += d));
    child.stderr.on('data', (d) => (childLog += d));
    try {
      // Wait for health.
      let up = false;
      for (let i = 0; i < 60 && !up; i++) {
        await new Promise((r) => setTimeout(r, 500));
        try {
          const res = await fetch(`${BASE}/health`);
          up = res.status === 200;
        } catch {
          up = false;
        }
      }
      assert.ok(up, 'server booted: ' + childLog.slice(-400));
      n++;

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
                // The portal session cookie is Secure; production
                // requests arrive via nginx with this proto header,
                // without which express-session will not emit it.
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
        const res = await req('POST', '/api/v1/portal/login', { body: { email, password: 'Batch89-Test-Pass!' } });
        assert.equal(res.status, 200, `login ${email}: ${res.buf.toString('utf8').slice(0, 200)}`);
        const cookies = (res.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
        assert.ok(cookies.includes('bitpype.portal.sid'), 'portal session cookie set');
        return cookies;
      }
      const cookie1 = await login('b89-one@test.invalid');
      const cookie2 = await login('b89-two@test.invalid');
      n += 2;

      const pngDataUrl = 'data:image/png;base64,' + pngBuf.toString('base64');
      // D1 upload happy path.
      const up1 = await req('POST', '/api/v1/portal/site/agent-chat/attachments', {
        cookie: cookie1,
        body: { data: pngDataUrl, name: 'storefront idea.png' },
      });
      assert.equal(up1.status, 200, up1.buf.toString('utf8').slice(0, 200));
      const att = up1.json.data;
      assert.ok(att.id > 0);
      assert.equal(att.mime, 'image/png');
      assert.equal(att.sizeBytes, pngBuf.length);
      assert.ok(att.thumbUrl);
      n += 5;
      // The record is in the workspace DB, linked to lead + site.
      const rowH = domain.withDb(1, (db) => chatAtt.getAttachmentRow(db, A.leadId, att.id));
      assert.ok(rowH && rowH.website_id === A.siteId, 'thread payload record correct (lead + site)');
      n++;

      // D2 fetch as the participant: byte-identical, safe headers.
      const got = await req('GET', att.url, { cookie: cookie1 });
      assert.equal(got.status, 200);
      assert.ok(got.buf.equals(pngBuf), 'fetched bytes identical to uploaded bytes');
      assert.equal(got.headers['content-type'], 'image/png');
      assert.equal(got.headers['x-content-type-options'], 'nosniff');
      n += 4;
      // Thumbnail variant serves a JPEG.
      const th = await req('GET', att.thumbUrl, { cookie: cookie1 });
      assert.equal(th.status, 200);
      assert.equal(th.headers['content-type'], 'image/jpeg');
      n += 2;

      // D3 unauthenticated fetch → 401.
      const anon = await req('GET', att.url, {});
      assert.equal(anon.status, 401);
      n++;
      // D4 OTHER WORKSPACE session → 404 (no existence leak).
      const crossWs = await req('GET', att.url, { cookie: cookie2 });
      assert.equal(crossWs.status, 404);
      n++;
      // D5 other-workspace session cannot USE the attachment in chat.
      const crossUse = await req('POST', '/api/v1/portal/site/agent-chat', {
        cookie: cookie2,
        body: { message: 'use this', attachmentIds: [att.id] },
      });
      assert.equal(crossUse.status, 400);
      assert.equal(crossUse.json.code, 'INVALID');
      n += 2;

      // D6 fake + SVG uploads rejected with coded errors.
      const fake = await req('POST', '/api/v1/portal/site/agent-chat/attachments', {
        cookie: cookie1,
        body: { data: 'data:image/png;base64,' + Buffer.from('definitely not an image').toString('base64'), name: 'fake.png' },
      });
      assert.equal(fake.status, 400);
      assert.equal(fake.json.code, 'INVALID_IMAGE');
      const svg = await req('POST', '/api/v1/portal/site/agent-chat/attachments', {
        cookie: cookie1,
        body: {
          data:
            'data:image/svg+xml;base64,' +
            Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64'),
          name: 'vector.svg',
        },
      });
      assert.equal(svg.status, 400);
      assert.equal(svg.json.code, 'INVALID_IMAGE');
      n += 4;

      // D7 agent-chat validation: image-only passes the message gate
      // (this env has no Muse key, so the coded outcome is
      // AI_NOT_CONFIGURED — never EMPTY); text-only unchanged; truly
      // empty still EMPTY.
      const imgOnly = await req('POST', '/api/v1/portal/site/agent-chat', {
        cookie: cookie1,
        body: { message: '', attachmentIds: [att.id] },
      });
      assert.equal(imgOnly.status, 403, imgOnly.buf.toString('utf8').slice(0, 200));
      assert.equal(imgOnly.json.code, 'AI_NOT_CONFIGURED');
      const textOnly = await req('POST', '/api/v1/portal/site/agent-chat', {
        cookie: cookie1,
        body: { message: 'Make the headline shorter' },
      });
      assert.equal(textOnly.status, 403);
      assert.equal(textOnly.json.code, 'AI_NOT_CONFIGURED');
      const empty = await req('POST', '/api/v1/portal/site/agent-chat', {
        cookie: cookie1,
        body: { message: '' },
      });
      assert.equal(empty.status, 400);
      assert.equal(empty.json.code, 'EMPTY');
      n += 6;

      // D8 upload rate limit fires (30 / 15 min bucket; D1+D6 spent 3).
      let saw429 = false;
      for (let i = 0; i < 40 && !saw429; i++) {
        const r = await req('POST', '/api/v1/portal/site/agent-chat/attachments', {
          cookie: cookie1,
          body: { data: pngDataUrl, name: 'rl.png' },
        });
        if (r.status === 429) saw429 = true;
        else assert.equal(r.status, 200, `upload ${i} before limit: ${r.status}`);
      }
      assert.ok(saw429, 'rate limit fired with 429');
      n++;

      group('D HTTP: sessions, auth matrix, rate limit', n);
    } finally {
      child.kill('SIGKILL');
    }
  }

  // ---------------------------------------------------------------
  // F. Portal UI wiring pins
  // ---------------------------------------------------------------
  {
    let n = 0;
    const html = fs.readFileSync(path.join(root, 'public', 'portal.html'), 'utf8');
    assert.ok(html.includes('id="agent-chat-file"'), 'file input in the compose form');
    assert.ok(html.includes('id="agent-chat-pending"'), 'pending strip in the compose form');
    assert.ok(html.includes('agent-chat-attach'), 'attach control styled');
    assert.ok(html.includes('bubble-imgs'), 'bubble thumbnail styles');
    n += 4;
    const js = fs.readFileSync(path.join(root, 'public', 'js', 'portal.js'), 'utf8');
    assert.ok(js.includes("'/site/agent-chat/attachments'"), 'upload call in portal.js');
    assert.ok(js.includes('body.attachmentIds'), 'send body carries attachmentIds');
    assert.ok(js.includes('agentChatPending'), 'pending state tracked');
    assert.ok(js.includes('renderAgentChatPending'), 'pending chips rendered');
    n += 4;
    const routes = fs.readFileSync(path.join(root, 'server', 'routes', 'portal.js'), 'utf8');
    assert.ok(routes.includes("'/site/agent-chat/attachments'"), 'upload route registered');
    assert.ok(routes.includes("'/site/agent-chat/attachments/:id'"), 'fetch route registered');
    assert.ok(routes.includes('chatUploadLimit'), 'upload rate limit wired');
    n += 3;
    const srv = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
    assert.ok(srv.includes('chatUpload') && srv.includes("'15mb'"), 'body-limit carve-out for uploads');
    n++;
    const mcpSrc = fs.readFileSync(path.join(root, 'server', 'mcp.js'), 'utf8');
    assert.ok(mcpSrc.includes("'site.chatAttachments'") && mcpSrc.includes("'site.chatAttachment'"), 'MCP tools registered');
    n++;
    group('F UI + wiring pins', n);
  }

  console.log(JSON.stringify({ passed: true, groups, negative: NEGATIVE || null }));
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
