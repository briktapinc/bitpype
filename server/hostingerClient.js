'use strict';

/**
 * Batch 59 — thin client for the Hostinger API (one-click VPS deploys).
 *
 * Verified against the OFFICIAL Hostinger API reference
 * (developers.hostinger.com + the OpenAPI spec it renders from,
 * v2.6.1, checked 2026-10-29):
 *   - Base URL https://developers.hostinger.com; every request carries
 *     `Authorization: Bearer <token>`; tokens are created in
 *     hPanel → Profile → API and inherit the owner's permissions.
 *   - Purchase: POST /api/vps/v1/virtual-machines { item_id,
 *     payment_method_id?, setup: { data_center_id, template_id,
 *     post_install_script_id?, password?, hostname?, public_key? } }
 *     → 200 { order, virtual_machine } once payment completes, or
 *     202 { id, subscription_id, status: 'payment_initiated' } while
 *     payment is still processing (poll; do NOT resend).
 *   - Setup of a purchased-but-unconfigured VM:
 *     POST /api/vps/v1/virtual-machines/{id}/setup (same setup body).
 *   - VM reads: GET /api/vps/v1/virtual-machines[/{id}] →
 *     { id, subscription_id, plan, hostname, state, ipv4[], ... }.
 *   - Catalog: GET /api/billing/v1/catalog?category=VPS → items with
 *     prices[] { id, name, currency, price (cents),
 *     first_period_price (cents), period, period_unit }.
 *   - Post-install scripts: POST /api/vps/v1/post-install-scripts
 *     { name, content } — saved to /post_install on the VM, executed
 *     once after install, output to /post_install.log, max 48 KB.
 *   - Payment methods: GET /api/billing/v1/payment-methods (the
 *     account default is used automatically when a purchase omits
 *     payment_method_id).
 *   - Rate limit: 90 requests/minute per token.
 *
 * Errors are thrown as coded Errors (HOSTINGER_AUTH,
 * HOSTINGER_VALIDATION, HOSTINGER_RATE_LIMIT, HOSTINGER_UNREACHABLE,
 * HOSTINGER_API) with the API's own message + correlation_id folded
 * into .detail — never the token, never a raw stack.
 */

const platform = require('./platform');

const DEFAULT_BASE = 'https://developers.hostinger.com';
const REQUEST_TIMEOUT_MS = 30000;

let fetchOverride = null;
/** Tests only: swap the fetch implementation (module-level, no HTTP). */
function __setFetchForTests(fn) {
  fetchOverride = fn || null;
}
function fetchImpl() {
  return fetchOverride || globalThis.fetch;
}

function baseUrl() {
  const raw = String(process.env.HOSTINGER_API_BASE || DEFAULT_BASE).trim();
  return raw.replace(/\/+$/, '') || DEFAULT_BASE;
}

function coded(code, message, detail) {
  const e = new Error(message);
  e.code = code;
  if (detail) e.detail = String(detail).slice(0, 900);
  return e;
}

async function getToken() {
  const token = String((await platform.getPlatformSetting('hostinger.api_token', '')) || '').trim();
  if (!token) {
    throw coded(
      'HOSTINGER_NOT_CONFIGURED',
      'Hostinger is not connected yet — add an API token in Admin → Settings → Hostinger.'
    );
  }
  return token;
}

