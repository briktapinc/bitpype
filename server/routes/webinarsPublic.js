'use strict';

/**
 * Batch 163 — public webinar gate + room.
 *
 * GET  /webinar/:slug            gate page, or the room when the
 *                                signed gate cookie is present
 * POST /webinar/:slug/enter      gate form (name/email/phone/code)
 * GET  /webinar/:slug/chat/stream  SSE stream for the room (cookie)
 * GET  /webinar/:slug/chat/messages  poll fallback (cookie)
 * POST /webinar/:slug/chat       post a chat message (cookie)
 *
 * The shareable link carries NO code — the code is typed at the gate.
 * A wrong code returns one generic error; attempts are rate-limited
 * per IP + webinar (lockout family consistent with the platform's
 * login limits). Every rendered value is escaped; chat messages are
 * rendered client-side via textContent, never innerHTML.
 */

const express = require('express');
const webinars = require('../webinars');
const { rateLimit } = require('../rateLimit');
const apiErrors = require('../apiErrors');

const router = express.Router();

const gateLimit = rateLimit({
  name: 'webinar-gate',
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyFn: (req) => `${req.params.slug || ''}:${req.ip || ''}`,
});
const chatLimit = rateLimit({
  name: 'webinar-chat',
  windowMs: 60 * 1000,
  max: 30,
  keyFn: (req) => `${req.params.slug || ''}:${req.ip || ''}`,
});

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function cookieSecure() {
  return String(process.env.APP_URL || '').startsWith('https://');
}

async function sessionFor(req, webinar) {
  const raw = req.cookies ? req.cookies[webinars.cookieName(webinar.id)] : null;
  const verified = webinars.verifyGateCookie(webinar.id, raw);
  if (!verified) return null;
  const rows = await require('../db').query('SELECT * FROM webinar_registrations WHERE id = :id AND webinar_id = :w', {
    id: verified.registrationId,
    w: webinar.id,
  });
  if (!rows.length) return null;
  const r = rows[0];
  return {
    id: Number(r.id),
    webinarId: Number(r.webinar_id),
    name: r.name || '',
    email: r.email || '',
    phone: r.phone || '',
  };
}

const PAGE_CSS = `
  :root { --bg:#f7f1e8; --surface:#fffaf4; --ink:#1c140f; --muted:#5c5148; --border:#e7dbc4;
    --accent:#0e7a68; --accent-dark:#0a5c4f; --coral:#ef5d45; --gold:#f0b429; --radius:20px;
    --shadow:0 1px 2px rgba(80,40,20,.05),0 8px 18px rgba(80,40,20,.06); }
  * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink);
    font-family:Figtree,system-ui,-apple-system,'Segoe UI',sans-serif; }
  .wrap { max-width:1060px; margin:0 auto; padding:28px 28px 48px; }
  @media (max-width:700px){ .wrap{ padding:20px 22px 36px; } }
  .brand { font-weight:800; letter-spacing:.14em; font-size:13px; color:var(--accent-dark); text-transform:uppercase; }
  h1 { font-family:Fraunces,Georgia,serif; font-weight:700; font-size:clamp(28px,4.5vw,44px); line-height:1.08; margin:10px 0 8px; }
  .lede { color:var(--muted); font-size:17px; line-height:1.55; max-width:640px; white-space:pre-wrap; }
  .when { display:inline-block; margin-top:10px; background:#e5f6f2; color:var(--accent-dark);
    padding:6px 12px; border-radius:999px; font-weight:700; font-size:14px; }
  .card { background:var(--surface); border:1px solid var(--border); border-radius:var(--radius);
    box-shadow:var(--shadow); padding:24px; }
  label { display:block; font-weight:700; font-size:14px; margin:14px 0 6px; }
  input { width:100%; padding:12px 14px; border:1px solid var(--border); border-radius:12px;
    font:inherit; background:#fff; color:var(--ink); }
  button.cta { margin-top:20px; width:100%; padding:14px; border:0; border-radius:12px; cursor:pointer;
    background:var(--accent); color:#fff; font:inherit; font-weight:800; font-size:16px; }
  button.cta:hover { background:var(--accent-dark); }
  .error { background:#fdeceb; border:1px solid #f3c1bb; color:#8c2b1f; border-radius:12px;
    padding:12px 14px; margin-top:16px; font-weight:600; }
  .grid { display:grid; grid-template-columns:1.6fr 1fr; gap:20px; align-items:start; }
  @media (max-width:860px){ .grid{ grid-template-columns:1fr; } }
  .video-frame { position:relative; padding-top:56.25%; border-radius:16px; overflow:hidden; background:#000; }
  .video-frame iframe { position:absolute; inset:0; width:100%; height:100%; border:0; }
  .chat-log { height:380px; overflow-y:auto; display:flex; flex-direction:column; gap:10px; padding:4px 2px; }
  .msg { background:#fff; border:1px solid var(--border); border-radius:12px; padding:8px 12px; }
  .msg .who { font-weight:800; font-size:13px; }
  .msg .who .host { background:var(--gold); color:#4a3200; border-radius:6px; padding:1px 6px; font-size:11px; margin-left:6px; }
  .msg .body { font-size:15px; line-height:1.45; overflow-wrap:anywhere; }
  .chat-form { display:flex; gap:8px; margin-top:12px; }
  .chat-form input { flex:1; }
  .chat-form button { padding:12px 18px; border:0; border-radius:12px; background:var(--accent);
    color:#fff; font:inherit; font-weight:800; cursor:pointer; }
  .notice { background:#fdf3d8; border:1px solid #ecd28a; border-radius:12px; padding:12px 14px; font-weight:600; }
`;

