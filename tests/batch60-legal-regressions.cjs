'use strict';
/**
 * Batch 60 — legal documents + generated site-level legal pages.
 *   A. Platform Terms/Privacy files: serve-time tokens only (zero '{{'
 *      after the sendTemplatedPage substitution), pinned third-party
 *      inventory, the third-party-outage liability clause, Cloudflare +
 *      Hostinger incorporation links, feature-specific pins, Privacy
 *      subprocessor list, and the Batch 56 census (exactly ONE
 *      first-party domain literal in shipped code).
 *   B. Site-level generator (src/siteLegal.js via writeStaticPages):
 *      every export ships /terms + /privacy built from verified fixture
 *      data; clause blocks appear ONLY for attached modules; footer
 *      links + sitemap entries; owner-authored legal pages win.
 *   C. DB-driven: site_module_embeds (published only) + analytics
 *      settings flow through buildSeoExportContext into the clauses,
 *      and qaSite's foundations check passes with the legal pages.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = process.env.BITPYPE_TEST_ROOT || path.resolve(__dirname, '..');
let Database;
try {
  Database = require('better-sqlite3');
} catch {
  Database = require('node:sqlite').DatabaseSync;
}
const results = [];
function check(name, fn) {
  fn();
  results.push(name);
}
async function acheck(name, fn) {
  await fn();
  results.push(name);
}

process.env.EXPORT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bp60-exports-'));
// Batch 60 renewals (section D): server modules read DB env at require
// time — point them at throwaway temp stores before anything loads them.
process.env.DB_DRIVER = 'sqlite';
process.env.SQLITE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bp60-server-')), 'server.db');
process.env.WORKSPACE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bp60-ws-'));
const engine = require(path.join(root, 'src/websiteEngine.js'));
const siteLegal = require(path.join(root, 'src/siteLegal.js'));

/* ---------------- A. Platform legal pages ---------------- */

function templated(rel) {
  const raw = fs.readFileSync(path.join(root, 'public', rel), 'utf8');
  // Mirror server.js sendTemplatedPage exactly.
  return raw
    .split('{{PUBLIC_URL}}').join('https://example.test')
    .split('{{SUPPORT_EMAIL}}').join('support@example.test');
}

const THIRD_PARTIES = ['Cloudflare', 'Hostinger', 'Stripe', 'Twilio', 'Mailjet',
  'OpenAI', 'fal.ai', 'Pexels', 'Tavily', 'Google', 'Meta', 'YouTube', 'Vimeo'];

