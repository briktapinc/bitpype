'use strict';

/**
 * Owner email notifications for visitor-created records (Batch 21b).
 *
 * Ely's rule: EVERY visitor submission on a client site emails the
 * website owner. Contact forms always did (server/contactForms.js);
 * bookings, estimate requests, member signups, paid memberships and
 * shop orders created records silently. This module is the shared
 * notifier those paths fire after a record is created.
 *
 * Pattern mirrors server/callNotify.js (Batch 21): recipient
 * resolution reuses the form-alert chain exactly — the lead's form
 * notify_email (callNotify.resolveNotifyRecipient) falling back to
 * the lead's email — and sending uses the platform mail helper
 * (server/mailer.js sendPlatformMail). Both empty → skip silently
 * with a warning log. Mail failures are caught and reported in the
 * return value; nothing here ever throws into a visitor request or a
 * webhook, and no dedupe table is needed: each caller fires exactly
 * once per created record (the two Stripe webhooks gate on the
 * pending → paid / no-row → row transition before calling).
 */

const domain = require('./domain');
const mailer = require('./mailer');
const { resolveNotifyRecipient } = require('./callNotify');
const { appUrl } = require('./stripeClient');

function portalCta(label) {
  return { label, url: `${String(appUrl() || '').replace(/\/$/, '')}/portal` };
}

function money(cents, currency) {
  const n = Number(cents);
  if (!Number.isFinite(n)) return '';
  const label = `$${(n / 100).toFixed(2)}`;
  const cur = String(currency || 'USD').toUpperCase();
  return cur === 'USD' ? label : `${label} ${cur}`;
}

function line(label, value) {
  const v = String(value == null ? '' : value).trim();
  return v ? `${label}: ${v}` : null;
}

/**
 * Shared send path. `build(db)` returns
 * { leadId, subject, title?, paragraphs, cta } or null when the
 * record is gone. Resolves to { sent, reason? } and never rejects.
 */
async function dispatch(workspaceId, build) {
  try {
    const prep = domain.withDb(workspaceId, (db) => {
      const built = build(db);
      if (!built || !built.leadId) return null;
      return { ...built, recipient: resolveNotifyRecipient(db, built.leadId) };
    });
    if (!prep) return { sent: false, reason: 'not_found' };
    if (!prep.recipient) {
      console.warn('[ownerNotify] no owner email resolved for lead', prep.leadId, '— notification skipped');
      return { sent: false, reason: 'no_recipient' };
    }
    try {
      await mailer.sendPlatformMail({
        to: prep.recipient,
        subject: prep.subject,
        title: prep.title || prep.subject,
        paragraphs: prep.paragraphs,
        text: (prep.paragraphs || []).join('\n'),
        cta: prep.cta,
      });
      return { sent: true };
    } catch (e) {
      if (e && e.code === 'SMTP_NOT_CONFIGURED') {
        return { sent: false, reason: 'mail_not_configured' };
      }
      console.warn('[ownerNotify] send failed:', e && e.message);
      return { sent: false, reason: 'send_failed' };
    }
  } catch (e) {
    console.warn('[ownerNotify] failed:', e && e.message);
    return { sent: false, reason: 'error' };
  }
}

/** A visitor booked an appointment (bookings module). */
async function notifyOwnerOfBooking(workspaceId, bookingId) {
  return dispatch(workspaceId, (db) => {
    const row = db
      .prepare(
        `SELECT b.*, s.name AS service_name
           FROM bookings b
           LEFT JOIN booking_services s ON s.id = b.service_id
          WHERE b.id = ?`
      )
      .get(Number(bookingId));
    if (!row) return null;
    const when = String(row.starts_at || '')
      .replace('T', ' ')
      .slice(0, 16);
    const paragraphs = [
      'A visitor booked an appointment on your website.',
      line('Service', row.service_name || 'Appointment'),
      line('Customer', row.customer_name),
      line('Email', row.customer_email),
      line('Phone', row.customer_phone),
      line('When', when),
      line('Status', row.status === 'pending' ? 'pending — waiting for you to confirm' : row.status),
      line('Notes', row.notes),
    ].filter(Boolean);
    return {
      leadId: Number(row.lead_id),
      subject: 'New booking from your website',
      paragraphs,
      cta: portalCta('View bookings in your portal'),
    };
  });
}

