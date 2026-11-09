'use strict';

/**
 * Batch 169 — Assistant page Themes registry (single source).
 *
 * One entry per theme: id, category, display name, thumbnail asset
 * path, and a machine-readable LAYOUT RECIPE (pages, per-page section
 * order, module types used). The thumbnail image is for humans; the
 * recipe is what actually guides the design agent when the Build
 * wizard turns a theme pick into a real design job.
 *
 * HARD RULE (Ely, 2026-11-09): recipes may only name section types
 * and module types that exist in the tree — the section types from
 * src/siteStructure.js (LAYOUT_CONTENT_TYPES + the nav / banner /
 * footer chrome) and MODULE_TYPES from server/siteModules.js (31).
 * validateThemes() enforces it and the batch169 suite fails on any
 * name outside those lists, so an invented component cannot ship.
 *
 * Themes are LAYOUT GUIDES only (uniqueness doctrine): branding,
 * colors, content and imagery are set per build in the wizard, and
 * nothing here publishes a site — the wizard creates a staged
 * design job in the normal queue, exactly like any other job.
 */

const CATEGORIES = [
  { id: 'directory', label: 'Directory' },
  { id: 'store', label: 'Store' },
  { id: 'services', label: 'Services' },
  { id: 'restaurant', label: 'Restaurant' },
  { id: 'art', label: 'Art & Portfolio' },
  { id: 'courses', label: 'Courses' },
  { id: 'events', label: 'Events' },
  { id: 'blog', label: 'Blog / Magazine' },
];

