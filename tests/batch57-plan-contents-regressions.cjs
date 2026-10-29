'use strict';
/**
 * Batch 57 — admin-editable package (plan) CONTENTS.
 *
 * Ely (2026-10-29): amounts were editable in Admin → Settings → Billing
 * (Plan pricing, Batch 24) but contents were a static catalog —
 * "Can I edit package contents" → "I want that feature."
 *
 * What shipped:
 *   - Storage: plans.contents_<plan> platform settings (one JSON row
 *     per plan, group 'billing', default ''). Absent/empty = the code
 *     catalog in server/plans.js.
 *   - Validation owned by server/planContents.validatePlanContents and
 *     enforced at BOTH write choke points (platform.setPlatformSetting
 *     canonicalizes; settingsKeys.validateSetting delegates — the
 *     Batch 24b invariant, pinned by production-regressions' meta check
 *     and re-pinned below).
 *   - Resolution is central in plans.js (getPlan / listPlans /
 *     publicPlan) over a cache primed at boot
 *     (planContents.refreshPlanContents, server.js) and refreshed on
 *     every save via platform.setPlatformSetting — the Batch 56
 *     pattern. Merge is per-field with WHOLESALE replacement of
 *     features / entitlements when present.
 *   - Admin API GET/PUT /admin/settings/plans-contents (super-admin
 *     router, beside pricing) + audit 'platform.plans_contents';
 *     UI panel "Package contents" beside Plan pricing.
 *
 * Pins below: defaults byte-identical with no overrides; per-field
 * merge; wholesale entitlements; validator matrix (atomic reject —
 * nothing written); settingsKeys writability; catalog API reflects a
 * saved override; entitlement flip end-to-end; reset clears the row;
 * boot refresh path; pricing panel resolves renamed plans.
 *
 * NEGATIVE PROOF (run at build time): dropping the four
 * plans.contents_* keys from settingsKeys.SETTABLE_KEYS makes the
 * writability pin below (and production-regressions' batch24b meta)
 * fail — restored, green.
 *
 * Harness: temp sqlite platform DB (mfa-totp / batch48 pattern).
 * Run via tests/run-regressions.cjs (DB_DRIVER=sqlite).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DB_DRIVER = process.env.DB_DRIVER || 'sqlite';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b57-'));
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.SETTINGS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'b57-test-secret-0123456789abcdef0123456789abcdef';

const root = path.resolve(__dirname, '..');
const results = [];
function check(name, fn) {
  fn();
  results.push(name);
}
async function checkAsync(name, fn) {
  await fn();
  results.push(name);
}

const plans = require(path.join(root, 'server/plans.js'));
const planContents = require(path.join(root, 'server/planContents.js'));
const settingsKeys = require(path.join(root, 'server/settingsKeys.js'));
const platform = require(path.join(root, 'server/platform.js'));

/* ------------------------------------------------------------------ */
/* Defaults pass through unchanged (no overrides anywhere)             */
/* ------------------------------------------------------------------ */

check('defaults: listPlans byte-identical to the pre-batch catalog formula', () => {
  const expected = [plans.PLAN_FREE, plans.PLAN_STANDARD, plans.PLAN_PRO, plans.PLAN_PREMIUM].map((id) => ({
    ...plans.PLANS[id],
  }));
  assert.equal(JSON.stringify(plans.listPlans()), JSON.stringify(expected));
});

check('defaults: publicPlan output identical to the pre-batch formula for every plan', () => {
  for (const id of ['free', 'standard', 'pro', 'premium']) {
    const base = plans.PLANS[id];
    const expected = {
      id: base.id,
      name: base.name,
      tagline: base.tagline,
      priceLabel: base.priceLabel,
      interval: base.interval,
      features: base.features.slice(),
      entitlements: { ...base.entitlements },
    };
    assert.deepEqual(plans.publicPlan(id), expected);
    assert.deepEqual(plans.getPlan(id), base);
  }
});

/* ------------------------------------------------------------------ */
/* Merge semantics (pure resolver)                                     */
/* ------------------------------------------------------------------ */

check('merge: override wins per-field; untouched fields keep defaults', () => {
  try {
    plans.setContentsOverrides({ standard: { tagline: 'A new tagline' } });
    const p = plans.getPlan('standard');
    assert.equal(p.tagline, 'A new tagline');
    assert.equal(p.name, 'Standard');
    assert.deepEqual(p.features, plans.PLANS.standard.features);
    assert.deepEqual(p.entitlements, plans.PLANS.standard.entitlements);
    assert.equal(p.id, 'standard');
    assert.equal(p.interval, 'month');
    assert.equal(p.priceLabel, plans.PLANS.standard.priceLabel);
  } finally {
    plans.setContentsOverrides({});
  }
});

