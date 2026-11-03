// @ts-check
'use strict';

/**
 * Batch 111 (consolidation step 4) — portal site modules: items CRUD, per-module admin settings (chatbot, bookings, estimate, social feed, datatables, call tracking, SEO, offers, members, shop keys), attach/detach, client MCP tokens.
 * PURE code motion from server/clientPortal.js (no logic edits);
 * server/clientPortal.js re-exports the full original surface.
 */

const { query, driver } = require('./db');
const { appUrl } = require('./stripeClient');
const { publishLiveAfterEmbed } = require('./portalForms');

async function requireSiteModules(workspaceId, clientEmail) {
  const billing = require('./billing');
  const { getPlan } = require('./plans');
  const planId = await billing.effectivePlan(workspaceId, { email: clientEmail });
  const ent = getPlan(planId).entitlements;
  if (!ent.siteModules) {
    throw Object.assign(new Error('Site modules require a paid plan (Standard, Pro, or Premium). Upgrade in Billing.'), {
      code: 'PLAN_REQUIRED',
      status: 403,
      plan: planId,
    });
  }
  return planId;
}

async function listSiteModules(workspaceId, leadId, clientEmail) {
  const domain = require('./domain');
  const modules = require('./siteModules');
  const billing = require('./billing');
  const { getPlan } = require('./plans');
  const { appUrl } = require('./stripeClient');
  const planId = await billing.effectivePlan(workspaceId, { email: clientEmail });
  const ents = getPlan(planId).entitlements;
  const siteModules = !!ents.siteModules;
  return domain.withDb(workspaceId, (db) => ({
    plan: planId,
    chatbot: !!ents.chatbot,
    ...modules.portalSummary(db, Number(leadId), { appUrl: appUrl(), siteModules }),
  }));
}

