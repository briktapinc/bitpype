'use strict';
/**
 * Batch 46 — Google Business Profile manager, Phase 1.
 *   platform settings registration (defs + validation + secret, never
 *   seeded into workspaces) → schema creation → OAuth refresh-token
 *   encryption round-trip (and the token never appears in the public
 *   connection shape) → prefill from a fixture lead (+ site domain
 *   eligibility) → conflict flagging with Google's value winning →
 *   Places prefill dormant codes (NO_KEY / NO_PLACE_ID) + stubbed
 *   details fetch (headers, parse, hours day-mapping) → local
 *   validation rules (Google's documented limits + §8 policy traps) →
 *   change-set lifecycle: draft → validate → ready → push HELD at
 *   ready while approval is pending (§7.6 message, zero client calls)
 *   → approval flip + stubbed Google client (validateOnly → update
 *   with updateMask = changed fields only → read-back snapshot) →
 *   quota-shaped error maps back to API_PENDING → hard failure lands
 *   'failed' with the response stored → OAuth not-configured honest
 *   state + stubbed OAuth exchange binding a connected account →
 *   tampered state rejected → cross-lead change-set guard (the
 *   portal's session-lead rule) → portal tab registration (owner yes,
 *   renter no) → pagination on change sets + overview.
 * NO live Google calls: every fetch / client is an injected stub.
 */
process.env.SETTINGS_ENCRYPTION_KEY = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.BITPYPE_TEST_ROOT || path.resolve(__dirname, '..');
let Database;
try {
  Database = require('better-sqlite3');
} catch {
  Database = require('node:sqlite').DatabaseSync;
}
const db = new Database(':memory:');
db.exec(fs.readFileSync(path.join(root, 'src/schema.sql'), 'utf8'));
const results = [];
function check(name, fn) {
  fn();
  results.push(name);
}
async function acheck(name, fn) {
  await fn();
  results.push(name);
}

const gbp = require(path.join(root, 'src/gbp.js'));
const PLACE_ID = 'ChIJN1t_tDeuEmsRUsoyG83frY4';
const FAKE_REFRESH = 'test-refresh' + '-token-123';

