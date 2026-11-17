'use strict';

/**
 * Batch 195 — Admin re-upload / replace for portal Training videos.
 *
 * Batch 194's seeded module videos are committed files under
 * public/training/ and public/training-mobile/ — baked into the
 * container image, so an admin upload can never be written there
 * (it would vanish on the next deploy). Following the Batch 87
 * branding pattern instead: uploaded files live on the DATA volume
 *   <dataRoot>/training-videos/(main|mobile)/<slug>.mp4
 * and SHADOW the baked file at the same canonical URL
 * (/training/<slug>.mp4, /training-mobile/<slug>.mp4): server.js
 * checks this store first and falls through to express.static when
 * no upload exists, so every existing surface (portal player, admin
 * list) keeps referencing the Batch 194 URLs untouched.
 *
 * Replace is an atomic tmp-write + rename over the SAME basename:
 * a replace never orphans the previous upload, and a viewer mid-
 * stream keeps the old inode until their request finishes — only
 * new requests see the new file. The baked seed file is never
 * modified or deleted; removing the uploaded shadow (module delete
 * cleanup below) restores it exactly.
 *
 * Validation mirrors the app's other upload paths (branding logos,
 * portal module assets): base64-in-JSON transport, a hard byte cap,
 * and magic-byte sniffing — the client's claimed type/filename is
 * never trusted. Cap: 50 MB. The app's other caps are 4 MB (logo),
 * ~5 MB (photo capture), 8 MB (brochure), 10 MB (chat attachment);
 * video is the largest media type the app handles and the seeded
 * modules already run to 5.3 MB, so the cap gives ~10x headroom
 * while staying bounded. server.js raises the JSON body limit for
 * this one route to 70 MB (~4/3 base64 inflation of the cap).
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const VIDEO_MAX_BYTES = 50 * 1024 * 1024;
const FILE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,119}\.mp4$/;
// ISO-BMFF major brands (the mp4 family the seeded modules use).
const MP4_BRANDS = new Set([
  'isom',
  'iso2',
  'iso3',
  'iso4',
  'iso5',
  'iso6',
  'iso8',
  'mp41',
  'mp42',
  'mp71',
  'avc1',
  'dash',
  'M4V ',
  'M4VP',
  'MSNV',
  'NDAS',
  'NDSC',
  'NDSH',
  'NDSM',
  'NDSP',
  'NDSS',
  'NDXC',
  'NDXH',
  'NDXM',
  'NDXP',
  'NDXS',
]);

function coded(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function videosRoot() {
  const { dataRoot } = require('./workspaceDb');
  return path.join(dataRoot(), 'training-videos');
}

function slotDir(slot) {
  return path.join(videosRoot(), slot === 'mobile' ? 'mobile' : 'main');
}

function canonicalUrl(slot, slug) {
  return slot === 'mobile' ? `/training-mobile/${slug}.mp4` : `/training/${slug}.mp4`;
}

/** Magic-byte sniff: an ISO-BMFF ftyp box with an mp4-family major brand. */
function sniffMp4(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return false;
  if (buf.toString('ascii', 4, 8) !== 'ftyp') return false;
  return MP4_BRANDS.has(buf.toString('ascii', 8, 12));
}

function validateVideoBuffer(buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) throw coded('EMPTY', 'No video file was provided.');
  if (buf.length > VIDEO_MAX_BYTES) {
    throw coded('TOO_LARGE', `Training videos are limited to ${VIDEO_MAX_BYTES / (1024 * 1024)} MB.`);
  }
  if (!sniffMp4(buf)) throw coded('INVALID_VIDEO', 'The uploaded file is not an MP4 video.');
}

/**
 * Absolute file for an uploaded video name in a slot, or null when
 * the name is not a minted module-video name / the file is gone.
 * The basename is validated against the strict pattern before any
 * filesystem use, so a tampered name can never escape the slot dir.
 */
function storedVideoFile(slot, name) {
  const n = String(name == null ? '' : name);
  if (!FILE_NAME_RE.test(n)) return null;
  const file = path.join(slotDir(slot), n);
  try {
    if (!fs.statSync(file).isFile()) return null;
  } catch {
    return null;
  }
  return { file, name: n, contentType: 'video/mp4' };
}

/**
 * Validate + store a replacement video for a module slot, point the
 * module's URL field at the canonical path, and return the updated
 * module. The previous upload at the same basename is replaced by
 * the atomic rename (no orphan); the baked seed file is untouched.
 */
async function replaceModuleVideo(id, slot, buf) {
  const s = slot === 'mobile' ? 'mobile' : slot === 'main' ? 'main' : null;
  if (!s) throw coded('INVALID', "slot must be 'main' or 'mobile'");
  validateVideoBuffer(buf);
  const learning = require('./learningModules');
  const all = await learning.listAll();
  const mod = all.find((m) => m.id === Number(id));
  if (!mod) throw coded('NOT_FOUND', 'NOT_FOUND');
  const dir = slotDir(s);
  fs.mkdirSync(dir, { recursive: true });
  const name = `${mod.slug}.mp4`;
  const tmp = path.join(dir, `.upload-${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`);
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, path.join(dir, name));
  const url = canonicalUrl(s, mod.slug);
  const updated = await learning.updateModule(mod.id, s === 'mobile' ? { videoMobileUrl: url } : { videoUrl: url });
  return { module: updated, url, bytes: buf.length, slot: s };
}

/** Best-effort removal of a module's uploaded videos (module delete). */
function deleteModuleVideos(slug) {
  const name = `${String(slug || '')}.mp4`;
  if (!FILE_NAME_RE.test(name)) return;
  for (const s of ['main', 'mobile']) {
    try {
      fs.unlinkSync(path.join(slotDir(s), name));
    } catch {
      /* already gone */
    }
  }
}

module.exports = {
  VIDEO_MAX_BYTES,
  canonicalUrl,
  sniffMp4,
  validateVideoBuffer,
  storedVideoFile,
  replaceModuleVideo,
  deleteModuleVideos,
};
