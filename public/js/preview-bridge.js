'use strict';

// Runs inside the opaque preview. No parent DOM, cookies, credentials or API proxy.
(function () {
  function fontLink(href) {
    if (!href) return;
    try {
      var url = new URL(href);
      if (url.origin !== 'https://fonts.googleapis.com' || !/^\/css2?$/.test(url.pathname)) return;
      var link = document.getElementById('ws-bridge-fonts');
      if (!link) {
        link = document.createElement('link');
        link.id = 'ws-bridge-fonts';
        link.rel = 'stylesheet';
        document.head.appendChild(link);
      }
      link.href = url.href;
    } catch (err) {
      /* Invalid font URLs are ignored. */
    }
  }
  function fonts(data) {
    document.documentElement.style.setProperty('--ws-font', String(data.font || '').slice(0, 2000));
    document.documentElement.style.setProperty(
      '--ws-heading-font',
      String(data.headingFont || data.font || '').slice(0, 2000)
    );
    var style = document.getElementById('ws-font-rules');
    if (!style) {
      style = document.createElement('style');
      style.id = 'ws-font-rules';
      document.head.appendChild(style);
    }
    style.textContent =
      'body{font-family:var(--ws-font)}h1,h2,h3,h4,h5,h6{font-family:var(--ws-heading-font,var(--ws-font))}';
    fontLink(data.fontHref);
  }
  function rewrite(from, to) {
    if (!/^#[\da-f]{6}$/i.test(from) || !/^#[\da-f]{6}$/i.test(to) || from === to) return;
    var re = new RegExp(from, 'gi');
    document.querySelectorAll('style').forEach(function (el) {
      el.textContent = el.textContent.replace(re, to);
    });
    document.querySelectorAll('[style],[fill],[stroke]').forEach(function (el) {
      ['style', 'fill', 'stroke'].forEach(function (attr) {
        var value = el.getAttribute(attr);
        if (value) el.setAttribute(attr, value.replace(re, to));
      });
    });
  }
  /* ------------------------------------------------------------------
   * Batch 104 — OPTIMISTIC PREVIEW patches (portal design chat).
   *
   * The owner-portal chat derives a patch spec from the change's
   * plan and posts it here so the accepted change appears in the
   * preview instantly, while the platform verifies the real
   * build. A patch is PROVISIONAL: it lives only in this
   * document, it never touches the real site, and the verified
   * render (which replaces this document wholesale) always wins.
   * On a verification failure the portal posts a revert and this
   * document returns byte-for-byte to its pre-patch state.
   *
   * Allowlisted ops ONLY — there is deliberately no html op:
   *   { op: 'text',  from, to }                  text swap (textContent)
   *   { op: 'style', selector, property, value } one CSS declaration
   *   { op: 'vars',  vars: { '--ws-primary': '#rrggbb' } }
   * Every field is re-validated here before it touches the DOM;
   * anything unrecognized is skipped, never improvised.
   * ------------------------------------------------------------------ */
  var PATCH_STYLE_PROPERTIES = {
    color: 1, 'background-color': 1, 'border-color': 1, 'font-family': 1,
    'font-size': 1, 'font-weight': 1, 'font-style': 1, 'letter-spacing': 1,
    'line-height': 1, 'text-transform': 1, 'text-decoration': 1,
    'margin-top': 1, 'margin-bottom': 1, 'padding-top': 1, 'padding-bottom': 1,
  };
  var PATCH_VARS = { '--ws-primary': 1, '--ws-secondary': 1, '--ws-bg': 1, '--ws-text': 1 };
  var patches = {}; // patchId -> { undos: [], styleEl, marked: [] }

  function patchFx(on) {
    var fx = document.getElementById('ws-chat-patch-fx');
    if (on && !fx) {
      fx = document.createElement('style');
      fx.id = 'ws-chat-patch-fx';
      fx.textContent =
        '@keyframes wsPatchPulse{from{outline-color:rgba(14,122,104,.22)}to{outline-color:rgba(14,122,104,.8)}}' +
        '[data-ws-patched]{outline:2px solid rgba(14,122,104,.55)!important;outline-offset:2px;' +
        'animation:wsPatchPulse 1.1s ease-in-out infinite alternate}' +
        '@media (prefers-reduced-motion: reduce){[data-ws-patched]{animation:none}}';
      document.head.appendChild(fx);
    } else if (!on && fx) {
      fx.remove();
    }
  }
  function anyPatchApplying() {
    for (var k in patches) if (Object.prototype.hasOwnProperty.call(patches, k)) return true;
    return false;
  }
  function markEl(patch, el) {
    if (!el || el.getAttribute('data-ws-patched') != null) return;
    el.setAttribute('data-ws-patched', '1');
    patch.marked.push(el);
  }
  function applyTextOp(patch, op) {
    var from = String(op.from || '');
    var to = String(op.to || '');
    if (!from || !to || from === to || from.length > 240 || to.length > 400) return false;
    // Preferred: a whole element whose exact text is the target
    // (the headline case). Deepest match wins; snapshots restore
    // the original markup exactly on revert.
    var candidates = [];
    try {
      candidates = Array.prototype.slice.call(document.querySelectorAll('body *')).filter(function (el) {
        return (el.textContent || '').trim() === from;
      });
    } catch (err) {
      candidates = [];
    }
    var el = null;
    for (var i = 0; i < candidates.length; i++) {
      var hasChildMatch = candidates.some(function (other) {
        return other !== candidates[i] && candidates[i].contains(other);
      });
      if (!hasChildMatch) {
        el = candidates[i];
        break;
      }
    }
    if (el) {
      // Snapshot the child nodes (clones) so revert restores the
      // original markup exactly — no innerHTML anywhere in the
      // patch engine; text goes in through textContent only.
      var savedChildren = Array.prototype.map.call(el.childNodes, function (n) {
        return n.cloneNode(true);
      });
      patch.undos.push(function () {
        while (el.firstChild) el.removeChild(el.firstChild);
        savedChildren.forEach(function (n) {
          el.appendChild(n.cloneNode(true));
        });
      });
      el.textContent = to;
      markEl(patch, el);
      return true;
    }
    // Fallback: the first text node containing the string
    // (script/style/textarea contents are never touched).
    try {
      var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode: function (node) {
          var p = node.parentElement;
          if (!p || /^(SCRIPT|STYLE|TEXTAREA|NOSCRIPT)$/.test(p.tagName)) return NodeFilter.FILTER_REJECT;
          return node.nodeValue && node.nodeValue.indexOf(from) !== -1
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_SKIP;
        },
      });
      var node = walker.nextNode();
      if (node) {
        var originalValue = node.nodeValue;
        patch.undos.push(function () {
          node.nodeValue = originalValue;
        });
        node.nodeValue = originalValue.replace(from, to);
        if (node.parentElement) markEl(patch, node.parentElement);
        return true;
      }
    } catch (err) {
      /* TreeWalker unavailable — the op simply does not ground. */
    }
    return false;
  }
  function validStyleOp(op) {
    var selector = String(op.selector || '');
    var property = String(op.property || '').toLowerCase();
    var value = String(op.value || '');
    if (!selector || selector.length > 200 || /[<>{}]/.test(selector)) return null;
    if (!PATCH_STYLE_PROPERTIES[property]) return null;
    if (!value || value.length > 160 || /[<>{};]|url\s*\(|expression|javascript:|@import/i.test(value)) return null;
    return { selector: selector, property: property, value: value };
  }
  function applyPatch(data) {
    var patchId = String(data.patchId || '').slice(0, 80);
    if (!patchId) return;
    if (patches[patchId]) revertPatch(patchId, true);
    var patch = { undos: [], styleEl: null, marked: [] };
    patches[patchId] = patch;
    var ops = Array.isArray(data.ops) ? data.ops.slice(0, 12) : [];
    var applied = 0;
    var styleRules = {}; // selector -> [declarations]
    ops.forEach(function (op) {
      if (!op || typeof op !== 'object') return;
      if (op.op === 'text') {
        if (applyTextOp(patch, op)) applied += 1;
      } else if (op.op === 'style') {
        var clean = validStyleOp(op);
        if (clean) {
          (styleRules[clean.selector] = styleRules[clean.selector] || []).push(
            clean.property + ':' + clean.value
          );
          applied += 1;
          try {
            Array.prototype.slice
              .call(document.querySelectorAll(clean.selector))
              .slice(0, 100)
              .forEach(function (el) {
                markEl(patch, el);
              });
          } catch (err) {
            /* an unmatchable selector marks nothing */
          }
        }
      } else if (op.op === 'vars') {
        var vars = op.vars && typeof op.vars === 'object' ? op.vars : {};
        var setAny = false;
        Object.keys(vars).forEach(function (name) {
          var value = String(vars[name] || '');
          if (!PATCH_VARS[name] || !/^#[\da-f]{6}$/i.test(value)) return;
          var prev = document.documentElement.style.getPropertyValue(name);
          patch.undos.push(function () {
            if (prev) document.documentElement.style.setProperty(name, prev);
            else document.documentElement.style.removeProperty(name);
          });
          document.documentElement.style.setProperty(name, value);
          setAny = true;
        });
        if (setAny) applied += 1;
      }
      // Any other op kind (html, script, …) is ignored by design.
    });
    var selectors = Object.keys(styleRules);
    if (selectors.length) {
      var styleEl = document.createElement('style');
      styleEl.setAttribute('data-ws-chat-patch', patchId);
      styleEl.textContent = selectors
        .map(function (sel) {
          return sel + '{' + styleRules[sel].join(';') + '}';
        })
        .join('\n');
      document.head.appendChild(styleEl);
      patch.styleEl = styleEl;
    }
    patchFx(true);
    parent.postMessage(
      { source: 'ws-preview', type: 'chat-patch-result', patchId: patchId, applied: applied, total: ops.length },
      '*'
    );
  }
  function revertPatch(patchId, silent) {
    var patch = patches[patchId];
    if (!patch) return;
    delete patches[patchId];
    for (var i = patch.undos.length - 1; i >= 0; i--) {
      try {
        patch.undos[i]();
      } catch (err) {
        /* one bad undo never blocks the rest */
      }
    }
    if (patch.styleEl) patch.styleEl.remove();
    patch.marked.forEach(function (el) {
      el.removeAttribute('data-ws-patched');
    });
    if (!anyPatchApplying()) patchFx(false);
    if (!silent) {
      parent.postMessage(
        { source: 'ws-preview', type: 'chat-patch-result', patchId: patchId, reverted: true },
        '*'
      );
    }
  }
  function confirmPatch(patchId) {
    var patch = patches[patchId];
    if (!patch) return;
    // The change stays; only the "applying" treatment comes off.
    // The verified render replaces this document on the portal's
    // next refresh and is the lasting truth.
    patch.marked.forEach(function (el) {
      el.removeAttribute('data-ws-patched');
    });
    patch.marked = [];
    delete patches[patchId];
    if (!anyPatchApplying()) patchFx(false);
    parent.postMessage(
      { source: 'ws-preview', type: 'chat-patch-result', patchId: patchId, confirmed: true },
      '*'
    );
  }

  window.addEventListener('message', function (event) {
    var data = event.data;
    if (event.source !== parent || !data || data.source !== 'ws-portal') return;
    if (data.type === 'chat-patch-apply') applyPatch(data);
    if (data.type === 'chat-patch-revert') revertPatch(String(data.patchId || ''));
    if (data.type === 'chat-patch-confirm') confirmPatch(String(data.patchId || ''));
    if (data.type === 'site-fonts') fonts(data);
    if (data.type === 'set-font') fontLink(data.fontHref);
    if (data.type === 'theme-preview') {
      (Array.isArray(data.rewrites) ? data.rewrites.slice(0, 100) : []).forEach(function (pair) {
        if (pair) rewrite(pair.from, pair.to);
      });
      ['primary', 'secondary', 'bg', 'text'].forEach(function (key) {
        var value = data.colors && data.colors[key];
        if (/^#[\da-f]{6}$/i.test(value)) document.documentElement.style.setProperty('--ws-' + key, value);
      });
      fonts(data);
    }
    if (data.type === 'restore-scroll' && Number.isFinite(data.x) && Number.isFinite(data.y))
      window.scrollTo(Math.max(0, data.x), Math.max(0, data.y));
  });
  var queued = false;
  window.addEventListener(
    'scroll',
    function () {
      if (queued) return;
      queued = true;
      requestAnimationFrame(function () {
        queued = false;
        parent.postMessage(
          { source: 'ws-preview', type: 'scroll-position', x: window.scrollX, y: window.scrollY },
          '*'
        );
      });
    },
    { passive: true }
  );
})();
