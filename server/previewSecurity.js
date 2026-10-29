'use strict';

const PUBLIC_PREVIEW_API =
  /^\/api\/v1\/(?:forms\/public|modules\/public|chat\/public|outreach\/public)(?:\/|$)|^\/api\/v1\/captcha\/config\/?$/;
// This public, credential-free bridge must also embed below opaque ancestors.
// frame-ancestors * rejects opaque ancestors; omit that directive here only.
const CAPTCHA_CSP =
  "default-src 'none'; script-src 'unsafe-inline' https://challenges.cloudflare.com; style-src 'unsafe-inline'; connect-src 'self' https:; frame-src https://challenges.cloudflare.com; img-src https: data:; base-uri 'none'; form-action 'none'";

function rejectOpaqueAppRequests(req, res, next) {
  if (req.headers.origin !== 'null') return next();
  // Public embeds use tokens, never staff/portal sessions or authorization.
  delete req.headers.cookie;
  delete req.headers.authorization;
  if (/^\/(?:api|mcp|ws|oauth|authorize)(?:\/|$)/i.test(req.path || '') && !PUBLIC_PREVIEW_API.test(req.path || '')) {
    return res
      .status(403)
      .json({ ok: false, code: 'PREVIEW_ORIGIN_DENIED', error: 'Preview cannot access authenticated app APIs' });
  }
  return next();
}

/**
 * Batch 27 → Batch 64: an archived (soft-deleted) site's public preview
 * must not serve. Preview folders carry the site id:
 *   ws-{ws}-site-{id}          canonical export folder (no slug)
 *   ws-{ws}-site-{id}-{slug}   canonical export folder (export_slug suffix)
 *   site-{id} / qa-site-{id}   screenshots + QA preview dirs (workspace 1)
 *   {slug}-{id}                legacy export folders (workspace 1)
 * When an id resolves, look the site up in its workspace and answer
 * 410 SITE_ARCHIVED — the same status + body the public module API
 * returns (server/siteModules.js assertSiteNotArchived) — when
 * archived_at is set. Anything unresolvable or any lookup failure
 * falls through unchanged, so a missing folder still 404s downstream.
 *
 * Batch 64 fix: the Batch 27 regex required the id at the very END of
 * the folder name, so the canonical {id}-{exportSlug} folders never
 * matched and archived sites kept serving their full preview (found by
 * Ely's delete test, 2026-10-29: /site-previews/ws-1-site-27-…/ 200
 * while site 27 was archived). Resolution is now anchored at the
 * folder-name START for the ws-/site- shapes, so sibling ids can never
 * be misread (site-270 never resolves as site 27).
 *
 * Deliberately NOT resolved as websites: ws-{ws}-design-{jobId}
 * folders (see the design branch in blockArchivedPreviews).
 * website-promo/ brochure assets encode no website id; they fall
 * through unchanged.
 *
 * Batch 67 hardening (final review H-1/H-2/M-1/M-2):
 *   H-1 — Express req.path is percent-ENCODED while serve-static
 *     decodes before the filesystem lookup, so encoding any character
 *     of the folder segment (ws-1-site-%32%38-…) defeated every regex
 *     above. The gate now decodes each segment (decodeURIComponent
 *     loop until stable; malformed/never-stable → fail CLOSED with
 *     the same 410) before matching, on both /site-previews mounts.
 *   H-2 — the gate used to inspect only segment[0], but send
 *     normalizes `..` AFTER the gate, so
 *     /ws-1-site-21-…/../ws-1-site-28-…/ served the archived folder.
 *     Any decoded `..` segment (incl. %2e%2e and ..%2f forms, which
 *     the decode-first split exposes) is rejected outright, and every
 *     segment of the decoded path is re-gated, not just the first.
 *   M-1 — a site folder whose websites ROW is missing used to fall
 *     through and serve in full (an orphaned export folder is public
 *     forever; that is exactly how site 28's folder kept serving
 *     after its row left with lead 641's delete). A resolved site
 *     folder with NO row now answers 410 when the folder actually
 *     exists on disk; a folder that does not exist still falls
 *     through so nonexistent previews keep their downstream 404.
 *   M-2 — ws-{ws}-design-{jobId} folders are resolved through
 *     design_jobs.website_id: a job linked to an archived (or now
 *     missing) website gets the same 410, and a design folder with
 *     no job row is treated like M-1 (410 when it exists on disk).
 *     Unlinked jobs (website_id NULL) remain deliberate job
 *     artifacts and pass.
 */
const SITE_ARCHIVED_BODY = {
  ok: false,
  code: 'SITE_ARCHIVED',
  error: 'This site is no longer available',
};

function resolveSiteFolderSegment(seg) {
  let m = seg.match(/^ws-(\d+)-site-(\d+)(?:-|$)/);
  if (m) return { workspaceId: Number(m[1]), siteId: Number(m[2]) };
  m = seg.match(/^(?:qa-)?site-(\d+)(?:-|$)/);
  if (m) return { workspaceId: 1, siteId: Number(m[1]) };
  // Legacy {slug}-{id}: trailing id only, and never inside the ws-*
  // namespace (ws-{ws}-design-{job} must not resolve as a website).
  if (!/^ws-\d+-/.test(seg)) {
    m = seg.match(/-(\d+)$/);
    if (m) return { workspaceId: 1, siteId: Number(m[1]) };
  }
  return null;
}