function platformChecks() {
  const terms = templated('legal/terms.html');
  const privacy = templated('legal/privacy.html');

  check('A1 legal pages: tokens substitute cleanly, zero {{ leakage, support token present in source', () => {
    for (const rel of ['legal/terms.html', 'legal/privacy.html']) {
      const raw = fs.readFileSync(path.join(root, 'public', rel), 'utf8');
      assert.ok(raw.includes('{{SUPPORT_EMAIL}}'), `${rel} must use the SUPPORT_EMAIL token`);
      const out = templated(rel);
      assert.ok(!out.includes('{{'), `${rel} leaks a token after substitution`);
      assert.ok(out.includes('support@example.test'), `${rel} support email substituted`);
    }
    assert.ok(terms.includes('https://example.test'), 'terms PUBLIC_URL token substituted');
    assert.ok(privacy.includes('https://example.test'), 'privacy PUBLIC_URL token substituted');
  });

  check('A2 terms: every pinned third-party name appears', () => {
    for (const name of THIRD_PARTIES) {
      assert.ok(terms.includes(name), `terms page missing third party: ${name}`);
    }
  });

  check('A3 terms: third-party outage liability clause (pinned phrases)', () => {
    assert.ok(terms.includes('We are not liable for third-party outages or changes'), 'outage clause heading');
    assert.ok(
      terms.includes('BitPype is not responsible or liable for outages, downtime, slowness, degraded performance, data loss, pricing changes, feature changes, policy or terms changes, suspensions, or discontinuations of any third-party service'),
      'outage clause body'
    );
  });

  check('A4 terms: Cloudflare + Hostinger terms incorporated by reference (official URLs)', () => {
    assert.ok(terms.includes('https://www.cloudflare.com/terms/'), 'Cloudflare SSA link');
    assert.ok(terms.includes('https://www.cloudflare.com/domain-registration-agreement/'), 'Cloudflare Registrar link');
    assert.ok(terms.includes('https://www.hostinger.com/legal/universal-terms-of-service-agreement'), 'Hostinger UTOS link');
  });

  check('A5 terms: feature-specific pins (lifecycle, credits, rentals, GBP honesty, MCP custody)', () => {
    const pins = [
      'Your plan stays active and your website stays live',   // cancel_at_period_end
      'Resubscribing does not automatically bring sites back', // no auto re-enable
      'at or under the included cap (currently $25)',         // domain cap
      'at least <strong>15 seconds</strong>',                 // call counting rule
      '1 credit per transcript',                              // transcription credit
      'never holds, routes, or has custody of those funds',   // owner Stripe
      'not the seller or merchant of record',                 // memberships/shop
      'charged <strong>exactly once</strong>',                // rentals exactly-once
      'lead delivery is never blocked by billing',            // rentals due rule
      'Google API access still pending — nothing was sent.',  // GBP drafts-only honesty
      'broad authority over your workspace',                  // MCP token custody
      'repeat infringers lose their accounts'.toLowerCase(),  // DMCA (case-normalized below)
    ];
    const lower = terms.toLowerCase();
    for (const pin of pins) {
      assert.ok(terms.includes(pin) || lower.includes(pin.toLowerCase()), `terms missing pin: ${pin}`);
    }
  });

  check('A6 privacy: subprocessor list + controller/processor framing + no-sale statement', () => {
    for (const name of THIRD_PARTIES) {
      assert.ok(privacy.includes(name), `privacy page missing processor: ${name}`);
    }
    assert.ok(privacy.includes('We do not sell personal data'), 'no-sale section');
    assert.ok(privacy.includes('controller') && privacy.includes('processor'), 'GDPR framing');
    assert.ok(privacy.includes('bcrypt'), 'security facts: bcrypt');
    assert.ok(privacy.includes('call recordings, voicemail recordings, and machine-generated transcripts'), 'call data story');
    assert.ok(privacy.includes('24 hours'), 'reviews cache retention');
    assert.ok(privacy.includes('90 days'), 'analytics retention');
  });

  check('A7 census: exactly one first-party domain literal in shipped code (Batch 56 pin)', () => {
    const walk = (dir, out = []) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) { if (ent.name !== 'node_modules') walk(p, out); }
        else if (/\.(js|html)$/.test(ent.name)) out.push(p);
      }
      return out;
    };
    let total = 0;
    const files = [];
    for (const tree of ['src', 'server', 'public']) {
      for (const file of walk(path.join(root, tree))) {
        const m = fs.readFileSync(file, 'utf8').match(/bitpype\.com/g);
        if (m) { total += m.length; files.push(path.relative(root, file)); }
      }
    }
    assert.equal(total, 1, `expected exactly 1 literal, found ${total} in ${files.join(', ')}`);
    assert.deepEqual(files, [path.join('server', 'platform.js')]);
  });
}

/* ---------------- B. Site-level generator fixtures ---------------- */

const BIZ_A = {
  businessName: 'Bare Bones Bakery', category: 'Bakery', phone: '(610) 555-0111',
  email: 'hello@barebones.example', city: 'Blandon', state: 'PA',
  address: '1 Main St', postalCode: '19510', country: 'US',
};
const BIZ_B = {
  businessName: 'Loaded Logistics LLC', category: 'Mover', phone: '(610) 555-0122',
  email: 'crew@loaded.example', city: 'Reading', state: 'PA',
  address: '22 Dock Rd', postalCode: '19601', country: 'US',
};
const BIZ_C = {
  businessName: 'Chatty Realty Group', category: 'Real estate', phone: '(610) 555-0133',
  email: 'hi@chatty.example', city: 'Wyomissing', state: 'PA',
  address: '9 Penn Ave', postalCode: '19610', country: 'US',
};

function fixturePages(extraSections = []) {
  return [
    {
      slug: '/', title: 'Home', description: 'Fixture home page with enough words to be a real page.',
      sections: [
        { type: 'nav', content: {} },
        { type: 'html', content: { html: '<h1>Welcome</h1><p>A fixture business home page for the legal generator tests, with ordinary content.</p>' } },
        ...extraSections,
        { type: 'footer', content: { business_name: 'Fixture' } },
      ],
    },
    {
      slug: 'about', title: 'About', description: 'About the fixture business.',
      sections: [
        { type: 'nav', content: {} },
        { type: 'html', content: { html: '<h1>About us</h1><p>Ordinary about content for the fixture business.</p>' } },
        { type: 'footer', content: { business_name: 'Fixture' } },
      ],
    },
  ];
}

function exportFixture(pages, seo) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp60-site-'));
  engine.writeStaticPages(pages, {}, dir, { seo });
  const read = (rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
  return { dir, read };
}