async function listModuleItems(workspaceId, leadId, moduleType, clientEmail, opts = {}) {
  const domain = require('./domain');
  const modules = require('./siteModules');
  const { appUrl } = require('./stripeClient');
  const planId = await requireSiteModules(workspaceId, clientEmail);
  const type = String(moduleType || '').toLowerCase();
  const includeArchived = !!(opts && opts.includeArchived);
  return domain.withDb(workspaceId, async (db) => {
    modules.ensureTables(db);
    let items = [];
    let blogTotal = null;
    let booking = null;
    let menu = null;
    let estimate = null;
    let socialfeed = null;
    let googlereviews = null;
    let calltracking = null;
    let members = null;
    let shop = null;
    let datatable = null;
    let charts = null;
    let newsletter = null;
    let taxonomy = null;
    let photocapture = null;
    if (type === 'blog') {
      // Batch 45: server-side paging when the caller asks for a page
      // (portal blog tab); no limit = the historical full list.
      const blogLimit = opts && opts.limit != null ? Number(opts.limit) : null;
      items = modules.listBlogPosts(db, Number(leadId), {
        limit: blogLimit,
        offset: opts && opts.offset != null ? Number(opts.offset) : 0,
      });
      blogTotal = modules.countBlogPosts(db, Number(leadId));
    }
    else if (type === 'ecommerce') {
      items = modules.listProducts(db, Number(leadId)).map((p) => ({
        ...p,
        price_label: modules.formatPrice(p.price_cents, p.currency),
      }));
      // Shop → Payments (Batch 19): the owner's own-Stripe status, the
      // workspace fallback state, and which source checkout would use.
      const shopStripe = require('./shopStripe');
      const payments = modules.shopStripeStatus(db, Number(leadId));
      const workspaceConfigured = shopStripe.isConfigured(db);
      shop = {
        payments,
        workspace_configured: workspaceConfigured,
        effective_source: payments.connected ? 'lead' : workspaceConfigured ? 'workspace' : 'none',
        webhook_path: `/api/v1/shop/webhook/${Number(workspaceId)}`,
      };
    } else if (type === 'courses') items = modules.listCourses(db, Number(leadId));
    else if (type === 'gallery') items = modules.listAlbums(db, Number(leadId));
    else if (type === 'directory') items = modules.listListings(db, Number(leadId));
    else if (type === 'faq') items = modules.listFaqItems(db, Number(leadId));
    else if (type === 'testimonials') items = modules.listTestimonials(db, Number(leadId));
    else if (type === 'team') items = modules.listTeamMembers(db, Number(leadId));
    else if (type === 'events') items = modules.listEvents(db, Number(leadId));
    else if (type === 'bookings') {
      modules.ensureDefaultBookingHours(db, Number(leadId));
      items = modules.listBookingServices(db, Number(leadId));
      booking = {
        settings: modules.getBookingSettings(db, Number(leadId)),
        hours: modules.listBookingHours(db, Number(leadId)),
        appointments: modules.listAppointments(db, Number(leadId), {
          limit: 100,
          includeArchived,
        }),
        // Nav badge source of truth: never includes archived.
        active_appointment_count: modules.moduleItemCount(db, Number(leadId), 'bookings'),
        blocks: modules.listBookingBlocks(db, Number(leadId)),
      };
    } else if (type === 'offers') items = modules.listOffers(db, Number(leadId));
    else if (type === 'menu') {
      items = modules.listMenuItems(db, Number(leadId));
      menu = { categories: modules.listMenuCategories(db, Number(leadId)) };
    } else if (type === 'careers') items = modules.listCareersPostings(db, Number(leadId));
    else if (type === 'video') items = modules.listVideoItems(db, Number(leadId));
    else if (type === 'estimate') {
      items = modules.listEstimateOptions(db, Number(leadId));
      estimate = {
        config: modules.getEstimateConfig(db, Number(leadId)),
        requests: modules.listEstimateRequests(db, Number(leadId), { limit: 100 }),
      };
    } else if (type === 'socialfeed') {
      // Automatic module: no items to manage — the panel shows the feed
      // config plus a preview of exactly what will render.
      items = [];
      socialfeed = modules.socialFeedPreview(db, Number(leadId));
    } else if (type === 'googlereviews') {
      // Automatic module (Batch 30): no items to manage — the panel
      // shows the Place ID config, the connection state in plain words,
      // and the cached reviews exactly as they will render.
      items = [];
      googlereviews = await modules.googleReviewsPreview(db, Number(leadId));
    } else if (type === 'calltracking') {
      // Automatic module (Batch 25c split): the client panel carries
      // ONLY their own phone number (the one field they control), the
      // read-only answered-call billing line, and every call received
      // (newest first). Batch 26b adds the public display number when
      // one is assigned so the client can save that website number as
      // a phone contact. Forwarding configuration — redirect,
      // recording, notify, webhook — is admin-only and is never
      // exposed here.
      items = [];
      const ctConfig = modules.getCallTrackingConfig(db, Number(leadId));
      const displayNumber = String(ctConfig.display_number || '').trim();
      const leadRow = db.prepare('SELECT phone FROM leads WHERE id = ?').get(Number(leadId));
      calltracking = {
        phone_number: leadRow && leadRow.phone ? String(leadRow.phone) : '',
        // Batch 76: the owner's Missed-Call Rescue opt-in rides the
        // same panel (the one toggle they control; engine settings
        // stay admin-side). Lazy require — callRescue sits above
        // siteModules/portalContacts, never the reverse at load time.
        rescue_enabled: !!require('./callRescue').getRescueConfig(db, Number(leadId)).enabled,
        tracking_assigned: !!displayNumber,
        ...(displayNumber ? { display_number: displayNumber } : {}),
        calls: modules.listCalls(db, Number(leadId), {
          limit: opts && opts.limit != null ? Number(opts.limit) : 200,
          offset: opts && opts.offset != null ? Number(opts.offset) : 0,
        }),
        billing: modules.callBillingSummary(db, Number(leadId), planId),
        workspace_id: Number(workspaceId),
      };
    } else if (type === 'members') {
      // Members join from the public site; the panel carries the gating
      // config plus the member list (password hashes never leave the server),
      // the paid tiers, the owner's own-Stripe status, and the revenue line.
      items = [];
      members = {
        config: modules.getMembersConfig(db, Number(leadId)),
        members: modules.listSiteMembers(db, Number(leadId), {
          limit: opts && opts.limit != null ? Number(opts.limit) : 200,
          offset: opts && opts.offset != null ? Number(opts.offset) : 0,
        }),
        counts: modules.countSiteMembers(db, Number(leadId)),
        tiers: modules.listMembershipTiers(db, Number(leadId), { includeInactive: true }),
        payments: modules.membershipStripeStatus(db, Number(leadId)),
        revenue: modules.membershipRevenueSummary(db, Number(leadId)),
        webhook_path: `/api/v1/membership/webhook/${Number(workspaceId)}`,
      };
    }
    else if (type === 'datatables') {
      // Batch 88: rows ride the generic item CRUD with flattened,
      // editor-friendly cell strings (the typed values stay under
      // `values`); the config block drives the panel + dynamic fields.
      const table = modules.getDataTable(db, Number(leadId));
      const cols = table.columns || [];
      items = table.rows.map((r) => {
        const flat = {
          id: r.id,
          sort_order: r.sort_order,
          status: r.status,
          source: r.source,
          values: r.values,
        };
        for (const col of cols) {
          const v = r.values ? r.values[col.key] : null;
          if (v == null) flat[col.key] = '';
          else if (col.type === 'boolean') flat[col.key] = v ? 'Yes' : 'No';
          else if (col.type === 'link') flat[col.key] = typeof v === 'object' ? String(v.url || '') : String(v);
          else flat[col.key] = String(v);
        }
        return flat;
      });
      datatable = {
        title: table.title,
        columns: table.columns,
        template: table.template,
        roles: table.roles,
        submit_mode: table.submit_mode,
        submit_fields: table.submit_fields,
        submit_fields_configured: table.submit_fields_configured,
        row_count: table.row_count,
        pending_count: table.pending_count,
      };
    }
    else if (type === 'charts') {
      // Batch 90: each chart is one item in the routed editor — scalar
      // fields flattened to editor-friendly strings (the typed
      // definition rides along), with the computed data the public
      // site will draw. The charts block carries the Data Table's
      // columns so the editor can offer binding pickers.
      const mod = modules.getChartsModule(db, Number(leadId));
      items = mod.charts.map((c) => ({
        id: c.id,
        title: c.title,
        chart_type: c.chart_type,
        source: c.source,
        label_column: c.label_column || '',
        value_columns: (c.value_columns || []).join(', '),
        aggregation: c.aggregation,
        colors: (c.colors || []).join(', '),
        show_legend: c.show_legend ? 'Yes' : 'No',
        show_values: c.show_values ? 'Yes' : 'No',
        series_names: (c.data.series || []).map((s) => s.name).join(', '),
        data_text: modules.chartDataToText(c.data),
        sort_order: c.sort_order,
        definition: c,
        computed: c.computed,
      }));
      charts = {
        chart_count: mod.chart_count,
        datatable_configured: mod.datatable.configured,
        datatable_title: mod.datatable.title,
        datatable_columns: mod.datatable.columns,
      };
    }
    else if (type === 'newsletter') {
      // Batch 118: automatic module — no items to manage. The panel
      // carries the config, counts, the resolved effective From (the
      // portal shows exactly what a send will use), recent sends and
      // the first page of subscribers; the dedicated /modules/
      // newsletter/* routes serve paging and every write.
      items = [];
      const nl = require('./newsletter');
      const cfg = nl.getConfig(db, Number(leadId));
      const leadRow = db.prepare('SELECT business_name FROM leads WHERE id = ?').get(Number(leadId));
      newsletter = {
        config: cfg,
        counts: nl.countSubscribers(db, Number(leadId)),
        from: await nl.resolveFrom(workspaceId, Number(leadId), { config: cfg }),
        sends: nl.listSends(db, Number(leadId), { limit: 20 }),
        subscribers: nl.listSubscribers(db, Number(leadId), { limit: 50, offset: 0 }),
        business_name: (leadRow && leadRow.business_name) || '',
      };
    }
    else if (type === 'photocapture') {
      // Batch 125: capture module — no owner-authored items. The panel
      // carries the config, the moderation counts, the newest
      // submissions and the gallery albums (for Add to gallery);
      // writes ride the dedicated /modules/photocapture/* routes.
      items = [];
      photocapture = {
        config: modules.getPhotoCaptureConfig(db, Number(leadId)),
        counts: modules.countPhotoSubmissions(db, Number(leadId)),
        submissions: modules.listPhotoSubmissions(db, Number(leadId), { limit: 100 }),
        albums: modules.listAlbums(db, Number(leadId), { withImages: false }),
      };
    }
    else if (type === 'chatbot') {
      const chat = require('./chatbot');
      const summary = chat.portalChatbotSummary(db, Number(leadId));
      const emb = modules.getEmbedRow(db, Number(leadId), type);
      return {
        module_type: type,
        items: summary.knowledge || [],
        embed: modules.publicEmbed(emb, appUrl()),
        pages: modules.listSitePages(db, Number(leadId)),
        chatbot: summary,
      };
    }
    else if (type === 'categories') {
      // Batch 124: the shared taxonomy — items are the categories
      // themselves (every scope, drafts included, with assignment
      // counts); the block carries the module's display-scope config.
      items = require('./categories').listCategories(db, Number(leadId));
      taxonomy = { scopes: modules.getCategoriesScopes(db, Number(leadId)) };
    } else throw Object.assign(new Error('Unknown module type'), { code: 'VALIDATION', status: 400 });
    const emb = modules.getEmbedRow(db, Number(leadId), type);
    const out = {
      module_type: type,
      items,
      embed: modules.publicEmbed(emb, appUrl()),
      pages: modules.listSitePages(db, Number(leadId)),
    };
    if (blogTotal != null) out.total = blogTotal;
    if (booking) out.booking = booking;
    if (menu) out.categories = menu.categories;
    if (estimate) out.estimate = estimate;
    if (socialfeed) out.socialfeed = socialfeed;
    if (googlereviews) out.googlereviews = googlereviews;
    if (calltracking) out.calltracking = calltracking;
    if (members) out.members = members;
    if (shop) out.shop = shop;
    if (datatable) out.datatable = datatable;
    if (charts) out.charts = charts;
    if (newsletter) out.newsletter = newsletter;
    if (taxonomy) out.taxonomy = taxonomy;
    if (photocapture) out.photocapture = photocapture;
    return out;
  });
}

