'use strict';

/**
 * errorCopy — Batch 54 (expert-review finding U-1). The ONE place raw
 * API/client errors become copy a user may see. Before this module, 259
 * sites across the staff app + portal rendered `err.message` directly,
 * so server internals (a ReferenceError for a helper that does not
 * exist, "SMTP error: expected 250 but got…", settings keys) were, in
 * effect, UI copy.
 *
 * How the decision is made — by CODE, never by guessing at the text:
 *  - A code with an entry in COPY renders that plain-language copy.
 *  - INTERNAL / no usable code / an unexpected 5xx renders the generic
 *    line plus the server reference id when one came back ("Reference:
 *    err_ab12cd34") — the ref is what support quotes to find the exact
 *    log line the server wrote (server/apiErrors.js).
 *  - Authored codes whose message was written for users (VALIDATION
 *    family, config diagnostics ending _NOT_CONFIGURED, …) keep their
 *    message — at 4xx generally, and at 5xx only for the passthrough
 *    set, so a raw exception message can never ride a 5xx to the DOM.
 *  - An error with no HTTP status originated in client code (or is a
 *    network failure): client-authored messages are already user copy;
 *    fetch failures become a connection message.
 * The raw message still goes to console.error at the sink's call sites
 * where it always did — it just no longer reaches the DOM from the
 * shared helpers (toast, error cards/rows, page-failed renderer).
 */
(function () {
  const GENERIC = 'Something went wrong on our side.';
  const NETWORK = 'Could not reach the server — check your connection and try again.';

  const COPY = {
    INTERNAL: GENERIC,
    BAD_JSON: 'That request could not be read. Please try again.',
    FORBIDDEN: "You don't have permission for that.",
    TOKEN_ROLE_DENIED: "You don't have permission for that.",
    LEAD_SCOPE: 'That record belongs to a different business.',
    AUTH_REQUIRED: 'Please sign in again.',
    SESSION_IDLE: 'Signed out after 30 hours of inactivity. Please sign in again.',
    INVALID_CREDENTIALS: 'Email or password is incorrect.',
    RATE_LIMITED: 'Too many attempts — please wait a moment and try again.',
    INSUFFICIENT_CREDITS: 'Not enough credits for that. Add credits and try again.',
    SUBSCRIPTION_REQUIRED: 'That needs an active subscription.',
    PAST_DUE: 'Your subscription payment is overdue — update billing to continue.',
    EMAIL_FAILED: 'That email could not be sent. Please try again later.',
    CAPTCHA_REQUIRED: 'Please complete the verification check and try again.',
    CAPTCHA_FAILED: 'The verification check failed. Please try again.',
    CAPTCHA_NOT_CONFIGURED: 'Verification is not available right now. Please try again later.',
    MFA_LOCKED: 'Too many incorrect codes — verification is locked for a while. Try again later.',
    IDEMPOTENCY_CONFLICT: 'That was already submitted — refresh to see the result before retrying.',
  };

  // Authored codes whose message is the point (form validation written
  // for users, delete-block explanations, config diagnostics). At 5xx
  // only these — plus any *_NOT_CONFIGURED code — may show their text.
  const PASSTHROUGH = new Set([
    'VALIDATION',
    'INVALID',
    'INVALID_PAGES',
    'SECTION_SCRIPT',
    'DUPLICATE_EMAIL',
    'FK_CONFLICT',
    'CONFIRM_REQUIRED',
    'NOT_FOUND',
    'CF_EMAIL_SEND_FAILED',
  ]);

  const AUTHORED = /^[A-Z][A-Z0-9_]+$/;

  function withRef(base, err) {
    return err && typeof err.ref === 'string' && err.ref ? `${base} Reference: ${err.ref}` : base;
  }

  // B54-DESCRIBE-BEGIN
  function describe(err) {
    if (err == null) return GENERIC;
    if (typeof err === 'string') {
      if (COPY[err]) return COPY[err];
      return err;
    }
    let code = typeof err.code === 'string' ? err.code : '';
    let message = typeof err.message === 'string' ? err.message : '';
    // Legacy flat shape: the message IS the code (e.g. 'AUTH_REQUIRED').
    if (!code && AUTHORED.test(message)) {
      code = message;
      message = '';
    }
    if (code && COPY[code]) {
      return code === 'INTERNAL' ? withRef(COPY[code], err) : COPY[code];
    }
    const status = Number(err.status) || 0;
    if (!status) {
      // Client-originated or transport failure.
      if (err instanceof TypeError || /failed to fetch|network ?error|load failed/i.test(message)) {
        return NETWORK;
      }
      return message || GENERIC;
    }
    const authored = AUTHORED.test(code) && code !== 'INTERNAL';
    if (status >= 500) {
      if (authored && message && (PASSTHROUGH.has(code) || /_NOT_CONFIGURED$/.test(code))) {
        return message;
      }
      return withRef(GENERIC, err);
    }
    // 4xx: route-authored copy (coded or not) is written for users.
    if (message && message !== 'Server error') return message;
    return withRef(GENERIC, err);
  }
  // B54-DESCRIBE-END

  window.ScoutErrorCopy = { describe, COPY, GENERIC, NETWORK };
  window.errText = describe;
})();
