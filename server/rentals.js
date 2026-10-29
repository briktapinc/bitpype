'use strict';

/**
 * Site Rentals — "Rent to Lead" (Batch 26).
 *
 * A rental is a LINK between an existing Lead (the tenant — the renting
 * business) and an existing Website (the rented niche site), with the
 * commercial terms on the link. It is NOT a flag on either side, and it
 * never writes to the tenant's own website fields: the email↔lead
 * uniqueness law and the lead↔own-website binding are untouched.
 *
 * While a rental is live (status trial | active):
 *   - Call tracking: the site's calltracking redirect_number is the
 *     TENANT's phone (the forward-TO destination — the Twilio tracking
 *     number stays the displayed/dialed number, per Batch 25c), written
 *     into the site OWNER's calltracking config at activation with the
 *     previous values snapshotted on the rental row and restored when
 *     the rental ends or pauses.
 *   - Delivery: form alerts, booking/estimate notifications, call
 *     notification emails and chatbot lead notifications for the site
 *     resolve to the TENANT (delivery-time resolution in the callers,
 *     via deliveryLeadId / the capture stamp).
 *   - Every capture (form submission, booking, estimate, chatbot lead)
 *     and every call on the site is stamped website_id + tenant_lead_id
 *     + rental_id at capture time. The stamp is a snapshot: it survives
 *     the rental ending and is never rewritten, so the old tenant keeps
 *     their history (read-only) and a new tenant only ever sees their
 *     own site leads.
 *
 * Billing:
 *   - flat: tracked + reported only — no credit machinery in v1.
 *   - per_lead: a qualified site lead = one stamped capture (form /
 *     booking / estimate / chatbot) or one answered call ≥15s (the
 *     call_logs.counted rule from Batch 21). Each qualified lead gets
 *     exactly one site_rental_charges row (unique per source row) —
 *     the stamped charges ARE the invoice. Trial leads are consumed
 *     first; after that, each lead debits credits at the rental's
 *     $/lead ($1 = 1 credit, so per-lead prices are whole dollars)
 *     through the platform credits engine, reason 'Rental site lead'.
 *     SOFT, like call billing: delivery NEVER stops for billing — when
 *     the balance can't cover a lead, the charge flips to 'due' and
 *     the amount accrues on the rental, visible in admin + portal.
 *
 * All db-level functions take the workspace better-sqlite3 handle (the
 * seoTool/portalContacts pattern); workspace-level orchestrators
 * (create/end with emails, charge settlement) lazy-require domain /
 * credits / mailer so this module stays loadable in isolation.
 */

const LIVE_STATUSES = ['trial', 'active'];

function fail(code, message, status = 400) {
  const e = new Error(message);
  e.code = code;
  e.status = status;
  return e;
}

function isLiveStatus(status) {
  return LIVE_STATUSES.includes(String(status || ''));
}