const THEMES = [
  {
    id: 'directory-classic',
    category: 'directory',
    name: 'DirectoryHub Classic',
    tagline: 'Search-first local directory with category browsing and featured listings.',
    thumbnail: '/themes/directory.png',
    siteShape: 'multipage',
    heroStyle: 'Centered headline over a two-field search bar (keyword + location) with quick-category pills.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'cards', 'cards', 'columns', 'cta', 'footer'],
        modules: ['directory', 'categories'],
      },
      {
        name: 'Listings',
        sections: ['nav', 'heading', 'cards', 'footer'],
        modules: ['directory', 'categories'],
      },
      {
        name: 'Categories',
        sections: ['nav', 'heading', 'cards', 'footer'],
        modules: ['categories'],
      },
      {
        name: 'Contact',
        sections: ['nav', 'heading', 'text', 'footer'],
        modules: [],
      },
    ],
  },
  {
    id: 'store-northwind',
    category: 'store',
    name: 'Northwind Supply',
    tagline: 'Warm retail storefront with a product spotlight hero and featured product grid.',
    thumbnail: '/themes/store.png',
    siteShape: 'multipage',
    heroStyle: 'Split hero — headline and CTAs on the left, a single featured-product panel on the right, announcement banner above the nav.',
    pages: [
      {
        name: 'Home',
        sections: ['banner', 'nav', 'hero', 'cards', 'cta', 'footer'],
        modules: ['ecommerce', 'offers'],
      },
      {
        name: 'Shop',
        sections: ['nav', 'heading', 'cards', 'footer'],
        modules: ['ecommerce', 'categories'],
      },
      {
        name: 'Product',
        sections: ['nav', 'text_image', 'reviews', 'footer'],
        modules: ['ecommerce', 'checkout'],
      },
      {
        name: 'Checkout',
        sections: ['nav', 'heading', 'footer'],
        modules: ['checkout'],
      },
    ],
  },
  {
    id: 'services-summit',
    category: 'services',
    name: 'Summit Home Services',
    tagline: 'Trust-first local services: estimate form in the hero, services grid, reviews, booking CTA.',
    thumbnail: '/themes/services.png',
    siteShape: 'multipage',
    heroStyle: 'Dark two-column hero — rating badge, headline and trust points on the left; a free-estimate form card on the right. Call button in the nav.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'services', 'columns', 'reviews', 'cta', 'footer'],
        modules: ['estimate', 'googlereviews'],
      },
      {
        name: 'Services',
        sections: ['nav', 'heading', 'services', 'faq', 'footer'],
        modules: ['faq'],
      },
      {
        name: 'Book a Visit',
        sections: ['nav', 'heading', 'text', 'footer'],
        modules: ['bookings'],
      },
      {
        name: 'Contact',
        sections: ['nav', 'heading', 'text', 'footer'],
        modules: ['calltracking'],
      },
    ],
  },
  {
    id: 'restaurant-olive-ember',
    category: 'restaurant',
    name: 'Olive & Ember',
    tagline: 'Dark, elegant dining room: centered hero, priced menu list, gallery, hours and reservations.',
    thumbnail: '/themes/restaurant.png',
    siteShape: 'multipage',
    heroStyle: 'Centered serif hero on a dark ground — small caps overline, big italic headline, gold reserve/menu buttons.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'cards', 'gallery', 'columns', 'footer'],
        modules: ['menu', 'gallery'],
      },
      {
        name: 'Menu',
        sections: ['nav', 'heading', 'text', 'footer'],
        modules: ['menu'],
      },
      {
        name: 'Gallery',
        sections: ['nav', 'heading', 'gallery', 'footer'],
        modules: ['gallery'],
      },
      {
        name: 'Reservations',
        sections: ['nav', 'heading', 'text', 'cta', 'footer'],
        modules: ['bookings', 'offers'],
      },
    ],
  },
  {
    id: 'art-mara-voss',
    category: 'art',
    name: 'Mara Voss Studio',
    tagline: 'Quiet gallery-first portfolio: big artwork grid, about split, collector words, enquiries.',
    thumbnail: '/themes/art.png',
    siteShape: 'multipage',
    heroStyle: 'Left-aligned oversized serif headline with one wide artwork image directly beneath it.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'gallery', 'about', 'reviews', 'footer'],
        modules: ['gallery', 'testimonials'],
      },
      {
        name: 'Work',
        sections: ['nav', 'heading', 'gallery', 'footer'],
        modules: ['gallery'],
      },
      {
        name: 'About',
        sections: ['nav', 'about', 'image', 'footer'],
        modules: ['video'],
      },
      {
        name: 'Contact',
        sections: ['nav', 'heading', 'text', 'footer'],
        modules: [],
      },
    ],
  },
  {
    id: 'courses-brightpath',
    category: 'courses',
    name: 'BrightPath Learning',
    tagline: 'Friendly course catalog with level-tagged cards, a live-class band and member access.',
    thumbnail: '/themes/courses.png',
    siteShape: 'multipage',
    heroStyle: 'Centered headline with pill stats (lessons, learners, rating) above a three-card course row.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'cards', 'cta', 'footer'],
        modules: ['courses', 'webinar'],
      },
      {
        name: 'Courses',
        sections: ['nav', 'heading', 'cards', 'footer'],
        modules: ['courses', 'categories'],
      },
      {
        name: 'Pricing',
        sections: ['nav', 'heading', 'cards', 'footer'],
        modules: ['pricing', 'members'],
      },
      {
        name: 'Live Classes',
        sections: ['nav', 'heading', 'text', 'footer'],
        modules: ['webinar'],
      },
    ],
  },
  {
    id: 'events-gatherwell',
    category: 'events',
    name: 'GatherWell Events',
    tagline: 'Warm events hub: date-block event list, stats panel, host CTA and ticket booking.',
    thumbnail: '/themes/events.png',
    siteShape: 'multipage',
    heroStyle: 'Centered serif headline with a pill event search (date + place) above a date-block event list.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'cards', 'about', 'cta', 'footer'],
        modules: ['events'],
      },
      {
        name: 'Events',
        sections: ['nav', 'heading', 'cards', 'footer'],
        modules: ['events', 'categories'],
      },
      {
        name: 'Event Details',
        sections: ['nav', 'text_image', 'text', 'footer'],
        modules: ['bookings'],
      },
      {
        name: 'Host an Event',
        sections: ['nav', 'heading', 'text', 'gallery', 'footer'],
        modules: ['webinar', 'gallery'],
      },
    ],
  },
  {
    id: 'blog-daily-field',
    category: 'blog',
    name: 'The Daily Field',
    tagline: 'Editorial magazine: masthead, featured story, three-column story grid, newsletter band.',
    thumbnail: '/themes/blog.png',
    siteShape: 'multipage',
    heroStyle: 'Newspaper masthead with a topic navigation rule; the featured story leads, no image hero.',
    pages: [
      {
        name: 'Home',
        sections: ['banner', 'nav', 'heading', 'cards', 'cta', 'footer'],
        modules: ['blog', 'newsletter'],
      },
      {
        name: 'Stories',
        sections: ['nav', 'heading', 'cards', 'footer'],
        modules: ['blog', 'categories'],
      },
      {
        name: 'Article',
        sections: ['nav', 'heading', 'text', 'footer'],
        modules: ['blog', 'comments'],
      },
      {
        name: 'About',
        sections: ['nav', 'about', 'text', 'footer'],
        modules: ['newsletter'],
      },
    ],
  },
];