check('merge: features + entitlements replace WHOLESALE when present', () => {
  try {
    plans.setContentsOverrides({
      premium: { features: ['Only this'], entitlements: { formInbox: false } },
    });
    const p = plans.getPlan('premium');
    assert.deepEqual(p.features, ['Only this']);
    assert.deepEqual(p.entitlements, { formInbox: false });
    // Resolved objects are copies — mutating one cannot poison the catalog.
    p.features.push('mutant');
    p.entitlements.formInbox = true;
    assert.deepEqual(plans.getPlan('premium').features, ['Only this']);
    assert.equal(plans.getPlan('premium').entitlements.formInbox, false);
  } finally {
    plans.setContentsOverrides({});
  }
});

/* ------------------------------------------------------------------ */
/* Validator matrix (pure)                                             */
/* ------------------------------------------------------------------ */

check('validator: accepts valid shapes and canonicalizes', () => {
  const v = planContents.validatePlanContents('pro', {
    name: '  Pro Plus ',
    tagline: ' Tag ',
    features: [' One ', 'Two'],
    entitlements: { formInbox: false, supportCadence: 'weekly' },
  });
  assert.equal(v.name, 'Pro Plus');
  assert.equal(v.tagline, 'Tag');
  assert.deepEqual(v.features, ['One', 'Two']);
  assert.equal(v.entitlements.formInbox, false);
  assert.equal(v.entitlements.supportCadence, 'weekly');
  // Empty object is a valid (no-op) override; ''/null clear.
  assert.deepEqual(planContents.validatePlanContents('free', {}), {});
  assert.equal(planContents.validatePlanContents('free', ''), null);
  assert.equal(planContents.validatePlanContents('free', null), null);
  // JSON string input parses.
  assert.equal(planContents.validatePlanContents('free', '{"name":"F2"}').name, 'F2');
});

check('validator: rejects the full bad matrix with coded VALIDATION errors', () => {
  const bad = [
    ['unknown top-level field', { priceLabel: '$1' }],
    ['unknown top-level field 2', { rank: 9 }],
    ['empty name', { name: '   ' }],
    ['oversized name', { name: 'x'.repeat(61) }],
    ['non-string name', { name: 42 }],
    ['oversized tagline', { tagline: 'x'.repeat(141) }],
    ['features not a list', { features: 'nope' }],
    ['features empty', { features: [] }],
    ['features too many', { features: Array.from({ length: 21 }, (_, i) => 'f' + i) }],
    ['feature blank after trim', { features: ['ok', '   '] }],
    ['feature oversized', { features: ['x'.repeat(121)] }],
    ['feature non-string', { features: [7] }],
    ['entitlements not an object', { entitlements: [true] }],
    ['unknown entitlement key', { entitlements: { teleport: true } }],
    ['non-boolean entitlement', { entitlements: { formInbox: 'yes' } }],
    ['non-boolean entitlement 2', { entitlements: { formInbox: 1 } }],
    ['bad supportCadence', { entitlements: { supportCadence: 'daily' } }],
    ['non-string supportCadence', { entitlements: { supportCadence: true } }],
  ];
  for (const [label, value] of bad) {
    assert.throws(
      () => planContents.validatePlanContents('standard', value),
      (e) => e.code === 'VALIDATION',
      label
    );
  }
  assert.throws(() => planContents.validatePlanContents('gold', { name: 'X' }), /Unknown plan/);
  assert.throws(() => planContents.validatePlanContents('free', '{not json'), (e) => e.code === 'VALIDATION');
  assert.throws(() => planContents.validatePlanContents('free', '[1,2]'), (e) => e.code === 'VALIDATION');
});

check('validator: entitlement key set + cadences derive from the catalog', () => {
  const keys = planContents.allowedEntitlementKeys();
  for (const id of ['free', 'standard', 'pro', 'premium']) {
    for (const k of Object.keys(plans.PLANS[id].entitlements)) assert.ok(keys.has(k), k);
  }
  assert.deepEqual(planContents.supportCadenceValues(), ['none', 'monthly', 'weekly']);
});

/* ------------------------------------------------------------------ */
/* settingsKeys registration (Batch 24b invariant)                     */
/* ------------------------------------------------------------------ */

check('settingsKeys: all four contents keys are settable + validated there', () => {
  for (const id of ['free', 'standard', 'pro', 'premium']) {
    const key = `plans.contents_${id}`;
    assert.ok(settingsKeys.SETTABLE_KEYS.includes(key), key + ' in SETTABLE_KEYS');
    assert.deepEqual(settingsKeys.validateSetting(key, ''), { ok: true, value: '' });
    const good = settingsKeys.validateSetting(key, '{"name":"Renamed"}');
    assert.equal(good.ok, true, key + ' accepts a valid override: ' + good.error);
    assert.equal(JSON.parse(good.value).name, 'Renamed');
    const badV = settingsKeys.validateSetting(key, '{"entitlements":{"formInbox":"yes"}}');
    assert.equal(badV.ok, false, key + ' rejects a non-boolean entitlement');
  }
});

