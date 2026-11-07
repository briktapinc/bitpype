'use strict';

(function () {
  const gate = document.getElementById('gate');
  const app = document.getElementById('app');
  const formAccess = document.getElementById('form-access');
  const formLogin = document.getElementById('form-login');
  const formMfa = document.getElementById('form-mfa');
  const formSetpwRequest = document.getElementById('form-setpw-request');
  const formSetpw = document.getElementById('form-setpw');
  const tabAccess = document.getElementById('tab-access');
  const tabLogin = document.getElementById('tab-login');

  let captchaAccess = { enabled: false, getToken: async () => '', reset: () => {} };
  let captchaLogin = { enabled: false, getToken: async () => '', reset: () => {} };
  let captchaSetpw = { enabled: false, getToken: async () => '', reset: () => {} };
  let upsellTipEpoch = 0;
  let upsellTipTimer = null;
  let upsellTipReturnFocus = null;
  let state = {
    client: null,
    year: null,
    month: null,
    posts: [],
    page: 1,
    pageSize: 6,
    imagePriceUsd: 1,
    imageCredits: 1,
    contentCredits: 1,
    creditsBalance: 0,
    creditsConfigured: false,
    creditsPackLabel: 'Credits pack',
    socialImagesIncluded: false,
    metaConfigured: false,
    socialAccountsCount: 0,
    previewUrl: null,
    hasSite: false,
    publishBusy: false,
    siteEditable: false,
    editMode: false,
    editFullscreen: false,
    pendingEdits: new Map(),
    canUndo: false,
    previewFrame: null,
    editableHtml: null,
    imageUploading: false,
    logoUploading: false,
    logo: { mode: 'text', url: null, publicUrl: null, brandName: null },
    aiImageSrc: null,
    entitlements: {},
    plan: 'free',
    themeOpen: false,
    themeSaving: false,
    theme: { primary: '#1a56db', secondary: '#0e2a5c', bg: '#ffffff', text: '#1f2937', font: '', headingFont: '', customCss: '', customJs: '', customHead: '' },
    themeSaved: { primary: '#1a56db', secondary: '#0e2a5c', bg: '#ffffff', text: '#1f2937', font: '', headingFont: '', customCss: '', customJs: '', customHead: '' },
    /** Colors currently painted in the preview iframe (role + palette hexes). */
    themeLive: { primary: '#1a56db', secondary: '#0e2a5c', bg: '#ffffff', text: '#1f2937' },
    /** Extra colors from site CSS: [{ original, current, roles }] */
    themePalette: [],
    selectedEditId: '',
    structureOpen: false,
    structureBusy: false,
    // Batch 147 — native section (layout) editor session.
    layoutOpen: false,
    layoutBusy: false,
    layout: null,
    structurePageIdx: 0,
    structureInsertAfter: 0,
    canvasPick: null,
    structure: null,
    previewPageSlug: null,
    agentChatBusy: false,
    agentChatHistory: [],
    agentChatPending: [],
    agentChatHistoryLoaded: false,
    agentChatCollapsed: false,
    agentChatServerIds: new Set(),
    // Batch 104: optimistic preview patches currently shown in
    // the preview iframe, keyed by patch id. A patch is a
    // PROVISIONAL render only — the verified build is the truth
    // and replaces it (see resolveAgentChatPatches).
    agentChatPatches: new Map(),
  };

  const THEME_KEYS = ['primary', 'secondary', 'bg', 'text'];
  // Batch 152 — owner global code fields in the theme bar.
  const CODE_FIELD_IDS = { customCss: 'theme-custom-css', customJs: 'theme-custom-js', customHead: 'theme-custom-head' };
  const CODE_FIELD_MAX = 100000;
  const THEME_VAR = { primary: '--ws-primary', secondary: '--ws-secondary', bg: '--ws-bg', text: '--ws-text' };

  const LOCKED_EDIT_PATH =
    /(^|\.)(phone|phone_display|email|address|address_lines|hours|rating|review_count|business_name|href|cta_href|cta_secondary_href|button_href|url|photographer|photographer_url|pexels_url)$/;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  async function api(path, opts = {}) {
    const res = await fetch(`/api/v1/portal${path}`, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
      ...opts,
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!res.ok || !data || !data.ok) {
      const detail = data && data.error;
      const nested = detail && typeof detail === 'object' ? detail : null;
      const message =
        (typeof detail === 'string' && detail) ||
        (nested && typeof nested.message === 'string' && nested.message) ||
        res.statusText ||
        `Request failed (${res.status})`;
      const err = new Error(message);
      err.code =
        (nested && typeof nested.code === 'string' && nested.code) ||
        (data && typeof data.code === 'string' && data.code) ||
        (typeof detail === 'string' && /^[A-Z][A-Z0-9_]+$/.test(detail) && detail) ||
        undefined;
      err.status = res.status;
      err.data = data;
      // Batch 54: carry the server's error reference id for errText().
      err.ref =
        (nested && typeof nested.ref === 'string' && nested.ref) ||
        (data && typeof data.ref === 'string' && data.ref) ||
        undefined;
      if (
        res.status === 401 &&
        (err.code === 'AUTH_REQUIRED' || err.code === 'SESSION_IDLE' || err.message === 'AUTH_REQUIRED')
      ) {
        showPortalLogin();
        if (err.code === 'SESSION_IDLE') {
          const msg = document.getElementById('msg-login');
          if (msg) {
            msg.className = 'msg err';
            msg.textContent = errText(err);
          }
        }
      }
      throw err;
    }
    return data.data;
  }

  const PORTAL_PANELS = [
    'website',
    'changes',
    'forms',
    'leadscout',
    'modules',
    'social',
    'referrals',
    'mcp',
    'soul',
    'analytics',
    'seo',
    'rentals',
    'billing',
    'gbp',
    'wordpress',
  ];
  // Batch 78: routed sub-pages that live under a nav tab (converted
  // from modal popups — pages, not popups). Not nav tabs themselves:
  // visibility follows the parent tab's Batch 29 user-type rules.
  const PORTAL_SUBPANELS = ['module-item'];
  const PORTAL_SUBPANEL_PARENT = { 'module-item': 'modules' };
  // Batch 29: the /me payload carries the tabs this user may open
  // (user type defaults + admin overrides, computed server-side in
  // portalTabs.js). null = no restriction info (show everything).
  // The API enforces the same set with 403s — this only drives the nav.
  let portalVisibleTabs = null;
  function portalTabVisible(id) {
    return !portalVisibleTabs || portalVisibleTabs.includes(id);
  }
  function applyPortalVisibleTabs() {
    document.querySelectorAll('#portal-nav [data-panel]').forEach((btn) => {
      const id = btn.getAttribute('data-panel');
      if (id === 'mcp') {
        btn.hidden = !portalTabVisible('mcp') || !state.mcpPaid;
      } else {
        btn.hidden = !portalTabVisible(id);
      }
    });
  }
  // Batch 119: while the account is suspended, only the Billing nav
  // item stays visible and a banner explains the state (the API
  // enforces the same narrowing). Built with DOM APIs only.
  function applyPortalSuspension() {
    document.querySelectorAll('#portal-nav [data-panel]').forEach((btn) => {
      if (btn.getAttribute('data-panel') !== 'billing') btn.hidden = true;
    });
    if (document.getElementById('portal-suspension-banner')) return;
    const banner = document.createElement('div');
    banner.id = 'portal-suspension-banner';
    banner.className = 'alert danger';
    const strong = document.createElement('strong');
    strong.textContent = 'Account suspended — payment failed.';
    banner.appendChild(strong);
    banner.appendChild(
      document.createTextNode(
        ' Your website is unavailable to visitors until your plan is renewed. Renew on the Billing panel to restore everything, exactly as it was.'
      )
    );
    const main = document.querySelector('main.portal-content');
    if (main) main.prepend(banner);
  }
  const PANEL_ALIASES = {
    website: 'website',
    preview: 'website',
    site: 'website',
    changes: 'changes',
    change: 'changes',
    request: 'changes',
    forms: 'forms',
    form: 'forms',
    submissions: 'forms',
    modules: 'modules',
    module: 'modules',
    blog: 'modules',
    shop: 'modules',
    ecommerce: 'modules',
    courses: 'modules',
    gallery: 'modules',
    directory: 'modules',
    social: 'social',
    calendar: 'social',
    posts: 'social',
    referrals: 'referrals',
    referral: 'referrals',
    refer: 'referrals',
    billing: 'billing',
    analytics: 'analytics',
    tracking: 'analytics',
    seo: 'seo',
    rentals: 'rentals',
    rented: 'rentals',
    rental: 'rentals',
    plans: 'billing',
    subscribe: 'billing',
    mcp: 'mcp',
    agent: 'mcp',
    muse: 'mcp',
    cursor: 'mcp',
    soul: 'soul',
    'agent-soul': 'soul',
    wordpress: 'wordpress',
    wp: 'wordpress',
  };

  function resolvePortalPanel(raw) {
    const key = String(raw || '')
      .toLowerCase()
      .trim();
    if (!key) return null;
    if (PANEL_ALIASES[key]) return PANEL_ALIASES[key];
    if (PORTAL_PANELS.includes(key)) return key;
    if (PORTAL_SUBPANELS.includes(key)) return key;
    return null;
  }

  function parsePortalPanelQuery() {
    try {
      const panel = new URLSearchParams(location.search).get('panel');
      if (!panel) return null;
      return resolvePortalPanel(panel);
    } catch {
      return null;
    }
  }

  function parsePortalHash() {
    // Hash wins once set. ?panel= is only a deep-link seed (OAuth / emails).
    // Preferring query over hash made tab clicks snap back after hashchange.
    const raw = String(location.hash || '')
      .replace(/^#\/?/, '')
      .trim()
      .toLowerCase();
    const key = raw.split(/[/?&#]/)[0] || '';
    if (key) return resolvePortalPanel(key);
    return parsePortalPanelQuery();
  }

  function panelHash(panel) {
    return `#/${panel}`;
  }

  function clearPortalPanelQuery() {
    try {
      const url = new URL(location.href);
      if (!url.searchParams.has('panel')) return;
      url.searchParams.delete('panel');
      history.replaceState(null, '', url.pathname + url.search + url.hash);
    } catch {
      /* ignore */
    }
  }

  let portalAuthed = false;

  function showPortalLogin() {
    portalAuthed = false;
    showGate();
    if (!location.hash) return;
    const panel = parsePortalHash();
    const url = new URL(location.href);
    if (panel && !url.searchParams.get('panel')) url.searchParams.set('panel', panel);
    url.hash = '';
    history.replaceState(null, '', url.pathname + url.search);
  }

  function showPortalPanel(panel, opts = {}) {
    if (!portalAuthed) {
      showPortalLogin();
      return null;
    }
    let next =
      PORTAL_PANELS.includes(panel) || PORTAL_SUBPANELS.includes(panel) ? panel : 'website';
    // Batch 29: a deep link / hash naming a tab this user cannot open
    // lands on their first visible tab instead. Batch 78: sub-pages
    // inherit their parent tab's visibility, exactly as the popup did.
    const nextParent = PORTAL_SUBPANEL_PARENT[next] || next;
    if (!portalTabVisible(nextParent)) {
      next = PORTAL_PANELS.find((p) => portalTabVisible(p)) || 'website';
    }
    // Batch 78: a bare #/module-item landing (refresh, back/forward)
    // with no editor prepared goes to Modules instead of an empty page.
    if (next === 'module-item') {
      const fieldsEl = document.getElementById('modules-fields');
      if (!fieldsEl || !fieldsEl.children.length) next = 'modules';
    }
    // Batch 119: a suspended account can only open the Billing panel.
    if (state.suspension && next !== 'billing') next = 'billing';
    // Batch 40: switching tabs always closes the Security section.
    const secSecurityEl = document.getElementById('sec-security');
    if (secSecurityEl) secSecurityEl.hidden = true;
    if (next !== 'website' && state.editFullscreen) setEditFullscreen(false);

    PORTAL_PANELS.forEach((id) => {
      const sec = document.querySelector(`section.portal-panel[data-panel="${id}"]`);
      const tab = document.querySelector(`#portal-nav [data-panel="${id}"]`);
      const active = id === next;
      if (sec) {
        if (active) sec.removeAttribute('hidden');
        else sec.setAttribute('hidden', '');
      }
      if (tab) {
        tab.setAttribute('aria-selected', active ? 'true' : 'false');
        tab.tabIndex = active ? 0 : -1;
      }
    });

    // Batch 78: sub-page sections toggle with the panels; the parent
    // tab shows as the active nav item while a sub-page is open.
    PORTAL_SUBPANELS.forEach((id) => {
      const sec = document.querySelector(`section.portal-panel[data-panel="${id}"]`);
      if (!sec) return;
      if (id === next) sec.removeAttribute('hidden');
      else sec.setAttribute('hidden', '');
    });
    if (PORTAL_SUBPANEL_PARENT[next]) {
      const parentTab = document.querySelector(
        `#portal-nav [data-panel="${PORTAL_SUBPANEL_PARENT[next]}"]`
      );
      if (parentTab) {
        parentTab.setAttribute('aria-selected', 'true');
        parentTab.tabIndex = 0;
      }
    }

    const wrap = document.querySelector('.wrap');
    if (wrap) wrap.classList.toggle('is-website-wide', next === 'website');

    if (next === 'mcp' && state.mcpPaid) refreshMcpTokens().catch(() => {});
    if (next === 'soul' && typeof loadAgentSoul === 'function') loadAgentSoul().catch(() => {});
    if (next === 'changes') loadChangesHistory().catch(() => {});
    if (next === 'referrals') loadReferrals().catch(() => {});
    if (next === 'analytics') loadAnalytics();
    if (next === 'seo' && typeof loadSeoTool === 'function') loadSeoTool().catch(() => {});
    if (next === 'rentals' && typeof loadRentals === 'function') loadRentals().catch(() => {});
    if (next === 'forms') loadForms().catch(() => {});
    if (next === 'leadscout') loadLeadScout().catch(() => {});
    if (next === 'modules') loadModules().catch(() => {});
    if (next === 'social') {
      loadCalendar().catch(() => {});
      loadSocialAccounts().catch(() => {});
    }
    if (next === 'billing') loadBilling().catch(() => {});
    if (next === 'gbp' && typeof loadGbpPanel === 'function') loadGbpPanel().catch(() => {});
    if (next === 'wordpress' && typeof loadWordpressPanel === 'function') loadWordpressPanel().catch(() => {});

    if (opts.updateHash !== false) {
      const want = panelHash(next);
      if (location.hash !== want) {
        if (opts.replaceHash) history.replaceState(null, '', want);
        else location.hash = want;
      }
      // Drop sticky ?panel= so later hashchanges (and bookmarks) follow the tab.
      clearPortalPanelQuery();
    }
    return next;
  }

  function syncPortalPanelFromHash(opts = {}) {
    let panel = parsePortalHash();
    if (!panel && portalCheckoutFlag()) panel = 'billing';
    if (!panel) panel = 'website';
    return showPortalPanel(panel, { updateHash: true, replaceHash: true, ...opts });
  }

  // Register early so a later setup error cannot leave tabs dead.
  const portalNav = document.getElementById('portal-nav');
  if (portalNav) {
    portalNav.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-panel]');
      if (!btn || !portalNav.contains(btn)) return;
      showPortalPanel(btn.getAttribute('data-panel'));
    });
    portalNav.addEventListener('keydown', (ev) => {
      const tabs = [...portalNav.querySelectorAll('[data-panel]')].filter((t) => !t.hidden);
      const current = tabs.findIndex((t) => t.getAttribute('aria-selected') === 'true');
      if (current < 0) return;
      let next = -1;
      if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') next = (current + 1) % tabs.length;
      else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp') next = (current - 1 + tabs.length) % tabs.length;
      else if (ev.key === 'Home') next = 0;
      else if (ev.key === 'End') next = tabs.length - 1;
      if (next < 0) return;
      ev.preventDefault();
      showPortalPanel(tabs[next].getAttribute('data-panel'));
      tabs[next].focus();
    });
  }
  window.addEventListener('hashchange', () => {
    if (!portalAuthed) {
      showPortalLogin();
      return;
    }
    syncPortalPanelFromHash();
  });

  function showGate() {
    hideUpsellTip();
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
    const themeBtn = document.getElementById('btn-theme-colors');
    if (themeBtn) themeBtn.classList.add('hidden');
    const structBtn = document.getElementById('btn-structure');
    if (structBtn) structBtn.classList.add('hidden');
    state.themeOpen = false;
    state.structureOpen = false;
    state.structure = null;
    const themeBar = document.getElementById('theme-bar');
    if (themeBar) themeBar.hidden = true;
    const backupBar = document.getElementById('backup-bar');
    if (backupBar) backupBar.hidden = true;
    const structBar = document.getElementById('structure-bar');
    if (structBar) structBar.hidden = true;
    syncFullscreenButtons();
  }

  function showApp() {
    portalAuthed = true;
    gate.classList.add('hidden');
    app.classList.remove('hidden');
    syncPortalPanelFromHash();
  }

  function setTab(which) {
    const access = which === 'access';
    tabAccess.setAttribute('aria-selected', access ? 'true' : 'false');
    tabLogin.setAttribute('aria-selected', access ? 'false' : 'true');
    formAccess.classList.toggle('hidden', !access);
    formLogin.classList.toggle('hidden', access);
    if (formMfa) formMfa.classList.add('hidden');
    if (formSetpwRequest) formSetpwRequest.classList.add('hidden');
    if (formSetpw) formSetpw.classList.add('hidden');
  }

  tabAccess.onclick = () => setTab('access');
  tabLogin.onclick = () => setTab('login');

  async function mountCaptchas() {
    if (!window.ScoutCaptcha) return;
    try {
      captchaAccess = await window.ScoutCaptcha.mount(document.getElementById('captcha-access'));
    } catch (e) {
      console.warn(e);
    }
    try {
      captchaLogin = await window.ScoutCaptcha.mount(document.getElementById('captcha-login'));
    } catch (e) {
      console.warn(e);
    }
    try {
      captchaSetpw = await window.ScoutCaptcha.mount(document.getElementById('captcha-setpw'));
    } catch (e) {
      console.warn(e);
    }
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
      msg.textContent =
        'If that email matches a project, a one-time sign-in link is on its way. Check your inbox — we never invent passwords for unknown emails.';
      try {
        captchaAccess.reset && captchaAccess.reset();
      } catch {
        /* */
      }
    } catch (e) {
      msg.className = 'msg err';
      msg.textContent = errText(e);
      try {
        captchaAccess.reset && captchaAccess.reset();
      } catch {
        /* */
      }
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
      document.getElementById('login-password').value = '';
      try {
        captchaLogin.reset && captchaLogin.reset();
      } catch {
        /* */
      }
      // Batch 40: opt-in TOTP — the password was right, but no session
      // exists until the code step completes.
      if (data && data.mfaRequired) {
        showMfaForm();
        return;
      }
      state.client = data.client;
      await loadDashboard();
    } catch (e) {
      msg.className = 'msg err';
      msg.textContent = errText(e);
      try {
        captchaLogin.reset && captchaLogin.reset();
      } catch {
        /* */
      }
    } finally {
      btn.disabled = false;
    }
  };

  // Batch 121 — set / reset password. Portal accounts are usually
  // provisioned with a random password nobody knows (sign-in is by
  // emailed link), so a real password is created through an emailed
  // one-time link: the signed-out form asks for one, and the emailed
  // /portal?setpw=<token> link opens the set form (see boot).
  let pendingSetpwToken = '';

  function showSetpwRequest() {
    showGate();
    setTab('login');
    if (formLogin) formLogin.classList.add('hidden');
    if (formSetpwRequest) formSetpwRequest.classList.remove('hidden');
    const input = document.getElementById('setpw-email');
    if (input) input.focus();
  }

  function showSetpwForm() {
    showGate();
    if (formAccess) formAccess.classList.add('hidden');
    if (formLogin) formLogin.classList.add('hidden');
    if (formMfa) formMfa.classList.add('hidden');
    if (formSetpwRequest) formSetpwRequest.classList.add('hidden');
    if (formSetpw) formSetpw.classList.remove('hidden');
    const input = document.getElementById('setpw-password');
    if (input) input.focus();
  }

  function setpwConfirmError(e) {
    const code = e && e.code;
    if (code === 'TOKEN_EXPIRED')
      return 'That set-password link expired — links last 1 hour. Request a fresh one from the log-in screen.';
    if (code === 'TOKEN_USED' || code === 'INVALID_TOKEN')
      return 'That set-password link is no longer valid. Request a fresh one from the log-in screen.';
    if (code === 'WEAK_PASSWORD') return 'Use at least 8 characters.';
    return errText(e);
  }

  const linkSetpw = document.getElementById('link-setpw');
  if (linkSetpw) {
    linkSetpw.onclick = (ev) => {
      ev.preventDefault();
      showSetpwRequest();
    };
  }
  const linkSetpwBack = document.getElementById('link-setpw-back');
  if (linkSetpwBack) {
    linkSetpwBack.onclick = (ev) => {
      ev.preventDefault();
      showGate();
      setTab('login');
    };
  }

  if (formSetpwRequest) {
    formSetpwRequest.onsubmit = async (ev) => {
      ev.preventDefault();
      const msg = document.getElementById('msg-setpw-request');
      const btn = document.getElementById('btn-setpw-request');
      msg.className = 'msg';
      msg.textContent = 'Sending…';
      btn.disabled = true;
      try {
        const captchaToken = await captchaSetpw.getToken();
        await api('/password-set/request-by-email', {
          method: 'POST',
          body: JSON.stringify({
            email: document.getElementById('setpw-email').value.trim(),
            captchaToken,
          }),
        });
        msg.className = 'msg ok';
        msg.textContent =
          'If that email matches an account, a link to set a new password is on its way. It expires in 1 hour and can only be used once.';
        try {
          captchaSetpw.reset && captchaSetpw.reset();
        } catch {
          /* */
        }
      } catch (e) {
        msg.className = 'msg err';
        msg.textContent = errText(e);
        try {
          captchaSetpw.reset && captchaSetpw.reset();
        } catch {
          /* */
        }
      } finally {
        btn.disabled = false;
      }
    };
  }

  if (formSetpw) {
    formSetpw.onsubmit = async (ev) => {
      ev.preventDefault();
      const msg = document.getElementById('msg-setpw');
      const btn = document.getElementById('btn-setpw');
      const pw = document.getElementById('setpw-password').value;
      const confirm = document.getElementById('setpw-confirm').value;
      if (pw.length < 8) {
        msg.className = 'msg err';
        msg.textContent = 'Use at least 8 characters.';
        return;
      }
      if (pw !== confirm) {
        msg.className = 'msg err';
        msg.textContent = 'The two passwords do not match.';
        return;
      }
      msg.className = 'msg';
      msg.textContent = 'Saving…';
      btn.disabled = true;
      try {
        await api('/password-set/confirm', {
          method: 'POST',
          body: JSON.stringify({ token: pendingSetpwToken, password: pw }),
        });
        pendingSetpwToken = '';
        document.getElementById('setpw-password').value = '';
        document.getElementById('setpw-confirm').value = '';
        msg.className = 'msg ok';
        msg.textContent = 'Password set.';
        // If this browser still holds a portal session, walk straight
        // back in; otherwise land on the log-in form with the news.
        try {
          await loadDashboard();
        } catch {
          showPortalLogin();
          setTab('login');
          const loginMsg = document.getElementById('msg-login');
          if (loginMsg) {
            loginMsg.className = 'msg ok';
            loginMsg.textContent = 'Password set — sign in with your new password.';
          }
        }
      } catch (e) {
        msg.className = 'msg err';
        msg.textContent = setpwConfirmError(e);
      } finally {
        btn.disabled = false;
      }
    };
  }

  // Batch 40 — portal second-factor step (opt-in TOTP). Shown after a
  // correct password or magic link when the account has MFA enabled;
  // the server holds only a challenge until /mfa/verify succeeds.
  let mfaUseRecovery = false;
  function showMfaForm() {
    showGate();
    setTab('login');
    if (!formMfa) return;
    formLogin.classList.add('hidden');
    formAccess.classList.add('hidden');
    formMfa.classList.remove('hidden');
    const msg = document.getElementById('msg-mfa');
    if (msg) {
      msg.className = 'msg';
      msg.textContent = 'Your password was accepted — one more step.';
    }
    const input = document.getElementById('mfa-code');
    if (input) input.focus();
  }

  const mfaToggle = document.getElementById('mfa-toggle');
  if (mfaToggle) {
    mfaToggle.addEventListener('click', (ev) => {
      ev.preventDefault();
      mfaUseRecovery = !mfaUseRecovery;
      const input = document.getElementById('mfa-code');
      const label = document.getElementById('mfa-code-label');
      if (label) label.textContent = mfaUseRecovery ? 'Recovery code' : 'Authenticator code';
      if (input) {
        input.placeholder = mfaUseRecovery ? 'XXXX-XXXX' : '123456';
        input.setAttribute('inputmode', mfaUseRecovery ? 'text' : 'numeric');
        input.value = '';
        input.focus();
      }
      mfaToggle.textContent = mfaUseRecovery ? 'Use my authenticator app instead' : 'Use a recovery code instead';
    });
  }

  if (formMfa) {
    formMfa.onsubmit = async (ev) => {
      ev.preventDefault();
      const msg = document.getElementById('msg-mfa');
      const btn = document.getElementById('btn-mfa');
      msg.className = 'msg';
      msg.textContent = 'Checking…';
      btn.disabled = true;
      try {
        const data = await api('/mfa/verify', {
          method: 'POST',
          body: JSON.stringify({ code: document.getElementById('mfa-code').value.trim() }),
        });
        state.client = data.client;
        formMfa.classList.add('hidden');
        await loadDashboard();
      } catch (e) {
        msg.className = 'msg err';
        msg.textContent = errText(e);
      } finally {
        btn.disabled = false;
      }
    };
  }

  document.getElementById('btn-logout').onclick = async () => {
    try {
      await api('/logout', { method: 'POST', body: '{}' });
    } catch {
      /* */
    }
    state.client = null;
    showPortalLogin();
    await mountCaptchas();
  };

  // Batch 40 — Account security section (opt-in TOTP management). Not a
  // portal tab: it sits outside the Batch 29 tab system so every
  // signed-in client (owner or renter) can reach it, and the API
  // routes are mounted with the core session routes server-side.
  const secSecurity = document.getElementById('sec-security');
  const securityBody = document.getElementById('security-body');

  function showSecurity() {
    if (!secSecurity) return;
    document.querySelectorAll('section.portal-panel').forEach((sec) => sec.setAttribute('hidden', ''));
    secSecurity.hidden = false;
    loadMfaSecurity();
  }
  function hideSecurity() {
    if (secSecurity) secSecurity.hidden = true;
  }
  const btnSecurity = document.getElementById('btn-security');
  if (btnSecurity) btnSecurity.onclick = () => showSecurity();
  const btnSecurityClose = document.getElementById('btn-security-close');
  if (btnSecurityClose) {
    btnSecurityClose.onclick = () => {
      hideSecurity();
      syncPortalPanelFromHash();
    };
  }

  async function loadMfaSecurity() {
    if (!securityBody) return;
    securityBody.innerHTML = '<p class="hint">Loading…</p>';
    try {
      const data = await api('/mfa');
      renderMfaSecurity(!!data.enabled);
    } catch (e) {
      securityBody.innerHTML = `<p class="msg err">${esc(errText(e))}</p>`;
    }
  }

  // Batch 121: the password confirm on this section is a dead end for
  // magic-link users (their account password is random and unknown).
  // A failed confirm now points at the remedy, and the remedy — an
  // emailed set-password link — sits right under the button.
  const MFA_PASSWORD_HINT =
    "That password didn't match. If you sign in with email links, you may not have a password yet — use the link below to set one.";
  function mfaPwError(e) {
    return e && e.code === 'INVALID_CREDENTIALS' ? MFA_PASSWORD_HINT : errText(e);
  }
  function wireMfaSetpwLink() {
    const link = document.getElementById('mfa-sec-setpw');
    if (!link) return;
    link.onclick = async (ev) => {
      ev.preventDefault();
      const msg = document.getElementById('mfa-sec-setpw-msg');
      if (msg) {
        msg.className = 'msg';
        msg.textContent = 'Sending…';
      }
      try {
        await api('/password-set/request', { method: 'POST', body: '{}' });
        if (msg) {
          msg.className = 'msg ok';
          msg.textContent =
            'A link to set your password is on its way to your account email. Set it, then come back here.';
        }
      } catch (e) {
        if (msg) {
          msg.className = 'msg err';
          msg.textContent = errText(e);
        }
      }
    };
  }

  function renderMfaSecurity(enabled, recoveryCodes) {
    if (!securityBody) return;
    if (recoveryCodes && recoveryCodes.length) {
      securityBody.innerHTML = `
        <p><strong>Two-factor authentication is on.</strong> Save these recovery codes somewhere safe — if you lose your authenticator app, one of these codes signs you in once. They will not be shown again.</p>
        <div class="mfa-codes">${recoveryCodes.map((c) => `<code>${esc(c)}</code>`).join('')}</div>
        <button type="button" class="btn" id="mfa-sec-done">I've saved my codes</button>`;
      document.getElementById('mfa-sec-done').onclick = () => renderMfaSecurity(true);
      return;
    }
    if (enabled) {
      securityBody.innerHTML = `
        <p><strong>Two-factor authentication is on.</strong> Signing in asks for a 6-digit code from your authenticator app after your password.</p>
        <p class="hint">To turn it off, enter your password and a current code (or a recovery code).</p>
        <div class="field"><label for="mfa-sec-password">Password</label><input id="mfa-sec-password" type="password" autocomplete="current-password" /></div>
        <div class="field"><label for="mfa-sec-code">Authenticator or recovery code</label><input id="mfa-sec-code" type="text" autocomplete="one-time-code" placeholder="123456 or XXXX-XXXX" /></div>
        <button type="button" class="btn" id="mfa-sec-disable">Turn off two-factor authentication</button>
        <p class="msg" id="mfa-sec-msg"></p>
        <p class="hint"><a href="#" id="mfa-sec-setpw">Don't know your password? Email me a link to set one.</a></p>
        <p class="msg" id="mfa-sec-setpw-msg"></p>`;
      wireMfaSetpwLink();
      document.getElementById('mfa-sec-disable').onclick = async () => {
        const msg = document.getElementById('mfa-sec-msg');
        msg.className = 'msg';
        msg.textContent = 'Checking…';
        try {
          await api('/mfa/disable', {
            method: 'POST',
            body: JSON.stringify({
              password: document.getElementById('mfa-sec-password').value,
              code: document.getElementById('mfa-sec-code').value.trim(),
            }),
          });
          renderMfaSecurity(false);
        } catch (e) {
          msg.className = 'msg err';
          msg.textContent = mfaPwError(e);
        }
      };
      return;
    }
    securityBody.innerHTML = `
      <p><strong>Two-factor authentication is off.</strong> Turn it on and signing in will also ask for a 6-digit code from an authenticator app (Google Authenticator, Authy, 1Password…) after your password.</p>
      <div class="field"><label for="mfa-sec-password">Confirm your password to set it up</label><input id="mfa-sec-password" type="password" autocomplete="current-password" /></div>
      <button type="button" class="btn" id="mfa-sec-start">Set up two-factor authentication</button>
      <p class="msg" id="mfa-sec-msg"></p>
      <p class="hint"><a href="#" id="mfa-sec-setpw">Don't know your password? Email me a link to set one.</a></p>
      <p class="msg" id="mfa-sec-setpw-msg"></p>
      <div id="mfa-sec-enroll"></div>`;
    wireMfaSetpwLink();
    document.getElementById('mfa-sec-start').onclick = async () => {
      const msg = document.getElementById('mfa-sec-msg');
      msg.className = 'msg';
      msg.textContent = 'Preparing…';
      try {
        const data = await api('/mfa/enroll/start', {
          method: 'POST',
          body: JSON.stringify({ password: document.getElementById('mfa-sec-password').value }),
        });
        msg.textContent = '';
        const host = document.getElementById('mfa-sec-enroll');
        host.innerHTML = `
          <div class="mfa-qr"><img src="${data.qrDataUrl}" alt="Authenticator setup QR code" width="220" height="220" /></div>
          <p class="hint mfa-key">Can't scan? Enter this key in the app manually:<br /><code>${esc(data.secret || '')}</code></p>
          <div class="field"><label for="mfa-sec-code">6-digit code from the app</label><input id="mfa-sec-code" type="text" inputmode="numeric" autocomplete="one-time-code" placeholder="123456" /></div>
          <button type="button" class="btn" id="mfa-sec-confirm">Confirm and turn on</button>
          <p class="msg" id="mfa-sec-msg2"></p>`;
        document.getElementById('mfa-sec-confirm').onclick = async () => {
          const msg2 = document.getElementById('mfa-sec-msg2');
          msg2.className = 'msg';
          msg2.textContent = 'Checking…';
          try {
            const done = await api('/mfa/enroll/confirm', {
              method: 'POST',
              body: JSON.stringify({ code: document.getElementById('mfa-sec-code').value.trim() }),
            });
            renderMfaSecurity(true, done.recoveryCodes || []);
          } catch (e) {
            msg2.className = 'msg err';
            msg2.textContent = errText(e);
          }
        };
      } catch (e) {
        msg.className = 'msg err';
        msg.textContent = mfaPwError(e);
      }
    };
  }

  function syncPublishButton() {
    const pubBtn = document.getElementById('btn-publish-site');
    if (!pubBtn) return;
    const show = !!(state.hasSite || state.previewUrl || state.siteEditable);
    pubBtn.classList.toggle('hidden', !show);
  }

  function setOpenPreview(previewUrl) {
    const openBtn = document.getElementById('btn-open-preview');
    if (openBtn) {
      if (!previewUrl) {
        openBtn.classList.add('hidden');
        openBtn.setAttribute('href', '#');
      } else {
        openBtn.href = previewUrl;
        openBtn.classList.remove('hidden');
      }
    }
    syncPublishButton();
  }

  function publishSuccessMessage(data) {
    const via = data && data.via;
    if (via === 'cloudflare') return 'Published. Your public preview is up to date.';
    if (via === 'app_url') return 'Published. Your preview link has been refreshed.';
    if (data && data.publicPreviewUpdated) return 'Published. Preview updated.';
    return 'Published.';
  }

  async function publishSitePreview() {
    const btn = document.getElementById('btn-publish-site');
    const label = document.getElementById('btn-publish-site-label');
    const msg = document.getElementById('msg-publish');
    if (state.publishBusy) return;
    state.publishBusy = true;
    if (btn) btn.disabled = true;
    if (label) label.textContent = 'Publishing…';
    if (msg) {
      msg.className = 'msg';
      msg.textContent = 'Updating your live preview…';
    }
    const keepMode = state.editMode;
    const keepFs = state.editFullscreen;
    try {
      const data = await api('/site/publish', { method: 'POST', body: '{}' });
      if (data && data.previewUrl) state.previewUrl = data.previewUrl;
      setOpenPreview(state.previewUrl);
      const okText = publishSuccessMessage(data);
      if (msg) {
        msg.className = 'msg ok';
        msg.textContent = okText;
      }
      await loadEditablePreview(state.previewUrl, {
        preserveEditMode: keepMode,
        preserveFullscreen: keepFs,
      });
      if (keepMode && state.siteEditable) setEditMode(true, { fullscreen: keepFs });
      else if (keepFs && state.siteEditable) setEditFullscreen(true);
      setTimeout(() => {
        if (msg && msg.textContent === okText) {
          msg.className = 'msg';
          msg.textContent = '';
        }
      }, 5000);
    } catch (e) {
      if (msg) {
        msg.className = 'msg err';
        msg.textContent = errText(e);
      }
    } finally {
      state.publishBusy = false;
      if (btn) btn.disabled = false;
      if (label) label.textContent = 'Publish';
    }
  }

  function postEditModeToFrame(on) {
    const frame = state.previewFrame;
    if (!frame || !frame.contentWindow) return;
    try {
      frame.contentWindow.postMessage({ source: 'ws-portal', type: 'edit-mode', on: !!on }, '*');
    } catch {
      /* */
    }
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
    if (typeof syncThemeUi === 'function') syncThemeUi();
  }

  function normalizeThemeHex(value) {
    let s = String(value == null ? '' : value).trim();
    if (!s) return null;
    if (s[0] !== '#') s = `#${s}`;
    if (/^#[0-9a-fA-F]{3}$/.test(s)) {
      s = `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
    }
    if (!/^#[0-9a-fA-F]{6}$/.test(s)) return null;
    return s.toLowerCase();
  }

  function readThemeForm() {
    const out = {};
    for (const key of THEME_KEYS) {
      const hexEl = document.getElementById(`theme-hex-${key}`);
      const pickEl = document.getElementById(`theme-pick-${key}`);
      const raw = (hexEl && hexEl.value) || (pickEl && pickEl.value) || state.theme[key];
      const hex = normalizeThemeHex(raw);
      if (!hex) {
        const err = new Error(`Invalid ${key} color — use #RRGGBB`);
        err.key = key;
        throw err;
      }
      out[key] = hex;
    }
    return out;
  }

  function fillThemeForm(colors) {
    const c = colors || state.theme;
    for (const key of THEME_KEYS) {
      const hex = normalizeThemeHex(c[key]) || state.themeSaved[key] || '#000000';
      const hexEl = document.getElementById(`theme-hex-${key}`);
      const pickEl = document.getElementById(`theme-pick-${key}`);
      if (hexEl) hexEl.value = hex;
      if (pickEl) pickEl.value = hex;
    }
  }

  // Batch 152 — the code textareas mirror state.theme; the save flow
  // sends only fields whose text differs from the last saved values,
  // so a colors-only save never rewrites the owner's code (and the
  // server leaves absent fields untouched).
  function syncCodeCounts() {
    for (const [key, id] of Object.entries(CODE_FIELD_IDS)) {
      const el = document.getElementById(id);
      const count = document.getElementById(`${id}-count`);
      if (count && el) count.textContent = `— ${el.value.length.toLocaleString('en-US')} / ${CODE_FIELD_MAX.toLocaleString('en-US')} characters`;
    }
  }

  function fillCodeFields(theme) {
    const t = theme || state.theme;
    for (const [key, id] of Object.entries(CODE_FIELD_IDS)) {
      const el = document.getElementById(id);
      if (el) el.value = t[key] != null ? String(t[key]) : '';
    }
    syncCodeCounts();
  }

  function readCodeFields() {
    const out = {};
    for (const [key, id] of Object.entries(CODE_FIELD_IDS)) {
      const el = document.getElementById(id);
      if (!el) continue;
      const saved = state.themeSaved[key] != null ? String(state.themeSaved[key]) : '';
      if (el.value !== saved) out[key] = el.value;
    }
    return out;
  }

  function setThemeFromServer(theme) {
    if (!theme || typeof theme !== 'object') return;
    const next = { ...state.theme };
    for (const key of THEME_KEYS) {
      const hex = normalizeThemeHex(theme[key]);
      if (hex) next[key] = hex;
    }
    if (theme.font) next.font = String(theme.font);
    if (theme.headingFont != null) next.headingFont = String(theme.headingFont || '');
    if (theme.customCss != null) next.customCss = String(theme.customCss);
    if (theme.customJs != null) next.customJs = String(theme.customJs);
    if (theme.customHead != null) next.customHead = String(theme.customHead);
    state.theme = next;
    state.themeSaved = { ...next };
    state.themeLive = {
      primary: next.primary,
      secondary: next.secondary,
      bg: next.bg,
      text: next.text,
    };
    const roleSet = new Set(THEME_KEYS.map((k) => next[k]));
    const rawPalette = Array.isArray(theme.palette) ? theme.palette : [];
    state.themePalette = rawPalette
      .map((p) => {
        const hex = normalizeThemeHex(p.hex || p);
        if (!hex) return null;
        return {
          original: hex,
          current: hex,
          roles: Array.isArray(p.roles) ? p.roles : [],
          isRole: roleSet.has(hex),
        };
      })
      .filter(Boolean);
    fillThemeForm(next);
    fillCodeFields(next);
    fillFontSelects();
    renderThemePalette();
  }

  function renderThemePalette() {
    const wrap = document.getElementById('theme-palette-wrap');
    const host = document.getElementById('theme-palette');
    if (!wrap || !host) return;
    const extras = state.themePalette.filter((p) => !p.isRole);
    if (!extras.length) {
      wrap.hidden = true;
      host.innerHTML = '';
      return;
    }
    wrap.hidden = false;
    host.innerHTML = extras
      .map((p, i) => {
        const label = p.roles && p.roles.length ? p.roles.join('/') : `Accent ${i + 1}`;
        return `<div class="theme-palette-item">
        <label>${esc(label)}</label>
        <div class="theme-inputs">
          <input type="color" data-palette-i="${i}" value="${esc(p.current)}" aria-label="${esc(label)} color" />
          <input type="text" data-palette-i="${i}" value="${esc(p.current)}" maxlength="7" spellcheck="false" autocomplete="off" />
        </div>
      </div>`;
      })
      .join('');
  }

  function ensureCatalogStyles(doc) {
    const target = doc || document;
    if (!target.head || !window.WsFonts) return;
    if (target.getElementById('ws-font-catalog')) return;
    const link = target.createElement('link');
    link.id = 'ws-font-catalog';
    link.rel = 'stylesheet';
    link.href = window.WsFonts.catalogHref();
    target.head.appendChild(link);
  }

  function fillFontSelects() {
    if (!window.WsFonts) return;
    const body = state.theme.font || '';
    const heading = state.theme.headingFont || '';
    window.WsFonts.fillSelect(document.getElementById('theme-font-body'), body, { defaultLabel: 'System' });
    window.WsFonts.fillSelect(document.getElementById('theme-font-heading'), heading, {
      defaultLabel: 'Same as site font',
    });
    window.WsFonts.fillSelect(document.getElementById('edit-font-body'), body, { defaultLabel: 'System' });
    window.WsFonts.fillSelect(document.getElementById('edit-font-heading'), heading, {
      defaultLabel: 'Same as site font',
    });
    const el = document.getElementById('edit-font-element');
    if (el && !el.options.length) {
      window.WsFonts.fillSelect(el, '', { defaultLabel: 'Site default' });
    }
    if (el) el.disabled = !state.selectedEditId;
  }

  function readThemeFonts() {
    const fonts = window.WsFonts;
    const bodySel = document.getElementById('theme-font-body');
    const headSel = document.getElementById('theme-font-heading');
    let font = state.theme.font || (fonts ? fonts.SYSTEM : '');
    let headingFont = state.theme.headingFont || '';
    if (bodySel && bodySel.value && bodySel.value !== '__custom__' && fonts) font = fonts.stackFor(bodySel.value);
    else if (bodySel && bodySel.value === '' && fonts) font = fonts.SYSTEM;
    if (headSel && headSel.value && headSel.value !== '__custom__' && fonts)
      headingFont = fonts.stackFor(headSel.value);
    else if (headSel && headSel.value === '') headingFont = '';
    return { font, headingFont };
  }

  function previewFontPayload(fonts) {
    const catalog = window.WsFonts;
    return {
      ...fonts,
      fontHref: catalog
        ? catalog.hrefFor([catalog.matchName(fonts.font), catalog.matchName(fonts.headingFont)].filter(Boolean))
        : '',
    };
  }

  function applyFontsLive(fonts) {
    const frame = state.previewFrame;
    if (fonts && frame && frame.contentWindow)
      frame.contentWindow.postMessage({ source: 'ws-portal', type: 'site-fonts', ...previewFontPayload(fonts) }, '*');
  }

  function syncFontSelect(sourceId, peerId) {
    const source = document.getElementById(sourceId);
    const peer = document.getElementById(peerId);
    if (source && peer && peer.value !== source.value) peer.value = source.value;
  }

  function onSiteFontPick(which) {
    if (which === 'body') syncFontSelect('theme-font-body', 'edit-font-body');
    if (which === 'heading') syncFontSelect('theme-font-heading', 'edit-font-heading');
    const fonts = readThemeFonts();
    state.theme = { ...state.theme, font: fonts.font, headingFont: fonts.headingFont };
    applyFontsLive(fonts);
  }

  function postElementFont(name) {
    const frame = state.previewFrame;
    if (!frame || !frame.contentWindow || !window.WsFonts) return;

    frame.contentWindow.postMessage(
      {
        source: 'ws-portal',
        type: 'set-font',
        fontHref: name ? window.WsFonts.hrefFor([name]) : '',
        family: name ? window.WsFonts.stackFor(name) : '',
        name: name || '',
      },
      '*'
    );
  }

  async function handleElementFont(data) {
    const id = String((data && data.id) || '');
    if (/^html:\d+:\d+(?::\d+)?$/.test(id) && data.html) {
      await handleListMutate({
        action: 'freeform-save',
        pageIndex: data.pageIndex,
        sectionIndex: data.sectionIndex,
        html: data.html,
      });
      return;
    }
    if (!/^\d+:\d+:/.test(id)) return;
    const msg = document.getElementById('msg-edit');
    if (msg) {
      msg.className = 'msg';
      msg.textContent = 'Saving font…';
    }
    await api('/site/theme', {
      method: 'POST',
      body: JSON.stringify({ elementFonts: { [id]: data.font || '' } }),
    });
    const keepMode = state.editMode;
    const keepFs = state.editFullscreen;
    await loadEditablePreview(state.previewUrl);
    if (keepMode && state.siteEditable) setEditMode(true, { fullscreen: keepFs });
    if (msg) {
      msg.className = 'msg ok';
      msg.textContent = 'Font saved on that element.';
    }
  }

  function applyThemeLiveToPreview(colors, opts = {}) {
    const frame = state.previewFrame;
    if (!frame || !frame.contentWindow) return false;
    const rewrites = [];
    for (const key of THEME_KEYS) {
      const hex = normalizeThemeHex(colors && colors[key]);
      if (!hex) continue;
      const prev = normalizeThemeHex(state.themeLive[key]) || normalizeThemeHex(state.theme[key]);
      if (prev && prev !== hex) rewrites.push({ from: prev, to: hex });
      state.themeLive[key] = hex;
    }
    if (Array.isArray(opts.paletteRewrites)) rewrites.push(...opts.paletteRewrites);
    frame.contentWindow.postMessage(
      {
        source: 'ws-portal',
        type: 'theme-preview',
        colors: state.themeLive,
        rewrites,
        ...previewFontPayload(readThemeFonts()),
      },
      '*'
    );
    return true;
  }

  function syncThemeUi() {
    const btn = document.getElementById('btn-theme-colors');
    const label = document.getElementById('btn-theme-colors-label');
    const bar = document.getElementById('theme-bar');
    const can = !!state.siteEditable;
    if (btn) {
      if (can) btn.classList.remove('hidden');
      else btn.classList.add('hidden');
      btn.setAttribute('aria-pressed', state.themeOpen && can ? 'true' : 'false');
    }
    if (label) label.textContent = state.themeOpen && can ? 'Hide theme' : 'Theme';
    if (bar) bar.hidden = !(can && state.themeOpen && !state.editFullscreen);
    // Batch 155: the standalone-backup bar rides the same site-editable
    // sync as the theme bar (always offered, not tucked behind Theme).
    const backupBar = document.getElementById('backup-bar');
    if (backupBar) backupBar.hidden = !(can && !state.editFullscreen);
    const saveBtn = document.getElementById('btn-theme-save');
    if (saveBtn) saveBtn.disabled = !!state.themeSaving;
  }

  function syncStructureUi() {
    const btn = document.getElementById('btn-structure');
    const label = document.getElementById('btn-structure-label');
    const bar = document.getElementById('structure-bar');
    const can = !!state.siteEditable;
    if (btn) {
      if (can) btn.classList.remove('hidden');
      else btn.classList.add('hidden');
      btn.setAttribute('aria-pressed', state.structureOpen && can ? 'true' : 'false');
      btn.classList.toggle('ghost', !!(state.structureOpen && can));
      btn.classList.toggle('soft', !(state.structureOpen && can));
    }
    if (label) label.textContent = state.structureOpen && can ? 'Hide order' : 'Order';
    if (bar) bar.hidden = !(can && state.structureOpen && !state.editFullscreen);
  }

  function setStructureMsg(text, kind) {
    const msg = document.getElementById('msg-structure');
    if (!msg) return;
    msg.className = kind ? `msg ${kind}` : 'msg';
    msg.textContent = text || '';
  }

  /* ================================================================ */
  /* Batch 147 — native section (layout) editor.                       */
  /* The portal-side controller: it holds the page's section list as   */
  /* the working model, mirrors the server ops in src/siteStructure.js */
  /* for instant feedback, re-renders the canvas from the server after */
  /* every op (the canvas is a render OF the model, never a fork of    */
  /* it) and persists only on explicit Save via POST /site/layout —    */
  /* the platform's real update path. All DOM below is built with      */
  /* createElement/textContent (no HTML-string sinks).                 */
  /* ================================================================ */

  const LAYOUT_PINNED_TYPES = { nav: 1, hero: 1, banner: 1, footer: 1 };

  function syncLayoutUi() {
    const btn = document.getElementById('btn-layout');
    const label = document.getElementById('btn-layout-label');
    const bar = document.getElementById('layout-bar');
    const can = !!state.siteEditable;
    if (btn) {
      if (can) btn.classList.remove('hidden');
      else btn.classList.add('hidden');
      btn.setAttribute('aria-pressed', state.layoutOpen && can ? 'true' : 'false');
      btn.classList.toggle('ghost', !!(state.layoutOpen && can));
      btn.classList.toggle('soft', !(state.layoutOpen && can));
    }
    if (label) label.textContent = state.layoutOpen && can ? 'Hide layout' : 'Layout';
    if (bar) bar.hidden = !(can && state.layoutOpen && !state.editFullscreen);
    const dirtyEl = document.getElementById('layout-dirty');
    if (dirtyEl) dirtyEl.hidden = !(state.layout && state.layout.dirty);
    const saveBtn = document.getElementById('btn-layout-save');
    if (saveBtn) saveBtn.disabled = !(state.layout && state.layout.dirty) || !!state.layoutBusy;
    const undoBtn = document.getElementById('btn-layout-undo');
    if (undoBtn) undoBtn.disabled = !(state.layout && state.layout.undo.length) || !!state.layoutBusy;
  }

  function setLayoutMsg(text, kind) {
    const msg = document.getElementById('msg-layout');
    if (!msg) return;
    msg.className = kind ? `msg ${kind}` : 'msg';
    msg.textContent = text || '';
  }

  function layoutSession() {
    return state.layout;
  }

  /** Resolve a section's editor flags from the working model. */
  function layoutInfo(section) {
    const L = layoutSession();
    const type = String((section && section.type) || '').toLowerCase();
    const c = section && section.content && typeof section.content === 'object' ? section.content : {};
    let moduleType = String(c.module_type || c.moduleType || '').toLowerCase();
    if (!moduleType && L) {
      const token =
        typeof c.public_token === 'string'
          ? c.public_token
          : typeof c.html === 'string'
            ? (c.html.match(/data-bitpype-module-token\s*=\s*["']([^"']+)["']/) || [])[1] || ''
            : '';
      if (token && L.tokens[token]) moduleType = L.tokens[token];
    }
    const chrome = type === 'nav' || type === 'footer';
    const fence = moduleType && L && L.fences ? L.fences[moduleType] : null;
    let label = '';
    if (moduleType) {
      const meta =
        L && L.palette ? (L.palette.modules || []).find((m) => m.type === moduleType) : null;
      label = `Module: ${(meta && meta.label) || c.title || moduleType}`;
    } else {
      label =
        c.title || c.heading || c.headline || c.brand || type.replace(/_/g, ' ').replace(/^./, (ch) => ch.toUpperCase());
    }
    return {
      type,
      moduleType: moduleType || '',
      label: String(label || type || 'Section'),
      chrome,
      movable: !chrome && !LAYOUT_PINNED_TYPES[type],
      canDuplicate: !chrome && !fence,
      duplicateReason: chrome ? 'Page chrome exists once per page.' : fence || null,
      canDelete: !chrome,
      // Batch 148 knobs — mirror of describeEditorSection's flags:
      // chrome gets neither; the chatbot overlay never gets width.
      canWidth: !chrome && moduleType !== 'chatbot',
      canHideMobile: !chrome,
      width: section && section.width === 'full' ? 'full' : 'contained',
      hideOnMobile: !!(section && section.hideOnMobile === true),
    };
  }

  function layoutModelFlags(index) {
    const L = layoutSession();
    if (!L) return null;
    return layoutInfo(L.model[index]);
  }

  function layoutMarkDirty() {
    const L = layoutSession();
    if (!L) return;
    L.dirty = JSON.stringify(L.model) !== JSON.stringify(L.saved);
    syncLayoutUi();
  }

  function layoutSnapshot() {
    const L = layoutSession();
    if (!L) return;
    L.undo.push(JSON.stringify(L.model));
    if (L.undo.length > 50) L.undo.shift();
  }

  async function openLayout(slug) {
    if (!state.siteEditable || state.layoutBusy) return;
    state.layoutBusy = true;
    syncLayoutUi();
    try {
      const qs = slug ? `?slug=${encodeURIComponent(slug)}` : '';
      const data = await api(`/site/layout${qs}`);
      if (!data || !data.page) throw new Error('No page to edit yet.');
      // Mutual exclusion with the other Website-tab modes.
      if (state.editMode) setEditMode(false, { fullscreen: false });
      state.structureOpen = false;
      state.themeOpen = false;
      syncStructureUi();
      syncThemeUi();
      state.layout = {
        slug: data.page.slug,
        pages: data.pages || [],
        model: JSON.parse(JSON.stringify(data.sections || [])),
        saved: JSON.parse(JSON.stringify(data.sections || [])),
        palette: data.palette || { content: [], modules: [] },
        theme: data.theme || {},
        padding: data.padding || { floor: 22, max: 160, defaultPx: 56 },
        tokens: data.tokens || {},
        fences: data.fences || {},
        freeform: !!data.freeform,
        undo: [],
        selected: -1,
        dirty: false,
        addAfter: null,
        paletteOpen: false,
      };
      state.layoutOpen = true;
      if (data.previewUrl) state.previewUrl = data.previewUrl;
      setLayoutMsg(
        data.freeform
          ? 'This page is freeform HTML — the layout editor applies to section-based pages. Pick another page above.'
          : '',
        ''
      );
      renderLayoutBar();
      await renderLayoutCanvas();
    } catch (e) {
      setLayoutMsg(errText(e), 'err');
      state.layoutOpen = false;
      // The bar is hidden on a failed open — surface the error on the
      // always-visible preview message line as well.
      const pubMsg = document.getElementById('msg-publish');
      if (pubMsg) {
        pubMsg.className = 'msg err';
        pubMsg.textContent = `Layout editor: ${errText(e)}`;
      }
    } finally {
      state.layoutBusy = false;
      syncLayoutUi();
    }
  }

  /** Close the editor UI. Returns false when the user cancels a
   *  dirty-discard confirm. keepSession=true hides the bar but keeps
   *  the working model (used when Edit routes to the Modules tab). */
  function closeLayout(opts = {}) {
    const L = layoutSession();
    if (L && L.dirty && !opts.keepSession && !opts.force) {
      if (!window.confirm('You have unsaved layout changes. Discard them?')) return false;
    }
    state.layoutOpen = false;
    if (!opts.keepSession) state.layout = null;
    syncLayoutUi();
    if (!opts.keepSession && !opts.skipReload) loadEditablePreview(state.previewUrl).catch(() => {});
    return true;
  }

  /** Guard for the other Website-tab modes: switching away with a
   *  dirty layout session needs an explicit discard. */
  function layoutBlocksModeSwitch() {
    if (!state.layoutOpen) return false;
    return !closeLayout();
  }

  async function renderLayoutCanvas() {
    const L = layoutSession();
    if (!L) return;
    try {
      const data = await api('/site/layout/render', {
        method: 'POST',
        body: JSON.stringify(
          L.freeform ? { slug: L.slug } : { slug: L.slug, sections: L.model }
        ),
      });
      setLayoutCanvasHtml(data && data.html ? data.html : '');
    } catch (e) {
      setLayoutMsg(errText(e), 'err');
    }
  }

  function setLayoutCanvasHtml(html) {
    const box = document.getElementById('preview-box');
    if (!box) return;
    while (box.firstChild) box.removeChild(box.firstChild);
    const empty = document.createElement('div');
    empty.className = 'preview-empty';
    empty.id = 'preview-empty';
    empty.textContent = 'No preview is available yet.';
    empty.hidden = !!html;
    box.appendChild(empty);
    const frame = document.createElement('iframe');
    frame.title = 'Website preview — layout editor';
    frame.id = 'portal-preview-frame';
    frame.setAttribute('sandbox', 'allow-scripts allow-forms');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.addEventListener('load', () => {
      postLayoutConfig();
      const L = layoutSession();
      if (L && L.selected >= 0) postLayoutHighlight(L.selected);
    });
    box.appendChild(frame);
    state.previewFrame = frame;
    state.previewScroll = { x: 0, y: 0 };
    frame.srcdoc = html || '<p style="font-family:sans-serif;padding:1rem">Empty preview.</p>';
  }

  function postLayoutConfig() {
    const L = layoutSession();
    const frame = state.previewFrame;
    if (!L || !frame || !frame.contentWindow) return;
    const sections = L.model.map((s, i) => {
      const info = layoutInfo(s);
      return {
        index: i,
        label: info.label,
        movable: info.movable,
        canDuplicate: info.canDuplicate,
        canDelete: info.canDelete,
        chrome: info.chrome,
        width: info.width,
        hideOnMobile: info.hideOnMobile,
      };
    });
    try {
      frame.contentWindow.postMessage({ source: 'bp-layout-host', action: 'config', sections }, '*');
    } catch {
      /* frame not ready */
    }
  }

  function postLayoutHighlight(index) {
    const frame = state.previewFrame;
    if (!frame || !frame.contentWindow) return;
    try {
      frame.contentWindow.postMessage({ source: 'bp-layout-host', action: 'highlight', index }, '*');
    } catch {
      /* frame not ready */
    }
  }

  function postLayoutStyle(index, style) {
    const frame = state.previewFrame;
    if (!frame || !frame.contentWindow) return;
    try {
      frame.contentWindow.postMessage(
        {
          source: 'bp-layout-host',
          action: 'style',
          index,
          background: style.background,
          paddingPx: style.paddingPx,
          width: style.width,
          hideOnMobile: style.hideOnMobile,
        },
        '*'
      );
    } catch {
      /* frame not ready */
    }
  }

  function layoutEl(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function layoutSmallBtn(text, title, act, idx, disabled) {
    const b = layoutEl('button', '', text);
    b.type = 'button';
    b.title = title;
    b.setAttribute('data-layout-act', act);
    b.setAttribute('data-layout-idx', String(idx));
    b.disabled = !!disabled;
    return b;
  }

  function renderLayoutBar() {
    const L = layoutSession();
    const tabsEl = document.getElementById('layout-page-tabs');
    const railEl = document.getElementById('layout-rail');
    if (!L || !tabsEl || !railEl) return;
    while (tabsEl.firstChild) tabsEl.removeChild(tabsEl.firstChild);
    for (const p of L.pages) {
      const b = layoutEl('button', p.slug === L.slug ? 'active' : '', p.title || p.slug || 'Page');
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.setAttribute('data-layout-page', String(p.slug || ''));
      if (p.freeform) b.title = 'Freeform HTML page — layout editing applies to section pages';
      tabsEl.appendChild(b);
    }
    renderLayoutRail();
    renderLayoutSide();
    renderLayoutPalette();
    syncLayoutUi();
  }

  function renderLayoutRail() {
    const L = layoutSession();
    const railEl = document.getElementById('layout-rail');
    if (!L || !railEl) return;
    while (railEl.firstChild) railEl.removeChild(railEl.firstChild);
    if (L.freeform) {
      railEl.appendChild(layoutEl('p', 'hint', 'This page is freeform HTML — section layout editing does not apply.'));
      return;
    }
    const movableIdx = [];
    L.model.forEach((s, i) => {
      if (layoutInfo(s).movable) movableIdx.push(i);
    });
    L.model.forEach((section, i) => {
      const info = layoutInfo(section);
      const row = layoutEl('div', `layout-row${i === L.selected ? ' selected' : ''}${info.chrome ? ' locked' : ''}`);
      row.setAttribute('data-layout-row', String(i));
      row.appendChild(layoutEl('span', 'layout-row-label', info.label));
      row.appendChild(
        layoutEl('span', 'layout-row-meta', info.chrome ? 'Locked' : info.moduleType ? 'Module' : info.type)
      );
      const btns = layoutEl('span', 'layout-row-btns');
      const posInMovable = movableIdx.indexOf(i);
      btns.appendChild(
        layoutSmallBtn('↑', 'Move up', 'up', i, !info.movable || posInMovable <= 0)
      );
      btns.appendChild(
        layoutSmallBtn('↓', 'Move down', 'down', i, !info.movable || posInMovable === movableIdx.length - 1)
      );
      btns.appendChild(layoutSmallBtn('⧉', info.duplicateReason || 'Duplicate section', 'duplicate', i, !info.canDuplicate));
      btns.appendChild(layoutSmallBtn('✕', 'Delete section', 'delete', i, !info.canDelete));
      btns.appendChild(layoutSmallBtn('Edit', 'Edit section', 'edit', i, false));
      row.appendChild(btns);
      railEl.appendChild(row);
    });
  }

  function layoutSectionBackground(section) {
    const c = section && section.content && typeof section.content === 'object' ? section.content : {};
    for (const key of ['backgroundColor', 'background_color', 'bg', 'background']) {
      const v = c[key];
      if (typeof v === 'string' && /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/.test(v.trim())) return v.trim();
    }
    return '';
  }

  function layoutSectionPadding(section) {
    const style = section && typeof section.style === 'string' ? section.style : '';
    let top = null;
    let bottom = null;
    for (const part of style.split(';')) {
      const idx = part.indexOf(':');
      if (idx <= 0) continue;
      const prop = part.slice(0, idx).trim().toLowerCase();
      const m = /^(\d+(?:\.\d+)?)px$/.exec(part.slice(idx + 1).trim());
      if (!m) continue;
      if (prop === 'padding-top') top = Number(m[1]);
      if (prop === 'padding-bottom') bottom = Number(m[1]);
    }
    if (top == null && bottom == null) return null;
    return Math.round(Math.max(top || 0, bottom || 0));
  }

  function renderLayoutSide() {
    const L = layoutSession();
    const side = document.getElementById('layout-side');
    const cols = document.getElementById('layout-cols');
    if (!L || !side) return;
    const i = L.selected;
    const section = i >= 0 ? L.model[i] : null;
    if (!section) {
      side.hidden = true;
      if (cols) cols.classList.remove('has-side');
      return;
    }
    const info = layoutInfo(section);
    side.hidden = false;
    if (cols) cols.classList.add('has-side');
    const title = document.getElementById('layout-side-title');
    if (title) title.textContent = info.label;
    const meta = document.getElementById('layout-side-meta');
    if (meta) {
      meta.textContent = info.chrome
        ? 'Page chrome — position locked (always first/last).'
        : info.moduleType
          ? `Module section — settings live in the Modules tab; this block only places the module on the page.`
          : `${info.type} section`;
    }
    const knobs = document.getElementById('layout-side-knobs');
    if (knobs) {
      while (knobs.firstChild) knobs.removeChild(knobs.firstChild);
      if (!info.chrome) {
        knobs.appendChild(layoutBackgroundKnob(i, section));
        knobs.appendChild(layoutPaddingKnob(i, section));
        if (info.canWidth) knobs.appendChild(layoutWidthKnob(i, section));
        if (info.canHideMobile) knobs.appendChild(layoutHideMobileKnob(i, section));
      }
    }
    const actions = document.getElementById('layout-side-actions');
    if (actions) {
      while (actions.firstChild) actions.removeChild(actions.firstChild);
      const editBtn = layoutEl('button', '', info.moduleType ? 'Edit module settings' : 'Edit content');
      editBtn.type = 'button';
      editBtn.onclick = () => layoutAct('edit', i);
      actions.appendChild(editBtn);
      const dupBtn = layoutEl('button', '', 'Duplicate');
      dupBtn.type = 'button';
      dupBtn.disabled = !info.canDuplicate;
      if (info.duplicateReason) dupBtn.title = info.duplicateReason;
      dupBtn.onclick = () => layoutAct('duplicate', i);
      actions.appendChild(dupBtn);
      const delBtn = layoutEl('button', '', 'Delete');
      delBtn.type = 'button';
      delBtn.disabled = !info.canDelete;
      delBtn.onclick = () => layoutAct('delete', i);
      actions.appendChild(delBtn);
      const addBtn = layoutEl('button', '', '+ Add below');
      addBtn.type = 'button';
      addBtn.onclick = () => layoutOpenPalette(i);
      actions.appendChild(addBtn);
    }
    const note = document.getElementById('layout-side-note');
    if (note) {
      note.textContent = info.chrome
        ? 'The menu and footer exist once per page — they cannot be moved, duplicated or removed here.'
        : info.duplicateReason || '';
    }
  }

  function layoutBackgroundKnob(index, section) {
    const L = layoutSession();
    const wrap = layoutEl('div', 'layout-knob');
    wrap.appendChild(layoutEl('label', '', 'Background'));
    const row = layoutEl('div', 'layout-swatches');
    const current = layoutSectionBackground(section).toLowerCase();
    const seen = new Set();
    const addSwatch = (hex, name) => {
      const norm = String(hex || '').toLowerCase();
      if (!/^#(?:[0-9a-f]{6}|[0-9a-f]{3})$/.test(norm) || seen.has(norm)) return;
      seen.add(norm);
      const b = layoutEl('button', `layout-swatch${norm === current ? ' selected' : ''}`);
      b.type = 'button';
      b.title = name || norm;
      b.style.backgroundColor = norm;
      b.onclick = () => layoutSetBackground(index, norm);
      row.appendChild(b);
    };
    const theme = (L && L.theme) || {};
    addSwatch(theme.primary, 'Primary');
    addSwatch(theme.secondary, 'Secondary');
    addSwatch(theme.bg, 'Site background');
    addSwatch(theme.text, 'Text colour');
    const palette = Array.isArray(theme.palette) ? theme.palette : [];
    for (const entry of palette) {
      addSwatch(typeof entry === 'string' ? entry : entry && entry.hex, 'Site colour');
    }
    const none = layoutEl('button', 'layout-swatch layout-swatch-none', 'None');
    none.type = 'button';
    if (!current) none.classList.add('selected');
    none.onclick = () => layoutSetBackground(index, '');
    row.appendChild(none);
    wrap.appendChild(row);
    return wrap;
  }

  function layoutPaddingKnob(index, section) {
    const L = layoutSession();
    const pad = (L && L.padding) || { floor: 22, max: 160, defaultPx: 56 };
    const wrap = layoutEl('div', 'layout-knob');
    wrap.appendChild(layoutEl('label', '', 'Vertical padding'));
    const row = layoutEl('div', 'layout-pad-row');
    const current = layoutSectionPadding(section);
    const range = document.createElement('input');
    range.type = 'range';
    range.min = String(pad.floor);
    range.max = String(pad.max);
    range.step = '2';
    range.value = String(current != null ? current : pad.defaultPx);
    range.setAttribute('aria-label', 'Vertical padding in pixels');
    const num = document.createElement('input');
    num.type = 'number';
    num.min = String(pad.floor);
    num.max = String(pad.max);
    num.step = '2';
    num.value = range.value;
    num.setAttribute('aria-label', 'Vertical padding value (px)');
    const apply = (v) => {
      const px = Math.max(pad.floor, Math.min(pad.max, Math.round(Number(v) || pad.defaultPx)));
      range.value = String(px);
      num.value = String(px);
      layoutSetPadding(index, px, true);
    };
    range.addEventListener('input', () => apply(range.value));
    num.addEventListener('change', () => apply(num.value));
    row.appendChild(range);
    row.appendChild(num);
    row.appendChild(layoutEl('span', 'hint', 'px'));
    wrap.appendChild(row);
    const foot = layoutEl('div', 'layout-pad-row');
    const state = layoutEl(
      'span',
      'hint',
      current != null ? `Custom — platform default is ${pad.defaultPx}px.` : `Site default (${pad.defaultPx}px) — drag to customise.`
    );
    foot.appendChild(state);
    if (current != null) {
      const reset = layoutEl('button', '', 'Reset');
      reset.type = 'button';
      reset.onclick = () => layoutSetPadding(index, null, false);
      foot.appendChild(reset);
    }
    const floorNote = layoutEl('p', 'hint', `Minimum ${pad.floor}px — the platform spacing floor keeps text off the edges.`);
    floorNote.style.margin = '6px 0 0';
    wrap.appendChild(foot);
    wrap.appendChild(floorNote);
    return wrap;
  }

  function layoutSetBackground(index, hex) {
    const L = layoutSession();
    const section = L && L.model[index];
    if (!section) return;
    layoutSnapshot();
    if (!section.content || typeof section.content !== 'object') section.content = {};
    if (hex) section.content.backgroundColor = hex;
    else delete section.content.backgroundColor;
    layoutMarkDirty();
    renderLayoutSide();
    postLayoutStyle(index, { background: hex || '' });
  }

  function layoutSetPadding(index, px, live) {
    const L = layoutSession();
    const section = L && L.model[index];
    if (!section) return;
    const pad = L.padding || { floor: 22, max: 160 };
    if (!live || L.padSnapIndex !== index) {
      layoutSnapshot();
      L.padSnapIndex = index;
    }
    const decls = [];
    const raw = typeof section.style === 'string' ? section.style : '';
    for (const part of raw.split(';')) {
      const ix = part.indexOf(':');
      if (ix <= 0) continue;
      const prop = part.slice(0, ix).trim().toLowerCase();
      const value = part.slice(ix + 1).trim();
      if (!prop || !value) continue;
      if (prop === 'padding-top' || prop === 'padding-bottom' || prop === 'padding') continue;
      decls.push(`${prop}:${value}`);
    }
    if (px != null) {
      const v = Math.max(pad.floor, Math.min(pad.max, Math.round(px)));
      decls.push(`padding-top:${v}px`, `padding-bottom:${v}px`);
    }
    if (decls.length) section.style = decls.join(';');
    else delete section.style;
    layoutMarkDirty();
    postLayoutStyle(index, { paddingPx: px == null ? '' : px });
    if (!live) {
      L.padSnapIndex = -1;
      renderLayoutSide();
    }
  }

  /* Batch 148 — width knob: Contained / Full width segmented control.
   * Full width stretches the section's band edge to edge; the platform
   * spacing inset stays on the band, so text still never touches the
   * screen edge. Stored as section.width='full'; contained stores
   * nothing (the pre-148 default). */
  function layoutWidthKnob(index, section) {
    const info = layoutInfo(section);
    const wrap = layoutEl('div', 'layout-knob');
    wrap.appendChild(layoutEl('label', '', 'Width'));
    const row = layoutEl('div', 'layout-seg');
    for (const [mode, label] of [
      ['contained', 'Contained'],
      ['full', 'Full width'],
    ]) {
      const b = layoutEl('button', `layout-seg-btn${info.width === mode ? ' selected' : ''}`, label);
      b.type = 'button';
      b.setAttribute('aria-pressed', info.width === mode ? 'true' : 'false');
      b.onclick = () => layoutSetWidth(index, mode);
      row.appendChild(b);
    }
    wrap.appendChild(row);
    const note = layoutEl(
      'p',
      'hint',
      info.width === 'full'
        ? 'Band spans the full screen width; the spacing inset still keeps text off the edges.'
        : 'Band content sits in the centred column, like every section today.'
    );
    note.style.margin = '6px 0 0';
    wrap.appendChild(note);
    return wrap;
  }

  /* Batch 148 — hide-on-mobile switch. The section disappears at phone
   * widths (≤700px) on the real site; in this canvas it stays visible,
   * dimmed and badged, so it can never be lost track of. Stored as
   * section.hideOnMobile=true; visible stores nothing. */
  function layoutHideMobileKnob(index, section) {
    const info = layoutInfo(section);
    const wrap = layoutEl('div', 'layout-knob');
    const row = layoutEl('div', 'layout-switch-row');
    const label = layoutEl('label', '', 'Hide on mobile');
    label.htmlFor = `layout-hide-mobile-${index}`;
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = `layout-hide-mobile-${index}`;
    input.checked = !!info.hideOnMobile;
    input.addEventListener('change', () => layoutSetHideMobile(index, input.checked));
    row.appendChild(label);
    row.appendChild(input);
    wrap.appendChild(row);
    const note = layoutEl(
      'p',
      'hint',
      info.hideOnMobile
        ? 'Hidden on phones (≤700px). It stays visible here, dimmed and badged.'
        : 'Shown on every screen size.'
    );
    note.style.margin = '6px 0 0';
    wrap.appendChild(note);
    return wrap;
  }

  function layoutSetWidth(index, mode) {
    const L = layoutSession();
    const section = L && L.model[index];
    if (!section) return;
    layoutSnapshot();
    if (mode === 'full') section.width = 'full';
    else delete section.width;
    layoutMarkDirty();
    renderLayoutSide();
    postLayoutStyle(index, { width: mode === 'full' ? 'full' : 'contained' });
  }

  function layoutSetHideMobile(index, hidden) {
    const L = layoutSession();
    const section = L && L.model[index];
    if (!section) return;
    layoutSnapshot();
    if (hidden) section.hideOnMobile = true;
    else delete section.hideOnMobile;
    layoutMarkDirty();
    renderLayoutSide();
    postLayoutStyle(index, { hideOnMobile: !!hidden });
  }

  function layoutAfterStructural() {
    layoutMarkDirty();
    renderLayoutBar();
    renderLayoutCanvas();
  }

  /** Client mirror of moveSectionToIndex (movable-slot rule). */
  function layoutMoveClient(from, toIndex) {
    const L = layoutSession();
    if (!L) return false;
    const model = L.model;
    const flags = model.map((s) => layoutInfo(s).movable);
    if (!flags[from]) return false;
    const slots = [];
    const movable = [];
    model.forEach((s, i) => {
      if (flags[i]) {
        slots.push(i);
        movable.push(s);
      }
    });
    const fromSlot = slots.indexOf(from);
    let toSlot = 0;
    slots.forEach((slotIdx, k) => {
      if (slotIdx <= toIndex) toSlot = k;
    });
    if (fromSlot < 0 || fromSlot === toSlot) return false;
    layoutSnapshot();
    const moved = movable.splice(fromSlot, 1)[0];
    movable.splice(toSlot, 0, moved);
    slots.forEach((slotIdx, k) => {
      model[slotIdx] = movable[k];
    });
    L.selected = slots[toSlot];
    layoutAfterStructural();
    return true;
  }

  function layoutFreshenCopy(model, copy) {
    const used = new Set();
    model.forEach((s) => {
      if (s && typeof s.id === 'string' && s.id) used.add(s.id);
      const a = s && s.content && typeof s.content === 'object' ? s.content.anchorId : '';
      if (typeof a === 'string' && a) used.add(a);
    });
    const fresh = (base) => {
      const stem = String(base || 'section').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48) || 'section';
      let candidate = `${stem}-copy`;
      let n = 2;
      while (used.has(candidate)) {
        candidate = `${stem}-copy-${n}`;
        n += 1;
      }
      used.add(candidate);
      return candidate;
    };
    if (typeof copy.id === 'string' && copy.id) copy.id = fresh(copy.id);
    if (copy.content && typeof copy.content.anchorId === 'string' && copy.content.anchorId) {
      copy.content.anchorId = fresh(copy.content.anchorId);
    }
  }

  function layoutAct(action, index) {
    const L = layoutSession();
    if (!L || L.freeform || state.layoutBusy) return;
    const info = layoutModelFlags(index);
    if (!info) return;
    if (action === 'edit') {
      layoutEditSection(index);
      return;
    }
    if (action === 'up' || action === 'down') {
      const slots = [];
      L.model.forEach((s, i) => {
        if (layoutInfo(s).movable) slots.push(i);
      });
      const pos = slots.indexOf(index);
      const target = action === 'up' ? slots[pos - 1] : slots[pos + 1];
      if (target != null) layoutMoveClient(index, target);
      return;
    }
    if (action === 'duplicate') {
      if (!info.canDuplicate) {
        if (info.duplicateReason) setLayoutMsg(info.duplicateReason, 'err');
        return;
      }
      layoutSnapshot();
      const copy = JSON.parse(JSON.stringify(L.model[index]));
      layoutFreshenCopy(L.model, copy);
      L.model.splice(index + 1, 0, copy);
      L.selected = index + 1;
      layoutAfterStructural();
      return;
    }
    if (action === 'delete') {
      if (!info.canDelete) return;
      layoutSnapshot();
      L.model.splice(index, 1);
      L.selected = Math.min(index, L.model.length - 1);
      layoutAfterStructural();
    }
  }

  function layoutSelect(index, fromCanvas) {
    const L = layoutSession();
    if (!L) return;
    L.selected = index;
    renderLayoutRail();
    renderLayoutSide();
    if (!fromCanvas && index >= 0) postLayoutHighlight(index);
  }

  function layoutUndo() {
    const L = layoutSession();
    if (!L || !L.undo.length) return;
    const prev = L.undo.pop();
    L.model = JSON.parse(prev);
    if (L.selected >= L.model.length) L.selected = L.model.length - 1;
    layoutMarkDirty();
    renderLayoutBar();
    renderLayoutCanvas();
  }

  async function layoutEditSection(index) {
    const L = layoutSession();
    const info = layoutModelFlags(index);
    if (!L || !info) return;
    if (info.moduleType) {
      // Module sections edit in their EXISTING portal settings UI
      // (the Modules tab) — the layout session (and any unsaved
      // changes) stays loaded under the Website tab.
      state.layoutOpen = false;
      syncLayoutUi();
      showPortalPanel('modules');
      try {
        await loadModules();
        if (moduleState && Array.isArray(moduleState.summary ? moduleState.summary.modules : [])) {
          moduleState.current = info.moduleType;
          renderModuleTypeTabs();
          await loadModuleItems();
        }
      } catch {
        /* modules panel reports its own errors */
      }
      return;
    }
    // Content / HTML / chrome sections edit in the existing preview
    // Edit mode, which works on the SAVED site — save first if dirty.
    if (L.dirty) {
      if (!window.confirm('Save your layout changes before editing content?')) return;
      const okSave = await saveLayout();
      if (!okSave) return;
    }
    closeLayout({ force: true, skipReload: true });
    await loadEditablePreview(state.previewUrl);
    setEditMode(true, { fullscreen: true });
  }

  async function saveLayout() {
    const L = layoutSession();
    if (!L || !L.dirty || state.layoutBusy) return false;
    state.layoutBusy = true;
    syncLayoutUi();
    setLayoutMsg('Saving…', '');
    try {
      const data = await api('/site/layout', {
        method: 'POST',
        body: JSON.stringify({ slug: L.slug, sections: L.model }),
      });
      L.saved = JSON.parse(JSON.stringify(L.model));
      L.undo = [];
      L.dirty = false;
      if (data.previewUrl) state.previewUrl = data.previewUrl;
      if (data.menu || data.pages) state.structure = { menu: data.menu, pages: data.pages };
      const un = Array.isArray(data.unpublishedModules) ? data.unpublishedModules : [];
      setLayoutMsg(
        un.length
          ? `Layout saved — preview updated. That removed the last ${un.join(', ')} block on the site, so the module was unpublished; its data is kept and it can be switched back on in Modules.`
          : 'Layout saved — preview updated.',
        'ok'
      );
      renderLayoutBar();
      await renderLayoutCanvas();
      return true;
    } catch (e) {
      setLayoutMsg(errText(e), 'err');
      return false;
    } finally {
      state.layoutBusy = false;
      syncLayoutUi();
    }
  }

  /* ---- ADD palette ------------------------------------------------- */
  function layoutInsertIndex(afterIndex) {
    const L = layoutSession();
    const model = L.model;
    let at = afterIndex == null ? model.length : afterIndex + 1;
    const footerAt = model.findIndex((s) => String(s.type || '').toLowerCase() === 'footer');
    if (footerAt >= 0 && at > footerAt) at = footerAt;
    if (model[0] && String(model[0].type || '').toLowerCase() === 'nav' && at < 1) at = 1;
    return Math.max(0, Math.min(at, model.length));
  }

  function layoutOpenPalette(afterIndex) {
    const L = layoutSession();
    if (!L || L.freeform) return;
    L.addAfter = afterIndex == null ? null : afterIndex;
    L.paletteOpen = true;
    renderLayoutPalette();
  }

  function renderLayoutPalette() {
    const L = layoutSession();
    const wrap = document.getElementById('layout-palette');
    const list = document.getElementById('layout-palette-list');
    const title = document.getElementById('layout-palette-title');
    if (!wrap || !list) return;
    const open = !!(L && L.paletteOpen && !L.freeform);
    wrap.hidden = !open;
    if (!open) return;
    if (title) {
      const after =
        L.addAfter != null && L.model[L.addAfter]
          ? layoutInfo(L.model[L.addAfter]).label
          : null;
      title.textContent = after ? `Add a section below “${after}”` : 'Add a section (goes above the footer)';
    }
    while (list.firstChild) list.removeChild(list.firstChild);
    const group = (name) => list.appendChild(layoutEl('p', 'layout-palette-group', name));
    const grid = () => {
      const g = layoutEl('div', 'layout-palette-grid');
      list.appendChild(g);
      return g;
    };
    group('Content sections');
    const contentGrid = grid();
    for (const c of (L.palette && L.palette.content) || []) {
      const b = layoutEl('button', '', c.label);
      b.type = 'button';
      b.setAttribute('data-layout-pick', 'content');
      b.setAttribute('data-layout-pick-type', c.type);
      contentGrid.appendChild(b);
    }
    group('Site modules');
    const modGrid = grid();
    const presentFences = {};
    L.model.forEach((s) => {
      const info = layoutInfo(s);
      if (info.moduleType && L.fences[info.moduleType]) presentFences[info.moduleType] = true;
    });
    for (const m of (L.palette && L.palette.modules) || []) {
      const b = layoutEl('button', '', m.label);
      b.type = 'button';
      b.setAttribute('data-layout-pick', 'module');
      b.setAttribute('data-layout-pick-type', m.type);
      if (m.duplicateFence && presentFences[m.type]) {
        b.disabled = true;
        b.title = m.duplicateFence;
      }
      modGrid.appendChild(b);
    }
    if (!((L.palette && L.palette.modules) || []).length) {
      modGrid.appendChild(layoutEl('p', 'hint', 'No modules available on this plan.'));
    }
  }

  async function layoutPickSection(kind, type) {
    const L = layoutSession();
    if (!L || state.layoutBusy) return;
    state.layoutBusy = true;
    syncLayoutUi();
    try {
      const data = await api('/site/layout/section', {
        method: 'POST',
        body: JSON.stringify(kind === 'module' ? { kind, moduleType: type } : { kind, type }),
      });
      if (!data || !data.section) throw new Error('Could not build that section.');
      layoutSnapshot();
      const at = layoutInsertIndex(L.addAfter);
      L.model.splice(at, 0, data.section);
      L.selected = at;
      L.paletteOpen = false;
      layoutAfterStructural();
      setLayoutMsg('Section added — Save to keep it.', '');
    } catch (e) {
      setLayoutMsg(errText(e), 'err');
    } finally {
      state.layoutBusy = false;
      syncLayoutUi();
    }
  }

  function renderStructureLists() {
    const menuEl = document.getElementById('structure-menu');
    const tabsEl = document.getElementById('structure-page-tabs');
    const secsEl = document.getElementById('structure-sections');
    const hintEl = document.getElementById('structure-sections-hint');
    if (!menuEl || !tabsEl || !secsEl) return;
    const data = state.structure;
    if (!data || !Array.isArray(data.menu)) {
      menuEl.innerHTML = '<p class="hint">No menu yet.</p>';
      tabsEl.innerHTML = '';
      secsEl.innerHTML = '';
      if (hintEl) hintEl.hidden = true;
      return;
    }
    const busy = !!state.structureBusy;
    menuEl.innerHTML =
      data.menu
        .map((item) => {
          const pinned = !!item.pinned;
          const depth = Number(item.depth) === 1 ? 1 : 0;
          const from = item.index != null ? item.index : item.visualIndex;
          const canUp = !busy && !!item.canUp;
          const canDown = !busy && !!item.canDown;
          const canNest = !busy && !!item.canNest;
          const canUnnest = !busy && !!item.canUnnest;
          const navVisible = item.navVisible !== false;
          const visTitle = navVisible ? 'Hide from menu' : 'Show in menu';
          const meta = pinned ? 'Home' : depth === 1 ? 'Sub' : navVisible ? esc(item.slug || '') : 'Hidden';
          return `<div class="structure-row${pinned ? ' pinned' : ''}${depth === 1 ? ' depth-1' : ''}${navVisible ? '' : ' nav-hidden'}">
        <span class="structure-label">${esc(item.title || item.slug || 'Page')}</span>
        <span class="structure-meta">${meta}</span>
        <button type="button" class="structure-visibility${navVisible ? '' : ' off'}" data-struct="menu" data-from="${from}" data-action="toggleNav" ${pinned || busy ? 'disabled' : ''} aria-label="${visTitle}" aria-pressed="${navVisible ? 'true' : 'false'}" title="${visTitle}">👁</button>
        <button type="button" data-struct="menu" data-from="${from}" data-action="unnest" ${canUnnest ? '' : 'disabled'} aria-label="Move out of submenu">←</button>
        <button type="button" data-struct="menu" data-from="${from}" data-action="nest" ${canNest ? '' : 'disabled'} aria-label="Nest under previous">→</button>
        <button type="button" data-struct="menu" data-from="${from}" data-dir="-1" data-action="move" ${canUp ? '' : 'disabled'} aria-label="Move up">↑</button>
        <button type="button" data-struct="menu" data-from="${from}" data-dir="1" data-action="move" ${canDown ? '' : 'disabled'} aria-label="Move down">↓</button>
      </div>`;
        })
        .join('') || '<p class="hint">No pages.</p>';

    const pages = Array.isArray(data.pages) ? data.pages : [];
    if (state.structurePageIdx >= pages.length) state.structurePageIdx = Math.max(0, pages.length - 1);
    tabsEl.innerHTML = pages
      .map(
        (p, i) =>
          `<button type="button" class="${i === state.structurePageIdx ? 'active' : ''}" data-struct-page="${i}">${esc(p.title || p.slug || 'Page ' + (i + 1))}</button>`
      )
      .join('');

    const page = pages[state.structurePageIdx];
    const menuMeta =
      (data.menu || []).find((m) => m && m.index === state.structurePageIdx) || data.menu[state.structurePageIdx];
    const freeform = !!(menuMeta && menuMeta.freeform);
    if (hintEl) hintEl.hidden = !freeform;
    const sections = page && Array.isArray(page.sections) ? page.sections : [];
    const insertGap = (afterIndex) =>
      `<div class="structure-insert-row"><button type="button" data-struct-insert="${afterIndex}" ` +
      `${busy ? 'disabled' : ''} aria-label="Insert section">+</button></div>`;

    if (freeform && !sections.length) {
      secsEl.innerHTML = `${insertGap(0)}<p class="hint">Legacy freeform page — rebuild to modular sections, or + injects a site module into the HTML.</p>`;
    } else if (!sections.length) {
      secsEl.innerHTML = '<p class="hint">No sections on this page.</p>';
    } else {
      secsEl.innerHTML = sections
        .map((s, i) => {
          const pinned = !!s.pinned;
          let canUp = !busy && !pinned && i > 0;
          let canDown = !busy && !pinned && i < sections.length - 1;
          if (canUp && sections[i - 1] && sections[i - 1].pinned) canUp = false;
          if (canDown && sections[i + 1] && sections[i + 1].pinned) canDown = false;
          return `<div class="structure-row${pinned ? ' pinned' : ''}">
          <span class="structure-label">${esc(s.label || s.type || 'Section ' + (i + 1))}</span>
          <span class="structure-meta">${pinned ? 'Fixed' : esc(s.type || '')}</span>
          <button type="button" data-struct="sections" data-from="${i}" data-dir="-1" ${canUp ? '' : 'disabled'} aria-label="Move up">↑</button>
          <button type="button" data-struct="sections" data-from="${i}" data-dir="1" ${canDown ? '' : 'disabled'} aria-label="Move down">↓</button>
        </div>${insertGap(i)}`;
        })
        .join('');
    }
    const addPageBtn = document.getElementById('btn-structure-add-page');
    if (addPageBtn) addPageBtn.disabled = busy;
  }

  function closeStructureModuleModal() {
    const backdrop = document.getElementById('structure-module-modal');
    if (backdrop) backdrop.hidden = true;
    const msg = document.getElementById('msg-structure-module');
    if (msg) {
      msg.className = 'msg';
      msg.textContent = '';
    }
    state.canvasPick = null;
  }

  function closeStructurePageModal() {
    const backdrop = document.getElementById('structure-page-modal');
    if (backdrop) backdrop.hidden = true;
    const msg = document.getElementById('msg-structure-page');
    if (msg) {
      msg.className = 'msg';
      msg.textContent = '';
    }
  }

  const CONTENT_BLOCKS = [
    { type: 'heading', label: 'Heading' },
    { type: 'text', label: 'Text' },
    { type: 'image', label: 'Image' },
    { type: 'html', label: 'HTML' },
  ];

  const LAYOUT_BLOCKS = [
    { type: 'columns', label: '1 column', cols: 1 },
    { type: 'columns', label: '2 columns', cols: 2 },
    { type: 'columns', label: '3 columns', cols: 3 },
    { type: 'columns', label: '4 columns', cols: 4 },
    { type: 'columns', label: '5 columns', cols: 5 },
    { type: 'columns', label: '6 columns', cols: 6 },
    { type: 'text_image', label: 'Text + image' },
    { type: 'cards', label: 'Cards' },
  ];

  const LEGACY_SECTION_BLOCKS = [
    { type: 'hero', label: 'Hero' },
    { type: 'services', label: 'Services' },
    { type: 'benefits', label: 'Benefits' },
    { type: 'about', label: 'About' },
    { type: 'faq', label: 'FAQ' },
    { type: 'cta', label: 'CTA' },
    { type: 'reviews', label: 'Reviews' },
    { type: 'gallery', label: 'Gallery' },
  ];

  function resolveStructureCols(btn) {
    if (!btn) return null;
    const fromSel = btn.getAttribute('data-structure-cols-from');
    if (fromSel) {
      const input = document.querySelector(fromSel);
      const n = input ? Number(input.value) : NaN;
      if (Number.isFinite(n)) return Math.max(1, Math.min(12, Math.round(n)));
    }
    const cols = btn.getAttribute('data-structure-cols');
    return cols != null ? Number(cols) : null;
  }

  function renderBlockPickerGroups({
    showLayouts = true,
    showWidgets = true,
    includeLegacy = false,
    canModules = false,
    mods = [],
    forms = [],
  } = {}) {
    let html = '';
    if (showLayouts) {
      html += `<div class="structure-block-group"><p class="hint" style="margin:0 0 8px">Design modules — Content</p>${CONTENT_BLOCKS.map(
        (b) => `<button type="button" class="picker-card" data-structure-section-type="${esc(b.type)}"><span class="picker-card-icon" aria-hidden="true">${blockIconSvg(b.type)}</span><span>${esc(b.label)}</span></button>`
      ).join('')}</div>`;
      html += `<div class="structure-block-group"><p class="hint" style="margin:0 0 8px">Design modules — Layout</p>${LAYOUT_BLOCKS.map(
        (b) =>
          `<button type="button" class="picker-card" data-structure-section-type="${esc(b.type)}"${b.cols ? ` data-structure-cols="${b.cols}"` : ''}><span class="picker-card-icon" aria-hidden="true">${blockIconSvg(b.type)}</span><span>${esc(b.label)}</span></button>`
      ).join('')}</div>`;
      if (includeLegacy) {
        html += `<div class="structure-block-group"><p class="hint" style="margin:0 0 8px">Page sections</p>${LEGACY_SECTION_BLOCKS.map(
          (b) => `<button type="button" class="picker-card" data-structure-section-type="${esc(b.type)}"><span class="picker-card-icon" aria-hidden="true">${blockIconSvg(b.type)}</span><span>${esc(b.label)}</span></button>`
        ).join('')}</div>`;
      }
    }
    if (showWidgets) {
      html += `<div class="structure-block-group"><p class="hint" style="margin:0 0 8px">Widgets — Forms</p>${
        forms.length
          ? forms
              .map((f) => {
                const form = f.form || f;
                return `<button type="button" class="picker-card" data-structure-form-id="${esc(String(form.id))}"><span class="picker-card-icon" aria-hidden="true">${blockIconSvg('form')}</span><span>${esc(form.name || form.title || 'Form ' + form.id)}</span></button>`;
              })
              .join('')
          : '<p class="hint">No forms yet. Create one in Forms.</p>'
      }</div>`;
      html += canModules
        ? `<div class="structure-block-group"><p class="hint" style="margin:0 0 8px">Widgets — Site modules</p><p class="hint" style="margin:0 0 8px">Placed widgets are styled to match your site automatically.</p>${
            (mods || [])
              .map(
                (m) =>
                  `<button type="button" class="picker-card" data-structure-module-type="${esc(m.type)}"><span class="picker-card-icon${moduleIconTint(m.type)}" aria-hidden="true">${moduleIconSvg(m.type)}</span><span>${esc(m.label || m.type)}</span></button>`
              )
              .join('') || '<p class="hint">No modules available.</p>'
          }</div>`
        : '<p class="hint">Site modules require a paid plan (Standard, Pro, or Premium).</p>';
    }
    return html || '<p class="hint">Nothing to insert.</p>';
  }

  function postInsertBlockToFrame(payload) {
    const frame = state.previewFrame;
    if (!frame || !frame.contentWindow) return;
    try {
      frame.contentWindow.postMessage(
        {
          source: 'ws-portal',
          type: 'insert-block',
          targetId: payload.targetId,
          html: payload.html || '',
        },
        '*'
      );
    } catch {
      /* */
    }
  }

  async function applyCanvasPickLayout(sectionType, cols) {
    const pick = state.canvasPick;
    if (!pick || !pick.targetId) return;
    const msg = document.getElementById('msg-structure-module');
    try {
      const body = { kind: 'layout', type: sectionType };
      if (cols != null) body.cols = Number(cols);
      const data = await api('/site/canvas-block', { method: 'POST', body: JSON.stringify(body) });
      closeStructureModuleModal();
      postInsertBlockToFrame({ targetId: pick.targetId, html: data.html || '' });
    } catch (e) {
      if (msg) {
        msg.className = 'msg err';
        msg.textContent = errText(e);
      }
    }
  }

  async function applyCanvasPickModule(moduleType) {
    const pick = state.canvasPick;
    if (!pick || !pick.targetId) return;
    const msg = document.getElementById('msg-structure-module');
    try {
      const data = await api('/site/canvas-block', {
        method: 'POST',
        body: JSON.stringify({ kind: 'module', type: moduleType }),
      });
      closeStructureModuleModal();
      postInsertBlockToFrame({ targetId: pick.targetId, html: data.html || '' });
    } catch (e) {
      if (msg) {
        msg.className = 'msg err';
        msg.textContent = errText(e);
      }
    }
  }

  async function applyCanvasPickForm(formId) {
    const pick = state.canvasPick;
    if (!pick || !pick.targetId) return;
    const msg = document.getElementById('msg-structure-module');
    try {
      const data = await api('/site/canvas-block', {
        method: 'POST',
        body: JSON.stringify({ kind: 'form', formId }),
      });
      closeStructureModuleModal();
      postInsertBlockToFrame({ targetId: pick.targetId, html: data.html || '' });
    } catch (e) {
      if (msg) {
        msg.className = 'msg err';
        msg.textContent = errText(e);
      }
    }
  }

  /**
   * @param {number} afterIndex structure sidebar insert index (ignored for canvas)
   * @param {{ mode?: 'all'|'design-module'|'widget', targetId?: string, pageIndex?: number }} opts
   */
  async function openStructureModuleModal(afterIndex, opts = {}) {
    const mode = String(opts.mode || 'all').toLowerCase();
    state.structureInsertAfter = Number(afterIndex);
    state.canvasPick =
      mode === 'design-module' || mode === 'widget'
        ? { mode, targetId: opts.targetId || '', pageIndex: opts.pageIndex }
        : null;
    const backdrop = document.getElementById('structure-module-modal');
    const listEl = document.getElementById('structure-module-list');
    const msg = document.getElementById('msg-structure-module');
    const titleEl = document.getElementById('structure-module-modal-title');
    const ledeEl = backdrop ? backdrop.querySelector('.lede') : null;
    if (!backdrop || !listEl) return;
    if (msg) {
      msg.className = 'msg';
      msg.textContent = '';
    }
    if (titleEl) {
      titleEl.textContent =
        mode === 'design-module' ? 'Add design module' : mode === 'widget' ? 'Add widget' : 'Insert block';
    }
    if (ledeEl) {
      ledeEl.textContent =
        mode === 'design-module'
          ? 'Choose a design module (heading, text, image, columns, HTML, …) to place in this section.'
          : mode === 'widget'
            ? 'Choose a form or site module to place inside this design module. It will be styled to match your site.'
            : 'Page → Section → Design module → Widget. Add layouts or live widgets. Style module/form mounts — do not leave bare default embeds.';
    }
    listEl.innerHTML = '<p class="hint">Loading…</p>';
    backdrop.hidden = false;
    const showLayouts = mode === 'all' || mode === 'design-module';
    const showWidgets = mode === 'all' || mode === 'widget';
    try {
      let mods = moduleState.summary && Array.isArray(moduleState.summary.modules) ? moduleState.summary.modules : null;
      if (!mods && showWidgets) {
        const data = await api('/modules');
        mods = Array.isArray(data.modules) ? data.modules : [];
        moduleState.summary = data;
      }
      const canModules = moduleState.enabled || (moduleState.summary && moduleState.summary.siteModules);
      let formList = [];
      if (showWidgets) {
        try {
          const formData = await api('/forms');
          formList = Array.isArray(formData.forms) ? formData.forms : formData.form ? [formData.form] : [];
        } catch {
          formList = [];
        }
      }
      listEl.innerHTML = renderBlockPickerGroups({
        showLayouts,
        showWidgets,
        includeLegacy: mode === 'all',
        canModules,
        mods,
        forms: formList,
      });
    } catch (e) {
      listEl.innerHTML = renderBlockPickerGroups({
        showLayouts,
        showWidgets,
        includeLegacy: mode === 'all',
      });
      if (msg) {
        msg.className = 'msg err';
        msg.textContent = errText(e);
      }
    }
  }

  function openStructurePageModal() {
    const backdrop = document.getElementById('structure-page-modal');
    const input = document.getElementById('structure-page-title');
    const msg = document.getElementById('msg-structure-page');
    if (!backdrop) return;
    if (input) input.value = '';
    if (msg) {
      msg.className = 'msg';
      msg.textContent = '';
    }
    backdrop.hidden = false;
    if (input) input.focus();
  }

  async function postStructureBody(body, okMessage) {
    if (!state.siteEditable || state.structureBusy) return;
    state.structureBusy = true;
    syncStructureUi();
    renderStructureLists();
    setStructureMsg('Saving…', '');
    try {
      const result = await api('/site/structure', { method: 'POST', body: JSON.stringify(body) });
      if (result) {
        state.structure = { menu: result.menu, pages: result.pages };
        if (result.previewUrl) state.previewUrl = result.previewUrl;
        if (Number.isInteger(result.pageIndex)) state.structurePageIdx = result.pageIndex;
      }
      renderStructureLists();
      setStructureMsg(`${okMessage} Refreshing preview…`, 'ok');
      await loadEditablePreview(state.previewUrl, {
        preserveEditMode: state.editMode,
        preserveFullscreen: state.editFullscreen,
      });
      setStructureMsg(`${okMessage}`, 'ok');
    } catch (e) {
      setStructureMsg(errText(e), 'err');
      await loadStructure({ quiet: true });
    } finally {
      state.structureBusy = false;
      syncStructureUi();
      renderStructureLists();
    }
  }

  async function applyStructureInsertModule(moduleType) {
    closeStructureModuleModal();
    await postStructureBody(
      {
        scope: 'sections',
        action: 'insertModule',
        pageIndex: state.structurePageIdx,
        afterIndex: state.structureInsertAfter,
        moduleType,
      },
      'Module block saved.'
    );
  }

  async function applyStructureInsertForm(formId) {
    const msg = document.getElementById('msg-structure-module');
    try {
      const data = await api('/site/canvas-block', {
        method: 'POST',
        body: JSON.stringify({ kind: 'form', formId }),
      });
      const wrap =
        '<section class="ws-page-section" data-ws-page-section="1">' +
        (data && data.html ? data.html : '') +
        '</section>';
      closeStructureModuleModal();
      await postStructureBody(
        {
          scope: 'sections',
          action: 'insertSection',
          pageIndex: state.structurePageIdx,
          afterIndex: state.structureInsertAfter,
          sectionType: 'html',
          html: wrap,
        },
        'Form block saved.'
      );
    } catch (e) {
      if (msg) {
        msg.className = 'msg err';
        msg.textContent = errText(e);
      }
    }
  }

  async function applyStructureInsertSection(sectionType, cols) {
    closeStructureModuleModal();
    const body = {
      scope: 'sections',
      action: 'insertSection',
      pageIndex: state.structurePageIdx,
      afterIndex: state.structureInsertAfter,
      sectionType,
    };
    if (cols != null) body.cols = Number(cols);
    await postStructureBody(body, 'Section saved.');
  }

  async function applyStructureAddPage(title) {
    closeStructurePageModal();
    await postStructureBody(
      {
        scope: 'menu',
        action: 'addPage',
        title,
      },
      'Page created.'
    );
  }

  async function loadStructure(opts = {}) {
    if (!state.siteEditable) return null;
    try {
      const data = await api('/site/structure');
      state.structure = data || null;
      if (!opts.quiet) setStructureMsg('', '');
      renderStructureLists();
      return data;
    } catch (e) {
      if (!opts.quiet) setStructureMsg(errText(e), 'err');
      return null;
    }
  }

  async function applyStructureMove(scope, fromIndex, direction, action) {
    if (!state.siteEditable || state.structureBusy) return;
    state.structureBusy = true;
    syncStructureUi();
    renderStructureLists();
    const act = String(action || 'move').toLowerCase();
    const nesting = act === 'nest' || act === 'unnest';
    const toggleNav = act === 'togglenav';
    setStructureMsg(
      toggleNav
        ? 'Updating menu visibility…'
        : nesting
          ? act === 'nest'
            ? 'Nesting…'
            : 'Unnesting…'
          : 'Saving order…',
      ''
    );
    try {
      const body = {
        scope,
        fromIndex: Number(fromIndex),
        action: toggleNav ? 'toggleNav' : nesting ? act : 'move',
      };
      if (!nesting && !toggleNav) body.direction = Number(direction);
      if (scope === 'sections') body.pageIndex = state.structurePageIdx;
      const result = await api('/site/structure', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      if (result) {
        state.structure = {
          menu: result.menu,
          pages: result.pages,
        };
        if (result.previewUrl) state.previewUrl = result.previewUrl;
      }
      renderStructureLists();
      setStructureMsg(toggleNav ? 'Menu updated. Refreshing preview…' : 'Order updated. Refreshing preview…', 'ok');
      await loadEditablePreview(state.previewUrl, {
        preserveEditMode: state.editMode,
        preserveFullscreen: state.editFullscreen,
      });
      setStructureMsg(toggleNav ? 'Menu visibility saved.' : 'Order saved on your site.', 'ok');
      setTimeout(() => {
        const msg = document.getElementById('msg-structure');
        if (
          msg &&
          (msg.textContent.indexOf('Order saved') === 0 || msg.textContent.indexOf('Menu visibility saved') === 0)
        ) {
          msg.className = 'msg';
          msg.textContent = '';
        }
      }, 3500);
    } catch (e) {
      setStructureMsg(errText(e), 'err');
      await loadStructure({ quiet: true });
    } finally {
      state.structureBusy = false;
      syncStructureUi();
      renderStructureLists();
    }
  }

  function syncEditModeUi() {
    const btn = document.getElementById('btn-edit-mode');
    const label = document.getElementById('btn-edit-mode-label');
    const box = document.getElementById('preview-box');
    const lede = document.getElementById('preview-lede');
    const on = !!(state.siteEditable && state.editMode);
    if (on || state.themeOpen) ensureCatalogStyles(document);
    syncThemeUi();
    syncStructureUi();
    syncLayoutUi();

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
        ? 'Edit mode on — click text to edit it, then pick a font for that element or for the whole site.'
        : 'Click Edit to change copy, fonts, images, or list items. Use the Changes tab for bigger updates.';
    }
    if (!state.siteEditable && state.editFullscreen) setEditFullscreen(false);
    else syncFullscreenButtons();
    postEditModeToFrame(on);
    const elementFont = document.getElementById('edit-font-element');
    if (elementFont) elementFont.disabled = !on || !state.selectedEditId;
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
    const logoBar = document.getElementById('logo-bar');
    const n = state.pendingEdits.size;
    if (!bar) return;
    const show = state.siteEditable && (state.editMode || n > 0);
    bar.hidden = !show;
    if (logoBar) logoBar.hidden = !(state.siteEditable && state.editMode);
    if (!show) return;
    if (hint) {
      if (state.imageUploading || state.logoUploading) {
        hint.innerHTML = '<strong>Uploading…</strong> — hang tight while we resize and save it.';
      } else if (n > 0) {
        hint.innerHTML = `<strong>${n} unsaved edit${n === 1 ? '' : 's'}</strong> — Save to update your live preview, or Cancel to discard.`;
      } else {
        hint.innerHTML =
          '<strong>Edit mode</strong> — click text to change it. Delete section removes a block. Forms and other modules on the page have Delete module. Undo reverses the last add or delete.';
      }
    }
    if (saveBtn) saveBtn.disabled = n === 0 || state.imageUploading || state.logoUploading;
    const undoBtn = document.getElementById('btn-edit-undo');
    if (undoBtn) undoBtn.disabled = !state.canUndo || !state.editMode;
    syncLogoUi();
  }

  function syncLogoUi() {
    const logo = state.logo || { mode: 'text' };
    const modeImage = logo.mode === 'image' && !!(logo.publicUrl || logo.url);
    const textRadio = document.getElementById('logo-mode-text');
    const imageRadio = document.getElementById('logo-mode-image');
    const previewText = document.getElementById('logo-preview-text');
    const previewImg = document.getElementById('logo-preview-img');
    const removeBtn = document.getElementById('btn-logo-remove');
    const uploadBtn = document.getElementById('btn-logo-upload');
    if (textRadio) textRadio.checked = !modeImage;
    if (imageRadio) imageRadio.checked = modeImage;
    if (previewText) {
      previewText.textContent = logo.brandName || (state.client && state.client.business_name) || 'Business';
      previewText.hidden = modeImage;
    }
    if (previewImg) {
      if (modeImage) {
        previewImg.src = logo.publicUrl || logo.url;
        previewImg.hidden = false;
      } else {
        previewImg.removeAttribute('src');
        previewImg.hidden = true;
      }
    }
    if (removeBtn) removeBtn.hidden = !modeImage;
    if (uploadBtn) uploadBtn.disabled = !!state.logoUploading;
    if (removeBtn) removeBtn.disabled = !!state.logoUploading;
  }

  async function resizeLogoForUpload(file) {
    // Keep PNG when possible so transparency survives client resize.
    if (!/^image\/(jpeg|jpg|png|webp|gif)$/.test(file.type || '')) {
      throw new Error('Please choose a JPEG, PNG, WebP, or GIF image');
    }
    let bitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      throw new Error('Could not read that image');
    }
    const maxW = 1280;
    let w = bitmap.width;
    let h = bitmap.height;
    if (w > maxW) {
      h = Math.round((h * maxW) / w);
      w = maxW;
    }
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not resize logo');
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(bitmap, 0, 0, w, h);
    try {
      bitmap.close();
    } catch {
      /* */
    }
    const mime = file.type === 'image/png' || file.type === 'image/webp' ? 'image/png' : file.type || 'image/png';
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not compress logo'))), mime, 0.92);
    });
    if (blob.size > 5.2 * 1024 * 1024) {
      throw new Error('Logo is still too large after resize');
    }
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const s = String(reader.result || '');
        const i = s.indexOf(',');
        resolve(i >= 0 ? s.slice(i + 1) : s);
      };
      reader.onerror = () => reject(new Error('Could not read logo'));
      reader.readAsDataURL(blob);
    });
    return { data, mimeType: mime, bytes: blob.size };
  }

  async function applyLogoMode(mode, file) {
    if (!state.siteEditable || state.logoUploading) return;
    const msg = document.getElementById('msg-logo');
    state.logoUploading = true;
    updateEditBar();
    try {
      let body;
      if (mode === 'text') {
        body = { mode: 'text' };
        if (msg) {
          msg.className = 'msg';
          msg.textContent = 'Switching to text logo…';
        }
      } else {
        const prepared = file ? await resizeLogoForUpload(file) : null;
        if (!prepared) throw new Error('Choose a logo image');
        body = { mode: 'image', data: prepared.data, mimeType: prepared.mimeType };
        if (msg) {
          msg.className = 'msg';
          msg.textContent = 'Uploading logo…';
        }
      }
      const result = await api('/site/logo', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      state.logo = {
        mode: result.mode || mode,
        url: result.logoUrl || null,
        publicUrl: result.publicUrl || null,
        brandName: result.brandName || state.logo.brandName,
      };
      if (msg) {
        msg.className = 'msg ok';
        msg.textContent = mode === 'text' ? 'Using text logo again.' : 'Logo updated on your preview.';
      }
      await loadEditablePreview(state.previewUrl, {
        preserveEditMode: true,
        preserveFullscreen: state.editFullscreen,
      });
    } catch (e) {
      if (msg) {
        msg.className = 'msg err';
        msg.textContent = errText(e);
      }
      syncLogoUi();
    } finally {
      state.logoUploading = false;
      updateEditBar();
    }
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
      box.innerHTML =
        '<div class="preview-empty" id="preview-empty">No preview is available yet. We’ll notify you when it’s ready.</div>';
      if (lede) lede.textContent = 'Live look at the current site we built for you.';
      return;
    }
    if (lede) {
      lede.textContent = 'Live look at your site. Use the Changes tab for updates — this preview is view-only.';
    }
    box.innerHTML = `
      <iframe title="Website preview" src="${esc(previewUrl)}" sandbox="allow-scripts allow-forms" loading="lazy" referrerpolicy="no-referrer"></iframe>`;
  }

  function getPreviewScroll() {
    return { ...(state.previewScroll || { x: 0, y: 0 }), parentX: window.scrollX || 0, parentY: window.scrollY || 0 };
  }

  function restorePreviewScroll(pos) {
    if (!pos) return;
    try {
      window.scrollTo(pos.parentX || 0, pos.parentY || 0);
    } catch {
      /* */
    }
    const apply = () => {
      try {
        const win = state.previewFrame && state.previewFrame.contentWindow;
        if (win) win.postMessage({ source: 'ws-portal', type: 'restore-scroll', x: pos.x || 0, y: pos.y || 0 }, '*');
      } catch {
        /* */
      }
      try {
        window.scrollTo(pos.parentX || 0, pos.parentY || 0);
      } catch {
        /* */
      }
    };
    apply();
    requestAnimationFrame(apply);
    setTimeout(apply, 40);
    setTimeout(apply, 160);
    setTimeout(apply, 400);
  }

  function renderEditableHtml(html, previewUrl, opts = {}) {
    const box = document.getElementById('preview-box');
    const lede = document.getElementById('preview-lede');
    const keepEdit = !!opts.preserveEditMode;
    const keepFs = !!opts.preserveFullscreen;
    const scrollPos = opts.restoreScroll || null;
    state.siteEditable = true;
    state.editableHtml = html || '';
    state.canUndo = false;
    if (!keepEdit) state.editMode = false;
    setOpenPreview(previewUrl);
    if (lede && !keepEdit) {
      lede.textContent = 'Click Edit to change copy or images in the preview. Use the Changes tab for bigger updates.';
    }
    box.innerHTML = `
      <iframe title="Website preview" id="portal-preview-frame"
        sandbox="allow-scripts allow-forms"
        referrerpolicy="no-referrer"></iframe>`;
    const frame = document.getElementById('portal-preview-frame');
    state.previewFrame = frame;
    state.previewScroll = { x: 0, y: 0 };
    frame.addEventListener('load', () => {
      if (keepEdit || state.editMode) {
        state.editMode = true;
        if (keepFs) state.editFullscreen = true;
        syncEditModeUi();
        postEditModeToFrame(true);
      }
      if (scrollPos) restorePreviewScroll(scrollPos);
      // Batch 104: the new document starts bridge-empty —
      // re-apply any still-unverified optimistic patches.
      reapplyAgentChatPatches();
    });
    frame.srcdoc = html || '<p style="font-family:sans-serif;padding:1rem">Empty preview.</p>';
    if (!keepEdit) syncEditModeUi();
    else {
      // Keep chrome in edit mode while iframe loads
      state.editMode = true;
      if (keepFs) {
        state.editFullscreen = true;
        const sec = document.getElementById('sec-preview');
        if (sec) sec.classList.add('is-edit-fullscreen');
        document.body.classList.add('is-preview-fullscreen');
      }
      syncEditModeUi();
    }
  }

  function setAgentChatStatus(text, kind) {
    const el = document.getElementById('agent-chat-status');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('is-busy', kind === 'busy');
    el.classList.toggle('is-err', kind === 'err');
  }

  // Batch 97: today's design-chat usage, shown in the chat header
  // when the site's plan carries a daily cap ("7 of 20 chat
  // requests today"). Unlimited plans carry no chatUsage payload
  // and the line stays hidden.
  function renderAgentChatUsage(usage) {
    const el = document.getElementById('agent-chat-usage');
    if (!el) return;
    if (!usage || usage.limit == null || usage.used == null) {
      el.hidden = true;
      el.textContent = '';
      return;
    }
    el.textContent = `${usage.used} of ${usage.limit} chat requests today`;
    el.hidden = false;
  }

  // Batch 101 — the queue status line: the honest state of
  // this site's queued design job(s), straight from the job
  // rows (queued / building / in verification / waiting on
  // you / delivered). Fed by the history payload, the updates
  // poller and chat responses — same truth everywhere.
  const AGENT_QUEUE_LABELS = {
    queued: 'queued for the design agent',
    building: 'being built by the design agent',
    in_review: 'back with the design agent after verification',
    waiting_on_you: 'waiting on your answer',
    delivered: 'delivered',
  };
  function renderAgentChatQueue(queue) {
    const el = document.getElementById('agent-chat-queue');
    if (!el) return;
    const items = Array.isArray(queue) ? queue.filter((q) => q && q.jobId) : [];
    if (!items.length) {
      el.hidden = true;
      el.textContent = '';
      return;
    }
    const parts = items.map((q) => {
      const label = AGENT_QUEUE_LABELS[q.state] || AGENT_QUEUE_LABELS.queued;
      const age = q.ageMinutes != null && q.state !== 'delivered' ? ` · ${q.ageMinutes}m` : '';
      return `Design job #${q.jobId}: ${label}${age}`;
    });
    el.textContent = parts.join('  ·  ');
    el.hidden = false;
  }

  // Batch 100 — the rolling summary block: what the agent
  // remembers about THIS site (settled choices, changes applied,
  // open items), rendered once at the top of the thread from the
  // history payload. Text is set via textContent throughout —
  // summary entries are owner/agent text, never markup.
  function renderAgentChatSummary(summary) {
    const list = document.getElementById('agent-chat-messages');
    if (!list || !summary || document.getElementById('agent-chat-summary')) return;
    const sections = [
      ['decisions', 'Decisions'],
      ['preferences', 'Preferences'],
      ['settledStyle', 'Settled style choices'],
      ['changesApplied', 'Changes applied'],
      ['openItems', 'Open items'],
    ];
    const details = document.createElement('details');
    details.id = 'agent-chat-summary';
    details.className = 'agent-chat-summary';
    const head = document.createElement('summary');
    head.textContent = 'What your design agent remembers about this site';
    details.appendChild(head);
    let any = false;
    for (const [key, label] of sections) {
      const entries = (Array.isArray(summary[key]) ? summary[key] : []).filter((e) => e && e.status === 'active');
      if (!entries.length) continue;
      any = true;
      const title = document.createElement('div');
      title.className = 'agent-chat-summary-section';
      title.textContent = label;
      details.appendChild(title);
      const ul = document.createElement('ul');
      for (const entry of entries) {
        const li = document.createElement('li');
        li.textContent = String(entry.text || '');
        ul.appendChild(li);
      }
      details.appendChild(ul);
    }
    if (!any) return;
    list.insertBefore(details, list.firstChild);
  }

  function appendAgentBubble(role, text, attachments, follow) {
    const list = document.getElementById('agent-chat-messages');
    const empty = document.getElementById('agent-chat-empty');
    if (!list) return;
    if (empty) empty.remove();
    // Batch 110: measured BEFORE the append — is the owner
    // already reading at (or near) the newest message?
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 96;
    const div = document.createElement('div');
    div.className = `agent-bubble ${role === 'user' ? 'user' : 'assistant'}`;
    if (text) {
      const span = document.createElement('span');
      span.textContent = String(text);
      div.appendChild(span);
    }
    // Batch 89: attached images render inline in the bubble; the <img>
    // src is the authorized attachment route (thumbnail), and clicking
    // opens the full image from the same route.
    const atts = Array.isArray(attachments) ? attachments : [];
    if (atts.length) {
      const imgs = document.createElement('div');
      imgs.className = 'bubble-imgs';
      for (const att of atts) {
        if (!att || !att.url) continue;
        const a = document.createElement('a');
        a.href = att.url;
        a.target = '_blank';
        a.rel = 'noopener';
        const img = document.createElement('img');
        img.src = att.thumbUrl || att.url;
        img.alt = att.name || 'Attached image';
        img.loading = 'lazy';
        a.appendChild(img);
        imgs.appendChild(a);
      }
      div.appendChild(imgs);
    }
    list.appendChild(div);
    // Batch 110: the message list scrolls internally (fixed
    // widget height). 'force' — the owner's own send and its
    // direct reply — always lands on the newest message.
    // 'gentle' (default — background poller write-backs) follows
    // only when the owner is already near the bottom, so reading
    // history is never yanked away. 'none' never scrolls (the
    // bulk history render scrolls once at the end).
    const mode = follow || 'gentle';
    if (mode === 'force' || (mode === 'gentle' && nearBottom)) {
      list.scrollTop = list.scrollHeight;
    }
  }

  function renderAgentChatPending() {
    const wrap = document.getElementById('agent-chat-pending');
    if (!wrap) return;
    wrap.innerHTML = '';
    wrap.hidden = !state.agentChatPending.length;
    state.agentChatPending.forEach((att, idx) => {
      const chip = document.createElement('span');
      chip.className = 'agent-chat-chip';
      const img = document.createElement('img');
      img.src = att.thumbUrl || att.url;
      img.alt = '';
      const name = document.createElement('span');
      name.className = 'chip-name';
      name.textContent = att.name || 'Image';
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'chip-remove';
      rm.setAttribute('aria-label', 'Remove attachment');
      rm.textContent = '×';
      rm.addEventListener('click', () => {
        state.agentChatPending.splice(idx, 1);
        renderAgentChatPending();
      });
      chip.appendChild(img);
      chip.appendChild(name);
      chip.appendChild(rm);
      wrap.appendChild(chip);
    });
  }

  async function onAgentChatFiles(fileList) {
    const files = Array.from(fileList || []);
    for (const file of files) {
      if (state.agentChatPending.length >= 4) {
        setAgentChatStatus('Up to 4 images per message.', 'err');
        break;
      }
      if (!/^image\/(png|jpe?g|webp|gif)$/i.test(file.type || '')) {
        setAgentChatStatus('Images only — PNG, JPG, WebP or GIF.', 'err');
        continue;
      }
      if (file.size > 10 * 1024 * 1024) {
        setAgentChatStatus('That image is over the 10 MB limit.', 'err');
        continue;
      }
      setAgentChatStatus('Attaching image…', 'busy');
      try {
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(new Error('Could not read that file.'));
          reader.readAsDataURL(file);
        });
        const att = await api('/site/agent-chat/attachments', {
          method: 'POST',
          body: JSON.stringify({ data: dataUrl, name: file.name }),
        });
        if (att && att.id) {
          state.agentChatPending.push(att);
          renderAgentChatPending();
          setAgentChatStatus('', '');
        }
      } catch (e) {
        setAgentChatStatus(errText(e), 'err');
      }
    }
  }

  function syncAgentChatUi() {
    const input = document.getElementById('agent-chat-input');
    const send = document.getElementById('agent-chat-send');
    const busy = !!state.agentChatBusy;
    if (input) input.disabled = busy;
    if (send) {
      send.disabled = busy;
      send.textContent = busy ? 'Working…' : 'Send';
    }
  }

  // ---------------------------------------------------------------
  // Batch 104 — OPTIMISTIC PREVIEW. When a change is accepted,
  // the owner sees it in the preview instantly; the verified
  // build remains the only truth. Three tiers:
  //   1. A deterministic quoted-text swap ("change "X" to "Y"")
  //      is parsed HERE, locally, and patched into the preview
  //      at send time — no server round-trip.
  //   2. Other small changes: the server derives a patch spec
  //      from the turn's plan (payload.optimisticPatch) and it
  //      is applied when the plan returns.
  //   3. Structural changes get a skeleton treatment on the
  //      preview — never fake content.
  // Transport is the owner-only postMessage bridge into the
  // preview iframe (public/js/preview-bridge.js) with an
  // allowlist of ops (text / style / vars — never raw HTML).
  // A patch is preview-only: on verification success the
  // verified render replaces it; on failure it is reverted and
  // the owner gets a plain-language notice.
  // ---------------------------------------------------------------

  function parseAgentChatTextSwap(text) {
    const s = String(text || '').trim();
    if (!s || s.length > 1200) return null;
    // A question that merely quotes text is not a change.
    if (
      /^(what|why|how|when|where|who|which|is|are|was|were|do|does|did|can|could|should|would)\b/i.test(s) &&
      s.endsWith('?')
    ) {
      return null;
    }
    const OPEN = '["\\u201C]';
    const CLOSE = '["\\u201D]';
    const BODY = '[^"\\u201C\\u201D]';
    const patterns = [
      new RegExp(
        '\\b(?:change|replace|swap|update|edit|rename|set)\\b' +
          BODY +
          '{0,60}?' +
          OPEN +
          '(' +
          BODY +
          '{1,240}?)' +
          CLOSE +
          '\\s*(?:to|into|with)\\s*' +
          OPEN +
          '(' +
          BODY +
          '{1,400}?)' +
          CLOSE,
        'i'
      ),
      new RegExp(
        '\\bmake\\b' +
          BODY +
          '{0,60}?' +
          OPEN +
          '(' +
          BODY +
          '{1,240}?)' +
          CLOSE +
          '\\s+say\\s+' +
          OPEN +
          '(' +
          BODY +
          '{1,400}?)' +
          CLOSE,
        'i'
      ),
    ];
    for (const re of patterns) {
      const m = s.match(re);
      if (!m) continue;
      const from = m[1].trim();
      const to = m[2].trim();
      if (from.length >= 2 && to && from !== to) return { from, to };
    }
    return null;
  }

  function postAgentPatchMessage(msg) {
    const frame = state.previewFrame;
    if (!frame || !frame.contentWindow) return;
    try {
      frame.contentWindow.postMessage({ source: 'ws-portal', ...msg }, '*');
    } catch {
      /* a dead frame drops the patch silently — verification is server-side */
    }
  }

  function syncAgentPatchUi() {
    const box = document.getElementById('preview-box');
    if (!box) return;
    let any = false;
    let skeleton = false;
    for (const p of state.agentChatPatches.values()) {
      any = true;
      if (p.tier === 3) skeleton = true;
    }
    box.classList.toggle('is-patch-skeleton', skeleton);
    box.classList.toggle('is-patch-applying', any && !skeleton);
  }

  function applyAgentPatchWithRetry(patch) {
    syncAgentPatchUi();
    if (!patch || !Array.isArray(patch.ops) || !patch.ops.length) return;
    if (patch._timer) clearTimeout(patch._timer);
    patch._acked = false;
    let attempts = 0;
    const delays = [120, 350, 700, 1200, 2000];
    const post = () => {
      if (!state.agentChatPatches.has(patch.id) || patch._acked) return;
      postAgentPatchMessage({ type: 'chat-patch-apply', patchId: patch.id, ops: patch.ops });
      attempts += 1;
      if (attempts <= delays.length) patch._timer = setTimeout(post, delays[attempts - 1]);
    };
    post();
  }

  function trackAgentPatch(patch) {
    if (!patch || !patch.id) return null;
    const tracked = { createdAt: Date.now(), ...patch };
    state.agentChatPatches.set(tracked.id, tracked);
    applyAgentPatchWithRetry(tracked);
    return tracked;
  }

  function dropAgentPatch(id, opts = {}) {
    const patch = state.agentChatPatches.get(id);
    if (!patch) return;
    if (patch._timer) clearTimeout(patch._timer);
    state.agentChatPatches.delete(id);
    if (opts.revert) postAgentPatchMessage({ type: 'chat-patch-revert', patchId: id });
    syncAgentPatchUi();
  }

  function handleAgentPatchResult(data) {
    const patch = state.agentChatPatches.get(String(data.patchId || ''));
    if (!patch) return;
    if (typeof data.applied === 'number') {
      patch._acked = true;
      if (patch._timer) clearTimeout(patch._timer);
      if (data.applied === 0 && patch.ops.length) {
        // The spec grounded nothing in this preview document
        // (e.g. the text lives on another page) — drop it
        // quietly rather than badge a change that isn't shown.
        state.agentChatPatches.delete(patch.id);
        syncAgentPatchUi();
      }
    }
  }

  /** A fresh preview document starts bridge-empty: re-apply the
   * patches whose jobs are still unverified. */
  function reapplyAgentChatPatches() {
    for (const patch of state.agentChatPatches.values()) {
      applyAgentPatchWithRetry(patch);
    }
  }

  /**
   * Resolve tracked patches against the poller's truth (Batch
   * 101 queue states + the job-linked write-back messages):
   *   delivered  -> the verified render wins: drop the patch
   *                 and reload the preview from the real site.
   *   in_review  -> the delivery bounced in verification:
   *                 revert the patch, reload the truth, and
   *                 say plainly what happened.
   *   stale >24h -> drop quietly (job long resolved/abandoned).
   */
  function resolveAgentChatPatches(queue, messages) {
    if (!state.agentChatPatches.size) return;
    const q = Array.isArray(queue) ? queue : [];
    const msgs = Array.isArray(messages) ? messages : [];
    const reloadTruth = () => {
      loadEditablePreview(state.previewUrl, {
        preserveEditMode: state.editMode,
        preserveFullscreen: state.editFullscreen,
      }).catch(() => {});
    };
    for (const patch of [...state.agentChatPatches.values()]) {
      if (patch.jobId == null) continue;
      const entry = q.find((x) => x && Number(x.jobId) === Number(patch.jobId));
      const msg = msgs.find((m) => m && m.jobId != null && Number(m.jobId) === Number(patch.jobId));
      const msgText = msg ? String(msg.content || '') : '';
      const bounced =
        (entry && entry.state === 'in_review') || /didn.t pass verification/i.test(msgText);
      const delivered =
        (entry && entry.state === 'delivered') ||
        /queued design job is done|has been completed/i.test(msgText);
      if (bounced) {
        dropAgentPatch(patch.id, { revert: true });
        setAgentChatStatus(
          'That change didn’t pass verification, so the preview is back to your current site while the design agent reworks it.',
          ''
        );
        reloadTruth();
      } else if (delivered) {
        dropAgentPatch(patch.id);
        reloadTruth();
      } else if (Date.now() - (patch.createdAt || 0) > 24 * 3600 * 1000) {
        dropAgentPatch(patch.id, { revert: true });
      }
    }
    syncAgentPatchUi();
  }

  async function sendAgentChat(message) {
    const text = String(message || '').trim();
    const pending = state.agentChatPending.slice();
    if ((!text && !pending.length) || state.agentChatBusy) return;
    state.agentChatBusy = true;
    syncAgentChatUi();
    appendAgentBubble('user', text, pending, 'force');
    setAgentChatStatus('Updating your site…', 'busy');
    // Batch 104 Tier 1: a quoted text swap is patched into the
    // preview the moment the message is sent. It is provisional
    // until the server's verified outcome for this turn lands
    // (see the response handling below).
    let turnPatchId = null;
    const swap = parseAgentChatTextSwap(text);
    if (swap && state.previewFrame) {
      turnPatchId = `t1-${Date.now()}`;
      trackAgentPatch({ id: turnPatchId, tier: 1, ops: [{ op: 'text', from: swap.from, to: swap.to }], jobId: null });
    }
    try {
      // Batch 96: no history is sent — the server loads this
      // site's saved transcript itself; the local array is now
      // display state only.
      const body = { message: text };
      if (pending.length) body.attachmentIds = pending.map((p) => p.id);
      if (state.previewPageSlug) body.pageSlug = state.previewPageSlug;
      const data = await api('/site/agent-chat', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      if (data && data.chatUsage) renderAgentChatUsage(data.chatUsage);
      if (data && data.queueStatus) renderAgentChatQueue([data.queueStatus]);
      // Batch 104: reconcile this turn's patches with the
      // server's outcome. A queued change's server-derived spec
      // supersedes the Tier-1 guess and stays tracked under its
      // job id until the poller resolves it; every other outcome
      // ends the Tier-1 patch (the verified render below is the
      // truth for builds, and non-change turns revert it).
      const sp = data && data.optimisticPatch;
      let queuedPatch = null;
      let patchFailed = false;
      if (sp && sp.state === 'queued' && sp.jobId != null) {
        queuedPatch = trackAgentPatch({
          id: `job-${sp.jobId}`,
          tier: sp.tier === 2 ? 2 : 3,
          ops: Array.isArray(sp.ops) ? sp.ops : [],
          jobId: Number(sp.jobId),
        });
      } else if (sp && sp.state === 'failed') {
        patchFailed = true;
      }
      if (turnPatchId) dropAgentPatch(turnPatchId, { revert: true });
      const reply = (data && data.reply) || 'Done — check the preview.';
      appendAgentBubble('assistant', reply, null, 'force');
      state.agentChatPending = [];
      renderAgentChatPending();
      const historyText =
        text + pending.map((p) => `\n[Attached image: ${p.name || 'image'}]`).join('');
      state.agentChatHistory.push({ role: 'user', content: historyText || '(image attached)' });
      state.agentChatHistory.push({ role: 'assistant', content: reply });
      if (state.agentChatHistory.length > 20) {
        state.agentChatHistory = state.agentChatHistory.slice(-20);
      }
      if (data && data.previewUrl) state.previewUrl = data.previewUrl;
      if (data && data.logo) {
        state.logo = {
          mode: data.logo.mode || 'text',
          url: data.logo.url || null,
          publicUrl: data.logo.publicUrl || null,
          brandName: data.logo.brandName || null,
        };
        syncLogoUi();
      }
      if (data && data.theme) setThemeFromServer(data.theme);
      if (data && data.html) {
        renderEditableHtml(data.html, data.previewUrl || state.previewUrl, {
          preserveEditMode: state.editMode,
          preserveFullscreen: state.editFullscreen,
        });
        syncThemeUi();
      } else {
        await loadEditablePreview(state.previewUrl, {
          pageSlug: state.previewPageSlug || undefined,
          preserveEditMode: state.editMode,
          preserveFullscreen: state.editFullscreen,
        });
      }
      setAgentChatStatus(data && data.mutated ? 'Preview updated.' : '', data && data.error ? 'err' : '');
      if (data && data.error && !data.mutated) {
        setAgentChatStatus('Could not fully apply that change.', 'err');
      }
      // Batch 104: the preview now shows the fresh render; put
      // the queued change's patch onto it and say what the badge
      // means. A failed-verification build gets the plain notice
      // (the preview already shows the truth — nothing was kept).
      if (queuedPatch) {
        applyAgentPatchWithRetry(queuedPatch);
        setAgentChatStatus('Previewing that change now — it becomes final once it passes verification.', 'busy');
      } else if (patchFailed) {
        setAgentChatStatus('That change didn’t pass verification, so the preview shows your site as it is.', 'err');
      }
    } catch (e) {
      // Batch 104: the turn never landed — the speculative
      // Tier-1 patch comes back off (the frame was not swapped).
      if (turnPatchId) dropAgentPatch(turnPatchId, { revert: true });
      appendAgentBubble('assistant', errText(e), null, 'force');
      setAgentChatStatus(errText(e), 'err');
    } finally {
      state.agentChatBusy = false;
      syncAgentChatUi();
      fetchAgentChatUpdates();
    }
  }

  // Batch 93: design-agent completions for chat-queued big jobs are
  // delivered server-side into the thread. Fetch any undelivered
  // ones and append them as assistant bubbles (and into the chat
  // history, so later turns know the outcome). Runs when the chat
  // wires up, after each send, and on a gentle interval while the
  // builder is open — a queued job may finish at any time.
  async function fetchAgentChatUpdates() {
    try {
      const data = await api('/site/agent-chat/updates');
      if (data && data.queue) renderAgentChatQueue(data.queue);
      const msgs = (data && data.messages) || [];
      for (const m of msgs) {
        if (!m || !m.content) continue;
        // Batch 94: never render a server message twice — the
        // initial history load may already include this id.
        if (m.id != null) {
          if (state.agentChatServerIds.has(m.id)) continue;
          state.agentChatServerIds.add(m.id);
        }
        appendAgentBubble('assistant', m.content);
        state.agentChatHistory.push({ role: 'assistant', content: m.content });
      }
      if (msgs.length && state.agentChatHistory.length > 20) {
        state.agentChatHistory = state.agentChatHistory.slice(-20);
      }
      // Batch 104: queued optimistic patches resolve against
      // this same truth — delivered confirms (verified render
      // reloads), a verification bounce reverts with a notice.
      resolveAgentChatPatches(data && data.queue, msgs);
    } catch {
      /* updates are best-effort; the chat itself must never break */
    }
  }

  // Batch 94: on open, the chat window shows this site's most
  // recent saved messages (server-side CHAT_HISTORY_LIMIT = 50) —
  // the thread survives reloads and devices. Loaded once per page;
  // rendered ids are remembered so the updates poller can never
  // double-render a write-back that history already showed.
  async function loadAgentChatHistory() {
    if (state.agentChatHistoryLoaded) return;
    state.agentChatHistoryLoaded = true;
    try {
      const data = await api('/site/agent-chat/history');
      if (data && data.chatUsage) renderAgentChatUsage(data.chatUsage);
      if (data && data.queue) renderAgentChatQueue(data.queue);
      if (data && data.summary) renderAgentChatSummary(data.summary);
      const msgs = (data && data.messages) || [];
      if (!msgs.length || state.agentChatHistory.length) return;
      for (const m of msgs) {
        if (!m || !m.content) continue;
        if (m.id != null) state.agentChatServerIds.add(m.id);
        state.agentChatHistory.push({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content });
        appendAgentBubble(m.role === 'user' ? 'user' : 'assistant', m.content, null, 'none');
      }
      // Batch 110: the saved thread opens on its newest message.
      // The chat is wired at boot, before the app is shown — a
      // still-hidden list has no scroll height, so the snap is
      // repeated the first time the list actually becomes
      // visible, whenever that lands.
      const listEl = document.getElementById('agent-chat-messages');
      if (listEl) {
        const snapToBottom = () => { listEl.scrollTop = listEl.scrollHeight; };
        snapToBottom();
        if (listEl.clientHeight === 0 && 'IntersectionObserver' in window) {
          const io = new IntersectionObserver((entries) => {
            if (entries.some((e) => e.isIntersecting)) {
              snapToBottom();
              io.disconnect();
            }
          });
          io.observe(listEl);
        }
      }
    } catch {
      /* history is best-effort; the chat itself must never break */
    }
  }

  function wireAgentChat() {
    loadAgentChatHistory();
    fetchAgentChatUpdates();
    if (!wireAgentChat._poll) {
      wireAgentChat._poll = setInterval(fetchAgentChatUpdates, 60000);
    }
    const form = document.getElementById('agent-chat-form');
    const input = document.getElementById('agent-chat-input');
    const toggle = document.getElementById('agent-chat-toggle');
    const panel = document.getElementById('agent-chat');
    const fileInput = document.getElementById('agent-chat-file');
    if (fileInput) {
      fileInput.addEventListener('change', (ev) => {
        onAgentChatFiles(ev.target.files);
        ev.target.value = '';
      });
    }
    if (form) {
      form.addEventListener('submit', (ev) => {
        ev.preventDefault();
        const val = input ? input.value : '';
        if (input) input.value = '';
        sendAgentChat(val);
      });
    }
    if (input) {
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' && !ev.shiftKey) {
          ev.preventDefault();
          form && form.requestSubmit && form.requestSubmit();
        }
      });
    }
    // Batch 110 collapse wiring — start
    // ONE collapsed state for the chat panel, driven by both the
    // side rail tab and the in-header text toggle, remembered
    // per browser (localStorage). Split layout: the panel leaves
    // the flow and the preview takes the full width. Stacked
    // layout: the same state folds the panel vertically via the
    // CSS media query.
    const workspace = document.getElementById('website-workspace');
    const sideToggle = document.getElementById('agent-chat-side-toggle');
    const applyAgentChatCollapsed = (collapsed) => {
      state.agentChatCollapsed = collapsed;
      if (workspace) workspace.classList.toggle('is-chat-collapsed', collapsed);
      if (sideToggle) {
        sideToggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        sideToggle.setAttribute('aria-label', collapsed ? 'Expand design chat panel' : 'Collapse design chat panel');
      }
      if (toggle) {
        toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        toggle.textContent = collapsed ? 'Show chat' : 'Hide chat';
      }
      try {
        localStorage.setItem('portal.agentChatCollapsed', collapsed ? '1' : '0');
      } catch { /* storage unavailable — collapse just won't persist */ }
    };
    let savedCollapsed = false;
    try {
      savedCollapsed = localStorage.getItem('portal.agentChatCollapsed') === '1';
    } catch { /* storage unavailable — default expanded */ }
    applyAgentChatCollapsed(savedCollapsed);
    if (!wireAgentChat._collapseWired) {
      wireAgentChat._collapseWired = true;
      if (sideToggle) {
        sideToggle.addEventListener('click', () => applyAgentChatCollapsed(!state.agentChatCollapsed));
      }
      if (toggle) {
        toggle.addEventListener('click', () => applyAgentChatCollapsed(!state.agentChatCollapsed));
      }
    }
    // Batch 110 collapse wiring — end
  }

  async function loadEditablePreview(fallbackUrl, opts = {}) {
    try {
      const q = new URLSearchParams({ editable: '1' });
      if (opts.pageSlug != null && String(opts.pageSlug).trim() !== '') {
        q.set('pageSlug', String(opts.pageSlug).trim());
        state.previewPageSlug = String(opts.pageSlug).trim();
      }
      const data = await api('/site/render?' + q.toString());
      if (data && data.previewUrl) state.previewUrl = data.previewUrl;
      if (data && data.logo) {
        state.logo = {
          mode: data.logo.mode || 'text',
          url: data.logo.url || null,
          publicUrl: data.logo.publicUrl || null,
          brandName: data.logo.brandName || null,
        };
      }
      if (data && data.theme) setThemeFromServer(data.theme);
      const url = (data && data.previewUrl) || fallbackUrl || state.previewUrl;
      if (data && data.editable && data.html) {
        renderEditableHtml(data.html, url, opts);
        syncLogoUi();
        syncThemeUi();
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

  function previewNavSlug(data) {
    const raw = String((data && (data.slug || data.file)) || '')
      .trim()
      .replace(/^\.\//, '')
      .replace(/^\//, '')
      .replace(/\.html$/i, '');
    if (!raw || raw === 'index' || raw === 'home') return 'home';
    return raw.replace(/[^a-z0-9-_]/gi, '_');
  }

  function handlePreviewNavMessage(data) {
    if (!data) return;
    if (data.external) {
      if (data.href) {
        try {
          const url = new URL(data.href);
          if (/^https?:$/.test(url.protocol)) window.open(url.href, '_blank', 'noopener,noreferrer');
        } catch {
          /* */
        }
      }
      return;
    }
    const id = previewNavSlug(data);
    // Guard found no #anchor (single-page render or unrewritten link) — load that page.
    const pageSlug = id === 'home' ? '/' : id;
    loadEditablePreview(state.previewUrl, {
      pageSlug,
      preserveEditMode: state.editMode,
      preserveFullscreen: state.editFullscreen,
    });
  }

  function postImageBusyToFrame(src, on) {
    const frame = state.previewFrame;
    if (!frame || !frame.contentWindow) return;
    try {
      frame.contentWindow.postMessage(
        {
          source: 'ws-portal',
          type: 'image-busy',
          src: String(src || ''),
          on: !!on,
        },
        '*'
      );
    } catch {
      /* */
    }
  }

  function pickImageFile() {
    return new Promise((resolve, reject) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/jpeg,image/png,image/webp,image/gif';
      input.style.display = 'none';
      document.body.appendChild(input);
      let settled = false;
      const finish = (fn, val) => {
        if (settled) return;
        settled = true;
        window.setTimeout(() => {
          try {
            input.remove();
          } catch {
            /* */
          }
        }, 0);
        fn(val);
      };
      input.addEventListener('change', () => {
        const file = input.files && input.files[0];
        if (!file) finish(reject, new Error('cancelled'));
        else finish(resolve, file);
      });
      input.addEventListener('cancel', () => finish(reject, new Error('cancelled')));
      input.click();
    });
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const s = String(reader.result || '');
        const i = s.indexOf(',');
        resolve(i >= 0 ? s.slice(i + 1) : s);
      };
      reader.onerror = () => reject(new Error('Could not read image'));
      reader.readAsDataURL(blob);
    });
  }

  async function resizeImageForUpload(file, maxWidth = 1600) {
    const type = String(file.type || '').toLowerCase();
    if (!/^image\/(jpeg|jpg|png|webp|gif)$/.test(type)) {
      throw new Error('Please choose a JPEG, PNG, WebP, or GIF image');
    }
    let bitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      throw new Error('Could not read that image');
    }
    let w = bitmap.width;
    let h = bitmap.height;
    if (!w || !h) {
      try {
        bitmap.close();
      } catch {
        /* */
      }
      throw new Error('Could not read that image');
    }
    if (w > maxWidth) {
      h = Math.max(1, Math.round(h * (maxWidth / w)));
      w = maxWidth;
    }
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      try {
        bitmap.close();
      } catch {
        /* */
      }
      throw new Error('Could not resize image');
    }
    ctx.drawImage(bitmap, 0, 0, w, h);
    try {
      bitmap.close();
    } catch {
      /* */
    }

    const preferJpeg = type !== 'image/png' || w * h > 800 * 800;
    const mime = preferJpeg ? 'image/jpeg' : 'image/png';
    const quality = preferJpeg ? 0.85 : undefined;
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not compress image'))), mime, quality);
    });
    // Keep under portal JSON limit after base64 (~33% overhead).
    if (blob.size > 4.5 * 1024 * 1024) {
      const tighter = await new Promise((resolve, reject) => {
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error('Image is still too large after resize'))),
          'image/jpeg',
          0.72
        );
      });
      const data = await blobToBase64(tighter);
      return { data, mimeType: 'image/jpeg', width: w, height: h, bytes: tighter.size };
    }
    const data = await blobToBase64(blob);
    return { data, mimeType: mime, width: w, height: h, bytes: blob.size };
  }

  async function handleImageReplace(replaceSrc) {
    if (!state.siteEditable || !state.editMode || state.imageUploading) return;
    const src = String(replaceSrc || '').trim();
    if (!src || /^data:/i.test(src) || /^blob:/i.test(src)) return;

    const msg = document.getElementById('msg-edit');
    let file;
    try {
      file = await pickImageFile();
    } catch {
      return;
    }

    const keepMode = state.editMode;
    const keepFs = state.editFullscreen;
    state.imageUploading = true;
    updateEditBar();
    postImageBusyToFrame(src, true);
    if (msg) {
      msg.className = 'msg';
      msg.textContent = 'Resizing and uploading image…';
    }

    try {
      const prepared = await resizeImageForUpload(file, 1600);
      const result = await api('/site/image', {
        method: 'POST',
        body: JSON.stringify({
          replaceSrc: src,
          data: prepared.data,
          mimeType: prepared.mimeType,
        }),
      });
      if (result && result.previewUrl) state.previewUrl = result.previewUrl;
      if (msg) {
        msg.className = 'msg ok';
        msg.textContent = 'Image updated on your live preview.';
      }
      await loadEditablePreview(state.previewUrl);
      if (keepMode && state.siteEditable) setEditMode(true, { fullscreen: keepFs });
      else if (keepFs && state.siteEditable) setEditFullscreen(true);
    } catch (e) {
      if (msg) {
        msg.className = 'msg err';
        msg.textContent = errText(e);
      }
      postImageBusyToFrame(src, false);
    } finally {
      state.imageUploading = false;
      updateEditBar();
    }
  }

  async function refreshCreditHints() {
    try {
      const b = await api('/billing');
      const credits = (b && b.credits) || {};
      if (credits.balance != null) state.creditsBalance = Number(credits.balance) || 0;
      if (credits.perSocialImage != null) state.imageCredits = Math.max(0, Number(credits.perSocialImage) || 0);
      state.creditsConfigured = !!credits.priceConfigured;
      state.entitlements = (b && b.entitlements) || state.entitlements || {};
      state.plan = (b && b.plan) || state.plan || 'free';
      if (state.plan !== 'free') hideUpsellTip();
      state.socialImagesIncluded = !!(state.entitlements && state.entitlements.socialImagesIncluded);
    } catch {
      /* keep last known */
    }
  }

  function aiImageCostLabel() {
    if (state.socialImagesIncluded) return 'Included in Premium — no credit charge.';
    const n = Math.max(0, Number(state.imageCredits) || 0);
    return `Costs ${n} credit${n === 1 ? '' : 's'} (balance: ${state.creditsBalance}). Buy packs in Billing if needed.`;
  }

  function closeAiImageModal() {
    const modal = document.getElementById('ai-image-modal');
    if (modal) modal.hidden = true;
    state.aiImageSrc = null;
    const ta = document.getElementById('ai-image-prompt');
    if (ta) ta.value = '';
    const msg = document.getElementById('msg-ai-image');
    if (msg) {
      msg.className = 'msg';
      msg.textContent = '';
    }
  }

  async function openAiImageModal(replaceSrc) {
    if (!state.siteEditable || !state.editMode || state.imageUploading) return;
    const src = String(replaceSrc || '').trim();
    if (!src || /^data:/i.test(src) || /^blob:/i.test(src)) return;
    state.aiImageSrc = src;
    await refreshCreditHints();
    const hint = document.getElementById('ai-image-credit-hint');
    if (hint) hint.textContent = aiImageCostLabel();
    const msg = document.getElementById('msg-ai-image');
    if (msg) {
      msg.className = 'msg';
      msg.textContent = '';
    }
    const ta = document.getElementById('ai-image-prompt');
    if (ta) ta.value = '';
    const modal = document.getElementById('ai-image-modal');
    if (modal) modal.hidden = false;
    if (ta) setTimeout(() => ta.focus(), 0);
  }

  async function submitAiImageGenerate() {
    const src = String(state.aiImageSrc || '').trim();
    const ta = document.getElementById('ai-image-prompt');
    const prompt = ta ? String(ta.value || '').trim() : '';
    const modalMsg = document.getElementById('msg-ai-image');
    const msg = document.getElementById('msg-edit');
    const genBtn = document.getElementById('btn-ai-image-generate');
    if (!src) {
      closeAiImageModal();
      return;
    }
    if (!prompt) {
      if (modalMsg) {
        modalMsg.className = 'msg err';
        modalMsg.textContent = 'Enter a description for the image.';
      }
      return;
    }
    if (state.imageUploading) return;

    const keepMode = state.editMode;
    const keepFs = state.editFullscreen;
    state.imageUploading = true;
    updateEditBar();
    if (genBtn) genBtn.disabled = true;
    if (modalMsg) {
      modalMsg.className = 'msg';
      modalMsg.textContent = 'Generating image… this can take a minute.';
    }
    postImageBusyToFrame(src, true);

    try {
      const result = await api('/site/image-generate', {
        method: 'POST',
        body: JSON.stringify({ replaceSrc: src, prompt }),
      });
      if (result && result.previewUrl) state.previewUrl = result.previewUrl;
      if (result && result.credits_balance != null) state.creditsBalance = Number(result.credits_balance);
      if (result && result.social_images_included != null) {
        state.socialImagesIncluded = !!result.social_images_included;
      }
      const charged = Number(result && result.credits_charged) || 0;
      closeAiImageModal();
      if (msg) {
        msg.className = 'msg ok';
        msg.textContent =
          charged > 0
            ? `Image generated. Used ${charged} credit${charged === 1 ? '' : 's'} (${state.creditsBalance} left).`
            : 'Image generated and updated on your live preview.';
      }
      await loadEditablePreview(state.previewUrl);
      if (keepMode && state.siteEditable) setEditMode(true, { fullscreen: keepFs });
      else if (keepFs && state.siteEditable) setEditFullscreen(true);
    } catch (e) {
      const insufficient = e && (e.code === 'INSUFFICIENT_CREDITS' || /not enough credits/i.test(e.message || ''));
      if (modalMsg) {
        modalMsg.className = 'msg err';
        modalMsg.textContent = errText(e);
      }
      if (msg && insufficient) {
        msg.className = 'msg err';
        msg.textContent = errText(e);
      }
      postImageBusyToFrame(src, false);
    } finally {
      state.imageUploading = false;
      updateEditBar();
      if (genBtn) genBtn.disabled = false;
    }
  }

  async function handleListMutate(data) {
    const msg = document.getElementById('msg-edit');
    const keepMode = state.editMode;
    const keepFs = state.editFullscreen;
    const action = String(data.action || '');
    const scrollPos = getPreviewScroll();
    if (msg) {
      msg.className = 'msg';
      msg.textContent =
        action === 'freeform-save' ? 'Saving…' : action === 'delete' ? 'Updating list…' : 'Adding item…';
    }
    try {
      // Flush pending text edits first so we don't lose them on reload
      if (state.pendingEdits.size) {
        const edits = [...state.pendingEdits.entries()].map(([id, text]) => ({ id, text }));
        await api('/site/edits', { method: 'POST', body: JSON.stringify({ edits }) });
        clearPendingEdits();
      }
      const body =
        action === 'freeform-save'
          ? {
              action: 'freeform-save',
              pageIndex: data.pageIndex,
              sectionIndex: data.sectionIndex,
              html: data.html,
              embedRemove: data.embedRemove || null,
              embedRestore: data.embedRestore || null,
            }
          : {
              action: action === 'delete' ? 'delete' : 'add',
              pageIndex: data.pageIndex,
              sectionIndex: data.sectionIndex,
              listKey: data.listKey || 'items',
              index: data.index,
            };
      const out = await api('/site/list-item', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      if (out && out.previewUrl) state.previewUrl = out.previewUrl;
      if (msg) {
        msg.className = 'msg ok';
        msg.textContent = action === 'delete' ? 'Item removed.' : 'Item added.';
      }
      // Freeform already mutated the live DOM — skip iframe reload (no jump).
      if (action === 'freeform-save') {
        restorePreviewScroll(scrollPos);
        setTimeout(() => {
          if (msg && (msg.textContent === 'Item removed.' || msg.textContent === 'Item added.')) {
            msg.className = 'msg';
            msg.textContent = '';
          }
        }, 2500);
        return;
      }
      await loadEditablePreview(state.previewUrl, {
        preserveEditMode: keepMode,
        preserveFullscreen: keepFs,
        restoreScroll: scrollPos,
      });
      setTimeout(() => {
        if (msg && (msg.textContent === 'Item removed.' || msg.textContent === 'Item added.')) {
          msg.className = 'msg';
          msg.textContent = '';
        }
      }, 3000);
    } catch (e) {
      if (msg) {
        msg.className = 'msg err';
        msg.textContent = errText(e);
      }
      // Freeform DOM already changed — reload to resync if save failed
      if (action === 'freeform-save') {
        try {
          await loadEditablePreview(state.previewUrl, {
            preserveEditMode: keepMode,
            preserveFullscreen: keepFs,
            restoreScroll: scrollPos,
          });
        } catch {
          /* */
        }
      }
    }
  }

  window.addEventListener('message', (ev) => {
    const frame = state.previewFrame;
    if (!frame || ev.source !== frame.contentWindow || ev.origin !== 'null') return;
    const data = ev.data;
    if (!data || typeof data !== 'object') return;
    if (data.source === 'ws-preview-nav') {
      handlePreviewNavMessage(data);
      return;
    }
    if (data.source !== 'ws-preview') return;
    if (!state.siteEditable) return;
    if (data.type === 'scroll-position') {
      if (
        Number.isFinite(data.x) &&
        Number.isFinite(data.y) &&
        data.x >= 0 &&
        data.y >= 0 &&
        data.x <= 10000000 &&
        data.y <= 10000000
      )
        state.previewScroll = { x: data.x, y: data.y };
      return;
    }
    if (data.type === 'chat-patch-result') {
      handleAgentPatchResult(data);
      return;
    }
    const allowedTypes = [
      'ready',
      'list-error',
      'undo-state',
      'list-mutate',
      'pick-block',
      'image-replace',
      'image-ai-generate',
      'element-select',
      'element-font',
    ];
    if (data.type != null && !allowedTypes.includes(data.type)) return;
    if (data.type === 'ready') {
      if (state.editMode) postEditModeToFrame(true);
      return;
    }
    if (data.type === 'list-error') {
      const msg = document.getElementById('msg-edit');
      if (msg) {
        msg.className = 'msg err';
        msg.textContent = data.message || 'Could not change list';
      }
      return;
    }
    if (data.type === 'undo-state') {
      state.canUndo = !!data.canUndo;
      updateEditBar();
      return;
    }
    if (data.type === 'list-mutate') {
      if (!state.editMode) return;
      if (!['add', 'delete', 'freeform-save'].includes(data.action)) return;
      if (data.html != null && (typeof data.html !== 'string' || data.html.length > 800000)) return;
      handleListMutate(data);
      return;
    }
    if (data.type === 'pick-block') {
      if (!state.editMode) return;
      const mode = String(data.mode || '').toLowerCase();
      if (mode !== 'design-module' && mode !== 'widget') return;
      openStructureModuleModal(-1, {
        mode,
        targetId: data.targetId || '',
        pageIndex: data.pageIndex,
      });
      return;
    }
    if (data.type === 'image-replace') {
      if (!state.editMode) return;
      handleImageReplace(data.src || data.absSrc || '');
      return;
    }
    if (data.type === 'image-ai-generate') {
      if (!state.editMode) return;
      openAiImageModal(data.src || data.absSrc || '');
      return;
    }
    if (data.type === 'element-select') {
      state.selectedEditId = String(data.id || '');
      const sel = document.getElementById('edit-font-element');
      if (sel && window.WsFonts) {
        if (!sel.options.length) window.WsFonts.fillSelect(sel, '', { defaultLabel: 'Site default' });
        sel.disabled = !state.selectedEditId || !state.editMode;
        sel.value = window.WsFonts.matchName(data.fontFamily || '') || '';
      }
      return;
    }
    if (data.type === 'element-font') {
      if (!state.editMode) return;
      handleElementFont(data).catch((e) => {
        const msg = document.getElementById('msg-edit');
        if (msg) {
          msg.className = 'msg err';
          msg.textContent = errText(e);
        }
      });
      return;
    }
    const id = String(data.id || '');
    if (!id || !state.editMode) return;
    if (typeof data.text !== 'string' || data.text.length > 50000 || id.length > 500) return;
    const text = String(data.text || '')
      .replace(/\s+/g, ' ')
      .trim();
    // Freeform HTML text nodes:
    //   html:pageIndex:nodeIndex (legacy page.html)
    //   html:pageIndex:sectionIndex:nodeIndex (modular section content.html)
    if (/^html:\d+:\d+(?::\d+)?$/.test(id)) {
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
    return (
      esc(
        String(iso || '')
          .replace('T', ' ')
          .slice(0, 16)
          // Batch 107: non-breaking separators (see fmtMcpDate).
          .replace(/-/g, '\u2011')
          .replace(/ /g, '\u00A0')
      ) + ' UTC'
    );
  }

  function money(n) {
    const v = Number(n);
    // Batch 143: a non-finite amount rendered as a literal '$1.00'
    // — a fabricated price. Unknown amounts show a dash instead.
    if (!Number.isFinite(v)) return '—';
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
    const showGenAd = !!state.socialImagesIncluded;
    const socialReady = !!state.metaConfigured && state.socialAccountsCount > 0;
    const gateReason = !state.metaConfigured
      ? 'Social publishing is not set up yet — contact Bitpype to connect your Facebook / Instagram accounts.'
      : 'Connect a Facebook / Instagram account above to approve & schedule posts.';
    const nowMs = Date.now();

    list.innerHTML = slice
      .map((p) => {
        const img = absoluteUrl(p.image_url);
        const platforms = (p.platforms || []).map((x) => esc(x)).join(', ');
        const media = img
          ? `<div class="post-media"><img src="${esc(img)}" alt="Post image" loading="lazy" /></div>`
          : `<div class="post-media">No image yet</div>`;
        const overdue =
          String(p.status || '') === 'draft' &&
          p.scheduled_at &&
          new Date(p.scheduled_at).getTime() < nowMs;
        return `
        <article class="post-card" data-post-id="${esc(p.id)}">
          ${media}
          <div class="post-body">
            <div class="post-meta">
              <span>${formatWhen(p.scheduled_at)}</span>
              <span class="platforms">${platforms || 'facebook, instagram'}</span>
              <span class="status-pill">${esc(p.status || 'draft')}</span>
              ${overdue ? '<span class="status-pill warn">Overdue</span>' : ''}
            </div>
            <div class="post-cap-block">
              <textarea class="post-cap-edit" data-caption-for="${esc(p.id)}" rows="3" aria-label="Post caption">${esc(p.caption || '')}</textarea>
              <button type="button" class="btn ghost small" data-act="save-caption" data-id="${esc(p.id)}">Save caption</button>
            </div>
            <div class="post-actions">
              ${
                showGenAd
                  ? `<button type="button" class="btn soft small" data-act="gen-image" data-id="${esc(p.id)}">Generate AD</button>`
                  : ''
              }
              ${
                ['draft', 'pending_approval', 'approved', 'rejected'].includes(String(p.status || ''))
                  ? socialReady
                    ? `<button type="button" class="btn soft small" data-act="approve" data-id="${esc(p.id)}">Approve &amp; schedule</button>`
                    : `<button type="button" class="btn soft small" disabled title="${esc(gateReason)}">Approve &amp; schedule</button>`
                  : ''
              }
              ${socialReady ? '' : `<span class="hint">${esc(gateReason)}</span>`}
              <label class="hint" style="display:inline-flex;align-items:center;gap:6px">
                When
                <input type="datetime-local" data-act="sched" data-id="${esc(p.id)}"
                  value="${esc(String(p.scheduled_at || '').slice(0, 16))}"
                  style="font:inherit;padding:6px 10px;border:1.5px solid rgba(28,20,15,.16);border-radius:14px;background:var(--paper);color:var(--ink)" />
              </label>
              <button type="button" class="btn ghost small" data-act="share-native" data-id="${esc(p.id)}"${socialReady ? '' : ` disabled title="${esc(gateReason)}"`}>Share</button>
              <button type="button" class="btn ghost small" data-act="share-fb" data-id="${esc(p.id)}">Facebook</button>
              <button type="button" class="btn ghost small" data-act="share-ig" data-id="${esc(p.id)}">Instagram</button>
              <button type="button" class="btn ghost small" data-act="copy" data-id="${esc(p.id)}">Copy caption</button>
            </div>
          </div>
        </article>`;
      })
      .join('');

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

  async function saveCaption(postId) {
    const msg = document.getElementById('msg-social');
    const ta = document.querySelector(`textarea[data-caption-for="${postId}"]`);
    const btn = document.querySelector(`[data-act="save-caption"][data-id="${postId}"]`);
    if (!ta) return;
    const caption = String(ta.value || '');
    msg.className = 'msg';
    msg.textContent = 'Saving caption…';
    if (btn) btn.disabled = true;
    try {
      const data = await api(`/social/posts/${postId}`, {
        method: 'PATCH',
        body: JSON.stringify({ caption }),
      });
      const idx = state.posts.findIndex((p) => Number(p.id) === Number(postId));
      if (idx >= 0) {
        state.posts[idx] = Object.assign({}, state.posts[idx], data && data.post ? data.post : { caption });
      }
      msg.className = 'msg ok';
      msg.textContent = 'Caption saved.';
    } catch (e) {
      msg.className = 'msg err';
      msg.textContent = errText(e);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function generateBrandedImage(postId) {
    if (!state.socialImagesIncluded) return;
    const msg = document.getElementById('msg-social');
    const btn = document.querySelector(`[data-act="gen-image"][data-id="${postId}"]`);
    msg.className = 'msg';
    msg.textContent = 'Generating AD…';
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
      if (data.credits_balance != null) state.creditsBalance = Number(data.credits_balance);
      renderPostPage();
      msg.className = 'msg ok';
      const charged = Number(data.credits_charged || 0);
      msg.textContent =
        data.included_in_plan || charged === 0
          ? 'Branded image ready — included in your plan.'
          : `Branded image ready. Used ${charged} credit${charged === 1 ? '' : 's'} (${state.creditsBalance} left).`;
    } catch (e) {
      msg.className = 'msg err';
      msg.textContent = errText(e);
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
    if (cal.image_credits != null) state.imageCredits = Math.max(0, Number(cal.image_credits) || 0);
    if (cal.content_credits != null) state.contentCredits = Math.max(0, Number(cal.content_credits) || 0);
    if (cal.credits_balance != null) state.creditsBalance = Math.max(0, Number(cal.credits_balance) || 0);
    if (cal.credits_pack_label) state.creditsPackLabel = String(cal.credits_pack_label);
    state.creditsConfigured = !!cal.credits_configured;
    state.socialImagesIncluded = !!cal.social_images_included;
    const label = new Date(Date.UTC(cal.year, cal.month - 1, 1)).toLocaleString(undefined, {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    });
    document.getElementById('cal-label').textContent = label;
    document.getElementById('cal-lede').textContent = `${label} · ${state.posts.length} post(s)`;

    const priceHint = document.getElementById('image-price-hint');
    priceHint.hidden = false;
    if (state.socialImagesIncluded) {
      priceHint.textContent = `Branded social images are included in your plan — no credit charge for images. Writing post content uses credits · Balance: ${state.creditsBalance} credits.`;
    } else {
      priceHint.textContent = `Balance: ${state.creditsBalance} credits · Images ${state.imageCredits}/ea · Content ${state.contentCredits}/generation. Buy packs in Billing.`;
    }

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
      .map((h) => `<div class="cal-head">${h}</div>`)
      .join('');
    let cells = '';
    for (let i = 0; i < startPad; i += 1) cells += '<div class="cal-cell muted"></div>';
    for (let d = 1; d <= total; d += 1) {
      const posts = byDay.get(d) || [];
      const dots = posts
        .slice(0, 2)
        .map((p) => `<span class="dot" title="${esc(p.status)}">${esc((p.caption || '').slice(0, 28))}</span>`)
        .join('');
      const more = posts.length > 2 ? `<span class="dot">+${posts.length - 2}</span>` : '';
      cells += `<div class="cal-cell"><div class="d">${d}</div>${dots}${more}</div>`;
    }
    document.getElementById('cal-grid').innerHTML = heads + cells;
    renderPostPage();
  }

  async function loadCalendar() {
    try {
      const now = new Date();
      const data = await api(`/calendar?year=${now.getUTCFullYear()}&month=${now.getUTCMonth() + 1}`);
      renderCalendar(data);
    } catch (e) {
      const lede = document.getElementById('cal-lede');
      if (lede) lede.textContent = 'Your social calendar could not be loaded.';
      const list = document.getElementById('post-list');
      if (list) {
        list.innerHTML =
          '<p class="hint">Something went wrong loading your posts. ' +
          '<button type="button" class="btn ghost small" id="cal-retry">Retry</button></p>';
        const retry = document.getElementById('cal-retry');
        if (retry) retry.onclick = () => loadCalendar().catch(() => {});
      }
      const msg = document.getElementById('msg-social');
      if (msg) {
        msg.className = 'msg err';
        msg.textContent = errText(e);
      }
    }
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
    } catch {
      /* ignore */
    }
  }

  function renderPlanCards(b) {
    const grid = document.getElementById('bill-plan-grid');
    if (!grid) return;
    const currentPlan = String(b.plan || 'free');
    const canSelfServe = !!(b.canSelfServe != null ? b.canSelfServe : b.canManage);
    const selfSubscribed = !!(
      b.hasActiveSubscription ||
      (currentPlan !== 'free' && ['active', 'trialing', 'past_due'].includes(String(b.subscriptionStatus || '')))
    );
    const cancelAtPeriodEnd = !!b.cancelAtPeriodEnd;
    const plans =
      Array.isArray(b.plans) && b.plans.length
        ? b.plans
        : [
            {
              id: 'free',
              name: 'Free',
              priceLabel: 'Free',
              tagline: 'Launch a site and edit it yourself.',
              features: [],
              checkout: false,
              priceConfigured: true,
            },
            {
              id: 'standard',
              name: 'Standard',
              priceLabel: 'Monthly',
              tagline: 'Monthly support with credit-based social ads.',
              features: [],
              checkout: true,
              priceConfigured: false,
            },
            {
              id: 'pro',
              name: 'Pro',
              priceLabel: 'Monthly',
              tagline: 'Monthly support with social images included.',
              features: [],
              checkout: true,
              priceConfigured: false,
            },
            {
              id: 'premium',
              name: 'Premium',
              priceLabel: 'Monthly',
              tagline: 'All features included, plus a monthly support call.',
              features: [],
              checkout: true,
              priceConfigured: false,
            },
          ];

    grid.innerHTML = plans
      .map((p) => {
        const isCurrent = p.id === currentPlan;
        let cta = '';
        if (!canSelfServe) {
          cta = isCurrent
            ? '<span class="hint">Current plan</span>'
            : '<span class="hint">Contact Bitpype to change plans</span>';
        } else if (p.id === 'free') {
          if (isCurrent && !selfSubscribed) {
            cta = '<span class="hint">Current plan</span>';
          } else if (cancelAtPeriodEnd && selfSubscribed) {
            cta =
              '<span class="hint">Cancels at period end</span>' +
              '<button class="btn ghost" type="button" data-resume-plan="1">Keep my plan</button>';
          } else if (selfSubscribed) {
            cta =
              '<button class="btn ghost" type="button" data-change-plan="free">Downgrade to Free</button>' +
              '<span class="hint">Keeps access until the period ends</span>';
          } else {
            cta = '<span class="hint">Current plan</span>';
          }
        } else if (isCurrent && selfSubscribed) {
          cta = cancelAtPeriodEnd
            ? '<span class="hint">Current — canceling at period end</span>' +
              '<button class="btn" type="button" data-resume-plan="1">Keep this plan</button>'
            : '<span class="hint">Current plan</span>';
        } else if (!p.priceConfigured) {
          cta = '<span class="hint">Price not configured yet</span>';
        } else if (!selfSubscribed) {
          cta = `<button class="btn" type="button" data-change-plan="${esc(p.id)}">Subscribe</button>`;
        } else if (p.id === 'premium' && currentPlan === 'standard') {
          cta = `<button class="btn" type="button" data-change-plan="premium">Upgrade to Premium</button>`;
        } else if (p.id === 'standard' && currentPlan === 'premium') {
          cta = `<button class="btn ghost" type="button" data-change-plan="standard">Switch to Standard</button>`;
        } else {
          cta = `<button class="btn" type="button" data-change-plan="${esc(p.id)}">Switch to ${esc(p.name)}</button>`;
        }
        const featuredNote =
          p.id === 'premium' || p.id === 'pro'
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
      })
      .join('');

    grid.querySelectorAll('[data-change-plan]').forEach((btn) => {
      btn.onclick = () => startPortalChangePlan(btn.getAttribute('data-change-plan'));
    });
    grid.querySelectorAll('[data-resume-plan]').forEach((btn) => {
      btn.onclick = () => startPortalResume();
    });
  }

  function refStatusLabel(status) {
    const s = String(status || 'pending');
    if (s === 'credited') return 'Credited';
    if (s === 'signed_up') return 'Signed up';
    return 'Pending';
  }

  function renderReferrals(data) {
    const totals = (data && data.totals) || {};
    const math = (data && data.creditMath) || {};
    const earnedEl = document.getElementById('ref-earned');
    const potEl = document.getElementById('ref-potential');
    const noteEl = document.getElementById('ref-math-note');
    if (earnedEl) earnedEl.textContent = String(totals.earnedCredits != null ? totals.earnedCredits : 0);
    if (potEl) potEl.textContent = String(totals.estimatedPendingCredits != null ? totals.estimatedPendingCredits : 0);
    if (noteEl) noteEl.textContent = math.note || 'Earn ~10% of a referred client’s paid plan value as social credits.';

    const list = document.getElementById('ref-list');
    if (!list) return;
    const rows = (data && data.referrals) || [];
    if (!rows.length) {
      list.innerHTML = '<p class="hint" style="margin:0">No referrals yet — submit one above.</p>';
      return;
    }
    list.innerHTML = `<div style="overflow-x:auto"><table class="ref-table" style="width:100%;border-collapse:collapse;font-size:0.92rem">
      <thead><tr>
        <th style="text-align:left;padding:8px 6px;border-bottom:1px solid rgba(0,0,0,.08)">Contact</th>
        <th style="text-align:left;padding:8px 6px;border-bottom:1px solid rgba(0,0,0,.08)">Status</th>
        <th style="text-align:right;padding:8px 6px;border-bottom:1px solid rgba(0,0,0,.08)">Credits</th>
      </tr></thead>
      <tbody>${rows
        .map((r) => {
          const title = esc(r.businessName || r.name || r.email || 'Referral');
          const sub = [r.name && r.businessName ? r.name : '', r.email || '', r.phone || '']
            .filter(Boolean)
            .map(esc)
            .join(' · ');
          const credits =
            r.status === 'credited'
              ? String(r.creditsAwarded || 0)
              : `~${math.standardEstimateCredits != null ? math.standardEstimateCredits : '—'}`;
          return `<tr>
          <td style="padding:10px 6px;vertical-align:top;border-bottom:1px solid rgba(0,0,0,.06)">
            <strong>${title}</strong>${sub ? `<div class="hint" style="margin:4px 0 0">${sub}</div>` : ''}
          </td>
          <td style="padding:10px 6px;vertical-align:top;border-bottom:1px solid rgba(0,0,0,.06)">
            <span class="status-pill${r.status === 'credited' ? '' : r.status === 'signed_up' ? ' warn' : ''}">${esc(refStatusLabel(r.status))}</span>
          </td>
          <td style="padding:10px 6px;vertical-align:top;text-align:right;border-bottom:1px solid rgba(0,0,0,.06)">${esc(credits)}</td>
        </tr>`;
        })
        .join('')}</tbody></table></div>`;
  }

  async function loadReferrals() {
    const data = await api('/referrals');
    renderReferrals(data);
    return data;
  }

  async function submitReferral() {
    const msg = document.getElementById('msg-referrals');
    const btn = document.getElementById('btn-ref-submit');
    if (msg) {
      msg.textContent = '';
      msg.className = 'msg';
    }
    if (btn) btn.disabled = true;
    try {
      const data = await api('/referrals', {
        method: 'POST',
        body: JSON.stringify({
          name: (document.getElementById('ref-name') || {}).value || '',
          email: (document.getElementById('ref-email') || {}).value || '',
          phone: (document.getElementById('ref-phone') || {}).value || '',
          businessName: (document.getElementById('ref-business') || {}).value || '',
        }),
      });
      ['ref-name', 'ref-email', 'ref-phone', 'ref-business'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.value = '';
      });
      renderReferrals(data);
      if (msg) {
        msg.textContent = 'Referral submitted.';
        msg.className = 'msg ok';
      }
    } catch (e) {
      if (msg) {
        msg.textContent = errText(e);
        msg.className = 'msg err';
      }
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  const btnRefSubmit = document.getElementById('btn-ref-submit');
  if (btnRefSubmit)
    btnRefSubmit.onclick = () => {
      submitReferral().catch(() => {});
    };

  let analyticsEpoch = 0;
  function analyticsRows(id, rows) {
    const table = document.getElementById(id);
    table.replaceChildren();
    for (const values of rows.length ? rows : [['No activity yet', '—']]) {
      const tr = document.createElement('tr');
      for (const value of values) {
        const td = document.createElement('td');
        td.textContent = String(value);
        tr.append(td);
      }
      table.append(tr);
    }
  }
  let seoEpoch = 0;
  let rentalsEpoch = 0;
  // ── Google Business Profile (Batch 46, Phase 1) ──────────────────
  // The owner's own profile panel. Drafts + validation work today;
  // pushing is held at "ready" until Google approves the Business
  // Profile API application — the server says so plainly, and this
  // panel shows that message instead of a fake success.
  let gbpEpoch = 0;

  async function loadGbpPanel() {
    const epoch = ++gbpEpoch;
    const host = document.getElementById('gbp-host');
    if (!host) return;
    host.innerHTML = '<p class="hint">Loading your Google Profile…</p>';
    let data;
    try {
      data = await api('/gbp');
    } catch (e) {
      if (epoch !== gbpEpoch) return;
      host.innerHTML = `<p class="hint">${esc(errText(e))}</p>`;
      return;
    }
    if (epoch !== gbpEpoch) return;
    renderGbpPanel(data);
  }

  const GBP_PORTAL_DAYS = [
    ['sunday', 'Sunday'],
    ['monday', 'Monday'],
    ['tuesday', 'Tuesday'],
    ['wednesday', 'Wednesday'],
    ['thursday', 'Thursday'],
    ['friday', 'Friday'],
    ['saturday', 'Saturday'],
  ];

  function gbpBadge(status) {
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

  function gbpCollectPortalState(form) {
    const v = (name) => {
      const el = form.querySelector(`[data-gbp="${name}"]`);
      return el ? el.value.trim() : '';
    };
    const hours = {};
    form.querySelectorAll('[data-gbp-day]').forEach((row) => {
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
      additional_categories: v('additional_categories').split(',').map((s) => s.trim()).filter(Boolean),
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
      service_areas: v('service_areas').split(',').map((s) => s.trim()).filter(Boolean),
      hours,
      attributes: {},
      photos: [],
    };
  }

  function renderGbpPanel(d) {
    const host = document.getElementById('gbp-host');
    if (!host) return;
    const data = d || {};
    const cfg = data.config || {};
    const conn = data.connection || {};
    const pre = data.prefill || { fields: {} };
    const st = pre.proposedState || {};
    const addr = st.address || {};
    const hours = st.hours || {};
    const fieldRows = Object.values(pre.fields || {})
      .map(
        (f) => `<tr>
          <td>${esc(f.label)}</td>
          <td>${esc(f.googleText || '—')}</td>
          <td>${esc(f.proposedText || '—')}</td>
          <td>${f.conflict ? '<span class="badge warn">differs — Google\u2019s value kept</span>' : ''}</td>
        </tr>`
      )
      .join('');
    const csRows = ((data.changeSets && data.changeSets.rows) || [])
      .map((cs) => {
        const diff = (cs.changes || [])
          .map(
            (c) =>
              `<div class="kv"><span class="k">${esc(c.label)}</span><span>${esc(c.beforeText || '—')} → <strong>${esc(c.afterText || '—')}</strong></span></div>`
          )
          .join('');
        const errs =
          cs.validation && !cs.validation.ok
            ? `<p class="hint" style="color:var(--coral)">${(cs.validation.errors || []).map((x) => esc(x.message)).join('<br/>')}</p>`
            : '';
        return `<div class="panel" style="margin-top:var(--card-gap)">
          <p><strong>Draft #${cs.id}</strong> ${gbpBadge(cs.status)} <span class="hint">${(cs.changes || []).length} change(s)</span></p>
          <p style="display:flex;gap:8px;flex-wrap:wrap">
            <button type="button" class="btn soft" data-gbp-act="diff" data-id="${cs.id}">Review changes</button>
            <button type="button" class="btn soft" data-gbp-act="validate" data-id="${cs.id}">Validate</button>
            <button type="button" class="btn" data-gbp-act="push" data-id="${cs.id}">Push to Google</button>
          </p>
          <div data-gbp-diff="${cs.id}" hidden>${diff || '<p class="hint">No field changes.</p>'}</div>
          ${errs}
          <p class="hint" data-gbp-msg="${cs.id}" role="status"></p>
        </div>`;
      })
      .join('');
    host.innerHTML = `
      ${
        cfg.apiPending
          ? `<div class="panel" style="border:1px solid var(--gold);background:var(--paper)">
               <h3>Google API access still pending</h3>
               <p>Everything here works — connect, compare, draft, validate. Pushing changes to Google unlocks the moment Google approves our Business Profile API access. Until then, validated drafts wait safely at "ready" and <strong>nothing is sent</strong>.</p>
             </div>`
          : ''
      }
      <div class="panel">
        <h3>Connection</h3>
        <p>Status: ${gbpBadge(conn.status)}${conn.last_sync_at ? ` · last synced ${esc(String(conn.last_sync_at).slice(0, 10))}` : ''}</p>
        <p style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <input type="text" id="gbp-place-id" value="${esc(conn.place_id || '')}" placeholder="Google Place ID (optional for now)" style="flex:1;min-width:220px" autocomplete="off" spellcheck="false">
          <button type="button" class="btn soft" data-gbp-act="save-place">Save Place ID</button>
          ${
            cfg.oauthReady
              ? '<button type="button" class="btn" data-gbp-act="connect">Connect Google</button>'
              : `<button type="button" class="btn" disabled>Connect Google</button>`
          }
          ${conn.status === 'connected' || conn.status === 'invited' ? '<button type="button" class="btn soft" data-gbp-act="disconnect">Disconnect</button>' : ''}
        </p>
        ${cfg.oauthReady ? '' : `<p class="hint">${esc(cfg.oauthNotConfiguredMessage || 'Google sign-in is not configured yet.')}</p>`}
        <p class="hint" data-gbp-msg="conn" role="status"></p>
      </div>
      <div class="panel">
        <h3>What Google shows vs what we have</h3>
        ${pre.websiteNote ? `<p class="hint">${esc(pre.websiteNote)}</p>` : ''}
        <table><thead><tr><th scope="col">Field</th><th scope="col">Google now</th><th scope="col">Proposed</th><th scope="col"></th></tr></thead>
        <tbody>${fieldRows}</tbody></table>
      </div>
      <div class="panel">
        <h3>Edit your profile draft</h3>
        <form id="gbp-form">
          <p><label>Business name<br><input type="text" data-gbp="name" value="${esc(st.name || '')}" style="width:100%"></label></p>
          <p><label>Primary category<br><input type="text" data-gbp="primary_category" value="${esc(st.primary_category || '')}" style="width:100%"></label></p>
          <p><label>Additional categories (comma-separated)<br><input type="text" data-gbp="additional_categories" value="${esc((st.additional_categories || []).join(', '))}" style="width:100%"></label></p>
          <p><label>Description (750 characters max)<br><textarea data-gbp="description" rows="3" style="width:100%">${esc(st.description || '')}</textarea></label></p>
          <p><label>Primary phone<br><input type="text" data-gbp="phone" value="${esc(st.phone || '')}" style="width:100%"></label></p>
          <p><label>Website<br><input type="text" data-gbp="website" value="${esc(st.website || '')}" style="width:100%"></label></p>
          <p><label>Location type<br><select data-gbp="location_mode">
            <option value="storefront" ${st.location_mode !== 'service_area' ? 'selected' : ''}>Storefront (public address)</option>
            <option value="service_area" ${st.location_mode === 'service_area' ? 'selected' : ''}>Service area (address hidden)</option>
          </select></label></p>
          <p><label>Service areas (comma-separated)<br><input type="text" data-gbp="service_areas" value="${esc((st.service_areas || []).join(', '))}" style="width:100%"></label></p>
          <p><label>Street address<br><input type="text" data-gbp="addr_line1" value="${esc(addr.line1 || '')}" style="width:100%"></label></p>
          <p><label>Address line 2<br><input type="text" data-gbp="addr_line2" value="${esc(addr.line2 || '')}" style="width:100%"></label></p>
          <p style="display:flex;gap:8px;flex-wrap:wrap">
            <label style="flex:1;min-width:140px">City<br><input type="text" data-gbp="addr_city" value="${esc(addr.city || '')}" style="width:100%"></label>
            <label style="flex:1;min-width:120px">State / region<br><input type="text" data-gbp="addr_region" value="${esc(addr.region || '')}" style="width:100%"></label>
            <label style="flex:1;min-width:110px">Postal code<br><input type="text" data-gbp="addr_postal" value="${esc(addr.postal_code || '')}" style="width:100%"></label>
            <label style="flex:0 0 90px">Country<br><input type="text" data-gbp="addr_country" value="${esc(addr.country || 'US')}" style="width:100%"></label>
          </p>
          <details><summary>Opening hours</summary>
            ${GBP_PORTAL_DAYS.map(([key, label]) => {
              const periods = Array.isArray(hours[key]) ? hours[key] : [];
              const f1 = periods[0] || { open: '', close: '' };
              const f2 = periods[1] || { open: '', close: '' };
              return `<p data-gbp-day="${key}" style="display:flex;gap:8px;flex-wrap:wrap;align-items:end">
                <strong style="flex:0 0 100px">${label}</strong>
                <label><input type="checkbox" data-h="closed" ${periods.length === 0 ? 'checked' : ''}> Closed</label>
                <label>Open <input type="text" data-h="open" value="${esc(f1.open || '')}" placeholder="09:00" size="6"></label>
                <label>Close <input type="text" data-h="close" value="${esc(f1.close || '')}" placeholder="17:00" size="6"></label>
                <label>2nd open <input type="text" data-h="open2" value="${esc(f2.open || '')}" size="6"></label>
                <label>2nd close <input type="text" data-h="close2" value="${esc(f2.close || '')}" size="6"></label>
              </p>`;
            }).join('')}
          </details>
          <p style="margin-top:10px"><button type="submit" class="btn">Save draft changes</button></p>
          <p class="hint" data-gbp-msg="form" role="status"></p>
        </form>
      </div>
      <div class="panel">
        <h3>Your change drafts</h3>
        ${csRows || '<p class="hint">No drafts yet. Edit the profile above and save — a draft is always created first, and you review the exact changes before anything can be pushed.</p>'}
      </div>
      ${
        data.reviews
          ? `<div class="panel"><h3>Reviews (sample)</h3><p>${esc(data.reviews.rating != null ? data.reviews.rating + ' ★ · ' : '')}${esc(String(data.reviews.total || 0))} reviews on Google. ${esc(data.reviews.note || '')}</p></div>`
          : ''
      }`;

    const msg = (key, text) => {
      const m = host.querySelector(`[data-gbp-msg="${key}"]`);
      if (m) m.textContent = text;
    };
    host.querySelectorAll('[data-gbp-act]').forEach((b) => {
      b.addEventListener('click', async () => {
        const act = b.getAttribute('data-gbp-act');
        const id = b.getAttribute('data-id');
        try {
          if (act === 'save-place') {
            await api('/gbp/connection', {
              method: 'PUT',
              body: JSON.stringify({ place_id: document.getElementById('gbp-place-id').value }),
            });
            msg('conn', 'Place ID saved.');
            loadGbpPanel();
          } else if (act === 'disconnect') {
            await api('/gbp/connection', { method: 'PUT', body: JSON.stringify({ action: 'disconnect' }) });
            loadGbpPanel();
          } else if (act === 'connect') {
            const r = await api('/gbp/oauth/start');
            if (r.configured && r.url) window.location.assign(r.url);
            else msg('conn', r.message || 'Google sign-in is not configured yet.');
          } else if (act === 'diff') {
            const box = host.querySelector(`[data-gbp-diff="${id}"]`);
            if (box) box.hidden = !box.hidden;
          } else if (act === 'validate') {
            const r = await api(`/gbp/change-sets/${id}/validate`, { method: 'POST', body: '{}' });
            msg(
              id,
              r.validation && r.validation.ok
                ? 'Valid — this draft is ready.'
                : 'Please fix: ' + ((r.validation && r.validation.errors) || []).map((x) => x.message).join(' ')
            );
            if (r.validation && r.validation.ok) loadGbpPanel();
          } else if (act === 'push') {
            const r = await api(`/gbp/change-sets/${id}/push`, { method: 'POST', body: '{}' });
            msg(id, r.ok ? 'Pushed to Google.' : r.message || 'Push did not go through.');
            if (r.ok) loadGbpPanel();
          }
        } catch (e) {
          msg(id || 'conn', errText(e));
        }
      });
    });
    const form = document.getElementById('gbp-form');
    if (form) {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          const state = gbpCollectPortalState(form);
          state.photos = st.photos || [];
          state.attributes = st.attributes || {};
          const r = await api('/gbp/change-sets', { method: 'POST', body: JSON.stringify({ state }) });
          msg('form', `Draft #${r.changeSet.id} saved with ${(r.changeSet.changes || []).length} change(s). Review it below, validate, and it will wait at "ready" until pushing unlocks.`);
          loadGbpPanel();
        } catch (err) {
          msg('form', errText(err));
        }
      });
    }
  }

  async function loadRentals() {
    const epoch = ++rentalsEpoch;
    const host = document.getElementById('rentals-host');
    if (!host) return;
    host.innerHTML = '<p class="hint">Loading your rentals…</p>';
    let st;
    try {
      st = await api('/rentals');
    } catch (e) {
      if (epoch !== rentalsEpoch) return;
      host.innerHTML = `<p class="hint">${esc(errText(e))}</p>`;
      return;
    }
    if (epoch !== rentalsEpoch) return;
    renderRentals(st);
  }

  function renderRentals(st) {
    const host = document.getElementById('rentals-host');
    if (!host) return;
    const list = st && Array.isArray(st.rentals) ? st.rentals : [];
    if (!list.length) {
      host.innerHTML =
        '<div class="panel"><h3>You don\u2019t have a rented site yet</h3><p>When you rent a lead website from us, it shows up here — with every lead it sends you, what each one cost, and anything due. Talk to the BitPype team if you\u2019d like a site in your trade and town.</p></div>';
      return;
    }
    const dollars = (c) => '$' + (Number(c || 0) / 100).toFixed(2);
    const statusText = (r) =>
      r.status === 'trial'
        ? 'Live — free trial leads'
        : r.status === 'active'
          ? 'Live'
          : r.status === 'paused'
            ? 'Paused'
            : 'Ended' + (r.ended_at ? ' ' + String(r.ended_at).slice(0, 10) : '');
    host.innerHTML = list
      .map((r) => {
        const month = r.this_month || {};
        const due = r.counters ? Number(r.counters.amount_due_cents || 0) : 0;
        const history = Array.isArray(r.history) ? r.history : [];
        return `
      <div class="panel">
        <h3>${esc((r.site && r.site.name) || 'Your rented site')}</h3>
        <p><span class="status-pill">${esc(statusText(r))}</span>
        <span class="hint" style="margin-left:8px">${r.model === 'per_lead' ? esc(dollars(r.price_cents)) + ' per lead' : esc(dollars(r.price_cents)) + ' / month flat'}${r.trial_leads ? ` · ${esc(r.trial_used || 0)} of ${esc(r.trial_leads)} free trial leads used` : ''} · since ${esc(String(r.started_at || r.created_at || '').slice(0, 10))}</span></p>
        <p style="display:flex;gap:18px;flex-wrap:wrap;margin:10px 0">
          <span><strong>${esc(month.qualified_leads || 0)}</strong> site leads this month</span>
          <span><strong>${esc(month.credits_charged || 0)}</strong> credits charged this month</span>
          <span>Amount due: <strong>${esc(dollars(due))}</strong></span>
        </p>
        ${due > 0 ? '<p class="hint">Your balance ran out before some leads could be charged, so they are listed as due above. Leads are never held back — top up your credits with the BitPype team and we will settle it.</p>' : ''}
        <h4>Site leads</h4>
        <table><thead><tr><th scope="col">When</th><th scope="col">Type</th><th scope="col">Contact</th><th scope="col">Charge</th></tr></thead><tbody>
        ${history.map((h) => `<tr><td>${esc(String(h.at || '').slice(0, 16).replace(/-/g, '\u2011').replace(/ /g, '\u00A0'))}</td><td>${esc(h.source_label || h.source || '')}</td><td>${esc(h.label || '')}</td><td>${h.charge ? esc(h.charge.status === 'trial' ? 'Free (trial)' : h.charge.status === 'charged' ? h.charge.credits + ' credits' : h.charge.status === 'due' ? dollars(h.charge.amount_due_cents) + ' due' : h.charge.status) : '—'}</td></tr>`).join('') || '<tr><td colspan="4">No leads yet — they will appear here the moment your site sends you one.</td></tr>'}
        </tbody></table>
      </div>`;
      })
      .join('');
  }

  async function loadSeoTool() {
    const epoch = ++seoEpoch;
    const host = document.getElementById('seo-host');
    if (!host) return;
    host.innerHTML = '<p class="hint">Loading your SEO tool…</p>';
    let st;
    try {
      st = await api('/seo');
    } catch (e) {
      if (epoch !== seoEpoch) return;
      host.innerHTML = `<p class="hint">${esc(errText(e))}</p>`;
      return;
    }
    if (epoch !== seoEpoch) return;
    renderSeoTool(st);
  }

  function renderSeoTool(st) {
    const host = document.getElementById('seo-host');
    if (!host) return;
    const d = st || {};
    // Batch 31: Google Search Console verification — the owner pastes
    // the token from Search Console's HTML-tag method; every exported
    // page then carries the verification meta tag.
    const gscPanel = `
      <div class="panel">
        <h3>Google Search Console</h3>
        <p>Verify your site with Google: in Search Console, add your website and choose the <strong>HTML tag</strong> verification method, then paste the token (the <code>content</code> value) here. We put the verification tag on every page of your site at the next publish.</p>
        <p style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <input type="text" id="seo-gsc-token" value="${esc(d.gscToken || '')}" placeholder="Verification token" style="flex:1;min-width:220px" autocomplete="off" spellcheck="false">
          <button type="button" class="btn soft" id="seo-gsc-save">Save token</button>
        </p>
        <p class="hint" id="seo-gsc-message" role="status">${d.gscToken ? 'A verification token is saved for your site.' : 'No token saved yet.'}</p>
      </div>`;
    const wireGsc = () => {
      const btn = document.getElementById('seo-gsc-save');
      const input = document.getElementById('seo-gsc-token');
      const gmsg = document.getElementById('seo-gsc-message');
      if (!btn || !input) return;
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        if (gmsg) gmsg.textContent = 'Saving…';
        try {
          const r = await api('/seo/gsc', { method: 'POST', body: JSON.stringify({ token: input.value }) });
          if (gmsg) {
            gmsg.textContent = r.gscToken
              ? 'Saved — the verification tag lands on your site at the next publish.'
              : 'Token cleared.';
          }
        } catch (e) {
          if (gmsg) gmsg.textContent = errText(e);
        }
        btn.disabled = false;
      });
    };
    if (!d.configured) {
      host.innerHTML =
        '<div class="panel"><h3>SEO is not switched on yet</h3><p>The AI behind this tool is not configured on our side yet, so there is nothing to generate right now. Check back soon — when it is on, you will be able to generate local SEO keywords for your business here and apply them to your site in one click.</p></div>' +
        gscPanel;
      wireGsc();
      return;
    }
    const pending = d.pending || null;
    const proposal = pending && pending.proposal ? pending.proposal : null;
    const kw = proposal && proposal.keywords ? proposal.keywords : null;
    const changes = proposal && Array.isArray(proposal.changes) ? proposal.changes : [];
    const history = Array.isArray(d.history) ? d.history : [];
    const cell = (v) =>
      v ? `<span style="white-space:pre-wrap;word-break:break-word">${esc(v)}</span>` : '<span class="hint">(empty)</span>';
    host.innerHTML = `
      <div class="panel">
        <h3>${proposal ? 'Your proposed SEO changes' : 'Generate your SEO proposal'}</h3>
        ${
          proposal
            ? `<p>We picked the keywords nearby customers actually search for and drafted the changes below. <strong>Nothing is live yet</strong> — review every line, then apply in one click. Changes land on your site right away; they show on the public site at the next publish.</p>
               ${kw && (kw.primary || (kw.supporting || []).length) ? `<p><strong>Primary keyword:</strong> ${esc(kw.primary || '—')}${(kw.supporting || []).length ? `<br><span class="hint">Supporting: ${kw.supporting.map((s) => esc(s)).join(' · ')}</span>` : ''}</p>` : ''}
               <table><thead><tr><th scope="col">Change</th><th scope="col">Current</th><th scope="col">Proposed</th></tr></thead><tbody>
               ${changes.map((c) => `<tr><td>${esc(c.label || c.kind)}</td><td>${cell(c.current)}</td><td>${cell(c.proposed)}</td></tr>`).join('') || '<tr><td colspan="3">The AI proposed no changes — your site already covers these keywords well.</td></tr>'}
               </tbody></table>`
            : '<p>One click and the AI reads your business and your pages, picks your best local keywords, and drafts better page titles, descriptions, headings, image descriptions and a LocalBusiness schema for Google. You review everything before anything changes.</p>'
        }
        <p style="display:flex;gap:8px;flex-wrap:wrap">
          <button type="button" class="btn soft" id="seo-generate">${proposal ? 'Regenerate proposal' : 'Generate proposal'}</button>
          ${proposal && changes.length ? '<button type="button" class="btn" id="seo-apply">Apply these changes</button>' : ''}
        </p>
        <p class="hint" id="seo-message" role="status"></p>
      </div>
      ${history.length ? `<div class="panel"><h3>Applied before</h3>${history.map((h) => `<p style="margin:6px 0"><strong>${esc(h.change_count)}</strong> change(s) applied by ${h.actor_kind === 'owner' ? 'you' : 'the BitPype team'} · ${esc(h.applied_at || '')}${h.keywords && h.keywords.primary ? `<br><span class="hint">Primary keyword: ${esc(h.keywords.primary)}</span>` : ''}</p>`).join('')}</div>` : ''}
      ${gscPanel}`;
    wireGsc();
    const msg = document.getElementById('seo-message');
    const genBtn = document.getElementById('seo-generate');
    if (genBtn) {
      genBtn.addEventListener('click', async () => {
        genBtn.disabled = true;
        if (msg) msg.textContent = 'Generating — the AI is reviewing your site…';
        try {
          renderSeoTool(await api('/seo/generate', { method: 'POST' }));
        } catch (e) {
          genBtn.disabled = false;
          if (msg) msg.textContent = errText(e);
        }
      });
    }
    const applyBtn = document.getElementById('seo-apply');
    if (applyBtn) {
      applyBtn.addEventListener('click', async () => {
        applyBtn.disabled = true;
        if (msg) msg.textContent = 'Applying…';
        try {
          const r = await api('/seo/apply', { method: 'POST' });
          renderSeoTool(r.state);
          const m2 = document.getElementById('seo-message');
          if (m2) {
            const skipped = Array.isArray(r.skipped) ? r.skipped.length : 0;
            m2.textContent = `Done — ${Array.isArray(r.applied) ? r.applied.length : 0} change(s) applied to your site${skipped ? `, ${skipped} skipped because that part of the page had changed` : ''}. They go public at the next publish.`;
          }
        } catch (e) {
          applyBtn.disabled = false;
          if (msg) msg.textContent = errText(e);
        }
      });
    }
  }

  async function loadAnalytics() {
    const epoch = ++analyticsEpoch;
    const msg = document.getElementById('analytics-message');
    const form = document.getElementById('analytics-settings');
    const controls = [...form.querySelectorAll('input,button')];
    controls.forEach((el) => {
      el.disabled = true;
    });
    msg.className = 'msg';
    msg.textContent = 'Loading analytics…';
    try {
      const report = await api('/analytics?days=' + document.getElementById('analytics-days').value);
      if (epoch !== analyticsEpoch) return;
      document.getElementById('analytics-internal').checked = report.internalEnabled;
      document.getElementById('analytics-google').value = report.googleIds.join(', ');
      document.getElementById('analytics-visits').textContent = report.visits.toLocaleString();
      document.getElementById('analytics-clicks').textContent = report.clicks.toLocaleString();
      analyticsRows(
        'analytics-pages',
        report.pages.slice(0, 10).map((r) => [r.path, r.visits])
      );
      const labels = {
        phone: 'Phone links',
        email: 'Email links',
        internal: 'Site links',
        external: 'External links',
        button: 'Buttons',
      };
      analyticsRows(
        'analytics-types',
        report.clickTypes.map((r) => [labels[r.kind] || r.kind, r.count])
      );
      analyticsRows(
        'analytics-daily',
        report.daily.map((r) => [r.day, r.visits, r.clicks])
      );
      msg.textContent =
        report.internalEnabled || report.googleIds.length
          ? 'Tracking settings saved. Publish your website to install tracking if you have not done so yet.'
          : 'Tracking is off. Enable it above to start collecting visits after publishing.';
    } catch (e) {
      if (epoch === analyticsEpoch) {
        msg.className = 'msg err';
        msg.textContent = errText(e);
      }
    } finally {
      if (epoch === analyticsEpoch)
        controls.forEach((el) => {
          el.disabled = false;
        });
    }
  }
  document.getElementById('analytics-settings').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = document.getElementById('analytics-save');
    button.disabled = true;
    const msg = document.getElementById('analytics-message');
    try {
      await api('/analytics', {
        method: 'POST',
        body: JSON.stringify({
          internalEnabled: document.getElementById('analytics-internal').checked,
          googleIds: document.getElementById('analytics-google').value,
        }),
      });
      await loadAnalytics();
    } catch (e) {
      msg.className = 'msg err';
      msg.textContent = errText(e);
    } finally {
      button.disabled = false;
    }
  });
  document.getElementById('analytics-refresh').addEventListener('click', loadAnalytics);
  document.getElementById('analytics-days').addEventListener('change', loadAnalytics);

  async function loadBilling() {
    try {
      await loadBillingInner();
    } catch (e) {
      const pill = document.getElementById('bill-status');
      if (pill) {
        pill.textContent = 'Couldn’t load';
        pill.className = 'status-pill bad';
      }
      const noticeEl = document.getElementById('bill-notice');
      if (noticeEl) {
        noticeEl.hidden = false;
        noticeEl.innerHTML =
          `Billing could not be loaded (${esc(errText(e))}). ` +
          '<button type="button" class="btn ghost small" id="bill-retry">Retry</button>';
        const retry = document.getElementById('bill-retry');
        if (retry) retry.onclick = () => loadBilling().catch(() => {});
      }
    }
  }

  async function loadBillingInner() {
    const b = await api('/billing');
    const pill = document.getElementById('bill-status');
    const planId = String(b.plan || 'free');
    const status = String(b.subscriptionStatus || (planId === 'free' ? 'free' : 'none'));
    const planName = b.planName || planId.charAt(0).toUpperCase() + planId.slice(1);
    const isSuspended = !!(b.suspension && b.suspension.suspended);
    pill.textContent = isSuspended
      ? 'Suspended'
      : status === 'trialing'
        ? 'Trialing'
        : status === 'past_due'
          ? 'Past due'
          : status === 'active' || b.workspaceSubscribed
            ? 'Active'
            : planId === 'free'
              ? 'Free'
              : status;
    pill.className =
      'status-pill' +
      (status === 'past_due' ? ' warn' : '') +
      (status === 'canceled' || isSuspended ? ' bad' : '');
    const planEl = document.getElementById('bill-plan-name');
    if (planEl) planEl.textContent = planName + ' plan';
    state.planName = planName;

    const end = b.currentPeriodEnd
      ? new Date(String(b.currentPeriodEnd).replace(' ', 'T') + (String(b.currentPeriodEnd).includes('Z') ? '' : 'Z'))
      : null;
    const endLabel =
      end && Number.isFinite(end.getTime())
        ? end.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
        : '';
    document.getElementById('bill-renewal').textContent =
      b.cancelAtPeriodEnd && endLabel
        ? `Access continues until ${endLabel}, then you move to Free.`
        : endLabel
          ? `Renews / period ends ${endLabel}.`
          : planId === 'free'
            ? 'You’re on Free — upgrade anytime for support. Pro and Premium include social images.'
            : 'Your service is currently covered.';
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
      } else if (flag === 'credits_success') {
        banner.hidden = false;
        banner.className = 'bill-alert ok';
        banner.innerHTML = '<strong>Credits payment received.</strong> Balance updates when Stripe confirms.';
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
    const footEl = document.getElementById('bill-plan-foot');
    if (footEl) {
      footEl.textContent = canSelfServe
        ? 'Switch plans here anytime. Switching between paid plans updates your Stripe subscription with proration. Downgrade to Free cancels at period end. Payment method and receipts: Manage subscription.'
        : 'Your plan is covered by Bitpype — contact us to change plans, update payment details, or cancel.';
    }

    const credits = b.credits || {};
    state.creditsBalance = Number(credits.balance || 0);
    state.creditsConfigured = !!credits.priceConfigured;
    state.creditsPackLabel = credits.packLabel || state.creditsPackLabel;
    state.imageCredits = Number(credits.perSocialImage != null ? credits.perSocialImage : state.imageCredits);
    state.contentCredits = Number(credits.perSocialContent != null ? credits.perSocialContent : state.contentCredits);
    const balEl = document.getElementById('bill-credits-balance');
    if (balEl) balEl.textContent = `Balance: ${state.creditsBalance} credits`;
    const ratesEl = document.getElementById('bill-credits-rates');
    if (ratesEl) {
      ratesEl.textContent = `Pack: ${credits.packLabel || '—'} · Image ${state.imageCredits} credit(s) · Content ${state.contentCredits} credit(s)`;
    }
    const buyBtn = document.getElementById('btn-buy-credits');
    if (buyBtn) {
      buyBtn.hidden = !(canSelfServe && state.creditsConfigured);
      const packPrice = credits.packPriceUsd != null ? Number(credits.packPriceUsd) : null;
      const priceLabel =
        packPrice != null && Number.isFinite(packPrice) && packPrice > 0
          ? ` — $${packPrice % 1 === 0 ? String(packPrice) : packPrice.toFixed(2)}`
          : '';
      buyBtn.textContent = `Buy ${credits.packLabel || 'credits'}${priceLabel}`;
    }

    state.entitlements = b.entitlements || {};
    state.plan = b.plan || 'free';
    if (state.plan !== 'free') hideUpsellTip();
    renderPlanCards(b);
    syncMcpPlanAccess(planId);
    updateFormsPlanLine();
  }

  const PLAN_NAMES = { free: 'Free', standard: 'Standard', pro: 'Pro', premium: 'Premium' };
  function updateFormsPlanLine(fallbackPlanId) {
    const el = document.getElementById('forms-plan-line');
    if (!el) return;
    const planId = String(state.plan || fallbackPlanId || 'free');
    const name = state.planName || PLAN_NAMES[planId] || planId;
    el.textContent = `Your plan: ${name}.`;
  }

  // Batch 84 — Agent SOUL.md panel. The server owns the document
  // (server/agent-soul.md); this loader fetches the rendered HTML for
  // reading plus the raw markdown the Copy button puts on the
  // clipboard, exactly as served — the page never re-types the text.
  let soulMarkdown = '';
  let soulLoaded = false;
  async function loadAgentSoul() {
    if (soulLoaded) return;
    const data = await api('/agent-soul');
    soulMarkdown = data.markdown || '';
    const doc = document.getElementById('soul-doc');
    if (doc) doc.innerHTML = data.html || '';
    soulLoaded = true;
  }

  // Batch 114 — WordPress panel. The server owns the registrations
  // (server/wpPlugin.js); this loader only renders them. Every value
  // reaches the DOM via textContent / createElement — no HTML string
  // building — because site names and URLs are owner-supplied text.
  const WP_STATUS_LABELS = {
    minted: 'Waiting for install',
    connected: 'Connected',
    disconnected: 'Disconnected',
    revoked: 'Revoked',
  };
  function wpFmtDate(v) {
    if (!v) return '—';
    return String(v).replace('T', ' ').slice(0, 16);
  }
  function wpCell(text) {
    const td = document.createElement('td');
    td.textContent = text == null || text === '' ? '—' : String(text);
    return td;
  }
  function renderWpDownloads(downloads) {
    const host = document.getElementById('wp-downloads');
    if (!host) return;
    host.replaceChildren();
    if (!Array.isArray(downloads) || !downloads.length) {
      const p = document.createElement('p');
      p.className = 'hint';
      p.style.margin = '0';
      p.textContent = 'No downloads yet. Your first download will appear here, and so will the WordPress site it connects.';
      host.appendChild(p);
      return;
    }
    const table = document.createElement('table');
    table.className = 'mcp-table';
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const label of ['WordPress site', 'Status', 'Downloaded', 'Connected', '']) {
      const th = document.createElement('th');
      th.textContent = label;
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    for (const d of downloads) {
      const tr = document.createElement('tr');
      tr.appendChild(wpCell(d.siteUrl || (d.status === 'minted' ? 'Not connected yet' : '')));
      tr.appendChild(wpCell(WP_STATUS_LABELS[d.status] || d.status));
      tr.appendChild(wpCell(wpFmtDate(d.createdAt)));
      tr.appendChild(wpCell(wpFmtDate(d.registeredAt)));
      const actionTd = document.createElement('td');
      if (d.status !== 'revoked') {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn soft small';
        btn.textContent = 'Revoke';
        btn.addEventListener('click', () => revokeWpDownload(d.id).catch(() => {}));
        actionTd.appendChild(btn);
      }
      tr.appendChild(actionTd);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    const wrap = document.createElement('div');
    wrap.className = 'mcp-table-wrap';
    wrap.appendChild(table);
    host.appendChild(wrap);
  }
  async function loadWordpressPanel() {
    const data = await api('/wordpress');
    renderWpDownloads(data.downloads || []);
  }
  async function revokeWpDownload(id) {
    const msg = document.getElementById('msg-wordpress');
    if (!window.confirm('Revoke this connection? That WordPress site will stop showing your BitPype forms right away.')) return;
    const data = await api(`/wordpress/${encodeURIComponent(id)}/revoke`, { method: 'POST' });
    renderWpDownloads(data.downloads || []);
    if (msg) {
      msg.className = 'msg ok';
      msg.textContent = 'Connection revoked.';
    }
  }

  const mcpEndpoint = () => `${window.location.origin}/mcp`;
  let mcpLastToken = '';

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

  function fmtMcpDate(v) {
    if (!v) return '—';
    // Batch 107: non-breaking separators — a rendered timestamp is one
    // unbreakable token inside table cells (display only).
    return String(v).replace('T', ' ').slice(0, 16).replace(/-/g, '\u2011').replace(/ /g, '\u00A0');
  }

  function initMcpEndpointUi() {
    const ep = mcpEndpoint();
    const pre = document.getElementById('mcp-snippet');
    const label = document.getElementById('mcp-endpoint-label');
    if (pre) pre.textContent = mcpCursorSnippet(ep, '<YOUR_MCP_TOKEN>');
    if (label) label.textContent = ep;
  }

  function syncMcpPlanAccess(planId) {
    const paid = planId === 'standard' || planId === 'pro' || planId === 'premium';
    state.mcpPaid = paid;
    const nav = document.getElementById('nav-mcp');
    if (nav) nav.hidden = !paid || !portalTabVisible('mcp');
    const upgrade = document.getElementById('mcp-upgrade');
    const app = document.getElementById('mcp-app');
    if (paid) {
      if (upgrade) upgrade.hidden = true;
      if (app) app.hidden = false;
      refreshMcpTokens().catch(() => {});
    } else {
      if (upgrade) upgrade.hidden = false;
      if (app) app.hidden = true;
    }
  }

  async function refreshMcpTokens() {
    const tbody = document.getElementById('mcp-tokens-body');
    const heading = document.getElementById('mcp-tokens-heading');
    if (!tbody || !state.mcpPaid) return;
    tbody.innerHTML = '<tr><td colspan="5" class="empty-cell">Loading…</td></tr>';
    try {
      const data = await api('/mcp/tokens');
      const tokens = data.tokens || [];
      if (heading) heading.textContent = `Your MCP tokens (${tokens.length})`;
      tbody.innerHTML =
        tokens
          .map(
            (t) => `
        <tr>
          <td>${esc(t.name || '')}</td>
          <td class="mono">${esc(t.token_prefix || '')}…</td>
          <td>${esc(fmtMcpDate(t.last_used_at))}</td>
          <td>${esc(fmtMcpDate(t.created_at))}</td>
          <td><button type="button" class="btn ghost small" data-mcp-revoke="${t.id}" style="color:var(--err)">Revoke</button></td>
        </tr>`
          )
          .join('') ||
        '<tr><td colspan="5" class="empty-cell">No tokens yet. Create one to connect your agent.</td></tr>';
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="5" class="empty-cell">${esc(errText(e))}</td></tr>`;
    }
  }

  let formState = {
    fields: [],
    entitlements: {},
    plan: 'free',
    forms: [],
    pages: [],
    editingId: null,
    current: null,
    currentEmbed: null,
  };

  function renderFormFieldsEditor() {
    const box = document.getElementById('form-fields-editor');
    if (!box) return;
    if (!formState.fields.length) {
      box.innerHTML = '<p class="hint">No fields yet.</p>';
      return;
    }
    box.innerHTML = formState.fields
      .map(
        (f, i) => `
      <div class="row" data-field-i="${i}" style="gap:8px;flex-wrap:wrap;margin:0 0 8px;align-items:flex-end">
        <div class="field" style="flex:1;min-width:120px;margin:0">
          <label>Label</label>
          <input data-fk="label" value="${esc(f.label || '')}" />
        </div>
        <div class="field" style="width:110px;margin:0">
          <label>Type</label>
          <select data-fk="field_type">
            ${['text', 'email', 'tel', 'textarea', 'select', 'checkbox', 'number', 'url']
              .map((t) => `<option value="${t}"${f.field_type === t ? ' selected' : ''}>${t}</option>`)
              .join('')}
          </select>
        </div>
        <label class="hint" style="display:flex;align-items:center;gap:4px;margin-bottom:8px">
          <input type="checkbox" data-fk="required"${f.required ? ' checked' : ''} /> Required
        </label>
        <button type="button" class="btn ghost small" data-fk="remove">Remove</button>
      </div>`
      )
      .join('');
  }

  function collectFormFieldsFromEditor() {
    const box = document.getElementById('form-fields-editor');
    if (!box) return formState.fields;
    const rows = [...box.querySelectorAll('[data-field-i]')];
    return rows.map((row, i) => {
      const prev = formState.fields[i] || {};
      return {
        field_key: prev.field_key || '',
        label: (row.querySelector('[data-fk="label"]') || {}).value || prev.label || 'Field',
        field_type: (row.querySelector('[data-fk="field_type"]') || {}).value || 'text',
        required: !!(row.querySelector('[data-fk="required"]') || {}).checked,
        placeholder: prev.placeholder || '',
        options: prev.options || null,
        sort_order: i,
      };
    });
  }

  function fillPageSelect(pages, selected) {
    const sel = document.getElementById('form-target-page');
    if (!sel) return;
    const list =
      Array.isArray(pages) && pages.length
        ? pages
        : [
            { slug: 'contact', title: 'Contact' },
            { slug: 'home', title: 'Home' },
            { slug: 'about', title: 'About' },
          ];
    const want = String(selected || 'contact');
    const slugs = new Set(list.map((p) => String(p.slug)));
    if (!slugs.has('contact')) list.unshift({ slug: 'contact', title: 'Contact' });
    sel.innerHTML = list
      .map((p) => {
        const slug = esc(p.slug);
        const label = esc(p.title || p.slug);
        return `<option value="${slug}"${String(p.slug) === want ? ' selected' : ''}>${label}</option>`;
      })
      .join('');
  }

  function showFormsList() {
    formState.editingId = null;
    formState.current = null;
    const listPanel = document.getElementById('forms-list-panel');
    const editor = document.getElementById('forms-editor-panel');
    if (listPanel) listPanel.hidden = false;
    if (editor) editor.hidden = true;
  }

  function showFormEditor() {
    const listPanel = document.getElementById('forms-list-panel');
    const editor = document.getElementById('forms-editor-panel');
    if (listPanel) listPanel.hidden = true;
    if (editor) editor.hidden = false;
    setFormsPane('setup');
  }

  function formLocationLabel(form) {
    const attached = form.embed_enabled !== false && form.embed_on_page !== false;
    if (!attached) return 'Embed URL only';
    const slug = String(form.target_page_slug || 'contact').trim() || 'contact';
    const nice = slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    return `On the ${nice} page`;
  }

  function renderFormsList() {
    const box = document.getElementById('forms-list');
    if (!box) return;
    const items = formState.forms || [];
    if (!items.length) {
      box.innerHTML = '<p class="hint">No forms yet. Click New form to create one.</p>';
      return;
    }
    box.classList.add('item-list');
    box.innerHTML = items
      .map((entry) => {
        const f = entry.form || entry;
        const status = f.published ? 'published' : 'draft';
        const pillClass = f.published ? 'status-pill' : 'status-pill draft';
        const kind = f.form_kind ? String(f.form_kind) : '';
        const place = formLocationLabel(f);
        return `<article class="item-card">
        <span class="item-card-mark" aria-hidden="true"></span>
        <div class="item-card-main">
          <p class="item-card-kicker">Form</p>
          <h3 class="item-card-title">${esc(f.name || f.title || 'Form')}</h3>
          <div class="item-card-meta">
            <span class="${pillClass}">${esc(status)}</span>
            ${kind ? `<span class="sep">·</span><span>${esc(kind)}</span>` : ''}
            <span class="sep">·</span>
            <span>${esc(place)}</span>
          </div>
        </div>
        <div class="item-card-actions">
          <button type="button" class="btn soft small" data-edit-form="${f.id}">Edit</button>
        </div>
      </article>`;
      })
      .join('');
    box.querySelectorAll('[data-edit-form]').forEach((btn) => {
      btn.onclick = () => openFormEditor(Number(btn.getAttribute('data-edit-form')));
    });
  }

  function applyFormToEditor(form, embed) {
    formState.current = form;
    formState.editingId = form.id;
    formState.currentEmbed = embed || null;
    formState.fields = Array.isArray(form.fields) ? form.fields.slice() : [];
    const nameEl = document.getElementById('form-name');
    if (nameEl) nameEl.value = form.name || form.title || '';
    document.getElementById('form-title').value = form.title || '';
    document.getElementById('form-intro').value = form.intro || '';
    document.getElementById('form-submit-label').value = form.submit_label || 'Send Message';
    document.getElementById('form-notify').value = form.notify_email || '';
    document.getElementById('form-success').value = form.success_message || '';
    const embedCb = document.getElementById('form-embed-on-page');
    if (embedCb) embedCb.checked = form.embed_enabled !== false && form.embed_on_page !== false;
    const navCb = document.getElementById('form-add-to-nav');
    if (navCb) navCb.checked = !!(form.add_to_nav || form.nav_visible);
    fillPageSelect(formState.pages, form.target_page_slug || 'contact');
    renderFormFieldsEditor();
    const embedTa = document.getElementById('form-embed-code');
    const hint = document.getElementById('form-embed-hint');
    const onPage = form.embed_enabled !== false && form.embed_on_page !== false;
    if (embed && embed.html) {
      embedTa.hidden = false;
      embedTa.value = embed.html;
      hint.textContent = form.published
        ? onPage
          ? `Published on your ${form.target_page_slug || 'contact'} page · ${embed.url || ''}`
          : `Published (embed URL only) · ${embed.url || ''}`
        : 'Save and publish to get an embed snippet.';
    } else {
      embedTa.hidden = true;
      hint.textContent = onPage
        ? 'Publish to show this form on the selected site page (and get an embed URL).'
        : 'Publish to get an embed URL (not added to a site page).';
    }
    showFormEditor();
  }

  async function openFormEditor(formId) {
    const data = await api(`/forms/${formId}`);
    if (data.pages) formState.pages = data.pages;
    applyFormToEditor(data.form || {}, data.embed);
  }

  // Batch 45 — submissions inbox paging (server: 50/page + total).
  let formSubsShown = [];
  let formSubsTotal = null;

  async function loadFormSubmissions(more) {
    const sub = await api(more ? `/forms/submissions?limit=50&offset=${formSubsShown.length}` : '/forms/submissions?limit=50');
    formState.plan = sub.plan || 'free';
    updateFormsPlanLine(formState.plan);
    const notice = document.getElementById('form-inbox-notice');
    const list = document.getElementById('form-submissions');
    if (!sub.inbox) {
      notice.textContent = sub.notice || 'Submissions are emailed only on Free.';
      list.innerHTML = '';
      formSubsShown = [];
      formSubsTotal = null;
    } else {
      const fresh = sub.submissions || [];
      formSubsTotal = sub.total != null ? Number(sub.total) : null;
      formSubsShown = more ? formSubsShown.concat(fresh) : fresh;
      const rows = formSubsShown;
      notice.textContent =
        formSubsTotal != null
          ? `${rows.length} of ${formSubsTotal} submission(s).`
          : `${rows.length} recent submission(s).`;
      list.innerHTML = rows.length
        ? rows
            .map((s) => {
              const payload = s.payload || {};
              const preview = Object.entries(payload)
                .slice(0, 3)
                .map(([k, v]) => `${esc(k)}: ${esc(String(v).slice(0, 80))}`)
                .join(' · ');
              return `<article class="post-card" style="margin-bottom:var(--card-gap)">
            <div class="post-body">
              <div class="post-meta">
                <label style="display:inline-flex;gap:6px;align-items:center"><input type="checkbox" class="sub-select" value="${esc(s.id)}" /></label>
                <span>${esc(
                  String(s.created_at || '')
                    .replace('T', ' ')
                    .slice(0, 16)
                )}</span>
                <span class="status-pill">${esc(s.routing || '')}</span>
                ${s.form_id != null ? `<span class="hint">form #${esc(String(s.form_id))}</span>` : ''}
                ${s.encrypted ? '<span class="hint">encrypted</span>' : ''}
                <button type="button" class="btn ghost small" data-sub-delete="${esc(s.id)}">Delete</button>
              </div>
              <p class="post-cap">${preview || '(empty)'}</p>
            </div>
          </article>`;
            })
            .join('') +
          `<div class="row" style="gap:8px;margin-top:10px;flex-wrap:wrap">
            <button type="button" class="btn ghost small" id="subs-delete-selected">Delete selected</button>
            ${formSubsTotal != null && rows.length < formSubsTotal ? '<button type="button" class="btn soft small" id="subs-load-more">Load more</button>' : ''}
          </div>`
        : '<p class="hint">No submissions yet.</p>';
      list.querySelectorAll('[data-sub-delete]').forEach((btn) => {
        btn.onclick = async () => {
          if (!window.confirm('Delete this submission? The sender stays in LeadScout.')) return;
          try {
            await api(`/forms/submissions/${encodeURIComponent(btn.getAttribute('data-sub-delete'))}`, { method: 'DELETE' });
            loadFormSubmissions().catch(() => {});
          } catch (e) {
            window.alert(errText(e));
          }
        };
      });
      const bulkBtn = document.getElementById('subs-delete-selected');
      if (bulkBtn) {
        bulkBtn.onclick = async () => {
          const ids = Array.from(list.querySelectorAll('.sub-select:checked')).map((n) => Number(n.value));
          if (!ids.length) return;
          if (!window.confirm(`Delete ${ids.length} submission(s)? The senders stay in LeadScout.`)) return;
          try {
            await api('/forms/submissions/delete-bulk', { method: 'POST', body: JSON.stringify({ ids }) });
            loadFormSubmissions().catch(() => {});
          } catch (e) {
            window.alert(errText(e));
          }
        };
      }
      const moreBtn = document.getElementById('subs-load-more');
      if (moreBtn) moreBtn.onclick = () => loadFormSubmissions(true).catch(() => {});
    }
  }

  async function loadForms() {
    try {
      await loadFormsInner();
    } catch (e) {
      const list = document.getElementById('forms-list');
      if (list) {
        list.innerHTML =
          '<p class="hint">Something went wrong loading your forms. ' +
          '<button type="button" class="btn ghost small" id="forms-retry">Retry</button></p>';
        const retry = document.getElementById('forms-retry');
        if (retry) retry.onclick = () => loadForms().catch(() => {});
      }
      const msg = document.getElementById('msg-forms-list');
      if (msg) {
        msg.className = 'msg err';
        msg.textContent = errText(e);
      }
    }
  }

  async function loadFormsInner() {
    const data = await api('/forms');
    formState.forms = Array.isArray(data.forms)
      ? data.forms
      : data.form
        ? [{ form: data.form, embed: data.embed }]
        : [];
    formState.pages = Array.isArray(data.pages) ? data.pages : [];
    renderFormsList();
    if (formState.editingId) {
      const match = formState.forms.find((e) => (e.form || e).id === formState.editingId);
      if (match) applyFormToEditor(match.form || match, match.embed);
      else showFormsList();
    } else {
      showFormsList();
    }
    try {
      await loadFormSubmissions();
    } catch (e) {
      const notice = document.getElementById('form-inbox-notice');
      if (notice) notice.textContent = `Submissions could not be loaded (${errText(e)}).`;
    }
  }

  async function loadSocialAccounts() {
    const msg = document.getElementById('msg-meta');
    const list = document.getElementById('social-accounts-list');
    const hint = document.getElementById('social-accounts-hint');
    try {
      const data = await api('/social/accounts');
      const accounts = (data && data.accounts) || [];
      state.metaConfigured = !!(data && data.metaConfigured);
      state.socialAccountsCount = accounts.length;
      if (!state.metaConfigured) {
        hint.textContent =
          'Social accounts aren’t connected yet. Contact Bitpype to connect your Facebook Page and Instagram account.';
      } else {
        hint.textContent = accounts.length
          ? 'Connected accounts for automatic scheduling.'
          : 'Connect a Facebook Page (Instagram Business linked) to schedule posts.';
      }
      list.innerHTML = accounts.length
        ? accounts
            .map(
              (a) => `
          <div class="row" style="justify-content:space-between;margin:6px 0;gap:8px;flex-wrap:wrap">
            <span><strong>${esc(a.platform)}</strong> · ${esc(a.account_name || a.account_id || '')}
              <span class="status-pill">${esc(a.status || '')}</span></span>
            <button type="button" class="btn ghost small" data-disconnect="${esc(a.id)}">Disconnect</button>
          </div>`
            )
            .join('')
        : '<p class="hint">No accounts connected.</p>';
      if (msg && /connected=1/.test(location.search)) {
        msg.className = 'msg ok';
        msg.textContent = 'Meta connected.';
      }
      if (state.posts && state.posts.length) renderPostPage();
    } catch (e) {
      if (hint) hint.textContent = 'Could not load your social accounts.';
      if (list) {
        list.innerHTML =
          '<p class="hint">Something went wrong loading your accounts. ' +
          '<button type="button" class="btn ghost small" id="social-accounts-retry">Retry</button></p>';
        const retry = document.getElementById('social-accounts-retry');
        if (retry) retry.onclick = () => loadSocialAccounts().catch(() => {});
      }
      if (msg) {
        msg.className = 'msg err';
        msg.textContent = errText(e);
      }
    }
  }

  const MODULE_TYPES = [
    { type: 'blog', label: 'Blog' },
    { type: 'ecommerce', label: 'Shop' },
    { type: 'courses', label: 'Courses' },
    { type: 'gallery', label: 'Gallery' },
    { type: 'directory', label: 'Directory' },
    { type: 'faq', label: 'FAQ' },
    { type: 'testimonials', label: 'Testimonials' },
    { type: 'team', label: 'Team' },
    { type: 'events', label: 'Events' },
    { type: 'bookings', label: 'Bookings' },
    { type: 'chatbot', label: 'Chatbot' },
    { type: 'offers', label: 'Special Offers' },
    { type: 'menu', label: 'Menu / Price List' },
    { type: 'careers', label: 'Careers' },
    { type: 'video', label: 'Video' },
    { type: 'estimate', label: 'Instant Estimate' },
    { type: 'socialfeed', label: 'Social Feed' },
    { type: 'googlereviews', label: 'Google Reviews' },
    { type: 'calltracking', label: 'Call Tracking' },
    { type: 'members', label: 'Membership' },
    { type: 'datatables', label: 'Data Tables' },
    { type: 'charts', label: 'Charts' },
    { type: 'newsletter', label: 'Newsletter' },
    { type: 'categories', label: 'Categories' },
    { type: 'photocapture', label: 'Photo Capture' },
    { type: 'qrcode', label: 'QR Code' },
    { type: 'checkout', label: 'Checkout' },
    { type: 'comments', label: 'Comments' },
    { type: 'pricing', label: 'Pricing' },
  ];
  const MODULE_NAV_GROUPS = [
    { id: 'content', label: 'Content', types: ['blog', 'ecommerce', 'checkout', 'gallery', 'courses', 'directory', 'faq', 'offers', 'menu', 'video', 'estimate', 'socialfeed', 'googlereviews', 'datatables', 'charts', 'categories', 'photocapture', 'qrcode', 'comments', 'pricing'] },
    { id: 'people', label: 'People', types: ['team', 'testimonials', 'careers', 'members', 'newsletter'] },
    { id: 'schedule', label: 'Schedule', types: ['events', 'bookings'] },
    { id: 'assist', label: 'Assist', types: ['chatbot', 'calltracking'] },
  ];
  // Batch 111 (consolidation): the Batch 91 icon family
  // (MODULE_ICON_PATHS + MODULE_ICON_FALLBACK) now lives in ONE
  // shared source — public/js/moduleIcons.js, loaded by
  // portal.html before this file; the per-file copy was removed.
  function moduleIconSvg(type) {
    return `<svg class="module-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${MODULE_ICON_PATHS[type] || MODULE_ICON_FALLBACK}</svg>`;
  }
  // Icon chip tint follows the module's nav group (platform palette).
  function moduleIconTint(type) {
    const g = MODULE_NAV_GROUPS.find((grp) => grp.types.includes(type));
    return g ? ` tint-${g.id}` : '';
  }
  // Glyphs for the Insert-block picker (design blocks + forms), same
  // stroke family; site modules reuse MODULE_ICON_PATHS above.
  const BLOCK_ICON_PATHS = {
    heading: '<path d="M6 4v16"/><path d="M18 4v16"/><path d="M6 12h12"/>',
    text: '<path d="M5 6h14"/><path d="M5 10h14"/><path d="M5 14h9"/><path d="M5 18h9"/>',
    image: MODULE_ICON_PATHS.gallery,
    html: '<path d="M8.5 7L3.8 12l4.7 5"/><path d="M15.5 7l4.7 5-4.7 5"/>',
    columns: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M9.2 5v14"/><path d="M14.8 5v14"/>',
    text_image: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M7 9.5h4"/><path d="M7 13h4"/><circle cx="15.8" cy="10.2" r="1.1"/><path d="M13.2 17.5l2.6-2.4 1.9 1.7 1.6-1.4"/>',
    cards: MODULE_ICON_FALLBACK,
    hero: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><circle cx="9" cy="9.8" r="1.3"/><path d="M3.8 17.5l4.7-3.8 3.4 2.7 3-2.3 5.3 3.9"/>',
    services: '<path d="M9.5 6H20"/><path d="M9.5 12H20"/><path d="M9.5 18H20"/><path d="M3.8 5.8l1.3 1.3L7.4 4.8"/><path d="M3.8 11.8l1.3 1.3 2.3-2.3"/><path d="M3.8 17.8l1.3 1.3 2.3-2.3"/>',
    benefits: '<path d="M12 3l7 2.5v5.7c0 4.6-3 7.9-7 9.8-4-1.9-7-5.2-7-9.8V5.5z"/><path d="M9 11.6l2.2 2.2 3.8-4"/>',
    about: '<circle cx="12" cy="12" r="8.8"/><path d="M12 11v5"/><circle cx="12" cy="7.9" r="0.4" fill="currentColor"/>',
    faq: MODULE_ICON_PATHS.faq,
    cta: '<path d="M3.8 10.2v3.6h2.7l8.7 4.7V5.5L6.5 10.2z"/><path d="M18.5 9.2a4.4 4.4 0 0 1 0 5.6"/>',
    reviews: MODULE_ICON_PATHS.googlereviews,
    gallery: MODULE_ICON_PATHS.gallery,
    form: '<rect x="5.5" y="4" width="13" height="17" rx="2"/><path d="M9 4.2a3 3 0 0 1 6 0"/><path d="M9 11h6"/><path d="M9 15h4"/>',
  };
  function blockIconSvg(type) {
    return `<svg class="module-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${BLOCK_ICON_PATHS[type] || MODULE_ICON_FALLBACK}</svg>`;
  }
  const MODULE_ITEM_COPY = {
    blog: { singular: 'post', plural: 'posts', newBtn: 'New post', kicker: 'Blog post' },
    ecommerce: { singular: 'product', plural: 'products', newBtn: 'New product', kicker: 'Product' },
    courses: { singular: 'course', plural: 'courses', newBtn: 'New course', kicker: 'Course' },
    gallery: { singular: 'album', plural: 'albums', newBtn: 'New album', kicker: 'Gallery album' },
    directory: { singular: 'listing', plural: 'listings', newBtn: 'New listing', kicker: 'Listing' },
    faq: { singular: 'question', plural: 'questions', newBtn: 'New question', kicker: 'FAQ' },
    testimonials: { singular: 'testimonial', plural: 'testimonials', newBtn: 'New testimonial', kicker: 'Testimonial' },
    team: { singular: 'member', plural: 'team members', newBtn: 'New team member', kicker: 'Team' },
    events: { singular: 'event', plural: 'events', newBtn: 'New event', kicker: 'Event' },
    bookings: { singular: 'service', plural: 'services', newBtn: 'New service', kicker: 'Booking service' },
    chatbot: { singular: 'knowledge item', plural: 'knowledge items', newBtn: 'Add knowledge', kicker: 'Knowledge' },
    offers: { singular: 'offer', plural: 'offers', newBtn: 'New offer', kicker: 'Special offer' },
    menu: { singular: 'menu item', plural: 'menu items', newBtn: 'New menu item', kicker: 'Menu item' },
    careers: { singular: 'posting', plural: 'postings', newBtn: 'New posting', kicker: 'Job posting' },
    video: { singular: 'video', plural: 'videos', newBtn: 'New video', kicker: 'Video' },
    estimate: { singular: 'option', plural: 'options', newBtn: 'New option', kicker: 'Estimate option' },
    socialfeed: { singular: 'post', plural: 'posts', newBtn: 'New post', kicker: 'Social post' },
    googlereviews: { singular: 'review', plural: 'reviews', newBtn: 'New review', kicker: 'Google review' },
    calltracking: { singular: 'call', plural: 'calls', newBtn: 'New call', kicker: 'Call' },
    members: { singular: 'member', plural: 'members', newBtn: 'New member', kicker: 'Member' },
    datatables: { singular: 'row', plural: 'rows', newBtn: 'New row', kicker: 'Table row' },
    charts: { singular: 'chart', plural: 'charts', newBtn: 'New chart', kicker: 'Chart' },
    newsletter: { singular: 'subscriber', plural: 'subscribers', newBtn: 'Add subscriber', kicker: 'Subscriber' },
    categories: { singular: 'category', plural: 'categories', newBtn: 'New category', kicker: 'Category' },
    photocapture: { singular: 'photo', plural: 'photos', newBtn: 'New photo', kicker: 'Photo submission' },
    qrcode: { singular: 'QR code', plural: 'QR codes', newBtn: 'New QR code', kicker: 'QR code' },
    checkout: { singular: 'order', plural: 'orders', newBtn: 'New order', kicker: 'Order' },
    comments: { singular: 'comment', plural: 'comments', newBtn: 'New comment', kicker: 'Comment' },
    pricing: { singular: 'price entry', plural: 'price entries', newBtn: 'New price entry', kicker: 'Pricing' },
  };
  const BOOKING_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MODULE_STORAGE_KEY = 'bp-portal-module';

  function moduleCopy(type) {
    return MODULE_ITEM_COPY[type] || { singular: 'item', plural: 'items', newBtn: 'New item', kicker: 'Item' };
  }

  function readStoredModuleType() {
    try {
      const v = String(sessionStorage.getItem(MODULE_STORAGE_KEY) || '').trim();
      if (MODULE_TYPES.some((m) => m.type === v)) return v;
    } catch {
      /* ignore */
    }
    return '';
  }

  function storeModuleType(type) {
    try {
      sessionStorage.setItem(MODULE_STORAGE_KEY, String(type || ''));
    } catch {
      /* ignore */
    }
  }

  let moduleState = {
    enabled: false,
    plan: 'free',
    current: readStoredModuleType() || 'blog',
    pane: 'content',
    summary: null,
    items: [],
    pages: [],
    embed: null,
    editingId: null,
    categories: [],
    // Batch 124: the shared taxonomy (every category of every scope)
    // feeding the item editors' category pickers, plus the Categories
    // module's own display-scope block from the server.
    allCategories: [],
    taxonomy: null,
    showArchivedAppointments: false,
    members: null,
    memberSearch: '',
    // Batch 45 — server-side paging state for the long lists.
    blogOffset: 0,
    blogTotal: null,
    memberOffset: 0,
    callOffset: 0,
  };

  let formsPane = 'setup';

  function moduleMsg(text, ok) {
    const el = document.getElementById('msg-modules');
    if (!el) return;
    el.className = ok ? 'msg ok' : text ? 'msg err' : 'msg';
    el.textContent = text || '';
  }

  // Batch 143 (full review): pager navigation for the server-paged
  // module lists (blog / members / calls). The offset advances ONLY
  // when the page load succeeds — the old handlers set the offset
  // first and swallowed the load error (.catch(() => {})), leaving
  // the stale list on screen under a pager claiming a new page.
  function pagerLoad(key, nextOffset) {
    const prev = moduleState[key] || 0;
    moduleState[key] = nextOffset;
    loadModuleItems().catch(() => {
      moduleState[key] = prev;
      moduleMsg('Could not load that page — please try again.');
    });
  }

  // Batch 124: the shared-taxonomy picker shared by the wired item
  // editors (blog, events, gallery albums, offers, directory). The
  // options are THIS lead's categories of the editor's own scope,
  // loaded by loadModuleItems into moduleState.allCategories — the
  // same assignments the design agent writes via categories.assign.
  // No categories in the scope → no picker rendered at all, so an
  // unused taxonomy changes nothing in the editors.
  function categoryPickerDef(scope) {
    const cats = (moduleState.allCategories || []).filter((c) => c && c.scope === scope);
    if (!cats.length) return null;
    return {
      key: 'category_ids',
      label: 'Categories',
      kind: 'checkboxes',
      options: cats.map((c) => ({ value: String(c.id), label: c.name || '' })),
      hint: 'Organize this item under the shared Categories taxonomy — ticked categories show it on their category pages.',
    };
  }

  function moduleFieldDefs(type) {
    const defs = moduleFieldDefsBase(type);
    // Batch 124: the wired consumers get the shared-taxonomy picker
    // appended (present only when the scope has categories).
    if (['blog', 'events', 'gallery', 'offers', 'directory', 'qrcode'].includes(type)) {
      const picker = categoryPickerDef(type);
      if (picker) defs.push(picker);
    }
    return defs;
  }

  function moduleFieldDefsBase(type) {
    if (type === 'socialfeed') {
      // Automatic module — no item editor; the Feed pane carries the settings.
      return [];
    }
    if (type === 'googlereviews') {
      // Automatic module — no item editor; the Reviews pane carries the
      // Place ID settings and the cached-review preview.
      return [];
    }
    if (type === 'calltracking') {
      // Automatic module — no item editor; the Calls pane carries the
      // number settings and the received-calls list.
      return [];
    }
    if (type === 'members') {
      // Members join from the public site — no item editor; the Members
      // pane carries the gating settings and the member list.
      return [];
    }
    if (type === 'newsletter') {
      // Batch 118: subscribers join from the public site — no item
      // editor; the Newsletter pane carries the list, compose and the
      // From settings.
      return [];
    }
    if (type === 'categories') {
      // Batch 124: the shared-taxonomy editor. Scope is chosen at
      // create and locked afterwards (the server refuses scope
      // changes — assignments were made under it). Parent options are
      // this lead's categories; the server enforces same-scope.
      const scopeOptions = MODULE_TYPES.map((m) => ({ value: m.type, label: m.label }));
      const editing = (moduleState.items || []).find(
        (c) => c && String(c.id) === String(moduleState.editingId || '')
      );
      const parentOptions = [{ value: '', label: 'No parent (top level)' }].concat(
        (moduleState.allCategories || [])
          .filter(
            (c) =>
              c &&
              String(c.id) !== String(moduleState.editingId || '') &&
              (!editing || c.scope === editing.scope)
          )
          .map((c) => ({
            value: String(c.id),
            label: `${(MODULE_TYPES.find((m) => m.type === c.scope) || {}).label || c.scope} — ${c.name || ''}`,
          }))
      );
      return [
        { key: 'name', label: 'Category name', required: true },
        {
          key: 'scope',
          label: 'Belongs to module',
          kind: 'select',
          options: scopeOptions,
          hint: 'The module whose items this category organizes. Chosen when the category is created — it cannot change later.',
        },
        { key: 'slug', label: 'Slug' },
        { key: 'description', label: 'Description', kind: 'textarea' },
        { key: 'image_url', label: 'Image', kind: 'image' },
        { key: 'parent_id', label: 'Parent category', kind: 'select', options: parentOptions },
        { key: 'sort_order', label: 'Sort order' },
        { key: 'status', label: 'Status', kind: 'select', options: ['draft', 'published'] },
      ];
    }
    if (type === 'datatables') {
      // Batch 88: the row editor's fields ARE the table's columns —
      // built from the schema the panel / MCP defined.
      const table = moduleState.datatable || {};
      const cols = Array.isArray(table.columns) ? table.columns : [];
      const roles = table.roles || {};
      const defs = cols.map((col) => {
        const def = { key: col.key, label: col.label || col.key };
        if (col.type === 'boolean') {
          def.kind = 'select';
          def.options = ['', 'Yes', 'No'];
        } else if (col.type === 'text' && roles.body === col.key) {
          def.kind = 'textarea';
        } else if (col.type === 'date') {
          def.placeholder = 'YYYY-MM-DD';
        } else if (col.type === 'link') {
          def.placeholder = 'https://…';
        } else if (col.type === 'currency') {
          def.placeholder = 'e.g. 49.99';
        }
        return def;
      });
      defs.push({ key: 'status', label: 'Status', kind: 'select', options: ['published', 'pending'] });
      return defs;
    }
    if (type === 'charts') {
      // Batch 90: a chart is one editor item. Table-binding pickers are
      // built from the site's Data Table columns (carried by the items
      // payload); manual data round-trips as one "Label | v | v" line
      // per point.
      const meta = moduleState.charts || {};
      const cols = Array.isArray(meta.datatable_columns) ? meta.datatable_columns : [];
      const colKeys = cols.map((c) => c.key);
      const numericKeys = cols.filter((c) => c.type === 'number' || c.type === 'currency').map((c) => c.key);
      return [
        { key: 'title', label: 'Chart title', required: true },
        { key: 'chart_type', label: 'Chart type', kind: 'select', options: ['bar', 'hbar', 'line', 'area', 'pie', 'doughnut'] },
        { key: 'source', label: 'Data source', kind: 'select', options: ['table', 'manual'] },
        {
          key: 'label_column',
          label: 'Table: label column',
          kind: 'select',
          options: [''].concat(colKeys),
        },
        {
          key: 'value_columns',
          label: 'Table: value columns (comma-separated keys' + (numericKeys.length ? ' — numeric: ' + numericKeys.join(', ') : '') + ')',
          placeholder: 'e.g. sales',
        },
        { key: 'aggregation', label: 'Table: aggregation', kind: 'select', options: ['sum', 'count', 'average', 'none'] },
        { key: 'series_names', label: 'Manual: series names (comma-separated)' },
        {
          key: 'data_text',
          label: 'Manual: data — one line per point, Label | value | value',
          kind: 'textarea',
          placeholder: 'Jan | 120 | 80',
        },
        { key: 'colors', label: 'Colors (comma-separated hex, optional)', placeholder: '#0e7a68, #e8873a' },
        { key: 'show_legend', label: 'Show legend', kind: 'select', options: ['Yes', 'No'] },
        { key: 'show_values', label: 'Show values', kind: 'select', options: ['No', 'Yes'] },
      ];
    }
    if (type === 'blog') {
      return [
        { key: 'title', label: 'Title', required: true },
        { key: 'slug', label: 'Slug' },
        { key: 'cover_image', label: 'Cover photo', kind: 'image' },
        { key: 'excerpt', label: 'Excerpt (optional — auto from body if empty)', kind: 'textarea' },
        { key: 'body_html', label: 'Body (HTML)', kind: 'textarea' },
        { key: 'status', label: 'Status', kind: 'select', options: ['draft', 'published'] },
      ];
    }
    if (type === 'ecommerce') {
      return [
        { key: 'name', label: 'Name', required: true },
        { key: 'slug', label: 'Slug' },
        { key: 'price', label: 'Price (e.g. 29.99)' },
        { key: 'currency', label: 'Currency', placeholder: 'USD' },
        { key: 'image_url', label: 'Product photo', kind: 'image' },
        { key: 'checkout_url', label: 'Checkout / buy URL' },
        { key: 'description', label: 'Description', kind: 'textarea' },
        { key: 'status', label: 'Status', kind: 'select', options: ['draft', 'published'] },
      ];
    }
    if (type === 'courses') {
      return [
        { key: 'title', label: 'Title', required: true },
        { key: 'slug', label: 'Slug' },
        { key: 'cover_image', label: 'Cover photo', kind: 'image' },
        { key: 'enrollment_url', label: 'Enrollment URL' },
        { key: 'description', label: 'Description', kind: 'textarea' },
        { key: 'status', label: 'Status', kind: 'select', options: ['draft', 'published'] },
      ];
    }
    if (type === 'gallery') {
      return [
        { key: 'title', label: 'Album title', required: true },
        { key: 'slug', label: 'Slug' },
        { key: 'description', label: 'Description', kind: 'textarea' },
        { key: 'status', label: 'Status', kind: 'select', options: ['draft', 'published'] },
        { key: 'image_url', label: 'First photo (optional)', kind: 'image' },
        {
          key: 'image_price',
          label: 'First photo price (optional)',
          placeholder: '25',
          hint: 'Price the first photo to sell it: priced photos in a published album can be bought through your Checkout page. Leave blank for display only.',
        },
      ];
    }
    if (type === 'faq') {
      return [
        { key: 'question', label: 'Question', required: true },
        { key: 'answer_html', label: 'Answer (HTML)', kind: 'textarea' },
        { key: 'category', label: 'Category' },
        { key: 'status', label: 'Status', kind: 'select', options: ['draft', 'published'] },
      ];
    }
    if (type === 'testimonials') {
      return [
        { key: 'quote', label: 'Quote', kind: 'textarea', required: true },
        { key: 'author_name', label: 'Author name' },
        { key: 'author_title', label: 'Author title / role' },
        { key: 'author_company', label: 'Company' },
        { key: 'rating', label: 'Rating (1–5)' },
        { key: 'image_url', label: 'Author photo', kind: 'image' },
        { key: 'status', label: 'Status', kind: 'select', options: ['draft', 'published'] },
      ];
    }
    if (type === 'team') {
      return [
        { key: 'name', label: 'Name', required: true },
        { key: 'slug', label: 'Slug' },
        { key: 'role_title', label: 'Role / title' },
        { key: 'bio', label: 'Bio', kind: 'textarea' },
        { key: 'image_url', label: 'Headshot', kind: 'image' },
        { key: 'email', label: 'Email' },
        { key: 'phone', label: 'Phone' },
        { key: 'social_url', label: 'Profile link' },
        { key: 'status', label: 'Status', kind: 'select', options: ['draft', 'published'] },
      ];
    }
    if (type === 'events') {
      return [
        { key: 'title', label: 'Title', required: true },
        { key: 'slug', label: 'Slug' },
        { key: 'starts_at', label: 'Starts (YYYY-MM-DD or datetime)' },
        { key: 'ends_at', label: 'Ends (optional)' },
        { key: 'location', label: 'Location' },
        { key: 'image_url', label: 'Event photo', kind: 'image' },
        {
          // Batch 122: the shared-layer gallery link — the SAME ref
          // the design agent sets via shared.link / gallery_album_id.
          key: 'gallery_album_id',
          label: 'Gallery album (shared)',
          kind: 'select',
          options: [
            { value: '', label: 'No gallery' },
            ...(moduleState.sharedAlbums || []).map((a) => ({
              value: String(a.source_id),
              label: a.title,
            })),
          ],
          hint: "Pick one of your gallery albums and its photos show on this event's page — modules share content through the shared layer.",
        },
        { key: 'ticket_url', label: 'Tickets / RSVP URL' },
        { key: 'description', label: 'Description', kind: 'textarea' },
        { key: 'status', label: 'Status', kind: 'select', options: ['draft', 'published'] },
      ];
    }
    if (type === 'bookings') {
      return [
        { key: 'name', label: 'Service name', required: true },
        { key: 'slug', label: 'Slug' },
        { key: 'duration_minutes', label: 'Duration (minutes)', placeholder: '30' },
        { key: 'buffer_minutes', label: 'Buffer between bookings (minutes)' },
        { key: 'price', label: 'Price (optional, e.g. 49)' },
        { key: 'currency', label: 'Currency', placeholder: 'USD' },
        { key: 'image_url', label: 'Service photo', kind: 'image' },
        { key: 'description', label: 'Description', kind: 'textarea' },
        { key: 'status', label: 'Status', kind: 'select', options: ['draft', 'published'] },
      ];
    }
    if (type === 'chatbot') {
      return [
        { key: 'kind', label: 'Type', kind: 'select', options: ['link', 'doc'] },
        { key: 'title', label: 'Title (optional if uploading files)' },
        { key: 'url', label: 'Website URL (for links)' },
        {
          key: 'files',
          label: 'Upload files (PDF, Word, Excel, PowerPoint, images, text)',
          kind: 'files',
          accept: '.pdf,.doc,.docx,.xls,.xlsx,.csv,.ppt,.pptx,.png,.jpg,.jpeg,.webp,.gif,.txt,.md,.html,.htm,.json',
          hint: 'Select one or more files. We extract searchable text (OCR for images) for the chat agent. Max 5MB each.',
        },
        { key: 'content_text', label: 'Notes / pasted text for the agent', kind: 'textarea' },
        { key: 'status', label: 'Status', kind: 'select', options: ['active', 'inactive'] },
      ];
    }
    if (type === 'pricing') {
      // Batch 139: the price-list editor. An entry is STANDALONE (its
      // own price) or LINKED to a booking service / shop product —
      // linked entries show the source's live name and price, and a
      // price typed here writes through to that source record (the
      // one number bookings and checkout charge). The link picker
      // options ride the list response (moduleState.pricing).
      const linkables = (moduleState.pricing && moduleState.pricing.linkables) || { bookings: [], ecommerce: [] };
      const linkOptions = [{ value: '', label: 'Standalone — its own price' }]
        .concat((linkables.bookings || []).map((s) => ({ value: `bookings:${s.id}`, label: `Booking service — ${s.name} (${s.price_label})` })))
        .concat((linkables.ecommerce || []).map((p) => ({ value: `ecommerce:${p.id}`, label: `Shop product — ${p.name} (${p.price_label})${p.has_variants ? ' · priced per variant' : ''}` })));
      return [
        { key: 'name', label: 'Name', hint: 'Required for a standalone entry. For a linked entry the name comes from the service/product itself — rename it there and this list follows.' },
        {
          key: 'linked_ref',
          label: 'Linked to',
          kind: 'select',
          options: linkOptions,
          hint: 'Link this line to a service or product to show ITS price — set once here, charged from the same number everywhere. Standalone lines carry their own price.',
        },
        { key: 'price', label: 'Price (e.g. 80 or 29.99)', hint: 'On a linked entry this edits the service/product price itself. A product priced per variant cannot take one price here — the server will refuse and point you to its variants.' },
        {
          key: 'price_mode',
          label: 'Show price as',
          kind: 'select',
          options: [
            { value: 'fixed', label: 'Exact price' },
            { value: 'from', label: 'From price ("From $…")' },
            { value: 'text', label: 'Text instead of an amount' },
          ],
        },
        { key: 'price_text', label: 'Text label', placeholder: 'Custom quote', hint: 'Used only when "Show price as" is Text.' },
        { key: 'unit_suffix', label: 'Unit (optional)', placeholder: 'per visit, /mo, per hour…' },
        { key: 'description', label: 'Description', kind: 'textarea' },
        { key: 'featured', label: 'Featured', kind: 'select', options: ['No', 'Yes'], hint: 'Featured entries are highlighted on your Pricing page.' },
        { key: 'sort_order', label: 'Sort order' },
        { key: 'status', label: 'Status', kind: 'select', options: ['draft', 'published'] },
      ];
    }
    if (type === 'offers') {
      return [
        { key: 'title', label: 'Offer title', required: true },
        { key: 'description', label: 'Description', kind: 'textarea' },
        { key: 'code', label: 'Promo code (optional)', placeholder: 'SAVE20' },
        { key: 'terms', label: 'Terms (optional)', kind: 'textarea' },
        { key: 'expires_at', label: 'Expires (optional)', placeholder: 'YYYY-MM-DD' },
        { key: 'image_url', label: 'Image (optional)', kind: 'image' },
        { key: 'sort_order', label: 'Sort order' },
        { key: 'status', label: 'Status', kind: 'select', options: ['draft', 'published'] },
      ];
    }
    if (type === 'menu') {
      const catOptions = [{ value: '', label: 'Uncategorized' }].concat(
        (moduleState.categories || []).map((c) => ({ value: String(c.id), label: c.name || '' }))
      );
      return [
        { key: 'name', label: 'Item name', required: true },
        { key: 'category_id', label: 'Category', kind: 'select', options: catOptions, hint: 'Manage categories above the item list.' },
        { key: 'price_text', label: 'Price', placeholder: '$12, Market price, from $40…' },
        { key: 'description', label: 'Description', kind: 'textarea' },
        { key: 'tags', label: 'Tags (optional)', placeholder: 'popular, spicy, gluten-free' },
        { key: 'sort_order', label: 'Sort order' },
        { key: 'status', label: 'Status', kind: 'select', options: ['draft', 'published'] },
      ];
    }
    if (type === 'careers') {
      return [
        { key: 'title', label: 'Job title', required: true },
        { key: 'employment_type', label: 'Employment type', kind: 'select', options: ['Full-time', 'Part-time', 'Contract', 'Seasonal'] },
        { key: 'location', label: 'Location', placeholder: 'Reading, PA' },
        { key: 'description', label: 'Description', kind: 'textarea' },
        { key: 'apply_mode', label: 'How to apply', kind: 'select', options: ['email', 'url', 'form'] },
        { key: 'apply_target', label: 'Apply target', placeholder: 'Email, application URL, or form page' },
        { key: 'sort_order', label: 'Sort order' },
        { key: 'status', label: 'Status', kind: 'select', options: ['active', 'inactive'] },
      ];
    }
    if (type === 'video') {
      return [
        { key: 'title', label: 'Title', required: true },
        { key: 'url', label: 'Video URL (YouTube or Vimeo)', required: true, placeholder: 'https://www.youtube.com/watch?v=…' },
        { key: 'description', label: 'Description (optional)', kind: 'textarea' },
        { key: 'thumbnail_url', label: 'Thumbnail override (optional)', kind: 'image' },
        { key: 'sort_order', label: 'Sort order' },
        { key: 'status', label: 'Status', kind: 'select', options: ['draft', 'published'] },
      ];
    }
    if (type === 'estimate') {
      return [
        { key: 'label', label: 'Option label', required: true, placeholder: 'e.g. Extra bathroom' },
        {
          key: 'input_type',
          label: 'Visitor picks',
          kind: 'select',
          options: ['checkbox', 'select', 'quantity'],
          hint: 'Checkbox = add the price when ticked. Quantity = price × amount. Select = visitor picks one of the choices below.',
        },
        { key: 'price', label: 'Price (for checkbox / quantity)', placeholder: '25 or 25.50' },
        {
          key: 'choices_text',
          label: 'Choices (select only — one per line: Label | price)',
          kind: 'textarea',
          placeholder: 'Small | 0\nLarge | 50',
        },
        { key: 'sort_order', label: 'Sort order' },
        { key: 'status', label: 'Status', kind: 'select', options: ['active', 'inactive'] },
      ];
    }
    if (type === 'qrcode') {
      // Batch 126: target pickers are built from the REAL site structure
      // (the list response's qrcode.targets — the site's actual pages and
      // its attached module landings), never free text. Only the fields
      // for the chosen target kind are used; the server validates.
      const qrTargets = (moduleState.qrcode && moduleState.qrcode.targets) || { pages: [], modules: [] };
      return [
        { key: 'name', label: 'Name', required: true, placeholder: 'e.g. Book a visit (table tent)' },
        {
          key: 'target_kind',
          label: 'What the code opens',
          kind: 'select',
          options: [
            { value: 'page', label: 'A page on this site' },
            { value: 'module', label: "Another module's page (bookings, menu, reviews…)" },
            { value: 'url', label: 'A web address (URL)' },
            { value: 'tel', label: 'A phone number (tap to call)' },
            { value: 'email', label: 'An email address' },
            { value: 'wifi', label: 'The WiFi network (guests join on scan)' },
          ],
          hint: 'Page and module codes are stored as references — if the page is renamed later, the printed code still lands in the right place.',
        },
        {
          key: 'target_page',
          label: 'Page (for “A page on this site”)',
          kind: 'select',
          options: (qrTargets.pages || []).map((p) => ({ value: p.slug, label: `${p.title || p.slug} (/${p.slug})` })),
        },
        {
          key: 'target_module',
          label: 'Module page (for “Another module’s page”)',
          kind: 'select',
          options: (qrTargets.modules || []).map((m) => ({
            value: m.type,
            label: `${m.label} (/${m.slug})${m.active ? '' : ' — not live yet'}`,
          })),
        },
        { key: 'target_value', label: 'URL / phone / email (for those kinds)', placeholder: 'https://… · +1 555 123 4567 · hello@example.com' },
        { key: 'wifi_ssid', label: 'WiFi network name (SSID)' },
        {
          key: 'wifi_password',
          label: 'WiFi password',
          hint: 'Stored as your own site config and only ever rendered inside the generated code image. Leave blank when editing to keep the current password.',
        },
        { key: 'wifi_auth', label: 'WiFi security', kind: 'select', options: ['WPA', 'WEP', 'nopass'] },
        { key: 'wifi_hidden', label: 'Hidden network', kind: 'select', options: [{ value: '0', label: 'No' }, { value: '1', label: 'Yes' }] },
        { key: 'size', label: 'Image size (px, for print)', placeholder: '512' },
        { key: 'fg_color', label: 'Code colour (#rrggbb)', placeholder: '#111111' },
        { key: 'bg_color', label: 'Background colour (#rrggbb)', placeholder: '#ffffff' },
        {
          key: 'ec_level',
          label: 'Error correction (higher = survives damage/print wear)',
          kind: 'select',
          options: [
            { value: 'L', label: 'L — low (~7%)' },
            { value: 'M', label: 'M — medium (~15%)' },
            { value: 'Q', label: 'Q — quartile (~25%)' },
            { value: 'H', label: 'H — high (~30%)' },
          ],
        },
        { key: 'sort_order', label: 'Sort order' },
        { key: 'status', label: 'Status', kind: 'select', options: ['draft', 'published'] },
      ];
    }
    // directory fallback
    return [
      { key: 'name', label: 'Name', required: true },
      { key: 'category', label: 'Category' },
      { key: 'contact_email', label: 'Email' },
      { key: 'contact_phone', label: 'Phone' },
      { key: 'website_url', label: 'Website / link' },
      { key: 'image_url', label: 'Photo', kind: 'image' },
      { key: 'description', label: 'Description', kind: 'textarea' },
      { key: 'status', label: 'Status', kind: 'select', options: ['draft', 'published'] },
    ];
  }

  function renderModuleTypeTabs() {
    const box = document.getElementById('modules-type-tabs');
    if (!box) return;
    const byType = new Map(MODULE_TYPES.map((m) => [m.type, m]));
    const summaryList = (moduleState.summary && moduleState.summary.modules) || [];
    box.innerHTML = MODULE_NAV_GROUPS.map((group) => {
      const rows = group.types
        .map((type) => {
          const meta = byType.get(type);
          if (!meta) return '';
          const summary = summaryList.find((x) => x.type === type);
          // Batch 29: the server filters the summary to the modules in
          // this user's effective set — a type absent from the summary
          // is not rendered at all.
          if (summaryList.length && !summary) return '';
          const count = summary ? summary.count : 0;
          const emb = summary && summary.embed;
          const live = !!(emb && emb.published && emb.embed_enabled);
          const sel = type === moduleState.current;
          return `<button type="button" class="module-card${sel ? ' is-active' : ''}" data-module-type="${esc(type)}" role="tab" aria-selected="${sel ? 'true' : 'false'}">
          <span class="module-card-top">
            <span class="module-card-icon${moduleIconTint(type)}" aria-hidden="true">${moduleIconSvg(type)}</span>
            ${live ? '<span class="module-card-live"><span class="module-card-live-dot"></span>On site</span>' : ''}
          </span>
          <span class="module-card-name">${esc(meta.label)}</span>
          <span class="module-card-meta">${count} ${esc(moduleCopy(type).plural)}</span>
        </button>`;
        })
        .join('');
      if (!rows) return '';
      return `<div class="modules-side-group">${esc(group.label)}</div>${rows}`;
    }).join('');
  }

  function syncModulesPaneTabs() {
    const tabs = document.getElementById('modules-pane-tabs');
    const content = document.getElementById('modules-pane-content');
    const hoursPane = document.getElementById('modules-pane-hours');
    const apptsPane = document.getElementById('modules-pane-appointments');
    const chatSettingsPane = document.getElementById('modules-pane-chat-settings');
    const chatInboxPane = document.getElementById('modules-pane-chat-inbox');
    const estCalcPane = document.getElementById('modules-pane-estimate-calc');
    const estReqPane = document.getElementById('modules-pane-estimate-requests');
    const sfPane = document.getElementById('modules-pane-socialfeed');
    const grPane = document.getElementById('modules-pane-googlereviews');
    const ctPane = document.getElementById('modules-pane-calltracking');
    const membersPane = document.getElementById('modules-pane-members');
    const nlPane = document.getElementById('modules-pane-newsletter');
    const pcPane = document.getElementById('modules-pane-photocapture');
    const cmPane = document.getElementById('modules-pane-comments');
    const results = document.getElementById('modules-pane-results');
    const bookingPanel = document.getElementById('modules-booking-panel');
    const isBookings = moduleState.current === 'bookings';
    const isChatbot = moduleState.current === 'chatbot';
    const isEstimate = moduleState.current === 'estimate';
    const isSocialfeed = moduleState.current === 'socialfeed';
    const isGoogleReviews = moduleState.current === 'googlereviews';
    const isCallTracking = moduleState.current === 'calltracking';
    const isMembers = moduleState.current === 'members';
    const isNewsletter = moduleState.current === 'newsletter';
    const isPhotoCapture = moduleState.current === 'photocapture';
    const isComments = moduleState.current === 'comments';
    const showTabs = isBookings || isChatbot || isEstimate || isSocialfeed || isGoogleReviews || isCallTracking || isMembers || isNewsletter || isPhotoCapture || isComments;
    if (isBookings) {
      const allowed = new Set(['content', 'hours', 'appointments']);
      if (!allowed.has(moduleState.pane)) moduleState.pane = 'content';
    } else if (isChatbot) {
      const allowed = new Set(['content', 'settings', 'inbox']);
      if (!allowed.has(moduleState.pane)) moduleState.pane = 'content';
    } else if (isEstimate) {
      const allowed = new Set(['content', 'calc', 'requests']);
      if (!allowed.has(moduleState.pane)) moduleState.pane = 'content';
    } else if (isSocialfeed) {
      // The feed has no item list — its only pane is the Feed pane.
      moduleState.pane = 'feed';
    } else if (isGoogleReviews) {
      // Google Reviews has no item list — its only pane is Reviews.
      moduleState.pane = 'reviews';
    } else if (isCallTracking) {
      // Call Tracking has no item list either — its only pane is Calls.
      moduleState.pane = 'calls';
    } else if (isMembers) {
      // Membership has no item list either — its only pane is Members.
      moduleState.pane = 'members';
    } else if (isNewsletter) {
      // Newsletter has no item list either — its only pane is Newsletter.
      moduleState.pane = 'newsletter';
    } else if (isPhotoCapture) {
      // Photo Capture has no item list either — its only pane is Photos
      // (config + the moderation inbox).
      moduleState.pane = 'photocapture';
    } else if (isComments) {
      // Comments has no item list either — its only pane is Comments
      // (settings + the moderation queue).
      moduleState.pane = 'comments';
    } else {
      moduleState.pane = 'content';
    }
    if (tabs) {
      tabs.hidden = !showTabs;
      tabs.setAttribute('aria-hidden', showTabs ? 'false' : 'true');
      tabs.setAttribute(
        'aria-label',
        isChatbot
          ? 'Chatbot sections'
          : isEstimate
            ? 'Estimate sections'
            : isSocialfeed
              ? 'Social Feed sections'
              : isGoogleReviews
                ? 'Google Reviews sections'
              : isCallTracking
                ? 'Call Tracking sections'
                : isMembers
                  ? 'Membership sections'
                  : isNewsletter
                    ? 'Newsletter sections'
                    : isPhotoCapture
                      ? 'Photo Capture sections'
                    : isComments
                      ? 'Comments sections'
                      : 'Bookings sections'
      );
      tabs.querySelectorAll('[data-modules-pane]').forEach((btn) => {
        const pane = btn.getAttribute('data-modules-pane');
        const forBookings = ['content', 'hours', 'appointments'].includes(pane);
        const forChat = ['content', 'settings', 'inbox'].includes(pane);
        const forEstimate = ['content', 'calc', 'requests'].includes(pane);
        const visible = isBookings ? forBookings : isChatbot ? forChat : isEstimate ? forEstimate : false;
        // Toggle per-module tab buttons via data-for attribute when present.
        const forAttr = btn.getAttribute('data-for');
        const showBtn = forAttr
          ? (isBookings && forAttr === 'bookings') ||
            (isChatbot && forAttr === 'chatbot') ||
            (isEstimate && forAttr === 'estimate') ||
            (isSocialfeed && forAttr === 'socialfeed') ||
            (isGoogleReviews && forAttr === 'googlereviews') ||
            (isCallTracking && forAttr === 'calltracking') ||
            (isMembers && forAttr === 'members') ||
            (isNewsletter && forAttr === 'newsletter') ||
            (isPhotoCapture && forAttr === 'photocapture') ||
            (isComments && forAttr === 'comments') ||
            (forAttr === 'both' && showTabs && !isSocialfeed && !isGoogleReviews && !isCallTracking && !isMembers && !isNewsletter && !isPhotoCapture && !isComments)
          : visible;
        btn.hidden = !showBtn;
        if (pane === 'content' && showBtn) {
          btn.textContent = isChatbot ? 'Knowledge' : isEstimate ? 'Options' : 'Services';
        }
        const on = pane === moduleState.pane && showBtn;
        btn.classList.toggle('is-active', on);
        btn.setAttribute('aria-selected', on ? 'true' : 'false');
      });
    }
    if (content) {
      content.hidden = showTabs && moduleState.pane !== 'content';
    }
    if (hoursPane) hoursPane.hidden = !(isBookings && moduleState.pane === 'hours');
    if (apptsPane) apptsPane.hidden = !(isBookings && moduleState.pane === 'appointments');
    if (chatSettingsPane) chatSettingsPane.hidden = !(isChatbot && moduleState.pane === 'settings');
    if (chatInboxPane) chatInboxPane.hidden = !(isChatbot && moduleState.pane === 'inbox');
    if (estCalcPane) estCalcPane.hidden = !(isEstimate && moduleState.pane === 'calc');
    if (estReqPane) estReqPane.hidden = !(isEstimate && moduleState.pane === 'requests');
    if (sfPane) sfPane.hidden = !(isSocialfeed && moduleState.pane === 'feed');
    if (grPane) grPane.hidden = !(isGoogleReviews && moduleState.pane === 'reviews');
    if (ctPane) ctPane.hidden = !(isCallTracking && moduleState.pane === 'calls');
    if (membersPane) membersPane.hidden = !(isMembers && moduleState.pane === 'members');
    if (nlPane) nlPane.hidden = !(isNewsletter && moduleState.pane === 'newsletter');
    if (pcPane) pcPane.hidden = !(isPhotoCapture && moduleState.pane === 'photocapture');
    if (cmPane) cmPane.hidden = !(isComments && moduleState.pane === 'comments');
    if (results) results.hidden = true;
    if (bookingPanel) bookingPanel.hidden = true;
    if (isChatbot && moduleState.pane === 'settings') renderChatbotSettingsPanel();
    if (isChatbot && moduleState.pane === 'inbox') renderChatbotInboxPanel();
  }

  function setFormsPane(pane) {
    formsPane = pane === 'results' ? 'results' : 'setup';
    const setup = document.getElementById('forms-pane-setup');
    const results = document.getElementById('forms-pane-results');
    const tabs = document.getElementById('forms-pane-tabs');
    if (setup) setup.hidden = formsPane !== 'setup';
    if (results) results.hidden = formsPane !== 'results';
    if (tabs) {
      tabs.querySelectorAll('[data-forms-pane]').forEach((btn) => {
        const on = btn.getAttribute('data-forms-pane') === formsPane;
        btn.classList.toggle('is-active', on);
        btn.setAttribute('aria-selected', on ? 'true' : 'false');
      });
    }
  }

  function updateModuleContentChrome() {
    const copy = moduleCopy(moduleState.current);
    const meta = MODULE_TYPES.find((m) => m.type === moduleState.current);
    const sub = document.getElementById('modules-items-sub');
    if (sub) {
      sub.textContent =
        moduleState.current === 'faq'
          ? 'Manage questions for your FAQ module. These are separate from your site’s designed FAQ section, which is edited under Website.'
          : moduleState.current === 'socialfeed'
            ? 'Your feed updates itself from your social posts — there is nothing to add by hand.'
            : moduleState.current === 'googlereviews'
              ? 'Your Google reviews pull in automatically — set your Place ID once and BitPype keeps them fresh.'
            : moduleState.current === 'members'
              ? 'Members join from your site — use the Members tab to choose what they can see and manage their accounts.'
              : moduleState.current === 'calltracking'
                ? 'The number you set here is the one your site shows — calls to it ring your real phone and are logged below.'
              : moduleState.current === 'datatables'
                ? 'One table of your data — prices, listings, schedules, anything — shown on your site as a table, card wall, results list or simple list. Visitors can submit rows if you turn submissions on.'
              : moduleState.current === 'charts'
                ? 'Charts drawn from your Data Table or from numbers you type in — bar, line, pie and more. A chart bound to the table updates itself whenever the table changes.'
              : moduleState.current === 'newsletter'
                ? 'Your newsletter — subscribers join from the signup block on your site. Compose an issue, preview it, then send it to everyone on the list.'
              : moduleState.current === 'photocapture'
                ? 'Visitors send you photos from your site — review them here. Nothing is shown publicly until you approve it, and approved photos can be added to a gallery album.'
              : moduleState.current === 'checkout'
                ? 'One checkout for everything you sell — shop products and priced gallery photos are charged here, through your own Stripe.'
              : moduleState.current === 'comments'
                ? 'Comments and likes on your posts, products and pages — review them here. Nothing is shown publicly until you approve it (unless you turn moderation off).'
              : `Manage ${copy.plural} for your ${(meta && meta.label) || 'module'}.`;
    }
    const newBtn = document.getElementById('btn-modules-new');
    if (newBtn) newBtn.textContent = copy.newBtn;
  }

  function fillModulePageSelect(pages, selected) {
    const sel = document.getElementById('modules-target-page');
    if (!sel) return;
    const defaults = {
      blog: 'blog',
      ecommerce: 'shop',
      courses: 'courses',
      gallery: 'gallery',
      directory: 'directory',
      faq: 'faq',
      testimonials: 'testimonials',
      team: 'team',
      events: 'events',
      bookings: 'book',
      offers: 'offers',
      menu: 'menu',
      careers: 'careers',
      video: 'videos',
      estimate: 'estimate',
      socialfeed: 'social-feed',
      googlereviews: 'reviews',
      calltracking: 'call',
      members: 'members',
      datatables: 'data-table',
      charts: 'charts',
      newsletter: 'newsletter',
      categories: 'categories',
    };
    let want = selected || defaults[moduleState.current] || 'home';
    const opts = Array.isArray(pages) && pages.length ? pages : [{ slug: want, title: want }];
    const slugs = new Set(opts.map((p) => p.slug));
    // FAQ module: prefer the site's FAQ page as the default target unless the
    // module is already live on a page (a stored target from setup may say Contact).
    const emb = moduleState.embed;
    const faqOnSite = !!(emb && emb.published && emb.embed_enabled);
    if (moduleState.current === 'faq' && !faqOnSite && slugs.has('faq')) want = 'faq';
    if (!slugs.has(want)) opts.unshift({ slug: want, title: want });
    sel.innerHTML = opts
      .map(
        (p) => `<option value="${esc(p.slug)}"${p.slug === want ? ' selected' : ''}>${esc(p.title || p.slug)}</option>`
      )
      .join('');
  }

  function renderModuleEmbedBar() {
    const label = document.getElementById('modules-current-label');
    const status = document.getElementById('modules-embed-status');
    const urlEl = document.getElementById('modules-embed-url');
    const bar = document.getElementById('modules-embed-bar');
    const meta = MODULE_TYPES.find((m) => m.type === moduleState.current);
    if (label) label.textContent = meta ? meta.label : moduleState.current;
    const emb = moduleState.embed;
    const onSite = !!(emb && emb.published && emb.embed_enabled);
    if (bar) bar.classList.toggle('is-on-site', onSite);
    const pageLabel = document.querySelector('#modules-embed-bar label.hint');
    const isChatbot = moduleState.current === 'chatbot';
    if (pageLabel) pageLabel.hidden = isChatbot;
    const attachBtn = document.getElementById('btn-modules-attach');
    const detachBtn = document.getElementById('btn-modules-detach');
    if (attachBtn) attachBtn.hidden = onSite;
    if (detachBtn) detachBtn.hidden = !onSite;
    // Batch 66 — per-record module delete (purge). Owners only (the
    // route enforces it too); visible whenever the module is installed
    // for this business, even while detached, since delete also
    // clears content a detach left behind.
    const deleteBtn = document.getElementById('btn-modules-purge');
    if (deleteBtn) {
      const isOwner = !!(state.client && state.client.userType === 'owner');
      deleteBtn.hidden = !(emb && isOwner);
    }
    if (status) {
      if (isChatbot) {
        status.innerHTML = onSite
          ? '<span class="status-pill">Live</span> Floating chat bubble on all published pages. Your AI assistant answers visitors from your knowledge items.'
          : 'Not on your site yet — click <strong>Add to site</strong> to place the chat bubble on every page.';
      } else {
        status.innerHTML = onSite
          ? `<span class="status-pill">Live</span> Showing on page “${esc(emb.target_page_slug || '—')}”`
          : 'Not on your site yet — pick a page and click <strong>Add to site</strong>.';
      }
    }
    if (urlEl) {
      urlEl.innerHTML =
        emb && emb.embed_url
          ? `<details class="modules-embed-details"><summary>Embed link (for custom pages)</summary><code>${esc(emb.embed_url)}</code></details>`
          : '';
    }
    fillModulePageSelect(moduleState.pages, emb && emb.target_page_slug);
    updateModuleContentChrome();
  }

  // Batch 137 — qualifying-question list editor (owner's own words;
  // the array on moduleState mirrors the DOM inputs, which are the
  // source of truth at save time).
  function syncChatQualifyingFromDom() {
    const inputs = document.querySelectorAll('#chat-qualifying-rows input[data-qual-q]');
    if (inputs.length) moduleState.chatQualifying = Array.from(inputs).map((i) => i.value);
  }

  function renderChatQualifyingRows() {
    const host = document.getElementById('chat-qualifying-rows');
    if (!host) return;
    const list = Array.isArray(moduleState.chatQualifying) ? moduleState.chatQualifying : [];
    host.innerHTML = list.length
      ? list
          .map(
            (q, i) => `
        <div class="row" style="gap:6px;align-items:center;margin:6px 0;flex-wrap:nowrap">
          <span class="hint" style="min-width:18px">${i + 1}.</span>
          <input type="text" data-qual-q="${i}" maxlength="200" value="${esc(q)}" placeholder="Type your question exactly as the chat should ask it" style="flex:1" />
          <button type="button" class="btn ghost small" data-qual-move="-1" data-qual-idx="${i}" ${i === 0 ? 'disabled' : ''} title="Move up">↑</button>
          <button type="button" class="btn ghost small" data-qual-move="1" data-qual-idx="${i}" ${i === list.length - 1 ? 'disabled' : ''} title="Move down">↓</button>
          <button type="button" class="btn ghost small" data-qual-del="${i}" title="Remove question">✕</button>
        </div>`
          )
          .join('')
      : '<p class="hint">No questions yet — add your first one below.</p>';
    host.querySelectorAll('[data-qual-del]').forEach((btn) => {
      btn.onclick = () => {
        syncChatQualifyingFromDom();
        moduleState.chatQualifying.splice(Number(btn.getAttribute('data-qual-del')), 1);
        renderChatQualifyingRows();
      };
    });
    host.querySelectorAll('[data-qual-move]').forEach((btn) => {
      btn.onclick = () => {
        syncChatQualifyingFromDom();
        const idx = Number(btn.getAttribute('data-qual-idx'));
        const to = idx + Number(btn.getAttribute('data-qual-move'));
        const arr = moduleState.chatQualifying;
        if (to < 0 || to >= arr.length) return;
        const tmp = arr[idx];
        arr[idx] = arr[to];
        arr[to] = tmp;
        renderChatQualifyingRows();
      };
    });
    const addBtn = document.getElementById('btn-chat-qualifying-add');
    if (addBtn) addBtn.disabled = list.length >= 6;
  }

  // Batch 151 — Knowledge sources panel: three groups (Modules /
  // Pages / Knowledge base) rendered from the portal summary's
  // knowledge_sources list (owner-facing only; these toggles never
  // reach the public widget config). Absent config = everything on.
  function knowledgeSourcesHtml(ks) {
    const data = ks && typeof ks === 'object' ? ks : { groups: {}, modules: [], pages: [], knowledge: [] };
    const groups = data.groups || {};
    const row = (attr, key, label, sub, enabled) => `
      <label class="hint" style="display:flex;align-items:center;gap:8px;margin:4px 0 4px 22px">
        <input type="checkbox" data-${attr}="${esc(key)}" ${enabled ? 'checked' : ''} />
        <span>${esc(label)}${sub ? ` <span style="opacity:.75">${esc(sub)}</span>` : ''}</span>
      </label>`;
    const groupHead = (group, label) => `
      <label class="hint" style="display:flex;align-items:center;gap:8px;margin:10px 0 2px;font-weight:600">
        <input type="checkbox" data-ks-group="${group}" ${groups[group] !== false ? 'checked' : ''} />
        ${label}
      </label>`;
    const mods = Array.isArray(data.modules) ? data.modules : [];
    const pages = Array.isArray(data.pages) ? data.pages : [];
    const docs = Array.isArray(data.knowledge) ? data.knowledge : [];
    return `
      ${groupHead('modules', 'Modules')}
      ${mods.length ? mods.map((m) => row('ks-module', m.type, m.label || m.type, m.count ? `${m.count} item${m.count === 1 ? '' : 's'}` : 'no items yet', m.enabled !== false)).join('') : '<p class="hint" style="margin-left:22px">No answer modules on your site yet.</p>'}
      ${groupHead('pages', 'Pages')}
      ${pages.length ? pages.map((p) => row('ks-page', p.slug, p.title || p.slug, `/${p.slug}`, p.enabled !== false)).join('') : '<p class="hint" style="margin-left:22px">No pages yet.</p>'}
      ${groupHead('knowledge', 'Knowledge base')}
      ${docs.length ? docs.map((d) => row('ks-doc', String(d.id), d.title || 'Untitled', d.status && d.status !== 'active' ? d.status : '', d.enabled !== false)).join('') : '<p class="hint" style="margin-left:22px">No knowledge items yet — add them in the Knowledge tab.</p>'}`;
  }

  function collectKnowledgeSourcesFromDom() {
    const groups = {};
    document.querySelectorAll('#chat-knowledge-sources input[data-ks-group]').forEach((el) => {
      groups[el.getAttribute('data-ks-group')] = el.checked;
    });
    const modulesMap = {};
    document.querySelectorAll('#chat-knowledge-sources input[data-ks-module]').forEach((el) => {
      modulesMap[el.getAttribute('data-ks-module')] = el.checked;
    });
    const pagesMap = {};
    document.querySelectorAll('#chat-knowledge-sources input[data-ks-page]').forEach((el) => {
      pagesMap[el.getAttribute('data-ks-page')] = el.checked;
    });
    const docsMap = {};
    document.querySelectorAll('#chat-knowledge-sources input[data-ks-doc]').forEach((el) => {
      docsMap[el.getAttribute('data-ks-doc')] = el.checked;
    });
    return { groups, modules: modulesMap, pages: pagesMap, knowledge: docsMap };
  }

  // After a save, re-derive the panel list's enabled flags from the
  // settings the server returned (absent entry = on), so a re-render
  // without a refetch still shows the saved state.
  function applyKnowledgeSourcesConfig(config) {
    const ks = moduleState.chatbot && moduleState.chatbot.knowledge_sources;
    if (!ks) return;
    const cfg = config && typeof config === 'object' ? config : null;
    const groups = (cfg && cfg.groups) || {};
    const on = (map, key, group) =>
      groups[group] === false ? false : !map || map[key] == null ? true : !!map[key];
    ks.groups = {
      modules: groups.modules !== false,
      pages: groups.pages !== false,
      knowledge: groups.knowledge !== false,
    };
    (ks.modules || []).forEach((m) => {
      m.enabled = on(cfg && cfg.modules, m.type, 'modules');
    });
    (ks.pages || []).forEach((p) => {
      p.enabled = on(cfg && cfg.pages, p.slug, 'pages');
    });
    (ks.knowledge || []).forEach((d) => {
      d.enabled = on(cfg && cfg.knowledge, String(d.id), 'knowledge');
    });
  }

  function renderChatbotSettingsPanel() {
    const host = document.getElementById('modules-chat-settings-panel');
    if (!host) return;
    const chat = moduleState.chatbot || {};
    const s = chat.settings || {};
    const boundary = chat.agent_boundary || {};
    // Batch 138: voice agent controls (list mirrors chatbot.REALTIME_VOICES).
    const voiceNames = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar'];
    const voiceOptions = voiceNames
      .map((v) => `<option value="${v}"${(s.voice_name || 'marin') === v ? ' selected' : ''}>${v}</option>`)
      .join('');
    const hasVoiceImg = !!s.voice_bubble_image;
    host.innerHTML = `
      <div class="row" style="justify-content:flex-start;margin-bottom:12px">
        <button type="button" class="btn ghost small" id="btn-chat-settings-back">← Knowledge</button>
      </div>
      <h3>Chatbot settings</h3>
      <p class="hint">Your chatbot answers visitors from your knowledge items. Questions it can’t answer are saved to the Inbox tab so you can follow up — nothing is missed.</p>
      <div class="field"><label>Greeting</label><input id="chat-set-greeting" type="text" value="${esc(s.greeting || '')}" /></div>
      <div class="field"><label>Bubble label</label><input id="chat-set-label" type="text" value="${esc(s.bubble_label || 'Chat')}" /></div>
      <div class="field"><label>Accent color (optional #hex)</label><input id="chat-set-color" type="text" value="${esc(s.primary_color || '')}" placeholder="#0e7a68" /></div>
      <div class="field"><label>Position</label>
        <select id="chat-set-position">
          <option value="bottom-right"${s.position !== 'bottom-left' ? ' selected' : ''}>Bottom right</option>
          <option value="bottom-left"${s.position === 'bottom-left' ? ' selected' : ''}>Bottom left</option>
        </select>
      </div>
      <div class="field"><label>Escalate notify email (optional)</label><input id="chat-set-email" type="email" value="${esc(s.escalate_email || '')}" /></div>
      <label class="hint" style="display:flex;align-items:center;gap:8px;margin:8px 0">
        <input type="checkbox" id="chat-set-portal" ${s.escalate_notify_portal !== false ? 'checked' : ''} />
        Show escalations in portal inbox
      </label>
      <label class="hint" style="display:flex;align-items:center;gap:8px;margin:8px 0">
        <input type="checkbox" id="chat-set-lead" ${s.suggest_lead_capture !== false ? 'checked' : ''} />
        Suggest lead capture when agent is unsure / slow
      </label>
      <div class="field"><label>Wait hint (seconds)</label><input id="chat-set-timeout" type="number" min="15" max="600" value="${esc(s.agent_timeout_hint_sec != null ? s.agent_timeout_hint_sec : 90)}" /></div>
      <h4 style="margin:18px 0 6px">Qualifying questions</h4>
      <p class="hint">Write a few questions your chat should ask visitors to understand what they need. The chat asks YOUR questions word for word, woven into the conversation one at a time — never as a form — and the answers show up in the Inbox tab. A visitor can always skip a question, and skipping never blocks them from getting help or booking.</p>
      <p class="hint"><em>Examples only, to adapt or ignore:</em> “Is this for your home or a rental property?” · “When are you hoping to have this done?” · “Is this a new problem, or has it happened before?”</p>
      <label class="hint" style="display:flex;align-items:center;gap:8px;margin:8px 0">
        <input type="checkbox" id="chat-set-qualifying-enabled" ${s.qualifying_enabled ? 'checked' : ''} />
        Ask my qualifying questions in the chat
      </label>
      ${s.qualifying_questions_source === 'industry_default' ? `<p class="hint" id="chat-qualifying-provenance">Industry defaults for ${esc(s.qualifying_industry || 'your industry')} — these are the five questions your chat and voice agent will ask until you edit them.</p>` : ''}
      <div id="chat-qualifying-rows"></div>
      <button type="button" class="btn soft small" id="btn-chat-qualifying-add">+ Add a question</button>
      <p class="hint">Up to 6 questions, 200 characters each. Use the arrows to change the order — the chat works through them in this order.</p>
      <h4 style="margin:18px 0 6px">Knowledge sources</h4>
      <p class="hint">Choose what your chat and voice assistant may answer from. Everything starts switched on — your modules, your pages and your knowledge items. Switch a source off and the assistant stops using it on BOTH the chat and the voice agent; switch a whole group off to pause that kind of source entirely.</p>
      <div id="chat-knowledge-sources">${knowledgeSourcesHtml(chat.knowledge_sources)}</div>
      <h4 style="margin:18px 0 6px">AI voice agent</h4>
      <p class="hint">Visitors can talk instead of typing — same knowledge and lead capture as this chat, powered by OpenAI Realtime. Every voice conversation is saved to the Inbox as a transcript. No audio is recorded.</p>
      <label class="hint" style="display:flex;align-items:center;gap:8px;margin:8px 0">
        <input type="checkbox" id="chat-set-voice-enabled" ${s.voice_enabled ? 'checked' : ''} />
        Show the voice bubble on my site
      </label>
      <div class="field"><label>Voice</label>
        <select id="chat-set-voice-name">${voiceOptions}</select>
      </div>
      <div class="field"><label>Bubble image (optional — shown on the voice bubble)</label>
        <div class="row" style="justify-content:flex-start;gap:10px;align-items:center;flex-wrap:wrap">
          ${
            hasVoiceImg
              ? '<img src="/api/v1/portal/modules/chatbot/voice-image" alt="Voice bubble" style="width:52px;height:52px;border-radius:50%;object-fit:cover;border:1px solid var(--line,#e6e0d8)" />'
              : '<span class="hint">No image — the bubble shows a microphone icon.</span>'
          }
          <input type="file" id="chat-voice-image-file" accept="image/png,image/jpeg,image/webp,image/gif" />
          ${hasVoiceImg ? '<button type="button" class="btn soft small" id="btn-chat-voice-image-remove">Remove</button>' : ''}
        </div>
        <p class="msg" id="msg-chat-voice-image"></p>
      </div>
      <button type="button" class="btn" id="btn-chat-settings-save">Save chatbot settings</button>
      <p class="msg" id="msg-chat-settings"></p>`;
    const backBtn = document.getElementById('btn-chat-settings-back');
    if (backBtn) {
      backBtn.onclick = () => {
        moduleState.pane = 'content';
        syncModulesPaneTabs();
      };
    }
    moduleState.chatQualifying = Array.isArray(s.qualifying_questions) ? s.qualifying_questions.slice(0, 6) : [];
    renderChatQualifyingRows();
    const qualAdd = document.getElementById('btn-chat-qualifying-add');
    if (qualAdd) {
      qualAdd.onclick = () => {
        syncChatQualifyingFromDom();
        if (moduleState.chatQualifying.length >= 6) return;
        moduleState.chatQualifying.push('');
        renderChatQualifyingRows();
        const inputs = document.querySelectorAll('#chat-qualifying-rows input[data-qual-q]');
        const last = inputs[inputs.length - 1];
        if (last) last.focus();
      };
    }
    const btn = document.getElementById('btn-chat-settings-save');
    if (btn) {
      btn.onclick = async () => {
        const msg = document.getElementById('msg-chat-settings');
        const qualInputs = Array.from(document.querySelectorAll('#chat-qualifying-rows input[data-qual-q]'));
        if (qualInputs.some((i) => !i.value.trim())) {
          if (msg) {
            msg.className = 'msg err';
            msg.textContent = 'A qualifying question is blank — fill it in or remove it before saving.';
          }
          return;
        }
        try {
          const data = await api('/modules/chatbot/settings', {
            method: 'PUT',
            body: JSON.stringify({
              greeting: document.getElementById('chat-set-greeting').value,
              bubble_label: document.getElementById('chat-set-label').value,
              primary_color: document.getElementById('chat-set-color').value,
              position: document.getElementById('chat-set-position').value,
              escalate_email: document.getElementById('chat-set-email').value,
              escalate_notify_portal: document.getElementById('chat-set-portal').checked,
              suggest_lead_capture: document.getElementById('chat-set-lead').checked,
              agent_timeout_hint_sec: Number(document.getElementById('chat-set-timeout').value) || 90,
              qualifying_enabled: document.getElementById('chat-set-qualifying-enabled').checked,
              qualifying_questions: qualInputs.map((i) => i.value.trim()),
              knowledge_sources: collectKnowledgeSourcesFromDom(),
              voice_enabled: document.getElementById('chat-set-voice-enabled').checked,
              voice_name: document.getElementById('chat-set-voice-name').value,
            }),
          });
          moduleState.chatbot = Object.assign({}, moduleState.chatbot || {}, { settings: data.settings });
          if (data.settings) applyKnowledgeSourcesConfig(data.settings.knowledge_sources);
          if (data.settings && Array.isArray(data.settings.qualifying_questions)) {
            moduleState.chatQualifying = data.settings.qualifying_questions.slice(0, 6);
            renderChatQualifyingRows();
          }
          if (msg) {
            msg.className = 'msg ok';
            msg.textContent = 'Saved.';
          }
        } catch (e) {
          if (msg) {
            msg.className = 'msg err';
            msg.textContent = errText(e);
          }
        }
      };
    }
    // Batch 138: bubble image upload/remove (validated server-side —
    // PNG/JPG/WebP/GIF by magic bytes, 10 MB cap, no SVG).
    const imgFile = document.getElementById('chat-voice-image-file');
    if (imgFile) {
      imgFile.onchange = async () => {
        const msg = document.getElementById('msg-chat-voice-image');
        const file = imgFile.files && imgFile.files[0];
        if (!file) return;
        try {
          const prepared = await fileToBase64Raw(file);
          const data = await api('/modules/chatbot/voice-image', {
            method: 'POST',
            body: JSON.stringify(prepared),
          });
          moduleState.chatbot = Object.assign({}, moduleState.chatbot || {}, { settings: data.settings });
          renderChatbotSettingsPanel();
          const done = document.getElementById('msg-chat-voice-image');
          if (done) {
            done.className = 'msg ok';
            done.textContent = 'Bubble image saved.';
          }
        } catch (e) {
          if (msg) {
            msg.className = 'msg err';
            msg.textContent = errText(e);
          }
        }
      };
    }
    const imgRemove = document.getElementById('btn-chat-voice-image-remove');
    if (imgRemove) {
      imgRemove.onclick = async () => {
        const msg = document.getElementById('msg-chat-voice-image');
        try {
          const data = await api('/modules/chatbot/voice-image', { method: 'DELETE' });
          moduleState.chatbot = Object.assign({}, moduleState.chatbot || {}, { settings: data.settings });
          renderChatbotSettingsPanel();
        } catch (e) {
          if (msg) {
            msg.className = 'msg err';
            msg.textContent = errText(e);
          }
        }
      };
    }
  }

  // Batch 137 — compact Q&A block for a session's qualifying
  // record (owner-facing; descriptive status words only).
  function qualBlockHtml(q) {
    if (!q || !Array.isArray(q.items) || !q.items.length) return '';
    const labels = {
      answered: 'Answered',
      answered_from_conversation: 'Visitor mentioned it themselves',
      asked: 'Asked — no answer yet',
      declined: 'Visitor passed on this one',
      pending: 'Not asked yet',
    };
    const rows = q.items
      .map(
        (it) => `
      <div style="margin:4px 0">
        <div><strong>Q:</strong> ${esc(it.question || '')}</div>
        <div class="hint"><strong>A:</strong> ${esc(it.answer || '—')} · ${esc(labels[it.status] || it.status || '')}</div>
      </div>`
      )
      .join('');
    return `<div style="margin:6px 0;padding:8px 10px;border:1px solid var(--line,#e6e0d8);border-radius:8px">
      <div class="hint" style="font-weight:600">Qualifying questions</div>${rows}</div>`;
  }

  function renderChatbotInboxPanel() {
    const host = document.getElementById('modules-chat-inbox-panel');
    if (!host) return;
    const chat = moduleState.chatbot || {};
    const escalations = Array.isArray(chat.escalations) ? chat.escalations : [];
    const leads = Array.isArray(chat.leads) ? chat.leads : [];
    const qualSessions = Array.isArray(chat.qualification_sessions) ? chat.qualification_sessions : [];
    const escHtml = escalations.length
      ? escalations
          .map(
            (e) => `
        <div class="row" style="justify-content:space-between;gap:8px;padding:8px 0;border-bottom:1px solid var(--line,#e6e0d8);flex-wrap:wrap">
          <div>
            <strong>${esc(e.reason || 'escalation')}</strong>
            <div class="hint">${esc(errText(e))}</div>
            <div class="hint">${esc(e.created_at || '')}</div>
            ${qualBlockHtml(e.qualification)}
          </div>
          <button type="button" class="btn soft small" data-chat-resolve="${e.id}">Resolve</button>
        </div>`
          )
          .join('')
      : '<p class="hint">No open escalations.</p>';
    const leadHtml = leads.length
      ? leads
          .map(
            (l) => `
        <div class="row" style="padding:8px 0;border-bottom:1px solid var(--line,#e6e0d8)">
          <div>
            <strong>${esc(l.name || 'Visitor')}</strong>
            <span class="hint"> · ${esc([l.email, l.phone].filter(Boolean).join(' · '))}</span>
            <div class="hint">${esc(l.message || '')}</div>
            ${qualBlockHtml(l.qualification)}
          </div>
        </div>`
          )
          .join('')
      : '<p class="hint">No chatbot leads yet.</p>';
    const qualHtml = qualSessions.length
      ? qualSessions
          .map(
            (s) => `
        <div style="padding:8px 0;border-bottom:1px solid var(--line,#e6e0d8)">
          <div><strong>Chat #${esc(String(s.id))}</strong> <span class="hint">${esc(s.created_at || '')} · ${esc(s.status || '')}</span></div>
          ${qualBlockHtml(s.qualification)}
        </div>`
          )
          .join('')
      : '';
    // Batch 138: voice conversations live in the same inbox — full
    // transcripts are saved on each session; duration + how the call
    // ended ride along here.
    const voiceSessions =
      chat.voice && Array.isArray(chat.voice.recent_sessions) ? chat.voice.recent_sessions : [];
    const voiceHtml = voiceSessions.length
      ? voiceSessions
          .map((vs) => {
            const v = vs.voice || {};
            const dur =
              v.duration_sec != null
                ? `${Math.floor(Number(v.duration_sec) / 60)}:${String(Number(v.duration_sec) % 60).padStart(2, '0')}`
                : '—';
            const ended =
              v.close_state === 'capped'
                ? 'hit the time limit'
                : v.close_state === 'abrupt'
                  ? 'ended abruptly'
                  : v.close_state === 'clean'
                    ? 'ended'
                    : 'in progress';
            return `
        <div class="row" style="padding:8px 0;border-bottom:1px solid var(--line,#e6e0d8)">
          <div>
            <strong>🎙 Voice conversation</strong>
            <span class="hint"> · ${esc(dur)} · ${esc(ended)}</span>
            <div class="hint">${esc(vs.created_at || '')} · transcript saved on the session</div>
          </div>
        </div>`;
          })
          .join('')
      : '<p class="hint">No voice conversations yet.</p>';
    host.innerHTML = `
      <div class="row" style="justify-content:flex-start;margin-bottom:12px">
        <button type="button" class="btn ghost small" id="btn-chat-inbox-back">← Knowledge</button>
      </div>
      <h3>Escalations &amp; leads</h3>
      <p class="hint">When the agent is unsure it escalates here. Lead capture from the chat widget also appears below.</p>
      <h4 style="margin:12px 0 6px">Open escalations (${esc(String(chat.open_escalations || escalations.length || 0))})</h4>
      ${escHtml}
      <h4 style="margin:16px 0 6px">Lead captures</h4>
      ${leadHtml}
      ${qualSessions.length ? `<h4 style="margin:16px 0 6px">Qualifying answers</h4>${qualHtml}` : ''}
      <h4 style="margin:16px 0 6px">Voice conversations</h4>
      ${voiceHtml}`;
    const backBtn = document.getElementById('btn-chat-inbox-back');
    if (backBtn) {
      backBtn.onclick = () => {
        moduleState.pane = 'content';
        syncModulesPaneTabs();
      };
    }
    host.querySelectorAll('[data-chat-resolve]').forEach((btn) => {
      btn.onclick = async () => {
        try {
          await api(`/modules/chatbot/escalations/${btn.getAttribute('data-chat-resolve')}/resolve`, {
            method: 'POST',
            body: '{}',
          });
          await loadModuleItems();
          renderChatbotInboxPanel();
        } catch (e) {
          moduleMsg(errText(e), false);
        }
      };
    });
  }

  function moduleItemTitle(it, type) {
    if (type === 'datatables') {
      const cols = ((moduleState.datatable || {}).columns) || [];
      const first = cols[0] && it[cols[0].key];
      return first ? String(first) : `#${it.id}`;
    }
    if (type === 'faq') return it.question || `#${it.id}`;
    if (type === 'testimonials') return it.author_name || it.name || it.title || `#${it.id}`;
    if (type === 'team') return it.name || it.title || `#${it.id}`;
    if (type === 'estimate') return it.label || `#${it.id}`;
    return it.title || it.name || `#${it.id}`;
  }

  function moduleItemMeta(it, type) {
    const st = it.status || 'draft';
    const pill = st === 'published' ? 'status-pill' : 'status-pill draft';
    const bits = [`<span class="${pill}">${esc(st)}</span>`];
    if (type === 'ecommerce' && it.price_label) bits.push(`<span>${esc(it.price_label)}</span>`);
    if (type === 'courses') bits.push(`<span>${(it.lessons || []).length} lessons</span>`);
    if (type === 'gallery') bits.push(`<span>${(it.images || []).length} photos</span>`);
    if (type === 'directory' && it.category) bits.push(`<span>${esc(it.category)}</span>`);
    if (type === 'faq' && it.category) bits.push(`<span>${esc(it.category)}</span>`);
    if (type === 'testimonials') {
      const role = [it.author_title, it.author_company].filter(Boolean).join(', ');
      if (role) bits.push(`<span>${esc(role)}</span>`);
      else if (it.rating != null && it.rating !== '') bits.push(`<span>${esc(String(it.rating))}★</span>`);
    }
    if (type === 'team' && it.role_title) bits.push(`<span>${esc(it.role_title)}</span>`);
    if (type === 'events') bits.push(`<span>${esc(it.starts_at || it.location || '')}</span>`);
    if (type === 'bookings') {
      bits.push(`<span>${esc(it.duration_label || (it.duration_minutes ? `${it.duration_minutes} min` : ''))}</span>`);
    }
    if (type === 'chatbot') {
      bits.length = 0;
      const st = it.status || 'active';
      bits.push(`<span class="${st === 'active' ? 'status-pill' : 'status-pill draft'}">${esc(st)}</span>`);
      bits.push(`<span>${esc(it.kind || 'link')}</span>`);
      if (it.file_name) bits.push(`<span>${esc(it.file_name)}</span>`);
      else if (it.url) bits.push(`<span>${esc(it.url)}</span>`);
      if (it.has_file) bits.push('<span>file</span>');
      const chars = String(it.content_text || '').trim().length;
      if (chars) bits.push(`<span>${chars.toLocaleString()} chars indexed</span>`);
    }
    if (type === 'offers') {
      if (it.expired) bits.push('<span class="status-pill draft">Expired</span>');
      if (it.code) bits.push(`<span>Code: ${esc(it.code)}</span>`);
      if (it.expires_at) bits.push(`<span>Expires ${esc(it.expires_at)}</span>`);
    }
    if (type === 'pricing') {
      if (it.price_label) bits.push(`<span>${esc(it.price_label)}${it.unit_suffix ? ' ' + esc(it.unit_suffix) : ''}</span>`);
      if (it.origin === 'bookings') bits.push('<span>Linked: booking service</span>');
      else if (it.origin === 'ecommerce') bits.push(`<span>Linked: shop product${it.has_variants ? ' (per variant)' : ''}</span>`);
      else bits.push('<span>Standalone</span>');
      if (it.source_missing) bits.push('<span class="status-pill draft">Source deleted — unlink or remove</span>');
      if (it.featured) bits.push('<span>Featured</span>');
    }
    if (type === 'qrcode') {
      const kindLabel = { page: 'Site page', module: 'Module page', url: 'Web address', tel: 'Phone', email: 'Email', wifi: 'WiFi' }[it.target_kind] || it.target_kind;
      bits.push(`<span>${esc(kindLabel)}</span>`);
      if (it.resolved_url) bits.push(`<span>${esc(it.resolved_url)}</span>`);
      else if (it.target_kind === 'wifi') bits.push(`<span>${esc(it.wifi_ssid || '')}</span>`);
      else if (it.payload) bits.push(`<span>${esc(it.payload)}</span>`);
      else bits.push('<span class="status-pill draft">Target unavailable</span>');
    }
    if (type === 'menu') {
      if (it.category_name) bits.push(`<span>${esc(it.category_name)}</span>`);
      if (it.price_text) bits.push(`<span>${esc(it.price_text)}</span>`);
    }
    if (type === 'careers') {
      bits.length = 0;
      const st = it.status || (it.active ? 'active' : 'inactive');
      bits.push(`<span class="${st === 'active' ? 'status-pill' : 'status-pill draft'}">${esc(st)}</span>`);
      if (it.employment_type) bits.push(`<span>${esc(it.employment_type)}</span>`);
      if (it.location) bits.push(`<span>${esc(it.location)}</span>`);
      if (it.apply_mode) bits.push(`<span>Apply: ${esc(it.apply_mode)}</span>`);
    }
    if (type === 'video') {
      if (it.provider) bits.push(`<span>${esc(it.provider === 'youtube' ? 'YouTube' : it.provider === 'vimeo' ? 'Vimeo' : it.provider)}</span>`);
      if (it.url) bits.push(`<span>${esc(it.url)}</span>`);
    }
    if (type === 'charts') {
      bits.length = 0;
      bits.push(`<span class="status-pill">${esc(it.chart_type || 'bar')}</span>`);
      bits.push(`<span>${esc(it.source === 'table' ? 'from Data Table' : 'manual data')}</span>`);
      const pts = it.computed && Array.isArray(it.computed.labels) ? it.computed.labels.length : 0;
      bits.push(`<span>${pts} point${pts === 1 ? '' : 's'}</span>`);
    }
    if (type === 'datatables') {
      if (it.source === 'visitor') bits.push('<span>visitor submission</span>');
      const cols = ((moduleState.datatable || {}).columns) || [];
      let shown = 0;
      for (const col of cols) {
        if (shown >= 3) break;
        const v = it[col.key];
        if (v != null && String(v).trim() !== '') {
          bits.push(`<span>${esc(col.label || col.key)}: ${esc(String(v))}</span>`);
          shown += 1;
        }
      }
    }
    if (type === 'estimate') {
      bits.length = 0;
      const st = it.status || (it.active ? 'active' : 'inactive');
      bits.push(`<span class="${st === 'active' ? 'status-pill' : 'status-pill draft'}">${esc(st)}</span>`);
      bits.push(`<span>${esc(it.input_type || 'checkbox')}</span>`);
      if (it.input_type === 'select') {
        bits.push(`<span>${(it.choices || []).length} choices</span>`);
      } else if (it.price_label) {
        bits.push(`<span>${esc(it.price_label)}</span>`);
      }
    }
    return bits.join('<span class="sep">·</span>');
  }

  function renderModuleItems() {
    const box = document.getElementById('modules-items');
    if (!box) return;
    const items = moduleState.items || [];
    const type = moduleState.current;
    const copy = moduleCopy(type);
    const headNewBtn = document.getElementById('btn-modules-new');
    // Batch 128 — Checkout has no items of its own: it sells the
    // other modules' sellables and its truth is the orders below.
    if (type === 'checkout') {
      box.classList.remove('item-list');
      box.innerHTML = `<div class="modules-empty">
        <strong>One checkout for everything you sell</strong>
        <p class="hint">Attach Checkout to a page (a "Checkout" page works best). Your shop products and any gallery photos you price are added to one cart on your site and paid here, through your own Stripe. Orders land in the panels below.</p>
      </div>`;
      if (headNewBtn) headNewBtn.hidden = true;
      return;
    }
    if (!items.length) {
      box.classList.remove('item-list');
      box.innerHTML = `<div class="modules-empty">
        <strong>No ${esc(copy.plural)} yet</strong>
        <p class="hint">Create your first ${esc(copy.singular)} — you can publish it when you are ready.</p>
        <button type="button" class="btn soft" id="btn-modules-empty-new">${esc(copy.newBtn)}</button>
      </div>`;
      if (headNewBtn) headNewBtn.hidden = true;
      const emptyBtn = document.getElementById('btn-modules-empty-new');
      if (emptyBtn) emptyBtn.onclick = () => openModuleEditor(null);
      return;
    }
    if (headNewBtn) headNewBtn.hidden = false;
    box.classList.add('item-list');
    const kicker = copy.kicker;
    box.innerHTML = items
      .map((it) => {
        const title = moduleItemTitle(it, type);
        return `<article class="item-card">
        <span class="item-card-mark" aria-hidden="true"></span>
        <div class="item-card-main">
          <p class="item-card-kicker">${esc(kicker)}</p>
          <h3 class="item-card-title">${esc(title)}</h3>
          <div class="item-card-meta">${moduleItemMeta(it, type)}</div>
        </div>
        <div class="item-card-actions">
          ${type === 'datatables' && it.status === 'pending' ? `<button type="button" class="btn soft small" data-dt-approve="${it.id}">Approve</button>` : ''}
          ${type === 'qrcode' && it.payload ? `<a class="btn soft small" href="/api/v1/portal/modules/qrcode/${it.id}/download?format=png">PNG</a><a class="btn soft small" href="/api/v1/portal/modules/qrcode/${it.id}/download?format=svg">SVG</a>` : ''}
          <button type="button" class="btn soft small" data-module-edit="${it.id}">Edit</button>
        </div>
      </article>`;
      })
      .join('');
    // Batch 88 — pending visitor submissions get a one-click approve.
    if (type === 'datatables') {
      box.querySelectorAll('[data-dt-approve]').forEach((btn) => {
        btn.onclick = async () => {
          const id = btn.getAttribute('data-dt-approve');
          btn.disabled = true;
          try {
            await api(`/modules/datatables/${encodeURIComponent(id)}`, {
              method: 'PUT',
              body: JSON.stringify({ status: 'published' }),
            });
            moduleMsg('Submission approved — it is live on your site now.', true);
            await loadModuleItems();
          } catch (e) {
            btn.disabled = false;
            moduleMsg(errText(e), false);
          }
        };
      });
    }
    // Batch 45 — blog pager (server pages of 6; total comes from the API).
    if (type === 'blog' && moduleState.blogTotal != null) {
      const off = moduleState.blogOffset || 0;
      const total = moduleState.blogTotal;
      const pager = document.createElement('div');
      pager.className = 'pagination';
      pager.style.marginTop = '10px';
      pager.innerHTML = `<button type="button" class="btn small" data-blog-prev ${off <= 0 ? 'disabled' : ''}>← Newer</button> <span class="hint">${total ? off + 1 : 0}–${Math.min(off + items.length, total)} of ${total}</span> <button type="button" class="btn small" data-blog-next ${off + items.length >= total ? 'disabled' : ''}>Older →</button>`;
      box.appendChild(pager);
      const prev = pager.querySelector('[data-blog-prev]');
      const next = pager.querySelector('[data-blog-next]');
      if (prev) prev.onclick = () => pagerLoad('blogOffset', Math.max(0, off - 6));
      if (next) next.onclick = () => pagerLoad('blogOffset', off + 6);
    }
  }

  function renderBookingAdminPanel() {
    const hoursHost = document.getElementById('modules-booking-hours-panel');
    const apptsHost = document.getElementById('modules-booking-appts-panel');
    const legacy = document.getElementById('modules-booking-panel');
    if (legacy) {
      legacy.hidden = true;
      legacy.innerHTML = '';
    }
    if (!hoursHost && !apptsHost) return;
    if (moduleState.current !== 'bookings') {
      if (hoursHost) hoursHost.innerHTML = '';
      if (apptsHost) apptsHost.innerHTML = '';
      return;
    }
    const booking = moduleState.booking || {};
    const settings = booking.settings || {};
    const hours = Array.isArray(booking.hours) ? booking.hours : [];
    const appointments = Array.isArray(booking.appointments) ? booking.appointments : [];
    const byDay = {};
    hours.forEach((h) => {
      const d = Number(h.weekday);
      if (!byDay[d]) byDay[d] = [];
      byDay[d].push(`${h.start_time}–${h.end_time}`);
    });
    const hoursHtml = BOOKING_WEEKDAYS.map((label, i) => {
      const ranges = byDay[i] || [];
      return `<label class="booking-hour-row">
        <input type="checkbox" data-bh-day="${i}" ${ranges.length ? 'checked' : ''} />
        <span class="booking-hour-day">${label}</span>
        <input type="text" data-bh-range="${i}" value="${esc(ranges[0] || '09:00–17:00')}" placeholder="09:00–17:00" />
      </label>`;
    }).join('');
    const apptHtml = appointments.length
      ? appointments
          .slice(0, 40)
          .map((a) => {
            const isArchived = !!a.archived_at;
            const canArchive = !isArchived && (a.status === 'completed' || a.status === 'cancelled');
            return `
        <div class="row" style="justify-content:space-between;gap:8px;padding:8px 0;border-bottom:1px solid var(--line,#e6e0d8);flex-wrap:wrap">
          <div>
            <strong>${esc(a.customer_name)}</strong>
            <span class="hint"> · ${esc(a.service_name || '')} · ${esc(a.starts_at || '')}</span>
            <div class="hint">${esc(a.customer_email || a.customer_phone || '')} · ${esc(a.status)}${isArchived ? ' · archived' : ''}</div>
            ${
              Number(a.discount_amount_cents) > 0
                ? `<div class="hint">${esc(a.discount_label || 'Online-booking discount')} · $${((Number(a.price_gross_cents) || 0) / 100).toFixed(2)} − $${((Number(a.discount_amount_cents) || 0) / 100).toFixed(2)} = $${((Number(a.price_net_cents) || 0) / 100).toFixed(2)}</div>`
                : ''
            }
          </div>
          <div class="row" style="gap:6px">
            ${!isArchived && a.status === 'pending' ? `<button type="button" class="btn soft small" data-appt-status="${a.id}" data-status="confirmed">Confirm</button>` : ''}
            ${!isArchived && a.status !== 'cancelled' && a.status !== 'completed' ? `<button type="button" class="btn ghost small" data-appt-status="${a.id}" data-status="cancelled">Cancel</button>` : ''}
            ${!isArchived && a.status === 'confirmed' ? `<button type="button" class="btn ghost small" data-appt-status="${a.id}" data-status="completed">Done</button>` : ''}
            ${canArchive ? `<button type="button" class="btn ghost small" data-appt-archive="${a.id}" data-archived="true">Archive</button>` : ''}
            ${isArchived ? `<button type="button" class="btn ghost small" data-appt-archive="${a.id}" data-archived="false">Restore</button>` : ''}
            ${!isArchived ? `<button type="button" class="btn ghost small" data-appt-delete="${a.id}">Delete</button>` : ''}
          </div>
        </div>`;
          })
          .join('')
      : `<p class="hint">${moduleState.showArchivedAppointments ? 'No archived appointments.' : 'No appointments yet. Visitors book from your site calendar.'}</p>`;
    if (hoursHost) {
      hoursHost.innerHTML = `
        <h3>Hours &amp; calendar</h3>
        <p class="hint">Set weekly availability — visitors see open slots on your booking page.</p>
        <div id="modules-booking-hours">${hoursHtml}</div>
        <div class="modules-booking-actions">
          <button type="button" class="btn soft small" id="btn-booking-hours-save">Save hours</button>
          <label class="hint">
            Auto-confirm
            <input type="checkbox" id="booking-auto-confirm" ${settings.auto_confirm ? 'checked' : ''} />
          </label>
          <label class="hint">Min notice (hrs)
            <input type="number" id="booking-min-notice" value="${esc(settings.min_notice_hours != null ? settings.min_notice_hours : 2)}" min="0" max="168" />
          </label>
          <label class="hint">Days ahead
            <input type="number" id="booking-max-ahead" value="${esc(settings.max_days_ahead != null ? settings.max_days_ahead : 60)}" min="1" max="365" />
          </label>
          <button type="button" class="btn soft small" id="btn-booking-settings-save">Save settings</button>
        </div>
        <div class="modules-booking-actions" style="flex-wrap:wrap">
          <strong style="width:100%">Online-booking discount</strong>
          <p class="hint" style="width:100%;margin:0">When on, EVERYONE who books online gets this discount automatically — it is shown on your booking page and applied at checkout. Off means no discount is shown or given anywhere.</p>
          <label class="hint">
            Discount on
            <input type="checkbox" id="booking-discount-enabled" ${settings.discount_enabled ? 'checked' : ''} />
          </label>
          <label class="hint">Type
            <select id="booking-discount-kind">
              <option value="percent" ${settings.discount_kind !== 'fixed' ? 'selected' : ''}>Percent off</option>
              <option value="fixed" ${settings.discount_kind === 'fixed' ? 'selected' : ''}>Fixed amount off</option>
            </select>
          </label>
          <label class="hint">Value <span class="hint">(percent 1–90, or dollars for fixed)</span>
            <input type="number" id="booking-discount-value" step="any" min="0" value="${esc(
              settings.discount_kind === 'fixed'
                ? ((Number(settings.discount_value) || 0) / 100).toFixed(2)
                : settings.discount_value != null
                  ? settings.discount_value
                  : 0
            )}" />
          </label>
          <label class="hint">Label (optional)
            <input type="text" id="booking-discount-label" maxlength="80" placeholder="e.g. New client special" value="${esc(settings.discount_label || '')}" />
          </label>
        </div>`;
    }
    if (apptsHost) {
      apptsHost.innerHTML = `
        <h3>Appointments</h3>
        <p class="hint">Confirm, cancel, or complete bookings from your site calendar.</p>
        <label class="hint" style="display:inline-flex;align-items:center;gap:6px;margin:4px 0 8px">
          <input type="checkbox" id="booking-show-archived" ${moduleState.showArchivedAppointments ? 'checked' : ''} />
          Show archived
        </label>
        <div id="modules-booking-appts">${apptHtml}</div>`;
    }
  }

  function renderEstimateAdminPanel() {
    const calcHost = document.getElementById('modules-estimate-calc-panel');
    const reqHost = document.getElementById('modules-estimate-requests-panel');
    if (!calcHost && !reqHost) return;
    if (moduleState.current !== 'estimate') {
      if (calcHost) calcHost.innerHTML = '';
      if (reqHost) reqHost.innerHTML = '';
      return;
    }
    const estimate = moduleState.estimate || {};
    const cfg = estimate.config || {};
    const requests = Array.isArray(estimate.requests) ? estimate.requests : [];
    const money = (cents) => `$${((Number(cents) || 0) / 100).toFixed(2)}`;
    const baseDollars = cfg.base_price_cents != null ? String((Number(cfg.base_price_cents) || 0) / 100) : '0';
    if (calcHost) {
      calcHost.innerHTML = `
        <h3>Calculator</h3>
        <p class="hint">Visitors pick options and see a ballpark instantly. The server always recomputes the total from these prices when a request is sent — and every request lands in LeadScout as a contact.</p>
        <div class="field"><label>Heading (optional)</label>
          <input type="text" id="estimate-title" value="${esc(cfg.title || '')}" placeholder="Get an instant estimate" /></div>
        <div class="field"><label>Intro (optional)</label>
          <textarea id="estimate-intro" rows="2">${esc(cfg.intro || '')}</textarea></div>
        <div class="field"><label>Service label</label>
          <input type="text" id="estimate-service-label" value="${esc(cfg.service_label || '')}" placeholder="e.g. Kitchen remodel" /></div>
        <div class="field"><label>Base price ($)</label>
          <input type="text" id="estimate-base-price" value="${esc(baseDollars)}" placeholder="0" /></div>
        <div class="field"><label>What visitors see</label>
          <select id="estimate-display-mode">
            <option value="exact"${cfg.display_mode === 'exact' ? ' selected' : ''}>Exact estimate, updating live</option>
            <option value="range"${cfg.display_mode === 'range' ? ' selected' : ''}>A range (total ± percent)</option>
            <option value="hidden"${cfg.display_mode === 'hidden' ? ' selected' : ''}>No price — capture first, we send the estimate</option>
          </select></div>
        <div class="field"><label>Range ± percent (range mode)</label>
          <input type="number" id="estimate-range-percent" value="${esc(cfg.range_percent != null ? cfg.range_percent : 15)}" min="0" max="100" /></div>
        <div class="field"><label>Submit button label</label>
          <input type="text" id="estimate-submit-label" value="${esc(cfg.submit_label || 'Send my estimate')}" /></div>
        <div class="field"><label>Disclaimer</label>
          <textarea id="estimate-disclaimer" rows="3">${esc(cfg.disclaimer || '')}</textarea>
          <p class="hint">Shown under the calculator. Keep it honest: an estimate is a ballpark, not a quote.</p></div>
        <button type="button" class="btn soft small" id="btn-estimate-config-save">Save calculator</button>`;
    }
    if (reqHost) {
      const reqHtml = requests.length
        ? requests
            .slice(0, 60)
            .map((r) => {
              const picks = (r.selections || [])
                .map(
                  (s) =>
                    `${esc(s.label || '')}${s.choice_label ? `: ${esc(s.choice_label)}` : ''}${s.quantity > 1 ? ` ×${s.quantity}` : ''} — ${money(s.line_total_cents)}`
                )
                .join('<br />');
              return `
        <div class="row" style="justify-content:space-between;gap:8px;padding:8px 0;border-bottom:1px solid var(--line,#e6e0d8);flex-wrap:wrap">
          <div>
            <strong>${esc(r.name || '')}</strong>
            <span class="hint"> · ${esc(r.estimate_label || money(r.estimate_cents))}${r.display_mode === 'hidden' ? ' (hidden mode)' : ''} · ${esc(r.created_at || '')}</span>
            <div class="hint">${esc(r.email || '')}${r.email && r.phone ? ' · ' : ''}${esc(r.phone || '')} · status: ${esc(r.status || 'new')}</div>
            ${picks ? `<div class="hint">${picks}</div>` : ''}
            ${r.notes ? `<div class="hint">“${esc(r.notes)}”</div>` : ''}
          </div>
          <div class="row" style="gap:6px">
            ${r.status !== 'contacted' ? `<button type="button" class="btn soft small" data-est-req-status="${r.id}" data-status="contacted">Mark contacted</button>` : ''}
            ${r.status !== 'closed' ? `<button type="button" class="btn ghost small" data-est-req-status="${r.id}" data-status="closed">Close</button>` : ''}
            ${r.status === 'closed' ? `<button type="button" class="btn ghost small" data-est-req-status="${r.id}" data-status="new">Reopen</button>` : ''}
            <button type="button" class="btn ghost small" data-est-req-delete="${r.id}">Delete</button>
          </div>
        </div>`;
            })
            .join('')
        : '<p class="hint">No estimate requests yet. When a visitor sends the calculator on your site, their request — and their contact — shows up here and in LeadScout.</p>';
      reqHost.innerHTML = `
        <h3>Estimate requests</h3>
        <p class="hint">Every submission is also captured as a LeadScout contact for this business.</p>
        <div id="modules-estimate-requests">${reqHtml}</div>`;
    }
  }

  function renderSocialFeedAdminPanel() {
    const host = document.getElementById('modules-socialfeed-panel');
    if (!host) return;
    if (moduleState.current !== 'socialfeed') {
      host.innerHTML = '';
      return;
    }
    const feed = moduleState.socialfeed || {};
    const cfg = feed.config || {};
    const items = Array.isArray(feed.items) ? feed.items : [];
    const accounts = Array.isArray(feed.accounts) ? feed.accounts : [];
    const connected = accounts.filter((a) => a.status === 'active' && a.has_token);
    const netLabel = (n) => (n === 'instagram' ? 'Instagram' : 'Facebook');
    const whenLabel = (v) => {
      const t = Date.parse(String(v || '').replace(' ', 'T') + (String(v || '').includes('T') ? '' : 'Z'));
      return Number.isFinite(t) ? new Date(t).toLocaleDateString() : '';
    };
    const previewHtml = items.length
      ? items
          .map(
            (it) => `
        <div class="row" style="justify-content:space-between;gap:8px;padding:8px 0;border-bottom:1px solid var(--line,#e6e0d8)">
          <div style="display:flex;gap:10px;align-items:flex-start">
            ${it.image_url ? `<img src="${esc(it.image_url)}" alt="" style="width:52px;height:52px;object-fit:cover;border-radius:8px" />` : ''}
            <div>
              <strong>${esc(netLabel(it.network))}</strong>
              <span class="hint"> · ${esc(whenLabel(it.published_at))}${it.source === 'bitpype' ? ' · posted via BitPype' : ''}</span>
              <div>${esc(it.text || '')}</div>
              ${it.permalink ? `<div class="hint"><a href="${esc(it.permalink)}" target="_blank" rel="noopener">View post</a></div>` : ''}
            </div>
          </div>
        </div>`
          )
          .join('')
      : '<p class="hint">Nothing to show yet. Posts you publish through BitPype appear here automatically — and on your site’s Social Feed page.</p>';
    host.innerHTML = `
      <h3>Social Feed</h3>
      <p class="hint">${esc(feed.source_note || 'Shows the posts published through BitPype.')}</p>
      ${
        connected.length
          ? `<p class="hint">Connected: ${connected.map((a) => `${esc(netLabel(a.platform))} — ${esc(a.account_name || '')}`).join(' · ')}${
              feed.last_fetched_at ? ` · last checked ${esc(feed.last_fetched_at)}` : ''
            }</p>`
          : '<p class="hint">No social account connected yet — connect one under Social to pull in your latest posts directly.</p>'
      }
      <div class="field"><label>Show posts from</label>
        <select id="socialfeed-networks">
          <option value="both"${cfg.networks !== 'facebook' && cfg.networks !== 'instagram' ? ' selected' : ''}>Facebook and Instagram</option>
          <option value="facebook"${cfg.networks === 'facebook' ? ' selected' : ''}>Facebook only</option>
          <option value="instagram"${cfg.networks === 'instagram' ? ' selected' : ''}>Instagram only</option>
        </select></div>
      <div class="field"><label>Posts to show</label>
        <input type="number" id="socialfeed-max-posts" value="${esc(cfg.max_posts != null ? cfg.max_posts : 6)}" min="1" max="24" /></div>
      <div class="field"><label>Layout</label>
        <select id="socialfeed-layout">
          <option value="grid"${cfg.layout !== 'list' ? ' selected' : ''}>Grid of cards</option>
          <option value="list"${cfg.layout === 'list' ? ' selected' : ''}>Simple list</option>
        </select></div>
      <div class="row" style="gap:6px">
        <button type="button" class="btn soft small" id="btn-socialfeed-config-save">Save feed settings</button>
        <button type="button" class="btn ghost small" id="btn-socialfeed-refresh">Check for new posts now</button>
      </div>
      <h3 style="margin-top:18px">What your visitors will see</h3>
      <div id="modules-socialfeed-preview">${previewHtml}</div>`;
  }

  function renderGoogleReviewsAdminPanel() {
    const host = document.getElementById('modules-googlereviews-panel');
    if (!host) return;
    if (moduleState.current !== 'googlereviews') {
      host.innerHTML = '';
      return;
    }
    const data = moduleState.googlereviews || {};
    const cfg = data.config || {};
    const summary = data.summary || {};
    const reviews = Array.isArray(data.reviews) ? data.reviews : [];
    const stars = (n) => {
      const r = Math.max(0, Math.min(5, Math.round(Number(n) || 0)));
      return r ? '★'.repeat(r) + '☆'.repeat(5 - r) : '';
    };
    const whenLabel = (v) => {
      const t = Date.parse(String(v || '').replace(' ', 'T') + (String(v || '').includes('T') ? '' : 'Z'));
      return Number.isFinite(t) ? new Date(t).toLocaleString() : '';
    };
    const previewHtml = reviews.length
      ? reviews
          .map(
            (r) => `
        <div style="padding:8px 0;border-bottom:1px solid var(--line,#e6e0d8)">
          <strong>${esc(r.author || '')}</strong>
          <span style="color:#f59e0b">${esc(stars(r.rating))}</span>
          ${r.relative_time ? `<span class="hint"> · ${esc(r.relative_time)}</span>` : ''}
          ${r.text ? `<div>${esc(r.text.length > 300 ? r.text.slice(0, 299).trimEnd() + '…' : r.text)}</div>` : ''}
        </div>`
          )
          .join('')
      : '<p class="hint">No reviews to preview yet.</p>';
    const minOptions = [
      [0, 'Show all reviews'],
      [3, '3 stars and up'],
      [4, '4 stars and up'],
      [4.5, '5 stars only (4.5+)'],
      [5, '5 stars only'],
    ];
    host.innerHTML = `
      <h3>Google Reviews</h3>
      <p class="hint">${esc(data.message || 'Your Google reviews pull in automatically.')}</p>
      ${
        summary.rating != null
          ? `<p><strong>${esc(summary.name || 'Your business')}</strong> — <span style="color:#f59e0b">${esc(stars(summary.rating))}</span> <strong>${esc(Number(summary.rating).toFixed(1))}</strong> from ${esc(summary.total || 0)} Google reviews${summary.fetched_at ? ` · last updated ${esc(whenLabel(summary.fetched_at))}` : ''}</p>`
          : ''
      }
      ${summary.last_error && data.state !== 'no_key' ? `<p class="hint">Last check hit a problem: ${esc(summary.last_error)}</p>` : ''}
      <div class="field"><label>Google Place ID</label>
        <input type="text" id="googlereviews-place-id" value="${esc(cfg.place_id || '')}" placeholder="e.g. ChIJN1t_tDeuEmsRUsoyG83frY4" autocomplete="off" spellcheck="false" />
        <p class="hint">The unique ID of your business on Google Maps. Changing it checks the new ID with Google before saving.</p></div>
      <div class="field"><label>Reviews to show</label>
        <input type="number" id="googlereviews-max-reviews" value="${esc(cfg.max_reviews != null ? cfg.max_reviews : 5)}" min="1" max="5" /></div>
      <div class="field"><label>Minimum rating</label>
        <select id="googlereviews-min-rating">
          ${minOptions.map(([v, label]) => `<option value="${v}"${Number(cfg.min_rating || 0) === v ? ' selected' : ''}>${label}</option>`).join('')}
        </select></div>
      <div class="row" style="gap:6px">
        <button type="button" class="btn soft small" id="btn-googlereviews-config-save">Save review settings</button>
        <button type="button" class="btn ghost small" id="btn-googlereviews-refresh">Refresh reviews now</button>
      </div>
      <h3 style="margin-top:18px">What your visitors will see</h3>
      <div id="modules-googlereviews-preview">${previewHtml}</div>`;
  }

  // Batch 125 — Photo Capture panel: capture-block settings plus the
  // moderation inbox. DOM APIs only, like the newsletter panel.
  // Submissions arrive from the public site; the owner approves or
  // rejects each one, and an approved photo can be pushed into a
  // gallery album (the server writes it through the gallery's own
  // path). Pending/rejected photos are never public.
  function renderPhotoCaptureAdminPanel() {
    const host = document.getElementById('modules-photocapture-panel');
    if (!host) return;
    if (moduleState.current !== 'photocapture') {
      host.textContent = '';
      return;
    }
    const data = moduleState.photocapture || {};
    const cfg = data.config || {};
    const counts = data.counts || { pending: 0, approved: 0, rejected: 0, total: 0 };
    const submissions = Array.isArray(data.submissions) ? data.submissions : [];
    const albums = Array.isArray(data.albums) ? data.albums : [];
    const filter = moduleState.pcFilter || 'all';

    const pcEl = (tag, cls, text) => {
      const n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text != null) n.textContent = String(text);
      return n;
    };
    const pcField = (labelText, input, hintText) => {
      const wrap = pcEl('div', 'field');
      wrap.appendChild(pcEl('label', null, labelText));
      wrap.appendChild(input);
      if (hintText) wrap.appendChild(pcEl('p', 'hint', hintText));
      return wrap;
    };
    const pcText = (id, value, placeholder) => {
      const i = document.createElement('input');
      i.type = 'text';
      i.id = id;
      i.value = value || '';
      if (placeholder) i.placeholder = placeholder;
      i.autocomplete = 'off';
      i.spellcheck = false;
      return i;
    };
    const whenLabel = (v) => {
      const t = Date.parse(String(v || '').replace(' ', 'T') + (String(v || '').includes('T') ? '' : 'Z'));
      return Number.isFinite(t) ? new Date(t).toLocaleString() : '';
    };
    const refresh = async () => {
      await loadModuleItems();
    };

    host.textContent = '';
    host.appendChild(pcEl('h3', null, 'Photo Capture'));
    host.appendChild(
      pcEl(
        'p',
        'hint',
        'Visitors take or upload a photo on your site and leave their name plus an email or phone. Every photo waits here for your decision — nothing is public until you approve it. Submitters also land in your contacts automatically.'
      )
    );

    /* ---- Capture block settings ---- */
    const headingInput = pcText('pc-heading', cfg.heading, 'Share your photo');
    const introInput = document.createElement('textarea');
    introInput.id = 'pc-intro';
    introInput.rows = 2;
    introInput.value = cfg.intro || '';
    const submitInput = pcText('pc-submit-label', cfg.submit_label, 'Send photo');
    const successInput = pcText('pc-success', cfg.success_message, 'Thanks — your photo is in.');
    const showWrap = pcEl('div', 'field');
    const showLabel = pcEl('label', null, 'Show approved photos on the page');
    const showInput = document.createElement('input');
    showInput.type = 'checkbox';
    showInput.id = 'pc-show-approved';
    showInput.checked = !!cfg.show_approved;
    showLabel.appendChild(showInput);
    showWrap.appendChild(showLabel);
    showWrap.appendChild(
      pcEl('p', 'hint', 'When on, approved photos also appear as a grid under the capture form on your site. Off by default.')
    );
    const limitInput = document.createElement('input');
    limitInput.type = 'number';
    limitInput.id = 'pc-grid-limit';
    limitInput.min = '1';
    limitInput.max = '60';
    limitInput.value = cfg.grid_limit != null ? String(cfg.grid_limit) : '12';
    host.appendChild(pcField('Block heading', headingInput));
    host.appendChild(pcField('Block text', introInput));
    host.appendChild(pcField('Button label', submitInput));
    host.appendChild(pcField('Thank-you message', successInput, 'Shown to every visitor after they send a photo, whatever you later decide.'));
    host.appendChild(showWrap);
    host.appendChild(pcField('Photos in the public grid (max)', limitInput));
    const saveBtn = pcEl('button', 'btn soft small', 'Save photo capture settings');
    saveBtn.type = 'button';
    saveBtn.addEventListener('click', async () => {
      moduleMsg('Saving photo capture settings…', true);
      try {
        await api('/modules/photocapture/config', {
          method: 'PUT',
          body: JSON.stringify({
            heading: headingInput.value,
            intro: introInput.value,
            submit_label: submitInput.value,
            success_message: successInput.value,
            show_approved: showInput.checked,
            grid_limit: Number(limitInput.value) || 12,
          }),
        });
        moduleMsg('Photo capture settings saved.', true);
        await refresh();
      } catch (e) {
        moduleMsg(errText(e), false);
      }
    });
    const saveRow = pcEl('div', 'row');
    saveRow.style.gap = '6px';
    saveRow.appendChild(saveBtn);
    host.appendChild(saveRow);

    /* ---- Moderation inbox ---- */
    const inboxH = pcEl('h3', null, 'Submissions');
    inboxH.style.marginTop = '18px';
    host.appendChild(inboxH);
    host.appendChild(
      pcEl(
        'p',
        'hint',
        `${counts.pending} waiting · ${counts.approved} approved · ${counts.rejected} rejected · ${counts.total} total`
      )
    );
    const filterRow = pcEl('div', 'row');
    filterRow.style.gap = '6px';
    filterRow.style.flexWrap = 'wrap';
    [
      ['all', 'All'],
      ['pending', 'Waiting'],
      ['approved', 'Approved'],
      ['rejected', 'Rejected'],
    ].forEach(([key, label]) => {
      const b = pcEl('button', `btn small${filter === key ? '' : ' soft'}`, label);
      b.type = 'button';
      b.addEventListener('click', () => {
        moduleState.pcFilter = key;
        renderPhotoCaptureAdminPanel();
      });
      filterRow.appendChild(b);
    });
    host.appendChild(filterRow);

    const visible = submissions.filter((s) => filter === 'all' || s.status === filter);
    if (!visible.length) {
      host.appendChild(
        pcEl('p', 'hint', submissions.length ? 'No submissions with this status.' : 'No photos yet — they will land here as visitors send them.')
      );
      return;
    }
    const list = pcEl('div');
    list.style.display = 'flex';
    list.style.flexDirection = 'column';
    list.style.gap = '16px';
    list.style.marginTop = '10px';
    for (const s of visible) {
      const card = pcEl('div', 'panel');
      card.style.display = 'flex';
      card.style.gap = '16px';
      card.style.flexWrap = 'wrap';
      const img = document.createElement('img');
      img.src = s.display_url || s.image_url || '';
      img.alt = s.message || s.name || 'Submitted photo';
      img.style.width = '140px';
      img.style.height = '140px';
      img.style.objectFit = 'cover';
      img.style.borderRadius = '10px';
      card.appendChild(img);
      const body = pcEl('div');
      body.style.flex = '1 1 260px';
      body.style.minWidth = '0';
      const titleLine = pcEl('p');
      titleLine.appendChild(pcEl('strong', null, s.name || 'Visitor'));
      titleLine.appendChild(document.createTextNode(` — ${s.status}`));
      body.appendChild(titleLine);
      const contactBits = [s.email, s.phone].filter(Boolean).join(' · ');
      if (contactBits) body.appendChild(pcEl('p', 'hint', contactBits));
      if (s.message) body.appendChild(pcEl('p', null, s.message));
      const when = whenLabel(s.created_at);
      if (when) body.appendChild(pcEl('p', 'hint', `Sent ${when}`));
      // Batch 125 finisher: the shared-taxonomy picker — this lead's
      // photocapture-scope categories from the shared Categories
      // module, saved through the same moderation write the design
      // agent uses (category_ids on the submission PUT). No
      // photocapture categories → no picker, inbox unchanged.
      const pcCats = (moduleState.allCategories || []).filter((c) => c && c.scope === 'photocapture');
      if (pcCats.length) {
        const catWrap = pcEl('div', 'field');
        catWrap.style.marginTop = '8px';
        catWrap.appendChild(pcEl('label', null, 'Categories'));
        const boxes = [];
        for (const c of pcCats) {
          const lab = pcEl('label', null);
          lab.style.display = 'block';
          const box = document.createElement('input');
          box.type = 'checkbox';
          box.checked = (Array.isArray(s.category_ids) ? s.category_ids : []).map(Number).includes(Number(c.id));
          box.dataset.catId = String(c.id);
          lab.appendChild(box);
          lab.appendChild(document.createTextNode(` ${c.name || ''}`));
          catWrap.appendChild(lab);
          boxes.push(box);
        }
        const saveCats = pcEl('button', 'btn soft small', 'Save categories');
        saveCats.type = 'button';
        saveCats.addEventListener('click', async () => {
          moduleMsg('Saving categories…', true);
          try {
            await api(`/modules/photocapture/submissions/${encodeURIComponent(s.id)}`, {
              method: 'PUT',
              body: JSON.stringify({
                category_ids: boxes.filter((b) => b.checked).map((b) => Number(b.dataset.catId)),
              }),
            });
            moduleMsg('Categories saved.', true);
            await refresh();
          } catch (e) {
            moduleMsg(errText(e), false);
          }
        });
        catWrap.appendChild(saveCats);
        body.appendChild(catWrap);
      }
      const actions = pcEl('div', 'row');
      actions.style.gap = '6px';
      actions.style.flexWrap = 'wrap';
      actions.style.marginTop = '8px';
      const moderate = async (status) => {
        moduleMsg(`${status === 'approved' ? 'Approving' : 'Rejecting'} photo…`, true);
        try {
          await api(`/modules/photocapture/submissions/${encodeURIComponent(s.id)}`, {
            method: 'PUT',
            body: JSON.stringify({ status }),
          });
          moduleMsg(`Photo ${status}.`, true);
          await refresh();
        } catch (e) {
          moduleMsg(errText(e), false);
        }
      };
      if (s.status !== 'approved') {
        const b = pcEl('button', 'btn small', 'Approve');
        b.type = 'button';
        b.addEventListener('click', () => moderate('approved'));
        actions.appendChild(b);
      }
      if (s.status !== 'rejected') {
        const b = pcEl('button', 'btn soft small', 'Reject');
        b.type = 'button';
        b.addEventListener('click', () => moderate('rejected'));
        actions.appendChild(b);
      }
      if (s.status === 'approved') {
        if (s.gallery_image_id) {
          actions.appendChild(pcEl('span', 'hint', 'In your gallery ✓'));
        } else if (albums.length) {
          const sel = document.createElement('select');
          for (const a of albums) {
            const opt = document.createElement('option');
            opt.value = String(a.id);
            opt.textContent = a.title || `Album ${a.id}`;
            sel.appendChild(opt);
          }
          actions.appendChild(sel);
          const b = pcEl('button', 'btn soft small', 'Add to gallery');
          b.type = 'button';
          b.addEventListener('click', async () => {
            moduleMsg('Adding photo to gallery…', true);
            try {
              await api(`/modules/photocapture/submissions/${encodeURIComponent(s.id)}/gallery`, {
                method: 'POST',
                body: JSON.stringify({ album_id: Number(sel.value) }),
              });
              moduleMsg('Photo added to the gallery.', true);
              await refresh();
            } catch (e) {
              moduleMsg(errText(e), false);
            }
          });
          actions.appendChild(b);
        } else {
          actions.appendChild(pcEl('span', 'hint', 'Create a gallery album to file this photo.'));
        }
      }
      const del = pcEl('button', 'btn ghost small danger', 'Delete');
      del.type = 'button';
      del.addEventListener('click', async () => {
        moduleMsg('Deleting photo…', true);
        try {
          await api(`/modules/photocapture/submissions/${encodeURIComponent(s.id)}`, { method: 'DELETE' });
          moduleMsg('Photo deleted.', true);
          await refresh();
        } catch (e) {
          moduleMsg(errText(e), false);
        }
      });
      actions.appendChild(del);
      body.appendChild(actions);
      card.appendChild(body);
      list.appendChild(card);
    }
    host.appendChild(list);
  }

  // Batch 118 — Newsletter panel. Built with DOM APIs only (no
  // innerHTML): the SEC-13 sink census pins these client surfaces, and
  // the Batch 117 WordPress panel set the same precedent. Compose
  // drafts + the preview token live on moduleState so a re-render
  // (e.g. after saving settings) never loses the owner's writing; any
  // draft edit after a preview marks the preview stale and disables
  // Send until a fresh preview — the server gate enforces the same.
  function renderCommentsAdminPanel() {
    const host = document.getElementById('modules-comments-panel');
    if (!host) return;
    if (moduleState.current !== 'comments') {
      host.textContent = '';
      return;
    }
    const data = moduleState.comments || {};
    const cfg = data.config || {};
    const counts = data.counts || { pending: 0, published: 0, rejected: 0, total: 0 };
    const comments = Array.isArray(data.comments) ? data.comments : [];
    const targets = Array.isArray(data.targets) ? data.targets : [];
    const filter = moduleState.cmFilter || 'pending';

    const cmEl = (tag, cls, text) => {
      const n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text != null) n.textContent = String(text);
      return n;
    };
    const cmField = (labelText, input, hintText) => {
      const wrap = cmEl('div', 'field');
      wrap.appendChild(cmEl('label', null, labelText));
      wrap.appendChild(input);
      if (hintText) wrap.appendChild(cmEl('p', 'hint', hintText));
      return wrap;
    };
    const cmCheck = (id, labelText, checked, hintText) => {
      const wrap = cmEl('div', 'field');
      const label = cmEl('label', null, labelText);
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.id = id;
      input.checked = !!checked;
      label.appendChild(input);
      wrap.appendChild(label);
      if (hintText) wrap.appendChild(cmEl('p', 'hint', hintText));
      return { wrap, input };
    };
    const cmSelect = (id, value, options) => {
      const sel = document.createElement('select');
      sel.id = id;
      options.forEach(([v, label]) => {
        const o = document.createElement('option');
        o.value = v;
        o.textContent = label;
        if (v === value) o.selected = true;
        sel.appendChild(o);
      });
      return sel;
    };
    const whenLabel = (v) => {
      const t = Date.parse(String(v || '').replace(' ', 'T') + (String(v || '').includes('T') ? '' : 'Z'));
      return Number.isFinite(t) ? new Date(t).toLocaleString() : '';
    };
    const refresh = async () => {
      await loadModuleItems();
    };

    host.textContent = '';
    host.appendChild(cmEl('h3', null, 'Comments'));
    host.appendChild(
      cmEl(
        'p',
        'hint',
        'Visitors comment on — and like — your posts, products, events, albums and pages. Commenters also land in your contacts automatically; likes are anonymous and never capture anyone.'
      )
    );

    /* ---- Settings ---- */
    const moderationSel = cmSelect('cm-moderation', cfg.moderation === 'auto' ? 'auto' : 'held', [
      ['held', 'Hold every comment for approval (recommended)'],
      ['auto', 'Publish comments immediately'],
    ]);
    host.appendChild(
      cmField('Moderation', moderationSel, 'Held comments are invisible on your site until you approve them below. Comments with lots of links are held either way.')
    );
    const modeSel = cmSelect('cm-target-mode', cfg.target_mode === 'item' ? 'item' : 'page', [
      ['page', 'One thread for the page the block sits on (guestbook style)'],
      ['item', 'A thread under each item the page shows (post, product, event…)'],
    ]);
    host.appendChild(cmField('What the block attaches to', modeSel));
    const targetTypeSel = cmSelect('cm-target-type', cfg.target_type || 'blog', [
      ['blog', 'Blog posts'],
      ['ecommerce', 'Shop products'],
      ['events', 'Events'],
      ['gallery', 'Gallery albums'],
      ['offers', 'Special offers'],
      ['video', 'Videos'],
      ['courses', 'Courses'],
      ['directory', 'Directory listings'],
    ]);
    host.appendChild(
      cmField('Item type (for item mode)', targetTypeSel, 'In item mode the block must sit on pages of this module — it picks up whichever item the visitor opened.')
    );
    const headingInput = document.createElement('input');
    headingInput.type = 'text';
    headingInput.id = 'cm-heading';
    headingInput.value = cfg.heading || 'Comments';
    headingInput.autocomplete = 'off';
    host.appendChild(cmField('Block heading', headingInput));
    const enabled = cmCheck('cm-enabled', 'Comments turned on', cfg.comments_enabled !== false, 'Off hides the block everywhere and refuses new comments.');
    host.appendChild(enabled.wrap);
    const likes = cmCheck('cm-allow-likes', 'Allow likes', cfg.allow_likes !== false, 'Visitors can like comments and (below) the item itself. Liking is anonymous — one like per visitor.');
    host.appendChild(likes.wrap);
    const itemLike = cmCheck('cm-allow-item-like', 'Show the like button for the item itself', cfg.allow_item_like !== false, 'The heart at the top of the block, next to the heading — its count is the item’s like count everywhere.');
    host.appendChild(itemLike.wrap);
    const saveBtn = cmEl('button', 'btn soft small', 'Save comment settings');
    saveBtn.type = 'button';
    saveBtn.addEventListener('click', async () => {
      moduleMsg('Saving comment settings…', true);
      try {
        await api('/modules/comments/config', {
          method: 'PUT',
          body: JSON.stringify({
            moderation: moderationSel.value,
            target_mode: modeSel.value,
            target_type: targetTypeSel.value,
            heading: headingInput.value,
            comments_enabled: enabled.input.checked,
            allow_likes: likes.input.checked,
            allow_item_like: itemLike.input.checked,
          }),
        });
        moduleMsg('Comment settings saved.', true);
        await refresh();
      } catch (e) {
        moduleMsg(errText(e), false);
      }
    });
    const saveRow = cmEl('div', 'row');
    saveRow.style.gap = '6px';
    saveRow.appendChild(saveBtn);
    host.appendChild(saveRow);

    /* ---- Targets roll-up ---- */
    if (targets.length) {
      const tH = cmEl('h3', null, 'Where the conversation is');
      tH.style.marginTop = '18px';
      host.appendChild(tH);
      targets.slice(0, 12).forEach((t) => {
        const line = cmEl(
          'p',
          'hint',
          `${t.title || `${t.target_type} #${t.target_id}`} — ${t.comments} comment(s)${t.pending ? `, ${t.pending} waiting` : ''}, ${t.likes} like(s)`
        );
        host.appendChild(line);
      });
    }

    /* ---- Moderation queue ---- */
    const qH = cmEl('h3', null, 'Moderation queue');
    qH.style.marginTop = '18px';
    host.appendChild(qH);
    host.appendChild(
      cmEl('p', 'hint', `${counts.pending} waiting · ${counts.published} published · ${counts.rejected} rejected · ${counts.total} total`)
    );
    const filterRow = cmEl('div', 'row');
    filterRow.style.gap = '6px';
    filterRow.style.flexWrap = 'wrap';
    [
      ['pending', 'Waiting'],
      ['all', 'All'],
      ['published', 'Published'],
      ['rejected', 'Rejected'],
    ].forEach(([key, label]) => {
      const b = cmEl('button', `btn small${filter === key ? '' : ' soft'}`, label);
      b.type = 'button';
      b.addEventListener('click', () => {
        moduleState.cmFilter = key;
        renderCommentsAdminPanel();
      });
      filterRow.appendChild(b);
    });
    if (counts.pending > 0) {
      const bulk = cmEl('button', 'btn small soft', `Approve all waiting (${counts.pending})`);
      bulk.type = 'button';
      bulk.addEventListener('click', async () => {
        bulk.disabled = true;
        try {
          for (const c of comments.filter((x) => x.status === 'pending')) {
            await api(`/modules/comments/${encodeURIComponent(c.id)}`, {
              method: 'PUT',
              body: JSON.stringify({ status: 'published' }),
            });
          }
          moduleMsg('All waiting comments approved.', true);
          await refresh();
        } catch (e) {
          moduleMsg(errText(e), false);
          bulk.disabled = false;
        }
      });
      filterRow.appendChild(bulk);
    }
    host.appendChild(filterRow);

    const visible = comments.filter((c) => filter === 'all' || c.status === filter);
    if (!visible.length) {
      host.appendChild(
        cmEl('p', 'hint', comments.length ? 'No comments with this status.' : 'No comments yet — they will land here as visitors write them.')
      );
    }
    const targetLabel = (c) => {
      const hit = targets.find((t) => t.target_type === c.target_type && String(t.target_id) === String(c.target_id));
      if (hit && hit.title) return hit.title;
      return c.target_type === 'page' ? `Page: ${c.target_id}` : `${c.target_type} #${c.target_id}`;
    };
    visible.forEach((c) => {
      const card = cmEl('div', 'card');
      card.style.marginTop = '10px';
      card.style.padding = '12px';
      const meta = cmEl(
        'p',
        'hint',
        `${c.is_owner ? 'Owner reply · ' : ''}${c.author_name || 'Anonymous'}${c.author_email ? ` <${c.author_email}>` : ''} · on ${targetLabel(c)} · ${whenLabel(c.created_at)} · ♥ ${c.like_count || 0} · ${c.status}`
      );
      card.appendChild(meta);
      const body = cmEl('p', null, c.body || '');
      body.style.whiteSpace = 'pre-wrap';
      card.appendChild(body);
      const row = cmEl('div', 'row');
      row.style.gap = '6px';
      row.style.flexWrap = 'wrap';
      const act = async (fn, okText) => {
        try {
          await fn();
          moduleMsg(okText, true);
          await refresh();
        } catch (e) {
          moduleMsg(errText(e), false);
        }
      };
      if (c.status !== 'published') {
        const b = cmEl('button', 'btn small', 'Approve');
        b.type = 'button';
        b.addEventListener('click', () =>
          act(
            () => api(`/modules/comments/${encodeURIComponent(c.id)}`, { method: 'PUT', body: JSON.stringify({ status: 'published' }) }),
            'Comment approved — it is live on the site.'
          )
        );
        row.appendChild(b);
      }
      if (c.status !== 'rejected') {
        const b = cmEl('button', 'btn small soft', 'Reject');
        b.type = 'button';
        b.addEventListener('click', () =>
          act(
            () => api(`/modules/comments/${encodeURIComponent(c.id)}`, { method: 'PUT', body: JSON.stringify({ status: 'rejected' }) }),
            'Comment rejected — it will not be shown.'
          )
        );
        row.appendChild(b);
      }
      const replyBox = cmEl('div', null);
      const replyBtn = cmEl('button', 'btn small soft', 'Reply as owner');
      replyBtn.type = 'button';
      replyBtn.addEventListener('click', () => {
        if (replyBox.firstChild) {
          replyBox.textContent = '';
          return;
        }
        const ta = document.createElement('textarea');
        ta.rows = 3;
        ta.maxLength = 2000;
        ta.placeholder = 'Your reply — published immediately, badged as the owner.';
        const send = cmEl('button', 'btn small', 'Post reply');
        send.type = 'button';
        send.addEventListener('click', () =>
          act(async () => {
            if (!ta.value.trim()) throw new Error('Write a reply first.');
            await api(`/modules/comments/${encodeURIComponent(c.id)}/reply`, {
              method: 'POST',
              body: JSON.stringify({ body: ta.value }),
            });
          }, 'Reply posted.')
        );
        replyBox.appendChild(ta);
        replyBox.appendChild(send);
      });
      row.appendChild(replyBtn);
      const del = cmEl('button', 'btn small soft', 'Delete');
      del.type = 'button';
      del.addEventListener('click', () =>
        act(
          () => api(`/modules/comments/${encodeURIComponent(c.id)}`, { method: 'DELETE' }),
          'Comment deleted.'
        )
      );
      row.appendChild(del);
      card.appendChild(row);
      card.appendChild(replyBox);
      host.appendChild(card);
    });
  }

  function renderNewsletterAdminPanel() {
    const host = document.getElementById('modules-newsletter-panel');
    if (!host) return;
    if (moduleState.current !== 'newsletter') {
      host.textContent = '';
      return;
    }
    const data = moduleState.newsletter || {};
    const cfg = data.config || {};
    const counts = data.counts || { active: 0, unsubscribed: 0, total: 0 };
    const from = data.from || {};
    const sends = Array.isArray(data.sends) ? data.sends : [];
    if (!Array.isArray(moduleState.nlSubscribers)) {
      moduleState.nlSubscribers = Array.isArray(data.subscribers) ? data.subscribers : [];
    }
    const subscribers = moduleState.nlSubscribers;
    const draft = moduleState.nlDraft || { subject: '', body: '' };
    const preview = moduleState.nlPreview || null;

    const nlEl = (tag, cls, text) => {
      const n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text != null) n.textContent = String(text);
      return n;
    };
    const nlField = (labelText, input, hintText) => {
      const wrap = nlEl('div', 'field');
      wrap.appendChild(nlEl('label', null, labelText));
      wrap.appendChild(input);
      if (hintText) wrap.appendChild(nlEl('p', 'hint', hintText));
      return wrap;
    };
    const nlText = (id, value, placeholder) => {
      const i = document.createElement('input');
      i.type = 'text';
      i.id = id;
      i.value = value || '';
      if (placeholder) i.placeholder = placeholder;
      i.autocomplete = 'off';
      i.spellcheck = false;
      return i;
    };
    const whenLabel = (v) => {
      const t = Date.parse(String(v || '').replace(' ', 'T') + (String(v || '').includes('T') ? '' : 'Z'));
      return Number.isFinite(t) ? new Date(t).toLocaleString() : '';
    };
    const fromLabel = (f) => {
      if (!f || !f.fromEmail) return '(not configured)';
      return f.fromName ? `${f.fromName} <${f.fromEmail}>` : f.fromEmail;
    };
    const refresh = async () => {
      moduleState.nlSubscribers = null;
      moduleState.nlOffset = 0;
      await loadModuleItems();
    };

    host.textContent = '';
    host.appendChild(nlEl('h3', null, 'Newsletter'));
    host.appendChild(
      nlEl(
        'p',
        'hint',
        'Subscribers join from the signup block on your site. Every issue carries an unsubscribe link, and an unsubscribed address is never mailed or quietly re-added.'
      )
    );

    /* ---- Signup block + sender settings ---- */
    const headingInput = nlText('nl-heading', cfg.heading, 'Join our newsletter');
    const blurbInput = document.createElement('textarea');
    blurbInput.id = 'nl-blurb';
    blurbInput.rows = 2;
    blurbInput.value = cfg.blurb || '';
    const buttonInput = nlText('nl-button-label', cfg.button_label, 'Subscribe');
    const fromNameInput = nlText('nl-from-name', cfg.from_name, 'e.g. Berks Roll-Off Co.');
    const fromEmailInput = nlText('nl-from-email', cfg.from_email, 'e.g. news@yourbusiness.com');
    host.appendChild(nlField('Signup block heading', headingInput));
    host.appendChild(nlField('Signup block text', blurbInput));
    host.appendChild(nlField('Button label', buttonInput));
    host.appendChild(nlField('From name', fromNameInput, 'The name subscribers see in their inbox. Fully yours to set.'));
    host.appendChild(
      nlField(
        'From email',
        fromEmailInput,
        'The address issues come from — when your domain is verified for sending. Until then, issues send from BitPype’s address with replies going to yours.'
      )
    );
    const fromBox = nlEl('div');
    const fromLine = nlEl('p');
    fromLine.appendChild(nlEl('strong', null, 'Issues will send from: '));
    fromLine.appendChild(document.createTextNode(fromLabel(from)));
    fromBox.appendChild(fromLine);
    if (from.replyTo) {
      const rt = nlEl('p');
      rt.appendChild(nlEl('strong', null, 'Replies go to: '));
      rt.appendChild(document.createTextNode(from.replyTo));
      fromBox.appendChild(rt);
    }
    if (from.note) fromBox.appendChild(nlEl('p', 'hint', from.note));
    host.appendChild(fromBox);
    const saveBtn = nlEl('button', 'btn soft small', 'Save newsletter settings');
    saveBtn.type = 'button';
    saveBtn.addEventListener('click', async () => {
      moduleMsg('Saving newsletter settings…', true);
      try {
        await api('/modules/newsletter/config', {
          method: 'PUT',
          body: JSON.stringify({
            heading: headingInput.value,
            blurb: blurbInput.value,
            button_label: buttonInput.value,
            from_name: fromNameInput.value,
            from_email: fromEmailInput.value,
          }),
        });
        moduleMsg('Newsletter settings saved.', true);
        await refresh();
      } catch (e) {
        moduleMsg(errText(e), false);
      }
    });
    const saveRow = nlEl('div', 'row');
    saveRow.style.gap = '6px';
    saveRow.appendChild(saveBtn);
    host.appendChild(saveRow);

    /* ---- Compose ---- */
    const composeH = nlEl('h3', null, 'Write an issue');
    composeH.style.marginTop = '18px';
    host.appendChild(composeH);
    const subjectInput = nlText('nl-subject', draft.subject, 'Subject line');
    const bodyInput = document.createElement('textarea');
    bodyInput.id = 'nl-body';
    bodyInput.rows = 10;
    bodyInput.value = draft.body || '';
    host.appendChild(nlField('Subject', subjectInput));
    host.appendChild(
      nlField(
        'Body',
        bodyInput,
        'Basic HTML is welcome (scripts are removed). Placeholders: {{name}}, {{email}}, {{unsubscribe_url}} — each subscriber gets their own unsubscribe link in the footer.'
      )
    );
    const recipLine = nlEl('p', 'hint', `${counts.active} active subscriber${counts.active === 1 ? '' : 's'} will receive the next issue.`);
    host.appendChild(recipLine);

    /* Batch 122 — auto-content blocks from the shared module layer.
       Resolved at preview and frozen into the send exactly as
       previewed (the preview token covers the resolved content). A
       block whose source has nothing to show is left out and noted
       under the preview — never an error. */
    const blockDefs = [
      ['socialfeed', 'Latest social posts'],
      ['events', 'Upcoming events'],
      ['offers', 'Current offers'],
    ];
    const blockWrap = nlEl('div', 'field');
    blockWrap.appendChild(nlEl('label', null, 'Auto-content blocks'));
    const blockChecks = blockDefs.map(([src, label]) => {
      const row = nlEl('label');
      row.style.display = 'flex';
      row.style.gap = '8px';
      row.style.alignItems = 'center';
      row.style.margin = '4px 0';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = src;
      cb.checked = (moduleState.nlBlocks || []).includes(src);
      row.appendChild(cb);
      row.appendChild(document.createTextNode(label));
      blockWrap.appendChild(row);
      return cb;
    });
    blockWrap.appendChild(
      nlEl(
        'p',
        'hint',
        'Pulled from your other modules when you preview, and frozen into the send exactly as previewed. A block with nothing to show is left out and noted under the preview.'
      )
    );
    host.appendChild(blockWrap);
    const selectedBlocks = () => blockChecks.filter((cb) => cb.checked).map((cb) => ({ source: cb.value, limit: 5 }));

    const previewBox = nlEl('div');
    previewBox.id = 'nl-preview-box';
    const previewNote = nlEl('p', 'hint', '');
    const sendBtn = nlEl('button', 'btn small', 'Send issue');
    sendBtn.type = 'button';
    sendBtn.disabled = true;
    const showPreview = () => {
      previewBox.textContent = '';
      /* Read the CURRENT preview at call time: the render-time
         `preview` const is null on a fresh panel, so a preview created
         by the Preview button in this session never rendered (the
         panel had to be re-opened to see it). */
      const current = moduleState.nlPreview || null;
      if (!current) {
        sendBtn.disabled = true;
        return;
      }
      const head = nlEl(
        'p',
        'hint',
        `Preview — as ${current.sampleEmail || 'a subscriber'} would see it. Sending will email ${current.recipientCount} subscriber(s) from ${fromLabel(current.from)}.`
      );
      previewBox.appendChild(head);
      const frame = document.createElement('iframe');
      frame.setAttribute('sandbox', '');
      frame.style.width = '100%';
      frame.style.height = '260px';
      frame.style.border = '1px solid var(--line,#e6e0d8)';
      frame.style.background = '#fff';
      frame.srcdoc = current.renderedHtml || '';
      previewBox.appendChild(frame);
      sendBtn.disabled = false;
    };
    const markStale = () => {
      moduleState.nlDraft = { subject: subjectInput.value, body: bodyInput.value };
      if (preview) {
        sendBtn.disabled = true;
        previewNote.textContent = 'The draft changed since the preview — preview again before sending.';
      }
    };
    subjectInput.addEventListener('input', markStale);
    bodyInput.addEventListener('input', markStale);
    blockChecks.forEach((cb) =>
      cb.addEventListener('change', () => {
        moduleState.nlBlocks = selectedBlocks().map((b) => b.source);
        markStale();
      })
    );

    const previewBtn = nlEl('button', 'btn soft small', 'Preview issue');
    previewBtn.type = 'button';
    previewBtn.addEventListener('click', async () => {
      moduleMsg('Rendering preview…', true);
      try {
        const r = await api('/modules/newsletter/preview', {
          method: 'POST',
          body: JSON.stringify({ subject: subjectInput.value, bodyHtml: bodyInput.value, blocks: selectedBlocks() }),
        });
        moduleState.nlPreview = {
          token: r.previewToken,
          recipientCount: r.recipientCount,
          from: r.from || {},
          renderedHtml: (r.rendered && r.rendered.html) || '',
          sampleEmail: (r.sampleSubscriber && r.sampleSubscriber.email) || '',
        };
        previewNote.textContent = (r.blocks || []).map((b) => b.note).filter(Boolean).join(' ');
        moduleMsg('Preview ready — check it below, then send.', true);
        showPreview();
      } catch (e) {
        moduleMsg(errText(e), false);
      }
    });
    sendBtn.addEventListener('click', async () => {
      const p = moduleState.nlPreview;
      if (!p) return;
      if (
        !window.confirm(
          `Send this issue to ${p.recipientCount} subscriber(s)? It will go out from ${fromLabel(p.from)} and cannot be unsent.`
        )
      )
        return;
      moduleMsg('Sending issue…', true);
      try {
        const r = await api('/modules/newsletter/send', {
          method: 'POST',
          body: JSON.stringify({
            subject: subjectInput.value,
            bodyHtml: bodyInput.value,
            blocks: selectedBlocks(),
            previewToken: p.token,
            confirmCount: p.recipientCount,
          }),
        });
        moduleState.nlPreview = null;
        if (r && r.failed > 0) {
          moduleMsg(`Issue sent to ${r.sent} of ${r.recipients} subscribers — ${r.failed} failed. See Sent issues below.`, false);
        } else {
          moduleMsg(`Issue sent to ${r ? r.sent : 0} subscriber(s).`, true);
        }
        await refresh();
      } catch (e) {
        moduleMsg(errText(e), false);
      }
    });
    const composeRow = nlEl('div', 'row');
    composeRow.style.gap = '6px';
    composeRow.appendChild(previewBtn);
    composeRow.appendChild(sendBtn);
    host.appendChild(composeRow);
    host.appendChild(previewNote);
    host.appendChild(previewBox);
    showPreview();

    /* ---- Subscribers ---- */
    const subsH = nlEl('h3', null, 'Subscribers');
    subsH.style.marginTop = '18px';
    host.appendChild(subsH);
    host.appendChild(
      nlEl('p', 'hint', `${counts.active} subscribed · ${counts.unsubscribed} unsubscribed · ${counts.total} total`)
    );
    const addEmail = nlText('nl-sub-email', '', 'subscriber@example.com');
    const addName = nlText('nl-sub-name', '', 'Name (optional)');
    const addBtn = nlEl('button', 'btn soft small', 'Add subscriber');
    addBtn.type = 'button';
    addBtn.addEventListener('click', async () => {
      moduleMsg('Adding subscriber…', true);
      try {
        const r = await api('/modules/newsletter/subscribers', {
          method: 'POST',
          body: JSON.stringify({ email: addEmail.value, name: addName.value }),
        });
        if (r && r.blocked) {
          moduleMsg('That address unsubscribed before — it has not been re-added. Use Resubscribe in the list if they asked to come back.', false);
        } else if (r && r.duplicate) {
          moduleMsg('That address is already subscribed.', true);
        } else {
          moduleMsg('Subscriber added.', true);
        }
        await refresh();
      } catch (e) {
        moduleMsg(errText(e), false);
      }
    });
    const addRow = nlEl('div', 'row');
    addRow.style.gap = '6px';
    addRow.appendChild(addEmail);
    addRow.appendChild(addName);
    addRow.appendChild(addBtn);
    host.appendChild(addRow);

    if (!subscribers.length) {
      host.appendChild(nlEl('p', 'hint', 'No subscribers yet — they will appear here as visitors sign up on your site.'));
    } else {
      const table = nlEl('table');
      const thead = nlEl('thead');
      const htr = nlEl('tr');
      for (const h of ['Email', 'Name', 'Source', 'Subscribed', 'Status', '']) {
        htr.appendChild(nlEl('th', null, h));
      }
      thead.appendChild(htr);
      table.appendChild(thead);
      const tbody = nlEl('tbody');
      for (const s of subscribers) {
        const tr = nlEl('tr');
        tr.appendChild(nlEl('td', null, s.email || ''));
        tr.appendChild(nlEl('td', null, s.name || ''));
        tr.appendChild(nlEl('td', null, s.source === 'portal' ? 'Added by you' : 'Website signup'));
        tr.appendChild(nlEl('td', null, whenLabel(s.created_at)));
        tr.appendChild(nlEl('td', null, s.status === 'unsubscribed' ? 'Unsubscribed' : 'Subscribed'));
        const actions = nlEl('td');
        const toggle = nlEl('button', 'btn ghost small', s.status === 'unsubscribed' ? 'Resubscribe' : 'Unsubscribe');
        toggle.type = 'button';
        toggle.addEventListener('click', async () => {
          try {
            await api(`/modules/newsletter/subscribers/${encodeURIComponent(s.id)}/status`, {
              method: 'POST',
              body: JSON.stringify({ status: s.status === 'unsubscribed' ? 'active' : 'unsubscribed' }),
            });
            moduleMsg(s.status === 'unsubscribed' ? 'Subscriber resubscribed.' : 'Subscriber unsubscribed.', true);
            await refresh();
          } catch (e) {
            moduleMsg(errText(e), false);
          }
        });
        const remove = nlEl('button', 'btn ghost small', 'Remove');
        remove.type = 'button';
        remove.addEventListener('click', async () => {
          if (!window.confirm(`Remove ${s.email} from the list entirely?`)) return;
          try {
            await api(`/modules/newsletter/subscribers/${encodeURIComponent(s.id)}`, { method: 'DELETE' });
            moduleMsg('Subscriber removed.', true);
            await refresh();
          } catch (e) {
            moduleMsg(errText(e), false);
          }
        });
        actions.appendChild(toggle);
        actions.appendChild(document.createTextNode(' '));
        actions.appendChild(remove);
        tr.appendChild(actions);
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      const scroll = nlEl('div');
      scroll.style.overflowX = 'auto';
      scroll.appendChild(table);
      host.appendChild(scroll);
      if (counts.total > 50) {
        const off = moduleState.nlOffset || 0;
        const pager = nlEl('div', 'pagination');
        pager.style.marginTop = '8px';
        const prev = nlEl('button', 'btn small', '← Newer');
        prev.type = 'button';
        prev.disabled = off <= 0;
        prev.addEventListener('click', async () => {
          const nextOff = Math.max(0, off - 50);
          try {
            const r = await api(`/modules/newsletter/subscribers?limit=50&offset=${nextOff}`);
            moduleState.nlSubscribers = Array.isArray(r.subscribers) ? r.subscribers : [];
            moduleState.nlOffset = nextOff;
            renderNewsletterAdminPanel();
          } catch (e) {
            moduleMsg(errText(e), false);
          }
        });
        const next = nlEl('button', 'btn small', 'Older →');
        next.type = 'button';
        next.disabled = off + subscribers.length >= counts.total;
        next.addEventListener('click', async () => {
          const nextOff = off + 50;
          try {
            const r = await api(`/modules/newsletter/subscribers?limit=50&offset=${nextOff}`);
            moduleState.nlSubscribers = Array.isArray(r.subscribers) ? r.subscribers : [];
            moduleState.nlOffset = nextOff;
            renderNewsletterAdminPanel();
          } catch (e) {
            moduleMsg(errText(e), false);
          }
        });
        pager.appendChild(prev);
        pager.appendChild(
          nlEl('span', 'hint', ` ${off + 1}–${off + subscribers.length} of ${counts.total} `)
        );
        pager.appendChild(next);
        host.appendChild(pager);
      }
    }

    /* ---- Sent issues ---- */
    const sendsH = nlEl('h3', null, 'Sent issues');
    sendsH.style.marginTop = '18px';
    host.appendChild(sendsH);
    if (!sends.length) {
      host.appendChild(nlEl('p', 'hint', 'No issues sent yet.'));
    } else {
      const table = nlEl('table');
      const thead = nlEl('thead');
      const htr = nlEl('tr');
      for (const h of ['Date', 'Subject', 'Recipients', 'Sent', 'Failed', 'From']) {
        htr.appendChild(nlEl('th', null, h));
      }
      thead.appendChild(htr);
      table.appendChild(thead);
      const tbody = nlEl('tbody');
      for (const s of sends) {
        const tr = nlEl('tr');
        tr.appendChild(nlEl('td', null, whenLabel(s.created_at)));
        tr.appendChild(nlEl('td', null, s.subject || ''));
        tr.appendChild(nlEl('td', null, String(s.recipient_count != null ? s.recipient_count : '')));
        tr.appendChild(nlEl('td', null, String(s.sent_count != null ? s.sent_count : '')));
        tr.appendChild(nlEl('td', null, String(s.failed_count != null ? s.failed_count : '')));
        tr.appendChild(
          nlEl('td', null, s.from_name ? `${s.from_name} <${s.from_email || ''}>` : s.from_email || '')
        );
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      const scroll = nlEl('div');
      scroll.style.overflowX = 'auto';
      scroll.appendChild(table);
      host.appendChild(scroll);
    }
  }

  function renderCallTrackingAdminPanel() {
    const host = document.getElementById('modules-calltracking-panel');
    if (!host) return;
    if (moduleState.current !== 'calltracking') {
      host.innerHTML = '';
      return;
    }
    const data = moduleState.calltracking || {};
    const calls = Array.isArray(data.calls) ? data.calls : [];
    const wsId = data.workspace_id || '';
    const whenLabel = (v) => {
      const t = Date.parse(String(v || '').replace(' ', 'T') + (String(v || '').includes('T') ? '' : 'Z'));
      return Number.isFinite(t) ? new Date(t).toLocaleString() : '';
    };
    const durLabel = (sec) => {
      if (sec == null || sec === '') return '—';
      const n = Math.max(0, Math.round(Number(sec) || 0));
      return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
    };
    const callsHtml = calls.length
      ? calls
          .map((c) => {
            const rec = c.recording_url
              ? `<div style="margin-top:6px"><audio controls preload="none" src="/api/v1/calls/recording-file/${esc(wsId)}/${esc(c.call_sid)}" style="max-width:320px;width:100%"></audio></div>`
              : '';
            const transcript = c.transcript
              ? `<div style="margin-top:6px"><strong>Transcript</strong><div>${esc(c.transcript)}</div></div>`
              : '<div class="hint" style="margin-top:6px">No transcript</div>';
            const vmBadge = c.is_voicemail
              ? ' <span style="display:inline-block;padding:1px 8px;border-radius:999px;background:var(--warn-soft,#fff3d2);border:1px solid var(--gold,#f0b429);color:var(--ink,#1c140f);font-size:.78rem;font-weight:600">Voicemail</span>'
              : '';
            const vmLength =
              c.is_voicemail && c.recording_duration != null
                ? ` · Message: ${esc(durLabel(c.recording_duration))}`
                : '';
            return `
        <div style="padding:10px 0;border-bottom:1px solid var(--line,#e6e0d8)">
          <div class="row" style="justify-content:space-between;gap:8px">
            <div><strong>${esc(c.from_number || 'Unknown caller')}</strong>${vmBadge} <span class="hint">→ ${esc(c.to_number || '')}</span></div>
            <span class="hint">${esc(whenLabel(c.created_at))}</span>
          </div>
          <div class="hint">Status: ${esc(c.status || '')} · Duration: ${esc(durLabel(c.duration_seconds))}${vmLength}${c.verified ? '' : ' · unverified'}</div>
          ${rec}
          ${transcript}
        </div>`;
          })
          .join('')
      : '<p class="hint">No calls yet. When someone calls your tracking number, the call shows up here — and the caller is saved as a LeadScout contact.</p>';
    const billing = data.billing || null;
    const allowanceLabel = billing && billing.allowance >= 100000 ? 'unlimited' : billing ? billing.allowance : '';
    const billingHtml = billing
      ? `<p class="hint">Answered this month: <strong>${esc(billing.answered)} / ${esc(allowanceLabel)}</strong>${
          billing.overage_due_credits > 0
            ? ` · Overage due: <strong>${esc(billing.overage_due_credits)} credits</strong>`
            : ''
        }</p>`
      : '';
    const websiteNumber = String(data.display_number || '').trim();
    const websiteNumberDisplay = websiteNumber.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, '($1) $2-$3');
    const leadContactTipHtml = websiteNumber
      ? `<aside class="calltracking-new-lead-card" style="margin:16px 0;padding:16px 18px;border:1.5px solid var(--gold,#f0b429);border-left:6px solid var(--teal,#0e7a68);border-radius:16px;background:linear-gradient(135deg,var(--warn-soft,#fff3d2),var(--paper,#fffaf4));box-shadow:var(--shadow,0 8px 18px rgba(80,40,20,.06));color:var(--ink,#1c140f)">
          <h4 style="margin:0 0 6px;font-family:Fraunces,Georgia,serif;font-size:1.08rem;line-height:1.25">Know when a website lead calls</h4>
          <p style="margin:0">Save your website number <strong>${esc(websiteNumberDisplay)}</strong> in your phone contacts as <strong>New Lead</strong>. When a call comes from your website, your phone will show 'New Lead' — so you always know it's a customer, not a stranger.</p>
        </aside>`
      : `<aside class="calltracking-new-lead-card is-muted" style="margin:16px 0;padding:16px 18px;border:1px dashed var(--border-strong,#d3bf9d);border-radius:16px;background:var(--cream,#f3eadf);color:var(--muted,#5c5148)">
          <h4 style="margin:0 0 6px;font-family:Fraunces,Georgia,serif;font-size:1.08rem;line-height:1.25">Know when a website lead calls</h4>
          <p style="margin:0">Once your website number is set up here, save it in your phone as 'New Lead' so website calls are easy to spot.</p>
        </aside>`;
    // Batch 25c split: the client controls exactly one thing — their
    // own phone number. Forwarding is set up by BitPype (admin side).
    const formHtml = `
      <div class="field"><label>Your phone number</label>
        <input type="tel" id="calltracking-phone-number" value="${esc(data.phone_number || '')}" placeholder="+16105550100" /></div>
      <p class="hint">This is the number your website shows as its call button, and the phone your calls ring. BitPype sets up the forwarding for you — there is nothing else to configure.</p>
      <div class="row" style="gap:6px">
        <button type="button" class="btn soft small" id="btn-calltracking-phone-save">Save my number</button>
      </div>
      ${
        data.tracking_assigned
          ? '<p class="hint" style="margin-top:8px">Call forwarding is active — a BitPype tracking number routes your website calls to this phone, and every call is logged below.</p>'
          : '<p class="hint" style="margin-top:8px">Save your number and we will finish setting up call forwarding for your site.</p>'
      }
      <div class="field" style="margin-top:14px"><label style="display:flex;gap:8px;align-items:flex-start;font-weight:600">
        <input type="checkbox" id="calltracking-rescue-enabled" ${data.rescue_enabled ? 'checked' : ''} style="margin-top:3px" />
        <span>Missed-Call Rescue — never lose a job to a missed call</span></label>
        <p class="hint" style="margin-top:6px">When a call to your website number is missed, we text the caller back within about a minute and can book the job straight into your appointments. If they don't reply, we call them. It also follows up on open estimates. Rescue only runs while call tracking is set up on your site.</p>
      </div>`;
    host.innerHTML = `
      <h3>Call Tracking</h3>
      <p class="hint">Your site shows your phone number as its call button. Calls ring your phone — and every call is logged here.</p>
      ${billingHtml}
      ${formHtml}
      ${leadContactTipHtml}
      <h3 style="margin-top:18px">Calls received</h3>
      <div id="modules-calltracking-calls">${callsHtml}</div>
      <div class="pagination" style="margin-top:8px"><button type="button" class="btn small" id="calls-prev" ${(moduleState.callOffset || 0) <= 0 ? 'disabled' : ''}>← Newer</button> <button type="button" class="btn small" id="calls-next" ${calls.length < 50 ? 'disabled' : ''}>Older →</button></div>`;
    // Batch 45 — calls pager wiring (server pages of 50).
    const cPrev = document.getElementById('calls-prev');
    const cNext = document.getElementById('calls-next');
    if (cPrev) cPrev.onclick = () => pagerLoad('callOffset', Math.max(0, (moduleState.callOffset || 0) - 50));
    if (cNext) cNext.onclick = () => pagerLoad('callOffset', (moduleState.callOffset || 0) + 50);
  }

  function memberRowHtml(m, tiers) {
    const whenLabel = (v) => {
      const t = Date.parse(String(v || '').replace(' ', 'T') + (String(v || '').includes('T') ? '' : 'Z'));
      return Number.isFinite(t) ? new Date(t).toLocaleDateString() : '';
    };
    const pillCls = (s) => (s === 'active' ? '' : s === 'pending' ? ' warn' : ' bad');
    const tierName = (id) => {
      const t = (tiers || []).find((x) => Number(x.id) === Number(id));
      return t ? t.name : '';
    };
    const sub = m.subscription || null;
    let planHtml = '';
    if (m.plan_source === 'comp') {
      planHtml = `<span class="status-pill">Comp${m.comp_tier_id ? ' · ' + esc(tierName(m.comp_tier_id)) : ''}</span>`;
      if (m.comp_until) planHtml += ` <span class="hint">until ${esc(whenLabel(m.comp_until))}</span>`;
    } else if (sub) {
      planHtml = `<span class="status-pill">${esc(sub.tier_name || 'Member')}</span>`;
      if (sub.cancel_at_period_end)
        planHtml += ` <span class="hint">cancels at period end${sub.current_period_end ? ' (' + esc(whenLabel(sub.current_period_end)) + ')' : ''}</span>`;
      else if (sub.current_period_end) planHtml += ` <span class="hint">renews ${esc(whenLabel(sub.current_period_end))}</span>`;
      if (sub.status && sub.status !== 'active' && sub.status !== 'trialing')
        planHtml += ` <span class="status-pill bad">${esc(sub.status)}</span>`;
    } else if (m.plan_label && m.plan_label !== '—') {
      planHtml = `<span class="status-pill">${esc(m.plan_label)}</span>`;
    }
    const canCancel =
      sub && (sub.status === 'active' || sub.status === 'trialing') && !sub.cancel_at_period_end;
    return `
        <div class="row" style="justify-content:space-between;gap:8px;padding:8px 0;border-bottom:1px solid var(--line,#e6e0d8);flex-wrap:wrap">
          <div>
            <strong>${esc(m.name || m.email)}</strong>
            <span class="status-pill${pillCls(m.status)}">${esc(m.status)}</span>
            ${planHtml}
            <div class="hint">${esc(m.email)} · joined ${esc(whenLabel(m.created_at))}${m.last_login_at ? ` · last login ${esc(whenLabel(m.last_login_at))}` : ' · never logged in'}</div>
          </div>
          <div class="row" style="gap:6px;align-items:flex-start">
            ${m.status === 'pending' ? `<button type="button" class="btn soft small" data-member-status="${m.id}" data-status="active">Approve</button>` : ''}
            ${m.status === 'active' ? `<button type="button" class="btn ghost small" data-member-status="${m.id}" data-status="disabled">Disable</button>` : ''}
            ${m.status === 'disabled' ? `<button type="button" class="btn soft small" data-member-status="${m.id}" data-status="active">Reactivate</button>` : ''}
            ${canCancel ? `<button type="button" class="btn ghost small" data-member-cancel-sub="${m.id}">Cancel subscription</button>` : ''}
            ${
              tiers && tiers.length
                ? m.comp_tier_id
                  ? `<button type="button" class="btn ghost small" data-member-comp-revoke="${m.id}">Revoke comp</button>`
                  : `<details><summary class="btn ghost small" style="display:inline-block;cursor:pointer">Comp…</summary>
                      <div class="row" style="gap:6px;margin-top:6px">
                        <select data-comp-tier="${m.id}">${tiers.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select>
                        <input type="date" data-comp-until="${m.id}" title="Comp expires (optional)" />
                        <button type="button" class="btn soft small" data-member-comp-grant="${m.id}">Grant comp</button>
                      </div>
                      <p class="hint">Free access to the picked tier. Leave the date empty for no expiry.</p>
                    </details>`
                : ''
            }
            <button type="button" class="btn ghost small" data-member-delete="${m.id}">Delete</button>
          </div>
        </div>`;
  }

  function renderMembersAdminPanel() {
    const host = document.getElementById('modules-members-panel');
    if (!host) return;
    if (moduleState.current !== 'members') {
      host.innerHTML = '';
      return;
    }
    const pack = moduleState.members || {};
    const cfg = pack.config || {};
    const counts = pack.counts || { total: 0, active: 0, pending: 0, disabled: 0 };
    const allMembers = Array.isArray(pack.members) ? pack.members : [];
    const pages = Array.isArray(moduleState.pages) ? moduleState.pages : [];
    const membersSlug = (moduleState.embed && moduleState.embed.target_page_slug) || 'members';
    const gated = new Set(cfg.gated_pages || []);
    const publics = new Set(cfg.public_pages || []);
    const whenLabel = (v) => {
      const t = Date.parse(String(v || '').replace(' ', 'T') + (String(v || '').includes('T') ? '' : 'Z'));
      return Number.isFinite(t) ? new Date(t).toLocaleDateString() : '';
    };
    const pageChecks = (name, chosen) =>
      pages.length
        ? pages
            .map((p) => {
              const isMembersPage = p.slug === membersSlug;
              return `<label class="booking-hour-row">
            <input type="checkbox" data-members-page="${esc(name)}" value="${esc(p.slug)}" ${chosen.has(p.slug) ? 'checked' : ''} ${isMembersPage && name === 'gated' ? 'disabled' : ''} />
            <span>${esc(p.title || p.slug)} <span class="hint">(${esc(p.slug)})</span>${isMembersPage ? ' <span class="hint">— always public, members sign in here</span>' : ''}</span>
          </label>`;
            })
            .join('')
        : '<p class="hint">No pages found on your site yet.</p>';
    const search = String(moduleState.memberSearch || '').toLowerCase();
    const shown = search
      ? allMembers.filter(
          (m) => (m.email || '').toLowerCase().includes(search) || (m.name || '').toLowerCase().includes(search)
        )
      : allMembers;
    const tiers = Array.isArray(pack.tiers) ? pack.tiers : [];
    const rowsHtml = shown.length
      ? shown.map((m) => memberRowHtml(m, tiers)).join('')
      : `<p class="hint">${allMembers.length ? 'No members match your search.' : 'No members yet. Visitors join from your site’s Members page — new accounts appear here.'}</p>`;
    const payments = pack.payments || { connected: false };
    const revenue = pack.revenue || { active_paid_members: 0, est_monthly_revenue_cents: 0 };
    const money = (cents) => {
      const n = (Number(cents) || 0) / 100;
      try {
        return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
      } catch {
        return '$' + n.toFixed(2);
      }
    };
    const webhookUrl = `${location.origin}${pack.webhook_path || ''}`;
    const webhookEvents =
      'checkout.session.completed, customer.subscription.created, customer.subscription.updated, customer.subscription.deleted, invoice.paid, invoice.payment_failed';
    const editingTier = moduleState.memberTierEditing || null;
    const tierPriceDollars = editingTier ? String((Number(editingTier.price_cents) || 0) / 100) : '';
    const tierRowsHtml = tiers.length
      ? tiers
          .map((t) => {
            const needsStripe = t.price_cents > 0 && !t.stripe_price_id;
            const state = !t.active
              ? '<span class="status-pill bad">Off</span>'
              : needsStripe
                ? '<span class="status-pill warn">Needs Stripe</span>'
                : '<span class="status-pill">Active</span>';
            return `
        <div class="row" style="justify-content:space-between;gap:8px;padding:8px 0;border-bottom:1px solid var(--line,#e6e0d8);flex-wrap:wrap">
          <div>
            <strong>${esc(t.name)}</strong> ${state}
            <div class="hint">${t.price_cents > 0 ? `${esc(t.price_label)} / ${esc(t.interval)}` : 'Free'}${t.description ? ' · ' + esc(t.description) : ''}</div>
          </div>
          <div class="row" style="gap:6px">
            <button type="button" class="btn ghost small" data-tier-edit="${t.id}">Edit</button>
            <button type="button" class="btn ghost small" data-tier-delete="${t.id}">Delete</button>
          </div>
        </div>`;
          })
          .join('')
      : '<p class="hint">No membership plans yet. Add a free plan, or a paid plan once your Stripe is connected below.</p>';
    host.innerHTML = `
      <h3>Membership</h3>
      <p class="hint">Let visitors create accounts on your site, and keep chosen pages — or the whole site — for members only. Gated content stays on the server until a member logs in; it is never just hidden on the page.</p>
      <p class="hint"><strong>${counts.active}</strong> active · <strong>${counts.pending}</strong> waiting for approval · <strong>${counts.disabled}</strong> disabled</p>
      <div class="field"><label>Who can see your site?</label>
        <select id="members-gate-mode">
          <option value="off"${cfg.gate_mode === 'off' ? ' selected' : ''}>Everyone — no pages are gated</option>
          <option value="selected"${cfg.gate_mode === 'selected' ? ' selected' : ''}>Only the pages I pick below are members-only</option>
          <option value="whole_site"${cfg.gate_mode === 'whole_site' ? ' selected' : ''}>The whole site is members-only (except pages I keep public)</option>
        </select></div>
      <div class="field"><label>Members-only pages <span class="hint">(used when you pick pages above)</span></label>
        <div id="members-gated-pages">${pageChecks('gated', gated)}</div></div>
      <div class="field"><label>Always-public pages <span class="hint">(used when the whole site is members-only)</span></label>
        <div id="members-public-pages">${pageChecks('public', publics)}</div></div>
      <div class="field"><label>New accounts</label>
        <select id="members-signup-mode">
          <option value="open"${cfg.signup_mode !== 'approval' ? ' selected' : ''}>Open — anyone can join and log in right away</option>
          <option value="approval"${cfg.signup_mode === 'approval' ? ' selected' : ''}>Approval — new members wait until I approve them below</option>
        </select></div>
      <div class="field"><label>Who gets into members-only pages?</label>
        <select id="members-access-level">
          <option value="any_member"${cfg.access_level !== 'any_paid' && cfg.access_level !== 'tier' ? ' selected' : ''}>Any member — logging in is enough</option>
          <option value="any_paid"${cfg.access_level === 'any_paid' ? ' selected' : ''}>Paid members — an active paid plan (or a comp from you)</option>
          <option value="tier"${cfg.access_level === 'tier' ? ' selected' : ''}>Members of one specific plan, picked here</option>
        </select></div>
      <div class="field"><label>Plan that unlocks gated pages <span class="hint">(used when you pick “one specific plan” above)</span></label>
        ${
          tiers.length
            ? `<select id="members-access-tier">${tiers.map((t) => `<option value="${t.id}"${Number(cfg.access_tier_id) === Number(t.id) ? ' selected' : ''}>${esc(t.name)} — ${t.price_cents > 0 ? esc(t.price_label) + ' / ' + esc(t.interval) : 'Free'}</option>`).join('')}</select>`
            : '<p class="hint">No plans yet — add one under Membership plans below first.</p>'
        }
      </div>
      <div class="field"><label>Message on the login wall</label>
        <input type="text" id="members-wall-headline" value="${esc(cfg.wall_headline || '')}" maxlength="140" /></div>
      <div class="row" style="gap:6px">
        <button type="button" class="btn soft small" id="btn-members-config-save">Save membership settings</button>
      </div>
      <p class="hint">Settings apply the next time your site is published or re-exported. Your own portal preview always shows the full site.</p>
      <h3 style="margin-top:18px">Membership plans</h3>
      <p class="hint">Plans are what visitors join on your Members page. Paid plans are charged through your own Stripe account (below) — the money goes straight to you.</p>
      <p class="hint">Estimated monthly revenue: <strong>${money(revenue.est_monthly_revenue_cents)}</strong> from ${revenue.active_paid_members} active paid member(s) — an estimate from your current subscriptions.</p>
      <div id="modules-tiers-list">${tierRowsHtml}</div>
      <div class="field"><label>${editingTier ? 'Edit plan' : 'Add a plan'}</label>
        <input type="text" id="tier-name" placeholder="Plan name (e.g. Gold)" value="${editingTier ? esc(editingTier.name) : ''}" maxlength="120" /></div>
      <div class="field"><label>Description <span class="hint">(optional)</span></label>
        <input type="text" id="tier-description" placeholder="What members get" value="${editingTier ? esc(editingTier.description || '') : ''}" maxlength="1000" /></div>
      <div class="row" style="gap:8px;flex-wrap:wrap">
        <div class="field" style="flex:1;min-width:140px"><label>Price (USD) <span class="hint">0 = free</span></label>
          <input type="text" id="tier-price" inputmode="decimal" placeholder="0" value="${esc(tierPriceDollars)}" /></div>
        <div class="field" style="flex:1;min-width:140px"><label>Billing</label>
          <select id="tier-interval">
            <option value="month"${!editingTier || editingTier.interval !== 'year' ? ' selected' : ''}>Monthly</option>
            <option value="year"${editingTier && editingTier.interval === 'year' ? ' selected' : ''}>Yearly</option>
          </select></div>
        <div class="field" style="flex:1;min-width:120px"><label>Available to join</label>
          <select id="tier-active">
            <option value="1"${!editingTier || editingTier.active ? ' selected' : ''}>On</option>
            <option value="0"${editingTier && !editingTier.active ? ' selected' : ''}>Off</option>
          </select></div>
      </div>
      <div class="row" style="gap:6px">
        <button type="button" class="btn soft small" id="btn-tier-save">${editingTier ? 'Save plan' : 'Add plan'}</button>
        ${editingTier ? '<button type="button" class="btn ghost small" id="btn-tier-edit-cancel">Cancel edit</button>' : ''}
      </div>
      <h3 style="margin-top:18px">Payments — your Stripe account</h3>
      ${
        payments.connected
          ? `<p class="hint"><strong>Connected.</strong> Your secret key ending ••••${esc(payments.secret_key_last4 || '')} is saved (encrypted). Members pay you directly through your own Stripe account.${payments.webhook_configured ? '' : ' <strong>Your webhook signing secret is still missing</strong> — paid memberships cannot be confirmed until it is saved.'}</p>`
          : '<p class="hint"><strong>Not connected.</strong> Free plans work without Stripe. To charge for paid plans, paste your own Stripe keys — the money goes straight to your Stripe account, never through BitPype.</p>'
      }
      <div class="field"><label>Publishable key</label>
        <input type="text" id="membership-pk" placeholder="pk_live_…" value="${esc(payments.publishable_key || '')}" autocomplete="off" /></div>
      <div class="field"><label>Secret key ${payments.connected ? '<span class="hint">(leave blank to keep the saved key)</span>' : ''}</label>
        <input type="password" id="membership-sk" placeholder="sk_live_…" autocomplete="off" /></div>
      <div class="field"><label>Webhook signing secret ${payments.webhook_configured ? '<span class="hint">(leave blank to keep the saved secret)</span>' : ''}</label>
        <input type="password" id="membership-whsec" placeholder="whsec_…" autocomplete="off" /></div>
      <div class="row" style="gap:6px">
        <button type="button" class="btn soft small" id="btn-membership-keys-save">Save Stripe keys</button>
        ${payments.connected ? '<button type="button" class="btn ghost small" id="btn-membership-keys-clear">Disconnect Stripe</button>' : ''}
      </div>
      <div class="field" style="margin-top:10px"><label>Your webhook URL <span class="hint">(add this in your Stripe dashboard → Developers → Webhooks)</span></label>
        <div class="row" style="gap:6px">
          <input type="text" id="membership-webhook-url" readonly value="${esc(webhookUrl)}" style="flex:1" />
          <button type="button" class="btn ghost small" data-copy-input="membership-webhook-url">Copy</button>
        </div></div>
      <div class="field"><label>Webhook events to subscribe</label>
        <div class="row" style="gap:6px">
          <input type="text" readonly value="${esc(webhookEvents)}" style="flex:1" />
          <button type="button" class="btn ghost small" data-copy-text="${esc(webhookEvents)}">Copy</button>
        </div>
        <p class="hint">Stripe sends these to confirm payments, renewals, and cancellations so member access stays in sync.</p></div>
      <h3 style="margin-top:18px">Members</h3>
      <div class="field"><input type="search" id="members-search" placeholder="Search by name or email…" value="${esc(moduleState.memberSearch || '')}" /></div>
      <div id="modules-members-list">${rowsHtml}</div>
      <div class="pagination" style="margin-top:8px"><button type="button" class="btn small" id="members-prev" ${(moduleState.memberOffset || 0) <= 0 ? 'disabled' : ''}>← Newer</button> <span class="hint">${counts.total ? `Members ${(moduleState.memberOffset || 0) + 1}–${(moduleState.memberOffset || 0) + allMembers.length} of ${counts.total}` : ''}</span> <button type="button" class="btn small" id="members-next" ${allMembers.length < 50 ? 'disabled' : ''}>Older →</button></div>`;
    // Batch 45 — members pager wiring (server pages of 50).
    const mPrev = document.getElementById('members-prev');
    const mNext = document.getElementById('members-next');
    if (mPrev) mPrev.onclick = () => pagerLoad('memberOffset', Math.max(0, (moduleState.memberOffset || 0) - 50));
    if (mNext) mNext.onclick = () => pagerLoad('memberOffset', (moduleState.memberOffset || 0) + 50);
  }

  function moduleModalMsg(text, ok) {
    const el = document.getElementById('msg-modules-modal');
    if (!el) return;
    el.className = ok ? 'msg ok' : text ? 'msg err' : 'msg';
    el.textContent = text || '';
  }

  // Batch 78: the item editor is the #/module-item page now — closing
  // it means going back to the Modules page it was opened from.
  function closeModuleModal() {
    moduleState.editingId = null;
    moduleModalMsg('', true);
    showPortalPanel('modules');
  }

  function updateModuleImagePreview(key, url) {
    const fields = document.getElementById('modules-fields');
    if (!fields) return;
    const wrap = fields.querySelector(`[data-mod-image-wrap="${key}"] .mod-image-preview`);
    if (!wrap) return;
    const u = String(url || '').trim();
    wrap.innerHTML = u ? `<img src="${esc(u)}" alt="" />` : '<span class="hint">No image</span>';
  }

  function renderModuleFieldHtml(d, src) {
    const val = src[d.key] != null ? src[d.key] : '';
    if (d.kind === 'image') {
      const u = String(val || '').trim();
      return `<div class="field mod-image-field" data-mod-image-wrap="${d.key}">
        <label>${esc(d.label)}</label>
        <div class="mod-image-row">
          <div class="mod-image-preview">${u ? `<img src="${esc(u)}" alt="" />` : '<span class="hint">No image</span>'}</div>
          <div class="mod-image-actions">
            <button type="button" class="btn soft small" data-mod-upload="${d.key}">Upload photo</button>
            <input type="file" accept="image/jpeg,image/png,image/webp,image/gif" data-mod-file="${d.key}" hidden />
            <details class="mod-image-url-fallback">
              <summary class="hint">Or paste image URL</summary>
              <input data-mod-field="${d.key}" type="url" value="${esc(u)}" placeholder="https://…" />
            </details>
          </div>
        </div>
      </div>`;
    }
    if (d.kind === 'files') {
      const existing = src.file_name
        ? `<p class="hint">Current file: ${esc(src.file_name)}${src.has_file ? '' : ''}</p>`
        : '';
      return `<div class="field mod-files-field" data-mod-files-wrap="${d.key}">
        <label>${esc(d.label)}</label>
        ${existing}
        <input type="file" multiple accept="${esc(d.accept || '*/*')}" data-mod-files="${d.key}" />
        <p class="hint" data-mod-files-list="${d.key}">No files selected yet.</p>
        ${d.hint ? `<p class="hint">${esc(d.hint)}</p>` : ''}
      </div>`;
    }
    if (d.kind === 'textarea') {
      return `<div class="field"><label>${esc(d.label)}</label><textarea data-mod-field="${d.key}" rows="4">${esc(val)}</textarea></div>`;
    }
    if (d.kind === 'select') {
      const opts = (d.options || [])
        .map((o) => {
          // Batch 122: options may be {value, label} pairs (the event
          // editor's gallery picker) as well as plain strings.
          const ov = o && typeof o === 'object' ? String(o.value) : String(o);
          const ol = o && typeof o === 'object' ? String(o.label != null ? o.label : o.value) : String(o);
          return `<option value="${esc(ov)}"${String(val) === ov ? ' selected' : ''}>${esc(ol)}</option>`;
        })
        .join('');
      return `<div class="field"><label>${esc(d.label)}</label><select data-mod-field="${d.key}">${opts}</select>${d.hint ? `<p class="hint">${esc(d.hint)}</p>` : ''}</div>`;
    }
    if (d.kind === 'checkboxes') {
      // Batch 124: multi-value picker (the item editors' category
      // assignments). Values ride a distinct attribute so
      // collectModuleFields can gather them into one array.
      const chosen = Array.isArray(val) ? val.map((v) => String(v)) : [];
      const boxes = (d.options || [])
        .map((o) => {
          const ov = o && typeof o === 'object' ? String(o.value) : String(o);
          const ol = o && typeof o === 'object' ? String(o.label != null ? o.label : o.value) : String(o);
          return `<label class="mod-check"><input type="checkbox" data-mod-field-multi="${d.key}" value="${esc(ov)}"${chosen.includes(ov) ? ' checked' : ''} /> ${esc(ol)}</label>`;
        })
        .join('');
      return `<div class="field"><label>${esc(d.label)}</label><div class="mod-check-group">${boxes}</div>${d.hint ? `<p class="hint">${esc(d.hint)}</p>` : ''}</div>`;
    }
    const req = d.required ? ' required' : '';
    return `<div class="field"><label>${esc(d.label)}</label><input data-mod-field="${d.key}" type="text" value="${esc(val)}" placeholder="${esc(d.placeholder || '')}"${req} /></div>`;
  }

  async function uploadModuleFieldImage(key, file) {
    const prepared = await resizeImageForUpload(file, 1600);
    const result = await api('/modules/upload-image', {
      method: 'POST',
      body: JSON.stringify({ data: prepared.data, mimeType: prepared.mimeType }),
    });
    const url = (result && (result.publicUrl || result.url)) || '';
    const fields = document.getElementById('modules-fields');
    const input = fields && fields.querySelector(`[data-mod-field="${key}"]`);
    if (input) input.value = url;
    updateModuleImagePreview(key, url);
    return url;
  }

  function wireModuleFieldUploads() {
    const fields = document.getElementById('modules-fields');
    if (!fields) return;
    fields.querySelectorAll('[data-mod-upload]').forEach((btn) => {
      btn.onclick = () => {
        const key = btn.getAttribute('data-mod-upload');
        const fileInput = fields.querySelector(`[data-mod-file="${key}"]`);
        if (fileInput) fileInput.click();
      };
    });
    fields.querySelectorAll('[data-mod-file]').forEach((input) => {
      input.onchange = async () => {
        const file = input.files && input.files[0];
        input.value = '';
        if (!file) return;
        const key = input.getAttribute('data-mod-file');
        moduleModalMsg('Uploading photo…', true);
        try {
          await uploadModuleFieldImage(key, file);
          moduleModalMsg('Photo uploaded.', true);
        } catch (e) {
          moduleModalMsg(errText(e), false);
        }
      };
    });
    fields.querySelectorAll('[data-mod-files]').forEach((input) => {
      input.onchange = () => {
        const key = input.getAttribute('data-mod-files');
        const list = input.files ? Array.from(input.files) : [];
        moduleState.pendingKnowledgeFiles = list;
        const label = fields.querySelector(`[data-mod-files-list="${key}"]`);
        if (label) {
          label.textContent = list.length
            ? `${list.length} file${list.length === 1 ? '' : 's'} selected: ${list.map((f) => f.name).join(', ')}`
            : 'No files selected yet.';
        }
        const kindSel = fields.querySelector('[data-mod-field="kind"]');
        if (kindSel && list.length) kindSel.value = 'doc';
        const titleInput = fields.querySelector('[data-mod-field="title"]');
        if (titleInput && !String(titleInput.value || '').trim() && list[0]) {
          titleInput.value = list[0].name.replace(/\.[^.]+$/, '');
        }
      };
    });
    fields.querySelectorAll('[data-mod-field]').forEach((el) => {
      if (el.type === 'url' && el.closest('[data-mod-image-wrap]')) {
        el.oninput = () => updateModuleImagePreview(el.getAttribute('data-mod-field'), el.value);
      }
    });
  }

  function openModuleEditor(item) {
    const fields = document.getElementById('modules-fields');
    const titleEl = document.getElementById('modules-modal-title');
    const ledeEl = document.getElementById('modules-modal-lede');
    const delBtn = document.getElementById('btn-modules-delete');
    if (!fields) return;
    moduleState.editingId = item && item.id ? item.id : null;
    moduleState.pendingKnowledgeFiles = [];
    const copy = moduleCopy(moduleState.current);
    const meta = MODULE_TYPES.find((m) => m.type === moduleState.current);
    if (titleEl) titleEl.textContent = moduleState.editingId ? `Edit ${copy.singular}` : copy.newBtn;
    if (ledeEl) {
      if (moduleState.current === 'chatbot') {
        ledeEl.textContent = moduleState.editingId
          ? 'Update this knowledge item. Re-upload a file to replace extracted text for the agent.'
          : 'Add a link, paste notes, or upload one or more docs (PDF, Word, Excel, PowerPoint, images, text). File text is extracted for the chat agent.';
      } else {
        ledeEl.textContent = moduleState.editingId
          ? `Update this ${copy.singular} for your ${(meta && meta.label) || 'module'}.`
          : `Fill in the details below. You can save as draft and publish when ready.`;
      }
    }
    if (delBtn) delBtn.hidden = !moduleState.editingId;
    const defs = moduleFieldDefs(moduleState.current);
    const src = item || (moduleState.current === 'chatbot' ? { status: 'active', kind: 'doc' } : { status: 'draft' });
    fields.innerHTML = defs.map((d) => renderModuleFieldHtml(d, src)).join('');
    if (
      (moduleState.current === 'ecommerce' ||
        moduleState.current === 'bookings' ||
        moduleState.current === 'pricing') &&
      item &&
      item.price_cents != null
    ) {
      const priceInput = fields.querySelector('[data-mod-field="price"]');
      if (priceInput) {
        priceInput.value = Number(item.price_cents) ? (Number(item.price_cents) / 100).toFixed(2) : '';
      }
    }
    if (moduleState.current === 'pricing' && item) {
      // Batch 139: featured rides the API as a boolean; the editor
      // select speaks Yes/No (the service accepts both).
      const featSel = fields.querySelector('[data-mod-field="featured"]');
      if (featSel) featSel.value = item.featured ? 'Yes' : 'No';
    }
    if (moduleState.current === 'ecommerce') {
      // Batch 127: the variant editor (option groups + the priced
      // matrix) rides under the generic fields; its state is gathered
      // by collectModuleFields into options/variants.
      const vWrap = document.createElement('div');
      vWrap.id = 'mod-variants-editor';
      fields.appendChild(vWrap);
      renderProductVariantEditor(item);
    }
    wireModuleFieldUploads();
    moduleModalMsg('', true);
    // Batch 78: navigate to the editor page (was: unhide a modal).
    showPortalPanel('module-item');
    const first = fields.querySelector('input, textarea, select');
    if (first) first.focus();
  }

  // ── Batch 127: product variant editor ──
  // Option groups (up to 2 axes) are edited as a name + a
  // comma-separated values line (the order typed is the order shown).
  // The matrix under them is generated from the axes; each row is one
  // purchasable variant with its own price / SKU / label /
  // availability. State lives in the DOM; collectModuleFields reads
  // it back into the exact options/variants shape the server
  // reconciles (one write path for portal, MCP and the design agent).
  let variantMatrixCombos = [];

  function variantComboKey(values) {
    return (values || []).map((v) => String(v || '').trim().toLowerCase()).join('|');
  }

  function readVariantGroupsFromDom() {
    const wrap = document.getElementById('mod-variants-editor');
    if (!wrap) return [];
    const groups = [];
    wrap.querySelectorAll('[data-var-group]').forEach((gEl) => {
      const nameEl = gEl.querySelector('[data-var-group-name]');
      const valuesEl = gEl.querySelector('[data-var-group-values]');
      const name = nameEl ? String(nameEl.value || '').trim() : '';
      const values = valuesEl
        ? String(valuesEl.value || '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
      if (name || values.length) groups.push({ name, values });
    });
    return groups;
  }

  function readVariantMatrixFromDom() {
    const wrap = document.getElementById('mod-variants-editor');
    if (!wrap) return [];
    const rows = [];
    wrap.querySelectorAll('[data-var-row]').forEach((rEl) => {
      const idx = Number(rEl.getAttribute('data-var-idx'));
      const values = variantMatrixCombos[idx];
      if (!values) return;
      const out = { values: values.slice() };
      const priceEl = rEl.querySelector('[data-var-price]');
      if (priceEl && priceEl.value !== '') out.price = Number(priceEl.value);
      const skuEl = rEl.querySelector('[data-var-sku]');
      if (skuEl && skuEl.value) out.sku = skuEl.value;
      const labelEl = rEl.querySelector('[data-var-label]');
      if (labelEl && labelEl.value) out.label = labelEl.value;
      const availEl = rEl.querySelector('[data-var-available]');
      out.available = !!(availEl && availEl.checked);
      rows.push(out);
    });
    return rows;
  }

  function renderVariantMatrix(seed) {
    const wrap = document.getElementById('mod-variants-editor');
    if (!wrap) return;
    const box = wrap.querySelector('[data-var-matrix]');
    if (!box) return;
    // Unsaved row edits survive a regeneration (seed only on open).
    const state = seed || {};
    if (!seed) {
      for (const row of readVariantMatrixFromDom()) state[variantComboKey(row.values)] = row;
    }
    const groups = readVariantGroupsFromDom().filter((g) => g.name && g.values.length);
    variantMatrixCombos = [];
    if (!groups.length) {
      box.innerHTML = '';
      return;
    }
    let combos = [[]];
    for (const g of groups) {
      const next = [];
      for (const c of combos) for (const v of g.values) next.push([...c, v]);
      combos = next;
    }
    if (combos.length > 100) {
      box.innerHTML = `<p class="hint">Those options make ${combos.length} variants — the limit is 100. Trim a value or two.</p>`;
      return;
    }
    variantMatrixCombos = combos;
    const fields = document.getElementById('modules-fields');
    const priceField = fields && fields.querySelector('[data-mod-field="price"]');
    const baseDollars = priceField && priceField.value !== '' ? Number(priceField.value) : 0;
    box.innerHTML =
      '<div class="mod-var-matrix">' +
      combos
        .map((values, i) => {
          const prev = state[variantComboKey(values)] || {};
          const dollars =
            prev.price != null
              ? String(prev.price)
              : prev.price_cents != null
                ? (Number(prev.price_cents) / 100).toFixed(2)
                : baseDollars
                  ? baseDollars.toFixed(2)
                  : '';
          return `<div class="mod-var-row" data-var-row data-var-idx="${i}">
        <span class="mod-var-combo">${esc(values.join(' · '))}</span>
        <label>Price $<input data-var-price type="text" inputmode="decimal" value="${esc(dollars)}" /></label>
        <label>SKU<input data-var-sku type="text" value="${esc(prev.sku || '')}" /></label>
        <label>Label<input data-var-label type="text" placeholder="Optional" value="${esc(prev.label || '')}" /></label>
        <label class="mod-check"><input type="checkbox" data-var-available ${prev.available === false ? '' : 'checked'} /> Available</label>
      </div>`;
        })
        .join('') +
      '</div>';
  }

  function variantGroupHtml(g) {
    return `<div class="mod-var-group" data-var-group>
      <div class="row" style="gap:6px">
        <input data-var-group-name type="text" placeholder="Option name — e.g. Pot" value="${esc(g.name || '')}" style="flex:1" />
        <button type="button" class="btn ghost small" data-var-group-up title="Move group up">↑</button>
        <button type="button" class="btn ghost small" data-var-group-down title="Move group down">↓</button>
        <button type="button" class="btn ghost small" data-var-group-remove>Remove</button>
      </div>
      <input data-var-group-values type="text" placeholder="Values, comma-separated — e.g. Nursery Pot, EcoPot" value="${esc((g.values || []).join(', '))}" />
    </div>`;
  }

  function wireProductVariantEditor() {
    const wrap = document.getElementById('mod-variants-editor');
    if (!wrap) return;
    const refreshChrome = () => {
      const count = wrap.querySelectorAll('[data-var-group]').length;
      const add = wrap.querySelector('[data-var-add-group]');
      if (add) add.disabled = count >= 2;
      const note = wrap.querySelector('[data-var-group-count]');
      if (note) note.textContent = count ? `${count} of 2 option groups` : '';
    };
    wrap.oninput = (ev) => {
      if (ev.target.closest('[data-var-group]')) renderVariantMatrix();
    };
    wrap.onclick = (ev) => {
      const add = ev.target.closest('[data-var-add-group]');
      if (add) {
        const groupsEl = wrap.querySelector('[data-var-groups]');
        if (groupsEl && wrap.querySelectorAll('[data-var-group]').length < 2) {
          groupsEl.insertAdjacentHTML('beforeend', variantGroupHtml({ name: '', values: [] }));
        }
        refreshChrome();
        return;
      }
      const groupEl = ev.target.closest('[data-var-group]');
      if (!groupEl) return;
      if (ev.target.closest('[data-var-group-remove]')) {
        groupEl.remove();
        renderVariantMatrix();
        refreshChrome();
      } else if (ev.target.closest('[data-var-group-up]')) {
        const prev = groupEl.previousElementSibling;
        if (prev) groupEl.parentNode.insertBefore(groupEl, prev);
        renderVariantMatrix();
      } else if (ev.target.closest('[data-var-group-down]')) {
        const next = groupEl.nextElementSibling;
        if (next) groupEl.parentNode.insertBefore(next, groupEl);
        renderVariantMatrix();
      }
    };
    refreshChrome();
  }

  function renderProductVariantEditor(item) {
    const wrap = document.getElementById('mod-variants-editor');
    if (!wrap) return;
    const seedGroups = ((item && item.options) || []).map((g) => ({
      name: g.name || '',
      values: (g.values || []).map((v) => (v && typeof v === 'object' ? v.value : v)),
    }));
    const seed = {};
    for (const v of (item && item.variants) || []) {
      seed[variantComboKey(v.values || [])] = {
        price_cents: v.price_cents,
        sku: v.sku || '',
        label: v.label_override || '',
        available: v.available !== false,
      };
    }
    wrap.innerHTML = `<div class="field mod-variants-field">
      <label>Options &amp; variants</label>
      <p class="hint">Options turn one product into priced variants — a plant in a Nursery Pot or an EcoPot, a Small or a Large. Buyers pick on the product page and each combination checks out at its own price. No option groups = a plain single-price product. Removing the groups removes the variants (orders already placed keep what was bought).</p>
      <div data-var-groups>${seedGroups.map(variantGroupHtml).join('')}</div>
      <div class="row" style="gap:6px;margin:6px 0"><button type="button" class="btn soft small" data-var-add-group>Add option group</button><span class="hint" data-var-group-count></span></div>
      <div data-var-matrix></div>
    </div>`;
    wireProductVariantEditor();
    renderVariantMatrix(seed);
  }

  async function fileToBase64Raw(file) {
    const data = await blobToBase64(file);
    return { data, mimeType: file.type || 'application/octet-stream', fileName: file.name };
  }

  async function uploadChatbotKnowledgeFiles(files, title) {
    const list = Array.from(files || []);
    if (!list.length) return null;
    const prepared = [];
    for (const file of list) {
      if (file.size > 5 * 1024 * 1024) {
        throw new Error(`${file.name} is over 5MB`);
      }
      prepared.push({
        ...(await fileToBase64Raw(file)),
        title: title || file.name.replace(/\.[^.]+$/, ''),
      });
    }
    return api('/modules/chatbot/knowledge/upload', {
      method: 'POST',
      body: JSON.stringify({ files: prepared, title: title || undefined }),
    });
  }

  function collectModuleFields() {
    const fields = document.getElementById('modules-fields');
    const out = {};
    if (!fields) return out;
    fields.querySelectorAll('[data-mod-field]').forEach((el) => {
      const key = el.getAttribute('data-mod-field');
      out[key] = el.value;
    });
    // Batch 124: multi-value pickers (category assignments) gather
    // their ticked boxes into one array of ids. A rendered group with
    // nothing ticked yields [] — the server reads that as "clear the
    // set" (key present = intent, the gallery_album_id discipline).
    fields.querySelectorAll('[data-mod-field-multi]').forEach((el) => {
      const key = el.getAttribute('data-mod-field-multi');
      if (!Array.isArray(out[key])) out[key] = [];
      if (el.checked) out[key].push(Number(el.value));
    });
    if (moduleState.current === 'ecommerce' && out.price != null && out.price !== '') {
      out.price = Number(out.price);
    }
    if (moduleState.current === 'ecommerce') {
      // Batch 127: the variant editor's full state is the truth on
      // every portal save (no groups = a single-price product); API
      // and agent writes keep the absent-key discipline server-side.
      const vWrap = document.getElementById('mod-variants-editor');
      if (vWrap) {
        out.options = readVariantGroupsFromDom();
        if (out.options.length) out.variants = readVariantMatrixFromDom();
      }
    }
    if (moduleState.current === 'pricing') {
      // Batch 139: an emptied price field means "no price change" —
      // dropping the key keeps the server's absent-key discipline
      // (a present-but-empty price would otherwise read as $0).
      if (out.price != null && out.price !== '') out.price = Number(out.price);
      else delete out.price;
      if (out.sort_order != null && out.sort_order !== '') out.sort_order = Number(out.sort_order);
      else delete out.sort_order;
    }
    if (moduleState.current === 'bookings') {
      if (out.price != null && out.price !== '') out.price = Number(out.price);
      if (out.duration_minutes != null && out.duration_minutes !== '') {
        out.duration_minutes = Number(out.duration_minutes);
      }
      if (out.buffer_minutes != null && out.buffer_minutes !== '') {
        out.buffer_minutes = Number(out.buffer_minutes);
      }
      if (out.rating != null && out.rating !== '') out.rating = Number(out.rating);
    }
    if (moduleState.current === 'testimonials' && out.rating != null && out.rating !== '') {
      out.rating = Number(out.rating);
    }
    if (moduleState.current === 'gallery' && out.image_url && !moduleState.editingId) {
      // Batch 128: an optional price on the first photo makes it
      // sellable through the Checkout module once the album is
      // published (price flows to addGalleryImage as dollars).
      out.images = [
        {
          image_url: out.image_url,
          ...(out.image_price != null && out.image_price !== '' ? { price: Number(out.image_price) || 0 } : {}),
        },
      ];
      delete out.image_url;
    }
    if (moduleState.current === 'gallery') delete out.image_price;
    if (moduleState.current === 'datatables') {
      // Batch 88: the editor fields are the table's columns — ship them
      // as one values object (the server validates types per column).
      const cols = ((moduleState.datatable || {}).columns) || [];
      const values = {};
      for (const col of cols) {
        if (out[col.key] != null) values[col.key] = out[col.key];
      }
      const res = { values };
      if (out.status) res.status = out.status;
      return res;
    }
    if (moduleState.current === 'charts') {
      // Batch 90: value columns travel as an array; everything else is
      // already in a server-accepted shape (comma strings for colors
      // and series names, Yes/No toggles, data_text lines).
      if (typeof out.value_columns === 'string') {
        out.value_columns = out.value_columns
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
      }
    }
    return out;
  }

  function patchBookingsNavCount(activeCount) {
    const list = moduleState.summary && Array.isArray(moduleState.summary.modules) ? moduleState.summary.modules : null;
    if (!list) return;
    const row = list.find((x) => x && x.type === 'bookings');
    if (!row) return;
    row.count = Math.max(0, Number(activeCount) || 0);
    renderModuleTypeTabs();
  }

  async function loadModuleItems() {
    const type = moduleState.current;
    storeModuleType(type);
    if (type === 'events') {
      // Batch 122: the event editor's gallery picker reads the shared
      // layer (this lead's published albums). Failure = no albums to
      // offer, never a broken editor.
      try {
        const shared = await api('/modules/shared/items?source=gallery&limit=100');
        moduleState.sharedAlbums = Array.isArray(shared.items) ? shared.items : [];
      } catch {
        moduleState.sharedAlbums = [];
      }
    }
    if (['blog', 'events', 'gallery', 'offers', 'directory', 'categories'].includes(type)) {
      // Batch 124: the category pickers read the shared taxonomy
      // (this lead's categories, every scope). Failure = no picker,
      // never a broken editor.
      try {
        const cats = await api('/modules/categories');
        moduleState.allCategories = Array.isArray(cats.items) ? cats.items : [];
      } catch {
        moduleState.allCategories = [];
      }
    }
    // Batch 45 — blog/members/calls fetch ONE server page at a time
    // (6/50/50) instead of the whole history.
    let qs = type === 'bookings' && moduleState.showArchivedAppointments ? '?includeArchived=1' : '';
    if (type === 'blog') qs = `?limit=6&offset=${moduleState.blogOffset || 0}`;
    if (type === 'members') qs = `?limit=50&offset=${moduleState.memberOffset || 0}`;
    if (type === 'calltracking') qs = `?limit=50&offset=${moduleState.callOffset || 0}`;
    // Batch 143: a failed list load must SAY so (moduleMsg) instead
    // of leaving the previous list on screen as if current. The
    // error still propagates — pagerLoad restores the offset on it,
    // and action handlers keep their existing try/catch behavior.
    let data;
    try {
      data = await api(`/modules/${encodeURIComponent(type)}${qs}`);
    } catch (e) {
      moduleMsg('Could not load this list — please try again.');
      throw e;
    }
    moduleState.items = Array.isArray(data.items) ? data.items : [];
    if (type === 'blog') {
      moduleState.blogTotal = data.total != null ? Number(data.total) : null;
      // Batch 45: an out-of-range page (e.g. after deleting the last post
      // on the last page) steps back instead of stranding the user.
      if (!moduleState.items.length && (moduleState.blogOffset || 0) > 0 && (moduleState.blogTotal || 0) > 0) {
        moduleState.blogOffset = Math.max(0, moduleState.blogOffset - 6);
        return loadModuleItems();
      }
    }
    moduleState.pages = Array.isArray(data.pages) ? data.pages : moduleState.pages;
    moduleState.embed = data.embed || null;
    moduleState.booking = data.booking || null;
    moduleState.chatbot = data.chatbot || null;
    moduleState.estimate = data.estimate || null;
    moduleState.socialfeed = data.socialfeed || null;
    moduleState.googlereviews = data.googlereviews || null;
    moduleState.newsletter = data.newsletter || null;
    moduleState.photocapture = data.photocapture || null;
    moduleState.comments = data.comments || null;
    moduleState.calltracking = data.calltracking || null;
    moduleState.members = data.members || null;
    moduleState.shop = data.shop || null;
    moduleState.checkout = data.checkout || null;
    moduleState.datatable = data.datatable || null;
    moduleState.charts = data.charts || null;
    moduleState.taxonomy = data.taxonomy || null;
    moduleState.qrcode = data.qrcode || null;
    moduleState.pricing = data.pricing || null;
    moduleState.categories = Array.isArray(data.categories) ? data.categories : [];
    if (type === 'bookings') {
      const booking = moduleState.booking || {};
      if (booking.active_appointment_count != null) {
        patchBookingsNavCount(booking.active_appointment_count);
      } else {
        const appts = Array.isArray(booking.appointments) ? booking.appointments : [];
        patchBookingsNavCount(appts.filter((a) => !a.archived_at).length);
      }
    }
    renderModuleItems();
    renderModuleEmbedBar();
    renderBookingAdminPanel();
    renderEstimateAdminPanel();
    renderSocialFeedAdminPanel();
    renderGoogleReviewsAdminPanel();
    renderNewsletterAdminPanel();
    renderPhotoCaptureAdminPanel();
    renderCommentsAdminPanel();
    renderCallTrackingAdminPanel();
    renderMembersAdminPanel();
    renderMenuCategoriesPanel();
    renderDatatablesPanel();
    renderOffersDisplayPanel();
    renderCategoriesScopesPanel();
    renderQrCodePanel();
    renderShopPaymentsPanel();
    renderShopOrdersPanel();
    renderCheckoutPanel();
    syncModulesPaneTabs();
  }

  // Batch 128 — orders with line items, shared by the Shop pane and
  // the Checkout pane. Each line shows the item's photo (the exact
  // image recorded on the order), its variant label when it has one,
  // and whether it is a shop product or a gallery photo.
  function shopOrdersHtml(orders) {
    const cents = (c, cur) => `${cur && cur !== 'USD' ? `${esc(cur)} ` : '$'}${((Number(c) || 0) / 100).toFixed(2)}`;
    const list = Array.isArray(orders) ? orders : [];
    if (!list.length) {
      return '<p class="hint">No orders yet. When a customer checks out on your site, their order lands here — and we email you right away.</p>';
    }
    return list
      .map((o) => {
        const when = o.created_at ? new Date(String(o.created_at).replace(' ', 'T') + 'Z').toLocaleString() : '';
        const lines = (Array.isArray(o.items) ? o.items : [])
          .map((it) => {
            const thumb = it.image_url
              ? `<img src="${esc(it.image_url)}" alt="" style="width:40px;height:40px;object-fit:cover;border-radius:6px" />`
              : '<span style="display:inline-block;width:40px;height:40px;border-radius:6px;background:var(--paper-2,#eee)" aria-hidden="true"></span>';
            const bits = [
              it.source_module === 'gallery' ? 'Photo' : '',
              it.variant_label || '',
              `× ${Number(it.quantity) || 1}`,
            ].filter(Boolean);
            return `<div class="row" style="gap:8px;align-items:center;margin-top:6px">${thumb}<span style="flex:1">${esc(it.product_name || 'Item')}${bits.length ? ` <span class="hint">${esc(bits.join(' · '))}</span>` : ''}</span><span>${cents(it.line_total_cents, it.currency || o.currency)}</span></div>`;
          })
          .join('');
        return `<div style="border-top:1px solid var(--line,#e5e0d5);padding:8px 0">
          <div class="row" style="gap:8px;align-items:baseline;flex-wrap:wrap">
            <strong>Order #${Number(o.id) || ''}</strong>
            <span class="hint">${esc(o.status || '')}</span>
            <span style="flex:1"></span>
            <strong>${cents(o.amount_cents, o.currency)}</strong>
          </div>
          <p class="hint" style="margin:2px 0 0">${esc(o.customer_email || 'No buyer email yet')}${when ? ` · ${esc(when)}` : ''}</p>
          ${
            o.discount && Number(o.discount.discount_amount_cents) > 0
              ? `<p class="hint" style="margin:2px 0 0">${esc(o.discount.label || 'Online-booking discount')} · ${cents(o.discount.gross_cents, o.currency)} − ${cents(o.discount.discount_amount_cents, o.currency)} = ${cents(o.amount_cents, o.currency)}</p>`
              : ''
          }
          ${lines || `<p class="hint" style="margin:2px 0 0">${esc(o.product_name || '')}</p>`}
        </div>`;
      })
      .join('');
  }

  function renderShopOrdersPanel() {
    const host = document.getElementById('modules-shop-orders-panel');
    if (!host) return;
    if (moduleState.current !== 'ecommerce') {
      host.innerHTML = '';
      host.hidden = true;
      return;
    }
    host.hidden = false;
    const shop = moduleState.shop || {};
    host.innerHTML = `<div class="card" style="margin-bottom:var(--card-gap)">
      <h3 style="margin:0 0 6px">Orders</h3>
      ${shopOrdersHtml(shop.orders)}
    </div>`;
  }

  function renderCheckoutPanel() {
    const host = document.getElementById('modules-checkout-panel');
    if (!host) return;
    if (moduleState.current !== 'checkout') {
      host.innerHTML = '';
      host.hidden = true;
      return;
    }
    host.hidden = false;
    const co = moduleState.checkout || {};
    const payments = co.payments || { connected: false };
    const source = co.effective_source || (payments.connected ? 'lead' : co.workspace_configured ? 'workspace' : 'none');
    const mode = co.effective_mode || null;
    const stateHtml =
      source === 'none'
        ? '<p class="hint"><strong>Payments are not set up yet.</strong> Checkout is off until Stripe keys are saved in <strong>Shop → Payments</strong> — paste your own Stripe keys there; the money goes straight to your Stripe account, never through BitPype.</p>'
        : `<p class="hint"><strong>Checkout is on${mode ? ` — ${mode === 'test' ? 'TEST mode' : 'LIVE mode'}` : ''}.</strong> ${
            source === 'lead'
              ? 'Charges run on the Stripe keys saved in Shop → Payments (your own account).'
              : 'Charges currently run on the workspace Stripe keys; save your own keys in Shop → Payments to take payments into your own account.'
          }${payments.connected && !payments.webhook_configured ? ' <strong>Your webhook signing secret is still missing</strong> — orders cannot be confirmed as paid until it is saved in Shop → Payments.' : ''}</p>`;
    const config = co.config || {};
    host.innerHTML = `<div class="card" style="margin-bottom:var(--card-gap)">
      <h3 style="margin:0 0 6px">Checkout</h3>
      ${stateHtml}
      <div class="field"><label>Thank-you message <span class="hint">(shown on the checkout page after a successful payment)</span></label>
        <input type="text" id="checkout-success-message" maxlength="300" placeholder="Thanks for your order!" value="${esc(config.success_message || '')}" /></div>
      <div class="row" style="gap:6px;flex-wrap:wrap">
        <button type="button" class="btn soft small" id="btn-checkout-config-save">Save checkout settings</button>
      </div>
      <p class="msg" id="msg-checkout-config"></p>
    </div>
    <div class="card" style="margin-bottom:var(--card-gap)">
      <h3 style="margin:0 0 6px">Orders</h3>
      ${shopOrdersHtml(co.orders)}
    </div>`;
    const saveBtn = document.getElementById('btn-checkout-config-save');
    if (saveBtn) {
      saveBtn.onclick = async () => {
        const body = {
          success_message: (document.getElementById('checkout-success-message') || {}).value || '',
        };
        try {
          const res = await api('/modules/checkout/config', { method: 'PUT', body: JSON.stringify(body) });
          if (!moduleState.checkout) moduleState.checkout = {};
          moduleState.checkout.config = (res && res.config) || moduleState.checkout.config;
          const el = document.getElementById('msg-checkout-config');
          if (el) {
            el.className = 'msg ok';
            el.textContent = 'Checkout settings saved.';
          }
        } catch (e) {
          const el = document.getElementById('msg-checkout-config');
          if (el) {
            el.className = 'msg err';
            el.textContent = errText(e);
          }
        }
      };
    }
  }

  function renderShopPaymentsPanel() {
    const host = document.getElementById('modules-shop-payments-panel');
    if (!host) return;
    if (moduleState.current !== 'ecommerce') {
      host.innerHTML = '';
      host.hidden = true;
      return;
    }
    host.hidden = false;
    const shop = moduleState.shop || {};
    const payments = shop.payments || { connected: false };
    const source = shop.effective_source || (payments.connected ? 'lead' : shop.workspace_configured ? 'workspace' : 'none');
    const webhookUrl = `${location.origin}${shop.webhook_path || ''}`;
    const webhookEvents =
      'checkout.session.completed, checkout.session.expired, checkout.session.async_payment_succeeded, checkout.session.async_payment_failed, payment_intent.payment_failed';
    const statusHtml = payments.connected
      ? `<p class="hint"><strong>Connected — your own Stripe.</strong> Your secret key ending ••••${esc(payments.secret_key_last4 || '')} is saved (encrypted). Shop checkout charges YOUR Stripe account directly, so payments land with you.${payments.webhook_configured ? '' : ' <strong>Your webhook signing secret is still missing</strong> — orders cannot be confirmed as paid until it is saved below.'}</p>`
      : source === 'workspace'
        ? '<p class="hint"><strong>Using the workspace Stripe keys.</strong> Checkout works today through the Stripe keys BitPype saved for this workspace — payments land in that account, not yours. To take shop payments into your OWN Stripe account, paste your keys here; your keys take over as soon as they are saved.</p>'
        : '<p class="hint"><strong>Not connected.</strong> Shop checkout is off until Stripe keys are saved. Paste your own Stripe keys — the money goes straight to your Stripe account, never through BitPype.</p>';
    host.innerHTML = `<div class="card" style="margin-bottom:var(--card-gap)">
      <h3 style="margin:0 0 6px">Payments — your Stripe account</h3>
      ${statusHtml}
      <div class="field"><label>Publishable key</label>
        <input type="text" id="shop-pk" placeholder="pk_live_…" value="${esc(payments.publishable_key || '')}" autocomplete="off" /></div>
      <div class="field"><label>Secret key ${payments.connected ? '<span class="hint">(leave blank to keep the saved key)</span>' : ''}</label>
        <input type="password" id="shop-sk" placeholder="sk_live_…" autocomplete="off" /></div>
      <div class="field"><label>Webhook signing secret ${payments.webhook_configured ? '<span class="hint">(leave blank to keep the saved secret)</span>' : ''}</label>
        <input type="password" id="shop-whsec" placeholder="whsec_…" autocomplete="off" /></div>
      <div class="row" style="gap:6px;flex-wrap:wrap">
        <button type="button" class="btn soft small" id="btn-shop-keys-save">Save Stripe keys</button>
        ${payments.connected ? '<button type="button" class="btn ghost small" id="btn-shop-keys-test">Test connection</button>' : ''}
        ${payments.connected ? '<button type="button" class="btn ghost small" id="btn-shop-keys-clear">Disconnect Stripe</button>' : ''}
      </div>
      <p class="msg" id="msg-shop-payments"></p>
      ${
        payments.connected
          ? `<div class="field" style="margin-top:10px"><label>Your webhook URL <span class="hint">(add this in your Stripe dashboard → Developers → Webhooks)</span></label>
        <div class="row" style="gap:6px">
          <input type="text" id="shop-webhook-url" readonly value="${esc(webhookUrl)}" style="flex:1" />
          <button type="button" class="btn ghost small" data-copy-input="shop-webhook-url">Copy</button>
        </div></div>
      <div class="field"><label>Webhook events to subscribe</label>
        <div class="row" style="gap:6px">
          <input type="text" readonly value="${esc(webhookEvents)}" style="flex:1" />
          <button type="button" class="btn ghost small" data-copy-text="${esc(webhookEvents)}">Copy</button>
        </div>
        <p class="hint">Stripe sends these to mark your orders paid, expired, or failed.</p></div>`
          : ''
      }
    </div>`;
    const msg = (text, ok) => {
      const el = document.getElementById('msg-shop-payments');
      if (!el) return;
      el.className = ok ? 'msg ok' : text ? 'msg err' : 'msg';
      el.textContent = text || '';
    };
    const saveBtn = document.getElementById('btn-shop-keys-save');
    if (saveBtn) {
      saveBtn.onclick = async () => {
        const body = {
          publishable_key: (document.getElementById('shop-pk') || {}).value || '',
          secret_key: (document.getElementById('shop-sk') || {}).value || '',
          webhook_secret: (document.getElementById('shop-whsec') || {}).value || '',
        };
        try {
          const res = await api('/modules/ecommerce/payments', { method: 'PUT', body: JSON.stringify(body) });
          if (!moduleState.shop) moduleState.shop = {};
          moduleState.shop.payments = (res && res.payments) || moduleState.shop.payments;
          moduleState.shop.effective_source = moduleState.shop.payments && moduleState.shop.payments.connected ? 'lead' : moduleState.shop.effective_source;
          renderShopPaymentsPanel();
          const el = document.getElementById('msg-shop-payments');
          if (el) {
            el.className = 'msg ok';
            el.textContent = 'Stripe keys saved. Your shop now charges your own Stripe account.';
          }
        } catch (e) {
          msg(errText(e), false);
        }
      };
    }
    const testBtn = document.getElementById('btn-shop-keys-test');
    if (testBtn) {
      testBtn.onclick = async () => {
        msg('Testing the saved key with Stripe…', true);
        try {
          const res = await api('/modules/ecommerce/payments/test', { method: 'POST', body: '{}' });
          const t = (res && res.test) || {};
          if (t.ok) {
            msg(
              `Connected. Stripe accepted the saved key${t.business_name ? ` for ${t.business_name}` : ''} (${t.test_mode ? 'test mode' : 'live mode'}; charges ${t.charges_enabled ? 'enabled' : 'not yet enabled'}).`,
              true
            );
          } else if (t.reason === 'not_connected') {
            msg('No keys are saved yet — save your Stripe keys first.', false);
          } else {
            msg('Stripe did not accept the saved secret key. Check the key in your Stripe dashboard and save it again.', false);
          }
        } catch (e) {
          msg(errText(e), false);
        }
      };
    }
    const clearBtn = document.getElementById('btn-shop-keys-clear');
    if (clearBtn) {
      clearBtn.onclick = async () => {
        try {
          const res = await api('/modules/ecommerce/payments', { method: 'DELETE' });
          if (!moduleState.shop) moduleState.shop = {};
          moduleState.shop.payments = (res && res.payments) || { connected: false };
          moduleState.shop.effective_source = moduleState.shop.workspace_configured ? 'workspace' : 'none';
          renderShopPaymentsPanel();
          const el = document.getElementById('msg-shop-payments');
          if (el) {
            el.className = 'msg ok';
            el.textContent = moduleState.shop.workspace_configured
              ? 'Your keys were removed. Checkout falls back to the workspace Stripe keys.'
              : 'Your keys were removed. Checkout is off until keys are saved again.';
          }
        } catch (e) {
          msg(errText(e), false);
        }
      };
    }
  }

  function renderOffersDisplayPanel() {
    const host = document.getElementById('modules-offers-display-panel');
    if (!host) return;
    if (moduleState.current !== 'offers') {
      host.innerHTML = '';
      host.hidden = true;
      return;
    }
    host.hidden = false;
    const settings = (moduleState.embed && moduleState.embed.settings) || {};
    const layout = settings.layout === 'horizontal' ? 'horizontal' : 'cards';
    host.innerHTML = `<div class="card" style="margin-bottom:var(--card-gap)">
      <h3 style="margin:0 0 6px">How offers appear</h3>
      <p class="hint" style="margin:0 0 8px">Cards shows your offers as a grid of cards. Horizontal shows each offer as a wide banner strip — handy for a single big promotion near the top of a page.</p>
      <div style="display:flex;gap:8px;align-items:center;padding-top:4px">
        <label class="hint" for="offers-layout-select" style="margin:0">Layout</label>
        <select id="offers-layout-select" style="width:auto">
          <option value="cards"${layout === 'cards' ? ' selected' : ''}>Cards</option>
          <option value="horizontal"${layout === 'horizontal' ? ' selected' : ''}>Horizontal</option>
        </select>
        <button type="button" class="btn soft small" id="btn-offers-layout-save">Save</button>
      </div>
    </div>`;
    const saveBtn = document.getElementById('btn-offers-layout-save');
    if (saveBtn) {
      saveBtn.onclick = async () => {
        const sel = document.getElementById('offers-layout-select');
        const next = sel && sel.value === 'horizontal' ? 'horizontal' : 'cards';
        try {
          const res = await api('/modules/offers/settings', {
            method: 'PUT',
            body: JSON.stringify({ layout: next }),
          });
          const saved = (res && res.settings && res.settings.layout) || next;
          if (!moduleState.embed) moduleState.embed = {};
          if (!moduleState.embed.settings) moduleState.embed.settings = {};
          moduleState.embed.settings.layout = saved;
          moduleMsg('Offer layout saved.', true);
          renderOffersDisplayPanel();
        } catch (e) {
          moduleMsg(errText(e), false);
        }
      };
    }
  }

  // Batch 124: which scopes the Categories module index shows on the
  // site. None ticked = every scope that has published categories.
  // This writes the same embed setting categories.setScopes writes.
  function renderCategoriesScopesPanel() {
    const host = document.getElementById('modules-categories-scopes-panel');
    if (!host) return;
    if (moduleState.current !== 'categories') {
      host.innerHTML = '';
      host.hidden = true;
      return;
    }
    host.hidden = false;
    const chosen =
      (moduleState.taxonomy && moduleState.taxonomy.scopes) ||
      (moduleState.embed && moduleState.embed.settings && moduleState.embed.settings.scopes) ||
      [];
    const scopesWithCats = [...new Set((moduleState.allCategories || []).map((c) => c && c.scope).filter(Boolean))];
    const boxes = MODULE_TYPES.filter((m) => m.type !== 'categories')
      .map((m) => {
        const has = scopesWithCats.includes(m.type);
        return `<label class="mod-check"><input type="checkbox" data-cat-scope="${esc(m.type)}"${chosen.includes(m.type) ? ' checked' : ''} /> ${esc(m.label)}${has ? '' : ' <span class="hint">(no categories yet)</span>'}</label>`;
      })
      .join('');
    host.innerHTML = `<div class="card" style="margin-bottom:var(--card-gap)">
      <h3 style="margin:0 0 6px">What the Categories page shows</h3>
      <p class="hint" style="margin:0 0 8px">Tick the modules whose categories appear on your site's Categories page. Leave everything unticked to show every module that has published categories.</p>
      <div class="mod-check-group">${boxes}</div>
      <div style="padding-top:8px"><button type="button" class="btn soft small" id="btn-categories-scopes-save">Save</button></div>
    </div>`;
    const saveBtn = document.getElementById('btn-categories-scopes-save');
    if (saveBtn) {
      saveBtn.onclick = async () => {
        const scopes = Array.from(host.querySelectorAll('[data-cat-scope]'))
          .filter((el) => el.checked)
          .map((el) => el.getAttribute('data-cat-scope'));
        try {
          const res = await api('/modules/categories/scopes', {
            method: 'PUT',
            body: JSON.stringify({ scopes }),
          });
          const saved = (res && res.settings && res.settings.scopes) || scopes;
          if (!moduleState.taxonomy) moduleState.taxonomy = {};
          moduleState.taxonomy.scopes = saved;
          moduleMsg('Categories page settings saved.', true);
          renderCategoriesScopesPanel();
        } catch (e) {
          moduleMsg(errText(e), false);
        }
      };
    }
  }

  function renderQrCodePanel() {
    const host = document.getElementById('modules-qrcode-panel');
    if (!host) return;
    if (moduleState.current !== 'qrcode') {
      host.innerHTML = '';
      host.hidden = true;
      return;
    }
    host.hidden = false;
    const qr = moduleState.qrcode || {};
    const display = qr.display || {};
    const items = moduleState.items || [];
    const published = items.filter((it) => it.status === 'published');
    const chosen = display.qrcode_id != null ? Number(display.qrcode_id) : null;
    const previews = items
      .filter((it) => it.image_data_url)
      .map(
        (it) => `<figure style="margin:0;text-align:center">
          <img src="${esc(it.image_data_url)}" alt="${esc(it.name || 'QR code')}" style="width:132px;height:132px;border:1px solid var(--line,#e7e2d9);border-radius:10px;background:#fff" />
          <figcaption class="hint" style="margin-top:4px">${esc(it.name || '')}</figcaption>
        </figure>`
      )
      .join('');
    host.innerHTML = `<div class="card" style="margin-bottom:var(--card-gap)">
      <h3 style="margin:0 0 6px">On your site</h3>
      <p class="hint" style="margin:0 0 8px">The QR Code module shows ONE code on your site. Pick a published code and an optional caption (like “Scan to book”). Codes are generated fresh from their target every time they are shown, so renaming a page never breaks a printed code.</p>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding-top:4px">
        <label class="hint" for="qrcode-display-select" style="margin:0">Show</label>
        <select id="qrcode-display-select" style="width:auto">
          <option value="">— Nothing yet —</option>
          ${published.map((it) => `<option value="${it.id}"${chosen === Number(it.id) ? ' selected' : ''}>${esc(it.name || `#${it.id}`)}</option>`).join('')}
        </select>
        <input id="qrcode-display-caption" type="text" maxlength="160" placeholder="Caption, e.g. Scan to book" value="${esc(display.caption || '')}" style="flex:1;min-width:180px" />
        <button type="button" class="btn soft small" id="btn-qrcode-display-save">Save</button>
      </div>
      ${previews ? `<div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:14px">${previews}</div>` : ''}
    </div>`;
    const saveBtn = document.getElementById('btn-qrcode-display-save');
    if (saveBtn) {
      saveBtn.onclick = async () => {
        const sel = document.getElementById('qrcode-display-select');
        const cap = document.getElementById('qrcode-display-caption');
        const qrcodeId = sel && sel.value ? Number(sel.value) : null;
        try {
          const res = await api('/modules/qrcode/display', {
            method: 'PUT',
            body: JSON.stringify({ qrcode_id: qrcodeId, caption: cap ? cap.value : '' }),
          });
          if (!moduleState.qrcode) moduleState.qrcode = {};
          moduleState.qrcode.display = (res && res.settings) || { qrcode_id: qrcodeId, caption: cap ? cap.value : '' };
          moduleMsg('QR code display saved.', true);
          renderQrCodePanel();
        } catch (e) {
          moduleMsg(errText(e), false);
        }
      };
    }
  }

  function renderDatatablesPanel() {
    const host = document.getElementById('modules-datatables-panel');
    if (!host) return;
    if (moduleState.current !== 'datatables') {
      host.innerHTML = '';
      host.hidden = true;
      return;
    }
    host.hidden = false;
    const table = moduleState.datatable || {};
    const columns = Array.isArray(table.columns) ? table.columns : [];
    const roles = table.roles || {};
    const submitFields = Array.isArray(table.submit_fields) ? table.submit_fields : [];
    const pending = Number(table.pending_count) || 0;
    const COLUMN_TYPES = ['text', 'number', 'currency', 'date', 'link', 'boolean'];
    const TEMPLATES = [
      ['table', 'Table — searchable, sortable, paged'],
      ['wall', 'Card wall — social-wall style cards'],
      ['results', 'Results list — search-results style'],
      ['list', 'Simple list — clean stacked rows'],
    ];
    const ROLE_DEFS = [
      ['title', 'Title'],
      ['body', 'Body text'],
      ['image', 'Image'],
      ['link', 'Link'],
      ['meta', 'Meta line'],
      ['badge', 'Badge'],
    ];
    const colOptions = (selected) =>
      `<option value=""${!selected ? ' selected' : ''}>— none —</option>` +
      columns
        .map((c) => `<option value="${esc(c.key)}"${selected === c.key ? ' selected' : ''}>${esc(c.label || c.key)}</option>`)
        .join('');
    const colRowHtml = (c) => `<div data-dt-col-row style="display:flex;gap:8px;align-items:center;padding:6px 0;flex-wrap:wrap">
        <input type="text" data-dt-col-key value="${esc(c.key || '')}" placeholder="key (e.g. price)" style="flex:1;min-width:110px" aria-label="Column key" />
        <input type="text" data-dt-col-label value="${esc(c.label || '')}" placeholder="Label (e.g. Price)" style="flex:1;min-width:110px" aria-label="Column label" />
        <select data-dt-col-type aria-label="Column type">${COLUMN_TYPES.map((t) => `<option value="${t}"${c.type === t ? ' selected' : ''}>${t}</option>`).join('')}</select>
        <button type="button" class="btn soft small" data-dt-col-remove>Remove</button>
      </div>`;
    host.innerHTML = `<div class="card" style="margin-bottom:var(--card-gap)">
      <h3 style="margin:0 0 6px">Table setup</h3>
      <p class="hint" style="margin:0 0 8px">Name your table and define its columns (up to 12). Rows are edited in the list below — each row editor follows these columns.</p>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <input type="text" id="dt-title" value="${esc(table.title || '')}" placeholder="Table name (e.g. Price list)" style="flex:1;min-width:180px" />
        <button type="button" class="btn soft small" id="btn-dt-save-title">Save name</button>
      </div>
      <div id="dt-cols" style="margin-top:10px">${columns.map(colRowHtml).join('') || '<p class="hint">No columns yet — add your first one below.</p>'}</div>
      <div class="row" style="gap:6px;flex-wrap:wrap;margin-top:6px">
        <button type="button" class="btn soft small" id="btn-dt-col-add">Add column</button>
        <button type="button" class="btn soft small" id="btn-dt-save-cols">Save columns</button>
      </div>
    </div>
    <div class="card" style="margin-bottom:var(--card-gap)">
      <h3 style="margin:0 0 6px">How it appears on your site</h3>
      <p class="hint" style="margin:0 0 8px">Pick a layout, then tell it which column plays which part. Anything left on “— none —” is simply skipped.</p>
      <div class="field"><label>Layout</label>
        <select id="dt-template">${TEMPLATES.map(([v, l]) => `<option value="${v}"${table.template === v ? ' selected' : ''}>${l}</option>`).join('')}</select></div>
      ${ROLE_DEFS.map(([role, label]) => `<div class="field"><label>${label} column</label><select data-dt-role="${role}">${colOptions(roles[role])}</select></div>`).join('')}
      <div class="field"><label>Visitor submissions</label>
        <select id="dt-submit-mode">
          <option value="off"${table.submit_mode === 'off' ? ' selected' : ''}>Off — no submission form</option>
          <option value="moderated"${table.submit_mode !== 'off' && table.submit_mode !== 'live' ? ' selected' : ''}>Moderated — you approve each submission first</option>
          <option value="live"${table.submit_mode === 'live' ? ' selected' : ''}>Live — submissions appear right away</option>
        </select></div>
      <div class="field"><label>Fields the submission form collects</label>
        ${columns.length ? columns.map((c) => `<label style="display:inline-flex;gap:6px;align-items:center;margin:0 12px 6px 0"><input type="checkbox" data-dt-submit-field="${esc(c.key)}"${submitFields.includes(c.key) ? ' checked' : ''} /> ${esc(c.label || c.key)}</label>`).join('') : '<p class="hint">Define columns first.</p>'}
      </div>
      <button type="button" class="btn soft small" id="btn-dt-save-display">Save appearance</button>
    </div>
    <div class="card" style="margin-bottom:var(--card-gap)">
      <h3 style="margin:0 0 6px">Rows</h3>
      ${pending ? `<p class="hint" style="margin:0 0 8px"><strong>${pending} visitor submission${pending === 1 ? '' : 's'} waiting for approval</strong> — look for the rows marked “pending” below and hit Approve.</p>` : '<p class="hint" style="margin:0 0 8px">Rows are managed in the list below.</p>'}
      <button type="button" class="btn ghost small" id="btn-dt-clear">Delete all rows</button>
    </div>`;
    const reload = async () => {
      try {
        await loadModuleItems();
      } catch (e) {
        moduleMsg(errText(e), false);
      }
    };
    const saveTitleBtn = document.getElementById('btn-dt-save-title');
    if (saveTitleBtn) {
      saveTitleBtn.onclick = async () => {
        const input = document.getElementById('dt-title');
        try {
          await api('/modules/datatables/config', {
            method: 'PUT',
            body: JSON.stringify({ title: String((input && input.value) || '').trim() }),
          });
          moduleMsg('Table name saved.', true);
          await reload();
        } catch (e) {
          moduleMsg(errText(e), false);
        }
      };
    }
    const colsHost = document.getElementById('dt-cols');
    const addColBtn = document.getElementById('btn-dt-col-add');
    if (addColBtn && colsHost) {
      addColBtn.onclick = () => {
        if (colsHost.querySelectorAll('[data-dt-col-row]').length >= 12) {
          moduleMsg('A table can have at most 12 columns.', false);
          return;
        }
        const wrap = document.createElement('div');
        wrap.innerHTML = colRowHtml({ key: '', label: '', type: 'text' });
        const row = wrap.firstElementChild;
        colsHost.appendChild(row);
        const rm = row.querySelector('[data-dt-col-remove]');
        if (rm) rm.onclick = () => row.remove();
        const keyInput = row.querySelector('[data-dt-col-key]');
        if (keyInput) keyInput.focus();
      };
    }
    host.querySelectorAll('[data-dt-col-remove]').forEach((btn) => {
      btn.onclick = () => {
        const row = btn.closest('[data-dt-col-row]');
        if (row) row.remove();
      };
    });
    const saveColsBtn = document.getElementById('btn-dt-save-cols');
    if (saveColsBtn) {
      saveColsBtn.onclick = async () => {
        const cols = [];
        host.querySelectorAll('[data-dt-col-row]').forEach((row) => {
          const key = String((row.querySelector('[data-dt-col-key]') || {}).value || '').trim();
          const label = String((row.querySelector('[data-dt-col-label]') || {}).value || '').trim();
          const type = String((row.querySelector('[data-dt-col-type]') || {}).value || 'text');
          if (key || label) cols.push({ key, label, type });
        });
        try {
          await api('/modules/datatables/config', { method: 'PUT', body: JSON.stringify({ columns: cols }) });
          moduleMsg('Columns saved.', true);
          await reload();
        } catch (e) {
          moduleMsg(errText(e), false);
        }
      };
    }
    const saveDisplayBtn = document.getElementById('btn-dt-save-display');
    if (saveDisplayBtn) {
      saveDisplayBtn.onclick = async () => {
        const rolesOut = {};
        host.querySelectorAll('[data-dt-role]').forEach((sel) => {
          rolesOut[sel.getAttribute('data-dt-role')] = sel.value || null;
        });
        const fields = [];
        host.querySelectorAll('[data-dt-submit-field]').forEach((cb) => {
          if (cb.checked) fields.push(cb.getAttribute('data-dt-submit-field'));
        });
        const modeSel = document.getElementById('dt-submit-mode');
        const tplSel = document.getElementById('dt-template');
        try {
          await api('/modules/datatables/config', {
            method: 'PUT',
            body: JSON.stringify({
              template: tplSel ? tplSel.value : undefined,
              roles: rolesOut,
              submit_mode: modeSel ? modeSel.value : undefined,
              submit_fields: fields,
            }),
          });
          moduleMsg('Appearance saved.', true);
          await reload();
        } catch (e) {
          moduleMsg(errText(e), false);
        }
      };
    }
    const clearBtn = document.getElementById('btn-dt-clear');
    if (clearBtn) {
      clearBtn.onclick = async () => {
        if (!window.confirm('Delete ALL rows from this table? The columns and settings stay. This cannot be undone.')) return;
        try {
          const res = await api('/modules/datatables/clear', { method: 'POST', body: JSON.stringify({}) });
          moduleMsg(`Deleted ${(res && res.deleted) || 0} rows.`, true);
          await reload();
        } catch (e) {
          moduleMsg(errText(e), false);
        }
      };
    }
  }

  function renderMenuCategoriesPanel() {
    const host = document.getElementById('modules-menu-cats-panel');
    if (!host) return;
    if (moduleState.current !== 'menu') {
      host.innerHTML = '';
      host.hidden = true;
      return;
    }
    host.hidden = false;
    const cats = moduleState.categories || [];
    const rows = cats
      .map(
        (c) => `<div class="menu-cat-row" data-cat-row="${c.id}" style="display:flex;gap:8px;align-items:center;padding:6px 0">
          <input type="text" class="menu-cat-name" value="${esc(c.name || '')}" style="flex:1" aria-label="Category name" />
          <button type="button" class="btn soft small" data-cat-save="${c.id}">Save</button>
          <button type="button" class="btn soft small" data-cat-delete="${c.id}">Delete</button>
        </div>`
      )
      .join('');
    host.innerHTML = `<div class="card" style="margin-bottom:var(--card-gap)">
      <h3 style="margin:0 0 6px">Menu categories</h3>
      <p class="hint" style="margin:0 0 8px">Categories group your menu items under headings (Starters, Mains…). Deleting a category keeps its items — they become uncategorized.</p>
      ${rows || '<p class="hint">No categories yet — add one below, or type a category name on an item.</p>'}
      <div style="display:flex;gap:8px;align-items:center;padding-top:8px">
        <input type="text" id="menu-cat-new-name" placeholder="New category name" style="flex:1" />
        <button type="button" class="btn soft small" id="btn-menu-cat-add">Add category</button>
      </div>
    </div>`;
    const reload = async () => {
      try {
        await loadModuleItems();
      } catch (e) {
        moduleMsg(errText(e), false);
      }
    };
    const addBtn = document.getElementById('btn-menu-cat-add');
    if (addBtn) {
      addBtn.onclick = async () => {
        const input = document.getElementById('menu-cat-new-name');
        const name = String((input && input.value) || '').trim();
        if (!name) return;
        try {
          await api('/modules/menu/categories', { method: 'POST', body: JSON.stringify({ name }) });
          moduleMsg('Category added.', true);
          await reload();
        } catch (e) {
          moduleMsg(errText(e), false);
        }
      };
    }
    host.querySelectorAll('[data-cat-save]').forEach((btn) => {
      btn.onclick = async () => {
        const id = btn.getAttribute('data-cat-save');
        const row = host.querySelector(`[data-cat-row="${id}"]`);
        const input = row ? row.querySelector('.menu-cat-name') : null;
        const name = String((input && input.value) || '').trim();
        if (!name) return;
        try {
          await api(`/modules/menu/categories/${encodeURIComponent(id)}`, {
            method: 'PUT',
            body: JSON.stringify({ name }),
          });
          moduleMsg('Category saved.', true);
          await reload();
        } catch (e) {
          moduleMsg(errText(e), false);
        }
      };
    });
    host.querySelectorAll('[data-cat-delete]').forEach((btn) => {
      btn.onclick = async () => {
        const id = btn.getAttribute('data-cat-delete');
        if (!window.confirm('Delete this category? Its items stay on the menu as uncategorized.')) return;
        try {
          await api(`/modules/menu/categories/${encodeURIComponent(id)}`, { method: 'DELETE' });
          moduleMsg('Category deleted.', true);
          await reload();
        } catch (e) {
          moduleMsg(errText(e), false);
        }
      };
    });
  }

  async function loadModules() {
    const upgrade = document.getElementById('modules-upgrade');
    const app = document.getElementById('modules-app');
    try {
      const data = await api('/modules');
      moduleState.plan = data.plan || 'free';
      moduleState.enabled = !!data.siteModules;
      moduleState.summary = data;
      moduleState.pages = Array.isArray(data.pages) ? data.pages : [];
      if (upgrade) upgrade.hidden = moduleState.enabled;
      if (app) app.hidden = !moduleState.enabled;
      if (!moduleState.enabled) return;
      // Batch 29: land on a module this user may actually open (the
      // summary is already filtered to their effective module set).
      const available = (Array.isArray(data.modules) ? data.modules : []).map((m) => m.type);
      if (!available.includes(moduleState.current)) {
        moduleState.current = available[0] || 'blog';
      }
      renderModuleTypeTabs();
      await loadModuleItems();
    } catch (e) {
      moduleMsg(errText(e), false);
      if (app && app.hidden && upgrade && upgrade.hidden) app.hidden = false;
      const box = document.getElementById('modules-items');
      if (box && app && !app.hidden) {
        box.innerHTML =
          '<p class="hint">Something went wrong loading your modules. ' +
          '<button type="button" class="btn ghost small" id="modules-retry">Retry</button></p>';
        const retry = document.getElementById('modules-retry');
        if (retry) retry.onclick = () => loadModules().catch(() => {});
      }
    }
  }

  let leadScoutSelectedId = null;
  // Batch 45 — LeadScout paging (server supports offset; 80/page).
  let leadScoutShown = [];

  async function loadLeadScout(more) {
    const listEl = document.getElementById('leadscout-list');
    const msgEl = document.getElementById('msg-leadscout-list');
    const healthBox = document.getElementById('leadscout-health');
    const healthMsg = document.getElementById('leadscout-health-msg');
    if (!listEl) return;
    try {
      const q = (document.getElementById('leadscout-q') && document.getElementById('leadscout-q').value) || '';
      const offset = more ? leadScoutShown.length : 0;
      const data = await api(`/leadscout/contacts?limit=80&offset=${offset}&q=${encodeURIComponent(q)}`);
      const fresh = data.contacts || [];
      const contacts = more ? leadScoutShown.concat(fresh) : fresh;
      leadScoutShown = contacts;
      const health = data.health || {};
      if (healthBox) {
        if (health.open_failures > 0) {
          healthBox.hidden = false;
          if (healthMsg) {
            healthMsg.textContent = `${health.open_failures} capture failure${health.open_failures === 1 ? '' : 's'} — retry to attach missing contacts.`;
          }
        } else {
          healthBox.hidden = true;
        }
      }
      if (!contacts.length) {
        listEl.innerHTML =
          '<p class="hint" style="margin:0">No contacts yet. Form submissions and bookings appear here automatically.</p>';
      } else {
        listEl.innerHTML =
          contacts
            .map((c) => {
              const active = Number(c.id) === Number(leadScoutSelectedId) ? ' is-active' : '';
              const sub = [c.email, c.phone].filter(Boolean).join(' · ') || 'No contact info';
              return `<button type="button" class="leadscout-row${active}" data-id="${c.id}" style="display:block;width:100%;text-align:left;padding:10px 12px;margin:0 0 6px;border:1px solid var(--line,#e2e8f0);background:${active ? 'rgba(0,0,0,.04)' : 'transparent'};cursor:pointer">
            <strong style="display:block">${esc(c.name || 'Contact')}</strong>
            <span class="hint" style="font-size:.85rem">${esc(sub)}</span>
            <span class="hint" style="display:block;font-size:.8rem;margin-top:2px">${Number(c.event_count) || 0} event${Number(c.event_count) === 1 ? '' : 's'}</span>
          </button>`;
            })
            .join('') +
          // Batch 45 — load-more while a full page came back.
          (fresh.length >= 80
            ? '<button type="button" class="btn ghost small" id="leadscout-more" style="margin-top:4px">Load more contacts</button>'
            : '');
        listEl.querySelectorAll('[data-id]').forEach((btn) => {
          btn.onclick = () => {
            leadScoutSelectedId = Number(btn.getAttribute('data-id'));
            loadLeadScoutDetail(leadScoutSelectedId);
            loadLeadScout().catch(() => {});
          };
        });
        const moreBtn = document.getElementById('leadscout-more');
        if (moreBtn) moreBtn.onclick = () => loadLeadScout(true).catch(() => {});
      }
      if (msgEl) msgEl.textContent = '';
      if (leadScoutSelectedId) await loadLeadScoutDetail(leadScoutSelectedId);
    } catch (e) {
      listEl.innerHTML =
        '<p class="hint" style="margin:0">Contacts could not be loaded. ' +
        '<button type="button" class="btn ghost small" id="leadscout-retry">Retry</button></p>';
      const retry = document.getElementById('leadscout-retry');
      if (retry) retry.onclick = () => loadLeadScout().catch(() => {});
      if (msgEl) msgEl.textContent = errText(e);
    }
  }

  async function loadLeadScoutDetail(id) {
    const empty = document.getElementById('leadscout-detail-empty');
    const detail = document.getElementById('leadscout-detail');
    if (!detail) return;
    try {
      const data = await api(`/leadscout/contacts/${Number(id)}`);
      const c = data.contact || {};
      const events = data.events || [];
      if (empty) empty.hidden = true;
      detail.hidden = false;
      const eventsHtml = events.length
        ? events
            .map((ev) => {
              const when = esc(ev.created_at || '');
              const label = esc(ev.source_label || ev.kind || 'Event');
              const extra =
                ev.kind === 'appointment'
                  ? `<div class="hint">${esc(ev.service_name || '')} · ${esc(ev.starts_at || '')} · ${esc(ev.status || '')}</div>`
                  : `<div class="hint">Page: ${esc(ev.page_slug || '—')}</div>`;
              let payloadBits = '';
              if (ev.payload && typeof ev.payload === 'object') {
                const keys = Object.keys(ev.payload).slice(0, 8);
                payloadBits = `<dl style="margin:6px 0 0;font-size:.85rem">${keys.map((k) => `<div><dt style="display:inline;font-weight:650">${esc(k)}:</dt> <dd style="display:inline;margin:0">${esc(ev.payload[k])}</dd></div>`).join('')}</dl>`;
              }
              return `<article style="border-top:1px solid var(--line,#e2e8f0);padding:10px 0">
            <strong>${label}</strong> <span class="hint">${when}</span>
            ${extra}${payloadBits}
          </article>`;
            })
            .join('')
        : '<p class="hint">No events yet.</p>';
      detail.innerHTML = `
        <h3 style="margin:0 0 6px;font-size:1.15rem">${esc(c.name || 'Contact')}</h3>
        <p style="margin:0 0 12px" class="hint">${esc([c.email, c.phone].filter(Boolean).join(' · ') || '—')}</p>
        <h4 style="margin:0 0 8px;font-size:1rem">Activity</h4>
        ${eventsHtml}
        <div style="margin-top:14px"><button type="button" class="btn ghost small" id="leadscout-delete-contact">Delete contact</button>
        <span class="hint"> Removes the contact and its activity. A contact tied to a charged rental event cannot be deleted.</span></div>`;
      const delBtn = document.getElementById('leadscout-delete-contact');
      if (delBtn) {
        delBtn.onclick = async () => {
          if (!window.confirm('Delete this contact and its activity? This cannot be undone.')) return;
          try {
            await api(`/leadscout/contacts/${Number(id)}`, { method: 'DELETE' });
            leadScoutSelectedId = null;
            detail.hidden = true;
            if (empty) empty.hidden = false;
            await loadLeadScout();
          } catch (e) {
            window.alert(errText(e));
          }
        };
      }
    } catch (e) {
      detail.hidden = false;
      if (empty) empty.hidden = true;
      detail.innerHTML = `<p class="msg">${esc(errText(e))}</p>`;
    }
  }

  async function loadDashboard() {
    hideUpsellTip();
    const me = await api('/me');
    state.client = me.client;
    state.previewUrl = me.previewUrl || null;
    state.hasSite = !!(me.site && me.site.id);
    document.getElementById('biz-name').textContent =
      (me.lead && me.lead.business_name) || me.client.businessName || 'Your project';
    const bits = [
      me.client.email,
      me.lead && [me.lead.city, me.lead.state].filter(Boolean).join(', '),
      me.site && me.site.name,
    ].filter(Boolean);
    document.getElementById('biz-meta').textContent = bits.join(' · ');
    // Domain picker (Batch 15): shown only while the site has no custom domain
    // (the /me payload carries the tokenized link, or null when not applicable).
    const domainBtn = document.getElementById('btn-get-domain');
    if (domainBtn) {
      if (me.domainPickerUrl) {
        domainBtn.href = me.domainPickerUrl;
        domainBtn.classList.remove('hidden');
      } else {
        domainBtn.classList.add('hidden');
        domainBtn.setAttribute('href', '#');
      }
    }
    // Batch 29: render the nav from the /me payload's visible tabs and
    // only eager-load panels this user may open (the API 403s the rest).
    portalVisibleTabs =
      me.client && Array.isArray(me.client.visibleTabs) ? me.client.visibleTabs.slice() : null;
    applyPortalVisibleTabs();
    // Batch 119: narrow the shell to Billing while suspended.
    state.suspension = me.suspension && me.suspension.suspended ? me.suspension : null;
    if (state.suspension) applyPortalSuspension();
    showApp();
    const eager = [loadEditablePreview(me.previewUrl)];
    if (portalTabVisible('social')) {
      eager.push(loadCalendar(), loadSocialAccounts().catch(() => {}));
    }
    if (portalTabVisible('billing')) eager.push(loadBilling());
    if (portalTabVisible('forms')) eager.push(loadForms().catch(() => {}));
    if (portalTabVisible('leadscout')) eager.push(loadLeadScout().catch(() => {}));
    if (portalTabVisible('modules')) eager.push(loadModules().catch(() => {}));
    await Promise.all(eager);
    if (portalTabVisible('billing')) scheduleUpsellTip();
  }

  function hideUpsellTip() {
    upsellTipEpoch += 1;
    if (upsellTipTimer != null) clearTimeout(upsellTipTimer);
    upsellTipTimer = null;
    const modal = document.getElementById('upsell-tip-modal');
    if (modal) {
      const restoreFocus = modal.contains(document.activeElement);
      modal.hidden = true;
      if (restoreFocus) {
        const previous = upsellTipReturnFocus;
        const target =
          previous && previous.isConnected && previous.getClientRects().length
            ? previous
            : document.querySelector('#portal-nav [aria-selected="true"]');
        if (target) target.focus();
      }
    }
    upsellTipReturnFocus = null;
  }

  function showUpsellTip(tip) {
    const modal = document.getElementById('upsell-tip-modal');
    const titleText = tip && typeof tip.title === 'string' ? tip.title.trim() : '';
    const bodyText = tip && typeof tip.body === 'string' ? tip.body.trim() : '';
    if (!modal || !portalAuthed || state.plan !== 'free' || !titleText || !bodyText) {
      hideUpsellTip();
      return;
    }
    const title = document.getElementById('upsell-tip-title');
    const body = document.getElementById('upsell-tip-body');
    const upgrade = document.getElementById('upsell-tip-upgrade');
    if (!title || !body || !upgrade) return;
    title.textContent = titleText;
    body.textContent = bodyText;
    if (upgrade) upgrade.textContent = tip.cta_label || 'Upgrade';
    if (modal.hidden) upsellTipReturnFocus = document.activeElement;
    modal.hidden = false;
  }

  function scheduleUpsellTip() {
    if (upsellTipTimer != null) clearTimeout(upsellTipTimer);
    // Free/basic only — paid plans skip. Delay so it doesn’t interrupt first paint.
    if (!portalAuthed || String(state.plan || 'free') !== 'free') return;
    upsellTipTimer = setTimeout(() => {
      upsellTipTimer = null;
      maybeShowUpsellTip().catch(() => {});
    }, 12000);
  }

  async function maybeShowUpsellTip() {
    if (!portalAuthed || String(state.plan || 'free') !== 'free') return;
    if (sessionStorage.getItem('bp_upsell_tip_session') === '1') return;
    const epoch = upsellTipEpoch;
    const data = await api('/upsell-tips/next');
    if (epoch !== upsellTipEpoch || !portalAuthed || state.plan !== 'free') return;
    if (!data || !data.tip) return;
    showUpsellTip(data.tip);
    const modal = document.getElementById('upsell-tip-modal');
    if (modal && !modal.hidden) sessionStorage.setItem('bp_upsell_tip_session', '1');
  }

  document.getElementById('btn-edit-mode').onclick = () => {
    if (!state.siteEditable) return;
    if (state.editMode) {
      // Done: leave edit mode + fullscreen; keep any unsaved edits in the bar
      setEditMode(false, { fullscreen: false });
    } else {
      if (layoutBlocksModeSwitch()) return;
      setEditMode(true, { fullscreen: true });
    }
  };

  const themeBtn = document.getElementById('btn-theme-colors');
  if (themeBtn) {
    themeBtn.onclick = () => {
      if (!state.siteEditable) return;
      if (!state.themeOpen && layoutBlocksModeSwitch()) return;
      state.themeOpen = !state.themeOpen;
      if (state.themeOpen) {
        fillThemeForm(state.theme);
        ensureCatalogStyles(document);
        fillFontSelects();
      }
      const msg = document.getElementById('msg-theme');
      if (msg && state.themeOpen) {
        msg.className = 'msg';
        msg.textContent = '';
      }
      syncThemeUi();
    };
  }

  const structureBtn = document.getElementById('btn-structure');
  if (structureBtn) {
    structureBtn.onclick = async () => {
      if (!state.siteEditable) return;
      if (!state.structureOpen && layoutBlocksModeSwitch()) return;
      state.structureOpen = !state.structureOpen;
      syncStructureUi();
      if (state.structureOpen) {
        setStructureMsg('', '');
        await loadStructure();
      }
    };
  }

  /* Batch 147 — layout editor bindings. */
  const layoutBtn = document.getElementById('btn-layout');
  if (layoutBtn) {
    layoutBtn.onclick = async () => {
      if (!state.siteEditable) return;
      if (state.layoutOpen) {
        closeLayout();
        return;
      }
      // Resume a session kept alive by a Modules-tab Edit trip — but
      // only if the saved page still matches the session's base;
      // anything else (design chat, structure saves) reopens fresh
      // rather than resurrecting a stale model.
      if (state.layout && !state.layout.freeform) {
        try {
          const fresh = await api(`/site/layout?slug=${encodeURIComponent(state.layout.slug)}`);
          if (fresh && JSON.stringify(fresh.sections || []) === JSON.stringify(state.layout.saved)) {
            state.layoutOpen = true;
            syncLayoutUi();
            renderLayoutBar();
            await renderLayoutCanvas();
            return;
          }
        } catch {
          /* fall through to a fresh open */
        }
        const slug = state.layout.slug;
        state.layout = null;
        await openLayout(slug);
        return;
      }
      if (state.layout) state.layout = null;
      await openLayout();
    };
  }

  const layoutBarEl = document.getElementById('layout-bar');
  if (layoutBarEl) {
    layoutBarEl.addEventListener('click', async (ev) => {
      const t = ev.target && ev.target.closest ? ev.target.closest('[data-layout-page],[data-layout-act],[data-layout-pick],[data-layout-row]') : null;
      if (!t || !layoutBarEl.contains(t)) return;
      if (t.hasAttribute('data-layout-page')) {
        const slug = t.getAttribute('data-layout-page');
        const L = layoutSession();
        if (!L || slug === L.slug) return;
        if (L.dirty && !window.confirm('You have unsaved layout changes on this page. Discard them and switch pages?')) return;
        state.layout = null;
        await openLayout(slug);
        return;
      }
      if (t.hasAttribute('data-layout-pick')) {
        if (t.disabled) return;
        layoutPickSection(t.getAttribute('data-layout-pick'), t.getAttribute('data-layout-pick-type'));
        return;
      }
      if (t.hasAttribute('data-layout-act')) {
        if (t.disabled) return;
        ev.stopPropagation();
        layoutAct(t.getAttribute('data-layout-act'), Number(t.getAttribute('data-layout-idx')));
        return;
      }
      if (t.hasAttribute('data-layout-row')) {
        layoutSelect(Number(t.getAttribute('data-layout-row')), false);
      }
    });
  }

  const btnLayoutSave = document.getElementById('btn-layout-save');
  if (btnLayoutSave) btnLayoutSave.onclick = () => saveLayout();
  const btnLayoutUndo = document.getElementById('btn-layout-undo');
  if (btnLayoutUndo) btnLayoutUndo.onclick = () => layoutUndo();
  const btnLayoutAdd = document.getElementById('btn-layout-add');
  if (btnLayoutAdd) {
    btnLayoutAdd.onclick = () => {
      const L = layoutSession();
      if (!L) return;
      if (L.paletteOpen) {
        L.paletteOpen = false;
        renderLayoutPalette();
      } else {
        layoutOpenPalette(L.selected >= 0 ? L.selected : null);
      }
    };
  }
  const btnLayoutClose = document.getElementById('btn-layout-close');
  if (btnLayoutClose) btnLayoutClose.onclick = () => closeLayout();

  // Canvas bridge messages (layout editor iframe -> portal).
  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (!d || d.source !== 'bp-layout-bridge') return;
    if (!state.layoutOpen || !layoutSession()) return;
    const frame = state.previewFrame;
    if (!frame || ev.source !== frame.contentWindow) return;
    if (d.action === 'ready') {
      postLayoutConfig();
      return;
    }
    if (d.action === 'select') {
      layoutSelect(Number(d.index), true);
      return;
    }
    if (d.action === 'move') {
      layoutMoveClient(Number(d.from), Number(d.toIndex));
      return;
    }
    if (d.action === 'moveUp') layoutAct('up', Number(d.index));
    else if (d.action === 'moveDown') layoutAct('down', Number(d.index));
    else if (d.action === 'duplicate') layoutAct('duplicate', Number(d.index));
    else if (d.action === 'delete') layoutAct('delete', Number(d.index));
    else if (d.action === 'edit') layoutAct('edit', Number(d.index));
  });

  // Leaving the page with unsaved layout changes warns (standing rule).
  window.addEventListener('beforeunload', (ev) => {
    if (state.layoutOpen && state.layout && state.layout.dirty) {
      ev.preventDefault();
      ev.returnValue = '';
    }
  });

  const structureBar = document.getElementById('structure-bar');
  if (structureBar) {
    structureBar.addEventListener('click', (ev) => {
      const t =
        ev.target && ev.target.closest
          ? ev.target.closest('[data-struct-page],[data-struct],[data-struct-insert]')
          : null;
      if (!t || !structureBar.contains(t)) return;
      if (t.hasAttribute('data-struct-insert')) {
        if (t.disabled) return;
        openStructureModuleModal(Number(t.getAttribute('data-struct-insert')));
        return;
      }
      if (t.hasAttribute('data-struct-page')) {
        state.structurePageIdx = Number(t.getAttribute('data-struct-page')) || 0;
        renderStructureLists();
        return;
      }
      if (t.disabled) return;
      const scope = t.getAttribute('data-struct');
      const from = t.getAttribute('data-from');
      const action = t.getAttribute('data-action') || 'move';
      const dir = t.getAttribute('data-dir');
      if (!scope) return;
      applyStructureMove(scope, from, dir, action);
    });
  }

  const btnStructureAddPage = document.getElementById('btn-structure-add-page');
  if (btnStructureAddPage) btnStructureAddPage.onclick = () => openStructurePageModal();

  const btnStructureModuleCancel = document.getElementById('btn-structure-module-cancel');
  if (btnStructureModuleCancel) btnStructureModuleCancel.onclick = () => closeStructureModuleModal();

  const btnStructurePageCancel = document.getElementById('btn-structure-page-cancel');
  if (btnStructurePageCancel) btnStructurePageCancel.onclick = () => closeStructurePageModal();

  const btnStructurePageSave = document.getElementById('btn-structure-page-save');
  if (btnStructurePageSave) {
    btnStructurePageSave.onclick = async () => {
      const input = document.getElementById('structure-page-title');
      const msg = document.getElementById('msg-structure-page');
      const title = input ? String(input.value || '').trim() : '';
      if (!title) {
        if (msg) {
          msg.className = 'msg err';
          msg.textContent = 'Enter a page title.';
        }
        return;
      }
      await applyStructureAddPage(title);
    };
  }

  const structureModuleModal = document.getElementById('structure-module-modal');
  if (structureModuleModal) {
    structureModuleModal.addEventListener('click', (ev) => {
      if (ev.target === structureModuleModal) closeStructureModuleModal();
      const sectionPick = ev.target && ev.target.closest ? ev.target.closest('[data-structure-section-type]') : null;
      if (sectionPick) {
        const cols = resolveStructureCols(sectionPick);
        if (state.canvasPick && state.canvasPick.mode === 'design-module') {
          applyCanvasPickLayout(sectionPick.getAttribute('data-structure-section-type'), cols);
        } else if (!state.canvasPick) {
          applyStructureInsertSection(sectionPick.getAttribute('data-structure-section-type'), cols);
        }
        return;
      }
      const formPick = ev.target && ev.target.closest ? ev.target.closest('[data-structure-form-id]') : null;
      if (formPick) {
        const formId = Number(formPick.getAttribute('data-structure-form-id'));
        if (state.canvasPick && state.canvasPick.mode === 'widget') {
          applyCanvasPickForm(formId);
        } else if (!state.canvasPick) {
          applyStructureInsertForm(formId);
        }
        return;
      }
      const pick = ev.target && ev.target.closest ? ev.target.closest('[data-structure-module-type]') : null;
      if (pick) {
        if (state.canvasPick && state.canvasPick.mode === 'widget') {
          applyCanvasPickModule(pick.getAttribute('data-structure-module-type'));
        } else if (!state.canvasPick) {
          applyStructureInsertModule(pick.getAttribute('data-structure-module-type'));
        }
      }
    });
  }
  const structurePageModal = document.getElementById('structure-page-modal');
  if (structurePageModal) {
    structurePageModal.addEventListener('click', (ev) => {
      if (ev.target === structurePageModal) closeStructurePageModal();
    });
  }

  function onThemeInputChange(ev) {
    const el = ev.target;
    const key = el && el.getAttribute('data-theme-key');
    if (!key || THEME_KEYS.indexOf(key) < 0) return;
    const hex = normalizeThemeHex(el.value);
    if (!hex) return;
    const hexEl = document.getElementById(`theme-hex-${key}`);
    const pickEl = document.getElementById(`theme-pick-${key}`);
    if (hexEl && hexEl !== el) hexEl.value = hex;
    if (pickEl && pickEl !== el) pickEl.value = hex;
    state.theme = { ...state.theme, [key]: hex };
    try {
      const colors = readThemeForm();
      applyThemeLiveToPreview(colors);
    } catch {
      /* incomplete hex while typing */
    }
  }

  function onPaletteInputChange(ev) {
    const el = ev.target;
    if (!el || !el.hasAttribute('data-palette-i')) return;
    const extras = state.themePalette.filter((p) => !p.isRole);
    const i = Number(el.getAttribute('data-palette-i'));
    if (!Number.isInteger(i) || i < 0 || i >= extras.length) return;
    const hex = normalizeThemeHex(el.value);
    if (!hex) return;
    const item = extras[i];
    const from = item.current;
    item.current = hex;
    // Sync sibling input in the same item
    const row = el.closest('.theme-palette-item');
    if (row) {
      row.querySelectorAll('[data-palette-i]').forEach((node) => {
        if (node !== el) node.value = hex;
      });
    }
    // Keep master palette list in sync
    const master = state.themePalette.find((p) => p.original === item.original);
    if (master) master.current = hex;
    applyThemeLiveToPreview(state.theme, {
      paletteRewrites: from && from !== hex ? [{ from, to: hex }] : [],
    });
  }

  for (const key of THEME_KEYS) {
    const hexEl = document.getElementById(`theme-hex-${key}`);
    const pickEl = document.getElementById(`theme-pick-${key}`);
    if (hexEl) {
      hexEl.addEventListener('input', onThemeInputChange);
      hexEl.addEventListener('change', onThemeInputChange);
    }
    if (pickEl) {
      pickEl.addEventListener('input', onThemeInputChange);
      pickEl.addEventListener('change', onThemeInputChange);
    }
  }

  const paletteHost = document.getElementById('theme-palette');
  if (paletteHost) {
    paletteHost.addEventListener('input', onPaletteInputChange);
    paletteHost.addEventListener('change', onPaletteInputChange);
  }

  for (const id of Object.values(CODE_FIELD_IDS)) {
    const codeEl = document.getElementById(id);
    if (codeEl) codeEl.addEventListener('input', syncCodeCounts);
  }

  const btnThemeReset = document.getElementById('btn-theme-reset');
  if (btnThemeReset) {
    btnThemeReset.onclick = () => {
      // Rebuild live from saved by reloading preview (hex rewrites are one-way in the iframe).
      state.theme = { ...state.themeSaved };
      state.themePalette = state.themePalette.map((p) => ({ ...p, current: p.original }));
      fillThemeForm(state.theme);
      fillCodeFields(state.theme);
      fillFontSelects();
      renderThemePalette();
      const msg = document.getElementById('msg-theme');
      if (msg) {
        msg.className = 'msg';
        msg.textContent = 'Resetting preview…';
      }
      loadEditablePreview(state.previewUrl, {
        preserveEditMode: state.editMode,
        preserveFullscreen: state.editFullscreen,
      }).then(() => {
        state.themeLive = {
          primary: state.theme.primary,
          secondary: state.theme.secondary,
          bg: state.theme.bg,
          text: state.theme.text,
        };
        if (msg) {
          msg.className = 'msg';
          msg.textContent = 'Reset to the last saved theme.';
        }
      });
    };
  }

  function bindPairedFontSelect(id, peerId, which) {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('change', () => {
      syncFontSelect(id, peerId);
      onSiteFontPick(which);
    });
  }
  bindPairedFontSelect('theme-font-body', 'edit-font-body', 'body');
  bindPairedFontSelect('edit-font-body', 'theme-font-body', 'body');
  bindPairedFontSelect('theme-font-heading', 'edit-font-heading', 'heading');
  bindPairedFontSelect('edit-font-heading', 'theme-font-heading', 'heading');
  const elementFont = document.getElementById('edit-font-element');
  if (elementFont) {
    if (window.WsFonts) window.WsFonts.fillSelect(elementFont, '', { defaultLabel: 'Site default' });
    elementFont.disabled = true;
    elementFont.addEventListener('change', () => {
      postElementFont(window.WsFonts ? window.WsFonts.selectedName(elementFont) : '');
    });
  }
  if (window.WsFonts) {
    ensureCatalogStyles(document);
    fillFontSelects();
  }

  const btnThemeSave = document.getElementById('btn-theme-save');
  if (btnThemeSave) {
    btnThemeSave.onclick = async () => {
      if (!state.siteEditable || state.themeSaving) return;
      const msg = document.getElementById('msg-theme');
      let colors;
      try {
        colors = { ...readThemeForm(), ...readThemeFonts() };
      } catch (e) {
        if (msg) {
          msg.className = 'msg err';
          msg.textContent = errText(e);
        }
        return;
      }
      const replacements = state.themePalette
        .filter((p) => p.current && p.original && p.current !== p.original)
        .map((p) => ({ from: p.original, to: p.current }));
      // Batch 152 — only code fields the owner actually edited ride
      // along; absent fields leave the stored code untouched.
      const codeFields = readCodeFields();
      // Also include role changes relative to saved (server builds map from old theme).
      state.themeSaving = true;
      syncThemeUi();
      if (msg) {
        msg.className = 'msg';
        msg.textContent = 'Saving theme…';
      }
      try {
        const result = await api('/site/theme', {
          method: 'POST',
          body: JSON.stringify({ ...colors, replacements, ...codeFields }),
        });
        if (result && result.theme) setThemeFromServer(result.theme);
        else {
          state.theme = { ...state.theme, ...colors, ...codeFields };
          state.themeSaved = { ...state.theme };
        }
        if (result && result.previewUrl) state.previewUrl = result.previewUrl;
        if (msg) {
          msg.className = 'msg ok';
          msg.textContent =
            result && result.publicPreviewUpdated
              ? 'Theme saved. Your public preview is up to date.'
              : 'Theme saved. Updating preview…';
        }
        await loadEditablePreview(state.previewUrl, {
          preserveEditMode: state.editMode,
          preserveFullscreen: state.editFullscreen,
        });
        if (msg) {
          const savedText = Object.keys(codeFields).length ? 'Theme saved on your site.' : 'Colors saved on your site.';
          msg.className = 'msg ok';
          msg.textContent = savedText;
          setTimeout(() => {
            if (msg.textContent === savedText) {
              msg.className = 'msg';
              msg.textContent = '';
            }
          }, 4000);
        }
      } catch (e) {
        if (msg) {
          msg.className = 'msg err';
          msg.textContent = errText(e);
        }
      } finally {
        state.themeSaving = false;
        syncThemeUi();
      }
    };
  }

  const btnPublishSite = document.getElementById('btn-publish-site');
  if (btnPublishSite) btnPublishSite.onclick = () => publishSitePreview();

  // Batch 155: Download Backup — POST streams a .tar.gz attachment
  // (the api() helper parses JSON, so this uses fetch directly, the
  // same shape as the staff postcard/export-zip downloads).
  const btnSiteBackup = document.getElementById('btn-site-backup');
  if (btnSiteBackup) {
    btnSiteBackup.onclick = async () => {
      if (!state.siteEditable || btnSiteBackup.disabled) return;
      const msg = document.getElementById('msg-backup');
      btnSiteBackup.disabled = true;
      if (msg) {
        msg.className = 'msg';
        msg.textContent = 'Preparing your backup — this can take a minute…';
      }
      try {
        const res = await fetch('/api/v1/portal/site/standalone-backup', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        if (!res.ok) {
          const data = await res.json().catch(() => null);
          const detail = data && data.error;
          const text =
            (typeof detail === 'string' && detail) ||
            (detail && typeof detail.message === 'string' && detail.message) ||
            res.statusText ||
            `Request failed (${res.status})`;
          const err = new Error(text);
          err.code = (data && typeof data.code === 'string' && data.code) || undefined;
          err.status = res.status;
          throw err;
        }
        const cd = res.headers.get('Content-Disposition') || '';
        let filename = 'site-standalone-backup.tar.gz';
        const m = /filename="([^"]+)"/i.exec(cd) || /filename=([^;]+)/i.exec(cd);
        if (m && m[1]) filename = m[1].trim().replace(/^["']|["']$/g, '');
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        try {
          const a = document.createElement('a');
          a.href = url;
          a.download = filename;
          a.rel = 'noopener';
          document.body.appendChild(a);
          a.click();
          a.remove();
        } finally {
          setTimeout(() => URL.revokeObjectURL(url), 2000);
        }
        if (msg) {
          msg.className = 'msg ok';
          msg.textContent = 'Backup downloaded. Keep it somewhere safe — it holds your whole site and its data.';
        }
      } catch (e) {
        if (msg) {
          msg.className = 'msg err';
          msg.textContent = errText(e);
        }
      } finally {
        btnSiteBackup.disabled = false;
      }
    };
  }

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

  const undoBtn = document.getElementById('btn-edit-undo');
  if (undoBtn) {
    undoBtn.onclick = () => {
      const frame = state.previewFrame;
      if (!frame || !frame.contentWindow || !state.canUndo) return;
      frame.contentWindow.postMessage({ source: 'ws-portal', type: 'undo' }, '*');
    };
  }

  document.getElementById('btn-edit-cancel').onclick = async () => {
    const keepMode = state.editMode;
    const keepFs = state.editFullscreen;
    clearPendingEdits();
    await loadEditablePreview(state.previewUrl);
    if (keepMode && state.siteEditable) setEditMode(true, { fullscreen: keepFs });
    else if (keepFs && state.siteEditable) setEditFullscreen(true);
  };

  const logoUploadBtn = document.getElementById('btn-logo-upload');
  const logoRemoveBtn = document.getElementById('btn-logo-remove');
  const logoModeText = document.getElementById('logo-mode-text');
  const logoModeImage = document.getElementById('logo-mode-image');
  if (logoUploadBtn) {
    logoUploadBtn.onclick = async () => {
      try {
        const file = await pickImageFile();
        if (!file) return;
        await applyLogoMode('image', file);
      } catch (e) {
        if (e && e.message === 'cancelled') return;
        const msg = document.getElementById('msg-logo');
        if (msg) {
          msg.className = 'msg err';
          msg.textContent = errText(e);
        }
      }
    };
  }
  if (logoRemoveBtn) {
    logoRemoveBtn.onclick = () => applyLogoMode('text');
  }
  if (logoModeText) {
    logoModeText.onchange = () => {
      if (logoModeText.checked && state.logo && state.logo.mode === 'image') applyLogoMode('text');
    };
  }
  if (logoModeImage) {
    logoModeImage.onchange = async () => {
      if (!logoModeImage.checked) return;
      if (state.logo && state.logo.mode === 'image') return;
      try {
        const file = await pickImageFile();
        if (!file) {
          syncLogoUi();
          return;
        }
        await applyLogoMode('image', file);
      } catch (e) {
        syncLogoUi();
        if (e && e.message === 'cancelled') return;
        const msg = document.getElementById('msg-logo');
        if (msg) {
          msg.className = 'msg err';
          msg.textContent = errText(e);
        }
      }
    };
  }

  const btnAiCancel = document.getElementById('btn-ai-image-cancel');
  const btnAiGenerate = document.getElementById('btn-ai-image-generate');
  const aiModal = document.getElementById('ai-image-modal');
  if (btnAiCancel) btnAiCancel.onclick = () => closeAiImageModal();
  if (btnAiGenerate) btnAiGenerate.onclick = () => submitAiImageGenerate();
  if (aiModal) {
    aiModal.addEventListener('click', (ev) => {
      if (ev.target === aiModal && !state.imageUploading) closeAiImageModal();
    });
  }
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && aiModal && !aiModal.hidden && !state.imageUploading) {
      closeAiImageModal();
    }
  });

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
      msg.textContent = data.publicPreviewUpdated
        ? 'Saved. Your public preview is up to date.'
        : 'Saved locally. Public Cloudflare preview will update on the next successful publish.';
      if (data.previewUrl) state.previewUrl = data.previewUrl;
      setTimeout(() => {
        if (msg.textContent.indexOf('Saved') === 0) {
          msg.className = 'msg';
          msg.textContent = '';
        }
      }, 4000);
    } catch (e) {
      msg.className = 'msg err';
      msg.textContent = errText(e);
    } finally {
      btn.disabled = false;
      cancel.disabled = false;
      updateEditBar();
    }
  };

  async function loadChangesHistory() {
    const list = document.getElementById('changes-history-list');
    if (!list) return;
    try {
      const data = await api('/changes');
      const requests = (data && data.requests) || [];
      if (!requests.length) {
        list.innerHTML =
          '<p class="hint" style="margin:0">No requests yet. When you submit a change request above, it will appear here so you can follow its progress.</p>';
        return;
      }
      list.innerHTML = requests
        .map((r) => {
          const when = r.created_at
            ? new Date(String(r.created_at).replace(' ', 'T') + 'Z').toLocaleDateString(undefined, {
                year: 'numeric',
                month: 'long',
                day: 'numeric',
              })
            : '';
          return `<div style="padding:10px 0;border-top:1px solid var(--line,#e2e8f0)">
            <div class="row" style="justify-content:space-between;gap:8px;flex-wrap:wrap">
              <strong>${esc(r.kind_label || r.kind || '')}</strong>
              <span class="status-pill">${esc(r.status_label || '')}</span>
            </div>
            <p style="margin:6px 0 0;white-space:pre-wrap">${esc(r.details || '')}</p>
            <p class="hint" style="margin:4px 0 0;font-size:.85rem">${esc(when)}</p>
          </div>`;
        })
        .join('');
    } catch (e) {
      list.innerHTML =
        '<p class="hint" style="margin:0">Your requests could not be loaded. ' +
        '<button type="button" class="btn ghost small" id="changes-retry">Retry</button></p>';
      const retry = document.getElementById('changes-retry');
      if (retry) retry.onclick = () => loadChangesHistory().catch(() => {});
    }
  }

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
      loadChangesHistory().catch(() => {});
    } catch (e) {
      msg.className = 'msg err';
      msg.textContent = errText(e);
    } finally {
      btn.disabled = false;
    }
  };

  async function generate(period) {
    const msg = document.getElementById('msg-social');
    const weekBtn = document.getElementById('gen-week');
    const monthBtn = document.getElementById('gen-month');
    msg.className = 'msg';
    const cost = state.contentCredits;
    msg.textContent =
      (period === 'week' ? 'Generating a week' : 'Generating a month') +
      (cost > 0 ? ` (${cost} credit${cost === 1 ? '' : 's'})…` : '…');
    weekBtn.disabled = true;
    monthBtn.disabled = true;
    try {
      const data = await api('/social/generate', {
        method: 'POST',
        body: JSON.stringify({ period }),
      });
      if (data && data.credits_balance != null) state.creditsBalance = Number(data.credits_balance);
      msg.className = 'msg ok';
      msg.textContent = 'Content queued. Refreshing calendar…';
      await loadCalendar();
      const charged = Number((data && data.credits_charged) || 0);
      msg.textContent =
        charged > 0
          ? `New posts added. Used ${charged} credit${charged === 1 ? '' : 's'} (${state.creditsBalance} left).`
          : 'New posts added to your calendar.';
    } catch (e) {
      msg.className = 'msg err';
      msg.textContent = errText(e);
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
    if (act === 'save-caption') return saveCaption(id);
    if (act === 'approve') {
      const msg = document.getElementById('msg-social');
      try {
        await api('/social/posts/approve', {
          method: 'POST',
          body: JSON.stringify({ postIds: [Number(id)] }),
        });
        msg.className = 'msg ok';
        msg.textContent = 'Post approved and scheduled.';
        await loadCalendar();
      } catch (e) {
        msg.className = 'msg err';
        msg.textContent = errText(e);
      }
      return;
    }
    if (act === 'share-native') return sharePost(post, 'native');
    if (act === 'share-fb') return sharePost(post, 'fb');
    if (act === 'share-ig') return sharePost(post, 'ig');
    if (act === 'copy') return sharePost(post, 'copy');
  };

  document.getElementById('post-list').onchange = async (ev) => {
    const input = ev.target.closest('input[data-act="sched"]');
    if (!input) return;
    const id = input.getAttribute('data-id');
    const msg = document.getElementById('msg-social');
    const val = String(input.value || '').trim();
    if (!val) return;
    try {
      const scheduled_at = val.length === 16 ? `${val}:00` : val;
      await api(`/social/posts/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ scheduled_at, status: 'scheduled' }),
      });
      msg.className = 'msg ok';
      msg.textContent = 'Schedule updated.';
      await loadCalendar();
    } catch (e) {
      msg.className = 'msg err';
      msg.textContent = errText(e);
    }
  };

  const btnMeta = document.getElementById('btn-meta-connect');
  if (btnMeta) {
    btnMeta.onclick = async () => {
      const msg = document.getElementById('msg-meta');
      msg.className = 'msg';
      msg.textContent = 'Starting Meta OAuth…';
      try {
        const data = await api('/social/oauth/start?returnTo=' + encodeURIComponent('/portal?connected=1#/social'));
        if (data && data.url) location.href = data.url;
        else throw new Error('No OAuth URL');
      } catch (e) {
        msg.className = 'msg err';
        msg.textContent = errText(e);
      }
    };
  }

  const accountsList = document.getElementById('social-accounts-list');
  if (accountsList) {
    accountsList.onclick = async (ev) => {
      const btn = ev.target.closest('[data-disconnect]');
      if (!btn) return;
      const msg = document.getElementById('msg-meta');
      try {
        await api(`/social/accounts/${btn.getAttribute('data-disconnect')}`, { method: 'DELETE' });
        msg.className = 'msg ok';
        msg.textContent = 'Disconnected.';
        await loadSocialAccounts();
      } catch (e) {
        msg.className = 'msg err';
        msg.textContent = errText(e);
      }
    };
  }

  const btnFormAdd = document.getElementById('btn-form-add-field');
  if (btnFormAdd) {
    btnFormAdd.onclick = () => {
      formState.fields = collectFormFieldsFromEditor();
      formState.fields.push({
        field_key: '',
        label: 'New field',
        field_type: 'text',
        required: false,
        placeholder: '',
        sort_order: formState.fields.length,
      });
      renderFormFieldsEditor();
    };
  }

  const fieldsEditor = document.getElementById('form-fields-editor');
  if (fieldsEditor) {
    fieldsEditor.onclick = (ev) => {
      const btn = ev.target.closest('[data-fk="remove"]');
      if (!btn) return;
      const row = btn.closest('[data-field-i]');
      const i = Number(row && row.getAttribute('data-field-i'));
      formState.fields = collectFormFieldsFromEditor().filter((_, idx) => idx !== i);
      renderFormFieldsEditor();
    };
  }

  function collectFormMeta() {
    const embedCb = document.getElementById('form-embed-on-page');
    const navCb = document.getElementById('form-add-to-nav');
    const pageSel = document.getElementById('form-target-page');
    const nameEl = document.getElementById('form-name');
    return {
      name: nameEl ? nameEl.value.trim() : '',
      title: document.getElementById('form-title').value.trim(),
      intro: document.getElementById('form-intro').value.trim(),
      submit_label: document.getElementById('form-submit-label').value.trim(),
      notify_email: document.getElementById('form-notify').value.trim(),
      success_message: document.getElementById('form-success').value.trim(),
      embed_on_page: !!(embedCb && embedCb.checked),
      embed_enabled: !!(embedCb && embedCb.checked),
      add_to_nav: !!(navCb && navCb.checked),
      nav_visible: !!(navCb && navCb.checked),
      target_page_slug: pageSel ? pageSel.value : 'contact',
      fields: formState.fields,
    };
  }

  async function saveFormBuilder() {
    const msg = document.getElementById('msg-forms');
    msg.className = 'msg';
    msg.textContent = 'Saving…';
    formState.fields = collectFormFieldsFromEditor();
    if (!formState.editingId) {
      msg.className = 'msg err';
      msg.textContent = 'No form selected.';
      return null;
    }
    try {
      const data = await api(`/forms/${formState.editingId}`, {
        method: 'PUT',
        body: JSON.stringify(collectFormMeta()),
      });
      msg.className = 'msg ok';
      msg.textContent = 'Form saved.';
      if (data.form) applyFormToEditor(data.form, data.embed);
      await loadForms();
      return data;
    } catch (e) {
      msg.className = 'msg err';
      msg.textContent = errText(e);
      return null;
    }
  }

  const btnFormSave = document.getElementById('btn-form-save');
  if (btnFormSave) btnFormSave.onclick = () => saveFormBuilder();

  async function publishForm() {
    const msg = document.getElementById('msg-forms');
    msg.className = 'msg';
    msg.textContent = 'Publishing…';
    try {
      const saved = await saveFormBuilder();
      if (!saved && !formState.editingId) return;
      const meta = collectFormMeta();
      const data = await api(`/forms/${formState.editingId}/publish`, {
        method: 'POST',
        body: JSON.stringify({
          embed_on_page: meta.embed_on_page,
          embed_enabled: meta.embed_enabled,
          target_page_slug: meta.target_page_slug,
        }),
      });
      msg.className = 'msg ok';
      if (!meta.embed_enabled) {
        msg.textContent = 'Published — embed URL ready (not added to a page).';
      } else if (data.publicPreviewUpdated || data.via === 'cloudflare' || data.via === 'app_url') {
        msg.textContent = `Published on your ${meta.target_page_slug || 'contact'} page (live site updated).`;
      } else {
        msg.textContent = `Saved on your ${meta.target_page_slug || 'contact'} page — click Publish website if the live link still looks old.`;
      }
      if (data.form) applyFormToEditor(data.form, data.embed);
      await loadForms();
    } catch (e) {
      msg.className = 'msg err';
      msg.textContent = errText(e);
    }
  }

  const btnPublish = document.getElementById('btn-form-publish');
  if (btnPublish) btnPublish.onclick = () => publishForm();

  const btnLeadScoutRefresh = document.getElementById('btn-leadscout-refresh');
  if (btnLeadScoutRefresh) btnLeadScoutRefresh.onclick = () => loadLeadScout().catch(() => {});
  const btnLeadScoutRetry = document.getElementById('btn-leadscout-retry');
  if (btnLeadScoutRetry) {
    btnLeadScoutRetry.onclick = async () => {
      try {
        await api('/leadscout/retry', { method: 'POST', body: '{}' });
        await loadLeadScout();
      } catch (e) {
        const msg = document.getElementById('msg-leadscout-list');
        if (msg) msg.textContent = errText(e);
      }
    };
  }
  // Batch 45 — clear resolved capture failures from the health panel.
  const btnLeadScoutClear = document.getElementById('btn-leadscout-clear-resolved');
  if (btnLeadScoutClear) {
    btnLeadScoutClear.onclick = async () => {
      try {
        await api('/leadscout/failures/clear-resolved', { method: 'POST', body: '{}' });
        await loadLeadScout();
      } catch (e) {
        const msg = document.getElementById('msg-leadscout-list');
        if (msg) msg.textContent = errText(e);
      }
    };
  }
  const leadScoutQ = document.getElementById('leadscout-q');
  if (leadScoutQ) {
    let t = null;
    leadScoutQ.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => loadLeadScout().catch(() => {}), 280);
    });
  }

  const btnFormNew = document.getElementById('btn-form-new');
  if (btnFormNew) {
    btnFormNew.onclick = async () => {
      const msg = document.getElementById('msg-forms-list') || document.getElementById('msg-forms');
      if (msg) {
        msg.className = 'msg';
        msg.textContent = 'Creating…';
      }
      try {
        const data = await api('/forms', {
          method: 'POST',
          body: JSON.stringify({
            name: 'Contact form',
            embed_on_page: true,
            embed_enabled: true,
            add_to_nav: false,
            target_page_slug: 'contact',
          }),
        });
        if (data.pages) formState.pages = data.pages;
        applyFormToEditor(data.form || {}, data.embed);
        await loadForms();
        if (msg) {
          msg.className = 'msg ok';
          msg.textContent = 'Form created.';
        }
      } catch (e) {
        if (msg) {
          msg.className = 'msg err';
          msg.textContent = errText(e);
        }
      }
    };
  }

  const btnFormBack = document.getElementById('btn-form-back');
  if (btnFormBack) {
    btnFormBack.onclick = () => {
      showFormsList();
      loadForms().catch(() => {});
    };
  }

  const btnFormDelete = document.getElementById('btn-form-delete');
  if (btnFormDelete) {
    btnFormDelete.onclick = async () => {
      if (!formState.editingId) return;
      if (!window.confirm('Delete this form? Submissions for it will be removed.')) return;
      const msg = document.getElementById('msg-forms');
      msg.className = 'msg';
      msg.textContent = 'Deleting…';
      try {
        await api(`/forms/${formState.editingId}`, { method: 'DELETE' });
        formState.editingId = null;
        showFormsList();
        await loadForms();
        msg.className = 'msg ok';
        msg.textContent = 'Form deleted.';
      } catch (e) {
        msg.className = 'msg err';
        msg.textContent = errText(e);
      }
    };
  }

  initMcpEndpointUi();

  const btnSoulCopy = document.getElementById('btn-soul-copy');
  if (btnSoulCopy) {
    btnSoulCopy.onclick = async () => {
      const msg = document.getElementById('msg-soul');
      try {
        if (!soulLoaded) await loadAgentSoul();
        if (!soulMarkdown) throw new Error('The document is still loading — try again in a moment.');
        const copied = await copyText(soulMarkdown);
        if (!copied) throw new Error('Copy failed — use Download instead.');
        if (msg) {
          msg.className = 'msg ok';
          msg.textContent = 'SOUL.md copied — paste it into your agent to add it.';
        }
      } catch (e) {
        if (msg) {
          msg.className = 'msg err';
          msg.textContent = errText(e);
        }
      }
    };
  }

  const btnMcpCopyConfig = document.getElementById('btn-mcp-copy-config');
  if (btnMcpCopyConfig) {
    btnMcpCopyConfig.onclick = () => copyText(mcpCursorSnippet(mcpEndpoint(), '<YOUR_MCP_TOKEN>'));
  }
  const btnMcpCopyUrl = document.getElementById('btn-mcp-copy-url');
  if (btnMcpCopyUrl) {
    btnMcpCopyUrl.onclick = () => copyText(mcpEndpoint());
  }
  const btnMcpCopyToken = document.getElementById('btn-mcp-copy-token');
  if (btnMcpCopyToken) {
    btnMcpCopyToken.onclick = () => {
      if (!mcpLastToken) return;
      copyText(mcpLastToken);
    };
  }
  const btnMcpCopyFilled = document.getElementById('btn-mcp-copy-filled');
  if (btnMcpCopyFilled) {
    btnMcpCopyFilled.onclick = () => {
      if (!mcpLastToken) return;
      copyText(mcpCursorSnippet(mcpEndpoint(), mcpLastToken));
    };
  }
  const mcpTokensBody = document.getElementById('mcp-tokens-body');
  if (mcpTokensBody) {
    mcpTokensBody.addEventListener('click', async (ev) => {
      const btn = ev.target.closest('[data-mcp-revoke]');
      if (!btn) return;
      const id = btn.getAttribute('data-mcp-revoke');
      if (!window.confirm('Revoke this token? Agents using it will lose access.')) return;
      btn.disabled = true;
      try {
        await api(`/mcp/token/${id}`, { method: 'DELETE' });
        await refreshMcpTokens();
      } catch (e) {
        btn.disabled = false;
        const msg = document.getElementById('msg-mcp');
        if (msg) {
          msg.className = 'msg err';
          msg.textContent = errText(e);
        }
      }
    });
  }
  const btnMcp = document.getElementById('btn-mcp-token');
  if (btnMcp) {
    btnMcp.onclick = async () => {
      const msg = document.getElementById('msg-mcp');
      const reveal = document.getElementById('mcp-token-reveal');
      const out = document.getElementById('mcp-token-out');
      const nameEl = document.getElementById('mcp-token-name');
      msg.className = 'msg';
      msg.textContent = 'Creating token…';
      try {
        const name = nameEl ? nameEl.value.trim() : '';
        const data = await api('/mcp/token', {
          method: 'POST',
          body: JSON.stringify({ name: name || undefined }),
        });
        mcpLastToken = data.token || '';
        if (out) out.textContent = mcpLastToken;
        if (reveal) reveal.hidden = !mcpLastToken;
        msg.className = 'msg ok';
        msg.textContent = data.hint || 'Copy now — shown only once.';
        await refreshMcpTokens();
      } catch (e) {
        msg.className = 'msg err';
        msg.textContent = errText(e);
      }
    };
  }
  const btnMcpUpgrade = document.getElementById('btn-mcp-upgrade');
  if (btnMcpUpgrade) {
    btnMcpUpgrade.onclick = () => showPortalPanel('billing');
  }

  const modulesTypeTabs = document.getElementById('modules-type-tabs');
  if (modulesTypeTabs) {
    modulesTypeTabs.addEventListener('click', async (ev) => {
      const btn = ev.target.closest('[data-module-type]');
      if (!btn) return;
      moduleState.current = btn.getAttribute('data-module-type');
      moduleState.pane = 'content';
      storeModuleType(moduleState.current);
      closeModuleModal();
      renderModuleTypeTabs();
      syncModulesPaneTabs();
      moduleMsg('', true);
      try {
        await loadModuleItems();
      } catch (e) {
        moduleMsg(errText(e), false);
      }
    });
  }

  const modulesPaneTabs = document.getElementById('modules-pane-tabs');
  if (modulesPaneTabs) {
    modulesPaneTabs.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-modules-pane]');
      if (!btn) return;
      const isBookings = moduleState.current === 'bookings';
      const isChatbot = moduleState.current === 'chatbot';
      const isEstimate = moduleState.current === 'estimate';
      if (!isBookings && !isChatbot && !isEstimate) return;
      const next = btn.getAttribute('data-modules-pane') || 'content';
      const allowed = isChatbot
        ? new Set(['content', 'settings', 'inbox'])
        : isEstimate
          ? new Set(['content', 'calc', 'requests'])
          : new Set(['content', 'hours', 'appointments']);
      moduleState.pane = allowed.has(next) ? next : 'content';
      syncModulesPaneTabs();
    });
  }

  const formsPaneTabs = document.getElementById('forms-pane-tabs');
  if (formsPaneTabs) {
    formsPaneTabs.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-forms-pane]');
      if (!btn) return;
      setFormsPane(btn.getAttribute('data-forms-pane'));
    });
    setFormsPane('setup');
  }

  const modulesItems = document.getElementById('modules-items');
  if (modulesItems) {
    modulesItems.addEventListener('click', async (ev) => {
      const editBtn = ev.target.closest('[data-module-edit]');
      if (editBtn) {
        const id = Number(editBtn.getAttribute('data-module-edit'));
        const item = (moduleState.items || []).find((x) => Number(x.id) === id);
        if (item) openModuleEditor(item);
      }
    });
  }

  const modulesBookingRoot =
    document.querySelector('.modules-admin-main') ||
    document.getElementById('modules-pane-hours') ||
    document.getElementById('modules-booking-panel');
  if (modulesBookingRoot) {
    modulesBookingRoot.addEventListener('change', async (ev) => {
      if (ev.target && ev.target.id === 'booking-show-archived') {
        moduleState.showArchivedAppointments = !!ev.target.checked;
        moduleMsg(moduleState.showArchivedAppointments ? 'Showing archived…' : 'Hiding archived…', true);
        try {
          await loadModuleItems();
          moduleMsg('', true);
        } catch (e) {
          moduleMsg(errText(e), false);
        }
      }
    });
    modulesBookingRoot.addEventListener('click', async (ev) => {
      const archiveBtn = ev.target.closest('[data-appt-archive]');
      if (archiveBtn) {
        const id = Number(archiveBtn.getAttribute('data-appt-archive'));
        const archived = archiveBtn.getAttribute('data-archived') === 'true';
        moduleMsg(archived ? 'Archiving…' : 'Restoring…', true);
        try {
          await api(`/modules/bookings/appointments/${id}`, {
            method: 'PUT',
            body: JSON.stringify({ archived }),
          });
          moduleMsg(archived ? 'Appointment archived.' : 'Appointment restored.', true);
          await loadModuleItems();
        } catch (e) {
          moduleMsg(errText(e), false);
        }
        return;
      }
      const apptDelBtn = ev.target.closest('[data-appt-delete]');
      if (apptDelBtn) {
        const id = Number(apptDelBtn.getAttribute('data-appt-delete'));
        if (!window.confirm('Delete this appointment? The booking is removed; the customer stays in LeadScout.')) return;
        moduleMsg('Deleting appointment…', true);
        try {
          await api(`/modules/bookings/appointments/${id}`, { method: 'DELETE' });
          moduleMsg('Appointment deleted.', true);
          await loadModuleItems();
        } catch (e) {
          moduleMsg(errText(e), false);
        }
        return;
      }
      const apptBtn = ev.target.closest('[data-appt-status]');
      if (apptBtn) {
        const id = Number(apptBtn.getAttribute('data-appt-status'));
        const status = apptBtn.getAttribute('data-status');
        moduleMsg('Updating appointment…', true);
        try {
          await api(`/modules/bookings/appointments/${id}`, {
            method: 'PUT',
            body: JSON.stringify({ status }),
          });
          moduleMsg('Appointment updated.', true);
          await loadModuleItems();
        } catch (e) {
          moduleMsg(errText(e), false);
        }
        return;
      }
      if (ev.target && ev.target.id === 'btn-booking-hours-save') {
        const hoursRoot = document.getElementById('modules-pane-hours') || modulesBookingRoot;
        const hours = [];
        BOOKING_WEEKDAYS.forEach((_, i) => {
          const on = hoursRoot.querySelector(`[data-bh-day="${i}"]`);
          const range = hoursRoot.querySelector(`[data-bh-range="${i}"]`);
          if (!on || !on.checked || !range) return;
          const parts = String(range.value || '')
            .split(/[–-]/)
            .map((s) => s.trim());
          if (parts.length >= 2) {
            hours.push({ weekday: i, start_time: parts[0], end_time: parts[1] });
          }
        });
        moduleMsg('Saving hours…', true);
        try {
          await api('/modules/bookings/hours', {
            method: 'PUT',
            body: JSON.stringify({ hours }),
          });
          moduleMsg('Hours saved.', true);
          await loadModuleItems();
        } catch (e) {
          moduleMsg(errText(e), false);
        }
        return;
      }
      if (ev.target && ev.target.id === 'btn-booking-settings-save') {
        const auto = document.getElementById('booking-auto-confirm');
        const notice = document.getElementById('booking-min-notice');
        const ahead = document.getElementById('booking-max-ahead');
        const discEnabled = document.getElementById('booking-discount-enabled');
        const discKind = document.getElementById('booking-discount-kind');
        const discValue = document.getElementById('booking-discount-value');
        const discLabel = document.getElementById('booking-discount-label');
        moduleMsg('Saving settings…', true);
        try {
          await api('/modules/bookings/settings', {
            method: 'PUT',
            body: JSON.stringify({
              auto_confirm: !!(auto && auto.checked),
              min_notice_hours: notice ? Number(notice.value) : undefined,
              max_days_ahead: ahead ? Number(ahead.value) : undefined,
              // Batch 136: fixed discounts are entered in dollars and
              // stored as cents; percent is stored as whole points.
              ...(discEnabled
                ? {
                    discount_enabled: !!discEnabled.checked,
                    discount_kind: discKind ? discKind.value : 'percent',
                    discount_value:
                      discKind && discKind.value === 'fixed'
                        ? Math.round((Number(discValue && discValue.value) || 0) * 100)
                        : Math.round(Number(discValue && discValue.value) || 0),
                    discount_label: discLabel ? discLabel.value : '',
                  }
                : {}),
            }),
          });
          moduleMsg('Settings saved.', true);
          await loadModuleItems();
        } catch (e) {
          moduleMsg(errText(e), false);
        }
      }
      const estReqDelBtn = ev.target.closest('[data-est-req-delete]');
      if (estReqDelBtn) {
        const id = Number(estReqDelBtn.getAttribute('data-est-req-delete'));
        if (!window.confirm('Delete this estimate request? The request is removed; the customer stays in LeadScout.')) return;
        moduleMsg('Deleting request…', true);
        try {
          await api(`/modules/estimate/requests/${id}`, { method: 'DELETE' });
          moduleMsg('Request deleted.', true);
          await loadModuleItems();
        } catch (e) {
          moduleMsg(errText(e), false);
        }
        return;
      }
      const estReqBtn = ev.target.closest('[data-est-req-status]');
      if (estReqBtn) {
        const id = Number(estReqBtn.getAttribute('data-est-req-status'));
        const status = estReqBtn.getAttribute('data-status');
        moduleMsg('Updating request…', true);
        try {
          await api(`/modules/estimate/requests/${id}`, {
            method: 'PUT',
            body: JSON.stringify({ status }),
          });
          moduleMsg('Request updated.', true);
          await loadModuleItems();
        } catch (e) {
          moduleMsg(errText(e), false);
        }
        return;
      }
      if (ev.target && ev.target.id === 'btn-estimate-config-save') {
        const val = (id) => {
          const n = document.getElementById(id);
          return n ? n.value : undefined;
        };
        moduleMsg('Saving calculator…', true);
        try {
          await api('/modules/estimate/config', {
            method: 'PUT',
            body: JSON.stringify({
              title: val('estimate-title'),
              intro: val('estimate-intro'),
              service_label: val('estimate-service-label'),
              base_price: val('estimate-base-price'),
              display_mode: val('estimate-display-mode'),
              range_percent: Number(val('estimate-range-percent')),
              disclaimer: val('estimate-disclaimer'),
              submit_label: val('estimate-submit-label'),
            }),
          });
          moduleMsg('Calculator saved.', true);
          await loadModuleItems();
        } catch (e) {
          moduleMsg(errText(e), false);
        }
      }
      if (ev.target && ev.target.id === 'btn-socialfeed-config-save') {
        const val = (id) => {
          const n = document.getElementById(id);
          return n ? n.value : undefined;
        };
        moduleMsg('Saving feed settings…', true);
        try {
          await api('/modules/socialfeed/config', {
            method: 'PUT',
            body: JSON.stringify({
              networks: val('socialfeed-networks'),
              max_posts: Number(val('socialfeed-max-posts')),
              layout: val('socialfeed-layout'),
            }),
          });
          moduleMsg('Feed settings saved.', true);
          await loadModuleItems();
        } catch (e) {
          moduleMsg(errText(e), false);
        }
      }
      if (ev.target && ev.target.id === 'btn-socialfeed-refresh') {
        moduleMsg('Checking for new posts…', true);
        try {
          const r = await api('/modules/socialfeed/refresh', { method: 'POST', body: '{}' });
          if (r && r.preview) moduleState.socialfeed = r.preview;
          moduleMsg('Feed is up to date.', true);
          await loadModuleItems();
        } catch (e) {
          moduleMsg(errText(e), false);
        }
      }
      if (ev.target && ev.target.id === 'btn-googlereviews-config-save') {
        const val = (id) => {
          const n = document.getElementById(id);
          return n ? n.value : undefined;
        };
        moduleMsg('Saving review settings…', true);
        try {
          const r = await api('/modules/googlereviews/config', {
            method: 'PUT',
            body: JSON.stringify({
              place_id: val('googlereviews-place-id'),
              max_reviews: Number(val('googlereviews-max-reviews')),
              min_rating: Number(val('googlereviews-min-rating')),
            }),
          });
          if (r && r.preview) moduleState.googlereviews = r.preview;
          moduleMsg('Review settings saved.', true);
          await loadModuleItems();
        } catch (e) {
          moduleMsg(errText(e), false);
        }
      }
      if (ev.target && ev.target.id === 'btn-googlereviews-refresh') {
        moduleMsg('Refreshing reviews from Google…', true);
        try {
          const r = await api('/modules/googlereviews/refresh', { method: 'POST', body: '{}' });
          if (r && r.preview) moduleState.googlereviews = r.preview;
          moduleMsg(
            r && r.refreshed ? 'Reviews are up to date.' : (r && r.preview && r.preview.message) || 'Reviews could not be refreshed yet.',
            true
          );
          await loadModuleItems();
        } catch (e) {
          moduleMsg(errText(e), false);
        }
      }
      if (ev.target && ev.target.id === 'btn-calltracking-phone-save') {
        // Batch 25c: the client saves ONLY their phone number — the
        // endpoint ignores everything else by construction.
        // Batch 76: the Missed-Call Rescue toggle is the one other
        // whitelisted field that may ride along with this save.
        const node = document.getElementById('calltracking-phone-number');
        const rescueNode = document.getElementById('calltracking-rescue-enabled');
        moduleMsg('Saving your number…', true);
        try {
          await api('/modules/calltracking/config', {
            method: 'PUT',
            body: JSON.stringify({
              phone: node ? node.value : '',
              rescue_enabled: rescueNode ? !!rescueNode.checked : undefined,
            }),
          });
          moduleMsg('Your number is saved — it shows on your site and your calls forward to it.', true);
          await loadModuleItems();
        } catch (e) {
          moduleMsg(errText(e), false);
        }
      }
      if (ev.target && ev.target.id === 'btn-members-config-save') {
        const val = (id) => {
          const n = document.getElementById(id);
          return n ? n.value : undefined;
        };
        const checked = (name) =>
          Array.from(document.querySelectorAll(`[data-members-page="${name}"]:checked`)).map((n) => n.value);
        moduleMsg('Saving membership settings…', true);
        try {
          const accessLevel = val('members-access-level');
          const cfgBody = {
            gate_mode: val('members-gate-mode'),
            gated_pages: checked('gated'),
            public_pages: checked('public'),
            signup_mode: val('members-signup-mode'),
            wall_headline: val('members-wall-headline'),
          };
          if (accessLevel) cfgBody.access_level = accessLevel;
          if (accessLevel === 'tier') {
            const tierSel = val('members-access-tier');
            if (tierSel) cfgBody.access_tier_id = Number(tierSel);
          }
          await api('/modules/members/config', {
            method: 'PUT',
            body: JSON.stringify(cfgBody),
          });
          moduleMsg(
            'Membership settings saved. They take effect the next time your site is published or re-exported.',
            true
          );
          await loadModuleItems();
        } catch (e) {
          moduleMsg(errText(e), false);
        }
        return;
      }
      const memberStatusBtn = ev.target.closest('[data-member-status]');
      if (memberStatusBtn) {
        const id = Number(memberStatusBtn.getAttribute('data-member-status'));
        const status = memberStatusBtn.getAttribute('data-status');
        moduleMsg('Updating member…', true);
        try {
          await api(`/modules/members/${id}`, {
            method: 'PUT',
            body: JSON.stringify({ status }),
          });
          moduleMsg(status === 'active' ? 'Member is active.' : 'Member disabled.', true);
          await loadModuleItems();
        } catch (e) {
          moduleMsg(errText(e), false);
        }
        return;
      }
      const memberDeleteBtn = ev.target.closest('[data-member-delete]');
      if (memberDeleteBtn) {
        if (!window.confirm('Delete this member account? They will no longer be able to log in.')) return;
        const id = Number(memberDeleteBtn.getAttribute('data-member-delete'));
        moduleMsg('Deleting member…', true);
        try {
          await api(`/modules/members/${id}`, { method: 'DELETE' });
          moduleMsg('Member deleted.', true);
          await loadModuleItems();
        } catch (e) {
          moduleMsg(errText(e), false);
        }
        return;
      }
      // Membership Part 2: Stripe keys.
      if (ev.target && ev.target.id === 'btn-membership-keys-save') {
        const val = (id) => {
          const n = document.getElementById(id);
          return n ? n.value : '';
        };
        moduleMsg('Saving your Stripe keys…', true);
        try {
          await api('/modules/members/payments', {
            method: 'PUT',
            body: JSON.stringify({
              publishable_key: val('membership-pk'),
              secret_key: val('membership-sk'),
              webhook_secret: val('membership-whsec'),
            }),
          });
          moduleMsg('Stripe keys saved (encrypted). Paid plans can now be activated.', true);
          await loadModuleItems();
        } catch (e) {
          moduleMsg(errText(e), false);
        }
        return;
      }
      if (ev.target && ev.target.id === 'btn-membership-keys-clear') {
        if (!window.confirm('Disconnect your Stripe account? Paid plans will stop being joinable until you reconnect.')) return;
        moduleMsg('Disconnecting Stripe…', true);
        try {
          await api('/modules/members/payments', { method: 'DELETE' });
          moduleMsg('Stripe disconnected.', true);
          await loadModuleItems();
        } catch (e) {
          moduleMsg(errText(e), false);
        }
        return;
      }
      // Copy helpers (webhook URL + event list).
      const copyTextBtn = ev.target.closest('[data-copy-text]');
      if (copyTextBtn) {
        const text = copyTextBtn.getAttribute('data-copy-text') || '';
        try {
          await navigator.clipboard.writeText(text);
          moduleMsg('Copied.', true);
        } catch {
          moduleMsg('Copy failed — select the text and copy it manually.', false);
        }
        return;
      }
      const copyInputBtn = ev.target.closest('[data-copy-input]');
      if (copyInputBtn) {
        const input = document.getElementById(copyInputBtn.getAttribute('data-copy-input'));
        if (input) {
          try {
            await navigator.clipboard.writeText(input.value);
            moduleMsg('Copied.', true);
          } catch {
            input.select();
            moduleMsg('Select the text and copy it.', false);
          }
        }
        return;
      }
      // Membership tiers.
      if (ev.target && ev.target.id === 'btn-tier-save') {
        const val = (id) => {
          const n = document.getElementById(id);
          return n ? n.value : '';
        };
        const editing = moduleState.memberTierEditing;
        const body = {
          name: val('tier-name'),
          description: val('tier-description'),
          price: val('tier-price'),
          interval: val('tier-interval') || 'month',
          active: val('tier-active') !== '0',
        };
        moduleMsg('Saving plan…', true);
        try {
          const r = editing
            ? await api(`/modules/members/tiers/${editing.id}`, { method: 'PUT', body: JSON.stringify(body) })
            : await api('/modules/members/tiers', { method: 'POST', body: JSON.stringify(body) });
          moduleState.memberTierEditing = null;
          if (r && r.stripe_state === 'not_connected') {
            moduleMsg(
              'Plan saved, but it stays OFF: connect your Stripe account below to charge for it. (Free plans work without Stripe.)',
              true
            );
          } else {
            moduleMsg('Plan saved.', true);
          }
          await loadModuleItems();
        } catch (e) {
          moduleMsg(errText(e), false);
        }
        return;
      }
      if (ev.target && ev.target.id === 'btn-tier-edit-cancel') {
        moduleState.memberTierEditing = null;
        renderMembersAdminPanel();
        return;
      }
      const tierEditBtn = ev.target.closest('[data-tier-edit]');
      if (tierEditBtn) {
        const id = Number(tierEditBtn.getAttribute('data-tier-edit'));
        const pack = moduleState.members || {};
        const tier = (Array.isArray(pack.tiers) ? pack.tiers : []).find((t) => Number(t.id) === id);
        if (tier) {
          moduleState.memberTierEditing = tier;
          renderMembersAdminPanel();
        }
        return;
      }
      const tierDeleteBtn = ev.target.closest('[data-tier-delete]');
      if (tierDeleteBtn) {
        if (!window.confirm('Delete this plan? Members who already joined keep their access; the plan just stops being offered.')) return;
        const id = Number(tierDeleteBtn.getAttribute('data-tier-delete'));
        moduleMsg('Deleting plan…', true);
        try {
          await api(`/modules/members/tiers/${id}`, { method: 'DELETE' });
          if (moduleState.memberTierEditing && Number(moduleState.memberTierEditing.id) === id) {
            moduleState.memberTierEditing = null;
          }
          moduleMsg('Plan deleted.', true);
          await loadModuleItems();
        } catch (e) {
          moduleMsg(errText(e), false);
        }
        return;
      }
      // Comps + subscription cancel.
      const compGrantBtn = ev.target.closest('[data-member-comp-grant]');
      if (compGrantBtn) {
        const id = Number(compGrantBtn.getAttribute('data-member-comp-grant'));
        const tierSel = document.querySelector(`[data-comp-tier="${id}"]`);
        const untilInput = document.querySelector(`[data-comp-until="${id}"]`);
        moduleMsg('Granting comp…', true);
        try {
          await api(`/modules/members/${id}/comp`, {
            method: 'POST',
            body: JSON.stringify({
              tier_id: tierSel ? Number(tierSel.value) : null,
              comp_until: untilInput && untilInput.value ? untilInput.value : null,
            }),
          });
          moduleMsg('Comp granted — this member now has free access to that plan.', true);
          await loadModuleItems();
        } catch (e) {
          moduleMsg(errText(e), false);
        }
        return;
      }
      const compRevokeBtn = ev.target.closest('[data-member-comp-revoke]');
      if (compRevokeBtn) {
        const id = Number(compRevokeBtn.getAttribute('data-member-comp-revoke'));
        moduleMsg('Revoking comp…', true);
        try {
          await api(`/modules/members/${id}/comp`, { method: 'DELETE' });
          moduleMsg('Comp revoked.', true);
          await loadModuleItems();
        } catch (e) {
          moduleMsg(errText(e), false);
        }
        return;
      }
      const cancelSubBtn = ev.target.closest('[data-member-cancel-sub]');
      if (cancelSubBtn) {
        if (
          !window.confirm(
            'Cancel this member’s subscription at the end of the current paid period? They keep access until the period ends, and your Stripe will not charge them again.'
          )
        )
          return;
        const id = Number(cancelSubBtn.getAttribute('data-member-cancel-sub'));
        moduleMsg('Cancelling subscription…', true);
        try {
          await api(`/modules/members/${id}/cancel-subscription`, { method: 'POST', body: '{}' });
          moduleMsg('Subscription set to cancel at the end of the paid period.', true);
          await loadModuleItems();
        } catch (e) {
          moduleMsg(errText(e), false);
        }
        return;
      }
    });
    modulesBookingRoot.addEventListener('input', (ev) => {
      if (ev.target && ev.target.id === 'members-search') {
        moduleState.memberSearch = ev.target.value || '';
        // Re-render only the list so the search box keeps focus.
        const pack = moduleState.members || {};
        const allMembers = Array.isArray(pack.members) ? pack.members : [];
        const search = moduleState.memberSearch.toLowerCase();
        const list = document.getElementById('modules-members-list');
        if (!list) return;
        const shown = search
          ? allMembers.filter(
              (m) => (m.email || '').toLowerCase().includes(search) || (m.name || '').toLowerCase().includes(search)
            )
          : allMembers;
        if (!shown.length) {
          list.innerHTML = `<p class="hint">${allMembers.length ? 'No members match your search.' : 'No members yet. Visitors join from your site’s Members page — new accounts appear here.'}</p>`;
          return;
        }
        const tiers = Array.isArray(pack.tiers) ? pack.tiers : [];
        list.innerHTML = shown.map((m) => memberRowHtml(m, tiers)).join('');
      }
    });
  }

  const btnModulesNew = document.getElementById('btn-modules-new');
  if (btnModulesNew) {
    btnModulesNew.onclick = () => openModuleEditor(null);
  }

  // Batch 78: the editor page's Back button (the modal backdrop and
  // its click-to-close are gone with the popup).
  const btnModuleItemBack = document.getElementById('btn-module-item-back');
  if (btnModuleItemBack) btnModuleItemBack.onclick = () => closeModuleModal();

  const btnModulesCancel = document.getElementById('btn-modules-cancel');
  if (btnModulesCancel) btnModulesCancel.onclick = () => closeModuleModal();

  const btnModulesSave = document.getElementById('btn-modules-save');
  if (btnModulesSave) {
    btnModulesSave.onclick = async () => {
      moduleModalMsg('Saving…', true);
      const body = collectModuleFields();
      const type = moduleState.current;
      try {
        if (type === 'chatbot') {
          const pending = moduleState.pendingKnowledgeFiles || [];
          if (pending.length) {
            moduleModalMsg(`Uploading & extracting ${pending.length} file${pending.length === 1 ? '' : 's'}…`, true);
            const up = await uploadChatbotKnowledgeFiles(pending, body.title);
            const uploaded = (up && up.items) || (up && up.item ? [up.item] : []);
            // Editing with a new file: remove the old row after successful upload.
            if (moduleState.editingId && uploaded.length) {
              try {
                await api(`/modules/chatbot/${moduleState.editingId}`, { method: 'DELETE' });
              } catch {
                /* keep new uploads even if old delete fails */
              }
            }
            // Also persist link/notes fields if they filled those without relying only on files.
            const hasLinkOrNotes = String(body.url || '').trim() || String(body.content_text || '').trim();
            if (hasLinkOrNotes && !moduleState.editingId) {
              await api('/modules/chatbot', {
                method: 'POST',
                body: JSON.stringify({
                  kind: body.kind || (body.url ? 'link' : 'doc'),
                  title: body.title || 'Notes',
                  url: body.url || '',
                  content_text: body.content_text || '',
                  status: body.status || 'active',
                }),
              });
            }
            moduleState.pendingKnowledgeFiles = [];
            closeModuleModal();
            const n = uploaded.length || pending.length;
            moduleMsg(`Uploaded ${n} knowledge file${n === 1 ? '' : 's'} (text extracted for the agent).`, true);
            await loadModules();
            return;
          }
        }
        if (moduleState.editingId) {
          await api(`/modules/${encodeURIComponent(type)}/${moduleState.editingId}`, {
            method: 'PUT',
            body: JSON.stringify(body),
          });
        } else {
          await api(`/modules/${encodeURIComponent(type)}`, {
            method: 'POST',
            body: JSON.stringify(body),
          });
        }
        closeModuleModal();
        moduleMsg('Saved.', true);
        await loadModules();
      } catch (e) {
        moduleModalMsg(errText(e), false);
      }
    };
  }

  const btnModulesDelete = document.getElementById('btn-modules-delete');
  if (btnModulesDelete) {
    btnModulesDelete.onclick = async () => {
      if (!moduleState.editingId) return;
      if (!window.confirm('Delete this item?')) return;
      moduleModalMsg('Deleting…', true);
      try {
        await api(`/modules/${encodeURIComponent(moduleState.current)}/${moduleState.editingId}`, {
          method: 'DELETE',
        });
        closeModuleModal();
        moduleMsg('Deleted.', true);
        await loadModules();
      } catch (e) {
        moduleModalMsg(errText(e), false);
      }
    };
  }

  const btnModulesAttach = document.getElementById('btn-modules-attach');
  if (btnModulesAttach) {
    btnModulesAttach.onclick = async () => {
      moduleMsg('Adding to site…', true);
      const pageSel = document.getElementById('modules-target-page');
      try {
        const attachData = await api(`/modules/${encodeURIComponent(moduleState.current)}/attach`, {
          method: 'POST',
          body: JSON.stringify({
            target_page_slug: pageSel ? pageSel.value : undefined,
            toSite: true,
          }),
        });
        moduleMsg(
          attachData &&
            (attachData.publicPreviewUpdated || attachData.via === 'cloudflare' || attachData.via === 'app_url')
            ? 'Module embedded — live site updated.'
            : 'Module embedded locally — click Publish website if the live link still looks old.',
          true
        );
        await loadModules();
        if (state.previewUrl) loadEditablePreview(state.previewUrl).catch(() => {});
      } catch (e) {
        moduleMsg(errText(e), false);
      }
    };
  }

  const btnModulesDetach = document.getElementById('btn-modules-detach');
  if (btnModulesDetach) {
    btnModulesDetach.onclick = async () => {
      moduleMsg('Removing from site…', true);
      try {
        await api(`/modules/${encodeURIComponent(moduleState.current)}/detach`, {
          method: 'POST',
          body: '{}',
        });
        moduleMsg('Removed from site.', true);
        await loadModules();
        if (state.previewUrl) loadEditablePreview(state.previewUrl).catch(() => {});
      } catch (e) {
        moduleMsg(errText(e), false);
      }
    };
  }

  // Batch 66 — delete (purge) the current module: embed + content.
  // The confirm carries the module's real content counts from the
  // summary payload; the server repeats the guard checks anyway.
  // (Distinct id from the item modal's btn-modules-delete.)
  const btnModulesPurge = document.getElementById('btn-modules-purge');
  if (btnModulesPurge) {
    btnModulesPurge.onclick = async () => {
      const meta = MODULE_TYPES.find((m) => m.type === moduleState.current);
      const label = meta ? meta.label : moduleState.current;
      const entry = ((moduleState.summary && moduleState.summary.modules) || []).find(
        (m) => m.type === moduleState.current
      );
      const parts = (entry && entry.purge && entry.purge.parts) || [];
      const what = parts.length ? parts.map((p) => `${p.count} ${p.label}`).join(', ') : 'no content rows';
      if (
        !window.confirm(
          `Delete the ${label} module from your business?\n\nThis permanently deletes the module and its content (${what}).\n\nRemove only takes it off your site and keeps content. Delete cannot be undone.`
        )
      ) {
        return;
      }
      moduleMsg('Deleting module…', true);
      try {
        await api(`/modules/${encodeURIComponent(moduleState.current)}`, { method: 'DELETE' });
        moduleMsg('Module deleted.', true);
        await loadModules();
        if (state.previewUrl) loadEditablePreview(state.previewUrl).catch(() => {});
      } catch (e) {
        moduleMsg(errText(e), false);
      }
    };
  }

  const btnModulesUpgrade = document.getElementById('btn-modules-upgrade');
  if (btnModulesUpgrade) {
    btnModulesUpgrade.onclick = () => showPortalPanel('billing');
  }

  const upsellClose = document.getElementById('upsell-tip-close');
  if (upsellClose) upsellClose.onclick = () => hideUpsellTip();
  const upsellUpgrade = document.getElementById('upsell-tip-upgrade');
  if (upsellUpgrade) {
    upsellUpgrade.onclick = () => {
      hideUpsellTip();
      showPortalPanel('billing');
    };
  }

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
      msg.textContent = errText(e);
    }
  };

  const buyCreditsBtn = document.getElementById('btn-buy-credits');
  if (buyCreditsBtn) {
    buyCreditsBtn.onclick = async () => {
      const msg = document.getElementById('msg-billing');
      msg.className = 'msg';
      msg.textContent = 'Opening credits checkout…';
      try {
        const data = await api('/billing/credits/checkout', {
          method: 'POST',
          body: JSON.stringify({ quantity: 1 }),
        });
        if (data.url) location.href = data.url;
        else throw new Error('No checkout URL returned');
      } catch (e) {
        msg.className = 'msg err';
        msg.textContent = errText(e);
      }
    };
  }

  async function startPortalChangePlan(plan) {
    const msg = document.getElementById('msg-billing');
    const target = String(plan || '');
    const isFree = target === 'free';
    if (isFree) {
      const ok = window.confirm(
        'Downgrade to Free?\n\nYour paid plan stays active until the end of the current billing period. After that you move to Free — no further charges.'
      );
      if (!ok) return;
    }
    msg.className = 'msg';
    msg.textContent = isFree ? 'Scheduling downgrade…' : target === 'premium' ? 'Upgrading…' : 'Updating plan…';
    try {
      const data = await api('/billing/change-plan', {
        method: 'POST',
        body: JSON.stringify({ plan: target }),
      });
      if (data.url) {
        location.href = data.url;
        return;
      }
      msg.className = 'msg ok';
      msg.textContent =
        data.message ||
        (data.action === 'cancel_at_period_end'
          ? 'Cancellation scheduled — you keep access until the period ends.'
          : data.action === 'updated'
            ? 'Plan updated.'
            : 'Done.');
      await loadBilling();
    } catch (e) {
      msg.className = 'msg err';
      msg.textContent = errText(e);
    }
  }

  async function startPortalResume() {
    const msg = document.getElementById('msg-billing');
    msg.className = 'msg';
    msg.textContent = 'Keeping your plan…';
    try {
      const data = await api('/billing/resume', { method: 'POST', body: '{}' });
      msg.className = 'msg ok';
      msg.textContent = data.message || 'Cancellation withdrawn — your plan will renew.';
      await loadBilling();
    } catch (e) {
      msg.className = 'msg err';
      msg.textContent = errText(e);
    }
  }

  // Batch 121: an emailed set-password link lands here. The token is
  // kept in pendingSetpwToken for the form submit and stripped from
  // the address bar immediately; the set form drives what happens
  // next (it does NOT sign anyone in by itself).
  async function trySetPasswordLink() {
    let token = '';
    try {
      token = new URLSearchParams(window.location.search).get('setpw') || '';
    } catch {
      /* ignore */
    }
    if (!token) return false;
    pendingSetpwToken = token;
    try {
      const u = new URL(window.location.href);
      u.searchParams.delete('setpw');
      window.history.replaceState({}, '', u.pathname + u.search + u.hash);
    } catch {
      /* ignore */
    }
    showSetpwForm();
    const msg = document.getElementById('msg-setpw');
    if (msg) {
      msg.className = 'msg';
      msg.textContent = 'Choose a password for your portal account.';
    }
    return true;
  }

  async function tryMagicLogin() {
    let magic = '';
    try {
      magic = new URLSearchParams(window.location.search).get('magic') || '';
    } catch {
      /* ignore */
    }
    if (!magic) return false;
    const msg = document.getElementById('msg-login');
    if (msg) {
      msg.className = 'msg';
      msg.textContent = 'Signing in with your link…';
    }
    setTab('login');
    try {
      const data = await api('/magic-login', {
        method: 'POST',
        body: JSON.stringify({ token: magic }),
      });
      // Strip token from the address bar without reloading.
      try {
        const u = new URL(window.location.href);
        u.searchParams.delete('magic');
        window.history.replaceState({}, '', u.pathname + u.search + u.hash);
      } catch {
        /* ignore */
      }
      // Batch 40: a magic link is a sign-in, not a side door — when the
      // account has TOTP on, the code step still stands.
      if (data && data.mfaRequired) {
        showMfaForm();
        return 'mfa';
      }
      return true;
    } catch (e) {
      if (msg) {
        msg.className = 'msg err';
        msg.textContent = errText(e);
      }
      return false;
    }
  }

  // Batch 105 — app-shell drawer wiring, mirroring the staff
  // app's menu behaviour: the menu button opens the sidenav
  // drawer, and the close button, the backdrop, or choosing a
  // section closes it. Null-safe for stripped DOMs.
  const portalShellEl = document.getElementById('portal-shell');
  const portalMenuBtn = document.getElementById('portal-menu-btn');
  const portalNavCloseBtn = document.getElementById('portal-nav-close');
  const portalBackdropEl = document.getElementById('portal-backdrop');
  function closePortalNav() {
    if (portalShellEl) portalShellEl.classList.remove('nav-open');
    if (portalBackdropEl) portalBackdropEl.hidden = true;
  }
  function openPortalNav() {
    if (portalShellEl) portalShellEl.classList.add('nav-open');
    if (portalBackdropEl) portalBackdropEl.hidden = false;
  }
  if (portalMenuBtn) portalMenuBtn.addEventListener('click', openPortalNav);
  if (portalNavCloseBtn) portalNavCloseBtn.addEventListener('click', closePortalNav);
  if (portalBackdropEl) portalBackdropEl.addEventListener('click', closePortalNav);
  if (portalNav) portalNav.addEventListener('click', closePortalNav);

  (async function boot() {
    wireAgentChat();
    await mountCaptchas();
    try {
      const usedSetpw = await trySetPasswordLink();
      if (usedSetpw) return;
      const usedMagic = await tryMagicLogin();
      if (usedMagic === 'mfa') return;
      if (usedMagic) {
        await loadDashboard();
        return;
      }
      await loadDashboard();
    } catch (err) {
      showPortalLogin();
      const authFail =
        err && (err.code === 'AUTH_REQUIRED' || err.code === 'SESSION_IDLE' || err.message === 'AUTH_REQUIRED');
      const msg = document.getElementById('msg-login');
      if (msg && err && err.code === 'SESSION_IDLE') {
        msg.className = 'msg err';
        msg.textContent = errText(err);
      } else if (!authFail && err && err.message && msg) {
        msg.className = 'msg err';
        msg.textContent = errText(err);
      }
    }
  })();

  // Batch 117 — WordPress design chat panel. Renders per connected
  // registration: the chat (transcript + composer), staged proposals
  // with Preview / Approve / Reject, and applied changes with Undo.
  // Approve-first is the product rule: this UI never applies
  // anything itself — approving only marks the proposal; the plugin
  // applies it on the site and reports back. All DOM is built with
  // createElement + textContent (owner-supplied site names, chat
  // text and proposal summaries are never markup here).
  const wpDesignState = { loaded: false, loading: false, sites: new Map() };
  const WP_PROPOSAL_LABELS = {
    staged: 'Waiting for your decision',
    approved: 'Approved — applies when your site next checks in',
    apply_failed: 'Your site could not apply this — approve again to retry, or reject it',
    applied: 'Applied',
    rejected: 'Rejected',
    superseded: 'Replaced by a newer proposal',
    undo_requested: 'Undo requested — completes when your site next checks in',
    undone: 'Undone',
  };
  function wpEl(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text != null) el.textContent = String(text);
    return el;
  }
  function wpDesignMsg(text, isErr) {
    const msg = document.getElementById('msg-wp-design');
    if (!msg) return;
    msg.className = isErr ? 'msg err' : 'msg ok';
    msg.textContent = text || '';
  }
  function renderWpDesignSite(host, site) {
    const card = wpEl('div');
    card.style.borderTop = '1px solid var(--line, #ddd)';
    card.style.paddingTop = '14px';
    card.style.marginTop = '14px';
    const title = wpEl('h4', null, site.siteName || site.siteUrl || 'WordPress site');
    title.style.margin = '0 0 4px';
    title.style.fontSize = '1rem';
    card.appendChild(title);
    const meta = wpEl(
      'p',
      'hint',
      site.census
        ? `${site.siteUrl || ''} · WordPress ${site.census.wpVersion || '?'} · Theme: ${(site.census.theme && site.census.theme.name) || 'unknown'} · ${site.census.pageCount} pages`
        : 'Waiting for the site to send its map — open Settings → BitPype once in WordPress admin.'
    );
    meta.style.margin = '0 0 10px';
    card.appendChild(meta);

    // Chat transcript (most recent 50, server-trimmed).
    const log = wpEl('div');
    log.style.maxHeight = '320px';
    log.style.overflowY = 'auto';
    log.style.display = 'flex';
    log.style.flexDirection = 'column';
    log.style.gap = '8px';
    log.style.margin = '0 0 10px';
    const messages = (site.chat && site.chat.messages) || [];
    if (!messages.length) {
      log.appendChild(wpEl('p', 'hint', 'No design conversation yet. Ask for a change — for example, “make my primary color deep green” or “add a hero section for spring bookings”.'));
    }
    for (const m of messages) {
      const row = wpEl('div');
      row.style.alignSelf = m.role === 'user' ? 'flex-end' : 'flex-start';
      row.style.maxWidth = '88%';
      row.style.padding = '8px 12px';
      row.style.borderRadius = '12px';
      row.style.whiteSpace = 'pre-wrap';
      row.style.background = m.role === 'user' ? 'var(--accent-soft, #eef4ff)' : 'var(--panel-2, #f6f3ec)';
      row.textContent = String(m.text || '');
      log.appendChild(row);
    }
    card.appendChild(log);
    log.scrollTop = log.scrollHeight;

    // Composer.
    const form = wpEl('form');
    form.style.display = 'flex';
    form.style.gap = '8px';
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Ask about the site, or describe a design change…';
    input.style.flex = '1';
    input.maxLength = 4000;
    const send = wpEl('button', 'btn', 'Send');
    send.type = 'submit';
    form.appendChild(input);
    form.appendChild(send);
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      send.disabled = true;
      sendWpDesignChat(site.id, text)
        .catch(() => {})
        .finally(() => {
          send.disabled = false;
        });
    });
    card.appendChild(form);
    if (site.usage && site.usage.limit != null) {
      const u = wpEl('p', 'hint', `${site.usage.used || 0} of ${site.usage.limit} design chat requests used today for this site.`);
      u.style.margin = '6px 0 0';
      card.appendChild(u);
    }

    // Proposals + history.
    const proposals = site.proposals || [];
    if (proposals.length) {
      const h = wpEl('h4', null, 'Design proposals');
      h.style.margin = '16px 0 8px';
      h.style.fontSize = '1rem';
      card.appendChild(h);
      for (const p of proposals) {
        const item = wpEl('div');
        item.style.padding = '10px 0';
        item.style.borderTop = '1px dashed var(--line, #ddd)';
        const head = wpEl('p', null, `${p.summary || 'Design change'} — ${WP_PROPOSAL_LABELS[p.status] || p.status}`);
        head.style.margin = '0 0 4px';
        item.appendChild(head);
        if (Array.isArray(p.changes) && p.changes.length) {
          const ul = wpEl('ul');
          ul.style.margin = '0 0 6px';
          ul.style.paddingLeft = '1.25rem';
          for (const c of p.changes) ul.appendChild(wpEl('li', null, c));
          item.appendChild(ul);
        }
        if (p.verify && p.verify.checked) {
          item.appendChild(
            wpEl('p', 'hint', p.verify.ok ? 'Checked in a staged preview before you were asked.' : `Preview check: ${(p.verify.notes || []).join(' ')}`)
          );
        }
        if (p.error) item.appendChild(wpEl('p', 'hint', `Problem: ${p.error}`));
        const actions = wpEl('div');
        actions.style.display = 'flex';
        actions.style.gap = '8px';
        actions.style.flexWrap = 'wrap';
        if (p.status === 'staged' || p.status === 'apply_failed') {
          const previewBtn = wpEl('button', 'btn soft small', 'Preview');
          previewBtn.type = 'button';
          previewBtn.addEventListener('click', () => openWpDesignPreview(site.id, p.id).catch(() => {}));
          actions.appendChild(previewBtn);
          const approveBtn = wpEl('button', 'btn small', 'Approve');
          approveBtn.type = 'button';
          approveBtn.addEventListener('click', () => decideWpDesignProposal(site.id, p.id, 'approve').catch(() => {}));
          actions.appendChild(approveBtn);
          const rejectBtn = wpEl('button', 'btn soft small', 'Reject');
          rejectBtn.type = 'button';
          rejectBtn.addEventListener('click', () => decideWpDesignProposal(site.id, p.id, 'reject').catch(() => {}));
          actions.appendChild(rejectBtn);
        }
        if (p.status === 'approved') {
          const rejectBtn = wpEl('button', 'btn soft small', 'Reject');
          rejectBtn.type = 'button';
          rejectBtn.addEventListener('click', () => decideWpDesignProposal(site.id, p.id, 'reject').catch(() => {}));
          actions.appendChild(rejectBtn);
        }
        if (p.status === 'applied') {
          const undoBtn = wpEl('button', 'btn soft small', 'Undo this change');
          undoBtn.type = 'button';
          undoBtn.addEventListener('click', () => decideWpDesignProposal(site.id, p.id, 'undo').catch(() => {}));
          actions.appendChild(undoBtn);
        }
        if (actions.childNodes.length) item.appendChild(actions);
        card.appendChild(item);
      }
    }
    host.appendChild(card);
  }
  function renderWpDesignPanel(downloads, sitesById) {
    const host = document.getElementById('wp-design-host');
    if (!host) return;
    host.replaceChildren();
    const connected = (downloads || []).filter((d) => d.status === 'connected');
    if (!connected.length) {
      host.appendChild(wpEl('p', 'hint', 'Connect a WordPress site first — design chat appears here once a site is connected with the current plugin.'));
      return;
    }
    for (const d of connected) {
      const site = sitesById.get(Number(d.id));
      if (d.designCapable && site) {
        renderWpDesignSite(host, site);
      } else {
        const card = wpEl('div');
        card.style.borderTop = '1px solid var(--line, #ddd)';
        card.style.paddingTop = '14px';
        card.style.marginTop = '14px';
        const title = wpEl('h4', null, d.siteName || d.siteUrl || 'WordPress site');
        title.style.margin = '0 0 4px';
        title.style.fontSize = '1rem';
        card.appendChild(title);
        card.appendChild(
          wpEl(
            'p',
            'hint',
            'Update available: this site is running the earlier plugin, which supports forms only. Design editing needs the new version — download a fresh copy above (it carries a new connect code) and install it in WordPress. Your forms keep working either way.'
          )
        );
        host.appendChild(card);
      }
    }
  }
  async function loadWpDesignPanel() {
    if (wpDesignState.loading) return;
    wpDesignState.loading = true;
    try {
      const data = await api('/wordpress');
      const downloads = data.downloads || [];
      const sitesById = new Map();
      for (const d of downloads) {
        if (d.status === 'connected' && d.designCapable) {
          try {
            const state = await api(`/wordpress/${encodeURIComponent(d.id)}/design`);
            sitesById.set(Number(d.id), state);
          } catch {
            /* one site's failure must not hide the others */
          }
        }
      }
      renderWpDesignPanel(downloads, sitesById);
      wpDesignState.loaded = true;
    } catch {
      const host = document.getElementById('wp-design-host');
      if (host) {
        host.replaceChildren();
        host.appendChild(wpEl('p', 'hint', 'Could not load design chat just now — reopen this tab to try again.'));
      }
    } finally {
      wpDesignState.loading = false;
    }
  }
  async function sendWpDesignChat(linkId, text) {
    wpDesignMsg('');
    try {
      const data = await api(`/wordpress/${encodeURIComponent(linkId)}/design/chat`, {
        method: 'POST',
        body: JSON.stringify({ message: text }),
      });
      if (data && data.error) wpDesignMsg(data.reply || 'The AI could not answer just now.', true);
      await loadWpDesignPanel();
    } catch (e) {
      wpDesignMsg(errText(e), true);
      await loadWpDesignPanel().catch(() => {});
    }
  }
  async function decideWpDesignProposal(linkId, proposalId, decision) {
    wpDesignMsg('');
    try {
      await api(`/wordpress/${encodeURIComponent(linkId)}/design/proposals/${encodeURIComponent(proposalId)}/${decision}`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      wpDesignMsg(
        decision === 'approve'
          ? 'Approved. It will be applied the next time your WordPress site checks in — opening Settings → BitPype in WordPress hurries it along.'
          : decision === 'undo'
            ? 'Undo requested. It completes the next time your WordPress site checks in.'
            : 'Proposal rejected and discarded.'
      );
      await loadWpDesignPanel();
    } catch (e) {
      wpDesignMsg(errText(e), true);
    }
  }
  async function openWpDesignPreview(linkId, proposalId) {
    try {
      const data = await api(`/wordpress/${encodeURIComponent(linkId)}/design/proposals/${encodeURIComponent(proposalId)}/preview`);
      if (data && data.url) window.open(data.url, '_blank', 'noopener');
      else wpDesignMsg('No preview address is available for that proposal.', true);
    } catch (e) {
      wpDesignMsg(errText(e), true);
    }
  }
  // Load when the WordPress panel becomes visible (any entry path:
  // nav click, hash routing, deep link).
  const wpDesignObserver = new MutationObserver(() => {
    const sec = document.getElementById('sec-wordpress');
    if (sec && !sec.hidden) loadWpDesignPanel().catch(() => {});
  });
  const wpSecEl = document.getElementById('sec-wordpress');
  if (wpSecEl) wpDesignObserver.observe(wpSecEl, { attributes: true, attributeFilter: ['hidden'] });
  const wpNavEl = document.getElementById('nav-wordpress');
  if (wpNavEl) wpNavEl.addEventListener('click', () => loadWpDesignPanel().catch(() => {}));
})();
