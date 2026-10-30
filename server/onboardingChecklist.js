'use strict';

/**
 * Batch 74 — per-lead onboarding checklist (staff admin).
 *
 * The 12-item run sheet from the client onboarding pack ("For the
 * BitPype team — running this onboarding") as a working checklist on
 * the lead record: staff tick items off as onboarding progresses, and
 * "Run checklist" AUTO-CHECKS what the data can prove, leaving a
 * confirming human to apply the passes.
 *
 * Ely's rules for this feature (2026-10-30):
 *   - ALL items are OPTIONAL. Nothing gates, blocks, or depends on
 *     completion anywhere in the app. The panel is just ticks.
 *   - A completed item shows a tick; provenance (who/when/how) lives
 *     in the stored state + the lead's event trail, not in pressure UI.
 *   - The auto-run NEVER writes by itself and NEVER fakes a pass: an
 *     item the data cannot verify comes back 'manual', an item whose
 *     condition is checked and unmet comes back 'fail', and Confirm
 *     re-runs the engine server-side and applies only fresh passes.
 *
 * This module is the SINGLE SOURCE for the item definition (keys +
 * labels) — the API serves it and the UI renders from the API.
 *
 * Storage: one row per (lead, item) in lead_onboarding_items, written
 * only when an item is done (absence = not done). Per-workspace
 * SQLite, like every other lead-owned table; the row carries a FK
 * ON DELETE CASCADE and leadEngine.deleteLead also drops the rows
 * explicitly, so no residue survives a lead delete.
 */

function fail(code, message, status = 400) {
  const e = new Error(message);
  e.code = code;
  e.status = status;
  return e;
}

const ITEMS = Object.freeze([
  { key: 'lead_record', label: 'Lead record complete (facts verified, real client email)' },
  {
    key: 'client_checklist',
    label: 'Client checklist received (logo, hours, services, forwarding number, service area)',
  },
  { key: 'site_built', label: 'Site built staged + whole-site audited' },
  { key: 'portal_account', label: 'Portal account created + client sign-in proven' },
  { key: 'call_tracking', label: 'Call tracking wired + test call rang the client' },
  {
    key: 'forms_verified',
    label: 'Forms verified end-to-end (submission → Forms → LeadScout → owner email)',
  },
  { key: 'domain_live', label: 'Domain linked + live on the real address' },
  { key: 'renewal_mode', label: 'Domain renewal mode checked + noted' },
  { key: 'google_pieces', label: 'Google pieces set (Place ID, Google Profile draft)' },
  {
    key: 'billing_checked',
    label: 'Billing reality-checked (subscription active, first payment email sent)',
  },
  { key: 'pack_delivered', label: 'Onboarding pack delivered + go-live checks done by client' },
  { key: 'checkin_scheduled', label: 'Two-week check-in scheduled' },
]);

const ITEM_KEYS = new Set(ITEMS.map((i) => i.key));

function ensureTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lead_onboarding_items (
      lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      item_key TEXT NOT NULL,
      done_by TEXT,
      done_by_id INTEGER,
      via TEXT NOT NULL DEFAULT 'manual',
      done_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (lead_id, item_key)
    );
  `);
}

function assertLead(db, leadId) {
  const id = Number(leadId);
  if (!Number.isInteger(id) || id <= 0) throw fail('VALIDATION', 'leadId must be a positive integer.', 422);
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
  if (!lead) throw fail('NOT_FOUND', `Lead ${id} not found.`, 404);
  return lead;
}

function actorLabel(actor) {
  if (actor && actor.email) return String(actor.email);
  if (actor && actor.id != null) return `user #${actor.id}`;
  return 'staff';
}