function pageShell(title, inner) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)} — BitPype Webinar</title>
<link rel="icon" href="/brand/favicon.png" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,700&family=Figtree:wght@400;600;700;800&display=swap" rel="stylesheet" />
<style>${PAGE_CSS}</style>
</head>
<body>
<div class="wrap">
  <div class="brand">BitPype Webinar</div>
  ${inner}
</div>
</body>
</html>`;
}

function gateHtml(webinar, error) {
  const when = webinar.scheduledLabel ? `<span class="when">${esc(webinar.scheduledLabel)}</span>` : '';
  const err = error ? `<div class="error">${esc(error)}</div>` : '';
  return pageShell(
    webinar.title,
    `
  <h1>${esc(webinar.title)}</h1>
  ${webinar.description ? `<p class="lede">${esc(webinar.description)}</p>` : ''}
  ${when}
  <div class="card" style="margin-top:22px;max-width:520px">
    <strong>Enter your details and the webinar code to join.</strong>
    ${err}
    <form method="post" action="/webinar/${esc(webinar.slug)}/enter">
      <label for="f-name">Full name</label>
      <input id="f-name" name="name" autocomplete="name" required maxlength="200" />
      <label for="f-email">Email</label>
      <input id="f-email" name="email" type="email" autocomplete="email" required maxlength="254" />
      <label for="f-phone">Phone number</label>
      <input id="f-phone" name="phone" type="tel" autocomplete="tel" required maxlength="32" />
      <label for="f-code">Webinar code</label>
      <input id="f-code" name="code" autocomplete="off" required maxlength="16" style="text-transform:uppercase" />
      <button class="cta" type="submit">Join the webinar</button>
    </form>
  </div>`
  );
}

function roomHtml(webinar, registration) {
  const open = webinars.chatEffectivelyOpen(webinar);
  const embed = webinar.youtubeId
    ? `<div class="video-frame"><iframe src="https://www.youtube-nocookie.com/embed/${esc(webinar.youtubeId)}" title="${esc(webinar.title)}" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe></div>`
    : `<div class="notice">The video will appear here when the host adds it.</div>`;
  const statusNotice =
    webinar.status === 'live'
      ? ''
      : webinar.status === 'ended'
        ? `<div class="notice" style="margin-top:14px">This webinar has ended — the recording stays up above, and the chat is now closed.</div>`
        : `<div class="notice" style="margin-top:14px">This webinar hasn't started yet${webinar.scheduledLabel ? ` — it begins ${esc(webinar.scheduledLabel)}` : ''}. The chat opens when the webinar goes live.</div>`;
  const chatPanel = `
  <div class="card">
    <strong>Live chat</strong>
    <div class="chat-log" id="chat-log" aria-live="polite"></div>
    ${
      open
        ? `<form class="chat-form" id="chat-form">
             <input id="chat-input" maxlength="2000" placeholder="Message the host…" autocomplete="off" />
             <button type="submit">Send</button>
           </form>`
        : `<p style="color:var(--muted);font-weight:600;margin:12px 0 0">Chat is ${webinar.status === 'ended' ? 'closed' : 'not open yet'}.</p>`
    }
  </div>`;
  const script = `
<script>
(function () {
  var slug = ${JSON.stringify(webinar.slug)};
  var log = document.getElementById('chat-log');
  var seen = {};
  function render(m) {
    if (!m || seen[m.id]) return;
    seen[m.id] = true;
    var box = document.createElement('div');
    box.className = 'msg';
    var who = document.createElement('div');
    who.className = 'who';
    who.textContent = m.authorName || 'Guest';
    if (m.isHost) {
      var badge = document.createElement('span');
      badge.className = 'host';
      badge.textContent = 'HOST';
      who.appendChild(badge);
    }
    var body = document.createElement('div');
    body.className = 'body';
    body.textContent = m.body || '';
    box.appendChild(who);
    box.appendChild(body);
    log.appendChild(box);
    log.scrollTop = log.scrollHeight;
  }
  function renderRedacted(m) {
    // A message the host hid: drop it from the visitor view entirely.
    seen[m.id] = true;
    // Simplest correct behaviour: rebuild from the server list.
    fetch('/webinar/' + encodeURIComponent(slug) + '/chat/messages', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        log.textContent = '';
        seen = {};
        (data.messages || []).forEach(render);
      })
      .catch(function () {});
  }
  fetch('/webinar/' + encodeURIComponent(slug) + '/chat/messages', { credentials: 'same-origin' })
    .then(function (r) { return r.json(); })
    .then(function (data) { (data.messages || []).forEach(render); })
    .catch(function () {});
  if (window.EventSource) {
    var es = new EventSource('/webinar/' + encodeURIComponent(slug) + '/chat/stream');
    es.addEventListener('message', function (ev) {
      try {
        var m = JSON.parse(ev.data);
        if (m.redacted) renderRedacted(m); else render(m);
      } catch (e) {}
    });
  }
  var form = document.getElementById('chat-form');
  if (form) {
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var input = document.getElementById('chat-input');
      var body = input.value.trim();
      if (!body) return;
      input.value = '';
      fetch('/webinar/' + encodeURIComponent(slug) + '/chat', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: body }),
      }).then(function (r) { return r.json(); }).then(function (data) {
        if (data && data.message) render(data.message);
      }).catch(function () {});
    });
  }
})();
</script>`;
  return pageShell(
    webinar.title,
    `
  <h1>${esc(webinar.title)}</h1>
  ${webinar.scheduledLabel ? `<span class="when">${esc(webinar.scheduledLabel)}</span>` : ''}
  ${statusNotice}
  <div class="grid" style="margin-top:20px">
    <div>${embed}</div>
    <div>${chatPanel}</div>
  </div>
  ${script}`
  );
}

