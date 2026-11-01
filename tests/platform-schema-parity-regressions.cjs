'use strict';
/**
 * Batch 112 — platform schema parity (SQLite vs MySQL).
 *
 * The platform layer keeps TWO schema definitions: sql/schema.sqlite.sql
 * (+ the SQLite branch of server/db.js migrate()) for dev/tests, and
 * sql/schema.sql (+ the MySQL branch) for production. Before this suite
 * the gate only ever executed the SQLite one, so a table or column that
 * existed in one dialect only shipped green — the "no such table:
 * client_portal_users" failure family. This suite runs the REAL
 * migrate() under both dialects into scratch databases and fails on
 * any table/column present in one and missing in the other, even for
 * tables no behavioural suite exercises.
 *
 * Needs a MySQL-compatible server: GATE_MYSQL_HOST (or MYSQL_HOST),
 * GATE_MYSQL_PORT, GATE_MYSQL_USER, GATE_MYSQL_PASSWORD — the user
 * must be able to CREATE/DROP a scratch database. The gate always
 * provides one. Outside the gate (no env) the suite SKIPS loudly;
 * with GATE_REQUIRE_PARITY=1 a missing server is a hard failure.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const host = process.env.GATE_MYSQL_HOST || process.env.MYSQL_HOST;
const port = String(process.env.GATE_MYSQL_PORT || process.env.MYSQL_PORT || 3306);
const user = process.env.GATE_MYSQL_USER || process.env.MYSQL_USER || 'scout';
const password = process.env.GATE_MYSQL_PASSWORD || process.env.MYSQL_PASSWORD || 'gate-scout';
const SCRATCH_DB = 'gate_parity_scratch';

function dump(env) {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'lib', 'schemaDump.cjs')], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 120000,
  });
  if (r.error || r.status !== 0) {
    throw new Error(`schemaDump failed (${env.DB_DRIVER}): ${r.error ? r.error.message : r.stderr || r.stdout}`);
  }
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('SCHEMA_JSON '));
  assert(line, `schemaDump printed no SCHEMA_JSON (${env.DB_DRIVER}): ${r.stdout} ${r.stderr}`);
  return JSON.parse(line.slice('SCHEMA_JSON '.length));
}

function diffSchemas(a, b) {
  const out = [];
  for (const t of Object.keys(a)) if (!(t in b)) out.push(`table only in sqlite: ${t}`);
  for (const t of Object.keys(b)) if (!(t in a)) out.push(`table only in mysql: ${t}`);
  for (const t of Object.keys(a)) {
    if (!(t in b)) continue;
    for (const c of a[t]) if (!b[t].includes(c)) out.push(`column only in sqlite: ${t}.${c}`);
    for (const c of b[t]) if (!a[t].includes(c)) out.push(`column only in mysql: ${t}.${c}`);
  }
  return out;
}

(async () => {
  if (!host) {
    if (process.env.GATE_REQUIRE_PARITY === '1') {
      throw new Error('GATE_REQUIRE_PARITY=1 but no MySQL host configured (GATE_MYSQL_HOST/MYSQL_HOST)');
    }
    console.log(
      JSON.stringify({
        platformSchemaParity: 'skipped',
        reason: 'no MySQL server configured (GATE_MYSQL_HOST/MYSQL_HOST unset) — the gate always provides one',
      })
    );
    return;
  }

  const mysql = require('mysql2/promise');
  const admin = await mysql.createConnection({ host, port: Number(port), user, password });
  try {
    await admin.query(`DROP DATABASE IF EXISTS \`${SCRATCH_DB}\``);
    await admin.query(`CREATE DATABASE \`${SCRATCH_DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  } finally {
    await admin.end();
  }

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-parity-'));
  try {
    const sqliteSchema = dump({
      ...process.env,
      DB_DRIVER: 'sqlite',
      REGRESSION_DB_DRIVER: 'sqlite',
      SQLITE_PATH: path.join(temp, 'platform.sqlite'),
    });
    const mysqlSchema = dump({
      ...process.env,
      DB_DRIVER: 'mysql',
      REGRESSION_DB_DRIVER: 'mysql',
      MYSQL_HOST: host,
      MYSQL_PORT: port,
      MYSQL_USER: user,
      MYSQL_PASSWORD: password,
      MYSQL_DATABASE: SCRATCH_DB,
    });
    const diffs = diffSchemas(sqliteSchema, mysqlSchema);
    assert.deepEqual(diffs, [], 'platform schema drift between dialects:\n' + diffs.join('\n'));
    const tables = Object.keys(sqliteSchema).length;
    const columns = Object.values(sqliteSchema).reduce((n, c) => n + c.length, 0);
    console.log('PLATFORM-SCHEMA-PARITY PASS ' + JSON.stringify({ tables, columns }));
    console.log(JSON.stringify({ platformSchemaParity: true, tables, columns }));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
    const cleanup = await mysql.createConnection({ host, port: Number(port), user, password });
    try {
      await cleanup.query(`DROP DATABASE IF EXISTS \`${SCRATCH_DB}\``);
    } finally {
      await cleanup.end();
    }
  }
})().catch((e) => {
  console.error('PLATFORM-SCHEMA-PARITY FAIL:', (e && e.message) || e);
  process.exit(1);
});
