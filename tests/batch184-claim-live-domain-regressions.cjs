'use strict';
/**
 * Batch 184 — claim dialogs must never arm on a site that is live on
 * its own domain, whichever domain flow put it there.
 *
 * Bug (Ely's screenshot, 2026-11-12): on the LIVE Berks Journal
 * (berksjournal.com) every nav click raised Chrome's native
 * "Leave site? Changes you made may not be saved." dialog. The
 * exporter injects the claim-preview loader into every exported page;
 * the loader arms its exit traps (timer modal, back-button trap,
 * pagehide, and a beforeunload handler) whenever the claim meta says
 * showClaimPrompt. Batch 39 suppression computed "already purchased"
 * ONLY from legacy domain_transactions rows in status 'live' — but
 * berksjournal.com was bought through the NEW domains.* flow (Batch
 * 182), which records the domain in site_domains and never writes a
 * domain_transactions row, so lead 944's meta kept returning
 * showClaimPrompt=true on a live newspaper.
 *
 * Fix under test:
 *   1. claimKit.liveDomainForSite — ONE shared determination used by
 *      the meta and the exporter: legacy domain_transactions 'live'
 *      OR a site_domains row bound to the website in status 'linked'
 *      (cfDomains.liveDomainForWebsite — the domain system's own read
 *      of the state linkDomainToWebsite writes after Pages attach +
 *      DNS succeed). A 'registered'-only row (bought, not linked)
 *      does NOT count: the site is not live on the domain yet.
 *   2. injectClaimPreviewIntoExport skips injection entirely for a
 *      live-domain site when the caller supplies its db (server
 *      export path does); prospect exports inject exactly as before.
 *   3. claim-preview.js itself is unchanged by the fix above (its
 *      suppression contract is source-pinned below).
 *
 * SCOPE ADDITION (Ely, mid-batch, 2026-11-12 13:30 EST): "Also the
 * claim should show once a day." claim-preview.js gains a per-visitor
 * DAILY DISPLAY CAP: the modal may be shown at most once per calendar
 * day per site — a token-scoped localStorage stamp
 * (bpClaimShown:<token> = the visitor-local YYYY-MM-DD), written when
 * the modal is actually displayed. Every show trigger (timer, back,
 * visibility, pagehide — all funnel through triggerShow) consults the
 * stamp first, and onBeforeUnload respects it too: already shown
 * today → the native leave prompt does not fire either. The stamp is
 * a DISPLAY cap only — it records no answer state (Batch 36 stands:
 * persistDone remains the only answer persistence, from decide()
 * only), and the "Later" session behaviour is untouched underneath.
 * The snippet cache-busts to claim-preview.js?v=9 (Batch 36 pattern;
 * claim-hold pins rotated).
 *
 * Checks:
 *   A — Journal-shaped fixture: site_domains 'linked', NO legacy txn
 *       → meta suppresses (alreadyPurchased, purchasedDomain set).
 *   B — site_domains 'registered' only → prompt still shows.
 *   C — legacy domain_transactions 'live' still suppresses (Batch 39).
 *   D — no domain anywhere → prospect unchanged (prompt shows).
 *   E — scoping: 'linked' bound to a DIFFERENT website / another
 *       lead's website does not suppress this site's meta.
 *   F — cfDomains.liveDomainForWebsite unit: linked → row;
 *       registered / unlinked / unknown id → null.
 *   G — exporter: prospect export gets the loader (BitpypeClaim +
 *       claim-preview.js) on every page incl. nested detail shells.
 *   H — exporter: site_domains-live site → injected 0 with the skip
 *       reason, pages byte-identical (no loader anywhere).
 *   I — exporter: legacy-live site → skipped the same way.
 *   J — claim-preview.js suppression contract intact: traps still arm
 *       behind the meta fetch and showClaimPrompt === false disarms.
 *   K — daily cap, executed against the REAL claim-preview.js in a
 *       stubbed-DOM vm: first show stamps today; a later load the
 *       same day never shows and its beforeunload stays silent; a
 *       yesterday stamp allows showing again (and re-stamps); a
 *       never-shown visitor still gets the native prompt (prospect
 *       behaviour intact); the cap is per-token.
 *
 * Run via tests/run-regressions.cjs (DB_DRIVER=sqlite).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || process.env.DB_DRIVER || 'sqlite';
process.env.APP_URL = 'https://bitpype.test';
if (!process.env.SESSION_SECRET) process.env['SESSION_' + 'SECRET'] = ['claim', 'live', 'domain', 'test'].join('-');

const root = path.resolve(__dirname, '..');
let Database;
try {
  Database = require('better-sqlite3');
} catch {
  Database = require('node:sqlite').DatabaseSync;
}
const db = new Database(':memory:');
db.exec(fs.readFileSync(path.join(root, 'src/schema.sql'), 'utf8'));
require('../src/websiteEngine').ensureTables(db);
require('../server/domainFlow').ensureTables(db);
require('../src/cfDomains').ensureTables(db);

const claimKit = require('../src/claimKit');
const cfDomains = require('../src/cfDomains');
const vm = require('node:vm');

const results = [];
function check(name, fn) {
  fn();
  results.push(name);
}

function makeLead(name, status = 'new') {
  const info = db.prepare(`INSERT INTO leads (business_name, email, status) VALUES (?, '', ?)`).run(name, status);
  const leadId = Number(info.lastInsertRowid);
  const site = db
    .prepare(
      `INSERT INTO websites (lead_id, name, theme, pages, status)
       VALUES (?, ?, '{}', '[]', 'draft')`
    )
    .run(leadId, name + ' Site');
  return { leadId, websiteId: Number(site.lastInsertRowid) };
}
function addSiteDomain(leadId, websiteId, status, domain) {
  db.prepare(
    `INSERT INTO site_domains (website_id, lead_id, domain_name, status, source)
     VALUES (?, ?, ?, ?, 'registrar')`
  ).run(websiteId, leadId, domain, status);
}
function addTxn(leadId, websiteId, status, domain) {
  db.prepare(
    `INSERT INTO domain_transactions (lead_id, website_id, domain, plan_id, status)
     VALUES (?, ?, ?, 'standard', ?)`
  ).run(leadId, websiteId, domain, status);
}

function makeExportDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b184-export-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<html><body><h1>Home</h1></body></html>', 'utf8');
  fs.mkdirSync(path.join(dir, 'detail', 'directory'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'detail', 'directory', 'item.html'),
    '<html><body><h1>Detail</h1></body></html>',
    'utf8'
  );
  return dir;
}
function readExport(dir) {
  return (
    fs.readFileSync(path.join(dir, 'index.html'), 'utf8') +
    '\n' +
    fs.readFileSync(path.join(dir, 'detail', 'directory', 'item.html'), 'utf8')
  );
}

/* ---- K harness: run the REAL claim-preview.js in a stubbed DOM ---- */
function hostDay(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}
function makeStorage(seed) {
  const map = new Map(Object.entries(seed || {}));
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}
async function runClaimPopup({ token, seedLocal }) {
  const localStorage = makeStorage(seedLocal);
  const sessionStorage = makeStorage();
  const byId = new Map();
  const timeouts = [];
  const winHandlers = new Map();
  const docHandlers = new Map();
  const addTo = (map) => (type, fn) => {
    if (!map.has(type)) map.set(type, []);
    map.get(type).push(fn);
  };
  const removeFrom = (map) => (type, fn) => {
    const a = map.get(type) || [];
    const i = a.indexOf(fn);
    if (i >= 0) a.splice(i, 1);
  };
  function makeEl(tag) {
    const el = {
      tagName: String(tag || 'div').toUpperCase(),
      id: '',
      children: [],
      style: {},
      textContent: '',
      classList: { add() {}, remove() {} },
      setAttribute() {},
      getAttribute() {
        return null;
      },
      addEventListener() {},
      removeEventListener() {},
      appendChild(child) {
        el.children.push(child);
        if (child && child.id) byId.set(child.id, child);
        return child;
      },
      remove() {
        if (el.id) byId.delete(el.id);
      },
      querySelector() {
        return null;
      },
    };
    return el;
  }
  const document = {
    readyState: 'complete',
    visibilityState: 'visible',
    documentElement: makeEl('html'),
    body: makeEl('body'),
    head: makeEl('head'),
    createElement: (tag) => makeEl(tag),
    getElementById: (id) => {
      if (byId.has(id)) return byId.get(id);
      if (id === 'bp-claim-overlay') return null; // strict: presence == displayed
      const el = makeEl('div');
      el.id = id;
      byId.set(id, el);
      return el;
    },
    querySelector: () => null,
    addEventListener: addTo(docHandlers),
    removeEventListener: removeFrom(docHandlers),
  };
  const sandbox = {
    console,
    setTimeout: (cb, ms) => {
      timeouts.push({ cb, ms });
      return timeouts.length;
    },
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    fetch: async () => ({
      ok: true,
      json: async () => ({ ok: true, data: { showClaimPrompt: true, businessName: 'Fixture Biz' } }),
    }),
    localStorage,
    sessionStorage,
    document,
    history: { pushState() {} },
    location: { href: 'https://preview.example/' },
    addEventListener: addTo(winHandlers),
    removeEventListener: removeFrom(winHandlers),
    getComputedStyle: () => ({ getPropertyValue: () => '', backgroundColor: '', color: '', fontFamily: '' }),
    BitpypeClaim: { apiBase: 'https://bitpype.test', token },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, 'public/js/claim-preview.js'), 'utf8'), sandbox, {
    filename: 'claim-preview.js',
  });
  // Let boot()'s fetch chain resolve and arm the triggers.
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  return {
    localStorage,
    isShown: () => byId.has('bp-claim-overlay'),
    fireTimer: () => {
      for (const t of timeouts.splice(0)) t.cb();
    },
    firePopstate: () => {
      for (const fn of [...(winHandlers.get('popstate') || [])]) fn({});
    },
    fireBeforeUnload: () => {
      const ev = {
        prevented: false,
        returnValue: undefined,
        preventDefault() {
          this.prevented = true;
        },
      };
      for (const fn of [...(winHandlers.get('beforeunload') || [])]) fn(ev);
      return ev;
    },
  };
}

