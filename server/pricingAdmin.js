'use strict';

/**
 * Batch 24 — pricing control in Admin Settings → Billing.
 *
 * Ely edits AMOUNTS (USD); this module owns the Stripe Products/Prices
 * behind them so nobody has to paste price_… ids by hand any more.
 *
 * Items: the three paid plans (monthly) + the Bit Credits pack (one-time).
 * Each item's checkout price id stays in its long-standing platform
 * setting (stripe.price_id_<plan> / stripe.price_id_credits) — this module
 * is a writer for those settings, not a replacement store. The resolved
 * Stripe Product id is persisted alongside (stripe.product_id_<plan> /
 * stripe.product_id_credits) so re-pricing always lands on the same
 * Product; product resolution order is:
 *   1. product of the item's current Price (what checkout uses today)
 *   2. the persisted product-id setting (verified live)
 *   3. Stripe product search / list by metadata bitpype_key=<lookupKey>
 *   4. create the Product with that metadata
 *
 * Save semantics (updatePricing):
 *   - Every requested amount is validated up front. Stripe unconfigured →
 *     STRIPE_NOT_CONFIGURED, nothing saved.
 *   - ALL new Prices are created BEFORE any setting is swapped. A Stripe
 *     rejection aborts the whole save: no settings change, no old price
 *     deactivated (an unreferenced orphan Price may exist in Stripe —
 *     prices are append-only there; it is never pointed at).
 *   - Settings (price id + product id + display label) are then written
 *     with a snapshot rollback, so a setting never points at a Price that
 *     does not exist.
 *   - Old Prices are deactivated last, best-effort: a failure is reported
 *     as a warning, never hidden. Existing subscribers keep the price
 *     they signed up with — this panel only affects NEW checkouts.
 *
 * Display copy sync: a plan's amount label (billing.amount_label_<plan>,
 * the same string billing.catalogForApi shows customers and referrals
 * parse) is rewritten as "<Plan> · $<amount>/mo"; the credits label
 * (credits.pack_label) as "<pack> credits · $<amount>".
 */

const platform = require('./platform');
const stripeClient = require('./stripeClient');
const { PLAN_STANDARD, PLAN_PRO, PLAN_PREMIUM, PLANS, getPlan } = require('./plans');

const MAX_AMOUNT_USD = 100000;

const ITEMS = [
  {
    id: 'standard',
    kind: 'plan',
    planId: PLAN_STANDARD,
    name: PLANS[PLAN_STANDARD].name,
    interval: 'month',
    priceSetting: 'stripe.price_id_standard',
    productSetting: 'stripe.product_id_standard',
    labelSetting: 'billing.amount_label_standard',
    productName: 'Bitpype Standard',
    lookupKey: 'plan_standard',
    envVars: ['STRIPE_PRICE_ID_STANDARD', 'STRIPE_PRICE_ID'],
  },
  {
    id: 'pro',
    kind: 'plan',
    planId: PLAN_PRO,
    name: PLANS[PLAN_PRO].name,
    interval: 'month',
    priceSetting: 'stripe.price_id_pro',
    productSetting: 'stripe.product_id_pro',
    labelSetting: 'billing.amount_label_pro',
    productName: 'Bitpype Pro',
    lookupKey: 'plan_pro',
    envVars: ['STRIPE_PRICE_ID_PRO'],
  },
  {
    id: 'premium',
    kind: 'plan',
    planId: PLAN_PREMIUM,
    name: PLANS[PLAN_PREMIUM].name,
    interval: 'month',
    priceSetting: 'stripe.price_id_premium',
    productSetting: 'stripe.product_id_premium',
    labelSetting: 'billing.amount_label_premium',
    productName: 'Bitpype Premium',
    lookupKey: 'plan_premium',
    envVars: ['STRIPE_PRICE_ID_PREMIUM'],
  },
  {
    id: 'credits',
    kind: 'credits',
    planId: null,
    name: 'Bit Credits pack',
    interval: null,
    priceSetting: 'stripe.price_id_credits',
    productSetting: 'stripe.product_id_credits',
    labelSetting: 'credits.pack_label',
    productName: 'Bitpype Bit Credits',
    lookupKey: 'credits_pack',
    envVars: ['STRIPE_PRICE_ID_CREDITS'],
  },
];

