'use strict';

/**
 * LeadScout — portal CRM for form + booking contacts (workspace DB).
 * Dedupe by email OR phone across all sites in the workspace.
 */

const submissionCopies = require('./submissionCopies');

function fail(code, message, status = 400) {
  const e = new Error(message);
  e.code = code;
  e.status = status;
  return e;
}

function ensureTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS leadscout_contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      email_norm TEXT NOT NULL DEFAULT '',
      phone_norm TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_leadscout_email ON leadscout_contacts(email_norm);
    CREATE INDEX IF NOT EXISTS idx_leadscout_phone ON leadscout_contacts(phone_norm);

    CREATE TABLE IF NOT EXISTS leadscout_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id INTEGER NOT NULL,
      lead_id INTEGER,
      kind TEXT NOT NULL,
      source_label TEXT NOT NULL DEFAULT '',
      page_slug TEXT NOT NULL DEFAULT '',
      form_id INTEGER,
      submission_id INTEGER,
      booking_id INTEGER,
      payload_json TEXT,
      status TEXT NOT NULL DEFAULT '',
      starts_at TEXT,
      service_name TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(contact_id) REFERENCES leadscout_contacts(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_leadscout_events_contact ON leadscout_events(contact_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_leadscout_events_lead ON leadscout_events(lead_id, id DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_leadscout_sub_unique
      ON leadscout_events(submission_id) WHERE submission_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_leadscout_book_unique
      ON leadscout_events(booking_id) WHERE booking_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS leadscout_capture_failures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      lead_id INTEGER,
      ref_id INTEGER,
      error TEXT NOT NULL DEFAULT '',
      payload_json TEXT,
      retries INTEGER NOT NULL DEFAULT 0,
      resolved_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_leadscout_failures_open
      ON leadscout_capture_failures(resolved_at, id DESC);
  `);
  // Instant Estimate requests reference their row the same way bookings do.
  try {
    const cols = db
      .prepare('PRAGMA table_info(leadscout_events)')
      .all()
      .map((c) => String(c.name || ''));
    if (!cols.includes('estimate_request_id')) {
      db.exec('ALTER TABLE leadscout_events ADD COLUMN estimate_request_id INTEGER');
    }
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_leadscout_estimate_unique
       ON leadscout_events(estimate_request_id) WHERE estimate_request_id IS NOT NULL`
    );
  } catch {
    /* race / exists */
  }
  // Call Tracking calls reference their call_logs row the same way.
  try {
    const cols = db
      .prepare('PRAGMA table_info(leadscout_events)')
      .all()
      .map((c) => String(c.name || ''));
    if (!cols.includes('call_log_id')) {
      db.exec('ALTER TABLE leadscout_events ADD COLUMN call_log_id INTEGER');
    }
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_leadscout_call_unique
       ON leadscout_events(call_log_id) WHERE call_log_id IS NOT NULL`
    );
  } catch {
    /* race / exists */
  }
  // Batch 118: Newsletter signups reference their subscriber row the
  // same way (one capture event per subscriber, deduped by the index).
  try {
    const cols = db
      .prepare('PRAGMA table_info(leadscout_events)')
      .all()
      .map((c) => String(c.name || ''));
    if (!cols.includes('newsletter_subscriber_id')) {
      db.exec('ALTER TABLE leadscout_events ADD COLUMN newsletter_subscriber_id INTEGER');
    }
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_leadscout_newsletter_unique
       ON leadscout_events(newsletter_subscriber_id) WHERE newsletter_subscriber_id IS NOT NULL`
    );
  } catch {
    /* race / exists */
  }
  // Batch 125: Photo Capture submissions reference their submission
  // row the same way (one capture event per submission, deduped by
  // the index).
  try {
    const cols = db
      .prepare('PRAGMA table_info(leadscout_events)')
      .all()
      .map((c) => String(c.name || ''));
    if (!cols.includes('photo_submission_id')) {
      db.exec('ALTER TABLE leadscout_events ADD COLUMN photo_submission_id INTEGER');
    }
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_leadscout_photo_unique
       ON leadscout_events(photo_submission_id) WHERE photo_submission_id IS NOT NULL`
    );
  } catch {
    /* race / exists */
  }
  // Batch 131: Comments reference their module_comments row the same
  // way (one capture event per comment, deduped by the index).
  try {
    const cols = db
      .prepare('PRAGMA table_info(leadscout_events)')
      .all()
      .map((c) => String(c.name || ''));
    if (!cols.includes('comment_id')) {
      db.exec('ALTER TABLE leadscout_events ADD COLUMN comment_id INTEGER');
    }
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_leadscout_comment_unique
       ON leadscout_events(comment_id) WHERE comment_id IS NOT NULL`
    );
  } catch {
    /* race / exists */
  }
  // Batch 163: Webinar registrations reference their platform
  // webinar_registrations row the same way (one capture event per
  // registration, deduped by the index).
  try {
    const cols = db
      .prepare('PRAGMA table_info(leadscout_events)')
      .all()
      .map((c) => String(c.name || ''));
    if (!cols.includes('webinar_registration_id')) {
      db.exec('ALTER TABLE leadscout_events ADD COLUMN webinar_registration_id INTEGER');
    }
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_leadscout_webinar_unique
       ON leadscout_events(webinar_registration_id) WHERE webinar_registration_id IS NOT NULL`
    );
  } catch {
    /* race / exists */
  }
  // Batch 178: Leads Router claims reference their router_leads row
  // the same way (one capture event per claimed router lead, deduped
  // by the index) — see captureFromRouterClaim.
  try {
    const cols = db
      .prepare('PRAGMA table_info(leadscout_events)')
      .all()
      .map((c) => String(c.name || ''));
    if (!cols.includes('router_lead_id')) {
      db.exec('ALTER TABLE leadscout_events ADD COLUMN router_lead_id INTEGER');
    }
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_leadscout_router_unique
       ON leadscout_events(router_lead_id) WHERE router_lead_id IS NOT NULL`
    );
  } catch {
    /* race / exists */
  }
  // SMS opt-in state (Batch 25): the consent record lives on the contact
  // itself — sms_opted_in + the consent timestamp + the source are the
  // business's proof of consent. sms_opted_out_at is written by any
  // future STOP/opt-out path; a contact counts as enrolled only when
  // their latest opt-in is newer than their latest opt-out.
  try {
    const cols = db
      .prepare('PRAGMA table_info(leadscout_contacts)')
      .all()
      .map((c) => String(c.name || ''));
    const addContactCol = (name, ddl) => {
      if (!cols.includes(name)) db.exec(`ALTER TABLE leadscout_contacts ADD COLUMN ${ddl}`);
    };
    addContactCol('sms_opted_in', 'sms_opted_in INTEGER NOT NULL DEFAULT 0');
    addContactCol('sms_opted_in_at', 'sms_opted_in_at TEXT');
    addContactCol('sms_opt_in_source', "sms_opt_in_source TEXT NOT NULL DEFAULT ''");
    addContactCol('sms_opted_out_at', 'sms_opted_out_at TEXT');
    addContactCol('sms_confirm_status', "sms_confirm_status TEXT NOT NULL DEFAULT ''");
    addContactCol('sms_confirm_at', 'sms_confirm_at TEXT');
    addContactCol('sms_confirm_error', "sms_confirm_error TEXT NOT NULL DEFAULT ''");
  } catch {
    /* race / exists */
  }
  // Site Rentals stamp (Batch 26): every capture carries the site it
  // came from and — while a rental is live — the tenant + rental it
  // belongs to, as a snapshot that is never rewritten.
  try {
    const cols = db
      .prepare('PRAGMA table_info(leadscout_events)')
      .all()
      .map((c) => String(c.name || ''));
    const addEventCol = (name, ddl) => {
      if (!cols.includes(name)) db.exec(`ALTER TABLE leadscout_events ADD COLUMN ${ddl}`);
    };
    addEventCol('website_id', 'website_id INTEGER');
    addEventCol('tenant_lead_id', 'tenant_lead_id INTEGER');
    addEventCol('rental_id', 'rental_id INTEGER');
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_leadscout_events_rental ON leadscout_events(rental_id, id DESC)'
    );
  } catch {
    /* race / exists */
  }
}