const PIN = {
  forms: 'form submissions are delivered to the business',
  recording: 'Calls to the phone number shown on this site may be recorded and transcribed',
  shop: 'Your contract of sale is with the business, not with the website platform',
  shopRefunds: "Refunds and returns are handled under the business's own policy",
  bookings: 'A booking request is not a confirmed appointment',
  chatbot: 'Some replies in the chat may be generated by AI',
  reviews: 'Reviews shown on this site are from Google',
  estimate: 'submitting an estimate request does not create a contract',
  members: "membership payments are processed by the business's own Stripe account",
  privacyForms: "what you send is stored in the business's contact system",
  privacyCalls: 'Calls are recorded using our phone service provider (Twilio)',
  privacyCard: 'Card payments are processed by Stripe',
  privacyChat: 'chat messages are stored so the business can read and follow up',
  privacyBare: 'does not run forms, bookings, accounts, or a shop',
};

function siteChecks() {
  // Site A — no optional modules, no forms.
  const a = exportFixture(fixturePages(), {
    baseUrl: 'https://barebones.example', business: BIZ_A, legalModules: [],
    legalAnalytics: { internal: false, googleIds: [] }, moduleFaqItems: [],
  });
  check('B1 bare site: terms+privacy exported, sitemap lists them, footer links on pages', () => {
    const terms = a.read('terms.html');
    const privacy = a.read('privacy.html');
    assert.ok(terms.includes('Bare Bones Bakery'), 'business name renders');
    assert.ok(terms.includes('hello@barebones.example'), 'business email renders');
    assert.ok(privacy.includes('Bare Bones Bakery'));
    const sm = a.read('sitemap.xml');
    assert.ok(sm.includes('<loc>https://barebones.example/terms</loc>'), 'sitemap /terms');
    assert.ok(sm.includes('<loc>https://barebones.example/privacy</loc>'), 'sitemap /privacy');
    const home = a.read('index.html');
    assert.ok(home.includes(siteLegal.LINKS_MARKER), 'footer legal-links marker injected');
    assert.ok(home.includes('href="/terms"') && home.includes('href="/privacy"'), 'footer links point at canonical paths');
    const about = a.read('about.html');
    assert.ok(about.includes(siteLegal.LINKS_MARKER), 'links injected on every page');
  });

  check('B2 bare site: NO module clauses anywhere', () => {
    const terms = a.read('terms.html');
    const privacy = a.read('privacy.html');
    for (const pin of [PIN.forms, PIN.recording, PIN.shop, PIN.bookings, PIN.chatbot, PIN.reviews, PIN.estimate, PIN.members]) {
      assert.ok(!terms.includes(pin), `bare terms must not include: ${pin}`);
    }
    for (const pin of [PIN.privacyForms, PIN.privacyCalls, PIN.privacyCard, PIN.privacyChat]) {
      assert.ok(!privacy.includes(pin), `bare privacy must not include: ${pin}`);
    }
    assert.ok(privacy.includes(PIN.privacyBare), 'bare privacy states the informational-site truth');
  });

  // Site B — calltracking + ecommerce + a contact form section.
  const b = exportFixture(fixturePages([{ type: 'contact_form', content: {} }]), {
    baseUrl: 'https://loaded.example', business: BIZ_B,
    legalModules: ['calltracking', 'ecommerce'],
    legalAnalytics: { internal: true, googleIds: [] }, moduleFaqItems: [],
  });
  check('B3 loaded site: exactly the attached-module clauses (call tracking, shop, forms)', () => {
    const terms = b.read('terms.html');
    assert.ok(terms.includes('Loaded Logistics LLC'));
    assert.ok(terms.includes(PIN.recording), 'call recording clause');
    assert.ok(terms.includes(PIN.shop), 'shop clause');
    assert.ok(terms.includes(PIN.shopRefunds), 'neutral refund phrasing, no invented policy');
    assert.ok(terms.includes(PIN.forms), 'forms clause (contact_form section detected)');
    assert.ok(!terms.includes(PIN.chatbot) && !terms.includes(PIN.reviews) && !terms.includes(PIN.bookings),
      'unattached modules stay out');
    const privacy = b.read('privacy.html');
    assert.ok(privacy.includes(PIN.privacyCalls), 'privacy call story names Twilio');
    assert.ok(privacy.includes(PIN.privacyCard), 'privacy card story names Stripe');
    assert.ok(privacy.includes(PIN.privacyForms), 'privacy form story');
    assert.ok(privacy.includes('daily totals by page'), 'internal analytics disclosed when enabled');
    assert.ok(!privacy.includes(PIN.privacyChat), 'no chat story without the module');
    assert.ok(!privacy.includes(PIN.privacyBare), 'loaded privacy is not the bare text');
  });

  // Site C — chatbot + googlereviews + bookings: a DIFFERENT clause set.
  const c = exportFixture(fixturePages(), {
    baseUrl: 'https://chatty.example', business: BIZ_C,
    legalModules: ['chatbot', 'googlereviews', 'bookings'],
    legalAnalytics: { internal: false, googleIds: ['G-FIXTURE123'] }, moduleFaqItems: [],
  });
  check('B4 different modules → different clause set (data-driven, not one static text)', () => {
    const termsC = c.read('terms.html');
    assert.ok(termsC.includes(PIN.chatbot) && termsC.includes(PIN.reviews) && termsC.includes(PIN.bookings));
    assert.ok(!termsC.includes(PIN.recording) && !termsC.includes(PIN.shop));
    assert.notEqual(termsC, b.read('terms.html'), 'clause sets differ between sites');
    const privacyC = c.read('privacy.html');
    assert.ok(privacyC.includes(PIN.privacyChat), 'chat story present');
    assert.ok(privacyC.includes('Google Analytics'), 'owner GA tag disclosed');
    assert.ok(!privacyC.includes('daily totals by page'), 'internal analytics not claimed when off');
  });

  // Site D — owner-authored terms page wins; privacy still generated.
  const pagesD = fixturePages();
  pagesD.push({
    slug: 'terms', title: 'Our Own Terms', navVisible: false,
    sections: [{ type: 'html', content: { html: '<h1>Owner Terms</h1><p>The owner wrote these terms personally.</p>' } }],
  });
  const d = exportFixture(pagesD, {
    baseUrl: 'https://barebones.example', business: BIZ_A, legalModules: ['calltracking'],
    legalAnalytics: { internal: false, googleIds: [] }, moduleFaqItems: [],
  });
  check('B5 owner-authored terms page is preserved verbatim; generated privacy still ships', () => {
    const terms = d.read('terms.html');
    assert.ok(terms.includes('Owner Terms'), 'owner page exported');
    assert.ok(!terms.includes('class="bp-legal"'), 'generated terms did NOT overwrite the owner page');
    const privacy = d.read('privacy.html');
    assert.ok(privacy.includes('class="bp-legal"'), 'generated privacy still produced');
    assert.ok(privacy.includes(PIN.privacyCalls), 'module clauses still apply to generated page');
  });

  check('B6 injectLegalLinks is idempotent and skips pages already linking both pages', () => {
    const once = siteLegal.injectLegalLinks('<html><body><footer>x</footer></body></html>', { urlFor: engine.pageUrlPath });
    const twice = siteLegal.injectLegalLinks(once, { urlFor: engine.pageUrlPath });
    assert.equal(once, twice, 'second injection is a no-op');
    assert.equal((once.match(/bitpype-legal-links/g) || []).length, 1, 'marker appears once (nav form)');
    const already = '<html><body><footer><a href="/terms">T</a> <a href="/privacy">P</a></footer></body></html>';
    assert.equal(siteLegal.injectLegalLinks(already, { urlFor: engine.pageUrlPath }), already, 'existing links respected');
  });
}

