'use strict';

/* ------------------------------------------------------------------ */
/* Batch 197 — SECTION CUSTOM TEMPLATES (Module Custom Layouts, Pt A)  */
/*                                                                     */
/* Ely's ask (2026-11-19): modules are rigid — fixed markup, one per   */
/* row. He wants the module's CORE FUNCTIONALITY unchanged while the   */
/* layout/design becomes fully custom: the agent rewrites the HTML     */
/* using the same names, classes and ids, and the behaviour must not   */
/* change. His guess — "we need the agent to know what elements go     */
/* into the module design" — is exactly the gap this file closes.      */
/*                                                                     */
/* This module is THE HOOKS MANIFEST + TEMPLATE ENGINE for design      */
/* sections (Family A in the 2026-11-19 investigation):                 */
/*                                                                     */
/*   MANIFEST — one entry per renderer type in src/websiteEngine.js    */
/*   (parity-checked by the batch197 suite: a renderer type without    */
/*   a manifest entry fails the suite, the Batch 122/188 discipline).  */
/*   Each entry declares the type's functional contract: the           */
/*   substitution tokens a template may use (with the escaping kind    */
/*   of each value), the item fields of each loop, the REQUIRED        */
/*   hooks a template must keep (form field names, the form action     */
/*   token, anchor ids, data attributes), and the DOM hooks the        */
/*   export browser audit asserts in the rendered page.                */
/*                                                                     */
/*   TEMPLATE — a section may carry `section.template`: sanitized      */
/*   HTML + substitution tokens ({{name}}, {{#items}}…{{/items}},      */
/*   {{#if name}}…{{/if}}). NO agent JavaScript: templates pass the     */
/*   platform sanitizer (scripts and on* handlers stripped) and the    */
/*   engine only substitutes pre-escaped values built by the same      */
/*   helpers the standard renderers use. Stored ONLY when set (the     */
/*   Batch 148/188 rule): absent = today's renderer, byte-identical.   */
/*                                                                     */
/*   SAFETY — a template is validated against the manifest on every    */
/*   write path (missing required hooks are rejected, naming the       */
/*   hook), and at render time ANY error falls back silently to the    */
/*   standard renderer: a broken template can never break a page.      */
/*                                                                     */
/* Types where free-HTML templates are unsafe or meaningless in v1     */
/* are manifest-only (templates:false + the reason recorded): page     */
/* chrome (nav/footer — freestyle content.html already exists and      */
/* variants fence chrome too), html (already fully free HTML), the     */
/* Family B mounts (bitpype_form/form — Part C; site_module —          */
/* Part B), and columns (the composition primitive whose cells render  */
/* widgets/mounts a flat template cannot express).                     */
/* ------------------------------------------------------------------ */

const MAX_TEMPLATE_CHARS = 100000;

/* Token kinds (what the substituted value is, so the agent places it
 * correctly): 'text' = escaped plain text (safe as element content or
 * inside an attribute value); 'html' = a rendered markup fragment
 * built by the renderer's own helpers (element content only);
 * 'url' = an escaped URL (use inside href/src/action attributes). */
const T_TEXT = 'text';
const T_HTML = 'html';
const T_URL = 'url';

function tok(name, kind, description) {
  return { name, kind, description };
}

function loopDef(name, description, fields) {
  return { name, description, fields };
}

/* Hook kinds (checked against the template string at save time):
 *   token      — a scalar token is used: {{name}}
 *   tokenAttr  — a token is used inside an attribute: attr="{{name}}"
 *   loop       — a loop is used: {{#name}}…{{/name}}
 *   element    — an element tag is present: <form>
 *   field      — a form field carries name="…"
 *   id         — an element carries id="…"
 *   attr       — an attribute is present with an exact value
 *   attrToken  — an attribute's value is a token: name="{{token}}"
 *   submit     — a submit control is present
 *   anyToken   — at least one of the named scalar tokens is used
 * `when: 'bound'` hooks apply only when the section's content binds a
 * platform form (content.form_action / content.form_token set).
 * `modes: ['static'|'embed']` hooks (Batch 198) apply only in that
 * contact_form rendering mode: 'embed' when the content carries
 * bitpype_embed_html (the renderer suppresses the static fields and
 * the browser-built embed form is the working form), else 'static'. */
function hook(def) {
  return Object.assign({ required: true }, def);
}
function optHook(def) {
  return Object.assign({ required: false }, def);
}

