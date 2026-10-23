'use strict';
/**
 * Harness for leadEngine.mergeLeads dependent-table treatment.
 * NOT part of tests/run-regressions.cjs allowlist — run directly:
 *   node tests/merge-leads-harness.cjs
 *
 * Builds a throwaway DB from the real src/schema.sql plus the feature-table
 * DDL copied from server/siteModules.js, server/contactForms.js,
 * server/chatbot.js and src/designJobs.js / src/designLearning.js, with
 * foreign_keys=ON (as server/db.js runs it), then merges a source lead
 * that owns the full dependent set into a keeper and asserts the outcome.
 * Duplicate-email leads are seeded with raw SQL on purpose: they model
 * legacy rows that predate the one-email-one-lead enforcement.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const Database = require(path.join(root, 'node_modules/better-sqlite3'));
const engine = require(path.join(root, 'src/leadEngine.js'));

const results = [];
function check(name, fn) {
  fn();
  results.push(name);
  console.log('ok -', name);
}
const count = (db, table, leadId) =>
  db.prepare(`SELECT COUNT(*) c FROM ${table} WHERE lead_id = ?`).get(leadId).c;

function freshDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(root, 'src/schema.sql'), 'utf8'));
  db.exec(`
    CREATE TABLE IF NOT EXISTS booking_settings (
      lead_id INTEGER PRIMARY KEY, timezone TEXT NOT NULL DEFAULT 'America/New_York',
      slot_interval_minutes INTEGER NOT NULL DEFAULT 30, min_notice_hours INTEGER NOT NULL DEFAULT 2,
      max_days_ahead INTEGER NOT NULL DEFAULT 60, auto_confirm INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS booking_services (
      id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id INTEGER NOT NULL, name TEXT NOT NULL,
      slug TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', duration_minutes INTEGER NOT NULL DEFAULT 30,
      buffer_minutes INTEGER NOT NULL DEFAULT 0, price_cents INTEGER NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'USD', image_url TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft', sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(lead_id, slug));
    CREATE TABLE IF NOT EXISTS booking_hours (
      id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id INTEGER NOT NULL, weekday INTEGER NOT NULL,
      start_time TEXT NOT NULL, end_time TEXT NOT NULL,
      UNIQUE(lead_id, weekday, start_time, end_time));
    CREATE TABLE IF NOT EXISTS booking_blocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id INTEGER NOT NULL, block_date TEXT NOT NULL,
      start_time TEXT NOT NULL DEFAULT '', end_time TEXT NOT NULL DEFAULT '', reason TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id INTEGER NOT NULL, service_id INTEGER NOT NULL,
      customer_name TEXT NOT NULL, customer_email TEXT NOT NULL DEFAULT '', customer_phone TEXT NOT NULL DEFAULT '',
      starts_at TEXT NOT NULL, ends_at TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending');
    CREATE TABLE IF NOT EXISTS contact_forms (
      id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id INTEGER NOT NULL,
      name TEXT NOT NULL DEFAULT 'Contact form', title TEXT NOT NULL DEFAULT 'Contact Us',
      intro TEXT NOT NULL DEFAULT '', submit_label TEXT NOT NULL DEFAULT 'Send Message',
      success_message TEXT NOT NULL DEFAULT 'Thanks', notify_email TEXT NOT NULL DEFAULT '',
      public_token TEXT, published INTEGER NOT NULL DEFAULT 0, published_to_site INTEGER NOT NULL DEFAULT 0,
      embed_enabled INTEGER NOT NULL DEFAULT 1, target_page_slug TEXT NOT NULL DEFAULT 'contact',
      sort_order INTEGER NOT NULL DEFAULT 0, form_kind TEXT, status TEXT NOT NULL DEFAULT 'draft',
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS form_submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, form_id INTEGER NOT NULL, lead_id INTEGER NOT NULL,
      payload_json TEXT, encrypted_payload TEXT, routing TEXT NOT NULL DEFAULT 'email',
      muse_delivered INTEGER NOT NULL DEFAULT 0, muse_error TEXT, ip TEXT, user_agent TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS site_module_embeds (
      id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id INTEGER NOT NULL, module_type TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '', public_token TEXT, published INTEGER NOT NULL DEFAULT 0,
      embed_enabled INTEGER NOT NULL DEFAULT 1, target_page_slug TEXT NOT NULL DEFAULT '',
      settings_json TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(lead_id, module_type));
    CREATE TABLE IF NOT EXISTS chatbot_settings (
      lead_id INTEGER PRIMARY KEY, greeting TEXT NOT NULL DEFAULT '',
      bubble_label TEXT NOT NULL DEFAULT 'Chat', primary_color TEXT NOT NULL DEFAULT '',
      position TEXT NOT NULL DEFAULT 'bottom-right', escalate_email TEXT NOT NULL DEFAULT '',
      escalate_notify_portal INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS design_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, title TEXT NOT NULL,
      instructions TEXT NOT NULL, lead_id INTEGER, status TEXT NOT NULL DEFAULT 'waiting_on_agent');
    CREATE TABLE IF NOT EXISTS design_learning_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT NOT NULL, design_job_id INTEGER,
      lead_id INTEGER, request_kind TEXT, category TEXT);
  `);
  // Mirror prod's legacy tenant DB: schema.sql creates the partial unique
  // index on email_norm for FRESH databases, but on prod it DEFERRED
  // (log-and-continue in ensureLeadColumns) because duplicate emails were
  // already present. Drop it here so legacy duplicate rows can exist;
  // mergeLeads calls ensureLeadColumns itself, which re-attempts the index
  // creation and defers again, exactly as in prod.
  db.exec('DROP INDEX IF EXISTS idx_leads_email_norm_unique');
  return db;
}

/** Insert a lead directly (legacy-style, bypasses create-time enforcement). */
function rawLead(db, name, email, phone) {
  const info = db
    .prepare('INSERT INTO leads (business_name, email, email_norm, phone, status) VALUES (?, ?, ?, ?, ?)')
    .run(name, email, email ? email.trim().toLowerCase() : '', phone || null, 'new');
  return Number(info.lastInsertRowid);
}

