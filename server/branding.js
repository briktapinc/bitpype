'use strict';
/**
 * Batch 87 — Admin-configurable platform branding (Ely 2026-10-30:
 * "also add site logo in admin for dark and light screens" + the
 * "Local business desk" tagline customizable in Admin too).
 *
 * Three platform settings (group `branding`, see PLATFORM_SETTING_DEFS
 * in server/platform.js) drive the first-party brand surfaces:
 *   branding.logo_dark  — full lockup shown on DARK surfaces
 *                         ('' = the committed default asset,
 *                         public/brand/logo-white.png — Batch 86
 *                         naming: the WHITE lockup for dark screens)
 *   branding.logo_light — full lockup shown on LIGHT surfaces
 *                         ('' = public/brand/logo-black.png /
 *                         logo-email.png — the BLACK lockup)
 *   branding.tagline    — the brand tagline ('' or blank falls back
 *                         to DEFAULT_TAGLINE, never renders blank)
 *
 * Uploaded logo files live on the DATA volume (never in public/,
 * which is baked into the container image):
 *   <dataRoot>/platform-brand/logo-(dark|light)-<ts>-<rand>.<ext>
 * and the setting stores the served path `/brand-files/<filename>`.
 * server.js intercepts the canonical brand URLs
 * (/brand/logo-white.png, /brand/logo-black.png, /brand/logo-email.png)
 * and serves the custom file when one is configured; otherwise the
 * request falls through to the committed default asset untouched.
 * server.js also serves the stored `/brand-files/<filename>` path
 * itself (Batch 92: Batch 87 minted the path but never mounted it, so
 * the Admin → Settings → Branding previews — whose <img> src is the
 * stored path — 404'd while the canonical URLs served the custom
 * logo fine).
 *
 * The sync cache mirrors the stripeClient public-URL and planContents
 * patterns: primed at boot, refreshed inside setPlatformSetting's
 * choke point (branding.* hook). Getters NEVER throw — a missing or
 * corrupt value renders the built-in default.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_TAGLINE = 'Local business desk';
const LOGO_KEYS = { dark: 'branding.logo_dark', light: 'branding.logo_light' };
const TAGLINE_KEY = 'branding.tagline';
const FILE_URL_PREFIX = '/brand-files/';
const LOGO_MAX_BYTES = 4 * 1024 * 1024;
const FILE_NAME_RE = /^logo-(dark|light)-\d+-[a-z0-9]{6}\.(png|jpg|svg|webp)$/;
const MIME_TO_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/svg+xml': 'svg' };
const EXT_TO_MIME = { png: 'image/png', jpg: 'image/jpeg', svg: 'image/svg+xml', webp: 'image/webp' };

let cache = { dark: '', light: '', tagline: DEFAULT_TAGLINE };

function coded(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function brandDir() {
  const { dataRoot } = require('./workspaceDb');
  return path.join(dataRoot(), 'platform-brand');
}

/** The stored/served path for a variant ('' when the default asset is in use). */
function validFileUrl(value) {
  const s = String(value == null ? '' : value).trim();
  if (!s.startsWith(FILE_URL_PREFIX)) return '';
  const name = s.slice(FILE_URL_PREFIX.length);
  return FILE_NAME_RE.test(name) ? s : '';
}

function tagline() {
  const t = String(cache.tagline || '').trim();
  return t || DEFAULT_TAGLINE;
}

/** Configured custom path for a variant ('dark' | 'light'), or ''. */
function customLogoPath(variant) {
  return variant === 'dark' || variant === 'light' ? cache[variant] || '' : '';
}

/**
 * Absolute file for a stored logo filename, or null when the name is
 * not a minted logo filename / the file is gone. The basename is
 * validated against the strict filename pattern before any filesystem
 * use, so a tampered name can never escape the brand directory.
 */
function storedLogoFile(name) {
  const n = String(name == null ? '' : name);
  if (!FILE_NAME_RE.test(n)) return null;
  const file = path.join(brandDir(), n);
  try {
    if (!fs.statSync(file).isFile()) return null;
  } catch {
    return null;
  }
  return { file, name: n, contentType: EXT_TO_MIME[n.split('.').pop()] || 'image/png' };
}

/**
 * Absolute file for the configured custom logo of a variant, or null
 * when unset / the stored value is corrupt / the file is gone.
 */
function customLogoFile(variant) {
  const url = customLogoPath(variant);
  if (!url) return null;
  return storedLogoFile(url.slice(FILE_URL_PREFIX.length));
}