check('defs: platform defs exist for the four keys in the billing group', () => {
  for (const id of ['free', 'standard', 'pro', 'premium']) {
    const def = platform.PLATFORM_SETTING_DEFS.find((d) => d.key === `plans.contents_${id}`);
    assert.ok(def, `def plans.contents_${id}`);
    assert.equal(def.group, 'billing');
    assert.equal(def.default, '');
  }
});

/* ------------------------------------------------------------------ */
/* Wiring pins (routes, api client, admin UI)                          */
/* ------------------------------------------------------------------ */

check('wiring: admin routes + audit + api helpers + panel', () => {
  const routes = fs.readFileSync(path.join(root, 'server/routes/admin.js'), 'utf8');
  assert.ok(routes.includes("router.get('/settings/plans-contents'"), 'GET route');
  assert.ok(routes.includes("router.put('/settings/plans-contents'"), 'PUT route');
  assert.ok(routes.includes("'platform.plans_contents'"), 'audit action name');
  const api = fs.readFileSync(path.join(root, 'public/js/api.js'), 'utf8');
  assert.ok(api.includes("adminPlanContents: () => get('/admin/settings/plans-contents')"), 'api GET helper');
  assert.ok(api.includes('adminPlanContentsUpdate'), 'api PUT helper');
  const app = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
  assert.ok(app.includes('Package contents'), 'panel title');
  assert.ok(app.includes('plan-contents-form'), 'panel form');
  assert.ok(app.includes('EVERYONE on the plan immediately, including existing subscribers'), 'warning copy');
  assert.ok(app.includes('PLANS_CONTENTS_MANAGED_KEYS'), 'managed keys set');
  assert.ok(app.includes("'plans.contents_free'"), 'managed key free');
  assert.ok(app.includes('data-act="reset-plan"'), 'per-plan reset control');
  const serverSrc = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.ok(serverSrc.includes('refreshPlanContents'), 'boot prime in server.js');
});

/* ------------------------------------------------------------------ */
/* DB round-trip: state → save → resolve → catalog → reset             */
/* ------------------------------------------------------------------ */