async function request(method, apiPath, body, { token } = {}) {
  const tok = token || (await getToken());
  let res;
  try {
    res = await fetchImpl()(`${baseUrl()}${apiPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${tok}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body == null ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    throw coded(
      'HOSTINGER_UNREACHABLE',
      'Could not reach the Hostinger API.',
      e && e.message ? e.message : String(e)
    );
  }
  let data = null;
  const text = await res.text().catch(() => '');
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (res.status === 401 || res.status === 403) {
    throw coded(
      'HOSTINGER_AUTH',
      'The Hostinger API rejected the API token (unauthorized). Create a fresh token in hPanel → API and save it in Admin → Settings → Hostinger.',
      data && (data.error || data.message)
    );
  }
  if (res.status === 429) {
    throw coded('HOSTINGER_RATE_LIMIT', 'Hostinger API rate limit hit — try again in a minute.', data && (data.error || data.message));
  }
  if (res.status === 422) {
    const msg = (data && (data.error || data.message)) || 'the request was rejected as invalid';
    const corr = data && data.correlation_id ? ` (correlation ${data.correlation_id})` : '';
    throw coded('HOSTINGER_VALIDATION', `Hostinger rejected the request: ${msg}${corr}`, msg);
  }
  if (!res.ok) {
    const msg = (data && (data.error || data.message)) || `HTTP ${res.status}`;
    const corr = data && data.correlation_id ? ` (correlation ${data.correlation_id})` : '';
    throw coded('HOSTINGER_API', `Hostinger API error: ${msg}${corr}`, msg);
  }
  return { status: res.status, data };
}

/** GET /api/billing/v1/catalog — full item list (filter client-side). */
async function getCatalog({ token } = {}) {
  const { data } = await request('GET', '/api/billing/v1/catalog', null, { token });
  return Array.isArray(data) ? data : data && Array.isArray(data.data) ? data.data : [];
}

/** Find one catalog price (by its price-item id) across all items. */
function findCatalogPrice(items, priceId) {
  for (const item of items || []) {
    for (const p of (item && item.prices) || []) {
      if (p && String(p.id) === String(priceId)) {
        return {
          itemId: String(item.id || ''),
          itemName: String(item.name || ''),
          priceId: String(p.id),
          priceName: String(p.name || ''),
          currency: String(p.currency || ''),
          priceCents: Number.isFinite(Number(p.price)) ? Number(p.price) : null,
          firstPeriodPriceCents: Number.isFinite(Number(p.first_period_price))
            ? Number(p.first_period_price)
            : null,
          period: p.period != null ? Number(p.period) : null,
          periodUnit: String(p.period_unit || ''),
        };
      }
    }
  }
  return null;
}

async function listPaymentMethods({ token } = {}) {
  const { data } = await request('GET', '/api/billing/v1/payment-methods', null, { token });
  return Array.isArray(data) ? data : data && Array.isArray(data.data) ? data.data : [];
}

async function listVirtualMachines({ token } = {}) {
  const { data } = await request('GET', '/api/vps/v1/virtual-machines', null, { token });
  return Array.isArray(data) ? data : data && Array.isArray(data.data) ? data.data : [];
}

async function getVirtualMachine(vmId, { token } = {}) {
  const { data } = await request(
    'GET',
    `/api/vps/v1/virtual-machines/${encodeURIComponent(String(vmId))}`,
    null,
    { token }
  );
  return data && data.data && !Array.isArray(data.data) ? data.data : data;
}

/**
 * POST /api/vps/v1/virtual-machines — PURCHASE (spends real money on
 * the connected account; the account's default payment method is
 * charged when payment_method_id is omitted). Returns
 * { status, order, virtualMachine, paymentProcessing }.
 */
async function purchaseVirtualMachine(body, { token } = {}) {
  const { status, data } = await request('POST', '/api/vps/v1/virtual-machines', body, { token });
  if (status === 202) {
    return { status, paymentProcessing: true, order: null, virtualMachine: null, raw: data };
  }
  const payload = data && data.data && typeof data.data === 'object' ? data.data : data;
  return {
    status,
    paymentProcessing: false,
    order: (payload && payload.order) || null,
    virtualMachine: (payload && payload.virtual_machine) || null,
    raw: data,
  };
}

/** POST /api/vps/v1/virtual-machines/{id}/setup — configure an `initial` VM. */
async function setupVirtualMachine(vmId, setup, { token } = {}) {
  const { data } = await request(
    'POST',
    `/api/vps/v1/virtual-machines/${encodeURIComponent(String(vmId))}/setup`,
    setup,
    { token }
  );
  return data && data.data && typeof data.data === 'object' ? data.data : data;
}

/** POST /api/vps/v1/post-install-scripts → the created script (with id). */
async function createPostInstallScript({ name, content }, { token } = {}) {
  const { data } = await request('POST', '/api/vps/v1/post-install-scripts', { name, content }, { token });
  const payload = data && data.data && typeof data.data === 'object' ? data.data : data;
  if (!payload || payload.id == null) {
    throw coded('HOSTINGER_API', 'Hostinger did not return a post-install script id.', JSON.stringify(payload || {}).slice(0, 300));
  }
  return payload;
}

async function listDataCenters({ token } = {}) {
  const { data } = await request('GET', '/api/vps/v1/data-centers', null, { token });
  return Array.isArray(data) ? data : data && Array.isArray(data.data) ? data.data : [];
}

async function listTemplates({ token } = {}) {
  const { data } = await request('GET', '/api/vps/v1/templates', null, { token });
  return Array.isArray(data) ? data : data && Array.isArray(data.data) ? data.data : [];
}

/** First IPv4 address string out of a VirtualMachineResource, or ''. */
function firstIpv4(vm) {
  const raw = vm ? vm.ipv4 : null;
  if (!raw) return '';
  if (typeof raw === 'string') return raw;
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(raw.addresses)
      ? raw.addresses
      : raw.address
        ? [raw]
        : [];
  for (const entry of list) {
    if (!entry) continue;
    if (typeof entry === 'string') return entry;
    const addr = entry.address || entry.ip_address || entry.ip || '';
    if (addr) return String(addr);
  }
  return '';
}

module.exports = {
  baseUrl,
  getToken,
  getCatalog,
  findCatalogPrice,
  listPaymentMethods,
  listVirtualMachines,
  getVirtualMachine,
  purchaseVirtualMachine,
  setupVirtualMachine,
  createPostInstallScript,
  listDataCenters,
  listTemplates,
  firstIpv4,
  __setFetchForTests,
};
