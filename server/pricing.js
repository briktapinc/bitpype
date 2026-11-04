'use strict';

/**
 * Batch 139 — THE PRICING SERVICE (Ely, 2026-11-04: "We need a
 * pricing module too — displays pricing set in portal and works
 * with all other modules").
 *
 * THE RECONCILIATION — ONE PRICE SOURCE. The hazard this module is
 * designed against is two stored numbers for one sellable drifting
 * apart (the price list says $80, checkout charges $100) or a price
 * being charged twice from two stores. The shape that kills both:
 *
 *   - A pricing entry is STANDALONE or LINKED. A standalone entry is
 *     the owner's own price-list line (a package, a tier, a "from"
 *     price, a display-only line) and owns its stored price.
 *   - A LINKED entry points at an existing sellable — a booking
 *     service ('bookings') or a shop product ('ecommerce') — and
 *     carries NO live price copy: its name and price resolve LIVE
 *     from the source record on every read, through the same
 *     readers bookings/checkout already use. The row stores only a
 *     link-time snapshot, used solely if the owner unlinks (the
 *     entry then keeps the last live values as its own).
 *   - The portal Pricing pane is the ONE editing surface. Editing a
 *     linked entry's price WRITES THROUGH to the source record via
 *     that module's own writer (updateBookingService /
 *     updateProduct), so the number bookings and the checkout
 *     engine charge from is the number the pane edited — there is
 *     literally one stored price per sellable, never a second copy
 *     to desync. No charging code changes: bookings and checkout
 *     already read those records; this service proves it in tests.
 *   - A product WITH VARIANTS is never flattened: the entry shows
 *     the product's honest range ("From $X" via productPriceLabel)
 *     and a single-price edit is REFUSED with directions to the
 *     variant editor — per-variant prices stay variant-owned.
 *   - Membership tiers are deliberately NOT linkable in v1: a tier's
 *     price is mirrored into Stripe (stripe_price_id) by the
 *     membership engine, so a write-through here could desync the
 *     local row from the live Stripe price. Gallery photo prices,
 *     estimate base prices and menu price_text are likewise left
 *     where they live (per-photo sale prices, calculator inputs and
 *     free text respectively — none is a price-list source).
 *   - The PRICE BOOK (getPriceBook) is the canonical read: the
 *     owner's published entries — standalone as stored, linked
 *     resolved live. It does NOT auto-include unlinked services or
 *     products: the price list is what the owner put on it, and
 *     auto-inclusion would surprise (a priced product is not
 *     automatically a price-list line). Every consumer — the site
 *     embed, the shared layer, the site chat, the design-agent
 *     census — reads the book, never the tables.
 *   - A linked entry whose source was deleted resolves to nothing:
 *     it drops out of the book and the public payload (dormant,
 *     never a dangling price) and is flagged source_missing in the
 *     portal so the owner can unlink or delete it.
 *
 * Display freshness: embeds resolve at serve time, so in-app and
 * preview displays are live; a STATIC EXPORT snapshots module
 * content at export time, so a price change reaches an exported
 * site on re-export — the same rule as every other module.
 */

const modules = require('./siteModules');

function fail(code, message, status) {
  const err = new Error(message);
  err.code = code;
  if (status) err.status = status;
  return err;
}

const PRICE_MODES = ['fixed', 'from', 'text'];
const LINKED_TYPES = ['bookings', 'ecommerce'];

function ensureTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pricing_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      price_mode TEXT NOT NULL DEFAULT 'fixed',
      price_cents INTEGER,
      price_text TEXT NOT NULL DEFAULT '',
      currency TEXT NOT NULL DEFAULT 'USD',
      unit_suffix TEXT NOT NULL DEFAULT '',
      linked_type TEXT NOT NULL DEFAULT '',
      linked_id INTEGER,
      featured INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'draft',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_pricing_entries_lead
      ON pricing_entries(lead_id, sort_order, id);
  `);
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

function cleanStatus(raw, fallback) {
  if (raw == null) return fallback;
  return String(raw).toLowerCase() === 'published' ? 'published' : 'draft';
}

function cleanMode(raw, fallback) {
  if (raw == null) return fallback;
  const mode = String(raw).trim().toLowerCase();
  if (!PRICE_MODES.includes(mode)) {
    throw fail('VALIDATION', `price_mode must be one of: ${PRICE_MODES.join(', ')}`);
  }
  return mode;
}

function cleanFeatured(raw, fallback) {
  if (raw == null) return fallback;
  if (typeof raw === 'boolean') return raw ? 1 : 0;
  if (typeof raw === 'number') return raw ? 1 : 0;
  const s = String(raw).trim().toLowerCase();
  if (s === 'yes' || s === 'true' || s === '1') return 1;
  if (s === 'no' || s === 'false' || s === '0' || s === '') return 0;
  return fallback;
}

/** A price as integer cents from price_cents or a dollars `price`.
 *  Negative money is refused outright — never clamped to zero. */
function priceCentsFrom(data) {
  const present = (v) => v != null && !(typeof v === 'string' && v.trim() === '');
  if (present(data.price_cents)) {
    const n = Number(data.price_cents);
    if (!Number.isFinite(n)) throw fail('VALIDATION', 'price_cents must be a number');
    if (n < 0) throw fail('VALIDATION', 'Price cannot be negative');
    return Math.round(n);
  }
  if (present(data.price)) {
    const n = Number(data.price);
    if (!Number.isFinite(n)) throw fail('VALIDATION', 'price must be a number');
    if (n < 0) throw fail('VALIDATION', 'Price cannot be negative');
    return Math.round(n * 100);
  }
  return undefined;
}

function hasPriceInput(data) {
  // An empty string from a form-style caller means "no price
  // change", never $0 — the absent-key discipline every module
  // writer here follows.
  const present = (v) => v != null && !(typeof v === 'string' && v.trim() === '');
  return present(data.price_cents) || present(data.price);
}

/** The link target of an entry: a booking service or a shop product
 *  of THIS lead. Returns the live source record or throws. */
function loadSource(db, lid, linkedType, linkedId) {
  if (linkedType === 'bookings') {
    const svc = modules.getBookingService(db, lid, linkedId);
    if (!svc) throw fail('VALIDATION', `Booking service #${linkedId} does not exist for this business`);
    return svc;
  }
  if (linkedType === 'ecommerce') {
    const product = modules.getProduct(db, lid, linkedId);
    if (!product) throw fail('VALIDATION', `Product #${linkedId} does not exist for this business`);
    return product;
  }
  throw fail('VALIDATION', `linked_type must be one of: ${LINKED_TYPES.join(', ')}`);
}

/** Parse a link change from an update/create payload: the explicit
 *  linked_type + linked_id pair, or the portal's composite
 *  linked_ref ('bookings:12'; '' unlinks). Returns null when the
 *  payload carries no link change. */
