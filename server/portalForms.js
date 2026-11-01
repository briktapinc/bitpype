// @ts-check
'use strict';

/**
 * Batch 111 (consolidation step 4) — portal contact forms + submissions CRUD and form-site rematerialisation.
 * PURE code motion from server/clientPortal.js (no logic edits);
 * server/clientPortal.js re-exports the full original surface.
 */

const { appUrl } = require('./stripeClient');

async function listContactForms(workspaceId, leadId, clientEmail) {
  const domain = require('./domain');
  const forms = require('./contactForms');
  const { appUrl } = require('./stripeClient');
  return domain.withDb(workspaceId, (db) => {
    const list = forms.listFormsForLead(db, Number(leadId), clientEmail);
    const pages = forms.listSitePages(db, Number(leadId));
    return {
      forms: list.map((form) => ({ form, embed: forms.embedSnippet(form, appUrl()) })),
      pages,
      workspaceId: Number(workspaceId),
    };
  });
}

async function getContactForm(workspaceId, leadId, clientEmail, formId) {
  const domain = require('./domain');
  const forms = require('./contactForms');
  const { appUrl } = require('./stripeClient');
  return domain.withDb(workspaceId, (db) => {
    const form =
      formId != null
        ? forms.getFormById(db, Number(leadId), Number(formId))
        : forms.getFormForLead(db, Number(leadId), clientEmail);
    const pages = forms.listSitePages(db, Number(leadId));
    const embed = forms.embedSnippet(form, appUrl());
    return { form, embed, pages, workspaceId: Number(workspaceId) };
  });
}

async function createContactForm(workspaceId, leadId, body, clientEmail) {
  const domain = require('./domain');
  const forms = require('./contactForms');
  const { appUrl } = require('./stripeClient');
  return domain.withDb(workspaceId, (db) => {
    const form = forms.createForm(
      db,
      Number(leadId),
      Object.assign({}, body || {}, {
        notify_email: (body && body.notify_email) != null ? body.notify_email : clientEmail,
      })
    );
    const pages = forms.listSitePages(db, Number(leadId));
    return { form, embed: forms.embedSnippet(form, appUrl()), pages, workspaceId: Number(workspaceId) };
  });
}

async function saveContactForm(workspaceId, leadId, patch, clientEmail, formId) {
  const domain = require('./domain');
  const forms = require('./contactForms');
  const { appUrl } = require('./stripeClient');
  const id = formId != null ? Number(formId) : patch && patch.id != null ? Number(patch.id) : null;
  return domain.withDb(workspaceId, (db) => {
    const form = forms.saveForm(
      db,
      Number(leadId),
      id,
      Object.assign({}, patch || {}, {
        notify_email: patch && patch.notify_email != null ? patch.notify_email : clientEmail,
      })
    );
    try {
      if (form.published) {
        forms.syncSiteFormEmbeds(db, Number(leadId));
        const site = db
          .prepare('SELECT id FROM websites WHERE lead_id = ? AND archived_at IS NULL ORDER BY id DESC LIMIT 1')
          .get(Number(leadId));
        if (site) rematerializeFormSite(db, workspaceId, site.id);
      }
    } catch {
      /* optional */
    }
    const pages = forms.listSitePages(db, Number(leadId));
    return { form, embed: forms.embedSnippet(form, appUrl()), pages, workspaceId: Number(workspaceId) };
  });
}

async function deleteContactForm(workspaceId, leadId, formId) {
  const domain = require('./domain');
  const forms = require('./contactForms');
  return domain.withDb(workspaceId, (db) => {
    const result = forms.deleteForm(db, Number(leadId), Number(formId));
    try {
      const site = db.prepare('SELECT id FROM websites WHERE lead_id = ? AND archived_at IS NULL ORDER BY id DESC LIMIT 1').get(Number(leadId));
      if (site) rematerializeFormSite(db, workspaceId, site.id);
    } catch {
      /* optional */
    }
    return result;
  });
}

function rematerializeFormSite(db, workspaceId, siteId) {
  try {
    const domain = require('./domain');
    domain.materializeWebsiteExport(db, workspaceId, siteId);
  } catch (e) {
    console.warn('[clientPortal] rematerialize form site:', e.message);
  }
}

/**
 * Rematerialize local export, then force Cloudflare/app preview so live Pages
 * HTML matches portal form/module attach (not just /site-previews).
 */
async function publishLiveAfterEmbed(workspaceId, siteId) {
  const domain = require('./domain');
  const id = Number(siteId);
  if (!Number.isInteger(id) || id < 1) return null;
  try {
    return await domain.sitesPreview(workspaceId, id, { force: true });
  } catch (e) {
    console.warn('[clientPortal] live publish after embed:', e.message);
    try {
      domain.withDb(workspaceId, (db) => rematerializeFormSite(db, workspaceId, id));
    } catch {
      /* best-effort local export */
    }
    return null;
  }
}