/** Batch 26 rental stamp + charge — lazy + guarded: stamping must
 *  never break a visitor capture. Batch 45 (B5): failures are LOGGED
 *  with context — the exactly-once guarantee comes from the rentals
 *  unique indexes, but a non-duplicate failure (missing table on an old
 *  DB, stamp mis-resolution) used to leave a qualified capture silently
 *  unbilled with no trace anywhere. Behavior is otherwise unchanged. */
function rentalStamp(db, leadId) {
  try {
    return require('./rentals').resolveStamp(db, leadId);
  } catch (e) {
    console.warn(
      `[portalContacts] rentalStamp failed for lead ${leadId}: ${(e && e.message) || e}`
    );
    return { websiteId: null, tenantLeadId: null, rentalId: null };
  }
}

function rentalCharge(db, args) {
  try {
    return require('./rentals').recordCaptureCharge(db, args);
  } catch (e) {
    console.warn(
      `[portalContacts] rentalCharge failed for lead ${args && args.ownerLeadId} event ${args && args.eventId} kind ${
        args && args.sourceKind
      }: ${(e && e.message) || e}`
    );
    return null;
  }
}

function normEmail(email) {
  return String(email || '')
    .trim()
    .toLowerCase()
    .slice(0, 240);
}

function normPhone(phone) {
  const digits = String(phone || '').replace(/\D+/g, '');
  if (digits.length < 7) return '';
  return digits.slice(-15);
}

function pickContactFields(payload = {}) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const lower = {};
  Object.keys(p).forEach((k) => {
    lower[String(k).toLowerCase()] = p[k];
  });
  const name = String(
    p.name || p.full_name || p.fullName || p.customer_name || lower.name || lower['full name'] || lower.fullname || ''
  )
    .trim()
    .slice(0, 200);
  const email = String(p.email || p.Email || p.customer_email || lower.email || lower['e-mail'] || '')
    .trim()
    .slice(0, 240);
  const phone = String(
    p.phone || p.Phone || p.customer_phone || p.tel || lower.phone || lower.telephone || lower.mobile || ''
  )
    .trim()
    .slice(0, 60);
  return { name, email, phone };
}

function findContact(db, { email, phone }) {
  const em = normEmail(email);
  const ph = normPhone(phone);
  if (em) {
    const byEmail = db.prepare('SELECT * FROM leadscout_contacts WHERE email_norm = ? LIMIT 1').get(em);
    if (byEmail) return byEmail;
  }
  if (ph) {
    const byPhone = db.prepare('SELECT * FROM leadscout_contacts WHERE phone_norm = ? LIMIT 1').get(ph);
    if (byPhone) return byPhone;
  }
  return null;
}

function upsertContact(db, { name, email, phone }) {
  ensureTables(db);
  const em = normEmail(email);
  const ph = normPhone(phone);
  if (!em && !ph) {
    throw fail('VALIDATION', 'LeadScout contact needs email or phone');
  }
  let row = findContact(db, { email: em, phone: ph });
  if (!row) {
    const info = db
      .prepare(
        `
      INSERT INTO leadscout_contacts (name, email, phone, email_norm, phone_norm)
      VALUES (?, ?, ?, ?, ?)
    `
      )
      .run(
        String(name || '').slice(0, 200),
        String(email || '').slice(0, 240),
        String(phone || '').slice(0, 60),
        em,
        ph
      );
    return db.prepare('SELECT * FROM leadscout_contacts WHERE id = ?').get(info.lastInsertRowid);
  }
  const nextName = String(name || '').trim() || row.name;
  const nextEmail = String(email || '').trim() || row.email;
  const nextPhone = String(phone || '').trim() || row.phone;
  db.prepare(
    `
    UPDATE leadscout_contacts
    SET name = ?, email = ?, phone = ?,
        email_norm = ?, phone_norm = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `
  ).run(
    nextName.slice(0, 200),
    nextEmail.slice(0, 240),
    nextPhone.slice(0, 60),
    normEmail(nextEmail) || row.email_norm,
    normPhone(nextPhone) || row.phone_norm,
    row.id
  );
  return db.prepare('SELECT * FROM leadscout_contacts WHERE id = ?').get(row.id);
}

