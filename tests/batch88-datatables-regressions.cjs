'use strict';
/**
 * Batch 88 — Data Tables module: a structured-data module (named
 * columns + rows) with full CRUD via MCP + portal, four public
 * presentations (table / wall / results / list) over ONE dataset, and
 * a protected visitor submit path (rate limit + Turnstile at the
 * route; moderated by default).
 *
 *   1. Service CRUD cycle: set columns → add row → bulk add → update
 *      a price → delete a row → clear.
 *   2. Schema/value validation rejects: bad column type, duplicate
 *      key, >12 columns, impossible date, non-http(s) link, unknown
 *      value key, and the 500-row cap.
 *   3. Display config round-trips (template / roles / submit_mode /
 *      submit_fields) and dangling roles are pruned when the schema
 *      drops their column.
 *   4. Public payload (via the embed token) serves published rows
 *      only, with the datatable render block.
 *   5. Visitor submit: moderated → pending + invisible → approve →
 *      visible; live → published at once; off → refused; a
 *      non-submittable key is never stored; an empty submission is
 *      refused.
 *   6. MCP surface: all 8 datatables.* tools are defined, the
 *      website.addModule enum carries 'datatables', and a scripted
 *      callTool session performs setColumns/add/addRows/update/get/
 *      delete/clear end to end. The local catalog + parity handlers
 *      carry the same tools.
 *   7. Portal: owners get the module (portalTabs), renters keep
 *      exactly ['calltracking']; listModuleItems flattens rows and
 *      carries the config block; the config + clear wrappers work.
 *   8. Deletion sweep: moduleContentCounts counts rows + config and
 *      deleteModule removes both tables and the embed.
 *   9. Source pins for the portal panel, embed renderer, public
 *      submit route, and the mod22 script version.
 *
 * Pure engine/facade tests on a temp workspace/platform pair
 * (DB_DRIVER=sqlite), no network. Run via tests/run-regressions.cjs.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b87-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.SESSION_SECRET = 'b87-test-secret';
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
function throwsCode(fn, code) {
  assert.throws(fn, (e) => e && e.code === code);
}

const WS = 1;
const LEAD = 87;
const LEAD_CAP = 88;
const LEAD_MCP = 89;
const TOKEN = '87_fixturetoken';

async function main() {
  const platformDb = require(path.join(root, 'server/db.js'));
  await platformDb.migrate();
  const { openWorkspaceDb } = require(path.join(root, 'server/workspaceDb.js'));
  const sm = require(path.join(root, 'server/siteModules.js'));
  const clientPortal = require(path.join(root, 'server/clientPortal.js'));
  const portalTabs = require(path.join(root, 'server/portalTabs.js'));
  const mcp = require(path.join(root, 'server/mcp.js'));

  // Plan stubs: both MCP (workspacePlan) and the portal
  // (effectivePlan) read ./billing — one shared module object.
  const billing = require(path.join(root, 'server/billing.js'));
  billing.workspacePlan = async () => 'standard';
  billing.effectivePlan = async () => 'standard';

  const db = openWorkspaceDb(WS);
  sm.ensureTables(db);
  const addLead = (id, name) =>
    db
      .prepare(
        `INSERT INTO leads (id, business_name, category, phone, email, city, state)
         VALUES (?, ?, 'Services', '(610) 555-0187', ?, 'Reading', 'PA')`
      )
      .run(id, name, `lead${id}@example.com`);
  addLead(LEAD, 'Table Co');
  addLead(LEAD_CAP, 'Cap Co');
  addLead(LEAD_MCP, 'Mcp Co');

  const COLUMNS = [
    { key: 'service', label: 'Service', type: 'text' },
    { key: 'price', label: 'Price', type: 'currency' },
    { key: 'notes', label: 'Notes', type: 'text' },
  ];

  // ── 1. Service CRUD cycle ──────────────────────────────────────
  check('1a setColumns stores schema + title and infers roles', () => {
    const cfg = sm.updateDataTableConfig(db, LEAD, { title: 'Price List', columns: COLUMNS });
    assert.equal(cfg.title, 'Price List');
    assert.deepEqual(cfg.columns, COLUMNS);
    assert.equal(cfg.template, 'table');
    assert.equal(cfg.submit_mode, 'moderated');
    assert.equal(cfg.roles.title, 'service');
    assert.equal(cfg.roles.body, 'notes');
  });

  let rowA;
  check('1b addRow validates + normalizes values (currency string → number)', () => {
    rowA = sm.createDataTableRow(db, LEAD, { values: { service: 'Haircut', price: '$25.00', notes: 'Basic cut' } });
    assert.equal(rowA.values.price, 25);
    assert.equal(rowA.status, 'published');
    assert.equal(rowA.source, 'owner');
  });

  check('1c addRows seeds several rows atomically', () => {
    const out = sm.addDataTableRows(db, LEAD, [
      { values: { service: 'Color', price: 80, notes: 'Full color' } },
      { values: { service: 'Perm', price: '95.5', notes: '' } },
    ]);
    assert.equal(out.added, 2);
    assert.equal(sm.countDataTableRows(db, LEAD), 3);
  });

  check('1d updateRow edits one price and nothing else', () => {
    const upd = sm.updateDataTableRow(db, LEAD, rowA.id, { values: { price: 30 } });
    assert.equal(upd.values.price, 30);
    assert.equal(upd.values.service, 'Haircut');
    assert.equal(upd.values.notes, 'Basic cut');
  });

  check('1e getDataTable reads back config + rows + counts', () => {
    const table = sm.getDataTable(db, LEAD);
    assert.equal(table.row_count, 3);
    assert.equal(table.pending_count, 0);
    assert.equal(table.rows.length, 3);
  });

  check('1f deleteRow removes exactly that row', () => {
    const rows = sm.listDataTableRows(db, LEAD);
    const victim = rows.find((r) => r.values.service === 'Perm');
    const out = sm.deleteDataTableRow(db, LEAD, victim.id);
    assert.equal(out.deleted, true);
    assert.equal(sm.countDataTableRows(db, LEAD), 2);
    throwsCode(() => sm.deleteDataTableRow(db, LEAD, victim.id), 'NOT_FOUND');
  });

  // ── 2. Validation rejects ──────────────────────────────────────
  check('2a bad column type is rejected and the schema survives', () => {
    throwsCode(
      () => sm.updateDataTableConfig(db, LEAD, { columns: [{ key: 'x', label: 'X', type: 'richtext' }] }),
      'VALIDATION'
    );
    assert.deepEqual(sm.getDataTableConfig(db, LEAD).columns, COLUMNS);
  });

  check('2b duplicate column keys are rejected', () => {
    throwsCode(
      () =>
        sm.updateDataTableConfig(db, LEAD, {
          columns: [
            { key: 'a', label: 'A', type: 'text' },
            { key: 'a', label: 'A again', type: 'text' },
          ],
        }),
      'VALIDATION'
    );
  });

  check('2c more than 12 columns is rejected', () => {
    const many = Array.from({ length: 13 }, (_, i) => ({ key: `c${i}`, label: `C${i}`, type: 'text' }));
    throwsCode(() => sm.updateDataTableConfig(db, LEAD, { columns: many }), 'VALIDATION');
  });

  check('2d impossible date / bad link protocol / unknown key are rejected', () => {
    sm.updateDataTableConfig(db, LEAD_CAP, {
      columns: [
        { key: 'when', label: 'When', type: 'date' },
        { key: 'site', label: 'Site', type: 'link' },
      ],
    });
    throwsCode(() => sm.createDataTableRow(db, LEAD_CAP, { values: { when: '2026-02-30' } }), 'VALIDATION');
    throwsCode(() => sm.createDataTableRow(db, LEAD_CAP, { values: { site: 'ftp://example.com' } }), 'VALIDATION');
    throwsCode(() => sm.createDataTableRow(db, LEAD_CAP, { values: { nope: 'x' } }), 'VALIDATION');
    const okRow = sm.createDataTableRow(db, LEAD_CAP, {
      values: { when: '2026-11-05', site: 'https://example.com/x' },
    });
    assert.equal(okRow.values.when, '2026-11-05');
    assert.equal(okRow.values.site.url, 'https://example.com/x');
    sm.clearDataTableRows(db, LEAD_CAP);
  });

  check('2e the 500-row cap is enforced', () => {
    const chunk = Array.from({ length: 100 }, (_, i) => ({ values: { when: '2026-11-05', site: '' } }));
    for (let n = 0; n < 5; n++) sm.addDataTableRows(db, LEAD_CAP, chunk);
    assert.equal(sm.countDataTableRows(db, LEAD_CAP), 500);
    throwsCode(() => sm.createDataTableRow(db, LEAD_CAP, { values: { when: '2026-11-06' } }), 'VALIDATION');
    const cleared = sm.clearDataTableRows(db, LEAD_CAP);
    assert.equal(cleared.deleted, 500);
    assert.equal(sm.countDataTableRows(db, LEAD_CAP), 0);
  });

  // ── 3. Display config ──────────────────────────────────────────
  check('3a setDisplay round-trips template/roles/submit settings', () => {
    const cfg = sm.updateDataTableConfig(db, LEAD, {
      template: 'wall',
      roles: { title: 'service', body: 'notes', meta: 'price', image: null, link: null, badge: null },
      submit_mode: 'moderated',
      submit_fields: ['service', 'notes'],
    });
    assert.equal(cfg.template, 'wall');
    assert.equal(cfg.roles.meta, 'price');
    assert.deepEqual(cfg.submit_fields, ['service', 'notes']);
    const back = sm.getDataTable(db, LEAD);
    assert.equal(back.template, 'wall');
    assert.deepEqual(back.submit_fields, ['service', 'notes']);
    assert.equal(back.submit_fields_configured, true);
  });

  // ── 4. Public payload ──────────────────────────────────────────
  check('4a embed payload serves published rows only + the render block', () => {
    db.prepare(
      `INSERT INTO site_module_embeds (lead_id, module_type, title, public_token, published)
       VALUES (?, 'datatables', 'Price List', ?, 1)`
    ).run(LEAD, TOKEN);
    sm.createDataTableRow(db, LEAD, { values: { service: 'Secret', price: 1, notes: 'hidden' }, status: 'pending' });
    const payload = sm.getPublicModuleByToken(db, TOKEN);
    assert.equal(payload.module_type, 'datatables');
    assert.equal(payload.items.length, 2);
    assert.ok(payload.items.every((r) => r.values.service !== 'Secret'), 'pending row never serves');
    assert.equal(payload.datatable.template, 'wall');
    assert.equal(payload.datatable.submit.enabled, true);
    assert.deepEqual(
      payload.datatable.submit.fields.map((f) => f.key),
      ['service', 'notes']
    );
  });

  // ── 5. Visitor submit ──────────────────────────────────────────
  let submissionId;
  check('5a moderated submission lands pending and stays invisible', () => {
    const out = sm.createPublicDataTableSubmissionByToken(db, TOKEN, {
      values: { service: 'Visitor Cut', notes: 'Please add this', price: 999 },
    });
    assert.equal(out.mode, 'moderated');
    assert.equal(out.row.status, 'pending');
    submissionId = out.row.id;
    const stored = sm.getDataTableRow(db, LEAD, submissionId);
    assert.equal(stored.source, 'visitor');
    assert.equal(stored.values.service, 'Visitor Cut');
    assert.equal(stored.values.price, undefined, 'non-submittable key is never stored');
    const payload = sm.getPublicModuleByToken(db, TOKEN);
    assert.equal(payload.items.length, 2, 'pending submission not served');
    assert.equal(sm.getDataTable(db, LEAD).pending_count, 2);
  });

  check('5b approving the submission makes it visible', () => {
    sm.updateDataTableRow(db, LEAD, submissionId, { status: 'published' });
    const payload = sm.getPublicModuleByToken(db, TOKEN);
    assert.equal(payload.items.length, 3);
    assert.ok(payload.items.some((r) => r.values.service === 'Visitor Cut'));
  });

  check('5c live mode publishes at once; off refuses; empty is refused', () => {
    sm.updateDataTableConfig(db, LEAD, { submit_mode: 'live' });
    const live = sm.createPublicDataTableSubmissionByToken(db, TOKEN, { values: { service: 'Instant', notes: '' } });
    assert.equal(live.row.status, 'published');
    sm.updateDataTableConfig(db, LEAD, { submit_mode: 'off' });
    throwsCode(
      () => sm.createPublicDataTableSubmissionByToken(db, TOKEN, { values: { service: 'Nope' } }),
      'VALIDATION'
    );
    sm.updateDataTableConfig(db, LEAD, { submit_mode: 'moderated' });
    throwsCode(() => sm.createPublicDataTableSubmissionByToken(db, TOKEN, { values: {} }), 'VALIDATION');
  });

  check('3b dangling roles are pruned when the schema drops a column', () => {
    const cfg = sm.updateDataTableConfig(db, LEAD, {
      columns: [
        { key: 'service', label: 'Service', type: 'text' },
        { key: 'price', label: 'Price', type: 'currency' },
      ],
    });
    assert.equal(cfg.roles.body, null, 'body pointed at the dropped notes column');
    assert.equal(cfg.roles.title, 'service');
    assert.equal(cfg.roles.meta, 'price');
    // Restore the working schema for the portal checks below.
    sm.updateDataTableConfig(db, LEAD, { columns: COLUMNS, template: 'table' });
  });

  // ── 6. MCP surface ─────────────────────────────────────────────
  check('6a tool defs + catalog carry the 8 tools and the enum value', () => {
    const defs = mcp.toolDefs();
    const names = defs.map((t) => t.name);
    for (const n of [
      'datatables.get',
      'datatables.setColumns',
      'datatables.setDisplay',
      'datatables.addRow',
      'datatables.addRows',
      'datatables.updateRow',
      'datatables.deleteRow',
      'datatables.clear',
    ]) {
      assert.ok(names.includes(n), `hosted defs include ${n}`);
    }
    const addModule = defs.find((t) => t.name === 'website.addModule');
    const enumVals =
      (addModule.inputSchema.properties.moduleType && addModule.inputSchema.properties.moduleType.enum) || [];
    assert.ok(enumVals.includes('datatables'), 'website.addModule enum includes datatables');
    const catalog = require(path.join(root, 'src/mcpCatalog.js'));
    const catNames = (catalog.tools || catalog).map((t) => t.name);
    assert.ok(catNames.includes('datatables.get'), 'local catalog includes datatables.get');
    const paritySrc = fs.readFileSync(path.join(root, 'src/mcpParityTools.js'), 'utf8');
    assert.ok(paritySrc.includes("'datatables.clear'"), 'parity handlers include datatables.clear');
  });

  await checkAsync('6b scripted MCP session runs the full CRUD cycle', async () => {
    const set = await mcp.callTool(WS, 'datatables.setColumns', { leadId: LEAD_MCP, title: 'Services', columns: COLUMNS });
    assert.equal(set.ok, true, JSON.stringify(set));
    assert.equal(set.data.config.title, 'Services');
    const one = await mcp.callTool(WS, 'datatables.addRow', {
      leadId: LEAD_MCP,
      values: { service: 'Cut', price: '$49.99', notes: 'First' },
    });
    assert.equal(one.ok, true, JSON.stringify(one));
    assert.equal(one.data.row.values.price, 49.99);
    const bulk = await mcp.callTool(WS, 'datatables.addRows', {
      leadId: LEAD_MCP,
      rows: [
        { values: { service: 'Color', price: 80, notes: '' } },
        { values: { service: 'Perm', price: 95, notes: '' } },
      ],
    });
    assert.equal(bulk.ok, true, JSON.stringify(bulk));
    assert.equal(bulk.data.added, 2);
    const upd = await mcp.callTool(WS, 'datatables.updateRow', {
      leadId: LEAD_MCP,
      id: one.data.row.id,
      values: { price: 59 },
    });
    assert.equal(upd.data.row.values.price, 59);
    const disp = await mcp.callTool(WS, 'datatables.setDisplay', { leadId: LEAD_MCP, template: 'results' });
    assert.equal(disp.data.config.template, 'results');
    const got = await mcp.callTool(WS, 'datatables.get', { leadId: LEAD_MCP });
    assert.equal(got.data.row_count, 3);
    const del = await mcp.callTool(WS, 'datatables.deleteRow', { leadId: LEAD_MCP, id: one.data.row.id });
    assert.equal(del.data.deleted, true);
    const got2 = await mcp.callTool(WS, 'datatables.get', { leadId: LEAD_MCP });
    assert.equal(got2.data.row_count, 2);
    const cleared = await mcp.callTool(WS, 'datatables.clear', { leadId: LEAD_MCP });
    assert.equal(cleared.data.deleted, 2);
    const got3 = await mcp.callTool(WS, 'datatables.get', { leadId: LEAD_MCP });
    assert.equal(got3.data.row_count, 0);
  });

  // ── 7. Portal ──────────────────────────────────────────────────
  check('7a portalTabs: owner + partner get datatables, renter does not', () => {
    assert.ok(portalTabs.effectiveModules('owner').includes('datatables'));
    assert.ok(portalTabs.effectiveModules('partner').includes('datatables'));
    assert.deepEqual(portalTabs.effectiveModules('renter'), ['calltracking']);
  });

  await checkAsync('7b listModuleItems flattens rows and carries the config block', async () => {
    const out = await clientPortal.listModuleItems(WS, LEAD, 'datatables', 'owner87@example.com');
    assert.equal(out.module_type, 'datatables');
    assert.ok(out.datatable, 'datatable block present');
    assert.deepEqual(out.datatable.columns, COLUMNS);
    assert.ok(out.items.length >= 3);
    const haircut = out.items.find((r) => r.service === 'Haircut');
    assert.ok(haircut, 'flat row keyed by column');
    assert.equal(haircut.price, '30', 'currency flattened to its string form');
    assert.equal(haircut.values.price, 30, 'typed values ride along');
  });

  await checkAsync('7c config + clear wrappers work through the portal facade', async () => {
    const saved = await clientPortal.saveDataTableConfig(WS, LEAD, { title: 'Our Prices' }, 'owner87@example.com');
    assert.equal(saved.config.title, 'Our Prices');
    const before = sm.countDataTableRows(db, LEAD);
    assert.ok(before > 0);
    const cleared = await clientPortal.clearDataTable(WS, LEAD, 'owner87@example.com');
    assert.equal(cleared.deleted, before);
    assert.equal(sm.countDataTableRows(db, LEAD), 0);
  });

  // ── 8. Deletion sweep ──────────────────────────────────────────
  check('8a deleteModule sweeps rows + config + embed', () => {
    sm.addDataTableRows(db, LEAD, [
      { values: { service: 'One', price: 1, notes: '' } },
      { values: { service: 'Two', price: 2, notes: '' } },
    ]);
    const counts = sm.moduleContentCounts(db, LEAD, 'datatables');
    assert.equal(counts.total, 3, '2 rows + 1 config row');
    sm.deleteModule(db, LEAD, 'datatables');
    assert.equal(sm.countDataTableRows(db, LEAD), 0);
    const cfgRows = db.prepare('SELECT COUNT(*) AS c FROM datatable_configs WHERE lead_id = ?').get(LEAD);
    assert.equal(Number(cfgRows.c), 0);
    const embRows = db.prepare('SELECT COUNT(*) AS c FROM site_module_embeds WHERE lead_id = ?').get(LEAD);
    assert.equal(Number(embRows.c), 0);
  });

  // ── 9. Source pins ─────────────────────────────────────────────
  check('9a wiring pins across portal, embed, routes, and script version', () => {
    const portalJs = fs.readFileSync(path.join(root, 'public/js/portal.js'), 'utf8');
    assert.ok(portalJs.includes('renderDatatablesPanel'), 'portal panel renderer');
    assert.ok(portalJs.includes("{ type: 'datatables', label: 'Data Tables' }"), 'portal module list entry');
    const portalHtml = fs.readFileSync(path.join(root, 'public/portal.html'), 'utf8');
    assert.ok(portalHtml.includes('id="modules-datatables-panel"'), 'portal panel host');
    const embedJs = fs.readFileSync(path.join(root, 'public/js/module-embed.js'), 'utf8');
    assert.ok(embedJs.includes('function renderDataTable('), 'embed renderer');
    assert.ok(embedJs.includes("'/submit'"), 'embed posts to the submit route');
    const pubRoutes = fs.readFileSync(path.join(root, 'server/routes/modulesPublic.js'), 'utf8');
    assert.ok(pubRoutes.includes("router.post('/:token/submit'"), 'public submit route');
    assert.ok(pubRoutes.includes('datatableSubmitLimit'), 'submit route is rate limited');
    const portalRoutes = fs.readFileSync(path.join(root, 'server/routes/portal.js'), 'utf8');
    assert.ok(portalRoutes.includes("'/modules/datatables/config'"), 'portal config route');
    assert.ok(portalRoutes.includes("'/modules/datatables/clear'"), 'portal clear route');
    assert.equal(sm.MODULE_SCRIPT_VER, 'mod29', 'Batch 87 bumps the embed script version');
    assert.ok(sm.MODULE_TYPES.includes('datatables'), 'module type registered');
  });

  console.log(JSON.stringify({ batch: 88, passed: true, groups: results.length, checks: results }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
