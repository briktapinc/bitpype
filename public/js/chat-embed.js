/**
 * BitPype site chatbot widget (Standard/Premium).
 * Mounts on .bitpype-chat-embed[data-bitpype-chat] and talks to
 * /api/v1/chat/public/:token — never uses workspace admin tokens.
 */
(function () {
  'use strict';

  if (window.BitpypeChat && window.BitpypeChat.__booted) return;

  var STYLE_ID = 'bitpype-chat-embed-css';
  var TOKEN_ATTR = 'data-bitpype-chat-token';
  var ROOT_CLASS = 'bitpype-chat-embed';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function apiBase(el) {
    var raw = (el && el.getAttribute('data-bitpype-api')) || '';
    if (raw) return String(raw).replace(/\/$/, '');
    try {
      var src = document.querySelector('script[data-bitpype-chat-script],script[src*="chat-embed.js"]');
      if (src && src.src) return new URL(src.src).origin;
    } catch (e) {
      /* ignore */
    }
    return '';
  }

  function ensureStyles(primary) {
    var color = primary || 'var(--ws-primary, var(--accent, #0e7a68))';
    var existing = document.getElementById(STYLE_ID);
    var css = [
      '.' + ROOT_CLASS + '{all:initial;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;}',
      '.' + ROOT_CLASS + ' *{box-sizing:border-box;}',
      '.bp-chat-bubble{position:fixed;z-index:2147483000;right:18px;bottom:18px;width:56px;height:56px;',
      'border:0;border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center;',
      'background:' + color + ';color:#fff;box-shadow:0 10px 28px rgba(0,0,0,.22);}',
      '.bp-chat-bubble svg{width:26px;height:26px;fill:currentColor;}',
      '.bp-chat-panel{position:fixed;z-index:2147483001;right:18px;bottom:84px;width:min(380px,calc(100vw - 24px));',
      'height:min(520px,calc(100vh - 120px));display:flex;flex-direction:column;border-radius:16px;overflow:hidden;',
      'background:#fff;color:#1a1a1a;box-shadow:0 18px 50px rgba(0,0,0,.28);border:1px solid rgba(0,0,0,.08);}',
      '.bp-chat-panel[hidden]{display:none!important;}',
      '.bp-chat-head{padding:14px 16px;background:' +
        color +
        ';color:#fff;display:flex;align-items:center;justify-content:space-between;gap:8px;}',
      '.bp-chat-head strong{font-size:15px;}',
      '.bp-chat-head button{appearance:none;border:0;background:transparent;color:inherit;font-size:20px;cursor:pointer;line-height:1;}',
      '.bp-chat-tabs{display:flex;gap:0;border-bottom:1px solid rgba(0,0,0,.08);background:#fff;flex-shrink:0;}',
      '.bp-chat-tab{flex:1;appearance:none;border:0;background:transparent;padding:10px 12px;font:inherit;font-size:13px;',
      'font-weight:600;color:#555;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px;}',
      '.bp-chat-tab.is-active{color:' + color + ';border-bottom-color:' + color + ';}',
      '.bp-chat-view{flex:1;min-height:0;display:none;flex-direction:column;}',
      '.bp-chat-view.is-active{display:flex;}',
      '.bp-chat-msgs{flex:1;overflow:auto;padding:14px;background:#f6f7f8;display:flex;flex-direction:column;gap:10px;}',
      '.bp-chat-msg{max-width:88%;padding:10px 12px;border-radius:14px;font-size:14px;line-height:1.4;white-space:pre-wrap;word-break:break-word;}',
      '.bp-chat-msg.visitor{align-self:flex-end;background:' + color + ';color:#fff;border-bottom-right-radius:4px;}',
      '.bp-chat-msg.agent,.bp-chat-msg.system{align-self:flex-start;background:#fff;border:1px solid rgba(0,0,0,.08);border-bottom-left-radius:4px;}',
      '.bp-chat-msg.system{opacity:.9;font-size:13px;}',
      '.bp-chat-msg.bp-chat-lead-cta{align-self:flex-start;max-width:100%;padding:0;border:0;background:transparent;}',
      '.bp-chat-lead-btn{appearance:none;border:0;border-radius:999px;padding:10px 16px;background:' + color + ';',
      'color:#fff;font:inherit;font-size:13px;font-weight:600;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.12);}',
      '.bp-chat-lead-btn:hover{filter:brightness(1.05);}',
      '.bp-chat-foot{padding:10px;border-top:1px solid rgba(0,0,0,.08);background:#fff;display:flex;gap:8px;flex-shrink:0;}',
      '.bp-chat-foot input{flex:1;border:1px solid rgba(0,0,0,.14);border-radius:999px;padding:10px 14px;font:inherit;}',
      '.bp-chat-foot button{appearance:none;border:0;border-radius:999px;padding:10px 14px;background:' +
        color +
        ';color:#fff;font:inherit;font-weight:600;cursor:pointer;}',
      '.bp-chat-lead{flex:1;min-height:0;overflow:auto;padding:14px;background:#fff;display:flex;flex-direction:column;gap:8px;}',
      '.bp-chat-lead input,.bp-chat-lead textarea{width:100%;border:1px solid rgba(0,0,0,.14);border-radius:10px;padding:8px 10px;font:inherit;}',
      '.bp-chat-lead textarea{min-height:64px;resize:vertical;}',
      '.bp-chat-lead .bp-chat-lead-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:4px;}',
      '.bp-chat-lead .bp-chat-lead-actions button{appearance:none;border:0;border-radius:999px;padding:8px 12px;font:inherit;cursor:pointer;}',
      '.bp-chat-lead .bp-chat-lead-sms{display:flex;align-items:flex-start;gap:8px;font-size:0.88rem;cursor:pointer;}',
      '.bp-chat-lead .bp-chat-lead-sms input{width:auto;margin-top:2px;}',
      '.bp-chat-lead .bp-chat-lead-sms-policy{margin:0;font-size:0.75rem;line-height:1.5;color:#666;}',
      '.bp-chat-lead .bp-chat-lead-sms-policy a{color:inherit;text-decoration:underline;}',
      '.bp-chat-lead .bp-chat-lead-submit{background:' + color + ';color:#fff;font-weight:600;}',
      '.bp-chat-lead .bp-chat-lead-cancel{background:#eee;}',
      '.bp-chat-status{font-size:12px;color:#666;padding:0 14px 8px;background:#f6f7f8;flex-shrink:0;}',
      // Batch 138: voice bubble + panel.
      '.bp-chat-voice-bubble{position:fixed;z-index:2147483000;right:18px;bottom:84px;width:56px;height:56px;',
      'border:0;border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center;overflow:hidden;',
      'background:' + color + ';color:#fff;box-shadow:0 10px 28px rgba(0,0,0,.22);padding:0;}',
      '.bp-chat-voice-bubble svg{width:26px;height:26px;fill:currentColor;}',
      '.bp-chat-voice-bubble img{width:100%;height:100%;object-fit:cover;display:block;}',
      '.bp-chat-voice-bubble.is-live{animation:bp-voice-pulse 1.6s ease-in-out infinite;}',
      '@keyframes bp-voice-pulse{0%,100%{box-shadow:0 10px 28px rgba(0,0,0,.22);}50%{box-shadow:0 0 0 10px rgba(0,0,0,.08),0 10px 28px rgba(0,0,0,.22);}}',
      '.bp-voice-panel{position:fixed;z-index:2147483001;right:18px;bottom:84px;width:min(380px,calc(100vw - 24px));',
      'height:min(440px,calc(100vh - 120px));display:flex;flex-direction:column;border-radius:16px;overflow:hidden;',
      'background:#fff;color:#1a1a1a;box-shadow:0 18px 50px rgba(0,0,0,.28);border:1px solid rgba(0,0,0,.08);}',
      '.bp-voice-panel[hidden]{display:none!important;}',
      '.bp-voice-head{padding:14px 16px;background:' + color + ';color:#fff;display:flex;align-items:center;justify-content:space-between;gap:8px;}',
      '.bp-voice-head strong{font-size:15px;}',
      '.bp-voice-head button{appearance:none;border:0;background:transparent;color:inherit;font-size:20px;cursor:pointer;line-height:1;}',
      '.bp-voice-status{padding:10px 14px;font-size:13px;color:#444;background:#f6f7f8;border-bottom:1px solid rgba(0,0,0,.06);display:flex;justify-content:space-between;gap:8px;flex-shrink:0;}',
      '.bp-voice-log{flex:1;overflow:auto;padding:14px;background:#f6f7f8;display:flex;flex-direction:column;gap:10px;}',
      '.bp-voice-foot{padding:10px;border-top:1px solid rgba(0,0,0,.08);background:#fff;display:flex;justify-content:center;flex-shrink:0;}',
      '.bp-voice-end{appearance:none;border:0;border-radius:999px;padding:10px 20px;background:#c0392b;color:#fff;font:inherit;font-weight:600;cursor:pointer;}',
      '@media (max-width:480px){.bp-chat-panel{right:8px;left:8px;width:auto;bottom:78px;height:min(70vh,560px);}',
      '.bp-chat-bubble{right:12px;bottom:12px}.bp-chat-voice-bubble{right:12px;bottom:76px}.bp-voice-panel{right:8px;left:8px;width:auto;bottom:78px}}',
    ].join('');
    if (existing) {
      existing.textContent = css;
      return;
    }
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = css;
    document.head.appendChild(style);
  }

  function iconSvg() {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-5 4v-4H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm2 4v2h12V8H6zm0 4v2h8v-2H6z"/></svg>';
  }

  function micSvg() {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3zm7-3a7 7 0 0 1-14 0H3a9 9 0 0 0 8 8.94V23h2v-3.06A9 9 0 0 0 21 12h-2z"/></svg>';
  }

  function mount(el) {
    if (!el || el.__bpChatMounted) return;
    var token = el.getAttribute(TOKEN_ATTR) || '';
    if (!token) return;
    el.__bpChatMounted = true;
    var base = apiBase(el);
    var state = {
      token: token,
      base: base,
      session: null,
      afterId: 0,
      settings: null,
      open: false,
      polling: null,
      waitingSince: 0,
      activeTab: 'chat',
      leadCtaShown: false,
    };

    var bubble = document.createElement('button');
    bubble.type = 'button';
    bubble.className = 'bp-chat-bubble';
    bubble.setAttribute('aria-label', 'Open chat');
    bubble.innerHTML = iconSvg();

    var panel = document.createElement('div');
    panel.className = 'bp-chat-panel';
    panel.hidden = true;
    panel.innerHTML = [
      '<div class="bp-chat-head"><strong class="bp-chat-title">Chat</strong><button type="button" class="bp-chat-close" aria-label="Close">×</button></div>',
      '<div class="bp-chat-tabs" role="tablist">',
      '<button type="button" class="bp-chat-tab is-active" data-tab="chat" role="tab" aria-selected="true">Chat</button>',
      '<button type="button" class="bp-chat-tab" data-tab="details" role="tab" aria-selected="false">Details</button>',
      '</div>',
      '<div class="bp-chat-view is-active" data-view="chat" role="tabpanel">',
      '<div class="bp-chat-msgs" role="log" aria-live="polite"></div>',
      '<div class="bp-chat-status" hidden></div>',
      '<form class="bp-chat-foot"><input type="text" class="bp-chat-input" placeholder="Type a message…" autocomplete="off" /><button type="submit">Send</button></form>',
      '</div>',
      '<div class="bp-chat-view" data-view="details" role="tabpanel" hidden>',
      '<div class="bp-chat-lead">',
      '<strong>Leave your details</strong>',
      '<input type="text" class="bp-chat-lead-name" placeholder="Name" autocomplete="name" />',
      '<input type="email" class="bp-chat-lead-email" placeholder="Email" autocomplete="email" />',
      '<input type="tel" class="bp-chat-lead-phone" placeholder="Phone" autocomplete="tel" />',
      // SMS opt-in (Batch 25): unchecked by default, never required.
      '<label class="bp-chat-lead-sms"><input type="checkbox" class="bp-chat-lead-sms-optin" /> <span class="bp-chat-lead-sms-label">Text me updates &amp; offers</span></label>',
      // SMS policy consent line (Batch 77): filled from the payload's
      // sms_policy block when the config arrives; stays hidden without it.
      '<p class="bp-chat-lead-sms-policy" hidden></p>',
      '<textarea class="bp-chat-lead-msg" placeholder="How can we help?"></textarea>',
      '<div class="bp-chat-lead-actions">',
      '<button type="button" class="bp-chat-lead-submit">Send</button>',
      '<button type="button" class="bp-chat-lead-cancel">Back to chat</button>',
      '</div></div></div>',
    ].join('');

    // Keep mount node empty; attach UI to body so position:fixed works in transformed parents.
    document.body.appendChild(bubble);
    document.body.appendChild(panel);

    /* ── Batch 138: AI voice agent (OpenAI Realtime over WebRTC) ──
     * The bubble renders only when the public config advertises voice.
     * Click → microphone permission → server mints an ephemeral
     * Realtime credential (the platform key never reaches this page)
     * → direct WebRTC to OpenAI. Both sides' transcripts are relayed
     * to the server so the conversation is saved with the text chats.
     * NO audio is recorded or stored — transcript text only.
     * Any failure lands the visitor in the regular text chat. */
    var voiceBubble = document.createElement('button');
    voiceBubble.type = 'button';
    voiceBubble.className = 'bp-chat-voice-bubble';
    voiceBubble.setAttribute('aria-label', 'Talk to us');
    voiceBubble.hidden = true;
    voiceBubble.innerHTML = micSvg();

    var voicePanel = document.createElement('div');
    voicePanel.className = 'bp-voice-panel';
    voicePanel.hidden = true;
    voicePanel.innerHTML = [
      '<div class="bp-voice-head"><strong>Voice</strong><button type="button" class="bp-voice-close" aria-label="Close">×</button></div>',
      '<div class="bp-voice-status"><span class="bp-voice-state">Ready</span><span class="bp-voice-timer"></span></div>',
      '<div class="bp-voice-log" role="log" aria-live="polite"></div>',
      '<div class="bp-voice-foot"><button type="button" class="bp-voice-end">End call</button></div>',
    ].join('');
    document.body.appendChild(voiceBubble);
    document.body.appendChild(voicePanel);

    var voiceStateEl = voicePanel.querySelector('.bp-voice-state');
    var voiceTimerEl = voicePanel.querySelector('.bp-voice-timer');
    var voiceLogEl = voicePanel.querySelector('.bp-voice-log');

    var voice = {
      cfg: null,
      active: false,
      connected: false,
      pc: null,
      dc: null,
      stream: null,
      audioEl: null,
      sessionId: null,
      relaySecret: null,
      startedAt: 0,
      maxSec: 600,
      pending: [],
      capTimer: null,
      tickTimer: null,
      flushTimer: null,
      ending: false,
    };

    function setVoiceState(text) {
      if (voiceStateEl) voiceStateEl.textContent = text || '';
    }

    function voiceApi(path, body, keepalive) {
      var url =
        (state.base || '') + '/api/v1/chat/public/' + encodeURIComponent(state.token) + path;
      return fetch(url, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
        keepalive: !!keepalive,
      }).then(function (r) {
        return r.json().then(function (j) {
          if (!r.ok || (j && j.ok === false)) {
            throw new Error((j && j.error) || 'HTTP ' + r.status);
          }
          return j.data || j;
        });
      });
    }

    function appendVoiceCaption(role, text) {
      if (!text) return;
      var div = document.createElement('div');
      div.className = 'bp-chat-msg ' + (role === 'visitor' ? 'visitor' : 'agent');
      div.textContent = text;
      voiceLogEl.appendChild(div);
      voiceLogEl.scrollTop = voiceLogEl.scrollHeight;
    }

    function queueTranscript(role, body, itemId) {
      if (!body) return;
      voice.pending.push({
        role: role,
        body: body,
        item_id: itemId || '',
        at_ms: voice.startedAt ? Date.now() - voice.startedAt : 0,
      });
      appendVoiceCaption(role, body);
    }

    function flushTranscript(final, close, useBeacon) {
      if (!voice.sessionId || !voice.relaySecret) return Promise.resolve();
      var items = voice.pending.splice(0, voice.pending.length);
      if (!items.length && !final) return Promise.resolve();
      var payload = {
        relay_secret: voice.relaySecret,
        items: items,
        final: !!final,
        close: close || undefined,
        connected: voice.connected,
      };
      var path = '/voice/session/' + encodeURIComponent(String(voice.sessionId)) + '/transcript';
      if (useBeacon && navigator.sendBeacon) {
        try {
          var url = (state.base || '') + '/api/v1/chat/public/' + encodeURIComponent(state.token) + path;
          navigator.sendBeacon(url, new Blob([JSON.stringify(payload)], { type: 'application/json' }));
          return Promise.resolve();
        } catch (e) {
          /* fall through to fetch */
        }
      }
      return voiceApi(path, payload, !!final).catch(function () {
        // A failed batch is re-queued once so a transient drop does not
        // silently lose part of the saved conversation.
        if (!final && items.length) voice.pending = items.concat(voice.pending);
      });
    }

    function stopVoiceTimers() {
      if (voice.capTimer) clearTimeout(voice.capTimer);
      if (voice.tickTimer) clearInterval(voice.tickTimer);
      if (voice.flushTimer) clearInterval(voice.flushTimer);
      voice.capTimer = voice.tickTimer = voice.flushTimer = null;
    }

    function teardownVoiceTransport() {
      stopVoiceTimers();
      try {
        if (voice.dc) voice.dc.close();
      } catch (e) {}
      try {
        if (voice.pc) voice.pc.close();
      } catch (e) {}
      if (voice.stream) {
        voice.stream.getTracks().forEach(function (t) {
          try {
            t.stop();
          } catch (e) {}
        });
      }
      if (voice.audioEl) {
        try {
          voice.audioEl.srcObject = null;
        } catch (e) {}
      }
      voice.dc = null;
      voice.pc = null;
      voice.stream = null;
      voice.connected = false;
    }

    function endVoice(closeReason) {
      if (!voice.active || voice.ending) return;
      voice.ending = true;
      var wasConnected = voice.connected;
      // Final flush BEFORE teardown so the saved transcript is complete.
      flushTranscript(true, closeReason || 'hangup').finally(function () {
        teardownVoiceTransport();
        voice.active = false;
        voice.ending = false;
        voice.sessionId = null;
        voice.relaySecret = null;
        voiceBubble.classList.remove('is-live');
        voicePanel.hidden = true;
        if (closeReason === 'cap') {
          openPanel();
          setStatus('Voice reached its time limit — you can keep chatting here by text.');
        } else if (closeReason === 'error' && !wasConnected) {
          openPanel();
          setStatus('Voice could not connect — you can chat here by text instead.');
        }
      });
    }

    function failVoice(line) {
      // One plain line, then the text chat — never a dead end.
      if (voice.sessionId) {
        endVoice('error');
      } else {
        teardownVoiceTransport();
        voice.active = false;
        voicePanel.hidden = true;
        voiceBubble.classList.remove('is-live');
      }
      openPanel();
      setStatus(line);
    }

    function relayToolCall(ev) {
      var done = function (output) {
        try {
          voice.dc.send(
            JSON.stringify({
              type: 'conversation.item.create',
              item: { type: 'function_call_output', call_id: ev.call_id, output: JSON.stringify(output) },
            })
          );
          voice.dc.send(JSON.stringify({ type: 'response.create' }));
        } catch (e) {
          /* channel gone — the conversation record still has the transcript */
        }
      };
      voiceApi('/voice/session/' + encodeURIComponent(String(voice.sessionId)) + '/tool', {
        relay_secret: voice.relaySecret,
        name: ev.name,
        arguments: ev.arguments || '{}',
      }).then(
        function (data) {
          done((data && data.result) || { ok: true });
        },
        function () {
          done({ ok: false, error: 'unavailable' });
        }
      );
    }

    function onVoiceEvent(ev) {
      var msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (e) {
        return;
      }
      if (!msg || !msg.type) return;
      if (msg.type === 'input_audio_buffer.speech_started') {
        setVoiceState('Listening…');
      } else if (msg.type === 'response.output_audio.delta') {
        setVoiceState('Speaking…');
      } else if (msg.type === 'response.done') {
        setVoiceState('Listening…');
      } else if (msg.type === 'conversation.item.input_audio_transcription.completed') {
        queueTranscript('visitor', String(msg.transcript || ''), msg.item_id);
        flushTranscript(false);
      } else if (msg.type === 'response.output_audio_transcript.done') {
        queueTranscript('agent', String(msg.transcript || ''), msg.item_id);
        flushTranscript(false);
      } else if (msg.type === 'response.function_call_arguments.done') {
        relayToolCall(msg);
      } else if (msg.type === 'error') {
        failVoice('Voice hit a problem — you can chat here by text instead.');
      }
    }

    function startVoiceTimers() {
      stopVoiceTimers();
      voice.tickTimer = setInterval(function () {
        var elapsed = Math.floor((Date.now() - voice.startedAt) / 1000);
        var mm = Math.floor(elapsed / 60);
        var ss = String(elapsed % 60);
        if (ss.length < 2) ss = '0' + ss;
        var capMm = Math.floor(voice.maxSec / 60);
        var capSs = String(voice.maxSec % 60);
        if (capSs.length < 2) capSs = '0' + capSs;
        voiceTimerEl.textContent = mm + ':' + ss + ' / ' + capMm + ':' + capSs;
      }, 1000);
      voice.flushTimer = setInterval(function () {
        flushTranscript(false);
      }, 5000);
      voice.capTimer = setTimeout(function () {
        endVoice('cap');
      }, voice.maxSec * 1000);
    }

    function startVoice() {
      if (!voice.cfg || !voice.cfg.enabled || voice.active) return;
      if (
        !navigator.mediaDevices ||
        !navigator.mediaDevices.getUserMedia ||
        typeof RTCPeerConnection === 'undefined'
      ) {
        openPanel();
        setStatus('Voice is not supported in this browser — you can chat here by text.');
        return;
      }
      voice.active = true;
      voice.ending = false;
      closePanel();
      voicePanel.hidden = false;
      voiceLogEl.innerHTML = '';
      voiceTimerEl.textContent = '';
      setVoiceState('Asking for microphone access…');
      navigator.mediaDevices
        .getUserMedia({ audio: true })
        .then(function (stream) {
          voice.stream = stream;
          setVoiceState('Connecting…');
          return voiceApi('/voice/session', {});
        })
        .then(function (data) {
          voice.sessionId = data.session && data.session.id;
          voice.relaySecret = data.relay_secret;
          voice.maxSec = Number(data.max_duration_sec) || 600;
          if (!voice.sessionId || !voice.relaySecret || !data.ephemeral || !data.ephemeral.value) {
            throw new Error('Voice session was not created');
          }
          var pc = new RTCPeerConnection();
          voice.pc = pc;
          voice.stream.getTracks().forEach(function (track) {
            pc.addTrack(track, voice.stream);
          });
          var audioEl = document.createElement('audio');
          audioEl.autoplay = true;
          voice.audioEl = audioEl;
          pc.ontrack = function (e) {
            if (e.streams && e.streams[0]) audioEl.srcObject = e.streams[0];
          };
          var dc = pc.createDataChannel('oai-events');
          voice.dc = dc;
          dc.onmessage = onVoiceEvent;
          dc.onopen = function () {
            voice.connected = true;
            voice.startedAt = Date.now();
            voiceBubble.classList.add('is-live');
            setVoiceState('Listening…');
            startVoiceTimers();
            // Ask the agent to greet first, like the text chat greeting.
            try {
              dc.send(JSON.stringify({ type: 'response.create' }));
            } catch (e) {}
          };
          dc.onclose = function () {
            if (voice.active && !voice.ending) endVoice('hangup');
          };
          return pc
            .createOffer()
            .then(function (offer) {
              return pc.setLocalDescription(offer).then(function () {
                return offer;
              });
            })
            .then(function (offer) {
              return fetch(data.calls_url || 'https://api.openai.com/v1/realtime/calls', {
                method: 'POST',
                body: offer.sdp,
                headers: {
                  Authorization: 'Bearer ' + data.ephemeral.value,
                  'Content-Type': 'application/sdp',
                },
              });
            })
            .then(function (resp) {
              if (!resp.ok) throw new Error('Voice connect failed');
              return resp.text();
            })
            .then(function (sdp) {
              return pc.setRemoteDescription({ type: 'answer', sdp: sdp });
            });
        })
        .catch(function () {
          if (voice.sessionId) {
            endVoice('error');
          } else {
            teardownVoiceTransport();
            voice.active = false;
            voicePanel.hidden = true;
            openPanel();
            setStatus('Voice could not start — check microphone access, or chat here by text.');
          }
        });
    }

    function setupVoice(cfg) {
      if (!cfg || !cfg.enabled) return;
      voice.cfg = cfg;
      voice.maxSec = Number(cfg.max_duration_sec) || 600;
      if (cfg.bubble_image_url) {
        var img = document.createElement('img');
        img.alt = '';
        img.src = (state.base || '') + cfg.bubble_image_url;
        voiceBubble.innerHTML = '';
        voiceBubble.appendChild(img);
      }
      voiceBubble.hidden = false;
    }

    voiceBubble.addEventListener('click', function () {
      if (voice.active) {
        voicePanel.hidden = !voicePanel.hidden;
        return;
      }
      startVoice();
    });
    voicePanel.querySelector('.bp-voice-close').addEventListener('click', function () {
      endVoice('hangup');
    });
    voicePanel.querySelector('.bp-voice-end').addEventListener('click', function () {
      endVoice('hangup');
    });
    window.addEventListener('beforeunload', function () {
      // Browser going away mid-call: flush what we have (non-final) —
      // the saved session then honestly reads as ended abruptly
      // rather than pretending the conversation completed.
      if (voice.active && voice.sessionId) flushTranscript(false, undefined, true);
    });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden && voice.active) flushTranscript(false);
    });

    var msgsEl = panel.querySelector('.bp-chat-msgs');
    var statusEl = panel.querySelector('.bp-chat-status');
    var form = panel.querySelector('.bp-chat-foot');
    var input = panel.querySelector('.bp-chat-input');
    var chatView = panel.querySelector('[data-view="chat"]');
    var detailsView = panel.querySelector('[data-view="details"]');
    var tabChat = panel.querySelector('.bp-chat-tab[data-tab="chat"]');
    var tabDetails = panel.querySelector('.bp-chat-tab[data-tab="details"]');

    function setStatus(text) {
      if (!text) {
        statusEl.hidden = true;
        statusEl.textContent = '';
        return;
      }
      statusEl.hidden = false;
      statusEl.textContent = text;
    }

    function setTab(name) {
      state.activeTab = name === 'details' ? 'details' : 'chat';
      var isDetails = state.activeTab === 'details';
      tabChat.classList.toggle('is-active', !isDetails);
      tabDetails.classList.toggle('is-active', isDetails);
      tabChat.setAttribute('aria-selected', isDetails ? 'false' : 'true');
      tabDetails.setAttribute('aria-selected', isDetails ? 'true' : 'false');
      chatView.classList.toggle('is-active', !isDetails);
      detailsView.classList.toggle('is-active', isDetails);
      chatView.hidden = isDetails;
      detailsView.hidden = !isDetails;
      if (isDetails) {
        var nameInput = panel.querySelector('.bp-chat-lead-name');
        if (nameInput)
          setTimeout(function () {
            nameInput.focus();
          }, 0);
      } else if (state.open) {
        setTimeout(function () {
          input.focus();
        }, 0);
      }
    }

    function showLeadCta(fromMsgId) {
      if (state.settings && state.settings.suggest_lead_capture === false) return;
      if (state.leadCtaShown) return;
      var ctaId = fromMsgId ? 'lead-cta-' + fromMsgId : 'lead-cta-timeout';
      if (msgsEl.querySelector('[data-id="' + ctaId + '"]')) {
        state.leadCtaShown = true;
        return;
      }
      state.leadCtaShown = true;
      var wrap = document.createElement('div');
      wrap.className = 'bp-chat-msg bp-chat-lead-cta';
      wrap.setAttribute('data-id', ctaId);
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'bp-chat-lead-btn';
      btn.textContent = 'Leave your details';
      btn.addEventListener('click', function () {
        setTab('details');
      });
      wrap.appendChild(btn);
      msgsEl.appendChild(wrap);
      msgsEl.scrollTop = msgsEl.scrollHeight;
    }

    function appendMsg(m) {
      if (!m || !m.id) return;
      if (msgsEl.querySelector('[data-id="' + m.id + '"]')) return;
      var div = document.createElement('div');
      div.className = 'bp-chat-msg ' + esc(m.role || 'agent');
      div.setAttribute('data-id', String(m.id));
      div.textContent = m.body || '';
      msgsEl.appendChild(div);
      msgsEl.scrollTop = msgsEl.scrollHeight;
      if (m.id > state.afterId) state.afterId = m.id;
      if (m.role === 'agent' || m.role === 'system') {
        state.waitingSince = 0;
        setStatus('');
      }
      // Server marks open_lead_form after a warning — show in-chat button, never overlay.
      var meta = m.meta || null;
      if (meta && meta.open_lead_form && state.settings && state.settings.suggest_lead_capture !== false) {
        showLeadCta(m.id);
      }
    }

    function api(path, opts) {
      var url = (state.base || '') + '/api/v1/chat/public/' + encodeURIComponent(state.token) + path;
      return fetch(
        url,
        Object.assign(
          {
            headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          },
          opts || {}
        )
      ).then(function (r) {
        return r.json().then(function (j) {
          if (!r.ok || (j && j.ok === false)) {
            throw new Error((j && j.error) || 'HTTP ' + r.status);
          }
          return j.data || j;
        });
      });
    }

    function ensureSession() {
      if (state.session && state.session.session_token) {
        return Promise.resolve(state.session);
      }
      return api('/session', {
        method: 'POST',
        body: JSON.stringify({}),
      }).then(function (data) {
        state.session = data.session;
        return state.session;
      });
    }

    function poll() {
      if (!state.session || !state.open) return;
      api(
        '/messages?session=' +
          encodeURIComponent(state.session.session_token) +
          '&after=' +
          encodeURIComponent(String(state.afterId || 0))
      )
        .then(function (data) {
          (data.messages || []).forEach(appendMsg);
          if (state.waitingSince) {
            var sec =
              state.settings && state.settings.agent_timeout_hint_sec
                ? Number(state.settings.agent_timeout_hint_sec)
                : 90;
            if ((Date.now() - state.waitingSince) / 1000 > sec) {
              setStatus('Still waiting on a reply — you can leave your contact details.');
              if (state.settings && state.settings.suggest_lead_capture !== false) {
                showLeadCta(null);
              }
            } else {
              setStatus('Waiting for a reply…');
            }
          }
        })
        .catch(function () {
          /* ignore transient */
        });
    }

    function startPoll() {
      stopPoll();
      state.polling = setInterval(poll, 2500);
      poll();
    }

    function stopPoll() {
      if (state.polling) clearInterval(state.polling);
      state.polling = null;
    }

    function openPanel() {
      state.open = true;
      panel.hidden = false;
      ensureSession()
        .then(function () {
          if (state.settings && state.settings.greeting && !msgsEl.children.length) {
            var greet = document.createElement('div');
            greet.className = 'bp-chat-msg agent';
            greet.textContent = state.settings.greeting;
            msgsEl.appendChild(greet);
          }
          startPoll();
          if (state.activeTab === 'chat') input.focus();
        })
        .catch(function (e) {
          setStatus(e.message || 'Could not start chat');
        });
    }

    function closePanel() {
      state.open = false;
      panel.hidden = true;
      stopPoll();
    }

    bubble.addEventListener('click', function () {
      if (panel.hidden) openPanel();
      else closePanel();
    });
    panel.querySelector('.bp-chat-close').addEventListener('click', closePanel);

    tabChat.addEventListener('click', function () {
      setTab('chat');
    });
    tabDetails.addEventListener('click', function () {
      setTab('details');
    });

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var text = String(input.value || '').trim();
      if (!text) return;
      input.value = '';
      ensureSession()
        .then(function () {
          return api('/message', {
            method: 'POST',
            body: JSON.stringify({
              session: state.session.session_token,
              message: text,
            }),
          });
        })
        .then(function (data) {
          if (data.session) state.session = data.session;
          if (data.message) appendMsg(data.message);
          state.waitingSince = Date.now();
          setStatus('Waiting for a reply…');
          startPoll();
        })
        .catch(function (e) {
          setStatus(e.message || 'Send failed');
        });
    });

    panel.querySelector('.bp-chat-lead-cancel').addEventListener('click', function () {
      setTab('chat');
    });
    panel.querySelector('.bp-chat-lead-submit').addEventListener('click', function () {
      ensureSession()
        .then(function () {
          return api('/lead', {
            method: 'POST',
            body: JSON.stringify({
              session: state.session.session_token,
              name: panel.querySelector('.bp-chat-lead-name').value,
              email: panel.querySelector('.bp-chat-lead-email').value,
              phone: panel.querySelector('.bp-chat-lead-phone').value,
              sms_optin_consent: !!(
                panel.querySelector('.bp-chat-lead-sms-optin') &&
                panel.querySelector('.bp-chat-lead-sms-optin').checked
              ),
              message: panel.querySelector('.bp-chat-lead-msg').value,
            }),
          });
        })
        .then(function (data) {
          setTab('chat');
          setStatus(data.message || 'Thanks — we will follow up.');
          state.waitingSince = 0;
        })
        .catch(function (e) {
          setStatus(e.message || 'Could not send details');
          setTab('chat');
        });
    });

    api('')
      .then(function (data) {
        state.settings = (data && data.settings) || {};
        ensureStyles(state.settings.primary_color || '');
        var smsLabel = panel.querySelector('.bp-chat-lead-sms-label');
        if (smsLabel && data && data.sms_optin && data.sms_optin.label) {
          smsLabel.textContent = data.sms_optin.label;
        }
        var smsPolicy = panel.querySelector('.bp-chat-lead-sms-policy');
        if (smsPolicy && data && data.sms_policy && data.sms_policy.html) {
          smsPolicy.innerHTML = data.sms_policy.html;
          smsPolicy.hidden = false;
        }
        var title = panel.querySelector('.bp-chat-title');
        if (title) title.textContent = state.settings.bubble_label || 'Chat';
        bubble.setAttribute('aria-label', state.settings.bubble_label || 'Open chat');
        if (state.settings.position === 'bottom-left') {
          bubble.style.right = 'auto';
          bubble.style.left = '18px';
          panel.style.right = 'auto';
          panel.style.left = '18px';
          voiceBubble.style.right = 'auto';
          voiceBubble.style.left = '18px';
          voicePanel.style.right = 'auto';
          voicePanel.style.left = '18px';
        }
        setupVoice(data && data.voice);
      })
      .catch(function () {
        ensureStyles('');
      });
  }

  function boot() {
    var nodes = document.querySelectorAll('.' + ROOT_CLASS + '[' + TOKEN_ATTR + '], [' + TOKEN_ATTR + ']');
    for (var i = 0; i < nodes.length; i++) mount(nodes[i]);
  }

  window.BitpypeChat = {
    __booted: true,
    boot: boot,
    mount: mount,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
