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
 *   #7   (detailed A, added 2026-11-16) vendor_design tokens are
 *        barred from design.setContact / design.emailQuestions /
 *        design.emailDelivery on MCP (policy + real dispatch) and
 *        REST (policy + real requireWorkspace guard), while the
 *        legitimate design surface stays allowed and standard
 *        tokens are unaffected.
 *   #8   (detailed C) two concurrent resetMemberPassword calls with
 *        one token: exactly one succeeds, the loser gets
 *        RESET_INVALID, and the winner's password is the one set.
 *   #9   (detailed D) authorize.html re-GETs the original /authorize
 *        URL after a mid-flow portal login (fresh user-bound park via
 *        full revalidation — the pre-auth park is never resurrected);
 *        flow pins: sign-in mid-flow reaches consent and mints a
 *        code, login alone still yields NO_PENDING, and a park bound
 *        to a different user still 403s PENDING_USER_MISMATCH.
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

  /* ============ #7 (detailed A) — vendor tokens cannot send email ============ */
  console.log('batch192 #7: vendor_design tokens are barred from the design contact/email tools (MCP + REST)');
  {
    const vt = require(path.join(root, 'server/vendorTools.js'));
    check('#7: MCP policy denies design.setContact for vendor tokens', vt.vendorToolAllowed('design.setContact') === false);
    check('#7: MCP policy denies design.emailQuestions for vendor tokens', vt.vendorToolAllowed('design.emailQuestions') === false);
    check('#7: MCP policy denies design.emailDelivery for vendor tokens', vt.vendorToolAllowed('design.emailDelivery') === false);
    check(
      '#7: legitimate design tools stay allowed for vendor tokens',
      vt.vendorToolAllowed('design.deliver') === true && vt.vendorToolAllowed('design.list') === true && vt.vendorToolAllowed('website.edit') === true
    );
    check(
      '#7: REST policy denies the three design contact/email suffixes',
      vt.vendorRestAllowed('POST', '/design/42/contact') === false &&
        vt.vendorRestAllowed('POST', '/design/42/email-questions') === false &&
        vt.vendorRestAllowed('POST', '/design/42/email-delivery') === false
    );
    check(
      '#7: REST policy keeps legitimate design writes allowed',
      vt.vendorRestAllowed('POST', '/design/jobs') === true && vt.vendorRestAllowed('POST', '/websites/40/preview') === true
    );

    // Dispatch level — the real MCP gate (batch103 pattern).
    const workspaceMod = require(path.join(root, 'server/workspace.js'));
    const made7 = await workspaceMod.createUserWithWorkspace({
      email: 'vendor-b192@example.com',
      password: 'vendor-b192-pass',
      name: 'Vendor B192',
      workspaceName: 'Batch192 Vendor',
    });
    const ws7 = Number(made7.workspaceId);
    const mcp = require(path.join(root, 'server/mcp.js'));
    const vctx = { tokenClass: 'vendor_design', tokenPrefix: 'ws_vendor_b192' };
    for (const t of ['design.setContact', 'design.emailQuestions', 'design.emailDelivery']) {
      const r = await mcp.callTool(ws7, t, { id: 1, jobId: 1, email: 'x@example.com' }, vctx);
      check(`#7: MCP dispatch refuses ${t} for a vendor token`, !!(r && r.ok === false && r.error === 'VENDOR_TOKEN_FORBIDDEN'), JSON.stringify(r).slice(0, 200));
    }
    const okRes7 = await mcp.callTool(ws7, 'settings.get', {}, vctx);
    check('#7: vendor token can still do allowed work (settings.get)', !!(okRes7 && okRes7.ok === true), JSON.stringify(okRes7).slice(0, 200));
    const stdRes7 = await mcp.callTool(ws7, 'design.setContact', { id: 999999, email: 'x@example.com' }, { tokenClass: 'standard' });
    check(
      '#7: standard token is NOT vendor-refused for design.setContact',
      !(stdRes7 && stdRes7.error === 'VENDOR_TOKEN_FORBIDDEN'),
      JSON.stringify(stdRes7).slice(0, 200)
    );

    // REST level — the real requireWorkspace guard (batch168 pattern).
    const { hashToken } = require(path.join(root, 'server/workspace.js'));
    const rawVendor7 = 'ws_vendor_b192_rest_fixture';
    await query(
      'INSERT INTO workspace_tokens (workspace_id, lead_id, token_hash, token_prefix, token_class) VALUES (:ws, NULL, :h, :p, :c)',
      { ws: ws7, h: hashToken(rawVendor7), p: 'ws_vendor', c: 'vendor_design' }
    );
    const mw7 = require(path.join(root, 'server/middleware.js'));
    const runMw7 = (method, p) =>
      new Promise((resolve) => {
        const req = { headers: { authorization: `Bearer ${rawVendor7}` }, method, path: p, session: null };
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
        mw7.requireWorkspace(req, res, () => resolve({ req, res, nexted: true }));
      });
    const deniedRest7 = await runMw7('POST', '/design/42/email-delivery');
    check(
      '#7: REST guard refuses vendor POST /design/:id/email-delivery with VENDOR_TOKEN_FORBIDDEN',
      deniedRest7.nexted === false && deniedRest7.res.statusCode === 403 && !!(deniedRest7.res.body && deniedRest7.res.body.code === 'VENDOR_TOKEN_FORBIDDEN'),
      JSON.stringify(deniedRest7.res.body)
    );
    const allowedRest7 = await runMw7('POST', '/design/jobs');
    check('#7: REST guard still allows vendor POST /design/jobs', allowedRest7.nexted === true);
  }

  /* ============ #8 (detailed C) — member reset token race ============ */
  console.log('batch192 #8: two concurrent member password resets with one token — exactly one wins');
  {
    const sm = require(path.join(root, 'server/siteModules.js'));
    const db = openWorkspaceDb(19208);
    const LEAD8 = 19208;
    db.prepare(`INSERT INTO leads (id, business_name, email, status) VALUES (?, ?, ?, 'customer')`).run(LEAD8, 'Reset Race Biz', 'race@example.com');
    await sm.signupMember(db, LEAD8, { name: 'Race Member', email: 'race@example.com', password: 'password123' });
    const rr8 = sm.requestMemberReset(db, LEAD8, 'race@example.com');
    check('#8: fixture reset token issued', !!(rr8 && rr8.resetToken));
    const attempts8 = await Promise.allSettled([
      sm.resetMemberPassword(db, LEAD8, rr8.resetToken, 'winner-pass-1'),
      sm.resetMemberPassword(db, LEAD8, rr8.resetToken, 'loser-pass-12'),
    ]);
    const wins8 = attempts8.filter((a) => a.status === 'fulfilled');
    const losses8 = attempts8.filter((a) => a.status === 'rejected');
    check(
      '#8: exactly one of two concurrent resets with one token succeeds',
      wins8.length === 1 && losses8.length === 1,
      JSON.stringify(attempts8.map((a) => a.status))
    );
    check(
      '#8: the loser is refused RESET_INVALID',
      losses8.length === 1 && !!(losses8[0].reason && losses8[0].reason.code === 'RESET_INVALID'),
      String(losses8[0] && losses8[0].reason && losses8[0].reason.code)
    );
    const winnerPw8 = attempts8[0].status === 'fulfilled' ? 'winner-pass-1' : 'loser-pass-12';
    const loserPw8 = attempts8[0].status === 'fulfilled' ? 'loser-pass-12' : 'winner-pass-1';
    await checkAsync('#8: the winning password is the one that sticks', async () => {
      const li = await sm.loginMember(db, LEAD8, { email: 'race@example.com', password: winnerPw8 });
      assert.ok(li.session && li.session.token);
      await assert.rejects(
        sm.loginMember(db, LEAD8, { email: 'race@example.com', password: loserPw8 }),
        (e) => e.code === 'INVALID_CREDENTIALS'
      );
    });
  }

  /* ============ #9 (detailed D) — OAuth sign-in mid-flow reaches consent ============ */
  console.log('batch192 #9: signing in mid-authorization reaches consent; cross-user parks still 403');
  {
    // Source pin: the authorize page re-runs the original /authorize
    // request after a successful login (fresh, user-bound park via
    // full revalidation) instead of going straight to refresh().
    const authzHtml = fs.readFileSync(path.join(root, 'public/authorize.html'), 'utf8');
    const loginAt = authzHtml.indexOf("api('/api/v1/portal/login'");
    const reauthAt = authzHtml.indexOf('window.location.href', loginAt);
    const refreshAt = authzHtml.indexOf('await refresh()', loginAt);
    check(
      '#9: authorize.html re-GETs the original /authorize URL after login, before refresh()',
      loginAt > -1 && reauthAt > loginAt && refreshAt > reauthAt && authzHtml.slice(reauthAt, reauthAt + 120).includes("redirect: 'manual'"),
      `login=${loginAt} reauth=${reauthAt} refresh=${refreshAt}`
    );

    // Flow level: a minimal app mounting the REAL portal + OAuth
    // session routers behind the portal session cookie, exactly as
    // server.js mounts them (in-memory session store stands in for
    // the MySQL store; regeneration semantics are express-session's).
    const express = require('express');
    const session = require('express-session');
    const bcrypt = require('bcryptjs');
    const crypto = require('node:crypto');
    const workspaceMod9 = require(path.join(root, 'server/workspace.js'));
    const made9 = await workspaceMod9.createUserWithWorkspace({
      email: 'oauth-b192@example.com',
      password: 'oauth-b192-pass',
      name: 'OAuth B192',
      workspaceName: 'Batch192 OAuth',
    });
    const ws9 = Number(made9.workspaceId);
    await query('UPDATE users SET is_super_admin = 1 WHERE id = :id', { id: Number(made9.userId) }); // paid plan for consent
    const db9 = openWorkspaceDb(ws9);
    db9.prepare(`INSERT INTO leads (id, business_name, email, status) VALUES (19209, 'OAuth Biz', 'oauth-b192@example.com', 'customer')`).run();
    const portalHash = bcrypt.hashSync('portal-pass-192', 12);
    const insA = await query(
      `INSERT INTO client_portal_users (email, password_hash, workspace_id, lead_id, business_name, status)
       VALUES ('oauth-b192@example.com', :h, :ws, 19209, 'OAuth Biz', 'active')`,
      { h: portalHash, ws: ws9 }
    );
    const userA9 = Number(insA.insertId);
    const insB = await query(
      `INSERT INTO client_portal_users (email, password_hash, workspace_id, lead_id, business_name, status)
       VALUES ('oauth-b192-b@example.com', :h, :ws, 19209, 'OAuth Biz', 'active')`,
      { h: portalHash, ws: ws9 }
    );
    const userB9 = Number(insB.insertId);
    check('#9: two distinct portal users seeded in one workspace', userA9 > 0 && userB9 > 0 && userA9 !== userB9, `${userA9}/${userB9}`);

    const oauth = require(path.join(root, 'server/mcpOAuth.js'));
    const registered = await oauth.registerClient({
      redirect_uris: ['http://127.0.0.1:8911/callback'],
      client_name: 'B192 Test Client',
    });
    const challenge = crypto.createHash('sha256').update('b192-verifier').digest('base64url');
    const authzQuery =
      `response_type=code&client_id=${encodeURIComponent(registered.client_id)}` +
      `&redirect_uri=${encodeURIComponent('http://127.0.0.1:8911/callback')}` +
      `&state=state192&code_challenge=${challenge}&code_challenge_method=S256&scope=mcp`;

    const store9 = new session.MemoryStore();
    const portalSession9 = session({
      name: 'bitpype.portal.sid',
      secret: process.env.SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      store: store9,
    });
    const app9 = express();
    app9.locals.portalIdleMs = 30 * 60 * 60 * 1000;
    app9.use(express.json());
    app9.use('/api/v1/portal', portalSession9, require(path.join(root, 'server/routes/portal.js')));
    app9.use(['/authorize', '/oauth'], portalSession9);
    app9.use(require(path.join(root, 'server/routes/mcpOAuth.js')).sessionRouter);
    const server9 = await new Promise((resolve) => {
      const s = app9.listen(0, '127.0.0.1', () => resolve(s));
    });
    const base9 = `http://127.0.0.1:${server9.address().port}`;
    // Tiny cookie jar over fetch.
    const jar9 = () => {
      const cookies = new Map();
      const call = async (method, url, body) => {
        const res = await fetch(base9 + url, {
          method,
          redirect: 'manual',
          headers: {
            ...(body ? { 'Content-Type': 'application/json' } : {}),
            ...(cookies.size ? { Cookie: [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
        });
        for (const sc of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
          const pair = sc.split(';')[0];
          const eq = pair.indexOf('=');
          if (eq > 0) cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
        }
        const text = await res.text();
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          /* authorize.html */
        }
        return { status: res.status, json, text, cookies };
      };
      return { call, cookies };
    };
    try {
      const jar = jar9();
      // 1 — signed-out /authorize parks display-only; pending shows it.
      const a1 = await jar.call('GET', `/authorize?${authzQuery}`);
      check('#9: signed-out /authorize serves the consent page', a1.status === 200 && a1.text.includes('panel-login'), `status=${a1.status}`);
      const p1 = await jar.call('GET', '/oauth/pending');
      check(
        '#9: pre-auth park is visible signed-out with no client (sign-in panel state)',
        p1.status === 200 && !!(p1.json && p1.json.pending) && !p1.json.client,
        JSON.stringify(p1.json).slice(0, 200)
      );
      // 2 — sign in (regenerates the session, destroying the park).
      const login = await jar.call('POST', '/api/v1/portal/login', { email: 'oauth-b192@example.com', password: 'portal-pass-192' });
      check('#9: portal login succeeds mid-flow', login.status === 200 && !!(login.json && login.json.ok), JSON.stringify(login.json).slice(0, 200));
      // 3 — negative control: WITHOUT re-authorizing, the park is gone
      // (L2 + regeneration intact — the pre-auth park is never revived).
      const pGone = await jar.call('GET', '/oauth/pending');
      check(
        '#9: after login alone, /oauth/pending is NO_PENDING (park destroyed, not resurrected)',
        pGone.status === 400 && !!(pGone.json && pGone.json.error === 'NO_PENDING'),
        JSON.stringify(pGone.json).slice(0, 200)
      );
      // 4 — the fixed page now re-GETs the original /authorize URL:
      // full revalidation parks a FRESH request bound to this user.
      const a2 = await jar.call('GET', `/authorize?${authzQuery}`);
      check('#9: re-GET /authorize after login re-parks (200)', a2.status === 200, `status=${a2.status}`);
      const p2 = await jar.call('GET', '/oauth/pending');
      check(
        '#9: after re-authorize, /oauth/pending shows the request AND the signed-in client (consent reachable)',
        p2.status === 200 && !!(p2.json && p2.json.pending && p2.json.client && p2.json.client.email === 'oauth-b192@example.com'),
        JSON.stringify(p2.json).slice(0, 240)
      );
      // 5 — consent completes and returns an authorization code redirect.
      const consent = await jar.call('POST', '/oauth/consent', { approve: true });
      check(
        '#9: consent approves and redirects with a code for the original request',
        consent.status === 200 &&
          !!(consent.json && consent.json.redirect && consent.json.redirect.startsWith('http://127.0.0.1:8911/callback?') && consent.json.redirect.includes('code=') && consent.json.redirect.includes('state=state192')),
        JSON.stringify(consent.json).slice(0, 240)
      );
      // 6 — mismatch half: a park bound to user A, presented by a
      // session authenticated as user B, still 403s. Constructed by
      // re-pointing the session's portal user in the store (the state
      // L2 guards against for any non-regenerating auth path).
      const a3 = await jar.call('GET', `/authorize?${authzQuery}`);
      check('#9: fresh park for user A established for the mismatch probe', a3.status === 200, `status=${a3.status}`);
      const rawSid = decodeURIComponent(jar.cookies.get('bitpype.portal.sid') || '');
      const sid = rawSid.replace(/^s:/, '').split('.')[0];
      const sessData = await new Promise((resolve, reject) => store9.get(sid, (e, s) => (e ? reject(e) : resolve(s))));
      check(
        '#9: mismatch fixture — park is bound to user A in the store',
        !!(sessData && sessData.oauthPending && Number(sessData.oauthPending.boundPortalUserId) === userA9),
        JSON.stringify(sessData && sessData.oauthPending).slice(0, 200)
      );
      sessData.clientPortalId = userB9;
      await new Promise((resolve, reject) => store9.set(sid, sessData, (e) => (e ? reject(e) : resolve())));
      const mismatch = await jar.call('POST', '/oauth/consent', { approve: true });
      check(
        '#9: consent by a different user than the park was bound to 403s PENDING_USER_MISMATCH',
        mismatch.status === 403 && !!(mismatch.json && mismatch.json.error === 'PENDING_USER_MISMATCH'),
        JSON.stringify(mismatch.json).slice(0, 200)
      );
    } finally {
      await new Promise((resolve) => server9.close(resolve));
    }
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
