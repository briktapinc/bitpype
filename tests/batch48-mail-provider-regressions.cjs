'use strict';
/**
 * Batch 48 — selectable mail provider (Custom SMTP default / Cloudflare
 * native). Ely 2026-10-28: "I'd still like to have it but default to
 * mailjet and current settings."
 *
 * Pins:
 *  (1) DEFAULT PIN — ws1-shaped settings (smtp.host set, NO mail.provider
 *      key at all) select SmtpProvider with the same parsed config as
 *      before the batch, and validateMailSettings is clean. Unset MUST
 *      mean custom: today's behaviour is byte-identical.
 *  (2) SELECTION — mail.provider='cloudflare' + complete config selects
 *      CloudflareProvider; the REST request is the documented contract
 *      (POST /client/v4/accounts/{id}/email/sending/send on
 *      api.cloudflare.com, Authorization: Bearer, JSON body with
 *      to/from/subject/html/text). Docs:
 *      https://developers.cloudflare.com/email-service/api/send-emails/rest-api/
 *  (3) ACCOUNT ID — mail.cf_account_id wins; cf.account_id (Cloudflare
 *      settings) is the fallback.
 *  (4) ERRORS SURFACE — a Cloudflare error envelope (and a permanent
 *      bounce) reject the send with the provider's code/message, the
 *      same way SMTP failures throw. No fake success.
 *  (5) NATIVE-UNCONFIGURED IS LOUD — cloudflare selected with token /
 *      account / from missing throws field-specific config errors;
 *      never a silent fallback to SMTP or the stub.
 *  (6) SETTINGS REGISTRATION — mail.provider / mail.cf_account_id /
 *      mail.cf_token are settable + validated in server/settingsKeys.js
 *      (the registry the REST API, IPC and MCP parity all consume);
 *      mail.cf_token is a SECRET_KEYS member.
 *  (7) TEST-SEND — domain.mailTestSend (behind POST /settings/mail-test)
 *      sends through the SELECTED provider (stubbed HTTPS), and the
 *      secret reads back as '***' through settingsGetAll, never in clear.
 *
 * NEGATIVE PROOF (run at build time): reverting the getProvider
 * cloudflare branch in src/email.js makes cases (2)/(3)/(7) fail —
 * restored, green.
 *
 * The Cloudflare HTTP layer is stubbed by patching node:https.request
 * BEFORE src/email.js is required (house pattern, cf. batch47). No real
 * network anywhere.
 *
 * Run via tests/run-regressions.cjs (DB_DRIVER=sqlite).
 */
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');

process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || process.env.DB_DRIVER || 'sqlite';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b48-'));
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.SETTINGS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

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

/* ---------------- stubbed HTTPS (Cloudflare API) ---------------- */
const httpCalls = [];
let httpResponder = null;
const CF_OK = {
  status: 200,
  json: {
    success: true,
    errors: [],
    messages: [],
    result: { delivered: ['user@example.com'], permanent_bounces: [], queued: [] },
  },
};
https.request = function (options, cb) {
  const call = { options, chunks: [] };
  httpCalls.push(call);
  const req = new EventEmitter();
  req.write = (c) => {
    call.chunks.push(Buffer.from(c));
    return true;
  };
  req.end = () => {
    call.body = Buffer.concat(call.chunks).toString('utf8');
    const spec = httpResponder ? httpResponder(call) : CF_OK;
    const res = new EventEmitter();
    res.statusCode = spec.status;
    process.nextTick(() => {
      cb(res);
      res.emit('data', Buffer.from(JSON.stringify(spec.json)));
      res.emit('end');
    });
  };
  req.destroy = (e) => {
    if (e) req.emit('error', e);
  };
  return req;
};

const email = require(path.join(root, 'src/email.js'));
const { getProvider, readMailConfig, readSmtpConfig, validateMailSettings, SmtpProvider, CloudflareProvider, StubProvider } = email;
const settingsKeys = require(path.join(root, 'server/settingsKeys.js'));

const ACCT_A = 'a'.repeat(32);
const ACCT_B = 'b'.repeat(32);
const ACCT_C = 'c'.repeat(32);

/* ws1's live shape today: Mailjet in smtp.*, no mail.provider anywhere. */
const WS1 = {
  'smtp.host': 'in-v3.mailjet.com',
  'smtp.port': '587',
  'smtp.secure': '0',
  'smtp.user': 'mj-user',
  'smtp.pass': 'mj-pass',
  'smtp.from_name': 'Bitpype',
  'smtp.from_email': 'team@bitpype.com',
};

const CF_BASE = {
  'mail.provider': 'cloudflare',
  'mail.cf_token': 'tok-test',
  'cf.account_id': ACCT_A,
  'smtp.from_name': 'Bitpype',
  'smtp.from_email': 'team@bitpype.com',
};

