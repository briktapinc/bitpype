'use strict';

/**
 * Batch 131 — THE COMMENTS SERVICE (Ely, 2026-11-03: "add a comments
 * module tonight" + "And likes").
 *
 * A first-class module type `comments`: threaded visitor comments and
 * visitor likes that attach to OTHER modules' items — a blog post, a
 * product, an event, a gallery album, an offer, a video — or to a page
 * of the site itself (guestbook-style). Per Ely's standing
 * interdependence rule this service is built INTO the Batch 122 shared
 * layer, never into pairwise links:
 *
 *   - Targets are identified by the shared layer's uniform identity —
 *     (source_type, source_id) — and validated/resolved ONLY through
 *     moduleShare's provider readers (published items only, strictly
 *     lead-scoped). A comment or like can never attach to a draft, to
 *     another lead's item, or to a type that shares nothing.
 *   - Comments themselves are an explicit NON-provider in the shared
 *     registry (a comment is engagement on content, not shelf
 *     content); the module CONSUMES the layer instead.
 *
 * One service behind every surface: the public embed endpoints, the
 * portal moderation queue, the MCP tools and the design agent all call
 * these same functions — no agent-only back door (Categories
 * precedent).
 *
 * Tables (owned here, workspace DB):
 *   comments_configs — the per-lead settings (moderation, likes,
 *     binding) created lazily with the defaults below.
 *   module_comments  — one row per comment/reply; status is the
 *     moderation state ('pending' | 'published' | 'rejected'); owner
 *     replies are flagged is_owner and publish immediately.
 *   module_likes     — one row per (lead, target, visitor); UNIQUE so
 *     one visitor = one like per target; toggling deletes the row.
 *     Item likes and comment likes share the table but live in
 *     separate target namespaces ('comment' vs the item's own type),
 *     so the two counts can never bleed into each other. The like
 *     state shown for an item in the comments block is THE item's
 *     count from this one store — any future surface reads the same
 *     numbers.
 *
 * Visitor identity for likes is a first-party random token minted by
 * the embed (localStorage); only its SHA-256 hash (salted per lead)
 * is stored — never the raw token, never an IP or fingerprint.
 *
 * Spam/rate discipline (documented choices):
 *   - the public routes ride the shared per-IP limiter + captcha
 *     (submissions), exactly like Photo Capture;
 *   - body is capped at 2000 chars, name at 80, email at 240;
 *   - a comment carrying 3+ links is HELD as pending even when the
 *     owner runs auto-publish (held, never silently dropped);
 *   - one visitor token may post at most 10 comments per hour per
 *     business; beyond that, further comments are held as pending
 *     rather than refused (again: never silently dropped).
 *
 * Comment bodies are PLAIN TEXT end to end — stored raw, rendered by
 * the embed via textContent only; nothing anywhere renders a comment
 * body as HTML.
 */

const crypto = require('crypto');
const modules = require('./siteModules');
const share = require('./moduleShare');

function fail(code, message, status) {
  const err = new Error(message);
  // @ts-ignore - coded errors are the codebase convention
  err.code = code;
  if (status) {
    // @ts-ignore
    err.status = status;
  }
  return err;
}

const COMMENT_STATUSES = ['pending', 'published', 'rejected'];
const COMMENT_BODY_MAX = 2000;
const COMMENT_NAME_MAX = 80;
const COMMENT_EMAIL_MAX = 240;
const LINK_HOLD_THRESHOLD = 3;
const VISITOR_HOURLY_POSTS = 10;
const THREAD_PAGE_MAX = 200;

const DEFAULT_HEADING = 'Comments';

/* ------------------------------------------------------------------ */
/* Tables                                                              */
/* ------------------------------------------------------------------ */

function ensureTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS comments_configs (
      lead_id INTEGER PRIMARY KEY,
      moderation TEXT NOT NULL DEFAULT 'held',
      allow_likes INTEGER NOT NULL DEFAULT 1,
      allow_item_like INTEGER NOT NULL DEFAULT 1,
      comments_enabled INTEGER NOT NULL DEFAULT 1,
      target_mode TEXT NOT NULL DEFAULT 'page',
      target_type TEXT NOT NULL DEFAULT 'blog',
      heading TEXT NOT NULL DEFAULT 'Comments',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS module_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      parent_id INTEGER,
      is_owner INTEGER NOT NULL DEFAULT 0,
      author_name TEXT NOT NULL DEFAULT '',
      author_email TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      like_count INTEGER NOT NULL DEFAULT 0,
      visitor_key TEXT NOT NULL DEFAULT '',
      page_slug TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_module_comments_target
      ON module_comments(lead_id, target_type, target_id, status, id);
    CREATE INDEX IF NOT EXISTS idx_module_comments_queue
      ON module_comments(lead_id, status, id DESC);

    CREATE TABLE IF NOT EXISTS module_likes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      visitor_key TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(lead_id, target_type, target_id, visitor_key)
    );
    CREATE INDEX IF NOT EXISTS idx_module_likes_target
      ON module_likes(lead_id, target_type, target_id);
  `);
}

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */

function normalizeTargetMode(value, fallback = 'page') {
  return value === 'item' ? 'item' : value === 'page' ? 'page' : fallback === 'item' ? 'item' : 'page';
}

function normalizeTargetType(value, fallback = 'blog') {
  const t = String(value || '')
    .trim()
    .toLowerCase();
  if (t === 'page') return 'page';
  const entry = share.SHARE_REGISTRY[t];
  if (entry && entry.kind === 'provider') return t;
  const fb = String(fallback || 'blog')
    .trim()
    .toLowerCase();
  const fbEntry = share.SHARE_REGISTRY[fb];
  return fbEntry && fbEntry.kind === 'provider' ? fb : 'blog';
}

function configShape(row) {
  if (!row) return null;
  return {
    lead_id: Number(row.lead_id),
    // Moderation: 'held' = every visitor comment waits for approval
    // (the DEFAULT); 'auto' = comments publish immediately (the link
    // heuristic can still hold an individual comment).
    moderation: row.moderation === 'auto' ? 'auto' : 'held',
    moderation_held: row.moderation !== 'auto',
    allow_likes: row.allow_likes == null ? true : !!row.allow_likes,
    allow_item_like: row.allow_item_like == null ? true : !!row.allow_item_like,
    comments_enabled: row.comments_enabled == null ? true : !!row.comments_enabled,
    target_mode: normalizeTargetMode(row.target_mode),
    target_type: normalizeTargetType(row.target_type),
    heading: String(row.heading || DEFAULT_HEADING),
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

function getCommentsConfig(db, leadId) {
  ensureTables(db);
  const id = Number(leadId);
  let row = db.prepare('SELECT * FROM comments_configs WHERE lead_id = ?').get(id);
  if (!row) {
    db.prepare(`INSERT INTO comments_configs (lead_id, moderation, heading) VALUES (?, 'held', ?)`).run(
      id,
      DEFAULT_HEADING
    );
    row = db.prepare('SELECT * FROM comments_configs WHERE lead_id = ?').get(id);
  }
  return configShape(row);
}

function boolSetting(data, key, current) {
  if (data[key] === undefined) return current;
  return data[key] === false || data[key] === 0 || data[key] === 'false' || data[key] === 'off' ? 0 : 1;
}

function updateCommentsConfig(db, leadId, data = {}) {
  ensureTables(db);
  const id = Number(leadId);
  const cur = getCommentsConfig(db, id);
  const moderation =
    data.moderation !== undefined
      ? data.moderation === 'auto' || data.moderation === false || data.moderation === 'off'
        ? 'auto'
        : 'held'
      : data.moderation_held !== undefined
        ? data.moderation_held === false || data.moderation_held === 0 || data.moderation_held === 'off'
          ? 'auto'
          : 'held'
        : cur.moderation;
  const heading =
    data.heading !== undefined
      ? String(data.heading || '')
          .trim()
          .slice(0, 120) || DEFAULT_HEADING
      : cur.heading;
  db.prepare(
    `UPDATE comments_configs
       SET moderation = ?, allow_likes = ?, allow_item_like = ?, comments_enabled = ?,
           target_mode = ?, target_type = ?, heading = ?, updated_at = datetime('now')
     WHERE lead_id = ?`
  ).run(
    moderation,
    boolSetting(data, 'allow_likes', cur.allow_likes ? 1 : 0),
    boolSetting(data, 'allow_item_like', cur.allow_item_like ? 1 : 0),
    boolSetting(data, 'comments_enabled', cur.comments_enabled ? 1 : 0),
    data.target_mode !== undefined ? normalizeTargetMode(data.target_mode, cur.target_mode) : cur.target_mode,
    data.target_type !== undefined ? normalizeTargetType(data.target_type, cur.target_type) : cur.target_type,
    heading,
    id
  );
  return getCommentsConfig(db, id);
}

/* ------------------------------------------------------------------ */
/* Target resolution — through the shared layer, never around it       */
/* ------------------------------------------------------------------ */

/**
 * Validate + canonicalize a comment/like target for this lead.
 * Returns { target_type, target_id, title } where target_id is the
 * shared layer's canonical source_id (or the page slug for 'page').
 * Throws VALIDATION for anything unresolvable: unknown or
 * non-provider type, draft item, another lead's item, unknown page.
 */
function resolveTarget(db, leadId, targetType, targetId) {
  ensureTables(db);
  const lid = Number(leadId);
  const type = String(targetType || '')
    .trim()
    .toLowerCase();
  const rawId = String(targetId == null ? '' : targetId).trim();
  if (!rawId) throw fail('VALIDATION', 'A target item is required');
  if (type === 'page') {
    const pages = modules.listSitePages(db, lid) || [];
    const page = pages.find((p) => String(p.slug || '') === rawId || String(p.id) === rawId);
    if (!page) throw fail('VALIDATION', `Unknown page: ${rawId}`);
    return { target_type: 'page', target_id: String(page.slug || rawId), title: page.title || page.slug || '' };
  }
  const entry = share.SHARE_REGISTRY[type];
  if (!entry) throw fail('VALIDATION', `Unknown comment target type: ${type || '(blank)'}`);
  if (entry.kind !== 'provider') {
    throw fail('VALIDATION', `${type} items can't take comments: ${entry.reason}`);
  }
  const items = share.readProviderItems(db, lid, type);
  const hit = items.find((it) => String(it.source_id) === rawId || (it.meta && String(it.meta.slug || '') === rawId));
  if (!hit) throw fail('VALIDATION', 'That item is not published (or does not belong to this business)');
  return { target_type: type, target_id: String(hit.source_id), title: hit.title || '' };
}

