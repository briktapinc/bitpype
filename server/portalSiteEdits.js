'use strict';

/**
 * Batch 111 (consolidation step 4) — portal site editing: render, theme colours, style rules, text/list edits, page HTML saves, image/logo uploads + generation, preview publish.
 * PURE code motion from server/clientPortal.js (no logic edits);
 * server/clientPortal.js re-exports the full original surface.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { resolvePreviewUrl, resolveExportPreviewBase, isPortalLockedPath, setContentPath, pagesSupportInlineEdit, pagesHaveFreeformHtml, parseJsonSafe, resolveClientSite } = require('./portalShared');

function renderClientSite(workspaceId, leadId, opts = {}) {
  const domain = require('./domain');
  const leadOk = domain.withDb(workspaceId, (db) => {
    const lead = db.prepare('SELECT id FROM leads WHERE id = ? LIMIT 1').get(Number(leadId));
    if (!lead) {
      throw Object.assign(new Error('Linked business not found'), { code: 'NOT_FOUND' });
    }
    const site = resolveClientSite(db, leadId);
    if (!site || !Array.isArray(site.pages) || !site.pages.length) {
      throw Object.assign(new Error('No website is available to edit yet'), { code: 'NO_SITE' });
    }
    return site;
  });
  const editableWanted = opts.editable !== false;
  const canInlineEdit = editableWanted && pagesSupportInlineEdit(leadOk.pages);
  const rendered = domain.sitesRenderHtml(workspaceId, leadOk.id, {
    editable: canInlineEdit,
    pageSlug: opts.pageSlug,
    pageIndex: opts.pageIndex,
  });
  const previewUrl = resolvePreviewUrl(leadOk);
  const assetBase = resolveExportPreviewBase(workspaceId, leadOk);
  const engine = require('../src/websiteEngine');
  // srcdoc has no document URL — relative images/… need a preview base.
  let html = canInlineEdit && assetBase ? engine.injectPreviewBaseHref(rendered.html, assetBase) : rendered.html;
  // Membership preview bypass (Batch 16): the owner previews their own site
  // through this portal path, never the public gate. When gating is active,
  // mint a short-lived preview grant and hand it to module-embed.js, which
  // presents it on module API calls so gated content renders for the owner.
  // The published/exported site is unaffected — visitors still hit the wall.
  try {
    const modules = require('./siteModules');
    const grant = domain.withDb(workspaceId, (db) => modules.memberPreviewGrantFor(db, Number(leadId)));
    if (grant) {
      const tag = `<script>window.__BP_MEMBER_PREVIEW_GRANT__=${JSON.stringify(grant)};</script>`;
      html = /<\/head>/i.test(html) ? html.replace(/<\/head>/i, `${tag}</head>`) : tag + html;
    }
  } catch {
    /* preview grant is best-effort; the preview itself must never break */
  }
  const theme = leadOk.theme && typeof leadOk.theme === 'object' ? leadOk.theme : {};
  const normalized = engine.normalizeTheme(theme);
  const themePalette = require('../src/themePalette');
  const { palette } = themePalette.extractPalette(leadOk.pages, normalized);
  const logoMode = String(theme.logoMode || 'text').toLowerCase() === 'image' && theme.logoUrl ? 'image' : 'text';
  const logoUrl = theme.logoUrl ? String(theme.logoUrl) : '';
  const logoPublicUrl =
    logoUrl && assetBase
      ? `${String(assetBase).replace(/\/+$/, '')}/${logoUrl.replace(/^\.?\//, '')}`
      : logoUrl && previewUrl
        ? `${String(previewUrl).replace(/\/+$/, '')}/${logoUrl.replace(/^\.?\//, '')}`
        : null;
  return {
    siteId: leadOk.id,
    name: leadOk.name,
    editable: canInlineEdit,
    freeform: pagesHaveFreeformHtml(leadOk.pages),
    previewUrl,
    assetBase,
    html,
    pages: rendered.pages,
    theme: {
      primary: normalized.primary,
      secondary: normalized.secondary,
      bg: normalized.bg,
      text: normalized.text,
      font: normalized.font,
      headingFont: normalized.headingFont || '',
      palette,
    },
    logo: {
      mode: logoMode,
      url: logoUrl || null,
      publicUrl: logoPublicUrl,
      brandName: theme.brandName || null,
    },
  };
}

const THEME_COLOR_KEYS = ['primary', 'secondary', 'bg', 'text'];

