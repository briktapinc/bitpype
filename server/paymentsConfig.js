'use strict';

/**
 * Batch 129 (Ely: "Can we streamline all?") — the ONE per-lead
 * payments configuration, and the resolution every selling surface
 * shares.
 *
 * Before 129 a business kept TWO Stripe key stores: shop keys
 * (shop_stripe_keys, Batch 19) and membership keys
 * (membership_stripe_keys, Batch 17) — usually the same account
 * pasted twice, free to drift apart. Now there is ONE config,
 * lead_payment_configs, written by the ONE write path
 * (saveCredentials) behind BOTH portal surfaces (Shop → Payments
 * and Members → Payments), and read by every checkout the platform
 * runs: shop products, cart/checkout, gallery photos, pay-at-
 * booking, and membership joins all resolve through here (via the
 * shopStripe / membershipStripe purpose adapters).
 *
 * BACKWARD COMPATIBILITY (hard requirement): the legacy stores are
 * never written after 129, but they keep READING as fallback layers
 * until the owner saves (or disconnects) through the unified path:
 *   shop purpose:       unified → shop legacy → workspace keys
 *   membership purpose: unified → membership legacy
 * (memberships never fell back to the workspace account — the
 * member's money goes to the site owner's own account only — and
 * that semantic is preserved.) The first unified save migrates the
 * purpose's effective values into the unified row (fields left
 * blank keep the stored ones), so no working setup changes behavior
 * until its owner touches it — and the resolved source is recorded
 * on every order / subscription ('unified' | 'lead' | 'membership'
 * | 'workspace') so support can always tell which layer ran a
 * charge.
 *
 * SUBSCRIPTION SAFETY: Stripe subscriptions keep billing on the
 * account that created them — nothing here moves a Stripe object.
 * Webhook verification tries EVERY secret the business has on file
 * (unified, then both legacy stores, then the workspace), so events
 * for subscriptions created under a retired store still verify, and
 * operations on an existing subscription (cancel) try the
 * subscription's origin layer first. Disconnect is a single action
 * for the single config: it clears the unified row AND both legacy
 * rows, so "disconnect" can never quietly leave a second store
 * live.
 *
 * Mode discipline (Batch 128) applies to the unified config as a
 * whole: a save whose effective publishable + secret pair mixes
 * test and live is refused, on either surface.
 */

const crypto = require('crypto');
const Stripe = require('stripe');

// siteModules is required LAZILY (the codebase's cycle pattern):
// siteModules' key functions delegate here, and this module reads
// its raw-row getters — a top-level require would close the loop.
let _sm = null;
function sm() {
  if (!_sm) _sm = require('./siteModules');
  return _sm;
}

// secretBox is lazy for the same reason: several VM regression
// loaders only stub it for loads that exercise key material, and a
// status read over an empty config must never need it.
let _box = null;
function box() {
  if (!_box) _box = require('../src/secretBox');
  return _box;
}

const clientCache = new Map(); // `${leadId}:${source}:${fingerprint}` -> Stripe client

function fail(code, message, status) {
  const e = new Error(message);
  e.code = code;
  e.status = status || 400;
  return e;
}

function notConfigured(message) {
  const e = new Error(message || 'Payments are not configured for this site yet.');
  e.code = 'PAYMENTS_NOT_CONFIGURED';
  e.status = 409;
  return e;
}

/** The mode a secret (or publishable) key belongs to, from its prefix alone. */
function modeForKey(key) {
  const k = String(key || '');
  if (/^(pk|sk|rk)_test_/.test(k)) return 'test';
  if (/^(pk|sk|rk)_live_/.test(k)) return 'live';
  return null;
}

function modeForSecret(secretKey) {
  return modeForKey(secretKey);
}

function decryptField(v) {
  if (!v) return '';
  try {
    return String(box().decryptValue(v) || '').trim();
  } catch {
    return '';
  }
}

/** Decrypted credentials from a raw key row (any of the three stores). */
function credsFromRow(row) {
  if (!row) return { publishableKey: '', secretKey: '', webhookSecret: '', last4: '', updated_at: null };
  return {
    publishableKey: String(row.publishable_key || '').trim(),
    secretKey: decryptField(row.secret_key_enc),
    webhookSecret: decryptField(row.webhook_secret_enc),
    last4: String(row.secret_key_last4 || ''),
    updated_at: row.updated_at || null,
  };
}

