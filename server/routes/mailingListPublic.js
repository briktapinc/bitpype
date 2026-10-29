'use strict';

/**
 * Batch 71 — public (no session) unsubscribe link for the Admin
 * mailing list. The token is HMAC-signed in server/mailingList.js
 * (same family as the outreach interest links); a GET flips that one
 * subscriber to unsubscribed and shows a plain confirmation page.
 * Nothing else about the list is exposed here — no reads, no counts.
 */

const express = require('express');
const mailingList = require('../mailingList');
const { rateLimit } = require('../rateLimit');

const router = express.Router();
const clickLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 120 });

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function page({ title, heading, body, tone }) {
  const accent = tone === 'ok' ? '#0b5442' : tone === 'warn' ? '#6b5a3e' : '#333';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex,nofollow" />
  <title>${esc(title)}</title>
  <style>
    :root { color-scheme: light; }
    body {
      margin: 0; min-height: 100vh; display: grid; place-items: center;
      font-family: Georgia, "Times New Roman", serif;
      background: linear-gradient(165deg, #f3f7f5 0%, #e4ece8 45%, #d7e3dc 100%);
      color: #1a2420;
    }
    main {
      width: min(32rem, calc(100% - 2rem));
      padding: 2rem 1.75rem;
      background: rgba(255,255,255,0.88);
      border: 1px solid rgba(11,84,66,0.12);
      box-shadow: 0 12px 40px rgba(20,40,30,0.08);
    }
    .brand { font-size: 0.8rem; letter-spacing: 0.12em; text-transform: uppercase; color: #0b5442; margin: 0 0 1rem; }
    h1 { font-size: 1.55rem; line-height: 1.25; margin: 0 0 0.75rem; color: ${accent}; font-weight: 600; }
    p { margin: 0; line-height: 1.55; font-size: 1.05rem; color: #33443d; }
  </style>
</head>
<body>
  <main>
    <p class="brand">Bitpype</p>
    <h1>${esc(heading)}</h1>
    <p>${body}</p>
  </main>
</body>
</html>`;
}

router.get('/unsubscribe/:token', clickLimit, async (req, res) => {
  const result = await mailingList.applyUnsubscribe(req.params.token);
  if (!result.ok) {
    return res
      .status(result.code === 'NOT_FOUND' ? 404 : 400)
      .type('html')
      .send(
        page({
          title: 'Unsubscribe link not valid',
          heading: 'That unsubscribe link is not valid',
          body: 'The link may be incomplete or expired. If you keep receiving the newsletter, reply to any issue and we will remove you manually.',
          tone: 'warn',
        })
      );
  }
  return res
    .status(200)
    .type('html')
    .send(
      page({
        title: 'Unsubscribed',
        heading: result.already ? 'You are already unsubscribed' : 'You have been unsubscribed',
        body: `${esc(result.email)} will not receive the BitPype newsletter any more.`,
        tone: 'ok',
      })
    );
});

module.exports = router;