function ensureRentals(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS site_rentals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      website_id INTEGER NOT NULL,
      tenant_lead_id INTEGER NOT NULL,
      owner_lead_id INTEGER NOT NULL DEFAULT 0,
      model TEXT NOT NULL DEFAULT 'per_lead',
      price_cents INTEGER NOT NULL DEFAULT 0,
      trial_leads INTEGER NOT NULL DEFAULT 0,
      trial_used INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      start_at TEXT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at TEXT,
      end_reason TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL DEFAULT '',
      prev_redirect_number TEXT,
      prev_redirect_enabled INTEGER,
      applied_redirect_number TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_site_rentals_one_live
      ON site_rentals(website_id) WHERE status IN ('trial', 'active');
    CREATE INDEX IF NOT EXISTS idx_site_rentals_tenant
      ON site_rentals(tenant_lead_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_site_rentals_site
      ON site_rentals(website_id, id DESC);

    CREATE TABLE IF NOT EXISTS site_rental_charges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rental_id INTEGER NOT NULL,
      website_id INTEGER NOT NULL,
      tenant_lead_id INTEGER NOT NULL,
      source_kind TEXT NOT NULL DEFAULT 'capture',
      event_id INTEGER,
      chatbot_lead_id INTEGER,
      call_log_id INTEGER,
      contact_label TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      credits_debited INTEGER NOT NULL DEFAULT 0,
      amount_due_cents INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      settled_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_rental_charges_event
      ON site_rental_charges(event_id) WHERE event_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_rental_charges_chatbot
      ON site_rental_charges(chatbot_lead_id) WHERE chatbot_lead_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_rental_charges_call
      ON site_rental_charges(call_log_id) WHERE call_log_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_rental_charges_rental
      ON site_rental_charges(rental_id, id);
  `);
}

// ---------- lookups ----------

function leadRow(db, leadId) {
  try {
    return db.prepare('SELECT * FROM leads WHERE id = ?').get(Number(leadId)) || null;
  } catch {
    return null;
  }
}

/** A lead's own website (latest row, matching seoSiteForLead). */
function websiteForLead(db, leadId) {
  try {
    return (
      db
        .prepare('SELECT * FROM websites WHERE lead_id = ? ORDER BY id DESC LIMIT 1')
        .get(Number(leadId)) || null
    );
  } catch {
    return null;
  }
}

function websiteRow(db, websiteId) {
  try {
    return db.prepare('SELECT * FROM websites WHERE id = ?').get(Number(websiteId)) || null;
  } catch {
    return null;
  }
}

function getRental(db, rentalId) {
  ensureRentals(db);
  return db.prepare('SELECT * FROM site_rentals WHERE id = ?').get(Number(rentalId)) || null;
}

function liveRentalForWebsite(db, websiteId) {
  ensureRentals(db);
  return (
    db
      .prepare(
        `SELECT * FROM site_rentals
          WHERE website_id = ? AND status IN ('trial', 'active')
          ORDER BY id DESC LIMIT 1`
      )
      .get(Number(websiteId)) || null
  );
}

/** The live rental on the site OWNED by this lead, if any. */
function liveRentalForLead(db, ownerLeadId) {
  const site = websiteForLead(db, ownerLeadId);
  if (!site) return null;
  return liveRentalForWebsite(db, site.id);
}

/**
 * The capture stamp for anything created on the site owned by
 * ownerLeadId right now: website always (when the lead has a site),
 * tenant + rental only while a rental is live. Never throws — a
 * stamping failure must never break a visitor capture.
 */
function resolveStamp(db, ownerLeadId) {
  const empty = { websiteId: null, tenantLeadId: null, rentalId: null };
  try {
    ensureRentals(db);
    const leadId = Number(ownerLeadId);
    if (!Number.isInteger(leadId) || leadId <= 0) return empty;
    const site = websiteForLead(db, leadId);
    if (!site) return empty;
    const rental = liveRentalForWebsite(db, site.id);
    if (!rental) return { websiteId: Number(site.id), tenantLeadId: null, rentalId: null };
    return {
      websiteId: Number(site.id),
      tenantLeadId: Number(rental.tenant_lead_id),
      rentalId: Number(rental.id),
    };
  } catch {
    return empty;
  }
}

/** Who should receive the site's delivery right now (tenant when rented). */
function deliveryLeadId(db, ownerLeadId) {
  const stamp = resolveStamp(db, ownerLeadId);
  return stamp.tenantLeadId || Number(ownerLeadId);
}

/**
 * The tenant's alert email: the form-alert chain for the tenant lead
 * (their first form's notify_email → their lead email), reusing
 * callNotify.resolveNotifyRecipient. Falls back to the lead email.
 */
function tenantAlertEmail(db, tenantLeadId) {
  try {
    const { resolveNotifyRecipient } = require('./callNotify');
    const resolved = resolveNotifyRecipient(db, Number(tenantLeadId));
    if (resolved) return resolved;
  } catch {
    /* fall through */
  }
  const lead = leadRow(db, tenantLeadId);
  return lead ? String(lead.email || '').trim() : '';
}

// ---------- niche / town conflict ----------

function normKey(v) {
  return String(v || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/** A site's niche + town: industry (or owner category) + owner city. */
function siteNicheTown(db, websiteId) {
  const site = websiteRow(db, websiteId);
  if (!site) return { niche: '', town: '' };
  const owner = site.lead_id ? leadRow(db, site.lead_id) : null;
  return {
    niche: normKey(site.industry || (owner && owner.category) || ''),
    town: normKey((owner && owner.city) || ''),
  };
}

/**
 * Other LIVE rentals whose site shares this site's niche + town.
 * A warning, never a block (the create caller decides on override).
 */
function findConflicts(db, websiteId) {
  ensureRentals(db);
  const target = siteNicheTown(db, websiteId);
  if (!target.niche || !target.town) return [];
  const rows = db
    .prepare(
      `SELECT * FROM site_rentals
        WHERE status IN ('trial', 'active') AND website_id <> ?
        ORDER BY id DESC`
    )
    .all(Number(websiteId));
  const out = [];
  for (const r of rows) {
    const nt = siteNicheTown(db, r.website_id);
    if (nt.niche && nt.town && nt.niche === target.niche && nt.town === target.town) {
      const tenant = leadRow(db, r.tenant_lead_id);
      const site = websiteRow(db, r.website_id);
      out.push({
        rental_id: Number(r.id),
        website_id: Number(r.website_id),
        site_name: site ? site.name || '' : '',
        tenant_lead_id: Number(r.tenant_lead_id),
        tenant_name: tenant ? tenant.business_name || '' : '',
        niche: target.niche,
        town: target.town,
      });
    }
  }
  return out;
}

// ---------- call tracking routing (activation / un-route) ----------

/**
 * Point the site's call forwarding at the tenant. Writes ONLY the
 * redirect (forward-TO) destination on the OWNER's calltracking
 * config — the Twilio tracking number stays the displayed number
 * (Batch 25c). Previous values are snapshotted on the rental row at
 * first activation. Never creates a config row: if the owner has no
 * calltracking module yet there is nothing to write. Never throws.
 */
function activateRental(db, rental) {
  const out = { callRouting: 'skipped', reason: '' };
  try {
    ensureRentals(db);
    const ownerLeadId = Number(rental.owner_lead_id);
    const tenant = leadRow(db, rental.tenant_lead_id);
    if (!tenant || !String(tenant.phone || '').trim()) {
      out.reason = 'tenant_no_phone';
      return out;
    }
    const hasCfg = db
      .prepare('SELECT lead_id FROM calltracking_configs WHERE lead_id = ?')
      .get(ownerLeadId);
    if (!hasCfg) {
      out.reason = 'no_calltracking_config';
      return out;
    }
    const modules = require('./siteModules');
    let phone = '';
    try {
      phone = modules.normalizeE164(tenant.phone, 'Tenant phone');
    } catch {
      out.reason = 'tenant_phone_invalid';
      return out;
    }
    if (rental.prev_redirect_number == null) {
      const cfg = modules.getCallTrackingConfig(db, ownerLeadId);
      db.prepare(
        `UPDATE site_rentals
            SET prev_redirect_number = ?, prev_redirect_enabled = ?, updated_at = datetime('now')
          WHERE id = ?`
      ).run(cfg.redirect_number || '', cfg.redirect_enabled ? 1 : 0, Number(rental.id));
    }
    modules.updateCallTrackingConfig(db, ownerLeadId, {
      redirect_number: phone,
      redirect_enabled: true,
    });
    db.prepare(
      `UPDATE site_rentals SET applied_redirect_number = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(phone, Number(rental.id));
    out.callRouting = 'written';
    out.redirect_number = phone;
    return out;
  } catch (e) {
    out.reason = 'error';
    out.error = e && e.message ? e.message : String(e);
    return out;
  }
}

