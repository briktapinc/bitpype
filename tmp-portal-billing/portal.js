'use strict';

(function () {
  const gate = document.getElementById('gate');
  const app = document.getElementById('app');
  const formAccess = document.getElementById('form-access');
  const formLogin = document.getElementById('form-login');
  const tabAccess = document.getElementById('tab-access');
  const tabLogin = document.getElementById('tab-login');

  let captchaAccess = { enabled: false, getToken: async () => '', reset: () => {} };
  let captchaLogin = { enabled: false, getToken: async () => '', reset: () => {} };
  let state = {
    client: null,
    year: null,
    month: null,
    posts: [],
    page: 1,
    pageSize: 6,
    imagePriceUsd: 1,
    socialImagesIncluded: false,
    previewUrl: null,
    siteEditable: false,
    editMode: false,
    editFullscreen: false,
    pendingEdits: new Map(),
    previewFrame: null,
    editableHtml: null,
  };

  const LOCKED_EDIT_PATH = /(^|\.)(phone|phone_display|email|address|address_lines|hours|rating|review_count|business_name|href|cta_href|cta_secondary_href|button_href|url|photographer|photographer_url|pexels_url)$/;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  async function api(path, opts = {}) {
    const res = await fetch(`/api/v1/portal${path}`, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
      ...opts,
    });
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok || !data || !data.ok) {
      const err = new Error((data && data.error) || `Request failed (${res.status})`);
      err.code = data && data.code;
      throw err;
    }
    return data.data;
  }

  function showGate() {
    gate.classList.remove('hidden');
    app.classList.add('hidden');
    state.siteEditable = false;
    state.editMode = false;
    state.editableHtml = null;
    state.previewFrame = null;
    state.pendingEdits.clear();
    setEditFullscreen(false);
    const editBtn = document.getElementById('btn-edit-mode');
    if (editBtn) editBtn.classList.add('hidden');
    syncFullscreenButtons();
  }

  function showApp() {
    gate.classList.add('hidden');
    app.classList.remove('hidden');
  }

  function setTab(which) {
    const access = which === 'access';
    tabAccess.setAttribute('aria-selected', access ? 'true' : 'false');
    tabLogin.setAttribute('aria-selected', access ? 'false' : 'true');
    formAccess.classList.toggle('hidden', !access);
    formLogin.classList.toggle('hidden', access);
  }

  tabAccess.onclick = () => setTab('access');
  tabLogin.onclick = () => setTab('login');

  async function mountCaptchas() {
    if (!window.ScoutCaptcha) return;
    try {
      captchaAccess = await window.ScoutCaptcha.mount(document.getElementById('captcha-access'));
    } catch (e) { console.warn(e); }
    try {
      captchaLogin = await window.ScoutCaptcha.mount(document.getElementById('captcha-login'));
    } catch (e) { console.warn(e); }
  }

  formAccess.onsubmit = async (ev) => {
    ev.preventDefault();
    const msg = document.getElementById('msg-access');
    const btn = document.getElementById('btn-access');
    msg.className = 'msg';
    msg.textContent = 'Sending…';
    btn.disabled = true;
    try {
      const captchaToken = await captchaAccess.getToken();
      const email = document.getElementById('access-email').value.trim();
      await api('/access', {
        method: 'POST',
        body: JSON.stringify({ email, captchaToken }),
      });
      msg.className = 'msg ok';
      msg.textContent = 'If we have a project for that email, a password is on its way. Check your inbox, then log in.';
      document.getElementById('login-email').value = email;
      setTab('login');
      try { captchaAccess.reset && captchaAccess.reset(); } catch { /* */ }
    } catch (e) {
      msg.className = 'msg err';
      msg.textContent = e.message;
      try { captchaAccess.reset && captchaAccess.reset(); } catch { /* */ }
    } finally {
      btn.disabled = false;
    }
  };

  formLogin.onsubmit = async (ev) => {
    ev.preventDefault();
    const msg = document.getElementById('msg-login');
    const btn = document.getElementById('btn-login');
    msg.className = 'msg';
    msg.textContent = 'Signing in…';
    btn.disabled = true;
    try {
      const captchaToken = await captchaLogin.getToken();
      const data = await api('/login', {
        method: 'POST',
        body: JSON.stringify({
          email: document.getElementById('login-email').value.trim(),
          password: document.getElementById('login-password').value,
          captchaToken,
        }),
      });
      state.client = data.client;
      document.getElementById('login-password').value = '';
      try { captchaLogin.reset && captchaLogin.reset(); } catch { /* */ }
      await loadDashboard();
    } catch (e) {
      msg.className = 'msg err';
      msg.textContent = e.message === 'INVALID_CREDENTIALS'
        ? 'Email or password is incorrect.'
        : e.message;
      try { captchaLogin.reset && captchaLogin.reset(); } catch { /* */ }
    } finally {
      btn.disabled = false;
    }
  };

  document.getElementById('btn-logout').onclick = async () => {
    try { await api('/logout', { method: 'POST', body: '{}' }); } catch { /* */ }
    state.client = null;
    showGate();
    await mountCaptchas();
  };

  function setOpenPreview(previewUrl) {
    const openBtn = document.getElementById('btn-open-preview');
    if (!openBtn) return;
    if (!previewUrl) {
      openBtn.classList.add('hidden');
      openBtn.setAttribute('href', '#');
      return;
    }
    openBtn.href = previewUrl;
    openBtn.classList.remove('hidden');
  }

  function postEditModeToFrame(on) {
    const frame = state.previewFrame;
    if (!frame || !frame.contentWindow) return;
    try {
      frame.contentWindow.postMessage({ source: 'ws-portal', type: 'edit-mode', on: !!on }, '*');
    } catch { /* */ }
  }

  function syncFullscreenButtons() {
    const enter = document.getElementById('btn-enter-fullscreen');
    const exit = document.getElementById('btn-exit-fullscreen');
    const canFs = !!state.siteEditable;
    if (enter) {
      if (canFs && !state.editFullscreen) enter.classList.remove('hidden');
      else enter.classList.add('hidden');
    }
    if (exit) {
      if (canFs && state.editFullscreen) exit.classList.remove('hidden');
      else exit.classList.add('hidden');
    }
  }

  function setEditFullscreen(on) {
    const next = !!(on && state.siteEditable);
    state.editFullscreen = next;
    const sec = document.getElementById('sec-preview');
    if (sec) sec.classList.toggle('is-edit-fullscreen', next);
    document.body.classList.toggle('is-preview-fullscreen', next);
    syncFullscreenButtons();
  }

  function syncEditModeUi() {
    const btn = document.getElementById('btn-edit-mode');
    const label = document.getElementById('btn-edit-mode-label');
    const box = document.getElementById('preview-box');
    const lede = document.getElementById('preview-lede');
    const on = !!(state.siteEditable && state.editMode);

    if (btn) {
      if (state.siteEditable) btn.classList.remove('hidden');
      else btn.classList.add('hidden');
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.classList.toggle('ghost', on);
      btn.classList.toggle('soft', !on);
    }
    if (label) label.textContent = on ? 'Done' : 'Edit';
    if (box) box.classList.toggle('is-edit-mode', on);
    if (lede && state.siteEditable) {
      lede.textContent = on
        ? 'Edit mode on — click highlighted text in the preview to change it, then Save.'
        : 'Click Edit to change copy in the preview. Use Request changes below for bigger updates.';
    }
    if (!state.siteEditable && state.editFullscreen) setEditFullscreen(false);
    else syncFullscreenButtons();
    postEditModeToFrame(on);
    updateEditBar();
  }

  function setEditMode(on, opts = {}) {
    if (!state.siteEditable) {
      state.editMode = false;
      setEditFullscreen(false);
      syncEditModeUi();
      return;
    }
    state.editMode = !!on;
    if (opts.fullscreen === true) setEditFullscreen(true);
    else if (opts.fullscreen === false) setEditFullscreen(false);
    else if (on) setEditFullscreen(true);
    else setEditFullscreen(false);
    syncEditModeUi();
  }

  function updateEditBar() {
    const bar = document.getElementById('edit-bar');
    const hint = document.getElementById('edit-hint');
    const saveBtn = document.getElementById('btn-edit-save');
    const n = state.pendingEdits.size;
    if (!bar) return;
    const show = state.siteEditable && (state.editMode || n > 0);
    bar.hidden = !show;
    if (!show) return;
    if (hint) {
      if (n > 0) {
        hint.innerHTML = `<strong>${n} unsaved edit${n === 1 ? '' : 's'}</strong> — Save to update your live preview, or Cancel to discard.`;
      } else {
        hint.innerHTML = '<strong>Edit mode</strong> — click any highlighted text in the preview to change it.';
      }
    }
    if (saveBtn) saveBtn.disabled = n === 0;
  }

  function clearPendingEdits() {
    state.pendingEdits.clear();
    const msg = document.getElementById('msg-edit');
    if (msg) {
      msg.className = 'msg';
      msg.textContent = '';
    }
    updateEditBar();
  }

  function renderStaticPreview(previewUrl) {
    const box = document.getElementById('preview-box');
    state.previewFrame = null;
    state.siteEditable = false;
    state.editMode = false;
    state.editableHtml = null;
    clearPendingEdits();
    setEditFullscreen(false);
    setOpenPreview(previewUrl);
    syncEditModeUi();
    const lede = document.getElementById('preview-lede');
    if (!previewUrl) {
      box.innerHTML = '<div class="preview-empty" id="preview-empty">No preview is available yet. We’ll notify you when it’s ready.</div>';
      if (lede) lede.textContent = 'Live look at the current site we built for you.';
      return;
    }
    if (lede) {
      lede.textContent = 'Live look at your site. Use Request changes below for updates — this preview is view-only.';
    }
    box.innerHTML = `
      <iframe title="Website preview" src="${esc(previewUrl)}" loading="lazy" referrerpolicy="no-referrer"></iframe>`;
  }

  function renderEditableHtml(html, previewUrl) {
    const box = document.getElementById('preview-box');
    const lede = document.getElementById('preview-lede');
    state.siteEditable = true;
    state.editableHtml = html || '';
    state.editMode = false;
    setOpenPreview(previewUrl);
    if (lede) {
      lede.textContent = 'Click Edit to change copy in the preview. Use Request changes below for bigger updates.';
    }
    box.innerHTML = `
      <iframe title="Website preview" id="portal-preview-frame"
        sandbox="allow-scripts allow-same-origin"
        referrerpolicy="no-referrer"></iframe>`;
    const frame = document.getElementById('portal-preview-frame');
    state.previewFrame = frame;
    frame.addEventListener('load', () => {
      if (state.editMode) postEditModeToFrame(true);
    });
    frame.srcdoc = html || '<p style="font-family:sans-serif;padding:1rem">Empty preview.</p>';
    syncEditModeUi();
  }

  async function loadEditablePreview(fallbackUrl) {
    try {
      const data = await api('/site/render?editable=1');
      if (data && data.previewUrl) state.previewUrl = data.previewUrl;
      const url = (data && data.previewUrl) || fallbackUrl || state.previewUrl;
      if (data && data.editable && data.html) {
        renderEditableHtml(data.html, url);
        return;
      }
      renderStaticPreview(url || fallbackUrl);
    } catch (e) {
      if (fallbackUrl || state.previewUrl) {
        renderStaticPreview(fallbackUrl || state.previewUrl);
      } else {
        renderStaticPreview(null);
      }
    }
  }

  window.addEventListener('message', (ev) => {
    const frame = state.previewFrame;
    if (!frame || ev.source !== frame.contentWindow) return;
    const data = ev.data;
    if (!data || data.source !== 'ws-preview') return;
    if (!state.siteEditable) return;
    if (data.type === 'ready') {
      if (state.editMode) postEditModeToFrame(true);
      return;
    }
    const id = String(data.id || '');
    if (!id || !state.editMode) return;
    const text = String(data.text || '').replace(/\s+/g, ' ').trim();
    // Freeform HTML text nodes: html:pageIndex:nodeIndex
    if (/^html:\d+:\d+$/.test(id)) {
      state.pendingEdits.set(id, text);
      updateEditBar();
      return;
    }
    const m = id.match(/^(\d+):(\d+):(.+)$/);
    if (!m || LOCKED_EDIT_PATH.test(m[3])) return;
    state.pendingEdits.set(id, text);
    updateEditBar();
  });

  function daysInMonth(y, m) {
    return new Date(Date.UTC(y, m, 0)).getUTCDate();
  }

  function formatWhen(iso) {
    return esc(String(iso || '').replace('T', ' ').slice(0, 16)) + ' UTC';
  }

  function money(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return '$1.00';
    return `$${v.toFixed(2)}`;
  }

  function absoluteUrl(u) {
    const s = String(u || '').trim();
    if (!s) return '';
    if (/^https?:\/\//i.test(s)) return s;
    if (s.startsWith('/')) return `${location.origin}${s}`;
    return s;
  }

  function renderPostPage() {
    const list = document.getElementById('post-list');
    const pager = document.getElementById('post-pager');
    const info = document.getElementById('post-page-info');
    const posts = state.posts;
    if (!posts.length) {
      list.innerHTML = '<p class="hint">No posts this month yet. Generate a week or a month below.</p>';
      pager.hidden = true;
      return;
    }

    const pages = Math.max(1, Math.ceil(posts.length / state.pageSize));
    if (state.page > pages) state.page = pages;
    if (state.page < 1) state.page = 1;
    const start = (state.page - 1) * state.pageSize;
    const slice = posts.slice(start, start + state.pageSize);
    const priceLabel = money(state.imagePriceUsd);

    list.innerHTML = slice.map((p) => {
      const img = absoluteUrl(p.image_url);
      const platforms = (p.platforms || []).map((x) => esc(x)).join(', ');
      const media = img
        ? `<div class="post-media"><img src="${esc(img)}" alt="Post image" loading="lazy" /></div>`
        : `<div class="post-media">No image yet</div>`;
      return `
        <article class="post-card" data-post-id="${esc(p.id)}">
          ${media}
          <div class="post-body">
            <div class="post-meta">
              <span>${formatWhen(p.scheduled_at)}</span>
              <span class="platforms">${platforms || 'facebook, instagram'}</span>
              <span class="status-pill">${esc(p.status || 'draft')}</span>
            </div>
            <p class="post-cap">${esc(p.caption || '')}</p>
            <div class="post-actions">
              <button type="button" class="btn soft small" data-act="gen-image" data-id="${esc(p.id)}">
                Generate branded image ad (${state.socialImagesIncluded ? 'included' : priceLabel})
              </button>
              <button type="button" class="btn ghost small" data-act="share-native" data-id="${esc(p.id)}">Share</button>
              <button type="button" class="btn ghost small" data-act="share-fb" data-id="${esc(p.id)}">Facebook</button>
              <button type="button" class="btn ghost small" data-act="share-ig" data-id="${esc(p.id)}">Instagram</button>
              <button type="button" class="btn ghost small" data-act="copy" data-id="${esc(p.id)}">Copy caption</button>
            </div>
          </div>
        </article>`;
    }).join('');

    pager.hidden = pages <= 1;
    info.textContent = `Showing ${start + 1}–${Math.min(start + state.pageSize, posts.length)} of ${posts.length}`;
    document.getElementById('post-prev').disabled = state.page <= 1;
    document.getElementById('post-next').disabled = state.page >= pages;
  }

  function findPost(id) {
    return state.posts.find((p) => Number(p.id) === Number(id));
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        return true;
      } catch {
        return false;
      }
    }
  }

  async function sharePost(post, mode) {
    const msg = document.getElementById('msg-social');
    const caption = String((post && post.caption) || '');
    const img = absoluteUrl(post && post.image_url);
    if (mode === 'copy') {
      const ok = await copyText(caption);
      msg.className = ok ? 'msg ok' : 'msg err';
      msg.textContent = ok ? 'Caption copied.' : 'Could not copy caption.';
      return;
    }
    if (mode === 'native') {
      if (navigator.share) {
        try {
          await navigator.share({
            title: document.getElementById('biz-name').textContent || 'Social post',
            text: caption,
            url: img || location.href,
          });
          msg.className = 'msg ok';
          msg.textContent = 'Share sheet opened.';
          return;
        } catch (e) {
          if (e && e.name === 'AbortError') return;
        }
      }
      const ok = await copyText(caption + (img ? `\n${img}` : ''));
      msg.className = ok ? 'msg ok' : 'msg err';
      msg.textContent = ok
        ? 'Copied caption' + (img ? ' and image link' : '') + ' — paste into your app.'
        : 'Sharing is not available in this browser.';
      return;
    }
    if (mode === 'fb') {
      const target = img || location.href;
      window.open(
        `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(target)}&quote=${encodeURIComponent(caption)}`,
        '_blank',
        'noopener,noreferrer'
      );
      msg.className = 'msg ok';
      msg.textContent = 'Facebook share opened. Paste the caption if the quote field is empty.';
      return;
    }
    if (mode === 'ig') {
      await copyText(caption);
      if (img) window.open(img, '_blank', 'noopener,noreferrer');
      window.open('https://www.instagram.com/', '_blank', 'noopener,noreferrer');
      msg.className = 'msg ok';
      msg.textContent = 'Caption copied. Open the image, save it, then create an Instagram post.';
    }
  }

  async function generateBrandedImage(postId) {
    const msg = document.getElementById('msg-social');
    const btn = document.querySelector(`[data-act="gen-image"][data-id="${postId}"]`);
    msg.className = 'msg';
    const chargeHint = state.socialImagesIncluded ? 'included in Premium' : money(state.imagePriceUsd);
    msg.textContent = `Generating branded image ad (${chargeHint})…`;
    if (btn) btn.disabled = true;
    try {
      const data = await api(`/social/posts/${postId}/image`, {
        method: 'POST',
        body: '{}',
      });
      const idx = state.posts.findIndex((p) => Number(p.id) === Number(postId));
      if (idx >= 0 && data.post) {
        state.posts[idx] = Object.assign({}, state.posts[idx], data.post, {
          image_url: data.image_url || data.post.image_url,
          with_image: true,
        });
      } else if (idx >= 0 && data.image_url) {
        state.posts[idx] = Object.assign({}, state.posts[idx], {
          image_url: data.image_url,
          with_image: true,
        });
      }
      if (data.included_in_plan) state.socialImagesIncluded = true;
      else if (data.price_usd != null) state.imagePriceUsd = Number(data.price_usd);
      renderPostPage();
      msg.className = 'msg ok';
      msg.textContent = data.included_in_plan || Number(data.price_usd) === 0
        ? 'Branded image ready — included in your plan.'
        : `Branded image ready. Charged ${money(data.price_usd != null ? data.price_usd : state.imagePriceUsd)}.`;
    } catch (e) {
      msg.className = 'msg err';
      msg.textContent = e.message;
      if (btn) btn.disabled = false;
    }
  }

  function renderCalendar(cal) {
    state.year = cal.year;
    state.month = cal.month;
    state.posts = Array.isArray(cal.posts) ? cal.posts.slice() : [];
    state.page = 1;
    if (cal.image_price_usd != null && Number.isFinite(Number(cal.image_price_usd))) {
      state.imagePriceUsd = Number(cal.image_price_usd);
    }
    state.socialImagesIncluded = !!cal.social_images_included || Number(cal.image_price_usd) === 0;
    const label = new Date(Date.UTC(cal.year, cal.month - 1, 1))
      .toLocaleString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
    document.getElementById('cal-label').textContent = label;
    document.getElementById('cal-lede').textContent = `${label} · ${state.posts.length} post(s)`;

    const priceHint = document.getElementById('image-price-hint');
    priceHint.hidden = false;
    priceHint.textContent = `Branded image ads: ${money(state.imagePriceUsd)} each (charged when you generate).`;

    const byDay = new Map();
    for (const p of state.posts) {
      const day = Number(String(p.scheduled_at || '').slice(8, 10));
      if (!day) continue;
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push(p);
    }

    const first = new Date(Date.UTC(cal.year, cal.month - 1, 1));
    const startPad = first.getUTCDay(); // 0 Sun
    const total = daysInMonth(cal.year, cal.month);
    const heads = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
      .map((h) => `<div class="cal-head">${h}</div>`).join('');
    let cells = '';
    for (let i = 0; i < startPad; i += 1) cells += '<div class="cal-cell muted"></div>';
    for (let d = 1; d <= total; d += 1) {
      const posts = byDay.get(d) || [];
      const dots = posts.slice(0, 2).map((p) =>
        `<span class="dot" title="${esc(p.status)}">${esc((p.caption || '').slice(0, 28))}</span>`
      ).join('');
      const more = posts.length > 2 ? `<span class="dot">+${posts.length - 2}</span>` : '';
      cells += `<div class="cal-cell"><div class="d">${d}</div>${dots}${more}</div>`;
    }
    document.getElementById('cal-grid').innerHTML = heads + cells;
    renderPostPage();
  }

  async function loadCalendar() {
    const now = new Date();
    const data = await api(`/calendar?year=${now.getUTCFullYear()}&month=${now.getUTCMonth() + 1}`);
    renderCalendar(data);
  }

  function portalCheckoutFlag() {
    try {
      return new URLSearchParams(location.search).get('checkout') || '';
    } catch {
      return '';
    }
  }

  function clearPortalCheckoutQuery() {
    try {
      const url = new URL(location.href);
      if (!url.searchParams.has('checkout') && !url.searchParams.has('plan')) return;
      url.searchParams.delete('checkout');
      url.searchParams.delete('plan');
      history.replaceState({}, '', url.pathname + url.search + url.hash);
    } catch { /* ignore */ }
  }

  function renderPlanCards(b) {
    const grid = document.getElementById('bill-plan-grid');
    if (!grid) return;
    const currentPlan = String(b.plan || 'free');
    const canSelfServe = !!(b.canSelfServe != null ? b.canSelfServe : b.canManage);
    const hasCustomer = !!b.hasCustomer;
    const subscribed = currentPlan !== 'free' && (
      b.workspaceSubscribed
      || ['active', 'trialing', 'past_due'].includes(String(b.subscriptionStatus || ''))
    );
    const plans = Array.isArray(b.plans) && b.plans.length
      ? b.plans
      : [
        { id: 'free', name: 'Free', priceLabel: 'Free', tagline: 'Launch a site and edit it yourself.', features: [], checkout: false, priceConfigured: true },
        { id: 'standard', name: 'Standard', priceLabel: 'Monthly', tagline: 'Monthly support with pay-per-image social ads.', features: [], checkout: true, priceConfigured: false },
        { id: 'premium', name: 'Premium', priceLabel: 'Monthly', tagline: 'Weekly support with social images included.', features: [], checkout: true, priceConfigured: false },
      ];

    grid.innerHTML = plans.map((p) => {
      const isCurrent = p.id === currentPlan || (p.id === 'free' && currentPlan === 'free');
      let cta = '';
      if (p.id === 'free') {
        cta = isCurrent
          ? '<span class="hint">Current plan</span>'
          : '<span class="hint">Downgrade via Manage subscription after cancel</span>';
      } else if (isCurrent && subscribed) {
        cta = '<span class="hint">Current plan</span>';
      } else if (!p.priceConfigured) {
        cta = '<span class="hint">Price not configured yet</span>';
      } else if (!canSelfServe) {
        cta = '<span class="hint">Contact Bitpype to change plans</span>';
      } else if (!hasCustomer || (p.checkout && !subscribed)) {
        cta = `<button class="btn" type="button" data-checkout-plan="${esc(p.id)}">Subscribe</button>`;
      } else {
        cta = '<span class="hint">Use Manage subscription to change plans</span>';
      }
      const featuredNote = p.id === 'premium'
        ? '<p class="plan-tagline" style="color:var(--accent);font-weight:550">Social images included — no per-image charge.</p>'
        : '';
      return `<div class="plan-card${isCurrent ? ' is-current' : ''}${p.id === 'premium' ? ' is-featured' : ''}">
        <div class="plan-card-h">
          <h3>${esc(p.name)}</h3>
          <div class="plan-price">${esc(p.priceLabel || '')}</div>
        </div>
        <p class="plan-tagline">${esc(p.tagline || '')}</p>
        ${featuredNote}
        <ul class="plan-features">${(p.features || []).map((f) => `<li>${esc(f)}</li>`).join('')}</ul>
        <div class="plan-cta">${cta}</div>
      </div>`;
    }).join('');

    grid.querySelectorAll('[data-checkout-plan]').forEach((btn) => {
      btn.onclick = () => startPortalCheckout(btn.getAttribute('data-checkout-plan'));
    });
  }

  async function loadBilling() {
    const b = await api('/billing');
    const pill = document.getElementById('bill-status');
    const planId = String(b.plan || 'free');
    const status = String(b.subscriptionStatus || (planId === 'free' ? 'free' : 'none'));
    const planName = b.planName || (planId.charAt(0).toUpperCase() + planId.slice(1));
    pill.textContent = status === 'trialing' ? 'Trialing'
      : status === 'past_due' ? 'Past due'
      : status === 'active' || b.workspaceSubscribed ? 'Active'
      : planId === 'free' ? 'Free' : status;
    pill.className = 'status-pill'
      + (status === 'past_due' ? ' warn' : '')
      + (status === 'canceled' ? ' bad' : '');
    const planEl = document.getElementById('bill-plan-name');
    if (planEl) planEl.textContent = planName + ' plan';

    const end = b.currentPeriodEnd
      ? new Date(String(b.currentPeriodEnd).replace(' ', 'T') + (String(b.currentPeriodEnd).includes('Z') ? '' : 'Z'))
      : null;
    document.getElementById('bill-renewal').textContent = end && Number.isFinite(end.getTime())
      ? `Renews / period ends ${end.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}.`
      : (planId === 'free'
        ? 'You’re on Free — upgrade anytime for support. Premium includes social images.'
        : 'Your service is currently covered.');
    const noticeEl = document.getElementById('bill-notice');
    noticeEl.textContent = b.notice || '';
    noticeEl.hidden = !b.notice;

    const banner = document.getElementById('bill-checkout-banner');
    const flag = portalCheckoutFlag();
    if (banner) {
      if (flag === 'success') {
        banner.hidden = false;
        banner.className = 'bill-alert ok';
        banner.innerHTML = '<strong>Payment received.</strong> Plan updates when Stripe confirms.';
        clearPortalCheckoutQuery();
      } else if (flag === 'cancel') {
        banner.hidden = false;
        banner.className = 'bill-alert warn';
        banner.textContent = 'Checkout canceled — no charge was made.';
        clearPortalCheckoutQuery();
      } else {
        banner.hidden = true;
        banner.textContent = '';
      }
    }

    const manage = document.getElementById('btn-manage-billing');
    const canSelfServe = !!(b.canSelfServe != null ? b.canSelfServe : b.canManage);
    if (manage) manage.hidden = !(canSelfServe && b.hasCustomer);

    renderPlanCards(b);
  }

  async function loadDashboard() {
    const me = await api('/me');
    state.client = me.client;
    state.previewUrl = me.previewUrl || null;
    document.getElementById('biz-name').textContent = (me.lead && me.lead.business_name)
      || me.client.businessName
      || 'Your project';
    const bits = [
      me.client.email,
      me.lead && [me.lead.city, me.lead.state].filter(Boolean).join(', '),
      me.site && me.site.name,
    ].filter(Boolean);
    document.getElementById('biz-meta').textContent = bits.join(' · ');
    showApp();
    await Promise.all([
      loadEditablePreview(me.previewUrl),
      loadCalendar(),
      loadBilling(),
    ]);
  }

  document.getElementById('btn-edit-mode').onclick = () => {
    if (!state.siteEditable) return;
    if (state.editMode) {
      // Done: leave edit mode + fullscreen; keep any unsaved edits in the bar
      setEditMode(false, { fullscreen: false });
    } else {
      setEditMode(true, { fullscreen: true });
    }
  };

  document.getElementById('btn-enter-fullscreen').onclick = () => {
    if (!state.siteEditable) return;
    if (!state.editMode) setEditMode(true, { fullscreen: true });
    else setEditFullscreen(true);
  };

  document.getElementById('btn-exit-fullscreen').onclick = () => {
    // Close / Esc: exit overlay only — do not discard pending edits
    setEditFullscreen(false);
  };

  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    if (!state.editFullscreen) return;
    ev.preventDefault();
    setEditFullscreen(false);
  });

  document.getElementById('btn-edit-cancel').onclick = async () => {
    const keepMode = state.editMode;
    const keepFs = state.editFullscreen;
    clearPendingEdits();
    await loadEditablePreview(state.previewUrl);
    if (keepMode && state.siteEditable) setEditMode(true, { fullscreen: keepFs });
    else if (keepFs && state.siteEditable) setEditFullscreen(true);
  };

  document.getElementById('btn-edit-save').onclick = async () => {
    const msg = document.getElementById('msg-edit');
    const btn = document.getElementById('btn-edit-save');
    const cancel = document.getElementById('btn-edit-cancel');
    if (!state.pendingEdits.size) return;
    const keepMode = state.editMode;
    const keepFs = state.editFullscreen;
    msg.className = 'msg';
    msg.textContent = 'Saving…';
    btn.disabled = true;
    cancel.disabled = true;
    try {
      const edits = [...state.pendingEdits.entries()].map(([id, text]) => ({ id, text }));
      const data = await api('/site/edits', {
        method: 'POST',
        body: JSON.stringify({ edits }),
      });
      if (data && data.previewUrl) state.previewUrl = data.previewUrl;
      clearPendingEdits();
      msg.className = 'msg ok';
      msg.textContent = `Saved ${data.applied || edits.length} change${(data.applied || edits.length) === 1 ? '' : 's'}. Updating preview…`;
      await loadEditablePreview(state.previewUrl);
      if (keepMode && state.siteEditable) setEditMode(true, { fullscreen: keepFs });
      else if (keepFs && state.siteEditable) setEditFullscreen(true);
      msg.className = 'msg ok';
      msg.textContent = 'Saved. Your public preview is up to date.';
      setTimeout(() => {
        if (msg.textContent.indexOf('Saved') === 0) {
          msg.className = 'msg';
          msg.textContent = '';
        }
      }, 4000);
    } catch (e) {
      msg.className = 'msg err';
      msg.textContent = e.message;
    } finally {
      btn.disabled = false;
      cancel.disabled = false;
      updateEditBar();
    }
  };

  document.getElementById('form-changes').onsubmit = async (ev) => {
    ev.preventDefault();
    const msg = document.getElementById('msg-changes');
    const btn = document.getElementById('btn-changes');
    msg.className = 'msg';
    msg.textContent = 'Sending…';
    btn.disabled = true;
    try {
      await api('/changes', {
        method: 'POST',
        body: JSON.stringify({
          kind: document.getElementById('change-kind').value,
          message: document.getElementById('change-message').value.trim(),
        }),
      });
      msg.className = 'msg ok';
      msg.textContent = 'Request received — we’ll take it from here.';
      document.getElementById('change-message').value = '';
    } catch (e) {
      msg.className = 'msg err';
      msg.textContent = e.message;
    } finally {
      btn.disabled = false;
    }
  };

  async function generate(period) {
    const msg = document.getElementById('msg-social');
    const weekBtn = document.getElementById('gen-week');
    const monthBtn = document.getElementById('gen-month');
    msg.className = 'msg';
    msg.textContent = period === 'week' ? 'Generating a week…' : 'Generating a month…';
    weekBtn.disabled = true;
    monthBtn.disabled = true;
    try {
      await api('/social/generate', {
        method: 'POST',
        body: JSON.stringify({ period }),
      });
      msg.className = 'msg ok';
      msg.textContent = 'Content queued. Refreshing calendar…';
      await loadCalendar();
      msg.textContent = 'New posts added to your calendar.';
    } catch (e) {
      msg.className = 'msg err';
      msg.textContent = e.message;
    } finally {
      weekBtn.disabled = false;
      monthBtn.disabled = false;
    }
  }

  document.getElementById('gen-week').onclick = () => generate('week');
  document.getElementById('gen-month').onclick = () => generate('month');

  document.getElementById('post-prev').onclick = () => {
    if (state.page > 1) {
      state.page -= 1;
      renderPostPage();
    }
  };
  document.getElementById('post-next').onclick = () => {
    const pages = Math.max(1, Math.ceil(state.posts.length / state.pageSize));
    if (state.page < pages) {
      state.page += 1;
      renderPostPage();
    }
  };

  document.getElementById('post-list').onclick = async (ev) => {
    const btn = ev.target.closest('[data-act]');
    if (!btn) return;
    const id = btn.getAttribute('data-id');
    const post = findPost(id);
    if (!post) return;
    const act = btn.getAttribute('data-act');
    if (act === 'gen-image') return generateBrandedImage(id);
    if (act === 'share-native') return sharePost(post, 'native');
    if (act === 'share-fb') return sharePost(post, 'fb');
    if (act === 'share-ig') return sharePost(post, 'ig');
    if (act === 'copy') return sharePost(post, 'copy');
  };

  document.getElementById('btn-manage-billing').onclick = async () => {
    const msg = document.getElementById('msg-billing');
    msg.className = 'msg';
    msg.textContent = 'Opening billing…';
    try {
      const data = await api('/billing/portal', { method: 'POST', body: '{}' });
      if (data.url) location.href = data.url;
      else throw new Error('No portal URL returned');
    } catch (e) {
      msg.className = 'msg err';
      msg.textContent = e.message;
    }
  };

  async function startPortalCheckout(plan) {
    const msg = document.getElementById('msg-billing');
    msg.className = 'msg';
    msg.textContent = 'Opening checkout…';
    try {
      const data = await api('/billing/checkout', {
        method: 'POST',
        body: JSON.stringify({ plan }),
      });
      if (data.url) location.href = data.url;
      else throw new Error('No checkout URL returned');
    } catch (e) {
      msg.className = 'msg err';
      msg.textContent = e.message;
    }
  }

  (async function boot() {
    await mountCaptchas();
    try {
      await loadDashboard();
    } catch (err) {
      showGate();
      const authFail = err && (
        err.code === 'AUTH_REQUIRED'
        || err.message === 'AUTH_REQUIRED'
      );
      if (!authFail && err && err.message) {
        const msg = document.getElementById('msg-login');
        if (msg) {
          msg.className = 'msg err';
          msg.textContent = /unavailable|failed|network|fetch/i.test(err.message)
            ? 'Could not restore your session — check your connection and refresh.'
            : err.message;
        }
      }
    }
  })();
})();
