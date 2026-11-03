'use strict';

/**
 * Batch 124 — THE CATEGORIES SERVICE (Ely, 2026-11-03).
 *
 * "Add a categories module that other modules can use to create
 * categories for themselves." A category is created FOR one consuming
 * module type (its `scope` — e.g. 'events', 'blog') and items of that
 * module are organized by ASSIGNMENT rows, so any module's items can
 * be categorized WITHOUT altering that module's own tables:
 *
 *   module_categories            — the taxonomy itself (per lead)
 *   module_category_assignments  — the generic join (any item of any
 *                                  module ↔ any category of its scope)
 *
 * This service is built INTO the Batch 122 shared layer, per Ely's
 * standing interdependence rule: moduleShare registers 'categories'
 * as a provider (categories as uniform items) and exposes the
 * items-by-category read, and assignments resolve a category's items
 * through moduleShare's uniform provider readers — published-only,
 * strictly lead-scoped, dormant-empty. There is ONE service: the
 * portal editors, the MCP tools and the design agent all call these
 * same functions — no agent-only back door.
 *
 * Assignments key on ids, never slugs, so renaming or re-slugging a
 * category (or an item) can never break them. Deleting a category
 * removes its assignments and re-parents its child categories to the
 * deleted category's parent — the items themselves are never touched.
 *
 * Menu's private menu_categories system predates this service and is
 * NOT migrated or disturbed — it stays as the one standing exception.
 */

const modules = require('./siteModules');
const share = require('./moduleShare');

function fail(code, message, status) {
  const err = new Error(message);
  err.code = code;
  if (status) err.status = status;
  return err;
}

function slugify(raw, fallback = 'item') {
  const s = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return s || fallback;
}

function ensureTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS module_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      scope TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      slug TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      image_url TEXT NOT NULL DEFAULT '',
      parent_id INTEGER,
      status TEXT NOT NULL DEFAULT 'draft',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(lead_id, scope, slug)
    );
    CREATE INDEX IF NOT EXISTS idx_module_categories_lead ON module_categories(lead_id, scope);
    CREATE TABLE IF NOT EXISTS module_category_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      consumer_type TEXT NOT NULL,
      item_id INTEGER NOT NULL,
      category_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(lead_id, consumer_type, item_id, category_id)
    );
    CREATE INDEX IF NOT EXISTS idx_module_category_assignments_lead
      ON module_category_assignments(lead_id, consumer_type, item_id);
    CREATE INDEX IF NOT EXISTS idx_module_category_assignments_category
      ON module_category_assignments(lead_id, category_id);
  `);
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

function cleanScope(raw) {
  const scope = String(raw || '')
    .trim()
    .toLowerCase();
  if (!scope) throw fail('VALIDATION', 'scope is required — the module type this category belongs to');
  if (!modules.MODULE_TYPES.includes(scope)) {
    throw fail('VALIDATION', `Unknown scope: ${raw}. Use a module type: ${modules.MODULE_TYPES.join(', ')}`);
  }
  return scope;
}

function cleanStatus(raw, fallback) {
  if (raw == null) return fallback;
  return String(raw).toLowerCase() === 'published' ? 'published' : 'draft';
}

/** A category's parent must be a category of the SAME lead + scope,
 *  never the category itself, and never one of its descendants. */
function assertValidParent(db, lid, scope, parentId, selfId) {
  if (parentId == null || parentId === '') return null;
  const pid = Number(parentId);
  if (!Number.isInteger(pid) || pid <= 0) throw fail('VALIDATION', 'parent_id must be a category id');
  if (selfId && pid === Number(selfId)) throw fail('VALIDATION', 'A category cannot be its own parent');
  const parent = db.prepare('SELECT * FROM module_categories WHERE lead_id = ? AND id = ?').get(lid, pid);
  if (!parent) throw fail('VALIDATION', `Parent category #${pid} does not exist for this business`);
  if (parent.scope !== scope) {
    throw fail('VALIDATION', `Parent category #${pid} belongs to scope '${parent.scope}', not '${scope}'`);
  }
  // Cycle walk: the new parent may not sit below the category itself.
  let cursor = parent;
  const seen = new Set();
  while (cursor && cursor.parent_id != null) {
    if (selfId && Number(cursor.parent_id) === Number(selfId)) {
      throw fail('VALIDATION', 'That parent would make the category its own ancestor');
    }
    if (seen.has(cursor.id)) break;
    seen.add(cursor.id);
    cursor = db.prepare('SELECT * FROM module_categories WHERE lead_id = ? AND id = ?').get(lid, cursor.parent_id);
  }
  return pid;
}