const MANIFEST = [
  {
    type: 'nav',
    label: 'Navigation (chrome)',
    summary:
      'Page chrome. The nav already accepts fully freestyle HTML via content.html (rendered inside .ws-nav-chrome), so no template channel is added in v1 — chrome is fenced from per-section design systems, as with variants.',
    templates: false,
    reason:
      'nav is page chrome: it already takes freestyle HTML through content.html, and chrome carries no variants or templates in v1.',
    tokens: [],
    loops: [],
    hooks: [],
    domHooks: [],
  },
  {
    type: 'hero',
    label: 'Hero',
    summary:
      'The page-opening headline block. A template lays out the headline, subheadline, rating badge, calls to action and photo freely; the data (and its escaping) is identical to the standard hero.',
    templates: true,
    tokens: [
      tok('headline', T_HTML, 'The headline (H1 copy), escaped and edit-wrapped like the standard hero.'),
      tok('subheadline', T_HTML, 'The subheadline paragraph copy; empty when unset.'),
      tok('ratingBadge', T_HTML, 'The ★ rating · review-count badge markup; empty when rating/review_count are unset.'),
      tok('ctaText', T_HTML, 'Primary call-to-action label; empty when unset.'),
      tok('ctaHref', T_URL, 'Primary call-to-action URL (defaults to #contact).'),
      tok('ctaSecondaryText', T_HTML, 'Secondary call-to-action label; empty when unset.'),
      tok('ctaSecondaryHref', T_URL, 'Secondary call-to-action URL (defaults to #services).'),
      tok('image', T_HTML, 'The side photo <figure> markup; empty when a background image is set or no photo exists.'),
      tok('backgroundImage', T_URL, 'The full-bleed background image URL; empty when unset.'),
    ],
    loops: [],
    hooks: [hook({ kind: 'token', token: 'headline', label: '{{headline}} — the hero headline must reach the page' })],
    domHooks: [],
  },
  {
    type: 'benefits',
    label: 'Benefits',
    summary:
      'A grid of benefit cards (icon, title, text). A template controls the card layout; every item in content.items renders through the loop.',
    templates: true,
    tokens: [
      tok('title', T_HTML, 'Section title; empty when unset.'),
      tok('subtitle', T_HTML, 'Section lede; empty when unset.'),
    ],
    loops: [
      loopDef('items', 'One pass per benefit in content.items.', [
        tok('title', T_HTML, 'Benefit title.'),
        tok('text', T_HTML, 'Benefit body copy.'),
        tok('icon', T_HTML, 'The item icon (or numbered chip) markup, as the standard renderer emits it.'),
        tok('index', T_TEXT, '1-based position in the loop.'),
      ]),
    ],
    hooks: [hook({ kind: 'loop', token: 'items', label: 'the {{#items}} loop — benefit items must render' })],
    domHooks: [],
  },
  {
    type: 'services',
    label: 'Services',
    summary:
      'The services grid. The section root carries id="services" — the anchor other sections link to (e.g. the hero secondary CTA defaults to #services) — so a template must keep that id on some element.',
    templates: true,
    tokens: [
      tok(
        'title',
        T_HTML,
        'Section title (the standard renderer falls back to "Our Services" in its heading only; the token is empty when unset).'
      ),
      tok('subtitle', T_HTML, 'Section lede; empty when unset.'),
    ],
    loops: [
      loopDef('items', 'One pass per service in content.items.', [
        tok('name', T_HTML, 'Service name.'),
        tok('description', T_HTML, 'Service description.'),
        tok('icon', T_HTML, 'The item icon markup; empty when the item has no known icon.'),
        tok('index', T_TEXT, '1-based position in the loop.'),
      ]),
    ],
    hooks: [
      hook({ kind: 'loop', token: 'items', label: 'the {{#items}} loop — services must render' }),
      hook({ kind: 'id', id: 'services', label: 'id="services" — the #services anchor target other sections link to' }),
    ],
    domHooks: [],
  },
  {
    type: 'about',
    label: 'About',
    summary: 'A titled prose block: one title plus a list of paragraphs.',
    templates: true,
    tokens: [tok('title', T_HTML, 'Section title; empty when unset.')],
    loops: [
      loopDef('paragraphs', 'One pass per paragraph in content.paragraphs.', [
        tok('text', T_HTML, 'The paragraph copy.'),
        tok('index', T_TEXT, '1-based position in the loop.'),
      ]),
    ],
    hooks: [
      hook({ kind: 'loop', token: 'paragraphs', label: 'the {{#paragraphs}} loop — the about copy must render' }),
    ],
    domHooks: [],
  },
  {
    type: 'gallery',
    label: 'Gallery',
    summary:
      'A photo grid. Each loop pass carries the rendered <figure> when the slot has a usable photo, or the gradient placeholder markup when it does not — use {{#if image}}{{image}}{{/if}}{{#if placeholder}}… style branching, or simply emit both tokens (the unused one is empty).',
    templates: true,
    tokens: [
      tok(
        'title',
        T_HTML,
        'Section title (standard fallback "Gallery" is the renderer’s; the token is empty when unset).'
      ),
      tok('subtitle', T_HTML, 'Section lede; empty when unset.'),
    ],
    loops: [
      loopDef('images', 'One pass per gallery slot (content.images, max 6; three placeholder slots when empty).', [
        tok('image', T_HTML, 'The photo <figure> markup; empty when the slot has no usable photo.'),
        tok('placeholder', T_HTML, 'The gradient placeholder block; empty when the slot has a photo.'),
        tok('src', T_URL, 'The photo URL; empty when the slot has no usable photo.'),
        tok('caption', T_TEXT, 'The photo caption (also the placeholder label).'),
        tok('index', T_TEXT, '1-based position in the loop.'),
      ]),
    ],
    hooks: [hook({ kind: 'loop', token: 'images', label: 'the {{#images}} loop — gallery photos must render' })],
    domHooks: [],
  },
  {
    type: 'reviews',
    label: 'Reviews',
    summary:
      'Customer review cards with a star row. A template controls the card layout; every review renders through the loop.',
    templates: true,
    tokens: [
      tok(
        'title',
        T_HTML,
        'Section title (standard fallback "What Customers Say" is the renderer’s; the token is empty when unset).'
      ),
      tok('subtitle', T_HTML, 'Section lede; empty when unset.'),
    ],
    loops: [
      loopDef('reviews', 'One pass per review in content.reviews.', [
        tok('text', T_HTML, 'The review copy.'),
        tok('name', T_HTML, 'The reviewer name.'),
        tok('stars', T_TEXT, 'The star row as ★/☆ characters (e.g. ★★★★☆).'),
        tok('rating', T_TEXT, 'The numeric star rating, 1–5.'),
        tok('index', T_TEXT, '1-based position in the loop.'),
      ]),
    ],
    hooks: [hook({ kind: 'loop', token: 'reviews', label: 'the {{#reviews}} loop — reviews must render' })],
    domHooks: [],
  },
  {
    type: 'cta',
    label: 'Call to action',
    summary: 'A single call-to-action band: title, optional text, optional button.',
    templates: true,
    tokens: [
      tok(
        'title',
        T_HTML,
        'The CTA heading (falls back to "Get in touch today" when unset, like the standard renderer).'
      ),
      tok('text', T_HTML, 'Supporting copy; empty when unset.'),
      tok('buttonText', T_HTML, 'Button label; empty when unset.'),
      tok('buttonHref', T_URL, 'Button URL (defaults to #contact).'),
    ],
    loops: [],
    hooks: [hook({ kind: 'token', token: 'title', label: '{{title}} — the CTA heading must reach the page' })],
    domHooks: [],
  },
  {
    type: 'contact_form',
    label: 'Contact form',
    summary:
      'The one static <form> among the sections — and the functional heart of Part A. The form contract is exactly what the standard renderer emits: a <form> whose action is {{formAction}} (the platform form’s public submit URL when bound, else the mailto: fallback), fields named name / phone / email / message, and a submit control. When the section is bound to a platform form (content.form_action / form_token set at sync), the form must also carry data-bitpype-form="1" and the form-token attribute set to the formToken substitution. A form may be bound AFTER the template is saved (the platform binds contact forms at save/sync), so the robust pattern emits those two attributes inside a {{#if bound}}…{{/if}} block in the form tag — they render only when bound. Keep id="contact" on some element — it is the #contact anchor target the hero CTAs point at. {{fields}} substitutes the standard field block wholesale when a template only wants to rearrange the chrome around working fields. EMBED MODE (Batch 198): when the section content carries bitpype_embed_html, the standard renderer suppresses the static fields entirely and the working form is the browser-built embed (form-embed.js builds the fields from the same form schema and submits with captcha). In that mode the static-form hooks do not apply; instead the template MUST include {{embedHtml}} — dropping it drops the form itself — and should restyle the chrome around the embed mount. id="contact" is required in both modes.',
    templates: true,
    tokens: [
      tok('title', T_TEXT, 'Section title (falls back to "Contact Us" when unset).'),
      tok('text', T_TEXT, 'Intro copy; empty when unset.'),
      tok(
        'formAction',
        T_URL,
        'The exact form action the standard renderer emits: the bound form’s public submit URL, or the mailto: fallback, or #.'
      ),
      tok('formToken', T_TEXT, 'The bound platform form’s public token; empty when unbound.'),
      tok('bound', T_TEXT, '"1" when the section is bound to a platform form, else empty — for {{#if bound}} blocks.'),
      tok(
        'fields',
        T_HTML,
        'The standard field block (Name/Phone/Email/Message fields + submit button) as rendered markup, for templates that keep the working fields and restyle around them. Using {{fields}} satisfies the field and submit hooks.'
      ),
      tok(
        'embedHtml',
        T_HTML,
        'The sanitized bitpype_embed_html slot content when the section carries it; empty otherwise.'
      ),
      tok('phone', T_TEXT, 'Display phone number; empty when unset.'),
      tok('phoneHref', T_URL, 'tel: link for the phone number; empty when unset.'),
      tok('email', T_TEXT, 'Display email address; empty when unset.'),
      tok('emailHref', T_URL, 'mailto: link for the email address; empty when unset.'),
      tok('address', T_TEXT, 'Postal address; empty when unset.'),
    ],
    loops: [],
    hooks: [
      hook({ kind: 'element', tag: 'form', modes: ['static'], label: 'a <form> element' }),
      hook({
        kind: 'tokenAttr',
        attr: 'action',
        token: 'formAction',
        modes: ['static'],
        label: 'the form action set to {{formAction}}',
      }),
      hook({
        kind: 'field',
        name: 'name',
        modes: ['static'],
        satisfiedByToken: 'fields',
        label: 'a field named "name" (or the {{fields}} block)',
      }),
      hook({
        kind: 'field',
        name: 'email',
        modes: ['static'],
        satisfiedByToken: 'fields',
        label: 'a field named "email" (or the {{fields}} block)',
      }),
      hook({
        kind: 'field',
        name: 'message',
        modes: ['static'],
        satisfiedByToken: 'fields',
        label: 'a field named "message" (or the {{fields}} block)',
      }),
      hook({
        kind: 'submit',
        modes: ['static'],
        satisfiedByToken: 'fields',
        label:
          'a submit control (button/input with type="submit", or a <button> with no type, or the {{fields}} block)',
      }),
      hook({ kind: 'id', id: 'contact', label: 'id="contact" — the #contact anchor target other sections link to' }),
      hook({
        kind: 'token',
        token: 'embedHtml',
        modes: ['embed'],
        label:
          '{{embedHtml}} — the platform form embed mount (required in embed mode: the embed builds the working form in the browser; omitting it removes the form)',
      }),
      hook({
        kind: 'attr',
        name: 'data-bitpype-form',
        value: '1',
        when: 'bound',
        modes: ['static'],
        label: 'data-bitpype-form="1" on the form (required when bound to a platform form)',
      }),
      hook({
        kind: 'attrToken',
        name: 'data-form-token',
        token: 'formToken',
        when: 'bound',
        modes: ['static'],
        label: 'data-form-token="{{formToken}}" on the form (required when bound to a platform form)',
      }),
      optHook({
        kind: 'field',
        name: 'phone',
        label:
          'a field named "phone" (the standard form collects it; omitting it loses the phone number on submission)',
      }),
      optHook({ kind: 'id', id: 'cf-name', label: 'id="cf-name" (the standard label pairing for the name field)' }),
      optHook({ kind: 'id', id: 'cf-email', label: 'id="cf-email" (the standard label pairing for the email field)' }),
      optHook({ kind: 'id', id: 'cf-msg', label: 'id="cf-msg" (the standard label pairing for the message field)' }),
    ],
    domHooks: ['form', 'form [name="name"]', 'form [name="email"]', 'form [name="message"]'],
  },
  {
    type: 'map_placeholder',
    label: 'Map placeholder',
    summary: 'A "find us" block listing address lines.',
    templates: true,
    tokens: [tok('title', T_TEXT, 'Section title (falls back to "Find Us" when unset).')],
    loops: [
      loopDef('lines', 'One pass per address line.', [
        tok('text', T_TEXT, 'The address line.'),
        tok('index', T_TEXT, '1-based position in the loop.'),
      ]),
    ],
    hooks: [hook({ kind: 'loop', token: 'lines', label: 'the {{#lines}} loop — the address must render' })],
    domHooks: [],
  },
  {
    type: 'hours',
    label: 'Business hours',
    summary: 'A day-by-day hours table.',
    templates: true,
    tokens: [tok('title', T_TEXT, 'Section title (falls back to "Business Hours" when unset).')],
    loops: [
      loopDef('hours', 'One pass per day row in content.hours.', [
        tok('day', T_TEXT, 'Day label.'),
        tok('open', T_TEXT, 'Opening time as entered.'),
        tok('close', T_TEXT, 'Closing time as entered.'),
        tok('range', T_TEXT, 'The "open – close" range as the standard table prints it.'),
        tok('index', T_TEXT, '1-based position in the loop.'),
      ]),
    ],
    hooks: [hook({ kind: 'loop', token: 'hours', label: 'the {{#hours}} loop — the hours must render' })],
    domHooks: [],
  },
  {
    type: 'faq',
    label: 'FAQ',
    summary:
      'Question/answer list. The standard renderer uses <details>/<summary>; a template may use any disclosure layout as long as every question and answer renders through the loop.',
    templates: true,
    tokens: [
      tok(
        'title',
        T_HTML,
        'Section title (standard fallback "Frequently Asked Questions" is the renderer’s; the token is empty when unset).'
      ),
    ],
    loops: [
      loopDef('items', 'One pass per question in content.items.', [
        tok('q', T_HTML, 'The question.'),
        tok('a', T_HTML, 'The answer.'),
        tok('index', T_TEXT, '1-based position in the loop.'),
      ]),
    ],
    hooks: [hook({ kind: 'loop', token: 'items', label: 'the {{#items}} loop — questions and answers must render' })],
    domHooks: [],
  },
  {
    type: 'footer',
    label: 'Footer (chrome)',
    summary:
      'Page chrome. The footer already accepts fully freestyle HTML via content.html (rendered inside .ws-footer-chrome), so no template channel is added in v1 — chrome is fenced from per-section design systems, as with variants.',
    templates: false,
    reason:
      'footer is page chrome: it already takes freestyle HTML through content.html, and chrome carries no variants or templates in v1.',
    tokens: [],
    loops: [],
    hooks: [],
    domHooks: [],
  },
  {
    type: 'booking_button',
    label: 'Booking / call button',
    summary:
      'A big call-to-action link (usually tel:). The link itself is the function: its href must be the {{href}} token.',
    templates: true,
    tokens: [
      tok('title', T_TEXT, 'Optional heading; empty when unset.'),
      tok('text', T_TEXT, 'The link label (falls back to "Call Now" when unset).'),
      tok(
        'href',
        T_URL,
        'The link URL — the phone tel: link, an explicit href, or #contact, exactly as the standard renderer computes it.'
      ),
      tok('subtext', T_TEXT, 'Small print under the link; empty when unset.'),
    ],
    loops: [],
    hooks: [hook({ kind: 'tokenAttr', attr: 'href', token: 'href', label: 'a link whose href is {{href}}' })],
    domHooks: [],
  },
  {
    type: 'social_links',
    label: 'Social links',
    summary: 'A row of social profile links with platform icons.',
    templates: true,
    tokens: [tok('title', T_TEXT, 'Section title (falls back to "Follow Us" when unset).')],
    loops: [
      loopDef('links', 'One pass per link in content.links.', [
        tok('href', T_URL, 'The profile URL.'),
        tok('label', T_TEXT, 'The accessible label (label, else network, else URL).'),
        tok('network', T_TEXT, 'The network name as entered.'),
        tok('icon', T_HTML, 'The platform icon SVG markup; empty when the network has no known icon.'),
        tok('index', T_TEXT, '1-based position in the loop.'),
      ]),
    ],
    hooks: [hook({ kind: 'loop', token: 'links', label: 'the {{#links}} loop — the social links must render' })],
    domHooks: [],
  },
  {
    type: 'custom',
    label: 'Custom block',
    summary:
      'The generic structured block (heading, body, photo, button) with an optional freestyle HTML override in content.html (exposed as {{html}}).',
    templates: true,
    tokens: [
      tok('heading', T_HTML, 'Block heading; empty when unset.'),
      tok('body', T_HTML, 'Block body copy; empty when unset.'),
      tok('image', T_HTML, 'The photo <figure> markup; empty when no photo.'),
      tok('buttonText', T_HTML, 'Button label; empty when no button.'),
      tok('buttonHref', T_URL, 'Button URL.'),
      tok('html', T_HTML, 'The sanitized freestyle content.html override; empty when unset.'),
    ],
    loops: [],
    hooks: [
      hook({
        kind: 'anyToken',
        tokens: ['heading', 'body', 'image', 'html'],
        label: 'at least one of {{heading}} / {{body}} / {{image}} / {{html}} — the block content must reach the page',
      }),
    ],
    domHooks: [],
  },
  {
    type: 'html',
    label: 'Free HTML',
    summary:
      'Already fully free HTML (content.html inside a stable wrapper) — a template would be a second free-HTML channel with no contract to preserve, so none is offered.',
    templates: false,
    reason:
      'html sections are already fully free HTML via content.html; there is no fixed markup for a template to replace.',
    tokens: [],
    loops: [],
    hooks: [],
    domHooks: [],
  },
  {
    type: 'bitpype_form',
    label: 'Platform form embed',
    summary:
      'A mount point: the form’s interior is generated in the visitor’s browser by form-embed.js from the form schema. There is no server-rendered markup to template in Part A — form slot templates are Part C.',
    templates: false,
    reason:
      'bitpype_form is a browser-rendered form mount (form-embed.js); its interior is generated client-side from the form schema — see Part C.',
    tokens: [],
    loops: [],
    hooks: [],
    domHooks: [],
  },
  {
    type: 'form',
    label: 'Platform form embed (alias)',
    summary: 'Alias of bitpype_form — same mount, same contract.',
    templates: false,
    reason: 'form is the bitpype_form alias: a browser-rendered form mount (form-embed.js) — see Part C.',
    tokens: [],
    loops: [],
    hooks: [],
    domHooks: [],
  },
  {
    type: 'site_module',
    label: 'Site module mount',
    summary:
      'A mount point for a Family B site module (blog, shop, bookings…): the page carries only the mount div + loader, and module-embed.js generates the interior in the browser. Embed templates are Part B.',
    templates: false,
    reason:
      'site_module is a browser-rendered module mount (module-embed.js); its interior is generated client-side — see Part B.',
    tokens: [],
    loops: [],
    hooks: [],
    domHooks: [],
  },
  {
    type: 'columns',
    label: 'Columns',
    summary:
      'The composition primitive: a grid of cells, each holding text, a photo, raw HTML, a form widget or a module mount. A flat per-section template cannot express per-cell widget rendering, so columns stay on the standard renderer in v1.',
    templates: false,
    reason:
      'columns is the composition primitive — its cells render widgets and module mounts (renderColCell) that a flat HTML template cannot express in v1.',
    tokens: [],
    loops: [],
    hooks: [],
    domHooks: [],
  },
  {
    type: 'text',
    label: 'Text block',
    summary:
      'A heading + body prose block, with an optional freestyle HTML override in content.html (exposed as {{html}}).',
    templates: true,
    tokens: [
      tok('heading', T_HTML, 'Block heading; empty when unset.'),
      tok('body', T_HTML, 'Block body copy; empty when unset.'),
      tok('html', T_HTML, 'The sanitized freestyle content.html override; empty when unset.'),
    ],
    loops: [],
    hooks: [
      hook({
        kind: 'anyToken',
        tokens: ['heading', 'body', 'html'],
        label: 'at least one of {{heading}} / {{body}} / {{html}} — the text must reach the page',
      }),
    ],
    domHooks: [],
  },
  {
    type: 'text_image',
    label: 'Text + image',
    summary:
      'The side-by-side explainer: heading, body, optional button, and a photo. A template frees the composition (stacked, overlapped, full-bleed…) while the photo and copy stay the section’s data.',
    templates: true,
    tokens: [
      tok('heading', T_HTML, 'Block heading; empty when unset.'),
      tok('body', T_HTML, 'Block body copy; empty when unset.'),
      tok('image', T_HTML, 'The photo <figure> markup, or the gradient placeholder block when no photo is set.'),
      tok('imageSrc', T_URL, 'The photo URL; empty when no photo is set.'),
      tok('buttonText', T_HTML, 'Button label; empty when no button.'),
      tok('buttonHref', T_URL, 'Button URL.'),
      tok('imageSide', T_TEXT, '"left" or "right" — the configured image position.'),
    ],
    loops: [],
    hooks: [
      hook({
        kind: 'anyToken',
        tokens: ['heading', 'body', 'image'],
        label: 'at least one of {{heading}} / {{body}} / {{image}} — the block content must reach the page',
      }),
    ],
    domHooks: [],
  },
  {
    type: 'cards',
    label: 'Card grid',
    summary:
      'A generic card grid (photo, title, text per card). A template controls the grid and card layout; every card renders through the loop.',
    templates: true,
    tokens: [
      tok('title', T_HTML, 'Section title; empty when unset.'),
      tok('subtitle', T_HTML, 'Section lede; empty when unset.'),
    ],
    loops: [
      loopDef('items', 'One pass per card in content.items.', [
        tok('title', T_HTML, 'Card title (item.title, else item.name).'),
        tok('text', T_HTML, 'Card copy (item.text, else item.description).'),
        tok('image', T_HTML, 'The card photo <figure> markup; empty when the card has no photo.'),
        tok('index', T_TEXT, '1-based position in the loop.'),
      ]),
    ],
    hooks: [hook({ kind: 'loop', token: 'items', label: 'the {{#items}} loop — cards must render' })],
    domHooks: [],
  },
  {
    type: 'heading',
    label: 'Heading',
    summary:
      'A standalone heading. {{tag}} is the configured heading tag (h1–h4) for templates that want the same level.',
    templates: true,
    tokens: [
      tok('heading', T_HTML, 'The heading copy.'),
      tok('level', T_TEXT, 'The heading level number, 1–4 (default 2).'),
      tok('tag', T_TEXT, 'The heading tag name, e.g. "h2".'),
    ],
    loops: [],
    hooks: [hook({ kind: 'token', token: 'heading', label: '{{heading}} — the heading must reach the page' })],
    domHooks: [],
  },
  {
    type: 'image',
    label: 'Image',
    summary: 'A standalone photo with an optional caption.',
    templates: true,
    tokens: [
      tok('image', T_HTML, 'The photo <figure> markup, or the gradient placeholder block when no photo is set.'),
      tok('src', T_URL, 'The photo URL; empty when no photo is set.'),
      tok('caption', T_TEXT, 'The caption (content.caption, else the photo alt).'),
      tok('alt', T_TEXT, 'The photo alt text.'),
    ],
    loops: [],
    hooks: [
      hook({
        kind: 'anyToken',
        tokens: ['image', 'src'],
        label: 'at least one of {{image}} / {{src}} — the photo must reach the page',
      }),
    ],
    domHooks: [],
  },
];

