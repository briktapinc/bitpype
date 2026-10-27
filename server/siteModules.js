'use strict';

/**
 * Site content modules (Blog, Ecommerce, Courses, Gallery, Directory,
 * FAQ, Testimonials, Team, Events, Bookings, Chatbot, Offers, Menu,
 * Careers, Video, Instant Estimate, Social Feed, Call Tracking).
 * Workspace SQLite tables per lead; in-page JS embeds (legacy iframe URL kept);
 * portal + MCP CRUD.
 * Gated by plan entitlement `siteModules` (Standard + Premium).
 *
 * Bookings is interactive: weekly hours + services drive a public slot picker
 * (calendar / time management), unlike the appointment *request* form which
 * only collects preferred date/time text.
 */

const crypto = require('crypto');

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
];
const MANAGED_ATTR = 'data-bitpype-module';
const EMBED_TYPE_ATTR = 'data-bitpype-module-type';
const EMBED_TOKEN_ATTR = 'data-bitpype-module-token';
const NAV_ATTR = 'data-bitpype-module-nav';
const SCRIPT_ATTR = 'data-bitpype-module-script';
const MODULE_SCRIPT_VER = 'mod17';

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
};

const BOOKING_STATUSES = ['pending', 'confirmed', 'cancelled', 'completed'];
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
  return String(process.env.APP_URL || '').replace(/\/$/, '');
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
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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

    CREATE TABLE IF NOT EXISTS booking_settings (
      lead_id INTEGER PRIMARY KEY,
      timezone TEXT NOT NULL DEFAULT 'America/New_York',
      slot_interval_minutes INTEGER NOT NULL DEFAULT 30,
      min_notice_hours INTEGER NOT NULL DEFAULT 2,
      max_days_ahead INTEGER NOT NULL DEFAULT 60,
      auto_confirm INTEGER NOT NULL DEFAULT 0,
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
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_blog_posts_lead ON blog_posts(lead_id);
    CREATE INDEX IF NOT EXISTS idx_ecom_products_lead ON ecommerce_products(lead_id);
    CREATE INDEX IF NOT EXISTS idx_ecom_orders_lead ON ecommerce_orders(lead_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ecom_orders_session ON ecommerce_orders(stripe_session_id) WHERE stripe_session_id <> '';
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
 * Relative multipage filename. Must match src/websiteEngine.js pageFileName:
 * home/index → index.html, everything else → {slug}.html.
 */
function pageFileName(slug) {
  const s = String(slug || '/')
    .replace(/^\//, '')
    .replace(/\/$/, '');
  if (!s || s === 'home' || s === 'index') return 'index.html';
  return s.replace(/[^a-z0-9-_]/gi, '_') + '.html';
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

function ensureModuleEmbedScript(html, appUrl) {
  const tag = moduleScriptTag(appUrl);
  if (!tag) return String(html || '');
  let s = String(html || '');
  s = s.replace(new RegExp(`<script\\b[^>]*\\b${SCRIPT_ATTR}\\b[^>]*>\\s*<\\/script>`, 'gi'), '');
  s = s.replace(/<script\b[^>]*\/js\/module-embed\.js[^>]*>\s*<\/script>/gi, '');
  if (/<\/body>/i.test(s)) return s.replace(/<\/body>/i, `${tag}\n</body>`);
  return `${s}\n${tag}`;
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

function injectContentSectionIntoHtml(pageHtml, sectionHtml, afterIndex) {
  let html = ensurePageChromeStyle(String(pageHtml || ''));
  const block = String(sectionHtml || contentSectionHtml());
  // Dedupe by section type / heading label — author content wins.
  const typeHint =
    (block.match(/\bdata-ws-section-type\s*=\s*["']([^"']+)["']/i) || [])[1] ||
    (block.match(/\bclass\s*=\s*["'][^"']*\b(cta|footer|contact|hero|faq)\b/i) || [])[1] ||
    '';
  const labelHint = anchorTextLabel((block.match(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/i) || [])[1] || '');
  if (
    typeHint &&
    new RegExp(`data-ws-section-type\\s*=\\s*["']${typeHint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`, 'i').test(
      html
    )
  ) {
    return html;
  }
  if (
    labelHint &&
    new RegExp(`>(?:\\s*)${labelHint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s*)<`, 'i').test(html)
  ) {
    return html;
  }
  if (!html.trim()) {
    return `<main class="bp-mod-main page module-page">${block}</main>`;
  }
  if (!/<main\b/i.test(html)) {
    return `${html}\n<main class="bp-mod-main page module-page">${block}</main>`;
  }
  return html.replace(/<main\b[^>]*>[\s\S]*?<\/main>/i, (mainBlock) => {
    const openMatch = mainBlock.match(/^<main\b[^>]*>/i);
    const open = withMainClass(openMatch ? openMatch[0] : '<main>', 'bp-mod-main');
    const openLen = openMatch ? openMatch[0].length : 6;
    const closeStart = mainBlock.lastIndexOf('</');
    const inner = closeStart > 0 ? mainBlock.slice(openLen, closeStart) : '';
    // Keep leading h1 (page title) out of the section list.
    const titleMatch = inner.match(/^\s*<h1\b[^>]*>[\s\S]*?<\/h1>/i);
    let rest = inner;
    let titleHtml = '';
    if (titleMatch) {
      titleHtml = titleMatch[0];
      rest = inner.slice(titleMatch[0].length);
    }
    const chunks = [];
    const chunkRe = /<section\b[\s\S]*?<\/section>|<div\b[^>]*(?:bitpype-module|bp-mod)[^>]*>[\s\S]*?<\/div>/gi;
    let cm;
    let cursor = 0;
    while ((cm = chunkRe.exec(rest))) {
      if (cm.index > cursor) {
        const gap = rest.slice(cursor, cm.index);
        if (gap.trim()) chunks.push(gap);
      }
      chunks.push(cm[0]);
      cursor = cm.index + cm[0].length;
    }
    if (cursor < rest.length) {
      const tail = rest.slice(cursor);
      if (tail.trim()) chunks.push(tail);
    }
    const at = Math.max(-1, Math.min(Number(afterIndex), chunks.length - 1));
    const out = [];
    if (!chunks.length || at < 0) {
      if (at < 0) out.push(block);
      out.push(...chunks);
      if (at >= 0 && !chunks.length) out.push(block);
    } else {
      chunks.forEach((c, i) => {
        out.push(c);
        if (i === at) out.push(block);
      });
    }
    return `${open}${titleHtml}${out.join('')}</main>`;
  });
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
  const starts = pageAnchors.map((a) => a.start).concat(managedRanges.map((r) => r.start));
  const ends = pageAnchors.map((a) => a.end).concat(managedRanges.map((r) => r.end));
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
  const activeTokens = new Set(embeds.map((e) => String(e.public_token || '').trim()).filter(Boolean));
  const reveal = new Set((Array.isArray(revealSlugs) ? revealSlugs : []).map((s) => normalizeSlug(s)).filter(Boolean));

  // Pass 1: strip only inactive embeds; leave placed widgets where they are.
  for (const page of pages) {
    if (pageUsesSections(page)) {
      page.sections = page.sections
        .filter((sec) => {
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

  // Section-type nav is rebuilt from the pages array at render time (one link per
  // page). Inserting another <a> there would duplicate it. Freeform HTML bakes the
  // menu into each page — module pages participate via pages[] + syncFreeformNavOrder.
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

/* ── Blog ── */

function listBlogPosts(db, leadId, { includeDrafts = true } = {}) {
  ensureTables(db);
  let sql = 'SELECT * FROM blog_posts WHERE lead_id = ?';
  if (!includeDrafts) sql += " AND status = 'published'";
  sql += ' ORDER BY COALESCE(published_at, created_at) DESC, id DESC';
  return db.prepare(sql).all(Number(leadId));
}

function getBlogPost(db, leadId, idOrSlug) {
  ensureTables(db);
  const lid = Number(leadId);
  if (/^\d+$/.test(String(idOrSlug))) {
    return db.prepare('SELECT * FROM blog_posts WHERE lead_id = ? AND id = ?').get(lid, Number(idOrSlug));
  }
  return db.prepare('SELECT * FROM blog_posts WHERE lead_id = ? AND slug = ?').get(lid, slugify(idOrSlug));
}

function createBlogPost(db, leadId, data = {}) {
  ensureTables(db);
  const title = String(data.title || '').trim();
  if (!title) throw fail('VALIDATION', 'title is required');
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
  return getBlogPost(db, leadId, row.id);
}

function deleteBlogPost(db, leadId, id) {
  ensureTables(db);
  const row = getBlogPost(db, leadId, id);
  if (!row) throw fail('NOT_FOUND', 'Blog post not found', 404);
  db.prepare('DELETE FROM blog_posts WHERE id = ? AND lead_id = ?').run(row.id, Number(leadId));
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
    return getProduct(db, leadId, info.lastInsertRowid);
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
  return getProduct(db, leadId, row.id);
}

function deleteProduct(db, leadId, id) {
  ensureTables(db);
  const row = getProduct(db, leadId, id);
  if (!row) throw fail('NOT_FOUND', 'Product not found', 404);
  db.prepare('DELETE FROM ecommerce_products WHERE id = ? AND lead_id = ?').run(row.id, Number(leadId));
  return { deleted: true, id: row.id };
}

/* ── Shop orders + Stripe checkout ── */

function insertShopOrder(db, leadId, product, opts = {}) {
  ensureTables(db);
  const keySource = opts && opts.keySource === 'lead' ? 'lead' : opts && opts.keySource === 'workspace' ? 'workspace' : '';
  const info = db
    .prepare(
      `INSERT INTO ecommerce_orders (lead_id, product_id, product_name, amount_cents, currency, status, stripe_key_source)
     VALUES (?, ?, ?, ?, ?, 'pending', ?)`
    )
    .run(
      Number(leadId),
      Number(product.id),
      String(product.name || ''),
      Number(product.price_cents) || 0,
      String(product.currency || 'USD'),
      keySource
    );
  return db.prepare('SELECT * FROM ecommerce_orders WHERE id = ?').get(info.lastInsertRowid);
}

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

function getShopOrderBySession(db, sessionId) {
  ensureTables(db);
  return db.prepare('SELECT * FROM ecommerce_orders WHERE stripe_session_id = ?').get(String(sessionId || '')) || null;
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
function applyShopStripeEvent(db, event) {
  ensureTables(db);
  const type = String((event && event.type) || '');
  const obj = (event && event.data && event.data.object) || {};
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
  if (order.status === 'paid') return { matched: true, orderId: order.id, status: 'paid' };
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
    updateShopOrder(db, order.id, {
      status: 'paid',
      stripe_payment_intent: String(obj.payment_intent || order.stripe_payment_intent || ''),
      customer_email: String(
        (obj.customer_details && obj.customer_details.email) || obj.customer_email || order.customer_email || ''
      ),
    });
    return { matched: true, orderId: order.id, status: 'paid' };
  }
  if (type === 'checkout.session.expired' || type === 'checkout.session.async_payment_failed') {
    updateShopOrder(db, order.id, { status: type.endsWith('expired') ? 'expired' : 'failed' });
    return { matched: true, orderId: order.id, status: type.endsWith('expired') ? 'expired' : 'failed' };
  }
  if (type === 'payment_intent.payment_failed') {
    updateShopOrder(db, order.id, { status: 'failed' });
    return { matched: true, orderId: order.id, status: 'failed' };
  }
  return { matched: true, orderId: order.id, status: order.status };
}

/**
 * Create a Stripe Checkout Session for a shop product via the public
 * module token. Prices are always read from the product row server-side.
 * A product with a manual checkout_url keeps the legacy external-link
 * behavior and never touches Stripe.
 */
async function createShopCheckoutByToken(db, token, { productId, returnUrl } = {}, opts = {}) {
  ensureTables(db);
  const row = db.prepare('SELECT * FROM site_module_embeds WHERE public_token = ?').get(String(token || ''));
  if (!row || row.module_type !== 'ecommerce') {
    throw fail('NOT_FOUND', 'Shop module not found', 404);
  }
  assertMemberAccessForEmbed(db, row, opts);
  const product = getProduct(db, row.lead_id, productId);
  if (!product || product.status !== 'published') {
    throw fail('NOT_FOUND', 'Product not found', 404);
  }
  if (product.checkout_url) {
    return { mode: 'external', url: product.checkout_url };
  }
  const shopStripe = require('./shopStripe');
  // Per-lead keys win; the workspace keys are the fallback (Batch 19).
  // Resolution happens BEFORE the order is written so a shop with no
  // keys anywhere fails cleanly and records which key-set ran it.
  const resolved = shopStripe.resolveForLead(db, row.lead_id); // throws SHOP_STRIPE_NOT_CONFIGURED
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
  const order = insertShopOrder(db, row.lead_id, product, { keySource: resolved.source });
  let session;
  try {
    session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: String(product.currency || 'USD').toLowerCase(),
            unit_amount: Number(product.price_cents) || 0,
            product_data: {
              name: String(product.name || 'Product'),
              ...(product.description ? { description: String(product.description).slice(0, 500) } : {}),
              ...(product.image_url && /^https?:\/\//.test(product.image_url) ? { images: [product.image_url] } : {}),
            },
          },
        },
      ],
      client_reference_id: String(order.id),
      metadata: {
        bitpype_order_id: String(order.id),
        bitpype_lead_id: String(row.lead_id),
        bitpype_product_id: String(product.id),
      },
      payment_intent_data: { metadata: { bitpype_order_id: String(order.id) } },
      success_url: `${base}${sep}order=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}${sep}order=cancelled`,
    });
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

function updateLesson(db, leadId, lessonId, data = {}) {
  ensureTables(db);
  const lesson = db.prepare('SELECT * FROM course_lessons WHERE id = ?').get(Number(lessonId));
  if (!lesson) throw fail('NOT_FOUND', 'Lesson not found', 404);
  const course = getCourse(db, leadId, lesson.course_id, { withLessons: false });
  if (!course) throw fail('NOT_FOUND', 'Course not found', 404);
  const title = data.title != null ? String(data.title).trim().slice(0, 200) : lesson.title;
  const body =
    data.body_html != null || data.body != null
      ? String(data.body_html != null ? data.body_html : data.body)
      : lesson.body_html;
  const url =
    data.lesson_url != null || data.lessonUrl != null || data.url != null
      ? String(data.lesson_url != null ? data.lesson_url : data.lessonUrl != null ? data.lessonUrl : data.url)
      : lesson.lesson_url;
  const sortOrder = data.sort_order != null ? Number(data.sort_order) || 0 : lesson.sort_order;
  db.prepare(
    `
    UPDATE course_lessons SET title=?, body_html=?, lesson_url=?, sort_order=?,
      updated_at=datetime('now') WHERE id=?
  `
  ).run(title, body, url, sortOrder, lesson.id);
  return db.prepare('SELECT * FROM course_lessons WHERE id = ?').get(lesson.id);
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
  if (!withImages) return rows;
  return rows.map((a) => ({ ...a, images: imagesForAlbum(db, a.id) }));
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
  return row;
}

function createAlbum(db, leadId, data = {}) {
  ensureTables(db);
  const title = String(data.title || data.name || '').trim();
  if (!title) throw fail('VALIDATION', 'title is required');
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
  return getAlbum(db, leadId, album.id);
}

function updateAlbum(db, leadId, id, data = {}) {
  ensureTables(db);
  const row = getAlbum(db, leadId, id, { withImages: false });
  if (!row) throw fail('NOT_FOUND', 'Album not found', 404);
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
  return getAlbum(db, leadId, row.id);
}

function deleteAlbum(db, leadId, id) {
  ensureTables(db);
  const row = getAlbum(db, leadId, id, { withImages: false });
  if (!row) throw fail('NOT_FOUND', 'Album not found', 404);
  db.prepare('DELETE FROM gallery_images WHERE album_id = ?').run(row.id);
  db.prepare('DELETE FROM gallery_albums WHERE id = ? AND lead_id = ?').run(row.id, Number(leadId));
  return { deleted: true, id: row.id };
}

function addGalleryImage(db, leadId, albumId, data = {}) {
  ensureTables(db);
  const album = getAlbum(db, leadId, albumId, { withImages: false });
  if (!album) throw fail('NOT_FOUND', 'Album not found', 404);
  const imageUrl = String(data.image_url || data.url || data.src || '').trim();
  if (!imageUrl) throw fail('VALIDATION', 'image_url is required');
  const info = db
    .prepare(
      `
    INSERT INTO gallery_images (album_id, image_url, caption, sort_order)
    VALUES (?, ?, ?, ?)
  `
    )
    .run(album.id, imageUrl, String(data.caption || ''), Number(data.sort_order) || 0);
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
  return db.prepare(sql).all(...params);
}

function getListing(db, leadId, id) {
  ensureTables(db);
  return db.prepare('SELECT * FROM directory_listings WHERE lead_id = ? AND id = ?').get(Number(leadId), Number(id));
}

function createListing(db, leadId, data = {}) {
  ensureTables(db);
  const name = String(data.name || data.title || '').trim();
  if (!name) throw fail('VALIDATION', 'name is required');
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
  return getListing(db, leadId, info.lastInsertRowid);
}

function updateListing(db, leadId, id, data = {}) {
  ensureTables(db);
  const row = getListing(db, leadId, id);
  if (!row) throw fail('NOT_FOUND', 'Listing not found', 404);
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
  return getListing(db, leadId, row.id);
}

function deleteListing(db, leadId, id) {
  ensureTables(db);
  const row = getListing(db, leadId, id);
  if (!row) throw fail('NOT_FOUND', 'Listing not found', 404);
  db.prepare('DELETE FROM directory_listings WHERE id = ? AND lead_id = ?').run(row.id, Number(leadId));
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

function listEvents(db, leadId, { includeDrafts = true } = {}) {
  ensureTables(db);
  let sql = 'SELECT * FROM events WHERE lead_id = ?';
  if (!includeDrafts) sql += " AND status = 'published'";
  sql += " ORDER BY CASE WHEN starts_at = '' THEN 1 ELSE 0 END, starts_at ASC, sort_order ASC, id DESC";
  return db.prepare(sql).all(Number(leadId));
}

function getEvent(db, leadId, idOrSlug) {
  ensureTables(db);
  const lid = Number(leadId);
  if (/^\d+$/.test(String(idOrSlug))) {
    return db.prepare('SELECT * FROM events WHERE lead_id = ? AND id = ?').get(lid, Number(idOrSlug));
  }
  return db.prepare('SELECT * FROM events WHERE lead_id = ? AND slug = ?').get(lid, slugify(idOrSlug));
}

function createEvent(db, leadId, data = {}) {
  ensureTables(db);
  const title = String(data.title || data.name || '').trim();
  if (!title) throw fail('VALIDATION', 'title is required');
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
  return getEvent(db, leadId, info.lastInsertRowid);
}

function updateEvent(db, leadId, id, data = {}) {
  ensureTables(db);
  const row = getEvent(db, leadId, id);
  if (!row) throw fail('NOT_FOUND', 'Event not found', 404);
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
  return getEvent(db, leadId, row.id);
}

function deleteEvent(db, leadId, id) {
  ensureTables(db);
  const row = getEvent(db, leadId, id);
  if (!row) throw fail('NOT_FOUND', 'Event not found', 404);
  db.prepare('DELETE FROM events WHERE id = ? AND lead_id = ?').run(row.id, Number(leadId));
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
  return includeDrafts ? rows : rows.filter((r) => !r.expired);
}

function getOffer(db, leadId, id) {
  ensureTables(db);
  const row = db.prepare('SELECT * FROM offers WHERE lead_id = ? AND id = ?').get(Number(leadId), Number(id));
  return withOfferFlags(row);
}

function createOffer(db, leadId, data = {}) {
  ensureTables(db);
  const title = String(data.title || data.name || '').trim();
  if (!title) throw fail('VALIDATION', 'title is required');
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
  return getOffer(db, leadId, info.lastInsertRowid);
}

function updateOffer(db, leadId, id, data = {}) {
  ensureTables(db);
  const row = getOffer(db, leadId, id);
  if (!row) throw fail('NOT_FOUND', 'Offer not found', 404);
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
  return getOffer(db, leadId, row.id);
}

function deleteOffer(db, leadId, id) {
  ensureTables(db);
  const row = getOffer(db, leadId, id);
  if (!row) throw fail('NOT_FOUND', 'Offer not found', 404);
  db.prepare('DELETE FROM offers WHERE id = ? AND lead_id = ?').run(row.id, Number(leadId));
  return { deleted: true, id: row.id };
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

function deleteEstimateRequest(db, leadId, id) {
  ensureTables(db);
  const row = getEstimateRequest(db, leadId, id);
  if (!row) throw fail('NOT_FOUND', 'Estimate request not found', 404);
  db.prepare('DELETE FROM estimate_requests WHERE id = ? AND lead_id = ?').run(row.id, Number(leadId));
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
  } catch {
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
  } catch {
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

function listCalls(db, leadId, { limit = CALL_LIST_CAP } = {}) {
  ensureTables(db);
  const lim = Math.min(CALL_LIST_CAP, Math.max(1, Number(limit) || CALL_LIST_CAP));
  return db
    .prepare('SELECT * FROM call_logs WHERE lead_id = ? ORDER BY id DESC LIMIT ?')
    .all(Number(leadId), lim);
}

/** Staff oversight: every call in the workspace, newest first. */
function listAllCalls(db, { limit = CALL_LIST_CAP } = {}) {
  ensureTables(db);
  const lim = Math.min(CALL_LIST_CAP, Math.max(1, Number(limit) || CALL_LIST_CAP));
  return db
    .prepare(
      `SELECT c.*, l.business_name AS lead_name
       FROM call_logs c
       LEFT JOIN leads l ON l.id = c.lead_id
       ORDER BY c.id DESC LIMIT ?`
    )
    .all(lim);
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
  sql += ' ORDER BY id DESC LIMIT ?';
  params.push(limit);
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

/**
 * Save the owner's Stripe keys for their site. Fields left blank keep
 * the stored value (the settings-UI convention); secret material is
 * stored secretBox-encrypted and is never returned — only a status.
 */
function saveMembershipStripeKeys(db, leadId, data = {}) {
  ensureTables(db);
  const id = Number(leadId);
  const box = require('../src/secretBox');
  const existing = getMembershipStripeKeyRow(db, id);
  const keep = (next, prev) => {
    const v = next == null ? '' : String(next).trim();
    return v === '' ? prev || '' : v;
  };
  let secretPlain = '';
  if (data.secret_key != null && String(data.secret_key).trim() !== '') {
    secretPlain = String(data.secret_key).trim();
    if (!/^(sk|rk)_(test|live)_/.test(secretPlain)) {
      throw fail('VALIDATION', 'Secret key must be a Stripe secret or restricted key (sk_… or rk_…).', 400);
    }
  }
  let publishable = keep(data.publishable_key, existing && existing.publishable_key);
  if (publishable && !/^pk_(test|live)_/.test(publishable)) {
    throw fail('VALIDATION', 'Publishable key must start with pk_test_ or pk_live_.', 400);
  }
  let webhookPlain = '';
  if (data.webhook_secret != null && String(data.webhook_secret).trim() !== '') {
    webhookPlain = String(data.webhook_secret).trim();
    if (!/^whsec_/.test(webhookPlain)) {
      throw fail('VALIDATION', 'Webhook signing secret must start with whsec_.', 400);
    }
  }
  const secretEnc = secretPlain
    ? box.encryptValue(secretPlain)
    : existing
      ? existing.secret_key_enc
      : '';
  const webhookEnc = webhookPlain
    ? box.encryptValue(webhookPlain)
    : existing
      ? existing.webhook_secret_enc
      : '';
  const last4 = secretPlain ? secretPlain.slice(-4) : existing ? existing.secret_key_last4 || '' : '';
  db.prepare(
    `INSERT INTO membership_stripe_keys (lead_id, publishable_key, secret_key_enc, webhook_secret_enc, secret_key_last4, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(lead_id) DO UPDATE SET publishable_key = excluded.publishable_key,
       secret_key_enc = excluded.secret_key_enc, webhook_secret_enc = excluded.webhook_secret_enc,
       secret_key_last4 = excluded.secret_key_last4, updated_at = datetime('now')`
  ).run(id, publishable || '', secretEnc || '', webhookEnc || '', last4 || '');
  return membershipStripeStatus(db, id);
}

function clearMembershipStripeKeys(db, leadId) {
  ensureTables(db);
  db.prepare('DELETE FROM membership_stripe_keys WHERE lead_id = ?').run(Number(leadId));
  return membershipStripeStatus(db, leadId);
}

/** Owner-safe status: never carries secret or webhook values. */
function membershipStripeStatus(db, leadId) {
  const row = getMembershipStripeKeyRow(db, leadId);
  const connected = !!(row && row.secret_key_enc);
  return {
    connected,
    publishable_key: row ? row.publishable_key || '' : '',
    secret_key_last4: row ? row.secret_key_last4 || '' : '',
    webhook_configured: !!(row && row.webhook_secret_enc),
    updated_at: row ? row.updated_at || null : null,
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
 * Save the owner's Stripe keys for their shop. Fields left blank keep
 * the stored value (the settings-UI convention); secret material is
 * stored secretBox-encrypted and is never returned — only a status.
 */
function saveShopStripeKeys(db, leadId, data = {}) {
  ensureTables(db);
  const id = Number(leadId);
  const box = require('../src/secretBox');
  const existing = getShopStripeKeyRow(db, id);
  const keep = (next, prev) => {
    const v = next == null ? '' : String(next).trim();
    return v === '' ? prev || '' : v;
  };
  let secretPlain = '';
  if (data.secret_key != null && String(data.secret_key).trim() !== '') {
    secretPlain = String(data.secret_key).trim();
    if (!/^(sk|rk)_(test|live)_/.test(secretPlain)) {
      throw fail('VALIDATION', 'Secret key must be a Stripe secret or restricted key (sk_… or rk_…).', 400);
    }
  }
  let publishable = keep(data.publishable_key, existing && existing.publishable_key);
  if (publishable && !/^pk_(test|live)_/.test(publishable)) {
    throw fail('VALIDATION', 'Publishable key must start with pk_test_ or pk_live_.', 400);
  }
  let webhookPlain = '';
  if (data.webhook_secret != null && String(data.webhook_secret).trim() !== '') {
    webhookPlain = String(data.webhook_secret).trim();
    if (!/^whsec_/.test(webhookPlain)) {
      throw fail('VALIDATION', 'Webhook signing secret must start with whsec_.', 400);
    }
  }
  const secretEnc = secretPlain
    ? box.encryptValue(secretPlain)
    : existing
      ? existing.secret_key_enc
      : '';
  const webhookEnc = webhookPlain
    ? box.encryptValue(webhookPlain)
    : existing
      ? existing.webhook_secret_enc
      : '';
  const last4 = secretPlain ? secretPlain.slice(-4) : existing ? existing.secret_key_last4 || '' : '';
  db.prepare(
    `INSERT INTO shop_stripe_keys (lead_id, publishable_key, secret_key_enc, webhook_secret_enc, secret_key_last4, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(lead_id) DO UPDATE SET publishable_key = excluded.publishable_key,
       secret_key_enc = excluded.secret_key_enc, webhook_secret_enc = excluded.webhook_secret_enc,
       secret_key_last4 = excluded.secret_key_last4, updated_at = datetime('now')`
  ).run(id, publishable || '', secretEnc || '', webhookEnc || '', last4 || '');
  return shopStripeStatus(db, id);
}

function clearShopStripeKeys(db, leadId) {
  ensureTables(db);
  db.prepare('DELETE FROM shop_stripe_keys WHERE lead_id = ?').run(Number(leadId));
  return shopStripeStatus(db, leadId);
}

/** Owner-safe status: never carries secret or webhook values. */
function shopStripeStatus(db, leadId) {
  const row = getShopStripeKeyRow(db, leadId);
  const connected = !!(row && row.secret_key_enc);
  return {
    connected,
    publishable_key: row ? row.publishable_key || '' : '',
    secret_key_last4: row ? row.secret_key_last4 || '' : '',
    webhook_configured: !!(row && row.webhook_secret_enc),
    updated_at: row ? row.updated_at || null : null,
  };
}

/**
 * Per-site payment state for the admin Shop screen: every lead that
 * has the Shop module, whether it connected its OWN Stripe keys, and
 * the effective source its checkout would use right now ('lead' when
 * the owner connected keys, 'workspace' when only the workspace keys
 * exist, 'none' when checkout cannot run). Truthful by construction —
 * derived from the key rows, never from a saved flag.
 */
function listShopPaymentSites(db, workspaceConfigured) {
  ensureTables(db);
  const rows = db
    .prepare(
      `SELECT e.lead_id AS lead_id, l.business_name AS lead_name,
              CASE WHEN k.secret_key_enc IS NOT NULL AND k.secret_key_enc <> '' THEN 1 ELSE 0 END AS lead_connected
       FROM site_module_embeds e
       LEFT JOIN leads l ON l.id = e.lead_id
       LEFT JOIN shop_stripe_keys k ON k.lead_id = e.lead_id
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

function setMembershipTierActive(db, leadId, tierId, active) {
  ensureTables(db);
  const existing = getMembershipTier(db, leadId, tierId);
  if (!existing) throw fail('NOT_FOUND', 'Tier not found', 404);
  db.prepare("UPDATE membership_tiers SET active = ?, updated_at = datetime('now') WHERE id = ? AND lead_id = ?").run(
    active ? 1 : 0,
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
  };
  if (existing) {
    db.prepare(
      `UPDATE member_subscriptions
       SET lead_id = ?, member_id = ?, tier_id = ?, tier_name = ?, price_cents = ?, interval = ?,
           stripe_customer_id = ?, stripe_subscription_id = ?, status = ?, cancel_at_period_end = ?,
           current_period_end = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).run(
      merged.lead_id, merged.member_id, merged.tier_id, merged.tier_name, merged.price_cents, merged.interval,
      merged.stripe_customer_id, merged.stripe_subscription_id, merged.status, merged.cancel_at_period_end,
      merged.current_period_end, existing.id
    );
    return shapeMemberSubscription(db.prepare('SELECT * FROM member_subscriptions WHERE id = ?').get(existing.id));
  }
  const info = db
    .prepare(
      `INSERT INTO member_subscriptions
       (lead_id, member_id, tier_id, tier_name, price_cents, interval, stripe_customer_id,
        stripe_subscription_id, status, cancel_at_period_end, current_period_end)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      merged.lead_id, merged.member_id, merged.tier_id, merged.tier_name, merged.price_cents, merged.interval,
      merged.stripe_customer_id, merged.stripe_subscription_id, merged.status, merged.cancel_at_period_end,
      merged.current_period_end
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
      // The money landed; the subscription.* events carry the
      // authoritative status + period and converge this row next.
      status: obj.payment_status === 'paid' ? 'active' : 'trialing',
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
    const stripeSubId = String(obj.subscription || '');
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
  if (!tier.stripe_price_id) {
    throw fail('MEMBERSHIP_STRIPE_NOT_CONFIGURED', 'Paid memberships are not set up for this site yet.', 409);
  }
  const membershipStripe = require('./membershipStripe');
  const stripe = membershipStripe.getClient(db, leadId); // throws MEMBERSHIP_STRIPE_NOT_CONFIGURED
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
  const metadata = {
    bitpype_lead_id: String(leadId),
    bitpype_member_id: String(member.id),
    bitpype_tier_id: String(tier.id),
  };
  let session;
  try {
    session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ quantity: 1, price: tier.stripe_price_id }],
      client_reference_id: String(member.id),
      customer_email: member.email,
      metadata,
      subscription_data: { metadata },
      success_url: `${base}${sep}membership=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}${sep}membership=cancelled`,
    });
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
         (SELECT COUNT(*) FROM membership_stripe_keys k WHERE k.lead_id = l.id AND k.secret_key_enc <> '') AS keys_connected
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
    updated_at: row.updated_at,
  };
}

function updateBookingSettings(db, leadId, data = {}) {
  ensureTables(db);
  getBookingSettings(db, leadId);
  const cur = db.prepare('SELECT * FROM booking_settings WHERE lead_id = ?').get(Number(leadId));
  const timezone = data.timezone != null ? String(data.timezone).slice(0, 80) : cur.timezone;
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
  db.prepare(
    `
    UPDATE booking_settings SET timezone=?, slot_interval_minutes=?, min_notice_hours=?,
      max_days_ahead=?, auto_confirm=?, updated_at=datetime('now') WHERE lead_id=?
  `
  ).run(timezone, interval, notice, ahead, auto, Number(leadId));
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

function deleteBookingService(db, leadId, id) {
  ensureTables(db);
  const row = db.prepare('SELECT * FROM booking_services WHERE lead_id = ? AND id = ?').get(Number(leadId), Number(id));
  if (!row) throw fail('NOT_FOUND', 'Service not found', 404);
  db.prepare('DELETE FROM booking_services WHERE id = ? AND lead_id = ?').run(row.id, Number(leadId));
  return { deleted: true, id: row.id };
}

function listAppointments(
  db,
  leadId,
  { status, from, to, limit = 200, includeArchived = false, archivedOnly = false } = {}
) {
  ensureTables(db);
  let sql = `
    SELECT b.*, s.name AS service_name, s.duration_minutes AS service_duration
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
    SELECT b.*, s.name AS service_name, s.duration_minutes AS service_duration
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
  ensureDefaultBookingHours(db, leadId);
  const settings = getBookingSettings(db, leadId);
  const day = parseYmd(date);
  if (!day) throw fail('VALIDATION', 'date must be YYYY-MM-DD');

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const max = new Date(today);
  max.setDate(max.getDate() + settings.max_days_ahead);
  if (day < today) throw fail('VALIDATION', 'date is in the past');
  if (day > max) throw fail('VALIDATION', `date is beyond the ${settings.max_days_ahead}-day booking window`);

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

  const weekday = day.getDay();
  const windows = listBookingHours(db, leadId).filter((h) => Number(h.weekday) === weekday);
  if (!windows.length) {
    return {
      date: ymdFromDate(day),
      service: service,
      settings,
      slots: [],
      closed: true,
    };
  }

  const ymd = ymdFromDate(day);
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
      const startMs = new Date(
        day.getFullYear(),
        day.getMonth(),
        day.getDate(),
        Math.floor(t / 60),
        t % 60,
        0
      ).getTime();
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

function createPublicBooking(db, leadId, data = {}) {
  ensureTables(db);
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

  const status = settings.auto_confirm ? 'confirmed' : 'pending';
  const info = db
    .prepare(
      `
    INSERT INTO bookings
      (lead_id, service_id, customer_name, customer_email, customer_phone, starts_at, ends_at, notes, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      status
    );
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

function createAppointment(db, leadId, data = {}) {
  // Staff/portal create — may force a slot even if slightly outside public rules
  ensureTables(db);
  const service = getBookingService(db, leadId, data.service_id || data.serviceId || data.service);
  if (!service) throw fail('VALIDATION', 'service_id is required');
  const name = String(data.customer_name || data.name || '').trim();
  if (!name) throw fail('VALIDATION', 'customer_name is required');
  let startsAt = String(data.starts_at || data.start || '').trim();
  if (!startsAt && data.date && data.time) {
    startsAt = `${data.date}T${String(data.time).slice(0, 5)}:00`;
  }
  const m = startsAt.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  if (!m) throw fail('VALIDATION', 'starts_at must be YYYY-MM-DDTHH:MM');
  const duration = Number(service.duration_minutes) || 30;
  const endsAt = data.ends_at ? String(data.ends_at) : `${m[1]}T${formatHm(parseHm(m[2]) + duration)}:00`;
  let status = String(data.status || 'confirmed').toLowerCase();
  if (!BOOKING_STATUSES.includes(status)) status = 'confirmed';
  const info = db
    .prepare(
      `
    INSERT INTO bookings
      (lead_id, service_id, customer_name, customer_email, customer_phone, starts_at, ends_at, notes, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
    )
    .run(
      Number(leadId),
      service.id,
      name.slice(0, 200),
      String(data.customer_email || data.email || '').slice(0, 240),
      String(data.customer_phone || data.phone || '').slice(0, 60),
      `${m[1]}T${m[2]}:00`,
      endsAt,
      String(data.notes || '').slice(0, 2000),
      status
    );
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
    console.warn('[siteModules] LeadScout appointment capture failed:', e.message || e);
  }
  return appt;
}

function deleteAppointment(db, leadId, id) {
  ensureTables(db);
  const row = getAppointment(db, leadId, id);
  if (!row) throw fail('NOT_FOUND', 'Appointment not found', 404);
  db.prepare('DELETE FROM bookings WHERE id = ? AND lead_id = ?').run(row.id, Number(leadId));
  return { deleted: true, id: row.id };
}

function moduleItemCount(db, leadId, type) {
  if (type === 'blog') return listBlogPosts(db, leadId).length;
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
    } catch {
      return 0;
    }
  }
  if (type === 'offers') return listOffers(db, leadId).length;
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
    } catch {
      return 0;
    }
  }
  if (type === 'calltracking') {
    // The tab badge counts calls received on the tracking number.
    ensureTables(db);
    const row = db.prepare('SELECT COUNT(*) AS c FROM call_logs WHERE lead_id = ?').get(Number(leadId));
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

function getPublicModuleByToken(db, token, opts = {}) {
  ensureTables(db);
  const row = db
    .prepare('SELECT * FROM site_module_embeds WHERE public_token = ? AND published = 1')
    .get(String(token || ''));
  if (!row) throw fail('NOT_FOUND', 'Module not found', 404);
  const leadId = row.lead_id;
  const type = row.module_type;
  // Membership: the members module itself is never gated; its payload
  // carries the caller's own member state for the public auth surface.
  if (type === 'members') return publicMembersPayload(db, row, opts);
  // Page gating: content on a gated page stays server-side until a valid
  // member session (or owner preview grant) accompanies the request. The
  // chatbot is a sitewide overlay, not page content — it is never gated.
  if (type !== 'chatbot') {
    const gate = memberGateCheck(db, leadId, opts.pageSlug || row.target_page_slug, opts);
    if (gate.locked) return lockedModulePayload(row, gate);
  }
  const settings = parseEmbedSettings(row);
  let items = [];
  let booking = null;
  let menuCategories = null;
  let estimate = null;
  let socialfeed = null;
  let calltracking = null;
  let total_published = null;
  if (type === 'blog') {
    items = listBlogPosts(db, leadId, { includeDrafts: false }).map((p) => ({
      ...p,
      excerpt: String(p.excerpt || '').trim() || deriveExcerptFromBody(p.body_html, 30),
    }));
    total_published = items.length;
    if (settings.post_limit != null) items = items.slice(0, settings.post_limit);
  } else if (type === 'ecommerce') {
    const stripeReady = require('./shopStripe').isConfiguredForLead(db, leadId);
    items = listProducts(db, leadId, { includeDrafts: false }).map((p) => ({
      ...p,
      price_label: formatPrice(p.price_cents, p.currency),
      stripe_checkout: stripeReady && !p.checkout_url,
    }));
  } else if (type === 'courses') items = listCourses(db, leadId, { includeDrafts: false, withLessons: true });
  else if (type === 'gallery') items = listAlbums(db, leadId, { includeDrafts: false, withImages: true });
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
  } else if (type === 'calltracking') {
    calltracking = publicCallTrackingPayload(db, leadId);
  } else if (type === 'chatbot') {
    try {
      const chat = require('./chatbot');
      return {
        ...chat.getPublicConfigByToken(db, row.public_token),
        items: [],
      };
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
  }
  if (estimate) out.estimate = estimate;
  if (socialfeed) out.socialfeed = socialfeed.config;
  if (calltracking) out.calltracking = calltracking;
  return out;
}

function getPublicModuleItem(db, token, slugOrId, opts = {}) {
  const payload = getPublicModuleByToken(db, token, opts);
  if (payload.locked) return payload;
  const type = payload.module_type;
  const leadId = payload.embed.lead_id;
  let item = null;
  if (type === 'blog') item = getBlogPost(db, leadId, slugOrId);
  else if (type === 'ecommerce') {
    item = getProduct(db, leadId, slugOrId);
    if (item)
      item = {
        ...item,
        price_label: formatPrice(item.price_cents, item.currency),
        stripe_checkout: require('./shopStripe').isConfiguredForLead(db, leadId) && !item.checkout_url,
      };
  } else if (type === 'courses') item = getCourse(db, leadId, slugOrId);
  else if (type === 'gallery') item = getAlbum(db, leadId, slugOrId);
  else if (type === 'directory') item = getListing(db, leadId, slugOrId);
  else if (type === 'faq') item = getFaqItem(db, leadId, slugOrId);
  else if (type === 'testimonials') item = getTestimonial(db, leadId, slugOrId);
  else if (type === 'team') item = getTeamMember(db, leadId, slugOrId);
  else if (type === 'events') item = getEvent(db, leadId, slugOrId);
  else if (type === 'bookings') item = getBookingService(db, leadId, slugOrId);
  else if (type === 'offers') {
    item = getOffer(db, leadId, slugOrId);
    if (item && item.expired) item = null;
  } else if (type === 'menu') item = getMenuItem(db, leadId, slugOrId);
  else if (type === 'careers') {
    item = getCareersPosting(db, leadId, slugOrId);
    if (item && !item.active) item = null;
  } else if (type === 'video') item = getVideoItem(db, leadId, slugOrId);
  if (!item || (item.status && item.status !== 'published' && item.status !== 'active')) {
    throw fail('NOT_FOUND', 'Item not found', 404);
  }
  return { ...payload, item };
}

function getPublicBookingSlots(db, token, { date, serviceId, serviceSlug } = {}, opts = {}) {
  ensureTables(db);
  const row = db
    .prepare('SELECT * FROM site_module_embeds WHERE public_token = ? AND published = 1')
    .get(String(token || ''));
  if (!row || row.module_type !== 'bookings') {
    throw fail('NOT_FOUND', 'Bookings module not found', 404);
  }
  assertMemberAccessForEmbed(db, row, opts);
  return {
    embed: publicEmbed(row),
    module_type: 'bookings',
    title: row.title || MODULE_META.bookings.label,
    ...listAvailableSlots(db, row.lead_id, { date, serviceId, serviceSlug }),
  };
}

function createPublicBookingByToken(db, token, data = {}, opts = {}) {
  ensureTables(db);
  const row = db
    .prepare('SELECT * FROM site_module_embeds WHERE public_token = ? AND published = 1')
    .get(String(token || ''));
  if (!row || row.module_type !== 'bookings') {
    throw fail('NOT_FOUND', 'Bookings module not found', 404);
  }
  assertMemberAccessForEmbed(db, row, opts);
  const appointment = createPublicBooking(db, row.lead_id, data);
  return {
    embed: publicEmbed(row),
    appointment: {
      id: appointment.id,
      service_id: appointment.service_id,
      service_name: appointment.service_name,
      starts_at: appointment.starts_at,
      ends_at: appointment.ends_at,
      status: appointment.status,
      customer_name: appointment.customer_name,
    },
    message:
      appointment.status === 'confirmed'
        ? 'Your appointment is confirmed.'
        : 'Request received — we will confirm your appointment soon.',
  };
}

/** Portal summary for all modules. */
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
  parseEmbedSettings,
  writeEmbedSettings,
  maybeProvisionBookingsCompanionForm,
  syncSiteModuleEmbeds,
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
  injectContentSectionIntoHtml,
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
  formatPrice,
  listCourses,
  getCourse,
  createCourse,
  updateCourse,
  deleteCourse,
  addLesson,
  updateLesson,
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
  setMembershipTierActive,
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
  listAppointments,
  moduleItemCount,
  getAppointment,
  createAppointment,
  updateAppointmentStatus,
  setAppointmentArchived,
  deleteAppointment,
  listAvailableSlots,
  createPublicBooking,
  getPublicModuleByToken,
  getPublicModuleItem,
  getPublicBookingSlots,
  createPublicBookingByToken,
  createShopCheckoutByToken,
  listShopOrders,
  applyShopStripeEvent,
  getShopOrderBySession,
  portalSummary,
  embedBlockHtml,
};