function normalizePortalHex(value) {
  let s = String(value == null ? '' : value).trim();
  if (!s) return null;
  if (s[0] !== '#') s = `#${s}`;
  if (/^#[0-9a-fA-F]{3}$/.test(s)) {
    s = `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  }
  if (!/^#[0-9a-fA-F]{6}$/.test(s)) return null;
  return s.toLowerCase();
}

function rewriteThemeHexInCss(css, oldTheme, newTheme) {
  const themePalette = require('../src/themePalette');
  const map = themePalette.buildReplacementMap(oldTheme, newTheme, []);
  return themePalette.rewriteHexMap(css, map);
}

/**
 * Update website theme colors from the client portal.
 * Merges primary/secondary/bg/text, rewrites matching hexes in customCss + page HTML,
 * optional replacements:[{from,to}] for extra palette colors, saves a new version.
 */
async function applyClientThemeColors(workspaceId, leadId, colors = {}) {
  const domain = require('./domain');
  const engine = require('../src/websiteEngine');
  const themePalette = require('../src/themePalette');
  const googleFonts = require('../public/js/fonts.js');
  const patch = {};
  for (const key of THEME_COLOR_KEYS) {
    if (colors[key] == null || colors[key] === '') continue;
    const hex = normalizePortalHex(colors[key]);
    if (!hex) {
      throw Object.assign(new Error(`Invalid ${key} color (use #RRGGBB)`), { code: 'INVALID_COLOR' });
    }
    patch[key] = hex;
  }
  if (colors.font != null && String(colors.font).trim()) {
    patch.font = googleFonts.safeStack(colors.font);
  }
  if (colors.headingFont != null) {
    const heading = String(colors.headingFont).trim();
    patch.headingFont = heading ? googleFonts.safeStack(heading) : '';
  }
  let elementPatch = null;
  if (colors.elementFonts && typeof colors.elementFonts === 'object' && !Array.isArray(colors.elementFonts)) {
    elementPatch = colors.elementFonts;
  }
  const replacements = Array.isArray(colors.replacements) ? colors.replacements : [];
  if (!Object.keys(patch).length && !elementPatch && !replacements.length) {
    throw Object.assign(new Error('Provide at least one theme color, palette replacement, or font'), { code: 'EMPTY' });
  }

  const prepared = domain.withDb(workspaceId, (db) => {
    const lead = db.prepare('SELECT id FROM leads WHERE id = ? LIMIT 1').get(Number(leadId));
    if (!lead) {
      throw Object.assign(new Error('Linked business not found'), { code: 'NOT_FOUND' });
    }
    const site = resolveClientSite(db, leadId);
    if (!site || !Array.isArray(site.pages) || !site.pages.length) {
      throw Object.assign(new Error('No website is available to edit yet'), { code: 'NO_SITE' });
    }
    const oldTheme = site.theme && typeof site.theme === 'object' ? site.theme : {};
    const oldNorm = engine.normalizeTheme(oldTheme);
    const map = themePalette.buildReplacementMap(oldNorm, patch, replacements);
    let theme = Object.assign({}, oldTheme, patch);
    if (elementPatch) {
      const prev = Object.assign({}, oldTheme.elementFonts || {});
      for (const [id, val] of Object.entries(elementPatch)) {
        if (!/^[\w:.-]{1,80}$/.test(id)) continue;
        if (val == null || val === '' || val === 'system') delete prev[id];
        else {
          const name = googleFonts.matchName(val);
          if (name) prev[id] = name;
        }
      }
      theme.elementFonts = prev;
    }
    if (typeof theme.customCss === 'string' && theme.customCss && Object.keys(map).length) {
      theme.customCss = themePalette.rewriteHexMap(theme.customCss, map);
    }
    let pages = site.pages;
    if (Object.keys(map).length) {
      const applied = themePalette.applyHexMapToPages(pages, map);
      pages = applied.pages;
    }
    const normalized = engine.normalizeTheme(theme);
    const { palette } = themePalette.extractPalette(pages, normalized);
    return {
      siteId: site.id,
      pages,
      theme,
      colors: {
        primary: normalized.primary,
        secondary: normalized.secondary,
        bg: normalized.bg,
        text: normalized.text,
        font: normalized.font,
        headingFont: normalized.headingFont || '',
        palette,
      },
      previewFallback: resolvePreviewUrl(site),
    };
  });

  const saved = domain.sitesSave(workspaceId, prepared.siteId, {
    pages: prepared.pages,
    theme: prepared.theme,
    note:
      colors.font || colors.headingFont || elementPatch ? 'Client portal theme fonts' : 'Client portal theme colors',
  });

  syncDesignDeliverablePages(workspaceId, leadId, prepared.siteId, prepared.pages, prepared.theme);

  let previewUrl = prepared.previewFallback;
  let publicPreviewUpdated = false;
  try {
    const preview = await domain.sitesPreview(workspaceId, prepared.siteId, { force: true });
    if (preview && preview.url) {
      previewUrl = preview.url;
      publicPreviewUpdated = true;
    }
  } catch (e) {
    console.warn('[clientPortal] force preview after theme:', e.message);
    const previewRow = domain.withDb(workspaceId, (db) =>
      db.prepare('SELECT preview_url, preview_path FROM websites WHERE id = ?').get(prepared.siteId)
    );
    previewUrl = resolvePreviewUrl(previewRow) || prepared.previewFallback;
  }

  try {
    domain.intentRecord(workspaceId, Number(leadId), 'theme.colors', 'Client portal theme colors');
  } catch {
    /* optional */
  }

  return {
    siteId: prepared.siteId,
    theme: prepared.colors,
    version: saved.version,
    previewUrl,
    publicPreviewUpdated,
  };
}

/**
 * Batch 94 — the implementor's element-style capability for the
 * portal design chat: apply ONE scoped style rule (e.g. selector
 * "h3", property "color", value "#444444" → every H3 on the site)
 * into the managed block of theme.customCss. Before this, the
 * in-chat agent could only change global theme colours, so it
 * refused and queued canonical small jobs ("make all H3s dark
 * grey"). All validation lives in server/styleRules.js (selector
 * grammar + property allowlist + per-property value checks) —
 * nothing unvalidated reaches the stylesheet. Persistence mirrors
 * applyClientThemeColors (sitesSave + deliverable sync + preview).
 */
async function applyClientStyleRule(workspaceId, leadId, args = {}) {
  const domain = require('./domain');
  const styleRules = require('./styleRules');
  const googleFonts = require('../public/js/fonts.js');
  const selector = styleRules.validateSelector(args.selector);
  if (!selector) {
    throw Object.assign(
      new Error('Selector is outside the allowed grammar (an element like h3, a .class, or section-scoped)'),
      { code: 'INVALID_SELECTOR' }
    );
  }
  const property = String(args.property || '').trim().toLowerCase();
  const removing = args.remove === true || args.value == null;
  let value = removing ? null : String(args.value);
  if (!removing && property === 'font-family') {
    value = googleFonts.safeStack(value);
  }
  // Validate BEFORE opening the DB so a bad rule never writes.
  const decl = removing ? null : styleRules.validateDeclaration(property, value);

  const prepared = domain.withDb(workspaceId, (db) => {
    const lead = db.prepare('SELECT id FROM leads WHERE id = ? LIMIT 1').get(Number(leadId));
    if (!lead) {
      throw Object.assign(new Error('Linked business not found'), { code: 'NOT_FOUND' });
    }
    const site = resolveClientSite(db, leadId);
    if (!site || !Array.isArray(site.pages) || !site.pages.length) {
      throw Object.assign(new Error('No website is available to edit yet'), { code: 'NO_SITE' });
    }
    const oldTheme = site.theme && typeof site.theme === 'object' ? site.theme : {};
    const customCss = styleRules.upsertStyleRule(String(oldTheme.customCss || ''), {
      selector,
      property,
      value: removing ? null : decl.value,
    });
    const theme = { ...oldTheme, customCss };
    return { siteId: site.id, pages: site.pages, theme, previewFallback: resolvePreviewUrl(site) };
  });

  const saved = domain.sitesSave(workspaceId, prepared.siteId, {
    pages: prepared.pages,
    theme: prepared.theme,
    note: 'Client portal style rule',
  });
  syncDesignDeliverablePages(workspaceId, leadId, prepared.siteId, prepared.pages, prepared.theme);

  let previewUrl = prepared.previewFallback;
  let publicPreviewUpdated = false;
  try {
    const preview = await domain.sitesPreview(workspaceId, prepared.siteId, { force: true });
    if (preview && preview.url) {
      previewUrl = preview.url;
      publicPreviewUpdated = true;
    }
  } catch (e) {
    console.warn('[clientPortal] force preview after style rule:', e.message);
    const previewRow = domain.withDb(workspaceId, (db) =>
      db.prepare('SELECT preview_url, preview_path FROM websites WHERE id = ?').get(prepared.siteId)
    );
    previewUrl = resolvePreviewUrl(previewRow) || prepared.previewFallback;
  }

  try {
    domain.intentRecord(workspaceId, Number(leadId), 'theme.styleRule', 'Client portal style rule');
  } catch {
    /* optional */
  }

  return {
    siteId: prepared.siteId,
    rule: removing ? { selector, property, removed: true } : { selector, property, value: decl.value },
    rules: styleRules.listStyleRules(prepared.theme.customCss),
    version: saved.version,
    previewUrl,
    publicPreviewUpdated,
  };
}