/* ------------------------------------------------------------------ */
/* Scenario A: full dependent set, source -> keeper                    */
/* ------------------------------------------------------------------ */
{
  const db = freshDb();
  const keep = rawLead(db, 'Keeper Biz', 'shared@example.com', '');
  const drop = rawLead(db, 'Dupe Biz', 'shared@example.com', '555-0100');

  // Keeper's own rows (some keys collide with the source's on purpose).
  db.prepare("INSERT INTO ai_usage (task, model, lead_id) VALUES ('qa','m',?)").run(keep);
  db.prepare("INSERT INTO booking_services (lead_id, name, slug) VALUES (?, 'Keeper Cut', 'cut')").run(keep);
  db.prepare("INSERT INTO booking_hours (lead_id, weekday, start_time, end_time) VALUES (?, 1, '09:00', '17:00')").run(keep);
  db.prepare("INSERT INTO site_module_embeds (lead_id, module_type) VALUES (?, 'booking')").run(keep);
  db.prepare("INSERT INTO chatbot_settings (lead_id, greeting) VALUES (?, 'keeper greeting')").run(keep);

  // Source's dependent set — mirrors prod lead 185's shape and more.
  for (let i = 0; i < 3; i++)
    db.prepare("INSERT INTO ai_usage (task, model, lead_id) VALUES ('design','m',?)").run(drop);
  db.prepare("INSERT INTO booking_settings (lead_id, timezone) VALUES (?, 'America/Chicago')").run(drop);
  const svcKeep = db.prepare("INSERT INTO booking_services (lead_id, name, slug) VALUES (?, 'Drop Trim', 'trim') RETURNING id").get(drop).id;
  db.prepare("INSERT INTO booking_services (lead_id, name, slug) VALUES (?, 'Drop Cut (dupe slug)', 'cut')").run(drop);
  db.prepare("INSERT INTO booking_hours (lead_id, weekday, start_time, end_time) VALUES (?, 1, '09:00', '17:00')").run(drop); // collides
  db.prepare("INSERT INTO booking_hours (lead_id, weekday, start_time, end_time) VALUES (?, 2, '10:00', '12:00')").run(drop); // moves
  db.prepare("INSERT INTO bookings (lead_id, service_id, customer_name, starts_at, ends_at) VALUES (?, ?, 'Cust A', '2026-11-01 09:00', '2026-11-01 09:30')").run(drop, svcKeep);
  db.prepare("INSERT INTO bookings (lead_id, service_id, customer_name, starts_at, ends_at) VALUES (?, ?, 'Cust B', '2026-11-02 09:00', '2026-11-02 09:30')").run(drop, svcKeep);
  const formId = db.prepare("INSERT INTO contact_forms (lead_id, name) VALUES (?, 'Drop Form') RETURNING id").get(drop).id;
  db.prepare("INSERT INTO form_submissions (form_id, lead_id, payload_json) VALUES (?, ?, '{}')").run(formId, drop);
  db.prepare("INSERT INTO form_submissions (form_id, lead_id, payload_json) VALUES (?, ?, '{}')").run(formId, drop);
  db.prepare("INSERT INTO site_module_embeds (lead_id, module_type) VALUES (?, 'booking')").run(drop); // collides
  db.prepare("INSERT INTO site_module_embeds (lead_id, module_type) VALUES (?, 'chatbot')").run(drop); // moves
  db.prepare("INSERT INTO chatbot_settings (lead_id, greeting) VALUES (?, 'drop greeting')").run(drop);
  db.prepare("INSERT INTO websites (lead_id, name, theme, pages) VALUES (?, 'Drop Site', '{}', '[]')").run(drop);
  db.prepare("INSERT INTO design_jobs (type, title, instructions, lead_id) VALUES ('website','t','i',?)").run(drop);
  db.prepare("INSERT INTO design_learning_events (event_type, lead_id) VALUES ('delivered', ?)").run(drop);
  db.prepare("INSERT INTO business_facts (lead_id, fact_key, value, source, claim_class) VALUES (?, 'site.style_guide', '{}', 'manual', 'UNKNOWN')").run(drop);
  db.prepare("INSERT INTO lead_scores (lead_id, score, breakdown) VALUES (?, 55, '{}')").run(drop);
  const campId = db.prepare("INSERT INTO campaigns (name) VALUES ('c1') RETURNING id").get().id;
  db.prepare("INSERT INTO campaign_messages (campaign_id, lead_id, to_email, subject, body) VALUES (?, ?, 'a@b.c', 's', 'b')").run(campId, drop);
  db.prepare("INSERT INTO intent_scores (lead_id, score, label) VALUES (?, 40, 'Warm')").run(drop);
  db.prepare("INSERT INTO prospect_events (lead_id, type) VALUES (?, 'preview.opened')").run(drop);

  const merged = engine.mergeLeads(db, keep, [drop]);

  check('merge returns keeper, source lead gone', () => {
    assert.equal(merged.id, keep);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM leads WHERE id = ?').get(drop).c, 0);
  });
  check('fill-fields preserved: keeper empty phone filled from source', () => {
    assert.equal(merged.phone, '555-0100');
  });
  check('ai_usage reassigned (NO ACTION FK no longer blocks)', () => {
    assert.equal(count(db, 'ai_usage', keep), 4);
  });
  check('website reassigned to keeper, not cascade-deleted', () => {
    const w = db.prepare('SELECT lead_id FROM websites').all();
    assert.equal(w.length, 1);
    assert.equal(w[0].lead_id, keep);
  });
  check('singleton booking_settings: keeper had none -> source row moves', () => {
    const s = db.prepare('SELECT timezone FROM booking_settings WHERE lead_id = ?').get(keep);
    assert.equal(s.timezone, 'America/Chicago');
  });
  check('singleton chatbot_settings: keeper row wins over source', () => {
    const rows = db.prepare('SELECT greeting FROM chatbot_settings').all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].greeting, 'keeper greeting');
  });
  check('booking_services dedupe: keeper slug wins, other service moves', () => {
    const rows = db.prepare('SELECT slug FROM booking_services WHERE lead_id = ? ORDER BY slug').all(keep);
    assert.deepEqual(rows.map((r) => r.slug), ['cut', 'trim']);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM booking_services').get().c, 2);
  });
  check('booking_hours dedupe: colliding window dropped, other moves', () => {
    assert.equal(count(db, 'booking_hours', keep), 2);
  });
  check('bookings moved and still point at the moved service', () => {
    const rows = db.prepare('SELECT service_id FROM bookings WHERE lead_id = ?').all(keep);
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.service_id === svcKeep));
  });
  check('contact form + its submissions moved', () => {
    assert.equal(count(db, 'contact_forms', keep), 1);
    assert.equal(count(db, 'form_submissions', keep), 2);
  });
  check('site_module_embeds dedupe by module_type', () => {
    const rows = db.prepare('SELECT module_type FROM site_module_embeds WHERE lead_id = ? ORDER BY module_type').all(keep);
    assert.deepEqual(rows.map((r) => r.module_type), ['booking', 'chatbot']);
  });
  check('design job + learning event + facts/scores/intent/prospect/campaign rows moved', () => {
    assert.equal(count(db, 'design_jobs', keep), 1);
    assert.equal(count(db, 'design_learning_events', keep), 1);
    assert.equal(count(db, 'business_facts', keep), 1);
    assert.equal(count(db, 'lead_scores', keep), 1);
    assert.equal(count(db, 'intent_scores', keep), 1);
    assert.equal(count(db, 'prospect_events', keep), 1);
    assert.equal(count(db, 'campaign_messages', keep), 1);
  });
  check('no row anywhere still references the dropped lead; FK check clean', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((r) => r.name);
    for (const t of tables) {
      const cols = db.prepare(`PRAGMA table_info(${t})`).all();
      if (!cols.some((c) => c.name === 'lead_id')) continue;
      assert.equal(count(db, t, drop), 0, `${t} still references dropped lead`);
    }
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  });
  db.close();
}

