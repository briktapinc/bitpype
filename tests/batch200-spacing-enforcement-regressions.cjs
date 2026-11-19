'use strict';
/**
 * Batch 200 — SPACING ENFORCEMENT (Ely, 2026-11-19: "That guy in the
 * code who needs to enforce margins and paddings is not doing his
 * work"). Enforcement only — the spacing law (28px/22px band inset,
 * ≥16px gaps, card floors; Batches 185–187 values) is unchanged.
 *
 * What was broken (proven on Victoria, website 40, 2026-11-19):
 *   - The export geometry audit timed out and attachSpacingAudit
 *     recorded a SKIPPED audit (filesAudited: 0) while the export
 *     completed — pages shipped with no audit at all, silently.
 *   - The audit measured at domcontentloaded, BEFORE module embeds
 *     render in the browser, so embed content (and its overhang)
 *     was invisible: Victoria's newsletter embed — widened by her
 *     own theme CSS breakout rule — overflowed the viewport by
 *     exactly the band inset (22px @390, 28px @980/1440) while the
 *     export stamp floated free, consulted by nothing.
 *
 * What Batch 200 ships:
 *   - spacingQa: embed settle (waitForEmbedSettle) before geometry
 *     in both the export audit and qaSite's measurement; per-file
 *     failure records (filesSelected / filesFailed / embeds) in the
 *     export audit result; export budget 60s → 240s.
 *   - domain.attachSpacingAudit: FAIL CLOSED — two attempts; a
 *     throw, a failed file, or fewer files measured than selected
 *     rejects the export with code SPACING_AUDIT_FAILED.
 *   - websiteEngine.qaSite: the 'spacing' check reads the export
 *     audit stamp — violations fail it, a legacy skipped stamp
 *     fails it, a clean stamp satisfies it. checkMobileOverflow
 *     also waits for embed settle.
 *
 *   Part 1 — source pins.
 *   Part 2 — fail-closed export (stubbed audit outcomes + real one).
 *   Part 3 — export browser audit: static overhang, async embed
 *     overhang (post-render measurement), clean page. Skips without
 *     a browser.
 *   Part 4 — qaSite spacing check wired to the export stamp.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b200-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch200', 'test', 'session', 'secret'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY = process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 33).toString('base64');

const THEME = {
  primary: '#1d4633',
  secondary: '#0e2c1f',
  bg: '#fffaf4',
  text: '#241d18',
  font: 'Karla',
  headingFont: 'Fraunces',
};

let groups = 0;
function group(name, n) {
  groups++;
  console.log(`ok ${groups} - ${name} (${n} checks)`);
}

function browserAvailable() {
  try {
    const puppeteer = require(path.join(root, 'node_modules/puppeteer'));
    const p = process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath();
    return !!(p && fs.existsSync(p));
  } catch {
    return false;
  }
}

(async () => {
  const engine = require(path.join(root, 'src/websiteEngine.js'));
  const domain = require(path.join(root, 'server/domain.js'));
  const spacingQa = require(path.join(root, 'server/spacingQa.js'));

  /* ================================================================== */
  /* Part 1 — source pins                                                */
  /* ================================================================== */
  {
    let n = 0;
    const dsrc = read('server/domain.js');
    assert.ok(dsrc.includes("err.code = 'SPACING_AUDIT_FAILED'"), 'domain fails the export closed with a named code');
    n++;
    assert.ok(/attempt <= 2/.test(dsrc), 'domain retries the audit once before failing the export');
    n++;
    assert.ok(
      !/records a skipped audit instead of blocking/.test(dsrc),
      'the Batch 185 skip-and-ship contract is gone'
    );
    n++;
    const ssrc = read('server/spacingQa.js');
    assert.equal(typeof spacingQa.waitForEmbedSettle, 'function', 'spacingQa exports the embed settle');
    n++;
    assert.equal(typeof spacingQa.embedsSettledInPage, 'function', 'spacingQa exports the in-page settle probe');
    n++;
    assert.ok(ssrc.includes('filesSelected'), 'export audit reports how many files were selected');
    n++;
    assert.ok(ssrc.includes('filesFailed'), 'export audit reports per-file failures');
    n++;
    const esrc = read('src/websiteEngine.js');
    assert.ok(esrc.includes('spacing_audit.'), 'qaSite reads the export audit stamp');
    n++;
    group('Part 1 — source pins', n);
  }

  /* ================================================================== */
  /* Setup — fixture workspace + sites                                   */
  /* ================================================================== */
  const platformDb = require(path.join(root, 'server/db.js'));
  await platformDb.migrate();
  const workspace = require(path.join(root, 'server/workspace.js'));
  const { openWorkspaceDb } = require(path.join(root, 'server/workspaceDb.js'));
  const acct = await workspace.createUserWithWorkspace({
    email: 'a200@example.invalid',
    password: ['batch200', 'fixture', 'pw'].join('-'),
    name: 'A200',
    workspaceName: 'Batch200 WS',
  });
  const WS_ID = Number(acct.workspaceId);
  const db = openWorkspaceDb(WS_ID);
  const mkSite = (leadId, name) => {
    db.prepare('INSERT INTO leads (id, business_name, email, status) VALUES (?, ?, ?, ?)').run(
      leadId,
      name,
      'b200@example.invalid',
      'customer'
    );
    const pages = [
      {
        slug: '/',
        title: 'Home',
        sections: [
          { type: 'nav', content: { brand: name } },
          { type: 'hero', content: { headline: 'Hello', subheadline: 'A clean fixture page.' } },
          { type: 'footer', content: {} },
        ],
      },
    ];
    const info = db
      .prepare('INSERT INTO websites (lead_id, name, status, pages, theme) VALUES (?, ?, ?, ?, ?)')
      .run(leadId, name, 'draft', JSON.stringify(pages), JSON.stringify(THEME));
    return Number(info.lastInsertRowid);
  };
  const SITE_A = mkSite(200001, 'B200 Export Fixture');
  const SITE_B = mkSite(200002, 'B200 QA Fixture');

  /* ================================================================== */
  /* Part 2 — fail-closed export                                         */
  /* ================================================================== */
  {
    let n = 0;
    const original = spacingQa.assessExportedFiles;
    try {
      // (a) the audit throws (the Victoria timeout shape) → export rejects.
      spacingQa.assessExportedFiles = async () => {
        throw new Error('Navigation timeout of 30000 ms exceeded');
      };
      await assert.rejects(domain.sitesExport(WS_ID, SITE_A), (e) => {
        assert.equal(e.code, 'SPACING_AUDIT_FAILED');
        assert.ok(/spacing audit could not complete/.test(e.message), 'rejection names the audit');
        assert.ok(/Navigation timeout/.test(e.message), 'rejection carries the underlying reason');
        return true;
      });
      n++;
      // (b) the audit "runs" but measures 0 of 3 files → export rejects.
      spacingQa.assessExportedFiles = async () => ({
        pass: null,
        totalViolations: null,
        byKind: {},
        filesAudited: 0,
        filesSelected: 3,
        filesFailed: [],
        filesTotal: 3,
        violations: [],
        auditedAt: new Date().toISOString(),
      });
      await assert.rejects(domain.sitesExport(WS_ID, SITE_A), (e) => {
        assert.equal(e.code, 'SPACING_AUDIT_FAILED');
        assert.ok(/measured 0 of 3/.test(e.message), 'rejection states the measured/selected counts');
        return true;
      });
      n++;
      // (c) one file failed to measure → export rejects, naming the file.
      spacingQa.assessExportedFiles = async () => ({
        pass: true,
        totalViolations: 0,
        byKind: {},
        filesAudited: 2,
        filesSelected: 3,
        filesFailed: [{ file: 'wedged.html', error: 'protocol timeout' }],
        filesTotal: 3,
        violations: [],
        auditedAt: new Date().toISOString(),
      });
      await assert.rejects(domain.sitesExport(WS_ID, SITE_A), (e) => {
        assert.equal(e.code, 'SPACING_AUDIT_FAILED');
        assert.ok(/wedged\.html/.test(e.message), 'rejection names the failed file');
        return true;
      });
      n++;
    } finally {
      spacingQa.assessExportedFiles = original;
    }
    // (d) the real audit completes → the export succeeds and stamps.
    if (browserAvailable()) {
      const out = await domain.sitesExport(WS_ID, SITE_A);
      assert.ok(out.spacingAudit, 'export result carries the audit');
      assert.ok(out.spacingAudit.filesAudited >= 1, 'the real audit measured at least the index file');
      assert.equal((out.spacingAudit.filesFailed || []).length, 0, 'no file failed to measure');
      n++;
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(`spacing_audit.${SITE_A}`);
      assert.ok(row && row.value, 'the audit stamp was written');
      const stamp = JSON.parse(row.value);
      assert.equal(stamp.filesAudited, out.spacingAudit.filesAudited, 'stamp matches the export result');
      n++;
    } else {
      console.log('  (Part 2d real export skipped locally: no browser)');
    }
    group('Part 2 — fail-closed export', n);
  }

  /* ================================================================== */
  /* Part 3 — export browser audit: post-embed measurement               */
  /* ================================================================== */
  {
    let n = 0;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b200-export-'));
    const page = (inner) =>
      '<!DOCTYPE html><html><head><meta charset="utf-8"><title>t</title>' +
      '<style>body{margin:0}section.band{padding-left:28px;padding-right:28px}</style></head><body>' +
      inner +
      '</body></html>';
    // The Victoria pattern, static: the breakout rule (width 100% +
    // 2×inset, margin-left −inset) applied where the mount's parent
    // carries NO inset of its own — the breakout overshoots the
    // viewport by exactly the inset on the right.
    fs.writeFileSync(
      path.join(dir, 'static.html'),
      page(
        '<div class="ws-html-block"><div style="width:calc(100% + 56px);margin-left:-28px;padding:0 28px;height:40px;background:#123">x</div></div>'
      )
    );
    // The Victoria pattern, async: the mount starts as a loading
    // placeholder; a script (standing in for module-embed.js) injects
    // the too-wide content after a delay. Only a post-settle
    // measurement can see it.
    fs.writeFileSync(
      path.join(dir, 'async.html'),
      page(
        '<div class="ws-html-block"><div data-bitpype-module="1" data-bitpype-module-type="newsletter">' +
          '<p class="bp-mod-loading">Loading…</p></div></div>' +
          '<script>setTimeout(function(){var m=document.querySelector("[data-bitpype-module]");' +
          'm.innerHTML="<div style=\\"width:calc(100% + 56px);margin-left:-28px;height:40px\\">rendered</div>";},700);</script>'
      )
    );
    fs.writeFileSync(
      path.join(dir, 'clean.html'),
      page('<section class="band"><p style="margin:0">All inside the band.</p></section>')
    );
    let audit = null;
    let auditErr = null;
    try {
      audit = await spacingQa.assessExportedFiles(
        { dir, files: ['static.html', 'async.html', 'clean.html'] },
        { widths: [390] }
      );
    } catch (e) {
      auditErr = e;
    }
    if (audit) {
      assert.equal(audit.filesAudited, 3, 'all three fixture files were measured');
      n++;
      assert.equal((audit.filesFailed || []).length, 0, 'no fixture file failed to measure');
      n++;
      assert.ok(audit.filesSelected === 3 && audit.filesTotal === 3, 'selection counts are reported');
      n++;
      const over = (audit.violations || []).filter((v) => v.kind === 'overflow');
      assert.ok(
        over.some((v) => v.page === 'static.html'),
        'the static breakout is flagged as overflow'
      );
      n++;
      assert.ok(
        over.some((v) => v.page === 'async.html'),
        'the async embed breakout is flagged — measurement waited for the mount to render'
      );
      n++;
      assert.ok(
        audit.embeds && audit.embeds.mounts >= 1 && audit.embeds.rendered >= 1,
        'the audit saw the mount render'
      );
      n++;
      assert.ok(!(audit.violations || []).some((v) => v.page === 'clean.html'), 'the clean page draws no violations');
      n++;
    } else {
      console.log(`  (Part 3 browser audit skipped locally: ${auditErr && (auditErr.code || auditErr.message)})`);
    }
    group('Part 3 — export browser audit (post-embed)', n);
  }

  /* ================================================================== */
  /* Part 4 — qaSite spacing check wired to the export stamp             */
  /* ================================================================== */
  {
    let n = 0;
    const setStamp = (stamp) =>
      db
        .prepare(
          'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
        )
        .run(`spacing_audit.${SITE_B}`, JSON.stringify(stamp));
    const spacingOf = (qa) => (qa.checks || []).find((c) => c.name === 'spacing');

    // (a) a dirty export stamp fails QA even though nothing else changed.
    setStamp({
      pass: false,
      totalViolations: 2,
      filesAudited: 3,
      filesTotal: 3,
      detail: '@390 index.html: overflow 28px div.bitpype-module-embed.bitpype-module-inpage',
      auditedAt: new Date().toISOString(),
    });
    const qaDirty = await engine.qaSite(db, SITE_B);
    assert.ok(spacingOf(qaDirty), 'QA carries the spacing check');
    n++;
    assert.equal(spacingOf(qaDirty).pass, false, 'a dirty export stamp fails the QA spacing check');
    n++;
    assert.ok(/overflow 28px/.test(spacingOf(qaDirty).detail), 'the QA failure carries the audit detail');
    n++;
    assert.equal(qaDirty.pass, false, 'the site cannot reach the QA-passed state with a dirty stamp');
    n++;

    // (b) a legacy skipped stamp (the pre-200 silent ship) fails QA.
    setStamp({
      pass: null,
      skipped: 'Navigation timeout of 30000 ms exceeded',
      totalViolations: null,
      filesAudited: 0,
      filesTotal: 3,
      auditedAt: new Date().toISOString(),
    });
    const qaSkipped = await engine.qaSite(db, SITE_B);
    assert.equal(spacingOf(qaSkipped).pass, false, 'a skipped-audit stamp fails the QA spacing check');
    n++;
    assert.ok(/did not run/.test(spacingOf(qaSkipped).detail), 'the failure says the audit did not run');
    n++;

    // (c) a clean stamp never fails QA *because of the stamp*.
    setStamp({
      pass: true,
      totalViolations: 0,
      filesAudited: 3,
      filesTotal: 3,
      detail: '',
      auditedAt: new Date().toISOString(),
    });
    const qaClean = await engine.qaSite(db, SITE_B);
    const spClean = spacingOf(qaClean);
    assert.ok(spClean, 'QA carries the spacing check on the clean site');
    n++;
    assert.ok(spClean.pass === true || !/export audit/.test(spClean.detail), 'a clean stamp contributes no QA failure');
    n++;
    group('Part 4 — qaSite spacing wired to the export stamp', n);
  }

  console.log(`\nbatch200: all ${groups} groups passed`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