const BY_TYPE = new Map(MANIFEST.map((e) => [e.type, e]));

function isRegisteredType(type) {
  return BY_TYPE.has(String(type || ''));
}

function getEntry(type) {
  return BY_TYPE.get(String(type || '')) || null;
}

function isTemplateEnabled(type) {
  const e = getEntry(type);
  return !!(e && e.templates);
}

function templateDisabledReason(type) {
  const e = getEntry(type);
  if (!e) return `section type "${type}" has no template manifest entry.`;
  if (e.templates) return '';
  return `custom templates are not available for ${e.type} sections in v1: ${e.reason || 'manifest-only type.'}`;
}

function typesWithTemplates() {
  return MANIFEST.filter((e) => e.templates).map((e) => e.type);
}

/** The section's stored template, trimmed; '' when unset. */
function templateOf(section) {
  const raw = section && typeof section.template === 'string' ? section.template : '';
  return raw.trim() ? raw : '';
}

function hasStoredTemplate(section) {
  return templateOf(section) !== '';
}

/** DOM hooks per template-enabled type, for the export browser audit. */
function domHooksByType() {
  const out = {};
  for (const e of MANIFEST) {
    if (e.templates) out[e.type] = Array.isArray(e.domHooks) ? e.domHooks.slice() : [];
  }
  return out;
}

