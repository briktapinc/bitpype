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
  // Batch 179 - the 66 staged themes (daily theme duty plus Ely's
  // 2026-11-11 bonus and variety batches) promoted into the live
  // registry (94 total). Recipes transcribed from each theme's staged
  // recipe.md, same conventions as Batch 175: the Home page follows
  // the recipe's section order (a module type named in a compact
  // section list is recorded as the section the full recipes use for
  // that content - menu as text - and rides in the page's module
  // list), and each theme carries the generic Detail Pages shape the
  // recipes describe (nav, heading, module content, cta, footer).
  {
    id: 'directory-v5',
    category: 'directory',
    name: 'Berks Shine Finder',
    tagline: 'Light mint/white sidebar directory of Berks home cleaners: search hero, photo band, filter sidebar (service + town) beside 4 photo listing rows',
    thumbnail: '/themes/directory-v5.png',
    siteShape: 'multipage',
    heroStyle: 'Centered search hero over a light mint ground; below it a photo band, then a filter sidebar (service + town) beside photo listing rows.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'image', 'cards', 'cta', 'footer'],
        modules: ['directory', 'categories', 'newsletter'],
      },
      {
        name: 'Detail Pages',
        sections: ['nav', 'heading', 'cards', 'cta', 'footer'],
        modules: ['directory', 'categories', 'newsletter'],
      },
    ],
  },
  {
    id: 'directory-v6',
    category: 'directory',
    name: 'Berks Green Directory',
    tagline: 'Deep green + cream serif directory with search hero, browse-by-town strip and photo listing cards',
    thumbnail: '/themes/directory-v6.png',
    siteShape: 'multipage',
    heroStyle: 'Centered search hero - headline over a search bar with a browse-by-town pill strip, on deep green and cream.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'cards', 'image', 'columns', 'cta', 'footer'],
        modules: ['directory', 'categories', 'newsletter'],
      },
      {
        name: 'Detail Pages',
        sections: ['nav', 'heading', 'cards', 'cta', 'footer'],
        modules: ['directory', 'categories', 'newsletter'],
      },
    ],
  },
  {
    id: 'directory-v7',
    category: 'directory',
    name: 'Keystone Law Finder',
    tagline: 'Navy + gold formal serif law directory with search hero, practice-area chips and stacked photo firm listing cards',
    thumbnail: '/themes/directory-v7.png',
    siteShape: 'multipage',
    heroStyle: 'Dark navy search hero with practice-area chips and a two-field search bar; stacked horizontal firm listing cards below.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'cards', 'columns', 'cta', 'footer'],
        modules: ['directory', 'categories', 'newsletter'],
      },
      {
        name: 'Detail Pages',
        sections: ['nav', 'heading', 'cards', 'cta', 'footer'],
        modules: ['directory', 'categories', 'newsletter'],
      },
    ],
  },
  {
    id: 'directory-v8',
    category: 'directory',
    name: 'Berks Pet Care Directory',
    tagline: 'Warm teal + coral directory with search hero, browse-by-service strip and rounded photo listing cards',
    thumbnail: '/themes/directory-v8.png',
    siteShape: 'multipage',
    heroStyle: 'Search hero with photo on warm teal and coral; browse-by-service pill strip directly under.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'html', 'cards', 'text_image', 'benefits', 'reviews', 'cta', 'footer'],
        modules: ['directory', 'categories', 'googlereviews', 'newsletter'],
      },
      {
        name: 'Detail Pages',
        sections: ['nav', 'heading', 'cards', 'cta', 'footer'],
        modules: ['directory', 'categories', 'googlereviews', 'newsletter'],
      },
    ],
  },
  {
    id: 'directory-v9',
    category: 'directory',
    name: 'Berks Homes Directory',
    tagline: 'Magazine-grid directory in stone/ivory with deep green + brass, serif display type, search hero and town columns',
    thumbnail: '/themes/directory-v9.png',
    siteShape: 'multipage',
    heroStyle: 'Centered search hero with a wide home photo and town pill chips, stone and ivory with deep green and brass.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'html', 'cards', 'columns', 'cta', 'footer'],
        modules: ['directory', 'categories', 'newsletter'],
      },
      {
        name: 'Detail Pages',
        sections: ['nav', 'heading', 'cards', 'cta', 'footer'],
        modules: ['directory', 'categories', 'newsletter'],
      },
    ],
  },
  {
    id: 'directory-v10',
    category: 'directory',
    name: 'LedgerLine Directory',
    tagline: 'Sidebar-led directory in slate + brass with practice-area sidebar, firm listing rows and estimate CTA band',
    thumbnail: '/themes/directory-v10.png',
    siteShape: 'multipage',
    heroStyle: 'Sidebar-led directory - a dark left sidebar with the practice-area list beside firm listing rows; brass estimate band below.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'html', 'html', 'cta', 'footer'],
        modules: ['directory', 'datatables', 'estimate'],
      },
      {
        name: 'Detail Pages',
        sections: ['nav', 'heading', 'cards', 'cta', 'footer'],
        modules: ['directory', 'datatables', 'estimate'],
      },
    ],
  },
  {
    id: 'directory-v11',
    category: 'directory',
    name: 'Berks Gather Directory',
    tagline: 'Playful rounded directory in blush + plum + cream with pill filters, vendor photo cards and plan-your-day steps',
    thumbnail: '/themes/directory-v11.png',
    siteShape: 'multipage',
    heroStyle: 'Rounded hero with a pill filter strip on blush, plum and cream; vendor-category photo cards below.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'cards', 'benefits', 'cta', 'footer'],
        modules: ['directory', 'categories', 'events', 'newsletter'],
      },
      {
        name: 'Detail Pages',
        sections: ['nav', 'heading', 'cards', 'cta', 'footer'],
        modules: ['directory', 'categories', 'events', 'newsletter'],
      },
    ],
  },
  {
    id: 'directory-v12',
    category: 'directory',
    name: 'Berks Move Directory',
    tagline: 'Dark athletic directory on charcoal with volt accent, bold type, studio photo cards and this-week band',
    thumbnail: '/themes/directory-v12.png',
    siteShape: 'multipage',
    heroStyle: 'Dark athletic hero with a class-type chip strip on charcoal with volt yellow-green; studio photo cards below.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'cards', 'html', 'cta', 'footer'],
        modules: ['directory', 'categories', 'offers'],
      },
      {
        name: 'Detail Pages',
        sections: ['nav', 'heading', 'cards', 'cta', 'footer'],
        modules: ['directory', 'categories', 'offers'],
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
    id: 'store-v5',
    category: 'store',
    name: 'Oley Valley Bake Shop',
    tagline: 'Warm wheat/cream serif bakery store: announcement bar, split hero with photo, 4-photo product grid (See in Store, no prices), cake-enquiry strip',
    thumbnail: '/themes/store-v5.png',
    siteShape: 'multipage',
    heroStyle: 'Split hero - serif headline and order-ahead CTAs on the left, a bakery-case photo on the right; announcement bar above the nav.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'image', 'cards', 'cta', 'footer'],
        modules: ['ecommerce', 'offers', 'newsletter'],
      },
      {
        name: 'Detail Pages',
        sections: ['nav', 'heading', 'cards', 'cta', 'footer'],
        modules: ['ecommerce', 'offers', 'newsletter'],
      },
    ],
  },
  {
    id: 'store-v6',
    category: 'store',
    name: 'Paw & Pantry',
    tagline: 'Warm orange + cream rounded pet supply store with category cards, photo product grid and grooming split section',
    thumbnail: '/themes/store-v6.png',
    siteShape: 'multipage',
    heroStyle: 'Split hero - headline and CTAs beside a pet-store photo, warm orange on cream; category cards below.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'cards', 'cards', 'text_image', 'cta', 'footer'],
        modules: ['ecommerce', 'categories', 'offers', 'newsletter'],
      },
      {
        name: 'Detail Pages',
        sections: ['nav', 'heading', 'cards', 'cta', 'footer'],
        modules: ['ecommerce', 'categories', 'offers', 'newsletter'],
      },
    ],
  },
  {
    id: 'store-v7',
    category: 'store',
    name: 'Keystone Floor & Tile',
    tagline: 'Slate + warm wood flooring showroom with category strip, room-scene product cards and a wide room band',
    thumbnail: '/themes/store-v7.png',
    siteShape: 'multipage',
    heroStyle: 'Split hero - showroom headline beside a room-scene photo, slate and warm wood tones; category pill strip under.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'cards', 'image', 'cta', 'footer'],
        modules: ['ecommerce', 'categories', 'offers'],
      },
      {
        name: 'Detail Pages',
        sections: ['nav', 'heading', 'cards', 'cta', 'footer'],
        modules: ['ecommerce', 'categories', 'offers'],
      },
    ],
  },
  {
    id: 'store-v8',
    category: 'store',
    name: 'Berks Farm & Feed',
    tagline: 'Barn red + cream rustic serif store with category strip, product photo grid, wide farm band and seasonal strip',
    thumbnail: '/themes/store-v8.png',
    siteShape: 'multipage',
    heroStyle: 'Split hero - rustic serif headline beside a farm photo, barn red on cream; category pill strip under.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'html', 'cards', 'image', 'cta', 'footer'],
        modules: ['ecommerce', 'categories', 'offers', 'newsletter'],
      },
      {
        name: 'Detail Pages',
        sections: ['nav', 'heading', 'cards', 'cta', 'footer'],
        modules: ['ecommerce', 'categories', 'offers', 'newsletter'],
      },
    ],
  },
  {
    id: 'store-v9',
    category: 'store',
    name: 'Hearth & Hardware',
    tagline: 'Retro poster hardware store in barn red, cream and ink black with department pill strip, product photo cards and project-advice split panel',
    thumbnail: '/themes/store-v9.png',
    siteShape: 'multipage',
    heroStyle: 'Retro poster hero panel beside a framed shop photo, barn red, cream and ink; department pill strip below.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'banner', 'heading', 'cards', 'text_image', 'cta', 'footer'],
        modules: ['ecommerce', 'categories', 'offers'],
      },
      {
        name: 'Detail Pages',
        sections: ['nav', 'heading', 'cards', 'cta', 'footer'],
        modules: ['ecommerce', 'categories', 'offers'],
      },
    ],
  },
  {
    id: 'store-v10',
    category: 'store',
    name: 'The Bound Bookshop',
    tagline: 'Literary editorial bookshop in ink navy and paper cream, Georgia serif throughout, with staff-picks cards, reading-nook panel and events strip',
    thumbnail: '/themes/store-v10.png',
    siteShape: 'multipage',
    heroStyle: 'Centered serif masthead with a ruled nav row; editorial hero beside a tall shelves photo, ink navy on paper cream.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'heading', 'cards', 'text_image', 'cards', 'cta', 'footer'],
        modules: ['ecommerce', 'blog', 'newsletter'],
      },
      {
        name: 'Detail Pages',
        sections: ['nav', 'heading', 'cards', 'cta', 'footer'],
        modules: ['ecommerce', 'blog', 'newsletter'],
      },
    ],
  },
  {
    id: 'store-v11',
    category: 'store',
    name: 'Aurelia & Co.',
    tagline: 'Minimal luxury jewellers in black, gold and white with full-bleed hero photo, macro product grid, gallery row and appointment CTA',
    thumbnail: '/themes/store-v11.png',
    siteShape: 'multipage',
    heroStyle: 'Centered serif intro over a full-bleed wide hero photo, black, gold and white minimal luxury.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'heading', 'hero', 'heading', 'cards', 'gallery', 'cta', 'footer'],
        modules: ['ecommerce', 'gallery', 'bookings'],
      },
      {
        name: 'Detail Pages',
        sections: ['nav', 'heading', 'cards', 'cta', 'footer'],
        modules: ['ecommerce', 'gallery', 'bookings'],
      },
    ],
  },
  {
    id: 'store-v12',
    category: 'store',
    name: 'Press & Fold Cleaners',
    tagline: 'Bright retro laundromat store in teal, coral and white with pill-tagged service cards, numbered how-it-works steps, FAQ row and order-ahead band',
    thumbnail: '/themes/store-v12.png',
    siteShape: 'multipage',
    heroStyle: 'Rounded teal hero panel beside a garment-rail photo, teal and coral retro; service cards below.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'heading', 'cards', 'columns', 'faq', 'cta', 'footer'],
        modules: ['ecommerce', 'faq', 'newsletter'],
      },
      {
        name: 'Detail Pages',
        sections: ['nav', 'heading', 'cards', 'cta', 'footer'],
        modules: ['ecommerce', 'faq', 'newsletter'],
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
    id: 'services-v5',
    category: 'services',
    name: 'Tulpehocken Heating & Air',
    tagline: 'Dark slate + orange HVAC site: hero with white service-request form card, photo band, 6-service grid with orange top rules, FAQ, 2-photo row, orange CTA',
    thumbnail: '/themes/services-v5.png',
    siteShape: 'multipage',
    heroStyle: 'Dark slate hero - headline on the left, a white service-request form card on the right; full-width photo band directly under.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'image', 'services', 'faq', 'image', 'cta', 'footer'],
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
    id: 'services-v6',
    category: 'services',
    name: 'Oley Valley Septic',
    tagline: 'Deep navy + white + safety-amber septic services layout with estimate form hero, services grid, how-it-works and FAQ',
    thumbnail: '/themes/services-v6.png',
    siteShape: 'multipage',
    heroStyle: 'Left-aligned hero - headline beside a tanker photo with an estimate form card alongside; safety-amber accents on deep navy.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'services', 'image', 'columns', 'text_image', 'faq', 'cta', 'footer'],
        modules: ['estimate', 'faq', 'bookings'],
      },
      {
        name: 'Detail Pages',
        sections: ['nav', 'heading', 'cards', 'cta', 'footer'],
        modules: ['estimate', 'faq', 'bookings'],
      },
    ],
  },
  {
    id: 'services-v7',
    category: 'services',
    name: 'Berks Bright Wash',
    tagline: 'Fresh cyan + white pressure washing layout with hero quote-form card, services grid, photo results gallery and FAQ',
    thumbnail: '/themes/services-v7.png',
    siteShape: 'multipage',
    heroStyle: 'Split hero - job photo on the left, a white quote-form card on the right, fresh cyan on white.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'services', 'gallery', 'faq', 'cta', 'footer'],
        modules: ['estimate', 'gallery', 'faq'],
      },
      {
        name: 'Detail Pages',
        sections: ['nav', 'heading', 'cards', 'cta', 'footer'],
        modules: ['estimate', 'gallery', 'faq'],
      },
    ],
  },
  {
    id: 'services-v8',
    category: 'services',
    name: 'Keystone Garage Door Co.',
    tagline: 'Charcoal + red bold services layout with hero service-form card, services grid, doors gallery and FAQ',
    thumbnail: '/themes/services-v8.png',
    siteShape: 'multipage',
    heroStyle: 'Dark charcoal hero panel - headline and a service-request form card over a door photo, red accents.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'services', 'gallery', 'faq', 'cta', 'footer'],
        modules: ['estimate', 'gallery', 'faq', 'bookings'],
      },
      {
        name: 'Detail Pages',
        sections: ['nav', 'heading', 'cards', 'cta', 'footer'],
        modules: ['estimate', 'gallery', 'faq', 'bookings'],
      },
    ],
  },
  {
    id: 'services-v9',
    category: 'services',
    name: 'Creekside Pest Defense',
    tagline: 'Leaf green split-hero services layout with estimate form card beside hero photo, numbered services grid, photo row, steps and FAQ',
    thumbnail: '/themes/services-v9.png',
    siteShape: 'multipage',
    heroStyle: 'Split hero - dark-green headline band, with a job photo beside an estimate form card; leaf green and white.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'services', 'gallery', 'text', 'faq', 'image', 'cta', 'footer'],
        modules: ['estimate', 'faq', 'bookings'],
      },
      {
        name: 'Detail Pages',
        sections: ['nav', 'heading', 'cards', 'cta', 'footer'],
        modules: ['estimate', 'faq', 'bookings'],
      },
    ],
  },
  {
    id: 'services-v10',
    category: 'services',
    name: 'Hamburg Moving Co.',
    tagline: 'Bold poster services layout in royal blue and orange with huge headlines, services cards, full photo row, 3-step plan and estimate form',
    thumbnail: '/themes/services-v10.png',
    siteShape: 'multipage',
    heroStyle: 'Bold poster hero band - giant uppercase headline and dual CTAs in royal blue and orange; full-width photo under.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'image', 'services', 'gallery', 'text', 'text_image', 'faq', 'image', 'cta', 'footer'],
        modules: ['estimate', 'faq', 'bookings'],
      },
      {
        name: 'Detail Pages',
        sections: ['nav', 'heading', 'cards', 'cta', 'footer'],
        modules: ['estimate', 'faq', 'bookings'],
      },
    ],
  },
  {
    id: 'services-v11',
    category: 'services',
    name: 'River Road Towing',
    tagline: 'Dark roadside services layout on near-black with hi-vis yellow, giant 24/7 banner band, services grid, photo strip and service-area towns',
    thumbnail: '/themes/services-v11.png',
    siteShape: 'multipage',
    heroStyle: 'Near-black roadside hero - job photo beside a request-a-truck form card, hi-vis yellow; giant 24/7 banner band above.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'banner', 'hero', 'services', 'gallery', 'text', 'faq', 'image', 'cta', 'footer'],
        modules: ['calltracking', 'estimate', 'faq'],
      },
      {
        name: 'Detail Pages',
        sections: ['nav', 'heading', 'cards', 'cta', 'footer'],
        modules: ['calltracking', 'estimate', 'faq'],
      },
    ],
  },
  {
    id: 'services-v12',
    category: 'services',
    name: 'Blue Mountain Concrete',
    tagline: 'Industrial photo-grid services layout in concrete gray and safety orange, gallery-led project cards, services list split, process steps and estimate form',
    thumbnail: '/themes/services-v12.png',
    siteShape: 'multipage',
    heroStyle: 'Slate hero band - bold uppercase headline and dual CTAs in concrete gray and safety orange; project photo grid leads.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'gallery', 'services', 'text', 'text_image', 'faq', 'footer'],
        modules: ['gallery', 'estimate', 'faq'],
      },
      {
        name: 'Detail Pages',
        sections: ['nav', 'heading', 'cards', 'cta', 'footer'],
        modules: ['gallery', 'estimate', 'faq'],
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
    id: 'restaurant-v5',
    category: 'restaurant',
    name: 'Casa Penn Cantina',
    tagline: 'Dark chili-brown + teal Mexican cantina: split hero with food photo, 4-photo dish grid (no prices), teal catering / chili visit split panels',
    thumbnail: '/themes/restaurant-v5.png',
    siteShape: 'multipage',
    heroStyle: 'Split hero - cantina headline and CTAs on the left, a plated-dish photo on the right, on dark chili-brown with teal accents.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'image', 'cards', 'columns', 'footer'],
        modules: ['menu', 'offers', 'bookings'],
      },
      {
        name: 'Detail Pages',
        sections: ['nav', 'heading', 'cards', 'cta', 'footer'],
        modules: ['menu', 'offers', 'bookings'],
      },
    ],
  },
  {
    id: 'restaurant-v6',
    category: 'restaurant',
    name: 'Nonna\'s on Penn',
    tagline: 'Tomato red + cream Italian trattoria with menu list, 4-photo gallery strip and interior split section',
    thumbnail: '/themes/restaurant-v6.png',
    siteShape: 'multipage',
    heroStyle: 'Split hero - trattoria headline beside an oven photo, tomato red on cream; priced menu panel below.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'text', 'gallery', 'text_image', 'cta', 'footer'],
        modules: ['menu', 'gallery', 'bookings', 'googlereviews'],
      },
      {
        name: 'Detail Pages',
        sections: ['nav', 'heading', 'cards', 'cta', 'footer'],
        modules: ['menu', 'gallery', 'bookings', 'googlereviews'],
      },
    ],
  },
  {
    id: 'restaurant-v7',
    category: 'restaurant',
    name: 'Hawk Mountain Coffee House',
    tagline: 'Warm espresso brown + cream cosy coffee house with dark menu board, photo gallery strip and hours/visit cards',
    thumbnail: '/themes/restaurant-v7.png',
    siteShape: 'multipage',
    heroStyle: 'Split hero - cafe headline beside an interior photo on espresso brown and cream; dark menu-board panel below.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'text', 'gallery', 'text_image', 'cards', 'footer'],
        modules: ['menu', 'gallery', 'testimonials'],
      },
      {
        name: 'Detail Pages',
        sections: ['nav', 'heading', 'cards', 'cta', 'footer'],
        modules: ['menu', 'gallery', 'testimonials'],
      },
    ],
  },
  {
    id: 'restaurant-v8',
    category: 'restaurant',
    name: 'Smokehaus Berks',
    tagline: 'Dark charcoal + ember orange BBQ smokehouse with bold type, menu-led layout and 5-photo gallery strip',
    thumbnail: '/themes/restaurant-v8.png',
    siteShape: 'multipage',
    heroStyle: 'Split hero - bold uppercase headline beside a grill photo on near-black with ember orange.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'html', 'gallery', 'cta', 'footer'],
        modules: ['menu', 'gallery', 'offers', 'bookings'],
      },
      {
        name: 'Detail Pages',
        sections: ['nav', 'heading', 'cards', 'cta', 'footer'],
        modules: ['menu', 'gallery', 'offers', 'bookings'],
      },
    ],
  },
  {
    id: 'restaurant-v9',
    category: 'restaurant',
    name: 'Scoops on Main',
    tagline: 'Pastel retro soda-shop (pink + mint + cream): rounded flavour cards with photos, sundae list, mint Sweet of the Week band and footer',
    thumbnail: '/themes/restaurant-v9.png',
    siteShape: 'multipage',
    heroStyle: 'Pastel soda-shop hero - serif headline with flavour photo cards below, pink, mint and cream.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'cards', 'banner', 'text', 'gallery', 'footer'],
        modules: ['menu', 'gallery', 'offers'],
      },
      {
        name: 'Detail Pages',
        sections: ['nav', 'heading', 'cards', 'cta', 'footer'],
        modules: ['menu', 'gallery', 'offers'],
      },
    ],
  },
  {
    id: 'restaurant-v10',
    category: 'restaurant',
    name: 'Fifth Street Deli & Butcher',
    tagline: 'Classic deli (forest green + cream + butcher-paper tan): dark menu-board panel, counter-favourites photo cards, catering split and footer',
    thumbnail: '/themes/restaurant-v10.png',
    siteShape: 'multipage',
    heroStyle: 'Classic deli hero on forest green and cream; dark menu-board panel below.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'html', 'cards', 'text_image', 'html', 'gallery', 'footer'],
        modules: ['menu', 'gallery', 'newsletter'],
      },
      {
        name: 'Detail Pages',
        sections: ['nav', 'heading', 'cards', 'cta', 'footer'],
        modules: ['menu', 'gallery', 'newsletter'],
      },
    ],
  },
  {
    id: 'restaurant-v11',
    category: 'restaurant',
    name: 'The Rolling Hearth',
    tagline: 'Street poster (black + flame orange + cream): bold type, weekly location schedule strip, menu cards with photos and find-the-truck CTA',
    thumbnail: '/themes/restaurant-v11.png',
    siteShape: 'multipage',
    heroStyle: 'Street-poster hero - bold uppercase headline on black and flame orange; weekly location schedule strip under.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'banner', 'cards', 'cta', 'footer'],
        modules: ['menu', 'events', 'socialfeed'],
      },
      {
        name: 'Detail Pages',
        sections: ['nav', 'heading', 'cards', 'cta', 'footer'],
        modules: ['menu', 'events', 'socialfeed'],
      },
    ],
  },
  {
    id: 'restaurant-v12',
    category: 'restaurant',
    name: 'Manatawny Creek Winery',
    tagline: 'Minimal luxury (deep burgundy + ivory): full-bleed vineyard hero, tasting-room story split, wine list with style notes only and visit band',
    thumbnail: '/themes/restaurant-v12.png',
    siteShape: 'multipage',
    heroStyle: 'Full-bleed vineyard photo hero with a burgundy caption band; minimal luxury serif type on ivory.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'text_image', 'text', 'gallery', 'cta', 'gallery', 'footer'],
        modules: ['menu', 'gallery', 'bookings', 'events'],
      },
      {
        name: 'Detail Pages',
        sections: ['nav', 'heading', 'cards', 'cta', 'footer'],
        modules: ['menu', 'gallery', 'bookings', 'events'],
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
    id: 'art-v4',
    category: 'art',
    name: 'Crown & Fade Barber Portfolio',
    tagline: 'Black + gold gallery-first barber portfolio: centred hero, 6-photo work gallery with labels, services / booking split, square gold CTAs',
    thumbnail: '/themes/art-v4.png',
    siteShape: 'multipage',
    heroStyle: 'Centered hero on black with gold accents; a six-photo labelled work gallery leads the page.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'gallery', 'columns', 'cta', 'footer'],
        modules: ['gallery', 'bookings', 'socialfeed'],
      },
      {
        name: 'Detail Pages',
        sections: ['nav', 'heading', 'cards', 'cta', 'footer'],
        modules: ['gallery', 'bookings', 'socialfeed'],
      },
    ],
  },
  {
    id: 'art-v5',
    category: 'art',
    name: 'Willow Salon Lookbook',
    tagline: 'Blush/cream serif salon lookbook: split hero with large photo, 6-tile lookbook grid, services / booking split, plum CTA',
    thumbnail: '/themes/art-v5.png',
    siteShape: 'multipage',
    heroStyle: 'Split hero - serif headline on blush cream beside a large salon photo; lookbook grid below.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'image', 'gallery', 'columns', 'cta', 'footer'],
        modules: ['gallery', 'bookings', 'socialfeed'],
      },
      {
        name: 'Detail Pages',
        sections: ['nav', 'heading', 'cards', 'cta', 'footer'],
        modules: ['gallery', 'bookings', 'socialfeed'],
      },
    ],
  },
  {
    id: 'art-v6',
    category: 'art',
    name: 'Ink & Iron Studio',
    tagline: 'Near-black + crimson dark tattoo studio with split hero, 2x2 dark gallery grid, artist about strip and booking CTA',
    thumbnail: '/themes/art-v6.png',
    siteShape: 'multipage',
    heroStyle: 'Dark split hero - crimson top bar, headline beside a studio photo on near-black.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'gallery', 'text_image', 'cards', 'cta', 'footer'],
        modules: ['gallery', 'bookings', 'team'],
      },
      {
        name: 'Detail Pages',
        sections: ['nav', 'heading', 'cards', 'cta', 'footer'],
        modules: ['gallery', 'bookings', 'team'],
      },
    ],
  },
  {
    id: 'art-v7',
    category: 'art',
    name: 'Blooms by the Creek',
    tagline: 'Soft blush + sage florist portfolio: split hero, occasions pill strip, 6-photo arrangement gallery grid, about split and CTA strip.',
    thumbnail: '/themes/art-v7.png',
    siteShape: 'multipage',
    heroStyle: 'Split hero - airy serif headline beside an arrangement photo, blush and sage; occasions pill strip under.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'heading', 'gallery', 'text_image', 'cta', 'footer'],
        modules: ['gallery', 'newsletter', 'chatbot'],
      },
      {
        name: 'Detail Pages',
        sections: ['nav', 'heading', 'cards', 'cta', 'footer'],
        modules: ['gallery', 'newsletter', 'chatbot'],
      },
    ],
  },
  {
    id: 'art-v8',
    category: 'art',
    name: 'Hearthside Interiors',
    tagline: 'Warm neutral editorial (bone, clay, ink) interior portfolio: split hero, 2x2 room grid, dark process strip, about split and clay CTA',
    thumbnail: '/themes/art-v8.png',
    siteShape: 'multipage',
    heroStyle: 'Split hero - editorial serif headline beside a room photo in bone, clay and ink.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'gallery', 'html', 'text_image', 'html', 'cta', 'footer'],
        modules: ['gallery', 'newsletter'],
      },
      {
        name: 'Detail Pages',
        sections: ['nav', 'heading', 'cards', 'cta', 'footer'],
        modules: ['gallery', 'newsletter'],
      },
    ],
  },
  {
    id: 'art-v9',
    category: 'art',
    name: 'Riverbend Dance Studio',
    tagline: 'Fluid editorial dance portfolio in charcoal, blush and ivory: oversized serif hero, 3 program cards, about split and wide performance photo',
    thumbnail: '/themes/art-v9.png',
    siteShape: 'multipage',
    heroStyle: 'Asymmetric photo-led hero with oversized serif headlines, charcoal, blush and ivory.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'benefits', 'cards', 'text_image', 'gallery', 'cta', 'footer'],
        modules: ['gallery', 'bookings', 'newsletter'],
      },
      {
        name: 'Detail Pages',
        sections: ['nav', 'heading', 'cards', 'cta', 'footer'],
        modules: ['gallery', 'bookings', 'newsletter'],
      },
    ],
  },
  {
    id: 'art-v10',
    category: 'art',
    name: 'Willow Creek Stables',
    tagline: 'Rustic editorial equestrian portfolio in leather brown, cream and sage: split hero, boarding/training/lessons cards, farm-story split and FAQ band',
    thumbnail: '/themes/art-v10.png',
    siteShape: 'multipage',
    heroStyle: 'Split hero - serif headline beside a stable photo, leather brown, cream and sage.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'cards', 'text_image', 'gallery', 'faq', 'cta', 'footer'],
        modules: ['gallery', 'bookings', 'faq'],
      },
      {
        name: 'Detail Pages',
        sections: ['nav', 'heading', 'cards', 'cta', 'footer'],
        modules: ['gallery', 'bookings', 'faq'],
      },
    ],
  },
  {
    id: 'art-v11',
    category: 'art',
    name: 'The Iron Works Gallery',
    tagline: 'Stark minimal gallery portfolio in white, black and one red accent: full-width exhibition hero, 3 bordered exhibition cards and visit/hours band',
    thumbnail: '/themes/art-v11.png',
    siteShape: 'multipage',
    heroStyle: 'Full-width current-exhibition photo hero with a black caption bar; stark white and black with a red accent.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'cards', 'gallery', 'text_image', 'cta', 'footer'],
        modules: ['gallery', 'events', 'newsletter'],
      },
      {
        name: 'Detail Pages',
        sections: ['nav', 'heading', 'cards', 'cta', 'footer'],
        modules: ['gallery', 'events', 'newsletter'],
      },
    ],
  },
  {
    id: 'art-v12',
    category: 'art',
    name: 'Liberty K9 Training',
    tagline: 'Field editorial dog-training portfolio in deep green, khaki and orange: split hero, 3 program cards, captioned field photo row and FAQ band',
    thumbnail: '/themes/art-v12.png',
    siteShape: 'multipage',
    heroStyle: 'Split hero - serif headline beside a field-training photo, deep green, khaki and orange.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'cards', 'gallery', 'faq', 'cta', 'footer'],
        modules: ['gallery', 'bookings', 'faq'],
      },
      {
        name: 'Detail Pages',
        sections: ['nav', 'heading', 'cards', 'cta', 'footer'],
        modules: ['gallery', 'bookings', 'faq'],
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
    id: 'courses-v4',
    category: 'courses',
    name: 'Aligned Back Academy',
    tagline: 'Teal/white centred-hero back-health academy: photo band, 4 horizontal course cards with photo thumbs, 3-step learning path, members CTA',
    thumbnail: '/themes/courses-v4.png',
    siteShape: 'multipage',
    heroStyle: 'Centered hero on teal and white with a photo band under it; horizontal course cards with photo thumbnails below.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'image', 'cards', 'columns', 'cta', 'footer'],
        modules: ['courses', 'members', 'newsletter'],
      },
      {
        name: 'Detail Pages',
        sections: ['nav', 'heading', 'cards', 'cta', 'footer'],
        modules: ['courses', 'members', 'newsletter'],
      },
    ],
  },
  {
    id: 'courses-v5',
    category: 'courses',
    name: 'Keystone Homebuyer School',
    tagline: 'Navy + sand serif homebuyer school: split hero with photo, course rows (not cards) each with photo thumb and View Course pill, navy intro CTA',
    thumbnail: '/themes/courses-v5.png',
    siteShape: 'multipage',
    heroStyle: 'Split hero - serif headline beside a home photo; the catalog below is course rows with photo thumbnails, not cards.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'image', 'cards', 'cta', 'footer'],
        modules: ['courses', 'members', 'newsletter'],
      },
      {
        name: 'Detail Pages',
        sections: ['nav', 'heading', 'cards', 'cta', 'footer'],
        modules: ['courses', 'members', 'newsletter'],
      },
    ],
  },
  {
    id: 'courses-v6',
    category: 'courses',
    name: 'Keystone CDL Academy',
    tagline: 'Highway navy + amber bold-sans CDL academy with program cards, 4-step strip, yard split and FAQ grid',
    thumbnail: '/themes/courses-v6.png',
    siteShape: 'multipage',
    heroStyle: 'Split hero - bold headline beside a highway photo, highway navy and amber; program cards below.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'cards', 'columns', 'text_image', 'faq', 'cta', 'footer'],
        modules: ['courses', 'faq'],
      },
      {
        name: 'Detail Pages',
        sections: ['nav', 'heading', 'cards', 'cta', 'footer'],
        modules: ['courses', 'faq'],
      },
    ],
  },
  {
    id: 'courses-v7',
    category: 'courses',
    name: 'Riverfront Music School',
    tagline: 'Deep plum + gold courses: split hero, 3 piano lesson cards with photos, 3-step how-it-works, learning splits and FAQ grid.',
    thumbnail: '/themes/courses-v7.png',
    siteShape: 'multipage',
    heroStyle: 'Split hero - elegant serif headline beside a lesson photo, deep plum and gold.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'cards', 'columns', 'text_image', 'faq', 'cta', 'footer'],
        modules: ['courses', 'faq', 'bookings'],
      },
      {
        name: 'Detail Pages',
        sections: ['nav', 'heading', 'cards', 'cta', 'footer'],
        modules: ['courses', 'faq', 'bookings'],
      },
    ],
  },
  {
    id: 'courses-v8',
    category: 'courses',
    name: 'Berks Safety Training',
    tagline: 'Clean red + white clinical safety courses: hero, 3 course cards, who-should-attend columns, practice split, FAQ and dark CTA',
    thumbnail: '/themes/courses-v8.png',
    siteShape: 'multipage',
    heroStyle: 'Split hero - headline beside a CPR training photo, clean red and white; course cards below.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'cards', 'columns', 'text_image', 'faq', 'cta', 'footer'],
        modules: ['courses', 'faq', 'bookings'],
      },
      {
        name: 'Detail Pages',
        sections: ['nav', 'heading', 'cards', 'cta', 'footer'],
        modules: ['courses', 'faq', 'bookings'],
      },
    ],
  },
  {
    id: 'courses-v9',
    category: 'courses',
    name: 'Berks Driving Academy',
    tagline: 'Road-sign yellow + black + white driving school: yellow hero panel, 3 program cards, black 4-step strip, photo splits, FAQ and CTA',
    thumbnail: '/themes/courses-v9.png',
    siteShape: 'multipage',
    heroStyle: 'Road-sign hero - yellow panel beside an L-plate photo, yellow, black and white signage type.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'cards', 'columns', 'text_image', 'text_image', 'faq', 'cta', 'footer'],
        modules: ['courses', 'bookings', 'faq'],
      },
      {
        name: 'Detail Pages',
        sections: ['nav', 'heading', 'cards', 'cta', 'footer'],
        modules: ['courses', 'bookings', 'faq'],
      },
    ],
  },
  {
    id: 'courses-v10',
    category: 'courses',
    name: 'The Copper Whisk',
    tagline: 'Warm editorial copper + cream + charcoal cooking school: centred hero, 3 class cards, chef\'s-table split, dark schedule band and newsletter CTA',
    thumbnail: '/themes/courses-v10.png',
    siteShape: 'multipage',
    heroStyle: 'Centered hero headline over a wide kitchen photo, copper, cream and charcoal editorial.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'image', 'cards', 'text_image', 'banner', 'text_image', 'cta', 'footer'],
        modules: ['courses', 'events', 'newsletter'],
      },
      {
        name: 'Detail Pages',
        sections: ['nav', 'heading', 'cards', 'cta', 'footer'],
        modules: ['courses', 'events', 'newsletter'],
      },
    ],
  },
  {
    id: 'courses-v11',
    category: 'courses',
    name: 'Bright Futures Tutoring',
    tagline: 'Friendly academic navy + coral + sky tutoring: split hero with pills, 2x2 subject cards, 3-step how-it-works, parent FAQ and coral CTA',
    thumbnail: '/themes/courses-v11.png',
    siteShape: 'multipage',
    heroStyle: 'Split hero with a pill feature row - headline beside a tutoring photo, navy, coral and sky.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'benefits', 'cards', 'columns', 'text_image', 'faq', 'cta', 'footer'],
        modules: ['courses', 'bookings', 'faq'],
      },
      {
        name: 'Detail Pages',
        sections: ['nav', 'heading', 'cards', 'cta', 'footer'],
        modules: ['courses', 'bookings', 'faq'],
      },
    ],
  },
  {
    id: 'courses-v12',
    category: 'courses',
    name: 'Global Roots Language School',
    tagline: 'Colorful global teal + saffron + ink language school: teal hero with greeting pills, 4 language cards, immersion split and pastel level guide',
    thumbnail: '/themes/courses-v12.png',
    siteShape: 'multipage',
    heroStyle: 'Teal hero panel with greeting pills beside a conversation photo; colorful language cards below.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'cards', 'text_image', 'columns', 'cta', 'footer'],
        modules: ['courses', 'members', 'newsletter'],
      },
      {
        name: 'Detail Pages',
        sections: ['nav', 'heading', 'cards', 'cta', 'footer'],
        modules: ['courses', 'members', 'newsletter'],
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
    id: 'events-v4',
    category: 'events',
    name: 'Berks Home & Garden Expo',
    tagline: 'Fresh green/white home expo: centred hero with date chips, wide photo band, 4-photo session cards, day-schedule rows, exhibitor CTA',
    thumbnail: '/themes/events-v4.png',
    siteShape: 'multipage',
    heroStyle: 'Centered hero with date chips on fresh green and white; wide photo band and session cards below.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'image', 'cards', 'text', 'cta', 'footer'],
        modules: ['events', 'directory', 'newsletter'],
      },
      {
        name: 'Detail Pages',
        sections: ['nav', 'heading', 'cards', 'cta', 'footer'],
        modules: ['events', 'directory', 'newsletter'],
      },
    ],
  },
  {
    id: 'events-v5',
    category: 'events',
    name: 'Berks Harvest Market',
    tagline: 'Harvest orange + leaf green serif market theme with event cards, wide produce band and season strip',
    thumbnail: '/themes/events-v5.png',
    siteShape: 'multipage',
    heroStyle: 'Split hero - market headline beside a stall photo with topic pills, harvest orange and leaf green.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'cards', 'image', 'columns', 'cta', 'footer'],
        modules: ['events', 'categories'],
      },
      {
        name: 'Detail Pages',
        sections: ['nav', 'heading', 'cards', 'cta', 'footer'],
        modules: ['events', 'categories'],
      },
    ],
  },
  {
    id: 'events-v6',
    category: 'events',
    name: 'Fairways at Berks',
    tagline: 'Fairway green + gold events venue: centered hero, wide 21/9 course band, 3 event-space cards, 3 outing packages described without prices, CTA.',
    thumbnail: '/themes/events-v6.png',
    siteShape: 'multipage',
    heroStyle: 'Centered hero text over a wide 21/9 golf-course band photo, fairway green and gold.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'image', 'cards', 'columns', 'text_image', 'cta', 'footer'],
        modules: ['events', 'bookings', 'gallery'],
      },
      {
        name: 'Detail Pages',
        sections: ['nav', 'heading', 'cards', 'cta', 'footer'],
        modules: ['events', 'bookings', 'gallery'],
      },
    ],
  },
  {
    id: 'events-v7',
    category: 'events',
    name: 'Riverfront Conference Center',
    tagline: 'Modern slate + teal conference venue: hero, 3 room-capacity cards, wide band photos, dark amenities columns and teal booking CTA',
    thumbnail: '/themes/events-v7.png',
    siteShape: 'multipage',
    heroStyle: 'Split hero - headline beside a conference-room photo, slate and teal with a dark header.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'cards', 'image', 'columns', 'gallery', 'cta', 'footer'],
        modules: ['events', 'bookings', 'gallery'],
      },
      {
        name: 'Detail Pages',
        sections: ['nav', 'heading', 'cards', 'cta', 'footer'],
        modules: ['events', 'bookings', 'gallery'],
      },
    ],
  },
  {
    id: 'events-v8',
    category: 'events',
    name: 'The Miller\'s House Inn',
    tagline: 'Romantic minimal luxury in sage, ivory and gold: full-bleed photo hero, room and gathering cards, weddings story split and sage booking CTA',
    thumbnail: '/themes/events-v8.png',
    siteShape: 'multipage',
    heroStyle: 'Full-bleed photo hero with the centered headline below it, sage, ivory and gold romantic minimal luxury.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'cards', 'text_image', 'gallery', 'cta', 'footer'],
        modules: ['events', 'bookings', 'gallery'],
      },
      {
        name: 'Detail Pages',
        sections: ['nav', 'heading', 'cards', 'cta', 'footer'],
        modules: ['events', 'bookings', 'gallery'],
      },
    ],
  },
  {
    id: 'events-v9',
    category: 'events',
    name: 'Pine Hollow Campground',
    tagline: 'Retro park poster in pine green, cream and rust: badge headings, framed hero photo, pavilion group-event cards, rust season band and wide photo bands',
    thumbnail: '/themes/events-v9.png',
    siteShape: 'multipage',
    heroStyle: 'Split hero - badge-style headline beside a framed campground photo, pine green, cream and rust retro poster.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'cards', 'columns', 'gallery', 'image', 'cta', 'footer'],
        modules: ['events', 'bookings', 'offers'],
      },
      {
        name: 'Detail Pages',
        sections: ['nav', 'heading', 'cards', 'cta', 'footer'],
        modules: ['events', 'bookings', 'offers'],
      },
    ],
  },
  {
    id: 'events-v10',
    category: 'events',
    name: 'Locked In Berks',
    tagline: 'Dark neon mystery in near-black and violet: hero, 3 room cards with difficulty labels, party-events band, FAQ strip and violet booking CTA',
    thumbnail: '/themes/events-v10.png',
    siteShape: 'multipage',
    heroStyle: 'Split hero - headline beside a framed room photo on near-black with violet neon accents.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'cards', 'text_image', 'faq', 'gallery', 'cta', 'footer'],
        modules: ['events', 'bookings', 'faq'],
      },
      {
        name: 'Detail Pages',
        sections: ['nav', 'heading', 'cards', 'cta', 'footer'],
        modules: ['events', 'bookings', 'faq'],
      },
    ],
  },
  {
    id: 'events-v11',
    category: 'events',
    name: 'Berks Bowl & Social',
    tagline: 'Retro bowling in teal, red and cream: hero, 3 party-package cards, dark league-night strip, snack-bar story split and red booking CTA',
    thumbnail: '/themes/events-v11.png',
    siteShape: 'multipage',
    heroStyle: 'Split hero - headline beside a bowling-lane photo, teal, red and cream retro.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'cards', 'columns', 'text_image', 'gallery', 'cta', 'footer'],
        modules: ['events', 'bookings', 'offers'],
      },
      {
        name: 'Detail Pages',
        sections: ['nav', 'heading', 'cards', 'cta', 'footer'],
        modules: ['events', 'bookings', 'offers'],
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
  {
    id: 'blog-v4',
    category: 'blog',
    name: 'Move Well Berks Journal',
    tagline: 'Sage-green newspaper-style therapy journal: top strip, centred masthead with ruled nav, featured story + companion photo, 3-photo story grid, newsletter band',
    thumbnail: '/themes/blog-v4.png',
    siteShape: 'multipage',
    heroStyle: 'Newspaper masthead hero leading a featured story with photo; full-width companion photo and a three-story grid below.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'image', 'cards', 'cta', 'footer'],
        modules: ['blog', 'newsletter', 'comments'],
      },
      {
        name: 'Detail Pages',
        sections: ['nav', 'heading', 'cards', 'cta', 'footer'],
        modules: ['blog', 'newsletter', 'comments'],
      },
    ],
  },
  {
    id: 'blog-v5',
    category: 'blog',
    name: 'The Lawn Letter',
    tagline: 'Fresh green editorial magazine with featured story hero, 2x2 story card grid, topics strip and newsletter band',
    thumbnail: '/themes/blog-v5.png',
    siteShape: 'multipage',
    heroStyle: 'Featured-story split hero - headline beside a lawn photo, fresh green editorial; story grid below.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'cards', 'columns', 'cta', 'footer'],
        modules: ['blog', 'newsletter', 'categories'],
      },
      {
        name: 'Detail Pages',
        sections: ['nav', 'heading', 'cards', 'cta', 'footer'],
        modules: ['blog', 'newsletter', 'categories'],
      },
    ],
  },
  {
    id: 'blog-v6',
    category: 'blog',
    name: 'Detail Culture',
    tagline: 'Dark glossy charcoal + electric blue magazine: featured story with large photo, topic pills, 6-story grid with photos, newsletter strip.',
    thumbnail: '/themes/blog-v6.png',
    siteShape: 'multipage',
    heroStyle: 'Featured story with a large photo beside the headline on dark glossy charcoal with electric blue.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'heading', 'cards', 'text', 'cta', 'footer'],
        modules: ['blog', 'newsletter', 'categories'],
      },
      {
        name: 'Detail Pages',
        sections: ['nav', 'heading', 'cards', 'cta', 'footer'],
        modules: ['blog', 'newsletter', 'categories'],
      },
    ],
  },
  {
    id: 'blog-v7',
    category: 'blog',
    name: 'The Berks Pet Post',
    tagline: 'Warm playful magazine (cream + terracotta): featured story split, 2x2 story card grid, care-topics pill strip and newsletter band',
    thumbnail: '/themes/blog-v7.png',
    siteShape: 'multipage',
    heroStyle: 'Featured-story split hero - serif headline beside a pet photo, cream and terracotta.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'cards', 'html', 'cta', 'footer'],
        modules: ['blog', 'newsletter', 'categories'],
      },
      {
        name: 'Detail Pages',
        sections: ['nav', 'heading', 'cards', 'cta', 'footer'],
        modules: ['blog', 'newsletter', 'categories'],
      },
    ],
  },
  {
    id: 'blog-v8',
    category: 'blog',
    name: 'Strong Roots Journal',
    tagline: 'Bold athletic magazine (black + red + white): split featured story, topics pill strip, 2x2 story card grid, spotlight band and red newsletter band',
    thumbnail: '/themes/blog-v8.png',
    siteShape: 'multipage',
    heroStyle: 'Split featured story - photo beside a black text panel, black, red and white athletic magazine.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'html', 'cards', 'text_image', 'cta', 'footer'],
        modules: ['blog', 'newsletter', 'categories'],
      },
      {
        name: 'Detail Pages',
        sections: ['nav', 'heading', 'cards', 'cta', 'footer'],
        modules: ['blog', 'newsletter', 'categories'],
      },
    ],
  },
  {
    id: 'blog-v9',
    category: 'blog',
    name: 'Orchard Row',
    tagline: 'Harvest editorial magazine (cream + rust + olive, serif): centered masthead, wide featured photo, 2x2 story grid, four seasons columns and newsletter band',
    thumbnail: '/themes/blog-v9.png',
    siteShape: 'multipage',
    heroStyle: 'Centered masthead over a wide featured orchard photo with a two-column intro, cream, rust and olive.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'cards', 'columns', 'text_image', 'cta', 'footer'],
        modules: ['blog', 'newsletter', 'categories'],
      },
      {
        name: 'Detail Pages',
        sections: ['nav', 'heading', 'cards', 'cta', 'footer'],
        modules: ['blog', 'newsletter', 'categories'],
      },
    ],
  },
  {
    id: 'blog-v10',
    category: 'blog',
    name: 'The Vet\'s Notebook',
    tagline: 'Clean clinical magazine (teal + white + warm gray): split featured story, pet-care topics strip, 2x2 story grid, reader Q&A band and newsletter band',
    thumbnail: '/themes/blog-v10.png',
    siteShape: 'multipage',
    heroStyle: 'Split featured story - headline beside a pet-care photo, teal and white clean clinical.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'html', 'cards', 'faq', 'cta', 'footer'],
        modules: ['blog', 'newsletter', 'faq'],
      },
      {
        name: 'Detail Pages',
        sections: ['nav', 'heading', 'cards', 'cta', 'footer'],
        modules: ['blog', 'newsletter', 'faq'],
      },
    ],
  },
  {
    id: 'blog-v11',
    category: 'blog',
    name: 'The Attic Journal',
    tagline: 'Vintage sepia editorial (sepia + ink, Georgia serif masthead): framed featured photo, 2 illustrated cards, text-only numbered story list, editorial columns and newsletter band',
    thumbnail: '/themes/blog-v11.png',
    siteShape: 'multipage',
    heroStyle: 'Framed featured photo with essay text under a serif masthead with double rules; vintage sepia, deliberately photo-light.',
    pages: [
      {
        name: 'Home',
        sections: ['nav', 'hero', 'cards', 'text', 'columns', 'cta', 'footer'],
        modules: ['blog', 'newsletter', 'categories'],
      },
      {
        name: 'Detail Pages',
        sections: ['nav', 'heading', 'cards', 'cta', 'footer'],
        modules: ['blog', 'newsletter', 'categories'],
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
