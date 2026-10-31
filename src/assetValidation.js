'use strict';

/**
 * Batch 102 (SEC-20) — content validation for website.uploadAsset.
 *
 * Before this module, uploadAsset trusted the filename extension
 * only: a script-bearing SVG (and HTML under a .png name) was stored
 * verbatim and served from the site's own origin (Audit 2 §D-1).
 * The rule now: the BYTES must match the extension's family —
 *   - raster images: magic bytes must match (png/jpg/gif/webp);
 *   - SVG: must parse as an SVG document and carry no script-capable
 *     constructs (script/foreignObject/event handlers/javascript:
 *     URLs/DOCTYPE entities) — rejected, not sanitized, so what is
 *     stored is always exactly what was validated;
 *   - ico / fonts / video: container magic must match.
 * Returns { ok: true, kind } or { ok: false, error }.
 */

function sniffRaster(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'gif';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

function validateSvg(buf) {
  const text = buf.toString('utf8');
  if (!/<svg[\s>]/i.test(text.slice(0, 4096))) {
    return { ok: false, error: 'SVG upload does not start with an <svg> document.' };
  }
  if (/<!doctype|<!entity/i.test(text)) {
    return { ok: false, error: 'SVG with a DOCTYPE/entity declaration is not accepted.' };
  }
  if (/<script[\s>]|<foreignobject[\s>]/i.test(text)) {
    return { ok: false, error: 'SVG containing script or foreignObject is not accepted.' };
  }
  if (/\son[a-z]+\s*=/i.test(text)) {
    return { ok: false, error: 'SVG containing event-handler attributes is not accepted.' };
  }
  if (/javascript\s*:/i.test(text)) {
    return { ok: false, error: 'SVG containing javascript: URLs is not accepted.' };
  }
  if (/<(?:animate|set)[^>]+(?:href|xlink:href)\s*=\s*["']?\s*javascript:/i.test(text)) {
    return { ok: false, error: 'SVG containing scripted animation targets is not accepted.' };
  }
  return { ok: true, kind: 'svg' };
}

function validateAssetBuffer(filename, buf) {
  const name = String(filename || '');
  const extMatch = name.toLowerCase().match(/\.([a-z0-9]+)$/);
  const ext = extMatch ? extMatch[1] : '';
  if (!Buffer.isBuffer(buf) || !buf.length) return { ok: false, error: 'Empty asset data' };

  if (ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'gif' || ext === 'webp') {
    const want = ext === 'jpeg' ? 'jpg' : ext;
    const got = sniffRaster(buf);
    if (got !== want) {
      return {
        ok: false,
        error: `Asset content does not match its .${ext} extension (detected: ${got || 'unknown'}). Upload the real image format.`,
      };
    }
    return { ok: true, kind: want };
  }
  if (ext === 'svg') return validateSvg(buf);
  if (ext === 'ico') {
    const ok = buf.length >= 4 && buf[0] === 0 && buf[1] === 0 && (buf[2] === 1 || buf[2] === 2) && buf[3] === 0;
    return ok ? { ok: true, kind: 'ico' } : { ok: false, error: 'Asset content is not a valid .ico file.' };
  }
  if (ext === 'woff2') {
    return buf.toString('ascii', 0, 4) === 'wOF2'
      ? { ok: true, kind: 'woff2' }
      : { ok: false, error: 'Asset content is not a valid .woff2 font.' };
  }
  if (ext === 'woff') {
    return buf.toString('ascii', 0, 4) === 'wOFF'
      ? { ok: true, kind: 'woff' }
      : { ok: false, error: 'Asset content is not a valid .woff font.' };
  }
  if (ext === 'ttf') {
    const sig = buf.toString('ascii', 0, 4);
    const ok = (buf[0] === 0 && buf[1] === 1 && buf[2] === 0 && buf[3] === 0) || sig === 'true' || sig === 'ttcf';
    return ok ? { ok: true, kind: 'ttf' } : { ok: false, error: 'Asset content is not a valid .ttf font.' };
  }
  if (ext === 'otf') {
    return buf.toString('ascii', 0, 4) === 'OTTO'
      ? { ok: true, kind: 'otf' }
      : { ok: false, error: 'Asset content is not a valid .otf font.' };
  }
  if (ext === 'mp4') {
    return buf.toString('ascii', 4, 8) === 'ftyp'
      ? { ok: true, kind: 'mp4' }
      : { ok: false, error: 'Asset content is not a valid .mp4 file.' };
  }
  if (ext === 'webm') {
    const ok = buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3;
    return ok ? { ok: true, kind: 'webm' } : { ok: false, error: 'Asset content is not a valid .webm file.' };
  }
  return { ok: false, error: `Unsupported asset extension: .${ext || '(none)'}` };
}

/**
 * Workspace-scoped staging folder for a site's app-storage files —
 * Batch 102 (SEC-20): the legacy `site-<id>` folder is keyed by the
 * per-workspace site id alone, so two workspaces' site #1 shared one
 * folder. New writes go to `ws-<workspaceId>-site-<siteId>`; readers
 * consult BOTH (scoped first) so already-staged assets keep shipping.
 */
function siteStorageFolder(workspaceId, siteId) {
  const ws = Number(workspaceId);
  const id = Number(siteId);
  if (Number.isInteger(ws) && ws > 0 && Number.isInteger(id) && id > 0) return `ws-${ws}-site-${id}`;
  return `site-${id}`;
}

function siteStorageFolders(workspaceId, siteId) {
  const scoped = siteStorageFolder(workspaceId, siteId);
  const legacy = `site-${Number(siteId)}`;
  return scoped === legacy ? [scoped] : [scoped, legacy];
}

/**
 * Engine modules receive only the workspace DB handle; the workspace
 * id is recoverable from the DB file path (…/workspaces/<id>/….db).
 * Returns null for in-memory/temp DBs (tests) — callers then keep the
 * legacy folder, which is collision-free in a single-tenant fixture.
 */
function workspaceIdFromDb(db) {
  try {
    const name = db && db.name ? String(db.name) : '';
    const m = name.replace(/\\/g, '/').match(/\/workspaces\/(\d+)\//);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

function siteStorageFoldersForDb(db, siteId) {
  return siteStorageFolders(workspaceIdFromDb(db), siteId);
}

function siteStorageFolderForDb(db, siteId) {
  return siteStorageFolder(workspaceIdFromDb(db), siteId);
}

module.exports = {
  validateAssetBuffer,
  sniffRaster,
  siteStorageFolder,
  siteStorageFolders,
  workspaceIdFromDb,
  siteStorageFoldersForDb,
  siteStorageFolderForDb,
};