/**
 * Hand call forwarding back to the site owner: restore the snapshotted
 * redirect values, but only when the current destination is still the
 * tenant number activation wrote (an admin may have changed it since —
 * their change wins). Never throws.
 */
function unrouteRental(db, rental) {
  const out = { restored: false, reason: '' };
  try {
    ensureRentals(db);
    if (!rental.applied_redirect_number) {
      out.reason = 'nothing_applied';
      return out;
    }
    const ownerLeadId = Number(rental.owner_lead_id);
    const cfg = db
      .prepare('SELECT * FROM calltracking_configs WHERE lead_id = ?')
      .get(ownerLeadId);
    if (cfg && String(cfg.redirect_number || '') === String(rental.applied_redirect_number)) {
      if (rental.prev_redirect_number != null) {
        db.prepare(
          `UPDATE calltracking_configs
              SET redirect_number = ?, redirect_enabled = ?, updated_at = datetime('now')
            WHERE lead_id = ?`
        ).run(
          String(rental.prev_redirect_number || ''),
          rental.prev_redirect_enabled ? 1 : 0,
          ownerLeadId
        );
        out.restored = true;
      }
    } else {
      out.reason = 'redirect_changed_since_activation';
    }
    db.prepare(
      `UPDATE site_rentals SET applied_redirect_number = NULL, updated_at = datetime('now') WHERE id = ?`
    ).run(Number(rental.id));
    return out;
  } catch (e) {
    out.reason = 'error';
    out.error = e && e.message ? e.message : String(e);
    return out;
  }
}

// ---------- create / end / pause / resume (db level) ----------

function createRentalRow(db, input = {}, { createdBy = '' } = {}) {
  ensureRentals(db);
  const websiteId = Number(input.websiteId != null ? input.websiteId : input.website_id);
  const tenantLeadId = Number(input.tenantLeadId != null ? input.tenantLeadId : input.tenant_lead_id);
  if (!Number.isInteger(websiteId) || websiteId <= 0) throw fail('VALIDATION', 'websiteId is required');
  if (!Number.isInteger(tenantLeadId) || tenantLeadId <= 0) {
    throw fail('VALIDATION', 'tenantLeadId is required');
  }
  const site = websiteRow(db, websiteId);
  if (!site) throw fail('NOT_FOUND', 'Website not found', 404);
  const tenant = leadRow(db, tenantLeadId);
  if (!tenant) throw fail('NOT_FOUND', 'Tenant lead not found', 404);
  const ownerLeadId = Number(site.lead_id || 0);
  if (!ownerLeadId) throw fail('VALIDATION', 'That website has no owner lead to rent from');
  if (tenantLeadId === ownerLeadId) {
    throw fail('VALIDATION', 'A business cannot rent its own website');
  }
  const model = String(input.model || 'per_lead').trim().toLowerCase();
  if (model !== 'flat' && model !== 'per_lead') {
    throw fail('VALIDATION', "model must be 'flat' or 'per_lead'");
  }
  const priceCents = Number(input.priceCents != null ? input.priceCents : input.price_cents);
  if (!Number.isInteger(priceCents) || priceCents < 0) {
    throw fail('VALIDATION', 'priceCents must be a non-negative integer (cents)');
  }
  if (model === 'per_lead') {
    if (priceCents <= 0) throw fail('VALIDATION', 'A per-lead rental needs a price per lead');
    if (priceCents % 100 !== 0) {
      throw fail(
        'VALIDATION',
        'Per-lead price must be whole dollars — site leads are charged in credits at $1 = 1 credit'
      );
    }
  }
  const trialLeadsRaw = Number(input.trialLeads != null ? input.trialLeads : input.trial_leads || 0);
  const trialLeads = Number.isFinite(trialLeadsRaw) ? Math.max(0, Math.min(10000, Math.floor(trialLeadsRaw))) : 0;
  const occupied = liveRentalForWebsite(db, websiteId);
  if (occupied) {
    const e = fail(
      'RENTAL_SITE_OCCUPIED',
      'That website already has a live rental — end it before renting the site again',
      409
    );
    e.existingRentalId = Number(occupied.id);
    e.details = { existingRentalId: Number(occupied.id) };
    throw e;
  }
  const conflicts = findConflicts(db, websiteId);
  const override = !!(input.overrideConflict || input.override_conflict);
  if (conflicts.length && !override) {
    const e = fail(
      'RENTAL_CONFLICT',
      'Another live rental already covers this niche in this town — confirm to create anyway',
      409
    );
    e.conflicts = conflicts;
    e.details = { conflicts };
    throw e;
  }
  const startAt =
    input.startAt || input.start_at
      ? String(input.startAt || input.start_at).slice(0, 40)
      : null;
  const status = trialLeads > 0 ? 'trial' : 'active';
  const info = db
    .prepare(
      `INSERT INTO site_rentals
         (website_id, tenant_lead_id, owner_lead_id, model, price_cents, trial_leads,
          status, start_at, started_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), ?)`
    )
    .run(
      websiteId,
      tenantLeadId,
      ownerLeadId,
      model,
      priceCents,
      trialLeads,
      status,
      startAt,
      startAt,
      String(createdBy || '').slice(0, 80)
    );
  const rental = getRental(db, info.lastInsertRowid);
  const activation = activateRental(db, rental);
  return { rental: getRental(db, rental.id), activation, warnings: override ? conflicts : [] };
}

