'use strict';
/**
 * Batch 85 — lead delete must account for attached portal accounts and
 * site member data (root-cause fix for the "Linked business not found"
 * portal break: Ely's portal account pointed at a demo lead deleted
 * 2026-10-29; sign-in authenticated, then failed resolving the business,
 * because domain.leadsDelete never swept client_portal_users. The
 * Batch 82 live proof independently found deleteLead orphaning
 * site_members / site_member_sessions / site_module_embeds rows.)
 *
 *   1. The pre-flight summary (domain.leadsReferences) inventories the
 *      attached portal account (email + type) and the member-data
 *      counts. Pre-batch: the summary has no portalAccounts field and
 *      leadReferenceSummary has no member counts.
 *   2. A confirmed domain.leadsDelete removes, in the same operation:
 *      the portal user row AND its login tokens (platform DB), plus the
 *      site_members / site_member_sessions / site_module_embeds rows
 *      (workspace DB). Pre-batch: all five stores keep their rows.
 *   3. A lead with no attachments deletes exactly as before, with an
 *      empty portal inventory and zero member counts.
 *   4. Wiring pins: staff confirm copy names portal accounts; REST
 *      references + delete routes await the async facade; MCP
 *      lead.delete awaits too.
 *
 * Pure engine/facade tests on a temp on-disk workspace/platform pair
 * (DB_DRIVER=sqlite), no network. Run via tests/run-regressions.cjs.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b85-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.SESSION_SECRET = 'b85-test-secret';
process.env.SETTINGS_ENCRYPTION_KEY =
  process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 9).toString('base64');

const results = [];
async function checkAsync(name, fn) {
  await fn();
  results.push(name);
}
function check(name, fn) {
  fn();
  results.push(name);
}

const WS = 1;
const LEAD = 85;
const PLAIN = 86;

async function main() {
  const platformDb = require(path.join(root, 'server/db.js'));
  await platformDb.migrate();
  const { openWorkspaceDb } = require(path.join(root, 'server/workspaceDb.js'));
  const siteModules = require(path.join(root, 'server/siteModules.js'));
  const domain = require(path.join(root, 'server/domain.js'));
  const clientPortal = require(path.join(root, 'server/clientPortal.js'));

  const wdb = openWorkspaceDb(WS);
  siteModules.ensureTables(wdb);
  const addLead = (id, name, email) =>
    wdb
      .prepare(
        `INSERT INTO leads (id, business_name, category, phone, email, city, state)
         VALUES (?, ?, 'Services', '(610) 555-0185', ?, 'Reading', 'PA')`
      )
      .run(id, name, email);
  addLead(LEAD, 'Attachment Co', 'attach85@example.com');
  addLead(PLAIN, 'Plain Co', 'plain85@example.com');

  // Fixture attachments for LEAD: portal user + login token (platform),
  // site member + session + module embed (workspace).
  const ins = await platformDb.query(
    `INSERT INTO client_portal_users (email, password_hash, workspace_id, lead_id, business_name, status, user_type)
     VALUES (:e, 'x', :ws, :lead, 'Attachment Co', 'active', 'owner')`,
    { e: 'owner85@example.com', ws: WS, lead: LEAD }
  );
  const portalUid = Number(ins.insertId);
  assert.ok(portalUid > 0, 'fixture portal user created');
  await platformDb.query(
    `INSERT INTO client_portal_login_tokens (portal_user_id, token_hash, expires_at)
     VALUES (:uid, 'b85-token-hash', '2999-01-01 00:00:00')`,
    { uid: portalUid }
  );
  const memberInfo = wdb
    .prepare(
      `INSERT INTO site_members (lead_id, email, name, password_hash) VALUES (?, 'member85@example.com', 'Member', 'x')`
    )
    .run(LEAD);
  const memberId = Number(memberInfo.lastInsertRowid);
  wdb
    .prepare(
      `INSERT INTO site_member_sessions (token_hash, member_id, lead_id, expires_at)
       VALUES ('b85-session-hash', ?, ?, '2999-01-01 00:00:00')`
    )
    .run(memberId, LEAD);
  wdb
    .prepare(
      `INSERT INTO site_module_embeds (lead_id, module_type, title, public_token, published)
       VALUES (?, 'members', 'Members', '85_fixturetoken', 1)`
    )
    .run(LEAD);

  const countWs = (table, leadId) =>
    Number(wdb.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE lead_id = ?`).get(leadId).c);
  const countPlatform = async (sql, params) => {
    const rows = await platformDb.query(sql, params);
    return Number(rows[0].c);
  };

  await checkAsync('1a references inventory names the portal account (email + type)', async () => {
    const refs = await domain.leadsReferences(WS, LEAD);
    assert.ok(Array.isArray(refs.portalAccounts), 'portalAccounts is an array');
    assert.equal(refs.portalAccounts.length, 1);
    assert.equal(refs.portalAccounts[0].email, 'owner85@example.com');
    assert.equal(refs.portalAccounts[0].userType, 'owner');
    assert.equal(refs.portalLookupFailed, false);
  });
  await checkAsync('1b references inventory counts the member data', async () => {
    const refs = await domain.leadsReferences(WS, LEAD);
    assert.equal(refs.siteMembers, 1);
    assert.equal(refs.siteMemberSessions, 1);
    assert.equal(refs.siteModuleEmbeds, 1);
  });
  await checkAsync('1c a plain lead inventories empty (no attachments)', async () => {
    const refs = await domain.leadsReferences(WS, PLAIN);
    assert.deepEqual(refs.portalAccounts, []);
    assert.equal(refs.siteMembers, 0);
    assert.equal(refs.siteMemberSessions, 0);
    assert.equal(refs.siteModuleEmbeds, 0);
  });

  await checkAsync('2a confirmed delete reports the portal sweep', async () => {
    const out = await domain.leadsDelete(WS, LEAD);
    assert.equal(out.ok, true);
    assert.equal(out.portalAccountsRemoved, 1);
    assert.equal(out.portalAccounts.length, 1);
    assert.equal(out.summary.siteMembers, 1, 'outcome summary matches the confirm inventory');
  });
  await checkAsync('2b zero portal rows remain (users + login tokens)', async () => {
    assert.equal(
      await countPlatform('SELECT COUNT(*) AS c FROM client_portal_users WHERE lead_id = :l AND workspace_id = :ws', {
        l: LEAD,
        ws: WS,
      }),
      0
    );
    assert.equal(
      await countPlatform('SELECT COUNT(*) AS c FROM client_portal_login_tokens WHERE portal_user_id = :uid', {
        uid: portalUid,
      }),
      0
    );
    assert.equal(await clientPortal.findById(portalUid), null, 'portal sign-in row is gone (no-account, not dangling)');
  });
  await checkAsync('2c zero member-data rows remain (members, sessions, embeds)', async () => {
    assert.equal(countWs('site_members', LEAD), 0);
    assert.equal(countWs('site_member_sessions', LEAD), 0);
    assert.equal(countWs('site_module_embeds', LEAD), 0);
    assert.equal(wdb.prepare('SELECT id FROM leads WHERE id = ?').get(LEAD), undefined, 'lead row deleted');
  });

  await checkAsync('3 a lead without attachments deletes unchanged', async () => {
    const out = await domain.leadsDelete(WS, PLAIN);
    assert.equal(out.ok, true);
    assert.equal(out.portalAccountsRemoved, 0);
    assert.deepEqual(out.portalAccounts, []);
    assert.equal(wdb.prepare('SELECT id FROM leads WHERE id = ?').get(PLAIN), undefined);
  });

  check('W1 wiring: confirm copy + async callers', () => {
    const appJs = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
    assert.ok(appJs.includes('portal account(s) will be deleted'), 'staff confirm names portal accounts');
    assert.ok(appJs.includes('site member account(s) will be deleted'), 'staff confirm names member accounts');
    const domainApi = fs.readFileSync(path.join(root, 'server/routes/domainApi.js'), 'utf8');
    assert.ok(domainApi.includes('await domain.leadsReferences('), 'references route awaits the facade');
    assert.ok(domainApi.includes('await domain.leadsDelete('), 'delete route awaits the facade');
    const mcp = fs.readFileSync(path.join(root, 'server/mcp.js'), 'utf8');
    assert.ok(mcp.includes('await domain.leadsDelete('), 'MCP lead.delete awaits the facade');
  });

  console.log(JSON.stringify({ file: 'batch85-lead-delete-attachments-regressions', passed: results.length, checks: results }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
