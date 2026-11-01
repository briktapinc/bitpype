'use strict';
/**
 * Batch 52 — Archives page hotfix ("setTitle is not defined").
 *
 * The bug: pageArchives() in public/js/app.js opened with a call to
 * setTitle('Archives') — an identifier defined NOWHERE in the client JS
 * (it arrived with Batch 27, feaac4a). navigate() catches the throw and
 * renders the "Page failed to load" card, so the Archives page — and
 * with it Batch 45's purge UI — never rendered in production. The shell
 * already sets the top-bar title itself (topTitle from ROUTE_LABELS in
 * navigate()); no page calls a title helper, so the fix is deleting the
 * stray call. Checks:
 *
 *   1. Static net for the whole bug class: scan every client script the
 *      staff shell loads for bare calls to identifiers defined NOWHERE
 *      in the client JS (declared-anywhere = defined; object-method
 *      definitions are definitions, not calls). setTitle is pinned by
 *      name as well. NEGATIVE PROOF: re-adding `setTitle('Archives');`
 *      to pageArchives fails check 1 — verified manually, then removed.
 *   2. Wiring pins: the three archives api methods + server routes
 *      exist with the paths pageArchives uses.
 *   3. Facade round-trip on a real temp workspace (Batch 45 idiom):
 *      archive → sitesArchivedList carries every field the renderer
 *      dereferences → sitesRestoreSite → gone from the list → re-archive
 *      → sitesPurgeSite wrong name refuses, exact name destroys.
 *   4. Chromium smoke (account-link harness): staff sign-in, visit
 *      #/archives — empty state renders, a fixture row renders with
 *      Restore + Purge buttons, Restore click and a type-the-name Purge
 *      click both complete, and the "Page failed to load" card never
 *      appears (zero pageerrors). Route smoke is Archives-only by
 *      design: a blanket fixture cannot feed every page's data shape,
 *      so check 1 is the class-wide net instead.
 *
 * Run via tests/run-regressions.cjs (DB_DRIVER=sqlite).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b52-'));
process.env.DB_DRIVER = 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'batch52-fixture-secret';
process.env.SETTINGS_ENCRYPTION_KEY =
  process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 7).toString('base64');

const results = [];
function check(name, fn) {
  fn();
  results.push(name);
}
async function checkAsync(name, fn) {
  await fn();
  results.push(name);
}

/* ---------------- 1. static undefined-callee scan ---------------- */

// Batch 111: + moduleIcons.js — the shared module-icon source both
// shells load (consolidation step 2); the staff script census grows
// by exactly this one intended file.
const CLIENT_FILES = ['fonts.js', 'errorCopy.js', 'api.js', 'captcha.js', 'navGroups.js', 'moduleIcons.js', 'app.js'];

