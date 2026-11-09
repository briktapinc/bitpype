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
  'site.',
  /* Batch 168 (S2#3): 'rentals.' was in this allow list even though
   * the file header and the rentals.* tool definitions both say
   * renting is staff-driven and workspace-token-only — a vendor
   * token could create an ACTIVE rental (rerouting a client's call
   * forwarding and delivery, emailing the tenant), end it, and
   * permanently delete it. Removed; rentals are not design work. */
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

/* Batch 168 (S2#1): the REST mirror of the class boundary. A
 * vendor_design token is a DESIGN-ONLY credential: on REST it may
 * read leads and read/update design + website content (the surfaces
 * its allowed MCP tools map to — design.* / website.* / content
 * modules) and nothing else. Enforcement must live at the REST edge
 * because the REST route table grew its own role checks over time
 * (several routes explicitly admit 'member'/'token' roles, which a
 * workspace token satisfies) — without this guard a vendor token
 * could register domains (real spend on the platform's Cloudflare
 * payment method), run jobs, send mail and delete leads over REST
 * while MCP refused the same calls. Deny-by-default: any method or
 * path not matched here is refused. Matching is on the path AFTER
 * the /api/v1 mount (req.path inside the mounted routers). */
const VENDOR_REST_READ_PREFIXES = ['/leads', '/design', '/websites', '/activity'];
const VENDOR_REST_WRITE_PREFIXES = ['/design', '/websites'];

function vendorRestAllowed(method, rawPath) {
  const m = String(method || 'GET').toUpperCase();
  const p = String(rawPath || '').split('?')[0];
  if (!p.startsWith('/')) return false;
  if (m === 'GET' || m === 'HEAD') {
    return VENDOR_REST_READ_PREFIXES.some((x) => p === x || p.startsWith(x + '/'));
  }
  if (m === 'POST' || m === 'PUT' || m === 'PATCH') {
    // Destructive or money-moving design/website actions stay
    // denied even inside the write prefixes (mirrors the MCP deny
    // list: website.delete / design.delete are exact denies there).
    if (/(^|\/)(delete|purge|restore|standalone-backup)(\/|$)/.test(p)) return false;
    if (/\/websites\/generate(\/|$)/.test(p)) return false; // AI-spend generation run
    return VENDOR_REST_WRITE_PREFIXES.some((x) => p === x || p.startsWith(x + '/'));
  }
  return false; // DELETE and anything exotic: never for this class
}

function vendorToolAllowed(name) {
  const n = String(name || '');
  if (!n) return false;
  if (DENY_EXACT.has(n)) return false;
  for (const p of DENY_PREFIXES) if (n.startsWith(p)) return false;
  if (ALLOW_EXACT.has(n)) return true;
  for (const p of ALLOW_PREFIXES) if (n.startsWith(p)) return true;
  return false;
}

module.exports = { vendorToolAllowed, vendorRestAllowed, DENY_EXACT, DENY_PREFIXES, ALLOW_PREFIXES, ALLOW_EXACT };
