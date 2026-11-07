'use strict';
/**
 * Batch 151 — AI KNOWLEDGE SOURCES (Ely's order 2026-11-05, from his
 * live voice test on Victoria): the owner selects which MODULES,
 * which PAGES and which KNOWLEDGE BASE documents may provide
 * answers. Root cause of the order: buildAssistantContext read ONLY
 * the business profile + the chatbot's own KB — module content was
 * never read in, so the agent could not say what plants the shop
 * sells.
 *
 * What is pinned here (behavioural, on the REAL context builder +
 * settings save path — no HTTP needed, both are in-process):
 *   Part 1 — source pins: no new module type (MODULE_TYPES stays
 *     29); the settings key, digest builder + caps, the voice seam,
 *     the portal panel, and the public-config fence (toggles never
 *     serialize into the widget config).
 *   Part 2 — defaults all-on: with NO settings ever saved, a
 *     fixture shop's products (names + "From" price), booking
 *     services, FAQ pairs, blog titles, the Batch 139 price book,
 *     the site's page text and both KB docs all reach
 *     buildAssistantContext; a checkout shell page never does.
 *   Part 3 — toggles: module off → that digest gone, others stay;
 *     page off → page text gone; KB doc off → that doc's snippets
 *     gone; KB group off → empty knowledge, context + voice still
 *     build (greet/escalate intact); modules group off → module
 *     digests AND the price book leave together; pricing off alone
 *     → priceBookFor null on every surface.
 *   Part 4 — one brain: voice instructions carry the same digests
 *     as the text context; the public widget config carries no
 *     knowledge_sources anywhere; a legacy settings row (no
 *     knowledge_sources key) behaves all-on; save validation
 *     refuses unknown module types without touching the row and
 *     drops dead slugs/ids safely; the portal summary lists every
 *     selectable source with live counts + effective state.
 *   Part 5 — caps: a 15-product shop digests to at most 10 product
 *     lines inside the per-source char cap.
 *   Part 6 — finisher fence ruling: the client MCP agent surface
 *     (chatbot.knowledge.list, items AND snippets) honours the same
 *     toggles through chatbot.knowledgeIncludeIds — the ONE filtered
 *     path buildAssistantContext uses — while listPendingSessions
 *     (the portal inbox preview) deliberately keeps all-docs
 *     behaviour: the owner sees everything, the agent does not.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b151-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch151', 'test', 'session', 'secret'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY = process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 24).toString('base64');

const groups = [];
function group(name, n) {
  groups.push(`${name} (${n})`);
  console.log(`  ok ${name} — ${n} checks`);
}

const LEAD_A = 151001;
const LEAD_B = 151002;
const LEAD_C = 151003;

(async () => {
  /* ================================================================== */
  /* Part 1 — source pins                                                */
  /* ================================================================== */
  {
    let n = 0;
    const sm = require(path.join(root, 'server/siteModules.js'));
    assert.equal(sm.MODULE_TYPES.length, 29, 'Batch 151 adds NO module type (29 stands)');
    n++;
    const botSrc = read('server/chatbot.js');
    assert.ok(botSrc.includes('knowledge_sources'), 'chatbot settings carry knowledge_sources');
    n++;
    assert.ok(botSrc.includes('function buildKnowledgeDigests'), 'the digest builder exists');
    n++;
    assert.ok(botSrc.includes('function knowledgeSourcesFromSettings'), 'the one resolver gate exists');
    n++;
    assert.ok(botSrc.includes('SOURCE_ITEMS_PER_MODULE = 10'), 'per-module item cap pinned');
    n++;
    assert.ok(botSrc.includes('SOURCE_MODULE_CHARS = 2400'), 'per-module char cap pinned');
    n++;
    assert.ok(botSrc.includes('SOURCE_PAGE_CHARS = 1500'), 'per-page char cap pinned');
    n++;
    assert.ok(botSrc.includes("require('./moduleShare')"), 'digests read through the Batch 122 shared layer');
    n++;
    const voiceSrc = read('server/chatbotVoice.js');
    assert.ok(voiceSrc.includes('ctx.sources'), 'voice instructions consume the same ctx.sources');
    n++;
    const portalSrc = read('public/js/portal.js');
    assert.ok(portalSrc.includes('Knowledge sources'), 'portal panel has the Knowledge sources section');
    n++;
    assert.ok(portalSrc.includes('data-ks-module') && portalSrc.includes('data-ks-page') && portalSrc.includes('data-ks-doc'), 'panel rows carry the three toggle kinds');
    n++;
    const cfgStart = botSrc.indexOf('function getPublicConfigByToken');
    const cfgBody = botSrc.slice(cfgStart, cfgStart + 6000);
    assert.ok(!cfgBody.includes('knowledge_sources'), 'public widget config never serializes the toggles');
    n++;
    group('part1 source pins', n);
  }

  /* ================================================================== */
  /* Fixtures — a plant shop (lead A), an untouched legacy lead (B),   */
  /* and a cap-stress lead (C).                                       */
  /* ================================================================== */
  const platformDb = require(path.join(root, 'server/db.js'));
  await platformDb.migrate();
  const workspace = require(path.join(root, 'server/workspace.js'));
  const { openWorkspaceDb } = require(path.join(root, 'server/workspaceDb.js'));
  const sm = require(path.join(root, 'server/siteModules.js'));
  const pricing = require(path.join(root, 'server/pricing.js'));
  const chatbot = require(path.join(root, 'server/chatbot.js'));
  const voice = require(path.join(root, 'server/chatbotVoice.js'));

  const PW = ['batch151', 'fixture', 'password'].join('-');
  const a = await workspace.createUserWithWorkspace({
    email: 'a151@example.invalid',
    password: PW,
    name: 'A151',
    workspaceName: 'Batch151 WS',
  });
  const WS_ID = Number(a.workspaceId);
  const db = openWorkspaceDb(WS_ID);
  sm.ensureTables(db);
  pricing.ensureTables(db);
  chatbot.ensureTables(db);
  for (const [id, name, email] of [
    [LEAD_A, 'Verdant Corner Plants', 'verdant151@example.invalid'],
    [LEAD_B, 'Legacy Ferns Co', 'legacy151@example.invalid'],
    [LEAD_C, 'Cap Stress Nursery', 'cap151@example.invalid'],
  ]) {
    db.prepare('INSERT INTO leads (id, business_name, email, status) VALUES (?, ?, ?, ?)').run(
      id,
      name,
      email,
      'customer'
    );
  }

  // Lead A — shop products (one variant "From" product, one plain).
  sm.createProduct(db, LEAD_A, {
    name: 'Monstera Deliciosa',
    description:
      'Our most popular houseplant — the classic indoor plant people ask about when they want types of plants that thrive in bright homes.',
    price: 58,
    status: 'published',
    options: [{ name: 'Pot', values: ['Nursery Pot', 'EcoPot'] }],
    variants: [{ values: ['EcoPot'], price_cents: 6800 }],
  });
  sm.createProduct(db, LEAD_A, {
    name: 'Golden Pothos',
    description: 'A trailing vine, easy for beginners.',
    price: 24,
    status: 'published',
  });
  sm.createBookingService(db, LEAD_A, {
    name: 'Plant Care Consult',
    description: 'Thirty minutes with our plant specialist.',
    price: 45,
    duration_minutes: 30,
    status: 'published',
  });
  sm.createFaqItem(db, LEAD_A, {
    question: 'Do you deliver plants locally?',
    answer: 'Yes — we deliver within 15 miles of the shop for a flat $6 fee.',
    status: 'published',
  });
  sm.createBlogPost(db, LEAD_A, {
    title: 'Caring for your Monstera in winter',
    body_html: '<p>Winter light is weak, so move your monstera closer to the window and water less often.</p>',
    status: 'published',
  });
  pricing.createPricingEntry(db, LEAD_A, {
    name: 'Repotting Service',
    price_cents: 2500,
    status: 'published',
    sort_order: 1,
  });
  const kbWater = chatbot.addKnowledge(db, LEAD_A, {
    kind: 'doc',
    title: 'Watering guide',
    content_text: 'Water your ZZ plant every three weeks. Let the soil dry fully between waterings.',
  });
  const kbReturns = chatbot.addKnowledge(db, LEAD_A, {
    kind: 'doc',
    title: 'Returns policy',
    content_text: 'Returns within 30 days with a receipt qualify for a full refund.',
  });
  db.prepare('INSERT INTO websites (lead_id, name, theme, pages, status) VALUES (?, ?, ?, ?, ?)').run(
    LEAD_A,
    'Verdant Corner Plants',
    '{}',
    JSON.stringify([
      {
        slug: 'home',
        title: 'Home',
        sections: [
          { type: 'nav', content: { brand: 'Verdant Corner' } },
          {
            type: 'hero',
            content: {
              headline: 'Verdant Corner — plants for bright homes',
              subheadline: 'Shop indoor plants, pots and care.',
            },
          },
          { type: 'footer', content: { note: 'Footer chrome text ZULUFOOT' } },
        ],
      },
      {
        slug: 'plant-care',
        title: 'Plant Care',
        sections: [
          {
            type: 'services',
            content: { title: 'Plant care basics', items: ['Mist leaves weekly', 'Rotate pots toward the light'] },
          },
        ],
      },
      {
        slug: 'checkout',
        title: 'Checkout',
        sections: [{ type: 'html', content: { html: '<p>Checkout shell token ZXQW</p>' } }],
      },
    ]),
    'published'
  );
  const embA = sm.ensureEmbed(db, LEAD_A, 'chatbot', { workspaceId: WS_ID });
  db.prepare('UPDATE site_module_embeds SET published = 1 WHERE id = ?').run(embA.id);
  const TOKEN_A = embA.public_token;

  // Lead B — one product, and a settings row will be hand-aged below.
  sm.createProduct(db, LEAD_B, { name: 'Beta Fern', description: 'A hardy fern.', price: 18, status: 'published' });
  // Lead C — fifteen products with fat descriptions for the cap check.
  for (let i = 1; i <= 15; i++) {
    sm.createProduct(db, LEAD_C, {
      name: `Cap Plant ${String(i).padStart(2, '0')}`,
      description: 'x'.repeat(300),
      price: 10 + i,
      status: 'published',
    });
  }

  /* ================================================================== */
  /* Part 2 — defaults all-on (no settings ever saved for lead A)      */
  /* ================================================================== */
  {
    let n = 0;
    assert.equal(chatbot.getSettings(db, LEAD_A).knowledge_sources, null, 'unsaved settings read as null (all-on)');
    n++;
    const ctx = chatbot.buildAssistantContext(db, LEAD_A, { query: 'what type of plants do you sell' });
    const src = ctx.sources.text;
    assert.ok(src.includes('From the shop:'), 'shop digest is labelled by source');
    n++;
    assert.ok(src.includes('Monstera Deliciosa'), 'variant product name reaches the context (the Victoria case)');
    n++;
    assert.ok(src.includes('From $58.00'), 'the honest "From" display price reaches the context');
    n++;
    assert.ok(src.includes('Golden Pothos'), 'plain product reaches the context');
    n++;
    const shopBlock = ctx.sources.blocks.find((b) => b.key === 'module:ecommerce');
    assert.ok(shopBlock, 'ecommerce block present');
    n++;
    assert.ok(
      shopBlock.text.split('\n')[1].includes('Monstera Deliciosa'),
      'the plants query scores the Monstera line to the top of the shop digest'
    );
    n++;
    assert.equal(ctx.sources.blocks[0].key, 'module:ecommerce', 'the plants query scores the product digest to the top');
    n++;
    assert.ok(src.includes('Plant Care Consult') && src.includes('30 min'), 'booking service + duration reach the context');
    n++;
    assert.ok(src.includes('Do you deliver plants locally?'), 'FAQ pair reaches the context');
    n++;
    assert.ok(src.includes('Caring for your Monstera in winter'), 'blog title reaches the context');
    n++;
    assert.ok(ctx.sources.includesPricing, 'price book rides the sources assembly by default');
    n++;
    assert.ok(src.includes('Repotting Service') && src.includes('$25.00'), 'price book figures reach the context');
    n++;
    assert.ok(src.includes('Plant care basics') && src.includes('Mist leaves weekly'), 'page text reaches the context');
    n++;
    assert.ok(src.includes('plants for bright homes'), 'home page text reaches the context');
    n++;
    assert.ok(!src.includes('ZXQW'), 'the checkout shell page is never a source');
    n++;
    assert.ok(!src.includes('ZULUFOOT'), 'footer chrome is never a source');
    n++;
    assert.ok(ctx.knowledge.count >= 2, 'both KB docs present by default');
    n++;
    assert.ok(ctx.knowledge.text.includes('ZZ plant'), 'KB doc 1 snippets present');
    n++;
    assert.ok(ctx.knowledge.text.includes('Returns within 30 days'), 'KB doc 2 snippets present');
    n++;
    assert.ok(chatbot.priceBookFor(db, LEAD_A), 'priceBookFor still serves the book (Batch 139 seam intact)');
    n++;
    group('part2 defaults all-on', n);
  }

  /* ================================================================== */
  /* Part 3 — toggles (through the REAL settings save path)            */
  /* ================================================================== */
  const save = (patch) => chatbot.saveSettings(db, LEAD_A, patch);
  {
    let n = 0;
    // Module off: the shop digest leaves, everything else stays.
    save({ knowledge_sources: { groups: {}, modules: { ecommerce: false }, pages: {}, knowledge: {} } });
    let ctx = chatbot.buildAssistantContext(db, LEAD_A, { query: 'what type of plants do you sell' });
    assert.ok(!ctx.sources.text.includes('Monstera Deliciosa'), 'ecommerce off → product digest gone');
    n++;
    assert.ok(ctx.sources.text.includes('Plant Care Consult'), 'ecommerce off → bookings digest stays');
    n++;
    assert.ok(ctx.sources.text.includes('Plant care basics'), 'ecommerce off → page digest stays');
    n++;
    assert.ok(ctx.knowledge.text.includes('ZZ plant'), 'ecommerce off → KB stays');
    n++;
    // Page off: that page's text leaves, the other page stays.
    save({ knowledge_sources: { groups: {}, modules: {}, pages: { 'plant-care': false }, knowledge: {} } });
    ctx = chatbot.buildAssistantContext(db, LEAD_A, { query: '' });
    assert.ok(!ctx.sources.text.includes('Mist leaves weekly'), 'page off → its text gone');
    n++;
    assert.ok(ctx.sources.text.includes('plants for bright homes'), 'page off → other pages stay');
    n++;
    assert.ok(ctx.sources.text.includes('Monstera Deliciosa'), 'page off → module digests stay');
    n++;
    // KB doc off: that doc's snippets leave, the other doc stays.
    save({ knowledge_sources: { groups: {}, modules: {}, pages: {}, knowledge: { [String(kbReturns.id)]: false } } });
    ctx = chatbot.buildAssistantContext(db, LEAD_A, { query: 'returns refund' });
    assert.ok(!ctx.knowledge.text.includes('Returns within 30 days'), 'KB doc off → its snippets gone');
    n++;
    assert.ok(ctx.knowledge.text.includes('ZZ plant'), 'KB doc off → other docs stay');
    n++;
    // KB group off: empty knowledge, handled gracefully everywhere.
    save({ knowledge_sources: { groups: { knowledge: false }, modules: {}, pages: {}, knowledge: {} } });
    ctx = chatbot.buildAssistantContext(db, LEAD_A, { query: 'hi' });
    assert.equal(ctx.knowledge.count, 0, 'KB group off → zero knowledge');
    n++;
    assert.equal(ctx.knowledge.text, '', 'KB group off → empty knowledge text, no crash');
    n++;
    assert.ok(ctx.sources.text.includes('Monstera Deliciosa'), 'KB group off → module digests still brief the agent');
    n++;
    const voiceOff = voice.buildVoiceInstructions(db, LEAD_A);
    assert.ok(voiceOff.includes('(no knowledge files uploaded yet)'), 'KB group off → voice still builds its instructions');
    n++;
    assert.ok(voiceOff.includes('capture_lead') && voiceOff.includes('escalate_to_team'), 'KB group off → greet/capture/escalate guidance intact');
    n++;
    // Pricing off alone: the book leaves every surface at one gate.
    save({ knowledge_sources: { groups: {}, modules: { pricing: false }, pages: {}, knowledge: {} } });
    assert.equal(chatbot.priceBookFor(db, LEAD_A), null, 'pricing off → priceBookFor null (139 seam gated)');
    n++;
    ctx = chatbot.buildAssistantContext(db, LEAD_A, { query: '' });
    assert.ok(!ctx.sources.includesPricing && !ctx.sources.text.includes('Repotting Service'), 'pricing off → book out of the digests');
    n++;
    assert.ok(ctx.sources.text.includes('Monstera Deliciosa'), 'pricing off → other modules stay');
    n++;
    const pubOff = chatbot.getPublicConfigByToken(db, TOKEN_A);
    assert.equal(pubOff.price_book, null, 'pricing off → public config carries no price book');
    n++;
    // Modules group off: digests AND the book leave; pages + KB stay.
    save({ knowledge_sources: { groups: { modules: false }, modules: {}, pages: {}, knowledge: {} } });
    ctx = chatbot.buildAssistantContext(db, LEAD_A, { query: '' });
    assert.ok(!ctx.sources.text.includes('From the shop:'), 'modules group off → no module digests');
    n++;
    assert.equal(chatbot.priceBookFor(db, LEAD_A), null, 'modules group off → price book gated too');
    n++;
    assert.ok(ctx.sources.text.includes('Plant care basics'), 'modules group off → pages stay');
    n++;
    assert.ok(ctx.knowledge.count >= 2, 'modules group off → KB stays');
    n++;
    // Back to all-on for the remaining parts.
    save({ knowledge_sources: { groups: {}, modules: {}, pages: {}, knowledge: {} } });
    group('part3 toggles', n);
  }

  /* ================================================================== */
  /* Part 4 — one brain, public fence, legacy rows, validation         */
  /* ================================================================== */
  {
    let n = 0;
    // Voice parity: the same digests ride the voice instructions.
    const vi = voice.buildVoiceInstructions(db, LEAD_A);
    assert.ok(vi.includes('Monstera Deliciosa'), 'voice instructions carry the shop digest');
    n++;
    assert.ok(vi.includes('Repotting Service') && vi.includes('$25.00'), 'voice instructions carry the price book');
    n++;
    assert.ok(vi.includes('Plant care basics'), 'voice instructions carry the page digest');
    n++;
    // Public fence: no toggle data anywhere in the widget config.
    const pub = chatbot.getPublicConfigByToken(db, TOKEN_A);
    assert.ok(pub.price_book && pub.price_book.text.includes('$25.00'), 'public config still serves the book by default');
    n++;
    assert.ok(!JSON.stringify(pub).includes('knowledge_sources'), 'public config JSON has no knowledge_sources');
    n++;
    assert.ok(!('knowledge_sources' in pub.settings), 'public settings subset has no knowledge_sources key');
    n++;
    // Legacy row: age lead B's settings row by hand — settings_json
    // with NO knowledge_sources key at all — and the site still
    // briefs all-on.
    chatbot.saveSettings(db, LEAD_B, { greeting: 'Hello from Legacy Ferns' });
    db.prepare("UPDATE chatbot_settings SET settings_json = ? WHERE lead_id = ?").run(
      JSON.stringify({ some_legacy_flag: true }),
      LEAD_B
    );
    assert.equal(chatbot.getSettings(db, LEAD_B).knowledge_sources, null, 'legacy row parses to null selection');
    n++;
    const ctxB = chatbot.buildAssistantContext(db, LEAD_B, { query: 'what ferns do you sell' });
    assert.ok(ctxB.sources.text.includes('Beta Fern'), 'legacy row behaves all-on (product digest present)');
    n++;
    // Save validation: unknown module type refused, row untouched.
    const before = chatbot.getSettings(db, LEAD_A).knowledge_sources;
    assert.throws(
      () => save({ knowledge_sources: { modules: { not_a_module: false } } }),
      /Unknown module type/,
      'unknown module type refused'
    );
    n++;
    assert.deepEqual(chatbot.getSettings(db, LEAD_A).knowledge_sources, before, 'refused save leaves the row untouched');
    n++;
    // Dead slugs / ids are dropped safely, never corrupting the row.
    save({
      knowledge_sources: {
        groups: {},
        modules: {},
        pages: { 'no-such-page': false, 'plant-care': true },
        knowledge: { '999999': false, [String(kbWater.id)]: true },
      },
    });
    const stored = chatbot.getSettings(db, LEAD_A).knowledge_sources;
    assert.ok(stored && !('no-such-page' in (stored.pages || {})), 'dead page slug dropped on save');
    n++;
    assert.ok(stored && !('999999' in (stored.knowledge || {})), 'dead KB id dropped on save');
    n++;
    assert.equal(stored.pages['plant-care'], true, 'live page toggle kept');
    n++;
    save({ knowledge_sources: { groups: {}, modules: {}, pages: {}, knowledge: {} } });
    // Portal summary: every selectable source with counts + state.
    const summary = chatbot.portalChatbotSummary(db, LEAD_A);
    const ks = summary.knowledge_sources;
    assert.ok(ks, 'portal summary carries knowledge_sources');
    n++;
    const shopRow = ks.modules.find((m) => m.type === 'ecommerce');
    assert.ok(shopRow && shopRow.count === 2 && shopRow.enabled === true, 'summary lists the shop with its live count, on');
    n++;
    assert.ok(ks.pages.some((p) => p.slug === 'plant-care'), 'summary lists the pages');
    n++;
    assert.ok(!ks.pages.some((p) => p.slug === 'checkout'), 'summary never lists the checkout shell');
    n++;
    assert.equal(ks.knowledge.length, 2, 'summary lists both KB docs');
    n++;
    save({ knowledge_sources: { groups: {}, modules: { faq: false }, pages: {}, knowledge: {} } });
    const ks2 = chatbot.portalChatbotSummary(db, LEAD_A).knowledge_sources;
    assert.equal(ks2.modules.find((m) => m.type === 'faq').enabled, false, 'summary reflects a saved toggle');
    n++;
    save({ knowledge_sources: { groups: {}, modules: {}, pages: {}, knowledge: {} } });
    // The 137 discipline is untouched: qualifying still round-trips.
    save({ qualifying_enabled: true, qualifying_questions: ['Is this for a home or a rental?'] });
    assert.deepEqual(
      chatbot.getSettings(db, LEAD_A).qualifying_questions,
      ['Is this for a home or a rental?'],
      'qualifying questions unaffected by the knowledge-sources work'
    );
    n++;
    group('part4 one brain + fences', n);
  }

  /* ================================================================== */
  /* Part 5 — caps                                                     */
  /* ================================================================== */
  {
    let n = 0;
    const ctxC = chatbot.buildAssistantContext(db, LEAD_C, { query: '' });
    const shop = ctxC.sources.blocks.find((b) => b.key === 'module:ecommerce');
    assert.ok(shop, 'cap lead has a shop block');
    n++;
    const lines = shop.text.split('\n').slice(1).filter(Boolean);
    assert.ok(lines.length <= 10, `per-module item cap holds (${lines.length} <= 10)`);
    n++;
    assert.ok(shop.text.length <= 2400 + 64, `per-module char cap holds (${shop.text.length})`);
    n++;
    assert.ok(ctxC.sources.text.length <= 9000 + 6000, 'total digest stays inside the combined budget');
    n++;
    group('part5 caps', n);
  }

  /* ================================================================== */
  /* Part 6 — finisher fence ruling: clientMcp honours the toggles;   */
  /* the portal inbox preview (listPendingSessions) keeps all-docs.   */
  /* ================================================================== */
  {
    let n = 0;
    const clientMcp = require(path.join(root, 'server/clientMcp.js'));
    const cmSrc = read('server/clientMcp.js');
    assert.ok(cmSrc.includes('knowledgeIncludeIds'), 'clientMcp routes its KB reads through the filtered path');
    n++;
    // The shared diet helper itself: all-on carries both docs.
    let ids = chatbot.knowledgeIncludeIds(db, LEAD_A);
    assert.ok(ids.has(Number(kbWater.id)) && ids.has(Number(kbReturns.id)), 'all-on → includeIds carries both docs');
    n++;
    save({ knowledge_sources: { groups: {}, modules: {}, pages: {}, knowledge: { [String(kbReturns.id)]: false } } });
    ids = chatbot.knowledgeIncludeIds(db, LEAD_A);
    assert.ok(ids.has(Number(kbWater.id)) && !ids.has(Number(kbReturns.id)), 'doc off → includeIds drops exactly that doc');
    n++;
    save({ knowledge_sources: { groups: { knowledge: false }, modules: {}, pages: {}, knowledge: {} } });
    assert.equal(chatbot.knowledgeIncludeIds(db, LEAD_A).size, 0, 'KB group off → includeIds empty');
    n++;
    save({ knowledge_sources: { groups: {}, modules: {}, pages: {}, knowledge: { [String(kbReturns.id)]: false } } });
    // The fence: the portal inbox preview keeps all-docs even with a
    // doc toggled off — the owner sees everything.
    const pending = chatbot.listPendingSessions(db, LEAD_A, { limit: 1 });
    assert.ok(pending.knowledge.text.includes('Returns within 30 days'), 'inbox preview keeps all-docs with a doc off');
    n++;
    // The real client MCP dispatch, on a paid-plan fixture owner:
    // knowledge.list honours the toggle in BOTH items and snippets.
    await platformDb.query("UPDATE users SET subscription_status = 'active', billing_plan = 'standard' WHERE id = :id", {
      id: a.userId,
    });
    const listedOff = await clientMcp.dispatchPortalTool(
      WS_ID,
      'chatbot.knowledge.list',
      { leadId: LEAD_A },
      { clientEmail: 'a151@example.invalid' }
    );
    assert.ok(
      !listedOff.items.some((it) => Number(it.id) === Number(kbReturns.id)),
      'clientMcp knowledge.list items exclude the OFF doc'
    );
    n++;
    assert.ok(!listedOff.snippets.text.includes('Returns within 30 days'), 'clientMcp knowledge.list snippets exclude the OFF doc');
    n++;
    assert.ok(listedOff.items.some((it) => Number(it.id) === Number(kbWater.id)), 'clientMcp knowledge.list keeps the ON doc');
    n++;
    save({ knowledge_sources: { groups: {}, modules: {}, pages: {}, knowledge: {} } });
    const listedOn = await clientMcp.dispatchPortalTool(
      WS_ID,
      'chatbot.knowledge.list',
      { leadId: LEAD_A },
      { clientEmail: 'a151@example.invalid' }
    );
    assert.ok(listedOn.items.some((it) => Number(it.id) === Number(kbReturns.id)), 'toggle back on → clientMcp sees the doc again');
    n++;
    group('part6 clientMcp fence', n);
  }

  console.log(`\nBATCH151 OK — ${groups.length} groups: ${groups.join(' · ')}`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