/** Batch 57: a plan's display name can be overridden in Package
 *  contents — resolve it live so this panel and the synced price labels
 *  use the current name, not the load-time catalog name. */
function displayName(item) {
  if (item.kind === 'plan' && item.planId) {
    try {
      return getPlan(item.planId).name || item.name;
    } catch {
      return item.name;
    }
  }
  return item.name;
}

function invalidAmount(item, value) {
  const e = new Error(
    `Invalid amount for ${displayName(item)}: ${JSON.stringify(value)} — enter a USD amount over $0 and up to $${MAX_AMOUNT_USD}, with at most 2 decimal places.`
  );
  e.code = 'INVALID_AMOUNT';
  return e;
}

/** Strict USD → cents. Accepts "49", "49.9", "49.99" (string or number). */
function parseAmountToCents(value, item) {
  const raw = typeof value === 'number' ? String(value) : String(value == null ? '' : value).trim();
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(raw);
  if (!m) throw invalidAmount(item, value);
  const cents = Number(m[1]) * 100 + Number((m[2] || '0').padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || cents <= 0 || cents > MAX_AMOUNT_USD * 100) {
    throw invalidAmount(item, value);
  }
  return cents;
}

function formatUsd(cents) {
  const v = Number(cents) / 100;
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

/** First $ amount in a display label ("Standard · $99/mo" → 9900), else null. */
function parseLabelCents(label) {
  const m = /\$\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/.exec(String(label || ''));
  if (!m) return null;
  try {
    return parseAmountToCents(m[1].replace(/,/g, ''), { name: 'label' });
  } catch {
    return null;
  }
}

/** 'test' | 'live' | 'unknown' from the configured key; null when no key. */
function modeFromKey(key) {
  const m = /(?:sk|rk)_(test|live)_/.exec(String(key || ''));
  if (m) return m[1];
  return String(key || '').trim() ? 'unknown' : null;
}

function envOverridden(item) {
  return item.envVars.some((v) => String(process.env[v] || '').trim() !== '');
}

/** The price id checkout would use for this item today (env wins, then setting). */
async function currentPriceId(item) {
  if (item.kind === 'plan') {
    return String((await stripeClient.getPriceIdForPlan(item.planId)) || '').trim();
  }
  const env = String(process.env.STRIPE_PRICE_ID_CREDITS || '').trim();
  if (env) return env;
  return String((await platform.getPlatformSetting(item.priceSetting, '')) || '').trim();
}

async function labelFor(item, cents) {
  if (item.kind === 'credits') {
    const pack = Math.max(1, Math.floor(Number(await platform.getPlatformSetting('credits.pack_amount', '50')) || 50));
    return `${pack} credits · $${formatUsd(cents)}`;
  }
  return `${displayName(item)} · $${formatUsd(cents)}/mo`;
}

/**
 * Resolve an item's current state. Stripe is consulted for the amount when
 * possible; ANY Stripe failure degrades to the stored display label — this
 * never throws, so the settings page always loads.
 */
async function resolveCurrent(item, stripe) {
  const priceId = await currentPriceId(item);
  const storedProductId = String((await platform.getPlatformSetting(item.productSetting, '')) || '').trim();
  const label = String((await platform.getPlatformSetting(item.labelSetting, '')) || '');
  let amountCents = null;
  let amountSource = null;
  let productId = '';
  let priceActive = null;
  if (stripe && priceId) {
    try {
      const price = await stripe.prices.retrieve(priceId);
      if (price) {
        productId = typeof price.product === 'string' ? price.product : (price.product && price.product.id) || '';
        priceActive = price.active !== false;
        const unit = Number(price.unit_amount);
        if (Number.isFinite(unit) && unit > 0) {
          amountCents = unit;
          amountSource = 'stripe';
        }
      }
    } catch {
      /* degrade to the label fallback below */
    }
  }
  if (amountCents == null) {
    const fromLabel = parseLabelCents(label);
    if (fromLabel != null) {
      amountCents = fromLabel;
      amountSource = 'label';
    }
  }
  return { priceId, storedProductId, label, amountCents, amountSource, productId, priceActive };
}

async function getPricingState() {
  const key = String((await stripeClient.getSecretKey()) || '').trim();
  const configured = !!key;
  let stripe = null;
  let stripeError = null;
  if (configured) {
    try {
      stripe = await stripeClient.getStripe();
    } catch (e) {
      stripeError = e.message;
    }
  }
  const items = [];
  for (const item of ITEMS) {
    const cur = await resolveCurrent(item, stripe);
    items.push({
      id: item.id,
      name: displayName(item),
      kind: item.kind,
      interval: item.interval,
      priceSetting: item.priceSetting,
      priceId: cur.priceId || null,
      productId: cur.storedProductId || cur.productId || null,
      amountUsd: cur.amountCents != null ? cur.amountCents / 100 : null,
      amountSource: cur.amountSource,
      priceActive: cur.priceActive,
      envOverridden: envOverridden(item),
      label: cur.label,
    });
  }
  return { configured, mode: modeFromKey(key), stripeError, items };
}

async function findOrCreateProduct(stripe, item, hintProductIds) {
  for (const pid of hintProductIds) {
    if (!pid) continue;
    try {
      const p = await stripe.products.retrieve(pid);
      if (p && !p.deleted && p.id) return { productId: String(p.id), created: false };
    } catch {
      /* fall through to search/create */
    }
  }
  try {
    const found = await stripe.products.search({
      query: `metadata['bitpype_key']:'${item.lookupKey}'`,
      limit: 1,
    });
    const hit = found && found.data && found.data[0];
    if (hit && hit.id && !hit.deleted) return { productId: String(hit.id), created: false };
  } catch {
    /* search is a fallback, never fatal */
  }
  try {
    const list = await stripe.products.list({ limit: 100 });
    const hit = ((list && list.data) || []).find(
      (p) => p && !p.deleted && p.metadata && p.metadata.bitpype_key === item.lookupKey
    );
    if (hit) return { productId: String(hit.id), created: false };
  } catch {
    /* list is a fallback, never fatal */
  }
  const created = await stripe.products.create({
    name: item.productName,
    metadata: { bitpype_key: item.lookupKey, bitpype_item: item.id },
  });
  return { productId: String((created && created.id) || ''), created: true };
}

function stripeFailure(item, e) {
  const err = new Error(`Stripe rejected the ${displayName(item)} price change: ${e.message || String(e)}`);
  err.code = 'STRIPE_ERROR';
  err.item = item.id;
  return err;
}

async function updatePricing(amounts) {
  const input = amounts && typeof amounts === 'object' ? amounts : {};
  const requested = ITEMS.filter(
    (it) => input[it.id] !== undefined && input[it.id] !== null && String(input[it.id]).trim() !== ''
  );
  const key = String((await stripeClient.getSecretKey()) || '').trim();
  const mode = modeFromKey(key);
  if (!requested.length) {
    return { configured: !!key, mode, updated: [], unchanged: [], warnings: [] };
  }

  // Validate everything before Stripe or any settings write.
  const desired = new Map();
  for (const item of requested) desired.set(item.id, parseAmountToCents(input[item.id], item));

  if (!key) {
    const e = new Error(
      'Stripe is not configured — add the Stripe secret key in Billing settings first, then set amounts.'
    );
    e.code = 'STRIPE_NOT_CONFIGURED';
    throw e;
  }
  let stripe;
  try {
    stripe = await stripeClient.getStripe();
  } catch (e) {
    const err = new Error(e.message || 'Stripe is not configured');
    err.code = 'STRIPE_NOT_CONFIGURED';
    throw err;
  }

  // Phase 1 — current state (read-only).
  const currents = new Map();
  for (const item of requested) currents.set(item.id, await resolveCurrent(item, stripe));
  const changed = requested.filter((item) => currents.get(item.id).amountCents !== desired.get(item.id));
  const unchanged = requested.filter((item) => !changed.includes(item)).map((item) => item.id);
  if (!changed.length) {
    return { configured: true, mode, updated: [], unchanged, warnings: [] };
  }

  // Phase 2 — create every new Price first. Any rejection aborts the whole
  // save with zero settings swapped and zero old prices deactivated.
  const minted = new Map();
  for (const item of changed) {
    const cur = currents.get(item.id);
    let product;
    try {
      product = await findOrCreateProduct(stripe, item, [cur.productId, cur.storedProductId]);
    } catch (e) {
      throw stripeFailure(item, e);
    }
    if (!product.productId) throw stripeFailure(item, new Error('Stripe did not return a product id'));
    let price;
    try {
      price = await stripe.prices.create({
        product: product.productId,
        currency: 'usd',
        unit_amount: desired.get(item.id),
        ...(item.interval ? { recurring: { interval: item.interval } } : {}),
        metadata: { bitpype_key: item.lookupKey, bitpype_item: item.id },
      });
    } catch (e) {
      throw stripeFailure(item, e);
    }
    if (!price || !price.id) throw stripeFailure(item, new Error('Stripe did not return a price id'));
    minted.set(item.id, {
      productId: product.productId,
      productCreated: product.created,
      newPriceId: String(price.id),
    });
  }

  // Phase 3 — swap settings (price id + product id + display label) with a
  // snapshot rollback: a setting only ever points at a Price that exists.
  const writes = [];
  for (const item of changed) {
    const m = minted.get(item.id);
    writes.push([item.priceSetting, m.newPriceId]);
    writes.push([item.productSetting, m.productId]);
    writes.push([item.labelSetting, await labelFor(item, desired.get(item.id))]);
  }
  const snapshot = new Map();
  for (const [k] of writes) {
    if (!snapshot.has(k)) snapshot.set(k, String((await platform.getPlatformSetting(k, '')) || ''));
  }
  const applied = [];
  try {
    for (const [k, v] of writes) {
      await platform.setPlatformSetting(k, v);
      applied.push(k);
    }
  } catch (e) {
    for (const k of applied.reverse()) {
      try {
        await platform.setPlatformSetting(k, snapshot.get(k));
      } catch {
        /* best-effort rollback */
      }
    }
    const err = new Error(
      `Saving the pricing settings failed (${e.message}); settings were rolled back and no price was swapped.`
    );
    err.code = 'SETTINGS_WRITE_FAILED';
    throw err;
  }

  // Phase 4 — deactivate the old Prices, best-effort with loud warnings.
  const warnings = [];
  for (const item of changed) {
    const oldId = currents.get(item.id).priceId;
    const newId = minted.get(item.id).newPriceId;
    if (oldId && oldId !== newId) {
      try {
        await stripe.prices.update(oldId, { active: false });
      } catch (e) {
        warnings.push(
          `${displayName(item)}: new price saved, but the old price ${oldId} could not be deactivated (${e.message}). It stays active in Stripe but checkout no longer uses it; deactivate it in the Stripe dashboard if you want it retired.`
        );
      }
    }
    if (envOverridden(item)) {
      warnings.push(
        `${displayName(item)}: an environment variable (${item.envVars.join(' / ')}) also sets this price and takes precedence over the saved setting until it is removed.`
      );
    }
  }

  return {
    configured: true,
    mode,
    updated: changed.map((item) => ({
      id: item.id,
      name: displayName(item),
      cents: desired.get(item.id),
      amountUsd: desired.get(item.id) / 100,
      oldPriceId: currents.get(item.id).priceId || null,
      newPriceId: minted.get(item.id).newPriceId,
      productId: minted.get(item.id).productId,
      productCreated: minted.get(item.id).productCreated,
    })),
    unchanged,
    warnings,
  };
}

module.exports = {
  ITEMS,
  MAX_AMOUNT_USD,
  parseAmountToCents,
  parseLabelCents,
  formatUsd,
  modeFromKey,
  getPricingState,
  updatePricing,
};
