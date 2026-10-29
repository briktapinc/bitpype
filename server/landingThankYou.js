'use strict';

/**
 * Batch 70 — /landing follow-through: the thank-you email, the
 * /thankyou page settings, and the page's serve-time sections.
 *
 * Ely's ask (2026-10-29): when a visitor fills the form on /landing,
 *   1. send them a thank-you email ("you will hear back from us
 *      shortly"),
 *   2. redirect them to a new /thankyou page,
 *   3. where a demo video + a Calendly booking link (both pasted by Ely
 *      in Admin → Settings → Landing) can be shown.
 *
 * Settings (platform group `landing`):
 *   landing.thankyou_video        — ONE YouTube video. Whatever Ely
 *     pastes (embed code, watch/youtu.be link, bare ID) is parsed with
 *     the Batch 58 landingVideos parser and only the canonical video
 *     ID is stored; pasted HTML is never stored or rendered.
 *   landing.thankyou_calendly_url — Ely's Calendly link. Must be an
 *     https URL on calendly.com (or a subdomain); anything else is a
 *     coded VALIDATION rejection at save time.
 * Both default empty → the matching /thankyou section does not render
 * at all (dormant-empty, the Google Reviews / landing videos rule).
 *
 * Calendly rendering is a prominent CTA BUTTON only. Calendly's
 * official inline embed loads its widget script from
 * assets.calendly.com, which the global CSP script-src
 * (server/securityHeaders.js: 'self' + unsafe-inline + Turnstile) does
 * not allow — embedding it would mean loosening the platform-wide
 * script policy for one marketing page, so the button ships instead.
 *
 * The thank-you email rides sendPlatformMail like every other platform
 * email and is BEST-EFFORT: a mail failure (including SMTP not
 * configured) is logged and swallowed — it never fails a submission
 * that already created/folded the lead.
 */

const { extractYouTubeVideoId, isYouTubeVideoId } = require('./landingVideos');

function validationError(message) {
  const err = new Error(message);
  err.code = 'VALIDATION';
  return err;
}

/* ------------------------------------------------------------------ */
/* Settings validation (both write choke points call these)            */
/* ------------------------------------------------------------------ */

/**
 * Canonical stored form: the bare 11-char video ID, or '' when unset.
 * Accepts a YouTube embed code, a watch/youtu.be/shorts link, or a
 * bare ID — exactly one video; a list is rejected.
 */
function validateThankYouVideoSetting(raw) {
  if (raw == null) return '';
  const text = String(raw).trim();
  if (!text) return '';
  if (!/<iframe\b/i.test(text)) {
    const tokens = text.split(/[\s,;]+/).filter(Boolean);
    if (tokens.length > 1) {
      throw validationError('Thank-you page video: paste just ONE YouTube video (embed code, link, or video ID).');
    }
  }
  const id = extractYouTubeVideoId(text);
  if (!id) {
    throw validationError('Thank-you page video: that is not a YouTube embed code, link, or video ID.');
  }
  return id;
}

/** Tolerant reader for rendering: a corrupt stored value renders nothing. */
function parseStoredThankYouVideoId(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return '';
  return isYouTubeVideoId(text) ? text : extractYouTubeVideoId(text) || '';
}

/**
 * Canonical stored form: the URL as given (trimmed), or '' when unset.
 * Only https://calendly.com (or a subdomain of it) is accepted — no
 * other host, no http, no credentials, no markup.
 */