/* ---------------- C. DB-driven wiring + QA ---------------- */

function makeDb() {
  const db = new Database(':memory:');
  db.exec(fs.readFileSync(path.join(root, 'src/schema.sql'), 'utf8'));
  engine.ensureTables(db);
  try { require(path.join(root, 'src/cfDomains.js')).ensureTables(db); } catch { /* migration optional */ }
  try { require(path.join(root, 'server/siteModules.js')).ensureTables(db); } catch { /* optional */ }
  try { require(path.join(root, 'server/siteAnalytics.js')).ensureTables(db); } catch { /* optional */ }
  return db;
}

async function dbChecks() {
  const db = makeDb();
  db.prepare(
    `INSERT INTO leads (id, business_name, category, phone, email, city, state, address, postal_code, country)
     VALUES (7701, 'Wired Widgets Inc', 'Widgets', '(610) 555-0177', 'team@wired.example', 'Reading', 'PA', '5 Circuit Way', '19601', 'US')`
  ).run();
  const pages = fixturePages();
  db.prepare(
    `INSERT INTO websites (id, lead_id, name, industry, theme, pages, status, preview_url, custom_domain, updated_at)
     VALUES (7701, 7701, 'Wired Widgets Inc', 'widgets', '{}', ?, 'draft', 'https://wired.example', NULL, '2026-10-01 00:00:00')`
  ).run(JSON.stringify(pages));
  const embed = db.prepare(
    `INSERT INTO site_module_embeds (lead_id, module_type, title, public_token, published) VALUES (7701, ?, '', ?, ?)`
  );
  embed.run('calltracking', 'tok-ct', 1);
  embed.run('ecommerce', 'tok-shop', 1);
  embed.run('chatbot', 'tok-chat', 0); // unpublished — must NOT produce clauses
  try {
    db.prepare(`INSERT INTO site_analytics_settings (website_id, token, internal_enabled, google_ids) VALUES (7701, 'tok-an', 1, '[]')`).run();
  } catch { /* analytics table optional in this schema build */ }

  await acheck('C1 buildSeoExportContext: legalModules = published embeds only; analytics state flows', async () => {
    const ctx = engine.buildSeoExportContext(db, 7701);
    assert.deepEqual([...(ctx.legalModules || [])].sort(), ['calltracking', 'ecommerce']);
    assert.equal(ctx.siteName, 'Wired Widgets Inc');
    if (ctx.legalAnalytics) assert.equal(typeof ctx.legalAnalytics.internal, 'boolean');
  });

  await acheck('C2 DB-driven export: clauses follow the embeds; unpublished module excluded', async () => {
    const ctx = engine.buildSeoExportContext(db, 7701);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp60-db-'));
    engine.writeStaticPages(pages, {}, dir, { seo: ctx });
    const terms = fs.readFileSync(path.join(dir, 'terms.html'), 'utf8');
    assert.ok(terms.includes('Wired Widgets Inc'));
    assert.ok(terms.includes(PIN.recording) && terms.includes(PIN.shop));
    assert.ok(!terms.includes(PIN.chatbot), 'unpublished chatbot embed produces no clause');
  });

  await acheck('C3 qaSite foundations: no missing terms.html / privacy.html failures', async () => {
    const qa = await engine.qaSite(db, 7701);
    const blob = JSON.stringify(qa.checks || []);
    assert.ok(!blob.includes('missing terms.html'), `QA must not report missing terms.html: ${blob.slice(0, 400)}`);
    assert.ok(!blob.includes('missing privacy.html'), `QA must not report missing privacy.html: ${blob.slice(0, 400)}`);
  });
}

