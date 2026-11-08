/**
 * Batch 165 — Webinar module client (card + gate/room).
 *
 * Loaded two ways:
 *  - module-embed.js lazy-loads it for the on-page Webinar block and
 *    calls renderCard(mount, { api, token }).
 *  - Exported webinar shells (webinar/<slug>.html) carry a
 *    [data-bitpype-webinar-root] element with api/token/slug in data
 *    attributes; this script auto-boots the gate/room there.
 *
 * All data comes from the webinar public API
 * (/api/v1/modules/public/webinar/<token>/...). The gate session is
 * the engine's signed payload, kept in localStorage and sent as the
 * X-Bitpype-Webinar-Session header (EventSource uses ?t=). Every
 * owner/visitor string is rendered via textContent — never innerHTML.
 */
(function () {
  'use strict';

  var STYLE_ID = 'bp-webinar-style';
  var CSS = [
    '.bp-webinar-card{border:1px solid rgba(0,0,0,.12);border-radius:16px;padding:22px;background:rgba(255,255,255,.65)}',
    '.bp-webinar-card h3{margin:0 0 6px;font-size:22px;line-height:1.2}',
    '.bp-webinar-when{display:inline-block;margin:4px 0 10px;padding:5px 11px;border-radius:999px;background:rgba(0,0,0,.07);font-weight:700;font-size:13px}',
    '.bp-webinar-live{display:inline-block;margin:4px 0 10px;padding:5px 11px;border-radius:999px;background:#c2261b;color:#fff;font-weight:800;font-size:13px;letter-spacing:.04em}',
    '.bp-webinar-desc{margin:0 0 14px;line-height:1.55;white-space:pre-wrap}',
    '.bp-webinar-cta{display:inline-block;padding:12px 20px;border-radius:12px;background:#111;color:#fff;font-weight:800;text-decoration:none}',
    '.bp-webinar-room .bp-webinar-grid{display:grid;grid-template-columns:1.6fr 1fr;gap:20px;align-items:start;margin-top:18px}',
    '@media (max-width:860px){.bp-webinar-room .bp-webinar-grid{grid-template-columns:1fr}}',
    '.bp-webinar-video{position:relative;padding-top:56.25%;border-radius:16px;overflow:hidden;background:#000}',
    '.bp-webinar-video iframe{position:absolute;inset:0;width:100%;height:100%;border:0}',
    '.bp-webinar-panel{border:1px solid rgba(0,0,0,.12);border-radius:16px;padding:20px;background:rgba(255,255,255,.65)}',
    '.bp-webinar-log{height:360px;overflow-y:auto;display:flex;flex-direction:column;gap:10px;padding:4px 2px}',
    '.bp-webinar-msg{border:1px solid rgba(0,0,0,.1);border-radius:12px;padding:8px 12px;background:rgba(255,255,255,.8)}',
    '.bp-webinar-msg .who{font-weight:800;font-size:13px}',
    '.bp-webinar-msg .who .host{background:#f0b429;color:#4a3200;border-radius:6px;padding:1px 6px;font-size:11px;margin-left:6px}',
    '.bp-webinar-msg .body{font-size:15px;line-height:1.45;overflow-wrap:anywhere}',
    '.bp-webinar-form label{display:block;font-weight:700;font-size:14px;margin:14px 0 6px}',
    '.bp-webinar-form input{width:100%;padding:12px 14px;border:1px solid rgba(0,0,0,.2);border-radius:12px;font:inherit;background:#fff;color:#111;box-sizing:border-box}',
    '.bp-webinar-send{display:flex;gap:8px;margin-top:12px}',
    '.bp-webinar-send input{flex:1}',
    '.bp-webinar-btn{margin-top:18px;width:100%;padding:14px;border:0;border-radius:12px;cursor:pointer;background:#111;color:#fff;font:inherit;font-weight:800;font-size:16px}',
    '.bp-webinar-send button{margin:0;width:auto;padding:12px 18px;font-size:15px}',
    '.bp-webinar-error{background:#fdeceb;border:1px solid #f3c1bb;color:#8c2b1f;border-radius:12px;padding:12px 14px;margin-top:16px;font-weight:600}',
    '.bp-webinar-notice{background:#fdf3d8;border:1px solid #ecd28a;border-radius:12px;padding:12px 14px;font-weight:600;margin-top:14px}',
    '.bp-webinar-muted{opacity:.75;font-weight:600}',
  ].join('\n');

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function apiUrl(api, token, slug, tail) {
    return (
      (api || '') +
      '/api/v1/modules/public/webinar/' +
      encodeURIComponent(token) +
      (slug ? '/' + encodeURIComponent(slug) : '') +
      (tail || '')
    );
  }

  function sessionKey(token, slug) {
    return 'bp-webinar-session-' + token + '-' + slug;
  }
  function getSession(token, slug) {
    try {
      return window.localStorage.getItem(sessionKey(token, slug)) || '';
    } catch (e) {
      return '';
    }
  }
  function setSession(token, slug, value) {
    try {
      if (value) window.localStorage.setItem(sessionKey(token, slug), value);
      else window.localStorage.removeItem(sessionKey(token, slug));
    } catch (e) {
      /* private mode — the room still works for this page view */
    }
  }

  function fetchJson(url, opts) {
    return fetch(url, opts || {}).then(function (r) {
      return r.json().catch(function () {
        return { ok: false, error: 'Unexpected response' };
      });
    });
  }

  /* ---------------- Card (on-page module block) ---------------- */

  function pickCurrent(list) {
    var live = list.filter(function (w) {
      return w.status === 'live';
    });
    if (live.length) return live[0];
    var now = Date.now();
    var upcoming = list
      .filter(function (w) {
        return w.status === 'scheduled' && (!w.scheduled_at || new Date(w.scheduled_at).getTime() >= now - 3600 * 1000);
      })
      .sort(function (a, b) {
        return String(a.scheduled_at || '9999').localeCompare(String(b.scheduled_at || '9999'));
      });
    return upcoming[0] || null;
  }

  function renderCard(mount, opts) {
    ensureStyle();
    var api = opts.api || '';
    var token = opts.token || '';
    if (!token) {
      mount.textContent = '';
      return;
    }
    fetchJson(apiUrl(api, token, null, '/list'))
      .then(function (data) {
        if (!data || !data.ok) {
          mount.textContent = '';
          return;
        }
        var w = pickCurrent(data.webinars || []);
        if (!w) {
          // Dormant-empty: no live or upcoming webinar.
          mount.textContent = '';
          return;
        }
        var card = el('div', 'bp-webinar-card');
        card.appendChild(el('h3', null, w.title || 'Webinar'));
        if (w.status === 'live') card.appendChild(el('span', 'bp-webinar-live', '● LIVE NOW'));
        else if (w.scheduled_label) card.appendChild(el('span', 'bp-webinar-when', w.scheduled_label));
        if (w.description) card.appendChild(el('p', 'bp-webinar-desc', w.description));
        var cta = el('a', 'bp-webinar-cta', w.status === 'live' ? 'Join the webinar' : 'Register / Join');
        cta.href = 'webinar/' + encodeURIComponent(w.slug) + '.html';
        card.appendChild(cta);
        mount.appendChild(card);
      })
      .catch(function () {
        mount.textContent = '';
      });
  }

  /* ---------------- Gate + room (exported shells) ---------------- */

  function renderMessage(log, seen, m) {
    if (!m || seen[m.id]) return;
    seen[m.id] = true;
    var box = el('div', 'bp-webinar-msg');
    var who = el('div', 'who', m.authorName || 'Guest');
    if (m.isHost) who.appendChild(el('span', 'host', 'HOST'));
    box.appendChild(who);
    box.appendChild(el('div', 'body', m.body || ''));
    log.appendChild(box);
    log.scrollTop = log.scrollHeight;
  }

  function bootRoom(root) {
    ensureStyle();
    var api = root.getAttribute('data-bitpype-api') || '';
    var token = root.getAttribute('data-token') || '';
    var slug = root.getAttribute('data-slug') || '';
    if (!token || !slug) return;
    root.textContent = '';
    var wrap = el('div', 'bp-webinar-room');
    root.appendChild(wrap);

    function headers() {
      var s = getSession(token, slug);
      return s ? { 'X-Bitpype-Webinar-Session': s } : {};
    }

    function loadState() {
      return fetchJson(apiUrl(api, token, slug, '/state'), { headers: headers() });
    }

    function renderGate(webinar, errorText) {
      wrap.textContent = '';
      wrap.appendChild(el('h1', null, webinar.title || 'Webinar'));
      if (webinar.description) wrap.appendChild(el('p', 'bp-webinar-desc', webinar.description));
      if (webinar.scheduled_label) wrap.appendChild(el('span', 'bp-webinar-when', webinar.scheduled_label));
      var panel = el('div', 'bp-webinar-panel');
      panel.appendChild(el('strong', null, 'Enter your details and the webinar code to join.'));
      if (errorText) panel.appendChild(el('div', 'bp-webinar-error', errorText));
      var form = el('form', 'bp-webinar-form');
      var fields = [
        ['name', 'Full name', 'text', 'name'],
        ['email', 'Email', 'email', 'email'],
        ['phone', 'Phone number', 'tel', 'tel'],
        ['code', 'Webinar code', 'text', 'off'],
      ];
      var inputs = {};
      fields.forEach(function (f) {
        var label = el('label', null, f[1]);
        label.htmlFor = 'bp-w-' + f[0];
        var input = document.createElement('input');
        input.id = 'bp-w-' + f[0];
        input.name = f[0];
        input.type = f[2];
        input.autocomplete = f[3];
        input.required = true;
        if (f[0] === 'code') input.style.textTransform = 'uppercase';
        inputs[f[0]] = input;
        form.appendChild(label);
        form.appendChild(input);
      });
      var btn = el('button', 'bp-webinar-btn', 'Join the webinar');
      btn.type = 'submit';
      form.appendChild(btn);
      form.addEventListener('submit', function (ev) {
        ev.preventDefault();
        btn.disabled = true;
        fetchJson(apiUrl(api, token, slug, '/register'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: inputs.name.value,
            email: inputs.email.value,
            phone: inputs.phone.value,
            code: inputs.code.value,
          }),
        })
          .then(function (data) {
            btn.disabled = false;
            if (data && data.ok && data.session) {
              setSession(token, slug, data.session);
              return loadState().then(function (st) {
                if (st && st.ok) renderRoom(st);
              });
            }
            renderGate(webinar, (data && data.error) || 'Something went wrong — try again.');
          })
          .catch(function () {
            btn.disabled = false;
            renderGate(webinar, 'Something went wrong — try again.');
          });
      });
      panel.appendChild(form);
      wrap.appendChild(panel);
    }

    function renderRoom(state) {
      var webinar = state.webinar;
      wrap.textContent = '';
      wrap.appendChild(el('h1', null, webinar.title || 'Webinar'));
      if (webinar.scheduled_label) wrap.appendChild(el('span', 'bp-webinar-when', webinar.scheduled_label));
      if (webinar.status === 'ended') {
        wrap.appendChild(
          el('div', 'bp-webinar-notice', 'This webinar has ended — the recording stays up above, and the chat is now closed.')
        );
      } else if (webinar.status !== 'live') {
        wrap.appendChild(
          el(
            'div',
            'bp-webinar-notice',
            "This webinar hasn't started yet" +
              (webinar.scheduled_label ? ' — it begins ' + webinar.scheduled_label : '') +
              '. The chat opens when the webinar goes live.'
          )
        );
      }
      var grid = el('div', 'bp-webinar-grid');
      var videoBox = el('div');
      if (webinar.youtube_id) {
        var frame = el('div', 'bp-webinar-video');
        var iframe = document.createElement('iframe');
        iframe.src = 'https://www.youtube-nocookie.com/embed/' + encodeURIComponent(webinar.youtube_id);
        iframe.title = webinar.title || 'Webinar video';
        iframe.setAttribute(
          'allow',
          'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share'
        );
        iframe.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
        iframe.allowFullscreen = true;
        frame.appendChild(iframe);
        videoBox.appendChild(frame);
      } else {
        videoBox.appendChild(el('div', 'bp-webinar-notice', 'The video will appear here when the host adds it.'));
      }
      grid.appendChild(videoBox);

      var panel = el('div', 'bp-webinar-panel');
      panel.appendChild(el('strong', null, 'Live chat'));
      var log = el('div', 'bp-webinar-log');
      log.setAttribute('aria-live', 'polite');
      panel.appendChild(log);
      var seen = {};
      (state.messages || []).forEach(function (m) {
        renderMessage(log, seen, m);
      });
      if (webinar.chat_open) {
        var form = el('form', 'bp-webinar-send');
        var input = document.createElement('input');
        input.maxLength = 2000;
        input.placeholder = 'Message the host…';
        input.autocomplete = 'off';
        var send = el('button', 'bp-webinar-btn', 'Send');
        send.type = 'submit';
        form.appendChild(input);
        form.appendChild(send);
        form.addEventListener('submit', function (ev) {
          ev.preventDefault();
          var body = input.value.trim();
          if (!body) return;
          input.value = '';
          fetchJson(apiUrl(api, token, slug, '/messages'), {
            method: 'POST',
            headers: Object.assign({ 'Content-Type': 'application/json' }, headers()),
            body: JSON.stringify({ body: body }),
          }).then(function (data) {
            if (data && data.ok && data.message) renderMessage(log, seen, data.message);
          });
        });
        panel.appendChild(form);
      } else {
        panel.appendChild(
          el('p', 'bp-webinar-muted', webinar.status === 'ended' ? 'Chat is closed.' : 'Chat is not open yet.')
        );
      }
      grid.appendChild(panel);
      wrap.appendChild(grid);

      var session = getSession(token, slug);
      if (window.EventSource && session) {
        var es = new EventSource(apiUrl(api, token, slug, '/chat/stream') + '?t=' + encodeURIComponent(session));
        es.addEventListener('message', function (ev) {
          try {
            var m = JSON.parse(ev.data);
            if (m.redacted) {
              // Host hid a message — rebuild from the server list.
              fetchJson(apiUrl(api, token, slug, '/messages'), { headers: headers() }).then(function (data) {
                if (data && data.ok) {
                  log.textContent = '';
                  seen = {};
                  (data.messages || []).forEach(function (mm) {
                    renderMessage(log, seen, mm);
                  });
                }
              });
            } else {
              renderMessage(log, seen, m);
            }
          } catch (e) {
            /* malformed event — ignore */
          }
        });
      }
    }

    loadState()
      .then(function (state) {
        if (!state || !state.ok) {
          wrap.appendChild(el('h1', null, 'Webinar not found'));
          wrap.appendChild(el('p', 'bp-webinar-desc', "That webinar link doesn't match a webinar. Check the link and try again."));
          return;
        }
        if (!state.registered) renderGate(state.webinar, null);
        else renderRoom(state);
      })
      .catch(function () {
        wrap.appendChild(el('p', 'bp-webinar-desc', 'The webinar could not be loaded. Try again in a moment.'));
      });
  }

  function bootRoots() {
    var roots = document.querySelectorAll('[data-bitpype-webinar-root]');
    for (var i = 0; i < roots.length; i++) bootRoom(roots[i]);
  }

  window.BitpypeWebinarEmbed = { renderCard: renderCard, bootRoom: bootRoom };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootRoots);
  else bootRoots();
})();
