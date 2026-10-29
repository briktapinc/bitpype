'use strict';
/**
 * Batch 55 fixture — SMTP provider scenarios against stub servers.
 *
 * Spawned by tests/batch55-hygiene-regressions.cjs as a child process so
 * NODE_EXTRA_CA_CERTS (set by the parent, pointing at the test CA) is
 * in effect from process start and the hand-rolled SMTP client's TLS
 * verification trusts the stub's certificate.
 *
 * Prints FACTS ONLY (one JSON object on the last stdout line); the
 * parent asserts. Scenarios:
 *   S1 server offers STARTTLS (587-style)  -> send must succeed, AUTH only after upgrade
 *   S2 server offers NO encryption        -> require-TLS default must refuse before AUTH
 *   S3 implicit TLS (465-style)           -> send must succeed
 *   S4 NO encryption + require_tls='0'    -> legacy plaintext send + warning (opt-out)
 * Env: B55_CERT_KEY, B55_CERT_CRT (stub server cert), B55_NEGATIVE passthrough.
 */

const net = require('node:net');
const tls = require('node:tls');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const email = require(path.join(root, 'src/email.js'));

const USER = 'mj-user-55';
const PASS = 'mj-pass-55';
const B64_USER = Buffer.from(USER, 'utf8').toString('base64');
const B64_PASS = Buffer.from(PASS, 'utf8').toString('base64');

const warnings = [];
const origWarn = console.warn;
console.warn = (...args) => {
  warnings.push(args.map(String).join(' '));
  origWarn(...args);
};

function startStub({ offerStarttls = false, implicitTls = false } = {}) {
  const key = fs.readFileSync(process.env.B55_CERT_KEY);
  const cert = fs.readFileSync(process.env.B55_CERT_CRT);
  const facts = { lines: [], credentialLines: 0, authAttempts: 0, completed: false };
  const sockets = new Set();

  function handle(transport, encrypted, greet = true) {
    let buf = '';
    let state = 'cmd'; // cmd | user | pass | data
    let enc = encrypted;
    transport.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (state !== 'data') {
          facts.lines.push({ text: line, encrypted: enc });
          if (line === B64_USER || line === B64_PASS) facts.credentialLines++;
        }
        respond(line);
      }
    });
    transport.on('error', () => {});
    function send(s) {
      transport.write(s + '\r\n');
    }
    function respond(line) {
      const up = line.toUpperCase();
      if (state === 'user') {
        state = 'pass';
        send('334 UGFzc3dvcmQ6');
        return;
      }
      if (state === 'pass') {
        state = 'cmd';
        send('235 2.7.0 Authentication successful');
        return;
      }
      if (state === 'data') {
        if (line === '.') {
          state = 'cmd';
          facts.completed = true;
          send('250 2.0.0 OK queued');
        }
        return;
      }
      if (up.startsWith('EHLO') || up.startsWith('HELO')) {
        if (!enc && offerStarttls) send('250-localhost\r\n250-STARTTLS\r\n250 AUTH LOGIN');
        else send('250-localhost\r\n250 AUTH LOGIN');
        return;
      }
      if (up === 'STARTTLS' && offerStarttls && !enc) {
        send('220 2.0.0 Ready to start TLS');
        const plain = transport;
        plain.removeAllListeners('data');
        const secure = new tls.TLSSocket(plain, { isServer: true, key, cert });
        sockets.add(secure);
        secure.on('error', () => {});
        // Any bytes already buffered are the client's problem — the real
        // client sends nothing between STARTTLS and the handshake.
        buf = '';
        enc = true;
        handle(secure, true, false);
        return;
      }
      if (up.startsWith('AUTH LOGIN')) {
        facts.authAttempts++;
        state = 'user';
        send('334 VXNlcm5hbWU6');
        return;
      }
      if (up.startsWith('MAIL FROM')) return send('250 2.1.0 OK');
      if (up.startsWith('RCPT TO')) return send('250 2.1.5 OK');
      if (up === 'DATA') {
        state = 'data';
        return send('354 End data with <CR><LF>.<CR><LF>');
      }
      if (up === 'QUIT') {
        send('221 2.0.0 Bye');
        transport.end();
        return;
      }
      send('250 OK');
    }
    if (greet) send('220 stub.local ESMTP ready');
  }

  return new Promise((resolve) => {
    const server = implicitTls
      ? tls.createServer({ key, cert }, (sock) => {
          sockets.add(sock);
          handle(sock, true);
        })
      : net.createServer((sock) => {
          sockets.add(sock);
          handle(sock, false);
        });
    server.on('error', () => {});
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        facts,
        close() {
          for (const s of sockets) s.destroy();
          server.close();
        },
      });
    });
  });
}

function settingsFor(port, extra = {}) {
  return {
    'smtp.host': '127.0.0.1',
    'smtp.port': String(port),
    'smtp.secure': '0',
    'smtp.user': USER,
    'smtp.pass': PASS,
    'smtp.from_name': 'Batch55 Test',
    'smtp.from_email': 'team@example.com',
    ...extra,
  };
}

async function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout ${label}`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function scenario(name, stubOpts, extraSettings) {
  const stub = await startStub(stubOpts);
  const out = { name };
  try {
    const provider = email.getProvider(settingsFor(stub.port, extraSettings));
    out.providerName = provider.name;
    try {
      const res = await withTimeout(
        provider.send({ to: 'dest@example.com', subject: `batch55 ${name}`, text: 'hello from the stub test' }),
        10000,
        name
      );
      out.sent = true;
      out.resultProvider = res.provider;
    } catch (e) {
      out.sent = false;
      out.errorCode = e.code || null;
      out.errorMessage = String(e.message || e);
    }
  } finally {
    out.stub = {
      lines: stub.facts.lines,
      credentialLines: stub.facts.credentialLines,
      authAttempts: stub.facts.authAttempts,
      completed: stub.facts.completed,
      plaintextCredentialLines: stub.facts.lines.filter(
        (l) => !l.encrypted && (l.text === B64_USER || l.text === B64_PASS)
      ).length,
      plaintextAuthAttempts: stub.facts.lines.filter((l) => !l.encrypted && /^AUTH /i.test(l.text)).length,
    };
    stub.close();
  }
  return out;
}

(async () => {
  const results = {};
  results.S1_starttls = await scenario('S1', { offerStarttls: true }, {});
  results.S2_noEncryption = await scenario('S2', { offerStarttls: false }, {});
  results.S3_implicitTls = await scenario('S3', { implicitTls: true }, { 'smtp.secure': '1' });
  results.S4_optOut = await scenario('S4', { offerStarttls: false }, { 'smtp.require_tls': '0' });
  results.warnings = warnings;
  results.negativeMode = process.env.B55_NEGATIVE === '1';
  process.stdout.write('\n' + JSON.stringify(results) + '\n');
  process.exit(0);
})().catch((e) => {
  process.stdout.write('\n' + JSON.stringify({ fatal: String((e && e.stack) || e) }) + '\n');
  process.exit(0);
});