/** A visitor submitted an instant-estimate request (estimate module). */
async function notifyOwnerOfEstimateRequest(workspaceId, requestId) {
  return dispatch(workspaceId, (db) => {
    const row = db
      .prepare('SELECT * FROM estimate_requests WHERE id = ?')
      .get(Number(requestId));
    if (!row) return null;
    let selections = [];
    try {
      const parsed = JSON.parse(String(row.selections_json || '[]'));
      if (Array.isArray(parsed)) selections = parsed;
    } catch {
      selections = [];
    }
    const selectionLines = selections.map((s) => {
      const bits = [String((s && s.label) || 'Option')];
      if (s && s.choice_label) bits.push(String(s.choice_label));
      let text = `Selected: ${bits.join(' — ')}`;
      if (s && s.quantity) text += ` × ${s.quantity}`;
      return text;
    });
    const paragraphs = [
      'A visitor requested an instant estimate on your website.',
      line('Name', row.name),
      line('Email', row.email),
      line('Phone', row.phone),
      ...selectionLines,
      line('Estimate', money(row.estimate_cents, 'USD')),
      line('Notes', row.notes),
    ].filter(Boolean);
    return {
      leadId: Number(row.lead_id),
      subject: 'New estimate request from your website',
      paragraphs,
      cta: portalCta('View estimate requests in your portal'),
    };
  });
}

/** A visitor created a member account (members module signup). */
async function notifyOwnerOfMemberSignup(workspaceId, memberId) {
  return dispatch(workspaceId, (db) => {
    const row = db.prepare('SELECT * FROM site_members WHERE id = ?').get(Number(memberId));
    if (!row) return null;
    const paragraphs = [
      'A visitor created a member account on your website.',
      line('Name', row.name),
      line('Email', row.email),
      line(
        'Status',
        row.status === 'pending' ? 'pending — waiting for your approval in the portal' : row.status
      ),
    ].filter(Boolean);
    return {
      leadId: Number(row.lead_id),
      subject: 'New member signup from your website',
      paragraphs,
      cta: portalCta('View members in your portal'),
    };
  });
}

/** A member's paid membership was created (membership Stripe webhook). */
async function notifyOwnerOfMembership(workspaceId, subscriptionId) {
  return dispatch(workspaceId, (db) => {
    const sub = db
      .prepare('SELECT * FROM member_subscriptions WHERE id = ?')
      .get(Number(subscriptionId));
    if (!sub) return null;
    let member = null;
    try {
      member = db.prepare('SELECT * FROM site_members WHERE id = ?').get(Number(sub.member_id));
    } catch {
      member = null;
    }
    const price = money(sub.price_cents, 'USD');
    const paragraphs = [
      'A member just joined a membership plan on your website.',
      line('Member', member ? member.name : ''),
      line('Email', member ? member.email : ''),
      line('Plan', sub.tier_name),
      line('Price', price ? `${price}${sub.interval ? ` / ${sub.interval}` : ''}` : ''),
      line('Status', sub.status),
    ].filter(Boolean);
    return {
      leadId: Number(sub.lead_id),
      subject: 'New membership from your website',
      paragraphs,
      cta: portalCta('View memberships in your portal'),
    };
  });
}

/** A shop order was paid (shop Stripe webhook, pending → paid only). */
async function notifyOwnerOfShopOrder(workspaceId, orderId) {
  return dispatch(workspaceId, (db) => {
    const row = db.prepare('SELECT * FROM ecommerce_orders WHERE id = ?').get(Number(orderId));
    if (!row) return null;
    const paragraphs = [
      'A customer just placed an order on your website.',
      line('Product', row.product_name),
      line('Total', money(row.amount_cents, row.currency)),
      line('Customer email', row.customer_email),
      line('Order', `#${row.id}`),
    ].filter(Boolean);
    return {
      leadId: Number(row.lead_id),
      subject: 'New order from your website',
      paragraphs,
      cta: portalCta('View orders in your portal'),
    };
  });
}

module.exports = {
  notifyOwnerOfBooking,
  notifyOwnerOfEstimateRequest,
  notifyOwnerOfMemberSignup,
  notifyOwnerOfMembership,
  notifyOwnerOfShopOrder,
};