async function createModuleItem(workspaceId, leadId, moduleType, body, clientEmail) {
  const domain = require('./domain');
  const modules = require('./siteModules');
  await requireSiteModules(workspaceId, clientEmail);
  const type = String(moduleType || '').toLowerCase();
  return domain.withDb(workspaceId, (db) => {
    let item;
    if (type === 'blog') item = modules.createBlogPost(db, Number(leadId), body || {});
    else if (type === 'ecommerce') item = modules.createProduct(db, Number(leadId), body || {});
    else if (type === 'courses') item = modules.createCourse(db, Number(leadId), body || {});
    else if (type === 'gallery') item = modules.createAlbum(db, Number(leadId), body || {});
    else if (type === 'directory') item = modules.createListing(db, Number(leadId), body || {});
    else if (type === 'faq') item = modules.createFaqItem(db, Number(leadId), body || {});
    else if (type === 'testimonials') item = modules.createTestimonial(db, Number(leadId), body || {});
    else if (type === 'team') item = modules.createTeamMember(db, Number(leadId), body || {});
    else if (type === 'events') item = modules.createEvent(db, Number(leadId), body || {});
    else if (type === 'bookings') item = modules.createBookingService(db, Number(leadId), body || {});
    else if (type === 'offers') item = modules.createOffer(db, Number(leadId), body || {});
    else if (type === 'menu') item = modules.createMenuItem(db, Number(leadId), body || {});
    else if (type === 'careers') item = modules.createCareersPosting(db, Number(leadId), body || {});
    else if (type === 'video') item = modules.createVideoItem(db, Number(leadId), body || {});
    else if (type === 'estimate') item = modules.createEstimateOption(db, Number(leadId), body || {});
    else if (type === 'datatables')
      item = modules.createDataTableRow(db, Number(leadId), {
        values: body && body.values != null ? body.values : body || {},
        status: body && body.status,
        sort_order: body && body.sort_order,
      });
    else if (type === 'charts') item = modules.createChart(db, Number(leadId), body || {});
    else if (type === 'categories') item = require('./categories').createCategory(db, Number(leadId), body || {});
    else if (type === 'socialfeed')
      throw Object.assign(new Error('Social Feed updates itself from your social posts — there are no items to add.'), {
        code: 'VALIDATION',
        status: 400,
      });
    else if (type === 'calltracking')
      throw Object.assign(
        new Error('Call Tracking is automatic — calls land here on their own. Use the Calls tab to set your phone number.'),
        { code: 'VALIDATION', status: 400 }
      );
    else if (type === 'newsletter')
      throw Object.assign(
        new Error('Newsletter subscribers join from your website’s signup block — use the Newsletter tab to add one by hand.'),
        { code: 'VALIDATION', status: 400 }
      );
    else if (type === 'photocapture')
      throw Object.assign(
        new Error('Photos arrive from your website’s Photo Capture block — there is nothing to add by hand. Use the Photos tab to review them.'),
        { code: 'VALIDATION', status: 400 }
      );
    else if (type === 'members')
      throw Object.assign(
        new Error('Members join from your website’s Members page — there is nothing to add here. Use the Members tab to approve or manage them.'),
        { code: 'VALIDATION', status: 400 }
      );
    else if (type === 'chatbot') {
      const chat = require('./chatbot');
      item = chat.addKnowledge(db, Number(leadId), body || {});
    } else throw Object.assign(new Error('Unknown module type'), { code: 'VALIDATION', status: 400 });
    return { item, module_type: type };
  });
}

async function updateModuleItem(workspaceId, leadId, moduleType, id, body, clientEmail) {
  const domain = require('./domain');
  const modules = require('./siteModules');
  await requireSiteModules(workspaceId, clientEmail);
  const type = String(moduleType || '').toLowerCase();
  return domain.withDb(workspaceId, (db) => {
    let item;
    if (type === 'blog') item = modules.updateBlogPost(db, Number(leadId), id, body || {});
    else if (type === 'ecommerce') item = modules.updateProduct(db, Number(leadId), id, body || {});
    else if (type === 'courses') item = modules.updateCourse(db, Number(leadId), id, body || {});
    else if (type === 'gallery') item = modules.updateAlbum(db, Number(leadId), id, body || {});
    else if (type === 'directory') item = modules.updateListing(db, Number(leadId), id, body || {});
    else if (type === 'faq') item = modules.updateFaqItem(db, Number(leadId), id, body || {});
    else if (type === 'testimonials') item = modules.updateTestimonial(db, Number(leadId), id, body || {});
    else if (type === 'team') item = modules.updateTeamMember(db, Number(leadId), id, body || {});
    else if (type === 'events') item = modules.updateEvent(db, Number(leadId), id, body || {});
    else if (type === 'bookings') item = modules.updateBookingService(db, Number(leadId), id, body || {});
    else if (type === 'offers') item = modules.updateOffer(db, Number(leadId), id, body || {});
    else if (type === 'menu') item = modules.updateMenuItem(db, Number(leadId), id, body || {});
    else if (type === 'careers') item = modules.updateCareersPosting(db, Number(leadId), id, body || {});
    else if (type === 'video') item = modules.updateVideoItem(db, Number(leadId), id, body || {});
    else if (type === 'estimate') item = modules.updateEstimateOption(db, Number(leadId), id, body || {});
    else if (type === 'datatables') item = modules.updateDataTableRow(db, Number(leadId), id, body || {});
    else if (type === 'charts') item = modules.updateChart(db, Number(leadId), id, body || {});
    else if (type === 'categories') item = require('./categories').updateCategory(db, Number(leadId), id, body || {});
    else if (type === 'socialfeed')
      throw Object.assign(new Error('Social Feed updates itself from your social posts — there are no items to edit.'), {
        code: 'VALIDATION',
        status: 400,
      });
    else if (type === 'calltracking')
      throw Object.assign(
        new Error('Call Tracking is automatic — use the Calls tab to set your phone number.'),
        { code: 'VALIDATION', status: 400 }
      );
    else if (type === 'newsletter')
      throw Object.assign(
        new Error('Newsletter subscribers are managed in the Newsletter tab — there are no items to edit here.'),
        { code: 'VALIDATION', status: 400 }
      );
    else if (type === 'photocapture')
      throw Object.assign(
        new Error('Photo submissions are moderated in the Photos tab — there are no items to edit here.'),
        { code: 'VALIDATION', status: 400 }
      );
    else if (type === 'members') {
      // The only member "edit" from the portal is a status change
      // (approve / disable / reactivate) — enforced by setSiteMemberStatus.
      item = modules.setSiteMemberStatus(db, Number(leadId), id, (body || {}).status);
    } else if (type === 'chatbot') {
      const chat = require('./chatbot');
      item = chat.updateKnowledge(db, Number(leadId), id, body || {});
    } else throw Object.assign(new Error('Unknown module type'), { code: 'VALIDATION', status: 400 });
    return { item, module_type: type };
  });
}

async function deleteModuleItem(workspaceId, leadId, moduleType, id, clientEmail) {
  const domain = require('./domain');
  const modules = require('./siteModules');
  await requireSiteModules(workspaceId, clientEmail);
  const type = String(moduleType || '').toLowerCase();
  return domain.withDb(workspaceId, (db) => {
    if (type === 'blog') return modules.deleteBlogPost(db, Number(leadId), id);
    if (type === 'ecommerce') return modules.deleteProduct(db, Number(leadId), id);
    if (type === 'courses') return modules.deleteCourse(db, Number(leadId), id);
    if (type === 'gallery') return modules.deleteAlbum(db, Number(leadId), id);
    if (type === 'directory') return modules.deleteListing(db, Number(leadId), id);
    if (type === 'faq') return modules.deleteFaqItem(db, Number(leadId), id);
    if (type === 'testimonials') return modules.deleteTestimonial(db, Number(leadId), id);
    if (type === 'team') return modules.deleteTeamMember(db, Number(leadId), id);
    if (type === 'events') return modules.deleteEvent(db, Number(leadId), id);
    if (type === 'bookings') return modules.deleteBookingService(db, Number(leadId), id);
    if (type === 'offers') return modules.deleteOffer(db, Number(leadId), id);
    if (type === 'menu') return modules.deleteMenuItem(db, Number(leadId), id);
    if (type === 'careers') return modules.deleteCareersPosting(db, Number(leadId), id);
    if (type === 'video') return modules.deleteVideoItem(db, Number(leadId), id);
    if (type === 'estimate') return modules.deleteEstimateOption(db, Number(leadId), id);
    if (type === 'datatables') return modules.deleteDataTableRow(db, Number(leadId), id);
    if (type === 'charts') return modules.deleteChart(db, Number(leadId), id);
    if (type === 'categories') return require('./categories').deleteCategory(db, Number(leadId), id);
    if (type === 'socialfeed')
      throw Object.assign(new Error('Social Feed updates itself from your social posts — there are no items to delete.'), {
        code: 'VALIDATION',
        status: 400,
      });
    if (type === 'calltracking')
      throw Object.assign(
        new Error('Call Tracking is automatic — there are no items to delete.'),
        { code: 'VALIDATION', status: 400 }
      );
    if (type === 'newsletter')
      throw Object.assign(
        new Error('Newsletter subscribers are managed in the Newsletter tab — there are no items to delete here.'),
        { code: 'VALIDATION', status: 400 }
      );
    if (type === 'photocapture')
      throw Object.assign(
        new Error('Photo submissions are managed in the Photos tab — delete them from there.'),
        { code: 'VALIDATION', status: 400 }
      );
    if (type === 'members') return modules.deleteSiteMember(db, Number(leadId), id);
    if (type === 'chatbot') {
      const chat = require('./chatbot');
      return chat.deleteKnowledge(db, Number(leadId), id);
    }
    throw Object.assign(new Error('Unknown module type'), { code: 'VALIDATION', status: 400 });
  });
}

