'use strict';

/**
 * Batch 177 — installer helper: set the demo portal account's
 * one-time password ON THE OWNER'S SERVER.
 *
 * A standalone package whose client had no BitPype portal account
 * carries a demo portal account in its seed (created by
 * server/standaloneBackup.js) whose password hash is bcrypt over a
 * throwaway random value — the plaintext exists nowhere, so the
 * account cannot be logged into as shipped, by design. This script
 * is the only place a usable demo password ever exists: install.sh
 * runs it inside the clone's app container on first install,
 * captures the single stdout line, and prints it once in the
 * completion summary with a change-it-after-login instruction. The
 * password is generated here, on the owner's machine, at install
 * time — it is never part of the package, the seed, any log, or the
 * manifest.
 *
 * Usage: node standalone/set-demo-password.js <demo-account-email>
 * Env:   SQLITE_PATH — the clone's platform DB (the compose stack
 *        sets /data/platform.sqlite; that is also the default).
 * Output: exactly one line on stdout — the new password. All
 * diagnostics go to stderr.
 */

const fs = require('fs');
const crypto = require('crypto');

const email = String(process.argv[2] || '')
  .trim()
  .toLowerCase();
if (!email || !email.includes('@')) {
  console.error('usage: set-demo-password.js <demo-account-email>');
  process.exit(2);
}

const dbPath = process.env.SQLITE_PATH || '/data/platform.sqlite';
if (!fs.existsSync(dbPath)) {
  console.error(`platform database not found at ${dbPath}`);
  process.exit(1);
}

const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const db = new Database(dbPath);
try {
  const row = db.prepare('SELECT id FROM client_portal_users WHERE email = ?').get(email);
  if (!row) {
    console.error(`no portal account found for ${email} — nothing changed`);
    process.exit(1);
  }
  // 16 URL-safe characters — same shape as the platform's own
  // generated passwords (portalAccounts.generatePassword), longer.
  const password = crypto.randomBytes(12).toString('base64url');
  const hash = bcrypt.hashSync(password, 12);
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  db.prepare('UPDATE client_portal_users SET password_hash = ?, updated_at = ? WHERE id = ?').run(hash, now, row.id);
  process.stdout.write(password + '\n');
} finally {
  db.close();
}