function getState(db, leadId) {
  ensureTables(db);
  const lead = assertLead(db, leadId);
  const rows = db.prepare('SELECT * FROM lead_onboarding_items WHERE lead_id = ?').all(lead.id);
  const byKey = new Map(rows.map((r) => [r.item_key, r]));
  const items = ITEMS.map((def) => {
    const row = byKey.get(def.key);
    return {
      key: def.key,
      label: def.label,
      done: !!row,
      doneBy: row ? row.done_by || null : null,
      doneById: row && row.done_by_id != null ? Number(row.done_by_id) : null,
      doneAt: row ? row.done_at || null : null,
      via: row ? row.via || 'manual' : null,
    };
  });
  return {
    leadId: lead.id,
    total: ITEMS.length,
    doneCount: items.filter((i) => i.done).length,
    items,
  };
}

function logOnboardingEvent(db, leadId, detail) {
  try {
    db.prepare('INSERT INTO lead_events (lead_id, type, detail) VALUES (?, ?, ?)').run(
      Number(leadId),
      'onboarding',
      String(detail).slice(0, 2000)
    );
  } catch {
    /* the event trail is desirable, never a reason to fail the toggle */
  }
}

/**
 * Set one item done/undone. actor: {id, email}. via: 'manual' (a human
 * ticked it) | 'autorun' (applied by Confirm after a Run checklist
 * pass — the event detail says so, per Ely's provenance ask).
 * Returns the fresh state. Idempotent: re-applying the same state is a
 * no-op (no duplicate event).
 */
function setItem(db, leadId, key, done, actor = {}, via = 'manual') {
  ensureTables(db);
  const lead = assertLead(db, leadId);
  const def = ITEMS.find((i) => i.key === key);
  if (!def) throw fail('VALIDATION', `Unknown onboarding item: ${key}`, 422);
  const want = !!done;
  const existing = db
    .prepare('SELECT item_key FROM lead_onboarding_items WHERE lead_id = ? AND item_key = ?')
    .get(lead.id, key);
  if (want && !existing) {
    db.prepare(
      `INSERT INTO lead_onboarding_items (lead_id, item_key, done_by, done_by_id, via, done_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`
    ).run(lead.id, key, actorLabel(actor), actor && actor.id != null ? Number(actor.id) : null, via === 'autorun' ? 'autorun' : 'manual');
    logOnboardingEvent(
      db,
      lead.id,
      via === 'autorun'
        ? `Onboarding: '${def.label}' checked via Run checklist (confirmed) by ${actorLabel(actor)}`
        : `Onboarding: '${def.label}' checked by ${actorLabel(actor)}`
    );
  } else if (!want && existing) {
    db.prepare('DELETE FROM lead_onboarding_items WHERE lead_id = ? AND item_key = ?').run(lead.id, key);
    logOnboardingEvent(db, lead.id, `Onboarding: '${def.label}' unchecked by ${actorLabel(actor)}`);
  }
  return getState(db, lead.id);
}

/* ------------------------------------------------------------------ */
/* Auto-run engine — reads only, never writes.                         */
/* Every verdict is derived from a real table; anything unverifiable   */
/* is 'manual', anything checked-and-unmet is 'fail'.                  */
/* ------------------------------------------------------------------ */

function tableExists(db, name) {
  try {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  } catch {
    return false;
  }
}

function count(db, sql, ...params) {
  try {
    const row = db.prepare(sql).get(...params);
    return row ? Number(row.c) || 0 : 0;
  } catch {
    return 0;
  }
}

function firstRow(db, sql, ...params) {
  try {
    return db.prepare(sql).get(...params) || null;
  } catch {
    return null;
  }
}

function allRows(db, sql, ...params) {
  try {
    return db.prepare(sql).all(...params);
  } catch {
    return [];
  }
}

