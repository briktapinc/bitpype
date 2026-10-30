'use strict';

/**
 * Batch 77 — SMS policy: the public page (/sms-policy) and the consent
 * line that rides on every public visitor-facing form collecting a
 * phone number (Ely, 2026-10-30: "Add sms policy link and page wherever
 * text field options are available for people to provide, I'll use this
 * link on twilio" — the page URL is what gets pasted into the Twilio
 * A2P campaign registration).
 *
 * Single source, mirroring server/smsOptIn.js (Batch 25): the payloads
 * that already carry the `sms_optin` consent-checkbox block (contact
 * forms, bookings, instant estimate, chatbot lead capture) also carry
 * this module's `sms_policy` block, and the embed renderers place the
 * line right under that checkbox. The line is DISCLOSURE ONLY — it is
 * not a checkbox, it is never required, and it changes nothing about
 * how any form submits.
 *
 * The link is ABSOLUTE and built from the one public-URL resolver
 * (stripeClient.appUrl — Batch 56), because client sites live on their
 * own domains while the policy page lives on the platform. No domain
 * is hardcoded here or anywhere this module's output lands.
 */

const POLICY_PATH = '/sms-policy';

function policyUrl() {
  try {
    const base = String(require('./stripeClient').appUrl() || '').replace(/\/+$/, '');
    return base ? base + POLICY_PATH : POLICY_PATH;
  } catch {
    return POLICY_PATH;
  }
}

/**
 * The consent line as HTML — the exact microcopy Ely approved, with
 * "SMS Policy" as the link text. `&` is written &amp; so the string is
 * safe to drop into HTML as-is; consentText() is the plain-text twin
 * (tests pin the two against each other).
 */
function consentHtml() {
  return (
    'By providing your phone number, you agree to receive text messages about your inquiry or appointment ' +
    'from this business, sent via BitPype. Msg &amp; data rates may apply. Reply STOP to end. See our ' +
    `<a href="${policyUrl()}" target="_blank" rel="noopener">SMS Policy</a>.`
  );
}

function consentText() {
  return (
    'By providing your phone number, you agree to receive text messages about your inquiry or appointment ' +
    'from this business, sent via BitPype. Msg & data rates may apply. Reply STOP to end. See our SMS Policy.'
  );
}

/** The sms_policy block public payloads carry next to sms_optin. */
function policyBlock() {
  return { url: policyUrl(), html: consentHtml() };
}

module.exports = { POLICY_PATH, policyUrl, consentHtml, consentText, policyBlock };
