'use strict';
/**
 * Batch 117 — WORDPRESS DESIGN-CHAT EDITING v1 (Ely's build order
 * 2026-11-02, after the think-through: design-chat editing was the
 * goal of the Batch 114 plugin all along).
 *
 * Decisions implemented exactly as Ely settled them:
 *   APPROVE-FIRST — a chat turn can only STAGE a proposal; the
 *     plugin applies it solely after the owner's Approve, and
 *     snapshots before applying so Undo restores byte-for-byte.
 *   SCOPE v1 = Layer 1 (global look tokens compiled into a
 *     plugin-owned CSS layer) + Layer 2 (BitPype zones). NO page
 *     content edits, NO builder internals, NO raw CSS op anywhere.
 *   CAPS — WP chat turns count against the same per-plan daily
 *     caps as BitPype-site chat (Batch 97), pooled per registration.
 *   ISOLATION — census/proposals/chat/usage are keyed by the
 *     wp_site_links registration (+workspace) and never cross.
 *
 * Part 1 — source pins: vocabulary mirrored platform↔plugin, the
 *   plugin capability handshake, approve-first wiring, portal copy,
 *   SEC-13 census byte-identical, no license machinery (incl. the
 *   new design.php), PHP lint when available.
 * Part 2 — functional (dialect-aware): ops validation/compilation,
 *   the v2 capability gate (v1 = forms only, never an error),
 *   census sanitize/store, the full proposal lifecycle over the
 *   module API (stage → preview token → approve → sync → report
 *   applied → undo → report undone; reject; supersede), plugin-side
 *   refusal facts (unknown op), usage caps, chat-store isolation.
 * Part 3 — chat turns with the model stubbed at global.fetch (the
 *   Batch 106 pattern): question answered read-only; a change is
 *   staged + critic-verified against the preview; an invalid op is
 *   dropped WITH disclosure; model failure is graceful and stages
 *   nothing; the daily cap refuses without counting.
 * Part 4 — HTTP over the real wordpressPublic router: census →
 *   sync → preview → report, cross-registration preview refusal,
 *   revoked fail-closed, v1 plugin refused UPDATE_REQUIRED.
 *
 * NEGATIVE PROOF: B117_NEGATIVE=raw-op asserts a raw-CSS op IS
 * accepted by the op engine — it must go RED.
 * B117_SKIP_HTTP=1 skips Part 4 locally; the gate runs it.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const NEGATIVE = process.env.B117_NEGATIVE || '';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b117-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch117', 'test', 'session', 'secret'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY = process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 43).toString('base64');

const groups = [];
function group(name, n) {
  groups.push(`${name} (${n})`);
  console.log(`  ok ${name} — ${n} checks`);
}

const CENSUS = {
  wp_version: '6.9',
  theme: { name: 'Twenty Twenty-Five', version: '1.3', stylesheet: 'twentytwentyfive' },
  site: {
    title: 'Fixture Plumbing',
    tagline: 'Pipes fixed fast',
    logo_url: '',
    timezone: 'UTC',
    home_url: 'https://wp.fixture.test',
  },
  pages: [
    { id: 2, title: 'Home', url: 'https://wp.fixture.test/', builder: 'gutenberg' },
    { id: 3, title: 'Landing', url: 'https://wp.fixture.test/landing', builder: 'elementor' },
    { id: 4, title: 'Odd', url: 'https://wp.fixture.test/odd', builder: 'weird-value' },
  ],
  menus: [{ name: 'Main', locations: ['primary'] }],
  design: { version: 0, tokens: {}, zones: {} },
};

(async () => {
  // ---------------------------------------------------------------
  // Part 1 — source pins
  // ---------------------------------------------------------------
  {
    let n = 0;
    const has = (src, s, label) => {
      assert.ok(src.includes(s), label);
      n += 1;
    };

    const opsSrc = read('server/wpDesignOps.js');
    has(opsSrc, "'primary_color'", 'vocabulary carries the color tokens');
    has(opsSrc, 'zone_create', 'vocabulary carries zone ops');
    assert.ok(!opsSrc.includes('raw_css'), 'there is NO raw-css op in the vocabulary');
    n += 1;

    const designPhp = read('integrations/wordpress/bitpype-connector/includes/design.php');
    for (const token of ['primary_color', 'button_background', 'heading_font', 'base_font_size', 'border_radius']) {
      has(designPhp, `'${token}'`, `plugin mirrors token ${token}`);
    }
    has(designPhp, 'bitpype_design_validate_ops', 'plugin validates ops itself (second refusal layer)');
    has(designPhp, "add_action('wp_head', 'bitpype_design_print_layer', 999)", 'design layer prints last in head');
    has(designPhp, "add_shortcode('bitpype_zone'", 'zone shortcode registered');
    has(designPhp, 'bitpype_design_snapshot', 'plugin snapshots before applying');
    has(designPhp, 'bitpype_preview', 'preview token parameter is honored');
    has(designPhp, 'design1', 'plugin design capability named in the design module');
    const main = read('integrations/wordpress/bitpype-connector/bitpype-connector.php');
    has(main, 'Version:           2.0.0', 'plugin is version 2.0.0');
    has(main, 'includes/design.php', 'main file loads the design module');
    const api = read('integrations/wordpress/bitpype-connector/includes/api.php');
    has(api, 'function bitpype_connector_capabilities()', 'capability handshake exists');
    has(api, "'design1'", 'design1 capability is reported');
    has(api, 'bitpype_connector_plugin_info()', 'register/ping carry version + caps');
    const uninstall = read('integrations/wordpress/bitpype-connector/uninstall.php');
    has(uninstall, "'bitpype_design_state'", 'uninstall wipes the design state');
    has(uninstall, "'bitpype_design_snapshots'", 'uninstall wipes the snapshots');
    const allPhp = [
      main,
      api,
      designPhp,
      uninstall,
      read('integrations/wordpress/bitpype-connector/includes/admin.php'),
    ].join('\n');
    assert.ok(!/license_key|activate_license|license server/i.test(allPhp), 'NO license machinery incl. design.php');
    n += 1;
    assert.ok(!/eval\s*\(|create_function/.test(allPhp), 'no eval-class constructs incl. design.php');
    n += 1;

    const wpPublic = read('server/routes/wordpressPublic.js');
    has(
      wpPublic,
      "router.post('/design/census', siteLimit, requireDesignSite",
      'census endpoint behind the design gate'
    );
    has(wpPublic, "router.get('/design/sync', siteLimit, requireDesignSite", 'sync endpoint behind the design gate');
    has(
      wpPublic,
      "router.post('/design/report', siteLimit, requireDesignSite",
      'report endpoint behind the design gate'
    );
    has(
      wpPublic,
      "router.get('/design/preview', siteLimit, requireDesignSite",
      'preview endpoint behind the design gate'
    );
    has(wpPublic, 'UPDATE_REQUIRED', 'a v1 plugin is told to update, never improvised with');
    const portalRoutes = read('server/routes/portal.js');
    has(portalRoutes, "router.get('/wordpress/:id/design', requireClient", 'portal design state route');
    has(portalRoutes, "router.post('/wordpress/:id/design/chat', requireClient", 'portal design chat route');
    has(portalRoutes, 'design/proposals/:pid/approve', 'portal approve route');
    has(portalRoutes, 'design/proposals/:pid/undo', 'portal undo route');
    const portalHtml = read('public/portal.html');
    has(portalHtml, 'id="wp-design-host"', 'portal has the design host');
    has(portalHtml, 'Nothing is ever applied without you', 'portal copy states approve-first');
    has(portalHtml, 'not included yet', 'portal copy is honest about page-content editing');
    has(
      portalHtml,
      '/js/portal.js?v=batch139-pricing1',
      'portal.js cache-busted for Batch 117 (string follows the newest rotation — Batch 131)'
    );
    const portalJs = read('public/js/portal.js');
    const designSlice = portalJs.slice(portalJs.indexOf('// Batch 117 — WordPress design chat panel'));
    assert.ok(designSlice.length > 1000, 'portal.js carries the design panel code');
    n += 1;
    assert.ok(!designSlice.includes('.innerHTML'), 'design panel builds DOM without innerHTML sinks');
    n += 1;
    has(portalJs, 'loadWpDesignPanel', 'portal.js loads the design panel');
    has(portalJs, 'decideWpDesignProposal', 'portal.js decides proposals');

    // Schema: both dialects carry the new tables + columns.
    for (const f of ['sql/schema.sql', 'sql/schema.sqlite.sql']) {
      const schema = read(f);
      has(schema, 'wp_design_proposals', `${f} has the proposals table`);
      has(schema, 'wp_design_chats', `${f} has the chats table`);
      has(schema, 'wp_design_chat_usage', `${f} has the usage table`);
      has(schema, 'plugin_version', `${f} has the plugin_version column`);
      has(schema, 'census_json', `${f} has the census column`);
    }

    // SEC-13 census unchanged (the design panel adds no sinks).
    const { census } = require(path.join(root, 'scripts', 'xss-census.cjs'));
    const cz = census();
    assert.deepEqual(
      cz.summary,
      // Batch 156 rotation: census 450 -> 453 (+1 STATIC +1 ESCAPED +1 SAFE in app.js — the fingerprint surfaces), safe classes 336 -> 339, RAW 78 / IDENT 36 and the 114-entry reviewed set unchanged; baseline regenerated.
      // Batch 161 rotation: census 453 -> 470 (+17 audited Assistant-surface sinks in app.js/portal.js — escape-first markdown renderer + esc()-wrapped usage templates; pairwise multiset-proven vs the 159 census — see batch103 narrative), safe classes 339 -> 351, RAW 81 / IDENT 38, reviewed set 119 entries; baseline regenerated.
      { total: 504, STATIC: 187, ESCAPED: 48, SAFE: 81, BUILDER: 64, IDENT: 38, RAW: 86 },
      'SEC-13 census summary unchanged'
    );
    n += 1;

    // PHP lint when a PHP binary is available (the WP end-to-end
    // exercises the code for real either way).
    let phpBin = null;
    try {
      phpBin = execFileSync('which', ['php'], { encoding: 'utf8' }).trim();
    } catch {
      phpBin = null;
    }
    if (phpBin) {
      const pluginDir = path.join(root, 'integrations', 'wordpress', 'bitpype-connector');
      const walk = (dir) =>
        fs
          .readdirSync(dir, { withFileTypes: true })
          .flatMap((e) =>
            e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.php') ? [path.join(dir, e.name)] : []
          );
      for (const file of walk(pluginDir)) {
        execFileSync(phpBin, ['-l', file], { stdio: 'pipe' });
        n += 1;
      }
    }
    group('Part 1 — source pins + census + php lint', n);
  }

  // ---------------------------------------------------------------
  // Part 2 — functional (module level, both dialects)
  // ---------------------------------------------------------------
  const platformDb = require('../server/db');
  await platformDb.migrate();
  const ops = require('../server/wpDesignOps');
  const wpPlugin = require('../server/wpPlugin');
  const wpDesign = require('../server/wpDesign');
  {
    let n = 0;
    await platformDb.query("INSERT INTO workspaces (id, name, slug) VALUES (1, 'B117 Fixture One', 'b117-one')");
    await platformDb.query("INSERT INTO workspaces (id, name, slug) VALUES (2, 'B117 Fixture Two', 'b117-two')");
    n += 1;

    // Op engine: valid application + deterministic compilation.
    const applied = ops.applyOps({}, {}, [
      { type: 'set_token', token: 'primary_color', value: '#ABC' },
      { type: 'set_token', token: 'body_font', value: 'inter' },
      {
        type: 'zone_create',
        zone: {
          id: 'spring',
          type: 'cta',
          fields: { headline: 'Spring', button_text: 'Call', button_url: 'https://x.test/' },
        },
      },
    ]);
    assert.equal(applied.tokens.primary_color, '#aabbcc', 'hex colors normalize');
    n += 1;
    assert.equal(ops.compileCss(applied.tokens), ops.compileCss(applied.tokens), 'CSS compilation is deterministic');
    n += 1;
    assert.ok(ops.compileCss(applied.tokens).includes('#aabbcc'), 'compiled CSS carries the token value');
    n += 1;

    // Op engine: everything outside the vocabulary is refused.
    const refused = [
      { type: 'raw_css', css: 'body{display:none}' },
      { type: 'set_token', token: 'primary_color', value: 'red' },
      { type: 'set_token', token: 'evil_token', value: '#123456' },
      { type: 'set_token', token: 'base_font_size', value: 99 },
      { type: 'set_token', token: 'body_font', value: 'comic_sans' },
      { type: 'zone_create', zone: { id: 'Bad Id', type: 'cta', fields: { headline: 'x' } } },
      { type: 'zone_create', zone: { id: 'ok-id', type: 'popup', fields: { headline: 'x' } } },
      { type: 'zone_update', zoneId: 'ghost', fields: { headline: 'x' } },
      { type: 'theme_file_edit', path: 'functions.php' },
    ];
    for (const op of refused) {
      if (NEGATIVE === 'raw-op' && op.type === 'raw_css') {
        // Negative proof: this assertion is INVERTED under the env
        // flag — the suite must go red because raw ops are refused.
        assert.doesNotThrow(() => ops.applyOps({}, {}, [op]), 'NEGATIVE: raw op accepted');
      } else {
        assert.throws(() => ops.applyOps({}, {}, [op]), /./, `op refused: ${op.type}`);
      }
      n += 1;
    }
    const lenient = ops.applyOpsLenient({}, {}, [
      { type: 'set_token', token: 'primary_color', value: '#123456' },
      { type: 'set_token', token: 'nope', value: 'x' },
    ]);
    assert.equal(lenient.applied.length, 1, 'lenient keeps the valid op');
    assert.equal(lenient.dropped.length, 1, 'lenient reports the dropped op');
    n += 2;

    // Registration: v2 reports design capability, v1 does not.
    const dlV2 = await wpPlugin.mintDownload(1, 42);
    const regV2 = await wpPlugin.registerSite({
      token: dlV2.token,
      siteUrl: 'https://wp.fixture.test',
      siteName: 'Fixture Plumbing',
      adminEmail: 'a@fixture.test',
      pluginVersion: '2.0.0',
      capabilities: ['forms', 'design1'],
    });
    const linkV2 = await wpPlugin.findById(1, regV2.linkId);
    assert.equal(wpPlugin.designCapable(linkV2), true, 'v2 registration is design-capable');
    n += 1;
    const dlV1 = await wpPlugin.mintDownload(1, 42);
    const regV1 = await wpPlugin.registerSite({
      token: dlV1.token,
      siteUrl: 'https://old.fixture.test',
      siteName: 'Old Site',
      adminEmail: 'b@fixture.test',
    });
    const linkV1 = await wpPlugin.findById(1, regV1.linkId);
    assert.equal(wpPlugin.designCapable(linkV1), false, 'v1 registration is forms-only');
    n += 1;
    const dlOther = await wpPlugin.mintDownload(2, 7);
    const regOther = await wpPlugin.registerSite({
      token: dlOther.token,
      siteUrl: 'https://other.fixture.test',
      siteName: 'Other WS',
      adminEmail: 'c@fixture.test',
      pluginVersion: '2.0.0',
      capabilities: ['forms', 'design1'],
    });
    const linkOther = await wpPlugin.findById(2, regOther.linkId);

    // Census: stored, sanitized (bad builder coerced), read back.
    const stored = await wpDesign.storeCensus(linkV2, CENSUS);
    assert.equal(stored.pages[2].builder, 'none', 'unknown builder values coerce to none');
    n += 1;
    const censusBack = wpDesign.censusOf(await wpPlugin.findById(1, regV2.linkId));
    assert.equal(censusBack.theme.name, 'Twenty Twenty-Five', 'census round-trips');
    n += 1;
    await assert.rejects(
      () => wpDesign.storeCensus(linkV2, { pages: 'nope', theme: null, site: null }),
      /./,
      'malformed census refused'
    );
    n += 1;

    // Proposal lifecycle.
    const st1 = await wpDesign.stageProposal(linkV2, {
      opsList: [{ type: 'set_token', token: 'primary_color', value: '#112233' }],
      tokens: { primary_color: '#112233' },
      zones: {},
      summary: 'Make the primary color deep blue',
      verify: null,
    });
    assert.ok(st1.id > 0 && st1.previewUrl.includes('bitpype_preview='), 'staging mints a preview link');
    n += 1;
    const pv = await wpDesign.validatePreview(linkV2, st1.previewUrl.split('bitpype_preview=')[1]);
    assert.ok(pv && pv.tokens.primary_color === '#112233', 'preview token validates to the staged state');
    n += 1;
    assert.equal(
      await wpDesign.validatePreview(linkOther, st1.previewUrl.split('bitpype_preview=')[1]),
      null,
      'preview token is refused for another registration'
    );
    n += 1;
    assert.equal(await wpDesign.validatePreview(linkV2, 'bpprev_nope'), null, 'a forged preview token is refused');
    n += 1;
    const st2 = await wpDesign.stageProposal(linkV2, {
      opsList: [{ type: 'set_token', token: 'accent_color', value: '#445566' }],
      tokens: { accent_color: '#445566' },
      zones: {},
      summary: 'Accent instead',
      verify: null,
    });
    const list1 = await wpDesign.listProposals(1, linkV2.id);
    assert.equal(list1.find((p) => p.id === st1.id).status, 'superseded', 'a newer proposal supersedes the staged one');
    n += 1;
    assert.equal(
      await wpDesign.validatePreview(linkV2, st1.previewUrl.split('bitpype_preview=')[1]),
      null,
      'a superseded proposal preview is dead'
    );
    n += 1;

    // Reject path.
    const rej = await wpDesign.decideProposal(1, linkV2.id, st2.id, 'reject');
    assert.equal(rej.status, 'rejected', 'reject lands');
    n += 1;
    await assert.rejects(
      () => wpDesign.decideProposal(1, linkV2.id, st2.id, 'approve'),
      /./,
      'a rejected proposal cannot be approved'
    );
    n += 1;

    // Approve → sync → report applied → undo → report undone.
    const st3 = await wpDesign.stageProposal(linkV2, {
      opsList: [{ type: 'set_token', token: 'primary_color', value: '#112233' }],
      tokens: { primary_color: '#112233' },
      zones: {},
      summary: 'Deep blue primary',
      verify: { checked: true, ok: true, notes: ['verified'] },
    });
    await wpDesign.decideProposal(1, linkV2.id, st3.id, 'approve');
    const sync1 = await wpDesign.syncForSite(linkV2);
    assert.equal(sync1.apply.length, 1, 'sync hands the plugin the approved proposal');
    assert.equal(sync1.apply[0].css.includes('#112233'), true, 'sync carries the compiled CSS');
    n += 2;
    const rep1 = await wpDesign.reportFromSite(linkV2, [
      { proposal_id: st3.id, action: 'apply', ok: true, snapshot_version: 1 },
    ]);
    assert.equal(rep1[0].status, 'applied', 'apply report lands');
    n += 1;
    await wpDesign.decideProposal(1, linkV2.id, st3.id, 'undo');
    const sync2 = await wpDesign.syncForSite(linkV2);
    assert.deepEqual(sync2.undo, [{ proposal_id: st3.id }], 'sync hands the plugin the undo');
    n += 1;
    const rep2 = await wpDesign.reportFromSite(linkV2, [{ proposal_id: st3.id, action: 'undo', ok: true }]);
    assert.equal(rep2[0].status, 'undone', 'undo report lands');
    n += 1;
    // Apply-failure report path.
    const st4 = await wpDesign.stageProposal(linkV2, {
      opsList: [{ type: 'set_token', token: 'link_color', value: '#101010' }],
      tokens: { link_color: '#101010' },
      zones: {},
      summary: 'Links',
      verify: null,
    });
    await wpDesign.decideProposal(1, linkV2.id, st4.id, 'approve');
    const rep3 = await wpDesign.reportFromSite(linkV2, [
      { proposal_id: st4.id, action: 'apply', ok: false, error: 'Refused by the plugin: unknown design token: evil' },
    ]);
    assert.equal(rep3[0].status, 'apply_failed', 'a plugin refusal surfaces as apply_failed, never as applied');
    n += 1;

    // Isolation: workspace 2 sees nothing of workspace 1's design.
    assert.equal(await wpDesign.findProposal(2, linkV2.id, st3.id), null, 'proposals are workspace-isolated');
    n += 1;
    await assert.rejects(
      () => wpDesign.designStateForPortal(2, linkV2.id, { limit: 5 }),
      /not found/i,
      'portal design state is workspace-isolated'
    );
    n += 1;
    const state = await wpDesign.designStateForPortal(1, linkV2.id, { limit: 5 });
    assert.equal(state.designCapable, true, 'portal state reports design capability');
    assert.ok(state.proposals.length >= 3, 'portal state carries the proposal history');
    assert.equal(state.census.theme.name, 'Twenty Twenty-Five', 'portal state carries the census');
    n += 3;
    const stateV1 = await wpDesign.designStateForPortal(1, linkV1.id, { limit: 5 });
    assert.equal(stateV1.updateNeeded, true, 'a connected v1 site reads as update-available, not broken');
    n += 1;

    // Usage caps (Batch 97 semantics, per registration).
    const u1 = await wpDesign.checkAndRecordUsage(linkV2.id, { limit: 2, timezone: 'UTC' });
    const u2 = await wpDesign.checkAndRecordUsage(linkV2.id, { limit: 2, timezone: 'UTC' });
    const u3 = await wpDesign.checkAndRecordUsage(linkV2.id, { limit: 2, timezone: 'UTC' });
    assert.deepEqual(
      [u1.allowed, u2.allowed, u3.allowed],
      [true, true, false],
      'the cap allows up to the limit then refuses'
    );
    n += 1;
    const uOther = await wpDesign.checkAndRecordUsage(linkOther.id, { limit: 2, timezone: 'UTC' });
    assert.equal(uOther.allowed, true, 'usage pools are per-registration');
    n += 1;
    const uNull = await wpDesign.checkAndRecordUsage(linkV2.id, { limit: null, timezone: 'UTC' });
    assert.equal(uNull.allowed, true, 'a null limit is unlimited');
    n += 1;

    // Chat store isolation + shape.
    await wpDesign.saveChat(1, linkV2.id, {
      transcript: [{ role: 'user', text: 'hi', at: 'x' }],
      summary: 's',
      pending: null,
    });
    const chatBack = await wpDesign.getChat(1, linkV2.id);
    assert.equal(chatBack.transcript.length, 1, 'chat transcript persists per registration');
    n += 1;
    const chatOther = await wpDesign.getChat(2, linkOther.id);
    assert.equal(chatOther.transcript.length, 0, 'another registration has its own empty chat');
    n += 1;

    group('Part 2 — ops, lifecycle, caps, isolation', n);
  }

  // ---------------------------------------------------------------
  // Part 3 — chat turns with a stubbed model (global.fetch)
  // ---------------------------------------------------------------
  {
    let n = 0;
    const platform = require('../server/platform');
    await platform.setPlatformSetting('muse.model_api_key', 'b117-stub-key');
    const wpDesignChat = require('../server/wpDesignChat');
    // A dedicated registration for chat turns: its own cap pool
    // (the Part 2 link already spent direct usage checks), and the
    // Free plan's 5/day cap is exercised exactly: five turns pass
    // the gate, the sixth is refused.
    const dlChat = await wpPlugin.mintDownload(1, 42);
    const regChat = await wpPlugin.registerSite({
      token: dlChat.token,
      siteUrl: 'https://chat.fixture.test',
      siteName: 'Chat Fixture',
      adminEmail: 'chat@fixture.test',
      pluginVersion: '2.0.0',
      capabilities: ['forms', 'design1'],
    });
    const linkId = regChat.linkId;
    const chatLinkRow = await wpPlugin.findById(1, linkId);
    await wpDesign.storeCensus(chatLinkRow, {
      ...CENSUS,
      site: { ...CENSUS.site, home_url: 'https://chat.fixture.test' },
    });
    n += 1;

    const realFetch = global.fetch;
    let modelMode = 'question';
    const modelReply = (obj) =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(obj) } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    global.fetch = async (url, opts) => {
      const u = String(url || '');
      if (u.includes('/chat/completions')) {
        const body = JSON.parse(String((opts && opts.body) || '{}'));
        const system = body.messages && body.messages[0] ? String(body.messages[0].content) : '';
        if (modelMode === 'fail') throw new Error('provider down');
        if (system.includes('You are the planner')) {
          if (modelMode === 'question')
            return modelReply({
              kind: 'question',
              answer: 'Your homepage was built with Gutenberg; the landing page uses Elementor.',
            });
          if (modelMode === 'clarify')
            return modelReply({
              kind: 'clarify',
              question: 'Which green did you have in mind — deep forest or bright mint?',
            });
          return modelReply({
            kind: 'change',
            plan: { summary: 'Change the primary color', details: 'Set primary_color to #1a7f64' },
          });
        }
        if (system.includes('You are the implementor')) {
          if (modelMode === 'change-invalid') {
            return modelReply({
              ops: [
                { type: 'set_token', token: 'primary_color', value: '#1a7f64' },
                { type: 'raw_css', css: 'body{display:none}' },
              ],
              summary: 'Primary color to deep green',
            });
          }
          return modelReply({
            ops: [{ type: 'set_token', token: 'primary_color', value: '#1a7f64' }],
            summary: 'Primary color to deep green',
          });
        }
        throw new Error('unexpected model call: ' + system.slice(0, 60));
      }
      if (u.includes('bitpype_preview=')) {
        return new Response(
          '<html><head><style id="bitpype-design-layer" data-bitpype-preview="1">:root{--bp-primary:#1a7f64;}h1,h2,h3{color:#1a7f64;}</style><!-- bitpype-design-preview --></head><body>staged</body></html>',
          { status: 200 }
        );
      }
      if (u === 'https://chat.fixture.test' || u.startsWith('https://chat.fixture.test/')) {
        return new Response('<html><body>public site</body></html>', { status: 200 });
      }
      return realFetch(url, opts);
    };

    try {
      // The workspace DB must exist for config/usage plumbing.
      const { openWorkspaceDb } = require('../server/workspaceDb');
      openWorkspaceDb(1);

      // Turn 1 — a question: planner only, answered from the census.
      modelMode = 'question';
      const q = await wpDesignChat.runWpDesignChat(
        1,
        linkId,
        { message: 'What builder is my site made with?' },
        { userType: 'owner' }
      );
      assert.ok(q.reply.includes('Gutenberg'), 'a question is answered from the census');
      n += 1;
      const chatAfterQ = await wpDesign.getChat(1, linkId);
      assert.equal(chatAfterQ.transcript.length, 2, 'the question turn persists');
      n += 1;

      // Turn 2 — an ambiguous request: the ONE clarification round.
      modelMode = 'clarify';
      const c1 = await wpDesignChat.runWpDesignChat(1, linkId, { message: 'Make it green' }, { userType: 'owner' });
      assert.ok(c1.reply.includes('?'), 'an ambiguous request gets the single clarification');
      n += 1;

      // Turn 3 — the owner answers. The stub planner STILL says
      // clarify, but the doctrine converts the turn to a change
      // with the settled facts: proposal staged + critic-verified.
      const c2 = await wpDesignChat.runWpDesignChat(1, linkId, { message: 'Deep forest green' }, { userType: 'owner' });
      assert.ok(c2.proposalId, 'after one clarification the turn proceeds to a staged proposal');
      n += 1;
      const stagedRow = await wpDesign.findProposal(1, linkId, c2.proposalId);
      assert.equal(stagedRow.status, 'staged', 'the proposal is staged, never applied by chat');
      n += 1;
      const verify = JSON.parse(stagedRow.verify_json || 'null');
      assert.ok(verify && verify.checked && verify.ok === true, 'the critic verified the staged preview');
      n += 1;
      assert.ok(c2.reply.includes('nothing is live yet'), 'the reply states approve-first plainly');
      n += 1;

      // Turn 4 — the model invents a raw-CSS op next to a valid
      // one: the valid op stages, the invention is dropped WITH
      // disclosure and never reaches the proposal.
      modelMode = 'change-invalid';
      const ci = await wpDesignChat.runWpDesignChat(
        1,
        linkId,
        { message: 'Change the primary color and hide the body' },
        { userType: 'owner' }
      );
      assert.ok(ci.proposalId, 'the valid op still stages');
      n += 1;
      assert.ok(ci.reply.includes('left out'), 'the refused op is disclosed in the reply');
      n += 1;
      const ciRow = await wpDesign.findProposal(1, linkId, ci.proposalId);
      assert.ok(!ciRow.ops_json.includes('raw_css'), 'the raw-css op never reaches the staged proposal');
      n += 1;

      // Turn 5 — the model is down: graceful failure, nothing
      // staged, no transcript written.
      modelMode = 'fail';
      const proposalsBeforeFail = (await wpDesign.listProposals(1, linkId)).length;
      const chatBeforeFail = (await wpDesign.getChat(1, linkId)).transcript.length;
      const f = await wpDesignChat.runWpDesignChat(
        1,
        linkId,
        { message: 'Change the color again' },
        { userType: 'owner' }
      );
      assert.equal(f.error, true, 'a model failure is reported as an error turn');
      assert.equal(f.reply, wpDesignChat.MODEL_FAIL_TEXT, 'model failure uses the graceful text');
      n += 2;
      assert.equal(
        (await wpDesign.listProposals(1, linkId)).length,
        proposalsBeforeFail,
        'a failed turn stages nothing'
      );
      n += 1;
      assert.equal(
        (await wpDesign.getChat(1, linkId)).transcript.length,
        chatBeforeFail,
        'a failed turn writes no transcript'
      );
      n += 1;

      // Turn 6 — the Free plan's 5/day cap is now spent: the turn
      // is refused BEFORE any model call, and is not counted.
      modelMode = 'question';
      const capped = await wpDesignChat.runWpDesignChat(
        1,
        linkId,
        { message: 'One more question' },
        { userType: 'owner' }
      );
      assert.equal(capped.limited, true, 'the sixth turn of the day hits the plan cap');
      assert.ok(capped.reply.includes('used all 5'), 'the refusal names the cap honestly');
      n += 2;
    } finally {
      global.fetch = realFetch;
    }
    group('Part 3 — chat turns with a stubbed model', n);
  }

  // ---------------------------------------------------------------
  // Part 4 — HTTP over the real plugin router
  // ---------------------------------------------------------------
  if (process.env.B117_SKIP_HTTP !== '1') {
    let n = 0;
    const express = require('express');
    const http = require('node:http');
    const wordpressPublic = require('../server/routes/wordpressPublic');
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use('/api/v1/wordpress', wordpressPublic);
    const srv = await new Promise((resolve) => {
      const s = http.createServer(app);
      s.listen(0, '127.0.0.1', () => resolve(s));
    });
    const base = `http://127.0.0.1:${srv.address().port}/api/v1/wordpress`;
    const call = async (method, p, { key, body } = {}) => {
      const res = await fetch(base + p, {
        method,
        headers: { 'Content-Type': 'application/json', ...(key ? { 'X-Bitpype-Site-Key': key } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, json: await res.json().catch(() => null) };
    };
    try {
      // Fresh v2 + v1 registrations over the wire.
      const dl = await wpPlugin.mintDownload(1, 42);
      const reg = await call('POST', '/register', {
        body: {
          token: dl.token,
          site_url: 'https://wire.fixture.test',
          site_name: 'Wire',
          admin_email: 'w@fixture.test',
          plugin_version: '2.0.0',
          capabilities: ['forms', 'design1'],
        },
      });
      assert.equal(reg.status, 200, 'wire registration succeeds');
      n += 1;
      const wireKey = reg.json.data.site_key;
      const wireLinkId = reg.json.data.link_id;
      const dlV1 = await wpPlugin.mintDownload(1, 42);
      const regV1 = await call('POST', '/register', {
        body: {
          token: dlV1.token,
          site_url: 'https://wire-old.fixture.test',
          site_name: 'Wire Old',
          admin_email: 'o@fixture.test',
        },
      });
      const v1Key = regV1.json.data.site_key;

      const censusRes = await call('POST', '/design/census', {
        key: wireKey,
        body: { census: CENSUS, plugin_version: '2.0.0', capabilities: ['forms', 'design1'] },
      });
      assert.equal(censusRes.status, 200, 'census accepted over the wire');
      n += 1;
      const v1Census = await call('POST', '/design/census', { key: v1Key, body: { census: CENSUS } });
      assert.equal(v1Census.status, 409, 'a v1 plugin is refused at the design endpoints');
      assert.equal(v1Census.json.code, 'UPDATE_REQUIRED', 'with the update-required code');
      n += 2;
      const noKey = await call('GET', '/design/sync', {});
      assert.equal(noKey.status, 401, 'design endpoints refuse anonymous calls');
      n += 1;

      const wireLink = await wpPlugin.findById(1, wireLinkId);
      const staged = await wpDesign.stageProposal(wireLink, {
        opsList: [{ type: 'set_token', token: 'primary_color', value: '#112233' }],
        tokens: { primary_color: '#112233' },
        zones: {},
        summary: 'Wire proposal',
        verify: null,
      });
      const token = staged.previewUrl.split('bitpype_preview=')[1];
      const pvOk = await call('GET', `/design/preview?token=${encodeURIComponent(token)}`, { key: wireKey });
      assert.equal(pvOk.status, 200, 'preview validates over the wire');
      assert.equal(pvOk.json.data.tokens.primary_color, '#112233', 'preview returns the staged state');
      n += 2;
      const pvBad = await call('GET', `/design/preview?token=${encodeURIComponent(token)}`, { key: v1Key });
      assert.notEqual(pvBad.status, 200, 'another site credential cannot read this preview');
      n += 1;

      await wpDesign.decideProposal(1, wireLinkId, staged.id, 'approve');
      const sync = await call('GET', '/design/sync', { key: wireKey });
      assert.equal(sync.json.data.apply.length, 1, 'sync delivers the approved proposal');
      n += 1;
      const rep = await call('POST', '/design/report', {
        key: wireKey,
        body: { results: [{ proposal_id: staged.id, action: 'apply', ok: true, snapshot_version: 3 }] },
      });
      assert.equal(rep.json.data.results[0].status, 'applied', 'the apply report lands over the wire');
      n += 1;

      // Revoke fails closed on the design endpoints too.
      await wpPlugin.revokeDownload(1, wireLinkId);
      const afterRevoke = await call('GET', '/design/sync', { key: wireKey });
      assert.equal(afterRevoke.status, 410, 'a revoked site is refused fail-closed');
      n += 1;
    } finally {
      await new Promise((r) => srv.close(r));
    }
    group('Part 4 — HTTP plugin design endpoints', n);
  }

  console.log(`BATCH117: ALL PASS — ${groups.join(' · ')}`);
})().catch((e) => {
  console.error('BATCH117 FAILED:', e && e.stack ? e.stack : e);
  process.exit(1);
});