function recordFailure(db, { kind, leadId, refId, error, payload, encrypted = false }) {
  ensureTables(db);
  db.prepare(
    `
    INSERT INTO leadscout_capture_failures (kind, lead_id, ref_id, error, payload_json)
    VALUES (?, ?, ?, ?, ?)
  `
  ).run(
    String(kind || 'unknown'),
    leadId != null ? Number(leadId) : null,
    refId != null ? Number(refId) : null,
    kind === 'submission' && (encrypted || submissionCopies.encryptedSubmission(db, refId))
      ? 'Submission capture failed'
      : String(error || '').slice(0, 500),
    payload != null
      ? kind === 'submission'
        ? submissionCopies.serialize(db, refId, payload, { encrypted })
        : JSON.stringify(payload).slice(0, 8000)
      : null
  );
}

function captureFromSubmission(
  db,
  { leadId, formId, formName, pageSlug, submissionId, payload, encrypted = false } = {}
) {
  ensureTables(db);
  const protect = encrypted || !!submissionCopies.encryptedSubmission(db, submissionId);
  try {
    const fields = pickContactFields(payload);
    if (!fields.email && !fields.phone) {
      // Nothing to attach — not a failure (anonymous / incomplete form).
      return { skipped: true, reason: 'no_identity' };
    }
    const contact = upsertContact(db, fields);
    const existing = db.prepare('SELECT id FROM leadscout_events WHERE submission_id = ?').get(Number(submissionId));
    if (existing) return { contact, eventId: existing.id, deduped: true };
    const stamp = rentalStamp(db, leadId);
    const info = db
      .prepare(
        `
      INSERT INTO leadscout_events
        (contact_id, lead_id, kind, source_label, page_slug, form_id, submission_id, payload_json,
         website_id, tenant_lead_id, rental_id)
      VALUES (?, ?, 'submission', ?, ?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        contact.id,
        leadId != null ? Number(leadId) : null,
        String(formName || 'Form').slice(0, 160),
        String(pageSlug || '').slice(0, 120),
        formId != null ? Number(formId) : null,
        Number(submissionId),
        submissionCopies.serialize(db, submissionId, payload || {}, { encrypted: protect }),
        stamp.websiteId,
        stamp.tenantLeadId,
        stamp.rentalId
      );
    const eventId = Number(info.lastInsertRowid);
    if (stamp.rentalId) {
      rentalCharge(db, {
        ownerLeadId: leadId,
        sourceKind: 'capture',
        eventId,
        contactLabel: fields.name || fields.email || fields.phone || '',
      });
    }
    return { contact, eventId };
  } catch (e) {
    recordFailure(db, {
      kind: 'submission',
      leadId,
      refId: submissionId,
      encrypted: protect,
      error: e.message || String(e),
      payload: { formId, pageSlug, payload },
    });
    return { error: protect ? 'Submission capture failed' : e.message || String(e) };
  }
}

function captureFromBooking(db, { leadId, booking, serviceName, pageSlug } = {}) {
  ensureTables(db);
  try {
    if (!booking || !booking.id) throw fail('VALIDATION', 'booking required');
    const fields = {
      name: booking.customer_name,
      email: booking.customer_email,
      phone: booking.customer_phone,
    };
    if (!fields.email && !fields.phone) {
      return { skipped: true, reason: 'no_identity' };
    }
    const contact = upsertContact(db, fields);
    const existing = db.prepare('SELECT id FROM leadscout_events WHERE booking_id = ?').get(Number(booking.id));
    if (existing) {
      db.prepare(
        `
        UPDATE leadscout_events
        SET status = ?, starts_at = ?, service_name = ?
        WHERE id = ?
      `
      ).run(
        String(booking.status || ''),
        booking.starts_at || null,
        String(serviceName || '').slice(0, 160),
        existing.id
      );
      return { contact, eventId: existing.id, deduped: true };
    }
    const stamp = rentalStamp(db, leadId);
    const info = db
      .prepare(
        `
      INSERT INTO leadscout_events
        (contact_id, lead_id, kind, source_label, page_slug, booking_id, status, starts_at, service_name, payload_json,
         website_id, tenant_lead_id, rental_id)
      VALUES (?, ?, 'appointment', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        contact.id,
        leadId != null ? Number(leadId) : null,
        'Booking',
        String(pageSlug || '').slice(0, 120),
        Number(booking.id),
        String(booking.status || ''),
        booking.starts_at || null,
        String(serviceName || '').slice(0, 160),
        JSON.stringify({
          customer_name: booking.customer_name,
          customer_email: booking.customer_email,
          customer_phone: booking.customer_phone,
          notes: booking.notes,
          ends_at: booking.ends_at,
        }).slice(0, 8000),
        stamp.websiteId,
        stamp.tenantLeadId,
        stamp.rentalId
      );
    const eventId = Number(info.lastInsertRowid);
    if (stamp.rentalId) {
      rentalCharge(db, {
        ownerLeadId: leadId,
        sourceKind: 'capture',
        eventId,
        contactLabel: fields.name || fields.email || fields.phone || '',
      });
    }
    return { contact, eventId };
  } catch (e) {
    recordFailure(db, {
      kind: 'appointment',
      leadId,
      refId: booking && booking.id,
      error: e.message || String(e),
      payload: { booking, serviceName, pageSlug },
    });
    return { error: e.message || String(e) };
  }
}

function captureFromEstimate(db, { leadId, request, pageSlug } = {}) {
  ensureTables(db);
  try {
    if (!request || !request.id) throw fail('VALIDATION', 'estimate request required');
    const fields = {
      name: request.name,
      email: request.email,
      phone: request.phone,
    };
    if (!fields.email && !fields.phone) {
      return { skipped: true, reason: 'no_identity' };
    }
    const contact = upsertContact(db, fields);
    const existing = db
      .prepare('SELECT id FROM leadscout_events WHERE estimate_request_id = ?')
      .get(Number(request.id));
    if (existing) return { contact, eventId: existing.id, deduped: true };
    let selections = request.selections;
    if (!Array.isArray(selections) && request.selections_json) {
      try {
        selections = JSON.parse(String(request.selections_json));
      } catch {
        selections = [];
      }
    }
    const stamp = rentalStamp(db, leadId);
    const info = db
      .prepare(
        `
      INSERT INTO leadscout_events
        (contact_id, lead_id, kind, source_label, page_slug, estimate_request_id, payload_json,
         website_id, tenant_lead_id, rental_id)
      VALUES (?, ?, 'estimate', ?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        contact.id,
        leadId != null ? Number(leadId) : null,
        'Instant Estimate',
        String(pageSlug || '').slice(0, 120),
        Number(request.id),
        JSON.stringify({
          name: request.name,
          email: request.email,
          phone: request.phone,
          notes: request.notes || '',
          estimate_cents: request.estimate_cents,
          display_mode: request.display_mode || '',
          selections: Array.isArray(selections) ? selections : [],
        }).slice(0, 8000),
        stamp.websiteId,
        stamp.tenantLeadId,
        stamp.rentalId
      );
    const eventId = Number(info.lastInsertRowid);
    if (stamp.rentalId) {
      rentalCharge(db, {
        ownerLeadId: leadId,
        sourceKind: 'capture',
        eventId,
        contactLabel: fields.name || fields.email || fields.phone || '',
      });
    }
    return { contact, eventId };
  } catch (e) {
    recordFailure(db, {
      kind: 'estimate',
      leadId,
      refId: request && request.id,
      error: e.message || String(e),
      payload: { request, pageSlug },
    });
    return { error: e.message || String(e) };
  }
}

function captureFromCall(db, { leadId, call } = {}) {
  ensureTables(db);
  try {
    if (!call || !call.id) throw fail('VALIDATION', 'call log row required');
    const fields = {
      name: '',
      email: '',
      phone: call.from_number || '',
    };
    if (!fields.phone) {
      return { skipped: true, reason: 'no_identity' };
    }
    const contact = upsertContact(db, fields);
    const existing = db.prepare('SELECT id FROM leadscout_events WHERE call_log_id = ?').get(Number(call.id));
    if (existing) {
      db.prepare('UPDATE leadscout_events SET status = ? WHERE id = ?').run(String(call.status || ''), existing.id);
      return { contact, eventId: existing.id, deduped: true };
    }
    // The call's own stamp (written on call_logs at log time) is the
    // snapshot of record; fall back to resolving the stamp now.
    const callStamp =
      call.rental_id != null || call.website_id != null
        ? {
            websiteId: call.website_id != null ? Number(call.website_id) : null,
            tenantLeadId: call.tenant_lead_id != null ? Number(call.tenant_lead_id) : null,
            rentalId: call.rental_id != null ? Number(call.rental_id) : null,
          }
        : rentalStamp(db, leadId);
    const info = db
      .prepare(
        `
      INSERT INTO leadscout_events
        (contact_id, lead_id, kind, source_label, page_slug, call_log_id, status, payload_json,
         website_id, tenant_lead_id, rental_id)
      VALUES (?, ?, 'call', ?, ?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        contact.id,
        leadId != null ? Number(leadId) : null,
        'Call',
        '',
        Number(call.id),
        String(call.status || ''),
        JSON.stringify({
          phone: call.from_number || '',
          from_number: call.from_number || '',
          to_number: call.to_number || '',
          call_sid: call.call_sid || '',
          status: call.status || '',
          duration_seconds: call.duration_seconds != null ? call.duration_seconds : null,
        }).slice(0, 8000),
        callStamp.websiteId,
        callStamp.tenantLeadId,
        callStamp.rentalId
      );
    return { contact, eventId: info.lastInsertRowid };
  } catch (e) {
    recordFailure(db, {
      kind: 'call',
      leadId,
      refId: call && call.id,
      error: e.message || String(e),
      payload: { call },
    });
    return { error: e.message || String(e) };
  }
}

/**
 * Batch 118 — a Newsletter signup becomes a LeadScout contact, sourced
 * to the signup, exactly like the other capture kinds: deduped by the
 * contact upsert (email) and by the per-subscriber event index, so a
 * repeat signup never duplicates the contact or the event.
 */
function captureFromNewsletter(db, { leadId, subscriber } = {}) {
  ensureTables(db);
  try {
    if (!subscriber || !subscriber.id) throw fail('VALIDATION', 'newsletter subscriber required');
    const fields = {
      name: subscriber.name || '',
      email: subscriber.email || '',
      phone: '',
    };
    if (!fields.email) {
      return { skipped: true, reason: 'no_identity' };
    }
    const contact = upsertContact(db, fields);
    const existing = db
      .prepare('SELECT id FROM leadscout_events WHERE newsletter_subscriber_id = ?')
      .get(Number(subscriber.id));
    if (existing) return { contact, eventId: existing.id, deduped: true };
    const stamp = rentalStamp(db, leadId);
    const info = db
      .prepare(
        `
      INSERT INTO leadscout_events
        (contact_id, lead_id, kind, source_label, page_slug, newsletter_subscriber_id, payload_json,
         website_id, tenant_lead_id, rental_id)
      VALUES (?, ?, 'newsletter', ?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        contact.id,
        leadId != null ? Number(leadId) : null,
        'Newsletter signup',
        '',
        Number(subscriber.id),
        JSON.stringify({
          email: subscriber.email || '',
          name: subscriber.name || '',
          source: subscriber.source || 'embed',
        }).slice(0, 8000),
        stamp.websiteId,
        stamp.tenantLeadId,
        stamp.rentalId
      );
    const eventId = Number(info.lastInsertRowid);
    if (stamp.rentalId) {
      rentalCharge(db, {
        ownerLeadId: leadId,
        sourceKind: 'capture',
        eventId,
        contactLabel: fields.name || fields.email || '',
      });
    }
    return { contact, eventId };
  } catch (e) {
    recordFailure(db, {
      kind: 'newsletter',
      leadId,
      refId: subscriber && subscriber.id,
      error: e.message || String(e),
      payload: { subscriber },
    });
    return { error: e.message || String(e) };
  }
}

/**
 * Batch 131 — a visitor comment becomes a LeadScout contact event,
 * exactly like a form submission / booking / photo: one deduped
 * contact per person (email — comments always collect one), one
 * event per comment row (deduped by comment_id), rental stamp +
 * charge when the site is rented. The comment itself stays in the
 * Comments module's storage; the event payload carries the target it
 * was left on and a body excerpt so the contact timeline shows what
 * came in. Liking captures NOTHING — a like carries no identity.
 */
function captureFromComment(db, { leadId, comment, pageSlug } = {}) {
  ensureTables(db);
  try {
    if (!comment || !comment.id) throw fail('VALIDATION', 'comment required');
    const fields = {
      name: comment.author_name || '',
      email: comment.author_email || '',
      phone: '',
    };
    if (!normEmail(fields.email)) {
      return { skipped: true, reason: 'no_identity' };
    }
    const contact = upsertContact(db, fields);
    const existing = db
      .prepare('SELECT id FROM leadscout_events WHERE comment_id = ?')
      .get(Number(comment.id));
    if (existing) return { contact, eventId: existing.id, deduped: true };
    const stamp = rentalStamp(db, leadId);
    const info = db
      .prepare(
        `
      INSERT INTO leadscout_events
        (contact_id, lead_id, kind, source_label, page_slug, comment_id, payload_json,
         website_id, tenant_lead_id, rental_id)
      VALUES (?, ?, 'comment', ?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        contact.id,
        leadId != null ? Number(leadId) : null,
        'Comment',
        pageSlug || comment.page_slug || '',
        Number(comment.id),
        JSON.stringify({
          name: fields.name,
          email: fields.email,
          target_type: comment.target_type || '',
          target_id: comment.target_id != null ? String(comment.target_id) : '',
          body: String(comment.body || '').slice(0, 1000),
          status: comment.status || 'pending',
        }).slice(0, 8000),
        stamp.websiteId,
        stamp.tenantLeadId,
        stamp.rentalId
      );
    const eventId = Number(info.lastInsertRowid);
    if (stamp.rentalId) {
      rentalCharge(db, {
        ownerLeadId: leadId,
        sourceKind: 'capture',
        eventId,
        contactLabel: fields.name || fields.email || '',
      });
    }
    return { contact, eventId };
  } catch (e) {
    recordFailure(db, {
      kind: 'comment',
      leadId,
      refId: comment && comment.id,
      error: e.message || String(e),
      payload: { comment, pageSlug },
    });
    return { error: e.message || String(e) };
  }
}

/**
 * Batch 125 — a Photo Capture submission becomes a LeadScout contact
 * event, exactly like a form submission / booking / estimate request:
 * one deduped contact per person (email or phone), one event per
 * submission row (deduped by photo_submission_id), rental stamp +
 * charge when the site is rented. The photo itself stays in the
 * module's storage; the event payload carries the message and the
 * stored image path so the contact timeline shows what came in.
 */
function captureFromPhoto(db, { leadId, submission, pageSlug } = {}) {
  ensureTables(db);
  try {
    if (!submission || !submission.id) throw fail('VALIDATION', 'photo submission required');
    const fields = {
      name: submission.name || '',
      email: submission.email || '',
      phone: submission.phone || '',
    };
    if (!normEmail(fields.email) && !normPhone(fields.phone)) {
      return { skipped: true, reason: 'no_identity' };
    }
    const contact = upsertContact(db, fields);
    const existing = db
      .prepare('SELECT id FROM leadscout_events WHERE photo_submission_id = ?')
      .get(Number(submission.id));
    if (existing) return { contact, eventId: existing.id, deduped: true };
    const stamp = rentalStamp(db, leadId);
    const info = db
      .prepare(
        `
      INSERT INTO leadscout_events
        (contact_id, lead_id, kind, source_label, page_slug, photo_submission_id, payload_json,
         website_id, tenant_lead_id, rental_id)
      VALUES (?, ?, 'photo', ?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        contact.id,
        leadId != null ? Number(leadId) : null,
        'Photo Capture',
        pageSlug || submission.page_slug || '',
        Number(submission.id),
        JSON.stringify({
          name: fields.name,
          email: fields.email,
          phone: fields.phone,
          message: submission.message || '',
          image_url: submission.image_url || '',
          image_src: submission.image_src || '',
          status: submission.status || 'pending',
        }).slice(0, 8000),
        stamp.websiteId,
        stamp.tenantLeadId,
        stamp.rentalId
      );
    const eventId = Number(info.lastInsertRowid);
    if (stamp.rentalId) {
      rentalCharge(db, {
        ownerLeadId: leadId,
        sourceKind: 'capture',
        eventId,
        contactLabel: fields.name || fields.email || fields.phone || '',
      });
    }
    return { contact, eventId };
  } catch (e) {
    recordFailure(db, {
      kind: 'photo',
      leadId,
      refId: submission && submission.id,
      error: e.message || String(e),
      payload: { submission, pageSlug },
    });
    return { error: e.message || String(e) };
  }
}

/**
 * Record an SMS opt-in on the LeadScout contact (Batch 25).
 *
 * Phone-keyed upsert (same dedupe as every other capture): a repeat
 * opt-in refreshes the consent timestamp + source on the ONE contact
 * row, never a duplicate. Returns `shouldSend` only on an enrollment
 * transition — the contact was not enrolled, or had opted out since
 * their last opt-in — so the welcome text goes out once per enrollment,
 * not once per submission. An 'sms_opt_in' timeline event is written on
 * transitions only. Never throws: failures land in the capture-failure
 * queue like every other capture kind.
 */
function recordSmsOptIn(db, { leadId, name, email, phone, source, formId } = {}) {
  ensureTables(db);
  try {
    const fields = {
      name: String(name || '').slice(0, 200),
      email: String(email || '').slice(0, 240),
      phone: String(phone || '').slice(0, 60),
    };
    if (!normPhone(fields.phone)) {
      return { skipped: true, reason: 'invalid_phone' };
    }
    const contact = upsertContact(db, fields);
    const optedOutSince =
      !!contact.sms_opted_out_at &&
      (!contact.sms_opted_in_at || String(contact.sms_opted_out_at) > String(contact.sms_opted_in_at));
    const alreadyEnrolled = Number(contact.sms_opted_in || 0) === 1 && !optedOutSince;
    const src = String(source || '').slice(0, 160);
    db.prepare(
      `
      UPDATE leadscout_contacts
      SET sms_opted_in = 1, sms_opted_in_at = datetime('now'), sms_opt_in_source = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `
    ).run(src, contact.id);
    let eventId = null;
    if (!alreadyEnrolled) {
      const info = db
        .prepare(
          `
      INSERT INTO leadscout_events
        (contact_id, lead_id, kind, source_label, form_id, payload_json, status)
      VALUES (?, ?, 'sms_opt_in', ?, ?, ?, 'enrolled')
    `
        )
        .run(
          contact.id,
          leadId != null ? Number(leadId) : null,
          src,
          formId != null ? Number(formId) : null,
          JSON.stringify({ phone: fields.phone, source: src }).slice(0, 8000)
        );
      eventId = info.lastInsertRowid;
    }
    const fresh = db.prepare('SELECT * FROM leadscout_contacts WHERE id = ?').get(contact.id);
    return { contact: fresh, enrolled: true, alreadyEnrolled, shouldSend: !alreadyEnrolled, eventId };
  } catch (e) {
    recordFailure(db, {
      kind: 'sms_opt_in',
      leadId,
      error: e.message || String(e),
      payload: { phone, source },
    });
    return { error: e.message || String(e) };
  }
}

/** Stamp the welcome-text outcome (sent | skipped | failed) on the contact. */
function markSmsConfirmResult(db, { contactId, status, error } = {}) {
  ensureTables(db);
  db.prepare(
    `
    UPDATE leadscout_contacts
    SET sms_confirm_status = ?, sms_confirm_at = datetime('now'), sms_confirm_error = ?
    WHERE id = ?
  `
  ).run(String(status || '').slice(0, 40), String(error || '').slice(0, 300), Number(contactId));
  return db.prepare('SELECT * FROM leadscout_contacts WHERE id = ?').get(Number(contactId));
}

function validLeadScope(leadId) {
  if (leadId == null) return null; // Explicit workspace-level internal callers only.
  const id = Number(leadId);
  if (!Number.isInteger(id) || id <= 0) throw fail('FORBIDDEN', 'Valid business scope required', 403);
  return id;
}

// Shared deduplication rows can be updated by a different business. Client
// identities must come only from that business's own captured event snapshots.
function projectScopedContact(db, row, leadId) {
  const snapshots = db
    .prepare(
      `
    SELECT payload_json FROM leadscout_events
    WHERE contact_id = ? AND lead_id = ? ORDER BY id DESC LIMIT 100
  `
    )
    .all(Number(row.id), leadId);
  const identity = { name: '', email: '', phone: '' };
  for (const snapshot of snapshots) {
    let payload;
    try {
      payload = submissionCopies.decode(snapshot.payload_json) || {};
    } catch {
      continue;
    }
    const fields = pickContactFields(payload);
    for (const key of ['name', 'email', 'phone']) {
      if (!identity[key] && fields[key]) identity[key] = fields[key];
    }
    if (identity.name && identity.email && identity.phone) break;
  }
  return { ...row, ...identity, email_norm: normEmail(identity.email), phone_norm: normPhone(identity.phone) };
}

function listContacts(db, { leadId = null, q = '', limit = 50, offset = 0 } = {}) {
  ensureTables(db);
  leadId = validLeadScope(leadId);
  const lim = Math.min(100, Math.max(1, Number(limit) || 50));
  const off = Math.max(0, Number(offset) || 0);
  const query = String(q || '')
    .trim()
    .toLowerCase();
  let rows;
  if (leadId != null) {
    rows = db
      .prepare(
        `
      SELECT c.id,
        MIN(e.created_at) AS created_at, MAX(e.created_at) AS updated_at,
        COUNT(*) AS event_count, MAX(e.created_at) AS last_event_at
      FROM leadscout_contacts c
      JOIN leadscout_events e ON e.contact_id = c.id AND e.lead_id = ?
      GROUP BY c.id
      ORDER BY last_event_at DESC, c.id DESC
      LIMIT ? OFFSET ?
    `
      )
      .all(leadId, lim, off)
      .map((row) => projectScopedContact(db, row, leadId));
  } else {
    rows = db
      .prepare(
        `
      SELECT c.*,
        (SELECT COUNT(*) FROM leadscout_events e WHERE e.contact_id = c.id) AS event_count,
        (SELECT MAX(e.created_at) FROM leadscout_events e WHERE e.contact_id = c.id) AS last_event_at
      FROM leadscout_contacts c
      ORDER BY COALESCE(
        (SELECT MAX(e.created_at) FROM leadscout_events e WHERE e.contact_id = c.id),
        c.updated_at
      ) DESC
      LIMIT ? OFFSET ?
    `
      )
      .all(lim, off);
  }
  if (query) {
    rows = rows.filter((r) => {
      const blob = `${r.name} ${r.email} ${r.phone}`.toLowerCase();
      return blob.includes(query);
    });
  }
  return rows;
}

function getContact(db, id, { leadId = null } = {}) {
  ensureTables(db);
  leadId = validLeadScope(leadId);
  let contact =
    leadId == null
      ? db.prepare('SELECT * FROM leadscout_contacts WHERE id = ?').get(Number(id))
      : db
          .prepare(
            `
      SELECT c.id, MIN(e.created_at) AS created_at, MAX(e.created_at) AS updated_at,
        COUNT(*) AS event_count, MAX(e.created_at) AS last_event_at
      FROM leadscout_contacts c
      JOIN leadscout_events e ON e.contact_id = c.id AND e.lead_id = ?
      WHERE c.id = ? GROUP BY c.id
    `
          )
          .get(leadId, Number(id));
  if (!contact) throw fail('NOT_FOUND', 'LeadScout contact not found', 404);
  if (leadId != null) contact = projectScopedContact(db, contact, leadId);
  const events = (
    leadId == null
      ? db.prepare('SELECT * FROM leadscout_events WHERE contact_id = ? ORDER BY id DESC LIMIT 100').all(Number(id))
      : db
          .prepare('SELECT * FROM leadscout_events WHERE contact_id = ? AND lead_id = ? ORDER BY id DESC LIMIT 100')
          .all(Number(id), leadId)
  ).map((e) => {
    let payload = null;
    if (e.payload_json) {
      try {
        payload = submissionCopies.decode(e.payload_json);
      } catch {
        payload = null;
      }
    }
    return { ...e, payload };
  });
  return {
    contact,
    events,
    appointments: events.filter((e) => e.kind === 'appointment'),
    submissions: events.filter((e) => e.kind === 'submission'),
    estimates: events.filter((e) => e.kind === 'estimate'),
    calls: events.filter((e) => e.kind === 'call'),
    photos: events.filter((e) => e.kind === 'photo'),
    comments: events.filter((e) => e.kind === 'comment'),
  };
}

/**
 * Batch 45 — hard-delete a LeadScout contact. Events cascade via the
 * leadscout_events FK. Money guard: if any of the contact's events
 * carries a rental charge (site_rental_charges.event_id), deletion is
 * refused — the charge ledger must never point at a vanished event.
 * Lead-scoped callers (the portal) may only delete a contact whose
 * events ALL belong to their lead; a contact shared with another
 * business is a staff-level (workspace-wide) delete.
 */
function deleteContact(db, id, { leadId = null } = {}) {
  ensureTables(db);
  const scope = validLeadScope(leadId);
  const contact = db.prepare('SELECT * FROM leadscout_contacts WHERE id = ?').get(Number(id));
  if (!contact) throw fail('NOT_FOUND', 'LeadScout contact not found', 404);
  const events = db.prepare('SELECT id, lead_id FROM leadscout_events WHERE contact_id = ?').all(contact.id);
  if (scope != null) {
    if (!events.length || events.some((e) => Number(e.lead_id) !== scope)) {
      throw fail(
        'CONTACT_SHARED',
        'This contact also belongs to another business — only staff can delete it.',
        409
      );
    }
  }
  const chargeTable = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'site_rental_charges'")
    .get();
  if (chargeTable && events.length) {
    const ids = events.map((e) => Number(e.id));
    const placeholders = ids.map(() => '?').join(',');
    const charge = db
      .prepare(`SELECT id FROM site_rental_charges WHERE event_id IN (${placeholders}) LIMIT 1`)
      .get(...ids);
    if (charge) {
      throw fail(
        'CONTACT_CHARGED',
        'This contact has rental-charged activity and cannot be deleted.',
        409
      );
    }
  }
  db.prepare('DELETE FROM leadscout_contacts WHERE id = ?').run(contact.id);
  return { deleted: true, id: contact.id, eventsRemoved: events.length };
}

/** Batch 45 — clear RESOLVED capture failures (housekeeping; open ones stay for retry). */
function clearResolvedFailures(db, { leadId = null } = {}) {
  ensureTables(db);
  const scope = validLeadScope(leadId);
  const info =
    scope == null
      ? db.prepare('DELETE FROM leadscout_capture_failures WHERE resolved_at IS NOT NULL').run()
      : db
          .prepare('DELETE FROM leadscout_capture_failures WHERE resolved_at IS NOT NULL AND lead_id = ?')
          .run(scope);
  return { cleared: Number(info.changes || 0) };
}

function captureHealth(db, { leadId = null } = {}) {
  ensureTables(db);
  leadId = validLeadScope(leadId);
  const scope = leadId == null ? '' : ' AND lead_id = ?';
  const params = leadId == null ? [] : [leadId];
  const open = db
    .prepare(
      `
    SELECT COUNT(*) AS c FROM leadscout_capture_failures WHERE resolved_at IS NULL${scope}
  `
    )
    .get(...params);
  const recent = db
    .prepare(
      `
    SELECT * FROM leadscout_capture_failures
    WHERE resolved_at IS NULL${scope}
    ORDER BY id DESC LIMIT 20
  `
    )
    .all(...params);
  return {
    ok: !(open && open.c),
    open_failures: Number(open && open.c) || 0,
    failures: recent,
  };
}

function retryOpenFailures(db, { leadId = null } = {}) {
  ensureTables(db);
  leadId = validLeadScope(leadId);
  const scope = leadId == null ? '' : ' AND lead_id = ?';
  const open = db
    .prepare(
      `
    SELECT * FROM leadscout_capture_failures
    WHERE resolved_at IS NULL${scope}
    ORDER BY id ASC LIMIT 50
  `
    )
    .all(...(leadId == null ? [] : [leadId]));
  let resolved = 0;
  for (const row of open) {
    let payload = null;
    try {
      payload = row.payload_json ? submissionCopies.decode(row.payload_json) : null;
    } catch {
      payload = null;
    }
    let result = null;
    if (row.kind === 'submission' && payload) {
      result = captureFromSubmission(db, {
        leadId: row.lead_id,
        formId: payload.formId,
        formName: payload.formName,
        pageSlug: payload.pageSlug,
        submissionId: row.ref_id,
        payload: payload.payload || payload,
      });
    } else if (row.kind === 'appointment' && payload) {
      result = captureFromBooking(db, {
        leadId: row.lead_id,
        booking: payload.booking,
        serviceName: payload.serviceName,
        pageSlug: payload.pageSlug,
      });
    } else if (row.kind === 'estimate' && payload) {
      result = captureFromEstimate(db, {
        leadId: row.lead_id,
        request: payload.request,
        pageSlug: payload.pageSlug,
      });
    } else if (row.kind === 'call' && payload) {
      result = captureFromCall(db, {
        leadId: row.lead_id,
        call: payload.call,
      });
    } else if (row.kind === 'newsletter' && payload) {
      result = captureFromNewsletter(db, {
        leadId: row.lead_id,
        subscriber: payload.subscriber,
      });
    } else if (row.kind === 'photo' && payload) {
      result = captureFromPhoto(db, {
        leadId: row.lead_id,
        submission: payload.submission,
        pageSlug: payload.pageSlug,
      });
    } else if (row.kind === 'comment' && payload) {
      result = captureFromComment(db, {
        leadId: row.lead_id,
        comment: payload.comment,
        pageSlug: payload.pageSlug,
      });
    }
    db.prepare(
      `
      UPDATE leadscout_capture_failures
      SET retries = retries + 1, updated_at = datetime('now'),
          resolved_at = CASE WHEN ? THEN datetime('now') ELSE resolved_at END,
          error = CASE WHEN ? THEN error ELSE ? END
      WHERE id = ?
    `
    ).run(
      result && !result.error ? 1 : 0,
      result && !result.error ? 1 : 0,
      result && result.error ? String(result.error).slice(0, 500) : row.error,
      row.id
    );
    if (result && !result.error) resolved += 1;
  }
  return { tried: open.length, resolved, health: captureHealth(db, { leadId }) };
}

/**
 * Batch 163 — a webinar registrant becomes a LeadScout contact event,
 * exactly like a newsletter signup: one deduped contact per person
 * (email/phone), one event per webinar registration (deduped by
 * webinar_registration_id), source label "Webinar — <title>". The
 * webinar lives at platform level, so there is no site lead — leadId
 * is null and the rental stamp resolves empty.
 */
function captureFromWebinar(db, { registration, webinarTitle } = {}) {
  ensureTables(db);
  try {
    if (!registration || !registration.id) throw fail('VALIDATION', 'webinar registration required');
    const fields = {
      name: registration.name || '',
      email: registration.email || '',
      phone: registration.phone || '',
    };
    if (!fields.email && !fields.phone) {
      return { skipped: true, reason: 'no_identity' };
    }
    const contact = upsertContact(db, fields);
    const existing = db
      .prepare('SELECT id FROM leadscout_events WHERE webinar_registration_id = ?')
      .get(Number(registration.id));
    if (existing) return { contact, eventId: existing.id, deduped: true };
    const stamp = rentalStamp(db, null);
    const info = db
      .prepare(
        `
      INSERT INTO leadscout_events
        (contact_id, lead_id, kind, source_label, page_slug, webinar_registration_id, payload_json,
         website_id, tenant_lead_id, rental_id)
      VALUES (?, NULL, 'webinar', ?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        contact.id,
        `Webinar — ${String(webinarTitle || 'Webinar').slice(0, 200)}`,
        '',
        Number(registration.id),
        JSON.stringify({
          email: registration.email || '',
          name: registration.name || '',
          phone: registration.phone || '',
          source: 'webinar-gate',
        }).slice(0, 8000),
        stamp.websiteId,
        stamp.tenantLeadId,
        stamp.rentalId
      );
    return { contact, eventId: Number(info.lastInsertRowid) };
  } catch (e) {
    recordFailure(db, {
      kind: 'webinar',
      leadId: null,
      refId: registration && registration.id,
      error: e.message || String(e),
      payload: { registration },
    });
    return { error: e.message || String(e) };
  }
}

/**
 * Batch 178 — a claimed Leads Router lead becomes a LeadScout contact
 * in the CLAIMING business's portal store (spec §7), stamped with
 * router_lead_id + platform + source_url. Exactly one event per
 * router lead (the partial UNIQUE index on router_lead_id), so a
 * claim retry never duplicates the contact.
 *
 * Identity note (spec §9 — no enrichment): a poster is only ever a
 * name as shown on the post. There is NO email or phone to dedupe
 * on, and upsertContact rightly refuses identity-less contacts — so
 * this capture keys identity to the router lead itself: the contact
 * row is created name-only, and the router_lead_id event is the
 * dedupe anchor. The payload carries exactly what the poster posted
 * (name, platform, source link, lead type, town) and nothing more.
 */
function captureFromRouterClaim(db, { leadId, routerLead } = {}) {
  ensureTables(db);
  try {
    if (!routerLead || !routerLead.id) throw fail('VALIDATION', 'router lead required');
    if (leadId == null) throw fail('VALIDATION', 'claiming leadId required');
    const existing = db
      .prepare('SELECT id, contact_id FROM leadscout_events WHERE router_lead_id = ?')
      .get(Number(routerLead.id));
    if (existing) {
      const contact = db.prepare('SELECT * FROM leadscout_contacts WHERE id = ?').get(existing.contact_id);
      return { contact, eventId: existing.id, deduped: true };
    }
    const name = String(routerLead.poster_name || '').slice(0, 200);
    const cInfo = db
      .prepare('INSERT INTO leadscout_contacts (name, email, phone, email_norm, phone_norm) VALUES (?, \'\', \'\', \'\', \'\')')
      .run(name);
    const contact = db.prepare('SELECT * FROM leadscout_contacts WHERE id = ?').get(cInfo.lastInsertRowid);
    const stamp = rentalStamp(db, leadId);
    const info = db
      .prepare(
        `
      INSERT INTO leadscout_events
        (contact_id, lead_id, kind, source_label, page_slug, router_lead_id, payload_json,
         website_id, tenant_lead_id, rental_id)
      VALUES (?, ?, 'router_claim', ?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        contact.id,
        Number(leadId),
        'Leads Router',
        '',
        Number(routerLead.id),
        JSON.stringify({
          name,
          platform: routerLead.platform || '',
          source_url: routerLead.source_url || '',
          source_context: routerLead.source_context || '',
          lead_type: routerLead.lead_type_label || routerLead.lead_type_key || '',
          request_kind: routerLead.request_kind || '',
          town: routerLead.town || '',
          area: routerLead.area || '',
        }).slice(0, 8000),
        stamp.websiteId,
        stamp.tenantLeadId,
        stamp.rentalId
      );
    const eventId = Number(info.lastInsertRowid);
    if (stamp.rentalId) {
      rentalCharge(db, {
        ownerLeadId: leadId,
        sourceKind: 'capture',
        eventId,
        contactLabel: name || routerLead.source_url || '',
      });
    }
    return { contact, eventId };
  } catch (e) {
    recordFailure(db, {
      kind: 'router_claim',
      leadId,
      refId: routerLead && routerLead.id,
      error: e.message || String(e),
      payload: { routerLead },
    });
    return { error: e.message || String(e) };
  }
}

module.exports = {
  ensureTables,
  upsertContact,
  captureFromRouterClaim,
  captureFromWebinar,
  captureFromSubmission,
  captureFromBooking,
  captureFromEstimate,
  captureFromCall,
  captureFromNewsletter,
  captureFromPhoto,
  captureFromComment,
  recordSmsOptIn,
  markSmsConfirmResult,
  listContacts,
  getContact,
  deleteContact,
  clearResolvedFailures,
  captureHealth,
  retryOpenFailures,
  pickContactFields,
  normEmail,
  normPhone,
};
