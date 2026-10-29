'use strict';

/**
 * Batch 58 — landing page YouTube videos (platform setting
 * `landing.video_embeds`).
 *
 * Ely pastes a full YouTube EMBED CODE (or a watch / youtu.be link, or a
 * bare video ID) into Admin → Settings → Landing. This module is the
 * ONLY parser: it extracts the video ID from each reference and the
 * setting stores canonical IDs as a JSON array string ('["dQw4w9WgXcQ"]').
 * The pasted HTML is NEVER stored and NEVER rendered — the landing page
 * builds its own youtube-nocookie iframes from the stored IDs, so a
 * pasted <script>, a Vimeo iframe, or any other markup is rejected at
 * save time with a coded VALIDATION error instead of becoming stored XSS.
 *
 * Accepted reference shapes (single or several, newline/comma separated
 * when not HTML):
 *   <iframe … src="https://www.youtube.com/embed/ID" …></iframe>
 *   https://www.youtube.com/watch?v=ID (extra params fine)
 *   https://www.youtube.com/embed/ID · /shorts/ID · /live/ID
 *   https://youtu.be/ID
 *   https://www.youtube-nocookie.com/embed/ID
 *   ID (bare, 11 chars)
 */

const ID_RE = /^[A-Za-z0-9_-]{11}$/;
const MAX_VIDEOS = 12;

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
]);
const SHORT_HOSTS = new Set(['youtu.be', 'www.youtu.be']);

function validationError(message) {
  const err = new Error(message);
  err.code = 'VALIDATION';
  return err;
}

function isYouTubeVideoId(v) {
  return typeof v === 'string' && ID_RE.test(v);
}

