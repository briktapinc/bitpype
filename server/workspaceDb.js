'use strict';

/**
 * Per-workspace SQLite stores: every tenant's domain data (leads, design
 * jobs, websites, outreach, settings) lives in its own
 * data/workspaces/<id>/websitescout.db, opened here and handed to the
 * src/ engines. The CENTRAL db (server/db.js — MySQL in production,
 * SQLite locally) holds only users / workspaces / auth tokens / billing.
 * DB_DRIVER therefore does NOT move tenant data.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const caches = new Map(); // workspaceId -> Database
const CACHE_MAX = Math.min(500, Math.max(32, Number(process.env.WORKSPACE_DB_CACHE_MAX) || 128));

/* Batch 145 (external review F10): handle leases. A caller doing
 * async work across awaits (domain.withDb) acquires a lease on
 * entry and releases it when done; eviction NEVER closes a handle
 * with a non-zero lease count — the old unconditional LRU close
 * killed in-flight operations mid-await ("The database connection
 * is not open" after external side effects had already run). */
const leases = new Map(); // workspaceId -> active lease count
const readonlyHandles = new Set(); // workspaceIds cached from a {create:false} open

function leaseCount(workspaceId) {
  return leases.get(Number(workspaceId)) || 0;
}

function acquireWorkspaceDb(workspaceId, opts) {
  const db = openWorkspaceDb(workspaceId, opts);
  if (db) leases.set(Number(workspaceId), leaseCount(workspaceId) + 1);
  return db;
}

function releaseWorkspaceDb(idOrDb) {
  let id = Number(idOrDb);
  if (!Number.isInteger(id) || id <= 0) {
    id = null;
    for (const [wid, db] of caches) {
      if (db === idOrDb) {
        id = wid;
        break;
      }
    }
    if (id == null) return;
  }
  const n = leaseCount(id) - 1;
  if (n > 0) leases.set(id, n);
  else leases.delete(id);
}

function dataRoot() {
  return process.env.WORKSPACE_DATA_DIR || path.join(__dirname, '..', 'data', 'workspaces');
}

function dbPathFor(workspaceId) {
  return path.join(dataRoot(), String(workspaceId), 'websitescout.db');
}

function evictOldestHandle() {
  if (caches.size < CACHE_MAX) return;
  // Skip leased handles (F10): close the oldest IDLE handle; if
  // every handle is leased, let the cache exceed the cap rather
  // than break an in-flight operation.
  for (const [wid, db] of caches) {
    if (leaseCount(wid) > 0) continue;
    caches.delete(wid);
    readonlyHandles.delete(wid);
    try {
      if (db) db.close();
    } catch {
      /* ignore */
    }
    return;
  }
}

/**
 * Open (or fetch) a workspace DB.
 *
 * opts.create === false (Batch 145, external review F09):
 * NON-CREATING mode for public/read-only paths. Returns null when
 * the tenant DB file does not already exist — no directory, no
 * schema, no migrations, no seeds. A public read must never
 * provision a tenant: before this mode existed, an unauthenticated
 * preview URL with an invented ws-<id> minted a full tenant DB.
 * When the file exists, the handle opens without the
 * ensure/migration passes (read-only gates don't need them).
 */
