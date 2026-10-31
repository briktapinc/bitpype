'use strict';

/**
 * Capability source of truth for the portal design chat
 * (Batch 94) — the shared registry Ely's four-role rebuild will
 * consume.
 *
 * The defect this kills: the agent REFUSED a job in one message
 * ("my editing tools only change overall text colors, not
 * H3-specific styling") and CLAIMED the same job in the next
 * ("And yes — I can make all H3s dark grey. Just say the word").
 * Both statements were free-text inventions. Capability text is
 * now DERIVED from the tool registry: a capability line exists
 * only when its tool is actually in the catalog offered to the
 * chat, and the prompts instruct the agent that this list is the
 * whole truth — never refuse what is listed, never promise what
 * is not. One function, every surface (build prompt, answer
 * prompt, tests).
 */

/** tool name → owner-language capability line. */
const CAPABILITY_LABELS = {
  'site.editText': 'edit the words anywhere on the site — headlines, paragraphs, button labels, list and card text',
  'site.editListItem': 'add, remove, or reorder items in lists, cards, and FAQs',
  'site.replaceImage': 'swap a site image for one the owner provides',
  'site.generateImage': 'generate a brand-new image and place it on the site',
  'site.setLogo': 'change the logo or brand name shown in the header',
  'theme.set': "change the site's overall theme colours and fonts",
  'theme.styleRule':
    'change the colour and typography of SPECIFIC elements — e.g. ALL H3 headings, paragraphs, or links — across the whole site or inside one kind of section (a scoped style rule in the site stylesheet)',
  'pages.structure.update': 'reorder pages or sections, add a new page, and show or hide pages in the menu',
  'modules.attach': 'add a module to the site (blog, bookings, gallery, contact form, and the rest of the module catalog)',
  'modules.detach': 'remove a module from the site',
  'modules.uploadImage': 'upload an image into a module',
  'site.canvasBlock': 'add or edit freeform content blocks on a page',
  'website.addModule': 'add a module to the site (blog, bookings, gallery, contact form, and the rest of the module catalog)',
  'site.publish': 'publish the site and refresh its public preview',
};

/** Lines for exactly the tools present — deduped, registry order stable. */
function portalCapabilityLines(toolNames) {
  const have = new Set(Array.isArray(toolNames) ? toolNames : []);
  const seen = new Set();
  const lines = [];
  for (const [name, line] of Object.entries(CAPABILITY_LABELS)) {
    if (!have.has(name) || seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }
  return lines;
}

/** The prompt block every chat mode shares. */
function portalCapabilityText(toolNames) {
  const lines = portalCapabilityLines(toolNames);
  if (!lines.length) return '';
  return [
    'YOUR CAPABILITIES — this list is generated from the tools you actually have in this chat, and it is the single source of truth for what you can and cannot do. NEVER say you cannot do something that is on this list. NEVER claim you can do something that is not on it — if a request needs something unlisted, say so once, plainly, and offer the closest listed alternative instead:',
    ...lines.map((l) => `- ${l}`),
  ].join('\n');
}

module.exports = { CAPABILITY_LABELS, portalCapabilityLines, portalCapabilityText };
