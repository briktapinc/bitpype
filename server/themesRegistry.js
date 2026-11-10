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
  // Batch 175 — the 20 staged themes (daily theme duty, 2026-11-09/10)
  // promoted into the live registry. Recipes transcribed from each
  // theme's staged recipe.md; where a compact recipe named a module
  // type in its section list (menu / courses / blog / bookings), the
  // section recorded is the one the full recipes use for that content
  // (cards / cta) and the module rides in the page's module list —
  // the same shape as the launch eight above.
  {
    id: 'directory-v2',
    category: 'directory',
    name: 'Berks Auto Care Finder',
    tagline: 'Dark charcoal + amber search-first directory of independent auto repair shops.',
    thumbnail: '/themes/directory-v2.png',
    siteShape: 'multipage',
    heroStyle: 'Search-style hero band — headline over a two-field directory search bar (service + town) with amber category pills.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'services', 'columns', 'benefits', 'text', 'cta', 'footer'],
        modules: ['directory', 'categories', 'newsletter'],
      },
      {
        name: 'Listing Profile',
        sections: ['nav', 'heading', 'text_image', 'reviews', 'faq', 'cta', 'footer'],
        modules: ['directory', 'calltracking'],
      },
      {
        name: 'Town',
        sections: ['nav', 'heading', 'cards', 'cta', 'footer'],
        modules: ['directory', 'categories'],
      },
    ],
  },
  {
    id: 'directory-v3',
    category: 'directory',
    name: 'Keystone Home Pros Directory',
    tagline: 'Light cream sidebar-layout directory of home contractors with featured-pro rows.',
    thumbnail: '/themes/directory-v3.png',
    siteShape: 'multipage',
    heroStyle: 'Serif headline with trade pills and a dark-green estimate intro card; main list beside a trades-index sidebar.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'columns', 'services', 'cta', 'footer'],
        modules: ['directory', 'categories', 'estimate', 'googlereviews'],
      },
      {
        name: 'Pro Profile',
        sections: ['nav', 'heading', 'text_image', 'reviews', 'faq', 'cta', 'footer'],
        modules: ['directory', 'googlereviews'],
      },
      {
        name: 'Trade',
        sections: ['nav', 'heading', 'cards', 'text', 'cta', 'footer'],
        modules: ['directory', 'categories', 'estimate'],
      },
    ],
  },
  {
    id: 'directory-v4',
    category: 'directory',
    name: 'Oley Valley Electricians Directory',
    tagline: 'Dark slate + amber search-first directory of electricians, by service and town.',
    thumbnail: '/themes/directory-v4.png',
    siteShape: 'multipage',
    heroStyle: 'Search panel hero with service and town fields over a dark slate ground, amber accents, horizontal listing rows below.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'columns', 'cards', 'cta', 'footer'],
        modules: ['directory', 'categories', 'estimate'],
      },
      {
        name: 'Detail Pages',
        sections: ['nav', 'heading', 'cards', 'cta', 'footer'],
        modules: ['directory', 'categories', 'estimate'],
      },
    ],
  },
  {
    id: 'store-v2',
    category: 'store',
    name: 'Fade & Supply Co.',
    tagline: 'Black + off-white sharp editorial barber-supply store with a horizontal product row.',
    thumbnail: '/themes/store-v2.png',
    siteShape: 'multipage',
    heroStyle: 'Full-black hero with an oversized serif headline and dual CTAs, announcement banner above the nav.',
    pages: [
      {
        name: 'Home',
        sections: ['banner', 'nav', 'hero', 'html', 'heading', 'cards', 'text_image', 'benefits', 'cta', 'footer'],
        modules: ['categories', 'ecommerce', 'offers', 'newsletter'],
      },
      {
        name: 'Shop',
        sections: ['nav', 'banner', 'heading', 'cards', 'cta', 'footer'],
        modules: ['ecommerce', 'categories'],
      },
      {
        name: 'Product',
        sections: ['nav', 'text_image', 'benefits', 'reviews', 'cta', 'footer'],
        modules: ['ecommerce'],
      },
      {
        name: 'Checkout',
        sections: ['nav', 'heading', 'html', 'footer'],
        modules: ['checkout'],
      },
    ],
  },
  {
    id: 'store-v3',
    category: 'store',
    name: 'Perkiomen Garden Supply',
    tagline: 'Light sage and cream garden store: seasonal hero panel, product grid, workshops strip.',
    thumbnail: '/themes/store-v3.png',
    siteShape: 'multipage',
    heroStyle: 'Seasonal hero panel with badge and dual pill CTAs beside a seasonal image panel, announcement banner above.',
    pages: [
      {
        name: 'Home',
        sections: ['banner', 'nav', 'hero', 'heading', 'cards', 'heading', 'columns', 'cta', 'footer'],
        modules: ['categories', 'ecommerce', 'events', 'newsletter'],
      },
      {
        name: 'Shop',
        sections: ['nav', 'banner', 'heading', 'cards', 'cta', 'footer'],
        modules: ['ecommerce', 'categories'],
      },
      {
        name: 'Product',
        sections: ['nav', 'text_image', 'benefits', 'reviews', 'cta', 'footer'],
        modules: ['ecommerce'],
      },
      {
        name: 'Events',
        sections: ['nav', 'heading', 'cards', 'faq', 'cta', 'footer'],
        modules: ['events'],
      },
      {
        name: 'Checkout',
        sections: ['nav', 'heading', 'html', 'footer'],
        modules: ['checkout'],
      },
    ],
  },
  {
    id: 'store-v4',
    category: 'store',
    name: 'Reading Auto Care Store',
    tagline: 'Light grey + red industrial auto-care store with a fitment finder in the hero.',
    thumbnail: '/themes/store-v4.png',
    siteShape: 'multipage',
    heroStyle: 'Hero with a fitment-finder panel under an announcement bar; category tiles and a six-product grid below.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'banner', 'hero', 'cards', 'columns', 'cta', 'footer'],
        modules: ['ecommerce', 'categories', 'newsletter'],
      },
      {
        name: 'Detail Pages',
        sections: ['nav', 'heading', 'cards', 'cta', 'footer'],
        modules: ['ecommerce', 'categories', 'checkout', 'newsletter'],
      },
    ],
  },
  {
    id: 'services-v2',
    category: 'services',
    name: 'Schuylkill Flow Plumbing',
    tagline: 'Deep navy + cyan plumbing site: estimate form in the hero and an emergency banner.',
    thumbnail: '/themes/services-v2.png',
    siteShape: 'multipage',
    heroStyle: 'Left-aligned hero — headline and service points on the left, a white estimate-form card on the right, cyan emergency strip directly under.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'banner', 'heading', 'services', 'columns', 'text_image', 'faq', 'cta', 'footer'],
        modules: ['estimate', 'calltracking', 'googlereviews', 'faq', 'bookings'],
      },
      {
        name: 'Services',
        sections: ['nav', 'heading', 'services', 'text', 'cta', 'footer'],
        modules: [],
      },
      {
        name: 'Book / Contact',
        sections: ['nav', 'heading', 'html', 'faq', 'footer'],
        modules: ['estimate', 'faq'],
      },
    ],
  },
  {
    id: 'services-v3',
    category: 'services',
    name: 'Berks Ridge Roofing',
    tagline: 'Warm cream + rust serif roofing site with an inspection-request card in the hero.',
    thumbnail: '/themes/services-v3.png',
    siteShape: 'multipage',
    heroStyle: 'Split hero — serif headline on the left, an inspection-request card on the right, on warm cream with rust accents.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'services', 'columns', 'faq', 'cta', 'footer'],
        modules: ['estimate', 'bookings', 'calltracking', 'faq'],
      },
      {
        name: 'Detail Pages',
        sections: ['nav', 'heading', 'cards', 'cta', 'footer'],
        modules: ['estimate', 'bookings', 'calltracking', 'faq'],
      },
    ],
  },
  {
    id: 'services-v4',
    category: 'services',
    name: 'Antietam Tree Care',
    tagline: 'Deep green + cream centered-hero tree service with a six-service card grid.',
    thumbnail: '/themes/services-v4.png',
    siteShape: 'multipage',
    heroStyle: 'Centered headline hero on deep green and cream, service-area split with town tags below.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'services', 'text_image', 'faq', 'cta', 'footer'],
        modules: ['estimate', 'bookings', 'calltracking', 'faq', 'googlereviews'],
      },
      {
        name: 'Detail Pages',
        sections: ['nav', 'heading', 'cards', 'cta', 'footer'],
        modules: ['estimate', 'bookings', 'calltracking', 'faq', 'googlereviews'],
      },
    ],
  },
  {
    id: 'restaurant-v2',
    category: 'restaurant',
    name: 'Tulpehocken Table',
    tagline: 'Warm cream + burgundy farm-to-table restaurant with a two-column seasonal menu.',
    thumbnail: '/themes/restaurant-v2.png',
    siteShape: 'multipage',
    heroStyle: 'Centered serif hero on warm cream — overline, big headline, dual reservation and menu CTAs.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'heading', 'cards', 'text_image', 'cta', 'gallery', 'columns', 'html', 'footer'],
        modules: ['menu', 'bookings', 'events', 'gallery', 'newsletter'],
      },
      {
        name: 'Menu',
        sections: ['nav', 'heading', 'cards', 'cta', 'footer'],
        modules: ['menu'],
      },
      {
        name: 'Catering & Private Events',
        sections: ['nav', 'heading', 'text_image', 'gallery', 'faq', 'cta', 'footer'],
        modules: ['events', 'bookings', 'gallery'],
      },
      {
        name: 'Visit / Reserve',
        sections: ['nav', 'heading', 'columns', 'html', 'footer'],
        modules: ['newsletter', 'bookings'],
      },
    ],
  },
  {
    id: 'restaurant-v3',
    category: 'restaurant',
    name: 'Penn Street Diner',
    tagline: 'Retro cream diner with a teal and red masthead and a two-column menu.',
    thumbnail: '/themes/restaurant-v3.png',
    siteShape: 'multipage',
    heroStyle: 'Centered masthead hero with a rule under it — retro diner wordmark, teal and red accents on cream.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'cards', 'columns', 'footer'],
        modules: ['menu', 'bookings', 'socialfeed'],
      },
      {
        name: 'Detail Pages',
        sections: ['nav', 'heading', 'cards', 'cta', 'footer'],
        modules: ['menu', 'bookings', 'socialfeed'],
      },
    ],
  },
  {
    id: 'restaurant-v4',
    category: 'restaurant',
    name: 'Isla Reading Kitchen',
    tagline: 'Dark-green tropical Puerto Rican kitchen with a coral and amber hero panel.',
    thumbnail: '/themes/restaurant-v4.png',
    siteShape: 'multipage',
    heroStyle: 'Coral and amber hero panel on a dark-green tropical ground, dish grid and catering split below.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'cards', 'text_image', 'footer'],
        modules: ['menu', 'bookings', 'gallery', 'socialfeed'],
      },
      {
        name: 'Detail Pages',
        sections: ['nav', 'heading', 'cards', 'cta', 'footer'],
        modules: ['menu', 'bookings', 'gallery', 'socialfeed'],
      },
    ],
  },
  {
    id: 'art-v2',
    category: 'art',
    name: 'Hawk Mountain Photography',
    tagline: 'Minimal near-white gallery-first photography portfolio with generous whitespace.',
    thumbnail: '/themes/art-v2.png',
    siteShape: 'multipage',
    heroStyle: 'Quiet left-aligned serif hero on near-white — kicker, headline and intro above a masonry-feel gallery grid.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'gallery', 'text_image', 'cards', 'banner', 'cta', 'footer'],
        modules: ['gallery', 'photocapture'],
      },
      {
        name: 'Portfolio',
        sections: ['nav', 'heading', 'gallery', 'cta', 'footer'],
        modules: ['gallery'],
      },
      {
        name: 'Sessions',
        sections: ['nav', 'heading', 'cards', 'faq', 'footer'],
        modules: ['pricing', 'bookings'],
      },
      {
        name: 'Contact',
        sections: ['nav', 'heading', 'text', 'footer'],
        modules: ['bookings'],
      },
    ],
  },
  {
    id: 'art-v3',
    category: 'art',
    name: 'Colour & Coat Studio',
    tagline: 'White minimal painter portfolio with a violet accent and a colour-swatch hero strip.',
    thumbnail: '/themes/art-v3.png',
    siteShape: 'multipage',
    heroStyle: 'Colour-swatch hero strip on white with a violet accent; gallery grid organised by colour story below.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'gallery', 'services', 'about', 'cta', 'footer'],
        modules: ['gallery', 'testimonials', 'bookings'],
      },
      {
        name: 'Detail Pages',
        sections: ['nav', 'heading', 'cards', 'cta', 'footer'],
        modules: ['gallery', 'testimonials', 'bookings'],
      },
    ],
  },
  {
    id: 'courses-v2',
    category: 'courses',
    name: 'Ledger Lab Academy',
    tagline: 'Light indigo friendly academy for bookkeeping and tax-prep courses, search-first.',
    thumbnail: '/themes/courses-v2.png',
    siteShape: 'multipage',
    heroStyle: 'Left-aligned split hero — pill label, headline and a course-search bar, with a learning-path mini card on the right.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'cards', 'columns', 'faq', 'html', 'cta', 'footer'],
        modules: ['courses', 'faq', 'newsletter', 'members'],
      },
      {
        name: 'Catalog',
        sections: ['nav', 'heading', 'cards', 'faq', 'cta', 'footer'],
        modules: ['courses', 'faq'],
      },
      {
        name: 'Course Detail',
        sections: ['nav', 'heading', 'text', 'cta', 'footer'],
        modules: ['courses', 'pricing'],
      },
      {
        name: 'Membership',
        sections: ['nav', 'heading', 'cards', 'faq', 'footer'],
        modules: ['pricing', 'members', 'faq'],
      },
    ],
  },
  {
    id: 'courses-v3',
    category: 'courses',
    name: 'Keystone Coverage Academy',
    tagline: 'Navy + gold professional academy with a stats panel and a course-row catalog.',
    thumbnail: '/themes/courses-v3.png',
    siteShape: 'multipage',
    heroStyle: 'Navy hero with a gold stats panel; the catalog below is course rows, not cards.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'cards', 'columns', 'cta', 'footer'],
        modules: ['courses', 'members', 'pricing', 'newsletter'],
      },
      {
        name: 'Detail Pages',
        sections: ['nav', 'heading', 'cards', 'cta', 'footer'],
        modules: ['courses', 'members', 'pricing', 'newsletter'],
      },
    ],
  },
  {
    id: 'events-v2',
    category: 'events',
    name: 'Blue Mountain Barn Events',
    tagline: 'Rustic terracotta and cream barn venue with a date-check hero card.',
    thumbnail: '/themes/events-v2.png',
    siteShape: 'multipage',
    heroStyle: 'Cream hero — headline and setting points beside a date-check card, terracotta rule and dark-brown header.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'heading', 'html', 'cards', 'gallery', 'columns', 'cta', 'footer'],
        modules: ['events', 'bookings', 'gallery', 'menu', 'faq'],
      },
      {
        name: 'Events',
        sections: ['nav', 'heading', 'cards', 'cta', 'footer'],
        modules: ['events'],
      },
      {
        name: 'Spaces',
        sections: ['nav', 'hero', 'cards', 'gallery', 'faq', 'cta', 'footer'],
        modules: ['gallery', 'faq'],
      },
      {
        name: 'Gallery',
        sections: ['nav', 'heading', 'gallery', 'cta', 'footer'],
        modules: ['gallery'],
      },
      {
        name: 'Menus',
        sections: ['nav', 'heading', 'text', 'cards', 'faq', 'cta', 'footer'],
        modules: ['menu', 'faq'],
      },
      {
        name: 'FAQ',
        sections: ['nav', 'heading', 'faq', 'cta', 'footer'],
        modules: ['faq'],
      },
      {
        name: 'Booking / Check a Date',
        sections: ['nav', 'heading', 'html', 'text', 'footer'],
        modules: ['bookings'],
      },
    ],
  },
  {
    id: 'events-v3',
    category: 'events',
    name: 'Schuylkill River Weddings',
    tagline: 'Ivory elegant serif wedding venue.',
    thumbnail: '/themes/events-v3.png',
    siteShape: 'multipage',
    heroStyle: 'Ivory elegant serif wedding venue: centred masthead nav, italic hero, 3 space cards, 4-step planning timeline, availability check band',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'cards', 'columns', 'cta', 'footer'],
        modules: ['events', 'bookings', 'gallery', 'testimonials'],
      },
      {
        name: 'Detail Pages',
        sections: ['nav', 'heading', 'cards', 'cta', 'footer'],
        modules: ['events', 'bookings', 'gallery', 'testimonials'],
      },
    ],
  },
  {
    id: 'blog-v2',
    category: 'blog',
    name: 'Berks Home Journal',
    tagline: 'Classic newspaper magazine: masthead with red rules, featured story and rail.',
    thumbnail: '/themes/blog-v2.png',
    siteShape: 'multipage',
    heroStyle: 'Newspaper masthead with red double rules; the featured story leads with a three-story side rail, no image hero.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'heading', 'text_image', 'cards', 'columns', 'html', 'footer'],
        modules: ['blog', 'categories', 'newsletter', 'socialfeed'],
      },
      {
        name: 'Section / Topic',
        sections: ['nav', 'heading', 'cards', 'html', 'footer'],
        modules: ['blog', 'newsletter'],
      },
      {
        name: 'Article',
        sections: ['nav', 'heading', 'text', 'image', 'html', 'footer'],
        modules: ['blog', 'comments', 'socialfeed', 'newsletter'],
      },
      {
        name: 'Archive',
        sections: ['nav', 'heading', 'cards', 'footer'],
        modules: ['categories', 'blog'],
      },
      {
        name: 'Subscribe',
        sections: ['nav', 'heading', 'text', 'footer'],
        modules: ['newsletter'],
      },
    ],
  },
  {
    id: 'blog-v3',
    category: 'blog',
    name: 'Bright Smiles Berks Journal',
    tagline: 'Clean light-blue dental magazine.',
    thumbnail: '/themes/blog-v3.png',
    siteShape: 'multipage',
    heroStyle: 'Clean light-blue dental magazine: top strip, masthead, featured story + Most Read sidebar, 3-story grid, newsletter band',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'heading', 'cards', 'cta', 'footer'],
        modules: ['blog', 'newsletter', 'categories', 'comments'],
      },
      {
        name: 'Detail Pages',
        sections: ['nav', 'heading', 'cards', 'cta', 'footer'],
        modules: ['blog', 'newsletter', 'categories', 'comments'],
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
 * what a build will follow without a second round-trip). Batch 171:
 * each theme also carries its full `recipe` text — the staff New
 * Design Job page inserts that exact text into the job instructions
 * as its delimited theme block, so page-created jobs carry the same
 * recipe markers as wizard-built ones. */
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
      recipe: recipeText(t),
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