/* ---------------- D. Domain renewals policy (Batch 60 addition) ----------------
 * Mode derivation (subscribed owner → 'auto' + registrar auto_renew
 * ON; otherwise 'manual' + OFF + admin marker), the
 * customer.subscription.deleted flip, reconciliation idempotency,
 * the manual-renew admin action guard, and the Terms renewal-policy
 * phrases. The registrar client is FULLY MOCKED — zero live calls. */

function renewalDb(domain, extra = {}) {
  const db = makeDb();
  db.prepare(
    `INSERT INTO leads (id, business_name, email) VALUES (8801, 'Renewal Fixture Co', 'owner@fixture.example')`
  ).run();
  db.prepare(
    `INSERT INTO websites (id, lead_id, name, industry, theme, pages, status, updated_at)
     VALUES (8801, 8801, 'Renewal Fixture Co', 'widgets', '{}', '[]', 'live', '2026-10-01 00:00:00')`
  ).run();
  db.prepare(
    `INSERT INTO site_domains (website_id, lead_id, domain_name, status, source, renewal_mode, renewal_auto_renew, expires_at, manual_renew_requested_at, manual_renew_from_expiry)
     VALUES (8801, 8801, ?, 'linked', 'registrar', ?, ?, ?, ?, ?)`
  ).run(
    domain,
    extra.mode ?? null,
    extra.autoRenew == null ? null : extra.autoRenew ? 1 : 0,
    extra.expiresAt ?? null,
    extra.requestedAt ?? null,
    extra.fromExpiry ?? null
  );
  return db;
}

function cfMocks(registrar, calls) {
  return {
    listRegistrations: async () => ({ domains: registrar, source: 'registrations' }),
    setRegistrationAutoRenew: async (db, domain, val) => {
      calls.push({ domain, val });
      const reg = registrar.find((r) => r.domain === domain);
      if (reg) reg.autoRenew = val;
      return { domain, autoRenew: val, state: 'succeeded', pending: false };
    },
  };
}