function notFoundPage(res) {
  res
    .status(404)
    .send(
      pageShell(
        'Webinar not found',
        `<h1>Webinar not found</h1><p class="lede">That webinar link doesn't match a webinar. Check the link and try again.</p>`
      )
    );
}

router.get('/webinar/:slug', async (req, res) => {
  try {
    const webinar = await webinars.getWebinarBySlug(req.params.slug);
    if (!webinar) return notFoundPage(res);
    const session = await sessionFor(req, webinar);
    if (!session) return res.send(gateHtml(webinar, null));
    await webinars.markJoined(session.id);
    return res.send(roomHtml(webinar, session));
  } catch (e) {
    return apiErrors.sendError(res, e, 500, { area: 'webinars-public', mask5xx: true });
  }
});

router.post('/webinar/:slug/enter', gateLimit, async (req, res) => {
  try {
    const webinar = await webinars.getWebinarBySlug(req.params.slug);
    if (!webinar) return notFoundPage(res);
    const body = req.body || {};
    const registration = await webinars.registerWithCode(webinar, {
      name: body.name,
      email: body.email,
      phone: body.phone,
      code: body.code,
    });
    res.cookie(webinars.cookieName(webinar.id), webinars.signGateCookie(webinar.id, registration.id), {
      httpOnly: true,
      sameSite: 'lax',
      secure: cookieSecure(),
      path: '/webinar/',
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });
    return res.redirect(303, `/webinar/${encodeURIComponent(webinar.slug)}`);
  } catch (e) {
    if (e.code === 'VALIDATION' || e.code === 'INVALID_CODE') {
      const webinar = await webinars.getWebinarBySlug(req.params.slug).catch(() => null);
      if (!webinar) return notFoundPage(res);
      return res.status(400).send(gateHtml(webinar, e.message));
    }
    return apiErrors.sendError(res, e, 500, { area: 'webinars-public', mask5xx: true });
  }
});