function stripCommentsAndStrings(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  const stack = [];
  let prevSig = '';
  let prevWord = '';
  const regexOkAfter = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^', '\n']);
  const regexOkWords = new Set(['return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'instanceof', 'await', 'yield', 'else', 'do']);
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    const top = stack[stack.length - 1];
    if (top && top.t === 'tpl') {
      if (c === '\\') { out += '  '; i += 2; continue; }
      if (c === '`') { stack.pop(); out += ' '; prevSig = '`'; i++; continue; }
      if (c === '$' && c2 === '{') { stack.push({ t: 'expr', depth: 1 }); out += '  '; i += 2; continue; }
      out += c === '\n' ? '\n' : ' ';
      i++;
      continue;
    }
    if (c === '/' && c2 === '/') { while (i < n && src[i] !== '\n') { out += ' '; i++; } continue; }
    if (c === '/' && c2 === '*') {
      out += '  '; i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++; }
      if (i < n) { out += '  '; i += 2; }
      continue;
    }
    if (c === '/' && (regexOkAfter.has(prevSig) || regexOkWords.has(prevWord) || prevSig === '')) {
      out += ' '; i++;
      let inClass = false;
      while (i < n) {
        const rc = src[i];
        if (rc === '\\') { out += '  '; i += 2; continue; }
        if (rc === '\n') break;
        if (rc === '[') inClass = true;
        if (rc === ']') inClass = false;
        out += ' ';
        i++;
        if (rc === '/' && !inClass) break;
      }
      while (i < n && /[a-z]/i.test(src[i])) { out += ' '; i++; }
      prevSig = '/'; prevWord = '';
      continue;
    }
    if (c === "'" || c === '"') {
      const q = c; out += ' '; i++;
      while (i < n && src[i] !== q) {
        if (src[i] === '\\') { out += '  '; i += 2; continue; }
        out += src[i] === '\n' ? '\n' : ' '; i++;
      }
      if (i < n) { out += ' '; i++; }
      prevSig = q; prevWord = '';
      continue;
    }
    if (c === '`') { stack.push({ t: 'tpl' }); out += ' '; i++; continue; }
    if (top && top.t === 'expr') {
      if (c === '{') top.depth++;
      if (c === '}') { top.depth--; if (top.depth === 0) { stack.pop(); out += ' '; i++; prevSig = '}'; continue; } }
    }
    out += c;
    if (!/\s/.test(c)) {
      prevSig = c;
      if (/[\w$]/.test(c)) prevWord = (prevWord + c).replace(/^.*?([A-Za-z_$][\w$]*)$/, '$1');
      else prevWord = '';
    }
    i++;
  }
  return out;
}

const GLOBALS = new Set([
  'Array', 'Object', 'String', 'Number', 'Boolean', 'BigInt', 'Symbol', 'Date', 'RegExp', 'Error',
  'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'EvalError', 'URIError', 'AggregateError',
  'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Proxy', 'Reflect', 'JSON', 'Math', 'Intl', 'ArrayBuffer',
  'SharedArrayBuffer', 'DataView', 'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array',
  'Uint16Array', 'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array',
  'BigUint64Array', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'decodeURI', 'encodeURI',
  'decodeURIComponent', 'encodeURIComponent', 'escape', 'unescape', 'queueMicrotask', 'structuredClone',
  'atob', 'btoa', 'window', 'document', 'navigator', 'location', 'history', 'localStorage',
  'sessionStorage', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'requestAnimationFrame', 'cancelAnimationFrame', 'fetch', 'alert', 'confirm', 'prompt', 'console',
  'crypto', 'URL', 'URLSearchParams', 'Blob', 'File', 'FileReader', 'FormData', 'Headers', 'Request',
  'Response', 'AbortController', 'AbortSignal', 'Event', 'CustomEvent', 'EventTarget',
  'MutationObserver', 'ResizeObserver', 'IntersectionObserver', 'HTMLElement', 'HTMLInputElement',
  'HTMLSelectElement', 'HTMLTextAreaElement', 'Element', 'Node', 'Text', 'Image', 'Audio', 'Option',
  'DOMParser', 'XMLSerializer', 'getComputedStyle', 'matchMedia', 'scrollTo', 'open', 'close', 'print',
  'postMessage', 'addEventListener', 'removeEventListener', 'dispatchEvent', 'TextEncoder',
  'TextDecoder', 'ReadableStream', 'WritableStream', 'TransformStream', 'WebSocket', 'Worker',
  'Notification', 'speechSynthesis', 'performance', 'CSS', 'customElements', 'createImageBitmap',
  'DOMException', 'MessageChannel', 'MessagePort', 'BroadcastChannel', 'PopStateEvent',
  'HashChangeEvent', 'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'TouchEvent', 'DragEvent',
  'FocusEvent', 'InputEvent', 'WheelEvent', 'MediaRecorder', 'AudioContext', 'webkitAudioContext',
  'OffscreenCanvas',
]);
const KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'new', 'typeof', 'do', 'else',
  'await', 'yield', 'delete', 'void', 'in', 'of', 'instanceof', 'case', 'throw', 'with', 'async',
]);