function parseLinkInput(data) {
  if (data.linked_ref != null) {
    const ref = String(data.linked_ref).trim();
    if (!ref) return { linked_type: '', linked_id: null };
    const m = /^([a-z]+):(\d+)$/.exec(ref);
    if (!m) throw fail('VALIDATION', `linked_ref must look like 'bookings:12' (got: ${ref})`);
    return { linked_type: m[1], linked_id: Number(m[2]) };
  }
  if (data.linked_type != null || data.linked_id != null) {
    const type = String(data.linked_type || '').trim().toLowerCase();
    if (!type) return { linked_type: '', linked_id: null };
    if (!LINKED_TYPES.includes(type)) {
      throw fail('VALIDATION', `linked_type must be one of: ${LINKED_TYPES.join(', ')}`);
    }
    const id = Number(data.linked_id);
    if (!Number.isInteger(id) || id <= 0) throw fail('VALIDATION', 'linked_id must be the id of the service or product to link');
    return { linked_type: type, linked_id: id };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Resolution — the one place a stored row becomes a priced entry.     */
/* Linked entries read their source LIVE on every call: a renamed    */
/* or repriced service/product shows its current values everywhere,  */
/* with no pricing-row write in between.                             */
/* ------------------------------------------------------------------ */

function resolveEntry(db, lid, row) {
  const linkedType = String(row.linked_type || '');
  const linkedId = row.linked_id != null ? Number(row.linked_id) : null;
  let name = String(row.name || '');
  let description = String(row.description || '');
  let priceCents = row.price_cents != null ? Number(row.price_cents) : null;
  let currency = String(row.currency || 'USD');
  let hasVariants = false;
  let sourceMissing = false;
  let product = null;

  if (linkedType && linkedId) {
    if (linkedType === 'bookings') {
      const svc = modules.getBookingService(db, lid, linkedId);
      if (!svc) sourceMissing = true;
      else {
        name = svc.name;
        if (!description) description = String(svc.description || '');
        priceCents = Number(svc.price_cents) || 0;
        currency = String(svc.currency || 'USD');
      }
    } else if (linkedType === 'ecommerce') {
      product = modules.getProduct(db, lid, linkedId);
      if (!product) sourceMissing = true;
      else {
        name = product.name;
        if (!description) description = String(product.description || '');
        hasVariants = modules.listProductVariants(db, lid, product.id).length > 0;
        priceCents = modules.productDisplayPriceCents(db, lid, product);
        currency = String(product.currency || 'USD');
      }
    }
  }

  const mode = PRICE_MODES.includes(row.price_mode) ? row.price_mode : 'fixed';
  let priceLabel;
  let displayMode = mode;
  if (mode === 'text') {
    priceLabel = String(row.price_text || '').trim() || 'Price on request';
    priceCents = null;
  } else if (linkedType === 'ecommerce' && product && hasVariants) {
    // The product's own honest label: "From $X" across a range, the
    // single price when every variant costs the same.
    priceLabel = modules.productPriceLabel(db, lid, product) || 'Free';
    displayMode = priceLabel.startsWith('From ') ? 'from' : 'fixed';
  } else {
    const base = modules.formatPrice(priceCents, currency);
    if (!base) {
      priceLabel = 'Free';
      displayMode = 'fixed';
    } else if (mode === 'from') {
      priceLabel = `From ${base}`;
    } else {
      priceLabel = base;
    }
  }

  return {
    id: row.id,
    lead_id: Number(row.lead_id),
    origin: linkedType ? linkedType : 'standalone',
    linked_type: linkedType,
    linked_id: linkedId,
    linked_ref: linkedType && linkedId ? `${linkedType}:${linkedId}` : '',
    name,
    description,
    price_mode: mode,
    display_mode: displayMode,
    price_cents: priceCents,
    price_text: String(row.price_text || ''),
    price_label: priceLabel,
    currency,
    unit_suffix: String(row.unit_suffix || ''),
    featured: !!row.featured,
    status: row.status,
    sort_order: Number(row.sort_order) || 0,
    has_variants: hasVariants,
    source_missing: sourceMissing,
    stored_name: String(row.name || ''),
    stored_price_cents: row.price_cents != null ? Number(row.price_cents) : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function getRawEntry(db, lid, id) {
  ensureTables(db);
  return db
    .prepare('SELECT * FROM pricing_entries WHERE lead_id = ? AND id = ?')
    .get(Number(lid), Number(id));
}

function listPricingEntries(db, leadId, { includeDrafts = true } = {}) {
  ensureTables(db);
  const lid = Number(leadId);
  let sql = 'SELECT * FROM pricing_entries WHERE lead_id = ?';
  if (!includeDrafts) sql += " AND status = 'published'";
  sql += ' ORDER BY sort_order ASC, id ASC';
  return db.prepare(sql).all(lid).map((row) => resolveEntry(db, lid, row));
}

function getPricingEntry(db, leadId, id) {
  const lid = Number(leadId);
  const row = getRawEntry(db, lid, id);
  if (!row) throw fail('NOT_FOUND', 'Pricing entry not found', 404);
  return resolveEntry(db, lid, row);
}

/* ------------------------------------------------------------------ */
/* The price book — the canonical read every consumer uses.            */
/* ------------------------------------------------------------------ */

/**
 * The owner's price list, resolved: published entries only (unless
 * includeDrafts), standalone entries as stored, linked entries at
 * their source's CURRENT name and price. Entries whose source has
 * been deleted drop out — dormant, never a dangling price.
 */
function getPriceBook(db, leadId, opts = {}) {
  const entries = listPricingEntries(db, leadId, {
    includeDrafts: !!opts.includeDrafts,
  }).filter((e) => !e.source_missing);
  return { entries, count: entries.length };
}

/** The public embed payload: published, resolved, display fields
 *  only — stored snapshots and editor state never leave the server. */
function publicPricingPayload(db, leadId) {
  const book = getPriceBook(db, leadId);
  return {
    entries: book.entries.map((e) => ({
      id: e.id,
      origin: e.origin,
      name: e.name,
      description: e.description,
      display_mode: e.display_mode,
      price_cents: e.price_cents,
      price_label: e.price_label,
      currency: e.currency,
      unit_suffix: e.unit_suffix,
      featured: e.featured,
    })),
  };
}

const PRICE_BOOK_CHAT_HEADER =
  'Price list — the business’s own published prices. Quote these figures EXACTLY as written; ' +
  'never invent, estimate, round or change a price, and never subtract a discount yourself ' +
  '(any booking discount mentioned elsewhere is applied by the booking system — these are the list prices):';

/** The chat quote block: one line per book entry, figures byte-equal
 *  to the book's own labels. Null when the book is empty — no block,
 *  no prices quoted, exactly like the Batch 136 pitch discipline. */
function priceBookChatText(book) {
  if (!book || !Array.isArray(book.entries) || !book.entries.length) return null;
  const lines = [PRICE_BOOK_CHAT_HEADER];
  for (const e of book.entries) {
    lines.push(`- ${e.name}: ${e.price_label}${e.unit_suffix ? ` ${e.unit_suffix}` : ''}`);
  }
  return lines.join('\n');
}

/** Portal pickers: the lead's linkable sellables with live prices. */
function listLinkables(db, leadId) {
  const lid = Number(leadId);
  modules.ensureTables(db);
  return {
    bookings: modules.listBookingServices(db, lid).map((s) => ({
      id: s.id,
      name: s.name,
      status: s.status,
      price_cents: Number(s.price_cents) || 0,
      price_label: s.price_label || modules.formatPrice(s.price_cents, s.currency) || 'Free',
    })),
    ecommerce: modules.listProducts(db, lid).map((p) => ({
      id: p.id,
      name: p.name,
      status: p.status,
      price_cents: modules.productDisplayPriceCents(db, lid, p),
      price_label: modules.productPriceLabel(db, lid, p) || 'Free',
      has_variants: modules.listProductVariants(db, lid, p.id).length > 0,
    })),
  };
}

/** Design-agent census summary: counts + the published lines. */
function pricingSummary(db, leadId) {
  const all = listPricingEntries(db, leadId);
  const book = getPriceBook(db, leadId);
  return {
    total: all.length,
    published: book.count,
    standalone: all.filter((e) => e.origin === 'standalone').length,
    linked: all.filter((e) => e.origin !== 'standalone').length,
    source_missing: all.filter((e) => e.source_missing).length,
    sample: book.entries
      .slice(0, 6)
      .map((e) => `${e.name} — ${e.price_label}${e.unit_suffix ? ` ${e.unit_suffix}` : ''}`),
  };
}

/* ------------------------------------------------------------------ */
/* Writes                                                              */
/* ------------------------------------------------------------------ */

/** Mode constraints checked against the MERGED entry state. */
function assertModeConstraints(resolvedLike, { standalone }) {
  if (resolvedLike.price_mode === 'text' && !String(resolvedLike.price_text || '').trim()) {
    throw fail('VALIDATION', 'A text-mode entry needs its label (price_text, e.g. "Custom quote")');
  }
  if (
    standalone &&
    resolvedLike.price_mode === 'from' &&
    !(Number(resolvedLike.price_cents) > 0)
  ) {
    throw fail('VALIDATION', 'A "from" price needs an amount above zero');
  }
}

/**
 * The write-through: a price edit aimed at a LINKED entry lands on
 * the SOURCE record, through the source module's own writer — the
 * same single stored number bookings and checkout charge from. A
 * variant product refuses (its prices are per-variant). Returns the
 * freshly resolved entry.
 */
function applyPriceWrite(db, lid, row, data) {
  if (!hasPriceInput(data)) return;
  const cents = priceCentsFrom(data);
  const linkedType = String(row.linked_type || '');
  if (!linkedType) {
    db.prepare('UPDATE pricing_entries SET price_cents = ?, updated_at = datetime(\'now\') WHERE id = ? AND lead_id = ?')
      .run(cents, row.id, lid);
    return;
  }
  if (linkedType === 'bookings') {
    const svc = modules.getBookingService(db, lid, row.linked_id);
    if (!svc) {
      throw fail('NOT_FOUND', 'The linked booking service no longer exists — unlink this entry or delete it', 404);
    }
    modules.updateBookingService(db, lid, svc.id, { price_cents: cents });
    return;
  }
  if (linkedType === 'ecommerce') {
    const product = modules.getProduct(db, lid, row.linked_id);
    if (!product) {
      throw fail('NOT_FOUND', 'The linked product no longer exists — unlink this entry or delete it', 404);
    }
    if (modules.listProductVariants(db, lid, product.id).length > 0) {
      throw fail(
        'VALIDATION',
        `"${product.name}" is priced per variant — set each variant's price in the Shop product editor; a single price here would flatten them`,
        400
      );
    }
    modules.updateProduct(db, lid, product.id, { price_cents: cents });
    return;
  }
}

/** Set one entry's price (standalone: its own row; linked: the
 *  source record). Returns the resolved entry + the price book. */
function setPricingEntryPrice(db, leadId, id, data = {}) {
  const lid = Number(leadId);
  const row = getRawEntry(db, lid, id);
  if (!row) throw fail('NOT_FOUND', 'Pricing entry not found', 404);
  if (!hasPriceInput(data)) throw fail('VALIDATION', 'price_cents (or price) is required');
  applyPriceWrite(db, lid, row, data);
  return { entry: getPricingEntry(db, lid, row.id), price_book: getPriceBook(db, lid) };
}

function createPricingEntry(db, leadId, data = {}) {
  ensureTables(db);
  const lid = Number(leadId);
  const link = parseLinkInput(data) || { linked_type: '', linked_id: null };
  const mode = cleanMode(data.price_mode, 'fixed');
  const status = cleanStatus(data.status, 'draft');

  let storedName = String(data.name || '').trim().slice(0, 200);
  let storedPrice = hasPriceInput(data) ? priceCentsFrom(data) : null;
  let currency = String(data.currency || 'USD').slice(0, 8).toUpperCase() || 'USD';

  if (link.linked_type) {
    // Validate the target BEFORE anything is stored; the snapshot
    // keeps the source's current name/price/currency so an unlink
    // (even after the source is deleted) lands on real values.
    const source = loadSource(db, lid, link.linked_type, link.linked_id);
    storedName = String(source.name || storedName || '').slice(0, 200);
    if (storedPrice == null) {
      storedPrice =
        link.linked_type === 'ecommerce'
          ? modules.productDisplayPriceCents(db, lid, source)
          : Number(source.price_cents) || 0;
    }
    currency = String(source.currency || currency).slice(0, 8).toUpperCase();
  } else if (!storedName) {
    throw fail('VALIDATION', 'name is required for a standalone pricing entry');
  }

  assertModeConstraints(
    { price_mode: mode, price_text: data.price_text, price_cents: storedPrice },
    { standalone: !link.linked_type }
  );

  const info = db
    .prepare(
      `INSERT INTO pricing_entries
         (lead_id, name, description, price_mode, price_cents, price_text, currency,
          unit_suffix, linked_type, linked_id, featured, status, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      lid,
      storedName,
      String(data.description || ''),
      mode,
      mode === 'text' ? null : storedPrice,
      String(data.price_text || '').slice(0, 120),
      currency,
      String(data.unit_suffix || '').slice(0, 40),
      link.linked_type,
      link.linked_id,
      cleanFeatured(data.featured, 0),
      status,
      Number(data.sort_order) || 0
    );
  const row = getRawEntry(db, lid, info.lastInsertRowid);
  // A price supplied WITH a link is the owner's intent for the
  // sellable itself — write it through to the source record.
  if (link.linked_type && hasPriceInput(data)) applyPriceWrite(db, lid, row, data);
  return getPricingEntry(db, lid, row.id);
}

function updatePricingEntry(db, leadId, id, data = {}) {
  ensureTables(db);
  const lid = Number(leadId);
  let row = getRawEntry(db, lid, id);
  if (!row) throw fail('NOT_FOUND', 'Pricing entry not found', 404);

  // 1) Link change first — price writes below aim at the NEW state.
  const link = parseLinkInput(data);
  if (link) {
    const wasLinked = !!row.linked_type;
    if (!link.linked_type && wasLinked) {
      // Unlink: snapshot the last live values into the row so the
      // entry stands on its own (works even if the source is gone —
      // the link-time snapshot is the fallback).
      const resolved = resolveEntry(db, lid, row);
      db.prepare(
        `UPDATE pricing_entries SET linked_type = '', linked_id = NULL,
           name = ?, price_cents = ?, currency = ?, updated_at = datetime('now')
         WHERE id = ? AND lead_id = ?`
      ).run(
        resolved.source_missing ? row.name : resolved.name,
        resolved.price_cents != null ? resolved.price_cents : row.price_cents,
        resolved.source_missing ? row.currency : resolved.currency,
        row.id,
        lid
      );
    } else if (link.linked_type) {
      const source = loadSource(db, lid, link.linked_type, link.linked_id);
      const snapshotPrice =
        link.linked_type === 'ecommerce'
          ? modules.productDisplayPriceCents(db, lid, source)
          : Number(source.price_cents) || 0;
      db.prepare(
        `UPDATE pricing_entries SET linked_type = ?, linked_id = ?,
           name = ?, price_cents = ?, currency = ?, updated_at = datetime('now')
         WHERE id = ? AND lead_id = ?`
      ).run(
        link.linked_type,
        link.linked_id,
        String(source.name || '').slice(0, 200),
        snapshotPrice,
        String(source.currency || row.currency || 'USD').slice(0, 8).toUpperCase(),
        row.id,
        lid
      );
    }
    row = getRawEntry(db, lid, id);
  }

  // 2) The name of a linked entry belongs to its source.
  if (data.name != null && row.linked_type) {
    const resolved = resolveEntry(db, lid, row);
    if (String(data.name).trim() !== resolved.name) {
      throw fail(
        'VALIDATION',
        `This entry is linked — its name comes from the ${row.linked_type === 'bookings' ? 'booking service' : 'product'} itself. Rename it there and the price list follows.`
      );
    }
  }

  // 3) Currency of a linked entry belongs to its source too.
  if (data.currency != null && row.linked_type) {
    const resolved = resolveEntry(db, lid, row);
    if (String(data.currency).slice(0, 8).toUpperCase() !== resolved.currency) {
      throw fail('VALIDATION', 'This entry is linked — its currency comes from the source. Change it on the service or product.');
    }
  }

  // 4) Plain field updates on the row itself.
  const sets = [];
  const params = [];
  const set = (col, val) => {
    sets.push(`${col} = ?`);
    params.push(val);
  };
  if (data.name != null && !row.linked_type) set('name', String(data.name).trim().slice(0, 200));
  if (data.description != null) set('description', String(data.description));
  if (data.price_mode != null) set('price_mode', cleanMode(data.price_mode, row.price_mode));
  if (data.price_text != null) set('price_text', String(data.price_text).slice(0, 120));
  if (data.currency != null && !row.linked_type) {
    set('currency', String(data.currency).slice(0, 8).toUpperCase() || 'USD');
  }
  if (data.unit_suffix != null) set('unit_suffix', String(data.unit_suffix).slice(0, 40));
  if (data.featured != null) set('featured', cleanFeatured(data.featured, row.featured));
  if (data.status != null) set('status', cleanStatus(data.status, row.status));
  if (data.sort_order != null) set('sort_order', Number(data.sort_order) || 0);
  if (sets.length) {
    db.prepare(
      `UPDATE pricing_entries SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ? AND lead_id = ?`
    ).run(...params, row.id, lid);
    row = getRawEntry(db, lid, id);
  }

  // 5) Merged-state mode constraints, then the price write-through.
  const resolvedNow = resolveEntry(db, lid, row);
  assertModeConstraints(resolvedNow, { standalone: !row.linked_type });
  if (hasPriceInput(data)) {
    if (resolvedNow.price_mode === 'text') {
      throw fail('VALIDATION', 'This entry shows a text label, not an amount — switch its price_mode to fixed or from to set a price');
    }
    applyPriceWrite(db, lid, row, data);
  }
  return getPricingEntry(db, lid, row.id);
}

function deletePricingEntry(db, leadId, id) {
  const lid = Number(leadId);
  const row = getRawEntry(db, lid, id);
  if (!row) throw fail('NOT_FOUND', 'Pricing entry not found', 404);
  db.prepare('DELETE FROM pricing_entries WHERE id = ? AND lead_id = ?').run(row.id, lid);
  return { deleted: true, id: row.id };
}

module.exports = {
  PRICE_MODES,
  LINKED_TYPES,
  PRICE_BOOK_CHAT_HEADER,
  ensureTables,
  listPricingEntries,
  getPricingEntry,
  createPricingEntry,
  updatePricingEntry,
  deletePricingEntry,
  setPricingEntryPrice,
  getPriceBook,
  publicPricingPayload,
  priceBookChatText,
  listLinkables,
  pricingSummary,
};