function getUnifiedCredentials(db, leadId) {
  sm().ensureTables(db);
  return credsFromRow(sm().getPaymentConfigRow(db, Number(leadId)));
}

function getShopLegacyCredentials(db, leadId) {
  sm().ensureTables(db);
  return credsFromRow(sm().getShopStripeKeyRow(db, Number(leadId)));
}

function getMembershipLegacyCredentials(db, leadId) {
  sm().ensureTables(db);
  return credsFromRow(sm().getMembershipStripeKeyRow(db, Number(leadId)));
}

/** Workspace-layer credentials (the operator's fallback for the shop). */
function getWorkspaceCredentials(db) {
  const get = (key) => {
    try {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
      return row && typeof row.value === 'string' ? box().decryptSetting(key, row.value) : null;
    } catch {
      return null;
    }
  };
  return {
    publishableKey: String(get('shop.stripe.publishable_key') || '').trim(),
    secretKey: String(get('shop.stripe.secret_key') || '').trim(),
    webhookSecret: String(get('shop.stripe.webhook_secret') || '').trim(),
    last4: '',
    updated_at: null,
  };
}

const SOURCE_LABELS = {
  shop: { unified: 'unified', legacy: 'lead' },
  membership: { unified: 'unified', legacy: 'membership' },
};

/**
 * The ordered credential layers for a purpose, highest precedence
 * first. Each entry: { source, publishableKey, secretKey,
 * webhookSecret, last4, updated_at } — sources are already mapped
 * to the vocabulary orders/subscriptions record ('unified', 'lead'
 * for shop legacy, 'membership' for membership legacy, 'workspace').
 * The workspace layer appears only for the shop purpose, exactly as
 * before 129.
 */
function layersFor(db, leadId, purpose) {
  const id = Number(leadId);
  const p = purpose === 'membership' ? 'membership' : 'shop';
  const labels = SOURCE_LABELS[p];
  const layers = [
    { source: labels.unified, ...getUnifiedCredentials(db, id) },
    {
      source: labels.legacy,
      ...(p === 'shop' ? getShopLegacyCredentials(db, id) : getMembershipLegacyCredentials(db, id)),
    },
  ];
  if (p === 'shop') layers.push({ source: 'workspace', ...getWorkspaceCredentials(db) });
  return layers;
}

/** The layer that would run a charge for this purpose right now (first with a secret key), or null. */
function resolve(db, leadId, purpose) {
  return layersFor(db, leadId, purpose).find((l) => l.secretKey) || null;
}

/** The first LEAD layer (never the workspace) holding any stored value — the merge/status base. */
function leadLayerFor(db, leadId, purpose) {
  const layers = layersFor(db, leadId, purpose).filter((l) => l.source !== 'workspace');
  return layers.find((l) => l.secretKey || l.publishableKey || l.webhookSecret) || null;
}

/** True when a charge could run for this purpose (any layer has a secret key). */
function isConfigured(db, leadId, purpose) {
  return !!resolve(db, leadId, purpose);
}

/** The mode a charge for this purpose would run in ('test' | 'live' | null). */
function effectiveMode(db, leadId, purpose) {
  const layer = resolve(db, leadId, purpose);
  return layer ? modeForSecret(layer.secretKey) : null;
}

/**
 * Owner-safe unified status: which layer currently provides the
 * lead's own config, its mode, and whether the unified row is the
 * provider. Never carries secret or webhook values.
 */
function statusFor(db, leadId, purpose = 'shop') {
  const layer = leadLayerFor(db, leadId, purpose);
  if (!layer) {
    return {
      connected: false,
      source: null,
      unified: false,
      mode: null,
      publishable_key: '',
      secret_key_last4: '',
      webhook_configured: false,
      updated_at: null,
    };
  }
  return {
    connected: !!layer.secretKey,
    source: layer.source,
    unified: layer.source === 'unified',
    mode: layer.secretKey ? modeForSecret(layer.secretKey) : null,
    publishable_key: layer.publishableKey || '',
    secret_key_last4: layer.last4 || (layer.secretKey ? layer.secretKey.slice(-4) : ''),
    webhook_configured: !!layer.webhookSecret,
    updated_at: layer.updated_at || null,
  };
}

