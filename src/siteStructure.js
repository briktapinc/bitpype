'use strict';

/**
 * Menu (pages[]) and section reorder helpers for portal + staff UI + MCP.
 * WordPress-style: pages may set menuParent (parent page slug) for one-level submenus.
 * Banner/hero/nav section types stay pinned; other sections can move past each other.
 */

const engine = require('./websiteEngine');

const PINNED_SECTION_TYPES = new Set(['nav', 'hero', 'banner']);
const MAX_MENU_DEPTH = 1;
const MAX_BLOCK_COLS = 12;

/** Column count for layout blocks (1–12). */
function clampBlockCols(n, fallback = 2) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return fallback;
  return Math.max(1, Math.min(MAX_BLOCK_COLS, v));
}

function isPinnedSection(section) {
  if (!section || typeof section !== 'object') return true;
  return PINNED_SECTION_TYPES.has(String(section.type || '').toLowerCase());
}

function isNavSection(section) {
  return !!(section && String(section.type || '').toLowerCase() === 'nav');
}

/**
 * Nav is always the first section on a page (sticky top chrome).
 * Extra nav sections are dropped; missing nav is left as-is (caller may require it).
 */
function ensureNavFirstSections(sections) {
  const list = Array.isArray(sections) ? sections.slice() : [];
  if (!list.length) return list;
  const navs = list.filter(isNavSection);
  const rest = list.filter((s) => !isNavSection(s));
  if (!navs.length) return list;
  return [navs[0], ...rest];
}

function ensureNavFirstPage(page) {
  if (!page || typeof page !== 'object') return page;
  if (!Array.isArray(page.sections) || !page.sections.length) return page;
  const next = ensureNavFirstSections(page.sections);
  if (next === page.sections || (next.length === page.sections.length && next.every((s, i) => s === page.sections[i])))
    return page;
  return Object.assign({}, page, { sections: next });
}

function ensureNavFirstPages(pages) {
  if (!Array.isArray(pages)) return pages;
  return pages.map(ensureNavFirstPage);
}

function isHomeLike(page, pages) {
  try {
    return engine.isHomePage(page, pages);
  } catch {
    const slug = String((page && page.slug) || '')
      .toLowerCase()
      .replace(/\.html$/i, '');
    return slug === '' || slug === 'home' || slug === 'index';
  }
}

function slugKey(slug) {
  return (
    String(slug == null ? '' : slug)
      .trim()
      .toLowerCase()
      .replace(/\.html$/i, '')
      .replace(/\/+$/, '') || ''
  );
}

function pageSlugKey(page) {
  return slugKey(page && page.slug);
}

function menuParentKey(page) {
  if (!page || typeof page !== 'object') return '';
  return slugKey(page.menuParent != null ? page.menuParent : page.menu_parent);
}

/** Default true — set page.navVisible = false to omit from site nav (page may still exist). */
function isNavVisible(page) {
  if (!page || typeof page !== 'object') return true;
  if (page.navVisible === false || page.nav_visible === false) return false;
  if (page.hiddenInNav === true || page.hidden_in_nav === true) return false;
  return true;
}

function setNavVisible(page, visible) {
  const next = Object.assign({}, page);
  if (visible) {
    delete next.navVisible;
    delete next.nav_visible;
    delete next.hiddenInNav;
    delete next.hidden_in_nav;
  } else {
    next.navVisible = false;
    delete next.nav_visible;
    delete next.hiddenInNav;
    delete next.hidden_in_nav;
  }
  return next;
}

function setMenuParent(page, parentSlug) {
  const next = Object.assign({}, page);
  const key = slugKey(parentSlug);
  if (!key) {
    delete next.menuParent;
    delete next.menu_parent;
  } else {
    next.menuParent = parentSlug;
    delete next.menu_parent;
  }
  return next;
}

function clonePages(pages) {
  return Array.isArray(pages) ? JSON.parse(JSON.stringify(pages)) : [];
}

/**
 * Resolve a stable parent key → page index map. Invalid/cyclic parents are treated as top-level.
 */
function resolveMenuParents(pages) {
  const list = Array.isArray(pages) ? pages : [];
  const bySlug = new Map();
  list.forEach((p, i) => {
    const k = pageSlugKey(p);
    if (k && !bySlug.has(k)) bySlug.set(k, i);
  });
  const parentOf = list.map((p, i) => {
    if (isHomeLike(p, list)) return '';
    let parent = menuParentKey(p);
    if (!parent || !bySlug.has(parent)) return '';
    if (bySlug.get(parent) === i) return '';
    // One level only: if parent is itself a child, promote to grandparent's parent (top).
    const parentPage = list[bySlug.get(parent)];
    const grand = menuParentKey(parentPage);
    if (grand && bySlug.has(grand)) {
      // Collapse deep nests to depth 1 under the top-most ancestor.
      let top = parent;
      let guard = 0;
      while (guard++ < 8) {
        const pi = bySlug.get(top);
        if (pi == null) break;
        const gp = menuParentKey(list[pi]);
        if (!gp || !bySlug.has(gp) || gp === top) break;
        top = gp;
      }
      parent = top;
    }
    return parent;
  });
  return { bySlug, parentOf };
}

/** Visual WordPress-style menu list (DFS, max depth 1). */
function menuVisualList(pages) {
  const list = Array.isArray(pages) ? pages : [];
  const { parentOf } = resolveMenuParents(list);
  const childrenOf = new Map();
  const tops = [];
  list.forEach((p, i) => {
    const parent = parentOf[i];
    if (!parent) {
      tops.push(i);
      return;
    }
    if (!childrenOf.has(parent)) childrenOf.set(parent, []);
    childrenOf.get(parent).push(i);
  });
  // Keep home first among tops when present.
  tops.sort((a, b) => {
    const ah = isHomeLike(list[a], list) ? 0 : 1;
    const bh = isHomeLike(list[b], list) ? 0 : 1;
    if (ah !== bh) return ah - bh;
    return a - b;
  });

  const out = [];
  tops.forEach((ti) => {
    const kids = childrenOf.get(pageSlugKey(list[ti])) || [];
    out.push({
      index: ti,
      depth: 0,
      slug: list[ti].slug,
      title: list[ti].title || list[ti].slug || `Page ${ti + 1}`,
      file: engine.pageFileName(list[ti].slug),
      pinned: isHomeLike(list[ti], list),
      parentSlug: null,
      childCount: kids.length,
      sectionCount: Array.isArray(list[ti].sections) ? list[ti].sections.length : 0,
      freeform:
        typeof list[ti].html === 'string' &&
        !!list[ti].html.trim() &&
        !(Array.isArray(list[ti].sections) && list[ti].sections.length),
      navVisible: isNavVisible(list[ti]),
    });
    kids.forEach((ci) => {
      out.push({
        index: ci,
        depth: 1,
        slug: list[ci].slug,
        title: list[ci].title || list[ci].slug || `Page ${ci + 1}`,
        file: engine.pageFileName(list[ci].slug),
        pinned: false,
        parentSlug: list[ti].slug,
        childCount: 0,
        sectionCount: Array.isArray(list[ci].sections) ? list[ci].sections.length : 0,
        freeform:
          typeof list[ci].html === 'string' &&
          !!list[ci].html.trim() &&
          !(Array.isArray(list[ci].sections) && list[ci].sections.length),
        navVisible: isNavVisible(list[ci]),
      });
    });
  });
  // Orphans already included as tops when parent invalid.
  return out;
}

function summarizeStructure(pages) {
  const list = Array.isArray(pages) ? pages : [];
  const menu = menuVisualList(list).map((item, visualIndex, arr) => {
    const prev = visualIndex > 0 ? arr[visualIndex - 1] : null;
    const next = visualIndex < arr.length - 1 ? arr[visualIndex + 1] : null;
    const canUp =
      !item.pinned &&
      !!prev &&
      prev.depth === item.depth &&
      String(prev.parentSlug || '') === String(item.parentSlug || '');
    const canDown =
      !item.pinned &&
      !!next &&
      next.depth === item.depth &&
      String(next.parentSlug || '') === String(item.parentSlug || '');
    // Nest under previous top-level item (or previous item's parent chain).
    let canNest = false;
    if (!item.pinned && item.depth < MAX_MENU_DEPTH && visualIndex > 0) {
      const candidate = arr[visualIndex - 1];
      if (candidate.depth === 0 && !candidate.pinned) canNest = true;
      else if (candidate.depth === 1 && candidate.parentSlug) canNest = item.depth === 0;
    }
    const canUnnest = !item.pinned && item.depth > 0;
    return Object.assign({}, item, { visualIndex, canUp, canDown, canNest, canUnnest });
  });
  return {
    menu,
    pages: list.map((p, i) => ({
      index: i,
      slug: p.slug,
      title: p.title || p.slug || `Page ${i + 1}`,
      menuParent: menuParentKey(p) || null,
      navVisible: isNavVisible(p),
      sections: Array.isArray(p.sections)
        ? p.sections.map((s, si) => ({
            index: si,
            type: s.type || 'block',
            pinned: isPinnedSection(s),
            label: sectionLabel(s, si),
          }))
        : [],
    })),
  };
}

function sectionLabel(section, index) {
  const t = String((section && section.type) || 'block');
  const c = (section && section.content) || {};
  if (t === 'site_module') {
    const mt = String(c.module_type || c.moduleType || 'module');
    const label = c.title || mt;
    return `Module: ${String(label).slice(0, 48)}`;
  }
  const title = c.title || c.heading || c.label || '';
  if (title) return `${t}: ${String(title).slice(0, 48)}`;
  return `${t} #${index + 1}`;
}

function titleToPageSlug(title) {
  const s = String(title || '')
    .trim()
    .toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  const base = s || 'page';
  return base.startsWith('/') ? base : `/${base}`;
}