async function getChatbotAdmin(workspaceId, leadId, clientEmail) {
  const domain = require('./domain');
  const billing = require('./billing');
  const { getPlan } = require('./plans');
  await requireSiteModules(workspaceId, clientEmail);
  const planId = await billing.effectivePlan(workspaceId, { email: clientEmail });
  if (!getPlan(planId).entitlements.chatbot) {
    throw Object.assign(new Error('Chatbot requires a paid plan (Standard, Pro, or Premium).'), {
      code: 'PLAN_REQUIRED',
      status: 403,
    });
  }
  return domain.withDb(workspaceId, (db) => {
    const chat = require('./chatbot');
    return { plan: planId, ...chat.portalChatbotSummary(db, Number(leadId)) };
  });
}

async function saveChatbotSettings(workspaceId, leadId, body, clientEmail) {
  const domain = require('./domain');
  const billing = require('./billing');
  const { getPlan } = require('./plans');
  await requireSiteModules(workspaceId, clientEmail);
  const planId = await billing.effectivePlan(workspaceId, { email: clientEmail });
  if (!getPlan(planId).entitlements.chatbot) {
    throw Object.assign(new Error('Chatbot requires a paid plan (Standard, Pro, or Premium).'), {
      code: 'PLAN_REQUIRED',
      status: 403,
    });
  }
  return domain.withDb(workspaceId, (db) => {
    const chat = require('./chatbot');
    return { settings: chat.saveSettings(db, Number(leadId), body || {}) };
  });
}

async function uploadChatbotKnowledge(workspaceId, leadId, body, clientEmail) {
  const domain = require('./domain');
  const billing = require('./billing');
  const { getPlan } = require('./plans');
  const extract = require('./chatbotKnowledgeExtract');
  await requireSiteModules(workspaceId, clientEmail);
  const planId = await billing.effectivePlan(workspaceId, { email: clientEmail });
  if (!getPlan(planId).entitlements.chatbot) {
    throw Object.assign(new Error('Chatbot requires a paid plan (Standard, Pro, or Premium).'), {
      code: 'PLAN_REQUIRED',
      status: 403,
    });
  }
  const chat = require('./chatbot');
  const storedList = await chat.storeKnowledgeUploads(workspaceId, leadId, body || {});
  return domain.withDb(workspaceId, (db) => {
    const items = storedList.map((stored) =>
      chat.addKnowledge(db, Number(leadId), {
        kind: 'doc',
        title: stored.title,
        content_text: stored.content_text,
        file_name: stored.file_name,
        file_path: stored.file_path,
      })
    );
    return {
      item: items[0] || null,
      items,
      count: items.length,
      extractors: storedList.map((s) => ({
        file_name: s.file_name,
        extractor: s.extractor,
        warning: s.extract_warning,
        chars: String(s.content_text || '').length,
      })),
      supported_types: extract.SUPPORTED_LABEL,
    };
  });
}

async function resolveChatbotEscalation(workspaceId, leadId, id, clientEmail) {
  const domain = require('./domain');
  await requireSiteModules(workspaceId, clientEmail);
  return domain.withDb(workspaceId, (db) => {
    const chat = require('./chatbot');
    return { escalation: chat.resolveEscalation(db, Number(leadId), id) };
  });
}

async function getBookingAdmin(workspaceId, leadId, clientEmail, opts = {}) {
  const domain = require('./domain');
  const modules = require('./siteModules');
  await requireSiteModules(workspaceId, clientEmail);
  const includeArchived = !!(opts && opts.includeArchived);
  return domain.withDb(workspaceId, (db) => {
    modules.ensureDefaultBookingHours(db, Number(leadId));
    return {
      settings: modules.getBookingSettings(db, Number(leadId)),
      hours: modules.listBookingHours(db, Number(leadId)),
      appointments: modules.listAppointments(db, Number(leadId), {
        limit: 200,
        includeArchived,
      }),
      blocks: modules.listBookingBlocks(db, Number(leadId)),
      services: modules.listBookingServices(db, Number(leadId)),
    };
  });
}

async function saveBookingSettings(workspaceId, leadId, body, clientEmail) {
  const domain = require('./domain');
  const modules = require('./siteModules');
  await requireSiteModules(workspaceId, clientEmail);
  return domain.withDb(workspaceId, (db) => ({
    settings: modules.updateBookingSettings(db, Number(leadId), body || {}),
  }));
}

async function saveEstimateConfig(workspaceId, leadId, body, clientEmail) {
  const domain = require('./domain');
  const modules = require('./siteModules');
  await requireSiteModules(workspaceId, clientEmail);
  return domain.withDb(workspaceId, (db) => ({
    config: modules.updateEstimateConfig(db, Number(leadId), body || {}),
  }));
}

async function saveSocialFeedConfig(workspaceId, leadId, body, clientEmail) {
  const domain = require('./domain');
  const modules = require('./siteModules');
  await requireSiteModules(workspaceId, clientEmail);
  return domain.withDb(workspaceId, (db) => ({
    config: modules.updateSocialFeedConfig(db, Number(leadId), body || {}),
  }));
}

/**
 * Data Tables (Batch 88): the panel's config save — title, column
 * schema, presentation template + display roles, and the visitor
 * submit settings, all normalized server-side in siteModules.
 */
async function saveDataTableConfig(workspaceId, leadId, body, clientEmail) {
  const domain = require('./domain');
  const modules = require('./siteModules');
  await requireSiteModules(workspaceId, clientEmail);
  return domain.withDb(workspaceId, (db) => ({
    config: modules.updateDataTableConfig(db, Number(leadId), body || {}),
  }));
}

/** Data Tables (Batch 88): delete every row; columns/settings stay. */
async function clearDataTable(workspaceId, leadId, clientEmail) {
  const domain = require('./domain');
  const modules = require('./siteModules');
  await requireSiteModules(workspaceId, clientEmail);
  return domain.withDb(workspaceId, (db) => modules.clearDataTableRows(db, Number(leadId)));
}

/**
 * Call Tracking — the client's ONLY save (Batch 25c split). The client
 * provides their phone number; forwarding is configured from the admin
 * side only. This endpoint accepts exactly one field — the phone number
 * (sent as `phone`, `phone_number`, or `phoneNumber`). Every other key
 * in the payload is ignored BY CONSTRUCTION (never read, never
 * written), so a crafted request cannot reach the admin-owned config.
 * Saving the number:
 *   - updates leads.phone (the number the site shows as its call button)
 *   - makes it the forwarding destination (calltracking redirect_number)
 * Everything else — tracking/display number, forwarding on/off,
 * recording, notify, button label — keeps whatever the admin set.
 */
