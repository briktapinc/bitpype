'use strict';

/**
 * Batch 99 (four-role chat rebuild, step 2) — the CRITIC.
 *
 * The critic never trusts the implementor's say-so. It inspects
 * the ACTUAL rendered site — computed styles via
 * server/siteStyleCascade.js and rendered text — against the
 * plan's verify[] checks (server/siteChatPlan.js), and it diffs a
 * site fingerprint captured before the work against the site
 * after, so anything that changed outside the plan's scope is
 * caught mechanically:
 *
 *   - a page changed whose slug is outside the plan's scope
 *     (when the scope names specific pages);
 *   - the theme's non-CSS fields changed with no theme.set step;
 *   - the customCss changed with no style-rule / theme step;
 *   - pages changed with no step that can change pages.
 *
 * A mutation the loop claims but the fingerprint cannot see ("no
 * effective change") is a critic failure too — that is the
 * mechanical form of finding C3 (success claimed while the
 * managed block shadowed the real element).
 *
 * Pure + injectable: the caller supplies renderPageHtml(slug) so
 * the in-chat path (clientPortal render) and the queued path
 * (websiteEngine render in deliverJob) share one critic.
 */

const crypto = require('node:crypto');
const cascade = require('./siteStyleCascade');

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

function parseJsonField(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

const THEME_TOKEN_KEYS = ['primary', 'secondary', 'accent', 'paper', 'bg', 'ink', 'text', 'headingFont', 'font'];

/**
 * Normalize a theme token for comparison. The platform's save
 * path canonicalizes themes on EVERY write (measured live,
 * Batch 99 proof diag 2026-10-31): font stacks gain fallbacks
 * ("Fraunces" -> "\"Fraunces\", serif") and default fields
 * materialize out of thin air (secondary, bg, logoMode, ...).
 * None of that is agent work, so tokens compare by their
 * normalized design value: fonts by first family, colours by
 * normalized hex, empties as null.
 */
function normTokenValue(key, value) {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  if (!text) return null;
  if (/font/i.test(key)) return text.split(',')[0].replace(/["']/g, '').trim().toLowerCase() || null;
  return cascade.normColor(text) || text.toLowerCase();
}

function themeTokens(theme) {
  const out = {};
  for (const key of THEME_TOKEN_KEYS) {
    out[key] = normTokenValue(key, theme && typeof theme === 'object' ? theme[key] : null);
  }
  return out;
}

/**
 * Fingerprint of one lead's site: per-page hashes (page-level
 * bookkeeping keys — updatedAt/createdAt stamps the save path
 * adds on every write — stripped before hashing), theme tokens
 * for the collateral comparison, and a customCss hash. The
 * fingerprint carries a format version: baselines stamped by
 * an older format are not diffed (the Batch 99 reviewer treats
 * a version mismatch as "no baseline" — verify[] still gates).
 */
function siteFingerprint(db, leadId) {
  const row = db.prepare('SELECT id, pages, theme FROM websites WHERE lead_id = ?').get(leadId);
  if (!row) return null;
  const pages = parseJsonField(row.pages, []);
  const theme = parseJsonField(row.theme, {});
  const pagesHash = {};
  const slugs = [];
  if (Array.isArray(pages)) {
    for (const page of pages) {
      const slug = String((page && page.slug) || '');
      if (!slug) continue;
      slugs.push(slug);
      const projection = page && typeof page === 'object' ? { ...page } : page;
      if (projection && typeof projection === 'object') {
        delete projection.updatedAt;
        delete projection.createdAt;
      }
      pagesHash[slug] = sha256(canonicalJson(projection));
    }
  }
  const themeCore = theme && typeof theme === 'object' ? { ...theme } : {};
  const customCss = typeof themeCore.customCss === 'string' ? themeCore.customCss : '';
  delete themeCore.customCss;
  return {
    v: 2,
    siteId: Number(row.id) || null,
    slugs,
    pagesHash,
    themeTokens: themeTokens(theme),
    themeCoreHash: sha256(canonicalJson(themeCore)),
    customCssHash: sha256(customCss),
  };
}

const PAGE_CHANGING_TOOLS = new Set([
  'site.editText', 'site.editListItem', 'site.canvasBlock',
  'pages.structure.update', 'modules.attach', 'modules.detach',
  'modules.uploadImage', 'website.addModule', 'site.replaceImage',
  'site.generateImage', 'site.setLogo',
]);
const CONTENT_TOOL_PREFIXES = [
  'blog.', 'faq.', 'gallery.', 'menu.', 'team.', 'testimonials.',
  'events.', 'careers.', 'courses.', 'video.', 'directory.',
  'offers.', 'charts.', 'datatables.', 'forms.', 'bookings.',
  'estimate.', 'members.', 'ecommerce.', 'googlereviews.', 'socialfeed.',
];

function stepChangesPages(step) {
  const tool = String((step && step.tool) || '');
  if (PAGE_CHANGING_TOOLS.has(tool)) return true;
  return CONTENT_TOOL_PREFIXES.some((p) => tool.startsWith(p));
}

function planSurfaces(plan) {
  const steps = Array.isArray(plan && plan.steps) ? plan.steps : [];
  return {
    themeCore: steps.some((s) => s.tool === 'theme.set'),
    customCss: steps.some((s) => s.tool === 'theme.styleRule' || s.tool === 'theme.set'),
    pages: steps.some(stepChangesPages),
  };
}

function scopedSlugs(plan) {
  const pages = plan && plan.scope && Array.isArray(plan.scope.pages) ? plan.scope.pages : [];
  if (!pages.length || pages.includes('all')) return null; // null = whole site in scope
  return new Set(pages.map((s) => String(s)));
}

/**
 * Diff two fingerprints against the plan. Returns
 * { changed, changedPages, addedPages, removedPages,
 *   themeCoreChanged, customCssChanged, violations[] }.
 */
function diffFingerprints(before, after, plan) {
  const out = {
    changed: false,
    changedPages: [],
    addedPages: [],
    removedPages: [],
    themeCoreChanged: false,
    customCssChanged: false,
    violations: [],
  };
  if (!before || !after) return out;
  if (before.v !== after.v) {
    // Fingerprint format changed between the baseline and now
    // (e.g. a job queued before the Batch 99 calibration
    // shipped): hashes are incomparable, so collateral is
    // report-only — the verify[] checks still gate.
    out.changed = true;
    out.versionMismatch = true;
    return out;
  }
  const scope = scopedSlugs(plan);
  const surfaces = planSurfaces(plan || {});
  const beforeSlugs = new Set(before.slugs || []);
  const afterSlugs = new Set(after.slugs || []);
  for (const slug of afterSlugs) {
    if (!beforeSlugs.has(slug)) out.addedPages.push(slug);
    else if (before.pagesHash[slug] !== after.pagesHash[slug]) out.changedPages.push(slug);
  }
  for (const slug of beforeSlugs) {
    if (!afterSlugs.has(slug)) out.removedPages.push(slug);
  }
  out.themeCoreChanged = before.themeCoreHash !== after.themeCoreHash;
  out.customCssChanged = before.customCssHash !== after.customCssHash;
  // Theme TOKEN drift: an EXISTING design token whose value
  // actually changed (defaults materializing out of thin air
  // and font-fallback canonicalization are platform save-path
  // behaviour, not agent work — see normTokenValue).
  const tokenChanges = [];
  const beforeTokens = before.themeTokens || {};
  const afterTokens = after.themeTokens || {};
  for (const key of Object.keys(afterTokens)) {
    const b = beforeTokens[key];
    const a = afterTokens[key];
    if (b != null && a != null && b !== a) tokenChanges.push(`${key}: ${b} -> ${a}`);
  }
  out.tokenChanges = tokenChanges;
  out.changed =
    out.changedPages.length > 0 || out.addedPages.length > 0 || out.removedPages.length > 0 ||
    tokenChanges.length > 0 || out.customCssChanged;

  if (scope) {
    for (const slug of [...out.changedPages, ...out.addedPages, ...out.removedPages]) {
      if (!scope.has(slug)) out.violations.push(`page "${slug}" changed but is outside the plan's scope`);
    }
  }
  if (tokenChanges.length && !surfaces.themeCore) {
    out.violations.push(`theme token(s) changed (${tokenChanges.join('; ')}) but the plan has no theme.set step`);
  }
  if (out.customCssChanged && !surfaces.customCss) {
    out.violations.push('custom CSS changed but the plan has no style-rule step');
  }
  if ((out.changedPages.length || out.addedPages.length || out.removedPages.length) && !surfaces.pages) {
    out.violations.push('pages changed but no plan step can change pages');
  }
  return out;
}

function visibleText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function checkEquals(actual, expected, property) {
  if (property && /color|background/i.test(property)) {
    const a = cascade.normColor(actual);
    const e = cascade.normColor(expected);
    if (a && e) return a === e;
  }
  return String(actual == null ? '' : actual).trim().toLowerCase() === String(expected == null ? '' : expected).trim().toLowerCase();
}

/**
 * Run the critic.
 *   opts: { plan, before, after, renderPageHtml(slug)->html,
 *           expectChange } — expectChange true asserts the
 *           fingerprint actually moved (mutation sanity).
 * Returns { verdict: 'pass'|'fail', checks: [...], collateral,
 *           failures: [plain-language strings] }.
 */
function runCritic(opts) {
  const plan = (opts && opts.plan) || {};
  const renderPageHtml = opts && typeof opts.renderPageHtml === 'function' ? opts.renderPageHtml : () => '';
  const checks = [];
  const renderCache = new Map();
  const render = (slug) => {
    if (!renderCache.has(slug)) {
      try {
        renderCache.set(slug, String(renderPageHtml(slug) || ''));
      } catch {
        renderCache.set(slug, '');
      }
    }
    return renderCache.get(slug);
  };
  const scope = scopedSlugs(plan);
  const slugsToRender = () => {
    const all = (opts.after && opts.after.slugs) || [];
    if (!scope) return all;
    return all.filter((s) => scope.has(s));
  };

  const verify = Array.isArray(plan.verify) ? plan.verify : [];
  for (const check of verify) {
    if (!check || typeof check !== 'object') continue;
    if (check.kind === 'computedStyle') {
      const where = check.where || 'all';
      const found = [];
      for (const slug of slugsToRender()) {
        for (const v of cascade.computedStyleValues(render(slug), check.selector, check.property)) {
          if (where === 'all' || v.context === where) found.push(v);
        }
      }
      let pass = found.length > 0;
      for (const v of found) {
        if (!checkEquals(v.value, check.equals, check.property)) pass = false;
      }
      const actual = found.length
        ? [...new Set(found.map((v) => `${v.value} (${v.context})`))].join(', ')
        : `no ${check.selector} elements found`;
      checks.push({ check, kind: 'computedStyle', pass, actual });
    } else if (check.kind === 'presence') {
      const needle = String(check.text || '').toLowerCase();
      let hit = null;
      for (const slug of slugsToRender()) {
        if (needle && visibleText(render(slug)).includes(needle)) {
          hit = slug;
          break;
        }
      }
      checks.push({ check, kind: 'presence', pass: !!hit, actual: hit ? `found on page "${hit}"` : `"${check.text}" not found on any in-scope page` });
    } else if (check.kind === 'noCollateral') {
      // Evaluated after the diff below; placeholder replaced there.
      checks.push({ check, kind: 'noCollateral', pass: true, actual: 'evaluated from the fingerprint diff' });
    }
  }

  const collateral = diffFingerprints(opts.before, opts.after, plan);
  for (const c of checks) {
    if (c.kind === 'noCollateral') {
      c.pass = collateral.violations.length === 0;
      c.actual = collateral.violations.length
        ? collateral.violations.join('; ')
        : collateral.changed
          ? 'changes confined to the plan scope'
          : 'nothing changed';
    }
  }
  if (opts.expectChange && !collateral.changed) {
    checks.push({
      check: { kind: 'effectiveChange' },
      kind: 'effectiveChange',
      pass: false,
      actual: 'the site is byte-identical to before the turn — nothing actually changed',
    });
  }

  const failures = [];
  for (const c of checks) {
    if (c.pass) continue;
    if (c.kind === 'computedStyle') {
      failures.push(`${c.check.selector} ${c.check.property} should be ${c.check.equals} — rendered: ${c.actual}`);
    } else if (c.kind === 'presence') {
      failures.push(c.actual);
    } else if (c.kind === 'noCollateral') {
      failures.push(`collateral: ${c.actual}`);
    } else {
      failures.push(c.actual);
    }
  }
  const verdict = failures.length === 0 ? 'pass' : 'fail';
  return { verdict, checks, collateral, failures };
}

module.exports = {
  canonicalJson,
  sha256,
  siteFingerprint,
  diffFingerprints,
  runCritic,
  planSurfaces,
  stepChangesPages,
  visibleText,
};