/* ------------------------------------------------------------------ */
/* Category CRUD                                                       */
/* ------------------------------------------------------------------ */

/** Assignment totals per category for one lead: { categoryId: n }. */
function assignmentCounts(db, lid) {
  const rows = db
    .prepare(
      'SELECT category_id, COUNT(*) AS c FROM module_category_assignments WHERE lead_id = ? GROUP BY category_id'
    )
    .all(lid);
  const out = new Map();
  for (const r of rows) out.set(Number(r.category_id), Number(r.c) || 0);
  return out;
}

/** Published-item counts per category: assignments ∩ the items the
 *  scope's shared-layer provider actually publishes for this lead —
 *  the count a public category view will really show. */
function publishedCounts(db, lid, categories) {
  const out = new Map();
  const scopes = [...new Set(categories.map((c) => c.scope))];
  for (const scope of scopes) {
    const publishedIds = new Set(share.readProviderItems(db, lid, scope).map((i) => Number(i.source_id)));
    if (!publishedIds.size) continue;
    const rows = db
      .prepare('SELECT category_id, item_id FROM module_category_assignments WHERE lead_id = ? AND consumer_type = ?')
      .all(lid, scope);
    for (const r of rows) {
      if (publishedIds.has(Number(r.item_id)))
        out.set(Number(r.category_id), (out.get(Number(r.category_id)) || 0) + 1);
    }
  }
  return out;
}

function decorateCounts(db, lid, rows, countsMode) {
  if (!rows.length) return rows;
  const counts = countsMode === 'published' ? publishedCounts(db, lid, rows) : assignmentCounts(db, lid);
  return rows.map((r) => ({ ...r, item_count: counts.get(Number(r.id)) || 0 }));
}

function listCategories(db, leadId, { scope = null, includeDrafts = true, counts = 'all' } = {}) {
  ensureTables(db);
  const lid = Number(leadId);
  let sql = 'SELECT * FROM module_categories WHERE lead_id = ?';
  const params = [lid];
  if (scope) {
    sql += ' AND scope = ?';
    params.push(cleanScope(scope));
  }
  if (!includeDrafts) sql += " AND status = 'published'";
  sql += ' ORDER BY sort_order ASC, name ASC, id ASC';
  return decorateCounts(db, lid, db.prepare(sql).all(...params), counts);
}

function getCategory(db, leadId, idOrSlug, { scope = null } = {}) {
  ensureTables(db);
  const lid = Number(leadId);
  let row;
  if (/^\d+$/.test(String(idOrSlug))) {
    row = db.prepare('SELECT * FROM module_categories WHERE lead_id = ? AND id = ?').get(lid, Number(idOrSlug));
  } else {
    let sql = 'SELECT * FROM module_categories WHERE lead_id = ? AND slug = ?';
    const params = [lid, slugify(idOrSlug)];
    if (scope) {
      sql += ' AND scope = ?';
      params.push(cleanScope(scope));
    }
    sql += ' ORDER BY id ASC LIMIT 1';
    row = db.prepare(sql).get(...params);
  }
  if (!row) return null;
  return decorateCounts(db, lid, [row], 'all')[0];
}