/**
 * Rematerialize the site export and refresh the public preview URL (Cloudflare Pages when configured).
 */
async function publishClientSitePreview(workspaceId, leadId) {
  const domain = require('./domain');
  const prepared = domain.withDb(workspaceId, (db) => {
    const lead = db.prepare('SELECT id FROM leads WHERE id = ? LIMIT 1').get(Number(leadId));
    if (!lead) {
      throw Object.assign(new Error('Linked business not found'), { code: 'NOT_FOUND' });
    }
    const site = resolveClientSite(db, leadId);
    if (!site || !Array.isArray(site.pages) || !site.pages.length) {
      throw Object.assign(new Error('No website is available yet'), { code: 'NO_SITE' });
    }
    return {
      siteId: site.id,
      previewFallback: resolvePreviewUrl(site),
    };
  });

  const preview = await domain.sitesPreview(workspaceId, prepared.siteId, { force: true });
  const previewUrl = (preview && preview.url) || prepared.previewFallback;
  const via = (preview && preview.via) || 'unknown';
  return {
    siteId: prepared.siteId,
    previewUrl,
    via,
    publicPreviewUpdated: via === 'cloudflare' || via === 'app_url',
    folder: preview && preview.folder,
  };
}

/**
 * Apply text edits from portal postMessage ids (`page:section:path`).
 * Saves via sitesSave (re-materializes /site-previews) and syncs design deliverable when linked.
 */