/**
 * Agent-facing manifest summary — the single source the design agent
 * (design.templates MCP tool), validation and QA all read. Per type:
 * whether templates are offered (and why not), the tokens and loop
 * fields with their escaping kinds, and the hook contract.
 */
function manifestSummary() {
  const types = {};
  for (const e of MANIFEST) {
    types[e.type] = {
      label: e.label,
      summary: e.summary,
      templates: !!e.templates,
      reason: e.templates ? null : e.reason || null,
      tokens: (e.tokens || []).map((t) => ({ name: t.name, kind: t.kind, description: t.description })),
      loops: (e.loops || []).map((l) => ({
        name: l.name,
        description: l.description,
        fields: l.fields.map((f) => ({ name: f.name, kind: f.kind, description: f.description })),
      })),
      hooks: (e.hooks || []).map((h) => ({
        label: h.label,
        required: !!h.required,
        when: h.when || null,
      })),
      domHooks: Array.isArray(e.domHooks) ? e.domHooks.slice() : [],
    };
  }
  return { version: 1, maxTemplateChars: MAX_TEMPLATE_CHARS, types };
}

/* ------------------------------------------------------------------ */
/* Template parser / renderer / validator                              */
/*                                                                     */
/* Syntax (deliberately small):                                        */
/*   {{name}}                 scalar substitution                      */
/*   {{#items}}…{{/items}}    loop over a declared loop (no nesting)   */
/*   {{#if name}}…{{/if}}     render the block when the scalar is      */
/*                            non-empty (allowed at top level and      */
/*                            inside a loop body)                      */
/* Inside a loop body, item fields shadow section scalars; {{index}}   */
/* is the 1-based position. Unknown tokens are save-time errors and    */
/* render-time throws (→ the renderer falls back to the standard       */
/* renderer, so a stored template can never break a page).             */
/* ------------------------------------------------------------------ */