async function publishContactForm(workspaceId, leadId, opts = {}, formId) {
  const domain = require('./domain');
  const forms = require('./contactForms');
  const { appUrl } = require('./stripeClient');
  const id = formId != null ? Number(formId) : opts.formId != null ? Number(opts.formId) : null;
  const packed = domain.withDb(workspaceId, (db) => {
    // Persist attachment settings before publish when provided.
    if (id != null && (opts.embed_on_page != null || opts.embed_enabled != null || opts.target_page_slug != null)) {
      forms.saveForm(db, Number(leadId), id, {
        embed_enabled: opts.embed_enabled != null ? opts.embed_enabled : opts.embed_on_page,
        target_page_slug: opts.target_page_slug,
      });
    }
    const form = forms.publishForm(db, Number(leadId), {
      formId: id,
      toSite: opts.toSite,
      workspaceId: Number(workspaceId),
    });
    const site = db.prepare('SELECT id FROM websites WHERE lead_id = ? AND archived_at IS NULL ORDER BY id DESC LIMIT 1').get(Number(leadId));
    const pages = forms.listSitePages(db, Number(leadId));
    return {
      form,
      embed: forms.embedSnippet(form, appUrl()),
      pages,
      workspaceId: Number(workspaceId),
      siteId: site && site.id,
    };
  });
  let preview = null;
  if (packed.siteId) {
    preview = await publishLiveAfterEmbed(workspaceId, packed.siteId);
  }
  return {
    form: packed.form,
    embed: packed.embed,
    pages: packed.pages,
    workspaceId: packed.workspaceId,
    previewUrl: preview && preview.url,
    via: preview && preview.via,
    publicPreviewUpdated: !!(preview && (preview.via === 'cloudflare' || preview.via === 'app_url')),
  };
}

async function listFormSubmissions(workspaceId, leadId, opts = {}) {
  const domain = require('./domain');
  const forms = require('./contactForms');
  const billing = require('./billing');
  const { getPlan } = require('./plans');
  const planId = await billing.effectivePlan(workspaceId, { email: opts.clientEmail });
  const ent = getPlan(planId).entitlements;
  if (!ent.formInbox) {
    return {
      plan: planId,
      inbox: false,
      notice: 'On Free, form submissions are emailed only. Upgrade to a paid plan (Standard, Pro, or Premium) for a portal inbox.',
      submissions: [],
    };
  }
  return domain.withDb(workspaceId, (db) => {
    const data = forms.listSubmissions(db, Number(leadId), {
      limit: opts.limit,
      offset: opts.offset,
      formId: opts.formId,
    });
    return { plan: planId, inbox: true, ...data };
  });
}

async function getFormSubmission(workspaceId, leadId, submissionId, clientEmail = '') {
  const domain = require('./domain');
  const forms = require('./contactForms');
  const billing = require('./billing');
  const { getPlan } = require('./plans');
  const planId = await billing.effectivePlan(workspaceId, { email: clientEmail });
  if (!getPlan(planId).entitlements.formInbox) {
    throw Object.assign(new Error('Form inbox requires a paid plan (Standard, Pro, or Premium)'), { code: 'FORBIDDEN', status: 403 });
  }
  return domain.withDb(workspaceId, (db) => forms.getSubmission(db, Number(leadId), Number(submissionId)));
}

/** Batch 45 — portal hard-delete of one form submission (spam/test cleanup). */
async function deleteFormSubmission(workspaceId, leadId, submissionId, clientEmail = '') {
  const domain = require('./domain');
  const forms = require('./contactForms');
  const billing = require('./billing');
  const { getPlan } = require('./plans');
  const planId = await billing.effectivePlan(workspaceId, { email: clientEmail });
  if (!getPlan(planId).entitlements.formInbox) {
    throw Object.assign(new Error('Form inbox requires a paid plan (Standard, Pro, or Premium)'), { code: 'FORBIDDEN', status: 403 });
  }
  return domain.withDb(workspaceId, (db) => forms.deleteSubmission(db, Number(leadId), Number(submissionId)));
}

/** Batch 45 — portal bulk delete of form submissions. */
async function deleteFormSubmissions(workspaceId, leadId, ids, clientEmail = '') {
  const domain = require('./domain');
  const forms = require('./contactForms');
  const billing = require('./billing');
  const { getPlan } = require('./plans');
  const planId = await billing.effectivePlan(workspaceId, { email: clientEmail });
  if (!getPlan(planId).entitlements.formInbox) {
    throw Object.assign(new Error('Form inbox requires a paid plan (Standard, Pro, or Premium)'), { code: 'FORBIDDEN', status: 403 });
  }
  return domain.withDb(workspaceId, (db) => forms.deleteSubmissions(db, Number(leadId), Array.isArray(ids) ? ids : []));
}


module.exports = {
  listContactForms,
  getContactForm,
  createContactForm,
  saveContactForm,
  deleteContactForm,
  publishContactForm,
  listFormSubmissions,
  getFormSubmission,
  deleteFormSubmission,
  deleteFormSubmissions,
  publishLiveAfterEmbed,
};