function createCategory(db, leadId, data = {}) {
  ensureTables(db);
  const lid = Number(leadId);
  const scope = cleanScope(data.scope);
  const name = String(data.name || data.title || '').trim();
  if (!name) throw fail('VALIDATION', 'name is required');
  const parentId = assertValidParent(db, lid, scope, data.parent_id != null ? data.parent_id : null, null);
  let slug = slugify(data.slug || name, 'category');
  const clash = db
    .prepare('SELECT id FROM module_categories WHERE lead_id = ? AND scope = ? AND slug = ?')
    .get(lid, scope, slug);
  if (clash) slug = `${slug}-${Date.now().toString(36).slice(-4)}`;
  const info = db
    .prepare(
      `INSERT INTO module_categories
        (lead_id, scope, name, slug, description, image_url, parent_id, status, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      lid,
      scope,
      name.slice(0, 200),
      slug,
      String(data.description || ''),
      String(data.image_url || data.image || ''),
      parentId,
      cleanStatus(data.status, 'draft'),
      Number(data.sort_order) || 0
    );
  return getCategory(db, lid, info.lastInsertRowid);
}

function updateCategory(db, leadId, id, data = {}) {
  ensureTables(db);
  const lid = Number(leadId);
  const row = getCategory(db, lid, id);
  if (!row) throw fail('NOT_FOUND', 'Category not found', 404);
  // Scope is the category's identity: its assignments were made under
  // it (consumer_type = scope). Moving a category to another scope
  // would silently orphan them, so scope is set at create only.
  if (data.scope != null && cleanScope(data.scope) !== row.scope) {
    throw fail('VALIDATION', 'A category’s scope cannot be changed — create a new category in the other scope');
  }
  const name =
    data.name != null || data.title != null
      ? String(data.name != null ? data.name : data.title)
          .trim()
          .slice(0, 200)
      : row.name;
  if (!name) throw fail('VALIDATION', 'name is required');
  let slug = row.slug;
  if (data.slug != null) {
    slug = slugify(data.slug, 'category');
    const clash = db
      .prepare('SELECT id FROM module_categories WHERE lead_id = ? AND scope = ? AND slug = ? AND id != ?')
      .get(lid, row.scope, slug, row.id);
    if (clash) throw fail('VALIDATION', `Slug '${slug}' is already used by another ${row.scope} category`);
  }
  const parentId =
    data.parent_id !== undefined
      ? assertValidParent(db, lid, row.scope, data.parent_id === '' ? null : data.parent_id, row.id)
      : row.parent_id;
  const description = data.description != null ? String(data.description) : row.description;
  const image =
    data.image_url != null || data.image != null
      ? String(data.image_url != null ? data.image_url : data.image)
      : row.image_url;
  const status = cleanStatus(data.status, row.status);
  const sortOrder = data.sort_order != null ? Number(data.sort_order) || 0 : row.sort_order;
  db.prepare(
    `UPDATE module_categories SET name=?, slug=?, description=?, image_url=?, parent_id=?,
       status=?, sort_order=?, updated_at=datetime('now')
     WHERE id=? AND lead_id=?`
  ).run(name, slug, description, image, parentId, status, sortOrder, row.id, lid);
  return getCategory(db, lid, row.id);
}

function deleteCategory(db, leadId, id) {
  ensureTables(db);
  const lid = Number(leadId);
  const row = getCategory(db, lid, id);
  if (!row) throw fail('NOT_FOUND', 'Category not found', 404);
  // Children keep their place in the tree: they move up to the
  // deleted category's own parent. Assignments go with the category;
  // the items they pointed at are never touched.
  db.prepare(
    "UPDATE module_categories SET parent_id = ?, updated_at = datetime('now') WHERE lead_id = ? AND parent_id = ?"
  ).run(row.parent_id != null ? row.parent_id : null, lid, row.id);
  const removed = db
    .prepare('DELETE FROM module_category_assignments WHERE lead_id = ? AND category_id = ?')
    .run(lid, row.id);
  db.prepare('DELETE FROM module_categories WHERE id = ? AND lead_id = ?').run(row.id, lid);
  return { deleted: true, id: row.id, assignments_removed: Number(removed.changes) || 0 };
}

/* ------------------------------------------------------------------ */
/* Assignments                                                         */
/* ------------------------------------------------------------------ */

/* Existence reads for assignment targets, built on the SAME list
 * readers the shared-layer providers use (drafts included — an item
 * may be categorized ahead of publishing; resolution stays dormant
 * until it publishes, exactly like the event→album link). Types whose
 * items are ephemeral (socialfeed / googlereviews) have no stable
 * rows to assign, so their targets resolve through the provider read
 * and effectively cannot match a stored id. */
const ITEM_READERS = {
  blog: (db, lid) => modules.listBlogPosts(db, lid, { includeDrafts: true }),
  ecommerce: (db, lid) => modules.listProducts(db, lid, { includeDrafts: true }),
  courses: (db, lid) => modules.listCourses(db, lid, { includeDrafts: true, withLessons: false }),
  gallery: (db, lid) => modules.listAlbums(db, lid, { includeDrafts: true, withImages: false }),
  directory: (db, lid) => modules.listListings(db, lid, { includeDrafts: true }),
  faq: (db, lid) => modules.listFaqItems(db, lid, { includeDrafts: true }),
  testimonials: (db, lid) => modules.listTestimonials(db, lid, { includeDrafts: true }),
  team: (db, lid) => modules.listTeamMembers(db, lid, { includeDrafts: true }),
  events: (db, lid) => modules.listEvents(db, lid, { includeDrafts: true }),
  bookings: (db, lid) => modules.listBookingServices(db, lid, { includeDrafts: true }),
  offers: (db, lid) => modules.listOffers(db, lid, { includeDrafts: true }),
  menu: (db, lid) => modules.listMenuItems(db, lid, { includeDrafts: true }),
  careers: (db, lid) => modules.listCareersPostings(db, lid, { includeInactive: true }),
  video: (db, lid) => modules.listVideoItems(db, lid, { includeDrafts: true }),
  categories: (db, lid) => listCategories(db, lid, { includeDrafts: true }),
  // Batch 125 finisher: photo submissions are stable rows in every
  // moderation state — a photo may be categorized while it is still
  // pending (resolution stays dormant until it is approved, exactly
  // like a draft item of any other consumer).
  photocapture: (db, lid) => modules.listPhotoSubmissions(db, lid, { limit: 500 }),
};

function itemExists(db, lid, consumerType, itemId) {
  const reader = ITEM_READERS[consumerType];
  if (reader) {
    try {
      return reader(db, lid).some((r) => Number(r.id) === Number(itemId));
    } catch {
      return false;
    }
  }
  return share.readProviderItems(db, lid, consumerType).some((i) => Number(i.source_id) === Number(itemId));
}

/** The shared pre-flight for every assignment write: the consumer
 *  must be a provider type (it has items to organize), the item must
 *  exist for THIS lead, and any category named must belong to this
 *  lead and to the consumer's own scope. */
function assertAssignable(db, lid, consumerType, itemId) {
  const type = cleanScope(consumerType);
  const entry = share.SHARE_REGISTRY[type];
  if (!entry || entry.kind !== 'provider') {
    throw fail(
      'VALIDATION',
      `${type} does not share items, so its items cannot be categorized${entry && entry.reason ? `: ${entry.reason}` : ''}`
    );
  }
  const iid = Number(itemId);
  if (!Number.isInteger(iid) || iid <= 0) throw fail('VALIDATION', 'item_id must be a positive integer');
  if (!itemExists(db, lid, type, iid)) {
    throw fail('VALIDATION', `No ${type} item #${iid} exists for this business`);
  }
  return { type, itemId: iid };
}

