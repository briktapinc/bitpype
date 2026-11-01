'use strict';
// Batch 112 — dialect-aware platform-DB helpers for suites.
//
// Several suites write or probe the PLATFORM database directly
// (toggling a setting, aging a row, asserting a table exists). Those
// helpers were written as raw SQLite SQL sent through the facade,
// which only ever ran in the SQLite gate. These helpers branch on
// the facade's own driver() so the same suite code runs correctly
// in both gate passes. App code is never involved.
async function setPlatformSetting(db, key, value) {
  if (db.driver() === 'mysql') {
    await db.query(
      'INSERT INTO platform_settings (`key`, value) VALUES (:key, :value) ON DUPLICATE KEY UPDATE value = VALUES(value)',
      { key, value }
    );
  } else {
    await db.query(
      'INSERT INTO platform_settings (key, value) VALUES (:key, :value) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      { key, value }
    );
  }
}

// SQL expression for "now minus N minutes" in stored-datetime terms.
// Both dialects store UTC (SQLite datetime('now') is UTC; the MySQL
// facade pins timezone 'Z'), so the expressions are equivalent.
function minutesAgoExpr(driver, minutes) {
  const n = Math.max(0, Math.floor(Number(minutes) || 0));
  return driver === 'mysql' ? `DATE_SUB(UTC_TIMESTAMP(), INTERVAL ${n} MINUTE)` : `datetime('now', '-${n} minutes')`;
}

// Column names of a platform table, in declaration order.
async function platformColumns(db, table) {
  if (db.driver() === 'mysql') {
    const rows = await db.query(
      'SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :t ORDER BY ORDINAL_POSITION',
      { t: table }
    );
    return rows.map((r) => r.name);
  }
  // The facade's query() cannot return PRAGMA rows (it routes only
  // SELECT/WITH to .all()), so read the file directly, as the suites
  // always have.
  const Database = require('better-sqlite3');
  const ro = new Database(db.sqlitePath(), { readonly: true });
  try {
    return ro
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((r) => r.name);
  } finally {
    ro.close();
  }
}

// Names of platform tables matching a LIKE pattern (e.g. 'mailing_list%').
async function platformTablesLike(db, pattern) {
  if (db.driver() === 'mysql') {
    const rows = await db.query(
      'SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE :p ORDER BY TABLE_NAME',
      { p: pattern }
    );
    return rows.map((r) => r.name);
  }
  const rows = await db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE :p ORDER BY name", {
    p: pattern,
  });
  return rows.map((r) => r.name);
}

module.exports = { setPlatformSetting, minutesAgoExpr, platformColumns, platformTablesLike };