/** Like targets add one namespace the resolver above refuses:
 *  individual comments ('comment' + comment id). */
function resolveLikeTarget(db, leadId, targetType, targetId, visitorKey) {
  const lid = Number(leadId);
  const type = String(targetType || '')
    .trim()
    .toLowerCase();
  if (type === 'comment') {
    const row = getCommentRow(db, lid, targetId);
    if (!row) throw fail('NOT_FOUND', 'Comment not found', 404);
    if (row.status === 'rejected') throw fail('VALIDATION', 'That comment is no longer available');
    // A pending comment may be liked only by its own author (the
    // embed shows the author their own pending comment + like).
    if (row.status === 'pending' && (!visitorKey || row.visitor_key !== visitorKey)) {
      throw fail('VALIDATION', 'That comment is awaiting approval');
    }
    return { target_type: 'comment', target_id: String(row.id), title: '' };
  }
  return resolveTarget(db, lid, type, targetId);
}

/* ------------------------------------------------------------------ */
/* Visitor identity                                                    */
/* ------------------------------------------------------------------ */

/** The stored form of a visitor token: sha256(token + lead). The raw
 *  token never reaches the database. Malformed tokens hash a fixed
 *  sentinel under the same lead salt, collapsing junk tokens into one
 *  rate-limit bucket instead of erroring public flows. */
function visitorKeyFor(leadId, visitorToken) {
  const raw = String(visitorToken || '');
  const usable = /^[A-Za-z0-9_-]{16,128}$/.test(raw) ? raw : 'invalid-visitor-token';
  return crypto
    .createHash('sha256')
    .update(`${Number(leadId)}:${usable}`)
    .digest('hex');
}

/** Batch 143 (full review): the sentinel bucket above is right for
 *  rate limiting comment POSTS, but it must never act as a like
 *  identity — every tokenless/junk-token visitor shared ONE like, so
 *  any of them could silently remove another's like (and the shared
 *  state read showed them all the same pressed buttons). Likes
 *  therefore require a usable token; the embed always mints one, so
 *  only hand-rolled callers see the refusal. */
function hasUsableVisitorToken(data = {}) {
  return /^[A-Za-z0-9_-]{16,128}$/.test(String(data.visitor_token || data.visitorToken || ''));
}

/* ------------------------------------------------------------------ */
/* Comments                                                            */
/* ------------------------------------------------------------------ */

function commentShape(row, { forOwner = false } = {}) {
  if (!row) return null;
  const out = {
    id: Number(row.id),
    target_type: row.target_type,
    target_id: String(row.target_id),
    parent_id: row.parent_id == null ? null : Number(row.parent_id),
    is_owner: !!row.is_owner,
    author_name: row.author_name || '',
    body: row.body || '',
    status: row.status,
    like_count: Number(row.like_count) || 0,
    created_at: row.created_at || null,
  };
  if (forOwner) {
    out.author_email = row.author_email || '';
    out.page_slug = row.page_slug || '';
    out.updated_at = row.updated_at || null;
  }
  return out;
}

function getCommentRow(db, leadId, id) {
  ensureTables(db);
  if (!/^\d+$/.test(String(id))) return null;
  return (
    db.prepare('SELECT * FROM module_comments WHERE lead_id = ? AND id = ?').get(Number(leadId), Number(id)) || null
  );
}

function countLinks(body) {
  const m = String(body || '').match(/https?:\/\/|www\./gi);
  return m ? m.length : 0;
}