/* ------------------------------------------------------------------ */
/* Scenario B: both leads own a website -> merge aborts, nothing moves */
/* ------------------------------------------------------------------ */
{
  const db = freshDb();
  const keep = rawLead(db, 'Site Keeper', 'a@example.com');
  const drop = rawLead(db, 'Site Drop', 'b@example.com');
  db.prepare("INSERT INTO websites (lead_id, name, theme, pages) VALUES (?, 'K', '{}', '[]')").run(keep);
  db.prepare("INSERT INTO websites (lead_id, name, theme, pages) VALUES (?, 'D', '{}', '[]')").run(drop);
  db.prepare("INSERT INTO ai_usage (task, model, lead_id) VALUES ('qa','m',?)").run(drop);
  check('both-websites merge throws a website conflict and rolls back fully', () => {
    assert.throws(() => engine.mergeLeads(db, keep, [drop]), /both own a website/);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM leads').get().c, 2);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM websites').get().c, 2);
    assert.equal(count(db, 'ai_usage', drop), 1);
  });
  db.close();
}

/* ------------------------------------------------------------------ */
/* Scenario C: DUPLICATE_EMAIL merge guard still fires                 */
/* ------------------------------------------------------------------ */
{
  const db = freshDb();
  const keep = rawLead(db, 'No Email Keeper', '');
  const drop = rawLead(db, 'Has Email', 'taken@example.com');
  const third = rawLead(db, 'Third Owner', 'taken@example.com');
  check('keeper inheriting a third lead\'s email is refused (DUPLICATE_EMAIL)', () => {
    assert.throws(
      () => engine.mergeLeads(db, keep, [drop]),
      (e) => e.code === 'DUPLICATE_EMAIL' && e.existingLeadId === third
    );
    // Rolled back: all three leads still exist.
    assert.equal(db.prepare('SELECT COUNT(*) c FROM leads').get().c, 3);
  });
  db.close();
}

console.log(JSON.stringify({ harness: 'merge-leads', checks: results.length, passed: true }));
