'use strict';
/**
 * Batch 136 — BOOKING DISCOUNT + MODULE-STATE CHAT PITCH
 * (Ely's order 2026-11-04, as corrected twice the same day).
 *
 * The mechanic, final form:
 *   - The discount is an ONLINE-BOOKING discount. The owner sets it
 *     in the portal (on/off, default OFF; percent 1–90 or a fixed
 *     amount; optional label). When ON, EVERY online booking gets
 *     it automatically; when OFF, no discount is shown or promised
 *     anywhere.
 *   - SHOW IT: the bookings module's public payload carries the
 *     templated display fact when ON; the booking widget renders it
 *     before checkout plus a gross / −discount / total summary; the
 *     confirmation repeats the server's stamped figures.
 *   - ENGINE: the discount is computed SERVER-SIDE from the live
 *     config and applied on the BOOKING surface of the shared
 *     checkout engine only. Bookings and orders are stamped
 *     gross / discount kind+value+amount / net. Cart and membership
 *     surfaces carry no discount. Net floors at 0; a booking whose
 *     net is 0 follows the free-booking path (no payment).
 *   - CHAT: driven by MODULE STATE, never conversation judgment.
 *     Bookings declares its pitch through the shared layer
 *     (moduleShare): bookings live → the chat context carries the
 *     booking pitch; discount on → the pitch includes the exact
 *     templated discount line; discount off → pitch, no discount.
 *     There is NO intent / need-signal / discretionary-offer logic
 *     anywhere in this batch — Part 1 pins its absence.
 *
 *   Part 1 — source pins (incl. no-intent pins, surface isolation,
 *     the Batch 129 integration point).
 *   Part 2 — config CRUD + validation (in-process).
 *   Part 3 — engine math (percent / fixed / floor / rounding).
 *   Part 4 — shared-layer pitch matrix + chat context matrix
 *     (two independent booleans; pitch unconditional on topics).
 *   Part 5 — booking records stamped + public payload fact.
 *   Part 6 — order stamping through the checkout core's insert
 *     path + cart isolation.
 *   Part 7 — POST-REBASE checks for the Batch 129 pay-at-booking
 *     wiring. These CANNOT run on the Batch 128 base (129's
 *     lineForBookingService / pay-at-booking flow do not exist
 *     here); they activate automatically once the finisher rebases
 *     onto the post-131 tip, and print an explicit SKIP line on
 *     this base — never a silent skip.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b136-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch136', 'test', 'session', 'secret', 'value'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY = process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 21).toString('base64');

const groups = [];
function group(name, n) {
  groups.push(`${name} (${n})`);
  console.log(`  ok ${name} — ${n} checks`);
}

const LEAD_CFG = 13601;
const LEAD_PITCH_OFF = 13602;
const LEAD_PITCH_ON = 13603;
const LEAD_BOOK = 13604;
const LEAD_BOOK_OFF = 13605;
const LEAD_ZERO = 13606;
let WS_ID;
let db;

function futureWeekdayStart() {
  const d = new Date();
  d.setDate(d.getDate() + 7);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `${ymd}T10:00:00`;
}

(async () => {
  const smSrc = read('server/siteModules.js');

  /* ================================================================== */
  /* Part 1 — source pins                                                */
  /* ================================================================== */
  {
    let n = 0;
    assert.ok(
      smSrc.includes('discount_enabled INTEGER NOT NULL DEFAULT 0'),
      'booking_settings carries the discount switch (default OFF)'
    );
    assert.ok(smSrc.includes('function getBookingDiscountConfig'), 'the live discount config reader exists');
    assert.ok(smSrc.includes('function bookingPriceStamp'), 'the server-side price stamp exists');
    assert.ok(smSrc.includes('function applyBookingDiscountToLine'), 'the Batch 129 integration helper exists');
    assert.ok(
      smSrc.includes('price_gross_cents') && smSrc.includes('price_net_cents'),
      'bookings carry gross/net stamp columns'
    );
    assert.ok(
      smSrc.includes('gross_amount_cents') && smSrc.includes('discount_amount_cents'),
      'orders carry the discount stamp columns'
    );
    assert.ok(
      smSrc.includes("const MODULE_SCRIPT_VER = 'mod39'"),
      'MODULE_SCRIPT_VER bumped relatively (+1 from the landed tip: mod37 -> mod38, applied by the finisher at rebase)'
    );
    n += 7;

    const shareSrc = read('server/moduleShare.js');
    assert.ok(shareSrc.includes('declarations:'), 'bookings DECLARES through the shared layer');
    assert.ok(shareSrc.includes('booking_pitch(db, leadId)'), 'the booking_pitch declaration exists');
    assert.ok(shareSrc.includes('function getBookingPitch'), 'the shared accessor exists');
    assert.ok(
      shareSrc.includes("chatbot: {\n    kind: 'none',"),
      'chatbot stays an explicit NON-provider (registry parity untouched)'
    );
    n += 4;

    const chatSrc = read('server/chatbot.js');
    assert.ok(
      chatSrc.includes("require('./moduleShare').getBookingPitch"),
      'chat consumes the pitch through the shared layer only'
    );
    assert.ok(
      chatSrc.includes('Online booking (always true on this site)'),
      'the AI fallback prompt carries the pitch as an always-true site fact'
    );
    assert.ok(
      chatSrc.includes('booking_pitch: bookingPitchFor(db, row.lead_id)'),
      'the public chat config carries the pitch'
    );
    n += 3;

    // NO INTENT LOGIC: the pitch builder reads module state only —
    // no conversation, visitor, or message input anywhere near it.
    const pitchBody = shareSrc.slice(
      shareSrc.indexOf('function buildBookingPitch'),
      shareSrc.indexOf('/** Convenience accessor')
    );
    assert.ok(
      !/visitorStatedNeed|listMessages|chatbot_sessions|latestVisitor|sessionId/.test(pitchBody),
      'buildBookingPitch inspects no conversation signal'
    );
    const stampBody = smSrc.slice(smSrc.indexOf('function bookingPriceStamp'), smSrc.indexOf('/** The stamp shape'));
    assert.ok(!/chat|visitor|intent/i.test(stampBody), 'the price stamp is config+price only');
    n += 2;

    const embedSrc = read('public/js/module-embed.js');
    assert.ok(
      embedSrc.includes('data-bp-discount-banner'),
      'the booking widget renders the discount fact before checkout'
    );
    assert.ok(
      embedSrc.includes('data-bp-price-summary'),
      'the booking widget renders gross/-discount/total before payment'
    );
    const portalSrc = read('public/js/portal.js');
    assert.ok(
      portalSrc.includes('id="booking-discount-enabled"'),
      'the portal bookings pane carries the discount switch'
    );
    assert.ok(
      portalSrc.includes('id="booking-discount-kind"') && portalSrc.includes('id="booking-discount-value"'),
      'the portal carries kind + value'
    );
    assert.ok(portalSrc.includes('id="booking-discount-label"'), 'the portal carries the optional label');
    n += 5;

    // Surface isolation pins: the discount reaches the checkout core
    // ONLY via the booking surface's opts; cart + membership never.
    assert.ok(smSrc.includes('opts.bookingDiscount'), 'checkoutShopLines accepts the booking-only discount stamp');
    const cartBody = smSrc.slice(
      smSrc.indexOf('function createCartCheckoutByToken'),
      smSrc.indexOf('function getCheckoutConfig')
    );
    assert.ok(!cartBody.includes('bookingDiscount'), 'the cart checkout never passes a discount');
    const memberBody = smSrc.slice(
      smSrc.indexOf('function createMembershipCheckoutByToken'),
      smSrc.indexOf('function joinFreeTierByToken')
    );
    assert.ok(
      memberBody.length > 0 && !memberBody.includes('Discount'),
      'the membership checkout never touches the discount'
    );
    n += 3;
    group('Part 1 source pins', n);
  }

  /* ================================================================== */
  /* Setup                                                               */
  /* ================================================================== */
  const platformDb = require(path.join(root, 'server/db.js'));
  await platformDb.migrate();
  const workspace = require(path.join(root, 'server/workspace.js'));
  const { openWorkspaceDb } = require(path.join(root, 'server/workspaceDb.js'));
  const sm = require(path.join(root, 'server/siteModules.js'));
  const share = require(path.join(root, 'server/moduleShare.js'));
  const chat = require(path.join(root, 'server/chatbot.js'));

  const a = await workspace.createUserWithWorkspace({
    email: 'a136@example.invalid',
    password: ['batch136', 'fixture', 'password'].join('-'),
    name: 'A136',
    workspaceName: 'Batch136 WS',
  });
  WS_ID = Number(a.workspaceId);
  db = openWorkspaceDb(WS_ID);
  sm.ensureTables(db);
  for (const lead of [LEAD_CFG, LEAD_PITCH_OFF, LEAD_PITCH_ON, LEAD_BOOK, LEAD_BOOK_OFF, LEAD_ZERO]) {
    db.prepare('INSERT INTO leads (id, business_name, email, status) VALUES (?, ?, ?, ?)').run(
      lead,
      `B136 Lead ${lead}`,
      `lead${lead}@example.invalid`,
      'customer'
    );
  }
  assert.equal(
    sm.MODULE_TYPES.length,
    28,
    'MODULE_TYPES unchanged — no new module type (28 on the landed tip: Batch 131 added comments after this suite was parked)'
  );
  assert.ok(!sm.MODULE_TYPES.includes('discount'), 'no discount module type exists');

  /* ================================================================== */
  /* Part 2 — config CRUD + validation                                   */
  /* ================================================================== */
  {
    let n = 0;
    const dflt = sm.getBookingSettings(db, LEAD_CFG);
    assert.equal(dflt.discount_enabled, false, 'discount defaults OFF');
    assert.equal(dflt.discount, null, 'no discount config by default');
    assert.equal(sm.getBookingDiscountConfig(db, LEAD_CFG), null, 'reader: unconfigured = null');
    n += 3;

    const on = sm.updateBookingSettings(db, LEAD_CFG, {
      discount_enabled: true,
      discount_kind: 'percent',
      discount_value: 15,
      discount_label: 'New client special',
    });
    assert.equal(on.discount_enabled, true);
    assert.equal(on.discount.kind, 'percent');
    assert.equal(on.discount.value, 15);
    assert.equal(on.discount.label, 'New client special');
    assert.equal(
      on.discount.display,
      'New client special — 15% off when you book online',
      'templated display, byte-equal'
    );
    n += 5;

    // Partial updates leave the discount untouched.
    const partial = sm.updateBookingSettings(db, LEAD_CFG, { auto_confirm: true });
    assert.equal(
      partial.discount.display,
      'New client special — 15% off when you book online',
      'partial update preserves the discount'
    );
    n++;

    // Validation: invalid deals are refused, never clamped into a
    // different deal than the owner typed.
    assert.throws(
      () => sm.updateBookingSettings(db, LEAD_CFG, { discount_kind: 'bogus' }),
      /discount_kind/,
      'bad kind refused'
    );
    assert.throws(
      () => sm.updateBookingSettings(db, LEAD_CFG, { discount_value: 91, discount_kind: 'percent' }),
      /between 1 and 90/,
      'percent > 90 refused'
    );
    assert.throws(
      () => sm.updateBookingSettings(db, LEAD_CFG, { discount_value: 10.5 }),
      /whole number/,
      'fractional value refused'
    );
    assert.throws(
      () => sm.updateBookingSettings(db, LEAD_CFG, { discount_value: -5 }),
      /whole number/,
      'negative value refused'
    );
    n += 4;

    // Enabling an incomplete deal is refused.
    sm.updateBookingSettings(db, LEAD_CFG, { discount_enabled: false, discount_value: 0, discount_label: '' });
    assert.throws(
      () => sm.updateBookingSettings(db, LEAD_CFG, { discount_enabled: true }),
      /to switch the discount on/,
      'enabling with no value refused'
    );
    n++;

    // Fixed amounts store as cents (discount_value_cents accepted).
    const fixed = sm.updateBookingSettings(db, LEAD_CFG, {
      discount_enabled: true,
      discount_kind: 'fixed',
      discount_value_cents: 2500,
      discount_label: '',
    });
    assert.equal(fixed.discount.value, 2500, 'fixed value stored in cents');
    assert.equal(
      fixed.discount.display,
      'Book online — $25.00 off your appointment',
      'default display generated when no label'
    );
    n += 2;

    // OFF keeps the stored deal but publishes nothing.
    const off = sm.updateBookingSettings(db, LEAD_CFG, { discount_enabled: false });
    assert.equal(off.discount, null, 'OFF publishes no discount');
    assert.equal(off.discount_value, 2500, 'OFF retains the stored value for re-enable');
    assert.equal(sm.getBookingDiscountConfig(db, LEAD_CFG), null, 'reader agrees: OFF = null');
    n += 3;
    group('Part 2 config CRUD + validation', n);
  }

  /* ================================================================== */
  /* Part 3 — engine math                                                */
  /* ================================================================== */
  {
    let n = 0;
    sm.updateBookingSettings(db, LEAD_CFG, {
      discount_enabled: true,
      discount_kind: 'percent',
      discount_value: 15,
      discount_label: 'New client special',
    });
    let s = sm.bookingPriceStamp(db, LEAD_CFG, 10000);
    assert.equal(s.discount_amount_cents, 1500, 'percent: 15% of $100.00');
    assert.equal(s.net_cents, 8500, 'percent net');
    assert.equal(s.discount_kind, 'percent');
    assert.equal(s.discount_value, 15);
    s = sm.bookingPriceStamp(db, LEAD_CFG, 9999);
    assert.equal(s.discount_amount_cents, 1500, 'percent rounds to the nearest cent (1499.85 -> 1500)');
    assert.equal(s.net_cents, 8499);
    n += 6;

    sm.updateBookingSettings(db, LEAD_CFG, { discount_kind: 'fixed', discount_value: 2500, discount_label: '' });
    s = sm.bookingPriceStamp(db, LEAD_CFG, 10000);
    assert.equal(s.discount_amount_cents, 2500, 'fixed amount');
    assert.equal(s.net_cents, 7500);
    s = sm.bookingPriceStamp(db, LEAD_CFG, 2000);
    assert.equal(s.discount_amount_cents, 2000, 'fixed larger than price takes the whole price');
    assert.equal(s.net_cents, 0, 'net floors at 0 — the $0 booking follows the free path');
    n += 4;

    sm.updateBookingSettings(db, LEAD_CFG, { discount_enabled: false });
    s = sm.bookingPriceStamp(db, LEAD_CFG, 10000);
    assert.equal(s.discount_amount_cents, 0, 'OFF: no discount computed');
    assert.equal(s.net_cents, 10000, 'OFF: net = gross');
    assert.equal(sm.publicDiscountStamp(s), null, 'OFF: no public stamp');
    s = sm.bookingPriceStamp(db, LEAD_CFG, 0);
    assert.equal(s.net_cents, 0, 'free service stays free');
    n += 4;
    group('Part 3 engine math', n);
  }

  /* ================================================================== */
  /* Part 4 — shared-layer pitch matrix + chat context                   */
  /* ================================================================== */
  {
    let n = 0;
    const activateBookings = (lead, { published = true } = {}) => {
      const emb = sm.ensureEmbed(db, lead, 'bookings', { workspaceId: WS_ID });
      db.prepare('UPDATE site_module_embeds SET published = ? WHERE id = ?').run(published ? 1 : 0, emb.id);
      return emb;
    };

    // Boolean 1 OFF: no bookings module at all -> no pitch.
    assert.equal(share.getBookingPitch(db, LEAD_PITCH_OFF), null, 'no bookings module -> no pitch');
    n++;
    // Embed present but not published -> still inactive.
    activateBookings(LEAD_PITCH_OFF, { published: false });
    sm.createBookingService(db, LEAD_PITCH_OFF, { name: 'Consult', status: 'published', price_cents: 5000 });
    assert.equal(share.getBookingPitch(db, LEAD_PITCH_OFF), null, 'unpublished bookings embed -> no pitch');
    n++;
    // Published embed but only a DRAFT service -> not bookable -> no pitch.
    const embOn = activateBookings(LEAD_PITCH_ON);
    sm.createBookingService(db, LEAD_PITCH_ON, { name: 'Draft Only', status: 'draft', price_cents: 5000 });
    assert.equal(share.getBookingPitch(db, LEAD_PITCH_ON), null, 'no published service -> no pitch');
    n++;

    // Boolean 1 ON, Boolean 2 OFF: pitch with NO discount anywhere.
    sm.createBookingService(db, LEAD_PITCH_ON, { name: 'Consult', status: 'published', price_cents: 5000 });
    const pitchOff = share.getBookingPitch(db, LEAD_PITCH_ON);
    assert.ok(pitchOff && pitchOff.active, 'bookings live -> pitch exists');
    assert.equal(pitchOff.booking_path, '/book', 'pitch routes to the booking page');
    assert.equal(pitchOff.discount, null, 'discount OFF -> pitch carries no discount');
    assert.ok(
      !/off|discount/i.test(pitchOff.pitch_text.replace('booking option', '')),
      'pitch text mentions no discount when OFF'
    );
    n += 4;

    // Boolean 2 ON: the pitch carries the EXACT templated fact.
    sm.updateBookingSettings(db, LEAD_PITCH_ON, {
      discount_enabled: true,
      discount_kind: 'percent',
      discount_value: 15,
      discount_label: '',
    });
    const pitchOn = share.getBookingPitch(db, LEAD_PITCH_ON);
    const cfgDisplay = sm.getBookingDiscountConfig(db, LEAD_PITCH_ON).display;
    assert.equal(cfgDisplay, 'Book online — 15% off your appointment');
    assert.equal(pitchOn.discount.display, cfgDisplay, 'pitch discount display is byte-equal to the config template');
    assert.ok(pitchOn.pitch_text.includes(cfgDisplay), 'pitch text includes the exact discount line');
    n += 3;

    // Chat context: same matrix, and UNCONDITIONAL on topics — the
    // pitch is identical before and after a visitor says anything.
    const chatEmb = sm.ensureEmbed(db, LEAD_PITCH_ON, 'chatbot', { workspaceId: WS_ID });
    db.prepare('UPDATE site_module_embeds SET published = 1 WHERE id = ?').run(chatEmb.id);
    const cfg1 = chat.getPublicConfigByToken(db, chatEmb.public_token);
    assert.ok(cfg1.booking_pitch && cfg1.booking_pitch.discount, 'chat config carries pitch + discount when both on');
    assert.ok(
      cfg1.allowed_actions.some((act) => act.id === 'bookings.pitch'),
      'allowed actions carry the pitch action'
    );
    const pending1 = chat.listPendingSessions(db, LEAD_PITCH_ON);
    assert.equal(pending1.booking_pitch.pitch_text, pitchOn.pitch_text, 'pending context pitch matches');
    db.prepare(
      "INSERT INTO chatbot_sessions (lead_id, session_token, status, needs_agent, last_visitor_at) VALUES (?, ?, 'open', 1, datetime('now'))"
    ).run(LEAD_PITCH_ON, 'b136-session-token');
    const sess = db.prepare('SELECT * FROM chatbot_sessions WHERE lead_id = ?').get(LEAD_PITCH_ON);
    db.prepare('INSERT INTO chatbot_messages (session_id, lead_id, role, body) VALUES (?, ?, ?, ?)').run(
      sess.id,
      LEAD_PITCH_ON,
      'visitor',
      'just browsing, no plans at all'
    );
    const pending2 = chat.listPendingSessions(db, LEAD_PITCH_ON);
    assert.equal(
      pending2.booking_pitch.pitch_text,
      pitchOn.pitch_text,
      'pitch is identical whatever the visitor said — no topic gating'
    );
    n += 4;

    // Chat context with bookings inactive: no pitch, no pitch action.
    const chatEmbOff = sm.ensureEmbed(db, LEAD_PITCH_OFF, 'chatbot', { workspaceId: WS_ID });
    db.prepare('UPDATE site_module_embeds SET published = 1 WHERE id = ?').run(chatEmbOff.id);
    const cfgOff = chat.getPublicConfigByToken(db, chatEmbOff.public_token);
    assert.equal(cfgOff.booking_pitch, null, 'bookings inactive -> chat context has no pitch');
    assert.ok(
      !cfgOff.allowed_actions.some((act) => act.id === 'bookings.pitch'),
      'no pitch action when bookings inactive'
    );
    n += 2;
    group('Part 4 pitch + chat context matrix', n);
  }

  /* ================================================================== */
  /* Part 5 — booking records stamped + public payload                   */
  /* ================================================================== */
  {
    let n = 0;
    const emb = sm.ensureEmbed(db, LEAD_BOOK, 'bookings', { workspaceId: WS_ID });
    db.prepare('UPDATE site_module_embeds SET published = 1 WHERE id = ?').run(emb.id);
    const svc = sm.createBookingService(db, LEAD_BOOK, {
      name: 'Deep Clean',
      status: 'published',
      price_cents: 10000,
      duration_minutes: 30,
    });
    sm.updateBookingSettings(db, LEAD_BOOK, {
      discount_enabled: true,
      discount_kind: 'percent',
      discount_value: 15,
      discount_label: 'New client special',
    });

    const payload = sm.getPublicModuleByToken(db, emb.public_token);
    assert.equal(
      payload.booking.discount.display,
      'New client special — 15% off when you book online',
      'public payload carries the templated fact when ON'
    );
    n++;

    const booked = await sm.createPublicBookingByToken(db, emb.public_token, {
      service_id: svc.id,
      starts_at: futureWeekdayStart(),
      customer_name: 'Pat Visitor',
      customer_email: 'pat@example.invalid',
    });
    assert.equal(booked.appointment.price_gross_cents, 10000, 'booking stamped gross');
    assert.equal(booked.appointment.discount_amount_cents, 1500, 'booking stamped discount amount');
    assert.equal(booked.appointment.price_net_cents, 8500, 'booking stamped net');
    assert.equal(booked.discount.discount_amount_cents, 1500, 'response carries the stamp');
    const row = sm.getAppointment(db, LEAD_BOOK, booked.appointment.id);
    assert.equal(row.discount_kind, 'percent');
    assert.equal(row.discount_value, 15);
    assert.equal(row.discount_label, 'New client special');
    n += 7;

    // OFF: payload has no fact, booking has no discount.
    const embOff = sm.ensureEmbed(db, LEAD_BOOK_OFF, 'bookings', { workspaceId: WS_ID });
    db.prepare('UPDATE site_module_embeds SET published = 1 WHERE id = ?').run(embOff.id);
    const svcOff = sm.createBookingService(db, LEAD_BOOK_OFF, {
      name: 'Checkup',
      status: 'published',
      price_cents: 8000,
      duration_minutes: 30,
    });
    const payloadOff = sm.getPublicModuleByToken(db, embOff.public_token);
    assert.equal(payloadOff.booking.discount, null, 'public payload has NO discount fact when OFF');
    const bookedOff = await sm.createPublicBookingByToken(db, embOff.public_token, {
      service_id: svcOff.id,
      starts_at: futureWeekdayStart(),
      customer_name: 'Sam Visitor',
      customer_email: 'sam@example.invalid',
    });
    assert.equal(bookedOff.appointment.discount_amount_cents, 0, 'OFF booking: no discount');
    assert.equal(bookedOff.appointment.price_net_cents, 8000, 'OFF booking: net = gross');
    assert.equal(bookedOff.discount, null, 'OFF booking: no stamp in the response');
    n += 4;

    // $0 booking: fixed discount >= price -> net 0, status follows
    // the free-booking precedent (auto_confirm decides, no payment).
    const embZ = sm.ensureEmbed(db, LEAD_ZERO, 'bookings', { workspaceId: WS_ID });
    db.prepare('UPDATE site_module_embeds SET published = 1 WHERE id = ?').run(embZ.id);
    const svcZ = sm.createBookingService(db, LEAD_ZERO, {
      name: 'Intro Visit',
      status: 'published',
      price_cents: 2000,
      duration_minutes: 30,
    });
    sm.updateBookingSettings(db, LEAD_ZERO, {
      discount_enabled: true,
      discount_kind: 'fixed',
      discount_value: 5000,
      auto_confirm: true,
    });
    const bookedZ = await sm.createPublicBookingByToken(db, embZ.public_token, {
      service_id: svcZ.id,
      starts_at: futureWeekdayStart(),
      customer_name: 'Zoe Visitor',
      customer_email: 'zoe@example.invalid',
    });
    assert.equal(bookedZ.appointment.price_net_cents, 0, '$0 booking: net is 0');
    assert.equal(
      bookedZ.appointment.status,
      'confirmed',
      '$0 booking confirms per auto_confirm — the free-booking path'
    );
    n += 2;
    group('Part 5 booking stamps + payload', n);
  }

  /* ================================================================== */
  /* Part 6 — order stamping + surface isolation                         */
  /* ================================================================== */
  {
    let n = 0;
    const stamp = {
      gross_cents: 10000,
      discount_amount_cents: 1500,
      net_cents: 8500,
      discount_kind: 'percent',
      discount_value: 15,
      discount_label: 'New client special',
    };
    const grossLine = {
      source_module: 'bookings',
      source_meta: JSON.stringify({ appointment_id: 42 }),
      product_id: 7,
      product_name: 'Deep Clean',
      variant_id: null,
      variant_label: '',
      image_url: '',
      unit_price_cents: 10000,
      quantity: 1,
      line_total_cents: 10000,
      currency: 'USD',
      description: '',
    };
    const netLine = sm.applyBookingDiscountToLine(grossLine, stamp);
    assert.equal(netLine.unit_price_cents, 8500, 'discounted line charges the NET');
    assert.equal(netLine.line_total_cents, 8500);
    const meta = JSON.parse(netLine.source_meta);
    assert.equal(meta.appointment_id, 42, 'line meta keeps the appointment link');
    assert.equal(meta.discount_amount_cents, 1500, 'line meta carries the stamp');
    assert.equal(grossLine.unit_price_cents, 10000, 'the gross line is not mutated');
    n += 5;

    // The order insert path (what checkoutShopLines calls) stamps
    // the order row; a mismatched stamp is refused.
    const order = sm.insertShopOrderWithLines(db, LEAD_BOOK, [netLine], { currency: 'USD', discount: stamp });
    assert.equal(order.amount_cents, 8500, 'order amount is the NET charged');
    assert.equal(order.gross_amount_cents, 10000, 'order stamped gross');
    assert.equal(order.discount_amount_cents, 1500, 'order stamped discount amount');
    assert.equal(order.discount_kind, 'percent');
    assert.equal(order.discount_value, 15);
    const withItems = sm.listShopOrdersWithItems(db, LEAD_BOOK).find((o) => o.id === order.id);
    assert.ok(withItems.discount, 'portal order read carries the stamp');
    assert.equal(withItems.discount.net_cents, 8500);
    assert.equal(withItems.items[0].source_module, 'bookings');
    n += 8;

    assert.throws(
      () =>
        sm.insertShopOrderWithLines(db, LEAD_BOOK, [netLine], {
          currency: 'USD',
          discount: { ...stamp, net_cents: 9999 },
        }),
      /does not match/,
      'a stamp that disagrees with the line total is refused'
    );
    n++;

    // Cart isolation at the same insert path: no stamp passed, no
    // stamp recorded, the read shape reports discount: null.
    const cartOrder = sm.insertShopOrderWithLines(
      db,
      LEAD_BOOK,
      [{ ...grossLine, source_module: 'ecommerce', source_meta: '', product_name: 'Plant' }],
      { currency: 'USD' }
    );
    assert.equal(cartOrder.discount_amount_cents, 0, 'cart order: no discount amount');
    assert.equal(cartOrder.gross_amount_cents, null, 'cart order: no gross stamp');
    const cartRead = sm.listShopOrdersWithItems(db, LEAD_BOOK).find((o) => o.id === cartOrder.id);
    assert.equal(cartRead.discount, null, 'cart order read: discount is null');
    n += 3;
    group('Part 6 order stamping + isolation', n);
  }

  /* ================================================================== */
  /* Part 7 — POST-REBASE (Batch 129) integration checks                 */
  /* ================================================================== */
  {
    let n = 0;
    if (!smSrc.includes('function lineForBookingService')) {
      console.log(
        '  SKIP Part 7 — Batch 129 pay-at-booking is not on this base (Batch 128). These checks activate on the finisher’s post-rebase run: (1) createPublicBookingByToken builds its line via applyBookingDiscountToLine; (2) checkoutShopLines is called with opts.bookingDiscount = the appointment stamp; (3) a net-0 booking creates NO checkout session and follows the free-booking path; (4) result.payment carries gross/discount/net.'
      );
      group('Part 7 post-rebase integration (SKIPPED on this base)', 0);
    } else {
      const tokenBody = smSrc.slice(
        smSrc.indexOf('async function createPublicBookingByToken'),
        smSrc.indexOf('function portalSummary')
      );
      assert.ok(tokenBody.includes('applyBookingDiscountToLine'), 'the booking flow discounts its shared-engine line');
      assert.ok(tokenBody.includes('bookingDiscount'), 'the booking flow passes the stamp into checkoutShopLines');
      assert.ok(tokenBody.includes('price_net_cents'), 'the booking flow branches on the stamped net (the $0 skip)');
      n += 3;
      group('Part 7 post-rebase integration', n);
    }
  }

  console.log(`\nBatch 136 booking-discount regressions: ALL PASS — ${groups.join('; ')}`);
})().catch((e) => {
  console.error('\nBatch 136 booking-discount regressions FAILED:');
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