function evaluate(db, leadId, extras = {}) {
  const lead = assertLead(db, leadId);
  const id = lead.id;
  const out = [];
  const push = (key, verdict, detail) => out.push({ key, verdict, detail });

  /* 1 — lead record complete: name + phone + plausible email + facts.
     "Verified" cannot be proven from data, so the basis is presence,
     stated plainly in the detail. */
  {
    const missing = [];
    if (!String(lead.business_name || '').trim()) missing.push('business name');
    if (!String(lead.phone || '').trim()) missing.push('phone');
    const email = String(lead.email || '').trim();
    if (!/.+@.+\..+/.test(email)) missing.push('a real email');
    const facts = count(db, 'SELECT COUNT(*) AS c FROM business_facts WHERE lead_id = ?', id);
    if (missing.length) {
      push('lead_record', 'fail', `Missing: ${missing.join(', ')}.`);
    } else if (!facts) {
      push('lead_record', 'fail', 'Name, phone and email are on record, but no researched facts are on file yet.');
    } else {
      push('lead_record', 'pass', `Name, phone and email on record; ${facts} fact(s) on file.`);
    }
  }

  /* 2 — client checklist received: no system record exists. */
  push(
    'client_checklist',
    'manual',
    'No system record of this — confirm the client\u2019s checklist (logo, hours, services, forwarding number, service area) actually arrived.'
  );

  /* 3 — site built staged: a website row exists. The whole-site audit
     itself is a human judgment; the detail says so. */
  {
    const site = firstRow(
      db,
      'SELECT id, name, status FROM websites WHERE lead_id = ? AND archived_at IS NULL',
      id
    );
    if (site) {
      push('site_built', 'pass', `Website \u2018${site.name}\u2019 exists (status: ${site.status}). The whole-site audit itself is on you.`);
    } else {
      push('site_built', 'fail', 'No website has been built for this lead yet.');
    }
  }

  /* 4 — portal account + sign-in: platform DB (resolved by the facade
     and handed in — client_portal_users.last_login_at is a real
     sign-in signal, written by the portal login flow). */
  {
    if (extras.portalLookupFailed) {
      push('portal_account', 'manual', 'Portal records could not be read — check the account by hand.');
    } else if (!extras.portalUser) {
      push('portal_account', 'fail', 'No portal account exists for this lead.');
    } else if (extras.portalUser.last_login_at) {
      push(
        'portal_account',
        'pass',
        `Portal account ${extras.portalUser.email} — client signed in ${String(extras.portalUser.last_login_at).slice(0, 10)}.`
      );
    } else {
      push(
        'portal_account',
        'fail',
        `Portal account ${extras.portalUser.email} exists, but the client has never signed in.`
      );
    }
  }

  /* 5 — call tracking: a tracking number assigned AND at least one
     logged call (the test call proves the chain end to end). */
  {
    let tracking = '';
    if (tableExists(db, 'calltracking_configs')) {
      const cfg = firstRow(db, 'SELECT * FROM calltracking_configs WHERE lead_id = ?', id);
      if (cfg) {
        tracking = String(cfg.display_number || '').trim();
        if (!tracking && cfg.rotation_numbers) {
          try {
            const set = JSON.parse(cfg.rotation_numbers);
            if (Array.isArray(set) && set.filter(Boolean).length) tracking = String(set.filter(Boolean)[0]);
          } catch {
            /* unparseable rotation set — treated as unassigned */
          }
        }
      }
    }
    const calls = count(db, 'SELECT COUNT(*) AS c FROM call_logs WHERE lead_id = ?', id);
    const lastCall = calls
      ? firstRow(db, 'SELECT created_at FROM call_logs WHERE lead_id = ? ORDER BY id DESC LIMIT 1', id)
      : null;
    if (tracking && calls > 0) {
      push(
        'call_tracking',
        'pass',
        `Tracking number ${tracking} assigned; ${calls} call(s) logged${lastCall ? `, latest ${String(lastCall.created_at).slice(0, 10)}` : ''}.`
      );
    } else if (tracking) {
      push(
        'call_tracking',
        'fail',
        `Tracking number ${tracking} assigned, but no calls are logged yet — the test call has not rung (or was not logged).`
      );
    } else {
      push('call_tracking', 'fail', 'No tracking number is assigned to this lead.');
    }
  }

  /* 6 — forms end-to-end: published form + a submission + a LeadScout
     capture for this lead. */
  {
    const publishedForms = count(
      db,
      "SELECT COUNT(*) AS c FROM contact_forms WHERE lead_id = ? AND (published = 1 OR status = 'published')",
      id
    );
    const submissions = count(db, 'SELECT COUNT(*) AS c FROM form_submissions WHERE lead_id = ?', id);
    const captures = count(db, 'SELECT COUNT(*) AS c FROM leadscout_events WHERE lead_id = ?', id);
    if (publishedForms > 0 && submissions > 0 && captures > 0) {
      push(
        'forms_verified',
        'pass',
        `${publishedForms} published form(s), ${submissions} submission(s) and ${captures} LeadScout capture(s) on file.`
      );
    } else {
      const missing = [];
      if (!publishedForms) missing.push('a published form');
      if (!submissions) missing.push('a form submission');
      if (!captures) missing.push('a LeadScout capture');
      push('forms_verified', 'fail', `Missing: ${missing.join(', ')}.`);
    }
  }

  /* 7 — domain linked + live: custom domain set on a published site.
     (cfDomains.verifyDomainResolves exists, but it needs the Pages
     project + registrar credentials and polls for up to ~20s — wrong
     shape for a checklist pass, so this stays a data check and the
     detail says exactly that.) */
  {
    const site = firstRow(db, 'SELECT status FROM websites WHERE lead_id = ?', id);
    // custom_domain is an ALTER-added column (cfDomains.ensureTables);
    // read it defensively in case an older DB predates the patch.
    const domainRow = firstRow(db, 'SELECT custom_domain FROM websites WHERE lead_id = ?', id);
    const domain = domainRow && domainRow.custom_domain ? String(domainRow.custom_domain).trim() : '';
    if (domain && site.status === 'published') {
      push(
        'domain_live',
        'pass',
        `Custom domain ${domain} is set and the site is published (data check — open the address to eyeball it).`
      );
    } else if (domain) {
      push('domain_live', 'fail', `Domain ${domain} is linked, but the site status is \u2018${site.status}\u2019, not published.`);
    } else {
      push('domain_live', 'fail', 'No custom domain is linked to this lead\u2019s site yet.');
    }
  }

  /* 8 — renewal mode: recorded on site_domains by domainRenewals. */
  {
    const rows = tableExists(db, 'site_domains')
      ? allRows(db, 'SELECT domain_name, renewal_mode FROM site_domains WHERE lead_id = ? ORDER BY id DESC', id)
      : [];
    const withMode = rows.find((r) => r.renewal_mode);
    if (withMode) {
      push('renewal_mode', 'pass', `Renewal mode recorded: \u2018${withMode.renewal_mode}\u2019 for ${withMode.domain_name}.`);
    } else if (rows.length) {
      push('renewal_mode', 'manual', 'A domain exists but no renewal mode has been recorded yet — check it and note it.');
    } else {
      push('renewal_mode', 'manual', 'No domain on this lead yet — nothing to check.');
    }
  }

  /* 9 — Google pieces: Place ID on the reviews config and/or a GBP
     change set drafted for the lead. */
  {
    let placeId = '';
    if (tableExists(db, 'googlereviews_configs')) {
      const cfg = firstRow(db, 'SELECT place_id FROM googlereviews_configs WHERE lead_id = ?', id);
      placeId = cfg ? String(cfg.place_id || '').trim() : '';
    }
    const changeSets = count(db, 'SELECT COUNT(*) AS c FROM gbp_change_sets WHERE lead_id = ?', id);
    if (placeId) {
      push(
        'google_pieces',
        'pass',
        `Google Place ID set${changeSets ? `; ${changeSets} Google Profile change set(s) drafted` : ''}.`
      );
    } else if (changeSets) {
      push('google_pieces', 'pass', `${changeSets} Google Profile change set(s) drafted; no Place ID set yet.`);
    } else {
      push('google_pieces', 'fail', 'No Place ID set and no Google Profile change set drafted yet.');
    }
  }

  /* 10 — billing: a paid domain transaction for the lead. (Platform
     subscriptions are per billing user, not per lead, so a lead with
     no transaction stays manual rather than guessing.) */
  const paidTxn = tableExists(db, 'domain_transactions')
    ? firstRow(
        db,
        "SELECT id, domain, status, paid_at FROM domain_transactions WHERE lead_id = ? AND (status = 'paid' OR paid_at IS NOT NULL) ORDER BY id DESC LIMIT 1",
        id
      )
    : null;
  const anyTxn = tableExists(db, 'domain_transactions')
    ? firstRow(db, 'SELECT id, domain, status FROM domain_transactions WHERE lead_id = ? ORDER BY id DESC LIMIT 1', id)
    : null;
  {
    if (paidTxn) {
      push(
        'billing_checked',
        'pass',
        `Domain transaction #${paidTxn.id} is ${paidTxn.status}${paidTxn.paid_at ? ` (paid ${String(paidTxn.paid_at).slice(0, 10)})` : ''} for ${paidTxn.domain}.`
      );
    } else if (anyTxn) {
      push('billing_checked', 'fail', `Latest domain transaction #${anyTxn.id} is \u2018${anyTxn.status}\u2019 — not paid.`);
    } else {
      push('billing_checked', 'manual', 'No domain transaction on file for this lead — check the subscription another way.');
    }
  }

  /* 11 — pack delivered: the payment-received email (which carries
     the onboarding pack link since Batch 73) is recorded as a
     'client_payment_email' step on the paid transaction. The client's
     own go-live checks half is a human confirmation — the detail
     says so even on a pass. */
  {
    let emailSent = false;
    if (paidTxn && tableExists(db, 'domain_transactions')) {
      const row = firstRow(db, 'SELECT steps_json FROM domain_transactions WHERE id = ?', paidTxn.id);
      try {
        const steps = JSON.parse((row && row.steps_json) || '[]');
        emailSent =
          Array.isArray(steps) && steps.some((s) => s && s.step === 'client_payment_email' && s.ok === true);
      } catch {
        emailSent = false;
      }
    }
    if (emailSent) {
      push(
        'pack_delivered',
        'pass',
        'The payment-received email (it carries the onboarding pack link) is recorded as sent. The client\u2019s own go-live checks are still yours to confirm.'
      );
    } else if (paidTxn) {
      push(
        'pack_delivered',
        'fail',
        'Payment landed, but the payment-received email is not recorded as sent — the pack may not have reached the client.'
      );
    } else {
      push('pack_delivered', 'manual', 'No paid transaction yet — pack delivery via the payment email cannot be proven.');
    }
  }

  /* 12 — two-week check-in: nothing in the schema records a per-lead
     follow-up appointment, so this is honestly manual. */
  push(
    'checkin_scheduled',
    'manual',
    'Nothing in the system records this — schedule the two-week check-in and tick it yourself.'
  );

  return out;
}

/**
 * Apply a fresh run's passes (Confirm). Only verdict==='pass' items
 * that are not already done are written, with via='autorun' and the
 * confirming staffer as actor. Returns the applied keys.
 */
function applyPasses(db, leadId, results, actor = {}) {
  const state = getState(db, leadId);
  const doneKeys = new Set(state.items.filter((i) => i.done).map((i) => i.key));
  const applied = [];
  for (const r of results || []) {
    if (r && r.verdict === 'pass' && ITEM_KEYS.has(r.key) && !doneKeys.has(r.key)) {
      setItem(db, leadId, r.key, true, actor, 'autorun');
      applied.push(r.key);
    }
  }
  return applied;
}

module.exports = {
  ITEMS,
  ensureTables,
  assertLead,
  getState,
  setItem,
  evaluate,
  applyPasses,
};
