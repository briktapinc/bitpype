'use strict';
/**
 * Batch 103 — licensee-readiness + small security items.
 * Fix log: ~/workspace/website-scout/security-fix-log-2026-10-31.md
 *
 *   SEC-07 per-token /mcp rate limits (general + AI buckets, DB store)
 *   SEC-08 MCP dispatch audit log (90-day retention, Admin-visible)
 *   SEC-09 vendor design-agent token class (allow/deny at dispatch)
 *   SEC-13 innerHTML census + lint pin (one proven sink fixed)
 *   SEC-15 mcpHttp.js env-guard default-off
 *   SEC-21 auth-event logging (staff/portal logins, MFA, MCP 401s)
 *   SEC-22 body-parser CVE bump (lockfile >= 1.20.9) + moderates
 *   SEC-23 email-asset magic check is fail-closed (no claimed mime)
 *   SEC-24 urlLooksHealthyOnce routes through urlSafety.fetchPublic
 *
 * Negative mode (B103_NEGATIVE=1): the vendor matrix is checked
 * against an allow-all shim — the deny assertions MUST fail (RED),
 * proving the gate assertions bite.
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b103-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch103', 'test', 'session', 'secret'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY =
  process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 29).toString('base64');

const NEGATIVE = process.env.B103_NEGATIVE === '1';
const groups = [];
function group(name, n) {
  groups.push([name, n]);
  console.log(`  ok ${name} (${n})`);
}

(async () => {
  let n = 0;

  // ---------- schema + token class (SEC-09 storage) ----------
  await require('../server/db').migrate();
  const workspaceMod = require('../server/workspace');
  const u = await workspaceMod.createUserWithWorkspace({
    email: 'b103-owner@example.test',
    password: 'b103-fixture-password',
    workspaceName: 'B103 Fixture WS',
  });
  const wsId = u.workspaceId;
  assert.ok(wsId, 'fixture workspace created');
  const vendor = await workspaceMod.createWorkspaceToken(wsId, 'vendor-fixture', { tokenClass: 'vendor_design' });
  assert.equal(vendor.tokenClass, 'vendor_design');
  const std = await workspaceMod.createWorkspaceToken(wsId, 'std-fixture');
  assert.equal(std.tokenClass, 'standard', 'default class is standard');
  await assert.rejects(
    () => workspaceMod.createWorkspaceToken(wsId, 'bad', { tokenClass: 'superuser' }),
    /token class/
  );
  const foundVendor = await workspaceMod.findWorkspaceByToken(vendor.token);
  assert.equal(foundVendor.token_class, 'vendor_design', 'lookup surfaces token_class');
  const dbSrc = read('server/db.js');
  assert.ok((dbSrc.match(/token_class/g) || []).length >= 2, 'token_class ensured in both dialects');
  n += 6;
  group('SEC-09 token class storage', n);

  // ---------- vendor allow/deny matrix (SEC-09 policy) ----------
  n = 0;
  const vendorTools = require('../server/vendorTools');
  const allowedFn = NEGATIVE ? () => true : vendorTools.vendorToolAllowed;
  const MUST_ALLOW = [
    'design.deliver', 'design.list', 'website.edit', 'modules.attach', 'forms.create',
    'blog.publish', 'datatables.rows', 'charts.create', 'lead.search', 'lead.get',
    'domains.check', 'domains.list', 'cloudflare.test', 'settings.get', 'prompts.list',
    'activity.recent', 'ai.usage', 'bookings.services', 'gallery.add', 'faq.save',
  ];
  const MUST_DENY = [
    'domains.register', 'cloudflare.publish', 'settings.set', 'prompts.save', 'sms.queue',
    'lead.bulk', 'lead.importCsv', 'lead.delete', 'lead.create', 'lead.update',
    'website.delete', 'design.delete', 'datatables.clear', 'members.grantComp',
    'domains.link', 'domains.unlink', 'billing.checkout', 'billing.plans',
    'calls.poolAdd', 'calls.buy', 'automation.run', 'handsOff.toggle', 'email.send',
    'outreach.send', 'jobs.run', 'members.list', 'social.post', 'unknown.tool',
  ];
  for (const t of MUST_ALLOW) assert.equal(allowedFn(t), true, `vendor may ${t}`);
  for (const t of MUST_DENY) assert.equal(allowedFn(t), false, `vendor must NOT ${t}`);
  n += MUST_ALLOW.length + MUST_DENY.length;
  group('SEC-09 vendor allow/deny matrix', n);

  // ---------- dispatch-level enforcement (SEC-09) ----------
  n = 0;
  const mcp = require('../server/mcp');
  const vctx = { tokenClass: 'vendor_design', tokenPrefix: vendor.prefix };
  const okRes = await mcp.callTool(wsId, 'settings.get', {}, vctx);
  assert.equal(okRes.ok, true, 'vendor token can do allowed design-plane work (settings.get)');
  for (const t of ['domains.register', 'billing.plans', 'settings.set', 'calls.poolAdd', 'lead.create']) {
    const r = await mcp.callTool(wsId, t, {}, vctx);
    assert.equal(r.ok, false, `${t} refused for vendor token`);
    assert.equal(r.error, 'VENDOR_TOKEN_FORBIDDEN', `${t} refusal code`);
  }
  const stdRes = await mcp.callTool(wsId, 'settings.get', {}, { tokenClass: 'standard' });
  assert.equal(stdRes.ok, true, 'standard token unaffected');
  const mcpSrc = read('server/mcp.js');
  const callAt = mcpSrc.indexOf('async function callTool');
  const gateAt = mcpSrc.indexOf('VENDOR_TOKEN_FORBIDDEN', callAt);
  const scopeAt = mcpSrc.indexOf('const clientNames = new Set(clientToolDefs()', callAt);
  assert.ok(callAt > 0 && gateAt > callAt && scopeAt > gateAt, 'vendor gate runs before client-scope handling');
  n += 13;
  group('SEC-09 dispatch enforcement', n);

  // ---------- audit + auth events (SEC-08 / SEC-21) ----------
  n = 0;
  const sev = require('../server/securityEvents');
  await sev.recordMcpCall({ workspaceId: wsId, tokenId: 1, tokenPrefix: 'ws_live_ab', tool: 'design.deliver', args: { id: 42, leadId: 7 }, ok: true });
  await sev.recordMcpCall({ workspaceId: wsId, tokenId: 1, tokenPrefix: 'ws_live_ab', tool: 'domains.register', args: { domain: 'x.test' }, ok: false, error: 'VENDOR_TOKEN_FORBIDDEN' });
  const audit = await sev.listMcpAudit({ workspaceId: wsId, limit: 10 });
  assert.equal(audit.length, 2, 'both dispatch rows listed');
  assert.equal(audit[0].tool, 'domains.register', 'newest first');
  assert.equal(audit[1].targets.id, 42, 'target ids extracted');
  assert.equal(audit[1].targets.leadId, 7);
  assert.equal(audit[0].ok, 0, 'failure recorded as not-ok');
  await sev.recordAuthEvent({ surface: 'staff', event: 'login_failure', email: 'a@b.test', ip: '203.0.113.9' });
  await sev.recordAuthEvent({ surface: 'staff', event: 'mfa_lockout', email: 'a@b.test', userId: 5, ip: '203.0.113.9' });
  await sev.recordAuthEvent({ surface: 'mcp', event: 'mcp_401', tokenPrefix: 'ws_live_zz', ip: '203.0.113.9' });
  const staffEvents = await sev.listAuthEvents({ surface: 'staff', limit: 10 });
  assert.equal(staffEvents.length, 2);
  assert.equal(staffEvents[0].event, 'mfa_lockout');
  const mcpEvents = await sev.listAuthEvents({ surface: 'mcp', limit: 10 });
  assert.equal(mcpEvents.length, 1);
  assert.ok(read('server/routes/admin.js').includes("'/mcp-audit'"), 'Admin audit route exists');
  assert.ok(read('server/routes/admin.js').includes("'/auth-events'"), 'Admin auth-events route exists');
  assert.ok(read('server/routes/auth.js').includes("event: 'login_failure'"), 'staff login failure hook');
  assert.ok(read('server/routes/auth.js').includes("'mfa_lockout'") && read('server/routes/auth.js').includes("'mfa_failure'"), 'MFA lockout/failure hook');
  assert.ok(read('server/routes/portal.js').includes("event: 'login_failure'"), 'portal login failure hook');
  assert.ok(read('server.js').includes("event: 'mcp_401'"), 'MCP 401 hook');
  n += 16;
  group('SEC-08/SEC-21 audit + auth events', n);

  // ---------- rate-limit core (SEC-07) ----------
  n = 0;
  const store = require('../server/rateLimitStore');
  const now = Date.now();
  let c = 0;
  for (let i = 0; i < 5; i++) c = await store.recordHit('mcp:general', 'tok103', 60000, now + i);
  assert.equal(c, 5, 'sliding-window count includes each hit');
  const other = await store.recordHit('mcp:ai', 'tok103', 60000, now);
  assert.equal(other, 1, 'AI bucket is independent');
  const later = await store.recordHit('mcp:general', 'tok103', 60000, now + 61000);
  assert.equal(later, 1, 'window slides');
  const serverSrc = read('server.js');
  assert.ok(serverSrc.includes("recordHit('mcp:general'") && serverSrc.includes('MCP_RL_GENERAL_MAX = 600'), 'general ceiling 600/min/token');
  assert.ok(serverSrc.includes("recordHit('mcp:ai'") && serverSrc.includes('MCP_RL_AI_MAX = 60'), 'AI bucket 60/min/token');
  assert.ok(serverSrc.includes('mcpIsAiTool'), 'AI classifier present');
  assert.ok(serverSrc.includes('RATE_LIMITED'), '429 surface present');
  n += 7;
  group('SEC-07 per-token MCP rate limits', n);

  // ---------- SEC-23: email assets fail closed ----------
  n = 0;
  const domain = require('../server/domain');
  const htmlBytes = Buffer.from('<html><script>alert(1)</script></html>');
  await assert.rejects(
    () => domain.emailUploadAsset(1, { data: htmlBytes.toString('base64'), mimeType: 'image/png' }),
    /Unrecognized image data/,
    'HTML bytes claiming png are refused'
  );
  // A real PNG (generated with the platform's own sharp) is
  // accepted and re-encoded.
  const sharp = require('sharp');
  const png1 = await sharp({
    create: { width: 2, height: 2, channels: 3, background: { r: 10, g: 20, b: 30 } },
  })
    .png()
    .toBuffer();
  const up = await domain.emailUploadAsset(1, { data: png1.toString('base64'), mimeType: 'image/png' });
  assert.ok(up && up.url && /\.png$/.test(up.url), 'real PNG uploads as .png');
  const domSrc = read('server/domain.js');
  assert.ok(!/mime === 'image\/jpeg' \|\| mime === 'image\/jpg'\s*\?\s*'jpg'/.test(domSrc), 'claimed-mime fallback branch is gone');
  n += 3;
  group('SEC-23 email asset magic check', n);

  // ---------- SEC-24 / SEC-15 pins ----------
  n = 0;
  const healthAt = domSrc.indexOf('async function urlLooksHealthyOnce');
  const healthBody = domSrc.slice(healthAt, healthAt + 1800);
  assert.ok(healthBody.includes("require('./urlSafety')") && healthBody.includes('fetchPublic'), 'health probe uses the SSRF guard');
  assert.ok(!/await fetch\(/.test(healthBody), 'no bare fetch left in the probe');
  const mcpHttpSrc = read('src/mcpHttp.js');
  const guardAt = mcpHttpSrc.indexOf('MCP_HTTP_ENABLED');
  const requireAt = mcpHttpSrc.indexOf("require('http')");
  assert.ok(guardAt > 0 && guardAt < requireAt, 'env guard precedes the server boot requires');
  let exited = null;
  try {
    execFileSync(process.execPath, [path.join(root, 'src/mcpHttp.js')], {
      env: { ...process.env, MCP_HTTP_ENABLED: '' },
      timeout: 15000,
      stdio: 'pipe',
    });
    exited = 0;
  } catch (e) {
    exited = e.status;
  }
  assert.equal(exited, 1, 'mcpHttp refuses to start without the explicit opt-in');
  n += 4;
  group('SEC-24 guarded probe + SEC-15 mcpHttp guard', n);

  // ---------- SEC-22: lockfile carries the fixes ----------
  n = 0;
  const lock = JSON.parse(read('package-lock.json'));
  const bp = lock.packages['node_modules/body-parser'].version;
  const [maj, min, pat] = bp.split('.').map(Number);
  assert.ok(maj > 1 || (maj === 1 && (min > 20 || (min === 20 && pat >= 9))), `body-parser ${bp} >= 1.20.9 (GHSA-27r3-jxmh-p828 fixed)`);
  assert.equal(lock.packages['node_modules/ip-address'].version, '10.7.5');
  assert.equal(lock.packages['node_modules/mailparser'].version, '3.14.1');
  assert.equal(lock.packages['node_modules/nodemailer'].version, '10.3.1');
  n += 4;
  group('SEC-22 dependency bumps', n);

  // ---------- SEC-13: census + lint pin ----------
  n = 0;
  const { census } = require('../scripts/xss-census.cjs');
  const cz = census();
  assert.equal(cz.summary.total, 450, 'sink census total pinned (Batch 139 finisher: +2 audited safe-class sinks in module-embed.js — pricing renderer; RAW/IDENT unchanged, snippet-verified; baseline regenerated) (Batch 140 finisher: total + safe classes unchanged; baseline refreshed for 12 portal.js RAW/IDENT sinks shifted +1 line by the qualifying-provenance line — every shifted sink line byte-identical to its pre-shift line, verified) (Batch 152 finisher: total + safe classes unchanged; baseline refreshed for 32 portal.js RAW/IDENT sinks shifted by the theme-bar code fields — pairwise-proven kind + snippet) (Batch 153 finisher, on the rebased 152 tree: census 448 -> 450 — +1 BUILDER +1 RAW in app.js, both the Admin Design-agent editor (rows build — every interpolated value esc()-wrapped; panel shell classified RAW by the conservative classifier, audited: its interpolations are a fixed literal seed note and the numeric limits only, no staff- or visitor-controlled string reaches it unescaped); BUILDER 59 -> 60, RAW 77 -> 78, safe classes 335 -> 336; pairwise (file,kind,snippet) multiset diff of the rebased census vs the landed 152 census = exactly these two app.js sinks, all other movement pure line shift; baseline regenerated as the union of the 152-refreshed baseline and the two new app.js entries)');
  assert.equal(cz.summary.ESCAPED + cz.summary.SAFE + cz.summary.STATIC + cz.summary.BUILDER, 336, 'provably-safe classes pinned');
  const reviewed = new Set(cz.sinks.filter((s) => s.kind === 'RAW' || s.kind === 'IDENT').map((s) => `${s.file}:${s.line}`));
  const BASELINE = new Set(require('./batch103-xss-baseline.json'));
  const newRaw = [...reviewed].filter((x) => !BASELINE.has(x));
  const goneRaw = [...BASELINE].filter((x) => !reviewed.has(x));
  assert.deepEqual(newRaw, [], `NEW raw sinks fail the gate (review + fix or baseline with justification): ${newRaw.join(', ')}`);
  assert.deepEqual(goneRaw, [], `baseline entries no longer raw — refresh the baseline deliberately: ${goneRaw.join(', ')}`);
  assert.ok(read('public/social-approve.html').includes("esc((p.platforms || []).join(', '))"), 'the one proven-unsafe sink (platforms) is escaped');
  n += 5;
  group('SEC-13 innerHTML census lint', n);

  // ---------- SEC-01 state (shipped in Batch 102 — pinned, not redone) ----------
  n = 0;
  const triggerSrc = read('src/designAgentTrigger.js');
  assert.ok(!/spawn\s*\(/.test(triggerSrc), 'no spawn() in the defanged trigger module');
  assert.ok(!triggerSrc.includes('shell: true') && !triggerSrc.includes('shell:true'), 'no shell spawn');
  assert.ok(!triggerSrc.includes("getSetting(db, 'design.agent_trigger_command'"), 'module never reads the command setting');
  n += 3;
  group('SEC-01 defanged state pinned', n);

  // ---------- token mint surface (SEC-09 REST) ----------
  n = 0;
  assert.ok(read('server/routes/mcpAdmin.js').includes('tokenClass'), 'REST token mint accepts tokenClass');
  assert.ok(read('server/workspace.js').includes("TOKEN_CLASSES = ['standard', 'vendor_design']"), 'class allowlist pinned');
  n += 2;
  group('SEC-09 mint surface', n);

  const total = groups.reduce((a, [, c]) => a + c, 0);
  console.log(`BATCH103 SUITE: ${groups.length} groups, ${total} checks — ALL PASS`);
})().catch((e) => {
  console.error('BATCH103 SUITE FAIL:', e && e.stack ? e.stack : e);
  process.exit(1);
});