function resolvePreviewSite(pathname) {
  const seg = String(pathname || '').split('/').filter(Boolean)[0] || '';
  return resolveSiteFolderSegment(seg);
}

function resolvePreviewDesign(seg) {
  const m = String(seg || '').match(/^ws-(\d+)-design-(\d+)(?:-|$)/);
  return m ? { workspaceId: Number(m[1]), jobId: Number(m[2]) } : null;
}

/**
 * Batch 67 (H-1): decode one path segment until stable. Returns null
 * when the encoding is malformed or never stabilizes (over-encoded)
 * — callers fail closed. `+` is NOT special in a path segment.
 */
function decodeSegmentStable(seg) {
  let cur = String(seg);
  for (let i = 0; i < 5; i++) {
    let next;
    try {
      next = decodeURIComponent(cur);
    } catch {
      return null;
    }
    if (next === cur) return cur;
    cur = next;
  }
  return null;
}

/**
 * Batch 67 (H-1/H-2): turn a raw (still percent-encoded) req.path
 * into the decoded segment list serve-static/send will effectively
 * traverse. A decoded segment may itself contain '/' (the ..%2f
 * form), so decoded parts are split again — after which a literal
 * '..' part is unambiguous traversal.
 */
function analyzePreviewPath(pathname) {
  const rawSegs = String(pathname || '').split('/').filter(Boolean);
  const segs = [];
  for (const raw of rawSegs) {
    const dec = decodeSegmentStable(raw);
    if (dec === null) return { malformed: true, traversal: false, segs: [] };
    for (const part of dec.split('/')) {
      if (part) segs.push(part);
    }
  }
  return { malformed: false, traversal: segs.includes('..'), segs };
}

/** Batch 67 (M-1/M-2): does this exact folder exist under the export root? */
function previewFolderExists(seg) {
  try {
    if (!seg || seg.includes('/') || seg.includes('\\')) return false;
    const fsMod = require('fs');
    const pathMod = require('path');
    const root = require('../src/openPreview').exportRoot();
    return fsMod.statSync(pathMod.join(root, seg)).isDirectory();
  } catch {
    return false;
  }
}

function sendArchivedPreview(res) {
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Access-Control-Allow-Origin', '*');
  return res.status(410).json({ ...SITE_ARCHIVED_BODY });
}

function blockArchivedPreviews(req, res, next) {
  try {
    const analysis = analyzePreviewPath(req.path);
    // Fail closed on malformed encoding and on any traversal: neither
    // can be a legitimate preview path (folder/file names on disk are
    // sanitized), and both were verified bypasses of the Batch 64 gate.
    if (analysis.malformed || analysis.traversal) {
      return sendArchivedPreview(res);
    }
    for (const seg of analysis.segs) {
      const target = resolveSiteFolderSegment(seg);
      if (target) {
        const db = require('./workspaceDb').openWorkspaceDb(target.workspaceId);
        const row = db.prepare('SELECT archived_at FROM websites WHERE id = ?').get(target.siteId);
        if (row && row.archived_at) {
          return sendArchivedPreview(res);
        }
        // M-1: no row + a real folder on disk = orphaned export of a
        // site that no longer exists — gone, not public. No folder →
        // fall through so the downstream 404 stands.
        if (!row && previewFolderExists(seg)) {
          return sendArchivedPreview(res);
        }
        continue;
      }
      const design = resolvePreviewDesign(seg);
      if (design) {
        const db = require('./workspaceDb').openWorkspaceDb(design.workspaceId);
        let job = null;
        try {
          job = db.prepare('SELECT website_id FROM design_jobs WHERE id = ?').get(design.jobId);
        } catch {
          job = null; /* older workspace DB without design_jobs: treat as missing */
        }
        if (!job) {
          if (previewFolderExists(seg)) {
            return sendArchivedPreview(res);
          }
          continue;
        }
        if (job.website_id) {
          const siteRow = db.prepare('SELECT archived_at FROM websites WHERE id = ?').get(job.website_id);
          // Linked to an archived site — or to a site row that has
          // since been deleted (lead-delete cascade): same 410.
          if (!siteRow || siteRow.archived_at) {
            return sendArchivedPreview(res);
          }
        }
        continue;
      }
    }
    return next();
  } catch {
    return next();
  }
}

function isolateStaticPreview(req, res, next) {
  // Enforced response policy also protects direct visits outside an iframe.
  res.setHeader(
    'Content-Security-Policy',
    "sandbox allow-scripts allow-forms; default-src 'self' https: data: blob:; script-src 'self' https: 'unsafe-inline'; style-src 'self' https: 'unsafe-inline'; img-src 'self' https: data: blob:; font-src 'self' https: data:; connect-src 'self' https:; object-src 'none'; frame-ancestors 'self'; form-action https:"
  );
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
}

module.exports = {
  rejectOpaqueAppRequests,
  isolateStaticPreview,
  blockArchivedPreviews,
  resolvePreviewSite,
  resolvePreviewDesign,
  analyzePreviewPath,
  SITE_ARCHIVED_BODY,
  CAPTCHA_CSP,
};
