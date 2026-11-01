'use strict';

const fs = require('fs');
const path = require('path');

const DRIVER = String(process.env.DB_DRIVER || 'mysql').toLowerCase();

let mysqlPool = null;
let sqliteDb = null;

function mysqlConfig() {
  return {
    host: process.env.MYSQL_HOST || '127.0.0.1',
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER || 'scout',
    password: process.env.MYSQL_PASSWORD || 'scout',
    database: process.env.MYSQL_DATABASE || 'website_scout',
    waitForConnections: true,
    connectionLimit: Number(process.env.MYSQL_POOL || 10),
    namedPlaceholders: true,
    timezone: 'Z',
    dateStrings: true,
  };
}

function sqlitePath() {
  return process.env.SQLITE_PATH || path.join(__dirname, '..', 'data', 'website-scout-web.sqlite');
}

function toSqliteSql(sql) {
  return String(sql)
    .replace(/INSERT IGNORE/gi, 'INSERT OR IGNORE')
    .replace(/UTC_TIMESTAMP\(\)/gi, "datetime('now')")
    .replace(/UTC_DATE\(\)/gi, "date('now')")
    .replace(/ON DUPLICATE KEY UPDATE/gi, 'ON CONFLICT DO UPDATE SET')
    .replace(/CAST\(:(\w+) AS JSON\)/gi, ':$1')
    .replace(/`/g, '');
}

/** Convert :name placeholders + object params to ? + ordered array for better-sqlite3. */
function bindNamed(sql, params) {
  if (!params || Array.isArray(params)) return { sql, params: params || [] };
  const names = [];
  const outSql = sql.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_m, name) => {
    names.push(name);
    return '?';
  });
  return { sql: outSql, params: names.map((n) => params[n]) };
}

function getMysqlPool() {
  if (!mysqlPool) {
    const mysql = require('mysql2/promise');
    mysqlPool = mysql.createPool(mysqlConfig());
  }
  return mysqlPool;
}

function getSqlite() {
  if (!sqliteDb) {
    const Database = require('better-sqlite3');
    const file = sqlitePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    sqliteDb = new Database(file);
    sqliteDb.pragma('journal_mode = WAL');
    sqliteDb.pragma('foreign_keys = ON');
  }
  return sqliteDb;
}

// --- SQLite transaction serialization (port of audit F-03) ---------------
// better-sqlite3 gives the whole process ONE connection, so the
// MySQL-shaped facade below (per-caller BEGIN/COMMIT) was unsafe: two
// concurrent callers either crashed with "cannot start a transaction
// within a transaction" or had their writes swept into — and rolled
// back with — a stranger's transaction. Fix: serialize top-level
// withConnection calls behind a mutex, track transaction depth so
// nested facades share the outer transaction, and make bare query()
// writes wait out any open transaction they don't own. (Production
// central runs MySQL, but sqlite mode — dev, tests, small installs —
// hit this under concurrent registrations.)
const { AsyncLocalStorage } = require('node:async_hooks');
const sqliteTxContext = new AsyncLocalStorage();
let sqliteMutex = Promise.resolve();
let sqliteTxDepth = 0;

function runSqliteExclusive(fn) {
  const result = sqliteMutex.then(fn);
  sqliteMutex = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

async function query(sql, params) {
  if (DRIVER === 'sqlite') {
    // While another caller holds an open transaction, an unrelated
    // write on the shared connection would silently join it. Wait for
    // it to finish instead (calls from inside the transaction don't wait).
    if (sqliteTxDepth > 0 && !sqliteTxContext.getStore()) {
      await sqliteMutex;
    }
    const db = getSqlite();
    let s = toSqliteSql(sql);
    // SQLite upsert rewrite for settings/sessions style inserts
    if (/ON CONFLICT DO UPDATE SET/i.test(s) && /workspace_settings/i.test(s)) {
      s = s.replace(
        /ON CONFLICT DO UPDATE SET value = VALUES\(value\)/i,
        'ON CONFLICT(workspace_id, key) DO UPDATE SET value = excluded.value'
      );
    }
    if (/ON CONFLICT DO UPDATE SET/i.test(s) && /platform_settings/i.test(s)) {
      s = s.replace(
        /ON CONFLICT DO UPDATE SET value = VALUES\(value\)/i,
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      );
    }
    if (/ON CONFLICT DO UPDATE SET/i.test(s) && /sessions/i.test(s)) {
      s = s.replace(
        /ON CONFLICT DO UPDATE SET expires = VALUES\(expires\), data = VALUES\(data\)/i,
        'ON CONFLICT(session_id) DO UPDATE SET expires = excluded.expires, data = excluded.data'
      );
    }
    const bound = bindNamed(s, params || {});
    const trimmed = bound.sql.trim().toUpperCase();
    if (trimmed.startsWith('SELECT') || trimmed.startsWith('WITH')) {
      return db.prepare(bound.sql).all(...bound.params);
    }
    const info = db.prepare(bound.sql).run(...bound.params);
    return { insertId: info.lastInsertRowid, affectedRows: info.changes, changes: info.changes };
  }

  const [rows] = await getMysqlPool().execute(sql, params || {});
  return rows;
}

async function withConnection(fn) {
  if (DRIVER === 'sqlite') {
    const db = getSqlite();
    const conn = {
      // Depth-counted: nested facades join the outer transaction
      // instead of issuing a second BEGIN (SQLite forbids it) or an
      // early COMMIT.
      beginTransaction: async () => {
        if (sqliteTxDepth === 0) db.exec('BEGIN');
        sqliteTxDepth++;
      },
      commit: async () => {
        if (sqliteTxDepth > 0) {
          sqliteTxDepth--;
          if (sqliteTxDepth === 0) db.exec('COMMIT');
        }
      },
      rollback: async () => {
        if (sqliteTxDepth > 0) {
          sqliteTxDepth = 0;
          db.exec('ROLLBACK');
        }
      },
      execute: async (sql, paramsArr) => {
        // workspace.js uses positional ? arrays with conn.execute
        const s = toSqliteSql(sql);
        const trimmed = s.trim().toUpperCase();
        if (trimmed.startsWith('SELECT')) {
          return [db.prepare(s).all(...(paramsArr || []))];
        }
        const info = db.prepare(s).run(...(paramsArr || []));
        return [{ insertId: info.lastInsertRowid, affectedRows: info.changes }];
      },
      query: async (sql) => {
        db.exec(sql);
        return [];
      },
    };
    // Nested withConnection (called from inside another caller's
    // callback) reuses the open transaction; top-level calls serialize
    // on the mutex.
    if (sqliteTxContext.getStore()) return fn(conn);
    return runSqliteExclusive(() => sqliteTxContext.run({ tx: true }, () => fn(conn)));
  }

  const conn = await getMysqlPool().getConnection();
  try {
    return await fn(conn);
  } finally {
    conn.release();
  }
}

async function ensureColumnMysql(conn, table, column, definition) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS c FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  );
  if (Number(rows[0].c) === 0) {
    await conn.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
  }
}

async function ensureColumnSqlite(db, table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

async function migrate() {
  if (DRIVER === 'sqlite') {
    const schemaPath = path.join(__dirname, '..', 'sql', 'schema.sqlite.sql');
    const sql = fs.readFileSync(schemaPath, 'utf8');
    const db = getSqlite();
    db.exec(sql);
    try {
      ensureColumnSqlite(db, 'users', 'is_super_admin', 'INTEGER NOT NULL DEFAULT 0');
    } catch {
      /* */
    }
    try {
      ensureColumnSqlite(db, 'users', 'status', "TEXT NOT NULL DEFAULT 'active'");
    } catch {
      /* */
    }
    try {
      ensureColumnSqlite(db, 'users', 'last_login_at', 'TEXT');
    } catch {
      /* */
    }
    try {
      ensureColumnSqlite(db, 'users', 'stripe_customer_id', 'TEXT');
    } catch {
      /* */
    }
    try {
      ensureColumnSqlite(db, 'users', 'stripe_subscription_id', 'TEXT');
    } catch {
      /* */
    }
    try {
      ensureColumnSqlite(db, 'users', 'subscription_status', "TEXT NOT NULL DEFAULT 'none'");
    } catch {
      /* */
    }
    try {
      ensureColumnSqlite(db, 'users', 'subscription_price_id', 'TEXT');
    } catch {
      /* */
    }
    try {
      ensureColumnSqlite(db, 'users', 'billing_plan', "TEXT NOT NULL DEFAULT 'free'");
    } catch {
      /* */
    }
    try {
      ensureColumnSqlite(db, 'users', 'current_period_end', 'TEXT');
    } catch {
      /* */
    }
    try {
      ensureColumnSqlite(db, 'users', 'deleted_at', 'TEXT');
    } catch {
      /* */
    }
    try {
      // Batch 80: partner program account classification ('standard' |
      // 'partner'); every existing user backfills to 'standard'.
      ensureColumnSqlite(db, 'users', 'account_type', "TEXT NOT NULL DEFAULT 'standard'");
    } catch {
      /* */
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS platform_settings (
        key TEXT NOT NULL PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS platform_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor_user_id INTEGER,
        action TEXT NOT NULL,
        detail TEXT,
        at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        stripe_invoice_id TEXT,
        stripe_payment_intent_id TEXT,
        stripe_charge_id TEXT,
        amount_cents INTEGER NOT NULL DEFAULT 0,
        currency TEXT NOT NULL DEFAULT 'usd',
        status TEXT NOT NULL DEFAULT 'open',
        description TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS refunds (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        payment_id INTEGER,
        user_id INTEGER,
        stripe_refund_id TEXT,
        amount_cents INTEGER NOT NULL DEFAULT 0,
        currency TEXT NOT NULL DEFAULT 'usd',
        status TEXT NOT NULL DEFAULT 'succeeded',
        reason TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS password_reset_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS deployments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id INTEGER NOT NULL,
        lead_id INTEGER NOT NULL,
        lead_email TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'queued',
        plan_item_id TEXT NOT NULL DEFAULT '',
        plan_name TEXT NOT NULL DEFAULT '',
        price_cents INTEGER,
        first_period_price_cents INTEGER,
        currency TEXT NOT NULL DEFAULT '',
        hostinger_order_id TEXT,
        hostinger_subscription_id TEXT,
        hostinger_vm_id TEXT,
        hostinger_script_id TEXT,
        hostname TEXT,
        ip_address TEXT,
        instance_url TEXT,
        admin_email TEXT NOT NULL DEFAULT '',
        setup_token_hash TEXT,
        setup_expires_at TEXT,
        callback_secret_hash TEXT,
        bundle_token_hash TEXT,
        active_lead_key TEXT UNIQUE,
        email_sent_at TEXT,
        warning TEXT,
        error_code TEXT,
        error_detail TEXT,
        created_by INTEGER,
        purchase_started_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_deployments_lead ON deployments(workspace_id, lead_id);
      CREATE INDEX IF NOT EXISTS idx_deployments_status ON deployments(status);
      CREATE TABLE IF NOT EXISTS workspace_invites (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id INTEGER NOT NULL,
        email TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member',
        token_hash TEXT NOT NULL UNIQUE,
        invited_by INTEGER,
        accepted_at TEXT,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS client_portal_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        workspace_id INTEGER NOT NULL,
        lead_id INTEGER NOT NULL,
        business_name TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active',
        user_type TEXT NOT NULL DEFAULT 'owner',
        nav_overrides TEXT,
        module_overrides TEXT,
        last_login_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS client_portal_login_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        portal_user_id INTEGER NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS credit_balances (
        workspace_id INTEGER NOT NULL PRIMARY KEY,
        balance INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS credit_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id INTEGER NOT NULL,
        user_id INTEGER,
        delta INTEGER NOT NULL,
        balance_after INTEGER NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        ref_type TEXT,
        ref_id TEXT,
        stripe_checkout_session_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(stripe_checkout_session_id)
      );
      CREATE INDEX IF NOT EXISTS idx_credit_ledger_ws ON credit_ledger(workspace_id, id DESC);
      CREATE TABLE IF NOT EXISTS portal_referrals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        referrer_portal_user_id INTEGER NOT NULL,
        referrer_workspace_id INTEGER NOT NULL,
        referrer_lead_id INTEGER,
        referred_name TEXT NOT NULL DEFAULT '',
        referred_email TEXT,
        referred_phone TEXT,
        referred_business_name TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        linked_lead_id INTEGER,
        linked_portal_user_id INTEGER,
        linked_user_id INTEGER,
        plan_id TEXT,
        plan_amount_cents INTEGER,
        credits_awarded INTEGER NOT NULL DEFAULT 0,
        credited_at TEXT,
        stripe_subscription_id TEXT,
        notes TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_portal_referrals_referrer ON portal_referrals(referrer_portal_user_id);
      CREATE INDEX IF NOT EXISTS idx_portal_referrals_ws ON portal_referrals(referrer_workspace_id);
      CREATE INDEX IF NOT EXISTS idx_portal_referrals_email ON portal_referrals(referred_email);
      CREATE INDEX IF NOT EXISTS idx_portal_referrals_status ON portal_referrals(status);
      CREATE TABLE IF NOT EXISTS stripe_events (
        event_id TEXT NOT NULL PRIMARY KEY,
        type TEXT NOT NULL DEFAULT '',
        processed_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS signup_plan_choices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL UNIQUE,
        workspace_id INTEGER,
        plan_id TEXT NOT NULL DEFAULT 'free',
        status TEXT NOT NULL DEFAULT 'free',
        checkout_session_id TEXT,
        checkout_url TEXT,
        checkout_error TEXT,
        welcome_status TEXT NOT NULL DEFAULT 'pending',
        welcome_sent_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS upsell_tips (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        feature_key TEXT NOT NULL DEFAULT '',
        target_plans TEXT NOT NULL DEFAULT 'free',
        enabled INTEGER NOT NULL DEFAULT 1,
        frequency_hours INTEGER NOT NULL DEFAULT 72,
        weight INTEGER NOT NULL DEFAULT 1,
        sort_order INTEGER NOT NULL DEFAULT 0,
        cta_label TEXT NOT NULL DEFAULT 'Upgrade',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS upsell_tip_impressions (
        portal_user_id INTEGER NOT NULL,
        tip_id INTEGER NOT NULL,
        last_shown_at TEXT NOT NULL,
        show_count INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (portal_user_id, tip_id)
      );
      CREATE TABLE IF NOT EXISTS mcp_oauth_auth_codes (
        code TEXT NOT NULL PRIMARY KEY,
        payload_json TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mcp_oauth_refresh_tokens (
        token_hash TEXT NOT NULL PRIMARY KEY,
        payload_json TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mcp_oauth_clients (
        client_id TEXT NOT NULL PRIMARY KEY,
        payload_json TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_mcp_oauth_codes_exp ON mcp_oauth_auth_codes(expires_at);
      CREATE INDEX IF NOT EXISTS idx_mcp_oauth_refresh_exp ON mcp_oauth_refresh_tokens(expires_at);
      CREATE INDEX IF NOT EXISTS idx_mcp_oauth_clients_exp ON mcp_oauth_clients(expires_at);
      CREATE TABLE IF NOT EXISTS rate_limit_hits (
        bucket TEXT NOT NULL,
        k TEXT NOT NULL,
        at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_rate_limit_hits ON rate_limit_hits (bucket, k, at);
      CREATE TABLE IF NOT EXISTS mailing_list_subscribers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'subscribed',
        source TEXT NOT NULL DEFAULT 'admin',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        unsubscribed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_mailing_list_status ON mailing_list_subscribers (status);
      CREATE TABLE IF NOT EXISTS mailing_list_sends (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        subject TEXT NOT NULL,
        recipients_attempted INTEGER NOT NULL DEFAULT 0,
        recipients_sent INTEGER NOT NULL DEFAULT 0,
        recipients_failed INTEGER NOT NULL DEFAULT 0,
        recipients_skipped INTEGER NOT NULL DEFAULT 0,
        created_by INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS partner_earnings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        partner_user_id INTEGER NOT NULL,
        workspace_id INTEGER,
        kind TEXT NOT NULL DEFAULT 'credit',
        amount_cents INTEGER NOT NULL DEFAULT 0,
        currency TEXT NOT NULL DEFAULT 'usd',
        credit_key TEXT UNIQUE,
        stripe_invoice_id TEXT,
        stripe_charge_id TEXT,
        payment_id INTEGER,
        payout_id INTEGER,
        related_entry_id INTEGER,
        note TEXT,
        created_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_partner_earnings_user ON partner_earnings (partner_user_id, id DESC);
      CREATE TABLE IF NOT EXISTS partner_payouts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        partner_user_id INTEGER NOT NULL,
        amount_cents INTEGER NOT NULL DEFAULT 0,
        method TEXT,
        note TEXT,
        paid_by INTEGER,
        created_at TEXT
      );
      CREATE TABLE IF NOT EXISTS partner_approval_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id INTEGER,
        requested_by INTEGER NOT NULL,
        action_kind TEXT NOT NULL,
        payload_json TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        decided_by INTEGER,
        decided_at TEXT,
        result_json TEXT,
        created_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_partner_approvals_status ON partner_approval_requests (status, id DESC);
    `);
    // Batch 29: portal user types + per-user nav overrides. The column
    // default backfills every existing portal user to 'owner'.
    ensureColumnSqlite(db, 'client_portal_users', 'user_type', "TEXT NOT NULL DEFAULT 'owner'");
    ensureColumnSqlite(db, 'client_portal_users', 'nav_overrides', 'TEXT');
    ensureColumnSqlite(db, 'client_portal_users', 'module_overrides', 'TEXT');
    try {
      db.exec(
        `UPDATE client_portal_users SET user_type = 'owner'
          WHERE user_type IS NULL OR user_type NOT IN ('owner', 'renter', 'partner')`
      );
    } catch {
      /* table may not exist on a bare schema */
    }
    try {
      ensureColumnSqlite(db, 'workspace_tokens', 'lead_id', 'INTEGER');
    } catch {
      /* */
    }
    ensureColumnSqlite(db, 'job_runs', 'trigger_source', "TEXT NOT NULL DEFAULT 'legacy'");
    ensureColumnSqlite(db, 'job_runs', 'triggered_by', "TEXT NOT NULL DEFAULT 'unknown'");
    ensureColumnSqlite(db, 'workspace_tokens', 'expires_at', 'INTEGER');
    ensureColumnSqlite(db, 'workspace_tokens', 'oauth_user_id', 'INTEGER');
    // Batch 103 (SEC-09): token class — 'standard' (default) or
    // 'vendor_design' (the restricted Solo vendor design-agent class,
    // enforced at MCP dispatch).
    ensureColumnSqlite(db, 'workspace_tokens', 'token_class', "TEXT NOT NULL DEFAULT 'standard'");
    // Batch 40: MFA (TOTP) state on both login surfaces — staff users
    // (required) and client portal users (opt-in). Secrets are stored
    // secretBox-encrypted; recovery codes as SHA-256 hashes only.
    for (const table of ['users', 'client_portal_users']) {
      ensureColumnSqlite(db, table, 'totp_secret', 'TEXT');
      ensureColumnSqlite(db, table, 'totp_pending_secret', 'TEXT');
      ensureColumnSqlite(db, table, 'totp_enabled', 'INTEGER NOT NULL DEFAULT 0');
      ensureColumnSqlite(db, table, 'totp_recovery_hashes', 'TEXT');
      ensureColumnSqlite(db, table, 'totp_failed_attempts', 'INTEGER NOT NULL DEFAULT 0');
      ensureColumnSqlite(db, table, 'totp_locked_until', 'TEXT');
    }
    // Batch 106: ai_usage.provider attribution (+ one-time backfill
    // on the boot that first adds the column).
    try {
      require('../src/aiProvider').ensureAiUsageProvider(db);
    } catch {
      /* table may not exist on a bare schema */
    }
    await require('./oauthTokenPolicy').backfill(query);
    return;
  }

  const schemaPath = path.join(__dirname, '..', 'sql', 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  const statements = sql
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('--'));
  await withConnection(async (conn) => {
    for (const stmt of statements) {
      await conn.query(stmt);
    }
    await ensureColumnMysql(conn, 'users', 'is_super_admin', 'TINYINT(1) NOT NULL DEFAULT 0');
    await ensureColumnMysql(conn, 'users', 'status', "VARCHAR(20) NOT NULL DEFAULT 'active'");
    await ensureColumnMysql(conn, 'users', 'last_login_at', 'DATETIME NULL');
    await ensureColumnMysql(conn, 'users', 'stripe_customer_id', 'VARCHAR(120) NULL');
    await ensureColumnMysql(conn, 'users', 'stripe_subscription_id', 'VARCHAR(120) NULL');
    await ensureColumnMysql(conn, 'users', 'subscription_status', "VARCHAR(40) NOT NULL DEFAULT 'none'");
    await ensureColumnMysql(conn, 'users', 'subscription_price_id', 'VARCHAR(120) NULL');
    await ensureColumnMysql(conn, 'users', 'billing_plan', "VARCHAR(40) NOT NULL DEFAULT 'free'");
    await ensureColumnMysql(conn, 'users', 'current_period_end', 'DATETIME NULL');
    await ensureColumnMysql(conn, 'users', 'deleted_at', 'DATETIME NULL');
    // Batch 80: partner program account classification.
    await ensureColumnMysql(conn, 'users', 'account_type', "VARCHAR(20) NOT NULL DEFAULT 'standard'");
    // Batch 106: ai_usage.provider attribution. Backfill runs ONLY
    // when the column was just added (mirrors src/aiProvider's
    // providerFromModel mapping; ambiguous models stay 'unknown').
    try {
      const [provRows] = await conn.query(
        `SELECT COUNT(*) AS c FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ai_usage' AND COLUMN_NAME = 'provider'`
      );
      if (Number(provRows[0].c) === 0) {
        await conn.query("ALTER TABLE `ai_usage` ADD COLUMN `provider` VARCHAR(40) NOT NULL DEFAULT 'unknown'");
        await conn.query("UPDATE ai_usage SET provider = 'muse' WHERE LOWER(model) LIKE 'muse-%' OR LOWER(model) LIKE 'muse_%'");
        await conn.query("UPDATE ai_usage SET provider = 'fal' WHERE LOWER(model) LIKE 'fal-ai/%' OR LOWER(model) LIKE 'fal-%'");
        await conn.query(
          "UPDATE ai_usage SET provider = 'openai' WHERE LOWER(model) LIKE 'gpt%' OR LOWER(model) LIKE 'dall-e%' OR LOWER(model) LIKE 'text-embedding-%' OR LOWER(model) LIKE 'text-davinci%' OR LOWER(model) LIKE 'text-moderation%' OR LOWER(model) LIKE 'whisper-%' OR LOWER(model) LIKE 'tts-%' OR LOWER(model) LIKE 'chatgpt-%' OR LOWER(model) LIKE 'codex-%' OR LOWER(model) REGEXP '^o[134](-|$)'"
        );
      }
    } catch {
      /* ai_usage may not exist on a bare schema */
    }
    await conn.query(`
      CREATE TABLE IF NOT EXISTS platform_settings (
        \`key\` VARCHAR(120) NOT NULL PRIMARY KEY,
        value MEDIUMTEXT NOT NULL,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS platform_audit (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        actor_user_id BIGINT UNSIGNED NULL,
        action VARCHAR(80) NOT NULL,
        detail TEXT NULL,
        at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        KEY idx_platform_audit_at (at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS partner_earnings (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        partner_user_id BIGINT UNSIGNED NOT NULL,
        workspace_id BIGINT UNSIGNED NULL,
        kind VARCHAR(16) NOT NULL DEFAULT 'credit',
        amount_cents INT NOT NULL DEFAULT 0,
        currency VARCHAR(8) NOT NULL DEFAULT 'usd',
        credit_key VARCHAR(255) NULL,
        stripe_invoice_id VARCHAR(255) NULL,
        stripe_charge_id VARCHAR(255) NULL,
        payment_id BIGINT UNSIGNED NULL,
        payout_id BIGINT UNSIGNED NULL,
        related_entry_id BIGINT UNSIGNED NULL,
        note VARCHAR(255) NULL,
        created_at VARCHAR(32) NULL,
        UNIQUE KEY uq_partner_earnings_key (credit_key),
        KEY idx_partner_earnings_user (partner_user_id, id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS partner_payouts (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        partner_user_id BIGINT UNSIGNED NOT NULL,
        amount_cents INT NOT NULL DEFAULT 0,
        method VARCHAR(64) NULL,
        note VARCHAR(255) NULL,
        paid_by BIGINT UNSIGNED NULL,
        created_at VARCHAR(32) NULL,
        KEY idx_partner_payouts_user (partner_user_id, id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS partner_approval_requests (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        workspace_id BIGINT UNSIGNED NULL,
        requested_by BIGINT UNSIGNED NOT NULL,
        action_kind VARCHAR(48) NOT NULL,
        payload_json TEXT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'pending',
        decided_by BIGINT UNSIGNED NULL,
        decided_at VARCHAR(32) NULL,
        result_json TEXT NULL,
        created_at VARCHAR(32) NULL,
        KEY idx_partner_approvals_status (status, id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS payments (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        user_id BIGINT UNSIGNED NULL,
        stripe_invoice_id VARCHAR(120) NULL,
        stripe_payment_intent_id VARCHAR(120) NULL,
        stripe_charge_id VARCHAR(120) NULL,
        amount_cents INT NOT NULL DEFAULT 0,
        currency VARCHAR(12) NOT NULL DEFAULT 'usd',
        status VARCHAR(40) NOT NULL DEFAULT 'open',
        description TEXT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_payments_invoice (stripe_invoice_id),
        KEY idx_payments_user (user_id),
        KEY idx_payments_charge (stripe_charge_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS refunds (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        payment_id BIGINT UNSIGNED NULL,
        user_id BIGINT UNSIGNED NULL,
        stripe_refund_id VARCHAR(120) NULL,
        amount_cents INT NOT NULL DEFAULT 0,
        currency VARCHAR(12) NOT NULL DEFAULT 'usd',
        status VARCHAR(40) NOT NULL DEFAULT 'succeeded',
        reason VARCHAR(80) NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_refunds_stripe (stripe_refund_id),
        KEY idx_refunds_user (user_id),
        KEY idx_refunds_payment (payment_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS password_reset_tokens (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        user_id BIGINT UNSIGNED NOT NULL,
        token_hash CHAR(64) NOT NULL,
        expires_at DATETIME NOT NULL,
        used_at DATETIME NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_prt_hash (token_hash),
        KEY idx_prt_user (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS deployments (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        workspace_id BIGINT UNSIGNED NOT NULL,
        lead_id BIGINT UNSIGNED NOT NULL,
        lead_email VARCHAR(254) NOT NULL DEFAULT '',
        status VARCHAR(24) NOT NULL DEFAULT 'queued',
        plan_item_id VARCHAR(120) NOT NULL DEFAULT '',
        plan_name VARCHAR(190) NOT NULL DEFAULT '',
        price_cents BIGINT NULL,
        first_period_price_cents BIGINT NULL,
        currency VARCHAR(8) NOT NULL DEFAULT '',
        hostinger_order_id VARCHAR(64) NULL,
        hostinger_subscription_id VARCHAR(64) NULL,
        hostinger_vm_id VARCHAR(64) NULL,
        hostinger_script_id VARCHAR(64) NULL,
        hostname VARCHAR(190) NULL,
        ip_address VARCHAR(64) NULL,
        instance_url VARCHAR(300) NULL,
        admin_email VARCHAR(254) NOT NULL DEFAULT '',
        setup_token_hash CHAR(64) NULL,
        setup_expires_at DATETIME NULL,
        callback_secret_hash CHAR(64) NULL,
        bundle_token_hash CHAR(64) NULL,
        active_lead_key VARCHAR(64) NULL,
        email_sent_at DATETIME NULL,
        warning VARCHAR(500) NULL,
        error_code VARCHAR(48) NULL,
        error_detail VARCHAR(1000) NULL,
        created_by BIGINT UNSIGNED NULL,
        purchase_started_at DATETIME NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_deployments_active_lead (active_lead_key),
        KEY idx_deployments_lead (workspace_id, lead_id),
        KEY idx_deployments_status (status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS workspace_invites (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        workspace_id BIGINT UNSIGNED NOT NULL,
        email VARCHAR(254) NOT NULL,
        role ENUM('owner','admin','member') NOT NULL DEFAULT 'member',
        token_hash CHAR(64) NOT NULL,
        invited_by BIGINT UNSIGNED NULL,
        accepted_at DATETIME NULL,
        expires_at DATETIME NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_invite_hash (token_hash),
        KEY idx_invite_ws (workspace_id),
        KEY idx_invite_email (email)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS client_portal_users (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        email VARCHAR(254) NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        workspace_id BIGINT UNSIGNED NOT NULL,
        lead_id BIGINT UNSIGNED NOT NULL,
        business_name VARCHAR(200) NOT NULL DEFAULT '',
        status VARCHAR(20) NOT NULL DEFAULT 'active',
        user_type VARCHAR(20) NOT NULL DEFAULT 'owner',
        nav_overrides TEXT NULL,
        module_overrides TEXT NULL,
        last_login_at DATETIME NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_client_portal_email (email),
        KEY idx_client_portal_ws_lead (workspace_id, lead_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS client_portal_login_tokens (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        portal_user_id BIGINT UNSIGNED NOT NULL,
        token_hash CHAR(64) NOT NULL,
        expires_at DATETIME NOT NULL,
        used_at DATETIME NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_cpl_hash (token_hash),
        KEY idx_cpl_user (portal_user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS credit_balances (
        workspace_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
        balance INT NOT NULL DEFAULT 0,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS credit_ledger (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        workspace_id BIGINT UNSIGNED NOT NULL,
        user_id BIGINT UNSIGNED NULL,
        delta INT NOT NULL,
        balance_after INT NOT NULL,
        reason VARCHAR(120) NOT NULL DEFAULT '',
        ref_type VARCHAR(60) NULL,
        ref_id VARCHAR(80) NULL,
        stripe_checkout_session_id VARCHAR(120) NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_credit_ledger_session (stripe_checkout_session_id),
        KEY idx_credit_ledger_ws (workspace_id, id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS portal_referrals (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        referrer_portal_user_id BIGINT UNSIGNED NOT NULL,
        referrer_workspace_id BIGINT UNSIGNED NOT NULL,
        referrer_lead_id BIGINT UNSIGNED NULL,
        referred_name VARCHAR(160) NOT NULL DEFAULT '',
        referred_email VARCHAR(254) NULL,
        referred_phone VARCHAR(40) NULL,
        referred_business_name VARCHAR(200) NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        linked_lead_id BIGINT UNSIGNED NULL,
        linked_portal_user_id BIGINT UNSIGNED NULL,
        linked_user_id BIGINT UNSIGNED NULL,
        plan_id VARCHAR(40) NULL,
        plan_amount_cents INT NULL,
        credits_awarded INT NOT NULL DEFAULT 0,
        credited_at DATETIME NULL,
        stripe_subscription_id VARCHAR(120) NULL,
        notes TEXT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        KEY idx_portal_referrals_referrer (referrer_portal_user_id),
        KEY idx_portal_referrals_ws (referrer_workspace_id),
        KEY idx_portal_referrals_email (referred_email),
        KEY idx_portal_referrals_status (status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS stripe_events (
        event_id VARCHAR(120) NOT NULL PRIMARY KEY,
        type VARCHAR(80) NOT NULL DEFAULT '',
        processed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        KEY idx_stripe_events_type (type)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS signup_plan_choices (
        id BIGINT PRIMARY KEY AUTO_INCREMENT,
        user_id BIGINT NOT NULL UNIQUE,
        workspace_id BIGINT NULL,
        plan_id VARCHAR(40) NOT NULL DEFAULT 'free',
        status VARCHAR(40) NOT NULL DEFAULT 'free',
        checkout_session_id VARCHAR(120) NULL,
        checkout_url TEXT NULL,
        checkout_error VARCHAR(80) NULL,
        welcome_status VARCHAR(20) NOT NULL DEFAULT 'pending',
        welcome_sent_at DATETIME NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    // Batch 29: portal user types + per-user nav overrides (existing
    // tables only — the CREATE above covers fresh installs). The column
    // default backfills every existing portal user to 'owner'.
    await ensureColumnMysql(conn, 'client_portal_users', 'user_type', "VARCHAR(20) NOT NULL DEFAULT 'owner'");
    await ensureColumnMysql(conn, 'client_portal_users', 'nav_overrides', 'TEXT NULL');
    await ensureColumnMysql(conn, 'client_portal_users', 'module_overrides', 'TEXT NULL');
    await conn.query(
      `UPDATE client_portal_users SET user_type = 'owner'
        WHERE user_type IS NULL OR user_type NOT IN ('owner', 'renter', 'partner')`
    );
    await ensureColumnMysql(conn, 'workspace_tokens', 'lead_id', 'BIGINT UNSIGNED NULL');
    await ensureColumnMysql(conn, 'job_runs', 'trigger_source', "VARCHAR(40) NOT NULL DEFAULT 'legacy'");
    await ensureColumnMysql(conn, 'job_runs', 'triggered_by', "VARCHAR(120) NOT NULL DEFAULT 'unknown'");
    await ensureColumnMysql(conn, 'workspace_tokens', 'expires_at', 'BIGINT NULL');
    await ensureColumnMysql(conn, 'workspace_tokens', 'oauth_user_id', 'BIGINT UNSIGNED NULL');
    // Batch 103 (SEC-09): token class (see the sqlite block above).
    await ensureColumnMysql(conn, 'workspace_tokens', 'token_class', "VARCHAR(32) NOT NULL DEFAULT 'standard'");
    // Batch 40: MFA (TOTP) state on both login surfaces — staff users
    // (required) and client portal users (opt-in). Secrets are stored
    // secretBox-encrypted; recovery codes as SHA-256 hashes only.
    for (const table of ['users', 'client_portal_users']) {
      await ensureColumnMysql(conn, table, 'totp_secret', 'TEXT NULL');
      await ensureColumnMysql(conn, table, 'totp_pending_secret', 'TEXT NULL');
      await ensureColumnMysql(conn, table, 'totp_enabled', 'TINYINT(1) NOT NULL DEFAULT 0');
      await ensureColumnMysql(conn, table, 'totp_recovery_hashes', 'TEXT NULL');
      await ensureColumnMysql(conn, table, 'totp_failed_attempts', 'INT NOT NULL DEFAULT 0');
      await ensureColumnMysql(conn, table, 'totp_locked_until', 'DATETIME NULL');
    }
    await conn.query(`
      CREATE TABLE IF NOT EXISTS upsell_tips (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        title VARCHAR(200) NOT NULL,
        body TEXT NOT NULL,
        feature_key VARCHAR(80) NOT NULL DEFAULT '',
        target_plans VARCHAR(80) NOT NULL DEFAULT 'free',
        enabled TINYINT(1) NOT NULL DEFAULT 1,
        frequency_hours INT NOT NULL DEFAULT 72,
        weight INT NOT NULL DEFAULT 1,
        sort_order INT NOT NULL DEFAULT 0,
        cta_label VARCHAR(80) NOT NULL DEFAULT 'Upgrade',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        KEY idx_upsell_tips_enabled (enabled, sort_order)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS upsell_tip_impressions (
        portal_user_id BIGINT UNSIGNED NOT NULL,
        tip_id BIGINT UNSIGNED NOT NULL,
        last_shown_at DATETIME NOT NULL,
        show_count INT NOT NULL DEFAULT 1,
        PRIMARY KEY (portal_user_id, tip_id),
        KEY idx_upsell_imp_shown (last_shown_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS mcp_oauth_auth_codes (
        code VARCHAR(128) NOT NULL PRIMARY KEY,
        payload_json MEDIUMTEXT NOT NULL,
        expires_at BIGINT NOT NULL,
        KEY idx_mcp_oauth_codes_exp (expires_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS mcp_oauth_refresh_tokens (
        token_hash VARCHAR(128) NOT NULL PRIMARY KEY,
        payload_json MEDIUMTEXT NOT NULL,
        expires_at BIGINT NOT NULL,
        KEY idx_mcp_oauth_refresh_exp (expires_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS mcp_oauth_clients (
        client_id VARCHAR(128) NOT NULL PRIMARY KEY,
        payload_json MEDIUMTEXT NOT NULL,
        expires_at BIGINT NOT NULL,
        KEY idx_mcp_oauth_clients_exp (expires_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    // Batch 55: durable rate-limit counters (server/rateLimitStore.js).
    await conn.query(`
      CREATE TABLE IF NOT EXISTS rate_limit_hits (
        bucket VARCHAR(160) NOT NULL,
        k VARCHAR(255) NOT NULL,
        at BIGINT NOT NULL,
        KEY idx_rate_limit_hits (bucket, k, at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    // Batch 71: Admin-only mailing list + newsletter (BitPype's own
    // list — platform-level, NOT a workspace table; server/mailingList.js).
    await conn.query(`
      CREATE TABLE IF NOT EXISTS mailing_list_subscribers (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        email VARCHAR(254) NOT NULL,
        name VARCHAR(200) NOT NULL DEFAULT '',
        status VARCHAR(20) NOT NULL DEFAULT 'subscribed',
        source VARCHAR(20) NOT NULL DEFAULT 'admin',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        unsubscribed_at DATETIME NULL,
        UNIQUE KEY uq_mailing_list_email (email),
        KEY idx_mailing_list_status (status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS mailing_list_sends (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        subject VARCHAR(255) NOT NULL,
        recipients_attempted INT NOT NULL DEFAULT 0,
        recipients_sent INT NOT NULL DEFAULT 0,
        recipients_failed INT NOT NULL DEFAULT 0,
        recipients_skipped INT NOT NULL DEFAULT 0,
        created_by BIGINT UNSIGNED NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        KEY idx_mailing_list_sends_at (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
  });
  await require('./oauthTokenPolicy').backfill(query);
}

async function ping() {
  if (DRIVER === 'sqlite') {
    getSqlite().prepare('SELECT 1').get();
    return true;
  }
  await query('SELECT 1 AS ok');
  return true;
}

function driver() {
  return DRIVER;
}

// Batch 112: deterministic shutdown for short-lived processes
// (regression suites, one-off scripts). The MySQL pool's sockets
// legitimately keep a server process alive forever; a test process
// that opened the pool in-process must be able to release it so it
// can exit on its own assertions. Long-running app code never calls
// this. Safe to call when nothing was opened.
async function close() {
  if (mysqlPool) {
    const pool = mysqlPool;
    mysqlPool = null;
    await pool.end();
  }
  if (sqliteDb) {
    const db = sqliteDb;
    sqliteDb = null;
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
}

module.exports = { query, withConnection, migrate, ping, driver, sqlitePath, mysqlConfig, close };