/** Refresh the sync cache from the platform settings store. Never throws. */
async function refreshBranding() {
  try {
    const platform = require('./platform');
    const [dark, light, tag] = await Promise.all([
      platform.getPlatformSetting(LOGO_KEYS.dark, ''),
      platform.getPlatformSetting(LOGO_KEYS.light, ''),
      platform.getPlatformSetting(TAGLINE_KEY, DEFAULT_TAGLINE),
    ]);
    cache = {
      dark: validFileUrl(dark),
      light: validFileUrl(light),
      tagline: String(tag == null ? '' : tag).trim() || DEFAULT_TAGLINE,
    };
  } catch {
    /* keep the previous cache (defaults on first boot) */
  }
  lastRefreshAt = Date.now();
  return { ...cache };
}

let lastRefreshAt = 0;

/**
 * Throttled refresh for request paths: an out-of-process write (a
 * settings import, a second instance, a proof script) converges into
 * this process's cache within a few seconds instead of only at the
 * next in-process write or reboot. At most one store read per
 * interval; failures keep the previous cache.
 */
async function refreshBrandingIfStale(maxAgeMs = 5000) {
  if (Date.now() - lastRefreshAt < maxAgeMs) return { ...cache };
  return refreshBranding();
}

function brandingState() {
  return {
    logoDark: cache.dark,
    logoLight: cache.light,
    // Batch 92 honesty flags: a slot can be configured while its file
    // is missing (wiped volume, partial restore). The settings UI
    // must not claim "A custom logo is in use" over a broken preview
    // in that case — it shows the built-in default and says the file
    // is missing. Real surfaces already fall back via customLogoFile.
    logoDarkMissing: Boolean(cache.dark) && !customLogoFile('dark'),
    logoLightMissing: Boolean(cache.light) && !customLogoFile('light'),
    tagline: tagline(),
    defaults: {
      logoDarkUrl: '/brand/logo-white.png',
      logoLightUrl: '/brand/logo-black.png',
    },
  };
}

/** Magic-byte sniff for the accepted logo types (mirrors clientPortal's). */
function sniffLogoMime(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  const head = buf.toString('utf8', 0, Math.min(buf.length, 1024)).replace(/^\uFEFF/, '').trimStart();
  if (/^<\?xml[\s\S]{0,600}?<svg[\s>]/i.test(head) || /^<svg[\s>]/i.test(head)) return 'image/svg+xml';
  return null;
}

function deleteStoredFile(url) {
  const name = String(url || '').slice(FILE_URL_PREFIX.length);
  if (!FILE_NAME_RE.test(name)) return;
  try {
    fs.unlinkSync(path.join(brandDir(), name));
  } catch {
    /* already gone */
  }
}

/**
 * Validate + store an uploaded logo for a variant, point the setting
 * at it, drop the replaced file, and refresh the cache. The platform
 * setting write goes through setPlatformSetting (the choke point),
 * whose branding.* hook also refreshes this cache.
 */
async function saveLogo(variant, buf) {
  if (variant !== 'dark' && variant !== 'light') throw coded('BAD_LOGO_VARIANT', 'Unknown logo variant.');
  if (!Buffer.isBuffer(buf) || !buf.length) throw coded('BAD_LOGO', 'No logo file was provided.');
  if (buf.length > LOGO_MAX_BYTES) throw coded('LOGO_TOO_LARGE', 'Logo files are limited to 4 MB.');
  const mime = sniffLogoMime(buf);
  if (!mime) throw coded('BAD_LOGO_TYPE', 'Logo must be a PNG, JPG, SVG, or WebP image.');
  const dir = brandDir();
  fs.mkdirSync(dir, { recursive: true });
  const filename = `logo-${variant}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.${MIME_TO_EXT[mime]}`;
  fs.writeFileSync(path.join(dir, filename), buf);
  const url = FILE_URL_PREFIX + filename;
  const previous = cache[variant];
  await require('./platform').setPlatformSetting(LOGO_KEYS[variant], url);
  if (previous && previous !== url) deleteStoredFile(previous);
  await refreshBranding();
  return { url, mime, bytes: buf.length };
}

/** Reset a variant to the built-in default asset. */
async function resetLogo(variant) {
  if (variant !== 'dark' && variant !== 'light') throw coded('BAD_LOGO_VARIANT', 'Unknown logo variant.');
  const previous = cache[variant];
  await require('./platform').setPlatformSetting(LOGO_KEYS[variant], '');
  if (previous) deleteStoredFile(previous);
  await refreshBranding();
  return { url: '' };
}

module.exports = {
  DEFAULT_TAGLINE,
  LOGO_KEYS,
  TAGLINE_KEY,
  LOGO_MAX_BYTES,
  FILE_URL_PREFIX,
  tagline,
  customLogoPath,
  customLogoFile,
  storedLogoFile,
  refreshBranding,
  refreshBrandingIfStale,
  brandingState,
  sniffLogoMime,
  saveLogo,
  resetLogo,
  validFileUrl,
};
