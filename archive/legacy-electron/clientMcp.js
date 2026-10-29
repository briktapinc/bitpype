'use strict';

/**
 * Client-scoped MCP tools for Standard/Premium portal users (lead-pinned tokens).
 * Wraps server/clientPortal.js — no duplicated business logic.
 */

const domain = require('./domain');
const portal = require('./clientPortal');
const billingMod = require('./billing');
const { getPlan } = require('./plans');

const ID = { type: 'integer', minimum: 1 };
const STR = { type: 'string' };
function schema(properties = {}, required = []) {
  return required.length ? { type: 'object', properties, required } : { type: 'object', properties };
}

/** Tool definitions for site/pages/theme/billing/changes (prepended to module + social tools in mcp.js). */
function portalToolDefs() {
  const leadHint = 'Optional on lead-scoped tokens (inferred from token).';
  return [
    {
      name: 'site.get',
      description:
        'Portal context for the linked business: lead summary, site id/status, preview URL, plan + entitlements. Call first in a Muse session. All plans with a site; token requires Standard or Premium.',
      inputSchema: schema({ leadId: ID }),
    },
    {
      name: 'site.render',
      description:
        'Editable-site snapshot: page list, theme colors/fonts, logo, preview URL. Set includeHtml:true for srcdoc HTML (large). Matches portal Website preview.',
      inputSchema: schema({
        leadId: ID,
        pageSlug: STR,
        includeHtml: { type: 'boolean' },
        editable: { type: 'boolean' },
      }),
    },
    {
      name: 'site.publish',
      description:
        'Publish / force preview — rematerialize export and refresh public preview URL (same as portal Publish). Requires previewHosting.',
      inputSchema: schema({ leadId: ID }),
    },
    {
      name: 'site.editText',
      description:
        'Inline text edits from portal edit mode. Prefer restyle/reuse over duplicating nav CTAs or forms. edits: [{ id: "page:section:path", text: "…" }]. Locked paths (phone, email, address) are rejected.',
      inputSchema: schema({
        leadId: ID,
        edits: { type: 'array', items: { type: 'object' } },
      }, ['edits']),
    },
    {
      name: 'site.editListItem',
      description:
        'Add/delete/reorder list/card/FAQ items on structured pages, or freeform-save with action freeform-save + pageIndex + html. Same as portal list-item API.',
      inputSchema: schema({
        leadId: ID,
        action: STR,
        pageIndex: { type: 'integer', minimum: 0 },
        sectionIndex: { type: 'integer', minimum: 0 },
        listKey: STR,
        itemIndex: { type: 'integer', minimum: 0 },
        html: STR,
      }),
    },
    {
      name: 'site.replaceImage',
      description:
        'Replace a site image (replaceSrc e.g. images/hero.jpg) with base64 data + mimeType. Max ~5.5MB. Rematerializes previews.',
      inputSchema: schema({
        leadId: ID,
        replaceSrc: STR,
        src: STR,
        data: STR,
        mimeType: STR,
      }, ['replaceSrc', 'data']),
    },
    {
      name: 'site.generateImage',
      description:
        'AI-generate and replace a site image (replaceSrc + prompt). Premium: images included; Free/Standard may charge credits.',
      inputSchema: schema({
        leadId: ID,
        replaceSrc: STR,
        src: STR,
        prompt: STR,
      }, ['replaceSrc', 'prompt']),
    },
    {
      name: 'site.setLogo',
      description:
        'Set header logo: mode text (text brand) or image with data+mimeType. Optional brandName.',
      inputSchema: schema({
        leadId: ID,
        mode: { type: 'string', enum: ['text', 'image'] },
        data: STR,
        mimeType: STR,
        brandName: STR,
      }),
    },
    {
      name: 'pages.structure',
      description:
        'Menu + pages summary for reorder UI (menu tree, page indexes, freeform/hasSections flags). Use menu[].index as fromIndex for pages.structure.update.',
      inputSchema: schema({ leadId: ID }),
    },
    {
      name: 'pages.structure.update',
      description:
        'Reorder/nest menu or sections, toggle nav visibility, add page (+ nav), insert module section. Pass scope menu|sections; action move|nest|unnest|togglenav|addpage|insertmodule; fromIndex, direction ±1, pageIndex, title, slug, moduleType, afterIndex. Same body as portal POST /site/structure.',
      inputSchema: schema({
        leadId: ID,
        scope: { type: 'string', enum: ['menu', 'sections'] },
        action: STR,
        fromIndex: { type: 'integer', minimum: 0 },
        direction: { type: 'integer', enum: [-1, 1] },
        pageIndex: { type: 'integer', minimum: 0 },
        afterIndex: { type: 'integer', minimum: 0 },
        title: STR,
        slug: STR,
        moduleType: STR,
        module_type: STR,
      }, ['scope']),
    },
    {
      name: 'theme.get',
      description: 'Current theme colors, fonts, logo mode/URL for the client site.',
      inputSchema: schema({ leadId: ID }),
    },
    {
      name: 'theme.set',
      description:
        'Set theme colors (#RRGGBB: primary, secondary, bg, text) and/or font, headingFont (from fonts.list), elementFonts, replacements[]. Same as portal Theme bar.',
      inputSchema: schema({
        leadId: ID,
        primary: STR,
        secondary: STR,
        bg: STR,
        text: STR,
        font: STR,
        headingFont: STR,
        elementFonts: { type: 'object' },
        replacements: { type: 'array', items: { type: 'object' } },
      }),
    },
    {
      name: 'fonts.list',
      description:
        'List curated Google Fonts for theme.font / theme.headingFont. Free local catalog (no API cost). Optional group: Sans|Serif|Display|Mono.',
      inputSchema: schema({ group: STR }),
    },
    {
      name: 'modules.attach',
      description:
        'Attach a site module into the live template (Standard/Premium siteModules). Alias of website.addModule — adds nav link + in-page mount. STYLING: wrap bare .bitpype-module-embed in a themed card/section; theme.customCss under section[data-ws-section-type="site_module"].',
      inputSchema: schema({
        leadId: ID,
        module: STR,
        moduleType: STR,
        title: STR,
        target_page_slug: STR,
        pageSlug: STR,
      }),
    },
    {
      name: 'modules.detach',
      description: 'Remove a module embed from the site template (Standard/Premium).',
      inputSchema: schema({ leadId: ID, module: STR, moduleType: STR }, ['module']),
    },
    {
      name: 'modules.uploadImage',
      description:
        'Upload image for module item fields (cover, gallery, etc.): moduleType, field, data, mimeType. Returns public URL path.',
      inputSchema: schema({
        leadId: ID,
        moduleType: STR,
        field: STR,
        data: STR,
        mimeType: STR,
      }, ['moduleType', 'data']),
    },
    {
      name: 'social.accounts.list',
      description: 'Connected Meta accounts for scheduling (read-only). Post scheduling tools require Premium socialMcpSchedule.',
      inputSchema: schema({ leadId: ID }),
    },
    {
      name: 'social.calendar',
      description: 'Social posts for a calendar month (same as portal Social tab). Premium socialMcpSchedule for MCP edits.',
      inputSchema: schema({
        leadId: ID,
        year: { type: 'integer' },
        month: { type: 'integer', minimum: 1, maximum: 12 },
      }),
    },
    {
      name: 'social.generate',
      description:
        'Queue AI social post generation for week|month (portal Generate). May charge credits on Free/Standard.',
      inputSchema: schema({
        leadId: ID,
        period: { type: 'string', enum: ['week', 'month'] },
      }),
    },
    {
      name: 'billing.get',
      description:
        'Plan, entitlements, subscription status, credits balance — safe read, no secrets. Use billing.checkout or billing.portal to start Stripe flows (returns URL only).',
      inputSchema: schema({ leadId: ID }),
    },
    {
      name: 'billing.checkout',
      description: 'Start Stripe Checkout for standard|premium. Returns checkout URL (one-time display flow).',
      inputSchema: schema({
        leadId: ID,
        planId: { type: 'string', enum: ['standard', 'premium'] },
        plan: { type: 'string', enum: ['standard', 'premium'] },
      }),
    },
    {
      name: 'billing.portal',
      description: 'Open Stripe Customer Portal session URL when self-serve billing is allowed.',
      inputSchema: schema({ leadId: ID }),
    },
    {
      name: 'billing.changePlan',
      description: 'Switch between standard and premium on an active subscription (proration).',
      inputSchema: schema({
        leadId: ID,
        planId: { type: 'string', enum: ['standard', 'premium'] },
      }, ['planId']),
    },
    {
      name: 'billing.cancel',
      description: 'Schedule cancel at period end (downgrade to Free).',
      inputSchema: schema({ leadId: ID }),
    },
    {
      name: 'billing.resume',
      description: 'Undo scheduled cancellation.',
      inputSchema: schema({ leadId: ID }),
    },
    {
      name: 'billing.credits.checkout',
      description: 'Start Stripe Checkout to buy social credit packs. Optional quantity.',
      inputSchema: schema({
        leadId: ID,
        quantity: { type: 'integer', minimum: 1, maximum: 20 },
      }),
    },
    {
      name: 'changes.submit',
      description:
        'Submit a design change request (portal Changes tab). Runs instruction-review first (inspect site → classify SAFE|BETTER_PATH|PUSH_BACK → plan). Returns classification, clientMessage, change_request_review log. kind redesign|improvements, message required. designChangeRequests entitlement.',
      inputSchema: schema({
        leadId: ID,
        message: STR,
        instructions: STR,
        kind: { type: 'string', enum: ['redesign', 'improvements'] },
      }, ['message']),
    },
  ];
}