function endRentalRow(db, rentalId, { reason = '' } = {}) {
  ensureRentals(db);
  const rental = getRental(db, rentalId);
  if (!rental) throw fail('NOT_FOUND', 'Rental not found', 404);
  if (rental.status === 'ended') return { rental, unroute: { restored: false, reason: 'already_ended' } };
  const unroute = unrouteRental(db, rental);
  db.prepare(
    `UPDATE site_rentals
        SET status = 'ended', ended_at = datetime('now'), end_reason = ?, updated_at = datetime('now')
      WHERE id = ?`
  ).run(String(reason || '').slice(0, 300), Number(rental.id));
  return { rental: getRental(db, rental.id), unroute };
}

/**
 * Batch 51 — hard-delete an ENDED rental record (the clear-all path for
 * historical rentals; there is no single-delete UI). Live rentals
 * (trial/active) are NEVER deleted here — ending one unroutes the site
 * first, and that stays the End action's job. A paused rental is not
 * history yet either. A rental whose charges still carry money in
 * flight (status 'pending' or 'due') keeps its record — the charge
 * ledger must not vanish under an outstanding balance. Settled charge
 * rows (charged/trial) are the rental's own history and go with it.
 */
function deleteEndedRental(db, rentalId) {
  ensureRentals(db);
  const rental = getRental(db, rentalId);
  if (!rental) throw fail('NOT_FOUND', 'Rental not found', 404);
  if (isLiveStatus(rental.status)) {
    throw fail('RENTAL_ACTIVE', 'Active rental — end it before it can be removed.', 409);
  }
  if (rental.status !== 'ended') {
    throw fail('RENTAL_NOT_ENDED', `Only an ended rental can be removed (this one is ${rental.status}).`, 409);
  }
  const open = db
    .prepare(
      `SELECT COUNT(*) AS c FROM site_rental_charges WHERE rental_id = ? AND status IN ('pending', 'due')`
    )
    .get(Number(rental.id));
  if (open && Number(open.c) > 0) {
    throw fail('RENTAL_CHARGES_OPEN', 'This rental still has unsettled charges and cannot be removed.', 409);
  }
  db.prepare('DELETE FROM site_rental_charges WHERE rental_id = ?').run(Number(rental.id));
  db.prepare('DELETE FROM site_rentals WHERE id = ?').run(Number(rental.id));
  return { deleted: true, id: Number(rental.id) };
}

function pauseRentalRow(db, rentalId) {
  ensureRentals(db);
  const rental = getRental(db, rentalId);
  if (!rental) throw fail('NOT_FOUND', 'Rental not found', 404);
  if (!isLiveStatus(rental.status)) {
    throw fail('VALIDATION', `Only a live rental can be paused (this one is ${rental.status})`);
  }
  const unroute = unrouteRental(db, rental);
  db.prepare(
    `UPDATE site_rentals SET status = 'paused', updated_at = datetime('now') WHERE id = ?`
  ).run(Number(rental.id));
  return { rental: getRental(db, rental.id), unroute };
}

function resumeRentalRow(db, rentalId) {
  ensureRentals(db);
  const rental = getRental(db, rentalId);
  if (!rental) throw fail('NOT_FOUND', 'Rental not found', 404);
  if (rental.status !== 'paused') {
    throw fail('VALIDATION', `Only a paused rental can be resumed (this one is ${rental.status})`);
  }
  const occupied = liveRentalForWebsite(db, rental.website_id);
  if (occupied && Number(occupied.id) !== Number(rental.id)) {
    const e = fail('RENTAL_SITE_OCCUPIED', 'Another rental is live on that website now', 409);
    e.existingRentalId = Number(occupied.id);
    e.details = { existingRentalId: Number(occupied.id) };
    throw e;
  }
  const status = Number(rental.trial_used) < Number(rental.trial_leads) ? 'trial' : 'active';
  db.prepare(
    `UPDATE site_rentals SET status = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(status, Number(rental.id));
  const fresh = getRental(db, rental.id);
  const activation = activateRental(db, fresh);
  return { rental: getRental(db, rental.id), activation };
}

// ---------- charges (the per-lead invoice) ----------

/**
 * Record one qualified site lead against the live per-lead rental on
 * the site owned by ownerLeadId. Idempotent per source row (unique
 * indexes). Returns the charge row, or null when there is nothing to
 * bill (no live rental / flat model). Never throws.
 */
function recordCaptureCharge(db, { ownerLeadId, sourceKind, eventId, chatbotLeadId, callLogId, contactLabel } = {}) {
  try {
    ensureRentals(db);
    const stamp = resolveStamp(db, ownerLeadId);
    if (!stamp.rentalId) return null;
    const rental = getRental(db, stamp.rentalId);
    if (!rental || rental.model !== 'per_lead' || !isLiveStatus(rental.status)) return null;
    return insertCharge(db, rental, {
      sourceKind,
      eventId,
      chatbotLeadId,
      callLogId,
      contactLabel,
    });
  } catch {
    return null;
  }
}

function insertCharge(db, rental, { sourceKind, eventId, chatbotLeadId, callLogId, contactLabel } = {}) {
  ensureRentals(db);
  db.prepare(
    `INSERT OR IGNORE INTO site_rental_charges
       (rental_id, website_id, tenant_lead_id, source_kind, event_id, chatbot_lead_id, call_log_id, contact_label)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    Number(rental.id),
    Number(rental.website_id),
    Number(rental.tenant_lead_id),
    String(sourceKind || 'capture').slice(0, 20),
    eventId != null ? Number(eventId) : null,
    chatbotLeadId != null ? Number(chatbotLeadId) : null,
    callLogId != null ? Number(callLogId) : null,
    String(contactLabel || '').slice(0, 200)
  );
  const key =
    eventId != null
      ? ['event_id', Number(eventId)]
      : chatbotLeadId != null
        ? ['chatbot_lead_id', Number(chatbotLeadId)]
        : ['call_log_id', Number(callLogId)];
  return (
    db.prepare(`SELECT * FROM site_rental_charges WHERE ${key[0]} = ?`).get(key[1]) || null
  );
}