/** Section types a recipe may name: the layout content types plus
 * the pinned chrome (nav / banner / footer) and the hero. Mirrors
 * src/siteStructure.js — validated against the real export so the
 * suite catches drift in either direction. */
function allowedSectionTypes() {
  const { LAYOUT_CONTENT_TYPES, LAYOUT_CHROME_TYPES, PINNED_SECTION_TYPES } = require('../src/siteStructure');
  const types = LAYOUT_CONTENT_TYPES.map((x) => (typeof x === 'string' ? x : x.type));
  return new Set([...types, ...LAYOUT_CHROME_TYPES, ...PINNED_SECTION_TYPES]);
}

function allowedModuleTypes() {
  const { MODULE_TYPES } = require('./siteModules');
  return new Set(MODULE_TYPES);
}

/** Structural validation of the whole catalog against the real
 * section/module lists. Returns a list of problem strings (empty =
 * valid). Pure and synchronous; the suite calls it directly. */
function validateThemes(themes = THEMES, categories = CATEGORIES) {
  const problems = [];
  const sections = allowedSectionTypes();
  const modules = allowedModuleTypes();
  const categoryIds = new Set(categories.map((c) => c.id));
  const seenIds = new Set();
  const seenCategories = new Set();
  for (const t of themes) {
    if (!t || typeof t !== 'object') {
      problems.push('theme entry is not an object');
      continue;
    }
    if (!t.id || seenIds.has(t.id)) problems.push(`theme id missing or duplicated: ${t.id || '(none)'}`);
    seenIds.add(t.id);
    if (!categoryIds.has(t.category)) problems.push(`${t.id}: unknown category ${t.category}`);
    seenCategories.add(t.category);
    if (!t.name || !t.tagline) problems.push(`${t.id}: name/tagline missing`);
    if (!/^\/themes\/[a-z0-9-]+\.png$/.test(t.thumbnail || '')) {
      problems.push(`${t.id}: thumbnail must be a /themes/*.png path`);
    }
    if (t.siteShape !== 'landing' && t.siteShape !== 'multipage') {
      problems.push(`${t.id}: siteShape must be landing or multipage`);
    }
    if (!Array.isArray(t.pages) || !t.pages.length) {
      problems.push(`${t.id}: pages missing`);
      continue;
    }
    for (const p of t.pages) {
      for (const s of p.sections || []) {
        if (!sections.has(s)) problems.push(`${t.id}/${p.name}: unknown section type "${s}"`);
      }
      for (const m of p.modules || []) {
        if (!modules.has(m)) problems.push(`${t.id}/${p.name}: unknown module type "${m}"`);
      }
    }
  }
  for (const c of categories) {
    if (!seenCategories.has(c.id)) problems.push(`category ${c.id} has no theme`);
  }
  return problems;
}

function getTheme(id) {
  return THEMES.find((t) => t.id === id) || null;
}

function categoryLabel(id) {
  const c = CATEGORIES.find((x) => x.id === id);
  return c ? c.label : id;
}

/** Public shape for the portal: categories in registry order, each
 * with its themes (recipe summary included so the wizard can show
 * what a build will follow without a second round-trip). */
function publicCatalog() {
  return CATEGORIES.map((c) => ({
    id: c.id,
    label: c.label,
    themes: THEMES.filter((t) => t.category === c.id).map((t) => ({
      id: t.id,
      name: t.name,
      tagline: t.tagline,
      thumbnail: t.thumbnail,
      siteShape: t.siteShape,
      pages: t.pages.map((p) => p.name),
      modules: [...new Set(t.pages.flatMap((p) => p.modules || []))],
    })),
  })).filter((c) => c.themes.length > 0);
}

/** The plain-text layout recipe embedded in the design job's
 * instructions. The design agent reads this as the page/section/
 * module plan; the theme id line doubles as the suite's marker. */