class TemplateError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

function parseTemplate(src) {
  const root = { kind: 'root', children: [] };
  const stack = [root];
  const re = /\{\{([\s\S]*?)\}\}/g;
  let last = 0;
  let m;
  const pushText = (txt) => {
    if (txt) stack[stack.length - 1].children.push({ kind: 'text', text: txt });
  };
  while ((m = re.exec(src)) !== null) {
    pushText(src.slice(last, m.index));
    last = re.lastIndex;
    const inner = m[1].trim();
    if (inner.startsWith('#if')) {
      const name = inner.slice(3).trim();
      if (!NAME_RE.test(name)) {
        throw new TemplateError(
          'TEMPLATE_PARSE',
          `malformed conditional "{{#if ${inner.slice(3)}}}" — expected {{#if tokenName}}.`
        );
      }
      const node = { kind: 'if', name, children: [] };
      stack[stack.length - 1].children.push(node);
      stack.push(node);
    } else if (inner.startsWith('#')) {
      const name = inner.slice(1).trim();
      if (!NAME_RE.test(name)) {
        throw new TemplateError('TEMPLATE_PARSE', `malformed loop "{{#${inner.slice(1)}}}" — expected {{#loopName}}.`);
      }
      const node = { kind: 'loop', name, children: [] };
      stack[stack.length - 1].children.push(node);
      stack.push(node);
    } else if (inner.startsWith('/')) {
      const name = inner.slice(1).trim();
      if (stack.length === 1) {
        throw new TemplateError('TEMPLATE_PARSE', `closing tag "{{/${name}}}" has no matching opening tag.`);
      }
      const top = stack[stack.length - 1];
      if (top.kind === 'loop' && top.name !== name) {
        throw new TemplateError(
          'TEMPLATE_PARSE',
          `closing tag "{{/${name}}}" does not match the open loop "{{#${top.name}}}".`
        );
      }
      if (top.kind === 'if' && name !== 'if') {
        throw new TemplateError(
          'TEMPLATE_PARSE',
          `closing tag "{{/${name}}}" does not match the open conditional "{{#if ${top.name}}}".`
        );
      }
      stack.pop();
    } else {
      if (!NAME_RE.test(inner)) {
        throw new TemplateError(
          'TEMPLATE_PARSE',
          `malformed token "{{${inner}}}" — tokens are {{name}}, {{#loop}}…{{/loop}} and {{#if name}}…{{/if}}.`
        );
      }
      stack[stack.length - 1].children.push({ kind: 'scalar', name: inner });
    }
  }
  pushText(src.slice(last));
  if (stack.length !== 1) {
    const top = stack[stack.length - 1];
    throw new TemplateError(
      'TEMPLATE_PARSE',
      top.kind === 'loop'
        ? `loop "{{#${top.name}}}" is never closed.`
        : `conditional "{{#if ${top.name}}}" is never closed.`
    );
  }
  return root.children;
}