async function applyClientTextEdits(workspaceId, leadId, edits) {
  const domain = require('./domain');
  const list = Array.isArray(edits) ? edits : [];
  if (!list.length) {
    throw Object.assign(new Error('No edits to save'), { code: 'EMPTY' });
  }
  if (list.length > 80) {
    throw Object.assign(new Error('Too many edits in one save'), { code: 'TOO_MANY' });
  }

  const prepared = domain.withDb(workspaceId, (db) => {
    const lead = db.prepare('SELECT id FROM leads WHERE id = ? LIMIT 1').get(Number(leadId));
    if (!lead) {
      throw Object.assign(new Error('Linked business not found'), { code: 'NOT_FOUND' });
    }
    const site = resolveClientSite(db, leadId);
    if (!site || !Array.isArray(site.pages) || !site.pages.length) {
      throw Object.assign(new Error('No website is available to edit yet'), { code: 'NO_SITE' });
    }
    if (!pagesSupportInlineEdit(site.pages)) {
      throw Object.assign(
        new Error('This site layout does not support inline text edits. Use Request changes instead.'),
        { code: 'NOT_EDITABLE' }
      );
    }

    const engine = require('../src/websiteEngine');
    const pages = JSON.parse(JSON.stringify(site.pages));
    const theme = site.theme && typeof site.theme === 'object' ? site.theme : {};
    const applied = [];
    const skipped = [];
    /** @type {Map<number, Map<number, string>>} */
    const freeformByPage = new Map();
    /** @type {Map<string, Map<number, string>>} key = `${pi}:${si}` */
    const freeformBySection = new Map();

    for (const raw of list) {
      const id = String((raw && raw.id) || '').trim();
      const text = String((raw && raw.text) != null ? raw.text : '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 4000);

      // Modular freestyle: html:pageIndex:sectionIndex:nodeIndex
      const freeSec = id.match(/^html:(\d+):(\d+):(\d+)$/);
      if (freeSec) {
        const pi = Number(freeSec[1]);
        const si = Number(freeSec[2]);
        const ni = Number(freeSec[3]);
        const page = pages[pi];
        const section = page && Array.isArray(page.sections) ? page.sections[si] : null;
        if (!section || !section.content || typeof section.content.html !== 'string') {
          skipped.push({ id, reason: 'missing' });
          continue;
        }
        const key = `${pi}:${si}`;
        if (!freeformBySection.has(key)) freeformBySection.set(key, new Map());
        freeformBySection.get(key).set(ni, text);
        applied.push(id);
        continue;
      }

      // Legacy freeform page.html: html:pageIndex:nodeIndex
      const free = id.match(/^html:(\d+):(\d+)$/);
      if (free) {
        const pi = Number(free[1]);
        const ni = Number(free[2]);
        const page = pages[pi];
        if (!page || typeof page.html !== 'string' || !page.html.trim()) {
          skipped.push({ id, reason: 'missing' });
          continue;
        }
        if (!freeformByPage.has(pi)) freeformByPage.set(pi, new Map());
        freeformByPage.get(pi).set(ni, text);
        applied.push(id);
        continue;
      }

      const m = id.match(/^(\d+):(\d+):(.+)$/);
      if (!m) {
        skipped.push({ id, reason: 'bad_id' });
        continue;
      }
      const pi = Number(m[1]);
      const si = Number(m[2]);
      const path = m[3];
      if (isPortalLockedPath(path)) {
        skipped.push({ id, reason: 'locked' });
        continue;
      }
      const page = pages[pi];
      const section = page && Array.isArray(page.sections) ? page.sections[si] : null;
      if (!section || !section.content || typeof section.content !== 'object') {
        skipped.push({ id, reason: 'missing' });
        continue;
      }
      setContentPath(section.content, path, text);
      applied.push(id);
    }

    for (const [key, nodeMap] of freeformBySection) {
      const [piStr, siStr] = key.split(':');
      const pi = Number(piStr);
      const si = Number(siStr);
      const section = pages[pi].sections[si];
      section.content.html = engine.applyFreeformTextEdits(section.content.html, nodeMap);
    }

    for (const [pi, nodeMap] of freeformByPage) {
      pages[pi].html = engine.applyFreeformTextEdits(pages[pi].html, nodeMap);
      try {
        const modules = require('./siteModules');
        if (typeof modules.ensureClientPageChrome === 'function') {
          pages[pi].html = modules.ensureClientPageChrome(pages[pi].html);
        }
      } catch {
        /* optional chrome upgrade */
      }
    }

    if (!applied.length) {
      throw Object.assign(
        new Error(
          skipped.some((s) => s.reason === 'locked')
            ? 'Those fields are locked (contact details and links). Use Request changes for those.'
            : 'No valid text edits to apply'
        ),
        { code: 'NO_VALID_EDITS' }
      );
    }

    return {
      siteId: site.id,
      pages,
      theme,
      applied,
      skipped,
      previewFallback: resolvePreviewUrl(site),
    };
  });

  // sitesSave rematerializes public /site-previews export folder.
  const saved = domain.sitesSave(workspaceId, prepared.siteId, {
    pages: prepared.pages,
    theme: prepared.theme,
    note: 'Client portal inline edit',
  });

  domain.withDb(workspaceId, (db) => {
    try {
      const job = db
        .prepare(
          `SELECT id, website_id, deliverable FROM design_jobs
         WHERE lead_id = ? AND (website_id = ? OR website_id IS NULL)
         ORDER BY CASE WHEN website_id = ? THEN 0 ELSE 1 END, id DESC LIMIT 1`
        )
        .get(Number(leadId), prepared.siteId, prepared.siteId);
      if (job && job.deliverable) {
        const payload = parseJsonSafe(job.deliverable, null);
        if (payload && Array.isArray(payload.pages)) {
          payload.pages = prepared.pages;
          payload.theme = prepared.theme;
          db.prepare(`UPDATE design_jobs SET deliverable = ?, updated_at = datetime('now') WHERE id = ?`).run(
            JSON.stringify(payload),
            job.id
          );
        }
      }
    } catch {
      /* optional sync */
    }
  });

  let previewUrl = prepared.previewFallback;
  let publicPreviewUpdated = false;
  try {
    const preview = await domain.sitesPreview(workspaceId, prepared.siteId, { force: true });
    if (preview && preview.url) {
      previewUrl = preview.url;
      publicPreviewUpdated = true;
    }
  } catch (e) {
    console.warn('[clientPortal] force preview after edit:', e.message);
    const previewRow = domain.withDb(workspaceId, (db) =>
      db.prepare(`SELECT preview_url, preview_path FROM websites WHERE id = ?`).get(prepared.siteId)
    );
    previewUrl = resolvePreviewUrl(previewRow) || prepared.previewFallback;
  }

  return {
    siteId: prepared.siteId,
    applied: prepared.applied.length,
    skipped: prepared.skipped,
    version: saved.version,
    previewUrl,
    publicPreviewUpdated,
  };
}

const LIST_ITEM_MAX = 24;

function blankListItem(listKey, sectionType) {
  if (listKey === 'reviews') {
    return { name: 'Customer', text: 'Add your review text here.', stars: 5 };
  }
  if (listKey === 'paragraphs') {
    return 'Add a new paragraph here.';
  }
  if (sectionType === 'faq' || (listKey === 'items' && sectionType === 'faq')) {
    return { q: 'New question?', a: 'Add your answer here.' };
  }
  if (sectionType === 'services') {
    return { name: 'New service', description: 'Describe this service.' };
  }
  // benefits / generic cards
  return { title: 'New item', text: 'Describe this item.' };
}

/**
 * Add or delete an item in a section list (benefits/services/faq/reviews).
 * Body: { action: 'add'|'delete', pageIndex, sectionIndex, listKey, index? }
 */
function mutateClientListItem(workspaceId, leadId, body = {}) {
  const domain = require('./domain');
  const action = String(body.action || '').toLowerCase();
  if (action !== 'add' && action !== 'delete') {
    throw Object.assign(new Error('action must be add or delete'), { code: 'INVALID' });
  }
  const pageIndex = Number(body.pageIndex);
  const sectionIndex = Number(body.sectionIndex);
  const listKey = String(body.listKey || 'items').trim() || 'items';
  const index = Number(body.index);

  const prepared = domain.withDb(workspaceId, (db) => {
    const lead = db.prepare('SELECT id FROM leads WHERE id = ? LIMIT 1').get(Number(leadId));
    if (!lead) throw Object.assign(new Error('Linked business not found'), { code: 'NOT_FOUND' });
    const site = resolveClientSite(db, leadId);
    if (!site || !Array.isArray(site.pages) || !site.pages.length) {
      throw Object.assign(new Error('No website is available to edit yet'), { code: 'NO_SITE' });
    }
    const pages = JSON.parse(JSON.stringify(site.pages));
    const page = pages[pageIndex];
    if (!page || !Array.isArray(page.sections)) {
      throw Object.assign(new Error('Page not found'), { code: 'NOT_FOUND' });
    }
    const section = page.sections[sectionIndex];
    if (!section || !section.content || typeof section.content !== 'object') {
      throw Object.assign(new Error('Section not found'), { code: 'NOT_FOUND' });
    }
    let list = section.content[listKey];
    if (!Array.isArray(list)) {
      // faq/services/benefits use items; reviews use reviews
      if (listKey === 'items' && Array.isArray(section.content.reviews)) list = section.content.reviews;
      else {
        section.content[listKey] = [];
        list = section.content[listKey];
      }
    }
    if (action === 'add') {
      if (list.length >= LIST_ITEM_MAX) {
        throw Object.assign(new Error('Maximum items reached'), { code: 'TOO_MANY' });
      }
      list.push(blankListItem(listKey, section.type));
    } else {
      if (list.length <= 1) {
        throw Object.assign(new Error('Keep at least one item'), { code: 'LAST_ITEM' });
      }
      if (!Number.isInteger(index) || index < 0 || index >= list.length) {
        throw Object.assign(new Error('Invalid item index'), { code: 'INVALID' });
      }
      list.splice(index, 1);
    }
    section.content[listKey] = list;
    return {
      siteId: site.id,
      pages,
      theme: site.theme && typeof site.theme === 'object' ? site.theme : {},
      previewFallback: resolvePreviewUrl(site),
    };
  });

  const saved = domain.sitesSave(workspaceId, prepared.siteId, {
    pages: prepared.pages,
    theme: prepared.theme,
    note: action === 'add' ? 'Client portal: added list item' : 'Client portal: removed list item',
  });
  syncDesignDeliverablePages(workspaceId, leadId, prepared.siteId, prepared.pages, prepared.theme);
  const previewRow = domain.withDb(workspaceId, (db) =>
    db.prepare(`SELECT preview_url, preview_path FROM websites WHERE id = ?`).get(prepared.siteId)
  );
  return {
    siteId: prepared.siteId,
    action,
    version: saved.version,
    previewUrl: resolvePreviewUrl(previewRow) || prepared.previewFallback,
  };
}

/**
 * Forms and site modules placed on a page are one module block.
 * Delete turns embedding off so the next save does not put the block back.
 * Undo turns it on again.
 */
function applyEmbedPlacement(db, leadId, body) {
  const remove = body && body.embedRemove;
  const restore = body && body.embedRestore;
  const change = remove && remove.kind ? remove : restore && restore.kind ? restore : null;
  if (!change) return;
  const on = !remove;
  const lid = Number(leadId);
  if (change.kind === 'module' && change.moduleType) {
    const type = String(change.moduleType).trim().toLowerCase();
    db.prepare(
      `UPDATE site_module_embeds
       SET published = ?, embed_enabled = ?, updated_at = datetime('now')
       WHERE lead_id = ? AND module_type = ?`
    ).run(on ? 1 : 0, on ? 1 : 0, lid, type);
    return;
  }
  if (change.kind === 'form' && change.token) {
    db.prepare(
      `UPDATE contact_forms
       SET embed_enabled = ?, updated_at = datetime('now')
       WHERE lead_id = ? AND public_token = ?`
    ).run(on ? 1 : 0, lid, String(change.token));
  }
}

/**
 * Replace freeform page.html after client-side clone/delete of a list block.
 * Body: { pageIndex, html }
 */
function saveClientPageHtml(workspaceId, leadId, body = {}) {
  const domain = require('./domain');
  const engine = require('../src/websiteEngine');
  const pageIndex = Number(body.pageIndex);
  const sectionIndexRaw = body.sectionIndex != null ? Number(body.sectionIndex) : NaN;
  let html = String(body.html || '');
  if (!Number.isInteger(pageIndex) || pageIndex < 0) {
    throw Object.assign(new Error('Invalid pageIndex'), { code: 'INVALID' });
  }
  if (!html.trim()) {
    throw Object.assign(new Error('Empty HTML'), { code: 'EMPTY' });
  }
  if (html.length > 1_500_000) {
    throw Object.assign(new Error('HTML too large'), { code: 'TOO_LARGE' });
  }
  // Sanitize; drop edit chrome if any leaked through
  if (typeof engine.sanitizeHtml === 'function') {
    html = engine.sanitizeHtml(html);
  }
  html = html
    .replace(/<button\b[^>]*class="[^"]*ws-(?:add|del|ff)-[^"]*"[^>]*>[\s\S]*?<\/button>/gi, '')
    .replace(/\sdata-edit="[^"]*"/gi, '')
    .replace(/\sclass="ws-edit"/gi, '');

  const prepared = domain.withDb(workspaceId, (db) => {
    const lead = db.prepare('SELECT id FROM leads WHERE id = ? LIMIT 1').get(Number(leadId));
    if (!lead) throw Object.assign(new Error('Linked business not found'), { code: 'NOT_FOUND' });
    const site = resolveClientSite(db, leadId);
    if (!site || !Array.isArray(site.pages) || !site.pages.length) {
      throw Object.assign(new Error('No website is available to edit yet'), { code: 'NO_SITE' });
    }
    const pages = JSON.parse(JSON.stringify(site.pages));
    const page = pages[pageIndex];
    if (!page) throw Object.assign(new Error('Page not found'), { code: 'NOT_FOUND' });

    const usesSections = Array.isArray(page.sections) && page.sections.length > 0;
    if (usesSections) {
      if (body.sectionIndex == null) {
        throw Object.assign(new Error('Select the original page section before saving this edit'), {
          code: 'SECTION_CONTEXT_REQUIRED',
          status: 409,
        });
      }
      const si = sectionIndexRaw;
      if (
        !Number.isInteger(si) ||
        si < 0 ||
        !page.sections[si]?.content ||
        typeof page.sections[si].content.html !== 'string'
      ) {
        throw Object.assign(new Error('The selected HTML section is unavailable'), {
          code: 'NOT_FREEFORM',
          status: 409,
        });
      }
      const sec = page.sections[si];
      sec.content = Object.assign({}, sec.content || {}, { html });
      if (typeof page.html === 'string') delete page.html;
      applyEmbedPlacement(db, leadId, body);
      const theme = site.theme && typeof site.theme === 'object' ? site.theme : {};
      return {
        siteId: site.id,
        pages,
        theme,
        previewFallback: resolvePreviewUrl(site),
      };
    }

    if (typeof page.html !== 'string' || !page.html.trim()) {
      throw Object.assign(new Error('This page is not freeform HTML'), { code: 'NOT_FREEFORM' });
    }
    const original = page.html;
    // Prefer file hrefs in stored HTML (strip preview-only #page anchors when multipage).
    html = engine.normalizePagesNavLinks(pages.map((p, i) => (i === pageIndex ? { ...p, html } : p)))[pageIndex].html;
    if (/<body\b/i.test(original) || /<!DOCTYPE/i.test(original) || /<html\b/i.test(original)) {
      const split = original.match(/(<body\b[^>]*>)([\s\S]*)(<\/body\s*>)/i);
      if (split) {
        page.html = original.replace(split[0], `${split[1]}${html}${split[3]}`);
      } else {
        page.html = html;
      }
    } else {
      page.html = html;
    }
    try {
      const modules = require('./siteModules');
      if (typeof modules.ensureClientPageChrome === 'function') {
        page.html = modules.ensureClientPageChrome(page.html);
      }
    } catch {
      /* optional chrome upgrade */
    }
    applyEmbedPlacement(db, leadId, body);
    return {
      siteId: site.id,
      pages,
      theme: site.theme && typeof site.theme === 'object' ? site.theme : {},
      previewFallback: resolvePreviewUrl(site),
    };
  });

  const saved = domain.sitesSave(workspaceId, prepared.siteId, {
    pages: prepared.pages,
    theme: prepared.theme,
    note: 'Client portal: list item change',
  });
  syncDesignDeliverablePages(workspaceId, leadId, prepared.siteId, prepared.pages, prepared.theme);
  const previewRow = domain.withDb(workspaceId, (db) =>
    db.prepare(`SELECT preview_url, preview_path FROM websites WHERE id = ?`).get(prepared.siteId)
  );
  return {
    siteId: prepared.siteId,
    version: saved.version,
    previewUrl: resolvePreviewUrl(previewRow) || prepared.previewFallback,
  };
}

function syncDesignDeliverablePages(workspaceId, leadId, siteId, pages, theme) {
  const domain = require('./domain');
  domain.withDb(workspaceId, (db) => {
    try {
      const job = db
        .prepare(
          `SELECT id, website_id, deliverable FROM design_jobs
         WHERE lead_id = ? AND (website_id = ? OR website_id IS NULL)
         ORDER BY CASE WHEN website_id = ? THEN 0 ELSE 1 END, id DESC LIMIT 1`
        )
        .get(Number(leadId), Number(siteId), Number(siteId));
      if (job && job.deliverable) {
        const payload = parseJsonSafe(job.deliverable, null);
        if (payload && Array.isArray(payload.pages)) {
          payload.pages = pages;
          payload.theme = theme;
          db.prepare(`UPDATE design_jobs SET deliverable = ?, updated_at = datetime('now') WHERE id = ?`).run(
            JSON.stringify(payload),
            job.id
          );
        }
      }
    } catch {
      /* optional */
    }
  });
}

const PORTAL_IMAGE_MAX_BYTES = 5.5 * 1024 * 1024;
const PORTAL_IMAGE_MIME = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

function sniffImageMime(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** Normalize an img src from the preview iframe to a relative export path. */
function normalizePortalImageSrc(raw, previewUrl) {
  let s = String(raw || '').trim();
  if (!s) return null;
  s = s.split('#')[0].split('?')[0];
  if (/^data:/i.test(s) || /^blob:/i.test(s)) return null;

  const tryRel = (u) => {
    let r = String(u || '')
      .replace(/\\/g, '/')
      .replace(/^\.\//, '');
    if (r.startsWith('/')) r = r.replace(/^\/+/, '');
    if (!r || r.includes('..')) return null;
    if (/^images\//i.test(r)) return `images/${path.basename(r)}`;
    if (/^assets\//i.test(r)) return `assets/${path.basename(r)}`;
    if (/^https?:\/\//i.test(r)) return null;
    if (/\.(png|jpe?g|gif|webp|svg|ico)$/i.test(r) && !r.includes('/')) {
      return `images/${r}`;
    }
    return null;
  };

  const direct = tryRel(s);
  if (direct) return direct;

  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      const pathName = u.pathname.replace(/\\/g, '/');
      const m = pathName.match(/\/site-previews\/[^/]+\/(.+)$/i);
      if (m) {
        const rel = tryRel(m[1]);
        if (rel) return rel;
      }
      const imgTail = pathName.match(/\/((?:images|assets)\/[^/]+)$/i);
      if (imgTail) {
        const rel = tryRel(imgTail[1]);
        if (rel) return rel;
      }
      const base = String(previewUrl || '').trim();
      if (base) {
        const b = new URL(base.endsWith('/') ? base : `${base}/`);
        if (u.origin === b.origin && pathName.startsWith(b.pathname)) {
          const rel = tryRel(pathName.slice(b.pathname.length));
          if (rel) return rel;
        }
      }
      // Last resort: basename under images/ when replacing a local asset name.
      const baseName = path.basename(pathName);
      if (/\.(png|jpe?g|gif|webp)$/i.test(baseName)) return `images/${baseName}`;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function replaceSrcDeep(value, from, to) {
  if (typeof value === 'string') {
    if (value === from) return to;
    if (value.includes(from)) return value.split(from).join(to);
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => replaceSrcDeep(v, from, to));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = replaceSrcDeep(v, from, to);
    return out;
  }
  return value;
}

/**
 * Client portal image replace: write under site export/images, update pages, rematerialize.
 * Ownership: workspaceId + leadId from the portal session only.
 */
async function applyClientImageUpload(workspaceId, leadId, payload = {}) {
  const domain = require('./domain');
  const openPreview = require('../src/openPreview');

  const replaceSrcRaw = String(payload.replaceSrc || payload.src || '').trim();
  const mimeClaimed = String(payload.mimeType || payload.contentType || '')
    .trim()
    .toLowerCase();
  const dataB64 = String(payload.data || payload.base64 || '')
    .replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '')
    .replace(/\s+/g, '');

  if (!replaceSrcRaw) {
    throw Object.assign(new Error('Missing image to replace'), { code: 'EMPTY' });
  }
  if (!dataB64) {
    throw Object.assign(new Error('Missing image data'), { code: 'EMPTY' });
  }

  let buffer;
  try {
    buffer = Buffer.from(dataB64, 'base64');
  } catch {
    throw Object.assign(new Error('Invalid image data'), { code: 'INVALID_IMAGE' });
  }
  if (!buffer.length || buffer.length > PORTAL_IMAGE_MAX_BYTES) {
    throw Object.assign(new Error('Image is too large (max ~5 MB after resize)'), { code: 'TOO_LARGE' });
  }

  let sniffed = sniffImageMime(buffer);
  if (!sniffed) {
    throw Object.assign(new Error('File is not a supported image (JPEG, PNG, WebP, GIF)'), { code: 'INVALID_IMAGE' });
  }
  let ext = PORTAL_IMAGE_MIME[sniffed] || PORTAL_IMAGE_MIME[mimeClaimed];
  if (!ext) {
    throw Object.assign(new Error('Unsupported image type'), { code: 'INVALID_IMAGE' });
  }

  try {
    const imageOptimize = require('../src/imageOptimize');
    const opt = await imageOptimize.optimizeBuffer(buffer, {
      fileName: `upload.${ext}`,
      role: 'photo',
      preferWebp: true,
    });
    if (!opt.skipped && opt.buffer && opt.buffer.length) {
      buffer = opt.buffer;
      if (opt.ext) ext = opt.ext.replace(/^\./, '');
      sniffed = opt.mime || sniffed;
    }
  } catch (e) {
    console.warn('[portal] image optimize skip:', e.message || e);
  }

  const prepared = domain.withDb(workspaceId, (db) => {
    const lead = db.prepare('SELECT id FROM leads WHERE id = ? LIMIT 1').get(Number(leadId));
    if (!lead) {
      throw Object.assign(new Error('Linked business not found'), { code: 'NOT_FOUND' });
    }
    const site = resolveClientSite(db, leadId);
    if (!site || !Array.isArray(site.pages) || !site.pages.length) {
      throw Object.assign(new Error('No website is available to edit yet'), { code: 'NO_SITE' });
    }
    if (!pagesSupportInlineEdit(site.pages)) {
      throw Object.assign(
        new Error('This site layout does not support inline image edits. Use Request changes instead.'),
        { code: 'NOT_EDITABLE' }
      );
    }

    const previewFallback = resolvePreviewUrl(site);
    const assetBase = resolveExportPreviewBase(workspaceId, site);
    const oldRel = normalizePortalImageSrc(replaceSrcRaw, assetBase || previewFallback);
    if (!oldRel) {
      throw Object.assign(new Error('That image cannot be replaced from the portal'), { code: 'INVALID_IMAGE' });
    }

    const folder = domain.resolveSiteExportFolder(workspaceId, site, db);
    const isAsset = /^assets\//i.test(oldRel);
    // Stable assets/ keep their filename; images/ get a unique upload name.
    const name = isAsset
      ? path.basename(oldRel)
      : `upload-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}.${ext}`;
    const sub = isAsset ? 'assets' : 'images';
    const imgDir = path.join(openPreview.exportRoot(), folder, sub);
    fs.mkdirSync(imgDir, { recursive: true });
    const absPath = path.join(imgDir, name);
    fs.writeFileSync(absPath, buffer);
    // Also mirror into the site staging folder so CF materialize always
    // finds the file. Batch 102 (SEC-20): mirror into the workspace-
    // scoped staging folder (materialize reads it first); the legacy
    // site-{id} mirror is kept for older readers.
    try {
      const scopedDir = path.join(
        openPreview.exportRoot(),
        require('../src/assetValidation').siteStorageFolder(workspaceId, site.id),
        sub
      );
      fs.mkdirSync(scopedDir, { recursive: true });
      fs.copyFileSync(absPath, path.join(scopedDir, name));
      const appDir = path.join(openPreview.exportRoot(), `site-${site.id}`, sub);
      fs.mkdirSync(appDir, { recursive: true });
      fs.copyFileSync(absPath, path.join(appDir, name));
    } catch {
      /* best effort */
    }
    const newRel = `${sub}/${name}`;

    let pages = JSON.parse(JSON.stringify(site.pages));
    pages = replaceSrcDeep(pages, oldRel, newRel);
    // Common relative variants used in freeform HTML / CSS.
    if (oldRel.startsWith('images/') || oldRel.startsWith('assets/')) {
      pages = replaceSrcDeep(pages, `./${oldRel}`, newRel);
      pages = replaceSrcDeep(pages, `/${oldRel}`, newRel);
    }

    const theme = site.theme && typeof site.theme === 'object' ? site.theme : {};

    // Keep deliverable.images in sync so later rematerialize / publish keep the file.
    try {
      const job = db
        .prepare(
          `SELECT id, website_id, deliverable FROM design_jobs
         WHERE lead_id = ? AND (website_id = ? OR website_id IS NULL)
         ORDER BY CASE WHEN website_id = ? THEN 0 ELSE 1 END, id DESC LIMIT 1`
        )
        .get(Number(leadId), site.id, site.id);
      if (job && job.deliverable) {
        const payloadJob = parseJsonSafe(job.deliverable, null);
        if (payloadJob && typeof payloadJob === 'object') {
          if (Array.isArray(payloadJob.pages)) payloadJob.pages = pages;
          payloadJob.theme = theme;
          if (!Array.isArray(payloadJob.images)) payloadJob.images = [];
          payloadJob.images.push({
            name,
            path: absPath,
            url: newRel,
            source: 'client-portal',
            replaced: oldRel,
          });
          db.prepare(`UPDATE design_jobs SET deliverable = ?, updated_at = datetime('now') WHERE id = ?`).run(
            JSON.stringify(payloadJob),
            job.id
          );
        }
      }
    } catch {
      /* optional */
    }

    return {
      siteId: site.id,
      pages,
      theme,
      oldRel,
      newRel,
      previewFallback,
      assetBase,
      publicUrl: assetBase ? `${String(assetBase).replace(/\/+$/, '')}/${newRel}` : null,
    };
  });

  const saved = domain.sitesSave(workspaceId, prepared.siteId, {
    pages: prepared.pages,
    theme: prepared.theme,
    note: 'Client portal image replace',
  });

  // Ensure the new file still exists after rematerialize (copy from our write if needed).
  try {
    const previewRowEarly = domain.withDb(workspaceId, (db) =>
      db.prepare(`SELECT preview_url, preview_path, export_slug FROM websites WHERE id = ?`).get(prepared.siteId)
    );
    const folder = domain.resolveSiteExportFolder(workspaceId, {
      id: prepared.siteId,
      preview_path: previewRowEarly && previewRowEarly.preview_path,
      export_slug: previewRowEarly && previewRowEarly.export_slug,
    });
    const dest = path.join(openPreview.exportRoot(), folder, prepared.newRel);
    if (!fs.existsSync(dest)) {
      // sitesSave may have used a fresh images copy; re-write from buffer we still have.
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buffer);
    }
  } catch {
    /* best effort */
  }

  const previewRow = domain.withDb(workspaceId, (db) =>
    db.prepare(`SELECT preview_url, preview_path, export_slug FROM websites WHERE id = ?`).get(prepared.siteId)
  );
  const previewUrl = resolvePreviewUrl(previewRow) || prepared.previewFallback;

  return {
    siteId: prepared.siteId,
    replaced: prepared.oldRel,
    src: prepared.newRel,
    publicUrl:
      prepared.publicUrl || (previewUrl ? `${String(previewUrl).replace(/\/+$/, '')}/${prepared.newRel}` : null),
    version: saved.version,
    previewUrl,
  };
}

/**
 * Standalone image upload for site module content (covers, product photos, etc.).
 * Body: { data: "<base64>", mimeType: "image/jpeg" }
 */
async function applyModuleAssetUpload(workspaceId, leadId, payload = {}) {
  const domain = require('./domain');
  const openPreview = require('../src/openPreview');

  const mimeClaimed = String(payload.mimeType || payload.contentType || '')
    .trim()
    .toLowerCase();
  const dataB64 = String(payload.data || payload.base64 || '')
    .replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '')
    .replace(/\s+/g, '');

  if (!dataB64) {
    throw Object.assign(new Error('Missing image data'), { code: 'EMPTY' });
  }

  let buffer;
  try {
    buffer = Buffer.from(dataB64, 'base64');
  } catch {
    throw Object.assign(new Error('Invalid image data'), { code: 'INVALID_IMAGE' });
  }
  if (!buffer.length || buffer.length > PORTAL_IMAGE_MAX_BYTES) {
    throw Object.assign(new Error('Image is too large (max ~5 MB after resize)'), { code: 'TOO_LARGE' });
  }

  let sniffed = sniffImageMime(buffer);
  if (!sniffed) {
    throw Object.assign(new Error('File is not a supported image (JPEG, PNG, WebP, GIF)'), { code: 'INVALID_IMAGE' });
  }
  let ext = PORTAL_IMAGE_MIME[sniffed] || PORTAL_IMAGE_MIME[mimeClaimed];
  if (!ext) {
    throw Object.assign(new Error('Unsupported image type'), { code: 'INVALID_IMAGE' });
  }

  try {
    const imageOptimize = require('../src/imageOptimize');
    const opt = await imageOptimize.optimizeBuffer(buffer, {
      fileName: `module.${ext}`,
      role: 'photo',
      preferWebp: true,
    });
    if (!opt.skipped && opt.buffer && opt.buffer.length) {
      buffer = opt.buffer;
      if (opt.ext) ext = opt.ext.replace(/^\./, '');
    }
  } catch (e) {
    console.warn('[portal] module image optimize skip:', e.message || e);
  }

  const prepared = domain.withDb(workspaceId, (db) => {
    const lead = db.prepare('SELECT id FROM leads WHERE id = ? LIMIT 1').get(Number(leadId));
    if (!lead) {
      throw Object.assign(new Error('Linked business not found'), { code: 'NOT_FOUND' });
    }
    const site = resolveClientSite(db, leadId);
    if (!site) {
      throw Object.assign(new Error('No website is available yet'), { code: 'NO_SITE' });
    }

    const previewFallback = resolvePreviewUrl(site);
    const assetBase = resolveExportPreviewBase(workspaceId, site);
    const folder = domain.resolveSiteExportFolder(workspaceId, site, db);
    const imgDir = path.join(openPreview.exportRoot(), folder, 'images');
    fs.mkdirSync(imgDir, { recursive: true });
    const name = `module-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}.${ext}`;
    fs.writeFileSync(path.join(imgDir, name), buffer);
    const newRel = `images/${name}`;

    const publicUrl = assetBase
      ? `${String(assetBase).replace(/\/+$/, '')}/${newRel}`
      : previewFallback
        ? `${String(previewFallback).replace(/\/+$/, '')}/${newRel}`
        : newRel;

    return { newRel, publicUrl };
  });

  return {
    src: prepared.newRel,
    url: prepared.publicUrl,
    publicUrl: prepared.publicUrl,
  };
}

/**
 * AI image generation for portal edit mode: OpenAI Images → replace site asset.
 * Credits: Free/Standard charge credits.per_social_image; Premium (socialImagesIncluded) is free.
 */
async function generateClientSiteImage(workspaceId, leadId, payload = {}, clientEmail = '') {
  const domain = require('./domain');
  const billing = require('./billing');
  const { getPlan } = require('./plans');
  const openaiImages = require('../src/openaiImages');
  const fs = require('fs');

  const prompt = String(payload.prompt || payload.description || '').trim();
  const replaceSrc = String(payload.replaceSrc || payload.src || '').trim();
  if (!prompt) {
    throw Object.assign(new Error('Describe the image you want'), { code: 'EMPTY' });
  }
  if (prompt.length > 2000) {
    throw Object.assign(new Error('Description is too long (max 2000 characters)'), { code: 'INVALID' });
  }
  if (!replaceSrc) {
    throw Object.assign(new Error('Missing image to replace'), { code: 'EMPTY' });
  }

  const planId = await billing.effectivePlan(workspaceId, { email: clientEmail });
  const entitlements = getPlan(planId).entitlements;
  const included = !!entitlements.socialImagesIncluded;
  const creditMod = require('./credits');
  const cfg = await creditMod.packConfig();
  const imageCost = included ? 0 : cfg.perImage;

  let spendResult = null;
  if (imageCost > 0) {
    spendResult = await creditMod.spend(workspaceId, imageCost, {
      reason: 'portal_site_image',
      refType: 'website',
      refId: String(leadId),
    });
  }

  try {
    const gen = await domain.withDb(workspaceId, async (db) => {
      if (!openaiImages.imageConfigured(db)) {
        throw Object.assign(new Error('Image generation is not configured yet. Contact support.'), {
          code: 'AI_NOT_CONFIGURED',
        });
      }
      return openaiImages.generateImages(db, prompt, {
        n: 1,
        size: payload.size || '1024x1024',
        quality: payload.quality != null ? payload.quality : 'low',
        leadId: Number(leadId),
        note: `portal site image lead=${leadId}`,
      });
    });

    const file = gen && Array.isArray(gen.images) ? gen.images[0] : null;
    if (!file || !file.path || !fs.existsSync(file.path)) {
      throw Object.assign(new Error('Image provider returned no image'), { code: 'AI_EMPTY' });
    }
    const buffer = fs.readFileSync(file.path);
    const mime = file.mime || 'image/png';
    const dataB64 = buffer.toString('base64');

    const out = await applyClientImageUpload(workspaceId, leadId, {
      replaceSrc,
      data: dataB64,
      mimeType: mime,
    });

    try {
      domain.intentRecord(workspaceId, Number(leadId), 'site.ai_image', prompt.slice(0, 160));
    } catch {
      /* optional */
    }

    return {
      ...out,
      prompt,
      model: gen.model || null,
      credits_charged: imageCost,
      credits_balance: spendResult ? spendResult.balance : await creditMod.getBalance(workspaceId),
      social_images_included: included,
      plan: planId,
    };
  } catch (e) {
    if (imageCost > 0) {
      try {
        await creditMod.grant(workspaceId, imageCost, {
          reason: 'refund_failed_portal_site_image',
          refType: 'website',
          refId: String(leadId),
        });
      } catch (re) {
        console.warn('[credits] refund after failed portal site image:', re.message);
      }
    }
    throw e;
  }
}

/**
 * Upload or clear the site header logo.
 * Body: { data, mimeType } to set an image logo, or { mode: "text" } to revert.
 * Optional brandName. Image is cover-cropped and saved as transparent PNG.
 */
async function applyClientLogoUpload(workspaceId, leadId, payload = {}) {
  const domain = require('./domain');
  const modeRaw = String(payload.mode || '')
    .trim()
    .toLowerCase();
  const wantText = modeRaw === 'text' || payload.clear === true || payload.remove === true;
  const brandName = payload.brandName != null ? String(payload.brandName).trim().slice(0, 120) : undefined;

  if (wantText) {
    return domain.sitesSetLogo(workspaceId, null, {
      leadId: Number(leadId),
      mode: 'text',
      brandName,
      note: 'Client portal logo → text',
    });
  }

  const dataB64 = String(payload.data || payload.base64 || '')
    .replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '')
    .replace(/\s+/g, '');
  if (!dataB64) {
    throw Object.assign(new Error('Missing logo image data (or pass mode: "text" to use text logo)'), {
      code: 'EMPTY',
    });
  }

  let buffer;
  try {
    buffer = Buffer.from(dataB64, 'base64');
  } catch {
    throw Object.assign(new Error('Invalid logo image data'), { code: 'INVALID_IMAGE' });
  }
  if (!buffer.length || buffer.length > PORTAL_IMAGE_MAX_BYTES) {
    throw Object.assign(new Error('Logo image is too large (max ~5 MB)'), { code: 'TOO_LARGE' });
  }
  if (!sniffImageMime(buffer)) {
    throw Object.assign(new Error('File is not a supported image (JPEG, PNG, WebP, GIF)'), { code: 'INVALID_IMAGE' });
  }

  const result = await domain.sitesSetLogo(workspaceId, null, {
    leadId: Number(leadId),
    mode: 'image',
    buffer,
    brandName,
    note: 'Client portal logo upload',
  });

  try {
    domain.intentRecord(workspaceId, Number(leadId), 'logo.uploaded', 'Client portal logo upload');
  } catch {
    /* optional */
  }

  return result;
}


module.exports = {
  renderClientSite,
  applyClientThemeColors,
  applyClientStyleRule,
  publishClientSitePreview,
  applyClientTextEdits,
  mutateClientListItem,
  saveClientPageHtml,
  normalizePortalImageSrc,
  applyClientImageUpload,
  applyModuleAssetUpload,
  generateClientSiteImage,
  applyClientLogoUpload,
  syncDesignDeliverablePages,
};