async function main() {
  const db = require(path.join(root, 'server/db.js'));
  await db.migrate();
  await platform.seedPlatformDefaults();

  await checkAsync('state: fresh install shows defaults, no overrides', async () => {
    const st = await planContents.getPlanContentsState();
    assert.equal(st.plans.length, 4);
    for (const p of st.plans) {
      assert.equal(p.hasOverride, false, p.id);
      assert.equal(p.override, null, p.id);
      assert.deepEqual(p.contents, p.defaults, p.id);
    }
    assert.deepEqual(st.cadenceOptions, ['none', 'monthly', 'weekly']);
    assert.ok(st.entitlementKeys.includes('formInbox'));
  });

  await checkAsync('save: override lands, resolver + raw row + state agree', async () => {
    const fullEnt = { ...plans.PLANS.standard.entitlements, formInbox: false };
    const res = await planContents.updatePlanContents({
      standard: { name: 'Standard Plus', entitlements: fullEnt },
    });
    assert.deepEqual(res.updated, ['standard']);
    assert.deepEqual(res.reset, []);
    const raw = await platform.getPlatformSetting('plans.contents_standard', '');
    assert.equal(JSON.parse(raw).name, 'Standard Plus');
    // The resolver cache refreshed through the setPlatformSetting hook —
    // no manual refresh was called.
    assert.equal(plans.getPlan('standard').name, 'Standard Plus');
    assert.equal(plans.getPlan('standard').entitlements.formInbox, false);
    // Untouched fields resolve from defaults.
    assert.equal(plans.getPlan('standard').tagline, plans.PLANS.standard.tagline);
    const st = await planContents.getPlanContentsState();
    const std = st.plans.find((p) => p.id === 'standard');
    assert.equal(std.hasOverride, true);
    assert.equal(std.contents.name, 'Standard Plus');
    assert.equal(std.defaults.name, 'Standard');
  });

  await checkAsync('catalog: billing.catalogForApi reflects the saved override', async () => {
    const billing = require(path.join(root, 'server/billing.js'));
    const catalog = await billing.catalogForApi();
    const std = catalog.find((p) => p.id === 'standard');
    assert.equal(std.name, 'Standard Plus');
    assert.equal(std.entitlements.formInbox, false);
    const free = catalog.find((p) => p.id === 'free');
    assert.equal(free.name, 'Free');
    assert.equal(free.entitlements.formInbox, false);
  });

  await checkAsync('entitlement flip: a partial override replaces entitlements wholesale end-to-end', async () => {
    await planContents.updatePlanContents({ premium: { entitlements: { formInbox: true } } });
    assert.deepEqual(plans.getPlan('premium').entitlements, { formInbox: true });
    const billing = require(path.join(root, 'server/billing.js'));
    const catalog = await billing.catalogForApi();
    assert.deepEqual(catalog.find((p) => p.id === 'premium').entitlements, { formInbox: true });
  });

  await checkAsync('atomic reject: one invalid plan in a batch writes NOTHING', async () => {
    await assert.rejects(
      () =>
        planContents.updatePlanContents({
          free: { name: 'Should Not Land' },
          pro: { entitlements: { bogusKey: true } },
        }),
      (e) => e.code === 'VALIDATION'
    );
    assert.equal(await platform.getPlatformSetting('plans.contents_free', ''), '');
    assert.equal(plans.getPlan('free').name, 'Free');
  });

  await checkAsync('choke point: platform.setPlatformSetting rejects invalid JSON overrides', async () => {
    await assert.rejects(
      () => platform.setPlatformSetting('plans.contents_free', '{"entitlements":{"formInbox":"yes"}}'),
      (e) => e.code === 'VALIDATION'
    );
    assert.equal(await platform.getPlatformSetting('plans.contents_free', ''), '');
    // …and canonicalizes valid ones (whitespace/field order normalized).
    await platform.setPlatformSetting('plans.contents_free', '{ "tagline": "  Padded  " }');
    const raw = await platform.getPlatformSetting('plans.contents_free', '');
    assert.equal(JSON.parse(raw).tagline, 'Padded');
    assert.equal(plans.getPlan('free').tagline, 'Padded');
    await platform.setPlatformSetting('plans.contents_free', '');
    assert.equal(plans.getPlan('free').tagline, plans.PLANS.free.tagline);
  });

  await checkAsync('reset: null clears the row and restores defaults', async () => {
    const res = await planContents.updatePlanContents({ standard: null, premium: null });
    assert.deepEqual(res.reset.sort(), ['premium', 'standard']);
    assert.equal(await platform.getPlatformSetting('plans.contents_standard', ''), '');
    assert.equal(await platform.getPlatformSetting('plans.contents_premium', ''), '');
    assert.equal(plans.getPlan('standard').name, 'Standard');
    assert.equal(plans.getPlan('standard').entitlements.formInbox, true);
    // Resetting an already-default plan is an unchanged no-op.
    const res2 = await planContents.updatePlanContents({ standard: null });
    assert.deepEqual(res2.unchanged, ['standard']);
  });

  await checkAsync('boot refresh: refreshPlanContents primes the resolver from stored rows', async () => {
    await platform.setPlatformSetting('plans.contents_pro', '{"name":"Pro Renamed"}');
    plans.setContentsOverrides({}); // simulate a cold process
    assert.equal(plans.getPlan('pro').name, 'Pro');
    await planContents.refreshPlanContents();
    assert.equal(plans.getPlan('pro').name, 'Pro Renamed');
    await platform.setPlatformSetting('plans.contents_pro', '');
    await planContents.refreshPlanContents();
    assert.equal(plans.getPlan('pro').name, 'Pro');
  });

  await checkAsync('corrupt stored row resolves to defaults, never a crash', async () => {
    const { query } = require(path.join(root, 'server/db.js'));
    await query(
      'INSERT INTO platform_settings (`key`, value) VALUES (:key, :value) ON DUPLICATE KEY UPDATE value = VALUES(value)',
      { key: 'plans.contents_free', value: '{"entitlements":{"formInbox":"yes"}}' }
    );
    await planContents.refreshPlanContents();
    assert.equal(plans.getPlan('free').name, 'Free');
    assert.equal(plans.getPlan('free').entitlements.formInbox, false);
    await query('DELETE FROM platform_settings WHERE `key` = :key', { key: 'plans.contents_free' });
    await planContents.refreshPlanContents();
  });

  await checkAsync('pricing panel: renamed plan resolves in pricing state', async () => {
    await planContents.updatePlanContents({ standard: { name: 'Standard Renamed' } });
    const pricingAdmin = require(path.join(root, 'server/pricingAdmin.js'));
    const st = await pricingAdmin.getPricingState();
    assert.equal(st.items.find((i) => i.id === 'standard').name, 'Standard Renamed');
    await planContents.updatePlanContents({ standard: null });
    const st2 = await pricingAdmin.getPricingState();
    assert.equal(st2.items.find((i) => i.id === 'standard').name, 'Standard');
  });

  console.log(`batch57 plan-contents: ${results.length} checks passed`);
}

main().catch((e) => {
  console.error('batch57 FAILED:', e);
  process.exit(1);
});