async function saveCallTrackingConfig(workspaceId, leadId, body, clientEmail) {
  const domain = require('./domain');
  const modules = require('./siteModules');
  await requireSiteModules(workspaceId, clientEmail);
  const src = body || {};
  const raw = src.phone != null ? src.phone : src.phone_number != null ? src.phone_number : src.phoneNumber;
  // Batch 76: the Missed-Call Rescue toggle may ride along with the
  // phone save, or be saved on its own — it is the second (and only
  // other) field this endpoint accepts, whitelisted by construction
  // exactly like the phone number.
  const hasRescueToggle = src.rescue_enabled != null || src.rescueEnabled != null;
  if (raw == null && !hasRescueToggle) {
    throw Object.assign(new Error('Your phone number is required.'), { code: 'VALIDATION', status: 400 });
  }
  if (raw == null) {
    // Rescue-toggle-only save: no phone write at all.
    const rescueOnly = domain.withDb(workspaceId, (db) => {
      const callRescue = require('./callRescue');
      const cfg = callRescue.setRescueConfig(db, Number(leadId), {
        enabled: !!(src.rescue_enabled != null ? src.rescue_enabled : src.rescueEnabled),
      });
      const ct = modules.getCallTrackingConfig(db, Number(leadId));
      return {
        rescue_enabled: cfg.enabled,
        tracking_assigned: !!String(ct.display_number || '').trim(),
        twilio_number_sid: String(ct.twilio_number_sid || ''),
      };
    });
    if (rescueOnly.rescue_enabled) {
      await pointRescueSmsWebhook(workspaceId, leadId, rescueOnly.twilio_number_sid);
    }
    return { rescue_enabled: rescueOnly.rescue_enabled, tracking_assigned: rescueOnly.tracking_assigned };
  }
  // Garbage numbers are rejected before anything is written.
  const phone = modules.normalizeE164(raw, 'Your phone number');
  const saved = await domain.withDb(workspaceId, (db) => {
    db.prepare("UPDATE leads SET phone = ?, updated_at = datetime('now') WHERE id = ?").run(
      phone,
      Number(leadId)
    );
    // Site Rentals (Batch 26): while this lead's site is rented out,
    // the forwarding destination belongs to the tenant — the owner's
    // portal phone save still updates their lead phone, but must not
    // stomp the tenant's redirect.
    let rented = false;
    try {
      rented = !!require('./rentals').liveRentalForLead(db, Number(leadId));
    } catch {
      rented = false;
    }
    if (rented) {
      const cfg = db
        .prepare('SELECT display_number FROM calltracking_configs WHERE lead_id = ?')
        .get(Number(leadId));
      return {
        phone_number: phone,
        tracking_assigned: !!(cfg && String(cfg.display_number || '').trim()),
        rental_active: true,
      };
    }
    const config = modules.updateCallTrackingConfig(db, Number(leadId), { redirect_number: phone });
    return {
      phone_number: phone,
      tracking_assigned: !!String(config.display_number || '').trim(),
      twilio_number_sid: String(config.twilio_number_sid || ''),
    };
  });
  // Batch 76: apply the rescue toggle when it rode along, then (on
  // enable) point the tracking number's SMS webhook at the rescue
  // route — best-effort, exactly like the voice-webhook assignment.
  if (hasRescueToggle) {
    const enabled = domain.withDb(workspaceId, (db) =>
      require('./callRescue').setRescueConfig(db, Number(leadId), {
        enabled: !!(src.rescue_enabled != null ? src.rescue_enabled : src.rescueEnabled),
      }).enabled
    );
    saved.rescue_enabled = enabled;
    if (enabled) await pointRescueSmsWebhook(workspaceId, leadId, saved.twilio_number_sid);
  }
  return saved;
}

/**
 * Batch 76: when Missed-Call Rescue is switched on for a lead whose
 * tracking number we manage, point that number's Twilio SMS webhook
 * at this workspace's rescue SMS route so caller replies reach the
 * conversation. Best-effort by design (same posture as the voice
 * webhook assignment in adminSaveCallTrackingConfig): a Twilio-side
 * failure is logged, never rolled back into the owner's save.
 */
async function pointRescueSmsWebhook(workspaceId, leadId, numberSid) {
  const sid = String(numberSid || '').trim();
  if (!sid) return { skipped: 'no_number_sid' };
  try {
    const { appUrl } = require('./stripeClient');
    const smsUrl = `${String(appUrl() || '').replace(/\/$/, '')}/api/v1/calls/sms/${Number(workspaceId)}`;
    const res = await require('./twilioClient').setNumberSmsUrl({ sid, smsUrl, workspaceId });
    return res && res.configured ? { set: true } : { skipped: 'twilio_not_configured' };
  } catch (e) {
    console.warn('[clientPortal] rescue SMS webhook set failed for lead', leadId, e && e.message);
    return { failed: true };
  }
}

/* AI SEO tool (Batch 22): the owner runs the same proposal flow staff
   use, pinned to their own lead's website. The website is resolved from
   the session lead — never from the request — so another business's
   site is unreachable from here. Not plan-gated: SEO is a site service,
   not a site module. */

function seoSiteForLead(db, leadId) {
  const site = db
    .prepare('SELECT id FROM websites WHERE lead_id = ? AND archived_at IS NULL ORDER BY id DESC LIMIT 1')
    .get(Number(leadId));
  if (!site) {
    throw Object.assign(new Error('No website has been built for this business yet.'), { code: 'NO_SITE' });
  }
  return site.id;
}

async function getSeoTool(workspaceId, leadId, clientEmail) {
  const domain = require('./domain');
  const seoTool = require('./seoTool');
  return domain.withDb(workspaceId, (db) => seoTool.getSeoState(db, seoSiteForLead(db, leadId)));
}

/* Site Rentals (Batch 26): the tenant's read-only view of their
   rentals — status, this month's site leads, charges, amount due and
   the stamped site-lead history (which survives the rental ending).
   The lead comes from the portal session, never from the request. */
async function getMyRentals(workspaceId, leadId, clientEmail) {
  const domain = require('./domain');
  const rentals = require('./rentals');
  return domain.withDb(workspaceId, (db) => ({ rentals: rentals.tenantView(db, Number(leadId)) }));
}

async function generateSeoTool(workspaceId, leadId, clientEmail) {
  const domain = require('./domain');
  const seoTool = require('./seoTool');
  return domain.withDb(workspaceId, (db) =>
    seoTool.generateSeoProposal(db, seoSiteForLead(db, leadId), { actor: 'owner' })
  );
}

async function applySeoTool(workspaceId, leadId, clientEmail) {
  const domain = require('./domain');
  const seoTool = require('./seoTool');
  return domain.withDb(workspaceId, (db) =>
    seoTool.applySeoProposal(db, seoSiteForLead(db, leadId), { actor: 'owner', actorKind: 'owner' })
  );
}

/* Batch 31 (I): the owner sets their own site's Google Search Console
   verification token from the portal SEO tab. Site resolved from the
   session lead, never from the request. */
async function setSeoGscToken(workspaceId, leadId, clientEmail, token) {
  const domain = require('./domain');
  return domain.withDb(workspaceId, (db) => {
    const websiteId = seoSiteForLead(db, leadId);
    const clean = String(token || '').trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 200);
    db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run(`seo.gsc.site.${websiteId}`, require('../src/secretBox').encryptSetting(`seo.gsc.site.${websiteId}`, clean));
    return { websiteId, gscToken: clean };
  });
}

async function saveOffersDisplaySettings(workspaceId, leadId, body, clientEmail) {
  const domain = require('./domain');
  const modules = require('./siteModules');
  await requireSiteModules(workspaceId, clientEmail);
  return domain.withDb(workspaceId, (db) => ({
    settings: modules.updateOffersLayout(db, Number(leadId), (body || {}).layout, {
      workspaceId: Number(workspaceId),
    }),
  }));
}

/** Batch 124: the Categories module's display scopes (embed settings). */
async function saveCategoriesDisplaySettings(workspaceId, leadId, body, clientEmail) {
  const domain = require('./domain');
  const modules = require('./siteModules');
  await requireSiteModules(workspaceId, clientEmail);
  return domain.withDb(workspaceId, (db) => ({
    settings: modules.updateCategoriesScopes(db, Number(leadId), (body || {}).scopes, {
      workspaceId: Number(workspaceId),
    }),
  }));
}

async function saveMembersConfig(workspaceId, leadId, body, clientEmail) {
  const domain = require('./domain');
  const modules = require('./siteModules');
  await requireSiteModules(workspaceId, clientEmail);
  return domain.withDb(workspaceId, (db) => ({
    config: modules.updateMembersConfig(db, Number(leadId), body || {}),
  }));
}

/* Membership Part 2: the owner's own Stripe keys, tiers, comps, cancels. */