function lookupScalar(scopes, name) {
  for (const scope of scopes) {
    if (scope && Object.prototype.hasOwnProperty.call(scope, name)) return scope[name];
  }
  return undefined;
}

function renderNodes(nodes, scopes, loops, insideLoop) {
  let out = '';
  for (const node of nodes) {
    if (node.kind === 'text') {
      out += node.text;
    } else if (node.kind === 'scalar') {
      const v = lookupScalar(scopes, node.name);
      if (v === undefined) throw new TemplateError('TEMPLATE_UNKNOWN_TOKEN', `unknown token {{${node.name}}}.`);
      out += v;
    } else if (node.kind === 'if') {
      const v = lookupScalar(scopes, node.name);
      if (v === undefined) throw new TemplateError('TEMPLATE_UNKNOWN_TOKEN', `unknown token {{#if ${node.name}}}.`);
      if (v) out += renderNodes(node.children, scopes, loops, insideLoop);
    } else if (node.kind === 'loop') {
      if (insideLoop)
        throw new TemplateError('TEMPLATE_NESTED_LOOP', `loop {{#${node.name}}} is nested inside another loop.`);
      const items = loops ? loops[node.name] : undefined;
      if (!Array.isArray(items)) throw new TemplateError('TEMPLATE_UNKNOWN_TOKEN', `unknown loop {{#${node.name}}}.`);
      items.forEach((item, i) => {
        const itemScope = Object.assign({}, item, { index: String(i + 1) });
        out += renderNodes(node.children, [itemScope, ...scopes], loops, true);
      });
    }
  }
  return out;
}

