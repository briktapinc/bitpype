'use strict';
/**
 * Batch 60 — generated site-level legal pages (Terms + Privacy) for websites
 * built/exported by BitPype.
 *
 * Rules (from the brief, mirrored in the platform Terms §5/§6):
 *  - Content is built ONLY from the site's verified record (business name,
 *    phone, email, address, domain) — never invented facts. Missing fields
 *    simply omit their line; there are no placeholders.
 *  - MODULE-AWARE: a clause block appears only when that module/feature is
 *    actually attached to the site (site_module_embeds, published=1) or a
 *    matching form section exists in the site's pages.
 *  - OWNER PAGES WIN: if the site already has a page whose canonical slug is
 *    'terms' or 'privacy', the generated page is NOT added for that slug.
 *  - Pages are generated at EXPORT time inside writeStaticPages and are not
 *    written back into websites.pages. Owners customize by replacing them
 *    with their own pages in the normal page model (see report limitation).
 *  - Truthful cookies/analytics claims only: internal site analytics is
 *    aggregate-only (90-day retention) and appears only when enabled; Google
 *    Analytics is claimed only when the owner actually added tag IDs;
 *    AdSense is phrased conditionally because plan state is resolved later
 *    in the export pipeline.
 */

const TERMS_SLUG = 'terms';
const PRIVACY_SLUG = 'privacy';
const LINKS_MARKER = 'bitpype-legal-links';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function updatedLabel(now) {
  const d = now instanceof Date ? now : new Date();
  try {
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

/** Modules whose presence changes the site's legal pages. */
const MODULE_CLAUSES = ['calltracking', 'ecommerce', 'members', 'bookings', 'estimate',
  'chatbot', 'googlereviews', 'socialfeed', 'video', 'courses', 'newsletter'];

/**
 * Build the legal context for one site export.
 * seoCtx: the object from buildSeoExportContext (business, legalModules,
 * legalAnalytics, siteName). pages: the site's authored pages (form scan).
 */
function legalContextFromSeo(seoCtx, pages) {
  const seo = seoCtx && typeof seoCtx === 'object' ? seoCtx : {};
  const business = seo.business && typeof seo.business === 'object' ? seo.business : {};
  const attached = new Set(Array.isArray(seo.legalModules) ? seo.legalModules : []);
  let hasForms = attached.has('contact_form');
  if (!hasForms && Array.isArray(pages)) {
    for (const p of pages) {
      const sections = Array.isArray(p && p.sections) ? p.sections : [];
      if (sections.some((s) => s && (s.type === 'contact_form' || s.type === 'form'))) { hasForms = true; break; }
    }
  }
  const analytics = seo.legalAnalytics && typeof seo.legalAnalytics === 'object'
    ? seo.legalAnalytics : { internal: false, googleIds: [] };
  return {
    name: String(business.businessName || seo.siteName || '').trim(),
    category: String(business.category || '').trim(),
    phone: String(business.phone || '').trim(),
    email: String(business.email || '').trim(),
    address: String(business.address || '').trim(),
    city: String(business.city || '').trim(),
    state: String(business.state || '').trim(),
    postalCode: String(business.postalCode || '').trim(),
    baseUrl: String(seo.baseUrl || '').trim(),
    modules: attached,
    hasForms,
    analytics: { internal: !!analytics.internal, googleIds: Array.isArray(analytics.googleIds) ? analytics.googleIds : [] },
  };
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return ''; }
}

function contactLines(ctx, { forPrivacy = false } = {}) {
  const lines = [];
  const addr = [ctx.address, ctx.city, ctx.state, ctx.postalCode].filter(Boolean).join(', ');
  if (addr) lines.push(`<li>${esc(ctx.name || 'The business')}, ${esc(addr)}</li>`);
  if (ctx.email) lines.push(`<li>Email: <a href="mailto:${esc(ctx.email)}">${esc(ctx.email)}</a></li>`);
  if (ctx.phone) lines.push(`<li>Phone: <a href="tel:${esc(ctx.phone.replace(/[^+\d]/g, ''))}">${esc(ctx.phone)}</a></li>`);
  if (!lines.length) {
    lines.push(forPrivacy
      ? '<li>Use the contact details published on this website to reach the business.</li>'
      : '<li>Use the contact details published on this website.</li>');
  }
  return `<ul>${lines.join('')}</ul>`;
}

/* ---------------- Terms ---------------- */

function termsHtml(ctx, now) {
  const name = esc(ctx.name || 'This business');
  const host = hostOf(ctx.baseUrl);
  const m = ctx.modules;
  const parts = [];
  parts.push(`<h1>Terms of Service</h1>`);
  parts.push(`<p><em>Last updated: ${esc(updatedLabel(now))}</em></p>`);
  parts.push(`<p>These terms are an agreement between you and <strong>${name}</strong> ("the business") for the use of this website${host ? ` (${esc(host)})` : ''}. By using this website, you agree to these terms. If you do not agree, do not use the site.</p>`);

  parts.push(`<h2>About this website</h2>`);
  parts.push(`<p>The information on this site is provided by the business${ctx.category ? ` (a ${esc(ctx.category)} business)` : ''} for general information about its services. Content, prices, and offers on this site may change without notice, and the business may correct errors. Information on this site is not professional advice for your specific situation.</p>`);
  parts.push(`<p>Some content on this site may have been drafted with the help of AI tools and reviewed by the business. The business is responsible for what it publishes here.</p>`);

  if (ctx.hasForms) {
    parts.push(`<h2>Forms and messages you send us</h2>`);
    parts.push(`<p>When you send a form on this site (for example a contact form), your <strong>form submissions are delivered to the business</strong> so it can read and respond to your message. Submitting a form does not create a contract, an appointment, or an obligation for the business to provide services. Please do not send sensitive personal information (such as financial account numbers or medical details) through website forms.</p>`);
  }
  if (m.has('estimate')) {
    parts.push(`<h2>Estimate requests</h2>`);
    parts.push(`<p>An estimate request is a request for a quote: <strong>submitting an estimate request does not create a contract</strong> and is not a price promise. Any price the business later quotes is governed by the quote or contract the business issues, not by this website.</p>`);
  }
  if (m.has('bookings')) {
    parts.push(`<h2>Bookings and appointments</h2>`);
    parts.push(`<p><strong>A booking request is not a confirmed appointment</strong> unless the business confirms it. When you request a booking through this site, the request is recorded as pending; the business may confirm, reschedule, or decline it. If this site's settings confirm bookings automatically, your booking is confirmed when the site says so. You are responsible for giving accurate contact details so the business can reach you about your booking.</p>`);
  }
  if (m.has('calltracking')) {
    parts.push(`<h2>Phone calls to this business</h2>`);
    parts.push(`<p><strong>Calls to the phone number shown on this site may be recorded and transcribed</strong> for quality, training, and follow-up. Calls are routed to the business through a call-tracking number. By calling the number shown on this site, you understand that the call may be recorded as described here and in the Privacy Policy. If you do not want to be recorded, contact the business another way (for example, by form or email where offered).</p>`);
  }
  if (m.has('ecommerce')) {
    parts.push(`<h2>Online shop</h2>`);
    parts.push(`<p>This shop is operated by ${name}. <strong>Your contract of sale is with the business, not with the website platform</strong> that hosts this site. Prices are shown at checkout; the business may correct pricing errors and may cancel an order affected by an error. Card payments are processed by Stripe through the business's own Stripe account — the business never receives your full card number.</p>`);
    parts.push(`<p><strong>Refunds and returns are handled under the business's own policy.</strong> Contact the business using the details below with any question about an order, a refund, or a return.</p>`);
  }
  if (m.has('members')) {
    parts.push(`<h2>Memberships and member accounts</h2>`);
    parts.push(`<p>Some pages and content on this site are available only to members. Membership is offered by the business on the terms shown at sign-up; <strong>membership payments are processed by the business's own Stripe account</strong>, and the business — not the website platform — is responsible for membership billing, access, and refunds under its own policy. Keep your account password private; you are responsible for activity under your account. The business may suspend a member account that misuses the site or violates these terms.</p>`);
  }
  if (m.has('courses')) {
    parts.push(`<h2>Courses</h2>`);
    parts.push(`<p><strong>Courses and lessons on this site are provided by the business.</strong> Enrollment, access periods, and any refunds follow the terms shown by the business at enrollment.</p>`);
  }
  if (m.has('chatbot')) {
    parts.push(`<h2>Chat on this site</h2>`);
    parts.push(`<p>This site offers a chat feature. <strong>Some replies in the chat may be generated by AI</strong> on the business's behalf; AI replies can be wrong, so confirm important details (prices, times, availability) with the business directly. Do not share sensitive personal information in chat. The business may read chat transcripts to follow up with you.</p>`);
  }
  if (m.has('googlereviews')) {
    parts.push(`<h2>Reviews</h2>`);
    parts.push(`<p><strong>Reviews shown on this site are from Google</strong> and were written by Google users about this business. They are those users' opinions, not the business's statements, and they are subject to Google's own terms and policies.</p>`);
  }
  if (m.has('socialfeed')) {
    parts.push(`<h2>Social media content</h2>`);
    parts.push(`<p>Posts shown on this site come from the business's connected social media accounts and remain subject to the terms of those platforms.</p>`);
  }
  if (m.has('newsletter')) {
    parts.push(`<h2>Newsletter</h2>`);
    parts.push(`<p>If you subscribe to this site's newsletter, the business collects your <strong>email address</strong> (and your name, if you give it) to send you its newsletter issues. Every issue carries an unsubscribe link, and unsubscribing stops future issues — the business keeps a record of the unsubscription so the address is not added back by accident. Subscribing does not create a contract or an obligation for the business to provide services.</p>`);
  }
  if (m.has('video')) {
    parts.push(`<h2>Videos</h2>`);
    parts.push(`<p>Videos on this site are embedded from YouTube or Vimeo. When you play a video, that provider's terms and privacy policy apply to the playback.</p>`);
  }

  parts.push(`<h2>Acceptable use</h2>`);
  parts.push(`<p>Do not misuse this site: no attempting to break its security, no automated scraping that burdens the site, no submitting false or unlawful content through its forms or chat, and no using the site to violate anyone's rights.</p>`);
  parts.push(`<h2>Intellectual property</h2>`);
  parts.push(`<p>The content on this site belongs to the business or its licensors. You may view it for your own use; do not copy or reuse it commercially without permission.</p>`);
  parts.push(`<h2>Liability</h2>`);
  parts.push(`<p>This site is provided "as is." To the extent the law allows, the business is not liable for indirect or consequential damages arising from your use of this website itself. Nothing in these terms limits the business's liability for its actual services to you, which are governed by your agreement with the business.</p>`);
  if (ctx.state) {
    parts.push(`<h2>Governing law</h2>`);
    parts.push(`<p>These terms are governed by the laws of the State of ${esc(ctx.state)}, where the business is located.</p>`);
  }
  parts.push(`<h2>Changes</h2>`);
  parts.push(`<p>The business may update these terms by posting a new version on this page with a new "last updated" date.</p>`);
  parts.push(`<h2>Contact</h2>`);
  parts.push(contactLines(ctx));
  return `<article class="bp-legal">${parts.join('\n')}</article>`;
}

/* ---------------- Privacy ---------------- */

function privacyHtml(ctx, now) {
  const name = esc(ctx.name || 'This business');
  const m = ctx.modules;
  const parts = [];
  parts.push(`<h1>Privacy Policy</h1>`);
  parts.push(`<p><em>Last updated: ${esc(updatedLabel(now))}</em></p>`);
  parts.push(`<p>This policy explains what information <strong>${name}</strong> ("the business") collects through this website, how it is used, and who it is shared with. The business is responsible for this data (the data controller). Its website is hosted and operated with the help of a website platform provider (BitPype), which processes website data on the business's behalf.</p>`);

  const collects = [];
  if (ctx.hasForms) collects.push(`<strong>Forms:</strong> when you send a form, <strong>what you send is stored in the business's contact system</strong> so the business can respond and follow up. The business is also emailed about each submission.`);
  if (m.has('bookings')) collects.push(`<strong>Bookings:</strong> your name, contact details, the service you choose, and the time you request, so the business can manage the appointment.`);
  if (m.has('estimate')) collects.push(`<strong>Estimate requests:</strong> the details you provide about the work you want priced.`);
  if (m.has('calltracking')) collects.push(`<strong>Phone calls:</strong> if you call the number shown on this site, the business receives your caller number and the call's time and duration. <strong>Calls are recorded using our phone service provider (Twilio)</strong>, and recordings may be transcribed automatically so the business can follow up. If you reach voicemail, your message is recorded and sent to the business.`);
  if (m.has('chatbot')) collects.push(`<strong>Chat:</strong> <strong>chat messages are stored so the business can read and follow up</strong>. Some replies may be generated by AI on the business's behalf.`);
  if (m.has('members')) collects.push(`<strong>Member accounts:</strong> if you create a member account, your name, email address, and a hashed password are stored so you can sign in, together with your membership status.`);
  if (m.has('ecommerce')) collects.push(`<strong>Orders:</strong> if you buy through this site's shop, the business receives your order details. <strong>Card payments are processed by Stripe</strong> through the business's own Stripe account — your full card number goes to Stripe, not to the business or this website.`);
  if (m.has('newsletter')) collects.push(`<strong>Newsletter:</strong> if you subscribe, your email address (and your name, if you give it) is stored so the business can send you its newsletter. Every issue includes an unsubscribe link; unsubscribing stops future issues and the unsubscription is recorded so the address is not re-added by accident.`);
  if (collects.length) {
    parts.push(`<h2>What this site collects</h2><ul>${collects.map((c) => `<li>${c}</li>`).join('')}</ul>`);
  } else {
    parts.push(`<h2>What this site collects</h2><p>This site is informational. It does not run forms, bookings, accounts, or a shop, and it does not collect personal information through the site itself. If you contact the business by phone or email outside this site, the business handles that information under its own practices.</p>`);
  }

  parts.push(`<h2>How the information is used</h2>`);
  parts.push(`<p>The business uses information collected through this site to respond to messages, manage bookings and estimates, provide memberships and orders, return calls, and run and improve its business. The business does not sell your personal information.</p>`);

  if (ctx.analytics.internal || ctx.analytics.googleIds.length) {
    const bits = [];
    if (ctx.analytics.internal) bits.push(`This site counts page views in aggregate — daily totals by page — to understand which pages are useful. These counts do not identify individual visitors and are kept for 90 days.`);
    if (ctx.analytics.googleIds.length) bits.push(`This site also uses Google Analytics under the business's own Google account; Google may set cookies and collect usage data under Google's privacy policy.`);
    parts.push(`<h2>Site analytics</h2><p>${bits.join(' ')}</p>`);
  }

  if (m.has('googlereviews')) {
    parts.push(`<h2>Reviews from Google</h2>`);
    parts.push(`<p>Reviews displayed on this site are fetched from Google and shown with the reviewer's name as Google provides it. That display is controlled by Google's systems, not collected by this site.</p>`);
  }

  // Cookies — claims limited to what this site actually does.
  const cookies = [`This site itself does not set tracking cookies. Your cookie-notice choice is stored in your browser's local storage, not a cookie.`];
  if (m.has('members')) cookies.push(`If you sign in as a member, a session cookie keeps you signed in.`);
  if (ctx.analytics.googleIds.length) cookies.push(`Google Analytics (above) may set cookies.`);
  if (m.has('video')) cookies.push(`When you play an embedded video, YouTube or Vimeo may set cookies under their own policies.`);
  cookies.push(`If advertising is shown on this site, the advertising provider (Google) may set cookies to serve and measure ads.`);
  parts.push(`<h2>Cookies</h2><p>${cookies.join(' ')}</p>`);

  parts.push(`<h2>Who receives the information</h2>`);
  const receivers = [`the business that runs this site`];
  if (ctx.hasForms || m.has('bookings') || m.has('estimate') || m.has('chatbot') || m.has('members') || m.has('newsletter')) receivers.push(`the website platform provider (BitPype), which stores submissions and account data on the business's behalf`);
  if (m.has('calltracking')) receivers.push(`Twilio, which carries, records, and transcribes calls and voicemail`);
  if (m.has('ecommerce') || m.has('members')) receivers.push(`Stripe, which processes payments for the business`);
  if (m.has('chatbot')) receivers.push(`an AI provider, which generates chat replies from the business's information`);
  if (m.has('googlereviews')) receivers.push(`Google, which provides the reviews shown on this site`);
  parts.push(`<p>Information collected through this site goes to: ${receivers.join('; ')}. It is shared otherwise only when the law requires it.</p>`);

  parts.push(`<h2>Keeping and deleting information</h2>`);
  parts.push(`<p>The business keeps submissions, bookings, call records, and account information for as long as it needs them to run its business and meet its legal obligations. To ask what the business holds about you, or to ask for correction or deletion, contact the business:</p>`);
  parts.push(contactLines(ctx, { forPrivacy: true }));
  parts.push(`<h2>Children</h2><p>This site is not directed to children under 13.</p>`);
  parts.push(`<h2>Changes</h2><p>The business may update this policy by posting a new version on this page with a new "last updated" date.</p>`);
  return `<article class="bp-legal">${parts.join('\n')}</article>`;
}

/* ---------------- Page assembly ---------------- */

function legalPageObject(slug, ctx, now) {
  const isTerms = slug === TERMS_SLUG;
  return {
    slug,
    title: isTerms ? 'Terms of Service' : 'Privacy Policy',
    description: isTerms
      ? `The terms for using the ${(ctx.name || 'business')} website.`
      : `How ${(ctx.name || 'this business')} handles information collected through its website.`,
    navVisible: false,
    sections: [{ type: 'html', content: { html: isTerms ? termsHtml(ctx, now) : privacyHtml(ctx, now) } }],
  };
}

/**
 * Return a NEW pages array with generated terms/privacy pages appended for
 * any of those canonical slugs the site does not already have. Authored
 * page objects are passed through untouched (identity preserved).
 * helpers.canon: canonicalSlugPath-compatible function.
 */
function withLegalPages(pages, ctx, helpers) {
  const canon = helpers && typeof helpers.canon === 'function' ? helpers.canon : (s) => String(s || '').trim().toLowerCase().replace(/\.html?$/i, '').replace(/^\//, '');
  const list = Array.isArray(pages) ? pages : [];
  const have = new Set(list.map((p) => canon(p && p.slug)));
  const out = list.slice();
  const now = new Date();
  if (!have.has(TERMS_SLUG)) out.push(legalPageObject(TERMS_SLUG, ctx, now));
  if (!have.has(PRIVACY_SLUG)) out.push(legalPageObject(PRIVACY_SLUG, ctx, now));
  return out;
}

/**
 * Inject footer legal links into an exported page's HTML (idempotent).
 * helpers.urlFor: pageUrlPath-compatible function.
 */
function injectLegalLinks(html, helpers) {
  const urlFor = helpers && typeof helpers.urlFor === 'function' ? helpers.urlFor : (s) => `/${s}`;
  let out = String(html || '');
  if (out.includes(LINKS_MARKER)) return out;
  if (/href=["']\/?terms(\.html)?["'#?]/i.test(out) && /href=["']\/?privacy(\.html)?["'#?]/i.test(out)) return out;
  const nav = `<nav class="bp-legal-links" aria-label="Legal"><!-- ${LINKS_MARKER} --><a href="${urlFor(TERMS_SLUG)}">Terms</a> · <a href="${urlFor(PRIVACY_SLUG)}">Privacy</a></nav>`;
  if (/<\/footer>/i.test(out)) return out.replace(/<\/footer>/i, `${nav}</footer>`);
  if (/<\/body>/i.test(out)) {
    const bar = `<footer class="bp-legal-footer" style="padding:20px 28px;text-align:center;font-size:.9rem"><!-- ${LINKS_MARKER} --><a href="${urlFor(TERMS_SLUG)}">Terms</a> · <a href="${urlFor(PRIVACY_SLUG)}">Privacy</a></footer>`;
    return out.replace(/<\/body>/i, `${bar}</body>`);
  }
  return out + nav;
}

module.exports = {
  TERMS_SLUG,
  PRIVACY_SLUG,
  LINKS_MARKER,
  legalContextFromSeo,
  termsHtml,
  privacyHtml,
  legalPageObject,
  withLegalPages,
  injectLegalLinks,
};