function openWorkspaceDb(workspaceId, opts = {}) {
  const id = Number(workspaceId);
  if (!Number.isInteger(id) || id <= 0) throw new Error('Invalid workspaceId');
  if (caches.has(id)) {
    const hit = caches.get(id);
    // A handle cached by a non-creating read is READ-ONLY: a caller
    // asking for a normal (writable) open must never inherit it.
    // Close and fall through to a full writable open.
    if (!(opts && opts.create === false) && readonlyHandles.has(id)) {
      caches.delete(id);
      readonlyHandles.delete(id);
      try {
        hit.close();
      } catch {
        /* ignore */
      }
    } else {
      // Refresh insertion order for simple LRU-ish eviction.
      caches.delete(id);
      caches.set(id, hit);
      return hit;
    }
  }

  evictOldestHandle();

  const file = dbPathFor(id);
  if (opts && opts.create === false) {
    if (!fs.existsSync(file)) return null;
    let db;
    try {
      db = new Database(file, { readonly: true });
      readonlyHandles.add(id);
    } catch {
      db = new Database(file);
    }
    caches.set(id, db);
    return db;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const firstRun = !fs.existsSync(file);
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  if (firstRun) {
    const schema = fs.readFileSync(path.join(__dirname, '..', 'src', 'schema.sql'), 'utf8');
    db.exec(schema);
  }

  // Always ensure design tables + column patches exist (idempotent).
  try {
    const design = require('../src/designJobs');
    if (typeof design.ensureTables === 'function') design.ensureTables(db);
  } catch (e) {
    console.warn('[workspaceDb] design.ensureTables:', e.message);
  }
  try {
    const emailRedesign = require('../src/emailRedesign');
    if (typeof emailRedesign.ensureTables === 'function') emailRedesign.ensureTables(db);
  } catch (e) {
    console.warn('[workspaceDb] emailRedesign.ensureTables:', e.message);
  }
  try {
    const designLearning = require('../src/designLearning');
    if (typeof designLearning.ensureTables === 'function') designLearning.ensureTables(db);
  } catch (e) {
    console.warn('[workspaceDb] designLearning.ensureTables:', e.message);
  }
  try {
    // Batch 106: ai_usage.provider attribution column (+ one-time
    // backfill on the open that first adds it).
    require('../src/aiProvider').ensureAiUsageProvider(db);
  } catch (e) {
    console.warn('[workspaceDb] aiProvider.ensureAiUsageProvider:', e.message);
  }
  try {
    const leadEngine = require('../src/leadEngine');
    if (typeof leadEngine.ensureLeadColumns === 'function') leadEngine.ensureLeadColumns(db);
  } catch {
    /* optional */
  }
  try {
    const websiteEngine = require('../src/websiteEngine');
    if (typeof websiteEngine.ensureTables === 'function') websiteEngine.ensureTables(db);
  } catch {
    /* optional */
  }
  try {
    const socialMedia = require('../src/socialMedia');
    if (typeof socialMedia.ensureTables === 'function') socialMedia.ensureTables(db);
  } catch (e) {
    console.warn('[workspaceDb] socialMedia.ensureTables:', e.message);
  }
  try {
    const outreach = require('../src/outreach');
    if (typeof outreach.ensureTables === 'function') outreach.ensureTables(db);
  } catch (e) {
    console.warn('[workspaceDb] outreach.ensureTables:', e.message);
  }
  try {
    const siteModules = require('./siteModules');
    if (typeof siteModules.ensureTables === 'function') siteModules.ensureTables(db);
  } catch (e) {
    console.warn('[workspaceDb] siteModules.ensureTables:', e.message);
  }
  try {
    const cfDomains = require('../src/cfDomains');
    if (typeof cfDomains.ensureTables === 'function') cfDomains.ensureTables(db);
  } catch (e) {
    console.warn('[workspaceDb] cfDomains.ensureTables:', e.message);
  }

  if (firstRun) {
    // Seed settings/prompts only — skip demo leads for multi-tenant workspaces.
    const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
    const { SETTING_SEEDS, PROMPT_SEEDS } = require('../src/seed');
    for (const [key, value] of SETTING_SEEDS) insertSetting.run(key, value);
    try {
      const platform = require('./platform');
      // Fill missing keys only — never overwrite settings the workspace already changed.
      platform
        .workspaceSeedFromPlatform()
        .then((seed) => {
          const insertIgnore = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
          for (const [key, value] of Object.entries(seed)) {
            if (value != null && String(value).trim() !== '') insertIgnore.run(key, value);
          }
        })
        .catch(() => {});
    } catch {
      /* optional */
    }
    const insertPrompt = db.prepare('INSERT OR IGNORE INTO prompts (key, name, body) VALUES (?, ?, ?)');
    for (const p of PROMPT_SEEDS) insertPrompt.run(p.key, p.name, p.body);
  }

  // SQLite is the runtime source of truth for automation_paused.
  // Only fill the key when this workspace has never set it — never overwrite.
  try {
    const { getSetting: mysqlGet } = require('./workspace');
    mysqlGet(id, 'automation_paused', null)
      .then((v) => {
        if (v == null || String(v).trim() === '') return;
        db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('automation_paused', String(v));
      })
      .catch(() => {});
  } catch {
    /* ignore */
  }

  // Lazy migration (port of audit M6): encrypt any secret settings
  // still stored as plaintext. Runs on every open when an encryption
  // key is configured; idempotent (enc:v1: values are skipped) and
  // best-effort (a failure must never block opening the workspace).
  try {
    const secretBox = require('../src/secretBox');
    if (secretBox.hasKey()) {
      const { SECRET_KEYS } = require('./settingsKeys');
      const rows = db.prepare('SELECT key, value FROM settings').all();
      const upd = db.prepare('UPDATE settings SET value = ? WHERE key = ?');
      for (const r of rows) {
        if (SECRET_KEYS.includes(r.key) && r.value && !secretBox.isEncrypted(r.value)) {
          upd.run(secretBox.encryptValue(r.value), r.key);
        }
      }
    }
  } catch (e) {
    console.warn('[workspaceDb] secret migration:', e.message);
  }

  caches.set(id, db);
  return db;
}

/**
 * Batch 192 (Greptile verification #11): a WRITABLE handle for a
 * workspace whose DB file ALREADY exists — for writers that must not
 * provision a tenant (the standalone-backup generator) but cannot
 * work through the cached readonly:true handle a {create:false}
 * read leaves behind. When the cache holds the readonly handle it
 * is closed and reopened writable — the exact upgrade a normal
 * openWorkspaceDb() call performs on a cache hit (see above), so
 * readonly protections for {create:false} readers are unchanged:
 * they still get a readonly handle, and only an explicit caller of
 * this function upgrades it. Returns null when no tenant DB file
 * exists (never creates one). Leases: no lease is taken or needed —
 * the returned handle is the shared cached one, same as a plain
 * openWorkspaceDb() result.
 */
function openExistingWorkspaceDbWritable(workspaceId) {
  const id = Number(workspaceId);
  if (!Number.isInteger(id) || id <= 0) throw new Error('Invalid workspaceId');
  if (caches.has(id) && !readonlyHandles.has(id)) return caches.get(id);
  if (!fs.existsSync(dbPathFor(id))) return null;
  if (caches.has(id)) {
    // Cached readonly handle — close it and fall through to the
    // full writable open, mirroring the normal-open upgrade path.
    const hit = caches.get(id);
    caches.delete(id);
    readonlyHandles.delete(id);
    try {
      hit.close();
    } catch {
      /* ignore */
    }
  }
  return openWorkspaceDb(id);
}

function closeAll() {
  for (const db of caches.values()) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
  caches.clear();
  leases.clear();
  readonlyHandles.clear();
}

module.exports = {
  openWorkspaceDb,
  openExistingWorkspaceDbWritable,
  acquireWorkspaceDb,
  releaseWorkspaceDb,
  leaseCount,
  dbPathFor,
  dataRoot,
  closeAll,
};
