'use strict';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function invoke(channel, arg) {
  if (!window.api || typeof window.api.invoke !== 'function') {
    throw new Error('window.api.invoke is not available');
  }
  return window.api.invoke(channel, arg);
}

function setMsg(el, text, cls) {
  if (!el) return;
  el.className = 'msg' + (cls ? ' ' + cls : '');
  el.textContent = text || '';
}

function priceLabel(d) {
  if (d.registrationCost == null) return '';
  return `${d.registrationCost}${d.currency ? ' ' + d.currency : ''}/yr`;
}

async function init(root) {
  const $ = (id) => root.querySelector(id) || document.getElementById(id.replace(/^#/, ''));
  const searchMsg = $('#dom-search-msg');
  const resultsEl = $('#dom-search-results');
  const linkedBody = $('#dom-linked-body');
  const siteSel = $('#dom-link-site');
  const cfHint = $('#dom-cf-hint');

  try {
    const cfg = await invoke('cloudflare:getConfig');
    if (cfHint) cfHint.hidden = !!(cfg && cfg.configured);
  } catch {
    if (cfHint) cfHint.hidden = false;
  }

  try {
    const sites = await invoke('sites:list', {});
    const rows = (sites && (sites.sites || sites.websites || sites.rows)) || (Array.isArray(sites) ? sites : []);
    if (siteSel) {
      siteSel.innerHTML = '<option value="">Select…</option>' + rows.map((s) =>
        `<option value="${esc(s.id)}">#${esc(s.id)} · ${esc(s.name || 'Site')}</option>`
      ).join('');
    }
  } catch { /* sites list optional */ }

  try {
    const leadSel = $('#dom-lead');
    const lr = await invoke('leads:list', { pageSize: 200 });
    const leads = (lr && (lr.leads || lr.rows)) || [];
    if (leadSel) {
      leadSel.innerHTML = '<option value="">None</option>' + leads.map((l) => {
        const name = l.business_name || l.name || ('Lead #' + l.id);
        const city = l.city ? ` · ${l.city}` : '';
        return `<option value="${esc(l.id)}">${esc(name)}${esc(city)}</option>`;
      }).join('');
    }
  } catch { /* leads list optional */ }

  async function refreshLinked() {
    try {
      const r = await invoke('domains:list', {});
      const linked = (r && r.domains) || [];
      linkedBody.innerHTML = linked.map((d) => `
        <tr>
          <td><a href="${esc(d.publicUrl || ('https://' + d.domain))}" target="_blank" rel="noopener">${esc(d.domain)}</a>
            <div class="hint">${esc(d.pagesProject || '')}</div></td>
          <td>${esc(d.status)}${d.registrationState ? `<div class="hint">${esc(d.registrationState)}</div>` : ''}</td>
          <td>${d.websiteId != null ? `#${esc(d.websiteId)}` : '—'}</td>
          <td class="mono">${d.price != null ? esc(String(d.price)) : '—'}</td>
          <td class="actions">
            ${d.status === 'registering' ? `<button class="btn small" data-act="poll" data-domain="${esc(d.domain)}">Refresh</button>` : ''}
            ${d.status === 'linked' ? `<button class="btn small danger" data-act="unlink" data-domain="${esc(d.domain)}">Unlink</button>` : ''}
          </td>
        </tr>`).join('') || '<tr><td colspan="5" class="empty">No domains yet.</td></tr>';
    } catch (e) {
      linkedBody.innerHTML = `<tr><td colspan="5" class="error">${esc(e.message || 'Could not load domains')}</td></tr>`;
    }
  }

  function renderSearch(domains) {
    if (!domains.length) {
      resultsEl.innerHTML = '<p class="hint">No suggestions.</p>';
      return;
    }
    resultsEl.innerHTML = `<div class="table-wrap"><table>
      <thead><tr><th>Domain</th><th>Available</th><th>Price</th><th></th></tr></thead>
      <tbody>${domains.map((d) => `<tr>
        <td class="mono">${esc(d.domain)}</td>
        <td>${d.registrable ? 'Yes' : 'No'}</td>
        <td>${esc(priceLabel(d) || '—')}</td>
        <td class="actions">
          <button type="button" class="btn small" data-act="check" data-domain="${esc(d.domain)}">Check</button>
          <button type="button" class="btn small primary" data-act="buy" data-domain="${esc(d.domain)}" ${d.registrable ? '' : 'disabled'}>Buy</button>
          <button type="button" class="btn small" data-act="use" data-domain="${esc(d.domain)}">Use to link</button>
        </td>
      </tr>`).join('')}</tbody></table></div>`;
  }

  $('#dom-search-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = $('#dom-q').value;
    const leadId = $('#dom-lead').value ? Number($('#dom-lead').value) : undefined;
    setMsg(searchMsg, 'Searching…', '');
    try {
      const r = await invoke('domains:search', { q, leadId });
      setMsg(searchMsg, `${(r.domains || []).length} suggestion(s)`, 'ok');
      renderSearch(r.domains || []);
    } catch (err) {
      setMsg(searchMsg, err.message || 'Search failed', 'err');
    }
  });

  $('#dom-link-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('#dom-link-msg');
    const domain = $('#dom-link-name').value;
    const websiteId = Number($('#dom-link-site').value);
    setMsg(msg, 'Linking…', '');
    try {
      const r = await invoke('domains:link', { domain, websiteId, forcePublish: true });
      setMsg(msg, `Linked — ${r.publicUrl || domain}`, 'ok');
      await refreshLinked();
    } catch (err) {
      setMsg(msg, err.message || 'Link failed', 'err');
    }
  });

  $('#dom-refresh-owned').addEventListener('click', async () => {
    const msg = $('#dom-link-msg');
    const host = $('#dom-owned');
    setMsg(msg, 'Loading…', '');
    try {
      const r = await invoke('domains:owned');
      const domains = r.domains || [];
      setMsg(msg, `${domains.length} on Cloudflare`, 'ok');
      host.innerHTML = domains.length
        ? `<table><thead><tr><th>Domain</th><th></th></tr></thead><tbody>${
          domains.map((d) => `<tr><td class="mono">${esc(d.domain)}</td>
            <td><button type="button" class="btn small" data-act="use" data-domain="${esc(d.domain)}">Use to link</button></td></tr>`).join('')
        }</tbody></table>`
        : '<p class="hint">No owned domains.</p>';
    } catch (err) {
      setMsg(msg, err.message || 'Failed', 'err');
    }
  });

  root.addEventListener('click', async (ev) => {
    const t = ev.target && ev.target.closest ? ev.target.closest('[data-act]') : null;
    if (!t || !root.contains(t)) return;
    const act = t.getAttribute('data-act');
    const domain = t.getAttribute('data-domain');
    if (act === 'use') {
      $('#dom-link-name').value = domain || '';
      return;
    }
    if (act === 'check') {
      setMsg(searchMsg, 'Checking…', '');
      try {
        const r = await invoke('domains:check', { domain });
        const d = (r.domains || [])[0];
        setMsg(searchMsg, d
          ? (d.registrable ? `${d.domain} registrable · ${priceLabel(d)}` : `${d.domain} not registrable`)
          : 'No result', d && d.registrable ? 'ok' : 'err');
      } catch (err) { setMsg(searchMsg, err.message, 'err'); }
      return;
    }
    if (act === 'buy') {
      if (!window.confirm(`Purchase ${domain} for 1 year on Cloudflare Registrar?\n\nBills your Cloudflare payment method; non-refundable.`)) return;
      setMsg(searchMsg, 'Registering…', '');
      try {
        const leadRaw = $('#dom-lead') && $('#dom-lead').value;
        const leadId = leadRaw ? Number(leadRaw) : undefined;
        const websiteId = $('#dom-link-site').value ? Number($('#dom-link-site').value) : undefined;
        await invoke('domains:register', { domain, years: 1, leadId, websiteId });
        setMsg(searchMsg, `Registration started for ${domain}`, 'ok');
        await refreshLinked();
      } catch (err) { setMsg(searchMsg, err.message, 'err'); }
      return;
    }
    if (act === 'poll') {
      try { await invoke('domains:status', { domain }); await refreshLinked(); }
      catch (err) { setMsg(searchMsg, err.message, 'err'); }
      return;
    }
    if (act === 'unlink') {
      if (!window.confirm(`Unlink ${domain}?`)) return;
      try { await invoke('domains:unlink', { domain }); await refreshLinked(); }
      catch (err) { setMsg($('#dom-link-msg'), err.message, 'err'); }
    }
  });

  await refreshLinked();
}

window.pageInit = init;