function assertCategoryForScope(db, lid, categoryId, consumerType) {
  const cid = Number(categoryId);
  if (!Number.isInteger(cid) || cid <= 0) throw fail('VALIDATION', 'category_id must be a positive integer');
  const cat = db.prepare('SELECT * FROM module_categories WHERE lead_id = ? AND id = ?').get(lid, cid);
  if (!cat) throw fail('VALIDATION', `Category #${cid} does not exist for this business`);
  if (cat.scope !== consumerType) {
    throw fail(
      'VALIDATION',
      `Category #${cid} belongs to scope '${cat.scope}' — a ${consumerType} item can only use ${consumerType} categories`
    );
  }
  return cat;
}

/** Validate a category_ids array for one consumer (the write-path
 *  pre-flight the module CRUDs run BEFORE they mutate anything). */
function assertCategoryIds(db, leadId, consumerType, rawIds) {
  ensureTables(db);
  const lid = Number(leadId);
  const type = cleanScope(consumerType);
  if (!Array.isArray(rawIds)) throw fail('VALIDATION', 'category_ids must be an array of category ids');
  const ids = [...new Set(rawIds.map((v) => Number(v)))];
  for (const cid of ids) {
    if (!Number.isInteger(cid) || cid <= 0) throw fail('VALIDATION', 'category_ids must be category ids');
    assertCategoryForScope(db, lid, cid, type);
  }
  return ids;
}