function validateThankYouCalendlyUrl(raw) {
  if (raw == null) return '';
  const text = String(raw).trim();
  if (!text) return '';
  if (text.length > 500 || /[\s<>"']/.test(text)) {
    throw validationError('Thank-you page Calendly link: paste a single Calendly URL.');
  }
  let url;
  try {
    url = new URL(text);
  } catch {
    throw validationError('Thank-you page Calendly link: that is not a valid URL.');
  }
  if (url.protocol !== 'https:') {
    throw validationError('Thank-you page Calendly link: the link must start with https://');
  }
  if (url.username || url.password) {
    throw validationError('Thank-you page Calendly link: credentials are not allowed in the link.');
  }
  const host = url.hostname.toLowerCase();
  if (host !== 'calendly.com' && !host.endsWith('.calendly.com')) {
    throw validationError('Thank-you page Calendly link: the link must be on calendly.com.');
  }
  return url.toString();
}

/** Tolerant reader for rendering: a corrupt stored value renders nothing. */
function parseStoredThankYouCalendlyUrl(raw) {
  try {
    return validateThankYouCalendlyUrl(raw);
  } catch {
    return '';
  }
}

/* ------------------------------------------------------------------ */
/* /thankyou serve-time sections (built from stored values only)       */
/* ------------------------------------------------------------------ */

function thankYouVideoSectionHtml(rawId) {
  const id = parseStoredThankYouVideoId(rawId);
  if (!id) return '';
  return `<section class="thankyou-video" id="thankyou-video">
    <h2>See BitPype <em>in action.</em></h2>
    <p class="section-lede">A short demo of the platform while you wait to hear from us.</p>
    <div class="video-frame">
      <iframe src="https://www.youtube-nocookie.com/embed/${id}" title="BitPype demo video" loading="lazy" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>
    </div>
  </section>`;
}

function thankYouBookingHtml(rawUrl) {
  const url = parseStoredThankYouCalendlyUrl(rawUrl);
  if (!url) return '';
  const href = url.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  return `<section class="thankyou-booking" id="thankyou-booking">
    <h2>Prefer to talk it through?</h2>
    <p class="section-lede">Book an appointment at a time that suits you — pick a slot and it lands straight in the calendar.</p>
    <p class="booking-cta"><a class="btn btn-primary btn-lg" href="${href}" target="_blank" rel="noopener">Book your appointment</a></p>
  </section>`;
}

function thankYouSectionsHtml({ videoId, calendlyUrl } = {}) {
  return [thankYouVideoSectionHtml(videoId), thankYouBookingHtml(calendlyUrl)]
    .filter(Boolean)
    .join('\n');
}

/* ------------------------------------------------------------------ */
/* Thank-you email                                                     */
/* ------------------------------------------------------------------ */

function firstNameOf(fullName) {
  const first = String(fullName == null ? '' : fullName).trim().split(/\s+/)[0] || '';
  // A name token with markup-ish characters is not a name worth greeting.
  return /[<>"'@/\\]/.test(first) ? '' : first.slice(0, 60);
}

function buildLandingThankYouEmail({ fullName, email } = {}) {
  const first = firstNameOf(fullName);
  const greeting = first ? `Hi ${first},` : 'Hi there,';
  const paragraphs = [
    greeting,
    'Thanks for your interest in BitPype — we received your details through our landing page and we appreciate you getting in touch.',
    'You will hear back from us shortly. A member of the BitPype team will be in touch to talk through what you have in mind.',
    'Thanks again,\nThe BitPype team',
  ];
  return {
    to: String(email || '').trim(),
    subject: 'Thanks for your interest in BitPype',
    title: 'Thanks for getting in touch',
    paragraphs,
    text: paragraphs.join('\n\n'),
  };
}

/**
 * Best-effort send. deps.sendMail is injectable for tests (the Batch
 * 61/63 pattern); production rides server/mailer.sendPlatformMail.
 * NEVER throws — returns { sent, reason? } and logs failures.
 */
async function sendLandingThankYou(input, deps = {}) {
  const mail = buildLandingThankYouEmail(input || {});
  if (!mail.to) return { sent: false, reason: 'no_recipient' };
  const sendMail =
    deps.sendMail || (async (m) => require('./mailer').sendPlatformMail(m));
  try {
    await sendMail(mail);
    return { sent: true };
  } catch (e) {
    console.warn(
      `[landing] thank-you email to ${mail.to} failed (submission unaffected):`,
      (e && e.code) || '',
      (e && e.message) || e
    );
    return { sent: false, reason: (e && e.code) || 'send_failed' };
  }
}

module.exports = {
  validateThankYouVideoSetting,
  parseStoredThankYouVideoId,
  validateThankYouCalendlyUrl,
  parseStoredThankYouCalendlyUrl,
  thankYouVideoSectionHtml,
  thankYouBookingHtml,
  thankYouSectionsHtml,
  firstNameOf,
  buildLandingThankYouEmail,
  sendLandingThankYou,
};