async function requireRoomSession(req, res) {
  const webinar = await webinars.getWebinarBySlug(req.params.slug);
  if (!webinar) {
    res.status(404).json({ ok: false, error: 'Webinar not found' });
    return null;
  }
  const session = await sessionFor(req, webinar);
  if (!session) {
    res.status(401).json({ ok: false, error: 'Join through the gate first' });
    return null;
  }
  return { webinar, session };
}

router.get('/webinar/:slug/chat/messages', async (req, res) => {
  try {
    const ctx = await requireRoomSession(req, res);
    if (!ctx) return;
    const messages = await webinars.listMessages(ctx.webinar.id, {
      afterId: Number(req.query.after || 0),
      includeHidden: false,
    });
    return res.json({
      ok: true,
      messages,
      chatOpen: webinars.chatEffectivelyOpen(ctx.webinar),
      status: ctx.webinar.status,
    });
  } catch (e) {
    return apiErrors.sendError(res, e, 500, { area: 'webinars-public', mask5xx: true });
  }
});

router.get('/webinar/:slug/chat/stream', async (req, res) => {
  try {
    const ctx = await requireRoomSession(req, res);
    if (!ctx) return;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const backlog = await webinars.listMessages(ctx.webinar.id, { includeHidden: false });
    for (const m of backlog) {
      res.write(`event: message\ndata: ${JSON.stringify(m)}\n\n`);
    }
    webinars.hubSubscribe(ctx.webinar.id, res);
    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        /* closed */
      }
    }, 25000);
    req.on('close', () => clearInterval(heartbeat));
  } catch (e) {
    return apiErrors.sendError(res, e, 500, { area: 'webinars-public', mask5xx: true });
  }
});

router.post('/webinar/:slug/chat', chatLimit, async (req, res) => {
  try {
    const ctx = await requireRoomSession(req, res);
    if (!ctx) return;
    if (!webinars.chatEffectivelyOpen(ctx.webinar)) {
      return res.status(403).json({ ok: false, error: 'Chat is not open right now' });
    }
    const message = await webinars.postMessage(ctx.webinar, {
      registration: ctx.session,
      body: (req.body || {}).body,
    });
    return res.json({ ok: true, message });
  } catch (e) {
    if (e.code === 'VALIDATION') return res.status(400).json({ ok: false, error: e.message });
    return apiErrors.sendError(res, e, 500, { area: 'webinars-public', mask5xx: true });
  }
});

module.exports = router;
