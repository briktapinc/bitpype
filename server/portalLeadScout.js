'use strict';

/**
 * Batch 111 (consolidation step 4) — portal LeadScout contacts + change-request listing.
 * PURE code motion from server/clientPortal.js (no logic edits);
 * server/clientPortal.js re-exports the full original surface.
 */



function leadScoutScope(leadId, workspaceWide) {
  if (workspaceWide === true) return null;
  const id = Number(leadId);
  if (!Number.isInteger(id) || id <= 0) {
    throw Object.assign(new Error('Valid business scope required'), { code: 'FORBIDDEN', status: 403 });
  }
  return id;
}

/** The client's own change-request history (Changes panel), own-lead scoped. */
function listChangeRequests(workspaceId, leadId, opts = {}) {
  const domain = require('./domain');
  const designJobs = require('../src/designJobs');
  const scope = leadScoutScope(leadId, false);
  return domain.withDb(workspaceId, (db) => designJobs.listChangeRequests(db, scope, { limit: opts.limit }));
}

function listLeadScoutContacts(workspaceId, leadId, opts = {}, { workspaceWide = false } = {}) {
  const domain = require('./domain');
  const contacts = require('./portalContacts');
  return domain.withDb(workspaceId, (db) =>
    contacts.listContacts(db, {
      leadId: leadScoutScope(leadId, workspaceWide),
      q: opts.q || '',
      limit: opts.limit,
      offset: opts.offset,
    })
  );
}

function getLeadScoutContact(workspaceId, leadId, contactId, { workspaceWide = false } = {}) {
  const domain = require('./domain');
  const contacts = require('./portalContacts');
  const scope = leadScoutScope(leadId, workspaceWide);
  return domain.withDb(workspaceId, (db) => contacts.getContact(db, contactId, { leadId: scope }));
}

/** Batch 45 — LeadScout contact delete (lead-scoped from the portal; workspace-wide from staff). */
function deleteLeadScoutContact(workspaceId, leadId, contactId, { workspaceWide = false } = {}) {
  const domain = require('./domain');
  const contacts = require('./portalContacts');
  const scope = leadScoutScope(leadId, workspaceWide);
  return domain.withDb(workspaceId, (db) => contacts.deleteContact(db, contactId, { leadId: scope }));
}

/** Batch 45 — clear resolved LeadScout capture failures. */
function clearLeadScoutResolvedFailures(workspaceId, leadId, { workspaceWide = false } = {}) {
  const domain = require('./domain');
  const contacts = require('./portalContacts');
  const scope = leadScoutScope(leadId, workspaceWide);
  return domain.withDb(workspaceId, (db) => contacts.clearResolvedFailures(db, { leadId: scope }));
}

function leadScoutHealth(workspaceId, leadId, { workspaceWide = false } = {}) {
  const domain = require('./domain');
  const contacts = require('./portalContacts');
  const scope = leadScoutScope(leadId, workspaceWide);
  return domain.withDb(workspaceId, (db) => contacts.captureHealth(db, { leadId: scope }));
}

function retryLeadScoutFailures(workspaceId, leadId) {
  const domain = require('./domain');
  const contacts = require('./portalContacts');
  const scope = leadScoutScope(leadId, false);
  return domain.withDb(workspaceId, (db) => contacts.retryOpenFailures(db, { leadId: scope }));
}


module.exports = {
  listChangeRequests,
  listLeadScoutContacts,
  getLeadScoutContact,
  deleteLeadScoutContact,
  clearLeadScoutResolvedFailures,
  leadScoutHealth,
  retryLeadScoutFailures,
};