function need(v, name) {
  if (v == null || v === '') throw new Error(`${name} is required`);
  return v;
}

function resolveLeadId(ctx, argsLeadId) {
  if (ctx && ctx.leadId) return Number(ctx.leadId);
  return argsLeadId != null ? Number(need(argsLeadId, 'leadId')) : null;
}

function assertLeadScope(ctx, leadId) {
  if (ctx && ctx.leadId && leadId && Number(ctx.leadId) !== Number(leadId)) {
    throw Object.assign(new Error('Forbidden'), { code: 'FORBIDDEN' });
  }
}

function resolveClientEmail(workspaceId, leadId) {
  return domain.withDb(workspaceId, (db) => {
    const row = db.prepare(
      `SELECT email FROM client_portal_users
       WHERE workspace_id = ? AND lead_id = ? AND status = 'active'
       ORDER BY id DESC LIMIT 1`
    ).get(Number(workspaceId), Number(leadId));
    return row ? String(row.email || '').trim().toLowerCase() : '';
  });
}

async function planEntitlements(workspaceId, clientEmail = '') {
  const planId = await billingMod.effectivePlan(workspaceId, { email: clientEmail });
  return { planId, entitlements: getPlan(planId).entitlements };
}

function planError(message) {
  return Object.assign(new Error(message), { code: 'PLAN_REQUIRED' });
}

