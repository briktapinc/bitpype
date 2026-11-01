'use strict';

/**
 * Batch 111 (consolidation step 4) — shared portal site helpers: site resolution, preview URLs, page-shape probes, JSON parsing, content-path writes.
 * PURE code motion from server/clientPortal.js (no logic edits);
 * server/clientPortal.js re-exports the full original surface.
 */

const path = require('path');
const { appUrl } = require('./stripeClient');

function resolvePreviewUrl(site) {
  if (!site) return null;
  if (site.preview_url && String(site.preview_url).trim()) {
    return String(site.preview_url).trim();
  }
  if (site.preview_path && String(site.preview_path).trim()) {
    const p = String(site.preview_path).replace(/\\/g, '/');
    const m = p.match(/website-scout-exports\/([^/]+)/i) || p.match(/\/([^/]+-site-[^/]+)\/?$/i);
    if (m) {
      return `${appUrl()}/site-previews/${m[1]}/`;
    }
    // Absolute export folder name as last path segment
    const parts = p.split('/').filter(Boolean);
    const last = parts[parts.length - 1];
    if (last && /site|ws-/i.test(last)) {
      return `${appUrl()}/site-previews/${last}/`;
    }
  }
  return null;
}

/**
 * Base URL for srcdoc asset resolution. Prefer APP_URL /site-previews/…
 * (local rematerialized export) over Cloudflare preview_url so portal image
 * uploads are visible immediately without a Pages republish.
 * Folder must match materializeWebsiteExport (ws-{ws}-site-{id}-{export_slug}).
 */
function resolveExportPreviewBase(workspaceId, site) {
  if (!site || site.id == null) return resolvePreviewUrl(site);
  const base = String(appUrl() || '').replace(/\/+$/, '');
  if (!base) return resolvePreviewUrl(site);
  if (site.preview_path && String(site.preview_path).trim()) {
    const p = String(site.preview_path).replace(/\\/g, '/');
    // Prefer full folder segment (includes export_slug). Avoid bare ws-N-site-M
    // which truncates slug folders like ws-1-site-1-c59b… → ws-1-site-1.
    const m = p.match(/website-scout-exports\/([^/]+)/i) || p.match(/\/(ws-\d+-site-\d+(?:-[A-Za-z0-9_-]+)?)(?:\/|$)/i);
    if (m) return `${base}/site-previews/${m[1]}/`;
  }
  try {
    const domain = require('./domain');
    const folder = domain.resolveSiteExportFolder(workspaceId, site);
    return `${base}/site-previews/${folder}/`;
  } catch {
    /* fall through */
  }
  const folder = `ws-${Number(workspaceId)}-site-${Number(site.id)}`;
  return `${base}/site-previews/${folder}/`;
}

/** Paths clients must not change via inline portal edit (verified facts / URLs). */
const PORTAL_LOCKED_PATH =
  /(^|\.)(phone|phone_display|email|address|address_lines|hours|rating|review_count|business_name|href|cta_href|cta_secondary_href|button_href|url|photographer|photographer_url|pexels_url)$/;

function isPortalLockedPath(path) {
  return PORTAL_LOCKED_PATH.test(String(path || ''));
}

function setContentPath(obj, path, value) {
  const parts = String(path).split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = /^\d+$/.test(parts[i]) ? Number(parts[i]) : parts[i];
    if (cur[key] == null || typeof cur[key] !== 'object') {
      cur[key] = /^\d+$/.test(parts[i + 1]) ? [] : {};
    }
    cur = cur[key];
  }
  const last = parts[parts.length - 1];
  cur[/^\d+$/.test(last) ? Number(last) : last] = value;
}

function pagesHaveEditableSections(pages) {
  return Array.isArray(pages) && pages.some((p) => Array.isArray(p.sections) && p.sections.length > 0);
}

/** Section model or freeform page.html — both support portal inline text edit. */
function pagesSupportInlineEdit(pages) {
  return (
    Array.isArray(pages) &&
    pages.some(
      (p) => (Array.isArray(p.sections) && p.sections.length > 0) || (typeof p.html === 'string' && p.html.trim())
    )
  );
}

function pagesHaveFreeformHtml(pages) {
  return Array.isArray(pages) && pages.some((p) => typeof p.html === 'string' && p.html.trim());
}

function parseJsonSafe(raw, fallback) {
  if (raw == null) return fallback;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/**
 * Resolve the client's site for their linked lead only (workspace + lead scoped).
 */
function resolveClientSite(db, leadId) {
  const lid = Number(leadId);
  let site = null;
  try {
    site = db
      .prepare(
        `SELECT id, lead_id, name, status, pages, theme, preview_url, preview_path, export_slug, updated_at
       FROM websites WHERE lead_id = ? AND archived_at IS NULL ORDER BY id DESC LIMIT 1`
      )
      .get(lid);
  } catch (e) {
    // Older workspace DBs may lack export_slug until ensureExportSlug runs.
    if (!/no such column:\s*export_slug/i.test(String((e && e.message) || e))) throw e;
    try {
      const domain = require('./domain');
      if (typeof domain.ensureExportSlugColumn === 'function') {
        domain.ensureExportSlugColumn(db);
      } else if (typeof domain.ensureExportSlug === 'function') {
        // ensureExportSlug needs a site id — add column first via bare ALTER.
        try {
          db.exec('ALTER TABLE websites ADD COLUMN export_slug TEXT');
        } catch {
          /* exists */
        }
      }
    } catch {
      /* best-effort */
    }
    try {
      site = db
        .prepare(
          `SELECT id, lead_id, name, status, pages, theme, preview_url, preview_path, export_slug, updated_at
         FROM websites WHERE lead_id = ? AND archived_at IS NULL ORDER BY id DESC LIMIT 1`
        )
        .get(lid);
    } catch {
      site = db
        .prepare(
          `SELECT id, lead_id, name, status, pages, theme, preview_url, preview_path, updated_at
         FROM websites WHERE lead_id = ? AND archived_at IS NULL ORDER BY id DESC LIMIT 1`
        )
        .get(lid);
    }
  }
  if (!site) return null;
  return {
    id: site.id,
    lead_id: site.lead_id,
    name: site.name,
    status: site.status,
    pages: parseJsonSafe(site.pages, []),
    theme: parseJsonSafe(site.theme, {}) || {},
    preview_url: site.preview_url,
    preview_path: site.preview_path,
    export_slug: site.export_slug || null,
    updated_at: site.updated_at,
  };
}

/**
 * Render the client's website HTML with editable markers (data-edit / ws-edit).
 * Ownership: workspaceId + leadId from the portal session only.
 */

module.exports = {
  resolvePreviewUrl,
  resolveExportPreviewBase,
  isPortalLockedPath,
  setContentPath,
  pagesHaveEditableSections,
  pagesSupportInlineEdit,
  pagesHaveFreeformHtml,
  parseJsonSafe,
  resolveClientSite,
};