function recentVisitorPosts(db, leadId, visitorKey) {
  if (!visitorKey) return 0;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM module_comments
        WHERE lead_id = ? AND visitor_key = ? AND created_at >= datetime('now', '-1 hour')`
    )
    .get(Number(leadId), visitorKey);
  return Number(row && row.c) || 0;
}

/**
 * Create a visitor comment. The target must resolve through the
 * shared layer (or be the embed's page); a reply's parent must be a
 * PUBLISHED top-level-or-reply comment on the SAME target (threading
 * is one level: replying to a reply attaches to its top-level
 * ancestor). Returns the visitor-safe comment + its status; the
 * public response built on this is state-blind about everything
 * except the caller's own comment's moderation state.
 */
function createComment(db, leadId, data = {}) {
  ensureTables(db);
  const lid = Number(leadId);
  const config = getCommentsConfig(db, lid);
  if (!config.comments_enabled) throw fail('VALIDATION', 'Comments are turned off for this site');
  const target = resolveTarget(db, lid, data.target_type, data.target_id);
  const name = String(data.author_name || data.name || '')
    .trim()
    .slice(0, COMMENT_NAME_MAX);
  const email = String(data.author_email || data.email || '')
    .trim()
    .slice(0, COMMENT_EMAIL_MAX);
  const body = String(data.body || '')
    .trim()
    .slice(0, COMMENT_BODY_MAX);
  if (!name) throw fail('VALIDATION', 'Please add your name');
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw fail('VALIDATION', 'Please add a valid email address');
  }
  if (!body) throw fail('VALIDATION', 'Please write a comment');

  let parentId = null;
  if (data.parent_id != null && String(data.parent_id) !== '') {
    const parent = getCommentRow(db, lid, data.parent_id);
    if (!parent || parent.status !== 'published') {
      throw fail('VALIDATION', 'That comment is no longer available to reply to');
    }
    if (parent.target_type !== target.target_type || String(parent.target_id) !== target.target_id) {
      throw fail('VALIDATION', 'That comment belongs to a different item');
    }
    parentId = parent.parent_id == null ? parent.id : Number(parent.parent_id);
  }

  const visitorKey = visitorKeyFor(lid, data.visitor_token || data.visitorToken || '');
  // Hold heuristics (never a silent drop): many links, or a visitor
  // posting fast, lands in the moderation queue even on auto-publish.
  let status = config.moderation_held ? 'pending' : 'published';
  let heldReason = '';
  if (status === 'published' && countLinks(body) >= LINK_HOLD_THRESHOLD) {
    status = 'pending';
    heldReason = 'links';
  }
  if (status === 'published' && recentVisitorPosts(db, lid, visitorKey) >= VISITOR_HOURLY_POSTS) {
    status = 'pending';
    heldReason = 'rate';
  }

  const info = db
    .prepare(
      `INSERT INTO module_comments
         (lead_id, target_type, target_id, parent_id, is_owner, author_name, author_email,
          body, status, visitor_key, page_slug)
       VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      lid,
      target.target_type,
      target.target_id,
      parentId,
      name,
      email,
      body,
      status,
      visitorKey,
      String(data.page_slug || data.pageSlug || '').slice(0, 120)
    );
  const row = getCommentRow(db, lid, info.lastInsertRowid);

  // LeadScout capture — a commenter's email becomes/updates the
  // deduped portal contact, exactly like every other capture kind.
  // Liking alone captures nothing (it carries no identity).
  try {
    require('./portalContacts').captureFromComment(db, {
      leadId: lid,
      comment: row,
      pageSlug: row.page_slug,
    });
  } catch {
    /* capture must never break a visitor comment */
  }
  return { comment: commentShape(row), status, held_reason: heldReason || undefined };
}

/** Owner reply — published immediately, flagged, badged in the UI. */
function replyAsOwner(db, leadId, parentId, data = {}) {
  ensureTables(db);
  const lid = Number(leadId);
  const parent = getCommentRow(db, lid, parentId);
  if (!parent) throw fail('NOT_FOUND', 'Comment not found', 404);
  // Batch 143 (full review): a reply to a REJECTED comment was stored
  // 'published' but could never render (publicThread only renders
  // replies under a published parent) — an invisible, counted reply
  // with no error anywhere. Pending parents stay allowed (the
  // moderation-queue workflow: reply first, approve after); rejected
  // is terminal, so refuse it like the visitor reply path does.
  if (parent.status === 'rejected') throw fail('VALIDATION', 'That comment is no longer available');
  const body = String(data.body || '')
    .trim()
    .slice(0, COMMENT_BODY_MAX);
  if (!body) throw fail('VALIDATION', 'Please write a reply');
  let name = String(data.author_name || data.name || '')
    .trim()
    .slice(0, COMMENT_NAME_MAX);
  if (!name) {
    try {
      const lead = db.prepare('SELECT business_name FROM leads WHERE id = ?').get(lid);
      name = String((lead && lead.business_name) || 'Owner').slice(0, COMMENT_NAME_MAX);
    } catch {
      name = 'Owner';
    }
  }
  const topId = parent.parent_id == null ? parent.id : Number(parent.parent_id);
  const info = db
    .prepare(
      `INSERT INTO module_comments
         (lead_id, target_type, target_id, parent_id, is_owner, author_name, author_email,
          body, status, visitor_key, page_slug)
       VALUES (?, ?, ?, ?, 1, ?, '', ?, 'published', '', ?)`
    )
    .run(lid, parent.target_type, parent.target_id, topId, name, body, parent.page_slug || '');
  return commentShape(getCommentRow(db, lid, info.lastInsertRowid), { forOwner: true });
}

