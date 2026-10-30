'use strict';
/**
 * Batch 75 — Facebook / earnings disclaimer for the public marketing
 * pages (Ely, 2026-10-30: "add this into the footer of marketing
 * materials"). The text below is Ely's verbatim copy — DO NOT edit,
 * rewrap, or "improve" it; it is pinned character-for-character by
 * tests/batch75-disclaimer-regressions.cjs. Non-ASCII characters are
 * written as \u escapes so the copy survives any file-encoding mishap:
 * \u2122 = ™, \u2019 = ’, \u201C/\u201D = “ ”.
 *
 * Single source: server.js injects disclaimerHtml() into exactly the
 * marketing page set at serve time —
 *   templated: home.html, how.html, how-it-works.html, onboarding.html
 *   dedicated senders: landing.html, thankyou.html, website-promo.html
 * The legal pages, /app, /portal and every transactional flow page are
 * deliberately NOT in the set and never receive the block. Neither does
 * /solo (public/solo.html): the playbook's own footer already carries
 * this exact text, so injecting would double it — it is served
 * verbatim by its own sender in server.js.
 */

const DISCLAIMER_PARAGRAPHS = [
  'This site is not a part of the Facebook\u2122 website or Facebook\u2122 Inc. Additionally, this site is NOT endorsed by Facebook\u2122 in any way. FACEBOOK\u2122 is a trademark of FACEBOOK\u2122, Inc.',
  'DISCLAIMER: The sales figures stated on this page and discussed in the training curriculum are our personal sales figures and in some cases the sales figures of previous or existing clients. Please understand these results are not typical. We\u2019re not implying you\u2019ll duplicate them (or do anything for that matter). The average person who buys \u201chow to\u201d information gets little to no results. We\u2019re using these references for example purposes only. Your results will vary and depend on many factors including but not limited to your background, experience, and work ethic. All business entails risk as well as massive and consistent effort and action. If you\u2019re not willing to accept that, please DO NOT PURCHASE from Bitpype.',
];

// Which templated pages (sendTemplatedPage rel paths) carry the block,
// and on which colour scheme. 'light' = dark muted text for the warm
// light pages; 'dark' = light muted text for /how, whose footer area
// sits on a near-black background. Any rel NOT listed here (notably
// legal/privacy.html and legal/terms.html) gets NO disclaimer.
const TEMPLATED_PAGE_SCHEMES = {
  'home.html': 'light',
  'how.html': 'dark',
  'how-it-works.html': 'light',
  'onboarding.html': 'light',
};

const SCHEMES = {
  light: { color: '#6f6357', border: 'rgba(28,20,15,.16)' },
  dark: { color: 'rgba(255,250,244,.62)', border: 'rgba(255,250,244,.20)' },
};

const MARKER = 'class="bp-earnings-disclaimer"';

function disclaimerHtml(scheme) {
  const s = SCHEMES[scheme] || SCHEMES.light;
  const paras = DISCLAIMER_PARAGRAPHS.map(
    (t, i) => `  <p style="margin:0${i < DISCLAIMER_PARAGRAPHS.length - 1 ? ' 0 8px' : ''}">${t}</p>`
  ).join('\n');
  return [
    `<div ${MARKER} style="max-width:1120px;margin:0 auto;padding:18px 28px 34px;border-top:1px solid ${s.border};color:${s.color};font-family:inherit;font-size:12.5px;line-height:1.55">`,
    paras,
    '</div>',
  ].join('\n');
}

/**
 * Insert the disclaimer as the last element before </body> (the
 * small-print band under the page footer). No-ops when the block is
 * already present or the scheme is unknown, so a page can never gain
 * the block twice.
 */
function injectDisclaimer(html, scheme) {
  if (!scheme || !SCHEMES[scheme]) return html;
  if (typeof html !== 'string' || html.includes(MARKER)) return html;
  const block = disclaimerHtml(scheme);
  const idx = html.lastIndexOf('</body>');
  if (idx === -1) return html + '\n' + block + '\n';
  return html.slice(0, idx) + block + '\n' + html.slice(idx);
}

module.exports = {
  DISCLAIMER_PARAGRAPHS,
  TEMPLATED_PAGE_SCHEMES,
  disclaimerHtml,
  injectDisclaimer,
};