function rentalCounters(db, rentalId) {
  ensureRentals(db);
  const rental = getRental(db, rentalId);
  const row = db
    .prepare(
      `SELECT COUNT(*) AS qualified,
              COALESCE(SUM(credits_debited), 0) AS charged_credits,
              COALESCE(SUM(CASE WHEN status = 'due' THEN amount_due_cents ELSE 0 END), 0) AS amount_due_cents,
              COALESCE(SUM(CASE WHEN status = 'trial' THEN 1 ELSE 0 END), 0) AS trial_charges,
              COALESCE(SUM(CASE WHEN status IN ('pending', 'charging') THEN 1 ELSE 0 END), 0) AS pending
         FROM site_rental_charges WHERE rental_id = ?`
    )
    .get(Number(rentalId));
  const month = db
    .prepare(
      `SELECT COUNT(*) AS n FROM site_rental_charges
        WHERE rental_id = ? AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')`
    )
    .get(Number(rentalId));
  return {
    qualified_leads: Number(row.qualified || 0),
    charged_credits: Number(row.charged_credits || 0),
    amount_due_cents: Number(row.amount_due_cents || 0),
    trial_used: rental ? Number(rental.trial_used || 0) : Number(row.trial_charges || 0),
    trial_leads: rental ? Number(rental.trial_leads || 0) : 0,
    pending: Number(row.pending || 0),
    this_month_leads: Number(month.n || 0),
  };
}

/**
 * Settle pending charges for a workspace: trial slots first (in
 * capture order), then a credits debit per charge. A debit that hits
 * INSUFFICIENT_CREDITS flips the charge to 'due' — delivery already
 * happened and never waits on this. Other errors leave the charge
 * pending for the next settle pass. The credits spend is idempotent
 * per charge id, so a crashed 'charging' row re-settles safely.
 */
async function settlePendingCharges(workspaceId, { rentalId = null, limit = 100 } = {}) {
  const summary = { processed: 0, trialed: 0, charged: 0, due: 0 };
  try {
    const domain = require('./domain');
    const credits = require('./credits');
    const ids = domain.withDb(workspaceId, (db) => {
      ensureRentals(db);
      const rows = rentalId
        ? db
            .prepare(
              `SELECT id FROM site_rental_charges
                WHERE status IN ('pending', 'charging') AND rental_id = ?
                ORDER BY id ASC LIMIT ?`
            )
            .all(Number(rentalId), Number(limit))
        : db
            .prepare(
              `SELECT id FROM site_rental_charges
                WHERE status IN ('pending', 'charging')
                ORDER BY id ASC LIMIT ?`
            )
            .all(Number(limit));
      return rows.map((r) => Number(r.id));
    });
    for (const id of ids) {
      const claim = domain.withDb(workspaceId, (db) => {
        const ch = db.prepare('SELECT * FROM site_rental_charges WHERE id = ?').get(id);
        if (!ch || (ch.status !== 'pending' && ch.status !== 'charging')) return null;
        const rental = getRental(db, ch.rental_id);
        if (!rental || rental.model !== 'per_lead') return null;
        if (Number(rental.trial_used) < Number(rental.trial_leads)) {
          db.prepare(
            `UPDATE site_rental_charges SET status = 'trial', settled_at = datetime('now') WHERE id = ?`
          ).run(id);
          const used = Number(rental.trial_used) + 1;
          db.prepare(
            `UPDATE site_rentals
                SET trial_used = ?,
                    status = CASE WHEN ? >= trial_leads AND status = 'trial' THEN 'active' ELSE status END,
                    updated_at = datetime('now')
              WHERE id = ?`
          ).run(used, used, Number(rental.id));
          return { kind: 'trial' };
        }
        db.prepare(`UPDATE site_rental_charges SET status = 'charging' WHERE id = ?`).run(id);
        return {
          kind: 'charge',
          rentalId: Number(rental.id),
          credits: Math.max(1, Math.round(Number(rental.price_cents) / 100)),
          priceCents: Number(rental.price_cents),
        };
      });
      if (!claim) continue;
      summary.processed += 1;
      if (claim.kind === 'trial') {
        summary.trialed += 1;
        continue;
      }
      try {
        await credits.spend(workspaceId, claim.credits, {
          reason: 'Rental site lead',
          refType: 'site_rental_lead',
          refId: String(id),
        });
        domain.withDb(workspaceId, (db) =>
          db
            .prepare(
              `UPDATE site_rental_charges
                  SET status = 'charged', credits_debited = ?, settled_at = datetime('now')
                WHERE id = ?`
            )
            .run(claim.credits, id)
        );
        summary.charged += 1;
      } catch (e) {
        if (e && e.code === 'INSUFFICIENT_CREDITS') {
          domain.withDb(workspaceId, (db) =>
            db
              .prepare(
                `UPDATE site_rental_charges
                    SET status = 'due', amount_due_cents = ?, settled_at = datetime('now')
                  WHERE id = ?`
              )
              .run(claim.priceCents, id)
          );
          summary.due += 1;
        } else {
          domain.withDb(workspaceId, (db) =>
            db
              .prepare(
                `UPDATE site_rental_charges SET status = 'pending' WHERE id = ? AND status = 'charging'`
              )
              .run(id)
          );
          console.warn('[rentals] charge settle failed; left pending:', e && e.message);
        }
      }
    }
  } catch (e) {
    console.warn('[rentals] settlePendingCharges failed:', e && e.message);
  }
  return summary;
}