function setCommentStatus(db, leadId, id, status) {
  ensureTables(db);
  const lid = Number(leadId);
  const s = String(status || '').toLowerCase();
  if (!COMMENT_STATUSES.includes(s)) {
    throw fail('VALIDATION', `status must be one of: ${COMMENT_STATUSES.join(', ')}`);
  }
  const row = getCommentRow(db, lid, id);
  if (!row) throw fail('NOT_FOUND', 'Comment not found', 404);
  db.prepare("UPDATE module_comments SET status = ?, updated_at = datetime('now') WHERE lead_id = ? AND id = ?").run(
    s,
    lid,
    row.id
  );
  return commentShape(getCommentRow(db, lid, row.id), { forOwner: true });
}

function deleteComment(db, leadId, id) {
  ensureTables(db);
  const lid = Number(leadId);
  const row = getCommentRow(db, lid, id);
  if (!row) throw fail('NOT_FOUND', 'Comment not found', 404);
  // Replies keep their thread: they re-parent to the deleted
  // comment's own parent (or become top-level), never cascade away.
  db.prepare('UPDATE module_comments SET parent_id = ? WHERE lead_id = ? AND parent_id = ?').run(
    row.parent_id == null ? null : Number(row.parent_id),
    lid,
    row.id
  );
  db.prepare("DELETE FROM module_likes WHERE lead_id = ? AND target_type = 'comment' AND target_id = ?").run(
    lid,
    String(row.id)
  );
  db.prepare('DELETE FROM module_comments WHERE lead_id = ? AND id = ?').run(lid, row.id);
  return { deleted: true, id: Number(row.id) };
}

/** Moderation queue + thread browser for the owner surfaces. */
function listCommentsForOwner(db, leadId, opts = {}) {
  ensureTables(db);
  const lid = Number(leadId);
  const limit = Math.max(1, Math.min(500, Number(opts.limit) || 200));
  let sql = 'SELECT * FROM module_comments WHERE lead_id = ?';
  const params = [lid];
  if (opts.status && COMMENT_STATUSES.includes(String(opts.status))) {
    sql += ' AND status = ?';
    params.push(String(opts.status));
  }
  if (opts.target_type) {
    sql += ' AND target_type = ?';
    params.push(String(opts.target_type).slice(0, 40));
  }
  if (opts.target_id != null && String(opts.target_id) !== '') {
    sql += ' AND target_id = ?';
    params.push(String(opts.target_id));
  }
  sql += ' ORDER BY id DESC LIMIT ?';
  params.push(limit);
  return db
    .prepare(sql)
    .all(...params)
    .map((r) => commentShape(r, { forOwner: true }));
}

function getCommentForOwner(db, leadId, id) {
  const row = getCommentRow(db, leadId, id);
  return row ? commentShape(row, { forOwner: true }) : null;
}

function countComments(db, leadId) {
  ensureTables(db);
  const rows = db
    .prepare('SELECT status, COUNT(*) AS c FROM module_comments WHERE lead_id = ? GROUP BY status')
    .all(Number(leadId));
  const counts = { pending: 0, published: 0, rejected: 0, total: 0 };
  for (const r of rows) {
    if (COMMENT_STATUSES.includes(r.status)) counts[r.status] = Number(r.c) || 0;
    counts.total += Number(r.c) || 0;
  }
  return counts;
}

/** Targets that carry comments/likes, newest activity first, with the
 *  shared-layer title where the target still resolves. */
