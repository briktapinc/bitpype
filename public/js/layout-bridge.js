'use strict';

/* Batch 147 — layout-editor canvas bridge.
 *
 * Runs inside the portal's layout canvas (a srcdoc preview whose
 * section roots carry data-bp-layout-section + data-ws-section-index).
 * It owns NO page model: it decorates section roots with a floating
 * toolbar, translates clicks / drag gestures into postMessage actions
 * for the portal, and applies the portal's highlight + live style
 * patches. The portal keeps the section list, re-renders this canvas
 * after every model change, and persists only on explicit Save.
 * Original code in the platform's preview-bridge pattern — the
 * interaction model (selectable blocks, toolbars, drag reorder) is
 * the classic page-builder one; nothing here is copied from any
 * external editor.
 */
(function () {
  var sections = []; // [{ el, index }]
  var config = {}; // index -> descriptor from the portal
  var selected = -1;
  var toolbar = null;
  var dragFrom = -1;

  function post(action, payload) {
    var msg = { source: 'bp-layout-bridge', action: action };
    if (payload) {
      for (var k in payload) msg[k] = payload[k];
    }
    try {
      window.parent.postMessage(msg, '*');
    } catch (err) {
      /* parent gone — canvas is inert */
    }
  }

  function collect() {
    sections = [];
    var nodes = document.querySelectorAll('[data-bp-layout-section]');
    for (var i = 0; i < nodes.length; i++) {
      var idx = Number(nodes[i].getAttribute('data-ws-section-index'));
      if (Number.isInteger(idx)) sections.push({ el: nodes[i], index: idx });
      // Batch 148: a mobile-hidden section stays visible in the canvas
      // (engine CSS overrides the hide rule here) but is dimmed, so the
      // owner always knows it disappears on phones.
      if (nodes[i].classList && nodes[i].classList.contains('bp-sec-nomobile')) {
        nodes[i].classList.add('bp-layout-dim');
      }
    }
  }

  /* The canvas document only carries the page's layout-knob rule block
   * when a knob was already set at render time; if the owner flips a
   * section to full-width live, mirror the one rule the renderer would
   * emit so the canvas reflects it immediately. Canvas-only DOM — it is
   * never saved or exported. */
  function ensureCanvasKnobCss() {
    if (document.querySelector('style[data-bp-layout-canvas]')) return;
    var st = document.createElement('style');
    st.setAttribute('data-bp-layout-canvas', '1');
    st.textContent = '.bp-sec-full>.container{max-width:none}';
    document.head.appendChild(st);
  }

  function makeChip(text) {
    var chip = document.createElement('span');
    chip.className = 'bp-layout-chip';
    chip.textContent = text;
    return chip;
  }

  function entryFor(index) {
    for (var i = 0; i < sections.length; i++) if (sections[i].index === index) return sections[i];
    return null;
  }

  function makeButton(text, title, action, index, disabled) {
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.title = title;
    b.disabled = !!disabled;
    b.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      post(action, { index: index });
    });
    return b;
  }

  function ensureToolbar() {
    if (toolbar) return toolbar;
    toolbar = document.createElement('div');
    toolbar.className = 'bp-layout-toolbar';
    toolbar.setAttribute('role', 'toolbar');
    toolbar.setAttribute('aria-label', 'Section tools');
    document.body.appendChild(toolbar);
    return toolbar;
  }

  function hideToolbar() {
    if (toolbar) toolbar.style.display = 'none';
  }

  function showToolbar(index) {
    var entry = entryFor(index);
    if (!entry) return hideToolbar();
    var d = config[index] || {};
    var bar = ensureToolbar();
    while (bar.firstChild) bar.removeChild(bar.firstChild);
    var label = document.createElement('span');
    label.className = 'bp-lt-label';
    label.textContent = d.label || 'Section';
    bar.appendChild(label);
    // Batch 148: knob badges — the owner sees a section's width mode and
    // mobile visibility right on its toolbar, never as a surprise.
    var isFull = d.width === 'full' || entry.el.classList.contains('bp-sec-full');
    var isHiddenMobile = d.hideOnMobile === true || entry.el.classList.contains('bp-sec-nomobile');
    if (isFull) bar.appendChild(makeChip('Full width'));
    if (isHiddenMobile) bar.appendChild(makeChip('Hidden on mobile'));
    if (d.movable) {
      var handle = makeButton('⠿', 'Drag to reorder', 'noop', index, false);
      handle.className = 'bp-lt-handle';
      handle.title = 'Drag to reorder';
      handle.addEventListener('pointerdown', function (ev) {
        ev.preventDefault();
        startDrag(entry, ev);
      });
      bar.appendChild(handle);
      bar.appendChild(makeButton('↑', 'Move up', 'moveUp', index, false));
      bar.appendChild(makeButton('↓', 'Move down', 'moveDown', index, false));
    }
    if (d.canDuplicate) {
      bar.appendChild(makeButton('⧉', 'Duplicate section', 'duplicate', index, false));
    }
    if (d.canDelete) {
      bar.appendChild(makeButton('✕', 'Delete section', 'delete', index, false));
    }
    bar.appendChild(makeButton('Edit', d.chrome ? 'Edit' : 'Edit section', 'edit', index, false));
    bar.style.display = 'flex';
    var rect = entry.el.getBoundingClientRect();
    var top = rect.top + window.scrollY - bar.offsetHeight - 8;
    if (top < window.scrollY + 4) top = rect.top + window.scrollY + 8;
    bar.style.top = top + 'px';
    bar.style.left = Math.max(4, rect.left + window.scrollX + 8) + 'px';
  }

  function select(index, notify) {
    selected = index;
    for (var i = 0; i < sections.length; i++) {
      if (sections[i].index === index) sections[i].el.setAttribute('data-bp-layout-selected', '1');
      else sections[i].el.removeAttribute('data-bp-layout-selected');
    }
    if (index >= 0) showToolbar(index);
    else hideToolbar();
    if (notify) post('select', { index: index });
  }

  /* ---- drag & drop ------------------------------------------------ */
  function startDrag(entry, ev) {
    dragFrom = entry.index;
    entry.el.setAttribute('draggable', 'true');
    var cleanup = function () {
      entry.el.removeAttribute('draggable');
      window.removeEventListener('pointerup', cleanup);
    };
    window.addEventListener('pointerup', cleanup);
  }

  function clearDropMarks() {
    for (var i = 0; i < sections.length; i++) sections[i].el.removeAttribute('data-bp-layout-drop');
  }

  function bindDrag() {
    document.addEventListener('dragstart', function (ev) {
      var t = ev.target;
      if (!t || !t.hasAttribute || !t.hasAttribute('data-bp-layout-section')) return;
      var idx = Number(t.getAttribute('data-ws-section-index'));
      if (Number.isInteger(idx)) dragFrom = idx;
      if (ev.dataTransfer) {
        ev.dataTransfer.effectAllowed = 'move';
        try {
          ev.dataTransfer.setData('text/plain', 'bp-layout-section');
        } catch (err) {
          /* some engines require no data; ignore */
        }
      }
    });
    document.addEventListener('dragover', function (ev) {
      if (dragFrom < 0) return;
      var entry = null;
      var node = ev.target;
      while (node && node !== document.body) {
        if (node.hasAttribute && node.hasAttribute('data-bp-layout-section')) {
          entry = entryFor(Number(node.getAttribute('data-ws-section-index')));
          break;
        }
        node = node.parentNode;
      }
      if (!entry) return;
      ev.preventDefault();
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
      clearDropMarks();
      var rect = entry.el.getBoundingClientRect();
      var after = ev.clientY > rect.top + rect.height / 2;
      entry.el.setAttribute('data-bp-layout-drop', after ? 'after' : 'before');
      entry.el.setAttribute('data-bp-layout-drop-side', after ? 'after' : 'before');
    });
    document.addEventListener('drop', function (ev) {
      if (dragFrom < 0) return;
      var node = ev.target;
      var entry = null;
      while (node && node !== document.body) {
        if (node.hasAttribute && node.hasAttribute('data-bp-layout-section')) {
          entry = entryFor(Number(node.getAttribute('data-ws-section-index')));
          break;
        }
        node = node.parentNode;
      }
      ev.preventDefault();
      var from = dragFrom;
      dragFrom = -1;
      clearDropMarks();
      if (!entry || entry.index === from) return;
      var after = entry.el.getAttribute('data-bp-layout-drop-side') === 'after';
      entry.el.removeAttribute('data-bp-layout-drop-side');
      var t = entry.index;
      // Translate the visual drop into the model's absolute-index
      // target (see moveSectionToIndex in src/siteStructure.js).
      var toIndex;
      if (!after) toIndex = from < t ? t - 1 : t;
      else toIndex = from < t ? t : t + 1;
      post('move', { from: from, toIndex: toIndex });
    });
    document.addEventListener('dragend', function () {
      dragFrom = -1;
      clearDropMarks();
    });
  }

  /* ---- selection clicks ------------------------------------------- */
  function bindClicks() {
    document.addEventListener(
      'click',
      function (ev) {
        var node = ev.target;
        if (toolbar && toolbar.contains(node)) return;
        while (node && node !== document.body) {
          if (node.hasAttribute && node.hasAttribute('data-bp-layout-section')) {
            var idx = Number(node.getAttribute('data-ws-section-index'));
            // The canvas is an editor, not the live site: clicks
            // select the section instead of navigating/firing.
            ev.preventDefault();
            ev.stopPropagation();
            if (Number.isInteger(idx)) select(idx, true);
            return;
          }
          node = node.parentNode;
        }
        select(-1, true);
      },
      true
    );
    window.addEventListener('scroll', function () {
      if (selected >= 0) showToolbar(selected);
    });
    window.addEventListener('resize', function () {
      if (selected >= 0) showToolbar(selected);
    });
  }

  /* ---- host messages ---------------------------------------------- */
  window.addEventListener('message', function (ev) {
    var d = ev.data;
    if (!d || d.source !== 'bp-layout-host') return;
    if (d.action === 'config') {
      config = {};
      (d.sections || []).forEach(function (s) {
        if (s && Number.isInteger(s.index)) config[s.index] = s;
      });
      if (selected >= 0) showToolbar(selected);
    } else if (d.action === 'highlight') {
      var entry = entryFor(Number(d.index));
      select(Number(d.index), false);
      if (entry) entry.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } else if (d.action === 'style') {
      var target = entryFor(Number(d.index));
      if (target) {
        if (typeof d.background === 'string') target.el.style.backgroundColor = d.background;
        if (d.paddingPx === '') {
          target.el.style.paddingTop = '';
          target.el.style.paddingBottom = '';
        } else if (d.paddingPx != null) {
          target.el.style.paddingTop = Number(d.paddingPx) + 'px';
          target.el.style.paddingBottom = Number(d.paddingPx) + 'px';
        }
        // Batch 148: live knob reflection — classes drive both the
        // canvas look (per-page layout CSS + canvas overrides) and the
        // toolbar badges.
        if (typeof d.width === 'string') {
          if (d.width === 'full') {
            ensureCanvasKnobCss();
            target.el.classList.add('bp-sec-full');
          } else target.el.classList.remove('bp-sec-full');
        }
        if (typeof d.hideOnMobile === 'boolean') {
          target.el.classList.toggle('bp-sec-nomobile', d.hideOnMobile);
          target.el.classList.toggle('bp-layout-dim', d.hideOnMobile);
        }
        if (typeof d.width === 'string' || typeof d.hideOnMobile === 'boolean') {
          if (selected === Number(d.index)) showToolbar(selected);
        }
      }
    }
  });

  function init() {
    collect();
    bindClicks();
    bindDrag();
    post('ready', {});
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
