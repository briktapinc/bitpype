'use strict';

/**
 * Batch 194 — Student → Owner conversion on package sign-up.
 *
 * A 'student' portal user (server/portalTabs.js) sees only Training
 * and Packages. When that student COMPLETES a package sign-up — a
 * subscription checkout for their own billing user — their portal
 * user_type flips student → owner, giving them the full client
 * portal. The flip is written to the platform audit log.
 *
 * Entry points (both best-effort hooks in server/billing.js, so a
 * conversion failure can never fail a webhook):
 *   - onCheckoutCompleted(session): checkout.session.completed /
 *     async_payment_succeeded for a subscription-mode session. The
 *     session metadata carries user_id (stamped by
 *     billing.createCheckoutSession) — that is the billing user.
 *   - onSubscriptionActive(sub): a subscription carrying
 *     metadata.user_id reaching active/trialing (covers the
 *     startOrChangePlan update path, which has no checkout session).
 *
 * Resolution: billing user id → users.email → client_portal_users
 * rows with that email AND user_type='student'. Matching is by the
 * billing user's OWN email only — a student is never converted by
 * somebody else's purchase. Idempotent: converted rows are no longer
 * 'student', so webhook redeliveries are no-ops. A failed/abandoned
 * checkout produces neither event, so nothing changes.
 */

const { query } = require('./db');

async function convertStudentForBillingUser(billingUserId, source) {
  const uid = Number(billingUserId);
  if (!uid) return { converted: [] };
  const users = await query('SELECT id, email FROM users WHERE id = :id LIMIT 1', { id: uid });
  const email =
    users && users[0]
      ? String(users[0].email || '')
          .trim()
          .toLowerCase()
      : '';
  if (!email) return { converted: [] };
  const students = await query(
    "SELECT id, email, workspace_id FROM client_portal_users WHERE LOWER(email) = :email AND user_type = 'student'",
    { email }
  );
  const converted = [];
  for (const row of students || []) {
    await query("UPDATE client_portal_users SET user_type = 'owner' WHERE id = :id AND user_type = 'student'", {
      id: Number(row.id),
    });
    converted.push(Number(row.id));
    try {
      await require('./platform').audit(
        null,
        'portal_user.student_converted',
        `portalUserId=${Number(row.id)} email=${row.email} billingUserId=${uid} via=${String(source || 'checkout').slice(0, 40)}`
      );
    } catch {
      /* audit is best-effort everywhere */
    }
  }
  return { converted };
}

async function onCheckoutCompleted(session) {
  try {
    if (!session || typeof session !== 'object') return { converted: [] };
    if (session.mode && session.mode !== 'subscription') return { converted: [] };
    const userRef = (session.metadata && session.metadata.user_id) || session.client_reference_id || null;
    if (!userRef) return { converted: [] };
    return await convertStudentForBillingUser(userRef, 'checkout.session.completed');
  } catch (e) {
    console.warn('[studentConversion] checkout hook:', e.message);
    return { converted: [] };
  }
}

async function onSubscriptionActive(sub) {
  try {
    if (!sub || typeof sub !== 'object') return { converted: [] };
    const status = String(sub.status || '');
    if (status !== 'active' && status !== 'trialing') return { converted: [] };
    const userRef = sub.metadata && sub.metadata.user_id;
    if (!userRef) return { converted: [] };
    return await convertStudentForBillingUser(userRef, 'subscription.active');
  } catch (e) {
    console.warn('[studentConversion] subscription hook:', e.message);
    return { converted: [] };
  }
}

module.exports = { convertStudentForBillingUser, onCheckoutCompleted, onSubscriptionActive };