function listCommentTargets(db, leadId) {
  ensureTables(db);
  const lid = Number(leadId);
  const rows = db
    .prepare(
      `SELECT target_type, target_id, COUNT(*) AS comments,
              SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
              MAX(id) AS last_id
         FROM module_comments WHERE lead_id = ? GROUP BY target_type, target_id`
    )
    .all(lid);
  const likeRows = db
    .prepare(
      `SELECT target_type, target_id, COUNT(*) AS likes FROM module_likes WHERE lead_id = ?
        GROUP BY target_type, target_id`
    )
    .all(lid);
  const likeMap = new Map(likeRows.map((r) => [`${r.target_type}:${r.target_id}`, Number(r.likes) || 0]));
  const out = rows.map((r) => {
    let title = '';
    try {
      title = resolveTarget(db, lid, r.target_type, r.target_id).title || '';
    } catch {
      /* target un-published since — the thread still moderates */
    }
    return {
      target_type: r.target_type,
      target_id: String(r.target_id),
      title,
      comments: Number(r.comments) || 0,
      pending: Number(r.pending) || 0,
      likes: likeMap.get(`${r.target_type}:${r.target_id}`) || 0,
      last_id: Number(r.last_id) || 0,
    };
  });
  // Item likes on targets with no comments yet still belong in the list.
  for (const r of likeRows) {
    if (r.target_type === 'comment') continue;
    if (out.some((t) => t.target_type === r.target_type && t.target_id === String(r.target_id))) continue;
    let title = '';
    try {
      title = resolveTarget(db, lid, r.target_type, r.target_id).title || '';
    } catch {
      /* dormant */
    }
    out.push({
      target_type: r.target_type,
      target_id: String(r.target_id),
      title,
      comments: 0,
      pending: 0,
      likes: Number(r.likes) || 0,
      last_id: 0,
    });
  }
  return out.sort((x, y) => y.last_id - x.last_id);
}

/* ------------------------------------------------------------------ */
/* Likes                                                               */
/* ------------------------------------------------------------------ */

function likeCount(db, leadId, targetType, targetId) {
  ensureTables(db);
  const row = db
    .prepare('SELECT COUNT(*) AS c FROM module_likes WHERE lead_id = ? AND target_type = ? AND target_id = ?')
    .get(Number(leadId), String(targetType), String(targetId));
  return Number(row && row.c) || 0;
}

function refreshCommentLikeCount(db, leadId, commentId) {
  const n = likeCount(db, leadId, 'comment', commentId);
  db.prepare('UPDATE module_comments SET like_count = ? WHERE lead_id = ? AND id = ?').run(
    n,
    Number(leadId),
    Number(commentId)
  );
  return n;
}

/** Toggle one visitor's like on one target. Returns the SERVER's
 *  count after the toggle — clients never do their own math. */
function toggleLike(db, leadId, data = {}) {
  ensureTables(db);
  const lid = Number(leadId);
  const config = getCommentsConfig(db, lid);
  if (!config.allow_likes) throw fail('VALIDATION', 'Likes are turned off for this site');
  if (!hasUsableVisitorToken(data)) throw fail('VALIDATION', 'A valid visitor token is required to like');
  const visitorKey = visitorKeyFor(lid, data.visitor_token || data.visitorToken || '');
  const target = resolveLikeTarget(db, lid, data.target_type, data.target_id, visitorKey);
  if (target.target_type !== 'comment' && !config.allow_item_like) {
    throw fail('VALIDATION', 'Item likes are turned off for this site');
  }
  const existing = db
    .prepare('SELECT id FROM module_likes WHERE lead_id = ? AND target_type = ? AND target_id = ? AND visitor_key = ?')
    .get(lid, target.target_type, target.target_id, visitorKey);
  let liked;
  if (existing) {
    db.prepare('DELETE FROM module_likes WHERE id = ?').run(existing.id);
    liked = false;
  } else {
    db.prepare('INSERT INTO module_likes (lead_id, target_type, target_id, visitor_key) VALUES (?, ?, ?, ?)').run(
      lid,
      target.target_type,
      target.target_id,
      visitorKey
    );
    liked = true;
  }
  const count =
    target.target_type === 'comment'
      ? refreshCommentLikeCount(db, lid, target.target_id)
      : likeCount(db, lid, target.target_type, target.target_id);
  return { liked, count, target_type: target.target_type, target_id: target.target_id };
}

/** The caller's own like state for a thread — pressed buttons only;
 *  counts always ride the thread payload itself. */