function scanUndefinedCallees() {
  const declared = new Set(GLOBALS);
  const cleaned = new Map();
  const addParams = (list) => {
    for (const part of String(list).split(',')) {
      const p = part.trim().replace(/^\.\.\./, '');
      if (!p) continue;
      if (p.startsWith('{') || p.startsWith('[')) {
        for (const d of p.matchAll(/([A-Za-z_$][\w$]*)\s*(?::\s*([A-Za-z_$][\w$]*))?/g)) declared.add(d[2] || d[1]);
      } else {
        const id = p.match(/^([A-Za-z_$][\w$]*)/);
        if (id) declared.add(id[1]);
      }
    }
  };
  for (const f of CLIENT_FILES) {
    const raw = fs.readFileSync(path.join(root, 'public', 'js', f), 'utf8');
    const clean = stripCommentsAndStrings(raw);
    cleaned.set(f, clean);
    for (const m of clean.matchAll(/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
    for (const m of clean.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
    for (const m of clean.matchAll(/\b(?:const|let|var)\s+([^;=\n]+(?:=[^;]*)?)(?:;|\n)/g)) {
      for (const part of m[1].split(',')) {
        const p = part.trim();
        const id = p.match(/^([A-Za-z_$][\w$]*)/);
        if (id) declared.add(id[1]);
        const destr = p.match(/^\{([^}]*)\}/) || p.match(/^\[([^\]]*)\]/);
        if (destr) for (const d of destr[1].matchAll(/([A-Za-z_$][\w$]*)\s*(?::\s*([A-Za-z_$][\w$]*))?/g)) declared.add(d[2] || d[1]);
      }
    }
    for (const m of clean.matchAll(/\bfunction\s*\*?\s*[A-Za-z_$]*\s*\(([^()]*)\)/g)) addParams(m[1]);
    for (const m of clean.matchAll(/\(([^()]*)\)\s*=>/g)) addParams(m[1]);
    for (const m of clean.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
    for (const m of clean.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*=>/g)) declared.add(m[1]);
    for (const m of clean.matchAll(/\bwindow\.([A-Za-z_$][\w$]*)\s*=/g)) declared.add(m[1]);
    for (const m of clean.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function|\()/g)) declared.add(m[1]);
  }
  const bad = [];
  for (const f of CLIENT_FILES) {
    const clean = cleaned.get(f);
    // positions where an identifier is an object-method DEFINITION
    // (`{ name(args) {` / `, name(args) {`) — a definition, not a call.
    // The `{` after the closing paren is required: a plain statement
    // after a block-opening brace (e.g. a reintroduced setTitle(...);)
    // must NOT be excused.
    const defPositions = new Set();
    for (const m of clean.matchAll(/(^|[{,]\s*)(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/gm)) {
      let depth = 0;
      let j = m.index + m[0].length - 1; // at the '('
      for (; j < clean.length; j++) {
        if (clean[j] === '(') depth++;
        else if (clean[j] === ')') { depth--; if (depth === 0) break; }
      }
      let k = j + 1;
      while (k < clean.length && /\s/.test(clean[k])) k++;
      if (clean[k] === '{') defPositions.add(m.index + m[0].indexOf(m[2], m[1].length));
    }
    for (const m of clean.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) {
      const name = m[1];
      if (KEYWORDS.has(name) || declared.has(name)) continue;
      if (defPositions.has(m.index)) continue;
      const line = clean.slice(0, m.index).split('\n').length;
      bad.push(`${f}:${line} calls undefined ${name}()`);
    }
  }
  return bad;
}

function staticChecks() {
  check('1a the scanned set is exactly the staff shell script set in index.html', () => {
    const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
    const loaded = [...html.matchAll(/<script src="\/js\/([\w.-]+\.js)[?"]/g)].map((m) => m[1]).sort();
    assert.deepEqual(loaded, [...CLIENT_FILES].sort());
  });
  check('1b no client script calls an identifier defined nowhere (setTitle class)', () => {
    assert.deepEqual(scanUndefinedCallees(), []);
  });
  check('1c setTitle is gone from the client JS entirely', () => {
    for (const f of CLIENT_FILES) {
      const raw = fs.readFileSync(path.join(root, 'public', 'js', f), 'utf8');
      assert.ok(!/\bsetTitle\b/.test(raw), `${f} still mentions setTitle`);
    }
  });
  check('1d pageArchives keeps its empty state, restore + purge actions and route', () => {
    const app = fs.readFileSync(path.join(root, 'public', 'js', 'app.js'), 'utf8');
    assert.ok(app.includes('archives: pageArchives'), 'PAGES map lost the archives route');
    const start = app.indexOf('async function pageArchives()');
    const slice = app.slice(start, app.indexOf('async function pageWebsites', start));
    assert.ok(slice.includes('No archived websites.'), 'empty state missing');
    assert.ok(slice.includes('data-act="restore"'), 'restore button missing');
    assert.ok(slice.includes('data-act="purge"'), 'purge button missing');
    assert.ok(slice.includes('api.websitesArchived()'), 'list call missing');
    assert.ok(slice.includes('api.websiteUnarchive('), 'restore call missing');
    assert.ok(slice.includes('api.websitePurge('), 'purge call missing');
  });
}

/* ---------------- 2. wiring pins + facade round-trip ---------------- */

function wiringChecks() {
  check('2a server routes for archives list / restore / purge exist', () => {
    const routes = fs.readFileSync(path.join(root, 'server', 'routes', 'domainApi.js'), 'utf8');
    assert.ok(routes.includes("router.get('/websites/archives'"), 'archives list route missing');
    assert.ok(routes.includes("router.post('/websites/:id/restore'"), 'restore route missing');
    assert.ok(routes.includes("router.delete('/websites/:id/purge'"), 'purge route missing');
  });
  check('2b api.js exposes the three archives methods on the same paths', () => {
    const api = fs.readFileSync(path.join(root, 'public', 'js', 'api.js'), 'utf8');
    assert.ok(api.includes("websitesArchived: () => get('/websites/archives')"), 'websitesArchived mismatch');
    assert.ok(api.includes("websiteUnarchive: (id) => post('/websites/' + id + '/restore', {})"), 'websiteUnarchive mismatch');
    assert.ok(api.includes("websitePurge: (id, confirmName) => del('/websites/' + id + '/purge', { confirmName })"), 'websitePurge mismatch');
  });
}

async function facadeRoundTrip() {
  const { openWorkspaceDb } = require(path.join(root, 'server', 'workspaceDb.js'));
  const domain = require(path.join(root, 'server', 'domain.js'));
  const websiteEngine = require(path.join(root, 'src', 'websiteEngine.js'));
  const wdb = openWorkspaceDb(1);
  wdb
    .prepare(
      `INSERT INTO leads (id, business_name, category, phone, email, city, state)
       VALUES (52, 'Fixture Archive Co', 'Services', '(610) 555-0152', 'arch52@example.com', 'Reading', 'PA')`
    )
    .run();
  wdb
    .prepare(
      `INSERT INTO websites (id, lead_id, name, industry, theme, pages, status, preview_url, updated_at)
       VALUES (5201, 52, 'Fixture Archived Site', 'services', '{}', '[]', 'approved', NULL, '2026-10-01 00:00:00')`
    )
    .run();

  await checkAsync('3a a live site is not in the archives list', async () => {
    assert.deepEqual(domain.sitesArchivedList(1).sites, []);
  });
  websiteEngine.deleteWebsite(wdb, 5201); // the soft delete (archive)
  await checkAsync('3b the archived list carries every field pageArchives renders', async () => {
    const { sites } = domain.sitesArchivedList(1);
    assert.equal(sites.length, 1);
    const s = sites[0];
    // pageArchives dereferences exactly: id, name, business_name,
    // lead_id, status, archived_at.
    for (const field of ['id', 'name', 'business_name', 'lead_id', 'status', 'archived_at']) {
      assert.ok(field in s, `archived row missing renderer field ${field}`);
    }
    assert.equal(s.id, 5201);
    assert.equal(s.name, 'Fixture Archived Site');
    assert.equal(s.business_name, 'Fixture Archive Co');
    assert.equal(s.lead_id, 52);
    assert.ok(s.archived_at, 'archived_at is stamped');
  });
  await checkAsync('3c restore via the facade returns the site to the live list', async () => {
    const out = domain.sitesRestoreSite(1, 5201);
    assert.equal(out.restored, true);
    assert.deepEqual(domain.sitesArchivedList(1).sites, []);
    assert.equal(wdb.prepare('SELECT archived_at FROM websites WHERE id = 5201').get().archived_at, null);
  });
  websiteEngine.deleteWebsite(wdb, 5201); // archive again for the purge leg
  await checkAsync('3d purge refuses a wrong confirm name, then destroys on the exact name', async () => {
    const e = await Promise.resolve()
      .then(() => domain.sitesPurgeSite(1, 5201, 'Not The Name'))
      .then(() => null, (err) => err);
    assert.ok(e && e.code === 'CONFIRM_REQUIRED', `got ${e && (e.code || e.message)}`);
    assert.equal(domain.sitesArchivedList(1).sites.length, 1, 'site kept after refused purge');
    // Batch 102 (SEC-19): sitesPurgeSite is async (Cloudflare teardown
    // runs before the local destroy) — await it before counting rows.
    await domain.sitesPurgeSite(1, 5201, 'Fixture Archived Site');
    assert.equal(wdb.prepare('SELECT COUNT(*) AS c FROM websites WHERE id = 5201').get().c, 0, 'row destroyed');
    assert.deepEqual(domain.sitesArchivedList(1).sites, []);
  });
}

/* ---------------- 3. Chromium smoke: the Archives page itself -------- */

async function browserSmoke() {
  const http = require('node:http');
  const express = require('express');
  const puppeteer = require('puppeteer');
  const app = express();
  app.use(express.json());
  let signedIn = false;
  let fixture = [];
  let restoreCalls = 0;
  let purgeCalls = 0;
  let purgeConfirmName = null;
  const ROW = {
    id: 77, lead_id: 52, name: 'Fixture Archived Site', industry: 'services',
    status: 'approved', origin: 'manual', archived_at: '2026-10-01 10:00:00',
    created_at: '2026-09-01 09:00:00', updated_at: '2026-10-01 10:00:00',
    business_name: 'Fixture Archive Co', category: 'Services',
  };
  app.get('/api/v1/auth/me', (req, res) =>
    signedIn
      ? res.json({ ok: true, data: { user: { id: 1, email: 'fixture@example.invalid', isSuperAdmin: true }, workspaceId: 1, workspaces: [{ id: 1, name: 'Fixture', role: 'owner' }], isSuperAdmin: true, productAccess: true } })
      : res.status(401).json({ ok: false, error: 'AUTH_REQUIRED', code: 'AUTH_REQUIRED' })
  );
  app.get('/api/v1/captcha/config', (req, res) => res.json({ ok: true, data: { enabled: false } }));
  app.get('/api/v1/billing/summary', (req, res) => res.json({ ok: true, data: { plan: 'free', plans: [], email: 'fixture@example.invalid', isSuperAdmin: true, credits: { balance: 0 } } }));
  app.get('/api/v1/websites/archives', (req, res) => res.json({ ok: true, data: { sites: fixture } }));
  app.post('/api/v1/websites/77/restore', (req, res) => { restoreCalls++; fixture = []; res.json({ ok: true, data: { id: 77, restored: true } }); });
  app.delete('/api/v1/websites/77/purge', (req, res) => { purgeCalls++; purgeConfirmName = (req.body || {}).confirmName; fixture = []; res.json({ ok: true, data: { id: 77, deleted: true } }); });
  app.use('/api/v1', (req, res) => {
    if (req.method !== 'GET') return res.status(500).json({ ok: false, error: 'No fixture writes allowed' });
    res.json({ ok: true, data: {} });
  });
  app.get('/app', (req, res) => res.sendFile(path.join(root, 'public', 'index.html')));
  app.use(express.static(path.join(root, 'public'), { index: false }));

  let browser;
  let server;
  try {
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = 'http://127.0.0.1:' + server.address().port;
    const exe =
      process.env.PUPPETEER_EXECUTABLE_PATH ||
      (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : await puppeteer.executablePath());
    browser = await puppeteer.launch({ headless: true, executablePath: exe, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('dialog', async (d) => {
      if (d.type() === 'prompt') await d.accept('Fixture Archived Site');
      else await d.accept();
    });
    await page.setRequestInterception(true);
    page.on('request', (r) => (r.url().startsWith(base) ? r.continue() : r.abort()));

    await page.goto(base + '/app#/archives');
    await page.waitForFunction(() => !!document.querySelector('#auth-gate'), { timeout: 15000 });
    signedIn = true;
    await page.reload();

    await checkAsync('4a Archives renders its empty state (no failure card, no pageerror)', async () => {
      await page.waitForFunction(() => document.querySelector('#view')?.textContent.includes('No archived websites.'), { timeout: 15000 });
      const viewText = await page.$eval('#view', (el) => el.textContent);
      assert.ok(viewText.includes('Archived websites'), 'page heading missing');
      assert.ok(!viewText.includes('Page failed to load'), 'failure card rendered');
      assert.deepEqual(errors, [], `pageerrors: ${errors.join('; ')}`);
    });

    fixture = [ROW];
    await page.reload();
    await checkAsync('4b an archived row renders with Restore + Purge buttons', async () => {
      await page.waitForFunction(() => document.querySelector('#arch-body')?.textContent.includes('Fixture Archived Site'), { timeout: 15000 });
      assert.ok(await page.$('#arch-body button[data-act="restore"]'), 'restore button missing');
      assert.ok(await page.$('#arch-body button[data-act="purge"]'), 'purge button missing');
      const viewText = await page.$eval('#view', (el) => el.textContent);
      assert.ok(viewText.includes('Fixture Archive Co'), 'business name missing');
      assert.ok(!viewText.includes('Page failed to load'), 'failure card rendered');
    });

    await page.click('#arch-body button[data-act="restore"]');
    await checkAsync('4c Restore click calls the API and the row clears', async () => {
      await page.waitForFunction(() => document.querySelector('#view')?.textContent.includes('No archived websites.'), { timeout: 15000 });
      assert.equal(restoreCalls, 1);
    });

    fixture = [ROW];
    await page.reload();
    await page.waitForFunction(() => !!document.querySelector('#arch-body button[data-act="purge"]'), { timeout: 15000 });
    await page.click('#arch-body button[data-act="purge"]');
    await checkAsync('4d Purge click sends the exact site name and the row clears', async () => {
      await page.waitForFunction(() => document.querySelector('#view')?.textContent.includes('No archived websites.'), { timeout: 15000 });
      assert.equal(purgeCalls, 1);
      assert.equal(purgeConfirmName, 'Fixture Archived Site');
      assert.deepEqual(errors, [], `pageerrors: ${errors.join('; ')}`);
    });
  } finally {
    if (browser) await browser.close();
    if (server) await new Promise((r) => server.close(r));
  }
}

(async () => {
  staticChecks();
  wiringChecks();
  await facadeRoundTrip();
  await browserSmoke();
  console.log(JSON.stringify({ passed: true, batch: 52, checks: results }));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
