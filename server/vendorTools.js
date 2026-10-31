'use strict';
/**
 * Batch 103 (SEC-09) — vendor design-agent token class.
 *
 * A workspace token minted with token_class='vendor_design' is the
 * class a Solo licensee's design agent runs under: it may do design,
 * website, module and content work plus lead READS — and nothing that
 * spends money, sends messages, changes account/billing state, or
 * deletes outside the design surface. Enforcement is at MCP dispatch
 * (server/mcp.js callTool), deny-by-default: anything not explicitly
 * allowed here is refused with VENDOR_TOKEN_FORBIDDEN.
 *
 * The deny list mirrors the fix log (SEC-09) verbatim; the allow side
 * is the positive list. Deny wins over allow where both could match.
 */

// Explicit denies from the SEC-09 spec (fix log, Audit 1 Q6 matrix).
const DENY_EXACT = new Set([
  'domains.register',
  'cloudflare.publish',
  'settings.set',
  'prompts.save',
  'sms.queue',
  'lead.bulk',
  'lead.importCsv',
  'lead.delete',
  'website.delete',
  'design.delete',
  'datatables.clear',
  'members.grantComp',
  // Same-risk siblings of the named denies:
  'members.revokeComp',
  'domains.link',
  'domains.unlink',
]);

// Whole namespaces that are never design work: money movement,
// telephony, outbound messaging, automation, account membership.
const DENY_PREFIXES = ['billing.', 'calls.', 'automation.', 'handsOff.', 'email.', 'outreach.', 'jobs.', 'sms.', 'members.', 'social.'];

// Content/module namespaces a design agent legitimately drives.
const ALLOW_PREFIXES = [
  'design.',
  'website.',
  'modules.',
  'menu.',
  'forms.',
  'gallery.',
  'testimonials.',
  'faq.',
  'blog.',
  'charts.',
  'datatables.',
  'courses.',
  'events.',
  'team.',
  'offers.',
  'careers.',
  'directory.',
  'ecommerce.',
  'video.',
  'googlereviews.',
  'socialfeed.',
  'bookings.',
  'estimate.',
  'rentals.',
  'site.',
];

// Individual reads outside the allow prefixes.
const ALLOW_EXACT = new Set([
  // Lead reads only (the class may look, never mutate the CRM).
  'lead.search',
  'lead.get',
  'lead.facets',
  'lead.duplicates',
  'lead.timeline',
  // Domain reads (register/link/unlink stay denied above).
  'domains.check',
  'domains.list',
  'domains.owned',
  'domains.search',
  'domains.status',
  // Connection test is a read; publish is denied above. Previews flow
  // through website.preview / design preview tools, not this one.
  'cloudflare.test',
  'settings.get',
  'prompts.list',
  'activity.recent',
  'ai.usage',
]);

function vendorToolAllowed(name) {
  const n = String(name || '');
  if (!n) return false;
  if (DENY_EXACT.has(n)) return false;
  for (const p of DENY_PREFIXES) if (n.startsWith(p)) return false;
  if (ALLOW_EXACT.has(n)) return true;
  for (const p of ALLOW_PREFIXES) if (n.startsWith(p)) return true;
  return false;
}

module.exports = { vendorToolAllowed, DENY_EXACT, DENY_PREFIXES, ALLOW_PREFIXES, ALLOW_EXACT };
