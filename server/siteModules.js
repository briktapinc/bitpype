'use strict';

/**
 * Site content modules (Blog, Ecommerce, Courses, Gallery, Directory,
 * FAQ, Testimonials, Team, Events, Bookings, Chatbot, Offers, Menu,
 * Careers, Video, Instant Estimate, Social Feed, Call Tracking,
 * Membership, Google Reviews, Data Tables, Charts, Newsletter, QR Code).
 * Workspace SQLite tables per lead; in-page JS embeds (legacy iframe URL kept);
 * portal + MCP CRUD.
 * Gated by plan entitlement `siteModules` (Standard + Premium).
 *
 * Bookings is interactive: weekly hours + services drive a public slot picker
 * (calendar / time management), unlike the appointment *request* form which
 * only collects preferred date/time text.
 */

const crypto = require('crypto');
const QRCode = require('qrcode');
// Batch 154 (§9): deterministic Stripe idempotency keys on this
// module's mutating Stripe calls (server/stripeIdempotency.js).
const { stripeIdempotencyKey } = require('./stripeIdempotency');

const MODULE_TYPES = [
  'blog',
  'ecommerce',
  'courses',
  'gallery',
  'directory',
  'faq',
  'testimonials',
  'team',
  'events',
  'bookings',
  'chatbot',
  'offers',
  'menu',
  'careers',
  'video',
  'estimate',
  'socialfeed',
  'calltracking',
  'members',
  'googlereviews',
  'datatables',
  'charts',
  'newsletter',
  'categories',
  'photocapture',
  'qrcode',
  'checkout',
  'comments',
  'pricing',
];
const MANAGED_ATTR = 'data-bitpype-module';
const EMBED_TYPE_ATTR = 'data-bitpype-module-type';
const EMBED_TOKEN_ATTR = 'data-bitpype-module-token';
const NAV_ATTR = 'data-bitpype-module-nav';
const SCRIPT_ATTR = 'data-bitpype-module-script';
// Batch 131: mod35 — the comments embed renderer (renderComments,
// like toggles, the visitor-token state fetch).
// Batch 142: mod36 — the nav cart element ([data-bp-nav-cart]) and
// the sitewide site_checkout payload stamp.
// Batch 136: mod38 — the booking widget's discount banner + gross /
// −discount / total summary (shipped after Batch 143's mod37 esc
// hardening; the bump is +1 relative to the landed tip, per the
// finisher convention).
// Batch 139: mod39 — the pricing embed renderer (renderPricing);
// the bump is +1 relative to the landed tip, per the finisher
// convention (the parked build's own pin predates the 131–149 chain).
const MODULE_SCRIPT_VER = 'mod39';

const MODULE_META = {
  blog: { label: 'Blog', defaultTitle: 'Blog', defaultSlug: 'blog' },
  ecommerce: { label: 'Shop', defaultTitle: 'Shop', defaultSlug: 'shop' },
  courses: { label: 'Courses', defaultTitle: 'Courses', defaultSlug: 'courses' },
  gallery: { label: 'Gallery', defaultTitle: 'Gallery', defaultSlug: 'gallery' },
  directory: { label: 'Directory', defaultTitle: 'Directory', defaultSlug: 'directory' },
  faq: { label: 'FAQ', defaultTitle: 'FAQ', defaultSlug: 'faq' },
  testimonials: { label: 'Testimonials', defaultTitle: 'Testimonials', defaultSlug: 'testimonials' },
  team: { label: 'Team', defaultTitle: 'Our Team', defaultSlug: 'team' },
  events: { label: 'Events', defaultTitle: 'Events', defaultSlug: 'events' },
  bookings: { label: 'Bookings', defaultTitle: 'Book an Appointment', defaultSlug: 'book' },
  // Floating sitewide widget — no nav page; inject chat-embed.js on all pages.
  chatbot: {
    label: 'Chatbot',
    defaultTitle: 'Chat',
    defaultSlug: '',
    sitewide: true,
    noNav: true,
    overlay: true,
  },
  offers: { label: 'Special Offers', defaultTitle: 'Special Offers', defaultSlug: 'offers' },
  menu: { label: 'Menu / Price List', defaultTitle: 'Menu', defaultSlug: 'menu' },
  careers: { label: 'Careers', defaultTitle: 'Careers', defaultSlug: 'careers' },
  video: { label: 'Video', defaultTitle: 'Videos', defaultSlug: 'videos' },
  estimate: { label: 'Instant Estimate', defaultTitle: 'Get an Estimate', defaultSlug: 'estimate' },
  socialfeed: { label: 'Social Feed', defaultTitle: 'Social Feed', defaultSlug: 'social-feed' },
  calltracking: { label: 'Call Tracking', defaultTitle: 'Call Us', defaultSlug: 'call' },
  members: { label: 'Membership', defaultTitle: 'Members', defaultSlug: 'members' },
  googlereviews: { label: 'Google Reviews', defaultTitle: 'Google Reviews', defaultSlug: 'reviews' },
  datatables: { label: 'Data Tables', defaultTitle: 'Data Table', defaultSlug: 'data-table' },
  charts: { label: 'Charts', defaultTitle: 'Charts', defaultSlug: 'charts' },
  newsletter: { label: 'Newsletter', defaultTitle: 'Newsletter', defaultSlug: 'newsletter' },
  categories: { label: 'Categories', defaultTitle: 'Categories', defaultSlug: 'categories' },
  photocapture: { label: 'Photo Capture', defaultTitle: 'Photo Capture', defaultSlug: 'photo-capture' },
  qrcode: { label: 'QR Code', defaultTitle: 'Scan Me', defaultSlug: 'qr-code' },
  checkout: { label: 'Checkout', defaultTitle: 'Checkout', defaultSlug: 'checkout' },
  comments: { label: 'Comments', defaultTitle: 'Comments', defaultSlug: 'comments' },
  pricing: { label: 'Pricing', defaultTitle: 'Pricing', defaultSlug: 'pricing' },
};

const BOOKING_STATUSES = ['pending', 'confirmed', 'cancelled', 'completed'];
/** Batch 129 (pay-at-booking): how long an unpaid booking holds its
 *  slot while the visitor completes checkout. The hold behaves
 *  exactly like a pending appointment for availability purposes
 *  until it lapses (see releaseExpiredBookingHolds).
 *  Batch 145 (external review F07) — ELY'S RULING (2026-11-05): the
 *  hold STAYS 30 minutes. (A 60-minute variant was built so the
 *  checkout session could be pinned exactly to the hold expiry and
 *  was reverted before deploy on his explicit decision.) Stripe
 *  Checkout Sessions have a MINIMUM lifetime of 30 minutes and the
 *  hold is created before the session, so a 30-minute hold can
 *  never be pinned exactly; checkoutShopLines instead caps the
 *  session at the earliest Stripe-permissible expiry (≈ the hold
 *  expiry), and the refund backstop in applyBookingPaymentTransition
 *  (paid_unfulfilled flag + auto-refund) is the guarantee for any
 *  payment that lands after the hold is released. */
const BOOKING_PAYMENT_HOLD_MINUTES = 30;
/** Stripe Checkout Sessions cannot expire sooner than 30 minutes
 *  after creation; SESSION_EXPIRY_MARGIN_MINUTES is the small clock
 *  safety margin added on top of that floor (Batch 145, F07). */
const STRIPE_SESSION_MIN_MINUTES = 30;
const SESSION_EXPIRY_MARGIN_MINUTES = 1;
const DEFAULT_BOOKING_HOURS = [
  { weekday: 1, start_time: '09:00', end_time: '17:00' },
  { weekday: 2, start_time: '09:00', end_time: '17:00' },
  { weekday: 3, start_time: '09:00', end_time: '17:00' },
  { weekday: 4, start_time: '09:00', end_time: '17:00' },
  { weekday: 5, start_time: '09:00', end_time: '17:00' },
];

function fail(code, message, status) {
  const err = new Error(message);
  err.code = code;
  if (status) err.status = status;
  return err;
}

function assertModuleType(type) {
  const t = String(type || '')
    .trim()
    .toLowerCase();
  if (!MODULE_TYPES.includes(t)) {
    throw fail('VALIDATION', `Unknown module type: ${type}. Use: ${MODULE_TYPES.join(', ')}`);
  }
  return t;
}

function slugify(raw, fallback = 'item') {
  const s = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return s || fallback;
}

function makePublicToken(workspaceId) {
  const ws = Number(workspaceId);
  if (!Number.isInteger(ws) || ws <= 0) throw fail('INVALID', 'workspaceId required for public token');
  return `${ws}_${crypto.randomBytes(18).toString('base64url')}`;
}

function parseWorkspaceFromToken(token) {
  const m = String(token || '').match(/^(\d+)_[A-Za-z0-9_-]+$/);
  return m ? Number(m[1]) : null;
}

function appBaseUrl() {
  // Batch 56: resolve from the canonical public URL (stripeClient.appUrl);
  // the env read remains only as a fallback if the resolver cannot load.
  try {
    return require('./stripeClient').appUrl();
  } catch {
    return String(process.env.APP_URL || '').replace(/\/+$/, '');
  }
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, '&#39;');
}

function ensureTables(db) {
  try {
    require('./chatbot').ensureTables(db);
  } catch {
    /* optional */
  }
  try {
    // Batch 118: newsletter_* tables are owned by server/newsletter.js.
    require('./newsletter').ensureTables(db);
  } catch {
    /* optional */
  }
  try {
    // Batch 131: comments_* / module_comments / module_likes tables
    // are owned by server/comments.js.
    require('./comments').ensureTables(db);
  } catch {
    /* optional */
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS site_module_embeds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      module_type TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      public_token TEXT,
      published INTEGER NOT NULL DEFAULT 0,
      embed_enabled INTEGER NOT NULL DEFAULT 1,
      target_page_slug TEXT NOT NULL DEFAULT '',
      settings_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(lead_id, module_type)
    );

    CREATE TABLE IF NOT EXISTS blog_posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      slug TEXT NOT NULL,
      body_html TEXT NOT NULL DEFAULT '',
      cover_image TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft',
      published_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(lead_id, slug)
    );

    CREATE TABLE IF NOT EXISTS ecommerce_products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      price_cents INTEGER NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'USD',
      image_url TEXT NOT NULL DEFAULT '',
      checkout_url TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(lead_id, slug)
    );

    CREATE TABLE IF NOT EXISTS ecommerce_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      product_id INTEGER,
      product_name TEXT NOT NULL DEFAULT '',
      amount_cents INTEGER NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'USD',
      status TEXT NOT NULL DEFAULT 'pending',
      stripe_session_id TEXT NOT NULL DEFAULT '',
      stripe_payment_intent TEXT NOT NULL DEFAULT '',
      stripe_key_source TEXT NOT NULL DEFAULT '',
      customer_email TEXT NOT NULL DEFAULT '',
      variant_id INTEGER,
      variant_label TEXT NOT NULL DEFAULT '',
      gross_amount_cents INTEGER,
      discount_amount_cents INTEGER NOT NULL DEFAULT 0,
      discount_kind TEXT NOT NULL DEFAULT '',
      discount_value INTEGER NOT NULL DEFAULT 0,
      discount_label TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    /* Batch 127 — product variants. Option groups are the axes a
     * product is sold by (up to 2: "Pot", "Size"); each group owns
     * ordered values; a variant is one combination of values and is
     * the purchasable unit (own price, SKU, availability). Products
     * with no option groups keep the single-price behavior they have
     * always had — the variant tables simply stay empty for them. */
    /* Batch 145 (external review F06): processed-event receipts for
     * tenant shop webhook events. Stripe delivers at-least-once and
     * unordered; the receipt makes a redelivery of an already-applied
     * event id a strict no-op (the terminal-state guards below are
     * the second line of defense). */
    CREATE TABLE IF NOT EXISTS shop_processed_stripe_events (
      event_id TEXT NOT NULL PRIMARY KEY,
      type TEXT NOT NULL DEFAULT '',
      order_id INTEGER,
      status TEXT NOT NULL DEFAULT '',
      processed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS ecommerce_product_options (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS ecommerce_product_option_values (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      option_id INTEGER NOT NULL,
      value TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS ecommerce_product_variants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      combo_key TEXT NOT NULL,
      option_value_ids TEXT NOT NULL DEFAULT '[]',
      label_override TEXT NOT NULL DEFAULT '',
      sku TEXT NOT NULL DEFAULT '',
      price_cents INTEGER NOT NULL DEFAULT 0,
      available INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(product_id, combo_key)
    );

    CREATE TABLE IF NOT EXISTS courses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      slug TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      enrollment_url TEXT NOT NULL DEFAULT '',
      cover_image TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(lead_id, slug)
    );

    CREATE TABLE IF NOT EXISTS course_lessons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      course_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      body_html TEXT NOT NULL DEFAULT '',
      lesson_url TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS gallery_albums (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      slug TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(lead_id, slug)
    );

    CREATE TABLE IF NOT EXISTS gallery_images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      album_id INTEGER NOT NULL,
      image_url TEXT NOT NULL,
      caption TEXT NOT NULL DEFAULT '',
      price_cents INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS directory_listings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      contact_email TEXT NOT NULL DEFAULT '',
      contact_phone TEXT NOT NULL DEFAULT '',
      website_url TEXT NOT NULL DEFAULT '',
      image_url TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS faq_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      question TEXT NOT NULL,
      answer_html TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS testimonials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      quote TEXT NOT NULL,
      author_name TEXT NOT NULL DEFAULT '',
      author_title TEXT NOT NULL DEFAULT '',
      author_company TEXT NOT NULL DEFAULT '',
      rating INTEGER NOT NULL DEFAULT 0,
      image_url TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS team_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      role_title TEXT NOT NULL DEFAULT '',
      bio TEXT NOT NULL DEFAULT '',
      image_url TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      social_url TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(lead_id, slug)
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      slug TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      starts_at TEXT NOT NULL DEFAULT '',
      ends_at TEXT NOT NULL DEFAULT '',
      location TEXT NOT NULL DEFAULT '',
      image_url TEXT NOT NULL DEFAULT '',
      ticket_url TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(lead_id, slug)
    );

    CREATE TABLE IF NOT EXISTS offers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      code TEXT NOT NULL DEFAULT '',
      terms TEXT NOT NULL DEFAULT '',
      expires_at TEXT NOT NULL DEFAULT '',
      image_url TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS menu_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'published',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS menu_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      category_id INTEGER,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      price_text TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS careers_postings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      employment_type TEXT NOT NULL DEFAULT 'Full-time',
      location TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      apply_mode TEXT NOT NULL DEFAULT 'email',
      apply_target TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS video_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      url TEXT NOT NULL DEFAULT '',
      provider TEXT NOT NULL DEFAULT '',
      video_id TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      thumbnail_url TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS estimate_configs (
      lead_id INTEGER PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      intro TEXT NOT NULL DEFAULT '',
      service_label TEXT NOT NULL DEFAULT '',
      base_price_cents INTEGER NOT NULL DEFAULT 0,
      display_mode TEXT NOT NULL DEFAULT 'exact',
      range_percent INTEGER NOT NULL DEFAULT 15,
      disclaimer TEXT NOT NULL DEFAULT '',
      submit_label TEXT NOT NULL DEFAULT 'Send my estimate',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS estimate_options (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      label TEXT NOT NULL,
      price_cents INTEGER NOT NULL DEFAULT 0,
      input_type TEXT NOT NULL DEFAULT 'checkbox',
      choices_json TEXT NOT NULL DEFAULT '[]',
      active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS estimate_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      contact_id INTEGER,
      name TEXT NOT NULL,
      email TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      selections_json TEXT NOT NULL DEFAULT '[]',
      estimate_cents INTEGER NOT NULL DEFAULT 0,
      display_mode TEXT NOT NULL DEFAULT 'exact',
      status TEXT NOT NULL DEFAULT 'new',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Batch 125: Photo Capture — one config row per lead plus the
    -- moderated visitor submissions. Photos themselves are stored by
    -- the shared module-asset pipeline (images/module-* in the site
    -- export); image_src is that stored path, image_url the absolute
    -- public URL when one was minted at upload time.
    CREATE TABLE IF NOT EXISTS photocapture_configs (
      lead_id INTEGER PRIMARY KEY,
      heading TEXT NOT NULL DEFAULT 'Share your photo',
      intro TEXT NOT NULL DEFAULT '',
      submit_label TEXT NOT NULL DEFAULT 'Send photo',
      success_message TEXT NOT NULL DEFAULT 'Thanks — your photo is in.',
      show_approved INTEGER NOT NULL DEFAULT 0,
      grid_limit INTEGER NOT NULL DEFAULT 12,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS photocapture_submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      message TEXT NOT NULL DEFAULT '',
      image_url TEXT NOT NULL DEFAULT '',
      image_src TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      gallery_image_id INTEGER,
      page_slug TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS socialfeed_configs (
      lead_id INTEGER PRIMARY KEY,
      networks TEXT NOT NULL DEFAULT 'both',
      max_posts INTEGER NOT NULL DEFAULT 6,
      layout TEXT NOT NULL DEFAULT 'grid',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS socialfeed_cache (
      lead_id INTEGER PRIMARY KEY,
      items_json TEXT NOT NULL DEFAULT '[]',
      fetched_at TEXT,
      last_error TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS googlereviews_configs (
      lead_id INTEGER PRIMARY KEY,
      place_id TEXT NOT NULL DEFAULT '',
      max_reviews INTEGER NOT NULL DEFAULT 5,
      min_rating REAL NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS googlereviews_cache (
      lead_id INTEGER PRIMARY KEY,
      payload_json TEXT NOT NULL DEFAULT '',
      fetched_at TEXT,
      last_error TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Batch 158: reviews → social dedupe map. A review becomes a
    -- social-calendar draft at most once, ever; review_key is the
    -- Places review name resource id when the cached payload carries
    -- one, else a sha256 of author+publish_time+text.
    CREATE TABLE IF NOT EXISTS googlereviews_social_posts (
      lead_id INTEGER NOT NULL,
      review_key TEXT NOT NULL,
      social_post_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (lead_id, review_key)
    );

    CREATE TABLE IF NOT EXISTS datatable_configs (
      lead_id INTEGER PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      columns_json TEXT NOT NULL DEFAULT '[]',
      display_json TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS datatable_rows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      values_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'published',
      source TEXT NOT NULL DEFAULT 'owner',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS charts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      chart_type TEXT NOT NULL DEFAULT 'bar',
      source TEXT NOT NULL DEFAULT 'manual',
      config_json TEXT NOT NULL DEFAULT '{}',
      data_json TEXT NOT NULL DEFAULT '',
      style_json TEXT NOT NULL DEFAULT '{}',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- QR Code module (Batch 126): stored codes whose page/module targets
    -- are REFERENCES (a page slug / a module type), resolved against the
    -- CURRENT site structure at render time — a renamed page never strands
    -- a printed code. Literal targets (url/tel/email) keep their value in
    -- target_ref; WiFi keeps structured fields (the password is owner
    -- config, rendered only inside the generated code image).
    CREATE TABLE IF NOT EXISTS module_qrcodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      target_kind TEXT NOT NULL DEFAULT 'page',
      target_ref TEXT NOT NULL DEFAULT '',
      target_title TEXT NOT NULL DEFAULT '',
      wifi_ssid TEXT NOT NULL DEFAULT '',
      wifi_auth TEXT NOT NULL DEFAULT 'WPA',
      wifi_password TEXT NOT NULL DEFAULT '',
      wifi_hidden INTEGER NOT NULL DEFAULT 0,
      size INTEGER NOT NULL DEFAULT 512,
      fg_color TEXT NOT NULL DEFAULT '#111111',
      bg_color TEXT NOT NULL DEFAULT '#ffffff',
      ec_level TEXT NOT NULL DEFAULT 'M',
      status TEXT NOT NULL DEFAULT 'draft',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS calltracking_configs (
      lead_id INTEGER PRIMARY KEY,
      display_number TEXT NOT NULL DEFAULT '',
      cta_text TEXT NOT NULL DEFAULT 'Call us',
      redirect_enabled INTEGER NOT NULL DEFAULT 1,
      redirect_number TEXT NOT NULL DEFAULT '',
      record_calls INTEGER NOT NULL DEFAULT 0,
      notify_email INTEGER NOT NULL DEFAULT 1,
      voicemail_enabled INTEGER NOT NULL DEFAULT 1,
      rotate_enabled INTEGER NOT NULL DEFAULT 0,
      rotate_counter INTEGER NOT NULL DEFAULT 0,
      twilio_number_sid TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Twilio number pool (Batch 26d): the numbers staff purchased on the
    -- workspace's Twilio account, registered here so forwarding setups
    -- can claim them (as a primary display number or in a rotation set)
    -- with exclusivity. The db file is per-workspace; workspace_id is
    -- carried anyway for clarity.
    CREATE TABLE IF NOT EXISTS twilio_numbers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL DEFAULT 0,
      phone_number TEXT NOT NULL DEFAULT '',
      label TEXT NOT NULL DEFAULT '',
      twilio_sid TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(workspace_id, phone_number)
    );

    -- Rotation set for one forwarding setup (Batch 26d): up to 5 pool
    -- numbers that rotate on the site's call button; every one of them
    -- forwards to the setup's single redirect_number because the voice
    -- route resolves the config by lead.
    CREATE TABLE IF NOT EXISTS calltracking_rotation_numbers (
      lead_id INTEGER NOT NULL,
      phone_number TEXT NOT NULL DEFAULT '',
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (lead_id, phone_number)
    );

    CREATE TABLE IF NOT EXISTS call_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      call_sid TEXT NOT NULL UNIQUE,
      from_number TEXT NOT NULL DEFAULT '',
      to_number TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'initiated',
      duration_seconds INTEGER,
      recording_sid TEXT NOT NULL DEFAULT '',
      recording_url TEXT NOT NULL DEFAULT '',
      recording_duration INTEGER,
      transcript TEXT NOT NULL DEFAULT '',
      transcript_status TEXT NOT NULL DEFAULT 'none',
      counted INTEGER NOT NULL DEFAULT 0,
      transcription_billed INTEGER NOT NULL DEFAULT 0,
      notify_status TEXT NOT NULL DEFAULT 'none',
      is_voicemail INTEGER NOT NULL DEFAULT 0,
      voicemail_notify_status TEXT NOT NULL DEFAULT 'none',
      website_id INTEGER,
      tenant_lead_id INTEGER,
      rental_id INTEGER,
      verified INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_call_logs_lead ON call_logs(lead_id, id DESC);

    CREATE TABLE IF NOT EXISTS calls_billing (
      lead_id INTEGER NOT NULL,
      month TEXT NOT NULL,
      last_billed_threshold INTEGER NOT NULL DEFAULT 0,
      overage_due_credits INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (lead_id, month)
    );

    -- Lead calling (Batch 162): staff follow-up notes from the lead
    -- Contact page. They live beside call_logs (same workspace store
    -- the lead drawer/pipeline read) so one lead's calls + notes form
    -- a single chronological follow-up timeline.
    CREATE TABLE IF NOT EXISTS lead_contact_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      staff_user_id INTEGER,
      staff_name TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_lead_contact_notes_lead ON lead_contact_notes(lead_id, id DESC);

    CREATE TABLE IF NOT EXISTS booking_settings (
      lead_id INTEGER PRIMARY KEY,
      timezone TEXT NOT NULL DEFAULT 'America/New_York',
      slot_interval_minutes INTEGER NOT NULL DEFAULT 30,
      min_notice_hours INTEGER NOT NULL DEFAULT 2,
      max_days_ahead INTEGER NOT NULL DEFAULT 60,
      auto_confirm INTEGER NOT NULL DEFAULT 0,
      discount_enabled INTEGER NOT NULL DEFAULT 0,
      discount_kind TEXT NOT NULL DEFAULT 'percent',
      discount_value INTEGER NOT NULL DEFAULT 0,
      discount_label TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS booking_services (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      duration_minutes INTEGER NOT NULL DEFAULT 30,
      buffer_minutes INTEGER NOT NULL DEFAULT 0,
      price_cents INTEGER NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'USD',
      image_url TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(lead_id, slug)
    );

    CREATE TABLE IF NOT EXISTS booking_hours (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      weekday INTEGER NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      UNIQUE(lead_id, weekday, start_time, end_time)
    );

    CREATE TABLE IF NOT EXISTS booking_blocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      block_date TEXT NOT NULL,
      start_time TEXT NOT NULL DEFAULT '',
      end_time TEXT NOT NULL DEFAULT '',
      reason TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      service_id INTEGER NOT NULL,
      customer_name TEXT NOT NULL,
      customer_email TEXT NOT NULL DEFAULT '',
      customer_phone TEXT NOT NULL DEFAULT '',
      starts_at TEXT NOT NULL,
      ends_at TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      price_gross_cents INTEGER NOT NULL DEFAULT 0,
      discount_label TEXT NOT NULL DEFAULT '',
      discount_kind TEXT NOT NULL DEFAULT '',
      discount_value INTEGER NOT NULL DEFAULT 0,
      discount_amount_cents INTEGER NOT NULL DEFAULT 0,
      price_net_cents INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_blog_posts_lead ON blog_posts(lead_id);
    CREATE INDEX IF NOT EXISTS idx_ecom_products_lead ON ecommerce_products(lead_id);
    CREATE INDEX IF NOT EXISTS idx_ecom_orders_lead ON ecommerce_orders(lead_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ecom_orders_session ON ecommerce_orders(stripe_session_id) WHERE stripe_session_id <> '';
    CREATE INDEX IF NOT EXISTS idx_ecom_options_product ON ecommerce_product_options(product_id, sort_order, id);
    CREATE INDEX IF NOT EXISTS idx_ecom_optvals_option ON ecommerce_product_option_values(option_id, sort_order, id);
    CREATE INDEX IF NOT EXISTS idx_ecom_variants_product ON ecommerce_product_variants(product_id, sort_order, id);
    CREATE INDEX IF NOT EXISTS idx_ecom_variants_lead ON ecommerce_product_variants(lead_id);
    CREATE INDEX IF NOT EXISTS idx_courses_lead ON courses(lead_id);
    CREATE INDEX IF NOT EXISTS idx_course_lessons_course ON course_lessons(course_id);
    CREATE INDEX IF NOT EXISTS idx_gallery_albums_lead ON gallery_albums(lead_id);
    CREATE INDEX IF NOT EXISTS idx_gallery_images_album ON gallery_images(album_id);
    CREATE INDEX IF NOT EXISTS idx_directory_lead ON directory_listings(lead_id);
    CREATE INDEX IF NOT EXISTS idx_faq_lead ON faq_items(lead_id);
    CREATE INDEX IF NOT EXISTS idx_testimonials_lead ON testimonials(lead_id);
    CREATE INDEX IF NOT EXISTS idx_team_lead ON team_members(lead_id);
    CREATE INDEX IF NOT EXISTS idx_events_lead ON events(lead_id);
    CREATE INDEX IF NOT EXISTS idx_booking_services_lead ON booking_services(lead_id);
    CREATE INDEX IF NOT EXISTS idx_booking_hours_lead ON booking_hours(lead_id);
    CREATE INDEX IF NOT EXISTS idx_booking_blocks_lead ON booking_blocks(lead_id, block_date);
    CREATE INDEX IF NOT EXISTS idx_bookings_lead ON bookings(lead_id, starts_at);
    CREATE INDEX IF NOT EXISTS idx_estimate_options_lead ON estimate_options(lead_id, sort_order, id);
    CREATE INDEX IF NOT EXISTS idx_estimate_requests_lead ON estimate_requests(lead_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_module_embeds_token ON site_module_embeds(public_token);

    CREATE TABLE IF NOT EXISTS members_configs (
      lead_id INTEGER PRIMARY KEY,
      gate_mode TEXT NOT NULL DEFAULT 'off',
      gated_pages_json TEXT NOT NULL DEFAULT '[]',
      public_pages_json TEXT NOT NULL DEFAULT '[]',
      signup_mode TEXT NOT NULL DEFAULT 'open',
      wall_headline TEXT NOT NULL DEFAULT 'This page is for members only',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS site_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      email TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      password_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_login_at TEXT,
      UNIQUE(lead_id, email)
    );

    CREATE TABLE IF NOT EXISTS site_member_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_hash TEXT NOT NULL UNIQUE,
      member_id INTEGER NOT NULL,
      lead_id INTEGER NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS site_member_reset_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_hash TEXT NOT NULL UNIQUE,
      member_id INTEGER NOT NULL,
      lead_id INTEGER NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS site_member_preview_grants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_hash TEXT NOT NULL UNIQUE,
      lead_id INTEGER NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_site_members_lead ON site_members(lead_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_site_member_sessions_member ON site_member_sessions(member_id);
    CREATE INDEX IF NOT EXISTS idx_site_member_sessions_lead ON site_member_sessions(lead_id);
    CREATE INDEX IF NOT EXISTS idx_site_member_resets_member ON site_member_reset_tokens(member_id);
    CREATE INDEX IF NOT EXISTS idx_site_member_grants_lead ON site_member_preview_grants(lead_id);

    -- Membership Part 2 (Batch 17): per-lead Stripe keys, paid tiers,
    -- and the local subscription records the gate reads as the
    -- entitlement source of truth (Stripe is never called in the gate).
    CREATE TABLE IF NOT EXISTS membership_stripe_keys (
      lead_id INTEGER PRIMARY KEY,
      publishable_key TEXT NOT NULL DEFAULT '',
      secret_key_enc TEXT NOT NULL DEFAULT '',
      webhook_secret_enc TEXT NOT NULL DEFAULT '',
      secret_key_last4 TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Shop Part 2 (Batch 19): per-lead Stripe keys for the Shop module.
    -- Same shape as membership_stripe_keys: owners save their OWN
    -- Stripe keys in the portal (Shop → Payments); checkout prefers
    -- them and falls back to the workspace keys (Settings → Shop
    -- payments) when a lead has none.
    CREATE TABLE IF NOT EXISTS shop_stripe_keys (
      lead_id INTEGER PRIMARY KEY,
      publishable_key TEXT NOT NULL DEFAULT '',
      secret_key_enc TEXT NOT NULL DEFAULT '',
      webhook_secret_enc TEXT NOT NULL DEFAULT '',
      secret_key_last4 TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Batch 129 (streamline all): the ONE per-lead payments
    -- configuration. Every selling surface (shop, checkout,
    -- gallery photos, pay-at-booking, memberships) resolves its
    -- Stripe keys through this row via server/paymentsConfig.js;
    -- the two legacy key tables above remain only as read-only
    -- fallback layers for pre-129 setups until their owners save
    -- or disconnect through the unified path.
    CREATE TABLE IF NOT EXISTS lead_payment_configs (
      lead_id INTEGER PRIMARY KEY,
      publishable_key TEXT NOT NULL DEFAULT '',
      secret_key_enc TEXT NOT NULL DEFAULT '',
      webhook_secret_enc TEXT NOT NULL DEFAULT '',
      secret_key_last4 TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Batch 128 (Checkout module): the line items of a shop order.
    -- One row per cart line, written by the cart checkout (the legacy
    -- single-product checkout writes exactly one). Product name, photo
    -- and prices are SNAPSHOTS from the product row at purchase time —
    -- the Batch 51 precedent (orders carry product_name snapshots), so
    -- order history survives later product edits and deletes. The
    -- variant columns carry Batch 127's variant identity (id + label
    -- snapshot); they stay NULL/'' for plain product lines.
    CREATE TABLE IF NOT EXISTS ecommerce_order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      lead_id INTEGER NOT NULL,
      product_id INTEGER,
      product_name TEXT NOT NULL DEFAULT '',
      variant_id INTEGER,
      variant_label TEXT NOT NULL DEFAULT '',
      source_module TEXT NOT NULL DEFAULT 'ecommerce',
      source_meta TEXT NOT NULL DEFAULT '',
      image_url TEXT NOT NULL DEFAULT '',
      unit_price_cents INTEGER NOT NULL DEFAULT 0,
      quantity INTEGER NOT NULL DEFAULT 1,
      line_total_cents INTEGER NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'USD',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_ecom_order_items_order ON ecommerce_order_items(order_id);
    CREATE INDEX IF NOT EXISTS idx_ecom_order_items_lead ON ecommerce_order_items(lead_id);

    -- Batch 128: per-lead Checkout module settings. The money config
    -- itself stays in shop_stripe_keys (Shop → Payments); this table
    -- holds only the checkout surface's own copy.
    CREATE TABLE IF NOT EXISTS checkout_configs (
      lead_id INTEGER PRIMARY KEY,
      success_message TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS membership_tiers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      price_cents INTEGER NOT NULL DEFAULT 0,
      interval TEXT NOT NULL DEFAULT 'month',
      stripe_product_id TEXT NOT NULL DEFAULT '',
      stripe_price_id TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS member_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      member_id INTEGER NOT NULL,
      tier_id INTEGER,
      tier_name TEXT NOT NULL DEFAULT '',
      price_cents INTEGER NOT NULL DEFAULT 0,
      interval TEXT NOT NULL DEFAULT 'month',
      stripe_customer_id TEXT NOT NULL DEFAULT '',
      stripe_subscription_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'incomplete',
      cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
      current_period_end TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_membership_tiers_lead ON membership_tiers(lead_id, sort_order, id);
    CREATE INDEX IF NOT EXISTS idx_member_subs_lead_member ON member_subscriptions(lead_id, member_id, id DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_member_subs_stripe_sub
      ON member_subscriptions(stripe_subscription_id) WHERE stripe_subscription_id <> '';
  `);
  try {
    // Batch 127: orders learn which variant was bought (existing DBs
    // predate the columns — the CREATE above only covers fresh ones).
    const orderCols = db
      .prepare('PRAGMA table_info(ecommerce_orders)')
      .all()
      .map((c) => String(c.name || ''));
    if (orderCols.length && !orderCols.includes('variant_id')) {
      db.exec('ALTER TABLE ecommerce_orders ADD COLUMN variant_id INTEGER');
    }
    if (orderCols.length && !orderCols.includes('variant_label')) {
      db.exec("ALTER TABLE ecommerce_orders ADD COLUMN variant_label TEXT NOT NULL DEFAULT ''");
    }
    // Batch 158: per-site reviews → social calendar toggle (existing
    // config rows predate the column).
    const grCols = db
      .prepare('PRAGMA table_info(googlereviews_configs)')
      .all()
      .map((c) => String(c.name || ''));
    if (grCols.length && !grCols.includes('share_to_social')) {
      db.exec('ALTER TABLE googlereviews_configs ADD COLUMN share_to_social INTEGER NOT NULL DEFAULT 0');
    }
    const callCols = db
      .prepare('PRAGMA table_info(call_logs)')
      .all()
      .map((c) => String(c.name || ''));
    if (callCols.length && !callCols.includes('counted')) {
      db.exec('ALTER TABLE call_logs ADD COLUMN counted INTEGER NOT NULL DEFAULT 0');
    }
    if (callCols.length && !callCols.includes('transcription_billed')) {
      db.exec('ALTER TABLE call_logs ADD COLUMN transcription_billed INTEGER NOT NULL DEFAULT 0');
    }
    if (callCols.length && !callCols.includes('notify_status')) {
      db.exec("ALTER TABLE call_logs ADD COLUMN notify_status TEXT NOT NULL DEFAULT 'none'");
    }
    // Site Rentals stamp (Batch 26): the site + tenant + rental a call
    // belongs to, snapshotted when the call is logged.
    if (callCols.length && !callCols.includes('website_id')) {
      db.exec('ALTER TABLE call_logs ADD COLUMN website_id INTEGER');
    }
    if (callCols.length && !callCols.includes('tenant_lead_id')) {
      db.exec('ALTER TABLE call_logs ADD COLUMN tenant_lead_id INTEGER');
    }
    if (callCols.length && !callCols.includes('rental_id')) {
      db.exec('ALTER TABLE call_logs ADD COLUMN rental_id INTEGER');
    }
    // Voicemail (Batch 26c): a recording left after an unanswered dial
    // is flagged on the call, with its own exactly-once email state.
    if (callCols.length && !callCols.includes('is_voicemail')) {
      db.exec('ALTER TABLE call_logs ADD COLUMN is_voicemail INTEGER NOT NULL DEFAULT 0');
    }
    if (callCols.length && !callCols.includes('voicemail_notify_status')) {
      db.exec("ALTER TABLE call_logs ADD COLUMN voicemail_notify_status TEXT NOT NULL DEFAULT 'none'");
    }
    // Lead calling (Batch 162): outbound staff calls from the pipeline
    // Contact page share this table with the inbound log — direction
    // discriminates; staff identity, the Twilio lead-leg SID and the
    // conference room ride along; a staff-corrected transcript keeps
    // the Whisper original beside it.
    if (callCols.length && !callCols.includes('direction')) {
      db.exec("ALTER TABLE call_logs ADD COLUMN direction TEXT NOT NULL DEFAULT 'inbound'");
    }
    if (callCols.length && !callCols.includes('staff_user_id')) {
      db.exec('ALTER TABLE call_logs ADD COLUMN staff_user_id INTEGER');
    }
    if (callCols.length && !callCols.includes('staff_name')) {
      db.exec("ALTER TABLE call_logs ADD COLUMN staff_name TEXT NOT NULL DEFAULT ''");
    }
    if (callCols.length && !callCols.includes('provider_call_sid')) {
      db.exec("ALTER TABLE call_logs ADD COLUMN provider_call_sid TEXT NOT NULL DEFAULT ''");
    }
    if (callCols.length && !callCols.includes('conference_name')) {
      db.exec("ALTER TABLE call_logs ADD COLUMN conference_name TEXT NOT NULL DEFAULT ''");
    }
    if (callCols.length && !callCols.includes('transcript_original')) {
      db.exec("ALTER TABLE call_logs ADD COLUMN transcript_original TEXT NOT NULL DEFAULT ''");
    }
    if (callCols.length && !callCols.includes('transcript_edited')) {
      db.exec('ALTER TABLE call_logs ADD COLUMN transcript_edited INTEGER NOT NULL DEFAULT 0');
    }
    const ctCols = db
      .prepare('PRAGMA table_info(calltracking_configs)')
      .all()
      .map((c) => String(c.name || ''));
    if (ctCols.length && !ctCols.includes('notify_email')) {
      db.exec('ALTER TABLE calltracking_configs ADD COLUMN notify_email INTEGER NOT NULL DEFAULT 1');
    }
    if (ctCols.length && !ctCols.includes('voicemail_enabled')) {
      db.exec('ALTER TABLE calltracking_configs ADD COLUMN voicemail_enabled INTEGER NOT NULL DEFAULT 1');
    }
    if (ctCols.length && !ctCols.includes('rotate_enabled')) {
      db.exec('ALTER TABLE calltracking_configs ADD COLUMN rotate_enabled INTEGER NOT NULL DEFAULT 0');
    }
    if (ctCols.length && !ctCols.includes('rotate_counter')) {
      db.exec('ALTER TABLE calltracking_configs ADD COLUMN rotate_counter INTEGER NOT NULL DEFAULT 0');
    }
  } catch {
    /* race / exists */
  }
  try {
    const cfgCols = db
      .prepare('PRAGMA table_info(members_configs)')
      .all()
      .map((c) => String(c.name || ''));
    if (!cfgCols.includes('access_level')) {
      db.exec("ALTER TABLE members_configs ADD COLUMN access_level TEXT NOT NULL DEFAULT 'any_member'");
    }
    if (!cfgCols.includes('access_tier_id')) {
      db.exec('ALTER TABLE members_configs ADD COLUMN access_tier_id INTEGER');
    }
  } catch {
    /* race / exists */
  }
  try {
    const memCols = db
      .prepare('PRAGMA table_info(site_members)')
      .all()
      .map((c) => String(c.name || ''));
    if (!memCols.includes('comp_tier_id')) {
      db.exec('ALTER TABLE site_members ADD COLUMN comp_tier_id INTEGER');
    }
    if (!memCols.includes('comp_until')) {
      db.exec('ALTER TABLE site_members ADD COLUMN comp_until TEXT');
    }
  } catch {
    /* race / exists */
  }
  try {
    const cols = db
      .prepare('PRAGMA table_info(site_module_embeds)')
      .all()
      .map((c) => String(c.name || ''));
    if (!cols.includes('settings_json')) {
      db.exec('ALTER TABLE site_module_embeds ADD COLUMN settings_json TEXT');
    }
  } catch {
    /* race / exists */
  }
  try {
    const blogCols = db
      .prepare('PRAGMA table_info(blog_posts)')
      .all()
      .map((c) => String(c.name || ''));
    if (!blogCols.includes('excerpt')) {
      db.exec("ALTER TABLE blog_posts ADD COLUMN excerpt TEXT NOT NULL DEFAULT ''");
    }
  } catch {
    /* race / exists */
  }
  try {
    const bookingCols = db
      .prepare('PRAGMA table_info(bookings)')
      .all()
      .map((c) => String(c.name || ''));
    if (!bookingCols.includes('archived_at')) {
      db.exec('ALTER TABLE bookings ADD COLUMN archived_at TEXT');
    }
    // Batch 66: appointments hold only a service_id FK — when a service
    // is deleted, its name/duration are snapshotted onto its bookings
    // first so past appointments never lose their readable service.
    if (bookingCols.length && !bookingCols.includes('service_name_snapshot')) {
      db.exec("ALTER TABLE bookings ADD COLUMN service_name_snapshot TEXT NOT NULL DEFAULT ''");
    }
    if (bookingCols.length && !bookingCols.includes('service_duration_snapshot')) {
      db.exec('ALTER TABLE bookings ADD COLUMN service_duration_snapshot INTEGER');
    }
    // Batch 136: every online booking carries its price stamp —
    // gross, the discount actually applied, and the net charged.
    for (const [col, ddl] of [
      ['price_gross_cents', 'ALTER TABLE bookings ADD COLUMN price_gross_cents INTEGER NOT NULL DEFAULT 0'],
      ['discount_label', "ALTER TABLE bookings ADD COLUMN discount_label TEXT NOT NULL DEFAULT ''"],
      ['discount_kind', "ALTER TABLE bookings ADD COLUMN discount_kind TEXT NOT NULL DEFAULT ''"],
      ['discount_value', 'ALTER TABLE bookings ADD COLUMN discount_value INTEGER NOT NULL DEFAULT 0'],
      [
        'discount_amount_cents',
        'ALTER TABLE bookings ADD COLUMN discount_amount_cents INTEGER NOT NULL DEFAULT 0',
      ],
      ['price_net_cents', 'ALTER TABLE bookings ADD COLUMN price_net_cents INTEGER NOT NULL DEFAULT 0'],
    ]) {
      if (bookingCols.length && !bookingCols.includes(col)) db.exec(ddl);
    }
    const bookingSettingCols = db
      .prepare('PRAGMA table_info(booking_settings)')
      .all()
      .map((c) => String(c.name || ''));
    for (const [col, ddl] of [
      [
        'discount_enabled',
        'ALTER TABLE booking_settings ADD COLUMN discount_enabled INTEGER NOT NULL DEFAULT 0',
      ],
      ['discount_kind', "ALTER TABLE booking_settings ADD COLUMN discount_kind TEXT NOT NULL DEFAULT 'percent'"],
      ['discount_value', 'ALTER TABLE booking_settings ADD COLUMN discount_value INTEGER NOT NULL DEFAULT 0'],
      ['discount_label', "ALTER TABLE booking_settings ADD COLUMN discount_label TEXT NOT NULL DEFAULT ''"],
    ]) {
      if (bookingSettingCols.length && !bookingSettingCols.includes(col)) db.exec(ddl);
    }
  } catch {
    /* race / exists */
  }
  try {
    const orderCols = db
      .prepare('PRAGMA table_info(ecommerce_orders)')
      .all()
      .map((c) => String(c.name || ''));
    if (orderCols.length && !orderCols.includes('stripe_key_source')) {
      db.exec("ALTER TABLE ecommerce_orders ADD COLUMN stripe_key_source TEXT NOT NULL DEFAULT ''");
    }
    // Batch 136: booking orders keep the same gross/discount/net
    // stamp as the appointment (other surfaces leave discount 0 and
    // gross = amount, filled at insert time).
    for (const [col, ddl] of [
      ['gross_amount_cents', 'ALTER TABLE ecommerce_orders ADD COLUMN gross_amount_cents INTEGER'],
      [
        'discount_amount_cents',
        'ALTER TABLE ecommerce_orders ADD COLUMN discount_amount_cents INTEGER NOT NULL DEFAULT 0',
      ],
      ['discount_kind', "ALTER TABLE ecommerce_orders ADD COLUMN discount_kind TEXT NOT NULL DEFAULT ''"],
      ['discount_value', 'ALTER TABLE ecommerce_orders ADD COLUMN discount_value INTEGER NOT NULL DEFAULT 0'],
      ['discount_label', "ALTER TABLE ecommerce_orders ADD COLUMN discount_label TEXT NOT NULL DEFAULT ''"],
    ]) {
      if (orderCols.length && !orderCols.includes(col)) db.exec(ddl);
    }
    // Batch 128: gallery photos gain a price (0 = not for sale) so the
    // Checkout module can sell them; existing gallery_images tables
    // predate the column.
    const galleryCols = db
      .prepare('PRAGMA table_info(gallery_images)')
      .all()
      .map((c) => String(c.name || ''));
    if (galleryCols.length && !galleryCols.includes('price_cents')) {
      db.exec('ALTER TABLE gallery_images ADD COLUMN price_cents INTEGER NOT NULL DEFAULT 0');
    }
    // Batch 129: bookings gain their payment link — pay-at-booking runs
    // through the shared checkout engine (hold → paid / released, with
    // the ecommerce_orders row that collected the money) — and member
    // subscriptions record which payments-config layer created them,
    // so lifecycle operations can act on the origin account first.
    const bookingCols = db
      .prepare('PRAGMA table_info(bookings)')
      .all()
      .map((c) => String(c.name || ''));
    if (bookingCols.length && !bookingCols.includes('payment_state')) {
      db.exec("ALTER TABLE bookings ADD COLUMN payment_state TEXT NOT NULL DEFAULT ''");
    }
    if (bookingCols.length && !bookingCols.includes('payment_expires_at')) {
      db.exec('ALTER TABLE bookings ADD COLUMN payment_expires_at TEXT');
    }
    if (bookingCols.length && !bookingCols.includes('payment_order_id')) {
      db.exec('ALTER TABLE bookings ADD COLUMN payment_order_id INTEGER');
    }
    const subCols = db
      .prepare('PRAGMA table_info(member_subscriptions)')
      .all()
      .map((c) => String(c.name || ''));
    if (subCols.length && !subCols.includes('stripe_key_source')) {
      db.exec("ALTER TABLE member_subscriptions ADD COLUMN stripe_key_source TEXT NOT NULL DEFAULT ''");
    }
  } catch {
    /* race / exists */
  }
}

/** First ~wordLimit words of plain text from HTML; never truncates mid-word. */
function deriveExcerptFromBody(bodyHtml, wordLimit = 30) {
  const plain = String(bodyHtml || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  if (!plain) return '';
  const words = plain.split(' ').filter(Boolean);
  const n = Math.max(1, Math.min(200, Number(wordLimit) || 30));
  if (words.length <= n) return words.join(' ');
  return `${words.slice(0, n).join(' ')}…`;
}

function resolveBlogExcerpt(data, bodyHtml, fallback = '') {
  if (data && data.excerpt != null) {
    const explicit = String(data.excerpt).trim();
    if (explicit) return explicit.slice(0, 500);
  }
  const derived = deriveExcerptFromBody(bodyHtml, 30);
  if (derived) return derived.slice(0, 500);
  return String(fallback || '')
    .trim()
    .slice(0, 500);
}

function normalizePostLimit(value) {
  if (value == null || value === '' || value === false) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(100, Math.floor(n));
}

/** Offers list layout: 'cards' (contained card grid, the default) or
 * 'horizontal' (banner-style rows). Anything else normalizes to 'cards'. */
function normalizeOffersLayout(value, fallback = 'cards') {
  return value === 'horizontal' ? 'horizontal' : fallback === 'horizontal' ? 'horizontal' : 'cards';
}

/** Batch 124: the Categories module's display config — which scopes
 * (consuming module types) its index shows. Empty = every scope that
 * has published categories. 'categories' itself is never a scope. */
function normalizeCategoryScopes(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const v of value) {
    const s = String(v || '')
      .trim()
      .toLowerCase();
    if (s && s !== 'categories' && MODULE_TYPES.includes(s) && !out.includes(s)) out.push(s);
  }
  return out;
}

function parseEmbedSettings(row) {
  let raw = {};
  if (row && row.settings_json) {
    try {
      const parsed = JSON.parse(row.settings_json);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) raw = parsed;
    } catch {
      /* ignore */
    }
  }
  const showRequest = raw.show_request_form;
  const showExcerpt = raw.show_excerpt;
  const out = {
    show_request_form: showRequest === false || showRequest === 0 || showRequest === 'false' ? false : true,
    appointment_form_provisioned: !!raw.appointment_form_provisioned,
    post_limit: normalizePostLimit(raw.post_limit),
    show_excerpt: showExcerpt === false || showExcerpt === 0 || showExcerpt === 'false' ? false : true,
  };
  // Offers-only display setting; other module types don't carry it.
  if (row && row.module_type === 'offers') out.layout = normalizeOffersLayout(raw.layout);
  // Categories-only display setting (Batch 124): the scopes shown.
  if (row && row.module_type === 'categories') out.scopes = normalizeCategoryScopes(raw.scopes);
  // QR Code-only display settings (Batch 126): which stored code the
  // module instance shows, plus its caption/CTA line.
  if (row && row.module_type === 'qrcode') {
    out.qrcode_id = raw.qrcode_id != null && Number(raw.qrcode_id) > 0 ? Number(raw.qrcode_id) : null;
    out.caption = String(raw.caption || '').slice(0, 160);
  }
  return out;
}

function writeEmbedSettings(db, embedId, settings = {}) {
  const row = db.prepare('SELECT * FROM site_module_embeds WHERE id = ?').get(Number(embedId));
  const cur = parseEmbedSettings(row || {});
  const next = {
    show_request_form:
      settings.show_request_form !== undefined ? settings.show_request_form !== false : cur.show_request_form,
    appointment_form_provisioned:
      settings.appointment_form_provisioned !== undefined
        ? !!settings.appointment_form_provisioned
        : cur.appointment_form_provisioned,
    post_limit: settings.post_limit !== undefined ? normalizePostLimit(settings.post_limit) : cur.post_limit,
    show_excerpt:
      settings.show_excerpt !== undefined
        ? !(settings.show_excerpt === false || settings.show_excerpt === 0 || settings.show_excerpt === 'false')
        : cur.show_excerpt,
  };
  if (row && row.module_type === 'offers') {
    next.layout =
      settings.layout !== undefined ? normalizeOffersLayout(settings.layout) : cur.layout || 'cards';
  }
  if (row && row.module_type === 'categories') {
    next.scopes =
      settings.scopes !== undefined ? normalizeCategoryScopes(settings.scopes) : cur.scopes || [];
  }
  if (row && row.module_type === 'qrcode') {
    next.qrcode_id =
      settings.qrcode_id !== undefined
        ? settings.qrcode_id == null || !(Number(settings.qrcode_id) > 0)
          ? null
          : Number(settings.qrcode_id)
        : cur.qrcode_id != null
          ? cur.qrcode_id
          : null;
    next.caption =
      settings.caption !== undefined ? String(settings.caption || '').slice(0, 160) : cur.caption || '';
  }
  db.prepare(
    `
    UPDATE site_module_embeds
    SET settings_json = ?, updated_at = datetime('now')
    WHERE id = ?
  `
  ).run(JSON.stringify(next), Number(embedId));
  return next;
}

/** Offers display settings (embed settings): the list layout choice. */
function getOffersLayout(db, leadId) {
  ensureTables(db);
  const row = getEmbedRow(db, leadId, 'offers');
  if (!row) return 'cards';
  return parseEmbedSettings(row).layout || 'cards';
}

function updateOffersLayout(db, leadId, layout, { workspaceId } = {}) {
  ensureTables(db);
  const row = ensureEmbed(db, leadId, 'offers', { workspaceId });
  const next = writeEmbedSettings(db, row.id, {
    ...parseEmbedSettings(row),
    layout: normalizeOffersLayout(layout),
  });
  return { layout: next.layout || 'cards' };
}

/** Categories display scopes (embed settings, Batch 124). */
function getCategoriesScopes(db, leadId) {
  ensureTables(db);
  const row = getEmbedRow(db, leadId, 'categories');
  if (!row) return [];
  return parseEmbedSettings(row).scopes || [];
}

function updateCategoriesScopes(db, leadId, scopes, { workspaceId } = {}) {
  ensureTables(db);
  const row = ensureEmbed(db, leadId, 'categories', { workspaceId });
  const next = writeEmbedSettings(db, row.id, {
    ...parseEmbedSettings(row),
    scopes: normalizeCategoryScopes(scopes),
  });
  return { scopes: next.scopes || [] };
}

/**
 * Bookings companion "Appointment request" form — created once at attach when
 * show_request_form is true. Tracked on the embed settings, not form existence,
 * so delete/disable never silently re-provisions on export/publish.
 */
function maybeProvisionBookingsCompanionForm(db, leadId, embedRow, opts = {}) {
  if (!embedRow || embedRow.module_type !== 'bookings') return null;
  const settings = parseEmbedSettings(embedRow);
  const showRequest =
    opts.show_request_form != null
      ? !(opts.show_request_form === false || opts.show_request_form === 0 || opts.show_request_form === 'false')
      : settings.show_request_form;

  if (settings.appointment_form_provisioned) {
    // Keep show_request_form writable on re-attach without recreating the form.
    if (opts.show_request_form != null && showRequest !== settings.show_request_form) {
      writeEmbedSettings(db, embedRow.id, {
        ...settings,
        show_request_form: showRequest,
      });
    }
    return { provisioned: true, created: false, show_request_form: showRequest };
  }

  let created = false;
  let formId = null;
  let provisionError = null;
  if (showRequest) {
    try {
      const forms = require('./contactForms');
      forms.ensureTables(db);
      const existing = forms
        .listFormRows(db, Number(leadId))
        .find((r) => r.form_kind === 'appointment' || /appointment\s*request/i.test(String(r.name || '')));
      if (existing) {
        formId = existing.id;
        if (opts.workspaceId && (!existing.published || !existing.public_token)) {
          forms.publishForm(db, Number(leadId), existing.id, {
            workspaceId: opts.workspaceId,
            embed_enabled: existing.embed_enabled == null ? true : !!existing.embed_enabled,
            target_page_slug:
              existing.target_page_slug || embedRow.target_page_slug || MODULE_META.bookings.defaultSlug,
          });
        }
      } else {
        // Defensive lead read — older/partial DBs may lack columns.
        let lead = null;
        try {
          lead = db.prepare('SELECT business_name, email FROM leads WHERE id = ?').get(Number(leadId));
        } catch {
          try {
            lead = db.prepare('SELECT business_name FROM leads WHERE id = ?').get(Number(leadId));
          } catch {
            lead = null;
          }
        }
        const preset = forms.FORM_PRESETS.appointment;
        const createdForm = forms.createForm(db, Number(leadId), {
          form_kind: 'appointment',
          name: preset.name,
          title: preset.title,
          intro: preset.intro(lead && lead.business_name),
          submit_label: preset.submit_label,
          success_message: preset.success_message,
          notify_email: (lead && lead.email) || '',
          embed_enabled: true,
          add_to_nav: false,
          target_page_slug: embedRow.target_page_slug || MODULE_META.bookings.defaultSlug,
          fields: preset.fields(),
        });
        formId = createdForm.id;
        if (opts.workspaceId) {
          forms.publishForm(db, Number(leadId), formId, {
            workspaceId: opts.workspaceId,
            embed_enabled: true,
            target_page_slug: embedRow.target_page_slug || MODULE_META.bookings.defaultSlug,
          });
        }
        created = true;
      }
    } catch (e) {
      provisionError = e && e.message ? String(e.message) : 'companion_form_failed';
      console.warn('[siteModules] bookings companion form:', provisionError);
    }
  }

  // Only stamp provisioned when we intentionally skip the form, or we have a form id.
  // Failed creates must remain retryable on next attach/publish.
  const provisionedOk = !showRequest || formId != null;
  writeEmbedSettings(db, embedRow.id, {
    show_request_form: showRequest,
    appointment_form_provisioned: provisionedOk,
  });
  return {
    provisioned: provisionedOk,
    created,
    formId,
    show_request_form: showRequest,
    error: provisionError || undefined,
  };
}

function normalizeSlug(slug) {
  // Prefer shared route identity ("/" / "index" / "home" → "index").
  try {
    const eng = require('../src/websiteEngine');
    if (typeof eng.normalizeRoute === 'function') return eng.normalizeRoute(slug);
  } catch {
    /* fall through */
  }
  return (
    String(slug || '')
      .trim()
      .toLowerCase()
      .replace(/^\//, '')
      .replace(/\.html$/i, '')
      .replace(/[^a-z0-9-_]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'index'
  );
}

function routeKey(hrefOrSlug) {
  try {
    const eng = require('../src/websiteEngine');
    if (typeof eng.normalizeRoute === 'function') return eng.normalizeRoute(hrefOrSlug);
  } catch {
    /* fall through */
  }
  return normalizeSlug(hrefOrSlug);
}

function anchorTextLabel(innerHtml) {
  try {
    const eng = require('../src/websiteEngine');
    if (typeof eng.navAnchorLabel === 'function') return eng.navAnchorLabel(innerHtml);
  } catch {
    /* fall through */
  }
  return String(innerHtml || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Blank / missing slug means "use the fallback", not the home page. */
function resolveTargetSlug(explicit, stored, fallback) {
  const pick = (v) => {
    if (v == null) return '';
    const s = String(v).trim();
    if (!s) return '';
    return normalizeSlug(s);
  };
  return pick(explicit) || pick(stored) || normalizeSlug(fallback || 'home');
}

/**
 * Relative multipage filename. Must match src/websiteEngine.js pageFileName
 * (Batch 31 canonical form): home/index → index.html, everything else →
 * nested dash path + .html (services/20-yard-dumpster-rental.html).
 */
function pageFileName(slug) {
  try {
    return require('../src/websiteEngine').pageFileName(slug);
  } catch {
    const s = String(slug || '/')
      .replace(/^\//, '')
      .replace(/\/$/, '');
    if (!s || s === 'home' || s === 'index') return 'index.html';
    return s.replace(/[^a-z0-9-_]/gi, '_') + '.html';
  }
}

function moduleEmbedActive(row) {
  if (!row || !Number(row.published) || !row.public_token) return false;
  if (row.embed_enabled == null || row.embed_enabled === '') return true;
  const n = Number(row.embed_enabled);
  return !Number.isNaN(n) ? n !== 0 : !!row.embed_enabled;
}

function findPageIndex(pages, slug) {
  const want = normalizeSlug(slug || 'home');
  let idx = pages.findIndex((p) => normalizeSlug(p && p.slug) === want);
  if (idx >= 0) return idx;
  if (want === 'home' || want === 'index') {
    idx = pages.findIndex((p) => {
      const s = normalizeSlug(p && p.slug);
      return s === 'home' || s === 'index' || s === '';
    });
    if (idx >= 0) return idx;
    return pages.length ? 0 : -1;
  }
  return -1;
}

function listSitePages(db, leadId) {
  const site = db.prepare('SELECT pages FROM websites WHERE lead_id = ? ORDER BY id DESC LIMIT 1').get(Number(leadId));
  if (!site) return [];
  try {
    const pages = JSON.parse(site.pages || '[]');
    if (!Array.isArray(pages)) return [];
    return pages.map((p) => ({
      slug: normalizeSlug(p && p.slug),
      title: String((p && p.title) || p.slug || ''),
    }));
  } catch {
    return [];
  }
}

/* ── Embeds ── */

function getEmbedRow(db, leadId, moduleType) {
  return db
    .prepare('SELECT * FROM site_module_embeds WHERE lead_id = ? AND module_type = ?')
    .get(Number(leadId), assertModuleType(moduleType));
}

/**
 * Review fix: an archived (soft-deleted) site's public module surfaces
 * stop serving — embed tokens outlive the site. Called by the public
 * token entry points below once the embed's lead is known (inside the
 * caller's own db scope, so public routes keep their single-domain-
 * touch invariant). A lead with no website is never blocked: modules
 * also live on lead-level surfaces.
 */
function assertSiteNotArchived(db, leadId) {
  let site = null;
  try {
    site = db
      .prepare('SELECT archived_at FROM websites WHERE lead_id = ?')
      .get(Number(leadId));
  } catch {
    return; // minimal db without a websites table — nothing to gate on
  }
  if (site && site.archived_at) {
    throw fail('SITE_ARCHIVED', 'This site is no longer available', 410);
  }
}

/**
 * Batch 119: the public-surface twin of the serve-time 503 gate. A
 * suspended account's site must not serve module content either —
 * the same marker rows the /site-previews gate reads
 * (subscription_site_suspensions, written/cleared by
 * server/subscriptionSuspension.js). Called beside
 * assertSiteNotArchived at the public token entry points only, so
 * staff/portal management of a suspended client's modules is never
 * blocked. The error stays generic — no suspension details leak to
 * the site's visitors.
 */
function assertSiteNotSuspended(db, leadId) {
  let marked = null;
  try {
    marked = db
      .prepare(
        `SELECT s.website_id FROM subscription_site_suspensions s
           JOIN websites w ON w.id = s.website_id
          WHERE w.lead_id = ? LIMIT 1`
      )
      .get(Number(leadId));
  } catch {
    return; // no marker table in this workspace — never suspended
  }
  if (marked) {
    throw fail('SITE_UNAVAILABLE', 'This site is temporarily unavailable', 503);
  }
}

function listEmbeds(db, leadId) {
  ensureTables(db);
  return db.prepare('SELECT * FROM site_module_embeds WHERE lead_id = ? ORDER BY module_type').all(Number(leadId));
}

function ensureEmbed(db, leadId, moduleType, { workspaceId, title } = {}) {
  ensureTables(db);
  const type = assertModuleType(moduleType);
  let row = getEmbedRow(db, leadId, type);
  if (row) return row;
  const meta = MODULE_META[type];
  const token = workspaceId ? makePublicToken(workspaceId) : null;
  const info = db
    .prepare(
      `
    INSERT INTO site_module_embeds
      (lead_id, module_type, title, public_token, published, embed_enabled, target_page_slug)
    VALUES (?, ?, ?, ?, 0, 1, ?)
  `
    )
    .run(Number(leadId), type, String(title || meta.defaultTitle).slice(0, 120), token, meta.defaultSlug);
  return db.prepare('SELECT * FROM site_module_embeds WHERE id = ?').get(info.lastInsertRowid);
}

function publicEmbed(row, appUrl) {
  if (!row) return null;
  const base = String(appUrl || appBaseUrl()).replace(/\/$/, '');
  const token = row.public_token || '';
  const embedUrl = token && base ? `${base}/embed/module.html?token=${encodeURIComponent(token)}` : '';
  const scriptUrl = base ? `${base}/js/module-embed.js?v=${MODULE_SCRIPT_VER}` : '';
  const settings = parseEmbedSettings(row);
  return {
    id: row.id,
    lead_id: row.lead_id,
    module_type: row.module_type,
    title: row.title,
    public_token: row.public_token,
    published: !!row.published,
    embed_enabled: row.embed_enabled == null ? true : !!row.embed_enabled,
    target_page_slug: row.target_page_slug || MODULE_META[row.module_type]?.defaultSlug || '',
    settings,
    show_request_form: settings.show_request_form,
    // Sites use an in-page JS mount (not an iframe). embed_url is a standalone viewer only.
    embed_mode: 'js',
    script_url: scriptUrl,
    embed_url: embedUrl,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function attachModule(db, leadId, moduleType, opts = {}) {
  ensureTables(db);
  const type = assertModuleType(moduleType);
  const workspaceId = opts.workspaceId;
  if (!workspaceId) throw fail('INVALID', 'workspaceId required to attach module');

  let row = ensureEmbed(db, leadId, type, {
    workspaceId,
    title: opts.title,
  });

  if (!row.public_token) {
    const token = makePublicToken(workspaceId);
    db.prepare("UPDATE site_module_embeds SET public_token = ?, updated_at = datetime('now') WHERE id = ?").run(
      token,
      row.id
    );
    row = getEmbedRow(db, leadId, type);
  }

  const meta = MODULE_META[type];
  const slug = resolveTargetSlug(opts.target_page_slug, row.target_page_slug, meta.defaultSlug);
  const embedEnabled = opts.embed_enabled != null ? (opts.embed_enabled ? 1 : 0) : opts.toSite === false ? 0 : 1;
  const title = opts.title != null ? String(opts.title).slice(0, 120) : row.title || meta.defaultTitle;

  db.prepare(
    `
    UPDATE site_module_embeds
    SET title = ?, published = 1, embed_enabled = ?, target_page_slug = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `
  ).run(title, embedEnabled, slug, row.id);

  row = getEmbedRow(db, leadId, type);

  // Persist embed settings (blog post_limit/show_excerpt, bookings show_request_form, …).
  if (opts.settings && typeof opts.settings === 'object') {
    writeEmbedSettings(db, row.id, {
      ...parseEmbedSettings(row),
      ...opts.settings,
      show_request_form:
        opts.show_request_form != null
          ? opts.show_request_form
          : opts.settings.show_request_form != null
            ? opts.settings.show_request_form
            : parseEmbedSettings(row).show_request_form,
    });
    row = getEmbedRow(db, leadId, type);
  } else if (opts.show_request_form != null && type === 'bookings') {
    writeEmbedSettings(db, row.id, {
      ...parseEmbedSettings(row),
      show_request_form: opts.show_request_form,
    });
    row = getEmbedRow(db, leadId, type);
  }

  let companion = null;
  if (type === 'bookings') {
    companion = maybeProvisionBookingsCompanionForm(db, leadId, row, {
      workspaceId,
      show_request_form:
        opts.show_request_form != null ? opts.show_request_form : opts.settings && opts.settings.show_request_form,
    });
    row = getEmbedRow(db, leadId, type);
  }

  const appUrl = opts.appUrl || appBaseUrl();
  const wouldInject = describeWouldInject(row, appUrl);

  // Author-mode preview: return what sync WOULD inject without mutating pages.
  if (opts.dryRun || opts.authorMode === 'preview') {
    let pages = [];
    try {
      const site = db
        .prepare('SELECT pages FROM websites WHERE lead_id = ? ORDER BY id DESC LIMIT 1')
        .get(Number(leadId));
      pages = site ? JSON.parse(site.pages || '[]') : [];
    } catch {
      pages = [];
    }
    const purpose = pageServesModulePurpose(pages, type, row.public_token, slug);
    return {
      embed: publicEmbed(row, appUrl),
      sync: { synced: false, dryRun: true },
      companion,
      authorMode: true,
      wouldInject,
      skippedInject: !!purpose.served,
      skipReason: purpose.served ? purpose.reason : null,
    };
  }

  // Author mode (default): if purpose already served, skip sync inject but still enable embed.
  let pagesPre = [];
  try {
    const site = db
      .prepare('SELECT pages FROM websites WHERE lead_id = ? ORDER BY id DESC LIMIT 1')
      .get(Number(leadId));
    pagesPre = site ? JSON.parse(site.pages || '[]') : [];
  } catch {
    pagesPre = [];
  }
  const purpose = pageServesModulePurpose(pagesPre, type, row.public_token, slug);
  const metaFlags = MODULE_META[type] || {};
  // Sitewide overlays (chatbot) always sync every page — skip author-purpose short-circuit.
  const authorMode = opts.authorMode !== false; // default ON
  if (!metaFlags.sitewide && authorMode && purpose.served && opts.forceInject !== true) {
    return {
      embed: publicEmbed(row, appUrl),
      sync: { synced: false, skipped: true, reason: purpose.reason },
      companion,
      authorMode: true,
      wouldInject,
      skippedInject: true,
      skipReason: purpose.reason,
    };
  }

  const sync = syncSiteModuleEmbeds(db, leadId, {
    appUrl,
    revealSlugs: metaFlags.noNav || metaFlags.sitewide ? [] : [slug],
  });
  return {
    embed: publicEmbed(row, appUrl),
    sync,
    companion,
    authorMode: true,
    wouldInject,
    skippedInject: false,
    sitewide: !!metaFlags.sitewide,
  };
}

function detachModule(db, leadId, moduleType) {
  ensureTables(db);
  const type = assertModuleType(moduleType);
  const row = getEmbedRow(db, leadId, type);
  if (!row) return { embed: null, sync: { synced: false } };
  db.prepare(
    `
    UPDATE site_module_embeds
    SET published = 0, embed_enabled = 0, updated_at = datetime('now')
    WHERE id = ?
  `
  ).run(row.id);
  const sync = syncSiteModuleEmbeds(db, leadId);
  return { embed: publicEmbed(getEmbedRow(db, leadId, type)), sync };
}

/* ── Batch 66: per-record module delete (Ely, 2026-10-29) ──────────
 * Detach (above) only unpublishes — the embed row and ALL content
 * survive. Delete is the purge: the embed row goes AND the module's
 * lead-scoped content/config goes with it. The data model scopes
 * everything by (lead_id, module_type) — site_module_embeds is
 * UNIQUE(lead_id, module_type), so the one embed IS the module
 * instance for the business; there is no second embed of the same
 * type whose content could be shared. Content of OTHER module types
 * and other leads is never touched (every step is lead-scoped).
 *
 * Records a module merely COLLECTED stay behind, by the codebase's
 * own precedents: ecommerce_orders (Batch 51 gave shop orders no
 * delete path; they carry product_name snapshots), call_logs +
 * calls_billing (Batch 45/51 delete those per-record under their own
 * guards). Pool numbers are NOT released by hand: findNumberClaim
 * derives claims from calltracking_configs, so purging the config
 * (and its rotation rows) frees the number automatically.
 * Bookings is guarded like the single-service delete: upcoming
 * appointments block the purge; past ones are already name-safe only
 * while their service exists, so deleting the module deletes past
 * appointments with it (they have no other surface without it).
 */

function moduleTableExists(db, table) {
  try {
    return !!db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table);
  } catch {
    return false;
  }
}

/** Ordered purge steps for a module type: [{ table, label, countSql, deleteSql, params }]. */
function modulePurgeSteps(leadId, type) {
  const lid = Number(leadId);
  const byLead = (table, label) => ({
    table,
    label,
    params: [lid],
    countSql: `SELECT COUNT(*) AS c FROM ${table} WHERE lead_id = ?`,
    deleteSql: `DELETE FROM ${table} WHERE lead_id = ?`,
  });
  const viaParent = (table, label, parentTable, parentKey) => ({
    table,
    label,
    params: [lid],
    countSql: `SELECT COUNT(*) AS c FROM ${table} WHERE ${parentKey} IN (SELECT id FROM ${parentTable} WHERE lead_id = ?)`,
    deleteSql: `DELETE FROM ${table} WHERE ${parentKey} IN (SELECT id FROM ${parentTable} WHERE lead_id = ?)`,
  });
  switch (type) {
    case 'blog':
      return [byLead('blog_posts', 'blog posts')];
    case 'ecommerce':
      // Orders stay (see header note); products + the shop's own
      // payment-key config are the module's content/config. Batch
      // 127: the variant structure is product content — variants,
      // then values, then groups, then the products themselves.
      return [
        byLead('ecommerce_product_variants', 'product variants'),
        byLead('ecommerce_product_option_values', 'product option values'),
        byLead('ecommerce_product_options', 'product options'),
        byLead('ecommerce_products', 'products'),
        byLead('shop_stripe_keys', 'shop payment settings'),
      ];
    case 'courses':
      return [viaParent('course_lessons', 'course lessons', 'courses', 'course_id'), byLead('courses', 'courses')];
    case 'gallery':
      return [viaParent('gallery_images', 'gallery images', 'gallery_albums', 'album_id'), byLead('gallery_albums', 'gallery albums')];
    case 'directory':
      return [byLead('directory_listings', 'directory listings')];
    case 'faq':
      return [byLead('faq_items', 'FAQ items')];
    case 'testimonials':
      return [byLead('testimonials', 'testimonials')];
    case 'team':
      return [byLead('team_members', 'team members')];
    case 'events':
      return [byLead('events', 'events')];
    case 'bookings':
      return [
        byLead('bookings', 'appointments'),
        byLead('booking_services', 'booking services'),
        byLead('booking_hours', 'booking hours'),
        byLead('booking_blocks', 'booking blocked dates'),
        byLead('booking_settings', 'booking settings'),
      ];
    case 'chatbot':
      return [
        byLead('chatbot_messages', 'chat messages'),
        byLead('chatbot_sessions', 'chat conversations'),
        byLead('chatbot_escalations', 'chat escalations'),
        byLead('chatbot_leads', 'chat lead captures'),
        byLead('chatbot_knowledge', 'chatbot knowledge items'),
        byLead('chatbot_settings', 'chatbot settings'),
      ];
    case 'offers':
      return [byLead('offers', 'offers')];
    case 'qrcode':
      return [byLead('module_qrcodes', 'QR codes')];
    case 'menu':
      return [byLead('menu_items', 'menu items'), byLead('menu_categories', 'menu categories')];
    case 'careers':
      return [byLead('careers_postings', 'careers postings')];
    case 'video':
      return [byLead('video_items', 'videos')];
    case 'estimate':
      return [
        byLead('estimate_requests', 'estimate requests'),
        byLead('estimate_options', 'estimate options'),
        byLead('estimate_configs', 'estimate settings'),
      ];
    case 'socialfeed':
      return [byLead('socialfeed_cache', 'social feed cache'), byLead('socialfeed_configs', 'social feed settings')];
    case 'calltracking':
      // call_logs + calls_billing stay (see header note); the pooled
      // Twilio number's claim is derived from the config, so purging
      // config + rotation rows releases it.
      return [
        byLead('calltracking_rotation_numbers', 'rotation numbers'),
        byLead('calltracking_configs', 'call tracking setup'),
      ];
    case 'members':
      // deleteSiteMember precedent: local subscription records go
      // with the account; the Stripe subscription itself lives on the
      // owner's Stripe and is theirs to cancel there.
      return [
        byLead('site_member_sessions', 'member sessions'),
        byLead('site_member_reset_tokens', 'member reset tokens'),
        byLead('site_member_preview_grants', 'member preview grants'),
        byLead('member_subscriptions', 'member subscriptions'),
        byLead('membership_tiers', 'membership tiers'),
        byLead('site_members', 'member accounts'),
        byLead('members_configs', 'membership settings'),
        byLead('membership_stripe_keys', 'membership payment settings'),
      ];
    case 'googlereviews':
      return [byLead('googlereviews_cache', 'Google Reviews cache'), byLead('googlereviews_configs', 'Google Reviews settings')];
    case 'datatables':
      return [byLead('datatable_rows', 'data table rows'), byLead('datatable_configs', 'data table settings')];
    case 'charts':
      return [byLead('charts', 'charts')];
    case 'newsletter':
      return [
        byLead('newsletter_sends', 'newsletter issues sent'),
        byLead('newsletter_subscribers', 'newsletter subscribers'),
        byLead('newsletter_configs', 'newsletter settings'),
      ];
    case 'categories':
      // Assignments first (they reference categories), then the
      // taxonomy itself. The items the assignments pointed at belong
      // to other modules and are never purged from here.
      return [
        byLead('module_category_assignments', 'category assignments'),
        byLead('module_categories', 'categories'),
      ];
    case 'photocapture':
      return [
        byLead('photocapture_submissions', 'photo submissions'),
        byLead('photocapture_configs', 'photo capture settings'),
      ];
    case 'checkout':
      // Config only. Orders and their line items are the shop's
      // transaction records — they stay, per the Batch 51 precedent
      // for ecommerce_orders (see the header note above).
      return [byLead('checkout_configs', 'checkout settings')];
    case 'comments':
      // Likes first (they reference comments and items), then the
      // comments themselves, then the settings. The items the
      // comments were attached to belong to other modules and are
      // never purged from here.
      return [
        byLead('module_likes', 'likes'),
        byLead('module_comments', 'comments'),
        byLead('comments_configs', 'comments settings'),
      ];
    case 'pricing':
      // Batch 139: the price-list entries themselves. Linked entries
      // hold no money state — the prices they showed live on the
      // source records (services/products), which belong to their
      // own modules and are never purged from here.
      return [byLead('pricing_entries', 'pricing entries')];
    default:
      return [];
  }
}

/** What deleteModule WOULD purge for (lead, type) — feeds confirm copy + audits. */
function moduleContentCounts(db, leadId, moduleType) {
  ensureTables(db);
  const type = assertModuleType(moduleType);
  const parts = [];
  let total = 0;
  for (const step of modulePurgeSteps(leadId, type)) {
    if (!moduleTableExists(db, step.table)) continue;
    const row = db.prepare(step.countSql).get(...step.params);
    const count = Number(row && row.c) || 0;
    if (count > 0) parts.push({ table: step.table, label: step.label, count });
    total += count;
  }
  return { module_type: type, total, parts };
}

function deleteModule(db, leadId, moduleType) {
  ensureTables(db);
  const type = assertModuleType(moduleType);
  const lid = Number(leadId);
  const embed = getEmbedRow(db, lid, type);
  if (!embed) throw fail('NOT_FOUND', 'Module is not installed for this business', 404);
  if (type === 'bookings') {
    const upcoming = listUpcomingAppointments(db, lid);
    if (upcoming.length) {
      throw fail(
        'MODULE_HAS_UPCOMING',
        `The Bookings module has ${upcoming.length} upcoming appointment${upcoming.length === 1 ? '' : 's'}. Cancel them before deleting the module.`,
        409
      );
    }
  }
  // LeadScout events reference bookings / estimate requests by id —
  // unlink them exactly like the per-record deletes do (Batch 45), so
  // purging the module leaves no dangling refs.
  if (type === 'bookings') {
    const ids = db.prepare('SELECT id FROM bookings WHERE lead_id = ?').all(lid);
    for (const r of ids) deleteLeadScoutEventsByRef(db, 'booking_id', r.id);
  }
  if (type === 'estimate') {
    const ids = db.prepare('SELECT id FROM estimate_requests WHERE lead_id = ?').all(lid);
    for (const r of ids) deleteLeadScoutEventsByRef(db, 'estimate_request_id', r.id);
  }
  if (type === 'newsletter') {
    const ids = db.prepare('SELECT id FROM newsletter_subscribers WHERE lead_id = ?').all(lid);
    for (const r of ids) deleteLeadScoutEventsByRef(db, 'newsletter_subscriber_id', r.id);
  }
  if (type === 'photocapture') {
    const rows = db
      .prepare('SELECT id, image_src, gallery_image_id FROM photocapture_submissions WHERE lead_id = ?')
      .all(lid);
    for (const r of rows) deleteLeadScoutEventsByRef(db, 'photo_submission_id', r.id);
    // Batch 132: purging the module removes the stored photo files
    // too (same rule as the per-record delete — a photo pushed into
    // a gallery keeps its file; that copy belongs to the gallery).
    for (const r of rows) {
      if (!r.gallery_image_id) removeStoredPhotoFile(db, lid, r.image_src);
    }
  }
  if (type === 'comments') {
    const ids = db.prepare('SELECT id FROM module_comments WHERE lead_id = ?').all(lid);
    for (const r of ids) deleteLeadScoutEventsByRef(db, 'comment_id', r.id);
  }
  const purged = {};
  let purgedTotal = 0;
  for (const step of modulePurgeSteps(lid, type)) {
    if (!moduleTableExists(db, step.table)) continue;
    const info = db.prepare(step.deleteSql).run(...step.params);
    if (info.changes) {
      purged[step.table] = info.changes;
      purgedTotal += info.changes;
    }
  }
  db.prepare('DELETE FROM site_module_embeds WHERE id = ?').run(embed.id);
  const sync = syncSiteModuleEmbeds(db, lid);
  return { deleted: true, module_type: type, lead_id: lid, purged, purged_total: purgedTotal, sync };
}

/* ------------------------------------------------------------------ */
/* Batch 133 — UNIVERSAL DETAIL PAGE.                                  */
/*                                                                     */
/* One generic detail page (/detail/<type>/<key>, exported as         */
/* item.html) serves EVERY module item: the page is handed an item    */
/* through the public item path and renders that type's detail        */
/* layout — it never cares which module served it (Ely, 2026-11-04:   */
/* "a checkout page that takes whatever module is served to it as     */
/* the detail page"). DETAIL_TYPES = exactly the types               */
/* getPublicModuleItem can resolve an item for. Every other type      */
/* (registry non-providers and interactive/config modules alike)      */
/* lands on the detail page's not-found state, never an error card    */
/* inside another page — the Batch 130 ?bpItem= ambiguity is          */
/* structurally impossible here because the URL carries ONE typed     */
/* target.                                                            */
/* ------------------------------------------------------------------ */
const DETAIL_TYPES = [
  'blog',
  'ecommerce',
  'courses',
  'gallery',
  'directory',
  'faq',
  'testimonials',
  'team',
  'events',
  'bookings',
  'categories',
  'offers',
  'menu',
  'careers',
  'video',
];

/**
 * Batch 141 — an item's primary photo for its per-item detail shell,
 * resolved from the list-payload row the enumeration already holds,
 * with the moduleShare uniform primary per type (the same photo the
 * public API resolves for the item): blog/courses lead with their
 * cover, an album's primary is its first image, a video's is its
 * thumbnail; everything else leads with image_url. '' when the item
 * has no photo — its shell then renders exactly as before.
 */
function detailItemPhoto(type, it) {
  if (!it || typeof it !== 'object') return '';
  let url = '';
  if (type === 'blog' || type === 'courses') url = it.cover_image || it.image_url || '';
  else if (type === 'gallery') {
    const first = Array.isArray(it.images) ? it.images.find((im) => im && im.image_url) : null;
    url = (first && first.image_url) || it.cover_image || it.image_url || '';
  } else if (type === 'video') url = it.thumbnail_url || it.image_url || '';
  else url = it.image_url || it.cover_image || '';
  return String(url || '').trim();
}

/**
 * The export-time detail context for one lead's site: for every
 * detail-capable module type with a live (published, enabled) embed,
 * the public token the detail page resolves through and the page the
 * type's list lives on (the detail page's back link). Tokens are the
 * same public embed tokens every mount on the site already carries.
 * Batch 141: also resolves each enumerated item's primary photo
 * (photos: { [type]: { [key]: url } }) for the per-item shells —
 * attached only when at least one photo exists, so an item-less
 * context keeps its exact { types } shape.
 */
function detailExportContext(db, leadId) {
  const types = {};
  const photos = {};
  const lid = Number(leadId);
  if (!Number.isInteger(lid) || lid <= 0) return { types };
  for (const type of DETAIL_TYPES) {
    try {
      const row = getEmbedRow(db, lid, type);
      if (!moduleEmbedActive(row)) continue;
      // Batch 133 finisher: also enumerate the type's published
      // item keys (slug + id) so the exporter can ship a real shell
      // file per item — the /detail/* rewrite does not fire on the
      // platform's Pages deployments, real files always serve.
      const items = [];
      const typePhotos = {};
      try {
        const payload = getPublicModuleByToken(db, row.public_token, {});
        if (payload && !payload.locked && Array.isArray(payload.items)) {
          const seen = new Set();
          for (const it of payload.items) {
            // Batch 141: the item's primary photo rides the same
            // enumeration (no second payload read) for its shell.
            const photo = detailItemPhoto(type, it);
            for (const k of [it && it.slug, it && it.id]) {
              if (k == null || k === '') continue;
              const key = String(k);
              if (/[\/\\]/.test(key) || key === '.' || key === '..') continue;
              if (photo) typePhotos[key] = photo;
              if (!seen.has(key)) {
                seen.add(key);
                items.push(key);
              }
            }
          }
        }
      } catch (e) {
        // Batch 143: was a silent catch — the Batch 133 fix-3
        // failure mode (a broken payload read quietly shipping zero
        // detail shells). The export continues, but the failure is
        // on the record.
        console.warn('[siteModules] detailExportContext items for', type, 'lead', lid, ':', e.message || e);
        /* items stay empty — the shell config still lists the type */
      }
      types[type] = {
        token: String(row.public_token || ''),
        page: String(row.target_page_slug || (MODULE_META[type] && MODULE_META[type].defaultSlug) || '').replace(/^\/+/, ''),
        items,
      };
      if (Object.keys(typePhotos).length) photos[type] = typePhotos;
    } catch (e) {
      // Batch 143: log it — "no embed row" is the expected empty
      // case (getEmbedRow returns null, handled above without
      // throwing); a THROW here is a real read failure and was
      // previously indistinguishable from it.
      console.warn('[siteModules] detailExportContext type', type, 'lead', lid, ':', e.message || e);
      /* a type without an embed row simply has no detail surface */
    }
  }
  const out = { types };
  if (Object.keys(photos).length) out.photos = photos;
  return out;
}

function moduleScriptTag(appUrl) {
  const base = String(appUrl || appBaseUrl()).replace(/\/$/, '');
  if (!base) return '';
  return (
    `<script src="${escapeAttr(base)}/js/module-embed.js?v=${MODULE_SCRIPT_VER}" ` +
    `defer ${SCRIPT_ATTR}="1"></script>`
  );
}

function embedBlockHtml(embed, appUrl) {
  const base = String(appUrl || appBaseUrl()).replace(/\/$/, '');
  const token = String(embed.public_token || '');
  if (!/^\d+_[A-Za-z0-9_-]+$/.test(token)) return '';
  if (String(embed.module_type || '') === 'chatbot') {
    try {
      return require('./chatbot').chatEmbedBlockHtml(embed, base);
    } catch {
      return '';
    }
  }
  const type = escapeAttr(embed.module_type);
  // In-page mount: customer sites (CF Pages / custom domains) load module-embed.js
  // and fetch the public JSON API. Title comes from the host page when present.
  return (
    `<div class="bitpype-module-embed" ${MANAGED_ATTR}="1" ${EMBED_TYPE_ATTR}="${type}" ` +
    `${EMBED_TOKEN_ATTR}="${escapeAttr(token)}" data-bitpype-api="${escapeAttr(base)}" ` +
    `data-bitpype-hide-title="1"></div>`
  );
}

function escapeRegExp(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function htmlHasModuleToken(html, token) {
  const t = String(token || '').trim();
  if (!t) return false;
  const esc = escapeRegExp(t);
  return new RegExp(`${EMBED_TOKEN_ATTR}\\s*=\\s*["']${esc}["']`, 'i').test(String(html || ''));
}

function stripManagedModuleEmbedsFromHtml(html) {
  let s = String(html || '');
  s = s.replace(new RegExp(`<div\\b[^>]*\\b${MANAGED_ATTR}\\s*=\\s*["']?1["']?[^>]*>[\\s\\S]*?<\\/div>`, 'gi'), '');
  s = s.replace(new RegExp(`<div\\b[^>]*\\b${MANAGED_ATTR}\\s*=\\s*["']?1["']?[^>]*\\/?>`, 'gi'), '');
  s = s.replace(/<iframe\b[^>]*\/embed\/module\.html[^>]*>\s*<\/iframe>/gi, '');
  s = s.replace(/<iframe\b[^>]*\/embed\/module\.html[^>]*\/>/gi, '');
  s = s.replace(new RegExp(`<script\\b[^>]*\\b${SCRIPT_ATTR}\\b[^>]*>\\s*<\\/script>`, 'gi'), '');
  s = s.replace(/<script\b[^>]*\/js\/module-embed\.js[^>]*>\s*<\/script>/gi, '');
  return s;
}

/**
 * Remove managed module embeds whose token is not in keepTokens.
 * Active, already-placed widgets stay put (including inside design modules).
 */
function stripInactiveModuleEmbedsFromHtml(html, keepTokens) {
  const keep = keepTokens instanceof Set ? keepTokens : new Set(keepTokens || []);
  let s = String(html || '');
  s = s.replace(
    new RegExp(`<div\\b[^>]*\\b${MANAGED_ATTR}\\s*=\\s*["']?1["']?[^>]*>[\\s\\S]*?<\\/div>`, 'gi'),
    (block) => {
      const m = block.match(new RegExp(`${EMBED_TOKEN_ATTR}\\s*=\\s*["']([^"']+)["']`, 'i'));
      const tok = m && m[1] ? m[1] : '';
      if (tok && keep.has(tok)) return block;
      return '';
    }
  );
  s = s.replace(new RegExp(`<div\\b[^>]*\\b${MANAGED_ATTR}\\s*=\\s*["']?1["']?[^>]*\\/?>`, 'gi'), (block) => {
    const m = block.match(new RegExp(`${EMBED_TOKEN_ATTR}\\s*=\\s*["']([^"']+)["']`, 'i'));
    const tok = m && m[1] ? m[1] : '';
    if (tok && keep.has(tok)) return block;
    return '';
  });
  // Drop orphan iframes / scripts only when no active embeds remain on the page.
  const stillHas = [...keep].some((t) => htmlHasModuleToken(s, t));
  if (!stillHas) {
    s = s.replace(/<iframe\b[^>]*\/embed\/module\.html[^>]*>\s*<\/iframe>/gi, '');
    s = s.replace(/<iframe\b[^>]*\/embed\/module\.html[^>]*\/>/gi, '');
    s = s.replace(new RegExp(`<script\\b[^>]*\\b${SCRIPT_ATTR}\\b[^>]*>\\s*<\\/script>`, 'gi'), '');
    s = s.replace(/<script\b[^>]*\/js\/module-embed\.js[^>]*>\s*<\/script>/gi, '');
  }
  return s;
}

function pagesHaveModuleToken(pages, token) {
  const want = String(token || '').trim();
  if (!want) return false;
  try {
    const scan = require('../src/pageContentScan');
    if (scan.collectTypedTokens(pages, { module: true, form: false }).has(want)) return true;
    return scan.pagesBlobHas(pages, (blob, ctx) => {
      if (ctx && ctx.kind === 'cell.widget' && ctx.widget) {
        const w = ctx.widget;
        const wt = String(w.type || '').toLowerCase();
        if (wt === 'site_module' || wt === 'module') {
          return String(w.public_token || w.publicToken || '').trim() === want;
        }
      }
      return htmlHasModuleToken(blob, want);
    });
  } catch {
    for (const page of pages || []) {
      if (typeof page.html === 'string' && htmlHasModuleToken(page.html, want)) return true;
      if (Array.isArray(page.sections)) {
        for (const sec of page.sections) {
          if (!sec || !sec.content) continue;
          const c = sec.content;
          if (typeof c.html === 'string' && htmlHasModuleToken(c.html, want)) return true;
          const cells = Array.isArray(c.cells) ? c.cells : [];
          for (const cell of cells) {
            if (!cell) continue;
            if (typeof cell.html === 'string' && htmlHasModuleToken(cell.html, want)) return true;
            if (cell.widget) {
              const tok = String(cell.widget.public_token || cell.widget.publicToken || '').trim();
              if (tok === want) return true;
            }
          }
          const secType = String(sec.type || '').toLowerCase();
          if (secType === 'site_module' || secType === 'module') {
            const tok = String(c.public_token || c.publicToken || '').trim();
            if (tok === want) return true;
          }
        }
      }
    }
    return false;
  }
}

/**
 * Author-mode: page already serves a module purpose (token, typed section,
 * cell widget, or nav link to the module slug) — inject nothing for that purpose.
 */
function pageServesModulePurpose(pages, moduleType, token, slug) {
  const wantTok = String(token || '').trim();
  if (wantTok && pagesHaveModuleToken(pages, wantTok)) {
    return { served: true, reason: 'token_present' };
  }
  const wantType = String(moduleType || '').toLowerCase();
  const wantSlug = normalizeSlug(slug || '');
  for (const page of pages || []) {
    const pageSlug = normalizeSlug(page && page.slug);
    if (wantSlug && pageSlug === wantSlug) {
      // Target page exists with author content — treat as purpose served when it has any mount/slot.
      if (pageUsesSections(page)) {
        for (const sec of page.sections || []) {
          const t = String((sec && sec.type) || '').toLowerCase();
          if (t === 'site_module' || t === 'module') {
            const mt = String((sec.content && (sec.content.module_type || sec.content.moduleType)) || '').toLowerCase();
            if (!wantType || mt === wantType || !mt) {
              return { served: true, reason: 'typed_section', pageSlug };
            }
          }
          const cells = Array.isArray(sec && sec.content && sec.content.cells) ? sec.content.cells : [];
          for (const cell of cells) {
            if (cell && cell.widget) {
              const wt = String(
                cell.widget.module_type || cell.widget.moduleType || cell.widget.type || ''
              ).toLowerCase();
              if (wt === wantType || wt === 'site_module' || wt === 'module') {
                return { served: true, reason: 'cell_widget', pageSlug };
              }
            }
            if (cell && typeof cell.html === 'string' && /data-bitpype-module/i.test(cell.html)) {
              return { served: true, reason: 'cell_html_mount', pageSlug };
            }
          }
        }
      } else if (typeof page.html === 'string' && /data-bitpype-module/i.test(page.html)) {
        return { served: true, reason: 'page_html_mount', pageSlug };
      }
    }
  }
  return { served: false };
}

/** Describe what attach/sync would inject (author decides). */
function describeWouldInject(embed, appUrl) {
  const meta = MODULE_META[embed && embed.module_type] || {};
  if (meta.sitewide || (embed && embed.module_type === 'chatbot')) {
    return {
      moduleType: embed && embed.module_type,
      pageSlug: null,
      navLink: null,
      mountHtml: embedBlockHtml(embed, appUrl),
      createsPageIfMissing: false,
      insertsManagedNavOnFreeform: false,
      sitewide: true,
      note: 'Floating chat bubble on all pages via chat-embed.js (portal client MCP for replies).',
    };
  }
  const slug = normalizeSlug((embed && embed.target_page_slug) || meta.defaultSlug || 'home');
  const title = (embed && embed.title) || meta.defaultTitle || slug;
  return {
    moduleType: embed && embed.module_type,
    pageSlug: slug,
    navLink: { label: title, href: `${slug}.html`, slug },
    mountHtml: embedBlockHtml(embed, appUrl),
    createsPageIfMissing: true,
    insertsManagedNavOnFreeform: true,
  };
}

/**
 * Batch 149: delegate to the ONE canonical managed-script ensure
 * (src/managedScripts.ensureManagedScript) -- the per-family
 * strip/append copies were not idempotent (see managedScripts.js).
 */
function ensureModuleEmbedScript(html, appUrl) {
  const tag = moduleScriptTag(appUrl);
  if (!tag) return String(html || '');
  return require('../src/managedScripts').ensureManagedScript(html, 'module-embed.js', tag);
}

function isBareModulePage(html) {
  const s = String(html || '');
  if (!s.trim()) return true;
  if (/module-page/i.test(s) && !/<nav\b/i.test(s) && !/<header\b/i.test(s)) return true;
  const compact = s.replace(/\s+/g, ' ').trim();
  return /^<main\b[^>]*>.*<\/main>$/i.test(compact) && !/<nav\b/i.test(compact);
}

function pageUsesSections(page) {
  return !!(page && Array.isArray(page.sections) && page.sections.length > 0);
}

/** nav/html/footer freestyle pages (Delle Donne–style modular chrome). */
function isFreestyleModularPage(page) {
  if (!pageUsesSections(page)) return false;
  const types = page.sections.map((s) => (s && s.type) || '');
  if (!types.includes('nav') || !types.includes('footer')) return false;
  const nav = page.sections.find((s) => s && s.type === 'nav');
  return !!(nav && nav.content && typeof nav.content.html === 'string' && nav.content.html.trim());
}

function findFreestyleTemplatePage(pages, excludeSlug) {
  const skip = excludeSlug != null ? normalizeSlug(excludeSlug) : '';
  const ranked = (pages || []).filter((p) => {
    if (!p || (skip && normalizeSlug(p.slug) === skip)) return false;
    return isFreestyleModularPage(p);
  });
  ranked.sort((a, b) => {
    const sa = normalizeSlug(a.slug);
    const sb = normalizeSlug(b.slug);
    const score = (slug) => (slug === 'home' || slug === 'index' ? 10 : 0) + (slug === 'contact' ? 2 : 0);
    return score(sb) - score(sa);
  });
  return ranked[0] || null;
}

function findFreestyleBodySection(page) {
  if (!pageUsesSections(page)) return null;
  return (
    page.sections.find(
      (s) =>
        s &&
        s.type === 'html' &&
        typeof (s.content && s.content.html) === 'string' &&
        /<main\b/i.test(s.content.html) &&
        !(s.content && s.content.bitpype_module_managed)
    ) ||
    page.sections.find(
      (s) =>
        s &&
        s.type === 'html' &&
        s.content &&
        typeof s.content.html === 'string' &&
        !(s.content && s.content.bitpype_module_managed)
    ) ||
    null
  );
}

function freestyleMobileBarFromTemplate(templatePage) {
  if (!templatePage || !pageUsesSections(templatePage)) return '';
  const htmlSec = templatePage.sections.find((s) => s && s.type === 'html');
  const html = htmlSec && htmlSec.content && htmlSec.content.html;
  if (typeof html !== 'string') return '';
  const mob = html.match(/<div class="mobilebar"[\s\S]*?<\/div>/i);
  return mob ? mob[0] : '';
}

function pushFreestyleModulePage(pages, { slug, title }) {
  const template = findFreestyleTemplatePage(pages, slug);
  if (!template) return false;
  const navSec = template.sections.find((s) => s && s.type === 'nav');
  const footSec = template.sections.find((s) => s && s.type === 'footer');
  if (!navSec || !footSec) return false;
  let body = ensureClientPageChrome(`<main class="bp-mod-main" id="main">${defaultClientPageInner(title)}</main>`);
  const mob = freestyleMobileBarFromTemplate(template);
  if (mob) body += `\n${mob}`;
  pages.push({
    slug,
    title,
    sections: [
      JSON.parse(JSON.stringify(navSec)),
      { type: 'html', content: { html: body } },
      JSON.parse(JSON.stringify(footSec)),
    ],
  });
  return true;
}

const MODULE_PAGE_INTRO = {
  bookings: 'Schedule electrical service online — pick a date and time that works for you.',
  blog: 'Read updates, tips, and news from our team.',
  ecommerce: 'Browse products and place an order online.',
  courses: 'Explore courses and enroll online.',
  gallery: 'View our recent work and project photos.',
  directory: 'Find people, places, and resources in our directory.',
  faq: 'Answers to common questions.',
  testimonials: 'See what customers are saying about us.',
  team: 'Meet the people behind our work.',
  events: 'Upcoming events and how to join.',
};

function upgradeModulePageIntro(html, pageEmbeds) {
  let s = String(html || '');
  const primary = pageEmbeds && pageEmbeds[0];
  const moduleType = primary && primary.module_type;
  const intro = MODULE_PAGE_INTRO[moduleType] || 'Use the tool below to get started.';
  if (!/<section\b[^>]*\bws-page-section\b/i.test(s)) return s;
  return s.replace(/<section\b([^>]*\bws-page-section\b[^>]*)>[\s\S]*?<\/section>/i, (block) => {
    if (!/add your content here|write this section|use \+ to add/i.test(block)) return block;
    const attrs = block.match(/^<section\b([^>]*)>/i);
    const open = attrs ? `<section${attrs[1]}>` : '<section class="ws-page-section" data-ws-page-section="1">';
    return `${open}<p>${escapeHtml(intro)}</p></section>`;
  });
}

function shellHtmlFromPages(pages, excludeSlug) {
  const skip = excludeSlug != null ? normalizeSlug(excludeSlug) : '';
  const ranked = [];
  for (const p of pages || []) {
    if (!p || typeof p.html !== 'string' || !p.html.trim()) continue;
    if (skip && normalizeSlug(p.slug) === skip) continue;
    if (isBareModulePage(p.html)) continue;
    const html = String(p.html);
    const score =
      (/<nav\b/i.test(html) ? 4 : 0) +
      (/<header\b/i.test(html) ? 2 : 0) +
      (/<footer\b/i.test(html) ? 1 : 0) +
      (normalizeSlug(p.slug) === 'home' || normalizeSlug(p.slug) === 'index' ? 8 : 0);
    ranked.push({ html, score });
  }
  ranked.sort((a, b) => b.score - a.score);
  if (ranked.length) return ranked[0].html;

  // Sections-only sites: synthesize a shell from freestyle nav/footer chrome.
  const home =
    (pages || []).find((p) => {
      if (!p || (skip && normalizeSlug(p.slug) === skip)) return false;
      const slug = normalizeSlug(p.slug);
      return slug === 'home' || slug === 'index' || p.slug === '/';
    }) || (pages || []).find((p) => p && pageUsesSections(p) && !(skip && normalizeSlug(p.slug) === skip));

  if (home && pageUsesSections(home)) {
    const nav = home.sections.find((s) => s && s.type === 'nav');
    const foot = home.sections.find((s) => s && s.type === 'footer');
    const navH = nav && nav.content && typeof nav.content.html === 'string' ? nav.content.html : '';
    const footH = foot && foot.content && typeof foot.content.html === 'string' ? foot.content.html : '';
    if (navH || footH) {
      return `${navH}\n<main class="bp-mod-main" id="main"></main>\n${footH}`;
    }
  }
  return '';
}

/** Blog-like page chrome (shared with module-embed bp-mod-* classes). */
const PAGE_CHROME_CSS = [
  'main.bp-mod-main,.bp-mod-main{',
  'max-width:1100px;width:100%;margin-left:auto;margin-right:auto;',
  'padding:clamp(1.75rem,4vw,3.25rem) clamp(1.1rem,3.5vw,2rem) clamp(3.5rem,8vw,5.5rem);',
  'box-sizing:border-box;',
  '}',
  'main.bp-mod-main > .bp-mod-page-title,.bp-mod-page-title{',
  'margin:0 0 0.2em;letter-spacing:-0.03em;line-height:1.08;',
  'font-size:clamp(2rem,4.5vw,3rem);',
  '}',
  '.ws-page-section{margin:1.35rem 0 0}',
  '.ws-page-section > h2:first-child{margin:0 0 0.45rem;letter-spacing:-0.02em;',
  'font-size:clamp(1.25rem,2.4vw,1.65rem);line-height:1.2}',
  '.ws-page-section > p{margin:0.55rem 0 0;max-width:42ch;',
  'color:var(--ws-muted,var(--muted,color-mix(in srgb,currentColor 58%,transparent)));',
  'font-size:1.05rem;line-height:1.55}',
].join('');

function ensurePageChromeStyle(html) {
  const s = String(html || '');
  if (!s.trim()) return s;
  if (/data-ws-page-chrome\s*=/.test(s)) return s;
  const tag = `<style data-ws-page-chrome="1">${PAGE_CHROME_CSS}</style>`;
  if (/<\/head>/i.test(s)) return s.replace(/<\/head>/i, `${tag}</head>`);
  return `${tag}${s}`;
}

function withMainClass(openTag, className) {
  const open = String(openTag || '<main>');
  const cls = String(className || '').trim();
  if (!cls) return open;
  if (new RegExp(`\\b${cls.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(open)) return open;
  if (/\bclass\s*=\s*"/i.test(open)) {
    return open.replace(/\bclass\s*=\s*"/i, `class="${cls} `);
  }
  if (/\bclass\s*=\s*'/i.test(open)) {
    return open.replace(/\bclass\s*=\s*'/i, `class='${cls} `);
  }
  return open.replace(/^<main\b/i, `<main class="${cls}"`);
}

/** Default interior for client-created / sparse pages — matches Blog title treatment. */
function defaultClientPageInner(title) {
  const t = escapeHtml(String(title || 'Page').trim() || 'Page');
  return (
    `<h1 class="bp-mod-page-title">${t}</h1>` +
    `<section class="ws-page-section" data-ws-page-section="1">` +
    `<h2>Add your content here.</h2>` +
    `<p>Write this section, or use + to add another.</p>` +
    `</section>`
  );
}

/**
 * Upgrade sparse freeform <main> chrome (bare h1 + loose copy) into Blog-like
 * title + ws-page-section blocks, preserving module/form embeds.
 */
function ensureClientPageChrome(pageHtml) {
  let html = ensurePageChromeStyle(String(pageHtml || ''));
  if (!html.trim() || !/<main\b/i.test(html)) return html;
  return html.replace(/<main\b[^>]*>[\s\S]*?<\/main>/i, (mainBlock) => {
    const openMatch = mainBlock.match(/^<main\b[^>]*>/i);
    const open = withMainClass(openMatch ? openMatch[0] : '<main>', 'bp-mod-main');
    const openLen = openMatch ? openMatch[0].length : 6;
    const closeStart = mainBlock.lastIndexOf('</');
    const inner = closeStart > 0 ? mainBlock.slice(openLen, closeStart) : '';
    if (/data-ws-page-section\s*=|class="[^"]*\bws-page-section\b/i.test(inner)) {
      const titled = inner.replace(/^\s*(<h1\b)([^>]*)(>)/i, (full, tag, attrs, close) => {
        if (/\bbp-mod-page-title\b/.test(attrs)) return full;
        if (/\bclass\s*=\s*"/i.test(attrs)) {
          return `${tag}${attrs.replace(/\bclass\s*=\s*"/i, 'class="bp-mod-page-title ')}${close}`;
        }
        return `${tag}${attrs} class="bp-mod-page-title"${close}`;
      });
      return `${open}${titled}</main>`;
    }
    const titleMatch = inner.match(/^\s*(<h1\b[^>]*>[\s\S]*?<\/h1>)/i);
    let titleHtml = '';
    let rest = inner;
    if (titleMatch) {
      titleHtml = titleMatch[1].replace(/^(<h1\b)([^>]*)(>)/i, (full, tag, attrs, close) => {
        if (/\bbp-mod-page-title\b/.test(attrs)) return full;
        if (/\bclass\s*=\s*"/i.test(attrs)) {
          return `${tag}${attrs.replace(/\bclass\s*=\s*"/i, 'class="bp-mod-page-title ')}${close}`;
        }
        return `${tag}${attrs} class="bp-mod-page-title"${close}`;
      });
      rest = inner.slice(titleMatch[0].length);
    }
    const embedChunks = [];
    const contentParts = [];
    const chunkRe =
      /(<div\b[^>]*(?:bitpype-module|bitpype-form|bp-mod)[^>]*>[\s\S]*?<\/div>|<iframe\b[^>]*>[\s\S]*?<\/iframe>)/gi;
    let cm;
    let cursor = 0;
    while ((cm = chunkRe.exec(rest))) {
      if (cm.index > cursor) {
        const gap = rest.slice(cursor, cm.index);
        if (gap.trim()) contentParts.push(gap);
      }
      embedChunks.push(cm[0]);
      cursor = cm.index + cm[0].length;
    }
    if (cursor < rest.length) {
      const tail = rest.slice(cursor);
      if (tail.trim()) contentParts.push(tail);
    }
    const body = contentParts.join('').trim();
    let sectionHtml = '';
    if (body) {
      sectionHtml = `<section class="ws-page-section" data-ws-page-section="1">${body}</section>`;
    } else if (titleHtml) {
      sectionHtml = contentSectionHtml({
        heading: 'Add your content here.',
        body: 'Write this section, or use + to add another.',
      });
    }
    return `${open}${titleHtml}${sectionHtml}${embedChunks.join('')}</main>`;
  });
}

/** Blank content block inserted by portal edit-mode / structure “Content section”. */
function contentSectionHtml(opts = {}) {
  const heading = escapeHtml(String(opts.heading || 'New section').trim() || 'New section');
  const body = escapeHtml(String(opts.body || 'Add your content here.').trim() || 'Add your content here.');
  return (
    `<section class="ws-page-section" data-ws-page-section="1">` +
    `<h2>${heading}</h2>` +
    `<p>${body}</p>` +
    `</section>`
  );
}


function fillShellMain(shellHtml, innerHtml) {
  let html = stripManagedNavLinks(stripManagedModuleEmbedsFromHtml(shellHtml));
  const inner = String(innerHtml || '');
  if (!html.trim()) {
    return ensurePageChromeStyle(`<main class="bp-mod-main page module-page">${inner}</main>`);
  }
  if (/<main\b[^>]*>[\s\S]*?<\/main>/i.test(html)) {
    html = html.replace(/<main\b[^>]*>[\s\S]*?<\/main>/i, (m) => {
      const open = withMainClass(m.match(/^<main\b[^>]*>/i)[0], 'bp-mod-main');
      return `${open}${inner}</main>`;
    });
    return ensurePageChromeStyle(html);
  }
  if (/<\/header>/i.test(html) && /<footer\b/i.test(html)) {
    html = html.replace(
      /<\/header>[\s\S]*?<footer\b/i,
      `</header>\n<main class="bp-mod-main page module-page">${inner}</main>\n<footer`
    );
    return ensurePageChromeStyle(html);
  }
  if (/<\/body>/i.test(html)) {
    html = html.replace(/<\/body>/i, `<main class="bp-mod-main page module-page">${inner}</main></body>`);
    return ensurePageChromeStyle(html);
  }
  return ensurePageChromeStyle(`${html}\n<main class="bp-mod-main page module-page">${inner}</main>`);
}

function injectHtmlEmbed(pageHtml, block) {
  let html = String(pageHtml || '');
  const chunk = String(block || '');
  // Author / prior inject wins — never stack a second mount of the same token or type.
  const token = (chunk.match(/\bdata-bitpype-module-token\s*=\s*["']([^"']+)["']/i) || [])[1];
  const modType = (chunk.match(/\bdata-bitpype-module-type\s*=\s*["']([^"']+)["']/i) || [])[1];
  if (token && htmlHasModuleToken(html, token)) return html;
  if (
    modType &&
    new RegExp(
      `\\bdata-bitpype-module-type\\s*=\\s*["']${modType.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`,
      'i'
    ).test(html)
  ) {
    return html;
  }
  if (!html.trim()) {
    return `<main class="bitpype-modules">${chunk}</main>`;
  }
  block = chunk;
  if (/<main\b/i.test(html)) {
    const secRe = /<section\b[^>]*\bws-page-section\b[^>]*>[\s\S]*?<\/section>/gi;
    let last;
    let m;
    while ((m = secRe.exec(html))) last = m;
    if (last) {
      const inner = last[0];
      if (!/bitpype-module-embed/i.test(inner)) {
        const upgraded = inner.replace(/<\/section>/i, `\n${block}</section>`);
        return html.slice(0, last.index) + upgraded + html.slice(last.index + last[0].length);
      }
    }
  }
  if (/<\/main>/i.test(html)) {
    return html.replace(/<\/main>/i, `${block}</main>`);
  }
  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${block}</body>`);
  }
  if (/<footer\b/i.test(html)) {
    return html.replace(/<footer\b/i, `${block}<footer`);
  }
  return `${html}\n${block}`;
}

/* ── Top-nav links for module pages ── */

function scanOpenTag(html, from, tag) {
  const re = new RegExp(`<${tag}\\b`, 'ig');
  re.lastIndex = Math.max(0, from || 0);
  const m = re.exec(html);
  if (!m || m.index < from) return null;
  let quote = null;
  for (let i = m.index + m[0].length; i < html.length; i++) {
    const c = html[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === '>') {
      const selfClosing = html[i - 1] === '/';
      return {
        start: m.index,
        openEnd: i + 1,
        attrs: html.slice(m.index + m[0].length, selfClosing ? i - 1 : i),
        selfClosing,
      };
    }
  }
  return null;
}

function findElement(html, tag, from) {
  const open = scanOpenTag(html, from || 0, tag);
  if (!open) return null;
  if (open.selfClosing) {
    return {
      start: open.start,
      openEnd: open.openEnd,
      closeStart: open.openEnd,
      end: open.openEnd,
      attrs: open.attrs,
    };
  }
  let depth = 1;
  let i = open.openEnd;
  const closeRe = new RegExp(`</${tag}\\s*>`, 'ig');
  while (i < html.length && depth > 0) {
    const nextOpen = scanOpenTag(html, i, tag);
    closeRe.lastIndex = i;
    const nextClose = closeRe.exec(html);
    if (!nextClose) return null;
    if (nextOpen && nextOpen.start < nextClose.index) {
      depth += 1;
      i = nextOpen.openEnd;
    } else {
      depth -= 1;
      if (depth === 0) {
        return {
          start: open.start,
          openEnd: open.openEnd,
          closeStart: nextClose.index,
          end: nextClose.index + nextClose[0].length,
          attrs: open.attrs,
        };
      }
      i = nextClose.index + nextClose[0].length;
    }
  }
  return null;
}

function findAllElements(html, tag) {
  const out = [];
  let from = 0;
  while (from < html.length) {
    const el = findElement(html, tag, from);
    if (!el) break;
    out.push(el);
    from = Math.max(el.end, from + 1);
  }
  return out;
}

function shiftEl(el, delta) {
  return {
    start: el.start + delta,
    openEnd: el.openEnd + delta,
    closeStart: el.closeStart + delta,
    end: el.end + delta,
    attrs: el.attrs,
  };
}

function attrValue(attrs, name) {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`, 'i');
  const m = String(attrs || '').match(re);
  if (!m) return '';
  if (m[1] != null) return m[1];
  if (m[2] != null) return m[2];
  return m[3] || '';
}

function cleanClass(cls) {
  return String(cls || '')
    .split(/\s+/)
    .filter((c) => c && !/^(active|current|is-active|is-current|selected|here)$/i.test(c))
    .join(' ');
}

function isPageLikeHref(href) {
  try {
    const eng = require('../src/websiteEngine');
    if (typeof eng.isComparableNavHref === 'function') return eng.isComparableNavHref(href);
  } catch {
    /* fall through */
  }
  const h = String(href || '').trim();
  if (!h || /^(mailto:|tel:|javascript:|https?:|\/\/)/i.test(h)) return false;
  if (h.charAt(0) === '#') return /^#[A-Za-z][A-Za-z0-9_-]*$/.test(h);
  const path = h.split('#')[0].split('?')[0];
  // Bare "/" is home — must count as a page link or rebuild leaves it and injects another Home.
  if (path === '/' || path === '') return true;
  return /^(\.\.\/|\.\/|\/)?[A-Za-z0-9][A-Za-z0-9_-]*(\.html?)?$/i.test(path);
}

function hrefPrefix(href) {
  const t = String(href || '').trim();
  if (t.startsWith('../')) return '../';
  if (t.startsWith('./')) return './';
  if (t.startsWith('/') && !t.startsWith('//')) return '/';
  return '';
}

function majority(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  let best = values[0] || '';
  let n = -1;
  for (const [k, c] of counts) {
    if (c > n) {
      best = k;
      n = c;
    }
  }
  return best;
}

/** Sibling href style, filename from pageFileName. Hashes are not a second scheme. */
function moduleHref(slug, sampleHrefs) {
  const file = pageFileName(normalizeSlug(slug));
  const samples = (sampleHrefs || [])
    .map((h) => String(h || '').trim())
    .filter((h) => h && h.charAt(0) !== '#' && isPageLikeHref(h));
  if (!samples.length) return file;
  const prefix = majority(samples.map(hrefPrefix));
  let htmlVotes = 0;
  let bareVotes = 0;
  for (const h of samples) {
    const path = h
      .split('#')[0]
      .split('?')[0]
      .replace(/^\.\.\//, '')
      .replace(/^\.\//, '')
      .replace(/^\//, '');
    if (/\.html?$/i.test(path)) htmlVotes += 1;
    else if (path) bareVotes += 1;
  }
  const name = bareVotes > htmlVotes ? file.replace(/\.html$/i, '') : file;
  return prefix + name;
}

function hrefTargetsPage(href, slug) {
  const want = routeKey(slug);
  const raw = String(href || '').trim();
  if (!raw) return false;
  return routeKey(raw) === want;
}

function pageAnchorsIn(html, el) {
  if (!el || el.openEnd == null || el.closeStart == null) return [];
  const inner = html.slice(el.openEnd, el.closeStart);
  const out = [];
  for (const a of findAllElements(inner, 'a')) {
    const href = attrValue(a.attrs, 'href');
    if (!isPageLikeHref(href)) continue;
    if (new RegExp(`\\b${NAV_ATTR}\\b`, 'i').test(a.attrs || '')) continue;
    const shifted = shiftEl(a, el.openEnd);
    shifted.href = href;
    out.push(shifted);
  }
  return out;
}

function topLevelAnchors(html, el) {
  const all = pageAnchorsIn(html, el);
  const inner = html.slice(el.openEnd, el.closeStart);
  const nested = [];
  for (const tag of ['ul', 'ol']) {
    for (const list of findAllElements(inner, tag)) {
      nested.push({ start: el.openEnd + list.start, end: el.openEnd + list.end });
    }
  }
  if (!nested.length) return all;
  const top = all.filter((a) => !nested.some((n) => a.start >= n.start && a.end <= n.end));
  return top.length ? top : all;
}

function pickLinkRow(html, el) {
  const innerFrom = el.openEnd;
  const inner = html.slice(el.openEnd, el.closeStart);
  const lists = [];
  for (const tag of ['ul', 'ol']) {
    for (const list of findAllElements(inner, tag)) {
      const abs = shiftEl(list, innerFrom);
      const links = pageAnchorsIn(html, abs);
      if (links.length) lists.push({ container: abs, links, pageLinks: links.length, useLi: true });
    }
  }
  lists.sort((a, b) => b.pageLinks - a.pageLinks || a.container.start - b.container.start);
  const bestList = lists[0] || null;
  const direct = pageAnchorsIn(html, el);
  // A menu list wins over a logo/CTA sitting beside it.
  if (bestList && bestList.pageLinks >= 2) return bestList;
  if (direct.length) {
    if (bestList && bestList.pageLinks === direct.length) return bestList;
    return { container: el, links: direct, pageLinks: direct.length, useLi: false };
  }
  return bestList;
}

function collectRanges(html, kind) {
  const ranges = [];
  const seen = new Set();
  const re = /<([a-zA-Z][\w:-]*)\b([^>]*)>/g;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[1];
    const attrs = m[2] || '';
    const t = tag.toLowerCase();
    let ok = false;
    if (kind === 'footer') {
      ok = t === 'footer' || /\bfooter\b/i.test(attrs) || /\brole\s*=\s*["']contentinfo["']/i.test(attrs);
    } else {
      ok =
        t === 'header' ||
        /\brole\s*=\s*["']banner["']/i.test(attrs) ||
        /\b(site-header|page-header|masthead|navbar|topbar)\b/i.test(attrs);
    }
    if (!ok) continue;
    if (/\/\s*$/.test(attrs)) continue;
    const el = findElement(html, tag, m.index);
    if (!el || seen.has(el.start)) continue;
    seen.add(el.start);
    ranges.push(el);
  }
  return ranges;
}

function indexInside(ranges, idx) {
  return ranges.some((r) => idx >= r.start && idx < r.end);
}

/**
 * Primary top nav: the header/nav link row, never the footer, never a list in the body.
 * Returns null when nothing safe is found — callers must not invent a header.
 */
function choosePrimaryNav(html) {
  const footerRanges = collectRanges(html, 'footer');
  const headerRanges = collectRanges(html, 'header');
  const mainAt = html.search(/<main\b/i);
  const candidates = [];
  for (const nav of findAllElements(html, 'nav')) {
    if (indexInside(footerRanges, nav.start)) continue;
    const blob = nav.attrs || '';
    if (/\b(footer|breadcrumb|social|legal|skip)\b/i.test(blob)) continue;
    const row = pickLinkRow(html, nav);
    if (!row || row.pageLinks < 1) continue;
    const fileLinks = row.links.filter(
      (a) =>
        String(a.href || '')
          .trim()
          .charAt(0) !== '#'
    ).length;
    let score = Math.min(row.pageLinks, 6) + fileLinks * 2;
    if (indexInside(headerRanges, nav.start)) score += 12;
    if (
      /\b(primary|main|site)\b/i.test(blob) ||
      /aria-label\s*=\s*["'][^"']*(primary|main|site|navigation)/i.test(blob)
    ) {
      score += 6;
    }
    if (/\b(nav|menu|header)\b/i.test(blob)) score += 3;
    if (mainAt >= 0 && nav.start < mainAt) score += 8;
    candidates.push({
      scope: nav,
      container: row.container,
      links: row.links,
      useLi: row.useLi,
      score,
      start: nav.start,
    });
  }
  if (!candidates.length) {
    for (const header of findAllElements(html, 'header')) {
      if (indexInside(footerRanges, header.start)) continue;
      if (/\bfooter\b/i.test(header.attrs || '')) continue;
      const row = pickLinkRow(html, header);
      if (!row || row.pageLinks < 2) continue;
      candidates.push({
        scope: header,
        container: row.container,
        links: row.links,
        useLi: row.useLi,
        score: row.pageLinks,
        start: header.start,
      });
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score || a.start - b.start);
  return candidates[0];
}

/**
 * Managed module nav chunks (li or a with data-bitpype-module-nav).
 * pageAnchorsIn intentionally skips these — collect separately so rebuild
 * can clear/hide/reorder them with the rest of the menu.
 */
function managedNavRangesIn(html, container) {
  if (!container || container.openEnd == null || container.closeStart == null) return [];
  const inner = html.slice(container.openEnd, container.closeStart);
  const attr = NAV_ATTR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const quoted = '(?:"[^"]*"|\'[^\']*\')';
  const ranges = [];
  const liRe = new RegExp(`<li\\b[^>]*\\b${attr}\\s*=\\s*${quoted}[^>]*>[\\s\\S]*?<\\/li>`, 'gi');
  let m;
  while ((m = liRe.exec(inner))) {
    ranges.push({
      start: container.openEnd + m.index,
      end: container.openEnd + m.index + m[0].length,
      html: m[0],
    });
  }
  const aRe = new RegExp(`<a\\b[^>]*\\b${attr}\\s*=\\s*${quoted}[^>]*>[\\s\\S]*?<\\/a>`, 'gi');
  while ((m = aRe.exec(inner))) {
    const startPos = container.openEnd + m.index;
    const endPos = startPos + m[0].length;
    if (ranges.some((r) => startPos >= r.start && endPos <= r.end)) continue;
    ranges.push({ start: startPos, end: endPos, html: m[0] });
  }
  return ranges;
}

/**
 * Footer link row: the link list inside the page footer, never the header/nav.
 * Picks the footer range whose row carries the most page links, mirroring
 * choosePrimaryNav's container picking so the footer can be rebuilt with the
 * same machinery against the footer link set.
 */
function chooseFooterLinkRow(html) {
  let best = null;
  for (const footer of collectRanges(html, 'footer')) {
    const row = pickLinkRow(html, footer);
    if (!row || row.pageLinks < 1) continue;
    if (!best || row.pageLinks > best.pageLinks) {
      best = {
        scope: footer,
        container: row.container,
        links: row.links,
        useLi: row.useLi,
        pageLinks: row.pageLinks,
        start: footer.start,
      };
    }
  }
  return best;
}

/**
 * Rebuild the primary header/nav link row to match portal menu order + navVisible.
 * Preserves logo/CTA outside the link row. Module pages (Blog/Shop/…) participate
 * like any other page via navLinks; old managed leftovers are cleared from the row.
 * opts.region === 'footer' rebuilds the footer link row instead, against the
 * footer link set (see buildFooterLinks in src/siteStructure.js for the rule).
 */
function rebuildFreeformPrimaryNav(html, navLinks, pages, opts = {}) {
  const src = String(html || '');
  if (!src.trim() || !Array.isArray(pages) || pages.length < 2) return src;
  const links = Array.isArray(navLinks) ? navLinks : [];
  const chosen = opts.region === 'footer' ? chooseFooterLinkRow(src) : choosePrimaryNav(src);
  if (!chosen || !chosen.container) return src;

  const container = chosen.container;
  const pageAnchors = pageAnchorsIn(src, container);
  const managedRanges = managedNavRangesIn(src, container);
  if (!pageAnchors.length && !managedRanges.length) return src;

  const activeBySlug = new Map();
  const activeModules = Array.isArray(opts.activeModules) ? opts.activeModules : [];
  activeModules.forEach((it) => {
    const slug = normalizeSlug(it && it.slug);
    const type = String((it && it.type) || '').trim();
    if (slug && type) activeBySlug.set(slug, type);
  });

  const rowLinks = chosen.links || pageAnchors;
  const template = templateAnchor(rowLinks.length ? rowLinks : pageAnchors);
  if (!template && !links.length) {
    if (!managedRanges.length) return src;
    const removeStart = Math.min(...managedRanges.map((r) => r.start));
    const removeEnd = Math.max(...managedRanges.map((r) => r.end));
    return src.slice(0, removeStart) + src.slice(removeEnd);
  }
  const tpl = template || pageAnchors[0];
  if (!tpl) return src;
  const sampleHrefs = (rowLinks.length ? rowLinks : pageAnchors).map((a) => a.href).filter(Boolean);
  const useLi = !!chosen.useLi;
  const innerSlice = src.slice(container.openEnd, container.closeStart);
  const sep = /\n/.test(innerSlice) ? '\n' : ' ';

  // Preserve custom labels (e.g. Journal → blog.html) when rebuilding.
  // Key by normalizeRoute so "/" and "/index" reuse the same authored Home link.
  const existingByRoute = new Map();
  const existingByLabel = new Map();
  const scanInner = src.slice(container.openEnd, container.closeStart);
  for (const a of findAllElements(scanInner, 'a')) {
    const href = attrValue(a.attrs, 'href');
    if (!isPageLikeHref(href)) continue;
    const route = routeKey(href);
    const shifted = shiftEl(a, container.openEnd);
    const chunk = {
      html: src.slice(shifted.start, shifted.end),
      attrs: a.attrs || '',
      href,
    };
    const label = anchorTextLabel(src.slice(shifted.openEnd, shifted.closeStart));
    if (route && !existingByRoute.has(route)) existingByRoute.set(route, chunk);
    if (label && !existingByLabel.has(label)) existingByLabel.set(label, chunk);
  }

  const anchorFromTemplate = (href, label, moduleType) => {
    const route = routeKey(href);
    const labelKey = String(label || '')
      .trim()
      .toLowerCase();
    const prev = (route && existingByRoute.get(route)) || (labelKey && existingByLabel.get(labelKey)) || null;
    if (prev && prev.html) {
      let reused = prev.html;
      // Keep author href when it already targets the same route (e.g. "/" vs "/index").
      const prevRoute = routeKey(prev.href);
      if (prevRoute !== route) {
        reused = reused.replace(/\bhref\s*=\s*(["'])[^"']*\1/i, `href="${escapeAttr(href)}"`);
      }
      if (moduleType) {
        if (new RegExp(`\\b${NAV_ATTR}\\b`, 'i').test(reused)) {
          reused = reused.replace(
            new RegExp(`\\b${NAV_ATTR}\\s*=\\s*(["'])[^"']*\\1`, 'i'),
            `${NAV_ATTR}="${escapeAttr(moduleType)}"`
          );
        } else {
          reused = reused.replace(/^<a\b/i, `<a ${NAV_ATTR}="${escapeAttr(moduleType)}"`);
        }
      }
      return reused;
    }
    const cls = cleanClass(attrValue(tpl.attrs, 'class'));
    const clsAttr = cls ? ` class="${escapeAttr(cls)}"` : '';
    const modAttr = moduleType ? ` ${NAV_ATTR}="${escapeAttr(moduleType)}"` : '';
    return `<a${clsAttr} href="${escapeAttr(href)}"${modAttr}>${escapeHtml(label || href)}</a>`;
  };

  const liShell = (anchorHtml, extraCls, moduleType) => {
    if (!useLi) return anchorHtml;
    const liTpl = liWrapping(src, container, tpl);
    const liCls = cleanClass([extraCls, liTpl ? attrValue(liTpl.attrs, 'class') : ''].filter(Boolean).join(' '));
    const liClsAttr = liCls ? ` class="${escapeAttr(liCls)}"` : '';
    const modAttr = moduleType ? ` ${NAV_ATTR}="${escapeAttr(moduleType)}"` : '';
    return `<li${liClsAttr}${modAttr}>${anchorHtml}</li>`;
  };

  const chunkForLink = (link) => {
    const slug = normalizeSlug(link.slug);
    const moduleType = activeBySlug.get(slug) || '';
    const href = moduleHref(link.slug, sampleHrefs);
    const top = anchorFromTemplate(href, link.label, moduleType);
    const kids = Array.isArray(link.children) ? link.children : [];
    if (!kids.length) return liShell(top, '', moduleType);
    const subParts = kids
      .map((c) => {
        const childType = activeBySlug.get(normalizeSlug(c.slug)) || '';
        const ch = anchorFromTemplate(moduleHref(c.slug, sampleHrefs), c.label, childType);
        if (!useLi) return ch;
        const childMod = childType ? ` ${NAV_ATTR}="${escapeAttr(childType)}"` : '';
        return `<li${childMod}>${ch}</li>`;
      })
      .join('');
    const sub = useLi ? `<ul class="nav-sub">${subParts}</ul>` : `<span class="nav-sub">${subParts}</span>`;
    return useLi
      ? liShell(`${top}${sub}`, 'has-children', moduleType)
      : `<span class="nav-item has-children">${top}${sub}</span>`;
  };

  const newPageChunk = links.map(chunkForLink).join(sep);
  // Batch 149: the chunk regenerates each item WITH its <li> shell, so
  // the replaced span must cover the shells too. The pre-149 span ran
  // from the first anchor's start to the last anchor's end, leaving the
  // first item's <li> and the last item's </li> outside the span --
  // they survived every rebuild and nested one more empty <li> per save.
  const itemRange = (r) => {
    if (!useLi) return r;
    const li = liWrapping(src, container, r);
    return li ? { start: li.start, end: li.end } : r;
  };
  const starts = pageAnchors.map((a) => itemRange(a).start).concat(managedRanges.map((r) => itemRange(r).start));
  const ends = pageAnchors.map((a) => itemRange(a).end).concat(managedRanges.map((r) => itemRange(r).end));
  const removeStart = Math.min(...starts);
  const removeEnd = Math.max(...ends);
  const out = src.slice(0, removeStart) + newPageChunk + src.slice(removeEnd);
  try {
    const eng = require('../src/websiteEngine');
    if (typeof eng.assertAndDedupeNavHtml === 'function') {
      return eng.assertAndDedupeNavHtml(
        out,
        opts.region === 'footer' ? 'rebuildFreeformFooterLinks' : 'rebuildFreeformPrimaryNav'
      );
    }
  } catch {
    /* optional */
  }
  return out;
}

/**
 * Rebuild the footer link row to the footer link set (full page set incl.
 * module pages and navVisible:false pages) in the same sync pass as the nav.
 */
function rebuildFreeformFooterLinks(html, footerLinks, pages, opts = {}) {
  return rebuildFreeformPrimaryNav(html, footerLinks, pages, Object.assign({}, opts, { region: 'footer' }));
}

function templateAnchor(anchors) {
  const files = anchors.filter(
    (a) =>
      String(a.href || '')
        .trim()
        .charAt(0) !== '#'
  );
  const pool = files.length ? files : anchors;
  for (let i = pool.length - 1; i >= 0; i--) {
    const cls = attrValue(pool[i].attrs, 'class');
    if (/\b(cta|btn|button)\b/i.test(cls)) continue;
    return pool[i];
  }
  return pool.length ? pool[pool.length - 1] : null;
}

function liWrapping(html, container, anchor) {
  const inner = html.slice(container.openEnd, container.closeStart);
  const relStart = anchor.start - container.openEnd;
  const relEnd = anchor.end - container.openEnd;
  let best = null;
  for (const li of findAllElements(inner, 'li')) {
    if (relStart >= li.start && relEnd <= li.end) {
      if (!best || li.end - li.start < best.end - best.start) best = li;
    }
  }
  if (!best) return null;
  return shiftEl(best, container.openEnd);
}

function gapBefore(html, index) {
  const back = html.slice(Math.max(0, index - 80), index);
  const m = back.match(/(\s+)$/);
  if (!m) return '';
  const nl = m[1].match(/(\r?\n[ \t]*)$/);
  if (nl) return nl[1];
  return ' ';
}

function stripManagedNavLinks(html) {
  let s = String(html || '');
  const attr = NAV_ATTR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const quoted = `(?:"[^"]*"|'[^']*')`;
  s = s.replace(new RegExp(`<li\\b[^>]*\\b${attr}\\s*=\\s*${quoted}[^>]*>[\\s\\S]*?<\\/li>`, 'gi'), '');
  s = s.replace(new RegExp(`<a\\b[^>]*\\b${attr}\\s*=\\s*${quoted}[^>]*>[\\s\\S]*?<\\/a>`, 'gi'), '');
  return s;
}

function navItemHtml(item, { href, className, liClass, useLi }) {
  const type = escapeAttr(item.type);
  const cls = className ? ` class="${escapeAttr(className)}"` : '';
  const anchor = `<a${cls} href="${escapeAttr(href)}" ${NAV_ATTR}="${type}">${escapeHtml(item.label)}</a>`;
  if (!useLi) return anchor;
  const liCls = liClass ? ` class="${escapeAttr(liClass)}"` : '';
  return `<li${liCls} ${NAV_ATTR}="${type}">${anchor}</li>`;
}

function insertModuleNavLinks(html, items, pages) {
  const src = String(html || '');
  if (!src.trim() || !Array.isArray(items) || !items.length) return src;
  const chosen = choosePrimaryNav(src);
  if (!chosen) return src;
  const scopeEl = chosen.scope || chosen.container;
  const scopeLinks = pageAnchorsIn(src, scopeEl);
  // Include labels from all anchors in the primary nav (even non-page-like) for dedupe.
  const scopeLabels = new Set();
  if (scopeEl && scopeEl.openEnd != null && scopeEl.closeStart != null) {
    const inner = src.slice(scopeEl.openEnd, scopeEl.closeStart);
    for (const a of findAllElements(inner, 'a')) {
      const label = anchorTextLabel(inner.slice(a.openEnd, a.closeStart));
      if (label) scopeLabels.add(label);
    }
  }
  const pageList = Array.isArray(pages) ? pages : [];
  const pending = items.filter((it) => {
    const label = String(it.label || '')
      .trim()
      .toLowerCase();
    if (scopeLinks.some((a) => hrefTargetsPage(a.href, it.slug))) return false;
    if (label && scopeLabels.has(label)) return false;
    // Real page in pages[] — syncFreeformNavOrder / rebuild owns visibility & order.
    const page = pageList.find((p) => routeKey(p && p.slug) === routeKey(it.slug));
    if (page) return false;
    return true;
  });
  if (!pending.length) return src;
  const rowLinks = pageAnchorsIn(src, chosen.container);
  const top = topLevelAnchors(src, chosen.container);
  const anchor = templateAnchor(top.length ? top : rowLinks);
  if (!anchor) return src;
  const sampleHrefs = (top.length ? top : rowLinks).map((a) => a.href);
  const className = cleanClass(attrValue(anchor.attrs, 'class'));
  let useLi = !!chosen.useLi;
  let liClass = '';
  let insertAt = anchor.end;
  let gapAt = anchor.start;
  if (useLi) {
    const li = liWrapping(src, chosen.container, anchor);
    if (li) {
      liClass = cleanClass(attrValue(li.attrs, 'class'));
      insertAt = li.end;
      gapAt = li.start;
    } else {
      useLi = false;
    }
  }
  const sep = gapBefore(src, gapAt) || ' ';
  const chunk = pending
    .map(
      (it) =>
        sep +
        navItemHtml(it, {
          href: moduleHref(it.slug, sampleHrefs),
          className,
          liClass,
          useLi,
        })
    )
    .join('');
  return src.slice(0, insertAt) + chunk + src.slice(insertAt);
}

function moduleNavItems(embeds) {
  const items = [];
  const seen = new Set();
  for (const emb of embeds) {
    const meta = MODULE_META[emb.module_type] || {};
    if (meta.noNav || meta.sitewide || emb.module_type === 'chatbot') continue;
    const slug = normalizeSlug(emb.target_page_slug || meta.defaultSlug || 'home');
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    const label =
      String(emb.title || meta.label || meta.defaultTitle || emb.module_type).trim() || meta.label || 'Page';
    items.push({ type: emb.module_type, slug, label });
  }
  return items;
}

/** True when a page is only a module title/embed, so detaching that module can hide it. */
function pageIsModuleShell(page) {
  const html = String((page && page.html) || '');
  if (!html.trim()) return true;
  const stripped = stripManagedModuleEmbedsFromHtml(html);
  const main = (stripped.match(/<main\b[^>]*>[\s\S]*?<\/main>/i) || [''])[0];
  const text = main
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return true;
  const title = String((page && page.title) || '').trim();
  if (title && text.toLowerCase() === title.toLowerCase()) return true;
  // Default module page chrome still counts as a shell (title + placeholder copy).
  if (title && /add your content here|write this section|use \+ to add/i.test(text)) {
    const withoutPlaceholder = text
      .replace(/add your content here\.?/gi, ' ')
      .replace(/write this section,? or use \+ to add another\.?/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return withoutPlaceholder.toLowerCase() === title.toLowerCase();
  }
  return false;
}

/**
 * True when a sections-based page carries real authored copy outside its
 * chrome (nav/footer) sections. pageIsModuleShell reads page.html only, so
 * it calls every sections page a shell; a platform-created module shell's
 * body is just the page title plus the default placeholder copy.
 */
function pageHasAuthoredContent(page) {
  if (!page || !Array.isArray(page.sections)) return false;
  const title = String(page.title || '')
    .trim()
    .toLowerCase();
  let text = page.sections
    .filter((sec) => sec && sec.type !== 'nav' && sec.type !== 'footer')
    .map((sec) => {
      const c = (sec && sec.content) || {};
      return [c.html, c.body, c.text, c.headline, c.title].filter((v) => typeof v === 'string').join(' ');
    })
    .join(' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/add your content here\.?/gi, ' ')
    .replace(/write this section,? or use \+ to add another\.?/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  // Platform-injected module intro copy is boilerplate, not authored content.
  for (const intro of Object.values(MODULE_PAGE_INTRO)) {
    text = text.split(String(intro).toLowerCase()).join(' ');
  }
  text = text.replace(/\s+/g, ' ').trim();
  if (!text) return false;
  return text !== title;
}

/**
 * The module context a nav/footer rebuild needs: which module links
 * are active (navItems) and which module-shell pages stay out of the
 * footer (footerExcludeSlugs). Applies the reveal/hide page-field
 * mutations exactly as syncSiteModuleEmbeds always has.
 * Batch 149: extracted so domain.sitesSave can run its pre-save nav
 * sync with the SAME context. Without it that pass rebuilt the chrome
 * without the managed module markers, the post-save sync rebuilt them
 * back, and saveSite's per-page updatedAt stamp saw a "change" on
 * every save — stored pages never reached a fixed point.
 */
function moduleNavContext(db, leadId, pages, { embeds: embedsArg, revealSlugs } = {}) {
  const embeds = Array.isArray(embedsArg) ? embedsArg : listEmbeds(db, leadId).filter(moduleEmbedActive);
  const reveal = new Set(
    (Array.isArray(revealSlugs) ? revealSlugs : []).map((s) => normalizeSlug(s)).filter(Boolean)
  );
  const navItems = moduleNavItems(embeds);
  const activeSlugs = new Set(navItems.map((it) => normalizeSlug(it.slug)));
  const moduleDefaultSlugs = new Set(
    Object.values(MODULE_META)
      // Drop empty defaultSlugs BEFORE normalizing: '' normalizes to 'index',
      // which would otherwise treat the home page as a module-default page.
      .map((m) => String(m.defaultSlug || '').trim())
      .filter(Boolean)
      .map((s) => normalizeSlug(s))
  );
  // Detached / disabled module pages stay in the site but leave the menu.
  // attachModule passes revealSlugs so re-attach restores menu presence without
  // undoing a client hide while the module is still active.
  const footerExcludeSlugs = [];
  const navRevealed = [];
  for (const page of pages) {
    const slug = normalizeSlug(page && page.slug);
    if (!moduleDefaultSlugs.has(slug)) continue;
    if (reveal.has(slug)) {
      delete page.navVisible;
      delete page.nav_visible;
      delete page.hiddenInNav;
      delete page.hidden_in_nav;
      navRevealed.push(slug);
    } else if (!activeSlugs.has(slug) && pageIsModuleShell(page)) {
      page.navVisible = false;
      // Hidden module shells leave the footer too — buildFooterLinks otherwise
      // lists every page, including navVisible:false ones like FAQ (by design).
      // Only true shells are excluded: pageIsModuleShell cannot judge
      // sections-based pages (it reads page.html only), so a sections page
      // carrying real authored copy — e.g. a hand-written FAQ page at the faq
      // slug — keeps its footer place.
      if (!pageHasAuthoredContent(page)) footerExcludeSlugs.push(slug);
    }
  }
  return { navItems, footerExcludeSlugs, navRevealed };
}

function syncSiteModuleEmbeds(db, leadId, { appUrl, revealSlugs } = {}) {
  ensureTables(db);
  const site = db
    .prepare('SELECT id, pages FROM websites WHERE lead_id = ? ORDER BY id DESC LIMIT 1')
    .get(Number(leadId));
  if (!site) return { synced: false, reason: 'no_site' };

  let pages;
  try {
    pages = JSON.parse(site.pages || '[]');
  } catch {
    return { synced: false, reason: 'bad_pages' };
  }
  if (!Array.isArray(pages) || !pages.length) return { synced: false, reason: 'empty_pages' };

  const base = appUrl || appBaseUrl();
  // embed_enabled / toSite off → not active, so neither the page embed nor the nav link is kept.
  const embeds = listEmbeds(db, leadId).filter(moduleEmbedActive);
  const membersActive = embeds.some((e) => e.module_type === 'members');
  const activeTokens = new Set(embeds.map((e) => String(e.public_token || '').trim()).filter(Boolean));
  const reveal = new Set((Array.isArray(revealSlugs) ? revealSlugs : []).map((s) => normalizeSlug(s)).filter(Boolean));

  // Pass 1: strip only inactive embeds; leave placed widgets where they are.
  for (const page of pages) {
    if (pageUsesSections(page)) {
      page.sections = page.sections
        .filter((sec) => {
          // Batch 82: the member-nav script carrier lives only while a
          // members embed is active on the site.
          if (sec && sec.content && sec.content.bitpype_member_nav_managed) return membersActive;
          if (!(sec && sec.content && sec.content.bitpype_module_managed)) return true;
          // Keep managed mount sections that still hold an active token.
          const html = typeof sec.content.html === 'string' ? sec.content.html : '';
          return [...activeTokens].some((t) => htmlHasModuleToken(html, t));
        })
        .map((sec) => {
          if (!sec || !sec.content || typeof sec.content.html !== 'string') return sec;
          const cleaned = stripInactiveModuleEmbedsFromHtml(sec.content.html, activeTokens);
          if (cleaned === sec.content.html) return sec;
          return Object.assign({}, sec, {
            content: Object.assign({}, sec.content, { html: cleaned }),
          });
        });
      if (typeof page.html === 'string') delete page.html;
    } else if (typeof page.html === 'string' && page.html.trim()) {
      page.html = stripManagedNavLinks(stripInactiveModuleEmbedsFromHtml(page.html, activeTokens));
    }
  }

  // Pass 2: inject only when an active embed is missing from every page.
  // Author-mode: if a page already serves that module purpose (cell/section/nav), skip.
  // Sitewide overlays (chatbot) are handled in a dedicated pass — skip here.
  const byPage = new Map();
  const authorSkipped = [];
  for (const emb of embeds) {
    const metaEarly = MODULE_META[emb.module_type] || {};
    if (metaEarly.sitewide || emb.module_type === 'chatbot') continue;

    const token = String(emb.public_token || '').trim();
    if (token && pagesHaveModuleToken(pages, token)) continue;

    const meta = metaEarly;
    const slug = normalizeSlug(emb.target_page_slug || meta.defaultSlug || 'home');
    const purpose = pageServesModulePurpose(pages, emb.module_type, token, slug);
    if (purpose.served) {
      authorSkipped.push({
        moduleType: emb.module_type,
        reason: purpose.reason,
        wouldInject: describeWouldInject(emb, base),
      });
      continue;
    }
    const title = emb.title || meta.defaultTitle || slug;
    let idx = findPageIndex(pages, slug);
    if (idx < 0) {
      // Prefer modular chrome clone when the site is already sections-based.
      let structure;
      try {
        structure = require('../src/siteStructure');
      } catch {
        structure = null;
      }
      const siteIsModular = pages.some((p) => pageUsesSections(p));
      const allModular = siteIsModular && pages.every((p) => pageUsesSections(p));
      if (siteIsModular && pushFreestyleModulePage(pages, { slug, title })) {
        idx = pages.length - 1;
      } else if (allModular && structure && typeof structure.createClientPage === 'function') {
        // Portal-style /slug pages only when every page is already sections-based.
        // Mixed freeform sites keep bare module slugs (blog, not /blog).
        const created = structure.createClientPage(pages, {
          title,
          slug,
          shellHtml: shellHtmlFromPages(pages, slug),
          fillShellMain,
          defaultInner: defaultClientPageInner,
        });
        pages = created.pages;
        idx = Number.isInteger(created.pageIndex) ? created.pageIndex : findPageIndex(pages, slug);
        if (idx >= 0 && pages[idx] && routeKey(pages[idx].slug) === routeKey(slug)) {
          pages[idx].slug = slug;
        }
      } else {
        const shell = shellHtmlFromPages(pages, slug);
        pages.push({
          slug,
          title,
          html: fillShellMain(shell, defaultClientPageInner(title)),
        });
        idx = pages.length - 1;
      }
    } else if (
      !pageUsesSections(pages[idx]) &&
      typeof pages[idx].html === 'string' &&
      isBareModulePage(pages[idx].html)
    ) {
      const shell = shellHtmlFromPages(pages, slug);
      if (shell) {
        pages[idx].html = fillShellMain(shell, defaultClientPageInner(title));
      }
    }
    if (idx < 0) continue;
    if (!byPage.has(idx)) byPage.set(idx, []);
    byPage.get(idx).push(emb);
  }

  for (const [idx, pageEmbeds] of byPage) {
    const page = pages[idx];
    const missing = pageEmbeds.filter((e) => {
      const token = String(e.public_token || '').trim();
      return !token || !pagesHaveModuleToken(pages, token);
    });
    if (!missing.length) continue;
    const blocks = missing.map((e) => embedBlockHtml(e, base)).join('\n');
    const usesSections = pageUsesSections(page);
    const hasHtml = !usesSections && typeof page.html === 'string' && page.html.trim();

    // Single write target — mirrors renderPage (sections win when non-empty).
    if (usesSections) {
      const bodySec = findFreestyleBodySection(page);
      if (bodySec) {
        let html = String(bodySec.content.html || '');
        html = ensureClientPageChrome(html);
        html = upgradeModulePageIntro(html, missing);
        html = injectHtmlEmbed(html, blocks);
        bodySec.content = Object.assign({}, bodySec.content, {
          html: ensureModuleEmbedScript(html, base),
        });
        delete bodySec.content.bitpype_module_managed;
      } else {
        const embedSec = {
          type: 'html',
          content: {
            html: `${blocks}\n${moduleScriptTag(base)}`,
            bitpype_module_managed: 1,
          },
        };
        const footerAt = page.sections.findIndex((s) => s && s.type === 'footer');
        if (footerAt >= 0) page.sections.splice(footerAt, 0, embedSec);
        else page.sections.push(embedSec);
      }
      if (typeof page.html === 'string') delete page.html;
    } else if (hasHtml) {
      page.html = ensureModuleEmbedScript(injectHtmlEmbed(page.html, blocks), base);
    } else {
      page.sections = [
        {
          type: 'html',
          content: {
            html: `${blocks}\n${moduleScriptTag(base)}`,
            bitpype_module_managed: 1,
          },
        },
      ];
    }
  }

  // Ensure script tags on pages that already host active embeds.
  for (const page of pages) {
    if (pageUsesSections(page)) {
      for (const sec of page.sections || []) {
        if (!sec || !sec.content || typeof sec.content.html !== 'string') continue;
        if (![...activeTokens].some((t) => htmlHasModuleToken(sec.content.html, t))) continue;
        sec.content.html = ensureModuleEmbedScript(sec.content.html, base);
      }
    } else if (typeof page.html === 'string' && page.html.trim()) {
      if ([...activeTokens].some((t) => htmlHasModuleToken(page.html, t))) {
        page.html = ensureModuleEmbedScript(page.html, base);
      }
    }
  }

  // Batch 82: while a members embed is active, guarantee the module loader
  // on EVERY page — the member nav logout (module-embed.js) must be able to
  // run from any page's top nav, not just pages hosting a module mount.
  // Same sitewide treatment the chatbot pass gives its loader below. With
  // no stored member session the script adds nothing to the nav, and its
  // stylesheet is class-scoped (.bp-mod-*), so plain pages are untouched
  // visually. Sections pages carry the loader in their nav section when it
  // has authored chrome; otherwise a managed carrier section rides before
  // the footer (dropped by Pass 1 once members is no longer active).
  if (membersActive) {
    // Section-carried tags must use the render-approved loader form
    // (managedScripts.loaderTag: exact appBase src, no version query) —
    // sanitizeHtml strips every other script from section html at render,
    // including moduleScriptTag's ?v= form, which only survives inside
    // site_module mount sections. Pages already carrying a module mount
    // (or a loader) are covered: the mount's own script runs the nav wiring.
    // Approved form = managedScripts.loaderTag (the platform's canonical
    // loader: appBase src, no version query) — exactly what
    // managedScripts.approvedScript accepts at render, on the app origin
    // that also serves exported sites. Fall back to a base-built approved
    // tag, then to the versioned mount tag, if the resolver is unavailable.
    let sitewideTag = '';
    try {
      sitewideTag = require('../src/managedScripts').loaderTag('module-embed.js');
    } catch {
      sitewideTag = '';
    }
    if (!sitewideTag && base) {
      sitewideTag = `<script src="${escapeAttr(String(base).replace(/\/$/, ''))}/js/module-embed.js" defer ${SCRIPT_ATTR}="1"></script>`;
    }
    if (!sitewideTag) sitewideTag = moduleScriptTag(base);
    const ensureSitewideScript = (html) =>
      // Batch 149: canonical managed-script ensure (fixed point).
      require('../src/managedScripts').ensureManagedScript(html, 'module-embed.js', sitewideTag);
    for (const page of pages) {
      if (pageUsesSections(page)) {
        let placed = false;
        for (const sec of page.sections || []) {
          if (!sec || !sec.content || typeof sec.content.html !== 'string') continue;
          if (/\/js\/module-embed\.js/i.test(sec.content.html) || /bitpype-module-embed/i.test(sec.content.html)) {
            placed = true;
            break;
          }
        }
        if (placed) continue;
        const navSec = (page.sections || []).find(
          (s) => s && s.type === 'nav' && s.content && typeof s.content.html === 'string' && s.content.html.trim()
        );
        if (navSec) {
          navSec.content = Object.assign({}, navSec.content, {
            html: ensureSitewideScript(navSec.content.html),
          });
        } else {
          const scriptSec = {
            type: 'html',
            content: { html: sitewideTag, bitpype_member_nav_managed: 1 },
          };
          const footerAt = page.sections.findIndex((s) => s && s.type === 'footer');
          if (footerAt >= 0) page.sections.splice(footerAt, 0, scriptSec);
          else page.sections.push(scriptSec);
        }
      } else if (typeof page.html === 'string' && page.html.trim()) {
        page.html = ensureModuleEmbedScript(page.html, base);
      }
    }
  }

  // Section-type nav is rebuilt from the pages array at render time (one link per
  // page). Inserting another <a> there would duplicate it. Freeform HTML bakes the
  // menu into each page — module pages participate via pages[] + syncFreeformNavOrder.
  const { navItems, footerExcludeSlugs, navRevealed } = moduleNavContext(db, leadId, pages, {
    embeds,
    revealSlugs,
  });

  let navInserted = 0;
  for (const page of pages) {
    if (typeof page.html !== 'string' || !page.html.trim()) continue;
    const next = insertModuleNavLinks(page.html, navItems, pages);
    if (next !== page.html) navInserted += 1;
    page.html = next;
  }

  // Normalization telemetry: navInserted above only counts insertModuleNavLinks
  // edits to freeform page.html, so on section-based sites it read 0 while
  // syncFreeformNavOrder rewrote every nav. navSync reports what the
  // normalization pass itself inserted / removed / deduped (nav + footer).
  const navReport = { inserted: new Set(), removed: new Set(), deduped: 0, touchedPages: new Set() };
  let navSync = null;
  try {
    pages = require('../src/siteStructure').syncFreeformNavOrder(pages, {
      activeModules: navItems,
      footerExcludeSlugs,
      report: navReport,
    });
    navSync = {
      pagesChanged: navReport.touchedPages.size,
      inserted: [...navReport.inserted].sort(),
      removed: [...navReport.removed].sort(),
      deduped: navReport.deduped,
    };
  } catch (e) {
    console.warn('[siteModules] syncFreeformNavOrder after module sync:', e && e.message);
  }

  // Sitewide floating chatbot on every page (no nav link / no module page).
  let chatbotSync = null;
  try {
    chatbotSync = require('./chatbot').syncChatbotSitewide(db, leadId, pages, { appUrl: base });
  } catch (e) {
    console.warn('[siteModules] chatbot sitewide sync:', e && e.message);
  }

  db.prepare("UPDATE websites SET pages = ?, updated_at = datetime('now') WHERE id = ?").run(
    JSON.stringify(pages),
    site.id
  );

  return {
    synced: true,
    siteId: site.id,
    embeds: embeds.length,
    pages: byPage.size,
    navInserted,
    navSync,
    navHidden: footerExcludeSlugs,
    navRevealed,
    authorSkipped,
    authorMode: true,
    chatbot: chatbotSync,
  };
}

/**
 * After generate/deliver: ensure module pages exist only when embeds already published.
 * Does not auto-create content — attaches nothing new unless already configured.
 */
function syncPublishedModules(db, leadId, opts = {}) {
  ensureTables(db);
  return syncSiteModuleEmbeds(db, leadId, opts);
}

/* ── Batch 124: shared-taxonomy wiring for item CRUD ──
 * An item row of a consuming module carries its category assignments
 * as the virtual field category_ids (stored as
 * module_category_assignments rows — see server/categories.js). The
 * portal editors, the MCP module tools and the design agent all read
 * and write it through the same paths: list/get decorate it, create/
 * update reconcile it when the key is present (absent = untouched),
 * delete clears it. Every helper is dormant-safe — a failure in the
 * categories layer reads as "no categories" and never breaks an
 * item read. */
function decorateItemCategories(db, leadId, type, row) {
  if (!row) return row;
  try {
    row.category_ids = require('./categories').listItemCategoryIds(db, leadId, type, row.id);
  } catch {
    row.category_ids = [];
  }
  return row;
}

function decorateItemsCategories(db, leadId, type, rows) {
  if (!Array.isArray(rows) || !rows.length) return rows;
  try {
    return require('./categories').decorateWithCategories(db, leadId, type, rows);
  } catch {
    for (const row of rows) row.category_ids = [];
    return rows;
  }
}

/** Pre-flight for a create/update carrying category_ids: every id
 *  must be a category of THIS lead in the item's own scope — checked
 *  BEFORE the write so a bad id fails the whole write. */
function assertItemCategories(db, leadId, type, data) {
  if (!data || data.category_ids === undefined) return false;
  require('./categories').assertCategoryIds(db, leadId, type, data.category_ids);
  return true;
}

function applyItemCategories(db, leadId, type, itemId, data) {
  require('./categories').setItemCategories(db, leadId, type, itemId, data.category_ids);
}

function clearItemCategories(db, leadId, type, itemId) {
  try {
    require('./categories').clearAssignmentsForItem(db, leadId, type, itemId);
  } catch {
    /* assignments are additive — never block a delete */
  }
}

/* ── Blog ── */

function listBlogPosts(db, leadId, { includeDrafts = true, limit = null, offset = 0 } = {}) {
  ensureTables(db);
  let sql = 'SELECT * FROM blog_posts WHERE lead_id = ?';
  if (!includeDrafts) sql += " AND status = 'published'";
  sql += ' ORDER BY COALESCE(published_at, created_at) DESC, id DESC';
  const params = [Number(leadId)];
  // Batch 45: paging is opt-in — callers that need every post (exports,
  // static blog snapshots) pass no limit and keep the full list.
  if (limit != null) {
    sql += ' LIMIT ? OFFSET ?';
    params.push(Math.min(200, Math.max(1, Number(limit) || 50)), Math.max(0, Number(offset) || 0));
  }
  return decorateItemsCategories(db, leadId, 'blog', db.prepare(sql).all(...params));
}

function countBlogPosts(db, leadId, { includeDrafts = true } = {}) {
  ensureTables(db);
  let sql = 'SELECT COUNT(*) AS c FROM blog_posts WHERE lead_id = ?';
  if (!includeDrafts) sql += " AND status = 'published'";
  const row = db.prepare(sql).get(Number(leadId));
  return Number(row && row.c) || 0;
}

function getBlogPost(db, leadId, idOrSlug) {
  ensureTables(db);
  const lid = Number(leadId);
  let row;
  if (/^\d+$/.test(String(idOrSlug))) {
    row = db.prepare('SELECT * FROM blog_posts WHERE lead_id = ? AND id = ?').get(lid, Number(idOrSlug));
  } else {
    row = db.prepare('SELECT * FROM blog_posts WHERE lead_id = ? AND slug = ?').get(lid, slugify(idOrSlug));
  }
  return decorateItemCategories(db, leadId, 'blog', row || null);
}

function createBlogPost(db, leadId, data = {}) {
  ensureTables(db);
  const title = String(data.title || '').trim();
  if (!title) throw fail('VALIDATION', 'title is required');
  // Batch 124: validate category assignments before the insert.
  const wantsCats = assertItemCategories(db, leadId, 'blog', data);
  const slug = slugify(data.slug || title, 'post');
  const status = String(data.status || 'draft').toLowerCase() === 'published' ? 'published' : 'draft';
  const publishedAt = status === 'published' ? data.published_at || new Date().toISOString() : null;
  const bodyHtml = String(data.body_html || data.body || '');
  const excerpt = resolveBlogExcerpt(data, bodyHtml);
  try {
    const info = db
      .prepare(
        `
      INSERT INTO blog_posts
        (lead_id, title, slug, body_html, excerpt, cover_image, status, published_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        Number(leadId),
        title.slice(0, 200),
        slug,
        bodyHtml,
        excerpt,
        String(data.cover_image || data.coverImage || ''),
        status,
        publishedAt
      );
    if (wantsCats) applyItemCategories(db, leadId, 'blog', Number(info.lastInsertRowid), data);
    return getBlogPost(db, leadId, info.lastInsertRowid);
  } catch (e) {
    if (String(e.message || '').includes('UNIQUE')) {
      throw fail('CONFLICT', `Blog slug already exists: ${slug}`, 409);
    }
    throw e;
  }
}

function updateBlogPost(db, leadId, id, data = {}) {
  ensureTables(db);
  const row = getBlogPost(db, leadId, id);
  if (!row) throw fail('NOT_FOUND', 'Blog post not found', 404);
  // Batch 124: validate category assignments before the update lands.
  const wantsCats = assertItemCategories(db, leadId, 'blog', data);
  const title = data.title != null ? String(data.title).trim().slice(0, 200) : row.title;
  const slug = data.slug != null ? slugify(data.slug, row.slug) : row.slug;
  const body =
    data.body_html != null || data.body != null
      ? String(data.body_html != null ? data.body_html : data.body)
      : row.body_html;
  const cover =
    data.cover_image != null || data.coverImage != null
      ? String(data.cover_image != null ? data.cover_image : data.coverImage)
      : row.cover_image;
  // Explicit excerpt wins; body edits re-derive; otherwise keep stored or derive.
  const nextExcerpt =
    data.excerpt != null
      ? resolveBlogExcerpt(data, body)
      : data.body_html != null || data.body != null
        ? resolveBlogExcerpt({ excerpt: '' }, body)
        : String(row.excerpt || '').trim() || resolveBlogExcerpt({}, body);
  let status = row.status;
  let publishedAt = row.published_at;
  if (data.status != null) {
    status = String(data.status).toLowerCase() === 'published' ? 'published' : 'draft';
    if (status === 'published' && !publishedAt) publishedAt = new Date().toISOString();
    if (status === 'draft') publishedAt = null;
  }
  if (data.published_at != null) publishedAt = data.published_at || null;
  try {
    db.prepare(
      `
      UPDATE blog_posts SET title=?, slug=?, body_html=?, excerpt=?, cover_image=?, status=?,
        published_at=?, updated_at=datetime('now') WHERE id=? AND lead_id=?
    `
    ).run(title, slug, body, nextExcerpt, cover, status, publishedAt, row.id, Number(leadId));
  } catch (e) {
    if (String(e.message || '').includes('UNIQUE')) {
      throw fail('CONFLICT', `Blog slug already exists: ${slug}`, 409);
    }
    throw e;
  }
  if (wantsCats) applyItemCategories(db, leadId, 'blog', row.id, data);
  return getBlogPost(db, leadId, row.id);
}

function deleteBlogPost(db, leadId, id) {
  ensureTables(db);
  const row = getBlogPost(db, leadId, id);
  if (!row) throw fail('NOT_FOUND', 'Blog post not found', 404);
  db.prepare('DELETE FROM blog_posts WHERE id = ? AND lead_id = ?').run(row.id, Number(leadId));
  clearItemCategories(db, leadId, 'blog', row.id);
  return { deleted: true, id: row.id };
}

/* ── Ecommerce ── */

function listProducts(db, leadId, { includeDrafts = true } = {}) {
  ensureTables(db);
  let sql = 'SELECT * FROM ecommerce_products WHERE lead_id = ?';
  if (!includeDrafts) sql += " AND status = 'published'";
  sql += ' ORDER BY sort_order ASC, id DESC';
  return db.prepare(sql).all(Number(leadId));
}

function getProduct(db, leadId, idOrSlug) {
  ensureTables(db);
  const lid = Number(leadId);
  if (/^\d+$/.test(String(idOrSlug))) {
    return db.prepare('SELECT * FROM ecommerce_products WHERE lead_id = ? AND id = ?').get(lid, Number(idOrSlug));
  }
  return db.prepare('SELECT * FROM ecommerce_products WHERE lead_id = ? AND slug = ?').get(lid, slugify(idOrSlug));
}

function createProduct(db, leadId, data = {}) {
  ensureTables(db);
  const name = String(data.name || data.title || '').trim();
  if (!name) throw fail('VALIDATION', 'name is required');
  // Batch 127: pre-flight the variant payload BEFORE the insert so a
  // bad options/variants block fails the whole create with nothing
  // stored (setProductOptions re-validates as it reconciles).
  if (data.options !== undefined) {
    const groups = normalizeVariantOptionsInput(data.options);
    normalizeVariantOverrides(data.variants, groups);
  } else if (data.variants !== undefined) {
    throw fail('VALIDATION', 'variants need option groups — send options together with the variants', 400);
  }
  const slug = slugify(data.slug || name, 'product');
  const priceCents =
    data.price_cents != null ? Math.round(Number(data.price_cents) || 0) : Math.round((Number(data.price) || 0) * 100);
  const status = String(data.status || 'draft').toLowerCase() === 'published' ? 'published' : 'draft';
  try {
    const info = db
      .prepare(
        `
      INSERT INTO ecommerce_products
        (lead_id, name, slug, description, price_cents, currency, image_url, checkout_url, status, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        Number(leadId),
        name.slice(0, 200),
        slug,
        String(data.description || ''),
        priceCents,
        String(data.currency || 'USD')
          .slice(0, 8)
          .toUpperCase(),
        String(data.image_url || data.image || ''),
        String(data.checkout_url || data.checkoutUrl || data.buy_url || ''),
        status,
        Number(data.sort_order) || 0
      );
    const created = getProduct(db, leadId, info.lastInsertRowid);
    // Batch 127: variant structure rides the same write (pre-flighted
    // above, so this reconcile cannot fail on validation).
    reconcileProductVariantsFromInput(db, leadId, created, data);
    return withProductVariants(db, leadId, created);
  } catch (e) {
    if (String(e.message || '').includes('UNIQUE')) {
      throw fail('CONFLICT', `Product slug already exists: ${slug}`, 409);
    }
    throw e;
  }
}

function updateProduct(db, leadId, id, data = {}) {
  ensureTables(db);
  const row = getProduct(db, leadId, id);
  if (!row) throw fail('NOT_FOUND', 'Product not found', 404);
  // Batch 127: pre-flight the variant payload before the field update
  // (a variants-only write validates against the existing axes).
  if (data.options !== undefined) {
    const groups = normalizeVariantOptionsInput(data.options);
    normalizeVariantOverrides(data.variants, groups);
  } else if (data.variants !== undefined) {
    const existing = listProductOptions(db, leadId, row.id);
    if (!existing.length)
      throw fail('VALIDATION', 'variants need option groups — send options together with the variants', 400);
    normalizeVariantOverrides(
      data.variants,
      existing.map((g) => ({ name: g.name, values: g.values.map((v) => v.value) }))
    );
  }
  const name =
    data.name != null || data.title != null
      ? String(data.name != null ? data.name : data.title)
          .trim()
          .slice(0, 200)
      : row.name;
  const slug = data.slug != null ? slugify(data.slug, row.slug) : row.slug;
  const description = data.description != null ? String(data.description) : row.description;
  let priceCents = row.price_cents;
  if (data.price_cents != null) priceCents = Math.round(Number(data.price_cents) || 0);
  else if (data.price != null) priceCents = Math.round((Number(data.price) || 0) * 100);
  const currency = data.currency != null ? String(data.currency).slice(0, 8).toUpperCase() : row.currency;
  const image =
    data.image_url != null || data.image != null
      ? String(data.image_url != null ? data.image_url : data.image)
      : row.image_url;
  const checkout =
    data.checkout_url != null || data.checkoutUrl != null || data.buy_url != null
      ? String(
          data.checkout_url != null ? data.checkout_url : data.checkoutUrl != null ? data.checkoutUrl : data.buy_url
        )
      : row.checkout_url;
  const status =
    data.status != null ? (String(data.status).toLowerCase() === 'published' ? 'published' : 'draft') : row.status;
  const sortOrder = data.sort_order != null ? Number(data.sort_order) || 0 : row.sort_order;
  try {
    db.prepare(
      `
      UPDATE ecommerce_products SET name=?, slug=?, description=?, price_cents=?, currency=?,
        image_url=?, checkout_url=?, status=?, sort_order=?, updated_at=datetime('now')
      WHERE id=? AND lead_id=?
    `
    ).run(name, slug, description, priceCents, currency, image, checkout, status, sortOrder, row.id, Number(leadId));
  } catch (e) {
    if (String(e.message || '').includes('UNIQUE')) {
      throw fail('CONFLICT', `Product slug already exists: ${slug}`, 409);
    }
    throw e;
  }
  // Batch 127: reconcile the variant structure (key present = intent;
  // both keys absent = the variants stay exactly as they were).
  const updated = getProduct(db, leadId, row.id);
  reconcileProductVariantsFromInput(db, leadId, updated, data);
  return withProductVariants(db, leadId, updated);
}

function deleteProduct(db, leadId, id) {
  ensureTables(db);
  const row = getProduct(db, leadId, id);
  if (!row) throw fail('NOT_FOUND', 'Product not found', 404);
  // Batch 127: the variant structure belongs to the product — it goes
  // with it. (Historical orders keep their variant label snapshot.)
  clearProductVariants(db, leadId, row.id);
  db.prepare('DELETE FROM ecommerce_products WHERE id = ? AND lead_id = ?').run(row.id, Number(leadId));
  return { deleted: true, id: row.id };
}

/* ── Shop orders + Stripe checkout ── */

// Batch 128: the single-product insertShopOrder was folded into
// insertShopOrderWithLines — every Stripe order now records its
// line items, a one-line cart included.

function updateShopOrder(db, orderId, patch) {
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(patch || {})) {
    if (!['status', 'stripe_session_id', 'stripe_payment_intent', 'customer_email'].includes(k)) continue;
    sets.push(`${k} = ?`);
    vals.push(v);
  }
  if (!sets.length) return;
  sets.push("updated_at = datetime('now')");
  vals.push(Number(orderId));
  db.prepare(`UPDATE ecommerce_orders SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

/* ── Batch 128: order line items + cart lines ── */

/** The recorded lines of one order (oldest line first). */
function listShopOrderItems(db, orderId) {
  ensureTables(db);
  return db
    .prepare('SELECT * FROM ecommerce_order_items WHERE order_id = ? ORDER BY id ASC')
    .all(Number(orderId));
}

/** An order row with its recorded line items attached as `items`. */
function shopOrderWithItems(db, order) {
  if (!order) return order;
  // Batch 136: surface the booking discount stamp (null on every
  // non-discount order — cart/membership orders never carry one).
  const discount = publicDiscountStamp({
    gross_cents: order.gross_amount_cents != null ? order.gross_amount_cents : order.amount_cents,
    discount_amount_cents: order.discount_amount_cents,
    net_cents: order.amount_cents,
    currency: order.currency,
    discount_kind: order.discount_kind,
    discount_value: order.discount_value,
    discount_label: order.discount_label,
    discount_display: '',
  });
  return { ...order, items: listShopOrderItems(db, order.id), discount };
}

/** Orders for the portal / agent reads — each with its line items. */
function listShopOrdersWithItems(db, leadId, { limit = 50 } = {}) {
  return listShopOrders(db, leadId, { limit }).map((o) => shopOrderWithItems(db, o));
}

/**
 * Batch 128 + 127 — resolve a purchasable line's variant against
 * Batch 127's variant tables. The SAME rules the single-product
 * checkout path has always enforced, shared by both paths so a
 * variant means the same thing in a cart as in a single buy:
 *   - a product WITH variants is bought as a CHOSEN variant — no
 *     variantId is refused, never silently priced as the base
 *     product;
 *   - a variantId for a variant-less product is a client error;
 *   - the variant must be one of THIS product's rows (another
 *     product's or another lead's variant never resolves) and must
 *     be available.
 * The returned shape is the line's pricing truth: id + display
 * label + the variant row's price (unit_price_cents is what
 * lineForProduct reads). Prices always come from the variant row
 * server-side, never from the caller.
 */
function resolveShopVariant(db, leadId, product, variantId) {
  const variants = listProductVariants(db, leadId, product.id);
  if (variantId == null || variantId === '') {
    if (variants.length) {
      throw fail('VALIDATION', 'Choose the product options before checkout', 400);
    }
    return null;
  }
  if (!variants.length) {
    throw fail('VALIDATION', 'This product has no options to choose', 400);
  }
  const variant = variants.find((v) => v.id === Number(variantId)) || null;
  if (!variant) throw fail('NOT_FOUND', 'That product option is no longer available', 404);
  if (!variant.available) {
    throw fail('VALIDATION', 'That product option is currently unavailable', 400);
  }
  return {
    id: Number(variant.id),
    label: String(variant.label || ''),
    price_cents: Number(variant.price_cents) || 0,
    unit_price_cents: Number(variant.price_cents) || 0,
  };
}

/**
 * One validated cart line, priced ENTIRELY from server-side rows:
 * the product row (name, photo, price, currency) and — via
 * resolveShopVariant — the variant row. Nothing the
 * client sent about money or identity beyond ids + quantity is
 * ever read. The photo is the product's own image_url — the same
 * source the storefront renders — snapshotted onto the order line.
 */
function lineForProduct(product, quantity, variant) {
  const unit = variant && variant.unit_price_cents != null ? Number(variant.unit_price_cents) || 0 : Number(product.price_cents) || 0;
  const qty = Number(quantity) || 0;
  return {
    source_module: 'ecommerce',
    source_meta: '',
    product_id: Number(product.id),
    product_name: String(product.name || ''),
    variant_id: variant ? Number(variant.id) : null,
    variant_label: variant ? String(variant.label || '') : '',
    image_url: String(product.image_url || ''),
    unit_price_cents: unit,
    quantity: qty,
    line_total_cents: unit * qty,
    currency: String(product.currency || 'USD'),
    description: String(product.description || ''),
  };
}

/**
 * Batch 128 — a gallery photo as a sellable line (Ely: "I can SELL
 * photos"). The photo is priced on the gallery side (gallery_images
 * .price_cents, 0 = not for sale) and must sit in a PUBLISHED album
 * of THIS lead. Title = the photo's caption, falling back to its
 * album's title; the image IS the product photo. Sold one at a
 * time — a photo is a single deliverable, not a stock item.
 * Delivery: the paid order's success state offers the buyer the
 * photo's download (its stored image_url); the order line records
 * the photo id + album in source_meta so fulfillment is never
 * ambiguous. Photo Capture submissions are NOT sellable here —
 * they become sellable only after an owner approves one into a
 * gallery album (Batch 125's add-to-gallery), priced by the owner.
 */
function getSellableGalleryImage(db, leadId, imageId) {
  ensureTables(db);
  const row = db
    .prepare(
      `SELECT gi.*, ga.title AS album_title, ga.status AS album_status
       FROM gallery_images gi
       JOIN gallery_albums ga ON ga.id = gi.album_id
       WHERE gi.id = ? AND ga.lead_id = ?`
    )
    .get(Number(imageId), Number(leadId));
  if (!row || row.album_status !== 'published') return null;
  return row;
}

/** Batch 143 (full review): a gallery photo has no currency of its
 *  own — it sells through the lead's shop, so it takes the shop's
 *  currency, resolved the same way product lines get theirs: from
 *  the lead's own product rows. The previous hardcoded 'USD' both
 *  charged EUR shops' photos in dollars and made a same-shop mixed
 *  cart (EUR product + photo) refuse as "mixes currencies". A lead
 *  with no published products keeps the 'USD' default. */
function shopCurrencyForLead(db, leadId) {
  const row = db
    .prepare("SELECT currency FROM ecommerce_products WHERE lead_id = ? AND status = 'published' ORDER BY id ASC LIMIT 1")
    .get(Number(leadId));
  return String((row && row.currency) || 'USD');
}

function lineForGalleryImage(img, currency) {
  const unit = Number(img.price_cents) || 0;
  return {
    source_module: 'gallery',
    source_meta: JSON.stringify({ album_id: Number(img.album_id), album_title: String(img.album_title || '') }),
    product_id: Number(img.id),
    product_name: String(img.caption || '').trim() || String(img.album_title || '').trim() || 'Photo',
    variant_id: null,
    variant_label: '',
    image_url: String(img.image_url || ''),
    unit_price_cents: unit,
    quantity: 1,
    line_total_cents: unit,
    currency: String(currency || 'USD'),
    description: '',
  };
}

/**
 * Batch 128 — the GENERIC SELLABLE LINE. A cart line references
 * { source, itemId, quantity, variantId? } and its price, title and
 * photo are resolved SERVER-SIDE through the source module's own
 * data at session creation — the client contributes ids + quantity
 * only, for every source. Sources v1:
 *   - 'ecommerce' — shop products (published, priced on the product
 *     row; an external checkout_url product keeps its own path and
 *     is refused here), variants via resolveShopVariant.
 *   - 'gallery' — gallery photos the owner priced (published album,
 *     price_cents > 0), sold one at a time; delivery is the photo
 *     download on the paid success state.
 * Everything else is refused with a plain reason. Batch 129 note:
 * bookings are NOT a cart source by design — a cart line creates no
 * appointment — but they are not unsold either: the booking flow
 * itself sells through this same engine (lineForBookingService →
 * checkoutShopLines), and memberships sell through the same unified
 * payments config in subscription mode. One engine, several doors.
 * Mixed-source carts are allowed: every line here is charged
 * through the SAME lead-level shop Stripe configuration, so the
 * money lands in one place. Duplicate lines merge per
 * source/item/variant. Throws coded errors throughout.
 */
function buildSellableLines(db, leadId, rawItems) {
  ensureTables(db);
  const lid = Number(leadId);
  if (!Array.isArray(rawItems) || !rawItems.length) {
    throw fail('VALIDATION', 'Your cart is empty', 400);
  }
  if (rawItems.length > 50) {
    throw fail('VALIDATION', 'Too many cart lines (max 50)', 400);
  }
  const merged = new Map();
  for (const raw of rawItems) {
    const source = String((raw && (raw.source || raw.source_module)) || 'ecommerce')
      .trim()
      .toLowerCase();
    const itemId = Number(
      raw && raw.itemId != null ? raw.itemId : raw && raw.item_id != null ? raw.item_id : raw && raw.productId != null ? raw.productId : raw && raw.product_id
    );
    if (!Number.isInteger(itemId) || itemId <= 0) {
      throw fail('VALIDATION', 'Each cart line needs a valid item id', 400);
    }
    const qty = Number(raw && (raw.quantity != null ? raw.quantity : raw.qty));
    if (!Number.isInteger(qty) || qty < 1 || qty > 99) {
      throw fail('VALIDATION', 'Each cart line needs a quantity between 1 and 99', 400);
    }
    const variantId = raw && raw.variantId != null ? raw.variantId : raw && raw.variant_id != null ? raw.variant_id : null;
    const key = `${source}:${itemId}:${variantId == null ? '' : Number(variantId)}`;
    const prev = merged.get(key);
    if (prev) {
      prev.quantity += qty;
      if (prev.quantity > 99) throw fail('VALIDATION', 'Quantity per item is capped at 99', 400);
    } else {
      merged.set(key, { source, itemId, quantity: qty, variantId });
    }
  }
  const lines = [];
  let currency = null;
  for (const entry of merged.values()) {
    let line;
    if (entry.source === 'ecommerce') {
      // Lead-scoped read: a product id from another lead never resolves.
      const product = getProduct(db, lid, entry.itemId);
      if (!product || product.status !== 'published') {
        throw fail('NOT_FOUND', 'Product not found', 404);
      }
      if (product.checkout_url) {
        throw fail(
          'VALIDATION',
          `${product.name || 'One item'} is sold through an external link and cannot be checked out here`,
          400
        );
      }
      const variant = resolveShopVariant(db, lid, product, entry.variantId);
      line = lineForProduct(product, entry.quantity, variant);
    } else if (entry.source === 'gallery') {
      const img = getSellableGalleryImage(db, lid, entry.itemId);
      if (!img) throw fail('NOT_FOUND', 'Photo not found', 404);
      if (!(Number(img.price_cents) > 0)) {
        throw fail('VALIDATION', 'This photo is not for sale', 400);
      }
      if (entry.quantity !== 1) {
        throw fail('VALIDATION', 'Photos are sold one at a time', 400);
      }
      if (entry.variantId != null) {
        throw fail('VALIDATION', 'Photos do not have variants', 400);
      }
      line = lineForGalleryImage(img, shopCurrencyForLead(db, lid));
    } else {
      throw fail('VALIDATION', `Items from ${entry.source} cannot be checked out here`, 400);
    }
    if (currency == null) currency = line.currency;
    else if (line.currency !== currency) {
      throw fail('VALIDATION', 'Your cart mixes currencies and cannot be checked out together', 400);
    }
    lines.push(line);
  }
  return { lines, currency: currency || 'USD' };
}

/**
 * Write the order row + its line items. The order row keeps the
 * legacy summary fields every existing reader uses: a single-line
 * order carries that product's id + name; a multi-line order names
 * the first line "+ N more" with product_id NULL (the lines are the
 * truth). Amount is the sum of the server-priced lines.
 */
function insertShopOrderWithLines(
  db,
  leadId,
  lines,
  { keySource = '', currency = 'USD', discount = null } = {}
) {
  ensureTables(db);
  const ks =
    keySource === 'lead'
      ? 'lead'
      : keySource === 'workspace'
        ? 'workspace'
        : keySource === 'unified'
          ? 'unified'
          : '';
  const total = lines.reduce((sum, l) => sum + (Number(l.line_total_cents) || 0), 0);
  // Batch 136: a booking discount stamp rides ONLY on booking-surface
  // orders (the caller passes it; cart/membership never do). The
  // stamp's net must equal the charged total — a mismatch means the
  // line and the stamp disagree, and the order must not be written.
  let orderDiscount = null;
  if (discount) {
    if (Number(discount.net_cents) !== total) {
      throw fail('VALIDATION', 'Discount stamp does not match the checkout total', 400);
    }
    orderDiscount = {
      gross: Number(discount.gross_cents) || 0,
      amount: Number(discount.discount_amount_cents) || 0,
      kind: String(discount.discount_kind || ''),
      value: Number(discount.discount_value) || 0,
      label: String(discount.discount_label || ''),
    };
  }
  const first = lines[0] || {};
  // The order row's legacy product link stays meaningful for the
  // classic single-product shop order; mixed/multi orders read
  // their truth from the line items (product_id NULL here).
  const productId = lines.length === 1 && first.source_module === 'ecommerce' ? Number(first.product_id) : null;
  const productName =
    lines.length === 1
      ? String(first.product_name || '')
      : `${String(first.product_name || 'Item')} + ${lines.length - 1} more`;
  // Batch 127's order-level variant snapshot: a one-line order IS
  // that line, so its variant identity rides on the order row too
  // (the columns Batch 127 added); multi-line orders keep theirs on
  // the line items only.
  const variantId = lines.length === 1 && first.variant_id != null ? Number(first.variant_id) : null;
  const variantLabel = lines.length === 1 ? String(first.variant_label || '') : '';
  const info = db
    .prepare(
      `INSERT INTO ecommerce_orders (lead_id, product_id, product_name, amount_cents, currency, status, stripe_key_source, variant_id, variant_label,
        gross_amount_cents, discount_amount_cents, discount_kind, discount_value, discount_label)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      Number(leadId),
      productId,
      productName,
      total,
      String(currency || 'USD'),
      ks,
      variantId,
      variantLabel,
      orderDiscount ? orderDiscount.gross : null,
      orderDiscount ? orderDiscount.amount : 0,
      orderDiscount ? orderDiscount.kind : '',
      orderDiscount ? orderDiscount.value : 0,
      orderDiscount ? orderDiscount.label : ''
    );
  const order = db.prepare('SELECT * FROM ecommerce_orders WHERE id = ?').get(info.lastInsertRowid);
  const ins = db.prepare(
    `INSERT INTO ecommerce_order_items
       (order_id, lead_id, product_id, product_name, variant_id, variant_label, source_module, source_meta, image_url,
        unit_price_cents, quantity, line_total_cents, currency)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const l of lines) {
    ins.run(
      Number(order.id),
      Number(leadId),
      l.product_id != null ? Number(l.product_id) : null,
      String(l.product_name || ''),
      l.variant_id != null ? Number(l.variant_id) : null,
      String(l.variant_label || ''),
      String(l.source_module || 'ecommerce'),
      String(l.source_meta || ''),
      String(l.image_url || ''),
      Number(l.unit_price_cents) || 0,
      Number(l.quantity) || 0,
      Number(l.line_total_cents) || 0,
      String(l.currency || currency || 'USD')
    );
  }
  return order;
}

function getShopOrderBySession(db, sessionId) {
  ensureTables(db);
  return db.prepare('SELECT * FROM ecommerce_orders WHERE stripe_session_id = ?').get(String(sessionId || '')) || null;
}

/** The embed row behind a public token (null when unknown). */
function getEmbedRowByToken(db, token) {
  ensureTables(db);
  return db.prepare('SELECT * FROM site_module_embeds WHERE public_token = ?').get(String(token || '')) || null;
}

function listShopOrders(db, leadId, { limit = 50 } = {}) {
  ensureTables(db);
  const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
  return db.prepare('SELECT * FROM ecommerce_orders WHERE lead_id = ? ORDER BY id DESC LIMIT ?').all(Number(leadId), n);
}

/**
 * Apply a verified Stripe webhook event to the matching shop order.
 * Idempotent: orders are matched by checkout session id and terminal
 * states are never downgraded. Returns { matched, orderId?, status? }.
 */
/**
 * Batch 129 — settle a booking payment hold from its order's fate.
 * Called by applyShopStripeEvent on the paid / expired / failed
 * transitions ONLY (never on payment_intent.payment_failed — a card
 * retry inside the same session must not lose the slot). Every
 * branch is guarded on payment_state = 'hold', so webhook replays
 * and late events are no-ops once a hold has settled either way.
 * outcome 'paid': payment_state 'paid'; the appointment confirms
 * when the business auto-confirms (otherwise it stays 'pending' for
 * the owner, now truthfully paid). outcome 'released': the hold is
 * freed and the appointment cancelled.
 */
function applyBookingPaymentTransition(db, order, outcome) {
  const items = listShopOrderItems(db, order.id).filter((l) => l.source_module === 'bookings');
  for (const line of items) {
    let meta = {};
    try {
      meta = JSON.parse(line.source_meta || '{}');
    } catch {
      meta = {};
    }
    const apptId = Number(meta.appointment_id);
    if (!Number.isInteger(apptId) || apptId <= 0) continue;
    const appt = db
      .prepare('SELECT * FROM bookings WHERE id = ? AND lead_id = ?')
      .get(apptId, Number(order.lead_id));
    if (!appt || appt.payment_state !== 'hold') continue;
    if (outcome === 'paid') {
      const settings = getBookingSettings(db, order.lead_id);
      const nextStatus =
        appt.status === 'pending' && settings.auto_confirm ? 'confirmed' : appt.status;
      db.prepare(
        "UPDATE bookings SET payment_state = 'paid', payment_order_id = ?, status = ?, updated_at = datetime('now') WHERE id = ? AND lead_id = ?"
      ).run(Number(order.id), nextStatus, apptId, Number(order.lead_id));
    } else {
      db.prepare(
        "UPDATE bookings SET payment_state = 'released', status = 'cancelled', updated_at = datetime('now') WHERE id = ? AND lead_id = ?"
      ).run(apptId, Number(order.lead_id));
    }
  }
}

/**
 * Batch 145 (external review F07 backstop): a booking payment that
 * completes AFTER its hold was released must not sit silently paid.
 * The appointment is flagged paid_unfulfilled (it stays cancelled —
 * the slot may already belong to someone else), the order is flagged
 * to match, and an automatic refund is attempted through the lead's
 * payments config on a detached task (this dispatcher is
 * synchronous; the webhook route's owner notifications use the same
 * fire-and-forget discipline). If the refund lands, the order
 * settles to 'refunded'; if the attempt fails, the flags alone
 * persist for owner attention.
 */
function flagLatePaidBookingOrders(db, order) {
  const items = listShopOrderItems(db, order.id).filter((l) => l.source_module === 'bookings');
  let flagged = false;
  for (const line of items) {
    let meta = {};
    try {
      meta = JSON.parse(line.source_meta || '{}');
    } catch {
      meta = {};
    }
    const apptId = Number(meta.appointment_id);
    if (!Number.isInteger(apptId) || apptId <= 0) continue;
    const appt = db
      .prepare('SELECT * FROM bookings WHERE id = ? AND lead_id = ?')
      .get(apptId, Number(order.lead_id));
    if (!appt || appt.payment_state !== 'released') continue;
    db.prepare(
      "UPDATE bookings SET payment_state = 'paid_unfulfilled', updated_at = datetime('now') WHERE id = ? AND lead_id = ?"
    ).run(apptId, Number(order.lead_id));
    flagged = true;
  }
  if (flagged) {
    updateShopOrder(db, order.id, { status: 'paid_unfulfilled' });
    attemptLatePaidBookingRefund(db, order.id).catch((e) =>
      console.warn('[siteModules] late-paid booking refund attempt failed:', e && e.message)
    );
  }
  return flagged;
}

async function attemptLatePaidBookingRefund(db, orderId) {
  const resolved = require('./shopStripe').resolveForLead(db, dbOrderLeadId(db, orderId));
  const stripe = resolved && resolved.client;
  const fresh = db.prepare('SELECT * FROM ecommerce_orders WHERE id = ?').get(Number(orderId));
  const pi = String((fresh && fresh.stripe_payment_intent) || '');
  if (!stripe || !pi || !stripe.refunds || typeof stripe.refunds.create !== 'function') return;
  // Batch 154: the auto-refund is keyed by the ORDER — the detached
  // retry (or a webhook redelivery re-flagging the order) replays
  // the original refund instead of refunding the payment twice.
  await stripe.refunds.create(
    { payment_intent: pi },
    { idempotencyKey: stripeIdempotencyKey('refund-late-paid-booking', Number(orderId), pi) }
  );
  const cur = db.prepare('SELECT status FROM ecommerce_orders WHERE id = ?').get(Number(orderId));
  if (cur && cur.status === 'paid_unfulfilled') {
    updateShopOrder(db, Number(orderId), { status: 'refunded' });
  }
}

function dbOrderLeadId(db, orderId) {
  const row = db.prepare('SELECT lead_id FROM ecommerce_orders WHERE id = ?').get(Number(orderId));
  return row ? Number(row.lead_id) : 0;
}

/**
 * Batch 145 (external review F06): processed-event receipt wrapper.
 * The first delivery of an event id is applied by
 * applyShopStripeEventInner and its outcome recorded; a redelivery
 * of a recorded id is a strict no-op returning the recorded outcome.
 */
function applyShopStripeEvent(db, event) {
  ensureTables(db);
  const eventId = String((event && event.id) || '');
  if (eventId) {
    const receipt = db
      .prepare('SELECT order_id, status FROM shop_processed_stripe_events WHERE event_id = ?')
      .get(eventId);
    if (receipt) {
      return { matched: true, duplicate: true, orderId: receipt.order_id, status: receipt.status };
    }
  }
  const result = applyShopStripeEventInner(db, event);
  if (eventId && result && result.matched && result.orderId) {
    db.prepare(
      'INSERT OR IGNORE INTO shop_processed_stripe_events (event_id, type, order_id, status) VALUES (?, ?, ?, ?)'
    ).run(eventId, String((event && event.type) || ''), Number(result.orderId), String(result.status || ''));
  }
  return result;
}

function applyShopStripeEventInner(db, event) {
  ensureTables(db);
  const type = String((event && event.type) || '');
  const obj = (event && event.data && event.data.object) || {};
  // Batch 143 (full review): tenant refunds were dropped entirely —
  // a fully-refunded order kept reading 'paid' in the portal, and a
  // refunded gallery photo stayed delivered. A FULL refund now marks
  // the order 'refunded' (partial refunds leave the paid state; the
  // order total no longer matches what the customer kept, but access
  // decisions stay with the owner). Matched by payment intent, the
  // reference every paid order records.
  if (type === 'charge.refunded') {
    const pi = String(obj.payment_intent || '');
    if (!pi) return { matched: false, reason: 'no payment intent' };
    const refundedOrder = db
      .prepare('SELECT * FROM ecommerce_orders WHERE stripe_payment_intent = ? ORDER BY id DESC LIMIT 1')
      .get(pi);
    if (!refundedOrder) return { matched: false, reason: 'unknown payment intent' };
    const amount = Number(obj.amount) || 0;
    const refunded = Number(obj.amount_refunded) || 0;
    // Batch 145 (F07): a late-paid flagged order ('paid_unfulfilled')
    // whose automatic refund lands settles to 'refunded' through
    // this same event.
    if (amount > 0 && refunded >= amount && (refundedOrder.status === 'paid' || refundedOrder.status === 'paid_unfulfilled')) {
      updateShopOrder(db, refundedOrder.id, { status: 'refunded' });
      return { matched: true, orderId: refundedOrder.id, status: 'refunded' };
    }
    return { matched: true, orderId: refundedOrder.id, status: refundedOrder.status };
  }
  let order = null;
  if (type.startsWith('checkout.session.')) {
    order = getShopOrderBySession(db, String(obj.id || ''));
    if (!order) return { matched: false, reason: 'unknown session' };
  } else if (type.startsWith('payment_intent.')) {
    const oid = Number(obj.metadata && obj.metadata.bitpype_order_id);
    if (!Number.isInteger(oid) || oid <= 0) return { matched: false, reason: 'no order reference' };
    order = db.prepare('SELECT * FROM ecommerce_orders WHERE id = ?').get(oid) || null;
    if (!order) return { matched: false, reason: 'unknown order' };
  } else {
    return { matched: false, reason: 'unhandled event type' };
  }
  // Batch 145 (external review F06): terminal-state protection.
  // 'refunded' is terminal for EVERY later event (a replayed
  // completion used to resurrect the order to 'paid' and re-notify
  // the owner); 'paid_unfulfilled' (the F07 late-payment flag) is
  // terminal for everything except the refund that settles it
  // (handled above); 'expired'/'failed' are terminal for a later
  // completion — Stripe delivers unordered, so a dead session's
  // completion must not fulfil after the fact.
  if (order.status === 'refunded') return { matched: true, orderId: order.id, status: 'refunded' };
  if (order.status === 'paid_unfulfilled') {
    return { matched: true, orderId: order.id, status: 'paid_unfulfilled' };
  }
  if (order.status === 'paid') return { matched: true, orderId: order.id, status: 'paid' };
  if (
    (order.status === 'expired' || order.status === 'failed') &&
    (type === 'checkout.session.completed' || type === 'checkout.session.async_payment_succeeded')
  ) {
    return { matched: true, orderId: order.id, status: order.status };
  }
  if (type === 'checkout.session.completed' || type === 'checkout.session.async_payment_succeeded') {
    // Review fix (mirrors the membership flow's payment_status gate):
    // checkout.session.completed also fires for async payment methods
    // whose money has NOT landed — Stripe reports payment_status
    // 'unpaid' and settles later via async_payment_succeeded/failed.
    // Marking paid on the event type alone fulfilled unpaid orders.
    // An explicitly unpaid completion leaves the order pending; a
    // session with no payment_status (older payloads) or one reported
    // paid / no_payment_required completes exactly as before.
    if (type === 'checkout.session.completed' && String(obj.payment_status || '') === 'unpaid') {
      return { matched: true, orderId: order.id, status: order.status };
    }
    // Batch 143 (full review): the event was matched by session id
    // alone and never compared against the order — a session settling
    // a DIFFERENT total or currency (a cheaper session under a
    // rotated key, an async session settling short) fulfilled the
    // order at its full recorded value. The order was priced
    // server-side at creation; the settled money must equal it
    // exactly, in the order's own currency, before anything is
    // marked paid. A mismatch leaves the order pending (visible to
    // the owner) rather than fulfilled or silently dropped.
    if (obj.amount_total != null && Number(obj.amount_total) !== Number(order.amount_cents)) {
      return { matched: true, orderId: order.id, status: order.status, reason: 'amount mismatch' };
    }
    const eventCurrency = String(obj.currency || '').toUpperCase();
    if (eventCurrency && eventCurrency !== String(order.currency || '').toUpperCase()) {
      return { matched: true, orderId: order.id, status: order.status, reason: 'currency mismatch' };
    }
    updateShopOrder(db, order.id, {
      status: 'paid',
      stripe_payment_intent: String(obj.payment_intent || order.stripe_payment_intent || ''),
      customer_email: String(
        (obj.customer_details && obj.customer_details.email) || obj.customer_email || order.customer_email || ''
      ),
    });
    // Batch 129: a paid order may be a booking's payment — settle its hold.
    applyBookingPaymentTransition(db, order, 'paid');
    // Batch 145 (F07 backstop): if a booking on this order was no
    // longer in hold state (its hold lapsed and released before the
    // money landed), flag order + booking paid_unfulfilled and
    // attempt the automatic refund — never leave it silently paid.
    if (flagLatePaidBookingOrders(db, order)) {
      return { matched: true, orderId: order.id, status: 'paid_unfulfilled', unfulfilled: true };
    }
    return { matched: true, orderId: order.id, status: 'paid' };
  }
  if (type === 'checkout.session.expired' || type === 'checkout.session.async_payment_failed') {
    updateShopOrder(db, order.id, { status: type.endsWith('expired') ? 'expired' : 'failed' });
    // Batch 129: the checkout died — release any booking hold on it.
    applyBookingPaymentTransition(db, order, 'released');
    return { matched: true, orderId: order.id, status: type.endsWith('expired') ? 'expired' : 'failed' };
  }
  if (type === 'payment_intent.payment_failed') {
    updateShopOrder(db, order.id, { status: 'failed' });
    return { matched: true, orderId: order.id, status: 'failed' };
  }
  return { matched: true, orderId: order.id, status: order.status };
}

/**
 * Batch 129 — the ONE tenant-event dispatcher behind the ONE
 * payments webhook pipeline (server/routes/paymentsWebhook.js,
 * mounted at /api/v1/payments/webhook AND at both legacy URLs).
 * Membership events (a member checkout's metadata, or any
 * subscription/invoice lifecycle type) go to the membership apply;
 * everything else (checkout sessions, payment intents) goes to the
 * shop/order apply — which also settles booking holds, since a
 * booking payment IS a shop order. Disambiguating
 * checkout.session.completed by its stamped metadata is what lets
 * one pipeline serve every surface without per-module forks.
 */
function applyTenantStripeEvent(db, event) {
  const type = String((event && event.type) || '');
  const obj = (event && event.data && event.data.object) || {};
  const meta = obj.metadata || {};
  const isMembership =
    !!meta.bitpype_member_id ||
    type.startsWith('customer.subscription.') ||
    type.startsWith('invoice.');
  if (isMembership) {
    return { pipeline: 'membership', ...applyMembershipStripeEvent(db, event) };
  }
  return { pipeline: 'shop', ...applyShopStripeEvent(db, event) };
}

/**
 * Batch 128 — the ONE shop checkout core, shared by the legacy
 * single-product buy and the Checkout module's cart: priced lines
 * in (already validated + server-priced by buildShopLines /
 * lineForProduct), a pending order + line items + a Stripe Checkout
 * Session out. Stripe resolution happens BEFORE the order is
 * written so a shop with no keys anywhere fails cleanly; a failed
 * session create marks the order 'failed' (a clearly-marked
 * incomplete state, never a phantom sale). The session charges the
 * LEAD's own shop Stripe configuration via shopStripe.resolveForLead
 * — never the platform's subscription Stripe.
 */
async function checkoutShopLines(db, embedRow, lines, currency, returnUrl, opts = {}) {
  const shopStripe = require('./shopStripe');
  // Per-lead keys win; the workspace keys are the fallback (Batch 19).
  const resolved = shopStripe.resolveForLead(db, embedRow.lead_id); // throws SHOP_STRIPE_NOT_CONFIGURED
  const stripe = resolved.client;
  const base = String(returnUrl || '').split('#')[0];
  let parsed;
  try {
    parsed = new URL(base);
  } catch {
    parsed = null;
  }
  if (!parsed || !/^https?:$/.test(parsed.protocol)) {
    throw fail('VALIDATION', 'A valid return URL is required for checkout', 400);
  }
  const sep = base.includes('?') ? '&' : '?';
  const order = insertShopOrderWithLines(db, embedRow.lead_id, lines, {
    keySource: resolved.source,
    currency,
    // Batch 136: opts.bookingDiscount is set ONLY by the booking
    // surface (Batch 129 pay-at-booking integration point); every
    // other surface leaves it unset and is stamped with nothing.
    discount: opts && opts.bookingDiscount ? opts.bookingDiscount : null,
  });
  // Batch 145 (external review F07) — session expiry for booking
  // lines. Batch 143's pin only set expires_at when ≥31 minutes of
  // hold remained, but holds were exactly 30 minutes, so the
  // condition was false in 100% of real cases and sessions lived
  // Stripe's 24h default while holds died at 30 minutes. The hold
  // STAYS 30 minutes per Ely's ruling (2026-11-05), and a
  // 30-minute hold cannot be pinned exactly: Stripe sessions have
  // a MINIMUM lifetime of 30 minutes from creation, and the hold
  // is created before the session, so the hold expiry is always
  // already inside that minimum. Instead the session is capped at
  // the earliest Stripe-permissible value — the later of (the
  // earliest hold expiry on the order + 1 minute) and (now +
  // Stripe's 30-minute minimum + 1 minute of clock margin) —
  // which lands ≈1 minute after the hold expiry in the normal
  // flow and NEVER at the 24h default. Any payment that still
  // lands after the hold is released is covered by the refund
  // backstop in applyBookingPaymentTransition (paid_unfulfilled
  // flag + detached auto-refund; no "new order" email).
  let holdExpiresAt = null;
  for (const l of lines) {
    if (l.source_module !== 'bookings') continue;
    let meta = {};
    try {
      meta = JSON.parse(l.source_meta || '{}');
    } catch {
      meta = {};
    }
    const apptId = Number(meta.appointment_id);
    if (!Number.isInteger(apptId) || apptId <= 0) continue;
    const appt = db
      .prepare('SELECT payment_expires_at FROM bookings WHERE id = ? AND lead_id = ?')
      .get(apptId, Number(embedRow.lead_id));
    const t = appt && appt.payment_expires_at ? Date.parse(String(appt.payment_expires_at)) : NaN;
    if (Number.isFinite(t) && (holdExpiresAt == null || t < holdExpiresAt)) holdExpiresAt = t;
  }
  const expiresAtSec =
    holdExpiresAt != null
      ? Math.floor(
          Math.max(
            holdExpiresAt + SESSION_EXPIRY_MARGIN_MINUTES * 60 * 1000,
            Date.now() + (STRIPE_SESSION_MIN_MINUTES + SESSION_EXPIRY_MARGIN_MINUTES) * 60 * 1000
          ) / 1000
        )
      : null;
  let session;
  try {
    session = await stripe.checkout.sessions.create({
      mode: 'payment',
      ...(expiresAtSec ? { expires_at: expiresAtSec } : {}),
      line_items: lines.map((l) => ({
        quantity: Number(l.quantity) || 1,
        price_data: {
          currency: String(l.currency || currency || 'USD').toLowerCase(),
          unit_amount: Number(l.unit_price_cents) || 0,
          product_data: {
            name:
              String(l.product_name || 'Product') +
              (l.variant_label ? ` \u2014 ${String(l.variant_label)}` : ''),
            ...(lines.length === 1 && l.description
              ? { description: String(l.description).slice(0, 500) }
              : {}),
            ...(l.image_url && /^https?:\/\//.test(l.image_url) ? { images: [l.image_url] } : {}),
          },
        },
      })),
      client_reference_id: String(order.id),
      // Batch 129: every session through this core — shop Buy door,
      // cart, photo, pay-at-booking — is stamped with the shared
      // purpose + the payments-config layer that ran it, so one
      // metadata/behavior change here is observable on every
      // selling surface (the streamline invariant).
      metadata: {
        bitpype_order_id: String(order.id),
        bitpype_lead_id: String(embedRow.lead_id),
        bitpype_purpose: 'shop',
        bitpype_key_source: resolved.source,
        ...(opts && opts.bookingDiscount && Number(opts.bookingDiscount.discount_amount_cents) > 0
          ? {
              bitpype_discount_kind: String(opts.bookingDiscount.discount_kind || ''),
              bitpype_discount_value: String(Number(opts.bookingDiscount.discount_value) || 0),
              bitpype_discount_amount_cents: String(Number(opts.bookingDiscount.discount_amount_cents) || 0),
              bitpype_gross_amount_cents: String(Number(opts.bookingDiscount.gross_cents) || 0),
            }
          : {}),
        ...(lines.length === 1 && lines[0].source_module === 'ecommerce'
          ? {
              bitpype_product_id: String(lines[0].product_id),
              ...(lines[0].variant_id ? { bitpype_variant_id: String(lines[0].variant_id) } : {}),
            }
          : {}),
      },
      payment_intent_data: {
        metadata: {
          bitpype_order_id: String(order.id),
          bitpype_lead_id: String(embedRow.lead_id),
          bitpype_purpose: 'shop',
          bitpype_key_source: resolved.source,
        },
      },
      success_url: `${base}${sep}order=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}${sep}order=cancelled`,
    },
      // Batch 154: keyed by the ORDER row created before the
      // session — every selling surface funnels through this one
      // core, so a retried checkout for the same order replays the
      // original session instead of orphaning a duplicate.
      {
        idempotencyKey: stripeIdempotencyKey('checkout-shop', Number(order.id), Number(embedRow.lead_id)),
      }
    );
  } catch (e) {
    updateShopOrder(db, order.id, { status: 'failed' });
    const err = new Error(e && e.message ? `Stripe checkout failed: ${e.message}` : 'Stripe checkout failed');
    err.code = 'SHOP_CHECKOUT_FAILED';
    err.status = 502;
    throw err;
  }
  updateShopOrder(db, order.id, {
    stripe_session_id: String(session.id || ''),
    stripe_payment_intent: String(session.payment_intent || ''),
  });
  return { mode: 'stripe', url: session.url, orderId: order.id, sessionId: session.id };
}

/** The embed gates every public shop checkout shares. */
function assertShopEmbedForCheckout(db, token, opts) {
  ensureTables(db);
  const row = db.prepare('SELECT * FROM site_module_embeds WHERE public_token = ?').get(String(token || ''));
  // Review fix: a DETACHED shop (published=0 / embed_enabled=0) must not
  // take orders — the token row survives detach, so gate on the same
  // moduleEmbedActive predicate the sync and payload paths use.
  if (!row || row.module_type !== 'ecommerce' || !moduleEmbedActive(row)) {
    throw fail('NOT_FOUND', 'Shop module not found', 404);
  }
  assertSiteNotArchived(db, row.lead_id);
  assertSiteNotSuspended(db, row.lead_id);
  assertMemberAccessForEmbed(db, row, opts);
  return row;
}

/**
 * Create a Stripe Checkout Session for a shop product via the public
 * module token. Prices are always read from the product row server-side.
 * A product with a manual checkout_url keeps the legacy external-link
 * behavior and never touches Stripe. Batch 128: the Stripe path runs
 * through the shared cart core, so a single buy records exactly one
 * line item, same as a one-line cart. Batch 127: a variantId selects
 * the purchasable variant — resolved by the same resolveShopVariant
 * the cart uses, so both paths enforce identical variant rules.
 */
async function createShopCheckoutByToken(db, token, { productId, variantId, returnUrl } = {}, opts = {}) {
  const row = assertShopEmbedForCheckout(db, token, opts);
  const product = getProduct(db, row.lead_id, productId);
  if (!product || product.status !== 'published') {
    throw fail('NOT_FOUND', 'Product not found', 404);
  }
  if (product.checkout_url) {
    return { mode: 'external', url: product.checkout_url };
  }
  const variant = resolveShopVariant(db, row.lead_id, product, variantId);
  const line = lineForProduct(product, 1, variant);
  return checkoutShopLines(db, row, [line], line.currency, returnUrl);
}

/**
 * Batch 128 (Checkout module) — cart checkout via the CHECKOUT
 * module's own public token. The token resolves the lead; the cart
 * lines ({source, itemId, quantity, variantId?}) are re-priced from
 * the source modules' own rows server-side by buildSellableLines
 * and charged as ONE Stripe Checkout Session on the lead's own shop
 * Stripe configuration. The cart belongs to the lead's checkout,
 * not to any one source module — products and gallery photos mix
 * in a single purchase because every line resolves to the same
 * lead-level payment configuration.
 */
async function createCartCheckoutByToken(db, token, { items, returnUrl } = {}, opts = {}) {
  ensureTables(db);
  const row = getEmbedRowByToken(db, token);
  // Same detach discipline as the shop: the token row survives
  // detach, so gate on moduleEmbedActive.
  if (!row || row.module_type !== 'checkout' || !moduleEmbedActive(row)) {
    throw fail('NOT_FOUND', 'Checkout module not found', 404);
  }
  assertSiteNotArchived(db, row.lead_id);
  assertSiteNotSuspended(db, row.lead_id);
  assertMemberAccessForEmbed(db, row, opts);
  const { lines, currency } = buildSellableLines(db, row.lead_id, items);
  return checkoutShopLines(db, row, lines, currency, returnUrl);
}

/* ── Batch 128: Checkout module config + public payload ── */

/** The Checkout module's own settings (surface copy only — the money
 *  configuration itself lives in the unified per-lead payments config,
 *  lead_payment_configs, resolved via paymentsConfig; the legacy
 *  shop_stripe_keys / membership_stripe_keys tables are read-only
 *  fallbacks. Batch 143 comment correction — this said shop_stripe_keys
 *  until now, which has been stale since the Batch 129 streamline. */
function getCheckoutConfig(db, leadId) {
  ensureTables(db);
  const row = db.prepare('SELECT * FROM checkout_configs WHERE lead_id = ?').get(Number(leadId)) || null;
  return {
    lead_id: Number(leadId),
    success_message: row ? String(row.success_message || '') : '',
    updated_at: row ? row.updated_at : null,
  };
}

function updateCheckoutConfig(db, leadId, data = {}) {
  ensureTables(db);
  const lid = Number(leadId);
  const current = getCheckoutConfig(db, lid);
  const msg = String(data.success_message != null ? data.success_message : current.success_message)
    .trim()
    .slice(0, 300);
  db.prepare(
    `INSERT INTO checkout_configs (lead_id, success_message, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(lead_id) DO UPDATE SET success_message = excluded.success_message, updated_at = datetime('now')`
  ).run(lid, msg);
  return getCheckoutConfig(db, lid);
}

/**
 * The Checkout module's public payload block: its own config, the
 * lead-level payment state (the cart charges the lead's shop Stripe
 * configuration, whichever source module a line came from), and
 * back-links to the site's shop / gallery pages — all resolved
 * through the platform (each embed's CURRENT page slug), never free
 * text. A missing source module just drops its back-link; the
 * checkout itself is dormant only when payments are unconfigured
 * (the embed then says so instead of offering a dead Pay button).
 */
function publicCheckoutPayload(db, leadId) {
  ensureTables(db);
  const lid = Number(leadId);
  const config = getCheckoutConfig(db, lid);
  const shopStripe = require('./shopStripe');
  const pageOf = (type) => {
    const embed = getEmbedRow(db, lid, type);
    if (!embed || !moduleEmbedActive(embed)) return null;
    return `/${String(embed.target_page_slug || MODULE_META[type].defaultSlug).replace(/^\/+/, '')}`;
  };
  return {
    config: { success_message: config.success_message },
    cart: {
      configured: shopStripe.isConfiguredForLead(db, lid),
      mode: shopStripe.effectiveMode(db, lid),
    },
    shop_page: pageOf('ecommerce'),
    gallery_page: pageOf('gallery'),
  };
}

function formatPrice(cents, currency = 'USD') {
  const raw = Number(cents);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  const n = raw / 100;
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD' }).format(n);
  } catch {
    return `${currency || 'USD'} ${n.toFixed(2)}`;
  }
}

/* ── Batch 127: product variants ──
 * A product may define up to two option groups (axes — "Pot",
 * "Size"), each with ordered values. The cartesian product of the
 * values is the variant matrix; each variant is a purchasable unit
 * with its own price, optional SKU / label override, and an
 * availability flag. Products without option groups have no variant
 * rows at all and behave exactly as they always have (single price).
 *
 * ONE write path: the portal editor, the hosted MCP tools and the
 * design agent all land in createProduct/updateProduct, which accept
 *   options:  [{ name, values: [..] }]   — key present = the product's
 *             whole option structure is reconciled to this; [] clears
 *             it; absent = untouched (partial updates stay partial).
 *   variants: [{ values: [..one per axis..] | { GroupName: value },
 *             price_cents | price, sku, label, available }]
 *             — per-combination overrides applied over the matrix;
 *             combinations not mentioned keep their reconciled state
 *             (existing price/flags, or the product base price for
 *             brand-new combinations).
 * Reconciliation preserves ids where it honestly can: groups match
 * by position (renaming an axis keeps its variants), values match by
 * string, variants match by combination. Orders snapshot the variant
 * label, so later edits never rewrite what a buyer actually bought. */

const MAX_OPTION_GROUPS = 2;
const MAX_OPTION_VALUES = 12;
const MAX_VARIANTS = 100;
const VARIANT_COMBO_SEP = '\u0001';

function variantComboKey(values) {
  return (values || []).map((v) => String(v || '').trim().toLowerCase()).join(VARIANT_COMBO_SEP);
}

function coerceVariantBool(v, dflt) {
  if (v == null) return dflt;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  const s = String(v).trim().toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes') return true;
  if (s === 'false' || s === '0' || s === 'no' || s === '') return false;
  return dflt;
}

function listProductOptions(db, leadId, productId) {
  ensureTables(db);
  const lid = Number(leadId);
  const pid = Number(productId);
  const groups = db
    .prepare(
      'SELECT * FROM ecommerce_product_options WHERE lead_id = ? AND product_id = ? ORDER BY sort_order ASC, id ASC'
    )
    .all(lid, pid);
  const values = db
    .prepare(
      'SELECT * FROM ecommerce_product_option_values WHERE lead_id = ? AND product_id = ? ORDER BY sort_order ASC, id ASC'
    )
    .all(lid, pid);
  return groups.map((g) => ({
    id: g.id,
    name: g.name,
    sort_order: g.sort_order,
    values: values
      .filter((v) => v.option_id === g.id)
      .map((v) => ({ id: v.id, value: v.value, sort_order: v.sort_order })),
  }));
}

function listProductVariants(db, leadId, productId) {
  ensureTables(db);
  const lid = Number(leadId);
  const pid = Number(productId);
  const groups = listProductOptions(db, lid, pid);
  const valueById = new Map();
  for (const g of groups) for (const v of g.values) valueById.set(v.id, v.value);
  const rows = db
    .prepare(
      'SELECT * FROM ecommerce_product_variants WHERE lead_id = ? AND product_id = ? ORDER BY sort_order ASC, id ASC'
    )
    .all(lid, pid);
  return rows.map((r) => {
    let ids = [];
    try {
      const parsed = JSON.parse(r.option_value_ids || '[]');
      if (Array.isArray(parsed)) ids = parsed.map((x) => Number(x) || 0);
    } catch {
      ids = [];
    }
    const values = ids.map((id) => valueById.get(id) || '');
    return {
      id: r.id,
      product_id: pid,
      option_value_ids: ids,
      values,
      label: String(r.label_override || '') || values.filter(Boolean).join(' · '),
      label_override: String(r.label_override || ''),
      sku: String(r.sku || ''),
      price_cents: Number(r.price_cents) || 0,
      available: !!r.available,
      sort_order: r.sort_order,
    };
  });
}

function productVariantData(db, leadId, productId) {
  const options = listProductOptions(db, leadId, productId);
  const variants = listProductVariants(db, leadId, productId);
  return { options, variants, has_variants: variants.length > 0 };
}

/** A product row plus its variant structure (options + variants). */
function withProductVariants(db, leadId, product) {
  if (!product) return product;
  const data = productVariantData(db, leadId, product.id);
  return { ...product, options: data.options, variants: data.variants, has_variants: data.has_variants };
}

function getProductVariant(db, leadId, variantId) {
  ensureTables(db);
  const row = db
    .prepare('SELECT * FROM ecommerce_product_variants WHERE lead_id = ? AND id = ?')
    .get(Number(leadId), Number(variantId));
  if (!row) return null;
  return listProductVariants(db, leadId, row.product_id).find((v) => v.id === row.id) || null;
}

/** The honest single price for a product: with variants, the lowest
 *  price among AVAILABLE variants (the lowest overall when none are
 *  available); without variants, the product's own price_cents. The
 *  shared layer (Batch 122) and every price label use this rule. */
function productDisplayPriceCents(db, leadId, product) {
  if (!product) return 0;
  const variants = listProductVariants(db, leadId, product.id);
  if (!variants.length) return Number(product.price_cents) || 0;
  const available = variants.filter((v) => v.available);
  const pool = available.length ? available : variants;
  return Math.min(...pool.map((v) => Number(v.price_cents) || 0));
}

function productPriceLabel(db, leadId, product) {
  if (!product) return null;
  const variants = listProductVariants(db, leadId, product.id);
  if (!variants.length) return formatPrice(product.price_cents, product.currency);
  const available = variants.filter((v) => v.available);
  const pool = available.length ? available : variants;
  const prices = pool.map((v) => Number(v.price_cents) || 0);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const minLabel = formatPrice(min, product.currency);
  if (min === max || !minLabel) return minLabel || formatPrice(max, product.currency);
  return `From ${minLabel}`;
}

/** The storefront shape of a product: variant structure in the
 *  public vocabulary (no SKUs — those are the merchant's own), plus
 *  the honest price label. */
function publicProductShape(db, leadId, product, stripeReady) {
  const data = productVariantData(db, leadId, product.id);
  return {
    ...product,
    options: data.options.map((g) => ({ name: g.name, values: g.values.map((v) => v.value) })),
    variants: data.variants.map((v) => ({
      id: v.id,
      values: v.values,
      label: v.label,
      price_cents: v.price_cents,
      price_label: formatPrice(v.price_cents, product.currency),
      available: v.available,
    })),
    has_variants: data.has_variants,
    price_from_cents: data.has_variants ? productDisplayPriceCents(db, leadId, product) : product.price_cents,
    price_label: productPriceLabel(db, leadId, product),
    stripe_checkout: !!stripeReady && !product.checkout_url,
  };
}

function normalizeVariantOptionsInput(raw) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw fail('VALIDATION', 'options must be an array of { name, values }', 400);
  if (raw.length > MAX_OPTION_GROUPS)
    throw fail('VALIDATION', `A product can have at most ${MAX_OPTION_GROUPS} option groups`, 400);
  const seenNames = new Set();
  const groups = raw.map((g) => {
    const name = String((g && (g.name != null ? g.name : g.label)) || '')
      .trim()
      .slice(0, 60);
    if (!name) throw fail('VALIDATION', 'Each option group needs a name (e.g. Pot, Size)', 400);
    const nameKey = name.toLowerCase();
    if (seenNames.has(nameKey)) throw fail('VALIDATION', `Duplicate option group: ${name}`, 400);
    seenNames.add(nameKey);
    const rawValues = g ? (g.values != null ? g.values : g.options) : null;
    if (!Array.isArray(rawValues) || !rawValues.length)
      throw fail('VALIDATION', `Option group "${name}" needs at least one value`, 400);
    if (rawValues.length > MAX_OPTION_VALUES)
      throw fail('VALIDATION', `Option group "${name}" can have at most ${MAX_OPTION_VALUES} values`, 400);
    const seenValues = new Set();
    const values = rawValues.map((v) => {
      const value = String((v && typeof v === 'object' ? (v.value != null ? v.value : v.name) : v) || '')
        .trim()
        .slice(0, 80);
      if (!value) throw fail('VALIDATION', `Option group "${name}" has an empty value`, 400);
      const vk = value.toLowerCase();
      if (seenValues.has(vk)) throw fail('VALIDATION', `Duplicate value "${value}" in option group "${name}"`, 400);
      seenValues.add(vk);
      return value;
    });
    return { name, values };
  });
  if (groups.length) {
    const combos = groups.reduce((n, g) => n * g.values.length, 1);
    if (combos > MAX_VARIANTS)
      throw fail('VALIDATION', `Those options make ${combos} variants — the limit is ${MAX_VARIANTS}`, 400);
  }
  return groups;
}

function normalizeVariantOverrides(raw, groups) {
  const map = new Map();
  if (raw == null) return map;
  if (!Array.isArray(raw)) throw fail('VALIDATION', 'variants must be an array', 400);
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') throw fail('VALIDATION', 'Each variant must be an object', 400);
    let values = null;
    if (Array.isArray(entry.values)) {
      values = entry.values.map((v) => String(v != null ? v : '').trim());
    } else if (entry.values && typeof entry.values === 'object') {
      values = groups.map((g) => {
        const hit = Object.entries(entry.values).find(([k]) => String(k).trim().toLowerCase() === g.name.toLowerCase());
        return hit ? String(hit[1] != null ? hit[1] : '').trim() : '';
      });
    }
    if (!values || values.length !== groups.length)
      throw fail('VALIDATION', 'Each variant must name exactly one value per option group', 400);
    values = values.map((v, i) => {
      const canonical = groups[i].values.find((gv) => gv.toLowerCase() === v.toLowerCase());
      if (!canonical) throw fail('VALIDATION', `"${v}" is not a value of option group "${groups[i].name}"`, 400);
      return canonical;
    });
    const key = variantComboKey(values);
    if (map.has(key)) throw fail('VALIDATION', `Duplicate variant combination: ${values.join(' / ')}`, 400);
    let priceCents = null;
    if (entry.price_cents != null) priceCents = Math.round(Number(entry.price_cents) || 0);
    else if (entry.price != null) priceCents = Math.round((Number(entry.price) || 0) * 100);
    if (priceCents != null && (priceCents < 0 || priceCents > 100000000))
      throw fail('VALIDATION', `Variant price looks wrong for: ${values.join(' / ')}`, 400);
    map.set(key, {
      values,
      price_cents: priceCents,
      sku: entry.sku != null ? String(entry.sku).slice(0, 80) : null,
      label: entry.label != null ? String(entry.label).slice(0, 120) : null,
      available: entry.available == null ? null : coerceVariantBool(entry.available, true),
    });
  }
  return map;
}

function clearProductVariants(db, leadId, productId) {
  const lid = Number(leadId);
  const pid = Number(productId);
  db.prepare('DELETE FROM ecommerce_product_variants WHERE lead_id = ? AND product_id = ?').run(lid, pid);
  db.prepare('DELETE FROM ecommerce_product_option_values WHERE lead_id = ? AND product_id = ?').run(lid, pid);
  db.prepare('DELETE FROM ecommerce_product_options WHERE lead_id = ? AND product_id = ?').run(lid, pid);
}

/** Reconcile a product's whole variant structure to the given option
 *  groups + per-combination overrides. Returns the fresh structure. */
function setProductOptions(db, leadId, product, optionsInput, variantsInput) {
  ensureTables(db);
  const lid = Number(leadId);
  const pid = Number(product.id);
  const groups = normalizeVariantOptionsInput(optionsInput);
  if (!groups.length) {
    clearProductVariants(db, lid, pid);
    return { options: [], variants: [], has_variants: false };
  }
  const overrides = normalizeVariantOverrides(variantsInput, groups);
  // Snapshot the existing structure BEFORE touching it: a variant
  // survives (same row, price, SKU, availability) while its
  // combination of VALUES survives. Values are matched by name,
  // then — when the group keeps the same number of values — by
  // position, so axis renames, value renames and reorders all keep
  // identity; a removed value takes its variants with it.
  // (Finisher fix: the builder's first cut matched values and
  // combinations by string only, so renaming a value silently
  // rebuilt its variants at the base price and re-enabled
  // unavailable ones; the live proof caught it.)
  const existingGroups = listProductOptions(db, lid, pid);
  const existingVariants = listProductVariants(db, lid, pid);
  const existingByCombo = new Map(existingVariants.map((v) => [(v.option_value_ids || []).join('-'), v]));

  // Groups match by position — renaming an axis keeps its variants.
  const axisValueIds = [];
  groups.forEach((g, gi) => {
    let groupRow = existingGroups[gi] || null;
    if (groupRow) {
      db.prepare(
        "UPDATE ecommerce_product_options SET name = ?, sort_order = ?, updated_at = datetime('now') WHERE id = ? AND lead_id = ?"
      ).run(g.name, gi, groupRow.id, lid);
    } else {
      const info = db
        .prepare('INSERT INTO ecommerce_product_options (lead_id, product_id, name, sort_order) VALUES (?, ?, ?, ?)')
        .run(lid, pid, g.name, gi);
      groupRow = { id: Number(info.lastInsertRowid), values: [] };
    }
    const existingValues = existingGroups[gi] ? existingGroups[gi].values : [];
    const byValue = new Map(existingValues.map((v) => [v.value.toLowerCase(), v]));
    const usedOldValues = new Set();
    const valueIds = new Array(g.values.length).fill(0);
    const updateValueRow = (rowId, value, vi) =>
      db
        .prepare(
          "UPDATE ecommerce_product_option_values SET value = ?, sort_order = ?, updated_at = datetime('now') WHERE id = ? AND lead_id = ?"
        )
        .run(value, vi, rowId, lid);
    // Pass 1: values match by name (case-insensitive) — an unchanged
    // or merely reordered value keeps its row.
    g.values.forEach((value, vi) => {
      const hit = byValue.get(value.toLowerCase());
      if (hit && !usedOldValues.has(hit.id)) {
        updateValueRow(hit.id, value, vi);
        usedOldValues.add(hit.id);
        valueIds[vi] = hit.id;
      }
    });
    // Pass 2 (rename detection): when the group keeps the same
    // number of values, an unmatched new value at the same position
    // as an unmatched old value is that value RENAMED — update its
    // row in place so its variants survive. When the count changed,
    // a rename cannot be told apart from a remove+add, so unmatched
    // values fall through as remove+add (the original behavior).
    if (existingValues.length === g.values.length) {
      g.values.forEach((value, vi) => {
        if (valueIds[vi]) return;
        const old = existingValues[vi];
        if (old && !usedOldValues.has(old.id)) {
          updateValueRow(old.id, value, vi);
          usedOldValues.add(old.id);
          valueIds[vi] = old.id;
        }
      });
    }
    // Pass 3: genuinely new values are inserted (BEFORE the deletes
    // below, so a freed rowid can never be reused inside this
    // reconcile and collide with a surviving combination).
    g.values.forEach((value, vi) => {
      if (valueIds[vi]) return;
      const info = db
        .prepare(
          'INSERT INTO ecommerce_product_option_values (lead_id, product_id, option_id, value, sort_order) VALUES (?, ?, ?, ?, ?)'
        )
        .run(lid, pid, groupRow.id, value, vi);
      valueIds[vi] = Number(info.lastInsertRowid);
    });
    const keep = new Set(valueIds);
    for (const v of existingValues) {
      if (!keep.has(v.id))
        db.prepare('DELETE FROM ecommerce_product_option_values WHERE id = ? AND lead_id = ?').run(v.id, lid);
    }
    axisValueIds.push(valueIds);
  });
  for (let gi = groups.length; gi < existingGroups.length; gi++) {
    db.prepare('DELETE FROM ecommerce_product_option_values WHERE option_id = ? AND lead_id = ?').run(
      existingGroups[gi].id,
      lid
    );
    db.prepare('DELETE FROM ecommerce_product_options WHERE id = ? AND lead_id = ?').run(existingGroups[gi].id, lid);
  }

  // The matrix: every combination of the axes' values, in axis order.
  const combos = [];
  const walk = (axis, acc) => {
    if (axis === groups.length) {
      combos.push(acc.slice());
      return;
    }
    groups[axis].values.forEach((value, vi) => {
      acc.push({ value, id: axisValueIds[axis][vi] });
      walk(axis + 1, acc);
      acc.pop();
    });
  };
  walk(0, []);
  const keepVariantIds = new Set();
  combos.forEach((combo, ci) => {
    const values = combo.map((c) => c.value);
    const ids = combo.map((c) => c.id);
    const key = variantComboKey(values);
    // Variants match by their value-id combination (overrides from
    // the caller still key on the value strings).
    const prev = existingByCombo.get(ids.join('-'));
    const ov = overrides.get(key);
    const priceCents =
      ov && ov.price_cents != null ? ov.price_cents : prev ? prev.price_cents : Number(product.price_cents) || 0;
    const sku = ov && ov.sku != null ? ov.sku : prev ? prev.sku : '';
    const labelOverride = ov && ov.label != null ? ov.label : prev ? prev.label_override : '';
    const available = ov && ov.available != null ? ov.available : prev ? prev.available : true;
    if (prev) {
      db.prepare(
        `UPDATE ecommerce_product_variants SET combo_key = ?, option_value_ids = ?, label_override = ?, sku = ?,
           price_cents = ?, available = ?, sort_order = ?, updated_at = datetime('now')
         WHERE id = ? AND lead_id = ?`
      ).run(ids.join('-'), JSON.stringify(ids), labelOverride, sku, priceCents, available ? 1 : 0, ci, prev.id, lid);
      keepVariantIds.add(prev.id);
    } else {
      const info = db
        .prepare(
          `INSERT INTO ecommerce_product_variants
             (lead_id, product_id, combo_key, option_value_ids, label_override, sku, price_cents, available, sort_order)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(lid, pid, ids.join('-'), JSON.stringify(ids), labelOverride, sku, priceCents, available ? 1 : 0, ci);
      keepVariantIds.add(Number(info.lastInsertRowid));
    }
  });
  for (const v of existingVariants) {
    if (!keepVariantIds.has(v.id))
      db.prepare('DELETE FROM ecommerce_product_variants WHERE id = ? AND lead_id = ?').run(v.id, lid);
  }
  return productVariantData(db, lid, pid);
}

/** The create/update discipline (same as category_ids): the options
 *  key present = reconcile the whole structure; variants alone =
 *  overrides against the existing axes; both absent = untouched. */
function reconcileProductVariantsFromInput(db, leadId, product, data) {
  if (!data || (data.options === undefined && data.variants === undefined)) return;
  if (data.options !== undefined) {
    setProductOptions(db, leadId, product, data.options, data.variants);
    return;
  }
  const existing = listProductOptions(db, leadId, product.id);
  if (!existing.length)
    throw fail('VALIDATION', 'variants need option groups — send options together with the variants', 400);
  setProductOptions(
    db,
    leadId,
    product,
    existing.map((g) => ({ name: g.name, values: g.values.map((v) => v.value) })),
    data.variants
  );
}

/* ── Courses ── */

function lessonsForCourse(db, courseId) {
  return db
    .prepare('SELECT * FROM course_lessons WHERE course_id = ? ORDER BY sort_order ASC, id ASC')
    .all(Number(courseId));
}

function listCourses(db, leadId, { includeDrafts = true, withLessons = true } = {}) {
  ensureTables(db);
  let sql = 'SELECT * FROM courses WHERE lead_id = ?';
  if (!includeDrafts) sql += " AND status = 'published'";
  sql += ' ORDER BY sort_order ASC, id DESC';
  const rows = db.prepare(sql).all(Number(leadId));
  if (!withLessons) return rows;
  return rows.map((c) => ({ ...c, lessons: lessonsForCourse(db, c.id) }));
}

function getCourse(db, leadId, idOrSlug, { withLessons = true } = {}) {
  ensureTables(db);
  const lid = Number(leadId);
  let row;
  if (/^\d+$/.test(String(idOrSlug))) {
    row = db.prepare('SELECT * FROM courses WHERE lead_id = ? AND id = ?').get(lid, Number(idOrSlug));
  } else {
    row = db.prepare('SELECT * FROM courses WHERE lead_id = ? AND slug = ?').get(lid, slugify(idOrSlug));
  }
  if (!row) return null;
  if (withLessons) row = { ...row, lessons: lessonsForCourse(db, row.id) };
  return row;
}

function createCourse(db, leadId, data = {}) {
  ensureTables(db);
  const title = String(data.title || '').trim();
  if (!title) throw fail('VALIDATION', 'title is required');
  const slug = slugify(data.slug || title, 'course');
  const status = String(data.status || 'draft').toLowerCase() === 'published' ? 'published' : 'draft';
  let course;
  try {
    const info = db
      .prepare(
        `
      INSERT INTO courses
        (lead_id, title, slug, description, enrollment_url, cover_image, status, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        Number(leadId),
        title.slice(0, 200),
        slug,
        String(data.description || ''),
        String(data.enrollment_url || data.enrollmentUrl || ''),
        String(data.cover_image || data.coverImage || ''),
        status,
        Number(data.sort_order) || 0
      );
    course = getCourse(db, leadId, info.lastInsertRowid, { withLessons: false });
  } catch (e) {
    if (String(e.message || '').includes('UNIQUE')) {
      throw fail('CONFLICT', `Course slug already exists: ${slug}`, 409);
    }
    throw e;
  }
  const lessons = Array.isArray(data.lessons) ? data.lessons : [];
  for (let i = 0; i < lessons.length; i++) {
    addLesson(db, leadId, course.id, {
      ...lessons[i],
      sort_order: lessons[i].sort_order != null ? lessons[i].sort_order : i,
    });
  }
  return getCourse(db, leadId, course.id);
}

function updateCourse(db, leadId, id, data = {}) {
  ensureTables(db);
  const row = getCourse(db, leadId, id, { withLessons: false });
  if (!row) throw fail('NOT_FOUND', 'Course not found', 404);
  const title = data.title != null ? String(data.title).trim().slice(0, 200) : row.title;
  const slug = data.slug != null ? slugify(data.slug, row.slug) : row.slug;
  const description = data.description != null ? String(data.description) : row.description;
  const enrollment =
    data.enrollment_url != null || data.enrollmentUrl != null
      ? String(data.enrollment_url != null ? data.enrollment_url : data.enrollmentUrl)
      : row.enrollment_url;
  const cover =
    data.cover_image != null || data.coverImage != null
      ? String(data.cover_image != null ? data.cover_image : data.coverImage)
      : row.cover_image;
  const status =
    data.status != null ? (String(data.status).toLowerCase() === 'published' ? 'published' : 'draft') : row.status;
  const sortOrder = data.sort_order != null ? Number(data.sort_order) || 0 : row.sort_order;
  try {
    db.prepare(
      `
      UPDATE courses SET title=?, slug=?, description=?, enrollment_url=?, cover_image=?,
        status=?, sort_order=?, updated_at=datetime('now') WHERE id=? AND lead_id=?
    `
    ).run(title, slug, description, enrollment, cover, status, sortOrder, row.id, Number(leadId));
  } catch (e) {
    if (String(e.message || '').includes('UNIQUE')) {
      throw fail('CONFLICT', `Course slug already exists: ${slug}`, 409);
    }
    throw e;
  }
  return getCourse(db, leadId, row.id);
}

function deleteCourse(db, leadId, id) {
  ensureTables(db);
  const row = getCourse(db, leadId, id, { withLessons: false });
  if (!row) throw fail('NOT_FOUND', 'Course not found', 404);
  db.prepare('DELETE FROM course_lessons WHERE course_id = ?').run(row.id);
  db.prepare('DELETE FROM courses WHERE id = ? AND lead_id = ?').run(row.id, Number(leadId));
  return { deleted: true, id: row.id };
}

function addLesson(db, leadId, courseId, data = {}) {
  ensureTables(db);
  const course = getCourse(db, leadId, courseId, { withLessons: false });
  if (!course) throw fail('NOT_FOUND', 'Course not found', 404);
  const title = String(data.title || '').trim();
  if (!title) throw fail('VALIDATION', 'lesson title is required');
  const info = db
    .prepare(
      `
    INSERT INTO course_lessons (course_id, title, body_html, lesson_url, sort_order)
    VALUES (?, ?, ?, ?, ?)
  `
    )
    .run(
      course.id,
      title.slice(0, 200),
      String(data.body_html || data.body || ''),
      String(data.lesson_url || data.lessonUrl || data.url || ''),
      Number(data.sort_order) || 0
    );
  return db.prepare('SELECT * FROM course_lessons WHERE id = ?').get(info.lastInsertRowid);
}


function deleteLesson(db, leadId, lessonId) {
  ensureTables(db);
  const lesson = db.prepare('SELECT * FROM course_lessons WHERE id = ?').get(Number(lessonId));
  if (!lesson) throw fail('NOT_FOUND', 'Lesson not found', 404);
  const course = getCourse(db, leadId, lesson.course_id, { withLessons: false });
  if (!course) throw fail('NOT_FOUND', 'Course not found', 404);
  db.prepare('DELETE FROM course_lessons WHERE id = ?').run(lesson.id);
  return { deleted: true, id: lesson.id };
}

/* ── Gallery ── */

function imagesForAlbum(db, albumId) {
  return db
    .prepare('SELECT * FROM gallery_images WHERE album_id = ? ORDER BY sort_order ASC, id ASC')
    .all(Number(albumId));
}

function listAlbums(db, leadId, { includeDrafts = true, withImages = true } = {}) {
  ensureTables(db);
  let sql = 'SELECT * FROM gallery_albums WHERE lead_id = ?';
  if (!includeDrafts) sql += " AND status = 'published'";
  sql += ' ORDER BY sort_order ASC, id DESC';
  const rows = db.prepare(sql).all(Number(leadId));
  if (!withImages) return decorateItemsCategories(db, leadId, 'gallery', rows);
  return decorateItemsCategories(
    db,
    leadId,
    'gallery',
    rows.map((a) => ({ ...a, images: imagesForAlbum(db, a.id) }))
  );
}

function getAlbum(db, leadId, idOrSlug, { withImages = true } = {}) {
  ensureTables(db);
  const lid = Number(leadId);
  let row;
  if (/^\d+$/.test(String(idOrSlug))) {
    row = db.prepare('SELECT * FROM gallery_albums WHERE lead_id = ? AND id = ?').get(lid, Number(idOrSlug));
  } else {
    row = db.prepare('SELECT * FROM gallery_albums WHERE lead_id = ? AND slug = ?').get(lid, slugify(idOrSlug));
  }
  if (!row) return null;
  if (withImages) row = { ...row, images: imagesForAlbum(db, row.id) };
  return decorateItemCategories(db, leadId, 'gallery', row);
}

function createAlbum(db, leadId, data = {}) {
  ensureTables(db);
  const title = String(data.title || data.name || '').trim();
  if (!title) throw fail('VALIDATION', 'title is required');
  // Batch 124: validate category assignments before the insert.
  const wantsCats = assertItemCategories(db, leadId, 'gallery', data);
  const slug = slugify(data.slug || title, 'album');
  const status = String(data.status || 'draft').toLowerCase() === 'published' ? 'published' : 'draft';
  let album;
  try {
    const info = db
      .prepare(
        `
      INSERT INTO gallery_albums (lead_id, title, slug, description, status, sort_order)
      VALUES (?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        Number(leadId),
        title.slice(0, 200),
        slug,
        String(data.description || ''),
        status,
        Number(data.sort_order) || 0
      );
    album = getAlbum(db, leadId, info.lastInsertRowid, { withImages: false });
  } catch (e) {
    if (String(e.message || '').includes('UNIQUE')) {
      throw fail('CONFLICT', `Album slug already exists: ${slug}`, 409);
    }
    throw e;
  }
  const images = Array.isArray(data.images) ? data.images : [];
  for (let i = 0; i < images.length; i++) {
    addGalleryImage(db, leadId, album.id, {
      ...images[i],
      sort_order: images[i].sort_order != null ? images[i].sort_order : i,
    });
  }
  if (wantsCats) applyItemCategories(db, leadId, 'gallery', album.id, data);
  return getAlbum(db, leadId, album.id);
}

function updateAlbum(db, leadId, id, data = {}) {
  ensureTables(db);
  const row = getAlbum(db, leadId, id, { withImages: false });
  if (!row) throw fail('NOT_FOUND', 'Album not found', 404);
  // Batch 124: validate category assignments before the update lands.
  const wantsCats = assertItemCategories(db, leadId, 'gallery', data);
  const title =
    data.title != null || data.name != null
      ? String(data.title != null ? data.title : data.name)
          .trim()
          .slice(0, 200)
      : row.title;
  const slug = data.slug != null ? slugify(data.slug, row.slug) : row.slug;
  const description = data.description != null ? String(data.description) : row.description;
  const status =
    data.status != null ? (String(data.status).toLowerCase() === 'published' ? 'published' : 'draft') : row.status;
  const sortOrder = data.sort_order != null ? Number(data.sort_order) || 0 : row.sort_order;
  try {
    db.prepare(
      `
      UPDATE gallery_albums SET title=?, slug=?, description=?, status=?, sort_order=?,
        updated_at=datetime('now') WHERE id=? AND lead_id=?
    `
    ).run(title, slug, description, status, sortOrder, row.id, Number(leadId));
  } catch (e) {
    if (String(e.message || '').includes('UNIQUE')) {
      throw fail('CONFLICT', `Album slug already exists: ${slug}`, 409);
    }
    throw e;
  }
  if (wantsCats) applyItemCategories(db, leadId, 'gallery', row.id, data);
  return getAlbum(db, leadId, row.id);
}

function deleteAlbum(db, leadId, id) {
  ensureTables(db);
  const row = getAlbum(db, leadId, id, { withImages: false });
  if (!row) throw fail('NOT_FOUND', 'Album not found', 404);
  db.prepare('DELETE FROM gallery_images WHERE album_id = ?').run(row.id);
  db.prepare('DELETE FROM gallery_albums WHERE id = ? AND lead_id = ?').run(row.id, Number(leadId));
  clearItemCategories(db, leadId, 'gallery', row.id);
  return { deleted: true, id: row.id };
}

function addGalleryImage(db, leadId, albumId, data = {}) {
  ensureTables(db);
  const album = getAlbum(db, leadId, albumId, { withImages: false });
  if (!album) throw fail('NOT_FOUND', 'Album not found', 404);
  const imageUrl = String(data.image_url || data.url || data.src || '').trim();
  if (!imageUrl) throw fail('VALIDATION', 'image_url is required');
  // Batch 128: an owner can price a photo (price_cents, or `price` in
  // dollars like products) — a priced photo in a published album is
  // sellable through the Checkout module; 0/absent stays display-only.
  const priceCents =
    data.price_cents != null
      ? Math.max(0, Math.round(Number(data.price_cents) || 0))
      : Math.max(0, Math.round((Number(data.price) || 0) * 100));
  const info = db
    .prepare(
      `
    INSERT INTO gallery_images (album_id, image_url, caption, price_cents, sort_order)
    VALUES (?, ?, ?, ?, ?)
  `
    )
    .run(album.id, imageUrl, String(data.caption || ''), priceCents, Number(data.sort_order) || 0);
  return db.prepare('SELECT * FROM gallery_images WHERE id = ?').get(info.lastInsertRowid);
}

function deleteGalleryImage(db, leadId, imageId) {
  ensureTables(db);
  const img = db.prepare('SELECT * FROM gallery_images WHERE id = ?').get(Number(imageId));
  if (!img) throw fail('NOT_FOUND', 'Image not found', 404);
  const album = getAlbum(db, leadId, img.album_id, { withImages: false });
  if (!album) throw fail('NOT_FOUND', 'Album not found', 404);
  db.prepare('DELETE FROM gallery_images WHERE id = ?').run(img.id);
  return { deleted: true, id: img.id };
}

/* ── Directory ── */

function listListings(db, leadId, { includeDrafts = true, category } = {}) {
  ensureTables(db);
  let sql = 'SELECT * FROM directory_listings WHERE lead_id = ?';
  const params = [Number(leadId)];
  if (!includeDrafts) sql += " AND status = 'published'";
  if (category) {
    sql += ' AND LOWER(category) = LOWER(?)';
    params.push(String(category));
  }
  sql += ' ORDER BY sort_order ASC, name ASC, id DESC';
  return decorateItemsCategories(db, leadId, 'directory', db.prepare(sql).all(...params));
}

function getListing(db, leadId, id) {
  ensureTables(db);
  const row = db
    .prepare('SELECT * FROM directory_listings WHERE lead_id = ? AND id = ?')
    .get(Number(leadId), Number(id));
  return decorateItemCategories(db, leadId, 'directory', row || null);
}

function createListing(db, leadId, data = {}) {
  ensureTables(db);
  const name = String(data.name || data.title || '').trim();
  if (!name) throw fail('VALIDATION', 'name is required');
  // Batch 124: validate category assignments before the insert.
  const wantsCats = assertItemCategories(db, leadId, 'directory', data);
  const status = String(data.status || 'draft').toLowerCase() === 'published' ? 'published' : 'draft';
  const info = db
    .prepare(
      `
    INSERT INTO directory_listings
      (lead_id, name, category, description, contact_email, contact_phone, website_url, image_url, status, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
    )
    .run(
      Number(leadId),
      name.slice(0, 200),
      String(data.category || '').slice(0, 120),
      String(data.description || ''),
      String(data.contact_email || data.email || ''),
      String(data.contact_phone || data.phone || ''),
      String(data.website_url || data.link || data.url || ''),
      String(data.image_url || data.image || ''),
      status,
      Number(data.sort_order) || 0
    );
  if (wantsCats) applyItemCategories(db, leadId, 'directory', Number(info.lastInsertRowid), data);
  return getListing(db, leadId, info.lastInsertRowid);
}

function updateListing(db, leadId, id, data = {}) {
  ensureTables(db);
  const row = getListing(db, leadId, id);
  if (!row) throw fail('NOT_FOUND', 'Listing not found', 404);
  // Batch 124: validate category assignments before the update lands.
  const wantsCats = assertItemCategories(db, leadId, 'directory', data);
  const name =
    data.name != null || data.title != null
      ? String(data.name != null ? data.name : data.title)
          .trim()
          .slice(0, 200)
      : row.name;
  const category = data.category != null ? String(data.category).slice(0, 120) : row.category;
  const description = data.description != null ? String(data.description) : row.description;
  const email =
    data.contact_email != null || data.email != null
      ? String(data.contact_email != null ? data.contact_email : data.email)
      : row.contact_email;
  const phone =
    data.contact_phone != null || data.phone != null
      ? String(data.contact_phone != null ? data.contact_phone : data.phone)
      : row.contact_phone;
  const website =
    data.website_url != null || data.link != null || data.url != null
      ? String(data.website_url != null ? data.website_url : data.link != null ? data.link : data.url)
      : row.website_url;
  const image =
    data.image_url != null || data.image != null
      ? String(data.image_url != null ? data.image_url : data.image)
      : row.image_url;
  const status =
    data.status != null ? (String(data.status).toLowerCase() === 'published' ? 'published' : 'draft') : row.status;
  const sortOrder = data.sort_order != null ? Number(data.sort_order) || 0 : row.sort_order;
  db.prepare(
    `
    UPDATE directory_listings SET name=?, category=?, description=?, contact_email=?,
      contact_phone=?, website_url=?, image_url=?, status=?, sort_order=?,
      updated_at=datetime('now') WHERE id=? AND lead_id=?
  `
  ).run(name, category, description, email, phone, website, image, status, sortOrder, row.id, Number(leadId));
  if (wantsCats) applyItemCategories(db, leadId, 'directory', row.id, data);
  return getListing(db, leadId, row.id);
}

function deleteListing(db, leadId, id) {
  ensureTables(db);
  const row = getListing(db, leadId, id);
  if (!row) throw fail('NOT_FOUND', 'Listing not found', 404);
  db.prepare('DELETE FROM directory_listings WHERE id = ? AND lead_id = ?').run(row.id, Number(leadId));
  clearItemCategories(db, leadId, 'directory', row.id);
  return { deleted: true, id: row.id };
}

/* ── FAQ ── */

function listFaqItems(db, leadId, { includeDrafts = true, category } = {}) {
  ensureTables(db);
  let sql = 'SELECT * FROM faq_items WHERE lead_id = ?';
  const params = [Number(leadId)];
  if (!includeDrafts) sql += " AND status = 'published'";
  if (category) {
    sql += ' AND LOWER(category) = LOWER(?)';
    params.push(String(category));
  }
  sql += ' ORDER BY sort_order ASC, id ASC';
  return db.prepare(sql).all(...params);
}

function getFaqItem(db, leadId, id) {
  ensureTables(db);
  return db.prepare('SELECT * FROM faq_items WHERE lead_id = ? AND id = ?').get(Number(leadId), Number(id));
}

function createFaqItem(db, leadId, data = {}) {
  ensureTables(db);
  const question = String(data.question || data.title || '').trim();
  if (!question) throw fail('VALIDATION', 'question is required');
  const status = String(data.status || 'draft').toLowerCase() === 'published' ? 'published' : 'draft';
  const info = db
    .prepare(
      `
    INSERT INTO faq_items (lead_id, question, answer_html, category, status, sort_order)
    VALUES (?, ?, ?, ?, ?, ?)
  `
    )
    .run(
      Number(leadId),
      question.slice(0, 400),
      String(data.answer_html || data.answer || data.body_html || ''),
      String(data.category || '').slice(0, 120),
      status,
      Number(data.sort_order) || 0
    );
  return getFaqItem(db, leadId, info.lastInsertRowid);
}

function updateFaqItem(db, leadId, id, data = {}) {
  ensureTables(db);
  const row = getFaqItem(db, leadId, id);
  if (!row) throw fail('NOT_FOUND', 'FAQ item not found', 404);
  const question =
    data.question != null || data.title != null
      ? String(data.question != null ? data.question : data.title)
          .trim()
          .slice(0, 400)
      : row.question;
  const answer =
    data.answer_html != null || data.answer != null || data.body_html != null
      ? String(data.answer_html != null ? data.answer_html : data.answer != null ? data.answer : data.body_html)
      : row.answer_html;
  const category = data.category != null ? String(data.category).slice(0, 120) : row.category;
  const status =
    data.status != null ? (String(data.status).toLowerCase() === 'published' ? 'published' : 'draft') : row.status;
  const sortOrder = data.sort_order != null ? Number(data.sort_order) || 0 : row.sort_order;
  db.prepare(
    `
    UPDATE faq_items SET question=?, answer_html=?, category=?, status=?, sort_order=?,
      updated_at=datetime('now') WHERE id=? AND lead_id=?
  `
  ).run(question, answer, category, status, sortOrder, row.id, Number(leadId));
  return getFaqItem(db, leadId, row.id);
}

function deleteFaqItem(db, leadId, id) {
  ensureTables(db);
  const row = getFaqItem(db, leadId, id);
  if (!row) throw fail('NOT_FOUND', 'FAQ item not found', 404);
  db.prepare('DELETE FROM faq_items WHERE id = ? AND lead_id = ?').run(row.id, Number(leadId));
  return { deleted: true, id: row.id };
}

/* ── Testimonials ── */

function listTestimonials(db, leadId, { includeDrafts = true } = {}) {
  ensureTables(db);
  let sql = 'SELECT * FROM testimonials WHERE lead_id = ?';
  if (!includeDrafts) sql += " AND status = 'published'";
  sql += ' ORDER BY sort_order ASC, id DESC';
  return db.prepare(sql).all(Number(leadId));
}

function getTestimonial(db, leadId, id) {
  ensureTables(db);
  return db.prepare('SELECT * FROM testimonials WHERE lead_id = ? AND id = ?').get(Number(leadId), Number(id));
}

function createTestimonial(db, leadId, data = {}) {
  ensureTables(db);
  const quote = String(data.quote || data.body || data.text || '').trim();
  if (!quote) throw fail('VALIDATION', 'quote is required');
  const status = String(data.status || 'draft').toLowerCase() === 'published' ? 'published' : 'draft';
  let rating = Number(data.rating);
  if (!Number.isFinite(rating) || rating < 0) rating = 0;
  if (rating > 5) rating = 5;
  rating = Math.round(rating);
  const info = db
    .prepare(
      `
    INSERT INTO testimonials
      (lead_id, quote, author_name, author_title, author_company, rating, image_url, status, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
    )
    .run(
      Number(leadId),
      quote,
      String(data.author_name || data.author || data.name || '').slice(0, 160),
      String(data.author_title || data.title || data.role || '').slice(0, 160),
      String(data.author_company || data.company || '').slice(0, 160),
      rating,
      String(data.image_url || data.image || ''),
      status,
      Number(data.sort_order) || 0
    );
  return getTestimonial(db, leadId, info.lastInsertRowid);
}

function updateTestimonial(db, leadId, id, data = {}) {
  ensureTables(db);
  const row = getTestimonial(db, leadId, id);
  if (!row) throw fail('NOT_FOUND', 'Testimonial not found', 404);
  const quote =
    data.quote != null || data.body != null || data.text != null
      ? String(data.quote != null ? data.quote : data.body != null ? data.body : data.text).trim()
      : row.quote;
  const authorName =
    data.author_name != null || data.author != null || data.name != null
      ? String(data.author_name != null ? data.author_name : data.author != null ? data.author : data.name).slice(
          0,
          160
        )
      : row.author_name;
  const authorTitle =
    data.author_title != null || data.title != null || data.role != null
      ? String(data.author_title != null ? data.author_title : data.title != null ? data.title : data.role).slice(
          0,
          160
        )
      : row.author_title;
  const authorCompany =
    data.author_company != null || data.company != null
      ? String(data.author_company != null ? data.author_company : data.company).slice(0, 160)
      : row.author_company;
  let rating = row.rating;
  if (data.rating != null) {
    rating = Number(data.rating);
    if (!Number.isFinite(rating) || rating < 0) rating = 0;
    if (rating > 5) rating = 5;
    rating = Math.round(rating);
  }
  const image =
    data.image_url != null || data.image != null
      ? String(data.image_url != null ? data.image_url : data.image)
      : row.image_url;
  const status =
    data.status != null ? (String(data.status).toLowerCase() === 'published' ? 'published' : 'draft') : row.status;
  const sortOrder = data.sort_order != null ? Number(data.sort_order) || 0 : row.sort_order;
  db.prepare(
    `
    UPDATE testimonials SET quote=?, author_name=?, author_title=?, author_company=?,
      rating=?, image_url=?, status=?, sort_order=?, updated_at=datetime('now')
    WHERE id=? AND lead_id=?
  `
  ).run(quote, authorName, authorTitle, authorCompany, rating, image, status, sortOrder, row.id, Number(leadId));
  return getTestimonial(db, leadId, row.id);
}

function deleteTestimonial(db, leadId, id) {
  ensureTables(db);
  const row = getTestimonial(db, leadId, id);
  if (!row) throw fail('NOT_FOUND', 'Testimonial not found', 404);
  db.prepare('DELETE FROM testimonials WHERE id = ? AND lead_id = ?').run(row.id, Number(leadId));
  return { deleted: true, id: row.id };
}

/* ── Team ── */

function listTeamMembers(db, leadId, { includeDrafts = true } = {}) {
  ensureTables(db);
  let sql = 'SELECT * FROM team_members WHERE lead_id = ?';
  if (!includeDrafts) sql += " AND status = 'published'";
  sql += ' ORDER BY sort_order ASC, name ASC, id ASC';
  return db.prepare(sql).all(Number(leadId));
}

function getTeamMember(db, leadId, idOrSlug) {
  ensureTables(db);
  const lid = Number(leadId);
  if (/^\d+$/.test(String(idOrSlug))) {
    return db.prepare('SELECT * FROM team_members WHERE lead_id = ? AND id = ?').get(lid, Number(idOrSlug));
  }
  return db.prepare('SELECT * FROM team_members WHERE lead_id = ? AND slug = ?').get(lid, slugify(idOrSlug));
}

function createTeamMember(db, leadId, data = {}) {
  ensureTables(db);
  const name = String(data.name || data.title || '').trim();
  if (!name) throw fail('VALIDATION', 'name is required');
  const status = String(data.status || 'draft').toLowerCase() === 'published' ? 'published' : 'draft';
  let slug = slugify(data.slug || name, 'member');
  const exists = db.prepare('SELECT id FROM team_members WHERE lead_id = ? AND slug = ?').get(Number(leadId), slug);
  if (exists) slug = `${slug}-${Date.now().toString(36).slice(-4)}`;
  const info = db
    .prepare(
      `
    INSERT INTO team_members
      (lead_id, name, slug, role_title, bio, image_url, email, phone, social_url, status, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
    )
    .run(
      Number(leadId),
      name.slice(0, 200),
      slug,
      String(data.role_title || data.role || data.title || '').slice(0, 160),
      String(data.bio || data.description || ''),
      String(data.image_url || data.image || ''),
      String(data.email || ''),
      String(data.phone || ''),
      String(data.social_url || data.link || data.url || ''),
      status,
      Number(data.sort_order) || 0
    );
  return getTeamMember(db, leadId, info.lastInsertRowid);
}

function updateTeamMember(db, leadId, id, data = {}) {
  ensureTables(db);
  const row = getTeamMember(db, leadId, id);
  if (!row) throw fail('NOT_FOUND', 'Team member not found', 404);
  const name = data.name != null ? String(data.name).trim().slice(0, 200) : row.name;
  let slug = row.slug;
  if (data.slug != null) {
    slug = slugify(data.slug, 'member');
    const clash = db
      .prepare('SELECT id FROM team_members WHERE lead_id = ? AND slug = ? AND id != ?')
      .get(Number(leadId), slug, row.id);
    if (clash) throw fail('VALIDATION', 'slug already in use');
  }
  const role =
    data.role_title != null || data.role != null || data.title != null
      ? String(data.role_title != null ? data.role_title : data.role != null ? data.role : data.title).slice(0, 160)
      : row.role_title;
  const bio =
    data.bio != null || data.description != null ? String(data.bio != null ? data.bio : data.description) : row.bio;
  const image =
    data.image_url != null || data.image != null
      ? String(data.image_url != null ? data.image_url : data.image)
      : row.image_url;
  const email = data.email != null ? String(data.email) : row.email;
  const phone = data.phone != null ? String(data.phone) : row.phone;
  const social =
    data.social_url != null || data.link != null || data.url != null
      ? String(data.social_url != null ? data.social_url : data.link != null ? data.link : data.url)
      : row.social_url;
  const status =
    data.status != null ? (String(data.status).toLowerCase() === 'published' ? 'published' : 'draft') : row.status;
  const sortOrder = data.sort_order != null ? Number(data.sort_order) || 0 : row.sort_order;
  db.prepare(
    `
    UPDATE team_members SET name=?, slug=?, role_title=?, bio=?, image_url=?, email=?,
      phone=?, social_url=?, status=?, sort_order=?, updated_at=datetime('now')
    WHERE id=? AND lead_id=?
  `
  ).run(name, slug, role, bio, image, email, phone, social, status, sortOrder, row.id, Number(leadId));
  return getTeamMember(db, leadId, row.id);
}

function deleteTeamMember(db, leadId, id) {
  ensureTables(db);
  const row = getTeamMember(db, leadId, id);
  if (!row) throw fail('NOT_FOUND', 'Team member not found', 404);
  db.prepare('DELETE FROM team_members WHERE id = ? AND lead_id = ?').run(row.id, Number(leadId));
  return { deleted: true, id: row.id };
}

/* ── Events ── */

// Batch 122 — an event row carries its shared-layer gallery link as
// the virtual field gallery_album_id (stored as a module_shared_refs
// row, role 'album' — see server/moduleShare.js). Reads decorate it
// dormant-safe: any failure reads as "no gallery linked", never an
// error, so event reads can never break because of the shared layer.
function decorateEventGallery(db, leadId, row) {
  if (!row) return row;
  try {
    row.gallery_album_id = require('./moduleShare').eventGalleryAlbumId(db, leadId, row.id);
  } catch {
    row.gallery_album_id = null;
  }
  return row;
}

function listEvents(db, leadId, { includeDrafts = true } = {}) {
  ensureTables(db);
  let sql = 'SELECT * FROM events WHERE lead_id = ?';
  if (!includeDrafts) sql += " AND status = 'published'";
  sql += " ORDER BY CASE WHEN starts_at = '' THEN 1 ELSE 0 END, starts_at ASC, sort_order ASC, id DESC";
  return db
    .prepare(sql)
    .all(Number(leadId))
    .map((row) => decorateItemCategories(db, leadId, 'events', decorateEventGallery(db, leadId, row)));
}

function getEvent(db, leadId, idOrSlug) {
  ensureTables(db);
  const lid = Number(leadId);
  let row;
  if (/^\d+$/.test(String(idOrSlug))) {
    row = db.prepare('SELECT * FROM events WHERE lead_id = ? AND id = ?').get(lid, Number(idOrSlug));
  } else {
    row = db.prepare('SELECT * FROM events WHERE lead_id = ? AND slug = ?').get(lid, slugify(idOrSlug));
  }
  return decorateItemCategories(db, leadId, 'events', decorateEventGallery(db, leadId, row || null));
}

function createEvent(db, leadId, data = {}) {
  ensureTables(db);
  const title = String(data.title || data.name || '').trim();
  if (!title) throw fail('VALIDATION', 'title is required');
  // Batch 122: validate the gallery link BEFORE the insert so a bad
  // album id fails the whole create instead of half-applying.
  const wantsGallery = data.gallery_album_id !== undefined;
  if (wantsGallery && Number(data.gallery_album_id) > 0) {
    require('./moduleShare').assertAlbumExists(db, leadId, Number(data.gallery_album_id));
  }
  // Batch 124: same discipline for category assignments.
  const wantsCats = assertItemCategories(db, leadId, 'events', data);
  const status = String(data.status || 'draft').toLowerCase() === 'published' ? 'published' : 'draft';
  let slug = slugify(data.slug || title, 'event');
  const exists = db.prepare('SELECT id FROM events WHERE lead_id = ? AND slug = ?').get(Number(leadId), slug);
  if (exists) slug = `${slug}-${Date.now().toString(36).slice(-4)}`;
  const info = db
    .prepare(
      `
    INSERT INTO events
      (lead_id, title, slug, description, starts_at, ends_at, location, image_url, ticket_url, status, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
    )
    .run(
      Number(leadId),
      title.slice(0, 200),
      slug,
      String(data.description || data.body || ''),
      String(data.starts_at || data.start || data.date || ''),
      String(data.ends_at || data.end || ''),
      String(data.location || data.venue || '').slice(0, 240),
      String(data.image_url || data.image || ''),
      String(data.ticket_url || data.link || data.url || ''),
      status,
      Number(data.sort_order) || 0
    );
  if (wantsGallery) {
    require('./moduleShare').applyEventGallery(db, leadId, Number(info.lastInsertRowid), data.gallery_album_id);
  }
  if (wantsCats) applyItemCategories(db, leadId, 'events', Number(info.lastInsertRowid), data);
  return getEvent(db, leadId, info.lastInsertRowid);
}

function updateEvent(db, leadId, id, data = {}) {
  ensureTables(db);
  const row = getEvent(db, leadId, id);
  if (!row) throw fail('NOT_FOUND', 'Event not found', 404);
  // Batch 122: validate the gallery link before the update lands.
  const wantsGallery = data.gallery_album_id !== undefined;
  if (wantsGallery && Number(data.gallery_album_id) > 0) {
    require('./moduleShare').assertAlbumExists(db, leadId, Number(data.gallery_album_id));
  }
  // Batch 124: same discipline for category assignments.
  const wantsCats = assertItemCategories(db, leadId, 'events', data);
  const title =
    data.title != null || data.name != null
      ? String(data.title != null ? data.title : data.name)
          .trim()
          .slice(0, 200)
      : row.title;
  let slug = row.slug;
  if (data.slug != null) {
    slug = slugify(data.slug, 'event');
    const clash = db
      .prepare('SELECT id FROM events WHERE lead_id = ? AND slug = ? AND id != ?')
      .get(Number(leadId), slug, row.id);
    if (clash) throw fail('VALIDATION', 'slug already in use');
  }
  const description =
    data.description != null || data.body != null
      ? String(data.description != null ? data.description : data.body)
      : row.description;
  const starts =
    data.starts_at != null || data.start != null || data.date != null
      ? String(data.starts_at != null ? data.starts_at : data.start != null ? data.start : data.date)
      : row.starts_at;
  const ends =
    data.ends_at != null || data.end != null ? String(data.ends_at != null ? data.ends_at : data.end) : row.ends_at;
  const location =
    data.location != null || data.venue != null
      ? String(data.location != null ? data.location : data.venue).slice(0, 240)
      : row.location;
  const image =
    data.image_url != null || data.image != null
      ? String(data.image_url != null ? data.image_url : data.image)
      : row.image_url;
  const ticket =
    data.ticket_url != null || data.link != null || data.url != null
      ? String(data.ticket_url != null ? data.ticket_url : data.link != null ? data.link : data.url)
      : row.ticket_url;
  const status =
    data.status != null ? (String(data.status).toLowerCase() === 'published' ? 'published' : 'draft') : row.status;
  const sortOrder = data.sort_order != null ? Number(data.sort_order) || 0 : row.sort_order;
  db.prepare(
    `
    UPDATE events SET title=?, slug=?, description=?, starts_at=?, ends_at=?, location=?,
      image_url=?, ticket_url=?, status=?, sort_order=?, updated_at=datetime('now')
    WHERE id=? AND lead_id=?
  `
  ).run(title, slug, description, starts, ends, location, image, ticket, status, sortOrder, row.id, Number(leadId));
  if (wantsGallery) {
    require('./moduleShare').applyEventGallery(db, leadId, row.id, data.gallery_album_id);
  }
  if (wantsCats) applyItemCategories(db, leadId, 'events', row.id, data);
  return getEvent(db, leadId, row.id);
}

function deleteEvent(db, leadId, id) {
  ensureTables(db);
  const row = getEvent(db, leadId, id);
  if (!row) throw fail('NOT_FOUND', 'Event not found', 404);
  db.prepare('DELETE FROM events WHERE id = ? AND lead_id = ?').run(row.id, Number(leadId));
  try {
    require('./moduleShare').clearRefsForConsumer(db, leadId, 'events', row.id);
  } catch {
    /* shared refs are additive — never block a delete */
  }
  clearItemCategories(db, leadId, 'events', row.id);
  return { deleted: true, id: row.id };
}

/* ── Special Offers ── */

function offerToday() {
  return new Date().toISOString().slice(0, 10);
}

function isOfferExpired(row) {
  if (!row || !row.expires_at) return false;
  return String(row.expires_at).slice(0, 10) < offerToday();
}

function withOfferFlags(row) {
  if (!row) return row;
  return { ...row, expired: isOfferExpired(row) ? 1 : 0 };
}

function normalizeOfferExpires(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) throw fail('VALIDATION', 'expires_at must be a date (YYYY-MM-DD)');
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function listOffers(db, leadId, { includeDrafts = true } = {}) {
  ensureTables(db);
  let sql = 'SELECT * FROM offers WHERE lead_id = ?';
  if (!includeDrafts) sql += " AND status = 'published'";
  sql += ' ORDER BY sort_order ASC, id DESC';
  const rows = db.prepare(sql).all(Number(leadId)).map(withOfferFlags);
  // Public lists never render expired offers; portal lists keep them (flagged).
  const visible = includeDrafts ? rows : rows.filter((r) => !r.expired);
  return decorateItemsCategories(db, leadId, 'offers', visible);
}

function getOffer(db, leadId, id) {
  ensureTables(db);
  const row = db.prepare('SELECT * FROM offers WHERE lead_id = ? AND id = ?').get(Number(leadId), Number(id));
  return decorateItemCategories(db, leadId, 'offers', withOfferFlags(row));
}

function createOffer(db, leadId, data = {}) {
  ensureTables(db);
  const title = String(data.title || data.name || '').trim();
  if (!title) throw fail('VALIDATION', 'title is required');
  // Batch 124: validate category assignments before the insert.
  const wantsCats = assertItemCategories(db, leadId, 'offers', data);
  const status = String(data.status || 'draft').toLowerCase() === 'published' ? 'published' : 'draft';
  const info = db
    .prepare(
      `
    INSERT INTO offers (lead_id, title, description, code, terms, expires_at, image_url, status, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
    )
    .run(
      Number(leadId),
      title.slice(0, 200),
      String(data.description || ''),
      String(data.code || '').slice(0, 80),
      String(data.terms || ''),
      normalizeOfferExpires(data.expires_at || data.expires || ''),
      String(data.image_url || data.image || ''),
      status,
      Number(data.sort_order) || 0
    );
  if (wantsCats) applyItemCategories(db, leadId, 'offers', Number(info.lastInsertRowid), data);
  return getOffer(db, leadId, info.lastInsertRowid);
}

function updateOffer(db, leadId, id, data = {}) {
  ensureTables(db);
  const row = getOffer(db, leadId, id);
  if (!row) throw fail('NOT_FOUND', 'Offer not found', 404);
  // Batch 124: validate category assignments before the update lands.
  const wantsCats = assertItemCategories(db, leadId, 'offers', data);
  const title = data.title != null || data.name != null ? String(data.title != null ? data.title : data.name).trim().slice(0, 200) : row.title;
  if (!title) throw fail('VALIDATION', 'title is required');
  const description = data.description != null ? String(data.description) : row.description;
  const code = data.code != null ? String(data.code).slice(0, 80) : row.code;
  const terms = data.terms != null ? String(data.terms) : row.terms;
  const expires =
    data.expires_at != null || data.expires != null
      ? normalizeOfferExpires(data.expires_at != null ? data.expires_at : data.expires)
      : row.expires_at;
  const image =
    data.image_url != null || data.image != null ? String(data.image_url != null ? data.image_url : data.image) : row.image_url;
  const status =
    data.status != null ? (String(data.status).toLowerCase() === 'published' ? 'published' : 'draft') : row.status;
  const sortOrder = data.sort_order != null ? Number(data.sort_order) || 0 : row.sort_order;
  db.prepare(
    `
    UPDATE offers SET title=?, description=?, code=?, terms=?, expires_at=?,
      image_url=?, status=?, sort_order=?, updated_at=datetime('now')
    WHERE id=? AND lead_id=?
  `
  ).run(title, description, code, terms, expires, image, status, sortOrder, row.id, Number(leadId));
  if (wantsCats) applyItemCategories(db, leadId, 'offers', row.id, data);
  return getOffer(db, leadId, row.id);
}

function deleteOffer(db, leadId, id) {
  ensureTables(db);
  const row = getOffer(db, leadId, id);
  if (!row) throw fail('NOT_FOUND', 'Offer not found', 404);
  db.prepare('DELETE FROM offers WHERE id = ? AND lead_id = ?').run(row.id, Number(leadId));
  clearItemCategories(db, leadId, 'offers', row.id);
  return { deleted: true, id: row.id };
}

/* ── QR Code (Batch 126) ──
 * Stored codes generated server-side with the `qrcode` package (the same
 * package/pattern as the TOTP enrollment codes and claimKit stickers —
 * no external QR APIs). Page/module targets are stored as REFERENCES and
 * resolved against the current site structure on every render, so a
 * renamed page or a re-slugged module landing never strands a printed
 * code; a target that has vanished resolves to an empty payload and the
 * surfaces render dormant-empty. v1 encodes targets directly — no
 * redirect/short-link layer and no scan analytics. */

const QR_TARGET_KINDS = ['page', 'module', 'url', 'tel', 'email', 'wifi'];
const QR_EC_LEVELS = ['L', 'M', 'Q', 'H'];
const QR_WIFI_AUTHS = ['WPA', 'WEP', 'nopass'];

function normalizeQrHex(value, fallback) {
  const v = String(value || '').trim();
  return /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : fallback;
}

function normalizeQrSize(value, fallback = 512) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(2048, Math.max(128, n));
}

/** Best-effort site palette accent for QR color defaults. */
function sitePaletteAccent(db, leadId) {
  try {
    const site = db
      .prepare('SELECT theme FROM websites WHERE lead_id = ? ORDER BY id DESC LIMIT 1')
      .get(Number(leadId));
    if (!site || !site.theme) return '';
    const theme = typeof site.theme === 'string' ? JSON.parse(site.theme) : site.theme;
    const candidates = [
      theme && theme.colors && theme.colors.primary,
      theme && theme.colors && theme.colors.accent,
      theme && theme.palette && theme.palette.primary,
      theme && theme.primary,
      theme && theme.accent,
    ];
    for (const c of candidates) {
      const hex = normalizeQrHex(c, '');
      if (hex) return hex;
    }
  } catch {
    /* palette is a default, never a blocker */
  }
  return '';
}

/** The site's public origin (custom domain wins, else the preview URL). */
function siteBaseUrl(db, leadId) {
  let site = null;
  try {
    site = db
      .prepare('SELECT custom_domain, preview_url FROM websites WHERE lead_id = ? ORDER BY id DESC LIMIT 1')
      .get(Number(leadId));
  } catch {
    return '';
  }
  if (!site) return '';
  const domain = String(site.custom_domain || '').trim();
  if (domain) return (/^https?:\/\//i.test(domain) ? domain : `https://${domain}`).replace(/\/+$/, '');
  return String(site.preview_url || '')
    .trim()
    .replace(/\/+$/, '');
}

function sitePageUrl(db, leadId, code) {
  const pages = listSitePages(db, leadId);
  const want = normalizeSlug(code.target_ref);
  let page = pages.find((p) => p.slug === want);
  if (!page && code.target_title) {
    // Printed-code insurance: the slug is a page's only platform
    // identity, so a slug rename would strand every stored reference
    // (module embeds carry the same property). When the exact slug is
    // gone, fall back to the page's title snapshot — a rename that
    // keeps the page's title still resolves; an ambiguous match or a
    // renamed title resolves dormant rather than pointing at the
    // wrong page.
    const titled = pages.filter((p) => p.title && p.title === code.target_title);
    if (titled.length === 1) page = titled[0];
  }
  if (!page) return '';
  const base = siteBaseUrl(db, leadId);
  if (!base) return '';
  if (!page.slug || page.slug === 'index' || page.slug === 'home') return `${base}/`;
  return `${base}/${page.slug}`;
}

function moduleLandingUrl(db, leadId, moduleType) {
  const type = String(moduleType || '');
  if (!MODULE_TYPES.includes(type) || type === 'qrcode') return '';
  const embed = getEmbedRow(db, leadId, type);
  if (!embed || !moduleEmbedActive(embed)) return '';
  const base = siteBaseUrl(db, leadId);
  if (!base) return '';
  const slug = embed.target_page_slug || MODULE_META[type].defaultSlug || '';
  if (!slug) return `${base}/`;
  return `${base}/${slug}`;
}

/** Pages + attached module landings a code may point at (picker data). */
function listQrCodeTargets(db, leadId) {
  ensureTables(db);
  const modules = [];
  for (const type of MODULE_TYPES) {
    if (type === 'qrcode') continue;
    const embed = getEmbedRow(db, leadId, type);
    if (!embed) continue;
    modules.push({
      type,
      label: MODULE_META[type].label,
      slug: embed.target_page_slug || MODULE_META[type].defaultSlug || '',
      active: moduleEmbedActive(embed),
    });
  }
  return { pages: listSitePages(db, leadId), modules };
}

function escapeWifiField(value) {
  return String(value == null ? '' : value).replace(/([\\;,":])/g, '\\$1');
}

/** The exact string a code encodes, resolved fresh from current state. */
function buildQrPayload(db, leadId, code) {
  if (!code) return '';
  const kind = String(code.target_kind || '');
  if (kind === 'page') return sitePageUrl(db, leadId, code);
  if (kind === 'module') return moduleLandingUrl(db, leadId, code.target_ref);
  if (kind === 'url') return String(code.target_ref || '');
  if (kind === 'tel') return code.target_ref ? `tel:${code.target_ref}` : '';
  if (kind === 'email') return code.target_ref ? `mailto:${code.target_ref}` : '';
  if (kind === 'wifi') {
    const ssid = String(code.wifi_ssid || '');
    if (!ssid) return '';
    const auth = QR_WIFI_AUTHS.includes(code.wifi_auth) ? code.wifi_auth : 'WPA';
    const parts = [`T:${auth}`, `S:${escapeWifiField(ssid)}`];
    if (auth !== 'nopass') parts.push(`P:${escapeWifiField(code.wifi_password || '')}`);
    if (Number(code.wifi_hidden)) parts.push('H:true');
    return `WIFI:${parts.join(';')};;`;
  }
  return '';
}

/**
 * Full resolution for one stored code: the payload plus, for web targets,
 * the URL a scanner lands on, and — once the QR Code module itself is
 * attached (it owns the public token) — the public image route other
 * surfaces (shared layer, newsletter, flyers) can pull the code through.
 */
function resolveQrCode(db, leadId, code) {
  ensureTables(db);
  const payload = buildQrPayload(db, leadId, code);
  const target_url = ['page', 'module', 'url'].includes(code.target_kind) ? payload : '';
  let image_url = '';
  if (payload) {
    const embed = getEmbedRow(db, leadId, 'qrcode');
    if (embed && embed.public_token) {
      image_url = `${appBaseUrl()}/api/v1/modules/public/${embed.public_token}/qrcode/${code.id}.png`;
    }
  }
  return { payload, target_url, image_url };
}

async function renderQrCodeImage(payload, code, { format = 'png', width } = {}) {
  const opts = {
    errorCorrectionLevel: QR_EC_LEVELS.includes(code.ec_level) ? code.ec_level : 'M',
    margin: 1,
    width: normalizeQrSize(width != null ? width : code.size),
    color: {
      dark: normalizeQrHex(code.fg_color, '#111111'),
      light: normalizeQrHex(code.bg_color, '#ffffff'),
    },
  };
  if (format === 'svg') {
    return { body: await QRCode.toString(String(payload), { ...opts, type: 'svg' }), contentType: 'image/svg+xml' };
  }
  return { body: await QRCode.toBuffer(String(payload), { ...opts, type: 'png' }), contentType: 'image/png' };
}

/** Small inline preview for portal lists (data URL; '' when dormant). */
async function qrCodePreviewDataUrl(db, leadId, code, width = 200) {
  const { payload } = resolveQrCode(db, leadId, code);
  if (!payload) return '';
  const { body } = await renderQrCodeImage(payload, code, { format: 'png', width });
  return `data:image/png;base64,${Buffer.from(body).toString('base64')}`;
}

function qrCodeRowView(row) {
  if (!row) return null;
  const kind = String(row.target_kind || '');
  return {
    ...row,
    wifi_hidden: Number(row.wifi_hidden) ? 1 : 0,
    target_page: kind === 'page' ? row.target_ref : '',
    target_module: kind === 'module' ? row.target_ref : '',
    target_value: ['url', 'tel', 'email'].includes(kind) ? row.target_ref : '',
  };
}

function normalizeQrCodeInput(db, leadId, data = {}, existing = null) {
  const kind = String(data.target_kind || (existing && existing.target_kind) || 'page')
    .trim()
    .toLowerCase();
  if (!QR_TARGET_KINDS.includes(kind)) {
    throw fail('VALIDATION', `target_kind must be one of: ${QR_TARGET_KINDS.join(', ')}`);
  }
  const keepRef = existing && existing.target_kind === kind ? existing.target_ref : '';
  let target_ref = '';
  let target_title = '';
  let wifi_ssid = '';
  let wifi_auth = 'WPA';
  let wifi_password = '';
  let wifi_hidden = 0;
  if (kind === 'page') {
    const raw = data.target_page != null ? data.target_page : data.target_ref != null ? data.target_ref : keepRef;
    const page = listSitePages(db, leadId).find((p) => p.slug === normalizeSlug(raw));
    if (!page) throw fail('VALIDATION', `That page is not part of this site: ${String(raw || '')}`);
    target_ref = page.slug;
    target_title = page.title || '';
  } else if (kind === 'module') {
    const raw = String(data.target_module != null ? data.target_module : data.target_ref != null ? data.target_ref : keepRef || '')
      .trim()
      .toLowerCase();
    if (!MODULE_TYPES.includes(raw) || raw === 'qrcode') {
      throw fail('VALIDATION', `Unknown module target: ${raw}`);
    }
    if (!getEmbedRow(db, leadId, raw)) {
      throw fail('VALIDATION', `The ${MODULE_META[raw].label} module is not added to this site yet`);
    }
    target_ref = raw;
  } else if (kind === 'url') {
    const raw = String(data.target_value != null ? data.target_value : data.target_ref != null ? data.target_ref : keepRef || '').trim();
    let parsed = null;
    try {
      parsed = new URL(raw);
    } catch {
      parsed = null;
    }
    if (!parsed || !/^https?:$/.test(parsed.protocol)) {
      throw fail('VALIDATION', 'Enter a full URL starting with https://');
    }
    target_ref = raw;
  } else if (kind === 'tel') {
    const raw = String(data.target_value != null ? data.target_value : data.target_ref != null ? data.target_ref : keepRef || '');
    const stripped = raw.replace(/[^\d+]/g, '');
    const normalized = (stripped.startsWith('+') ? '+' : '') + stripped.replace(/\+/g, '');
    if (!/^\+?\d{5,20}$/.test(normalized)) throw fail('VALIDATION', 'Enter a valid phone number');
    target_ref = normalized;
  } else if (kind === 'email') {
    const raw = String(data.target_value != null ? data.target_value : data.target_ref != null ? data.target_ref : keepRef || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(raw)) throw fail('VALIDATION', 'Enter a valid email address');
    target_ref = raw;
  } else if (kind === 'wifi') {
    wifi_ssid = String(data.wifi_ssid != null ? data.wifi_ssid : existing ? existing.wifi_ssid : '').trim();
    if (!wifi_ssid) throw fail('VALIDATION', 'WiFi network name (SSID) is required');
    wifi_auth = QR_WIFI_AUTHS.includes(data.wifi_auth) ? data.wifi_auth : existing ? existing.wifi_auth : 'WPA';
    if (!QR_WIFI_AUTHS.includes(wifi_auth)) wifi_auth = 'WPA';
    // A blank password on update keeps the stored one: list responses
    // never carry the password back to the browser, so the editor's
    // empty field means "unchanged", not "cleared".
    wifi_password =
      data.wifi_password != null && String(data.wifi_password) !== ''
        ? String(data.wifi_password)
        : existing
          ? existing.wifi_password
          : '';
    const hiddenRaw = data.wifi_hidden != null ? data.wifi_hidden : existing ? existing.wifi_hidden : 0;
    wifi_hidden = hiddenRaw === true || hiddenRaw === 1 || hiddenRaw === '1' || hiddenRaw === 'true' ? 1 : 0;
  }
  return { target_kind: kind, target_ref, target_title, wifi_ssid, wifi_auth, wifi_password, wifi_hidden };
}

function listQrCodes(db, leadId, { includeDrafts = true } = {}) {
  ensureTables(db);
  const rows = db
    .prepare('SELECT * FROM module_qrcodes WHERE lead_id = ? ORDER BY sort_order ASC, id ASC')
    .all(Number(leadId));
  // Batch 126 finisher: codes carry their shared-taxonomy assignments
  // like every other consuming module's items (scope 'qrcode').
  return decorateItemsCategories(
    db,
    leadId,
    'qrcode',
    rows.filter((r) => includeDrafts || r.status === 'published').map(qrCodeRowView)
  );
}

function getQrCode(db, leadId, id) {
  ensureTables(db);
  const row = db
    .prepare('SELECT * FROM module_qrcodes WHERE id = ? AND lead_id = ?')
    .get(Number(id), Number(leadId));
  return decorateItemCategories(db, leadId, 'qrcode', qrCodeRowView(row || null));
}

function createQrCode(db, leadId, data = {}) {
  ensureTables(db);
  const name = String(data.name || data.title || '').trim();
  if (!name) throw fail('VALIDATION', 'QR code name is required');
  // Batch 126 finisher: validate category assignments before the insert.
  const wantsCats = assertItemCategories(db, leadId, 'qrcode', data);
  const target = normalizeQrCodeInput(db, leadId, data, null);
  const accent = sitePaletteAccent(db, leadId);
  const info = db
    .prepare(
      `INSERT INTO module_qrcodes
        (lead_id, name, target_kind, target_ref, target_title, wifi_ssid, wifi_auth, wifi_password, wifi_hidden,
         size, fg_color, bg_color, ec_level, status, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      Number(leadId),
      name.slice(0, 120),
      target.target_kind,
      target.target_ref,
      target.target_title,
      target.wifi_ssid,
      target.wifi_auth,
      target.wifi_password,
      target.wifi_hidden,
      normalizeQrSize(data.size),
      normalizeQrHex(data.fg_color, accent || '#111111'),
      normalizeQrHex(data.bg_color, '#ffffff'),
      QR_EC_LEVELS.includes(data.ec_level) ? data.ec_level : 'M',
      data.status === 'published' ? 'published' : 'draft',
      Number(data.sort_order) || 0
    );
  if (wantsCats) applyItemCategories(db, leadId, 'qrcode', Number(info.lastInsertRowid), data);
  return getQrCode(db, leadId, info.lastInsertRowid);
}

function updateQrCode(db, leadId, id, data = {}) {
  ensureTables(db);
  const existing = db
    .prepare('SELECT * FROM module_qrcodes WHERE id = ? AND lead_id = ?')
    .get(Number(id), Number(leadId));
  if (!existing) throw fail('NOT_FOUND', 'QR code not found', 404);
  // Batch 126 finisher: category_ids present = replace the code's
  // category set; absent = assignments untouched. Pre-flighted before
  // any mutation so a bad id fails the whole write.
  const wantsCats = assertItemCategories(db, leadId, 'qrcode', data);
  const targetTouched =
    data.target_kind != null ||
    data.target_ref != null ||
    data.target_page != null ||
    data.target_module != null ||
    data.target_value != null ||
    data.wifi_ssid != null ||
    data.wifi_auth != null ||
    data.wifi_password != null ||
    data.wifi_hidden != null;
  const target = targetTouched ? normalizeQrCodeInput(db, leadId, data, existing) : existing;
  const name = data.name != null || data.title != null ? String(data.name || data.title || '').trim() : existing.name;
  if (!name) throw fail('VALIDATION', 'QR code name is required');
  db.prepare(
    `UPDATE module_qrcodes SET
       name = ?, target_kind = ?, target_ref = ?, target_title = ?, wifi_ssid = ?, wifi_auth = ?, wifi_password = ?,
       wifi_hidden = ?, size = ?, fg_color = ?, bg_color = ?, ec_level = ?, status = ?, sort_order = ?,
       updated_at = datetime('now')
     WHERE id = ? AND lead_id = ?`
  ).run(
    name.slice(0, 120),
    target.target_kind,
    target.target_ref,
    target.target_title != null ? target.target_title : existing.target_title || '',
    target.wifi_ssid,
    target.wifi_auth,
    target.wifi_password,
    Number(target.wifi_hidden) ? 1 : 0,
    normalizeQrSize(data.size != null ? data.size : existing.size, existing.size),
    normalizeQrHex(data.fg_color, existing.fg_color),
    normalizeQrHex(data.bg_color, existing.bg_color),
    QR_EC_LEVELS.includes(data.ec_level) ? data.ec_level : existing.ec_level,
    data.status === 'published' || data.status === 'draft' ? data.status : existing.status,
    data.sort_order != null ? Number(data.sort_order) || 0 : existing.sort_order,
    existing.id,
    Number(leadId)
  );
  if (wantsCats) applyItemCategories(db, leadId, 'qrcode', existing.id, data);
  return getQrCode(db, leadId, existing.id);
}

function deleteQrCode(db, leadId, id) {
  ensureTables(db);
  const row = getQrCode(db, leadId, id);
  if (!row) throw fail('NOT_FOUND', 'QR code not found', 404);
  db.prepare('DELETE FROM module_qrcodes WHERE id = ? AND lead_id = ?').run(row.id, Number(leadId));
  // Batch 126 finisher: the code's taxonomy assignments go with it —
  // never blocks the delete.
  clearItemCategories(db, leadId, 'qrcode', row.id);
  return { deleted: true, id: row.id };
}

/** Which stored code the site module displays + its caption (embed settings). */
function getQrCodeDisplay(db, leadId) {
  ensureTables(db);
  const row = getEmbedRow(db, leadId, 'qrcode');
  if (!row) return { qrcode_id: null, caption: '' };
  const settings = parseEmbedSettings(row);
  return { qrcode_id: settings.qrcode_id != null ? settings.qrcode_id : null, caption: settings.caption || '' };
}

function updateQrCodeDisplay(db, leadId, data = {}, { workspaceId } = {}) {
  ensureTables(db);
  const row = ensureEmbed(db, leadId, 'qrcode', { workspaceId });
  let qrcodeId = data.qrcode_id != null ? Number(data.qrcode_id) || null : undefined;
  if (qrcodeId) {
    const code = getQrCode(db, leadId, qrcodeId);
    if (!code) throw fail('VALIDATION', 'That QR code does not belong to this site');
  }
  const next = writeEmbedSettings(db, row.id, {
    ...parseEmbedSettings(row),
    ...(qrcodeId !== undefined ? { qrcode_id: qrcodeId } : {}),
    ...(data.caption != null ? { caption: String(data.caption || '').slice(0, 160) } : {}),
  });
  return { qrcode_id: next.qrcode_id != null ? next.qrcode_id : null, caption: next.caption || '' };
}

/**
 * The public payload block for the QR Code module: the ONE chosen code,
 * resolved at serve time. Dormant (null) when nothing is chosen, the
 * chosen code is unpublished, or its target has vanished — the embed
 * renders nothing, never a broken image.
 */
function publicQrCodePayload(db, leadId, embedRow) {
  const settings = parseEmbedSettings(embedRow);
  if (!settings.qrcode_id) return null;
  const code = getQrCode(db, leadId, settings.qrcode_id);
  if (!code || code.status !== 'published') return null;
  const resolved = resolveQrCode(db, leadId, code);
  if (!resolved.payload) return null;
  return {
    id: code.id,
    name: code.name,
    caption: settings.caption || '',
    // Batch 134 (bug hunt): a WiFi code's resolved payload embeds the
    // network password — it must never ride this anonymous payload
    // (the Batch 126 contract: the password exists only inside the
    // server-rendered code image). The embed renderer builds the
    // block from image_url/name/caption alone, so wifi codes ship
    // an empty payload here; other kinds keep theirs (a URL/tel/
    // mailto payload is the public target itself).
    payload: code.target_kind === 'wifi' ? '' : resolved.payload,
    target_url: resolved.target_url,
    image_url: resolved.image_url,
    svg_url: resolved.image_url ? resolved.image_url.replace(/\.png$/, '.svg') : '',
  };
}

/**
 * Token + id → the published code behind the public image route. The id
 * is always resolved inside the token's own lead (strict isolation).
 */
function resolvePublicQrCode(db, token, id) {
  ensureTables(db);
  const row = db
    .prepare('SELECT * FROM site_module_embeds WHERE public_token = ?')
    .get(String(token || ''));
  if (!row || row.module_type !== 'qrcode' || !moduleEmbedActive(row)) {
    throw fail('NOT_FOUND', 'QR code not found', 404);
  }
  assertSiteNotArchived(db, row.lead_id);
  assertSiteNotSuspended(db, row.lead_id);
  const code = getQrCode(db, row.lead_id, id);
  if (!code || code.status !== 'published') throw fail('NOT_FOUND', 'QR code not found', 404);
  const resolved = resolveQrCode(db, row.lead_id, code);
  if (!resolved.payload) throw fail('NOT_FOUND', 'QR code not found', 404);
  return { leadId: row.lead_id, code, payload: resolved.payload };
}

/* ── Menu / Price List (categories + items) ── */

function listMenuCategories(db, leadId, { includeDrafts = true } = {}) {
  ensureTables(db);
  let sql = 'SELECT * FROM menu_categories WHERE lead_id = ?';
  if (!includeDrafts) sql += " AND status = 'published'";
  sql += ' ORDER BY sort_order ASC, name ASC, id ASC';
  return db.prepare(sql).all(Number(leadId));
}

function getMenuCategory(db, leadId, id) {
  ensureTables(db);
  return db.prepare('SELECT * FROM menu_categories WHERE lead_id = ? AND id = ?').get(Number(leadId), Number(id));
}

function createMenuCategory(db, leadId, data = {}) {
  ensureTables(db);
  const name = String(data.name || data.title || '').trim();
  if (!name) throw fail('VALIDATION', 'category name is required');
  const status = String(data.status || 'published').toLowerCase() === 'published' ? 'published' : 'draft';
  const info = db
    .prepare('INSERT INTO menu_categories (lead_id, name, status, sort_order) VALUES (?, ?, ?, ?)')
    .run(Number(leadId), name.slice(0, 120), status, Number(data.sort_order) || 0);
  return getMenuCategory(db, leadId, info.lastInsertRowid);
}

function ensureMenuCategory(db, leadId, name) {
  const clean = String(name || '').trim();
  if (!clean) return null;
  const existing = db
    .prepare('SELECT * FROM menu_categories WHERE lead_id = ? AND lower(name) = lower(?) ORDER BY id ASC LIMIT 1')
    .get(Number(leadId), clean.slice(0, 120));
  if (existing) return existing;
  return createMenuCategory(db, leadId, { name: clean });
}

function updateMenuCategory(db, leadId, id, data = {}) {
  ensureTables(db);
  const row = getMenuCategory(db, leadId, id);
  if (!row) throw fail('NOT_FOUND', 'Menu category not found', 404);
  const name = data.name != null || data.title != null ? String(data.name != null ? data.name : data.title).trim().slice(0, 120) : row.name;
  if (!name) throw fail('VALIDATION', 'category name is required');
  const status =
    data.status != null ? (String(data.status).toLowerCase() === 'published' ? 'published' : 'draft') : row.status;
  const sortOrder = data.sort_order != null ? Number(data.sort_order) || 0 : row.sort_order;
  db.prepare(
    "UPDATE menu_categories SET name=?, status=?, sort_order=?, updated_at=datetime('now') WHERE id=? AND lead_id=?"
  ).run(name, status, sortOrder, row.id, Number(leadId));
  return getMenuCategory(db, leadId, row.id);
}

function deleteMenuCategory(db, leadId, id) {
  ensureTables(db);
  const row = getMenuCategory(db, leadId, id);
  if (!row) throw fail('NOT_FOUND', 'Menu category not found', 404);
  // Items survive as uncategorized — deleting a heading never deletes food.
  db.prepare('UPDATE menu_items SET category_id = NULL, updated_at = datetime(\'now\') WHERE lead_id = ? AND category_id = ?').run(
    Number(leadId),
    row.id
  );
  db.prepare('DELETE FROM menu_categories WHERE id = ? AND lead_id = ?').run(row.id, Number(leadId));
  return { deleted: true, id: row.id };
}

function resolveMenuCategoryId(db, leadId, data, currentId) {
  if (data.category_id != null && data.category_id !== '') {
    const cid = Number(data.category_id);
    if (!cid) return null;
    const cat = getMenuCategory(db, leadId, cid);
    if (!cat) throw fail('VALIDATION', 'category_id does not belong to this menu');
    return cat.id;
  }
  if (data.category_name != null || data.category != null) {
    const name = String(data.category_name != null ? data.category_name : data.category || '').trim();
    if (!name) return null;
    const cat = ensureMenuCategory(db, leadId, name);
    return cat ? cat.id : null;
  }
  return currentId != null ? currentId : null;
}

function listMenuItems(db, leadId, { includeDrafts = true } = {}) {
  ensureTables(db);
  let sql = `
    SELECT mi.*, mc.name AS category_name
    FROM menu_items mi
    LEFT JOIN menu_categories mc ON mc.id = mi.category_id AND mc.lead_id = mi.lead_id
    WHERE mi.lead_id = ?`;
  if (!includeDrafts) sql += " AND mi.status = 'published'";
  sql += `
    ORDER BY CASE WHEN mi.category_id IS NULL THEN 1 ELSE 0 END,
      mc.sort_order ASC, mc.name ASC, mi.sort_order ASC, mi.id ASC`;
  return db.prepare(sql).all(Number(leadId));
}

function getMenuItem(db, leadId, id) {
  ensureTables(db);
  return db
    .prepare(
      `SELECT mi.*, mc.name AS category_name
       FROM menu_items mi
       LEFT JOIN menu_categories mc ON mc.id = mi.category_id AND mc.lead_id = mi.lead_id
       WHERE mi.lead_id = ? AND mi.id = ?`
    )
    .get(Number(leadId), Number(id));
}

function createMenuItem(db, leadId, data = {}) {
  ensureTables(db);
  const name = String(data.name || data.title || '').trim();
  if (!name) throw fail('VALIDATION', 'name is required');
  const categoryId = resolveMenuCategoryId(db, leadId, data, null);
  const status = String(data.status || 'draft').toLowerCase() === 'published' ? 'published' : 'draft';
  const info = db
    .prepare(
      `
    INSERT INTO menu_items (lead_id, category_id, name, description, price_text, tags, status, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `
    )
    .run(
      Number(leadId),
      categoryId,
      name.slice(0, 200),
      String(data.description || ''),
      String(data.price_text || data.price || '').slice(0, 80),
      String(data.tags || '').slice(0, 200),
      status,
      Number(data.sort_order) || 0
    );
  return getMenuItem(db, leadId, info.lastInsertRowid);
}

function updateMenuItem(db, leadId, id, data = {}) {
  ensureTables(db);
  const row = getMenuItem(db, leadId, id);
  if (!row) throw fail('NOT_FOUND', 'Menu item not found', 404);
  const name =
    data.name != null || data.title != null ? String(data.name != null ? data.name : data.title).trim().slice(0, 200) : row.name;
  if (!name) throw fail('VALIDATION', 'name is required');
  const categoryId = resolveMenuCategoryId(db, leadId, data, row.category_id);
  const description = data.description != null ? String(data.description) : row.description;
  const priceText =
    data.price_text != null || data.price != null
      ? String(data.price_text != null ? data.price_text : data.price).slice(0, 80)
      : row.price_text;
  const tags = data.tags != null ? String(data.tags).slice(0, 200) : row.tags;
  const status =
    data.status != null ? (String(data.status).toLowerCase() === 'published' ? 'published' : 'draft') : row.status;
  const sortOrder = data.sort_order != null ? Number(data.sort_order) || 0 : row.sort_order;
  db.prepare(
    `
    UPDATE menu_items SET category_id=?, name=?, description=?, price_text=?, tags=?,
      status=?, sort_order=?, updated_at=datetime('now')
    WHERE id=? AND lead_id=?
  `
  ).run(categoryId, name, description, priceText, tags, status, sortOrder, row.id, Number(leadId));
  return getMenuItem(db, leadId, row.id);
}

function deleteMenuItem(db, leadId, id) {
  ensureTables(db);
  const row = getMenuItem(db, leadId, id);
  if (!row) throw fail('NOT_FOUND', 'Menu item not found', 404);
  db.prepare('DELETE FROM menu_items WHERE id = ? AND lead_id = ?').run(row.id, Number(leadId));
  return { deleted: true, id: row.id };
}

/* ── Careers ── */

const CAREERS_EMPLOYMENT_TYPES = ['Full-time', 'Part-time', 'Contract', 'Seasonal'];
const CAREERS_APPLY_MODES = ['email', 'url', 'form'];

function withCareersStatus(row) {
  if (!row) return row;
  return { ...row, status: row.active ? 'active' : 'inactive' };
}

function listCareersPostings(db, leadId, { includeInactive = true } = {}) {
  ensureTables(db);
  let sql = 'SELECT * FROM careers_postings WHERE lead_id = ?';
  if (!includeInactive) sql += ' AND active = 1';
  sql += ' ORDER BY sort_order ASC, id DESC';
  return db.prepare(sql).all(Number(leadId)).map(withCareersStatus);
}

function getCareersPosting(db, leadId, id) {
  ensureTables(db);
  const row = db
    .prepare('SELECT * FROM careers_postings WHERE lead_id = ? AND id = ?')
    .get(Number(leadId), Number(id));
  return withCareersStatus(row);
}

function normalizeCareersFields(data, row = {}) {
  const pick = (key, aliases = []) => {
    if (data[key] != null) return data[key];
    for (const a of aliases) if (data[a] != null) return data[a];
    return undefined;
  };
  const out = {};
  const title = pick('title', ['name']);
  out.title = title !== undefined ? String(title).trim().slice(0, 200) : row.title || '';
  const employment = pick('employment_type', ['type']);
  if (employment !== undefined) {
    const match = CAREERS_EMPLOYMENT_TYPES.find((t) => t.toLowerCase() === String(employment).trim().toLowerCase());
    out.employment_type = match || 'Full-time';
  } else out.employment_type = row.employment_type || 'Full-time';
  const location = pick('location');
  out.location = location !== undefined ? String(location).slice(0, 200) : row.location || '';
  const description = pick('description', ['body']);
  out.description = description !== undefined ? String(description) : row.description || '';
  const mode = pick('apply_mode');
  if (mode !== undefined) {
    const m = String(mode).trim().toLowerCase();
    out.apply_mode = CAREERS_APPLY_MODES.includes(m) ? m : 'email';
  } else out.apply_mode = row.apply_mode || 'email';
  const target = pick('apply_target', ['apply_url', 'apply_email']);
  out.apply_target = target !== undefined ? String(target).trim().slice(0, 500) : row.apply_target || '';
  if (out.apply_mode === 'email' && out.apply_target && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.apply_target)) {
    throw fail('VALIDATION', 'apply_target must be an email address when apply_mode is email');
  }
  if (out.apply_mode === 'url' && out.apply_target && !/^https?:\/\//i.test(out.apply_target)) {
    throw fail('VALIDATION', 'apply_target must be an http(s) URL when apply_mode is url');
  }
  const activeRaw = pick('active', ['status']);
  if (activeRaw !== undefined) {
    out.active =
      activeRaw === true || activeRaw === 1 || activeRaw === '1'
        ? 1
        : typeof activeRaw === 'string' && ['active', 'published', 'true', 'yes'].includes(activeRaw.toLowerCase())
          ? 1
          : 0;
  } else out.active = row.active != null ? row.active : 1;
  const sort = pick('sort_order', ['sort']);
  out.sort_order = sort !== undefined ? Number(sort) || 0 : row.sort_order || 0;
  return out;
}

function createCareersPosting(db, leadId, data = {}) {
  ensureTables(db);
  const f = normalizeCareersFields(data);
  if (!f.title) throw fail('VALIDATION', 'title is required');
  const info = db
    .prepare(
      `
    INSERT INTO careers_postings
      (lead_id, title, employment_type, location, description, apply_mode, apply_target, active, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
    )
    .run(
      Number(leadId),
      f.title,
      f.employment_type,
      f.location,
      f.description,
      f.apply_mode,
      f.apply_target,
      f.active,
      f.sort_order
    );
  return getCareersPosting(db, leadId, info.lastInsertRowid);
}

function updateCareersPosting(db, leadId, id, data = {}) {
  ensureTables(db);
  const row = getCareersPosting(db, leadId, id);
  if (!row) throw fail('NOT_FOUND', 'Careers posting not found', 404);
  const f = normalizeCareersFields(data, row);
  if (!f.title) throw fail('VALIDATION', 'title is required');
  db.prepare(
    `
    UPDATE careers_postings SET title=?, employment_type=?, location=?, description=?,
      apply_mode=?, apply_target=?, active=?, sort_order=?, updated_at=datetime('now')
    WHERE id=? AND lead_id=?
  `
  ).run(f.title, f.employment_type, f.location, f.description, f.apply_mode, f.apply_target, f.active, f.sort_order, row.id, Number(leadId));
  return getCareersPosting(db, leadId, row.id);
}

function deleteCareersPosting(db, leadId, id) {
  ensureTables(db);
  const row = getCareersPosting(db, leadId, id);
  if (!row) throw fail('NOT_FOUND', 'Careers posting not found', 404);
  db.prepare('DELETE FROM careers_postings WHERE id = ? AND lead_id = ?').run(row.id, Number(leadId));
  return { deleted: true, id: row.id };
}

/* ── Video ── */

function parseVideoUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) throw fail('VALIDATION', 'url is required');
  let u;
  try {
    u = new URL(s);
  } catch {
    throw fail('VALIDATION', 'url must be a valid YouTube or Vimeo URL');
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const bad = () => fail('VALIDATION', 'url must be a YouTube or Vimeo video URL');
  if (host === 'youtube.com' || host === 'm.youtube.com') {
    let id = '';
    if (u.pathname === '/watch') id = u.searchParams.get('v') || '';
    else {
      const m = u.pathname.match(/^\/(?:embed|shorts|live)\/([\w-]{6,20})/);
      if (m) id = m[1];
    }
    if (!/^[\w-]{6,20}$/.test(id)) throw bad();
    return {
      provider: 'youtube',
      video_id: id,
      embed_url: `https://www.youtube-nocookie.com/embed/${id}`,
      thumbnail_url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    };
  }
  if (host === 'youtu.be') {
    const id = u.pathname.replace(/\//g, '');
    if (!/^[\w-]{6,20}$/.test(id)) throw bad();
    return {
      provider: 'youtube',
      video_id: id,
      embed_url: `https://www.youtube-nocookie.com/embed/${id}`,
      thumbnail_url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    };
  }
  if (host === 'vimeo.com') {
    const m = u.pathname.match(/\/(\d{5,})(?:\/|$)/);
    if (!m) throw bad();
    return {
      provider: 'vimeo',
      video_id: m[1],
      embed_url: `https://player.vimeo.com/video/${m[1]}`,
      thumbnail_url: '',
    };
  }
  if (host === 'player.vimeo.com') {
    const m = u.pathname.match(/^\/video\/(\d{5,})/);
    if (!m) throw bad();
    return {
      provider: 'vimeo',
      video_id: m[1],
      embed_url: `https://player.vimeo.com/video/${m[1]}`,
      thumbnail_url: '',
    };
  }
  throw bad();
}

function withVideoDerived(row) {
  if (!row) return row;
  let derived = { embed_url: '', thumbnail_url: row.thumbnail_url || '' };
  try {
    const p = parseVideoUrl(row.url);
    derived = { embed_url: p.embed_url, thumbnail_url: row.thumbnail_url || p.thumbnail_url };
    return { ...row, provider: p.provider, video_id: p.video_id, ...derived };
  } catch {
    return { ...row, ...derived };
  }
}

function listVideoItems(db, leadId, { includeDrafts = true } = {}) {
  ensureTables(db);
  let sql = 'SELECT * FROM video_items WHERE lead_id = ?';
  if (!includeDrafts) sql += " AND status = 'published'";
  sql += ' ORDER BY sort_order ASC, id DESC';
  return db.prepare(sql).all(Number(leadId)).map(withVideoDerived);
}

function getVideoItem(db, leadId, id) {
  ensureTables(db);
  const row = db.prepare('SELECT * FROM video_items WHERE lead_id = ? AND id = ?').get(Number(leadId), Number(id));
  return withVideoDerived(row);
}

function createVideoItem(db, leadId, data = {}) {
  ensureTables(db);
  const title = String(data.title || data.name || '').trim();
  if (!title) throw fail('VALIDATION', 'title is required');
  const parsed = parseVideoUrl(data.url || data.video_url || '');
  const status = String(data.status || 'draft').toLowerCase() === 'published' ? 'published' : 'draft';
  const info = db
    .prepare(
      `
    INSERT INTO video_items (lead_id, title, url, provider, video_id, description, thumbnail_url, status, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
    )
    .run(
      Number(leadId),
      title.slice(0, 200),
      String(data.url || data.video_url || '').trim(),
      parsed.provider,
      parsed.video_id,
      String(data.description || ''),
      String(data.thumbnail_url || data.thumbnail || ''),
      status,
      Number(data.sort_order) || 0
    );
  return getVideoItem(db, leadId, info.lastInsertRowid);
}

function updateVideoItem(db, leadId, id, data = {}) {
  ensureTables(db);
  const row = getVideoItem(db, leadId, id);
  if (!row) throw fail('NOT_FOUND', 'Video not found', 404);
  const title =
    data.title != null || data.name != null ? String(data.title != null ? data.title : data.name).trim().slice(0, 200) : row.title;
  if (!title) throw fail('VALIDATION', 'title is required');
  let url = row.url;
  let provider = row.provider;
  let videoId = row.video_id;
  if (data.url != null || data.video_url != null) {
    url = String(data.url != null ? data.url : data.video_url).trim();
    const parsed = parseVideoUrl(url);
    provider = parsed.provider;
    videoId = parsed.video_id;
  }
  const description = data.description != null ? String(data.description) : row.description;
  const thumbnail =
    data.thumbnail_url != null || data.thumbnail != null
      ? String(data.thumbnail_url != null ? data.thumbnail_url : data.thumbnail)
      : row.thumbnail_url;
  const status =
    data.status != null ? (String(data.status).toLowerCase() === 'published' ? 'published' : 'draft') : row.status;
  const sortOrder = data.sort_order != null ? Number(data.sort_order) || 0 : row.sort_order;
  db.prepare(
    `
    UPDATE video_items SET title=?, url=?, provider=?, video_id=?, description=?,
      thumbnail_url=?, status=?, sort_order=?, updated_at=datetime('now')
    WHERE id=? AND lead_id=?
  `
  ).run(title, url, provider, videoId, description, thumbnail, status, sortOrder, row.id, Number(leadId));
  return getVideoItem(db, leadId, row.id);
}

function deleteVideoItem(db, leadId, id) {
  ensureTables(db);
  const row = getVideoItem(db, leadId, id);
  if (!row) throw fail('NOT_FOUND', 'Video not found', 404);
  db.prepare('DELETE FROM video_items WHERE id = ? AND lead_id = ?').run(row.id, Number(leadId));
  return { deleted: true, id: row.id };
}

/* ── Instant Estimate (config + priced options + visitor requests) ──
 * One config row per lead (singleton, like booking_settings) plus a list of
 * priced options. Visitors pick options on the public page; the server ALWAYS
 * recomputes the total from stored prices on submit — client math is only a
 * display aid. In `hidden` display mode the public payload carries NO prices
 * at all, so the total is not derivable from the page: the server computes
 * and stores it, and the visitor only hears "we'll send your estimate".
 * Requests land in LeadScout through portalContacts.captureFromEstimate —
 * the same dedupe funnel form submissions and bookings use. */

const ESTIMATE_DISPLAY_MODES = ['exact', 'range', 'hidden'];
const ESTIMATE_INPUT_TYPES = ['checkbox', 'select', 'quantity'];
const ESTIMATE_REQUEST_STATUSES = ['new', 'contacted', 'closed'];
const ESTIMATE_DEFAULT_DISCLAIMER =
  'This instant estimate is a ballpark for planning purposes only — it is not a quote. Your final price will be confirmed after we review your project details.';
const ESTIMATE_DEFAULT_SUBMIT_LABEL = 'Send my estimate';
const MAX_MONEY_CENTS = 1000000000; // $10,000,000 sanity cap

function parseMoneyCents(dollarsValue, centsValue) {
  if (centsValue != null && centsValue !== '') {
    const c = Math.round(Number(centsValue));
    if (!Number.isFinite(c) || c < 0 || c > MAX_MONEY_CENTS) {
      throw fail('VALIDATION', 'price must be between $0 and $10,000,000');
    }
    return c;
  }
  if (dollarsValue == null || dollarsValue === '') return null;
  const n = Number(String(dollarsValue).replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n)) throw fail('VALIDATION', 'price must be a number');
  const c = Math.round(n * 100);
  if (c < 0 || c > MAX_MONEY_CENTS) {
    throw fail('VALIDATION', 'price must be between $0 and $10,000,000');
  }
  return c;
}

function normalizeEstimateMode(value, fallback = 'exact') {
  const m = String(value || '')
    .trim()
    .toLowerCase();
  return ESTIMATE_DISPLAY_MODES.includes(m) ? m : fallback;
}

function getEstimateConfig(db, leadId) {
  ensureTables(db);
  const id = Number(leadId);
  let row = db.prepare('SELECT * FROM estimate_configs WHERE lead_id = ?').get(id);
  if (!row) {
    db.prepare(
      `INSERT INTO estimate_configs (lead_id, disclaimer, submit_label) VALUES (?, ?, ?)`
    ).run(id, ESTIMATE_DEFAULT_DISCLAIMER, ESTIMATE_DEFAULT_SUBMIT_LABEL);
    row = db.prepare('SELECT * FROM estimate_configs WHERE lead_id = ?').get(id);
  }
  return { ...row, price_label: formatPrice(row.base_price_cents) };
}

function updateEstimateConfig(db, leadId, data = {}) {
  ensureTables(db);
  const row = getEstimateConfig(db, leadId);
  const title = data.title != null ? String(data.title).trim().slice(0, 200) : row.title;
  const intro = data.intro != null ? String(data.intro).slice(0, 2000) : row.intro;
  const serviceLabel =
    data.service_label != null || data.serviceLabel != null
      ? String(data.service_label != null ? data.service_label : data.serviceLabel)
          .trim()
          .slice(0, 200)
      : row.service_label;
  let baseCents = row.base_price_cents;
  if (data.base_price_cents != null || data.base_price != null || data.basePrice != null) {
    const parsed = parseMoneyCents(
      data.base_price != null ? data.base_price : data.basePrice,
      data.base_price_cents
    );
    baseCents = parsed != null ? parsed : 0;
  }
  const mode =
    data.display_mode != null || data.displayMode != null
      ? normalizeEstimateMode(data.display_mode != null ? data.display_mode : data.displayMode, row.display_mode)
      : row.display_mode;
  let rangePercent = row.range_percent;
  if (data.range_percent != null || data.rangePercent != null) {
    rangePercent = Math.round(Number(data.range_percent != null ? data.range_percent : data.rangePercent));
    if (!Number.isFinite(rangePercent) || rangePercent < 0) rangePercent = 0;
    if (rangePercent > 100) rangePercent = 100;
  }
  const disclaimer = data.disclaimer != null ? String(data.disclaimer).slice(0, 1000) : row.disclaimer;
  let submitLabel =
    data.submit_label != null || data.submitLabel != null
      ? String(data.submit_label != null ? data.submit_label : data.submitLabel)
          .trim()
          .slice(0, 80)
      : row.submit_label;
  if (!submitLabel) submitLabel = ESTIMATE_DEFAULT_SUBMIT_LABEL;
  db.prepare(
    `
    UPDATE estimate_configs
    SET title = ?, intro = ?, service_label = ?, base_price_cents = ?, display_mode = ?,
        range_percent = ?, disclaimer = ?, submit_label = ?, updated_at = datetime('now')
    WHERE lead_id = ?
  `
  ).run(title, intro, serviceLabel, baseCents, mode, rangePercent, disclaimer, submitLabel, Number(leadId));
  return getEstimateConfig(db, leadId);
}

function normalizeEstimateChoices(raw) {
  let list = [];
  if (Array.isArray(raw)) {
    list = raw;
  } else if (typeof raw === 'string' && raw.trim()) {
    const s = raw.trim();
    if (s.startsWith('[')) {
      try {
        const parsed = JSON.parse(s);
        if (Array.isArray(parsed)) list = parsed;
      } catch {
        list = [];
      }
    }
    if (!list.length) {
      list = s
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const idx = line.lastIndexOf('|');
          if (idx > 0) return { label: line.slice(0, idx).trim(), price: line.slice(idx + 1).trim() };
          return { label: line, price: null };
        });
    }
  }
  return list
    .slice(0, 50)
    .map((c) => {
      const label = String((c && (c.label != null ? c.label : c.name)) || '')
        .trim()
        .slice(0, 120);
      if (!label) return null;
      const cents = parseMoneyCents(c && c.price, c && (c.price_cents != null ? c.price_cents : c.priceCents));
      return { label, price_cents: cents != null ? cents : 0 };
    })
    .filter(Boolean);
}

function parseEstimateChoicesJson(json) {
  try {
    const parsed = JSON.parse(String(json || '[]'));
    return Array.isArray(parsed) ? normalizeEstimateChoices(parsed) : [];
  } catch {
    return [];
  }
}

function withEstimateOptionShape(row) {
  if (!row) return row;
  const choices = parseEstimateChoicesJson(row.choices_json);
  return {
    ...row,
    choices,
    choices_text: choices.map((c) => `${c.label} | ${(c.price_cents / 100).toFixed(2)}`).join('\n'),
    price_label: formatPrice(row.price_cents),
    price: row.price_cents / 100,
    status: row.active ? 'active' : 'inactive',
  };
}

function listEstimateOptions(db, leadId, { includeInactive = true } = {}) {
  ensureTables(db);
  let sql = 'SELECT * FROM estimate_options WHERE lead_id = ?';
  if (!includeInactive) sql += ' AND active = 1';
  sql += ' ORDER BY sort_order ASC, id ASC';
  return db.prepare(sql).all(Number(leadId)).map(withEstimateOptionShape);
}

function getEstimateOption(db, leadId, id) {
  ensureTables(db);
  const row = db
    .prepare('SELECT * FROM estimate_options WHERE lead_id = ? AND id = ?')
    .get(Number(leadId), Number(id));
  return withEstimateOptionShape(row);
}

function normalizeEstimateOptionFields(data, row = {}) {
  const label =
    data.label != null || data.title != null || data.name != null
      ? String(data.label != null ? data.label : data.title != null ? data.title : data.name)
          .trim()
          .slice(0, 200)
      : row.label || '';
  if (!label) throw fail('VALIDATION', 'label is required');
  const inputType =
    data.input_type != null || data.inputType != null
      ? String(data.input_type != null ? data.input_type : data.inputType)
          .trim()
          .toLowerCase()
      : row.input_type || 'checkbox';
  if (!ESTIMATE_INPUT_TYPES.includes(inputType)) {
    throw fail('VALIDATION', `input_type must be one of: ${ESTIMATE_INPUT_TYPES.join(', ')}`);
  }
  let priceCents = row.price_cents || 0;
  if (data.price_cents != null || data.price != null) {
    const parsed = parseMoneyCents(data.price, data.price_cents);
    priceCents = parsed != null ? parsed : 0;
  }
  let choices = row.choices_json != null ? parseEstimateChoicesJson(row.choices_json) : [];
  if (data.choices !== undefined || data.choices_text !== undefined || data.choicesText !== undefined) {
    choices = normalizeEstimateChoices(
      data.choices !== undefined ? data.choices : data.choices_text !== undefined ? data.choices_text : data.choicesText
    );
  }
  if (inputType === 'select' && !choices.length) {
    throw fail('VALIDATION', 'a select option needs at least one choice (one per line: Label | price)');
  }
  if (inputType !== 'select') choices = [];
  let active = row.active == null ? 1 : row.active;
  if (data.active != null) active = data.active ? 1 : 0;
  else if (data.status != null) active = String(data.status).toLowerCase() === 'active' ? 1 : 0;
  const sortOrder = data.sort_order != null ? Number(data.sort_order) || 0 : row.sort_order || 0;
  return { label, input_type: inputType, price_cents: priceCents, choices, active, sort_order: sortOrder };
}

function createEstimateOption(db, leadId, data = {}) {
  ensureTables(db);
  const f = normalizeEstimateOptionFields(data);
  const info = db
    .prepare(
      `
    INSERT INTO estimate_options (lead_id, label, price_cents, input_type, choices_json, active, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `
    )
    .run(Number(leadId), f.label, f.price_cents, f.input_type, JSON.stringify(f.choices), f.active, f.sort_order);
  return getEstimateOption(db, leadId, info.lastInsertRowid);
}

function updateEstimateOption(db, leadId, id, data = {}) {
  ensureTables(db);
  const row = db
    .prepare('SELECT * FROM estimate_options WHERE lead_id = ? AND id = ?')
    .get(Number(leadId), Number(id));
  if (!row) throw fail('NOT_FOUND', 'Estimate option not found', 404);
  const f = normalizeEstimateOptionFields(data, row);
  db.prepare(
    `
    UPDATE estimate_options
    SET label = ?, price_cents = ?, input_type = ?, choices_json = ?, active = ?, sort_order = ?,
        updated_at = datetime('now')
    WHERE id = ? AND lead_id = ?
  `
  ).run(f.label, f.price_cents, f.input_type, JSON.stringify(f.choices), f.active, f.sort_order, row.id, Number(leadId));
  return getEstimateOption(db, leadId, row.id);
}

function deleteEstimateOption(db, leadId, id) {
  ensureTables(db);
  const row = getEstimateOption(db, leadId, id);
  if (!row) throw fail('NOT_FOUND', 'Estimate option not found', 404);
  db.prepare('DELETE FROM estimate_options WHERE id = ? AND lead_id = ?').run(row.id, Number(leadId));
  return { deleted: true, id: row.id };
}

/**
 * Authoritative estimate math. Selections reference stored options only;
 * unknown or inactive option ids are rejected. Select options always
 * contribute exactly one choice (default: the first) — that is the module's
 * semantic (e.g. size: Small +$0 / Large +$50).
 */
function computeEstimate(db, leadId, selections) {
  const config = getEstimateConfig(db, leadId);
  const options = listEstimateOptions(db, leadId, { includeInactive: false });
  const byId = new Map(options.map((o) => [Number(o.id), o]));
  let total = Number(config.base_price_cents) || 0;
  const snapshot = [];
  const seen = new Set();
  const list = Array.isArray(selections) ? selections.slice(0, 100) : [];
  for (const sel of list) {
    if (!sel || typeof sel !== 'object') continue;
    const id = Number(sel.option_id != null ? sel.option_id : sel.optionId != null ? sel.optionId : sel.id);
    const opt = byId.get(id);
    if (!opt) throw fail('VALIDATION', 'An option you picked is no longer available');
    if (seen.has(id)) continue;
    seen.add(id);
    if (opt.input_type === 'checkbox') {
      const on = sel.checked === true || sel.checked === 1 || sel.checked === 'true' || !!sel.selected;
      if (!on) continue;
      snapshot.push({
        option_id: opt.id,
        label: opt.label,
        input_type: 'checkbox',
        quantity: 1,
        choice_label: '',
        unit_price_cents: opt.price_cents,
        line_total_cents: opt.price_cents,
      });
      total += opt.price_cents;
    } else if (opt.input_type === 'quantity') {
      let qty = Math.floor(Number(sel.quantity != null ? sel.quantity : sel.qty));
      if (!Number.isFinite(qty) || qty < 0) qty = 0;
      if (qty > 99) qty = 99;
      if (!qty) continue;
      snapshot.push({
        option_id: opt.id,
        label: opt.label,
        input_type: 'quantity',
        quantity: qty,
        choice_label: '',
        unit_price_cents: opt.price_cents,
        line_total_cents: qty * opt.price_cents,
      });
      total += qty * opt.price_cents;
    } else if (opt.input_type === 'select') {
      const choices = opt.choices || [];
      let idx = Number(sel.choice_index != null ? sel.choice_index : sel.choiceIndex);
      if (sel.choice_label != null || sel.choiceLabel != null) {
        const wanted = String(sel.choice_label != null ? sel.choice_label : sel.choiceLabel);
        const found = choices.findIndex((c) => c.label === wanted);
        if (found >= 0) idx = found;
      }
      if (!Number.isInteger(idx) || idx < 0) idx = 0;
      if (idx >= choices.length) throw fail('VALIDATION', `Please pick an option for “${opt.label}”`);
      const choice = choices[idx];
      snapshot.push({
        option_id: opt.id,
        label: opt.label,
        input_type: 'select',
        quantity: 1,
        choice_label: choice.label,
        unit_price_cents: choice.price_cents,
        line_total_cents: choice.price_cents,
      });
      total += choice.price_cents;
    }
  }
  // Selects always contribute exactly one choice, even if the client omitted them.
  for (const opt of options) {
    if (opt.input_type !== 'select' || seen.has(opt.id)) continue;
    const choice = (opt.choices || [])[0];
    if (!choice) continue;
    snapshot.push({
      option_id: opt.id,
      label: opt.label,
      input_type: 'select',
      quantity: 1,
      choice_label: choice.label,
      unit_price_cents: choice.price_cents,
      line_total_cents: choice.price_cents,
    });
    total += choice.price_cents;
  }
  return { config, total_cents: total, snapshot };
}

function estimateRangeBounds(totalCents, rangePercent) {
  const p = Math.min(100, Math.max(0, Number(rangePercent) || 0));
  return {
    low_cents: Math.floor((totalCents * (100 - p)) / 100),
    high_cents: Math.ceil((totalCents * (100 + p)) / 100),
  };
}

/** Public-safe estimate payload. Hidden mode strips EVERY price. */
function publicEstimatePayload(db, leadId) {
  const config = getEstimateConfig(db, leadId);
  const hidden = config.display_mode === 'hidden';
  const options = listEstimateOptions(db, leadId, { includeInactive: false }).map((o) => {
    const base = { id: o.id, label: o.label, input_type: o.input_type, sort_order: o.sort_order };
    if (hidden) {
      base.choices = (o.choices || []).map((c) => ({ label: c.label }));
    } else {
      base.price_cents = o.price_cents;
      base.price_label = o.price_label;
      base.choices = (o.choices || []).map((c) => ({
        label: c.label,
        price_cents: c.price_cents,
        price_label: formatPrice(c.price_cents),
      }));
    }
    return base;
  });
  const cfg = {
    title: config.title,
    service_label: config.service_label,
    intro: config.intro,
    display_mode: config.display_mode,
    range_percent: config.range_percent,
    disclaimer: config.disclaimer,
    submit_label: config.submit_label || ESTIMATE_DEFAULT_SUBMIT_LABEL,
  };
  if (!hidden) {
    cfg.base_price_cents = config.base_price_cents;
    cfg.base_price_label = formatPrice(config.base_price_cents);
  }
  return { config: cfg, options };
}

function withEstimateRequestShape(row) {
  if (!row) return row;
  let selections = [];
  try {
    const parsed = JSON.parse(String(row.selections_json || '[]'));
    if (Array.isArray(parsed)) selections = parsed;
  } catch {
    selections = [];
  }
  return { ...row, selections, estimate_label: formatPrice(row.estimate_cents) };
}

function listEstimateRequests(db, leadId, { limit = 50 } = {}) {
  ensureTables(db);
  const lim = Math.min(200, Math.max(1, Number(limit) || 50));
  return db
    .prepare('SELECT * FROM estimate_requests WHERE lead_id = ? ORDER BY id DESC LIMIT ?')
    .all(Number(leadId), lim)
    .map(withEstimateRequestShape);
}

function getEstimateRequest(db, leadId, id) {
  ensureTables(db);
  const row = db
    .prepare('SELECT * FROM estimate_requests WHERE lead_id = ? AND id = ?')
    .get(Number(leadId), Number(id));
  return withEstimateRequestShape(row);
}

function updateEstimateRequestStatus(db, leadId, id, status) {
  ensureTables(db);
  const row = getEstimateRequest(db, leadId, id);
  if (!row) throw fail('NOT_FOUND', 'Estimate request not found', 404);
  const s = String(status || '')
    .trim()
    .toLowerCase();
  if (!ESTIMATE_REQUEST_STATUSES.includes(s)) {
    throw fail('VALIDATION', `status must be one of: ${ESTIMATE_REQUEST_STATUSES.join(', ')}`);
  }
  db.prepare(
    `UPDATE estimate_requests SET status = ?, updated_at = datetime('now') WHERE id = ? AND lead_id = ?`
  ).run(s, row.id, Number(leadId));
  return getEstimateRequest(db, leadId, row.id);
}

/** Batch 45: remove the LeadScout timeline event(s) referencing a module
 * row being deleted (the contact itself is always preserved). The events
 * table/columns are owned by portalContacts and may not exist yet on a
 * bare DB, so absence is a no-op, never an error. */
function deleteLeadScoutEventsByRef(db, column, refId) {
  const allowed = [
    'submission_id',
    'booking_id',
    'estimate_request_id',
    'call_log_id',
    'newsletter_subscriber_id',
    'photo_submission_id',
    // Batch 131: comment captures ref their comment row.
    'comment_id',
  ];
  if (!allowed.includes(column)) return 0;
  const t = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'leadscout_events'").get();
  if (!t) return 0;
  const cols = db
    .prepare('PRAGMA table_info(leadscout_events)')
    .all()
    .map((c) => String(c.name || ''));
  if (!cols.includes(column)) return 0;
  const info = db.prepare(`DELETE FROM leadscout_events WHERE ${column} = ?`).run(Number(refId));
  return Number(info.changes || 0);
}

function deleteEstimateRequest(db, leadId, id) {
  ensureTables(db);
  const row = getEstimateRequest(db, leadId, id);
  if (!row) throw fail('NOT_FOUND', 'Estimate request not found', 404);
  db.prepare('DELETE FROM estimate_requests WHERE id = ? AND lead_id = ?').run(row.id, Number(leadId));
  deleteLeadScoutEventsByRef(db, 'estimate_request_id', row.id);
  return { deleted: true, id: row.id };
}

function createEstimateRequest(db, leadId, data = {}) {
  ensureTables(db);
  const name = String(data.name || data.customer_name || data.customerName || '').trim();
  const email = String(data.email || data.customer_email || data.customerEmail || '').trim();
  const phone = String(data.phone || data.customer_phone || data.customerPhone || '').trim();
  if (!name) throw fail('VALIDATION', 'name is required');
  if (!email && !phone) throw fail('VALIDATION', 'email or phone is required');
  const { config, total_cents, snapshot } = computeEstimate(
    db,
    leadId,
    data.selections || data.options || []
  );
  const info = db
    .prepare(
      `
    INSERT INTO estimate_requests
      (lead_id, name, email, phone, notes, selections_json, estimate_cents, display_mode, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new')
  `
    )
    .run(
      Number(leadId),
      name.slice(0, 200),
      email.slice(0, 240),
      phone.slice(0, 60),
      String(data.notes || '').slice(0, 2000),
      JSON.stringify(snapshot).slice(0, 8000),
      total_cents,
      config.display_mode
    );
  const request = getEstimateRequest(db, leadId, info.lastInsertRowid);
  try {
    const portalContacts = require('./portalContacts');
    const cap = portalContacts.captureFromEstimate(db, {
      leadId,
      request,
      pageSlug: data.page_slug || data.pageSlug || '',
    });
    if (cap && cap.contact && cap.contact.id) {
      db.prepare('UPDATE estimate_requests SET contact_id = ? WHERE id = ?').run(cap.contact.id, request.id);
      request.contact_id = cap.contact.id;
    }
  } catch (e) {
    console.warn('[siteModules] LeadScout estimate capture failed:', e.message || e);
  }
  return request;
}

function createPublicEstimateRequestByToken(db, token, data = {}, opts = {}) {
  ensureTables(db);
  const row = db
    .prepare('SELECT * FROM site_module_embeds WHERE public_token = ? AND published = 1')
    .get(String(token || ''));
  if (!row || row.module_type !== 'estimate') {
    throw fail('NOT_FOUND', 'Estimate module not found', 404);
  }
  assertSiteNotArchived(db, row.lead_id);
  assertSiteNotSuspended(db, row.lead_id);
  assertMemberAccessForEmbed(db, row, opts);
  const request = createEstimateRequest(db, row.lead_id, data);
  const hidden = request.display_mode === 'hidden';
  const pubRequest = { id: request.id, display_mode: request.display_mode };
  if (!hidden) {
    pubRequest.estimate_cents = request.estimate_cents;
    pubRequest.estimate_label = request.estimate_label;
    if (request.display_mode === 'range') {
      const config = getEstimateConfig(db, row.lead_id);
      const bounds = estimateRangeBounds(request.estimate_cents, config.range_percent);
      pubRequest.range_low_cents = bounds.low_cents;
      pubRequest.range_high_cents = bounds.high_cents;
      pubRequest.range_low_label = formatPrice(bounds.low_cents);
      pubRequest.range_high_label = formatPrice(bounds.high_cents);
    }
  }
  return {
    embed: publicEmbed(row),
    request: pubRequest,
    message: hidden
      ? 'Thanks — your request is in. We will review it and send your estimate shortly.'
      : 'Your estimate is ready — the business has your details and will confirm the final price.',
  };
}

/* ── Photo Capture (Batch 125) ───────────────────────────────────────
 * Visitors send the business a photo from the public site — device
 * camera or file upload — with their name and a phone or email. The
 * photo bytes land through the SAME module-asset pipeline every other
 * module image uses (portalSiteEdits.applyModuleAssetUpload: content
 * sniff, ~5MB cap, WebP optimization, site export folder); this
 * section owns the config, the moderated submission inbox and every
 * read the rest of the platform makes.
 *
 * Moderation is the whole point: a submission is `pending` until the
 * owner approves it. Pending and rejected photos are NEVER public —
 * the public payload and the Batch 122 shared layer both read
 * approved rows only. The state machine is one-way-safe: any status
 * can move to any other status (re-approving a rejected photo is
 * allowed), and nothing outside this section decides visibility.
 *
 * Every submission also lands in LeadScout through
 * portalContacts.captureFromPhoto — the same dedupe funnel form
 * submissions, bookings, estimate requests and newsletter signups
 * use — and an approved photo can be pushed into a gallery album
 * through addGalleryImage, the gallery's own write function.
 */

const PHOTOCAPTURE_STATUSES = ['pending', 'approved', 'rejected'];
const PHOTOCAPTURE_DEFAULT_HEADING = 'Share your photo';
const PHOTOCAPTURE_DEFAULT_SUBMIT_LABEL = 'Send photo';
const PHOTOCAPTURE_DEFAULT_SUCCESS = 'Thanks — your photo is in.';
const PHOTOCAPTURE_GRID_MAX = 60;

function normalizePhotoStatus(value, fallback = 'pending') {
  const s = String(value || '')
    .trim()
    .toLowerCase();
  return PHOTOCAPTURE_STATUSES.includes(s) ? s : fallback;
}

function getPhotoCaptureConfig(db, leadId) {
  ensureTables(db);
  const id = Number(leadId);
  let row = db.prepare('SELECT * FROM photocapture_configs WHERE lead_id = ?').get(id);
  if (!row) {
    db.prepare(
      `INSERT INTO photocapture_configs (lead_id, heading, submit_label, success_message)
       VALUES (?, ?, ?, ?)`
    ).run(id, PHOTOCAPTURE_DEFAULT_HEADING, PHOTOCAPTURE_DEFAULT_SUBMIT_LABEL, PHOTOCAPTURE_DEFAULT_SUCCESS);
    row = db.prepare('SELECT * FROM photocapture_configs WHERE lead_id = ?').get(id);
  }
  return { ...row, show_approved: !!row.show_approved };
}

function updatePhotoCaptureConfig(db, leadId, data = {}) {
  ensureTables(db);
  const row = getPhotoCaptureConfig(db, leadId);
  const heading =
    data.heading != null ? String(data.heading).trim().slice(0, 200) || row.heading : row.heading;
  const intro = data.intro != null ? String(data.intro).slice(0, 2000) : row.intro;
  let submitLabel =
    data.submit_label != null || data.submitLabel != null
      ? String(data.submit_label != null ? data.submit_label : data.submitLabel)
          .trim()
          .slice(0, 80)
      : row.submit_label;
  if (!submitLabel) submitLabel = PHOTOCAPTURE_DEFAULT_SUBMIT_LABEL;
  let successMessage =
    data.success_message != null || data.successMessage != null
      ? String(data.success_message != null ? data.success_message : data.successMessage)
          .trim()
          .slice(0, 300)
      : row.success_message;
  if (!successMessage) successMessage = PHOTOCAPTURE_DEFAULT_SUCCESS;
  // The shaped config carries show_approved as a boolean; SQLite
  // binds numbers only, so normalize back to 1/0 for the write.
  let showApproved = row.show_approved ? 1 : 0;
  if (data.show_approved != null || data.showApproved != null) {
    const v = data.show_approved != null ? data.show_approved : data.showApproved;
    showApproved = v === true || v === 1 || v === '1' || v === 'true' || v === 'on' ? 1 : 0;
  }
  let gridLimit = row.grid_limit;
  if (data.grid_limit != null || data.gridLimit != null) {
    gridLimit = Math.round(Number(data.grid_limit != null ? data.grid_limit : data.gridLimit));
    if (!Number.isFinite(gridLimit) || gridLimit < 1) gridLimit = 1;
    if (gridLimit > PHOTOCAPTURE_GRID_MAX) gridLimit = PHOTOCAPTURE_GRID_MAX;
  }
  db.prepare(
    `
    UPDATE photocapture_configs
    SET heading = ?, intro = ?, submit_label = ?, success_message = ?,
        show_approved = ?, grid_limit = ?, updated_at = datetime('now')
    WHERE lead_id = ?
  `
  ).run(heading, intro, submitLabel, successMessage, showApproved, gridLimit, Number(leadId));
  return getPhotoCaptureConfig(db, leadId);
}

function withPhotoSubmissionShape(row) {
  if (!row) return row;
  return {
    ...row,
    // The display URL is the absolute public URL minted at upload
    // time; the stored site-relative src is the fallback (portal and
    // embeds both run against the site's own origin there).
    display_url: row.image_url || row.image_src || '',
    in_gallery: !!row.gallery_image_id,
  };
}

/** The visitor-field rules for a photo submission (name present,
 *  email-or-phone present, email well-formed when given) — the ONE
 *  source for the checks createPhotoSubmission enforces. The public
 *  submit route runs this BEFORE it stores the uploaded photo
 *  (Batch 132): validating only after storage left an orphaned file
 *  in the site's export for every refused submission. */
function validatePhotoSubmissionFields(data = {}) {
  const name = String(data.name || '').trim();
  const email = String(data.email || '').trim();
  const phone = String(data.phone || '').trim();
  if (!name) throw fail('VALIDATION', 'Your name is required');
  if (!email && !phone) throw fail('VALIDATION', 'Please give an email address or a phone number');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw fail('VALIDATION', 'Please enter a valid email address');
  }
}

function createPhotoSubmission(db, leadId, data = {}) {
  ensureTables(db);
  const lid = Number(leadId);
  const name = String(data.name || '').trim().slice(0, 200);
  const email = String(data.email || '').trim().slice(0, 240);
  const phone = String(data.phone || '').trim().slice(0, 60);
  const message = String(data.message || '').trim().slice(0, 2000);
  const imageUrl = String(data.image_url || data.imageUrl || '').trim().slice(0, 1000);
  const imageSrc = String(data.image_src || data.imageSrc || '').trim().slice(0, 1000);
  if (!imageUrl && !imageSrc) throw fail('VALIDATION', 'A photo is required');
  validatePhotoSubmissionFields(data);
  const info = db
    .prepare(
      `
      INSERT INTO photocapture_submissions
        (lead_id, name, email, phone, message, image_url, image_src, status, page_slug)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `
    )
    .run(lid, name, email, phone, message, imageUrl, imageSrc, String(data.page_slug || data.pageSlug || '').slice(0, 200));
  const submission = getPhotoSubmission(db, lid, Number(info.lastInsertRowid));
  // LeadScout funnel — the same capture pattern every other public
  // capture uses; capture failures are recorded inside portalContacts
  // and never fail the visitor's submission.
  try {
    require('./portalContacts').captureFromPhoto(db, {
      leadId: lid,
      submission,
      pageSlug: submission.page_slug || '',
    });
  } catch (e) {
    console.warn('[siteModules] captureFromPhoto:', e.message || e);
  }
  return submission;
}

function getPhotoSubmission(db, leadId, id) {
  ensureTables(db);
  const row = db
    .prepare('SELECT * FROM photocapture_submissions WHERE lead_id = ? AND id = ?')
    .get(Number(leadId), Number(id));
  // Batch 125 finisher: submissions carry their shared-taxonomy
  // assignments like every other consuming module's items.
  return decorateItemCategories(db, leadId, 'photocapture', withPhotoSubmissionShape(row || null));
}

function listPhotoSubmissions(db, leadId, { status = null, limit = 100, offset = 0 } = {}) {
  ensureTables(db);
  const lim = Math.min(Math.max(Math.round(Number(limit)) || 100, 1), 500);
  const off = Math.max(Math.round(Number(offset)) || 0, 0);
  let sql = 'SELECT * FROM photocapture_submissions WHERE lead_id = ?';
  const params = [Number(leadId)];
  if (status != null && String(status).trim() !== '') {
    sql += ' AND status = ?';
    params.push(normalizePhotoStatus(status, '__none__'));
  }
  sql += ' ORDER BY id DESC LIMIT ? OFFSET ?';
  params.push(lim, off);
  const rows = db.prepare(sql).all(...params).map(withPhotoSubmissionShape);
  return decorateItemsCategories(db, leadId, 'photocapture', rows);
}

function countPhotoSubmissions(db, leadId) {
  ensureTables(db);
  const rows = db
    .prepare('SELECT status, COUNT(*) AS c FROM photocapture_submissions WHERE lead_id = ? GROUP BY status')
    .all(Number(leadId));
  const counts = { pending: 0, approved: 0, rejected: 0, total: 0 };
  for (const r of rows) {
    if (PHOTOCAPTURE_STATUSES.includes(r.status)) counts[r.status] = Number(r.c) || 0;
    counts.total += Number(r.c) || 0;
  }
  return counts;
}

function updatePhotoSubmissionStatus(db, leadId, id, status, data = {}) {
  ensureTables(db);
  const existing = getPhotoSubmission(db, leadId, id);
  if (!existing) throw fail('NOT_FOUND', 'Photo submission not found', 404);
  // Batch 125 finisher — the Batch 124 write pattern, ridden on the
  // moderation write (Photo Capture's only owner-side item write):
  // category_ids present = replace the submission's category set;
  // absent = assignments untouched. The pre-flight runs BEFORE any
  // mutation so a bad id fails the whole write. A null status with
  // category_ids is a categories-only save (the portal inbox picker);
  // with neither, the historical status validation still fires.
  const hasCats = !!data && data.category_ids !== undefined;
  if (hasCats) assertItemCategories(db, leadId, 'photocapture', data);
  if (status != null) {
    const next = normalizePhotoStatus(status, '__none__');
    if (next === '__none__') {
      throw fail('VALIDATION', `status must be one of: ${PHOTOCAPTURE_STATUSES.join(', ')}`);
    }
    db.prepare(
      "UPDATE photocapture_submissions SET status = ?, updated_at = datetime('now') WHERE lead_id = ? AND id = ?"
    ).run(next, Number(leadId), Number(id));
  } else if (!hasCats) {
    throw fail('VALIDATION', `status must be one of: ${PHOTOCAPTURE_STATUSES.join(', ')}`);
  }
  if (hasCats) applyItemCategories(db, leadId, 'photocapture', existing.id, data);
  return getPhotoSubmission(db, leadId, id);
}

/** Batch 132: best-effort removal of a deleted submission's stored
 * photo file. Before this, deleting a submission removed the row but
 * left the photo in the site's export, still served at its public
 * URL — an owner's delete (e.g. of an inappropriate photo) did not
 * actually take the photo down. Only pipeline-minted module assets
 * (images/module-*) are ever touched — never an external URL or an
 * owner's own asset — and only while the photo has NOT been pushed
 * into a gallery: a pushed copy is the gallery's own image by then
 * and its file must stay. Folder resolution mirrors the upload
 * (applyModuleAssetUpload: resolveClientSite + resolveSiteExport
 * Folder), with the assetValidation candidate folders as fallback.
 * Any failure is swallowed: file cleanup never blocks the delete. */
function removeStoredPhotoFile(db, leadId, imageSrc) {
  try {
    const rel = String(imageSrc || '').replace(/\\/g, '/');
    if (!/^images\/module-[a-z0-9-]+\.(jpg|jpeg|png|webp|gif)$/i.test(rel)) return false;
    const fs = require('fs');
    const path = require('path');
    const root = require('../src/openPreview').exportRoot();
    const folders = [];
    try {
      const wsId = require('../src/assetValidation').workspaceIdFromDb(db);
      const site = require('./portalShared').resolveClientSite(db, Number(leadId));
      if (wsId && site) {
        folders.push(require('./domain').resolveSiteExportFolder(wsId, site, db));
        for (const f of require('../src/assetValidation').siteStorageFoldersForDb(db, site.id)) folders.push(f);
      }
    } catch {
      /* candidates stay empty — nothing to unlink */
    }
    for (const folder of [...new Set(folders)]) {
      if (!folder) continue;
      const abs = path.resolve(path.join(root, folder, rel));
      const back = path.relative(path.resolve(root), abs);
      if (!back || back.startsWith('..') || path.isAbsolute(back)) continue;
      if (fs.existsSync(abs)) {
        fs.unlinkSync(abs);
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

function deletePhotoSubmission(db, leadId, id) {
  ensureTables(db);
  const existing = getPhotoSubmission(db, leadId, id);
  if (!existing) throw fail('NOT_FOUND', 'Photo submission not found', 404);
  // The LeadScout event references the submission row — unlink it
  // exactly like the estimate-request delete does (Batch 45).
  deleteLeadScoutEventsByRef(db, 'photo_submission_id', existing.id);
  db.prepare('DELETE FROM photocapture_submissions WHERE lead_id = ? AND id = ?').run(
    Number(leadId),
    Number(id)
  );
  // Batch 125 finisher: the submission's taxonomy assignments go with
  // it (the categories and every other item stay) — never blocks.
  clearItemCategories(db, leadId, 'photocapture', existing.id);
  // Batch 132: the stored photo file goes with the row (unless the
  // photo was pushed into a gallery — that copy is the gallery's).
  if (!existing.gallery_image_id) removeStoredPhotoFile(db, leadId, existing.image_src);
  return { deleted: true, id: existing.id };
}

/**
 * Cross-module write, Batch 122 style: an APPROVED photo is copied
 * into a gallery album through the gallery's own write function
 * (addGalleryImage validates the album belongs to this lead), never
 * by reaching into gallery tables from here. Idempotent per
 * submission: a second push returns the row already created.
 */
function addPhotoSubmissionToGallery(db, leadId, submissionId, albumId) {
  ensureTables(db);
  const submission = getPhotoSubmission(db, leadId, submissionId);
  if (!submission) throw fail('NOT_FOUND', 'Photo submission not found', 404);
  if (submission.status !== 'approved') {
    throw fail('VALIDATION', 'Only an approved photo can be added to the gallery');
  }
  const album = getAlbum(db, leadId, albumId);
  if (!album) throw fail('NOT_FOUND', 'Gallery album not found', 404);
  if (submission.gallery_image_id) {
    const existing = db
      .prepare('SELECT * FROM gallery_images WHERE id = ? AND album_id = ?')
      .get(Number(submission.gallery_image_id), Number(album.id));
    if (existing) return { submission, image: existing, already: true };
  }
  const image = addGalleryImage(db, leadId, album.id, {
    image_url: submission.display_url,
    caption: submission.message || submission.name || '',
  });
  db.prepare(
    "UPDATE photocapture_submissions SET gallery_image_id = ?, updated_at = datetime('now') WHERE lead_id = ? AND id = ?"
  ).run(Number(image.id), Number(leadId), Number(submission.id));
  return { submission: getPhotoSubmission(db, leadId, submission.id), image, already: false };
}

/** Public-safe payload: config copy + (optionally) the approved grid.
 * Pending/rejected submissions are never included, in any mode. */
function photoCapturePublicPayload(db, leadId) {
  ensureTables(db);
  const config = getPhotoCaptureConfig(db, leadId);
  const showApproved = !!config.show_approved;
  const items = showApproved
    ? listPhotoSubmissions(db, leadId, { status: 'approved', limit: config.grid_limit }).map((s) => ({
        id: s.id,
        image_url: s.display_url,
        caption: s.message || '',
        name: s.name || '',
        created_at: s.created_at,
      }))
    : [];
  return {
    config: {
      heading: config.heading,
      intro: config.intro,
      submit_label: config.submit_label,
      success_message: config.success_message,
      show_approved: showApproved,
    },
    items,
  };
}

/**
 * Public submit by embed token. The photo BYTES are stored by the
 * caller through the module-asset pipeline first (async — image
 * optimization cannot run inside this sync withDb section); `data`
 * carries the stored { image_url, image_src } plus the visitor's
 * fields. The response is deliberately state-blind: the visitor
 * hears the same thanks regardless of moderation.
 */
function createPublicPhotoSubmissionByToken(db, token, data = {}, opts = {}) {
  ensureTables(db);
  const row = db
    .prepare('SELECT * FROM site_module_embeds WHERE public_token = ?')
    .get(String(token || ''));
  if (!row || row.module_type !== 'photocapture') {
    throw fail('NOT_FOUND', 'Photo Capture module not found', 404);
  }
  assertSiteNotArchived(db, row.lead_id);
  assertSiteNotSuspended(db, row.lead_id);
  assertMemberAccessForEmbed(db, row, opts);
  const submission = createPhotoSubmission(db, row.lead_id, data);
  const config = getPhotoCaptureConfig(db, row.lead_id);
  return {
    embed: publicEmbed(row),
    submission: { id: submission.id },
    message: config.success_message || PHOTOCAPTURE_DEFAULT_SUCCESS,
  };
}

/* ── Social Feed ─────────────────────────────────────────────────────────────
 * Automatic module — no per-item CRUD. Items come from, in priority order:
 * (1) posts BitPype itself published for this lead (social_posts, stored
 * locally — always truthful, no API dependency), and (2) when the lead has
 * a connected Meta account, that account's latest posts fetched live via
 * socialMedia.fetchRemoteFeedPosts and cached in socialfeed_cache for
 * 15 minutes. A failed or unpermitted live read falls back silently to (1):
 * the public page must never error because of Meta. The portal preview
 * tells the owner, in plain words, which sources the feed is showing. */

const SOCIALFEED_NETWORKS = ['facebook', 'instagram', 'both'];
const SOCIALFEED_LAYOUTS = ['grid', 'list'];
const SOCIALFEED_CACHE_TTL_MS = 15 * 60 * 1000;
const SOCIALFEED_TEXT_LIMIT = 280;
const SOCIALFEED_DEFAULT_MAX_POSTS = 6;
const SOCIALFEED_MAX_POSTS_CAP = 24;

function parseJsonLoose(raw, fallback) {
  try {
    const parsed = JSON.parse(String(raw || ''));
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function normalizeSocialFeedNetworks(value, fallback = 'both') {
  const v = String(value || '')
    .trim()
    .toLowerCase();
  return SOCIALFEED_NETWORKS.includes(v) ? v : fallback;
}

function normalizeSocialFeedLayout(value, fallback = 'grid') {
  const v = String(value || '')
    .trim()
    .toLowerCase();
  return SOCIALFEED_LAYOUTS.includes(v) ? v : fallback;
}

function clampSocialFeedMaxPosts(value, fallback = SOCIALFEED_DEFAULT_MAX_POSTS) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(SOCIALFEED_MAX_POSTS_CAP, n));
}

function readSocialFeedConfig(db, leadId) {
  ensureTables(db);
  const row = db.prepare('SELECT * FROM socialfeed_configs WHERE lead_id = ?').get(Number(leadId));
  if (!row) {
    return {
      lead_id: Number(leadId),
      networks: 'both',
      max_posts: SOCIALFEED_DEFAULT_MAX_POSTS,
      layout: 'grid',
      updated_at: null,
    };
  }
  return {
    ...row,
    networks: normalizeSocialFeedNetworks(row.networks),
    layout: normalizeSocialFeedLayout(row.layout),
    max_posts: clampSocialFeedMaxPosts(row.max_posts),
  };
}

function getSocialFeedConfig(db, leadId) {
  ensureTables(db);
  const id = Number(leadId);
  const existing = db.prepare('SELECT lead_id FROM socialfeed_configs WHERE lead_id = ?').get(id);
  if (!existing) {
    db.prepare('INSERT INTO socialfeed_configs (lead_id) VALUES (?)').run(id);
  }
  return readSocialFeedConfig(db, id);
}

function updateSocialFeedConfig(db, leadId, data = {}) {
  ensureTables(db);
  const row = getSocialFeedConfig(db, leadId);
  const networks =
    data.networks != null ? normalizeSocialFeedNetworks(data.networks, row.networks) : row.networks;
  const layout = data.layout != null ? normalizeSocialFeedLayout(data.layout, row.layout) : row.layout;
  const maxPosts =
    data.max_posts != null || data.maxPosts != null
      ? clampSocialFeedMaxPosts(data.max_posts != null ? data.max_posts : data.maxPosts, row.max_posts)
      : row.max_posts;
  db.prepare(
    `UPDATE socialfeed_configs SET networks = ?, max_posts = ?, layout = ?, updated_at = datetime('now') WHERE lead_id = ?`
  ).run(networks, maxPosts, layout, Number(leadId));
  return getSocialFeedConfig(db, leadId);
}

function feedTimeMs(value) {
  if (!value) return 0;
  let s = String(value).trim();
  // SQLite datetime('now') shape → ISO UTC so Date.parse is unambiguous.
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) s = `${s.replace(' ', 'T')}Z`;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : 0;
}

function truncateFeedText(text) {
  const s = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > SOCIALFEED_TEXT_LIMIT ? `${s.slice(0, SOCIALFEED_TEXT_LIMIT - 1).trimEnd()}…` : s;
}

function shapeFeedItem(raw) {
  if (!raw) return null;
  return {
    network: raw.network === 'instagram' ? 'instagram' : 'facebook',
    external_id: String(raw.external_id || ''),
    text: truncateFeedText(raw.text),
    image_url: raw.image_url ? String(raw.image_url) : null,
    permalink: raw.permalink ? String(raw.permalink) : null,
    published_at: raw.published_at || null,
    source: raw.source === 'bitpype' ? 'bitpype' : 'live',
  };
}

/** Posts BitPype itself published for this lead, expanded per platform. */
function localSocialFeedItems(db, leadId) {
  let rows = [];
  try {
    require('../src/socialMedia').ensureTables(db);
    rows = db
      .prepare(
        `SELECT * FROM social_posts WHERE lead_id = ? AND status IN ('posted','partial')
         ORDER BY published_at DESC, id DESC`
      )
      .all(Number(leadId));
  } catch (e) {
    console.warn('[siteModules] localSocialFeedItems:', e.message || e);
    return [];
  }
  const items = [];
  for (const row of rows) {
    const platforms = parseJsonLoose(row.platforms, ['facebook']);
    const results = parseJsonLoose(row.meta_results, {}) || {};
    for (const platform of Array.isArray(platforms) ? platforms : []) {
      if (platform !== 'facebook' && platform !== 'instagram') continue;
      const res = results && typeof results === 'object' ? results[platform] : null;
      // A stored per-platform result decides success; rows without one still
      // count — their status already says the post went out.
      if (res && res.ok === false) continue;
      const extId = res && res.id ? String(res.id) : '';
      items.push(
        shapeFeedItem({
          network: platform,
          external_id: extId,
          text: row.caption,
          image_url: row.image_url || null,
          permalink: platform === 'facebook' && extId ? `https://www.facebook.com/${extId}` : null,
          published_at: row.published_at || row.created_at,
          source: 'bitpype',
        })
      );
    }
  }
  return items;
}

function readSocialFeedCache(db, leadId) {
  ensureTables(db);
  const row = db.prepare('SELECT * FROM socialfeed_cache WHERE lead_id = ?').get(Number(leadId));
  if (!row) return { items: [], fetched_at: null, last_error: '' };
  let items = [];
  const parsed = parseJsonLoose(row.items_json, []);
  if (Array.isArray(parsed)) items = parsed.map(shapeFeedItem).filter(Boolean);
  return { items, fetched_at: row.fetched_at || null, last_error: row.last_error || '' };
}

function socialFeedCacheStale(db, leadId) {
  const { fetched_at } = readSocialFeedCache(db, leadId);
  if (!fetched_at) return true;
  return Date.now() - feedTimeMs(fetched_at) > SOCIALFEED_CACHE_TTL_MS;
}

const socialFeedRefreshInFlight = new Set();

/**
 * Refresh the live-posts cache for a lead. Honors the 15-minute TTL unless
 * `force`; failures keep the previous cache and are reported, never thrown.
 */
async function refreshSocialFeedRemote(db, leadId, opts = {}) {
  const id = Number(leadId);
  ensureTables(db);
  if (!opts.force && !socialFeedCacheStale(db, id)) {
    const cache = readSocialFeedCache(db, id);
    return { ok: true, skipped: 'fresh', items: cache.items, fetched_at: cache.fetched_at, errors: [] };
  }
  if (socialFeedRefreshInFlight.has(id)) {
    const cache = readSocialFeedCache(db, id);
    return { ok: true, skipped: 'in-flight', items: cache.items, fetched_at: cache.fetched_at, errors: [] };
  }
  socialFeedRefreshInFlight.add(id);
  try {
    const social = require('../src/socialMedia');
    const { items, errors } = await social.fetchRemoteFeedPosts(db, id, {
      fetchImpl: opts.fetchImpl,
      limit: SOCIALFEED_MAX_POSTS_CAP,
    });
    const shaped = (Array.isArray(items) ? items : []).map(shapeFeedItem).filter(Boolean);
    const errText = (Array.isArray(errors) ? errors : [])
      .map((e) => `${e.platform}: ${e.error}`)
      .join('; ')
      .slice(0, 500);
    db.prepare(
      `INSERT INTO socialfeed_cache (lead_id, items_json, fetched_at, last_error, updated_at)
       VALUES (?, ?, datetime('now'), ?, datetime('now'))
       ON CONFLICT(lead_id) DO UPDATE SET
         items_json = excluded.items_json, fetched_at = excluded.fetched_at,
         last_error = excluded.last_error, updated_at = datetime('now')`
    ).run(id, JSON.stringify(shaped), errText);
    const cache = readSocialFeedCache(db, id);
    return {
      ok: !(errors && errors.length),
      items: cache.items,
      fetched_at: cache.fetched_at,
      errors: errors || [],
    };
  } catch (e) {
    try {
      db.prepare(
        `INSERT INTO socialfeed_cache (lead_id, items_json, fetched_at, last_error, updated_at)
         VALUES (?, '[]', NULL, ?, datetime('now'))
         ON CONFLICT(lead_id) DO UPDATE SET last_error = excluded.last_error, updated_at = datetime('now')`
      ).run(id, String((e && e.message) || e).slice(0, 500));
    } catch {
      /* cache is best-effort */
    }
    const cache = readSocialFeedCache(db, id);
    return { ok: false, error: (e && e.message) || String(e), items: cache.items, fetched_at: cache.fetched_at, errors: [] };
  } finally {
    socialFeedRefreshInFlight.delete(id);
  }
}

/** Fire-and-forget refresh used by read paths; only when an account exists. */
function maybeRefreshSocialFeed(db, leadId) {
  try {
    if (!socialFeedCacheStale(db, leadId)) return;
    const social = require('../src/socialMedia');
    const { accounts } = social.listAccounts(db, Number(leadId));
    if (!accounts || !accounts.some((a) => a.status === 'active' && a.has_token)) return;
    refreshSocialFeedRemote(db, leadId).catch(() => {});
  } catch {
    /* the feed must never break a page */
  }
}

/** Merged, filtered, ordered feed items for a lead (what will render). */
function socialFeedItems(db, leadId, opts = {}) {
  const config = opts.config || readSocialFeedConfig(db, leadId);
  const networks = normalizeSocialFeedNetworks(opts.networks || config.networks);
  const maxPosts = clampSocialFeedMaxPosts(opts.max_posts != null ? opts.max_posts : config.max_posts);
  const local = localSocialFeedItems(db, leadId);
  const localIds = new Set(local.map((i) => i.external_id).filter(Boolean));
  const remote = readSocialFeedCache(db, leadId).items.filter((r) => {
    if (r.external_id && localIds.has(r.external_id)) return false; // local copy wins
    // Photo posts get a different external id from Meta on read-back; also
    // dedupe on same network + same text + near-identical publish time.
    if (r.text) {
      const rt = feedTimeMs(r.published_at);
      const dup = local.some(
        (l) =>
          l.network === r.network &&
          l.text === r.text &&
          (!rt || !feedTimeMs(l.published_at) || Math.abs(feedTimeMs(l.published_at) - rt) <= 120000)
      );
      if (dup) return false;
    }
    return true;
  });
  let items = [...local, ...remote];
  items.sort((a, b) => feedTimeMs(b.published_at) - feedTimeMs(a.published_at));
  if (networks !== 'both') items = items.filter((i) => i.network === networks);
  return items.slice(0, maxPosts);
}

function socialFeedSourceNote(accounts, liveItemCount) {
  const active = (accounts || []).filter((a) => a.status === 'active' && a.has_token);
  if (!active.length) {
    return 'Shows the posts published through BitPype. Connect a Facebook or Instagram account under Social and the feed will also pull in your latest posts from there.';
  }
  const names = [...new Set(active.map((a) => (a.platform === 'instagram' ? 'Instagram' : 'Facebook')))];
  const from =
    names.length === 2 ? 'your connected Facebook and Instagram accounts' : `your connected ${names[0]} account`;
  if (liveItemCount > 0) {
    return `Shows the posts published through BitPype, plus your latest posts from ${from}.`;
  }
  return `Shows the posts published through BitPype. New posts from ${from} are pulled in automatically — check back after your next post.`;
}

/** Portal-facing preview: config + exactly what the public feed will show. */
function socialFeedPreview(db, leadId) {
  const config = getSocialFeedConfig(db, leadId);
  maybeRefreshSocialFeed(db, leadId);
  const cache = readSocialFeedCache(db, leadId);
  let accounts = [];
  try {
    accounts = require('../src/socialMedia').listAccounts(db, Number(leadId)).accounts || [];
  } catch {
    accounts = [];
  }
  return {
    config,
    items: socialFeedItems(db, leadId, { config }),
    accounts: accounts.map((a) => ({
      platform: a.platform,
      account_name: a.account_name,
      status: a.status,
      has_token: a.has_token,
    })),
    source_note: socialFeedSourceNote(accounts, cache.items.length),
    live: cache.items.length > 0,
    last_fetched_at: cache.fetched_at,
    last_error: cache.last_error || '',
  };
}

/** Public-safe payload: config display fields + merged published items. */
function publicSocialFeedPayload(db, leadId) {
  const config = readSocialFeedConfig(db, leadId);
  maybeRefreshSocialFeed(db, leadId);
  return {
    config: { networks: config.networks, max_posts: config.max_posts, layout: config.layout },
    items: socialFeedItems(db, leadId, { config }),
  };
}

/* ── Google Reviews (Batch 30) ───────────────────────────────────────────────
 * Automatic module — no per-item CRUD. The business's Google Place ID is
 * stored per lead; reviews are fetched SERVER-SIDE from the Google Places
 * API (New) using the PLATFORM key (google.places_api_key, Admin →
 * Settings, secretBox-encrypted) and cached in googlereviews_cache for
 * 24h. The key never reaches the exported site or any client JS — the
 * public payload carries only the cached, already-public review data.
 * Honesty states: no key, no Place ID, no successful fetch yet, or zero
 * matching reviews → the module renders NOTHING on the public site (no
 * placeholder, no invented reviews — ever). Fetch failures keep the last
 * good cache and surface only in the portal/admin, never on the site. */

const GOOGLE_REVIEWS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const GOOGLE_REVIEWS_MAX_CAP = 5; // the Places API returns at most 5 reviews
const GOOGLE_REVIEWS_DEFAULT_MAX = 5;
const GOOGLE_REVIEWS_TEXT_LIMIT = 1200;
const GOOGLE_PLACES_FIELD_MASK = 'displayName,rating,userRatingCount,reviews,googleMapsUri';

function assertGooglePlaceId(value) {
  const v = String(value || '').trim();
  if (!v) return '';
  // Place IDs are URL-safe tokens (letters, digits, '-' and '_'),
  // e.g. ChIJN1t_tDeuEmsRUsoyG83frY4 — reject anything else up front so
  // a bad ID fails at save with a clear message, not inside a fetch.
  if (v.length < 8 || v.length > 256 || !/^[A-Za-z0-9_-]+$/.test(v)) {
    throw fail(
      'VALIDATION',
      'That does not look like a Google Place ID. A Place ID is a long code of letters, numbers, dashes and underscores (for example ChIJN1t_tDeuEmsRUsoyG83frY4) — copy it exactly from Google.'
    );
  }
  return v;
}

function clampGoogleReviewsMax(value, fallback = GOOGLE_REVIEWS_DEFAULT_MAX) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(GOOGLE_REVIEWS_MAX_CAP, n));
}

function normalizeGoogleMinRating(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  // Half-star steps (0, 0.5, … 5) — review ratings are whole stars, so
  // 4 and 4.5 both mean "4 stars and up" in effect; keep the steps anyway.
  return Math.max(0, Math.min(5, Math.round(n * 2) / 2));
}

function readGoogleReviewsConfig(db, leadId) {
  ensureTables(db);
  const row = db.prepare('SELECT * FROM googlereviews_configs WHERE lead_id = ?').get(Number(leadId));
  if (!row) {
    return {
      lead_id: Number(leadId),
      place_id: '',
      max_reviews: GOOGLE_REVIEWS_DEFAULT_MAX,
      min_rating: 0,
      share_to_social: 0,
      updated_at: null,
    };
  }
  return {
    ...row,
    place_id: String(row.place_id || '').trim(),
    max_reviews: clampGoogleReviewsMax(row.max_reviews),
    min_rating: normalizeGoogleMinRating(row.min_rating),
    share_to_social: row.share_to_social ? 1 : 0,
  };
}

function getGoogleReviewsConfig(db, leadId) {
  ensureTables(db);
  const id = Number(leadId);
  const existing = db.prepare('SELECT lead_id FROM googlereviews_configs WHERE lead_id = ?').get(id);
  if (!existing) {
    db.prepare('INSERT INTO googlereviews_configs (lead_id) VALUES (?)').run(id);
  }
  return readGoogleReviewsConfig(db, id);
}

function updateGoogleReviewsConfig(db, leadId, data = {}) {
  ensureTables(db);
  const row = getGoogleReviewsConfig(db, leadId);
  let placeId = row.place_id;
  if (data.place_id != null || data.placeId != null) {
    placeId = assertGooglePlaceId(data.place_id != null ? data.place_id : data.placeId);
  }
  const maxReviews =
    data.max_reviews != null || data.maxReviews != null
      ? clampGoogleReviewsMax(data.max_reviews != null ? data.max_reviews : data.maxReviews, row.max_reviews)
      : row.max_reviews;
  const minRating =
    data.min_rating != null || data.minRating != null
      ? normalizeGoogleMinRating(data.min_rating != null ? data.min_rating : data.minRating, row.min_rating)
      : row.min_rating;
  const shareRaw = data.share_to_social != null ? data.share_to_social : data.shareToSocial;
  const shareToSocial = shareRaw != null ? (shareRaw === true || Number(shareRaw) === 1 ? 1 : 0) : row.share_to_social ? 1 : 0;
  db.prepare(
    `UPDATE googlereviews_configs SET place_id = ?, max_reviews = ?, min_rating = ?, share_to_social = ?, updated_at = datetime('now') WHERE lead_id = ?`
  ).run(placeId, maxReviews, minRating, shareToSocial, Number(leadId));
  return getGoogleReviewsConfig(db, leadId);
}

/** One Places (New) review → the stored/public shape. Text is verbatim
 * (Google attribution policy: reviews are shown unaltered); only length
 * is bounded for storage, and display truncation happens at render. */
function shapeGoogleReview(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const attribution = raw.authorAttribution || {};
  const text = raw.text && typeof raw.text === 'object' ? String(raw.text.text || '') : String(raw.text || '');
  const rating = Math.max(0, Math.min(5, Math.round(Number(raw.rating) || 0)));
  const author = String(attribution.displayName || '').trim();
  if (!author && !text && !rating) return null;
  return {
    author,
    author_uri: attribution.uri ? String(attribution.uri) : '',
    photo_uri: attribution.photoUri ? String(attribution.photoUri) : '',
    rating,
    relative_time: String(raw.relativePublishTimeDescription || ''),
    publish_time: raw.publishTime ? String(raw.publishTime) : '',
    text: text.slice(0, GOOGLE_REVIEWS_TEXT_LIMIT),
  };
}

/** Places (New) place-details JSON → the cached payload shape. */
function parseGooglePlaceDetails(json) {
  const src = json && typeof json === 'object' ? json : {};
  const reviews = (Array.isArray(src.reviews) ? src.reviews : []).map(shapeGoogleReview).filter(Boolean);
  return {
    name: src.displayName && typeof src.displayName === 'object' ? String(src.displayName.text || '') : '',
    rating: src.rating != null && Number.isFinite(Number(src.rating)) ? Number(src.rating) : null,
    total: src.userRatingCount != null ? Math.max(0, Math.round(Number(src.userRatingCount) || 0)) : 0,
    google_maps_uri: src.googleMapsUri ? String(src.googleMapsUri) : '',
    reviews,
  };
}

function readGoogleReviewsCache(db, leadId) {
  ensureTables(db);
  const row = db.prepare('SELECT * FROM googlereviews_cache WHERE lead_id = ?').get(Number(leadId));
  if (!row) return { data: null, fetched_at: null, last_error: '' };
  let data = null;
  const parsed = parseJsonLoose(row.payload_json, null);
  if (parsed && typeof parsed === 'object' && Array.isArray(parsed.reviews)) data = parsed;
  return { data, fetched_at: row.fetched_at || null, last_error: row.last_error || '' };
}

function storeGoogleReviewsCache(db, leadId, payload) {
  ensureTables(db);
  db.prepare(
    `INSERT INTO googlereviews_cache (lead_id, payload_json, fetched_at, last_error, updated_at)
     VALUES (?, ?, datetime('now'), '', datetime('now'))
     ON CONFLICT(lead_id) DO UPDATE SET
       payload_json = excluded.payload_json, fetched_at = excluded.fetched_at,
       last_error = '', updated_at = datetime('now')`
  ).run(Number(leadId), JSON.stringify(payload || {}));
  // Batch 158: every cache store funnels through here (portal refresh,
  // lazy refresh, Place-ID-save prefetch), so this is the one hook the
  // reviews → social bridge needs. Through the Batch 122 shared layer,
  // never a pairwise import; sharing must never break a refresh.
  try {
    require('./moduleShare').shareGoogleReviewsToSocial(db, Number(leadId));
  } catch {
    /* the bridge is best-effort — a refresh never fails because of it */
  }
  return readGoogleReviewsCache(db, leadId);
}

function googleReviewsCacheStale(db, leadId) {
  const { fetched_at } = readGoogleReviewsCache(db, leadId);
  if (!fetched_at) return true;
  return Date.now() - feedTimeMs(fetched_at) > GOOGLE_REVIEWS_CACHE_TTL_MS;
}

/** The platform Places key. opts.apiKey wins (tests, explicit callers);
 * otherwise the Admin → Settings platform secret. Never logged. */
async function resolveGooglePlacesApiKey(opts = {}) {
  if (opts.apiKey != null) return String(opts.apiKey || '').trim();
  try {
    const platform = require('./platform');
    return String((await platform.getPlatformSetting('google.places_api_key', '')) || '').trim();
  } catch {
    return '';
  }
}

async function googlePlacesConfigured(opts = {}) {
  return !!(await resolveGooglePlacesApiKey(opts));
}

/** One server-side Places (New) details fetch. Throws an Error with a
 * `.code`: PLACES_NOT_FOUND (bad Place ID), PLACES_DENIED (key/quota),
 * PLACES_ERROR (anything else). The key travels in a header only. */
async function fetchGooglePlaceDetails(apiKey, placeId, fetchImpl) {
  const key = String(apiKey || '').trim();
  if (!key) throw Object.assign(new Error('Google Places API key is not configured'), { code: 'NO_KEY' });
  const id = assertGooglePlaceId(placeId);
  if (!id) throw Object.assign(new Error('Google Place ID is not set'), { code: 'NO_PLACE_ID' });
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) throw Object.assign(new Error('No fetch implementation available'), { code: 'PLACES_ERROR' });
  const url = `https://places.googleapis.com/v1/places/${encodeURIComponent(id)}`;
  let res;
  try {
    res = await doFetch(url, {
      method: 'GET',
      headers: {
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': GOOGLE_PLACES_FIELD_MASK,
        Accept: 'application/json',
      },
    });
  } catch (e) {
    throw Object.assign(new Error(`Could not reach Google Places: ${(e && e.message) || e}`), { code: 'PLACES_ERROR' });
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const gmsg =
      (body && body.error && (body.error.message || body.error.status)) || `HTTP ${res.status}`;
    if (res.status === 404) {
      throw Object.assign(new Error(`Google could not find that Place ID (${gmsg})`), { code: 'PLACES_NOT_FOUND' });
    }
    if (res.status === 400 && /place/i.test(String(gmsg))) {
      throw Object.assign(new Error(`Google rejected that Place ID (${gmsg})`), { code: 'PLACES_NOT_FOUND' });
    }
    if (res.status === 401 || res.status === 403 || res.status === 429) {
      throw Object.assign(new Error(`Google Places request was refused (${gmsg})`), { code: 'PLACES_DENIED' });
    }
    throw Object.assign(new Error(`Google Places request failed (${gmsg})`), { code: 'PLACES_ERROR' });
  }
  return parseGooglePlaceDetails(body);
}

const googleReviewsRefreshInFlight = new Set();

/**
 * Refresh the cached Google reviews for a lead. Honors the 24h TTL
 * unless `force`. Dormant-clean: with no platform key or no Place ID it
 * returns a coded result WITHOUT touching the cache or the network.
 * Failures keep the last good cache; only last_error is updated.
 */
async function refreshGoogleReviews(db, leadId, opts = {}) {
  const id = Number(leadId);
  ensureTables(db);
  const config = readGoogleReviewsConfig(db, id);
  if (!config.place_id) {
    const cache = readGoogleReviewsCache(db, id);
    return { ok: false, code: 'NO_PLACE_ID', error: 'No Google Place ID is set for this business yet.', data: cache.data, fetched_at: cache.fetched_at };
  }
  const apiKey = await resolveGooglePlacesApiKey(opts);
  if (!apiKey) {
    const cache = readGoogleReviewsCache(db, id);
    return { ok: false, code: 'NO_KEY', error: 'The platform Google Places key is not configured yet.', data: cache.data, fetched_at: cache.fetched_at };
  }
  if (!opts.force && !googleReviewsCacheStale(db, id)) {
    const cache = readGoogleReviewsCache(db, id);
    return { ok: true, skipped: 'fresh', data: cache.data, fetched_at: cache.fetched_at };
  }
  if (googleReviewsRefreshInFlight.has(id)) {
    const cache = readGoogleReviewsCache(db, id);
    return { ok: true, skipped: 'in-flight', data: cache.data, fetched_at: cache.fetched_at };
  }
  googleReviewsRefreshInFlight.add(id);
  try {
    const payload = await fetchGooglePlaceDetails(apiKey, config.place_id, opts.fetchImpl);
    const cache = storeGoogleReviewsCache(db, id, payload);
    return { ok: true, data: cache.data, fetched_at: cache.fetched_at };
  } catch (e) {
    try {
      db.prepare(
        `INSERT INTO googlereviews_cache (lead_id, payload_json, fetched_at, last_error, updated_at)
         VALUES (?, '', NULL, ?, datetime('now'))
         ON CONFLICT(lead_id) DO UPDATE SET last_error = excluded.last_error, updated_at = datetime('now')`
      ).run(id, String((e && e.message) || e).slice(0, 500));
    } catch {
      /* cache is best-effort */
    }
    const cache = readGoogleReviewsCache(db, id);
    return { ok: false, code: (e && e.code) || 'PLACES_ERROR', error: (e && e.message) || String(e), data: cache.data, fetched_at: cache.fetched_at };
  } finally {
    googleReviewsRefreshInFlight.delete(id);
  }
}

/** Fire-and-forget refresh used by read paths (public payload, portal
 * preview). Dormant configurations exit silently — the public page must
 * never wait on, or break because of, Google. */
function maybeRefreshGoogleReviews(db, leadId) {
  try {
    if (!googleReviewsCacheStale(db, leadId)) return;
    if (!readGoogleReviewsConfig(db, leadId).place_id) return;
    refreshGoogleReviews(db, leadId).catch(() => {});
  } catch {
    /* reviews must never break a page */
  }
}

/** The reviews that will actually render: cached, min-rating filtered,
 * capped at the configured count. */
function googleReviewsItems(db, leadId, opts = {}) {
  const config = opts.config || readGoogleReviewsConfig(db, leadId);
  const { data } = readGoogleReviewsCache(db, leadId);
  if (!data || !Array.isArray(data.reviews)) return [];
  const min = normalizeGoogleMinRating(opts.min_rating != null ? opts.min_rating : config.min_rating);
  const max = clampGoogleReviewsMax(opts.max_reviews != null ? opts.max_reviews : config.max_reviews);
  return data.reviews.filter((r) => (Number(r.rating) || 0) >= min).slice(0, max);
}

/** Public payload — null whenever there is nothing honest to show. */
function publicGoogleReviewsPayload(db, leadId) {
  const config = readGoogleReviewsConfig(db, leadId);
  maybeRefreshGoogleReviews(db, leadId);
  const { data } = readGoogleReviewsCache(db, leadId);
  if (!config.place_id || !data) return null;
  const reviews = googleReviewsItems(db, leadId, { config });
  if (!reviews.length) return null;
  return {
    config: { max_reviews: config.max_reviews, min_rating: config.min_rating },
    name: data.name || '',
    rating: data.rating,
    total: data.total || 0,
    google_maps_uri: data.google_maps_uri || '',
    reviews,
  };
}

/**
 * Portal/admin state for the module: config, key presence, a state code
 * + plain-language message, and the cached summary. Async because key
 * presence lives in the platform settings store.
 */
async function googleReviewsPreview(db, leadId, opts = {}) {
  const config = readGoogleReviewsConfig(db, leadId);
  maybeRefreshGoogleReviews(db, leadId);
  const cache = readGoogleReviewsCache(db, leadId);
  const keyConfigured = await googlePlacesConfigured(opts);
  const reviews = googleReviewsItems(db, leadId, { config });
  let state;
  let message;
  if (!keyConfigured) {
    state = 'no_key';
    message = 'Waiting for the platform Google connection — BitPype needs to add the Google Places API key in Admin → Settings before reviews can load. Your Place ID and settings are saved and will light up automatically.';
  } else if (!config.place_id) {
    state = 'no_place_id';
    message = 'Add your Google Place ID to start showing your Google reviews here and on your website.';
  } else if (!cache.data) {
    state = cache.last_error ? 'error' : 'never_fetched';
    message = cache.last_error
      ? `The last check for reviews failed: ${cache.last_error}`
      : 'Your Place ID is saved. Reviews have not been fetched yet — use Refresh now to pull them in.';
  } else if (!reviews.length) {
    state = 'empty';
    message = config.min_rating > 0
      ? 'Google returned reviews, but none meet the minimum rating you set — lower the minimum to show more.'
      : 'Google has no reviews to show for this business yet. New reviews will appear here automatically.';
  } else {
    state = 'ready';
    message = 'Your Google reviews are live on your website.';
  }
  return {
    config,
    key_configured: keyConfigured,
    state,
    message,
    summary: {
      name: cache.data ? cache.data.name || '' : '',
      rating: cache.data ? cache.data.rating : null,
      total: cache.data ? cache.data.total || 0 : 0,
      review_count: reviews.length,
      fetched_at: cache.fetched_at,
      last_error: cache.last_error || '',
    },
    reviews,
  };
}

/* ── Data Tables (Batch 88) ──────────────────────────────────────────────────
 *
 * A generic structured-data module (Ely 2026-10-30: "add datatables
 * module so mcp can use it to build app-like features websites", then
 * widened: "it should be flexible enough to be designed into anything —
 * a twitter wall or Google search page style or a list with a form
 * field to submit"). ONE dataset per site (named columns + rows, full
 * CRUD via MCP + the portal editor) rendered by ONE of several
 * presentation templates chosen per instance: an interactive table
 * (search / sort / pagination), a card wall, a search-results-style
 * list, or a simple list. A display mapping says which column plays
 * which role (title / body / image / link / meta / badge) in the
 * role-based templates; defaults are inferred from column order+type.
 *
 * Visitor submissions are the module's only public write path and ride
 * the same protections as bookings/estimate (per-IP rate limiter +
 * Turnstile on the route). An instance's submit_mode decides what a
 * submission becomes: 'off' (no form), 'moderated' (DEFAULT — lands
 * as a pending row, invisible until the owner approves it in the
 * portal or via MCP), or 'live' (published immediately). Rows carry a
 * status ('published' | 'pending') and a source ('owner' | 'visitor');
 * the public payload only ever serves published rows.
 */

const DATATABLE_COLUMN_TYPES = ['text', 'number', 'currency', 'date', 'link', 'boolean'];
const DATATABLE_TEMPLATES = ['table', 'wall', 'results', 'list'];
const DATATABLE_SUBMIT_MODES = ['off', 'moderated', 'live'];
const DATATABLE_ROLES = ['title', 'body', 'image', 'link', 'meta', 'badge'];
const DATATABLE_MAX_COLUMNS = 12;
const DATATABLE_MAX_ROWS = 500;
const DATATABLE_ROW_STATUSES = ['published', 'pending'];

function normalizeDataTableColumns(raw) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw fail('VALIDATION', 'columns must be an array of { key, label, type }');
  if (raw.length > DATATABLE_MAX_COLUMNS) {
    throw fail('VALIDATION', `A data table can have at most ${DATATABLE_MAX_COLUMNS} columns`);
  }
  const seen = new Set();
  const out = [];
  for (const entry of raw) {
    const col = entry && typeof entry === 'object' ? entry : {};
    const key = String(col.key || '')
      .trim()
      .toLowerCase();
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(key)) {
      throw fail('VALIDATION', `Invalid column key "${col.key || ''}" — use lowercase letters, digits and underscores, starting with a letter`);
    }
    if (seen.has(key)) throw fail('VALIDATION', `Duplicate column key "${key}"`);
    seen.add(key);
    const label = String(col.label || '').trim().slice(0, 80);
    if (!label) throw fail('VALIDATION', `Column "${key}" needs a label`);
    const type = String(col.type || 'text').trim().toLowerCase();
    if (!DATATABLE_COLUMN_TYPES.includes(type)) {
      throw fail('VALIDATION', `Invalid column type "${col.type || ''}" for "${key}" — use: ${DATATABLE_COLUMN_TYPES.join(', ')}`);
    }
    out.push({ key, label, type });
  }
  return out;
}

/** Role defaults inferred from column order + type (overridable). */
function inferDataTableRoles(columns) {
  const roles = { title: null, body: null, image: null, link: null, meta: null, badge: null };
  const texts = columns.filter((c) => c.type === 'text');
  const links = columns.filter((c) => c.type === 'link');
  if (texts[0]) roles.title = texts[0].key;
  if (texts[1]) roles.body = texts[1].key;
  else if (texts[0]) roles.body = null;
  if (links[0]) roles.image = links[0].key;
  if (links[1]) roles.link = links[1].key;
  const dateCol = columns.find((c) => c.type === 'date');
  const moneyCol = columns.find((c) => c.type === 'currency' || c.type === 'number');
  if (dateCol) roles.meta = dateCol.key;
  else if (moneyCol) roles.meta = moneyCol.key;
  const boolCol = columns.find((c) => c.type === 'boolean');
  if (boolCol) roles.badge = boolCol.key;
  return roles;
}

function normalizeDataTableDisplay(columns, raw, base) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const current = base || {
    template: 'table',
    roles: inferDataTableRoles(columns),
    submit_mode: 'moderated',
    submit_fields: null, // null = derive from roles at read time
  };
  const out = {
    template: current.template,
    roles: { ...current.roles },
    submit_mode: current.submit_mode,
    submit_fields: current.submit_fields == null ? null : [...current.submit_fields],
  };
  if (src.template != null) {
    const t = String(src.template).trim().toLowerCase();
    if (!DATATABLE_TEMPLATES.includes(t)) {
      throw fail('VALIDATION', `Invalid template "${src.template}" — use: ${DATATABLE_TEMPLATES.join(', ')}`);
    }
    out.template = t;
  }
  if (src.roles != null) {
    if (typeof src.roles !== 'object' || Array.isArray(src.roles)) {
      throw fail('VALIDATION', 'roles must be an object mapping role → column key');
    }
    const keys = new Set(columns.map((c) => c.key));
    for (const role of DATATABLE_ROLES) {
      if (!(role in src.roles)) continue;
      const v = src.roles[role];
      if (v == null || v === '') {
        out.roles[role] = null;
        continue;
      }
      const key = String(v).trim().toLowerCase();
      if (!keys.has(key)) throw fail('VALIDATION', `Role "${role}" points at unknown column "${v}"`);
      out.roles[role] = key;
    }
  }
  if (src.submit_mode != null) {
    const m = String(src.submit_mode).trim().toLowerCase();
    if (!DATATABLE_SUBMIT_MODES.includes(m)) {
      throw fail('VALIDATION', `Invalid submit_mode "${src.submit_mode}" — use: ${DATATABLE_SUBMIT_MODES.join(', ')}`);
    }
    out.submit_mode = m;
  }
  if (src.submit_fields != null) {
    if (!Array.isArray(src.submit_fields)) throw fail('VALIDATION', 'submit_fields must be an array of column keys');
    const keys = new Set(columns.map((c) => c.key));
    const fields = [];
    for (const f of src.submit_fields) {
      const key = String(f || '').trim().toLowerCase();
      if (!keys.has(key)) throw fail('VALIDATION', `submit_fields names unknown column "${f}"`);
      if (!fields.includes(key)) fields.push(key);
    }
    if (fields.length > DATATABLE_MAX_COLUMNS) throw fail('VALIDATION', 'Too many submit fields');
    out.submit_fields = fields;
  }
  // Stored roles/fields can outlive a column they point at (schema was
  // replaced) — prune anything dangling so renders never chase ghosts.
  const keys = new Set(columns.map((c) => c.key));
  for (const role of DATATABLE_ROLES) {
    if (out.roles[role] && !keys.has(out.roles[role])) out.roles[role] = null;
  }
  if (out.submit_fields) out.submit_fields = out.submit_fields.filter((k) => keys.has(k));
  return out;
}

/** The visitor-facing submit fields: configured set, else title+body roles. */
function dataTableSubmitFieldKeys(config) {
  if (Array.isArray(config.submit_fields)) return config.submit_fields;
  const keys = [];
  for (const role of ['title', 'body']) {
    const k = config.roles && config.roles[role];
    if (k && !keys.includes(k)) keys.push(k);
  }
  return keys;
}

function readDataTableConfig(db, leadId) {
  ensureTables(db);
  const row = db.prepare('SELECT * FROM datatable_configs WHERE lead_id = ?').get(Number(leadId));
  if (!row) return null;
  let columns = [];
  try {
    columns = normalizeDataTableColumns(JSON.parse(row.columns_json || '[]'));
  } catch {
    columns = [];
  }
  let display = {};
  try {
    display = JSON.parse(row.display_json || '') || {};
  } catch {
    display = {};
  }
  const merged = normalizeDataTableDisplay(columns, display, null);
  return {
    lead_id: Number(row.lead_id),
    title: String(row.title || ''),
    columns,
    template: merged.template,
    roles: merged.roles,
    submit_mode: merged.submit_mode,
    submit_fields: merged.submit_fields,
    updated_at: row.updated_at,
  };
}

function getDataTableConfig(db, leadId) {
  const cfg = readDataTableConfig(db, leadId);
  if (cfg) return cfg;
  return {
    lead_id: Number(leadId),
    title: '',
    columns: [],
    template: 'table',
    roles: inferDataTableRoles([]),
    submit_mode: 'moderated',
    submit_fields: null,
    updated_at: null,
  };
}

/**
 * Create or update the table definition. `data` may carry: title,
 * columns (replaces the schema wholesale), template, roles,
 * submit_mode, submit_fields. When columns change, stored row values
 * for removed keys are kept in the rows (harmless — reads and renders
 * only ever look at current column keys).
 */
function updateDataTableConfig(db, leadId, data = {}) {
  ensureTables(db);
  const lid = Number(leadId);
  const existing = readDataTableConfig(db, lid);
  const columns = data.columns != null ? normalizeDataTableColumns(data.columns) : existing ? existing.columns : [];
  const display = normalizeDataTableDisplay(
    columns,
    {
      template: data.template,
      roles: data.roles,
      submit_mode: data.submit_mode,
      submit_fields: data.submit_fields,
    },
    existing
      ? {
          template: existing.template,
          roles: existing.roles,
          submit_mode: existing.submit_mode,
          submit_fields: existing.submit_fields,
        }
      : null
  );
  const title =
    data.title != null ? String(data.title).trim().slice(0, 120) : existing ? existing.title : '';
  const displayJson = JSON.stringify({
    template: display.template,
    roles: display.roles,
    submit_mode: display.submit_mode,
    submit_fields: display.submit_fields,
  });
  db.prepare(
    `INSERT INTO datatable_configs (lead_id, title, columns_json, display_json, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(lead_id) DO UPDATE SET title = excluded.title,
       columns_json = excluded.columns_json, display_json = excluded.display_json,
       updated_at = datetime('now')`
  ).run(lid, title, JSON.stringify(columns), displayJson);
  // The embed carries the page-facing title; keep it in step when the
  // table is renamed and the module is attached.
  if (data.title != null) {
    db.prepare(
      "UPDATE site_module_embeds SET title = ?, updated_at = datetime('now') WHERE lead_id = ? AND module_type = 'datatables'"
    ).run(title || MODULE_META.datatables.defaultTitle, lid);
  }
  return getDataTableConfig(db, lid);
}

function normalizeDataTableCell(col, value) {
  if (value == null || value === '') return null;
  switch (col.type) {
    case 'text':
      return String(value).slice(0, 2000);
    case 'number': {
      const n = typeof value === 'number' ? value : Number(String(value).replace(/[$,]/g, '').trim());
      if (!Number.isFinite(n)) throw fail('VALIDATION', `Column "${col.key}" expects a number, got "${value}"`);
      return n;
    }
    case 'currency': {
      const n = typeof value === 'number' ? value : Number(String(value).replace(/[$,]/g, '').trim());
      if (!Number.isFinite(n)) throw fail('VALIDATION', `Column "${col.key}" expects an amount, got "${value}"`);
      return Math.round(n * 100) / 100;
    }
    case 'date': {
      const s = String(value).trim().slice(0, 10);
      const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (!m) throw fail('VALIDATION', `Column "${col.key}" expects a date as YYYY-MM-DD, got "${value}"`);
      const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
      if (d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) {
        throw fail('VALIDATION', `Column "${col.key}" got a date that does not exist: "${value}"`);
      }
      return s;
    }
    case 'link': {
      let url = '';
      let label = '';
      if (typeof value === 'object') {
        url = String(value.url || value.href || '').trim();
        label = String(value.label || value.text || '').trim().slice(0, 200);
      } else {
        url = String(value).trim();
      }
      if (!url) throw fail('VALIDATION', `Column "${col.key}" expects a URL`);
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        throw fail('VALIDATION', `Column "${col.key}" got an invalid URL: "${url}"`);
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw fail('VALIDATION', `Column "${col.key}" links must start with http:// or https://`);
      }
      return { url: parsed.toString(), label: label || parsed.toString() };
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      const s = String(value).trim().toLowerCase();
      if (['true', '1', 'yes', 'y'].includes(s)) return true;
      if (['false', '0', 'no', 'n'].includes(s)) return false;
      throw fail('VALIDATION', `Column "${col.key}" expects true/false, got "${value}"`);
    }
    default:
      return String(value).slice(0, 2000);
  }
}

/**
 * Validate + normalize a values object against the schema. Unknown
 * keys are rejected (catches agent typos). With `partial`, only the
 * provided keys are returned (row updates merge). With
 * `onlyKeys` (visitor submissions), only those columns are read —
 * anything else the client sent is ignored, never stored.
 */
function normalizeDataTableValues(columns, raw, { partial = false, onlyKeys = null } = {}) {
  if (!columns.length) throw fail('VALIDATION', 'Define the table columns before adding rows');
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  if (!src) throw fail('VALIDATION', 'values must be an object keyed by column');
  const byKey = new Map(columns.map((c) => [c.key, c]));
  if (!onlyKeys) {
    for (const key of Object.keys(src)) {
      if (!byKey.has(key)) throw fail('VALIDATION', `Unknown column "${key}" — this table has: ${columns.map((c) => c.key).join(', ')}`);
    }
  }
  const out = {};
  const wanted = onlyKeys || columns.map((c) => c.key);
  for (const key of wanted) {
    if (!(key in src)) {
      if (!partial && !onlyKeys) out[key] = null;
      continue;
    }
    out[key] = normalizeDataTableCell(byKey.get(key), src[key]);
  }
  return out;
}

function shapeDataTableRow(row) {
  if (!row) return row;
  let values = {};
  try {
    values = JSON.parse(row.values_json || '{}') || {};
  } catch {
    values = {};
  }
  return {
    id: row.id,
    values,
    status: row.status === 'pending' ? 'pending' : 'published',
    source: row.source === 'visitor' ? 'visitor' : 'owner',
    sort_order: row.sort_order || 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function listDataTableRows(db, leadId, { includePending = true } = {}) {
  ensureTables(db);
  let sql = 'SELECT * FROM datatable_rows WHERE lead_id = ?';
  if (!includePending) sql += " AND status = 'published'";
  sql += ' ORDER BY sort_order ASC, id ASC';
  return db.prepare(sql).all(Number(leadId)).map(shapeDataTableRow);
}

function getDataTableRow(db, leadId, id) {
  ensureTables(db);
  const row = db
    .prepare('SELECT * FROM datatable_rows WHERE lead_id = ? AND id = ?')
    .get(Number(leadId), Number(id));
  return shapeDataTableRow(row) || null;
}

function countDataTableRows(db, leadId, status = null) {
  ensureTables(db);
  let sql = 'SELECT COUNT(*) AS c FROM datatable_rows WHERE lead_id = ?';
  const params = [Number(leadId)];
  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }
  const row = db.prepare(sql).get(...params);
  return Number(row && row.c) || 0;
}

function insertDataTableRow(db, lid, values, { status, source, sortOrder }) {
  const info = db
    .prepare(
      `INSERT INTO datatable_rows (lead_id, values_json, status, source, sort_order)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(lid, JSON.stringify(values), status, source, sortOrder);
  return getDataTableRow(db, lid, info.lastInsertRowid);
}

function createDataTableRow(db, leadId, data = {}) {
  ensureTables(db);
  const lid = Number(leadId);
  const cfg = getDataTableConfig(db, lid);
  const values = normalizeDataTableValues(cfg.columns, data.values != null ? data.values : data);
  if (countDataTableRows(db, lid) >= DATATABLE_MAX_ROWS) {
    throw fail('VALIDATION', `This table already has the maximum of ${DATATABLE_MAX_ROWS} rows`);
  }
  const status = data.status != null ? String(data.status).toLowerCase() : 'published';
  if (!DATATABLE_ROW_STATUSES.includes(status)) {
    throw fail('VALIDATION', `Invalid row status "${data.status}" — use: ${DATATABLE_ROW_STATUSES.join(', ')}`);
  }
  const sortOrder =
    data.sort_order != null
      ? Number(data.sort_order) || 0
      : db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM datatable_rows WHERE lead_id = ?').get(lid).m + 1;
  return insertDataTableRow(db, lid, values, { status, source: 'owner', sortOrder });
}

/** Bulk seed: validate everything first, then insert in one pass. */
function addDataTableRows(db, leadId, rows) {
  ensureTables(db);
  const lid = Number(leadId);
  if (!Array.isArray(rows)) throw fail('VALIDATION', 'rows must be an array of { values } objects');
  const cfg = getDataTableConfig(db, lid);
  const prepared = rows.map((r) => {
    const item = r && typeof r === 'object' ? r : {};
    return normalizeDataTableValues(cfg.columns, item.values != null ? item.values : item);
  });
  if (countDataTableRows(db, lid) + prepared.length > DATATABLE_MAX_ROWS) {
    throw fail('VALIDATION', `Adding ${prepared.length} rows would exceed the maximum of ${DATATABLE_MAX_ROWS} rows per table`);
  }
  let next = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM datatable_rows WHERE lead_id = ?').get(lid).m;
  const added = prepared.map((values) => insertDataTableRow(db, lid, values, { status: 'published', source: 'owner', sortOrder: ++next }));
  return { added: added.length, rows: added };
}

function updateDataTableRow(db, leadId, id, data = {}) {
  ensureTables(db);
  const lid = Number(leadId);
  const row = getDataTableRow(db, lid, id);
  if (!row) throw fail('NOT_FOUND', 'Data table row not found', 404);
  const cfg = getDataTableConfig(db, lid);
  let values = row.values;
  const rawValues = data.values != null ? data.values : null;
  if (rawValues != null) {
    const patch = normalizeDataTableValues(cfg.columns, rawValues, { partial: true });
    values = { ...values, ...patch };
  }
  let status = row.status;
  if (data.status != null) {
    status = String(data.status).toLowerCase();
    if (!DATATABLE_ROW_STATUSES.includes(status)) {
      throw fail('VALIDATION', `Invalid row status "${data.status}" — use: ${DATATABLE_ROW_STATUSES.join(', ')}`);
    }
  }
  const sortOrder = data.sort_order != null ? Number(data.sort_order) || 0 : row.sort_order;
  db.prepare(
    "UPDATE datatable_rows SET values_json = ?, status = ?, sort_order = ?, updated_at = datetime('now') WHERE id = ? AND lead_id = ?"
  ).run(JSON.stringify(values), status, sortOrder, row.id, lid);
  return getDataTableRow(db, lid, row.id);
}

function deleteDataTableRow(db, leadId, id) {
  ensureTables(db);
  const row = getDataTableRow(db, leadId, id);
  if (!row) throw fail('NOT_FOUND', 'Data table row not found', 404);
  db.prepare('DELETE FROM datatable_rows WHERE id = ? AND lead_id = ?').run(row.id, Number(leadId));
  return { deleted: true, id: row.id };
}

function clearDataTableRows(db, leadId) {
  ensureTables(db);
  const info = db.prepare('DELETE FROM datatable_rows WHERE lead_id = ?').run(Number(leadId));
  return { deleted: info.changes };
}

/** Everything the owner/agent surfaces need in one read. */
function getDataTable(db, leadId) {
  const cfg = getDataTableConfig(db, leadId);
  const rows = listDataTableRows(db, leadId);
  return {
    title: cfg.title,
    columns: cfg.columns,
    template: cfg.template,
    roles: cfg.roles,
    submit_mode: cfg.submit_mode,
    submit_fields: dataTableSubmitFieldKeys(cfg),
    submit_fields_configured: Array.isArray(cfg.submit_fields),
    rows,
    row_count: rows.length,
    pending_count: rows.filter((r) => r.status === 'pending').length,
    updated_at: cfg.updated_at,
  };
}

/** The public (visitor) view: published rows only + render config. */
function publicDataTablePayload(db, leadId) {
  const cfg = getDataTableConfig(db, leadId);
  const submitKeys = cfg.submit_mode === 'off' ? [] : dataTableSubmitFieldKeys(cfg);
  const byKey = new Map(cfg.columns.map((c) => [c.key, c]));
  return {
    title: cfg.title,
    template: cfg.template,
    roles: cfg.roles,
    columns: cfg.columns,
    submit: {
      enabled: cfg.submit_mode !== 'off' && submitKeys.length > 0,
      mode: cfg.submit_mode,
      fields: submitKeys.map((k) => byKey.get(k)).filter(Boolean),
    },
  };
}

/**
 * The module's only public write path. Called by the token route
 * (rate limiter + Turnstile run in front of it, exactly like bookings
 * and estimate requests). A submission may only fill the configured
 * submit fields; it lands pending (moderated) or published (live).
 */
function createPublicDataTableSubmission(db, leadId, data = {}) {
  ensureTables(db);
  const lid = Number(leadId);
  const cfg = getDataTableConfig(db, lid);
  if (cfg.submit_mode === 'off') {
    throw fail('VALIDATION', 'This table is not accepting submissions', 403);
  }
  const fieldKeys = dataTableSubmitFieldKeys(cfg);
  if (!fieldKeys.length) throw fail('VALIDATION', 'This table is not accepting submissions', 403);
  const values = normalizeDataTableValues(cfg.columns, data.values != null ? data.values : data, {
    onlyKeys: fieldKeys,
  });
  const filled = fieldKeys.filter((k) => values[k] != null && values[k] !== '');
  if (!filled.length) throw fail('VALIDATION', 'Fill in at least one field before submitting');
  if (countDataTableRows(db, lid) >= DATATABLE_MAX_ROWS) {
    throw fail('VALIDATION', 'This table is full right now — please try again later', 409);
  }
  const status = cfg.submit_mode === 'live' ? 'published' : 'pending';
  const sortOrder =
    db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM datatable_rows WHERE lead_id = ?').get(lid).m + 1;
  const row = insertDataTableRow(db, lid, values, { status, source: 'visitor', sortOrder });
  return { row, mode: cfg.submit_mode };
}

function createPublicDataTableSubmissionByToken(db, token, data = {}, opts = {}) {
  ensureTables(db);
  const row = db
    .prepare('SELECT * FROM site_module_embeds WHERE public_token = ? AND published = 1')
    .get(String(token || ''));
  if (!row || row.module_type !== 'datatables') {
    throw fail('NOT_FOUND', 'Data table not found', 404);
  }
  assertSiteNotArchived(db, row.lead_id);
  assertSiteNotSuspended(db, row.lead_id);
  assertMemberAccessForEmbed(db, row, opts);
  const { row: created, mode } = createPublicDataTableSubmission(db, row.lead_id, data);
  return {
    embed: publicEmbed(row),
    row: { id: created.id, status: created.status },
    mode,
    message:
      mode === 'live'
        ? 'Thanks — your submission is live.'
        : 'Thanks — your submission was received and is awaiting approval.',
  };
}

/* ── Charts (Batch 90) ─────────────────────────────────────────────────────
 *
 * A data-visualization module (Ely 2026-10-30: "add a graphs module to
 * take data from the datatables or any source and display as any graph
 * style" — shipped as Charts). The module instance is one-per-site
 * like every module (site_module_embeds is UNIQUE(lead_id,
 * module_type)); the instance holds up to CHART_MAX_CHARTS chart
 * definitions, each rendered by the embed in order.
 *
 * A chart's data comes from one of two sources:
 *   - 'table'  — bound to the site's Data Table: a label column plus
 *     one or more numeric value columns, aggregated (sum / count /
 *     average) per label, or plotted row-by-row ('none'). Computed
 *     server-side at payload time from PUBLISHED rows only — pending
 *     visitor submissions are never charted, and the public payload
 *     carries only the computed labels + series, never raw rows.
 *   - 'manual' — a dataset stored on the chart itself (labels + up to
 *     CHART_MAX_SERIES series), entered via the portal editor or MCP.
 *     The stored shape ({ labels, series }) is the extension point:
 *     future sources produce the same shape and plug in unchanged.
 *
 * Styles: bar | hbar | line | area | pie | doughnut, switchable by
 * config without touching the data. The embed renders inline SVG (no
 * external chart library), so client sites stay self-contained.
 */

const CHART_TYPES = ['bar', 'hbar', 'line', 'area', 'pie', 'doughnut'];
const CHART_SOURCES = ['table', 'manual'];
const CHART_AGGREGATIONS = ['sum', 'count', 'average', 'none'];
const CHART_MAX_CHARTS = 20;
const CHART_MAX_POINTS = 50;
const CHART_MAX_SERIES = 4;
const CHART_MAX_COLORS = 12;
const CHART_DEFAULT_COLORS = [
  '#0e7a68',
  '#e8873a',
  '#3a6ea8',
  '#b04a6e',
  '#5b8c3e',
  '#7a5ba8',
  '#c2a13a',
  '#4a8c8c',
];

function chartBool(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const s = String(value).trim().toLowerCase();
  if (['yes', 'true', '1', 'on'].includes(s)) return true;
  if (['no', 'false', '0', 'off', ''].includes(s)) return false;
  return fallback;
}

function normalizeChartColors(raw) {
  if (raw == null || raw === '') return null; // null = keep/default
  let list = raw;
  if (typeof list === 'string') list = list.split(',');
  if (!Array.isArray(list)) throw fail('VALIDATION', 'colors must be an array of hex colors');
  const out = [];
  for (const entry of list) {
    const s = String(entry || '').trim();
    if (!s) continue;
    const m = s.match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
    if (!m) throw fail('VALIDATION', `Invalid color "${s}" — use hex like #0e7a68`);
    let hex = m[1].toLowerCase();
    if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
    if (!out.includes('#' + hex)) out.push('#' + hex);
  }
  if (out.length > CHART_MAX_COLORS) {
    throw fail('VALIDATION', `A chart can use at most ${CHART_MAX_COLORS} colors`);
  }
  return out;
}

function chartNumber(value, where) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value.replace(/[$,]/g, '').trim());
    if (Number.isFinite(n) && value.trim() !== '') return n;
  }
  throw fail('VALIDATION', `Chart data needs a number at ${where}, got "${value}"`);
}

function finishChartData(labels, series) {
  if (labels.length > CHART_MAX_POINTS) {
    throw fail('VALIDATION', `A chart can have at most ${CHART_MAX_POINTS} data points`);
  }
  if (series.length > CHART_MAX_SERIES) {
    throw fail('VALIDATION', `A chart can have at most ${CHART_MAX_SERIES} series`);
  }
  for (const s of series) {
    if (s.values.length !== labels.length) {
      throw fail(
        'VALIDATION',
        `Series "${s.name}" has ${s.values.length} values for ${labels.length} labels — they must match`
      );
    }
  }
  return { labels, series };
}

/**
 * A manual dataset, accepted in two shapes:
 *   structured: { labels: [...], series: [{ name, values: [...] }] }
 *   text:       { data_text: "Label | 10 | 4\n…", series_names: "A, B" }
 * The text form is what the portal editor round-trips (one point per
 * line, values separated by | or ,). Values must be numbers — numeric
 * strings are coerced ("$1,200" → 1200); anything else is rejected.
 */
function normalizeChartData(raw) {
  if (raw == null) return { labels: [], series: [] };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw fail('VALIDATION', 'data must be an object with labels + series (or data_text)');
  }
  if (raw.data_text != null) {
    const namesRaw = raw.series_names;
    const names = Array.isArray(namesRaw)
      ? namesRaw.map((n) => String(n || '').trim().slice(0, 60))
      : String(namesRaw || '')
          .split(',')
          .map((n) => n.trim().slice(0, 60))
          .filter(Boolean);
    const labels = [];
    const columns = [];
    const lines = String(raw.data_text).split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const cells = (trimmed.includes('|') ? trimmed.split('|') : trimmed.split(',')).map((c) => c.trim());
      labels.push(cells[0].slice(0, 80));
      const vals = cells.slice(1);
      if (columns.length && vals.length !== columns.length) {
        throw fail(
          'VALIDATION',
          `Data line "${trimmed.slice(0, 40)}" has ${vals.length} values — every line needs the same count`
        );
      }
      vals.forEach((v, i) => {
        if (!columns[i]) columns[i] = [];
        columns[i].push(chartNumber(v, `line "${cells[0]}", value ${i + 1}`));
      });
    }
    const series = columns.map((values, i) => ({ name: names[i] || `Series ${i + 1}`, values }));
    return finishChartData(labels, series);
  }
  if (raw.labels == null && raw.series == null) return { labels: [], series: [] };
  if (!Array.isArray(raw.labels)) throw fail('VALIDATION', 'data.labels must be an array');
  if (!Array.isArray(raw.series)) throw fail('VALIDATION', 'data.series must be an array');
  const labels = raw.labels.map((l) => String(l == null ? '' : l).slice(0, 80));
  const series = raw.series.map((s, i) => {
    const entry = s && typeof s === 'object' ? s : {};
    if (!Array.isArray(entry.values)) {
      throw fail('VALIDATION', `Series ${i + 1} needs a values array`);
    }
    return {
      name: String(entry.name || `Series ${i + 1}`).trim().slice(0, 60) || `Series ${i + 1}`,
      values: entry.values.map((v, j) => chartNumber(v, `series ${i + 1}, point ${j + 1}`)),
    };
  });
  return finishChartData(labels, series);
}

/** The portal editor's text form of a stored dataset (round-trips). */
function chartDataToText(data) {
  const d = data && typeof data === 'object' ? data : { labels: [], series: [] };
  const labels = Array.isArray(d.labels) ? d.labels : [];
  const series = Array.isArray(d.series) ? d.series : [];
  return labels
    .map((label, i) => [label, ...series.map((s) => (s.values && s.values[i] != null ? s.values[i] : ''))].join(' | '))
    .join('\n');
}

function normalizeChartBinding(columns, raw, base) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {
    label_column: base ? base.label_column : null,
    value_columns: base ? [...base.value_columns] : [],
    aggregation: base ? base.aggregation : 'sum',
  };
  if (src.label_column != null) {
    const key = String(src.label_column || '').trim().toLowerCase();
    out.label_column = key || null;
  }
  if (src.value_columns != null) {
    // The portal editor sends a comma-separated string; MCP sends an array.
    if (typeof src.value_columns === 'string') src.value_columns = src.value_columns.split(',');
    if (!Array.isArray(src.value_columns)) {
      throw fail('VALIDATION', 'value_columns must be an array of column keys');
    }
    const seen = new Set();
    out.value_columns = [];
    for (const v of src.value_columns) {
      const key = String(v || '').trim().toLowerCase();
      if (key && !seen.has(key)) {
        seen.add(key);
        out.value_columns.push(key);
      }
    }
    if (out.value_columns.length > CHART_MAX_SERIES) {
      throw fail('VALIDATION', `A chart can plot at most ${CHART_MAX_SERIES} value columns`);
    }
  }
  if (src.aggregation != null) {
    const a = String(src.aggregation).trim().toLowerCase();
    if (!CHART_AGGREGATIONS.includes(a)) {
      throw fail('VALIDATION', `Invalid aggregation "${src.aggregation}" — use: ${CHART_AGGREGATIONS.join(', ')}`);
    }
    out.aggregation = a;
  }
  // Validate against the table's CURRENT schema whenever the keys are
  // being set (a dangling key stored earlier is pruned at compute time
  // instead — the schema may have changed since the binding was saved).
  const byKey = new Map((columns || []).map((c) => [c.key, c]));
  if (src.label_column != null && out.label_column && !byKey.has(out.label_column)) {
    throw fail('VALIDATION', `Label column "${out.label_column}" is not a column of the site's Data Table`);
  }
  if (src.value_columns != null) {
    for (const key of out.value_columns) {
      const col = byKey.get(key);
      if (!col) throw fail('VALIDATION', `Value column "${key}" is not a column of the site's Data Table`);
      if (out.aggregation !== 'count' && col.type !== 'number' && col.type !== 'currency') {
        throw fail(
          'VALIDATION',
          `Value column "${key}" is a ${col.type} column — charts can only plot number or currency columns`
        );
      }
    }
  }
  return out;
}

function normalizeChartStyle(raw, base) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {
    colors: base ? [...base.colors] : [],
    show_legend: base ? base.show_legend : true,
    show_values: base ? base.show_values : false,
  };
  if (src.colors != null) {
    const colors = normalizeChartColors(src.colors);
    if (colors) out.colors = colors;
  }
  if (src.show_legend != null) out.show_legend = chartBool(src.show_legend, out.show_legend);
  if (src.show_values != null) out.show_values = chartBool(src.show_values, out.show_values);
  return out;
}

/** Flatten a stored binding/style/data patch: sub-objects OR flat keys. */
function chartPatch(data, subKey, flatKeys) {
  const out = {};
  const sub = data && typeof data[subKey] === 'object' && data[subKey] && !Array.isArray(data[subKey]) ? data[subKey] : {};
  for (const k of flatKeys) {
    if (data && data[k] != null) out[k] = data[k];
    else if (sub[k] != null) out[k] = sub[k];
  }
  return out;
}

function shapeChart(row) {
  if (!row) return null;
  let config = {};
  let data = { labels: [], series: [] };
  let style = {};
  try {
    config = JSON.parse(row.config_json || '{}') || {};
  } catch {
    config = {};
  }
  try {
    data = JSON.parse(row.data_json || '') || { labels: [], series: [] };
  } catch {
    data = { labels: [], series: [] };
  }
  try {
    style = JSON.parse(row.style_json || '{}') || {};
  } catch {
    style = {};
  }
  return {
    id: Number(row.id),
    lead_id: Number(row.lead_id),
    title: String(row.title || ''),
    chart_type: CHART_TYPES.includes(row.chart_type) ? row.chart_type : 'bar',
    source: CHART_SOURCES.includes(row.source) ? row.source : 'manual',
    label_column: config.label_column || null,
    value_columns: Array.isArray(config.value_columns) ? config.value_columns : [],
    aggregation: CHART_AGGREGATIONS.includes(config.aggregation) ? config.aggregation : 'sum',
    data: {
      labels: Array.isArray(data.labels) ? data.labels : [],
      series: Array.isArray(data.series) ? data.series : [],
    },
    colors: Array.isArray(style.colors) ? style.colors : [],
    show_legend: style.show_legend !== false,
    show_values: style.show_values === true,
    sort_order: Number(row.sort_order) || 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function listCharts(db, leadId) {
  ensureTables(db);
  return db
    .prepare('SELECT * FROM charts WHERE lead_id = ? ORDER BY sort_order ASC, id ASC')
    .all(Number(leadId))
    .map(shapeChart);
}

function getChart(db, leadId, id) {
  ensureTables(db);
  const row = db
    .prepare('SELECT * FROM charts WHERE lead_id = ? AND id = ?')
    .get(Number(leadId), Number(id));
  return shapeChart(row);
}

function countCharts(db, leadId) {
  ensureTables(db);
  const row = db.prepare('SELECT COUNT(*) AS c FROM charts WHERE lead_id = ?').get(Number(leadId));
  return Number(row && row.c) || 0;
}

/**
 * Merge a create/update patch over the existing chart (or defaults).
 * Binding keys validate against the site's Data Table schema; manual
 * data validates standalone. Returns the storage-shaped record.
 */
function normalizeChartInput(db, leadId, data = {}, existing = null) {
  const tableCfg = getDataTableConfig(db, Number(leadId));
  const binding = normalizeChartBinding(
    tableCfg.columns,
    chartPatch(data, 'config', ['label_column', 'value_columns', 'aggregation']),
    existing
      ? {
          label_column: existing.label_column,
          value_columns: existing.value_columns,
          aggregation: existing.aggregation,
        }
      : null
  );
  const style = normalizeChartStyle(
    chartPatch(data, 'style', ['colors', 'show_legend', 'show_values']),
    existing ? { colors: existing.colors, show_legend: existing.show_legend, show_values: existing.show_values } : null
  );
  let chartType = existing ? existing.chart_type : 'bar';
  if (data.chart_type != null) {
    const t = String(data.chart_type).trim().toLowerCase();
    if (!CHART_TYPES.includes(t)) {
      throw fail('VALIDATION', `Invalid chart type "${data.chart_type}" — use: ${CHART_TYPES.join(', ')}`);
    }
    chartType = t;
  }
  let source = existing ? existing.source : 'manual';
  if (data.source != null) {
    const s = String(data.source).trim().toLowerCase();
    if (!CHART_SOURCES.includes(s)) {
      throw fail('VALIDATION', `Invalid chart source "${data.source}" — use: ${CHART_SOURCES.join(', ')}`);
    }
    source = s;
  }
  let manual = existing ? existing.data : { labels: [], series: [] };
  if (data.data != null) manual = normalizeChartData(data.data);
  else if (data.data_text != null) {
    manual = normalizeChartData({ data_text: data.data_text, series_names: data.series_names });
  }
  return {
    title: data.title != null ? String(data.title).trim().slice(0, 120) : existing ? existing.title : '',
    chart_type: chartType,
    source,
    config: binding,
    data: manual,
    style,
    sort_order:
      data.sort_order != null && Number.isFinite(Number(data.sort_order))
        ? Number(data.sort_order)
        : existing
          ? existing.sort_order
          : null,
  };
}

function createChart(db, leadId, data = {}) {
  ensureTables(db);
  const lid = Number(leadId);
  if (countCharts(db, lid) >= CHART_MAX_CHARTS) {
    throw fail('VALIDATION', `A site can have at most ${CHART_MAX_CHARTS} charts`);
  }
  const norm = normalizeChartInput(db, lid, data, null);
  const sortOrder =
    norm.sort_order != null
      ? norm.sort_order
      : db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM charts WHERE lead_id = ?').get(lid).m + 1;
  const info = db
    .prepare(
      `INSERT INTO charts (lead_id, title, chart_type, source, config_json, data_json, style_json, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      lid,
      norm.title,
      norm.chart_type,
      norm.source,
      JSON.stringify(norm.config),
      JSON.stringify(norm.data),
      JSON.stringify(norm.style),
      sortOrder
    );
  return getChart(db, lid, info.lastInsertRowid);
}

function updateChart(db, leadId, id, data = {}) {
  ensureTables(db);
  const lid = Number(leadId);
  const existing = getChart(db, lid, id);
  if (!existing) throw fail('NOT_FOUND', 'Chart not found', 404);
  const norm = normalizeChartInput(db, lid, data, existing);
  db.prepare(
    `UPDATE charts SET title = ?, chart_type = ?, source = ?, config_json = ?, data_json = ?,
       style_json = ?, sort_order = ?, updated_at = datetime('now') WHERE lead_id = ? AND id = ?`
  ).run(
    norm.title,
    norm.chart_type,
    norm.source,
    JSON.stringify(norm.config),
    JSON.stringify(norm.data),
    JSON.stringify(norm.style),
    norm.sort_order != null ? norm.sort_order : existing.sort_order,
    lid,
    Number(id)
  );
  return getChart(db, lid, id);
}

function deleteChart(db, leadId, id) {
  ensureTables(db);
  const info = db
    .prepare('DELETE FROM charts WHERE lead_id = ? AND id = ?')
    .run(Number(leadId), Number(id));
  if (!info.changes) throw fail('NOT_FOUND', 'Chart not found', 404);
  return { deleted: true };
}

function clearCharts(db, leadId) {
  ensureTables(db);
  const info = db.prepare('DELETE FROM charts WHERE lead_id = ?').run(Number(leadId));
  return { deleted: info.changes };
}

/** A table cell as a chart label, formatted per the column's type. */
function chartLabelText(col, value) {
  if (value == null || value === '') return '(blank)';
  if (!col) return String(value);
  if (col.type === 'boolean') return value ? 'Yes' : 'No';
  if (col.type === 'link' && typeof value === 'object') return String(value.label || value.url || '');
  return String(value);
}

function roundChartValue(n) {
  const r = Math.round((Number(n) || 0) * 100) / 100;
  return r === 0 ? 0 : r;
}

/**
 * The chart's plottable data, from whichever source it is bound to.
 * Table-bound charts read PUBLISHED rows only (pending visitor
 * submissions are never charted) and aggregate per label; stored
 * binding keys that no longer exist in the schema are pruned here,
 * mirroring the Data Tables display-role pruning.
 */
function computeChartData(db, leadId, chart) {
  if (!chart || chart.source !== 'table') {
    const d = chart ? chart.data : { labels: [], series: [] };
    return { labels: [...d.labels], series: d.series.map((s) => ({ name: s.name, values: [...s.values] })), truncated: false };
  }
  const lid = Number(leadId);
  const cfg = getDataTableConfig(db, lid);
  const byKey = new Map(cfg.columns.map((c) => [c.key, c]));
  const labelCol = chart.label_column ? byKey.get(chart.label_column) : null;
  if (!labelCol) return { labels: [], series: [], truncated: false };
  const valueCols = (chart.value_columns || [])
    .map((k) => byKey.get(k))
    .filter((c) => c && (chart.aggregation === 'count' || c.type === 'number' || c.type === 'currency'));
  if (chart.aggregation !== 'count' && !valueCols.length) {
    return { labels: [], series: [], truncated: false };
  }
  const rows = listDataTableRows(db, lid, { includePending: false });
  const cell = (row, key) => (row.values ? row.values[key] : null);
  const num = (row, key) => {
    const v = cell(row, key);
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  };
  if (chart.aggregation === 'none') {
    const capped = rows.slice(0, CHART_MAX_POINTS);
    return {
      labels: capped.map((r) => chartLabelText(labelCol, cell(r, labelCol.key))),
      series: valueCols.map((c) => ({
        name: c.label || c.key,
        values: capped.map((r) => roundChartValue(num(r, c.key) || 0)),
      })),
      truncated: rows.length > CHART_MAX_POINTS,
    };
  }
  // Grouped aggregation: sum / count / average per distinct label.
  const groups = new Map();
  for (const row of rows) {
    const label = chartLabelText(labelCol, cell(row, labelCol.key));
    if (!groups.has(label)) groups.set(label, { count: 0, sums: valueCols.map(() => 0), nums: valueCols.map(() => 0) });
    const g = groups.get(label);
    g.count += 1;
    valueCols.forEach((c, i) => {
      const v = num(row, c.key);
      if (v != null) {
        g.sums[i] += v;
        g.nums[i] += 1;
      }
    });
  }
  const allLabels = [...groups.keys()];
  const labels = allLabels.slice(0, CHART_MAX_POINTS);
  let series;
  if (chart.aggregation === 'count') {
    series = [{ name: 'Count', values: labels.map((l) => groups.get(l).count) }];
  } else {
    series = valueCols.map((c, i) => ({
      name: c.label || c.key,
      values: labels.map((l) => {
        const g = groups.get(l);
        if (chart.aggregation === 'average') {
          return g.nums[i] ? roundChartValue(g.sums[i] / g.nums[i]) : 0;
        }
        return roundChartValue(g.sums[i]);
      }),
    }));
  }
  return { labels, series, truncated: allLabels.length > CHART_MAX_POINTS };
}

/** One chart as the public site renders it: definition + computed data. */
function publicChart(chart, computed) {
  return {
    id: chart.id,
    title: chart.title,
    chart_type: chart.chart_type,
    colors: chart.colors.length ? chart.colors : CHART_DEFAULT_COLORS,
    show_legend: chart.show_legend,
    show_values: chart.show_values,
    labels: computed.labels,
    series: computed.series,
  };
}

/** The public (visitor) view: every chart with its computed data. */
function publicChartsPayload(db, leadId) {
  const charts = listCharts(db, Number(leadId)).map((chart) =>
    publicChart(chart, computeChartData(db, Number(leadId), chart))
  );
  return { charts };
}

/** Everything the owner/agent surfaces need in one read. */
function getChartsModule(db, leadId) {
  const lid = Number(leadId);
  const charts = listCharts(db, lid).map((chart) => ({
    ...chart,
    computed: computeChartData(db, lid, chart),
  }));
  const table = getDataTableConfig(db, lid);
  return {
    charts,
    chart_count: charts.length,
    datatable: {
      configured: table.columns.length > 0,
      title: table.title,
      columns: table.columns,
    },
  };
}

/* ── Call Tracking (Twilio Voice) ────────────────────────────────────────────
 *
 * Client/admin split (Batch 25c, Ely 2026-10-26): the client only ever
 * provides their own phone number — it lands on leads.phone, shows on
 * the site as the call button's text, and becomes the forwarding
 * destination (redirect_number). ALL forwarding configuration is
 * admin-side: display_number (the Twilio tracking number the button
 * actually dials), redirect on/off, recording, notify, button label.
 * Twilio posts inbound calls to
 * /api/v1/calls/voice/:workspaceId/:leadId (server/routes/calls.js);
 * when redirect is on, the TwiML dials redirect_number (the business's
 * real phone) with callerId = the display number, so the business sees
 * the tracking number on their phone. Every call is logged in
 * call_logs; finished calls capture a LeadScout contact from the
 * caller's number. Recording is opt-in per lead (record_calls) with a
 * spoken consent notice; transcripts land asynchronously via
 * twilioClient and never block a webhook.
 */

const CALL_TRACKING_DEFAULT_CTA = 'Call us';
const CALL_TERMINAL_STATUSES = ['completed', 'busy', 'no-answer', 'failed', 'canceled'];
const CALL_LIST_CAP = 200;

/* Charging model (Batch 21, addendum #3 — Ely approved): the
 * subscription carries call tracking; credits meter the extras. SOFT
 * CAPS ONLY — calls are never blocked, cut off, or un-forwarded for
 * billing reasons. Answered-call allowances per plan per calendar
 * month (UTC); a call counts when it completes with >= 15s duration.
 * Each completed block of CALL_OVERAGE_BLOCK over-cap calls costs 1
 * credit (server/callBilling.js settles via the credits engine). */
const CALL_ALLOWANCE_BY_PLAN = { free: 0, standard: 60, pro: 150, premium: 100000 };
const CALL_COUNT_MIN_SECONDS = 15;
const CALL_OVERAGE_BLOCK = 10;

function callAllowanceForPlan(planId) {
  const key = String(planId || 'free').toLowerCase();
  return Object.prototype.hasOwnProperty.call(CALL_ALLOWANCE_BY_PLAN, key)
    ? CALL_ALLOWANCE_BY_PLAN[key]
    : 0;
}

function currentCallMonth(date = new Date()) {
  return date.toISOString().slice(0, 7); // 'YYYY-MM' in UTC
}

/**
 * Free-plan gate for ACTIVATING call tracking with a display number.
 * A lead that already has a number keeps it (and keeps receiving
 * calls) on any plan — only putting a first number on a free plan is
 * blocked. Throws a PLAN_REQUIRED error the surfaces render as an
 * upgrade message.
 */
function assertCallTrackingActivation(config, body, planId) {
  if (String(planId || 'free').toLowerCase() !== 'free') return;
  const src = body || {};
  const requested = String(
    src.display_number != null ? src.display_number : src.displayNumber != null ? src.displayNumber : ''
  ).trim();
  // Batch 26d: claiming rotation numbers is a first tracking number
  // too — same paid-plan gate as a first display number.
  const rotationRequested =
    Array.isArray(src.rotation_numbers) && src.rotation_numbers.some((n) => String(n || '').trim());
  if (!requested && !rotationRequested) return;
  if (config && String(config.display_number || '').trim()) return;
  const err = new Error(
    'Call Tracking with a number requires a paid plan. Upgrade the plan to add a display number — calls to a number already on the account keep working on any plan.'
  );
  err.code = 'PLAN_REQUIRED';
  err.status = 402;
  throw err;
}

/**
 * Normalize a phone number to E.164 (+<country><number>). US 10-digit
 * and 1+10-digit inputs are accepted and prefixed; anything else must
 * already carry its country code. Garbage is a VALIDATION error —
 * settings saves reject it with a clear message. '' → ''.
 */
function normalizeE164(value, label = 'Phone number') {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return '';
  const hasPlus = raw.startsWith('+');
  const digits = raw.replace(/\D/g, '');
  let out = '';
  if (hasPlus) out = `+${digits}`;
  else if (digits.length === 10) out = `+1${digits}`;
  else if (digits.length === 11 && digits.startsWith('1')) out = `+${digits}`;
  else if (digits.length >= 7) out = `+${digits}`;
  if (!/^\+[1-9]\d{6,14}$/.test(out)) {
    throw fail(
      'VALIDATION',
      `${label} must be a valid phone number in international format (e.g. +16105551234).`
    );
  }
  return out;
}

/** Friendly rendering for a stored E.164 number (+1 US → (610) 555-1234). */
function formatPhoneDisplay(e164) {
  const v = String(e164 || '').trim();
  const m = v.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  if (m) return `(${m[1]}) ${m[2]}-${m[3]}`;
  return v;
}

function shapeCallTrackingConfig(row, leadId) {
  if (!row) {
    return {
      lead_id: Number(leadId),
      display_number: '',
      cta_text: CALL_TRACKING_DEFAULT_CTA,
      redirect_enabled: true,
      redirect_number: '',
      record_calls: false,
      notify_email: true,
      voicemail_enabled: true,
      rotate_enabled: false,
      rotation_numbers: [],
      twilio_number_sid: '',
      updated_at: null,
    };
  }
  return {
    ...row,
    redirect_enabled: !!row.redirect_enabled,
    record_calls: !!row.record_calls,
    notify_email: row.notify_email == null ? true : !!row.notify_email,
    // Batch 26c: voicemail greeting defaults ON wherever a config
    // exists; an admin turns it off per business.
    voicemail_enabled: row.voicemail_enabled == null ? true : !!row.voicemail_enabled,
    // Batch 26d: rotation is opt-in per setup (default off).
    rotate_enabled: !!row.rotate_enabled,
  };
}

function readCallTrackingConfig(db, leadId) {
  ensureTables(db);
  const row = db.prepare('SELECT * FROM calltracking_configs WHERE lead_id = ?').get(Number(leadId));
  const shaped = shapeCallTrackingConfig(row, leadId);
  // Batch 26d: the rotation set rides along on the config shape (the
  // numbers are public — they render on the site — so this is safe on
  // every surface that already reads the full config).
  shaped.rotation_numbers = getRotationNumbers(db, leadId);
  return shaped;
}

function getCallTrackingConfig(db, leadId) {
  ensureTables(db);
  const id = Number(leadId);
  const existing = db.prepare('SELECT lead_id FROM calltracking_configs WHERE lead_id = ?').get(id);
  if (!existing) {
    db.prepare('INSERT INTO calltracking_configs (lead_id) VALUES (?)').run(id);
  }
  return readCallTrackingConfig(db, id);
}

function updateCallTrackingConfig(db, leadId, data = {}) {
  ensureTables(db);
  const row = getCallTrackingConfig(db, leadId);
  const displayNumber =
    data.display_number != null || data.displayNumber != null
      ? normalizeE164(data.display_number != null ? data.display_number : data.displayNumber, 'Display number')
      : row.display_number;
  const redirectNumber =
    data.redirect_number != null || data.redirectNumber != null
      ? normalizeE164(
          data.redirect_number != null ? data.redirect_number : data.redirectNumber,
          'Redirect number'
        )
      : row.redirect_number;
  const ctaText =
    data.cta_text != null || data.ctaText != null
      ? String(data.cta_text != null ? data.cta_text : data.ctaText)
          .trim()
          .slice(0, 60) || CALL_TRACKING_DEFAULT_CTA
      : row.cta_text;
  const redirectEnabled =
    data.redirect_enabled != null || data.redirectEnabled != null
      ? data.redirect_enabled != null
        ? !!data.redirect_enabled
        : !!data.redirectEnabled
      : row.redirect_enabled;
  const recordCalls =
    data.record_calls != null || data.recordCalls != null
      ? data.record_calls != null
        ? !!data.record_calls
        : !!data.recordCalls
      : row.record_calls;
  const notifyEmail =
    data.notify_email != null || data.notifyEmail != null
      ? data.notify_email != null
        ? !!data.notify_email
        : !!data.notifyEmail
      : row.notify_email;
  const voicemailEnabled =
    data.voicemail_enabled != null || data.voicemailEnabled != null
      ? data.voicemail_enabled != null
        ? !!data.voicemail_enabled
        : !!data.voicemailEnabled
      : row.voicemail_enabled;
  const numberSid =
    data.twilio_number_sid != null || data.twilioNumberSid != null
      ? String(data.twilio_number_sid != null ? data.twilio_number_sid : data.twilioNumberSid)
          .trim()
          .slice(0, 64)
      : row.twilio_number_sid;
  db.prepare(
    `UPDATE calltracking_configs
     SET display_number = ?, cta_text = ?, redirect_enabled = ?, redirect_number = ?,
         record_calls = ?, notify_email = ?, voicemail_enabled = ?, twilio_number_sid = ?, updated_at = datetime('now')
     WHERE lead_id = ?`
  ).run(
    displayNumber,
    ctaText,
    redirectEnabled ? 1 : 0,
    redirectNumber,
    recordCalls ? 1 : 0,
    notifyEmail ? 1 : 0,
    voicemailEnabled ? 1 : 0,
    numberSid,
    Number(leadId)
  );
  return getCallTrackingConfig(db, leadId);
}

/* ------------------------------------------------------------------ */
/* Twilio number pool + rotation (Batch 26d — Ely 2026-10-26)          */
/*                                                                     */
/* Staff register the Twilio numbers they purchased in a per-        */
/* workspace pool (twilio_numbers). A forwarding setup claims pool    */
/* numbers — as its primary display_number and/or, with Rotate on,    */
/* in a rotation set of up to 5 — and a pool number can be actively   */
/* claimed by only ONE setup at a time. "Actively claimed" = the       */
/* setup's primary, plus its rotation set while rotation is enabled;  */
/* a stored-but-disabled set claims nothing, so turning Rotate off    */
/* frees its numbers. Every claimed number forwards to the setup's    */
/* single redirect_number because the voice route resolves the        */
/* config by lead, not by dialed number.                              */
/* ------------------------------------------------------------------ */

const ROTATION_MAX_NUMBERS = 5;

function rotationError(code, status, message) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

/** The stored rotation set for a setup, in slot order. */
function getRotationNumbers(db, leadId) {
  ensureTables(db);
  try {
    return db
      .prepare(
        'SELECT phone_number FROM calltracking_rotation_numbers WHERE lead_id = ? ORDER BY position ASC, phone_number ASC'
      )
      .all(Number(leadId))
      .map((r) => String(r.phone_number || ''))
      .filter(Boolean);
  } catch (e) {
    console.warn('[siteModules] getRotationNumbers:', e.message || e);
    return [];
  }
}

function poolNumberRow(db, workspaceId, phoneNumber) {
  ensureTables(db);
  return (
    db
      .prepare('SELECT * FROM twilio_numbers WHERE workspace_id = ? AND phone_number = ?')
      .get(Number(workspaceId) || 0, String(phoneNumber || '')) || null
  );
}

/**
 * Who actively claims a number right now: { lead_id, lead_name, role }
 * or null. role is 'primary' (the setup's display_number) or 'rotation'
 * (in its set while Rotate is on). exceptLeadId ignores one setup.
 */
function findNumberClaim(db, phoneNumber, exceptLeadId = 0) {
  ensureTables(db);
  const num = String(phoneNumber || '');
  if (!num) return null;
  const except = Number(exceptLeadId) || 0;
  const primary = db
    .prepare(
      `SELECT c.lead_id, l.business_name
       FROM calltracking_configs c LEFT JOIN leads l ON l.id = c.lead_id
       WHERE c.display_number = ? AND c.lead_id != ?`
    )
    .get(num, except);
  if (primary) {
    return { lead_id: Number(primary.lead_id), lead_name: primary.business_name || '', role: 'primary' };
  }
  const rotation = db
    .prepare(
      `SELECT r.lead_id, l.business_name
       FROM calltracking_rotation_numbers r
       JOIN calltracking_configs c ON c.lead_id = r.lead_id AND c.rotate_enabled = 1
       LEFT JOIN leads l ON l.id = r.lead_id
       WHERE r.phone_number = ? AND r.lead_id != ?`
    )
    .get(num, except);
  if (rotation) {
    return { lead_id: Number(rotation.lead_id), lead_name: rotation.business_name || '', role: 'rotation' };
  }
  return null;
}

/** The set of numbers a setup actively claims (primary ∪ live rotation). */
function claimedNumbersFor(db, leadId, config) {
  const cfg = config || readCallTrackingConfig(db, leadId);
  const out = new Set();
  const primary = String(cfg.display_number || '').trim();
  if (primary) out.add(primary);
  if (cfg.rotate_enabled) {
    for (const n of getRotationNumbers(db, leadId)) out.add(n);
  }
  return out;
}

/** Pool list with each number's current assignment (or null). */
function listTwilioNumberPool(db, workspaceId) {
  ensureTables(db);
  const rows = db
    .prepare('SELECT * FROM twilio_numbers WHERE workspace_id = ? ORDER BY phone_number ASC')
    .all(Number(workspaceId) || 0);
  return rows.map((r) => ({
    id: Number(r.id),
    workspace_id: Number(r.workspace_id) || 0,
    phone_number: r.phone_number || '',
    label: r.label || '',
    twilio_sid: r.twilio_sid || '',
    created_at: r.created_at || null,
    assignment: findNumberClaim(db, r.phone_number, 0),
  }));
}

/** Register a verified-owned number in the pool. Idempotent per number. */
function addTwilioNumberToPool(db, workspaceId, { phoneNumber, label, twilioSid } = {}) {
  ensureTables(db);
  const num = normalizeE164(phoneNumber, 'Phone number');
  if (!num) throw rotationError('VALIDATION', 400, 'A phone number is required.');
  const existing = poolNumberRow(db, workspaceId, num);
  if (existing) {
    return {
      id: Number(existing.id),
      workspace_id: Number(existing.workspace_id) || 0,
      phone_number: existing.phone_number,
      label: existing.label || '',
      twilio_sid: existing.twilio_sid || '',
      created_at: existing.created_at || null,
      already_present: true,
      assignment: findNumberClaim(db, num, 0),
    };
  }
  const info = db
    .prepare('INSERT INTO twilio_numbers (workspace_id, phone_number, label, twilio_sid) VALUES (?, ?, ?, ?)')
    .run(
      Number(workspaceId) || 0,
      num,
      String(label || '').trim().slice(0, 80),
      String(twilioSid || '').trim().slice(0, 64)
    );
  const row = db.prepare('SELECT * FROM twilio_numbers WHERE id = ?').get(info.lastInsertRowid);
  return {
    id: Number(row.id),
    workspace_id: Number(row.workspace_id) || 0,
    phone_number: row.phone_number,
    label: row.label || '',
    twilio_sid: row.twilio_sid || '',
    created_at: row.created_at || null,
    already_present: false,
    assignment: null,
  };
}

/**
 * Remove a pool number. Blocked while any setup actively claims it —
 * the error names the business so staff know where it is used.
 */
function removeTwilioNumberFromPool(db, workspaceId, { id, phoneNumber } = {}) {
  ensureTables(db);
  let row = null;
  if (id != null && Number(id) > 0) {
    row = db
      .prepare('SELECT * FROM twilio_numbers WHERE workspace_id = ? AND id = ?')
      .get(Number(workspaceId) || 0, Number(id));
  }
  if (!row && phoneNumber) {
    row = poolNumberRow(db, workspaceId, normalizeE164(phoneNumber, 'Phone number'));
  }
  if (!row) throw rotationError('NOT_FOUND', 404, 'That number is not in the pool.');
  const claim = findNumberClaim(db, row.phone_number, 0);
  if (claim) {
    throw rotationError(
      'NUMBER_ASSIGNED',
      409,
      `${row.phone_number} is in use by ${claim.lead_name || 'another business'} (${claim.role === 'primary' ? 'its tracking number' : 'its rotation'}) — remove it from that forwarding setup first.`
    );
  }
  db.prepare('DELETE FROM twilio_numbers WHERE id = ?').run(row.id);
  return { removed: true, id: Number(row.id), phone_number: row.phone_number };
}

/**
 * Validate + persist a setup's rotation flag and set.
 * - numbers: pool numbers only, deduped in slot order, at most 5.
 * - the setup's primary number is dropped from the set (it already
 *   displays full-time; a slot would be wasted on it).
 * - exclusivity: no member may be actively claimed by another setup.
 * Writes the set + rotate_enabled flag; returns the persisted state.
 */
function setCallTrackingRotation(db, leadId, { rotateEnabled, numbers, primaryNumber, workspaceId } = {}) {
  ensureTables(db);
  const id = Number(leadId);
  getCallTrackingConfig(db, id); // ensure the config row exists
  const primary = String(primaryNumber || '').trim();
  const seen = new Set();
  const clean = [];
  for (const raw of Array.isArray(numbers) ? numbers : []) {
    const num = normalizeE164(raw, 'Rotation number');
    if (!num || seen.has(num)) continue;
    seen.add(num);
    if (num === primary) continue;
    clean.push(num);
  }
  if (clean.length > ROTATION_MAX_NUMBERS) {
    throw rotationError(
      'VALIDATION',
      400,
      `Rotation is limited to ${ROTATION_MAX_NUMBERS} numbers per forwarding setup.`
    );
  }
  // Pool membership + exclusivity are enforced for the ACTIVE set.
  // A stored set under Rotate-off claims nothing, so it is only
  // normalized/capped here — it is fully revalidated when re-enabled.
  if (rotateEnabled) {
    for (const num of clean) {
      if (!poolNumberRow(db, workspaceId, num)) {
        throw rotationError(
          'VALIDATION',
          400,
          `${num} is not in the Twilio numbers pool — add it to the pool first, then it can join a rotation.`
        );
      }
      const claim = findNumberClaim(db, num, id);
      if (claim) {
        throw rotationError(
          'NUMBER_IN_USE',
          409,
          `${num} is already used by ${claim.lead_name || 'another business'} (${claim.role === 'primary' ? 'its tracking number' : 'its rotation'}). A number can serve only one forwarding setup at a time.`
        );
      }
    }
  }
  db.prepare('DELETE FROM calltracking_rotation_numbers WHERE lead_id = ?').run(id);
  const insert = db.prepare(
    'INSERT INTO calltracking_rotation_numbers (lead_id, phone_number, position) VALUES (?, ?, ?)'
  );
  clean.forEach((num, i) => insert.run(id, num, i));
  db.prepare('UPDATE calltracking_configs SET rotate_enabled = ?, updated_at = datetime(\'now\') WHERE lead_id = ?').run(
    rotateEnabled ? 1 : 0,
    id
  );
  return { rotate_enabled: !!rotateEnabled, rotation_numbers: clean };
}

/** Best-effort E.164 for a number stored outside the call-tracking
 * config (leads.phone is free-form). '' when nothing dialable remains. */
function coercePhoneE164(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return '';
  try {
    return normalizeE164(raw, 'Phone number');
  } catch {
    const digits = raw.replace(/\D/g, '');
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length >= 7 && digits.length <= 15) return `+${digits}`;
    return '';
  }
}

/** The lead's own phone number (leads.phone), coerced to E.164. */
function leadPhoneE164(db, leadId) {
  try {
    const row = db.prepare('SELECT phone FROM leads WHERE id = ?').get(Number(leadId));
    return coercePhoneE164(row && row.phone);
  } catch {
    return '';
  }
}

/** Public-safe payload: only what the site may show (Batch 25c split,
 * rendering rule corrected by Batch 25c-fix per Ely 2026-10-26 21:46).
 * The call button displays the Twilio tracking number (display_number)
 * as BOTH its text and its tel: target, so visitors call the tracking
 * number and Twilio forwards + logs. The number the client provided
 * (leads.phone / redirect_number) is the forward-to destination ONLY —
 * it is never exposed in this payload and never renders on the site.
 * Fallback before admin assigns a tracking number: the button shows and
 * dials leads.phone, the only callable number that exists yet; once a
 * tracking number is assigned it takes over the display completely. */
function publicCallTrackingPayload(db, leadId) {
  const config = readCallTrackingConfig(db, leadId);
  let tracking = String(config.display_number || '').trim();
  // Batch 26d rotation: with Rotate on and a non-empty set, the button
  // shows/dials a set member instead of the single tracking number.
  // Round-robin via a persisted counter on the config row, so page
  // loads share the numbers evenly; every member still forwards to
  // the setup's one redirect_number (the voice route resolves the
  // config by lead). Rotate off / empty set → exactly the single-
  // number behavior.
  const rotationSet = config.rotate_enabled ? (config.rotation_numbers || []).filter(Boolean) : [];
  if (rotationSet.length) {
    const counter = Number(config.rotate_counter) || 0;
    tracking = rotationSet[counter % rotationSet.length];
    try {
      db.prepare('UPDATE calltracking_configs SET rotate_counter = ? WHERE lead_id = ?').run(
        counter + 1,
        Number(leadId)
      );
    } catch {
      /* read-only handle / race — this load still got its number */
    }
  }
  const shown = tracking || leadPhoneE164(db, leadId);
  if (!shown) return { configured: false };
  return {
    configured: true,
    display_number: shown,
    display_number_formatted: formatPhoneDisplay(shown),
    tracking_number: tracking,
    cta_text: config.cta_text || CALL_TRACKING_DEFAULT_CTA,
  };
}

function xmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * TwiML for an inbound call to a lead's tracking number.
 * - not configured → hangup (nothing to route to, say nothing)
 * - recording on → consent notice first; <Dial record> fires the
 *   recording callback as the call is answered
 * - redirect on + number set → <Dial callerId=display_number> to the
 *   redirect number; the Dial action posts the outcome to the status URL
 * - redirect off → a short spoken pointer to the website, then hangup
 */
function buildCallTrackingVoiceTwiml(config, { workspaceId, leadId, baseUrl } = {}) {
  const head = '<?xml version="1.0" encoding="UTF-8"?>';
  if (!config || !config.display_number) return `${head}<Response><Hangup/></Response>`;
  const base = String(baseUrl || '').replace(/\/$/, '');
  const statusUrl = `${base}/api/v1/calls/status/${Number(workspaceId)}/${Number(leadId)}`;
  let out = `${head}<Response>`;
  if (config.record_calls) {
    out += '<Say>This call may be recorded for quality purposes.</Say>';
  }
  if (config.redirect_enabled && config.redirect_number) {
    const recordAttrs = config.record_calls
      ? ` record="record-from-answer-dual" recordingStatusCallback="${xmlEscape(
          `${base}/api/v1/calls/recording/${Number(workspaceId)}/${Number(leadId)}`
        )}" recordingStatusCallbackMethod="POST"`
      : '';
    out +=
      `<Dial callerId="${xmlEscape(config.display_number)}" action="${xmlEscape(statusUrl)}" method="POST"${recordAttrs}>` +
      `${xmlEscape(config.redirect_number)}</Dial>`;
  } else {
    out +=
      '<Say>Thanks for calling. Please reach us through our website and we will get right back to you.</Say><Hangup/>';
  }
  return `${out}</Response>`;
}

/* Voicemail (Batch 26c — Ely 2026-10-26): when the forwarded call is
 * not answered (Dial action reports no-answer / busy / failed), the
 * caller hears a greeting spoken with the business's name and is
 * invited to leave a message. The <Record> posts to the SAME recording
 * webhook as answered-call recordings — flagged ?vm=1 so the recording
 * is stored as a voicemail, transcribed through the existing billing
 * path, and emailed to the owner (server/voicemailNotify.js). The
 * greeting is the whole experience: no separate recording notice is
 * stacked on top of it (leaving a voicemail is inherently a recording
 * the caller chooses to make). */
const VOICEMAIL_MAX_SECONDS = 120;

function buildVoicemailTwiml(config, { workspaceId, leadId, baseUrl, businessName } = {}) {
  const head = '<?xml version="1.0" encoding="UTF-8"?>';
  const base = String(baseUrl || '').replace(/\/$/, '');
  const recordingUrl =
    `${base}/api/v1/calls/recording/${Number(workspaceId)}/${Number(leadId)}?vm=1`;
  const name = String(businessName || '').trim();
  const greeting = name
    ? `Thanks for calling ${name}. We're sorry we missed your call. Please leave your name, number, and a brief message after the tone, and we'll get back to you as soon as we can.`
    : `Thanks for calling. We're sorry we missed your call. Please leave your name, number, and a brief message after the tone, and we'll get back to you as soon as we can.`;
  return (
    `${head}<Response>` +
    `<Say>${xmlEscape(greeting)}</Say>` +
    `<Record maxLength="${VOICEMAIL_MAX_SECONDS}" playBeep="true" finishOnKey="#" ` +
    `action="${xmlEscape(recordingUrl)}" method="POST" ` +
    `recordingStatusCallback="${xmlEscape(recordingUrl)}" recordingStatusCallbackMethod="POST"/>` +
    `</Response>`
  );
}

function getCallLogBySid(db, callSid) {
  ensureTables(db);
  return db.prepare('SELECT * FROM call_logs WHERE call_sid = ?').get(String(callSid || '')) || null;
}

/** Batch 26: the site-rental stamp for a call being logged (lazy +
 *  guarded — stamping must never break a Twilio webhook). */
function callRentalStamp(db, leadId) {
  try {
    return require('./rentals').resolveStamp(db, leadId);
  } catch {
    return { websiteId: null, tenantLeadId: null, rentalId: null };
  }
}

/** Log the inbound leg when Twilio first posts the voice webhook. */
function logCallInitiated(db, leadId, { callSid, from, to, verified } = {}) {
  ensureTables(db);
  const sid = String(callSid || '').trim();
  if (!sid) return null;
  const stamp = callRentalStamp(db, leadId);
  db.prepare(
    `INSERT INTO call_logs (lead_id, call_sid, from_number, to_number, status, verified, website_id, tenant_lead_id, rental_id)
     VALUES (?, ?, ?, ?, 'initiated', ?, ?, ?, ?)
     ON CONFLICT(call_sid) DO UPDATE SET
       verified = MAX(call_logs.verified, excluded.verified),
       updated_at = datetime('now')`
  ).run(
    Number(leadId),
    sid,
    String(from || '').slice(0, 40),
    String(to || '').slice(0, 40),
    verified ? 1 : 0,
    stamp.websiteId,
    stamp.tenantLeadId,
    stamp.rentalId
  );
  return getCallLogBySid(db, sid);
}

/**
 * Merge a Twilio status / Dial-action callback into the call_logs row
 * keyed by CallSid. DialCallStatus/DialCallDuration win over the parent
 * CallStatus/CallDuration when both are present. Returns the row.
 */
function upsertCallStatus(db, leadId, params = {}, { verified } = {}) {
  ensureTables(db);
  const sid = String(params.CallSid || '').trim();
  if (!sid) return null;
  const status = String(params.DialCallStatus || params.CallStatus || '').trim();
  const durationRaw = params.DialCallDuration != null ? params.DialCallDuration : params.CallDuration;
  const duration = durationRaw != null && durationRaw !== '' && Number.isFinite(Number(durationRaw))
    ? Math.max(0, Math.round(Number(durationRaw)))
    : null;
  const existing = getCallLogBySid(db, sid);
  if (!existing) {
    const stamp = callRentalStamp(db, leadId);
    db.prepare(
      `INSERT INTO call_logs (lead_id, call_sid, from_number, to_number, status, duration_seconds, verified, website_id, tenant_lead_id, rental_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      Number(leadId),
      sid,
      String(params.From || '').slice(0, 40),
      String(params.To || '').slice(0, 40),
      status || 'initiated',
      duration,
      verified ? 1 : 0,
      stamp.websiteId,
      stamp.tenantLeadId,
      stamp.rentalId
    );
  } else {
    db.prepare(
      `UPDATE call_logs SET
         status = CASE WHEN ? <> '' THEN ? ELSE status END,
         duration_seconds = COALESCE(?, duration_seconds),
         from_number = CASE WHEN ? <> '' THEN ? ELSE from_number END,
         to_number = CASE WHEN ? <> '' THEN ? ELSE to_number END,
         verified = MAX(verified, ?),
         updated_at = datetime('now')
       WHERE call_sid = ?`
    ).run(
      status,
      status,
      duration,
      String(params.From || ''),
      String(params.From || ''),
      String(params.To || ''),
      String(params.To || ''),
      verified ? 1 : 0,
      sid
    );
  }
  // A Dial-action callback can also carry the finished recording.
  if (params.RecordingUrl || params.RecordingSid) {
    storeCallRecording(db, sid, {
      recordingSid: params.RecordingSid,
      recordingUrl: params.RecordingUrl,
      recordingDuration: params.RecordingDuration,
    });
  }
  // Billing counter (addendum #3): a call counts toward the plan's
  // monthly answered allowance once it has completed with at least
  // CALL_COUNT_MIN_SECONDS of talk time. Sticky — never un-counts.
  const rowNow = getCallLogBySid(db, sid);
  if (
    rowNow &&
    !rowNow.counted &&
    String(rowNow.status || '').toLowerCase() === 'completed' &&
    Number(rowNow.duration_seconds || 0) >= CALL_COUNT_MIN_SECONDS
  ) {
    db.prepare('UPDATE call_logs SET counted = 1 WHERE call_sid = ?').run(sid);
  }
  return getCallLogBySid(db, sid);
}

/** Store recording facts (from the recording callback or a Dial action).
 * `voicemail: true` flags the call as a voicemail (Batch 26c) — set by
 * the recording route when the callback carries the ?vm=1 marker the
 * voicemail <Record> was built with. Sticky: never un-flags. */
function storeCallRecording(db, callSid, { recordingSid, recordingUrl, recordingDuration, voicemail } = {}) {
  ensureTables(db);
  const sid = String(callSid || '').trim();
  if (!sid) return null;
  const dur =
    recordingDuration != null && recordingDuration !== '' && Number.isFinite(Number(recordingDuration))
      ? Math.max(0, Math.round(Number(recordingDuration)))
      : null;
  db.prepare(
    `UPDATE call_logs SET
       recording_sid = CASE WHEN ? <> '' THEN ? ELSE recording_sid END,
       recording_url = CASE WHEN ? <> '' THEN ? ELSE recording_url END,
       recording_duration = COALESCE(?, recording_duration),
       is_voicemail = MAX(is_voicemail, ?),
       updated_at = datetime('now')
     WHERE call_sid = ?`
  ).run(
    String(recordingSid || ''),
    String(recordingSid || ''),
    String(recordingUrl || ''),
    String(recordingUrl || ''),
    dur,
    voicemail ? 1 : 0,
    sid
  );
  return getCallLogBySid(db, sid);
}

function setCallTranscript(db, callSid, { status, text } = {}) {
  ensureTables(db);
  const sid = String(callSid || '').trim();
  if (!sid) return null;
  db.prepare(
    `UPDATE call_logs SET
       transcript_status = ?,
       transcript = CASE WHEN ? <> '' THEN ? ELSE transcript END,
       updated_at = datetime('now')
     WHERE call_sid = ?`
  ).run(String(status || 'none'), String(text || ''), String(text || ''), sid);
  return getCallLogBySid(db, sid);
}

function isTerminalCallStatus(status) {
  return CALL_TERMINAL_STATUSES.includes(String(status || '').trim().toLowerCase());
}

/* ------------------------------------------------------------------ */
/* Lead calling (Batch 162) — outbound staff calls + follow-up notes.  */
/* Outbound rows share call_logs with the inbound log: direction is   */
/* 'outbound', call_sid is OUR ref (outbound-<uuid>) so every         */
/* existing sid-keyed helper (recording store, transcript, playback)  */
/* works unchanged, and provider_call_sid carries the Twilio lead     */
/* leg's real SID. Outbound status writes deliberately do NOT reuse   */
/* upsertCallStatus: that path marks inbound calls "counted" toward   */
/* the client's call-tracking allowance — a staff sales call must     */
/* never consume it, and must never settle inbound billing, fire the  */
/* owner notification, or open a missed-call rescue.                  */
/* ------------------------------------------------------------------ */

function createOutboundCall(db, leadId, { callRef, fromNumber, toNumber, staffUserId, staffName, room } = {}) {
  ensureTables(db);
  const ref = String(callRef || '').trim();
  if (!ref) return null;
  db.prepare(
    `INSERT INTO call_logs (lead_id, call_sid, direction, from_number, to_number, status, staff_user_id, staff_name, conference_name)
     VALUES (?, ?, 'outbound', ?, ?, 'initiated', ?, ?, ?)`
  ).run(
    Number(leadId),
    ref,
    String(fromNumber || '').slice(0, 40),
    String(toNumber || '').slice(0, 40),
    staffUserId != null ? Number(staffUserId) : null,
    String(staffName || '').slice(0, 120),
    String(room || '').slice(0, 120)
  );
  return getCallLogBySid(db, ref);
}

/** Claim the dial step exactly once: initiated → dialing. */
function claimOutboundDial(db, callRef) {
  ensureTables(db);
  const r = db
    .prepare(
      `UPDATE call_logs SET status = 'dialing', updated_at = datetime('now')
       WHERE call_sid = ? AND direction = 'outbound' AND status = 'initiated' AND provider_call_sid = ''`
    )
    .run(String(callRef || ''));
  return Number(r.changes || 0) === 1;
}

function setOutboundProviderSid(db, callRef, providerSid) {
  ensureTables(db);
  db.prepare(
    `UPDATE call_logs SET provider_call_sid = ?, status = 'ringing', updated_at = datetime('now')
     WHERE call_sid = ? AND direction = 'outbound'`
  ).run(String(providerSid || '').slice(0, 64), String(callRef || ''));
  return getCallLogBySid(db, String(callRef || ''));
}

/** Outbound-only status merge (see the header note: no counting, no
 * billing settlement, no notifications — those are inbound concepts). */
function updateOutboundCallStatus(db, callRef, { status, durationSeconds } = {}) {
  ensureTables(db);
  const st = String(status || '').trim().toLowerCase();
  const dur =
    durationSeconds != null && durationSeconds !== '' && Number.isFinite(Number(durationSeconds))
      ? Math.max(0, Math.round(Number(durationSeconds)))
      : null;
  db.prepare(
    `UPDATE call_logs SET
       status = CASE WHEN ? <> '' THEN ? ELSE status END,
       duration_seconds = COALESCE(?, duration_seconds),
       updated_at = datetime('now')
     WHERE call_sid = ? AND direction = 'outbound'`
  ).run(st, st, dur, String(callRef || ''));
  return getCallLogBySid(db, String(callRef || ''));
}

function listOutboundCalls(db, leadId, { limit = CALL_LIST_CAP } = {}) {
  ensureTables(db);
  const lim = Math.min(CALL_LIST_CAP, Math.max(1, Number(limit) || CALL_LIST_CAP));
  return db
    .prepare(
      `SELECT * FROM call_logs WHERE lead_id = ? AND direction = 'outbound' ORDER BY id DESC LIMIT ?`
    )
    .all(Number(leadId), lim);
}

/** Preserve the Whisper original the first time it exists (called
 * after a transcription lands, and lazily before a staff edit). */
function stampTranscriptOriginal(db, callSid) {
  ensureTables(db);
  db.prepare(
    `UPDATE call_logs SET transcript_original = transcript
     WHERE call_sid = ? AND transcript_original = '' AND transcript <> ''`
  ).run(String(callSid || ''));
  return getCallLogBySid(db, String(callSid || ''));
}

/** Staff correction of a transcript: the corrected text becomes the
 * transcript, transcript_edited flips on, and the pre-edit (Whisper)
 * text is preserved in transcript_original. */
function editCallTranscript(db, callSid, text) {
  ensureTables(db);
  stampTranscriptOriginal(db, callSid);
  db.prepare(
    `UPDATE call_logs SET transcript = ?, transcript_edited = 1, updated_at = datetime('now')
     WHERE call_sid = ?`
  ).run(String(text || ''), String(callSid || ''));
  return getCallLogBySid(db, String(callSid || ''));
}

/* ------------------------- follow-up notes ------------------------ */

function addLeadContactNote(db, leadId, { staffUserId, staffName, body } = {}) {
  ensureTables(db);
  const text = String(body || '').trim();
  if (!text) {
    const e = new Error('A note needs some text.');
    e.code = 'VALIDATION';
    e.status = 400;
    throw e;
  }
  const info = db
    .prepare(
      `INSERT INTO lead_contact_notes (lead_id, staff_user_id, staff_name, body) VALUES (?, ?, ?, ?)`
    )
    .run(
      Number(leadId),
      staffUserId != null ? Number(staffUserId) : null,
      String(staffName || '').slice(0, 120),
      text.slice(0, 10000)
    );
  return getLeadContactNote(db, Number(info.lastInsertRowid));
}

function getLeadContactNote(db, id) {
  ensureTables(db);
  return db.prepare('SELECT * FROM lead_contact_notes WHERE id = ?').get(Number(id)) || null;
}

function listLeadContactNotes(db, leadId, { limit = CALL_LIST_CAP } = {}) {
  ensureTables(db);
  const lim = Math.min(CALL_LIST_CAP, Math.max(1, Number(limit) || CALL_LIST_CAP));
  return db
    .prepare('SELECT * FROM lead_contact_notes WHERE lead_id = ? ORDER BY id DESC LIMIT ?')
    .all(Number(leadId), lim);
}

function updateLeadContactNote(db, id, body) {
  ensureTables(db);
  const text = String(body || '').trim();
  if (!text) {
    const e = new Error('A note needs some text.');
    e.code = 'VALIDATION';
    e.status = 400;
    throw e;
  }
  db.prepare(
    `UPDATE lead_contact_notes SET body = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(text.slice(0, 10000), Number(id));
  return getLeadContactNote(db, id);
}

function deleteLeadContactNote(db, id) {
  ensureTables(db);
  const r = db.prepare('DELETE FROM lead_contact_notes WHERE id = ?').run(Number(id));
  return Number(r.changes || 0) === 1;
}

function listCalls(db, leadId, { limit = CALL_LIST_CAP, offset = 0 } = {}) {
  ensureTables(db);
  const lim = Math.min(CALL_LIST_CAP, Math.max(1, Number(limit) || CALL_LIST_CAP));
  const off = Math.max(0, Number(offset) || 0);
  return db
    .prepare('SELECT * FROM call_logs WHERE lead_id = ? ORDER BY id DESC LIMIT ? OFFSET ?')
    .all(Number(leadId), lim, off);
}

/** Staff oversight: every call in the workspace, newest first. */
function listAllCalls(db, { limit = CALL_LIST_CAP, offset = 0 } = {}) {
  ensureTables(db);
  const lim = Math.min(CALL_LIST_CAP, Math.max(1, Number(limit) || CALL_LIST_CAP));
  const off = Math.max(0, Number(offset) || 0);
  return db
    .prepare(
      `SELECT c.*, l.business_name AS lead_name
       FROM call_logs c
       LEFT JOIN leads l ON l.id = c.lead_id
       ORDER BY c.id DESC LIMIT ? OFFSET ?`
    )
    .all(lim, off);
}

/**
 * Batch 45 — test-call cleanup ONLY. A call log is billing history the
 * moment it counted toward a plan allowance, was billed for transcription,
 * or carries a rental charge; those are refused with 409 and stay forever.
 * A clean, uncounted, uncharged log (e.g. a staff test call) may be
 * deleted by staff. The LeadScout call event goes with it; the contact
 * stays.
 */
function deleteCallLog(db, id) {
  ensureTables(db);
  const row = db.prepare('SELECT * FROM call_logs WHERE id = ?').get(Number(id));
  if (!row) throw fail('NOT_FOUND', 'Call log not found', 404);
  if (Number(row.counted || 0) !== 0) {
    throw fail('CALL_COUNTED', 'Counted calls are billing history and cannot be deleted.', 409);
  }
  if (Number(row.transcription_billed || 0) !== 0) {
    throw fail('CALL_BILLED', 'This call was billed for transcription and cannot be deleted.', 409);
  }
  const chargeTable = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'site_rental_charges'")
    .get();
  if (chargeTable) {
    const charge = db.prepare('SELECT id FROM site_rental_charges WHERE call_log_id = ? LIMIT 1').get(row.id);
    if (charge) {
      throw fail('CALL_CHARGED', 'This call carries a rental charge and cannot be deleted.', 409);
    }
  }
  db.prepare('DELETE FROM call_logs WHERE id = ?').run(row.id);
  deleteLeadScoutEventsByRef(db, 'call_log_id', row.id);
  return { deleted: true, id: row.id };
}

/* ── Call billing bookkeeping (addendum #3) ──────────────────────────
 * Sync SQLite state only. The async money movement (credits engine,
 * plan lookup) lives in server/callBilling.js; these helpers are the
 * ledger it settles against. */

function countCountedCalls(db, leadId, month) {
  ensureTables(db);
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM call_logs
       WHERE lead_id = ? AND counted = 1 AND strftime('%Y-%m', created_at) = ?`
    )
    .get(Number(leadId), String(month || currentCallMonth()));
  return row ? Number(row.c) || 0 : 0;
}

function getCallBillingState(db, leadId, month) {
  ensureTables(db);
  const m = String(month || currentCallMonth());
  const row = db
    .prepare('SELECT * FROM calls_billing WHERE lead_id = ? AND month = ?')
    .get(Number(leadId), m);
  return {
    lead_id: Number(leadId),
    month: m,
    last_billed_threshold: row ? Number(row.last_billed_threshold) || 0 : 0,
    overage_due_credits: row ? Number(row.overage_due_credits) || 0 : 0,
  };
}

function setCallBillingState(db, leadId, month, { lastBilledThreshold, overageDueCredits } = {}) {
  ensureTables(db);
  const m = String(month || currentCallMonth());
  db.prepare(
    `INSERT INTO calls_billing (lead_id, month, last_billed_threshold, overage_due_credits, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(lead_id, month) DO UPDATE SET
       last_billed_threshold = excluded.last_billed_threshold,
       overage_due_credits = excluded.overage_due_credits,
       updated_at = datetime('now')`
  ).run(
    Number(leadId),
    m,
    Math.max(0, Math.trunc(Number(lastBilledThreshold) || 0)),
    Math.max(0, Math.trunc(Number(overageDueCredits) || 0))
  );
  return getCallBillingState(db, leadId, m);
}

/** Display counters for the portal panel + staff Calls screen. */
function callBillingSummary(db, leadId, planId, month) {
  const m = String(month || currentCallMonth());
  const state = getCallBillingState(db, leadId, m);
  return {
    month: m,
    answered: countCountedCalls(db, leadId, m),
    allowance: callAllowanceForPlan(planId),
    plan: String(planId || 'free').toLowerCase(),
    overage_due_credits: state.overage_due_credits,
  };
}

function markTranscriptionBilled(db, callSid) {
  ensureTables(db);
  const sid = String(callSid || '').trim();
  if (!sid) return null;
  db.prepare('UPDATE call_logs SET transcription_billed = 1 WHERE call_sid = ?').run(sid);
  return getCallLogBySid(db, sid);
}

/* ── Call email notification state (addendum #4) ─────────────────────
 * Exactly-once: the status handler claims the row (notify_status
 * 'none' → 'pending') BEFORE any send attempt; only the claim winner
 * emails. Outcomes land as 'sent' | 'failed' | 'skipped' | 'off'. */

function claimCallNotify(db, callSid) {
  ensureTables(db);
  const sid = String(callSid || '').trim();
  if (!sid) return false;
  const info = db
    .prepare(
      "UPDATE call_logs SET notify_status = 'pending', updated_at = datetime('now') WHERE call_sid = ? AND notify_status = 'none'"
    )
    .run(sid);
  return Number(info.changes) === 1;
}

function setCallNotifyStatus(db, callSid, status) {
  ensureTables(db);
  const sid = String(callSid || '').trim();
  if (!sid) return null;
  db.prepare('UPDATE call_logs SET notify_status = ?, updated_at = datetime(\'now\') WHERE call_sid = ?').run(
    String(status || 'none'),
    sid
  );
  return getCallLogBySid(db, sid);
}

/* ── Voicemail email state (Batch 26c) ───────────────────────────────
 * The voicemail email is a SEPARATE exactly-once send from the missed-
 * call alert: claim flips voicemail_notify_status 'none' → 'pending'
 * before the attempt; outcomes 'sent' | 'failed' | 'skipped' | 'off'. */

function claimVoicemailNotify(db, callSid) {
  ensureTables(db);
  const sid = String(callSid || '').trim();
  if (!sid) return false;
  const info = db
    .prepare(
      "UPDATE call_logs SET voicemail_notify_status = 'pending', updated_at = datetime('now') WHERE call_sid = ? AND voicemail_notify_status = 'none'"
    )
    .run(sid);
  return Number(info.changes) === 1;
}

function setVoicemailNotifyStatus(db, callSid, status) {
  ensureTables(db);
  const sid = String(callSid || '').trim();
  if (!sid) return null;
  db.prepare(
    'UPDATE call_logs SET voicemail_notify_status = ?, updated_at = datetime(\'now\') WHERE call_sid = ?'
  ).run(String(status || 'none'), sid);
  return getCallLogBySid(db, sid);
}

/* ── Members (Membership) — site user accounts, sessions, page gating ──
 *
 * Accounts live per lead (site_members). Passwords use bcrypt cost 12 —
 * the platform's existing scheme (server/clientPortal.js, server/admin.js).
 * Session + password-reset + preview-grant tokens are random values; only
 * their sha256 hashes are ever stored. Gating is enforced server-side:
 * public payloads for modules mounted on a gated page return a locked
 * response carrying NO content, and at export time a gated page ships as
 * a shell — its authored body is served only by getMemberPageBody after a
 * valid member session (or a short-lived owner preview grant) is shown.
 */
const bcrypt = require('bcryptjs');

const MEMBER_STATUSES = ['active', 'pending', 'disabled'];
const MEMBER_GATE_MODES = ['off', 'selected', 'whole_site'];
const MEMBER_SIGNUP_MODES = ['open', 'approval'];
const MEMBER_ACCESS_LEVELS = ['any_member', 'any_paid', 'tier'];
const MEMBER_TIER_INTERVALS = ['month', 'year'];
// Subscription statuses that grant paid access from local records.
// 'past_due' is deliberately NOT entitled: the owner's Stripe dunning
// decides retries; owners can comp a member to bridge a failed payment.
const MEMBER_ENTITLED_STATUSES = ['active', 'trialing'];
const MEMBER_WALL_DEFAULT = 'This page is for members only';
const MEMBER_PASSWORD_MIN = 8;
// Timing pad so unknown-email logins cost the same bcrypt compare as real ones.
const MEMBER_DUMMY_HASH = bcrypt.hashSync('bitpype-member-timing-pad', 12);

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function normalizeMemberEmail(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .slice(0, 254);
}

function memberEmailOk(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

function assertMemberPassword(password) {
  const pw = String(password || '');
  if (pw.length < MEMBER_PASSWORD_MIN) {
    throw fail('VALIDATION', `Password must be at least ${MEMBER_PASSWORD_MIN} characters.`, 400);
  }
  if (pw.length > 200) throw fail('VALIDATION', 'Password is too long.', 400);
  return pw;
}

/** Public member shape — never carries the password hash. */
function publicMember(row) {
  if (!row) return null;
  return {
    id: row.id,
    lead_id: row.lead_id,
    email: row.email,
    name: row.name || '',
    status: row.status,
    created_at: row.created_at,
    last_login_at: row.last_login_at || null,
    comp_tier_id: row.comp_tier_id != null ? Number(row.comp_tier_id) : null,
    comp_until: row.comp_until || null,
  };
}

function membersEmbedForLead(db, leadId) {
  ensureTables(db);
  return (
    db
      .prepare("SELECT * FROM site_module_embeds WHERE lead_id = ? AND module_type = 'members'")
      .get(Number(leadId)) || null
  );
}

function membersPageSlug(db, leadId) {
  const embed = membersEmbedForLead(db, leadId);
  return normalizeSlug((embed && embed.target_page_slug) || MODULE_META.members.defaultSlug);
}

function slugListFrom(value) {
  let arr = value;
  if (typeof value === 'string') {
    try {
      arr = JSON.parse(value);
    } catch {
      arr = value ? [value] : [];
    }
  }
  if (!Array.isArray(arr)) arr = [];
  const out = [];
  for (const v of arr) {
    const s = normalizeSlug(v);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= 200) break;
  }
  return out;
}

function shapeMembersConfig(row, leadId) {
  if (!row) {
    return {
      lead_id: Number(leadId),
      gate_mode: 'off',
      gated_pages: [],
      public_pages: [],
      signup_mode: 'open',
      wall_headline: MEMBER_WALL_DEFAULT,
      access_level: 'any_member',
      access_tier_id: null,
      updated_at: null,
    };
  }
  return {
    lead_id: row.lead_id,
    gate_mode: MEMBER_GATE_MODES.includes(row.gate_mode) ? row.gate_mode : 'off',
    gated_pages: slugListFrom(row.gated_pages_json),
    public_pages: slugListFrom(row.public_pages_json),
    signup_mode: MEMBER_SIGNUP_MODES.includes(row.signup_mode) ? row.signup_mode : 'open',
    wall_headline: String(row.wall_headline || '').trim() || MEMBER_WALL_DEFAULT,
    access_level: MEMBER_ACCESS_LEVELS.includes(row.access_level) ? row.access_level : 'any_member',
    access_tier_id: row.access_tier_id != null ? Number(row.access_tier_id) : null,
    updated_at: row.updated_at || null,
  };
}

function readMembersConfig(db, leadId) {
  ensureTables(db);
  const row = db.prepare('SELECT * FROM members_configs WHERE lead_id = ?').get(Number(leadId));
  return shapeMembersConfig(row, leadId);
}

function getMembersConfig(db, leadId) {
  ensureTables(db);
  const id = Number(leadId);
  const existing = db.prepare('SELECT lead_id FROM members_configs WHERE lead_id = ?').get(id);
  if (!existing) db.prepare('INSERT INTO members_configs (lead_id) VALUES (?)').run(id);
  return readMembersConfig(db, id);
}

function updateMembersConfig(db, leadId, data = {}) {
  ensureTables(db);
  const row = getMembersConfig(db, leadId);
  const gateMode = data.gate_mode != null ? String(data.gate_mode).trim().toLowerCase() : row.gate_mode;
  if (!MEMBER_GATE_MODES.includes(gateMode)) {
    throw fail('VALIDATION', 'gate_mode must be off, selected or whole_site.', 400);
  }
  const signupMode = data.signup_mode != null ? String(data.signup_mode).trim().toLowerCase() : row.signup_mode;
  if (!MEMBER_SIGNUP_MODES.includes(signupMode)) {
    throw fail('VALIDATION', 'signup_mode must be open or approval.', 400);
  }
  const gatedPages = data.gated_pages != null ? slugListFrom(data.gated_pages) : row.gated_pages;
  const publicPages = data.public_pages != null ? slugListFrom(data.public_pages) : row.public_pages;
  const wallHeadline =
    data.wall_headline != null
      ? String(data.wall_headline).trim().slice(0, 140) || MEMBER_WALL_DEFAULT
      : row.wall_headline;
  const accessLevel =
    data.access_level != null ? String(data.access_level).trim().toLowerCase() : row.access_level;
  if (!MEMBER_ACCESS_LEVELS.includes(accessLevel)) {
    throw fail('VALIDATION', 'access_level must be any_member, any_paid or tier.', 400);
  }
  let accessTierId = row.access_tier_id;
  if (data.access_tier_id !== undefined) {
    accessTierId =
      data.access_tier_id === null || data.access_tier_id === '' ? null : Number(data.access_tier_id);
    if (accessTierId !== null && (!Number.isInteger(accessTierId) || accessTierId <= 0)) {
      throw fail('VALIDATION', 'access_tier_id must be a tier id or null.', 400);
    }
  }
  if (accessLevel === 'tier') {
    if (!accessTierId) {
      throw fail('VALIDATION', 'Pick the tier that unlocks gated pages (access_tier_id).', 400);
    }
    const tier = db
      .prepare('SELECT id FROM membership_tiers WHERE id = ? AND lead_id = ?')
      .get(accessTierId, Number(leadId));
    if (!tier) throw fail('VALIDATION', 'access_tier_id must be one of this site’s membership tiers.', 400);
  }
  db.prepare(
    `UPDATE members_configs
     SET gate_mode = ?, gated_pages_json = ?, public_pages_json = ?, signup_mode = ?, wall_headline = ?,
         access_level = ?, access_tier_id = ?,
         updated_at = datetime('now')
     WHERE lead_id = ?`
  ).run(
    gateMode,
    JSON.stringify(gatedPages),
    JSON.stringify(publicPages),
    signupMode,
    wallHeadline,
    accessLevel,
    accessTierId,
    Number(leadId)
  );
  return getMembersConfig(db, leadId);
}

/**
 * Is this page gated for visitors right now? The members page itself is
 * always public; gating also requires an attached, published module.
 */
function pageIsGated(db, leadId, slug) {
  const cfg = readMembersConfig(db, leadId);
  if (cfg.gate_mode === 'off') return false;
  const embed = membersEmbedForLead(db, leadId);
  if (!embed || !moduleEmbedActive(embed)) return false;
  const s = normalizeSlug(slug);
  if (s === membersPageSlug(db, leadId)) return false;
  if (cfg.gate_mode === 'selected') return cfg.gated_pages.includes(s);
  // whole_site: every page except the members page + owner exceptions.
  return !cfg.public_pages.includes(s);
}

function createMemberSession(db, member) {
  const raw = crypto.randomBytes(32).toString('base64url');
  db.prepare("DELETE FROM site_member_sessions WHERE member_id = ? AND expires_at <= datetime('now')").run(member.id);
  const info = db
    .prepare(
      `INSERT INTO site_member_sessions (token_hash, member_id, lead_id, expires_at)
       VALUES (?, ?, ?, datetime('now', '+30 days'))`
    )
    .run(sha256Hex(raw), member.id, member.lead_id);
  const row = db.prepare('SELECT expires_at FROM site_member_sessions WHERE id = ?').get(info.lastInsertRowid);
  return { token: raw, expires_at: row ? row.expires_at : null };
}

/** Session member row (active accounts only) or null. Lead-scoped. */
function getSessionMember(db, leadId, rawToken) {
  if (!rawToken) return null;
  ensureTables(db);
  const row = db
    .prepare(
      `SELECT m.* FROM site_member_sessions s
       JOIN site_members m ON m.id = s.member_id
       WHERE s.token_hash = ? AND s.lead_id = ? AND s.expires_at > datetime('now')`
    )
    .get(sha256Hex(rawToken), Number(leadId));
  if (!row || row.status !== 'active') return null;
  return row;
}

function createMemberPreviewGrant(db, leadId) {
  ensureTables(db);
  const raw = crypto.randomBytes(24).toString('base64url');
  db.prepare("DELETE FROM site_member_preview_grants WHERE lead_id = ? AND expires_at <= datetime('now')").run(
    Number(leadId)
  );
  db.prepare(
    `INSERT INTO site_member_preview_grants (token_hash, lead_id, expires_at)
     VALUES (?, ?, datetime('now', '+2 hours'))`
  ).run(sha256Hex(raw), Number(leadId));
  return raw;
}

function verifyMemberPreviewGrant(db, leadId, raw) {
  if (!raw) return false;
  ensureTables(db);
  const row = db
    .prepare(
      "SELECT id FROM site_member_preview_grants WHERE token_hash = ? AND lead_id = ? AND expires_at > datetime('now')"
    )
    .get(sha256Hex(raw), Number(leadId));
  return !!row;
}

/** Mint a preview grant only when the site actually gates something. */
function memberPreviewGrantFor(db, leadId) {
  const cfg = readMembersConfig(db, leadId);
  if (cfg.gate_mode === 'off') return null;
  const embed = membersEmbedForLead(db, leadId);
  if (!embed || !moduleEmbedActive(embed)) return null;
  return createMemberPreviewGrant(db, leadId);
}

/**
 * Access for payload/body reads: { member } for a valid session, { preview }
 * for an owner preview grant, null otherwise. Always scoped to this lead.
 */
function resolveMemberAccess(db, leadId, opts = {}) {
  const member = getSessionMember(db, leadId, opts.memberSession || opts.sessionToken || '');
  if (member) return { member: publicMember(member), preview: false };
  if (verifyMemberPreviewGrant(db, leadId, opts.previewGrant || '')) return { member: null, preview: true };
  return null;
}

/**
 * What a member's money/comp state buys them, from LOCAL records only
 * (member_subscriptions + the comp fields on site_members). Stripe is
 * never consulted here — the webhook keeps these rows current.
 *
 * Returns:
 *   has_paid   — an entitled (active/trialing) subscription on a PAID
 *                tier, or a live owner comp (either satisfies any_paid).
 *   tier_id    — the tier granting access (comp first, then paid sub,
 *                then a free-tier join), or null.
 *   source     — 'comp' | 'subscription' | 'free' | null.
 */
function memberAccessInfo(db, leadId, member) {
  ensureTables(db);
  const none = { has_paid: false, tier_id: null, source: null, subscription: null };
  if (!member) return none;
  const id = Number(leadId);
  const mid = Number(member.id);
  // Owner comp: explicit tier, optional expiry (null = indefinite).
  if (member.comp_tier_id != null) {
    const until = member.comp_until ? String(member.comp_until) : '';
    if (!until || until > new Date().toISOString().slice(0, 19).replace('T', ' ')) {
      const tier = getMembershipTier(db, id, Number(member.comp_tier_id));
      return {
        has_paid: true,
        tier_id: Number(member.comp_tier_id),
        tier_name: tier ? tier.name : '',
        source: 'comp',
        subscription: null,
        comp_until: member.comp_until || null,
      };
    }
  }
  const sub =
    db
      .prepare(
        `SELECT * FROM member_subscriptions
         WHERE lead_id = ? AND member_id = ? AND status IN ('active', 'trialing')
         ORDER BY id DESC LIMIT 1`
      )
      .get(id, mid) || null;
  if (!sub) return none;
  const shaped = shapeMemberSubscription(sub);
  if (Number(sub.price_cents) > 0) {
    return { has_paid: true, tier_id: sub.tier_id, tier_name: sub.tier_name || '', source: 'subscription', subscription: shaped };
  }
  // A free-tier join: membership of that tier, but not "paid".
  return { has_paid: false, tier_id: sub.tier_id, tier_name: sub.tier_name || '', source: 'free', subscription: shaped };
}

/** Does this access info satisfy the site's configured access level? */
function accessSatisfies(cfg, info) {
  if (!cfg || cfg.access_level === 'any_member') return true;
  if (!info) return false;
  if (cfg.access_level === 'any_paid') return !!info.has_paid;
  if (cfg.access_level === 'tier') {
    return info.tier_id != null && cfg.access_tier_id != null && Number(info.tier_id) === Number(cfg.access_tier_id);
  }
  return false;
}

/** The wall-facing fields every locked surface shares. */
function gateWallFields(gate) {
  return {
    wall_headline: gate.wall_headline,
    signup_mode: gate.signup_mode,
    members_token: gate.members_token,
    members_page: gate.members_page,
    needs: gate.needs || 'login',
    access_level: gate.access_level || 'any_member',
    access_tier_id: gate.access_tier_id != null ? gate.access_tier_id : null,
    access_tier_name: gate.access_tier_name || '',
    member: gate.member || null,
  };
}

function memberGateCheck(db, leadId, pageSlug, opts = {}) {
  if (!pageIsGated(db, leadId, pageSlug)) return { locked: false };
  const cfg = readMembersConfig(db, leadId);
  const embed = membersEmbedForLead(db, leadId);
  const base = {
    wall_headline: cfg.wall_headline,
    signup_mode: cfg.signup_mode,
    gate_mode: cfg.gate_mode,
    members_token: embed ? embed.public_token : '',
    members_page: pageFileName(membersPageSlug(db, leadId)),
    access_level: cfg.access_level,
    access_tier_id: cfg.access_tier_id,
    access_tier_name: '',
  };
  if (cfg.access_tier_id) {
    const t = getMembershipTier(db, leadId, cfg.access_tier_id);
    if (t) base.access_tier_name = t.name;
  }
  const access = resolveMemberAccess(db, leadId, opts);
  if (access && access.preview) return { locked: false, access };
  if (access && access.member) {
    // Any-member sites keep Part 1 behavior exactly: a session unlocks.
    if (cfg.access_level === 'any_member') return { locked: false, access };
    const memberRow = getSessionMember(db, leadId, opts.memberSession || opts.sessionToken || '');
    const info = memberAccessInfo(db, leadId, memberRow);
    if (accessSatisfies(cfg, info)) return { locked: false, access, entitlement: info };
    return { locked: true, ...base, needs: 'subscription', member: access.member, entitlement: info };
  }
  return { locked: true, ...base, needs: 'login', member: null };
}

function lockedModulePayload(embedRow, gate) {
  return {
    embed: publicEmbed(embedRow),
    module_type: embedRow.module_type,
    title: embedRow.title || MODULE_META[embedRow.module_type]?.label || embedRow.module_type,
    settings: parseEmbedSettings(embedRow),
    items: [],
    locked: true,
    gate: gateWallFields(gate),
  };
}

/** For write/action endpoints whose module lives on a gated page. */
function assertMemberAccessForEmbed(db, embedRow, opts = {}) {
  if (!embedRow || embedRow.module_type === 'members') return;
  const gate = memberGateCheck(db, embedRow.lead_id, embedRow.target_page_slug, opts);
  if (gate.locked) {
    const err = fail(
      'MEMBER_LOCKED',
      gate.needs === 'subscription'
        ? 'This needs a paid membership — please join a plan to continue.'
        : 'This is members-only — please log in to continue.',
      401
    );
    err.gate = gateWallFields(gate);
    throw err;
  }
}

function getMemberByEmail(db, leadId, email) {
  ensureTables(db);
  return (
    db
      .prepare('SELECT * FROM site_members WHERE lead_id = ? AND email = ?')
      .get(Number(leadId), normalizeMemberEmail(email)) || null
  );
}

function signupMember(db, leadId, data = {}) {
  ensureTables(db);
  const id = Number(leadId);
  const name = String(data.name || '')
    .trim()
    .slice(0, 120);
  const email = normalizeMemberEmail(data.email);
  const password = assertMemberPassword(data.password);
  if (!name) throw fail('VALIDATION', 'Please enter your name.', 400);
  if (!memberEmailOk(email)) throw fail('VALIDATION', 'Please enter a valid email address.', 400);
  if (getMemberByEmail(db, id, email)) {
    throw fail('EMAIL_TAKEN', 'An account with this email already exists — try logging in instead.', 409);
  }
  const cfg = readMembersConfig(db, id);
  const status = cfg.signup_mode === 'approval' ? 'pending' : 'active';
  const hash = bcrypt.hashSync(password, 12);
  let info;
  try {
    info = db
      .prepare('INSERT INTO site_members (lead_id, email, name, password_hash, status) VALUES (?, ?, ?, ?, ?)')
      .run(id, email, name, hash, status);
  } catch (e) {
    if (/UNIQUE/i.test(String((e && e.message) || ''))) {
      throw fail('EMAIL_TAKEN', 'An account with this email already exists — try logging in instead.', 409);
    }
    throw e;
  }
  const member = db.prepare('SELECT * FROM site_members WHERE id = ?').get(info.lastInsertRowid);
  const out = { member: publicMember(member), pending: status === 'pending', session: null };
  if (status === 'active') {
    db.prepare("UPDATE site_members SET last_login_at = datetime('now') WHERE id = ?").run(member.id);
    out.session = createMemberSession(db, member);
    out.member = publicMember(db.prepare('SELECT * FROM site_members WHERE id = ?').get(member.id));
  }
  return out;
}

function loginMember(db, leadId, data = {}) {
  ensureTables(db);
  const id = Number(leadId);
  const email = normalizeMemberEmail(data.email);
  const password = String(data.password || '');
  const member = getMemberByEmail(db, id, email);
  if (!member) {
    try {
      bcrypt.compareSync(password, MEMBER_DUMMY_HASH);
    } catch {
      /* timing pad only */
    }
    throw fail('INVALID_CREDENTIALS', 'Email or password is incorrect.', 401);
  }
  let ok = false;
  try {
    ok = bcrypt.compareSync(password, member.password_hash);
  } catch {
    ok = false;
  }
  if (!ok) throw fail('INVALID_CREDENTIALS', 'Email or password is incorrect.', 401);
  if (member.status === 'pending') {
    throw fail('MEMBER_PENDING', 'Your account is waiting for approval — we will let you know when it is ready.', 403);
  }
  if (member.status === 'disabled') {
    throw fail('MEMBER_DISABLED', 'This account has been disabled. Please contact us for help.', 403);
  }
  db.prepare("UPDATE site_members SET last_login_at = datetime('now') WHERE id = ?").run(member.id);
  const session = createMemberSession(db, member);
  const fresh = db.prepare('SELECT * FROM site_members WHERE id = ?').get(member.id);
  return { member: publicMember(fresh), session };
}

function logoutMember(db, leadId, rawToken) {
  ensureTables(db);
  if (rawToken) {
    db.prepare('DELETE FROM site_member_sessions WHERE token_hash = ? AND lead_id = ?').run(
      sha256Hex(rawToken),
      Number(leadId)
    );
  }
  return { ok: true };
}

/** Creates a reset token (hashed at rest, 1h, single-use). Null when no such member. */
function requestMemberReset(db, leadId, email) {
  ensureTables(db);
  const member = getMemberByEmail(db, leadId, email);
  if (!member || member.status === 'disabled') return null;
  db.prepare('DELETE FROM site_member_reset_tokens WHERE member_id = ?').run(member.id);
  const raw = crypto.randomBytes(32).toString('base64url');
  db.prepare(
    `INSERT INTO site_member_reset_tokens (token_hash, member_id, lead_id, expires_at)
     VALUES (?, ?, ?, datetime('now', '+1 hour'))`
  ).run(sha256Hex(raw), member.id, member.lead_id);
  return { member: publicMember(member), resetToken: raw };
}

/** Compose (never sends) the reset email — senders use the platform mailer. */
function buildMemberResetMail(db, leadId, member, rawToken, appUrl) {
  const embed = membersEmbedForLead(db, leadId);
  if (!embed || !embed.public_token || !member) return null;
  const base = String(appUrl || appBaseUrl()).replace(/\/$/, '');
  if (!base) return null;
  const url = `${base}/member-reset.html?t=${encodeURIComponent(embed.public_token)}&r=${encodeURIComponent(rawToken)}`;
  let business = '';
  try {
    const lead = db.prepare('SELECT business_name FROM leads WHERE id = ?').get(Number(leadId));
    business = String((lead && lead.business_name) || '').trim();
  } catch {
    business = '';
  }
  return {
    to: member.email,
    subject: business ? `Reset your ${business} password` : 'Reset your password',
    title: 'Reset your password',
    paragraphs: [
      `Hi ${member.name || 'there'},`,
      business
        ? `Someone asked to reset the password for your ${business} member account. Use the button below within the next hour to choose a new password.`
        : 'Someone asked to reset the password for your member account. Use the button below within the next hour to choose a new password.',
      'If that was not you, you can ignore this email — your password will not change.',
    ],
    cta: { label: 'Choose a new password', url },
    footerNote: 'This link works once and expires in one hour.',
  };
}

function resetMemberPassword(db, leadId, rawToken, newPassword) {
  ensureTables(db);
  const password = assertMemberPassword(newPassword);
  const id = Number(leadId);
  const row = db
    .prepare('SELECT * FROM site_member_reset_tokens WHERE token_hash = ? AND lead_id = ?')
    .get(sha256Hex(rawToken), id);
  if (!row || row.used_at || !(feedTimeMs(row.expires_at) > Date.now())) {
    throw fail('RESET_INVALID', 'This reset link is invalid or has expired. Please request a new one.', 400);
  }
  const member = db.prepare('SELECT * FROM site_members WHERE id = ? AND lead_id = ?').get(row.member_id, id);
  if (!member) {
    throw fail('RESET_INVALID', 'This reset link is invalid or has expired. Please request a new one.', 400);
  }
  const hash = bcrypt.hashSync(password, 12);
  db.prepare("UPDATE site_member_reset_tokens SET used_at = datetime('now') WHERE id = ?").run(row.id);
  db.prepare('UPDATE site_members SET password_hash = ? WHERE id = ?').run(hash, member.id);
  // A password reset ends every existing session for this member.
  db.prepare('DELETE FROM site_member_sessions WHERE member_id = ?').run(member.id);
  return { member: publicMember(db.prepare('SELECT * FROM site_members WHERE id = ?').get(member.id)) };
}

/* Owner-side member management */

function listSiteMembers(db, leadId, opts = {}) {
  ensureTables(db);
  const limit = Math.min(500, Math.max(1, Number(opts.limit) || 200));
  const offset = Math.max(0, Number(opts.offset) || 0);
  const params = [Number(leadId)];
  let sql = 'SELECT * FROM site_members WHERE lead_id = ?';
  const status = String(opts.status || '')
    .trim()
    .toLowerCase();
  if (MEMBER_STATUSES.includes(status)) {
    sql += ' AND status = ?';
    params.push(status);
  }
  const search = String(opts.search || '')
    .trim()
    .toLowerCase()
    .replace(/[%_]/g, '');
  if (search) {
    sql += ' AND (email LIKE ? OR lower(name) LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }
  sql += ' ORDER BY id DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  return db
    .prepare(sql)
    .all(...params)
    .map((row) => {
      const m = publicMember(row);
      const info = memberAccessInfo(db, Number(leadId), row);
      m.plan_label = info.source === 'comp' ? 'Comp' : info.tier_id != null ? info.tier_name || 'Member' : '—';
      m.plan_source = info.source;
      m.subscription = info.subscription
        ? {
            id: info.subscription.id,
            tier_id: info.subscription.tier_id,
            tier_name: info.subscription.tier_name,
            status: info.subscription.status,
            cancel_at_period_end: info.subscription.cancel_at_period_end,
            current_period_end: info.subscription.current_period_end,
          }
        : null;
      return m;
    });
}

function countSiteMembers(db, leadId) {
  ensureTables(db);
  const rows = db
    .prepare('SELECT status, COUNT(*) AS c FROM site_members WHERE lead_id = ? GROUP BY status')
    .all(Number(leadId));
  const counts = { total: 0, active: 0, pending: 0, disabled: 0 };
  for (const r of rows) {
    const c = Number(r.c) || 0;
    counts.total += c;
    if (Object.prototype.hasOwnProperty.call(counts, r.status)) counts[r.status] = c;
  }
  return counts;
}

function setSiteMemberStatus(db, leadId, memberId, status) {
  ensureTables(db);
  const st = String(status || '')
    .trim()
    .toLowerCase();
  if (!MEMBER_STATUSES.includes(st)) {
    throw fail('VALIDATION', 'status must be active, pending or disabled.', 400);
  }
  const member = db
    .prepare('SELECT * FROM site_members WHERE id = ? AND lead_id = ?')
    .get(Number(memberId), Number(leadId));
  if (!member) throw fail('NOT_FOUND', 'Member not found', 404);
  db.prepare('UPDATE site_members SET status = ? WHERE id = ?').run(st, member.id);
  // Leaving active ends the member's sessions immediately.
  if (st !== 'active') db.prepare('DELETE FROM site_member_sessions WHERE member_id = ?').run(member.id);
  return publicMember(db.prepare('SELECT * FROM site_members WHERE id = ?').get(member.id));
}

function deleteSiteMember(db, leadId, memberId) {
  ensureTables(db);
  const member = db
    .prepare('SELECT * FROM site_members WHERE id = ? AND lead_id = ?')
    .get(Number(memberId), Number(leadId));
  if (!member) throw fail('NOT_FOUND', 'Member not found', 404);
  db.prepare('DELETE FROM site_member_sessions WHERE member_id = ?').run(member.id);
  db.prepare('DELETE FROM site_member_reset_tokens WHERE member_id = ?').run(member.id);
  // Local subscription records go with the account (the Stripe
  // subscription itself lives on the owner's Stripe — cancelling it
  // there is the owner's call; nothing here can reach it).
  db.prepare('DELETE FROM member_subscriptions WHERE member_id = ? AND lead_id = ?').run(member.id, Number(leadId));
  db.prepare('DELETE FROM site_members WHERE id = ? AND lead_id = ?').run(member.id, Number(leadId));
  return { deleted: true, id: member.id };
}

/* ── Membership Part 2 (Batch 17): per-lead Stripe keys, paid tiers,
 * subscriptions, comps ──
 *
 * Money runs on the SITE OWNER'S OWN Stripe account (the Shop pattern):
 * owners save their keys in the portal, stored secretBox-encrypted in
 * membership_stripe_keys, scoped to their lead. The platform never
 * holds member money. member_subscriptions rows — kept current by the
 * membership webhook — are the ONLY entitlement source in gate paths.
 */

/** Raw key row (encrypted values). Internal: membershipStripe + tests. */
function getMembershipStripeKeyRow(db, leadId) {
  ensureTables(db);
  return (
    db.prepare('SELECT * FROM membership_stripe_keys WHERE lead_id = ?').get(Number(leadId)) || null
  );
}

/** Raw UNIFIED payments-config row (encrypted values). Batch 129:
 *  internal: paymentsConfig + tests. */
function getPaymentConfigRow(db, leadId) {
  ensureTables(db);
  return (
    db.prepare('SELECT * FROM lead_payment_configs WHERE lead_id = ?').get(Number(leadId)) || null
  );
}

/**
 * Save the owner's Stripe keys for their site.
 *
 * Batch 129: this is a FACADE over the one unified payments config
 * (server/paymentsConfig.js saveCredentials, purpose 'membership') —
 * the membership key store's write path is RETIRED. Fields left blank
 * keep the stored value of the effective config; the Batch 128
 * test/live mode-mix refusal now applies here too, because there is
 * only one config left to keep honest.
 */
function saveMembershipStripeKeys(db, leadId, data = {}) {
  require('./paymentsConfig').saveCredentials(db, leadId, data, 'membership');
  return membershipStripeStatus(db, leadId);
}

/** Batch 129: disconnect is ONE action for the ONE config — it
 *  clears the unified row and both legacy key rows (see
 *  paymentsConfig.clearCredentials). */
function clearMembershipStripeKeys(db, leadId) {
  require('./paymentsConfig').clearCredentials(db, leadId);
  return membershipStripeStatus(db, leadId);
}

/** Owner-safe status: never carries secret or webhook values.
 *  Batch 129: reads the EFFECTIVE membership-purpose layer (unified
 *  config first, membership legacy second). `mode`, `source` and
 *  `unified` are additive; every pre-129 field keeps its meaning. */
function membershipStripeStatus(db, leadId) {
  const s = require('./paymentsConfig').statusFor(db, leadId, 'membership');
  return {
    connected: s.connected,
    publishable_key: s.publishable_key,
    secret_key_last4: s.secret_key_last4,
    webhook_configured: s.webhook_configured,
    updated_at: s.updated_at,
    mode: s.mode,
    source: s.source,
    unified: s.unified,
  };
}

/* ── Shop Part 2 (Batch 19): per-lead Stripe keys ──
 *
 * The membership pattern applied to the Shop module: owners save
 * their OWN Stripe keys in the portal (Shop → Payments), stored
 * secretBox-encrypted in shop_stripe_keys, scoped to their lead.
 * Checkout prefers the lead's keys and falls back to the workspace
 * keys (Settings → Shop payments); server/shopStripe.js owns the
 * resolution, this section owns storage + status.
 */

/** Raw key row (encrypted values). Internal: shopStripe + tests. */
function getShopStripeKeyRow(db, leadId) {
  ensureTables(db);
  return db.prepare('SELECT * FROM shop_stripe_keys WHERE lead_id = ?').get(Number(leadId)) || null;
}

/**
 * Save the owner's Stripe keys for their shop.
 *
 * Batch 129: this is a FACADE over the one unified payments config
 * (server/paymentsConfig.js saveCredentials, purpose 'shop') — the
 * shop key store's write path is RETIRED. Fields left blank keep the
 * stored value of the effective config (unified row, else the shop
 * legacy row), so a first save after 129 migrates a working legacy
 * setup instead of orphaning it. Format validation and the Batch 128
 * test/live mode-mix refusal live in the one write path and run
 * BEFORE any write: a refused save stores nothing.
 */
function saveShopStripeKeys(db, leadId, data = {}) {
  require('./paymentsConfig').saveCredentials(db, leadId, data, 'shop');
  return shopStripeStatus(db, leadId);
}

/** Batch 129: disconnect is ONE action for the ONE config — it
 *  clears the unified row and both legacy key rows (see
 *  paymentsConfig.clearCredentials). */
function clearShopStripeKeys(db, leadId) {
  require('./paymentsConfig').clearCredentials(db, leadId);
  return shopStripeStatus(db, leadId);
}

/** Owner-safe status: never carries secret or webhook values.
 *  Batch 128: `mode` reports which Stripe mode the effective secret
 *  key actually belongs to ('test' | 'live' | null) — derived from
 *  the key's prefix at read time (the paymentsConfig.modeForSecret
 *  rule), never a stored claim, so the portal can say plainly
 *  whether this shop would take test or real charges.
 *  Batch 129: reads the EFFECTIVE shop-purpose LEAD layer (unified
 *  config first, shop legacy second). `source` ('unified' | 'lead')
 *  and `unified` are additive; every pre-129 field keeps its
 *  meaning. The workspace fallback layer is NOT part of this status
 *  (it is the operator's, reported separately as before). */
function shopStripeStatus(db, leadId) {
  const s = require('./paymentsConfig').statusFor(db, leadId, 'shop');
  return {
    connected: s.connected,
    mode: s.mode,
    publishable_key: s.publishable_key,
    secret_key_last4: s.secret_key_last4,
    webhook_configured: s.webhook_configured,
    updated_at: s.updated_at,
    source: s.source,
    unified: s.unified,
  };
}

function listShopPaymentSites(db, workspaceConfigured) {
  ensureTables(db);
  const rows = db
    .prepare(
      `SELECT e.lead_id AS lead_id, l.business_name AS lead_name,
              CASE WHEN (k.secret_key_enc IS NOT NULL AND k.secret_key_enc <> '')
                        OR (u.secret_key_enc IS NOT NULL AND u.secret_key_enc <> '') THEN 1 ELSE 0 END AS lead_connected
       FROM site_module_embeds e
       LEFT JOIN leads l ON l.id = e.lead_id
       LEFT JOIN shop_stripe_keys k ON k.lead_id = e.lead_id
       LEFT JOIN lead_payment_configs u ON u.lead_id = e.lead_id
       WHERE e.module_type = 'ecommerce'
       ORDER BY e.lead_id ASC`
    )
    .all();
  return rows.map((r) => ({
    lead_id: Number(r.lead_id),
    lead_name: r.lead_name || '',
    lead_connected: Number(r.lead_connected) === 1,
    effective_source:
      Number(r.lead_connected) === 1 ? 'lead' : workspaceConfigured ? 'workspace' : 'none',
  }));
}

/* Tiers */

function shapeMembershipTier(row) {
  if (!row) return null;
  return {
    id: row.id,
    lead_id: row.lead_id,
    name: row.name || '',
    description: row.description || '',
    price_cents: Number(row.price_cents) || 0,
    price_label: Number(row.price_cents) > 0 ? formatPrice(Number(row.price_cents), 'USD') : 'Free',
    interval: MEMBER_TIER_INTERVALS.includes(row.interval) ? row.interval : 'month',
    stripe_product_id: row.stripe_product_id || '',
    stripe_price_id: row.stripe_price_id || '',
    active: Number(row.active) === 1,
    sort_order: Number(row.sort_order) || 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function listMembershipTiers(db, leadId, opts = {}) {
  ensureTables(db);
  let sql = 'SELECT * FROM membership_tiers WHERE lead_id = ?';
  if (!opts.includeInactive) sql += ' AND active = 1';
  sql += ' ORDER BY sort_order ASC, id ASC';
  return db.prepare(sql).all(Number(leadId)).map(shapeMembershipTier);
}

function getMembershipTier(db, leadId, tierId) {
  ensureTables(db);
  const row = db
    .prepare('SELECT * FROM membership_tiers WHERE lead_id = ? AND id = ?')
    .get(Number(leadId), Number(tierId));
  return row ? shapeMembershipTier(row) : null;
}

/**
 * Validate tier input to a fields object (no write). Price accepts
 * dollars (`price`) or cents (`price_cents`) like estimate options.
 */
function validateMembershipTierInput(db, leadId, data = {}, existing = null) {
  const name =
    data.name != null ? String(data.name).trim().slice(0, 120) : existing ? existing.name : '';
  if (!name) throw fail('VALIDATION', 'Give the tier a name.', 400);
  const description =
    data.description != null
      ? String(data.description).trim().slice(0, 1000)
      : existing
        ? existing.description
        : '';
  let priceCents = existing ? Number(existing.price_cents) || 0 : 0;
  if (data.price_cents != null || data.price != null) {
    const parsed = parseMoneyCents(data.price, data.price_cents);
    priceCents = parsed == null ? 0 : parsed;
  }
  const intervalRaw =
    data.interval != null ? String(data.interval).trim().toLowerCase() : existing ? existing.interval : 'month';
  if (!MEMBER_TIER_INTERVALS.includes(intervalRaw)) {
    throw fail('VALIDATION', 'interval must be month or year.', 400);
  }
  const sortOrder =
    data.sort_order != null
      ? Math.max(0, Math.min(10000, Math.round(Number(data.sort_order)) || 0))
      : existing
        ? existing.sort_order
        : 0;
  return { name, description, price_cents: priceCents, interval: intervalRaw, sort_order: sortOrder };
}

function insertMembershipTier(db, leadId, fields, opts = {}) {
  ensureTables(db);
  const info = db
    .prepare(
      `INSERT INTO membership_tiers (lead_id, name, description, price_cents, interval, stripe_product_id, stripe_price_id, active, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      Number(leadId),
      fields.name,
      fields.description,
      fields.price_cents,
      fields.interval,
      opts.stripe_product_id || '',
      opts.stripe_price_id || '',
      opts.active === false ? 0 : 1,
      fields.sort_order
    );
  return getMembershipTier(db, leadId, info.lastInsertRowid);
}

function updateMembershipTierRow(db, leadId, tierId, fields, opts = {}) {
  ensureTables(db);
  const existing = getMembershipTier(db, leadId, tierId);
  if (!existing) throw fail('NOT_FOUND', 'Tier not found', 404);
  db.prepare(
    `UPDATE membership_tiers
     SET name = ?, description = ?, price_cents = ?, interval = ?, sort_order = ?,
         stripe_product_id = ?, stripe_price_id = ?, active = ?, updated_at = datetime('now')
     WHERE id = ? AND lead_id = ?`
  ).run(
    fields.name,
    fields.description,
    fields.price_cents,
    fields.interval,
    fields.sort_order,
    opts.stripe_product_id !== undefined ? opts.stripe_product_id : existing.stripe_product_id,
    opts.stripe_price_id !== undefined ? opts.stripe_price_id : existing.stripe_price_id,
    opts.active !== undefined ? (opts.active ? 1 : 0) : existing.active ? 1 : 0,
    Number(tierId),
    Number(leadId)
  );
  return getMembershipTier(db, leadId, tierId);
}


function deleteMembershipTier(db, leadId, tierId) {
  ensureTables(db);
  const existing = getMembershipTier(db, leadId, tierId);
  if (!existing) throw fail('NOT_FOUND', 'Tier not found', 404);
  // Subscriptions keep their tier name/price snapshot, so members who
  // already joined are unaffected by the tier going away.
  db.prepare('DELETE FROM membership_tiers WHERE id = ? AND lead_id = ?').run(Number(tierId), Number(leadId));
  return { deleted: true, id: existing.id };
}

/* Subscriptions (local records — the entitlement source of truth) */

function shapeMemberSubscription(row) {
  if (!row) return null;
  return {
    id: row.id,
    lead_id: row.lead_id,
    member_id: row.member_id,
    tier_id: row.tier_id != null ? Number(row.tier_id) : null,
    tier_name: row.tier_name || '',
    price_cents: Number(row.price_cents) || 0,
    interval: MEMBER_TIER_INTERVALS.includes(row.interval) ? row.interval : 'month',
    stripe_customer_id: row.stripe_customer_id || '',
    stripe_subscription_id: row.stripe_subscription_id || '',
    // Batch 129: which payments-config layer created this
    // subscription ('unified' | 'membership' | '' pre-129) — lifecycle
    // operations act on the origin account first.
    stripe_key_source: row.stripe_key_source || '',
    status: row.status || 'incomplete',
    cancel_at_period_end: Number(row.cancel_at_period_end) === 1,
    current_period_end: row.current_period_end || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function getMemberSubscriptionByStripeId(db, stripeSubscriptionId) {
  ensureTables(db);
  if (!stripeSubscriptionId) return null;
  const row = db
    .prepare('SELECT * FROM member_subscriptions WHERE stripe_subscription_id = ?')
    .get(String(stripeSubscriptionId));
  return row ? shapeMemberSubscription(row) : null;
}

function listMemberSubscriptions(db, leadId, opts = {}) {
  ensureTables(db);
  const params = [Number(leadId)];
  let sql = 'SELECT * FROM member_subscriptions WHERE lead_id = ?';
  if (opts.memberId != null) {
    sql += ' AND member_id = ?';
    params.push(Number(opts.memberId));
  }
  sql += ' ORDER BY id DESC';
  const limit = Math.min(500, Math.max(1, Number(opts.limit) || 200));
  sql += ' LIMIT ?';
  params.push(limit);
  return db.prepare(sql).all(...params).map(shapeMemberSubscription);
}

/** Which lead owns this Stripe subscription/customer (webhook routing). */
function findLeadByStripeSubscription(db, stripeSubscriptionId) {
  const sub = getMemberSubscriptionByStripeId(db, stripeSubscriptionId);
  return sub ? sub.lead_id : null;
}

function findLeadByStripeCustomer(db, stripeCustomerId) {
  ensureTables(db);
  if (!stripeCustomerId) return null;
  const row = db
    .prepare('SELECT lead_id FROM member_subscriptions WHERE stripe_customer_id = ? ORDER BY id DESC LIMIT 1')
    .get(String(stripeCustomerId));
  return row ? Number(row.lead_id) : null;
}

/**
 * Idempotent upsert keyed by the Stripe subscription id (or, for local
 * free-tier joins with no Stripe id, by member+tier). Stripe events
 * arriving twice — or out of order — converge on the same row.
 */
function upsertMemberSubscription(db, fields) {
  ensureTables(db);
  const leadId = Number(fields.lead_id);
  const memberId = Number(fields.member_id);
  let existing = null;
  if (fields.stripe_subscription_id) {
    existing = db
      .prepare('SELECT * FROM member_subscriptions WHERE stripe_subscription_id = ?')
      .get(String(fields.stripe_subscription_id));
  }
  if (!existing && !fields.stripe_subscription_id && fields.tier_id != null) {
    existing = db
      .prepare(
        "SELECT * FROM member_subscriptions WHERE lead_id = ? AND member_id = ? AND tier_id = ? AND stripe_subscription_id = '' ORDER BY id DESC LIMIT 1"
      )
      .get(leadId, memberId, Number(fields.tier_id));
  }
  // Batch 143 (full review): a Stripe subscription id whose row is
  // 'canceled' is TERMINAL. customer.subscription.deleted is final
  // at Stripe — that id can never bill or entitle again — but event
  // delivery is not ordered, and without this guard a stale
  // subscription.updated (status 'active') arriving after the
  // deleted event resurrected the row and restored paid access with
  // no payment. A genuinely new subscription arrives under a NEW
  // Stripe id (a fresh checkout), so it is unaffected; local
  // free-tier rows carry no Stripe id and are unaffected.
  if (existing && fields.stripe_subscription_id && existing.status === 'canceled') {
    const incoming = String(fields.status || existing.status);
    if (incoming !== 'canceled') return shapeMemberSubscription(existing);
  }
  const merged = {
    lead_id: leadId,
    member_id: memberId,
    tier_id: fields.tier_id !== undefined ? fields.tier_id : existing ? existing.tier_id : null,
    tier_name: fields.tier_name !== undefined ? String(fields.tier_name || '') : existing ? existing.tier_name : '',
    price_cents:
      fields.price_cents !== undefined ? Number(fields.price_cents) || 0 : existing ? Number(existing.price_cents) || 0 : 0,
    interval: fields.interval || (existing ? existing.interval : 'month'),
    stripe_customer_id:
      fields.stripe_customer_id !== undefined
        ? String(fields.stripe_customer_id || '')
        : existing
          ? existing.stripe_customer_id
          : '',
    stripe_subscription_id:
      fields.stripe_subscription_id !== undefined
        ? String(fields.stripe_subscription_id || '')
        : existing
          ? existing.stripe_subscription_id
          : '',
    status: fields.status || (existing ? existing.status : 'incomplete'),
    cancel_at_period_end:
      fields.cancel_at_period_end !== undefined
        ? fields.cancel_at_period_end
          ? 1
          : 0
        : existing
          ? Number(existing.cancel_at_period_end) || 0
          : 0,
    current_period_end:
      fields.current_period_end !== undefined ? fields.current_period_end : existing ? existing.current_period_end : null,
    // Batch 129: recorded once at creation from the checkout
    // session's stamped metadata; lifecycle events never rewrite it.
    stripe_key_source:
      fields.stripe_key_source !== undefined
        ? String(fields.stripe_key_source || '')
        : existing
          ? existing.stripe_key_source || ''
          : '',
  };
  if (existing) {
    db.prepare(
      `UPDATE member_subscriptions
       SET lead_id = ?, member_id = ?, tier_id = ?, tier_name = ?, price_cents = ?, interval = ?,
           stripe_customer_id = ?, stripe_subscription_id = ?, status = ?, cancel_at_period_end = ?,
           current_period_end = ?, stripe_key_source = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).run(
      merged.lead_id, merged.member_id, merged.tier_id, merged.tier_name, merged.price_cents, merged.interval,
      merged.stripe_customer_id, merged.stripe_subscription_id, merged.status, merged.cancel_at_period_end,
      merged.current_period_end, merged.stripe_key_source, existing.id
    );
    return shapeMemberSubscription(db.prepare('SELECT * FROM member_subscriptions WHERE id = ?').get(existing.id));
  }
  const info = db
    .prepare(
      `INSERT INTO member_subscriptions
       (lead_id, member_id, tier_id, tier_name, price_cents, interval, stripe_customer_id,
        stripe_subscription_id, status, cancel_at_period_end, current_period_end, stripe_key_source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      merged.lead_id, merged.member_id, merged.tier_id, merged.tier_name, merged.price_cents, merged.interval,
      merged.stripe_customer_id, merged.stripe_subscription_id, merged.status, merged.cancel_at_period_end,
      merged.current_period_end, merged.stripe_key_source
    );
  return shapeMemberSubscription(db.prepare('SELECT * FROM member_subscriptions WHERE id = ?').get(info.lastInsertRowid));
}

/** Local free-tier join: an active subscription row with no Stripe ids. */
function createFreeTierMembership(db, leadId, memberId, tier) {
  return upsertMemberSubscription(db, {
    lead_id: Number(leadId),
    member_id: Number(memberId),
    tier_id: tier.id,
    tier_name: tier.name,
    price_cents: 0,
    interval: tier.interval,
    stripe_customer_id: '',
    stripe_subscription_id: '',
    status: 'active',
    cancel_at_period_end: 0,
    current_period_end: null,
  });
}

/**
 * The immediate local mark when a cancel is requested: the row keeps its
 * Stripe status (access continues) and gains cancel_at_period_end until
 * the webhook lands the terminal state at the period's end.
 */
function markSubscriptionCanceling(db, subscriptionId) {
  ensureTables(db);
  db.prepare(
    "UPDATE member_subscriptions SET cancel_at_period_end = 1, updated_at = datetime('now') WHERE id = ?"
  ).run(Number(subscriptionId));
  const row = db.prepare('SELECT * FROM member_subscriptions WHERE id = ?').get(Number(subscriptionId));
  return shapeMemberSubscription(row);
}

/** Local-only cancel (free-tier joins have no Stripe subscription). */
function cancelLocalSubscription(db, subscriptionId) {
  ensureTables(db);
  db.prepare(
    "UPDATE member_subscriptions SET status = 'canceled', updated_at = datetime('now') WHERE id = ?"
  ).run(Number(subscriptionId));
  const row = db.prepare('SELECT * FROM member_subscriptions WHERE id = ?').get(Number(subscriptionId));
  return shapeMemberSubscription(row);
}

/* Owner comps */

function grantMemberComp(db, leadId, memberId, data = {}) {
  ensureTables(db);
  const id = Number(leadId);
  const member = db
    .prepare('SELECT * FROM site_members WHERE id = ? AND lead_id = ?')
    .get(Number(memberId), id);
  if (!member) throw fail('NOT_FOUND', 'Member not found', 404);
  const tierId = data.tier_id != null ? Number(data.tier_id) : data.tierId != null ? Number(data.tierId) : null;
  if (!tierId || !Number.isInteger(tierId)) throw fail('VALIDATION', 'Pick the tier to comp.', 400);
  const tier = getMembershipTier(db, id, tierId);
  if (!tier) throw fail('VALIDATION', 'That tier does not belong to this site.', 400);
  let until = null;
  const rawUntil = data.comp_until != null ? data.comp_until : data.until;
  if (rawUntil != null && String(rawUntil).trim() !== '') {
    const d = new Date(String(rawUntil).trim());
    if (Number.isNaN(d.getTime())) throw fail('VALIDATION', 'comp_until must be a date.', 400);
    until = d.toISOString().slice(0, 19).replace('T', ' ');
  }
  db.prepare('UPDATE site_members SET comp_tier_id = ?, comp_until = ? WHERE id = ?').run(tierId, until, member.id);
  return publicMember(db.prepare('SELECT * FROM site_members WHERE id = ?').get(member.id));
}

function revokeMemberComp(db, leadId, memberId) {
  ensureTables(db);
  const member = db
    .prepare('SELECT * FROM site_members WHERE id = ? AND lead_id = ?')
    .get(Number(memberId), Number(leadId));
  if (!member) throw fail('NOT_FOUND', 'Member not found', 404);
  db.prepare('UPDATE site_members SET comp_tier_id = NULL, comp_until = NULL WHERE id = ?').run(member.id);
  return publicMember(db.prepare('SELECT * FROM site_members WHERE id = ?').get(member.id));
}

/* Revenue estimate (local records only, labeled as an estimate) */

function membershipRevenueSummary(db, leadId) {
  ensureTables(db);
  const rows = db
    .prepare(
      `SELECT price_cents, interval, COUNT(*) AS c FROM member_subscriptions
       WHERE lead_id = ? AND status IN ('active', 'trialing') AND price_cents > 0
       GROUP BY price_cents, interval`
    )
    .all(Number(leadId));
  let membersCount = 0;
  let monthly = 0;
  for (const r of rows) {
    const c = Number(r.c) || 0;
    membersCount += c;
    const per = Number(r.price_cents) || 0;
    monthly += (r.interval === 'year' ? per / 12 : per) * c;
  }
  return { active_paid_members: membersCount, est_monthly_revenue_cents: Math.round(monthly) };
}

/* Webhook application — pure DB, idempotent (mirrors applyShopStripeEvent) */

function stripeTsToIso(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

function subscriptionPeriodEnd(obj) {
  if (obj.current_period_end) return stripeTsToIso(obj.current_period_end);
  const item = obj.items && Array.isArray(obj.items.data) ? obj.items.data[0] : null;
  if (item && item.current_period_end) return stripeTsToIso(item.current_period_end);
  return undefined; // unknown — keep whatever we already stored
}

function applyMembershipStripeEvent(db, event) {
  ensureTables(db);
  const type = String((event && event.type) || '');
  const obj = (event && event.data && event.data.object) || {};
  const meta = obj.metadata || {};

  if (type === 'checkout.session.completed') {
    const leadId = Number(meta.bitpype_lead_id);
    const memberId = Number(meta.bitpype_member_id);
    const tierId = Number(meta.bitpype_tier_id);
    if (!leadId || !memberId) return { matched: false, reason: 'no membership metadata' };
    const tier = tierId ? getMembershipTier(db, leadId, tierId) : null;
    const sub = upsertMemberSubscription(db, {
      lead_id: leadId,
      member_id: memberId,
      tier_id: tierId || null,
      tier_name: tier ? tier.name : undefined,
      price_cents: tier ? tier.price_cents : undefined,
      interval: tier ? tier.interval : undefined,
      stripe_customer_id: String(obj.customer || ''),
      stripe_subscription_id: String(obj.subscription || ''),
      // Batch 129: record the payments-config layer that created
      // this subscription (stamped on the session at checkout).
      ...(meta.bitpype_key_source ? { stripe_key_source: String(meta.bitpype_key_source) } : {}),
      // The subscription.* events carry the authoritative status +
      // period and converge this row next. Batch 143 (full review):
      // 'unpaid' must NOT map to an entitled status — it did
      // ('trialing', which memberAccessInfo counts as paid on a
      // priced tier), so an async/unpaid membership checkout granted
      // paid access with no money landed; the shop pipeline was
      // fixed against this exact pattern and this door was missed.
      // 'no_payment_required' is a genuine trial (entitled);
      // 'unpaid' parks as 'incomplete' until a subscription/invoice
      // event reports real money.
      status:
        obj.payment_status === 'paid'
          ? 'active'
          : obj.payment_status === 'no_payment_required'
            ? 'trialing'
            : 'incomplete',
    });
    return { matched: true, subscriptionId: sub.id, status: sub.status };
  }

  if (type.startsWith('customer.subscription.')) {
    const stripeSubId = String(obj.id || '');
    if (!stripeSubId) return { matched: false, reason: 'no subscription id' };
    const existing = getMemberSubscriptionByStripeId(db, stripeSubId);
    const leadId = Number(meta.bitpype_lead_id) || (existing ? existing.lead_id : 0);
    const memberId = Number(meta.bitpype_member_id) || (existing ? existing.member_id : 0);
    if (!leadId || !memberId) return { matched: false, reason: 'unknown subscription' };
    const tierId = Number(meta.bitpype_tier_id) || (existing ? existing.tier_id : null);
    const tier = tierId ? getMembershipTier(db, leadId, tierId) : null;
    const fields = {
      lead_id: leadId,
      member_id: memberId,
      tier_id: tierId || null,
      stripe_customer_id: String(obj.customer || (existing ? existing.stripe_customer_id : '') || ''),
      stripe_subscription_id: stripeSubId,
      status: String(obj.status || (existing ? existing.status : 'incomplete')),
      cancel_at_period_end: !!obj.cancel_at_period_end,
    };
    if (tier) {
      fields.tier_name = tier.name;
      fields.price_cents = tier.price_cents;
      fields.interval = tier.interval;
    }
    const end = subscriptionPeriodEnd(obj);
    if (end !== undefined) fields.current_period_end = end;
    if (type === 'customer.subscription.deleted') fields.status = 'canceled';
    const sub = upsertMemberSubscription(db, fields);
    return { matched: true, subscriptionId: sub.id, status: sub.status };
  }

  if (type === 'invoice.payment_failed' || type === 'invoice.paid') {
    // Batch 145 (external review F17): modern invoice objects carry
    // the subscription reference under
    // parent.subscription_details.subscription — the old top-level
    // read matched nothing and the event was dropped.
    const stripeSubId = require('./stripeShapes').invoiceSubscriptionId(obj);
    const existing = stripeSubId ? getMemberSubscriptionByStripeId(db, stripeSubId) : null;
    if (!existing) return { matched: false, reason: 'unknown subscription' };
    if (type === 'invoice.payment_failed') {
      if (existing.status === 'active' || existing.status === 'trialing') {
        const sub = upsertMemberSubscription(db, {
          lead_id: existing.lead_id,
          member_id: existing.member_id,
          stripe_subscription_id: stripeSubId,
          status: 'past_due',
        });
        return { matched: true, subscriptionId: sub.id, status: sub.status };
      }
      return { matched: true, subscriptionId: existing.id, status: existing.status };
    }
    // invoice.paid revives a past_due row; any other status is already
    // governed by the subscription.* events.
    if (existing.status === 'past_due') {
      const sub = upsertMemberSubscription(db, {
        lead_id: existing.lead_id,
        member_id: existing.member_id,
        stripe_subscription_id: stripeSubId,
        status: 'active',
      });
      return { matched: true, subscriptionId: sub.id, status: sub.status };
    }
    return { matched: true, subscriptionId: existing.id, status: existing.status };
  }

  return { matched: false, reason: 'unhandled event type' };
}

/* Public (token-scoped) paid membership: checkout + free join */

function memberFromOpts(db, leadId, opts = {}) {
  const member = getSessionMember(db, leadId, opts.memberSession || opts.sessionToken || '');
  if (!member) {
    const err = fail('MEMBER_LOCKED', 'Log in or create an account first.', 401);
    err.gate = { needs: 'login' };
    throw err;
  }
  return member;
}

/**
 * Stripe Checkout for a PAID tier, on the OWNER's Stripe account.
 * Prices come from the tier row server-side; the checkout metadata is
 * what the membership webhook routes + applies by.
 */
async function createMembershipCheckoutByToken(db, token, { tierId, returnUrl } = {}, opts = {}) {
  const row = membersEmbedByToken(db, token);
  const leadId = row.lead_id;
  const member = memberFromOpts(db, leadId, opts);
  const tier = getMembershipTier(db, leadId, tierId);
  if (!tier || !tier.active) throw fail('NOT_FOUND', 'That membership plan is not available.', 404);
  if (!(tier.price_cents > 0)) {
    throw fail('VALIDATION', 'That plan is free — use Join instead of checkout.', 400);
  }
  // Batch 129: memberships resolve through the ONE payments config
  // (purpose 'membership': unified → membership legacy — never the
  // workspace account). Not connected at all keeps the pre-129 409.
  const paymentsConfig = require('./paymentsConfig');
  const resolved = paymentsConfig.resolve(db, leadId, 'membership');
  if (!resolved) {
    throw fail('MEMBERSHIP_STRIPE_NOT_CONFIGURED', 'Paid memberships are not set up for this site yet.', 409);
  }
  const membershipStripe = require('./membershipStripe');
  const stripe = membershipStripe.getClient(db, leadId); // the resolved layer's client
  // Tier-price account safety: a tier's Stripe price lives on the
  // account that created it. If the payments config now resolves to
  // a DIFFERENT account (e.g. the owner unified onto the shop's
  // account), the stored price id does not exist there — verify it
  // and, when it is missing, re-ensure the tier's product+price on
  // the resolved account instead of failing the join. Existing
  // subscriptions are untouched either way: Stripe keeps billing
  // them on the account that created them; only NEW joins use the
  // new price.
  let priceId = String(tier.stripe_price_id || '');
  if (priceId) {
    try {
      await stripe.prices.retrieve(priceId);
    } catch {
      priceId = '';
    }
  }
  if (!priceId) {
    const ids = await membershipStripe.ensureTierStripePrice(db, leadId, tier);
    priceId = String(ids.stripe_price_id || '');
    db.prepare(
      'UPDATE membership_tiers SET stripe_product_id = ?, stripe_price_id = ?, updated_at = datetime(\'now\') WHERE id = ? AND lead_id = ?'
    ).run(String(ids.stripe_product_id || ''), priceId, Number(tier.id), Number(leadId));
  }
  const base = String(returnUrl || '').split('#')[0];
  let parsed;
  try {
    parsed = new URL(base);
  } catch {
    parsed = null;
  }
  if (!parsed || !/^https?:$/.test(parsed.protocol)) {
    throw fail('VALIDATION', 'A valid return URL is required for checkout', 400);
  }
  const sep = base.includes('?') ? '&' : '?';
  // Batch 129: the shared session stamps ride along — purpose +
  // the config layer that ran the charge — on the session AND the
  // subscription it creates, so the unified webhook attributes the
  // subscription to its origin account.
  const metadata = {
    bitpype_lead_id: String(leadId),
    bitpype_member_id: String(member.id),
    bitpype_tier_id: String(tier.id),
    bitpype_purpose: 'membership',
    bitpype_key_source: resolved.source,
  };
  let session;
  try {
    session = await stripe.checkout.sessions.create(
      {
        mode: 'subscription',
        line_items: [{ quantity: 1, price: priceId }],
        client_reference_id: String(member.id),
        customer_email: member.email,
        metadata,
        subscription_data: { metadata },
        success_url: `${base}${sep}membership=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${base}${sep}membership=cancelled`,
      },
      // Batch 154: keyed by lead + member + tier + price — a
      // retried join replays the original session; a price change
      // (new price id) is a different operation.
      {
        idempotencyKey: stripeIdempotencyKey('checkout-membership', Number(leadId), Number(member.id), Number(tier.id), priceId),
      }
    );
  } catch (e) {
    const err = new Error(e && e.message ? `Stripe checkout failed: ${e.message}` : 'Stripe checkout failed');
    err.code = 'MEMBERSHIP_CHECKOUT_FAILED';
    err.status = 502;
    throw err;
  }
  return { mode: 'stripe', url: session.url, sessionId: session.id, tier_id: tier.id };
}

/** Free-tier join (no Stripe): records the local membership row. */
function joinFreeTierByToken(db, token, { tierId } = {}, opts = {}) {
  const row = membersEmbedByToken(db, token);
  const leadId = row.lead_id;
  const member = memberFromOpts(db, leadId, opts);
  const tier = getMembershipTier(db, leadId, tierId);
  if (!tier || !tier.active) throw fail('NOT_FOUND', 'That membership plan is not available.', 404);
  if (tier.price_cents > 0) {
    throw fail('VALIDATION', 'That plan is paid — use checkout to join.', 400);
  }
  const sub = createFreeTierMembership(db, leadId, member.id, tier);
  return { joined: true, subscription: sub, member: publicMember(member) };
}

/* Admin oversight rollup (local records; payouts attach in the route) */

function adminMembershipsLocal(db) {
  ensureTables(db);
  const rows = db
    .prepare(
      `SELECT l.id AS lead_id, l.business_name AS lead_name,
         (SELECT COUNT(*) FROM site_members m WHERE m.lead_id = l.id) AS members_count,
         (SELECT COUNT(*) FROM membership_tiers t WHERE t.lead_id = l.id) AS tiers_count,
         (SELECT COUNT(*) FROM membership_stripe_keys k WHERE k.lead_id = l.id AND k.secret_key_enc <> '')
           + (SELECT COUNT(*) FROM lead_payment_configs u WHERE u.lead_id = l.id AND u.secret_key_enc <> '' AND NOT EXISTS (SELECT 1 FROM membership_stripe_keys k2 WHERE k2.lead_id = l.id AND k2.secret_key_enc <> '')) AS keys_connected
       FROM leads l
       WHERE EXISTS (SELECT 1 FROM site_module_embeds e WHERE e.lead_id = l.id AND e.module_type = 'members')
          OR EXISTS (SELECT 1 FROM site_members m2 WHERE m2.lead_id = l.id)
          OR EXISTS (SELECT 1 FROM membership_tiers t2 WHERE t2.lead_id = l.id)
       ORDER BY l.id ASC`
    )
    .all();
  return rows.map((r) => {
    const revenue = membershipRevenueSummary(db, r.lead_id);
    return {
      lead_id: Number(r.lead_id),
      lead_name: r.lead_name || '',
      members_count: Number(r.members_count) || 0,
      tiers_count: Number(r.tiers_count) || 0,
      paid_subs_active: revenue.active_paid_members,
      est_monthly_revenue_cents: revenue.est_monthly_revenue_cents,
      keys_connected: Number(r.keys_connected) > 0,
      payout: null,
    };
  });
}

/* Public (token-scoped) members surface */

function membersEmbedByToken(db, token) {
  ensureTables(db);
  const row = db
    .prepare('SELECT * FROM site_module_embeds WHERE public_token = ? AND published = 1')
    .get(String(token || ''));
  if (!row || row.module_type !== 'members') throw fail('NOT_FOUND', 'Membership module not found', 404);
  // Review fix: every public member flow funnels through here — an
  // archived site's membership surface closes with the site.
  assertSiteNotArchived(db, row.lead_id);
  assertSiteNotSuspended(db, row.lead_id);
  return row;
}

function publicMemberSignup(db, token, data = {}) {
  const row = membersEmbedByToken(db, token);
  return signupMember(db, row.lead_id, data);
}

function publicMemberLogin(db, token, data = {}) {
  const row = membersEmbedByToken(db, token);
  return loginMember(db, row.lead_id, data);
}

function publicMemberLogout(db, token, rawSession) {
  const row = membersEmbedByToken(db, token);
  return logoutMember(db, row.lead_id, rawSession);
}

/** Returns { embed, request|null } — the route composes + sends the email. */
function publicMemberForgot(db, token, email) {
  const row = membersEmbedByToken(db, token);
  return { embed: publicEmbed(row), request: requestMemberReset(db, row.lead_id, email) };
}

function publicMemberReset(db, token, data = {}) {
  const row = membersEmbedByToken(db, token);
  return resetMemberPassword(db, row.lead_id, data.reset_token || data.resetToken || '', data.password);
}

/** Members-page payload: public config + the caller's own member state. */
function publicMembersPayload(db, embedRow, opts = {}) {
  const leadId = embedRow.lead_id;
  const cfg = readMembersConfig(db, leadId);
  const access = resolveMemberAccess(db, leadId, opts);
  const tiers = listMembershipTiers(db, leadId).map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    price_cents: t.price_cents,
    price_label: t.price_label,
    interval: t.interval,
    free: !(t.price_cents > 0),
    joinable: t.price_cents > 0 ? !!t.stripe_price_id : true,
  }));
  let entitlement = null;
  if (access && access.member) {
    const memberRow = getSessionMember(db, leadId, opts.memberSession || opts.sessionToken || '');
    const info = memberAccessInfo(db, leadId, memberRow);
    entitlement = {
      has_paid: info.has_paid,
      tier_id: info.tier_id,
      tier_name: info.tier_name || '',
      source: info.source,
      current_period_end: info.subscription ? info.subscription.current_period_end : null,
      cancel_at_period_end: info.subscription ? info.subscription.cancel_at_period_end : false,
    };
  }
  return {
    embed: publicEmbed(embedRow),
    module_type: 'members',
    title: embedRow.title || MODULE_META.members.label,
    settings: parseEmbedSettings(embedRow),
    items: [],
    members: {
      config: {
        signup_mode: cfg.signup_mode,
        gate_mode: cfg.gate_mode,
        wall_headline: cfg.wall_headline,
        access_level: cfg.access_level,
        access_tier_id: cfg.access_tier_id,
      },
      member: access && access.member ? access.member : null,
      preview: !!(access && access.preview),
      members_token: embedRow.public_token,
      members_page: pageFileName(membersPageSlug(db, leadId)),
      tiers,
      entitlement,
      stripe_connected: membershipStripeStatus(db, leadId).connected,
    },
  };
}

/* Gated page bodies + export shells */

function stripModuleEmbedScripts(html) {
  return String(html || '').replace(/<script\b[^>]*src=["'][^"']*module-embed\.js[^"']*["'][^>]*>\s*<\/script>/gi, '');
}

/** The servable body of a freeform page: main content without site chrome. */
function extractServableBodyHtml(html) {
  const src = String(html || '');
  const main = src.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  if (main) return main[1];
  const body = src.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  if (body) {
    return body[1]
      .replace(/<header\b[^>]*>[\s\S]*?<\/header>/gi, '')
      .replace(/<footer\b[^>]*>[\s\S]*?<\/footer>/gi, '')
      .replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi, '');
  }
  return src;
}

/**
 * The real body of a page, served only to a valid member session (or an
 * owner preview grant) when the page is gated; un-gated pages render the
 * same way. Throws MEMBER_LOCKED (401) with the wall copy when locked.
 */
function getMemberPageBody(db, leadId, slug, opts = {}) {
  ensureTables(db);
  const id = Number(leadId);
  const gate = memberGateCheck(db, id, slug, opts);
  if (gate.locked) {
    const err = fail('MEMBER_LOCKED', gate.wall_headline, 401);
    err.gate = gateWallFields(gate);
    throw err;
  }
  const site = db
    .prepare('SELECT pages, theme FROM websites WHERE lead_id = ? ORDER BY id DESC LIMIT 1')
    .get(id);
  if (!site) throw fail('NOT_FOUND', 'Website not found', 404);
  let pages = [];
  let theme = {};
  try {
    pages = JSON.parse(site.pages || '[]');
  } catch {
    pages = [];
  }
  try {
    theme = JSON.parse(site.theme || '{}');
  } catch {
    theme = {};
  }
  if (!Array.isArray(pages)) throw fail('NOT_FOUND', 'Page not found', 404);
  const idx = findPageIndex(pages, slug);
  if (idx < 0) throw fail('NOT_FOUND', 'Page not found', 404);
  const page = pages[idx];
  const eng = require('../src/websiteEngine');
  let html = '';
  if (pageUsesSections(page)) {
    html = page.sections
      .filter((s) => s && s.type !== 'nav' && s.type !== 'footer')
      .map((s) => eng.sectionToHtml(s, theme, null))
      .join('\n');
  } else {
    html = eng.sanitizeHtml(extractServableBodyHtml(String(page.html || '')));
  }
  html = eng.applySitePartials(html, theme, page);
  html = eng.rewriteAnchorLinksToFiles(html, pages);
  html = stripModuleEmbedScripts(html);
  return { slug: normalizeSlug(page.slug || slug), title: String(page.title || ''), html };
}

function memberGateMountHtml(embedRow, slug, appUrl) {
  const base = String(appUrl || appBaseUrl()).replace(/\/$/, '');
  return (
    `<div class="bitpype-member-gate" data-bitpype-member-gate="1"` +
    ` data-bitpype-module-token="${escapeAttr(embedRow.public_token)}"` +
    ` data-bitpype-api="${escapeAttr(base)}"` +
    ` data-bitpype-page-slug="${escapeAttr(normalizeSlug(slug))}"></div>`
  );
}

function shellOutFreeformPage(html, mount, appUrl) {
  const src = String(html || '');
  if (/<main\b[^>]*>/i.test(src)) {
    const out = src.replace(/(<main\b[^>]*>)[\s\S]*?(<\/main>)/i, (m, open, close) => open + mount + close);
    return ensureModuleEmbedScript(out, appUrl);
  }
  const bodyMatch = src.match(/(<body\b[^>]*>)([\s\S]*?)(<\/body>)/i);
  if (bodyMatch) {
    const chrome = [];
    for (const tag of ['header', 'footer', 'nav']) {
      const m = bodyMatch[2].match(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, 'i'));
      if (m) chrome.push(m[0]);
    }
    const inner = `${chrome.join('\n')}<main class="bp-mod-main">${mount}</main>`;
    const out = src.replace(bodyMatch[0], `${bodyMatch[1]}${inner}${bodyMatch[3]}`);
    return ensureModuleEmbedScript(out, appUrl);
  }
  return `<main class="bp-mod-main">${mount}</main>` + moduleScriptTag(appUrl);
}

/**
 * Export-time gate: returns a copy of `pages` where every gated page's
 * authored body is replaced by a members gate shell. The stored pages are
 * never mutated — the real body is served later by getMemberPageBody.
 */
function gateExportPages(db, leadId, pages, opts = {}) {
  if (!Array.isArray(pages) || !pages.length) return pages;
  const cfg = readMembersConfig(db, leadId);
  if (cfg.gate_mode === 'off') return pages;
  const embed = membersEmbedForLead(db, leadId);
  if (!embed || !moduleEmbedActive(embed)) return pages;
  const appUrl = opts.appUrl || appBaseUrl();
  let changed = false;
  const out = pages.map((page) => {
    if (!page || typeof page !== 'object') return page;
    const slug = normalizeSlug(page.slug);
    if (!pageIsGated(db, leadId, slug)) return page;
    changed = true;
    const mount = memberGateMountHtml(embed, slug, appUrl);
    if (pageUsesSections(page)) {
      const nav = page.sections.filter((s) => s && s.type === 'nav');
      const footer = page.sections.filter((s) => s && s.type === 'footer');
      const gateSection = {
        type: 'html',
        content: { html: `<main class="bp-mod-main">${mount}</main>` + moduleScriptTag(appUrl) },
      };
      return { ...page, sections: [...nav, gateSection, ...footer] };
    }
    return { ...page, html: shellOutFreeformPage(page.html || '', mount, appUrl) };
  });
  return changed ? out : pages;
}

/* ── Bookings (services + hours + calendar slots) ── */

function parseHm(s) {
  const m = String(s || '')
    .trim()
    .match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

function formatHm(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function ymdFromDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseYmd(s) {
  const m = String(s || '')
    .trim()
    .match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return dt;
}

/* ── Batch 145 (external review F14): business-timezone math ──────
 * Availability used to compute "today", the booking window and slot
 * instants in SERVER-local time (UTC in production) while the
 * business's configured timezone was stored but never consumed —
 * every non-UTC business lost valid slots or was offered slots
 * inside its notice window. These helpers resolve a wall-clock time
 * in an IANA zone to an unambiguous UTC instant via Intl (the same
 * approach as siteChatUsage.dayKey): format the instant in the zone,
 * read the wall clock back, and the difference is the zone offset. */

/** Zone offset (ms) at an instant: wallClockAsUTC − utc. */
function zoneOffsetMs(timezone, utcMs) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  const wallAsUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') % 24,
    get('minute'),
    get('second')
  );
  return wallAsUtc - Math.floor(utcMs / 1000) * 1000;
}

/** UTC instant (ms) of a wall-clock time in `timezone`. */
function zonedWallToUtcMs(timezone, year, month, day, minutesOfDay) {
  const wallAsUtc = Date.UTC(year, month - 1, day, Math.floor(minutesOfDay / 60), minutesOfDay % 60, 0);
  let utc = wallAsUtc - zoneOffsetMs(timezone, wallAsUtc);
  // One refinement pass: the offset at the resolved instant can
  // differ from the offset at the naive guess around DST transitions.
  const refined = wallAsUtc - zoneOffsetMs(timezone, utc);
  if (refined !== utc) utc = refined;
  return utc;
}

/** { year, month, day } of an instant in `timezone`. */
function ymdPartsInZone(timezone, utcMs) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(utcMs));
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  return { year: get('year'), month: get('month'), day: get('day') };
}

function ymdString({ year, month, day }) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Calendar arithmetic on a {year, month, day} (zone-free). */
function addDaysYmd(parts, days) {
  const dt = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return { year: dt.getUTCFullYear(), month: dt.getUTCMonth() + 1, day: dt.getUTCDate() };
}

function publicBookingService(row) {
  if (!row) return null;
  const priceLabel = formatPrice(row.price_cents, row.currency);
  return {
    ...row,
    price_label: priceLabel,
    duration_label: `${row.duration_minutes} min`,
  };
}

function getBookingSettings(db, leadId) {
  ensureTables(db);
  let row = db.prepare('SELECT * FROM booking_settings WHERE lead_id = ?').get(Number(leadId));
  if (!row) {
    db.prepare(
      `
      INSERT INTO booking_settings (lead_id) VALUES (?)
    `
    ).run(Number(leadId));
    row = db.prepare('SELECT * FROM booking_settings WHERE lead_id = ?').get(Number(leadId));
  }
  return {
    lead_id: row.lead_id,
    timezone: row.timezone || 'America/New_York',
    slot_interval_minutes: Number(row.slot_interval_minutes) || 30,
    min_notice_hours: Number(row.min_notice_hours) || 0,
    max_days_ahead: Number(row.max_days_ahead) || 60,
    auto_confirm: !!row.auto_confirm,
    // Batch 136: the owner-set ONLINE-BOOKING discount. Default OFF:
    // no discount exists anywhere until the owner configures one.
    discount_enabled: !!row.discount_enabled,
    discount_kind: row.discount_kind === 'fixed' ? 'fixed' : 'percent',
    discount_value: Number(row.discount_value) || 0,
    discount_label: String(row.discount_label || ''),
    discount: bookingDiscountConfigFromRow(row),
    updated_at: row.updated_at,
  };
}

/* ── Batch 136: online-booking discount ─────────────────────────────
 * The discount is a standing public fact about booking online, not
 * a per-visitor judgment: the owner switches it on in the portal,
 * every online booking gets it, and every surface (booking widget,
 * checkout, chat) reads the SAME normalized config through here /
 * the shared layer. The model and the browser never invent terms —
 * display strings are templated from the stored config only. */

function bookingDiscountTerms(kind, value, currency = 'USD') {
  if (kind === 'fixed') return `${formatPrice(value, currency) || '$0.00'} off`;
  return `${Number(value) || 0}% off`;
}

function bookingDiscountDisplay(config, currency = 'USD') {
  if (!config || !config.enabled) return '';
  const terms = bookingDiscountTerms(config.kind, config.value, currency);
  const label = String(config.label || '').trim();
  return label ? `${label} — ${terms} when you book online` : `Book online — ${terms} your appointment`;
}

/** Normalized discount config from a booking_settings row, or null
 *  when the discount is OFF / unconfigured / stored-invalid. */
function bookingDiscountConfigFromRow(row) {
  if (!row || !row.discount_enabled) return null;
  const kind = row.discount_kind === 'fixed' ? 'fixed' : 'percent';
  const value = Number(row.discount_value);
  if (!Number.isInteger(value)) return null;
  if (kind === 'percent' && (value < 1 || value > 90)) return null;
  if (kind === 'fixed' && value <= 0) return null;
  const config = {
    enabled: true,
    kind,
    value,
    label: String(row.discount_label || '').trim().slice(0, 80),
  };
  config.terms = bookingDiscountTerms(kind, value);
  config.display = bookingDiscountDisplay(config);
  return config;
}

/** The lead's live booking-discount config (null = no discount). */
function getBookingDiscountConfig(db, leadId) {
  ensureTables(db);
  const row = db.prepare('SELECT * FROM booking_settings WHERE lead_id = ?').get(Number(leadId));
  return bookingDiscountConfigFromRow(row);
}

/**
 * The price stamp for one online booking: gross in, discount
 * computed SERVER-SIDE from the live config, net floored at 0.
 * Rounding: percent discounts round to the nearest cent; a fixed
 * discount larger than the price takes the whole price (net 0 —
 * the booking then follows the free-booking path, no payment).
 */
function bookingPriceStamp(db, leadId, grossCents, currency = 'USD') {
  const gross = Math.max(0, Math.round(Number(grossCents) || 0));
  const config = gross > 0 ? getBookingDiscountConfig(db, leadId) : null;
  let amount = 0;
  if (config) {
    amount =
      config.kind === 'percent' ? Math.round((gross * config.value) / 100) : Math.min(gross, config.value);
  }
  amount = Math.max(0, Math.min(gross, amount));
  return {
    gross_cents: gross,
    discount_amount_cents: amount,
    net_cents: gross - amount,
    currency: String(currency || 'USD').toUpperCase(),
    discount_kind: amount > 0 && config ? config.kind : '',
    discount_value: amount > 0 && config ? config.value : 0,
    discount_label: amount > 0 && config ? config.label : '',
    discount_display: amount > 0 && config ? bookingDiscountDisplay(config, currency) : '',
  };
}

/** The stamp shape carried on API responses (booking + order). */
function publicDiscountStamp(stamp) {
  if (!stamp || !(Number(stamp.discount_amount_cents) > 0)) return null;
  return {
    gross_cents: Number(stamp.gross_cents) || 0,
    discount_amount_cents: Number(stamp.discount_amount_cents) || 0,
    net_cents: Number(stamp.net_cents) || 0,
    currency: String(stamp.currency || 'USD').toUpperCase(),
    kind: String(stamp.discount_kind || ''),
    value: Number(stamp.discount_value) || 0,
    label: String(stamp.discount_label || ''),
    display: String(stamp.discount_display || ''),
  };
}

/** The same stamp read back off a bookings row. */
function bookingDiscountStampFromAppointment(appointment) {
  if (!appointment) return null;
  return publicDiscountStamp({
    gross_cents: appointment.price_gross_cents,
    discount_amount_cents: appointment.discount_amount_cents,
    net_cents: appointment.price_net_cents,
    currency: appointment.currency || 'USD',
    discount_kind: appointment.discount_kind,
    discount_value: appointment.discount_value,
    discount_label: appointment.discount_label,
    discount_display:
      Number(appointment.discount_amount_cents) > 0
        ? bookingDiscountDisplay(
            {
              enabled: true,
              kind: appointment.discount_kind,
              value: appointment.discount_value,
              label: appointment.discount_label,
            },
            appointment.service_currency || appointment.currency || 'USD'
          )
        : '',
  });
}

/**
 * Batch 136 × Batch 129 INTEGRATION POINT: the shared checkout
 * engine's booking line, discounted. Takes the line built by 129's
 * lineForBookingService (gross unit price from the service row) and
 * the appointment's server-computed stamp, and returns the line the
 * engine must charge: unit + total at NET, with the full stamp in
 * source_meta so the order line itself records gross/discount/net.
 */
function applyBookingDiscountToLine(line, stamp) {
  if (!line || !stamp) return line;
  let meta = {};
  try {
    meta = JSON.parse(line.source_meta || '{}');
  } catch {
    meta = {};
  }
  const net = Math.max(0, Number(stamp.net_cents) || 0);
  return {
    ...line,
    unit_price_cents: net,
    line_total_cents: net,
    source_meta: JSON.stringify({
      ...meta,
      price_gross_cents: Number(stamp.gross_cents) || 0,
      discount_kind: String(stamp.discount_kind || ''),
      discount_value: Number(stamp.discount_value) || 0,
      discount_amount_cents: Number(stamp.discount_amount_cents) || 0,
      price_net_cents: net,
      discount_label: String(stamp.discount_label || ''),
    }),
  };
}

function updateBookingSettings(db, leadId, data = {}) {
  ensureTables(db);
  getBookingSettings(db, leadId);
  const cur = db.prepare('SELECT * FROM booking_settings WHERE lead_id = ?').get(Number(leadId));
  const timezone = data.timezone != null ? String(data.timezone).slice(0, 80) : cur.timezone;
  // Batch 145 (external review F14): a saved timezone drives all
  // availability math — refuse an unusable value outright (never
  // clamp it into a different zone than the owner typed).
  if (data.timezone != null && !require('./siteChatUsage').isValidTimezone(timezone)) {
    throw fail('VALIDATION', 'timezone must be a valid IANA timezone (e.g. America/New_York)');
  }
  let interval = data.slot_interval_minutes != null ? Number(data.slot_interval_minutes) : cur.slot_interval_minutes;
  if (!Number.isFinite(interval) || interval < 5) interval = 5;
  if (interval > 240) interval = 240;
  let notice = data.min_notice_hours != null ? Number(data.min_notice_hours) : cur.min_notice_hours;
  if (!Number.isFinite(notice) || notice < 0) notice = 0;
  if (notice > 168) notice = 168;
  let ahead = data.max_days_ahead != null ? Number(data.max_days_ahead) : cur.max_days_ahead;
  if (!Number.isFinite(ahead) || ahead < 1) ahead = 1;
  if (ahead > 365) ahead = 365;
  const auto = data.auto_confirm != null ? (data.auto_confirm ? 1 : 0) : cur.auto_confirm;
  // Batch 136: discount fields — validated, never clamped into a
  // different deal than the owner typed. Kind/value/label are kept
  // while the discount is off (so re-enabling restores the deal);
  // switching it ON requires a complete, valid configuration.
  const discountEnabled =
    data.discount_enabled != null
      ? data.discount_enabled === true || data.discount_enabled === 1 || data.discount_enabled === 'true'
        ? 1
        : 0
      : cur.discount_enabled
        ? 1
        : 0;
  const discountKindRaw =
    data.discount_kind != null ? String(data.discount_kind).trim().toLowerCase() : cur.discount_kind || 'percent';
  if (discountKindRaw !== 'percent' && discountKindRaw !== 'fixed') {
    throw fail('VALIDATION', 'discount_kind must be percent or fixed');
  }
  const discountKind = discountKindRaw;
  let discountValue;
  if (data.discount_value_cents != null && discountKind === 'fixed') discountValue = Number(data.discount_value_cents);
  else if (data.discount_value != null) discountValue = Number(data.discount_value);
  else discountValue = Number(cur.discount_value) || 0;
  if (!Number.isInteger(discountValue) || discountValue < 0) {
    throw fail('VALIDATION', 'discount_value must be a whole number (percent points, or cents for a fixed discount)');
  }
  if (discountKind === 'percent' && discountValue > 90) {
    throw fail('VALIDATION', 'A percent discount must be between 1 and 90');
  }
  if (discountEnabled) {
    if (discountKind === 'percent' && discountValue < 1) {
      throw fail('VALIDATION', 'Set a percent discount between 1 and 90 to switch the discount on');
    }
    if (discountKind === 'fixed' && discountValue < 1) {
      throw fail('VALIDATION', 'Set a fixed discount amount above $0.00 to switch the discount on');
    }
  }
  const discountLabel =
    data.discount_label != null
      ? String(data.discount_label).trim().slice(0, 80)
      : String(cur.discount_label || '');
  db.prepare(
    `
    UPDATE booking_settings SET timezone=?, slot_interval_minutes=?, min_notice_hours=?,
      max_days_ahead=?, auto_confirm=?, discount_enabled=?, discount_kind=?, discount_value=?,
      discount_label=?, updated_at=datetime('now') WHERE lead_id=?
  `
  ).run(
    timezone,
    interval,
    notice,
    ahead,
    auto,
    discountEnabled,
    discountKind,
    discountValue,
    discountLabel,
    Number(leadId)
  );
  return getBookingSettings(db, leadId);
}

function listBookingHours(db, leadId) {
  ensureTables(db);
  const rows = db
    .prepare('SELECT * FROM booking_hours WHERE lead_id = ? ORDER BY weekday ASC, start_time ASC')
    .all(Number(leadId));
  return rows;
}

function ensureDefaultBookingHours(db, leadId) {
  ensureTables(db);
  const existing = listBookingHours(db, leadId);
  if (existing.length) return existing;
  const insert = db.prepare('INSERT INTO booking_hours (lead_id, weekday, start_time, end_time) VALUES (?, ?, ?, ?)');
  const tx = db.transaction(() => {
    for (const h of DEFAULT_BOOKING_HOURS) {
      insert.run(Number(leadId), h.weekday, h.start_time, h.end_time);
    }
  });
  tx();
  return listBookingHours(db, leadId);
}

function setBookingHours(db, leadId, hours) {
  ensureTables(db);
  if (!Array.isArray(hours)) throw fail('VALIDATION', 'hours is required');
  const list = hours;
  const cleaned = [];
  for (const h of list) {
    const weekday = Number(h.weekday);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
      throw fail('VALIDATION', 'weekday must be 0 (Sun) through 6 (Sat)');
    }
    const start = parseHm(h.start_time || h.start);
    const end = parseHm(h.end_time || h.end);
    if (start == null || end == null || end <= start) {
      throw fail('VALIDATION', 'Each hour needs start_time and end_time as HH:MM with end after start');
    }
    cleaned.push({ weekday, start_time: formatHm(start), end_time: formatHm(end) });
  }
  const del = db.prepare('DELETE FROM booking_hours WHERE lead_id = ?');
  const insert = db.prepare('INSERT INTO booking_hours (lead_id, weekday, start_time, end_time) VALUES (?, ?, ?, ?)');
  const tx = db.transaction(() => {
    del.run(Number(leadId));
    for (const h of cleaned) insert.run(Number(leadId), h.weekday, h.start_time, h.end_time);
  });
  tx();
  return listBookingHours(db, leadId);
}

function listBookingBlocks(db, leadId, { from, to } = {}) {
  ensureTables(db);
  let sql = 'SELECT * FROM booking_blocks WHERE lead_id = ?';
  const params = [Number(leadId)];
  if (from) {
    sql += ' AND block_date >= ?';
    params.push(String(from));
  }
  if (to) {
    sql += ' AND block_date <= ?';
    params.push(String(to));
  }
  sql += ' ORDER BY block_date ASC, start_time ASC, id ASC';
  return db.prepare(sql).all(...params);
}

function createBookingBlock(db, leadId, data = {}) {
  ensureTables(db);
  const date = String(data.block_date || data.date || '').trim();
  if (!parseYmd(date)) throw fail('VALIDATION', 'block_date must be YYYY-MM-DD');
  const start = data.start_time != null ? String(data.start_time).trim() : '';
  const end = data.end_time != null ? String(data.end_time).trim() : '';
  if (start || end) {
    if (parseHm(start) == null || parseHm(end) == null || parseHm(end) <= parseHm(start)) {
      throw fail('VALIDATION', 'Partial blocks need valid start_time and end_time');
    }
  }
  const info = db
    .prepare(
      `
    INSERT INTO booking_blocks (lead_id, block_date, start_time, end_time, reason)
    VALUES (?, ?, ?, ?, ?)
  `
    )
    .run(Number(leadId), date, start, end, String(data.reason || '').slice(0, 240));
  return db.prepare('SELECT * FROM booking_blocks WHERE id = ?').get(info.lastInsertRowid);
}

function deleteBookingBlock(db, leadId, id) {
  ensureTables(db);
  const row = db.prepare('SELECT * FROM booking_blocks WHERE id = ? AND lead_id = ?').get(Number(id), Number(leadId));
  if (!row) throw fail('NOT_FOUND', 'Block not found', 404);
  db.prepare('DELETE FROM booking_blocks WHERE id = ?').run(row.id);
  return { deleted: true, id: row.id };
}

function listBookingServices(db, leadId, { includeDrafts = true } = {}) {
  ensureTables(db);
  let sql = 'SELECT * FROM booking_services WHERE lead_id = ?';
  if (!includeDrafts) sql += " AND status = 'published'";
  sql += ' ORDER BY sort_order ASC, name ASC, id ASC';
  return db.prepare(sql).all(Number(leadId)).map(publicBookingService);
}

function getBookingService(db, leadId, idOrSlug) {
  ensureTables(db);
  const lid = Number(leadId);
  let row;
  if (/^\d+$/.test(String(idOrSlug))) {
    row = db.prepare('SELECT * FROM booking_services WHERE lead_id = ? AND id = ?').get(lid, Number(idOrSlug));
  } else {
    row = db.prepare('SELECT * FROM booking_services WHERE lead_id = ? AND slug = ?').get(lid, slugify(idOrSlug));
  }
  return publicBookingService(row);
}

function createBookingService(db, leadId, data = {}) {
  ensureTables(db);
  ensureDefaultBookingHours(db, leadId);
  getBookingSettings(db, leadId);
  const name = String(data.name || data.title || '').trim();
  if (!name) throw fail('VALIDATION', 'name is required');
  const status = String(data.status || 'draft').toLowerCase() === 'published' ? 'published' : 'draft';
  let slug = slugify(data.slug || name, 'service');
  const exists = db.prepare('SELECT id FROM booking_services WHERE lead_id = ? AND slug = ?').get(Number(leadId), slug);
  if (exists) slug = `${slug}-${Date.now().toString(36).slice(-4)}`;
  let duration = Number(data.duration_minutes != null ? data.duration_minutes : data.duration) || 30;
  if (duration < 5) duration = 5;
  if (duration > 480) duration = 480;
  let buffer = Number(data.buffer_minutes != null ? data.buffer_minutes : data.buffer) || 0;
  if (buffer < 0) buffer = 0;
  if (buffer > 240) buffer = 240;
  let priceCents = 0;
  if (data.price_cents != null) priceCents = Math.round(Number(data.price_cents)) || 0;
  else if (data.price != null) priceCents = Math.round(Number(data.price) * 100) || 0;
  const info = db
    .prepare(
      `
    INSERT INTO booking_services
      (lead_id, name, slug, description, duration_minutes, buffer_minutes, price_cents, currency, image_url, status, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
    )
    .run(
      Number(leadId),
      name.slice(0, 200),
      slug,
      String(data.description || ''),
      duration,
      buffer,
      priceCents,
      String(data.currency || 'USD')
        .slice(0, 8)
        .toUpperCase(),
      String(data.image_url || data.image || ''),
      status,
      Number(data.sort_order) || 0
    );
  return getBookingService(db, leadId, info.lastInsertRowid);
}

function updateBookingService(db, leadId, id, data = {}) {
  ensureTables(db);
  const raw = db.prepare('SELECT * FROM booking_services WHERE lead_id = ? AND id = ?').get(Number(leadId), Number(id));
  if (!raw) throw fail('NOT_FOUND', 'Service not found', 404);
  const name =
    data.name != null || data.title != null
      ? String(data.name != null ? data.name : data.title)
          .trim()
          .slice(0, 200)
      : raw.name;
  let slug = raw.slug;
  if (data.slug != null) {
    slug = slugify(data.slug, 'service');
    const clash = db
      .prepare('SELECT id FROM booking_services WHERE lead_id = ? AND slug = ? AND id != ?')
      .get(Number(leadId), slug, raw.id);
    if (clash) throw fail('VALIDATION', 'slug already in use');
  }
  const description = data.description != null ? String(data.description) : raw.description;
  let duration = raw.duration_minutes;
  if (data.duration_minutes != null || data.duration != null) {
    duration = Number(data.duration_minutes != null ? data.duration_minutes : data.duration) || 30;
    if (duration < 5) duration = 5;
    if (duration > 480) duration = 480;
  }
  let buffer = raw.buffer_minutes;
  if (data.buffer_minutes != null || data.buffer != null) {
    buffer = Number(data.buffer_minutes != null ? data.buffer_minutes : data.buffer) || 0;
    if (buffer < 0) buffer = 0;
    if (buffer > 240) buffer = 240;
  }
  let priceCents = raw.price_cents;
  if (data.price_cents != null) priceCents = Math.round(Number(data.price_cents)) || 0;
  else if (data.price != null) priceCents = Math.round(Number(data.price) * 100) || 0;
  const currency = data.currency != null ? String(data.currency).slice(0, 8).toUpperCase() : raw.currency;
  const image =
    data.image_url != null || data.image != null
      ? String(data.image_url != null ? data.image_url : data.image)
      : raw.image_url;
  const status =
    data.status != null ? (String(data.status).toLowerCase() === 'published' ? 'published' : 'draft') : raw.status;
  const sortOrder = data.sort_order != null ? Number(data.sort_order) || 0 : raw.sort_order;
  db.prepare(
    `
    UPDATE booking_services SET name=?, slug=?, description=?, duration_minutes=?, buffer_minutes=?,
      price_cents=?, currency=?, image_url=?, status=?, sort_order=?, updated_at=datetime('now')
    WHERE id=? AND lead_id=?
  `
  ).run(
    name,
    slug,
    description,
    duration,
    buffer,
    priceCents,
    currency,
    image,
    status,
    sortOrder,
    raw.id,
    Number(leadId)
  );
  return getBookingService(db, leadId, raw.id);
}

/**
 * Batch 66 — appointments that still block a service (or the whole
 * Bookings module) from being deleted: live bookings in the future.
 * Cancelled/completed rows and archived rows never block; their
 * service name is snapshotted instead (see deleteBookingService).
 */
function listUpcomingAppointments(db, leadId, serviceId = null) {
  ensureTables(db);
  const sql = serviceId
    ? 'SELECT * FROM bookings WHERE lead_id = ? AND service_id = ? AND archived_at IS NULL'
    : 'SELECT * FROM bookings WHERE lead_id = ? AND archived_at IS NULL';
  const rows = db.prepare(sql).all(...(serviceId ? [Number(leadId), Number(serviceId)] : [Number(leadId)]));
  const now = Date.now();
  return rows.filter((b) => {
    const st = String(b.status || '').toLowerCase();
    if (st !== 'pending' && st !== 'confirmed') return false;
    const t = new Date(String(b.starts_at || '')).getTime();
    return Number.isFinite(t) && t >= now;
  });
}

function deleteBookingService(db, leadId, id) {
  ensureTables(db);
  const row = db.prepare('SELECT * FROM booking_services WHERE lead_id = ? AND id = ?').get(Number(leadId), Number(id));
  if (!row) throw fail('NOT_FOUND', 'Service not found', 404);
  // Batch 66 (Ely: per-record service delete): a service with upcoming
  // appointments cannot be deleted out from under its customers —
  // cancel or reassign them first. Past appointments keep a readable
  // service via the snapshot columns (the bookings table holds only a
  // service_id FK, so the name/duration are copied onto the rows
  // before the service goes; appointment lists COALESCE to them).
  const upcoming = listUpcomingAppointments(db, leadId, row.id);
  if (upcoming.length) {
    throw fail(
      'SERVICE_HAS_UPCOMING',
      `This service has ${upcoming.length} upcoming appointment${upcoming.length === 1 ? '' : 's'}. Cancel or reassign them before deleting the service.`,
      409
    );
  }
  const snap = db
    .prepare(
      `UPDATE bookings SET service_name_snapshot = ?, service_duration_snapshot = ?
       WHERE lead_id = ? AND service_id = ? AND COALESCE(service_name_snapshot, '') = ''`
    )
    .run(String(row.name || ''), row.duration_minutes != null ? Number(row.duration_minutes) : null, Number(leadId), row.id);
  db.prepare('DELETE FROM booking_services WHERE id = ? AND lead_id = ?').run(row.id, Number(leadId));
  return {
    deleted: true,
    id: row.id,
    name: row.name || '',
    past_appointments_snapshotted: snap.changes || 0,
  };
}

function listAppointments(
  db,
  leadId,
  { status, from, to, limit = 200, includeArchived = false, archivedOnly = false } = {}
) {
  ensureTables(db);
  // Batch 129: reading appointments converges expired payment holds.
  releaseExpiredBookingHolds(db, leadId);
  let sql = `
    SELECT b.*, COALESCE(NULLIF(b.service_name_snapshot, ''), s.name) AS service_name, COALESCE(b.service_duration_snapshot, s.duration_minutes) AS service_duration, COALESCE(s.currency, 'USD') AS service_currency
    FROM bookings b
    LEFT JOIN booking_services s ON s.id = b.service_id
    WHERE b.lead_id = ?
  `;
  const params = [Number(leadId)];
  if (status) {
    sql += ' AND b.status = ?';
    params.push(String(status));
  }
  if (archivedOnly) {
    sql += ' AND b.archived_at IS NOT NULL';
  } else if (!includeArchived) {
    sql += ' AND b.archived_at IS NULL';
  }
  if (from) {
    sql += ' AND b.starts_at >= ?';
    params.push(String(from));
  }
  if (to) {
    sql += ' AND b.starts_at <= ?';
    params.push(String(to));
  }
  sql += ' ORDER BY b.starts_at ASC, b.id ASC LIMIT ?';
  params.push(Math.min(500, Math.max(1, Number(limit) || 200)));
  return db.prepare(sql).all(...params);
}

function getAppointment(db, leadId, id) {
  ensureTables(db);
  return db
    .prepare(
      `
    SELECT b.*, COALESCE(NULLIF(b.service_name_snapshot, ''), s.name) AS service_name, COALESCE(b.service_duration_snapshot, s.duration_minutes) AS service_duration, COALESCE(s.currency, 'USD') AS service_currency
    FROM bookings b
    LEFT JOIN booking_services s ON s.id = b.service_id
    WHERE b.lead_id = ? AND b.id = ?
  `
    )
    .get(Number(leadId), Number(id));
}

function updateAppointmentStatus(db, leadId, id, status) {
  ensureTables(db);
  const row = getAppointment(db, leadId, id);
  if (!row) throw fail('NOT_FOUND', 'Appointment not found', 404);
  const st = String(status || '').toLowerCase();
  if (!BOOKING_STATUSES.includes(st)) {
    throw fail('VALIDATION', `status must be one of: ${BOOKING_STATUSES.join(', ')}`);
  }
  db.prepare("UPDATE bookings SET status = ?, updated_at = datetime('now') WHERE id = ? AND lead_id = ?").run(
    st,
    row.id,
    Number(leadId)
  );
  return getAppointment(db, leadId, row.id);
}

const ARCHIVABLE_STATUSES = ['completed', 'cancelled'];

function setAppointmentArchived(db, leadId, id, archived = true) {
  ensureTables(db);
  const row = getAppointment(db, leadId, id);
  if (!row) throw fail('NOT_FOUND', 'Appointment not found', 404);
  const want = archived === true || archived === 1 || String(archived).toLowerCase() === 'true';
  if (want) {
    if (!ARCHIVABLE_STATUSES.includes(String(row.status || '').toLowerCase())) {
      throw fail('VALIDATION', `Only ${ARCHIVABLE_STATUSES.join(' or ')} appointments can be archived`);
    }
    db.prepare(
      "UPDATE bookings SET archived_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND lead_id = ?"
    ).run(row.id, Number(leadId));
  } else {
    db.prepare("UPDATE bookings SET archived_at = NULL, updated_at = datetime('now') WHERE id = ? AND lead_id = ?").run(
      row.id,
      Number(leadId)
    );
  }
  return getAppointment(db, leadId, row.id);
}

function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

function listAvailableSlots(db, leadId, { date, serviceId, serviceSlug } = {}) {
  ensureTables(db);
  // Batch 129: an expired payment hold must never keep a slot busy.
  releaseExpiredBookingHolds(db, leadId);
  ensureDefaultBookingHours(db, leadId);
  const settings = getBookingSettings(db, leadId);
  const day = parseYmd(date);
  if (!day) throw fail('VALIDATION', 'date must be YYYY-MM-DD');

  // Batch 145 (F14): "today", the window and every slot instant are
  // computed in the BUSINESS timezone (settings.timezone), never the
  // server's. A stored value that isn't a usable IANA zone falls
  // back to UTC for reads (saves refuse invalid values outright).
  const tz = require('./siteChatUsage').isValidTimezone(settings.timezone) ? settings.timezone : 'UTC';
  const requested = { year: day.getFullYear(), month: day.getMonth() + 1, day: day.getDate() };
  const requestedYmd = ymdString(requested);
  const todayYmd = ymdString(ymdPartsInZone(tz, Date.now()));
  const maxYmd = ymdString(addDaysYmd(ymdPartsInZone(tz, Date.now()), settings.max_days_ahead));
  if (requestedYmd < todayYmd) throw fail('VALIDATION', 'date is in the past');
  if (requestedYmd > maxYmd)
    throw fail('VALIDATION', `date is beyond the ${settings.max_days_ahead}-day booking window`);

  let service = null;
  if (serviceId != null) service = getBookingService(db, leadId, serviceId);
  else if (serviceSlug) service = getBookingService(db, leadId, serviceSlug);
  else {
    const services = listBookingServices(db, leadId, { includeDrafts: false });
    if (services.length === 1) service = services[0];
  }
  if (!service || service.status !== 'published') {
    throw fail('VALIDATION', 'A published service is required (serviceId)');
  }

  // Weekday of a calendar date is zone-independent (a property of
  // the date itself) — computed on the UTC calendar to stay so.
  const weekday = new Date(Date.UTC(requested.year, requested.month - 1, requested.day)).getUTCDay();
  const windows = listBookingHours(db, leadId).filter((h) => Number(h.weekday) === weekday);
  if (!windows.length) {
    return {
      date: requestedYmd,
      service: service,
      settings,
      slots: [],
      closed: true,
    };
  }

  const ymd = requestedYmd;
  const blocks = listBookingBlocks(db, leadId, { from: ymd, to: ymd });
  const duration = Number(service.duration_minutes) || 30;
  const buffer = Number(service.buffer_minutes) || 0;
  const step = Math.max(5, Number(settings.slot_interval_minutes) || duration);
  const noticeMs = (Number(settings.min_notice_hours) || 0) * 60 * 60 * 1000;
  const earliest = Date.now() + noticeMs;

  const busy = listAppointments(db, leadId, {
    from: `${ymd}T00:00:00`,
    to: `${ymd}T23:59:59`,
  }).filter((b) => b.status === 'pending' || b.status === 'confirmed');

  const slots = [];
  for (const win of windows) {
    const wStart = parseHm(win.start_time);
    const wEnd = parseHm(win.end_time);
    if (wStart == null || wEnd == null) continue;
    for (let t = wStart; t + duration <= wEnd; t += step) {
      const startLabel = formatHm(t);
      const endLabel = formatHm(t + duration);
      const startIso = `${ymd}T${startLabel}:00`;
      const endIso = `${ymd}T${endLabel}:00`;
      // Batch 145 (F14): the slot label is a wall-clock time in the
      // business zone — resolve it to its true UTC instant for the
      // notice cutoff comparison. (starts_at strings keep the
      // established wall-clock convention; the zone from
      // booking_settings is what makes them unambiguous.)
      const startMs = zonedWallToUtcMs(tz, requested.year, requested.month, requested.day, t);
      if (startMs < earliest) continue;

      let blocked = false;
      for (const bl of blocks) {
        if (!bl.start_time && !bl.end_time) {
          blocked = true;
          break;
        }
        const bs = parseHm(bl.start_time);
        const be = parseHm(bl.end_time);
        if (bs != null && be != null && rangesOverlap(t, t + duration, bs, be)) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;

      let conflict = false;
      for (const b of busy) {
        const bStart = String(b.starts_at || '');
        const bEnd = String(b.ends_at || '');
        // Expand busy by buffer on both sides of existing appointment
        const bStartM = parseHm(bStart.slice(11, 16));
        const bEndM = parseHm(bEnd.slice(11, 16));
        if (bStartM == null || bEndM == null) continue;
        if (rangesOverlap(t, t + duration + buffer, bStartM - buffer, bEndM + buffer)) {
          conflict = true;
          break;
        }
      }
      if (conflict) continue;

      slots.push({
        starts_at: startIso,
        ends_at: endIso,
        label: startLabel,
      });
    }
  }

  return {
    date: ymd,
    service,
    settings,
    slots,
    closed: false,
  };
}

/**
 * Batch 129 — pay-at-booking hold lifecycle. A priced booking whose
 * business has payments connected starts life as a HOLD: a real
 * appointment row (status 'pending', payment_state 'hold') that
 * blocks its slot exactly like any pending appointment, for
 * BOOKING_PAYMENT_HOLD_MINUTES. Payment (via the shared shop
 * webhook → applyShopStripeEvent) flips it to payment_state 'paid'
 * (and 'confirmed' when the business auto-confirms); an expired or
 * failed checkout releases it (payment_state 'released', status
 * 'cancelled'). Holds that simply lapse are released LAZILY by this
 * sweep — called on every availability read, every appointment
 * list, and every new booking — so an abandoned checkout can never
 * squat a slot past its window. The appointment stays the record of
 * fulfillment; the ecommerce_orders row (bookings.payment_order_id)
 * is the record of payment; they reference each other.
 */
function releaseExpiredBookingHolds(db, leadId) {
  ensureTables(db);
  const nowIso = new Date().toISOString();
  const info = db
    .prepare(
      `UPDATE bookings SET status = 'cancelled', payment_state = 'released', updated_at = datetime('now')
       WHERE lead_id = ? AND payment_state = 'hold' AND payment_expires_at IS NOT NULL AND payment_expires_at <= ?`
    )
    .run(Number(leadId), nowIso);
  return Number(info.changes) || 0;
}

/** The shared-engine line for one priced booking: the appointment IS
 *  the item being sold (quantity 1, server-side price from the
 *  service row — the client never names an amount). */
function lineForBookingService(service, appointment) {
  return {
    source_module: 'bookings',
    source_meta: JSON.stringify({
      appointment_id: Number(appointment.id),
      starts_at: String(appointment.starts_at || ''),
      service_name: String(service.name || ''),
    }),
    product_id: Number(service.id),
    product_name: String(service.name || 'Booking'),
    variant_id: null,
    variant_label: '',
    image_url: String(service.image_url || ''),
    unit_price_cents: Number(service.price_cents) || 0,
    quantity: 1,
    line_total_cents: Number(service.price_cents) || 0,
    currency: String(service.currency || 'USD').toUpperCase(),
    description: '',
  };
}

function createPublicBooking(db, leadId, data = {}, opts = {}) {
  ensureTables(db);
  // Batch 129: a stale hold never blocks the slot this booking wants.
  releaseExpiredBookingHolds(db, leadId);
  ensureDefaultBookingHours(db, leadId);
  const settings = getBookingSettings(db, leadId);
  const service = getBookingService(db, leadId, data.service_id || data.serviceId || data.service);
  if (!service || service.status !== 'published') {
    throw fail('VALIDATION', 'service_id must reference a published service');
  }
  const name = String(data.customer_name || data.name || '').trim();
  const email = String(data.customer_email || data.email || '').trim();
  const phone = String(data.customer_phone || data.phone || '').trim();
  if (!name) throw fail('VALIDATION', 'customer_name is required');
  if (!email && !phone) throw fail('VALIDATION', 'customer_email or customer_phone is required');

  let startsAt = String(data.starts_at || data.start || '').trim();
  if (!startsAt && data.date && data.time) {
    const time = String(data.time).trim();
    const hm = parseHm(time.length === 5 ? time : time.slice(0, 5));
    if (!parseYmd(data.date) || hm == null) throw fail('VALIDATION', 'date and time must be YYYY-MM-DD and HH:MM');
    startsAt = `${data.date}T${formatHm(hm)}:00`;
  }
  const m = startsAt.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  if (!m) throw fail('VALIDATION', 'starts_at must be YYYY-MM-DDTHH:MM');
  const date = m[1];
  const time = m[2];
  const duration = Number(service.duration_minutes) || 30;
  const startMins = parseHm(time);
  const endsAt = `${date}T${formatHm(startMins + duration)}:00`;

  const available = listAvailableSlots(db, leadId, { date, serviceId: service.id });
  const okSlot = (available.slots || []).some((s) => s.starts_at === `${date}T${time}:00` || s.label === time);
  if (!okSlot) throw fail('VALIDATION', 'That time slot is no longer available', 409);

  // Batch 129: a payment hold stays 'pending' until the money lands —
  // auto_confirm applies at PAYMENT time (applyShopStripeEvent), not
  // at request time, so an unpaid hold can never read as confirmed.
  // (The sole caller, createPublicBookingByToken, passes paymentHold
  // only when the Batch 136 stamp's NET is > 0, so a $0-net booking
  // never reaches this branch and follows the free-booking path.)
  const paymentHold = !!(opts && opts.paymentHold) && Number(service.price_cents) > 0;
  const status = paymentHold ? 'pending' : settings.auto_confirm ? 'confirmed' : 'pending';
  // Batch 136: an ONLINE booking is stamped at creation with the
  // price it will be charged at — gross, the live-config discount,
  // net — computed here, server-side, never from the request body.
  const stamp = bookingPriceStamp(db, leadId, Number(service.price_cents) || 0, service.currency || 'USD');
  const info = db
    .prepare(
      `
    INSERT INTO bookings
      (lead_id, service_id, customer_name, customer_email, customer_phone, starts_at, ends_at, notes, status,
       price_gross_cents, discount_label, discount_kind, discount_value, discount_amount_cents, price_net_cents)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
    )
    .run(
      Number(leadId),
      service.id,
      name.slice(0, 200),
      email.slice(0, 240),
      phone.slice(0, 60),
      `${date}T${time}:00`,
      endsAt,
      String(data.notes || '').slice(0, 2000),
      status,
      stamp.gross_cents,
      stamp.discount_label,
      stamp.discount_kind,
      stamp.discount_value,
      stamp.discount_amount_cents,
      stamp.net_cents
    );
  if (paymentHold) {
    const expiresAt = new Date(Date.now() + BOOKING_PAYMENT_HOLD_MINUTES * 60 * 1000).toISOString();
    db.prepare(
      "UPDATE bookings SET payment_state = 'hold', payment_expires_at = ?, updated_at = datetime('now') WHERE id = ? AND lead_id = ?"
    ).run(expiresAt, Number(info.lastInsertRowid), Number(leadId));
  }
  const appt = getAppointment(db, leadId, info.lastInsertRowid);
  try {
    const portalContacts = require('./portalContacts');
    portalContacts.captureFromBooking(db, {
      leadId,
      booking: appt,
      serviceName: service.name,
      pageSlug: '',
    });
  } catch (e) {
    console.warn('[siteModules] LeadScout booking capture failed:', e.message || e);
  }
  return appt;
}


function deleteAppointment(db, leadId, id) {
  ensureTables(db);
  const row = getAppointment(db, leadId, id);
  if (!row) throw fail('NOT_FOUND', 'Appointment not found', 404);
  db.prepare('DELETE FROM bookings WHERE id = ? AND lead_id = ?').run(row.id, Number(leadId));
  deleteLeadScoutEventsByRef(db, 'booking_id', row.id);
  return { deleted: true, id: row.id };
}

function moduleItemCount(db, leadId, type) {
  if (type === 'blog') return countBlogPosts(db, leadId);
  if (type === 'ecommerce') return listProducts(db, leadId).length;
  if (type === 'courses') return listCourses(db, leadId, { withLessons: false }).length;
  if (type === 'gallery') return listAlbums(db, leadId, { withImages: false }).length;
  if (type === 'directory') return listListings(db, leadId).length;
  if (type === 'faq') return listFaqItems(db, leadId).length;
  if (type === 'testimonials') return listTestimonials(db, leadId).length;
  if (type === 'team') return listTeamMembers(db, leadId).length;
  if (type === 'events') return listEvents(db, leadId).length;
  if (type === 'bookings') {
    // Nav badge: active appointments only (exclude archived).
    ensureTables(db);
    const row = db
      .prepare('SELECT COUNT(*) AS c FROM bookings WHERE lead_id = ? AND archived_at IS NULL')
      .get(Number(leadId));
    return Number(row && row.c) || 0;
  }
  if (type === 'chatbot') {
    try {
      return require('./chatbot').listKnowledge(db, leadId).length;
    } catch (e) {
      console.warn('[siteModules] moduleItemCount chatbot:', e.message || e);
      return 0;
    }
  }
  if (type === 'offers') return listOffers(db, leadId).length;
  if (type === 'qrcode') return listQrCodes(db, leadId).length;
  if (type === 'menu') return listMenuItems(db, leadId).length;
  if (type === 'careers') return listCareersPostings(db, leadId).length;
  if (type === 'video') return listVideoItems(db, leadId).length;
  if (type === 'estimate') {
    // Like bookings (count = appointments), the tab badge counts incoming
    // estimate requests — the work queue — not the priced options.
    ensureTables(db);
    const row = db.prepare('SELECT COUNT(*) AS c FROM estimate_requests WHERE lead_id = ?').get(Number(leadId));
    return Number(row && row.c) || 0;
  }
  if (type === 'socialfeed') {
    // The tab badge counts what the feed will actually show.
    try {
      return socialFeedItems(db, leadId).length;
    } catch (e) {
      console.warn('[siteModules] moduleItemCount socialfeed:', e.message || e);
      return 0;
    }
  }
  if (type === 'googlereviews') {
    // The tab badge counts the reviews that will actually render.
    try {
      return googleReviewsItems(db, leadId).length;
    } catch (e) {
      console.warn('[siteModules] moduleItemCount googlereviews:', e.message || e);
      return 0;
    }
  }
  if (type === 'calltracking') {
    // The tab badge counts calls received on the tracking number.
    ensureTables(db);
    const row = db.prepare('SELECT COUNT(*) AS c FROM call_logs WHERE lead_id = ?').get(Number(leadId));
    return Number(row && row.c) || 0;
  }
  if (type === 'datatables') {
    // The tab badge counts every row the owner has to manage,
    // including visitor submissions still pending approval.
    return countDataTableRows(db, leadId);
  }
  if (type === 'newsletter') {
    // The tab badge counts the subscribers who will actually receive
    // an issue (active only — unsubscribed addresses are never mailed).
    ensureTables(db);
    const row = db
      .prepare("SELECT COUNT(*) AS c FROM newsletter_subscribers WHERE lead_id = ? AND status = 'active'")
      .get(Number(leadId));
    return Number(row && row.c) || 0;
  }
  if (type === 'categories') {
    // The tab badge counts the taxonomy itself (every category of
    // every scope, drafts included — the owner's organizing work).
    try {
      return require('./categories').listCategories(db, leadId).length;
    } catch (e) {
      console.warn('[siteModules] moduleItemCount categories:', e.message || e);
      return 0;
    }
  }
  if (type === 'photocapture') {
    // Like estimate requests, the tab badge counts the moderation
    // queue — submissions still waiting for a decision.
    ensureTables(db);
    const row = db
      .prepare("SELECT COUNT(*) AS c FROM photocapture_submissions WHERE lead_id = ? AND status = 'pending'")
      .get(Number(leadId));
    return Number(row && row.c) || 0;
  }
  if (type === 'checkout') {
    // The tab badge counts the shop's orders — the work queue the
    // Checkout pane exists to show (orders are ecommerce records;
    // the checkout module is their surface).
    ensureTables(db);
    const row = db.prepare('SELECT COUNT(*) AS c FROM ecommerce_orders WHERE lead_id = ?').get(Number(leadId));
    return Number(row && row.c) || 0;
  }
  if (type === 'comments') {
    // Like Photo Capture, the tab badge counts the moderation
    // queue — comments still waiting for a decision.
    ensureTables(db);
    const row = db
      .prepare("SELECT COUNT(*) AS c FROM module_comments WHERE lead_id = ? AND status = 'pending'")
      .get(Number(leadId));
    return Number(row && row.c) || 0;
  }
  if (type === 'pricing') {
    // The tab badge counts the owner's price-list entries (drafts
    // included — the list they are building IS the work here).
    try {
      return require('./pricing').listPricingEntries(db, leadId).length;
    } catch (e) {
      console.warn('[siteModules] moduleItemCount pricing:', e.message || e);
      return 0;
    }
  }
  if (type === 'charts') {
    // The tab badge counts the chart definitions on the site.
    ensureTables(db);
    const row = db.prepare('SELECT COUNT(*) AS c FROM charts WHERE lead_id = ?').get(Number(leadId));
    return Number(row && row.c) || 0;
  }
  if (type === 'members') {
    // The tab badge counts active members.
    ensureTables(db);
    const row = db
      .prepare("SELECT COUNT(*) AS c FROM site_members WHERE lead_id = ? AND status = 'active'")
      .get(Number(leadId));
    return Number(row && row.c) || 0;
  }
  return 0;
}

/* ── Public payload for embed ── */

/**
 * Batch 142 extension — the SITEWIDE checkout presence. When a
 * Checkout module is attached AND active for the lead, every public
 * embed payload for that lead carries `site_checkout` so the nav
 * cart (module-embed.js) can register on ANY page that loads a
 * module payload — the home page, an About page with a newsletter
 * block, a blog index — not only on pages hosting a selling embed.
 * This is the ONE source of "checkout is on for this site": the
 * Batch 128 selling signal (checkout_token / checkout_page on the
 * ecommerce/gallery payloads) is derived from this same resolver,
 * never a parallel check. Detaching or deactivating Checkout makes
 * this return null and the stamp vanishes from every payload at
 * once, exactly as the selling signal already did.
 *
 * The stamp carries exactly two fields, both already public on the
 * selling payloads today: `page` — the checkout page path (a link
 * target rendered in the site nav) — and `token` — the Checkout
 * embed's public_token, which module-embed.js needs because the
 * cart's localStorage key is 'bp-cart-' + that token; without it a
 * non-selling page could render a cart link but could not show the
 * live count/total from the same cart. The public_token is a
 * public embed identifier (it rides in the checkout page's own
 * mount markup and in every selling payload); it grants nothing
 * beyond the public payload reads and the server-re-priced cart
 * checkout those payloads already expose. No keys, secrets or
 * config ride in the stamp.
 */
function siteCheckoutPresence(db, leadId) {
  const coEmbed = getEmbedRow(db, Number(leadId), 'checkout');
  if (!coEmbed || !moduleEmbedActive(coEmbed)) return null;
  return {
    page: `/${String(coEmbed.target_page_slug || MODULE_META.checkout.defaultSlug).replace(/^\/+/, '')}`,
    token: String(coEmbed.public_token || ''),
  };
}

function getPublicModuleByToken(db, token, opts = {}) {
  ensureTables(db);
  const row = db
    .prepare('SELECT * FROM site_module_embeds WHERE public_token = ? AND published = 1')
    .get(String(token || ''));
  if (!row) throw fail('NOT_FOUND', 'Module not found', 404);
  const leadId = row.lead_id;
  const type = row.module_type;
  // Review fix: the public shop payload stops serving when the shop is
  // detached/unpublished (same gate as shop checkout, above). Batch
  // 128: the Checkout payload carries the shop's public token, so a
  // detached checkout stops serving on the same predicate.
  if ((type === 'ecommerce' || type === 'checkout') && !moduleEmbedActive(row)) {
    throw fail('NOT_FOUND', type === 'checkout' ? 'Checkout module not found' : 'Shop module not found', 404);
  }
  // Review fix: no public module payload serves an archived site.
  assertSiteNotArchived(db, leadId);
  assertSiteNotSuspended(db, leadId);
  // Membership: the members module itself is never gated; its payload
  // carries the caller's own member state for the public auth surface.
  // Batch 142 extension: the sitewide checkout presence for this
  // lead (null when Checkout is not attached/active) — stamped on
  // every payload shape this function returns, below.
  const siteCheckout = siteCheckoutPresence(db, leadId);
  if (type === 'members') {
    const membersPayload = publicMembersPayload(db, row, opts);
    if (siteCheckout) membersPayload.site_checkout = siteCheckout;
    return membersPayload;
  }
  // Page gating: content on a gated page stays server-side until a valid
  // member session (or owner preview grant) accompanies the request. The
  // chatbot is a sitewide overlay, not page content — it is never gated.
  if (type !== 'chatbot') {
    const gate = memberGateCheck(db, leadId, opts.pageSlug || row.target_page_slug, opts);
    if (gate.locked) {
      const lockedPayload = lockedModulePayload(row, gate);
      if (siteCheckout) lockedPayload.site_checkout = siteCheckout;
      return lockedPayload;
    }
  }
  const settings = parseEmbedSettings(row);
  let items = [];
  let booking = null;
  let menuCategories = null;
  let estimate = null;
  let socialfeed = null;
  let googlereviews = null;
  let calltracking = null;
  let datatable = null;
  let charts = null;
  let newsletter = null;
  let categoryScopes = null;
  let photocapture = null;
  let qrcode = null;
  let checkout = null;
  let pricing = null;
  let checkoutPage = null;
  let checkoutToken = null;
  let comments = null;
  let total_published = null;
  // Batch 128: when a Checkout module is attached and active, the
  // selling modules' payloads name its page + token — their embeds
  // then offer the shared cart (add-to-cart → the checkout page)
  // instead of any module-local buy path, so a site has ONE
  // checkout, never two competing ones.
  // Batch 142 extension: the selling signal derives from the SAME
  // sitewide presence resolved above — one source of truth for
  // "checkout is on", so the two signals can never disagree.
  const resolveCheckoutLink = () => {
    if (siteCheckout) {
      checkoutPage = siteCheckout.page;
      checkoutToken = siteCheckout.token;
    }
  };
  if (type === 'blog') {
    items = listBlogPosts(db, leadId, { includeDrafts: false }).map((p) => ({
      ...p,
      excerpt: String(p.excerpt || '').trim() || deriveExcerptFromBody(p.body_html, 30),
    }));
    total_published = items.length;
    if (settings.post_limit != null) items = items.slice(0, settings.post_limit);
  } else if (type === 'ecommerce') {
    const stripeReady = require('./shopStripe').isConfiguredForLead(db, leadId);
    // Batch 127: products carry their variant structure + the honest
    // (variant-aware) price label into the storefront payload.
    items = listProducts(db, leadId, { includeDrafts: false }).map((p) =>
      publicProductShape(db, leadId, p, stripeReady)
    );
    resolveCheckoutLink();
  } else if (type === 'checkout') {
    // Batch 128: the Checkout module sells the site's Shop products —
    // its payload is its own config + the resolved shop pointer
    // (publicCheckoutPayload); products themselves are read live
    // through the shop, never duplicated here. items stays empty.
    checkout = publicCheckoutPayload(db, leadId);
    items = [];
  } else if (type === 'courses') items = listCourses(db, leadId, { includeDrafts: false, withLessons: true });
  else if (type === 'gallery') {
    // Batch 128: priced photos carry their sale shape (price_label +
    // for_sale) so the gallery embed can offer them through the
    // checkout; unpriced photos (price_cents 0) stay display-only.
    items = listAlbums(db, leadId, { includeDrafts: false, withImages: true }).map((a) => ({
      ...a,
      images: (a.images || []).map((im) => ({
        ...im,
        price_label: Number(im.price_cents) > 0 ? formatPrice(im.price_cents, 'USD') : null,
        for_sale: Number(im.price_cents) > 0,
      })),
    }));
    resolveCheckoutLink();
  }
  else if (type === 'directory') items = listListings(db, leadId, { includeDrafts: false });
  else if (type === 'faq') items = listFaqItems(db, leadId, { includeDrafts: false });
  else if (type === 'testimonials') items = listTestimonials(db, leadId, { includeDrafts: false });
  else if (type === 'team') items = listTeamMembers(db, leadId, { includeDrafts: false });
  else if (type === 'events') items = listEvents(db, leadId, { includeDrafts: false });
  else if (type === 'bookings') {
    ensureDefaultBookingHours(db, leadId);
    items = listBookingServices(db, leadId, { includeDrafts: false });
    booking = {
      settings: getBookingSettings(db, leadId),
      hours: listBookingHours(db, leadId),
      // Batch 136: the public discount FACT — the templated display
      // object when the owner has the online-booking discount ON,
      // null when OFF/unconfigured (nothing shown, nothing promised).
      discount: getBookingDiscountConfig(db, leadId),
    };
  } else if (type === 'offers') {
    // Published + unexpired only (listOffers filters expired for public lists).
    items = listOffers(db, leadId, { includeDrafts: false });
  } else if (type === 'menu') {
    items = listMenuItems(db, leadId, { includeDrafts: false });
    const usedCategoryIds = new Set(items.map((i) => i.category_id).filter((v) => v != null));
    menuCategories = listMenuCategories(db, leadId, { includeDrafts: false }).filter((c) => usedCategoryIds.has(c.id));
  } else if (type === 'careers') {
    items = listCareersPostings(db, leadId, { includeInactive: false });
  } else if (type === 'video') {
    items = listVideoItems(db, leadId, { includeDrafts: false });
  } else if (type === 'estimate') {
    estimate = publicEstimatePayload(db, leadId);
  } else if (type === 'socialfeed') {
    socialfeed = publicSocialFeedPayload(db, leadId);
    items = socialfeed.items;
  } else if (type === 'googlereviews') {
    // Null whenever there is nothing honest to show (dormant states) —
    // the embed then renders nothing at all.
    googlereviews = publicGoogleReviewsPayload(db, leadId);
    items = googlereviews ? googlereviews.reviews : [];
  } else if (type === 'calltracking') {
    calltracking = publicCallTrackingPayload(db, leadId);
  } else if (type === 'datatables') {
    // Published rows only — pending visitor submissions never serve.
    items = listDataTableRows(db, leadId, { includePending: false }).map((r) => ({
      id: r.id,
      values: r.values,
      sort_order: r.sort_order,
    }));
    datatable = publicDataTablePayload(db, leadId);
  } else if (type === 'newsletter') {
    // Signup-block copy only — subscribers, From settings and send
    // history never leave the server through the public payload.
    newsletter = require('./newsletter').publicConfig(db, leadId);
    items = [];
  } else if (type === 'categories') {
    // Batch 124: the shared taxonomy's public index — published
    // categories of the configured scopes (no config = every scope),
    // each with the count of published items its view will show.
    // Assignments and draft items never leave the server.
    items = require('./categories').publicIndex(db, leadId, settings.scopes);
    categoryScopes = [...new Set(items.map((c) => c.scope))].map((scope) => ({
      scope,
      label: MODULE_META[scope]?.label || scope,
    }));
  } else if (type === 'photocapture') {
    // Capture-form copy plus, only when the owner turned the public
    // grid on, the APPROVED photos. Pending/rejected submissions and
    // submitter contact details never leave the server here.
    photocapture = photoCapturePublicPayload(db, leadId);
    items = photocapture.items;
  } else if (type === 'charts') {
    // Computed chart data only — table-bound charts aggregate the
    // table's PUBLISHED rows server-side (see computeChartData); the
    // public payload never carries raw rows.
    charts = publicChartsPayload(db, leadId);
    items = [];
  } else if (type === 'qrcode') {
    // The one chosen code, resolved at serve time; dormant-empty (no
    // block, no items) when its target has vanished.
    qrcode = publicQrCodePayload(db, leadId, row);
    items = qrcode ? [qrcode] : [];
  } else if (type === 'comments') {
    // Batch 131: the comments block — config plus, in page mode, the
    // page's published thread. Item-mode threads resolve in
    // getPublicModuleItem (the item key only exists there). Pending /
    // rejected comments and author emails never enter the payload.
    comments = require('./comments').publicPayload(db, leadId, row, opts);
    items = [];
  } else if (type === 'pricing') {
    // Batch 139: the price book, resolved at serve time — linked
    // entries show their source's CURRENT name and price; entries
    // whose source vanished are already dropped by the book.
    pricing = require('./pricing').publicPricingPayload(db, leadId);
    items = pricing.entries;
  } else if (type === 'chatbot') {
    try {
      const chat = require('./chatbot');
      const chatPayload = {
        ...chat.getPublicConfigByToken(db, row.public_token),
        items: [],
      };
      if (siteCheckout) chatPayload.site_checkout = siteCheckout;
      return chatPayload;
    } catch (e) {
      throw fail('NOT_FOUND', e.message || 'Chatbot not found', 404);
    }
  }

  const out = {
    embed: publicEmbed(row),
    module_type: type,
    title: row.title || MODULE_META[type]?.label || type,
    settings,
    items,
  };
  // Batch 31 (C5): FAQ module payloads carry FAQPage JSON-LD built from
  // the same published items, so module FAQs are schema-visible; the
  // client embed injects it next to the rendered questions.
  if (type === 'faq' && items.length) {
    try {
      const faqLd = require('../src/seoSchema').buildFaqPageLd(items);
      if (faqLd) out.schema = faqLd;
    } catch {
      /* schema is additive */
    }
  }
  if (total_published != null) {
    out.total_published = total_published;
    out.post_limit = settings.post_limit;
    out.show_excerpt = settings.show_excerpt;
    out.truncated = settings.post_limit != null && total_published > items.length;
  }
  if (booking) out.booking = booking;
  if (menuCategories) out.categories = menuCategories;
  // SMS opt-in (Batch 25): bookings + instant estimate collect a phone
  // number, so their forms offer the consent checkbox from this block.
  if (type === 'bookings' || type === 'estimate') {
    try {
      const smsOptIn = require('./smsOptIn');
      out.sms_optin = smsOptIn.optInBlock(smsOptIn.businessNameForLead(db, leadId));
    } catch {
      out.sms_optin = null;
    }
    // Batch 77: the SMS-policy consent line rides with the opt-in
    // block — both module forms always render a phone field.
    try {
      out.sms_policy = require('./smsPolicy').policyBlock();
    } catch {
      out.sms_policy = null;
    }
  }
  if (estimate) out.estimate = estimate;
  if (socialfeed) out.socialfeed = socialfeed.config;
  if (googlereviews) {
    out.googlereviews = {
      name: googlereviews.name,
      rating: googlereviews.rating,
      total: googlereviews.total,
      google_maps_uri: googlereviews.google_maps_uri,
      config: googlereviews.config,
    };
  }
  if (calltracking) out.calltracking = calltracking;
  if (datatable) out.datatable = datatable;
  if (charts) out.charts = charts;
  if (newsletter) out.newsletter = newsletter;
  if (categoryScopes) out.category_scopes = categoryScopes;
  if (photocapture) out.photocapture = photocapture;
  if (qrcode) out.qrcode = qrcode;
  if (pricing) out.pricing = pricing;
  if (checkout) out.checkout = checkout;
  if (checkoutPage) out.checkout_page = checkoutPage;
  if (checkoutToken) out.checkout_token = checkoutToken;
  if (comments) out.comments = comments;
  // Batch 142 extension: EVERY payload for a checkout site carries
  // the sitewide presence (selling payloads included — identical
  // values to their checkout_token/checkout_page signal), so any
  // module mount on any page can register the nav cart.
  if (siteCheckout) out.site_checkout = siteCheckout;
  return out;
}

function getPublicModuleItem(db, token, slugOrId, opts = {}) {
  const payload = getPublicModuleByToken(db, token, opts);
  if (payload.locked) return payload;
  const type = payload.module_type;
  const leadId = payload.embed.lead_id;
  let item = null;
  let categoryItems = null;
  if (type === 'blog') item = getBlogPost(db, leadId, slugOrId);
  else if (type === 'ecommerce') {
    item = getProduct(db, leadId, slugOrId);
    if (item)
      item = publicProductShape(db, leadId, item, require('./shopStripe').isConfiguredForLead(db, leadId));
  } else if (type === 'courses') item = getCourse(db, leadId, slugOrId);
  else if (type === 'gallery') {
    item = getAlbum(db, leadId, slugOrId);
    if (item) {
      // Batch 128: same sale shaping as the list payload, so a priced
      // photo is buyable from the album detail view too.
      item = {
        ...item,
        images: (item.images || []).map((im) => ({
          ...im,
          price_label: Number(im.price_cents) > 0 ? formatPrice(im.price_cents, 'USD') : null,
          for_sale: Number(im.price_cents) > 0,
        })),
      };
    }
  }
  else if (type === 'directory') item = getListing(db, leadId, slugOrId);
  else if (type === 'faq') item = getFaqItem(db, leadId, slugOrId);
  else if (type === 'testimonials') item = getTestimonial(db, leadId, slugOrId);
  else if (type === 'team') item = getTeamMember(db, leadId, slugOrId);
  else if (type === 'events') {
    item = getEvent(db, leadId, slugOrId);
    if (item) {
      // Batch 122 — the event's shared gallery (moduleShare ref,
      // role 'album') resolved at payload time: published album +
      // photos ride along for the detail view; anything missing or
      // unpublished resolves to nothing (dormant-empty discipline).
      try {
        const sharedGallery = require('./moduleShare').resolveEventGallery(db, leadId, item);
        if (sharedGallery) item = { ...item, shared_gallery: sharedGallery };
      } catch {
        /* the shared layer can never break an event page */
      }
    }
  }
  else if (type === 'bookings') item = getBookingService(db, leadId, slugOrId);
  else if (type === 'categories') {
    // Batch 124: the "item" is one published category; its assigned
    // items ride along as uniform shared-layer cards whose link_url
    // points at each item's own page. Drafts never resolve.
    const cats = require('./categories');
    item = cats.getPublicCategory(db, leadId, slugOrId, payload.settings && payload.settings.scopes);
    if (item) categoryItems = cats.publicCategoryItems(db, leadId, item);
  }
  else if (type === 'offers') {
    item = getOffer(db, leadId, slugOrId);
    if (item && item.expired) item = null;
  } else if (type === 'comments') {
    // Batch 131: the "item" is the comment thread for the item the
    // page is showing, resolved under the embed's configured target
    // type through the shared layer. A key that doesn't resolve is
    // NOT an error — the block stays dormant (the Batch 130 rule: a
    // neighboring module never paints an error for an item that
    // isn't its own), so the base payload returns untouched.
    const ctx = require('./comments').publicItemContext(db, leadId, payload.embed, slugOrId);
    if (!ctx) return payload;
    return { ...payload, item: { comments_target: ctx.target }, comments: ctx };
  } else if (type === 'menu') item = getMenuItem(db, leadId, slugOrId);
  else if (type === 'careers') {
    item = getCareersPosting(db, leadId, slugOrId);
    if (item && !item.active) item = null;
  } else if (type === 'video') item = getVideoItem(db, leadId, slugOrId);
  if (!item || (item.status && item.status !== 'published' && item.status !== 'active')) {
    throw fail('NOT_FOUND', 'Item not found', 404);
  }
  const out = { ...payload, item };
  if (categoryItems) out.category_items = categoryItems;
  // Batch 131 finisher (Batch 133 detail wiring): when the site has
  // an active Comments module, the item's comment thread rides the
  // item payload as detail_comments — the universal detail page
  // renders it under the article through the 133 mount point, keyed
  // by this item's own (type, key) through the shared layer. No
  // comments module (or comments off / unresolvable target) = the
  // field simply stays absent; in-app item views ignore it.
  if (type !== 'comments') {
    try {
      const cRow = getEmbedRow(db, leadId, 'comments');
      if (cRow && moduleEmbedActive(cRow)) {
        const ctx = require('./comments').publicDetailContext(db, leadId, type, slugOrId);
        if (ctx) out.detail_comments = { ...ctx, token: cRow.public_token };
      }
    } catch {
      /* the comments layer can never break an item page */
    }
  }
  return out;
}

function getPublicBookingSlots(db, token, { date, serviceId, serviceSlug } = {}, opts = {}) {
  ensureTables(db);
  const row = db
    .prepare('SELECT * FROM site_module_embeds WHERE public_token = ? AND published = 1')
    .get(String(token || ''));
  if (!row || row.module_type !== 'bookings') {
    throw fail('NOT_FOUND', 'Bookings module not found', 404);
  }
  assertSiteNotArchived(db, row.lead_id);
  assertSiteNotSuspended(db, row.lead_id);
  assertMemberAccessForEmbed(db, row, opts);
  return {
    embed: publicEmbed(row),
    module_type: 'bookings',
    title: row.title || MODULE_META.bookings.label,
    ...listAvailableSlots(db, row.lead_id, { date, serviceId, serviceSlug }),
  };
}

async function createPublicBookingByToken(db, token, data = {}, opts = {}) {
  ensureTables(db);
  const row = db
    .prepare('SELECT * FROM site_module_embeds WHERE public_token = ? AND published = 1')
    .get(String(token || ''));
  if (!row || row.module_type !== 'bookings') {
    throw fail('NOT_FOUND', 'Bookings module not found', 404);
  }
  assertSiteNotArchived(db, row.lead_id);
  assertSiteNotSuspended(db, row.lead_id);
  assertMemberAccessForEmbed(db, row, opts);
  // Batch 129 — pay-at-booking. A PRICED service sells through the
  // shared checkout engine when the business has payments connected
  // through the unified config. Free services, and priced services
  // on sites without payments connected, keep today's flow
  // byte-for-byte.
  // Batch 145 (external review F08): whether payment is required is
  // decided SERVER-SIDE ONLY — the old condition also required a
  // visitor-supplied return URL, so omitting that one field routed
  // a priced, configured booking down the unpaid path (confirmed
  // for free under auto_confirm). The return URL is now DERIVED
  // from the site's own published origin + the embed's page; the
  // client-supplied value is only a last-resort fallback for a site
  // with no recorded origin, and a priced+configured booking with
  // NO derivable URL fails closed instead of falling through free.
  const servicePreview = getBookingService(
    db,
    row.lead_id,
    data.service_id || data.serviceId || data.service
  );
  const priced = !!(servicePreview && Number(servicePreview.price_cents) > 0);
  // Batch 136 × 129: the amount actually charged is the stamp's NET.
  // A priced service whose online-booking discount takes the net to
  // $0 follows the free-booking path — no hold, no checkout session —
  // exactly like a free service. The stamp is recomputed identically
  // inside createPublicBooking for the appointment row itself.
  const stampPreview = servicePreview
    ? bookingPriceStamp(
        db,
        row.lead_id,
        Number(servicePreview.price_cents) || 0,
        servicePreview.currency || 'USD'
      )
    : null;
  // Derived return URL: the site's own published origin (custom
  // domain or preview URL), plus the page the embed lives on.
  let returnUrl = '';
  const siteOrigin = siteBaseUrl(db, row.lead_id);
  if (siteOrigin) {
    const slug = String(row.target_page_slug || '')
      .trim()
      .replace(/^\/+/, '');
    returnUrl = slug && slug !== 'index' && slug !== 'home' ? `${siteOrigin}/${slug}` : `${siteOrigin}/`;
  }
  if (!returnUrl) {
    returnUrl = String(data.return_url || data.returnUrl || '').trim();
  }
  // The payments-config check short-circuits LAST: a free or
  // zero-net booking never touches the payments layer at all.
  const payNow =
    priced &&
    !!stampPreview &&
    stampPreview.net_cents > 0 &&
    require('./shopStripe').isConfiguredForLead(db, row.lead_id);
  if (payNow && !returnUrl) {
    throw fail(
      'BOOKING_RETURN_URL_UNAVAILABLE',
      'Online payment is required for this booking, but no return page could be determined for this site. Please contact the business to book.',
      500
    );
  }
  const appointment = createPublicBooking(db, row.lead_id, data, { paymentHold: payNow });
  const result = {
    embed: publicEmbed(row),
    appointment: {
      id: appointment.id,
      service_id: appointment.service_id,
      service_name: appointment.service_name,
      starts_at: appointment.starts_at,
      ends_at: appointment.ends_at,
      status: appointment.status,
      customer_name: appointment.customer_name,
      // Batch 136: the booking's stamped price (gross/discount/net).
      price_gross_cents: Number(appointment.price_gross_cents) || 0,
      discount_amount_cents: Number(appointment.discount_amount_cents) || 0,
      price_net_cents: Number(appointment.price_net_cents) || 0,
    },
    discount: bookingDiscountStampFromAppointment(appointment),
    message:
      appointment.status === 'confirmed'
        ? 'Your appointment is confirmed.'
        : 'Request received — we will confirm your appointment soon.',
  };
  if (payNow) {
    const grossLine = lineForBookingService(servicePreview, appointment);
    // Batch 136 × 129 INTEGRATION POINT: the shared engine charges
    // the DISCOUNTED line (unit + total at NET, the full stamp in the
    // line's source_meta), and the appointment's stamp rides into
    // checkoutShopLines as opts.bookingDiscount — the booking surface
    // is the ONLY caller that ever sets it; cart and membership never
    // do, so their orders are never stamped.
    const stamp = {
      gross_cents: Number(appointment.price_gross_cents) || 0,
      discount_amount_cents: Number(appointment.discount_amount_cents) || 0,
      net_cents: Number(appointment.price_net_cents) || 0,
      currency: String(servicePreview.currency || 'USD').toUpperCase(),
      discount_kind: String(appointment.discount_kind || ''),
      discount_value: Number(appointment.discount_value) || 0,
      discount_label: String(appointment.discount_label || ''),
    };
    const line = applyBookingDiscountToLine(grossLine, stamp);
    let checkout;
    try {
      checkout = await checkoutShopLines(db, row, [line], line.currency, returnUrl, {
        bookingDiscount: stamp,
      });
    } catch (e) {
      // The hold must not outlive a failed checkout start: release
      // the slot immediately and surface the checkout error.
      db.prepare(
        "UPDATE bookings SET status = 'cancelled', payment_state = 'released', updated_at = datetime('now') WHERE id = ? AND lead_id = ? AND payment_state = 'hold'"
      ).run(Number(appointment.id), Number(row.lead_id));
      throw e;
    }
    db.prepare(
      "UPDATE bookings SET payment_order_id = ?, updated_at = datetime('now') WHERE id = ? AND lead_id = ?"
    ).run(Number(checkout.orderId), Number(appointment.id), Number(row.lead_id));
    result.payment = {
      required: true,
      url: checkout.url,
      order_id: checkout.orderId,
      expires_at: appointment.payment_expires_at || null,
      // Batch 136: the stamped figures ride the payment block — the
      // gross, the discount actually applied, and the net charged.
      gross_cents: stamp.gross_cents,
      discount_amount_cents: stamp.discount_amount_cents,
      net_cents: stamp.net_cents,
    };
    result.message = 'Almost done — complete your payment to confirm your appointment.';
  }
  return result;
}

/**
 * Portal summary for all modules.
 * @param {any} db
 * @param {any} leadId
 * @param {{ appUrl?: string, siteModules?: boolean }} [opts]
 */
function portalSummary(db, leadId, { appUrl, siteModules = false } = {}) {
  ensureTables(db);
  const pages = listSitePages(db, leadId);
  const embeds = listEmbeds(db, leadId).map((e) => publicEmbed(e, appUrl));
  return {
    siteModules: !!siteModules,
    modules: MODULE_TYPES.map((type) => {
      const emb = embeds.find((e) => e.module_type === type) || null;
      return {
        type,
        label: MODULE_META[type].label,
        count: moduleItemCount(db, leadId, type),
        // Batch 66: what a per-record module delete would purge —
        // drives the portal delete confirm's real counts.
        purge: moduleContentCounts(db, leadId, type),
        embed: emb,
      };
    }),
    pages,
  };
}

module.exports = {
  MODULE_TYPES,
  MODULE_META,
  BOOKING_STATUSES,
  ensureTables,
  parseWorkspaceFromToken,
  makePublicToken,
  listSitePages,
  listEmbeds,
  getEmbedRow,
  ensureEmbed,
  publicEmbed,
  attachModule,
  detachModule,
  deleteModule,
  moduleContentCounts,
  parseEmbedSettings,
  writeEmbedSettings,
  maybeProvisionBookingsCompanionForm,
  syncSiteModuleEmbeds,
  moduleNavContext,
  syncPublishedModules,
  rebuildFreeformPrimaryNav,
  rebuildFreeformFooterLinks,
  shellHtmlFromPages,
  fillShellMain,
  PAGE_CHROME_CSS,
  ensurePageChromeStyle,
  defaultClientPageInner,
  ensureClientPageChrome,
  contentSectionHtml,
  withMainClass,
  embedBlockHtml,
  moduleScriptTag,
  ensureModuleEmbedScript,
  injectHtmlEmbed,
  htmlHasModuleToken,
  stripInactiveModuleEmbedsFromHtml,
  pagesHaveModuleToken,
  pageServesModulePurpose,
  describeWouldInject,
  stripManagedModuleEmbedsFromHtml,
  deriveExcerptFromBody,
  parseEmbedSettings,
  writeEmbedSettings,
  listBlogPosts,
  getBlogPost,
  createBlogPost,
  updateBlogPost,
  deleteBlogPost,
  listProducts,
  getProduct,
  createProduct,
  updateProduct,
  deleteProduct,
  listProductOptions,
  listProductVariants,
  getProductVariant,
  setProductOptions,
  productVariantData,
  withProductVariants,
  productDisplayPriceCents,
  productPriceLabel,
  publicProductShape,
  formatPrice,
  listCourses,
  getCourse,
  createCourse,
  updateCourse,
  deleteCourse,
  addLesson,
  deleteLesson,
  listAlbums,
  getAlbum,
  createAlbum,
  updateAlbum,
  deleteAlbum,
  addGalleryImage,
  deleteGalleryImage,
  listListings,
  getListing,
  createListing,
  updateListing,
  deleteListing,
  listFaqItems,
  getFaqItem,
  createFaqItem,
  updateFaqItem,
  deleteFaqItem,
  listTestimonials,
  getTestimonial,
  createTestimonial,
  updateTestimonial,
  deleteTestimonial,
  listTeamMembers,
  getTeamMember,
  createTeamMember,
  updateTeamMember,
  deleteTeamMember,
  listEvents,
  getEvent,
  createEvent,
  updateEvent,
  deleteEvent,
  listOffers,
  getOffer,
  createOffer,
  updateOffer,
  deleteOffer,
  isOfferExpired,
  listQrCodes,
  getQrCode,
  createQrCode,
  updateQrCode,
  deleteQrCode,
  listQrCodeTargets,
  buildQrPayload,
  resolveQrCode,
  renderQrCodeImage,
  qrCodePreviewDataUrl,
  getQrCodeDisplay,
  updateQrCodeDisplay,
  publicQrCodePayload,
  resolvePublicQrCode,
  listMenuCategories,
  getMenuCategory,
  createMenuCategory,
  updateMenuCategory,
  deleteMenuCategory,
  ensureMenuCategory,
  listMenuItems,
  getMenuItem,
  createMenuItem,
  updateMenuItem,
  deleteMenuItem,
  listCareersPostings,
  getCareersPosting,
  createCareersPosting,
  updateCareersPosting,
  deleteCareersPosting,
  CAREERS_EMPLOYMENT_TYPES,
  CAREERS_APPLY_MODES,
  listVideoItems,
  getVideoItem,
  createVideoItem,
  updateVideoItem,
  deleteVideoItem,
  parseVideoUrl,
  ESTIMATE_DISPLAY_MODES,
  ESTIMATE_INPUT_TYPES,
  ESTIMATE_REQUEST_STATUSES,
  ESTIMATE_DEFAULT_DISCLAIMER,
  getEstimateConfig,
  getOffersLayout,
  updateOffersLayout,
  getCategoriesScopes,
  updateCategoriesScopes,
  normalizeCategoryScopes,
  normalizeOffersLayout,
  updateEstimateConfig,
  listEstimateOptions,
  getEstimateOption,
  createEstimateOption,
  updateEstimateOption,
  deleteEstimateOption,
  computeEstimate,
  estimateRangeBounds,
  publicEstimatePayload,
  listEstimateRequests,
  getEstimateRequest,
  updateEstimateRequestStatus,
  deleteEstimateRequest,
  createEstimateRequest,
  createPublicEstimateRequestByToken,
  PHOTOCAPTURE_STATUSES,
  getPhotoCaptureConfig,
  updatePhotoCaptureConfig,
  validatePhotoSubmissionFields,
  createPhotoSubmission,
  getPhotoSubmission,
  listPhotoSubmissions,
  countPhotoSubmissions,
  updatePhotoSubmissionStatus,
  deletePhotoSubmission,
  addPhotoSubmissionToGallery,
  photoCapturePublicPayload,
  createPublicPhotoSubmissionByToken,
  SOCIALFEED_NETWORKS,
  SOCIALFEED_LAYOUTS,
  getSocialFeedConfig,
  updateSocialFeedConfig,
  localSocialFeedItems,
  readSocialFeedCache,
  socialFeedCacheStale,
  refreshSocialFeedRemote,
  socialFeedItems,
  socialFeedPreview,
  publicSocialFeedPayload,
  GOOGLE_REVIEWS_CACHE_TTL_MS,
  assertGooglePlaceId,
  readGoogleReviewsConfig,
  getGoogleReviewsConfig,
  updateGoogleReviewsConfig,
  shapeGoogleReview,
  parseGooglePlaceDetails,
  readGoogleReviewsCache,
  storeGoogleReviewsCache,
  googleReviewsCacheStale,
  resolveGooglePlacesApiKey,
  googlePlacesConfigured,
  fetchGooglePlaceDetails,
  refreshGoogleReviews,
  googleReviewsItems,
  publicGoogleReviewsPayload,
  googleReviewsPreview,
  DATATABLE_COLUMN_TYPES,
  DATATABLE_TEMPLATES,
  DATATABLE_SUBMIT_MODES,
  DATATABLE_ROLES,
  DATATABLE_MAX_COLUMNS,
  DATATABLE_MAX_ROWS,
  normalizeDataTableColumns,
  getDataTableConfig,
  updateDataTableConfig,
  listDataTableRows,
  getDataTableRow,
  createDataTableRow,
  addDataTableRows,
  updateDataTableRow,
  deleteDataTableRow,
  clearDataTableRows,
  countDataTableRows,
  getDataTable,
  publicDataTablePayload,
  createPublicDataTableSubmission,
  createPublicDataTableSubmissionByToken,
  CHART_TYPES,
  CHART_SOURCES,
  CHART_AGGREGATIONS,
  CHART_MAX_CHARTS,
  CHART_MAX_POINTS,
  CHART_MAX_SERIES,
  CHART_DEFAULT_COLORS,
  normalizeChartData,
  chartDataToText,
  listCharts,
  getChart,
  countCharts,
  createChart,
  updateChart,
  deleteChart,
  clearCharts,
  computeChartData,
  publicChartsPayload,
  getChartsModule,
  normalizeE164,
  formatPhoneDisplay,
  getCallTrackingConfig,
  updateCallTrackingConfig,
  publicCallTrackingPayload,
  getRotationNumbers,
  setCallTrackingRotation,
  listTwilioNumberPool,
  addTwilioNumberToPool,
  removeTwilioNumberFromPool,
  findNumberClaim,
  claimedNumbersFor,
  poolNumberRow,
  ROTATION_MAX_NUMBERS,
  buildCallTrackingVoiceTwiml,
  buildVoicemailTwiml,
  VOICEMAIL_MAX_SECONDS,
  getCallLogBySid,
  logCallInitiated,
  upsertCallStatus,
  storeCallRecording,
  setCallTranscript,
  isTerminalCallStatus,
  listCalls,
  listAllCalls,
  deleteCallLog,
  createOutboundCall,
  claimOutboundDial,
  setOutboundProviderSid,
  updateOutboundCallStatus,
  listOutboundCalls,
  stampTranscriptOriginal,
  editCallTranscript,
  addLeadContactNote,
  getLeadContactNote,
  listLeadContactNotes,
  updateLeadContactNote,
  deleteLeadContactNote,
  countBlogPosts,
  CALL_ALLOWANCE_BY_PLAN,
  CALL_COUNT_MIN_SECONDS,
  CALL_OVERAGE_BLOCK,
  callAllowanceForPlan,
  currentCallMonth,
  assertCallTrackingActivation,
  countCountedCalls,
  getCallBillingState,
  setCallBillingState,
  callBillingSummary,
  markTranscriptionBilled,
  claimCallNotify,
  setCallNotifyStatus,
  claimVoicemailNotify,
  setVoicemailNotifyStatus,
  MEMBER_STATUSES,
  MEMBER_GATE_MODES,
  MEMBER_SIGNUP_MODES,
  MEMBER_WALL_DEFAULT,
  getMembersConfig,
  readMembersConfig,
  updateMembersConfig,
  pageIsGated,
  memberGateCheck,
  signupMember,
  loginMember,
  logoutMember,
  getSessionMember,
  resolveMemberAccess,
  requestMemberReset,
  buildMemberResetMail,
  resetMemberPassword,
  listSiteMembers,
  countSiteMembers,
  setSiteMemberStatus,
  deleteSiteMember,
  publicMemberSignup,
  publicMemberLogin,
  publicMemberLogout,
  publicMemberForgot,
  publicMemberReset,
  publicMembersPayload,
  getMemberPageBody,
  gateExportPages,
  memberPreviewGrantFor,
  createMemberPreviewGrant,
  verifyMemberPreviewGrant,
  membersEmbedForLead,
  membersPageSlug,
  membersEmbedByToken,
  MEMBER_ACCESS_LEVELS,
  MEMBER_TIER_INTERVALS,
  MEMBER_ENTITLED_STATUSES,
  memberAccessInfo,
  accessSatisfies,
  gateWallFields,
  getMembershipStripeKeyRow,
  getPaymentConfigRow,
  releaseExpiredBookingHolds,
  BOOKING_PAYMENT_HOLD_MINUTES,
  applyTenantStripeEvent,
  saveMembershipStripeKeys,
  clearMembershipStripeKeys,
  membershipStripeStatus,
  getShopStripeKeyRow,
  saveShopStripeKeys,
  clearShopStripeKeys,
  shopStripeStatus,
  listShopPaymentSites,
  shapeMembershipTier,
  listMembershipTiers,
  getMembershipTier,
  validateMembershipTierInput,
  insertMembershipTier,
  updateMembershipTierRow,
  deleteMembershipTier,
  shapeMemberSubscription,
  getMemberSubscriptionByStripeId,
  listMemberSubscriptions,
  findLeadByStripeSubscription,
  findLeadByStripeCustomer,
  upsertMemberSubscription,
  createFreeTierMembership,
  markSubscriptionCanceling,
  cancelLocalSubscription,
  grantMemberComp,
  revokeMemberComp,
  membershipRevenueSummary,
  applyMembershipStripeEvent,
  createMembershipCheckoutByToken,
  joinFreeTierByToken,
  adminMembershipsLocal,
  MODULE_SCRIPT_VER,
  getBookingSettings,
  updateBookingSettings,
  getBookingDiscountConfig,
  bookingDiscountDisplay,
  bookingPriceStamp,
  publicDiscountStamp,
  bookingDiscountStampFromAppointment,
  applyBookingDiscountToLine,
  listBookingHours,
  ensureDefaultBookingHours,
  setBookingHours,
  listBookingBlocks,
  createBookingBlock,
  deleteBookingBlock,
  listBookingServices,
  getBookingService,
  createBookingService,
  updateBookingService,
  deleteBookingService,
  listUpcomingAppointments,
  listAppointments,
  moduleItemCount,
  getAppointment,
  updateAppointmentStatus,
  setAppointmentArchived,
  deleteAppointment,
  listAvailableSlots,
  createPublicBooking,
  getPublicModuleByToken,
  getPublicModuleItem,
  siteCheckoutPresence,
  getPublicBookingSlots,
  createPublicBookingByToken,
  createShopCheckoutByToken,
  createCartCheckoutByToken,
  buildSellableLines,
  insertShopOrderWithLines,
  listShopOrders,
  listShopOrderItems,
  listShopOrdersWithItems,
  shopOrderWithItems,
  getCheckoutConfig,
  updateCheckoutConfig,
  publicCheckoutPayload,
  getEmbedRowByToken,
  getSellableGalleryImage,
  applyShopStripeEvent,
  getShopOrderBySession,
  portalSummary,
  embedBlockHtml,
  DETAIL_TYPES,
  detailExportContext,
};