/**
 * THE one write path behind both portal key surfaces. Blank fields
 * keep the stored value — where "stored" is the purpose's effective
 * lead config (the unified row, else that purpose's legacy row), so
 * the first save after 129 migrates the working config into the
 * unified row instead of orphaning it. Validation + the test/live
 * mode-mix refusal (Batch 128, now config-wide) run BEFORE any
 * write: a refused save stores nothing, on either surface.
 */
function saveCredentials(db, leadId, data = {}, purpose = 'shop') {
  sm().ensureTables(db);
  const id = Number(leadId);
  const current = leadLayerFor(db, id, purpose) || {
    publishableKey: '',
    secretKey: '',
    webhookSecret: '',
  };
  const keep = (next, prev) => {
    const v = next == null ? '' : String(next).trim();
    return v === '' ? prev || '' : v;
  };
  let secretPlain = '';
  if (data.secret_key != null && String(data.secret_key).trim() !== '') {
    secretPlain = String(data.secret_key).trim();
    if (!/^(sk|rk)_(test|live)_/.test(secretPlain)) {
      throw fail('VALIDATION', 'Secret key must be a Stripe secret or restricted key (sk_… or rk_…).', 400);
    }
  }
  const publishable = keep(data.publishable_key, current.publishableKey);
  if (publishable && !/^pk_(test|live)_/.test(publishable)) {
    throw fail('VALIDATION', 'Publishable key must start with pk_test_ or pk_live_.', 400);
  }
  let webhookPlain = '';
  if (data.webhook_secret != null && String(data.webhook_secret).trim() !== '') {
    webhookPlain = String(data.webhook_secret).trim();
    if (!/^whsec_/.test(webhookPlain)) {
      throw fail('VALIDATION', 'Webhook signing secret must start with whsec_.', 400);
    }
  }
  const secret = secretPlain || current.secretKey || '';
  const webhook = webhookPlain || current.webhookSecret || '';
  // Mode discipline on the EFFECTIVE pair after this save — the
  // unified config can never hold a test publishable key beside a
  // live secret (or the reverse), whichever surface saved it.
  const pkMode = modeForKey(publishable);
  const skMode = modeForKey(secret);
  if (pkMode && skMode && pkMode !== skMode) {
    throw fail(
      'VALIDATION',
      'Publishable and secret keys must be from the same Stripe mode (both test or both live).',
      400
    );
  }
  const secretEnc = secret ? box().encryptValue(secret) : '';
  const webhookEnc = webhook ? box().encryptValue(webhook) : '';
  const last4 = secret ? secret.slice(-4) : '';
  db.prepare(
    `INSERT INTO lead_payment_configs (lead_id, publishable_key, secret_key_enc, webhook_secret_enc, secret_key_last4, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(lead_id) DO UPDATE SET publishable_key = excluded.publishable_key,
       secret_key_enc = excluded.secret_key_enc, webhook_secret_enc = excluded.webhook_secret_enc,
       secret_key_last4 = excluded.secret_key_last4, updated_at = datetime('now')`
  ).run(id, publishable || '', secretEnc || '', webhookEnc || '', last4 || '');
  return statusFor(db, id, purpose);
}

/**
 * Disconnect — ONE action for the ONE config: clears the unified
 * row AND both legacy rows, so no retired store can keep a surface
 * quietly configured after the owner disconnects.
 */
function clearCredentials(db, leadId) {
  sm().ensureTables(db);
  const id = Number(leadId);
  db.prepare('DELETE FROM lead_payment_configs WHERE lead_id = ?').run(id);
  db.prepare('DELETE FROM shop_stripe_keys WHERE lead_id = ?').run(id);
  db.prepare('DELETE FROM membership_stripe_keys WHERE lead_id = ?').run(id);
}

/** A Stripe client bound to an explicit secret (cached per lead+source+fingerprint). */
function clientForLayer(leadId, source, secretKey) {
  const fingerprint = crypto.createHash('sha256').update(secretKey).digest('hex').slice(0, 12);
  const cacheKey = `${Number(leadId)}:${source}:${fingerprint}`;
  let client = clientCache.get(cacheKey);
  if (!client) {
    client = new Stripe(secretKey, { timeout: 15000, maxNetworkRetries: 1 });
    clientCache.set(cacheKey, client);
  }
  return client;
}

/** Resolve + build the client that would run a charge for this purpose. Throws PAYMENTS_NOT_CONFIGURED. */

/**
 * Ordered webhook-verification candidates for a lead: the unified
 * secret first, then BOTH legacy stores (an event for a purchase
 * made under a retired store must still verify), then — for shop /
 * unified traffic — the workspace secret. Deduped by secret value;
 * each candidate carries the secret key of its own layer so a
 * verification client can be built from it.
 */
