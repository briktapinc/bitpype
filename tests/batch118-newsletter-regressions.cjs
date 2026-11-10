'use strict';
/**
 * Batch 118 — CLIENT NEWSLETTER MODULE (Ely's build order 2026-11-02,
 * with his explicit addition: "allow the user to customize the from
 * email part").
 *
 * Batch 71 built BitPype's OWN staff mailing list (platform-level).
 * This batch gives each CLIENT their own newsletter as a site module:
 * a signup block on the client's site, a per-lead subscriber list in
 * the portal, preview-gated sends (Batch 71 discipline), LeadScout
 * capture, and a customizable From NAME + From EMAIL resolved honestly
 * against what the platform's sending account can actually send as.
 *
 * What is pinned here:
 *   Part 1 — registry: newsletter is the 23rd module type everywhere
 *     the catalog is enumerated (siteModules, portalTabs entitlements,
 *     MCP enums, portal.js, the shared icon map with a real glyph),
 *     and the SEC-13 sink census is untouched (407, no new sinks).
 *   Part 2 — engine (in-process, temp DBs): config + From validation,
 *     subscriber discipline (duplicate = no-op, unsubscribed is never
 *     silently revived, explicit owner resubscribe only), public
 *     signup → subscriber + deduped LeadScout contact/event, HMAC
 *     unsubscribe tokens scoped per workspace+lead (cross-client and
 *     cross-kind tokens act on nothing), effective-From resolution
 *     (default / custom / Reply-To fallback), preview gate (token +
 *     subject/body/From hash + exact confirmCount), per-recipient
 *     failure isolation, send history, public payload carries block
 *     copy only, module delete purges + unlinks LeadScout events.
 *   Part 3 — HTTP over the real server: portal owner full flow
 *     (panel, config, manual add, preview, send with an unconfigured
 *     mailer reported honestly), renter refused (module not in the
 *     renter set), free plan refused (PLAN_REQUIRED), anonymous 401,
 *     public signup + payload, public unsubscribe flips status and is
 *     idempotent, cross-client unsubscribe token refused.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b118-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch118', 'test', 'session', 'secret'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY = process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 18).toString('base64');

const PORT = 31482;
const BASE = `http://127.0.0.1:${PORT}`;
const PW = ['batch118', 'fixture', 'password'].join('-');

const groups = [];
function group(name, n) {
  groups.push(`${name} (${n})`);
  console.log(`  ok ${name} — ${n} checks`);
}
function makeJar() {
  const cookies = new Map();
  return {
    async fetch(url, opts = {}) {
      const headers = { 'x-forwarded-proto': 'https', ...(opts.headers || {}) };
      if (cookies.size) headers.cookie = [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
      if (opts.body && !headers['content-type']) headers['content-type'] = 'application/json';
      const res = await fetch(url, { ...opts, headers, redirect: 'manual' });
      const set = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
      for (const c of set) {
        const pair = String(c).split(';')[0];
        const i = pair.indexOf('=');
        if (i > 0) cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
      }
      return res;
    },
  };
}
async function json(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

const LEAD_A = 11801;
const LEAD_B = 11802;
let WS_ID;
let db;

(async () => {
  /* ================================================================== */
  /* Part 1 — registry + source pins                                     */
  /* ================================================================== */
  {
    let n = 0;
    const sm = require(path.join(root, 'server/siteModules.js'));
    assert.equal(
      sm.MODULE_TYPES.length,
      31,
      'catalog has 30 types (Batch 124: categories 24th; Batch 125: photocapture 25th; Batch 126 finisher: qrcode the 26th; Batch 128: checkout the 27th; Batch 131: comments the 28th; Batch 139: pricing the 29th; Batch 164: custom_code the 30th)'
    );
    n++;
    assert.equal(sm.MODULE_TYPES[22], 'newsletter', 'newsletter is the 23rd type');
    n++;
    assert.equal(sm.MODULE_META.newsletter.label, 'Newsletter');
    n++;
    assert.equal(sm.MODULE_META.newsletter.defaultSlug, 'newsletter');
    n++;

    const portalTabs = require(path.join(root, 'server/portalTabs.js'));
    assert.ok(portalTabs.PORTAL_MODULES.includes('newsletter'), 'owner module set includes newsletter');
    n++;
    const defaults = portalTabs.factoryDefaults();
    assert.ok(!defaults.modules.renter.includes('newsletter'), 'renter module set excludes newsletter');
    n++;
    assert.ok(defaults.modules.owner.includes('newsletter'), 'owner defaults include newsletter');
    n++;
    assert.ok(defaults.modules.partner.includes('newsletter'), 'partner defaults include newsletter');
    n++;

    const icons = read('public/js/moduleIcons.js');
    assert.ok(
      /newsletter:\s*'<rect[^']*<path d="M3\.8 7\.2L12 13l8\.2-5\.8"\/>'/.test(icons),
      'envelope glyph on the shared icon map'
    );
    n++;
    const mcp = read('server/mcp.js');
    assert.equal(
      (mcp.match(/'newsletter',/g) || []).length,
      2,
      'hosted MCP module + moduleType enums carry newsletter'
    );
    n++;
    const catalog = read('src/mcpCatalog.js');
    assert.equal((catalog.match(/'newsletter',/g) || []).length, 2, 'client MCP catalog enums carry newsletter');
    n++;

    const portalJs = read('public/js/portal.js');
    assert.ok(
      portalJs.includes("{ type: 'newsletter', label: 'Newsletter' }"),
      'portal MODULE_TYPES carries newsletter'
    );
    n++;
    assert.ok(portalJs.includes('renderNewsletterAdminPanel'), 'portal renders the newsletter panel');
    n++;
    assert.ok(
      !portalJs
        .slice(
          portalJs.indexOf('function renderNewsletterAdminPanel'),
          portalJs.indexOf('function renderCallTrackingAdminPanel')
        )
        .includes('.innerHTML'),
      'newsletter panel adds no innerHTML sink'
    );
    n++;
    const portalHtml = read('public/portal.html');
    assert.ok(portalHtml.includes('id="modules-pane-newsletter"'), 'portal.html has the newsletter pane');
    n++;
    assert.ok(portalHtml.includes('data-for="newsletter"'), 'portal.html has the newsletter pane tab');
    n++;
    assert.ok(portalHtml.includes('/js/portal.js?v=batch139-pricing1'), 'portal.js cache-busted for Batch 118');
    n++;
    const embed = read('public/js/module-embed.js');
    assert.ok(embed.includes('function renderNewsletter('), 'public embed renders the newsletter block');
    n++;
    assert.ok(embed.includes('/newsletter/subscribe'), 'embed posts to the newsletter subscribe endpoint');
    n++;
    const nlRenderer = embed.slice(
      embed.indexOf('function renderNewsletter('),
      embed.indexOf('function renderCharts(')
    );
    assert.ok(!nlRenderer.includes('.innerHTML'), 'embed newsletter renderer adds no innerHTML sink');
    n++;

    const { census } = require(path.join(root, 'scripts/xss-census.cjs'));
    assert.equal(
      census().summary.total,
      506, // Batch 174 rotation: census 503 -> 506 (+3 IDENT assistantMd writes in portal.js, design-chat redesign — see batch103 narrative); Batch 164 rotation: census 486 -> 492 (+6 audited Custom Code sinks, pairwise-proven — see batch103 narrative); Batch 162 rotation: census 470 -> 474 (+4 audited Contact-page sinks, pairwise-proven — see batch103 narrative); Batch 161 rotation: census 453 -> 470 (+17 audited Assistant-surface sinks, pairwise-proven — see batch103 narrative)
      'SEC-13 census total (Batch 139 finisher: +2 audited safe-class sinks in module-embed.js — pricing renderer; Batch 128 added 13 safe sinks; reviewed set unchanged; Batch 137 finisher: +1 audited SAFE sink in portal.js (qualifying-question rows render — numeric indices + esc()-wrapped question text), census 441 -> 442, SAFE 73 -> 74, reviewed RAW/IDENT content unchanged (12 portal.js positions shifted +127, pure line movement, snippet-verified); Batch 153: census 448 -> 450 — +1 BUILDER +1 RAW in app.js, both the Admin Design-agent editor (rows build — every interpolated value esc()-wrapped; panel shell classified RAW by the conservative classifier, audited: its interpolations are a fixed literal seed note and the numeric limits only, no staff- or visitor-controlled string reaches it unescaped); BUILDER 59 -> 60, RAW 77 -> 78, safe classes 335 -> 336; remaining app.js RAW/IDENT movement is pure line shift from the editor + popup insertions, (file,kind,snippet) multiset diff vs the Batch 139 base = exactly these two sinks; baseline regenerated; Batch 156 rotation: census 450 -> 453 (+1 STATIC +1 ESCAPED +1 SAFE in app.js — fingerprint surfaces), safe classes 336 -> 339, RAW/IDENT reviewed set unchanged; baseline regenerated)'
    );
    n++;
    group('Part 1 registry + source pins', n);
  }

  /* ================================================================== */
  /* Part 2 — engine (in-process)                                        */
  /* ================================================================== */
  const platformDb = require(path.join(root, 'server/db.js'));
  await platformDb.migrate();
  const workspace = require(path.join(root, 'server/workspace.js'));
  const { openWorkspaceDb } = require(path.join(root, 'server/workspaceDb.js'));
  const sm = require(path.join(root, 'server/siteModules.js'));
  const nl = require(path.join(root, 'server/newsletter.js'));
  const portalContacts = require(path.join(root, 'server/portalContacts.js'));

  const a = await workspace.createUserWithWorkspace({
    email: 'a118@example.invalid',
    password: PW,
    name: 'A118',
    workspaceName: 'Batch118 WS',
  });
  // Super admin → premium plan, so the paid-plan module gate passes
  // for in-process portalModules calls (the batch66/71 pattern).
  await platformDb.query('UPDATE users SET is_super_admin = 1 WHERE email = :e', { e: 'a118@example.invalid' });
  WS_ID = Number(a.workspaceId);
  db = openWorkspaceDb(WS_ID);
  sm.ensureTables(db);
  db.prepare('INSERT INTO leads (id, business_name, email, status) VALUES (?, ?, ?, ?)').run(
    LEAD_A,
    'B118 Alpha Cuts',
    'alpha118@example.invalid',
    'customer'
  );
  db.prepare('INSERT INTO leads (id, business_name, email, status) VALUES (?, ?, ?, ?)').run(
    LEAD_B,
    'B118 Beta Lawns',
    'beta118@example.invalid',
    'customer'
  );
  db.prepare('INSERT INTO websites (lead_id, name, theme, pages, status) VALUES (?, ?, ?, ?, ?)').run(
    LEAD_A,
    'Alpha Site',
    '{}',
    JSON.stringify([{ slug: 'home', title: 'Home', html: '<p>hi</p>' }]),
    'draft'
  );

  {
    let n = 0;
    const cfg = nl.getConfig(db, LEAD_A);
    assert.equal(cfg.heading, 'Join our newsletter', 'default heading');
    n++;
    assert.equal(cfg.from_email, '', 'default From email empty');
    n++;
    assert.throws(
      () => nl.saveConfig(db, LEAD_A, { from_email: 'not-an-email' }),
      (e) => e.code === 'VALIDATION',
      'invalid From email refused'
    );
    n++;
    const saved = nl.saveConfig(db, LEAD_A, {
      heading: 'The Alpha Letter',
      from_name: 'Alpha Cuts',
      from_email: 'News@AlphaCuts.example',
    });
    assert.equal(saved.heading, 'The Alpha Letter');
    n++;
    assert.equal(saved.from_email, 'news@alphacuts.example', 'From email normalized');
    n++;
    group('Part 2a config + From validation', n);
  }

  {
    let n = 0;
    const r1 = nl.addSubscriber(db, LEAD_A, { email: '  First@Example.com ', name: ' First  Person ' });
    assert.equal(r1.added, true);
    n++;
    assert.equal(r1.subscriber.email, 'first@example.com', 'email normalized');
    n++;
    const dup = nl.addSubscriber(db, LEAD_A, { email: 'first@example.com' });
    assert.equal(dup.added, false);
    assert.equal(dup.duplicate, true, 'duplicate active signup is a no-op');
    n++;
    nl.setSubscriberStatus(db, LEAD_A, r1.subscriber.id, 'unsubscribed');
    const blocked = nl.addSubscriber(db, LEAD_A, { email: 'first@example.com' });
    assert.equal(blocked.added, false);
    assert.equal(blocked.blocked, true, 'unsubscribed signup does NOT silently revive');
    n++;
    assert.equal(nl.getSubscriberById(db, LEAD_A, r1.subscriber.id).status, 'unsubscribed');
    n++;
    const back = nl.setSubscriberStatus(db, LEAD_A, r1.subscriber.id, 'active');
    assert.equal(back.status, 'active', 'explicit owner resubscribe flips back');
    n++;
    const counts = nl.countSubscribers(db, LEAD_A);
    assert.deepEqual(counts, { active: 1, unsubscribed: 0, total: 1 });
    n++;
    // Isolation: the same email on another lead is a different list.
    const other = nl.addSubscriber(db, LEAD_B, { email: 'first@example.com' });
    assert.equal(other.added, true, 'same email subscribes independently per lead');
    n++;
    assert.equal(nl.getSubscriberById(db, LEAD_A, other.subscriber.id), null, 'subscriber ids are lead-scoped');
    n++;
    group('Part 2b subscriber discipline + isolation', n);
  }

  let embedToken;
  {
    let n = 0;
    const emb = sm.ensureEmbed(db, LEAD_A, 'newsletter', { workspaceId: WS_ID });
    db.prepare('UPDATE site_module_embeds SET published = 1 WHERE id = ?').run(emb.id);
    embedToken = emb.public_token;
    assert.ok(embedToken, 'embed token minted');
    n++;
    const res = nl.subscribeByToken(db, embedToken, { email: 'visitor@example.com', name: 'Visitor One' });
    assert.equal(res.ok, true);
    assert.equal(res.added, true);
    n++;
    const sub = nl.getSubscriberByEmail(db, LEAD_A, 'visitor@example.com');
    assert.ok(sub && sub.source === 'embed', 'signup recorded with embed source');
    n++;
    const contact = db.prepare("SELECT * FROM leadscout_contacts WHERE email_norm = 'visitor@example.com'").get();
    assert.ok(contact, 'LeadScout contact captured');
    n++;
    const ev = db.prepare('SELECT * FROM leadscout_events WHERE newsletter_subscriber_id = ?').get(sub.id);
    assert.ok(
      ev && ev.kind === 'newsletter' && ev.source_label === 'Newsletter signup',
      'LeadScout event sourced to the signup'
    );
    n++;
    const again = nl.subscribeByToken(db, embedToken, { email: 'visitor@example.com', name: 'Visitor One' });
    assert.equal(again.added, false, 'repeat signup adds nothing');
    n++;
    const evCount = db
      .prepare('SELECT COUNT(*) AS c FROM leadscout_events WHERE newsletter_subscriber_id = ?')
      .get(sub.id).c;
    assert.equal(evCount, 1, 'no duplicate LeadScout event');
    n++;
    assert.throws(
      () => nl.subscribeByToken(db, embedToken, { email: 'nope' }),
      (e) => e.code === 'VALIDATION',
      'invalid email refused'
    );
    n++;
    assert.throws(
      () => nl.subscribeByToken(db, 'bogus-token', { email: 'x@example.com' }),
      (e) => e.code === 'NOT_FOUND',
      'unknown token refused'
    );
    n++;
    // Public payload carries block copy only — never list data.
    const payload = sm.getPublicModuleByToken(db, embedToken);
    assert.equal(payload.module_type, 'newsletter');
    assert.equal(payload.newsletter.heading, 'The Alpha Letter', 'public payload carries the block copy');
    n++;
    assert.ok(!JSON.stringify(payload).includes('visitor@example.com'), 'public payload leaks no subscriber data');
    n++;
    assert.equal(sm.moduleItemCount(db, LEAD_A, 'newsletter'), 2, 'tab badge counts active subscribers');
    n++;
    group('Part 2c public signup + LeadScout capture + payload', n);
  }

  {
    let n = 0;
    const sub = nl.getSubscriberByEmail(db, LEAD_A, 'visitor@example.com');
    const url = nl.unsubscribeUrl(WS_ID, LEAD_A, sub.id);
    const token = decodeURIComponent(url.split('/unsubscribe/')[1]);
    const parsed = nl.verifyUnsubscribeToken(token);
    assert.deepEqual(parsed, { workspaceId: WS_ID, leadId: LEAD_A, subscriberId: sub.id }, 'token round-trips');
    n++;
    const done = await nl.applyUnsubscribe(token);
    assert.equal(done.ok, true);
    assert.equal(done.already, false);
    assert.equal(done.businessName, 'B118 Alpha Cuts');
    n++;
    assert.equal(nl.getSubscriberById(db, LEAD_A, sub.id).status, 'unsubscribed', 'unsubscribe flipped the status');
    n++;
    const againRes = await nl.applyUnsubscribe(token);
    assert.equal(againRes.ok, true);
    assert.equal(againRes.already, true, 'second click is idempotent');
    n++;
    // Cross-client: a well-formed token naming lead B with lead A's
    // subscriber id matches nothing on B's list and changes nothing.
    const foreign = nl.signUnsubscribeToken(WS_ID, LEAD_B, sub.id);
    const refused = await nl.applyUnsubscribe(foreign);
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'NOT_FOUND', 'cross-client token refused');
    n++;
    // Tampered token refused.
    const tampered = token.slice(0, -2) + 'xx';
    const bad = await nl.applyUnsubscribe(tampered);
    assert.equal(bad.ok, false);
    assert.equal(bad.code, 'INVALID_TOKEN');
    n++;
    // A Batch 71 staff-list token (different action) never verifies here.
    const ml = require(path.join(root, 'server/mailingList.js'));
    const mlToken = ml.signUnsubscribeToken(1);
    assert.throws(
      () => nl.verifyUnsubscribeToken(mlToken),
      (e) => e.code === 'INVALID_TOKEN',
      'staff-list token is a different kind'
    );
    n++;
    // And the re-signup of the unsubscribed visitor stays blocked.
    const re = nl.subscribeByToken(db, embedToken, { email: 'visitor@example.com' });
    assert.equal(re.added, false, 'public re-signup does not revive an unsubscribed address');
    n++;
    assert.equal(nl.getSubscriberById(db, LEAD_A, sub.id).status, 'unsubscribed');
    n++;
    group('Part 2d unsubscribe tokens + isolation', n);
  }

  {
    let n = 0;
    const { matchSenderEntry } = require(path.join(root, 'src/mailjetSender.js'));
    const entries = [
      { Email: 'hello@bitpype.test', Status: 'Active' },
      { Email: '*@alphacuts.example', Status: 'Active' },
      { Email: 'beta.example', Status: 'Active' },
      { Email: 'idle@other.example', Status: 'Inactive' },
    ];
    assert.equal(matchSenderEntry(entries, 'hello@bitpype.test'), true, 'exact sender matches');
    n++;
    assert.equal(matchSenderEntry(entries, 'news@alphacuts.example'), true, 'wildcard domain sender matches');
    n++;
    assert.equal(matchSenderEntry(entries, 'any@beta.example'), true, 'whole-domain sender entry matches');
    n++;
    assert.equal(matchSenderEntry(entries, 'idle@other.example'), false, 'inactive sender does not match');
    n++;
    assert.equal(matchSenderEntry(entries, 'x@unrelated.example'), false, 'unrelated domain does not match');
    n++;

    const cfSettings = {
      'mail.provider': 'cloudflare',
      'smtp.from_email': 'hello@bitpype.test',
      'smtp.from_name': 'BitPype',
      'smtp.host': '',
    };
    // Restore a known config on lead A for resolution checks.
    nl.saveConfig(db, LEAD_A, { from_name: 'Alpha Cuts', from_email: '' });
    let st = await nl.resolveFrom(WS_ID, LEAD_A, { settings: cfSettings });
    assert.equal(st.state, 'default', 'no custom From → platform default');
    assert.equal(st.fromEmail, 'hello@bitpype.test');
    assert.equal(st.fromName, 'Alpha Cuts', 'owner From NAME honoured even on the default sender');
    n++;
    nl.saveConfig(db, LEAD_A, { from_email: 'news@bitpype.test' });
    st = await nl.resolveFrom(WS_ID, LEAD_A, { settings: cfSettings });
    assert.equal(st.state, 'custom', 'same-domain custom From is authenticated (provider domain rule)');
    assert.equal(st.fromEmail, 'news@bitpype.test');
    assert.equal(st.replyTo, '');
    n++;
    nl.saveConfig(db, LEAD_A, { from_email: 'news@alphacuts.example' });
    st = await nl.resolveFrom(WS_ID, LEAD_A, { settings: cfSettings });
    assert.equal(st.state, 'fallback', 'unverified domain falls back');
    assert.equal(st.fromEmail, 'hello@bitpype.test', 'fallback sends from the platform address');
    assert.equal(st.replyTo, 'news@alphacuts.example', 'owner address becomes Reply-To');
    assert.ok(st.note.includes("isn't verified for sending yet"), 'fallback state is stated plainly');
    n++;
    // Mailjet path: the injected checker decides.
    const mjSettings = {
      'mail.provider': '',
      'smtp.host': 'in-v3.mailjet.com',
      'smtp.from_email': 'hello@bitpype.test',
      'smtp.from_name': 'BitPype',
    };
    st = await nl.resolveFrom(WS_ID, LEAD_A, {
      settings: mjSettings,
      senderIsAuthenticated: async () => true,
    });
    assert.equal(st.state, 'custom', 'Mailjet-verified sender sends as the owner');
    n++;
    st = await nl.resolveFrom(WS_ID, LEAD_A, {
      settings: mjSettings,
      senderIsAuthenticated: async () => false,
    });
    assert.equal(st.state, 'fallback', 'Mailjet-unverified sender falls back');
    n++;
    group('Part 2e effective From resolution', n);
  }

  {
    let n = 0;
    // Fixture: lead B with two active + the shared unsubscribed pattern.
    nl.saveConfig(db, LEAD_B, { heading: 'Beta News', from_name: 'Beta Lawns', from_email: '' });
    const b1 = nl.addSubscriber(db, LEAD_B, { email: 'one@beta.example', name: 'One' }).subscriber;
    const b2 = nl.addSubscriber(db, LEAD_B, { email: 'two@beta.example', name: 'Two' }).subscriber;
    const cfSettings = {
      'mail.provider': 'cloudflare',
      'smtp.from_email': 'hello@bitpype.test',
      'smtp.from_name': 'BitPype',
      'smtp.host': '',
    };
    const sent = [];
    const sendMail = async (m) => {
      sent.push(m);
      if (m.to === 'two@beta.example') throw new Error('mailbox full (fixture)');
      return { sent: true };
    };
    const deps = { settings: cfSettings, sendMail };

    await assert.rejects(
      () => nl.sendIssue(WS_ID, LEAD_B, { subject: 'Hi', bodyHtml: '<p>Hello {{name}}</p>', confirmCount: 2 }, deps),
      (e) => e.code === 'PREVIEW_REQUIRED',
      'send without preview refused'
    );
    n++;
    await assert.rejects(
      () => nl.previewIssue(WS_ID, LEAD_B, { subject: 'Hi', bodyHtml: '<p>x</p><script>alert(1)</script>' }, deps),
      (e) => e.code === 'VALIDATION',
      'script in body refused'
    );
    n++;
    const pv = await nl.previewIssue(
      WS_ID,
      LEAD_B,
      { subject: 'Beta Update', bodyHtml: '<p>Hello {{name}}</p>' },
      deps
    );
    assert.equal(pv.recipientCount, 3, 'preview counts active subscribers (incl. Part 2b subscriber)');
    n++;
    assert.equal(pv.from.state, 'default');
    n++;
    await assert.rejects(
      () =>
        nl.sendIssue(
          WS_ID,
          LEAD_B,
          {
            subject: 'Beta Update',
            bodyHtml: '<p>Hello {{name}}</p>',
            previewToken: pv.previewToken,
            confirmCount: 99,
          },
          deps
        ),
      (e) => e.code === 'CONFIRM_MISMATCH',
      'wrong confirm count refused'
    );
    n++;
    // The failed confirm did not consume the token.
    const out = await nl.sendIssue(
      WS_ID,
      LEAD_B,
      { subject: 'Beta Update', bodyHtml: '<p>Hello {{name}}</p>', previewToken: pv.previewToken, confirmCount: 3 },
      deps
    );
    assert.equal(out.recipients, 3);
    assert.equal(out.sent, 2, 'one failure does not abort the rest');
    assert.equal(out.failed, 1);
    assert.equal(out.partial, true);
    n++;
    const toTwo = sent.find((m) => m.to === 'two@beta.example');
    const toOne = sent.find((m) => m.to === 'one@beta.example');
    assert.ok(toOne.html.includes('Hello One'), 'name placeholder substituted per recipient');
    n++;
    assert.ok(toOne.html.includes('B118 Beta Lawns'), 'footer names the business');
    n++;
    const unsubMatch = /\/api\/v1\/newsletter\/unsubscribe\/([A-Za-z0-9_\-.]+)/.exec(toOne.html);
    assert.ok(unsubMatch, 'issue carries the per-client unsubscribe link');
    n++;
    const parsedTok = nl.verifyUnsubscribeToken(decodeURIComponent(unsubMatch[1]));
    assert.equal(parsedTok.subscriberId, b1.id, 'unsubscribe link is scoped to the recipient');
    assert.equal(parsedTok.leadId, LEAD_B);
    n++;
    assert.equal(toOne.from.email, 'hello@bitpype.test', 'mail carries the resolved From');
    n++;
    const sends = nl.listSends(db, LEAD_B);
    assert.equal(sends.length, 1, 'send history recorded');
    assert.equal(sends[0].recipient_count, 3);
    assert.equal(sends[0].sent_count, 2);
    assert.equal(sends[0].failed_count, 1);
    assert.equal(sends[0].from_email, 'hello@bitpype.test');
    n++;
    // Draft change after preview → fresh preview required.
    const pv2 = await nl.previewIssue(WS_ID, LEAD_B, { subject: 'Beta Update', bodyHtml: '<p>v2</p>' }, deps);
    await assert.rejects(
      () =>
        nl.sendIssue(
          WS_ID,
          LEAD_B,
          { subject: 'Beta Update', bodyHtml: '<p>v2 CHANGED</p>', previewToken: pv2.previewToken, confirmCount: 3 },
          deps
        ),
      (e) => e.code === 'PREVIEW_REQUIRED',
      'changed body after preview refused'
    );
    n++;
    // From-settings change after preview → fresh preview required.
    const pv3 = await nl.previewIssue(WS_ID, LEAD_B, { subject: 'Beta Update', bodyHtml: '<p>v3</p>' }, deps);
    nl.saveConfig(db, LEAD_B, { from_email: 'news@elsewhere.example' });
    await assert.rejects(
      () =>
        nl.sendIssue(
          WS_ID,
          LEAD_B,
          { subject: 'Beta Update', bodyHtml: '<p>v3</p>', previewToken: pv3.previewToken, confirmCount: 3 },
          deps
        ),
      (e) => e.code === 'PREVIEW_REQUIRED',
      'changed From after preview refused'
    );
    n++;
    nl.saveConfig(db, LEAD_B, { from_email: '' });
    group('Part 2f preview gate + send', n);
  }

  {
    let n = 0;
    const pm = require(path.join(root, 'server/portalModules.js'));
    const listed = await pm.listModuleItems(WS_ID, LEAD_A, 'newsletter', 'a118@example.invalid');
    assert.equal(listed.module_type, 'newsletter');
    assert.ok(listed.newsletter && listed.newsletter.config, 'portal list carries the newsletter block');
    assert.ok(listed.newsletter.from && listed.newsletter.from.state, 'portal list carries the effective From');
    n++;
    await assert.rejects(
      () => pm.createModuleItem(WS_ID, LEAD_A, 'newsletter', {}, 'a118@example.invalid'),
      (e) => e.code === 'VALIDATION' && /Newsletter tab/.test(e.message),
      'generic item create refuses with guidance'
    );
    n++;
    // Module delete purges the list and unlinks LeadScout events.
    const sub = nl.getSubscriberByEmail(db, LEAD_A, 'first@example.com');
    assert.ok(sub, 'fixture subscriber present before delete');
    n++;
    const del = sm.deleteModule(db, LEAD_A, 'newsletter');
    assert.equal(del.purged.newsletter_subscribers, 2, 'subscribers purged on module delete');
    assert.equal(del.purged.newsletter_configs, 1, 'config purged on module delete');
    n++;
    const evLeft = db.prepare("SELECT COUNT(*) AS c FROM leadscout_events WHERE kind = 'newsletter'").get().c;
    assert.equal(evLeft, 0, 'LeadScout newsletter events unlinked on module delete');
    n++;
    const contactLeft = db
      .prepare("SELECT COUNT(*) AS c FROM leadscout_contacts WHERE email_norm = 'visitor@example.com'")
      .get().c;
    assert.equal(contactLeft, 1, 'the LeadScout CONTACT itself stays (Batch 45 precedent)');
    n++;
    group('Part 2g portal surface + module delete', n);
  }

  /* ================================================================== */
  /* Part 3 — HTTP over the real server                                  */
  /* ================================================================== */
  {
    let n = 0;
    const q = platformDb.query;
    const bcrypt = require('bcryptjs');
    // Re-attach the module deleted in Part 2g + two subscribers.
    const emb = sm.ensureEmbed(db, LEAD_A, 'newsletter', { workspaceId: WS_ID });
    db.prepare('UPDATE site_module_embeds SET published = 1 WHERE id = ?').run(emb.id);
    const token = emb.public_token;
    nl.addSubscriber(db, LEAD_A, { email: 'http-one@example.com', name: 'Http One' });
    nl.addSubscriber(db, LEAD_A, { email: 'http-two@example.com', name: 'Http Two' });

    // Portal users: owner + renter on lead A (plan via super-admin
    // platform users, the batch66 pattern), plus a FREE-plan owner on
    // a second workspace for the PLAN_REQUIRED gate.
    for (const [email, type] of [
      ['owner118@example.invalid', 'owner'],
      ['renter118@example.invalid', 'renter'],
    ]) {
      await q('INSERT INTO users (email, password_hash, name, is_super_admin, status) VALUES (:e, :h, :n, 1, :s)', {
        e: email,
        h: bcrypt.hashSync('UnusedPass118!', 12),
        n: 'B118 Portal Link',
        s: 'active',
      });
      await q(
        `INSERT INTO client_portal_users (email, password_hash, workspace_id, lead_id, business_name, status, user_type)
         VALUES (:e, :h, :w, :l, :b, 'active', :t)`,
        { e: email, h: bcrypt.hashSync(PW, 12), w: WS_ID, l: LEAD_A, b: 'B118 Alpha Cuts', t: type }
      );
    }
    const free = await workspace.createUserWithWorkspace({
      email: 'free118@example.invalid',
      password: PW,
      name: 'Free118',
      workspaceName: 'Batch118 Free WS',
    });
    const freeDb = openWorkspaceDb(Number(free.workspaceId));
    sm.ensureTables(freeDb);
    freeDb
      .prepare('INSERT INTO leads (id, business_name, email, status) VALUES (?, ?, ?, ?)')
      .run(11809, 'B118 Free Co', 'free118co@example.invalid', 'customer');
    await q(
      `INSERT INTO client_portal_users (email, password_hash, workspace_id, lead_id, business_name, status, user_type)
       VALUES (:e, :h, :w, :l, :b, 'active', 'owner')`,
      {
        e: 'free118@example.invalid',
        h: bcrypt.hashSync(PW, 12),
        w: Number(free.workspaceId),
        l: 11809,
        b: 'B118 Free Co',
      }
    );

    // Platform mail identity for From-resolution over HTTP: Cloudflare
    // provider selected (domain rule), platform From on bitpype.test.
    const platform = require(path.join(root, 'server/platform.js'));
    await platform.setPlatformSetting('mail.provider', 'cloudflare');
    await platform.setPlatformSetting('mail.cf_token', 'fixture-token');
    await platform.setPlatformSetting('mail.cf_account_id', 'fixture-account');
    await platform.setPlatformSetting('smtp.from_email', 'hello@bitpype.test');
    await platform.setPlatformSetting('smtp.from_name', 'BitPype');

    const child = spawn(process.execPath, [path.join(root, 'server.js')], {
      cwd: root,
      env: { ...process.env, PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (b) => (output += b));
    child.stderr.on('data', (b) => (output += b));
    const closed = new Promise((resolve) => child.once('close', resolve));
    try {
      let ready = false;
      for (let i = 0; i < 300 && !ready; i++) {
        if (child.exitCode != null) throw new Error('server exited early: ' + output);
        try {
          const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(500) });
          if (r.ok) ready = true;
        } catch {}
        if (!ready) await new Promise((r) => setTimeout(r, 200));
      }
      assert(ready, 'server did not become ready: ' + output);
      n++;

      const post = (jar, p, body) => jar.fetch(BASE + p, { method: 'POST', body: JSON.stringify(body || {}) });
      const portalSession = async (email) => {
        const jar = makeJar();
        const res = await post(jar, '/api/v1/portal/login', { email, password: PW });
        assert.equal(res.status, 200, `portal login for ${email}`);
        return jar;
      };
      const owner = await portalSession('owner118@example.invalid');
      const renter = await portalSession('renter118@example.invalid');
      const freeOwner = await portalSession('free118@example.invalid');
      n++;

      // Anonymous refused.
      {
        const res = await fetch(`${BASE}/api/v1/portal/modules/newsletter/panel`);
        assert.equal(res.status, 401, 'anonymous panel read refused');
        n++;
      }
      // Renter refused: newsletter is not in the renter module set.
      {
        const res = await renter.fetch(`${BASE}/api/v1/portal/modules/newsletter/panel`);
        assert.equal(res.status, 403, 'renter refused the newsletter panel');
        n++;
      }
      // Free plan refused by the module plan gate.
      {
        const res = await freeOwner.fetch(`${BASE}/api/v1/portal/modules/newsletter/panel`);
        const body = await json(res);
        assert.equal(res.status, 403, 'free plan refused');
        assert.equal(body.code, 'PLAN_REQUIRED');
        n++;
      }
      // Owner panel: config + counts + effective From.
      {
        const res = await owner.fetch(`${BASE}/api/v1/portal/modules/newsletter/panel`);
        const body = await json(res);
        assert.equal(res.status, 200, JSON.stringify(body));
        assert.equal(body.data.counts.active, 2, 'panel counts the two subscribers');
        assert.equal(body.data.from.state, 'default');
        assert.equal(body.data.from.fromEmail, 'hello@bitpype.test');
        n++;
      }
      // Config save: unverified-domain From → fallback state, plainly.
      {
        const res = await owner.fetch(`${BASE}/api/v1/portal/modules/newsletter/config`, {
          method: 'PUT',
          body: JSON.stringify({ from_name: 'Alpha Cuts', from_email: 'news@alphacuts.example' }),
        });
        const body = await json(res);
        assert.equal(res.status, 200, JSON.stringify(body));
        assert.equal(body.data.from.state, 'fallback');
        assert.equal(body.data.from.replyTo, 'news@alphacuts.example');
        assert.ok(body.data.from.note.includes("isn't verified for sending yet"));
        n++;
      }
      // Same-domain From → custom state.
      {
        const res = await owner.fetch(`${BASE}/api/v1/portal/modules/newsletter/config`, {
          method: 'PUT',
          body: JSON.stringify({ from_email: 'news@bitpype.test' }),
        });
        const body = await json(res);
        assert.equal(body.data.from.state, 'custom');
        assert.equal(body.data.from.fromEmail, 'news@bitpype.test');
        n++;
      }
      // Preview gate over HTTP.
      {
        const sendRes = await post(owner, '/api/v1/portal/modules/newsletter/send', {
          subject: 'HTTP Issue',
          bodyHtml: '<p>Hello</p>',
          confirmCount: 2,
        });
        const sendBody = await json(sendRes);
        assert.equal(sendRes.status, 400);
        assert.equal(sendBody.code, 'PREVIEW_REQUIRED', 'HTTP send without preview refused');
        n++;
        const pvRes = await post(owner, '/api/v1/portal/modules/newsletter/preview', {
          subject: 'HTTP Issue',
          bodyHtml: '<p>Hello {{name}}</p>',
        });
        const pv = await json(pvRes);
        assert.equal(pvRes.status, 200, JSON.stringify(pv));
        assert.equal(pv.data.recipientCount, 2);
        assert.equal(pv.data.from.state, 'custom');
        assert.ok(pv.data.rendered.html.includes('Hello Http One'), 'preview renders the first subscriber');
        n++;
        // Send: the Cloudflare fixture account cannot really send —
        // the failure must be honest (recorded, counted), never faked.
        const okRes = await post(owner, '/api/v1/portal/modules/newsletter/send', {
          subject: 'HTTP Issue',
          bodyHtml: '<p>Hello {{name}}</p>',
          previewToken: pv.data.previewToken,
          confirmCount: 2,
        });
        const okBody = await json(okRes);
        assert.equal(okRes.status, 200, JSON.stringify(okBody));
        assert.equal(okBody.data.recipients, 2);
        assert.equal(okBody.data.sent + okBody.data.failed, 2, 'every recipient accounted for');
        const panelRes = await owner.fetch(`${BASE}/api/v1/portal/modules/newsletter/panel`);
        const panel = await json(panelRes);
        assert.equal(panel.data.sends.length, 1, 'send recorded in history');
        assert.equal(panel.data.sends[0].from_email, 'news@bitpype.test', 'history keeps the effective From');
        n++;
      }
      // Public payload + signup over HTTP.
      {
        const res = await fetch(`${BASE}/api/v1/modules/public/${encodeURIComponent(token)}`);
        const body = await json(res);
        assert.equal(res.status, 200);
        assert.equal(body.data.module_type, 'newsletter');
        assert.ok(body.data.newsletter && body.data.newsletter.heading, 'public payload carries the block');
        n++;
        const sub = await fetch(`${BASE}/api/v1/modules/public/${encodeURIComponent(token)}/newsletter/subscribe`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https' },
          body: JSON.stringify({ email: 'http-three@example.com', name: 'Http Three' }),
        });
        const subBody = await json(sub);
        assert.equal(sub.status, 200, JSON.stringify(subBody));
        assert.equal(subBody.data.message, 'Thanks — your signup was received.', 'state-blind public response');
        n++;
        const listRes = await owner.fetch(`${BASE}/api/v1/portal/modules/newsletter/subscribers`);
        const list = await json(listRes);
        assert.ok(
          list.data.subscribers.some((s) => s.email === 'http-three@example.com' && s.source === 'embed'),
          'HTTP signup visible in the portal list'
        );
        n++;
      }
      // Public unsubscribe over HTTP + idempotency + cross-client.
      {
        const sub3 = nl.getSubscriberByEmail(db, LEAD_A, 'http-three@example.com');
        const url = nl.unsubscribeUrl(WS_ID, LEAD_A, sub3.id);
        const tok = decodeURIComponent(url.split('/unsubscribe/')[1]);
        const res = await fetch(`${BASE}/api/v1/newsletter/unsubscribe/${tok}`);
        const html = await res.text();
        assert.equal(res.status, 200);
        assert.ok(html.includes('You have been unsubscribed'), 'unsubscribe page confirms');
        assert.ok(html.includes('B118 Alpha Cuts'), 'unsubscribe page names the business');
        n++;
        assert.equal(nl.getSubscriberById(db, LEAD_A, sub3.id).status, 'unsubscribed');
        n++;
        const res2 = await fetch(`${BASE}/api/v1/newsletter/unsubscribe/${tok}`);
        const html2 = await res2.text();
        assert.equal(res2.status, 200);
        assert.ok(html2.includes('already unsubscribed'), 'second click idempotent');
        n++;
        const foreign = nl.signUnsubscribeToken(WS_ID, LEAD_B, sub3.id);
        const res3 = await fetch(`${BASE}/api/v1/newsletter/unsubscribe/${foreign}`);
        assert.equal(res3.status, 404, 'cross-client token refused over HTTP');
        n++;
      }
    } finally {
      child.kill('SIGKILL');
      await closed;
    }
    group('Part 3 HTTP portal + public flow', n);
  }

  console.log(`\nBATCH118 REGRESSIONS: ALL PASS — ${groups.length} groups`);
})().catch((e) => {
  console.error('BATCH118 REGRESSIONS: FAIL');
  console.error(e);
  process.exit(1);
});
