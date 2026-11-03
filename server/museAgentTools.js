// @ts-check
'use strict';

/**
 * Batch 111 (consolidation step 4) — the portal agent tool catalogues (read/mutate/design sets, deny list) + per-mode step budgets + the mode tool gate.
 * PURE code motion from server/museAgent.js (no logic edits, no
 * prompt-text changes); server/museAgent.js re-exports the full
 * original surface.
 */



const MAX_STEPS = 36;
const MAX_PORTAL_STEPS = 20;
const REQUEST_TIMEOUT_MS = 180000;

/** Mutating client tools — after any of these, portal chat refreshes the preview. */
const PORTAL_MUTATE_TOOLS = new Set([
  'site.editText',
  'site.editListItem',
  'site.replaceImage',
  'site.generateImage',
  'site.setLogo',
  'theme.set',
  'theme.styleRule',
  'pages.structure.update',
  'modules.attach',
  'modules.detach',
  'modules.uploadImage',
  'site.publish',
  'site.canvasBlock',
  'website.addModule',
  // Batch 122: shared-layer links change rendered pages (an event's
  // gallery) — refresh the preview after them like other mutations.
  'shared.link',
  'shared.unlink',
]);

/** Tools Muse must not call in Hands-off (destructive / meta / job control). */
const DENY_TOOLS = new Set([
  'lead.delete',
  'website.delete',
  'jobs.delete',
  'jobs.create',
  'jobs.update',
  'jobs.runNow',
  'automation.pause',
  'automation.resume',
  'settings.set',
  'prompts.save',
  'handsOff.runNow',
  'handsOff.status',
]);

/**
 * Batch 93 — the portal chat is a design AGENT, not a build pipe:
 * a message may be a question, an underspecified change (clarify
 * first), a specific change (implement), or off-topic (decline).
 * Question / clarification turns run READ-ONLY. PORTAL_MUTATE_TOOLS
 * is NOT the fence — it only lists the tools after which the preview
 * refreshes, while the client-scoped catalog carries many more
 * mutating tools (blog.create, datatables.addRow, …). The fence is
 * this explicit ALLOWLIST of pure reads (get / list / preview /
 * render), applied through the single seam portalModeAllowsTool():
 * read-only modes never OFFER a tool outside the list, and the
 * dispatch refuses one even if a wire name somehow resolves.
 */
const PORTAL_READONLY_TOOLS = new Set([
  'site.get',
  'site.render',
  'theme.get',
  'pages.structure',
  'modules.list',
  'blog.list',
  'careers.list',
  'courses.list',
  'datatables.get',
  'charts.get',
  'directory.list',
  'ecommerce.list',
  'ecommerce.listOrders',
  'events.list',
  'faq.list',
  'forms.get',
  'forms.list',
  'gallery.list',
  'menu.list',
  'offers.list',
  'team.list',
  'testimonials.list',
  'video.list',
  'bookings.list',
  'bookings.services',
  'bookings.getHours',
  'bookings.slots',
  'estimate.getConfig',
  'estimate.listOptions',
  'estimate.listRequests',
  'members.getConfig',
  'members.listTiers',
  'members.listMembers',
  'members.listSubscriptions',
  'calls.list',
  'calls.getSettings',
  'googlereviews.getConfig',
  'googlereviews.preview',
  'socialfeed.getConfig',
  'socialfeed.preview',
  // Batch 122: the shared module layer's reads — first-class agent
  // surface for composing across modules.
  'shared.sources',
  'shared.items',
  'shared.refs',
  'social.accounts.list',
  'social.calendar',
  'social.posts.list',
  'fonts.list',
]);

/** Step caps per chat mode — Q&A / clarification turns stay cheap. */
const PORTAL_MODE_STEPS = { build: MAX_PORTAL_STEPS, answer: 6, clarify: 5 };

/**
 * Batch 98 (SEC-06) — build mode's POSITIVE allowlist. Until now
 * build mode could use the whole client-scoped catalog minus a
 * 12-tool deny list (review finding M2: billing.*, social.*,
 * chatbot.*, members.grantComp, datatables.clear and more were
 * reachable from a chat turn). The fence is now default-deny:
 * build mode may use ONLY the read allowlist plus the design /
 * content writes below — the tools that design or author the
 * owner's OWN site. Money (billing.*), outbound channels
 * (social.*, email/sms/outreach), the visitor chatbot's
 * conversation tools, member comp grants, bulk clears
 * (datatables.clear, charts.clear) and every workspace/admin
 * surface are simply not in the set, so they are never offered
 * and refused again at dispatch.
 */
const PORTAL_DESIGN_WRITE_TOOLS = new Set([
  ...PORTAL_MUTATE_TOOLS,
  'blog.create', 'blog.update', 'blog.delete',
  'faq.create', 'faq.update', 'faq.delete',
  'gallery.addImage', 'gallery.create', 'gallery.update', 'gallery.delete',
  'menu.addCategory', 'menu.create', 'menu.delete', 'menu.deleteCategory', 'menu.update', 'menu.updateCategory',
  'team.create', 'team.update', 'team.delete',
  'testimonials.create', 'testimonials.update', 'testimonials.delete',
  'events.create', 'events.update', 'events.delete',
  'careers.create', 'careers.update', 'careers.delete',
  'courses.addLesson', 'courses.create', 'courses.update', 'courses.delete',
  'video.create', 'video.update', 'video.delete',
  'directory.create', 'directory.update', 'directory.delete',
  'offers.create', 'offers.update', 'offers.delete',
  'charts.create', 'charts.update', 'charts.delete',
  'datatables.addRow', 'datatables.addRows', 'datatables.updateRow', 'datatables.deleteRow',
  'datatables.setColumns', 'datatables.setDisplay',
  'forms.create', 'forms.update', 'forms.delete', 'forms.suggestFields',
  'bookings.createService', 'bookings.updateService', 'bookings.deleteService',
  'bookings.setHours', 'bookings.setSettings',
  'estimate.createOption', 'estimate.updateOption', 'estimate.deleteOption', 'estimate.updateConfig',
  'members.createTier', 'members.updateTier', 'members.updateConfig',
  'ecommerce.create', 'ecommerce.update', 'ecommerce.delete',
  'googlereviews.updateConfig', 'googlereviews.refresh',
  'socialfeed.updateConfig',
  // Batch 122: cross-module links are design writes (same config the
  // portal edits — no agent-only back door).
  'shared.link', 'shared.unlink',
]);

/** Everything build mode may touch: reads ∪ design/content writes. */
const PORTAL_DESIGN_TOOLS = new Set([...PORTAL_READONLY_TOOLS, ...PORTAL_DESIGN_WRITE_TOOLS]);

/**
 * THE fence (Batch 93, rebuilt Batch 98). Build mode is a
 * POSITIVE allowlist (PORTAL_DESIGN_TOOLS — SEC-06); answer /
 * clarify modes may use ONLY the read allowlist.
 */
function portalModeAllowsTool(mode, name) {
  if (mode === 'build') return PORTAL_DESIGN_TOOLS.has(name);
  return PORTAL_READONLY_TOOLS.has(name);
}


module.exports = {
  MAX_STEPS,
  MAX_PORTAL_STEPS,
  PORTAL_MUTATE_TOOLS,
  DENY_TOOLS,
  PORTAL_READONLY_TOOLS,
  PORTAL_DESIGN_WRITE_TOOLS,
  PORTAL_DESIGN_TOOLS,
  portalModeAllowsTool,
  REQUEST_TIMEOUT_MS,
  PORTAL_MODE_STEPS,
};
