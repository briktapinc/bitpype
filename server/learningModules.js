'use strict';

/**
 * Batch 194 — portal Training (learning) modules.
 *
 * Platform-level catalog (one list for every workspace, like upsell
 * tips): each module is a short video + its transcript. Admin manages
 * the catalog from Admin → Training (add / edit / remove / reorder /
 * publish toggle, via server/routes/admin.js); the portal Training
 * tab lists PUBLISHED modules only, in admin-set order.
 *
 * Seeding: the 17 launch modules (server/learningSeed.js — the
 * "BitPype Basics" portal-section videos) are inserted the first time
 * the catalog is read while empty. Seeding is by slug and only ever
 * runs on an EMPTY table, so admin edits/removals are never undone
 * by a re-seed.
 */

const { query, driver } = require('./db');
const SEED = require('./learningSeed');

let seeded = false;

async function ensureSeeded() {
  if (seeded) return;
  const rows = await query('SELECT COUNT(*) AS n FROM learning_modules');
  const n = rows && rows[0] ? Number(rows[0].n) : 0;
  if (n === 0) {
    for (const m of SEED) {
      await query(
        `INSERT INTO learning_modules
           (slug, title, transcript, video_url, video_mobile_url, sort_order, published)
         VALUES (:slug, :title, :transcript, :videoUrl, :videoMobileUrl, :sortOrder, :published)`,
        {
          slug: m.slug,
          title: m.title,
          transcript: m.transcript,
          videoUrl: m.videoUrl,
          videoMobileUrl: m.videoMobileUrl,
          sortOrder: m.sortOrder,
          published: m.published ? 1 : 0,
        }
      );
    }
  }
  seeded = true;
}

function view(row, { withUnpublished = false } = {}) {
  if (!row) return null;
  const out = {
    id: Number(row.id),
    slug: row.slug,
    title: row.title,
    transcript: row.transcript || '',
    videoUrl: row.video_url || '',
    videoMobileUrl: row.video_mobile_url || '',
    sortOrder: Number(row.sort_order) || 0,
    published: Number(row.published) === 1,
  };
  if (!withUnpublished) delete out.published;
  return out;
}

/** Portal view: published modules only, admin order. */
async function listPublished() {
  await ensureSeeded();
  const rows = await query('SELECT * FROM learning_modules WHERE published = 1 ORDER BY sort_order ASC, id ASC');
  return rows.map((r) => view(r));
}

/** Admin view: everything, admin order. */
async function listAll() {
  await ensureSeeded();
  const rows = await query('SELECT * FROM learning_modules ORDER BY sort_order ASC, id ASC');
  return rows.map((r) => view(r, { withUnpublished: true }));
}

function slugify(title) {
  const s = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
  return s || 'module';
}

function cleanModuleInput(input = {}) {
  const title = String(input.title || '')
    .trim()
    .slice(0, 200);
  if (!title) throw Object.assign(new Error('Title is required'), { code: 'INVALID' });
  return {
    title,
    transcript: String(input.transcript || '').slice(0, 100000),
    videoUrl: String(input.videoUrl ?? input.video_url ?? '')
      .trim()
      .slice(0, 500),
    videoMobileUrl: String(input.videoMobileUrl ?? input.video_mobile_url ?? '')
      .trim()
      .slice(0, 500),
    sortOrder: Number.isFinite(Number(input.sortOrder ?? input.sort_order))
      ? Math.trunc(Number(input.sortOrder ?? input.sort_order))
      : 0,
    published: input.published === undefined ? true : !!input.published,
  };
}

async function createModule(input = {}) {
  await ensureSeeded();
  const clean = cleanModuleInput(input);
  let slug = slugify(String(input.slug || '').trim() || clean.title);
  // Slugs are the stable public key; uniquify instead of failing.
  const clash = await query('SELECT id FROM learning_modules WHERE slug = :slug', { slug });
  if (clash && clash[0]) slug = `${slug}-${Date.now().toString(36)}`.slice(0, 120);
  const result = await query(
    `INSERT INTO learning_modules
       (slug, title, transcript, video_url, video_mobile_url, sort_order, published)
     VALUES (:slug, :title, :transcript, :videoUrl, :videoMobileUrl, :sortOrder, :published)`,
    { slug, ...clean, published: clean.published ? 1 : 0 }
  );
  const id = result && result.insertId;
  const rows = await query('SELECT * FROM learning_modules WHERE id = :id', { id });
  if (!rows || !rows[0]) {
    const bySlug = await query('SELECT * FROM learning_modules WHERE slug = :slug', { slug });
    return view(bySlug && bySlug[0], { withUnpublished: true });
  }
  return view(rows[0], { withUnpublished: true });
}

async function updateModule(id, input = {}) {
  const mid = Number(id);
  if (!mid) throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' });
  const existing = await query('SELECT * FROM learning_modules WHERE id = :id', { id: mid });
  if (!existing || !existing[0]) throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' });
  const cur = view(existing[0], { withUnpublished: true });
  const merged = {
    title: input.title !== undefined ? input.title : cur.title,
    transcript: input.transcript !== undefined ? input.transcript : cur.transcript,
    videoUrl: input.videoUrl ?? input.video_url ?? cur.videoUrl,
    videoMobileUrl: input.videoMobileUrl ?? input.video_mobile_url ?? cur.videoMobileUrl,
    sortOrder: input.sortOrder ?? input.sort_order ?? cur.sortOrder,
    published: input.published !== undefined ? input.published : cur.published,
  };
  const clean = cleanModuleInput(merged);
  await query(
    `UPDATE learning_modules
        SET title = :title, transcript = :transcript, video_url = :videoUrl,
            video_mobile_url = :videoMobileUrl, sort_order = :sortOrder,
            published = :published
            ${driver() === 'sqlite' ? ", updated_at = datetime('now')" : ''}
      WHERE id = :id`,
    { ...clean, published: clean.published ? 1 : 0, id: mid }
  );
  const rows = await query('SELECT * FROM learning_modules WHERE id = :id', { id: mid });
  return view(rows && rows[0], { withUnpublished: true });
}

async function deleteModule(id) {
  const mid = Number(id);
  if (!mid) throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' });
  const existing = await query('SELECT id, slug FROM learning_modules WHERE id = :id', { id: mid });
  if (!existing || !existing[0]) throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' });
  await query('DELETE FROM learning_modules WHERE id = :id', { id: mid });
  return { deleted: true, id: mid, slug: existing[0].slug };
}

/** Reorder: orderedIds is the full (or partial) id list in new order. */
async function reorderModules(orderedIds) {
  if (!Array.isArray(orderedIds) || !orderedIds.length) {
    throw Object.assign(new Error('orderedIds array is required'), { code: 'INVALID' });
  }
  let step = 10;
  for (const raw of orderedIds) {
    const mid = Number(raw);
    if (!mid) continue;
    await query('UPDATE learning_modules SET sort_order = :o WHERE id = :id', { o: step, id: mid });
    step += 10;
  }
  return listAll();
}

module.exports = {
  ensureSeeded,
  listPublished,
  listAll,
  createModule,
  updateModule,
  deleteModule,
  reorderModules,
  slugify,
};