async function renewalChecks() {
  const renewals = require(path.join(root, 'server/domainRenewals.js'));
  const billing = require(path.join(root, 'server/billing.js'));
  const cfDomains = require(path.join(root, 'src/cfDomains.js'));
  await require(path.join(root, 'server/db.js')).migrate();

  // D1 — subscribed owner: mode 'auto', registrar drift patched ON.
  const calls1 = [];
  const registrar1 = [{ domain: 'auto-one.example', status: 'active', expiresAt: '2027-05-01T00:00:00Z', autoRenew: false }];
  const db1 = renewalDb('auto-one.example');
  const r1 = await renewals.reconcileWorkspace(db1, 1, {
    ...cfMocks(registrar1, calls1),
    workspaceSubscribed: async () => true,
  });
  check('D1 mode matrix: active paid subscription → auto, auto_renew patched ON', () => {
    const d = r1.domains[0];
    assert.equal(d.mode, 'auto');
    assert.equal(d.subscribed, true);
    assert.equal(d.registrarAutoRenewBefore, false);
    assert.equal(d.registrarAutoRenewAfter, true);
    assert.equal(d.changed, true);
    assert.deepEqual(calls1, [{ domain: 'auto-one.example', val: true }]);
    const row = db1.prepare('SELECT * FROM site_domains WHERE domain_name = ?').get('auto-one.example');
    assert.equal(row.renewal_mode, 'auto');
    assert.equal(row.renewal_auto_renew, 1);
    assert.equal(row.expires_at, '2027-05-01T00:00:00Z');
  });

  // D2 — no subscription (Free/never): mode 'manual', patched OFF.
  const calls2 = [];
  const registrar2 = [{ domain: 'free-one.example', status: 'active', expiresAt: '2026-11-15T00:00:00Z', autoRenew: true }];
  const db2 = renewalDb('free-one.example');
  const r2 = await renewals.reconcileWorkspace(db2, 2, {
    ...cfMocks(registrar2, calls2),
    workspaceSubscribed: async () => false,
    // no domainBillingUserSubscribed dep: the default path runs against
    // a workspace with no domain_transactions table and safely says no.
  });
  check('D2 mode matrix: no active subscription → manual, auto_renew patched OFF', () => {
    const d = r2.domains[0];
    assert.equal(d.mode, 'manual');
    assert.equal(d.subscribed, false);
    assert.deepEqual(calls2, [{ domain: 'free-one.example', val: false }]);
    const row = db2.prepare('SELECT * FROM site_domains WHERE domain_name = ?').get('free-one.example');
    assert.equal(row.renewal_mode, 'manual');
    assert.equal(row.renewal_auto_renew, 0);
  });

  // D3 — subscription-state semantics at the billing source: a cancel
  // scheduled for period end leaves status 'active' until the period
  // actually ends, so renewal stays 'auto' for the whole paid period.
  check('D3 billing.isSubscribed: in-period states stay subscribed; ended states do not', () => {
    assert.equal(billing.isSubscribed({ subscription_status: 'active' }), true, 'active (incl. cancel-at-period-end pending)');
    assert.equal(billing.isSubscribed({ subscription_status: 'trialing' }), true);
    assert.equal(billing.isSubscribed({ subscription_status: 'past_due' }), true, 'past_due grace');
    assert.equal(billing.isSubscribed({ subscription_status: 'canceled' }), false, 'ended');
    assert.equal(billing.isSubscribed({}), false, 'never subscribed');
    assert.equal(billing.isSubscribed({ subscription_status: 'active', status: 'disabled' }), false, 'disabled account');
    assert.equal(billing.isSubscribed({ is_super_admin: 1 }), true, 'platform owner');
  });

  // D4 — lifecycle flip: customer.subscription.deleted reconciles the
  // user's workspaces and flips the domain to manual + auto_renew OFF.
  const calls4 = [];
  const registrar4 = [{ domain: 'flip.example', status: 'active', expiresAt: '2027-02-01T00:00:00Z', autoRenew: true }];
  const db4 = renewalDb('flip.example', { mode: 'auto', autoRenew: true, expiresAt: '2027-02-01T00:00:00Z' });
  const sub4 = { id: 'sub_flip', customer: 'cus_flip', metadata: { user_id: '42' }, status: 'canceled' };
  const deps4 = {
    ...cfMocks(registrar4, calls4),
    getUserBilling: async (id) => ({ id, stripe_subscription_id: 'sub_flip', subscription_status: 'canceled' }),
    listUserWorkspaceIds: async () => [4],
    openDb: () => db4,
    workspaceSubscribed: async () => false, // post-deletion truth
  };
  const r4 = await renewals.reconcileForSubscriptionEvent(sub4, 'customer.subscription.deleted', deps4);
  check('D4 subscription.deleted flips the domain to manual + auto_renew OFF', () => {
    assert.equal(r4.domains.length, 1);
    assert.equal(r4.domains[0].mode, 'manual');
    assert.deepEqual(calls4, [{ domain: 'flip.example', val: false }]);
    const row = db4.prepare('SELECT * FROM site_domains WHERE domain_name = ?').get('flip.example');
    assert.equal(row.renewal_mode, 'manual');
    assert.equal(row.renewal_auto_renew, 0);
  });

  // D4b — orphan guard: a deleted sub the user no longer tracks, while
  // another subscription is active, changes nothing.
  const calls4b = [];
  const r4b = await renewals.reconcileForSubscriptionEvent(sub4, 'customer.subscription.deleted', {
    ...deps4,
    ...cfMocks(registrar4, calls4b),
    getUserBilling: async (id) => ({ id, stripe_subscription_id: 'sub_other', subscription_status: 'active' }),
  });
  check('D4b orphan guard: stale deleted sub does not flip a live subscriber', () => {
    assert.equal(r4b.skipped, 'other_subscription_tracked');
    assert.equal(calls4b.length, 0);
  });

  // D5 — idempotency: registrar already matches the desired state →
  // zero PATCH calls, changed=false, stored row values stable.
  const calls5 = [];
  const rowBefore = db1.prepare('SELECT renewal_mode, renewal_auto_renew, expires_at FROM site_domains WHERE domain_name = ?').get('auto-one.example');
  const r5 = await renewals.reconcileWorkspace(db1, 1, {
    ...cfMocks(registrar1, calls5), // registrar1 now reports autoRenew:true (D1 applied it)
    workspaceSubscribed: async () => true,
  });
  check('D5 reconcile idempotency: second pass changes nothing', () => {
    assert.equal(calls5.length, 0, 'no registrar writes on a clean second pass');
    assert.equal(r5.domains[0].changed, false);
    const rowAfter = db1.prepare('SELECT renewal_mode, renewal_auto_renew, expires_at FROM site_domains WHERE domain_name = ?').get('auto-one.example');
    assert.deepEqual(rowAfter, rowBefore);
  });

  // D6 — manual-renew action: guard + intent recording.
  let autoErr = null;
  try {
    await renewals.requestManualRenewal(db1, 1, 'auto-one.example', 7);
  } catch (e) {
    autoErr = e;
  }
  let missingErr = null;
  try {
    await renewals.requestManualRenewal(db2, 2, 'nope.example', 7);
  } catch (e) {
    missingErr = e;
  }
  const manualRes = await renewals.requestManualRenewal(db2, 2, 'free-one.example', 99);
  check('D6 manual-renew guard: only from manual mode; records intent + dashboard path', () => {
    assert.equal(autoErr && autoErr.code, 'NOT_MANUAL_MODE');
    assert.equal(autoErr && autoErr.status, 409);
    assert.equal(missingErr && missingErr.code, 'NOT_FOUND');
    assert.equal(manualRes.renewalMode, 'manual');
    assert.equal(manualRes.expiresAt, '2026-11-15T00:00:00Z');
    assert.ok(manualRes.instructions.includes('Renew/Extend Domain'), 'dashboard step named (API cannot renew)');
    if (manualRes.dashboardUrl) assert.ok(manualRes.dashboardUrl.includes('dash.cloudflare.com/'));
    const row = db2.prepare('SELECT * FROM site_domains WHERE domain_name = ?').get('free-one.example');
    assert.ok(row.manual_renew_requested_at, 'request timestamp recorded');
    assert.equal(row.manual_renew_requested_by, 99);
    assert.equal(row.manual_renew_from_expiry, '2026-11-15T00:00:00Z');
  });

  // D7 — admin surface: publicRow carries the marker fields; the UI
  // carries the exact badge phrase + action; routes exist behind the
  // super-admin router.
  check('D7 admin marker: listLinked row + UI badge phrase + super-admin routes', () => {
    const linked = cfDomains.listLinked(db2);
    const row = linked.find((d) => d.domain === 'free-one.example');
    assert.ok(row, 'fixture domain listed');
    assert.equal(row.renewalMode, 'manual');
    assert.equal(row.expiresAt, '2026-11-15T00:00:00Z');
    assert.equal(row.manualRenewRequestedAt != null, true);
    const appJs = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
    assert.ok(appJs.includes('Manual renewal only — owner not subscribed'), 'exact admin badge phrase');
    assert.ok(appJs.includes('dom-renew-manual'), 'renew-manually action wired');
    const apiJs = fs.readFileSync(path.join(root, 'public/js/api.js'), 'utf8');
    assert.ok(apiJs.includes('/admin/domains/renew-manual'), 'api helper targets the super-admin route');
    const adminJs = fs.readFileSync(path.join(root, 'server/routes/admin.js'), 'utf8');
    assert.ok(adminJs.includes("router.use(requireAuth, requireSuperAdmin)"), 'admin router is super-admin gated');
    assert.ok(adminJs.includes("router.post('/domains/renew-manual'"), 'renew-manual route present');
    assert.ok(adminJs.includes("router.post('/domains/reconcile'"), 'reconcile route present');
  });

  // D8 — Terms carry the renewal policy (served page + Ely's md draft).
  check('D8 terms: renewal policy phrases pinned (page; md draft when present)', () => {
    const terms = templated('legal/terms.html');
    assert.ok(terms.includes('renew automatically while your subscription is active'), 'subscribed → auto-renew');
    assert.ok(terms.includes('marked as manual-renewal-only'), 'unsubscribed → marked manual');
    assert.ok(
      terms.includes('BitPype is not liable for the loss of a domain that lapses because it was not renewed'),
      'lapse liability disclaimer'
    );
    const mdPath = path.resolve(root, '..', 'website-scout', 'legal', 'terms-of-service.md');
    if (fs.existsSync(mdPath)) {
      const md = fs.readFileSync(mdPath, 'utf8');
      assert.ok(md.includes('renew automatically while your subscription is active'), 'md: auto phrase');
      assert.ok(md.includes('marked as manual-renewal-only'), 'md: manual phrase');
    }
  });

  // D9 — wiring pins: billing webhook calls the reconcile (both
  // lifecycle branches) and server.js starts the sweep ticker.
  check('D9 wiring: webhook lifecycle hooks + sweep ticker present', () => {
    const billingSrc = fs.readFileSync(path.join(root, 'server/billing.js'), 'utf8');
    const hits = billingSrc.split('reconcileForSubscriptionEvent').length - 1;
    assert.ok(hits >= 2, `billing.js must call the renewal reconcile from both lifecycle branches (found ${hits})`);
    const serverSrc = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
    assert.ok(serverSrc.includes('startRenewalTicker'), 'server.js starts the renewal sweep ticker');
  });

  // D10 — reconcileAll across workspaces (deploy-sweep shape).
  const dbA = renewalDb('sweep-auto.example');
  const dbB = renewalDb('sweep-manual.example');
  const regA = [{ domain: 'sweep-auto.example', status: 'active', expiresAt: '2027-01-01T00:00:00Z', autoRenew: false }];
  const regB = [{ domain: 'sweep-manual.example', status: 'active', expiresAt: '2026-12-01T00:00:00Z', autoRenew: true }];
  const dbs = { 11: dbA, 12: dbB };
  const r10 = await renewals.reconcileAll({
    listWorkspaceIds: async () => [11, 12],
    openDb: (ws) => dbs[ws],
    listRegistrations: async (db) => ({ domains: db === dbA ? regA : regB, source: 'registrations' }),
    setRegistrationAutoRenew: async (db, domain, val) => ({ domain, autoRenew: val, state: 'succeeded', pending: false }),
    workspaceSubscribed: async (ws) => ws === 11,
  });
  check('D10 reconcileAll: per-workspace modes in one flattened report', () => {
    const byDomain = Object.fromEntries(r10.domains.map((d) => [d.domain, d]));
    assert.equal(byDomain['sweep-auto.example'].mode, 'auto');
    assert.equal(byDomain['sweep-auto.example'].workspaceId, 11);
    assert.equal(byDomain['sweep-manual.example'].mode, 'manual');
    assert.equal(byDomain['sweep-manual.example'].workspaceId, 12);
  });

  // D12 — registrar list page size stays within the API's cap (the
  // deploy-day reconcile found per_page=100 is a 400; max is 50).
  check('D12 registrar list uses per_page=50 (API cap)', () => {
    const src = fs.readFileSync(path.join(root, 'src/cfDomains.js'), 'utf8');
    assert.ok(src.includes("per_page: '50'"), 'listRegistrations must page at 50');
    assert.ok(!src.includes("per_page: '100'"), 'per_page 100 is rejected by the Registrar API');
  });

  // D11 — a requested manual renewal is observed complete when the
  // registrar expiry moves past the recorded pre-renewal expiry.
  const db11 = renewalDb('renewed.example', {
    mode: 'manual', autoRenew: false, expiresAt: '2026-03-01T00:00:00Z',
    requestedAt: '2026-10-29T00:00:00.000Z', fromExpiry: '2026-03-01T00:00:00Z',
  });
  const reg11 = [{ domain: 'renewed.example', status: 'active', expiresAt: '2027-03-01T00:00:00Z', autoRenew: false }];
  await renewals.reconcileWorkspace(db11, 13, {
    ...cfMocks(reg11, []),
    workspaceSubscribed: async () => false,
  });
  check('D11 manual renewal completion observed via expiry movement', () => {
    const row = db11.prepare('SELECT * FROM site_domains WHERE domain_name = ?').get('renewed.example');
    assert.equal(row.manual_renew_requested_at, null, 'request cleared once the renewal lands');
    assert.equal(row.expires_at, '2027-03-01T00:00:00Z');
    assert.equal(row.renewal_mode, 'manual', 'still manual — owner still unsubscribed');
  });
}

async function main() {
  platformChecks();
  siteChecks();
  await dbChecks();
  await renewalChecks();
  console.log(`batch60-legal-regressions: ${results.length} checks passed`);
  for (const r of results) console.log(`  ✓ ${r}`);
}

main().catch((e) => {
  console.error('batch60-legal-regressions FAILED:', e && e.stack ? e.stack : e);
  process.exit(1);
});