/**
 * Render a template against a context { scalars, loops } whose values
 * are FINAL output fragments (already escaped by the engine builders).
 * Throws TemplateError on any problem — callers fall back to the
 * standard renderer.
 */
function renderTemplate(template, context) {
  const nodes = parseTemplate(String(template || ''));
  const scalars = (context && context.scalars) || {};
  const loops = (context && context.loops) || {};
  return renderNodes(nodes, [scalars], loops, false);
}

/* ------------------------- hook checks --------------------------- */

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function scalarTokenRe(name) {
  return new RegExp('\\{\\{\\s*' + escapeRegExp(name) + '\\s*\\}\\}');
}

function sectionMode(content) {
  const c = content || {};
  return String(c.bitpype_embed_html || '').trim() ? 'embed' : 'static';
}

function hookApplies(h, content) {
  if (Array.isArray(h.modes) && h.modes.length && !h.modes.includes(sectionMode(content))) return false;
  if (h.when === 'bound') {
    const c = content || {};
    return !!(String(c.form_action || '').trim() || String(c.form_token || '').trim());
  }
  return true;
}

function checkHook(h, template) {
  const src = String(template || '');
  // A hook may be satisfied by a substitution token whose expansion is
  // fixed platform markup (contact_form's {{fields}} block always
  // carries the standard fields + submit control).
  if (h.satisfiedByToken && scalarTokenRe(h.satisfiedByToken).test(src)) return true;
  switch (h.kind) {
    case 'token':
      return scalarTokenRe(h.token).test(src);
    case 'loop':
      return new RegExp('\\{\\{\\s*#\\s*' + escapeRegExp(h.token) + '\\s*\\}\\}').test(src);
    case 'tokenAttr':
      return new RegExp(
        '\\b' + escapeRegExp(h.attr) + '\\s*=\\s*["\'][^"\']*\\{\\{\\s*' + escapeRegExp(h.token) + '\\s*\\}\\}',
        'i'
      ).test(src);
    case 'element':
      return new RegExp('<' + escapeRegExp(h.tag) + '(\\s|>)', 'i').test(src);
    case 'field':
      return new RegExp(
        '<(input|textarea|select)\\b[^>]*\\bname\\s*=\\s*("|\')?' + escapeRegExp(h.name) + '("|\'|\\s|>)',
        'i'
      ).test(src);
    case 'id':
      return new RegExp('\\bid\\s*=\\s*("|\')' + escapeRegExp(h.id) + '("|\')', 'i').test(src);
    case 'attr':
      return new RegExp('\\b' + escapeRegExp(h.name) + '\\s*=\\s*("|\')' + escapeRegExp(h.value) + '("|\')', 'i').test(
        src
      );
    case 'attrToken':
      return new RegExp(
        '\\b' + escapeRegExp(h.name) + '\\s*=\\s*["\'][^"\']*\\{\\{\\s*' + escapeRegExp(h.token) + '\\s*\\}\\}',
        'i'
      ).test(src);
    case 'submit':
      return /\btype\s*=\s*("|\')submit("|\')/i.test(src) || /<button(?![^>]*\btype\s*=)[^>]*>/i.test(src);
    case 'anyToken':
      return (h.tokens || []).some((t) => scalarTokenRe(t).test(src));
    default:
      return true;
  }
}

/* ------------------------- validation ---------------------------- */

const FORBIDDEN = [
  {
    re: /<script\b/i,
    code: 'TEMPLATE_SCRIPT',
    message: 'templates may not contain <script> — JavaScript is not part of the template contract.',
  },
  {
    re: /data-bitpype-module|bitpype-module-embed|bitpype-form-embed|data-bitpype-chat/i,
    code: 'TEMPLATE_MOUNT',
    message:
      'templates may not contain module/form/chat mount markup (data-bitpype-module, bitpype-form-embed, …) — mounts are placed by their own section types.',
  },
  {
    re: /<(iframe|object|embed|base)\b/i,
    code: 'TEMPLATE_FORBIDDEN_TAG',
    message: 'templates may not contain <iframe>, <object>, <embed> or <base> elements.',
  },
];

function validTokenList(entry, loopEntry) {
  const names = (entry.tokens || []).map((t) => t.name);
  if (loopEntry) {
    for (const f of loopEntry.fields) if (!names.includes(f.name)) names.push(f.name);
  }
  return names;
}

function validateNodes(nodes, entry, loopEntry, problems) {
  for (const node of nodes) {
    if (node.kind === 'scalar' || node.kind === 'if') {
      const allowed = validTokenList(entry, loopEntry);
      if (!allowed.includes(node.name)) {
        const loops = (entry.loops || []).map((l) => l.name).join(', ') || 'none';
        problems.push({
          code: 'TEMPLATE_UNKNOWN_TOKEN',
          message:
            `unknown token {{${node.name}}} for ${entry.type} sections — valid tokens: ${allowed.join(', ') || 'none'}; valid loops: ${loops}.` +
            (loopEntry ? '' : ' (Item fields are only valid inside their loop.)'),
        });
      }
      if (node.kind === 'if') validateNodes(node.children, entry, loopEntry, problems);
    } else if (node.kind === 'loop') {
      if (loopEntry) {
        problems.push({
          code: 'TEMPLATE_NESTED_LOOP',
          message: `loop {{#${node.name}}} is nested inside {{#${loopEntry.name}}} — loops may not nest in v1; flatten the layout or use {{#if}} inside the loop.`,
        });
        continue;
      }
      const found = (entry.loops || []).find((l) => l.name === node.name);
      if (!found) {
        problems.push({
          code: 'TEMPLATE_UNKNOWN_TOKEN',
          message: `unknown loop {{#${node.name}}} for ${entry.type} sections — valid loops: ${(entry.loops || []).map((l) => l.name).join(', ') || 'none'}.`,
        });
        continue;
      }
      validateNodes(node.children, entry, found, problems);
    }
  }
}

/**
 * Validate a candidate template for a section type against the
 * manifest: forbidden content, size, syntax, unknown tokens, nested
 * loops, and every required hook (evaluated against the section's
 * content for conditional hooks). Returns { ok, problems, missing }
 * where `missing` lists the labels of absent REQUIRED hooks.
 */
function validateTemplate(type, template, content) {
  const problems = [];
  const missing = [];
  const entry = getEntry(type);
  if (!entry) {
    return {
      ok: false,
      missing,
      problems: [{ code: 'TEMPLATE_UNKNOWN_TYPE', message: `section type "${type}" has no template manifest entry.` }],
    };
  }
  if (!entry.templates) {
    return {
      ok: false,
      missing,
      problems: [{ code: 'TEMPLATE_NOT_AVAILABLE', message: templateDisabledReason(type) }],
    };
  }
  const src = String(template == null ? '' : template);
  if (!src.trim()) {
    return {
      ok: false,
      missing,
      problems: [
        {
          code: 'INVALID_TEMPLATE',
          message: 'template must be a non-empty HTML string or absent (omit it for the standard layout).',
        },
      ],
    };
  }
  if (src.length > MAX_TEMPLATE_CHARS) {
    problems.push({
      code: 'TEMPLATE_TOO_LONG',
      message: `template is ${src.length} characters — the limit is ${MAX_TEMPLATE_CHARS}.`,
    });
  }
  for (const f of FORBIDDEN) {
    if (f.re.test(src)) problems.push({ code: f.code, message: f.message });
  }
  let nodes = null;
  try {
    nodes = parseTemplate(src);
  } catch (e) {
    problems.push({ code: e.code || 'TEMPLATE_PARSE', message: e.message });
  }
  if (nodes) validateNodes(nodes, entry, null, problems);
  for (const h of entry.hooks || []) {
    if (!h.required) continue;
    if (!hookApplies(h, content)) continue;
    if (!checkHook(h, src)) {
      missing.push(h.label);
      problems.push({
        code: 'TEMPLATE_MISSING_HOOK',
        message: `template is missing a required hook: ${h.label}.`,
      });
    }
  }
  return { ok: problems.length === 0, problems, missing };
}

module.exports = {
  MANIFEST,
  MAX_TEMPLATE_CHARS,
  TemplateError,
  isRegisteredType,
  getEntry,
  isTemplateEnabled,
  templateDisabledReason,
  typesWithTemplates,
  templateOf,
  hasStoredTemplate,
  domHooksByType,
  manifestSummary,
  parseTemplate,
  renderTemplate,
  validateTemplate,
  checkHook,
  hookApplies,
  sectionMode,
};
