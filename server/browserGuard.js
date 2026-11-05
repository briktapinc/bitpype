'use strict';

/**
 * Batch 145 (external review F11) — SSRF guard for headless-browser
 * navigation.
 *
 * The screenshot / QA browsers launch Chromium with --no-sandbox
 * inside the app container, and at least one caller-supplied URL
 * (the screenshot API's previewUrl) reached page.goto with nothing
 * but an http(s) prefix check — any workspace role could drive the
 * browser at loopback / RFC-1918 / link-local targets and read back
 * a rendered screenshot as an oracle. The platform's fetch paths
 * already validate with server/urlSafety.assertPublicUrl; the
 * browser paths now use the same guard:
 *
 *   - assertBrowserUrl(url): validate a URL BEFORE page.goto.
 *   - guardBrowserPage(page): request interception that aborts any
 *     request (redirect hops and subresources included) whose host
 *     fails the same validation. Verdicts are cached per host for
 *     the life of the page.
 *
 * Local http previews stay available outside production (the
 * museRouter precedent) so dev/test captures of the app's own
 * 127.0.0.1 preview keep working; in production a loopback or
 * private target is refused outright.
 */

const { assertPublicUrl } = require('./urlSafety');

function isLocalHost(rawUrl) {
  try {
    const h = new URL(String(rawUrl || '')).hostname.toLowerCase();
    return h === 'localhost' || h === '127.0.0.1' || h === '::1';
  } catch {
    return false;
  }
}

async function assertBrowserUrl(rawUrl) {
  const prod = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
  return assertPublicUrl(rawUrl, { allowHttpLocal: !prod && isLocalHost(rawUrl) });
}

// Schemes a rendered page legitimately uses that are not network
// fetches at all (inline assets, the setContent document itself).
const NON_NETWORK_SCHEME = /^(?:data:|blob:|about:|chrome:|chrome-extension:)/i;

async function guardBrowserPage(page) {
  const verdicts = new Map(); // hostname -> Promise<boolean>
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    (async () => {
      try {
        const url = req.url();
        if (NON_NETWORK_SCHEME.test(url)) {
          await req.continue();
          return;
        }
        const host = new URL(url).hostname.toLowerCase();
        if (!verdicts.has(host)) {
          verdicts.set(
            host,
            assertBrowserUrl(url).then(
              () => true,
              () => false
            )
          );
        }
        if (await verdicts.get(host)) {
          await req.continue();
        } else {
          await req.abort('blockedbyclient');
        }
      } catch {
        try {
          await req.abort('blockedbyclient');
        } catch {
          /* request already settled */
        }
      }
    })();
  });
}

module.exports = { assertBrowserUrl, guardBrowserPage, isLocalHost };