function providerSuite() {
  check('default pin: no mail.provider key -> SmtpProvider, same parsed config', () => {
    const p = getProvider({ ...WS1 });
    assert.ok(p instanceof SmtpProvider, 'expected SmtpProvider');
    assert.equal(p.name, 'smtp');
    assert.deepEqual(p.cfg, readSmtpConfig({ ...WS1 }));
    assert.equal(p.cfg.host, 'in-v3.mailjet.com');
    assert.equal(p.cfg.port, 587);
    assert.equal(p.cfg.user, 'mj-user');
    assert.equal(p.cfg.fromEmail, 'team@bitpype.com');
    assert.equal(readMailConfig({ ...WS1 }).provider, 'custom');
    assert.deepEqual(validateMailSettings({ ...WS1 }), []);
  });

  check('default pin: empty settings -> StubProvider (unchanged legacy path)', () => {
    const p = getProvider({});
    assert.ok(p instanceof StubProvider);
    assert.equal(p.name, 'stub');
  });

  check("explicit 'custom' -> SmtpProvider", () => {
    const p = getProvider({ ...WS1, 'mail.provider': 'custom' });
    assert.ok(p instanceof SmtpProvider);
  });

  check('native unconfigured: getProvider throws field-specific errors, no fallback', () => {
    assert.throws(() => getProvider({ 'mail.provider': 'cloudflare' }), /mail\.cf_token is empty/);
    assert.throws(
      () => getProvider({ 'mail.provider': 'cloudflare', 'mail.cf_token': 'x' }),
      /mail\.cf_account_id \/ cf\.account_id is empty/
    );
    assert.throws(
      () =>
        getProvider({
          'mail.provider': 'cloudflare',
          'mail.cf_token': 'x',
          'cf.account_id': ACCT_A,
        }),
      /smtp\.from_email is not a valid email address/
    );
    // Even WITH a full SMTP config present, native-selected-but-broken
    // must not fall back to SMTP.
    assert.throws(() => getProvider({ ...WS1, 'mail.provider': 'cloudflare' }), /Invalid Cloudflare mail config/);
  });

  check('validateMailSettings names the missing native fields', () => {
    const errs = validateMailSettings({ 'mail.provider': 'cloudflare' });
    assert.ok(errs.some((e) => e.includes('mail.cf_token')), JSON.stringify(errs));
    assert.ok(errs.some((e) => e.includes('cf.account_id')), JSON.stringify(errs));
    assert.ok(errs.some((e) => e.includes('smtp.from_email')), JSON.stringify(errs));
    assert.deepEqual(validateMailSettings({ ...CF_BASE }), []);
  });

  check('settings registry: keys settable, validated, token is secret', () => {
    for (const k of ['mail.provider', 'mail.cf_account_id', 'mail.cf_token']) {
      assert.ok(settingsKeys.SETTABLE_KEYS.includes(k), `${k} must be settable`);
    }
    assert.ok(settingsKeys.SECRET_KEYS.includes('mail.cf_token'));
    assert.equal(settingsKeys.validateSetting('mail.provider', 'cloudflare').ok, true);
    assert.equal(settingsKeys.validateSetting('mail.provider', 'bogus').ok, false);
    assert.equal(settingsKeys.validateSetting('mail.cf_account_id', ACCT_A).ok, true);
    assert.equal(settingsKeys.validateSetting('mail.cf_account_id', 'not-hex').ok, false);
    assert.equal(settingsKeys.validateSetting('mail.cf_token', 'x'.repeat(501)).ok, false);
    const seeds = Object.fromEntries(settingsKeys.SETTING_SEEDS);
    assert.equal(seeds['mail.provider'], 'custom');
    assert.equal(seeds['mail.cf_account_id'], '');
    assert.equal(seeds['mail.cf_token'], '');
  });
}