/**
 * A call reached its terminal state: if it counted (answered ≥15s)
 * and it belongs to a rental (stamped at log time, or resolvable
 * now), record + settle its per-lead charge. Fire-and-forget safe —
 * mirrors callBilling.settleCallBilling and never throws.
 */
async function settleCallCharge(workspaceId, callSid) {
  try {
    const domain = require('./domain');
    const chargeId = domain.withDb(workspaceId, (db) => {
      ensureRentals(db);
      const call = db
        .prepare('SELECT * FROM call_logs WHERE call_sid = ?')
        .get(String(callSid || ''));
      if (!call || !call.counted) return null;
      let rentalId = call.rental_id != null ? Number(call.rental_id) : null;
      if (!rentalId) {
        const stamp = resolveStamp(db, call.lead_id);
        if (stamp.rentalId) {
          db.prepare(
            'UPDATE call_logs SET website_id = ?, tenant_lead_id = ?, rental_id = ? WHERE id = ?'
          ).run(stamp.websiteId, stamp.tenantLeadId, stamp.rentalId, Number(call.id));
          rentalId = stamp.rentalId;
        }
      }
      if (!rentalId) return null;
      const rental = getRental(db, rentalId);
      if (!rental || rental.model !== 'per_lead') return null;
      const charge = insertCharge(db, rental, {
        sourceKind: 'call',
        callLogId: Number(call.id),
        contactLabel: String(call.from_number || ''),
      });
      return charge ? Number(charge.id) : null;
    });
    if (chargeId) {
      const ch = domain.withDb(workspaceId, (db) =>
        db.prepare('SELECT rental_id FROM site_rental_charges WHERE id = ?').get(chargeId)
      );
      await settlePendingCharges(workspaceId, { rentalId: ch ? Number(ch.rental_id) : null });
    }
    return { settled: !!chargeId };
  } catch (e) {
    console.warn('[rentals] settleCallCharge failed:', e && e.message);
    return { settled: false, reason: 'error' };
  }
}

// ---------- views ----------

function siteUrl(site) {
  if (!site) return '';
  if (site.custom_domain) return `https://${site.custom_domain}`;
  return String(site.preview_url || '');
}

function rentalView(db, row) {
  if (!row) return null;
  const site = websiteRow(db, row.website_id);
  const owner = row.owner_lead_id ? leadRow(db, row.owner_lead_id) : null;
  const tenant = leadRow(db, row.tenant_lead_id);
  const nt = siteNicheTown(db, row.website_id);
  return {
    id: Number(row.id),
    website_id: Number(row.website_id),
    tenant_lead_id: Number(row.tenant_lead_id),
    owner_lead_id: Number(row.owner_lead_id || 0),
    model: row.model,
    price_cents: Number(row.price_cents || 0),
    trial_leads: Number(row.trial_leads || 0),
    trial_used: Number(row.trial_used || 0),
    status: row.status,
    start_at: row.start_at || null,
    started_at: row.started_at || null,
    ended_at: row.ended_at || null,
    end_reason: row.end_reason || '',
    created_by: row.created_by || '',
    created_at: row.created_at || null,
    site: site
      ? {
          id: Number(site.id),
          name: site.name || '',
          status: site.status || '',
          url: siteUrl(site),
          niche: nt.niche,
          town: nt.town,
        }
      : null,
    tenant: tenant
      ? {
          id: Number(tenant.id),
          business_name: tenant.business_name || '',
          email: tenant.email || '',
          phone: tenant.phone || '',
        }
      : null,
    owner: owner ? { id: Number(owner.id), business_name: owner.business_name || '' } : null,
    counters: rentalCounters(db, row.id),
  };
}

function listRentals(db, { websiteId = null, tenantLeadId = null, status = null, limit = 200 } = {}) {
  ensureRentals(db);
  const where = [];
  const args = [];
  if (websiteId != null) {
    where.push('website_id = ?');
    args.push(Number(websiteId));
  }
  if (tenantLeadId != null) {
    where.push('tenant_lead_id = ?');
    args.push(Number(tenantLeadId));
  }
  if (status) {
    where.push('status = ?');
    args.push(String(status));
  }
  const rows = db
    .prepare(
      `SELECT * FROM site_rentals ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY id DESC LIMIT ?`
    )
    .all(...args, Math.max(1, Math.min(500, Number(limit) || 200)));
  return rows.map((r) => rentalView(db, r));
}

/**
 * The tenant-facing "site leads" history for one rental: every stamped
 * capture / chatbot lead / call, newest first, each with its charge
 * outcome when the rental bills per lead. This is the frozen history —
 * it reads purely off the stamps, so it survives the rental ending.
 */
