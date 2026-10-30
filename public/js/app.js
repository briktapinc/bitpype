'use strict';

/* Website Scout web UI — hash router, Electron-parity pages.
 * All data via window.ScoutApi (public/js/api.js). Always esc() user content before innerHTML. */

const api = window.ScoutApi;
const authGate = document.getElementById('auth-gate');
const shell = document.getElementById('app-shell');
const view = document.getElementById('view');
const wsSelect = document.getElementById('workspace-select');
const autoEl = document.getElementById('shell-automation');
const topTitle = document.getElementById('top-title');
const toastHost = document.getElementById('toast-host');

const ROUTES = [
  'dashboard',
  'leads',
  'websites',
  'archives',
  'domains',
  'design',
  'social',
  'outreach',
  'pipeline',
  'forms',
  'leadscout',
  'bookings',
  'shop',
  'calls',
  'seo',
  'rentals',
  'modules',
  'courses',
  'analytics',
  'jobs',
  'mcp',
  'settings',
  'billing',
  'finance',
  'admin',
];
const ROUTE_LABELS = {
  dashboard: 'Dashboard',
  leads: 'Leads',
  websites: 'Websites',
  archives: 'Archives',
  design: 'Design',
  social: 'Social',
  outreach: 'Outreach',
  pipeline: 'Pipeline',
  forms: 'Forms',
  leadscout: 'LeadScout',
  bookings: 'Bookings',
  shop: 'Shop',
  memberships: 'Memberships',
  calls: 'Calls',
  seo: 'SEO',
  rentals: 'Rentals',
  modules: 'Modules',
  courses: 'Courses',
  analytics: 'Analytics',
  jobs: 'Jobs',
  mcp: 'MCP',
  settings: 'Settings',
  billing: 'Billing',
  finance: 'Finance',
  admin: 'Admin',
  'mailing-list': 'Mailing list',
};
let currentUserIsSuperAdmin = false;
let currentUserIsPartner = false;
let currentUserId = null;
let requireSubscription = false;
let userSubscribed = true;
let productAccess = true;
let subscriptionStatus = 'none';
const LEAD_STATUSES = [
  'new',
  'researching',
  'qualified',
  'building',
  'qa_pending',
  'ready',
  'outreach_pending',
  'contacted',
  'engaged',
  'claimed',
  'trial',
  'customer',
  'lost',
];
const DESIGN_STATUSES = ['draft', 'waiting_on_agent', 'questions_pending', 'in_progress', 'delivered'];
const DESIGN_TYPES = ['website', 'logo', 'social', 'flyer', 'brand', 'other'];
const INTENT_EVENTS = [
  'email.opened',
  'email.clicked',
  'preview.viewed',
  'preview.viewed_twice',
  'editor.opened',
  'text.changed',
  'logo.uploaded',
  'site.claimed',
  'pricing.viewed',
  'domain.searched',
  'domain.purchased',
  'trial.activated',
];
const CLAIM_CLASSES = ['VERIFIED', 'AI_COPY', 'OWNER_PROVIDED', 'UNKNOWN'];
const SUPPRESSION_REASONS = ['do-not-contact', 'unsubscribed', 'bounced', 'complaint'];
const MODEL_TASKS = ['research', 'generation', 'scoring', 'email', 'qa', 'editor', 'followup', 'image', 'vision'];

let automationPaused = false;
let leadsReload = null;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
const pretty = (s) => String(s == null ? '' : s).replace(/_/g, ' ');
const fmtDate = (s) =>
  String(s || '')
    .slice(0, 16)
    .replace('T', ' ');
const money = (n) => '$' + (Number.isFinite(Number(n)) ? Number(n).toFixed(2) : '0.00');
const statusBadge = (s) => `<span class="badge status-${esc(s)}">${esc(pretty(s) || '—')}</span>`;

function scorePill(score) {
  const n = Number(score) || 0;
  const band = n >= 70 ? 'hot' : n >= 50 ? 'warm' : n > 0 ? 'cool' : 'none';
  return `<span class="score-pill score-${band}" title="Lead score, 0–100 — Qualified at 50+, Hot at 70+ (Settings → Footer &amp; scoring)">${esc(n)}</span>`;
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function parseJson(v, fallback) {
  if (v == null || v === '') return fallback;
  if (typeof v === 'object') return v;
  try {
    return JSON.parse(v);
  } catch {
    return fallback;
  }
}

function toast(text, kind) {
  if (String(text) === 'AUTH_REQUIRED') return;
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.textContent = String(text);
  toastHost.appendChild(el);
  setTimeout(() => el.remove(), kind === 'err' ? 7000 : 3800);
}

function setMsg(el, text, kind) {
  if (!el) return;
  el.textContent = text || '';
  el.className = 'msg' + (kind ? ' ' + kind : '');
}

function optionList(values, selected, labelFn) {
  return values
    .map(
      (v) =>
        `<option value="${esc(v)}" ${String(v) === String(selected) ? 'selected' : ''}>${esc(labelFn ? labelFn(v) : pretty(v))}</option>`
    )
    .join('');
}

function kv(k, v, raw) {
  const val = v == null || v === '' ? '—' : raw ? v : esc(v);
  return `<div class="kv"><span class="k">${esc(k)}</span><span>${val}</span></div>`;
}

function jsonPre(obj) {
  return `<pre class="out">${esc(JSON.stringify(obj, null, 2))}</pre>`;
}

function formObject(form) {
  const out = {};
  new FormData(form).forEach((v, k) => {
    out[k] = typeof v === 'string' ? v.trim() : v;
  });
  return out;
}

function dropEmpty(obj) {
  const out = {};
  Object.keys(obj).forEach((k) => {
    if (obj[k] !== '' && obj[k] != null) out[k] = obj[k];
  });
  return out;
}

/**
 * Normalize list payloads from /api/v1. Accepts a bare array, or an object that
 * may nest the array under common keys (and one level of accidental double-wrap).
 */
function asList(value, keys) {
  const prefer = keys || [
    'rows',
    'jobs',
    'sites',
    'leads',
    'templates',
    'tokens',
    'items',
    'requests',
    'versions',
    'prompts',
  ];
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  for (let i = 0; i < prefer.length; i++) {
    const k = prefer[i];
    if (Array.isArray(value[k])) return value[k];
  }
  for (let i = 0; i < prefer.length; i++) {
    const inner = value[prefer[i]];
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
      const nested = asList(inner, prefer);
      if (nested.length || Array.isArray(inner.rows) || Array.isArray(inner.jobs)) return nested;
    }
  }
  return [];
}

function dataOf(res) {
  return res && res.data != null ? res.data : {};
}

/**
 * Shared list-loading treatment (Batch 2 gave Leads a timeout + Retry;
 * this is the same pattern for every staff list): race fetches against a
 * 15s timeout so a stalled request surfaces an error instead of an
 * endless "Loading…".
 */
function withLoadTimeout(p, ms = 15000) {
  return Promise.race([
    p,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timed out after 15s')), ms)),
  ]);
}

function loadRowHtml(colspan, label) {
  return `<tr><td colspan="${colspan}" class="empty"><span class="load-spin" aria-hidden="true"></span> ${esc(label || 'Loading…')}</td></tr>`;
}

function loadErrorRowHtml(colspan, act, message) {
  return `<tr><td colspan="${colspan}" class="empty">Could not load (${esc(message || 'request failed')}). <button class="btn small" data-act="${act}">Retry</button></td></tr>`;
}

function loadErrorCardHtml(message) {
  return `<div class="card error-card"><h2>Could not load</h2><p>${esc(message || 'Request failed')}</p><p><button class="btn" data-act="page-retry">Retry</button></p></div>`;
}

// Batch 54: overview payloads carry `warnings` when a sub-builder failed
// and its section fell back to empty/default data (the server logs the
// real error). Render them as a visible notice — partial data must
// never present itself as complete.
function warningsBannerHtml(warnings) {
  const list = Array.isArray(warnings) ? warnings.filter((w) => w && w.message) : [];
  if (!list.length) return '';
  const items = list.map((w) => `<li>${esc(w.message)}</li>`).join('');
  return `<div class="alert warn" role="alert"><strong>Some data couldn't be loaded — this page may be incomplete.</strong><ul>${items}</ul></div>`;
}

function wirePageRetry(retryFn) {
  const b = view.querySelector('[data-act="page-retry"]');
  if (b) b.addEventListener('click', () => retryFn());
}

/** Truncate at a word boundary with an ellipsis (never mid-word, never silent). */
function truncateWords(text, max) {
  const t = String(text || '');
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return (sp > 12 ? cut.slice(0, sp) : cut) + '…';
}

/** Drop repeated rows for the same id (selector lists must never show one lead twice). */
function dedupeById(rows) {
  const seen = new Set();
  return (rows || []).filter((r) => {
    const k = String(r && r.id);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function pager(host, { page, pages, total }, onPage) {
  host.innerHTML = `<button class="btn small" data-p="prev" ${page <= 1 ? 'disabled' : ''}>Prev</button>
    <span>Page ${page} of ${Math.max(1, pages || 1)} (${total || 0} total)</span>
    <button class="btn small" data-p="next" ${page >= (pages || 1) ? 'disabled' : ''}>Next</button>`;
  host.onclick = (e) => {
    const b = e.target.closest('[data-p]');
    if (!b || b.disabled) return;
    onPage(b.dataset.p === 'prev' ? page - 1 : page + 1);
  };
}

function isAuthRequired(err) {
  return !!(
    err &&
    err.status === 401 &&
    (err.code === 'AUTH_REQUIRED' ||
      (err.data && err.data.error === 'AUTH_REQUIRED') ||
      err.message === 'AUTH_REQUIRED')
  );
}

async function safeRun(btn, fn) {
  const isBtn = btn && btn.tagName === 'BUTTON';
  if (isBtn) btn.disabled = true;
  try {
    return await fn();
  } catch (err) {
    if (isAuthRequired(err)) {
      goToLogin();
      return undefined;
    }
    toast(errText(err), 'err');
    return undefined;
  } finally {
    if (isBtn && btn.isConnected) btn.disabled = false;
  }
}

// Double-submit guard for forms (port of audit A3): assigns
// form.onsubmit to a wrapper that ignores repeat submits while one
// is in flight and disables the form's submit buttons meanwhile.
function guardSubmit(form, handler) {
  if (!form) return;
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (form.dataset.submitting === '1') return;
    form.dataset.submitting = '1';
    const btns = form.querySelectorAll('button[type="submit"], input[type="submit"]');
    btns.forEach((b) => (b.disabled = true));
    try {
      await handler(e);
    } finally {
      delete form.dataset.submitting;
      btns.forEach((b) => (b.disabled = false));
    }
  };
}

// Stale-response gate for list loaders (port of audit B1): each call
// returns a check; only the most recent call's check still passes
// after its await, so out-of-order responses can't repaint old data.
function latestGate() {
  let gen = 0;
  return () => {
    const mine = ++gen;
    return () => mine === gen;
  };
}

/** data-act delegation: handlers[act](element, event). */
function delegate(root, handlers) {
  root.onclick = (e) => {
    const t = e.target.closest('[data-act]');
    if (!t || !root.contains(t)) return;
    const fn = handlers[t.dataset.act];
    if (!fn) return;
    e.preventDefault();
    safeRun(t, () => fn(t, e));
  };
}

function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).then(
      () => toast('Copied', 'ok'),
      () => toast('Copy failed', 'err')
    );
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    toast('Copied', 'ok');
  } catch {
    toast('Copy failed', 'err');
  }
  ta.remove();
  return Promise.resolve();
}

const overlays = new Set();

function openModal({ title, body, wide, buttons }) {
  const bd = document.createElement('div');
  bd.className = 'modal-backdrop';
  bd.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
    <h2>${esc(title)}</h2><div class="modal-body">${body || ''}</div><div class="modal-actions"></div></div>`;
  const onKey = (e) => {
    if (e.key === 'Escape') m.close();
  };
  const m = {
    el: bd.firstElementChild,
    body: $('.modal-body', bd),
    close() {
      bd.remove();
      document.removeEventListener('keydown', onKey);
      overlays.delete(m);
    },
  };
  overlays.add(m);
  const actions = $('.modal-actions', bd);
  (buttons || [{ label: 'Close' }]).forEach((b) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn ' + (b.cls || '');
    btn.textContent = b.label;
    btn.onclick = () => (b.onClick ? safeRun(btn, () => b.onClick(m, btn)) : m.close());
    actions.appendChild(btn);
  });
  bd.addEventListener('mousedown', (e) => {
    if (e.target === bd) m.close();
  });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(bd);
  return m;
}

/* Batch 78: the slide-over drawer (openDrawer) is GONE — lead detail,
   form submissions and LeadScout contacts are full routed pages now
   (#/leads/<id>, #/forms/<id>, #/leadscout/<id>). */

/** Single-lead typeahead picker. Returns { get(), set(lead), clear() }. */
function mountLeadPicker(host, opts) {
  const o = opts || {};
  let current = null;
  let lastRows = [];
  host.classList.add('lead-picker');
  host.innerHTML = `<input type="search" class="lp-input" placeholder="${esc(o.placeholder || 'Search by name, business, or email…')}" autocomplete="off" />
    <ul class="lead-picker-results hidden"></ul><div class="lead-picker-selected hidden"></div>`;
  const input = $('.lp-input', host);
  const ul = $('.lead-picker-results', host);
  const selBox = $('.lead-picker-selected', host);

  function leadTitle(l) {
    return (l && (l.business_name || l.name)) || 'Lead';
  }
  function leadMeta(l) {
    if (!l) return '';
    return [l.email, l.city, l.phone, l.category].filter(Boolean).join(' · ');
  }
  function normalizeLead(l) {
    if (!l) return null;
    return Object.assign({}, l, {
      id: Number(l.id),
      name: leadTitle(l),
      business_name: l.business_name || l.name || null,
      meta: leadMeta(l),
    });
  }

  function renderSelected() {
    if (!current) {
      selBox.classList.add('hidden');
      input.classList.remove('hidden');
      return;
    }
    selBox.classList.remove('hidden');
    input.classList.add('hidden');
    const meta = leadMeta(current) || current.meta || '';
    selBox.innerHTML = `<span class="lp-selected-copy"><b>${esc(leadTitle(current))}</b> <span class="hint">#${esc(current.id)}</span>
      ${meta ? `<div class="hint">${esc(meta)}</div>` : ''}</span>
      <button type="button" class="btn small clear">Clear</button>`;
    $('.clear', selBox).onclick = () => {
      current = null;
      renderSelected();
      if (o.onChange) o.onChange(null);
    };
  }

  const search = debounce(async () => {
    const q = input.value.trim();
    if (!q) {
      ul.classList.add('hidden');
      lastRows = [];
      return;
    }
    try {
      const r = await api.leads({ q, pageSize: 8 });
      const rows = (r.data && r.data.leads) || [];
      lastRows = rows;
      let html = '';
      if (/^\d+$/.test(q)) {
        html += `<li><button type="button" data-id="${esc(q)}" data-fetch="1">Use lead id <b>#${esc(q)}</b></button></li>`;
      }
      html += rows
        .map((l) => {
          const meta = leadMeta(l);
          return `<li><button type="button" data-id="${l.id}"><b>${esc(l.business_name)}</b> <span class="hint">#${l.id}${meta ? ` · ${esc(meta)}` : ''}</span></button></li>`;
        })
        .join('');
      ul.innerHTML = html || '<li class="empty">No matches</li>';
      ul.classList.remove('hidden');
    } catch (e) {
      toast(errText(e), 'err');
    }
  }, 250);

  input.addEventListener('input', search);
  ul.addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-id]');
    if (!b) return;
    const id = Number(b.dataset.id);
    if (!Number.isInteger(id) || id <= 0) return;
    let next = lastRows.find((r) => Number(r.id) === id) || null;
    if (!next || b.dataset.fetch === '1') {
      try {
        const r = await api.leadGet(id);
        next = (r.data && r.data.lead) || r.data || next;
      } catch (err) {
        if (!next) {
          toast(errText(err), 'err');
          return;
        }
      }
    }
    current = normalizeLead(next || { id, name: `Lead #${id}` });
    ul.classList.add('hidden');
    input.value = '';
    renderSelected();
    if (o.onChange) o.onChange(current);
  });
  return {
    get: () => current,
    set(lead) {
      current = normalizeLead(lead);
      renderSelected();
    },
    clear() {
      current = null;
      renderSelected();
      if (o.onChange) o.onChange(null);
    },
  };
}

/** Iframe preview with page select + desktop/mobile toggle. renderFn(slug) -> api envelope with data.html. */
function mountPreview(host, renderFn, hooks) {
  host.innerHTML = `<div class="preview-toolbar">
    <select class="pv-page" aria-label="Preview page"><option value="">All pages</option></select>
    <div class="pv-actions">
      <div class="pv-device" role="group" aria-label="Preview size">
        <button type="button" class="btn small primary pv-desktop">Desktop</button>
        <button type="button" class="btn small pv-mobile">Mobile</button>
      </div>
      <button type="button" class="btn small pv-refresh">Refresh</button>
      <span class="msg pv-msg"></span>
    </div>
  </div>
  <div class="preview-frame desktop"><iframe class="pv-frame" sandbox="allow-scripts allow-forms" title="Site preview"></iframe></div>`;
  const sel = $('.pv-page', host);
  const frame = $('.pv-frame', host);
  const box = $('.preview-frame', host);
  const msg = $('.pv-msg', host);
  let populated = false;

  function matchPageOption(slugOrFile) {
    const want = String(slugOrFile || '')
      .trim()
      .replace(/^\//, '')
      .replace(/\.html$/i, '');
    if (!want || want === 'index' || want === 'home') {
      const home = [...sel.options].find(
        (o) => o.value && (o.value === '/' || o.value === 'home' || o.value === 'index')
      );
      return home || null;
    }
    return (
      [...sel.options].find((o) => {
        if (!o.value) return false;
        const v = String(o.value)
          .replace(/^\//, '')
          .replace(/\.html$/i, '');
        return v === want || o.value === slugOrFile;
      }) || null
    );
  }

  async function load() {
    setMsg(msg, 'Rendering…');
    try {
      const r = await renderFn(sel.value || undefined);
      frame.srcdoc = (r.data && r.data.html) || '<p style="font-family:sans-serif;padding:1rem">Empty render.</p>';
      const pages = (r.data && r.data.pages) || [];
      if (!populated && pages.length) {
        populated = true;
        sel.innerHTML =
          '<option value="">All pages</option>' +
          pages.map((p) => `<option value="${esc(p.slug)}">${esc(p.title || p.slug)}</option>`).join('');
      }
      setMsg(msg, '');
    } catch (e) {
      setMsg(msg, errText(e), 'err');
    }
  }
  sel.onchange = load;
  $('.pv-refresh', host).onclick = load;
  $('.pv-desktop', host).onclick = () => {
    box.className = 'preview-frame desktop';
    $('.pv-desktop', host).classList.add('primary');
    $('.pv-mobile', host).classList.remove('primary');
  };
  $('.pv-mobile', host).onclick = () => {
    box.className = 'preview-frame mobile';
    $('.pv-mobile', host).classList.add('primary');
    $('.pv-desktop', host).classList.remove('primary');
  };
  // In-preview nav posts here when a relative link has no #anchor in the stacked doc.
  const onPreviewNav = (ev) => {
    if (!ev.data || ev.data.source !== 'ws-preview-nav') return;
    if (ev.source !== frame.contentWindow || ev.origin !== 'null') return;
    if (ev.data.external) return;
    const opt = matchPageOption(ev.data.slug || ev.data.file || '');
    if (!opt || opt.value === sel.value) return;
    sel.value = opt.value;
    load();
  };
  window.addEventListener('message', onPreviewNav);
  const onPreviewMsg = (ev) => {
    if (!frame.contentWindow || ev.source !== frame.contentWindow || ev.origin !== 'null') return;
    if (
      !ev.data ||
      ev.data.source !== 'ws-preview' ||
      !['ready', 'element-select', 'element-font'].includes(ev.data.type)
    )
      return;
    if (hooks && typeof hooks.onPreview === 'function') hooks.onPreview(ev.data);
  };
  window.addEventListener('message', onPreviewMsg);
  load();
  return {
    reload: load,
    post(msg) {
      if (frame.contentWindow) frame.contentWindow.postMessage(msg, '*');
    },
    destroy() {
      window.removeEventListener('message', onPreviewNav);
      window.removeEventListener('message', onPreviewMsg);
    },
  };
}

function mergePageInnerHtml(original, inner) {
  const src = String(original || '');
  const body = String(inner || '');
  const split = src.match(/(<body\b[^>]*>)([\s\S]*)(<\/body\s*>)/i);
  if (split) return src.replace(split[0], split[1] + body + split[3]);
  return body;
}

/**
 * Sitewide Google fonts plus a per-element font, shared by design and website screens.
 * save(pages, theme) persists. preview is a mountPreview handle rendered with editable:true.
 */
function bindFontToolbar(prefix, preview, getPages, getTheme, save) {
  const fonts = window.WsFonts;
  if (!fonts) return;
  if (!document.getElementById('ws-font-catalog')) {
    const link = document.createElement('link');
    link.id = 'ws-font-catalog';
    link.rel = 'stylesheet';
    link.href = fonts.catalogHref();
    document.head.appendChild(link);
  }
  const theme = getTheme() || {};
  fonts.fillSelect($('#' + prefix + '-font-body'), theme.font || '', { defaultLabel: 'System' });
  fonts.fillSelect($('#' + prefix + '-font-heading'), theme.headingFont || '', { defaultLabel: 'Same as site font' });
  const elementSel = $('#' + prefix + '-font-element');
  fonts.fillSelect(elementSel, '', { defaultLabel: 'Site default' });
  if (elementSel) elementSel.disabled = true;
  const msg = $('#' + prefix + '-font-msg');
  let styling = false;
  let selectedId = '';

  function applyLive() {
    const picked = readFonts();
    if (preview)
      preview.post({
        source: 'ws-portal',
        type: 'site-fonts',
        ...picked,
        fontHref: fonts.hrefFor([fonts.matchName(picked.font), fonts.matchName(picked.headingFont)].filter(Boolean)),
      });
  }

  function readFonts() {
    const body = $('#' + prefix + '-font-body');
    const head = $('#' + prefix + '-font-heading');
    let font = theme.font || fonts.SYSTEM;
    let headingFont = theme.headingFont || '';
    if (body && body.value && body.value !== '__custom__') font = fonts.stackFor(body.value);
    else if (body && body.value === '') font = fonts.SYSTEM;
    if (head && head.value && head.value !== '__custom__') headingFont = fonts.stackFor(head.value);
    else if (head && head.value === '') headingFont = '';
    return { font, headingFont };
  }

  async function persist(pages, nextTheme, okText) {
    setMsg(msg, 'Saving fonts…');
    try {
      await save(pages, nextTheme);
      Object.assign(theme, nextTheme);
      setMsg(msg, okText || 'Fonts saved.', 'ok');
      if (preview) preview.reload();
    } catch (e) {
      setMsg(msg, errText(e), 'err');
    }
  }

  const saveBtn = $('#' + prefix + '-font-save');
  if (saveBtn) {
    saveBtn.onclick = () => {
      const picked = readFonts();
      const next = Object.assign({}, getTheme() || {}, picked);
      persist(getPages(), next, 'Site fonts saved.');
    };
  }
  ['body', 'heading'].forEach((which) => {
    const sel = $('#' + prefix + '-font-' + which);
    if (sel) sel.addEventListener('change', () => applyLive());
  });
  const editBtn = $('#' + prefix + '-font-edit');
  if (editBtn) {
    editBtn.onclick = () => {
      styling = !styling;
      editBtn.classList.toggle('primary', styling);
      editBtn.textContent = styling ? 'Done styling' : 'Style an element';
      if (elementSel) elementSel.disabled = !styling || !selectedId;
      if (preview) preview.post({ source: 'ws-portal', type: 'edit-mode', on: styling, fontsOnly: true });
      setMsg(msg, styling ? 'Click text in the preview, then choose its font.' : '');
    };
  }
  if (elementSel) {
    elementSel.addEventListener('change', () => {
      if (!preview) return;
      const name = fonts.selectedName(elementSel);

      preview.post({
        source: 'ws-portal',
        type: 'set-font',
        fontHref: name ? fonts.hrefFor([name]) : '',
        family: name ? fonts.stackFor(name) : '',
        name: name || '',
      });
    });
  }

  return {
    onPreview(data) {
      if (!data) return;
      if (data.type === 'ready') {
        applyLive();
        if (styling && preview) preview.post({ source: 'ws-portal', type: 'edit-mode', on: true, fontsOnly: true });
      }
      if (data.type === 'element-select') {
        selectedId = String(data.id || '');
        if (elementSel) {
          elementSel.disabled = !styling || !selectedId;
          elementSel.value = fonts.matchName(data.fontFamily || '') || '';
        }
      }
      if (data.type === 'element-font') {
        if (
          !styling ||
          !selectedId ||
          data.id !== selectedId ||
          (data.html && (typeof data.html !== 'string' || data.html.length > 800000))
        )
          return;
        const id = String(data.id || '');
        const pages = getPages();
        const nextTheme = Object.assign({}, getTheme() || {});
        if (/^html:\d+:\d+$/.test(id) && data.html) {
          const pi = Number(data.pageIndex) || 0;
          const page = pages[pi];
          if (!page || typeof page.html !== 'string') {
            setMsg(msg, 'This page is not freeform HTML.', 'err');
            return;
          }
          page.html = mergePageInnerHtml(page.html, data.html);
          persist(pages, nextTheme, 'Element font saved.');
          return;
        }
        if (/^\d+:\d+:/.test(id)) {
          const map = Object.assign({}, nextTheme.elementFonts || {});
          if (!data.font) delete map[id];
          else map[id] = data.font;
          nextTheme.elementFonts = map;
          persist(pages, nextTheme, 'Element font saved.');
        }
      }
    },
  };
}

/* ------------------------------------------------------------------ */
/* Auth + shell                                                        */
/* ------------------------------------------------------------------ */

const PUBLIC_ROUTES = new Set(['login', 'register', 'forgot', 'reset', 'invite']);
let signedIn = false;
// Batch 53: an invite token that arrived with a sign-in/register submit
// is parked here while the second-factor challenge runs (register now
// parks the same MFA challenge as login — review E-4), then accepted by
// renderAuthMfa's finishWith once a real session exists.
let pendingInviteToken = '';
// Batch 61: a paid plan picked at registration creates its Stripe
// checkout up front; the URL rides through the MFA detour (like the
// invite token) and the browser goes there once enrollment completes.
let pendingSignupCheckoutUrl = '';

// Registration visibility for the auth screen (Admin Settings →
// General → registration.open). Defaults to visible; loadRegistrationOpen()
// refreshes it from the public /auth/config payload at boot. Failures keep
// the default so a config hiccup can never break the sign-in screen.
let registrationOpen = true;
async function loadRegistrationOpen() {
  try {
    const res = await api.authConfig();
    if (res && res.data && typeof res.data.registrationOpen === 'boolean') {
      registrationOpen = res.data.registrationOpen;
    }
  } catch {
    /* keep the default: registration visible */
  }
}

function authHashMode() {
  const { route, param } = parseHash();
  if (route === 'reset' && param) return { mode: 'reset', token: param, inviteToken: '' };
  if (route === 'invite' && param) return { mode: 'login', token: '', inviteToken: param };
  if (route === 'forgot') return { mode: 'forgot', token: '', inviteToken: '' };
  if (route === 'register') return { mode: 'register', token: '', inviteToken: '' };
  return { mode: 'login', token: '', inviteToken: '' };
}

function rememberReturnHash() {
  const hash = window.location.hash || '';
  const m = hash.match(/^#\/([a-z-]+)/);
  if (!m || PUBLIC_ROUTES.has(m[1])) return;
  try {
    sessionStorage.setItem('scout.returnHash', hash);
  } catch {
    /* ignore */
  }
}

function consumeReturnHash() {
  let hash = '';
  try {
    hash = sessionStorage.getItem('scout.returnHash') || '';
    sessionStorage.removeItem('scout.returnHash');
  } catch {
    /* ignore */
  }
  const m = hash.match(/^#\/([a-z-]+)/);
  if (!m || PUBLIC_ROUTES.has(m[1]) || !ROUTES.includes(m[1])) return '#/dashboard';
  return hash;
}

function goToLogin(opts) {
  signedIn = false;
  shell.classList.add('hidden');
  const forget = !!(opts && opts.forgetReturn);
  if (forget) {
    try {
      sessionStorage.removeItem('scout.returnHash');
    } catch {
      /* ignore */
    }
  }
  const { route } = parseHash();
  const onPublic = PUBLIC_ROUTES.has(route);
  if (!onPublic && !forget) rememberReturnHash();
  if (!onPublic && window.location.hash !== '#/login') {
    history.replaceState(null, '', window.location.pathname + window.location.search + '#/login');
  }
  const modeNow = authHashMode().mode;
  if (
    authGate &&
    !authGate.classList.contains('hidden') &&
    document.getElementById('auth-form') &&
    authGate.dataset.mode === modeNow
  ) {
    return;
  }
  renderAuth();
}

function renderAuth(forcedMode) {
  authGate.classList.remove('hidden');
  shell.classList.add('hidden');
  const hashMode = authHashMode();
  let mode = forcedMode || hashMode.mode;
  // Registration turned off in Admin Settings: a #/register link (or a stale
  // forced mode) lands on Log in instead of a dead register state.
  if (mode === 'register' && !registrationOpen) mode = 'login';
  authGate.dataset.mode = mode;
  const resetToken = hashMode.token;
  const inviteToken = hashMode.inviteToken || '';

  const inviteNote = inviteToken
    ? `<p class="hint">You were invited — sign in${registrationOpen ? ' or register' : ''} with the <strong>same email</strong> the invite was sent to, then we will join you to the workspace.</p>`
    : '';

  authGate.innerHTML = `
    <div class="auth-card">
      <div class="auth-brand"><span class="brand-mark" style="background:#171512;color:#f3ead8">BP</span><h1>Bitpype</h1></div>
      <p class="sub">Local business desk — sign in to your workspace.</p>
      ${inviteNote}
      <div class="tabs" id="auth-tabs">
        <button type="button" class="active" data-tab="login">Log in</button>
        ${registrationOpen ? '<button type="button" data-tab="register">Register</button>' : ''}
      </div>
      <form id="auth-form">
        <div id="auth-login-fields">
          <div class="field"><label for="a-email">Email</label><input id="a-email" name="email" type="email" autocomplete="username" /></div>
          <div class="field" id="pass-field"><label for="a-pass">Password</label><input id="a-pass" name="password" type="password" minlength="8" autocomplete="current-password" /></div>
        </div>
        ${
          registrationOpen
            ? `<div id="reg-extra" class="hidden">
          <div class="field"><label for="a-name">Your name</label><input id="a-name" name="name" type="text" /></div>
          <div class="field"><label for="a-ws">Workspace name</label><input id="a-ws" name="workspaceName" type="text" placeholder="My agency" /></div>
          <div class="field" id="reg-plan-field"><label>Choose your plan</label><div id="reg-plan-options"><p class="hint">Loading plans…</p></div></div>
          <label class="terms-row">
            <input type="checkbox" name="acceptTerms" id="a-terms" value="1" />
            <span>I agree to the <a href="/legal/terms.html" target="_blank" rel="noopener">Terms of Service</a> and <a href="/legal/privacy.html" target="_blank" rel="noopener">Privacy Policy</a>.</span>
          </label>
        </div>`
            : ''
        }
        <div id="reset-extra" class="hidden">
          <div class="field"><label for="a-pass2">New password</label><input id="a-pass2" name="password2" type="password" minlength="8" autocomplete="new-password" /></div>
        </div>
        <div id="auth-captcha" class="field" style="margin:12px 0"></div>
        <button class="btn primary" type="submit" id="auth-submit" style="width:100%">Continue</button>
        <div class="msg" id="auth-msg"></div>
      </form>
      <div class="auth-links" id="auth-links">
        <button type="button" data-goto="forgot">Forgot password?</button>
        <a href="/legal/terms.html" target="_blank" rel="noopener">Terms</a>
      </div>
    </div>`;

  const tabs = $('#auth-tabs', authGate);
  const regExtra = $('#reg-extra', authGate);
  const resetExtra = $('#reset-extra', authGate);
  const passField = $('#pass-field', authGate);
  const submitBtn = $('#auth-submit', authGate);
  const links = $('#auth-links', authGate);
  const emailInput = $('#a-email', authGate);
  const passInput = $('#a-pass', authGate);

  function paintMode() {
    const isForgot = mode === 'forgot';
    const isReset = mode === 'reset';
    const isReg = mode === 'register';
    tabs.classList.toggle('hidden', isForgot || isReset || !registrationOpen);
    if (regExtra) regExtra.classList.toggle('hidden', !isReg);
    resetExtra.classList.toggle('hidden', !isReset);
    passField.classList.toggle('hidden', isForgot);
    emailInput.required = !isReset;
    passInput.required = !isForgot && !isReset;
    if (isReset) {
      passInput.name = 'password';
      passInput.required = true;
      passInput.autocomplete = 'new-password';
      $('#a-pass2', authGate).required = true;
    }
    submitBtn.textContent = isForgot ? 'Send reset link' : isReset ? 'Set new password' : 'Continue';
    links.innerHTML =
      isForgot || isReset
        ? '<button type="button" data-goto="login">Back to log in</button>'
        : '<button type="button" data-goto="forgot">Forgot password?</button><a href="/legal/terms.html" target="_blank" rel="noopener">Terms</a>';
    $$('[data-tab]', authGate).forEach((b) => b.classList.toggle('active', b.dataset.tab === mode));
    $$('[data-goto]', links).forEach((btn) => {
      btn.onclick = () => {
        mode = btn.dataset.goto;
        if (mode === 'login') window.location.hash = '#/login';
        else if (mode === 'forgot') window.location.hash = '#/forgot';
        paintMode();
      };
    });
  }

  paintMode();

  let authCaptcha = { enabled: false, getToken: async () => '', reset: () => {} };
  (async () => {
    try {
      if (window.ScoutCaptcha) {
        authCaptcha = await window.ScoutCaptcha.mount($('#auth-captcha', authGate));
      }
    } catch (err) {
      console.warn('captcha mount failed', err);
    }
  })();

  // Batch 61 — plan step: the register form offers the live plan
  // catalog (GET /auth/plans = billing.catalogForApi verbatim). Free is
  // the preselected no-card default; picking a paid plan creates its
  // checkout at register time and the submit handler below routes the
  // browser there after the MFA enrollment completes. If the catalog
  // can't load, registration still works — the owner starts on Free
  // and can upgrade from Billing, exactly as before this step existed.
  (async () => {
    const box = $('#reg-plan-options', authGate);
    if (!box) return;
    try {
      const r = await api.authPlans();
      const plans = (r && r.data && r.data.plans) || [];
      if (!plans.length) throw new Error('empty catalog');
      box.innerHTML = plans
        .map(
          (p) => `<label class="plan-option" style="display:flex;gap:8px;align-items:flex-start;padding:8px 10px;border:1px solid var(--line);border-radius:8px;margin:6px 0;cursor:pointer">
            <input type="radio" name="plan" value="${esc(p.id)}" ${p.id === 'free' ? 'checked' : ''} style="margin-top:3px" />
            <span><strong>${esc(p.name)}</strong> · ${esc(p.priceLabel || (p.id === 'free' ? 'Free' : ''))}<br/><span class="hint">${esc(p.tagline || '')}</span></span>
          </label>`
        )
        .join('');
    } catch {
      box.innerHTML =
        '<p class="hint">Plans could not load — you will start on Free and can upgrade any time from Billing.</p>';
    }
  })();

  $$('[data-tab]', authGate).forEach((btn) => {
    btn.addEventListener('click', () => {
      mode = btn.dataset.tab;
      paintMode();
      try {
        authCaptcha.reset && authCaptcha.reset();
      } catch {
        /* ignore */
      }
    });
  });

  $('#auth-form', authGate).addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = formObject(e.target);
    const msg = $('#auth-msg', authGate);
    setMsg(msg, 'Working…');
    try {
      body.captchaToken = await authCaptcha.getToken();
      if (mode === 'forgot') {
        const r = await api.forgotPassword(body.email, body.captchaToken);
        const data = r.data || {};
        setMsg(msg, 'If that email exists, a reset link was sent.', 'ok');
        try {
          authCaptcha.reset && authCaptcha.reset();
        } catch {
          /* ignore */
        }
        return;
      }
      if (mode === 'reset') {
        if (body.password !== body.password2) throw new Error('Passwords do not match');
        await api.resetPassword(resetToken, body.password, body.captchaToken);
        setMsg(msg, 'Password updated. You can log in.', 'ok');
        mode = 'login';
        window.location.hash = '#/';
        paintMode();
        return;
      }
      if (mode === 'register') {
        if (!$('#a-terms', authGate).checked) throw new Error('Accept the Terms and Privacy Policy to continue');
        body.acceptTerms = true;
      }
      const res = mode === 'login' ? await api.login(body) : await api.register(body);
      // Batch 61: a paid plan picked at registration already created
      // its Stripe checkout — stash the URL so it survives the MFA
      // detour below (consumed in renderAuthMfa's finishWith).
      if (mode === 'register' && res.data && res.data.planChoice && res.data.planChoice.checkoutUrl) {
        pendingSignupCheckoutUrl = res.data.planChoice.checkoutUrl;
      }
      // Batch 40: staff TOTP is required — a correct password returns a
      // second-factor challenge instead of a session. Enrollment (first
      // time) and the code step both complete through renderAuthMfa,
      // which boots the app with the payload the confirm/verify returns.
      // Batch 53: registration parks the same challenge (it used to skip
      // straight to a session), so the check is no longer login-only; a
      // pending invite rides through the challenge via pendingInviteToken.
      if (res.data && res.data.mfaRequired) {
        if (inviteToken) pendingInviteToken = inviteToken;
        renderAuthMfa(res.data);
        return;
      }
      signedIn = true;
      api.setWorkspaceId(res.data.workspaceId);
      if (inviteToken) {
        try {
          const inv = await api.acceptInvite(inviteToken);
          if (inv.data && inv.data.workspaceId) {
            api.setWorkspaceId(inv.data.workspaceId);
            res.data.workspaceId = inv.data.workspaceId;
            if (inv.data.workspaces) res.data.workspaces = inv.data.workspaces;
          }
          toast('Invite accepted', 'ok');
          window.location.hash = '#/dashboard';
        } catch (invErr) {
          toast(errText(invErr), 'err');
        }
      }
      // Batch 61: no-challenge path (defensive — register parks a
      // challenge since Batch 53) still honours a pending checkout.
      if (pendingSignupCheckoutUrl) {
        const url = pendingSignupCheckoutUrl;
        pendingSignupCheckoutUrl = '';
        window.location.href = url;
        return;
      }
      await bootApp(res.data);
    } catch (err) {
      try {
        authCaptcha.reset && authCaptcha.reset();
      } catch {
        /* ignore */
      }
      setMsg(msg, errText(err), 'error');
    }
  });
}

// Batch 40 — staff second-factor screens, rendered into the auth gate.
// Stage 'enroll' is the forced first-time setup: QR + manual key, one
// confirming code, then the one-time recovery codes. Stage 'verify' is
// the returning-user code step; a link toggles the same field to take
// a recovery code instead. Neither stage holds a session — the
// confirm/verify response carries the full auth payload and bootApp
// takes it from there.
function renderAuthMfa(challenge) {
  const stage = challenge && challenge.mfaStage === 'enroll' ? 'enroll' : 'verify';
  authGate.classList.remove('hidden');
  shell.classList.add('hidden');
  authGate.dataset.mode = 'mfa';
  const brand = `<div class="auth-brand"><span class="brand-mark" style="background:#171512;color:#f3ead8">BP</span><h1>Bitpype</h1></div>`;

  async function finishWith(payload) {
    // Batch 61: registration with a paid plan goes to its Stripe
    // checkout as soon as the second factor completes — the workspace
    // exists either way, and cancelling checkout just leaves the owner
    // on Free until they upgrade from Billing.
    if (pendingSignupCheckoutUrl) {
      const url = pendingSignupCheckoutUrl;
      pendingSignupCheckoutUrl = '';
      toast('Workspace ready — opening secure checkout to activate your plan', 'ok');
      window.location.href = url;
      return;
    }
    signedIn = true;
    api.setWorkspaceId(payload.workspaceId);
    // Batch 53: accept an invite that was parked before the second-factor
    // detour — the same acceptance the no-challenge path performs inline
    // (register used to reach it directly; now both login and register
    // arrive here with the session freshly issued by finishStaffLogin).
    if (pendingInviteToken) {
      const invite = pendingInviteToken;
      pendingInviteToken = '';
      try {
        const inv = await api.acceptInvite(invite);
        if (inv.data && inv.data.workspaceId) {
          api.setWorkspaceId(inv.data.workspaceId);
          payload.workspaceId = inv.data.workspaceId;
          if (inv.data.workspaces) payload.workspaces = inv.data.workspaces;
        }
        toast('Invite accepted', 'ok');
      } catch (invErr) {
        toast(errText(invErr), 'err');
      }
    }
    await bootApp(payload);
  }

  function showRecoveryCodes(codes, payload) {
    authGate.innerHTML = `
    <div class="auth-card">
      ${brand}
      <h2 style="margin:0 0 8px">Save your recovery codes</h2>
      <p class="sub">If you lose your authenticator app, one of these codes signs you in once. Each works a single time, and they will not be shown again.</p>
      <div class="mfa-codes">${codes.map((c) => `<code>${esc(c)}</code>`).join('')}</div>
      <button class="btn primary" id="mfa-codes-done" type="button" style="width:100%">I've saved my codes — continue</button>
    </div>`;
    $('#mfa-codes-done', authGate).onclick = () => finishWith(payload);
  }

  function paintVerify() {
    let useRecovery = false;
    authGate.innerHTML = `
    <div class="auth-card">
      ${brand}
      <h2 style="margin:0 0 8px">Two-factor authentication</h2>
      <p class="sub" id="mfa-verify-hint">Enter the 6-digit code from your authenticator app.</p>
      <form id="mfa-form">
        <div class="field"><label for="mfa-code" id="mfa-code-label">Authenticator code</label><input id="mfa-code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" placeholder="123456" /></div>
        <button class="btn primary" type="submit" style="width:100%">Verify</button>
        <div class="msg" id="mfa-msg"></div>
      </form>
      <div class="auth-links">
        <button type="button" id="mfa-toggle">Use a recovery code instead</button>
        <button type="button" id="mfa-back">Back to log in</button>
      </div>
    </div>`;
    $('#mfa-back', authGate).onclick = () => renderAuth('login');
    $('#mfa-toggle', authGate).onclick = () => {
      useRecovery = !useRecovery;
      $('#mfa-code-label', authGate).textContent = useRecovery ? 'Recovery code' : 'Authenticator code';
      const input = $('#mfa-code', authGate);
      input.placeholder = useRecovery ? 'XXXX-XXXX' : '123456';
      input.setAttribute('inputmode', useRecovery ? 'text' : 'numeric');
      input.value = '';
      input.focus();
      $('#mfa-toggle', authGate).textContent = useRecovery
        ? 'Use my authenticator app instead'
        : 'Use a recovery code instead';
      $('#mfa-verify-hint', authGate).textContent = useRecovery
        ? 'Enter one of the recovery codes you saved when you set this up.'
        : 'Enter the 6-digit code from your authenticator app.';
    };
    $('#mfa-form', authGate).addEventListener('submit', async (e) => {
      e.preventDefault();
      const msg = $('#mfa-msg', authGate);
      setMsg(msg, 'Checking…');
      try {
        const res = await api.mfaVerify($('#mfa-code', authGate).value.trim());
        await finishWith(res.data);
      } catch (err) {
        setMsg(msg, errText(err), 'error');
      }
    });
    $('#mfa-code', authGate).focus();
  }

  async function paintEnroll() {
    authGate.innerHTML = `
    <div class="auth-card">
      ${brand}
      <h2 style="margin:0 0 8px">Set up two-factor authentication</h2>
      <p class="sub">Staff accounts require an authenticator app. Scan this code with yours (Google Authenticator, Authy, 1Password…), then enter the 6-digit code it shows to finish.</p>
      <div id="mfa-enroll-body"><p class="sub">Preparing your setup code…</p></div>
      <div class="auth-links"><button type="button" id="mfa-back">Back to log in</button></div>
    </div>`;
    $('#mfa-back', authGate).onclick = () => renderAuth('login');
    const host = $('#mfa-enroll-body', authGate);
    try {
      const res = await api.mfaEnrollStart();
      const d = res.data || {};
      host.innerHTML = `
        <div style="text-align:center"><img src="${d.qrDataUrl}" alt="Authenticator setup QR code" width="220" height="220" /></div>
        <p class="sub" style="text-align:center">Can't scan? Enter this key manually:<br /><code style="font-size:1rem;letter-spacing:0.08em">${esc(d.secret || '')}</code></p>
        <form id="mfa-form">
          <div class="field"><label for="mfa-code">6-digit code from the app</label><input id="mfa-code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" placeholder="123456" /></div>
          <button class="btn primary" type="submit" style="width:100%">Confirm and sign in</button>
          <div class="msg" id="mfa-msg"></div>
        </form>`;
      $('#mfa-form', authGate).addEventListener('submit', async (e) => {
        e.preventDefault();
        const msg = $('#mfa-msg', authGate);
        setMsg(msg, 'Checking…');
        try {
          const r = await api.mfaEnrollConfirm($('#mfa-code', authGate).value.trim());
          const payload = r.data || {};
          const codes = payload.recoveryCodes || [];
          delete payload.recoveryCodes;
          if (codes.length) showRecoveryCodes(codes, payload);
          else await finishWith(payload);
        } catch (err) {
          setMsg(msg, errText(err), 'error');
        }
      });
      const codeInput = $('#mfa-code', authGate);
      if (codeInput) codeInput.focus();
    } catch (err) {
      host.innerHTML = `<div class="msg error">${esc(errText(err))}</div>`;
    }
  }

  if (stage === 'enroll') paintEnroll();
  else paintVerify();
}

function updateBillingBanner() {  const el = document.getElementById('billing-banner');
  if (!el) return;
  if (subscriptionStatus === 'past_due') {
    el.classList.remove('hidden');
    el.innerHTML = `<strong>Payment past due.</strong> Update your card to keep access.
      <a href="#/billing">Open Billing</a>`;
    return;
  }
  // Core Free access always has productAccess; this banner is only for paid gates.
  if (requireSubscription && !productAccess && !currentUserIsSuperAdmin) {
    el.classList.remove('hidden');
    el.innerHTML = `<strong>Paid plan required for this feature.</strong> Upgrade to unlock Standard/Premium entitlements.
      <a href="#/billing">Go to Billing</a>`;
    return;
  }
  el.classList.add('hidden');
  el.innerHTML = '';
}

function fillWorkspaces(workspaces, currentId) {
  if (!wsSelect) return;
  wsSelect.innerHTML = asList(workspaces)
    .map(
      (w) =>
        `<option value="${w.id}" ${Number(w.id) === Number(currentId) ? 'selected' : ''}>${esc(w.name)} (${esc(w.role)})</option>`
    )
    .join('');
}

async function refreshAutomation() {
  if (!autoEl) return;
  try {
    const res = await api.stats();
    automationPaused = !!res.data.automationPaused;
    autoEl.title =
      'The workspace pause switch — click to pause/resume all automation. Same switch as Dashboard Pause and Settings → Emergency stop.';
    autoEl.textContent = automationPaused ? 'Automation paused' : 'Automation running';
    autoEl.classList.toggle('is-paused', automationPaused);
    autoEl.classList.toggle('is-running', !automationPaused);
  } catch {
    autoEl.textContent = 'Automation status unavailable';
    autoEl.classList.remove('is-paused', 'is-running');
  }
}

async function setAutomation(paused) {
  await api.automation(paused);
  await refreshAutomation();
  toast(paused ? 'Automation paused' : 'Automation resumed', 'ok');
}

async function bootApp(meData) {
  signedIn = true;
  authGate.classList.add('hidden');
  authGate.dataset.mode = '';
  shell.classList.remove('hidden');
  currentUserIsSuperAdmin = !!(meData.isSuperAdmin || (meData.user && meData.user.isSuperAdmin));
  currentUserIsPartner = !!(meData.isPartner || (meData.user && meData.user.isPartner));
  currentUserId = meData.user && meData.user.id != null ? Number(meData.user.id) : null;
  requireSubscription = !!meData.requireSubscription;
  userSubscribed = meData.subscribed != null ? !!meData.subscribed : !!(meData.user && meData.user.subscribed);
  productAccess =
    meData.productAccess != null
      ? !!meData.productAccess
      : userSubscribed || !!meData.workspaceSubscribed || currentUserIsSuperAdmin;
  subscriptionStatus = (meData.user && meData.user.subscriptionStatus) || 'none';
  const navAdmin = document.getElementById('nav-admin');
  if (navAdmin) navAdmin.classList.toggle('hidden', !currentUserIsSuperAdmin);
  const navMailingList = document.getElementById('nav-mailing-list');
  if (navMailingList) navMailingList.classList.toggle('hidden', !currentUserIsSuperAdmin);
  const navPartnerEarnings = document.getElementById('nav-partner-earnings');
  if (navPartnerEarnings) navPartnerEarnings.classList.toggle('hidden', !currentUserIsPartner);
  fillWorkspaces(meData.workspaces, meData.workspaceId || api.getWorkspaceId());
  updateBillingBanner();

  const { route, param } = parseHash();
  if (route === 'invite' && param) {
    try {
      const inv = await api.acceptInvite(param);
      if (inv.data && inv.data.workspaceId) {
        api.setWorkspaceId(inv.data.workspaceId);
        if (inv.data.workspaces) fillWorkspaces(inv.data.workspaces, inv.data.workspaceId);
      }
      toast('Invite accepted', 'ok');
      window.location.hash = '#/dashboard';
    } catch (err) {
      toast(errText(err), 'err');
    }
  }

  try {
    await refreshAutomation();
  } catch {
    /* paywalled */
  }
  navigate();
}

function closeNav() {
  shell.classList.remove('nav-open');
  $('#sidebar-backdrop').hidden = true;
}
function openNav() {
  shell.classList.add('nav-open');
  $('#sidebar-backdrop').hidden = false;
}

/* ------------------------------------------------------------------ */
/* Dashboard                                                           */
/* ------------------------------------------------------------------ */

async function pageDashboard() {
  const [st, act] = await Promise.all([api.stats(), api.activity({ limit: 15 }).catch(() => null)]);
  const d = st.data;
  const paused = !!d.automationPaused;
  automationPaused = paused;
  const activity = asList(act && act.data, ['rows']).length ? asList(act.data, ['rows']) : asList(d.activity);
  const byStatus = d.byStatus || {};

  view.innerHTML = `
    <div class="page-head">
      <div><h1>Dashboard</h1><p class="lede">${esc(d.workspace.name)} · role ${esc(d.workspace.role)}</p></div>
      <div class="page-actions" id="dash-auto"></div>
    </div>
    <div class="alert warn" id="dash-banner" ${paused ? '' : 'hidden'}>
      <strong>Automation is paused.</strong> Discovery, research, generation, scheduled jobs and outreach will not run.
      <button class="btn small" data-act="resume">Resume</button>
    </div>
    <div class="stats-cards">
      <div class="stat-card"><div class="stat-label">Leads</div><div class="stat-value">${esc(d.leadsTotal)}</div></div>
      <div class="stat-card"><div class="stat-label">Websites</div><div class="stat-value">${esc(d.websites)}</div></div>
      <div class="stat-card"><div class="stat-label">Design waiting</div><div class="stat-value">${esc(d.designJobsWaitingOnAgent)}</div></div>
      <div class="stat-card"><div class="stat-label">Questions pending</div><div class="stat-value">${esc(d.designJobsQuestionsPending)}</div></div>
      <div class="stat-card"><div class="stat-label">Emails sent today</div><div class="stat-value">${esc(d.outreachSentToday == null ? '—' : d.outreachSentToday)}</div></div>
      <div class="stat-card"><div class="stat-label">AI spend today</div><div class="stat-value">${money(d.aiSpendTodayUsd)}</div></div>
      <div class="stat-card ${paused ? 'is-paused' : 'is-running'}"><div class="stat-label">Automation</div><div class="stat-value">${paused ? 'Paused' : 'Running'}</div></div>
    </div>
    <div class="card">
      <div class="panel-h"><h3>Leads by status</h3><a href="#/leads" class="btn small">Open leads</a></div>
      <div class="chips">${
        Object.keys(byStatus).length
          ? Object.keys(byStatus)
              .map(
                (s) =>
                  `<a class="chip" href="#/leads?status=${encodeURIComponent(s)}" style="text-decoration:none;color:inherit">${esc(pretty(s))}<span>${esc(byStatus[s])}</span></a>`
              )
              .join('')
          : '<span class="hint">No leads yet — run Discover on the Leads page.</span>'
      }</div>
    </div>
    <div class="card">
      <div class="panel-h"><h3>Recent activity</h3>${activity.length ? '<button class="btn small danger" data-act="clear-activity">Clear all…</button>' : ''}</div>
      <ul class="list">${
        activity.length
          ? activity
              .map(
                (a) => `<li>${esc(a.message)}<div class="timestamp">${esc(a.area)} · ${esc(fmtDate(a.at))}</div></li>`
              )
              .join('')
          : '<li class="hint">No activity yet.</li>'
      }</ul>
    </div>
    <div class="card">
      <h3>Emergency stop</h3>
      <p class="hint">Same switch as Pause automation, just in red: it blocks new discovery, research, generation and outreach (a step already running finishes) and logs an activity entry. Nothing extra is cancelled.</p>
      <button class="big-danger" data-act="stop">Emergency stop</button>
    </div>`;

  $('#dash-auto').innerHTML = paused
    ? '<button class="btn primary" data-act="resume">Resume automation</button>'
    : '<button class="btn" data-act="pause">Pause automation</button>';

  delegate(view, {
    pause: async () => {
      if (!window.confirm('Pause all automation (discovery, jobs, outreach, AI)?')) return;
      await setAutomation(true);
      pageDashboard();
    },
    resume: async () => {
      if (!window.confirm('Resume automation?')) return;
      await setAutomation(false);
      pageDashboard();
    },
    stop: async () => {
      if (!window.confirm('Pause ALL automation now: discovery, research, generation and outreach?')) return;
      await setAutomation(true);
      pageDashboard();
    },
    'clear-activity': async () => {
      await runClearActivityFlow(() => pageDashboard());
    },
  });
}

/* ------------------------------------------------------------------ */
/* Leads                                                               */
/* ------------------------------------------------------------------ */

const leadsState = {
  q: '',
  status: '',
  minScore: '',
  group: '',
  category: '',
  page: 1,
  pageSize: 25,
  total: 0,
  selected: new Set(),
  facets: { groups: [], categories: [], tags: [] },
};

async function pageLeads(param, query) {
  // Batch 78: #/leads/<id> is the full lead page (was a slide-over drawer).
  if (param) return pageLeadDetail(Number(param), query);
  if (query && query.status !== undefined) {
    leadsState.status = query.status;
    leadsState.page = 1;
  }

  view.innerHTML = `
    <div class="page-head">
      <div><h1>Leads</h1><p class="lede">Discover, import, score, research and qualify local businesses.</p></div>
      <div class="page-actions">
        <button class="btn primary" data-act="discover">Discover</button>
        <button class="btn" data-act="add">Add lead</button>
        <button class="btn" data-act="import">Import CSV</button>
      </div>
    </div>
    <div class="chips" id="l-chips"></div>
    <div class="toolbar">
      <input id="l-q" type="search" class="grow" placeholder="Search name, city, category, email, group…" value="${esc(leadsState.q)}" />
      <select id="l-status"><option value="">All statuses</option>${optionList(LEAD_STATUSES, leadsState.status)}</select>
      <input id="l-min" type="number" min="0" max="100" placeholder="Min score" style="width:110px" value="${esc(leadsState.minScore)}" />
      <select id="l-group"></select>
      <select id="l-cat"></select>
      <button class="btn" data-act="clear">Clear</button>
    </div>
    <div class="bulk-bar" id="l-bulk" hidden>
      <strong id="l-selcount">0 selected</strong>
      <select id="l-bulk-status"><option value="">Set status…</option>${optionList(LEAD_STATUSES, '')}</select>
      <input id="l-bulk-val" type="text" placeholder="Group or tag" style="width:150px" />
      <button class="btn small" data-act="b-group">Set group</button>
      <button class="btn small" data-act="b-tag">Add tag</button>
      <button class="btn small" data-act="b-untag">Remove tag</button>
      <button class="btn small" data-act="b-research">Research</button>
      <button class="btn small" data-act="b-campaign">Create campaign</button>
      <button class="btn small danger" data-act="b-delete">Delete</button>
      <button class="btn small" data-act="b-clear">Clear selection</button>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th style="width:34px"><input type="checkbox" id="l-all" aria-label="Select all" /></th><th>Business</th><th>Group</th><th>Category</th><th>Tags</th><th>Score</th><th>Status</th><th>Source</th><th>Updated</th></tr></thead>
      <tbody id="l-body">${loadRowHtml(9, 'Loading leads…')}</tbody>
    </table></div>
    <div class="pagination" id="l-pager"></div>`;

  function updateBulk() {
    const n = leadsState.selected.size;
    $('#l-bulk').hidden = n === 0;
    $('#l-selcount').textContent = n + ' selected';
  }

  const leadsGate = latestGate();
  const facetsGate = latestGate();
  async function loadFacets() {
    const mine = facetsGate();
    try {
      leadsState.facets = (await api.leadFacets()).data.facets || leadsState.facets;
    } catch {
      /* optional */
    }
    if (!mine()) return;
    const g = $('#l-group');
    if (!g) return;
    const f = leadsState.facets;
    const usable = (items) => (items || []).filter((i) => i.name && !String(i.name).startsWith('('));
    const opts = (items, all, cur) =>
      `<option value="">${all}</option>` +
      usable(items)
        .map(
          (i) =>
            `<option value="${esc(i.name)}" ${i.name === cur ? 'selected' : ''}>${esc(i.name)} (${i.count})</option>`
        )
        .join('');
    g.innerHTML = opts(f.groups, 'All groups', leadsState.group);
    $('#l-cat').innerHTML = opts(f.categories, 'All categories', leadsState.category);
    const chips = usable(f.groups).slice(0, 8);
    $('#l-chips').innerHTML = chips.length
      ? '<span class="hint">Hunts</span>' +
        chips
          .map(
            (c) =>
              `<button class="chip ${leadsState.group === c.name ? 'active' : ''}" data-act="chip" data-group="${esc(c.name)}">${esc(c.name)}<span>${c.count}</span></button>`
          )
          .join('')
      : '<span class="hint">No hunt groups yet — Discover or set a group on selected leads.</span>';
  }

  async function load() {
    const mine = leadsGate();
    const body = $('#l-body');
    if (!body) return;
    let r;
    try {
      r = await Promise.race([
        api.leads({
          q: leadsState.q,
          status: leadsState.status,
          minScore: leadsState.minScore,
          group: leadsState.group,
          category: leadsState.category,
          page: leadsState.page,
          pageSize: leadsState.pageSize,
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timed out after 15s')), 15000)),
      ]);
    } catch (e) {
      if (!mine() || !$('#l-body')) return;
      body.innerHTML = loadErrorRowHtml(9, 'l-retry', errText(e));
      return;
    }
    if (!mine() || !$('#l-body')) return;
    const rows = asList(r.data, ['leads', 'rows']);
    leadsState.total = r.data.total || rows.length;
    body.innerHTML =
      rows
        .map(
          (l) => `<tr>
      <td><input type="checkbox" class="row-check" data-id="${l.id}" ${leadsState.selected.has(l.id) ? 'checked' : ''} aria-label="Select lead" /></td>
      <td><button class="link-btn" data-act="open" data-id="${l.id}">${esc(l.business_name)}</button>${l.qualified ? ' <span class="badge ok">qualified</span>' : ''}<div class="hint">${esc(l.email || '')}</div></td>
      <td>${esc(l.lead_group || '—')}</td>
      <td>${esc(l.category || '—')}</td>
      <td>${
        (l.tags || [])
          .slice(0, 3)
          .map((t) => `<span class="tag-pill">${esc(t)}</span>`)
          .join('') || '—'
      }</td>
      <td>${scorePill(l.score)}</td>
      <td>${statusBadge(l.status)}</td>
      <td>${esc(l.source || '—')}</td>
      <td>${esc(fmtDate(l.updated_at))}</td>
    </tr>`
        )
        .join('') || '<tr><td colspan="9" class="empty">No leads match these filters.</td></tr>';
    const pages = Math.max(1, Math.ceil(leadsState.total / leadsState.pageSize));
    pager($('#l-pager'), { page: leadsState.page, pages, total: leadsState.total }, (p) => {
      leadsState.page = p;
      load();
    });
    updateBulk();
  }
  leadsReload = () => {
    if ($('#l-body')) {
      load().catch((e) => toast(errText(e), 'err'));
      loadFacets();
    }
  };

  const applyFilters = () => {
    leadsState.q = $('#l-q').value.trim();
    leadsState.status = $('#l-status').value;
    leadsState.minScore = $('#l-min').value;
    leadsState.group = $('#l-group').value;
    leadsState.category = $('#l-cat').value;
    leadsState.page = 1;
    load().catch((e) => toast(errText(e), 'err'));
    loadFacets();
  };
  $('#l-q').addEventListener('input', debounce(applyFilters, 300));
  $('#l-min').addEventListener('input', debounce(applyFilters, 300));
  ['#l-status', '#l-group', '#l-cat'].forEach((s) => $(s).addEventListener('change', applyFilters));

  $('#l-body').addEventListener('change', (e) => {
    const cb = e.target.closest('.row-check');
    if (!cb) return;
    const id = Number(cb.dataset.id);
    if (cb.checked) leadsState.selected.add(id);
    else leadsState.selected.delete(id);
    updateBulk();
  });
  $('#l-all').addEventListener('change', (e) => {
    $$('.row-check', $('#l-body')).forEach((cb) => {
      cb.checked = e.target.checked;
      const id = Number(cb.dataset.id);
      if (e.target.checked) leadsState.selected.add(id);
      else leadsState.selected.delete(id);
    });
    updateBulk();
  });
  $('#l-bulk-status').addEventListener('change', (e) => {
    if (e.target.value) safeRun(null, () => bulk('status', e.target.value));
    e.target.value = '';
  });

  async function bulk(action, value) {
    const ids = Array.from(leadsState.selected);
    if (!ids.length) return;
    if (action === 'delete' && !window.confirm(`Delete ${ids.length} lead(s)? This cannot be undone.`)) return;
    if (['set_group', 'tag', 'untag'].includes(action) && !value) {
      toast('Enter a value first.', 'err');
      return;
    }
    const r = await api.bulkLeads(action, ids, value);
    const b = r.data.bulk || {};
    toast(`Bulk ${action}: ${b.processed || 0} ok, ${b.failed || 0} failed`, b.failed ? 'err' : 'ok');
    if (action === 'delete' || action === 'status') leadsState.selected.clear();
    $('#l-all').checked = false;
    await load();
    loadFacets();
  }

  delegate(view, {
    open: (t) => {
      window.location.hash = '#/leads/' + t.dataset.id;
    },
    'l-retry': () => {
      const b = $('#l-body');
      if (b) b.innerHTML = loadRowHtml(9, 'Loading leads…');
      load();
    },
    chip: (t) => {
      leadsState.group = leadsState.group === t.dataset.group ? '' : t.dataset.group;
      leadsState.page = 1;
      load();
      loadFacets();
    },
    clear: () => {
      Object.assign(leadsState, { q: '', status: '', minScore: '', group: '', category: '', page: 1 });
      $('#l-q').value = '';
      $('#l-status').value = '';
      $('#l-min').value = '';
      load();
      loadFacets();
    },
    discover: () => openDiscoverModal(),
    add: () => openAddLeadModal(),
    import: () => openImportModal(),
    'b-group': () => bulk('set_group', $('#l-bulk-val').value.trim()),
    'b-tag': () => bulk('tag', $('#l-bulk-val').value.trim()),
    'b-untag': () => bulk('untag', $('#l-bulk-val').value.trim()),
    'b-research': () => bulk('research'),
    'b-delete': () => bulk('delete'),
    'b-clear': () => {
      leadsState.selected.clear();
      $('#l-all').checked = false;
      load();
    },
    'b-campaign': () => {
      sessionStorage.setItem('scout.campaignLeadIds', JSON.stringify(Array.from(leadsState.selected)));
      outreachTab = 'campaigns';
      window.location.hash = '#/outreach?new=1';
    },
  });

  await Promise.all([load(), loadFacets()]);
  // Legacy deep links (the old id-query lead links — old bookmarks and
  // OAuth returns) land on the lead page now (Batch 78).
  if (query && query.id) window.location.hash = '#/leads/' + Number(query.id);
}

async function openDiscoverModal() {
  let providers = [];
  try {
    providers = ((await api.providers()).data.providers || []).filter((p) => p.name !== 'csv' && p.name !== 'manual');
  } catch {
    /* ignore */
  }
  const preferred = providers.find((p) => p.configured) || providers[0];
  const m = openModal({
    title: 'Discover leads',
    body: `<p class="hint">Searches a provider for local businesses and adds new leads. Requires a provider key (Settings → Lead discovery).</p>
      <div class="row">
        <div class="field"><label for="d-prov">Provider</label><select id="d-prov">${providers.map((p) => `<option value="${esc(p.name)}" ${preferred && preferred.name === p.name ? 'selected' : ''}>${esc(p.name)}${p.configured ? '' : ' (not configured)'}</option>`).join('') || '<option value="tavily">tavily</option>'}</select></div>
        <div class="field"><label for="d-limit">Limit</label><input id="d-limit" type="number" min="1" max="50" value="8" /></div>
      </div>
      <div class="row">
        <div class="field"><label for="d-cat">Category</label><input id="d-cat" type="text" value="Plumber" /></div>
        <div class="field"><label for="d-loc">Location</label><input id="d-loc" type="text" value="Springfield" /></div>
      </div>
      <div class="row">
        <div class="field"><label for="d-group">Hunt group (optional)</label><input id="d-group" type="text" placeholder="auto from category · location" /></div>
        <div class="field"><label for="d-web">Website</label><select id="d-web"><option value="">Any</option><option value="has">Has website</option><option value="no">No website</option></select></div>
      </div>
      <label><input id="d-score" type="checkbox" checked /> Score new leads</label>
      <div class="msg" id="d-msg"></div>`,
    buttons: [
      { label: 'Close' },
      {
        label: 'Run discovery',
        cls: 'primary',
        onClick: async (mm, btn) => {
          const category = $('#d-cat', mm.el).value.trim();
          const location = $('#d-loc', mm.el).value.trim();
          const msg = $('#d-msg', mm.el);
          if (!category || !location) {
            setMsg(msg, 'Category and location are required.', 'err');
            return;
          }
          setMsg(msg, 'Discovering… this can take a minute.');
          btn.textContent = 'Discovering…';
          try {
            const r = await api.discover(
              dropEmpty({
                provider: $('#d-prov', mm.el).value,
                category,
                location,
                group: $('#d-group', mm.el).value.trim(),
                limit: Number($('#d-limit', mm.el).value) || 8,
                score: $('#d-score', mm.el).checked,
                websitePresence: $('#d-web', mm.el).value,
              })
            );
            const x = r.data;
            const names = (x.leads || [])
              .slice(0, 8)
              .map((l) => `#${l.id} ${esc(l.business_name)}${l.score != null ? ` (score ${esc(l.score)})` : ''}`)
              .join('<br>');
            msg.className = 'msg ok';
            msg.innerHTML = `Provider <b>${esc(x.provider)}</b>: created <b>${esc(x.created)}</b>, skipped <b>${esc(x.skipped)}</b>, scored <b>${esc(x.scored)}</b>, queried <b>${esc(x.queried)}</b>.${x.warning ? `<br>${esc(x.warning)}` : ''}${names ? `<br><span class="hint">${names}</span>` : ''}`;
            if (leadsReload) leadsReload();
          } catch (err) {
            setMsg(msg, errText(err), 'err');
          } finally {
            btn.textContent = 'Run discovery';
          }
        },
      },
    ],
  });
  return m;
}

function openAddLeadModal() {
  openModal({
    title: 'Add lead',
    body: `<form id="al-form">
      <div class="field"><label>Business name *</label><input name="business_name" required /></div>
      <div class="row">
        <div class="field"><label>Category</label><input name="category" /></div>
        <div class="field"><label>Hunt group</label><input name="group" /></div>
      </div>
      <div class="row">
        <div class="field"><label>Email</label><input name="email" type="email" /></div>
        <div class="field"><label>Phone</label><input name="phone" /></div>
      </div>
      <div class="row">
        <div class="field"><label>Website</label><input name="website" /></div>
        <div class="field"><label>City</label><input name="city" /></div>
        <div class="field"><label>State</label><input name="state" /></div>
      </div>
      <div class="field"><label>Tags (comma separated)</label><input name="tags" /></div>
      <div class="field"><label>Notes</label><textarea name="notes" style="min-height:60px"></textarea></div>
      <div class="msg" id="al-msg"></div></form>`,
    buttons: [
      { label: 'Cancel' },
      {
        label: 'Create lead',
        cls: 'primary',
        onClick: async (m) => {
          const obj = dropEmpty(formObject($('#al-form', m.el)));
          if (!obj.business_name) {
            setMsg($('#al-msg', m.el), 'Business name is required.', 'err');
            return;
          }
          if (obj.tags)
            obj.tags = obj.tags
              .split(',')
              .map((t) => t.trim())
              .filter(Boolean);
          await api.createLead(obj);
          toast('Lead created', 'ok');
          m.close();
          if (leadsReload) leadsReload();
        },
      },
    ],
  });
}

function openImportModal() {
  openModal({
    title: 'Import leads from CSV',
    wide: true,
    body: `<p class="hint">Header row required. Common columns: business_name, category, email, phone, website, address, city, state, tags, group. Also accepts GapScout CSV (project, business, profile_url, location, score, opportunity, signal_evidence, platform, …).</p>
      <div class="field"><input id="im-file" type="file" accept=".csv,text/csv,text/plain" style="padding:6px" /></div>
      <div class="field"><textarea id="im-text" class="mono" placeholder="business_name,category,email,city&#10;Acme Plumbing,Plumber,hi@acme.test,Springfield"></textarea></div>
      <div class="field"><label>Hunt group (optional)</label><input id="im-group" type="text" /></div>
      <div class="msg" id="im-msg"></div>`,
    buttons: [
      { label: 'Close' },
      {
        label: 'Import',
        cls: 'primary',
        onClick: async (m) => {
          const text = $('#im-text', m.el).value;
          const msg = $('#im-msg', m.el);
          if (!text.trim()) {
            setMsg(msg, 'Paste CSV text or choose a file first.', 'err');
            return;
          }
          const group = $('#im-group', m.el).value.trim();
          const r = await api.importLeads(text, group ? { group } : {});
          const x = r.data;
          const errs = (x.errors || [])
            .slice(0, 8)
            .map((e) => `line ${esc(e.line)}: ${esc(e.error)}`)
            .join('<br>');
          msg.className = 'msg ok';
          msg.innerHTML = `Imported <b>${esc(x.created)}</b>, skipped <b>${esc(x.skipped)}</b>.${errs ? `<br><span class="hint">${errs}</span>` : ''}`;
          if (leadsReload) leadsReload();
        },
      },
    ],
  });
  const f = $('#im-file');
  f.addEventListener('change', () => {
    const file = f.files && f.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      $('#im-text').value = String(reader.result || '');
    };
    reader.onerror = () => toast('Could not read file.', 'err');
    reader.readAsText(file);
  });
}

/** After an SMS is queued for a lead: offer immediate send or leave queued. */
function openQueuedSmsModal(q) {
  openModal({
    title: 'Send SMS now?',
    body: `<p>Queued for <b>${esc(q.to)}</b>. Send it immediately, or leave it queued.</p>
      <p class="hint" id="qs-msg"></p>`,
    buttons: [
      {
        label: 'Keep queued',
        onClick: (mm) => {
          toast('SMS queued', 'ok');
          mm.close();
        },
      },
      {
        label: 'Send now',
        cls: 'primary',
        onClick: async (mm, btn) => {
          setMsg($('#qs-msg', mm.el), 'Sending…');
          btn.textContent = 'Sending…';
          try {
            const s = (await api.emailSend(q.messageId)).data;
            toast(s.sent ? `SMS sent to ${s.to}` : 'Queued but not sent', s.sent ? 'ok' : 'err');
            mm.close();
          } catch (err) {
            setMsg($('#qs-msg', mm.el), errText(err), 'err');
            btn.textContent = 'Send now';
          }
        },
      },
    ],
  });
}

/** Compose + queue a one-off SMS for a specific lead (lead page action). */
async function openQueueSmsModal(leadId) {
  let lead = {};
  try {
    lead = (await api.leadGet(leadId)).data.lead || {};
  } catch {
    /* fall through — queue call will surface errors */
  }
  if (!lead.phone) {
    toast('This lead has no phone number.', 'err');
    return;
  }
  const m = openModal({
    title: 'Queue SMS — ' + (lead.business_name || 'Lead #' + leadId),
    body: `<div class="field"><label for="ld-sms-body">SMS body</label>
      <textarea id="ld-sms-body" rows="4" maxlength="1600" placeholder="Hi {{business_name}} — preview: {{website_link}}"></textarea>
      <div class="hint"><span id="ld-sms-count">0 characters</span> · Variables: {{business_name}}, {{website_link}}, {{site_screenshot}}</div></div>`,
    buttons: [
      { label: 'Cancel' },
      {
        label: 'Queue SMS',
        cls: 'primary',
        onClick: async (mm) => {
          const sms = ($('#ld-sms-body', mm.el).value || '').trim();
          if (!sms) {
            toast('Write the SMS first.', 'err');
            return;
          }
          try {
            const q = (await api.smsQueue({ leadId, body: sms })).data;
            mm.close();
            openQueuedSmsModal(q);
          } catch (err) {
            toast(errText(err), 'err');
          }
        },
      },
    ],
  });
  const ta = $('#ld-sms-body', m.el);
  if (ta) {
    ta.addEventListener('input', () => {
      const c = $('#ld-sms-count', m.el);
      if (c) c.textContent = `${ta.value.length} characters`;
    });
    ta.focus();
  }
}

/* ------------------------------------------------------------------ */
/* Onboarding checklist (Batch 74) — lead page section.              */
/* The 12-item onboarding run sheet as plain ticks: every item is     */
/* optional, nothing gates on it. "Run checklist" asks the server     */
/* what the data can prove (pass / not yet / needs your eyes);         */
/* Confirm applies ONLY the passes, server re-verified.               */
/* ------------------------------------------------------------------ */

function onboardingVerdictBadge(verdict) {
  return (
    {
      pass: '<span class="badge ok">auto-pass</span>',
      fail: '<span class="badge err">not yet</span>',
      manual: '<span class="badge warn">needs your eyes</span>',
    }[verdict] || ''
  );
}

async function loadLeadOnboarding(dr, leadId) {
  const host = () => $('#ld-onboarding', dr.el);
  if (!host()) return;
  let state;
  try {
    state = (await api.leadOnboarding(leadId)).data;
  } catch (e) {
    host().innerHTML = `<p class="error">${esc(errText(e))}</p>`;
    return;
  }
  render(state, null);

  function render(st, run) {
    const el = host();
    if (!el) return;
    const results = run && Array.isArray(run.results) ? run.results : null;
    const byKey = {};
    if (results) for (const r of results) byKey[r.key] = r;
    const doneByKey = {};
    for (const i of st.items) doneByKey[i.key] = i.done;
    const passUndone = results
      ? results.filter((r) => r.verdict === 'pass' && !doneByKey[r.key]).length
      : 0;
    el.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:6px">
        <span class="hint">Onboarding — ${st.doneCount} of ${st.total} ticked. Every item is optional; tick them as you go.</span>
        <button class="btn small" type="button" data-onb-run>Run checklist</button>
      </div>
      ${st.items
        .map((i) => {
          const r = results ? byKey[i.key] : null;
          return `<div>
        <label class="pick-row"><input type="checkbox" data-onb-key="${esc(i.key)}" ${i.done ? 'checked' : ''} /><span>${i.done ? '✓ ' : ''}${esc(i.label)}</span></label>
        ${i.done && i.doneBy ? `<div class="sub-line" style="margin-left:28px">${esc(i.doneBy)}${i.doneAt ? ' · ' + esc(fmtDate(i.doneAt)) : ''}${i.via === 'autorun' ? ' · via Run checklist' : ''}</div>` : ''}
        ${r ? `<div class="sub-line" style="margin-left:28px">${onboardingVerdictBadge(r.verdict)} ${esc(r.detail)}</div>` : ''}
      </div>`;
        })
        .join('')}
      ${
        results
          ? `<div style="margin-top:10px">${
              passUndone
                ? `<button class="btn primary small" type="button" data-onb-confirm>Confirm — apply ${passUndone} passed check${passUndone === 1 ? '' : 's'}</button>`
                : '<span class="hint">Nothing new to apply — the rest stay unticked for a human.</span>'
            }</div>`
          : ''
      }`;

    el.querySelectorAll('[data-onb-key]').forEach((box) => {
      box.addEventListener('change', async () => {
        box.disabled = true;
        try {
          const next = (await api.leadOnboardingSet(leadId, box.dataset.onbKey, box.checked)).data;
          render(next, run);
        } catch (e) {
          toast(errText(e), 'err');
          render(st, run);
        }
      });
    });
    const runBtn = el.querySelector('[data-onb-run]');
    if (runBtn) {
      runBtn.addEventListener('click', async () => {
        runBtn.disabled = true;
        runBtn.textContent = 'Checking…';
        try {
          const out = (await api.leadOnboardingRun(leadId)).data;
          render(out.state || st, out);
        } catch (e) {
          toast(errText(e), 'err');
          render(st, run);
        }
      });
    }
    const confirmBtn = el.querySelector('[data-onb-confirm]');
    if (confirmBtn) {
      confirmBtn.addEventListener('click', async () => {
        confirmBtn.disabled = true;
        try {
          const out = (await api.leadOnboardingConfirm(leadId)).data;
          toast(
            out.appliedCount
              ? `Applied ${out.appliedCount} passed check${out.appliedCount === 1 ? '' : 's'}`
              : 'Nothing new passed on re-check — nothing applied',
            'ok'
          );
          render(out.state, out);
        } catch (e) {
          toast(errText(e), 'err');
          render(st, run);
        }
      });
    }
  }
}

/* Google Profile (Batch 46, Phase 1) — lead page section.            */
/* Prefill + draft change sets work today; pushing is held at "ready" */
/* until Google approves the Business Profile API application.        */
/* ------------------------------------------------------------------ */

const GBP_DAYS = [
  ['sunday', 'Sunday'],
  ['monday', 'Monday'],
  ['tuesday', 'Tuesday'],
  ['wednesday', 'Wednesday'],
  ['thursday', 'Thursday'],
  ['friday', 'Friday'],
  ['saturday', 'Saturday'],
];

function gbpStatusBadge(status) {
  return (
    {
      connected: '<span class="badge ok">connected</span>',
      invited: '<span class="badge warn">invite sent</span>',
      disconnected: '<span class="badge">disconnected</span>',
      error: '<span class="badge err">error</span>',
      none: '<span class="badge">not connected</span>',
      draft: '<span class="badge">draft</span>',
      ready: '<span class="badge warn">ready — awaiting push</span>',
      pushed: '<span class="badge ok">pushed</span>',
      failed: '<span class="badge err">failed</span>',
    }[status] || `<span class="badge">${esc(status)}</span>`
  );
}

function gbpHoursRowsHtml(state) {
  const hours = (state && state.hours) || {};
  return GBP_DAYS.map(([key, label]) => {
    const periods = Array.isArray(hours[key]) ? hours[key] : [];
    const first = periods[0] || { open: '', close: '' };
    const second = periods[1] || { open: '', close: '' };
    const closed = periods.length === 0;
    return `<div class="row" data-gbp-day="${key}">
      <div class="field" style="flex:0 0 110px"><label>${label}</label>
        <label class="hint" style="display:flex;gap:6px;align-items:center"><input type="checkbox" data-h="closed" ${closed ? 'checked' : ''}/> Closed</label></div>
      <div class="field"><label>Open</label><input data-h="open" value="${esc(first.open || '')}" placeholder="09:00" /></div>
      <div class="field"><label>Close</label><input data-h="close" value="${esc(first.close || '')}" placeholder="17:00" /></div>
      <div class="field"><label>2nd open</label><input data-h="open2" value="${esc(second.open || '')}" /></div>
      <div class="field"><label>2nd close</label><input data-h="close2" value="${esc(second.close || '')}" /></div>
    </div>`;
  }).join('');
}

function gbpCollectState(root) {
  const v = (name) => {
    const el = root.querySelector(`[data-gbp="${name}"]`);
    return el ? el.value.trim() : '';
  };
  const hours = {};
  root.querySelectorAll('[data-gbp-day]').forEach((row) => {
    const day = row.getAttribute('data-gbp-day');
    const closed = row.querySelector('[data-h="closed"]').checked;
    const periods = [];
    if (!closed) {
      const o1 = row.querySelector('[data-h="open"]').value.trim();
      const c1 = row.querySelector('[data-h="close"]').value.trim();
      const o2 = row.querySelector('[data-h="open2"]').value.trim();
      const c2 = row.querySelector('[data-h="close2"]').value.trim();
      if (o1 && c1) periods.push({ open: o1, close: c1 });
      if (o2 && c2) periods.push({ open: o2, close: c2 });
    }
    hours[day] = periods;
  });
  return {
    name: v('name'),
    primary_category: v('primary_category'),
    additional_categories: v('additional_categories')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    description: v('description'),
    phone: v('phone'),
    website: v('website'),
    location_mode: v('location_mode'),
    address: {
      line1: v('addr_line1'),
      line2: v('addr_line2'),
      city: v('addr_city'),
      region: v('addr_region'),
      postal_code: v('addr_postal'),
      country: v('addr_country') || 'US',
    },
    service_areas: v('service_areas')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    hours,
    attributes: {},
    photos: [],
  };
}

async function loadLeadGbp(dr, leadId) {
  const host = () => $('#ld-gbp', dr.el);
  if (!host()) return;
  let data;
  try {
    data = (await api.gbpPanel(leadId)).data;
  } catch (e) {
    host().innerHTML = `<p class="error">${esc(errText(e))}</p>`;
    return;
  }
  render(data);

  function render(d) {
    const el = host();
    if (!el) return;
    const cfg = d.config || {};
    const conn = d.connection || {};
    const pre = d.prefill || { fields: {} };
    const st = (pre && pre.proposedState) || {};
    const fieldRows = Object.values(pre.fields || {})
      .map(
        (f) => `<tr>
          <td>${esc(f.label)}</td>
          <td>${esc(f.googleText || '—')}</td>
          <td>${esc(f.proposedText || '—')} <span class="badge">${esc(f.source || '')}</span></td>
          <td>${f.conflict ? '<span class="badge warn">conflict — Google value kept</span>' : ''}</td>
        </tr>`
      )
      .join('');
    const csRows = ((d.changeSets && d.changeSets.rows) || [])
      .map((cs) => {
        const errs =
          cs.validation && !cs.validation.ok
            ? `<div class="hint" style="color:var(--coral)">${(cs.validation.errors || []).map((x) => esc(x.message)).join('<br/>')}</div>`
            : '';
        const diff = (cs.changes || [])
          .map(
            (c) =>
              `<div class="kv"><span class="k">${esc(c.label)}</span><span>${esc(c.beforeText || '—')} → <strong>${esc(c.afterText || '—')}</strong></span></div>`
          )
          .join('');
        return `<div class="kv" style="display:block">
          <span class="k">#${cs.id} ${gbpStatusBadge(cs.status)}</span>
          <span>${(cs.changes || []).length} change(s) · ${esc(fmtDate(cs.created_at))}${cs.author ? ` · ${esc(cs.author)}` : ''}</span>
          <div class="inline" style="margin-top:6px">
            <button class="btn small" data-gbp-act="diff" data-id="${cs.id}">Diff</button>
            <button class="btn small" data-gbp-act="validate" data-id="${cs.id}">Validate</button>
            <button class="btn small primary" data-gbp-act="push" data-id="${cs.id}">Push to Google</button>
          </div>
          <div class="gbp-diff" data-diff="${cs.id}" hidden>${diff || '<p class="hint">No field changes.</p>'}</div>
          ${errs}
          <span class="msg" data-gbp-msg="${cs.id}"></span>
        </div>`;
      })
      .join('');
    el.innerHTML = `
      ${
        cfg.apiPending
          ? `<p class="hint" style="border:1px solid var(--gold);background:var(--paper);border-radius:10px;padding:10px 12px"><strong>Google API access still pending</strong> — prefill, drafts and validation work now; pushing unlocks when Google approves the application. Nothing is sent to Google in the meantime.</p>`
          : ''
      }
      <div class="kv"><span class="k">Connection</span><span>${gbpStatusBadge(conn.status)} ${conn.method === 'manager' ? '· manager invite' : '· Google sign-in'}${conn.google_account_id ? ` · account ${esc(conn.google_account_id)}` : ''}${conn.last_sync_at ? ` · last sync ${esc(fmtDate(conn.last_sync_at))}` : ''}</span></div>
      <div class="row">
        <div class="field"><label>Google Place ID</label><input data-gbp-conn="place" value="${esc(conn.place_id || '')}" placeholder="ChIJ…" /></div>
      </div>
      <div class="inline">
        <button class="btn small" data-gbp-act="save-place">Save Place ID</button>
        ${
          cfg.oauthReady
            ? '<button class="btn small" data-gbp-act="connect">Connect Google</button>'
            : `<button class="btn small" disabled>Connect Google</button> <span class="hint">${esc(cfg.oauthNotConfiguredMessage || 'Google sign-in is not configured yet.')}</span>`
        }
        <button class="btn small" data-gbp-act="invite">Record manager invite</button>
        ${conn.status === 'connected' || conn.status === 'invited' ? '<button class="btn small danger" data-gbp-act="disconnect">Disconnect</button>' : ''}
        <button class="btn small" data-gbp-act="places">Refresh from Places</button>
        <span class="msg" data-gbp-msg="conn"></span>
      </div>
      ${pre.websiteNote ? `<p class="hint">${esc(pre.websiteNote)}</p>` : ''}
      <h4 style="margin:14px 0 6px">Prefill — what BitPype has vs what Google shows</h4>
      <table class="tbl"><thead><tr><th>Field</th><th>Google now</th><th>Proposed</th><th></th></tr></thead><tbody>${fieldRows}</tbody></table>
      <h4 style="margin:14px 0 6px">Edit profile draft</h4>
      <form id="ld-gbp-form">
        <div class="row">
          <div class="field"><label>Business name</label><input data-gbp="name" value="${esc(st.name || '')}" /></div>
          <div class="field"><label>Primary category</label><input data-gbp="primary_category" value="${esc(st.primary_category || '')}" /></div>
        </div>
        <div class="field"><label>Additional categories (comma-separated)</label><input data-gbp="additional_categories" value="${esc((st.additional_categories || []).join(', '))}" /></div>
        <div class="field"><label>Description (750 max)</label><textarea data-gbp="description" rows="3" maxlength="900">${esc(st.description || '')}</textarea></div>
        <div class="row">
          <div class="field"><label>Primary phone</label><input data-gbp="phone" value="${esc(st.phone || '')}" /></div>
          <div class="field"><label>Website</label><input data-gbp="website" value="${esc(st.website || '')}" /></div>
        </div>
        <div class="row">
          <div class="field"><label>Location type</label><select data-gbp="location_mode">
            <option value="storefront" ${st.location_mode !== 'service_area' ? 'selected' : ''}>Storefront (public address)</option>
            <option value="service_area" ${st.location_mode === 'service_area' ? 'selected' : ''}>Service area (address hidden)</option>
          </select></div>
          <div class="field"><label>Service areas (comma-separated)</label><input data-gbp="service_areas" value="${esc((st.service_areas || []).join(', '))}" /></div>
        </div>
        <div class="row">
          <div class="field"><label>Street address</label><input data-gbp="addr_line1" value="${esc((st.address || {}).line1 || '')}" /></div>
          <div class="field"><label>Address line 2</label><input data-gbp="addr_line2" value="${esc((st.address || {}).line2 || '')}" /></div>
        </div>
        <div class="row">
          <div class="field"><label>City</label><input data-gbp="addr_city" value="${esc((st.address || {}).city || '')}" /></div>
          <div class="field"><label>State / region</label><input data-gbp="addr_region" value="${esc((st.address || {}).region || '')}" /></div>
          <div class="field"><label>Postal code</label><input data-gbp="addr_postal" value="${esc((st.address || {}).postal_code || '')}" /></div>
          <div class="field"><label>Country</label><input data-gbp="addr_country" value="${esc((st.address || {}).country || 'US')}" /></div>
        </div>
        <details><summary>Opening hours</summary>${gbpHoursRowsHtml(st)}</details>
        <div class="inline" style="margin-top:10px">
          <button class="btn primary small" type="submit">Save draft change set</button>
          <span class="msg" data-gbp-msg="form"></span>
        </div>
      </form>
      <h4 style="margin:14px 0 6px">Change sets</h4>
      ${csRows || '<p class="hint">No change sets yet. Edit the draft above and save — nothing reaches Google without a saved change set.</p>'}
      ${
        d.reviews
          ? `<h4 style="margin:14px 0 6px">Reviews (Places sample)</h4><p class="hint">${esc(d.reviews.rating != null ? d.reviews.rating + ' ★ · ' : '')}${esc(String(d.reviews.total || 0))} reviews · ${esc(d.reviews.note || '')}</p>`
          : ''
      }`;

    const msg = (key, text, cls) => {
      const m = el.querySelector(`[data-gbp-msg="${key}"]`);
      if (m) {
        m.textContent = text;
        m.className = 'msg ' + (cls || '');
      }
    };
    const refresh = async () => render((await api.gbpPanel(leadId)).data);

    el.querySelectorAll('[data-gbp-act]').forEach((b) => {
      b.onclick = async () => {
        const act = b.getAttribute('data-gbp-act');
        const id = b.getAttribute('data-id');
        try {
          if (act === 'save-place') {
            await api.gbpConnection(leadId, { place_id: el.querySelector('[data-gbp-conn="place"]').value });
            msg('conn', 'Place ID saved', 'ok');
            refresh();
          } else if (act === 'invite') {
            await api.gbpConnection(leadId, { action: 'invite' });
            msg('conn', 'Manager invite recorded', 'ok');
            refresh();
          } else if (act === 'disconnect') {
            await api.gbpConnection(leadId, { action: 'disconnect' });
            refresh();
          } else if (act === 'connect') {
            const r = (await api.gbpOauthStart(leadId)).data;
            if (r.configured && r.url) window.location.assign(r.url);
            else msg('conn', r.message || 'Google sign-in is not configured yet.', 'err');
          } else if (act === 'places') {
            const r = (await api.gbpPlacesPrefill(leadId)).data;
            if (r.places && !r.places.ok) msg('conn', r.places.message || 'Places prefill is dormant.', 'err');
            if (r.panel) render(r.panel);
          } else if (act === 'diff') {
            const box = el.querySelector(`[data-diff="${id}"]`);
            if (box) box.hidden = !box.hidden;
          } else if (act === 'validate') {
            const r = (await api.gbpValidateChangeSet(leadId, Number(id))).data;
            msg(
              id,
              r.validation.ok
                ? 'Valid — change set is ready.'
                : 'Validation errors: ' + (r.validation.errors || []).map((x) => x.message).join(' '),
              r.validation.ok ? 'ok' : 'err'
            );
            refresh();
          } else if (act === 'push') {
            const r = (await api.gbpPushChangeSet(leadId, Number(id))).data;
            msg(id, r.ok ? 'Pushed to Google.' : r.message || 'Push did not go through.', r.ok ? 'ok' : 'err');
            if (r.ok) refresh();
          }
        } catch (e) {
          msg(id || 'conn', errText(e), 'err');
        }
      };
    });

    const form = $('#ld-gbp-form', el);
    if (form) {
      form.onsubmit = async (e) => {
        e.preventDefault();
        try {
          const state = gbpCollectState(form);
          // Photos/attributes ride along from the proposal (edited via
          // their own surfaces; not part of this form).
          state.photos = st.photos || [];
          state.attributes = st.attributes || {};
          const r = (await api.gbpCreateChangeSet(leadId, state)).data;
          msg('form', `Draft change set #${r.changeSet.id} saved (${(r.changeSet.changes || []).length} change(s))`, 'ok');
          refresh();
        } catch (err) {
          msg('form', errText(err), 'err');
        }
      };
    }
  }
}

// Batch 59: one-click Hostinger deployment panel on the lead page
// (software-interest leads only — the section itself is only rendered
// for those). States: dormant (Hostinger unconfigured) → deploy
// button → typed-DEPLOY confirmation against the LIVE catalog price →
// polled provisioning/installing → ready (instance link) | failed
// (coded reason + VM id + retry). Exactly-once is enforced server-
// side; this panel just renders the deployment the server reports.
async function loadLeadHostinger(dr, leadId) {
  const host = () => $('#ld-hostinger', dr.el);
  const wsId = api.getWorkspaceId();
  const money = (cents, currency) => {
    if (cents == null) return '—';
    try {
      return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: currency || 'USD' });
    } catch {
      return `${(cents / 100).toFixed(2)} ${currency || ''}`;
    }
  };
  const periodText = (plan) => (plan && plan.period ? ` / ${plan.period} ${plan.periodUnit || ''}`.trimEnd() : '');

  async function refresh() {
    if (!host()) return;
    let view;
    try {
      view = (await api.leadHostingerDeployment(leadId, wsId)).data;
    } catch (e) {
      const el = host();
      if (el) el.innerHTML = `<p class="hint">Deployment status could not be loaded: ${esc(errText(e))}</p>`;
      return;
    }
    if (!host()) return;
    paint(view);
    const dep = view.deployment;
    if (dep && ['queued', 'provisioning', 'installing'].includes(dep.status)) {
      setTimeout(() => {
        if (host()) refresh();
      }, 5000);
    }
  }

  function paint(view) {
    const el = host();
    if (!el) return;
    if (!view.eligible) {
      el.innerHTML = '<p class="hint">Not a software-interest lead.</p>';
      return;
    }
    if (!view.configured) {
      el.innerHTML = `<p class="hint">Hostinger is not connected yet, so this deploy button is dormant. Add the API token and the catalog defaults in <a href="#/admin/hostinger">Platform admin → Settings → Hostinger</a>${(view.missing || []).length ? ` — missing: ${esc(view.missing.join(', '))}` : ''}.</p>`;
      return;
    }
    const dep = view.deployment;
    if (!dep) return paintStart('');
    if (dep.status === 'failed') return paintFailed(dep);
    if (dep.status === 'ready') {
      el.innerHTML = `
        <p><span class="badge">ready</span> ${dep.instanceUrl ? `<a href="${esc(dep.instanceUrl)}" target="_blank" rel="noopener">${esc(dep.instanceUrl)}</a>` : ''}</p>
        ${kv('Plan', dep.planName)}${kv('Admin email', dep.adminEmail)}
        ${kv('Server', [dep.hostname, dep.ipAddress].filter(Boolean).join(' · '))}
        ${dep.emailSentAt ? `<p class="hint">Setup email sent ${esc(fmtDate(dep.emailSentAt))} — the one-time password link is good for 72 hours after the instance reported ready; after that the customer uses “Forgot password”.</p>` : '<p class="hint">No setup-email send is recorded for this deployment.</p>'}
        ${dep.warning ? `<p class="hint">⚠ ${esc(dep.warning)}</p>` : ''}`;
      return;
    }
    el.innerHTML = `
      <p><span class="badge">${esc(dep.status)}</span> Deployment #${dep.id} — ${esc(dep.planName || '')}</p>
      ${kv('Started', fmtDate(dep.createdAt))}
      ${dep.vmId ? kv('Hostinger VM', dep.vmId) : ''}
      ${dep.hostname ? kv('Hostname', dep.hostname) : ''}
      <p class="hint">${dep.status === 'installing' ? 'The server is up and the BitPype install is running on it. This panel refreshes every few seconds; the setup email goes out automatically when it finishes.' : 'Buying and booting the VPS on the connected Hostinger account. This panel refreshes every few seconds.'}</p>`;
  }

  function paintStart(note) {
    const el = host();
    if (!el) return;
    el.innerHTML = `
      ${note ? `<p class="hint">${esc(note)}</p>` : '<p class="hint">Provision a fresh Hostinger VPS and install a standard BitPype for this signup. The exact live catalog price is confirmed before anything is bought.</p>'}
      <button class="btn small" id="ld-hostinger-deploy">Deploy on Hostinger…</button>`;
    $('#ld-hostinger-deploy', el).onclick = () => showConfirm(false);
  }

  function paintFailed(dep) {
    const el = host();
    if (!el) return;
    el.innerHTML = `
      <p><span class="badge">failed</span> Deployment #${dep.id} — ${esc(dep.errorCode || 'DEPLOY_FAILED')}</p>
      <p class="hint">${esc(dep.errorDetail || '')}</p>
      ${dep.vmId ? `<p class="hint">Hostinger VM ${esc(dep.vmId)}${dep.hostname ? ` (${esc(dep.hostname)})` : ''} may still exist — check hPanel and remove it there if it is not needed.</p>` : ''}
      <button class="btn small" id="ld-hostinger-retry">Retry deployment…</button>`;
    $('#ld-hostinger-retry', el).onclick = () => showConfirm(true);
  }

  async function showConfirm(isRetry) {
    const el = host();
    if (!el) return;
    el.innerHTML = '<p class="hint">Reading the live Hostinger catalog…</p>';
    let preview;
    try {
      preview = (await api.leadHostingerPreview(leadId, wsId)).data;
    } catch (e) {
      const el2 = host();
      if (el2) {
        el2.innerHTML = `<p class="hint">${esc(errText(e))}</p><button class="btn small" id="ld-hostinger-back">Back</button>`;
        $('#ld-hostinger-back', el2).onclick = () => refresh();
      }
      return;
    }
    const el2 = host();
    if (!el2 || !preview.plan) return;
    const plan = preview.plan;
    const firstPeriod = plan.firstPeriodPriceCents != null ? plan.firstPeriodPriceCents : plan.priceCents;
    el2.innerHTML = `
      <p><strong>Confirm deployment${isRetry ? ' (retry)' : ''}</strong></p>
      ${kv('Customer', `${preview.lead.name || ''} — ${preview.lead.email || ''}`)}
      ${kv('VPS plan', plan.itemName || plan.priceId)}
      ${kv('First period', `${money(firstPeriod, plan.currency)}${plan.priceName ? ` (${esc(plan.priceName)})` : ''}`)}
      ${kv('Then', `${money(plan.priceCents, plan.currency)}${esc(periodText(plan))}`)}
      ${kv('Data center / template', `${plan.dataCenterId} / ${plan.templateId}`)}
      <p class="hint">This purchases a real VPS on the connected Hostinger account, charged to its default payment method, and installs a fresh standard BitPype whose admin account is the customer's email. A one-time password-setup link is emailed to them when it is ready.</p>
      <div class="field"><label>Type DEPLOY to confirm the purchase</label><input id="ld-hostinger-type" autocomplete="off" /></div>
      <div class="inline" style="margin-top:8px">
        <button class="btn small primary" id="ld-hostinger-confirm" disabled>Buy &amp; deploy</button>
        <button class="btn small" id="ld-hostinger-cancel">Cancel</button>
        <span class="msg" id="ld-hostinger-msg"></span>
      </div>`;
    const typeEl = $('#ld-hostinger-type', el2);
    const confirmBtn = $('#ld-hostinger-confirm', el2);
    typeEl.oninput = () => {
      confirmBtn.disabled = typeEl.value.trim() !== 'DEPLOY';
    };
    $('#ld-hostinger-cancel', el2).onclick = () => refresh();
    confirmBtn.onclick = async () => {
      const msg = $('#ld-hostinger-msg', el2);
      confirmBtn.disabled = true;
      try {
        const body = { confirmText: typeEl.value.trim(), confirmPriceCents: plan.priceCents, confirmFirstPeriodCents: firstPeriod };
        if (isRetry) await api.leadHostingerRetry(leadId, wsId, body);
        else await api.leadHostingerStart(leadId, wsId, body);
        toast('Deployment started', 'ok');
        refresh();
      } catch (e) {
        if (e && e.code === 'PRICE_CHANGED') {
          setMsg(msg, 'The catalog price changed — reloading the current price…', 'err');
          setTimeout(() => showConfirm(isRetry), 900);
          return;
        }
        setMsg(msg, errText(e), 'err');
        confirmBtn.disabled = false;
      }
    };
  }

  refresh();
}

/* Batch 78 — the lead detail is a full routed page (#/leads/<id>), not
   a slide-over drawer. `dr` is the page handle ({ el, body, title,
   close }) the section loaders (Onboarding / Google Profile /
   Hostinger) were written against; it now points at the page DOM and
   close() navigates back to the leads list. */
async function pageLeadDetail(id, query) {
  view.innerHTML = `
    <div class="page-head">
      <div><h1 id="ld-title">Lead #${esc(id)}</h1><p class="lede">Details, score &amp; intent, website, onboarding checklist, Google Profile, facts and timeline — everything about this lead on one page.</p></div>
      <div class="page-actions"><button class="btn" data-act="back">← Back to leads</button></div>
    </div>
    <div class="lead-page" id="ld-body"><p class="hint">Loading…</p></div>`;
  const dr = {
    el: view,
    body: $('#ld-body', view),
    title: $('#ld-title', view),
    close() {
      window.location.hash = '#/leads';
    },
  };

  async function reload() {
    const [leadR, tlR, psR, intR, siteR] = await Promise.allSettled([
      api.leadGet(id),
      api.leadTimeline(id, 60),
      api.leadProspectScore(id),
      api.intentGet(id),
      api.websiteByLead(id),
    ]);
    if (leadR.status !== 'fulfilled') {
      dr.body.innerHTML = `<p class="error">${esc(errText(leadR.reason))}</p>`;
      return;
    }
    const data = leadR.value.data;
    const lead = data.lead || {};
    const facts = data.facts || [];
    const timeline = tlR.status === 'fulfilled' ? tlR.value.data.timeline || [] : data.events || [];
    const ps = psR.status === 'fulfilled' ? psR.value.data : null;
    const intent = intR.status === 'fulfilled' ? intR.value.data : null;
    const site = siteR.status === 'fulfilled' ? siteR.value.data.site : null;
    const breakdown = ps && ps.latest ? parseJson(ps.latest.breakdown, {}) : {};
    // Verified data often lives only in business_facts (research stores it
    // there without back-filling the lead row) — fall back to the fact value
    // for the summary rows so the drawer doesn't show blanks it already knows.
    const factFallback = (key) => {
      const cands = facts.filter((x) => x.fact_key === key && x.value);
      const pref =
        cands.find((x) => x.claim_class === 'VERIFIED' || x.claim_class === 'OWNER_PROVIDED') || cands[0];
      return pref ? String(pref.value) : '';
    };
    const addressText =
      [lead.address, lead.city, lead.state, lead.postal_code].filter(Boolean).join(', ') ||
      factFallback('address');
    const ratingText =
      lead.rating != null ? `${lead.rating} (${lead.review_count || 0} reviews)` : factFallback('rating');
    const fmtUsPhone = (raw) => {
      const d = String(raw || '').replace(/\D/g, '');
      const n = d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
      return n.length === 10 ? `(${n.slice(0, 3)}) ${n.slice(3, 6)}-${n.slice(6)}` : '';
    };
    const phoneDisplay = fmtUsPhone(lead.phone);
    // Batch 59: the one-click Hostinger deploy lives on software-
    // interest leads only (the /landing signups), super-admin only —
    // its API is platform-admin regardless.
    const isSoftwareLead =
      !!currentUserIsSuperAdmin &&
      (String(lead.lead_group || '').toLowerCase() === 'software interest' ||
        lead.source === 'landing-software' ||
        (lead.tags || []).includes('landing-software') ||
        (lead.tags || []).includes('software-interest'));

    dr.title.textContent = lead.business_name || 'Lead #' + id;
    dr.body.innerHTML = `
      <div class="inline" style="margin:10px 0 0">
        <button class="btn small" data-act="score">Score</button>
        <button class="btn small" data-act="qualify">Qualify</button>
        <button class="btn small" data-act="research">Research</button>
        <button class="btn small" data-act="dupes">Find duplicates</button>
        <button class="btn small" data-act="pipeline">Record intent</button>
        <button class="btn small" data-act="queue-sms">Queue SMS</button>
        <button class="btn small" data-act="rent">Rent a site</button>
        <button class="btn small danger" data-act="delete">Delete</button>
      </div>
      <div id="ld-merge"></div>
      <section><h3>Details</h3>
        <form id="ld-form">
          <div class="row">
            <div class="field"><label>Status</label><select name="status">${optionList(LEAD_STATUSES, lead.status)}</select></div>
            <div class="field"><label>Category</label><input name="category" value="${esc(lead.category || '')}" /></div>
          </div>
          <div class="row">
            <div class="field"><label>Email</label><input name="email" value="${esc(lead.email || '')}" /></div>
            <div class="field"><label>Phone</label><input name="phone" value="${esc(lead.phone || '')}" />${phoneDisplay && phoneDisplay !== lead.phone ? `<div class="hint">${esc(phoneDisplay)}</div>` : ''}</div>
          </div>
          <div class="row">
            <div class="field"><label>Website</label><input name="website" value="${esc(lead.website || '')}" /></div>
            <div class="field"><label>City</label><input name="city" value="${esc(lead.city || '')}" /></div>
          </div>
          <div class="field"><label>Notes</label><textarea name="notes" style="min-height:60px">${esc(lead.notes || '')}</textarea></div>
          <div class="inline"><button class="btn primary small" type="submit">Save changes</button><span class="msg" id="ld-msg"></span></div>
        </form>
        ${kv('Group', lead.lead_group)}${kv('Source', lead.source)}${kv('Tags', (lead.tags || []).join(', '))}
        ${kv('Address', addressText)}
        ${kv('Rating', ratingText)}
        ${lead.description ? kv('Description', lead.description) : ''}
        ${lead.qualification_note ? kv('Qualification', lead.qualification_note) : ''}
      </section>
      <section><h3>Score &amp; intent</h3>
        ${kv('Score', ps ? `${ps.score} — band: ${ps.label}` : lead.score)}
        ${kv('Marked qualified', lead.qualified ? 'Yes' : 'No')}
        ${kv('Intent', intent ? `${intent.score} · ${intent.label}` : '')}
        ${Object.keys(breakdown)
          .map((k) => kv(k, '+' + breakdown[k]))
          .join('')}
      </section>
      <section><h3>Website</h3>
        ${
          site
            ? `<p><a href="#/websites/${site.id}">${esc(site.name)}</a> ${statusBadge(site.status)}</p>
           <div class="inline" style="margin-top:8px">
             <button class="btn small" data-act="postcard">Postcard / QR</button>
           </div>
           <div id="ld-claim-kit" class="hint" style="margin-top:8px"></div>`
            : `<p class="hint">No website yet.</p><button class="btn small" data-act="gen">Build template site</button>`
        }
      </section>
      <section><h3>Onboarding checklist</h3>
        <div id="ld-onboarding"><p class="hint">Loading…</p></div>
      </section>
      <section><h3>Google Profile</h3>
        <div id="ld-gbp"><p class="hint">Loading…</p></div>
      </section>
      ${isSoftwareLead ? `<section><h3>Software deployment</h3>
        <div id="ld-hostinger"><p class="hint">Loading…</p></div>
      </section>` : ''}
      <section><h3>Social (Facebook / Instagram)</h3>
        <p class="hint">Generate a month of posts, weekly client approval, then schedule to Meta. Images optional.</p>
        <a class="btn small" href="#/social?leadId=${esc(id)}">Open Social for this lead</a>
      </section>
      <section><h3>Facts &amp; provenance (${facts.length})</h3>
        ${
          facts
            .map(
              (
                f
              ) => `<div class="kv"><span class="k">${esc(f.fact_key)}</span><span>${esc(String(f.value).slice(0, 400))} <span class="badge claim-${esc(f.claim_class)}">${esc(f.claim_class)}</span></span>
          <span class="sub-line">source: ${esc(f.source)}${f.source_url ? ` · <a href="${esc(f.source_url)}" target="_blank" rel="noopener">link</a>` : ''} · ${esc(f.confidence)} · ${esc(fmtDate(f.fetched_at))}</span></div>`
            )
            .join('') || '<p class="hint">No facts yet. Run Research.</p>'
        }
        <details style="margin-top:10px"><summary>Add a fact</summary>
          <form id="ld-fact">
            <div class="row">
              <div class="field"><label>Key</label><input name="fact_key" placeholder="phone" required /></div>
              <div class="field"><label>Claim class</label><select name="claim_class">${optionList(CLAIM_CLASSES, 'OWNER_PROVIDED')}</select></div>
            </div>
            <div class="field"><label>Value</label><input name="value" required /></div>
            <div class="row">
              <div class="field"><label>Source</label><input name="source" value="manual" required /></div>
              <div class="field"><label>Confidence</label><select name="confidence">${optionList(['high', 'medium', 'low'], 'medium')}</select></div>
            </div>
            <button class="btn small" type="submit">Add fact</button>
          </form>
        </details>
      </section>
      <section><h3>Timeline</h3>
        ${timeline.map((ev) => `<div class="kv"><span class="k">${esc(ev.type)}</span><span>${esc(ev.detail || '')}</span><span class="sub-line">${esc(ev.kind || '')} · ${esc(fmtDate(ev.at))}</span></div>`).join('') || '<p class="hint">No events yet.</p>'}
      </section>`;

    loadLeadGbp(dr, id);
    loadLeadOnboarding(dr, id);
    if (isSoftwareLead) loadLeadHostinger(dr, id);

    guardSubmit($('#ld-form', dr.el), async (e) => {
      e.preventDefault();
      const msg = $('#ld-msg', dr.el);
      try {
        await api.patchLead(id, formObject(e.target));
        setMsg(msg, 'Saved', 'ok');
        if (leadsReload) leadsReload();
      } catch (err) {
        setMsg(msg, errText(err), 'err');
      }
    });
    guardSubmit($('#ld-fact', dr.el), async (e) => {
      e.preventDefault();
      await safeRun(null, async () => {
        await api.leadFacts(id, formObject(e.target));
        toast('Fact added', 'ok');
        await reload();
      });
    });
  }

  delegate(dr.el, {
    back: () => {
      window.location.hash = '#/leads';
    },
    rent: () => {
      rentalsPreselect = { tenantLeadId: id };
      window.location.hash = '#/rentals';
    },
    score: async () => {
      const r = await api.scoreLead(id);
      toast('Score: ' + r.data.score, 'ok');
      await reload();
      if (leadsReload) leadsReload();
    },
    qualify: async () => {
      const r = await api.qualifyLead(id);
      const q = r.data.lead || {};
      toast(
        q.qualified ? 'QUALIFIED' : 'Not qualified — ' + (q.note || 'see qualification note'),
        q.qualified ? 'ok' : ''
      );
      await reload();
      if (leadsReload) leadsReload();
    },
    research: async () => {
      toast('Researching…');
      const r = await api.researchLead(id);
      toast(
        `Research complete${r.data && r.data.facts != null ? ': ' + (r.data.facts.length != null ? r.data.facts.length : r.data.facts) + ' facts' : ''}`,
        'ok'
      );
      await reload();
      if (leadsReload) leadsReload();
    },
    dupes: async () => {
      const box = $('#ld-merge', dr.el);
      const r = await api.leadDuplicates(id);
      const dups = r.data.duplicates || [];
      if (!dups.length) {
        box.innerHTML = '<p class="hint">No duplicate candidates found.</p>';
        return;
      }
      box.innerHTML =
        `<h3 style="margin-top:14px">Merge into this lead (keeps this record)</h3>` +
        dups
          .map(
            (d) =>
              `<label class="pick-row"><input type="checkbox" class="merge-check" value="${d.id}" /><span><b>${esc(d.business_name)}</b> (#${d.id}) — matched on ${esc((d.matched_on || []).join(', '))}</span></label>`
          )
          .join('') +
        '<button class="btn danger small" data-act="merge" style="margin-top:8px">Merge selected</button>';
    },
    merge: async () => {
      const dropIds = $$('.merge-check:checked', dr.el).map((c) => Number(c.value));
      if (!dropIds.length) {
        toast('Select at least one duplicate.', 'err');
        return;
      }
      if (!window.confirm(`Merge ${dropIds.length} lead(s) into #${id}? Merged records are deleted.`)) return;
      await api.mergeLeads(id, dropIds);
      toast('Merged', 'ok');
      await reload();
      if (leadsReload) leadsReload();
    },
    pipeline: () => openIntentModal(id, reload),
    'queue-sms': () => openQueueSmsModal(id),
    postcard: async () => {
      const box = $('#ld-claim-kit', dr.el);
      if (box) box.innerHTML = '<span class="hint">Loading…</span>';
      try {
        const kit = (await api.leadClaimKit(id)).data || {};
        if (box) {
          box.innerHTML = `
            ${kit.siteUrl ? `<div class="kv"><span class="k">Site</span><span><a href="${esc(kit.siteUrl)}" target="_blank" rel="noopener">${esc(kit.siteUrl)}</a></span></div>` : '<p class="hint">No site URL yet.</p>'}
            ${kit.claimUrl ? `<div class="kv"><span class="k">Claim</span><span><a href="${esc(kit.claimUrl)}" target="_blank" rel="noopener">${esc(kit.claimUrl)}</a></span></div>` : ''}
            <div class="inline" style="gap:12px;margin-top:8px;flex-wrap:wrap">
              ${kit.siteQrDataUrl ? `<img src="${esc(kit.siteQrDataUrl)}" alt="Site QR" width="96" height="96" />` : ''}
              ${kit.claimQrDataUrl ? `<img src="${esc(kit.claimQrDataUrl)}" alt="Claim QR" width="96" height="96" />` : ''}
            </div>`;
        }
        await api.leadPostcard(id);
        toast('Postcard downloaded', 'ok');
      } catch (e) {
        if (box) box.innerHTML = `<span class="error">${esc(errText(e))}</span>`;
        toast(errText(e), 'err');
      }
    },
    gen: async () => {
      toast('Building template site…');
      await api.generateSite({ leadId: id, force: true, fallback: true });
      toast('Site built', 'ok');
      await reload();
    },
    delete: async () => {
      // Batch 45 (B1): show the pre-flight reference summary in the
      // confirm — a lead delete archives (never silently destroys) any
      // live website first, and retires its domain links.
      let refs = null;
      try {
        refs = (await api.leadReferences(id)).data.references;
      } catch {
        refs = null;
      }
      let msg = 'Delete this lead? This cannot be undone.';
      if (refs) {
        const parts = [];
        if (refs.websites) {
          parts.push(
            `${refs.websites} website(s) (${refs.websitesActive} live, ${refs.websitesArchived} archived) — live sites are archived first, never silently destroyed`
          );
        }
        if (refs.siteDomains) parts.push(`${refs.siteDomains} domain link(s) will be retired`);
        if (refs.designJobs) parts.push(`${refs.designJobs} design job(s) keep their own lifecycle`);
        if (refs.domainTransactions) parts.push(`${refs.domainTransactions} domain transaction record(s) stay as history`);
        if (refs.formSubmissions) parts.push(`${refs.formSubmissions} form submission(s) will be deleted`);
        if (refs.bookings) parts.push(`${refs.bookings} booking(s) keep their records`);
        if (refs.callLogs) parts.push(`${refs.callLogs} call log(s) keep their records`);
        if (parts.length) msg = `Delete this lead?\n\n${parts.join('\n')}\n\nThis cannot be undone.`;
      }
      if (!window.confirm(msg)) return;
      await api.deleteLead(id);
      toast('Lead deleted', 'ok');
      dr.close();
      if (leadsReload) leadsReload();
    },
  });
  await reload();
}

async function openIntentModal(leadId, onDone) {
  let cur = null;
  try {
    cur = (await api.intentGet(leadId)).data;
  } catch {
    /* optional */
  }
  openModal({
    title: 'Record intent event',
    body: `<p class="hint">Current intent: <b>${esc(cur ? `${cur.score} · ${cur.label}` : '—')}</b></p>
      <div class="field"><label>Event</label><select id="in-ev">${optionList(INTENT_EVENTS, 'email.opened', (v) => v)}</select></div>
      <div class="field"><label>Note (optional)</label><input id="in-note" type="text" /></div>
      <div class="msg" id="in-msg"></div>`,
    buttons: [
      { label: 'Close' },
      {
        label: 'Record',
        cls: 'primary',
        onClick: async (m) => {
          const r = await api.intentRecord(
            leadId,
            $('#in-ev', m.el).value,
            $('#in-note', m.el).value.trim() || undefined
          );
          setMsg($('#in-msg', m.el), `Intent now ${r.data.score} · ${r.data.label}`, 'ok');
          if (onDone) onDone();
        },
      },
    ],
  });
}

/* ------------------------------------------------------------------ */
/* Websites                                                            */
/* ------------------------------------------------------------------ */

const sitesState = { page: 1, status: '' };

async function assignDesignJob(leadId, shape) {
  let instructions =
    'Design a complete custom website for this business. Use verified facts for contact details; marketing glue as AI_COPY.';
  try {
    const d = await api.designDefaultInstructions();
    if (d.data && d.data.website) instructions = d.data.website;
  } catch {
    /* use fallback */
  }
  const r = await api.designCreate({
    type: 'website',
    title: 'Website for lead #' + leadId,
    instructions,
    leadId,
    site_shape: shape || 'multipage',
  });
  return r.data.job;
}

/** Batch 27 — Archives: soft-deleted websites with a Restore button each. */
async function pageArchives() {
  view.classList.remove('wide');
  view.innerHTML = `
    <div class="card">
      <h3>Archived websites</h3>
      <p class="hint">Deleting a website archives it: pages, versions, forms, modules and data are all preserved, but the site no longer shows publicly or in the Websites list. Restore brings it back exactly as it was.</p>
      <span class="msg" id="arch-msg"></span>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>Name</th><th>Business</th><th>Status</th><th>Archived</th><th></th></tr></thead>
      <tbody id="arch-body">${loadRowHtml(5, 'Loading archives…')}</tbody>
    </table></div>`;

  async function load() {
    let r;
    try {
      r = await withLoadTimeout(api.websitesArchived());
    } catch (e) {
      const b = $('#arch-body');
      if (b) b.innerHTML = loadErrorRowHtml(5, 'arch-retry', errText(e));
      return;
    }
    const body = $('#arch-body');
    if (!body) return;
    const sites = asList(r.data || {}, ['sites', 'rows']);
    body.innerHTML =
      sites
        .map(
          (s) => `<tr>
      <td>${esc(s.name)}</td>
      <td>${esc(s.business_name || '#' + s.lead_id)}</td>
      <td>${statusBadge(s.status)}</td><td>${esc(fmtDate(s.archived_at))}</td>
      <td class="actions"><button type="button" class="btn small primary" data-act="restore" data-id="${s.id}" data-name="${esc(s.name)}">Restore</button> <button type="button" class="btn small danger" data-act="purge" data-id="${s.id}" data-name="${esc(s.name)}">Purge</button></td></tr>`
        )
        .join('') || '<tr><td colspan="5" class="empty">No archived websites.</td></tr>';
  }
  delegate(view, {
    'arch-retry': () => load(),
    // Batch 45 — permanent purge: type-to-confirm (exact site name),
    // enforced again server-side. This is the ONLY hard website delete.
    purge: async (t) => {
      const id = Number(t.dataset.id);
      const name = t.dataset.name || '';
      const typed = window.prompt(
        `PERMANENTLY delete the archived website "${name}"?\n\nThis destroys its pages, versions and export files and cannot be undone. Type the exact site name to confirm:`
      );
      if (typed == null) return;
      if (typed !== name) {
        setMsg($('#arch-msg'), 'Purge cancelled — the name did not match.', 'err');
        return;
      }
      try {
        await api.websitePurge(id, typed);
        toast(`Website #${id} purged permanently`, 'ok');
        setMsg($('#arch-msg'), `Purged website #${id} permanently.`, 'ok');
        await load();
      } catch (e) {
        setMsg($('#arch-msg'), errText(e), 'err');
        toast(errText(e), 'err');
      }
    },
    restore: async (t) => {
      const id = Number(t.dataset.id);
      const name = t.dataset.name || '#' + id;
      if (!window.confirm(`Restore website "${name}"? It returns to the Websites list with everything intact.`)) return;
      try {
        await api.websiteUnarchive(id);
        toast(`Website #${id} restored`, 'ok');
        setMsg($('#arch-msg'), `Restored website #${id}.`, 'ok');
        await load();
      } catch (e) {
        setMsg($('#arch-msg'), errText(e), 'err');
        toast(errText(e), 'err');
      }
    },
  });
  await load();
}

async function pageWebsites(param) {
  if (param) return pageWebsiteDetail(Number(param));

  view.innerHTML = `
    <div class="page-head"><div><h1>Websites</h1><p class="lede">Agent-delivered and template sites for this workspace. Open one to preview, run QA, export, restore versions or publish.</p></div></div>
    <div class="card">
      <h3>Build a website for a lead</h3>
      <div class="row end">
        <div class="field" style="flex:2"><label class="lbl">Lead</label><div id="w-lead"></div></div>
        <div class="field" style="max-width:200px"><label class="lbl" for="w-shape">Site shape</label>
          <select id="w-shape"><option value="multipage">Multi-page</option><option value="landing">Landing page</option></select></div>
      </div>
      <div class="inline">
        <button class="btn primary" data-act="assign">Assign to design agent</button>
        <button class="btn" data-act="template">Build template site</button>
        <span class="msg" id="w-msg"></span>
      </div>
    </div>
    <div class="toolbar">
      <select id="w-status"><option value="">All statuses</option>${optionList(['draft', 'qa_pending', 'approved', 'ready', 'published'], sitesState.status)}</select>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>Name</th><th>Lead</th><th>Status</th><th>Origin</th><th>Updated</th><th></th></tr></thead>
      <tbody id="w-body">${loadRowHtml(6, 'Loading websites…')}</tbody>
    </table></div>
    <div class="pagination" id="w-pager"></div>`;

  const picker = mountLeadPicker($('#w-lead'));

  const sitesGate = latestGate();
  async function load() {
    const mine = sitesGate();
    let r;
    try {
      r = await withLoadTimeout(api.websites({ page: sitesState.page, pageSize: 25, status: sitesState.status }));
    } catch (e) {
      const b = $('#w-body');
      if (!mine() || !b) return;
      b.innerHTML = loadErrorRowHtml(6, 'w-retry', errText(e));
      return;
    }
    const body = $('#w-body');
    if (!mine() || !body) return;
    const d = r.data || {};
    const sites = asList(d, ['sites', 'rows']);
    body.innerHTML =
      sites
        .map(
          (s) => `<tr>
      <td><button class="link-btn" data-act="open" data-id="${s.id}">${esc(s.name)}</button></td>
      <td>${esc(s.business_name || '#' + s.lead_id)}</td>
      <td>${statusBadge(s.status)}</td><td>${esc(s.origin || '—')}</td><td>${esc(fmtDate(s.updated_at))}</td>
      <td class="actions"><button type="button" class="btn small danger" data-act="delete" data-id="${s.id}" data-name="${esc(s.name)}">Archive</button></td></tr>`
        )
        .join('') || '<tr><td colspan="6" class="empty">No websites yet. Build one for a lead above.</td></tr>';
    pager($('#w-pager'), { page: d.page || 1, pages: d.pages || 1, total: d.total || sites.length }, (p) => {
      sitesState.page = p;
      load();
    });
  }
  $('#w-status').addEventListener('change', (e) => {
    sitesState.status = e.target.value;
    sitesState.page = 1;
    load();
  });

  delegate(view, {
    'w-retry': () => {
      const b = $('#w-body');
      if (b) b.innerHTML = loadRowHtml(6, 'Loading websites…');
      load();
    },
    open: (t) => {
      window.location.hash = '#/websites/' + t.dataset.id;
    },
    delete: async (t) => {
      const id = Number(t.dataset.id);
      const name = t.dataset.name || '#' + id;
      if (
        !window.confirm(
          `Archive website \"${name}\"?

The site will be soft-deleted: it disappears from public view and the Websites list, but everything (pages, versions, forms, modules, data) is preserved and it can be restored from Archives at any time.`
        )
      )
        return;
      try {
        await api.websiteDelete(id);
        toast(`Website #${id} archived`, 'ok');
        setMsg($('#w-msg'), `Archived website #${id}. Restore it from Archives.`, 'ok');
        await load();
      } catch (e) {
        setMsg($('#w-msg'), errText(e), 'err');
        toast(errText(e), 'err');
      }
    },
    assign: async () => {
      const lead = picker.get();
      if (!lead) {
        setMsg($('#w-msg'), 'Select a lead first.', 'err');
        return;
      }
      setMsg($('#w-msg'), 'Assigning to the agent…');
      const job = await assignDesignJob(lead.id, $('#w-shape').value);
      setMsg($('#w-msg'), `Design job #${job.id} is ${pretty(job.status)}.`, 'ok');
      toast(`Design job #${job.id} queued`, 'ok');
    },
    template: async () => {
      const lead = picker.get();
      if (!lead) {
        setMsg($('#w-msg'), 'Select a lead first.', 'err');
        return;
      }
      if (!window.confirm('Build a local template site? This replaces an agent delivery for that lead.')) return;
      setMsg($('#w-msg'), 'Building from the template…');
      const r = await api.generateSite({ leadId: lead.id, force: true, fallback: true });
      setMsg($('#w-msg'), `Template site #${r.data.id} built.`, 'ok');
      load();
    },
  });
  await load();
}

async function pageWebsiteDetail(id) {
  const [siteR, verR, cfR] = await Promise.all([
    api.websiteGet(id),
    api.websiteVersions(id, { pageSize: 30 }).catch(() => null),
    api.cfGet().catch(() => null),
  ]);
  const site = siteR.data.site || {};
  let manifest = null;
  try {
    manifest = (await api.websiteByLead(site.lead_id)).data.site;
  } catch {
    /* optional */
  }
  let pages = parseJson(site.pages, []);
  const theme = parseJson(site.theme, {});
  const versions = verR ? asList(verR.data, ['versions', 'rows']) : [];
  const versionsTotal = verR && verR.data && Number(verR.data.total) ? Number(verR.data.total) : versions.length;
  const versionRowHtml = (v) => `<div class="shell-log-line">
              <span class="shell-dim">v${esc(v.version_no)}</span><span class="shell-main">${esc(v.note || '—')}</span>
              <span class="shell-meta">${esc(fmtDate(v.created_at))} · <button type="button" class="shell-link" data-act="restore" data-v="${v.id}">Restore</button></span>
            </div>`;
  const cf = cfR ? cfR.data : null;
  let structPageIdx = 0;

  view.innerHTML = `
    <div class="page-head">
      <div>
        <a href="#/websites" class="btn small">&larr; All websites</a>
        <h1 style="margin-top:10px">${esc(site.name || 'Website #' + id)}</h1>
        <p class="lede">${statusBadge(site.status)} <span class="badge">${esc(site.origin || 'template')}</span>
          · Lead <a href="#/leads/${esc(site.lead_id)}">#${esc(site.lead_id)}</a> · updated ${esc(fmtDate(site.updated_at))}</p>
      </div>
      <div class="page-actions">
        <button class="btn" data-act="qa">Run QA</button>
        <button class="btn" data-act="export">Export</button>
        <button class="btn" data-act="download-zip">Download ZIP</button>
        <button class="btn" data-act="postcard">Postcard / QR</button>
        <button class="btn" data-act="url">Preview URL</button>
        <button class="btn" data-act="photos">Add photos</button>
        <button class="btn" data-act="optimize">Optimize images</button>
        <button class="btn" data-act="regen">Regenerate</button>
        <button class="btn" data-act="assign">Assign design job</button>
        <button class="btn" data-act="rent">Rent to lead</button>
        <button class="btn primary" data-act="publish">Publish to Cloudflare</button>
        <button class="btn danger" data-act="delete">Archive</button>
      </div>
    </div>
    ${
      site.has_shop_module && site.shop_stripe_configured === false
        ? '<div class="alert warn" style="margin-bottom:14px">Shop payments are not configured — checkout is disabled until Stripe keys are saved in <a href="#/settings/shop">Settings → Shop payments</a>. Products with their own checkout links are unaffected.</div>'
        : ''
    }
    <div class="detail-grid website-detail">
      <div>
        <div class="card"><h3>Preview</h3><div id="wd-preview"></div></div>
        <div class="card"><h3>Fonts</h3>
          <div class="font-toolbar">
            <p class="hint">Pick site fonts for a live preview update. Save to keep them, or style one element in the preview.</p>
            <div class="font-toolbar-row">
              <div class="field"><label class="lbl" for="wd-font-body">Site</label><select id="wd-font-body"></select></div>
              <div class="field"><label class="lbl" for="wd-font-heading">Headings</label><select id="wd-font-heading"></select></div>
              <button type="button" class="btn small" id="wd-font-save">Save site fonts</button>
            </div>
            <hr class="font-toolbar-divider" />
            <div class="font-toolbar-row is-actions">
              <button type="button" class="btn small" id="wd-font-edit">Style an element</button>
              <div class="field"><label class="lbl" for="wd-font-element">This element</label><select id="wd-font-element" disabled></select></div>
              <span class="msg" id="wd-font-msg"></span>
            </div>
            <p class="hint" style="margin-top:6px">“This element” stays disabled until you click “Style an element” and select text in the preview.</p>
          </div>
        </div>
      </div>
      <div>
        <div class="card"><h3>Actions &amp; results</h3>
          <div id="wd-out" class="hint">Run QA, export, or publish to see results here.</div>
          ${cf && !cf.configured ? '<p class="hint">Cloudflare is not configured. <a href="#/settings/cloudflare">Add credentials in Settings</a> to publish.</p>' : ''}
        </div>
        <div class="card"><h3>Postcard &amp; claim QR</h3>
          <p class="hint">Printable 4×6 postcard with a site QR and a claim QR (Yes / No). Claim uses the same interest path as outreach links.</p>
          ${
            site.claim_popup
              ? `<p class="hint">Claim popup: ${
                  site.claim_popup.state === 'injected'
                    ? 'injected'
                    : site.claim_popup.state === 'suppressed'
                      ? 'suppressed — ' + esc(site.claim_popup.reason || 'off')
                      : 'status unavailable'
                }${
                  site.claim_popup.expires_at
                    ? ' · ' +
                      (site.claim_popup.expired
                        ? '7-day hold ended ' +
                          esc(
                            new Date(site.claim_popup.expires_at).toLocaleDateString('en-US', {
                              month: 'short',
                              day: 'numeric',
                              year: 'numeric',
                            })
                          )
                        : '7-day hold ends ' +
                          esc(
                            new Date(site.claim_popup.expires_at).toLocaleDateString('en-US', {
                              month: 'short',
                              day: 'numeric',
                              year: 'numeric',
                            })
                          ) +
                          (site.claim_popup.days_remaining != null
                            ? ' (' + site.claim_popup.days_remaining + 'd left)'
                            : ''))
                    : ''
                }</p>`
              : ''
          }
          <div id="wd-claim-kit" class="hint">Open Postcard / QR to load links.</div>
        </div>
        <div class="card"><h3>Preview screenshots</h3>
          <p class="hint">Desktop/mobile captures of home + services for outreach. Email uses a JPEG ≤1200px; SMS/MMS uses a &lt;900KB JPEG. Each lead gets their own site’s shots via {{site_screenshot}}.</p>
          <div id="wd-shots" class="hint">Loading…</div>
          <div class="inline" style="margin-top:8px">
            <button type="button" class="btn small" data-act="shots-regen">Regenerate screenshots</button>
            <span class="msg" id="wd-shots-msg"></span>
          </div>
        </div>
        <div class="card"><h3>Versions (${versionsTotal})</h3>
          <div class="shell-log shell-log-lines" id="wd-ver-list" tabindex="0">
            ${versions.map(versionRowHtml).join('') || '<p class="shell-empty">No versions saved yet.</p>'}
          </div>
          <div id="wd-ver-more-wrap" style="margin-top:8px">
            ${
              versions.length < versionsTotal
                ? `<button type="button" class="btn small" data-act="versions-more">Show more versions (${versions.length} of ${versionsTotal})</button>`
                : ''
            }
          </div>
        </div>
        <div class="card" id="wd-structure-card"><h3>Menu &amp; sections</h3>
          <p class="hint">Reorder (↑↓), nest submenu (→), or unnest (←). Home stays first; banner / hero / nav stay fixed.</p>
          <div id="wd-structure"></div>
          <span class="msg" id="wd-struct-msg"></span>
          <div class="swatches" style="margin-top:10px">${['primary', 'secondary', 'bg', 'text']
            .filter((k) => theme[k])
            .map(
              (k) =>
                `<span class="swatch" title="${esc(k)} ${esc(theme[k])}" style="background:${esc(theme[k])}"></span>`
            )
            .join('')}</div>
        </div>
        <div class="card"><h3>Logo</h3>
          <p class="hint">Text brand name (default) or an uploaded image logo (transparent PNG, header-sized).</p>
          <div class="inline" style="align-items:center;gap:12px;margin:8px 0">
            <label><input type="radio" name="wd-logo-mode" value="text" ${theme.logoMode === 'image' && theme.logoUrl ? '' : 'checked'} /> Text</label>
            <label><input type="radio" name="wd-logo-mode" value="image" ${theme.logoMode === 'image' && theme.logoUrl ? 'checked' : ''} /> Image</label>
          </div>
          <div id="wd-logo-preview" style="min-height:48px;margin:8px 0;display:flex;align-items:center">
            ${
              theme.logoMode === 'image' && theme.logoUrl
                ? `<img src="${esc(theme.logoUrl)}" alt="Logo" style="max-height:44px;max-width:200px;object-fit:contain;background:repeating-conic-gradient(#eee 0% 25%,#fff 0% 50%) 50%/12px 12px" />`
                : `<strong>${esc(theme.brandName || site.name || 'Business')}</strong>`
            }
          </div>
          <div class="inline" style="margin-top:8px">
            <button class="btn small" data-act="logo-upload" type="button">Upload logo</button>
            <button class="btn small" data-act="logo-text" type="button">Use text logo</button>
            <span class="msg" id="wd-logo-msg"></span>
          </div>
        </div>
        <div class="card"><h3>Edit JSON</h3>
          <p class="hint">Advanced: edit pages + theme directly. Saving creates a new version.</p>
          <textarea id="wd-json" class="json" spellcheck="false">${esc(JSON.stringify({ pages, theme }, null, 2))}</textarea>
          <div class="inline" style="margin-top:8px"><button class="btn primary small" data-act="save">Save as new version</button><span class="msg" id="wd-save-msg"></span></div>
        </div>
        ${manifest && manifest.manifest ? `<div class="card"><details><summary>Claim manifest</summary>${jsonPre(manifest.manifest)}</details></div>` : ''}
      </div>
    </div>`;

  let fontHooks = null;
  const preview = mountPreview($('#wd-preview'), (slug) => api.websiteRender(id, { editable: true, pageSlug: slug }), {
    onPreview: (data) => {
      if (fontHooks) fontHooks.onPreview(data);
    },
  });
  fontHooks = bindFontToolbar(
    'wd',
    preview,
    () => pages,
    () => theme,
    (nextPages, nextTheme) => api.websiteSave(id, { pages: nextPages, theme: nextTheme, note: 'Site fonts' })
  );
  const out = $('#wd-out');
  const PINNED_SEC = new Set(['nav', 'hero', 'banner']);
  function isHomeLikeAdmin(p, list) {
    const slug = String((p && p.slug) || '')
      .toLowerCase()
      .replace(/\.html$/i, '');
    if (slug === '' || slug === '/' || slug === 'home' || slug === 'index') return true;
    return Array.isArray(list) && list[0] === p;
  }
  function sectionLabelAdmin(s, i) {
    const t = String((s && s.type) || 'block');
    const c = (s && s.content) || {};
    const title = c.title || c.heading || c.label || '';
    return title ? `${t}: ${String(title).slice(0, 40)}` : `${t} #${i + 1}`;
  }
  let structMenu = null;
  async function loadWdStructureSummary() {
    try {
      const r = await api.websiteStructure(id);
      const data = r && r.data ? r.data : r;
      structMenu = (data && data.menu) || null;
    } catch {
      structMenu = null;
    }
  }
  function renderWdStructure() {
    const host = $('#wd-structure');
    if (!host) return;
    if (!pages.length) {
      host.innerHTML = '<p class="hint">No pages.</p>';
      return;
    }
    if (structPageIdx >= pages.length) structPageIdx = Math.max(0, pages.length - 1);
    const menuItems =
      Array.isArray(structMenu) && structMenu.length
        ? structMenu
        : pages.map((p, i) => ({
            index: i,
            depth: p.menuParent || p.menu_parent ? 1 : 0,
            slug: p.slug,
            title: p.title || p.slug,
            pinned: isHomeLikeAdmin(p, pages) && i === 0,
            canUp: i > 0 && !(isHomeLikeAdmin(pages[i - 1], pages) && i - 1 === 0),
            canDown: i < pages.length - 1 && !isHomeLikeAdmin(p, pages),
            canNest: i > 0 && !(p.menuParent || p.menu_parent) && !isHomeLikeAdmin(p, pages),
            canUnnest: !!(p.menuParent || p.menu_parent),
          }));
    const menuHtml = menuItems
      .map((item) => {
        const pinned = !!item.pinned;
        const depth = Number(item.depth) === 1 ? 1 : 0;
        const from = item.index != null ? item.index : 0;
        const canUp = !!item.canUp;
        const canDown = !!item.canDown;
        const canNest = !!item.canNest;
        const canUnnest = !!item.canUnnest;
        return `<div class="struct-row${pinned ? ' pinned' : ''}${depth === 1 ? ' depth-1' : ''}">
        <span class="struct-label"><strong>${esc(item.title || item.slug)}</strong> <span class="mono hint">${esc(item.slug || '')}${depth === 1 ? ' · sub' : ''}</span></span>
        <button type="button" class="btn small" data-act="menu-unnest" data-i="${from}" ${canUnnest ? '' : 'disabled'} title="Unnest">←</button>
        <button type="button" class="btn small" data-act="menu-nest" data-i="${from}" ${canNest ? '' : 'disabled'} title="Nest">→</button>
        <button type="button" class="btn small" data-act="menu-up" data-i="${from}" ${canUp ? '' : 'disabled'}>↑</button>
        <button type="button" class="btn small" data-act="menu-down" data-i="${from}" ${canDown ? '' : 'disabled'}>↓</button>
      </div>`;
      })
      .join('');
    const tabsHtml = pages
      .map(
        (p, i) =>
          `<button type="button" class="btn small${i === structPageIdx ? ' primary' : ''}" data-act="struct-page" data-i="${i}">${esc(p.title || p.slug)}</button>`
      )
      .join(' ');
    const page = pages[structPageIdx];
    const secs = (page && page.sections) || [];
    const freeform = page && typeof page.html === 'string' && page.html.trim();
    let secsHtml;
    if (freeform && !secs.length) {
      secsHtml = '<p class="hint">Freeform HTML page — reorder via Menu above.</p>';
    } else {
      secsHtml =
        secs
          .map((s, i) => {
            const pinned = PINNED_SEC.has(String(s.type || '').toLowerCase());
            let canUp = !pinned && i > 0 && !PINNED_SEC.has(String(secs[i - 1].type || '').toLowerCase());
            let canDown =
              !pinned && i < secs.length - 1 && !PINNED_SEC.has(String(secs[i + 1].type || '').toLowerCase());
            return `<div class="struct-row${pinned ? ' pinned' : ''}">
          <span class="struct-label">${esc(sectionLabelAdmin(s, i))}${pinned ? ' <span class="hint">fixed</span>' : ''}</span>
          <button type="button" class="btn small" data-act="sec-up" data-i="${i}" ${canUp ? '' : 'disabled'}>↑</button>
          <button type="button" class="btn small" data-act="sec-down" data-i="${i}" ${canDown ? '' : 'disabled'}>↓</button>
        </div>`;
          })
          .join('') || '<p class="hint">No sections.</p>';
    }
    host.innerHTML = `<h4 style="margin:8px 0 6px;font-size:13px">Menu</h4>${menuHtml}
      <h4 style="margin:14px 0 6px;font-size:13px">Sections</h4>
      <div class="inline" style="flex-wrap:wrap;gap:4px;margin-bottom:8px">${tabsHtml}</div>
      ${secsHtml}`;
  }
  loadWdStructureSummary().then(() => renderWdStructure());
  renderWdStructure();

  async function loadWdShots() {
    const host = $('#wd-shots');
    if (!host) return;
    try {
      const r = await api.websiteScreenshots(id, { ready: '1' });
      const shots = (r.data && r.data.screenshots) || [];
      const captures = shots.filter((s) => s.kind === 'capture' || !s.kind);
      const renditions = shots.filter((s) => s.kind === 'email' || s.kind === 'mms');
      if (!shots.length) {
        host.innerHTML = '<p class="hint">No screenshots yet. Publish a preview, then Regenerate.</p>';
        return;
      }
      const thumb = (
        s
      ) => `<div class="shot-card" style="border:1px solid var(--border);border-radius:10px;padding:8px;min-width:140px;max-width:180px">
        <a href="${esc(s.publicUrl)}" target="_blank" rel="noopener"><img src="${esc(s.publicUrl)}" alt="" style="width:100%;height:90px;object-fit:cover;border-radius:6px;background:#eee" /></a>
        <div class="hint" style="margin-top:6px">${esc(s.page)} · ${esc(s.viewport)}${s.kind && s.kind !== 'capture' ? ' · ' + esc(s.kind) : ''}</div>
        <div class="hint">${esc(fmtDate(s.capturedAt))}${s.ready === false ? ' · <span class="error">not ready</span>' : ''}</div>
        <div class="inline" style="margin-top:4px;gap:4px">
          <button type="button" class="btn small" data-act="shot-copy" data-url="${esc(s.publicUrl)}">Copy URL</button>
          <a class="btn small" href="${esc(s.publicUrl)}" target="_blank" rel="noopener">View</a>
        </div>
      </div>`;
      host.innerHTML = `<div style="display:flex;flex-wrap:wrap;gap:10px">${captures.map(thumb).join('')}</div>
        ${renditions.length ? `<p class="hint" style="margin-top:10px">Campaign renditions</p><div style="display:flex;flex-wrap:wrap;gap:10px">${renditions.map(thumb).join('')}</div>` : ''}`;
    } catch (e) {
      host.innerHTML = `<span class="error">${esc(errText(e))}</span>`;
    }
  }
  loadWdShots();

  async function wdReorder(scope, fromIndex, direction, action) {
    const msg = $('#wd-struct-msg');
    const act = String(action || 'move').toLowerCase();
    const nesting = act === 'nest' || act === 'unnest';
    setMsg(msg, nesting ? (act === 'nest' ? 'Nesting…' : 'Unnesting…') : 'Saving order…', '');
    try {
      const body = {
        scope,
        fromIndex,
        action: nesting ? act : 'move',
        pageIndex: structPageIdx,
      };
      if (!nesting) body.direction = direction;
      const r = await api.websiteReorderStructure(id, body);
      if (r && r.data && Array.isArray(r.data.pages)) pages = r.data.pages;
      else {
        const refreshed = await api.websiteGet(id);
        pages = parseJson((refreshed.data.site || {}).pages, pages);
      }
      if (r && r.data && Array.isArray(r.data.menu)) structMenu = r.data.menu;
      else await loadWdStructureSummary();
      renderWdStructure();
      const jsonEl = $('#wd-json');
      if (jsonEl) {
        try {
          const cur = JSON.parse(jsonEl.value);
          jsonEl.value = JSON.stringify({ pages, theme: cur.theme != null ? cur.theme : theme }, null, 2);
        } catch {
          jsonEl.value = JSON.stringify({ pages, theme }, null, 2);
        }
      }
      setMsg(msg, 'Order saved', 'ok');
      preview.reload();
    } catch (e) {
      setMsg(msg, errText(e), 'err');
    }
  }

  delegate(view, {
    rent: () => {
      rentalsPreselect = { websiteId: Number(id) };
      window.location.hash = '#/rentals';
    },
    'menu-up': async (t) => {
      await wdReorder('menu', Number(t.dataset.i), -1, 'move');
    },
    'menu-down': async (t) => {
      await wdReorder('menu', Number(t.dataset.i), 1, 'move');
    },
    'menu-nest': async (t) => {
      await wdReorder('menu', Number(t.dataset.i), 0, 'nest');
    },
    'menu-unnest': async (t) => {
      await wdReorder('menu', Number(t.dataset.i), 0, 'unnest');
    },
    'sec-up': async (t) => {
      await wdReorder('sections', Number(t.dataset.i), -1, 'move');
    },
    'sec-down': async (t) => {
      await wdReorder('sections', Number(t.dataset.i), 1, 'move');
    },
    'struct-page': (t) => {
      structPageIdx = Number(t.dataset.i) || 0;
      renderWdStructure();
    },
    'shots-regen': async () => {
      const msg = $('#wd-shots-msg');
      setMsg(msg, 'Capturing (this can take a minute)…', '');
      try {
        await api.websiteScreenshotsCapture(id, { forcePreview: true });
        setMsg(msg, 'Screenshots updated', 'ok');
        await loadWdShots();
      } catch (e) {
        setMsg(msg, errText(e), 'err');
      }
    },
    'shot-copy': async (t) => {
      const url = t.dataset.url;
      if (!url) return;
      try {
        await navigator.clipboard.writeText(url);
        toast('URL copied', 'ok');
      } catch {
        toast(url, 'ok');
      }
    },
    qa: async () => {
      out.innerHTML = '<span class="hint">Running QA…</span>';
      const r = (await api.websiteQa(id)).data;
      out.innerHTML = `<p><strong class="${r.pass ? 'check-pass' : 'check-fail'}">${r.pass ? 'PASS' : 'FAIL'}</strong></p>
        <table><thead><tr><th>Check</th><th>Result</th><th>Detail</th></tr></thead><tbody>${(r.checks || [])
          .map(
            (c) =>
              `<tr><td class="mono">${esc(c.name)}</td><td class="${c.pass ? 'check-pass' : 'check-fail'}">${c.pass ? 'PASS' : 'FAIL'}</td><td class="hint">${esc(c.detail || '')}</td></tr>`
          )
          .join('')}</tbody></table>`;
    },
    export: async () => {
      out.textContent = 'Exporting…';
      const r = (await api.websiteExport(id)).data;
      out.innerHTML = `Exported on the server to: <span class="mono">${esc(r.path)}</span>`;
    },
    'download-zip': async () => {
      out.textContent = 'Building ZIP…';
      try {
        const r = await api.websiteExportZip(id);
        out.innerHTML = `Downloaded <span class="mono">${esc(r.filename)}</span>${r.bytes != null ? ` (${esc(String(r.bytes))} bytes)` : ''}.`;
      } catch (e) {
        out.innerHTML = `<span class="error">ZIP failed: ${esc(errText(e))}</span>`;
      }
    },
    postcard: async () => {
      const box = $('#wd-claim-kit');
      out.textContent = 'Building postcard…';
      if (box) box.innerHTML = '<span class="hint">Loading claim kit…</span>';
      try {
        const kit = (await api.websiteClaimKit(id)).data || {};
        if (box) {
          box.innerHTML = `
            <div class="row" style="gap:16px;align-items:flex-start;flex-wrap:wrap">
              <div style="flex:1;min-width:160px">
                <div class="hint">View your site</div>
                ${kit.siteUrl ? `<a href="${esc(kit.siteUrl)}" target="_blank" rel="noopener" class="mono" style="word-break:break-all;font-size:0.85rem">${esc(kit.siteUrl)}</a>` : '<span class="hint">No preview URL yet — use Preview URL / Publish first.</span>'}
                ${kit.siteQrDataUrl ? `<div style="margin-top:8px"><img src="${esc(kit.siteQrDataUrl)}" alt="Site QR" width="120" height="120" style="image-rendering:pixelated" /></div>` : ''}
              </div>
              <div style="flex:1;min-width:160px">
                <div class="hint">Scan to claim (Yes / No)</div>
                ${kit.claimUrl ? `<a href="${esc(kit.claimUrl)}" target="_blank" rel="noopener" class="mono" style="word-break:break-all;font-size:0.85rem">${esc(kit.claimUrl)}</a>` : '<span class="error">Claim URL unavailable</span>'}
                ${kit.claimQrDataUrl ? `<div style="margin-top:8px"><img src="${esc(kit.claimQrDataUrl)}" alt="Claim QR" width="120" height="120" style="image-rendering:pixelated" /></div>` : ''}
              </div>
            </div>`;
        }
        const r = await api.websitePostcard(id);
        out.innerHTML = `Downloaded postcard <span class="mono">${esc(r.filename)}</span>${r.bytes != null ? ` (${esc(String(r.bytes))} bytes)` : ''}.`;
        toast('Postcard downloaded', 'ok');
      } catch (e) {
        out.innerHTML = `<span class="error">Postcard failed: ${esc(errText(e))}</span>`;
        if (box && !box.querySelector('img')) {
          box.innerHTML = `<span class="error">${esc(errText(e))}</span>`;
        }
      }
    },
    url: async () => {
      out.textContent = 'Publishing preview…';
      const r = (await api.websitePreview(id, false, { force: true })).data;
      const link = r.url
        ? `<a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.url)}</a>`
        : esc(r.path || '');
      out.innerHTML = `Public preview: ${link}${r.via ? `<div class="hint">via ${esc(r.via)}${r.project ? ` · project ${esc(r.project)}` : ''}</div>` : ''}`;
    },
    photos: async () => {
      out.textContent = 'Pulling photos…';
      const r = (await api.websiteImages(id, {})).data;
      out.textContent = `Added ${r.count} photo(s) for “${r.query}”.`;
      preview.reload();
    },
    optimize: async () => {
      out.textContent = 'Optimizing images (resize/compress; may take a minute)…';
      try {
        const r = (await api.websiteOptimizeImages(id, {})).data || {};
        const n = r.changed != null ? r.changed : r.optimized != null ? r.optimized : r.count;
        const saved = r.savedBytes != null ? r.savedBytes : r.bytesSaved != null ? r.bytesSaved : r.saved_bytes;
        out.innerHTML =
          `Image optimize finished${n != null ? `: <strong>${esc(String(n))}</strong> file(s) changed` : ''}${saved != null ? ` · saved ${esc(String(saved))} bytes` : ''}.` +
          (r.pagesUpdated != null ? `<div class="hint">Pages updated: ${esc(String(r.pagesUpdated))}</div>` : '');
        preview.reload();
      } catch (e) {
        out.innerHTML = `<span class="error">${esc(errText(e))}</span>`;
      }
    },
    regen: async () => {
      if (!window.confirm('Rebuild this site with fresh AI marketing copy? Layout resets to the template.')) return;
      out.textContent = 'Regenerating…';
      await api.generateSite({ leadId: site.lead_id, force: true });
      pageWebsiteDetail(id);
    },
    assign: async () => {
      const job = await assignDesignJob(site.lead_id, 'multipage');
      out.innerHTML = `Design job <a href="#/design/${job.id}">#${esc(job.id)}</a> is ${esc(pretty(job.status))}.`;
    },
    publish: async () => {
      out.textContent = 'Exporting and publishing…';
      const r = (await api.cfPublish(id)).data;
      if (r.ok === false) {
        out.innerHTML = `<span class="error">Publish failed: ${esc(r.error)}</span>${r.hint || r.detail ? `<div class="hint">${esc(r.hint || r.detail)}</div>` : ''}`;
        return;
      }
      out.innerHTML = `Published${r.url ? `: <a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.url)}</a>` : ''}${r.project ? `<div class="hint">Project ${esc(r.project)}</div>` : ''}`;
    },
    delete: async () => {
      const name = site.name || '#' + id;
      if (
        !window.confirm(
          `Archive website \"${name}\"?

The site will be soft-deleted: it disappears from public view and the Websites list, but everything (pages, versions, forms, modules, data) is preserved and it can be restored from Archives at any time.`
        )
      )
        return;
      out.textContent = 'Archiving…';
      try {
        await api.websiteDelete(id);
        toast(`Website #${id} archived`, 'ok');
        window.location.hash = '#/websites';
      } catch (e) {
        out.innerHTML = `<span class="error">${esc(errText(e))}</span>`;
      }
    },
    restore: async (t) => {
      if (!window.confirm('Restore this version? The current state is saved as a new version first.')) return;
      await api.websiteRestore(Number(t.dataset.v));
      toast('Version restored', 'ok');
      pageWebsiteDetail(id);
    },
    'versions-more': async (t) => {
      const list = $('#wd-ver-list');
      if (!list || t.disabled) return;
      t.disabled = true;
      try {
        const nextPage = Math.floor(versions.length / 30) + 1;
        const r = await api.websiteVersions(id, { page: nextPage, pageSize: 30 });
        const more = r ? asList(r.data, ['versions', 'rows']) : [];
        const seen = new Set(versions.map((v) => v.id));
        const fresh = more.filter((v) => !seen.has(v.id));
        versions.push(...fresh);
        list.insertAdjacentHTML('beforeend', fresh.map(versionRowHtml).join(''));
        const wrap = $('#wd-ver-more-wrap');
        if (wrap) {
          wrap.innerHTML =
            versions.length < versionsTotal
              ? `<button type="button" class="btn small" data-act="versions-more">Show more versions (${versions.length} of ${versionsTotal})</button>`
              : '';
        }
      } catch (e) {
        t.disabled = false;
        toast(errText(e), 'err');
      }
    },
    save: async () => {
      const msg = $('#wd-save-msg');
      let parsed;
      try {
        parsed = JSON.parse($('#wd-json').value);
      } catch (e) {
        setMsg(msg, 'Invalid JSON: ' + errText(e), 'err');
        return;
      }
      const r = await api.websiteSave(id, {
        pages: parsed.pages,
        theme: parsed.theme,
        note: 'Manual edit from web UI',
      });
      setMsg(msg, `Saved as version ${r.data.version.version_no}`, 'ok');
      preview.reload();
    },
    'logo-text': async () => {
      const msg = $('#wd-logo-msg');
      setMsg(msg, 'Switching to text logo…', '');
      try {
        await api.websiteLogo(id, { mode: 'text' });
        toast('Using text logo', 'ok');
        pageWebsiteDetail(id);
      } catch (e) {
        setMsg(msg, errText(e), 'err');
      }
    },
    'logo-upload': async () => {
      const msg = $('#wd-logo-msg');
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/jpeg,image/png,image/webp,image/gif';
      input.onchange = async () => {
        const file = input.files && input.files[0];
        if (!file) return;
        setMsg(msg, 'Uploading logo…', '');
        try {
          const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ''));
            reader.onerror = () => reject(new Error('Could not read file'));
            reader.readAsDataURL(file);
          });
          const b64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
          await api.websiteLogo(id, { mode: 'image', data: b64, mimeType: file.type });
          toast('Logo uploaded', 'ok');
          pageWebsiteDetail(id);
        } catch (e) {
          setMsg(msg, errText(e), 'err');
        }
      };
      input.click();
    },
  });
}

/* ------------------------------------------------------------------ */
/* Design                                                              */
/* ------------------------------------------------------------------ */

const designState = { page: 1, status: '' };

function erRowHtml(r, withJob) {
  return `<div class="q-card">
    <div><b>${esc(r.subject || '(no subject)')}</b> <span class="badge">${esc(r.request_kind)}</span> ${statusBadge(r.status)}</div>
    <div class="hint">from ${esc(r.from_email || 'unknown')} · ${esc(fmtDate(r.received_at))}${withJob ? ` · job ${r.design_job_id ? `<a href="#/design/${r.design_job_id}">#${esc(r.design_job_id)}</a>` : 'unlinked'}` : ''}</div>
    <p style="white-space:pre-wrap;margin:6px 0">${esc(r.body_excerpt || r.body || '')}</p>
    <div class="inline">
      ${
        r.status !== 'submitted' && r.status !== 'dismissed'
          ? `<button class="btn small primary" data-act="er-submit" data-id="${r.id}" data-job="${esc(r.design_job_id || '')}">Submit to agent</button>
      <button class="btn small" data-act="er-use" data-id="${r.id}">Use as instructions</button>
      <button class="btn small danger" data-act="er-dismiss" data-id="${r.id}">Dismiss</button>`
          : ''
      }
    </div></div>`;
}

/** Pull change-request body from merged job.instructions (headers written by requestAgentChange / client form). */
function extractQueuedChangeText(instructions, kind) {
  const text = String(instructions || '');
  if (!text.trim()) return '';
  const headers =
    kind === 'improvements'
      ? ['=== IMPROVEMENTS REQUEST ===', '=== CLIENT CHANGE REQUEST ===']
      : ['=== REDESIGN REQUEST ===', '=== CLIENT CHANGE REQUEST ==='];
  for (const header of headers) {
    const start = text.indexOf(header);
    if (start < 0) continue;
    let body = text.slice(start + header.length).replace(/^\s*\n/, '');
    const next = body.search(/\n=== [A-Z]/);
    if (next >= 0) body = body.slice(0, next);
    // Strip trailing scope notes appended by the queue helpers.
    body = body
      .replace(/\n\(Visual review used[\s\S]*$/i, '')
      .replace(/\nScope:[\s\S]*$/i, '')
      .trim();
    if (body) return body.slice(0, 6000);
  }
  return '';
}

/**
 * Resolve text for the redesign / improvement instruction boxes.
 * Prefer: pending inbound email → queued job instructions → latest review suggestions.
 */
function resolveChangeBoxText(job, kind) {
  const review = job && job.review;
  const reviewText =
    kind === 'improvements'
      ? String((review && review.improvement_instructions) || '').trim()
      : String((review && review.redesign_instructions) || '').trim();

  const pending = (job && Array.isArray(job.email_redesigns) ? job.email_redesigns : []).filter(
    (r) =>
      r &&
      (r.request_kind === kind || (!r.request_kind && kind === 'redesign')) &&
      r.status !== 'submitted' &&
      r.status !== 'dismissed'
  );
  if (pending.length) {
    const latest = pending[0];
    const body = String(latest.body || latest.body_excerpt || '').trim();
    if (body) return body.slice(0, 6000);
  }

  const queued = extractQueuedChangeText(job && job.instructions, kind);
  if (queued && (!job.request_kind || job.request_kind === kind)) return queued;

  // After a client/operator queue, review.*_instructions may hold the same text.
  return reviewText.slice(0, 6000);
}

function fillChangeInstructionBoxes(job, reviewOverride) {
  const review = reviewOverride || (job && job.review) || null;
  const viewJob = review && review !== (job && job.review) ? Object.assign({}, job || {}, { review }) : job;
  const redesignEl = $('#dd-redesign');
  const improveEl = $('#dd-improve');
  if (redesignEl) redesignEl.value = resolveChangeBoxText(viewJob, 'redesign');
  if (improveEl) improveEl.value = resolveChangeBoxText(viewJob, 'improvements');
}

/** Design learning panel (status, playbook, distill/clear). Used on Design + Settings. */
async function mountLearning(host) {
  async function load() {
    host.innerHTML = '<p class="hint">Loading learning status…</p>';
    let res;
    try {
      res = (await api.learningPlaybook()).data;
    } catch (e) {
      host.innerHTML = `<p class="error">Learning unavailable: ${esc(errText(e))}</p>`;
      return;
    }
    const st = res.status || {};
    const pb = res.playbook || [];
    host.innerHTML = `
      <p class="hint">Last learned: ${esc(st.last_learned_at ? new Date(st.last_learned_at).toLocaleString() : 'never')} · Events: ${esc(st.event_count == null ? '—' : st.event_count)}
        · Email msgs: ${esc(st.email_event_count == null ? '—' : st.email_event_count)} · Playbook: ${pb.length}${st.enabled === false ? ' · (learning off)' : ''}</p>
      <textarea readonly class="mono" placeholder="No lessons yet — run a review or redesign to start learning.">${esc(pb.map((b, i) => `${i + 1}. [${b.category || 'general'}] ${b.lesson || ''}`).join('\n'))}</textarea>
      <div class="inline" style="margin-top:8px">
        <button class="btn small" data-lr="refresh">Refresh</button>
        <button class="btn small primary" data-lr="distill">Distill now</button>
        <button class="btn small" data-lr="clear-playbook">Clear playbook</button>
        <button class="btn small danger" data-lr="clear-all">Clear all learning</button>
        <span class="msg" data-lr-msg></span>
      </div>`;
  }
  host.onclick = (e) => {
    const b = e.target.closest('[data-lr]');
    if (!b) return;
    const msg = () => $('[data-lr-msg]', host);
    safeRun(b, async () => {
      const act = b.dataset.lr;
      if (act === 'refresh') {
        await load();
        return;
      }
      if (act === 'distill') {
        const r = (await api.learningDistill(true)).data;
        await load();
        const m = msg();
        if (r && r.ok === false)
          setMsg(m, `Distill: ${r.reason || 'failed'} (heuristic playbook still updates on each review/edit).`, 'err');
        else
          setMsg(
            m,
            `Distilled${r && r.ai_used ? ' (AI)' : ''} — ${r && r.playbook_count != null ? r.playbook_count : '?'} lessons.`,
            'ok'
          );
        return;
      }
      if (act === 'clear-playbook') {
        await api.learningClear('playbook');
        await load();
        return;
      }
      if (act === 'clear-all') {
        if (!window.confirm('Clear all design learning events and the playbook?')) return;
        await api.learningClear('all');
        await load();
      }
    });
  };
  await load();
}

let domainsQuery = {};
let txnOffset = 0;
async function pageDomains(param, query) {
  if (query && typeof query === 'object') domainsQuery = query;
  const txnId = Number((domainsQuery && domainsQuery.txn) || 0) || null;
  const [cfRes, linkedRes, sitesRes, leadsRes, txnRes, txnDetailRes] = await Promise.all([
    withLoadTimeout(api.cfGet()).catch(() => null),
    withLoadTimeout(api.domainsList()).catch(() => null),
    withLoadTimeout(api.websites({ pageSize: 100 })).catch(() => null),
    withLoadTimeout(api.leads({ pageSize: 200 })).catch(() => null),
    withLoadTimeout(api.adminDomainTransactions({ limit: 100, offset: txnOffset })).catch(() => null),
    txnId ? withLoadTimeout(api.adminDomainTransaction(txnId)).catch(() => null) : Promise.resolve(null),
  ]);
  const purchases = asList((txnRes && txnRes.data) || {}, ['transactions', 'rows']);
  const txnDetail = (txnDetailRes && txnDetailRes.data) || null;
  const cf = (cfRes && cfRes.data) || {};
  const linked = asList((linkedRes && linkedRes.data) || {}, ['domains', 'rows']);
  const sites = asList((sitesRes && sitesRes.data) || {}, ['websites', 'sites', 'rows']);
  const leads = dedupeById(asList((leadsRes && leadsRes.data) || {}, ['leads', 'rows']));
  const siteOpts = sites
    .map(
      (s) =>
        `<option value="${esc(s.id)}">#${esc(s.id)} · ${esc(s.name || 'Site')}${s.lead_id ? ` · lead ${esc(s.lead_id)}` : ''}</option>`
    )
    .join('');
  const leadOpts = leads
    .map((l) => {
      const name = l.business_name || l.name || 'Lead #' + l.id;
      const city = l.city ? ` · ${l.city}` : '';
      return `<option value="${esc(l.id)}">${esc(name)}${esc(city)}</option>`;
    })
    .join('');

  // ---- Domain purchases (Batch 15): plan checkouts that bundle a domain ----
  const txnBadge = (t) => {
    const s = t.displayStatus || t.status;
    const cls = s === 'live' ? 'ok' : s === 'failed' || s === 'abandoned' ? 'danger' : s === 'paid' || s === 'registering' ? 'warn' : '';
    return `<span class="badge ${cls}">${esc(pretty(s))}</span>`;
  };
  // Batch 60 renewal badge: mode is derived from the owner's
  // subscription state (auto while subscribed, manual otherwise).
  const renewalBadge = (mode) =>
    mode === 'auto'
      ? `<span class="badge ok">Auto-renew</span>`
      : mode === 'manual'
        ? `<span class="badge warn">Manual renewal only — owner not subscribed</span>`
        : '';
  const purchasesHtml = `
    <div class="card">
      <div class="panel-h"><h3>Domain purchases</h3><span class="hint">${purchases.length} transaction(s) — clients who picked a domain and paid for a plan</span></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Business</th><th>Domain</th><th>Plan</th><th>Paid</th><th>Registrar cost</th><th>Status</th><th>When</th><th></th></tr></thead>
        <tbody>${
          purchases
            .map(
              (t) => `<tr>
            <td>${esc(t.leadName || 'Lead #' + t.leadId)}<div class="hint">${esc(t.leadEmail || '')}</div></td>
            <td class="mono">${esc(t.domain)}</td>
            <td>${esc(t.planName || t.planId)}</td>
            <td>${t.amountPaidCents != null ? esc(moneyCents(t.amountPaidCents, 'USD')) : '—'}</td>
            <td>${t.registrarPriceCents != null ? esc(moneyCents(t.registrarPriceCents, t.registrarCurrency || 'USD')) + '/yr' : '—'}</td>
            <td>${txnBadge(t)}${t.renewalMode ? `<div style="margin-top:4px">${renewalBadge(t.renewalMode)}</div>` : ''}</td>
            <td>${t.createdAt ? esc(fmtDate(t.createdAt)) : '—'}</td>
            <td class="actions"><button class="btn small" data-act="txn-view" data-id="${esc(t.id)}">View</button>${t.status === 'pending_payment' || t.status === 'failed' ? ` <button class="btn small danger" data-act="txn-void" data-id="${esc(t.id)}">Void</button>` : ''}${t.status === 'voided' || t.status === 'failed' ? ` <button class="btn small danger" data-act="txn-remove" data-id="${esc(t.id)}" data-domain="${esc(t.domain)}">Remove</button>` : ''}</td>
          </tr>`
            )
            .join('') || '<tr><td colspan="8" class="empty">No domain purchases yet. They appear here when a client picks a domain and pays for a plan.</td></tr>'
        }
        </tbody>
      </table></div>
      <div class="pagination" style="margin-top:8px"><button class="btn small" data-act="txn-prev" ${txnOffset <= 0 ? 'disabled' : ''}>← Newer</button> <span class="hint">${esc(((txnRes && txnRes.data) || {}).total != null ? `${txnOffset + 1}–${txnOffset + purchases.length} of ${((txnRes && txnRes.data) || {}).total}` : `${purchases.length} shown`)}</span> <button class="btn small" data-act="txn-next" ${purchases.length < 100 ? 'disabled' : ''}>Older →</button></div>
    </div>`;
  let txnDetailHtml = '';
  if (txnDetail && txnDetail.transaction) {
    const t = txnDetail.transaction;
    const steps = Array.isArray(t.steps) ? t.steps : [];
    const stepState = (name) => {
      const hits = steps.filter((s) => s.step === name);
      if (!hits.length) return null;
      return hits[hits.length - 1];
    };
    const checkRow = (label, done, pendingLabel) =>
      `<div class="panel-h"><div>${done ? '✓' : '○'} <strong>${esc(label)}</strong></div><span class="hint">${done ? esc(done.detail || 'done') : esc(pendingLabel || 'pending')}</span></div>`;
    const regStep = stepState('register');
    const dnsStep = stepState('dns');
    const linkStep = stepState('link');
    const canComplete = t.status === 'paid' || t.status === 'failed';
    txnDetailHtml = `
    <div class="card" id="txn-detail">
      <div class="panel-h"><h3>Domain transaction #${esc(t.id)}</h3>${txnBadge(t)}</div>
      ${t.error ? `<div class="alert danger"><strong>Last error:</strong> ${esc(t.error)}</div>` : ''}
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px">
        <div><h4>Client &amp; site</h4>
          <p><strong>${esc((txnDetail.lead && txnDetail.lead.businessName) || t.leadName || 'Lead #' + t.leadId)}</strong><br>
          ${esc((txnDetail.lead && txnDetail.lead.email) || '')}${txnDetail.lead && txnDetail.lead.phone ? ' · ' + esc(txnDetail.lead.phone) : ''}<br>
          Site: ${txnDetail.website ? esc(txnDetail.website.name || '') + ' (#' + esc(txnDetail.website.id) + ')' : '—'}${
            txnDetail.website && txnDetail.website.customDomain
              ? `<br>Live at <a href="https://${esc(txnDetail.website.customDomain)}" target="_blank" rel="noopener">${esc(txnDetail.website.customDomain)}</a>`
              : ''
          }</p></div>
        <div><h4>Purchase</h4>
          <p>Domain: <span class="mono">${esc(t.domain)}</span><br>
          Plan: ${esc(t.planName || t.planId)} · Amount paid: ${t.amountPaidCents != null ? esc(moneyCents(t.amountPaidCents, 'USD')) : '—'}<br>
          Registrar cost: ${t.registrarPriceCents != null ? esc(moneyCents(t.registrarPriceCents, t.registrarCurrency || 'USD')) + '/yr' : '—'} (Cloudflare account)<br>
          ${t.renewalMode ? `Renewal: ${renewalBadge(t.renewalMode)}${t.domainExpiresAt ? ` · expires ${esc(fmtDate(t.domainExpiresAt))}` : ''}${t.manualRenewRequestedAt ? `<br><span class="hint">Manual renewal requested ${esc(fmtDate(t.manualRenewRequestedAt))} — renew it in the Cloudflare dashboard.</span>` : ''}${t.renewalMode === 'manual' ? `<br><button class="btn small" data-act="dom-renew-manual" data-domain="${esc(t.domain)}" style="margin-top:6px">Renew manually…</button>` : ''}<br>` : ''}
          <span class="hint">Stripe session ${esc(t.stripeSessionId || '—')} · subscription ${esc(t.stripeSubscriptionId || '—')} · customer ${esc(t.stripeCustomerId || '—')}</span></p></div>
      </div>
      <h4>Completion checklist</h4>
      ${checkRow('Payment received', t.paidAt ? { detail: 'paid ' + fmtDate(t.paidAt) } : null, 'waiting for payment')}
      ${checkRow('Domain registered at Cloudflare', regStep && regStep.ok ? regStep : null, regStep ? regStep.detail : 'not started')}
      ${checkRow('DNS pointed at the site', dnsStep && dnsStep.ok ? dnsStep : null, dnsStep ? dnsStep.detail : 'not started')}
      ${checkRow('Site published & domain linked', linkStep && linkStep.ok ? linkStep : null, linkStep ? linkStep.detail : 'not started')}
      ${checkRow('Live', t.status === 'live' ? { detail: 'live at https://' + t.domain } : null, 'not yet')}
      ${
        steps.length
          ? `<details style="margin-top:8px"><summary>Step log</summary><ul class="list">${steps
              .map(
                (s) =>
                  `<li>${s.ok ? '✓' : '✗'} <strong>${esc(s.step)}</strong> ${esc(s.detail || '')}<div class="timestamp">${esc(s.at ? fmtDate(s.at) : '')}</div></li>`
              )
              .join('')}</ul></details>`
          : ''
      }
      ${
        canComplete
          ? `<div class="inline" style="margin-top:12px"><button class="btn primary" data-act="txn-complete" data-id="${esc(t.id)}">${t.status === 'failed' ? 'Retry — complete registration & go live' : 'Complete registration & go live'}</button><span class="msg" id="txn-complete-msg"></span></div>`
          : ''
      }
    </div>`;
  }

  view.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Domains</h1>
        <p class="lede">Search and buy domains via Cloudflare Registrar, then link them to a published site (Pages custom domain). Purchase bills your Cloudflare payment method.</p>
      </div>
    </div>
    ${purchasesHtml}
    ${txnDetailHtml}
    ${!cf.configured ? `<div class="card"><p class="error">Cloudflare is not configured. <a href="#/settings/cloudflare">Add token + Account ID in Settings</a> (permissions: Account · Registrar · Edit, Account · Cloudflare Pages · Edit).</p></div>` : ''}
    <div class="card">
      <h3>Search domains</h3>
      <form id="dom-search-form" class="row end">
        <div class="field" style="flex:2;min-width:200px"><label>Keyword or name</label>
          <input name="q" required placeholder="acme plumbing" autocomplete="off" /></div>
        <div class="field" style="flex:1;min-width:180px"><label>Lead (optional)</label>
          <input type="search" id="dom-search-lead-search" placeholder="Type to filter…" autocomplete="off" style="margin-bottom:6px" />
          <select name="leadId" id="dom-search-lead"><option value="">None</option>${leadOpts}</select></div>
        <div class="field" style="flex:0 0 auto"><label>&nbsp;</label>
          <button class="btn primary" type="submit">Search</button></div>
      </form>
      <span class="msg" id="dom-search-msg"></span>
      <div id="dom-search-results" style="margin-top:12px"></div>
    </div>
    <div class="card">
      <h3>Link a domain to a site</h3>
      <p class="hint">Use a domain you just bought, or one already on this Cloudflare account. The site is published to Pages if needed, the hostname is attached, and the domain's DNS is pointed at the site — linking only succeeds once the name is actually pointed at the site.</p>
      <form id="dom-link-form" class="row end">
        <div class="field"><label>Domain</label><input name="domain" required placeholder="example.com" /></div>
        <div class="field"><label>Website</label><select name="websiteId" required><option value="">Select…</option>${siteOpts}</select></div>
        <div class="field" style="flex:0 0 auto"><label>&nbsp;</label><button class="btn primary" type="submit">Link domain</button></div>
      </form>
      <div class="inline" style="margin-top:8px">
        <button type="button" class="btn small" id="dom-refresh-owned">Load owned CF domains</button>
        <span class="msg" id="dom-link-msg"></span>
      </div>
      <div id="dom-owned" style="margin-top:10px"></div>
    </div>
    <div class="card">
      <h3>Linked &amp; registered</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>Domain</th><th>Status</th><th>Website</th><th>Price</th><th>Expires</th><th>Renewal</th><th></th></tr></thead>
        <tbody id="dom-linked-body">${
          linked
            .map(
              (d) => `
          <tr>
            <td><a href="${esc(d.publicUrl || 'https://' + d.domain)}" target="_blank" rel="noopener">${esc(d.domain)}</a>
              <div class="hint">${esc(d.pagesProject || '')}</div></td>
            <td>${esc(d.status)}${d.registrationState ? `<div class="hint">${esc(d.registrationState)}</div>` : ''}</td>
            <td>${d.websiteId ? `<a href="#/websites/${esc(d.websiteId)}">#${esc(d.websiteId)}</a>` : '—'}</td>
            <td class="mono">${d.price != null ? esc(String(d.price)) + (d.currency ? ' ' + esc(d.currency) : '') : '—'}</td>
            <td>${d.expiresAt ? esc(fmtDate(d.expiresAt)) : '—'}${d.renewalError ? `<div class="hint" style="color:#b00">${esc(d.renewalError)}</div>` : ''}</td>
            <td>${renewalBadge(d.renewalMode)}${d.manualRenewRequestedAt ? `<div class="hint">renewal requested ${esc(fmtDate(d.manualRenewRequestedAt))}</div>` : ''}</td>
            <td class="actions">
              ${d.status === 'registering' ? `<button class="btn small" data-act="dom-poll" data-domain="${esc(d.domain)}">Refresh status</button>` : ''}
              ${d.status === 'registered' && d.websiteId ? `<button class="btn small" data-act="dom-link-row" data-domain="${esc(d.domain)}" data-site="${esc(d.websiteId)}">Link to site</button>` : ''}
              ${d.renewalMode === 'manual' ? `<button class="btn small" data-act="dom-renew-manual" data-domain="${esc(d.domain)}">Renew manually…</button>` : ''}
              ${d.status === 'linked' ? `<button class="btn small danger" data-act="dom-unlink" data-domain="${esc(d.domain)}">Unlink</button>` : ''}
            </td>
          </tr>`
            )
            .join('') || '<tr><td colspan="7" class="empty">No domains yet — search above to get started.</td></tr>'
        }
        </tbody>
      </table></div>
    </div>`;

  const resultsEl = $('#dom-search-results');
  const searchMsg = $('#dom-search-msg');

  function priceLabel(d) {
    if (d.registrationCost == null) return '';
    return `${d.registrationCost}${d.currency ? ' ' + d.currency : ''}/yr`;
  }

  function renderSearchResults(domains) {
    if (!domains.length) {
      resultsEl.innerHTML =
        '<p class="hint">No suggestions. Try another keyword, then Check a full name like brand.com.</p>';
      return;
    }
    resultsEl.innerHTML = `<div class="table-wrap"><table>
      <thead><tr><th>Domain</th><th>Available</th><th>Price</th><th></th></tr></thead>
      <tbody>${domains
        .map(
          (d) => `<tr>
        <td class="mono">${esc(d.domain)}</td>
        <td class="${d.registrable ? 'check-pass' : 'check-fail'}">${d.registrable ? 'Yes' : 'No'}${d.reason ? `<div class="hint">${esc(d.reason)}</div>` : ''}</td>
        <td>${esc(priceLabel(d) || '—')}</td>
        <td class="actions">
          <button type="button" class="btn small" data-act="dom-check" data-domain="${esc(d.domain)}">Check</button>
          <button type="button" class="btn small primary" data-act="dom-buy" data-domain="${esc(d.domain)}" ${d.registrable ? '' : 'disabled'}>Buy</button>
          <button type="button" class="btn small" data-act="dom-use-link" data-domain="${esc(d.domain)}">Use to link</button>
        </td>
      </tr>`
        )
        .join('')}</tbody></table></div>`;
  }

  wireSelectSearch($('#dom-search-lead-search'), $('#dom-search-lead'));
  $('#dom-search-form').onsubmit = async (e) => {
    e.preventDefault();
    const body = formObject(e.target);
    setMsg(searchMsg, 'Searching…', '');
    try {
      const r = await api.domainsSearch(body.q, body.leadId ? { leadId: Number(body.leadId) } : {});
      const domains = (r.data && r.data.domains) || [];
      setMsg(searchMsg, `${domains.length} suggestion(s)`, 'ok');
      renderSearchResults(domains);
    } catch (err) {
      setMsg(searchMsg, errText(err), 'err');
    }
  };

  $('#dom-link-form').onsubmit = async (e) => {
    e.preventDefault();
    const body = formObject(e.target);
    const msg = $('#dom-link-msg');
    setMsg(msg, 'Linking (may publish preview first)…', '');
    try {
      const r = await api.domainsLink({
        domain: body.domain,
        websiteId: Number(body.websiteId),
        forcePublish: true,
      });
      const dns = (r.data && r.data.dns) || null;
      const dnsNote = dns
        ? dns.created
          ? ` DNS record created — ${body.domain} now points at ${dns.target}.`
          : ` DNS already pointed at ${dns.target} — nothing to change.`
        : '';
      setMsg(msg, `Linked — ${(r.data && r.data.publicUrl) || body.domain}.${dnsNote}`, 'ok');
      pageDomains();
    } catch (err) {
      setMsg(msg, errText(err), 'err');
    }
  };

  $('#dom-refresh-owned').onclick = async () => {
    const host = $('#dom-owned');
    const msg = $('#dom-link-msg');
    setMsg(msg, 'Loading owned domains…', '');
    try {
      const r = await api.domainsOwned();
      const domains = (r.data && r.data.domains) || [];
      setMsg(msg, `${domains.length} on Cloudflare Registrar`, 'ok');
      host.innerHTML = domains.length
        ? `<div class="table-wrap"><table><thead><tr><th>Domain</th><th>Status</th><th></th></tr></thead><tbody>${domains
            .map(
              (d) => `<tr>
            <td class="mono">${esc(d.domain)}</td>
            <td>${esc(d.status || '—')}${d.expiresAt ? `<div class="hint">expires ${esc(d.expiresAt)}</div>` : ''}</td>
            <td><button type="button" class="btn small" data-act="dom-use-link" data-domain="${esc(d.domain)}">Use to link</button></td>
          </tr>`
            )
            .join('')}</tbody></table></div>`
        : '<p class="hint">No domains on this Cloudflare account yet.</p>';
    } catch (err) {
      setMsg(msg, errText(err), 'err');
    }
  };

  delegate(view, {
    'dom-check': async (t) => {
      setMsg(searchMsg, 'Checking live availability…', '');
      try {
        const r = await api.domainsCheck([t.dataset.domain]);
        const d = ((r.data && r.data.domains) || [])[0];
        if (!d) {
          setMsg(searchMsg, 'No check result', 'err');
          return;
        }
        setMsg(
          searchMsg,
          d.registrable
            ? `${d.domain} is registrable${d.registrationCost != null ? ` · ${d.registrationCost} ${d.currency || ''}/yr` : ''}`
            : `${d.domain} not registrable${d.reason ? ': ' + d.reason : ''}`,
          d.registrable ? 'ok' : 'err'
        );
      } catch (err) {
        setMsg(searchMsg, errText(err), 'err');
      }
    },
    'dom-buy': async (t) => {
      const domain = t.dataset.domain;
      const form = $('#dom-search-form');
      const leadId = form && form.leadId ? Number(form.leadId.value) : null;
      const siteSel = document.querySelector('#dom-link-form select[name="websiteId"]');
      const websiteId = siteSel && siteSel.value ? Number(siteSel.value) : null;
      if (
        !window.confirm(
          `Purchase ${domain} for 1 year on Cloudflare Registrar?\n\nThis bills the payment method on your Cloudflare account and is non-refundable.`
        )
      )
        return;
      setMsg(searchMsg, 'Registering…', '');
      try {
        const r = await api.domainsRegister({
          domain,
          years: 1,
          leadId: leadId || undefined,
          websiteId: websiteId || undefined,
        });
        const st = (r.data && r.data.status) || 'registering';
        setMsg(searchMsg, `Registration ${st} for ${domain}`, 'ok');
        if (websiteId && st === 'registered') {
          await api.domainsLink({ domain, websiteId, forcePublish: true });
        }
        pageDomains();
      } catch (err) {
        setMsg(searchMsg, errText(err), 'err');
      }
    },
    'dom-use-link': (t) => {
      const input = document.querySelector('#dom-link-form input[name="domain"]');
      if (input) input.value = t.dataset.domain || '';
      input && input.focus();
    },
    'dom-poll': async (t) => {
      try {
        await api.domainsStatus(t.dataset.domain);
        pageDomains();
      } catch (err) {
        toast(errText(err), 'err');
      }
    },
    'dom-link-row': async (t) => {
      try {
        const r = await api.domainsLink({ domain: t.dataset.domain, websiteId: Number(t.dataset.site), forcePublish: true });
        const dns = (r.data && r.data.dns) || null;
        toast(
          dns
            ? dns.created
              ? `Domain linked — DNS record created (${t.dataset.domain} → ${dns.target})`
              : `Domain linked — DNS already pointed at ${dns.target}`
            : 'Domain linked',
          'ok'
        );
        pageDomains();
      } catch (err) {
        toast(errText(err), 'err');
      }
    },
    'dom-unlink': async (t) => {
      if (!window.confirm(`Unlink ${t.dataset.domain} from its site?`)) return;
      try {
        await api.domainsUnlink({ domain: t.dataset.domain });
        toast('Unlinked', 'ok');
        pageDomains();
      } catch (err) {
        toast(errText(err), 'err');
      }
    },
    // Batch 60 — manual renewal: the registrar API cannot renew, so
    // the server records the intent and hands back the Cloudflare
    // dashboard link + steps; the new expiry is picked up by the sweep.
    'dom-renew-manual': async (t) => {
      const domain = t.dataset.domain;
      if (
        !window.confirm(
          `Record a manual renewal for ${domain}?\n\nCloudflare does not allow renewals through its API — you renew in the Cloudflare dashboard (Manage domains → ${domain} → Registration → Renew/Extend Domain). This records the request and tracks the expiry before/after.`
        )
      )
        return;
      try {
        const r = await api.adminDomainRenewManual(domain, api.getWorkspaceId());
        const d = (r && r.data) || {};
        toast(`Manual renewal recorded for ${domain}${d.expiresAt ? ` — current expiry ${fmtDate(d.expiresAt)}` : ''}. Renew it in the Cloudflare dashboard.`, 'ok');
        if (d.dashboardUrl) window.open(d.dashboardUrl, '_blank', 'noopener');
        pageDomains(null, domainsQuery);
      } catch (err) {
        toast(errText(err), 'err');
      }
    },
    'txn-view': (t) => {
      window.location.hash = '#/domains?txn=' + encodeURIComponent(t.dataset.id);
    },
    // Batch 45 — void a dead-end transaction (pending payment / failed
    // only; the API refuses paid/live with 409).
    'txn-void': async (t) => {
      const id = Number(t.dataset.id);
      if (!window.confirm('Void this transaction? It drops out of the claim page and domain picker. Paid or live transactions cannot be voided.')) return;
      try {
        await api.adminDomainTransactionVoid(id);
        toast('Transaction voided', 'ok');
        pageDomains(null, domainsQuery);
      } catch (err) {
        toast(errText(err), 'err');
      }
    },
    // Batch 51 — permanently remove a voided/failed transaction row.
    'txn-remove': async (t) => {
      const id = Number(t.dataset.id);
      const domain = t.dataset.domain || 'this domain';
      if (!window.confirm(`Remove the transaction for ${domain} permanently? The row is deleted for good. Paid or live transactions can never be removed.`)) return;
      try {
        await api.adminDomainTransactionRemove(id);
        toast('Transaction removed', 'ok');
        pageDomains(null, domainsQuery);
      } catch (err) {
        toast(errText(err), 'err');
      }
    },
    'txn-prev': () => {
      txnOffset = Math.max(0, txnOffset - 100);
      pageDomains(null, domainsQuery);
    },
    'txn-next': () => {
      txnOffset += 100;
      pageDomains(null, domainsQuery);
    },
    'txn-complete': async (t) => {
      const id = Number(t.dataset.id);
      if (
        !window.confirm(
          'Complete this domain purchase?\n\nThis registers the domain on Cloudflare (bills the Cloudflare account), publishes the site, links the domain and emails the client that their site is live.'
        )
      )
        return;
      const msg = $('#txn-complete-msg');
      setMsg(msg, 'Registering, publishing and linking…', '');
      t.disabled = true;
      try {
        const r = await api.adminDomainTransactionComplete(id);
        const d = (r && r.data) || {};
        if (d.completed) {
          toast('Site is live', 'ok');
        } else if (d.pending) {
          toast(d.message || 'DNS is pointed at the site, but the name is not resolving yet — click Complete again in a few minutes.', 'ok');
        } else {
          toast(d.error || 'Completion failed — see the transaction for the step error', 'err');
        }
        pageDomains(null, domainsQuery);
      } catch (err) {
        setMsg(msg, errText(err), 'err');
        t.disabled = false;
      }
    },
  });
}

async function pageDesign(param) {
  if (param) return pageDesignDetail(Number(param));
  let pend, list, er;
  try {
    [pend, list, er] = await withLoadTimeout(
      Promise.all([
        api.designPending().catch(() => null),
        api.designList({ page: designState.page, pageSize: 25, status: designState.status }),
        api.emailRedesignList({ pendingOnly: 1 }).catch(() => null),
      ])
    );
  } catch (e) {
    view.innerHTML = loadErrorCardHtml(errText(e));
    wirePageRetry(() => pageDesign());
    return;
  }
  const counts = pend
    ? pend.data.counts || { waiting_on_agent: 0, questions_pending: 0 }
    : { waiting_on_agent: 0, questions_pending: 0 };
  const jobs = asList(list.data, ['jobs', 'rows']);
  const ers = er ? asList(er.data, ['requests', 'rows']) : [];

  view.innerHTML = `
    <div class="page-head">
      <div><h1>Design</h1><p class="lede">${esc(counts.waiting_on_agent)} waiting on agent · ${esc(counts.questions_pending)} questions pending. Jobs are picked up automatically by the design agent.</p></div>
      <div class="page-actions"><button class="btn primary" data-act="new">New design job</button></div>
    </div>
    <div class="toolbar">
      <select id="dj-status"><option value="">All statuses</option>${optionList(DESIGN_STATUSES, designState.status)}</select>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>#</th><th>Title</th><th>Type</th><th>Shape</th><th>Status</th><th>Questions</th><th>Updated</th><th></th></tr></thead>
      <tbody>${
        jobs
          .map(
            (j) => `<tr>
        <td>${j.id}</td>
        <td><button class="link-btn" data-act="open" data-id="${j.id}">${esc(j.title)}</button>${j.lead_id ? `<div class="hint">lead #${esc(j.lead_id)}</div>` : ''}</td>
        <td>${esc(j.type)}</td><td>${esc(j.website_shape || j.site_shape || '—')}${j.website_pages ? `<div class="hint">${esc(j.website_pages)} pages on the site</div>` : ''}</td><td>${statusBadge(j.status)}</td>
        <td>${j.pending_questions ? `<span class="badge warn">${esc(j.pending_questions)} pending</span>` : '—'}</td>
        <td>${esc(fmtDate(j.updated_at))}</td>
        <td class="actions"><button class="btn small danger" data-act="delete" data-id="${j.id}">Delete</button></td></tr>`
          )
          .join('') || '<tr><td colspan="8" class="empty">No design jobs yet.</td></tr>'
      }</tbody>
    </table></div>
    <div class="pagination" id="dj-pager"></div>
    <div class="card">
      <div class="panel-h"><h3>Email change requests</h3>
        <div class="inline">
          <button class="btn small" data-act="imap">Poll IMAP inbox</button>
          <button class="btn small" data-act="scan">Scan drop folder</button>
        </div></div>
      <p class="hint">Client replies with <code>[Job #N]</code> in the subject are matched when IMAP is on. OpenAI turns the email into agent instructions before the job is queued (needs AI key in Settings). ${er && er.data.dropDir ? `Drop folder: <span class="mono">${esc(er.data.dropDir)}</span>` : ''}</p>
      <div id="dj-er">${ers.map((r) => erRowHtml(r, true)).join('') || '<p class="hint">No pending email requests.</p>'}</div>
    </div>
    <div class="card"><details><summary>Design learning</summary><div id="dj-learning" style="margin-top:8px"></div></details></div>`;

  pager(
    $('#dj-pager'),
    { page: list.data.page || 1, pages: list.data.pages || 1, total: list.data.total || 0 },
    (p) => {
      designState.page = p;
      pageDesign();
    }
  );
  $('#dj-status').addEventListener('change', (e) => {
    designState.status = e.target.value;
    designState.page = 1;
    pageDesign();
  });
  mountLearning($('#dj-learning'));

  delegate(view, {
    open: (t) => {
      window.location.hash = '#/design/' + t.dataset.id;
    },
    new: () => openNewDesignModal(),
    delete: async (t) => {
      if (!window.confirm('Delete design job #' + t.dataset.id + '?')) return;
      await api.designDelete(Number(t.dataset.id));
      toast('Deleted', 'ok');
      pageDesign();
    },
    scan: async () => {
      const r = (await api.emailRedesignScan()).data;
      toast(`Scanned ${r.scanned || 0} file(s).`, 'ok');
      pageDesign();
    },
    imap: async () => {
      const r = (await api.emailImapPoll({ force: true })).data;
      if (r.skipped)
        toast(
          r.reason === 'imap_not_configured' || r.reason === 'imap_disabled'
            ? 'Enable IMAP under Settings → Email first.'
            : r.reason || 'IMAP skipped',
          'err'
        );
      else toast(`IMAP: fetched ${r.fetched || 0}, processed ${r.processed || 0}.`, 'ok');
      pageDesign();
    },
    'er-submit': async (t) => {
      let jobId = t.dataset.job ? Number(t.dataset.job) : null;
      if (!jobId) {
        const v = window.prompt('Design job id to apply this request to:');
        if (!v) return;
        jobId = Number(v);
      }
      await api.emailRedesignSubmit(Number(t.dataset.id), { designJobId: jobId });
      toast('Submitted to the agent queue', 'ok');
      pageDesign();
    },
    'er-use': (t) => {
      const r = ers.find((x) => String(x.id) === t.dataset.id);
      if (r && r.design_job_id) window.location.hash = '#/design/' + r.design_job_id;
      else toast('Link this request to a job first (submit with a job id).');
    },
    'er-dismiss': async (t) => {
      await api.emailRedesignDismiss(Number(t.dataset.id));
      pageDesign();
    },
  });
}

async function openNewDesignModal() {
  let defaults = '';
  try {
    defaults = (await api.designDefaultInstructions()).data.website || '';
  } catch {
    /* optional */
  }
  const m = openModal({
    title: 'New design job',
    wide: true,
    body: `<div class="row">
        <div class="field"><label>Type</label><select id="nd-type">${optionList(DESIGN_TYPES, 'website')}</select></div>
        <div class="field" id="nd-shape-wrap"><label>Site shape</label><select id="nd-shape"><option value="multipage">Multi-page</option><option value="landing">Landing page</option></select></div>
      </div>
      <div class="field"><label>Title *</label><input id="nd-title" type="text" /></div>
      <div class="row">
        <div class="field" style="flex:2"><label>Lead (optional)</label><div id="nd-lead"></div></div>
        <div class="field"><label>Contact email (optional)</label><input id="nd-email" type="email" /></div>
      </div>
      <div class="field"><label>Instructions *</label><textarea id="nd-instr" style="min-height:160px">${esc(defaults)}</textarea></div>
      <div class="msg" id="nd-msg"></div>`,
    buttons: [
      { label: 'Cancel' },
      {
        label: 'Queue for agent',
        cls: 'primary',
        onClick: async (mm) => {
          const type = $('#nd-type', mm.el).value;
          const title = $('#nd-title', mm.el).value.trim();
          const instructions = $('#nd-instr', mm.el).value.trim();
          if (!title || !instructions) {
            setMsg($('#nd-msg', mm.el), 'Title and instructions are required.', 'err');
            return;
          }
          const lead = picker.get();
          const r = await api.designCreate(
            dropEmpty({
              type,
              title,
              instructions,
              leadId: lead ? lead.id : undefined,
              contactEmail: $('#nd-email', mm.el).value.trim(),
              site_shape: type === 'website' ? $('#nd-shape', mm.el).value : undefined,
            })
          );
          toast(`Job #${r.data.job.id} queued`, 'ok');
          mm.close();
          window.location.hash = '#/design/' + r.data.job.id;
        },
      },
    ],
  });
  const picker = mountLeadPicker($('#nd-lead', m.el));
  $('#nd-type', m.el).addEventListener('change', (e) => {
    $('#nd-shape-wrap', m.el).classList.toggle('hidden', e.target.value !== 'website');
    if (e.target.value !== 'website' && $('#nd-instr', m.el).value === defaults) $('#nd-instr', m.el).value = '';
    else if (e.target.value === 'website' && !$('#nd-instr', m.el).value.trim()) $('#nd-instr', m.el).value = defaults;
  });
}

function reviewHtml(r) {
  if (!r) return '<p class="hint">No review yet. Run a review to get QA notes on the delivered site.</p>';
  const items = [];
  ['issues', 'findings', 'problems', 'notes', 'suggestions', 'recommendations'].forEach((k) => {
    if (Array.isArray(r[k]))
      r[k].forEach((x) => items.push(typeof x === 'string' ? x : x.message || x.text || x.issue || JSON.stringify(x)));
  });
  return `<p>${r.pass === true ? '<span class="check-pass">PASS</span>' : r.pass === false ? '<span class="check-fail">NEEDS WORK</span>' : ''} <span class="hint">${esc(fmtDate(r.at))}</span></p>
    ${r.summary ? `<p>${esc(r.summary)}</p>` : ''}
    ${items.length ? `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : ''}
    <details><summary>Raw review</summary>${jsonPre(r)}</details>`;
}

/** Instruction-review layer (SAFE / BETTER_PATH / PUSH_BACK) from brief.change_request_review. */
function changeRequestReviewHtml(crr) {
  if (!crr || typeof crr !== 'object') return '';
  const cls = String(crr.classification || crr.class || '').toUpperCase();
  const badge =
    cls === 'SAFE'
      ? 'check-pass'
      : cls === 'PUSH_BACK' || cls === 'PUSHBACK'
        ? 'check-fail'
        : cls
          ? 'badge warn'
          : 'hint';
  const plan = crr.plan || crr.agent_plan || '';
  const msg = crr.clientMessage || crr.client_message || '';
  return `<div class="card" style="margin:0 0 10px;padding:10px 12px;background:var(--surface-2,transparent)">
      <p style="margin:0 0 6px"><strong>Change-request review</strong>
        ${cls ? ` <span class="${badge}">${esc(cls)}</span>` : ''}
        ${crr.at ? `<span class="hint"> · ${esc(fmtDate(crr.at))}</span>` : ''}</p>
      ${msg ? `<p style="margin:0 0 6px">${esc(msg)}</p>` : ''}
      ${plan ? `<p class="hint" style="margin:0;white-space:pre-wrap">${esc(typeof plan === 'string' ? plan : JSON.stringify(plan, null, 2))}</p>` : ''}
      <details style="margin-top:6px"><summary>Raw classification</summary>${jsonPre(crr)}</details>
    </div>`;
}

async function pageDesignDetail(id) {
  const r = await api.designGet(id);
  const job = r.data.job;
  const questions = job.questions || [];
  const deliverable = job.deliverable;
  const hasSite = !!(deliverable && Array.isArray(deliverable.pages) && deliverable.pages.length);
  const ers = job.email_redesigns || [];
  const brief = job.brief;

  view.innerHTML = `
    <div class="page-head">
      <div>
        <a href="#/design" class="btn small">&larr; All design jobs</a>
        <h1 style="margin-top:10px">#${esc(job.id)} ${esc(job.title)}</h1>
        <p class="lede">${statusBadge(job.status)} <span class="badge">${esc(job.type)}</span>
          ${job.website_shape || job.site_shape ? `<span class="badge">${esc(job.website_shape || job.site_shape)}</span>` : ''}${job.website_pages ? `<span class="badge">${esc(job.website_pages)} pages</span>` : ''}
          ${job.request_kind ? `<span class="badge warn">${esc(job.request_kind)}</span>` : ''}
          ${job.lead_id ? ` · Lead <a href="#/leads/${esc(job.lead_id)}">#${esc(job.lead_id)}</a>` : ''}
          · updated ${esc(fmtDate(job.updated_at))}</p>
      </div>
      <div class="page-actions"><button class="btn danger" data-act="delete">Delete job</button></div>
    </div>
    <div class="detail-grid">
      <div>
        <div class="card"><h3>Instructions</h3>
          <pre class="shell-log" tabindex="0">${esc(job.instructions || '') || '<span class="shell-empty">(no instructions)</span>'}</pre>
          ${
            job.type === 'website'
              ? `<div class="shell-actions"><label class="lbl" for="dd-shape">Site shape</label>
            <select id="dd-shape">${optionList(['multipage', 'landing'], job.site_shape || 'multipage')}</select>
            <button type="button" class="shell-link" data-act="shape">Update shape</button></div>`
              : ''
          }
        </div>

        <div class="card"><h3>Questions from the agent (${questions.length})</h3>
          ${
            questions
              .map(
                (q) => `<div class="q-card ${q.answer == null ? 'pending' : ''}">
            <div><b>Q${esc(q.id)}:</b> ${q.internal ? '<span class="badge">Internal note</span> ' : ''}${esc(q.question)}</div>
            ${
              q.answer != null
                ? `<div class="hint" style="margin-top:4px">Answer${q.from_email ? ' from ' + esc(q.from_email) : ''} · ${esc(fmtDate(q.answered_at))}</div><div style="white-space:pre-wrap">${esc(q.answer)}</div>`
                : `<textarea id="qa-${q.id}" placeholder="Your answer…"></textarea><button class="btn small primary" data-act="answer" data-q="${q.id}" style="margin-top:6px">Send answer</button>`
            }
          </div>`
              )
              .join('') || '<p class="hint">No questions.</p>'
          }
        </div>

        <div class="card"><h3>Client contact</h3>
          <div class="row end">
            <div class="field"><label class="lbl" for="dd-contact">Contact email</label><input id="dd-contact" type="email" value="${esc(job.contact_email || '')}" /></div>
            <div class="field"><label class="lbl" for="dd-contact-phone">Contact phone</label><input id="dd-contact-phone" type="tel" value="${esc(job.contact_phone || '')}" placeholder="+1 555 555 5555" /></div>
            <div class="field" style="flex:0 0 auto"><button class="btn" data-act="contact">Save contact</button></div>
          </div>
          <div class="inline">
            <button class="btn small" data-act="email-q">Email questions</button>
            <button class="btn small" data-act="email-d" ${deliverable && job.type !== 'website' ? '' : 'disabled'} title="${job.type === 'website' ? 'Use preview/export for websites' : ''}">Email delivery</button>
            <button class="btn small" data-act="client-form">Client form link</button>
            <span class="hint">${job.questions_emailed_at ? 'Questions emailed ' + esc(fmtDate(job.questions_emailed_at)) + '. ' : ''}${job.delivery_emailed_at ? 'Delivery emailed ' + esc(fmtDate(job.delivery_emailed_at)) + '.' : ''}</span>
          </div>
          <p class="hint" style="margin-top:8px">Emails include a public form link so clients can answer questions or request changes without IMAP.</p>
          <div id="dd-form-link" class="hint mono" style="margin-top:6px;word-break:break-all"></div>
          <details style="margin-top:10px"><summary>Record a client reply</summary>
            <div class="field"><label class="lbl">From email (optional)</label><input id="dd-rfrom" type="email" /></div>
            <div class="field"><label class="lbl">Reply text</label><textarea id="dd-reply" placeholder="Paste the reply. For multiple questions use 1. … 2. … or Q12: …"></textarea></div>
            <button class="btn small primary" data-act="reply">Record reply</button>
          </details>
          <div id="dd-email-out" class="hint" style="margin-top:8px"></div>
        </div>

        <div class="card"><h3>Review &amp; changes</h3>
          ${changeRequestReviewHtml(brief && brief.change_request_review)}
          <div id="dd-review">${reviewHtml(job.review)}</div>
          <div class="inline" style="margin:8px 0"><button class="btn" data-act="review" ${hasSite ? '' : 'disabled'}>Run review</button>${hasSite ? '' : '<span class="hint">Needs a delivered website.</span>'}</div>
          <div class="field"><label class="lbl">Redesign instructions</label><textarea id="dd-redesign" placeholder="Bigger changes: new look, structure, tone…"></textarea>
            <button class="btn small" data-act="redesign" style="margin-top:6px" ${hasSite ? '' : 'disabled'}>Queue redesign</button></div>
          <div class="field"><label class="lbl">Improvement instructions</label><textarea id="dd-improve" placeholder="Polish and fixes only…"></textarea>
            <button class="btn small" data-act="improve" style="margin-top:6px" ${hasSite ? '' : 'disabled'}>Queue improvements</button></div>
          <div id="dd-change-out" class="hint"></div>
        </div>
      </div>

      <div>
        <div class="card"><h3>Delivery</h3>
          ${
            deliverable
              ? `${
                  hasSite
                    ? `<div class="font-toolbar">
               <p class="hint">Google fonts for this design. Preview updates as you pick; Save keeps site fonts. Style one element in the preview when needed.</p>
               <div class="font-toolbar-row">
                 <div class="field"><label class="lbl" for="dd-font-body">Site</label><select id="dd-font-body"></select></div>
                 <div class="field"><label class="lbl" for="dd-font-heading">Headings</label><select id="dd-font-heading"></select></div>
                 <button type="button" class="btn small" id="dd-font-save">Save site fonts</button>
               </div>
               <hr class="font-toolbar-divider" />
               <div class="font-toolbar-row is-actions">
                 <button type="button" class="btn small" id="dd-font-edit">Style an element</button>
                 <div class="field"><label class="lbl" for="dd-font-element">This element</label><select id="dd-font-element" disabled></select></div>
                 <span class="msg" id="dd-font-msg"></span>
               </div>
               <p class="hint" style="margin-top:6px">“This element” stays disabled until you click “Style an element” and select text in the preview.</p>
             </div><div id="dd-preview"></div>`
                    : ''
                }
               <div class="inline" style="margin-top:8px">
                 ${job.type === 'website' ? '<button class="btn small" data-act="url">Preview URL</button>' : ''}
                 <button class="btn small" data-act="photos">Add Pexels photos</button>
                 <button class="btn small" data-act="genimg">Generate image</button>
                 ${job.website_id ? `<a class="btn small" href="#/websites/${esc(job.website_id)}">Open website</a>` : ''}
               </div>
               <div id="dd-delivery-out" class="hint" style="margin-top:6px"></div>
               ${(job.claims || []).length ? `<details style="margin-top:8px"><summary>Claims (${job.claims.length})</summary>${jsonPre(job.claims)}</details>` : ''}
               <details style="margin-top:8px"><summary>Raw delivery</summary>${jsonPre(deliverable)}</details>`
              : '<p class="hint">Nothing delivered yet. The MCP agent will deliver here.</p>'
          }
        </div>

        <div class="card"><h3>Email change requests</h3>
          <div id="dd-er">${ers.map((x) => erRowHtml(x, false)).join('') || '<p class="hint">No pending requests for this job.</p>'}</div>
          <details style="margin-top:10px"><summary>Paste a client email</summary>
            <div class="row"><div class="field"><label class="lbl">From</label><input id="er-from" type="email" /></div>
              <div class="field"><label class="lbl">Kind</label><select id="er-kind"><option value="">Auto-detect</option><option value="redesign">Redesign</option><option value="improvements">Improvements</option></select></div></div>
            <div class="field"><label class="lbl">Subject</label><input id="er-subject" type="text" /></div>
            <div class="field"><label class="lbl">Body</label><textarea id="er-body"></textarea></div>
            <button class="btn small primary" data-act="er-save">Save request</button>
          </details>
        </div>

        ${brief ? `<div class="card"><details><summary>Design brief</summary>${jsonPre(brief)}</details></div>` : ''}
      </div>
    </div>`;

  let designFontHooks = null;
  if (hasSite) {
    const designPreview = mountPreview(
      $('#dd-preview'),
      (slug) => api.designRender(id, { editable: true, pageSlug: slug }),
      {
        onPreview: (data) => {
          if (designFontHooks) designFontHooks.onPreview(data);
        },
      }
    );
    const designPages = deliverable.pages;
    const designTheme = deliverable.theme && typeof deliverable.theme === 'object' ? deliverable.theme : {};
    designFontHooks = bindFontToolbar(
      'dd',
      designPreview,
      () => designPages,
      () => designTheme,
      (nextPages, nextTheme) => api.designSaveWebsite(id, nextPages, nextTheme)
    );
  }
  fillChangeInstructionBoxes(job);

  // Server contract: an EMPTY instruction box means "refresh" — the server
  // re-runs the design against the latest answers/facts (refresh) and forces
  // a fresh review (forceReview) unless the job already has one. Typed
  // instructions request a targeted change instead (both flags false).
  const changeBody = (kind) => {
    const instr = $(kind === 'improvements' ? '#dd-improve' : '#dd-redesign').value.trim();
    return { instructions: instr || undefined, refresh: !instr, forceReview: !instr && !(job.review && job.review.at) };
  };

  delegate(view, {
    delete: async () => {
      if (!window.confirm('Delete this design job?')) return;
      await api.designDelete(id);
      window.location.hash = '#/design';
    },
    shape: async () => {
      await api.designUpdate(id, { site_shape: $('#dd-shape').value });
      toast('Shape updated', 'ok');
      pageDesignDetail(id);
    },
    answer: async (t) => {
      const text = $('#qa-' + t.dataset.q).value.trim();
      if (!text) {
        toast('Write an answer first.', 'err');
        return;
      }
      await api.designAnswer(Number(t.dataset.q), text);
      toast('Answer recorded', 'ok');
      pageDesignDetail(id);
    },
    contact: async () => {
      await api.designContact(id, {
        email: $('#dd-contact').value.trim(),
        phone: ($('#dd-contact-phone') && $('#dd-contact-phone').value.trim()) || '',
      });
      toast('Contact saved', 'ok');
    },
    'email-q': async () => {
      const x = (await api.designEmailQuestions(id)).data;
      const msg =
        x && x.error ? x.error : x && x.sent ? `Sent to ${x.to}` : x && (x.message || 'Questions email processed.');
      $('#dd-email-out').textContent = msg;
      toast(
        x && x.sent
          ? `Questions emailed to ${x.to}`
          : x && x.code === 'SMTP_NOT_CONFIGURED'
            ? 'SMTP not configured'
            : 'Questions email processed',
        x && x.sent ? 'ok' : ''
      );
    },
    'email-d': async () => {
      const x = (await api.designEmailDelivery(id)).data;
      const msg =
        x && x.error ? x.error : x && x.sent ? `Sent to ${x.to}` : x && (x.message || 'Delivery email processed.');
      $('#dd-email-out').textContent = msg;
      toast(
        x && x.sent
          ? `Delivery emailed to ${x.to}`
          : x && x.code === 'SMTP_NOT_CONFIGURED'
            ? 'SMTP not configured'
            : 'Delivery email processed',
        x && x.sent ? 'ok' : ''
      );
    },
    reply: async () => {
      const reply = $('#dd-reply').value.trim();
      if (!reply) {
        toast('Paste the reply text.', 'err');
        return;
      }
      await api.designReply(id, reply, $('#dd-rfrom').value.trim() || undefined);
      toast('Reply recorded', 'ok');
      pageDesignDetail(id);
    },
    'client-form': async () => {
      const x = (await api.designClientForm(id)).data;
      const el = $('#dd-form-link');
      if (el) el.innerHTML = `Client form: <a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.url)}</a>`;
      try {
        if (navigator.clipboard && x.url) {
          await navigator.clipboard.writeText(x.url);
          toast('Client form link copied', 'ok');
        } else toast('Client form link ready', 'ok');
      } catch {
        toast('Client form link ready', 'ok');
      }
    },
    review: async () => {
      $('#dd-review').innerHTML = '<p class="hint">Reviewing…</p>';
      const x = (await api.designReview(id, {})).data;
      const review = (x && x.review) || (x && x.job && x.job.review) || x;
      $('#dd-review').innerHTML = reviewHtml(review);
      fillChangeInstructionBoxes(job, review);
    },
    redesign: async () => {
      await api.designRedesign(id, changeBody('redesign'));
      toast('Redesign queued for the agent', 'ok');
      pageDesignDetail(id);
    },
    improve: async () => {
      await api.designImprove(id, changeBody('improvements'));
      toast('Improvements queued for the agent', 'ok');
      pageDesignDetail(id);
    },
    url: async () => {
      $('#dd-delivery-out').textContent = 'Publishing preview…';
      const x = (await api.designPreview(id, false)).data;
      const link = x.url
        ? `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.url)}</a>`
        : esc(x.path || '');
      $('#dd-delivery-out').innerHTML =
        `Public preview: ${link}${x.via ? `<div class="hint">via ${esc(x.via)}</div>` : ''}`;
    },
    photos: async () => {
      const x = (await api.designImages(id, {})).data;
      $('#dd-delivery-out').textContent = `Added ${x.count != null ? x.count : '?'} photo(s).`;
      pageDesignDetail(id);
    },
    genimg: async () => {
      const prompt = window.prompt('Image prompt (leave blank for a lead-aware default):', '');
      if (prompt === null) return;
      $('#dd-delivery-out').textContent = 'Generating image…';
      const x = (await api.designGenerateImages(id, { prompt: prompt.trim() || undefined, n: 1, quality: 'low' })).data;
      $('#dd-delivery-out').textContent =
        `Generated ${x.count != null ? x.count : '?'} image(s)${x.model ? ' with ' + x.model : ''}.`;
      pageDesignDetail(id);
    },
    'er-save': async () => {
      const body = $('#er-body').value.trim();
      if (!body) {
        toast('Paste the email body.', 'err');
        return;
      }
      const x = (
        await api.emailRedesignIngest(
          dropEmpty({
            designJobId: id,
            fromEmail: $('#er-from').value.trim(),
            subject: $('#er-subject').value.trim(),
            body,
            source: 'paste',
            force: true,
            requestKind: $('#er-kind').value,
          })
        )
      ).data;
      if (x.skipped) {
        toast(x.error || 'Not detected as a change request.', 'err');
        return;
      }
      toast('Request saved', 'ok');
      pageDesignDetail(id);
    },
    'er-submit': async (t) => {
      await api.emailRedesignSubmit(Number(t.dataset.id), { designJobId: id });
      toast('Submitted to the agent queue', 'ok');
      pageDesignDetail(id);
    },
    'er-dismiss': async (t) => {
      await api.emailRedesignDismiss(Number(t.dataset.id));
      pageDesignDetail(id);
    },
    'er-use': (t) => {
      const x = ers.find((e) => String(e.id) === t.dataset.id);
      if (!x) return;
      const area = $(x.request_kind === 'improvements' ? '#dd-improve' : '#dd-redesign');
      area.value = x.body || x.body_excerpt || '';
      toast('Copied into ' + x.request_kind + ' instructions.', 'ok');
    },
  });
}

/* ------------------------------------------------------------------ */
/* Outreach                                                            */
/* ------------------------------------------------------------------ */

let outreachTab = 'campaigns';

async function pageOutreach(param, query) {
  let st;
  try {
    st = (await withLoadTimeout(api.outreachStats())).data;
  } catch (e) {
    view.innerHTML = loadErrorCardHtml(errText(e));
    wirePageRetry(() => pageOutreach(param, query));
    return;
  }
  const mbs = st.messagesByStatus || {};
  view.innerHTML = `
    <div class="page-head">
      <div><h1>Outreach</h1><p class="lede">Email and SMS templates, campaigns, the send queue and the suppression list. SMS credentials are in Settings → SMS (or Admin → SMS).</p></div>
      <div class="page-actions"><button class="btn primary" data-act="process">Process queue now</button></div>
    </div>
    <div class="stats-cards">
      <div class="stat-card"><div class="stat-label">Sent today</div><div class="stat-value">${esc(st.sentToday)} / ${esc(st.dailyCap)}</div></div>
      <div class="stat-card"><div class="stat-label">Queued</div><div class="stat-value">${esc(mbs.queued || 0)}</div></div>
      <div class="stat-card"><div class="stat-label">Campaigns</div><div class="stat-value">${esc(st.activeCampaigns)} / ${esc(st.campaigns)}</div><div class="hint">active / total</div></div>
      <div class="stat-card"><div class="stat-label">Templates</div><div class="stat-value">${esc(st.templates)}</div></div>
      <div class="stat-card"><div class="stat-label">Suppressed</div><div class="stat-value">${esc(st.suppressionCount)}</div></div>
    </div>
    <div class="tabs" id="o-tabs">
      ${['campaigns', 'templates', 'suppression'].map((t) => `<button data-tab="${t}" class="${outreachTab === t ? 'active' : ''}">${esc(t[0].toUpperCase() + t.slice(1))}</button>`).join('')}
    </div>
    <div id="o-tab"></div>`;

  $('#o-tabs').onclick = (e) => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    outreachTab = b.dataset.tab;
    $$('#o-tabs button').forEach((x) => x.classList.toggle('active', x === b));
    loadTab();
  };
  delegate($('.page-actions', view), {
    process: async () => {
      const r = (await api.processQueue()).data;
      toast('Queue processed' + (r && r.sent != null ? `: ${r.sent} sent` : ''), 'ok');
      pageOutreach();
    },
  });

  async function loadTab() {
    const host = $('#o-tab');
    if (!host) return;
    host.innerHTML = '<p class="hint"><span class="load-spin" aria-hidden="true"></span> Loading…</p>';
    try {
      await withLoadTimeout(
        outreachTab === 'campaigns'
          ? tabCampaigns(host)
          : outreachTab === 'templates'
            ? tabTemplates(host)
            : tabSuppression(host)
      );
    } catch (e) {
      if (!$('#o-tab')) return;
      host.innerHTML = `<div class="card error-card"><p>Could not load this tab (${esc(errText(e))}).</p><p><button class="btn" data-act="o-retry">Retry</button></p></div>`;
      const b = host.querySelector('[data-act="o-retry"]');
      if (b) b.addEventListener('click', () => loadTab());
    }
  }
  await loadTab();
  if (query && query.new) openCampaignModal();
}

function confirmCampaignAction({ title, body, confirmLabel, danger }, onConfirm) {
  openModal({
    title,
    body: `<p>${body}</p>`,
    buttons: [
      { label: 'Keep', onClick: (m) => m.close() },
      {
        label: confirmLabel,
        cls: danger ? 'danger' : 'primary',
        onClick: async (m) => {
          await onConfirm();
          m.close();
        },
      },
    ],
  });
}

async function tabCampaigns(host) {
  const r = (await api.campaigns({ pageSize: 50 })).data || {};
  const rows = asList(r, ['rows', 'campaigns']);
  const canCancel = (s) => s === 'active' || s === 'paused' || s === 'draft';
  host.innerHTML = `
    <div class="toolbar">
      <button class="btn primary" data-act="new">New campaign</button>
      <button class="btn" data-act="compose">Compose email</button>
      <button class="btn" data-act="compose-sms">Compose SMS</button>
    </div>
    <p class="hint">Campaigns are multi-send sequences to many leads. Single sends to one lead (Compose, above) don't appear here — they live in that lead's timeline.</p>
    <div class="table-wrap"><table>
      <thead><tr><th>Name</th><th>Status</th><th>Queued</th><th>Sent</th><th>Failed</th><th>Suppressed</th><th>Rate/h</th><th></th></tr></thead>
      <tbody>${
        rows
          .map(
            (c) => `<tr>
        <td>${esc(c.name)}<div class="hint">#${esc(c.id)} · ${esc(fmtDate(c.created_at))}</div></td>
        <td>${statusBadge(c.status)}</td><td>${esc(c.queued)}</td><td>${esc(c.sent)}</td><td>${esc(c.failed)}</td><td>${esc(c.suppressed)}</td><td>${esc(c.rate_per_hour || '—')}</td>
        <td class="actions">
          <button class="btn small" data-act="messages" data-id="${c.id}" data-name="${esc(c.name)}">Messages</button>
          ${c.status === 'active' ? `<button class="btn small" data-act="pause" data-id="${c.id}">Pause</button>` : ''}
          ${c.status === 'paused' || c.status === 'draft' ? `<button class="btn small" data-act="resume" data-id="${c.id}">Resume</button>` : ''}
          ${canCancel(c.status) ? `<button class="btn small" data-act="cancel" data-id="${c.id}" data-name="${esc(c.name)}">Cancel</button>` : ''}
          <button class="btn small danger" data-act="delete" data-id="${c.id}" data-name="${esc(c.name)}">Delete</button>
        </td></tr>`
          )
          .join('') || '<tr><td colspan="8" class="empty">No campaigns yet.</td></tr>'
      }</tbody>
    </table></div>`;
  delegate(host, {
    new: () => openCampaignModal(),
    compose: () => openComposeModal('email'),
    'compose-sms': () => openComposeModal('sms'),
    messages: (t) => openMessagesModal(Number(t.dataset.id), t.dataset.name),
    pause: async (t) => {
      await api.campaignStatus(Number(t.dataset.id), 'paused');
      tabCampaigns(host);
    },
    resume: async (t) => {
      await api.campaignStatus(Number(t.dataset.id), 'active');
      tabCampaigns(host);
    },
    cancel: (t) => {
      const id = Number(t.dataset.id);
      const name = t.dataset.name || '#' + id;
      confirmCampaignAction(
        {
          title: 'Cancel campaign',
          body: `Cancel <strong>${esc(name)}</strong>? This permanently stops the campaign. Queued messages will not send. You cannot resume afterwards (unlike Pause).`,
          confirmLabel: 'Cancel campaign',
          danger: true,
        },
        async () => {
          const res = await api.campaignCancel(id);
          const n = (res.data && res.data.cancelledQueued) || 0;
          toast(n ? `Campaign cancelled (${n} queued stopped)` : 'Campaign cancelled', 'ok');
          tabCampaigns(host);
        }
      );
    },
    delete: (t) => {
      const id = Number(t.dataset.id);
      const name = t.dataset.name || '#' + id;
      confirmCampaignAction(
        {
          title: 'Delete campaign',
          body: `Permanently delete <strong>${esc(name)}</strong> and all of its messages? This cannot be undone.`,
          confirmLabel: 'Delete',
          danger: true,
        },
        async () => {
          await api.campaignDelete(id);
          toast('Campaign deleted', 'ok');
          tabCampaigns(host);
        }
      );
    },
  });
}

async function openMessagesModal(campaignId, name) {
  const m = openModal({
    title: 'Messages — ' + name,
    wide: true,
    body: '<div id="cm-body"><p class="hint">Loading…</p></div>',
  });
  let page = 1;
  let status = '';
  const cmGate = latestGate();
  async function load() {
    const mine = cmGate();
    const r = (await api.campaignMessages(campaignId, { page, pageSize: 25, status })).data;
    const body = $('#cm-body', m.el);
    if (!mine() || !body) return;
    body.innerHTML = `<div class="toolbar"><select id="cm-status"><option value="">All statuses</option>${optionList(['queued', 'sent', 'failed', 'suppressed'], status)}</select></div>
      <div class="table-wrap"><table><thead><tr><th>To</th><th>Channel</th><th>Subject / preview</th><th>Status</th><th>Scheduled</th><th>Sent</th><th></th></tr></thead>
      <tbody>${
        (r.rows || [])
          .map((x) => {
            const ch = (x.channel || 'email') === 'sms' ? 'sms' : 'email';
            const to = ch === 'sms' ? x.to_phone || x.to_email : x.to_email;
            const preview = ch === 'sms' ? String(x.body || '').slice(0, 80) : x.subject;
            return `<tr>
        <td>${esc(to)}<div class="hint">${esc(x.business_name || '')}</div></td>
        <td>${statusBadge(ch)}</td>
        <td>${esc(preview)}${x.error ? `<div class="error hint">${esc(x.error)}</div>` : ''}</td>
        <td>${statusBadge(x.status)}</td><td>${esc(fmtDate(x.scheduled_at))}</td><td>${esc(fmtDate(x.sent_at))}</td>
        <td>${x.status === 'queued' ? `<button class="btn small" data-act="send" data-id="${x.id}">Send now</button>` : ''}</td></tr>`;
          })
          .join('') || '<tr><td colspan="7" class="empty">No messages.</td></tr>'
      }</tbody></table></div>
      <div class="pagination" id="cm-pager"></div>`;
    $('#cm-status', m.el).value = status;
    $('#cm-status', m.el).onchange = (e) => {
      status = e.target.value;
      page = 1;
      load();
    };
    pager($('#cm-pager', m.el), { page: r.page || 1, pages: r.pages || 1, total: r.total || 0 }, (p) => {
      page = p;
      load();
    });
  }
  delegate(m.el, {
    send: async (t) => {
      const x = (await api.emailSend(Number(t.dataset.id))).data;
      const label = x.channel === 'sms' ? 'SMS' : 'Email';
      toast(x.sent ? `${label} sent to ${x.to}` : 'Not sent (suppressed)', x.sent ? 'ok' : '');
      load();
    },
  });
  await load();
}

async function openCampaignModal() {
  const tplR = await api.templates();
  let templates = tplR.data.templates || [];
  const selected = new Set();
  try {
    (JSON.parse(sessionStorage.getItem('scout.campaignLeadIds') || '[]') || []).forEach((i) => selected.add(Number(i)));
  } catch {
    /* ignore */
  }
  sessionStorage.removeItem('scout.campaignLeadIds');
  let results = [];

  const m = openModal({
    title: 'New campaign',
    wide: true,
    body: `<div class="row">
        <div class="field"><label>Name *</label><input id="cp-name" type="text" /></div>
        <div class="field"><label>Template *</label><select id="cp-tpl"></select></div>
        <div class="field"><label>Send via</label>
          <select id="cp-channel">
            <option value="email">Email</option>
            <option value="sms">SMS</option>
            <option value="both">Email + SMS</option>
          </select>
        </div>
        <div class="field" style="max-width:130px"><label id="cp-rate-label">Per hour</label><input id="cp-rate" type="number" min="1" max="1000" value="30" /></div>
      </div>
      <div class="field"><label>Find leads</label>
        <div class="inline"><input id="cp-q" type="search" placeholder="Search leads…" class="grow" style="flex:1" />
          <select id="cp-status" style="width:auto"><option value="">Any status</option>${optionList(LEAD_STATUSES, '')}</select>
          <button class="btn small" data-act="addall">Add all results</button></div></div>
      <div class="pick-list" id="cp-results"><div class="empty">Search or filter to list leads.</div></div>
      <p class="hint"><b id="cp-count">0</b> lead(s) selected. <span id="cp-elig-hint">Leads without an email, or on the suppression list, are never sent.</span>
        <button class="link-btn" data-act="clearsel">Clear</button></p>
      <div class="msg" id="cp-msg"></div>`,
    buttons: [
      { label: 'Cancel' },
      {
        label: 'Create campaign',
        cls: 'primary',
        onClick: async (mm) => {
          const name = $('#cp-name', mm.el).value.trim();
          const templateId = Number($('#cp-tpl', mm.el).value);
          const channel = $('#cp-channel', mm.el).value || 'email';
          const msg = $('#cp-msg', mm.el);
          if (!name) {
            setMsg(msg, 'Name is required.', 'err');
            return;
          }
          if (!templateId) {
            setMsg(msg, 'Choose a template.', 'err');
            return;
          }
          if (!selected.size) {
            setMsg(msg, 'Select at least one lead.', 'err');
            return;
          }
          const r = (
            await api.createCampaign({
              name,
              templateId,
              channel,
              leadIds: Array.from(selected),
              ratePerHour: Number($('#cp-rate', mm.el).value) || 30,
            })
          ).data;
          toast('Campaign created' + (r && r.queued != null ? `: ${r.queued} queued` : ''), 'ok');
          mm.close();
          pageOutreach();
        },
      },
    ],
  });

  function tplHasEmail(t) {
    return !!String(t.body || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  function tplHasSms(t) {
    return !!(String(t.sms_body || '').trim() || ((t.channel || '') === 'sms' && String(t.body || '').trim()));
  }
  function fillTemplates() {
    const ch = $('#cp-channel', m.el).value;
    const list = templates.filter((t) => {
      if (ch === 'sms') return tplHasSms(t);
      if (ch === 'both') return tplHasEmail(t) && tplHasSms(t);
      return tplHasEmail(t);
    });
    $('#cp-tpl', m.el).innerHTML =
      list.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('') ||
      `<option value="">(no templates with ${ch === 'both' ? 'email + SMS' : ch} content)</option>`;
    const hint = $('#cp-elig-hint', m.el);
    if (hint) {
      hint.textContent =
        ch === 'sms'
          ? 'Leads without a phone number are never texted.'
          : ch === 'both'
            ? 'Email needs a non-suppressed address; SMS needs a phone. Missing either channel is suppressed for that channel only.'
            : 'Leads without an email, or on the suppression list, are never sent.';
    }
    $('#cp-rate-label', m.el).textContent =
      ch === 'sms' ? 'Texts / hour' : ch === 'both' ? 'Messages / hour' : 'Emails / hour';
  }
  fillTemplates();
  $('#cp-channel', m.el).onchange = fillTemplates;

  const count = () => {
    $('#cp-count', m.el).textContent = selected.size;
  };
  function renderResults() {
    const ch = $('#cp-channel', m.el).value;
    $('#cp-results', m.el).innerHTML =
      results
        .map((l) => {
          const contact = ch === 'sms' ? l.phone || 'no phone' : l.email || 'no email';
          return `<label class="pick-row"><input type="checkbox" data-lead="${l.id}" ${selected.has(l.id) ? 'checked' : ''} />
      <span><b>${esc(l.business_name)}</b> <span class="hint">#${l.id} · ${esc(contact)} · ${esc(l.status)}</span></span></label>`;
        })
        .join('') || '<div class="empty">No leads found.</div>';
  }
  const search = async () => {
    const r = (
      await api.leads({ q: $('#cp-q', m.el).value.trim(), status: $('#cp-status', m.el).value, pageSize: 100 })
    ).data;
    results = r.leads || [];
    renderResults();
  };
  $('#cp-q', m.el).addEventListener(
    'input',
    debounce(() => safeRun(null, search), 300)
  );
  $('#cp-status', m.el).addEventListener('change', () => safeRun(null, search));
  $('#cp-results', m.el).addEventListener('change', (e) => {
    const cb = e.target.closest('[data-lead]');
    if (!cb) return;
    const id = Number(cb.dataset.lead);
    if (cb.checked) selected.add(id);
    else selected.delete(id);
    count();
  });
  delegate(m.el, {
    addall: () => {
      results.forEach((l) => selected.add(l.id));
      renderResults();
      count();
    },
    clearsel: () => {
      selected.clear();
      renderResults();
      count();
    },
  });
  count();
  if (selected.size) setMsg($('#cp-msg', m.el), `${selected.size} lead(s) preselected from the Leads page.`);
  await search();
}

function looksLikeHtmlClient(s) {
  return typeof s === 'string' && /<\/?[a-z][\s\S]*>/i.test(s);
}

function plainToEditorHtml(text) {
  const t = String(text || '')
    .replace(/\r\n/g, '\n')
    .trim();
  if (!t) return '<p>Hi {{business_name}},</p><p>…</p>';
  if (looksLikeHtmlClient(t)) return t;
  return t
    .split(/\n{2,}/)
    .map((block) => {
      const inner = esc(block).replace(/\n/g, '<br>');
      return `<p>${inner}</p>`;
    })
    .join('');
}

/**
 * Lightweight contenteditable email body editor (bold / links / lists / images).
 * Stores HTML in a hidden textarea named "body" for form submit.
 */
function mountEmailBodyEditor(host, { initialHtml } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'email-rte';
  wrap.innerHTML = `
    <div class="email-rte-toolbar" role="toolbar" aria-label="Formatting">
      <button type="button" class="btn small" data-cmd="bold" title="Bold"><b>B</b></button>
      <button type="button" class="btn small" data-cmd="italic" title="Italic"><i>I</i></button>
      <button type="button" class="btn small" data-cmd="insertUnorderedList" title="Bullet list">• List</button>
      <button type="button" class="btn small" data-cmd="insertOrderedList" title="Numbered list">1. List</button>
      <button type="button" class="btn small" data-cmd="link" title="Insert link">Link</button>
      <button type="button" class="btn small" data-cmd="image" title="Upload image">Image</button>
      <button type="button" class="btn small" data-cmd="site-shot" title="Insert site screenshot merge field">Site screenshot</button>
    </div>
    <div class="email-rte-surface" contenteditable="true" role="textbox" aria-multiline="true"></div>
    <textarea name="body" class="email-rte-hidden" required hidden></textarea>
    <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" class="email-rte-file" hidden />`;
  host.appendChild(wrap);
  const surface = $('.email-rte-surface', wrap);
  const hidden = $('.email-rte-hidden', wrap);
  const fileInput = $('.email-rte-file', wrap);

  const sync = () => {
    hidden.value = surface.innerHTML.trim();
  };
  const setHtml = (html) => {
    surface.innerHTML = plainToEditorHtml(html);
    sync();
  };
  setHtml(initialHtml || '<p>Hi {{business_name}},</p><p>…</p>');
  surface.addEventListener('input', sync);
  surface.addEventListener('blur', sync);

  const insertHtml = (html) => {
    surface.focus();
    try {
      document.execCommand('insertHTML', false, html);
    } catch {
      surface.insertAdjacentHTML('beforeend', html);
    }
    sync();
  };

  $('.email-rte-toolbar', wrap).onclick = async (e) => {
    const btn = e.target.closest('[data-cmd]');
    if (!btn) return;
    e.preventDefault();
    const cmd = btn.dataset.cmd;
    surface.focus();
    if (cmd === 'link') {
      const url = window.prompt('Link URL (https://… or mailto:…)', 'https://');
      if (!url) return;
      const safe = String(url).trim();
      if (!/^(https?:\/\/|mailto:|tel:)/i.test(safe)) {
        toast('Links must start with https://, mailto:, or tel:', 'err');
        return;
      }
      document.execCommand('createLink', false, safe);
      sync();
      return;
    }
    if (cmd === 'image') {
      fileInput.value = '';
      fileInput.click();
      return;
    }
    if (cmd === 'site-shot') {
      // Per-recipient merge field — resolved at campaign create to each lead's email JPEG.
      insertHtml('<p>{{site_screenshot}}</p>');
      toast('Inserted {{site_screenshot}} — each recipient gets their own site preview image.', 'ok');
      return;
    }
    document.execCommand(cmd, false, null);
    sync();
  };

  fileInput.onchange = async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      toast('Image must be 5 MB or smaller.', 'err');
      return;
    }
    try {
      toast('Uploading image…');
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Could not read file'));
        reader.readAsDataURL(file);
      });
      const r = (await api.emailUploadAsset({ data: dataUrl, mimeType: file.type })).data;
      insertHtml(`<p><img src="${esc(r.url)}" alt="" style="max-width:100%;height:auto;"></p>`);
      toast('Image added', 'ok');
    } catch (err) {
      toast(errText(err), 'err');
    }
  };

  return {
    getHtml: () => {
      sync();
      return hidden.value;
    },
    setHtml,
    el: wrap,
  };
}

async function openComposeModal(channel = 'email') {
  const ch = channel === 'sms' ? 'sms' : 'email';
  const tplRes = await api.templates();
  const all = (tplRes.data && tplRes.data.templates) || [];
  const templates = all.filter((t) => {
    if (ch === 'sms') {
      return !!(String(t.sms_body || '').trim() || ((t.channel || '') === 'sms' && String(t.body || '').trim()));
    }
    return !!String(t.body || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  });
  const m = openModal({
    title: ch === 'sms' ? 'Compose a single SMS' : 'Compose a single email',
    wide: true,
    body: `<div class="field"><label>Lead</label><div id="cx-lead"></div></div>
      <div class="field"><label>Template</label><select id="cx-tpl">${templates.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('') || '<option value="">(create a template with ' + (ch === 'sms' ? 'SMS' : 'email') + ' content first)</option>'}</select></div>
      <div id="cx-prev" class="hint">${
        ch === 'sms'
          ? 'Uses the template’s SMS body. {{website_link}} is the live preview URL. {{site_screenshot}} attaches that lead’s MMS JPEG when captured (falls back to text+link). The lead must have a phone number.'
          : 'Uses the template’s email subject/body. {{website_link}} is the live preview URL. {{site_screenshot}} inserts that lead’s hosted preview image. {{interested}} / {{uninterested}} become signed response links.'
      }</div>`,
    buttons: [
      { label: 'Close' },
      {
        label: 'Preview',
        onClick: async (mm) => {
          const lead = picker.get();
          if (!lead) {
            toast('Select a lead.', 'err');
            return;
          }
          const tid = Number($('#cx-tpl', mm.el).value);
          if (!tid) {
            toast('Choose a template.', 'err');
            return;
          }
          if (ch === 'sms' && !lead.phone) {
            toast('This lead has no phone number.', 'err');
            return;
          }
          const r = (await api.emailCompose(lead.id, tid, false, ch)).data;
          const bodyHtml =
            ch === 'sms' || !looksLikeHtmlClient(r.body)
              ? `<p style="white-space:pre-wrap">${esc(r.body)}</p>`
              : `<div class="email-preview-body">${r.body}</div>`;
          $('#cx-prev', mm.el).innerHTML =
            `<div class="q-card"><b>${esc(ch === 'sms' ? 'SMS' : r.subject)}</b>${bodyHtml}${(r.missing || []).length ? `<div class="hint">Missing: ${esc(r.missing.join(', '))}</div>` : ''}</div>`;
        },
      },
      {
        label: 'Queue & send now',
        cls: 'primary',
        onClick: async (mm) => {
          const lead = picker.get();
          if (!lead) {
            toast('Select a lead.', 'err');
            return;
          }
          const tid = Number($('#cx-tpl', mm.el).value);
          if (!tid) {
            toast('Choose a template.', 'err');
            return;
          }
          if (ch === 'sms' && !lead.phone) {
            toast('This lead has no phone number.', 'err');
            return;
          }
          if (!window.confirm(ch === 'sms' ? 'Send this SMS now?' : 'Send this email now?')) return;
          const q = (await api.emailCompose(lead.id, tid, true, ch)).data;
          const s = (await api.emailSend(q.messageId)).data;
          const label = s.channel === 'sms' ? 'SMS' : 'Email';
          toast(s.sent ? `${label} sent to ${s.to}` : 'Not sent (suppressed)', s.sent ? 'ok' : 'err');
          mm.close();
        },
      },
    ],
  });
  const picker = mountLeadPicker($('#cx-lead', m.el));
}

/** In-app AI draft for Outreach templates (no window.prompt). Fills email + SMS together. */
function openAiWriteModal({ existingSubject, existingBody, onApplied }) {
  const m = openModal({
    title: 'Help me write with AI',
    body: `
      <div class="field">
        <label for="ai-brief">Writing brief</label>
        <textarea id="ai-brief" rows="4" placeholder="Tone, offer, angle — e.g. friendly intro for a new local website preview"></textarea>
        <div class="hint">Optional. Generates an email draft plus a companion SMS with {{website_link}}.</div>
      </div>
      <div class="field">
        <label>Lead for context <span class="hint">(optional)</span></label>
        <div id="ai-lead"></div>
        <div class="hint">Search by name, business, or email. Clear the selection for a reusable template.</div>
      </div>
      <p class="msg" id="ai-msg"></p>`,
    buttons: [
      { label: 'Cancel' },
      {
        label: 'Generate',
        cls: 'primary',
        onClick: async (mm, btn) => {
          const brief = ($('#ai-brief', mm.el).value || '').trim();
          const lead = picker.get();
          const leadId = lead && lead.id ? Number(lead.id) : undefined;
          const msg = $('#ai-msg', mm.el);
          setMsg(msg, 'Generating with AI…');
          btn.textContent = 'Generating…';
          try {
            const r = (
              await api.emailDraft({
                prompt: brief || undefined,
                leadId,
                existingSubject,
                existingBody: existingBody || '',
              })
            ).data;
            if (typeof onApplied === 'function') onApplied(r, leadId || null);
            mm.close();
          } catch (err) {
            setMsg(msg, errText(err), 'err');
            btn.textContent = 'Generate';
          }
        },
      },
    ],
  });
  const picker = mountLeadPicker($('#ai-lead', m.el), {
    placeholder: 'Search by name, business, or email…',
  });
  const briefEl = $('#ai-brief', m.el);
  if (briefEl) briefEl.focus();
  return m;
}

async function tabTemplates(host) {
  const templates = asList((await api.templates()).data, ['templates', 'rows']);
  const emailVarChips = [
    'business_name',
    'city',
    'category',
    'phone',
    'website_link',
    'site_screenshot',
    'interested',
    'uninterested',
  ]
    .map((v) => `<code class="var-chip" data-var="{{${v}}}" data-target="email">{{${v}}}</code>`)
    .join(' ');
  const smsVarChips = ['business_name', 'city', 'category', 'phone', 'website_link', 'site_screenshot']
    .map((v) => `<code class="var-chip" data-var="{{${v}}}" data-target="sms">{{${v}}}</code>`)
    .join(' ');
  host.innerHTML = `
    <div class="grid cols-2" style="align-items:start">
      <div class="card"><h3 id="tp-title">New template</h3>
        <form id="tp-form">
          <input type="hidden" name="id" />
          <div class="field"><label>Name</label><input name="name" required /></div>
          <div class="field" id="tp-subject-wrap"><label>Email subject</label><input name="subject" id="tp-subject" /></div>
          <div class="field" id="tp-email-body-wrap">
            <div class="field-head">
              <label for="tp-body-host">Email body</label>
              <button type="button" class="btn small" data-act="ai-write">Help me write with AI</button>
            </div>
            <div id="tp-body-host"></div>
            <div class="hint">Variables: ${emailVarChips}. <code>{{website_link}}</code> is the active published site URL.</div>
          </div>
          <div class="field" id="tp-sms-body-wrap">
            <div class="field-head">
              <label for="tp-sms-body">SMS body (plain text)</label>
            </div>
            <textarea id="tp-sms-body" name="sms_body" rows="4" maxlength="1600" placeholder="Hi {{business_name}} — preview: {{website_link}}"></textarea>
            <div class="hint">Saved with this template. Keep it short (≤160 ideal). Variables: ${smsVarChips}. Include <code>{{website_link}}</code>. <code>{{site_screenshot}}</code> sends as MMS (media URL) when available, else plain SMS with the preview link.</div>
            <div class="hint" id="tp-sms-count">0 characters</div>
            <div class="hint" style="margin-top:8px">To send this SMS to a lead, save the template, then use Compose SMS (Campaigns tab) or the Queue SMS action on the lead itself.</div>
          </div>
          <div class="inline"><button class="btn primary" type="submit">Save template</button><button class="btn" type="button" data-act="reset">Reset</button><span class="msg" id="tp-msg"></span></div>
        </form>
      </div>
      <div class="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>SMS</th><th></th></tr></thead>
        <tbody>${
          templates
            .map((t) => {
              const hasEmail = !!String(t.body || '')
                .replace(/<[^>]+>/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();
              const hasSms = !!(
                String(t.sms_body || '').trim() ||
                ((t.channel || '') === 'sms' && String(t.body || '').trim())
              );
              const smsPrev = truncateWords(t.sms_body || ((t.channel || '') === 'sms' ? t.body : '') || '', 60);
              return `<tr><td>${esc(t.name)}<div class="hint">${esc(t.subject || '')}</div></td>
            <td>${hasEmail ? statusBadge('email') : '<span class="hint">—</span>'}</td>
            <td>${hasSms ? `${statusBadge('sms')}<div class="hint sms-prev">${esc(smsPrev)}</div>` : '<span class="hint">—</span>'}</td>
          <td class="actions"><button class="btn small" data-act="edit" data-id="${t.id}">Edit</button> <button class="btn small danger" data-act="delete" data-id="${t.id}">Delete</button></td></tr>`;
            })
            .join('') || '<tr><td colspan="4" class="empty">No templates yet.</td></tr>'
        }</tbody></table></div>
    </div>`;
  const form = $('#tp-form', host);
  const editor = mountEmailBodyEditor($('#tp-body-host', host), {
    initialHtml: '<p>Hi {{business_name}},</p><p>…</p>',
  });
  function updateSmsCount() {
    const el = $('#tp-sms-body', host);
    const c = $('#tp-sms-count', host);
    if (el && c) c.textContent = `${el.value.length} characters`;
  }
  $('#tp-sms-body', host).addEventListener('input', updateSmsCount);
  updateSmsCount();

  guardSubmit(form, async (e) => {
    const body = formObject(form);
    body.body = editor.getHtml();
    body.sms_body = ($('#tp-sms-body', host).value || '').trim();
    const hasEmail = !!String(body.body || '')
      .replace(/<[^>]+>/g, '')
      .trim();
    const hasSms = !!body.sms_body;
    if (!hasEmail && !hasSms) {
      setMsg($('#tp-msg', host), 'Provide an email body and/or SMS body.', 'err');
      return;
    }
    if (hasEmail && !String(body.subject || '').trim()) {
      setMsg($('#tp-msg', host), 'Email subject is required when saving an email body.', 'err');
      return;
    }
    delete body.channel;
    if (!body.id) delete body.id;
    else body.id = Number(body.id);
    try {
      await api.saveTemplate(body);
      toast('Template saved', 'ok');
      tabTemplates(host);
    } catch (err) {
      setMsg($('#tp-msg', host), errText(err), 'err');
    }
  });

  host.querySelectorAll('.var-chip').forEach((chip) => {
    chip.style.cursor = 'pointer';
    chip.title = 'Click to insert';
    chip.onclick = () => {
      const v = chip.dataset.var;
      if (chip.dataset.target === 'sms') {
        const ta = $('#tp-sms-body', host);
        const start = ta.selectionStart || ta.value.length;
        ta.value = ta.value.slice(0, start) + v + ta.value.slice(ta.selectionEnd || start);
        updateSmsCount();
        ta.focus();
        return;
      }
      editor.el.querySelector('.email-rte-surface').focus();
      try {
        document.execCommand('insertText', false, v);
      } catch {
        editor.setHtml(editor.getHtml() + ' ' + v);
      }
    };
  });

  delegate(host, {
    reset: () => tabTemplates(host),
    'ai-write': () => {
      openAiWriteModal({
        existingSubject: form.subject.value,
        existingBody: editor.getHtml(),
        onApplied: (r, leadId) => {
          if (r.subject) form.subject.value = r.subject;
          if (r.body) editor.setHtml(r.body);
          if (r.sms_body) {
            $('#tp-sms-body', host).value = r.sms_body;
            updateSmsCount();
          }
          setMsg($('#tp-msg', host), 'Draft ready — review email + SMS and save.', 'ok');
          toast(r.sms_body ? 'AI draft + SMS ready' : 'AI draft applied', 'ok');
        },
      });
    },
    edit: (t) => {
      const tpl = templates.find((x) => String(x.id) === t.dataset.id);
      if (!tpl) return;
      form.id.value = tpl.id;
      form.name.value = tpl.name;
      form.subject.value = tpl.subject === '(SMS)' ? '' : tpl.subject || '';
      const legacySms = (tpl.channel || '') === 'sms' && !String(tpl.sms_body || '').trim();
      editor.setHtml(legacySms ? '<p></p>' : tpl.body || '<p></p>');
      $('#tp-sms-body', host).value = legacySms ? tpl.body || '' : tpl.sms_body || '';
      updateSmsCount();
      $('#tp-title', host).textContent = 'Edit template #' + tpl.id;
      form.scrollIntoView({ behavior: 'smooth', block: 'center' });
    },
    delete: async (t) => {
      if (!window.confirm('Delete this template?')) return;
      await api.deleteTemplate(Number(t.dataset.id));
      toast('Template deleted', 'ok');
      tabTemplates(host);
    },
  });
}

async function tabSuppression(host) {
  const r = (await api.suppression({ pageSize: 100 })).data;
  const rows = r.rows || [];
  host.innerHTML = `
    <div class="card"><h3>Add to suppression list</h3>
      <form class="inline" id="sp-form">
        <input name="email" type="email" placeholder="name@example.com" required style="min-width:240px" />
        <select name="reason">${optionList(SUPPRESSION_REASONS, 'do-not-contact')}</select>
        <button class="btn primary" type="submit">Suppress</button><span class="msg" id="sp-msg"></span>
      </form>
      <p class="hint">Suppressed addresses are never emailed; queued messages to them are cancelled.</p>
    </div>
    <div class="table-wrap"><table><thead><tr><th>Email</th><th>Reason</th><th>Added</th><th></th></tr></thead>
      <tbody>${
        rows
          .map(
            (s) => `<tr><td>${esc(s.email)}${(s.near_match_emails || []).length ? `<div class="hint">Similar address in use: ${esc(s.near_match_emails.join(', '))} — not suppressed</div>` : ''}</td><td>${esc(s.reason)}</td><td>${esc(fmtDate(s.created_at))}</td>
        <td><button class="btn small" data-act="remove" data-id="${s.id}">Remove</button></td></tr>`
          )
          .join('') || '<tr><td colspan="4" class="empty">Suppression list is empty.</td></tr>'
      }</tbody></table></div>`;
  guardSubmit($('#sp-form', host), async (e) => {
    e.preventDefault();
    const f = formObject(e.target);
    try {
      await api.suppressionAdd(f.email, f.reason);
      toast('Added', 'ok');
      tabSuppression(host);
    } catch (err) {
      setMsg($('#sp-msg', host), errText(err), 'err');
    }
  });
  delegate(host, {
    remove: async (t) => {
      await api.suppressionRemove(Number(t.dataset.id));
      tabSuppression(host);
    },
  });
}

/* ------------------------------------------------------------------ */
/* Pipeline                                                            */
/* ------------------------------------------------------------------ */

async function pagePipeline() {
  view.classList.add('wide');
  let res;
  try {
    res = await withLoadTimeout(api.pipeline());
  } catch (e) {
    view.innerHTML = loadErrorCardHtml(errText(e));
    wirePageRetry(() => pagePipeline());
    return;
  }
  const columns = asList(res.data && res.data.columns);
  view.innerHTML = `
    <div class="page-head"><div><h1>Pipeline</h1><p class="lede">Move leads between stages and record intent events (opens, clicks, claims).</p>
      <p class="hint">Card numbers: the pill is the lead score (0–100; Qualified at 50+, Hot at 70+). The badge is intent — engagement points from opens, clicks and claim actions (Cold under 11 · Warm 11–30 · Interested 31–60 · Hot 61+).</p></div>
      <div class="page-actions"><button class="btn" data-act="refresh">Refresh</button></div></div>
    <div class="kanban">${
      columns
        .map(
          (col) => `
      <div class="kanban-col" data-col="${esc(col.key)}">
        <div class="kanban-head"><span>${esc(col.title)}</span><span class="count">${esc(col.total)}</span></div>
        ${
          asList(col.leads)
            .map(
              (l) => `
          <div class="kanban-card">
            <div class="title"><button class="link-btn" data-act="open" data-id="${l.id}">${esc(l.business_name)}</button></div>
            <div class="hint">${esc(l.category || '')}${l.email ? ' · ' + esc(l.email) : ''}</div>
            <div class="meta">${scorePill(l.score)}<span class="badge intent-${esc(String(l.intent_label || 'Cold').toLowerCase())}" title="Intent: engagement points from email opens, clicks and claim actions — Cold under 11, Warm 11–30, Interested 31–60, Hot 61+">${esc(l.intent_label || 'Cold')} ${esc(l.intent_score || 0)}</span></div>
            <div class="meta"><select data-status="${l.id}" aria-label="Status">${optionList(LEAD_STATUSES, l.status)}</select>
              <button class="btn small" data-act="intent" data-id="${l.id}">Intent</button></div>
          </div>`
            )
            .join('') || '<div class="hint" style="padding:8px">Empty</div>'
        }
        ${col.hasMore ? `<div class="hint">Showing ${esc(col.shown)} of ${esc(col.total)}.</div>` : ''}
      </div>`
        )
        .join('') || '<p class="hint">No pipeline columns.</p>'
    }</div>`;

  view.onchange = (e) => {
    const sel = e.target.closest('[data-status]');
    if (!sel) return;
    const card = sel.closest('.kanban-card');
    const name = (card && card.querySelector('.title .link-btn')?.textContent) || 'lead #' + sel.dataset.status;
    if (!window.confirm(`Change status of ${name} to "${sel.value}"?`)) {
      pagePipeline(); // re-render so the select snaps back to the saved value
      return;
    }
    safeRun(null, async () => {
      await api.patchLead(Number(sel.dataset.status), { status: sel.value });
      toast('Status updated', 'ok');
      pagePipeline();
    });
  };
  delegate(view, {
    refresh: () => pagePipeline(),
    open: (t) => {
      window.location.hash = '#/leads/' + t.dataset.id;
    },
    intent: (t) => openIntentModal(Number(t.dataset.id), () => pagePipeline()),
  });
}

/* ------------------------------------------------------------------ */
/* Social (Facebook + Instagram)                                       */
/* ------------------------------------------------------------------ */

async function pageSocial(_param, query = {}) {
  const leadIdQ = query.leadId ? Number(query.leadId) : null;
  let ov;
  try {
    ov = (await withLoadTimeout(api.socialOverview())).data;
  } catch (e) {
    view.innerHTML = loadErrorCardHtml(errText(e));
    wirePageRetry(() => pageSocial(_param, query));
    return;
  }
  let leads = [];
  try {
    const lr = await api.leads({ pageSize: 200 });
    leads = dedupeById(asList(lr.data, ['leads', 'rows']));
  } catch {
    /* ignore */
  }

  let detail = null;
  let selectedLeadId = leadIdQ;
  if (query.campaignId) {
    detail = (await api.socialCampaignGet(Number(query.campaignId))).data;
    selectedLeadId = detail.campaign && detail.campaign.lead_id;
  } else if (selectedLeadId) {
    const camps = (await api.socialCampaigns({ leadId: selectedLeadId })).data.campaigns || [];
    if (camps[0]) detail = (await api.socialCampaignGet(camps[0].id)).data;
  }

  if (query.connected === '1') {
    toast(`Meta connected: ${query.fb || 0} Facebook, ${query.ig || 0} Instagram`, 'ok');
  }

  const accounts =
    detail && detail.accounts
      ? detail.accounts
      : selectedLeadId
        ? (await api.socialAccounts(selectedLeadId)).data.accounts || []
        : [];

  view.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Social</h1>
        <p class="lede">Facebook + Instagram for website clients. Generate a month of captions (photos optional), send a week for approval, then schedule posts.</p>
      </div>
    </div>
    <div class="stats-cards">
      <div class="stat-card"><div class="stat-label">Meta app</div><div class="stat-value">${ov.metaConfigured ? 'Ready' : 'Setup'}</div></div>
      <div class="stat-card"><div class="stat-label">Accounts</div><div class="stat-value">${esc(ov.counts.accounts)}</div></div>
      <div class="stat-card"><div class="stat-label">Pending approval</div><div class="stat-value">${esc(ov.counts.pendingApproval)}</div></div>
      <div class="stat-card"><div class="stat-label">Scheduled</div><div class="stat-value">${esc(ov.counts.scheduled)}</div></div>
      <div class="stat-card"><div class="stat-label">Failed</div><div class="stat-value">${esc(ov.counts.failed)}</div></div>
    </div>
    ${!ov.metaConfigured ? '<div class="alert warn">Add <strong>Meta App ID</strong> and secret under <a href="#/settings/social">Settings → Social</a>, then connect a Page.</div>' : ''}

    <div class="card">
      <h3>Client / lead</h3>
      <div class="row">
        <div class="field"><label>Lead</label>
          <input type="search" id="soc-lead-search" placeholder="Type to filter…" autocomplete="off" style="margin-bottom:6px" />
          <select id="soc-lead">
            <option value="">Select a lead…</option>
            ${leads.map((l) => `<option value="${esc(l.id)}" ${Number(l.id) === selectedLeadId ? 'selected' : ''}>${esc(l.business_name || '#' + l.id)}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="inline" style="margin-top:8px">
        <button class="btn primary" type="button" data-act="connect" ${selectedLeadId ? '' : 'disabled'}>Connect Facebook / Instagram</button>
        <button class="btn" type="button" data-act="refresh">Refresh</button>
      </div>
      <div style="margin-top:12px">
        ${
          (accounts || [])
            .map(
              (a) => `
          <div class="kv"><span class="k">${esc(a.platform)}</span>
            <span>${esc(a.account_name || a.account_id)} ${statusBadge(a.status)}
              <button class="btn small danger" type="button" data-act="disconnect" data-id="${esc(a.id)}">Disconnect</button>
            </span></div>`
            )
            .join('') ||
          (selectedLeadId
            ? '<p class="hint">No accounts connected yet.</p>'
            : '<p class="hint">Pick a lead to connect accounts.</p>')
        }
      </div>
    </div>

    <div class="card">
      <h3>Generate month</h3>
      <p class="hint">Creates ~30 draft posts from the lead brief. Images stay off unless you opt in (Instagram needs a photo to publish).</p>
      <form id="soc-gen">
        <div class="row">
          <div class="field"><label>Month start</label><input name="monthStart" type="date" value="${esc(new Date().toISOString().slice(0, 10))}" required /></div>
          <div class="field"><label>Days</label><input name="days" type="number" min="7" max="60" value="30" /></div>
          <div class="field"><label>Client email (approval)</label><input name="clientEmail" type="email" placeholder="client@example.com" value="${esc((detail && detail.campaign && detail.campaign.client_email) || '')}" /></div>
        </div>
        <div class="row">
          <div class="field"><label>Require client approval</label>
            <select name="requireClientApproval"><option value="1" selected>Yes — weekly email</option><option value="0">No — schedule immediately</option></select>
          </div>
          <div class="field"><label>Include images</label>
            <select name="withImages"><option value="0" selected>No (text OK; IG skipped without photo)</option><option value="1">Yes (Pexels when configured)</option></select>
          </div>
        </div>
        <div class="field"><label>Brief (optional)</label><textarea name="brief" placeholder="Promo Tuesdays, keep tone friendly, no politics…"></textarea></div>
        <div class="inline"><button class="btn primary" type="submit" ${selectedLeadId ? '' : 'disabled'}>Generate month</button><span class="msg" id="soc-gen-msg"></span></div>
      </form>
    </div>

    <div class="card">
      <div class="panel-h"><h3>Campaigns</h3>
        <div class="inline">
          <button class="btn small" type="button" data-act="weekly-tick">Run weekly send now</button>
          <button class="btn small" type="button" data-act="publish-due">Publish due now</button>
        </div>
      </div>
      <div class="table-scroll"><table class="data">
        <thead><tr><th>Campaign</th><th>Lead</th><th>Status</th><th>Images</th><th></th></tr></thead>
        <tbody>
          ${
            (ov.campaigns || [])
              .map(
                (c) => `<tr>
            <td>${esc(c.title || '#' + c.id)}<div class="sub-line">${esc(c.month_start)}</div></td>
            <td>${esc(c.business_name || c.lead_id)}</td>
            <td>${statusBadge(c.status)}</td>
            <td>${c.with_images ? 'Yes' : 'Optional/off'}</td>
            <td><button class="btn small" type="button" data-act="open-camp" data-id="${esc(c.id)}">Open</button></td>
          </tr>`
              )
              .join('') || '<tr><td colspan="5">No campaigns yet</td></tr>'
          }
        </tbody>
      </table></div>
    </div>

    ${detail ? renderSocialCampaignDetail(detail) : ''}`;

  $('#soc-lead').onchange = () => {
    const id = Number($('#soc-lead').value);
    window.location.hash = id ? `#/social?leadId=${id}` : '#/social';
  };
  wireSelectSearch($('#soc-lead-search'), $('#soc-lead'));

  const gen = $('#soc-gen');
  if (gen) {
    gen.onsubmit = async (e) => {
      e.preventDefault();
      if (!selectedLeadId) return;
      const msg = $('#soc-gen-msg');
      setMsg(msg, 'Generating…');
      try {
        const fd = formObject(gen);
        const r = await api.socialGenerateMonth({
          leadId: selectedLeadId,
          monthStart: fd.monthStart,
          days: Number(fd.days) || 30,
          withImages: fd.withImages === '1' || fd.withImages === 1,
          brief: fd.brief || '',
          clientEmail: fd.clientEmail || '',
          requireClientApproval: fd.requireClientApproval !== '0',
        });
        setMsg(msg, `Created campaign #${r.data.campaign.id} with ${r.data.posts.length} posts.`, 'ok');
        window.location.hash = `#/social?campaignId=${r.data.campaign.id}`;
      } catch (err) {
        setMsg(msg, errText(err), 'err');
      }
    };
  }

  delegate(view, {
    refresh: () => pageSocial(_param, query),
    connect: async () => {
      if (!selectedLeadId) return;
      const r = await api.socialOauthStart(selectedLeadId, `#/social?leadId=${selectedLeadId}`);
      window.location.href = r.data.url;
    },
    disconnect: async (t) => {
      if (!confirm('Disconnect this account?')) return;
      await api.socialDisconnect(Number(t.dataset.id));
      toast('Disconnected', 'ok');
      pageSocial(_param, query);
    },
    'open-camp': (t) => {
      window.location.hash = `#/social?campaignId=${t.dataset.id}`;
    },
    'weekly-tick': async () => {
      const r = await api.socialWeeklyTick();
      toast(`Weekly tick: ${r.data.campaigns || 0} campaign(s)`, 'ok');
      pageSocial(_param, query);
    },
    'publish-due': async () => {
      const r = await api.socialPublishDue({});
      toast(`Publish due: ${r.data.published || 0}`, 'ok');
      pageSocial(_param, query);
    },
    'send-week': async (t) => {
      const r = await api.socialSendWeek(Number(t.dataset.id), true);
      if (r.data.approveUrl) toast('Week packed — check email / copy link from response', 'ok');
      else toast(r.data.reason || 'Done', 'ok');
      if (r.data.approveUrl) {
        openModal({
          title: 'Weekly batch',
          body: `<p>${r.data.sent ? 'Email sent to ' + esc(r.data.to) : 'Email not sent (SMTP?). Share this link:'}</p>
            <p class="mono" style="word-break:break-all">${esc(r.data.approveUrl || '')}</p>
            ${r.data.sendError ? `<p class="error">${esc(r.data.sendError)}</p>` : ''}`,
          buttons: [{ label: 'Close' }],
        });
      }
      pageSocial(_param, { campaignId: String(t.dataset.id) });
    },
    'camp-status': async (t) => {
      await api.socialCampaignStatus(Number(t.dataset.id), t.dataset.status);
      toast('Campaign updated', 'ok');
      pageSocial(_param, { campaignId: String(t.dataset.id) });
    },
    'approve-posts': async (t) => {
      const ids = [...view.querySelectorAll('.soc-post-pick:checked')].map((el) => Number(el.value));
      if (!ids.length) {
        toast('Select posts', 'err');
        return;
      }
      await api.socialApprovePosts(ids);
      toast('Scheduled ' + ids.length + ' posts', 'ok');
      pageSocial(_param, { campaignId: t.dataset.camp });
    },
    'publish-one': async (t) => {
      const r = await api.socialPublishPost(Number(t.dataset.id));
      toast(`Publish: ${r.data.status}`, r.data.status === 'posted' ? 'ok' : 'err');
      pageSocial(_param, { campaignId: t.dataset.camp });
    },
    'save-post': async (t) => {
      const id = Number(t.dataset.id);
      const card = t.closest('.soc-post');
      const caption = $('.soc-cap', card).value;
      const scheduled_at = $('.soc-when', card).value ? new Date($('.soc-when', card).value).toISOString() : null;
      await api.socialUpdatePost(id, { caption, scheduled_at });
      toast('Post saved', 'ok');
    },
  });
}

function renderSocialCampaignDetail(detail) {
  const c = detail.campaign;
  const posts = detail.posts || [];
  const accounts = detail.accounts || [];
  const hasAccount = accounts.some((a) => a.status === 'active');
  const draftCount = posts.filter((p) => p.status === 'draft').length;
  const now = Date.now();
  return `
    <div class="card">
      <div class="panel-h">
        <h3>${esc(c.title || 'Campaign #' + c.id)}</h3>
        <div class="inline">
          <button class="btn small primary" type="button" data-act="send-week" data-id="${esc(c.id)}">Send this week</button>
          <button class="btn small" type="button" data-act="approve-posts" data-camp="${esc(c.id)}">Approve selected → schedule</button>
          ${
            c.status === 'active'
              ? `<button class="btn small" type="button" data-act="camp-status" data-id="${esc(c.id)}" data-status="paused">Pause</button>`
              : `<button class="btn small" type="button" data-act="camp-status" data-id="${esc(c.id)}" data-status="active">Activate</button>`
          }
        </div>
      </div>
      <p class="hint">${statusBadge(c.status)} · approval ${c.require_client_approval ? 'on' : 'off'} · images ${c.with_images ? 'on' : 'optional/off'} · ${esc(c.client_email || 'no client email')} · ${posts.length} post(s) total · ${draftCount} draft(s)</p>
      <div class="soc-posts">
        ${
          posts
            .map((p) => {
              const publishable = ['scheduled', 'approved', 'failed'].includes(p.status);
              const overdue =
                p.status === 'draft' && p.scheduled_at && new Date(p.scheduled_at).getTime() < now;
              const pubReason = !publishable
                ? p.status === 'draft'
                  ? 'Approve and schedule this post before publishing'
                  : p.status === 'posted'
                    ? 'Already published'
                    : `Post is ${p.status} — not publishable`
                : !hasAccount
                  ? 'Connect a Meta account to publish'
                  : '';
              return `
          <div class="card soc-post" style="margin:10px 0">
            <label class="inline"><input type="checkbox" class="soc-post-pick" value="${esc(p.id)}" /> <strong>#${esc(p.day_index)}</strong> ${statusBadge(p.status)}${overdue ? ' <span class="badge warn">Overdue</span>' : ''}</label>
            <div class="meta hint">${esc((p.platforms || []).join(', '))} · ${p.with_image ? 'photo' : 'text only'}${p.publish_error ? ` · <span class="error">${esc(p.publish_error)}</span>` : ''}</div>
            <div class="field"><label>When (local)</label>
              <input class="soc-when" type="datetime-local" value="${esc(toLocalInput(p.scheduled_at))}" /></div>
            <div class="field"><label>Caption</label><textarea class="soc-cap" rows="3">${esc(p.caption || '')}</textarea></div>
            ${p.image_url ? `<img src="${esc(p.image_url)}" alt="" style="max-width:180px;border-radius:8px" />` : ''}
            <div class="inline">
              <button class="btn small" type="button" data-act="save-post" data-id="${esc(p.id)}">Save</button>
              <button class="btn small" type="button" data-act="publish-one" data-id="${esc(p.id)}" data-camp="${esc(c.id)}" ${pubReason ? `disabled title="${esc(pubReason)}"` : ''}>Publish now</button>
              ${pubReason ? `<span class="hint">${esc(pubReason)}</span>` : ''}
            </div>
          </div>`;
            })
            .join('') || '<p class="hint">No posts</p>'
        }
      </div>
    </div>`;
}

function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* ------------------------------------------------------------------ */
/* Jobs (web-only scheduled jobs)                                      */
/* ------------------------------------------------------------------ */

async function pageJobs() {
  let res;
  try {
    res = await withLoadTimeout(api.jobsList());
  } catch (e) {
    view.innerHTML = loadErrorCardHtml(errText(e));
    wirePageRetry(() => pageJobs());
    return;
  }
  const d = res.data || {};
  const jobs = asList(d, ['jobs', 'rows']);
  const types =
    Array.isArray(d.types) && d.types.length
      ? d.types
      : [
          'discovery',
          'outreach_process',
          'imap_poll',
          'design_poll_notify',
          'social_weekly',
          'social_publish',
          'hands_off',
          'hands_off_digest',
          'custom',
        ];
  view.innerHTML = `
    <div class="page-head"><div><h1>Jobs</h1><p class="lede">Schedule discovery, outreach, IMAP, social weekly send / publish, and custom work — also available via MCP <code>jobs.*</code>. Jobs honor the automation kill switch.</p></div></div>
    <div class="card"><h3>Create job</h3>
      <form id="job-form">
        <div class="row">
          <div class="field"><label>Name</label><input name="name" required placeholder="Nightly discovery" /></div>
          <div class="field"><label>Type</label><select name="type">${types.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join('')}</select></div>
          <div class="field"><label>Interval (minutes)</label><input name="interval_minutes" type="number" min="1" value="360" /></div>
        </div>
        <div class="field"><label>Payload JSON (optional)</label><textarea name="payload" class="mono" placeholder='{"category":"Plumber","location":"Springfield","limit":8}'></textarea></div>
        <div class="inline"><button class="btn primary" type="submit">Create</button><span class="msg" id="job-msg"></span></div>
      </form>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>Name</th><th>Type</th><th>Next run</th><th>Last run</th><th></th></tr></thead>
      <tbody>${
        jobs
          .map(
            (j) => `<tr>
        <td>${esc(j.name)}<div class="hint">${j.enabled ? 'enabled' : 'disabled'} · every ${esc(j.interval_minutes || '—')} min</div></td>
        <td>${esc(j.type)}</td><td>${esc(j.next_run_at || '—')}</td>
        <td>${esc(j.last_status || '—')}<div class="hint">${esc(j.last_run_at || '')}</div></td>
        <td class="actions">
          <button class="btn small" data-act="run" data-id="${j.id}">Run now</button>
          <button class="btn small" data-act="toggle" data-id="${j.id}" data-en="${j.enabled ? 0 : 1}">${j.enabled ? 'Disable' : 'Enable'}</button>
          <button class="btn small danger" data-act="delete" data-id="${j.id}">Delete</button>
        </td></tr>`
          )
          .join('') || '<tr><td colspan="5" class="empty">No jobs yet.</td></tr>'
      }</tbody>
    </table></div>`;

  guardSubmit($('#job-form'), async (e) => {
    const body = formObject(e.target);
    body.interval_minutes = Number(body.interval_minutes) || null;
    // Invalid payload JSON must surface, not silently save as {} (audit A4).
    try {
      body.payload = JSON.parse(body.payload || '{}');
    } catch {
      setMsg($('#job-msg'), 'Payload is not valid JSON — fix it or clear the field.', 'err');
      return;
    }
    try {
      await api.jobsCreate(body);
      toast('Job created', 'ok');
      pageJobs();
    } catch (err) {
      setMsg($('#job-msg'), errText(err), 'err');
    }
  });
  delegate(view, {
    run: async (t) => {
      await api.jobsRun(t.dataset.id);
      toast('Job executed', 'ok');
      pageJobs();
    },
    toggle: async (t) => {
      await api.jobsUpdate(t.dataset.id, { enabled: Number(t.dataset.en) === 1 });
      pageJobs();
    },
    delete: async (t) => {
      if (window.confirm('Delete job?')) {
        await api.jobsDelete(t.dataset.id);
        pageJobs();
      }
    },
  });
}

/* ------------------------------------------------------------------ */
/* MCP                                                                 */
/* ------------------------------------------------------------------ */

function mcpCursorSnippet(endpoint, tokenPlaceholder) {
  return JSON.stringify(
    {
      mcpServers: {
        'website-scout': {
          url: endpoint,
          headers: { Authorization: 'Bearer ' + tokenPlaceholder },
        },
      },
    },
    null,
    2
  );
}

function mcpGroupTools(data) {
  const groups = data.groups && typeof data.groups === 'object' ? data.groups : null;
  if (groups && Object.keys(groups).length) {
    return Object.keys(groups)
      .sort()
      .map((key) => ({
        key,
        names: groups[key] || [],
      }));
  }
  const names = data.tools || (data.catalog || []).map((t) => t.name);
  const map = {};
  for (const name of names) {
    const key = String(name).includes('.') ? String(name).split('.')[0] : 'other';
    if (!map[key]) map[key] = [];
    map[key].push(name);
  }
  return Object.keys(map)
    .sort()
    .map((key) => ({ key, names: map[key] }));
}

async function pageMcp() {
  const res = await api.mcpStatus();
  const d = res.data || {};
  const origin = window.location.origin;
  const endpoint = origin + '/mcp';
  const tokens = asList(d, ['tokens', 'rows']);
  const toolCount = d.toolCount != null ? d.toolCount : asList(d, ['tools']).length;
  const serverLabel = d.server
    ? `${d.server.name || 'website-scout-web-mcp'} ${d.server.version || ''}`.trim()
    : 'website-scout-web-mcp';
  const snippet = mcpCursorSnippet(endpoint, '<YOUR_WORKSPACE_TOKEN>');
  const grouped = mcpGroupTools(d);
  const catalogByName = {};
  (d.catalog || []).forEach((t) => {
    catalogByName[t.name] = t.description || '';
  });

  view.innerHTML = `
    <div class="page-head">
      <div>
        <h1>MCP</h1>
        <p class="lede">Streamable HTTP MCP for this workspace. Point Cursor (or any MCP client) at the URL below with a Bearer token — no local port, Tailscale, or desktop bind.</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" data-act="copy-endpoint">Copy endpoint</button>
        <button class="btn primary" type="button" data-act="copy-config">Copy Cursor config</button>
      </div>
    </div>

    <div class="grid cols-2" style="align-items:start">
      <div class="card">
        <h3>Endpoint</h3>
        <p class="mono" id="mcp-endpoint">${esc(endpoint)}</p>
        <p class="hint" style="margin-top:8px">
          Auth: <code>Authorization: Bearer &lt;token&gt;</code>
          · ${esc(serverLabel)}
          ${d.protocolVersion ? ` · protocol ${esc(d.protocolVersion)}` : ''}
          · ${esc(String(toolCount))} tools
        </p>
        <h3 style="margin-top:16px">Cursor <code>mcp.json</code></h3>
        <p class="hint">Paste into <code>~/.cursor/mcp.json</code> or project <code>.cursor/mcp.json</code>, then replace <code>&lt;YOUR_WORKSPACE_TOKEN&gt;</code> with a token you mint below.</p>
        <pre class="out" id="mcp-snippet">${esc(snippet)}</pre>
        <div class="inline" style="margin-top:8px">
          <button class="btn small" type="button" data-act="copy-config">Copy config</button>
          <button class="btn small" type="button" data-act="copy-endpoint">Copy URL</button>
        </div>
      </div>

      <div class="card">
        <h3>Create token</h3>
        <p class="hint">Tokens are scoped to the current workspace. The full secret is shown once.</p>
        <div class="row end">
          <div class="field"><label class="lbl" for="mcp-name">Name</label>
            <input id="mcp-name" type="text" maxlength="80" placeholder="e.g. Cursor laptop" autocomplete="off" />
          </div>
          <div class="field" style="flex:0 0 auto">
            <button class="btn primary" type="button" data-act="mint">Create MCP token</button>
          </div>
        </div>
        <div class="msg" id="mcp-msg"></div>
        <div id="mcp-token-panel" class="hidden" style="margin-top:10px">
          <p class="hint">Raw token (copy now — it will not be shown again):</p>
          <pre class="out" id="mcp-token-out"></pre>
          <div class="inline" style="margin-top:8px">
            <button class="btn small primary" type="button" data-act="copy-token">Copy token</button>
            <button class="btn small" type="button" data-act="copy-filled">Copy config with token</button>
          </div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="panel-h">
        <h3>Workspace tokens (${tokens.length})</h3>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>Prefix</th><th>Last used</th><th>Created</th><th></th></tr></thead>
        <tbody>${
          tokens
            .map(
              (t) => `<tr>
          <td>${esc(t.name)}</td>
          <td class="mono">${esc(t.token_prefix)}…</td>
          <td>${esc(fmtDate(t.last_used_at) || '—')}</td>
          <td>${esc(fmtDate(t.created_at) || '—')}</td>
          <td class="actions"><button class="btn small danger" type="button" data-act="revoke" data-id="${esc(t.id)}">Revoke</button></td>
        </tr>`
            )
            .join('') || '<tr><td colspan="5" class="empty">No tokens yet. Create one to connect Cursor.</td></tr>'
        }
        </tbody>
      </table></div>
    </div>

    <div class="card">
      <div class="panel-h">
        <h3>Tool catalog (${toolCount})</h3>
        <span class="hint">Same names <code>tools/list</code> returns over MCP</span>
      </div>
      <div class="mcp-tool-groups">
        ${
          grouped
            .map(
              (g) => `
          <details class="mcp-tool-group"${g.names.length <= 12 ? ' open' : ''}>
            <summary><strong>${esc(g.key)}</strong> <span class="hint">${g.names.length}</span></summary>
            <ul class="mcp-tool-list">
              ${g.names
                .map((name) => {
                  const desc = catalogByName[name];
                  return `<li><code>${esc(name)}</code>${desc ? ` <span class="hint">— ${esc(desc)}</span>` : ''}</li>`;
                })
                .join('')}
            </ul>
          </details>`
            )
            .join('') || '<p class="hint">No tools reported.</p>'
        }
      </div>
    </div>`;

  let lastToken = '';
  delegate(view, {
    'copy-endpoint': () => copyText(endpoint),
    'copy-config': () => copyText(snippet),
    'copy-token': () => {
      if (!lastToken) {
        toast('Mint a token first', 'err');
        return;
      }
      return copyText(lastToken);
    },
    'copy-filled': () => {
      if (!lastToken) {
        toast('Mint a token first', 'err');
        return;
      }
      return copyText(mcpCursorSnippet(endpoint, lastToken));
    },
    mint: async () => {
      const out = (await api.mcpToken($('#mcp-name').value.trim() || 'MCP')).data;
      lastToken = out.token;
      const pre = $('#mcp-token-out');
      pre.textContent = out.token;
      $('#mcp-token-panel').classList.remove('hidden');
      setMsg($('#mcp-msg'), out.hint || 'Copy now — shown only once.', 'ok');
      toast('Token created — copy it now', 'ok');
    },
    revoke: async (t) => {
      if (!window.confirm('Revoke this token? Agents using it will lose access.')) return;
      await api.mcpRevoke(Number(t.dataset.id));
      toast('Token revoked', 'ok');
      pageMcp();
    },
  });
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

let settingsTab = 'team';

const SETTINGS_TABS = [
  ['team', 'Team', 'sec-team'],
  ['ai', 'AI', 'sec-ai'],
  ['cost', 'Cost', 'sec-cost'],
  ['prompts', 'Prompts', 'sec-prompts'],
  ['automation', 'Automation', 'sec-automation'],
  ['handsoff', 'Hands-off', 'sec-hands-off'],
  ['agent', 'Design agent', 'sec-agent'],
  ['learning', 'Design learning', 'sec-learning'],
  ['discovery', 'Discovery', 'sec-discovery'],
  ['email', 'Email', 'sec-smtp'],
  ['sms', 'SMS', 'sec-sms'],
  ['social', 'Social', 'sec-meta'],
  ['cloudflare', 'Cloudflare', 'sec-cf'],
  ['domains', 'Domains', 'sec-domains'],
  ['shop', 'Shop payments', 'sec-shop'],
  ['keys', 'Provider keys', 'sec-keys'],
  ['footer', 'Footer & scoring', 'sec-mail'],
];

async function pageSettings(param) {
  const safe = (p) =>
    p.then(
      (r) => r.data,
      () => null
    );
  const [setR, promptsR, schedR, provR, usageR, aiR, cfR, hoR] = await Promise.all([
    api.settingsGet(),
    safe(api.prompts()),
    safe(api.discoveryGet()),
    safe(api.providers()),
    safe(api.aiUsage(30)),
    safe(api.aiStatus()),
    safe(api.cfGet()),
    safe(api.handsOffStatus()),
  ]);
  const s = (setR.data && setR.data.settings) || {};
  const prompts = asList(promptsR, ['prompts', 'rows']);
  const sched = schedR || {};
  const ho = hoR || {};
  const providers = asList(provR, ['providers']).filter((p) => p.name !== 'csv' && p.name !== 'manual');
  const paused = s.automation_paused === '1';
  automationPaused = paused;

  const requested = (param && String(param).split('/')[0]) || settingsTab || 'team';
  settingsTab = SETTINGS_TABS.some(([k]) => k === requested) ? requested : 'team';
  const activeSec = (SETTINGS_TABS.find(([k]) => k === settingsTab) || SETTINGS_TABS[0])[2];
  const showSec = (id) => (id === activeSec ? '' : ' hidden');

  // Field factory shared by every Settings tab: f() renders a labelled
  // control bound by data-key; secret() below renders a write-only
  // password input bound by data-secret (the server only ever returns
  // '***' for a stored secret, shown as the set/not-set badge). The
  // saveSection collector submits every [data-key] value, but a
  // [data-secret] only when its field is non-empty — so saving a tab
  // never wipes a stored key the user didn't retype.
  const f = (key, label, o) => {
    const opt = o || {};
    const val = s[key] == null ? (opt.def == null ? '' : opt.def) : s[key];
    let input;
    if (opt.options)
      input = `<select data-key="${esc(key)}">${opt.options.map(([v, l]) => `<option value="${esc(v)}" ${String(val) === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
    else if (opt.area) input = `<textarea data-key="${esc(key)}" rows="3">${esc(val)}</textarea>`;
    else
      input = `<input data-key="${esc(key)}" type="${opt.type || 'text'}" value="${esc(val)}" ${opt.step ? `step="${opt.step}"` : ''} ${opt.min != null ? `min="${opt.min}"` : ''} ${opt.placeholder ? `placeholder="${esc(opt.placeholder)}"` : ''} autocomplete="off" />`;
    return `<div class="field"><label>${esc(label)}</label>${input}${opt.hint ? `<div class="hint">${opt.hint}</div>` : ''}</div>`;
  };
  const secret = (
    key,
    label,
    hint
  ) => `<div class="field"><label>${esc(label)} <span class="badge ${s[key] === '***' ? 'ok' : ''}">${s[key] === '***' ? 'set' : 'not set'}</span></label>
    <input data-secret="${esc(key)}" type="password" autocomplete="new-password" placeholder="${s[key] === '***' ? '(saved — enter to replace)' : 'Paste key'}" />${hint ? `<div class="hint">${hint}</div>` : ''}</div>`;
  const save = (id, label) =>
    `<div class="inline"><button class="btn primary" data-act="save" data-sec="${id}">${esc(label)}</button><span class="msg" data-msg="${id}"></span></div>`;
  const onOff = [
    ['1', 'On'],
    ['0', 'Off'],
  ];
  // Hands-off blank-field resolutions (from the status endpoint) so the
  // panel shows what a blank Template id / Digest email will actually do.
  const hoTemplateHint = ho.templateId
    ? `Using template #${esc(ho.templateId)}.`
    : ho.resolvedTemplateId
      ? `Blank = auto: template #${esc(ho.resolvedTemplateId)} (first with email + SMS text) will be used.`
      : 'Blank = auto — but no template exists yet, so the campaign email is skipped after a build.';
  const hoDigestHint = ho.reportEmail
    ? ''
    : ho.resolvedReportEmail
      ? `Blank = digest goes to ${esc(ho.resolvedReportEmail)} (platform support / SMTP From fallback).`
      : 'Blank = falls back to the platform support email, then your SMTP From address — neither is set, so no digest can be sent.';

  view.innerHTML = `
    <div class="page-head"><div><h1>Settings</h1><p class="lede">Provider keys, spend limits, prompts, email, publishing and the kill switch for this workspace. Secrets are write-only: they are never shown again after saving. Changing settings requires an owner or admin role.</p></div></div>
    <div class="tabs settings-tabs" id="settings-tabs" role="tablist" aria-label="Settings sections">${SETTINGS_TABS.map(
      ([k, l]) =>
        `<button type="button" role="tab" data-tab="${k}" class="${k === settingsTab ? 'active' : ''}" aria-selected="${k === settingsTab ? 'true' : 'false'}">${esc(l)}</button>`
    ).join('')}</div>
    <div class="settings-main">

        <section class="card" id="sec-team"${showSec('sec-team')}><h2>Team invites</h2>
          <p class="hint">Invite teammates by email. They must register or sign in with that exact address. Owners and admins can invite.</p>
          <form id="invite-form" class="row" style="align-items:flex-end">
            <div class="field" style="flex:2"><label for="inv-email">Email</label><input id="inv-email" name="email" type="email" required placeholder="teammate@example.com" /></div>
            <div class="field"><label for="inv-role">Role</label>
              <select id="inv-role" name="role"><option value="member">Member</option><option value="admin">Admin</option><option value="owner">Owner</option></select>
            </div>
            <button class="btn primary" type="submit">Send invite</button>
          </form>
          <div class="msg" id="inv-msg"></div>
          <div id="team-members" style="margin-top:14px"><p class="hint">Loading members…</p></div>
          <div id="inv-list" style="margin-top:14px"><p class="hint">Loading invites…</p></div>
        </section>

        <section class="card" id="sec-ai"${showSec('sec-ai')}><h2>AI provider</h2>
          <p class="hint">Each task can use its own model; a blank row uses the default.</p>
          <div class="spend">AI spend — today: ${money(usageR && usageR.todayUsd)} · this month: ${money(usageR && usageR.monthUsd)} · ${aiR && aiR.configured ? 'API key configured' : 'no API key'}</div>
          ${secret('ai.api_key', 'API key', 'Stored on the server; never displayed again.')}
          ${f('ai.base_url', 'Base URL')}
          <div class="field"><label>Model routing</label>
            <table><thead><tr><th>Task</th><th>Model (blank = default)</th></tr></thead><tbody>
              <tr><td>default</td><td><input data-key="ai.model.default" value="${esc(s['ai.model.default'] || '')}" /></td></tr>
              ${MODEL_TASKS.map((t) => `<tr><td>${esc(t)}</td><td><input data-key="ai.model.${t}" value="${esc(s['ai.model.' + t] || '')}" /></td></tr>`).join('')}
            </tbody></table></div>
          ${save('sec-ai', 'Save AI settings')}
        </section>

        <section class="card" id="sec-cost"${showSec('sec-cost')}><h2>Cost controls</h2>
          <p class="hint">Hard stops for AI spend and daily production.</p>
          <div class="row">${f('cost.daily_budget_usd', 'Daily AI budget (USD)', { type: 'number', step: '0.5', min: 0 })}${f('cost.max_websites_per_day', 'Max websites / day', { type: 'number', min: 0 })}${f('cost.max_outreach_per_day', 'Max outreach / day (email + SMS)', { type: 'number', min: 0 })}</div>
          <div class="row">${f('cost.per_1k_prompt', 'Cost / 1k prompt tokens (USD)', { type: 'number', step: '0.0001', min: 0 })}${f('cost.per_1k_completion', 'Cost / 1k completion tokens (USD)', { type: 'number', step: '0.0001', min: 0 })}</div>
          ${save('sec-cost', 'Save cost controls')}
        </section>

        <section class="card" id="sec-prompts"${showSec('sec-prompts')}><h2>Prompt library</h2>
          <p class="hint">System prompts for each AI task. Restore brings back the shipped default.</p>
          <div class="field" style="max-width:320px"><label for="pr-sel">Prompt</label><select id="pr-sel">${prompts.map((p) => `<option value="${esc(p.key)}">${esc(p.name || p.key)}</option>`).join('')}</select></div>
          <div class="field"><label for="pr-body">Body</label><textarea id="pr-body" rows="10" class="mono"></textarea></div>
          <div class="inline"><button class="btn primary" data-act="prompt-save">Save prompt</button><button class="btn" data-act="prompt-reset">Restore default</button><span class="msg" id="pr-msg"></span></div>
        </section>

        <section class="card" id="sec-automation"${showSec('sec-automation')}><h2>Automation</h2>
          <p class="hint">Pause stops scanning, generation, campaigns, scheduled jobs and AI actions. New work is blocked at the next step; a step already running finishes.</p>
          <p>Status: <strong id="auto-status">${paused ? 'Paused' : 'Running'}</strong></p>
          <div class="inline"><button class="btn" data-act="auto-toggle" id="auto-toggle">${paused ? 'Resume automation' : 'Pause automation'}</button></div>
          <div style="margin-top:16px"><button class="big-danger" data-act="auto-stop">Emergency stop</button></div>
          <p class="hint" style="margin-top:8px">Emergency stop sets the same pause as the button above — there is no separate kill switch and it cancels nothing extra. Everything stays blocked until you resume.</p>
        </section>

        <section class="card" id="sec-hands-off"${showSec('sec-hands-off')}><h2>Hands-off mode</h2>
          <p class="hint">Unattended pipeline: discover → score → Meta Muse builds via tools → publish → email/SMS → follow-up → owner digest. Requires platform Meta Muse Model API key (<code>muse.model_*</code> in Admin). Honors the automation pause switch.</p>
          <p class="hint">Muse: <strong>${ho.museConfigured ? 'configured' : 'not configured'}</strong>${ho.museModel ? ' · ' + esc(ho.museModel) : ''} · Last run: ${esc(ho.lastRunAt || s['hands_off.last_run_at'] || 'never')} · Last digest: ${esc(ho.lastDigestAt || s['hands_off.last_digest_at'] || 'never')}</p>
          <div class="row">
            ${f('hands_off.enabled', 'Hands-off', { options: onOff, def: '0' })}
            ${f('hands_off.min_score', 'Min score to build', { type: 'number', min: 0, def: '50' })}
            ${f('hands_off.max_sites_per_day', 'Max sites / day', { type: 'number', min: 0, def: '5' })}
            ${f('hands_off.followup_days', 'Follow-up days', { type: 'number', min: 1, def: '3' })}
          </div>
          <div class="row">
            ${f('hands_off.channel', 'Outreach channel', {
              def: 'both',
              options: [
                ['both', 'Email + SMS'],
                ['email', 'Email only'],
                ['sms', 'SMS only'],
              ],
            })}
            ${f('hands_off.template_id', 'Template id (optional)', { placeholder: 'first dual-channel template', hint: hoTemplateHint })}
            ${f('hands_off.report_email', 'Digest email', { type: 'email', placeholder: 'falls back to support.email', hint: hoDigestHint })}
          </div>
          <div class="row">
            ${f('hands_off.followup_interested_email', 'Interested follow-up email', { options: onOff, def: '1', hint: 'When a lead clicks "I\'m interested" (email link or site claim popup), email them next steps — customizations, plan pricing, portal access and available domain names — and notify the digest email. Sent once per lead.' })}
          </div>
          <div class="inline">
            ${save('sec-hands-off', 'Save Hands-off')}
            <button class="btn" type="button" data-act="hands-off-run">Run tick now</button>
            <span class="msg" data-msg="hands-off-run"></span>
          </div>
        </section>

        <section class="card" id="sec-agent"${showSec('sec-agent')}><h2>Design agent trigger</h2>
          <p class="hint">When a design job becomes <code>waiting_on_agent</code> the server writes a trigger file and can run a command or POST a webhook (redesign / improvements). Failures never block the queue.</p>
          ${f('design.agent_notify', 'Notify', { options: onOff, def: '1' })}
          ${f('design.agent_trigger_command', 'Trigger command (optional)', { hint: 'Placeholders: <code>{{job_id}}</code>, <code>{{reason}}</code>, <code>{{status}}</code>, <code>{{message}}</code>. Runs on the server.' })}
          ${f('design.agent_webhook_url', 'Webhook URL (optional)', { type: 'url', placeholder: 'https://example.com/hooks/design-agent', hint: 'POSTed as JSON when redesign or improvements is queued.' })}
          ${f('design.agent_webhook_secret', 'Webhook secret (optional)', { type: 'password', hint: 'Sent as <code>Authorization: Bearer …</code> and <code>X-Webhook-Secret</code>.' })}
          ${f('design.agent_trigger_file', 'Trigger file path (optional)', { hint: 'Default: <code>design-agent-trigger.json</code> beside the workspace database.' })}
          ${save('sec-agent', 'Save design agent trigger')}
        </section>

        <section class="card" id="sec-learning"${showSec('sec-learning')}><h2>Design learning</h2>
          <p class="hint">Reviews, redesign requests and client emails feed a short playbook that is added to new design briefs.</p>
          <div class="row">${f('design.learning.enabled', 'Learning', { options: onOff })}${f('design.learning.max_playbook', 'Max playbook lessons', { type: 'number', min: 4, def: '24' })}</div>
          ${save('sec-learning', 'Save learning settings')}
          <div id="st-learning" style="margin-top:12px"></div>
        </section>

        <section class="card" id="sec-discovery"${showSec('sec-discovery')}><h2>Discovery schedule</h2>
          <p class="hint">Runs lead discovery on the server on a schedule. Honors the automation pause switch.</p>
          <div class="row">
            <div class="field"><label>Schedule</label><select id="ds-enabled"><option value="0" ${sched.enabled ? '' : 'selected'}>Off</option><option value="1" ${sched.enabled ? 'selected' : ''}>On</option></select></div>
            <div class="field"><label>Frequency</label><select id="ds-mode"><option value="interval" ${sched.mode === 'daily' ? '' : 'selected'}>Every N hours</option><option value="daily" ${sched.mode === 'daily' ? 'selected' : ''}>Daily at a time</option></select></div>
            <div class="field"><label>Interval (hours)</label><input id="ds-interval" type="number" min="1" max="168" value="${esc(sched.interval_hours || 6)}" /></div>
            <div class="field"><label>Daily time</label><input id="ds-daily" type="time" value="${esc(sched.daily_time || '09:00')}" /></div>
          </div>
          <div class="row">
            <div class="field"><label>Provider</label><select id="ds-provider">${(providers.length ? providers : [{ name: sched.provider || 'tavily' }]).map((p) => `<option value="${esc(p.name)}" ${p.name === sched.provider ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>
            <div class="field"><label>Category / niche</label><input id="ds-category" value="${esc(sched.category || '')}" placeholder="Plumber or * for any" /><div class="hint">Use <code>*</code> or <code>any</code> for all niches.</div></div>
            <div class="field"><label>Location</label><input id="ds-location" value="${esc(sched.location || '')}" placeholder="Springfield" /></div>
          </div>
          <div class="row">
            <div class="field"><label>Limit per run</label><input id="ds-limit" type="number" min="1" max="50" value="${esc(sched.limit || 8)}" /></div>
            <div class="field"><label>Lead group (optional)</label><input id="ds-group" value="${esc(sched.group || '')}" /></div>
            <div class="field"><label>Score new leads</label><select id="ds-score"><option value="1" ${sched.score === false ? '' : 'selected'}>Yes</option><option value="0" ${sched.score === false ? 'selected' : ''}>No</option></select></div>
            <div class="field"><label>Website</label><select id="ds-web"><option value="">Any</option><option value="has" ${sched.websitePresence === 'has' ? 'selected' : ''}>Has website</option><option value="no" ${sched.websitePresence === 'no' ? 'selected' : ''}>No website</option></select></div>
          </div>
          <div class="inline"><button class="btn primary" data-act="disc-save">Save schedule</button><button class="btn" data-act="disc-run">Run now</button><span class="msg" id="ds-msg"></span></div>
          <p class="hint" id="ds-status" style="margin-top:10px">${esc(sched.enabled ? 'Enabled' : 'Disabled')} · next: ${esc(sched.next_run || '—')} · last: ${esc(sched.last_run || '—')} ${esc(sched.last_status || '')} ${esc(sched.last_error || '')}</p>
        </section>

        <section class="card" id="sec-sms"${showSec('sec-sms')}><h2>SMS (Twilio)</h2>
          <p class="hint">Text-message outreach. When <code>sms.enabled</code> is off or credentials are missing, queued SMS is stub-sent (logged, marked sent) so drafts still work. Platform Admin → SMS can seed defaults for new workspaces.</p>
          <div class="row">${f('sms.enabled', 'SMS enabled', { options: onOff, def: '0' })}${f('sms.provider', 'Provider', {
            options: [
              ['twilio', 'Twilio'],
              ['vonage', 'Vonage (not implemented)'],
              ['custom', 'Custom → Twilio API'],
            ],
          })}</div>
          <div class="row">${f('sms.account_sid', 'Account SID')}${f('sms.from_number', 'From number', { placeholder: '+15551234567' })}</div>
          ${secret('sms.auth_token', 'Auth token')}
          ${f('sms.webhook_url', 'Inbound webhook URL (optional)', { placeholder: 'https://…' })}
          ${save('sec-sms', 'Save SMS settings')}
        </section>

        <section class="card" id="sec-smtp"${showSec('sec-smtp')}><h2>Email (SMTP + IMAP)</h2>
          <p class="hint">Outbound mail (design jobs, outreach, notifications) goes through the provider selected below — Custom SMTP (Mailjet today) or native Cloudflare. Each job email also includes a public <strong>client form</strong> link for answers and change requests (works without IMAP). Optional IMAP still polls replies with <code>[Job #N]</code>.</p>
          <h3 style="margin:12px 0 8px;font-size:15px">Mail provider</h3>
          <p class="hint">Active provider: <strong>${s['mail.provider'] === 'cloudflare' ? 'Cloudflare (native)' : 'Custom SMTP (Mailjet)'}</strong>${s['mail.provider'] === 'cloudflare' ? (s['mail.cf_token'] === '***' ? ' — API token saved.' : ' — API token NOT saved yet: sends will fail until it is set below.') : s['smtp.host'] ? (!s['smtp.user'] || !s['smtp.pass'] ? ' — SMTP credentials are missing: mail will fail until the username and password are set below.' : '') : ' — SMTP host is empty, so mail is not configured (sends are logged, not delivered).'}</p>
          <div class="row">${f('mail.provider', 'Send mail via', { options: [['custom', 'Custom SMTP (Mailjet)'], ['cloudflare', 'Cloudflare (native)']], def: 'custom' })}</div>
          <div id="mail-custom-fields">
          <h3 style="margin:12px 0 8px;font-size:15px">SMTP (outbound)</h3>
          <div class="row">${f('smtp.host', 'Host', { placeholder: 'mail.example.com' })}${f('smtp.port', 'Port', { type: 'number', min: 1 })}${f(
            'smtp.secure',
            'Use TLS (port 465)',
            {
              options: [
                ['0', 'No (STARTTLS / plain)'],
                ['1', 'Yes'],
              ],
            }
          )}${f('smtp.require_tls', 'Require TLS', {
            options: [
              ['1', 'Yes — never send the password unencrypted'],
              ['0', 'No — allow plain (not recommended)'],
            ],
            def: '1',
            hint: 'With Yes, a server that offers no encryption is refused before the password is sent.',
          })}</div>
          <div class="row">${f('smtp.user', 'Username')}${secret('smtp.pass', 'Password')}</div>
          </div>
          <div id="mail-cf-fields">
          <h3 style="margin:12px 0 8px;font-size:15px">Cloudflare Email Sending (native)</h3>
          <p class="hint">Sends via Cloudflare's Email Sending REST API. The token needs the <strong>Email Sending: Edit</strong> permission, and the domain of the From email below must be onboarded for Email Sending in Cloudflare. The From name/email below are shared with SMTP.</p>
          <div class="row">${secret('mail.cf_token', 'Cloudflare API token')}${f('mail.cf_account_id', 'Account ID (optional)', { placeholder: s['cf.account_id'] ? 'Defaults to ' + s['cf.account_id'] : 'Defaults to the Cloudflare tab account ID' })}</div>
          </div>
          <div class="row">${f('smtp.from_name', 'From name')}${f('smtp.from_email', 'From email')}</div>
          <h3 style="margin:18px 0 8px;font-size:15px">IMAP (inbound replies)</h3>
          <div class="row">${f('mail.imap.enabled', 'IMAP polling', { options: onOff })}${f('mail.imap.auto_submit', 'Auto-queue change requests', { options: onOff, def: '0', hint: 'When on, redesign/improve replies are submitted to waiting_on_agent.' })}</div>
          <div class="row">${f('mail.imap.host', 'IMAP host', { placeholder: '(defaults to SMTP host)' })}${f('mail.imap.port', 'Port', { type: 'number', min: 1, def: '993' })}${f(
            'mail.imap.secure',
            'TLS',
            {
              options: [
                ['1', 'Yes (993)'],
                ['0', 'No'],
              ],
            }
          )}</div>
          <div class="row">${f('mail.imap.user', 'IMAP username', { placeholder: '(defaults to SMTP user)' })}${secret('mail.imap.pass', 'IMAP password', 'Leave blank to reuse the SMTP password.')}</div>
          <div class="row">${f('mail.imap.mailbox', 'Mailbox', { def: 'INBOX' })}${f('mail.inbound_drop_dir', 'Drop folder (optional)', { placeholder: '(default: workspace data / inbound-email)' })}</div>
          <div class="inline">${save('sec-smtp', 'Save email settings')}<button class="btn" type="button" data-act="imap-test">Poll inbox now</button><span class="msg" data-msg="imap-test"></span></div>
          <div class="inline" style="margin-top:8px"><label class="fld" style="flex:1"><span>Send a test email to</span><input id="mail-test-to" type="email" placeholder="you@example.com"></label><button class="btn" type="button" data-act="mail-test">Send test email</button><span class="msg" data-msg="mail-test"></span></div>
          <p class="hint">The test send uses the provider selected above (save first if you just changed it).</p>
        </section>

        <section class="card" id="sec-meta"${showSec('sec-meta')}><h2>Social (Meta)</h2>
          <p class="hint">Facebook + Instagram posting. Create a Meta app, add the OAuth redirect
            <code>${esc((window.location.origin || '') + '/api/v1/social/meta/callback')}</code>,
            and request Page + Instagram publishing permissions. Images are optional — Instagram skips caption-only posts.</p>
          ${f('meta.app_id', 'Meta App ID')}
          ${secret('meta.app_secret', 'Meta App Secret')}
          ${f('social.image_price_usd', 'Branded image ad price (USD)', { type: 'number', step: '0.01', min: 0, hint: 'Charged per image for Free/Standard. Premium includes social images at $0. Falls back to the platform admin default when blank.' })}
          <p class="hint">Currently resolves to <strong>${esc(
            (() => {
              const wp = parseFloat(s['social.image_price_usd']);
              return Number.isFinite(wp) && wp >= 0 ? `$${wp.toFixed(2)} per image (workspace value above)` : '$1.00 per image (platform default)';
            })()
          )}</strong>.</p>
          ${save('sec-meta', 'Save Meta settings')}
        </section>

        <section class="card" id="sec-cf"${showSec('sec-cf')}><h2>Cloudflare Pages &amp; Domains</h2>
          <p class="hint">Publish previews and buy/link domains (Domains page). Token needs Account → Cloudflare Pages → Edit and Account → Registrar → Edit. Set a default payment method on Cloudflare before purchasing. ${cfR ? (cfR.configured ? '<span class="badge ok">configured</span>' : '<span class="badge warn">not configured</span>') : ''}</p>
          <div class="row">${f('cf.account_id', 'Account ID', { placeholder: '32-character hex ID' })}${f('cf.project', 'Pages project', { placeholder: 'my-preview-sites' })}</div>
          ${f('cf.preview_domain', 'Custom preview domain (optional)', { placeholder: 'previews.example.com' })}
          ${secret('cf.api_token', 'API token')}
          <div class="inline"><button class="btn primary" data-act="save" data-sec="sec-cf">Save Cloudflare settings</button><button class="btn" data-act="cf-test">Test connection</button><span class="msg" data-msg="sec-cf"></span></div>
          <div id="cf-out" class="hint" style="margin-top:8px"></div>
        </section>

        <section class="card" id="sec-domains"${showSec('sec-domains')}><h2>Domain registration</h2>
          <p class="hint">Default registrant contact sent with every domain registered through BitPype (Cloudflare Registrar). Registrations are blocked until every field except Organization is filled — Cloudflare rejects purchases that arrive without a registrant contact. This is the platform's contact (the domain owner of record), not the client's.</p>
          <div class="row">${f('domain.registrant_first_name', 'First name')}${f('domain.registrant_last_name', 'Last name')}</div>
          ${f('domain.registrant_organization', 'Organization (optional)')}
          <div class="row">${f('domain.registrant_email', 'Email', { type: 'email' })}${f('domain.registrant_phone', 'Phone', { placeholder: '+1 610 555 0123' })}</div>
          ${f('domain.registrant_address', 'Street address')}
          <div class="row">${f('domain.registrant_city', 'City')}${f('domain.registrant_state', 'State / province')}${f('domain.registrant_postal_code', 'Postal code')}</div>
          ${f('domain.registrant_country', 'Country (ISO 2-letter)', { placeholder: 'US' })}
          ${save('sec-domains', 'Save domain settings')}
        </section>

        <section class="card" id="sec-shop"${showSec('sec-shop')}><h2>Shop payments (Stripe)</h2>
          <p class="hint">Let shop customers pay by card through Stripe Checkout. Payments go directly to <b>your</b> Stripe account — BitPype never touches the money. Get the keys in your Stripe dashboard under Developers → API keys. A restricted key with only Checkout Sessions write permission is safest. Products that have their own checkout link keep using that link instead.</p>
          ${f('shop.stripe.publishable_key', 'Publishable key', { placeholder: 'pk_live_…' })}
          ${secret('shop.stripe.secret_key', 'Secret / restricted key', 'Write-only. Leave blank to keep the current value.')}
          ${secret('shop.stripe.webhook_secret', 'Webhook signing secret', 'Write-only. From the webhook endpoint below.')}
          <p class="hint">To record paid orders, add this endpoint in Stripe under Developers → Webhooks, subscribe to <code>checkout.session.completed</code>, <code>checkout.session.expired</code> and <code>payment_intent.payment_failed</code>, then paste its signing secret (whsec_…) above:<br><code>${esc((window.location.origin || '') + '/api/v1/shop/webhook/' + (api.getWorkspaceId() || ''))}</code></p>
          ${save('sec-shop', 'Save shop payment settings')}
        </section>

        <section class="card" id="sec-keys"${showSec('sec-keys')}><h2>Provider keys</h2>
          <p class="hint">Write-only. Leave blank to keep the current value.</p>
          ${secret('providers.tavily.api_key', 'Tavily (lead discovery)', 'Required for Leads → Discover with the <code>tavily</code> provider.')}
          ${f('providers.tavily.search_depth', 'Tavily search depth', {
            options: [
              ['advanced', 'advanced (better relevance)'],
              ['basic', 'basic (faster / cheaper)'],
            ],
          })}
          ${secret('pexels.api_key', 'Pexels (stock photos)')}
          ${secret('fal.api_key', 'fal.ai (image enhance)')}
          ${save('sec-keys', 'Save provider keys')}
        </section>

        <section class="card" id="sec-mail"${showSec('sec-mail')}><h2>Footer &amp; scoring</h2>
          ${f('mail.footer', 'Legal footer appended to every outreach email', { area: true })}
          <div class="row">${f('score.threshold_qualified', 'Qualified threshold (0–100)', { type: 'number', min: 0 })}${f('score.threshold_hot', 'Hot threshold (0–100)', { type: 'number', min: 0 })}${f('app.name', 'App name')}</div>
          ${save('sec-mail', 'Save')}
        </section>
    </div>`;

  $('#settings-tabs').onclick = (e) => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    window.location.hash = '#/settings/' + b.dataset.tab;
  };

  // Batch 48: the mail provider select toggles which field group shows —
  // SMTP fields for Custom, token + account id for Cloudflare (native).
  // The From name/email row stays visible either way (shared identity).
  const mailProvSel = document.querySelector('[data-key="mail.provider"]');
  const syncMailProviderFields = () => {
    const native = !!mailProvSel && mailProvSel.value === 'cloudflare';
    const cfBox = document.getElementById('mail-cf-fields');
    const customBox = document.getElementById('mail-custom-fields');
    if (cfBox) cfBox.style.display = native ? '' : 'none';
    if (customBox) customBox.style.display = native ? 'none' : '';
  };
  if (mailProvSel) {
    mailProvSel.addEventListener('change', syncMailProviderFields);
    syncMailProviderFields();
  }

  mountLearning($('#st-learning'));

  async function refreshMembers() {
    const host = $('#team-members');
    if (!host) return;
    try {
      const rows = asList((await api.invitesMembers()).data, ['members', 'rows']);
      host.innerHTML = `<h3 style="margin-bottom:8px">Current members</h3><div class="table-scroll"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th></tr></thead><tbody>
        ${
          rows
            .map(
              (m) => `<tr>
          <td>${esc(m.name || '—')}</td><td>${esc(m.email)}</td><td>${esc(m.role)}</td>
        </tr>`
            )
            .join('') || '<tr><td colspan="3">No members yet</td></tr>'
        }
      </tbody></table></div>`;
    } catch (err) {
      host.innerHTML = `<p class="hint">${esc(errText(err))}</p>`;
    }
  }
  refreshMembers();

  async function refreshInvites() {
    const host = $('#inv-list');
    if (!host) return;
    try {
      const rows = asList((await api.invitesList()).data, ['invites', 'rows']);
      host.innerHTML = `<div class="table-scroll"><table><thead><tr><th>Email</th><th>Role</th><th>Expires</th><th>Status</th></tr></thead><tbody>
        ${
          rows
            .map((r) => {
              // Display-only state: a pending invite past its expiry can no
              // longer be accepted (acceptInvite rejects it) — say so.
              const expMs = r.expires_at ? Date.parse(String(r.expires_at).replace(' ', 'T') + 'Z') : NaN;
              const expired = !r.accepted_at && Number.isFinite(expMs) && expMs < Date.now();
              const badge = r.accepted_at
                ? '<span class="badge ok">accepted</span>'
                : expired
                  ? '<span class="badge warn">expired</span>'
                  : '<span class="badge">pending</span>';
              return `<tr>
          <td>${esc(r.email)}</td><td>${esc(r.role)}</td><td>${esc(fmtDate(r.expires_at))}</td>
          <td>${badge}</td>
        </tr>`;
            })
            .join('') || '<tr><td colspan="4">No invites yet</td></tr>'
        }
      </tbody></table></div>`;
    } catch (err) {
      host.innerHTML = `<p class="hint">${esc(errText(err))}</p>`;
    }
  }
  refreshInvites();
  const invForm = $('#invite-form');
  if (invForm) {
    guardSubmit(invForm, async (e) => {
      e.preventDefault();
      const msg = $('#inv-msg');
      setMsg(msg, 'Sending…');
      try {
        const body = formObject(e.target);
        const r = await api.invitesCreate(body);
        const data = r.data || {};
        if (data.link) setMsg(msg, 'Invite created (email not sent). Link: ' + data.link, 'ok');
        else setMsg(msg, data.emailed ? 'Invite emailed.' : 'Invite created.', 'ok');
        e.target.reset();
        refreshInvites();
      } catch (err) {
        setMsg(msg, errText(err), 'err');
      }
    });
  }

  const loadPrompt = () => {
    const p = prompts.find((x) => x.key === $('#pr-sel').value);
    $('#pr-body').value = p ? p.body : '';
  };
  $('#pr-sel').addEventListener('change', loadPrompt);
  loadPrompt();

  async function saveSection(secId, btn) {
    const sec = document.getElementById(secId);
    const msg = $(`[data-msg="${secId}"]`, sec);
    setMsg(msg, 'Saving…');
    try {
      for (const el of $$('[data-key]', sec)) await api.settingsSet(el.dataset.key, el.value);
      for (const el of $$('[data-secret]', sec)) {
        if (el.value.trim()) {
          await api.settingsSecret(el.dataset.secret, el.value.trim());
          el.value = '';
        }
      }
      setMsg(msg, 'Saved', 'ok');
      toast('Settings saved', 'ok');
    } catch (err) {
      setMsg(msg, errText(err), 'err');
    }
    return btn;
  }

  delegate(view, {
    save: (t) => saveSection(t.dataset.sec, t),
    'prompt-save': async () => {
      await api.promptSave($('#pr-sel').value, $('#pr-body').value);
      const p = prompts.find((x) => x.key === $('#pr-sel').value);
      if (p) p.body = $('#pr-body').value;
      setMsg($('#pr-msg'), 'Saved', 'ok');
    },
    'prompt-reset': async () => {
      if (!window.confirm('Restore the shipped default for this prompt?')) return;
      const r = (await api.promptReset($('#pr-sel').value)).data;
      const p = prompts.find((x) => x.key === r.key);
      if (p) p.body = r.body;
      $('#pr-body').value = r.body;
      setMsg($('#pr-msg'), 'Restored', 'ok');
    },
    'auto-toggle': async () => {
      if (
        !window.confirm(
          automationPaused ? 'Resume automation?' : 'Pause all automation (discovery, jobs, outreach, AI)?'
        )
      )
        return;
      await setAutomation(!automationPaused);
      settingsTab = 'automation';
      if (window.location.hash === '#/settings/automation') pageSettings('automation');
      else window.location.hash = '#/settings/automation';
    },
    'auto-stop': async () => {
      if (!window.confirm('Emergency stop: pause ALL automation now? (Same pause switch as Pause automation.)')) return;
      await setAutomation(true);
      settingsTab = 'automation';
      if (window.location.hash === '#/settings/automation') pageSettings('automation');
      else window.location.hash = '#/settings/automation';
    },
    'cf-test': async () => {
      const out = $('#cf-out');
      out.textContent = 'Testing connection…';
      const r = (await api.cfTest()).data;
      if (r.ok === false)
        out.innerHTML = `<span class="error">${esc(r.error)}</span>${r.hint || r.detail ? ' — ' + esc(r.hint || r.detail) : ''}`;
      else
        out.innerHTML = `<span class="check-pass">Connected.</span> Projects: ${esc((r.projects || []).join(', ') || 'none')}`;
    },
    'imap-test': async () => {
      const msg = $('[data-msg="imap-test"]');
      setMsg(msg, 'Polling…');
      try {
        const r = (await api.emailImapPoll({ force: true })).data;
        if (r.skipped) setMsg(msg, r.reason || 'skipped', 'err');
        else setMsg(msg, `Fetched ${r.fetched || 0}, processed ${r.processed || 0}`, 'ok');
      } catch (err) {
        setMsg(msg, errText(err), 'err');
      }
    },
    // Batch 48: test-send through the SELECTED mail provider.
    'mail-test': async () => {
      const msg = $('[data-msg="mail-test"]');
      const to = (($('#mail-test-to') || {}).value || '').trim();
      if (!to) {
        setMsg(msg, 'Enter an email address first', 'err');
        return;
      }
      setMsg(msg, 'Sending…');
      try {
        const r = (await api.mailTest(to)).data;
        setMsg(msg, `Sent via ${r.provider} to ${r.to}`, 'ok');
      } catch (err) {
        setMsg(msg, errText(err), 'err');
      }
    },
    'disc-save': async () => {
      const msg = $('#ds-msg');
      try {
        const r =
          (
            await api.discoverySet({
              enabled: $('#ds-enabled').value === '1',
              mode: $('#ds-mode').value,
              interval_hours: Number($('#ds-interval').value) || 6,
              daily_time: $('#ds-daily').value || '09:00',
              provider: $('#ds-provider').value,
              category: $('#ds-category').value.trim(),
              location: $('#ds-location').value.trim(),
              limit: Number($('#ds-limit').value) || 8,
              score: $('#ds-score').value === '1',
              group: $('#ds-group').value.trim(),
              websitePresence: $('#ds-web').value,
            })
          ).data.schedule || {};
        setMsg(msg, 'Saved', 'ok');
        $('#ds-status').textContent =
          `${r.enabled ? 'Enabled' : 'Disabled'} · next: ${r.next_run || '—'} · last: ${r.last_run || '—'}`;
      } catch (err) {
        setMsg(msg, errText(err), 'err');
      }
    },
    'disc-run': async () => {
      const msg = $('#ds-msg');
      setMsg(msg, 'Running discovery…');
      const r = (await api.discoveryRun()).data;
      setMsg(
        msg,
        r && r.skipped ? `Skipped: ${r.reason}` : `Done${r && r.created != null ? ': ' + r.created + ' created' : ''}.`,
        'ok'
      );
    },
    'hands-off-run': async () => {
      if (
        !window.confirm(
          'Run one Hands-off tick now? A tick runs discovery, scores leads, builds at most one site for a qualifying lead (within the min score and daily cap), publishes it, and sends its outreach plus a digest. It does nothing while Hands-off is Off or automation is paused.'
        )
      )
        return;
      const msg = $('[data-msg="hands-off-run"]');
      setMsg(msg, 'Running Hands-off tick…');
      try {
        const r = (await api.handsOffRun(false)).data;
        if (r && r.skipped) setMsg(msg, `Skipped: ${r.reason}`, 'err');
        else
          setMsg(
            msg,
            `Done — discovered ${r.discovered || 0}, scored ${r.scored || 0}, delivered ${r.delivered || 0}.`,
            'ok'
          );
      } catch (err) {
        setMsg(msg, errText(err), 'err');
      }
    },
  });
}

/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */

function parseHash() {
  const m = (window.location.hash || '#/dashboard').match(/^#\/([a-z-]+)(?:\/([^?]*))?(?:\?(.*))?$/);
  if (!m) return { route: 'dashboard', param: '', query: {} };
  const query = {};
  new URLSearchParams(m[3] || '').forEach((v, k) => {
    query[k] = v;
  });
  return { route: m[1], param: m[2] || '', query };
}

/* ------------------------------------------------------------------ */
/* Platform super admin                                                */
/* ------------------------------------------------------------------ */

let adminTab = 'overview';
let gbpAdminPage = 1;

async function pageAdmin(param) {
  if (!currentUserIsSuperAdmin) {
    view.innerHTML =
      '<div class="card error-card"><h2>Super admin only</h2><p>Your account is not a platform administrator.</p></div>';
    return;
  }
  const tab = (param && String(param).split('/')[0]) || adminTab || 'overview';
  adminTab = tab;
  const tabs = [
    ['overview', 'Overview'],
    ['users', 'Users'],
    ['partners', 'Partners'],
    ['approvals', 'Approvals'],
    ['access', 'Portal access'],
    ['workspaces', 'Workspaces'],
    ['payments', 'Payments'],
    ['upsell', 'Upsell tips'],
    ['email', 'Email'],
    // SMS admin tab hidden until a send path exists (settings still accept sms.* keys).
    ['keys', 'API keys'],
    ['gbp', 'Google Business'],
    ['billing', 'Stripe'],
    ['adsense', 'AdSense'],
    ['general', 'General'],
    ['landing', 'Landing'],
    ['hostinger', 'Hostinger'],
    ['audit', 'Audit'],
  ];

  view.innerHTML = `
    <div class="page-head">
      <div><h1>Platform admin</h1><p class="lede">Manage users, workspaces, and platform-wide defaults.</p></div>
    </div>
    <div class="tabs" id="admin-tabs">${tabs
      .map(([k, l]) => `<button type="button" class="${k === tab ? 'active' : ''}" data-tab="${k}">${l}</button>`)
      .join('')}</div>
    <div id="admin-body"><p class="hint"><span class="load-spin" aria-hidden="true"></span> Loading…</p></div>`;

  $('#admin-tabs').onclick = (e) => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    window.location.hash = '#/admin/' + b.dataset.tab;
  };

  const body = $('#admin-body');
  try {
    await withLoadTimeout(
      (async () => {
        if (tab === 'overview') await renderAdminOverview(body);
        else if (tab === 'users') await renderAdminUsers(body);
        else if (tab === 'partners') await renderAdminPartners(body);
        else if (tab === 'approvals') await renderAdminApprovals(body);
        else if (tab === 'access') await renderAdminPortalAccess(body);
        else if (tab === 'workspaces') await renderAdminWorkspaces(body);
        else if (tab === 'payments') await renderAdminPayments(body);
        else if (tab === 'upsell') await renderAdminUpsellTips(body);
        else if (tab === 'adsense') await renderAdminAdsense(body);
        else if (tab === 'gbp') await renderAdminGbp(body);
        else if (tab === 'email' || tab === 'sms' || tab === 'keys' || tab === 'general' || tab === 'billing' || tab === 'landing' || tab === 'hostinger')
          await renderAdminSettings(body, tab);
        else if (tab === 'audit') await renderAdminAudit(body);
        else body.innerHTML = '<p class="hint">Unknown tab</p>';
      })(),
      20000
    );
  } catch (err) {
    body.innerHTML = `<div class="card error-card"><p>${esc(errText(err))}</p><p><button class="btn" data-act="admin-retry">Retry</button></p></div>`;
    const rb = body.querySelector('[data-act="admin-retry"]');
    if (rb) rb.addEventListener('click', () => pageAdmin(param));
  }
}

/* Batch 80 — Admin → Partners: balances across partner accounts and
   the record-payout action. The app RECORDS payouts; the money itself
   moves outside the app (manual/Stripe by Ely). Payouts are gross —
   partners handle their own taxes. */
async function renderAdminPartners(el) {
  const res = await api.adminPartners();
  const partners = (res.data && res.data.partners) || [];
  const money = (c) => moneyCents(c || 0, 'USD');
  const rows = partners
    .map(
      (p) => `<tr>
        <td>${esc(p.email)}<br><span class="hint">${esc(p.name || '')}</span></td>
        <td>${esc((p.workspaceIds || []).join(', ') || '—')}</td>
        <td style="text-align:right">${money(p.balanceCents)}</td>
        <td>${p.eligible ? '<strong>Eligible</strong>' : '<span class="hint">below $500</span>'}</td>
        <td class="row actions">
          <input type="text" data-payout-method="${p.userId}" placeholder="Method (e.g. Stripe)" style="max-width:150px" />
          <input type="text" data-payout-note="${p.userId}" placeholder="Note" style="max-width:150px" />
          <button class="btn ghost small" data-payout="${p.userId}" ${p.balanceCents > 0 ? '' : 'disabled'}>Record payout (full balance)</button>
        </td>
      </tr>`
    )
    .join('');
  el.innerHTML = `
    <div class="panel"><div class="panel-b">
      <p class="hint" style="margin-bottom:0.75rem">Partners earn the commission rate (platform setting <code>partners.commission_percent</code>, default 30%) on subscription payments from customers in their workspace. Payouts are monthly once a balance reaches $500, are recorded here only — send the money outside the app — and are <strong>gross</strong>: partners are responsible for their own taxes. Partner accounts are created in the Users tab (create user, then “Make partner”).</p>
      <table><thead><tr><th>Partner</th><th>Workspaces</th><th style="text-align:right">Balance</th><th>Payout status</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5" class="hint">No partner accounts yet.</td></tr>'}</tbody></table>
    </div></div>`;
  $$('[data-payout]').forEach(
    (b) =>
      (b.onclick = async () => {
        const uid = b.dataset.payout;
        const method = (el.querySelector(`[data-payout-method="${uid}"]`) || {}).value || '';
        const note = (el.querySelector(`[data-payout-note="${uid}"]`) || {}).value || '';
        if (!confirm('Record a payout of this partner\'s FULL current balance as PAID? Only do this after the money has actually been sent.'))
          return;
        await safeRun(b, async () => {
          const out = await api.adminRecordPartnerPayout(uid, { method, note });
          toast(`Payout recorded: ${moneyCents(out.data.amountCents || 0, 'USD')}`, 'ok');
          pageAdmin('partners');
        });
      })
  );
}

/* Batch 80 — Admin → Approvals: the partner purchase-approval queue.
   Approve executes the stored purchase with the admin as the actor;
   deny closes the request with the decision recorded. */
async function renderAdminApprovals(el) {
  const res = await api.adminPartnerApprovals();
  const approvals = (res.data && res.data.approvals) || [];
  const rows = approvals
    .map(
      (a) => `<tr>
        <td>${esc(String(a.createdAt || '').slice(0, 10))}</td>
        <td>${esc(a.actionKind)}</td>
        <td>ws ${esc(a.workspaceId != null ? a.workspaceId : '—')} · user ${esc(a.requestedBy)}</td>
        <td><code style="font-size:0.8rem">${esc(JSON.stringify(a.payload || {}).slice(0, 140))}</code></td>
        <td>${esc(a.status)}${a.status === 'failed' && a.result ? `<br><span class="hint">${esc(a.result.message || a.result.error || '')}</span>` : ''}</td>
        <td class="row actions">${a.status === 'pending' ? `<button class="btn ghost small" data-approve="${a.id}">Approve &amp; run</button> <button class="btn ghost small" data-deny="${a.id}">Deny</button>` : ''}</td>
      </tr>`
    )
    .join('');
  el.innerHTML = `
    <div class="panel"><div class="panel-b">
      <p class="hint" style="margin-bottom:0.75rem">Purchases a partner starts (domain registrations, tracking numbers, credits, domain-flow completions, Hostinger deployments) land here instead of executing. Approving runs the stored action as you; denying closes it with the decision recorded.</p>
      <table><thead><tr><th>Date</th><th>Action</th><th>Scope</th><th>Payload</th><th>Status</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="6" class="hint">No approval requests yet.</td></tr>'}</tbody></table>
    </div></div>`;
  const decide = async (b, approve) => {
    if (
      !confirm(
        approve
          ? 'Approve and EXECUTE this purchase now? This spends real money / starts the stored action.'
          : 'Deny this purchase request? It will be closed and never executed.'
      )
    )
      return;
    await safeRun(b, async () => {
      const out = await api.adminDecidePartnerApproval(b.dataset.approve || b.dataset.deny, { approve });
      toast(`Request ${out.data.status}`, out.data.status === 'failed' ? 'err' : 'ok');
      pageAdmin('approvals');
    });
  };
  $$('[data-approve]').forEach((b) => (b.onclick = () => decide(b, true)));
  $$('[data-deny]').forEach((b) => (b.onclick = () => decide(b, false)));
}

async function renderAdminOverview(el) {
  const ov = (await api.adminOverview()).data;
  el.innerHTML = `
    <div class="stats-cards">
      <div class="stat-card"><div class="n">${ov.users}</div><div class="l">Users</div></div>
      <div class="stat-card"><div class="n">${ov.usersActive}</div><div class="l">Active</div></div>
      <div class="stat-card"><div class="n">${ov.workspaces}</div><div class="l">Workspaces</div></div>
      <div class="stat-card"><div class="n">${ov.superAdmins}</div><div class="l">Super admins</div></div>
      <div class="stat-card"><div class="n">${ov.mcpTokens}</div><div class="l">MCP tokens</div></div>
      <div class="stat-card"><div class="n">${ov.scheduledJobs}</div><div class="l">Scheduled jobs</div></div>
    </div>
    <div class="panel" style="margin-top:1rem">
      <div class="panel-b">
        <p>Registration: <strong>${ov.registrationOpen ? 'open' : 'closed'}</strong> ·
           Maintenance: <strong>${ov.maintenanceMode ? 'on' : 'off'}</strong></p>
        <div class="row actions" style="margin-top:0.75rem">
          <button class="btn" type="button" id="admin-push">Push defaults to all workspaces (fill empty)</button>
          <button class="btn ghost" type="button" id="admin-push-force">Force overwrite defaults</button>
        </div>
        <div class="msg" id="admin-ov-msg"></div>
      </div>
    </div>`;
  $('#admin-push').onclick = () =>
    safeRun($('#admin-ov-msg'), async () => {
      const r = await api.adminPushDefaults({ force: false });
      $('#admin-ov-msg').textContent =
        `Updated ${r.data.cellsUpdated} setting cells across ${r.data.workspaces} workspaces.`;
      $('#admin-ov-msg').className = 'msg ok';
    });
  $('#admin-push-force').onclick = () => {
    if (!confirm('Overwrite workspace settings with platform defaults?')) return;
    safeRun($('#admin-ov-msg'), async () => {
      const r = await api.adminPushDefaults({ force: true });
      $('#admin-ov-msg').textContent =
        `Force-updated ${r.data.cellsUpdated} cells across ${r.data.workspaces} workspaces.`;
      $('#admin-ov-msg').className = 'msg ok';
    });
  };
}

function adminUserStatusLabel(status) {
  return String(status || 'active') === 'disabled' ? 'blocked' : 'active';
}

function openAdminEditUser(u) {
  const m = openModal({
    title: 'Edit user',
    body: `<form id="admin-edit-user-form" class="stack">
      <div><label>Email</label><input name="email" type="email" required value="${esc(u.email || '')}" /></div>
      <div><label>Name</label><input name="name" value="${esc(u.name || '')}" /></div>
      <div><label>New password <span class="hint">(optional)</span></label>
        <input name="password" type="password" minlength="8" autocomplete="new-password" placeholder="Leave blank to keep" /></div>
      <div class="msg" id="admin-edit-user-msg"></div>
    </form>`,
    buttons: [
      { label: 'Cancel' },
      {
        label: 'Save',
        cls: 'primary',
        onClick: async (modal) => {
          const form = $('#admin-edit-user-form', modal.el);
          const fd = new FormData(form);
          const body = {
            email: String(fd.get('email') || '').trim(),
            name: String(fd.get('name') || '').trim(),
          };
          const password = String(fd.get('password') || '');
          if (password) body.password = password;
          const msg = $('#admin-edit-user-msg', modal.el);
          try {
            await api.adminUpdateUser(u.id, body);
            setMsg(msg, 'Saved', 'ok');
            modal.close();
            toast('User updated', 'ok');
            pageAdmin('users');
          } catch (err) {
            setMsg(msg, errText(err), 'error');
            throw err;
          }
        },
      },
    ],
  });
  return m;
}

async function renderAdminUsers(el) {
  const users = asList((await api.adminUsers()).data, ['users']);
  const selfId = currentUserId;
  el.innerHTML = `
    <div class="panel">
      <div class="panel-h"><h3>Create user</h3></div>
      <div class="panel-b">
        <form id="admin-user-form" class="stack">
          <div class="row">
            <div><label>Email</label><input name="email" type="email" required /></div>
            <div><label>Name</label><input name="name" /></div>
            <div><label>Password</label><input name="password" type="password" minlength="8" required /></div>
          </div>
          <div class="row">
            <div><label>Workspace name</label><input name="workspaceName" placeholder="Optional" /></div>
            <div><label><input name="superAdmin" type="checkbox" /> Super admin</label></div>
          </div>
          <div class="row actions"><button class="btn" type="submit">Create</button></div>
          <div class="msg" id="admin-user-msg"></div>
        </form>
      </div>
    </div>
    <div class="panel" style="margin-top:1rem">
      <div class="panel-h"><h3>Users</h3></div>
      <div class="panel-b">
        <p class="hint" style="margin-bottom:0.75rem">Blocked users cannot sign in (stored as status <code>disabled</code>). Delete soft-removes the account and memberships; workspaces remain.</p>
        <table><thead><tr><th>Email</th><th>Name</th><th>Status</th><th>WS</th><th>Role</th><th></th></tr></thead>
        <tbody>
          ${
            users
              .map((u) => {
                const blocked = String(u.status || 'active') === 'disabled';
                const isSelf = selfId != null && Number(u.id) === Number(selfId);
                return `<tr>
            <td>${esc(u.email)}${isSelf ? ' <span class="hint">(you)</span>' : ''}</td><td>${esc(u.name)}</td>
            <td>${esc(adminUserStatusLabel(u.status))}</td><td>${esc(u.workspace_count)}</td>
            <td>${Number(u.is_super_admin) ? 'super' : u.account_type === 'partner' ? 'partner' : 'user'}</td>
            <td class="row actions">
              <button class="btn ghost small" data-edit="${u.id}">Edit</button>
              ${isSelf ? '' : `<button class="btn ghost small" data-toggle-partner="${u.id}" data-on="${u.account_type === 'partner' ? 0 : 1}">${u.account_type === 'partner' ? 'Make standard' : 'Make partner'}</button>`}
              ${isSelf ? '' : `<button class="btn ghost small" data-toggle-sa="${u.id}" data-on="${Number(u.is_super_admin) ? 0 : 1}">${Number(u.is_super_admin) ? 'Demote' : 'Make super'}</button>`}
              ${isSelf ? '' : `<button class="btn ghost small" data-toggle-st="${u.id}" data-st="${blocked ? 'active' : 'disabled'}">${blocked ? 'Unblock' : 'Block'}</button>`}
              <button class="btn ghost small" data-reset="${u.id}">Reset pw</button>
              <button class="btn ghost small" data-reset-mfa="${u.id}" title="${Number(u.totp_enabled) ? 'Two-factor is ON for this user — reset clears it and they re-enroll at next sign-in' : 'Clear any two-factor setup for this user'}">Reset MFA${Number(u.totp_enabled) ? ' (on)' : ''}</button>
              ${isSelf ? '' : `<button class="btn danger small" data-del="${u.id}">Delete</button>`}
            </td>
          </tr>`;
              })
              .join('') || '<tr><td colspan="6">No users</td></tr>'
          }
        </tbody></table>
      </div>
    </div>`;

  guardSubmit($('#admin-user-form'), async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = Object.fromEntries(fd.entries());
    body.superAdmin = !!fd.get('superAdmin');
    const msg = $('#admin-user-msg');
    try {
      await api.adminCreateUser(body);
      msg.textContent = 'Created';
      msg.className = 'msg ok';
      pageAdmin('users');
    } catch (err) {
      msg.textContent = errText(err);
      msg.className = 'msg error';
    }
  });
  $$('[data-edit]').forEach((b) => {
    b.onclick = () => {
      const u = users.find((x) => Number(x.id) === Number(b.dataset.edit));
      if (u) openAdminEditUser(u);
    };
  });
  $$('[data-toggle-sa]').forEach(
    (b) =>
      (b.onclick = async () => {
        const promoting = Number(b.dataset.on) === 1;
        const u = users.find((x) => Number(x.id) === Number(b.dataset.toggleSa));
        const who = u ? u.email : 'this user';
        if (
          !confirm(
            promoting
              ? `Make ${who} a SUPER ADMIN? They will have full platform access, including all workspaces and platform settings.`
              : `Remove super admin from ${who}? They will lose platform-wide access.`
          )
        )
          return;
        await safeRun(b, async () => {
          await api.adminUpdateUser(b.dataset.toggleSa, { is_super_admin: promoting });
          toast(promoting ? 'Super admin granted' : 'Super admin removed', 'ok');
          pageAdmin('users');
        });
      })
  );
  $$('[data-toggle-partner]').forEach(
    (b) =>
      (b.onclick = async () => {
        const making = Number(b.dataset.on) === 1;
        const u = users.find((x) => Number(x.id) === Number(b.dataset.togglePartner));
        const who = u ? u.email : 'this user';
        if (
          !confirm(
            making
              ? `Make ${who} a PARTNER? They keep full staff access inside their own workspace only, cannot change settings, need approval for purchases, and earn commission on their workspace's customer payments.`
              : `Remove partner status from ${who}? Their earnings ledger and payout history stay on record.`
          )
        )
          return;
        await safeRun(b, async () => {
          await api.adminUpdateUser(b.dataset.togglePartner, { account_type: making ? 'partner' : 'standard' });
          toast(making ? 'Partner status granted' : 'Partner status removed', 'ok');
          pageAdmin('users');
        });
      })
  );
  $$('[data-toggle-st]').forEach(
    (b) =>
      (b.onclick = async () => {
        const next = b.dataset.st;
        const label = next === 'disabled' ? 'block' : 'unblock';
        if (
          !confirm(
            `${label === 'block' ? 'Block' : 'Unblock'} this user? ${next === 'disabled' ? 'They will not be able to sign in.' : 'They will be able to sign in again.'}`
          )
        )
          return;
        await safeRun(b, async () => {
          await api.adminUpdateUser(b.dataset.toggleSt, { status: next });
          toast(next === 'disabled' ? 'User blocked' : 'User unblocked', 'ok');
          pageAdmin('users');
        });
      })
  );
  $$('[data-reset]').forEach(
    (b) =>
      (b.onclick = async () => {
        const password = prompt('New password (min 8 chars)');
        if (!password) return;
        try {
          await api.adminUpdateUser(b.dataset.reset, { password });
          toast('Password updated', 'ok');
        } catch (err) {
          toast(errText(err), 'err');
        }
      })
  );
  $$('[data-reset-mfa]').forEach(
    (b) =>
      (b.onclick = async () => {
        const u = users.find((x) => Number(x.id) === Number(b.dataset.resetMfa));
        const who = u ? u.email : 'this user';
        if (
          !confirm(
            `Reset two-factor authentication for ${who}? Their authenticator setup and recovery codes are cleared; staff must re-enroll at their next sign-in.`
          )
        )
          return;
        await safeRun(b, async () => {
          await api.adminResetUserMfa(b.dataset.resetMfa);
          toast('Two-factor reset — they will re-enroll at next sign-in', 'ok');
          pageAdmin('users');
        });
      })
  );
  $$('[data-del]').forEach(
    (b) =>
      (b.onclick = async () => {
        const u = users.find((x) => Number(x.id) === Number(b.dataset.del));
        const email = u ? u.email : b.dataset.del;
        const wsNote =
          u && Number(u.workspace_count) > 0
            ? ` They belong to ${u.workspace_count} workspace(s); memberships will be removed and sole-owned workspaces will have no owner (workspaces are kept).`
            : '';
        if (!confirm(`Delete user ${email}? This soft-deletes the account and cannot be undone from the UI.${wsNote}`))
          return;
        if (prompt('Type DELETE to confirm') !== 'DELETE') return;
        await safeRun(b, async () => {
          const r = await api.adminDeleteUser(b.dataset.del);
          const sole = (r.data && r.data.soleOwnedWorkspaces) || [];
          toast(
            sole.length ? `User deleted. ${sole.length} workspace(s) left without an owner.` : 'User deleted',
            'ok'
          );
          pageAdmin('users');
        });
      })
  );
  // Batch 29: client portal users (types + tab access) live below the
  // staff users panel on this same tab.
  renderAdminPortalUsersPanel(el).catch(() => {});
}

/* Batch 29 — client portal users: type (owner/renter) + per-tab nav
   overrides. Effective access is enforced by the portal API itself;
   this UI only writes user_type / nav_overrides via the admin API. */
function openAdminPortalUserAccess(u, meta) {
  const tabs = (meta && meta.tabs) || [];
  const defaults = (meta && meta.typeDefaults) || { owner: [], renter: [] };
  const modList = (meta && meta.modules) || [];
  const modDefaults = (meta && meta.moduleTypeDefaults) || { owner: [], renter: [] };
  // Pre-fill: the user's current effective set when the type is
  // unchanged; the (admin-configured) type defaults when it switches.
  const checkedFor = (type) =>
    type === u.userType ? new Set(u.visibleTabs || []) : new Set(defaults[type] || []);
  const checkedModsFor = (type) =>
    type === u.userType ? new Set(u.visibleModules || []) : new Set(modDefaults[type] || []);
  const checklist = (list, prefix) =>
    list
      .map(
        (t) =>
          `<label style="font-weight:normal"><input type="checkbox" name="${prefix}${esc(t.key)}" value="1" /> ${esc(t.label)}</label>`
      )
      .join('');
  const m = openModal({
    title: `Portal access — ${u.email}`,
    body: `<form id="admin-portal-access-form" class="stack">
      <p class="hint">${esc(u.businessName || '')} · workspace ${esc(u.workspaceId)} · lead ${esc(u.leadId)}</p>
      <div><label>User type</label>
        <select name="user_type" id="admin-portal-type">
          <option value="owner" ${u.userType === 'owner' ? 'selected' : ''}>Owner</option>
          <option value="renter" ${u.userType === 'renter' ? 'selected' : ''}>Renter</option>
        </select></div>
      <div><label>Portal tabs this user can open</label>
        <div class="stack" style="gap:0.25rem">${checklist(tabs, 'tab_')}</div>
      </div>
      <div><label>Site modules this user can use</label>
        <div class="stack" style="gap:0.25rem">${checklist(modList, 'mod_')}</div>
        <p class="hint">Modules live inside the Modules tab — a module only becomes reachable when that tab is also on. Anything ticked differently from the type's defaults (Admin → Portal access) is saved as a per-user override; matching the type exactly clears the override.</p>
      </div>
      <div class="msg" id="admin-portal-access-msg"></div>
    </form>`,
    buttons: [
      { label: 'Cancel' },
      {
        label: 'Reset to type defaults',
        cls: 'ghost',
        onClick: async (modal) => {
          const msg = $('#admin-portal-access-msg', modal.el);
          try {
            const type = $('#admin-portal-type', modal.el).value;
            await api.adminUpdatePortalUser(u.id, { user_type: type, reset_overrides: true });
            setMsg(msg, 'Saved', 'ok');
            modal.close();
            toast('Portal access reset to type defaults', 'ok');
            pageAdmin('users');
          } catch (err) {
            setMsg(msg, errText(err), 'error');
            throw err;
          }
        },
      },
      {
        label: 'Save',
        cls: 'primary',
        onClick: async (modal) => {
          const msg = $('#admin-portal-access-msg', modal.el);
          const type = $('#admin-portal-type', modal.el).value;
          const diff = (list, prefix, defArr) => {
            const def = new Set(defArr || []);
            const out = {};
            list.forEach((t) => {
              const box = modal.el.querySelector(`[name="${prefix}${t.key}"]`);
              const on = !!(box && box.checked);
              if (on !== def.has(t.key)) out[t.key] = on;
            });
            return out;
          };
          try {
            await api.adminUpdatePortalUser(u.id, {
              user_type: type,
              nav_overrides: diff(tabs, 'tab_', defaults[type]),
              module_overrides: diff(modList, 'mod_', modDefaults[type]),
            });
            setMsg(msg, 'Saved', 'ok');
            modal.close();
            toast('Portal access updated', 'ok');
            pageAdmin('users');
          } catch (err) {
            setMsg(msg, errText(err), 'error');
            throw err;
          }
        },
      },
    ],
  });
  const paint = () => {
    const type = $('#admin-portal-type', m.el).value;
    const set = checkedFor(type);
    tabs.forEach((t) => {
      const box = m.el.querySelector(`[name="tab_${t.key}"]`);
      if (box) box.checked = set.has(t.key);
    });
    const mset = checkedModsFor(type);
    modList.forEach((t) => {
      const box = m.el.querySelector(`[name="mod_${t.key}"]`);
      if (box) box.checked = mset.has(t.key);
    });
  };
  paint();
  const typeSel = $('#admin-portal-type', m.el);
  if (typeSel) typeSel.addEventListener('change', paint);
  return m;
}

/* Batch 29 — Admin → Portal access: the default tab + module sets per
   portal user type. Stored as one platform setting; per-user overrides
   (Users tab → Access) still win per item. */
async function renderAdminPortalAccess(el) {
  const data = (await api.adminPortalAccessDefaults()).data || {};
  const defaults = data.defaults || { owner: { tabs: [], modules: [] }, renter: { tabs: [], modules: [] } };
  const factory = data.factory || defaults;
  const tabList = data.tabs || [];
  const modList = data.modules || [];
  const group = (type, label, blurb) => `
    <div class="panel" style="margin-top:1rem">
      <div class="panel-h"><h3>${esc(label)}</h3></div>
      <div class="panel-b">
        <p class="hint" style="margin-bottom:0.75rem">${esc(blurb)}</p>
        <div class="row" style="align-items:flex-start;gap:2rem;flex-wrap:wrap">
          <div><label>Tabs</label><div class="stack" style="gap:0.25rem">
            ${tabList
              .map(
                (t) =>
                  `<label style="font-weight:normal"><input type="checkbox" data-pa="${type}-tab-${esc(t.key)}" ${defaults[type].tabs.includes(t.key) ? 'checked' : ''} /> ${esc(t.label)}</label>`
              )
              .join('')}
          </div></div>
          <div><label>Modules</label><div class="stack" style="gap:0.25rem">
            ${modList
              .map(
                (t) =>
                  `<label style="font-weight:normal"><input type="checkbox" data-pa="${type}-mod-${esc(t.key)}" ${defaults[type].modules.includes(t.key) ? 'checked' : ''} /> ${esc(t.label)}</label>`
              )
              .join('')}
          </div></div>
        </div>
      </div>
    </div>`;
  el.innerHTML = `
    <div class="panel">
      <div class="panel-b">
        <p class="hint">Defaults apply to every portal user of that type, effective immediately (existing sessions included). Per-user overrides set under <strong>Users → Access</strong> win item-by-item over these defaults. Modules are only reachable while the <strong>Modules</strong> tab is on for that type/user. Clearing every box is allowed — that type then sees nothing until you change it back.</p>
        <div class="row actions" style="margin-top:0.75rem">
          <button class="btn" type="button" id="pa-save">Save defaults</button>
          <button class="btn ghost" type="button" id="pa-factory">Restore factory defaults</button>
        </div>
        <div class="msg" id="pa-msg"></div>
      </div>
    </div>
    ${group('owner', 'Owner defaults', 'Site owners. Factory: every tab, every module.')}
    ${group('renter', 'Renter defaults', 'Site tenants. Factory: Website / Modules / Rentals tabs, Call Tracking module only.')}`;
  const collect = (src) => {
    const pick = (type, prefix, list) =>
      list.filter((t) => {
        const box = el.querySelector(`[data-pa="${type}-${prefix}-${t.key}"]`);
        return src === 'dom' ? !!(box && box.checked) : (src[type][prefix === 'tab' ? 'tabs' : 'modules'] || []).includes(t.key);
      }).map((t) => t.key);
    return {
      owner: { tabs: pick('owner', 'tab', tabList), modules: pick('owner', 'mod', modList) },
      renter: { tabs: pick('renter', 'tab', tabList), modules: pick('renter', 'mod', modList) },
    };
  };
  $('#pa-save').onclick = () =>
    safeRun($('#pa-msg'), async () => {
      await api.adminUpdatePortalAccessDefaults(collect('dom'));
      $('#pa-msg').textContent = 'Defaults saved — they apply to portal users right away.';
      $('#pa-msg').className = 'msg ok';
    });
  $('#pa-factory').onclick = () => {
    if (!confirm('Restore the factory defaults for both types? Per-user overrides are not touched.')) return;
    safeRun($('#pa-msg'), async () => {
      await api.adminUpdatePortalAccessDefaults(factory);
      toast('Factory defaults restored', 'ok');
      pageAdmin('access');
    });
  };
}

async function renderAdminPortalUsersPanel(el) {
  const data = (await api.adminPortalUsers()).data || {};
  const users = data.users || [];
  const meta = {
    tabs: data.tabs || [],
    typeDefaults: data.typeDefaults || {},
    modules: data.modules || [],
    moduleTypeDefaults: data.moduleTypeDefaults || {},
  };
  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.style.marginTop = '1rem';
  panel.innerHTML = `
      <div class="panel-h"><h3>Client portal users</h3></div>
      <div class="panel-b">
        <p class="hint" style="margin-bottom:0.75rem">End customers who sign in at /portal. <strong>Owners</strong> see every tab. <strong>Renters</strong> (site tenants) see only Website, Modules and Rentals — enforced by the portal API, not just hidden here. Use Access to change a type or override individual tabs for one user.</p>
        <table><thead><tr><th>Email</th><th>Business</th><th>Type</th><th>Tabs</th><th>Status</th><th></th></tr></thead>
        <tbody>
          ${
            users
              .map(
                (u) => `<tr>
            <td>${esc(u.email)}</td><td>${esc(u.businessName || '')}</td>
            <td>${esc(u.userType)}${u.navOverrides || u.moduleOverrides ? ' <span class="hint">(custom)</span>' : ''}</td>
            <td>${esc((u.visibleTabs || []).length)} tabs · ${esc((u.visibleModules || []).length)} modules</td>
            <td>${esc(u.status || 'active')}${u.mfaEnabled ? ' · <span class="hint">2FA on</span>' : ''}</td>
            <td class="row actions"><button class="btn ghost small" data-portal-access="${u.id}">Access</button><button class="btn ghost small" data-portal-reset-mfa="${u.id}">Reset MFA</button><button class="btn ghost small" data-portal-delete="${u.id}">Delete</button></td>
          </tr>`
              )
              .join('') || '<tr><td colspan="6">No portal users yet</td></tr>'
          }
        </tbody></table>
      </div>`;
  el.appendChild(panel);
  panel.querySelectorAll('[data-portal-access]').forEach((b) => {
    b.onclick = () => {
      const u = users.find((x) => Number(x.id) === Number(b.dataset.portalAccess));
      if (u) openAdminPortalUserAccess(u, meta);
    };
  });
  // Batch 45 — super-admin portal user delete (row + MFA setup go;
  // the lead and its data stay — this removes sign-in access only).
  panel.querySelectorAll('[data-portal-delete]').forEach((b) => {
    b.onclick = async () => {
      const u = users.find((x) => Number(x.id) === Number(b.dataset.portalDelete));
      const who = u ? u.email : 'this client';
      if (!confirm(`Delete the portal sign-in for ${who}? They will no longer be able to log in. Their business, website and billing records are NOT deleted.`)) return;
      try {
        await api.adminDeletePortalUser(b.dataset.portalDelete);
        toast('Portal user deleted', 'ok');
        pageAdmin('users');
      } catch (err) {
        toast(errText(err), 'err');
      }
    };
  });
  panel.querySelectorAll('[data-portal-reset-mfa]').forEach((b) => {
    b.onclick = async () => {
      const u = users.find((x) => Number(x.id) === Number(b.dataset.portalResetMfa));
      const who = u ? u.email : 'this client';
      if (
        !confirm(
          `Reset two-factor authentication for ${who}? Their authenticator setup and recovery codes are cleared; they sign in with just their password until they turn it on again.`
        )
      )
        return;
      try {
        await api.adminResetPortalUserMfa(b.dataset.portalResetMfa);
        toast('Portal two-factor reset', 'ok');
        pageAdmin('users');
      } catch (err) {
        toast(errText(err), 'err');
      }
    };
  });
}

async function renderAdminWorkspaces(el) {
  const workspaces = asList((await api.adminWorkspaces()).data, ['workspaces']);
  const users = asList((await api.adminUsers({ limit: 200 })).data, ['users']);
  el.innerHTML = `
    <div class="panel">
      <div class="panel-h"><h3>Create workspace</h3></div>
      <div class="panel-b">
        <form id="admin-ws-form" class="row actions">
          <input name="name" placeholder="Workspace name" required style="min-width:200px" />
          <select name="ownerUserId"><option value="">No owner</option>
            ${users.map((u) => `<option value="${u.id}">${esc(u.email)}</option>`).join('')}
          </select>
          <button class="btn" type="submit">Create</button>
        </form>
        <div class="msg" id="admin-ws-msg"></div>
      </div>
    </div>
    <div class="panel" style="margin-top:1rem">
      <div class="panel-h"><h3>Workspaces</h3></div>
      <div class="panel-b">
        <table><thead><tr><th>Name</th><th>Slug</th><th>Members</th><th>Tokens</th><th></th></tr></thead>
        <tbody>
          ${
            workspaces
              .map(
                (w) => `<tr>
            <td>${esc(w.name)}</td><td class="mono">${esc(w.slug)}</td>
            <td>${esc(w.member_count)}</td><td>${esc(w.token_count)}</td>
            <td class="row actions">
              <button class="btn ghost small" data-ws-view="${w.id}">Members</button>
              <button class="btn danger small" data-ws-del="${w.id}">Delete</button>
            </td>
          </tr>`
              )
              .join('') || '<tr><td colspan="5">None</td></tr>'
          }
        </tbody></table>
        <div id="admin-ws-detail" style="margin-top:1rem"></div>
      </div>
    </div>`;

  guardSubmit($('#admin-ws-form'), async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = {
      name: fd.get('name'),
      ownerUserId: fd.get('ownerUserId') ? Number(fd.get('ownerUserId')) : undefined,
    };
    try {
      await api.adminCreateWorkspace(body);
      pageAdmin('workspaces');
    } catch (err) {
      $('#admin-ws-msg').textContent = errText(err);
      $('#admin-ws-msg').className = 'msg error';
    }
  });
  $$('[data-ws-del]').forEach(
    (b) =>
      (b.onclick = async () => {
        if (!confirm('Delete this workspace and all its MySQL data?')) return;
        await safeRun(b, async () => {
          await api.adminDeleteWorkspace(b.dataset.wsDel);
          toast('Workspace deleted', 'ok');
          pageAdmin('workspaces');
        });
      })
  );
  $$('[data-ws-view]').forEach(
    (b) =>
      (b.onclick = async () => {
        const d = (await api.adminWorkspace(b.dataset.wsView)).data;
        const detail = $('#admin-ws-detail');
        detail.innerHTML = `
      <h4>${esc(d.workspace.name)} members</h4>
      <div class="table-scroll"><table><thead><tr><th>Email</th><th>Role</th><th></th></tr></thead>
      <tbody>${
        (d.members || [])
          .map(
            (m) => `<tr>
        <td>${esc(m.email)}</td><td>${esc(m.role)}</td>
        <td><button class="btn ghost small" data-rm="${m.user_id}">Remove</button></td>
      </tr>`
          )
          .join('') || '<tr><td colspan="3">No members</td></tr>'
      }</tbody></table></div>
      <form id="admin-add-member" class="row actions" style="margin-top:0.75rem">
        <select name="userId" required>${users.map((u) => `<option value="${u.id}">${esc(u.email)}</option>`).join('')}</select>
        <select name="role"><option value="member">member</option><option value="admin">admin</option><option value="owner">owner</option></select>
        <button class="btn" type="submit">Add member</button>
      </form>`;
        $$('[data-rm]', detail).forEach(
          (btn) =>
            (btn.onclick = async () => {
              await api.adminRemoveMember(d.workspace.id, btn.dataset.rm);
              b.click();
            })
        );
        $('#admin-add-member').onsubmit = async (ev) => {
          ev.preventDefault();
          const f = new FormData(ev.target);
          await api.adminAddMember(d.workspace.id, Number(f.get('userId')), f.get('role'));
          b.click();
        };
      })
  );
}

async function renderAdminPayments(el) {
  const [payRes, refRes] = await Promise.all([api.adminPayments(), api.adminRefunds()]);
  const payments = asList(payRes.data, ['payments']);
  const refunds = asList(refRes.data, ['refunds']);
  el.innerHTML = `
    <div class="panel">
      <div class="panel-h"><h3>Payments</h3></div>
      <div class="panel-b">
        <table><thead><tr><th>When</th><th>User</th><th>Amount</th><th>Status</th><th>Invoice</th><th></th></tr></thead>
        <tbody>
          ${
            payments
              .map(
                (p) => `<tr>
            <td>${esc(fmtDate(p.created_at))}</td>
            <td>${esc(p.user_email || p.user_id || '—')}</td>
            <td>${esc((Number(p.amount_cents || 0) / 100).toFixed(2))} ${esc(String(p.currency || '').toUpperCase())}</td>
            <td>${esc(p.status)}</td>
            <td class="mono">${esc(p.stripe_invoice_id || '')}</td>
            <td>${p.status === 'succeeded' ? `<button class="btn ghost small" data-refund="${p.id}">Refund</button>` : ''}</td>
          </tr>`
              )
              .join('') || '<tr><td colspan="6">No payments yet</td></tr>'
          }
        </tbody></table>
      </div>
    </div>
    <div class="panel" style="margin-top:1rem">
      <div class="panel-h"><h3>Refunds</h3></div>
      <div class="panel-b">
        <table><thead><tr><th>When</th><th>User</th><th>Amount</th><th>Status</th><th>Refund ID</th></tr></thead>
        <tbody>
          ${
            refunds
              .map(
                (r) => `<tr>
            <td>${esc(fmtDate(r.created_at))}</td>
            <td>${esc(r.user_email || r.user_id || '—')}</td>
            <td>${esc((Number(r.amount_cents || 0) / 100).toFixed(2))} ${esc(String(r.currency || '').toUpperCase())}</td>
            <td>${esc(r.status)}</td>
            <td class="mono">${esc(r.stripe_refund_id || '')}</td>
          </tr>`
              )
              .join('') || '<tr><td colspan="5">No refunds yet</td></tr>'
          }
        </tbody></table>
      </div>
    </div>`;
  $$('[data-refund]').forEach(
    (b) =>
      (b.onclick = async () => {
        if (!confirm('Refund this payment in Stripe?')) return;
        try {
          await api.adminRefundPayment(b.dataset.refund, {});
          toast('Refund created', 'ok');
          pageAdmin('payments');
        } catch (err) {
          toast(errText(err), 'err');
        }
      })
  );
}

// Batch 24: the Update pricing panel owns these Stripe id settings — the
// generic billing form carries them as hidden inputs so a plain Save can
// never wipe them, and amounts (not ids) are the editable surface.
const PRICING_MANAGED_KEYS = new Set([
  'stripe.price_id_standard',
  'stripe.price_id_pro',
  'stripe.price_id_premium',
  'stripe.price_id',
  'stripe.price_id_credits',
  'stripe.product_id_standard',
  'stripe.product_id_pro',
  'stripe.product_id_premium',
  'stripe.product_id_credits',
]);

function pricingPriceLine(it) {
  if (!it.priceId) return 'No Stripe price yet — saving an amount creates one.';
  return `Current price: ${it.priceId}${it.priceActive === false ? ' (inactive)' : ''}${
    it.amountSource === 'label' ? ' · amount shown is from the saved label' : ''
  }`;
}

function pricingPanelHtml(state) {
  if (!state) {
    return `<div class="panel" style="margin-bottom:1rem">
      <div class="panel-h"><h3>Plan pricing</h3></div>
      <div class="panel-b"><p class="hint">Pricing state could not be loaded — reload the page to try again. The settings form below still works.</p></div>
    </div>`;
  }
  const modeLine = !state.configured
    ? 'Stripe is <strong>not configured</strong> — save a Stripe secret key in the form below first; amounts cannot be saved until then.'
    : state.mode === 'live'
      ? 'Stripe mode: <strong>LIVE</strong> — new prices are created on your live Stripe account.'
      : state.mode === 'test'
        ? 'Stripe mode: <strong>TEST</strong> — new prices are created in test mode, from the test key below.'
        : 'Stripe mode: <strong>could not be determined</strong> from the configured key.';
  const rows = (state.items || [])
    .map(
      (it) => `<div>
        <label>${esc(it.name)} <span class="hint">${it.kind === 'credits' ? 'one-time pack' : 'monthly subscription'} · USD</span></label>
        <input name="${esc(it.id)}" type="number" step="0.01" min="0" inputmode="decimal" placeholder="Not set"
          value="${it.amountUsd == null ? '' : esc(String(it.amountUsd))}" ${state.configured ? '' : 'disabled'} />
        <p class="hint mono" data-price-line="${esc(it.id)}">${esc(pricingPriceLine(it))}</p>
        ${it.envOverridden ? '<p class="hint">An environment variable also sets this price and takes precedence over the saved setting.</p>' : ''}
      </div>`
    )
    .join('');
  return `<div class="panel" style="margin-bottom:1rem">
    <div class="panel-h"><h3>Plan pricing</h3></div>
    <div class="panel-b" style="padding-bottom:0">
      <p class="hint">${modeLine}</p>
      <p class="hint">Edit the <strong>amounts</strong> — saving creates a new Stripe price for each changed amount, points checkout at it, and deactivates the old price. Unchanged amounts are left alone. <strong>Existing subscribers keep the price they signed up with; changes apply to new customers only.</strong></p>
      ${state.stripeError ? `<p class="hint">Stripe could not be reached to confirm current amounts (${esc(state.stripeError)}); amounts shown fall back to the saved labels.</p>` : ''}
    </div>
    <div class="panel-b">
      <form id="pricing-form" class="stack">
        ${rows}
        <div class="row actions"><button class="btn" type="submit" ${state.configured ? '' : 'disabled'}>Update pricing</button></div>
        <div class="msg" id="pricing-msg"></div>
      </form>
    </div>
  </div>`;
}

// Batch 57: the Package contents panel owns these JSON settings — the
// generic billing form carries them as hidden inputs so a plain Save can
// never wipe them, and the structured editor below is the surface.
const PLANS_CONTENTS_MANAGED_KEYS = new Set([
  'plans.contents_free',
  'plans.contents_standard',
  'plans.contents_pro',
  'plans.contents_premium',
]);

function pcEntitlementLabel(key) {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/^./, (c) => c.toUpperCase());
}

function pcFeatureRowHtml(value) {
  return `<div class="pc-feature row" style="gap:.4rem;margin-bottom:.4rem">
    <input data-feature value="${esc(value)}" maxlength="120" style="flex:1" />
    <button type="button" class="btn small" data-act="feat-up" title="Move up">↑</button>
    <button type="button" class="btn small" data-act="feat-down" title="Move down">↓</button>
    <button type="button" class="btn small" data-act="feat-del" title="Remove">✕</button>
  </div>`;
}

function pcPlanBlockHtml(p, cadenceOptions) {
  const c = p.contents || p.defaults;
  const defEnt = p.defaults.entitlements || {};
  const resEnt = c.entitlements || {};
  const checks = Object.keys(defEnt)
    .filter((k) => k !== 'supportCadence')
    .map(
      (k) => `<label style="display:inline-flex;align-items:center;gap:.35rem;margin:0 .9rem .4rem 0">
        <input type="checkbox" data-ent="${esc(k)}" ${resEnt[k] === true ? 'checked' : ''} /> ${esc(pcEntitlementLabel(k))}
      </label>`
    )
    .join('');
  const cadenceVal = resEnt.supportCadence != null ? resEnt.supportCadence : defEnt.supportCadence;
  const cadence = `<label>Support cadence
      <select data-field="supportCadence">
        ${cadenceOptions.map((v) => `<option value="${esc(v)}"${cadenceVal === v ? ' selected' : ''}>${esc(v)}</option>`).join('')}
      </select>
    </label>`;
  return `<fieldset class="pc-plan" data-plan="${esc(p.id)}" style="border:1px solid var(--line,#ddd);border-radius:12px;padding:1rem 1.1rem;margin:0 0 1rem">
    <div class="row" style="justify-content:space-between;align-items:baseline">
      <h4 style="margin:.1rem 0 .6rem">${esc(p.defaults.name)} <span class="hint mono">${esc(p.id)}</span></h4>
      <span class="hint" data-pc-badge>${p.hasOverride ? 'Customized — differs from the built-in defaults' : 'Using built-in defaults'}</span>
    </div>
    <div>
      <label>Plan name</label>
      <input data-field="name" value="${esc(c.name || '')}" maxlength="60" />
    </div>
    <div>
      <label>Tagline</label>
      <input data-field="tagline" value="${esc(c.tagline || '')}" maxlength="140" />
    </div>
    <div>
      <label>Feature bullets</label>
      <div class="pc-features">${(c.features || []).map((f) => pcFeatureRowHtml(f)).join('')}</div>
      <button type="button" class="btn small" data-act="add-feature">Add feature</button>
    </div>
    <div>
      <label>Entitlements</label>
      <div>${checks}</div>
      ${cadence}
    </div>
    <div class="row actions">
      <button type="button" class="btn small" data-act="reset-plan">Reset to defaults</button>
    </div>
  </fieldset>`;
}

function planContentsPanelHtml(state) {
  if (!state) {
    return `<div class="panel" style="margin-bottom:1rem">
      <div class="panel-h"><h3>Package contents</h3></div>
      <div class="panel-b"><p class="hint">Package contents could not be loaded — reload the page to try again. The settings form below still works.</p></div>
    </div>`;
  }
  const cadenceOptions = state.cadenceOptions && state.cadenceOptions.length ? state.cadenceOptions : ['none', 'monthly', 'weekly'];
  return `<div class="panel" style="margin-bottom:1rem">
    <div class="panel-h"><h3>Package contents</h3></div>
    <div class="panel-b" style="padding-bottom:0">
      <p class="hint">Edit what each package <strong>is</strong> — its name, tagline, feature bullets and entitlements. Amounts are set with <strong>Plan pricing</strong> above.</p>
      <p class="hint"><strong>Warning:</strong> contents and entitlement changes apply to <strong>EVERYONE on the plan immediately, including existing subscribers</strong> — unlike prices, which only affect new checkouts. Turning an entitlement off removes that capability from current customers on the plan as soon as you save. Saving a plan exactly as its built-in defaults clears its customization.</p>
    </div>
    <div class="panel-b">
      <form id="plan-contents-form" class="stack">
        ${(state.plans || []).map((p) => pcPlanBlockHtml(p, cadenceOptions)).join('')}
        <label class="hint" style="display:flex;gap:6px;align-items:flex-start"><input type="checkbox" id="plan-contents-email-subs" style="margin-top:2px" /> <span><strong>Email this change to current subscribers</strong> — off by default. When checked, owners on each plan you actually changed get one email with the plan's new feature list. Prices are never mentioned (existing subscribers keep their price).</span></label>
        <div class="row actions"><button class="btn" type="submit">Save package contents</button></div>
        <div class="msg" id="plan-contents-msg"></div>
      </form>
    </div>
  </div>`;
}

function pcFillBlock(block, planState, useDefaults) {
  const src = useDefaults ? planState.defaults : planState.contents || planState.defaults;
  block.querySelector('[data-field="name"]').value = src.name || '';
  block.querySelector('[data-field="tagline"]').value = src.tagline || '';
  const wrap = block.querySelector('.pc-features');
  wrap.innerHTML = (src.features || []).map((f) => pcFeatureRowHtml(f)).join('');
  const ent = src.entitlements || {};
  block.querySelectorAll('[data-ent]').forEach((cb) => {
    cb.checked = ent[cb.dataset.ent] === true;
  });
  const cad = block.querySelector('[data-field="supportCadence"]');
  if (cad && ent.supportCadence != null) cad.value = ent.supportCadence;
}

// Batch 59: Hostinger status + connection test panel for
// Admin → Settings → Hostinger. The four hostinger.* fields themselves
// render in the generic form below; this panel reports whether the
// feature is actually armed and pings the account on demand.
function hostingerPanelHtml(state) {
  if (!state) {
    return `<div class="panel" style="margin-bottom:1rem">
      <div class="panel-h"><h3>Hostinger connection</h3></div>
      <div class="panel-b"><p class="hint">Hostinger status could not be loaded — reload the page to try again. The settings form below still works.</p></div>
    </div>`;
  }
  const rows = [
    `<div class="kv"><span class="k">API token</span><span>${state.tokenSet ? 'Saved' : 'Not set — create one in hPanel → Profile → API, paste it below and Save'}</span></div>`,
    `<div class="kv"><span class="k">One-click deploys</span><span>${
      state.configured
        ? 'Armed — software-interest leads get a working “Deploy on Hostinger” button on their lead page'
        : 'Dormant — still missing: ' + esc((state.missing || []).join(', '))
    }</span></div>`,
    `<div class="kv"><span class="k">Default VPS plan</span><span class="mono">${esc(state.defaultPriceId || '—')}</span></div>`,
    `<div class="kv"><span class="k">Data center / template</span><span>${esc(state.dataCenterId != null ? String(state.dataCenterId) : '—')} / ${esc(state.templateId != null ? String(state.templateId) : '—')}</span></div>`,
  ].join('');
  return `<div class="panel" style="margin-bottom:1rem">
    <div class="panel-h"><h3>Hostinger connection</h3></div>
    <div class="panel-b" style="padding-bottom:0">
      <p class="hint">One-click deployments buy a real VPS on the connected Hostinger account (charged to its default payment method) and install a fresh, standard BitPype for a /landing software signup. The deploy button lives on the lead itself — open a software-interest lead and use the “Software deployment” section. Prices are always read live from the Hostinger catalog at click time; nothing is bought without the typed confirmation.</p>
    </div>
    <div class="panel-b">
      ${rows}
      <div class="row actions" style="margin-top:10px"><button class="btn" type="button" id="hostinger-test">Test connection</button></div>
      <div class="msg" id="hostinger-test-msg"></div>
    </div>
  </div>`;
}

// Batch 47: captcha status banner for Admin → Settings (General group,
// where the captcha.* keys live). Driven by the server's computed status —
// the point is that "captcha is on" is never assumed when it isn't.
function captchaStatusHtml(st) {
  if (!st || !st.state) return '';
  const map = {
    enforcing: ['ok', 'Turnstile captcha is configured and enforcing on public forms and sign-in.'],
    misconfigured: [
      'error',
      '⚠ Captcha is REQUIRED on this install but the Turnstile keys are not set — every public form submit and sign-in will fail (503) until both the site key and the secret key are saved below.',
    ],
    off: [
      'error',
      '⚠ Captcha is turned OFF below (captcha.enabled = 0). Public forms and sign-in are unprotected.',
    ],
    skipped: [
      '',
      'Captcha is not enforcing on this install: no Turnstile keys are saved. Skipping is only possible outside production or with CAPTCHA_OPTIONAL=1 — a production install without keys refuses to boot.',
    ],
  };
  const [cls, text] = map[st.state] || ['', 'Captcha status unknown.'];
  return `<div class="panel"><div class="panel-b"><div class="msg ${cls}" role="status">${esc(text)}</div></div></div>`;
}

async function renderAdminSettings(el, group) {
  const res = await api.adminSettings();
  const settings = res.data.settings || {};
  const defs = (res.data.defs || []).filter((d) => d.group === group);
  const captchaStatus = group === 'general' ? (res.data && res.data.captcha) || null : null;
  let pricingState = null;
  let planContentsState = null;
  let hostingerState = null;
  if (group === 'hostinger') {
    try {
      hostingerState = (await api.adminHostingerStatus()).data;
    } catch {
      hostingerState = null; /* panel renders a could-not-load note; form still works */
    }
  }
  if (group === 'billing') {
    try {
      pricingState = (await api.adminPricing()).data;
    } catch {
      pricingState = null; /* panel renders a could-not-load note; form still works */
    }
    try {
      planContentsState = (await api.adminPlanContents()).data;
    } catch {
      planContentsState = null; /* panel renders a could-not-load note; form still works */
    }
  }
  const title =
    {
      email: 'Email / SMTP',
      sms: 'SMS',
      keys: 'Default API keys',
      general: 'General',
      billing: 'Stripe & subscription',
      landing: 'Landing page',
      hostinger: 'Hostinger (one-click VPS deploys)',
    }[group] || group;
  const webhookHint =
    group === 'billing'
      ? `<p class="hint">Webhook endpoint: <span class="mono">${esc(window.location.origin)}/api/v1/billing/webhook</span><br/>
       Events: <span class="mono">checkout.session.completed, checkout.session.async_payment_succeeded, customer.subscription.*, invoice.paid, invoice.payment_failed, charge.refunded, charge.dispute.created, radar.early_fraud_warning.created</span><br/>
       Plan and credits-pack amounts are set with <strong>Update pricing</strong> above — it creates the Stripe Products and Prices, fills the <span class="mono">price_…</span>/<span class="mono">prod_…</span> ids below in automatically, and keeps the customer-facing price labels in sync. Edit the ids directly only for a manual setup. Set the credits pack size + per-image/content rates below. Leave keys empty until you paste real Dashboard values. Prefer a restricted API key (rk_…).</p>`
      : '<span class="hint">Defaults apply to new workspaces. Secrets are write-only.</span>';
  el.innerHTML = `
    ${captchaStatus ? captchaStatusHtml(captchaStatus) : ''}
    ${group === 'billing' ? pricingPanelHtml(pricingState) : ''}
    ${group === 'billing' ? planContentsPanelHtml(planContentsState) : ''}
    ${group === 'hostinger' ? hostingerPanelHtml(hostingerState) : ''}
    <div class="panel">
      <div class="panel-h"><h3>${esc(title)}</h3></div>
      <div class="panel-b" style="padding-bottom:0">${webhookHint}</div>
      <div class="panel-b">
        <form id="admin-set-form" class="stack">
          ${
            defs
              .map((d) => {
                const isSecret = d.secret;
                const val = settings[d.key] || '';
                if (group === 'billing' && (PRICING_MANAGED_KEYS.has(d.key) || PLANS_CONTENTS_MANAGED_KEYS.has(d.key))) {
                  // Owned by the panels above; carried hidden so this
                  // form's Save writes the same values back.
                  return `<input type="hidden" name="${esc(d.key)}" value="${esc(val)}" />`;
                }
                if (d.key === 'general.public_url') {
                  // Batch 56: the canonical public URL — validated server-side
                  // (platform.setPlatformSetting); the hint states the stakes.
                  return `<div>
              <label>${esc(d.label)} <span class="mono hint">${esc(d.key)}</span></label>
              <input name="${esc(d.key)}" type="url" value="${esc(val)}" placeholder="https://example.com" />
              <p class="hint">Links in emails and pages are built from this address. Claim, billing, portal and sign-in links all point here — change it only when the app itself moves to a new domain.</p>
            </div>`;
                }
                if (d.key === 'landing.video_embeds') {
                  // Batch 58: stored value is a canonical JSON array of
                  // YouTube IDs; show Ely one youtu.be link per line for
                  // editing. The server extracts IDs from whatever is
                  // pasted (embed code, link, or ID) at save time.
                  let display = '';
                  try {
                    const ids = JSON.parse(val || '[]');
                    display = Array.isArray(ids)
                      ? ids
                          .filter((x) => typeof x === 'string')
                          .map((id) => `https://youtu.be/${id}`)
                          .join('\n')
                      : val;
                  } catch {
                    display = val;
                  }
                  return `<div>
              <label>${esc(d.label)} <span class="mono hint">${esc(d.key)}</span></label>
              <textarea name="${esc(d.key)}" rows="6" placeholder="Paste a YouTube embed code or link">${esc(display)}</textarea>
              <p class="hint">Paste a YouTube embed code or link — one video per line; several are welcome. Only YouTube is accepted: the app stores just the video IDs and builds the embeds itself, so pasted page code is never kept. Videos appear in the videos section on /landing; leave this empty and that section does not show at all.</p>
            </div>`;
                }
                if (d.key === 'landing.thankyou_video') {
                  // Batch 70: stored value is a single canonical YouTube
                  // ID; show it as a youtu.be link for editing. The
                  // server extracts the ID from whatever is pasted
                  // (embed code, link, or ID) at save time.
                  const display = /^[A-Za-z0-9_-]{11}$/.test(val) ? `https://youtu.be/${val}` : val;
                  return `<div>
              <label>${esc(d.label)} <span class="mono hint">${esc(d.key)}</span></label>
              <input name="${esc(d.key)}" type="text" value="${esc(display)}" placeholder="Paste a YouTube embed code or link" />
              <p class="hint">One video for the /thankyou page visitors land on after the landing form — a walkthrough or demo works well here. Paste a YouTube embed code or link; only the video ID is stored and the app builds the player itself. Leave empty and no video shows on /thankyou.</p>
            </div>`;
                }
                if (d.key === 'landing.thankyou_calendly_url') {
                  // Batch 70: validated server-side — https on
                  // calendly.com only; anything else is rejected at
                  // save time with the reason shown to the admin.
                  return `<div>
              <label>${esc(d.label)} <span class="mono hint">${esc(d.key)}</span></label>
              <input name="${esc(d.key)}" type="url" value="${esc(val)}" placeholder="https://calendly.com/your-link" />
              <p class="hint">Your Calendly booking link. When set, the /thankyou page shows a prominent “Book your appointment” button that opens it. Must be an https://calendly.com link. Leave empty and no booking button shows.</p>
            </div>`;
                }
                if (d.key === 'registration.open') {
                  const on = String(val || '1') === '1';
                  return `<div>
              <label>${esc(d.label)} <span class="mono hint">${esc(d.key)}</span></label>
              <select name="${esc(d.key)}">
                <option value="1"${on ? ' selected' : ''}>On — Register tab shown, sign-ups allowed</option>
                <option value="0"${on ? '' : ' selected'}>Off — Register tab hidden, sign-ups rejected</option>
              </select>
              <p class="hint">Show or hide the Register tab on the sign-in screen and activate or deactivate new-account sign-ups. People with accounts can always log in. The client portal has no registration and is not affected.</p>
            </div>`;
                }
                return `<div>
              <label>${esc(d.label)} <span class="mono hint">${esc(d.key)}</span></label>
              ${
                isSecret
                  ? `<input name="${esc(d.key)}" type="password" placeholder="${val === '***' ? 'Set (currently configured)' : 'Not set'}" autocomplete="new-password" />`
                  : `<input name="${esc(d.key)}" value="${esc(val)}" />`
              }
            </div>`;
              })
              .join('') || '<p class="hint">No settings in this group</p>'
          }
          <div class="row actions"><button class="btn" type="submit">Save</button></div>
          <div class="msg" id="admin-set-msg"></div>
        </form>
      </div>
    </div>`;

  const hostingerTestBtn = $('#hostinger-test');
  if (hostingerTestBtn) {
    hostingerTestBtn.onclick = async () => {
      const msg = $('#hostinger-test-msg');
      hostingerTestBtn.disabled = true;
      setMsg(msg, 'Contacting Hostinger…', '');
      try {
        const res = (await api.adminHostingerTest()).data;
        setMsg(
          msg,
          `Connected — ${res.paymentMethods} payment method(s)${res.hasDefaultPaymentMethod ? ' (default available for purchases)' : ' — WARNING: no default payment method, purchases will fail'}, catalog: ${res.catalogItems} item(s) / ${res.catalogPrices} price(s).${res.configured ? '' : ' Deploys still dormant — missing: ' + (res.missing || []).join(', ')}`,
          'ok'
        );
      } catch (err) {
        setMsg(msg, errText(err), 'err');
      } finally {
        hostingerTestBtn.disabled = false;
      }
    };
  }

  const pricingForm = $('#pricing-form');
  if (pricingForm) {
    pricingForm.onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(pricingForm);
      const amounts = {};
      for (const it of (pricingState && pricingState.items) || []) {
        const v = fd.get(it.id);
        if (v != null && String(v).trim() !== '') amounts[it.id] = String(v).trim();
      }
      const msg = $('#pricing-msg');
      msg.textContent = 'Saving…';
      msg.className = 'msg';
      try {
        const d = (await api.adminPricingUpdate(amounts)).data || {};
        const parts = [];
        for (const u of d.updated || []) {
          parts.push(
            `${u.name} → $${u.amountUsd}${u.id === 'credits' ? '' : '/mo'} (new price ${u.newPriceId})`
          );
        }
        if ((d.unchanged || []).length) parts.push(`Unchanged: ${d.unchanged.join(', ')}`);
        if (!parts.length) parts.push('Nothing to change.');
        msg.textContent = parts.join(' · ');
        msg.className = 'msg ok';
        toast('Pricing saved', 'ok');
        for (const w of d.warnings || []) {
          const p = document.createElement('p');
          p.className = 'hint';
          p.textContent = w;
          msg.appendChild(p);
        }
        // Refresh the current-price lines + amount inputs from the server.
        try {
          const st = (await api.adminPricing()).data;
          pricingState = st;
          for (const it of st.items || []) {
            const line = pricingForm.querySelector(`[data-price-line="${it.id}"]`);
            if (line) line.textContent = pricingPriceLine(it);
            const inp = pricingForm.querySelector(`input[name="${it.id}"]`);
            if (inp && it.amountUsd != null) inp.value = it.amountUsd;
          }
        } catch {
          /* small print refreshes on next page load */
        }
      } catch (err) {
        msg.textContent = errText(err);
        msg.className = 'msg error';
      }
    };
  }

  const pcForm = $('#plan-contents-form');
  if (pcForm && planContentsState) {
    pcForm.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-act]');
      if (!btn) return;
      const act = btn.dataset.act;
      const block = btn.closest('.pc-plan');
      if (!block) return;
      if (act === 'add-feature') {
        const wrap = block.querySelector('.pc-features');
        wrap.insertAdjacentHTML('beforeend', pcFeatureRowHtml(''));
        const inp = wrap.lastElementChild && wrap.lastElementChild.querySelector('input');
        if (inp) inp.focus();
      } else if (act === 'feat-del') {
        const row = btn.closest('.pc-feature');
        if (row) row.remove();
      } else if (act === 'feat-up') {
        const row = btn.closest('.pc-feature');
        if (row && row.previousElementSibling) row.parentNode.insertBefore(row, row.previousElementSibling);
      } else if (act === 'feat-down') {
        const row = btn.closest('.pc-feature');
        if (row && row.nextElementSibling) row.parentNode.insertBefore(row.nextElementSibling, row);
      } else if (act === 'reset-plan') {
        const p = (planContentsState.plans || []).find((x) => x.id === block.dataset.plan);
        if (p) pcFillBlock(block, p, true);
        const msg = $('#plan-contents-msg');
        if (msg) {
          msg.textContent = `${block.dataset.plan}: defaults restored in the editor — Save to clear its customization.`;
          msg.className = 'msg';
        }
      }
    });
    pcForm.onsubmit = async (e) => {
      e.preventDefault();
      const msg = $('#plan-contents-msg');
      const contents = {};
      for (const block of pcForm.querySelectorAll('.pc-plan')) {
        const p = (planContentsState.plans || []).find((x) => x.id === block.dataset.plan);
        if (!p) continue;
        const features = [...block.querySelectorAll('[data-feature]')]
          .map((i) => i.value.trim())
          .filter((v) => v !== '');
        if (!features.length) {
          msg.textContent = `${p.id}: keep at least one feature bullet.`;
          msg.className = 'msg error';
          return;
        }
        const entitlements = {};
        const cad = block.querySelector('[data-field="supportCadence"]');
        for (const k of Object.keys(p.defaults.entitlements || {})) {
          if (k === 'supportCadence') {
            if (cad) entitlements.supportCadence = cad.value;
            continue;
          }
          const cb = block.querySelector(`[data-ent="${k}"]`);
          entitlements[k] = !!(cb && cb.checked);
        }
        const candidate = {
          name: block.querySelector('[data-field="name"]').value.trim(),
          tagline: block.querySelector('[data-field="tagline"]').value.trim(),
          features,
          entitlements,
        };
        // Saving a plan exactly as its defaults clears the override.
        contents[p.id] = JSON.stringify(candidate) === JSON.stringify(p.defaults) ? null : candidate;
      }
      msg.textContent = 'Saving…';
      msg.className = 'msg';
      const emailSubsEl = $('#plan-contents-email-subs');
      const emailSubscribers = !!(emailSubsEl && emailSubsEl.checked);
      try {
        const d = (await api.adminPlanContentsUpdate(contents, { emailSubscribers })).data || {};
        const parts = [];
        if ((d.updated || []).length) parts.push(`Updated: ${d.updated.join(', ')}`);
        if ((d.reset || []).length) parts.push(`Reset to defaults: ${d.reset.join(', ')}`);
        if ((d.unchanged || []).length) parts.push(`Unchanged: ${d.unchanged.join(', ')}`);
        if (d.notified) {
          const bits = Object.entries(d.notified).map(([p, n]) => `${p} ×${(n && n.sent) || 0}`);
          parts.push(bits.length ? `Subscribers emailed: ${bits.join(', ')}` : 'Subscribers emailed: none (no plans changed)');
        }
        if (!parts.length) parts.push('Nothing to change.');
        toast('Package contents saved', 'ok');
        // Re-render the whole settings view so badges, editor state and
        // the generic form's hidden carries all reflect the save.
        await renderAdminSettings(el, group);
        const msg2 = $('#plan-contents-msg');
        if (msg2) {
          msg2.textContent = parts.join(' · ');
          msg2.className = 'msg ok';
        }
      } catch (err) {
        msg.textContent = errText(err);
        msg.className = 'msg error';
      }
    };
  }

  $('#admin-set-form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const plain = {};
    const secrets = [];
    for (const d of defs) {
      const v = fd.get(d.key);
      if (d.secret) {
        if (v && String(v).trim()) secrets.push([d.key, String(v)]);
      } else {
        plain[d.key] = v == null ? '' : String(v);
      }
    }
    const msg = $('#admin-set-msg');
    try {
      if (Object.keys(plain).length) await api.adminSettingsSave(plain);
      for (const [k, v] of secrets) await api.adminSettingsSecret(k, v);
      msg.textContent = 'Saved';
      msg.className = 'msg ok';
      toast('Platform settings saved', 'ok');
    } catch (err) {
      msg.textContent = errText(err);
      msg.className = 'msg error';
    }
  };
}

async function renderAdminGbp(el) {
  // Batch 46 — Google Business Profile manager oversight: platform
  // Google settings (OAuth client, project number, API approval flag)
  // + the read-only roll-up of every lead's connection state and the
  // change sets held at "ready" by the pending approval.
  const res = await api.adminSettings();
  const settings = res.data.settings || {};
  const defs = (res.data.defs || []).filter((d) => d.group === 'gbp');
  let ov = null;
  try {
    ov = (await api.gbpOverview(gbpAdminPage)).data;
  } catch {
    ov = null; /* roll-up is best-effort; the settings form still works */
  }
  const cfg = (ov && ov.config) || {};
  const approval = cfg.approvalState || settings['gbp.api_approval_state'] || 'pending';
  const redirectUri = `${window.location.origin}/api/v1/gbp/oauth/callback`;
  const statusBadge = (s) =>
    ({
      connected: '<span class="badge ok">connected</span>',
      invited: '<span class="badge warn">invite sent</span>',
      disconnected: '<span class="badge">disconnected</span>',
      error: '<span class="badge err">error</span>',
      none: '<span class="badge">not connected</span>',
    })[s] || `<span class="badge">${esc(s)}</span>`;
  const rows = ov ? ov.rows || [] : [];
  el.innerHTML = `
    <div class="panel">
      <div class="panel-h"><h3>Google Business Profile manager</h3></div>
      <div class="panel-b">
        <p class="hint">Per-lead Google profile management (panel lives on each lead's page and in the client portal).
        The Business Profile API stays at quota 0 until Google approves the application — profile verified 60+ days,
        then the access form with the Cloud project number below (owner checklist: <span class="mono">gbp-google-clock-checklist-2026-10-28.md</span>).
        While approval is <strong>pending</strong>, change sets validate and wait at "ready"; nothing is sent to Google.</p>
        <p class="hint">API access: <strong>${esc(approval)}</strong>${cfg.approvedAt ? ` (approved ${esc(cfg.approvedAt)})` : ''}
        · OAuth client: <strong>${cfg.oauthReady ? 'configured' : 'not configured yet'}</strong>
        · Places prefill key: <strong>${cfg.placesConfigured ? 'configured' : 'not set'}</strong>
        · Change sets awaiting push: <strong>${ov ? ov.awaitingPushTotal || 0 : '—'}</strong></p>
        <p class="hint">When creating the Google OAuth client, register this redirect URI:<br/><span class="mono">${esc(redirectUri)}</span></p>
      </div>
    </div>
    <div class="panel">
      <div class="panel-h"><h3>Connections (this workspace)</h3></div>
      <div class="panel-b">
        ${
          ov
            ? `<table class="tbl"><thead><tr><th>Business</th><th>Location</th><th>Status</th><th>Place ID</th><th>Awaiting push</th></tr></thead>
               <tbody>${rows
                 .map(
                   (r) => `<tr>
                     <td><a href="#/leads/${esc(r.lead_id)}">${esc(r.business_name || 'Lead #' + r.lead_id)}</a></td>
                     <td>${esc([r.city, r.state].filter(Boolean).join(', '))}</td>
                     <td>${statusBadge(r.connection_status)}</td>
                     <td class="mono">${esc(r.place_id || '—')}</td>
                     <td>${r.awaiting_push || 0}</td>
                   </tr>`
                 )
                 .join('')}</tbody></table>
               <div class="inline" style="margin-top:10px">
                 <button class="btn small" data-gbp-page="prev" ${ov.page <= 1 ? 'disabled' : ''}>← Prev</button>
                 <span class="hint">Page ${ov.page} of ${ov.pages} · ${ov.total} leads</span>
                 <button class="btn small" data-gbp-page="next" ${ov.page >= ov.pages ? 'disabled' : ''}>Next →</button>
               </div>`
            : '<p class="hint">The connection roll-up could not be loaded.</p>'
        }
      </div>
    </div>
    <div class="panel">
      <div class="panel-h"><h3>Platform Google settings</h3></div>
      <div class="panel-b">
        <form id="gbp-set-form" class="stack">
          ${defs
            .map((d) => {
              const val = settings[d.key] || '';
              if (d.key === 'gbp.api_approval_state') {
                const cur = String(val || 'pending').toLowerCase() === 'approved' ? 'approved' : 'pending';
                return `<div>
              <label>${esc(d.label)} <span class="mono hint">${esc(d.key)}</span></label>
              <select name="${esc(d.key)}">
                <option value="pending"${cur === 'pending' ? ' selected' : ''}>Pending — change sets hold at "ready", nothing is sent</option>
                <option value="approved"${cur === 'approved' ? ' selected' : ''}>Approved — push path unlocked (Phase 2 wiring completes it)</option>
              </select>
              <p class="hint">Flip this only when Google's approval email lands. It is the single flag every Google Profile surface reads.</p>
            </div>`;
              }
              return `<div>
              <label>${esc(d.label)} <span class="mono hint">${esc(d.key)}</span></label>
              ${
                d.secret
                  ? `<input name="${esc(d.key)}" type="password" placeholder="${val === '***' ? 'Set (currently configured)' : 'Not set'}" autocomplete="new-password" />`
                  : `<input name="${esc(d.key)}" value="${esc(val)}" />`
              }
            </div>`;
            })
            .join('')}
          <div class="row actions"><button class="btn" type="submit">Save</button></div>
          <div class="msg" id="gbp-set-msg"></div>
        </form>
      </div>
    </div>`;

  el.querySelectorAll('[data-gbp-page]').forEach((b) => {
    b.onclick = () => {
      gbpAdminPage = Math.max(1, gbpAdminPage + (b.dataset.gbpPage === 'next' ? 1 : -1));
      renderAdminGbp(el);
    };
  });

  const form = $('#gbp-set-form', el);
  if (form) {
    form.onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const plain = {};
      const secrets = [];
      for (const d of defs) {
        const v = fd.get(d.key);
        if (d.secret) {
          if (v && String(v).trim()) secrets.push([d.key, String(v)]);
        } else {
          plain[d.key] = v == null ? '' : String(v);
        }
      }
      const msg = $('#gbp-set-msg', el);
      try {
        if (Object.keys(plain).length) await api.adminSettingsSave(plain);
        for (const [k, v] of secrets) await api.adminSettingsSecret(k, v);
        msg.textContent = 'Saved';
        msg.className = 'msg ok';
        toast('Google Business settings saved', 'ok');
        renderAdminGbp(el);
      } catch (err) {
        msg.textContent = errText(err);
        msg.className = 'msg error';
      }
    };
  }
}

async function renderAdminAdsense(el) {
  const res = await api.adminSettings();
  const settings = res.data.settings || {};
  const defs = (res.data.defs || []).filter((d) => d.group === 'adsense');
  let state = null;
  try {
    state = (await api.adminAdsenseState()).data;
  } catch {
    /* state line is best-effort */
  }
  const stateHtml = state
    ? state.state === 'active'
      ? `<p class="hint"><strong>● Active</strong> — ${esc(state.detail)}</p>`
      : `<p class="hint"><strong>○ Off</strong> — ${esc(state.detail)}</p>`
    : '';
  el.innerHTML = `
    <div class="panel">
      <div class="panel-h"><h3>Google AdSense</h3></div>
      <div class="panel-b" style="padding-bottom:0">
        <p class="hint">Ads appear <strong>only on sites whose customer is on the Free plan</strong> — on every page of the site. Standard, Pro and Premium sites never show ads. Changes take effect at each site's next publish or export. Each site's domain must also be approved in your Google AdSense account before Google serves ads.</p>
        ${stateHtml}
      </div>
      <div class="panel-b">
        <form id="admin-adsense-form" class="stack">
          ${
            defs
              .map((d) => {
                if (d.key === 'adsense.enabled') {
                  const on = String(settings[d.key] || '0') === '1';
                  return `<div>
              <label>${esc(d.label)} <span class="mono hint">${esc(d.key)}</span></label>
              <select name="${esc(d.key)}">
                <option value="0"${on ? '' : ' selected'}>Off</option>
                <option value="1"${on ? ' selected' : ''}>On</option>
              </select>
            </div>`;
                }
                if (d.key === 'adsense.publisher_id') {
                  return `<div>
              <label>${esc(d.label)} <span class="mono hint">${esc(d.key)}</span></label>
              <input name="${esc(d.key)}" value="${esc(settings[d.key] || '')}" placeholder="ca-pub-1234567890123456" autocomplete="off" />
            </div>`;
                }
                return `<div>
              <label>${esc(d.label)} <span class="mono hint">${esc(d.key)}</span></label>
              <input name="${esc(d.key)}" value="${esc(settings[d.key] || '')}" />
            </div>`;
              })
              .join('') || '<p class="hint">No settings in this group</p>'
          }
          <div class="row actions"><button class="btn" type="submit">Save</button></div>
          <div class="msg" id="admin-adsense-msg"></div>
        </form>
      </div>
    </div>`;

  $('#admin-adsense-form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const plain = {};
    for (const d of defs) {
      const v = fd.get(d.key);
      plain[d.key] = v == null ? '' : String(v);
    }
    const msg = $('#admin-adsense-msg');
    const pub = String(plain['adsense.publisher_id'] || '').trim();
    if (pub && !/^ca-pub-\d{10,24}$/.test(pub)) {
      msg.textContent = 'Publisher ID should look like ca-pub-1234567890123456 — check it and save again.';
      msg.className = 'msg error';
      return;
    }
    try {
      if (Object.keys(plain).length) await api.adminSettingsSave(plain);
      toast('AdSense settings saved', 'ok');
      await renderAdminAdsense(el);
    } catch (err) {
      msg.textContent = errText(err);
      msg.className = 'msg error';
    }
  };
}

let billingTab = 'subscription';

async function pageBilling(param, query) {
  const summary = (await api.billingSummary()).data;
  const checkoutFlag = (query && query.checkout) || '';
  const billTabs = [
    ['subscription', 'Plans'],
    ['credits', 'Credits'],
    ['payments', 'Payment history'],
    ['account', 'Delete account'],
  ];
  const requested = (param && String(param).split('/')[0]) || billingTab || 'subscription';
  billingTab = billTabs.some(([k]) => k === requested) ? requested : 'subscription';
  // Checkout return URLs land on #/billing?checkout=… — keep Plans/Credits tab.
  if (checkoutFlag === 'credits_success') billingTab = 'credits';
  else if (checkoutFlag) billingTab = 'subscription';

  const currentPlan = String(summary.plan || 'free');
  const plans = Array.isArray(summary.plans) ? summary.plans : [];
  const planCards = plans
    .map((p) => {
      const isCurrent = p.id === currentPlan;
      const canCheckout =
        p.checkout && p.priceConfigured && !summary.isSuperAdmin && (!summary.subscribed || currentPlan !== p.id);
      let cta = '';
      if (p.id === 'free') {
        cta = isCurrent
          ? '<span class="hint">Current plan</span>'
          : '<span class="hint">Downgrade via Manage billing after cancel</span>';
      } else if (isCurrent && summary.subscribed) {
        cta = '<span class="hint">Current plan</span>';
      } else if (!p.priceConfigured) {
        cta = '<span class="hint">Price not configured yet</span>';
      } else if (canCheckout) {
        cta = `<button class="btn" type="button" data-checkout-plan="${esc(p.id)}">Subscribe</button>`;
      } else {
        cta = '<span class="hint">Use Manage billing to change plans</span>';
      }
      return `<div class="plan-card${isCurrent ? ' is-current' : ''}${p.id === 'premium' ? ' is-featured' : ''}">
      <div class="plan-card-h">
        <h3>${esc(p.name)}</h3>
        <div class="plan-price">${esc(p.priceLabel || '')}</div>
      </div>
      <p class="hint plan-tagline">${esc(p.tagline || '')}</p>
      <ul class="plan-features">${(p.features || []).map((f) => `<li>${esc(f)}</li>`).join('')}</ul>
      <div class="plan-cta">${cta}</div>
    </div>`;
    })
    .join('');

  view.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Billing &amp; plans</h1>
        <p class="lede">${esc(summary.amountLabel || 'Bitpype plans')} · ${esc(summary.email)}</p>
      </div>
    </div>
    ${checkoutFlag === 'success' ? '<div class="alert ok"><strong>Payment received.</strong> Plan updates when Stripe confirms via webhook.</div>' : ''}
    ${checkoutFlag === 'credits_success' ? '<div class="alert ok"><strong>Credits payment received.</strong> Balance updates when Stripe confirms via webhook.</div>' : ''}
    ${checkoutFlag === 'cancel' ? '<div class="alert warn">Checkout canceled — no charge was made.</div>' : ''}
    ${summary.subscriptionStatus === 'past_due' ? '<div class="alert danger"><strong>Payment failed.</strong> Update your payment method in the customer portal to avoid losing paid features.</div>' : ''}
    <div class="stats-cards">
      <div class="stat-card"><div class="n" style="font-size:1.2rem">${esc(summary.planName || pretty(currentPlan))}</div><div class="l">Plan</div></div>
      <div class="stat-card"><div class="n" style="font-size:1.2rem">${esc(pretty(summary.subscriptionStatus || (currentPlan === 'free' ? 'free' : 'none')))}</div><div class="l">Status</div></div>
      <div class="stat-card"><div class="n" style="font-size:1.2rem">${esc(String((summary.credits && summary.credits.balance) != null ? summary.credits.balance : 0))}</div><div class="l">Credits</div></div>
      <div class="stat-card"><div class="n" style="font-size:1.05rem">${esc(fmtDate(summary.currentPeriodEnd) || '—')}</div><div class="l">Current period end</div></div>
    </div>
    <div class="tabs" id="billing-tabs" role="tablist" aria-label="Billing sections">${billTabs
      .map(
        ([k, l]) =>
          `<button type="button" role="tab" data-tab="${k}" class="${k === billingTab ? 'active' : ''}" aria-selected="${k === billingTab ? 'true' : 'false'}">${esc(l)}</button>`
      )
      .join('')}</div>
    <div class="panel" id="bill-panel-subscription"${billingTab === 'subscription' ? '' : ' hidden'}>
      <div class="panel-h"><h3>Choose a plan</h3>
        ${summary.hasCustomer ? '<button class="btn ghost" type="button" id="bill-portal">Manage billing</button>' : ''}
      </div>
      <div class="panel-b">
        <p class="hint">${
          summary.isSuperAdmin
            ? 'Super admins have Premium entitlements without a paid Stripe plan.'
            : 'Free includes website + inline edits. Upgrade for support cadence and included social images. Card and cancel live in the Stripe customer portal.'
        }</p>
        <div class="plan-grid">${planCards || '<p class="hint">Plans unavailable</p>'}</div>
        <div class="msg" id="bill-msg"></div>
      </div>
    </div>
    <div class="panel" id="bill-panel-credits"${billingTab === 'credits' ? '' : ' hidden'}>
      <div class="panel-h"><h3>Social credits</h3>
        ${
          summary.credits && summary.credits.priceConfigured && !summary.isSuperAdmin
            ? '<button class="btn" type="button" id="bill-buy-credits">Buy credits</button>'
            : ''
        }
      </div>
      <div class="panel-b">
        <p class="hint">Credits power branded social image ads and caption generation for the current workspace.
          Premium includes images (no credit charge for images). Set pack Price ID and rates in Admin → Stripe.</p>
        <div class="stats-cards" style="margin:12px 0">
          <div class="stat-card"><div class="n" style="font-size:1.2rem">${esc(String((summary.credits && summary.credits.balance) != null ? summary.credits.balance : 0))}</div><div class="l">Balance</div></div>
          <div class="stat-card"><div class="n" style="font-size:1.05rem">${esc((summary.credits && summary.credits.packLabel) || '—')}</div><div class="l">Pack</div></div>
          <div class="stat-card"><div class="n" style="font-size:1.2rem">${esc(String((summary.credits && summary.credits.perSocialImage) != null ? summary.credits.perSocialImage : 1))}</div><div class="l">Per image</div></div>
          <div class="stat-card"><div class="n" style="font-size:1.2rem">${esc(String((summary.credits && summary.credits.perSocialContent) != null ? summary.credits.perSocialContent : 1))}</div><div class="l">Per content gen</div></div>
        </div>
        ${
          !(summary.credits && summary.credits.priceConfigured)
            ? '<p class="msg warn">Credits checkout is not configured yet (missing <span class="mono">stripe.price_id_credits</span>).</p>'
            : ''
        }
        <div class="msg" id="bill-credits-msg"></div>
        <table><thead><tr><th>When</th><th>Change</th><th>Balance</th><th>Reason</th></tr></thead>
        <tbody>
          ${
            ((summary.credits && summary.credits.recent) || [])
              .map(
                (r) => `<tr>
            <td>${esc(fmtDate(r.created_at))}</td>
            <td>${Number(r.delta) > 0 ? '+' : ''}${esc(String(r.delta))}</td>
            <td>${esc(String(r.balance_after))}</td>
            <td>${esc(r.reason || '')}</td>
          </tr>`
              )
              .join('') || '<tr><td colspan="4">No credit activity yet</td></tr>'
          }
        </tbody></table>
      </div>
    </div>
    <div class="panel" id="bill-panel-payments"${billingTab === 'payments' ? '' : ' hidden'}>
      <div class="panel-h"><h3>Payment history</h3></div>
      <div class="panel-b">
        <table><thead><tr><th>When</th><th>Amount</th><th>Status</th><th>Description</th></tr></thead>
        <tbody>
          ${
            (summary.payments || [])
              .map(
                (p) => `<tr>
            <td>${esc(fmtDate(p.created_at))}</td>
            <td>${esc((Number(p.amount_cents || 0) / 100).toFixed(2))} ${esc(String(p.currency || '').toUpperCase())}</td>
            <td>${esc(p.status)}</td>
            <td>${esc(p.description || '')}</td>
          </tr>`
              )
              .join('') || '<tr><td colspan="4">No payments yet</td></tr>'
          }
        </tbody></table>
      </div>
    </div>
    <div class="panel" id="bill-panel-account"${billingTab === 'account' ? '' : ' hidden'}>
      <div class="panel-h"><h3>Delete account</h3></div>
      <div class="panel-b">
        <p class="hint">Cancels your Stripe subscription (if any), disables login, and removes workspace memberships. Payment records are kept for the platform.</p>
        <button class="btn danger" type="button" id="bill-delete">Delete my account</button>
      </div>
    </div>`;

  $('#billing-tabs').onclick = (e) => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    window.location.hash = '#/billing/' + b.dataset.tab;
  };

  const msg = $('#bill-msg');
  $$('[data-checkout-plan]').forEach((btn) => {
    btn.onclick = () =>
      safeRun(btn, async () => {
        const plan = btn.getAttribute('data-checkout-plan');
        const r = await api.billingCheckout(plan);
        if (r.data && r.data.url) window.location.href = r.data.url;
        else throw new Error('No checkout URL returned');
      });
  });
  const buyCredits = $('#bill-buy-credits');
  if (buyCredits) {
    buyCredits.onclick = () =>
      safeRun(buyCredits, async () => {
        const r = await api.billingCreditsCheckout(1);
        if (r.data && r.data.url) window.location.href = r.data.url;
        else throw new Error('No checkout URL returned');
      });
  }
  const portalBtn = $('#bill-portal');
  if (portalBtn) {
    portalBtn.onclick = () =>
      safeRun(portalBtn, async () => {
        const r = await api.billingPortal();
        if (r.data && r.data.url) window.location.href = r.data.url;
        else throw new Error('No portal URL returned');
      });
  }
  const delBtn = $('#bill-delete');
  if (delBtn) {
    delBtn.onclick = async () => {
      if (!confirm('Permanently delete your account? This cannot be undone.')) return;
      if (prompt('Type DELETE to confirm') !== 'DELETE') return;
      try {
        await api.deleteAccount();
        localStorage.removeItem('scout.workspaceId');
        toast('Account deleted', 'ok');
        renderAuth();
      } catch (err) {
        toast(errText(err), 'err');
      }
    };
  }
  const prices = summary.priceIds || {};
  if (msg && !summary.isSuperAdmin && !prices.standard && !prices.premium && !summary.priceId) {
    msg.textContent =
      'Paid plans are not configured yet (missing Stripe price IDs). Ask your admin — Free still works.';
    msg.className = 'msg warn';
  }
  requireSubscription = !!summary.requireSubscription || requireSubscription;
  userSubscribed = !!summary.subscribed;
  if (summary.productAccess != null) productAccess = !!summary.productAccess;
  else productAccess = true;
  subscriptionStatus = summary.subscriptionStatus || subscriptionStatus;
  updateBillingBanner();
}

async function renderAdminUpsellTips(el) {
  const data = (await api.adminUpsellTips()).data || {};
  const tips = Array.isArray(data.tips) ? data.tips : [];
  const features = Array.isArray(data.features) ? data.features : [];
  const featureOpts = features
    .map((f) => `<option value="${esc(f.key)}">${esc(f.label)} → ${esc(f.minPlan)}</option>`)
    .join('');

  el.innerHTML = `
    <div class="panel">
      <div class="panel-h"><h3>Did you know? tips</h3></div>
      <div class="panel-b">
        <p class="hint">Popups shown to Free (basic) portal users for features they don’t have. Each tip has its own frequency (hours between shows per user). A 6-hour global cooldown applies between any tip. Every popup includes an Upgrade button.</p>
        <div class="msg" id="admin-upsell-msg"></div>
        <table>
          <thead><tr>
            <th>On</th><th>Title / body</th><th>Feature</th><th>Every (hrs)</th><th>Weight</th><th>Shows</th><th></th>
          </tr></thead>
          <tbody id="admin-upsell-rows">
            ${
              tips
                .map(
                  (t) => `
              <tr data-tip-id="${t.id}">
                <td><input type="checkbox" data-tip-enabled ${t.enabled ? 'checked' : ''} title="Enabled" /></td>
                <td>
                  <input type="text" data-tip-title value="${esc(t.title)}" style="width:100%;margin-bottom:4px" />
                  <textarea data-tip-body rows="2" style="width:100%">${esc(t.body)}</textarea>
                </td>
                <td>
                  <select data-tip-feature style="max-width:11rem">
                    <option value="">(general)</option>
                    ${features
                      .map(
                        (f) =>
                          `<option value="${esc(f.key)}" ${t.feature_key === f.key ? 'selected' : ''}>${esc(f.label)}</option>`
                      )
                      .join('')}
                  </select>
                  <div class="hint" style="margin-top:4px">Plans: ${esc((t.target_plans || ['free']).join(', '))}</div>
                </td>
                <td><input type="number" data-tip-freq min="1" max="8760" value="${esc(t.frequency_hours)}" style="width:4.5rem" /></td>
                <td><input type="number" data-tip-weight min="1" max="100" value="${esc(t.weight)}" style="width:3.5rem" title="Relative how often among eligible tips" /></td>
                <td class="hint">${esc((t.stats && t.stats.shows) || 0)} <span title="unique viewers">/ ${esc((t.stats && t.stats.viewers) || 0)}</span></td>
                <td class="row actions" style="gap:4px">
                  <button type="button" class="btn soft small" data-tip-save>Save</button>
                  <button type="button" class="btn ghost small" data-tip-del>Delete</button>
                </td>
              </tr>`
                )
                .join('') || '<tr><td colspan="7" class="hint">No tips yet — add one below.</td></tr>'
            }
          </tbody>
        </table>
      </div>
    </div>
    <div class="panel" style="margin-top:1rem">
      <div class="panel-h"><h3>Add tip</h3></div>
      <div class="panel-b">
        <form id="admin-upsell-add" class="stack">
          <div><label>Title</label><input name="title" required value="Did you know?" maxlength="200" /></div>
          <div><label>Body</label><textarea name="body" required rows="3" maxlength="2000" placeholder="Short upsell copy…"></textarea></div>
          <div class="row" style="gap:12px;flex-wrap:wrap">
            <div><label>Feature (skip if they already have it)</label>
              <select name="feature_key"><option value="">(general)</option>${featureOpts}</select></div>
            <div><label>Frequency (hours)</label><input name="frequency_hours" type="number" min="1" value="72" /></div>
            <div><label>Weight</label><input name="weight" type="number" min="1" value="1" /></div>
            <div><label>CTA label</label><input name="cta_label" value="Upgrade" maxlength="80" /></div>
          </div>
          <input type="hidden" name="target_plans" value="free" />
          <button type="submit" class="btn primary">Add tip</button>
        </form>
      </div>
    </div>`;

  const msg = $('#admin-upsell-msg');
  const flash = (text, ok) => {
    if (!msg) return;
    msg.textContent = text || '';
    msg.className = ok ? 'msg ok' : text ? 'msg err' : 'msg';
  };

  const rows = $('#admin-upsell-rows');
  if (rows) {
    rows.onclick = (e) => {
      const tr = e.target.closest('tr[data-tip-id]');
      if (!tr) return;
      const id = Number(tr.getAttribute('data-tip-id'));
      if (e.target.closest('[data-tip-save]')) {
        safeRun(msg, async () => {
          await api.adminUpsellTipUpdate(id, {
            title: tr.querySelector('[data-tip-title]').value,
            body: tr.querySelector('[data-tip-body]').value,
            feature_key: tr.querySelector('[data-tip-feature]').value,
            enabled: tr.querySelector('[data-tip-enabled]').checked,
            frequency_hours: Number(tr.querySelector('[data-tip-freq]').value) || 72,
            weight: Number(tr.querySelector('[data-tip-weight]').value) || 1,
            target_plans: 'free',
          });
          flash('Saved.', true);
          await renderAdminUpsellTips(el);
        });
      }
      if (e.target.closest('[data-tip-del]')) {
        if (!confirm('Delete this tip?')) return;
        safeRun(msg, async () => {
          await api.adminUpsellTipDelete(id);
          flash('Deleted.', true);
          await renderAdminUpsellTips(el);
        });
      }
    };
  }

  const form = $('#admin-upsell-add');
  if (form) {
    form.onsubmit = (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      safeRun(msg, async () => {
        await api.adminUpsellTipCreate({
          title: fd.get('title'),
          body: fd.get('body'),
          feature_key: fd.get('feature_key'),
          frequency_hours: Number(fd.get('frequency_hours')) || 72,
          weight: Number(fd.get('weight')) || 1,
          cta_label: fd.get('cta_label') || 'Upgrade',
          target_plans: 'free',
          enabled: true,
        });
        flash('Tip added.', true);
        await renderAdminUpsellTips(el);
      });
    };
  }
}

async function renderAdminAudit(el) {
  const rows = asList((await api.adminAudit({ limit: 80 })).data, ['rows']);
  el.innerHTML = `
    <div class="panel">
      <div class="panel-h"><h3>Audit log</h3></div>
      <div class="panel-b">
        <table><thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Detail</th></tr></thead>
        <tbody>
          ${
            rows
              .map(
                (r) => `<tr>
            <td>${esc(fmtDate(r.at))}</td>
            <td>${esc(r.actor_email || r.actor_user_id || '—')}</td>
            <td>${esc(r.action)}</td>
            <td class="mono">${esc(r.detail || '')}</td>
          </tr>`
              )
              .join('') || '<tr><td colspan="4">No audit events yet</td></tr>'
          }
        </tbody></table>
      </div>
    </div>`;
}

/* ------------------------------------------------------------------ */
/* Admin area: Forms / LeadScout / Bookings / Shop / Modules / Courses / Analytics */
/* Read-only workspace-wide views over the same engines the portal and  */
/* MCP use.                                                             */
/* ------------------------------------------------------------------ */

function moneyCents(cents, currency) {
  return `${(Number(cents || 0) / 100).toFixed(2)} ${String(currency || 'USD').toUpperCase()}`;
}

// Batch 18: shared Business filter for the staff admin-area screens
// (Bookings, Forms, Shop, Memberships, Courses). Options derive from the
// rows the screen already loaded — every admin-area row carries
// lead_id/lead_name — and filtering runs client-side over that data, so
// all screens share one markup pattern and one behavior.
function bizFilterKey(row) {
  return row && row.lead_id != null ? String(row.lead_id) : '';
}
function bizFilterLabel(row) {
  return (row && row.lead_name) || (row && row.lead_id != null ? 'Lead #' + row.lead_id : 'Unknown business');
}
// Batch 51 — type-to-filter for business <select>s. With hundreds of
// leads a bare dropdown is unusable, so every business picker gets a
// search box that hides non-matching options as you type. The select
// itself stays the value source (existing change handlers untouched);
// the "All businesses" empty option is never hidden.
function bizOptionMatches(label, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return true;
  return String(label || '').toLowerCase().includes(q);
}
function filterSelectOptions(sel, query) {
  if (!sel) return;
  for (const opt of sel.options) {
    opt.hidden = opt.value === '' ? false : !bizOptionMatches(opt.textContent, query);
  }
}
function wireSelectSearch(input, sel) {
  if (!input || !sel) return;
  input.addEventListener('input', () => filterSelectOptions(sel, input.value));
}
function selectSearchHtml(id, label) {
  return `<div class="field"><label for="${id}">${esc(label || 'Search')}</label><input type="search" id="${id}" placeholder="Type to filter…" autocomplete="off" /></div>`;
}
// Batch 51 — shared clear-all flow for staff list surfaces: a confirm
// that names the scope, the type-to-confirm prompt (the Batch 45
// idiom — the API enforces confirm:'DELETE' too), then a
// deleted/skipped toast. Returns the result payload or null.
async function runClearAllFlow({ noun, scopeLabel, extra, call }) {
  const scope = scopeLabel || 'all businesses';
  if (
    !window.confirm(
      `Clear ALL ${noun} (${scope})?${extra ? ' ' + extra : ''} Protected items are skipped and reported. This cannot be undone.`
    )
  )
    return null;
  if (prompt('Type DELETE to confirm') !== 'DELETE') return null;
  try {
    const r = await call();
    const d = (r && r.data) || {};
    const skipped = d.skippedCount || 0;
    toast(
      `Cleared ${noun}: deleted ${d.deleted || 0}${skipped ? `, skipped ${skipped} (protected)` : ''}`,
      skipped ? '' : 'ok'
    );
    return d;
  } catch (e) {
    toast(errText(e), 'err');
    return null;
  }
}
// Batch 72 — clear-all for Recent Activity, shared by the Dashboard and
// Analytics panels (both render the same workspace activity_log). Same
// confirm idiom as the Batch 51 flow, but the count comes from the
// activity endpoint's total (the panels only show the newest rows) and
// nothing is ever "skipped" — the facade deletes the whole log, or the
// confirm gate refuses everything. On success the caller re-renders its
// page, which lands the panel on its "No activity yet." empty state.
async function runClearActivityFlow(refresh) {
  let total;
  try {
    const r = await api.activity({ limit: 1 });
    total = (r && r.data && r.data.total) || 0;
  } catch (e) {
    toast(errText(e), 'err');
    return;
  }
  if (!total) {
    toast('No activity to clear.');
    return;
  }
  if (
    !window.confirm(
      `Clear ALL recent activity (this workspace)? This removes ${total} ${total === 1 ? 'entry' : 'entries'} from the activity log. This cannot be undone.`
    )
  )
    return;
  if (prompt('Type DELETE to confirm') !== 'DELETE') return;
  try {
    const r = await api.adminClearAllActivity({ confirm: 'DELETE' });
    const d = (r && r.data) || {};
    toast(`Cleared activity: deleted ${d.deleted || 0}`, 'ok');
    if (refresh) refresh();
  } catch (e) {
    toast(errText(e), 'err');
  }
}
function businessFilterBarHtml(rows, id) {
  const seen = new Map();
  for (const r of rows || []) {
    const k = bizFilterKey(r);
    if (k && !seen.has(k)) seen.set(k, bizFilterLabel(r));
  }
  const options = [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  return `<div class="filter-bar"><div class="field"><label for="${id}">Business</label><select id="${id}"><option value="">All businesses</option>${options
    .map(([value, label]) => `<option value="${esc(value)}">${esc(label)}</option>`)
    .join('')}</select></div>${selectSearchHtml(id + '-search', 'Search businesses')}</div>`;
}
function applyBusinessFilter(rows, value) {
  if (!value) return rows;
  return rows.filter((r) => bizFilterKey(r) === value);
}
function wireBusinessFilter(id, onChange) {
  const sel = view.querySelector('#' + id);
  if (sel) sel.onchange = () => onChange(sel.value);
  const search = view.querySelector('#' + id + '-search');
  if (search && sel) wireSelectSearch(search, sel);
}

function payloadTableHtml(payload) {
  if (payload == null) return '<p class="hint">No readable payload.</p>';
  if (typeof payload !== 'object' || Array.isArray(payload)) return `<p>${esc(String(payload))}</p>`;
  const entries = Object.entries(payload);
  if (!entries.length) return '<p class="hint">Empty submission.</p>';
  return `<div class="table-scroll"><table><tbody>${entries
    .map(
      ([k, v]) =>
        `<tr><td style="white-space:nowrap"><strong>${esc(k)}</strong></td><td>${esc(
          v && typeof v === 'object' ? JSON.stringify(v) : String(v == null ? '' : v)
        )}</td></tr>`
    )
    .join('')}</tbody></table></div>`;
}

async function pageForms(param) {
  // Batch 78: #/forms/<id> is the submissions page (was a slide-over drawer).
  if (param) return pageFormSubmissions(Number(param));
  let res;
  try {
    res = await withLoadTimeout(api.adminForms());
  } catch (e) {
    view.innerHTML = loadErrorCardHtml(errText(e));
    wirePageRetry(() => pageForms());
    return;
  }
  const forms = asList(res.data, ['forms']);
  const formRows = (list, filtered) =>
    list
      .map(
        (f) => `<tr>
        <td>${esc(f.name || f.title || 'Form')}<div class="hint">${esc(f.title || '')}</div></td>
        <td>${esc(f.lead_name || 'Lead #' + f.lead_id)}</td>
        <td>${esc(f.form_kind || '—')}</td>
        <td>${f.published ? '<span class="badge ok">published</span>' : esc(f.status || '—')}</td>
        <td>${esc(f.submission_count || 0)}</td>
        <td>${f.last_submission_at ? esc(fmtDate(f.last_submission_at)) : '—'}</td>
        <td class="actions"><button class="btn small" data-act="subs" data-id="${f.id}">Submissions</button></td></tr>`
      )
      .join('') ||
    `<tr><td colspan="7" class="empty">${
      filtered
        ? 'No forms for this business.'
        : 'No forms yet. Forms are created per site from the Design flow or MCP forms.create.'
    }</td></tr>`;
  const renderForms = (list, filtered) => {
    view.querySelector('#fm-body').innerHTML = formRows(list, filtered);
    view.querySelectorAll('[data-act="subs"]').forEach(
      (b) =>
        (b.onclick = () => {
          window.location.hash = '#/forms/' + b.dataset.id;
        })
    );
  };
  view.innerHTML = `
    <div class="page-head"><div><h1>Forms</h1><p class="lede">Every BitPype form across your sites, with submission counts. Open a form to read its submissions.</p></div>
    <div class="page-actions"><button class="btn danger" data-act="clear-all" ${forms.length ? '' : 'disabled'}>Clear all…</button> <button class="btn" data-act="refresh">Refresh</button></div></div>
    ${businessFilterBarHtml(forms, 'fm-biz')}
    <div class="table-wrap"><table>
      <thead><tr><th>Form</th><th>Business</th><th>Kind</th><th>Status</th><th>Submissions</th><th>Last submission</th><th></th></tr></thead>
      <tbody id="fm-body"></tbody>
    </table></div>`;
  renderForms(forms, false);
  view.querySelector('[data-act="refresh"]').onclick = () => pageForms();
  let fmBiz = '';
  wireBusinessFilter('fm-biz', (v) => {
    fmBiz = v;
    renderForms(applyBusinessFilter(forms, v), !!v);
  });
  const fmClear = view.querySelector('[data-act="clear-all"]');
  if (fmClear) {
    fmClear.onclick = async () => {
      const sel = view.querySelector('#fm-biz');
      const scopeLabel = fmBiz ? sel.options[sel.selectedIndex].textContent : 'all businesses';
      const out = await runClearAllFlow({
        noun: 'forms',
        scopeLabel,
        extra: 'Deleting a form deletes its submissions too. The last remaining form for a business is kept (it cannot be deleted) and will be skipped.',
        call: () => api.adminClearAllForms({ leadId: fmBiz ? Number(fmBiz) : null, confirm: 'DELETE' }),
      });
      if (out) pageForms();
    };
  }
}

/* Batch 78 — form submissions are a full routed page (#/forms/<id>),
   not a slide-over drawer. `d` is the page handle ({ body, title }). */
async function pageFormSubmissions(formId) {
  view.innerHTML = `
    <div class="page-head"><div><h1 id="fs-title">Submissions</h1><p class="lede">Submissions for this form, newest first — 50 at a time, delete spam or test entries right here.</p></div>
    <div class="page-actions"><button class="btn" id="fs-back">← Back to forms</button></div></div>
    <div id="fs-body"><p class="hint">Loading…</p></div>`;
  const fsBack = $('#fs-back', view);
  if (fsBack)
    fsBack.onclick = () => {
      window.location.hash = '#/forms';
    };
  const d = { body: $('#fs-body', view), title: $('#fs-title', view) };
  // Batch 45: submissions can be deleted (spam/test) one by one or in
  // bulk, and the list pages with the engine's offset (50 at a time).
  const shown = [];
  const cardHtml = (s) =>
    `<div class="card" data-sub-card="${s.id}"><div class="panel-h"><h3>${esc(fmtDate(s.created_at))}</h3><span><span class="badge ${
      s.encrypted ? 'info' : ''
    }">${esc(s.routing || 'email')}</span> <button class="btn small danger" data-sub-del="${s.id}">Delete</button></span></div>${payloadTableHtml(s.payload)}</div>`;
  const wireCards = () => {
    d.body.querySelectorAll('[data-sub-del]').forEach((b) => {
      b.onclick = async () => {
        const subId = Number(b.dataset.subDel);
        if (!window.confirm('Delete this submission permanently?')) return;
        try {
          await api.adminDeleteFormSubmission(formId, subId);
          const card = d.body.querySelector(`[data-sub-card="${subId}"]`);
          if (card) card.remove();
          const i = shown.indexOf(subId);
          if (i >= 0) shown.splice(i, 1);
          toast('Submission deleted', 'ok');
        } catch (e) {
          toast(errText(e), 'err');
        }
      };
    });
  };
  try {
    const res = await withLoadTimeout(api.adminFormSubmissions(formId, { limit: 50 }));
    const data = res.data || {};
    const subs = asList(data, ['submissions']);
    subs.forEach((s) => shown.push(s.id));
    d.title.textContent = `${data.form ? data.form.name || data.form.title : 'Form'} — ${data.lead_name || ''}`;
    d.body.innerHTML =
      (subs.length
        ? subs.map(cardHtml).join('')
        : '<p class="hint">No submissions for this form yet.</p>') +
      `<div class="inline" style="gap:8px;margin-top:10px"><button class="btn" id="sub-more">Load more</button><button class="btn danger" id="sub-del-shown">Delete shown</button></div>`;
    wireCards();
    const more = d.body.querySelector('#sub-more');
    if (more) {
      if (subs.length < 50) more.style.display = 'none';
      more.onclick = async () => {
        more.disabled = true;
        try {
          const r2 = await withLoadTimeout(api.adminFormSubmissions(formId, { limit: 50, offset: shown.length }));
          const extra = asList(r2.data || {}, ['submissions']);
          extra.forEach((s) => shown.push(s.id));
          more.insertAdjacentHTML('beforebegin', extra.map(cardHtml).join(''));
          wireCards();
          if (extra.length < 50) more.style.display = 'none';
        } catch (e) {
          toast(errText(e), 'err');
        } finally {
          more.disabled = false;
        }
      };
    }
    const delShown = d.body.querySelector('#sub-del-shown');
    if (delShown) {
      delShown.onclick = async () => {
        if (!shown.length) return;
        if (!window.confirm(`Delete the ${shown.length} shown submission(s) permanently?`)) return;
        try {
          const r = await api.adminDeleteFormSubmissionsBulk(formId, shown.slice());
          toast(`Deleted ${(r.data && r.data.deletedCount) || 0} submission(s)`, 'ok');
          pageFormSubmissions(formId);
        } catch (e) {
          toast(errText(e), 'err');
        }
      };
    }
  } catch (e) {
    d.body.innerHTML = `<p class="error">${esc(errText(e))}</p>`;
  }
}

const leadScoutState = { q: '', biz: '' };

async function pageLeadScout(param) {
  // Batch 78: #/leadscout/<id> is the contact page (was a slide-over drawer).
  if (param) return pageLeadScoutContact(Number(param));
  let res;
  try {
    res = await withLoadTimeout(api.adminLeadScoutContacts({ q: leadScoutState.q, limit: 100 }));
  } catch (e) {
    view.innerHTML = loadErrorCardHtml(errText(e));
    wirePageRetry(() => pageLeadScout());
    return;
  }
  const d = res.data || {};
  let contacts = asList(d, ['contacts']);
  const health = d.health;
  // Businesses that have contacts, from the loaded contacts' event leads
  // (attached by the admin-area route — contacts themselves are deduped
  // workspace-wide and can span businesses).
  const bizSeen = new Map();
  for (const c of contacts)
    for (const b of c.businesses || []) {
      const k = String(b.lead_id);
      if (!bizSeen.has(k)) bizSeen.set(k, b.lead_name || 'Lead #' + b.lead_id);
    }
  const bizOptions = [...bizSeen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  if (leadScoutState.biz && !bizSeen.has(leadScoutState.biz)) leadScoutState.biz = '';
  const visibleContacts = () =>
    leadScoutState.biz
      ? contacts.filter((c) => (c.businesses || []).some((b) => String(b.lead_id) === leadScoutState.biz))
      : contacts;
  const contactRows = (list) =>
    list
      .map((c) => {
        const bizNames = (c.businesses || []).map((b) => b.lead_name || 'Lead #' + b.lead_id).join(' · ');
        return `<tr>
        <td>${esc(c.name || '—')}${bizNames ? `<div class="hint">${esc(bizNames)}</div>` : ''}</td>
        <td>${esc(c.email || '—')}</td>
        <td>${esc(c.phone || '—')}</td>
        <td>${esc(c.event_count || 0)}</td>
        <td>${c.last_event_at ? esc(fmtDate(c.last_event_at)) : c.updated_at ? esc(fmtDate(c.updated_at)) : '—'}</td>
        <td>${c.created_at ? esc(fmtDate(c.created_at)) : '—'}</td>
        <td class="actions"><button class="btn small" data-act="view" data-id="${c.id}">View</button> <button class="btn small danger" data-act="del-contact" data-id="${c.id}">Delete</button></td></tr>`;
      })
      .join('') ||
    `<tr><td colspan="7" class="empty">${
      leadScoutState.biz
        ? 'No contacts for this business.'
        : 'No LeadScout contacts yet. Contacts appear when a site form is submitted or a booking is made.'
    }</td></tr>`;
  const renderContacts = () => {
    view.querySelector('#ls-body').innerHTML = contactRows(visibleContacts());
    view.querySelectorAll('[data-act="view"]').forEach(
      (b) =>
        (b.onclick = () => {
          window.location.hash = '#/leadscout/' + b.dataset.id;
        })
    );
    view.querySelectorAll('[data-act="del-contact"]').forEach((b) => (b.onclick = () => deleteLeadScoutContact(Number(b.dataset.id))));
    const more = view.querySelector('#ls-more');
    if (more) more.style.display = contacts.length && contacts.length % 100 === 0 ? '' : 'none';
  };
  // Batch 45 — delete a contact (engine refuses rental-charged contacts).
  async function deleteLeadScoutContact(id) {
    if (!window.confirm('Delete this LeadScout contact and its history? This cannot be undone.')) return;
    try {
      await api.adminDeleteLeadScoutContact(id);
      contacts = contacts.filter((c) => Number(c.id) !== id);
      renderContacts();
      toast('Contact deleted', 'ok');
    } catch (e) {
      toast(errText(e), 'err');
    }
  }
  // Batch 45 — page through contacts with the engine's existing offset.
  async function loadMoreContacts(btn) {
    btn.disabled = true;
    try {
      const more = await withLoadTimeout(
        api.adminLeadScoutContacts({ q: leadScoutState.q, limit: 100, offset: contacts.length })
      );
      const extra = asList(more.data || {}, ['contacts']);
      for (const c of extra) c.businesses = c.businesses || [];
      contacts = contacts.concat(extra);
      renderContacts();
    } catch (e) {
      toast(errText(e), 'err');
    } finally {
      btn.disabled = false;
    }
  }
  view.innerHTML = `
    <div class="page-head"><div><h1>LeadScout</h1><p class="lede">Deduped contacts captured from site forms and bookings — the same store the client portal reads. Not the outreach CRM (that's Leads).</p></div>
    <div class="page-actions"><button class="btn danger" data-act="clear-all" ${contacts.length ? '' : 'disabled'}>Clear all…</button> <button class="btn" data-act="clear-resolved">Clear resolved failures</button> <button class="btn" data-act="refresh">Refresh</button></div></div>
    ${
      health && health.open_failures
        ? `<div class="alert warn"><strong>Capture health:</strong> ${esc(health.open_failures)} open capture failure(s) — some submissions or bookings may not have been recorded.</div>`
        : ''
    }
    ${warningsBannerHtml(d.warnings)}
    <form id="ls-search"><div class="row"><div class="field"><label>Search contacts</label><input name="q" value="${esc(
      leadScoutState.q
    )}" placeholder="Name, email, or phone" /></div><div class="field"><label>Search businesses</label><input type="search" id="ls-biz-search" placeholder="Type to filter…" autocomplete="off" /></div><div class="field"><label>Business</label><select id="ls-biz"><option value="">All businesses</option>${bizOptions
      .map(([value, label]) => `<option value="${esc(value)}"${value === leadScoutState.biz ? ' selected' : ''}>${esc(label)}</option>`)
      .join('')}</select></div><div class="field"><label>&nbsp;</label><button class="btn primary" type="submit">Search</button></div></div></form>
    <div class="table-wrap"><table>
      <thead><tr><th>Contact</th><th>Email</th><th>Phone</th><th>Events</th><th>Last activity</th><th>First seen</th><th></th></tr></thead>
      <tbody id="ls-body"></tbody>
    </table></div>
    <div class="pagination"><button class="btn" id="ls-more" style="display:none">Load more contacts</button></div>`;
  renderContacts();
  view.querySelector('[data-act="refresh"]').onclick = () => pageLeadScout();
  view.querySelector('[data-act="clear-resolved"]').onclick = async (e) => {
    try {
      const r = await api.adminClearLeadScoutResolved();
      toast(`Cleared ${(r.data && r.data.cleared) || 0} resolved failure(s)`, 'ok');
    } catch (err) {
      toast(errText(err), 'err');
    }
  };
  const lsMore = view.querySelector('#ls-more');
  if (lsMore) lsMore.onclick = () => loadMoreContacts(lsMore);
  $('#ls-search').onsubmit = (e) => {
    e.preventDefault();
    leadScoutState.q = new FormData(e.target).get('q') || '';
    pageLeadScout();
  };
  view.querySelector('#ls-biz').onchange = (e) => {
    leadScoutState.biz = e.target.value || '';
    renderContacts();
  };
  wireSelectSearch(view.querySelector('#ls-biz-search'), view.querySelector('#ls-biz'));
  const lsClear = view.querySelector('[data-act="clear-all"]');
  if (lsClear) {
    lsClear.onclick = async () => {
      const sel = view.querySelector('#ls-biz');
      const scopeLabel = leadScoutState.biz ? sel.options[sel.selectedIndex].textContent : 'all businesses';
      const out = await runClearAllFlow({
        noun: 'LeadScout contacts',
        scopeLabel,
        extra:
          'Contacts are deduped across businesses, so a contact in scope is removed entirely. Contacts with rental-charged activity cannot be deleted and will be skipped.',
        call: () =>
          api.adminClearAllLeadScoutContacts({
            leadId: leadScoutState.biz ? Number(leadScoutState.biz) : null,
            confirm: 'DELETE',
          }),
      });
      if (out) pageLeadScout();
    };
  }
}

/* Batch 78 — the LeadScout contact detail is a full routed page
   (#/leadscout/<id>), not a slide-over drawer. `d` is the page
   handle ({ body, title }). */
async function pageLeadScoutContact(id) {
  view.innerHTML = `
    <div class="page-head"><div><h1 id="lc-title">Contact</h1><p class="lede">LeadScout contact detail and full event history.</p></div>
    <div class="page-actions"><button class="btn" id="lc-back">← Back to LeadScout</button></div></div>
    <div id="lc-body"><p class="hint">Loading…</p></div>`;
  const lcBack = $('#lc-back', view);
  if (lcBack)
    lcBack.onclick = () => {
      window.location.hash = '#/leadscout';
    };
  const d = { body: $('#lc-body', view), title: $('#lc-title', view) };
  try {
    const res = await withLoadTimeout(api.adminLeadScoutContact(id));
    const data = res.data || {};
    const c = data.contact || {};
    const events = asList(data, ['events']);
    d.title.textContent = c.name || c.email || 'Contact';
    d.body.innerHTML = `
      <div class="card"><h3>Contact</h3>
        <p><strong>${esc(c.name || '—')}</strong><br>${esc(c.email || '')}${c.phone ? '<br>' + esc(c.phone) : ''}</p>
        <p class="hint">First seen ${c.created_at ? esc(fmtDate(c.created_at)) : '—'} · Last activity ${
          c.last_event_at ? esc(fmtDate(c.last_event_at)) : '—'
        } · ${esc(c.event_count != null ? c.event_count : events.length)} event(s)</p></div>
      <div class="card"><h3>History</h3>
      ${
        events.length
          ? events
              .map(
                (e) =>
                  `<div class="panel-h"><div><strong>${esc(e.kind)}</strong> ${esc(e.source_label || '')}<div class="hint">${esc(
                    e.page_slug || ''
                  )}${e.service_name ? ' · ' + esc(e.service_name) : ''}${e.status ? ' · ' + esc(e.status) : ''}</div></div><span class="timestamp">${esc(
                    fmtDate(e.created_at)
                  )}</span></div>${e.payload ? payloadTableHtml(e.payload) : ''}`
              )
              .join('')
          : '<p class="hint">No events recorded.</p>'
      }
      </div>`;
  } catch (e) {
    d.body.innerHTML = `<p class="error">${esc(errText(e))}</p>`;
  }
}

async function pageBookings() {
  let res;
  try {
    res = await withLoadTimeout(api.adminBookings());
  } catch (e) {
    view.innerHTML = loadErrorCardHtml(errText(e));
    wirePageRetry(() => pageBookings());
    return;
  }
  const d = res.data || {};
  const appointments = asList(d, ['appointments']);
  const services = asList(d, ['services']);
  const apptRows = (list, filtered) =>
    list
      .map(
        (b) => `<tr>
        <td>${esc(fmtDate(b.starts_at))}<div class="hint">to ${esc(fmtDate(b.ends_at))}</div></td>
        <td>${esc(b.customer_name || '—')}<div class="hint">${esc(b.customer_email || '')}${b.customer_phone ? ' · ' + esc(b.customer_phone) : ''}</div></td>
        <td>${esc(b.service_name || '—')}</td>
        <td>${esc(b.lead_name || 'Lead #' + b.lead_id)}</td>
        <td><span class="badge ${b.status === 'confirmed' ? 'ok' : b.status === 'cancelled' ? 'danger' : 'warn'}">${esc(b.status || 'pending')}</span></td></tr>`
      )
      .join('') ||
    `<tr><td colspan="5" class="empty">${filtered ? 'No appointments for this business.' : 'No appointments yet.'}</td></tr>`;
  const svcRows = (list, filtered) =>
    list
      .map(
        (s) => `<tr>
        <td>${esc(s.name || '—')}<div class="hint">${esc(s.description || '')}</div></td>
        <td>${esc(s.lead_name || 'Lead #' + s.lead_id)}</td>
        <td>${esc(s.duration_minutes || 30)} min</td>
        <td>${s.price_cents ? esc(moneyCents(s.price_cents, s.currency)) : '—'}</td>
        <td>${esc(s.status || 'draft')}</td>
        <td>${esc(s.booking_count || 0)}</td>
        <td class="actions"><button class="btn small danger" data-svc-del="${esc(s.id)}" data-lead="${esc(s.lead_id)}" data-name="${esc(s.name || '')}" data-biz="${esc(s.lead_name || 'Lead #' + s.lead_id)}" data-count="${esc(s.booking_count || 0)}">Delete</button></td></tr>`
      )
      .join('') ||
    `<tr><td colspan="7" class="empty">${
      filtered
        ? 'No services for this business.'
        : 'No services yet. Services are created per site via MCP bookings.createService.'
    }</td></tr>`;
  const renderBookings = (v) => {
    const appts = applyBusinessFilter(appointments, v);
    const svcs = applyBusinessFilter(services, v);
    view.querySelector('#bk-appt-body').innerHTML = apptRows(appts, !!v);
    view.querySelector('#bk-svc-body').innerHTML = svcRows(svcs, !!v);
    view.querySelector('#bk-appt-count').textContent = `${appts.length} shown`;
    view.querySelector('#bk-svc-count').textContent = `${svcs.length} shown`;
  };
  view.innerHTML = `
    <div class="page-head"><div><h1>Bookings</h1><p class="lede">Appointments and bookable services across every site. Clients manage appointment status from their portal.</p></div>
    <div class="page-actions"><button class="btn danger" data-act="clear-all" ${appointments.length ? '' : 'disabled'}>Clear all…</button> <button class="btn" data-act="refresh">Refresh</button></div></div>
    ${businessFilterBarHtml(appointments.concat(services), 'bk-biz')}
    <div class="card"><div class="panel-h"><h3>Appointments</h3><span class="hint" id="bk-appt-count">${appointments.length} shown</span></div>
    <div class="table-wrap"><table>
      <thead><tr><th>When</th><th>Customer</th><th>Service</th><th>Business</th><th>Status</th></tr></thead>
      <tbody id="bk-appt-body"></tbody>
    </table></div></div>
    <div class="card"><div class="panel-h"><h3>Services</h3><span class="hint" id="bk-svc-count">${services.length} shown</span></div>
    <div class="table-wrap"><table>
      <thead><tr><th>Service</th><th>Business</th><th>Duration</th><th>Price</th><th>Status</th><th>Bookings</th><th></th></tr></thead>
      <tbody id="bk-svc-body"></tbody>
    </table></div></div>`;
  renderBookings('');
  view.querySelector('[data-act="refresh"]').onclick = () => pageBookings();
  let bkBiz = '';
  wireBusinessFilter('bk-biz', (v) => {
    bkBiz = v;
    renderBookings(v);
  });
  const bkClear = view.querySelector('[data-act="clear-all"]');
  if (bkClear) {
    bkClear.onclick = async () => {
      const sel = view.querySelector('#bk-biz');
      const scopeLabel = bkBiz ? sel.options[sel.selectedIndex].textContent : 'all businesses';
      const out = await runClearAllFlow({
        noun: 'appointments',
        scopeLabel,
        extra: 'Services are not touched — appointments only.',
        call: () => api.adminClearAllBookings({ leadId: bkBiz ? Number(bkBiz) : null, confirm: 'DELETE' }),
      });
      if (out) pageBookings();
    };
  }
  // Batch 66 — per-record service delete (the tbody persists across
  // filter re-renders, so one delegated listener covers every row).
  const svcBody = view.querySelector('#bk-svc-body');
  if (svcBody) {
    svcBody.addEventListener('click', async (ev) => {
      const btn = ev.target.closest('[data-svc-del]');
      if (!btn) return;
      const name = btn.dataset.name || 'this service';
      const biz = btn.dataset.biz || '';
      const count = Number(btn.dataset.count || 0);
      let msg = `Delete the service “${name}”${biz ? ` for ${biz}` : ''}?`;
      if (count > 0) {
        msg += `\n\nIt has ${count} appointment(s) on record — past appointments keep the service name on their record.`;
      }
      msg += '\n\nThis cannot be undone.';
      if (!window.confirm(msg)) return;
      try {
        await api.adminDeleteBookingService(Number(btn.dataset.lead), Number(btn.dataset.svcDel));
        toast('Service deleted', 'ok');
        pageBookings();
      } catch (e) {
        toast(errText(e), 'err');
      }
    });
  }
}

async function pageShop() {
  let res;
  try {
    res = await withLoadTimeout(api.adminShop());
  } catch (e) {
    view.innerHTML = loadErrorCardHtml(errText(e));
    wirePageRetry(() => pageShop());
    return;
  }
  const d = res.data || {};
  const orders = asList(d, ['orders']);
  const totals = asList(d, ['totals']);
  const sites = asList(d, ['sites']);
  const ownKeysCount = sites.filter((s) => s.effective_source === 'lead').length;
  const orderRows = (list, filtered) =>
    list
      .map(
        (o) => `<tr>
        <td>#${esc(o.id)}</td>
        <td>${esc(o.product_name || '—')}</td>
        <td>${esc(o.customer_email || '—')}</td>
        <td>${esc(o.lead_name || 'Lead #' + o.lead_id)}</td>
        <td>${esc(moneyCents(o.amount_cents, o.currency))}</td>
        <td><span class="badge ${o.status === 'paid' ? 'ok' : o.status === 'failed' || o.status === 'cancelled' ? 'danger' : 'warn'}">${esc(
          o.status || 'pending'
        )}</span>${
          o.stripe_key_source === 'lead'
            ? '<div class="hint">own keys</div>'
            : o.stripe_key_source === 'workspace'
              ? '<div class="hint">workspace keys</div>'
              : ''
        }</td>
        <td>${o.created_at ? esc(fmtDate(o.created_at)) : '—'}</td></tr>`
      )
      .join('') ||
    `<tr><td colspan="7" class="empty">${filtered ? 'No orders for this business.' : 'No orders yet.'}</td></tr>`;
  const siteRows = sites
    .map((s) => {
      const badge =
        s.effective_source === 'lead'
          ? '<span class="badge ok">Own Stripe keys</span>'
          : s.effective_source === 'workspace'
            ? '<span class="badge warn">Workspace keys</span>'
            : '<span class="badge danger">Not configured</span>';
      return `<tr><td>${esc(s.lead_name || 'Lead #' + s.lead_id)}</td><td>${badge}</td></tr>`;
    })
    .join('');
  view.innerHTML = `
    <div class="page-head"><div><h1>Shop</h1><p class="lede">Store orders across every site, plus the workspace payments configuration.</p></div>
    <div class="page-actions"><button class="btn" data-act="refresh">Refresh</button></div></div>
    ${
      d.stripe_configured
        ? '<div class="alert ok"><strong>Workspace payments configured.</strong> Stripe keys are saved for this workspace, so shop checkout can run on the workspace fallback. Sites whose owners connected their own keys in the portal charge their own Stripe instead — see Payments by site below.</div>'
        : ownKeysCount
          ? `<div class="alert warn"><strong>No workspace keys saved.</strong> Checkout still works for ${ownKeysCount} site(s) whose owners connected their own Stripe keys in the portal; every other shop has no working checkout until keys are added in Settings → Shop payments or the owner connects their own.</div>`
          : '<div class="alert warn"><strong>Payments are not configured.</strong> No Stripe keys are saved for this workspace and no site owner has connected their own — shop sites have no working checkout until keys are added in Settings → Shop payments or an owner connects theirs in the portal.</div>'
    }
    ${
      sites.length
        ? `<div class="table-wrap" style="margin-bottom:14px"><table>
      <thead><tr><th>Payments by site</th><th>Checkout runs on</th></tr></thead>
      <tbody>${siteRows}</tbody>
    </table></div>`
        : ''
    }
    <div class="stats-cards">
      <div class="stat-card"><div class="stat-label">Products (all sites)</div><div class="stat-value">${esc(d.product_count || 0)}</div></div>
      ${totals
        .map(
          (t) =>
            `<div class="stat-card"><div class="stat-label">${esc(pretty(t.status))} orders (all sites)</div><div class="stat-value">${esc(
              t.c
            )}</div><div class="hint">${esc(moneyCents(t.cents, 'USD'))}</div></div>`
        )
        .join('')}
    </div>
    ${businessFilterBarHtml(orders, 'sh-biz')}
    <div class="table-wrap"><table>
      <thead><tr><th>Order</th><th>Product</th><th>Customer</th><th>Business</th><th>Amount</th><th>Status</th><th>Date</th></tr></thead>
      <tbody id="sh-body"></tbody>
    </table></div>`;
  const renderOrders = (v) => {
    view.querySelector('#sh-body').innerHTML = orderRows(applyBusinessFilter(orders, v), !!v);
  };
  renderOrders('');
  view.querySelector('[data-act="refresh"]').onclick = () => pageShop();
  wireBusinessFilter('sh-biz', renderOrders);
}

async function pageModules() {
  let res;
  try {
    res = await withLoadTimeout(api.adminModules());
  } catch (e) {
    view.innerHTML = loadErrorCardHtml(errText(e));
    wirePageRetry(() => pageModules());
    return;
  }
  const d = res.data || {};
  const catalog = asList(d, ['catalog']);
  const installs = asList(d, ['installs']);
  const counts = d.counts || {};
  const labelFor = (t) => {
    const c = catalog.find((x) => x.type === t);
    return c ? c.label : t;
  };
  const installRows = (list, filtered) =>
    list
      .map(
        (i) => `<tr>
        <td>${esc(labelFor(i.module_type))}<div class="hint">${esc(i.title || '')}</div></td>
        <td>${esc(i.lead_name || 'Lead #' + i.lead_id)}</td>
        <td>${esc(i.website_name || '—')}</td>
        <td>${esc(i.target_page_slug || '—')}</td>
        <td>${i.published ? '<span class="badge ok">published</span>' : '<span class="badge">draft</span>'}</td>
        <td>${i.updated_at ? esc(fmtDate(i.updated_at)) : '—'}</td>
        <td class="actions"><button class="btn small danger" data-mod-del="${esc(i.lead_id)}" data-type="${esc(i.module_type)}" data-label="${esc(labelFor(i.module_type))}" data-biz="${esc(i.lead_name || 'Lead #' + i.lead_id)}" data-purge="${esc(
          ((i.purge && i.purge.parts) || []).map((p) => `${p.count} ${p.label}`).join(' · ')
        )}">Delete</button></td></tr>`
      )
      .join('') ||
    `<tr><td colspan="7" class="empty">${filtered ? 'No modules installed for this business.' : 'No modules installed yet.'}</td></tr>`;
  view.innerHTML = `
    <div class="page-head"><div><h1>Modules</h1><p class="lede">Platform modules and where they are installed. Attach or detach modules per site from the Design flow or MCP.</p></div>
    <div class="page-actions"><button class="btn danger" data-act="clear-all" ${installs.length ? '' : 'disabled'}>Clear all…</button> <button class="btn" data-act="refresh">Refresh</button></div></div>
    <div class="card"><div class="panel-h"><h3>Catalog</h3></div>
      <div class="chips">${catalog
        .map((c) => `<span class="chip">${esc(c.label)}<span>${esc(counts[c.type] || 0)} installed</span></span>`)
        .join('')}</div></div>
    ${businessFilterBarHtml(installs, 'md-biz')}
    <div class="table-wrap"><table>
      <thead><tr><th>Module</th><th>Business</th><th>Website</th><th>Page</th><th>Published</th><th>Updated</th><th></th></tr></thead>
      <tbody id="md-body"></tbody>
    </table></div>`;
  const renderInstalls = (v) => {
    view.querySelector('#md-body').innerHTML = installRows(applyBusinessFilter(installs, v), !!v);
  };
  renderInstalls('');
  view.querySelector('[data-act="refresh"]').onclick = () => pageModules();
  // Batch 66 — per-record module delete (embed + content purge; the
  // tbody persists across filter re-renders, one delegated listener).
  const mdBody = view.querySelector('#md-body');
  if (mdBody) {
    mdBody.addEventListener('click', async (ev) => {
      const btn = ev.target.closest('[data-mod-del]');
      if (!btn) return;
      const label = btn.dataset.label || btn.dataset.type;
      const biz = btn.dataset.biz || '';
      const purge = btn.dataset.purge || '';
      let msg = `Delete the ${label} module${biz ? ` for ${biz}` : ''}?`;
      msg += purge
        ? `\n\nThis permanently deletes the module and its content: ${purge}.`
        : '\n\nThis permanently deletes the module (it has no content rows).';
      msg += '\n\nDetach only unpublishes. Delete cannot be undone.';
      if (!window.confirm(msg)) return;
      try {
        await api.adminDeleteModuleInstall(Number(btn.dataset.modDel), btn.dataset.type);
        toast('Module deleted', 'ok');
        pageModules();
      } catch (e) {
        toast(errText(e), 'err');
      }
    });
  }
  let mdBiz = '';
  wireBusinessFilter('md-biz', (v) => {
    mdBiz = v;
    renderInstalls(v);
  });
  const mdClear = view.querySelector('[data-act="clear-all"]');
  if (mdClear) {
    mdClear.onclick = async () => {
      const sel = view.querySelector('#md-biz');
      const scopeLabel = mdBiz ? sel.options[sel.selectedIndex].textContent : 'all businesses';
      const out = await runClearAllFlow({
        noun: 'module attachments',
        scopeLabel,
        extra:
          'Clear-all DETACHES modules (the same detach the Design flow uses) — module content is kept, and live sites change on their next publish.',
        call: () => api.adminClearAllModules({ leadId: mdBiz ? Number(mdBiz) : null, confirm: 'DELETE' }),
      });
      if (out) pageModules();
    };
  }
}

async function pageCourses() {
  let res;
  try {
    res = await withLoadTimeout(api.adminCourses());
  } catch (e) {
    view.innerHTML = loadErrorCardHtml(errText(e));
    wirePageRetry(() => pageCourses());
    return;
  }
  const courses = asList(res.data, ['courses']);
  const courseRows = (list, filtered) =>
    list
      .map(
        (c) => `<tr>
        <td>${esc(c.title || '—')}<div class="hint">${esc(c.description || '')}</div></td>
        <td>${esc(c.lead_name || 'Lead #' + c.lead_id)}</td>
        <td>${esc(c.lesson_count || 0)}</td>
        <td>${c.status === 'published' ? '<span class="badge ok">published</span>' : esc(c.status || 'draft')}</td>
        <td>${c.updated_at ? esc(fmtDate(c.updated_at)) : '—'}</td></tr>`
      )
      .join('') ||
    `<tr><td colspan="5" class="empty">${
      filtered ? 'No courses for this business.' : 'No courses yet. Courses are managed per site via MCP courses.*.'
    }</td></tr>`;
  view.innerHTML = `
    <div class="page-head"><div><h1>Courses</h1><p class="lede">Courses published through the courses module, across every site.</p></div>
    <div class="page-actions"><button class="btn danger" data-act="clear-all" ${courses.length ? '' : 'disabled'}>Clear all…</button> <button class="btn" data-act="refresh">Refresh</button></div></div>
    ${businessFilterBarHtml(courses, 'co-biz')}
    <div class="table-wrap"><table>
      <thead><tr><th>Course</th><th>Business</th><th>Lessons</th><th>Status</th><th>Updated</th></tr></thead>
      <tbody id="co-body"></tbody>
    </table></div>`;
  const renderCourses = (v) => {
    view.querySelector('#co-body').innerHTML = courseRows(applyBusinessFilter(courses, v), !!v);
  };
  renderCourses('');
  view.querySelector('[data-act="refresh"]').onclick = () => pageCourses();
  let coBiz = '';
  wireBusinessFilter('co-biz', (v) => {
    coBiz = v;
    renderCourses(v);
  });
  const coClear = view.querySelector('[data-act="clear-all"]');
  if (coClear) {
    coClear.onclick = async () => {
      const sel = view.querySelector('#co-biz');
      const scopeLabel = coBiz ? sel.options[sel.selectedIndex].textContent : 'all businesses';
      const out = await runClearAllFlow({
        noun: 'courses',
        scopeLabel,
        extra: 'Lessons inside each course are deleted with it.',
        call: () => api.adminClearAllCourses({ leadId: coBiz ? Number(coBiz) : null, confirm: 'DELETE' }),
      });
      if (out) pageCourses();
    };
  }
}

async function pageAnalytics() {
  let res;
  try {
    res = await withLoadTimeout(api.adminAnalytics());
  } catch (e) {
    view.innerHTML = loadErrorCardHtml(errText(e));
    wirePageRetry(() => pageAnalytics());
    return;
  }
  const d = res.data || {};
  const dash = d.dashboard || {};
  const out = d.outreach || {};
  const byStatus = dash.byStatus || {};
  const msgByStatus = out.messagesByStatus || {};
  const eventsByType = out.eventsByType || {};
  const activity = asList(dash, ['activity']);
  const chipRow = (obj) =>
    Object.keys(obj).length
      ? Object.keys(obj)
          .map((k) => `<span class="chip">${esc(pretty(k))}<span>${esc(obj[k])}</span></span>`)
          .join('')
      : '<span class="hint">No data yet.</span>';
  view.innerHTML = `
    <div class="page-head"><div><h1>Analytics</h1><p class="lede">Workspace totals at a glance — leads, sites, outreach and recent activity.</p></div>
    <div class="page-actions"><button class="btn" data-act="refresh">Refresh</button></div></div>
    <div class="stats-cards">
      <div class="stat-card"><div class="stat-label">Leads</div><div class="stat-value">${esc(dash.leadsTotal || 0)}</div></div>
      <div class="stat-card"><div class="stat-label">Websites</div><div class="stat-value">${esc(dash.websites || 0)}</div></div>
      <div class="stat-card"><div class="stat-label">Campaigns</div><div class="stat-value">${esc(out.campaigns || 0)}</div></div>
      <div class="stat-card"><div class="stat-label">Active campaigns</div><div class="stat-value">${esc(out.activeCampaigns || 0)}</div></div>
      <div class="stat-card"><div class="stat-label">Emails sent today</div><div class="stat-value">${esc(dash.outreachSentToday == null ? '—' : dash.outreachSentToday)}</div></div>
      <div class="stat-card"><div class="stat-label">AI spend today</div><div class="stat-value">${money(dash.aiSpendTodayUsd)}</div></div>
      <div class="stat-card"><div class="stat-label">Suppressed addresses</div><div class="stat-value">${esc(out.suppressionCount || 0)}</div></div>
    </div>
    <div class="card"><div class="panel-h"><h3>Leads by status</h3><a href="#/pipeline" class="btn small">Open pipeline</a></div>
      <div class="chips">${chipRow(byStatus)}</div></div>
    <div class="card"><div class="panel-h"><h3>Outreach messages by status</h3><a href="#/outreach" class="btn small">Open outreach</a></div>
      <div class="chips">${chipRow(msgByStatus)}</div></div>
    <div class="card"><div class="panel-h"><h3>Email events by type</h3></div>
      <div class="chips">${chipRow(eventsByType)}</div></div>
    <div class="card"><div class="panel-h"><h3>Recent activity</h3>${activity.length ? '<button class="btn small danger" data-act="clear-activity">Clear all…</button>' : ''}</div>
      <ul class="list">${
        activity.length
          ? activity
              .map((a) => `<li>${esc(a.message)}<div class="timestamp">${esc(a.area)} · ${esc(fmtDate(a.at))}</div></li>`)
              .join('')
          : '<li class="hint">No activity yet.</li>'
      }</ul></div>`;
  view.querySelector('[data-act="refresh"]').onclick = () => pageAnalytics();
  const anClear = view.querySelector('[data-act="clear-activity"]');
  if (anClear) {
    anClear.onclick = async () => {
      await runClearActivityFlow(() => pageAnalytics());
    };
  }
}

async function pageCalls() {
  // Batch 45: the call list is paged (50/page) through the engine offset —
  // history past the first page is reachable, and clean test calls can be
  // deleted (the button only renders on uncounted rows; the API refuses
  // counted/billed/charged logs regardless).
  const CALL_PAGE = 50;
  let callOffset = 0;
  let res;
  try {
    res = await withLoadTimeout(api.adminCalls({ limit: CALL_PAGE, offset: 0 }));
  } catch (e) {
    view.innerHTML = loadErrorCardHtml(errText(e));
    wirePageRetry(() => pageCalls());
    return;
  }
  const d = res.data || {};
  let allRows = asList(d, ['calls']);
  const businesses = asList(d, ['businesses']);
  // Batch 51: the forwarding-setup picker is fed by pickerBusinesses —
  // EVERY lead (setup is how a business enters call tracking). The
  // module-attached-only `businesses` list still drives the billing
  // strip and the log filter below.
  const pickerBusinesses = asList(d, ['pickerBusinesses']);
  const cfgList = pickerBusinesses.length ? pickerBusinesses : businesses;
  const poolNums = asList(d, ['pool']);
  const wsId = d.workspace_id || '';
  const whenLabel = (v) => {
    const t = Date.parse(String(v || '').replace(' ', 'T') + (String(v || '').includes('T') ? '' : 'Z'));
    return Number.isFinite(t) ? new Date(t).toLocaleString() : '—';
  };
  const durLabel = (sec) => {
    if (sec == null || sec === '') return '—';
    const n = Math.max(0, Math.round(Number(sec) || 0));
    return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
  };
  const callRows = (list) =>
    list
      .map((c) => {
        const main = `<tr>
        <td>${esc(whenLabel(c.created_at))}</td>
        <td>${esc(c.lead_name || '—')}</td>
        <td>${esc(c.from_number || '—')}</td>
        <td>${esc(c.to_number || '—')}</td>
        <td>${esc(c.status || '—')}${c.verified ? '' : ' <span class="hint">(unverified)</span>'}</td>
        <td>${esc(durLabel(c.duration_seconds))}</td>
        <td>${Number(c.counted || 0) === 0 ? `<button type="button" class="btn small danger" data-cl-del="${c.id}">Delete</button>` : ''}</td>
      </tr>`;
        if (!c.recording_url && !c.transcript) return main;
        const player = c.recording_url
          ? `<audio controls preload="none" src="/api/v1/calls/recording-file/${esc(wsId)}/${esc(c.call_sid)}" style="max-width:340px;width:100%"></audio>`
          : '';
        const transcript = c.transcript
          ? `<div style="margin-top:6px"><strong>Transcript</strong><div>${esc(c.transcript)}</div></div>`
          : '<div class="hint" style="margin-top:6px">No transcript</div>';
        return `${main}<tr><td colspan="7" style="background:var(--paper-2,#faf7f1)">${player}${transcript}</td></tr>`;
      })
      .join('');
  const table = (rowsHtml) =>
    `<table class="table"><thead><tr><th>Time</th><th>Business</th><th>From</th><th>To</th><th>Status</th><th>Duration</th><th></th></tr></thead><tbody id="cl-body">${rowsHtml}</tbody></table>`;
  const configured = !!d.twilio_configured;
  const bizById = new Map(businesses.map((b) => [String(b.lead_id), b]));
  const cfgById = new Map(cfgList.map((b) => [String(b.lead_id), b]));
  const bizStrip = businesses.length
    ? `<div class="card" style="margin-bottom:1rem"><h3 style="margin-top:0">This month by business</h3>${businesses
        .map((b) => {
          const bl = b.billing || {};
          const allow = bl.allowance >= 100000 ? 'unlimited' : bl.allowance;
          return `<div style="display:flex;justify-content:space-between;gap:10px;padding:6px 0;border-bottom:1px solid var(--line,#e6e0d8)">
      <div><strong>${esc(b.lead_name || 'Business')}</strong> <span class="hint">${esc(b.plan || '')} plan${b.display_number ? ' · ' + esc(b.display_number) : ''}</span>${b.display_number ? `<div class="hint" style="margin-top:2px">Tip for the client: save this number in their phone as 'New Lead'.</div>` : ''}</div>
      <div class="hint">Answered this month: <strong>${esc(bl.answered != null ? bl.answered : 0)} / ${esc(allow != null ? allow : '')}</strong>${bl.overage_due_credits > 0 ? ` · Overage due: <strong>${esc(bl.overage_due_credits)} credits</strong>` : ''}</div>
    </div>`;
        })
        .join('')}</div>`
    : '';
  // Forwarding setup (Batch 25c): admin-only. Clients provide just
  // their phone number (leads.phone — the forward-to destination only;
  // it never shows on their site). The site's call button shows the
  // Twilio tracking number; tracking, forwarding, recording, alerts
  // and rotation (Batch 26d) are configured here.
  const cfgCard = cfgList.length
    ? `<div class="card" style="margin-bottom:1rem">
      <h3 style="margin-top:0">Forwarding setup</h3>
      <p class="hint">Clients only provide their phone number — it is where their calls ring, and it never appears on their site. Their site's call button shows the Twilio tracking number. Assign the tracking number and forwarding here.</p>
      <label class="field">Search businesses<br />
        <input type="search" id="cl-cfg-search" placeholder="Type to filter…" autocomplete="off" />
      </label>
      <label class="field">Business<br />
        <select id="cl-cfg-biz">${cfgList.map((b) => `<option value="${esc(b.lead_id)}">${esc(b.lead_name || 'Business')}</option>`).join('')}</select>
      </label>
      <div id="cl-cfg-host"></div>
    </div>`
    : '';
  view.innerHTML = `
    <div class="page-head"><div><h1>Calls</h1><p class="lede">Every call to a client's tracking number — the number their site shows — across all sites. Completed calls also save the caller as a LeadScout contact on that business.</p></div>
    <div class="page-actions"><button class="btn danger" id="cl-clear-all" ${allRows.length ? '' : 'disabled'}>Clear all…</button></div></div>
    ${warningsBannerHtml(d.warnings)}
    <div class="card" style="margin-bottom:1rem">
      <h3 style="margin-top:0">Buy a tracking number</h3>
      ${
        configured
          ? '<p class="hint">Pick the business in the filter below, search an area code, and buy. Numbers run about $1.15/mo on Twilio. Buying attaches the number to that business as its display number and points its calls at BitPype automatically — no Twilio console trip needed.</p>'
          : '<p class="hint">Twilio is not connected yet — add the Account SID and Auth Token in Platform settings (Calls group) and this panel wakes up. Until then, a client can still bring a number they already own — point its voice webhook at the URL in the forwarding setup below.</p>'
      }
      <div style="display:flex;gap:8px;align-items:end;flex-wrap:wrap">
        <label class="field" style="margin:0">Area code<br /><input id="cl-area" value="610" size="5" maxlength="3" ${configured ? '' : 'disabled'} /></label>
        <button type="button" class="btn" id="cl-search" ${configured ? '' : 'disabled'}>Search numbers</button>
      </div>
      <div id="cl-results" style="margin-top:10px"></div>
    </div>
    <div class="card" style="margin-bottom:1rem">
      <h3 style="margin-top:0">Twilio numbers</h3>
      <p class="hint">The numbers you purchased on the connected Twilio account. Add each one here once — then a forwarding setup below can use it as its tracking number or in a rotation. A number can serve only one business at a time.</p>
      ${
        poolNums.length
          ? poolNums
              .map((p) => {
                const a = p.assignment || null;
                const used = a
                  ? a.role === 'primary'
                    ? `Tracking number for ${a.lead_name || 'a business'}`
                    : `In rotation for ${a.lead_name || 'a business'}`
                  : 'Unassigned';
                return `<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--line,#e6e0d8)">
              <div><strong>${esc(p.phone_number)}</strong>${p.label ? ` <span class="hint">${esc(p.label)}</span>` : ''} <span class="hint">· ${esc(used)}</span></div>
              <button type="button" class="btn small" data-cl-pool-remove="${esc(p.id)}" ${a ? 'disabled title="In use — remove it from that forwarding setup first."' : ''}>Remove</button>
            </div>`;
              })
              .join('')
          : '<p class="hint">No numbers in the pool yet.</p>'
      }
      <div style="display:flex;gap:8px;align-items:end;flex-wrap:wrap;margin-top:10px">
        <label class="field" style="margin:0">Number you purchased<br /><input id="cl-pool-number" type="tel" placeholder="+16105551234" ${configured ? '' : 'disabled'} /></label>
        <label class="field" style="margin:0">Label (optional)<br /><input id="cl-pool-label" type="text" maxlength="80" placeholder="e.g. Reading line" ${configured ? '' : 'disabled'} /></label>
        <button type="button" class="btn" id="cl-pool-add" ${configured ? '' : 'disabled'}>Add to pool</button>
      </div>
      ${configured ? '' : '<p class="hint" style="margin-top:8px">Connect Twilio first — a number can only join the pool once it is verified on the account.</p>'}
    </div>
    ${bizStrip}
    ${cfgCard}
    ${businessFilterBarHtml([...allRows, ...businesses], 'cl-biz')}
    <div class="card"><div class="table-wrap">${table(callRows(allRows))}</div>
    ${allRows.length ? '' : '<p class="hint" style="margin-top:10px">No calls yet.</p>'}
    <div class="pagination" style="margin-top:10px"><button type="button" class="btn" id="cl-prev">← Newer</button> <span class="hint" id="cl-page-label"></span> <button type="button" class="btn" id="cl-next">Older →</button></div></div>`;
  const selectedBiz = () => {
    const sel = document.getElementById('cl-biz');
    return sel && sel.value ? bizById.get(String(sel.value)) || null : null;
  };
  const gateBuyPanel = () => {
    const b = selectedBiz();
    const sb = document.getElementById('cl-search');
    const host = document.getElementById('cl-results');
    if (b && b.plan === 'free') {
      if (sb) sb.disabled = true;
      if (host)
        host.innerHTML =
          '<p class="hint"><strong>Buying a number requires a paid plan.</strong> This business is on the free plan — upgrade it first. A business that already has a number keeps receiving calls on any plan.</p>';
    } else if (sb && configured) {
      sb.disabled = false;
    }
  };
  const wireCallDeletes = () => {
    view.querySelectorAll('[data-cl-del]').forEach((b) => {
      b.onclick = async () => {
        const id = Number(b.dataset.clDel);
        if (!window.confirm('Delete this call log? Only uncounted, unbilled test calls can be deleted.')) return;
        try {
          await api.adminDeleteCall(id);
          allRows = allRows.filter((c) => Number(c.id) !== id);
          const body = document.getElementById('cl-body');
          if (body) body.innerHTML = callRows(allRows);
          wireCallDeletes();
          toast('Call log deleted', 'ok');
        } catch (e) {
          toast(errText(e), 'err');
        }
      };
    });
  };
  const syncCallPager = () => {
    const prev = document.getElementById('cl-prev');
    const next = document.getElementById('cl-next');
    const label = document.getElementById('cl-page-label');
    if (prev) prev.disabled = callOffset <= 0;
    if (next) next.disabled = allRows.length < CALL_PAGE;
    if (label) label.textContent = allRows.length ? `Calls ${callOffset + 1}–${callOffset + allRows.length}` : 'No calls on this page';
  };
  const loadCallPage = async (nextOffset) => {
    try {
      const r = await withLoadTimeout(api.adminCalls({ limit: CALL_PAGE, offset: nextOffset }));
      callOffset = nextOffset;
      allRows = asList(r.data || {}, ['calls']);
      const body = document.getElementById('cl-body');
      if (body) body.innerHTML = callRows(allRows);
      wireCallDeletes();
      syncCallPager();
    } catch (e) {
      toast(errText(e), 'err');
    }
  };
  const clPrev = document.getElementById('cl-prev');
  const clNext = document.getElementById('cl-next');
  if (clPrev) clPrev.onclick = () => loadCallPage(Math.max(0, callOffset - CALL_PAGE));
  if (clNext) clNext.onclick = () => loadCallPage(callOffset + CALL_PAGE);
  wireCallDeletes();
  syncCallPager();
  wireBusinessFilter('cl-biz', (val) => {
    const body = document.getElementById('cl-body');
    if (body) body.innerHTML = callRows(applyBusinessFilter(allRows, val));
    wireCallDeletes();
    gateBuyPanel();
  });
  gateBuyPanel();
  // Twilio number pool (Batch 26d): add verifies ownership server-side;
  // remove is blocked while a setup uses the number (button disabled,
  // and the API refuses with the business named).
  const poolAddBtn = document.getElementById('cl-pool-add');
  if (poolAddBtn) {
    poolAddBtn.addEventListener('click', async () => {
      const number = (document.getElementById('cl-pool-number') || {}).value || '';
      const label = (document.getElementById('cl-pool-label') || {}).value || '';
      if (!number.trim()) {
        toast('Enter the purchased number first.', 'err');
        return;
      }
      poolAddBtn.disabled = true;
      try {
        const r = await api.adminCallPoolAdd({ phoneNumber: number.trim(), label: label.trim() });
        const pd = (r && r.data) || {};
        if (pd.configured === false) {
          toast('Twilio is not connected yet — nothing was added.', 'err');
          poolAddBtn.disabled = false;
          return;
        }
        toast(`${(pd.number && pd.number.phone_number) || number} is in the pool.`);
        pageCalls();
      } catch (e) {
        toast(errText(e), 'err');
        poolAddBtn.disabled = false;
      }
    });
  }
  view.querySelectorAll('[data-cl-pool-remove]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-cl-pool-remove');
      if (!window.confirm('Remove this number from the pool? It stays on your Twilio account — it just becomes unavailable to forwarding setups.')) return;
      btn.disabled = true;
      try {
        await api.adminCallPoolRemove(id);
        toast('Number removed from the pool.');
        pageCalls();
      } catch (e) {
        toast(errText(e), 'err');
        btn.disabled = false;
      }
    });
  });
  const renderCfgForm = () => {
    const host = document.getElementById('cl-cfg-host');
    const sel = document.getElementById('cl-cfg-biz');
    if (!host || !sel) return;
    const b = cfgById.get(String(sel.value));
    if (!b) {
      host.innerHTML = '';
      return;
    }
    const c = b.config || {};
    host.innerHTML = `
      <p class="hint" style="margin:6px 0">Client's number (destination): <strong>${esc(b.lead_phone || '— not provided yet —')}</strong>. This number never shows on their site — it is only where calls ring. Their site's call button shows and dials the tracking number below, which forwards to it.</p>
      ${b.has_module === false ? '<p class="hint" style="margin:6px 0"><strong>Call tracking is not attached to this business\u2019s site yet.</strong> You can save the forwarding setup now — it takes effect as soon as the module is attached to their site.</p>' : ''}
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px">
        <label class="field" style="margin:0">Tracking number (Twilio)<br /><input id="cl-cfg-display" type="tel" value="${esc(c.display_number || '')}" placeholder="+16105551234" /></label>
        <label class="field" style="margin:0">Button label<br /><input id="cl-cfg-cta" type="text" maxlength="60" value="${esc(c.cta_text || 'Call us')}" /></label>
        <label class="field" style="margin:0">Redirect number (override)<br /><input id="cl-cfg-redirect" type="tel" value="${esc(c.redirect_number || '')}" placeholder="${esc(b.lead_phone || '+16105550100')}" /></label>
      </div>
      <div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:8px">
        <label><input type="checkbox" id="cl-cfg-redirect-enabled"${c.redirect_enabled ? ' checked' : ''} /> Forward calls</label>
        <label><input type="checkbox" id="cl-cfg-record"${c.record_calls ? ' checked' : ''} /> Record calls</label>
        <label><input type="checkbox" id="cl-cfg-notify"${c.notify_email === false ? '' : ' checked'} /> Email the client when a call comes in</label>
        <label><input type="checkbox" id="cl-cfg-voicemail"${c.voicemail_enabled === false ? '' : ' checked'} /> Voicemail greeting when a call isn't answered (message is transcribed + emailed)</label>
      </div>
      <div style="margin-top:10px">
        <label><input type="checkbox" id="cl-cfg-rotate"${c.rotate_enabled ? ' checked' : ''} /> <strong>Rotate numbers</strong> — the site's call button cycles through up to 5 pool numbers; every one forwards to the client's number above. Off = the single tracking number, as usual.</label>
        <div id="cl-cfg-rotate-host" style="display:${c.rotate_enabled ? 'grid' : 'none'};grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px;margin-top:8px">
          ${[0, 1, 2, 3, 4]
            .map((i) => {
              const current = (c.rotation_numbers || [])[i] || '';
              const options = poolNums
                .map((p) => {
                  const usedByOther = p.assignment && Number(p.assignment.lead_id) !== Number(b.lead_id);
                  const dis = usedByOther && p.phone_number !== current ? ' disabled' : '';
                  const suffix = p.assignment
                    ? Number(p.assignment.lead_id) === Number(b.lead_id)
                      ? p.assignment.role === 'primary'
                        ? ' · this business’s tracking number'
                        : ' · in this rotation'
                      : ` · used by ${p.assignment.lead_name || 'another business'}`
                    : '';
                  return `<option value="${esc(p.phone_number)}"${p.phone_number === current ? ' selected' : ''}${dis}>${esc(p.phone_number)}${p.label ? ' · ' + esc(p.label) : ''}${esc(suffix)}</option>`;
                })
                .join('');
              return `<label class="field" style="margin:0">Rotation number ${i + 1}<br /><select id="cl-cfg-rot-${i}"><option value="">— none —</option>${options}</select></label>`;
            })
            .join('')}
        </div>
        ${poolNums.length ? '' : '<p class="hint" style="margin-top:6px">The pool is empty — add purchased numbers in the Twilio numbers section above first.</p>'}
      </div>
      <p class="hint" style="margin-top:8px">Voice webhook for an owned Twilio number (POST):<br /><code>${esc(b.voice_url || '')}</code></p>
      <button type="button" class="btn" id="cl-cfg-save">Save forwarding setup</button>`;
    const rotateBox = document.getElementById('cl-cfg-rotate');
    if (rotateBox) {
      rotateBox.addEventListener('change', () => {
        const host = document.getElementById('cl-cfg-rotate-host');
        if (host) host.style.display = rotateBox.checked ? 'grid' : 'none';
      });
    }
    const saveBtn = document.getElementById('cl-cfg-save');
    if (saveBtn) {
      saveBtn.addEventListener('click', async () => {
        const val = (id) => {
          const n = document.getElementById(id);
          return n ? n.value : '';
        };
        const on = (id) => {
          const n = document.getElementById(id);
          return !!(n && n.checked);
        };
        saveBtn.disabled = true;
        try {
          const rotation_numbers = [0, 1, 2, 3, 4]
            .map((i) => val(`cl-cfg-rot-${i}`))
            .filter((v) => v);
          const r = await api.adminCallConfigSave({
            leadId: Number(sel.value),
            display_number: val('cl-cfg-display'),
            cta_text: val('cl-cfg-cta'),
            redirect_enabled: on('cl-cfg-redirect-enabled'),
            redirect_number: val('cl-cfg-redirect'),
            record_calls: on('cl-cfg-record'),
            notify_email: on('cl-cfg-notify'),
            voicemail_enabled: on('cl-cfg-voicemail'),
            rotate_enabled: on('cl-cfg-rotate'),
            rotation_numbers,
          });
          const saved = (r && r.data && r.data.config) || {};
          b.config = { ...(b.config || {}), ...saved };
          if (saved.display_number != null) b.display_number = saved.display_number;
          if (r && r.data && r.data.lead_phone != null) b.lead_phone = r.data.lead_phone;
          const hookFailed = (((r || {}).data || {}).webhook_results || []).filter((w) => !w.ok);
          if (hookFailed.length) {
            toast(
              `Saved for ${b.lead_name || 'that business'} — but Twilio did not accept the voice webhook for ${hookFailed.map((w) => w.phone_number).join(', ')}. Calls to it won't reach BitPype until its voice webhook (below) is set in Twilio; re-saving retries.`,
              'err'
            );
          } else {
            toast(`Forwarding setup saved for ${b.lead_name || 'that business'}.`);
          }
          renderCfgForm();
        } catch (e) {
          toast(errText(e), 'err');
          saveBtn.disabled = false;
        }
      });
    }
  };
  const cfgBizSel = document.getElementById('cl-cfg-biz');
  if (cfgBizSel) {
    cfgBizSel.addEventListener('change', renderCfgForm);
    wireSelectSearch(document.getElementById('cl-cfg-search'), cfgBizSel);
    renderCfgForm();
  }
  const clClear = document.getElementById('cl-clear-all');
  if (clClear) {
    clClear.addEventListener('click', async () => {
      const b = selectedBiz();
      const out = await runClearAllFlow({
        noun: 'call logs',
        scopeLabel: b ? b.lead_name || 'the selected business' : 'all businesses',
        extra: 'Only uncounted, unbilled, uncharged logs can be deleted — counted or charged calls are billing history and will be skipped.',
        call: () =>
          api.adminClearAllCalls({ leadId: b ? Number(b.lead_id) : null, confirm: 'DELETE' }),
      });
      if (out) pageCalls();
    });
  }
  const searchBtn = document.getElementById('cl-search');
  if (searchBtn) {
    searchBtn.addEventListener('click', async () => {
      const selBiz = selectedBiz();
      if (selBiz && selBiz.plan === 'free') {
        gateBuyPanel();
        return;
      }
      const area = (document.getElementById('cl-area') || {}).value || '610';
      const host = document.getElementById('cl-results');
      host.innerHTML = '<p class="hint">Searching Twilio…</p>';
      try {
        const r = await api.adminCallNumbersAvailable({ areaCode: area });
        const nd = (r && r.data) || {};
        if (nd.configured === false) {
          host.innerHTML = '<p class="hint">Twilio is not connected yet.</p>';
          return;
        }
        const nums = nd.numbers || [];
        host.innerHTML = nums.length
          ? nums
              .map(
                (n) => `<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--line,#e6e0d8)">
              <div><strong>${esc(n.phoneNumber)}</strong> <span class="hint">${esc([n.locality, n.region].filter(Boolean).join(', '))}</span></div>
              <button type="button" class="btn small" data-cl-buy="${esc(n.phoneNumber)}">Buy — about $1.15/mo</button>
            </div>`
              )
              .join('')
          : '<p class="hint">No numbers available in that area code right now — try another.</p>';
        host.querySelectorAll('[data-cl-buy]').forEach((btn) => {
          btn.addEventListener('click', async () => {
            const leadSel = document.getElementById('cl-biz');
            const leadId = leadSel ? leadSel.value : '';
            if (!leadId) {
              toast('Pick the business in the filter first — the number attaches to it.', 'err');
              return;
            }
            const bizName = leadSel.options[leadSel.selectedIndex]
              ? leadSel.options[leadSel.selectedIndex].textContent
              : 'that business';
            const number = btn.getAttribute('data-cl-buy');
            if (!window.confirm(`Buy ${number} for ${bizName}? It bills about $1.15/mo on Twilio and becomes that business's display number.`)) return;
            btn.disabled = true;
            try {
              const pr = await api.adminCallNumberPurchase({ leadId: Number(leadId), phoneNumber: number });
              const pd = (pr && pr.data) || {};
              if (pd.configured === false) {
                toast('Twilio is not connected yet — nothing was bought.', 'err');
                btn.disabled = false;
                return;
              }
              host.innerHTML = `<p><strong>${esc(pd.phoneNumber || number)}</strong> is now ${esc(bizName)}'s tracking number — their call button dials it and calls forward per the forwarding setup below.</p>`;
              toast(`Number ${pd.phoneNumber || number} attached to ${bizName}.`);
            } catch (e) {
              toast(errText(e), 'err');
              btn.disabled = false;
            }
          });
        });
      } catch (e) {
        host.innerHTML = `<p class="hint">${esc(errText(e))}</p>`;
      }
    });
  }
}

async function pageMemberships() {
  let res;
  try {
    res = await withLoadTimeout(api.adminMemberships());
  } catch (e) {
    view.innerHTML = loadErrorCardHtml(errText(e));
    wirePageRetry(() => pageMemberships());
    return;
  }
  const d = res.data || {};
  const sites = asList(d, ['sites']);
  const payoutCell = (s) => {
    if (!s.keys_connected) return '<span class="hint">No Stripe keys</span>';
    const p = s.payout;
    if (!p) return '<span class="hint">…</span>';
    if (!p.ok)
      return `<span class="badge warn">unavailable</span><div class="hint">checked ${p.as_of ? esc(fmtDate(p.as_of)) : '—'}</div>`;
    const last = p.last_payout
      ? `<div class="hint">Last payout ${esc(moneyCents(p.last_payout.amount_cents, p.last_payout.currency))} · ${esc(
          p.last_payout.status || ''
        )}${p.last_payout.arrival_date ? ' · arrives ' + esc(fmtDate(p.last_payout.arrival_date)) : ''}</div>`
      : '<div class="hint">No payouts yet</div>';
    return `<strong>${esc(moneyCents(p.available_cents, p.currency))}</strong> available<div class="hint">${esc(
      moneyCents(p.pending_cents, p.currency)
    )} pending · as of ${p.as_of ? esc(fmtDate(p.as_of)) : '—'}</div>${last}`;
  };
  const siteRows = (list, filtered) =>
    list
      .map(
        (s) => `<tr>
        <td>${esc(s.lead_name || 'Lead #' + s.lead_id)}<div class="hint">${esc(s.tiers_count || 0)} tier(s)</div></td>
        <td>${esc(s.members_count || 0)}</td>
        <td>${esc(s.paid_subs_active || 0)}</td>
        <td>${esc(moneyCents(s.est_monthly_revenue_cents || 0, 'USD'))}<div class="hint">estimated from local records</div></td>
        <td>${s.keys_connected ? '<span class="badge ok">connected</span>' : '<span class="badge">not connected</span>'}</td>
        <td>${payoutCell(s)}</td></tr>`
      )
      .join('') ||
    `<tr><td colspan="6" class="empty">${
      filtered
        ? 'No membership sites for this business.'
        : 'No sites with membership yet. Sites appear here once the Membership module is attached or a member joins.'
    }</td></tr>`;
  view.innerHTML = `
    <div class="page-head"><div><h1>Memberships</h1><p class="lede">Paid memberships across client sites. Members pay each site owner through the owner's own Stripe account — BitPype never holds this money; this screen is oversight only.</p></div>
    <div class="page-actions"><button class="btn danger" data-act="clear-members" disabled title="Pick a business first — members are cleared per site.">Clear all members…</button> <button class="btn" data-act="refresh">Refresh</button></div></div>
    ${businessFilterBarHtml(sites, 'ms-biz')}
    <div class="table-wrap"><table>
      <thead><tr><th>Site</th><th>Members</th><th>Paid subs (active)</th><th>Est. monthly revenue</th><th>Owner Stripe</th><th>Payouts (owner's Stripe)</th></tr></thead>
      <tbody id="ms-body"></tbody>
    </table></div>`;
  const renderSites = (v) => {
    view.querySelector('#ms-body').innerHTML = siteRows(applyBusinessFilter(sites, v), !!v);
  };
  renderSites('');
  view.querySelector('[data-act="refresh"]').onclick = () => pageMemberships();
  let msBiz = '';
  const msClear = view.querySelector('[data-act="clear-members"]');
  wireBusinessFilter('ms-biz', (v) => {
    msBiz = v;
    renderSites(v);
    if (msClear) {
      msClear.disabled = !v;
      msClear.title = v ? '' : 'Pick a business first — members are cleared per site.';
    }
  });
  if (msClear) {
    msClear.onclick = async () => {
      if (!msBiz) return;
      const sel = view.querySelector('#ms-biz');
      const scopeLabel = sel.options[sel.selectedIndex].textContent;
      const site = sites.find((s) => String(s.lead_id) === String(msBiz));
      const out = await runClearAllFlow({
        noun: `members (${(site && site.members_count) || 0} on this site)`,
        scopeLabel,
        extra:
          "Each member's local subscription records go with the account. A member's Stripe subscription lives on the site owner's own Stripe account and is NOT cancelled by this.",
        call: () => api.adminClearAllMembers({ leadId: Number(msBiz), confirm: 'DELETE' }),
      });
      if (out) pageMemberships();
    };
  }
}

/* Site Rentals (Batch 26) — set from the lead page ("Rent a site")
   or the website detail page ("Rent to lead") to prefill the create
   form; consumed (and cleared) by pageRentals. */
let rentalsPreselect = null;

async function pageRentals() {
  let res;
  try {
    res = await withLoadTimeout(api.adminRentals());
  } catch (e) {
    view.innerHTML = loadErrorCardHtml(errText(e));
    wirePageRetry(() => pageRentals());
    return;
  }
  const d = res.data || {};
  const rentals = asList(d, ['rentals']);
  const sites = asList(d, ['sites']);
  const leads = asList(d, ['leads']);
  const pre = rentalsPreselect || {};
  rentalsPreselect = null;
  const cents = (c) => moneyCents(Number(c || 0), 'usd');
  const priceLabel = (r) =>
    r.model === 'per_lead' ? `${cents(r.price_cents)} per lead` : `${cents(r.price_cents)} / month (flat)`;
  const statusPill = (s) =>
    `<span class="badge">${esc(s)}${''}</span>`;
  const siteName = (r) => esc((r.site && r.site.name) || 'Site #' + r.website_id);
  const tenantName = (r) => esc((r.tenant && r.tenant.business_name) || 'Lead #' + r.tenant_lead_id);

  view.innerHTML = `
    <div class="page-head"><div><h1>Rentals</h1><p class="lede">Rent a ranked niche site to one local business — "Rent to Lead". While a rental is live, the site's calls forward to the tenant's phone and its form, booking and chat leads are delivered to the tenant. Per-lead rentals bill in credits ($1 = 1 credit); delivery never stops at a zero balance — the amount due just accrues. Ending a rental routes everything back to the site owner.</p></div>
    <div class="page-actions"><button class="btn danger" id="rent-clear-all" type="button" ${rentals.length ? '' : 'disabled'}>Clear all…</button> <button class="btn" id="rent-refresh" type="button">Refresh</button></div></div>
    <div class="card" style="margin-bottom:1rem">
      <h3 style="margin-top:0">Rent a site</h3>
      <div class="row">
        <div class="field"><label>Website</label><input type="search" id="rent-site-search" placeholder="Type to filter…" autocomplete="off" style="margin-bottom:6px" /><select id="rent-site">${sites.map((s) => `<option value="${esc(s.id)}" ${Number(pre.websiteId) === Number(s.id) ? 'selected' : ''}>${esc(s.owner_business || s.name)}${s.owner_city ? ' · ' + esc(s.owner_city) : ''}${s.industry ? ' · ' + esc(s.industry) : ''}</option>`).join('')}</select></div>
        <div class="field"><label>Tenant (lead)</label><input type="search" id="rent-tenant-search" placeholder="Type to filter…" autocomplete="off" style="margin-bottom:6px" /><select id="rent-tenant">${leads.map((l) => `<option value="${esc(l.id)}" ${Number(pre.tenantLeadId) === Number(l.id) ? 'selected' : ''}>${esc(l.business_name || 'Lead #' + l.id)}${l.city ? ' · ' + esc(l.city) : ''}${l.phone ? ' · ' + esc(l.phone) : ''}</option>`).join('')}</select></div>
      </div>
      <div class="row">
        <div class="field"><label>Pricing model</label><select id="rent-model"><option value="per_lead">Per lead</option><option value="flat">Flat monthly</option></select></div>
        <div class="field"><label>Price ($)</label><input id="rent-price" type="number" min="0" step="1" value="25" /><span class="hint" id="rent-price-hint">Per qualified lead. Whole dollars — charged in credits.</span></div>
        <div class="field"><label>Free trial leads</label><input id="rent-trial" type="number" min="0" step="1" value="0" /></div>
        <div class="field"><label>Start date (optional)</label><input id="rent-start" type="date" /></div>
      </div>
      <div class="inline"><button class="btn primary" id="rent-create" type="button">Start rental</button><span class="msg" id="rent-msg"></span></div>
      <div id="rent-conflict"></div>
    </div>
    <div class="card" style="margin-bottom:1rem">
      <div class="inline" style="justify-content:space-between"><h3 style="margin:0">All rentals</h3>
      <input id="rent-filter" type="search" placeholder="Filter by business…" style="max-width:260px" /></div>
      <div class="table-wrap"><table class="table"><thead><tr><th>Site</th><th>Tenant</th><th>Terms</th><th>Status</th><th>Site leads</th><th>Charged</th><th>Amount due</th><th>Started</th><th></th></tr></thead>
      <tbody id="rent-rows"></tbody></table></div>
    </div>
    <div id="rent-detail"></div>`;

  const rowsEl = document.getElementById('rent-rows');
  wireSelectSearch(document.getElementById('rent-site-search'), document.getElementById('rent-site'));
  wireSelectSearch(document.getElementById('rent-tenant-search'), document.getElementById('rent-tenant'));
  const rentClear = document.getElementById('rent-clear-all');
  if (rentClear) {
    rentClear.addEventListener('click', async () => {
      const out = await runClearAllFlow({
        noun: 'rentals',
        scopeLabel: 'all rentals',
        extra:
          'Only ENDED rental records are removed. Live (trial/active) and paused rentals are never removed here — end them first — and rentals with unsettled charges are kept.',
        call: () => api.adminClearAllRentals({ confirm: 'DELETE' }),
      });
      if (out) pageRentals();
    });
  }
  const rentRefresh = document.getElementById('rent-refresh');
  if (rentRefresh) rentRefresh.addEventListener('click', () => pageRentals());
  // Batch 65 — per-record delete of an ended rental (the engine
  // refuses live/paused rentals and any rental with charges still
  // open; the tenant lead itself is never deleted).
  const deleteRental = async (id) => {
    const r = rentals.find((x) => Number(x.id) === Number(id)) || {};
    const label = `${(r.site && r.site.name) || 'Site #' + r.website_id} → ${(r.tenant && r.tenant.business_name) || 'Lead #' + r.tenant_lead_id}`;
    if (
      !window.confirm(
        `Delete the rental record for ${label}? This permanently removes the ended rental and its charge history. The site is already unrented, and the tenant's lead record is NOT deleted.`
      )
    )
      return;
    try {
      await api.adminRentalDelete(id);
      toast('Rental deleted', 'ok');
      pageRentals();
    } catch (e) {
      toast(errText(e), 'err');
    }
  };
  const renderRows = (list) => {
    rowsEl.innerHTML =
      list
        .map(
          (r) => `<tr>
        <td>${siteName(r)}<div class="hint">${esc((r.site && r.site.town) || '')}${r.site && r.site.town && r.site.niche ? ' · ' : ''}${esc((r.site && r.site.niche) || '')}</div></td>
        <td>${tenantName(r)}</td>
        <td>${esc(priceLabel(r))}${r.trial_leads ? `<div class="hint">${esc(r.trial_used || 0)} of ${esc(r.trial_leads)} trial leads used</div>` : ''}</td>
        <td>${statusPill(r.status)}</td>
        <td>${esc(r.counters ? r.counters.qualified_leads : 0)}</td>
        <td>${esc(r.counters ? r.counters.charged_credits : 0)} credits</td>
        <td>${r.counters && r.counters.amount_due_cents ? '<strong>' + esc(cents(r.counters.amount_due_cents)) + '</strong>' : cents(0)}</td>
        <td>${esc(fmtDate(r.started_at || r.start_at || r.created_at))}</td>
        <td class="actions"><button class="btn small" data-rent-view="${esc(r.id)}" type="button">View</button>${r.status === 'ended' ? ` <button class="btn small danger" data-rent-del="${esc(r.id)}" type="button">Delete</button>` : ''}</td>
      </tr>`
        )
        .join('') || '<tr><td colspan="9" class="empty">No rentals yet.</td></tr>';
  };
  renderRows(rentals);
  const filterEl = document.getElementById('rent-filter');
  filterEl.addEventListener('input', () => {
    const q = filterEl.value.trim().toLowerCase();
    renderRows(
      q
        ? rentals.filter((r) =>
            [
              r.site && r.site.name,
              r.tenant && r.tenant.business_name,
              r.site && r.site.niche,
              r.site && r.site.town,
            ]
              .filter(Boolean)
              .join(' ')
              .toLowerCase()
              .includes(q)
          )
        : rentals
    );
  });

  const detailEl = document.getElementById('rent-detail');
  const renderDetail = async (id) => {
    detailEl.innerHTML = '<p class="hint">Loading…</p>';
    try {
      const r = await api.adminRentalGet(id);
      const dd = r.data || {};
      const rental = dd.rental || {};
      const charges = dd.charges || [];
      const history = dd.history || [];
      const live = rental.status === 'trial' || rental.status === 'active';
      detailEl.innerHTML = `
      <div class="card">
        <div class="inline" style="justify-content:space-between"><h3 style="margin:0">${siteName(rental)} → ${tenantName(rental)}</h3>${statusPill(rental.status)}</div>
        <p class="hint">${esc(priceLabel(rental))} · started ${esc(fmtDate(rental.started_at || rental.created_at))}${rental.ended_at ? ' · ended ' + esc(fmtDate(rental.ended_at)) + (rental.end_reason ? ' (' + esc(rental.end_reason) + ')' : '') : ''}</p>
        ${kv('Qualified site leads', rental.counters ? rental.counters.qualified_leads : 0)}
        ${kv('Trial leads used', `${rental.trial_used || 0} of ${rental.trial_leads || 0}`)}
        ${kv('Credits charged', rental.counters ? rental.counters.charged_credits : 0)}
        ${kv('Amount due', cents(rental.counters ? rental.counters.amount_due_cents : 0))}
        ${
          live
            ? `<div class="inline" style="margin-top:10px">
            ${rental.status !== 'paused' ? `<button class="btn small" id="rent-pause" type="button">Pause</button>` : ''}
            <span class="field" style="margin:0"><input id="rent-end-reason" placeholder="End reason (optional)" /></span>
            <button class="btn small danger" id="rent-end" type="button">End rental</button>
            <span class="msg" id="rent-detail-msg"></span></div>`
            : rental.status === 'paused'
              ? `<div class="inline" style="margin-top:10px"><button class="btn small primary" id="rent-resume" type="button">Resume rental</button>
            <span class="field" style="margin:0"><input id="rent-end-reason" placeholder="End reason (optional)" /></span>
            <button class="btn small danger" id="rent-end" type="button">End rental</button>
            <span class="msg" id="rent-detail-msg"></span></div>`
              : `<div class="inline" style="margin-top:10px"><button class="btn small danger" id="rent-delete" type="button">Delete record</button>
            <span class="msg" id="rent-detail-msg"></span></div>`
        }
        <h4>Per-lead charges</h4>
        <div class="table-wrap"><table class="table"><thead><tr><th>When</th><th>Source</th><th>Contact</th><th>Status</th><th>Charge</th></tr></thead><tbody>
        ${charges.map((c) => `<tr><td>${esc(fmtDate(c.created_at))}</td><td>${esc(c.source_kind)}</td><td>${esc(c.contact_label || '')}</td><td>${esc(c.status)}</td><td>${c.status === 'trial' ? 'trial' : c.status === 'charged' ? esc(c.credits_debited) + ' credits' : c.status === 'due' ? esc(cents(c.amount_due_cents)) + ' due' : '—'}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">No charges yet.</td></tr>'}
        </tbody></table></div>
        <h4>Site leads delivered</h4>
        <div class="table-wrap"><table class="table"><thead><tr><th>When</th><th>Source</th><th>Contact</th><th>Charge</th></tr></thead><tbody>
        ${history.map((h) => `<tr><td>${esc(fmtDate(h.at))}</td><td>${esc(h.source_label || h.source)}</td><td>${esc(h.label || '')}</td><td>${h.charge ? esc(h.charge.status) + (h.charge.credits ? ' · ' + esc(h.charge.credits) + ' credits' : '') + (h.charge.amount_due_cents ? ' · ' + esc(cents(h.charge.amount_due_cents)) + ' due' : '') : '—'}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">No site leads yet.</td></tr>'}
        </tbody></table></div>
      </div>`;
      const msg = document.getElementById('rent-detail-msg');
      const wire = (btnId, fn, okText) => {
        const b = document.getElementById(btnId);
        if (!b) return;
        b.addEventListener('click', async () => {
          b.disabled = true;
          try {
            await fn();
            toast(okText, 'ok');
            pageRentals();
          } catch (e) {
            b.disabled = false;
            if (msg) msg.textContent = errText(e);
          }
        });
      };
      wire('rent-pause', () => api.adminRentalPause(rental.id), 'Rental paused — routing reverted to the owner.');
      wire('rent-resume', () => api.adminRentalResume(rental.id), 'Rental resumed — routing re-applied.');
      wire('rent-end', () => api.adminRentalEnd(rental.id, { reason: (document.getElementById('rent-end-reason') || {}).value || '' }), 'Rental ended.');
      // Batch 65 — delete from the detail panel mirrors the row action
      // (ended rentals only; the button is not rendered otherwise).
      const rentDeleteBtn = document.getElementById('rent-delete');
      if (rentDeleteBtn) {
        rentDeleteBtn.addEventListener('click', async () => {
          if (
            !window.confirm(
              `Delete the rental record for ${(rental.site && rental.site.name) || 'Site #' + rental.website_id} → ${(rental.tenant && rental.tenant.business_name) || 'Lead #' + rental.tenant_lead_id}? This permanently removes the ended rental and its charge history. The tenant's lead record is NOT deleted.`
            )
          )
            return;
          rentDeleteBtn.disabled = true;
          try {
            await api.adminRentalDelete(rental.id);
            toast('Rental deleted', 'ok');
            pageRentals();
          } catch (e) {
            rentDeleteBtn.disabled = false;
            if (msg) msg.textContent = errText(e);
          }
        });
      }
    } catch (e) {
      detailEl.innerHTML = `<p class="error">${esc(errText(e))}</p>`;
    }
  };
  rowsEl.addEventListener('click', (ev) => {
    const del = ev.target.closest('[data-rent-del]');
    if (del) {
      deleteRental(Number(del.getAttribute('data-rent-del')));
      return;
    }
    const btn = ev.target.closest('[data-rent-view]');
    if (btn) renderDetail(Number(btn.getAttribute('data-rent-view')));
  });

  const modelSel = document.getElementById('rent-model');
  const priceHint = document.getElementById('rent-price-hint');
  modelSel.addEventListener('change', () => {
    priceHint.textContent =
      modelSel.value === 'per_lead'
        ? 'Per qualified lead. Whole dollars — charged in credits.'
        : 'Per month. Tracked and reported only — flat rentals are not charged per lead.';
  });
  const createBtn = document.getElementById('rent-create');
  const createMsg = document.getElementById('rent-msg');
  const conflictEl = document.getElementById('rent-conflict');
  const doCreate = async (overrideConflict) => {
    const dollars = Number(document.getElementById('rent-price').value || 0);
    const body = {
      websiteId: Number(document.getElementById('rent-site').value),
      tenantLeadId: Number(document.getElementById('rent-tenant').value),
      model: modelSel.value,
      priceCents: Math.round(dollars * 100),
      trialLeads: Number(document.getElementById('rent-trial').value || 0),
      startAt: document.getElementById('rent-start').value || undefined,
      overrideConflict: !!overrideConflict,
    };
    createBtn.disabled = true;
    createMsg.textContent = 'Starting rental…';
    try {
      const r = await api.adminRentalCreate(body);
      const rd = r.data || {};
      toast(
        rd.activation && rd.activation.callRouting !== 'written'
          ? 'Rental started — call routing skipped: ' + (rd.activation.reason || 'not configured')
          : 'Rental started — delivery now routes to the tenant.',
        'ok'
      );
      pageRentals();
    } catch (e) {
      createBtn.disabled = false;
      const conflicts =
        e && e.data && e.data.error && e.data.error.details ? e.data.error.details.conflicts : null;
      if (e && e.code === 'RENTAL_CONFLICT' && Array.isArray(conflicts) && conflicts.length) {
        createMsg.textContent = '';
        conflictEl.innerHTML = `
          <div class="alert warn" style="margin-top:10px"><strong>Exclusivity warning:</strong> another live rental already covers this niche + town:
          ${conflicts.map((c) => `<div>• ${esc(c.site_name || 'Site #' + c.website_id)} → ${esc(c.tenant_business_name || 'Lead #' + c.tenant_lead_id)} (${esc(c.niche || '')}, ${esc(c.town || '')})</div>`).join('')}
          <div style="margin-top:8px"><button class="btn small" id="rent-create-anyway" type="button">Create anyway</button></div></div>`;
        document.getElementById('rent-create-anyway').addEventListener('click', () => doCreate(true));
      } else {
        createMsg.textContent = errText(e);
      }
    }
  };
  createBtn.addEventListener('click', () => doCreate(false));
}

async function pageSeo() {
  let res;
  try {
    res = await withLoadTimeout(api.adminSeoSites());
  } catch (e) {
    view.innerHTML = loadErrorCardHtml(errText(e));
    wirePageRetry(() => pageSeo());
    return;
  }
  const d = res.data || {};
  const sites = asList(d, ['sites']);
  const configured = !!d.configured;
  view.innerHTML = `
    <div class="page-head"><div><h1>SEO</h1><p class="lede">AI local SEO for client sites. Generate a keyword set and a change list — page titles, meta descriptions, headings, image alt text and a LocalBusiness schema — review current vs proposed, then apply in one click. Nothing changes until you apply, and the client sees this same tool in their portal.</p></div></div>
    ${configured ? '' : '<div class="alert warn" style="margin-bottom:1rem"><strong>AI is not configured.</strong> Add the AI API key in Settings and this tool wakes up — until then generation is unavailable for staff and clients.</div>'}
    <div class="card" style="margin-bottom:1rem">
      <label class="field" style="margin:0">Website<br />
      <select id="seo-site">${sites.map((s) => `<option value="${esc(s.id)}">${esc(s.business_name || s.name)}${s.has_pending ? ' — proposal waiting' : ''}</option>`).join('')}</select></label>
    </div>
    <div id="seo-body">${sites.length ? '<p class="hint">Loading…</p>' : '<p class="hint">No websites yet.</p>'}</div>`;
  const body = document.getElementById('seo-body');
  const sel = document.getElementById('seo-site');
  const valCell = (v) =>
    v ? `<span style="white-space:pre-wrap;word-break:break-word">${esc(v)}</span>` : '<span class="hint">(empty)</span>';
  const renderState = (st) => {
    const sd = st.data || {};
    const pending = sd.pending || null;
    const proposal = pending && pending.proposal ? pending.proposal : null;
    const kw = proposal && proposal.keywords ? proposal.keywords : null;
    const changes = proposal && Array.isArray(proposal.changes) ? proposal.changes : [];
    const history = Array.isArray(sd.history) ? sd.history : [];
    body.innerHTML = `
      ${sd.site ? `<p class="hint">${esc(sd.site.business_name || sd.site.name)} · site #${esc(sd.site.id)} · ${esc(sd.site.status || '')}</p>` : ''}
      <div class="card" style="margin-bottom:1rem">
        <h3 style="margin-top:0">${proposal ? 'Proposed SEO changes' : 'Generate an SEO proposal'}</h3>
        ${
          proposal
            ? `<p class="hint">Generated by ${esc(pending.generated_by || 'staff')} ${pending.generated_at ? '· ' + esc(pending.generated_at) : ''}. Review every line — applying writes these values into the site's pages; the next publish carries them.</p>
               ${kw && (kw.primary || (kw.supporting || []).length) ? `<p><strong>Primary keyword:</strong> ${esc(kw.primary || '—')}${(kw.supporting || []).length ? `<br /><span class="hint">Supporting: ${kw.supporting.map((s) => esc(s)).join(' · ')}</span>` : ''}</p>` : ''}
               <div class="table-wrap"><table class="table"><thead><tr><th>Change</th><th>Current</th><th>Proposed</th></tr></thead><tbody>
               ${changes.map((c) => `<tr><td>${esc(c.label || c.kind)}</td><td>${valCell(c.current)}</td><td>${valCell(c.proposed)}</td></tr>`).join('') || '<tr><td colspan="3" class="empty">The AI proposed no changes for this site.</td></tr>'}
               </tbody></table></div>`
            : '<p class="hint">The AI reads the business and its pages, picks the local keywords customers actually search, and drafts improvements. You review everything before anything is applied.</p>'
        }
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">
          <button type="button" class="btn" id="seo-generate" ${configured ? '' : 'disabled'}>${proposal ? 'Regenerate proposal' : 'Generate proposal'}</button>
          ${proposal && changes.length ? '<button type="button" class="btn primary" id="seo-apply">Apply proposal</button>' : ''}
        </div>
        <p class="hint" id="seo-status" role="status"></p>
      </div>
      ${history.length ? `<div class="card"><h3 style="margin-top:0">Applied history</h3>${history.map((h) => `<div style="padding:6px 0;border-bottom:1px solid var(--line,#e6e0d8)"><strong>${esc(h.change_count)}</strong> change(s) applied by ${esc(h.actor_kind || h.actor || '')} · ${esc(h.applied_at || '')}${h.keywords && h.keywords.primary ? `<div class="hint">Primary keyword: ${esc(h.keywords.primary)}</div>` : ''}</div>`).join('')}</div>` : ''}`;
    const status = document.getElementById('seo-status');
    const genBtn = document.getElementById('seo-generate');
    if (genBtn) {
      genBtn.addEventListener('click', async () => {
        genBtn.disabled = true;
        if (status) status.textContent = 'Generating — the AI is reviewing the site…';
        try {
          renderState(await api.adminSeoGenerate(sel.value));
        } catch (e) {
          genBtn.disabled = false;
          if (status) status.textContent = errText(e);
        }
      });
    }
    const applyBtn = document.getElementById('seo-apply');
    if (applyBtn) {
      applyBtn.addEventListener('click', async () => {
        applyBtn.disabled = true;
        if (status) status.textContent = 'Applying…';
        try {
          const r = await api.adminSeoApply(sel.value);
          const rd = (r && r.data) || {};
          const appliedCount = Array.isArray(rd.applied) ? rd.applied.length : 0;
          const skippedCount = Array.isArray(rd.skipped) ? rd.skipped.length : 0;
          renderState({ data: rd.state });
          const st2 = document.getElementById('seo-status');
          if (st2) {
            st2.textContent = `Applied ${appliedCount} change(s)${skippedCount ? `, skipped ${skippedCount} (target no longer on the site)` : ''}. Publish the site to push them live.`;
          }
        } catch (e) {
          applyBtn.disabled = false;
          if (status) status.textContent = errText(e);
        }
      });
    }
  };
  const loadState = async () => {
    if (!sel || !sel.value) return;
    body.innerHTML = '<p class="hint">Loading…</p>';
    try {
      renderState(await api.adminSeoState(sel.value));
    } catch (e) {
      body.innerHTML = loadErrorCardHtml(errText(e));
      wirePageRetry(() => loadState());
    }
  };
  if (sel) {
    sel.addEventListener('change', loadState);
    if (sites.length) loadState();
  }
}

/* ------------------------------------------------------------------ */
/* Finance (Batch 49) — recorded expenditure + manual expenses         */
/* ------------------------------------------------------------------ */

const FIN_CATEGORIES = ['domains', 'ai', 'cloudflare', 'hosting', 'calls', 'email', 'other'];
const FIN_PRESETS = [
  ['today', 'Today'],
  ['7d', '7 days'],
  ['30d', '30 days'],
  ['90d', '90 days'],
  ['12m', '12 months'],
  ['mtd', 'Month to date'],
  ['custom', 'Custom'],
];

async function pageFinance(param, query) {
  const q = query && typeof query === 'object' ? query : {};
  const preset = FIN_PRESETS.some(([k]) => k === q.preset) ? q.preset : '30d';
  const state = {
    preset,
    from: q.from || '',
    to: q.to || '',
    category: FIN_CATEGORIES.includes(q.category) ? q.category : '',
    page: Math.max(1, Number(q.page) || 1),
  };
  const periodQ = { preset };
  if (preset === 'custom') {
    periodQ.from = state.from;
    periodQ.to = state.to;
  }
  const hashFor = (over) => {
    const s = { ...state, ...over };
    const sp = new URLSearchParams();
    sp.set('preset', s.preset);
    if (s.preset === 'custom') {
      if (s.from) sp.set('from', s.from);
      if (s.to) sp.set('to', s.to);
    }
    if (s.category) sp.set('category', s.category);
    if (s.page > 1) sp.set('page', s.page);
    return `#/finance?${sp.toString()}`;
  };

  let sumRes;
  let ledRes;
  try {
    [sumRes, ledRes] = await Promise.all([
      withLoadTimeout(api.financeSummary(periodQ)),
      withLoadTimeout(api.financeLedger({ ...periodQ, category: state.category || undefined, page: state.page, pageSize: 25 })),
    ]);
  } catch (e) {
    view.innerHTML = loadErrorCardHtml(errText(e));
    wirePageRetry(() => pageFinance(param, query));
    return;
  }
  const sum = sumRes.data || {};
  const led = ledRes.data || { rows: [], total: 0, page: 1, pages: 1 };
  const cats = sum.categories || {};
  const period = sum.period || periodQ;
  const money = (c) => moneyCents(c || 0, 'USD');

  // Batch 62 — per-workspace AI costs. Super-admin only: the endpoint
  // refuses everyone else and the section simply doesn't render.
  let aiWsHtml = '';
  try {
    const aiRes = await withLoadTimeout(api.financeAiByWorkspace(periodQ));
    const aiWs = (aiRes && aiRes.data) || null;
    if (aiWs && Array.isArray(aiWs.rows)) {
      const rowHtml = aiWs.rows
        .map(
          (r) =>
            `<tr><td>${esc(r.name || '')} <span class="hint">#${esc(r.workspaceId)}</span></td><td style="text-align:right">${esc(r.calls || 0)}</td><td style="text-align:right">${esc((r.tokens || 0).toLocaleString())}</td><td style="text-align:right">${money(r.cents || 0)}</td></tr>`
        )
        .join('');
      const t = aiWs.totals || {};
      aiWsHtml = `<div class="card">
      <div class="panel-h"><h3>AI usage by workspace</h3><span class="hint">estimated · all workspaces, this period</span></div>
      <table class="table"><thead><tr><th>Workspace</th><th style="text-align:right">Calls</th><th style="text-align:right">Tokens</th><th style="text-align:right">Est. cost</th></tr></thead>
      <tbody>${rowHtml || '<tr><td colspan="4" class="hint">No workspaces yet.</td></tr>'}
      <tr><td><strong>All workspaces</strong></td><td style="text-align:right"><strong>${esc(t.calls || 0)}</strong></td><td style="text-align:right"><strong>${esc((t.tokens || 0).toLocaleString())}</strong></td><td style="text-align:right"><strong>${money(t.cents || 0)}</strong></td></tr></tbody></table>
      <p class="hint">AI figures are estimates from the app's per-call cost log — the same numbers the AI card above sums for this workspace alone.</p>
    </div>`;
    }
  } catch {
    aiWsHtml = '';
  }

  const catCard = (key) => {
    const c = cats[key] || { label: key, totalCents: 0, autoCents: 0, manualCents: 0 };
    let sub = '';
    if (key === 'domains') {
      sub = `${c.txnCount || 0} registration(s)${c.manualCents ? ` · incl. ${money(c.manualCents)} manual` : ''}`;
    } else if (key === 'ai') {
      sub = `${c.calls || 0} calls · ${((c.promptTokens || 0) + (c.completionTokens || 0)).toLocaleString()} tokens · estimated`;
    } else if (c.manualCents) {
      sub = `${c.manualCount || 0} manual entr${c.manualCount === 1 ? 'y' : 'ies'}`;
    } else {
      sub = 'no manual entries';
    }
    return `<div class="stat-card"><div class="stat-label">${esc(c.label || key)}</div><div class="stat-value">${money(c.totalCents)}</div><div class="hint">${esc(sub)}</div></div>`;
  };

  const series = sum.series || { granularity: 'daily', buckets: [] };
  const maxBucket = Math.max(1, ...series.buckets.map((b) => b.totalCents || 0));
  const seriesHtml = series.buckets.length
    ? series.buckets
        .map((b) => {
          const pct = Math.max(0, Math.round(((b.totalCents || 0) / maxBucket) * 100));
          return `<div style="display:flex;align-items:center;gap:10px;margin:3px 0">
            <span class="hint" style="flex:0 0 92px">${esc(b.label)}</span>
            <span style="flex:1;background:var(--accent-soft);border-radius:6px;height:14px;overflow:hidden"><span style="display:block;height:100%;width:${pct}%;background:var(--accent)"></span></span>
            <span style="flex:0 0 84px;text-align:right;font-variant-numeric:tabular-nums">${money(b.totalCents)}</span>
          </div>`;
        })
        .join('')
    : '<p class="hint">Nothing recorded in this period.</p>';

  const catOptions = FIN_CATEGORIES.map((c) => {
    const label = (cats[c] && cats[c].label) || c;
    return `<option value="${esc(c)}" ${state.category === c ? 'selected' : ''}>${esc(label)}</option>`;
  }).join('');

  view.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Finance</h1>
        <p class="lede">What the business spends, ${esc(period.from)} → ${esc(period.to)} (UTC). Domain registrar charges and AI usage are recorded by the app itself; hosting, the Cloudflare plan, Twilio and similar bills are added as manual expenses below.</p>
      </div>
    </div>
    <div class="chips" style="margin-bottom:14px">${FIN_PRESETS.map(
      ([k, label]) =>
        `<a class="chip" href="${hashFor({ preset: k, page: 1 })}" style="text-decoration:none;color:inherit;${state.preset === k ? 'border-color:var(--accent);font-weight:700' : ''}">${esc(label)}</a>`
    ).join('')}</div>
    ${
      preset === 'custom'
        ? `<form id="fin-custom" class="row end" style="margin-bottom:14px">
        <div class="field"><label>From</label><input type="date" name="from" value="${esc(state.from)}" required /></div>
        <div class="field"><label>To</label><input type="date" name="to" value="${esc(state.to)}" required /></div>
        <div class="field" style="flex:0 0 auto"><label>&nbsp;</label><button class="btn primary" type="submit">Apply</button></div>
      </form>`
        : ''
    }
    <div class="stats-cards">
      <div class="stat-card"><div class="stat-label">Total expenditure</div><div class="stat-value">${money(sum.totalExpenditureCents)}</div><div class="hint">recorded + manual, this period</div></div>
      ${catCard('domains')}
      ${catCard('ai')}
      ${catCard('cloudflare')}
      ${catCard('hosting')}
      ${catCard('calls')}
      ${catCard('email')}
      ${catCard('other')}
      <div class="stat-card"><div class="stat-label">${esc((sum.collected && sum.collected.label) || 'Collected')}</div><div class="stat-value">${money(sum.collected && sum.collected.cents)}</div><div class="hint">money in — context only, not expenditure</div></div>
    </div>
    <p class="hint" style="margin:-4px 0 14px">${esc(sum.aiNote || '')}</p>
    ${aiWsHtml}
    <div class="card">
      <div class="panel-h"><h3>Spend over time</h3><span class="hint">${esc(series.granularity)} buckets</span></div>
      ${seriesHtml}
    </div>
    <div class="card">
      <div class="panel-h"><h3>Add an expense</h3><span class="hint">for bills the app doesn't see — Workers plan, VPS, Twilio top-ups…</span></div>
      <form id="fin-add" class="row end">
        <div class="field"><label>Date</label><input type="date" name="date" required value="${esc(period.to)}" /></div>
        <div class="field"><label>Category</label><select name="category">${FIN_CATEGORIES.map((c) => `<option value="${esc(c)}">${esc((cats[c] && cats[c].label) || c)}</option>`).join('')}</select></div>
        <div class="field" style="flex:2;min-width:180px"><label>Label</label><input name="label" required maxlength="200" placeholder="e.g. Cloudflare Workers Paid" /></div>
        <div class="field"><label>Amount (USD)</label><input name="amount" type="number" min="0.01" step="0.01" required placeholder="5.00" /></div>
        <div class="field" style="flex:2;min-width:160px"><label>Note (optional)</label><input name="note" maxlength="1000" /></div>
        <div class="field" style="flex:0 0 auto"><label>&nbsp;</label><button class="btn primary" type="submit">Add expense</button></div>
      </form>
      <span class="msg" id="fin-add-msg"></span>
    </div>
    <div class="card">
      <div class="panel-h"><h3>Ledger</h3>
        <span class="inline">
          <select id="fin-filter">${'<option value="">All categories</option>' + catOptions}</select>
          <button class="btn small" id="fin-csv">Download CSV</button>
        </span>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>Date</th><th>Category</th><th>Source</th><th>Label</th><th style="text-align:right">Amount</th><th></th></tr></thead>
        <tbody>${
          (led.rows || [])
            .map(
              (r) => `<tr>
            <td>${esc(r.date)}</td>
            <td>${esc(r.categoryLabel || r.category)}</td>
            <td><span class="badge">${esc(r.source)}</span></td>
            <td>${esc(r.label)}</td>
            <td style="text-align:right;font-variant-numeric:tabular-nums">${money(r.amountCents)}</td>
            <td class="actions">${r.deletable ? `<button class="btn small danger" data-act="fin-del" data-id="${esc(r.refId)}">Delete</button>` : ''}</td>
          </tr>`
            )
            .join('') || '<tr><td colspan="6" class="empty">No expenditure recorded in this period.</td></tr>'
        }
        </tbody>
      </table></div>
      <div class="pagination" style="margin-top:8px">
        <button class="btn small" data-act="fin-prev" ${led.page <= 1 ? 'disabled' : ''}>← Prev</button>
        <span class="hint">Page ${esc(led.page)} of ${esc(led.pages)} · ${esc(led.total)} row(s)</span>
        <button class="btn small" data-act="fin-next" ${led.page >= led.pages ? 'disabled' : ''}>Next →</button>
      </div>
    </div>`;

  const customForm = $('#fin-custom');
  if (customForm) {
    customForm.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const fd = new FormData(customForm);
      window.location.hash = hashFor({ preset: 'custom', from: fd.get('from'), to: fd.get('to'), page: 1 });
    });
  }
  const addForm = $('#fin-add');
  if (addForm) {
    addForm.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const fd = new FormData(addForm);
      const msg = $('#fin-add-msg');
      try {
        await api.financeAddExpense({
          date: fd.get('date'),
          category: fd.get('category'),
          label: fd.get('label'),
          amount: Number(fd.get('amount')),
          note: fd.get('note') || undefined,
        });
        toast('Expense added', 'ok');
        navigate();
      } catch (e) {
        if (msg) msg.textContent = errText(e);
      }
    });
  }
  const filter = $('#fin-filter');
  if (filter) {
    filter.addEventListener('change', () => {
      window.location.hash = hashFor({ category: filter.value, page: 1 });
    });
  }
  const csvBtn = $('#fin-csv');
  if (csvBtn) {
    csvBtn.addEventListener('click', async () => {
      try {
        const headers = { 'Content-Type': 'application/json' };
        const ws = api.getWorkspaceId();
        if (ws) headers['X-Workspace-Id'] = String(ws);
        const qs = new URLSearchParams(periodQ);
        if (state.category) qs.set('category', state.category);
        const res = await fetch(`/api/v1/admin-area/finance/export.csv?${qs.toString()}`, {
          credentials: 'include',
          headers,
        });
        if (!res.ok) throw new Error(`Export failed (${res.status})`);
        const blob = await res.blob();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `bitpype-finance-${period.from}-to-${period.to}.csv`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      } catch (e) {
        toast(errText(e), 'err');
      }
    });
  }
  view.querySelectorAll('[data-act="fin-del"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!window.confirm('Delete this expense entry? This cannot be undone.')) return;
      try {
        await api.financeDeleteExpense(btn.getAttribute('data-id'));
        toast('Expense deleted', 'ok');
        navigate();
      } catch (e) {
        toast(errText(e), 'err');
      }
    });
  });
  const prev = view.querySelector('[data-act="fin-prev"]');
  if (prev) prev.addEventListener('click', () => (window.location.hash = hashFor({ page: state.page - 1 })));
  const next = view.querySelector('[data-act="fin-next"]');
  if (next) next.addEventListener('click', () => (window.location.hash = hashFor({ page: state.page + 1 })));
}

/* Batch 71 — Admin mailing list + newsletter (BitPype's own list).
   Platform-level and super-admin only, like the Admin page; data comes
   from /admin/mailing-list/* (server/mailingList.js). */
const mlState = { page: 1, pageSize: 50, search: '', status: '', previewToken: '', recipientCount: 0 };

async function pageMailingList() {
  if (!currentUserIsSuperAdmin) {
    view.innerHTML =
      '<div class="card error-card"><h2>Super admin only</h2><p>The mailing list belongs to the platform owner.</p></div>';
    return;
  }
  view.innerHTML = `
    <div class="page-head"><div><h1>Mailing list</h1><p class="lede">BitPype&rsquo;s own mailing list — subscribers you add yourself, and the newsletter you send them. Unsubscribed addresses stay on the list (marked) and are never emailed or silently re-subscribed.</p></div></div>
    <div class="stats-cards" id="ml-counts"><div class="stat-card"><div class="n">…</div><div class="l">Loading</div></div></div>
    <div class="card"><h3>Subscribers</h3>
      <div class="row">
        <div class="field"><label>Search</label><input id="ml-search" placeholder="Email or name" value="${esc(mlState.search)}" /></div>
        <div class="field"><label>Status</label><select id="ml-status">
          <option value="" ${mlState.status === '' ? 'selected' : ''}>All</option>
          <option value="subscribed" ${mlState.status === 'subscribed' ? 'selected' : ''}>Subscribed</option>
          <option value="unsubscribed" ${mlState.status === 'unsubscribed' ? 'selected' : ''}>Unsubscribed</option>
        </select></div>
      </div>
      <div id="ml-list"><p class="hint"><span class="load-spin" aria-hidden="true"></span> Loading…</p></div>
    </div>
    <div class="card"><h3>Add a subscriber</h3>
      <form id="ml-add-form"><div class="row">
        <div class="field"><label>Name (optional)</label><input name="name" placeholder="Ada Lovelace" /></div>
        <div class="field"><label>Email</label><input name="email" required placeholder="ada@example.com" /></div>
      </div><button class="btn" type="submit">Add subscriber</button> <span class="hint" id="ml-add-result"></span></form>
    </div>
    <div class="card"><h3>Import subscribers</h3>
      <p class="hint">Paste one email per line, or CSV (email,name). Duplicates and unsubscribed addresses are reported, never silently changed.</p>
      <div class="field"><textarea id="ml-import-text" rows="6" placeholder="ada@example.com, Ada Lovelace&#10;grace@example.com"></textarea></div>
      <button class="btn" id="ml-import-btn" type="button">Import</button> <span class="hint" id="ml-import-result"></span>
    </div>
    <div class="card"><h3>Compose newsletter</h3>
      <div class="field"><label>Subject</label><input id="ml-subject" placeholder="What&rsquo;s new at BitPype" /></div>
      <div class="field"><label>Body (HTML)</label><textarea id="ml-body" rows="10" placeholder="<p>Hi {{name}},</p><p>…</p>"></textarea></div>
      <p class="hint">Placeholders: <code>{{name}}</code>, <code>{{email}}</code>, <code>{{unsubscribe_url}}</code>. Anything else is sent literally. Every email carries its own signed unsubscribe link.</p>
      <button class="btn" id="ml-preview-btn" type="button">Preview</button>
      <div id="ml-preview"></div>
    </div>
    <div class="card"><h3>Send history</h3><div id="ml-history"><p class="hint">Loading…</p></div></div>`;

  const renderCounts = (counts) => {
    $('#ml-counts').innerHTML = `
      <div class="stat-card"><div class="n">${counts.total}</div><div class="l">Total</div></div>
      <div class="stat-card"><div class="n">${counts.subscribed}</div><div class="l">Subscribed</div></div>
      <div class="stat-card"><div class="n">${counts.unsubscribed}</div><div class="l">Unsubscribed</div></div>`;
  };

  const loadList = async () => {
    const box = $('#ml-list');
    try {
      const res = await api.adminMailingListSubscribers({
        page: mlState.page,
        pageSize: mlState.pageSize,
        search: mlState.search,
        status: mlState.status,
      });
      const d = res.data || {};
      renderCounts(d.counts || { total: 0, subscribed: 0, unsubscribed: 0 });
      const pages = Math.max(1, Math.ceil((d.total || 0) / mlState.pageSize));
      const rows = (d.rows || [])
        .map(
          (r) => `<tr>
            <td>${esc(r.email)}</td><td>${esc(r.name || '')}</td>
            <td>${r.status === 'subscribed' ? '<span class="badge ok">subscribed</span>' : '<span class="badge">unsubscribed</span>'}</td>
            <td>${esc(r.source || '')}</td><td>${esc(String(r.created_at || '').slice(0, 10))}</td>
            <td class="row-actions">
              ${r.status === 'subscribed'
                ? `<button class="btn small" data-ml-act="unsub" data-id="${r.id}">Unsubscribe</button>`
                : `<button class="btn small" data-ml-act="resub" data-id="${r.id}">Re-subscribe</button>`}
              <button class="btn small danger" data-ml-act="remove" data-id="${r.id}" data-email="${esc(r.email)}">Remove</button>
            </td></tr>`
        )
        .join('');
      box.innerHTML = `
        <table class="table"><thead><tr><th>Email</th><th>Name</th><th>Status</th><th>Source</th><th>Added</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan="6" class="hint">No subscribers match.</td></tr>'}</tbody></table>
        <div class="row pager">
          <button class="btn small" id="ml-prev" ${mlState.page <= 1 ? 'disabled' : ''}>← Prev</button>
          <span class="hint">Page ${mlState.page} of ${pages} · ${d.total || 0} matching</span>
          <button class="btn small" id="ml-next" ${mlState.page >= pages ? 'disabled' : ''}>Next →</button>
        </div>`;
      const prev = $('#ml-prev');
      if (prev) prev.onclick = () => { mlState.page--; loadList(); };
      const next = $('#ml-next');
      if (next) next.onclick = () => { mlState.page++; loadList(); };
      box.querySelectorAll('[data-ml-act]').forEach((b) => {
        b.onclick = async () => {
          const id = Number(b.dataset.id);
          try {
            if (b.dataset.mlAct === 'unsub') await api.adminMailingListUnsubscribe(id);
            else if (b.dataset.mlAct === 'resub') {
              if (!window.confirm('Re-subscribe this address? Only do this when they asked to come back.')) return;
              await api.adminMailingListResubscribe(id);
            } else if (b.dataset.mlAct === 'remove') {
              if (!window.confirm(`Remove ${b.dataset.email} from the mailing list entirely? This deletes the record.`)) return;
              await api.adminMailingListRemove(id);
            }
            toast('Mailing list updated', 'ok');
            loadList();
            loadHistory();
          } catch (e) {
            toast(errText(e), 'error');
          }
        };
      });
    } catch (e) {
      box.innerHTML = `<div class="card error-card"><p>${esc(errText(e))}</p></div>`;
    }
  };

  const loadHistory = async () => {
    const box = $('#ml-history');
    try {
      const res = await api.adminMailingListSends({ page: 1, pageSize: 50 });
      const d = res.data || {};
      const rows = (d.rows || [])
        .map(
          (r) => `<tr><td>${esc(String(r.created_at || '').slice(0, 16).replace('T', ' '))}</td><td>${esc(r.subject)}</td>
            <td>${r.attempted}</td><td>${r.sent}</td><td>${r.failed}</td><td>${r.skipped}</td></tr>`
        )
        .join('');
      box.innerHTML = `<table class="table"><thead><tr><th>Date</th><th>Subject</th><th>Attempted</th><th>Sent</th><th>Failed</th><th>Skipped (suppressed)</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="6" class="hint">No newsletters sent yet.</td></tr>'}</tbody></table>`;
    } catch (e) {
      box.innerHTML = `<p class="hint">${esc(errText(e))}</p>`;
    }
  };

  let searchTimer = null;
  $('#ml-search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      mlState.search = e.target.value.trim();
      mlState.page = 1;
      loadList();
    }, 300);
  });
  $('#ml-status').addEventListener('change', (e) => {
    mlState.status = e.target.value;
    mlState.page = 1;
    loadList();
  });

  $('#ml-add-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const out = $('#ml-add-result');
    try {
      const res = await api.adminMailingListAdd({ name: fd.get('name'), email: fd.get('email') });
      const d = res.data || {};
      out.textContent = d.added
        ? `Added ${d.subscriber.email}.`
        : d.reason === 'unsubscribed'
          ? `${d.subscriber.email} is unsubscribed — re-subscribe them from the list if they asked to come back.`
          : `${d.subscriber.email} is already on the list.`;
      e.target.reset();
      mlState.page = 1;
      loadList();
    } catch (err) {
      out.textContent = errText(err);
    }
  });

  $('#ml-import-btn').onclick = async () => {
    const out = $('#ml-import-result');
    const text = $('#ml-import-text').value;
    if (!text.trim()) { out.textContent = 'Paste at least one email first.'; return; }
    try {
      const res = await api.adminMailingListImport(text);
      const d = res.data || {};
      out.textContent = `Added ${d.added} · duplicates ${d.duplicates} · unsubscribed (not changed) ${d.blockedUnsubscribed} · invalid ${d.invalid.length}${d.invalid.length ? ': ' + d.invalid.slice(0, 5).join(' | ') : ''}`;
      mlState.page = 1;
      loadList();
    } catch (err) {
      out.textContent = errText(err);
    }
  };

  $('#ml-preview-btn').onclick = async () => {
    const box = $('#ml-preview');
    box.innerHTML = '<p class="hint">Rendering preview…</p>';
    try {
      const res = await api.adminMailingListPreview({
        subject: $('#ml-subject').value,
        bodyHtml: $('#ml-body').value,
      });
      const d = res.data || {};
      mlState.previewToken = d.previewToken;
      mlState.recipientCount = d.recipientCount;
      box.innerHTML = `
        <div class="card" style="margin-top:12px">
          <p class="hint">Preview for ${esc(d.sampleSubscriber.email)}${d.sampleSubscriber.real ? '' : ' (sample — the list is empty)'} · Subject: <strong>${esc(d.rendered.subject)}</strong></p>
          <iframe id="ml-preview-frame" sandbox="" style="width:100%;height:340px;border:1px solid #ddd;background:#fff" title="Newsletter preview"></iframe>
          <p><strong>${d.recipientCount}</strong> subscriber(s) will be emailed (${d.subscribedCount} subscribed, ${d.suppressedCount} skipped via the suppression list).</p>
          <button class="btn danger" id="ml-send-btn" type="button">Send newsletter to ${d.recipientCount} subscriber(s)</button>
          <span class="hint" id="ml-send-result"></span>
        </div>`;
      const frame = $('#ml-preview-frame');
      frame.srcdoc = `<!DOCTYPE html><html><body style="font-family:Georgia,serif;padding:16px">${d.rendered.html}</body></html>`;
      $('#ml-send-btn').onclick = async () => {
        if (!window.confirm(`Send this newsletter now to exactly ${mlState.recipientCount} subscriber(s)?`)) return;
        const out = $('#ml-send-result');
        try {
          const res2 = await api.adminMailingListSend({
            subject: $('#ml-subject').value,
            bodyHtml: $('#ml-body').value,
            previewToken: mlState.previewToken,
            confirmCount: mlState.recipientCount,
          });
          const s = res2.data || {};
          out.textContent = `Sent ${s.sent} of ${s.attempted} attempted (${s.failed} failed, ${s.skippedSuppressed} suppressed).`;
          toast('Newsletter sent', 'ok');
          loadHistory();
        } catch (err) {
          out.textContent = errText(err);
        }
      };
    } catch (err) {
      box.innerHTML = `<p class="hint">${esc(errText(err))}</p>`;
    }
  };

  loadList();
  loadHistory();
}

/* Batch 80 — partner earnings: the signed-in partner's balance,
   per-payment commission history, payout history, pending purchase
   approvals, and the partner terms block. Data: GET /partners/me +
   /partners/approvals (server/routes/partners.js). */
async function pagePartnerEarnings() {
  view.innerHTML = '<div class="card"><p class="hint">Loading your earnings…</p></div>';
  let me;
  let approvals;
  try {
    [me, approvals] = await Promise.all([
      withLoadTimeout(api.partnerMe()),
      withLoadTimeout(api.partnerApprovals()),
    ]);
  } catch (e) {
    view.innerHTML = loadErrorCardHtml(errText(e));
    wirePageRetry(() => pagePartnerEarnings());
    return;
  }
  const d = (me && me.data) || {};
  const money = (c) => moneyCents(c || 0, 'USD');
  const terms = d.terms || {};
  const entryRows = (d.entries || [])
    .map(
      (en) =>
        `<tr><td>${esc(String(en.createdAt || '').slice(0, 10))}</td><td>${esc(en.kind)}</td><td>${esc(en.stripeInvoiceId || en.note || '—')}</td><td style="text-align:right">${en.amountCents < 0 ? '−' : ''}${money(Math.abs(en.amountCents))}</td></tr>`
    )
    .join('');
  const payoutRows = (d.payouts || [])
    .map(
      (p) =>
        `<tr><td>${esc(String(p.createdAt || '').slice(0, 10))}</td><td>${esc(p.method || '—')}</td><td>${esc(p.note || '')}</td><td style="text-align:right">${money(p.amountCents)}</td></tr>`
    )
    .join('');
  const approvalRows = ((approvals && approvals.data && approvals.data.approvals) || [])
    .map(
      (a) =>
        `<tr><td>${esc(String(a.createdAt || '').slice(0, 10))}</td><td>${esc(a.actionKind)}</td><td>${esc(a.status)}</td></tr>`
    )
    .join('');
  view.innerHTML = `
  <div class="page-head"><h2>Partner earnings</h2></div>
  <div class="cards">
    <div class="card"><div class="panel-h"><h3>Your balance</h3></div>
      <p style="font-size:2rem;font-weight:800;margin:6px 0">${money(d.balanceCents)}</p>
      <p class="hint">${d.eligible ? 'Payout-eligible — payouts run monthly.' : `Payouts start at ${money(d.thresholdCents)}.`}</p>
    </div>
    <div class="card"><div class="panel-h"><h3>Your rate</h3></div>
      <p style="font-size:2rem;font-weight:800;margin:6px 0">${esc(d.ratePercent != null ? d.ratePercent : 30)}%</p>
      <p class="hint">of every subscription payment from customers in your workspace, credited when the payment clears.</p>
    </div>
  </div>
  <div class="card">
    <div class="panel-h"><h3>Payment history</h3><span class="hint">credits, refund/dispute reversals and payouts</span></div>
    <table class="table"><thead><tr><th>Date</th><th>Kind</th><th>Reference</th><th style="text-align:right">Amount</th></tr></thead>
    <tbody>${entryRows || '<tr><td colspan="4" class="hint">No earnings yet — your first customer payment lands here.</td></tr>'}</tbody></table>
  </div>
  <div class="card">
    <div class="panel-h"><h3>Payout history</h3></div>
    <table class="table"><thead><tr><th>Date</th><th>Method</th><th>Note</th><th style="text-align:right">Amount</th></tr></thead>
    <tbody>${payoutRows || '<tr><td colspan="4" class="hint">No payouts recorded yet.</td></tr>'}</tbody></table>
  </div>
  <div class="card">
    <div class="panel-h"><h3>Purchase approvals</h3><span class="hint">spends our team double-checks before they run</span></div>
    <table class="table"><thead><tr><th>Date</th><th>Action</th><th>Status</th></tr></thead>
    <tbody>${approvalRows || '<tr><td colspan="3" class="hint">No purchase requests yet.</td></tr>'}</tbody></table>
  </div>
  <div class="card">
    <div class="panel-h"><h3>Partner terms</h3></div>
    <p>${esc(terms.taxes || 'Payouts are gross — no tax is withheld. You are responsible for your own taxes on partner earnings.')}</p>
    <p>${esc(terms.support || 'You support your own customers day to day; the BitPype team backs you up on platform issues.')}</p>
    <p>${esc(terms.catalog || 'Partners sell the standard BitPype plans at the standard prices.')}</p>
    <p>${esc(terms.purchases || 'Anything that costs money is double-checked and approved by the BitPype team before it runs.')}</p>
  </div>`;
}

const PAGES = {
  dashboard: pageDashboard,
  leads: pageLeads,
  websites: pageWebsites,
  archives: pageArchives,
  domains: pageDomains,
  design: pageDesign,
  social: pageSocial,
  outreach: pageOutreach,
  pipeline: pagePipeline,
  forms: pageForms,
  leadscout: pageLeadScout,
  bookings: pageBookings,
  shop: pageShop,
  memberships: pageMemberships,
  calls: pageCalls,
  seo: pageSeo,
  rentals: pageRentals,
  modules: pageModules,
  courses: pageCourses,
  analytics: pageAnalytics,
  jobs: pageJobs,
  mcp: pageMcp,
  settings: pageSettings,
  billing: pageBilling,
  finance: pageFinance,
  'partner-earnings': pagePartnerEarnings,
  admin: pageAdmin,
  'mailing-list': pageMailingList,
};

async function navigate() {
  closeNav();
  Array.from(overlays).forEach((o) => o.close());
  let { route, param, query } = parseHash();

  if (!signedIn) {
    if (!PUBLIC_ROUTES.has(route)) return goToLogin();
    return renderAuth();
  }
  if (route === 'login' || route === 'register') {
    const next = consumeReturnHash();
    if (window.location.hash !== next) {
      history.replaceState(null, '', window.location.pathname + window.location.search + next);
    }
    ({ route, param, query } = parseHash());
    if (PUBLIC_ROUTES.has(route) || !PAGES[route]) {
      route = 'dashboard';
      param = '';
      query = {};
      if (window.location.hash !== '#/dashboard') {
        history.replaceState(null, '', window.location.pathname + window.location.search + '#/dashboard');
      }
    }
  }
  if (route === 'forgot' || route === 'reset') {
    return renderAuth();
  }
  if (route === 'invite' && param) {
    if (shell.classList.contains('hidden')) return renderAuth();
    try {
      const inv = await api.acceptInvite(param);
      if (inv.data && inv.data.workspaceId) {
        api.setWorkspaceId(inv.data.workspaceId);
        if (inv.data.workspaces) fillWorkspaces(inv.data.workspaces, inv.data.workspaceId);
      }
      if (inv.data && inv.data.productAccess != null) productAccess = !!inv.data.productAccess;
      toast('Invite accepted', 'ok');
    } catch (err) {
      toast(errText(err), 'err');
    }
    window.location.hash = '#/dashboard';
    return;
  }

  const paywalled = requireSubscription && !productAccess && !currentUserIsSuperAdmin;
  if (paywalled && route !== 'billing' && route !== 'admin') {
    window.location.hash = '#/billing';
    return;
  }
  updateBillingBanner();

  $$('.nav-links a').forEach((a) => {
    const on = a.dataset.route === route;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  syncNavGroups(route);
  topTitle.textContent = ROUTE_LABELS[route] || '';
  view.onclick = null;
  view.onchange = null;
  // Pipeline + Design/Website detail need the full main column (preview panes).
  view.classList.toggle('wide', route === 'pipeline' || ((route === 'design' || route === 'websites') && !!param));
  leadsReload = null;

  if (!PAGES[route]) {
    view.innerHTML =
      '<div class="card error-card"><h2>Page not found</h2><p>Choose a page from the navigation.</p></div>';
    return;
  }
  if ((route === 'admin' || route === 'mailing-list') && !currentUserIsSuperAdmin) {
    view.innerHTML =
      '<div class="card error-card"><h2>Super admin only</h2><p>Your account is not a platform administrator.</p></div>';
    return;
  }
  view.innerHTML = '<p class="hint"><span class="load-spin" aria-hidden="true"></span> Loading…</p>';
  try {
    await PAGES[route](param, query);
    window.scrollTo(0, 0);
    const main = $('.app-main');
    if (main) main.scrollTop = 0;
  } catch (err) {
    if (isAuthRequired(err)) return goToLogin();
    if (err.status === 402) {
      window.location.hash = '#/billing';
      return;
    }
    view.innerHTML = `<div class="card error-card"><h2>Page failed to load</h2><p>${esc(errText(err))}</p><p><button class="btn" data-act="page-retry">Retry</button></p></div>`;
    wirePageRetry(() => navigate());
  }
}

if (wsSelect) {
  wsSelect.addEventListener('change', async () => {
    const id = Number(wsSelect.value);
    api.setWorkspaceId(id);
    try {
      const r = await api.selectWorkspace(id);
      if (r.data && r.data.productAccess != null) productAccess = !!r.data.productAccess;
      if (r.data && r.data.subscribed != null) userSubscribed = !!r.data.subscribed;
    } catch (err) {
      toast(errText(err), 'err');
    }
    leadsState.selected.clear();
    try {
      await refreshAutomation();
    } catch {
      /* paywalled */
    }
    navigate();
  });
}

const logoutBtn = document.getElementById('logout-btn');
if (logoutBtn) {
  logoutBtn.addEventListener('click', async () => {
    try {
      await api.logout();
    } catch {
      /* ignore */
    }
    localStorage.removeItem('scout.workspaceId');
    goToLogin({ forgetReturn: true });
  });
}

if (autoEl) {
  autoEl.addEventListener('click', (e) => {
    e.preventDefault();
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      window.location.hash = '#/settings/automation';
      return;
    }
    const next = !automationPaused;
    if (!window.confirm(next ? 'Pause all automation (discovery, jobs, outreach, AI)?' : 'Resume automation?')) return;
    safeRun(null, async () => {
      await setAutomation(next);
      const { route } = parseHash();
      if (route === 'dashboard' || route === 'settings') navigate();
    });
  });
}

const menuBtn = document.getElementById('menu-btn');
const sidebarClose = document.getElementById('sidebar-close');
const sidebarBackdrop = document.getElementById('sidebar-backdrop');
if (menuBtn) menuBtn.addEventListener('click', openNav);
if (sidebarClose) sidebarClose.addEventListener('click', closeNav);
if (sidebarBackdrop) sidebarBackdrop.addEventListener('click', closeNav);
window.addEventListener('hashchange', navigate);

/* ---------- Batch 50: sidebar submenu groups ----------
 * Structure lives in public/js/navGroups.js (window.NavGroups): daily
 * drivers stay top-level, the rest sit in collapsible groups. State
 * persists per group in localStorage ('scout.navGroups'); the group
 * holding the current route always expands on navigation so the
 * active item is never hidden (see navResolveExpanded). */
const NAV_STORE_KEY = 'scout.navGroups';
let navStoredState = null;
function loadNavStored() {
  try {
    return JSON.parse(localStorage.getItem(NAV_STORE_KEY) || '{}') || {};
  } catch {
    return {};
  }
}
function saveNavStored(map) {
  try {
    localStorage.setItem(NAV_STORE_KEY, JSON.stringify(map));
  } catch {
    /* storage unavailable — expansion just won't persist */
  }
}
function applyNavGroups(map) {
  $$('.nav-section[data-nav-group]').forEach((sec) => {
    const open = !!map[sec.dataset.navGroup];
    sec.classList.toggle('collapsed', !open);
    const btn = sec.querySelector('[data-nav-toggle]');
    if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
}
function syncNavGroups(route) {
  if (!window.NavGroups) return;
  if (navStoredState === null) navStoredState = loadNavStored();
  navStoredState = window.NavGroups.navResolveExpanded(route, navStoredState);
  saveNavStored(navStoredState);
  applyNavGroups(navStoredState);
  const gid = window.NavGroups.navGroupForRoute(route);
  $$('[data-nav-toggle]').forEach((b) => b.classList.toggle('has-active', b.dataset.navToggle === gid));
}
function initNavGroups() {
  $$('[data-nav-toggle]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.navToggle;
      if (navStoredState === null) navStoredState = loadNavStored();
      navStoredState = { ...navStoredState, [id]: !navStoredState[id] };
      saveNavStored(navStoredState);
      applyNavGroups(navStoredState);
    });
  });
  syncNavGroups(parseHash().route);
}
initNavGroups();

(async function init() {
  if (typeof api.setOnAuthRequired === 'function') api.setOnAuthRequired(() => goToLogin());
  await loadRegistrationOpen();
  const { route } = parseHash();
  try {
    const me = await api.me();
    signedIn = true;
    if (me.data.workspaceId) api.setWorkspaceId(me.data.workspaceId);
    else if (api.getWorkspaceId()) await api.selectWorkspace(api.getWorkspaceId());
    if (route === 'forgot' || route === 'reset') return renderAuth();
    await bootApp(me.data);
  } catch (err) {
    signedIn = false;
    // AUTH_REQUIRED → login page. Other failures keep the session cookie;
    // tell the user to retry instead of implying they were signed out.
    if (isAuthRequired(err)) {
      goToLogin();
      return;
    }
    renderAuth();
    if (err && err.status === 403) {
      toast(errText(err), 'err');
      return;
    }
    if (err && err.status >= 500) {
      toast('Server temporarily unavailable — refresh in a moment.', 'err');
      return;
    }
    toast(errText(err), 'err');
  }
})();