function recipeText(theme) {
  const lines = [];
  lines.push(`THEME LAYOUT GUIDE - ${theme.name} (theme id: ${theme.id}, category: ${categoryLabel(theme.category)})`);
  lines.push('This theme is a LAYOUT GUIDE ONLY. Follow the page list, section order and module plan below;');
  lines.push('all branding, colors, wording and imagery come from the business details in this brief.');
  lines.push(`Site shape: ${theme.siteShape}`);
  lines.push(`Hero style: ${theme.heroStyle}`);
  lines.push('Pages and layout:');
  for (const p of theme.pages) {
    const mods = (p.modules || []).length ? ` | modules: ${p.modules.join(', ')}` : '';
    lines.push(`- ${p.name}: sections: ${p.sections.join(' > ')}${mods}`);
  }
  lines.push('Use only the section and module types named above - they are the types that exist in BitPype.');
  return lines.join('\n');
}

function cleanText(v, max) {
  return String(v == null ? '' : v).trim().slice(0, max);
}

/**
 * The wizard's Build action. Runs inside the client's workspace db:
 * resolves the lead (existing id, verified in THIS workspace, or a
 * new lead created through the lead engine), composes the design
 * job brief from the wizard fields + the theme recipe, and creates
 * the job through the one shared designJobs.createJob flow. The job
 * lands in the normal design queue (waiting_on_agent) — staged for
 * review, never auto-published.
 *
 * Throws an Error with .code set (VALIDATION / NOT_FOUND / CONFLICT)
 * and a client-safe message; the route surfaces it in the popup.
 */
function buildWithTheme(db, input = {}) {
  const theme = getTheme(cleanText(input.themeId, 80));
  if (!theme) {
    const err = new Error('Pick a theme to build from.');
    err.code = 'VALIDATION';
    throw err;
  }
  const designJobs = require('../src/designJobs');
  const leadEngine = require('../src/leadEngine');

  let leadId = Number(input.leadId) || 0;
  let lead = null;
  if (leadId > 0) {
    const row = db.prepare('SELECT id, business_name FROM leads WHERE id = ?').get(leadId);
    if (!row) {
      const err = new Error('That business is not in your leads. Add it as a new lead instead.');
      err.code = 'NOT_FOUND';
      throw err;
    }
    lead = row;
  } else if (input.newLead && typeof input.newLead === 'object') {
    const nl = input.newLead;
    const contactName = cleanText(nl.contactName, 160);
    const created = leadEngine.createLead(db, {
      business_name: cleanText(nl.businessName, 200),
      category: cleanText(nl.category, 120) || categoryLabel(theme.category),
      city: cleanText(nl.city, 120),
      email: cleanText(nl.email, 200),
      phone: cleanText(nl.phone, 60),
      notes: contactName
        ? `Added from the Assistant Themes build wizard. Contact: ${contactName}.`
        : 'Added from the Assistant Themes build wizard.',
    });
    leadId = created.id;
    lead = { id: created.id, business_name: created.business_name };
  } else {
    const err = new Error('Choose one of your leads, or add the business as a new lead.');
    err.code = 'VALIDATION';
    throw err;
  }

  const businessName =
    cleanText(input.businessName, 200) || (lead && lead.business_name) || 'New website';
  const siteShape = input.siteShape === 'landing' ? 'landing' : 'multipage';
  const pagesWanted = cleanText(input.pagesWanted, 600);
  const brandNotes = cleanText(input.brandNotes, 1500);

  const detailLines = [
    `Build a website for ${businessName} using the "${theme.name}" theme as the layout guide.`,
  ];
  if (pagesWanted) detailLines.push(`Pages wanted: ${pagesWanted}`);
  if (brandNotes) detailLines.push(`Brand notes (colors, style, anything to include or avoid): ${brandNotes}`);
  if (!pagesWanted && !brandNotes) {
    detailLines.push('No extra pages or brand notes were given - follow the theme recipe pages as listed.');
  }
  const instructions = `${detailLines.join('\n')}\n\n${recipeText(theme)}`;

  const job = designJobs.createJob(db, {
    type: 'website',
    title: `${businessName} - ${theme.name} theme build`.slice(0, 200),
    instructions,
    leadId,
    siteShape,
  });
  return { job, theme, leadId };
}

module.exports = {
  CATEGORIES,
  THEMES,
  allowedSectionTypes,
  allowedModuleTypes,
  validateThemes,
  getTheme,
  categoryLabel,
  publicCatalog,
  recipeText,
  buildWithTheme,
};