function assignItem(db, leadId, ref = {}) {
  ensureTables(db);
  const lid = Number(leadId);
  const consumerType = ref.consumer_type != null ? ref.consumer_type : ref.consumerType;
  const itemId = ref.item_id != null ? ref.item_id : ref.itemId;
  const categoryId = ref.category_id != null ? ref.category_id : ref.categoryId;
  const checked = assertAssignable(db, lid, consumerType, itemId);
  const cat = assertCategoryForScope(db, lid, categoryId, checked.type);
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO module_category_assignments (lead_id, consumer_type, item_id, category_id)
       VALUES (?, ?, ?, ?)`
    )
    .run(lid, checked.type, checked.itemId, cat.id);
  return {
    assigned: true,
    already: Number(info.changes) === 0,
    lead_id: lid,
    consumer_type: checked.type,
    item_id: checked.itemId,
    category_id: cat.id,
  };
}

function unassignItem(db, leadId, ref = {}) {
  ensureTables(db);
  const lid = Number(leadId);
  const consumerType = String(ref.consumer_type != null ? ref.consumer_type : ref.consumerType || '')
    .trim()
    .toLowerCase();
  const itemId = Number(ref.item_id != null ? ref.item_id : ref.itemId);
  const categoryId = Number(ref.category_id != null ? ref.category_id : ref.categoryId);
  const info = db
    .prepare(
      'DELETE FROM module_category_assignments WHERE lead_id = ? AND consumer_type = ? AND item_id = ? AND category_id = ?'
    )
    .run(lid, consumerType, itemId, categoryId);
  return {
    removed: Number(info.changes) > 0,
    lead_id: lid,
    consumer_type: consumerType,
    item_id: itemId,
    category_id: categoryId,
  };
}

function listItemCategoryIds(db, leadId, consumerType, itemId) {
  ensureTables(db);
  return db
    .prepare(
      'SELECT category_id FROM module_category_assignments WHERE lead_id = ? AND consumer_type = ? AND item_id = ? ORDER BY category_id ASC'
    )
    .all(
      Number(leadId),
      String(consumerType || '')
        .trim()
        .toLowerCase(),
      Number(itemId)
    )
    .map((r) => Number(r.category_id));
}

/** Replace an item's category set (the item editors' write path —
 *  `category_ids` present on a create/update means "this is the full
 *  set"; absent means untouched, exactly like gallery_album_id). */
function setItemCategories(db, leadId, consumerType, itemId, rawIds) {
  ensureTables(db);
  const lid = Number(leadId);
  const checked = assertAssignable(db, lid, consumerType, itemId);
  const ids = assertCategoryIds(db, lid, checked.type, rawIds);
  db.prepare('DELETE FROM module_category_assignments WHERE lead_id = ? AND consumer_type = ? AND item_id = ?').run(
    lid,
    checked.type,
    checked.itemId
  );
  for (const cid of ids) {
    db.prepare(
      'INSERT OR IGNORE INTO module_category_assignments (lead_id, consumer_type, item_id, category_id) VALUES (?, ?, ?, ?)'
    ).run(lid, checked.type, checked.itemId, cid);
  }
  return { category_ids: ids };
}

/** Decorate item rows with their category_ids (the editors' read
 *  path). One grouped query per call; rows are mutated in place. */
function decorateWithCategories(db, leadId, consumerType, rows) {
  if (!Array.isArray(rows) || !rows.length) return rows;
  ensureTables(db);
  const lid = Number(leadId);
  const type = String(consumerType || '')
    .trim()
    .toLowerCase();
  const ids = rows.map((r) => Number(r.id)).filter((v) => Number.isInteger(v) && v > 0);
  const byItem = new Map();
  if (ids.length) {
    const found = db
      .prepare(
        `SELECT item_id, category_id FROM module_category_assignments
         WHERE lead_id = ? AND consumer_type = ? AND item_id IN (${ids.map(() => '?').join(',')})
         ORDER BY category_id ASC`
      )
      .all(lid, type, ...ids);
    for (const r of found) {
      const list = byItem.get(Number(r.item_id)) || [];
      list.push(Number(r.category_id));
      byItem.set(Number(r.item_id), list);
    }
  }
  for (const row of rows) row.category_ids = byItem.get(Number(row.id)) || [];
  return rows;
}

/** When an item is deleted, its assignments go with it (the category
 *  and every other item stay). Never blocks the caller's delete. */
function clearAssignmentsForItem(db, leadId, consumerType, itemId) {
  ensureTables(db);
  const info = db
    .prepare('DELETE FROM module_category_assignments WHERE lead_id = ? AND consumer_type = ? AND item_id = ?')
    .run(
      Number(leadId),
      String(consumerType || '')
        .trim()
        .toLowerCase(),
      Number(itemId)
    );
  return { cleared: Number(info.changes) || 0 };
}

/* ------------------------------------------------------------------ */
/* Reads through the shared layer                                      */
/* ------------------------------------------------------------------ */

/** A category's items in the one uniform shape — the scope provider's
 *  published items, filtered by the assignment rows. Draft or deleted
 *  items simply never appear (dormant discipline). */
function itemsForCategory(db, leadId, category, { limit = 200 } = {}) {
  ensureTables(db);
  const lid = Number(leadId);
  if (!category) return [];
  const assigned = new Set(
    db
      .prepare('SELECT item_id FROM module_category_assignments WHERE lead_id = ? AND category_id = ?')
      .all(lid, Number(category.id))
      .map((r) => Number(r.item_id))
  );
  if (!assigned.size) return [];
  const cap = Math.max(1, Math.min(200, Number(limit) || 200));
  return share
    .readProviderItems(db, lid, category.scope)
    .filter((i) => assigned.has(Number(i.source_id)))
    .slice(0, cap);
}

/** Where an item "lives" on the site: its own module page with the
 *  platform's ?bpItem= key (slug when the provider carries one). */
function categoryItemLink(db, leadId, uniformItem) {
  const fallback = String((uniformItem && uniformItem.link_url) || '');
  try {
    const embed = modules.getEmbedRow(db, Number(leadId), uniformItem.source_type);
    if (!embed) return fallback;
    const meta = modules.MODULE_META[uniformItem.source_type] || {};
    const page = String(embed.target_page_slug || meta.defaultSlug || '').replace(/^\/+/, '');
    if (!page) return fallback;
    const key = (uniformItem.meta && uniformItem.meta.slug) || uniformItem.source_id;
    if (key == null || key === '') return fallback;
    return `/${page}?bpItem=${encodeURIComponent(String(key))}`;
  } catch {
    return fallback;
  }
}

/** Public index for the categories module: published categories of
 *  the configured scopes (empty config = every scope), each with its
 *  published item count and scope label. */
function publicIndex(db, leadId, scopesSetting) {
  const lid = Number(leadId);
  const configured = Array.isArray(scopesSetting)
    ? scopesSetting
        .map((s) =>
          String(s || '')
            .trim()
            .toLowerCase()
        )
        .filter((s) => modules.MODULE_TYPES.includes(s) && s !== 'categories')
    : [];
  let rows = listCategories(db, lid, { includeDrafts: false, counts: 'published' });
  if (configured.length) rows = rows.filter((r) => configured.includes(r.scope));
  return rows.map((r) => ({
    ...r,
    scope_label: (modules.MODULE_META[r.scope] && modules.MODULE_META[r.scope].label) || r.scope,
  }));
}

/** One published category for the public category view (drafts never
 *  resolve), honoring the module's configured scopes. */
function getPublicCategory(db, leadId, idOrSlug, scopesSetting) {
  const lid = Number(leadId);
  const rows = publicIndex(db, lid, scopesSetting);
  const byId = /^\d+$/.test(String(idOrSlug));
  const found = rows.find((r) => (byId ? Number(r.id) === Number(idOrSlug) : r.slug === slugify(idOrSlug)));
  return found || null;
}

/** The category view's cards: uniform items with link_url pointed at
 *  each item's own page whenever that page exists. */
function publicCategoryItems(db, leadId, category) {
  const lid = Number(leadId);
  return itemsForCategory(db, lid, category).map((it) => {
    const link = categoryItemLink(db, lid, it);
    return link ? { ...it, link_url: link } : it;
  });
}

/** Census summary for the design agent: per-scope totals. */
function categoriesSummary(db, leadId) {
  ensureTables(db);
  const lid = Number(leadId);
  const rows = db
    .prepare(
      `SELECT scope, COUNT(*) AS total,
         SUM(CASE WHEN status = 'published' THEN 1 ELSE 0 END) AS published
       FROM module_categories WHERE lead_id = ? GROUP BY scope ORDER BY scope ASC`
    )
    .all(lid);
  const assigned = db
    .prepare(
      'SELECT consumer_type, COUNT(*) AS c FROM module_category_assignments WHERE lead_id = ? GROUP BY consumer_type'
    )
    .all(lid);
  const byType = new Map(assigned.map((r) => [r.consumer_type, Number(r.c) || 0]));
  return rows.map((r) => ({
    scope: r.scope,
    total: Number(r.total) || 0,
    published: Number(r.published) || 0,
    assigned_items: byType.get(r.scope) || 0,
  }));
}

module.exports = {
  ensureTables,
  listCategories,
  getCategory,
  createCategory,
  updateCategory,
  deleteCategory,
  assignItem,
  unassignItem,
  listItemCategoryIds,
  setItemCategories,
  decorateWithCategories,
  clearAssignmentsForItem,
  assertCategoryIds,
  itemsForCategory,
  categoryItemLink,
  publicIndex,
  getPublicCategory,
  publicCategoryItems,
  categoriesSummary,
};