function webhookCandidates(db, leadId, purpose = 'any') {
  const id = Number(leadId);
  const seen = new Set();
  const out = [];
  const push = (source, creds) => {
    if (!creds || !creds.webhookSecret || seen.has(creds.webhookSecret)) return;
    seen.add(creds.webhookSecret);
    out.push({ source, webhookSecret: creds.webhookSecret, secretKey: creds.secretKey || '' });
  };
  push('unified', getUnifiedCredentials(db, id));
  if (purpose !== 'membership') push('lead', getShopLegacyCredentials(db, id));
  if (purpose !== 'shop') push('membership', getMembershipLegacyCredentials(db, id));
  if (purpose === 'membership') push('lead', getShopLegacyCredentials(db, id));
  if (purpose !== 'membership') push('workspace', getWorkspaceCredentials(db));
  return out;
}

/**
 * Verify a webhook payload against the business's candidate
 * secrets (see webhookCandidates). Returns { event, source } for
 * the layer whose secret verified. Throws PAYMENTS_NOT_CONFIGURED
 * when no layer has a webhook secret, or the last signature error
 * when none verify. The verification client is built from the
 * candidate's own secret key when it has one (any client can verify
 * any secret — the SDK checks the signature against the SECRET, not
 * the key — but using the layer's own client keeps test stubs and
 * account context honest).
 */
function constructEventAny(db, leadId, rawBody, signature) {
  const candidates = webhookCandidates(db, leadId, 'any');
  if (!candidates.length) {
    throw notConfigured('Stripe webhooks are not configured for this site.');
  }
  let lastError = null;
  for (const cand of candidates) {
    try {
      const client = cand.secretKey
        ? clientForLayer(leadId, cand.source, cand.secretKey)
        : clientForLayer(leadId, cand.source, candidates.find((c) => c.secretKey)?.secretKey || 'whsec_only');
      const event = client.webhooks.constructEvent(rawBody, signature, cand.webhookSecret);
      return { event, source: cand.source };
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError || new Error('Webhook signature verification failed');
}

/**
 * Pick which lead an (unverified) tenant event belongs to, merging
 * the shop and membership resolvers: checkout/order metadata and
 * local order records first, then membership subscription/customer
 * records. Peeked values ONLY select the verification candidates —
 * nothing is applied until a signature check passes.
 */
function resolveLeadForEvent(db, eventLike) {
  sm().ensureTables(db);
  const obj = (eventLike && eventLike.data && eventLike.data.object) || {};
  const meta = obj.metadata || {};
  const fromMeta = Number(meta.bitpype_lead_id);
  if (Number.isInteger(fromMeta) && fromMeta > 0) return fromMeta;
  const orderId = Number(meta.bitpype_order_id);
  if (Number.isInteger(orderId) && orderId > 0) {
    const row = db.prepare('SELECT lead_id FROM ecommerce_orders WHERE id = ?').get(orderId);
    if (row) return Number(row.lead_id);
  }
  if (obj.id && String(obj.id).startsWith('cs_')) {
    const order = sm().getShopOrderBySession(db, String(obj.id));
    if (order) return Number(order.lead_id);
  }
  const subId = String(obj.subscription || (obj.object === 'subscription' ? obj.id : '') || '');
  if (subId) {
    const leadId = sm().findLeadByStripeSubscription(db, subId);
    if (leadId) return leadId;
  }
  if (obj.id && String(obj.id).startsWith('sub_')) {
    const leadId = sm().findLeadByStripeSubscription(db, String(obj.id));
    if (leadId) return leadId;
  }
  const customer = String(obj.customer || '');
  if (customer) {
    const leadId = sm().findLeadByStripeCustomer(db, customer);
    if (leadId) return leadId;
  }
  return null;
}

module.exports = {
  fail,
  notConfigured,
  modeForKey,
  modeForSecret,
  getUnifiedCredentials,
  getShopLegacyCredentials,
  getMembershipLegacyCredentials,
  getWorkspaceCredentials,
  layersFor,
  resolve,
  leadLayerFor,
  isConfigured,
  effectiveMode,
  statusFor,
  saveCredentials,
  clearCredentials,
  clientForLayer,
  webhookCandidates,
  constructEventAny,
  resolveLeadForEvent,
};