async function main() {
  /* -------- A: Journal-shaped — new-flow live domain suppresses -------- */
  const a = makeLead('Fixture Journal News');
  addSiteDomain(a.leadId, a.websiteId, 'linked', 'fixture-journal.com');
  check('A: site_domains linked (no legacy txn) → meta suppresses with purchased domain', () => {
    const meta = claimKit.claimPageMeta(db, 1, a.leadId);
    assert.equal(meta.showClaimPrompt, false);
    assert.equal(meta.alreadyPurchased, true);
    assert.equal(meta.purchasedDomain, 'fixture-journal.com');
    const live = claimKit.liveDomainForSite(db, a.leadId, a.websiteId);
    assert.equal(live.source, 'site_domains');
    assert.equal(live.domain, 'fixture-journal.com');
  });

  /* -------- B: registered-but-not-linked is NOT live -------- */
  const b = makeLead('Fixture Registered Only');
  addSiteDomain(b.leadId, b.websiteId, 'registered', 'registered-only.com');
  check("B: site_domains 'registered' only → prompt still shows (bought ≠ live)", () => {
    const meta = claimKit.claimPageMeta(db, 1, b.leadId);
    assert.equal(meta.showClaimPrompt, true);
    assert.equal(meta.alreadyPurchased, false);
    assert.equal(meta.purchasedDomain, null);
    assert.equal(cfDomains.liveDomainForWebsite(db, b.websiteId), null);
  });

  /* -------- C: legacy live txn still suppresses -------- */
  const c = makeLead('Fixture Legacy Live');
  addTxn(c.leadId, c.websiteId, 'live', 'legacy-live.com');
  check('C: legacy domain_transactions live → still suppresses (Batch 39 intact)', () => {
    const meta = claimKit.claimPageMeta(db, 1, c.leadId);
    assert.equal(meta.showClaimPrompt, false);
    assert.equal(meta.alreadyPurchased, true);
    assert.equal(meta.purchasedDomain, 'legacy-live.com');
    assert.equal(claimKit.liveDomainForSite(db, c.leadId, c.websiteId).source, 'domain_transactions');
  });

  /* -------- D: no domain — prospect unchanged -------- */
  const d = makeLead('Fixture Plain Prospect');
  check('D: no domain rows → prompt shows, no purchased flags', () => {
    const meta = claimKit.claimPageMeta(db, 1, d.leadId);
    assert.equal(meta.showClaimPrompt, true);
    assert.equal(meta.alreadyPurchased, false);
    assert.equal(meta.purchasedDomain, null);
    assert.equal(claimKit.liveDomainForSite(db, d.leadId, d.websiteId), null);
  });

  /* -------- E: scoped to this lead+website pair -------- */
  // (schema: one website per lead, so the "different website" case is
  // another lead's website — the meta only ever consults the website
  // resolved for ITS lead, exactly like Batch 39's pair scoping.)
  const e = makeLead('Fixture Scoped Sites');
  const otherLead = makeLead('Fixture Neighbour Lead');
  addSiteDomain(otherLead.leadId, otherLead.websiteId, 'linked', 'neighbour-live.com');
  check("E: a linked domain on another lead's website does not suppress this site's meta", () => {
    const meta = claimKit.claimPageMeta(db, 1, e.leadId);
    assert.equal(meta.showClaimPrompt, true);
    assert.equal(meta.alreadyPurchased, false);
    assert.equal(claimKit.liveDomainForSite(db, e.leadId, e.websiteId), null);
  });
  check("E: the neighbour lead's own meta IS suppressed by its own linked domain", () => {
    const meta = claimKit.claimPageMeta(db, 1, otherLead.leadId);
    assert.equal(meta.showClaimPrompt, false);
    assert.equal(meta.purchasedDomain, 'neighbour-live.com');
  });
  check('E: binding a linked domain to THIS website suppresses from that moment', () => {
    addSiteDomain(e.leadId, e.websiteId, 'linked', 'scoped-now-live.com');
    const meta = claimKit.claimPageMeta(db, 1, e.leadId);
    assert.equal(meta.showClaimPrompt, false);
    assert.equal(meta.purchasedDomain, 'scoped-now-live.com');
  });

  /* -------- F: liveDomainForWebsite unit -------- */
  check('F: liveDomainForWebsite — linked row returned; unlinked / bad id → null', () => {
    const row = cfDomains.liveDomainForWebsite(db, a.websiteId);
    assert.ok(row && row.domain_name === 'fixture-journal.com');
    const u = makeLead('Fixture Unlinked');
    addSiteDomain(u.leadId, u.websiteId, 'unlinked', 'was-linked.com');
    assert.equal(cfDomains.liveDomainForWebsite(db, u.websiteId), null);
    assert.equal(cfDomains.liveDomainForWebsite(db, 999999), null);
    assert.equal(cfDomains.liveDomainForWebsite(db, 0), null);
    assert.equal(cfDomains.liveDomainForWebsite(db, null), null);
  });

  /* -------- G: exporter still injects for a prospect -------- */
  const gDir = makeExportDir();
  check('G: prospect export → loader injected on every page incl. detail shells', () => {
    const r = claimKit.injectClaimPreviewIntoExport(gDir, 1, d.leadId, { db, websiteId: d.websiteId });
    assert.equal(r.injected, 2);
    const html = readExport(gDir);
    assert.ok(html.includes('window.BitpypeClaim'), 'claim config snippet present');
    assert.ok(html.includes('/js/claim-preview.js'), 'loader script present');
  });

  /* -------- H: exporter skips a site_domains-live site -------- */
  const hDir = makeExportDir();
  const hBefore = readExport(hDir);
  check('H: site_domains-live export → injection skipped, pages byte-identical', () => {
    const r = claimKit.injectClaimPreviewIntoExport(hDir, 1, a.leadId, { db, websiteId: a.websiteId });
    assert.equal(r.injected, 0);
    assert.equal(r.skipped, 'site_live_on_own_domain');
    const html = readExport(hDir);
    assert.equal(html, hBefore, 'export pages untouched');
    assert.ok(!html.includes('BitpypeClaim'), 'no claim loader anywhere');
    assert.ok(!html.includes('claim-preview'), 'no claim-preview reference anywhere');
  });

  /* -------- I: exporter skips a legacy-live site too -------- */
  const iDir = makeExportDir();
  check('I: legacy-live export → injection skipped the same way', () => {
    const r = claimKit.injectClaimPreviewIntoExport(iDir, 1, c.leadId, { db, websiteId: c.websiteId });
    assert.equal(r.injected, 0);
    assert.equal(r.skipped, 'site_live_on_own_domain');
    assert.ok(!readExport(iDir).includes('BitpypeClaim'));
  });

  /* -------- J: claim-preview.js suppression contract intact -------- */
  const popupSrc = fs.readFileSync(path.join(root, 'public/js/claim-preview.js'), 'utf8');
  check('J: popup suppression contract intact — traps arm post-meta, showClaimPrompt===false disarms', () => {
    assert.ok(popupSrc.includes("window.addEventListener('beforeunload', onBeforeUnload)"), 'trap code intact');
    assert.ok(popupSrc.includes('if (meta.showClaimPrompt === false'), 'server suppression branch intact');
    const domainSrc = fs.readFileSync(path.join(root, 'server/domain.js'), 'utf8');
    assert.ok(
      domainSrc.includes('injectClaimPreviewIntoExport(exported.dir, workspaceId, leadId, {'),
      'export path passes its db + websiteId to the injector'
    );
  });
  check('J: daily cap wiring — stamp key, trigger consult, display stamp, beforeunload consult', () => {
    assert.ok(popupSrc.includes("const shownKey = 'bpClaimShown:' + token;"), 'token-scoped stamp key');
    assert.ok(popupSrc.includes('if (shownToday()) return;'), 'triggerShow consults the cap first');
    assert.ok(popupSrc.includes('stampShownToday();'), 'actual display stamps the day');
    assert.ok(popupSrc.includes('|| shownToday()) return;'), 'onBeforeUnload respects the cap');
    assert.ok(
      !popupSrc.includes('bp_claim_done_') || popupSrc.indexOf('persistDone') > -1,
      'answer persistence untouched'
    );
  });

  /* -------- K: daily cap, executed against the real script -------- */
  const k1 = await runClaimPopup({ token: 'tokA' });
  check('K: first show of the day displays the modal and stamps today', () => {
    assert.equal(k1.isShown(), false, 'nothing shown before any trigger');
    k1.fireTimer();
    assert.equal(k1.isShown(), true, 'timer trigger shows the modal');
    assert.equal(k1.localStorage.getItem('bpClaimShown:tokA'), hostDay(0), 'display stamped today');
    assert.equal(k1.localStorage.getItem('bp_claim_done_tokA'), null, 'display is NOT an answer — no done flag');
  });
  const k2 = await runClaimPopup({ token: 'tokA', seedLocal: Object.fromEntries(k1.localStorage.map) });
  check('K: same-day later visit — no trigger shows again, beforeunload stays silent', () => {
    k2.fireTimer();
    assert.equal(k2.isShown(), false, 'timer blocked by the daily cap');
    k2.firePopstate();
    assert.equal(k2.isShown(), false, 'back trigger blocked by the daily cap');
    const ev = k2.fireBeforeUnload();
    assert.equal(ev.prevented, false, 'native leave prompt does NOT fire after a same-day show');
    assert.equal(ev.returnValue, undefined, 'returnValue untouched');
  });
  const k3 = await runClaimPopup({ token: 'tokA', seedLocal: { 'bpClaimShown:tokA': hostDay(-1) } });
  check('K: a stamp from a previous day allows showing again and re-stamps', () => {
    k3.fireTimer();
    assert.equal(k3.isShown(), true, 'yesterday’s stamp does not block today');
    assert.equal(k3.localStorage.getItem('bpClaimShown:tokA'), hostDay(0), 'stamp advanced to today');
  });
  const k4 = await runClaimPopup({ token: 'tokA' });
  check('K: never shown today → the native leave prompt still fires (prospect intact)', () => {
    const ev = k4.fireBeforeUnload();
    assert.equal(ev.prevented, true, 'beforeunload prompts when the modal has not shown today');
    assert.equal(ev.returnValue, '');
  });
  const k5 = await runClaimPopup({ token: 'tokA', seedLocal: { 'bpClaimShown:tokB': hostDay(0) } });
  check('K: the cap is per-token — another site’s stamp does not block this site', () => {
    k5.fireTimer();
    assert.equal(k5.isShown(), true, 'a different token’s today-stamp is ignored');
    assert.equal(k5.localStorage.getItem('bpClaimShown:tokA'), hostDay(0));
  });

  console.log(JSON.stringify({ file: 'batch184-claim-live-domain-regressions', passed: true, checks: results.length }));
  for (const name of results) console.log('  ok -', name);
}

main().catch((e) => {
  console.error(JSON.stringify({ file: 'batch184-claim-live-domain-regressions', passed: false, error: e.message }));
  console.error(e);
  process.exit(1);
});
