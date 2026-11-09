'use strict';
/**
 * Batch 168 — full-codebase third-party review: fix regressions.
 *
 * Ely's order 2026-11-09: review the ENTIRE codebase (bugs,
 * robustness, security), fix what's unambiguously broken with a
 * contained blast radius, report the rest. Every group below pins
 * one fixed finding from review-batch168-report.md; each was
 * reproduced against the pre-fix tree by the audit slices (repros
 * in the batch working notes) before it was fixed.
 *
 *   A — S8#F3/S2#9: apiErrors driver-code masking (+ isDriverCode).
 *   B — S2#1/#3: vendor token scope (REST matrix + MCP allowlist).
 *   C — S2#7 + pins: raw MCP catalog uniqueness; dead route files
 *       gone; embed viewer script pins match the server constants;
 *       boot asserts SETTINGS_ENCRYPTION_KEY; WP chat failTurn;
 *       portal failure-turn recording; mcpHttp timing-safe bearer.
 *   D — S8#F1: lead delete/merge cover the post-143 families, and
 *       the schema-derived inventory tripwire (every lead_id table
 *       in a fully-provisioned tenant DB is classified).
 *   E — S5#1: standalone backup contains ONLY the target client.
 *   F — S3: member-gate intersection, setSharedRef validation,
 *       notify_email strip, WiFi password off list surfaces.
 *   G — S4: PI-failed→paid completes; sub-less invoice.paid does
 *       not lift a suspension; split refunds reach 'refunded'.
 *   H — S1: session-cap predicates (staff + portal), OAuth code
 *       stored hashed, lockout fail-closed is pinned by source
 *       (its DB harness lives in the batch154 suite).
 *   I — S7: chat amount grammar widened; miscapture containment;
 *       webinar hub caps.
 *   J — S5#2: exporter prunes stale nested shells, leaves the
 *       domain-owned webinar/ tree alone.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b168-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch168', 'test', 'session', 'secret', 'value'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY =
  process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 41).toString('base64');

const groups = [];
function group(name, n) {
  groups.push(`${name} (${n})`);
  console.log(`  ok ${name} — ${n} checks`);
}

(async () => {
  /* ---------------- A — apiErrors driver masking ---------------- */
  {
    let n = 0;
    const apiErrors = require(path.join(root, 'server/apiErrors.js'));
    for (const code of ['SQLITE_CONSTRAINT_UNIQUE', 'ER_DUP_ENTRY', 'SQLITE_ERROR', 'ER_NO_SUCH_TABLE', 'ECONNREFUSED']) {
      assert.equal(apiErrors.isDriverCode(code), true, `driver code recognised: ${code}`);
      const e = Object.assign(new Error(`raw driver text for ${code}: UNIQUE constraint failed: t.email`), { code });
      const shaped = apiErrors.shapeError(e, 500, 'suite');
      assert.equal(shaped.code, 'INTERNAL', `${code} masked at 500`);
      assert.equal(shaped.message, apiErrors.GENERIC_MESSAGE, `${code} generic message`);
      assert.ok(shaped.ref && shaped.ref.startsWith('err_'), `${code} carries a ref`);
      const shaped4 = apiErrors.shapeError(e, 400, 'suite');
      assert.equal(shaped4.code, 'INTERNAL', `${code} masked even at 400`);
      n += 5;
    }
    // Authored codes still pass through untouched.
    const authored = Object.assign(new Error('That lead does not exist'), { code: 'NOT_FOUND' });
    const s2 = apiErrors.shapeError(authored, 404, 'suite');
    assert.equal(s2.code, 'NOT_FOUND');
    assert.equal(s2.message, 'That lead does not exist');
    n += 2;
    group('A apiErrors driver masking', n);
  }

  /* ---------------- B — vendor token scope ---------------- */
  {
    let n = 0;
    const vt = require(path.join(root, 'server/vendorTools.js'));
    // MCP allowlist: rentals are NOT vendor business (S2#3).
    assert.equal(vt.vendorToolAllowed('rentals.create'), false, 'rentals.create denied');
    assert.equal(vt.vendorToolAllowed('rentals.list'), false, 'rentals.list denied');
    assert.equal(vt.vendorToolAllowed('design.jobs.list'), true, 'design reads still allowed');
    n += 3;
    // REST matrix (S2#1).
    const cases = [
      ['POST', '/leads/register', false],
      ['POST', '/leads', false],
      ['GET', '/leads', true],
      ['GET', '/design/jobs', true],
      ['POST', '/design/jobs', true],
      ['POST', '/websites/40/preview', true],
      ['POST', '/websites/40/delete', false],
      ['POST', '/websites/generate', false],
      ['POST', '/websites/40/standalone-backup', false],
      ['DELETE', '/design/jobs/9', false],
      ['GET', '/settings', false],
      ['POST', '/activity/log', false],
    ];
    for (const [m, p, want] of cases) {
      assert.equal(vt.vendorRestAllowed(m, p), want, `vendorRestAllowed ${m} ${p} = ${want}`);
      n += 1;
    }
    group('B vendor token scope', n);
  }

  /* ---------------- C — catalog + source pins ---------------- */
  {
    let n = 0;
    const catalog = require(path.join(root, 'src/mcpCatalog.js'));
    const defs = Array.isArray(catalog.tools) ? catalog.tools : [];
    const names = defs.map((t) => t.name).filter(Boolean);
    assert.ok(names.length > 200, 'catalog loads');
    const seen = new Set();
    const dupes = [];
    for (const nm of names) {
      if (seen.has(nm)) dupes.push(nm);
      seen.add(nm);
    }
    assert.deepEqual(dupes, [], `raw catalog has no duplicate names (dupes: ${dupes.join(',')})`);
    n += 2;
    for (const dead of ['server/routes/dashboard.js', 'server/routes/leads.js', 'server/routes/design.js', 'server/routes/settings.js']) {
      assert.equal(fs.existsSync(path.join(root, dead)), false, `${dead} deleted (unmounted drift)`);
      n += 1;
    }
    const modVer = /const MODULE_SCRIPT_VER = '([^']+)'/.exec(read('server/siteModules.js'))[1];
    const formVer = /const FORM_SCRIPT_VER = '([^']+)'/.exec(read('server/contactForms.js'))[1];
    assert.ok(read('public/embed/module.html').includes(`module-embed.js?v=${modVer}`), 'module viewer pin matches MODULE_SCRIPT_VER');
    assert.ok(read('public/embed/form.html').includes(`form-embed.js?v=${formVer}`), 'form viewer pin matches FORM_SCRIPT_VER');
    n += 2;
    assert.ok(read('server.js').includes('SETTINGS_ENCRYPTION_KEY must be set in production'), 'boot asserts the encryption key');
    assert.ok(read('src/mcpRemote.js').includes("MCP_HTTP_ENABLED: '1'"), 'remote spawn opts into the SEC-15 gate');
    assert.ok(read('src/mcpHttp.js').includes('timingSafeEqual'), 'legacy bearer compare is timing-safe');
    const wp = read('server/wpDesignChat.js');
    assert.equal((wp.match(/return failTurn\(\);/g) || []).length, 6, 'all six WP failure paths persist the turn');
    assert.ok(read('server/routes/portal.js').includes('chat failure-turn record failed'), 'portal records failed turns');
    assert.ok(read('server/routes/mcpOAuth.js').includes('pendingExpiresAt'), 'oauth pending carries an expiry');
    n += 6;
    group('C catalog + source pins', n);
  }

  /* ---------------- D — lead delete/merge inventory (S8#F1) ---------------- */
  {
    let n = 0;
    const Database = require(path.join(root, 'node_modules/better-sqlite3'));
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(
      `CREATE TABLE leads (id INTEGER PRIMARY KEY, business_name TEXT DEFAULT '', email TEXT DEFAULT '', email_norm TEXT DEFAULT '', phone TEXT DEFAULT '', website TEXT DEFAULT '', website_kind TEXT DEFAULT 'bitpype', website_platform TEXT, status TEXT DEFAULT 'lead', notes TEXT DEFAULT '', tags TEXT DEFAULT '', category TEXT DEFAULT '', city TEXT DEFAULT '', state TEXT DEFAULT '', postal_code TEXT DEFAULT '', country TEXT DEFAULT '', latitude REAL, longitude REAL, rating REAL, review_count INTEGER, description TEXT DEFAULT '', hours TEXT DEFAULT '', services TEXT DEFAULT '', social_links TEXT DEFAULT '', source TEXT DEFAULT '', source_ref TEXT DEFAULT '', lead_group TEXT, address TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
       CREATE TABLE websites (id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id INTEGER, name TEXT NOT NULL DEFAULT '', preview_path TEXT NOT NULL DEFAULT '', archived_at TEXT, pages TEXT NOT NULL DEFAULT '[]', theme TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
       CREATE TABLE activity_log (id INTEGER PRIMARY KEY AUTOINCREMENT, area TEXT, message TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
       CREATE TABLE lead_events (id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id INTEGER, type TEXT, detail TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
       CREATE TABLE site_domains (id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id INTEGER, website_id INTEGER, domain TEXT);`
    );
    const sm = require(path.join(root, 'server/siteModules.js'));
    sm.ensureTables(db);
    require(path.join(root, 'server/assistantChat.js')).ensureTables(db);
    try {
      require(path.join(root, 'server/chatbot.js')).ensureTables(db);
    } catch {
      /* chatbot tables are created by siteModules.ensureTables already */
    }
    try {
      require(path.join(root, 'server/contactForms.js')).ensureTables(db);
    } catch {
      /* same */
    }
    const le = require(path.join(root, 'src/leadEngine.js'));
    try {
      le.ensureLeadColumns(db);
    } catch {
      /* fixture DDL already current */
    }

    const FAMS = [
      'module_custom_code_blocks',
      'lead_contact_notes',
      'googlereviews_social_posts',
      'assistant_conversations',
      'assistant_messages',
      'assistant_attachments',
      'call_logs',
    ];
    function seed(id) {
      db.prepare('INSERT INTO leads (id,business_name,email) VALUES (?,?,?)').run(id, 'Biz' + id, `b${id}@x.invalid`);
      db.prepare('INSERT INTO module_custom_code_blocks (lead_id,label,html,js) VALUES (?,?,?,?)').run(id, 'L', '<b>x</b>', 'alert(1)');
      db.prepare('INSERT INTO lead_contact_notes (lead_id,body) VALUES (?,?)').run(id, 'note');
      db.prepare('INSERT INTO googlereviews_social_posts (lead_id,review_key,social_post_id) VALUES (?,?,?)').run(id, 'rk' + id, 999);
      db.prepare('INSERT INTO assistant_conversations (surface,actor_id,lead_id,title) VALUES (?,?,?,?)').run('portal', 7, id, 'chat');
      const cid = db.prepare('SELECT last_insert_rowid() c').get().c;
      db.prepare('INSERT INTO assistant_messages (conversation_id,role,content) VALUES (?,?,?)').run(cid, 'user', 'hi');
      db.prepare(
        'INSERT INTO assistant_attachments (surface,actor_id,lead_id,conversation_id,stored_name,stored_rel,mime,kind,size_bytes) VALUES (?,?,?,?,?,?,?,?,?)'
      ).run('portal', 7, id, cid, 'f.png', 'f.png', 'image/png', 'image', 10);
      db.prepare('INSERT INTO call_logs (lead_id,call_sid) VALUES (?,?)').run(id, 'CA' + id);
    }
    function counts(id) {
      const out = {};
      for (const t of FAMS) {
        out[t] =
          t === 'assistant_messages'
            ? db
                .prepare('SELECT COUNT(*) c FROM assistant_messages WHERE conversation_id IN (SELECT id FROM assistant_conversations WHERE lead_id=?)')
                .get(id).c
            : db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE lead_id=?`).get(id).c;
      }
      return out;
    }
    seed(1);
    le.deleteLead(db, 1);
    const afterDelete = counts(1);
    for (const t of FAMS) assert.equal(afterDelete[t], 0, `delete: ${t} has no orphans`);
    n += FAMS.length;
    seed(2);
    seed(3);
    le.mergeLeads(db, 2, [3]);
    const stranded = counts(3);
    const keeper = counts(2);
    for (const t of FAMS) {
      assert.equal(stranded[t], 0, `merge: ${t} not stranded on the dropped lead`);
      assert.equal(keeper[t], 2, `merge: ${t} rows followed to the keeper`);
      n += 2;
    }

    /* The durable tripwire: enumerate EVERY table with a lead_id
     * column in this fully-provisioned schema and require it to be
     * classified — in deleteLead's drop list, in one of the merge
     * treatment lists, swept by an explicit DELETE, or in the
     * keep-with-reason map below. A future module table that lands
     * in NO list fails here instead of orphaning silently (which is
     * exactly how the post-143 families escaped the 143 suite). */
    const srcText = read('src/leadEngine.js');
    const grab = (re) => new Set([...srcText.matchAll(re)].map((m) => m[1]));
    const region = (startMarker, endMarker) => {
      const a = srcText.indexOf(startMarker);
      const b = a < 0 ? -1 : srcText.indexOf(endMarker, a);
      return a < 0 || b < 0 ? '' : srcText.slice(a, b);
    };
    const classified = new Set([
      ...grab(/drop\('([a-z0-9_]+)'\)/g),
      ...grab(/DELETE FROM ([a-z0-9_]+)/g),
    ]);
    for (const [s, e] of [
      ['const MERGE_MOVE_TABLES = [', '];'],
      ['const MERGE_DEDUPE_TABLES = {', '};'],
      ['const MERGE_SINGLETON_TABLES = [', '];'],
    ]) {
      for (const m of region(s, e).matchAll(/'?([a-z0-9_]+)'?\s*:/g)) classified.add(m[1]);
      for (const m of region(s, e).matchAll(/'([a-z0-9_]+)',/g)) classified.add(m[1]);
    }
    const KEEP_WITH_REASON = {
      leads: 'the root row itself',
      websites: "deleteLead's own site sweep (archivedWebsiteIds)",
      assistant_messages: 'no lead_id column path — swept via conversation sweep',
      settings: 'key-value table; lead keys die by the lead_id.<id>. prefix delete',
    };
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((r) => r.name);
    const leadTables = tables.filter((t) =>
      db
        .prepare(`PRAGMA table_info(${t})`)
        .all()
        .some((c) => c.name === 'lead_id')
    );
    const unclassified = leadTables.filter((t) => !classified.has(t) && !(t in KEEP_WITH_REASON));
    assert.deepEqual(
      unclassified,
      [],
      `every lead_id table is classified for delete/merge (unclassified: ${unclassified.join(', ')})`
    );
    n += 1;
    group('D lead delete/merge inventory', n);
  }

  /* ---------------- E — standalone backup scoping (S5#1) ---------------- */
  {
    let n = 0;
    const platformDb = require(path.join(root, 'server/db.js'));
    const platform = require(path.join(root, 'server/platform.js'));
    const workspace = require(path.join(root, 'server/workspace.js'));
    const { openWorkspaceDb } = require(path.join(root, 'server/workspaceDb.js'));
    const sm = require(path.join(root, 'server/siteModules.js'));
    const backup = require(path.join(root, 'server/standaloneBackup.js'));
    const bcrypt = require(path.join(root, 'node_modules/bcryptjs'));
    await platformDb.migrate();
    await platform.seedPlatformDefaults();
    const a = await workspace.createUserWithWorkspace({
      email: 'owner-b168@example.com',
      password: 'Owner-B168-Pass!',
      name: 'Owner',
      workspaceName: 'B168WS',
    });
    const ws = Number(a.workspaceId || a.workspace_id || a.id);
    const db = openWorkspaceDb(ws);
    sm.ensureTables(db);
    const pages = [{ slug: 'index', title: 'Home', sections: [{ type: 'heading', content: { title: 'Target Biz' } }] }];
    db.prepare("INSERT INTO leads (id,business_name,email,status) VALUES (101,'Target Biz','target@example.com','customer')").run();
    db.prepare("INSERT INTO leads (id,business_name,email,status) VALUES (102,'OTHER CLIENT MARKER','other-b168@example.com','customer')").run();
    db.prepare('INSERT INTO websites (id,lead_id,name,pages,theme) VALUES (101,101,?,?,?)').run('Target Biz', JSON.stringify(pages), '{}');
    db.prepare('INSERT INTO websites (id,lead_id,name,pages,theme) VALUES (102,102,?,?,?)').run('OTHER CLIENT MARKER', JSON.stringify(pages), '{}');
    sm.createProduct(db, 102, { name: 'OTHER CLIENT PRODUCT', price_cents: 100, status: 'published' });
    sm.createProduct(db, 101, { name: 'Target Product', price_cents: 200, status: 'published' });
    await platformDb.query(
      "INSERT INTO client_portal_users (email,password_hash,workspace_id,lead_id,business_name,status) VALUES (:e,:h,:ws,102,'Other','active')",
      { e: 'other-b168@example.com', h: bcrypt.hashSync('OtherPortalPass!', 4), ws }
    );
    await platformDb.query(
      "INSERT INTO client_portal_users (email,password_hash,workspace_id,lead_id,business_name,status) VALUES (:e,:h,:ws,101,'Target','active')",
      { e: 'target@example.com', h: bcrypt.hashSync('TargetPortalPass!', 4), ws }
    );
    const genDir = path.join(temp, 'gen');
    fs.mkdirSync(genDir, { recursive: true });
    const gen = await backup.generateStandaloneBackup({ workspaceId: ws, websiteId: 101, workDir: genDir });
    const Database = require(path.join(root, 'node_modules/better-sqlite3'));
    const tenant = new Database(path.join(gen.packageDir, 'seed/tenant.sqlite'), { readonly: true });
    const leadIds = tenant.prepare('SELECT id FROM leads').all().map((r) => r.id);
    assert.deepEqual(leadIds, [101], 'tenant package holds ONLY the target lead');
    const siteRows = tenant.prepare('SELECT id, lead_id FROM websites').all();
    assert.ok(siteRows.length === 1 && siteRows[0].lead_id === 101, 'only the target website travels');
    const prodNames = tenant.prepare('SELECT name FROM ecommerce_products').all().map((r) => r.name);
    assert.deepEqual(prodNames, ['Target Product'], "the other client's products are scrubbed");
    n += 3;
    const plat = new Database(path.join(gen.packageDir, 'seed/platform.sqlite'), { readonly: true });
    const portalUsers = plat.prepare('SELECT email, lead_id FROM client_portal_users').all();
    assert.ok(portalUsers.length === 1 && portalUsers[0].lead_id === 101, 'platform seed holds only the target portal user');
    const staff = plat.prepare('SELECT email, length(password_hash) AS hl FROM users').all();
    assert.ok(staff.length >= 1 && staff.every((u) => u.hl === 0), 'staff password hashes are blanked in the seed');
    n += 2;
    assert.ok(gen.manifest && gen.manifest.seed && gen.manifest.seed.tenantScrub, 'manifest records the tenant scrub');
    n += 1;
    group('E standalone backup scoping', n);
  }

  /* ---------------- F — S3 module surfaces ---------------- */
  {
    let n = 0;
    const Database = require(path.join(root, 'node_modules/better-sqlite3'));
    const db = new Database(':memory:');
    db.exec(
      `CREATE TABLE IF NOT EXISTS leads (id INTEGER PRIMARY KEY, business_name TEXT, email TEXT, status TEXT, phone TEXT);
       CREATE TABLE IF NOT EXISTS websites (id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id INTEGER, name TEXT, theme TEXT, pages TEXT, status TEXT, updated_at TEXT);`
    );
    const sm = require(path.join(root, 'server/siteModules.js'));
    const share = require(path.join(root, 'server/moduleShare.js'));
    sm.ensureTables(db);
    const LEAD = 1;
    db.prepare("INSERT INTO leads (id, business_name, email, status) VALUES (1,'Biz','b@x.invalid','customer')").run();
    db.prepare("INSERT INTO websites (lead_id, name, theme, pages, status) VALUES (1,'S','{}','[]','draft')").run();
    sm.attachModule(db, LEAD, 'members', { workspaceId: 99 });
    sm.attachModule(db, LEAD, 'courses', { workspaceId: 99 });
    const cEmbed = sm.getEmbedRow(db, LEAD, 'courses');
    sm.updateMembersConfig(db, LEAD, { gate_mode: 'selected', gated_pages: ['courses'] });
    const course = sm.createCourse(db, LEAD, {
      title: 'Secret Course',
      status: 'published',
      description: 'paid content',
      lessons: [{ title: 'L1', body_html: 'SECRET LESSON BODY' }],
    });
    // A3: the client claims an UNGATED page slug — the course list
    // must still be member-locked (the embed's own page is gated).
    const p = sm.getPublicModuleByToken(db, cEmbed.public_token, { pageSlug: 'index' });
    assert.equal(!!p.locked, true, 'member gate holds against a lying bpPage');
    assert.ok(!JSON.stringify(p).includes('SECRET LESSON BODY'), 'locked payload carries no lesson bodies');
    n += 2;
    // A4: the item path too.
    let itemLocked = false;
    try {
      const it = sm.getPublicModuleItem(db, cEmbed.public_token, course.slug, { pageSlug: 'index' });
      itemLocked = !!it.locked || !JSON.stringify(it).includes('SECRET LESSON BODY');
    } catch {
      itemLocked = true;
    }
    assert.equal(itemLocked, true, 'item path holds the gate too');
    n += 1;
    // setSharedRef consumer validation (S3#4).
    const album = sm.createAlbum(db, LEAD, { title: 'Album', status: 'published', images: [{ image_url: 'https://i/x.jpg' }] });
    for (const ref of [
      { consumer_type: 'events', consumer_id: 999999, provider_type: 'gallery', provider_id: album.id, role: 'album' },
      { consumer_type: 'custom_code', consumer_id: 1, provider_type: 'gallery', provider_id: album.id, role: 'x' },
      { consumer_type: 'chatbot', consumer_id: 1, provider_type: 'gallery', provider_id: album.id, role: 'x' },
    ]) {
      assert.throws(() => share.setSharedRef(db, LEAD, ref), /./, `invalid consumer rejected: ${ref.consumer_type}`);
      n += 1;
    }
    assert.equal(share.listSharedRefs(db, LEAD).length, 0, 'no invalid refs stored');
    n += 1;
    group('F module surfaces', n);
  }

  /* ---------------- G — S4 payments ---------------- */
  {
    let n = 0;
    // S4#1 — PI-failed then paid in the same session settles (the
    // proven slice-4 fixture: real checkout creation against a
    // stubbed Stripe client, then the two real webhook events).
    const shopStripe = require(path.join(root, 'server/shopStripe.js'));
    const stubStripe = {
      checkout: {
        sessions: {
          create: async () => ({ id: 'cs_b168', url: 'https://checkout.stripe.test/cs_b168', payment_intent: 'pi_b168' }),
        },
      },
      refunds: { create: async () => ({ id: 're_b168' }) },
    };
    shopStripe.resolveForLead = () => ({ client: stubStripe, source: 'test' });
    shopStripe.isConfiguredForLead = () => true;
    const Database = require(path.join(root, 'node_modules/better-sqlite3'));
    const db = new Database(':memory:');
    const sm = require(path.join(root, 'server/siteModules.js'));
    sm.ensureTables(db);
    db.exec(
      `CREATE TABLE leads (id INTEGER PRIMARY KEY, business_name TEXT, email TEXT, categories TEXT);
       CREATE TABLE websites (id INTEGER PRIMARY KEY, lead_id INTEGER, custom_domain TEXT, preview_url TEXT);`
    );
    db.prepare("INSERT INTO leads (id, business_name, email) VALUES (42, 'B168 Shop', 'shop@fixture.test')").run();
    const embed = sm.ensureEmbed(db, 42, 'ecommerce', { workspaceId: 999 });
    db.prepare('UPDATE site_module_embeds SET published = 1 WHERE id = ?').run(embed.id);
    const product = sm.createProduct(db, 42, { name: 'Widget', price_cents: 2500, status: 'published' });
    const shop = await sm.createShopCheckoutByToken(db, embed.public_token, {
      productId: product.id,
      returnUrl: 'https://fixture.test/shop',
    });
    sm.applyTenantStripeEvent(db, {
      id: 'evt_b168_1',
      type: 'payment_intent.payment_failed',
      data: { object: { id: 'pi_b168', metadata: { bitpype_order_id: String(shop.orderId) } } },
    });
    const midStatus = db.prepare('SELECT status FROM ecommerce_orders WHERE id = ?').get(shop.orderId).status;
    assert.equal(midStatus, 'failed', 'first declined attempt marks the order failed');
    sm.applyTenantStripeEvent(db, {
      id: 'evt_b168_2',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_b168',
          payment_status: 'paid',
          payment_intent: 'pi_b168',
          amount_total: 2500,
          currency: 'USD',
          customer_details: { email: 'buyer@fixture.test' },
        },
      },
    });
    const finalStatus = db.prepare('SELECT status FROM ecommerce_orders WHERE id = ?').get(shop.orderId).status;
    assert.equal(finalStatus, 'paid', 'the paid retry in the same session settles the order (S4#1)');
    n += 2;

    // S4#2 + S4#3 — platform side through the real billing dispatch.
    const { query, migrate } = require(path.join(root, 'server/db.js'));
    await migrate();
    const workspace = require(path.join(root, 'server/workspace.js'));
    const { openWorkspaceDb } = require(path.join(root, 'server/workspaceDb.js'));
    const billing = require(path.join(root, 'server/billing.js'));
    const suspension = require(path.join(root, 'server/subscriptionSuspension.js'));
    const deps = { sendMail: async () => ({ sent: true }), openDb: (ws) => openWorkspaceDb(ws) };
    process.env.MAIL_DRY_RUN = 'true';
    const acct = await workspace.createUserWithWorkspace({
      email: 'susp-b168@fixture.test',
      password: 'susp-b168-password',
      name: 'SuspB168',
    });
    const userId = Number(acct.userId);
    await query(
      `UPDATE users SET stripe_customer_id='cus_b168', stripe_subscription_id='sub_b168',
       subscription_status='unpaid', billing_plan='standard' WHERE id=:id`,
      { id: userId }
    );
    const wdb = openWorkspaceDb(acct.workspaceId);
    const lead = wdb.prepare('INSERT INTO leads (business_name, email) VALUES (?, ?)').run('B168 Biz', 'susp-b168@fixture.test');
    wdb.prepare("INSERT INTO websites (name, status, lead_id, theme, pages) VALUES ('B168 Site','published',?,'classic','[]')").run(
      Number(lead.lastInsertRowid)
    );
    await suspension.suspendForSubscription(
      { id: 'sub_b168', customer: 'cus_b168', status: 'unpaid', metadata: { user_id: String(userId) } },
      deps
    );
    assert.ok(await suspension.getActiveSuspensionForUser(userId, deps), 'suspension is active before the test invoice');
    const lifted = await suspension.restoreForInvoice(
      { id: 'in_b168_subless', customer: 'cus_b168', amount_paid: 500, currency: 'usd', status: 'paid', billing_reason: 'manual' },
      deps
    );
    assert.equal(lifted, null, 'restoreForInvoice refuses a sub-less invoice (S4#2)');
    await billing.handleWebhookEvent(
      {
        id: 'evt_b168_subless',
        type: 'invoice.paid',
        data: {
          object: { id: 'in_b168_subless', customer: 'cus_b168', amount_paid: 500, currency: 'usd', status: 'paid', billing_reason: 'manual' },
        },
      },
      deps
    );
    assert.ok(await suspension.getActiveSuspensionForUser(userId, deps), 'suspension survives a sub-less invoice.paid end-to-end');
    n += 3;

    // S4#3 — split partial refunds reach 'refunded' cumulatively.
    const acct2 = await workspace.createUserWithWorkspace({
      email: 'ref-b168@fixture.test',
      password: 'ref-b168-password',
      name: 'RefB168',
    });
    await query(
      `INSERT INTO payments (user_id, stripe_invoice_id, stripe_payment_intent_id, stripe_charge_id, amount_cents, currency, status, description)
       VALUES (:u, 'in_b168r', 'pi_b168r', 'ch_b168r', 10000, 'usd', 'succeeded', 'Invoice in_b168r')`,
      { u: Number(acct2.userId) }
    );
    const payStatus = async () =>
      (await query('SELECT status FROM payments WHERE stripe_charge_id=:c', { c: 'ch_b168r' }))[0].status;
    const refundEvt = (id, refund, amountRefunded) => ({
      id,
      type: 'charge.refunded',
      data: {
        object: {
          id: 'ch_b168r',
          amount: 10000,
          amount_refunded: amountRefunded,
          currency: 'usd',
          customer: 'cus_none',
          payment_intent: 'pi_b168r',
          refunds: { data: [refund] },
        },
      },
    });
    await billing.handleWebhookEvent(refundEvt('evt_b168_r1', { id: 're_b168_1', amount: 3000, status: 'succeeded' }, 3000), {});
    assert.equal(await payStatus(), 'partially_refunded', 'first split partial reads partially_refunded');
    await billing.handleWebhookEvent(refundEvt('evt_b168_r2', { id: 're_b168_2', amount: 7000, status: 'succeeded' }, 10000), {});
    assert.equal(await payStatus(), 'refunded', 'cumulative full refund reads refunded (S4#3)');
    n += 2;
    group('G payments', n);
  }

  /* ---------------- H — S1 session/oauth predicates ---------------- */
  {
    let n = 0;
    const mw = require(path.join(root, 'server/middleware.js'));
    const now = Date.now();
    assert.equal(mw.portalSessionAbsoluteExpired({ clientPortalId: 5, clientIssuedAt: now }), false, 'fresh portal session alive');
    assert.equal(
      mw.portalSessionAbsoluteExpired({ clientPortalId: 5, clientIssuedAt: now - 31 * 24 * 3600 * 1000 }),
      true,
      'portal session past the absolute cap is expired'
    );
    assert.equal(mw.portalSessionAbsoluteExpired({ clientPortalId: 5 }), true, 'unstamped portal session fails closed');
    assert.equal(mw.portalSessionAbsoluteExpired({}), false, 'no portal session → not applicable');
    assert.equal(mw.staffSessionAbsoluteExpired({ session: { userId: 1 } }), true, 'unstamped staff session fails closed');
    n += 5;
    // Drift pin: routes/portal.js carries its own copy of the cap
    // (it cannot take a new cross-file require — VM suites stub its
    // relative requires). Both copies must keep the same default.
    assert.equal(mw.PORTAL_ABSOLUTE_SESSION_MS, 30 * 24 * 60 * 60 * 1000, 'middleware portal cap default is 30d');
    assert.ok(
      read('server/routes/portal.js').includes("Number(process.env.PORTAL_ABSOLUTE_SESSION_MS) : 0) || 30 * 24 * 60 * 60 * 1000"),
      'portal.js local cap matches the middleware default'
    );
    assert.ok(read('server/routes/portal.js').includes('req.session.clientIssuedAt = Date.now();'), 'portal sessions are stamped at establishment');
    n += 3;
    // OAuth codes: stored hashed, redeemable once (S1#6).
    const oauth = require(path.join(root, 'server/mcpOAuth.js'));
    const platformDb = require(path.join(root, 'server/db.js'));
    await platformDb.migrate();
    const code = await oauth.createAuthorizationCode(
      { clientId: 'b168-client', redirectUri: 'https://client.example/cb', codeChallenge: 'x'.repeat(43) },
      { workspace_id: 1, lead_id: 2, email: 'oauth-b168@example.com', id: 77 }
    );
    const rows = await platformDb.query('SELECT code FROM mcp_oauth_auth_codes');
    assert.ok(rows.length >= 1, 'code row stored');
    assert.ok(!rows.some((r) => r.code === code), 'the RAW code is never what is stored');
    const { hashToken } = require(path.join(root, 'server/workspace.js'));
    assert.ok(rows.some((r) => r.code === hashToken(code)), 'the stored key is the code hash');
    const taken = await oauth.takeAuthCode(code);
    assert.ok(taken && taken.email === 'oauth-b168@example.com', 'code redeems by hash');
    const again = await oauth.takeAuthCode(code);
    assert.equal(again, null, 'code is single-use');
    n += 5;
    // F05 (external review harness, inverted): the REAL
    // requireWorkspace must (a) propagate the token class onto
    // req.auth and (b) refuse a vendor_design token's REST mutation
    // while allowing its reads — the reviewer's repro reached
    // leadsCreate on the pre-fix tree because the class was dropped.
    await platformDb.query(
      "INSERT INTO workspaces (id, name, slug) VALUES (7, 'Vendor Fixture WS', 'vendor-fixture-ws')"
    );
    const rawVendor = 'ws_vendor_b168_fixture_token';
    await platformDb.query(
      'INSERT INTO workspace_tokens (workspace_id, lead_id, token_hash, token_prefix, token_class) VALUES (7, NULL, ?, ?, ?)',
      [hashToken(rawVendor), 'ws_vendor', 'vendor_design']
    );
    const mwReal = require(path.join(root, 'server/middleware.js'));
    const runMw = (method, p) =>
      new Promise((resolve) => {
        const req = { headers: { authorization: `Bearer ${rawVendor}` }, method, path: p, session: null };
        const res = {
          statusCode: 200,
          body: null,
          status(c) {
            this.statusCode = c;
            return this;
          },
          json(b) {
            this.body = b;
            resolve({ req, res: this, nexted: false });
            return this;
          },
        };
        mwReal.requireWorkspace(req, res, () => resolve({ req, res, nexted: true }));
      });
    const denied = await runMw('POST', '/leads');
    assert.equal(denied.nexted, false, 'vendor POST /leads never reaches the route');
    assert.equal(denied.res.statusCode, 403, 'vendor POST /leads is refused');
    assert.equal(denied.res.body && denied.res.body.code, 'VENDOR_TOKEN_FORBIDDEN', 'refusal carries the vendor code');
    const allowed = await runMw('GET', '/leads');
    assert.equal(allowed.nexted, true, 'vendor GET /leads is allowed through');
    assert.equal(allowed.req.auth.tokenClass, 'vendor_design', 'the token class survives requireWorkspace onto req.auth');
    n += 5;
    group('H session/oauth', n);
  }

  /* ---------------- I — S7 chat + webinar hub ---------------- */
  {
    let n = 0;
    const chat = require(path.join(root, 'server/chatbot.js'));
    for (const [text, want] of [
      ['That is $999 total', [999]],
      ['$ 999', [999]],
      ['999 dollars', [999]],
      ['USD 999', [999]],
      ['€999', [999]],
      ['£1,250.50', [1250.5]],
      ['no money mentioned', []],
    ]) {
      assert.deepEqual(chat.chatStatedAmounts(text), want, `amounts in ${JSON.stringify(text)}`);
      n += 1;
    }
    // Miscapture containment (S7#3) through the 167 gate path.
    const Database = require(path.join(root, 'node_modules/better-sqlite3'));
    const db = new Database(':memory:');
    db.exec(
      `CREATE TABLE IF NOT EXISTS leads (id INTEGER PRIMARY KEY, business_name TEXT, email TEXT, status TEXT, phone TEXT);
       CREATE TABLE IF NOT EXISTS websites (id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id INTEGER, name TEXT, theme TEXT, pages TEXT, status TEXT, updated_at TEXT);`
    );
    const sm = require(path.join(root, 'server/siteModules.js'));
    sm.ensureTables(db);
    chat.ensureTables(db);
    const LEAD = 1;
    db.prepare("INSERT INTO leads (id, business_name, email, status) VALUES (1,'Chat Biz','c@x.invalid','customer')").run();
    chat.saveSettings(db, LEAD, {
      qualifying_enabled: true,
      qualifying_questions: ['What is your website address?'],
    });
    const sessInfo = db
      .prepare(
        "INSERT INTO chatbot_sessions (lead_id, session_token, status, needs_agent, last_visitor_at) VALUES (?, ?, 'open', 1, datetime('now'))"
      )
      .run(LEAD, 'b168-sess-1');
    const sessId = Number(sessInfo.lastInsertRowid);
    chat.recordQualificationUpdates(db, LEAD, sessId, [{ index: 0, status: 'asked' }]);
    const gated = chat.recordQualificationUpdates(
      db,
      LEAD,
      sessId,
      [{ index: 0, status: 'answered', answer: 'www.example.com' }],
      { guardMiscapture: true, latestVisitorText: 'What do you do?' }
    );
    assert.equal(gated.applied, 0, 'a fabricated answer inside a visitor QUESTION is gated');
    const rec = chat.getSessionQualification(db, sessId);
    assert.ok(!JSON.stringify(rec).includes('www.example.com'), 'the fabricated answer was not stored');
    n += 2;
    const okTurn = chat.recordQualificationUpdates(
      db,
      LEAD,
      sessId,
      [{ index: 0, status: 'answered', answer: 'example.com' }],
      { guardMiscapture: true, latestVisitorText: 'What do you do? My site is example.com' }
    );
    assert.equal(okTurn.applied, 1, 'a genuine answer embedded in a longer message still records');
    n += 1;
    // Webinar hub caps (S7#5): fake response objects.
    const webinars = require(path.join(root, 'server/webinars.js'));
    const mkRes = () => {
      const handlers = {};
      return { on: (ev, fn) => (handlers[ev] = fn), fire: (ev) => handlers[ev] && handlers[ev]() };
    };
    let accepted = 0;
    const ress = [];
    for (let i = 0; i < 210; i++) {
      const r = mkRes();
      ress.push(r);
      if (webinars.hubSubscribe(424242, r, { key: `ip:10.0.0.${i}` })) accepted++;
    }
    assert.equal(accepted, 200, 'per-webinar hub cap is enforced at 200');
    for (const r of ress) r.fire('close');
    let perKey = 0;
    for (let i = 0; i < 7; i++) {
      if (webinars.hubSubscribe(424243, mkRes(), { key: 'reg:55' })) perKey++;
    }
    assert.equal(perKey, 5, 'per-registration hub cap is enforced at 5');
    n += 2;
    group('I chat gates + webinar hub', n);
  }

  /* ---------------- J — exporter prune (S5#2) ---------------- */
  {
    let n = 0;
    const engine = require(path.join(root, 'src/websiteEngine.js'));
    assert.equal(typeof engine.exportStatic, 'function', 'exporter loads');
    // Source-level pin for the sweep contract (the full export
    // harness lives in the public-workspace suite): the recursive
    // sweep walks the whole tree and exempts the owner-upload and
    // domain-owned top-level trees.
    const srcText = read('src/websiteEngine.js');
    assert.ok(srcText.includes('const sweepDir = (dir, prefix) => {'), 'recursive stale sweep present');
    assert.ok(
      srcText.includes("name === 'images' || name === 'assets' || name === 'webinar'"),
      'sweep exemptions pinned (images/assets/webinar)'
    );
    n += 2;
    group('J exporter prune pins', n);
  }

  // ---- K: external review F02 — OAuth callback reflection ----
  {
    let n = 0;
    // The provider error params must never be reflected into the
    // text/html response of a public callback (reflected XSS).
    const social = read('server/routes/socialPublic.js');
    assert.ok(!social.includes('Meta OAuth error: ${'), 'meta callback does not reflect the error param');
    assert.ok(social.includes('Meta sign-in was not completed.'), 'meta callback answers with fixed copy');
    const gbp = read('server/routes/gbp.js');
    assert.ok(!gbp.includes('Google OAuth error: ${'), 'gbp callback does not reflect the error param');
    assert.ok(gbp.includes('Google sign-in was not completed.'), 'gbp callback answers with fixed copy');
    n += 4;
    group('K oauth callback reflection (F02)', n);
  }

  // ---- L: external review F04 — billing identities are not staff ----
  {
    let n = 0;
    const pb = read('server/portalBilling.js');
    assert.ok(pb.includes("billing_only)\n") && pb.includes("'member', 1)"), 'portal billing linkage inserts a billing_only row');
    assert.ok(!pb.includes("VALUES (:ws, :uid, 'member', CURRENT_TIMESTAMP)"), 'no plain member row is minted by billing');
    const ws = read('server/workspace.js');
    assert.ok(ws.includes('COALESCE(m.billing_only, 0) = 0'), 'membership lookups exclude billing-only rows');
    const dbjs = read('server/db.js');
    assert.ok(
      dbjs.includes("ensureColumnSqlite(db, 'workspace_members', 'billing_only'") &&
        dbjs.includes("ensureColumnMysql(conn, 'workspace_members', 'billing_only'"),
      'platform migration adds billing_only (both dialects)'
    );
    const schemaSql = read('sql/schema.sql');
    assert.ok(schemaSql.includes('billing_only'), 'fresh-install schema carries billing_only');
    n += 5;
    group('L billing-only membership (F04)', n);
  }

  // ---- M: external review F06 — attempt-scoped Stripe keys ----
  {
    let n = 0;
    const idem = require(path.join(root, 'server/stripeIdempotency.js'));
    const a1 = idem.stripeAttemptKey('subscription-update', 'sub_1', 'cancel_at_period_end=true');
    const a2 = idem.stripeAttemptKey('subscription-update', 'sub_1', 'cancel_at_period_end=true');
    assert.notEqual(a1, a2, 'two intentional cancels derive DIFFERENT keys (no replay collapse)');
    const d1 = idem.stripeIdempotencyKey('customer-create', 42);
    const d2 = idem.stripeIdempotencyKey('customer-create', 42);
    assert.equal(d1, d2, 'find-or-create keys stay deterministic');
    const billing = read('server/billing.js');
    for (const op of ['checkout-subscription', 'subscription-plan-change', 'checkout-credits', 'refund-admin', 'subscription-cancel']) {
      assert.ok(billing.includes(`stripeAttemptKey('${op}'`) || billing.includes(`stripeAttemptKey(\n`), `billing uses attempt keys (${op} site family)`);
      n += 1;
    }
    assert.ok(billing.includes("stripeIdempotencyKey('customer-create'"), 'customer create keeps the deterministic key');
    const ms = read('server/membershipStripe.js');
    assert.ok(ms.includes("stripeAttemptKey('subscription-update'"), 'membership cancel uses an attempt key');
    const sm = read('server/siteModules.js');
    assert.ok(sm.includes("stripeAttemptKey('checkout-membership'"), 'membership checkout uses an attempt key');
    assert.ok(sm.includes("stripeIdempotencyKey('checkout-shop'"), 'per-order shop checkout keeps its deterministic key');
    n += 5;
    group('M stripe attempt keys (F06)', n);
  }

  // ---- N: external review F10 — private attachment storage ----
  {
    let n = 0;
    const tmpPriv = fs.mkdtempSync(path.join(os.tmpdir(), 'b168-priv-'));
    const tmpExp = fs.mkdtempSync(path.join(os.tmpdir(), 'b168-exp-'));
    const prevPriv = process.env.PRIVATE_FILES_ROOT;
    const prevExp = process.env.EXPORT_ROOT;
    process.env.PRIVATE_FILES_ROOT = tmpPriv;
    process.env.EXPORT_ROOT = tmpExp;
    try {
      const ac = require(path.join(root, 'server/assistantChat.js'));
      const rel = 'assistant-chat/ws-9/1700000000000-abcdef012345.bin';
      // No file anywhere: a NEW write resolves under the private root.
      const fresh = ac.absFromRel(rel);
      assert.ok(fresh && fresh.startsWith(path.resolve(tmpPriv)), 'new attachment paths resolve under the private root');
      // Legacy file (pre-168, exports root): still readable via fallback.
      const legacyAbs = path.join(tmpExp, rel);
      fs.mkdirSync(path.dirname(legacyAbs), { recursive: true });
      fs.writeFileSync(legacyAbs, 'legacy');
      assert.equal(ac.absFromRel(rel), legacyAbs, 'legacy exports file still resolves for the checked handlers');
      // Private copy wins once migrated.
      const privAbs = path.join(tmpPriv, rel);
      fs.mkdirSync(path.dirname(privAbs), { recursive: true });
      fs.writeFileSync(privAbs, 'private');
      assert.equal(ac.absFromRel(rel), privAbs, 'private copy takes precedence');
      // Traversal is refused.
      assert.equal(ac.absFromRel('../outside.bin'), null, 'traversal outside the roots is refused');
      n += 4;
      const serverSrc = read('server.js');
      assert.ok(serverSrc.includes("seg === 'assistant-chat' || seg === 'site-chat'"), 'the public preview mount denies the private directory shapes');
      n += 1;
    } finally {
      if (prevPriv == null) delete process.env.PRIVATE_FILES_ROOT;
      else process.env.PRIVATE_FILES_ROOT = prevPriv;
      if (prevExp == null) delete process.env.EXPORT_ROOT;
      else process.env.EXPORT_ROOT = prevExp;
      fs.rmSync(tmpPriv, { recursive: true, force: true });
      fs.rmSync(tmpExp, { recursive: true, force: true });
    }
    group('N private attachments (F10)', n);
  }

  // ---- O: external review F11/F12 — credits accounting ----
  {
    let n = 0;
    const credits = require(path.join(root, 'server/credits.js'));
    // F12: the purchase-time snapshot wins over today's config.
    assert.equal(
      credits.creditsFromSession({ metadata: { pack_amount: '50', quantity: '1' } }, 100),
      50,
      'fulfillment grants the purchased pack size, not the current config'
    );
    assert.equal(
      credits.creditsFromSession({ metadata: { pack_amount: '50', quantity: '3' } }, 100),
      150,
      'snapshot pack size multiplies by the purchased quantity'
    );
    assert.equal(
      credits.creditsFromSession({ metadata: { credits: '70' } }, 100),
      70,
      'an explicit purchased credit total is honoured when no pack math was recorded'
    );
    assert.equal(
      credits.creditsFromSession({ metadata: {} }, 100),
      100,
      'legacy sessions without a snapshot fall back to the live config'
    );
    n += 4;
    // F11: cumulative clawback wiring.
    const creditsSrc = read('server/credits.js');
    assert.ok(creditsSrc.includes('cumulativeRefundedCents'), 'clawback takes the cumulative refunded total');
    assert.ok(creditsSrc.includes('stripe_refund_shortfall'), 'un-coverable clawbacks are recorded durably');
    assert.ok(creditsSrc.includes('entitlement_already_clawed'), 'a second refund cannot re-claw the same entitlement');
    const billingSrc = read('server/billing.js');
    assert.ok(billingSrc.includes('cumulativeRefundedCents: charge && charge.amount_refunded'), 'the refund handler passes Stripe cumulative amounts');
    n += 4;
    group('O credits refund/fulfillment (F11/F12)', n);
  }

  // ---- P: external review F13/F14 — standalone package + webhook ----
  {
    let n = 0;
    const dockerfile = read('Dockerfile');
    assert.ok(dockerfile.includes('COPY Dockerfile ./'), 'the release image carries its own Dockerfile (F13)');
    const sb = read('server/standaloneBackup.js');
    assert.ok(sb.includes('APP_TREE_INCOMPLETE'), 'the generator fails closed on a missing app-tree asset');
    const wh = read('server/routes/paymentsWebhook.js');
    assert.ok(wh.includes("router.post('/',"), 'the bare webhook path exists for single-site clones (F14)');
    assert.ok(wh.includes('isSingleSite()'), 'the bare path resolves only in single-site mode');
    const install = read('standalone/install.sh');
    for (const ev of ['invoice.paid', 'invoice.payment_failed', 'customer.subscription.deleted', 'checkout.session.async_payment_succeeded', 'payment_intent.payment_failed']) {
      assert.ok(install.includes(ev), `installer subscribes to ${ev}`);
      n += 1;
    }
    n += 4;
    group('P standalone installable (F13/F14)', n);
  }

  // ---- Q: external review F15/F16 — event loop + permissions policy ----
  {
    let n = 0;
    const sm = read('server/siteModules.js');
    assert.ok(!sm.includes('bcrypt.compareSync(password'), 'member login no longer blocks on sync bcrypt (F15)');
    assert.ok(!sm.includes('bcrypt.hashSync(password'), 'member signup/reset no longer block on sync bcrypt');
    assert.ok(sm.includes('async function loginMember'), 'member login is async');
    assert.ok(sm.includes('await bcrypt.compare(password, member.password_hash)'), 'member compare is awaited');
    n += 4;
    const sh = require(path.join(root, 'server/securityHeaders.js'));
    assert.ok(sh.permissionsPolicyFor({ path: '/api/v1/leads' }).includes('microphone=()'), 'staff/API surfaces keep the microphone disabled (F16)');
    assert.ok(sh.permissionsPolicyFor({ path: '/staff' }).includes('microphone=()'), 'staff pages keep the microphone disabled');
    assert.ok(sh.permissionsPolicyFor({ path: '/site-previews/ws1/site/index.html' }).includes('microphone=(self)'), 'app-hosted site documents may use the microphone');
    assert.ok(sh.permissionsPolicyFor({ path: '/embed/chat/abc' }).includes('microphone=(self)'), 'embed documents may use the microphone');
    n += 4;
    group('Q event loop + permissions (F15/F16)', n);
  }

  // ---- R: external review F09 — recording proxy session parity ----
  {
    let n = 0;
    const mw = read('server/middleware.js');
    assert.ok(mw.includes('loadSessionUser,'), 'middleware exports the session user loader');
    const calls = read('server/routes/calls.js');
    assert.ok(calls.includes('capsForStaff.loadUser'), 'the recording proxy loads the staff account');
    assert.ok(calls.includes("String(u.status || 'active') === 'disabled'"), 'a disabled staff account cannot play recordings');
    assert.ok(calls.includes('u.deleted_at'), 'a deleted staff account cannot play recordings');
    n += 4;
    group('R recording session parity (F09)', n);
  }

  console.log(`\nBatch 168 review-fixes regressions: ALL PASS — ${groups.join('; ')}`);
})().catch((err) => {
  console.error('\nBatch 168 review-fixes regressions FAILED:');
  console.error(err);
  process.exit(1);
});