function insertLead(values) {
  const cols = Object.keys(values);
  const info = db
    .prepare(`INSERT INTO leads (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(...cols.map((c) => values[c]));
  return Number(info.lastInsertRowid);
}

const lead1 = insertLead({
  business_name: 'Fixture Plumbing LLC',
  category: 'Plumber',
  phone: '(610) 555-0119',
  email: 'hello@fixtureplumbing.example',
  address: '123 Main St',
  city: 'Reading',
  state: 'PA',
  postal_code: '19601',
  country: 'US',
  description: 'Family plumbers in Reading.',
  hours: JSON.stringify([{ day: 'Monday', open: '09:00', close: '17:00' }]),
  website: '',
});
const lead2 = insertLead({ business_name: 'Second Fixture HVAC', category: 'HVAC', city: 'Wyomissing', state: 'PA' });

async function main() {
  // ── Schema ──
  check('batch46 schema: gbp tables created, ensureTables idempotent', () => {
    gbp.ensureTables(db);
    gbp.ensureTables(db);
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'gbp_%' ORDER BY name")
      .all()
      .map((r) => r.name);
    assert.deepEqual(names, ['gbp_change_sets', 'gbp_connections', 'gbp_snapshots']);
  });

  // ── Platform settings registration ──
  check('batch46 settings: gbp keys registered, validated, secret, never workspace-seeded', () => {
    const settingsKeys = require(path.join(root, 'server/settingsKeys.js'));
    assert(settingsKeys.SECRET_KEYS.includes('gbp.oauth_client_secret'));
    for (const k of ['gbp.oauth_client_id', 'gbp.oauth_client_secret', 'gbp.cloud_project_number', 'gbp.api_approval_state', 'gbp.api_approved_at']) {
      assert(settingsKeys.SETTABLE_KEYS.includes(k), `${k} settable`);
    }
    assert.equal(settingsKeys.validateSetting('gbp.api_approval_state', 'approved').ok, true);
    assert.equal(settingsKeys.validateSetting('gbp.api_approval_state', '').value, 'pending');
    assert.equal(settingsKeys.validateSetting('gbp.api_approval_state', 'maybe').ok, false);
    assert.equal(settingsKeys.validateSetting('gbp.cloud_project_number', '123456789').ok, true);
    assert.equal(settingsKeys.validateSetting('gbp.cloud_project_number', 'proj-123').ok, false);
    assert.equal(settingsKeys.validateSetting('gbp.api_approved_at', '2026-12-28').ok, true);
    assert.equal(settingsKeys.validateSetting('gbp.api_approved_at', 'Dec 2026').ok, false);
    assert.equal(settingsKeys.validateSetting('gbp.oauth_client_id', '123-abc.apps.googleusercontent.com').ok, true);
    assert.equal(settingsKeys.validateSetting('gbp.oauth_client_id', 'has spaces').ok, false);
    const platform = require(path.join(root, 'server/platform.js'));
    for (const k of ['gbp.oauth_client_id', 'gbp.oauth_client_secret', 'gbp.cloud_project_number', 'gbp.api_approval_state', 'gbp.api_approved_at']) {
      const def = platform.PLATFORM_SETTING_DEFS.find((d) => d.key === k);
      assert(def, `${k} def exists`);
      assert.equal(def.group, 'gbp', `${k} in group gbp`);
      assert(!platform.WORKSPACE_SEED_KEYS.includes(k), `${k} is never seeded into workspaces`);
    }
    const secretDef = platform.PLATFORM_SETTING_DEFS.find((d) => d.key === 'gbp.oauth_client_secret');
    assert.equal(secretDef.secret, true);
    assert(platform.PLATFORM_SECRET_KEYS.includes('gbp.oauth_client_secret'));
    const approvalDef = platform.PLATFORM_SETTING_DEFS.find((d) => d.key === 'gbp.api_approval_state');
    assert.equal(approvalDef.default, 'pending');
  });

  // ── Token storage ──
  check('batch46 tokens: refresh token encrypted at rest, round-trips, never serialized', () => {
    gbp.storeConnectionTokens(db, lead1, { refreshToken: FAKE_REFRESH, scopes: gbp.GBP_SCOPE, googleAccountId: 'g-1' });
    const raw = db.prepare('SELECT token_enc FROM gbp_connections WHERE lead_id = ?').get(lead1);
    assert(raw.token_enc.startsWith('enc:v1:'), 'stored value is secretBox-encrypted');
    assert(!raw.token_enc.includes(FAKE_REFRESH), 'plaintext token not present in storage');
    assert.equal(gbp.readRefreshToken(db, lead1), FAKE_REFRESH);
    const pub = gbp.getConnection(db, lead1);
    assert.equal(pub.has_token, true);
    assert.equal(pub.status, 'connected');
    assert(!JSON.stringify(pub).includes(FAKE_REFRESH), 'public connection carries no token');
    assert(!('token_enc' in pub), 'public connection has no token field');
  });

  // ── Prefill from the lead + site ──
  check('batch46 prefill: lead fields flow in; staged preview website is not eligible', () => {
    try {
      db.exec('ALTER TABLE websites ADD COLUMN custom_domain TEXT');
    } catch {
      /* column already there */
    }
    db.prepare(
      "INSERT INTO websites (lead_id, name, theme, pages, status, preview_url) VALUES (?, 'Fixture site', '{}', '[]', 'published', 'https://bp-w1-s99.pages.dev')"
    ).run(lead1);
    const pre = gbp.buildPrefill(db, lead1);
    assert.equal(pre.proposedState.name, 'Fixture Plumbing LLC');
    assert.equal(pre.proposedState.primary_category, 'Plumber');
    assert.equal(pre.proposedState.phone, '(610) 555-0119');
    assert.equal(pre.proposedState.address.city, 'Reading');
    assert.equal(pre.proposedState.location_mode, 'storefront');
    assert.deepEqual(pre.proposedState.hours.monday, [{ open: '09:00', close: '17:00' }]);
    assert.equal(pre.proposedState.website, 'https://bp-w1-s99.pages.dev');
    assert.equal(pre.websiteEligible, false);
    assert(/staged preview/i.test(pre.websiteNote));
  });

  check('batch46 prefill: a live custom domain becomes the eligible website', () => {
    db.prepare("UPDATE websites SET custom_domain = 'fixtureplumbing.com' WHERE lead_id = ?").run(lead1);
    const pre = gbp.buildPrefill(db, lead1);
    assert.equal(pre.proposedState.website, 'https://fixtureplumbing.com');
    assert.equal(pre.websiteEligible, true);
  });

  // ── Conflicts: Google's current value wins ──
  check('batch46 prefill conflicts: differing fields flagged, Google value proposed', () => {
    const googleState = gbp.normalizeProfileState({
      name: 'Fixture Plumbing LLC',
      primary_category: 'Plumber',
      phone: '+1 610-555-9999',
      website: 'https://fixtureplumbing.com',
      address: { line1: '123 Main St', city: 'Reading', region: 'PA', postal_code: '19601', country: 'US' },
    });
    gbp.saveSnapshot(db, lead1, googleState, 'oauth');
    const pre = gbp.buildPrefill(db, lead1);
    assert.equal(pre.fields.phone.conflict, true);
    assert.equal(pre.proposedState.phone, '+1 610-555-9999');
    assert.equal(pre.fields.phone.source, 'google');
    assert.equal(pre.fields.name.conflict, false);
    assert(pre.conflicts.includes('phone'));
  });

  // ── Places prefill: dormant + stubbed ──
  await acheck('batch46 places: NO_KEY / NO_PLACE_ID dormant codes, never an exception', async () => {
    const noKey = await gbp.fetchPlacesState(PLACE_ID, { apiKey: '' });
    assert.equal(noKey.ok, false);
    assert.equal(noKey.code, 'NO_KEY');
    const noId = await gbp.fetchPlacesState('', { apiKey: 'k' });
    assert.equal(noId.code, 'NO_PLACE_ID');
    const dormant = await gbp.placesPrefillForLead(db, lead1, { apiKey: '' });
    assert.equal(dormant.code, 'NO_KEY');
  });

  await acheck('batch46 places: stubbed details fetch parses state + hours, key in header only', async () => {
    gbp.setConnectionPlaceId(db, lead1, PLACE_ID);
    let seen = null;
    const fetchImpl = async (url, opts) => {
      seen = { url, opts };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          displayName: { text: 'Fixture Plumbing LLC' },
          primaryTypeDisplayName: { text: 'Plumber' },
          nationalPhoneNumber: '(610) 555-0119',
          websiteUri: 'https://fixtureplumbing.com',
          formattedAddress: '123 Main St, Reading, PA 19601, USA',
          addressComponents: [
            { longText: '123', shortText: '123', types: ['street_number'] },
            { longText: 'Main St', shortText: 'Main St', types: ['route'] },
            { longText: 'Reading', shortText: 'Reading', types: ['locality'] },
            { longText: 'Pennsylvania', shortText: 'PA', types: ['administrative_area_level_1'] },
            { longText: '19601', shortText: '19601', types: ['postal_code'] },
            { longText: 'United States', shortText: 'US', types: ['country'] },
          ],
          regularOpeningHours: {
            periods: [
              { open: { day: 1, hour: 9, minute: 0 }, close: { day: 1, hour: 17, minute: 30 } },
              { open: { day: 6, hour: 10, minute: 0 }, close: { day: 6, hour: 14, minute: 0 } },
            ],
          },
          rating: 4.8,
          userRatingCount: 96,
          googleMapsUri: 'https://maps.google.com/?cid=42',
        }),
      };
    };
    const r = await gbp.placesPrefillForLead(db, lead1, { apiKey: 'test-places-key', fetchImpl });
    assert.equal(r.ok, true);
    assert.equal(r.state.name, 'Fixture Plumbing LLC');
    assert.equal(r.state.address.line1, '123 Main St');
    assert.equal(r.state.address.region, 'PA');
    assert.deepEqual(r.state.hours.monday, [{ open: '09:00', close: '17:30' }]);
    assert.deepEqual(r.state.hours.saturday, [{ open: '10:00', close: '14:00' }]);
    assert.equal(r.meta.rating, 4.8);
    assert(seen.url.includes('/v1/places/' + PLACE_ID));
    assert(!seen.url.includes('test-places-key'), 'API key never travels in the URL');
    assert.equal(seen.opts.headers['X-Goog-Api-Key'], 'test-places-key');
    assert(seen.opts.headers['X-Goog-FieldMask'].includes('formattedAddress'));
  });

  // ── Local validation rules ──
  check('batch46 validation: Google limits + policy traps enforced locally', () => {
    const base = gbp.normalizeProfileState({
      name: 'Fixture Plumbing LLC',
      primary_category: 'Plumber',
      phone: '(610) 555-0119',
      website: 'https://fixtureplumbing.com',
      address: { line1: '123 Main St', city: 'Reading', region: 'PA', postal_code: '19601', country: 'US' },
    });
    assert.equal(gbp.validateProfileState(base, { leadName: 'Fixture Plumbing LLC' }).ok, true);
    const longDesc = gbp.validateProfileState({ ...base, description: 'x'.repeat(751) });
    assert(longDesc.errors.some((e) => e.code === 'DESCRIPTION_TOO_LONG'));
    const staged = gbp.validateProfileState({ ...base, website: 'https://bp-w1-s99.pages.dev' });
    assert(staged.errors.some((e) => e.code === 'WEBSITE_NOT_ELIGIBLE'));
    const sab = gbp.validateProfileState({ ...base, location_mode: 'service_area', service_areas: [] });
    assert(sab.errors.some((e) => e.code === 'SERVICE_AREA_REQUIRED'));
    assert(sab.warnings.some((w) => w.code === 'SAB_ADDRESS_HIDDEN'));
    const renamed = gbp.validateProfileState({ ...base, name: 'Best Cheap Plumbers 24/7' }, { leadName: 'Fixture Plumbing LLC' });
    assert(renamed.warnings.some((w) => w.code === 'NAME_DIFFERS_FROM_LEAD'));
    const noPostal = gbp.validateProfileState({ ...base, address: { ...base.address, postal_code: '' } });
    assert(noPostal.errors.some((e) => e.code === 'ADDRESS_INCOMPLETE'));
  });

  // ── Change-set lifecycle ──
  let csReady = null;
  check('batch46 change sets: draft diffs against the snapshot, validate promotes to ready', () => {
    gbp.upsertConnection(db, lead1, { status: 'connected', location_name: 'locations/123' });
    const snap = gbp.getLatestSnapshot(db, lead1);
    const proposed = { ...snap.state, phone: '(610) 555-2222', website: 'https://www.fixtureplumbing.com' };
    const cs = gbp.createChangeSet(db, lead1, { author: 'staff:1', state: proposed });
    assert.equal(cs.status, 'draft');
    assert.deepEqual(cs.changes.map((c) => c.field), ['phone', 'website']);
    const { changeSet, validation } = gbp.validateChangeSet(db, cs.id);
    assert.equal(validation.ok, true);
    assert.equal(changeSet.status, 'ready');
    csReady = changeSet;
  });

  await acheck('batch46 push held: approval pending stops at ready with the §7.6 message, zero client calls', async () => {
    let calls = 0;
    const countingClient = {
      validateOnly: async () => { calls++; return { ok: true }; },
      updateLocation: async () => { calls++; return {}; },
      getLocation: async () => { calls++; return null; },
    };
    const r = await gbp.pushChangeSet(db, csReady.id, { approvalState: 'pending', googleClient: countingClient });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'API_PENDING');
    assert.equal(r.message, 'Google API access still pending — nothing was sent.');
    assert.equal(calls, 0);
    assert.equal(gbp.getChangeSet(db, csReady.id).status, 'ready');
  });

  await acheck('batch46 push approved + stubbed client: mask = changed fields only, read-back snapshot saved', async () => {
    const seen = {};
    const client = {
      validateOnly: async (name, payload, mask) => { seen.validate = { name, mask }; return { ok: true }; },
      updateLocation: async (name, payload, mask) => { seen.update = { name, payload, mask }; return { name }; },
      getLocation: async (name) => {
        seen.readBack = name;
        return { state: { ...gbp.getChangeSet(db, csReady.id).state, phone: '(610) 555-2222' } };
      },
    };
    const r = await gbp.pushChangeSet(db, csReady.id, { approvalState: 'approved', googleClient: client });
    assert.equal(r.ok, true);
    assert.equal(r.changeSet.status, 'pushed');
    assert(r.changeSet.pushed_at);
    assert.equal(seen.validate.name, 'locations/123');
    assert.deepEqual(seen.update.mask, ['primaryPhone', 'websiteUri']);
    assert.equal(seen.update.payload.primaryPhone, '(610) 555-2222');
    const snap = gbp.getLatestSnapshot(db, lead1);
    assert.equal(snap.source, 'push_readback');
  });

  await acheck('batch46 push failures: quota error returns to API_PENDING untouched; hard failure lands failed + stored', async () => {
    const snap = gbp.getLatestSnapshot(db, lead1);
    const mk = () => {
      const cs = gbp.createChangeSet(db, lead1, {
        author: 'staff:1',
        state: { ...snap.state, description: 'Updated description for the fixture.' },
      });
      return gbp.validateChangeSet(db, cs.id).changeSet;
    };
    const quotaCs = mk();
    const quotaClient = {
      updateLocation: async () => {
        const e = new Error('Quota exceeded');
        e.status = 429;
        e.response = { error: { status: 'RESOURCE_EXHAUSTED' } };
        throw e;
      },
    };
    const qr = await gbp.pushChangeSet(db, quotaCs.id, { approvalState: 'approved', googleClient: quotaClient });
    assert.equal(qr.code, 'API_PENDING');
    assert.equal(gbp.getChangeSet(db, quotaCs.id).status, 'ready');

    const failCs = mk();
    const failClient = {
      updateLocation: async () => {
        const e = new Error('Invalid field');
        e.response = { error: { message: 'bad' } };
        throw e;
      },
    };
    const fr = await gbp.pushChangeSet(db, failCs.id, { approvalState: 'approved', googleClient: failClient });
    assert.equal(fr.code, 'PUSH_FAILED');
    const stored = gbp.getChangeSet(db, failCs.id);
    assert.equal(stored.status, 'failed');
    assert(stored.google_response && stored.google_response.error, 'Google response stored on the failed set');
  });

  await acheck('batch46 push guards: draft cannot push (NOT_READY); mask builder skips photos + dedupes', async () => {
    const snap = gbp.getLatestSnapshot(db, lead1);
    const draft = gbp.createChangeSet(db, lead1, {
      author: 'staff:1',
      state: { ...snap.state, description: 'A draft that never gets validated.' },
    });
    const r = await gbp.pushChangeSet(db, draft.id, { approvalState: 'approved', googleClient: {} });
    assert.equal(r.code, 'NOT_READY');
    assert.deepEqual(
      gbp.updateMaskForChanges([{ field: 'name' }, { field: 'phone' }, { field: 'photos' }, { field: 'name' }]),
      ['name', 'primaryPhone']
    );
  });

  // ── OAuth ──
  check('batch46 oauth: no client configured renders the honest not-configured state', () => {
    const r = gbp.buildOauthStart(db, { workspaceId: 1, leadId: lead1, cfg: {}, appUrl: 'https://bitpype.com' });
    assert.equal(r.configured, false);
    assert.equal(r.code, 'OAUTH_NOT_CONFIGURED');
    assert(/not configured yet/.test(r.message));
    const panel = gbp.panelData(db, lead1, { cfg: { approvalState: 'pending' } });
    assert.equal(panel.config.oauthReady, false);
    assert.equal(panel.config.apiPending, true);
    assert.equal(panel.config.apiPendingMessage, 'Google API access still pending — nothing was sent.');
  });

  await acheck('batch46 oauth: stubbed exchange connects the account, token stored encrypted', async () => {
    const cfg = { clientId: 'cid-123', clientSecret: 'cs-456', approvalState: 'pending' };
    const start = gbp.buildOauthStart(db, {
      workspaceId: 1,
      leadId: lead1,
      actor: 'staff:1',
      returnTo: '/app#/leads',
      cfg,
      appUrl: 'https://bitpype.com',
    });
    assert.equal(start.configured, true);
    const url = new URL(start.url);
    assert.equal(url.hostname, 'accounts.google.com');
    assert.equal(url.searchParams.get('scope'), gbp.GBP_SCOPE);
    assert.equal(url.searchParams.get('access_type'), 'offline');
    const state = url.searchParams.get('state');
    const calls = [];
    const fetchImpl = async (u, opts) => {
      calls.push(u);
      if (String(u).includes('oauth2.googleapis.com/token')) {
        return { ok: true, status: 200, json: async () => ({ access_token: 'at-1', refresh_token: FAKE_REFRESH, scope: gbp.GBP_SCOPE }) };
      }
      return { ok: true, status: 200, json: async () => ({ sub: 'g-987', email: 'owner@example.com' }) };
    };
    const out = await gbp.handleOauthCallback(db, { code: 'auth-code', state, cfg, appUrl: 'https://bitpype.com', fetchImpl });
    assert.equal(out.leadId, lead1);
    assert.equal(calls.length, 2);
    const conn = gbp.getConnection(db, lead1);
    assert.equal(conn.status, 'connected');
    assert.equal(conn.google_account_id, 'g-987');
    assert.equal(gbp.readRefreshToken(db, lead1), FAKE_REFRESH);
    await assert.rejects(
      () => gbp.handleOauthCallback(db, { code: 'x', state: state.slice(0, -2) + 'zz', cfg, appUrl: 'https://bitpype.com', fetchImpl }),
      (e) => e.code === 'INVALID_STATE'
    );
  });

  // ── Cross-lead guard + portal registration (role guards) ──
  check('batch46 guards: a change set is invisible through another lead; renter tab set excludes gbp', () => {
    const anyCs = gbp.listChangeSets(db, lead1, { page: 1, pageSize: 1 }).rows[0];
    assert(anyCs, 'fixture change set exists');
    assert.equal(gbp.getChangeSetForLead(db, lead2, anyCs.id), null);
    assert.equal(gbp.getChangeSetForLead(db, lead1, anyCs.id).id, anyCs.id);
    const tabs = require(path.join(root, 'server/portalTabs.js'));
    assert(tabs.PORTAL_TABS.includes('gbp'));
    assert.equal(tabs.TAB_LABELS.gbp, 'Google Profile');
    assert(tabs.effectiveTabs('owner', null).includes('gbp'));
    assert(!tabs.effectiveTabs('renter', null).includes('gbp'));
    assert.equal(tabs.hasTab({ user_type: 'renter' }, 'gbp'), false);
    assert.equal(tabs.hasTab({ user_type: 'owner' }, 'gbp'), true);
    const portalSrc = fs.readFileSync(path.join(root, 'server/routes/portal.js'), 'utf8');
    assert(portalSrc.includes("['/gbp', 'gbp']"), 'portal route→tab mapping registered');
    assert(portalSrc.includes('getChangeSetForLead'), 'portal change-set routes use the lead guard');
    const staffSrc = fs.readFileSync(path.join(root, 'server/routes/gbp.js'), 'utf8');
    assert(staffSrc.includes("'/oauth/callback'"), 'staff router carries the OAuth callback');
    assert(staffSrc.includes("req.auth.via !== 'session'"), 'staff router is session-only');
  });

  // ── UI structural pins ──
  check('batch46 ui: staff admin tab + drawer, portal nav + panel all wired', () => {
    const appJs = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
    assert(appJs.includes("['gbp', 'Google Business']"));
    assert(appJs.includes('renderAdminGbp'));
    assert(appJs.includes('id="ld-gbp"'));
    assert(appJs.includes('loadLeadGbp'));
    const portalHtml = fs.readFileSync(path.join(root, 'public/portal.html'), 'utf8');
    assert(portalHtml.includes('data-panel="gbp"'));
    assert(portalHtml.includes('id="gbp-host"'));
    const portalJs = fs.readFileSync(path.join(root, 'public/js/portal.js'), 'utf8');
    assert(portalJs.includes('loadGbpPanel'));
    assert(portalJs.includes("'/gbp'"));
    const apiJs = fs.readFileSync(path.join(root, 'public/js/api.js'), 'utf8');
    assert(apiJs.includes('gbpPanel'));
    const serverJs = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
    assert(serverJs.includes("app.use('/api/v1/gbp'"));
  });

  // ── Pagination ──
  check('batch46 pagination: change sets + overview page via src/paginate', () => {
    for (let i = 0; i < 30; i++) {
      gbp.createChangeSet(db, lead2, { author: 'staff:1', state: { name: `Second Fixture HVAC ${i}` } });
    }
    const p1 = gbp.listChangeSets(db, lead2, { page: 1, pageSize: 25 });
    assert.equal(p1.total, 30);
    assert.equal(p1.rows.length, 25);
    const p2 = gbp.listChangeSets(db, lead2, { page: 2, pageSize: 25 });
    assert.equal(p2.rows.length, 5);
    assert.equal(p2.pages, 2);
    const ov = gbp.overview(db, { page: 1, pageSize: 1 });
    assert(ov.total >= 2);
    assert.equal(ov.rows.length, 1);
    assert(ov.pages >= 2);
    assert.equal(typeof ov.awaitingPushTotal, 'number');
  });

  // ── Panel assembly ──
  check('batch46 panel: assembles config + connection + prefill + change sets', () => {
    const panel = gbp.panelData(db, lead1, { cfg: { clientId: 'x', clientSecret: 'y', approvalState: 'approved', projectNumber: '123' } });
    assert.equal(panel.config.oauthReady, true);
    assert.equal(panel.config.apiPending, false);
    assert.equal(panel.config.projectNumberSet, true);
    assert.equal(panel.connection.status, 'connected');
    assert(panel.changeSets.total >= 1);
    assert.equal(panel.lead.business_name, 'Fixture Plumbing LLC');
  });

  console.log(JSON.stringify({ file: 'gbp-manager-regressions', passed: results.length, checks: results }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
