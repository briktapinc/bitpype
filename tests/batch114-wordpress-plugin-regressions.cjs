'use strict';
/**
 * Batch 114 — WORDPRESS CONNECTOR PLUGIN (Ely's order 2026-11-01).
 *
 * The FREE, unlicensed plugin that plugs BitPype into an existing
 * WordPress site, distributed as a download in the client portal.
 * Every download is generated per click and carries a unique
 * registration code in its config file that works like a
 * REGISTRATION LINK: it connects exactly ONE WordPress site to the
 * downloading workspace, then it is spent. Registration derives a
 * scoped site credential (fetch this workspace's form list + report
 * lifecycle status — nothing else); submissions never use it, they
 * post to the existing public form endpoints via form-embed.js.
 *
 * Part 1 — source pins: portal tab + routes + panel copy (incl. the
 *   honest lifecycle lines), the PHP plugin's hooks/escaping shape,
 *   NO license machinery anywhere, SEC-13 census byte-identical.
 * Part 2 — functional (in-process, dialect-aware): schema parity
 *   for wp_site_links, mint → zip determinism (two downloads differ
 *   ONLY on the config lines) → register → second-site refusal
 *   (TOKEN_SPENT) → deactivate/reactivate on the SAME registration
 *   → workspace isolation → revoke fails closed → a fresh download
 *   registers a second site.
 * Part 3 — HTTP (bare express mount of the real routers): the full
 *   plugin lifecycle over the wire + submission attribution (a WP
 *   embed's LeadScout event carries the WP page URL; a hosted embed
 *   without a source keeps the old page slug).
 *
 * NEGATIVE PROOF: B114_NEGATIVE=double-register asserts the second
 * registration with the same code SUCCEEDS — it must go RED, proving
 * the one-link-one-site assertions bite.
 * B114_SKIP_HTTP=1 skips Part 3 locally; the gate runs it.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const NEGATIVE = process.env.B114_NEGATIVE || '';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b114-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch114', 'test', 'session', 'secret'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY = process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 41).toString('base64');

const groups = [];
function group(name, n) {
  groups.push(`${name} (${n})`);
  console.log(`  ok ${name} — ${n} checks`);
}

// Minimal stored-zip reader for the determinism proof.
function unzipStore(buf) {
  const entries = new Map();
  let off = 0;
  while (off + 30 <= buf.length && buf.readUInt32LE(off) === 0x04034b50) {
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    const size = buf.readUInt32LE(off + 18);
    const name = buf.toString('utf8', off + 30, off + 30 + nameLen);
    const dataStart = off + 30 + nameLen + extraLen;
    entries.set(name, buf.subarray(dataStart, dataStart + size));
    off = dataStart + size;
  }
  return entries;
}

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

    // Portal tab + routes + guard wiring.
    const portalTabs = read('server/portalTabs.js');
    has(portalTabs, "'wordpress',", 'wordpress is a portal tab');
    has(portalTabs, "wordpress: 'WordPress',", 'wordpress tab label');
    const portalRoutes = read('server/routes/portal.js');
    has(portalRoutes, "['/wordpress', 'wordpress'],", 'route→tab guard mapping');
    has(portalRoutes, "router.get('/wordpress', requireClient", 'portal wordpress list route');
    has(portalRoutes, "router.get('/wordpress/download', requireClient", 'portal wordpress download route');
    has(portalRoutes, "router.post('/wordpress/:id/revoke', requireClient", 'portal wordpress revoke route');
    has(
      portalRoutes,
      'mintDownload(req.client.workspace_id, req.client.id)',
      'download mints per click, bound to workspace + user'
    );
    has(portalRoutes, 'buildPluginZip', 'download renders a fresh zip per click');

    // Public plugin API.
    const serverJs = read('server.js');
    has(serverJs, "app.use('/api/v1/wordpress', wordpressPublicRoutes)", 'plugin API mounted');
    const wpRoutes = read('server/routes/wordpressPublic.js');
    has(wpRoutes, "router.post('/register', registerLimit", 'register endpoint is rate-limited');
    has(wpRoutes, "router.get('/forms', siteLimit, requireSiteKey", 'forms endpoint needs the site credential');
    has(wpRoutes, "router.post('/ping', siteLimit, requireSiteKey", 'ping endpoint needs the site credential');
    has(
      wpRoutes,
      "router.post('/disconnect', siteLimit, requireSiteKey",
      'disconnect endpoint needs the site credential'
    );

    // Core module shape: token classes stay separate, nothing derives
    // from the workspace bearer token.
    const wp = read('server/wpPlugin.js');
    has(wp, "const TOKEN_PREFIX = 'bpreg_';", 'registration codes carry their own prefix');
    has(wp, "const SITE_KEY_PREFIX = 'bpsk_';", 'site credentials carry a distinct prefix');
    has(wp, 'TOKEN_SPENT', 'spent-link refusal exists');
    has(wp, 'wp_site_links', 'registrations live in the platform table');
    assert.ok(!wp.includes('workspace_tokens'), 'wpPlugin never touches workspace bearer tokens');
    n += 1;
    assert.ok(!wp.includes('createWorkspaceToken'), 'wpPlugin never mints workspace tokens');
    n += 1;

    // The production image must carry the plugin sources (the
    // download endpoint reads them at request time).
    const dockerfile = read('Dockerfile');
    has(dockerfile, 'COPY integrations ./integrations', 'Dockerfile copies the plugin sources into the image');

    // Portal panel: nav, section, instructions, honest lifecycle copy.
    const portalHtml = read('public/portal.html');
    has(portalHtml, 'id="nav-wordpress" data-panel="wordpress"', 'wordpress nav button');
    has(portalHtml, 'id="sec-wordpress"', 'wordpress section');
    has(portalHtml, '/api/v1/portal/wordpress/download', 'download button href');
    has(portalHtml, 'like a registration link', 'instructions explain the per-download code');
    has(portalHtml, 'Contacts stay put', 'panel states captured contacts remain after removal');
    has(portalHtml, 'remove the <code>[bitpype_form]</code> shortcodes', 'panel carries the uninstall shortcode line');
    has(
      portalHtml,
      '/js/portal.js?v=batch139-pricing1',
      'portal.js cache-busted (Batch 117 rotation; string follows the newest rotation — Batch 131)'
    );
    const portalJs = read('public/js/portal.js');
    has(portalJs, "'wordpress',", 'portal.js panel list includes wordpress');
    has(portalJs, 'loadWordpressPanel', 'portal.js has the wordpress loader');
    has(portalJs, 'renderWpDownloads', 'portal.js renders registrations');
    const wpLoaderSrc = portalJs.slice(
      portalJs.indexOf('// Batch 114 — WordPress panel'),
      portalJs.indexOf('const mcpEndpoint')
    );
    assert.ok(!wpLoaderSrc.includes('.innerHTML'), 'wordpress loader builds DOM without innerHTML sinks');
    n += 1;

    // The PHP plugin: hooks, escaping, lifecycle, NO license machinery.
    const pluginDir = path.join(root, 'integrations', 'wordpress', 'bitpype-connector');
    const main = read('integrations/wordpress/bitpype-connector/bitpype-connector.php');
    has(main, 'register_activation_hook', 'activation hook registered');
    has(main, 'register_deactivation_hook', 'deactivation hook registered');
    has(main, "bitpype_connector_disconnect('deactivated')", 'deactivation pings BitPype (portal shows Disconnected)');
    const api = read('integrations/wordpress/bitpype-connector/includes/api.php');
    has(api, 'function bitpype_connector_register()', 'plugin can register');
    has(api, 'X-Bitpype-Site-Key', 'plugin sends the scoped site credential');
    const render = read('integrations/wordpress/bitpype-connector/includes/render.php');
    has(render, "add_shortcode('bitpype_form'", 'shortcode registered');
    has(render, 'data-bitpype-source', 'embed carries the WP page URL for attribution');
    has(render, "esc_attr($form['token'])", 'embed token escaped at output');
    has(render, "'connected' !== bitpype_connector_status()", 'rendering fails closed when not connected');
    const admin = read('integrations/wordpress/bitpype-connector/includes/admin.php');
    has(
      admin,
      'already connected a WordPress site. Each download connects one site',
      'TOKEN_SPENT guidance text (portal download direction)'
    );
    has(admin, 'disconnected in your BitPype portal', 'revoked guidance text');
    has(admin, 'wp_verify_nonce', 'admin actions are nonce-checked');
    has(admin, "current_user_can('manage_options')", 'admin actions are capability-gated');
    const uninstall = read('integrations/wordpress/bitpype-connector/uninstall.php');
    has(uninstall, 'WP_UNINSTALL_PLUGIN', 'uninstall handler guarded');
    has(uninstall, 'delete_option($bitpype_option)', 'uninstall wipes the plugin options (clean exit)');
    has(uninstall, "'uninstalled'", 'uninstall says goodbye so the portal shows Disconnected');
    const config = read('integrations/wordpress/bitpype-connector/bitpype-config.php');
    has(config, '%%BITPYPE_REGISTRATION_TOKEN%%', 'config template carries the token placeholder');
    has(config, '%%BITPYPE_APP_URL%%', 'config template carries the app-url placeholder');
    const allPhp = [main, api, render, admin, uninstall, config].join('\n');
    assert.ok(
      !/license_key|activate_license|license server/i.test(allPhp),
      'NO license machinery in the plugin (Ely: free, unlicensed)'
    );
    n += 1;
    assert.ok(!/eval\s*\(|create_function/.test(allPhp), 'no eval-class constructs in the plugin');
    n += 1;
    // PHP lint when a PHP binary is available (the WP end-to-end proof
    // exercises the code for real either way).
    let phpBin = null;
    try {
      phpBin = execFileSync('which', ['php'], { encoding: 'utf8' }).trim();
    } catch {
      phpBin = null;
    }
    if (phpBin) {
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

    // SEC-13 census: identical to the Batch 112/113 pins — the new
    // portal.js code and form-embed.js attribution add no sinks.
    const { census } = require(path.join(root, 'scripts', 'xss-census.cjs'));
    const cz = census();
    assert.deepEqual(
      cz.summary,
      { total: 448, STATIC: 162, ESCAPED: 41, SAFE: 73, BUILDER: 59, IDENT: 36, RAW: 77 },
      'SEC-13 census summary unchanged'
    );
    n += 1;
    const multiset = cz.sinks.map((s) => `${s.file}|${s.kind}|${s.snippet}`).sort();
    const sha = crypto.createHash('sha256').update(multiset.join('\n')).digest('hex');
    assert.equal(
      sha,
      'a3fdd0d2828bda5f285652714975ba4010db4c1cc0eeadf2c89ddd071bc40040',
      'SEC-13 sink multiset byte-identical (Batch 136 finisher: +2 audited STATIC sinks in module-embed.js; RAW/IDENT multiset unchanged)'
    );
    n += 1;

    // Attribution plumbing pins.
    const formEmbed = read('public/js/form-embed.js');
    has(formEmbed, 'data-bitpype-source', 'form-embed reads the source attribute');
    has(formEmbed, 'source: source || undefined', 'form-embed submits the source when present');
    const formsPublic = read('server/routes/formsPublic.js');
    has(formsPublic, 'sourceLabel', 'public submit route accepts the attribution label');
    const contactForms = read('server/contactForms.js');
    has(contactForms, "const FORM_SCRIPT_VER = 'form10'", 'embed script version bumped for the attribution change');

    group('Part 1 — source pins + census + php lint', n);
  }

  // ---------------------------------------------------------------
  // Part 2 — functional (module level, both dialects)
  // ---------------------------------------------------------------
  const platformDb = require('../server/db');
  await platformDb.migrate();
  const { platformColumns } = require('./lib/platformTestDb.cjs');
  {
    let n = 0;
    const cols = await platformColumns(platformDb, 'wp_site_links');
    assert.deepEqual(
      cols,
      [
        'id',
        'workspace_id',
        'portal_user_id',
        'token_hash',
        'token_prefix',
        'status',
        'site_url',
        'site_name',
        'admin_email',
        'site_key_hash',
        'site_key_prefix',
        'disconnect_reason',
        'plugin_version',
        'plugin_caps',
        'census_json',
        'census_at',
        'created_at',
        'registered_at',
        'last_seen_at',
        'revoked_at',
      ],
      'wp_site_links columns (ordered, dialect-identical)'
    );
    n += 1;

    // Fixture workspaces + leads + published forms.
    await platformDb.query("INSERT INTO workspaces (id, name, slug) VALUES (1, 'B114 Fixture One', 'b114-one')");
    await platformDb.query("INSERT INTO workspaces (id, name, slug) VALUES (2, 'B114 Fixture Two', 'b114-two')");
    const { openWorkspaceDb } = require('../server/workspaceDb');
    const contactForms = require('../server/contactForms');
    const seedForm = (wsId, leadId, name) => {
      const wdb = openWorkspaceDb(wsId);
      wdb
        .prepare('INSERT INTO leads (id, business_name, email, status) VALUES (?, ?, ?, ?)')
        .run(leadId, name + ' Co', 'owner@fixture.test', 'new');
      const form = contactForms.createForm(wdb, leadId, {
        name,
        fields: [
          { field_key: 'name', label: 'Name', field_type: 'text', required: 1 },
          { field_key: 'email', label: 'Email', field_type: 'email', required: 1 },
          { field_key: 'message', label: 'Message', field_type: 'textarea', required: 1 },
        ],
      });
      contactForms.publishForm(wdb, leadId, form.id, { workspaceId: wsId });
      return contactForms.getFormById(wdb, leadId, form.id);
    };
    const form1 = seedForm(1, 1, 'WP Contact');
    const form2 = seedForm(2, 1, 'Other WS Form');
    assert.ok(form1.public_token && form2.public_token, 'fixture forms published with public tokens');
    n += 1;

    const wpPlugin = require('../server/wpPlugin');

    // Mint + zip determinism.
    const dl1 = await wpPlugin.mintDownload(1, 42);
    const dl2 = await wpPlugin.mintDownload(1, 42);
    assert.match(dl1.token, /^bpreg_[A-Za-z0-9_-]{32,}$/, 'registration code shape');
    assert.notEqual(dl1.token, dl2.token, 'every download mints a fresh code');
    n += 2;
    const zip1 = wpPlugin.buildPluginZip({ token: dl1.token, appUrl: 'https://bitpype.test' });
    const zip2 = wpPlugin.buildPluginZip({ token: dl2.token, appUrl: 'https://bitpype.test' });
    assert.ok(!zip1.equals(zip2), 'two downloads produce byte-different zips');
    n += 1;
    const entries1 = unzipStore(zip1);
    const entries2 = unzipStore(zip2);
    assert.deepEqual([...entries1.keys()].sort(), [...entries2.keys()].sort(), 'zip entry lists identical');
    n += 1;
    let differingEntries = 0;
    for (const [name, data] of entries1) {
      const other = entries2.get(name);
      if (!data.equals(other)) {
        differingEntries += 1;
        assert.equal(name, 'bitpype-connector/bitpype-config.php', 'only the config file may differ between downloads');
        const lines1 = data.toString('utf8').split('\n');
        const lines2 = other.toString('utf8').split('\n');
        assert.equal(lines1.length, lines2.length, 'config line count identical');
        for (let i = 0; i < lines1.length; i++) {
          if (lines1[i] !== lines2[i]) {
            assert.ok(
              lines1[i].includes('BITPYPE_REGISTRATION_TOKEN'),
              'differing config lines are the token define only'
            );
          }
        }
        assert.ok(data.toString('utf8').includes(dl1.token), 'zip 1 config carries download 1 code');
        assert.ok(other.toString('utf8').includes(dl2.token), 'zip 2 config carries download 2 code');
      }
    }
    assert.equal(differingEntries, 1, 'exactly one zip entry differs between two downloads');
    n += 5;

    // Register → bind → lifecycle.
    const reg = await wpPlugin.registerSite({
      token: dl1.token,
      siteUrl: 'https://wp-one.example.test/',
      siteName: 'WP One',
      adminEmail: 'admin@wp-one.example.test',
    });
    assert.match(reg.siteKey, /^bpsk_[A-Za-z0-9_-]{32,}$/, 'site credential shape');
    assert.equal(reg.siteUrl, 'https://wp-one.example.test', 'site URL normalized (trailing slash dropped)');
    n += 2;

    // One link, one site: a second registration (any site) is refused.
    let spentErr = null;
    try {
      await wpPlugin.registerSite({
        token: dl1.token,
        siteUrl: 'https://other.example.test',
        siteName: 'Other',
        adminEmail: '',
      });
    } catch (e) {
      spentErr = e;
    }
    if (NEGATIVE === 'double-register') {
      assert.equal(spentErr, null, 'NEGATIVE MODE: second registration wrongly allowed');
    } else {
      assert.ok(
        spentErr && spentErr.code === 'TOKEN_SPENT' && spentErr.status === 409,
        'second registration refused as TOKEN_SPENT'
      );
    }
    n += 1;

    // The registration code is NOT a credential, and the site key is
    // scoped to its own workspace's forms.
    let badAuth = null;
    try {
      await wpPlugin.requireSite(dl1.token);
    } catch (e) {
      badAuth = e;
    }
    assert.ok(badAuth && badAuth.code === 'INVALID_SITE_KEY', 'registration code cannot act as a site credential');
    n += 1;
    const siteRow = await wpPlugin.requireSite(reg.siteKey);
    const forms = await wpPlugin.siteForms(siteRow);
    assert.equal(forms.forms.length, 1, 'site sees exactly its own workspace forms');
    assert.equal(forms.forms[0].token, form1.public_token, 'form list carries the public embed token');
    assert.equal(forms.forms[0].shortcode, `[bitpype_form id="${form1.id}"]`, 'form list carries the shortcode');
    n += 3;

    // Deactivate → disconnected (same registration) → status ping does
    // NOT reconnect → reactivate (active ping) reconnects the SAME row.
    const viewOf = async () => (await wpPlugin.listDownloads(1)).find((d) => d.id === reg.linkId);
    await wpPlugin.pingSite(siteRow, 'deactivated');
    let view = await viewOf();
    assert.equal(view.status, 'disconnected', 'portal shows DISCONNECTED after deactivation');
    assert.equal(view.disconnectReason, 'deactivated', 'disconnect reason recorded');
    n += 2;
    await wpPlugin.pingSite(siteRow, 'status');
    view = await viewOf();
    assert.equal(view.status, 'disconnected', 'a status ping never reconnects a disconnected site');
    n += 1;
    // Deactivate-then-delete (the normal WP flow): the uninstall
    // signal still updates the recorded reason without resurrecting
    // the connection — via the ping path here…
    await wpPlugin.pingSite(siteRow, 'uninstalled');
    view = await viewOf();
    assert.equal(view.status, 'disconnected', 'uninstall after deactivation keeps the site disconnected');
    assert.equal(view.disconnectReason, 'uninstalled', 'uninstall reason recorded over the deactivation');
    n += 2;
    await wpPlugin.pingSite(siteRow, 'active');
    view = await viewOf();
    assert.equal(view.status, 'connected', 'reactivation reconnects the SAME registration');
    n += 1;

    // Revoke fails closed; a fresh download registers a second site.
    await wpPlugin.revokeDownload(1, reg.linkId);
    let revokedErr = null;
    try {
      await wpPlugin.requireSite(reg.siteKey);
    } catch (e) {
      revokedErr = e;
    }
    assert.ok(
      revokedErr && revokedErr.code === 'SITE_REVOKED' && revokedErr.status === 410,
      'revoked site credential fails closed'
    );
    n += 1;
    const reg2 = await wpPlugin.registerSite({
      token: dl2.token,
      siteUrl: 'https://wp-two.example.test',
      siteName: 'WP Two',
      adminEmail: '',
    });
    assert.ok(
      reg2.linkId !== reg.linkId && reg2.siteKey !== reg.siteKey,
      'a fresh download registers a second site independently'
    );
    n += 1;
    // …and the uninstall-reason rule via the disconnect path, on
    // the second registration: deactivated by ping first, then the
    // uninstall goodbye records the stronger reason.
    const siteRow2 = await wpPlugin.requireSite(reg2.siteKey);
    await wpPlugin.pingSite(siteRow2, 'deactivated');
    await wpPlugin.disconnectSite(siteRow2, 'uninstalled');
    const view2 = (await wpPlugin.listDownloads(1)).find((d) => d.id === reg2.linkId);
    assert.equal(view2.status, 'disconnected', 'second site stays disconnected through its uninstall goodbye');
    assert.equal(
      view2.disconnectReason,
      'uninstalled',
      'disconnect endpoint records the uninstall reason over a deactivation'
    );
    n += 2;
    let revokedLinkErr = null;
    try {
      await wpPlugin.registerSite({
        token: dl1.token,
        siteUrl: 'https://x.example.test',
        siteName: '',
        adminEmail: '',
      });
    } catch (e) {
      revokedLinkErr = e;
    }
    assert.ok(revokedLinkErr && revokedLinkErr.code === 'LINK_REVOKED', 'a revoked download link can never register');
    n += 1;

    group('Part 2 — registration lifecycle + zip determinism + isolation', n);
  }

  // ---------------------------------------------------------------
  // Part 3 — HTTP over the real routers
  // ---------------------------------------------------------------
  if (process.env.B114_SKIP_HTTP !== '1') {
    let n = 0;
    const express = require('express');
    const wpPlugin = require('../server/wpPlugin');
    const app = express();
    app.use(express.json());
    app.use('/api/v1/wordpress', require('../server/routes/wordpressPublic'));
    app.use('/api/v1/forms/public', require('../server/routes/formsPublic'));
    const server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, p, { key, body } = {}) => {
      const res = await fetch(base + p, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(key ? { 'X-Bitpype-Site-Key': key } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, json: await res.json().catch(() => null) };
    };
    try {
      const dl = await wpPlugin.mintDownload(2, 7);
      const regRes = await call('POST', '/api/v1/wordpress/register', {
        body: {
          token: dl.token,
          site_url: 'https://site-two.example.test/',
          site_name: 'Site Two',
          admin_email: 'a@b.test',
        },
      });
      assert.equal(regRes.status, 200, 'HTTP register succeeds');
      const siteKey = regRes.json.data.site_key;
      assert.ok(siteKey, 'HTTP register returns the site key');
      n += 2;

      const again = await call('POST', '/api/v1/wordpress/register', {
        body: { token: dl.token, site_url: 'https://evil.example.test', site_name: 'Evil', admin_email: '' },
      });
      assert.equal(again.status, 409, 'HTTP second registration → 409');
      assert.equal(again.json.code, 'TOKEN_SPENT', 'HTTP second registration → TOKEN_SPENT');
      n += 2;

      const noKey = await call('GET', '/api/v1/wordpress/forms');
      assert.equal(noKey.status, 401, 'forms without a site key → 401');
      n += 1;
      const formsRes = await call('GET', '/api/v1/wordpress/forms', { key: siteKey });
      assert.equal(formsRes.status, 200, 'forms with the site key → 200');
      assert.equal(formsRes.json.data.forms.length, 1, 'HTTP forms list has the workspace form');
      const formToken = formsRes.json.data.forms[0].token;
      n += 2;

      const deact = await call('POST', '/api/v1/wordpress/ping', { key: siteKey, body: { state: 'deactivated' } });
      assert.equal(deact.json.data.status, 'disconnected', 'HTTP deactivation → disconnected');
      const formsWhileDown = await call('GET', '/api/v1/wordpress/forms', { key: siteKey });
      assert.equal(formsWhileDown.status, 409, 'forms while disconnected → 409 SITE_DISCONNECTED');
      assert.equal(formsWhileDown.json.code, 'SITE_DISCONNECTED');
      n += 3;
      const react = await call('POST', '/api/v1/wordpress/ping', { key: siteKey, body: { state: 'active' } });
      assert.equal(react.json.data.status, 'connected', 'HTTP reactivation → connected (same registration)');
      n += 1;

      // Attribution: a submit carrying the WP page URL labels the
      // LeadScout event with it; one without keeps the empty slug.
      const { openWorkspaceDb } = require('../server/workspaceDb');
      const submit = (source) =>
        call('POST', `/api/v1/forms/public/${encodeURIComponent(formToken)}/submit`, {
          body: {
            values: {
              name: 'Pat Visitor',
              email: `pat-${Math.random().toString(36).slice(2, 8)}@example.test`,
              message: 'Hello',
            },
            ...(source ? { source } : {}),
          },
        });
      const sub1 = await submit('https://site-two.example.test/contact-us');
      assert.equal(sub1.status, 200, 'WP-attributed submit accepted');
      const sub2 = await submit(null);
      assert.equal(sub2.status, 200, 'plain submit accepted');
      const wdb = openWorkspaceDb(2);
      const events = wdb
        .prepare("SELECT page_slug FROM leadscout_events WHERE kind = 'submission' ORDER BY id ASC")
        .all()
        .map((r) => r.page_slug);
      assert.ok(events.includes('https://site-two.example.test/contact-us'), 'LeadScout event carries the WP page URL');
      assert.ok(events.includes('contact'), 'hosted-style event keeps its original page slug (the form target page)');
      n += 4;

      // Revoke over the module → the plugin's next call fails closed.
      const list = await wpPlugin.listDownloads(2);
      const linkId = list.find((d) => d.status === 'connected').id;
      await wpPlugin.revokeDownload(2, linkId);
      const afterRevoke = await call('GET', '/api/v1/wordpress/forms', { key: siteKey });
      assert.equal(afterRevoke.status, 410, 'after portal revoke, the next plugin call → 410');
      assert.equal(afterRevoke.json.code, 'SITE_REVOKED', 'after portal revoke → SITE_REVOKED');
      n += 2;
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    group('Part 3 — HTTP lifecycle + submission attribution', n);
  }

  console.log(`\nBATCH114 REGRESSIONS: ALL PASS — ${groups.length} groups`);
})().catch((e) => {
  console.error('BATCH114 REGRESSIONS FAILED:', e && e.stack ? e.stack : e);
  process.exit(1);
});
