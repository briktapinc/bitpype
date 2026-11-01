'use strict';
/**
 * Batch 97 — per-plan daily cap on portal design-chat requests
 * (Ely 2026-10-31: "limit chat requests per package to x per day,
 * add to admin").
 *
 * What shipped:
 *   - server/plans.js: every plan carries chatRequestsPerDay
 *     (Ely's defaults: Free 5, Standard 20, Pro 50, Premium 150),
 *     resolved through the Batch 57 contents overrides — an admin
 *     override wins wholesale, an explicit null means unlimited.
 *     plans.chatRequestsPerDayFor(planId) normalizes to a
 *     positive int or null.
 *   - server/planContents.js: chatRequestsPerDay is a validated
 *     contents field (whole number 1–100000, or null), editable
 *     in Admin → Settings → Billing → Package contents, and the
 *     editor (public/js/app.js) round-trips it (blank = unlimited).
 *   - server/siteChatUsage.js: per-site (lead) per-day counting.
 *     Day boundary is site-local where the site has a timezone
 *     (bookings settings row, probed read-only), else UTC. A
 *     refused request is NOT counted and never enters the
 *     pipeline; an allowed request is counted as it enters.
 *   - clientPortal.gateSiteChatRequest: owner-tier sessions only
 *     (owner + partner — a partner draws on the client's site
 *     pool); staff/admin never use the portal; renters pass
 *     through untouched. The portal route checks the gate BEFORE
 *     runSiteAgentChat (no model call on a refusal), answers a
 *     refusal with mode 'limit' + an honest reply, and carries
 *     chatUsage {used, limit} on chat + history responses so the
 *     portal chrome can show "N of M chat requests today".
 *
 * NEGATIVE PROOF: B97_NEGATIVE=cap shims the refusal branch out
 * of siteChatUsage.checkAndRecord (the cap never refuses — the
 * pre-batch behaviour) → Part 3's refusal assertions go RED.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b97-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch97', 'test', 'session', 'secret'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY =
  process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 23).toString('base64');

const NEGATIVE = process.env.B97_NEGATIVE || '';
const groups = [];
function group(name, n) {
  groups.push(`${name} (${n})`);
  console.log(`  ok ${name} — ${n} checks`);
}

// The usage module, optionally shimmed for the negative proof:
// B97_NEGATIVE=cap removes the refusal so the cap never bites.
function loadUsageModule() {
  let src = fs.readFileSync(path.join(root, 'server', 'siteChatUsage.js'), 'utf8');
  if (NEGATIVE === 'cap') {
    const shimmed = src.replace(
      '  if (used >= limit) return { allowed: false, used, limit, timezone, day };',
      '  // B97 NEGATIVE SHIM — cap never refuses'
    );
    assert.notEqual(shimmed, src, 'cap shim must change the usage source');
    src = shimmed;
  }
  const m = { exports: {} };
  vm.runInNewContext(src + ';module.exports = module.exports;', {
    module: m,
    exports: m.exports,
    console,
    Buffer,
    process,
  });
  return m.exports;
}

(async () => {
  const plans = require(path.join(root, 'server', 'plans.js'));
  const planContents = require(path.join(root, 'server', 'planContents.js'));
  const usage = loadUsageModule();
  await require(path.join(root, 'server', 'db.js')).migrate();
  const domain = require(path.join(root, 'server', 'domain.js'));
  const siteModules = require(path.join(root, 'server', 'siteModules.js'));
  const realDb = domain.withDb(1, (db) => db);
  siteModules.ensureTables(realDb);
  const seedLead = (label) =>
    Number(
      realDb
        .prepare('INSERT INTO leads (business_name, category, phone) VALUES (?, ?, ?)')
        .run(`ZZ B97 ${label}`, 'Bakery', '(610) 555-0197').lastInsertRowid
    );

  // ---------------------------------------------------------------
  // Part 1 — Ely's defaults ride the catalog; resolver normalizes.
  // ---------------------------------------------------------------
  {
    let n = 0;
    assert.equal(plans.chatRequestsPerDayFor('free'), 5, 'Free = 5/day');
    assert.equal(plans.chatRequestsPerDayFor('standard'), 20, 'Standard = 20/day');
    assert.equal(plans.chatRequestsPerDayFor('pro'), 50, 'Pro = 50/day');
    assert.equal(plans.chatRequestsPerDayFor('premium'), 150, 'Premium = 150/day');
    assert.equal(plans.chatRequestsPerDayFor('nonsense'), 5, 'unknown plan resolves as Free');
    assert.equal(plans.getPlan('standard').chatRequestsPerDay, 20, 'getPlan carries the field');
    n += 6;
    group('Part 1 plan defaults: 5 / 20 / 50 / 150', n);
  }

  // ---------------------------------------------------------------
  // Part 2 — the cap is a Batch 57 contents field: validated,
  // overridable per plan, explicit null = unlimited, and the
  // admin save path (updatePlanContents) drives the resolver.
  // ---------------------------------------------------------------
  {
    let n = 0;
    assert.ok(planContents.CONTENT_FIELDS.includes('chatRequestsPerDay'), 'field is editable contents');
    assert.deepEqual(planContents.validatePlanContents('standard', { chatRequestsPerDay: 2 }), {
      chatRequestsPerDay: 2,
    });
    assert.deepEqual(planContents.validatePlanContents('standard', { chatRequestsPerDay: null }), {
      chatRequestsPerDay: null,
    });
    n += 3;
    for (const bad of [0, -3, 2.5, '20', true, 100001]) {
      let threw = null;
      try {
        planContents.validatePlanContents('standard', { chatRequestsPerDay: bad });
      } catch (e) {
        threw = e;
      }
      assert.ok(threw && threw.code === 'VALIDATION', `rejects ${JSON.stringify(bad)}`);
      n += 1;
    }
    // Resolver-level override (what setContentsCacheForKey applies):
    plans.setContentsOverrides({ standard: { chatRequestsPerDay: 2 } });
    assert.equal(plans.chatRequestsPerDayFor('standard'), 2, 'override wins over the default');
    plans.setContentsOverrides({ standard: { chatRequestsPerDay: null } });
    assert.equal(plans.chatRequestsPerDayFor('standard'), null, 'explicit null = unlimited');
    plans.setContentsOverrides({});
    assert.equal(plans.chatRequestsPerDayFor('standard'), 20, 'clearing overrides restores the default');
    n += 3;
    // The real admin save path, end to end:
    const res = await planContents.updatePlanContents({ standard: { chatRequestsPerDay: 3 } });
    assert.deepEqual(res.updated, ['standard']);
    assert.equal(plans.chatRequestsPerDayFor('standard'), 3, 'saved cap drives the resolver immediately');
    const st = await planContents.getPlanContentsState();
    const std = st.plans.find((p) => p.id === 'standard');
    assert.equal(std.contents.chatRequestsPerDay, 3, 'editor state shows the saved cap');
    assert.equal(std.defaults.chatRequestsPerDay, 20, 'editor state still shows the built-in default');
    const free = st.plans.find((p) => p.id === 'free');
    assert.deepEqual(free.contents, free.defaults, 'untouched plans: contents == defaults (editor reset math)');
    n += 5;
    const res2 = await planContents.updatePlanContents({ standard: null });
    assert.deepEqual(res2.reset, ['standard']);
    assert.equal(plans.chatRequestsPerDayFor('standard'), 20, 'reset restores the default cap');
    n += 2;
    group('Part 2 contents field: validated, overridable, admin save path', n);
  }

  // ---------------------------------------------------------------
  // Part 3 — counting: day boundaries (site tz else UTC), the
  // refusal core, per-site pools, day rollover. (Usage module is
  // shimmed under B97_NEGATIVE=cap → refusal checks go RED.)
  // ---------------------------------------------------------------
  {
    let n = 0;
    const oct31 = Date.UTC(2026, 9, 31, 2, 30); // 02:30 UTC = Oct 30, 22:30 in New York (EDT)
    assert.equal(usage.dayKey(null, oct31), '2026-10-31', 'no timezone → UTC day');
    assert.equal(usage.dayKey('UTC', oct31), '2026-10-31');
    assert.equal(usage.dayKey('America/New_York', oct31), '2026-10-30', 'site-local day boundary (EDT)');
    const jan15 = Date.UTC(2026, 0, 15, 4, 30); // 04:30 UTC = Jan 14, 23:30 in New York (EST)
    assert.equal(usage.dayKey('America/New_York', jan15), '2026-01-14', 'site-local day boundary (EST)');
    assert.equal(usage.dayKey('Mars/Olympus_Mons', oct31), '2026-10-31', 'unusable timezone falls back to UTC');
    n += 5;

    const leadA = seedLead('CAP-A');
    const leadB = seedLead('CAP-B');
    // Timezone probe: no booking row → null; a configured row wins;
    // the probe itself creates nothing.
    assert.equal(usage.siteTimezone(realDb, leadA), null, 'no bookings row → no site timezone');
    const bsCount = () =>
      realDb.prepare('SELECT COUNT(*) AS c FROM booking_settings WHERE lead_id = ?').get(leadA).c;
    assert.equal(bsCount(), 0, 'probe created no booking_settings row');
    realDb
      .prepare('INSERT INTO booking_settings (lead_id, timezone) VALUES (?, ?)')
      .run(leadA, 'America/New_York');
    assert.equal(usage.siteTimezone(realDb, leadA), 'America/New_York', 'configured timezone is the site timezone');
    n += 3;

    // The gate core at a tiny cap (the live-proof shape).
    const now = Date.UTC(2026, 9, 31, 15, 0); // Oct 31, 11:00 in New York
    const g1 = usage.checkAndRecord(realDb, { leadId: leadA, limit: 2, nowMs: now });
    assert.deepEqual([g1.allowed, g1.used, g1.day], [true, 1, '2026-10-31'], 'first request counted, site-local day');
    const g2 = usage.checkAndRecord(realDb, { leadId: leadA, limit: 2, nowMs: now });
    assert.deepEqual([g2.allowed, g2.used], [true, 2], 'second request reaches the cap');
    const g3 = usage.checkAndRecord(realDb, { leadId: leadA, limit: 2, nowMs: now });
    assert.equal(g3.allowed, false, 'third request refused at the cap');
    assert.equal(g3.used, 2, 'refusal reports the count honestly');
    assert.equal(usage.getDailyCount(realDb, leadA, '2026-10-31'), 2, 'a refused request is NOT counted');
    n += 5;
    const gB = usage.checkAndRecord(realDb, { leadId: leadB, limit: 2, nowMs: now });
    assert.deepEqual([gB.allowed, gB.used, gB.day], [true, 1, '2026-10-31'], "site B's pool is its own (UTC day — no timezone)");
    n += 1;
    const tomorrow = Date.UTC(2026, 10, 1, 15, 0); // Nov 1, 10:00 EST in New York
    const gNext = usage.checkAndRecord(realDb, { leadId: leadA, limit: 2, nowMs: tomorrow });
    assert.deepEqual([gNext.allowed, gNext.used, gNext.day], [true, 1, '2026-11-01'], 'a new site-local day resets the pool');
    n += 1;
    const gFree = usage.checkAndRecord(realDb, { leadId: leadB, limit: null, nowMs: now });
    assert.equal(gFree.allowed, true, 'unlimited plan always allowed');
    assert.equal(gFree.used, null, 'unlimited plan reports no count');
    assert.equal(usage.getDailyCount(realDb, leadB, '2026-10-31'), 1, 'unlimited turns are not counted (only the earlier capped turn is)');
    n += 3;
    group('Part 3 counting: tz days, cap refusal, per-site pools, rollover', n);
  }

  // ---------------------------------------------------------------
  // Part 4 — gate surface: exemption, refusal text, and the
  // wiring pins across route / portal chrome / admin editor.
  // ---------------------------------------------------------------
  {
    let n = 0;
    const portal = require(path.join(root, 'server', 'clientPortal.js'));
    const renter = await portal.gateSiteChatRequest(1, 424242, { userType: 'renter' });
    assert.equal(renter.allowed, true, 'renter passes through (no builder chat to cap)');
    assert.equal(renter.exempt, true, 'non-owner-tier is exempt from the gate');
    n += 2;
    const text = portal.chatLimitReplyText({ limit: 20, used: 20, planName: 'Standard', timezone: null });
    assert.ok(text.includes('20 of 20'), 'refusal states the count');
    assert.ok(text.includes('Standard'), 'refusal names the plan');
    assert.ok(text.includes('resets at midnight (UTC)'), 'refusal states the reset (UTC site)');
    assert.ok(text.includes('Nothing was changed'), 'refusal is honest that nothing happened');
    const textTz = portal.chatLimitReplyText({ limit: 5, used: 5, planName: 'Free', timezone: 'America/New_York' });
    assert.ok(textTz.includes('resets at midnight (America/New_York)'), 'refusal names the site timezone when it has one');
    n += 5;

    const routeSrc = fs.readFileSync(path.join(root, 'server', 'routes', 'portal.js'), 'utf8');
    assert.ok(routeSrc.includes('gateSiteChatRequest'), 'route checks the gate');
    assert.ok(routeSrc.includes("mode: 'limit'"), 'route answers refusals with mode limit');
    assert.ok(routeSrc.indexOf('gateSiteChatRequest') < routeSrc.indexOf('runSiteAgentChat(req.client'), 'gate runs BEFORE the pipeline');
    assert.ok(routeSrc.includes('getSiteChatUsage'), 'history carries the usage for the chrome');
    n += 4;
    const portalSrc = require('./lib/monolithSource.cjs').clientPortalSource();
    assert.ok(portalSrc.includes('chatRequestsPerDayFor'), 'gate resolves the cap from the plan');
    assert.ok(portalSrc.includes('workspacePlan'), 'gate resolves the workspace plan');
    assert.ok(portalSrc.includes('isOwnerTier'), 'gate scopes to owner-tier sessions');
    n += 3;
    const portalJs = fs.readFileSync(path.join(root, 'public', 'js', 'portal.js'), 'utf8');
    assert.ok(portalJs.includes('renderAgentChatUsage'), 'portal renders the usage line');
    assert.ok(portalJs.includes('chat requests today'), 'usage line text is the spec shape');
    const portalHtml = fs.readFileSync(path.join(root, 'public', 'portal.html'), 'utf8');
    assert.ok(portalHtml.includes('id="agent-chat-usage"'), 'chat chrome carries the usage element');
    const appJs = fs.readFileSync(path.join(root, 'public', 'js', 'app.js'), 'utf8');
    assert.ok(appJs.includes('Design chat requests per day'), 'admin editor labels the field');
    assert.ok(appJs.includes('data-field="chatRequestsPerDay"'), 'admin editor round-trips the field');
    n += 5;
    group('Part 4 gate surface: exemption, refusal text, wiring pins', n);
  }

  console.log(JSON.stringify({ passed: true, groups, negative: NEGATIVE || null }));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