function ensureUniquePageSlug(pages, slug) {
  let candidate = String(slug || '/page').trim();
  if (!candidate.startsWith('/')) candidate = `/${candidate.replace(/^\//, '')}`;
  const used = new Set((pages || []).map((p) => pageSlugKey(p)).filter(Boolean));
  if (!used.has(pageSlugKey({ slug: candidate }))) return candidate;
  const stem = candidate.replace(/^\//, '').replace(/\/$/, '') || 'page';
  for (let n = 2; n < 200; n += 1) {
    const next = `/${stem}-${n}`;
    if (!used.has(pageSlugKey({ slug: next }))) return next;
  }
  return `/${stem}-${Date.now()}`;
}

function defaultSectionContent(type, opts = {}) {
  const t = String(type || 'custom').toLowerCase();
  switch (t) {
    case 'hero':
      return {
        headline: 'Headline',
        subheadline: 'Add a short supporting line.',
        cta_text: 'Contact Us',
        cta_href: '#contact',
      };
    case 'benefits':
      return { title: 'Why Choose Us', items: [{ title: 'Benefit one', text: 'Short description.' }] };
    case 'services':
      return { title: 'Our Services', items: [{ name: 'Service name', description: 'Short description.' }] };
    case 'about':
      return { title: 'About Us', paragraphs: ['About paragraph.'] };
    case 'gallery':
      return { title: 'Gallery' };
    case 'reviews':
      return { title: 'Customer Reviews', reviews: [{ name: 'Customer', text: 'Great experience.', stars: 5 }] };
    case 'cta':
      return { title: 'Get in touch today', text: '', button_text: 'Contact Us', button_href: '#contact' };
    case 'faq':
      return { title: 'FAQ', items: [{ q: 'Question?', a: 'Answer.' }] };
    case 'columns': {
      const cols = clampBlockCols(opts.cols, 2);
      return {
        title: '',
        cols,
        cells: Array.from({ length: cols }, (_, i) => ({
          heading: `Column ${i + 1}`,
          body: 'Add your content.',
        })),
      };
    }
    case 'heading':
      return { heading: 'Heading', level: 2 };
    case 'image':
      return { image: null, caption: '' };
    case 'text':
      return { heading: 'Section heading', body: 'Add your content here.' };
    case 'text_image':
      return {
        heading: 'Section heading',
        body: 'Add your content here.',
        image_position: 'right',
        image: null,
      };
    case 'cards': {
      const cols = clampBlockCols(opts.cols, 3);
      const items = [];
      for (let i = 0; i < cols; i++) {
        items.push({ title: `Card ${i + 1}`, text: 'Short description.' });
      }
      return { title: 'Cards', cols, items };
    }
    case 'section':
      return {
        html:
          '<section class="ws-page-section" data-ws-page-section="1">' +
          '<p>Empty section — use Add block.</p></section>',
      };
    case 'html':
      return { html: '<p>Custom HTML block</p>' };
    case 'custom':
    default:
      return { heading: 'New section', body: 'Add your content here.' };
  }
}

/**
 * Insert a content section (custom/services/…) after afterIndex. afterIndex -1 inserts at 0.
 * Skips pinning past footer when present.
 */
function insertContentSection(pages, pageIndex, afterIndex, sectionType, opts = {}) {
  const list = clonePages(pages);
  const pi = Number(pageIndex);
  if (!Number.isInteger(pi) || pi < 0 || pi >= list.length) {
    return { pages: list, changed: false };
  }
  const page = list[pi];
  if (!page || !Array.isArray(page.sections) || !page.sections.length) {
    return { pages: list, changed: false, reason: 'no_sections' };
  }
  let type = String(sectionType || 'custom').toLowerCase() || 'custom';
  // Empty page section container (Page → Section → Block model).
  if (type === 'section' || type === 'page_section' || type === 'page-section') {
    type = 'html';
    opts = Object.assign({}, opts, {
      html:
        opts.html ||
        '<section class="ws-page-section" data-ws-page-section="1">' +
          '<p>Empty section — use Add block.</p></section>',
    });
  }
  if (PINNED_SECTION_TYPES.has(type) || type === 'footer' || type === 'nav') {
    return { pages: list, changed: false, reason: 'pinned_type' };
  }
  page.sections = ensureNavFirstSections(page.sections);
  // Never insert above nav — afterIndex -1 lands right after nav when present.
  let insertAt = Math.max(0, Math.min(Number(afterIndex) + 1, page.sections.length));
  if (page.sections[0] && isNavSection(page.sections[0]) && insertAt < 1) insertAt = 1;
  const footerAt = page.sections.findIndex((s) => s && s.type === 'footer');
  let at = insertAt;
  if (footerAt >= 0 && at > footerAt) at = footerAt;
  let content =
    opts.content && typeof opts.content === 'object'
      ? Object.assign({}, opts.content)
      : defaultSectionContent(type, opts);
  if (opts.html != null && type === 'html') content.html = String(opts.html);
  page.sections.splice(at, 0, { type, content });
  page.sections = ensureNavFirstSections(page.sections);
  // Drop legacy freeform so modular sections become the source of truth.
  if (typeof page.html === 'string') delete page.html;
  list[pi] = page;
  return { pages: list, changed: true, sectionIndex: at };
}

/**
 * Insert a content/layout/widget block into (or after) a section.
 * Nesting: Page → Section → Block; optional cellIndex for columns cells.
 * For modular typed sections, inserts a sibling section (the block) after sectionIndex.
 * For html/custom freestyle bodies, appends block markup inside the section HTML when possible.
 */
function insertBlockIntoSection(pages, pageIndex, sectionIndex, blockType, opts = {}) {
  const list = clonePages(pages);
  const pi = Number(pageIndex);
  const si = Number(sectionIndex);
  if (!Number.isInteger(pi) || pi < 0 || pi >= list.length) {
    return { pages: list, changed: false, reason: 'bad_page' };
  }
  const page = list[pi];
  if (!page || !Array.isArray(page.sections) || !page.sections.length) {
    return { pages: list, changed: false, reason: 'no_sections' };
  }
  if (!Number.isInteger(si) || si < 0 || si >= page.sections.length) {
    return { pages: list, changed: false, reason: 'bad_section' };
  }
  const type = String(blockType || opts.type || '')
    .trim()
    .toLowerCase();
  if (!type) return { pages: list, changed: false, reason: 'block_type_required' };
  if (PINNED_SECTION_TYPES.has(type) || type === 'footer' || type === 'nav' || type === 'section') {
    return { pages: list, changed: false, reason: 'invalid_block' };
  }

  const host = page.sections[si];
  const cellIndex = opts.cellIndex != null ? Number(opts.cellIndex) : null;
  const content = opts.content && typeof opts.content === 'object' ? opts.content : defaultSectionContent(type, opts);

  // Inject into a columns cell when requested.
  if (Number.isInteger(cellIndex) && cellIndex >= 0 && host && host.type === 'columns') {
    const cells = Array.isArray(host.content && host.content.cells) ? host.content.cells.slice() : [];
    while (cells.length <= cellIndex) cells.push({ heading: '', body: '' });
    const cell = Object.assign({}, cells[cellIndex] || {});
    // First-class module/form widgets in a cell (native mounts — no body CSS hacks).
    if (
      type === 'module' ||
      type === 'site_module' ||
      type === 'widget' ||
      type === 'form' ||
      type === 'bitpype_form'
    ) {
      const widgetType = type === 'form' || type === 'bitpype_form' ? 'form' : 'site_module';
      const widget = Object.assign(
        {},
        content && typeof content === 'object' ? content : {},
        opts.widget && typeof opts.widget === 'object' ? opts.widget : {},
        { type: widgetType }
      );
      if (opts.html) widget.html = String(opts.html);
      cell.widget = widget;
      if (widget.html) cell.html = String(widget.html);
      // Clear competing text so the cell is the widget.
      cell.heading = '';
      cell.body = '';
    } else if (type === 'html' && content.html) {
      cell.html = content.html;
      delete cell.widget;
    } else if (type === 'heading') {
      cell.heading = content.heading || content.title || 'Heading';
      delete cell.widget;
    } else if (type === 'text') {
      cell.heading = content.heading || cell.heading || '';
      cell.body = content.body || content.text || 'Add your content.';
      delete cell.widget;
    } else if (type === 'image' && content.image) {
      cell.image = content.image;
      if (content.image && content.image.crop) cell.crop = content.image.crop;
      delete cell.widget;
    } else if (opts.html) {
      cell.html = String(opts.html);
    } else {
      cell.heading = content.heading || content.title || cell.heading || '';
      cell.body = content.body || content.text || cell.body || '';
    }
    cells[cellIndex] = cell;
    host.content = Object.assign({}, host.content || {}, { cells });
    list[pi] = page;
    return { pages: list, changed: true, sectionIndex: si, cellIndex };
  }

  // Freestyle html section: append rendered block or raw html inside first ws-page-section.
  if (
    host &&
    host.type === 'html' &&
    host.content &&
    typeof host.content.html === 'string' &&
    (opts.html || type === 'html')
  ) {
    const blockHtml =
      opts.html != null
        ? String(opts.html)
        : content.html || `<div class="ws-block" data-ws-block="${type}"><p>${type}</p></div>`;
    let html = host.content.html;
    if (/<\/section>/i.test(html) && /ws-page-section/i.test(html)) {
      html = html.replace(/<\/section>/i, `${blockHtml}</section>`);
    } else {
      html = `${html}\n${blockHtml}`;
    }
    host.content = Object.assign({}, host.content, { html });
    list[pi] = page;
    return { pages: list, changed: true, sectionIndex: si };
  }

  // Default: insert typed block as a sibling section after the host (modular pages).
  return insertContentSection(list, pi, si, type, Object.assign({}, opts, { content }));
}

/**
 * Insert a site_module section after afterIndex (between sections). afterIndex -1 inserts at 0.
 */
function insertModuleSection(pages, pageIndex, afterIndex, moduleContent) {
  const list = clonePages(pages);
  const pi = Number(pageIndex);
  if (!Number.isInteger(pi) || pi < 0 || pi >= list.length) {
    return { pages: list, changed: false };
  }
  const page = list[pi];
  if (!page || !Array.isArray(page.sections) || !page.sections.length) {
    return { pages: list, changed: false, reason: 'no_sections' };
  }
  const content = moduleContent && typeof moduleContent === 'object' ? moduleContent : {};
  const token = String(content.public_token || content.publicToken || '').trim();
  const moduleType = String(content.module_type || content.moduleType || '').trim();
  if (!token || !moduleType) return { pages: list, changed: false, reason: 'invalid_module' };

  const insertAt = Math.max(0, Math.min(Number(afterIndex) + 1, page.sections.length));
  const footerAt = page.sections.findIndex((s) => s && s.type === 'footer');
  let at = insertAt;
  if (footerAt >= 0 && at > footerAt) at = footerAt;

  // Prefer Page → Section → Block: wrap the live widget inside a ws-page-section.
  const apiBase = content.api_base || content.apiBase || '';
  const title = content.title || moduleType;
  const embedDiv =
    `<div class="bitpype-module-embed" data-bitpype-module="1" ` +
    `data-bitpype-module-type="${String(moduleType).replace(/"/g, '')}" ` +
    `data-bitpype-module-token="${String(token).replace(/"/g, '')}"` +
    (apiBase ? ` data-bitpype-api="${String(apiBase).replace(/"/g, '')}"` : '') +
    ` data-bitpype-hide-title="1"></div>`;
  const section = {
    type: 'html',
    content: {
      html:
        `<section class="ws-page-section" data-ws-page-section="1">` +
        `<h2>${String(title).replace(/</g, '&lt;')}</h2>${embedDiv}</section>`,
      module_type: moduleType,
      public_token: token,
      api_base: apiBase,
      title,
    },
  };
  page.sections.splice(at, 0, section);
  page.sections = ensureNavFirstSections(page.sections);
  // Drop legacy freeform so modular sections become the source of truth.
  if (typeof page.html === 'string') delete page.html;
  list[pi] = page;
  return { pages: list, changed: true, sectionIndex: at };
}

/**
 * Add a page with a nav entry (pages[] drives menu). Structured sites clone nav/footer shell.
 */
function createClientPage(pages, opts = {}) {
  const list = clonePages(pages);
  const title = String(opts.title || '')
    .trim()
    .slice(0, 120);
  if (!title) return { pages: list, changed: false, reason: 'title_required' };

  let slug = opts.slug != null ? String(opts.slug).trim() : titleToPageSlug(title);
  slug = ensureUniquePageSlug(list, slug);

  const structured = list.some((p) => Array.isArray(p.sections) && p.sections.length);
  const home = list.find((p, i) => isHomeLike(p, list)) || list[0];

  if (structured && home && Array.isArray(home.sections) && home.sections.length) {
    const navSec = home.sections.find((s) => s && s.type === 'nav');
    const footerSec = home.sections.find((s) => s && s.type === 'footer');
    const sections = [];
    if (navSec) sections.push(JSON.parse(JSON.stringify(navSec)));
    // Page title as custom heading; body invites edit-mode / structure “+” sections.
    sections.push({
      type: 'custom',
      content: {
        heading: title,
        body: 'Add your content here. Use + to add another section.',
      },
    });
    if (footerSec) sections.push(JSON.parse(JSON.stringify(footerSec)));
    list.push({ slug, title, sections, navVisible: opts.navVisible !== false });
  } else {
    const shellHtml = typeof opts.shellHtml === 'string' ? opts.shellHtml : '';
    const inner =
      typeof opts.pageInner === 'string' && opts.pageInner.trim()
        ? opts.pageInner
        : typeof opts.defaultInner === 'function'
          ? opts.defaultInner(title)
          : `<h1 class="bp-mod-page-title">${escapeHtml(title)}</h1>` +
            `<section class="ws-page-section" data-ws-page-section="1">` +
            `<h2>Add your content here.</h2>` +
            `<p>Write this section, or use + to add another.</p>` +
            `</section>`;
    let html;
    if (shellHtml.trim() && typeof opts.fillShellMain === 'function') {
      html = opts.fillShellMain(shellHtml, inner);
    } else if (shellHtml.trim()) {
      html = shellHtml;
    } else {
      html = `<main class="bp-mod-main page">${inner}</main>`;
    }
    list.push({ slug, title, html, sections: [], navVisible: opts.navVisible !== false });
  }

  const next = syncFreeformNavOrder(list);
  return { pages: next, changed: true, pageIndex: next.length - 1, slug, title };
}

/** Swap adjacent items only when both ends are allowed to move. */
function moveItem(list, from, dir, canMove) {
  const arr = Array.isArray(list) ? list.slice() : [];
  const i = Number(from);
  const d = Number(dir) < 0 ? -1 : 1;
  const j = i + d;
  if (!Number.isInteger(i) || i < 0 || i >= arr.length) return { list: arr, changed: false };
  if (j < 0 || j >= arr.length) return { list: arr, changed: false };
  if (typeof canMove === 'function') {
    if (!canMove(arr[i], i) || !canMove(arr[j], j)) return { list: arr, changed: false };
  }
  const tmp = arr[i];
  arr[i] = arr[j];
  arr[j] = tmp;
  return { list: arr, changed: true };
}

/**
 * Rebuild pages[] in visual DFS order so sibling order matches the menu.
 * Preserves page objects (with updated menuParent).
 */
function flattenMenuToPages(pages, visualIndices) {
  const list = Array.isArray(pages) ? pages : [];
  const seen = new Set();
  const out = [];
  visualIndices.forEach((i) => {
    if (!Number.isInteger(i) || i < 0 || i >= list.length || seen.has(i)) return;
    seen.add(i);
    out.push(list[i]);
  });
  list.forEach((p, i) => {
    if (!seen.has(i)) out.push(p);
  });
  return out;
}

function reorderMenu(pages, fromIndex, direction) {
  const list = clonePages(pages);
  const visual = menuVisualList(list);
  const vi = visual.findIndex((v) => v.index === Number(fromIndex));
  if (vi < 0) return { pages: list, changed: false };
  const item = visual[vi];
  if (item.pinned) return { pages: list, changed: false };
  const d = Number(direction) < 0 ? -1 : 1;
  const vj = vi + d;
  if (vj < 0 || vj >= visual.length) return { pages: list, changed: false };
  const other = visual[vj];
  if (other.depth !== item.depth) return { pages: list, changed: false };
  if (String(other.parentSlug || '') !== String(item.parentSlug || '')) return { pages: list, changed: false };
  if (other.pinned) return { pages: list, changed: false };

  // Swap visual siblings; when moving a top-level parent, keep its children glued after it.
  const order = visual.map((v) => v.index);
  if (item.depth === 0) {
    // Build blocks: each top + its following depth-1 children
    const blocks = [];
    for (let i = 0; i < visual.length; ) {
      if (visual[i].depth !== 0) {
        i += 1;
        continue;
      }
      const block = [visual[i].index];
      let j = i + 1;
      while (j < visual.length && visual[j].depth === 1) {
        block.push(visual[j].index);
        j += 1;
      }
      blocks.push({ start: i, indices: block, pinned: visual[i].pinned });
      i = j;
    }
    const bi = blocks.findIndex((b) => b.indices[0] === item.index);
    const bj = bi + d;
    if (bi < 0 || bj < 0 || bj >= blocks.length) return { pages: list, changed: false };
    if (blocks[bi].pinned || blocks[bj].pinned) return { pages: list, changed: false };
    const tmp = blocks[bi];
    blocks[bi] = blocks[bj];
    blocks[bj] = tmp;
    const flat = [];
    blocks.forEach((b) => flat.push(...b.indices));
    const next = flattenMenuToPages(list, flat);
    return { pages: syncFreeformNavOrder(next), changed: true };
  }

  // Child: swap with adjacent sibling in order array
  const tmp = order[vi];
  order[vi] = order[vj];
  order[vj] = tmp;
  const next = flattenMenuToPages(list, order);
  return { pages: syncFreeformNavOrder(next), changed: true };
}

function nestMenuItem(pages, fromIndex) {
  const list = clonePages(pages);
  const visual = menuVisualList(list);
  const vi = visual.findIndex((v) => v.index === Number(fromIndex));
  if (vi <= 0) return { pages: list, changed: false };
  const item = visual[vi];
  if (item.pinned || item.depth >= MAX_MENU_DEPTH) return { pages: list, changed: false };

  // Previous visual item: if child, use its parent; if top, use it.
  const prev = visual[vi - 1];
  let parentSlug = null;
  if (prev.depth === 0 && !prev.pinned) parentSlug = prev.slug;
  else if (prev.depth === 1 && prev.parentSlug) parentSlug = prev.parentSlug;
  if (!parentSlug) return { pages: list, changed: false };
  if (slugKey(parentSlug) === pageSlugKey(list[item.index])) return { pages: list, changed: false };

  list[item.index] = setMenuParent(list[item.index], parentSlug);
  // Place nested item immediately after parent block start (after parent, among children).
  const parentIdx = list.findIndex((p) => pageSlugKey(p) === slugKey(parentSlug));
  if (parentIdx < 0) return { pages: list, changed: false };
  const moving = list[item.index];
  // Rebuild visual after parent assign, then flatten.
  const nextVisual = menuVisualList(list);
  const flat = nextVisual.map((v) => v.index);
  // Ensure the nested page sits with its siblings after parent:
  const without = flat.filter((i) => i !== item.index);
  const pPos = without.indexOf(parentIdx);
  if (pPos < 0) return { pages: list, changed: false };
  // Insert after existing children of this parent already in without
  let insertAt = pPos + 1;
  while (insertAt < without.length && menuParentKey(list[without[insertAt]]) === slugKey(parentSlug)) {
    insertAt += 1;
  }
  without.splice(insertAt, 0, item.index);
  list[item.index] = moving;
  const next = flattenMenuToPages(list, without);
  return { pages: syncFreeformNavOrder(next), changed: true };
}

function unnestMenuItem(pages, fromIndex) {
  const list = clonePages(pages);
  const visual = menuVisualList(list);
  const vi = visual.findIndex((v) => v.index === Number(fromIndex));
  if (vi < 0) return { pages: list, changed: false };
  const item = visual[vi];
  if (item.pinned || item.depth <= 0) return { pages: list, changed: false };
  list[item.index] = setMenuParent(list[item.index], null);
  // Place right after former parent's block
  const nextVisual = menuVisualList(list);
  const flat = nextVisual.map((v) => v.index);
  const next = flattenMenuToPages(list, flat);
  return { pages: syncFreeformNavOrder(next), changed: true };
}

function toggleNavVisibility(pages, fromIndex) {
  const list = clonePages(pages);
  const i = Number(fromIndex);
  if (!Number.isInteger(i) || i < 0 || i >= list.length) return { pages: list, changed: false };
  if (isHomeLike(list[i], list)) return { pages: list, changed: false };
  const nextVisible = !isNavVisible(list[i]);
  list[i] = setNavVisible(list[i], nextVisible);
  return { pages: syncFreeformNavOrder(list), changed: true };
}

function applyMenuAction(pages, body = {}) {
  const action = String(body.action || 'move').toLowerCase();
  const fromIndex = Number(body.fromIndex);
  if (!Number.isInteger(fromIndex) || fromIndex < 0) {
    return { pages: clonePages(pages), changed: false };
  }
  if (action === 'nest' || action === 'indent') return nestMenuItem(pages, fromIndex);
  if (action === 'unnest' || action === 'outdent') return unnestMenuItem(pages, fromIndex);
  if (action === 'togglenav' || action === 'toggle-nav' || action === 'toggle_nav') {
    return toggleNavVisibility(pages, fromIndex);
  }
  const direction = Number(body.direction);
  if (direction !== 1 && direction !== -1) return { pages: clonePages(pages), changed: false };
  return reorderMenu(pages, fromIndex, direction);
}

function reorderSections(pages, pageIndex, fromIndex, direction) {
  const list = clonePages(pages);
  const pi = Number(pageIndex);
  if (!Number.isInteger(pi) || pi < 0 || pi >= list.length) {
    return { pages: list, changed: false };
  }
  const page = list[pi];
  if (!page || !Array.isArray(page.sections) || !page.sections.length) {
    return { pages: list, changed: false };
  }
  const { list: secs, changed } = moveItem(page.sections, fromIndex, direction, (sec) => !isPinnedSection(sec));
  if (!changed) return { pages: list, changed: false };
  page.sections = ensureNavFirstSections(secs);
  list[pi] = page;
  return { pages: list, changed: true };
}

/**
 * Build nav link tree for structured render (and MCP).
 * opts.preview → #anchor hrefs; else the canonical URL path (Batch 31:
 * extensionless dash form — the ONE internal-link form everywhere).
 */
function buildNavLinks(pages, opts = {}) {
  const list = Array.isArray(pages) ? pages : [];
  const preview = !!opts.preview;
  const visual = menuVisualList(list);
  const links = [];
  visual.forEach((item) => {
    if (item.depth !== 0) return;
    const page = list[item.index];
    if (!isNavVisible(page)) return;
    const href = preview
      ? `#${engine.anchorId ? engine.anchorId(item.slug) : String(item.slug || 'home').replace(/^\//, '')}`
      : engine.pageUrlPath(item.slug);
    let anchorHref = href;
    try {
      anchorHref = preview ? `#${require('./websiteEngine').anchorId(item.slug)}` : engine.pageUrlPath(item.slug);
    } catch {
      anchorHref = href;
    }
    const children = visual
      .filter(
        (c) =>
          c.depth === 1 && slugKey(c.parentSlug) === pageSlugKey({ slug: item.slug }) && isNavVisible(list[c.index])
      )
      .map((c) => ({
        label: c.title,
        href: preview
          ? `#${(() => {
              try {
                return engine.anchorId(c.slug);
              } catch {
                return String(c.slug || '').replace(/^\//, '');
              }
            })()}`
          : engine.pageUrlPath(c.slug),
        slug: c.slug,
      }));
    links.push({
      label: item.title,
      href: anchorHref,
      slug: item.slug,
      children,
    });
  });
  return links;
}

/**
 * Footer link tree — the FULL page set.
 *
 * Chrome rule (nav vs footer): both lists are built from the same pages[]
 * in the same syncFreeformNavOrder pass. The primary nav (buildNavLinks)
 * shows the navVisible subset — navVisible:false hides a page from the nav
 * only. The footer shows every depth-0 page and its children, INCLUDING
 * navVisible:false pages (the FAQ page belongs in the footer by platform
 * convention) and pages inserted by modules (Shop, Blog, …), so a module
 * page can never appear in the nav while missing from the footer.
 * opts.excludeSlugs (slugs in any form) drops pages the caller hid during
 * this same sync — syncSiteModuleEmbeds passes module shells whose module
 * is inactive, which must leave BOTH chrome lists.
 */
function buildFooterLinks(pages, opts = {}) {
  const list = Array.isArray(pages) ? pages : [];
  const exclude = new Set((Array.isArray(opts.excludeSlugs) ? opts.excludeSlugs : []).map((s) => slugKey(s)));
  const visual = menuVisualList(list);
  const links = [];
  visual.forEach((item) => {
    if (item.depth !== 0) return;
    if (exclude.has(slugKey(item.slug))) return;
    const children = visual
      .filter((c) => c.depth === 1 && slugKey(c.parentSlug) === pageSlugKey({ slug: item.slug }))
      .filter((c) => !exclude.has(slugKey(c.slug)))
      .map((c) => ({ label: c.title, href: engine.pageUrlPath(c.slug), slug: c.slug }));
    links.push({ label: item.title, href: engine.pageUrlPath(item.slug), slug: item.slug, children });
  });
  return links;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderNavLinksHtml(links, { asList } = {}) {
  const items = Array.isArray(links) ? links : [];
  if (asList) {
    return `<ul class="nav-menu">${items
      .map((l) => {
        const kids = Array.isArray(l.children) ? l.children : [];
        const sub = kids.length
          ? `<ul class="nav-sub">${kids
              .map((c) => `<li><a href="${escapeHtml(c.href || '#')}">${escapeHtml(c.label || '')}</a></li>`)
              .join('')}</ul>`
          : '';
        const cls = kids.length ? ' class="has-children"' : '';
        return `<li${cls}><a href="${escapeHtml(l.href || '#')}">${escapeHtml(l.label || '')}</a>${sub}</li>`;
      })
      .join('')}</ul>`;
  }
  return items
    .map((l) => {
      const kids = Array.isArray(l.children) ? l.children : [];
      if (!kids.length) {
        return `<a href="${escapeHtml(l.href || '#')}">${escapeHtml(l.label || '')}</a>`;
      }
      const sub = kids.map((c) => `<a href="${escapeHtml(c.href || '#')}">${escapeHtml(c.label || '')}</a>`).join('');
      return `<span class="nav-item has-children"><a href="${escapeHtml(l.href || '#')}">${escapeHtml(l.label || '')}</a><span class="nav-sub">${sub}</span></span>`;
    })
    .join('\n');
}

function buildPageHrefIndex(pages) {
  const list = Array.isArray(pages) ? pages : [];
  const byFile = new Map();
  const byAnchor = new Map();
  list.forEach((p, i) => {
    const file = engine.pageFileName(p.slug).toLowerCase();
    byFile.set(file, i);
    const bare = file.replace(/\.html$/i, '');
    if (bare && bare !== file) byFile.set(bare, i);
    // Batch 31: canonical URL path + legacy underscore filename spellings
    // resolve to the same page, so nav sync recognizes every form.
    try {
      const canon = engine.pageUrlPath(p.slug).replace(/^\//, '').toLowerCase();
      if (canon) {
        byFile.set(canon, i);
        byFile.set(`${canon}.html`, i);
      }
      const legacy = engine.legacyPageFileName(p.slug).toLowerCase();
      byFile.set(legacy, i);
      const legacyBare = legacy.replace(/\.html$/i, '');
      if (legacyBare && legacyBare !== legacy) byFile.set(legacyBare, i);
    } catch {
      /* optional */
    }
    try {
      const aid = String(engine.anchorId(p.slug) || '').toLowerCase();
      if (aid) byAnchor.set(aid, i);
    } catch {
      /* optional */
    }
    const sk = slugKey(p.slug);
    if (sk) byAnchor.set(sk, i);
  });
  const homeIdx = list.findIndex((p) => isHomeLike(p, list));
  if (homeIdx >= 0) {
    byFile.set('index.html', homeIdx);
    byAnchor.set('home', homeIdx);
    byAnchor.set('index', homeIdx);
  }
  return { byFile, byAnchor, multipage: list.length >= 2 };
}

function hrefPageIndex(href, hrefIndex) {
  const h = String(href || '').trim();
  if (!h || /^(mailto:|tel:|javascript:|https?:|\/\/)/i.test(h)) return null;
  let pathPart = h;
  let hashPart = '';
  if (h.includes('#')) {
    const parts = h.split('#');
    pathPart = parts[0];
    hashPart = slugKey(parts.slice(1).join('#'));
  }
  let bare = String(pathPart || '')
    .replace(/^\.\//, '')
    .split('?')[0]
    .toLowerCase();
  if (bare.startsWith('/')) bare = bare.slice(1);
  // Bare "/" / "" / home / index → home page file.
  let route = '';
  try {
    route = engine.normalizeRoute ? engine.normalizeRoute(h) : '';
  } catch {
    route = '';
  }
  if (!bare || bare === 'home' || bare === 'index' || route === 'index') {
    if (hrefIndex.byFile.has('index.html')) return hrefIndex.byFile.get('index.html');
    if (hrefIndex.byAnchor.has('home')) return hrefIndex.byAnchor.get('home');
    if (hrefIndex.byAnchor.has('index')) return hrefIndex.byAnchor.get('index');
  }
  if (bare && hrefIndex.byFile.has(bare)) return hrefIndex.byFile.get(bare);
  if (bare && !bare.endsWith('.html') && hrefIndex.byFile.has(`${bare}.html`)) {
    return hrefIndex.byFile.get(`${bare}.html`);
  }
  if (hashPart && hrefIndex.byAnchor.has(hashPart)) return hrefIndex.byAnchor.get(hashPart);
  if (h.charAt(0) === '#' && h.length > 1) {
    const id = slugKey(h.slice(1));
    if (hrefIndex.byAnchor.has(id)) return hrefIndex.byAnchor.get(id);
  }
  return null;
}

function isManagedModuleNavLink(linkHtml) {
  return /data-bitpype-module-nav/i.test(String(linkHtml || ''));
}

function keepNonPageNavLink(linkHtml, hrefIndex) {
  if (isManagedModuleNavLink(linkHtml)) return true;
  if (!hrefIndex.multipage) return true;
  const hm = String(linkHtml || '').match(/\bhref\s*=\s*["']([^"']+)["']/i);
  if (!hm) return true;
  return hrefPageIndex(hm[1], hrefIndex) == null;
}

/** Fallback when primary nav heuristics miss: rewrite whole <nav> inner. */
function syncLegacyNavTags(html, navLinks, list, fileSet, hrefIndex) {
  return String(html || '').replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi, (navBlock) => {
    const openEnd = navBlock.indexOf('>') + 1;
    const closeStart = navBlock.lastIndexOf('</');
    if (openEnd <= 0 || closeStart <= openEnd) return navBlock;
    const open = navBlock.slice(0, openEnd);
    const close = navBlock.slice(closeStart);
    const inner = navBlock.slice(openEnd, closeStart);
    const linkRe = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>[\s\S]*?<\/a>/gi;
    const pageLinks = new Map();
    const other = [];
    let m;
    while ((m = linkRe.exec(inner))) {
      const href = String(m[1] || '').trim();
      const pi = hrefPageIndex(href, hrefIndex);
      if (pi != null) {
        const file = engine.pageFileName(list[pi].slug).toLowerCase();
        if (!pageLinks.has(file)) pageLinks.set(file, m[0]);
      } else {
        other.push(m[0]);
      }
    }
    if (!pageLinks.size) return navBlock;

    const useList = /<ul\b/i.test(inner);
    const resolveLink = (file, label) => {
      const existing = pageLinks.get(String(file || '').toLowerCase());
      if (existing) return existing;
      // Fresh anchors use the canonical URL path (Batch 31).
      const slugGuess = String(file || '').replace(/\.html$/i, '');
      const href = slugGuess === 'index' || slugGuess === '' ? '/' : `/${slugGuess.replace(/^\/+/, '')}`;
      return `<a href="${escapeHtml(href)}">${escapeHtml(label || file)}</a>`;
    };
    const filteredOther = other.filter((chunk) => keepNonPageNavLink(chunk, hrefIndex));

    let rebuilt;
    if (useList) {
      rebuilt = `<ul class="nav-menu">${navLinks
        .map((l) => {
          const kids = Array.isArray(l.children) ? l.children : [];
          const sub = kids.length
            ? `<ul class="nav-sub">${kids
                .map((c) => `<li>${resolveLink(engine.pageFileName(c.slug), c.label)}</li>`)
                .join('')}</ul>`
            : '';
          const cls = kids.length ? ' class="has-children"' : '';
          return `<li${cls}>${resolveLink(engine.pageFileName(l.slug), l.label)}${sub}</li>`;
        })
        .join('')}</ul>`;
      if (filteredOther.length) rebuilt += filteredOther.join(' ');
    } else {
      const parts = navLinks.map((l) => {
        const kids = Array.isArray(l.children) ? l.children : [];
        const top = resolveLink(engine.pageFileName(l.slug), l.label);
        if (!kids.length) return top;
        const sub = kids.map((c) => resolveLink(engine.pageFileName(c.slug), c.label)).join('');
        return `<span class="nav-item has-children">${top}<span class="nav-sub">${sub}</span></span>`;
      });
      rebuilt = parts.concat(filteredOther).join(/\n/.test(inner) ? '\n' : ' ');
    }
    return open + rebuilt + close;
  });
}

/**
 * Reorder / hide menu links in freeform HTML to match pages[] (menuParent + navVisible).
 * Uses primary header/nav detection (same as module nav); falls back to bare <nav> rewrite.
 */
function syncFreeformNavOrder(pages, opts = {}) {
  let list = Array.isArray(pages) ? pages : [];
  if (!list.length) return list;
  if (list.length >= 2 && typeof engine.normalizePagesNavLinks === 'function') {
    list = engine.normalizePagesNavLinks(list);
  }
  const fileOrder = list.map((p) => engine.pageFileName(p.slug).toLowerCase());
  const fileSet = new Set(fileOrder);
  const hrefIndex = buildPageHrefIndex(list);
  const navLinks = buildNavLinks(list, { preview: false });
  const footerLinks = buildFooterLinks(list, { excludeSlugs: opts.footerExcludeSlugs });
  const rebuildOpts = {
    activeModules: Array.isArray(opts.activeModules) ? opts.activeModules : [],
  };
  let rebuildPrimary = null;
  let rebuildFooter = null;
  try {
    const siteModules = require('../server/siteModules');
    rebuildPrimary = siteModules.rebuildFreeformPrimaryNav;
    rebuildFooter = siteModules.rebuildFreeformFooterLinks;
  } catch {
    /* electron / tests without server */
  }

  // Optional telemetry (opts.report): callers pass a report object and get
  // back what normalization actually did — which page links were inserted /
  // removed / deduped across nav + footer, and how many pages changed.
  // Counting is keyed by target page (via hrefIndex), not raw href text, so
  // '#anchor' → file rewrites from normalizePagesNavLinks don't read as churn.
  const report = opts.report && typeof opts.report === 'object' ? opts.report : null;
  if (report) {
    if (!(report.inserted instanceof Set)) report.inserted = new Set();
    if (!(report.removed instanceof Set)) report.removed = new Set();
    if (!(report.touchedPages instanceof Set)) report.touchedPages = new Set();
    if (typeof report.deduped !== 'number') report.deduped = 0;
  }
  const pageTargetCounts = (html) => {
    const counts = new Map();
    const re = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi;
    let m;
    const s = String(html || '');
    while ((m = re.exec(s))) {
      const pi = hrefPageIndex(m[1], hrefIndex);
      if (pi != null) counts.set(pi, (counts.get(pi) || 0) + 1);
    }
    return counts;
  };
  const noteChunk = (pageIndex, beforeHtml, afterHtml) => {
    if (!report || beforeHtml === afterHtml) return;
    const before = pageTargetCounts(beforeHtml);
    const after = pageTargetCounts(afterHtml);
    // pagesChanged counts pages whose link SET changed; the rebuild
    // re-renders chrome markup every pass, so byte churn alone is not a change.
    let linkChanged = false;
    for (const pi of new Set([...before.keys(), ...after.keys()])) {
      const b = before.get(pi) || 0;
      const a = after.get(pi) || 0;
      if (a === b) continue;
      linkChanged = true;
      const file = fileOrder[pi];
      if (a > b && b === 0) report.inserted.add(file);
      else if (b > a && a === 0) report.removed.add(file);
      else if (b > a) report.deduped += b - a;
    }
    if (linkChanged) report.touchedPages.add(pageIndex);
  };

  return list.map((page, pageIndex) => {
    if (!page) return page;
    let next = page;
    const hasSections = Array.isArray(page.sections) && page.sections.length > 0;
    const hasHtml = typeof page.html === 'string' && !!page.html.trim();

    if (hasHtml && !hasSections) {
      let html = page.html;
      if (typeof rebuildPrimary === 'function') {
        const rebuilt = rebuildPrimary(html, navLinks, list, rebuildOpts);
        if (rebuilt !== html) {
          next = Object.assign({}, next, { html: rebuilt });
          html = rebuilt;
        }
      }
      const legacy = syncLegacyNavTags(html, navLinks, list, fileSet, hrefIndex);
      if (legacy !== html) {
        next = Object.assign({}, next, { html: legacy });
        html = legacy;
      }
      try {
        const deduped = engine.assertAndDedupeNavHtml(html, `syncFreeformNavOrder:${page.slug || ''}`);
        if (deduped !== html) {
          next = Object.assign({}, next, { html: deduped });
          html = deduped;
        }
      } catch {
        /* optional */
      }
      // Same pass: footer link row follows the footer rule (full page set).
      if (typeof rebuildFooter === 'function') {
        const foot = rebuildFooter(html, footerLinks, list, rebuildOpts);
        if (foot !== html) {
          next = Object.assign({}, next, { html: foot });
          html = foot;
        }
      }
      noteChunk(pageIndex, page.html, html);
    }

    // Freestyle nav chrome lives in sections[nav].content.html on modular sites;
    // footer chrome likewise in sections[footer].content.html — same pass.
    if (hasSections && typeof rebuildPrimary === 'function') {
      let sectionsChanged = false;
      const sections = page.sections.map((sec) => {
        if (!sec || !sec.content || typeof sec.content.html !== 'string') {
          return sec;
        }
        const isNavSec = sec.type === 'nav';
        const isFooterSec = sec.type === 'footer';
        if (!isNavSec && !isFooterSec) return sec;
        let html = sec.content.html;
        if (!html.trim()) return sec;
        if (isNavSec) {
          const rebuilt = rebuildPrimary(html, navLinks, list, rebuildOpts);
          if (rebuilt !== html) html = rebuilt;
          try {
            html = engine.assertAndDedupeNavHtml(html, `syncFreeformNavOrder:nav:${page.slug || ''}`);
          } catch {
            /* optional */
          }
        } else if (typeof rebuildFooter === 'function') {
          const rebuilt = rebuildFooter(html, footerLinks, list, rebuildOpts);
          if (rebuilt !== html) html = rebuilt;
        }
        noteChunk(pageIndex, sec.content.html, html);
        if (html === sec.content.html) return sec;
        sectionsChanged = true;
        return Object.assign({}, sec, {
          content: Object.assign({}, sec.content, { html }),
        });
      });
      if (sectionsChanged) next = Object.assign({}, next, { sections });
    }

    return next;
  });
}

/* ================================================================== */
/* Batch 147 — NATIVE SECTION EDITOR model ops.                        */
/*                                                                     */
/* The portal layout editor edits the page MODEL (the section list)    */
/* — never exported HTML — through these pure ops plus the portal      */
/* wrappers in server/portalSiteChat.js, and saves through the same    */
/* domain.sitesSave path the design payload uses, so editor saves and  */
/* design saves can never diverge.                                     */
/*                                                                     */
/* Structural law enforced here (mirrors the platform's own rules):    */
/*   - nav is locked first, footer is locked last; neither moves,      */
/*     duplicates or deletes (page chrome — one per page).             */
/*   - hero/banner stay pinned in place (PINNED_SECTION_TYPES),        */
/*     exactly as the adjacent-swap reorder has always treated them:   */
/*     a move rearranges only the movable sections among the slots     */
/*     the movable sections already occupy.                            */
/*   - module sections duplicate their section/embed REFERENCE only:   */
/*     site_module_embeds is UNIQUE(lead_id, module_type) and every    */
/*     module's settings/content live in lead-scoped tables, so a      */
/*     duplicate mount renders the same singleton module twice and     */
/*     can never copy or corrupt the singleton row. Module types       */
/*     whose mount must stay singular are fenced below with reasons.   */
/* ================================================================== */

/** Module types whose page mount must never be duplicated. */
const LAYOUT_DUPLICATE_FENCE = {
  chatbot: 'The chat widget is a sitewide overlay — one per site, not a page section you can stack.',
  checkout:
    'Checkout is the site’s single checkout surface — a second mount would render two live checkout forms sharing one cart.',
};

/** Section types the editor never duplicates or deletes (page chrome). */
const LAYOUT_CHROME_TYPES = new Set(['nav', 'footer']);

/** Content section types the ADD palette offers (renderer-backed, with
 *  platform defaults via defaultSectionContent). */
const LAYOUT_CONTENT_TYPES = [
  { type: 'heading', label: 'Heading' },
  { type: 'text', label: 'Text' },
  { type: 'text_image', label: 'Text + image' },
  { type: 'image', label: 'Image' },
  { type: 'hero', label: 'Hero banner' },
  { type: 'benefits', label: 'Benefits' },
  { type: 'services', label: 'Services' },
  { type: 'cards', label: 'Cards' },
  { type: 'columns', label: 'Columns' },
  { type: 'about', label: 'About' },
  { type: 'gallery', label: 'Gallery' },
  { type: 'reviews', label: 'Reviews' },
  { type: 'faq', label: 'FAQ' },
  { type: 'cta', label: 'Call to action' },
  { type: 'html', label: 'Custom HTML' },
];

/** Vertical-padding floor for the layout knob: the tightest edge inset
 *  the Batch 135 spacing guarantee promises anywhere (the mobile
 *  section inset, parsed from the single-sourced tokens block in
 *  public/css/tokens.css — never a hardcoded copy that can drift). */
let _layoutPadFloorCache = null;
function layoutPaddingFloorPx() {
  if (_layoutPadFloorCache != null) return _layoutPadFloorCache;
  let floor = 22;
  try {
    const fs = require('fs');
    const css = fs.readFileSync(require('path').join(__dirname, '..', 'public', 'css', 'tokens.css'), 'utf8');
    const m = /--bp-space-section-inset-mobile\s*:\s*(\d+(?:\.\d+)?)px/.exec(css);
    if (m) floor = Number(m[1]);
  } catch {
    /* tokens unreadable — fall back to the Batch 135 mobile inset */
  }
  _layoutPadFloorCache = floor;
  return floor;
}
const LAYOUT_PADDING_MAX_PX = 160;
/** The renderer base (section.block padding) — what an unset knob means. */
const LAYOUT_PADDING_DEFAULT_PX = 56;

function layoutErr(code, message) {
  return Object.assign(new Error(message), { code });
}

/** Parse a section's inline style string into ordered [prop, value] pairs. */
function parseStyleDecls(style) {
  const out = [];
  if (typeof style !== 'string') return out;
  for (const part of style.split(';')) {
    const idx = part.indexOf(':');
    if (idx <= 0) continue;
    const prop = part.slice(0, idx).trim().toLowerCase();
    const value = part.slice(idx + 1).trim();
    if (prop && value) out.push([prop, value]);
  }
  return out;
}

function styleDeclsToString(decls) {
  return decls.map(([p, v]) => `${p}:${v}`).join(';');
}

/** Current vertical padding (px) written on the section, or null when unset. */
function getSectionPaddingPx(section) {
  if (!section || typeof section !== 'object') return null;
  const decls = parseStyleDecls(typeof section.style === 'string' ? section.style : '');
  let top = null;
  let bottom = null;
  for (const [prop, value] of decls) {
    const m = /^(\d+(?:\.\d+)?)px$/.exec(value);
    if (!m) continue;
    if (prop === 'padding-top') top = Number(m[1]);
    if (prop === 'padding-bottom') bottom = Number(m[1]);
  }
  if (top == null && bottom == null) return null;
  return Math.round(Math.max(top || 0, bottom || 0));
}

/**
 * Write (or clear, with null) the section's vertical padding into the
 * EXISTING section.style field. Sub-floor values are REFUSED, never
 * silently clamped — the Batch 135 floor is platform law.
 */
function setSectionPaddingPx(section, px) {
  if (!section || typeof section !== 'object') throw layoutErr('INVALID', 'Section is required.');
  const rest = parseStyleDecls(typeof section.style === 'string' ? section.style : '').filter(
    ([p]) => p !== 'padding-top' && p !== 'padding-bottom' && p !== 'padding'
  );
  if (px == null) {
    if (rest.length) section.style = styleDeclsToString(rest);
    else delete section.style;
    return section;
  }
  const value = Math.round(Number(px));
  if (!Number.isFinite(value)) throw layoutErr('INVALID_PADDING', 'Padding must be a number of pixels.');
  const floor = layoutPaddingFloorPx();
  if (value < floor) {
    throw layoutErr(
      'PADDING_BELOW_FLOOR',
      `Vertical padding cannot go under ${floor}px — the platform spacing floor keeps text off the section edges.`
    );
  }
  if (value > LAYOUT_PADDING_MAX_PX) {
    throw layoutErr('PADDING_TOO_LARGE', `Vertical padding cannot exceed ${LAYOUT_PADDING_MAX_PX}px.`);
  }
  rest.push(['padding-top', `${value}px`], ['padding-bottom', `${value}px`]);
  section.style = styleDeclsToString(rest);
  return section;
}

const LAYOUT_HEX_RE = /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/;

/** Current background colour from the EXISTING content.backgroundColor field. */
function getSectionBackground(section) {
  const c = section && typeof section === 'object' ? section.content : null;
  if (!c || typeof c !== 'object') return '';
  for (const key of ['backgroundColor', 'background_color', 'bg', 'background']) {
    const v = c[key];
    if (typeof v === 'string' && LAYOUT_HEX_RE.test(v.trim())) return v.trim();
  }
  return '';
}

/** Write (or clear, with '') the section background into content.backgroundColor. */
function setSectionBackground(section, hex) {
  if (!section || typeof section !== 'object') throw layoutErr('INVALID', 'Section is required.');
  if (!section.content || typeof section.content !== 'object') section.content = {};
  const value = String(hex || '').trim();
  if (!value) {
    delete section.content.backgroundColor;
    return section;
  }
  if (!LAYOUT_HEX_RE.test(value)) throw layoutErr('INVALID_COLOR', 'Background must be a hex colour like #1a56db.');
  section.content.backgroundColor = value;
  return section;
}

function sectionTypeOf(section) {
  return String((section && section.type) || '').toLowerCase();
}

function isFooterSection(section) {
  return sectionTypeOf(section) === 'footer';
}

/** A section is movable in the editor unless it is page chrome or a
 *  platform-pinned type (nav/hero/banner) or the footer. */
function isLayoutMovable(section) {
  if (!section || typeof section !== 'object') return false;
  const t = sectionTypeOf(section);
  if (LAYOUT_CHROME_TYPES.has(t)) return false;
  return !PINNED_SECTION_TYPES.has(t);
}

/**
 * Drag-style move to an absolute index. Pinned/chrome sections keep
 * their absolute slots; the movable sections are rearranged among the
 * slots they already occupy (the movable-slot rule — the drag
 * generalization of the adjacent-swap law in reorderSections, so the
 * two UIs can never disagree about what may move where).
 * Returns { sections, changed, reason? } — never mutates the input.
 */
function moveSectionToIndex(sections, fromIndex, toIndex) {
  const list = Array.isArray(sections) ? sections.slice() : [];
  const from = Number(fromIndex);
  const to = Number(toIndex);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from >= list.length) {
    return { sections: list, changed: false, reason: 'out_of_range' };
  }
  if (!isLayoutMovable(list[from])) return { sections: list, changed: false, reason: 'locked' };
  const slots = [];
  const movable = [];
  list.forEach((s, i) => {
    if (isLayoutMovable(s)) {
      slots.push(i);
      movable.push(s);
    }
  });
  const fromSlot = slots.indexOf(from);
  // Target is expressed as an absolute index; translate to the nearest
  // movable slot at or before it (dropping "after the footer" lands on
  // the last movable slot, never past the footer).
  let toSlot = 0;
  slots.forEach((slotIdx, k) => {
    if (slotIdx <= to) toSlot = k;
  });
  if (fromSlot < 0 || fromSlot === toSlot) return { sections: list, changed: false, reason: 'no_move' };
  const [moved] = movable.splice(fromSlot, 1);
  movable.splice(toSlot, 0, moved);
  slots.forEach((slotIdx, k) => {
    list[slotIdx] = movable[k];
  });
  return { sections: list, changed: true };
}

/** Fresh identity for a duplicated section: the rendered element id
 *  (section.id) and in-section anchors must not collide on the page. */
function freshenSectionIdentity(pageSections, copy) {
  const used = new Set();
  for (const s of pageSections || []) {
    if (s && typeof s.id === 'string' && s.id) used.add(s.id);
    const anchor = s && s.content && typeof s.content.anchorId === 'string' ? s.content.anchorId : '';
    if (anchor) used.add(anchor);
  }
  const freshen = (base) => {
    const stem =
      String(base || 'section')
        .replace(/[^a-zA-Z0-9_-]/g, '')
        .slice(0, 48) || 'section';
    let candidate = `${stem}-copy`;
    let n = 2;
    while (used.has(candidate)) {
      candidate = `${stem}-copy-${n}`;
      n += 1;
    }
    used.add(candidate);
    return candidate;
  };
  if (typeof copy.id === 'string' && copy.id) copy.id = freshen(copy.id);
  if (
    copy.content &&
    typeof copy.content === 'object' &&
    typeof copy.content.anchorId === 'string' &&
    copy.content.anchorId
  ) {
    copy.content.anchorId = freshen(copy.content.anchorId);
  }
  return copy;
}

/**
 * Duplicate a section in place (copy lands directly after the source).
 * Deep-copies the section object with a fresh identity. For module
 * sections the copy keeps the same embed reference (public_token /
 * module mount html) — the singleton embed row and the module's
 * settings/content rows are never read or written here. Fenced:
 * page chrome (nav/footer) and LAYOUT_DUPLICATE_FENCE module types.
 * `moduleType` is the section's resolved module type, when any.
 */
function duplicateSectionAt(sections, index, moduleType) {
  const list = Array.isArray(sections) ? sections.slice() : [];
  const at = Number(index);
  if (!Number.isInteger(at) || at < 0 || at >= list.length) {
    return { sections: list, changed: false, reason: 'out_of_range' };
  }
  const source = list[at];
  const t = sectionTypeOf(source);
  if (LAYOUT_CHROME_TYPES.has(t)) {
    return {
      sections: list,
      changed: false,
      reason: 'chrome',
      message: 'Page chrome (menu/footer) exists once per page and cannot be duplicated.',
    };
  }
  const mt = String(moduleType || '').toLowerCase();
  if (mt && LAYOUT_DUPLICATE_FENCE[mt]) {
    return { sections: list, changed: false, reason: 'fenced_module', message: LAYOUT_DUPLICATE_FENCE[mt] };
  }
  const copy = JSON.parse(JSON.stringify(source));
  freshenSectionIdentity(list, copy);
  list.splice(at + 1, 0, copy);
  return { sections: list, changed: true, sectionIndex: at + 1, section: copy };
}

/**
 * Remove a section from the page model. Module DATA is never touched:
 * removing a module section unpublishes that mount from the page (the
 * portal save wrapper unpublishes the embed itself when a module's
 * last mount leaves the site — mirrors detachModule's flags). Page
 * chrome (nav/footer) cannot be removed.
 */
function removeSectionAt(sections, index) {
  const list = Array.isArray(sections) ? sections.slice() : [];
  const at = Number(index);
  if (!Number.isInteger(at) || at < 0 || at >= list.length) {
    return { sections: list, changed: false, reason: 'out_of_range' };
  }
  if (LAYOUT_CHROME_TYPES.has(sectionTypeOf(list[at]))) {
    return {
      sections: list,
      changed: false,
      reason: 'chrome',
      message: 'Page chrome (menu/footer) cannot be removed from a page.',
    };
  }
  const [removed] = list.splice(at, 1);
  return { sections: list, changed: true, removed };
}

/**
 * Structural law for an editor-submitted section list. Returns a list
 * of { code, message } violations (empty = lawful). A page may legally
 * have no nav or no footer; what is forbidden is a nav anywhere but
 * first, more than one nav, a footer anywhere but last, or more than
 * one footer.
 */
function validateEditorSections(sections) {
  const problems = [];
  if (!Array.isArray(sections)) {
    return [{ code: 'NOT_A_LIST', message: 'Sections must be a list.' }];
  }
  const navAt = [];
  const footerAt = [];
  sections.forEach((s, i) => {
    if (!s || typeof s !== 'object' || typeof s.type !== 'string' || !s.type) {
      problems.push({ code: 'BAD_SECTION', message: `Section ${i + 1} is malformed.` });
      return;
    }
    if (isNavSection(s)) navAt.push(i);
    if (isFooterSection(s)) footerAt.push(i);
  });
  if (navAt.length > 1) problems.push({ code: 'NAV_DUPLICATE', message: 'A page has exactly one menu section.' });
  if (navAt.length === 1 && navAt[0] !== 0) {
    problems.push({ code: 'NAV_NOT_FIRST', message: 'The menu section must stay first.' });
  }
  if (footerAt.length > 1) {
    problems.push({ code: 'FOOTER_DUPLICATE', message: 'A page has exactly one footer section.' });
  }
  if (footerAt.length === 1 && footerAt[0] !== sections.length - 1) {
    problems.push({ code: 'FOOTER_NOT_LAST', message: 'The footer section must stay last.' });
  }
  return problems;
}

/* ------------------------------------------------------------------ */
/* Batch 188 — section design variants (spec §3/§4). The field lives   */
/* ON THE SECTION object alongside the Batch 148 knobs:                */
/*   variant — a registry id from src/sectionVariants.js; the only     */
/*     stored values are non-default ids. ABSENT (or 'standard')       */
/*     means today's composition. The setter DELETES the field at the  */
/*     default, so a variant-free page stores nothing new and renders  */
/*     byte-identically to the pre-188 renderer BY CONSTRUCTION.       */
/*   Chrome (nav/footer) never carries a variant in v1 (spec D5);      */
/*   functional flow sections (forms, module mounts) register only     */
/*   'standard', so the registry itself fences them.                   */
/* ------------------------------------------------------------------ */

const sectionVariants = require('./sectionVariants');
const sectionTemplates = require('./sectionTemplates');
const sectionScripts = require('./sectionScripts');

function getSectionVariant(section) {
  return sectionVariants.variantOf(section);
}

/**
 * Variant op: a non-standard registry id stores the field; 'standard',
 * '' or null clears it. Unknown ids are refused with a named error
 * listing the valid ids for the type (spec §3).
 */
function setSectionVariant(section, id) {
  if (!section || typeof section !== 'object') {
    throw layoutKnobError('INVALID_SECTION', 'setSectionVariant needs a section object.');
  }
  const type = String(section.type || '');
  if (LAYOUT_CHROME_TYPES.has(type)) {
    throw layoutKnobError('CHROME_VARIANT', `The ${type} is page chrome — chrome has no design variants in v1.`);
  }
  const m = id == null ? '' : String(id).trim();
  if (m === '' || m === sectionVariants.STANDARD) {
    delete section.variant;
    return section;
  }
  if (!sectionVariants.isValidVariant(type, m)) {
    throw layoutKnobError(
      'UNKNOWN_VARIANT',
      `Unknown variant "${m}" for section type "${type}". Valid variants: ${
        sectionVariants.idsFor(type).join(', ') || '(none — this type has no variants)'
      }.`
    );
  }
  section.variant = m;
  return section;
}

/**
 * Save-path validation for section variants (same discipline as the
 * knob re-check): returns { code, message } problems — empty when
 * clean. An unknown id is NEVER silently kept (spec §3).
 */
function validateSectionVariants(sections) {
  const problems = [];
  if (!Array.isArray(sections)) return problems;
  sections.forEach((section, index) => {
    if (!section || typeof section !== 'object') return;
    if (!('variant' in section)) return;
    const where = `section ${index + 1} (${section.type || 'custom'})`;
    const type = String(section.type || '');
    const id = section.variant;
    if (typeof id !== 'string' || !id.trim()) {
      problems.push({
        code: 'UNKNOWN_VARIANT',
        message: `${where}: variant must be a registry id string or absent (standard).`,
      });
      return;
    }
    if (LAYOUT_CHROME_TYPES.has(type)) {
      problems.push({
        code: 'CHROME_VARIANT',
        message: `${where}: page chrome cannot carry a design variant in v1.`,
      });
      return;
    }
    if (id.trim() === sectionVariants.STANDARD) {
      problems.push({
        code: 'UNKNOWN_VARIANT',
        message: `${where}: "standard" is the default and is never stored — omit variant for the standard layout.`,
      });
      return;
    }
    if (!sectionVariants.isValidVariant(type, id.trim())) {
      problems.push({
        code: 'UNKNOWN_VARIANT',
        message: `${where}: unknown variant "${id}" for type "${type}". Valid variants: ${
          sectionVariants.idsFor(type).join(', ') || '(none — this type has no variants)'
        }.`,
      });
    }
  });
  return problems;
}

/* ------------------------------------------------------------------ */
/* Section custom templates (Batch 197) — section.template             */
/*                                                                     */
/* Same storage discipline as variants (Batch 148/188): the property   */
/* exists ONLY when a custom template is set, so an unset section      */
/* renders byte-identically to before. setSectionTemplate validates    */
/* against the type's hooks manifest (src/sectionTemplates.js), so a   */
/* template that drops a required functional hook (form field name,    */
/* form action, anchor id) can never be stored through the model       */
/* layer.                                                              */
/* ------------------------------------------------------------------ */

/** The section's custom template; '' when unset (standard layout). */
function getSectionTemplate(section) {
  return sectionTemplates.templateOf(section || {});
}

/**
 * Set or clear a section's custom template. '' / null / undefined
 * clears (the property is deleted — unset stays unset). Throws a
 * coded error (mirroring layoutKnobError) when the value is not a
 * string, when the type does not offer templates in v1, or when the
 * template fails manifest validation — the error names the missing
 * hook(s).
 */
function setSectionTemplate(section, template) {
  if (!section || typeof section !== 'object') {
    throw layoutKnobError('INVALID_SECTION', 'setSectionTemplate needs a section object.');
  }
  if (template === undefined || template === null || template === '') {
    delete section.template;
    return section;
  }
  if (typeof template !== 'string') {
    throw layoutKnobError('INVALID_TEMPLATE', 'template must be an HTML string (or empty to clear it).');
  }
  if (!sectionTemplates.isTemplateEnabled(section.type)) {
    throw layoutKnobError('TEMPLATE_NOT_AVAILABLE', sectionTemplates.templateDisabledReason(section.type));
  }
  const verdict = sectionTemplates.validateTemplate(section.type, template, section.content || {});
  if (!verdict.ok) {
    const first = verdict.problems[0];
    throw layoutKnobError(first.code, first.message);
  }
  section.template = template;
  return section;
}

/** True when the section carries a custom template. */
function hasSectionTemplate(section) {
  return getSectionTemplate(section) !== '';
}

/**
 * Save-path validation for section templates: returns { code,
 * message } problems — empty when every stored template parses,
 * belongs to a template-enabled type, and keeps every required hook
 * from its manifest entry. Mirrors validateSectionVariants; used by
 * the section-editor save path and the design-job payload validator
 * (the remaining write paths run sectionTemplates.validateTemplate
 * directly).
 */
function validateSectionTemplates(sections) {
  const problems = [];
  if (!Array.isArray(sections)) return problems;
  sections.forEach((section, index) => {
    if (!section || typeof section !== 'object') return;
    if (!('template' in section)) return;
    const where = `section ${index + 1} (${section.type || 'custom'})`;
    if (typeof section.template !== 'string' || !section.template.trim()) {
      problems.push({
        code: 'INVALID_TEMPLATE',
        message: `${where}: template must be a non-empty HTML string or absent (omit it for the standard layout).`,
      });
      return;
    }
    if (!sectionTemplates.isTemplateEnabled(section.type)) {
      problems.push({
        code: 'TEMPLATE_NOT_AVAILABLE',
        message: `${where}: ${sectionTemplates.templateDisabledReason(section.type)}`,
      });
      return;
    }
    const verdict = sectionTemplates.validateTemplate(section.type, section.template, section.content || {});
    for (const p of verdict.problems) {
      problems.push({ code: p.code, message: `${where}: ${p.message}` });
    }
  });
  return problems;
}

/* ------------------------------------------------------------------ */
/* Section scripts (Batch 199, Part D1) — section.js / libs /          */
/* jsModule / jsExpect                                                 */
/*                                                                     */
/* Same storage discipline as templates (Batch 197): every field       */
/* exists ONLY when set, so a script-free section renders              */
/* byte-identically to before. setSectionJs validates through          */
/* src/sectionScripts.js (caps, syntax, denylist, registry libs), so   */
/* an invalid script can never be stored through the model layer.      */
/* ------------------------------------------------------------------ */

/** The section's script; '' when unset. */
function getSectionJs(section) {
  return sectionScripts.jsOf(section || {});
}

/**
 * Set or clear a section's script fields. `fields` is the full set
 * { js, libs, jsModule, jsExpect } — pass js '' / null / undefined
 * (with no other fields) to clear ALL four (the properties are
 * deleted — unset stays unset). Throws a coded error mirroring
 * layoutKnobError on any validation problem, naming the rule.
 */
function setSectionJs(section, fields) {
  if (!section || typeof section !== 'object') {
    throw layoutKnobError('INVALID_SECTION', 'setSectionJs needs a section object.');
  }
  const f = fields && typeof fields === 'object' ? fields : {};
  const clearing =
    (f.js === undefined || f.js === null || f.js === '') && f.libs == null && f.jsModule == null && f.jsExpect == null;
  if (clearing) {
    delete section.js;
    delete section.libs;
    delete section.jsModule;
    delete section.jsExpect;
    return section;
  }
  const candidate = Object.assign({}, section, {
    js: f.js,
    libs: f.libs,
    jsModule: f.jsModule,
    jsExpect: f.jsExpect,
  });
  const problems = sectionScripts.validateSectionScript(candidate);
  if (problems.length) {
    throw layoutKnobError(problems[0].code, problems[0].message);
  }
  section.js = f.js;
  if (Array.isArray(f.libs) && f.libs.length) section.libs = f.libs.slice();
  else delete section.libs;
  if (f.jsModule === true) section.jsModule = true;
  else delete section.jsModule;
  if (typeof f.jsExpect === 'string' && f.jsExpect.trim()) section.jsExpect = f.jsExpect.trim();
  else delete section.jsExpect;
  return section;
}

/** True when the section carries a script. */
function hasSectionJs(section) {
  return sectionScripts.hasSectionJs(section || {});
}

/**
 * Save-path validation for section scripts: returns { code, message }
 * problems — empty when every stored script field set is valid
 * (availability, caps, syntax, denylist, registry coherence) and the
 * page's total script size is within the per-page cap. Mirrors
 * validateSectionTemplates; used beside it on the write paths.
 */
function validateSectionScripts(sections) {
  const problems = [];
  if (!Array.isArray(sections)) return problems;
  sections.forEach((section, index) => {
    if (!section || typeof section !== 'object') return;
    const where = `section ${index + 1} (${section.type || 'custom'})`;
    for (const p of sectionScripts.validateSectionScript(section)) {
      problems.push({ code: p.code, message: `${where}: ${p.message}` });
    }
  });
  const total = sectionScripts.pageJsChars(sections);
  if (total > sectionScripts.MAX_PAGE_JS_CHARS) {
    problems.push({
      code: 'PAGE_JS_TOO_LONG',
      message: `page section scripts total ${total} characters — the per-page limit is ${sectionScripts.MAX_PAGE_JS_CHARS}.`,
    });
  }
  return problems;
}

/**
 * Per-section editor descriptor for one page. `resolveModuleType` is a
 * caller-supplied (section) => moduleType|'' (the portal layer resolves
 * mount tokens against the lead's embeds; pure callers may omit it).
 */
/* ------------------------------------------------------------------ */
/* Batch 148 — section layout knobs: width mode + mobile visibility.   */
/* The fields live ON THE SECTION object alongside `style`:            */
/*   width        — the only stored value is 'full'; ABSENT means      */
/*     contained (today's behaviour).                                  */
/*   hideOnMobile — the only stored value is true; ABSENT means        */
/*     visible.                                                        */
/* Setters DELETE the field when a knob returns to its default, so a   */
/* page whose sections carry neither field stores nothing new — which  */
/* is what makes a knob-free page render byte-identically to the       */
/* pre-148 renderer BY CONSTRUCTION (the renderer stamps no class and  */
/* emits no rule block for absent fields). Nav/footer chrome can       */
/* never carry either knob; module types that are not page bands       */
/* (the sitewide chatbot overlay) never get the width knob.            */
/* ------------------------------------------------------------------ */

const LAYOUT_NON_BAND_MODULE_TYPES = new Set(['chatbot']);

function layoutKnobError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function getSectionWidth(section) {
  return section && section.width === 'full' ? 'full' : 'contained';
}

function getSectionHideOnMobile(section) {
  return !!(section && section.hideOnMobile === true);
}

function assertSectionKnobAllowed(section, knob, moduleType) {
  if (section && LAYOUT_CHROME_TYPES.has(section.type)) {
    throw layoutKnobError(
      'CHROME_KNOB',
      `The ${section.type} is page chrome — its ${knob === 'width' ? 'width' : 'mobile visibility'} is locked.`
    );
  }
  if (knob === 'width' && moduleType && LAYOUT_NON_BAND_MODULE_TYPES.has(moduleType)) {
    throw layoutKnobError(
      'WIDTH_NOT_AVAILABLE',
      `The ${moduleType} module is not a page band, so it has no width setting.`
    );
  }
}

/** Width knob op: 'full' stores the field; 'contained' clears it. */
function setSectionWidth(section, mode, moduleType) {
  if (!section || typeof section !== 'object') {
    throw layoutKnobError('INVALID_SECTION', 'setSectionWidth needs a section object.');
  }
  assertSectionKnobAllowed(section, 'width', moduleType);
  const m = mode == null ? '' : String(mode).trim().toLowerCase();
  if (m === '' || m === 'contained') {
    delete section.width;
    return section;
  }
  if (m !== 'full') {
    throw layoutKnobError(
      'INVALID_WIDTH',
      `Section width must be "full" or "contained" (got ${JSON.stringify(mode)}).`
    );
  }
  section.width = 'full';
  return section;
}

/** Hide-on-mobile op: true stores the field; false clears it. */
function setSectionHideOnMobile(section, hidden) {
  if (!section || typeof section !== 'object') {
    throw layoutKnobError('INVALID_SECTION', 'setSectionHideOnMobile needs a section object.');
  }
  assertSectionKnobAllowed(section, 'hideOnMobile');
  if (hidden === true) {
    section.hideOnMobile = true;
    return section;
  }
  if (hidden === false || hidden == null || hidden === '') {
    delete section.hideOnMobile;
    return section;
  }
  throw layoutKnobError('INVALID_HIDE_ON_MOBILE', 'Hide-on-mobile is a switch — pass true or false.');
}

/**
 * Save-path validation for the Batch 148 knobs (the layout editor's
 * save re-check, same discipline as the padding/background re-checks):
 * returns a list of { code, message } problems — empty when clean. A
 * hand-crafted save payload cannot hide the nav, widen an overlay, or
 * store an illegal knob value.
 */
function validateSectionLayoutKnobs(sections, resolveModuleType) {
  const problems = [];
  if (!Array.isArray(sections)) return problems;
  sections.forEach((section, index) => {
    if (!section || typeof section !== 'object') return;
    const where = `section ${index + 1} (${section.type || 'custom'})`;
    if ('width' in section && section.width !== 'full') {
      problems.push({ code: 'INVALID_WIDTH', message: `${where}: width must be "full" or absent (contained).` });
    }
    if ('hideOnMobile' in section && section.hideOnMobile !== true) {
      problems.push({
        code: 'INVALID_HIDE_ON_MOBILE',
        message: `${where}: hideOnMobile must be true or absent (visible).`,
      });
    }
    if (LAYOUT_CHROME_TYPES.has(section.type) && ('width' in section || 'hideOnMobile' in section)) {
      problems.push({
        code: 'CHROME_KNOB',
        message: `${where}: page chrome cannot carry a width or hide-on-mobile setting.`,
      });
    }
    if (section.width === 'full' && typeof resolveModuleType === 'function') {
      const mt = resolveModuleType(section);
      if (mt && LAYOUT_NON_BAND_MODULE_TYPES.has(mt)) {
        problems.push({
          code: 'WIDTH_NOT_AVAILABLE',
          message: `${where}: the ${mt} module is not a page band and cannot be full-width.`,
        });
      }
    }
  });
  return problems;
}

function describeEditorSection(section, index, resolveModuleType) {
  const t = sectionTypeOf(section);
  const moduleType =
    typeof resolveModuleType === 'function' ? String(resolveModuleType(section) || '').toLowerCase() : '';
  const chrome = LAYOUT_CHROME_TYPES.has(t);
  const fence = moduleType ? LAYOUT_DUPLICATE_FENCE[moduleType] : null;
  return {
    index,
    type: t,
    moduleType: moduleType || null,
    label: sectionLabel(section),
    chrome,
    movable: isLayoutMovable(section),
    canDuplicate: !chrome && !fence,
    duplicateReason: chrome ? 'Page chrome exists once per page.' : fence || null,
    canDelete: !chrome,
    canStyle: !chrome,
    paddingPx: getSectionPaddingPx(section),
    background: getSectionBackground(section),
    // Batch 148 knobs: chrome gets neither; non-band module types
    // (chatbot overlay) get hide-on-mobile but never width.
    canWidth: !chrome && !(moduleType && LAYOUT_NON_BAND_MODULE_TYPES.has(moduleType)),
    canHideMobile: !chrome,
    width: getSectionWidth(section),
    hideOnMobile: getSectionHideOnMobile(section),
    // Batch 188: design variant (spec §4/§6) — chrome never carries
    // one in v1; options come from the registry with agent metadata.
    canVariant: !chrome,
    variant: getSectionVariant(section),
    variantOptions: sectionVariants.entriesFor(t).map((e) => ({
      id: e.id,
      label: e.label,
      description: e.description,
      bestFor: e.bestFor,
      avoidWhen: e.avoidWhen,
    })),
    // Batch 197: custom template availability for this type — the
    // manifest decides (chrome and the Family B mounts are fenced);
    // hasTemplate reports whether one is currently stored.
    canTemplate: sectionTemplates.isTemplateEnabled(t),
    hasTemplate: hasSectionTemplate(section),
    templateNote: sectionTemplates.isTemplateEnabled(t) ? null : sectionTemplates.templateDisabledReason(t),
    // Batch 199: section script slot — read-only info for structure
    // views (no JS editor in the portal canvas in v1; scripts never
    // execute there). Availability mirrors the template fence.
    canJs: sectionTemplates.isTemplateEnabled(t),
    hasJs: hasSectionJs(section),
    jsNote: sectionTemplates.isTemplateEnabled(t)
      ? null
      : `Section scripts are not offered for this type in v1: ${sectionTemplates.templateDisabledReason(t)}`,
  };
}

module.exports = {
  PINNED_SECTION_TYPES,
  MAX_MENU_DEPTH,
  isPinnedSection,
  isNavSection,
  ensureNavFirstSections,
  ensureNavFirstPage,
  ensureNavFirstPages,
  isHomeLike,
  slugKey,
  menuParentKey,
  isNavVisible,
  setNavVisible,
  setMenuParent,
  menuVisualList,
  summarizeStructure,
  reorderMenu,
  nestMenuItem,
  unnestMenuItem,
  toggleNavVisibility,
  applyMenuAction,
  reorderSections,
  insertModuleSection,
  insertContentSection,
  insertBlockIntoSection,
  clampBlockCols,
  MAX_BLOCK_COLS,
  defaultSectionContent,
  createClientPage,
  titleToPageSlug,
  ensureUniquePageSlug,
  syncFreeformNavOrder,
  buildNavLinks,
  buildFooterLinks,
  renderNavLinksHtml,
  moveItem,
  // Batch 147 — native section editor ops.
  LAYOUT_DUPLICATE_FENCE,
  LAYOUT_CHROME_TYPES,
  LAYOUT_CONTENT_TYPES,
  LAYOUT_PADDING_MAX_PX,
  LAYOUT_PADDING_DEFAULT_PX,
  layoutPaddingFloorPx,
  parseStyleDecls,
  getSectionPaddingPx,
  setSectionPaddingPx,
  getSectionBackground,
  setSectionBackground,
  getSectionWidth,
  setSectionWidth,
  getSectionHideOnMobile,
  setSectionHideOnMobile,
  validateSectionLayoutKnobs,
  getSectionVariant,
  setSectionVariant,
  validateSectionVariants,
  getSectionTemplate,
  setSectionTemplate,
  hasSectionTemplate,
  validateSectionTemplates,
  getSectionJs,
  setSectionJs,
  hasSectionJs,
  validateSectionScripts,
  LAYOUT_NON_BAND_MODULE_TYPES,
  isLayoutMovable,
  moveSectionToIndex,
  duplicateSectionAt,
  removeSectionAt,
  validateEditorSections,
  describeEditorSection,
  freshenSectionIdentity,
};
