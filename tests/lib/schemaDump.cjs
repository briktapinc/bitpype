'use strict';
// Batch 112 — platform schema dumper for the parity suite.
// Runs server/db.js migrate() against the env-selected database and
// prints one line:  SCHEMA_JSON {"table":[sorted column names],...}
// SQLite introspection reads the file directly with better-sqlite3
// (the facade's query() only routes SELECT/WITH to .all()); MySQL
// introspection goes through the facade against information_schema.
(async () => {
  const db = require('../../server/db');
  await db.migrate();
  const schema = {};
  if ((process.env.DB_DRIVER || '') === 'sqlite') {
    const Database = require('better-sqlite3');
    const file = process.env.SQLITE_PATH;
    if (!file) throw new Error('SQLITE_PATH required for sqlite schema dump');
    const ro = new Database(file, { readonly: true });
    const tables = ro
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all();
    for (const t of tables) {
      schema[t.name] = ro
        .prepare(`PRAGMA table_info(${t.name})`)
        .all()
        .map((c) => c.name)
        .sort();
    }
    ro.close();
  } else {
    const tables = await db.query(
      'SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME'
    );
    for (const row of tables) {
      const cols = await db.query(
        'SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :t ORDER BY COLUMN_NAME',
        { t: row.t }
      );
      schema[row.t] = cols.map((c) => c.c).sort();
    }
  }
  console.log('SCHEMA_JSON ' + JSON.stringify(schema));
  process.exit(0);
})().catch((e) => {
  console.error('schemaDump failed:', (e && e.stack) || e);
  process.exit(1);
});