function tenantSiteLeads(db, rentalId, { limit = 100 } = {}) {
  ensureRentals(db);
  const rid = Number(rentalId);
  const lim = Math.max(1, Math.min(500, Number(limit) || 100));
  const charges = db.prepare('SELECT * FROM site_rental_charges WHERE rental_id = ?').all(rid);
  const byEvent = new Map();
  const byChatbot = new Map();
  const byCall = new Map();
  for (const ch of charges) {
    const slim = {
      status: ch.status,
      credits: Number(ch.credits_debited || 0),
      amount_due_cents: Number(ch.amount_due_cents || 0),
    };
    if (ch.event_id != null) byEvent.set(Number(ch.event_id), slim);
    if (ch.chatbot_lead_id != null) byChatbot.set(Number(ch.chatbot_lead_id), slim);
    if (ch.call_log_id != null) byCall.set(Number(ch.call_log_id), slim);
  }
  const out = [];
  try {
    const events = db
      .prepare(
        `SELECT e.id, e.kind, e.created_at, e.source_label,
                COALESCE(NULLIF(c.name, ''), NULLIF(c.email, ''), NULLIF(c.phone, ''), '') AS label
           FROM leadscout_events e
           LEFT JOIN leadscout_contacts c ON c.id = e.contact_id
          WHERE e.rental_id = ? AND e.kind IN ('submission', 'appointment', 'estimate')
          ORDER BY e.id DESC LIMIT ?`
      )
      .all(rid, lim);
    for (const e of events) {
      out.push({
        at: e.created_at,
        source: e.kind === 'submission' ? 'form' : e.kind,
        source_label: e.source_label || '',
        label: e.label || '',
        charge: byEvent.get(Number(e.id)) || null,
      });
    }
  } catch {
    /* table may not exist in a bare fixture */
  }
  try {
    const chats = db
      .prepare(
        `SELECT id, created_at, name, email, phone FROM chatbot_leads WHERE rental_id = ? ORDER BY id DESC LIMIT ?`
      )
      .all(rid, lim);
    for (const c of chats) {
      out.push({
        at: c.created_at,
        source: 'chatbot',
        source_label: 'Website chat',
        label: c.name || c.email || c.phone || '',
        charge: byChatbot.get(Number(c.id)) || null,
      });
    }
  } catch {
    /* ignore */
  }
  try {
    const calls = db
      .prepare(
        `SELECT id, created_at, from_number, status, duration_seconds FROM call_logs WHERE rental_id = ? ORDER BY id DESC LIMIT ?`
      )
      .all(rid, lim);
    for (const c of calls) {
      out.push({
        at: c.created_at,
        source: 'call',
        source_label: 'Call',
        label: c.from_number || '',
        charge: byCall.get(Number(c.id)) || null,
      });
    }
  } catch {
    /* ignore */
  }
  out.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  return out.slice(0, lim);
}

function rentalDetail(db, rentalId) {
  ensureRentals(db);
  const rental = getRental(db, rentalId);
  if (!rental) throw fail('NOT_FOUND', 'Rental not found', 404);
  const charges = db
    .prepare('SELECT * FROM site_rental_charges WHERE rental_id = ? ORDER BY id DESC LIMIT 200')
    .all(Number(rentalId))
    .map((ch) => ({
      id: Number(ch.id),
      source_kind: ch.source_kind,
      contact_label: ch.contact_label || '',
      status: ch.status,
      credits_debited: Number(ch.credits_debited || 0),
      amount_due_cents: Number(ch.amount_due_cents || 0),
      created_at: ch.created_at,
      settled_at: ch.settled_at || null,
    }));
  return {
    rental: rentalView(db, rental),
    charges,
    history: tenantSiteLeads(db, rentalId),
  };
}

/** Portal tenant view: my rentals (live + ended), my site leads, dues. */
function tenantView(db, tenantLeadId) {
  ensureRentals(db);
  const rows = db
    .prepare('SELECT * FROM site_rentals WHERE tenant_lead_id = ? ORDER BY id DESC LIMIT 50')
    .all(Number(tenantLeadId));
  return rows.map((r) => {
    const view = rentalView(db, r);
    view.history = tenantSiteLeads(db, r.id, { limit: 50 });
    const month = db
      .prepare(
        `SELECT COUNT(*) AS n,
                COALESCE(SUM(credits_debited), 0) AS credits,
                COALESCE(SUM(CASE WHEN status = 'due' THEN amount_due_cents ELSE 0 END), 0) AS due
           FROM site_rental_charges
          WHERE rental_id = ? AND created_at >= date('now', 'start of month')`
      )
      .get(Number(r.id));
    view.this_month = {
      qualified_leads: Number(month.n || 0),
      credits_charged: Number(month.credits || 0),
      amount_due_cents: Number(month.due || 0),
    };
    return view;
  });
}

/** Staff Rentals screen data: rentals + picker lists. */
function screenData(db) {
  ensureRentals(db);
  const rentals = listRentals(db, { limit: 200 });
  let sites = [];
  let leads = [];
  try {
    sites = db
      .prepare(
        `SELECT w.id, w.name, w.status, w.lead_id, w.industry,
                l.business_name AS owner_business, l.category AS owner_category, l.city AS owner_city
           FROM websites w LEFT JOIN leads l ON l.id = w.lead_id
          ORDER BY w.id DESC LIMIT 300`
      )
      .all();
  } catch {
    sites = [];
  }
  try {
    leads = db
      .prepare(
        `SELECT id, business_name, category, city, email, phone FROM leads ORDER BY business_name ASC LIMIT 500`
      )
      .all();
  } catch {
    leads = [];
  }
  return { rentals, sites, leads };
}