/**
 * Dispatch portal-facing tools. Returns undefined if name is not handled here.
 * Must not require leadId until the tool name is known to be a portal tool —
 * otherwise workspace tools (lead.create, website.addSection, …) fail on
 * workspace-scoped tokens that have no lead_id.
 */
async function dispatchPortalTool(ws, name, a, ctx = {}) {
  const portalNames = new Set(portalToolDefs().map((t) => t.name));
  if (!portalNames.has(name)) return undefined;

  const leadId = resolveLeadId(ctx, a.leadId);
  if (!leadId) throw new Error('leadId is required');
  assertLeadScope(ctx, leadId);
  const clientEmail = resolveClientEmail(ws, leadId);
  const { planId, entitlements } = await planEntitlements(ws, clientEmail);

  const requireEnt = (key, msg) => {
    if (!entitlements[key]) throw planError(msg);
  };

  if (name === 'site.get') {
    const ctxData = portal.loadLeadContext(ws, leadId);
    return {
      plan: planId,
      entitlements,
      lead: ctxData.lead,
      site: ctxData.site,
      previewUrl: ctxData.previewUrl,
      hasDesignJob: !!(ctxData.designJob && ctxData.designJob.id),
    };
  }

  if (name === 'site.render') {
    const includeHtml = a.includeHtml === true;
    const data = portal.renderClientSite(ws, leadId, {
      editable: a.editable !== false,
      pageSlug: a.pageSlug,
    });
    if (!includeHtml) {
      const { html, ...rest } = data;
      return { plan: planId, ...rest, htmlIncluded: false };
    }
    return { plan: planId, ...data, htmlIncluded: true };
  }

  if (name === 'site.publish') {
    requireEnt('previewHosting', 'Publish requires preview hosting on your plan.');
    const out = await portal.publishClientSitePreview(ws, leadId);
    return { plan: planId, ...out };
  }

  if (name === 'site.editText') {
    requireEnt('inlineEdits', 'Inline edits are not on your plan.');
    const edits = a.edits || [];
    const out = portal.applyClientTextEdits(ws, leadId, edits);
    return { plan: planId, ...out };
  }

  if (name === 'site.editListItem') {
    requireEnt('inlineEdits', 'Inline edits are not on your plan.');
    const body = { ...a };
    if (body.action === 'freeform-save' || body.html) {
      const out = portal.saveClientPageHtml(ws, leadId, body);
      return { plan: planId, ...out };
    }
    const out = portal.mutateClientListItem(ws, leadId, body);
    return { plan: planId, ...out };
  }

  if (name === 'site.replaceImage') {
    requireEnt('inlineEdits', 'Image edits are not on your plan.');
    const payload = {
      replaceSrc: a.replaceSrc || a.src,
      data: a.data,
      mimeType: a.mimeType,
    };
    const out = await portal.applyClientImageUpload(ws, leadId, payload);
    return { plan: planId, ...out };
  }

  if (name === 'site.generateImage') {
    requireEnt('inlineEdits', 'Image edits are not on your plan.');
    const out = await portal.generateClientSiteImage(
      ws,
      leadId,
      { replaceSrc: a.replaceSrc || a.src, prompt: a.prompt },
      clientEmail
    );
    return { plan: planId, ...out };
  }

  if (name === 'site.setLogo') {
    requireEnt('inlineEdits', 'Logo edits are not on your plan.');
    const out = await portal.applyClientLogoUpload(ws, leadId, a);
    return { plan: planId, ...out };
  }

  if (name === 'pages.structure') {
    const out = portal.getClientSiteStructure(ws, leadId);
    return { plan: planId, ...out };
  }

  if (name === 'pages.structure.update') {
    requireEnt('inlineEdits', 'Structure edits require inline edit access.');
    const out = portal.applyClientStructureReorder(ws, leadId, a);
    return { plan: planId, ...out };
  }

  if (name === 'theme.get') {
    const data = portal.renderClientSite(ws, leadId, { editable: false });
    return {
      plan: planId,
      siteId: data.siteId,
      theme: data.theme,
      logo: data.logo,
    };
  }

  if (name === 'theme.set') {
    requireEnt('inlineEdits', 'Theme edits are not on your plan.');
    const out = await portal.applyClientThemeColors(ws, leadId, a);
    return { plan: planId, ...out };
  }

  if (name === 'fonts.list') {
    const fonts = require('../public/js/fonts.js');
    let list = Array.isArray(fonts.CATALOG) ? fonts.CATALOG.slice() : [];
    const group = a.group != null ? String(a.group).trim() : '';
    if (group) {
      const g = group.toLowerCase();
      list = list.filter((f) => String(f.group || '').toLowerCase() === g);
    }
    return {
      plan: planId,
      fonts: list.map((f) => ({
        name: f.name,
        group: f.group,
        generic: f.generic,
        stack: fonts.stackFor(f.name),
      })),
      groups: [...new Set((fonts.CATALOG || []).map((f) => f.group).filter(Boolean))],
      count: list.length,
      note: 'Free local catalog. Pass name to theme.set ({ font, headingFont }).',
    };
  }

  if (name === 'modules.attach') {
    requireEnt('siteModules', 'Site modules require Standard or Premium.');
    const moduleType = a.module || a.moduleType;
    const out = await portal.attachSiteModule(ws, leadId, moduleType, a, clientEmail);
    return {
      plan: planId,
      embed_mode: 'js',
      note: 'Call site.publish after attach so the public site picks up the mount.',
      ...out,
    };
  }

  if (name === 'modules.detach') {
    requireEnt('siteModules', 'Site modules require Standard or Premium.');
    const moduleType = a.module || a.moduleType;
    const out = await portal.detachSiteModule(ws, leadId, moduleType, clientEmail);
    return { plan: planId, ...out };
  }

  if (name === 'modules.uploadImage') {
    requireEnt('siteModules', 'Site modules require Standard or Premium.');
    const out = await portal.applyModuleAssetUpload(ws, leadId, a);
    return { plan: planId, ...out };
  }

  if (name === 'social.accounts.list') {
    const out = portal.socialAccountsForClient(ws, leadId);
    return { plan: planId, ...out };
  }

  if (name === 'social.calendar') {
    const out = await portal.calendarPosts(ws, leadId, {
      year: a.year,
      month: a.month,
      clientEmail,
    });
    return { plan: planId, ...out };
  }

  if (name === 'social.generate') {
    const period = String(a.period || 'month').toLowerCase() === 'week' ? 'week' : 'month';
    const out = await portal.generateSocial(ws, leadId, clientEmail, period);
    return { plan: planId, ...out };
  }

  if (name === 'billing.get') {
    const out = await portal.billingForClient(ws, clientEmail);
    return { plan: planId, ...out };
  }

  if (name === 'billing.checkout') {
    const plan = a.planId || a.plan || 'standard';
    const out = await portal.openCheckout(ws, clientEmail, plan);
    return { plan: planId, ...out };
  }

  if (name === 'billing.portal') {
    const out = await portal.openBillingPortal(ws, clientEmail);
    return { plan: planId, ...out };
  }

  if (name === 'billing.changePlan') {
    const out = await portal.changePlan(ws, clientEmail, need(a.planId, 'planId'));
    return { plan: planId, ...out };
  }

  if (name === 'billing.cancel') {
    const out = await portal.cancelToFree(ws, clientEmail);
    return { plan: planId, ...out };
  }

  if (name === 'billing.resume') {
    const out = await portal.resumeBilling(ws, clientEmail);
    return { plan: planId, ...out };
  }

  if (name === 'billing.credits.checkout') {
    const out = await portal.openCreditsCheckout(ws, clientEmail, a.quantity || 1);
    return { plan: planId, ...out };
  }

  if (name === 'changes.submit') {
    requireEnt('designChangeRequests', 'Change requests are not on your plan.');
    const out = await portal.submitChangeRequest(ws, leadId, clientEmail, a);
    return { plan: planId, ...out };
  }

  return undefined;
}

module.exports = {
  portalToolDefs,
  dispatchPortalTool,
  resolveClientEmail,
};
