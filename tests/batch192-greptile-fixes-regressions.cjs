'use strict';
/**
 * Batch 192 — Greptile-verification fixes (Ely ordered "fix all",
 * 2026-11-15). One pin per CONFIRMED finding from
 * website-scout/greptile-review-2026-11-15-verification.md:
 *
 *   #15  Outreach SMS paths never consulted opt-out/suppression.
 *        Pins: an opted-out contact is skipped by BOTH the
 *        processQueue SMS branch (send-time) and the domain
 *        emailSend one-off SMS path, and at createCampaign queue
 *        time — no send call is made and the queue item is marked
 *        suppressed (terminal, not failed / not left queued).
 *   #23  A queued plain SMS (media_url empty) to a lead WITH a
 *        current screenshot is sent with NO media; a message WITH
 *        media_url still attaches it.
 *   #20  Two workspaces' website id 1 produce DIFFERENT screenshot
 *        folder paths/URLs; a write in one does not appear in the
 *        other; the /site-previews gate resolves the scoped folder
 *        to the right workspace.
 *   #5   A refund whose checkout-session lookup fails claws ONLY
 *        the grant matching the refunded payment_intent (two grants
 *        seeded; the older is refunded; the newest is untouched);
 *        an unidentifiable grant claws nothing and leaves a
 *        stripe_refund_unmatched manual-review marker.
 *   #12  A workspace with NO legacy ai.api_key but a routed
 *        platform provider configured passes the AI gate:
 *        generateSeoProposal does not throw AI_NOT_CONFIGURED and
 *        the previously-silent designLearning distill proceeds.
 *   #11  In a cold child process whose first workspace touch is a
 *        {create:false} read (which caches the readonly handle),
 *        generateStandaloneBackup completes without SQLITE_READONLY.
 *
 * Harness: in-process on temp platform + tenant DBs (batch191
 * pattern); #11 spawns a child process for a genuinely cold handle
 * cache. Real-server header convention: CAPTCHA_OPTIONAL=1 +
 * APP_URL are set below.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b192-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch192', 'test', 'session', 'secret'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY =
  process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 19).toString('base64');

let passed = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) {
    passed++;
    console.log(`  ok - ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL - ${name}${extra ? ` :: ${extra}` : ''}`);
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    check(name, true);
  } catch (e) {
    check(name, false, String((e && e.message) || e).slice(0, 300));
  }
}

const PHONE_OUT = '5550101001'; // opted-out lead
const PHONE_PLAIN = '5550101002'; // plain-SMS lead (has a current screenshot)
const PHONE_MEDIA = '5550101003'; // media_url lead
const norm = (p) => '+1' + p;

(async () => {
  const platformDb = require(path.join(root, 'server/db.js'));
  await platformDb.migrate();
  const query = platformDb.query;
  const { openWorkspaceDb } = require(path.join(root, 'server/workspaceDb.js'));

  /* ================= #5 — PI-fallback clawback targeting ================= */
  console.log('batch192 #5: refund clawback targets the refunded payment\u2019s own grant');
  {
    const credits = require(path.join(root, 'server/credits.js'));
    const WS = 77;
    await query('INSERT INTO credit_balances (workspace_id, balance) VALUES (:ws, 250)', { ws: WS });
    // Older grant: 100 credits, session cs_192_old, PI pi_192_old.
    // Newer grant: 150 credits, session cs_192_new, PI pi_192_new.
    // The PI is stamped via UPDATE (guarded) so this suite also runs
    // against the pre-192 tree for the fail-side proof, where the
    // column — and the PI recording — do not exist yet.
    await query(
      `INSERT INTO credit_ledger (workspace_id, user_id, delta, balance_after, reason, ref_type, ref_id, stripe_checkout_session_id)
       VALUES (:ws, 7, 100, 100, 'stripe_purchase', 'checkout_session', 'cs_192_old', 'cs_192_old')`,
      { ws: WS }
    );
    await query(
      `INSERT INTO credit_ledger (workspace_id, user_id, delta, balance_after, reason, ref_type, ref_id, stripe_checkout_session_id)
       VALUES (:ws, 7, 150, 250, 'stripe_purchase', 'checkout_session', 'cs_192_new', 'cs_192_new')`,
      { ws: WS }
    );
    try {
      await query(`UPDATE credit_ledger SET stripe_payment_intent_id = 'pi_192_old' WHERE stripe_checkout_session_id = 'cs_192_old'`);
      await query(`UPDATE credit_ledger SET stripe_payment_intent_id = 'pi_192_new' WHERE stripe_checkout_session_id = 'cs_192_new'`);
    } catch {
      /* pre-192 tree: no PI column — the fallback defect is the point */
    }
    await query(
      `INSERT INTO payments (user_id, stripe_payment_intent_id, amount_cents, currency, status, description)
       VALUES (7, 'pi_192_old', 10000, 'usd', 'succeeded', 'Credits pack (+100) for workspace #77')`
    );
    await query(
      `INSERT INTO payments (user_id, stripe_payment_intent_id, amount_cents, currency, status, description)
       VALUES (7, 'pi_192_new', 15000, 'usd', 'succeeded', 'Credits pack (+150) for workspace #77')`
    );
    // A payment whose grant predates PI recording: payments row only.
    await query(
      `INSERT INTO payments (user_id, stripe_payment_intent_id, amount_cents, currency, status, description)
       VALUES (7, 'pi_192_ghost', 5000, 'usd', 'succeeded', 'Credits pack (+50) for workspace #77')`
    );

    // Refund the OLDER pack with NO checkout session (the degraded
    // path: billing.js session lookup failed).
    const res = await credits.clawbackFromRefund({
      checkoutSessionId: null,
      refundId: 're_192_a',
      paymentIntentId: 'pi_192_old',
      cumulativeRefundedCents: 10000,
      chargeAmountCents: 10000,
    });
    check('#5: PI-fallback clawback reports clawed', res && res.clawed === true, JSON.stringify(res));
    check('#5: balance drops by the OLDER grant only (250 -> 150)', (await credits.getBalance(WS)) === 150);
    const clawRows = await query(
      `SELECT stripe_checkout_session_id FROM credit_ledger WHERE workspace_id = :ws AND reason = 'stripe_refund' AND delta < 0`,
      { ws: WS }
    );
    check(
      '#5: the single claw row is keyed to the older grant session',
      clawRows.length === 1 && String(clawRows[0].stripe_checkout_session_id).startsWith('refund:cs_192_old:'),
      JSON.stringify(clawRows)
    );

    // Unidentifiable grant: no ledger row carries pi_192_ghost.
    const res2 = await credits.clawbackFromRefund({
      checkoutSessionId: null,
      refundId: 're_192_b',
      paymentIntentId: 'pi_192_ghost',
      cumulativeRefundedCents: 5000,
      chargeAmountCents: 5000,
    });
    check(
      '#5: unidentifiable grant claws nothing + flags manual review',
      res2 && res2.clawed === false && res2.reason === 'grant_unmatched_manual_review',
      JSON.stringify(res2)
    );
    check('#5: balance unchanged after unidentifiable refund', (await credits.getBalance(WS)) === 150);
    const markers = await query(
      `SELECT stripe_checkout_session_id FROM credit_ledger WHERE workspace_id = :ws AND reason = 'stripe_refund_unmatched' AND delta = 0`,
      { ws: WS }
    );
    check(
      '#5: manual-review marker recorded for the unmatched refund',
      markers.length === 1 && String(markers[0].stripe_checkout_session_id).includes('pi_192_ghost'),
      JSON.stringify(markers)
    );
  }

  /* ================= #15 + #23 — outreach SMS ================= */
  console.log('batch192 #15/#23: outreach SMS opt-out suppression + no silent MMS upgrade');
  {
    const outreach = require(path.join(root, 'src/outreach.js'));
    const portalContacts = require(path.join(root, 'server/portalContacts.js'));
    const shots = require(path.join(root, 'src/siteScreenshots.js'));
    const db = openWorkspaceDb(11);
    outreach.ensureTables(db);
    portalContacts.ensureTables(db);

    const insLead = db.prepare(
      `INSERT INTO leads (id, business_name, phone, email, status) VALUES (?, ?, ?, ?, 'new')`
    );
    insLead.run(1, 'Opted Out Biz', PHONE_OUT, 'out@example.com');
    insLead.run(2, 'Plain Sms Biz', PHONE_PLAIN, 'plain@example.com');
    insLead.run(3, 'Media Biz', PHONE_MEDIA, 'media@example.com');

    // Lead 1 texted STOP: LeadScout contact carries the opt-out stamp.
    db.prepare(
      `INSERT INTO leadscout_contacts (phone_norm, sms_opted_out_at) VALUES (?, datetime('now'))`
    ).run(portalContacts.normPhone(norm(PHONE_OUT)));

    // Lead 2 HAS a current MMS screenshot on file (the #23 trap).
    shots.ensureTables(db);
    db.prepare(
      `INSERT INTO site_screenshots (website_id, lead_id, version, is_current, page, viewport, kind, storage_path, public_url)
       VALUES (1, 2, 1, 1, 'home', 'desktop', 'mms', '/tmp/b192-shot.jpg', 'https://bitpype.test/site-previews/ws-11-site-1/screenshots/v1/home-desktop-mms.jpg')`
    ).run();
    db.prepare(
      `INSERT INTO site_screenshots (website_id, lead_id, version, is_current, page, viewport, kind, storage_path, public_url)
       VALUES (1, 2, 1, 1, 'home', 'desktop', 'email', '/tmp/b192-shot-e.jpg', 'https://bitpype.test/site-previews/ws-11-site-1/screenshots/v1/home-desktop-email.jpg')`
    ).run();

    const tpl0 = db
      .prepare(`INSERT INTO email_templates (name, subject, body, sms_body, channel) VALUES ('B192 Template', 'Hi', 'Body', 'Text body', 'both')`)
      .run();
    db.prepare(
      `INSERT INTO campaigns (id, name, template_id, status, rate_per_hour) VALUES (1, 'B192 Campaign', ?, 'active', 1000)`
    ).run(Number(tpl0.lastInsertRowid));
    const insMsg = db.prepare(
      `INSERT INTO campaign_messages (campaign_id, lead_id, to_email, subject, body, status, scheduled_at, error, channel, to_phone, media_url, send_mode)
       VALUES (1, ?, ?, '(SMS)', 'Hello from Batch 192', 'queued', NULL, NULL, 'sms', ?, ?, ?)`
    );
    const mOut = Number(insMsg.run(1, norm(PHONE_OUT), norm(PHONE_OUT), null, 'sms').lastInsertRowid);
    const mPlain = Number(insMsg.run(2, norm(PHONE_PLAIN), norm(PHONE_PLAIN), null, 'sms').lastInsertRowid);
    const mMedia = Number(
      insMsg.run(3, norm(PHONE_MEDIA), norm(PHONE_MEDIA), 'https://bitpype.test/media/intended.jpg', 'mms_pending')
        .lastInsertRowid
    );

    const stubSends = () =>
      db
        .prepare(`SELECT message FROM activity_log WHERE area = 'outreach' AND message LIKE '[stub]%'`)
        .all()
        .map((r) => r.message);
    const msgStatus = (id) => db.prepare('SELECT status, error FROM campaign_messages WHERE id = ?').get(id);

    const q = await outreach.processQueue(db);
    check('#15: processQueue marks the opted-out SMS suppressed', msgStatus(mOut).status === 'suppressed', JSON.stringify(msgStatus(mOut)));
    check(
      '#15: processQueue suppression reason names the opt-out check',
      /opt-out/.test(String(msgStatus(mOut).error || '')),
      String(msgStatus(mOut).error || '')
    );
    check(
      '#15: NO send was attempted to the opted-out number',
      !stubSends().some((m) => m.includes(norm(PHONE_OUT))),
      JSON.stringify(stubSends())
    );
    check('#15/#23: queue result counts the suppression', q && q.suppressed >= 1, JSON.stringify(q));

    check('#23: plain SMS to a lead WITH a screenshot is sent', msgStatus(mPlain).status === 'sent', JSON.stringify(msgStatus(mPlain)));
    const plainSend = stubSends().find((m) => m.includes(norm(PHONE_PLAIN)));
    check('#23: plain SMS went out with NO media attached', !!plainSend && !/media=/.test(plainSend), String(plainSend || '(no send)'));
    check('#23: plain SMS send_mode stayed sms', db.prepare('SELECT send_mode FROM campaign_messages WHERE id = ?').get(mPlain).send_mode === 'sms');

    check('#23: media-intent message is sent', msgStatus(mMedia).status === 'sent', JSON.stringify(msgStatus(mMedia)));
    const mediaSend = stubSends().find((m) => m.includes(norm(PHONE_MEDIA)));
    check(
      '#23: media-intent message still attaches its media',
      !!mediaSend && mediaSend.includes('media=https://bitpype.test/media/intended.jpg'),
      String(mediaSend || '(no send)')
    );

    // createCampaign queue-time suppression (#15b).
    const camp = outreach.createCampaign(db, {
      name: 'B192 Opt-Out Campaign',
      templateId: Number(tpl0.lastInsertRowid),
      leadIds: [1],
      channel: 'sms',
    });
    const campMsg = db
      .prepare('SELECT status, error FROM campaign_messages WHERE campaign_id = ? AND channel = ?')
      .get(camp.id, 'sms');
    check(
      '#15: createCampaign queues an opted-out SMS as suppressed, never queued',
      camp.queued === 0 && camp.suppressed >= 1 && campMsg && campMsg.status === 'suppressed',
      JSON.stringify({ camp, campMsg })
    );

    // domain emailSend one-off SMS path (#15c).
    const domain = require(path.join(root, 'server/domain.js'));
    const mOneOff = Number(insMsg.run(1, norm(PHONE_OUT), norm(PHONE_OUT), null, 'sms').lastInsertRowid);
    // The one-off message belongs to an active campaign row too (the
    // single-send path only requires the message itself to be queued).
    const sendsBefore = stubSends().length;
    const oneOff = await domain.emailSend(11, mOneOff);
    check(
      '#15: emailSend one-off SMS to an opted-out number is suppressed, not sent',
      oneOff && oneOff.sent === false && oneOff.suppressed === true && msgStatus(mOneOff).status === 'suppressed',
      JSON.stringify({ oneOff, st: msgStatus(mOneOff) })
    );
    check('#15: emailSend made no send call for the opted-out number', stubSends().length === sendsBefore);
  }

  /* ================= #20 — workspace-scoped screenshots ================= */
  console.log('batch192 #20: screenshot folders/URLs are workspace-scoped');
  {
    const shots = require(path.join(root, 'src/siteScreenshots.js'));
    const { workspaceIdFromDb } = require(path.join(root, 'src/assetValidation.js'));
    const previewSecurity = require(path.join(root, 'server/previewSecurity.js'));

    const f1 = shots.shotFolder(1, 1);
    const f2 = shots.shotFolder(1, 2);
    check('#20: same website id in two workspaces -> different folders', f1 !== f2, `${f1} vs ${f2}`);
    check(
      '#20: folders carry the canonical ws-{ws}-site-{id} shape',
      f1.endsWith(path.join('ws-1-site-1', 'screenshots')) && f2.endsWith(path.join('ws-2-site-1', 'screenshots')),
      `${f1} / ${f2}`
    );
    const u1 = shots.publicUrlFor(1, 'v1/home-desktop.png', 1);
    const u2 = shots.publicUrlFor(1, 'v1/home-desktop.png', 2);
    check(
      '#20: public URLs are workspace-scoped too',
      u1.includes('/site-previews/ws-1-site-1/screenshots/') && u2.includes('/site-previews/ws-2-site-1/screenshots/'),
      `${u1} / ${u2}`
    );

    // End-to-end through real tenant handles: ws id derives from the
    // db file path, and a write under one workspace's folder does not
    // appear under the other's.
    const dbA = openWorkspaceDb(21);
    const dbB = openWorkspaceDb(22);
    check('#20: workspace id derives from tenant db handles', workspaceIdFromDb(dbA) === 21 && workspaceIdFromDb(dbB) === 22);
    const folderA = shots.shotFolder(1, workspaceIdFromDb(dbA));
    const folderB = shots.shotFolder(1, workspaceIdFromDb(dbB));
    fs.mkdirSync(folderA, { recursive: true });
    fs.writeFileSync(path.join(folderA, 'only-in-a.png'), 'A');
    check(
      '#20: a write in workspace A\u2019s folder does not appear in workspace B\u2019s',
      fs.existsSync(path.join(folderA, 'only-in-a.png')) && !fs.existsSync(path.join(folderB, 'only-in-a.png'))
    );
    check(
      '#20: /site-previews gate resolves the scoped screenshot folder to its own workspace',
      JSON.stringify(previewSecurity.resolvePreviewSite('/ws-22-site-1/screenshots/v1/home-desktop.png')) ===
        JSON.stringify({ workspaceId: 22, siteId: 1 })
    );
    check(
      '#20: legacy site-{id} folder still resolves (read-compat for existing shots)',
      JSON.stringify(previewSecurity.resolvePreviewSite('/site-1/screenshots/v1/home-desktop.png')) ===
        JSON.stringify({ workspaceId: 1, siteId: 1 })
    );
  }

  /* ================= #12 — routed AI gate ================= */
  console.log('batch192 #12: routed provider config passes the AI pre-gates');
  {
    const ai = require(path.join(root, 'src/ai.js'));
    const platform = require(path.join(root, 'server/platform.js'));
    const db = openWorkspaceDb(31);
    // No legacy key anywhere on this workspace.
    check('#12: fixture workspace has no legacy ai.api_key', ai.aiConfigured(db) === false);
    await checkAsync('#12: with nothing configured the routed gate still refuses (legacy behaviour)', async () => {
      assert.equal(await ai.aiConfiguredRouted(db, 'editor'), false);
    });

    // Platform-keyed Muse profile, routed as primary for editor + qa.
    await platform.setPlatformSetting('muse.model_api_key', 'batch192-fake-muse-key');
    await platform.setPlatformSetting('ai.route.editor.primary', 'muse');
    await platform.setPlatformSetting('ai.route.editor.fallback', 'none');
    await platform.setPlatformSetting('ai.route.qa.primary', 'muse');
    await platform.setPlatformSetting('ai.route.qa.fallback', 'none');
    await checkAsync('#12: routed gate passes with platform provider only (no legacy key)', async () => {
      assert.equal(await ai.aiConfiguredRouted(db, 'editor'), true);
      assert.equal(await ai.aiConfiguredRouted(db, 'qa'), true);
    });

    // Stub the provider wire: any chat/completions call answers with
    // a payload both consumers below can parse.
    const urlSafety = require(path.join(root, 'server/urlSafety.js'));
    const origAssert = urlSafety.assertAiBaseUrl;
    urlSafety.assertAiBaseUrl = async () => {};
    const realFetch = global.fetch;
    global.fetch = async (url, opts) => {
      const body = JSON.parse(String((opts && opts.body) || '{}'));
      const sys = String(((body.messages || [])[0] || {}).content || '');
      const content = /distill/i.test(sys)
        ? JSON.stringify({ lessons: [{ category: 'cta', lesson: 'Keep the call button visible above the fold' }] })
        : JSON.stringify({
            keywords: { primary: 'fixture plumber reading pa', supporting: [] },
            values: {},
            schemaDescription: 'Fixture plumbing in Reading, PA.',
          });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content } }],
          usage: { prompt_tokens: 10, completion_tokens: 10 },
        }),
      };
    };
    try {
      // Fixture site for the SEO thrower path.
      db.prepare(
        `INSERT INTO leads (id, business_name, category, phone, email, city, state) VALUES (3101, 'Fixture Plumbing Co', 'plumber', '555-0199', 'fix@example.com', 'Reading', 'PA')`
      ).run();
      const pages = [
        {
          slug: 'index',
          title: 'Home',
          description: '',
          sections: [{ type: 'heading', content: { title: 'Fixture Plumbing Co' } }],
        },
      ];
      db.prepare(
        `INSERT INTO websites (id, lead_id, name, industry, theme, pages, status) VALUES (3101, 3101, 'Fixture Plumbing Co', 'plumber', '{}', ?, 'draft')`
      ).run(JSON.stringify(pages));

      const seoTool = require(path.join(root, 'server/seoTool.js'));
      await checkAsync('#12: generateSeoProposal does NOT throw AI_NOT_CONFIGURED under routed-only config', async () => {
        const state = await seoTool.generateSeoProposal(db, 3101);
        assert.ok(state && state.site && state.site.id === 3101);
        const row = db.prepare('SELECT status FROM seo_proposals WHERE website_id = 3101').get();
        assert.ok(row && row.status === 'pending', 'proposal persisted');
      });

      // A previously-silent enhancement path proceeds: designLearning
      // distill used to return reason 'ai_not_configured'.
      const learning = require(path.join(root, 'src/designLearning.js'));
      learning.ensureTables(db);
      db.prepare(
        `INSERT INTO design_learning_events (event_type, category, summary) VALUES ('observe', 'cta', 'Client asked for a bigger call button')`
      ).run();
      await checkAsync('#12: designLearning distill proceeds under routed-only config', async () => {
        const res = await learning.distillWithAi(db);
        assert.ok(res && res.ok === true, JSON.stringify(res));
      });
    } finally {
      global.fetch = realFetch;
      urlSafety.assertAiBaseUrl = origAssert;
    }
  }

  /* ================= #11 — cold-process standalone backup ================= */
  console.log('batch192 #11: cold-process generateStandaloneBackup writes through a writable handle');
  {
    const workspace = require(path.join(root, 'server/workspace.js'));
    const made = await workspace.createUserWithWorkspace({
      email: 'owner-b192@example.com',
      password: ['Batch192', 'Owner', 'Pass'].join('-') + '!',
      name: 'Owner B192',
      workspaceName: 'Batch192 Cold Backup',
    });
    const wsId = Number(made.workspaceId || made.workspace_id || made.id);
    const db = openWorkspaceDb(wsId);
    db.prepare(
      `INSERT INTO leads (id, business_name, email, status) VALUES (19201, 'Cold Backup Biz', 'cold@example.com', 'customer')`
    ).run();
    const pages = [
      {
        slug: 'index',
        title: 'Home',
        sections: [
          { type: 'heading', content: { title: 'Cold Backup Biz' } },
          { type: 'text', content: { body: 'Cold-process backup fixture.' } },
        ],
      },
    ];
    db.prepare('INSERT INTO websites (id, lead_id, name, pages, theme) VALUES (19201, 19201, ?, ?, ?)')
      .run('Cold Backup Biz', JSON.stringify(pages), JSON.stringify({ colors: { primary: '#224422' } }));

    // Child process: genuinely cold handle cache. Its FIRST touch of
    // the workspace is a {create:false} read (the public-preview
    // pattern that caches the readonly handle), then the generator.
    const childScript = path.join(temp, 'b192-cold-child.cjs');
    fs.writeFileSync(
      childScript,
      [
        "'use strict';",
        `const path = require('node:path');`,
        `const root = ${JSON.stringify(root)};`,
        '(async () => {',
        '  const platformDb = require(path.join(root, "server/db.js"));',
        '  await platformDb.migrate();',
        '  const { openWorkspaceDb } = require(path.join(root, "server/workspaceDb.js"));',
        `  const ro = openWorkspaceDb(${wsId}, { create: false });`,
        '  if (!ro) { console.log("CHILD_NO_DB"); process.exit(2); }',
        '  const backup = require(path.join(root, "server/standaloneBackup.js"));',
        `  const out = await backup.generateStandaloneBackup({ workspaceId: ${wsId}, websiteId: 19201, workDir: ${JSON.stringify(path.join(temp, 'cold-gen'))} });`,
        '  console.log("GEN_OK " + out.packageName);',
        '})().catch((e) => { console.log("GEN_FAIL " + (e.code || "") + " " + String(e.message || e)); process.exit(1); });',
        '',
      ].join('\n')
    );
    const child = spawnSync(process.execPath, [childScript], {
      cwd: root,
      env: { ...process.env },
      encoding: 'utf8',
      timeout: 300000,
    });
    const childOut = `${child.stdout || ''}\n${child.stderr || ''}`;
    check(
      '#11: cold-process backup generation completes (no SQLITE_READONLY)',
      child.status === 0 && /GEN_OK/.test(childOut),
      childOut.slice(-400)
    );
  }

  console.log(`\nbatch192: ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('FAILURES:\n - ' + failures.join('\n - '));
    process.exit(1);
  }
})().catch((e) => {
  console.error('batch192 suite crashed:', e);
  process.exit(1);
});