function likeState(db, leadId, data = {}) {
  ensureTables(db);
  const lid = Number(leadId);
  const out = { item_liked: false, liked_comment_ids: [] };
  // Batch 143: an unusable token has no like identity — report the
  // empty state rather than the shared sentinel bucket's likes.
  if (!hasUsableVisitorToken(data)) return out;
  const visitorKey = visitorKeyFor(lid, data.visitor_token || data.visitorToken || '');
  if (data.target_type && data.target_id != null && String(data.target_id) !== '') {
    const t = resolveTarget(db, lid, data.target_type, data.target_id);
    const row = db
      .prepare(
        'SELECT id FROM module_likes WHERE lead_id = ? AND target_type = ? AND target_id = ? AND visitor_key = ?'
      )
      .get(lid, t.target_type, t.target_id, visitorKey);
    out.item_liked = !!row;
  }
  const ids = Array.isArray(data.comment_ids) ? data.comment_ids : [];
  for (const id of ids.slice(0, 300)) {
    if (!/^\d+$/.test(String(id))) continue;
    const row = db
      .prepare(
        "SELECT id FROM module_likes WHERE lead_id = ? AND target_type = 'comment' AND target_id = ? AND visitor_key = ?"
      )
      .get(lid, String(id), visitorKey);
    if (row) out.liked_comment_ids.push(Number(id));
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Public thread + payloads                                            */
/* ------------------------------------------------------------------ */

/** The published thread for one target, threaded one level. Pending
 *  and rejected comments NEVER appear; author emails never leave the
 *  server. Bodies are raw plain text — the embed renders them with
 *  textContent only. */
function publicThread(db, leadId, targetType, targetId) {
  ensureTables(db);
  const lid = Number(leadId);
  const target = resolveTarget(db, lid, targetType, targetId);
  const rows = db
    .prepare(
      `SELECT * FROM module_comments
        WHERE lead_id = ? AND target_type = ? AND target_id = ? AND status = 'published'
        ORDER BY id ASC LIMIT ?`
    )
    .all(lid, target.target_type, target.target_id, THREAD_PAGE_MAX * 2);
  const tops = [];
  const byId = new Map();
  for (const r of rows) {
    const c = commentShape(r);
    c.replies = [];
    byId.set(c.id, c);
    if (c.parent_id == null) tops.push(c);
  }
  for (const r of rows) {
    if (r.parent_id == null) continue;
    const child = byId.get(Number(r.id));
    const parent = byId.get(Number(r.parent_id));
    // A reply renders only under its published top-level parent; a
    // reply whose parent left the published set stays hidden with it.
    if (child && parent) parent.replies.push(child);
  }
  return {
    target,
    like_count: likeCount(db, lid, target.target_type, target.target_id),
    comments: tops.slice(0, THREAD_PAGE_MAX),
  };
}

/** Public-safe config subset for the embed. */
function publicConfig(config) {
  return {
    moderation_held: !!config.moderation_held,
    allow_likes: !!config.allow_likes,
    allow_item_like: !!config.allow_item_like,
    comments_enabled: !!config.comments_enabled,
    target_mode: config.target_mode,
    target_type: config.target_type,
    heading: config.heading,
  };
}

/**
 * The `comments` block for getPublicModuleByToken (no item open):
 * page-mode embeds carry their page thread; item-mode embeds carry
 * only the binding (their thread arrives with the item payload).
 */
function publicPayload(db, leadId, embedRow, opts = {}) {
  ensureTables(db);
  const lid = Number(leadId);
  const config = getCommentsConfig(db, lid);
  const out = { config: publicConfig(config), thread: null };
  if (!config.comments_enabled) return out;
  if (config.target_mode === 'page') {
    const slug = String(opts.pageSlug || (embedRow && embedRow.target_page_slug) || '').trim();
    if (slug) {
      try {
        out.thread = publicThread(db, lid, 'page', slug);
      } catch {
        /* unknown page — dormant, never an error on a public page */
      }
    }
  }
  return out;
}

/**
 * The item context for getPublicModuleItem when a comments embed is
 * handed the page's bpItem key: resolve the key under the embed's
 * configured target_type (shared-layer identity — id or slug). An
 * unresolvable key is NOT an error: the block simply stays dormant
 * (returns null) — the Batch 130 lesson: a neighboring module must
 * never paint an error for an item that isn't its own.
 */
function publicItemContext(db, leadId, embedRow, slugOrId) {
  ensureTables(db);
  const lid = Number(leadId);
  const config = getCommentsConfig(db, lid);
  if (!config.comments_enabled || config.target_mode !== 'item') return null;
  let target = null;
  try {
    target = resolveTarget(db, lid, config.target_type, slugOrId);
  } catch {
    return null;
  }
  return {
    config: publicConfig(config),
    thread: publicThread(db, lid, target.target_type, target.target_id),
    target: { ...target },
  };
}

/**
 * Batch 131 finisher (Batch 133 detail wiring): the comment context
 * for a universal detail page — the detail page is keyed by the
 * ITEM's own (type, key), not by this block's configured binding, so
 * any published provider item can carry its thread there. Returns
 * null when comments are off or the target doesn't resolve
 * (dormant, never an error on a detail page).
 */
function publicDetailContext(db, leadId, targetType, targetId) {
  ensureTables(db);
  const lid = Number(leadId);
  const config = getCommentsConfig(db, lid);
  if (!config.comments_enabled) return null;
  let target = null;
  try {
    target = resolveTarget(db, lid, targetType, targetId);
  } catch {
    return null;
  }
  return {
    config: publicConfig(config),
    thread: publicThread(db, lid, target.target_type, target.target_id),
    target: { ...target },
  };
}

/* ------------------------------------------------------------------ */
/* Token entry points (public routes)                                  */
/* ------------------------------------------------------------------ */

function embedRowByToken(db, token) {
  const row = db.prepare('SELECT * FROM site_module_embeds WHERE public_token = ?').get(String(token || ''));
  if (!row || row.module_type !== 'comments') {
    throw fail('NOT_FOUND', 'Comments module not found', 404);
  }
  return row;
}

/** The gates every public comments write runs, through the ONE
 *  public payload path (Photo Capture precedent): archived and
 *  suspended sites throw inside getPublicModuleByToken; a member-
 *  gated page comes back as a locked payload, refused here. */
function gateByToken(db, token, opts = {}) {
  const row = embedRowByToken(db, token);
  const payload = modules.getPublicModuleByToken(db, token, opts);
  if (payload.locked) throw fail('MEMBER_LOCKED', 'Sign in to continue', 403);
  return { row, leadId: Number(row.lead_id), payload };
}

/**
 * Public comment creation by embed token — mirrors Photo Capture's
 * discipline: the embed's gates run first (archived / suspended /
 * member page gate), the response is state-blind beyond the caller's
 * own comment (its status so the embed can show the "awaiting
 * approval" note), and the target in the body must match the embed's
 * binding — in item mode the type must be the configured target_type;
 * in page mode the only legal target is the embed's own page.
 */
function createPublicComment(db, token, data = {}, opts = {}) {
  ensureTables(db);
  const { row, leadId } = gateByToken(db, token, opts);
  const config = getCommentsConfig(db, leadId);
  if (!config.comments_enabled) throw fail('VALIDATION', 'Comments are turned off for this site');

  let targetType = String(data.target_type || '')
    .trim()
    .toLowerCase();
  let targetId = data.target_id;
  // Batch 131 finisher (detail surface): a post from a universal
  // detail page carries detail=1 — its target is the item the page
  // itself resolved, keyed by the item's own type, so the block's
  // configured binding does not apply. The target still resolves
  // through the shared layer inside createComment (published-only,
  // lead-scoped) — a foreign or draft target is refused there.
  const isDetail = data.detail === true || data.detail === 1 || data.detail === '1';
  if (isDetail) {
    /* Batch 168 (S3#6): detail=1 skipped ALL binding checks — the
     * type stood as posted, so a comment could be attached to any
     * shared-layer type an item id resolved under (e.g. type
     * 'pricing' with a pricing-entry id: stored, counted by the
     * owner's roll-up, rendered nowhere). The detail page only ever
     * serves DETAIL_TYPES, so the legal set is exactly that list;
     * the item binding itself (exists, published, this lead) still
     * runs inside createComment via the shared layer. */
    if (!modules.DETAIL_TYPES.includes(targetType)) {
      throw fail('VALIDATION', 'That item does not belong to this comments block');
    }
  } else if (config.target_mode === 'page') {
    targetType = 'page';
    targetId = String(opts.pageSlug || row.target_page_slug || '').trim();
  } else {
    if (targetType && targetType !== config.target_type) {
      throw fail('VALIDATION', 'That item does not belong to this comments block');
    }
    targetType = config.target_type;
  }
  const created = createComment(db, leadId, {
    ...data,
    target_type: targetType,
    target_id: targetId,
    page_slug: opts.pageSlug || row.target_page_slug || '',
  });
  // The embed re-renders from the refreshed published thread when the
  // comment published immediately; a held comment stays invisible.
  let thread = null;
  if (created.status === 'published') {
    try {
      thread = publicThread(db, leadId, created.comment.target_type, created.comment.target_id);
    } catch {
      /* dormant */
    }
  }
  return {
    comment: created.comment,
    status: created.status,
    message:
      created.status === 'pending' ? 'Thanks — your comment is awaiting approval.' : 'Thanks — your comment is live.',
    thread,
  };
}

function togglePublicLike(db, token, data = {}, opts = {}) {
  ensureTables(db);
  const { leadId } = gateByToken(db, token, opts);
  return toggleLike(db, leadId, data);
}

function publicLikeState(db, token, data = {}, opts = {}) {
  ensureTables(db);
  const { leadId } = gateByToken(db, token, opts);
  return likeState(db, leadId, data);
}

module.exports = {
  COMMENT_STATUSES,
  COMMENT_BODY_MAX,
  ensureTables,
  getCommentsConfig,
  updateCommentsConfig,
  resolveTarget,
  visitorKeyFor,
  createComment,
  getCommentForOwner,
  replyAsOwner,
  setCommentStatus,
  deleteComment,
  listCommentsForOwner,
  countComments,
  listCommentTargets,
  toggleLike,
  likeState,
  likeCount,
  publicThread,
  publicPayload,
  publicItemContext,
  publicDetailContext,
  createPublicComment,
  togglePublicLike,
  publicLikeState,
  getCommentRow,
};