// ---------- emails + workspace-level orchestration ----------

function money(cents) {
  const n = Number(cents);
  if (!Number.isFinite(n)) return '';
  return `$${(n / 100).toFixed(2)}`;
}

async function sendRentalEmail(workspaceId, rentalId, kind) {
  try {
    const domain = require('./domain');
    const mailer = require('./mailer');
    const { appUrl } = require('./stripeClient');
    const data = domain.withDb(workspaceId, (db) => {
      const rental = getRental(db, rentalId);
      if (!rental) return null;
      const view = rentalView(db, rental);
      const tenant = leadRow(db, rental.tenant_lead_id);
      return { view, tenantEmail: tenant ? String(tenant.email || '').trim() : '' };
    });
    if (!data || !data.tenantEmail) return { sent: false, reason: 'no_tenant_email' };
    const { view } = data;
    const siteName = (view.site && view.site.name) || 'your rented site';
    const siteUrl = (view.site && view.site.url) || '';
    const portal = `${String(appUrl() || '').replace(/\/$/, '')}/portal`;
    let subject;
    let paragraphs;
    if (kind === 'ended') {
      subject = `Your rental of ${siteName} has ended`;
      paragraphs = [
        `Your rental of ${siteName} has ended${view.end_reason ? ` (${view.end_reason})` : ''}. The site's calls and messages now go back to the site owner.`,
        `Final counts: ${view.counters.qualified_leads} site lead(s) delivered, ${view.counters.trial_used} on trial, ${view.counters.charged_credits} credit(s) charged${view.counters.amount_due_cents ? `, ${money(view.counters.amount_due_cents)} still due` : ''}.`,
        'Your site-lead history stays available in your portal, read-only.',
      ];
    } else {
      subject = 'Your site is live';
      paragraphs = [
        `${siteName} is now rented to you${siteUrl ? `: ${siteUrl}` : ''}.`,
        'Calls to the site\u2019s number forward to your phone, and form submissions, bookings and chat leads from the site are delivered to you.',
        view.model === 'per_lead'
          ? `Billing: your first ${view.trial_leads} site lead(s) are free; after that each site lead is ${money(view.price_cents)}, charged in Bit Credits. Delivery never stops — if credits run out, the balance shows as an amount due in your portal.`
          : `Billing: this rental is a flat ${money(view.price_cents)} per month, tracked on your account.`,
      ];
    }
    await mailer.sendPlatformMail({
      to: data.tenantEmail,
      subject,
      title: subject,
      paragraphs,
      text: paragraphs.join('\n'),
      cta: { label: 'View your rented site in your portal', url: portal },
    });
    return { sent: true };
  } catch (e) {
    if (e && e.code === 'SMTP_NOT_CONFIGURED') return { sent: false, reason: 'mail_not_configured' };
    console.warn('[rentals] email failed:', e && e.message);
    return { sent: false, reason: 'send_failed' };
  }
}

async function createRental(workspaceId, input = {}, { createdBy = '' } = {}) {
  const domain = require('./domain');
  const created = domain.withDb(workspaceId, (db) => createRentalRow(db, input, { createdBy }));
  const view = domain.withDb(workspaceId, (db) => rentalView(db, created.rental));
  const email = await sendRentalEmail(workspaceId, created.rental.id, 'activated');
  return { rental: view, activation: created.activation, warnings: created.warnings, email };
}

async function endRental(workspaceId, rentalId, { reason = '' } = {}) {
  const domain = require('./domain');
  const ended = domain.withDb(workspaceId, (db) => endRentalRow(db, rentalId, { reason }));
  // A lead captured just before the end may still be settling.
  await settlePendingCharges(workspaceId, { rentalId: Number(rentalId) });
  const view = domain.withDb(workspaceId, (db) => rentalView(db, ended.rental));
  const email = await sendRentalEmail(workspaceId, rentalId, 'ended');
  return { rental: view, unroute: ended.unroute, email };
}

function pauseRental(workspaceId, rentalId) {
  const domain = require('./domain');
  const out = domain.withDb(workspaceId, (db) => pauseRentalRow(db, rentalId));
  return { rental: domain.withDb(workspaceId, (db) => rentalView(db, out.rental)), unroute: out.unroute };
}

function resumeRental(workspaceId, rentalId) {
  const domain = require('./domain');
  const out = domain.withDb(workspaceId, (db) => resumeRentalRow(db, rentalId));
  return {
    rental: domain.withDb(workspaceId, (db) => rentalView(db, out.rental)),
    activation: out.activation,
  };
}

module.exports = {
  LIVE_STATUSES,
  isLiveStatus,
  ensureRentals,
  leadRow,
  websiteForLead,
  websiteRow,
  getRental,
  liveRentalForWebsite,
  liveRentalForLead,
  resolveStamp,
  deliveryLeadId,
  tenantAlertEmail,
  siteNicheTown,
  findConflicts,
  activateRental,
  unrouteRental,
  createRentalRow,
  endRentalRow,
  deleteEndedRental,
  pauseRentalRow,
  resumeRentalRow,
  recordCaptureCharge,
  insertCharge,
  rentalCounters,
  settlePendingCharges,
  settleCallCharge,
  rentalView,
  listRentals,
  tenantSiteLeads,
  rentalDetail,
  tenantView,
  screenData,
  createRental,
  endRental,
  pauseRental,
  resumeRental,
};