async function saveMembershipKeys(workspaceId, leadId, body, clientEmail) {
  const domain = require('./domain');
  const modules = require('./siteModules');
  await requireSiteModules(workspaceId, clientEmail);
  return domain.withDb(workspaceId, (db) => ({
    payments: modules.saveMembershipStripeKeys(db, Number(leadId), body || {}),
  }));
}

async function clearMembershipKeys(workspaceId, leadId, clientEmail) {
  const domain = require('./domain');
  const modules = require('./siteModules');
  await requireSiteModules(workspaceId, clientEmail);
  return domain.withDb(workspaceId, (db) => ({
    payments: modules.clearMembershipStripeKeys(db, Number(leadId)),
  }));
}

/* Shop Part 2 (Batch 19): the owner's own Stripe keys for their shop. */

async function saveShopKeys(workspaceId, leadId, body, clientEmail) {
  const domain = require('./domain');
  const modules = require('./siteModules');
  await requireSiteModules(workspaceId, clientEmail);
  return domain.withDb(workspaceId, (db) => ({
    payments: modules.saveShopStripeKeys(db, Number(leadId), body || {}),
  }));
}

async function clearShopKeys(workspaceId, leadId, clientEmail) {
  const domain = require('./domain');
  const modules = require('./siteModules');
  await requireSiteModules(workspaceId, clientEmail);
  return domain.withDb(workspaceId, (db) => ({
    payments: modules.clearShopStripeKeys(db, Number(leadId)),
  }));
}

/**
 * Truthful connection test for the owner's saved shop keys: one
 * lightweight Stripe read with the saved secret. Success reports
 * facts about the owner's own account; failure reports a plain
 * rejection — Stripe's raw error is never forwarded (it can echo key
 * fragments) and no key material is ever returned or logged.
 */
async function testShopKeys(workspaceId, leadId, clientEmail) {
  const domain = require('./domain');
  const shopStripe = require('./shopStripe');
  await requireSiteModules(workspaceId, clientEmail);
  try {
    const result = await domain.withDb(workspaceId, async (db) => shopStripe.testLeadConnection(db, Number(leadId)));
    return { test: { ok: true, ...result } };
  } catch (e) {
    if (e && e.code === 'SHOP_STRIPE_NOT_CONFIGURED') {
      return { test: { ok: false, reason: 'not_connected' } };
    }
    return { test: { ok: false, reason: 'rejected' } };
  }
}

async function createMembershipTier(workspaceId, leadId, body, clientEmail) {
  const domain = require('./domain');
  const membershipStripe = require('./membershipStripe');
  await requireSiteModules(workspaceId, clientEmail);
  return domain.withDb(workspaceId, async (db) => {
    const result = await membershipStripe.saveMembershipTier(db, Number(leadId), body || {});
    return { tier: result.tier, stripe_state: result.stripe_state, module_type: 'members' };
  });
}

async function updateMembershipTier(workspaceId, leadId, tierId, body, clientEmail) {
  const domain = require('./domain');
  const membershipStripe = require('./membershipStripe');
  await requireSiteModules(workspaceId, clientEmail);
  return domain.withDb(workspaceId, async (db) => {
    const result = await membershipStripe.saveMembershipTier(db, Number(leadId), body || {}, Number(tierId));
    return { tier: result.tier, stripe_state: result.stripe_state, module_type: 'members' };
  });
}

async function deleteMembershipTier(workspaceId, leadId, tierId, clientEmail) {
  const domain = require('./domain');
  const modules = require('./siteModules');
  await requireSiteModules(workspaceId, clientEmail);
  return domain.withDb(workspaceId, (db) => modules.deleteMembershipTier(db, Number(leadId), Number(tierId)));
}

async function grantMemberComp(workspaceId, leadId, memberId, body, clientEmail) {
  const domain = require('./domain');
  const modules = require('./siteModules');
  await requireSiteModules(workspaceId, clientEmail);
  return domain.withDb(workspaceId, (db) => ({
    member: modules.grantMemberComp(db, Number(leadId), Number(memberId), body || {}),
  }));
}

async function revokeMemberComp(workspaceId, leadId, memberId, clientEmail) {
  const domain = require('./domain');
  const modules = require('./siteModules');
  await requireSiteModules(workspaceId, clientEmail);
  return domain.withDb(workspaceId, (db) => ({
    member: modules.revokeMemberComp(db, Number(leadId), Number(memberId)),
  }));
}

async function cancelMemberSubscription(workspaceId, leadId, memberId, clientEmail) {
  const domain = require('./domain');
  const membershipStripe = require('./membershipStripe');
  await requireSiteModules(workspaceId, clientEmail);
  return domain.withDb(workspaceId, async (db) =>
    membershipStripe.cancelMemberSubscription(db, Number(leadId), Number(memberId))
  );
}

async function refreshSocialFeed(workspaceId, leadId, clientEmail) {
  const domain = require('./domain');
  const modules = require('./siteModules');
  await requireSiteModules(workspaceId, clientEmail);
  return domain.withDb(workspaceId, async (db) => {
    const result = await modules.refreshSocialFeedRemote(db, Number(leadId), { force: true });
    return {
      refreshed: !!result.ok,
      preview: modules.socialFeedPreview(db, Number(leadId)),
    };
  });
}

/**
 * Google Reviews config save (Batch 30). Setting a NEW Place ID is
 * validated against Google before anything is stored (when the platform
 * key exists): a Place ID Google cannot find fails the save with a clear
 * message and nothing is written. A verified fetch doubles as the first
 * cache fill, so the module lights up immediately. With no platform key
 * the config saves dormant and activates when the key is added.
 */
async function saveGoogleReviewsConfig(workspaceId, leadId, body, clientEmail) {
  const domain = require('./domain');
  const modules = require('./siteModules');
  await requireSiteModules(workspaceId, clientEmail);
  return domain.withDb(workspaceId, async (db) => {
    const id = Number(leadId);
    const prev = modules.readGoogleReviewsConfig(db, id);
    const rawPlace = body ? (body.place_id != null ? body.place_id : body.placeId) : null;
    const nextPlace = rawPlace != null ? String(rawPlace).trim() : prev.place_id;
    let prefetched = null;
    if (nextPlace && nextPlace !== prev.place_id) {
      modules.assertGooglePlaceId(nextPlace);
      const key = await modules.resolveGooglePlacesApiKey();
      if (key) {
        try {
          prefetched = await modules.fetchGooglePlaceDetails(key, nextPlace);
        } catch (e) {
          if (e && e.code === 'PLACES_NOT_FOUND') {
            throw Object.assign(
              new Error('Google could not find that Place ID — check it and try again. Nothing was saved.'),
              { code: 'VALIDATION', status: 400 }
            );
          }
          throw Object.assign(
            new Error(`Could not check that Place ID with Google right now (${(e && e.message) || e}). Nothing was saved — try again in a moment.`),
            { code: 'PLACES_UNAVAILABLE', status: 502 }
          );
        }
      }
    }
    const config = modules.updateGoogleReviewsConfig(db, id, body || {});
    if (prefetched) modules.storeGoogleReviewsCache(db, id, prefetched);
    return { config, preview: await modules.googleReviewsPreview(db, id) };
  });
}

async function refreshGoogleReviews(workspaceId, leadId, clientEmail) {
  const domain = require('./domain');
  const modules = require('./siteModules');
  await requireSiteModules(workspaceId, clientEmail);
  return domain.withDb(workspaceId, async (db) => {
    const result = await modules.refreshGoogleReviews(db, Number(leadId), { force: true });
    return {
      refreshed: !!result.ok,
      code: result.code || null,
      error: result.error || null,
      preview: await modules.googleReviewsPreview(db, Number(leadId)),
    };
  });
}