async function cloudflareSendSuite() {
  await checkAsync('selection: complete CF config -> CloudflareProvider; REST request matches the docs contract', async () => {
    httpCalls.length = 0;
    httpResponder = null;
    const p = getProvider({ ...CF_BASE });
    assert.ok(p instanceof CloudflareProvider);
    assert.equal(p.name, 'cloudflare');
    const r = await p.send({
      to: 'user@example.com',
      subject: 'Hi there',
      html: '<p>Hello</p>',
      text: 'Hello',
      skipBrand: true,
    });
    assert.equal(r.ok, true);
    assert.equal(r.provider, 'cloudflare');
    assert.ok(typeof r.messageId === 'string' && r.messageId.length > 0);
    assert.equal(httpCalls.length, 1);
    const call = httpCalls[0];
    assert.equal(call.options.hostname, 'api.cloudflare.com');
    assert.equal(call.options.method, 'POST');
    assert.equal(call.options.path, `/client/v4/accounts/${ACCT_A}/email/sending/send`);
    assert.equal(call.options.headers.Authorization, 'Bearer tok-test');
    assert.equal(call.options.headers['Content-Type'], 'application/json');
    const body = JSON.parse(call.body);
    assert.equal(body.to, 'user@example.com');
    assert.deepEqual(body.from, { email: 'team@bitpype.com', name: 'Bitpype' });
    assert.equal(body.subject, 'Hi there');
    assert.equal(body.html, '<p>Hello</p>');
    assert.equal(body.text, 'Hello');
  });

  await checkAsync('account id: mail.cf_account_id overrides the cf.account_id fallback', async () => {
    httpCalls.length = 0;
    httpResponder = null;
    const p = getProvider({ ...CF_BASE, 'mail.cf_account_id': ACCT_B });
    await p.send({ to: 'user@example.com', subject: 'x', text: 'y', skipBrand: true });
    assert.equal(httpCalls.length, 1);
    assert.equal(httpCalls[0].options.path, `/client/v4/accounts/${ACCT_B}/email/sending/send`);
  });

  await checkAsync('CF error envelope -> send rejects with the provider code + message', async () => {
    httpResponder = () => ({
      status: 403,
      json: {
        success: false,
        errors: [{ code: 10102, message: 'email.sending.error.authentication.forbidden' }],
        messages: [],
        result: null,
      },
    });
    const p = getProvider({ ...CF_BASE });
    await assert.rejects(
      () => p.send({ to: 'user@example.com', subject: 'x', text: 'y', skipBrand: true }),
      (err) => {
        assert.equal(err.code, 'CF_EMAIL_SEND_FAILED');
        assert.match(err.message, /10102/);
        assert.match(err.message, /email\.sending\.error\.authentication\.forbidden/);
        return true;
      }
    );
    httpResponder = null;
  });

  await checkAsync('permanent bounce -> send rejects (no fake success)', async () => {
    httpResponder = () => ({
      status: 200,
      json: {
        success: true,
        errors: [],
        messages: [],
        result: { delivered: [], permanent_bounces: ['user@example.com'], queued: [] },
      },
    });
    const p = getProvider({ ...CF_BASE });
    await assert.rejects(
      () => p.send({ to: 'user@example.com', subject: 'x', text: 'y', skipBrand: true }),
      /permanent bounce/
    );
    httpResponder = null;
  });
}

async function testSendSuite() {
  const domain = require(path.join(root, 'server/domain.js'));

  await checkAsync('test-send route fn: sends via the SELECTED (cloudflare) provider; secret masked on read', async () => {
    domain.settingsSet(1, 'mail.provider', 'cloudflare');
    domain.settingsSet(1, 'mail.cf_account_id', ACCT_C);
    domain.settingsSet(1, 'smtp.from_name', 'Bitpype');
    domain.settingsSet(1, 'smtp.from_email', 'team@bitpype.com');
    domain.settingsSetSecret(1, 'mail.cf_token', 'tok-domain');

    const all = domain.settingsGetAll(1);
    assert.equal(all['mail.cf_token'], '***', 'secret must read back masked');
    assert.equal(all['mail.provider'], 'cloudflare');

    httpCalls.length = 0;
    httpResponder = null;
    const r = await domain.mailTestSend(1, { to: 'user@example.com' });
    assert.equal(r.ok, true);
    assert.equal(r.provider, 'cloudflare');
    assert.equal(httpCalls.length, 1);
    assert.equal(httpCalls[0].options.path, `/client/v4/accounts/${ACCT_C}/email/sending/send`);
    assert.equal(httpCalls[0].options.headers.Authorization, 'Bearer tok-domain');
  });

  await checkAsync('test-send: invalid address rejected before any send', async () => {
    httpCalls.length = 0;
    await assert.rejects(() => domain.mailTestSend(1, { to: 'not-an-email' }), /valid email address/);
    assert.equal(httpCalls.length, 0);
  });

  await checkAsync('test-send: custom provider + no SMTP host -> honest not-configured error', async () => {
    domain.settingsSet(1, 'mail.provider', 'custom');
    domain.settingsSet(1, 'smtp.host', '');
    await assert.rejects(() => domain.mailTestSend(1, { to: 'user@example.com' }), /not configured/);
  });

  check('wiring pins: route, api client and admin UI reference the test send + selector', () => {
    const routes = fs.readFileSync(path.join(root, 'server/routes/domainApi.js'), 'utf8');
    assert.match(routes, /post\('\/settings\/mail-test'/);
    const api = fs.readFileSync(path.join(root, 'public/js/api.js'), 'utf8');
    assert.match(api, /mailTest/);
    const app = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
    assert.match(app, /data-act="mail-test"/);
    assert.match(app, /'mail\.provider', 'Send mail via'/);
    assert.match(app, /secret\('mail\.cf_token'/);
    assert.match(app, /Active provider:/);
  });
}

(async () => {
  try {
    providerSuite();
    await cloudflareSendSuite();
    await testSendSuite();
  } finally {
    /* stubbed https.request lives only inside this process */
  }
  console.log(`batch48-mail-provider-regressions: ${results.length} checks passed`);
  for (const name of results) console.log(`  ok - ${name}`);
  console.log(JSON.stringify({ file: 'batch48-mail-provider-regressions', checks: results.length, passed: true }));
})().catch((e) => {
  console.error('batch48-mail-provider-regressions FAILED:', e);
  process.exit(1);
});