/** Extract the video ID from ONE YouTube reference; null when not YouTube. */
function extractYouTubeVideoId(input) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) return null;
  if (ID_RE.test(raw)) return raw;

  let text = raw;
  if (/<iframe\b/i.test(text)) {
    const m = text.match(/<iframe\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i);
    if (!m) return null;
    text = m[1].trim();
  }
  if (!/^https?:\/\//i.test(text)) {
    if (/^[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(text)) text = `https://${text}`;
    else return null;
  }
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (SHORT_HOSTS.has(host)) {
    const seg = url.pathname.split('/').filter(Boolean)[0] || '';
    return ID_RE.test(seg) ? seg : null;
  }
  if (!YOUTUBE_HOSTS.has(host)) return null;
  const v = url.searchParams.get('v');
  if (v && ID_RE.test(v)) return v;
  const m = url.pathname.match(/^\/(?:embed|shorts|live|v)\/([A-Za-z0-9_-]{11})(?:[/?#]|$)/);
  if (m) return m[1];
  return null;
}

/**
 * Parse the admin-facing value into canonical IDs. Throws a coded
 * VALIDATION error on anything that is not purely YouTube references.
 */
function parseLandingVideoEmbeds(raw) {
  if (raw == null) return [];
  if (Array.isArray(raw)) {
    const ids = [];
    for (const item of raw) ids.push(...parseLandingVideoEmbeds(item));
    return dedupe(ids);
  }
  const text = String(raw).trim();
  if (!text) return [];
  if (text.startsWith('[')) {
    // Canonical stored form (or a pasted JSON list): every element must
    // be a single valid reference.
    let arr;
    try {
      arr = JSON.parse(text);
    } catch {
      throw validationError('Landing videos: the saved list could not be read — paste YouTube embed codes or links instead.');
    }
    if (!Array.isArray(arr)) {
      throw validationError('Landing videos must be a list of YouTube embed codes or links.');
    }
    const ids = [];
    for (const item of arr) {
      const id = extractYouTubeVideoId(typeof item === 'string' ? item : '');
      if (!id) {
        throw validationError('Landing videos: every entry must be a YouTube embed code, link, or video ID.');
      }
      ids.push(id);
    }
    return dedupe(ids);
  }
  if (/<[a-z!]/i.test(text)) {
    // HTML paste: ONLY <iframe> embed codes, each with a YouTube src.
    // Plain references (links/IDs) may sit on other lines around the
    // embed codes — they are parsed too; any OTHER markup is rejected.
    if (/<script\b/i.test(text)) {
      throw validationError('Landing videos: scripts are not allowed — paste a YouTube embed code or link.');
    }
    const tags = text.match(/<iframe\b[^>]*>/gi) || [];
    if (!tags.length) {
      throw validationError('Landing videos: no YouTube embed code found — paste a YouTube embed code or link.');
    }
    const ids = [];
    for (const tag of tags) {
      const id = extractYouTubeVideoId(tag);
      if (!id) {
        throw validationError('Landing videos: every embed must be a YouTube embed — other video hosts are not accepted.');
      }
      ids.push(id);
    }
    const rest = text.replace(/<\/?iframe\b[^>]*>/gi, ' ');
    if (/<[a-z!]/i.test(rest)) {
      throw validationError('Landing videos: only YouTube embed codes and links are accepted — other page code is not stored.');
    }
    for (const token of rest.split(/[\s,;]+/).filter(Boolean)) {
      const id = extractYouTubeVideoId(token);
      if (!id) {
        throw validationError(`Landing videos: "${token.slice(0, 80)}" is not a YouTube embed code, link, or video ID.`);
      }
      ids.push(id);
    }
    return dedupe(ids);
  }
  // Plain list: one reference per line / comma / semicolon.
  const tokens = text.split(/[\s,;]+/).filter(Boolean);
  const ids = [];
  for (const token of tokens) {
    const id = extractYouTubeVideoId(token);
    if (!id) {
      throw validationError(`Landing videos: "${token.slice(0, 80)}" is not a YouTube embed code, link, or video ID.`);
    }
    ids.push(id);
  }
  return dedupe(ids);
}

function dedupe(ids) {
  const out = [...new Set(ids)];
  if (out.length > MAX_VIDEOS) {
    throw validationError(`Landing videos: keep it to ${MAX_VIDEOS} videos or fewer.`);
  }
  return out;
}

/**
 * settingsKeys.validateSetting / platform.setPlatformSetting choke-point
 * rule: returns the canonical stored string (JSON array of IDs) or
 * throws a coded VALIDATION error.
 */
function validateLandingVideoEmbedsSetting(raw) {
  return JSON.stringify(parseLandingVideoEmbeds(raw));
}

/** Tolerant reader for rendering: a corrupt stored value renders no videos. */
function parseStoredLandingVideoEmbeds(raw) {
  try {
    return parseLandingVideoEmbeds(raw).filter(isYouTubeVideoId);
  } catch {
    return [];
  }
}

/**
 * The videos section for /landing. Empty list → empty string (the
 * section does not render at all — dormant-empty, the same rule as the
 * Google Reviews module). Iframes are constructed here from validated
 * IDs only; nothing from the stored setting reaches the page raw.
 */
function landingVideosSectionHtml(ids) {
  const list = (Array.isArray(ids) ? ids : []).filter(isYouTubeVideoId);
  if (!list.length) return '';
  const frames = list
    .map(
      (id) => `      <div class="video-frame">
        <iframe src="https://www.youtube-nocookie.com/embed/${id}" title="BitPype walkthrough video" loading="lazy" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>
      </div>`
    )
    .join('\n');
  return `<section class="videos" id="videos">
    <h2>Watch it <em>in action.</em></h2>
    <p class="section-lede">Walkthroughs of the platform, recorded by the team behind it.</p>
    <div class="video-grid">
${frames}
    </div>
  </section>`;
}

module.exports = {
  MAX_VIDEOS,
  isYouTubeVideoId,
  extractYouTubeVideoId,
  parseLandingVideoEmbeds,
  validateLandingVideoEmbedsSetting,
  parseStoredLandingVideoEmbeds,
  landingVideosSectionHtml,
};