async function updateEstimateRequest(workspaceId, leadId, id, body, clientEmail) {
  const domain = require('./domain');
  const modules = require('./siteModules');
  await requireSiteModules(workspaceId, clientEmail);
  return domain.withDb(workspaceId, (db) => {
    if (body && body.status != null) {
      return {
        request: modules.updateEstimateRequestStatus(db, Number(leadId), id, body.status),
      };
    }
    return { request: modules.getEstimateRequest(db, Number(leadId), id) };
  });
}

async function saveBookingHours(workspaceId, leadId, body, clientEmail) {
  const domain = require('./domain');
  const modules = require('./siteModules');
  await requireSiteModules(workspaceId, clientEmail);
  const hours = Array.isArray(body && body.hours) ? body.hours : Array.isArray(body) ? body : [];
  return domain.withDb(workspaceId, (db) => ({
    hours: modules.setBookingHours(db, Number(leadId), hours),
  }));
}

/** Batch 45 — portal delete of one appointment (wires the long-dead engine fn). */
async function deleteBookingAppointment(workspaceId, leadId, id, clientEmail) {
  const domain = require('./domain');
  const modules = require('./siteModules');
  await requireSiteModules(workspaceId, clientEmail);
  return domain.withDb(workspaceId, (db) => modules.deleteAppointment(db, Number(leadId), id));
}

/** Batch 45 — portal delete of one estimate request (wires the long-dead engine fn). */
async function deleteEstimateRequest(workspaceId, leadId, id, clientEmail) {
  const domain = require('./domain');
  const modules = require('./siteModules');
  await requireSiteModules(workspaceId, clientEmail);
  return domain.withDb(workspaceId, (db) => modules.deleteEstimateRequest(db, Number(leadId), id));
}

/* ── Photo Capture (Batch 125) — the portal inbox's writes. Every one
 * delegates to the siteModules engine functions, so the portal, the
 * design agent and the MCP tools moderate through ONE code path. ── */

async function savePhotoCaptureConfig(workspaceId, leadId, body, clientEmail) {
  const domain = require('./domain');
  const modules = require('./siteModules');
  await requireSiteModules(workspaceId, clientEmail);
  return domain.withDb(workspaceId, (db) => ({
    config: modules.updatePhotoCaptureConfig(db, Number(leadId), body || {}),
  }));
}

async function updatePhotoSubmission(workspaceId, leadId, id, body, clientEmail) {
  const domain = require('./domain');
  const modules = require('./siteModules');
  await requireSiteModules(workspaceId, clientEmail);
  return domain.withDb(workspaceId, (db) => {
    if (body && body.status != null) {
      return { submission: modules.updatePhotoSubmissionStatus(db, Number(leadId), id, body.status) };
    }
    return { submission: modules.getPhotoSubmission(db, Number(leadId), id) };
  });
}

async function removePhotoSubmission(workspaceId, leadId, id, clientEmail) {
  const domain = require('./domain');
  const modules = require('./siteModules');
  await requireSiteModules(workspaceId, clientEmail);
  return domain.withDb(workspaceId, (db) => modules.deletePhotoSubmission(db, Number(leadId), id));
}

async function addPhotoSubmissionToGallery(workspaceId, leadId, id, body, clientEmail) {
  const domain = require('./domain');
  const modules = require('./siteModules');
  await requireSiteModules(workspaceId, clientEmail);
  return domain.withDb(workspaceId, (db) =>
    modules.addPhotoSubmissionToGallery(db, Number(leadId), id, body && (body.album_id || body.albumId))
  );
}

async function updateBookingAppointment(workspaceId, leadId, id, body, clientEmail) {
  const domain = require('./domain');
  const modules = require('./siteModules');
  await requireSiteModules(workspaceId, clientEmail);
  return domain.withDb(workspaceId, (db) => {
    let appointment = null;
    if (body && body.status != null) {
      appointment = modules.updateAppointmentStatus(db, Number(leadId), id, body.status);
    }
    if (body && body.archived != null) {
      appointment = modules.setAppointmentArchived(db, Number(leadId), id, body.archived);
    }
    if (appointment) return { appointment };
    throw Object.assign(new Error('status or archived is required'), { code: 'VALIDATION', status: 400 });
  });
}

async function createBookingBlockAdmin(workspaceId, leadId, body, clientEmail) {
  const domain = require('./domain');
  const modules = require('./siteModules');
  await requireSiteModules(workspaceId, clientEmail);
  return domain.withDb(workspaceId, (db) => ({
    block: modules.createBookingBlock(db, Number(leadId), body || {}),
  }));
}

async function deleteBookingBlockAdmin(workspaceId, leadId, id, clientEmail) {
  const domain = require('./domain');
  const modules = require('./siteModules');
  await requireSiteModules(workspaceId, clientEmail);
  return domain.withDb(workspaceId, (db) => modules.deleteBookingBlock(db, Number(leadId), id));
}

async function addModuleChild(workspaceId, leadId, moduleType, parentId, body, clientEmail) {
  const domain = require('./domain');
  const modules = require('./siteModules');
  await requireSiteModules(workspaceId, clientEmail);
  const type = String(moduleType || '').toLowerCase();
  return domain.withDb(workspaceId, (db) => {
    if (type === 'courses') {
      return { lesson: modules.addLesson(db, Number(leadId), parentId, body || {}) };
    }
    if (type === 'gallery') {
      return { image: modules.addGalleryImage(db, Number(leadId), parentId, body || {}) };
    }
    throw Object.assign(new Error('Child items only for courses (lessons) or gallery (images)'), {
      code: 'VALIDATION',
      status: 400,
    });
  });
}

async function listMenuCategories(workspaceId, leadId, clientEmail) {
  const domain = require('./domain');
  const modules = require('./siteModules');
  await requireSiteModules(workspaceId, clientEmail);
  return domain.withDb(workspaceId, (db) => ({
    categories: modules.listMenuCategories(db, Number(leadId)),
  }));
}

async function createMenuCategory(workspaceId, leadId, body, clientEmail) {
  const domain = require('./domain');
  const modules = require('./siteModules');
  await requireSiteModules(workspaceId, clientEmail);
  return domain.withDb(workspaceId, (db) => modules.createMenuCategory(db, Number(leadId), body || {}));
}

async function updateMenuCategory(workspaceId, leadId, id, body, clientEmail) {
  const domain = require('./domain');
  const modules = require('./siteModules');
  await requireSiteModules(workspaceId, clientEmail);
  return domain.withDb(workspaceId, (db) => modules.updateMenuCategory(db, Number(leadId), id, body || {}));
}

async function deleteMenuCategory(workspaceId, leadId, id, clientEmail) {
  const domain = require('./domain');
  const modules = require('./siteModules');
  await requireSiteModules(workspaceId, clientEmail);
  return domain.withDb(workspaceId, (db) => modules.deleteMenuCategory(db, Number(leadId), id));
}

async function deleteModuleChild(workspaceId, leadId, moduleType, childId, clientEmail) {
  const domain = require('./domain');
  const modules = require('./siteModules');
  await requireSiteModules(workspaceId, clientEmail);
  const type = String(moduleType || '').toLowerCase();
  return domain.withDb(workspaceId, (db) => {
    if (type === 'courses') return modules.deleteLesson(db, Number(leadId), childId);
    if (type === 'gallery') return modules.deleteGalleryImage(db, Number(leadId), childId);
    throw Object.assign(new Error('Child delete only for courses or gallery'), {
      code: 'VALIDATION',
      status: 400,
    });
  });
}

