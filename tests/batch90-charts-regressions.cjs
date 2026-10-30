'use strict';
/**
 * Batch 90 — Charts module: chart definitions on a site, drawn from
 * the site's Data Table (bound: label column + numeric value columns,
 * aggregated per label) or from a manual dataset stored on the chart,
 * rendered by the embed as inline SVG in six styles (bar / hbar /
 * line / area / pie / doughnut) with no external chart library.
 *
 *   1. Manual chart CRUD cycle + the 20-chart cap.
 *   2. Manual data validation: caps (50 points / 4 series), length
 *      mismatch, non-numeric values (structured + text forms),
 *      inconsistent text rows, bad color, bad type/source/aggregation.
 *   3. data_text parsing (pipe + comma) and the text round-trip.
 *   4. Table binding math: sum / count / average / none against a
 *      fixture with duplicate labels + null cells; dangling binding
 *      keys pruned at compute time when the schema drops a column.
 *   5. Published-only: pending Data Table rows are never charted —
 *      neither in computeChartData nor in the public payload.
 *   6. Public payload (embed token) carries computed charts only;
 *      the embed's pure SVG builders render all six types.
 *   7. MCP surface: the 5 charts.* tools are defined (hosted +
 *      catalog + parity), the website.addModule enum carries
 *      'charts', and a scripted callTool session runs the cycle.
 *   8. Portal: owners + partners get the module, renters keep exactly
 *      ['calltracking']; listModuleItems flattens chart definitions
 *      and carries the binding context; item wrappers CRUD.
 *   9. Deletion sweeps: moduleContentCounts + deleteModule purge the
 *      charts table; leadEngine.deleteLead drops chart rows.
 *  10. Cross-workspace: a chart id from another workspace is
 *      NOT_FOUND for read/update/delete; its list stays empty.
 *  11. Source pins across siteModules / portal / routes / embed and
 *      the mod23 script version.
 *
 * Pure engine/facade tests on a temp workspace/platform pair
 * (DB_DRIVER=sqlite), no network. Run via tests/run-regressions.cjs.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b90-'));
process.env.DB_DRIVER = 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.SESSION_SECRET = 'b90-test-secret';
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
const WS2 = 2;
const LEAD = 90;
const LEAD_CAP = 91;
const LEAD_MCP = 92;
const LEAD_X = 93;
const TOKEN = '90_fixturetoken';

const COLUMNS = [
  { key: 'city', label: 'City', type: 'text' },
  { key: 'sales', label: 'Sales', type: 'currency' },
  { key: 'deals', label: 'Deals', type: 'number' },
];

async function main() {
  const platformDb = require(path.join(root, 'server/db.js'));
  await platformDb.migrate();
  const { openWorkspaceDb } = require(path.join(root, 'server/workspaceDb.js'));
  const sm = require(path.join(root, 'server/siteModules.js'));
  const clientPortal = require(path.join(root, 'server/clientPortal.js'));
  const portalTabs = require(path.join(root, 'server/portalTabs.js'));
  const mcp = require(path.join(root, 'server/mcp.js'));
  const leadEngine = require(path.join(root, 'src/leadEngine.js'));

  const billing = require(path.join(root, 'server/billing.js'));
  billing.workspacePlan = async () => 'standard';
  billing.effectivePlan = async () => 'standard';

  const db = openWorkspaceDb(WS);
  sm.ensureTables(db);
  const addLead = (target, id, name) =>
    target
      .prepare(
        `INSERT INTO leads (id, business_name, category, phone, email, city, state)
         VALUES (?, ?, 'Services', '(610) 555-0190', ?, 'Reading', 'PA')`
      )
      .run(id, name, `lead${id}@example.com`);
  addLead(db, LEAD, 'Chart Co');
  addLead(db, LEAD_CAP, 'Cap Co');
  addLead(db, LEAD_MCP, 'Mcp Chart Co');

  // Data Table fixture: duplicate labels + a null cell + (later) a
  // pending row that must never be charted.
  sm.updateDataTableConfig(db, LEAD, { title: 'Sales', columns: COLUMNS });
  sm.addDataTableRows(db, LEAD, [
    { values: { city: 'Reading', sales: 100, deals: 3 } },
    { values: { city: 'Reading', sales: 50, deals: 1 } },
    { values: { city: 'York', sales: 200, deals: 5 } },
    { values: { city: 'York', sales: null, deals: 2 } },
  ]);

  // ── 1. Manual CRUD cycle ───────────────────────────────────────
  let manual;
  check('1a createChart stores a manual dataset + style', () => {
    manual = sm.createChart(db, LEAD, {
      title: 'Monthly signups',
      chart_type: 'bar',
      source: 'manual',
      data: { labels: ['Jan', 'Feb'], series: [{ name: 'Signups', values: [10, 25] }] },
      colors: ['#123456'],
      show_values: true,
    });
    assert.equal(manual.title, 'Monthly signups');
    assert.equal(manual.chart_type, 'bar');
    assert.deepEqual(manual.data.labels, ['Jan', 'Feb']);
    assert.deepEqual(manual.data.series[0].values, [10, 25]);
    assert.deepEqual(manual.colors, ['#123456']);
    assert.equal(manual.show_values, true);
    assert.equal(manual.show_legend, true, 'legend defaults on');
  });

  check('1b updateChart switches type + style without touching data', () => {
    const upd = sm.updateChart(db, LEAD, manual.id, { chart_type: 'line', show_legend: 'No' });
    assert.equal(upd.chart_type, 'line');
    assert.equal(upd.show_legend, false);
    assert.deepEqual(upd.data.series[0].values, [10, 25]);
    manual = upd;
  });

  check('1c getChart / listCharts / countCharts read back', () => {
    assert.equal(sm.getChart(db, LEAD, manual.id).title, 'Monthly signups');
    assert.ok(sm.listCharts(db, LEAD).some((c) => c.id === manual.id));
    assert.ok(sm.countCharts(db, LEAD) >= 1);
    assert.equal(sm.getChart(db, LEAD, 99999), null);
  });

  check('1d deleteChart removes exactly that chart; clearCharts empties', () => {
    const tmp = sm.createChart(db, LEAD_CAP, { title: 'Temp', source: 'manual', data: { labels: ['A'], series: [{ name: 'S', values: [1] }] } });
    assert.deepEqual(sm.deleteChart(db, LEAD_CAP, tmp.id), { deleted: true });
    throwsCode(() => sm.deleteChart(db, LEAD_CAP, tmp.id), 'NOT_FOUND');
    sm.createChart(db, LEAD_CAP, { title: 'T2', source: 'manual' });
    assert.deepEqual(sm.clearCharts(db, LEAD_CAP), { deleted: 1 });
    assert.equal(sm.countCharts(db, LEAD_CAP), 0);
  });

  check('1e the 20-chart cap is enforced', () => {
    for (let i = 0; i < 20; i++) sm.createChart(db, LEAD_CAP, { title: `C${i}`, source: 'manual' });
    assert.equal(sm.countCharts(db, LEAD_CAP), 20);
    throwsCode(() => sm.createChart(db, LEAD_CAP, { title: 'one too many', source: 'manual' }), 'VALIDATION');
    sm.clearCharts(db, LEAD_CAP);
  });

  // ── 2. Manual data validation ──────────────────────────────────
  check('2a more than 50 points is rejected', () => {
    const labels = Array.from({ length: 51 }, (_, i) => `P${i}`);
    throwsCode(
      () => sm.createChart(db, LEAD, { source: 'manual', data: { labels, series: [{ name: 'S', values: labels.map(() => 1) }] } }),
      'VALIDATION'
    );
  });

  check('2b more than 4 series is rejected', () => {
    const series = Array.from({ length: 5 }, (_, i) => ({ name: `S${i}`, values: [1] }));
    throwsCode(() => sm.createChart(db, LEAD, { source: 'manual', data: { labels: ['A'], series } }), 'VALIDATION');
  });

  check('2c series/labels length mismatch is rejected', () => {
    throwsCode(
      () => sm.createChart(db, LEAD, { source: 'manual', data: { labels: ['A', 'B'], series: [{ name: 'S', values: [1] }] } }),
      'VALIDATION'
    );
  });

  check('2d non-numeric values are rejected (structured + text)', () => {
    throwsCode(
      () => sm.createChart(db, LEAD, { source: 'manual', data: { labels: ['A'], series: [{ name: 'S', values: ['lots'] }] } }),
      'VALIDATION'
    );
    throwsCode(() => sm.createChart(db, LEAD, { source: 'manual', data_text: 'A | many' }), 'VALIDATION');
    throwsCode(() => sm.createChart(db, LEAD, { source: 'manual', data_text: 'A | 1 | 2\nB | 3' }), 'VALIDATION');
  });

  check('2e bad color / type / source / aggregation are rejected', () => {
    throwsCode(() => sm.createChart(db, LEAD, { source: 'manual', colors: ['red'] }), 'VALIDATION');
    throwsCode(() => sm.createChart(db, LEAD, { source: 'manual', colors: ['#12'] }), 'VALIDATION');
    throwsCode(() => sm.createChart(db, LEAD, { source: 'manual', chart_type: 'scatter' }), 'VALIDATION');
    throwsCode(() => sm.createChart(db, LEAD, { source: 'csv' }), 'VALIDATION');
    throwsCode(
      () => sm.createChart(db, LEAD, { source: 'table', label_column: 'city', value_columns: ['sales'], aggregation: 'median' }),
      'VALIDATION'
    );
  });

  check('2f binding validation: unknown + non-numeric columns rejected', () => {
    throwsCode(() => sm.createChart(db, LEAD, { source: 'table', label_column: 'nope' }), 'VALIDATION');
    throwsCode(
      () => sm.createChart(db, LEAD, { source: 'table', label_column: 'city', value_columns: ['nope'] }),
      'VALIDATION'
    );
    throwsCode(
      () => sm.createChart(db, LEAD, { source: 'table', label_column: 'city', value_columns: ['city'] }),
      'VALIDATION'
    );
    const ok = sm.createChart(db, LEAD, {
      source: 'table',
      label_column: 'city',
      value_columns: ['city'],
      aggregation: 'count',
      title: 'count tolerates a text value column (ignored)',
    });
    assert.ok(ok.id);
    sm.deleteChart(db, LEAD, ok.id);
  });

  // ── 3. data_text forms ─────────────────────────────────────────
  check('3a data_text parses pipe + comma forms, coerces $ and commas', () => {
    const a = sm.createChart(db, LEAD_CAP, {
      source: 'manual',
      data_text: 'Jan | $1,200 | 4\nFeb | 900 | 6',
      series_names: 'Revenue, Deals',
    });
    assert.deepEqual(a.data.labels, ['Jan', 'Feb']);
    assert.deepEqual(a.data.series.map((s) => s.name), ['Revenue', 'Deals']);
    assert.deepEqual(a.data.series[0].values, [1200, 900]);
    const b = sm.createChart(db, LEAD_CAP, { source: 'manual', data_text: 'Q1, 5\nQ2, 7' });
    assert.deepEqual(b.data.series[0].values, [5, 7]);
    assert.equal(b.data.series[0].name, 'Series 1');
    sm.clearCharts(db, LEAD_CAP);
  });

  check('3b chartDataToText round-trips a stored dataset', () => {
    const text = sm.chartDataToText(manual.data);
    assert.equal(text, 'Jan | 10\nFeb | 25');
    const back = sm.normalizeChartData({ data_text: text, series_names: 'Signups' });
    assert.deepEqual(back, manual.data);
  });

  // ── 4. Table binding math ──────────────────────────────────────
  check('4a sum groups duplicate labels, per value column', () => {
    const c = sm.createChart(db, LEAD, {
      title: 'Sum', source: 'table', label_column: 'city', value_columns: ['sales', 'deals'], aggregation: 'sum',
    });
    const out = sm.computeChartData(db, LEAD, c);
    assert.deepEqual(out.labels, ['Reading', 'York']);
    assert.deepEqual(out.series[0], { name: 'Sales', values: [150, 200] });
    assert.deepEqual(out.series[1], { name: 'Deals', values: [4, 7] });
    sm.deleteChart(db, LEAD, c.id);
  });

  check('4b count needs no value columns', () => {
    const c = sm.createChart(db, LEAD, { title: 'Count', source: 'table', label_column: 'city', aggregation: 'count' });
    const out = sm.computeChartData(db, LEAD, c);
    assert.deepEqual(out.series, [{ name: 'Count', values: [2, 2] }]);
    sm.deleteChart(db, LEAD, c.id);
  });

  check('4c average skips null cells (York sales = its one value)', () => {
    const c = sm.createChart(db, LEAD, {
      title: 'Avg', source: 'table', label_column: 'city', value_columns: ['sales'], aggregation: 'average',
    });
    const out = sm.computeChartData(db, LEAD, c);
    assert.deepEqual(out.series[0].values, [75, 200]);
    sm.deleteChart(db, LEAD, c.id);
  });

  check('4d none plots rows in order, null value becomes 0', () => {
    const c = sm.createChart(db, LEAD, {
      title: 'Raw', source: 'table', label_column: 'city', value_columns: ['sales'], aggregation: 'none',
    });
    const out = sm.computeChartData(db, LEAD, c);
    assert.deepEqual(out.labels, ['Reading', 'Reading', 'York', 'York']);
    assert.deepEqual(out.series[0].values, [100, 50, 200, 0]);
    sm.deleteChart(db, LEAD, c.id);
  });

  check('4e dangling binding keys are pruned at compute time', () => {
    const c = sm.createChart(db, LEAD, {
      title: 'Prune', source: 'table', label_column: 'city', value_columns: ['sales', 'deals'], aggregation: 'sum',
    });
    sm.updateDataTableConfig(db, LEAD, {
      columns: [
        { key: 'city', label: 'City', type: 'text' },
        { key: 'sales', label: 'Sales', type: 'currency' },
      ],
    });
    const out = sm.computeChartData(db, LEAD, sm.getChart(db, LEAD, c.id));
    assert.deepEqual(out.series.map((s) => s.name), ['Sales'], 'dropped deals column no longer plots');
    sm.updateDataTableConfig(db, LEAD, { columns: COLUMNS });
    sm.deleteChart(db, LEAD, c.id);
  });

  // ── 5. Published-only ──────────────────────────────────────────
  let bound;
  check('5a a pending row is never charted (compute + would-be values)', () => {
    bound = sm.createChart(db, LEAD, {
      title: 'Bound', chart_type: 'bar', source: 'table', label_column: 'city', value_columns: ['sales'], aggregation: 'sum',
    });
    sm.createDataTableRow(db, LEAD, { values: { city: 'Reading', sales: 9999, deals: 99 }, status: 'pending' });
    const out = sm.computeChartData(db, LEAD, bound);
    assert.deepEqual(out.series[0].values, [150, 200], 'pending 9999 must not leak into the sum');
  });

  // ── 6. Public payload + embed builders ─────────────────────────
  check('6a embed payload carries computed charts only — no raw rows', () => {
    db.prepare(
      `INSERT INTO site_module_embeds (lead_id, module_type, title, public_token, published)
       VALUES (?, 'charts', 'Charts', ?, 1)`
    ).run(LEAD, TOKEN);
    const payload = sm.getPublicModuleByToken(db, TOKEN);
    assert.equal(payload.module_type, 'charts');
    assert.ok(payload.charts && Array.isArray(payload.charts.charts), 'charts block present');
    const boundPub = payload.charts.charts.find((c) => c.id === bound.id);
    assert.ok(boundPub, 'bound chart in payload');
    assert.deepEqual(boundPub.series[0].values, [150, 200], 'pending row excluded from the public payload too');
    assert.equal(boundPub.labels.length, 2);
    assert.ok(!('values' in boundPub), 'no row-shaped data leaks — computed labels/series only');
    assert.ok(Array.isArray(boundPub.colors) && boundPub.colors.length > 0, 'palette resolved');
  });

  check('6b every chart type renders non-empty SVG via the embed builders', () => {
    const src = fs.readFileSync(path.join(root, 'public/js/module-embed.js'), 'utf8');
    const m = src.match(/\/\* CHART-SVG-BEGIN[\s\S]*?CHART-SVG-END \*\//);
    assert.ok(m, 'chart builder block is extractable');
    const { chartSvgMarkup, chartLegendHtml } = new Function(`${m[0]}\nreturn { chartSvgMarkup, chartLegendHtml };`)();
    const baseChart = {
      title: 'T', colors: ['#0e7a68', '#e8873a'], show_legend: true, show_values: true,
      labels: ['Reading', 'York'],
      series: [
        { name: 'Sales', values: [150, 200] },
        { name: 'Deals', values: [4, 7] },
      ],
    };
    for (const t of ['bar', 'hbar', 'line', 'area', 'pie', 'doughnut']) {
      const svg = chartSvgMarkup({ ...baseChart, chart_type: t });
      assert.ok(svg.startsWith('<svg') && svg.includes('</svg>'), `${t} renders an svg`);
      assert.ok(svg.length > 300, `${t} svg is non-trivial`);
      assert.ok(svg.includes('role="img"'), `${t} svg carries the img role`);
    }
    const bar = chartSvgMarkup({ ...baseChart, chart_type: 'bar' });
    assert.ok(bar.includes('<rect'), 'bar draws rects');
    assert.ok(bar.includes('150'), 'bar shows the Reading value');
    const pie = chartSvgMarkup({ ...baseChart, chart_type: 'pie' });
    assert.ok(pie.includes('<path'), 'pie draws slice paths');
    assert.ok(chartLegendHtml({ ...baseChart, chart_type: 'pie' }).includes('57%'), 'pie legend carries percents');
    assert.equal(
      chartLegendHtml({ ...baseChart, chart_type: 'bar', series: [baseChart.series[0]] }),
      '',
      'single-series cartesian legend is suppressed'
    );
    const full = chartSvgMarkup({ ...baseChart, chart_type: 'doughnut', labels: ['Only'], series: [{ name: 'S', values: [5] }] });
    assert.ok(full.includes('evenodd'), 'single-slice doughnut uses the evenodd full circle');
  });

  // ── 7. MCP surface ─────────────────────────────────────────────
  check('7a tool defs + catalog + parity carry the 5 charts tools', () => {
    const names = mcp.toolDefs().map((t) => t.name);
    for (const n of ['charts.get', 'charts.create', 'charts.update', 'charts.delete', 'charts.clear']) {
      assert.ok(names.includes(n), `hosted defs include ${n}`);
    }
    const addModule = mcp.toolDefs().find((t) => t.name === 'website.addModule');
    const enumVals =
      (addModule.inputSchema.properties.moduleType && addModule.inputSchema.properties.moduleType.enum) || [];
    assert.ok(enumVals.includes('charts'), 'website.addModule enum includes charts');
    const catalog = require(path.join(root, 'src/mcpCatalog.js'));
    const catNames = (catalog.tools || catalog).map((t) => t.name);
    assert.ok(catNames.includes('charts.create'), 'local catalog includes charts.create');
    const paritySrc = fs.readFileSync(path.join(root, 'src/mcpParityTools.js'), 'utf8');
    assert.ok(paritySrc.includes("'charts.clear'"), 'parity handlers include charts.clear');
  });

  await checkAsync('7b scripted MCP session runs the chart cycle', async () => {
    const created = await mcp.callTool(WS, 'charts.create', {
      leadId: LEAD_MCP,
      title: 'MCP chart',
      chart_type: 'pie',
      source: 'manual',
      data: { labels: ['A', 'B'], series: [{ name: 'S', values: [3, 7] }] },
    });
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.equal(created.data.chart.chart_type, 'pie');
    const got = await mcp.callTool(WS, 'charts.get', { leadId: LEAD_MCP });
    assert.equal(got.ok, true, JSON.stringify(got));
    assert.equal(got.data.chart_count, 1);
    assert.deepEqual(got.data.charts[0].computed.series[0].values, [3, 7]);
    const upd = await mcp.callTool(WS, 'charts.update', {
      leadId: LEAD_MCP,
      id: created.data.chart.id,
      chart_type: 'doughnut',
    });
    assert.equal(upd.data.chart.chart_type, 'doughnut');
    const del = await mcp.callTool(WS, 'charts.delete', { leadId: LEAD_MCP, id: created.data.chart.id });
    assert.equal(del.data.deleted, true);
    await mcp.callTool(WS, 'charts.create', { leadId: LEAD_MCP, title: 'x', source: 'manual' });
    const cleared = await mcp.callTool(WS, 'charts.clear', { leadId: LEAD_MCP });
    assert.equal(cleared.data.deleted, 1);
    const got2 = await mcp.callTool(WS, 'charts.get', { leadId: LEAD_MCP });
    assert.equal(got2.data.chart_count, 0);
  });

  // ── 8. Portal ──────────────────────────────────────────────────
  check('8a portalTabs: owner + partner get charts, renter does not', () => {
    assert.ok(portalTabs.effectiveModules('owner').includes('charts'));
    assert.ok(portalTabs.effectiveModules('partner').includes('charts'));
    assert.deepEqual(portalTabs.effectiveModules('renter'), ['calltracking']);
  });

  await checkAsync('8b listModuleItems flattens definitions + binding context', async () => {
    const out = await clientPortal.listModuleItems(WS, LEAD, 'charts', 'owner90@example.com');
    assert.equal(out.module_type, 'charts');
    assert.ok(out.charts, 'charts block present');
    assert.deepEqual(out.charts.datatable_columns, COLUMNS);
    assert.equal(out.charts.datatable_configured, true);
    const item = out.items.find((c) => c.id === bound.id);
    assert.ok(item, 'bound chart listed as an item');
    assert.equal(item.value_columns, 'sales', 'value columns flattened to a comma string');
    assert.equal(item.show_legend, 'Yes');
    assert.deepEqual(item.computed.series[0].values, [150, 200]);
  });

  await checkAsync('8c portal item wrappers create/update/delete charts', async () => {
    const made = await clientPortal.createModuleItem(
      WS,
      LEAD,
      'charts',
      {
        title: 'Portal chart',
        chart_type: 'hbar',
        source: 'manual',
        data_text: 'Q1 | 5\nQ2 | 9',
        series_names: 'Deals',
        show_values: 'Yes',
      },
      'owner90@example.com'
    );
    assert.equal(made.item.chart_type, 'hbar');
    assert.deepEqual(made.item.data.series[0].values, [5, 9]);
    const upd = await clientPortal.updateModuleItem(
      WS,
      LEAD,
      'charts',
      made.item.id,
      { chart_type: 'area' },
      'owner90@example.com'
    );
    assert.equal(upd.item.chart_type, 'area');
    const del = await clientPortal.deleteModuleItem(WS, LEAD, 'charts', made.item.id, 'owner90@example.com');
    assert.equal(del.deleted, true);
    assert.equal(sm.getChart(db, LEAD, made.item.id), null);
  });

  // ── 9. Deletion sweeps ─────────────────────────────────────────
  check('9a deleteModule sweeps charts + the embed', () => {
    const counts = sm.moduleContentCounts(db, LEAD, 'charts');
    assert.ok(counts.total >= 2, `counts include the charts (got ${counts.total})`);
    sm.deleteModule(db, LEAD, 'charts');
    assert.equal(sm.countCharts(db, LEAD), 0);
    const embRows = db
      .prepare("SELECT COUNT(*) AS c FROM site_module_embeds WHERE lead_id = ? AND module_type = 'charts'")
      .get(LEAD);
    assert.equal(Number(embRows.c), 0);
  });

  check('9b leadEngine.deleteLead drops chart rows', () => {
    addLead(db, LEAD_X, 'Doomed Co');
    sm.createChart(db, LEAD_X, { title: 'Doomed chart', source: 'manual', data: { labels: ['A'], series: [{ name: 'S', values: [1] }] } });
    assert.equal(sm.countCharts(db, LEAD_X), 1);
    leadEngine.deleteLead(db, LEAD_X);
    assert.equal(sm.countCharts(db, LEAD_X), 0);
  });

  // ── 10. Cross-workspace ────────────────────────────────────────
  check('10a another workspace cannot read/update/delete this chart', () => {
    const db2 = openWorkspaceDb(WS2);
    sm.ensureTables(db2);
    addLead(db2, LEAD_X, 'Other Workspace Co');
    const mine = sm.createChart(db, LEAD, { title: 'Mine', source: 'manual' });
    assert.equal(sm.getChart(db2, LEAD, mine.id), null, 'no cross-workspace read');
    throwsCode(() => sm.updateChart(db2, LEAD, mine.id, { title: 'hijack' }), 'NOT_FOUND');
    throwsCode(() => sm.deleteChart(db2, LEAD, mine.id), 'NOT_FOUND');
    assert.equal(sm.listCharts(db2, LEAD_X).length, 0);
    assert.equal(sm.getChart(db, LEAD, mine.id).title, 'Mine', 'original untouched');
    sm.deleteChart(db, LEAD, mine.id);
  });

  // ── 11. Source pins ────────────────────────────────────────────
  check('11a wiring pins across modules, portal, routes, embed, version', () => {
    assert.ok(sm.MODULE_TYPES.includes('charts'), 'module type registered');
    assert.equal(sm.MODULE_TYPES.length, 22, 'charts is the 22nd module type');
    assert.equal(sm.MODULE_SCRIPT_VER, 'mod23', 'Batch 90 bumps the embed script version');
    const portalJs = fs.readFileSync(path.join(root, 'public/js/portal.js'), 'utf8');
    assert.ok(portalJs.includes("{ type: 'charts', label: 'Charts' }"), 'portal module list entry');
    assert.ok(portalJs.includes("type === 'charts'"), 'portal charts handling');
    const embedJs = fs.readFileSync(path.join(root, 'public/js/module-embed.js'), 'utf8');
    assert.ok(embedJs.includes('function renderCharts('), 'embed renderer');
    assert.ok(embedJs.includes('CHART-SVG-BEGIN'), 'embed svg builders');
    const portalRoutes = fs.readFileSync(path.join(root, 'server/routes/portal.js'), 'utf8');
    assert.ok(portalRoutes.includes("['charts', 'charts']"), 'portal module subpath mapping');
    const clientPortalSrc = fs.readFileSync(path.join(root, 'server/clientPortal.js'), 'utf8');
    assert.ok(clientPortalSrc.includes("type === 'charts'"), 'portal facade branches');
  });

  console.log(JSON.stringify({ batch: 90, passed: true, groups: results.length, checks: results }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