async function attachSiteModule(workspaceId, leadId, moduleType, opts = {}, clientEmail) {
  const domain = require('./domain');
  const modules = require('./siteModules');
  const billing = require('./billing');
  const { getPlan } = require('./plans');
  const { appUrl } = require('./stripeClient');
  await requireSiteModules(workspaceId, clientEmail);
  if (String(moduleType || '').toLowerCase() === 'chatbot') {
    const planId = await billing.effectivePlan(workspaceId, { email: clientEmail });
    if (!getPlan(planId).entitlements.chatbot) {
      throw Object.assign(new Error('Chatbot requires a paid plan (Standard, Pro, or Premium).'), {
        code: 'PLAN_REQUIRED',
        status: 403,
      });
    }
  }
  const packed = domain.withDb(workspaceId, (db) => {
    const result = modules.attachModule(db, Number(leadId), moduleType, {
      workspaceId: Number(workspaceId),
      title: opts.title,
      target_page_slug: opts.target_page_slug,
      embed_enabled: opts.embed_enabled != null ? opts.embed_enabled : opts.toSite !== false,
      appUrl: appUrl(),
    });
    const site = db.prepare('SELECT id FROM websites WHERE lead_id = ? AND archived_at IS NULL ORDER BY id DESC LIMIT 1').get(Number(leadId));
    return {
      ...result,
      pages: modules.listSitePages(db, Number(leadId)),
      siteId: site && site.id,
    };
  });
  let preview = null;
  if (packed.siteId) {
    preview = await publishLiveAfterEmbed(workspaceId, packed.siteId);
  }
  const { siteId, ...rest } = packed;
  return {
    ...rest,
    previewUrl: preview && preview.url,
    via: preview && preview.via,
    publicPreviewUpdated: !!(preview && (preview.via === 'cloudflare' || preview.via === 'app_url')),
  };
}

async function detachSiteModule(workspaceId, leadId, moduleType, clientEmail) {
  const domain = require('./domain');
  const modules = require('./siteModules');
  await requireSiteModules(workspaceId, clientEmail);
  const packed = domain.withDb(workspaceId, (db) => {
    const result = modules.detachModule(db, Number(leadId), moduleType);
    const site = db.prepare('SELECT id FROM websites WHERE lead_id = ? AND archived_at IS NULL ORDER BY id DESC LIMIT 1').get(Number(leadId));
    return { ...result, siteId: site && site.id };
  });
  let preview = null;
  if (packed.siteId) {
    preview = await publishLiveAfterEmbed(workspaceId, packed.siteId);
  }
  const { siteId, ...rest } = packed;
  return {
    ...rest,
    previewUrl: preview && preview.url,
    via: preview && preview.via,
    publicPreviewUpdated: !!(preview && (preview.via === 'cloudflare' || preview.via === 'app_url')),
  };
}

/**
 * Batch 66 — owner-only per-record module delete from the portal.
 * Unlike detach (unpublish, content kept), this purges the embed AND
 * its lead-scoped content/config via the engine. The owner check
 * lives in the route (portal user types are a route-layer concept);
 * this facade mirrors detachSiteModule's shape, including the live
 * preview republish so the site stops showing the module at once.
 */
async function deleteSiteModule(workspaceId, leadId, moduleType, clientEmail) {
  const domain = require('./domain');
  const modules = require('./siteModules');
  await requireSiteModules(workspaceId, clientEmail);
  const packed = domain.withDb(workspaceId, (db) => {
    const result = modules.deleteModule(db, Number(leadId), moduleType);
    const site = db.prepare('SELECT id FROM websites WHERE lead_id = ? AND archived_at IS NULL ORDER BY id DESC LIMIT 1').get(Number(leadId));
    return { ...result, siteId: site && site.id };
  });
  let preview = null;
  if (packed.siteId) {
    preview = await publishLiveAfterEmbed(workspaceId, packed.siteId);
  }
  const { siteId, ...rest } = packed;
  return {
    ...rest,
    previewUrl: preview && preview.url,
    via: preview && preview.via,
    publicPreviewUpdated: !!(preview && (preview.via === 'cloudflare' || preview.via === 'app_url')),
  };
}

async function requireClientMcpPlan(workspaceId, clientEmail) {
  const billing = require('./billing');
  const { isPaidPlan } = require('./plans');
  const planId = await billing.effectivePlan(workspaceId, { email: clientEmail });
  if (!isPaidPlan(planId)) {
    throw Object.assign(new Error('Client MCP tokens require a paid plan (Standard, Pro, or Premium). Upgrade in Billing.'), {
      code: 'FORBIDDEN',
      status: 403,
    });
  }
  return planId;
}

async function listClientMcpTokens(workspaceId, leadId, clientEmail) {
  await requireClientMcpPlan(workspaceId, clientEmail);
  const tokens = await query(
    `SELECT id, name, token_prefix, last_used_at, created_at
     FROM workspace_tokens
     WHERE workspace_id = :workspaceId AND lead_id = :leadId
     ORDER BY id DESC`,
    { workspaceId, leadId: Number(leadId) }
  );
  return { tokens, endpoint: '/mcp' };
}

async function revokeClientMcpToken(workspaceId, leadId, clientEmail, tokenId) {
  await requireClientMcpPlan(workspaceId, clientEmail);
  const id = Number(tokenId);
  if (!id) {
    throw Object.assign(new Error('Invalid token id'), { code: 'INVALID', status: 400 });
  }
  const result = await query(
    `DELETE FROM workspace_tokens
     WHERE id = :id AND workspace_id = :workspaceId AND lead_id = :leadId`,
    { id, workspaceId, leadId: Number(leadId) }
  );
  if (!result.affectedRows) {
    throw Object.assign(new Error('Token not found'), { code: 'NOT_FOUND', status: 404 });
  }
  return { id };
}

async function createClientMcpToken(workspaceId, leadId, clientEmail, opts = {}) {
  const { createWorkspaceToken } = require('./workspace');
  await requireClientMcpPlan(workspaceId, clientEmail);
  const custom = String(opts.name || '')
    .trim()
    .slice(0, 80);
  const name = custom || `Client portal · ${String(clientEmail || '').slice(0, 40)} · lead ${leadId}`;
  const created = await createWorkspaceToken(workspaceId, name, {
    leadId: Number(leadId),
    expiresAt: opts.expiresAt ?? null,
    oauthUserId: opts.oauthUserId ?? null,
  });
  return {
    ...created,
    hint:
      'Lead-scoped Bearer token for Muse or any MCP client. Connect to your workspace /mcp URL. ' +
      'Start with site.get, then site.editText / pages.structure.update / modules.* / theme.set (global colours/fonts) / theme.styleRule (per-element styling, e.g. all H3s) / site.publish. ' +
      'Social post scheduling via social.posts.* is Premium only; form inbox stays in the portal UI.',
  };
}


module.exports = {
  requireSiteModules,
  listSiteModules,
  listModuleItems,
  createModuleItem,
  updateModuleItem,
  deleteModuleItem,
  getChatbotAdmin,
  saveChatbotSettings,
  uploadChatbotKnowledge,
  resolveChatbotEscalation,
  getBookingAdmin,
  saveBookingSettings,
  saveEstimateConfig,
  saveSocialFeedConfig,
  saveDataTableConfig,
  clearDataTable,
  saveCallTrackingConfig,
  getSeoTool,
  getMyRentals,
  generateSeoTool,
  applySeoTool,
  setSeoGscToken,
  saveOffersDisplaySettings,
  saveCategoriesDisplaySettings,
  saveMembersConfig,
  saveMembershipKeys,
  clearMembershipKeys,
  saveShopKeys,
  clearShopKeys,
  testShopKeys,
  createMembershipTier,
  updateMembershipTier,
  deleteMembershipTier,
  grantMemberComp,
  revokeMemberComp,
  cancelMemberSubscription,
  refreshSocialFeed,
  saveGoogleReviewsConfig,
  refreshGoogleReviews,
  updateEstimateRequest,
  saveBookingHours,
  deleteBookingAppointment,
  deleteEstimateRequest,
  savePhotoCaptureConfig,
  updatePhotoSubmission,
  removePhotoSubmission,
  addPhotoSubmissionToGallery,
  updateBookingAppointment,
  createBookingBlockAdmin,
  deleteBookingBlockAdmin,
  addModuleChild,
  listMenuCategories,
  createMenuCategory,
  updateMenuCategory,
  deleteMenuCategory,
  deleteModuleChild,
  attachSiteModule,
  detachSiteModule,
  deleteSiteModule,
  listClientMcpTokens,
  revokeClientMcpToken,
  createClientMcpToken,
};
