'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = process.env.BITPYPE_TEST_ROOT || path.resolve(__dirname, '..');
let Database;
try { Database = require('better-sqlite3'); } catch { Database = require('node:sqlite').DatabaseSync; }
const db = new Database(':memory:');
const contacts = require(path.join(root, 'server/portalContacts.js'));
const portalTabs = require(path.join(root, 'server/portalTabs.js'));
const apiErrors = require(path.join(root, 'server/apiErrors.js')); // Batch 54: route files require it; VM mocks hand them the real module
const managedScripts = require(path.join(root, 'src/managedScripts.js')); // Batch 149: the managed-script ensures in siteModules/chatbot/contactForms delegate to this shared leaf; VM loads get the real module (same pattern as apiErrors)
const results = [];
function check(name, fn) { fn(); results.push(name); }
// Batch 76: the missed-call rescue engine is required (lazily) by
// routes/calls.js and clientPortal.js; VM loads get an inert stub —
// the engine itself is pinned by batch76's own regression file.
const callRescueStub = {
  getRescueConfig: () => ({ enabled: false, reply_window_minutes: 10, quiet_start: '21:00', quiet_end: '08:00' }),
  setRescueConfig: () => ({ enabled: false }),
  maybeCreateRescue: async () => ({ created: false, reason: 'stubbed' }),
  handleInboundSms: async () => ({ handled: false }),
  handleVoiceInput: async () => '<Response/>',
};
// Batch 121: routes/portal.js requires the set-password engine at
// load time; VM loads get an inert stub — the engine itself is
// pinned by the batch121 regression file.
const portalPasswordStub = {
  requestForUser: async () => ({ ok: true }),
  requestByEmail: async () => ({ ok: true }),
  confirmPasswordSet: async () => ({ ok: true }),
};
// Batch 111: clientPortal.js / museAgent.js are facades over split
// modules; VM loads resolve those siblings through the same loader +
// mocks (single-instance cache per top-level load, as Node would).
const SPLIT_MODULES = new Set([
  'portalAccounts', 'portalShared', 'portalSiteEdits', 'portalSocial', 'portalForms',
  'portalModules', 'portalBilling', 'portalLeadScout', 'portalSiteChat',
  'museAgentTools', 'museAgentCore', 'museAgentClassifier', 'museAgentPlanner',
  // Batch 120: museAgentCore requires the provider-routing registry;
  // it only lazily requires ./platform (mocked at every load site).
  'aiRouting',
  // Batch 143: portalAccounts requires ./rateLimitStore (the portal
  // access-email throttle moved to the durable Batch 55 store).
  'rateLimitStore',
  // Batch 145 (F17): the shared Stripe invoice-shape helper joins the
  // graph — a dependency-free leaf required by paymentsConfig et al.
  'stripeShapes',
  // Batch 145 (F14): siteModules' availability math lazily requires
  // ./siteChatUsage for its IANA timezone validator — also a
  // dependency-free leaf.
  'siteChatUsage',
  'paymentsConfig', // Batch 129: the unified payments config joins the stubbed module graph
  // Batch 129: paymentsConfig lazily requires ./siteModules (the cycle
  // pattern); routing it through inner() returns the load's own root
  // instance from the cache, exactly as Node would.
  'siteModules',
]);
function load(file, mocks) {
  const cache = new Map();
  const inner = (f) => {
    if (cache.has(f)) return cache.get(f);
    const module = { exports: {} };
    cache.set(f, module.exports);
    vm.runInNewContext(fs.readFileSync(path.join(root, f), 'utf8'), {
      module, exports: module.exports, require: name => {
        if (Object.hasOwn(mocks, name)) return mocks[name];
        // Batch 54: route files require the shared error shaper; it is a
        // dependency-free leaf, so VM loads get the real module.
        if (name === '../apiErrors') return apiErrors;
        if (name === '../src/managedScripts') return managedScripts; // Batch 149 (see above)
        if (name === '../callRescue' || name === './callRescue') return callRescueStub;
        if (!name.startsWith('.')) return require(name);
        if (SPLIT_MODULES.has(path.basename(name))) return inner('server/' + path.basename(name) + '.js');
        throw new Error('Unexpected dependency: ' + name);
      }, process: { env: {} }, console, Buffer, URL, Date, setTimeout, clearTimeout,
    }, { filename: f });
    cache.set(f, module.exports);
    return module.exports;
  };
  return inner(file);
}
function capture(leadId, submissionId, payload) {
  const r = contacts.captureFromSubmission(db, { leadId, submissionId, formId: leadId, formName: 'Fixture', payload });
  assert.equal(r.error, undefined);
  return Number(r.contact.id);
}
async function main() {
  const shared = capture(1, 1, {name:'Client One Name',email:'shared@example.invalid',phone:'1112223333',private_note:'ONE ONLY'});
  assert.equal(capture(2, 2, {name:'Client Two Name',email:'shared@example.invalid',phone:'9998887777',private_note:'TWO ONLY'}),shared);
  const foreign = capture(2, 3, {name:'Unrelated Person',email:'foreign@example.invalid'});
  check('scoped list excludes foreign contacts, identity and aggregates',()=>{
    const rows=contacts.listContacts(db,{leadId:1}); assert.equal(rows.length,1);
    assert.equal(rows[0].name,'Client One Name'); assert.equal(rows[0].phone,'1112223333'); assert.equal(rows[0].event_count,1);
    assert(!JSON.stringify(rows).includes('Client Two'));
  });
  check('scoped detail rejects guessed foreign IDs and excludes foreign events',()=>{
    assert.throws(()=>contacts.getContact(db,foreign,{leadId:1}),e=>e.code==='NOT_FOUND');
    const detail=contacts.getContact(db,shared,{leadId:1});
    assert.equal(detail.events.length,1); assert.equal(detail.contact.name,'Client One Name');
    assert(!JSON.stringify(detail).includes('TWO ONLY'));
  });
  check('invalid scope fails closed while explicit internal workspace views remain available',()=>{
    assert.throws(()=>contacts.listContacts(db,{leadId:0}),e=>e.code==='FORBIDDEN');
    assert.equal(contacts.listContacts(db).length,2);
  });
  db.prepare('UPDATE leadscout_events SET created_at = ? WHERE lead_id = ?').run('2099-01-01 00:00:00',2);
  check('other business timestamps are excluded',()=>assert(!JSON.stringify(contacts.listContacts(db,{leadId:1})).includes('2099')));
  const failure=db.prepare('INSERT INTO leadscout_capture_failures(kind,lead_id,error,payload_json) VALUES (?,?,?,?)');
  failure.run('synthetic',1,'one failure','{}');failure.run('synthetic',2,'two failure','{"private":"TWO"}');
  check('health and retries operate only on caller business',()=>{
    const health=contacts.captureHealth(db,{leadId:1});assert.equal(health.open_failures,1);assert.equal(health.failures[0].lead_id,1);
    const r=contacts.retryOpenFailures(db,{leadId:1});assert.equal(r.tried,1);assert.equal(r.health.open_failures,1);
    assert.equal(db.prepare('SELECT retries FROM leadscout_capture_failures WHERE lead_id = ?').get(2).retries,0);
  });
  db.prepare('UPDATE leadscout_events SET payload_json = ? WHERE lead_id = ?').run('corrupt snapshot',1);
  check('corrupt snapshots do not fall back to shared foreign identity',()=>{
    assert.equal(contacts.listContacts(db,{leadId:1})[0].name,'');
    assert.equal(contacts.getContact(db,shared,{leadId:1}).contact.phone,'');
  });
  const portal=load('server/clientPortal.js',{
    bcryptjs:{hashSync:()=> 'fixture'},'./db':{},'./mailer':{},'./stripeClient':{},'./workspaceDb':{},
    './domain':{withDb:(_ws,fn)=>fn(db)},'./portalContacts':contacts,'./portalTabs':portalTabs,
  });
  check('portal wrappers ignore allSites and reject missing scope',()=>{
    assert.equal(portal.listLeadScoutContacts(1,1,{allSites:true}).length,1);
    assert.throws(()=>portal.listLeadScoutContacts(1,null,{allSites:true}),e=>e.code==='FORBIDDEN');
    assert.throws(()=>portal.getLeadScoutContact(1,1,foreign),e=>e.code==='NOT_FOUND');
    assert.equal(portal.leadScoutHealth(1,1).open_failures,1);
  });
  const mcp=load('server/clientMcp.js',{
    './domain':{},'./clientPortal':{...portal,activeEmailForLead:async()=> 'fixture@example.invalid'},
    './billing':{effectivePlan:async()=> 'premium'},'./plans':{getPlan:()=>({entitlements:{}})},
  });
  const cl=await mcp.dispatchPortalTool(1,'leadscout.contacts.list',{allSites:true},{leadId:1});
  assert.equal(cl.contacts.length,1); assert.equal(cl.health.open_failures,1);
  await assert.rejects(mcp.dispatchPortalTool(1,'leadscout.contacts.get',{id:foreign},{leadId:1}),e=>e.code==='NOT_FOUND');
  const ws=await mcp.dispatchPortalTool(1,'leadscout.contacts.list',{allSites:true},{});
  assert.equal(ws.contacts.length,2);assert.equal(ws.health.open_failures,2);
  results.push('MCP client tokens remain pinned; explicit workspace token views are preserved');
  const portalRoutes=[];
  const portalRouter={use(){}};
  for(const method of ['get','post','put','patch','delete'])portalRouter[method]=(route,...handlers)=>portalRoutes.push({method,route,handlers});
  load('server/routes/portal.js',{
    express:{Router:()=>portalRouter},'../clientPortal':{...portal,findById:async()=>({id:1,status:'active',workspace_id:1,lead_id:1})},
    '../captcha':{requireCaptcha:()=>((_req,_res,next)=>next())},'../rateLimit':{rateLimit:()=>((_req,_res,next)=>next())},'../portalTabs':portalTabs,
    '../mfa':{isEnabled:async()=>false},'../apiErrors':apiErrors,'../portalPassword':portalPasswordStub,
  });
  async function callPortal(method,url,query={},params={}){
    const route=portalRoutes.find(x=>x.method===method&&x.route===url);assert(route,url);
    const req={session:{clientPortalId:1,clientLastActiveAt:Date.now()},query,params,app:{locals:{}}};
    let status=200,body;const res={status(v){status=v;return this},json(v){body=v;return this}};
    for(const handler of route.handlers){let advanced=false;await handler(req,res,()=>{advanced=true});if(!advanced)break;}
    return {status,body};
  }
  assert.equal((await callPortal('get','/leadscout/contacts',{allSites:'1'})).body.data.contacts.length,1);
  assert.equal((await callPortal('get','/leadscout/contacts/:id',{}, {id:String(foreign)})).status,404);
  assert.equal((await callPortal('get','/leadscout/health')).body.data.open_failures,1);
  assert.equal((await callPortal('post','/leadscout/retry')).body.data.tried,1);
  assert.equal(db.prepare('SELECT retries FROM leadscout_capture_failures WHERE lead_id = ?').get(2).retries,0);
  results.push('real portal route handlers ignore allSites, reject foreign detail, scope health and retries');
  const middleware=load('server/middleware.js',{'./workspace':{}});
  const registrations=[],uses=[];
  const router={use(...h){uses.push(...h)}};
  for(const method of ['get','post','patch','delete'])router[method]=(route,...handlers)=>registrations.push({method,route,handlers});
  let jobCalls=0;
  const jobs=new Proxy({}, {get:()=>async()=>{jobCalls++;return {ok:true}}});
  load('server/routes/jobs.js',{
    express:{Router:()=>router},'../jobs':jobs,'../db':{query:async()=>{jobCalls++;return []}},
    '../middleware':{...middleware,requireWorkspace:(_req,_res,next)=>next()},'../apiErrors':apiErrors,
  });
  async function call(route,auth){
    const req={auth,params:{id:'1'},body:{}};let status=200,body;
    const res={status(v){status=v;return this},json(v){body=v;return this}};
    for(const handler of [...uses,...route.handlers]){
      let advanced=false;await handler(req,res,()=>{advanced=true});
      if(!advanced)break;
    }
    return {status,body};
  }
  for(const route of registrations){
    const before=jobCalls;const r=await call(route,{via:'token',role:'token',leadId:1,workspaceId:1});
    assert.equal(r.status,403,route.method+' '+route.route);assert.equal(jobCalls,before);
  }
  results.push('all job endpoints reject client tokens before queries or execution');
  const run=registrations.find(x=>x.method==='post'&&x.route==='/:id/run');
  assert.equal((await call(run,{via:'session',role:'member',workspaceId:1})).status,403);
  assert.equal((await call(run,{via:'session',role:'owner',workspaceId:1})).status,200);
  assert.equal((await call(run,{via:'token',role:'token',leadId:null,workspaceId:1})).status,200);
  results.push('forced execution allows owners and workspace service tokens; denies ordinary members');
  // --- AdSense gating matrix (Batch 9): free-plan only, idempotent, stripping ---
  const adsense = require(path.join(root, 'server/adsense.js'));
  const PUB = 'ca-pub-1234567890123456';
  const docHtml = '<!DOCTYPE html><html><head><title>T</title></head><body><main>Hi</main><footer>F</footer></body></html>';
  const adsOn = adsense.buildConfig({ enabled: '1', publisherId: PUB, slotId: '1234567890', plan: 'free' });
  assert.equal(adsOn.active, true);
  const withAds = adsense.applyToHtml(docHtml, adsOn);
  assert.ok(withAds.includes('adsbygoogle.js?client=' + PUB), 'adsense loader script injected');
  assert.ok(withAds.includes('data-ad-slot="1234567890"'), 'adsense unit injected');
  assert.ok(withAds.indexOf('data-bitpype-adsense') < withAds.indexOf('<footer'), 'unit lands before footer');
  assert.equal(adsense.applyToHtml(withAds, adsOn), withAds, 'adsense injection is idempotent');
  for (const plan of ['standard', 'pro', 'premium']) {
    const paidCfg = adsense.buildConfig({ enabled: '1', publisherId: PUB, slotId: '1234567890', plan });
    assert.equal(paidCfg.active, false, plan + ' never gets ads');
    assert.equal(adsense.applyToHtml(withAds, paidCfg), docHtml, plan + ' strips existing ads');
  }
  assert.equal(adsense.buildConfig({ enabled: '0', publisherId: PUB, plan: 'free' }).active, false);
  assert.equal(adsense.buildConfig({ enabled: '1', publisherId: '', plan: 'free' }).active, false);
  assert.equal(adsense.buildConfig({ enabled: '1', publisherId: 'not-a-pub-id', plan: 'free' }).active, false);
  assert.equal(adsense.applyToHtml(docHtml, adsense.buildConfig({ enabled: '0', publisherId: PUB, plan: 'free' })), docHtml);
  const autoOnly = adsense.applyToHtml(docHtml, adsense.buildConfig({ enabled: '1', publisherId: PUB, slotId: '', plan: 'free' }));
  assert.ok(autoOnly.includes('adsbygoogle.js?client=' + PUB) && !autoOnly.includes('<ins class="adsbygoogle"'), 'blank slot = Auto Ads script only');
  results.push('adsense gate: free-only matrix, idempotent inject, strip on paid/disabled, auto-ads without slot');

  // --- Change-request history (Batch 11): record-on-submit, scoping, derived status ---
  db.exec(fs.readFileSync(path.join(root, 'src/schema.sql'), 'utf8'));
  const designJobs = require(path.join(root, 'src/designJobs.js'));
  designJobs.ensureTables(db);
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='change_requests'").get(), 'change_requests table exists');
  db.prepare("INSERT INTO leads (id, business_name, email) VALUES (101, 'Fixture One', 'one@example.invalid')").run();
  db.prepare("INSERT INTO leads (id, business_name, email) VALUES (102, 'Fixture Two', 'two@example.invalid')").run();
  const crJob = designJobs.createJob(db, { leadId: 101, type: 'website', title: 'Fixture One website', instructions: 'Build a site.', contactEmail: 'one@example.invalid' });
  const crToken = designJobs.ensureClientFormToken(db, crJob.id);
  await designJobs.submitClientForm(db, crToken, { message: 'Soften the hero headline.', kind: 'improvements', email: 'one@example.invalid', answers: {} });
  await designJobs.submitClientForm(db, crToken, { message: 'Redo the whole homepage.', kind: 'redesign', email: 'one@example.invalid', answers: {} });
  const crRows = db.prepare('SELECT * FROM change_requests ORDER BY id').all();
  assert.equal(crRows.length, 2, 'every change submission writes a discrete record, merge path included');
  assert.equal(crRows[0].job_id, crJob.id); assert.equal(crRows[0].requester_email, 'one@example.invalid');
  const qRow = db.prepare('INSERT INTO design_questions (job_id, question) VALUES (?, ?)').run(crJob.id, 'What color?');
  await designJobs.submitClientForm(db, crToken, { email: 'one@example.invalid', answers: { [qRow.lastInsertRowid]: 'Blue' } });
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM change_requests').get().c, 2, 'answers-only submissions write no history record');
  check('change requests list is own-lead scoped, newest first, with the form\u2019s kind labels', () => {
    const list = designJobs.listChangeRequests(db, 101);
    assert.equal(list.length, 2);
    assert.equal(list[0].details, 'Redo the whole homepage.');
    assert.equal(list[0].kind_label, 'Bigger redesign');
    assert.equal(list[1].kind_label, 'Small changes / polish');
    assert.equal(designJobs.listChangeRequests(db, 102).length, 0);
    assert.throws(() => designJobs.listChangeRequests(db, null), (e) => e.code === 'FORBIDDEN');
    assert.throws(() => designJobs.listChangeRequests(db, 0), (e) => e.code === 'FORBIDDEN');
  });
  check('change request status derives from the linked job at read time', () => {
    const setStatus = (s) => db.prepare('UPDATE design_jobs SET status = ? WHERE id = ?').run(s, crJob.id);
    setStatus('waiting_on_agent'); assert.equal(designJobs.listChangeRequests(db, 101)[0].status, 'received');
    setStatus('questions_pending'); assert.equal(designJobs.listChangeRequests(db, 101)[0].status, 'received');
    setStatus('in_progress'); assert.equal(designJobs.listChangeRequests(db, 101)[0].status, 'in_progress');
    setStatus('delivered');
    const done = designJobs.listChangeRequests(db, 101)[0];
    assert.equal(done.status, 'done'); assert.equal(done.status_label, 'Done');
    designJobs.recordChangeRequest(db, { leadId: 102, jobId: null, kind: 'improvements', details: 'Unlinked request', requesterEmail: 'two@example.invalid' });
    assert.equal(designJobs.listChangeRequests(db, 102)[0].status, 'received', 'unlinked record reads Received');
    db.prepare('DELETE FROM design_jobs WHERE id = ?').run(crJob.id);
    const surviving = designJobs.listChangeRequests(db, 101);
    assert.equal(surviving.length, 2, 'history survives job deletion');
    assert.equal(surviving[0].status, 'received');
  });
  const portal11 = load('server/clientPortal.js', {
    bcryptjs: { hashSync: () => 'fixture' }, './db': {}, './mailer': {}, './stripeClient': {}, './workspaceDb': {},
    './domain': { withDb: (_ws, fn) => fn(db) }, './portalContacts': contacts, '../src/designJobs': designJobs, './portalTabs': portalTabs,
  });
  assert.equal(portal11.listChangeRequests(1, 102).length, 1);
  assert.throws(() => portal11.listChangeRequests(1, null), (e) => e.code === 'FORBIDDEN');
  const portalRoutes11 = [];
  const portalRouter11 = { use() {} };
  for (const method of ['get', 'post', 'put', 'patch', 'delete']) portalRouter11[method] = (route, ...handlers) => portalRoutes11.push({ method, route, handlers });
  load('server/routes/portal.js', {
    express: { Router: () => portalRouter11 }, '../clientPortal': { ...portal11, findById: async () => ({ id: 7, status: 'active', workspace_id: 1, lead_id: 102 }) },
    '../captcha': { requireCaptcha: () => ((_req, _res, next) => next()) }, '../rateLimit': { rateLimit: () => ((_req, _res, next) => next()) }, '../portalTabs': portalTabs,
    '../mfa': { isEnabled: async () => false }, '../apiErrors': apiErrors, '../portalPassword': portalPasswordStub,
  });
  async function callPortal11(method, url, body) {
    const route = portalRoutes11.find((x) => x.method === method && x.route === url); assert(route, url);
    const req = { session: { clientPortalId: 7, clientLastActiveAt: Date.now() }, query: {}, params: {}, body: body || {}, app: { locals: {} } };
    let status = 200, payload; const res = { status(v) { status = v; return this; }, json(v) { payload = v; return this; } };
    for (const handler of route.handlers) { let advanced = false; await handler(req, res, () => { advanced = true; }); if (!advanced) break; }
    return { status, body: payload };
  }
  const getChanges = await callPortal11('get', '/changes');
  assert.equal(getChanges.status, 200);
  assert.equal(getChanges.body.data.requests.length, 1, 'route returns only the session lead\u2019s requests');
  assert.equal(getChanges.body.data.requests[0].details, 'Unlinked request');
  const postChanges = await callPortal11('post', '/changes', { kind: 'improvements', message: 'Route-level request.' });
  assert.equal(postChanges.status, 200);
  const afterPost = await callPortal11('get', '/changes');
  assert.equal(afterPost.body.data.requests.length, 2, 'POST /changes records a history entry for the session lead');
  assert.equal(afterPost.body.data.requests[0].details, 'Route-level request.');
  assert.equal(designJobs.listChangeRequests(db, 101).length, 2, 'no cross-lead leakage from route submissions');
  results.push('portal /changes routes: session-scoped history read + record-on-submit');

  // ── Batch 12: offers / menu / careers / video site modules ──
  const sm12 = load('server/siteModules.js', {
    '../src/pageContentScan': require(path.join(root, 'src/pageContentScan.js')),
  });
  sm12.ensureTables(db);
  assert.equal(Object.keys(sm12.MODULE_META).length, 29, 'module catalog has 29 types (Batch 124: categories is the 24th; Batch 125: photocapture is the 25th; Batch 128: checkout is the 27th; Batch 131: comments is the 28th; Batch 139: pricing is the 29th)');
  for (const t of ['offers', 'menu', 'careers', 'video']) assert(sm12.MODULE_META[t], 'meta for ' + t);
  check('batch12 catalog: module types incl. offers/menu/careers/video', () => {});

  // Offers: CRUD + per-lead scoping + expiry rules.
  const offerA = sm12.createOffer(db, 201, { title: 'Spring Deal', code: 'SPRING', expires_at: '2999-01-01', status: 'published' });
  const offerOld = sm12.createOffer(db, 201, { title: 'Ancient Deal', expires_at: '2000-01-01', status: 'published' });
  const offerDraft = sm12.createOffer(db, 201, { title: 'Draft Deal' });
  assert.equal(sm12.listOffers(db, 201).length, 3);
  assert.equal(sm12.listOffers(db, 202).length, 0, 'offers are lead-scoped');
  assert.equal(sm12.getOffer(db, 202, offerA.id), undefined, 'cross-lead get returns nothing');
  assert.equal(sm12.getOffer(db, 201, offerOld.id).expired, 1, 'portal row flags expired');
  const publicOffers = sm12.listOffers(db, 201, { includeDrafts: false });
  assert.equal(publicOffers.length, 1, 'public list hides expired + drafts');
  assert.equal(publicOffers[0].id, offerA.id);
  assert.throws(() => sm12.createOffer(db, 201, { title: 'Bad', expires_at: 'next Friday' }), (e) => e.code === 'VALIDATION');
  sm12.updateOffer(db, 201, offerDraft.id, { status: 'published', expires_at: '2000-06-01' });
  assert.equal(sm12.listOffers(db, 201, { includeDrafts: false }).length, 1, 'newly expired offer hides too');
  assert.equal(sm12.moduleItemCount(db, 201, 'offers'), 3);
  check('batch12 offers: CRUD, lead scoping, expired hidden from public list but flagged in portal list', () => {});

  // Menu: categories + items.
  const catMains = sm12.createMenuCategory(db, 201, { name: 'Mains' });
  const burger = sm12.createMenuItem(db, 201, { name: 'Smash Burger', price_text: '$14', category_id: catMains.id, status: 'published' });
  assert.equal(burger.category_name, 'Mains');
  const fries = sm12.createMenuItem(db, 201, { name: 'Fries', price_text: 'Market price', category_name: 'Sides', status: 'published' });
  assert.equal(fries.category_name, 'Sides', 'category_name find-or-creates');
  assert.equal(sm12.listMenuCategories(db, 201).length, 2);
  const secret = sm12.createMenuItem(db, 201, { name: 'Secret Sauce', category_name: 'Sides' });
  assert.equal(sm12.listMenuCategories(db, 201).length, 2, 'find-or-create reuses the category');
  assert.equal(sm12.listMenuItems(db, 201, { includeDrafts: false }).length, 2, 'draft menu items hidden publicly');
  assert.equal(sm12.listMenuItems(db, 202).length, 0, 'menu items are lead-scoped');
  const otherCat = sm12.createMenuCategory(db, 202, { name: 'Foreign' });
  assert.throws(() => sm12.createMenuItem(db, 201, { name: 'X', category_id: otherCat.id }), (e) => e.code === 'VALIDATION');
  sm12.deleteMenuCategory(db, 201, catMains.id);
  assert.equal(sm12.getMenuItem(db, 201, burger.id).category_id, null, 'category delete unlinks items, keeps them');
  assert.equal(sm12.moduleItemCount(db, 201, 'menu'), 3);
  check('batch12 menu: categories CRUD, find-or-create, cross-lead category rejected, delete keeps items', () => {});

  // Careers: defaults, validation, inactive hiding.
  const jobA = sm12.createCareersPosting(db, 201, { title: 'Line Cook', apply_mode: 'email', apply_target: 'jobs@example.invalid' });
  assert.equal(jobA.employment_type, 'Full-time');
  assert.equal(jobA.status, 'active');
  const jobOff = sm12.createCareersPosting(db, 201, { title: 'Filled Role', active: 0 });
  assert.equal(jobOff.status, 'inactive');
  assert.equal(sm12.listCareersPostings(db, 201).length, 2);
  assert.equal(sm12.listCareersPostings(db, 201, { includeInactive: false }).length, 1, 'inactive postings hidden publicly');
  assert.equal(sm12.listCareersPostings(db, 202).length, 0, 'postings are lead-scoped');
  assert.throws(
    () => sm12.createCareersPosting(db, 201, { title: 'Bad Apply', apply_mode: 'email', apply_target: 'not-an-email' }),
    (e) => e.code === 'VALIDATION'
  );
  assert.throws(
    () => sm12.createCareersPosting(db, 201, { title: 'Bad URL', apply_mode: 'url', apply_target: 'ftp://x' }),
    (e) => e.code === 'VALIDATION'
  );
  sm12.updateCareersPosting(db, 201, jobA.id, { status: 'inactive' });
  assert.equal(sm12.getCareersPosting(db, 201, jobA.id).active, 0, 'portal status select maps to active flag');
  sm12.updateCareersPosting(db, 201, jobA.id, { status: 'active' });
  assert.equal(sm12.moduleItemCount(db, 201, 'careers'), 2);
  check('batch12 careers: defaults, apply validation, inactive hidden, status<->active mapping', () => {});

  // Video: URL validation matrix + derived fields.
  const vidYt = sm12.createVideoItem(db, 201, { title: 'Tour', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', status: 'published' });
  assert.equal(vidYt.provider, 'youtube');
  assert.equal(vidYt.embed_url, 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
  assert.equal(vidYt.thumbnail_url, 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg');
  const vidShort = sm12.createVideoItem(db, 201, { title: 'Short', url: 'https://youtu.be/dQw4w9WgXcQ' });
  assert.equal(vidShort.video_id, 'dQw4w9WgXcQ');
  const vidVimeo = sm12.createVideoItem(db, 201, { title: 'Vim', url: 'https://vimeo.com/123456789' });
  assert.equal(vidVimeo.embed_url, 'https://player.vimeo.com/video/123456789');
  assert.equal(vidVimeo.thumbnail_url, '', 'vimeo has no derived thumbnail');
  for (const bad of ['https://example.com/v.mp4', 'https://www.youtube.com/', 'not a url', 'https://vimeo.com/about', '']) {
    assert.throws(() => sm12.createVideoItem(db, 201, { title: 'Bad', url: bad }), (e) => e.code === 'VALIDATION', 'rejects ' + bad);
  }
  const vidUpdated = sm12.updateVideoItem(db, 201, vidShort.id, { url: 'https://www.youtube.com/shorts/abcDEF123_-' });
  assert.equal(vidUpdated.video_id, 'abcDEF123_-', 'update re-derives provider fields');
  assert.equal(sm12.listVideoItems(db, 202).length, 0, 'videos are lead-scoped');
  assert.equal(sm12.moduleItemCount(db, 201, 'video'), 3);
  check('batch12 video: YouTube/Vimeo URL matrix, derived embed + thumbnail, rejections', () => {});

  // Public payload via a published embed row (token surface used by module-embed.js).
  db.prepare("INSERT INTO leads (id, business_name, email) VALUES (201, 'Fixture Modules', 'modules@example.invalid')").run();
  const homePages = JSON.stringify([{ slug: 'index', file: 'index.html', title: 'Home', nav_label: 'Home', html: '<p>hi</p>', sections: [] }]);
  db.prepare('INSERT INTO websites (lead_id, name, theme, pages) VALUES (201, ?, ?, ?)').run(
    'Fixture Site',
    '{}',
    homePages
  );
  const embOffersRes = sm12.attachModule(db, 201, 'offers', { workspaceId: 1, appUrl: 'https://example.test' });
  const embOffers = embOffersRes.embed;
  assert(embOffers && embOffers.public_token, 'attach returns an embed with a token');
  const pubOffers = sm12.getPublicModuleByToken(db, embOffers.public_token);
  assert.equal(pubOffers.module_type, 'offers');
  assert.deepEqual(pubOffers.items.map((i) => i.id), [offerA.id], 'public payload excludes expired offers');
  assert.throws(() => sm12.getPublicModuleItem(db, embOffers.public_token, offerOld.id), (e) => e.code === 'NOT_FOUND');
  const embMenu = sm12.attachModule(db, 201, 'menu', { workspaceId: 1, appUrl: 'https://example.test' }).embed;
  const pubMenu = sm12.getPublicModuleByToken(db, embMenu.public_token);
  assert.equal(pubMenu.items.length, 2);
  assert.deepEqual(pubMenu.categories.map((c) => c.name), ['Sides'], 'public categories only include ones with published items');
  const embCareers = sm12.attachModule(db, 201, 'careers', { workspaceId: 1, appUrl: 'https://example.test' }).embed;
  const pubCareers = sm12.getPublicModuleByToken(db, embCareers.public_token);
  assert.deepEqual(pubCareers.items.map((i) => i.id), [jobA.id], 'public payload excludes inactive postings');
  assert.throws(() => sm12.getPublicModuleItem(db, embCareers.public_token, jobOff.id), (e) => e.code === 'NOT_FOUND');
  const embVideo = sm12.attachModule(db, 201, 'video', { workspaceId: 1, appUrl: 'https://example.test' }).embed;
  const pubVideo = sm12.getPublicModuleByToken(db, embVideo.public_token);
  assert.equal(pubVideo.items.length, 1, 'only published videos surface');
  assert.equal(pubVideo.items[0].embed_url, 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
  const summary12 = sm12.portalSummary(db, 201);
  assert.equal(summary12.modules.length, 29, 'portal summary lists all 29 module types');
  check('batch12 public payloads: token surface filters expired/inactive/draft; portal summary = 18 types', () => {});

  // Attach injects nav pages; detach removes them.
  const siteRow = db.prepare('SELECT pages FROM websites WHERE lead_id = 201').get();
  const pagesAfterAttach = JSON.parse(siteRow.pages);
  for (const slug of ['offers', 'menu', 'careers', 'videos']) {
    assert(pagesAfterAttach.some((p) => p.slug === slug), 'nav page injected for ' + slug);
  }
  for (const t of ['offers', 'menu', 'careers', 'video']) sm12.detachModule(db, 201, t);
  const embedsAfterDetach = sm12.listEmbeds(db, 201);
  assert.equal(embedsAfterDetach.length, 4, 'detach keeps embed rows (soft-disable, same as existing modules)');
  assert(embedsAfterDetach.every((e) => !e.embed_enabled && !e.published), 'detach disables + unpublishes every embed');
  assert.throws(() => sm12.getPublicModuleByToken(db, embOffers.public_token), (e) => e.code === 'NOT_FOUND', 'detached module token no longer serves');
  check('batch12 attach/detach: nav pages injected for all four modules; detach soft-disables and the token stops serving', () => {});

  // ── Batch 13: Instant Estimate module ──
  const sm13 = load('server/siteModules.js', {
    '../src/pageContentScan': require(path.join(root, 'src/pageContentScan.js')),
    './portalContacts': contacts,
  });
  sm13.ensureTables(db);
  assert(sm13.MODULE_META.estimate, 'meta for estimate');
  assert.equal(sm13.MODULE_META.estimate.label, 'Instant Estimate');
  check('batch13 catalog: estimate registered as the 16th module type', () => {});

  // Config: honest defaults + validated updates.
  const cfgDefault = sm13.getEstimateConfig(db, 301);
  assert.equal(cfgDefault.display_mode, 'exact');
  assert.equal(cfgDefault.range_percent, 15);
  assert.equal(cfgDefault.submit_label, 'Send my estimate');
  assert(cfgDefault.disclaimer.includes('ballpark'), 'default disclaimer is honest estimate wording');
  const cfgSet = sm13.updateEstimateConfig(db, 301, {
    service_label: 'Kitchen remodel',
    base_price: '100',
    display_mode: 'range',
    range_percent: 250,
  });
  assert.equal(cfgSet.base_price_cents, 10000, 'base_price dollars convert to cents');
  assert.equal(cfgSet.range_percent, 100, 'range_percent clamped to 100');
  assert.throws(() => sm13.updateEstimateConfig(db, 301, { base_price: '-5' }), (e) => e.code === 'VALIDATION');
  assert.throws(() => sm13.updateEstimateConfig(db, 301, { base_price: 'lots' }), (e) => e.code === 'VALIDATION');
  assert.throws(() => sm13.updateEstimateConfig(db, 301, { base_price: '20000000' }), (e) => e.code === 'VALIDATION');
  sm13.updateEstimateConfig(db, 301, { display_mode: 'exact', range_percent: 15 });
  check('batch13 config: defaults, dollar→cent base price, clamping, money validation', () => {});

  // Options: CRUD + per-lead scoping + choices parsing.
  const optCheck = sm13.createEstimateOption(db, 301, { label: 'Extra bathroom', input_type: 'checkbox', price: '25' });
  assert.equal(optCheck.price_cents, 2500);
  assert.equal(optCheck.status, 'active');
  const optQty = sm13.createEstimateOption(db, 301, { label: 'Windows', input_type: 'quantity', price: 10 });
  assert.equal(optQty.price_cents, 1000);
  const optSel = sm13.createEstimateOption(db, 301, {
    label: 'Project size',
    input_type: 'select',
    choices_text: 'Small | 0\nLarge | 50',
  });
  assert.equal(
    JSON.stringify(optSel.choices.map((c) => [c.label, c.price_cents])),
    JSON.stringify([
      ['Small', 0],
      ['Large', 5000],
    ]),
    'choices_text lines parse to label + cents'
  );
  assert.equal(sm13.listEstimateOptions(db, 302).length, 0, 'options are lead-scoped');
  assert.equal(sm13.getEstimateOption(db, 302, optCheck.id), undefined, 'cross-lead get returns nothing');
  assert.throws(() => sm13.createEstimateOption(db, 301, { label: 'Bad type', input_type: 'slider' }), (e) => e.code === 'VALIDATION');
  assert.throws(() => sm13.createEstimateOption(db, 301, { label: 'No choices', input_type: 'select' }), (e) => e.code === 'VALIDATION');
  const optOff = sm13.createEstimateOption(db, 301, { label: 'Retired add-on', price: 5 });
  sm13.updateEstimateOption(db, 301, optOff.id, { status: 'inactive' });
  assert.equal(sm13.getEstimateOption(db, 301, optOff.id).active, 0, 'portal status maps to active flag');
  assert.equal(sm13.listEstimateOptions(db, 301, { includeInactive: false }).length, 3, 'inactive options hidden from active list');
  check('batch13 options: CRUD, lead scoping, choices parsing, validation, active mapping', () => {});

  // Calculator math (server-authoritative).
  const math1 = sm13.computeEstimate(db, 301, [
    { option_id: optCheck.id, checked: true },
    { option_id: optQty.id, quantity: 3 },
    { option_id: optSel.id, choice_index: 0 },
  ]);
  assert.equal(math1.total_cents, 10000 + 2500 + 3000 + 0, 'base + checkbox + qty×3 + first select choice');
  const math2 = sm13.computeEstimate(db, 301, [{ option_id: optSel.id, choice_index: 1 }]);
  assert.equal(math2.total_cents, 10000 + 5000, 'select with no other picks still counts base + chosen choice');
  const mathAuto = sm13.computeEstimate(db, 301, []);
  assert.equal(mathAuto.total_cents, 10000, 'omitted select defaults to its first choice ($0 here)');
  assert.throws(() => sm13.computeEstimate(db, 301, [{ option_id: 999999, checked: true }]), (e) => e.code === 'VALIDATION');
  assert.throws(() => sm13.computeEstimate(db, 301, [{ option_id: optOff.id, checked: true }]), (e) => e.code === 'VALIDATION', 'inactive option rejected');
  assert.throws(() => sm13.computeEstimate(db, 301, [{ option_id: optSel.id, choice_index: 9 }]), (e) => e.code === 'VALIDATION');
  const bounds = sm13.estimateRangeBounds(15500, 15);
  assert.equal(bounds.low_cents, 13175);
  assert.equal(bounds.high_cents, 17825);
  check('batch13 math: checkbox/select/quantity combos, select auto-default, unknown/inactive rejected, range bounds', () => {});

  // Requests: stored snapshot + LeadScout funnel dedupe.
  assert.throws(() => sm13.createEstimateRequest(db, 301, { email: 'x@example.invalid' }), (e) => e.code === 'VALIDATION', 'name required');
  assert.throws(() => sm13.createEstimateRequest(db, 301, { name: 'No Contact' }), (e) => e.code === 'VALIDATION', 'email or phone required');
  const req1 = sm13.createEstimateRequest(db, 301, {
    name: 'Visitor One',
    email: 'visitor@example.invalid',
    selections: [
      { option_id: optCheck.id, checked: true },
      { option_id: optQty.id, quantity: 2 },
    ],
  });
  assert.equal(req1.estimate_cents, 10000 + 2500 + 2000 + 0);
  assert.equal(req1.selections.length, 3, 'snapshot includes the auto-applied select choice');
  assert(req1.contact_id, 'request linked to its LeadScout contact');
  const req2 = sm13.createEstimateRequest(db, 301, {
    name: 'Visitor One',
    email: 'visitor@example.invalid',
    phone: '5551112222',
    selections: [],
  });
  const scopedContacts = contacts.listContacts(db, { leadId: 301 });
  assert.equal(scopedContacts.length, 1, 'repeat submission dedupes to ONE contact');
  assert.equal(scopedContacts[0].event_count, 2, 'both submissions recorded as events on the one contact');
  const detail301 = contacts.getContact(db, req1.contact_id, { leadId: 301 });
  assert.equal(detail301.estimates.length, 2, 'contact detail exposes estimate events');
  assert.equal(sm13.listEstimateRequests(db, 301).length, 2);
  assert.equal(sm13.listEstimateRequests(db, 302).length, 0, 'requests are lead-scoped');
  assert.equal(sm13.moduleItemCount(db, 301, 'estimate'), 2, 'tab count = request queue');
  const reqStatus = sm13.updateEstimateRequestStatus(db, 301, req2.id, 'contacted');
  assert.equal(reqStatus.status, 'contacted');
  assert.throws(() => sm13.updateEstimateRequestStatus(db, 301, req2.id, 'bogus'), (e) => e.code === 'VALIDATION');
  check('batch13 requests: validation, snapshot + server total stored, one-contact dedupe via the funnel', () => {});

  // Public token surface: attach, exact payload, hidden-mode leak check, cross-type token rejection.
  db.prepare("INSERT INTO leads (id, business_name, email) VALUES (301, 'Fixture Estimate', 'estimate@example.invalid')").run();
  db.prepare('INSERT INTO websites (lead_id, name, theme, pages) VALUES (301, ?, ?, ?)').run(
    'Fixture Estimate Site',
    '{}',
    homePages
  );
  const embEst = sm13.attachModule(db, 301, 'estimate', { workspaceId: 1, appUrl: 'https://example.test' }).embed;
  const pubEst = sm13.getPublicModuleByToken(db, embEst.public_token);
  assert.equal(pubEst.module_type, 'estimate');
  assert.equal(pubEst.estimate.config.base_price_cents, 10000, 'exact mode exposes the base price');
  assert.equal(pubEst.estimate.options.length, 3, 'public options exclude inactive ones');
  assert.equal(pubEst.estimate.options.find((o) => o.id === optCheck.id).price_cents, 2500);
  const pubSubmit = sm13.createPublicEstimateRequestByToken(db, embEst.public_token, {
    name: 'Public Visitor',
    phone: '5553334444',
    selections: [{ option_id: optQty.id, quantity: 1 }],
  });
  assert.equal(pubSubmit.request.estimate_cents, 10000 + 1000 + 0);
  assert.throws(
    () => sm13.createPublicEstimateRequestByToken(db, embOffers.public_token, { name: 'X', email: 'x@example.invalid' }),
    (e) => e.code === 'NOT_FOUND',
    'a token for another module type cannot submit estimates'
  );
  assert.throws(
    () => sm13.createPublicEstimateRequestByToken(db, 'bogus-token', { name: 'X', email: 'x@example.invalid' }),
    (e) => e.code === 'NOT_FOUND'
  );
  sm13.updateEstimateConfig(db, 301, { display_mode: 'hidden' });
  const pubHidden = sm13.getPublicModuleByToken(db, embEst.public_token);
  const hiddenJson = JSON.stringify(pubHidden.estimate);
  assert(!hiddenJson.includes('price_cents'), 'hidden payload carries no price_cents anywhere');
  assert(!hiddenJson.includes('price_label'), 'hidden payload carries no price labels');
  assert(!hiddenJson.includes('10000'), 'hidden payload does not leak the base price value');
  assert.equal(pubHidden.estimate.options.find((o) => o.id === optSel.id).choices[1].label, 'Large', 'choice labels still ship in hidden mode');
  const hiddenSubmit = sm13.createPublicEstimateRequestByToken(db, embEst.public_token, {
    name: 'Hidden Visitor',
    email: 'hidden@example.invalid',
    selections: [{ option_id: optCheck.id, checked: true }],
  });
  assert.equal(hiddenSubmit.request.estimate_cents, undefined, 'hidden-mode response reveals no total');
  const storedHidden = sm13.listEstimateRequests(db, 301)[0];
  assert.equal(storedHidden.estimate_cents, 10000 + 2500 + 0, 'server still computes + stores the hidden total');
  sm13.updateEstimateConfig(db, 301, { display_mode: 'exact' });
  sm13.detachModule(db, 301, 'estimate');
  assert.throws(() => sm13.getPublicModuleByToken(db, embEst.public_token), (e) => e.code === 'NOT_FOUND', 'detached estimate token stops serving');
  assert.throws(
    () => sm13.createPublicEstimateRequestByToken(db, embEst.public_token, { name: 'X', email: 'x@example.invalid' }),
    (e) => e.code === 'NOT_FOUND',
    'detached estimate token cannot accept submissions'
  );
  check('batch13 public surface: exact payload, hidden mode leaks nothing, type-checked token writes, detach kills the token', () => {});

  // ── Batch 14: Social Feed module ──
  const socialReal = require(path.join(root, 'src/socialMedia.js'));
  socialReal.ensureTables(db);
  let stubFetchCalls = 0;
  let stubFetchImpl = async () => ({ items: [], errors: [] });
  const socialStub = {
    ensureTables: (d) => socialReal.ensureTables(d),
    listAccounts: (d, leadId) => socialReal.listAccounts(d, leadId),
    fetchRemoteFeedPosts: async (d, leadId, opts) => {
      stubFetchCalls++;
      return stubFetchImpl(d, leadId, opts);
    },
  };
  const sm14 = load('server/siteModules.js', {
    '../src/pageContentScan': require(path.join(root, 'src/pageContentScan.js')),
    './portalContacts': contacts,
    '../src/socialMedia': socialStub,
  });
  sm14.ensureTables(db);
  assert(sm14.MODULE_META.socialfeed, 'meta for socialfeed');
  assert.equal(sm14.MODULE_META.socialfeed.label, 'Social Feed');
  assert.equal(sm14.MODULE_META.socialfeed.defaultSlug, 'social-feed');
  check('batch14 catalog: socialfeed registered as the 17th module type', () => {});

  // Config: honest defaults + clamping + invalid values fall back.
  const sfCfg0 = sm14.getSocialFeedConfig(db, 401);
  assert.equal(sfCfg0.networks, 'both');
  assert.equal(sfCfg0.max_posts, 6);
  assert.equal(sfCfg0.layout, 'grid');
  const sfCfg1 = sm14.updateSocialFeedConfig(db, 401, { networks: 'facebook', max_posts: 99, layout: 'list' });
  assert.equal(sfCfg1.networks, 'facebook');
  assert.equal(sfCfg1.max_posts, 24, 'max_posts clamped to 24');
  assert.equal(sfCfg1.layout, 'list');
  const sfCfg2 = sm14.updateSocialFeedConfig(db, 401, { networks: 'tiktok', layout: 'masonry' });
  assert.equal(sfCfg2.networks, 'facebook', 'unknown networks value falls back to current');
  assert.equal(sfCfg2.layout, 'list', 'unknown layout falls back to current');
  sm14.updateSocialFeedConfig(db, 401, { networks: 'both', max_posts: 6, layout: 'grid' });
  check('batch14 config: defaults, max_posts clamping, invalid values fall back', () => {});

  // Local sourcing: only this lead's published posts, expanded per platform.
  const campId = Number(
    db.prepare('INSERT INTO social_campaigns (lead_id, title, month_start) VALUES (?, ?, ?)').run(401, 'Oct', '2026-10-01')
      .lastInsertRowid
  );
  const camp2Id = Number(
    db.prepare('INSERT INTO social_campaigns (lead_id, title, month_start) VALUES (?, ?, ?)').run(402, 'Oct', '2026-10-01')
      .lastInsertRowid
  );
  const insPost = db.prepare(
    'INSERT INTO social_posts (campaign_id, lead_id, caption, platforms, image_url, status, published_at, meta_results) VALUES (?,?,?,?,?,?,?,?)'
  );
  insPost.run(
    campId, 401, 'Fresh croissants today', '["facebook","instagram"]', 'https://cdn.example.test/a.jpg', 'posted',
    '2026-10-20 10:00:00',
    JSON.stringify({ facebook: { ok: true, id: '111_222' }, instagram: { ok: true, id: 'ig_1' } })
  );
  insPost.run(
    campId, 401, 'IG only win', '["facebook","instagram"]', null, 'partial', '2026-10-21 09:00:00',
    JSON.stringify({ facebook: { ok: false, error: 'page error' }, instagram: { ok: true, id: 'ig_2' } })
  );
  insPost.run(campId, 401, 'Draft secret', '["facebook"]', null, 'draft', null, null);
  insPost.run(campId, 401, 'Scheduled secret', '["facebook"]', null, 'scheduled', null, null);
  insPost.run(
    camp2Id, 402, 'Foreign post', '["facebook"]', null, 'posted', '2026-10-22 10:00:00',
    JSON.stringify({ facebook: { ok: true, id: '999_999' } })
  );
  const local401 = sm14.localSocialFeedItems(db, 401);
  assert.equal(local401.length, 3, 'posted expands per platform; partial keeps only the ok platform; draft/scheduled excluded');
  assert(local401.every((i) => i.source === 'bitpype'));
  const fbLocal = local401.find((i) => i.network === 'facebook');
  assert.equal(fbLocal.external_id, '111_222');
  assert.equal(fbLocal.permalink, 'https://www.facebook.com/111_222', 'facebook permalink derived from the stored post id');
  assert.equal(local401.find((i) => i.external_id === 'ig_2').permalink, null, 'instagram local posts carry no derivable permalink');
  const merged0 = sm14.socialFeedItems(db, 401);
  assert.equal(merged0.length, 3);
  assert.equal(merged0[0].external_id, 'ig_2', 'newest first');
  sm14.updateSocialFeedConfig(db, 401, { networks: 'instagram' });
  assert.equal(
    sm14.socialFeedItems(db, 401).map((i) => i.external_id).join(','),
    'ig_2,ig_1',
    'network filter honored'
  );
  sm14.updateSocialFeedConfig(db, 401, { networks: 'both', max_posts: 2 });
  assert.equal(sm14.socialFeedItems(db, 401).length, 2, 'max_posts honored');
  sm14.updateSocialFeedConfig(db, 401, { max_posts: 6 });
  assert.equal(sm14.socialFeedItems(db, 402).length, 1, 'another lead sees only its own posts');
  assert.equal(sm14.socialFeedItems(db, 403).length, 0, 'a lead with no posts gets an empty feed');
  assert.equal(sm14.moduleItemCount(db, 401, 'socialfeed'), 3, 'tab count = what the feed shows');
  check('batch14 local sourcing: published-only, per-platform expansion, scoping, network filter + cap, ordering', () => {});

  // Remote sourcing: stubbed fetch → cache; dedupe vs local; TTL; failure fallback.
  stubFetchImpl = async () => ({
    items: [
      {
        network: 'facebook', external_id: '111_222', text: 'Fresh croissants today',
        image_url: 'https://cdn.example.test/a.jpg', permalink: 'https://www.facebook.com/111_222',
        published_at: '2026-10-20T10:00:00Z',
      },
      {
        network: 'facebook', external_id: '555_777', text: 'Weekend market stall',
        image_url: null, permalink: 'https://www.facebook.com/555_777', published_at: '2026-10-23T08:30:00Z',
      },
    ],
    errors: [],
  });
  const refresh1 = await sm14.refreshSocialFeedRemote(db, 401, { force: true });
  assert.equal(refresh1.ok, true);
  assert.equal(stubFetchCalls, 1);
  const merged1 = sm14.socialFeedItems(db, 401);
  assert.equal(merged1.length, 4, 'remote adds the new post; the duplicate of a local post is suppressed');
  assert.equal(merged1[0].external_id, '555_777', 'newest remote post sorts first');
  assert.equal(merged1.filter((i) => i.external_id === '111_222').length, 1, 'no duplicate card for the same post');
  assert.equal(merged1.find((i) => i.external_id === '111_222').source, 'bitpype', 'the local copy wins the dedupe');
  const refresh2 = await sm14.refreshSocialFeedRemote(db, 401);
  assert.equal(refresh2.skipped, 'fresh', 'a second refresh inside the TTL is a no-op');
  assert.equal(stubFetchCalls, 1, 'no second fetch within 15 minutes');
  stubFetchImpl = async () => {
    throw new Error('Meta is down');
  };
  const refresh3 = await sm14.refreshSocialFeedRemote(db, 401, { force: true });
  assert.equal(refresh3.ok, false, 'a fetch failure is reported, never thrown');
  assert.equal(sm14.readSocialFeedCache(db, 401).items.length, 2, 'a failed refresh keeps the previous cache');
  assert(sm14.readSocialFeedCache(db, 401).last_error.includes('Meta is down'), 'the failure is recorded on the cache row');
  assert.equal(sm14.socialFeedItems(db, 401).length, 4, 'the feed still renders from local + cache after the failure');
  check('batch14 remote: cache write, dedupe vs local, TTL skip, failure keeps cache and never throws', () => {});

  // socialMedia.fetchRemoteFeedPosts: real Graph read-back, fetch injected.
  db.prepare(
    'INSERT INTO social_accounts (lead_id, platform, account_id, account_name, page_id, access_token_enc, status) VALUES (?,?,?,?,?,?,?)'
  ).run(501, 'facebook', 'pg_1', 'Bakery Page', 'pg_1', socialReal.encToken('TEST-TOKEN'), 'active');
  db.prepare(
    'INSERT INTO social_accounts (lead_id, platform, account_id, account_name, page_id, access_token_enc, status) VALUES (?,?,?,?,?,?,?)'
  ).run(501, 'instagram', 'ig_1', 'bakery.ig', 'pg_1', socialReal.encToken('TEST-TOKEN'), 'active');
  const seenUrls = [];
  const feedFetch = async (url) => {
    seenUrls.push(String(url));
    if (String(url).includes('/published_posts')) {
      return {
        ok: true, status: 200,
        json: async () => ({
          data: [
            {
              id: 'pg_1_42', message: 'Hello from the Page', created_time: '2026-10-24T12:00:00+0000',
              full_picture: 'https://cdn.example.test/p.jpg', permalink_url: 'https://www.facebook.com/pg_1_42',
            },
          ],
        }),
      };
    }
    return {
      ok: true, status: 200,
      json: async () => ({
        data: [
          {
            id: 'igm_1', caption: 'IG hello', media_type: 'VIDEO', media_url: 'https://cdn.example.test/v.mp4',
            thumbnail_url: 'https://cdn.example.test/t.jpg', permalink: 'https://www.instagram.com/p/abc/',
            timestamp: '2026-10-24T13:00:00+0000',
          },
        ],
      }),
    };
  };
  const remote = await socialReal.fetchRemoteFeedPosts(db, 501, { fetchImpl: feedFetch });
  assert.equal(remote.errors.length, 0);
  assert.equal(remote.items.length, 2);
  const fbItem = remote.items.find((i) => i.network === 'facebook');
  assert.equal(fbItem.external_id, 'pg_1_42');
  assert.equal(fbItem.text, 'Hello from the Page');
  assert.equal(fbItem.permalink, 'https://www.facebook.com/pg_1_42');
  const igItem = remote.items.find((i) => i.network === 'instagram');
  assert.equal(igItem.image_url, 'https://cdn.example.test/t.jpg', 'video posts surface their thumbnail');
  assert(seenUrls.some((u) => u.includes('/pg_1/published_posts')), 'page published_posts endpoint hit');
  assert(seenUrls.some((u) => u.includes('/ig_1/media')), 'instagram media endpoint hit');
  const deniedFetch = async () => ({
    ok: false, status: 403,
    json: async () => ({ error: { message: '(#10) Application does not have permission for this action' } }),
  });
  const denied = await socialReal.fetchRemoteFeedPosts(db, 501, { fetchImpl: deniedFetch });
  assert.equal(denied.items.length, 0);
  assert.equal(denied.errors.length, 2, 'permission failures are reported per platform, never thrown');
  const noAcct = await socialReal.fetchRemoteFeedPosts(db, 599, { fetchImpl: feedFetch });
  assert.deepEqual(noAcct, { items: [], errors: [] }, 'no connected account → empty result, no error');
  check('batch14 socialMedia read-back: page + IG normalization, video thumbnail, denial reported not thrown', () => {});

  // Public token surface: attach, payload shape, preview parity, empty feed, detach.
  db.prepare("INSERT INTO leads (id, business_name, email) VALUES (401, 'Fixture Feed', 'feed@example.invalid')").run();
  db.prepare('INSERT INTO websites (lead_id, name, theme, pages) VALUES (401, ?, ?, ?)').run(
    'Fixture Feed Site',
    '{}',
    homePages
  );
  const embFeed = sm14.attachModule(db, 401, 'socialfeed', { workspaceId: 1, appUrl: 'https://example.test' }).embed;
  const pubFeed = sm14.getPublicModuleByToken(db, embFeed.public_token);
  assert.equal(pubFeed.module_type, 'socialfeed');
  assert.equal(pubFeed.socialfeed.layout, 'grid');
  assert.equal(pubFeed.socialfeed.networks, 'both');
  assert.equal(pubFeed.items.length, 4, 'public payload = local published + cached live posts');
  assert(!JSON.stringify(pubFeed).includes('Draft secret'), 'drafts never reach the public payload');
  assert(!JSON.stringify(pubFeed).includes('Scheduled secret'), 'scheduled posts never reach the public payload');
  assert(!JSON.stringify(pubFeed).includes('Foreign post'), 'other leads never reach the public payload');
  const preview401 = sm14.socialFeedPreview(db, 401);
  assert.equal(preview401.items.length, 4, 'portal preview matches what will render');
  assert(
    preview401.source_note.includes('Shows the posts published through BitPype'),
    'the preview explains the sourcing in plain words'
  );
  db.prepare("INSERT INTO leads (id, business_name, email) VALUES (403, 'Fixture Empty Feed', 'emptyfeed@example.invalid')").run();
  db.prepare('INSERT INTO websites (lead_id, name, theme, pages) VALUES (403, ?, ?, ?)').run(
    'Fixture Empty Site',
    '{}',
    homePages
  );
  const embEmpty = sm14.attachModule(db, 403, 'socialfeed', { workspaceId: 1, appUrl: 'https://example.test' }).embed;
  const pubEmpty = sm14.getPublicModuleByToken(db, embEmpty.public_token);
  assert.equal(pubEmpty.items.length, 0, 'a lead with no published posts gets an empty payload (the section renders nothing)');
  sm14.detachModule(db, 401, 'socialfeed');
  assert.throws(
    () => sm14.getPublicModuleByToken(db, embFeed.public_token),
    (e) => e.code === 'NOT_FOUND',
    'detached feed token stops serving'
  );
  check('batch14 public surface: merged published-only payload, preview parity + sourcing note, empty renders nothing, detach kills token', () => {});

  // ── Batch 15: Domain Purchase → Live flow ──
  // Real outreach token roundtrip for the new 'd' (domain) action. Pin a test
  // secret: the gate container sets APP_URL, where the dev fallback is refused.
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'batch15-test-secret';
  const outreachReal = require(path.join(root, 'src/outreach.js'));
  const dTok = outreachReal.signInterestToken({ workspaceId: 1, leadId: 501, action: 'domain' });
  const dVer = outreachReal.verifyInterestToken(dTok);
  assert.equal(dVer.action, 'domain', "action 'd' verifies as domain");
  assert.equal(dVer.workspaceId, 1);
  assert.equal(dVer.leadId, 501);
  const cTok = outreachReal.signInterestToken({ workspaceId: 1, leadId: 501, action: 'claim' });
  assert.equal(outreachReal.verifyInterestToken(cTok).action, 'claim', 'claim action unchanged');
  check('batch15 tokens: real outreach sign/verify roundtrip for the domain action; claim untouched', () => {});

  // cfDomains stub: fixture-priced registrar with call recording.
  const cfCalls = [];
  const cfFixture = {
    'fixturebakery.com': { registrable: true, registrationCost: '12.99', renewalCost: '12.99', currency: 'USD' },
    'fixturebakery.net': { registrable: true, registrationCost: '9.50', renewalCost: '9.50', currency: 'USD' },
    'premiumfixture.com': { registrable: true, registrationCost: '30.00', renewalCost: '30.00', currency: 'USD' },
    'takenfixture.com': { registrable: false, reason: 'Already registered', registrationCost: null, currency: 'USD' },
  };
  let cfRegisterImpl = null; // optional override (db, domain, opts) => result/throw
  let cfRegStatusState = 'succeeded';
  const cfStub = {
    ensureTables: (d) => {
      d.exec(`CREATE TABLE IF NOT EXISTS site_domains (
        id INTEGER PRIMARY KEY AUTOINCREMENT, website_id INTEGER, lead_id INTEGER,
        domain_name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', source TEXT,
        years INTEGER, price TEXT, currency TEXT, pages_project TEXT, public_url TEXT,
        registration_state TEXT, error TEXT, meta TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`);
      try { d.exec('ALTER TABLE websites ADD COLUMN custom_domain TEXT'); } catch { /* exists */ }
    },
    normalizeDomain: (name) => {
      const s = String(name || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      return /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(s) ? s : null;
    },
    recordSearchIntent: () => {},
    searchDomains: async (d, q) => ({
      query: q,
      domains: Object.entries(cfFixture).map(([domain, f]) => ({ domain, ...f })),
    }),
    checkDomains: async (d, names) => ({
      domains: names.map((n) => ({ domain: n, ...(cfFixture[n] || { registrable: false, reason: 'Unknown' }) })),
    }),
    registerDomain: async (d, domain, opts = {}) => {
      cfCalls.push('register:' + domain);
      if (cfRegisterImpl) return cfRegisterImpl(d, domain, opts);
      const f = cfFixture[domain] || {};
      d.prepare("INSERT INTO site_domains (website_id, lead_id, domain_name, status, source, years, price, currency, registration_state) VALUES (?, ?, ?, 'registered', 'registrar', 1, ?, ?, 'succeeded')")
        .run(opts.websiteId != null ? opts.websiteId : null, opts.leadId != null ? opts.leadId : null, domain, f.registrationCost || null, f.currency || 'USD');
      return { domain, status: 'registered', registrationState: 'succeeded', price: f.registrationCost || null, currency: f.currency || 'USD' };
    },
    registrationStatus: async (d, domain) => ({ domain, state: cfRegStatusState, completed: cfRegStatusState === 'succeeded' }),
    // Batch 43: the completion flow's dns step calls the website-scoped
    // ensure + the resolution verifier on the same injected cf surface.
    ensureDomainDnsForWebsite: async (d, opts) => {
      cfCalls.push('dns:' + opts.domain);
      return { zoneId: 'fixture-zone', target: 'fixture-project.pages.dev', created: true, project: 'fixture-project' };
    },
    verifyDomainResolves: async (d, domain, project) => ({ resolved: true, via: 'pages', pagesStatus: 'active', attempts: 1 }),
    linkDomainToWebsite: async (d, opts) => {
      cfCalls.push('link:' + opts.domain);
      if (typeof opts.publishFn === 'function') await opts.publishFn(opts.websiteId, 'fixture-project');
      d.prepare('UPDATE websites SET custom_domain = ? WHERE id = ?').run(opts.domain, opts.websiteId);
      const ex = d.prepare('SELECT id FROM site_domains WHERE domain_name = ? ORDER BY id DESC LIMIT 1').get(opts.domain);
      if (ex) d.prepare("UPDATE site_domains SET status = 'linked', website_id = ?, lead_id = ?, pages_project = 'fixture-project', public_url = ? WHERE id = ?").run(opts.websiteId, opts.leadId != null ? opts.leadId : null, 'https://' + opts.domain, ex.id);
      else d.prepare("INSERT INTO site_domains (website_id, lead_id, domain_name, status, source, pages_project, public_url) VALUES (?, ?, ?, 'linked', 'link', 'fixture-project', ?)").run(opts.websiteId, opts.leadId != null ? opts.leadId : null, opts.domain, 'https://' + opts.domain);
      return { websiteId: opts.websiteId, domain: opts.domain, project: 'fixture-project', publicUrl: 'https://' + opts.domain };
    },
  };
  const outreachStub = {
    signInterestToken: ({ workspaceId, leadId, action }) => `${workspaceId}.${leadId}.${action}`,
    verifyInterestToken: (token) => {
      const [w, l, a] = String(token || '').split('.');
      const action = a === 'd' ? 'domain' : a === 'c' ? 'claim' : a === 'u' ? 'uninterested' : 'interested';
      if (!w || !l || !a) throw Object.assign(new Error('Invalid response link'), { code: 'INVALID_TOKEN' });
      return { workspaceId: Number(w), leadId: Number(l), action };
    },
    getSetting: (d, key, fb) => (key === 'smtp.from_email' ? 'admin@example.test' : fb || ''),
  };
  const df = load('server/domainFlow.js', {
    '../src/cfDomains': cfStub,
    '../src/outreach': outreachStub,
    '../src/claimKit': { buildDomainPickerUrl: (w, l) => `https://app.test/domain-picker.html?t=${w}.${l}.d` },
    './plans': require(path.join(root, 'server/plans.js')),
    './appUrls': { staffUrl: (route, params) => `https://app.test/app#/${route}?txn=${params.txn}` },
  });
  df.ensureTables(db);
  db.prepare("INSERT INTO leads (id, business_name, email, phone, status) VALUES (501, 'Fixture Bakery', 'owner@example.invalid', '5550001111', 'engaged')").run();
  db.prepare('INSERT INTO websites (lead_id, name, theme, pages) VALUES (501, ?, ?, ?)').run('Fixture Bakery Site', '{}', homePages);
  const site501 = db.prepare('SELECT id FROM websites WHERE lead_id = 501').get().id;
  check('batch15 fixtures: domain flow module loads; QA-style lead + site present', () => {});

  // Included-cap rule.
  assert.equal(df.isIncludedPrice(2500, 'USD', 25), true, 'price at cap is included');
  assert.equal(df.isIncludedPrice(2501, 'USD', 25), false, 'price above cap is not included');
  assert.equal(df.isIncludedPrice(1000, 'EUR', 25), false, 'non-USD is never silently included');
  assert.equal(df.isIncludedPrice(null, 'USD', 25), false, 'unpriced is not included');
  const annIn = df.annotateDomain(cfFixture['fixturebakery.com'] && { domain: 'fixturebakery.com', ...cfFixture['fixturebakery.com'] }, 25);
  assert.equal(annIn.selectable, true); assert.equal(annIn.label, 'Included with your plan'); assert.equal(annIn.priceCents, 1299);
  const annPrem = df.annotateDomain({ domain: 'premiumfixture.com', ...cfFixture['premiumfixture.com'] }, 25);
  assert.equal(annPrem.selectable, false); assert.equal(annPrem.label, 'Premium domain — contact us');
  const annTaken = df.annotateDomain({ domain: 'takenfixture.com', ...cfFixture['takenfixture.com'] }, 25);
  assert.equal(annTaken.selectable, false);
  assert.equal(df.priceToCents('12.99'), 1299);
  assert.equal(df.priceToCents(''), null);
  check('batch15 cap rule: ≤ cap selectable + Included label; > cap premium (visible, not selectable); taken/unpriced excluded', () => {});

  // Token gate + picker meta.
  assert.equal(df.verifyDomainToken('1.501.d').leadId, 501);
  assert.throws(() => df.verifyDomainToken('1.501.c'), (e) => e.code === 'INVALID_TOKEN', 'claim token cannot open the picker');
  const meta501 = df.pickerMeta(db, 1, 501);
  assert.equal(meta501.businessName, 'Fixture Bakery Site', 'site brand name wins for the picker');
  assert.equal(meta501.hasCustomDomain, false);
  assert.equal(meta501.openTransaction, null);
  check('batch15 picker meta: token action-gated, site state + no open transaction', () => {});

  // startCheckout — happy path wires the EXISTING billing checkout with metadata.
  let capturedCheckout = null;
  const cpStub = { ensureBillingUserForPortalClient: async () => 777 };
  const billingOk = {
    createCheckoutSession: async (userId, plan, opts) => {
      capturedCheckout = { userId, plan, opts };
      return { action: 'checkout', url: 'https://checkout.stripe.test/session', sessionId: 'cs_test_123', plan };
    },
  };
  const co1 = await df.startCheckout(db, 1, { leadId: 501, domain: 'fixturebakery.com', planId: 'standard' }, { capUsd: 25, clientPortal: cpStub, billing: billingOk });
  assert.equal(co1.unavailable, false);
  assert.equal(co1.checkoutUrl, 'https://checkout.stripe.test/session');
  assert.equal(capturedCheckout.userId, 777);
  assert.equal(capturedCheckout.opts.metadata.domain_transaction_id, String(co1.transaction.id), 'transaction id rides Stripe metadata');
  assert.equal(capturedCheckout.opts.metadata.domain_workspace_id, '1');
  assert(capturedCheckout.opts.successUrl.endsWith('/domain-success.html?domain=fixturebakery.com'), 'success returns to the domain success page');
  assert(capturedCheckout.opts.cancelUrl.includes('domain-picker.html'), 'cancel returns to the picker');
  const txn1 = df.getTransaction(db, co1.transaction.id);
  assert.equal(txn1.status, 'pending_payment');
  assert.equal(txn1.registrar_price_cents, 1299, 'true registrar price stored on the transaction');
  assert.equal(txn1.stripe_session_id, 'cs_test_123');
  assert.equal(txn1.billing_user_id, 777);
  check('batch15 checkout: transaction created pending_payment; plan checkout started with transaction metadata', () => {});

  // Premium + taken domains never reach checkout and create nothing.
  const txnCountBefore = db.prepare('SELECT COUNT(*) AS c FROM domain_transactions').get().c;
  await assert.rejects(
    df.startCheckout(db, 1, { leadId: 501, domain: 'premiumfixture.com', planId: 'standard' }, { capUsd: 25, clientPortal: cpStub, billing: billingOk }),
    (e) => e.code === 'PREMIUM_DOMAIN'
  );
  await assert.rejects(
    df.startCheckout(db, 1, { leadId: 501, domain: 'takenfixture.com', planId: 'standard' }, { capUsd: 25, clientPortal: cpStub, billing: billingOk }),
    (e) => e.code === 'NOT_AVAILABLE'
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM domain_transactions').get().c, txnCountBefore, 'rejected picks create no transaction');
  check('batch15 checkout guards: premium + unavailable domains rejected before any transaction exists', () => {});

  // Dead Stripe price IDs → graceful unavailable state, transaction kept, no fake success.
  const billingDead = {
    createCheckoutSession: async () => {
      throw Object.assign(new Error("No such price: 'price_dead'"), { code: 'STRIPE_ERROR' });
    },
  };
  const co2 = await df.startCheckout(db, 1, { leadId: 501, domain: 'fixturebakery.net', planId: 'pro' }, { capUsd: 25, clientPortal: cpStub, billing: billingDead });
  assert.equal(co2.unavailable, true);
  assert.equal(co2.checkoutUrl, null);
  assert(!/No such price/.test(co2.message), 'client message stays friendly (no Stripe internals)');
  const txn2 = df.getTransaction(db, co2.transaction.id);
  assert.equal(txn2.status, 'pending_payment', 'transaction stays pending_payment when checkout cannot start');
  assert(/No such price/.test(txn2.error), 'the real error is recorded for the admin');
  check('batch15 checkout failure: dead price IDs degrade gracefully — friendly client state, real error on the transaction', () => {});

  // Webhook function (the exact one billing calls) marks paid + emails admin once.
  const sentMail = [];
  const sendMailStub = async (mail) => { sentMail.push(mail); return { sent: true }; };
  const platformStub = { getPlatformSetting: async () => '' };
  const hookSession = {
    id: 'cs_test_123',
    metadata: { domain_transaction_id: String(txn1.id), domain_workspace_id: '1', user_id: '777', plan: 'standard' },
    subscription: 'sub_123',
    customer: 'cus_123',
    amount_total: 9900,
  };
  const hook1 = await df.onDomainCheckoutPaid(hookSession, { openDb: () => db, sendMail: sendMailStub, platform: platformStub });
  assert.equal(hook1.ok, true);
  const txn1Paid = df.getTransaction(db, txn1.id);
  assert.equal(txn1Paid.status, 'paid');
  assert(txn1Paid.paid_at, 'paid_at set');
  assert.equal(txn1Paid.stripe_subscription_id, 'sub_123');
  assert.equal(txn1Paid.stripe_customer_id, 'cus_123');
  assert.equal(txn1Paid.amount_paid_cents, 9900);
  assert.equal(sentMail.length, 2, 'one admin email + one client payment email (Batch 36)');
  const adminMail = sentMail.find((m) => m.to === 'admin@example.test');
  const clientPaidMail = sentMail.find((m) => m.to === 'owner@example.invalid');
  assert(adminMail, 'admin email sent');
  assert.equal(adminMail.to, 'admin@example.test', 'admin email goes to the resolved report address');
  assert(adminMail.subject.includes('fixturebakery.com'), 'subject names the chosen domain');
  assert(JSON.stringify(adminMail).includes(`#/domains?txn=${txn1.id}`), 'email deep-links the transaction');
  assert(JSON.stringify(adminMail).includes('$12.99'), 'email shows the true registrar cost');
  assert(clientPaidMail, 'client payment-received email sent at paid time (Batch 36)');
  assert(clientPaidMail.subject.includes('Payment received'), 'client email is the payment confirmation');
  assert(JSON.stringify(clientPaidMail).includes('fixturebakery.com'), 'client email names the chosen domain');
  const hook2 = await df.onDomainCheckoutPaid(hookSession, { openDb: () => db, sendMail: sendMailStub, platform: platformStub });
  assert.equal(hook2.duplicate, true, 'repeat webhook is a no-op');
  assert.equal(sentMail.length, 2, 'no second admin or client email');
  const hookSkip = await df.onDomainCheckoutPaid({ metadata: { user_id: '5' } }, { openDb: () => db, sendMail: sendMailStub, platform: platformStub });
  assert.equal(hookSkip.skipped, true, 'sessions without domain metadata are ignored');
  // Composer dry-run (the QA path): same content without sending.
  const composed = await df.composeAdminPaidEmail(db, 1, txn1.id, { platform: platformStub });
  assert.equal(composed.to, 'admin@example.test');
  assert(composed.paragraphs.join(' ').includes('Fixture Bakery Site'));
  check('batch15 webhook: paid marks the right transaction via metadata, one admin email with deep link + registrar cost, idempotent (Batch 36 adds the client payment email)', () => {});

  // Completion orchestration with stubbed registrar + publish.
  cfCalls.length = 0;
  const publishCalls = [];
  const completeDeps = {
    cf: cfStub,
    publishSite: async (d, websiteId, project) => { publishCalls.push(websiteId); cfCalls.push('publish'); },
    sendMail: sendMailStub,
  };
  const done1 = await df.completeTransaction(db, 1, txn1.id, completeDeps);
  assert.equal(done1.completed, true);
  assert.equal(done1.transaction.status, 'live');
  assert(done1.transaction.completedAt, 'completed_at set');
  const regIdx = cfCalls.indexOf('register:fixturebakery.com');
  const linkIdx = cfCalls.indexOf('link:fixturebakery.com');
  assert(regIdx >= 0 && linkIdx > regIdx, 'register runs before link');
  assert(publishCalls.length === 1 && publishCalls[0] === site501, 'publish runs inside the link step');
  assert.equal(db.prepare('SELECT custom_domain FROM websites WHERE id = ?').get(site501).custom_domain, 'fixturebakery.com');
  const liveMail = sentMail[sentMail.length - 1];
  assert.equal(liveMail.to, 'owner@example.invalid', 'client gets the live email');
  assert(liveMail.subject.includes('fixturebakery.com'));
  const doneAgain = await df.completeTransaction(db, 1, txn1.id, completeDeps);
  assert.equal(doneAgain.already, true, 'completing a live transaction is a no-op');
  assert.equal(cfCalls.filter((c) => c === 'register:fixturebakery.com').length, 1, 'no duplicate registration');
  assert.equal(df.pickerMeta(db, 1, 501).hasCustomDomain, true, 'picker now reports the site as domained');
  check('batch15 completion: register → publish+link → live, client emailed, fully idempotent on repeat', () => {});

  // Completion guards + failure/retry semantics.
  const txnPending = df.createTransaction(db, { leadId: 501, websiteId: site501, domain: 'fixturebakery.net', registrarPriceCents: 950, registrarCurrency: 'USD', planId: 'pro' });
  await assert.rejects(df.completeTransaction(db, 1, txnPending.id, completeDeps), (e) => e.code === 'INVALID_STATE', 'unpaid transaction cannot be completed');
  df.markPaid(db, txnPending.id, { subscriptionId: 'sub_9', customerId: 'cus_9', amountCents: 16900 });
  cfRegisterImpl = () => { throw Object.assign(new Error('Cloudflare boom'), { code: 'CF_ERROR' }); };
  const failTry = await df.completeTransaction(db, 1, txnPending.id, completeDeps);
  assert.equal(failTry.completed, false);
  assert.equal(failTry.transaction.status, 'failed');
  assert.equal(failTry.transaction.error, 'Cloudflare boom', 'the failing step error is stored verbatim');
  cfRegisterImpl = null;
  const retryTry = await df.completeTransaction(db, 1, txnPending.id, completeDeps);
  assert.equal(retryTry.completed, true, 'retry after failure completes');
  assert.equal(retryTry.transaction.status, 'live');
  check('batch15 completion failure: step error stored, status failed, retry completes', () => {});

  // Registration already in progress at CF: fail clean, then succeed by polling (no re-register).
  const txnProg = df.createTransaction(db, { leadId: 501, websiteId: site501, domain: 'fixturebakery.net', registrarPriceCents: 950, registrarCurrency: 'USD', planId: 'standard' });
  df.markPaid(db, txnProg.id, { subscriptionId: 'sub_10', customerId: 'cus_10', amountCents: 9900 });
  db.prepare("INSERT INTO site_domains (website_id, lead_id, domain_name, status, source, registration_state) VALUES (?, 501, 'progfixture.com', 'registering', 'registrar', 'in_progress')").run(site501);
  const txnProg2 = df.createTransaction(db, { leadId: 501, websiteId: site501, domain: 'progfixture.com', registrarPriceCents: 1100, registrarCurrency: 'USD', planId: 'standard' });
  df.markPaid(db, txnProg2.id, { subscriptionId: 'sub_11', customerId: 'cus_11', amountCents: 9900 });
  cfRegStatusState = 'in_progress';
  cfCalls.length = 0;
  const progTry = await df.completeTransaction(db, 1, txnProg2.id, completeDeps);
  assert.equal(progTry.completed, false);
  assert.equal(progTry.code, 'IN_PROGRESS');
  assert(!cfCalls.includes('register:progfixture.com'), 'no duplicate registration while CF is processing');
  cfRegStatusState = 'succeeded';
  const progDone = await df.completeTransaction(db, 1, txnProg2.id, completeDeps);
  assert.equal(progDone.completed, true, 'once CF confirms, completion proceeds without re-registering');
  assert(!cfCalls.includes('register:progfixture.com'), 'registration step was skipped via status poll');
  check('batch15 completion in-progress: CF registering state blocks duplicate registration, poll confirms, retry links', () => {});

  // Admin list/detail + cross-workspace scoping (a foreign db knows nothing).
  const list = df.adminList(db, {});
  assert(list.transactions.length >= 4, 'admin list returns the workspace transactions');
  assert.equal(list.transactions[0].domain, 'progfixture.com', 'newest first');
  const detail = df.adminDetail(db, txn1.id);
  assert.equal(detail.lead.email, 'owner@example.invalid');
  assert.equal(detail.transaction.domain, 'fixturebakery.com');
  assert.equal(detail.website.id, site501);
  assert(detail.website.customDomain, 'website carries a linked custom domain');
  assert(detail.staffLink.includes('txn=' + txn1.id));
  const foreignDb = new Database(':memory:');
  foreignDb.exec('CREATE TABLE leads (id INTEGER PRIMARY KEY, business_name TEXT, email TEXT, phone TEXT, status TEXT)');
  foreignDb.exec('CREATE TABLE websites (id INTEGER PRIMARY KEY, lead_id INTEGER, name TEXT, custom_domain TEXT, preview_url TEXT, status TEXT)');
  df.ensureTables(foreignDb);
  assert.equal(df.adminList(foreignDb, {}).transactions.length, 0, 'transactions are workspace-scoped');
  assert.throws(() => df.adminDetail(foreignDb, txn1.id), (e) => e.code === 'NOT_FOUND');
  foreignDb.close();
  check('batch15 admin views: list newest-first with joins, detail carries client/site/payment, foreign workspace sees nothing', () => {});

  // ── Batch 16: Membership — site user accounts, sessions, page gating ──
  const sm16 = load('server/siteModules.js', {
    '../src/pageContentScan': require(path.join(root, 'src/pageContentScan.js')),
    '../src/websiteEngine': require(path.join(root, 'src/websiteEngine.js')),
    './portalContacts': contacts,
  });
  sm16.ensureTables(db);
  assert(sm16.MODULE_META.members, 'meta for members');
  assert.equal(sm16.MODULE_META.members.label, 'Membership');
  assert.equal(sm16.MODULE_TYPES.length, 29, 'members was the 18th module type; calltracking the 19th; googlereviews the 20th; datatables the 21st; charts the 22nd; newsletter the 23rd; categories the 24th; photocapture the 25th; checkout the 27th; comments the 28th; pricing the 29th');
  assert.equal(sm16.MODULE_TYPES.includes('members'), true);
  check('batch16 catalog: members registered as the 18th module type', () => {});

  // Fixture site: sections pages — home (public) + about (to be gated).
  db.prepare("INSERT INTO leads (id, business_name, email) VALUES (1601, 'Fixture Members', 'members@example.invalid')").run();
  db.prepare("INSERT INTO leads (id, business_name, email) VALUES (1602, 'Fixture Members Two', 'two@example.invalid')").run();
  const MARKER16 = 'MEMBERS_ONLY_MARKER_7f3a9';
  const pages1601 = [
    { slug: 'index', title: 'Home', sections: [{ type: 'nav', content: {} }, { type: 'html', content: { html: '<p>Welcome home</p>' } }, { type: 'footer', content: {} }] },
    { slug: 'about', title: 'About', sections: [{ type: 'nav', content: {} }, { type: 'html', content: { html: `<p>${MARKER16} secret about body</p>` } }, { type: 'footer', content: {} }] },
  ];
  db.prepare('INSERT INTO websites (lead_id, name, theme, pages) VALUES (1601, ?, ?, ?)').run(
    'Members Fixture Site',
    '{}',
    JSON.stringify(pages1601)
  );
  const embMembers16 = sm16.attachModule(db, 1601, 'members', { workspaceId: 1, appUrl: 'https://example.test' }).embed;
  assert(embMembers16 && embMembers16.public_token, 'members attach returns a token');
  const embBlog16 = sm16.attachModule(db, 1601, 'blog', { workspaceId: 1, appUrl: 'https://example.test' }).embed;
  sm16.createBlogPost(db, 1601, { title: 'Members Post', body_html: '<p>hello members</p>', status: 'published' });

  // Config defaults.
  const cfg16Default = sm16.getMembersConfig(db, 1601);
  assert.equal(cfg16Default.gate_mode, 'off');
  assert.equal(cfg16Default.signup_mode, 'open');
  assert(cfg16Default.wall_headline.length > 0, 'wall headline has a sane default');
  assert.throws(() => sm16.updateMembersConfig(db, 1601, { gate_mode: 'sometimes' }), (e) => e.code === 'VALIDATION');
  assert.throws(() => sm16.updateMembersConfig(db, 1601, { signup_mode: 'maybe' }), (e) => e.code === 'VALIDATION');
  check('batch16 config: honest defaults, enum validation', () => {});

  // Signup + hashing at rest + session lifecycle.
  assert.throws(() => sm16.signupMember(db, 1601, { name: 'A', email: 'a@b.co', password: 'short' }), (e) => e.code === 'VALIDATION', 'short password rejected server-side');
  assert.throws(() => sm16.signupMember(db, 1601, { name: 'A', email: 'not-an-email', password: 'password123' }), (e) => e.code === 'VALIDATION');
  const su16 = sm16.signupMember(db, 1601, { name: 'Pat Member', email: 'Pat@Example.com', password: 'password123' });
  assert.equal(su16.member.email, 'pat@example.com', 'email normalized');
  assert.equal(su16.member.status, 'active');
  assert(su16.session && su16.session.token, 'open signup starts a session');
  assert(!('password_hash' in su16.member), 'public member shape carries no hash');
  const stored16 = db.prepare('SELECT * FROM site_members WHERE id = ?').get(su16.member.id);
  assert(stored16.password_hash !== 'password123' && !stored16.password_hash.includes('password123'), 'password never stored in plaintext');
  assert(stored16.password_hash.startsWith('$2'), 'bcrypt hash at rest (platform scheme)');
  const sessRow16 = db.prepare('SELECT * FROM site_member_sessions WHERE member_id = ? ORDER BY id DESC LIMIT 1').get(su16.member.id);
  assert(sessRow16 && sessRow16.token_hash !== su16.session.token && sessRow16.token_hash.length === 64, 'session token stored as sha256 hash only');
  assert.throws(() => sm16.signupMember(db, 1601, { name: 'Pat Two', email: 'PAT@example.com', password: 'password123' }), (e) => e.code === 'EMAIL_TAKEN', 'duplicate email per lead rejected (case-insensitive)');
  check('batch16 signup: validation, bcrypt at rest, session token hashed at rest, duplicate email rejected', () => {});

  // Login semantics: no enumeration, session resolution, lead scoping, logout.
  assert.throws(() => sm16.loginMember(db, 1601, { email: 'pat@example.com', password: 'wrong-password' }), (e) => e.code === 'INVALID_CREDENTIALS');
  assert.throws(() => sm16.loginMember(db, 1601, { email: 'ghost@example.com', password: 'password123' }), (e) => e.code === 'INVALID_CREDENTIALS', 'unknown email gives the same generic error');
  const li16 = sm16.loginMember(db, 1601, { email: 'pat@example.com', password: 'password123' });
  assert(li16.session.token, 'login returns a session');
  assert.equal(sm16.getSessionMember(db, 1601, li16.session.token).email, 'pat@example.com');
  assert.equal(sm16.getSessionMember(db, 1602, li16.session.token), null, 'a session only ever resolves inside its own lead');
  sm16.logoutMember(db, 1601, li16.session.token);
  assert.equal(sm16.getSessionMember(db, 1601, li16.session.token), null, 'logout deletes the session');
  check('batch16 login: generic credential errors, lead-scoped sessions, logout kills the session', () => {});

  // Approval flow: pending cannot log in until the owner approves.
  sm16.updateMembersConfig(db, 1601, { signup_mode: 'approval' });
  const suPam = sm16.signupMember(db, 1601, { name: 'Pending Pam', email: 'pam@example.com', password: 'password123' });
  assert.equal(suPam.pending, true);
  assert.equal(suPam.session, null, 'pending members get no session');
  assert.throws(() => sm16.loginMember(db, 1601, { email: 'pam@example.com', password: 'password123' }), (e) => e.code === 'MEMBER_PENDING');
  sm16.setSiteMemberStatus(db, 1601, suPam.member.id, 'active');
  const liPam = sm16.loginMember(db, 1601, { email: 'pam@example.com', password: 'password123' });
  assert(liPam.session.token, 'approved member can log in');
  sm16.setSiteMemberStatus(db, 1601, suPam.member.id, 'disabled');
  assert.equal(sm16.getSessionMember(db, 1601, liPam.session.token), null, 'disabling a member kills their live sessions');
  assert.throws(() => sm16.loginMember(db, 1601, { email: 'pam@example.com', password: 'password123' }), (e) => e.code === 'MEMBER_DISABLED');
  sm16.setSiteMemberStatus(db, 1601, suPam.member.id, 'active');
  sm16.updateMembersConfig(db, 1601, { signup_mode: 'open' });
  check('batch16 approval flow: pending blocked, approve unlocks, disable kills sessions + login', () => {});

  // Password reset: hashed single-use token, sessions invalidated, dry-run mail.
  const liPreReset = sm16.loginMember(db, 1601, { email: 'pat@example.com', password: 'password123' });
  const rr16 = sm16.requestMemberReset(db, 1601, 'pat@example.com');
  assert(rr16 && rr16.resetToken, 'reset request issues a token');
  const mail16 = sm16.buildMemberResetMail(db, 1601, rr16.member, rr16.resetToken, 'https://example.test');
  assert.equal(mail16.to, 'pat@example.com');
  assert(mail16.cta.url.startsWith('https://example.test/member-reset.html?t='), 'reset mail links the platform reset page with the module token');
  assert(mail16.cta.url.includes('&r=' + rr16.resetToken), 'reset mail carries the raw reset token');
  const resetRow16 = db.prepare('SELECT * FROM site_member_reset_tokens WHERE member_id = ? ORDER BY id DESC LIMIT 1').get(su16.member.id);
  assert(resetRow16.token_hash !== rr16.resetToken && resetRow16.token_hash.length === 64, 'reset token hashed at rest');
  assert.equal(sm16.requestMemberReset(db, 1601, 'ghost@example.com'), null, 'unknown email composes nothing (route answers uniformly)');
  assert.throws(() => sm16.resetMemberPassword(db, 1601, rr16.resetToken, 'short'), (e) => e.code === 'VALIDATION');
  sm16.resetMemberPassword(db, 1601, rr16.resetToken, 'newpassword99');
  assert.equal(sm16.getSessionMember(db, 1601, liPreReset.session.token), null, 'a reset invalidates existing sessions');
  assert.throws(() => sm16.resetMemberPassword(db, 1601, rr16.resetToken, 'anotherpass1'), (e) => e.code === 'RESET_INVALID', 'reset token is single-use');
  assert.throws(() => sm16.loginMember(db, 1601, { email: 'pat@example.com', password: 'password123' }), (e) => e.code === 'INVALID_CREDENTIALS', 'old password is dead after reset');
  const liPat = sm16.loginMember(db, 1601, { email: 'pat@example.com', password: 'newpassword99' });
  assert(liPat.session.token, 'new password works');
  check('batch16 reset: hashed single-use token, sessions invalidated, dry-run mail composition', () => {});

  // A foreign lead's member — the cross-lead probe for every gate below.
  const suForeign = sm16.signupMember(db, 1602, { name: 'Foreign Fran', email: 'fran@example.com', password: 'password123' });
  assert(suForeign.session && suForeign.session.token);

  // Gating — selected mode on the about page.
  sm16.updateMembersConfig(db, 1601, { gate_mode: 'selected', gated_pages: ['about'], wall_headline: 'Members only beyond this point' });
  assert.equal(sm16.pageIsGated(db, 1601, 'about'), true);
  assert.equal(sm16.pageIsGated(db, 1601, 'index'), false);
  assert.equal(sm16.pageIsGated(db, 1601, 'members'), false, 'the members page itself is always public');
  const lockedPayload16 = sm16.getPublicModuleByToken(db, embBlog16.public_token, { pageSlug: 'about' });
  assert.equal(lockedPayload16.locked, true, 'module payload on a gated page locks');
  assert.equal(lockedPayload16.items.length, 0, 'locked payload carries zero items');
  assert(!JSON.stringify(lockedPayload16).includes('Members Post'), 'locked payload leaks no content');
  assert.equal(lockedPayload16.gate.wall_headline, 'Members only beyond this point');
  assert.equal(lockedPayload16.gate.members_token, embMembers16.public_token, 'wall points at the members module for login');
  const openPayload16 = sm16.getPublicModuleByToken(db, embBlog16.public_token, { pageSlug: 'about', memberSession: liPat.session.token });
  assert(!openPayload16.locked && openPayload16.items.length === 1, 'a valid session unlocks the payload');
  const foreignPayload16 = sm16.getPublicModuleByToken(db, embBlog16.public_token, { pageSlug: 'about', memberSession: suForeign.session.token });
  assert.equal(foreignPayload16.locked, true, 'a foreign lead session unlocks nothing');
  assert.equal(foreignPayload16.items.length, 0);
  const membersPayload16 = sm16.getPublicModuleByToken(db, embMembers16.public_token, { memberSession: liPat.session.token });
  assert.equal(membersPayload16.module_type, 'members');
  assert.equal(membersPayload16.members.member.email, 'pat@example.com', 'members payload carries the caller’s own state');
  assert.equal(sm16.getPublicModuleByToken(db, embMembers16.public_token).members.member, null, 'anonymous members payload has no member');
  check('batch16 payload gating: locked = zero items + wall copy; session unlocks; cross-lead unlocks nothing', () => {});

  // Export shell — the leak assertion: gated page HTML contains NONE of the body.
  const eng16 = require(path.join(root, 'src/websiteEngine.js'));
  const storedPages16 = JSON.parse(db.prepare('SELECT pages FROM websites WHERE lead_id = 1601').get().pages);
  assert(JSON.stringify(storedPages16).includes(MARKER16), 'fixture body carries the marker before export');
  const gatedPages16 = sm16.gateExportPages(db, 1601, storedPages16, { appUrl: 'https://example.test' });
  const aboutExport16 = gatedPages16.find((p) => p.slug === 'about');
  const aboutHtml16 = eng16.renderPage(aboutExport16, gatedPages16, {}, {});
  assert(!aboutHtml16.includes(MARKER16), 'exported gated page contains NONE of the authored body');
  assert(aboutHtml16.includes('data-bitpype-member-gate'), 'exported gated page is a shell carrying the gate mount');
  const homeExport16 = gatedPages16.find((p) => p.slug === 'index');
  assert(eng16.renderPage(homeExport16, gatedPages16, {}, {}).includes('Welcome home'), 'un-gated pages export exactly as before');
  const storedAfter16 = JSON.parse(db.prepare('SELECT pages FROM websites WHERE lead_id = 1601').get().pages);
  assert(JSON.stringify(storedAfter16).includes(MARKER16), 'stored pages keep the real body — the gate is export-only');
  check('batch16 export shell: gated page ships no body (marker absent), un-gated untouched, DB unchanged', () => {});

  // Body API: locked anonymously, served to the member, never cross-lead.
  assert.throws(() => sm16.getMemberPageBody(db, 1601, 'about'), (e) => e.code === 'MEMBER_LOCKED' && e.status === 401, 'body API refuses anonymous reads');
  assert.throws(() => sm16.getMemberPageBody(db, 1601, 'about', { memberSession: suForeign.session.token }), (e) => e.code === 'MEMBER_LOCKED', 'body API refuses foreign sessions');
  const body16 = sm16.getMemberPageBody(db, 1601, 'about', { memberSession: liPat.session.token });
  assert(body16.html.includes(MARKER16), 'a valid member session receives the real body');
  const grant16 = sm16.memberPreviewGrantFor(db, 1601);
  assert(grant16, 'owner preview grant minted while gating is active');
  const grantRow16 = db.prepare('SELECT * FROM site_member_preview_grants WHERE lead_id = 1601 ORDER BY id DESC LIMIT 1').get();
  assert(grantRow16.token_hash !== grant16 && grantRow16.token_hash.length === 64, 'preview grant hashed at rest');
  assert(sm16.getMemberPageBody(db, 1601, 'about', { previewGrant: grant16 }).html.includes(MARKER16), 'preview grant unlocks for the owner');
  assert.equal(sm16.verifyMemberPreviewGrant(db, 1602, grant16), false, 'preview grant is lead-scoped');
  check('batch16 body API + preview grant: member-only body serving, hashed lead-scoped owner bypass', () => {});

  // Whole-site mode + gate off.
  sm16.updateMembersConfig(db, 1601, { gate_mode: 'whole_site', public_pages: ['index'] });
  assert.equal(sm16.pageIsGated(db, 1601, 'index'), false, 'whole-site exception stays public');
  assert.equal(sm16.pageIsGated(db, 1601, 'about'), true);
  assert.equal(sm16.pageIsGated(db, 1601, 'members'), false);
  sm16.updateMembersConfig(db, 1601, { gate_mode: 'off' });
  assert.equal(sm16.pageIsGated(db, 1601, 'about'), false, 'gate off opens everything');
  assert.equal(sm16.memberPreviewGrantFor(db, 1601), null, 'no preview grant when the gate is off');
  const ungatedPayload16 = sm16.getPublicModuleByToken(db, embBlog16.public_token, { pageSlug: 'about' });
  assert(!ungatedPayload16.locked && ungatedPayload16.items.length === 1, 'un-gated sites behave exactly as before');
  check('batch16 gate modes: whole-site with exceptions, off restores open behavior', () => {});

  // Owner management: counts, search, hash-free lists, delete cleans sessions.
  const counts16 = sm16.countSiteMembers(db, 1601);
  assert.equal(counts16.total, 2);
  assert.equal(counts16.active, 2);
  assert.equal(sm16.moduleItemCount(db, 1601, 'members'), 2, 'tab badge counts active members');
  const listed16 = sm16.listSiteMembers(db, 1601, { search: 'pam@' });
  assert.equal(listed16.length, 1);
  assert.equal(listed16[0].email, 'pam@example.com');
  assert(!('password_hash' in listed16[0]), 'owner member list never carries password hashes');
  const liPam2 = sm16.loginMember(db, 1601, { email: 'pam@example.com', password: 'password123' });
  sm16.deleteSiteMember(db, 1601, suPam.member.id);
  assert.equal(sm16.getSessionMember(db, 1601, liPam2.session.token), null, 'deleting a member ends their sessions');
  assert.equal(sm16.countSiteMembers(db, 1601).total, 1);
  assert.throws(() => sm16.setSiteMemberStatus(db, 1601, suPam.member.id, 'active'), (e) => e.code === 'NOT_FOUND');
  check('batch16 owner management: counts, search, hash-free list, delete cleans up sessions', () => {});

  // ── Batch 17: Membership Part 2 — owner Stripe keys, tiers, subscriptions, comps ──
  // Faithful mini secretBox (same enc:v1 AES-256-GCM format) so the
  // at-rest assertions exercise the real encrypt/decrypt call path.
  const crypto17 = require('node:crypto');
  const boxKey17 = crypto17.randomBytes(32);
  const box17 = {
    PREFIX: 'enc:v1:',
    hasKey: () => true,
    isEncrypted: (v) => typeof v === 'string' && v.startsWith('enc:v1:'),
    encryptValue(plain) {
      if (plain == null || plain === '' || box17.isEncrypted(plain)) return plain;
      const iv = crypto17.randomBytes(12);
      const cipher = crypto17.createCipheriv('aes-256-gcm', boxKey17, iv);
      const body = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
      return 'enc:v1:' + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
    },
    decryptValue(stored) {
      if (!box17.isEncrypted(stored)) return stored;
      const buf = Buffer.from(stored.slice('enc:v1:'.length), 'base64');
      const decipher = crypto17.createDecipheriv('aes-256-gcm', boxKey17, buf.subarray(0, 12));
      decipher.setAuthTag(buf.subarray(12, 28));
      return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
    },
    encryptSetting: (k, v) => box17.encryptValue(v),
    decryptSetting: (k, v) => box17.decryptValue(v),
  };
  // Stub Stripe: no real API calls anywhere in this suite.
  const stub17 = { priceSeq: 0, productSeq: 0, balanceCalls: 0, checkoutParams: [], subUpdates: [], failPrices: false, failBalance: false };
  const stubStripeClient17 = {
    checkout: {
      sessions: {
        create: async (params) => {
          stub17.checkoutParams.push(params);
          return { id: 'cs_test_17', url: 'https://checkout.stripe.test/cs_test_17' };
        },
      },
    },
    products: {
      create: async () => ({ id: 'prod_' + ++stub17.productSeq }),
      retrieve: async (id) => ({ id }),
    },
    prices: {
      create: async () => {
        if (stub17.failPrices) throw new Error('Stripe price boom (stub)');
        return { id: 'price_' + ++stub17.priceSeq };
      },
      // Batch 129: the membership checkout verifies the tier's price
      // exists on the resolved payments account before using it.
      retrieve: async (id) => ({ id }),
    },
    subscriptions: {
      update: async (id, params) => {
        stub17.subUpdates.push([id, params]);
        return { id };
      },
    },
    webhooks: {
      constructEvent: (body, sig, secret) => {
        if (sig !== 'sig:' + secret) throw new Error('No signatures found matching the expected signature for payload.');
        return JSON.parse(Buffer.isBuffer(body) ? body.toString('utf8') : String(body));
      },
    },
    balance: {
      retrieve: async () => {
        stub17.balanceCalls++;
        if (stub17.failBalance) throw new Error('Stripe balance boom (stub)');
        return { available: [{ amount: 12345, currency: 'usd' }], pending: [{ amount: 500, currency: 'usd' }] };
      },
    },
    payouts: {
      list: async () => ({ data: [{ amount: 5000, currency: 'usd', status: 'paid', arrival_date: 1761000000 }] }),
    },
  };
  function StubStripe17() {
    return stubStripeClient17;
  }
  const sm17 = load('server/siteModules.js', {
    '../src/pageContentScan': require(path.join(root, 'src/pageContentScan.js')),
    '../src/websiteEngine': require(path.join(root, 'src/websiteEngine.js')),
    './portalContacts': contacts,
    '../src/secretBox': box17,
    // Batch 129: the membership checkout also calls
    // ensureTierStripePrice (the tier-price account self-heal);
    // forward it to the real module loaded just below.
    './membershipStripe': {
      getClient: () => stubStripeClient17,
      ensureTierStripePrice: (...args) => ms17.ensureTierStripePrice(...args),
    },
  });
  const ms17 = load('server/membershipStripe.js', {
    './siteModules': sm17,
    '../src/secretBox': box17,
    stripe: StubStripe17,
  });
  sm17.ensureTables(db);
  assert.equal(sm17.MODULE_TYPES.length, 29, 'catalog 29 types (Batch 125: photocapture is the 25th; Batch 128: checkout is the 27th; Batch 131: comments is the 28th; Batch 139: pricing is the 29th)');
  assert.equal(sm17.MODULE_SCRIPT_VER, 'mod39', 'script version: batch 20 mod13, batch 21 mod14, batch 26 mod15, batch 25c mod16, batch 25c-fix mod17, batch 30 mod18, batch 31 mod19, batch 32 mod20');
  const cfg17Default = sm17.getMembersConfig(db, 1701);
  assert.equal(cfg17Default.access_level, 'any_member', 'Part 1 default preserved: any member');
  assert.equal(cfg17Default.access_tier_id, null);
  check('batch17 catalog + defaults: 18 types, script mod13 (batch 20), access_level defaults to any_member', () => {});

  // Fixture: lead 1701 (site + members + blog) and foreign lead 1702.
  db.prepare("INSERT INTO leads (id, business_name, email) VALUES (1701, 'Fixture Paid Members', 'paid@example.invalid')").run();
  db.prepare("INSERT INTO leads (id, business_name, email) VALUES (1702, 'Fixture Foreign Paid', 'foreign2@example.invalid')").run();
  const MARKER17 = 'PAID_MEMBERS_MARKER_3c51e';
  const pages1701 = [
    { slug: 'index', title: 'Home', sections: [{ type: 'nav', content: {} }, { type: 'html', content: { html: '<p>Home</p>' } }, { type: 'footer', content: {} }] },
    { slug: 'about', title: 'About', sections: [{ type: 'nav', content: {} }, { type: 'html', content: { html: `<p>${MARKER17} paid body</p>` } }, { type: 'footer', content: {} }] },
  ];
  db.prepare('INSERT INTO websites (lead_id, name, theme, pages) VALUES (1701, ?, ?, ?)').run('Paid Fixture Site', '{}', JSON.stringify(pages1701));
  const embMembers17 = sm17.attachModule(db, 1701, 'members', { workspaceId: 1, appUrl: 'https://example.test' }).embed;
  const embBlog17 = sm17.attachModule(db, 1701, 'blog', { workspaceId: 1, appUrl: 'https://example.test' }).embed;
  sm17.createBlogPost(db, 1701, { title: 'Paid Post', body_html: '<p>paid hello</p>', status: 'published' });

  // Per-lead keys: encrypted at rest, status never leaks, cross-lead isolation.
  const SECRET17 = 'sk_test_4eC39HqLyjWDarjtT1zdp7dc';
  const status1702 = sm17.saveMembershipStripeKeys(db, 1702, {
    publishable_key: 'pk_test_51H7example',
    secret_key: SECRET17,
    webhook_secret: 'whsec_foreign_secret',
  });
  assert.equal(status1702.connected, true);
  assert.equal(status1702.secret_key_last4, 'p7dc');
  assert(!JSON.stringify(status1702).includes(SECRET17), 'status never carries the secret');
  // Batch 129: the save now writes the ONE unified payments config
  // (lead_payment_configs); the legacy membership key store is a
  // read-only fallback. The at-rest encryption assertions are
  // unchanged — the unified write path uses the same secretBox format.
  const rawKeyRow17 = db.prepare('SELECT * FROM lead_payment_configs WHERE lead_id = 1702').get();
  assert(rawKeyRow17.secret_key_enc.startsWith('enc:v1:'), 'secret stored secretBox-encrypted');
  assert(!rawKeyRow17.secret_key_enc.includes(SECRET17), 'ciphertext contains no plaintext key');
  assert(!rawKeyRow17.webhook_secret_enc.includes('whsec_foreign_secret'), 'webhook secret encrypted too');
  assert.equal(ms17.getCredentials(db, 1702).secretKey, SECRET17, 'decrypt round-trips for the owning lead');
  assert.equal(sm17.membershipStripeStatus(db, 1701).connected, false, 'keys are per-lead: 1701 has none');
  assert.throws(() => ms17.getClient(db, 1701), (e) => e.code === 'MEMBERSHIP_STRIPE_NOT_CONFIGURED');
  assert.throws(() => sm17.saveMembershipStripeKeys(db, 1701, { secret_key: 'not-a-key' }), (e) => e.code === 'VALIDATION');
  check('batch17 keys: encrypted at rest, status leaks nothing, decrypt is lead-scoped', () => {});

  // Tiers without keys: paid saves INACTIVE; free works keyless.
  const goldDraft = await ms17.saveMembershipTier(db, 1701, { name: 'Gold', price: 20, interval: 'month', active: true });
  assert.equal(goldDraft.stripe_state, 'not_connected');
  assert.equal(goldDraft.tier.active, false, 'paid tier without keys stays inactive');
  const clubFree = await ms17.saveMembershipTier(db, 1701, { name: 'Club', price: 0, interval: 'month', active: true });
  assert.equal(clubFree.stripe_state, 'free');
  assert.equal(clubFree.tier.active, true, 'free tier activates with no keys at all');
  const silverFree = await ms17.saveMembershipTier(db, 1701, { name: 'Silver', price: 0, active: true });
  check('batch17 tiers keyless: paid tier inactive with connect-Stripe state, free tiers live', () => {});

  // Connect 1701's keys, then the paid tier mints its Stripe Price on save.
  sm17.saveMembershipStripeKeys(db, 1701, {
    publishable_key: 'pk_test_paid51',
    secret_key: 'sk_test_paid51secret',
    webhook_secret: 'whsec_paid51',
  });
  const goldLive = await ms17.saveMembershipTier(db, 1701, { price: 25, active: true }, goldDraft.tier.id);
  assert.equal(goldLive.stripe_state, 'connected');
  assert.equal(goldLive.tier.active, true);
  assert.equal(goldLive.tier.stripe_price_id, 'price_1', 'first save mints the Stripe price');
  assert(goldLive.tier.stripe_product_id.startsWith('prod_'));
  const goldRepriced = await ms17.saveMembershipTier(db, 1701, { price: 30 }, goldDraft.tier.id);
  assert.equal(goldRepriced.tier.stripe_price_id, 'price_2', 'a price change mints a NEW Stripe price');
  assert.equal(goldRepriced.tier.price_cents, 3000);
  stub17.failPrices = true;
  await assert.rejects(
    ms17.saveMembershipTier(db, 1701, { name: 'Platinum', price: 50, active: true }),
    /Stripe price boom/,
    'Stripe rejection surfaces the real error'
  );
  stub17.failPrices = false;
  assert.equal(sm17.listMembershipTiers(db, 1701, { includeInactive: true }).some((t) => t.name === 'Platinum'), false, 'rejected tier was not half-saved');
  check('batch17 tiers with keys: price minted on save, repricing mints anew, Stripe failure saves nothing', () => {});

  // Members + paid gate (any_paid).
  const memberA17 = sm17.signupMember(db, 1701, { name: 'Payer Pat', email: 'payer@example.com', password: 'password123' });
  const memberB17 = sm17.signupMember(db, 1701, { name: 'Free Fran', email: 'fran2@example.com', password: 'password123' });
  sm17.updateMembersConfig(db, 1701, { gate_mode: 'selected', gated_pages: ['about'], access_level: 'any_paid' });
  const lockedAnon17 = sm17.getPublicModuleByToken(db, embBlog17.public_token, { pageSlug: 'about' });
  assert.equal(lockedAnon17.locked, true);
  assert.equal(lockedAnon17.gate.needs, 'login', 'anonymous wall asks for login');
  const lockedB17 = sm17.getPublicModuleByToken(db, embBlog17.public_token, { pageSlug: 'about', memberSession: memberB17.session.token });
  assert.equal(lockedB17.locked, true);
  assert.equal(lockedB17.gate.needs, 'subscription', 'a logged-in non-payer gets the join wall, not a login form');
  assert.equal(lockedB17.gate.member.email, 'fran2@example.com');
  assert.equal(lockedB17.items.length, 0);
  assert.throws(() => sm17.getMemberPageBody(db, 1701, 'about', { memberSession: memberB17.session.token }), (e) => e.code === 'MEMBER_LOCKED');
  check('batch17 gate any_paid: anonymous needs login, unpaid member needs subscription, zero content leaks', () => {});

  // Checkout creation rides the member session + tier price on the owner account.
  const checkout17 = await sm17.createMembershipCheckoutByToken(
    db,
    embMembers17.public_token,
    { tierId: goldDraft.tier.id, returnUrl: 'https://site.example/members.html' },
    { memberSession: memberA17.session.token }
  );
  assert.equal(checkout17.url, 'https://checkout.stripe.test/cs_test_17');
  const cp17 = stub17.checkoutParams[stub17.checkoutParams.length - 1];
  assert.equal(cp17.mode, 'subscription');
  assert.equal(cp17.line_items[0].price, 'price_2', 'checkout charges the tier’s current Stripe price');
  assert.equal(cp17.metadata.bitpype_lead_id, '1701');
  assert.equal(cp17.metadata.bitpype_member_id, String(memberA17.member.id));
  assert.equal(cp17.subscription_data.metadata.bitpype_tier_id, String(goldDraft.tier.id));
  await assert.rejects(
    sm17.createMembershipCheckoutByToken(db, embMembers17.public_token, { tierId: goldDraft.tier.id, returnUrl: 'https://site.example/members.html' }, {}),
    (e) => e.code === 'MEMBER_LOCKED',
    'checkout requires a member session'
  );
  await assert.rejects(
    sm17.createMembershipCheckoutByToken(db, embMembers17.public_token, { tierId: clubFree.tier.id, returnUrl: 'https://site.example/members.html' }, { memberSession: memberA17.session.token }),
    (e) => e.code === 'VALIDATION',
    'free tiers join without checkout'
  );
  check('batch17 checkout: session-minted on the owner account with routing metadata', () => {});

  // Webhook: per-lead secret verification + lead resolution.
  const completed17 = {
    id: 'evt_17_1',
    type: 'checkout.session.completed',
    data: {
      object: {
        object: 'checkout.session',
        payment_status: 'paid',
        customer: 'cus_A17',
        subscription: 'sub_A17',
        metadata: { bitpype_lead_id: '1701', bitpype_member_id: String(memberA17.member.id), bitpype_tier_id: String(goldDraft.tier.id) },
      },
    },
  };
  assert.equal(ms17.resolveLeadForEvent(db, completed17), 1701, 'lead resolves from checkout metadata');
  const rawCompleted17 = JSON.stringify(completed17);
  const verified17 = ms17.constructEventForLead(db, 1701, rawCompleted17, 'sig:whsec_paid51');
  assert.equal(verified17.type, 'checkout.session.completed');
  assert.throws(() => ms17.constructEventForLead(db, 1701, rawCompleted17, 'sig:whsec_WRONG'), /No signatures found/, 'wrong secret fails verification');
  assert.throws(() => ms17.constructEventForLead(db, 1702, rawCompleted17, 'sig:whsec_paid51'), /No signatures found/, 'another lead’s secret cannot verify this lead’s events');
  const invoice17 = { type: 'invoice.paid', data: { object: { object: 'invoice', subscription: 'sub_A17', customer: 'cus_A17' } } };
  check('batch17 webhook verify: per-lead secrets only; lead resolves from metadata', () => {});

  // Applying events drives the gate from local records.
  const applied17 = sm17.applyMembershipStripeEvent(db, verified17);
  assert.equal(applied17.matched, true);
  assert.equal(applied17.status, 'active');
  const subA17 = sm17.getMemberSubscriptionByStripeId(db, 'sub_A17');
  assert.equal(subA17.member_id, memberA17.member.id);
  assert.equal(subA17.price_cents, 3000, 'tier price snapshot stored');
  const openA17 = sm17.getPublicModuleByToken(db, embBlog17.public_token, { pageSlug: 'about', memberSession: memberA17.session.token });
  assert(!openA17.locked && openA17.items.length === 1, 'paid member unlocks the gated payload');
  assert(sm17.getMemberPageBody(db, 1701, 'about', { memberSession: memberA17.session.token }).html.includes(MARKER17), 'paid member receives the gated body');
  const membersPayload17 = sm17.getPublicModuleByToken(db, embMembers17.public_token, { memberSession: memberA17.session.token });
  assert.equal(membersPayload17.members.entitlement.source, 'subscription');
  assert.equal(membersPayload17.members.stripe_connected, true);
  assert(membersPayload17.members.tiers.some((t) => t.id === goldDraft.tier.id && t.price_label === '$30.00'), 'members page lists tiers with prices');
  sm17.applyMembershipStripeEvent(db, verified17);
  assert.equal(sm17.listMemberSubscriptions(db, 1701, { memberId: memberA17.member.id }).length, 1, 'duplicate delivery is a no-op');
  const createdSub17 = {
    type: 'customer.subscription.created',
    data: {
      object: {
        object: 'subscription',
        id: 'sub_A17',
        status: 'active',
        customer: 'cus_A17',
        current_period_end: 1793000000,
        metadata: { bitpype_lead_id: '1701', bitpype_member_id: String(memberA17.member.id), bitpype_tier_id: String(goldDraft.tier.id) },
      },
    },
  };
  sm17.applyMembershipStripeEvent(db, createdSub17);
  assert(sm17.getMemberSubscriptionByStripeId(db, 'sub_A17').current_period_end.startsWith('2026-'), 'period end converges from subscription events');
  assert.equal(ms17.resolveLeadForEvent(db, invoice17), 1701, 'invoice events resolve via the local subscription row');
  check('batch17 webhook apply: subscription activates, gate unlocks, duplicates converge', () => {});

  // Revenue estimate from local records (A: $30/mo; C: $120/yr → $10/mo).
  const memberC17 = sm17.signupMember(db, 1701, { name: 'Yearly Yves', email: 'yves@example.com', password: 'password123' });
  sm17.upsertMemberSubscription(db, {
    lead_id: 1701, member_id: memberC17.member.id, tier_id: goldDraft.tier.id, tier_name: 'Gold',
    price_cents: 12000, interval: 'year', stripe_customer_id: 'cus_C17', stripe_subscription_id: 'sub_C17', status: 'active',
  });
  const revenue17 = sm17.membershipRevenueSummary(db, 1701);
  assert.equal(revenue17.active_paid_members, 2);
  assert.equal(revenue17.est_monthly_revenue_cents, 4000, 'monthly + yearly normalized to a monthly estimate');
  check('batch17 revenue: estimated monthly revenue from local records only', () => {});

  // Payment failure locks, payment recovery unlocks, deletion locks.
  sm17.applyMembershipStripeEvent(db, { type: 'invoice.payment_failed', data: { object: { object: 'invoice', subscription: 'sub_A17', customer: 'cus_A17' } } });
  assert.equal(sm17.getMemberSubscriptionByStripeId(db, 'sub_A17').status, 'past_due');
  assert.equal(sm17.getPublicModuleByToken(db, embBlog17.public_token, { pageSlug: 'about', memberSession: memberA17.session.token }).locked, true, 'past_due is not entitled');
  sm17.applyMembershipStripeEvent(db, invoice17);
  assert.equal(sm17.getMemberSubscriptionByStripeId(db, 'sub_A17').status, 'active', 'invoice.paid revives a past_due subscription');
  sm17.applyMembershipStripeEvent(db, {
    type: 'customer.subscription.deleted',
    data: { object: { object: 'subscription', id: 'sub_A17', status: 'canceled', customer: 'cus_A17', metadata: { bitpype_lead_id: '1701', bitpype_member_id: String(memberA17.member.id), bitpype_tier_id: String(goldDraft.tier.id) } } },
  });
  assert.equal(sm17.getMemberSubscriptionByStripeId(db, 'sub_A17').status, 'canceled');
  assert.equal(sm17.getPublicModuleByToken(db, embBlog17.public_token, { pageSlug: 'about', memberSession: memberA17.session.token }).locked, true, 'deleted subscription locks the gate again');
  check('batch17 lifecycle: payment_failed → past_due locks, invoice.paid revives, deleted locks', () => {});

  // Comps: grant (indefinite + tier match), expiry, revoke.
  sm17.grantMemberComp(db, 1701, memberB17.member.id, { tier_id: goldDraft.tier.id });
  assert(!sm17.getPublicModuleByToken(db, embBlog17.public_token, { pageSlug: 'about', memberSession: memberB17.session.token }).locked, 'comp satisfies any_paid');
  const bRow17 = sm17.listSiteMembers(db, 1701, { search: 'fran2@' })[0];
  assert.equal(bRow17.plan_source, 'comp');
  assert.equal(bRow17.plan_label, 'Comp');
  sm17.updateMembersConfig(db, 1701, { access_level: 'tier', access_tier_id: silverFree.tier.id });
  assert.equal(sm17.getPublicModuleByToken(db, embBlog17.public_token, { pageSlug: 'about', memberSession: memberB17.session.token }).locked, true, 'a Gold comp does not satisfy a Silver-tier gate');
  sm17.grantMemberComp(db, 1701, memberB17.member.id, { tier_id: silverFree.tier.id, comp_until: '2000-01-01' });
  assert.equal(sm17.getPublicModuleByToken(db, embBlog17.public_token, { pageSlug: 'about', memberSession: memberB17.session.token }).locked, true, 'an expired comp grants nothing');
  sm17.grantMemberComp(db, 1701, memberB17.member.id, { tier_id: silverFree.tier.id });
  assert(!sm17.getPublicModuleByToken(db, embBlog17.public_token, { pageSlug: 'about', memberSession: memberB17.session.token }).locked, 'a live comp for the required tier unlocks');
  sm17.revokeMemberComp(db, 1701, memberB17.member.id);
  assert.equal(sm17.getPublicModuleByToken(db, embBlog17.public_token, { pageSlug: 'about', memberSession: memberB17.session.token }).locked, true, 'revoked comp locks again');
  assert.throws(() => sm17.grantMemberComp(db, 1702, memberB17.member.id, { tier_id: goldDraft.tier.id }), (e) => e.code === 'NOT_FOUND', 'comps are lead-scoped');
  check('batch17 comps: grant/expiry/tier-match/revoke all drive the gate', () => {});

  // Free-tier join under a tier gate; free never counts as paid.
  sm17.updateMembersConfig(db, 1701, { access_level: 'tier', access_tier_id: clubFree.tier.id });
  const joined17 = sm17.joinFreeTierByToken(db, embMembers17.public_token, { tierId: clubFree.tier.id }, { memberSession: memberB17.session.token });
  assert.equal(joined17.joined, true);
  assert.equal(joined17.subscription.status, 'active');
  assert(!sm17.getPublicModuleByToken(db, embBlog17.public_token, { pageSlug: 'about', memberSession: memberB17.session.token }).locked, 'free-tier join satisfies its own tier gate');
  sm17.updateMembersConfig(db, 1701, { access_level: 'any_paid' });
  assert.equal(sm17.getPublicModuleByToken(db, embBlog17.public_token, { pageSlug: 'about', memberSession: memberB17.session.token }).locked, true, 'a free join never counts as paid');
  sm17.updateMembersConfig(db, 1701, { access_level: 'any_member' });
  assert(!sm17.getPublicModuleByToken(db, embBlog17.public_token, { pageSlug: 'about', memberSession: memberB17.session.token }).locked, 'any_member restores exact Part 1 behavior');
  check('batch17 free join + levels: tier gate satisfied by joining, any_paid still requires payment', () => {});

  // Cancel at period end: access lasts until Stripe ends the period.
  sm17.updateMembersConfig(db, 1701, { access_level: 'any_paid' });
  sm17.upsertMemberSubscription(db, {
    lead_id: 1701, member_id: memberA17.member.id, tier_id: goldDraft.tier.id, tier_name: 'Gold',
    price_cents: 3000, interval: 'month', stripe_customer_id: 'cus_A17', stripe_subscription_id: 'sub_A2_17', status: 'active',
    current_period_end: '2099-01-01 00:00:00',
  });
  assert(!sm17.getPublicModuleByToken(db, embBlog17.public_token, { pageSlug: 'about', memberSession: memberA17.session.token }).locked);
  const cancel17 = await ms17.cancelMemberSubscription(db, 1701, memberA17.member.id);
  assert.equal(cancel17.stripe_called, true);
  const lastSubUpdate17 = stub17.subUpdates[stub17.subUpdates.length - 1];
  assert.equal(lastSubUpdate17[0], 'sub_A2_17');
  assert.equal(lastSubUpdate17[1].cancel_at_period_end, true, 'Stripe told to cancel at period end');
  assert.equal(cancel17.subscription.cancel_at_period_end, true, 'local row is marked canceling immediately');
  assert.equal(cancel17.subscription.status, 'active', 'status stays Stripe’s until the period ends');
  assert(!sm17.getPublicModuleByToken(db, embBlog17.public_token, { pageSlug: 'about', memberSession: memberA17.session.token }).locked, 'access continues until period end');
  sm17.applyMembershipStripeEvent(db, {
    type: 'customer.subscription.deleted',
    data: { object: { object: 'subscription', id: 'sub_A2_17', status: 'canceled', customer: 'cus_A17', metadata: { bitpype_lead_id: '1701', bitpype_member_id: String(memberA17.member.id), bitpype_tier_id: String(goldDraft.tier.id) } } },
  });
  assert.equal(sm17.getPublicModuleByToken(db, embBlog17.public_token, { pageSlug: 'about', memberSession: memberA17.session.token }).locked, true, 'period end + deletion ends access');
  check('batch17 cancel: period-end cancel keeps access, deletion at period end closes it', () => {});

  // Admin rollup + payout oversight (cached, failure-isolated).
  const rollup17 = sm17.adminMembershipsLocal(db);
  const row1701 = rollup17.find((r) => r.lead_id === 1701);
  assert(row1701, 'rollup includes the fixture site');
  assert.equal(row1701.keys_connected, true);
  assert(row1701.members_count >= 3);
  assert.equal(row1701.paid_subs_active, 1, 'only the yearly member remains actively paid');
  const payout17 = await ms17.getPayoutStatus(db, 1701);
  assert.equal(payout17.ok, true);
  assert.equal(payout17.available_cents, 12345);
  assert.equal(payout17.last_payout.amount_cents, 5000);
  assert(payout17.as_of, 'payout figures carry an as-of time');
  const callsBefore17 = stub17.balanceCalls;
  await ms17.getPayoutStatus(db, 1701);
  assert.equal(stub17.balanceCalls, callsBefore17, 'payout reads are cached (10 min)');
  stub17.failBalance = true;
  const payoutFail17 = await ms17.getPayoutStatus(db, 1702, { force: true });
  assert.equal(payoutFail17.ok, false, 'a Stripe failure renders unavailable, never throws');
  stub17.failBalance = false;
  const payoutNone17 = await ms17.getPayoutStatus(db, 1799);
  assert.equal(payoutNone17.ok, false);
  assert.equal(payoutNone17.reason, 'not_connected');
  check('batch17 admin: local rollup + cached, failure-isolated payout reads', () => {});

  // ── Batch 20: offers layout setting + shared in-page container ──
  const sm20 = load('server/siteModules.js', {
    '../src/pageContentScan': require(path.join(root, 'src/pageContentScan.js')),
  });
  sm20.ensureTables(db);
  db.prepare("INSERT INTO leads (id, business_name, email) VALUES (2001, 'Fixture Offers Layout', 'offers20@example.invalid')").run();
  db.prepare('INSERT INTO websites (lead_id, name, theme, pages) VALUES (2001, ?, ?, ?)').run(
    'Fixture Offers Site',
    '{}',
    JSON.stringify([{ slug: 'index', file: 'index.html', title: 'Home', nav_label: 'Home', html: '<p>hi</p>', sections: [] }])
  );
  const offImg20 = sm20.createOffer(db, 2001, {
    title: 'Save 20% on every new job',
    description: 'New customers save on their first job.',
    code: 'SAVE20',
    expires_at: '2999-11-20',
    image_url: 'https://example.test/offer.jpg',
    status: 'published',
  });
  const offPlain20 = sm20.createOffer(db, 2001, { title: 'Free Checkup', description: 'No image on this one.', status: 'published' });
  assert(offImg20.id && offPlain20.id);
  // Layout setting: default cards, persists, rides the public payload, junk normalizes.
  assert.equal(sm20.getOffersLayout(db, 2001), 'cards', 'default layout = cards');
  const emb20 = sm20.attachModule(db, 2001, 'offers', { workspaceId: 1, appUrl: 'https://example.test' }).embed;
  let pub20 = sm20.getPublicModuleByToken(db, emb20.public_token);
  assert.equal(pub20.settings.layout, 'cards');
  assert.equal(pub20.items.length, 2, 'both published offers surface');
  assert.equal(sm20.updateOffersLayout(db, 2001, 'horizontal', { workspaceId: 1 }).layout, 'horizontal');
  pub20 = sm20.getPublicModuleByToken(db, emb20.public_token);
  assert.equal(pub20.settings.layout, 'horizontal', 'payload carries the layout to module-embed.js');
  sm20.attachModule(db, 2001, 'offers', { workspaceId: 1, appUrl: 'https://example.test', settings: { post_limit: 5 } });
  assert.equal(sm20.getOffersLayout(db, 2001), 'horizontal', 'layout survives unrelated settings writes');
  assert.equal(sm20.updateOffersLayout(db, 2001, 'diagonal', { workspaceId: 1 }).layout, 'cards', 'junk layout normalizes to cards');
  assert.equal(sm20.getOffersLayout(db, 2001), 'cards');
  pub20 = sm20.getPublicModuleByToken(db, emb20.public_token);
  assert.equal(pub20.settings.layout, 'cards', 'payload back to cards after normalize');
  check('batch20 offers layout: default cards, persists in embed settings, payload carries it, survives re-attach, junk normalizes', () => {});

  // Client render: module-embed.js under a fake DOM + stubbed fetch.
  const embedSrc20 = fs.readFileSync(path.join(root, 'public/js/module-embed.js'), 'utf8');
  function fakeEl20(tag) {
    const el = {
      tagName: String(tag || 'div').toUpperCase(),
      children: [],
      parentElement: null,
      previousElementSibling: null,
      _html: '',
      _text: '',
      _attrs: {},
      _classes: new Set(),
      style: {},
      classList: {
        add: (...cs) => cs.forEach((c) => el._classes.add(c)),
        remove: (...cs) => cs.forEach((c) => el._classes.delete(c)),
        contains: (c) => el._classes.has(c),
        toggle: (c, force) => {
          const on = force === undefined ? !el._classes.has(c) : !!force;
          if (on) el._classes.add(c);
          else el._classes.delete(c);
          return on;
        },
      },
      getAttribute: (n) => (n in el._attrs ? el._attrs[n] : null),
      setAttribute: (n, v) => {
        el._attrs[n] = String(v);
      },
      closest: () => null,
      querySelectorAll: () => [],
      querySelector: () => null,
      addEventListener: () => {},
      appendChild: (child) => {
        el.children.push(child);
        return child;
      },
    };
    Object.defineProperty(el, 'innerHTML', {
      get: () => el._html,
      set: (v) => {
        el._html = String(v);
      },
    });
    Object.defineProperty(el, 'textContent', {
      get: () => el._text,
      set: (v) => {
        el._text = String(v);
      },
    });
    return el;
  }
  async function renderModule20(payload) {
    const mount = fakeEl20('div');
    mount.setAttribute('data-bitpype-module', '1');
    mount.setAttribute('data-bitpype-module-token', payload.embed.public_token);
    mount.setAttribute('data-bitpype-api', 'https://example.test');
    mount.setAttribute('data-bitpype-hide-title', '1');
    const body = fakeEl20('body');
    body.children = [fakeEl20('header'), fakeEl20('main'), mount];
    mount.parentElement = body;
    let css = '';
    const document20 = {
      readyState: 'complete',
      body,
      head: {
        appendChild: (s) => {
          css = s.textContent || '';
          return s;
        },
      },
      getElementById: () => null,
      createElement: (tag) => fakeEl20(tag),
      querySelector: () => null,
      querySelectorAll: (sel) =>
        sel.includes('data-bitpype-module') && !sel.includes('member-gate') ? [mount] : [],
      addEventListener: () => {},
    };
    const location20 = { pathname: '/index.html', search: '', href: 'https://example.test/index.html' };
    const window20 = { location: location20 };
    vm.runInNewContext(embedSrc20, {
      window: window20,
      document: document20,
      localStorage: { length: 0, key: () => null, getItem: () => null, setItem: () => {}, removeItem: () => {} },
      location: location20,
      fetch: () => Promise.resolve({ json: () => Promise.resolve({ ok: true, data: payload }) }),
      URL,
      URLSearchParams,
      console,
      setTimeout,
      clearTimeout,
    });
    await new Promise((r) => setTimeout(r, 25));
    return { html: mount._html, css, classes: mount._classes };
  }

  // Shared container: every in-page mount is centered in a content column.
  const cardsAll20 = await renderModule20(pub20);
  assert(cardsAll20.classes.has('bitpype-module-inpage'), 'mount is marked in-page');
  assert(cardsAll20.css.includes('.bitpype-module-embed.bitpype-module-inpage'), 'shared in-page container rule ships');
  assert(cardsAll20.css.includes('max-width:1100px'), 'container caps at the module content column');
  assert(cardsAll20.css.includes('margin-left:auto'), 'container centers with auto margins');
  assert(cardsAll20.css.includes('.bp-mod-offers.is-horizontal'), 'horizontal layout CSS ships');
  assert(cardsAll20.css.includes('.bp-mod-offer-row{'), 'horizontal row CSS ships');
  check('batch20 shared container: in-page mounts get a centered 1100px content column in the shared embed CSS', () => {});

  // Cards layout (the default): single offer + multiple offers.
  const imgItem20 = pub20.items.find((i) => i.image_url);
  const cardsOne20 = await renderModule20({ ...pub20, items: [imgItem20] });
  assert(cardsOne20.html.includes('class="bp-mod-offers"'), 'cards wrapper renders');
  assert(!cardsOne20.html.includes('is-horizontal'), 'cards is not the horizontal layout');
  assert.equal(cardsOne20.html.split('class="bp-mod-offer"').length - 1, 1, 'single offer renders one card');
  assert(cardsOne20.html.includes('SAVE20') && cardsOne20.html.includes('Expires 2999-11-20'), 'card shows code + expiry');
  const cardsTwo20 = await renderModule20(pub20);
  assert.equal(cardsTwo20.html.split('class="bp-mod-offer"').length - 1, 2, 'two offers render two cards');
  check('batch20 cards layout: single offer contained, multiple offers all render, code + expiry shown', () => {});

  // Horizontal layout: banner rows, image left / body / code+expiry right,
  // and a no-image offer renders a row without an <img>.
  const horiz20 = await renderModule20({ ...pub20, settings: { ...pub20.settings, layout: 'horizontal' } });
  assert(horiz20.html.includes('class="bp-mod-offers is-horizontal"'), 'horizontal wrapper renders');
  assert.equal(horiz20.html.split('bp-mod-offer-row').length - 1 >= 2, true, 'rows render');
  assert(horiz20.html.includes('bp-mod-offer-row-side'), 'code/expiry side cell renders');
  assert(horiz20.html.includes('SAVE20'), 'row shows the code chip');
  assert.equal(horiz20.html.split('<img').length - 1, 1, 'only the imaged offer renders an image');
  assert(horiz20.html.includes('bp-mod-offer-row no-img'), 'no-image offer collapses the thumb cell');
  check('batch20 horizontal layout: banner rows with side code/expiry; no-image offer renders without an image', () => {});

  // Another module type still renders through the same mount path.
  const faq20 = await renderModule20({
    embed: { public_token: 'tok20' },
    module_type: 'faq',
    title: 'FAQ',
    settings: {},
    items: [{ question: 'Do you travel?', answer_html: '<p>Yes, locally.</p>' }],
  });
  assert(faq20.html.includes('bp-mod-faq') && faq20.html.includes('Do you travel?'), 'faq still renders');
  check('batch20 regression: faq module renders unchanged through the shared mount', () => {});

  // ── Batch 19: Shop Part 2 — per-lead Stripe keys, checkout resolution, webhook secrets ──
  // Stub Stripe whose clients remember WHICH secret built them, so the
  // key-selection assertions prove which layer a call actually ran on.
  const stub19 = { sessions: [], accounts: [] };
  function StubStripe19(secretKey) {
    return {
      __secret: secretKey,
      checkout: {
        sessions: {
          create: async (params) => {
            stub19.sessions.push({ secret: secretKey, params });
            return { id: 'cs_test_19_' + stub19.sessions.length, url: 'https://checkout.stripe.test/cs19' };
          },
        },
      },
      webhooks: {
        constructEvent: (body, sig, secret) => {
          if (sig !== 'sig:' + secret) throw new Error('No signatures found matching the expected signature for payload.');
          return JSON.parse(Buffer.isBuffer(body) ? body.toString('utf8') : String(body));
        },
      },
      accounts: {
        retrieve: async () => {
          stub19.accounts.push(secretKey);
          if (String(secretKey).includes('REJECT')) throw new Error('Invalid API Key provided (stub)');
          return { id: 'acct_owner19', charges_enabled: true, payouts_enabled: true, business_profile: { name: 'Fixture Bakery' } };
        },
      },
      balance: { retrieve: async () => ({ available: [], pending: [] }) },
    };
  }
  const mocks19 = {
    '../src/pageContentScan': require(path.join(root, 'src/pageContentScan.js')),
    '../src/websiteEngine': require(path.join(root, 'src/websiteEngine.js')),
    './portalContacts': contacts,
    '../src/secretBox': box17,
    './membershipStripe': { getClient: () => stubStripeClient17 },
    './shopStripe': null, // filled in below, before any checkout call
  };
  const sm19 = load('server/siteModules.js', mocks19);
  const ss19 = load('server/shopStripe.js', {
    stripe: StubStripe19,
    './siteModules': sm19,
    '../src/secretBox': box17,
  });
  mocks19['./shopStripe'] = ss19;
  sm19.ensureTables(db);

  // Fixtures: 1901 connects its OWN keys; 1902 relies on the workspace
  // fallback; 1903 has nothing. All three run a shop.
  for (const [id, name] of [[1901, 'Fixture Own Keys Bakery'], [1902, 'Fixture Fallback Bakery'], [1903, 'Fixture No Keys Bakery']]) {
    db.prepare('INSERT INTO leads (id, business_name, email) VALUES (?, ?, ?)').run(id, name, `shop${id}@example.invalid`);
    db.prepare('INSERT INTO websites (lead_id, name, theme, pages) VALUES (?, ?, ?, ?)').run(
      id,
      name + ' Site',
      '{}',
      JSON.stringify([{ slug: 'index', title: 'Home', sections: [{ type: 'nav', content: {} }, { type: 'footer', content: {} }] }])
    );
    sm19.attachModule(db, id, 'ecommerce', { workspaceId: 1, appUrl: 'https://example.test' });
    sm19.createProduct(db, id, { name: 'Sourdough ' + id, price: 12.5, status: 'published' });
  }
  const emb19 = (leadId) => sm19.getEmbedRow(db, leadId, 'ecommerce');
  const product19 = (leadId) => sm19.listProducts(db, leadId)[0];

  // (1) Key storage: encrypted at rest, status leaks nothing, lead-scoped.
  const LEAD_SK19 = 'sk_test_LEAD19SECRETKEY0001';
  const LEAD_WHSEC19 = 'whsec_lead19signingsecret';
  const savedStatus19 = sm19.saveShopStripeKeys(db, 1901, {
    publishable_key: 'pk_test_lead19',
    secret_key: LEAD_SK19,
    webhook_secret: LEAD_WHSEC19,
  });
  assert.equal(savedStatus19.connected, true);
  assert.equal(savedStatus19.secret_key_last4, '0001');
  assert.equal(savedStatus19.webhook_configured, true);
  assert(!JSON.stringify(savedStatus19).includes(LEAD_SK19), 'status never carries the secret');
  assert(!JSON.stringify(savedStatus19).includes(LEAD_WHSEC19), 'status never carries the webhook secret');
  // Batch 129: the save now writes the ONE unified payments config
  // (lead_payment_configs); the legacy shop key store is a read-only
  // fallback. The at-rest encryption assertions are unchanged.
  const rawShopRow19 = db.prepare('SELECT * FROM lead_payment_configs WHERE lead_id = 1901').get();
  assert(rawShopRow19.secret_key_enc.startsWith('enc:v1:'), 'shop secret stored secretBox-encrypted');
  assert(!rawShopRow19.secret_key_enc.includes(LEAD_SK19), 'ciphertext contains no plaintext key');
  assert(!rawShopRow19.webhook_secret_enc.includes(LEAD_WHSEC19), 'webhook secret encrypted too');
  assert.equal(ss19.getLeadCredentials(db, 1901).secretKey, LEAD_SK19, 'decrypt round-trips for the owning lead');
  assert.equal(sm19.shopStripeStatus(db, 1902).connected, false, 'keys are per-lead: 1902 has none');
  assert.equal(ss19.isLeadConnected(db, 1902), false);
  assert.throws(() => sm19.saveShopStripeKeys(db, 1902, { secret_key: 'not-a-key' }), (e) => e.code === 'VALIDATION');
  assert.throws(() => sm19.saveShopStripeKeys(db, 1902, { webhook_secret: 'nope' }), (e) => e.code === 'VALIDATION');
  // Save + disconnect round-trip on the fallback lead leaves it keyless.
  sm19.saveShopStripeKeys(db, 1902, { secret_key: 'sk_test_TEMP19KEY' });
  assert.equal(sm19.shopStripeStatus(db, 1902).connected, true);
  assert.equal(sm19.clearShopStripeKeys(db, 1902).connected, false);
  check('batch19 keys: encrypted at rest, status leaks nothing, per-lead isolation, validation + disconnect', () => {});

  // (2) Admin three-state accuracy with NO workspace keys anywhere.
  const sitesNoWs19 = sm19.listShopPaymentSites(db, false);
  const byLead19 = Object.fromEntries(sitesNoWs19.map((s) => [s.lead_id, s]));
  assert.equal(byLead19[1901].effective_source, 'lead');
  assert.equal(byLead19[1901].lead_connected, true);
  assert.equal(byLead19[1902].effective_source, 'none');
  assert.equal(byLead19[1903].effective_source, 'none');
  check('batch19 admin sites: own-keys lead reads lead, others none, when workspace is unset', () => {});

  // Workspace fallback keys arrive (settings table, secretBox-encrypted values).
  db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)');
  const WS_SK19 = 'sk_test_WORKSPACE19SECRET';
  const WS_WHSEC19 = 'whsec_workspace19signing';
  const setWs19 = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  setWs19.run('shop.stripe.publishable_key', box17.encryptValue('pk_test_workspace19'));
  setWs19.run('shop.stripe.secret_key', box17.encryptValue(WS_SK19));
  setWs19.run('shop.stripe.webhook_secret', box17.encryptValue(WS_WHSEC19));
  assert.equal(ss19.isConfigured(db), true, 'workspace layer reads its settings keys');
  const sitesWs19 = sm19.listShopPaymentSites(db, true);
  const byLeadWs19 = Object.fromEntries(sitesWs19.map((s) => [s.lead_id, s]));
  assert.equal(byLeadWs19[1901].effective_source, 'lead', 'own keys still win over the fallback');
  assert.equal(byLeadWs19[1902].effective_source, 'workspace');
  assert.equal(byLeadWs19[1903].effective_source, 'workspace');
  check('batch19 admin sites: fallback leads read workspace once workspace keys exist', () => {});

  // (3) Checkout key selection: lead keys preferred, workspace fallback,
  // and the order records which key-set ran it.
  const coLead19 = await sm19.createShopCheckoutByToken(db, emb19(1901).public_token, {
    productId: product19(1901).id,
    returnUrl: 'https://site.example/shop.html',
  });
  assert.equal(coLead19.mode, 'stripe');
  assert.equal(stub19.sessions.at(-1).secret, LEAD_SK19, 'checkout ran on the LEAD secret key');
  const orderLead19 = db.prepare('SELECT * FROM ecommerce_orders WHERE id = ?').get(coLead19.orderId);
  // Batch 129: keys saved through the portal save path land in the
  // unified payments config, so the order records 'unified' (the
  // 'lead' source remains for pre-129 legacy rows never re-saved).
  assert.equal(orderLead19.stripe_key_source, 'unified', 'order records the lead key-set');
  const coWs19 = await sm19.createShopCheckoutByToken(db, emb19(1902).public_token, {
    productId: product19(1902).id,
    returnUrl: 'https://site.example/shop.html',
  });
  assert.equal(stub19.sessions.at(-1).secret, WS_SK19, 'fallback checkout ran on the WORKSPACE secret key');
  const orderWs19 = db.prepare('SELECT * FROM ecommerce_orders WHERE id = ?').get(coWs19.orderId);
  assert.equal(orderWs19.stripe_key_source, 'workspace', 'order records the workspace key-set');
  check('batch19 checkout: lead keys preferred, workspace fallback, order records the key source', () => {});

  // (4) Webhook secret resolution per lead, workspace fallback, idempotent apply.
  const evtLead19 = {
    type: 'checkout.session.completed',
    data: {
      object: {
        id: coLead19.sessionId,
        payment_intent: 'pi_19_lead',
        customer_details: { email: 'buyer@example.invalid' },
        metadata: { bitpype_lead_id: '1901', bitpype_order_id: String(coLead19.orderId), bitpype_product_id: String(product19(1901).id) },
      },
    },
  };
  const rawEvt19 = Buffer.from(JSON.stringify(evtLead19));
  const verifiedLead19 = ss19.constructEventForShop(db, rawEvt19, 'sig:' + LEAD_WHSEC19, evtLead19);
  // Batch 129: the verifying layer is the unified config ('unified').
  assert.equal(verifiedLead19.source, 'unified', 'owner-signed event verifies against the LEAD secret');
  const applied19 = sm19.applyShopStripeEvent(db, verifiedLead19.event);
  assert.equal(applied19.status, 'paid');
  assert.equal(db.prepare('SELECT status FROM ecommerce_orders WHERE id = ?').get(coLead19.orderId).status, 'paid');
  const appliedAgain19 = sm19.applyShopStripeEvent(db, verifiedLead19.event);
  assert.equal(appliedAgain19.status, 'paid', 'redelivery is idempotent');
  // The same shop's event signed by the WORKSPACE secret (an order placed
  // on the fallback before the owner connected keys) still verifies.
  const verifiedWs19 = ss19.constructEventForShop(db, rawEvt19, 'sig:' + WS_WHSEC19, evtLead19);
  assert.equal(verifiedWs19.source, 'workspace', 'workspace-signed event verifies via the fallback candidate');
  assert.throws(() => ss19.constructEventForShop(db, rawEvt19, 'sig:whsec_garbage', evtLead19), /No signatures found/);
  check('batch19 webhook: per-lead secret resolution, workspace fallback candidate, garbage rejected, apply idempotent', () => {});

  // (5) Nothing configured anywhere: checkout refuses cleanly (no orphan
  // order) and the webhook reports NOT_CONFIGURED, not a signature error.
  db.prepare("DELETE FROM settings WHERE key LIKE 'shop.stripe.%'").run();
  const ordersBefore19 = db.prepare('SELECT COUNT(*) AS c FROM ecommerce_orders WHERE lead_id = 1903').get().c;
  await assert.rejects(
    sm19.createShopCheckoutByToken(db, emb19(1903).public_token, {
      productId: product19(1903).id,
      returnUrl: 'https://site.example/shop.html',
    }),
    (e) => e.code === 'SHOP_STRIPE_NOT_CONFIGURED'
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS c FROM ecommerce_orders WHERE lead_id = 1903').get().c,
    ordersBefore19,
    'no orphan order is written when no keys exist'
  );
  assert.throws(() => ss19.constructEventForShop(db, rawEvt19, 'sig:anything', null), (e) => e.code === 'SHOP_STRIPE_NOT_CONFIGURED');
  check('batch19 unconfigured: checkout refuses before writing an order; webhook says NOT_CONFIGURED', () => {});

  // (6) Connection test: a lightweight account read on the owner's key;
  // a key Stripe rejects surfaces as a failure, never a fake success.
  const testOk19 = await ss19.testLeadConnection(db, 1901);
  assert.equal(testOk19.ok, true);
  assert.equal(testOk19.account_id, 'acct_owner19');
  assert.equal(testOk19.test_mode, true);
  assert.equal(testOk19.charges_enabled, true);
  sm19.saveShopStripeKeys(db, 1903, { secret_key: 'sk_test_REJECT19key' });
  await assert.rejects(ss19.testLeadConnection(db, 1903), /Invalid API Key/);
  sm19.clearShopStripeKeys(db, 1903);
  check('batch19 connection test: real read succeeds on a good key and fails on a rejected one', () => {});

  // (7) Portal surface: the Shop panel payload carries the payments
  // status + effective source, and the portal wrappers save/test keys.
  const portal19 = load('server/clientPortal.js', {
    './portalTabs': portalTabs,
    bcryptjs: { hashSync: () => 'fixture' },
    './db': {},
    './mailer': {},
    './stripeClient': { appUrl: () => 'https://example.test' },
    './workspaceDb': {},
    './domain': { withDb: (_ws, fn) => fn(db) },
    './portalContacts': contacts,
    './siteModules': sm19,
    './shopStripe': ss19,
    './billing': { effectivePlan: async () => 'premium' },
    './plans': { getPlan: () => ({ entitlements: { siteModules: true, chatbot: false } }) },
  });
  const panel19 = await portal19.listModuleItems(1, 1901, 'ecommerce', 'owner@example.invalid');
  assert.equal(panel19.shop.payments.connected, true);
  assert.equal(panel19.shop.payments.secret_key_last4, '0001');
  assert.equal(panel19.shop.effective_source, 'lead');
  assert.equal(panel19.shop.webhook_path, '/api/v1/shop/webhook/1');
  assert(!JSON.stringify(panel19.shop).includes(LEAD_SK19), 'panel payload never carries the secret');
  const savedViaPortal19 = await portal19.saveShopKeys(1, 1902, { secret_key: 'sk_test_PORTAL19KEY' }, 'owner@example.invalid');
  assert.equal(savedViaPortal19.payments.connected, true);
  assert.equal(savedViaPortal19.payments.secret_key_last4, '9KEY');
  const testedViaPortal19 = await portal19.testShopKeys(1, 1901, 'owner@example.invalid');
  assert.equal(testedViaPortal19.test.ok, true);
  const panelFallback19 = await portal19.listModuleItems(1, 1903, 'ecommerce', 'owner@example.invalid');
  assert.equal(panelFallback19.shop.effective_source, 'none', 'after settings cleanup + no own keys the panel says none');
  check('batch19 portal: panel payload + save/test wrappers carry status and effective source', () => {});

  // --- Call Tracking (Batch 21): settings, TwiML, call log, contacts,
  // Twilio client, signature gate, number purchase ----------------------
  const crypto21 = require('node:crypto');
  const sm21 = load('server/siteModules.js', {
    '../src/pageContentScan': require(path.join(root, 'src/pageContentScan.js')),
    '../src/websiteEngine': require(path.join(root, 'src/websiteEngine.js')),
    './portalContacts': contacts,
    '../src/secretBox': require(path.join(root, 'src/secretBox.js')),
    './membershipStripe': {},
    './shopStripe': {},
  });
  sm21.ensureTables(db);
  db.prepare("INSERT INTO leads (id, business_name, email) VALUES (2101, 'Fixture Calls', 'calls@example.invalid')").run();
  db.prepare("INSERT INTO leads (id, business_name, email) VALUES (2102, 'Fixture Calls Bare', 'calls2@example.invalid')").run();
  db.prepare("INSERT INTO leads (id, business_name, email) VALUES (2103, 'Fixture Calls Buy', 'calls3@example.invalid')").run();

  check('batch21 module registered + embed script version bumped', () => {
    assert.ok(sm21.MODULE_TYPES.includes('calltracking'));
    assert.equal(sm21.MODULE_SCRIPT_VER, 'mod39', 'batch 21 mod14, batch 26 mod15, batch 25c mod16, batch 25c-fix mod17, batch 30 mod18, batch 31 mod19, batch 32 mod20');
    assert.equal(sm21.MODULE_META.calltracking.label, 'Call Tracking');
  });

  const cfg21 = sm21.updateCallTrackingConfig(db, 2101, {
    display_number: '6105551234',
    cta_text: 'Call the shop',
    redirect_enabled: true,
    redirect_number: '+16105550100',
    record_calls: false,
  });
  check('batch21 settings: US numbers normalize to E.164', () => {
    assert.equal(cfg21.display_number, '+16105551234');
    assert.equal(cfg21.redirect_number, '+16105550100');
    assert.equal(cfg21.cta_text, 'Call the shop');
    assert.equal(cfg21.redirect_enabled, true);
    assert.equal(cfg21.record_calls, false);
  });
  check('batch21 settings: garbage numbers rejected, stored settings untouched', () => {
    assert.throws(() => sm21.updateCallTrackingConfig(db, 2101, { display_number: 'call-me-maybe' }), (e) => e.code === 'VALIDATION');
    assert.throws(() => sm21.updateCallTrackingConfig(db, 2101, { redirect_number: '123' }), (e) => e.code === 'VALIDATION');
    assert.equal(sm21.getCallTrackingConfig(db, 2101).display_number, '+16105551234');
  });

  const voiceArgs21 = { workspaceId: 1, leadId: 2101, baseUrl: 'https://example.test' };
  const twimlOn = sm21.buildCallTrackingVoiceTwiml(sm21.getCallTrackingConfig(db, 2101), voiceArgs21);
  check('batch21 twiml: redirect on dials the redirect number with the display number as caller id', () => {
    assert.ok(twimlOn.startsWith('<?xml'));
    assert.ok(twimlOn.includes('<Dial callerId="+16105551234"'));
    assert.ok(twimlOn.includes('>+16105550100</Dial>'));
    assert.ok(twimlOn.includes('action="https://example.test/api/v1/calls/status/1/2101"'));
    assert.ok(!twimlOn.includes('record='));
    assert.ok(!twimlOn.includes('may be recorded'));
  });
  sm21.updateCallTrackingConfig(db, 2101, { record_calls: true });
  const twimlRec = sm21.buildCallTrackingVoiceTwiml(sm21.getCallTrackingConfig(db, 2101), voiceArgs21);
  check('batch21 twiml: recording adds the consent say, dual-channel record and recording callback', () => {
    assert.ok(twimlRec.includes('This call may be recorded for quality purposes.'));
    assert.ok(twimlRec.includes('record="record-from-answer-dual"'));
    assert.ok(twimlRec.includes('recordingStatusCallback="https://example.test/api/v1/calls/recording/1/2101"'));
    assert.ok(twimlRec.indexOf('may be recorded') < twimlRec.indexOf('<Dial'));
  });
  sm21.updateCallTrackingConfig(db, 2101, { record_calls: false, redirect_enabled: false });
  const twimlOff = sm21.buildCallTrackingVoiceTwiml(sm21.getCallTrackingConfig(db, 2101), voiceArgs21);
  check('batch21 twiml: redirect off says the website message and hangs up', () => {
    assert.ok(!twimlOff.includes('<Dial'));
    assert.ok(twimlOff.includes('through our website'));
    assert.ok(twimlOff.includes('<Hangup/>'));
  });
  const twimlBare = sm21.buildCallTrackingVoiceTwiml(sm21.getCallTrackingConfig(db, 2102), {
    workspaceId: 1,
    leadId: 2102,
    baseUrl: 'https://example.test',
  });
  check('batch21 twiml: unconfigured module hangs up', () => {
    assert.equal(twimlBare, '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
  });
  check('batch21 public payload: display number shown formatted, redirect number never exposed', () => {
    const pub = sm21.publicCallTrackingPayload(db, 2101);
    assert.equal(pub.configured, true);
    assert.equal(pub.display_number, '+16105551234');
    assert.equal(pub.display_number_formatted, '(610) 555-1234');
    assert.ok(!JSON.stringify(pub).includes('5550100'));
    assert.equal(sm21.publicCallTrackingPayload(db, 2102).configured, false);
  });

  const SID21 = 'CAtest2101';
  sm21.logCallInitiated(db, 2101, { callSid: SID21, from: '+16105559999', to: '+16105551234', verified: true });
  const upParams21 = {
    CallSid: SID21,
    From: '+16105559999',
    To: '+16105551234',
    CallStatus: 'completed',
    DialCallStatus: 'completed',
    DialCallDuration: '42',
  };
  const up1 = sm21.upsertCallStatus(db, 2101, upParams21, { verified: true });
  const up2 = sm21.upsertCallStatus(db, 2101, upParams21, { verified: true });
  check('batch21 call log: status callbacks dedupe by CallSid', () => {
    assert.equal(up1.id, up2.id);
    const rows = sm21.listCalls(db, 2101);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'completed');
    assert.equal(rows[0].duration_seconds, 42);
    assert.equal(rows[0].verified, 1);
  });
  sm21.storeCallRecording(db, SID21, {
    recordingSid: 'REtest21',
    recordingUrl: 'https://api.twilio.com/rec/REtest21',
    recordingDuration: '40',
  });
  sm21.setCallTranscript(db, SID21, { status: 'done', text: 'Hi, do you fix brakes?' });
  check('batch21 recording stores sid/url/duration; transcript roundtrips', () => {
    const row = sm21.getCallLogBySid(db, SID21);
    assert.equal(row.recording_sid, 'REtest21');
    assert.equal(row.recording_url, 'https://api.twilio.com/rec/REtest21');
    assert.equal(row.recording_duration, 40);
    assert.equal(row.transcript_status, 'done');
    assert.equal(row.transcript, 'Hi, do you fix brakes?');
    assert.equal(sm21.listCalls(db, 2101)[0].transcript, 'Hi, do you fix brakes?');
  });

  const callRow21 = sm21.getCallLogBySid(db, SID21);
  const capCall1 = contacts.captureFromCall(db, { leadId: 2101, call: callRow21 });
  const capCall2 = contacts.captureFromCall(db, { leadId: 2101, call: callRow21 });
  check('batch21 contact: terminal call upserts one LeadScout contact by caller phone, deduped per call', () => {
    assert.equal(capCall1.error, undefined);
    assert.equal(capCall1.contact.phone, '+16105559999');
    assert.equal(capCall2.contact.id, capCall1.contact.id);
    assert.equal(capCall2.deduped, true);
    const detail = contacts.getContact(db, capCall1.contact.id, { leadId: 2101 });
    assert.equal(detail.calls.length, 1);
    assert.equal(detail.calls[0].kind, 'call');
    assert.equal(detail.events.filter((e) => e.kind === 'call').length, 1);
  });

  // Twilio client behind a stub fetch + stub platform settings.
  function loadTwilio21(settings, fetchImpl) {
    const mod = { exports: {} };
    vm.runInNewContext(
      fs.readFileSync(path.join(root, 'server/twilioClient.js'), 'utf8'),
      {
        module: mod,
        exports: mod.exports,
        require: (name) => {
          if (name === './platform') return { getPlatformSetting: async (k) => settings[k] || '' };
          if (!name.startsWith('.')) return require(name);
          throw new Error('Unexpected dependency: ' + name);
        },
        process: { env: {} },
        console,
        Buffer,
        URL,
        URLSearchParams,
        FormData,
        Blob,
        fetch: fetchImpl,
        setTimeout,
        clearTimeout,
      },
      { filename: 'server/twilioClient.js' }
    );
    return mod.exports;
  }
  const twilioOff = loadTwilio21({}, async () => {
    throw new Error('fetch must not run without credentials');
  });
  const offSearch21 = await twilioOff.searchNumbers({ areaCode: '610' });
  const offPurchase21 = await twilioOff.purchaseNumber({ phoneNumber: '+16105550199', voiceUrl: 'https://example.test/x' });
  const offMedia21 = await twilioOff.fetchRecordingMedia('https://api.twilio.com/rec/x');
  check('batch21 twilio client: unconfigured platform is dormant-safe', () => {
    assert.equal(offSearch21.configured, false);
    assert.equal(offSearch21.numbers.length, 0);
    assert.equal(offPurchase21.configured, false);
    assert.equal(offMedia21.configured, false);
  });
  const seen21 = [];
  const twilioOn = loadTwilio21(
    {
      'twilio.account_sid': 'ACtest21',
      'twilio.auth_token': 'tok21',
      'ai.api_key': 'sk-test21',
      'ai.base_url': 'https://ai.example.test/v1',
    },
    async (url, opts = {}) => {
      seen21.push({ url: String(url), opts });
      if (String(url).includes('/AvailablePhoneNumbers/'))
        return {
          ok: true,
          status: 200,
          json: async () => ({
            available_phone_numbers: [
              { phone_number: '+16105550199', friendly_name: '(610) 555-0199', locality: 'Reading', region: 'PA', iso_country: 'US' },
            ],
          }),
        };
      if (String(url).includes('/IncomingPhoneNumbers.json'))
        return { ok: true, status: 201, json: async () => ({ sid: 'PNtest21', phone_number: '+16105550199' }) };
      if (String(url).includes('/Recordings/'))
        return { ok: true, status: 200, headers: { get: () => 'audio/mpeg' }, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
      if (String(url).includes('/audio/transcriptions'))
        return { ok: true, status: 200, json: async () => ({ text: 'Caller asked about brakes.' }) };
      throw new Error('unexpected fetch ' + url);
    }
  );
  const found21 = await twilioOn.searchNumbers({ areaCode: '610' });
  check('batch21 twilio client: number search maps Twilio results with basic auth', () => {
    assert.equal(found21.configured, true);
    assert.equal(found21.numbers.length, 1);
    assert.equal(found21.numbers[0].phoneNumber, '+16105550199');
    assert.equal(found21.numbers[0].friendlyName, '(610) 555-0199');
    assert.equal(found21.numbers[0].locality, 'Reading');
    assert.equal(found21.numbers[0].region, 'PA');
    assert.ok(seen21[0].url.includes('AreaCode=610'));
    assert.equal(seen21[0].opts.headers.Authorization, 'Basic ' + Buffer.from('ACtest21:tok21').toString('base64'));
  });
  const bought21 = await twilioOn.purchaseNumber({
    phoneNumber: '+16105550199',
    voiceUrl: 'https://example.test/api/v1/calls/voice/1/2103',
  });
  check('batch21 twilio client: purchase posts the voice webhook url', () => {
    assert.equal(bought21.configured, true);
    assert.equal(bought21.sid, 'PNtest21');
    const post = seen21.find((r) => String(r.url).includes('/IncomingPhoneNumbers.json'));
    const body = new URLSearchParams(post.opts.body);
    assert.equal(body.get('VoiceUrl'), 'https://example.test/api/v1/calls/voice/1/2103');
    assert.equal(body.get('VoiceMethod'), 'POST');
    assert.equal(body.get('PhoneNumber'), '+16105550199');
  });
  const transcribed21 = await twilioOn.transcribeRecording(
    'https://api.twilio.com/2010-04-01/Accounts/ACtest21/Recordings/REtest21'
  );
  check('batch21 twilio client: transcription downloads the mp3 and posts it to the STT api', () => {
    assert.equal(transcribed21.ok, true);
    assert.equal(transcribed21.text, 'Caller asked about brakes.');
  });
  const noStt21 = loadTwilio21({ 'twilio.account_sid': 'ACtest21', 'twilio.auth_token': 'tok21' }, async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => new ArrayBuffer(4),
  }));
  const noSttRes21 = await noStt21.transcribeRecording('https://api.twilio.com/rec/x');
  check('batch21 twilio client: no STT key leaves transcription off, never throws', () => {
    assert.equal(noSttRes21.ok, false);
    assert.equal(noSttRes21.reason, 'no_stt_key');
  });

  // Signature validation against the real client (pure crypto).
  const realTwilio21 = require(path.join(root, 'server/twilioClient.js'));
  const signParams21 = { CallSid: 'CAsign', From: '+16105559999', To: '+16105551234' };
  const signUrl21 = 'https://example.test/api/v1/calls/voice/1/2101';
  const signFor21 = (url, params, token) => {
    let data = url;
    for (const k of Object.keys(params).sort()) data += k + params[k];
    return crypto21.createHmac('sha1', token).update(Buffer.from(data, 'utf-8')).digest('base64');
  };
  const goodSig21 = signFor21(signUrl21, signParams21, 'tok21');
  check('batch21 signature: valid HMAC-SHA1 accepted, tampered rejected', () => {
    assert.equal(realTwilio21.validateSignature('tok21', signUrl21, signParams21, goodSig21), true);
    assert.equal(realTwilio21.validateSignature('tok21', signUrl21, { ...signParams21, From: '+10000000000' }, goodSig21), false);
    assert.equal(realTwilio21.validateSignature('tok21', signUrl21, signParams21, 'bogus'), false);
    assert.equal(realTwilio21.validateSignature('', signUrl21, signParams21, goodSig21), false);
  });

  // Domain purchase flow with a stubbed Twilio client.
  let purchaseBehavior21 = async () => ({ configured: true, phoneNumber: '+16105550199', sid: 'PNdomain21' });
  let planVar21 = 'standard';
  const purchaseCalls21 = [];
  const domain21 = load('server/domain.js', {
    './workspaceDb': { openWorkspaceDb: () => db, acquireWorkspaceDb: () => db, releaseWorkspaceDb: () => {}, leaseCount: () => 1 },
    './billing': { effectivePlan: async () => planVar21 },
    './twilioClient': {
      searchNumbers: async () => ({ configured: false, numbers: [] }),
      purchaseNumber: async (args) => {
        purchaseCalls21.push(args);
        return purchaseBehavior21(args);
      },
    },
    './stripeClient': { appUrl: () => 'https://example.test' },
    './siteModules': sm21,
  });
  const boughtDomain21 = await domain21.adminPurchaseCallNumber(1, { leadId: 2103, phoneNumber: '+16105550199' });
  check('batch21 purchase: success attaches number + SID with the lead voice url', () => {
    assert.equal(boughtDomain21.configured, true);
    assert.equal(purchaseCalls21[0].voiceUrl, 'https://example.test/api/v1/calls/voice/1/2103');
    const cfg = sm21.getCallTrackingConfig(db, 2103);
    assert.equal(cfg.display_number, '+16105550199');
    assert.equal(cfg.twilio_number_sid, 'PNdomain21');
  });
  purchaseBehavior21 = async () => {
    const e = new Error('The number is no longer available');
    e.code = 'TWILIO_ERROR';
    throw e;
  };
  let purchaseErr21 = null;
  try {
    await domain21.adminPurchaseCallNumber(1, { leadId: 2103, phoneNumber: '+16105550200' });
  } catch (e) {
    purchaseErr21 = e;
  }
  check('batch21 purchase: Twilio failure changes nothing', () => {
    assert.equal(purchaseErr21 && purchaseErr21.code, 'TWILIO_ERROR');
    const cfg = sm21.getCallTrackingConfig(db, 2103);
    assert.equal(cfg.display_number, '+16105550199');
    assert.equal(cfg.twilio_number_sid, 'PNdomain21');
  });
  purchaseBehavior21 = async () => ({ configured: false });
  const unconf21 = await domain21.adminPurchaseCallNumber(1, { leadId: 2103, phoneNumber: '+16105550200' });
  const overview21 = await domain21.adminCallsOverview(1);
  check('batch21 purchase: unconfigured Twilio reports configured:false; admin overview spans leads', () => {
    assert.equal(unconf21.configured, false);
    const row = overview21.calls.find((c) => c.call_sid === SID21);
    assert.ok(row);
    assert.equal(row.lead_name, 'Fixture Calls');
  });

  // Route level: signature gate, unknown lead, status dedupe, recording.
  const handlers21 = { get: {}, post: {} };
  const fakeRouter21 = {
    get: (p, ...h) => {
      handlers21.get[p] = h[h.length - 1];
    },
    post: (p, ...h) => {
      handlers21.post[p] = h[h.length - 1];
    },
    use: () => {},
  };
  let routeToken21 = 'tok21';
  load('server/routes/calls.js', {
    express: { Router: () => fakeRouter21 },
    '../domain': { withDb: (_ws, fn) => fn(db) },
    '../workspaceExists': { assertWorkspaceExists: (id) => Number(id) === 1 },
    '../siteModules': sm21,
    '../portalContacts': contacts,
    '../twilioClient': {
      getCredentials: async () => ({ accountSid: 'ACtest21', authToken: routeToken21 }),
      validateSignature: realTwilio21.validateSignature,
      transcribeRecording: async () => ({ ok: false, reason: 'no_stt_key' }),
      fetchRecordingMedia: async () => ({ configured: false }),
    },
    '../clientPortal': { findById: () => null },
    '../workspace': { getMembership: () => null, findWorkspaceByToken: () => null },
    '../callNotify': { notifyCallByEmail: async () => ({ sent: false, reason: 'stubbed' }) },
    '../callBilling': {
      settleCallBilling: async () => ({ settled: true }),
      transcribeCallRecording: async (ws, leadId, callSid) => {
        sm21.setCallTranscript(db, callSid, { status: 'unavailable' });
        return { ok: false, reason: 'no_stt_key' };
      },
    },
    '../stripeClient': { appUrl: () => 'https://example.test' },
    '../rateLimit': { rateLimit: () => ((_req, _res, next) => next()) },
  });
  function fakeRes21() {
    return {
      statusCode: 200,
      headers: {},
      body: null,
      status(c) {
        this.statusCode = c;
        return this;
      },
      set(k, v) {
        this.headers[k] = v;
        return this;
      },
      type() {
        return this;
      },
      send(b) {
        this.body = b;
        return this;
      },
    };
  }
  sm21.updateCallTrackingConfig(db, 2101, { redirect_enabled: true });
  const voicePath21 = '/api/v1/calls/voice/1/2101';
  const voiceParams21 = { CallSid: 'CAroute21', From: '+16105557777', To: '+16105551234' };
  const goodRes21 = fakeRes21();
  await handlers21.post['/voice/:workspaceId/:leadId'](
    {
      params: { workspaceId: '1', leadId: '2101' },
      body: voiceParams21,
      headers: { 'x-twilio-signature': signFor21('https://example.test' + voicePath21, voiceParams21, 'tok21') },
      originalUrl: voicePath21,
    },
    goodRes21
  );
  check('batch21 route: correctly signed voice webhook returns forwarding TwiML and logs verified', () => {
    assert.equal(goodRes21.statusCode, 200);
    assert.ok(String(goodRes21.body).includes('<Dial'));
    const row = sm21.getCallLogBySid(db, 'CAroute21');
    assert.ok(row);
    assert.equal(row.verified, 1);
    assert.equal(row.status, 'initiated');
  });
  const badRes21 = fakeRes21();
  await handlers21.post['/voice/:workspaceId/:leadId'](
    {
      params: { workspaceId: '1', leadId: '2101' },
      body: voiceParams21,
      headers: { 'x-twilio-signature': 'bogus' },
      originalUrl: voicePath21,
    },
    badRes21
  );
  check('batch21 route: bad signature is rejected 403 when a token is configured', () => {
    assert.equal(badRes21.statusCode, 403);
  });
  const unknownParams21 = { CallSid: 'CAunknown21', From: '+16105557777', To: '+16105551234' };
  const unknownPath21 = '/api/v1/calls/voice/1/999999';
  const unknownRes21 = fakeRes21();
  await handlers21.post['/voice/:workspaceId/:leadId'](
    {
      params: { workspaceId: '1', leadId: '999999' },
      body: unknownParams21,
      headers: { 'x-twilio-signature': signFor21('https://example.test' + unknownPath21, unknownParams21, 'tok21') },
      originalUrl: unknownPath21,
    },
    unknownRes21
  );
  check('batch21 route: unknown lead gets hangup TwiML', () => {
    assert.equal(unknownRes21.statusCode, 200);
    assert.equal(String(unknownRes21.body), '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
  });
  const statusParams21 = {
    CallSid: 'CAroute21',
    From: '+16105557777',
    To: '+16105551234',
    CallStatus: 'completed',
    DialCallStatus: 'completed',
    DialCallDuration: '17',
  };
  const statusPath21 = '/api/v1/calls/status/1/2101';
  const runStatus21 = async () => {
    const r = fakeRes21();
    await handlers21.post['/status/:workspaceId/:leadId'](
      {
        params: { workspaceId: '1', leadId: '2101' },
        body: statusParams21,
        headers: { 'x-twilio-signature': signFor21('https://example.test' + statusPath21, statusParams21, 'tok21') },
        originalUrl: statusPath21,
      },
      r
    );
    return r;
  };
  const statusRes1 = await runStatus21();
  const statusRes2 = await runStatus21();
  check('batch21 route: status callback upserts once and captures the caller contact', () => {
    assert.equal(statusRes1.statusCode, 200);
    assert.equal(statusRes2.statusCode, 200);
    const rows = sm21.listCalls(db, 2101).filter((c) => c.call_sid === 'CAroute21');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'completed');
    assert.equal(rows[0].duration_seconds, 17);
    const found = contacts.listContacts(db, { leadId: 2101 }).filter((c) => c.phone === '+16105557777');
    assert.equal(found.length, 1);
    const detail = contacts.getContact(db, found[0].id, { leadId: 2101 });
    assert.equal(detail.calls.length, 1);
    assert.equal(detail.calls[0].source_label, 'Call');
  });
  const recParams21 = {
    CallSid: 'CAroute21',
    RecordingSid: 'REroute21',
    RecordingUrl: 'https://api.twilio.com/rec/REroute21',
    RecordingDuration: '16',
    RecordingStatus: 'completed',
  };
  const recPath21 = '/api/v1/calls/recording/1/2101';
  const recRes21 = fakeRes21();
  await handlers21.post['/recording/:workspaceId/:leadId'](
    {
      params: { workspaceId: '1', leadId: '2101' },
      body: recParams21,
      headers: { 'x-twilio-signature': signFor21('https://example.test' + recPath21, recParams21, 'tok21') },
      originalUrl: recPath21,
    },
    recRes21
  );
  await new Promise((r) => setTimeout(r, 25));
  check('batch21 route: recording callback stores the recording on the call row', () => {
    assert.equal(recRes21.statusCode, 200);
    const row = sm21.getCallLogBySid(db, 'CAroute21');
    assert.equal(row.recording_sid, 'REroute21');
    assert.equal(row.recording_url, 'https://api.twilio.com/rec/REroute21');
    assert.equal(row.recording_duration, 16);
    assert.equal(row.transcript_status, 'unavailable');
  });
  routeToken21 = '';
  const openParams21 = { CallSid: 'CAopen21', From: '+16105556666', To: '+16105551234' };
  const openRes21 = fakeRes21();
  await handlers21.post['/voice/:workspaceId/:leadId'](
    { params: { workspaceId: '1', leadId: '2101' }, body: openParams21, headers: {}, originalUrl: voicePath21 },
    openRes21
  );
  check('batch21 route: without a platform token, webhooks are accepted but logged unverified', () => {
    assert.equal(openRes21.statusCode, 200);
    assert.equal(sm21.getCallLogBySid(db, 'CAopen21').verified, 0);
  });
  check('batch21 surfaces: embed CTA, portal panel and staff screen are wired', () => {
    const embedSrc = fs.readFileSync(path.join(root, 'public/js/module-embed.js'), 'utf8');
    assert.ok(embedSrc.includes("type === 'calltracking'"));
    assert.ok(embedSrc.includes('href="tel:'));
    const portalSrc = fs.readFileSync(path.join(root, 'public/js/portal.js'), 'utf8');
    assert.ok(portalSrc.includes('renderCallTrackingAdminPanel'));
    const appSrc = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
    assert.ok(appSrc.includes('pageCalls'));
  });

  // --- Batch 21 addendum #3: charging model (soft caps, credits) -------
  db.prepare("INSERT INTO leads (id, business_name, email) VALUES (2104, 'Fixture Billing', 'billing@example.invalid')").run();
  db.prepare("INSERT INTO leads (id, business_name, email) VALUES (2105, 'Fixture Counting', 'counting@example.invalid')").run();
  db.prepare("INSERT INTO leads (id, business_name, email) VALUES (2106, 'Fixture Broke', 'broke@example.invalid')").run();

  check('batch21 billing: allowance mapping per plan', () => {
    assert.equal(sm21.CALL_ALLOWANCE_BY_PLAN.free, 0);
    assert.equal(sm21.CALL_ALLOWANCE_BY_PLAN.standard, 60);
    assert.equal(sm21.CALL_ALLOWANCE_BY_PLAN.pro, 150);
    assert.equal(sm21.CALL_ALLOWANCE_BY_PLAN.premium, 100000);
    assert.equal(sm21.callAllowanceForPlan('free'), 0);
    assert.equal(sm21.callAllowanceForPlan('standard'), 60);
    assert.equal(sm21.callAllowanceForPlan('pro'), 150);
    assert.equal(sm21.callAllowanceForPlan('premium'), 100000);
    assert.equal(sm21.callAllowanceForPlan('nonsense'), 0);
  });

  const countedRow21 = (sid) => sm21.getCallLogBySid(db, sid);
  sm21.upsertCallStatus(db, 2105, { CallSid: 'CAcount-short', From: '+16105550001', To: '+16105551234', CallStatus: 'completed', DialCallStatus: 'completed', DialCallDuration: '10' });
  sm21.upsertCallStatus(db, 2105, { CallSid: 'CAcount-exact', From: '+16105550001', To: '+16105551234', CallStatus: 'completed', DialCallStatus: 'completed', DialCallDuration: '15' });
  sm21.upsertCallStatus(db, 2105, { CallSid: 'CAcount-long', From: '+16105550001', To: '+16105551234', CallStatus: 'completed', DialCallStatus: 'completed', DialCallDuration: '61' });
  sm21.upsertCallStatus(db, 2105, { CallSid: 'CAcount-noanswer', From: '+16105550001', To: '+16105551234', CallStatus: 'no-answer', DialCallStatus: 'no-answer', DialCallDuration: '60' });
  sm21.upsertCallStatus(db, 2105, { CallSid: 'CAcount-busy', From: '+16105550001', To: '+16105551234', CallStatus: 'busy', DialCallStatus: 'busy', DialCallDuration: '30' });
  check('batch21 billing: counting ignores <15s calls and non-completed statuses', () => {
    assert.equal(countedRow21('CAcount-short').counted, 0);
    assert.equal(countedRow21('CAcount-exact').counted, 1);
    assert.equal(countedRow21('CAcount-long').counted, 1);
    assert.equal(countedRow21('CAcount-noanswer').counted, 0);
    assert.equal(countedRow21('CAcount-busy').counted, 0);
    assert.equal(sm21.countCountedCalls(db, 2105, sm21.currentCallMonth()), 2);
  });

  check('batch21 billing: free-plan activation gate blocks a first number only', () => {
    assert.throws(
      () => sm21.assertCallTrackingActivation({ display_number: '' }, { display_number: '+16105551234' }, 'free'),
      (e) => e.code === 'PLAN_REQUIRED'
    );
    // Already has a number → keeps working on free.
    sm21.assertCallTrackingActivation({ display_number: '+16105551234' }, { display_number: '+16105559999' }, 'free');
    // Paid plan → fine. No number requested → fine.
    sm21.assertCallTrackingActivation({ display_number: '' }, { display_number: '+16105551234' }, 'standard');
    sm21.assertCallTrackingActivation({ display_number: '' }, { cta_text: 'Ring us' }, 'free');
  });

  // callBilling behind stub credits + stub plan + stub STT.
  const creditState21 = { balance: 0, spends: [] };
  let planCb21 = 'standard';
  let transcribeBehavior21 = async () => ({ ok: true, text: 'Hello from the caller.' });
  let transcribeCalls21 = 0;
  const callBilling21 = load('server/callBilling.js', {
    './domain': { withDb: (_ws, fn) => fn(db) },
    './siteModules': sm21,
    './credits': {
      getBalance: async () => creditState21.balance,
      spend: async (ws, amount, meta) => {
        if (creditState21.balance < amount) {
          const e = new Error('Not enough credits');
          e.code = 'INSUFFICIENT_CREDITS';
          throw e;
        }
        creditState21.balance -= amount;
        creditState21.spends.push({ amount, ...meta });
        return { balance: creditState21.balance, ledgerId: creditState21.spends.length, duplicate: false };
      },
    },
    './billing': { effectivePlan: async () => planCb21 },
    './twilioClient': {
      transcribeRecording: async (url) => {
        transcribeCalls21 += 1;
        return transcribeBehavior21(url);
      },
    },
  });
  const seedCounted21 = (leadId, n, prefix) => {
    const ins = db.prepare(
      "INSERT INTO call_logs (lead_id, call_sid, from_number, to_number, status, duration_seconds, counted) VALUES (?, ?, '+16105550001', '+16105551234', 'completed', 30, 1)"
    );
    let lastSid = '';
    for (let i = 0; i < n; i++) {
      lastSid = `${prefix}-${i}`;
      ins.run(leadId, lastSid);
    }
    return lastSid;
  };
  const month21 = sm21.currentCallMonth();

  creditState21.balance = 5;
  const lastSeed1 = seedCounted21(2104, 70, 'CAseedA');
  const settle1 = await callBilling21.settleCallBilling(1, 2104, lastSeed1);
  const overageSpends1 = creditState21.spends.filter((x) => x.reason === 'Call tracking overage');
  check('batch21 billing: the 10th over-cap call triggers exactly one credit debit', () => {
    assert.equal(settle1.settled, true);
    assert.equal(settle1.count, 70);
    assert.equal(settle1.allowance, 60);
    assert.equal(overageSpends1.length, 1);
    assert.equal(overageSpends1[0].refType, 'call_overage');
    assert.equal(overageSpends1[0].refId, `2104:${month21}:1`);
    assert.equal(creditState21.balance, 4);
    const st = sm21.getCallBillingState(db, 2104, month21);
    assert.equal(st.last_billed_threshold, 1);
    assert.equal(st.overage_due_credits, 0);
  });
  const lastSeed2 = seedCounted21(2104, 10, 'CAseedB');
  await callBilling21.settleCallBilling(1, 2104, lastSeed2);
  // Re-settling the same state must not debit again.
  await callBilling21.settleCallBilling(1, 2104, lastSeed2);
  check('batch21 billing: the 20th over-cap call debits a second credit; re-settle is a no-op', () => {
    const spends = creditState21.spends.filter((x) => x.reason === 'Call tracking overage');
    assert.equal(spends.length, 2);
    assert.equal(spends[1].refId, `2104:${month21}:2`);
    assert.equal(creditState21.balance, 3);
    const summary = sm21.callBillingSummary(db, 2104, 'standard');
    assert.equal(summary.answered, 80);
    assert.equal(summary.allowance, 60);
    assert.equal(summary.overage_due_credits, 0);
  });

  creditState21.balance = 0;
  planCb21 = 'free'; // allowance 0 — every answered block of 10 is over cap
  const brokeSid = seedCounted21(2106, 10, 'CAseedC');
  const settleBroke = await callBilling21.settleCallBilling(1, 2106, brokeSid);
  check('batch21 billing: insufficient balance accrues overage due and the call still stands', () => {
    assert.equal(settleBroke.settled, true);
    assert.equal(settleBroke.overage_due_credits, 1);
    const st = sm21.getCallBillingState(db, 2106, month21);
    assert.equal(st.overage_due_credits, 1);
    assert.equal(st.last_billed_threshold, 1);
    // The calls themselves were logged and counted — never blocked.
    assert.equal(sm21.countCountedCalls(db, 2106, month21), 10);
    assert.equal(sm21.listCalls(db, 2106).length, 10);
    assert.equal(creditState21.spends.filter((x) => x.reason === 'Call tracking overage').length, 2);
  });

  const seedRecorded21 = (leadId, sid) => {
    db.prepare(
      "INSERT INTO call_logs (lead_id, call_sid, from_number, to_number, status, duration_seconds, counted, recording_url) VALUES (?, ?, '+16105550001', '+16105551234', 'completed', 30, 1, 'https://api.twilio.com/rec/REx')"
    ).run(leadId, sid);
  };
  planCb21 = 'standard';
  creditState21.balance = 1;
  seedRecorded21(2104, 'CAtr-std');
  const trStd = await callBilling21.transcribeCallRecording(1, 2104, 'CAtr-std');
  const trStdAgain = await callBilling21.transcribeCallRecording(1, 2104, 'CAtr-std');
  check('batch21 billing: transcription debits 1 credit on standard, once per call', () => {
    assert.equal(trStd.ok, true);
    const row = sm21.getCallLogBySid(db, 'CAtr-std');
    assert.equal(row.transcript, 'Hello from the caller.');
    assert.equal(row.transcript_status, 'done');
    assert.equal(row.transcription_billed, 1);
    const spends = creditState21.spends.filter((x) => x.reason === 'Call transcription');
    assert.equal(spends.length, 1);
    assert.equal(spends[0].refId, 'CAtr-std');
    assert.equal(creditState21.balance, 0);
  });
  planCb21 = 'premium';
  creditState21.balance = 0;
  seedRecorded21(2104, 'CAtr-prem');
  const trPrem = await callBilling21.transcribeCallRecording(1, 2104, 'CAtr-prem');
  check('batch21 billing: transcription is included on premium (no debit, works at zero balance)', () => {
    assert.equal(trPrem.ok, true);
    assert.equal(sm21.getCallLogBySid(db, 'CAtr-prem').transcript_status, 'done');
    assert.equal(creditState21.spends.filter((x) => x.reason === 'Call transcription').length, 1);
  });
  planCb21 = 'standard';
  creditState21.balance = 0;
  const transcribeCallsBefore = transcribeCalls21;
  seedRecorded21(2104, 'CAtr-broke');
  const trBroke = await callBilling21.transcribeCallRecording(1, 2104, 'CAtr-broke');
  check('batch21 billing: zero balance skips transcription entirely', () => {
    assert.equal(trBroke.ok, false);
    assert.equal(trBroke.reason, 'skipped_no_credits');
    const row = sm21.getCallLogBySid(db, 'CAtr-broke');
    assert.equal(row.transcript_status, 'skipped_no_credits');
    assert.equal(row.transcript, '');
    assert.equal(transcribeCalls21, transcribeCallsBefore, 'STT provider never called');
  });

  // Free-plan purchase gate at the domain boundary (Twilio never runs).
  planVar21 = 'free';
  const purchaseCallsBefore21 = purchaseCalls21.length;
  let planErr21 = null;
  try {
    await domain21.adminPurchaseCallNumber(1, { leadId: 2103, phoneNumber: '+16105550321' });
  } catch (e) {
    planErr21 = e;
  }
  planVar21 = 'standard';
  check('batch21 billing: free-plan number purchase is blocked before Twilio', () => {
    assert.equal(planErr21 && planErr21.code, 'PLAN_REQUIRED');
    assert.ok(/paid plan/i.test(planErr21.message));
    assert.equal(purchaseCalls21.length, purchaseCallsBefore21);
    assert.notEqual(sm21.getCallTrackingConfig(db, 2103).display_number, '+16105550321');
  });

  // --- Batch 21 addendum #4/#5: per-call email notifications -----------
  require(path.join(root, 'server/contactForms.js')).ensureTables(db);
  db.prepare("INSERT INTO leads (id, business_name, email) VALUES (2107, 'Fixture Notify', 'owner@example.invalid')").run();
  db.prepare("INSERT INTO leads (id, business_name, email) VALUES (2108, 'Fixture Notify Bare', 'bare@example.invalid')").run();
  // The form-alert recipient: the lead's form notify_email wins.
  db.prepare("INSERT INTO contact_forms (lead_id, name, notify_email) VALUES (2107, 'Contact form', 'alerts@example.invalid')").run();
  sm21.updateCallTrackingConfig(db, 2107, { display_number: '+16105551234' });
  sm21.updateCallTrackingConfig(db, 2108, { display_number: '+16105551234' });

  const mailState21 = { sent: [], behavior: 'ok' };
  const callNotify21 = load('server/callNotify.js', {
    './domain': { withDb: (_ws, fn) => fn(db) },
    './siteModules': sm21,
    './mailer': {
      sendPlatformMail: async (msg) => {
        if (mailState21.behavior === 'fail') throw new Error('SMTP blew up');
        if (mailState21.behavior === 'unconfigured') {
          const e = new Error('Platform SMTP is not configured');
          e.code = 'SMTP_NOT_CONFIGURED';
          throw e;
        }
        mailState21.sent.push(msg);
        return { sent: true };
      },
    },
    './stripeClient': { appUrl: () => 'https://example.test' },
  });
  const terminalCall21 = (leadId, sid, status, duration) => {
    sm21.logCallInitiated(db, leadId, { callSid: sid, from: '+16105550123', to: '+16105551234', verified: true });
    return sm21.upsertCallStatus(
      db,
      leadId,
      { CallSid: sid, From: '+16105550123', To: '+16105551234', CallStatus: status, DialCallStatus: status, DialCallDuration: String(duration) },
      { verified: true }
    );
  };

  check('batch21 notify: setting defaults on', () => {
    assert.equal(sm21.getCallTrackingConfig(db, 2107).notify_email, true);
  });

  terminalCall21(2107, 'CAemail-answered', 'completed', 83);
  const notifyA = await callNotify21.notifyCallByEmail(1, 2107, 'CAemail-answered');
  const notifyAgain = await callNotify21.notifyCallByEmail(1, 2107, 'CAemail-answered');
  check('batch21 notify: terminal answered call emails the form notify address exactly once, fixed subject', () => {
    assert.equal(notifyA.sent, true);
    assert.equal(mailState21.sent.length, 1);
    const msg = mailState21.sent[0];
    assert.equal(msg.to, 'alerts@example.invalid');
    assert.equal(msg.subject, 'Incoming call from new lead');
    const body = (msg.paragraphs || []).join('\n');
    assert.ok(body.includes('+16105550123'));
    assert.ok(/answered/i.test(body));
    assert.ok(body.includes('1:23'));
    assert.ok(body.includes('completed'));
    assert.equal(msg.cta.url, 'https://example.test/portal');
    assert.equal(sm21.getCallLogBySid(db, 'CAemail-answered').notify_status, 'sent');
    assert.equal(notifyAgain.sent, false, 'duplicate callback never re-sends');
  });

  terminalCall21(2107, 'CAemail-missed', 'no-answer', 0);
  await callNotify21.notifyCallByEmail(1, 2107, 'CAemail-missed');
  check('batch21 notify: missed call uses missed wording, same fixed subject', () => {
    assert.equal(mailState21.sent.length, 2);
    const msg = mailState21.sent[1];
    assert.equal(msg.subject, 'Incoming call from new lead');
    const body = (msg.paragraphs || []).join('\n');
    assert.ok(/missed/i.test(body));
    assert.ok(body.includes('no-answer'));
  });

  // Recording/transcript availability is mentioned — contents never leak.
  terminalCall21(2107, 'CAemail-rec', 'completed', 30);
  sm21.storeCallRecording(db, 'CAemail-rec', { recordingSid: 'REmail', recordingUrl: 'https://api.twilio.com/rec/REmail', recordingDuration: '29' });
  sm21.setCallTranscript(db, 'CAemail-rec', { status: 'done', text: 'SECRET TRANSCRIPT TEXT' });
  await callNotify21.notifyCallByEmail(1, 2107, 'CAemail-rec');
  check('batch21 notify: recording/transcript availability line, no contents in the email', () => {
    assert.equal(mailState21.sent.length, 3);
    const msg = mailState21.sent[2];
    const body = (msg.paragraphs || []).join('\n') + '\n' + (msg.text || '');
    assert.ok(/recording/.test(body) && /transcript/.test(body) && /available in your portal/.test(body));
    assert.ok(!body.includes('SECRET TRANSCRIPT TEXT'));
    assert.ok(!body.includes('api.twilio.com/rec'));
  });

  sm21.updateCallTrackingConfig(db, 2108, { notify_email: false });
  terminalCall21(2108, 'CAemail-off', 'completed', 20);
  const notifyOff = await callNotify21.notifyCallByEmail(1, 2108, 'CAemail-off');
  check('batch21 notify: notify_email=false sends nothing and marks off', () => {
    assert.equal(notifyOff.sent, false);
    assert.equal(mailState21.sent.length, 3);
    assert.equal(sm21.getCallLogBySid(db, 'CAemail-off').notify_status, 'off');
  });

  sm21.updateCallTrackingConfig(db, 2108, { notify_email: true });
  terminalCall21(2108, 'CAemail-bare', 'completed', 20);
  await callNotify21.notifyCallByEmail(1, 2108, 'CAemail-bare');
  check('batch21 notify: without a form, the recipient falls back to the lead email', () => {
    assert.equal(mailState21.sent.length, 4);
    assert.equal(mailState21.sent[3].to, 'bare@example.invalid');
  });

  mailState21.behavior = 'fail';
  terminalCall21(2107, 'CAemail-fail', 'completed', 20);
  const notifyFail = await callNotify21.notifyCallByEmail(1, 2107, 'CAemail-fail');
  check('batch21 notify: mailer failure marks failed and never throws into the webhook', () => {
    assert.equal(notifyFail.sent, false);
    assert.equal(notifyFail.reason, 'send_failed');
    assert.equal(sm21.getCallLogBySid(db, 'CAemail-fail').notify_status, 'failed');
    assert.equal(mailState21.sent.length, 4);
  });

  mailState21.behavior = 'unconfigured';
  terminalCall21(2107, 'CAemail-skip', 'busy', 0);
  const notifySkip = await callNotify21.notifyCallByEmail(1, 2107, 'CAemail-skip');
  check('batch21 notify: unconfigured mail is a silent skip', () => {
    assert.equal(notifySkip.sent, false);
    assert.equal(notifySkip.reason, 'mail_not_configured');
    assert.equal(sm21.getCallLogBySid(db, 'CAemail-skip').notify_status, 'skipped');
  });
  mailState21.behavior = 'ok';

  // --- Batch 21b: owner email notifications for every visitor form ----
  // Every visitor-created record emails the site owner. Contact forms
  // always did — except when the form's notify_email was empty: the
  // alert silently went nowhere. acceptSubmission now falls back to
  // the LEAD's email at send time. Bookings, estimate requests, member
  // signups, paid memberships (Stripe webhook) and paid shop orders
  // (Stripe webhook) notify via server/ownerNotify.js, fired once per
  // created record; webhooks gate on the pending → paid / new-row
  // transition so redeliveries stay silent.
  const mailState21b = { sent: [], behavior: 'ok' };
  const mailerStub21b = {
    sendPlatformMail: async (msg) => {
      if (mailState21b.behavior === 'fail') throw new Error('SMTP blew up');
      if (mailState21b.behavior === 'unconfigured') {
        const e = new Error('Platform SMTP is not configured');
        e.code = 'SMTP_NOT_CONFIGURED';
        throw e;
      }
      mailState21b.sent.push(msg);
      return { sent: true };
    },
  };
  const flush21b = () => new Promise((r) => setImmediate(r));
  const lastMail21b = () => mailState21b.sent[mailState21b.sent.length - 1];
  const sm21b = load('server/siteModules.js', {
    '../src/pageContentScan': require(path.join(root, 'src/pageContentScan.js')),
    '../src/websiteEngine': require(path.join(root, 'src/websiteEngine.js')),
    './portalContacts': contacts,
    '../src/secretBox': require(path.join(root, 'src/secretBox.js')),
    './membershipStripe': {},
    './shopStripe': {},
  });
  sm21b.ensureTables(db);
  const callNotify21b = load('server/callNotify.js', {
    './domain': { withDb: (_ws, fn) => fn(db) },
    './siteModules': sm21b,
    './mailer': mailerStub21b,
    './stripeClient': { appUrl: () => 'https://example.test' },
  });
  const ownerNotify21b = load('server/ownerNotify.js', {
    './domain': { withDb: (_ws, fn) => fn(db) },
    './mailer': mailerStub21b,
    './callNotify': callNotify21b,
    './stripeClient': { appUrl: () => 'https://example.test' },
  });
  for (const [id, name, email] of [
    [2181, 'Fixture Forms B', 'formsb@example.invalid'],
    [2182, 'Fixture Bare Forms B', ''],
    [2183, 'Fixture Bookings B', 'booksb@example.invalid'],
    [2184, 'Fixture Estimate B', 'estb@example.invalid'],
    [2185, 'Fixture Members B', 'memb@example.invalid'],
    [2186, 'Fixture Shop B', 'shopb@example.invalid'],
    [2187, 'Fixture Bookings Bare', ''],
  ]) {
    db.prepare('INSERT INTO leads (id, business_name, email) VALUES (?, ?, ?)').run(id, name, email);
  }
  const homePages21b = JSON.stringify([
    {
      slug: 'index',
      title: 'Home',
      sections: [
        { type: 'nav', content: {} },
        { type: 'html', content: { html: '<p>hi</p>' } },
        { type: 'footer', content: {} },
      ],
    },
  ]);
  for (const id of [2183, 2184, 2185, 2186, 2187]) {
    db.prepare('INSERT INTO websites (lead_id, name, theme, pages) VALUES (?, ?, ?, ?)').run(id, `Site ${id}`, '{}', homePages21b);
  }

  // (a) Contact forms — the empty-notify_email hole is fixed at send time.
  const cf21b = load('server/contactForms.js', {
    './plans': { getPlan: () => ({ id: 'free', entitlements: {} }), normalizePlanId: (v) => v || 'free' },
    './portalContacts': contacts,
    './mailer': mailerStub21b,
    './museRouter': {},
  });
  cf21b.ensureTables(db);
  const mkForm21b = (leadId, token, notifyEmail) => {
    const info = db
      .prepare(
        "INSERT INTO contact_forms (lead_id, name, title, notify_email, public_token, published) VALUES (?, 'Contact', 'Contact Us', ?, ?, 1)"
      )
      .run(leadId, notifyEmail, token);
    db.prepare(
      "INSERT INTO form_fields (form_id, field_key, label, field_type, required) VALUES (?, 'message', 'Message', 'textarea', 0)"
    ).run(info.lastInsertRowid);
    return info.lastInsertRowid;
  };
  mkForm21b(2181, 'tok-21b-a', '');
  const subA21b = await cf21b.acceptSubmission(db, {
    token: 'tok-21b-a',
    values: { message: 'Hello from a visitor' },
    workspaceId: 1,
    planId: 'free',
  });
  check('batch21b forms: empty notify_email falls back to the lead email at send time', () => {
    assert.equal(subA21b.email && subA21b.email.sent, true);
    assert.equal(mailState21b.sent.length, 1);
    assert.equal(mailState21b.sent[0].to, 'formsb@example.invalid');
    assert.equal(mailState21b.sent[0].subject, 'New form submission — Contact Us');
  });
  mkForm21b(2181, 'tok-21b-b', 'explicit@example.invalid');
  const subB21b = await cf21b.acceptSubmission(db, {
    token: 'tok-21b-b',
    values: { message: 'Second visitor' },
    workspaceId: 1,
    planId: 'free',
  });
  check('batch21b forms: a set form notify_email still wins over the lead email', () => {
    assert.equal(subB21b.email && subB21b.email.sent, true);
    assert.equal(mailState21b.sent.length, 2);
    assert.equal(mailState21b.sent[1].to, 'explicit@example.invalid');
  });
  mkForm21b(2182, 'tok-21b-c', '');
  const subC21b = await cf21b.acceptSubmission(db, {
    token: 'tok-21b-c',
    values: { message: 'No one home' },
    workspaceId: 1,
    planId: 'free',
  });
  check('batch21b forms: no recipient anywhere sends nothing and keeps the submission', () => {
    assert.equal(subC21b.email && subC21b.email.sent, false);
    assert.equal(subC21b.email && subC21b.email.error, 'NO_NOTIFY_EMAIL');
    assert.equal(mailState21b.sent.length, 2);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM form_submissions WHERE id = ?').get(subC21b.id).c, 1);
  });

  // (b) Route harness for the public module routes + both Stripe webhooks.
  function stubRouter21b() {
    const routes = [];
    const router = { use() {} };
    for (const m of ['get', 'post', 'put', 'patch', 'delete']) {
      router[m] = (route, ...handlers) => routes.push({ method: m, route, handlers });
    }
    return { routes, router };
  }
  async function callRoute21b(routes, method, routePath, req) {
    const route = routes.find((x) => x.method === method && x.route === routePath);
    assert(route, `${method} ${routePath} registered`);
    let status = 200;
    let body;
    const res = {
      status(v) {
        status = v;
        return this;
      },
      json(v) {
        body = v;
        return this;
      },
    };
    for (const handler of route.handlers) {
      let advanced = false;
      await handler(req, res, () => {
        advanced = true;
      });
      if (!advanced) break;
    }
    return { status, body };
  }
  const reqFor21b = (params, body) => ({ params, body: body || {}, query: {}, headers: {}, get: () => '' });
  const mod21b = stubRouter21b();
  load('server/routes/modulesPublic.js', {
    express: { Router: () => mod21b.router },
    '../domain': { withDb: (_ws, fn) => fn(db) },
    '../siteModules': sm21b,
    '../captcha': {
      requireCaptcha: () => (_req, _res, next) => next(),
      getCaptchaConfig: async () => ({ enabled: false }),
    },
    '../rateLimit': { rateLimit: () => (_req, _res, next) => next() },
    '../workspaceExists': { assertWorkspaceExists: async () => {} },
    '../ownerNotify': ownerNotify21b,
    '../apiErrors': apiErrors,
  });
  async function bookViaRoute21b(token, serviceId, customerEmail) {
    for (let add = 2; add <= 45; add++) {
      const d = new Date();
      d.setDate(d.getDate() + add);
      if (d.getDay() === 0 || d.getDay() === 6) continue;
      const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      let avail;
      try {
        avail = sm21b.getPublicBookingSlots(db, token, { date: ymd, serviceId });
      } catch {
        continue;
      }
      if (!avail.slots || !avail.slots.length) continue;
      const slot = avail.slots[0];
      return callRoute21b(
        mod21b.routes,
        'post',
        '/:token/book',
        reqFor21b(
          { token },
          {
            service_id: serviceId,
            customer_name: 'Walk In',
            customer_email: customerEmail,
            date: ymd,
            time: slot.label || String(slot.starts_at).slice(11, 16),
          }
        )
      );
    }
    throw new Error('no bookable slot found');
  }

  // Bookings: owner email on create, form notify address wins the chain.
  const embBook21b = sm21b.attachModule(db, 2183, 'bookings', { workspaceId: 1, appUrl: 'https://example.test' }).embed;
  const svcBook21b = sm21b.createBookingService(db, 2183, {
    name: 'Haircut',
    status: 'published',
    duration_minutes: 60,
  });
  db.prepare('DELETE FROM contact_forms WHERE lead_id = 2183').run();
  db.prepare(
    "INSERT INTO contact_forms (lead_id, name, notify_email) VALUES (2183, 'Contact', 'bookalerts@example.invalid')"
  ).run();
  const mailBeforeBook21b = mailState21b.sent.length;
  const bookRes1 = await bookViaRoute21b(embBook21b.public_token, svcBook21b.id, 'walkin@example.invalid');
  await flush21b();
  check('batch21b bookings: a public booking emails the owner once (form notify wins)', () => {
    assert.equal(bookRes1.status, 200);
    assert.equal(bookRes1.body.ok, true);
    assert.equal(mailState21b.sent.length, mailBeforeBook21b + 1);
    const msg = lastMail21b();
    assert.equal(msg.to, 'bookalerts@example.invalid');
    assert.equal(msg.subject, 'New booking from your website');
    const body = (msg.paragraphs || []).join('\n');
    assert.ok(body.includes('Haircut'));
    assert.ok(body.includes('Walk In'));
  });
  mailState21b.behavior = 'fail';
  const bookCountBeforeFail = db.prepare('SELECT COUNT(*) AS c FROM bookings WHERE lead_id = 2183').get().c;
  const bookRes2 = await bookViaRoute21b(embBook21b.public_token, svcBook21b.id, 'second@example.invalid');
  await flush21b();
  mailState21b.behavior = 'ok';
  check('batch21b bookings: a mailer failure never fails the booking', () => {
    assert.equal(bookRes2.status, 200);
    assert.equal(bookRes2.body.ok, true);
    assert.equal(
      db.prepare('SELECT COUNT(*) AS c FROM bookings WHERE lead_id = 2183').get().c,
      bookCountBeforeFail + 1
    );
  });
  const embBookBare = sm21b.attachModule(db, 2187, 'bookings', { workspaceId: 1, appUrl: 'https://example.test' }).embed;
  const svcBare21b = sm21b.createBookingService(db, 2187, { name: 'Trim', status: 'published', duration_minutes: 30 });
  const mailBeforeBare = mailState21b.sent.length;
  const bookRes3 = await bookViaRoute21b(embBookBare.public_token, svcBare21b.id, 'bare@example.invalid');
  await flush21b();
  check('batch21b bookings: no owner email anywhere sends nothing; booking still created', () => {
    assert.equal(bookRes3.status, 200);
    assert.equal(bookRes3.body.ok, true);
    assert.equal(mailState21b.sent.length, mailBeforeBare);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM bookings WHERE lead_id = 2187').get().c, 1);
  });

  // Estimate requests: owner email on create.
  const embEst21b = sm21b.attachModule(db, 2184, 'estimate', { workspaceId: 1, appUrl: 'https://example.test' }).embed;
  const optEst21b = sm21b.createEstimateOption(db, 2184, { label: 'Deep clean', input_type: 'checkbox', price: 40 });
  const mailBeforeEst = mailState21b.sent.length;
  const estRes = await callRoute21b(
    mod21b.routes,
    'post',
    '/:token/estimate',
    reqFor21b(
      { token: embEst21b.public_token },
      { name: 'Est Visitor', email: 'estvis@example.invalid', selections: [{ option_id: optEst21b.id, checked: true }] }
    )
  );
  await flush21b();
  check('batch21b estimates: a public estimate request emails the owner', () => {
    assert.equal(estRes.status, 200);
    assert.equal(estRes.body.ok, true);
    assert.equal(mailState21b.sent.length, mailBeforeEst + 1);
    const msg = lastMail21b();
    assert.equal(msg.to, 'estb@example.invalid');
    assert.equal(msg.subject, 'New estimate request from your website');
    const body = (msg.paragraphs || []).join('\n');
    assert.ok(body.includes('Est Visitor'));
    assert.ok(body.includes('Deep clean'));
  });

  // Member signups: owner email on create (approval visibility).
  const embMem21b = sm21b.attachModule(db, 2185, 'members', { workspaceId: 1, appUrl: 'https://example.test' }).embed;
  const mailBeforeSignup = mailState21b.sent.length;
  const signupRes = await callRoute21b(
    mod21b.routes,
    'post',
    '/:token/members/signup',
    reqFor21b(
      { token: embMem21b.public_token },
      { name: 'New Member', email: 'newmember@example.invalid', password: 'password123' }
    )
  );
  await flush21b();
  check('batch21b members: a public member signup emails the owner', () => {
    assert.equal(signupRes.status, 200);
    assert.equal(signupRes.body.ok, true);
    assert.equal(mailState21b.sent.length, mailBeforeSignup + 1);
    const msg = lastMail21b();
    assert.equal(msg.to, 'memb@example.invalid');
    assert.equal(msg.subject, 'New member signup from your website');
    assert.ok((msg.paragraphs || []).join('\n').includes('newmember@example.invalid'));
  });

  // Notifier robustness, direct: mailer failure is reported, not thrown;
  // a missing record is a quiet no-op.
  mailState21b.behavior = 'fail';
  const directFail21b = await ownerNotify21b.notifyOwnerOfEstimateRequest(1, estRes.body.data.request.id);
  mailState21b.behavior = 'ok';
  const directGone21b = await ownerNotify21b.notifyOwnerOfBooking(1, 99999999);
  check('batch21b notify: mailer failure and missing record never throw', () => {
    assert.equal(directFail21b.sent, false);
    assert.equal(directFail21b.reason, 'send_failed');
    assert.equal(directGone21b.sent, false);
    assert.equal(directGone21b.reason, 'not_found');
  });

  // Shop orders: owner email only on the pending → paid transition.
  // Batch 129: shopWebhook.js is an alias — the route under test is
  // the ONE payments webhook handler, loaded here with the unified
  // paymentsConfig verification mocked the way shopStripe's
  // constructEventForShop used to be.
  const shopHook21b = stubRouter21b();
  const paymentsHookShop21b = load('server/routes/paymentsWebhook.js', {
    express: { Router: () => shopHook21b.router },
    '../domain': { withDb: (_ws, fn) => fn(db) },
    '../siteModules': sm21b,
    '../shopStripe': {
      constructEvent: (_db, raw) => JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw)),
    },
    '../paymentsConfig': {
      resolveLeadForEvent: () => 2186,
      constructEventAny: (_db, _leadId, raw) => ({
        event: JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw)),
        source: 'lead',
      }),
    },
    '../workspaceExists': { assertWorkspaceExists: async () => {} },
    '../ownerNotify': ownerNotify21b,
    '../apiErrors': apiErrors,
  });
  load('server/routes/shopWebhook.js', { './paymentsWebhook': paymentsHookShop21b });
  const prodShop21b = sm21b.createProduct(db, 2186, { name: 'Widget', price_cents: 2500, status: 'published' });
  db.prepare(
    "INSERT INTO ecommerce_orders (lead_id, product_id, product_name, amount_cents, currency, status, stripe_session_id) VALUES (2186, ?, 'Widget', 2500, 'USD', 'pending', 'cs_test_21b')"
  ).run(prodShop21b.id);
  const shopEvent21b = {
    type: 'checkout.session.completed',
    data: {
      object: { id: 'cs_test_21b', payment_intent: 'pi_21b', customer_details: { email: 'buyer@example.invalid' } },
    },
  };
  const shopReq21b = () => ({
    params: { workspaceId: '1' },
    body: Buffer.from(JSON.stringify(shopEvent21b)),
    headers: {},
    get: () => '',
  });
  const mailBeforeShop = mailState21b.sent.length;
  const shopRes1 = await callRoute21b(shopHook21b.routes, 'post', '/:workspaceId', shopReq21b());
  await flush21b();
  check('batch21b shop: a paid order emails the owner', () => {
    assert.equal(shopRes1.status, 200);
    assert.equal(shopRes1.body.ok, true);
    assert.equal(mailState21b.sent.length, mailBeforeShop + 1);
    const msg = lastMail21b();
    assert.equal(msg.to, 'shopb@example.invalid');
    assert.equal(msg.subject, 'New order from your website');
    const body = (msg.paragraphs || []).join('\n');
    assert.ok(body.includes('Widget'));
    assert.ok(body.includes('$25.00'));
    assert.equal(
      db.prepare("SELECT status FROM ecommerce_orders WHERE stripe_session_id = 'cs_test_21b'").get().status,
      'paid'
    );
  });
  const shopRes2 = await callRoute21b(shopHook21b.routes, 'post', '/:workspaceId', shopReq21b());
  await flush21b();
  check('batch21b shop: a redelivered webhook does not email the owner again', () => {
    assert.equal(shopRes2.status, 200);
    assert.equal(mailState21b.sent.length, mailBeforeShop + 1);
  });

  // Memberships: owner email only when checkout CREATES the subscription.
  // Batch 129: membershipWebhook.js is an alias of the same unified
  // handler; its verification is mocked through paymentsConfig.
  const memHook21b = stubRouter21b();
  const paymentsHookMem21b = load('server/routes/paymentsWebhook.js', {
    express: { Router: () => memHook21b.router },
    '../domain': { withDb: (_ws, fn) => fn(db) },
    '../siteModules': sm21b,
    '../shopStripe': {
      constructEvent: (_db, raw) => JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw)),
    },
    '../paymentsConfig': {
      resolveLeadForEvent: (_db, peek) => Number(peek.data.object.metadata.bitpype_lead_id),
      constructEventAny: (_db, _leadId, raw) => ({
        event: JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw)),
        source: 'membership',
      }),
    },
    '../workspaceExists': { assertWorkspaceExists: async () => {} },
    '../ownerNotify': ownerNotify21b,
    '../apiErrors': apiErrors,
  });
  load('server/routes/membershipWebhook.js', { './paymentsWebhook': paymentsHookMem21b });
  const tier21b = sm21b.insertMembershipTier(db, 2185, {
    name: 'Gold',
    description: '',
    price_cents: 1500,
    interval: 'month',
    sort_order: 0,
  });
  const member21b = sm21b.signupMember(db, 2185, {
    name: 'Paying Pat',
    email: 'patpay@example.invalid',
    password: 'password123',
  }).member;
  const memEvent21b = {
    type: 'checkout.session.completed',
    data: {
      object: {
        customer: 'cus_21b',
        subscription: 'sub_21b',
        payment_status: 'paid',
        metadata: {
          bitpype_lead_id: '2185',
          bitpype_member_id: String(member21b.id),
          bitpype_tier_id: String(tier21b.id),
        },
      },
    },
  };
  const memReq21b = () => ({
    params: { workspaceId: '1' },
    body: Buffer.from(JSON.stringify(memEvent21b)),
    headers: {},
    get: () => '',
  });
  const mailBeforeMem = mailState21b.sent.length;
  const memRes1 = await callRoute21b(memHook21b.routes, 'post', '/:workspaceId', memReq21b());
  await flush21b();
  check('batch21b memberships: a newly created paid membership emails the owner', () => {
    assert.equal(memRes1.status, 200);
    assert.equal(memRes1.body.ok, true);
    assert.equal(mailState21b.sent.length, mailBeforeMem + 1);
    const msg = lastMail21b();
    assert.equal(msg.to, 'memb@example.invalid');
    assert.equal(msg.subject, 'New membership from your website');
    const body = (msg.paragraphs || []).join('\n');
    assert.ok(body.includes('Gold'));
    assert.ok(body.includes('patpay@example.invalid'));
  });
  const memRes2 = await callRoute21b(memHook21b.routes, 'post', '/:workspaceId', memReq21b());
  await flush21b();
  check('batch21b memberships: a redelivered webhook does not email the owner again', () => {
    assert.equal(memRes2.status, 200);
    assert.equal(mailState21b.sent.length, mailBeforeMem + 1);
  });

  // --- AI SEO tool (Batch 22): generate → preview → apply on the staff
  // facade and the owner portal, AI stubbed at the src/ai seam ---------
  const realAi22 = require(path.join(root, 'src/ai.js'));
  let canned22 = '{}';
  let lastChatArgs22 = null;
  const stubAi22 = {
    aiConfigured: (d) => realAi22.aiConfigured(d),
    chat: async (args) => {
      lastChatArgs22 = args;
      return { text: canned22, model: 'stub-model', promptTokens: 10, completionTokens: 10, costUsd: 0 };
    },
  };
  const seo22 = load('server/seoTool.js', {
    '../src/ai': stubAi22,
    '../src/seoSchema': require(path.join(root, 'src/seoSchema.js')),
  });
  seo22.ensureSeoTables(db);
  db.prepare(
    `INSERT INTO leads (id, business_name, category, phone, email, city, state, address, postal_code, services)
     VALUES (2201, 'Fixture Plumbing Co', 'Plumber', '+16105550100', 'seo@example.invalid', 'Reading', 'PA', '12 Main St', '19601', '["Drain cleaning","Water heaters"]')`
  ).run();
  db.prepare(
    `INSERT INTO leads (id, business_name, category, email, city, state)
     VALUES (2202, 'Fixture Other Biz', 'Bakery', 'other@example.invalid', 'York', 'PA')`
  ).run();
  const pages2201 = [
    {
      slug: 'index',
      title: 'Fixture Plumbing Co',
      sections: [
        { type: 'hero', content: { headline: 'We Fix Pipes', subheadline: 'Fast help', image: { url: 'https://img.test/hero.jpg', alt: '' } } },
        { type: 'services', content: { title: 'Our Services', items: [{ name: 'Drain cleaning' }, { name: 'Water heaters' }] } },
        { type: 'gallery', content: { title: 'Gallery', images: [{ url: 'https://img.test/van.jpg', alt: '' }, { url: 'https://img.test/crew.jpg', alt: 'Crew' }] } },
      ],
    },
    {
      slug: 'services',
      title: 'Services',
      description: 'Old description',
      sections: [
        { type: 'heading', content: { heading: 'What We Do' } },
        { type: 'text_image', content: { heading: 'Meet the Team', image: { url: 'https://img.test/team.jpg', alt: 'Team photo working on a sink repair job' } } },
      ],
    },
  ];
  db.prepare('INSERT INTO websites (id, lead_id, name, industry, theme, pages, status) VALUES (2201, 2201, ?, ?, ?, ?, ?)').run(
    'Fixture Plumbing Co',
    'Plumbing',
    JSON.stringify({ primary: '#123456', customHead: '<meta name="robots" content="index">' }),
    JSON.stringify(pages2201),
    'published'
  );
  const pages2202 = [{ slug: 'index', title: 'Other Biz', sections: [{ type: 'hero', content: { headline: 'Fresh Bread' } }] }];
  db.prepare('INSERT INTO websites (id, lead_id, name, industry, theme, pages, status) VALUES (2202, 2202, ?, ?, ?, ?, ?)').run(
    'Fixture Other Biz',
    'Bakery',
    JSON.stringify({}),
    JSON.stringify(pages2202),
    'draft'
  );
  const siteRow22 = (id) => db.prepare('SELECT * FROM websites WHERE id = ?').get(id);

  db.prepare("DELETE FROM settings WHERE key = 'ai.api_key'").run();
  assert.equal(seo22.getSeoState(db, 2201).configured, false);
  await assert.rejects(seo22.generateSeoProposal(db, 2201, { actor: 'staff' }), (e) => e.code === 'AI_NOT_CONFIGURED');
  results.push('batch22 state: unconfigured AI reports configured:false and generate refuses');
  db.prepare("INSERT INTO settings (key, value) VALUES ('ai.api_key', 'sk-test22') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
  assert.equal(seo22.getSeoState(db, 2201).configured, true);

  const cannedSeo22 = (title) =>
    JSON.stringify({
      keywords: { primary: 'plumber in Reading PA', supporting: ['drain cleaning Reading PA', 'water heater repair Reading'] },
      values: {
        'meta_title:index': title,
        'meta_desc:index':
          'Fixture Plumbing Co provides drain cleaning and water heater services in Reading, PA. Call today for fast, friendly plumbing help.',
        'heading:index:0:headline': 'Trusted Plumber in Reading, PA',
        'alt:index:0:image': 'Plumber repairing a kitchen sink in Reading PA',
        'alt:index:2:images.0': 'Fixture Plumbing Co service van in Reading PA',
        'meta_title:services': 'Services',
        'bogus:id': 'must be dropped',
      },
      schemaDescription: 'Fixture Plumbing Co is a plumbing company in Reading, PA offering drain cleaning and water heater services.',
    });
  canned22 = cannedSeo22('Plumber in Reading, PA | Fixture Plumbing Co');
  const genState22 = await seo22.generateSeoProposal(db, 2201, { actor: 'staff' });
  check('batch22 generate: canned AI parses into keywords + current-vs-proposed changes; unknown ids and no-ops dropped', () => {
    assert.ok(lastChatArgs22, 'AI seam was called');
    const promptText = lastChatArgs22.messages.map((m) => m.content).join('\n');
    assert.ok(promptText.includes('Fixture Plumbing Co'));
    assert.ok(promptText.includes('Reading'));
    assert.ok(promptText.includes('meta_title:index'));
    assert.equal(lastChatArgs22.db, db);
    const proposal = genState22.pending.proposal;
    assert.equal(proposal.keywords.primary, 'plumber in Reading PA');
    assert.equal(proposal.keywords.supporting.length, 2);
    const byId = Object.fromEntries(proposal.changes.map((c) => [c.id, c]));
    assert.equal(byId['meta_title:index'].current, 'Fixture Plumbing Co');
    assert.equal(byId['meta_title:index'].proposed, 'Plumber in Reading, PA | Fixture Plumbing Co');
    assert.equal(byId['meta_desc:index'].current, '');
    assert.ok(byId['meta_desc:index'].proposed.includes('Reading, PA'));
    assert.equal(byId['heading:index:0:headline'].current, 'We Fix Pipes');
    assert.equal(byId['alt:index:2:images.0'].current, '');
    assert.ok(!('meta_title:services' in byId), 'no-op value dropped');
    assert.ok(!('bogus:id' in byId), 'unknown target id dropped');
    assert.ok(!('alt:services:1:image' in byId), 'image with a real alt is not a target');
    const schema = byId['schema'];
    assert.ok(schema, 'schema change proposed');
    assert.equal(schema.current, '');
    const ld = JSON.parse(schema.proposed);
    assert.equal(ld['@type'], 'Plumber');
    assert.equal(ld.name, 'Fixture Plumbing Co');
    assert.equal(ld.telephone, '+16105550100');
    assert.equal(ld.address.addressLocality, 'Reading');
    assert.equal(genState22.pending.generated_by, 'staff');
  });
  check('batch22 generate: nothing is applied by generating', () => {
    const site = siteRow22(2201);
    assert.equal(JSON.parse(site.pages)[0].title, 'Fixture Plumbing Co');
    assert.ok(!String(JSON.parse(site.theme).customHead || '').includes('ld+json'));
  });

  canned22 = cannedSeo22('Reading PA Plumber | Fixture Plumbing');
  const regenState22 = await seo22.generateSeoProposal(db, 2201, { actor: 'staff' });
  check('batch22 regenerate: replaces the pending proposal wholesale, still applies nothing', () => {
    const byId = Object.fromEntries(regenState22.pending.proposal.changes.map((c) => [c.id, c]));
    assert.equal(byId['meta_title:index'].proposed, 'Reading PA Plumber | Fixture Plumbing');
    assert.equal(JSON.parse(siteRow22(2201).pages)[0].title, 'Fixture Plumbing Co');
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM seo_proposals WHERE website_id = 2201').get().c, 1);
  });

  const applyRes22 = seo22.applySeoProposal(db, 2201, { actor: 'staff', actorKind: 'staff' });
  check('batch22 apply: writes pages + theme schema in one action, records history, clears pending', () => {
    assert.equal(applyRes22.skipped.length, 0);
    assert.ok(applyRes22.applied.length >= 5);
    const site = siteRow22(2201);
    const pages = JSON.parse(site.pages);
    assert.equal(pages[0].title, 'Reading PA Plumber | Fixture Plumbing');
    assert.ok(pages[0].description.includes('drain cleaning and water heater services in Reading, PA'));
    assert.equal(pages[0].sections[0].content.headline, 'Trusted Plumber in Reading, PA');
    assert.equal(pages[0].sections[0].content.image.alt, 'Plumber repairing a kitchen sink in Reading PA');
    assert.equal(pages[0].sections[2].content.images[0].alt, 'Fixture Plumbing Co service van in Reading PA');
    assert.equal(pages[1].title, 'Services', 'untouched page keeps its title');
    const theme = JSON.parse(site.theme);
    assert.ok(theme.customHead.includes('<meta name="robots" content="index">'), 'existing head content preserved');
    assert.ok(theme.customHead.includes('application/ld+json'));
    assert.ok(theme.customHead.includes('"@type": "Plumber"'));
    const state = seo22.getSeoState(db, 2201);
    assert.equal(state.pending, null);
    assert.equal(state.history.length, 1);
    assert.equal(state.history[0].actor_kind, 'staff');
    assert.equal(state.history[0].change_count, applyRes22.applied.length);
    assert.equal(state.history[0].keywords.primary, 'plumber in Reading PA');
    assert.throws(() => seo22.applySeoProposal(db, 2201, { actor: 'staff' }), (e) => e.code === 'NO_PROPOSAL');
  });

  check('batch22 render: the exported page HTML carries the new title, description and schema', () => {
    const engine22 = require(path.join(root, 'src/websiteEngine.js'));
    const site = siteRow22(2201);
    const pages = JSON.parse(site.pages);
    const html = engine22.renderPage(pages[0], pages, JSON.parse(site.theme));
    assert.ok(html.includes('<title>Reading PA Plumber | Fixture Plumbing</title>'));
    assert.ok(html.includes('name="description"'));
    assert.ok(html.includes('drain cleaning and water heater services in Reading, PA'));
    assert.ok(html.includes('application/ld+json'));
    assert.ok(html.includes('Trusted Plumber in Reading, PA'));
    assert.ok(html.includes('alt="Plumber repairing a kitchen sink in Reading PA"'));
  });

  const portal22 = load('server/clientPortal.js', {
    './portalTabs': portalTabs,
    bcryptjs: { hashSync: () => 'fixture', compareSync: () => true },
    './db': {},
    './mailer': {},
    './stripeClient': {},
    './workspaceDb': {},
    './domain': { withDb: (_ws, fn) => fn(db) },
    './portalContacts': contacts,
    './seoTool': seo22,
  });
  canned22 = JSON.stringify({
    keywords: { primary: 'plumber in Reading PA', supporting: [] },
    values: { 'meta_desc:services': 'Drain cleaning and water heaters in Reading, PA from Fixture Plumbing Co — book a visit today.' },
    // Same description as the staff-applied schema, so the schema the
    // portal proposal rebuilds is identical and no schema change joins.
    schemaDescription: 'Fixture Plumbing Co is a plumbing company in Reading, PA offering drain cleaning and water heater services.',
  });
  const portalGen22 = await portal22.generateSeoTool(1, 2201, 'seo@example.invalid');
  check('batch22 portal: owner generate lands on their own site only', () => {
    assert.equal(portalGen22.site.id, 2201);
    assert.ok(portalGen22.pending);
    assert.equal(portalGen22.pending.generated_by, 'owner');
    assert.equal(seo22.getSeoState(db, 2202).pending, null);
  });
  const portalApply22 = await portal22.applySeoTool(1, 2201, 'seo@example.invalid');
  check('batch22 portal: owner apply records actor_kind owner; the other business is untouched', () => {
    assert.equal(portalApply22.applied.length, 1);
    const pages = JSON.parse(siteRow22(2201).pages);
    assert.ok(pages[1].description.startsWith('Drain cleaning and water heaters in Reading, PA'));
    const hist = seo22.getSeoState(db, 2201).history;
    assert.equal(hist[0].actor_kind, 'owner');
    assert.equal(JSON.parse(siteRow22(2202).pages)[0].title, 'Other Biz');
    assert.equal(seo22.getSeoState(db, 2202).history.length, 0);
  });
  await assert.rejects(portal22.getSeoTool(1, 2999, 'ghost@example.invalid'), (e) => e.code === 'NO_SITE');
  results.push('batch22 portal: a lead with no website gets NO_SITE, never another site');

  const portalRoutes22 = [];
  const portalRouter22 = { use() {} };
  for (const m of ['get', 'post', 'put', 'patch', 'delete'])
    portalRouter22[m] = (route, ...handlers) => portalRoutes22.push({ method: m, route, handlers });
  load('server/routes/portal.js', {
    '../portalTabs': portalTabs,
    express: { Router: () => portalRouter22 },
    '../clientPortal': {
      ...portal22,
      findById: async () => ({ id: 7, status: 'active', workspace_id: 1, lead_id: 2201, email: 'seo@example.invalid' }),
    },
    '../captcha': { requireCaptcha: () => (_req, _res, next) => next() },
    '../rateLimit': { rateLimit: () => (_req, _res, next) => next() },
    '../mfa': { isEnabled: async () => false }, '../apiErrors': apiErrors, '../portalPassword': portalPasswordStub,
  });
  async function callPortal22(method, url, body = {}) {
    const route = portalRoutes22.find((x) => x.method === method && x.route === url);
    assert(route, url);
    const req = { session: { clientPortalId: 7, clientLastActiveAt: Date.now() }, body, query: {}, params: {}, app: { locals: {} } };
    let status = 200,
      payload;
    const res = {
      status(v) {
        status = v;
        return this;
      },
      json(v) {
        payload = v;
        return this;
      },
    };
    for (const handler of route.handlers) {
      let advanced = false;
      await handler(req, res, () => {
        advanced = true;
      });
      if (!advanced) break;
    }
    return { status, body: payload };
  }
  canned22 = cannedSeo22('Portal Route Plumber Reading PA');
  await seo22.generateSeoProposal(db, 2201, { actor: 'owner' });
  const routeApply22 = await callPortal22('post', '/seo/apply', { websiteId: 2202 });
  check('batch22 portal routes: the session lead wins over a body websiteId naming another business', () => {
    assert.equal(routeApply22.status, 200);
    assert.equal(routeApply22.body.ok, true);
    assert.equal(JSON.parse(siteRow22(2201).pages)[0].title, 'Portal Route Plumber Reading PA');
    assert.equal(JSON.parse(siteRow22(2202).pages)[0].title, 'Other Biz');
    assert.equal(seo22.getSeoState(db, 2202).pending, null);
  });
  const routeState22 = await callPortal22('get', '/seo');
  check('batch22 portal routes: GET /seo returns only the session business state', () => {
    assert.equal(routeState22.status, 200);
    assert.equal(routeState22.body.data.site.id, 2201);
    assert.equal(routeState22.body.data.configured, true);
  });

  const domain22 = load('server/domain.js', {
    './workspaceDb': { openWorkspaceDb: () => db, acquireWorkspaceDb: () => db, releaseWorkspaceDb: () => {}, leaseCount: () => 1 },
    './seoTool': seo22,
  });
  canned22 = JSON.stringify({
    keywords: { primary: 'bakery in York PA', supporting: [] },
    values: { 'meta_title:index': 'Bakery in York, PA | Fixture Other Biz' },
    schemaDescription: 'A neighborhood bakery in York, PA.',
  });
  const staffGen22 = await domain22.seoGenerate(1, 2202, 'staff');
  const staffApply22 = domain22.seoApply(1, 2202, 'staff');
  check('batch22 staff facade: list spans the workspace; staff can generate + apply for any site', () => {
    const list = domain22.seoListSites(1);
    const ids = list.sites.map((s) => s.id);
    assert.ok(ids.includes(2201) && ids.includes(2202));
    assert.equal(list.configured, true);
    assert.ok(staffGen22.pending);
    assert.equal(staffApply22.skipped.length, 0);
    assert.equal(JSON.parse(siteRow22(2202).pages)[0].title, 'Bakery in York, PA | Fixture Other Biz');
    const theme = JSON.parse(siteRow22(2202).theme);
    assert.ok(theme.customHead.includes('"@type": "Restaurant"'), 'bakery maps to a Restaurant schema');
    assert.equal(domain22.seoState(1, 2202).history[0].actor_kind, 'staff');
  });

  check('batch22 schema block: re-applying replaces the marked block in place', () => {
    const once = seo22.upsertSchemaBlock('<meta name="x" content="1">', '{"v":1}');
    const twice = seo22.upsertSchemaBlock(once, '{"v":2}');
    assert.equal((twice.match(/<!--bitpype-seo-schema-->/g) || []).length, 1);
    assert.ok(twice.includes('<meta name="x" content="1">'));
    assert.equal(seo22.currentSchema({ customHead: twice }), '{"v":2}');
    assert.equal(seo22.currentSchema({ customHead: '<meta name="x">' }), '');
  });

  // --- Batch 23: registration hide/show toggle (Admin Settings) --------
  // The real auth router runs against a flip-able registration.open platform
  // setting: OFF must hide nothing server-side by accident — it must reject
  // sign-ups before any account exists — while login keeps working.
  const settings23 = new Map();
  const platform23 = {
    getPlatformSetting: async (key, dflt) => (settings23.has(key) ? settings23.get(key) : dflt),
  };
  const bcrypt23 = require('bcryptjs');
  const passwordHash23 = bcrypt23.hashSync('fixture-pass-23', 4);
  let createdUsers23 = 0;
  const workspace23 = {
    createUserWithWorkspace: async ({ email }) => {
      createdUsers23++;
      return { userId: 2300 + createdUsers23, workspaceId: 2400 + createdUsers23, email };
    },
    findUserByEmail: async (email) => {
      const e = String(email || '').toLowerCase();
      if (e === 'member23@example.invalid')
        return {
          id: 2301,
          email: 'member23@example.invalid',
          name: 'Member',
          password_hash: passwordHash23,
          is_super_admin: 0,
          subscription_status: 'none',
          billing_plan: 'free',
          status: 'active',
          created_at: '2026-01-01',
        };
      // Batch 53: the account created by the register check below must be
      // findable so its parked MFA challenge can complete (finishStaffLogin
      // re-loads the user by the challenge email, exactly like login).
      if (e === 'new23@example.invalid' && createdUsers23 > 0)
        return {
          id: 2301,
          email: 'new23@example.invalid',
          name: 'New',
          password_hash: passwordHash23,
          is_super_admin: 0,
          subscription_status: 'none',
          billing_plan: 'free',
          status: 'active',
          created_at: '2026-01-01',
        };
      return null;
    },
    listWorkspacesForUser: async () => [{ id: 2401, name: 'Fixture WS', role: 'owner' }],
  };
  const billing23 = {
    isSubscribed: () => false,
    requireSubscriptionEnabled: async () => false,
    workspaceHasSubscription: async () => false,
    workspaceHasProductAccess: async () => false,
    hasProductAccess: () => false,
    planOfUser: () => 'free',
    workspacePlan: async () => 'free',
    getUserBilling: async () => ({}),
  };
  // Batch 40: staff login now interposes a required TOTP factor. The
  // fixture user has MFA enabled, so /login returns a challenge and the
  // session is issued only by /mfa/verify (stubbed code check here;
  // the real crypto is pinned by tests/mfa-totp-regressions.cjs).
  const mfa23 = {
    getState: async () => ({ exists: true, enabled: true, hasPending: false, lockedUntil: null }),
    verifyLoginCode: async () => ({ via: 'totp' }),
  };
  const authRoutes23 = [];
  const authRouter23 = { use() {} };
  for (const method of ['get', 'post', 'put', 'patch', 'delete'])
    authRouter23[method] = (route, ...handlers) => authRoutes23.push({ method, route, handlers });
  load('server/routes/auth.js', {
    express: { Router: () => authRouter23 },
    bcryptjs: bcrypt23,
    '../workspace': workspace23,
    '../middleware': { requireAuth: (_req, _res, next) => next() },
    '../rateLimit': { rateLimit: () => (_req, _res, next) => next() },
    '../captcha': { requireCaptcha: () => (_req, _res, next) => next() },
    '../mfa': mfa23,
    '../platform': platform23,
    '../billing': billing23,
    '../admin': { touchLogin: async () => {} },
    '../passwordReset': { requestReset: async () => ({}), confirmReset: async () => {} },
    '../branding': { tagline: () => 'Local business desk' },
    '../invites': { acceptInvite: async () => ({ workspaceId: 2401 }) },
    '../db': { query: async () => [] },
    '../apiErrors': apiErrors,
  });
  async function callAuth23(method, url, body = {}, session = {}) {
    const route = authRoutes23.find((x) => x.method === method && x.route === url);
    assert(route, method + ' ' + url);
    const req = { body, session, app: { locals: {} }, headers: {} };
    let status = 200,
      payload;
    const res = {
      status(v) {
        status = v;
        return this;
      },
      json(v) {
        payload = v;
        return this;
      },
      clearCookie() {
        return this;
      },
    };
    for (const handler of route.handlers) {
      let advanced = false;
      await handler(req, res, (e) => {
        advanced = true;
        if (e) throw e;
      });
      if (!advanced) break;
    }
    return { status, body: payload, session: req.session };
  }
  const regBody23 = {
    email: 'new23@example.invalid',
    password: 'long-enough-1',
    name: 'New',
    workspaceName: 'New WS',
    acceptTerms: true,
  };

  const cfgDefault23 = await callAuth23('get', '/config');
  check('batch23 config: registration defaults OFF when the setting is unset (Batch 143: the ON default was the registration bug)', () => {
    assert.equal(cfgDefault23.status, 200);
    assert.equal(cfgDefault23.body.ok, true);
    assert.equal(cfgDefault23.body.data.registrationOpen, false);
  });

  settings23.set('registration.open', '0');
  const cfgOff23 = await callAuth23('get', '/config');
  const regOff23 = await callAuth23('post', '/register', regBody23);
  check('batch23 config: OFF is exposed in the public auth config payload', () => {
    assert.equal(cfgOff23.status, 200);
    assert.equal(cfgOff23.body.data.registrationOpen, false);
  });
  check('batch23 register: OFF rejects 403 REGISTRATION_DISABLED and creates no account', () => {
    assert.equal(regOff23.status, 403);
    assert.equal(regOff23.body.ok, false);
    assert.equal(regOff23.body.error, 'REGISTRATION_DISABLED');
    assert.equal(createdUsers23, 0);
  });

  const loginOff23 = await callAuth23('post', '/login', {
    email: 'member23@example.invalid',
    password: 'fixture-pass-23',
  });
  check('batch23 login: existing users can still log in while registration is OFF', () => {
    assert.equal(loginOff23.status, 200);
    assert.equal(loginOff23.body.ok, true);
    // Batch 40: password alone issues no session — a TOTP challenge is
    // parked instead; the verify step completes the same login.
    assert.equal(loginOff23.body.data.mfaRequired, true);
    assert.equal(loginOff23.body.data.mfaStage, 'verify');
    assert.equal(loginOff23.session.userId, undefined);
  });
  const loginVerify23 = await callAuth23('post', '/mfa/verify', { code: '123456' }, loginOff23.session);
  check('batch40 login: the TOTP step completes the batch23 login', () => {
    assert.equal(loginVerify23.status, 200);
    assert.equal(loginVerify23.body.ok, true);
    assert.equal(loginVerify23.body.data.user.email, 'member23@example.invalid');
    assert.equal(loginVerify23.session.userId, 2301);
  });

  settings23.set('registration.open', '1');
  const cfgOn23 = await callAuth23('get', '/config');
  const regOn23 = await callAuth23('post', '/register', regBody23);
  check('batch23 register: ON again creates the account', () => {
    assert.equal(cfgOn23.body.data.registrationOpen, true);
    assert.equal(regOn23.status, 200);
    assert.equal(regOn23.body.ok, true);
    assert.equal(createdUsers23, 1);
    // Batch 53: register no longer issues a full session on password
    // alone — it parks the SAME MFA challenge as login (the fixture's
    // MFA state is enabled, so the stage is 'verify').
    assert.equal(regOn23.body.data.mfaRequired, true);
    assert.equal(regOn23.body.data.mfaStage, 'verify');
    assert.equal(regOn23.session.userId, undefined);
  });
  const regVerify23 = await callAuth23('post', '/mfa/verify', { code: '123456' }, regOn23.session);
  check('batch53 register: the parked challenge completes the registration like a login', () => {
    assert.equal(regVerify23.status, 200);
    assert.equal(regVerify23.body.ok, true);
    assert.equal(regVerify23.body.data.user.email, 'new23@example.invalid');
    assert.equal(regVerify23.session.userId, 2301);
  });

  check('batch23 gates: endpoint gate, boot payload, tab gate and settings toggle are wired', () => {
    const authSrc23 = fs.readFileSync(path.join(root, 'server/routes/auth.js'), 'utf8');
    assert.ok(authSrc23.includes("getPlatformSetting('registration.open', '0')"), 'register gate reads registration.open');
    assert.ok(authSrc23.includes("error: 'REGISTRATION_DISABLED'"), 'disabled error present');
    assert.ok(authSrc23.includes("router.get('/config'"), 'public auth config route present');
    const platformSrc23 = fs.readFileSync(path.join(root, 'server/platform.js'), 'utf8');
    assert.ok(/key: 'registration\.open'[\s\S]{0,600}?default: '0'/.test(platformSrc23), 'setting def defaults OFF (Batch 143; window widened for the explanatory comment in the def)');
    const appSrc23 = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
    assert.ok(appSrc23.includes('api.authConfig()'), 'auth screen loads the boot flag');
    assert.ok(
      appSrc23.includes("if (mode === 'register' && !registrationOpen) mode = 'login';"),
      'register mode falls back to login'
    );
    assert.ok(
      appSrc23.includes("registrationOpen ? '<button type=\"button\" data-tab=\"register\">Register</button>' : ''"),
      'register tab renders only when open'
    );
    assert.ok(appSrc23.includes("d.key === 'registration.open'"), 'admin settings toggle present');
    const apiSrc23 = fs.readFileSync(path.join(root, 'public/js/api.js'), 'utf8');
    assert.ok(apiSrc23.includes("authConfig: () => get('/auth/config')"), 'api client exposes the auth config');
  });

  check('batch23 portal: client portal ships no registration tab or staff-register call', () => {
    const portalHtml23 = fs.readFileSync(path.join(root, 'public/portal.html'), 'utf8');
    const portalSrc23 = fs.readFileSync(path.join(root, 'public/js/portal.js'), 'utf8');
    for (const src of [portalHtml23, portalSrc23]) {
      assert.ok(!src.includes('data-tab="register"'), 'no register tab in portal');
      assert.ok(!src.includes('/auth/register'), 'no staff register call in portal');
      assert.ok(!src.includes('authConfig'), 'portal does not read the auth config');
    }
  });

  // --- Batch 24: pricing control in Admin Settings → Billing -----------
  // The real pricingAdmin runs against an in-memory platform-settings map
  // and a stub Stripe client: amounts in → Products/Prices managed, ids
  // swapped, olds deactivated, display labels synced — and any Stripe
  // rejection leaves every setting untouched.
  const settings24 = new Map();
  const platform24 = {
    getPlatformSetting: async (key, dflt = '') => (settings24.has(key) ? settings24.get(key) : dflt),
    setPlatformSetting: async (key, value) => {
      settings24.set(key, String(value));
    },
  };
  const prices24 = new Map();
  const products24 = new Map();
  const stripeCalls24 = [];
  const stripeCtl24 = { failCreateFor: null };
  let priceSeq24 = 0;
  let productSeq24 = 0;
  class StubStripe24 {
    constructor() {
      this.prices = {
        create: async (args) => {
          stripeCalls24.push(['prices.create', args]);
          if (stripeCtl24.failCreateFor && args.metadata && args.metadata.bitpype_item === stripeCtl24.failCreateFor) {
            throw new Error('Stub Stripe rejection');
          }
          const rec = {
            id: 'price_24_' + ++priceSeq24,
            product: args.product,
            unit_amount: args.unit_amount,
            currency: args.currency,
            recurring: args.recurring || null,
            metadata: args.metadata || {},
            active: true,
          };
          prices24.set(rec.id, rec);
          return rec;
        },
        retrieve: async (id) => {
          stripeCalls24.push(['prices.retrieve', id]);
          const rec = prices24.get(id);
          if (!rec) throw new Error('No such price: ' + id);
          return rec;
        },
        update: async (id, args) => {
          stripeCalls24.push(['prices.update', id, args]);
          const rec = prices24.get(id);
          if (!rec) throw new Error('No such price: ' + id);
          Object.assign(rec, args);
          return rec;
        },
      };
      this.products = {
        create: async (args) => {
          stripeCalls24.push(['products.create', args]);
          const rec = { id: 'prod_24_' + ++productSeq24, name: args.name, metadata: args.metadata || {}, deleted: false };
          products24.set(rec.id, rec);
          return rec;
        },
        retrieve: async (id) => {
          stripeCalls24.push(['products.retrieve', id]);
          const rec = products24.get(id);
          if (!rec) throw new Error('No such product: ' + id);
          return rec;
        },
        search: async (args) => {
          stripeCalls24.push(['products.search', args]);
          const m = /metadata\['bitpype_key'\]:'([^']+)'/.exec((args && args.query) || '');
          const hit = [...products24.values()].find((p) => p.metadata.bitpype_key === (m && m[1]));
          return { data: hit ? [hit] : [] };
        },
        list: async () => ({ data: [...products24.values()] }),
      };
    }
  }
  const stripeClient24 = {
    getSecretKey: async () => settings24.get('stripe.secret_key') || '',
    getStripe: async () => {
      if (!settings24.get('stripe.secret_key')) {
        const e = new Error('Stripe is not configured (stripe.secret_key / STRIPE_SECRET_KEY)');
        e.code = 'STRIPE_NOT_CONFIGURED';
        throw e;
      }
      return new StubStripe24();
    },
    getPriceIdForPlan: async (plan) => settings24.get('stripe.price_id_' + plan) || settings24.get('stripe.price_id') || '',
  };
  const pricing24 = load('server/pricingAdmin.js', {
    './platform': platform24,
    './stripeClient': stripeClient24,
    './plans': require(path.join(root, 'server/plans.js')),
  });

  const stateUnconf24 = await pricing24.getPricingState();
  check('batch24 state: unconfigured Stripe reports configured:false, mode null, no amounts', () => {
    assert.equal(stateUnconf24.configured, false);
    assert.equal(stateUnconf24.mode, null);
    assert.equal(stateUnconf24.items.length, 4);
    assert.ok(stateUnconf24.items.every((i) => i.amountUsd === null && i.priceId === null));
  });
  await assert.rejects(pricing24.updatePricing({ standard: 49 }), (e) => e.code === 'STRIPE_NOT_CONFIGURED');
  check('batch24 save: unconfigured Stripe rejects clean and changes no setting', () => {
    assert.equal(settings24.size, 0);
    assert.equal(stripeCalls24.length, 0);
  });

  settings24.set('stripe.secret_key', 'sk_test_24fixture');
  for (const bad of [0, -5, 'abc', '1.999', '0.00', 100001]) {
    await assert.rejects(pricing24.updatePricing({ standard: bad }), (e) => e.code === 'INVALID_AMOUNT');
  }
  check('batch24 save: invalid amounts rejected before any Stripe call or setting write', () => {
    assert.equal(stripeCalls24.length, 0);
    assert.equal(settings24.has('stripe.price_id_standard'), false);
  });

  const first24 = await pricing24.updatePricing({ standard: '49', pro: 99, premium: '199.00', credits: 25 });
  check('batch24 save: first save mints products+prices with correct cents and intervals', () => {
    assert.equal(first24.configured, true);
    assert.equal(first24.mode, 'test');
    assert.equal(first24.updated.length, 4);
    assert.equal(first24.unchanged.length, 0);
    const std = first24.updated.find((u) => u.id === 'standard');
    assert.equal(std.cents, 4900);
    assert.equal(std.productCreated, true);
    const stdPrice = prices24.get(std.newPriceId);
    assert.equal(stdPrice.unit_amount, 4900);
    assert.equal(stdPrice.recurring.interval, 'month');
    assert.equal(stdPrice.product, std.productId);
    assert.equal(products24.get(std.productId).metadata.bitpype_key, 'plan_standard');
    const cred = first24.updated.find((u) => u.id === 'credits');
    assert.equal(cred.cents, 2500);
    assert.equal(prices24.get(cred.newPriceId).recurring, null, 'credits price is one-time');
    assert.equal(products24.get(cred.productId).metadata.bitpype_key, 'credits_pack');
  });
  check('batch24 save: settings swapped to the new ids and display labels synced', () => {
    const byId = Object.fromEntries(first24.updated.map((u) => [u.id, u]));
    assert.equal(settings24.get('stripe.price_id_standard'), byId.standard.newPriceId);
    assert.equal(settings24.get('stripe.price_id_pro'), byId.pro.newPriceId);
    assert.equal(settings24.get('stripe.price_id_premium'), byId.premium.newPriceId);
    assert.equal(settings24.get('stripe.price_id_credits'), byId.credits.newPriceId);
    assert.equal(settings24.get('stripe.product_id_standard'), byId.standard.productId);
    assert.equal(settings24.get('stripe.product_id_credits'), byId.credits.productId);
    assert.equal(settings24.get('billing.amount_label_standard'), 'Standard · $49/mo');
    assert.equal(settings24.get('billing.amount_label_pro'), 'Pro · $99/mo');
    assert.equal(settings24.get('billing.amount_label_premium'), 'Premium · $199/mo');
    assert.equal(settings24.get('credits.pack_label'), '50 credits · $25');
  });

  const state24 = await pricing24.getPricingState();
  check('batch24 state: amounts resolve live from Stripe with mode test', () => {
    assert.equal(state24.configured, true);
    assert.equal(state24.mode, 'test');
    const byId = Object.fromEntries(state24.items.map((i) => [i.id, i]));
    assert.equal(byId.standard.amountUsd, 49);
    assert.equal(byId.standard.amountSource, 'stripe');
    assert.equal(byId.pro.amountUsd, 99);
    assert.equal(byId.premium.amountUsd, 199);
    assert.equal(byId.credits.amountUsd, 25);
    assert.equal(byId.standard.priceId, settings24.get('stripe.price_id_standard'));
  });

  const createCountBeforeNoop24 = stripeCalls24.filter((c) => c[0] === 'prices.create').length;
  const noop24 = await pricing24.updatePricing({ standard: 49, pro: '99.00', premium: 199, credits: '25' });
  check('batch24 save: unchanged amounts are no-ops (no new prices, nothing deactivated)', () => {
    assert.equal(noop24.updated.length, 0);
    assert.deepEqual([...noop24.unchanged].sort(), ['credits', 'premium', 'pro', 'standard']);
    assert.equal(stripeCalls24.filter((c) => c[0] === 'prices.create').length, createCountBeforeNoop24);
    assert.equal(stripeCalls24.filter((c) => c[0] === 'prices.update').length, 0);
  });

  const proBefore24 = settings24.get('stripe.price_id_pro');
  const proProductBefore24 = settings24.get('stripe.product_id_pro');
  const stdIdBefore24 = settings24.get('stripe.price_id_standard');
  const productCreatesBefore24 = stripeCalls24.filter((c) => c[0] === 'products.create').length;
  const reprice24 = await pricing24.updatePricing({ pro: 129 });
  check('batch24 save: changing one plan mints a new price on the SAME product and deactivates the old', () => {
    assert.equal(reprice24.updated.length, 1);
    assert.equal(reprice24.updated[0].id, 'pro');
    assert.equal(reprice24.updated[0].productId, proProductBefore24, 'same product reused');
    assert.equal(reprice24.updated[0].productCreated, false);
    assert.equal(stripeCalls24.filter((c) => c[0] === 'products.create').length, productCreatesBefore24);
    assert.equal(prices24.get(proBefore24).active, false, 'old pro price deactivated');
    assert.equal(settings24.get('stripe.price_id_pro'), reprice24.updated[0].newPriceId);
    assert.notEqual(settings24.get('stripe.price_id_pro'), proBefore24);
    assert.equal(settings24.get('billing.amount_label_pro'), 'Pro · $129/mo');
    assert.equal(settings24.get('stripe.price_id_standard'), stdIdBefore24, 'other plans untouched');
  });

  const snapshot24 = new Map(settings24);
  stripeCtl24.failCreateFor = 'premium';
  await assert.rejects(pricing24.updatePricing({ standard: 59, premium: 299 }), (e) => e.code === 'STRIPE_ERROR');
  stripeCtl24.failCreateFor = null;
  check('batch24 save: a Stripe rejection aborts the whole save — no setting swapped, no old price deactivated', () => {
    assert.deepEqual(
      [...settings24.entries()].sort(),
      [...snapshot24.entries()].sort()
    );
    assert.equal(prices24.get(settings24.get('stripe.price_id_standard')).active, true, 'old standard price still active');
    assert.equal(settings24.get('billing.amount_label_standard'), 'Standard · $49/mo');
  });

  settings24.set('stripe.price_id_premium', 'price_24_missing');
  settings24.set('billing.amount_label_premium', 'Premium · $299/mo');
  settings24.set('stripe.secret_key', 'sk_live_24fixture');
  const stateFallback24 = await pricing24.getPricingState();
  check('batch24 state: unreachable Stripe price falls back to the saved label amount; live key reads LIVE', () => {
    const prem = stateFallback24.items.find((i) => i.id === 'premium');
    assert.equal(prem.amountUsd, 299);
    assert.equal(prem.amountSource, 'label');
    assert.equal(stateFallback24.mode, 'live');
  });

  check('batch24 wiring: routes, client, panel and product-id defs are in place', () => {
    const routesSrc24 = fs.readFileSync(path.join(root, 'server/routes/admin.js'), 'utf8');
    assert.ok(routesSrc24.includes("router.get('/settings/pricing'"), 'pricing state route');
    assert.ok(routesSrc24.includes("router.put('/settings/pricing'"), 'pricing update route');
    assert.ok(routesSrc24.includes("require('../pricingAdmin')"), 'routes use pricingAdmin');
    const apiSrc24 = fs.readFileSync(path.join(root, 'public/js/api.js'), 'utf8');
    assert.ok(apiSrc24.includes("adminPricing: () => get('/admin/settings/pricing')"), 'api state call');
    assert.ok(apiSrc24.includes('adminPricingUpdate'), 'api update call');
    const appSrc24 = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
    assert.ok(appSrc24.includes('id="pricing-form"'), 'pricing form rendered');
    assert.ok(appSrc24.includes('Update pricing'), 'update button copy');
    assert.ok(appSrc24.includes('PRICING_MANAGED_KEYS'), 'id fields hidden from generic form');
    assert.ok(appSrc24.includes('Existing subscribers keep the price they signed up with'), 'new-customers-only copy');
    const platformSrc24 = fs.readFileSync(path.join(root, 'server/platform.js'), 'utf8');
    for (const k of ['stripe.product_id_standard', 'stripe.product_id_pro', 'stripe.product_id_premium', 'stripe.product_id_credits']) {
      assert.ok(platformSrc24.includes(`key: '${k}'`), 'def for ' + k);
    }
  });

  // ---- Batch 24b: settings validators — the sms.* group (and every other
  // platform def) must have a registered validator, so saving settings can
  // never hard-fail with `No validator for setting "…"` again. Both save
  // paths (domain.settingsSet, ipc settings:set) funnel through
  // settingsKeys.validateSetting, so it is exercised directly here.
  const settingsKeys24b = require(path.join(root, 'server/settingsKeys.js'));
  const platformDefs24b = require(path.join(root, 'server/platform.js')).PLATFORM_SETTING_DEFS;
  const defByKey24b = new Map(platformDefs24b.map((d) => [d.key, d]));
  const seedByKey24b = new Map(settingsKeys24b.SETTING_SEEDS);
  const sampleFor24b = (key) => {
    if (key === 'mcp.http_port') return '8080'; // seed '' means "unset"; the port validator requires a real port
    if (defByKey24b.has(key)) return defByKey24b.get(key).default;
    if (seedByKey24b.has(key)) return seedByKey24b.get(key);
    return '';
  };

  check('batch24b meta: every platform setting def has a registered validator', () => {
    assert.ok(platformDefs24b.length > 0);
    for (const def of platformDefs24b) {
      const v = settingsKeys24b.validateSetting(def.key, sampleFor24b(def.key));
      assert.ok(!/No validator/.test((v && v.error) || ''), def.key + ' must not hit the No-validator default');
      assert.equal(v.ok, true, def.key + ' should accept its default/sample: ' + (v && v.error));
    }
  });
  check('batch24b meta: every SETTABLE_KEYS entry has a working validator', () => {
    for (const key of settingsKeys24b.SETTABLE_KEYS) {
      const v = settingsKeys24b.validateSetting(key, sampleFor24b(key));
      assert.equal(v.ok, true, key + ' should validate its sample: ' + (v && v.error));
    }
  });
  check('batch24b sms: all sms.* keys accept valid values through validateSetting', () => {
    const cases24b = [
      ['sms.enabled', '1', '1'],
      ['sms.enabled', '0', '0'],
      ['sms.provider', 'twilio', 'twilio'],
      ['sms.provider', 'Vonage', 'vonage'],
      ['sms.provider', 'custom', 'custom'],
      ['sms.account_sid', 'AC0123456789abcdef0123456789abcdef', 'AC0123456789abcdef0123456789abcdef'],
      ['sms.auth_token', 'tok_abc123', 'tok_abc123'],
      ['sms.api_key', 'key_abc123', 'key_abc123'],
      ['sms.from_number', '+16105550101', '+16105550101'],
      ['sms.webhook_url', 'https://example.com/sms-inbound', 'https://example.com/sms-inbound'],
      ['sms.webhook_url', '', ''],
    ];
    for (const [key, input, expected] of cases24b) {
      const v = settingsKeys24b.validateSetting(key, input);
      assert.equal(v.ok, true, key + ' should accept ' + JSON.stringify(input) + ': ' + (v && v.error));
      assert.equal(v.value, expected, key + ' normalization');
    }
  });
  check('batch24b sms: enabled rejects a non-boolean value', () => {
    const v = settingsKeys24b.validateSetting('sms.enabled', 'banana');
    assert.equal(v.ok, false);
    assert.match(v.error, /boolean/);
  });
  check('batch24b sms: provider rejects an off-enum value', () => {
    const v = settingsKeys24b.validateSetting('sms.provider', 'pigeon');
    assert.equal(v.ok, false);
    assert.match(v.error, /twilio.*vonage.*custom/);
  });
  check('batch24b audit: mcp.public_url validator runs instead of throwing (module path)', () => {
    assert.deepEqual(settingsKeys24b.validateSetting('mcp.public_url', ''), { ok: true, value: '' });
    assert.equal(settingsKeys24b.validateSetting('mcp.public_url', 'https://example.com').ok, true);
  });
  check('batch24b wiring: sms + platform secret keys are settable and masked on read', () => {
    for (const key of ['sms.auth_token', 'sms.api_key']) {
      assert.ok(settingsKeys24b.SETTABLE_KEYS.includes(key), key + ' settable');
      assert.ok(settingsKeys24b.SECRET_KEYS.includes(key), key + ' masked');
    }
    for (const key of ['muse.model_api_key', 'captcha.secret_key', 'stripe.secret_key', 'stripe.webhook_secret', 'twilio.auth_token']) {
      assert.ok(settingsKeys24b.SECRET_KEYS.includes(key), key + ' masked');
    }
  });

  // --- Batch 25: SMS opt-in on web forms ------------------------------
  // Every visitor form that collects a phone gains an unchecked-by-
  // default consent checkbox naming the business. Consent + a plausible
  // phone records the opt-in on the LeadScout contact (proof of
  // consent) and sends ONE welcome text via the platform SMS seam
  // (src/sms.js + sms.* settings). No consent / SMS off / sender down
  // never fails the visitor's submission. The sender is stubbed at the
  // src/sms provider seam — no live texts.
  const realSms25 = require(path.join(root, 'src/sms.js'));
  const smsSends25 = [];
  let smsThrow25 = false;
  const smsStub25 = {
    ...realSms25,
    resolveSmsSettings: async (s) => ({ ...(s || {}) }),
    getSmsProvider: () => ({
      name: 'stub25',
      send: async ({ to, body }) => {
        if (smsThrow25) throw new Error('Twilio boom (fixture)');
        smsSends25.push({ to, body });
        return { ok: true, provider: 'twilio', messageId: 'SM25fixture', status: 'queued' };
      },
    }),
  };
  const smsOptIn25 = load('server/smsOptIn.js', {
    '../src/sms': smsStub25,
    './portalContacts': contacts,
    './domain': { withDb: (_ws, fn) => fn(db) },
  });
  const mailerStub25 = { sendPlatformMail: async () => ({ sent: true }) };
  const cf25 = load('server/contactForms.js', {
    './plans': { getPlan: () => ({ id: 'free', entitlements: {} }), normalizePlanId: (v) => v || 'free' },
    './portalContacts': contacts,
    './mailer': mailerStub25,
    './museRouter': {},
    './smsOptIn': smsOptIn25,
  });
  cf25.ensureTables(db);
  const sm25 = load('server/siteModules.js', {
    '../src/pageContentScan': require(path.join(root, 'src/pageContentScan.js')),
    '../src/websiteEngine': require(path.join(root, 'src/websiteEngine.js')),
    './portalContacts': contacts,
    '../src/secretBox': require(path.join(root, 'src/secretBox.js')),
    './membershipStripe': {},
    './shopStripe': {},
    './smsOptIn': smsOptIn25,
  });
  sm25.ensureTables(db);
  db.prepare("INSERT INTO leads (id, business_name, email) VALUES (2501, 'Fixture Texts R Us', 'texts@example.invalid')").run();
  db.prepare("INSERT INTO leads (id, business_name, email) VALUES (2502, 'Fixture Booking Texts', 'booktexts@example.invalid')").run();
  const homePages25 = JSON.stringify([{ slug: 'index', file: 'index.html', title: 'Home', nav_label: 'Home', html: '<p>hi</p>', sections: [] }]);
  for (const id of [2501, 2502]) {
    db.prepare('INSERT INTO websites (lead_id, name, theme, pages) VALUES (?, ?, ?, ?)').run(id, `Site ${id}`, '{}', homePages25);
  }
  const setSetting25 = (k, v) =>
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v);
  setSetting25('sms.enabled', '1');
  setSetting25('sms.provider', 'twilio');
  setSetting25('sms.account_sid', 'AC25fixture');
  setSetting25('sms.auth_token', 'tok25');
  setSetting25('sms.from_number', '+16105550199');
  const contactByPhone25 = (phone) =>
    db.prepare('SELECT * FROM leadscout_contacts WHERE phone_norm = ?').get(contacts.normPhone(phone));
  const mkForm25 = (leadId, token, withPhone) => {
    const info = db
      .prepare("INSERT INTO contact_forms (lead_id, name, title, notify_email, public_token, published) VALUES (?, 'Contact', 'Contact Us', '', ?, 1)")
      .run(leadId, token);
    const fid = Number(info.lastInsertRowid);
    const addField = (key, label, type, req, sort) =>
      db.prepare('INSERT INTO form_fields (form_id, field_key, label, field_type, required, sort_order) VALUES (?, ?, ?, ?, ?, ?)').run(fid, key, label, type, req, sort);
    addField('name', 'Name', 'text', 1, 1);
    addField('email', 'Email', 'email', 1, 2);
    if (withPhone) addField('phone', 'Phone', 'tel', 0, 3);
    addField('message', 'Message', 'textarea', 1, 4);
    return fid;
  };
  const formId25 = mkForm25(2501, 'tok-25-a', true);
  mkForm25(2501, 'tok-25-nophone', false);
  const pubForm25 = cf25.getPublicFormByToken(db, 'tok-25-a');
  const pubFormNoPhone25 = cf25.getPublicFormByToken(db, 'tok-25-nophone');
  const formEmbedSrc25 = fs.readFileSync(path.join(root, 'public/js/form-embed.js'), 'utf8');
  const contactFormsSrc25 = fs.readFileSync(path.join(root, 'server/contactForms.js'), 'utf8');
  check('batch25 render: form schema carries the opt-in block naming the business; renderer draws it unchecked', () => {
    assert.ok(contactFormsSrc25.includes("FORM_SCRIPT_VER = 'form10'"), 'form embed cache-bust bumped');
    assert.ok(pubForm25.sms_optin, 'sms_optin block present when the form collects a phone');
    assert.equal(pubForm25.sms_optin.consent_key, 'sms_optin_consent');
    assert.equal(pubForm25.sms_optin.phone_field_key, 'phone');
    assert.equal(pubForm25.sms_optin.label, 'Text me updates & offers from Fixture Texts R Us');
    assert.equal(pubFormNoPhone25.sms_optin, null, 'no phone field → no opt-in block');
    assert.ok(formEmbedSrc25.includes("smsInput.name = 'sms_optin_consent'"), 'renderer adds the consent checkbox');
    assert.ok(!formEmbedSrc25.includes('smsInput.checked'), 'checkbox is never pre-checked');
    assert.ok(formEmbedSrc25.includes('values.sms_optin_consent = !!smsConsentInput.checked'), 'consent rides the submit values');
  });

  const subNoConsent25 = await cf25.acceptSubmission(db, {
    token: 'tok-25-a',
    values: { name: 'No Consent', email: 'noconsent@example.invalid', phone: '4845550101', message: 'Hi' },
    workspaceId: 1,
    planId: 'free',
  });
  check('batch25 submit: without consent nothing is recorded and no text is sent', () => {
    assert.ok(subNoConsent25.id, 'submission still succeeds');
    assert.equal(subNoConsent25.sms_optin && subNoConsent25.sms_optin.reason, 'no_consent');
    const c = contactByPhone25('4845550101');
    assert.ok(c, 'LeadScout capture still created the contact');
    assert.equal(Number(c.sms_opted_in), 0);
    assert.equal(smsSends25.length, 0);
  });

  const subConsent25 = await cf25.acceptSubmission(db, {
    token: 'tok-25-a',
    values: { name: 'Opted In', email: 'optedin@example.invalid', phone: '4845550102', message: 'Yes please', sms_optin_consent: true },
    workspaceId: 1,
    planId: 'free',
  });
  check('batch25 submit: consent records the opt-in on the contact and sends exactly one welcome text', () => {
    assert.equal(subConsent25.sms_optin && subConsent25.sms_optin.sent, true);
    assert.equal(smsSends25.length, 1);
    assert.equal(smsSends25[0].to, '+14845550102');
    assert.equal(
      smsSends25[0].body,
      "Welcome to Fixture Texts R Us texts — you're enrolled! Msg & data rates may apply. Reply STOP to end, HELP for help."
    );
    const c = contactByPhone25('4845550102');
    assert.equal(Number(c.sms_opted_in), 1);
    assert.ok(c.sms_opted_in_at, 'consent timestamp recorded');
    assert.equal(c.sms_opt_in_source, `form:${formId25}`);
    assert.equal(c.sms_confirm_status, 'sent');
    const ev = db.prepare("SELECT * FROM leadscout_events WHERE contact_id = ? AND kind = 'sms_opt_in'").get(c.id);
    assert.ok(ev, 'opt-in timeline event written');
    assert.equal(Number(ev.form_id), formId25);
  });

  const subAgain25 = await cf25.acceptSubmission(db, {
    token: 'tok-25-a',
    values: { name: 'Opted In', email: 'optedin@example.invalid', phone: '4845550102', message: 'Me again', sms_optin_consent: true },
    workspaceId: 1,
    planId: 'free',
  });
  check('batch25 resubmit: an already-enrolled contact is not re-texted and never duplicated', () => {
    assert.equal(subAgain25.sms_optin && subAgain25.sms_optin.reason, 'already_enrolled');
    assert.equal(smsSends25.length, 1, 'no second welcome text');
    const rows = db.prepare('SELECT * FROM leadscout_contacts WHERE phone_norm = ?').all(contacts.normPhone('4845550102'));
    assert.equal(rows.length, 1, 'one contact row');
    assert.equal(Number(rows[0].sms_opted_in), 1);
    assert.ok(rows[0].sms_opted_in_at, 'consent timestamp refreshed');
    const evCount = db
      .prepare("SELECT COUNT(*) AS c FROM leadscout_events WHERE contact_id = ? AND kind = 'sms_opt_in'")
      .get(rows[0].id).c;
    assert.equal(evCount, 1, 'no duplicate enrollment event');
  });

  setSetting25('sms.enabled', '0');
  const subDormant25 = await cf25.acceptSubmission(db, {
    token: 'tok-25-a',
    values: { name: 'Dormant Dan', email: 'dormant@example.invalid', phone: '4845550103', message: 'Hi', sms_optin_consent: true },
    workspaceId: 1,
    planId: 'free',
  });
  setSetting25('sms.enabled', '1');
  check('batch25 dormant: SMS disabled records the opt-in, skips the send, submission succeeds', () => {
    assert.ok(subDormant25.id, 'submission succeeds while SMS is off');
    assert.equal(subDormant25.sms_optin && subDormant25.sms_optin.skippedSend, true);
    const c = contactByPhone25('4845550103');
    assert.equal(Number(c.sms_opted_in), 1, 'opt-in recorded anyway');
    assert.equal(c.sms_confirm_status, 'skipped');
    assert.match(c.sms_confirm_error, /sms\.enabled is off/);
    assert.equal(smsSends25.length, 1, 'no text sent');
  });

  smsThrow25 = true;
  const subThrow25 = await cf25.acceptSubmission(db, {
    token: 'tok-25-a',
    values: { name: 'Unlucky Uma', email: 'uma@example.invalid', phone: '4845550104', message: 'Hi', sms_optin_consent: true },
    workspaceId: 1,
    planId: 'free',
  });
  smsThrow25 = false;
  check('batch25 failure: a throwing sender never fails the submission and the failure is stamped', () => {
    assert.ok(subThrow25.id, 'submission succeeds despite the sender throwing');
    const c = contactByPhone25('4845550104');
    assert.equal(Number(c.sms_opted_in), 1);
    assert.equal(c.sms_confirm_status, 'failed');
    assert.match(c.sms_confirm_error, /Twilio boom/);
    assert.equal(smsSends25.length, 1);
  });

  const contactCountBeforeBad25 = db.prepare('SELECT COUNT(*) AS c FROM leadscout_contacts').get().c;
  const badPhone25 = await smsOptIn25.handleSmsOptIn(db, {
    leadId: 2501,
    phone: '123',
    consent: true,
    source: 'form:x',
  });
  check('batch25 guard: consent with an implausible phone records nothing and sends nothing', () => {
    assert.equal(badPhone25.skipped, true);
    assert.equal(badPhone25.reason, 'invalid_phone');
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM leadscout_contacts').get().c, contactCountBeforeBad25);
    assert.equal(smsSends25.length, 1);
  });

  const embBook25 = sm25.attachModule(db, 2501, 'bookings', { workspaceId: 1, appUrl: 'https://example.test' }).embed;
  const pubBook25 = sm25.getPublicModuleByToken(db, embBook25.public_token);
  const embEst25 = sm25.attachModule(db, 2501, 'estimate', { workspaceId: 1, appUrl: 'https://example.test' }).embed;
  const pubEst25 = sm25.getPublicModuleByToken(db, embEst25.public_token);
  const embFaq25 = sm25.attachModule(db, 2501, 'faq', { workspaceId: 1, appUrl: 'https://example.test' }).embed;
  const pubFaq25 = sm25.getPublicModuleByToken(db, embFaq25.public_token);
  check('batch25 modules: bookings + estimate payloads carry the opt-in block; other modules do not', () => {
    assert.equal(sm25.MODULE_SCRIPT_VER, 'mod39', 'batch 26 bumped mod15; batch 25c bumped mod16; batch 25c-fix bumped mod17; batch 30 bumped mod18; batch 31 bumped mod19, batch 32 bumped mod20');
    assert.equal(pubBook25.sms_optin && pubBook25.sms_optin.label, 'Text me updates & offers from Fixture Texts R Us');
    assert.equal(pubEst25.sms_optin && pubEst25.sms_optin.consent_key, 'sms_optin_consent');
    assert.equal(pubFaq25.sms_optin, undefined, 'modules without a phone form get no block');
  });

  // Route-level: the estimate POST carries the consent through the
  // fire-and-forget hook into the contact + welcome text.
  const mod25 = stubRouter21b();
  load('server/routes/modulesPublic.js', {
    express: { Router: () => mod25.router },
    '../domain': { withDb: (_ws, fn) => fn(db) },
    '../siteModules': sm25,
    '../captcha': {
      requireCaptcha: () => (_req, _res, next) => next(),
      getCaptchaConfig: async () => ({ enabled: false }),
    },
    '../rateLimit': { rateLimit: () => (_req, _res, next) => next() },
    '../workspaceExists': { assertWorkspaceExists: async () => {} },
    '../ownerNotify': { notifyOwnerOfEstimateRequest: async () => ({ sent: false }) },
    '../smsOptIn': smsOptIn25,
  });
  const estRoute25 = await callRoute21b(
    mod25.routes,
    'post',
    '/:token/estimate',
    reqFor21b(
      { token: embEst25.public_token },
      { name: 'Route Visitor', email: 'route@example.invalid', phone: '6105557777', sms_optin_consent: true, selections: [] }
    )
  );
  await flush21b();
  await flush21b();
  check('batch25 routes: an estimate submission with consent enrolls the contact and texts once', () => {
    assert.equal(estRoute25.status, 200);
    assert.equal(estRoute25.body.ok, true);
    const c = contactByPhone25('6105557777');
    assert.ok(c, 'contact created');
    assert.equal(Number(c.sms_opted_in), 1);
    assert.equal(c.sms_opt_in_source, 'estimate');
    assert.equal(smsSends25.length, 2);
    assert.equal(smsSends25[1].to, '+16105557777');
    assert.ok(smsSends25[1].body.startsWith('Welcome to Fixture Texts R Us texts'));
  });

  const wrapRes25 = await smsOptIn25.handleSmsOptInForWorkspace(1, {
    leadId: 2502,
    phone: '6105558888',
    consent: true,
    source: 'booking',
  });
  check('batch25 wrapper: the workspace-scoped path (bookings/chatbot routes) records + sends', () => {
    assert.equal(wrapRes25.sent, true);
    const c = contactByPhone25('6105558888');
    assert.equal(Number(c.sms_opted_in), 1);
    assert.equal(c.sms_opt_in_source, 'booking');
    assert.equal(smsSends25.length, 3);
    assert.ok(smsSends25[2].body.startsWith('Welcome to Fixture Booking Texts texts'));
  });

  const chatbotSrc25 = fs.readFileSync(path.join(root, 'server/chatbot.js'), 'utf8');
  const chatbotRouteSrc25 = fs.readFileSync(path.join(root, 'server/routes/chatbotPublic.js'), 'utf8');
  const chatEmbedSrc25 = fs.readFileSync(path.join(root, 'public/js/chat-embed.js'), 'utf8');
  const moduleEmbedSrc25 = fs.readFileSync(path.join(root, 'public/js/module-embed.js'), 'utf8');
  const modulesRouteSrc25 = fs.readFileSync(path.join(root, 'server/routes/modulesPublic.js'), 'utf8');
  check('batch25 wiring: chatbot config + embeds carry the consent pair end to end', () => {
    assert.ok(chatbotSrc25.includes("CHAT_SCRIPT_VER = 'chat8'"), 'chat embed cache-bust bumped');
    assert.ok(chatbotSrc25.includes('sms_optin: smsOptInBlock'), 'chat public config carries the block');
    assert.ok(chatbotRouteSrc25.includes('sms_optin_consent') && chatbotRouteSrc25.includes('handleSmsOptInForWorkspace'), 'chat lead route fires the opt-in');
    assert.ok(chatEmbedSrc25.includes('bp-chat-lead-sms-optin') && chatEmbedSrc25.includes('sms_optin_consent'), 'chat embed renders + submits the consent');
    assert.ok(moduleEmbedSrc25.split('sms_optin_consent').length - 1 >= 4, 'module embed: booking + estimate render and submit the consent');
    assert.ok(modulesRouteSrc25.includes('fireSmsOptIn'), 'module routes fire the opt-in hook');
  });

  // --- Batch 25b: decrypt workspace SMS secrets on read + twilio -----
  // credential fallback -------------------------------------------------
  // Workspace secret settings are secretBox-ENCRYPTED at rest, but
  // Batch 25's settings reader (and the chatbot owner-notify path that
  // predates it) read the settings table RAW — sms.auth_token would
  // reach Twilio as ciphertext and auth would fail in production (the
  // stubbed provider hid it). The fix centralizes a decrypting reader
  // in src/sms.js (readWorkspaceSettings, the src/outreach.js pattern)
  // and points every SMS consumer at it. twilioClient additionally
  // falls back to the workspace sms.* pair when the platform twilio.*
  // pair is unset, so the one place Ely manages Twilio keys (Admin →
  // SMS) feeds call tracking too. Below, the REAL secretBox and REAL
  // src/sms.js run in VMs keyed with a throwaway SETTINGS_ENCRYPTION_KEY
  // so the encrypt/decrypt path under test is the production one.
  const crypto25b = require('node:crypto');
  const keyHex25b = crypto25b.randomBytes(32).toString('hex');
  const loadBox25b = () => {
    const mod = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(root, 'src/secretBox.js'), 'utf8'), {
      module: mod, exports: mod.exports,
      require: (name) => {
        if (name === '../server/settingsKeys') return require(path.join(root, 'server/settingsKeys.js'));
        if (!name.startsWith('.')) return require(name);
        throw new Error('Unexpected dependency: ' + name);
      },
      process: { env: { SETTINGS_ENCRYPTION_KEY: keyHex25b } }, console, Buffer,
    }, { filename: 'src/secretBox.js' });
    return mod.exports;
  };
  const box25b = loadBox25b();
  const twilioHttp25b = [];
  let twilioHttpImpl25b = async () => ({
    ok: true, status: 201,
    text: async () => JSON.stringify({ sid: 'SM25b', status: 'queued' }),
  });
  const loadSms25b = () => {
    const mod = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(root, 'src/sms.js'), 'utf8'), {
      module: mod, exports: mod.exports,
      require: (name) => {
        if (name === './secretBox') return box25b;
        if (name === '../server/platform') return { getPlatformSetting: async () => '' };
        if (!name.startsWith('.')) return require(name);
        throw new Error('Unexpected dependency: ' + name);
      },
      process: { env: {} }, console, Buffer, URL, URLSearchParams,
      fetch: async (url, opts) => { twilioHttp25b.push({ url: String(url), opts }); return twilioHttpImpl25b(url, opts); },
      setTimeout, clearTimeout,
    }, { filename: 'src/sms.js' });
    return mod.exports;
  };
  const smsVm25b = loadSms25b();
  const setRaw25b = (k, v) =>
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v);
  const PLAIN_TOKEN25B = 'tok25b-plaintext-secret';
  setRaw25b('sms.enabled', '1');
  setRaw25b('sms.provider', 'twilio');
  setRaw25b('sms.account_sid', 'AC25b');
  setRaw25b('sms.from_number', '+16105550199');
  // Written exactly as domain.setSetting writes it: encryptSetting(key, v).
  setRaw25b('sms.auth_token', box25b.encryptSetting('sms.auth_token', PLAIN_TOKEN25B));
  check('batch25b fixture: the token is ciphertext at rest and plaintext via the decrypting reader', () => {
    const raw = db.prepare("SELECT value FROM settings WHERE key = 'sms.auth_token'").get().value;
    assert.ok(box25b.isEncrypted(raw), 'stored value carries the enc:v1: prefix');
    assert.notEqual(raw, PLAIN_TOKEN25B);
    // domain.js's sanctioned getter is exactly decryptSetting(key, row.value):
    assert.equal(box25b.decryptSetting('sms.auth_token', raw), PLAIN_TOKEN25B);
    const map = smsVm25b.readWorkspaceSettings(db);
    assert.equal(map['sms.auth_token'], PLAIN_TOKEN25B, 'centralized reader decrypts');
    assert.equal(map['sms.account_sid'], 'AC25b', 'plaintext values pass through');
  });

  const smsOptIn25b = load('server/smsOptIn.js', {
    '../src/sms': smsVm25b,
    './portalContacts': contacts,
  });
  const optinRes25b = await smsOptIn25b.handleSmsOptIn(db, {
    leadId: 2501, name: 'Encrypted Erin', phone: '6105550143', consent: true, source: 'batch25b',
  });
  check('batch25b opt-in: welcome text is sent with the DECRYPTED token (real Twilio auth header)', () => {
    assert.equal(optinRes25b.sent, true);
    assert.equal(twilioHttp25b.length, 1, 'exactly one Twilio API call');
    const call = twilioHttp25b[0];
    assert.ok(call.url.includes('/Accounts/AC25b/Messages.json'));
    assert.equal(
      call.opts.headers.Authorization,
      'Basic ' + Buffer.from('AC25b:' + PLAIN_TOKEN25B).toString('base64'),
      'provider received the plaintext token, not the at-rest ciphertext'
    );
    const body = new URLSearchParams(call.opts.body);
    assert.equal(body.get('To'), '+16105550143');
    assert.equal(body.get('From'), '+16105550199');
    assert.ok(body.get('Body').startsWith('Welcome to Fixture Texts R Us texts'));
  });

  // Twilio client credential resolution: platform pair → workspace
  // sms.* fallback (decrypted) → dormant.
  const PLAIN_WS_TOKEN25B = 'tok25b-workspace-secret';
  setRaw25b('sms.account_sid', 'ACws25b');
  setRaw25b('sms.auth_token', box25b.encryptSetting('sms.auth_token', PLAIN_WS_TOKEN25B));
  twilioHttp25b.length = 0;
  twilioHttpImpl25b = async () => ({
    ok: true, status: 200,
    json: async () => ({
      available_phone_numbers: [
        { phone_number: '+16105550199', friendly_name: '(610) 555-0199', locality: 'Reading', region: 'PA' },
      ],
    }),
    text: async () => '{}',
  });
  const emptyDb25b = new Database(':memory:');
  function loadTwilio25b(platformSettings, wsDb) {
    const mod = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(root, 'server/twilioClient.js'), 'utf8'), {
      module: mod, exports: mod.exports,
      require: (name) => {
        if (name === './platform') return { getPlatformSetting: async (k) => platformSettings[k] || '' };
        if (name === './workspaceDb') return { openWorkspaceDb: () => wsDb, acquireWorkspaceDb: () => wsDb, releaseWorkspaceDb: () => {}, leaseCount: () => 1 };
        if (name === '../src/sms') return smsVm25b;
        if (!name.startsWith('.')) return require(name);
        throw new Error('Unexpected dependency: ' + name);
      },
      process: { env: {} }, console, Buffer, URL, URLSearchParams, FormData, Blob,
      fetch: async (url, opts) => { twilioHttp25b.push({ url: String(url), opts }); return twilioHttpImpl25b(url, opts); },
      setTimeout, clearTimeout,
    }, { filename: 'server/twilioClient.js' });
    return mod.exports;
  }
  const twilioWs25b = loadTwilio25b({}, db);
  const credsWs25b = await twilioWs25b.getCredentials({ workspaceId: 1 });
  const foundWs25b = await twilioWs25b.searchNumbers({ areaCode: '610', workspaceId: 1 });
  check('batch25b twilio fallback: workspace sms.* pair (decrypted) is used when the platform pair is unset', () => {
    assert.equal(credsWs25b.accountSid, 'ACws25b');
    assert.equal(credsWs25b.authToken, PLAIN_WS_TOKEN25B);
    assert.equal(credsWs25b.source, 'workspace');
    assert.equal(foundWs25b.configured, true);
    assert.equal(foundWs25b.numbers.length, 1);
    const call = twilioHttp25b[twilioHttp25b.length - 1];
    assert.equal(
      call.opts.headers.Authorization,
      'Basic ' + Buffer.from('ACws25b:' + PLAIN_WS_TOKEN25B).toString('base64')
    );
  });
  const twilioPlat25b = loadTwilio25b({ 'twilio.account_sid': 'ACplat25b', 'twilio.auth_token': 'tokPlat25b' }, db);
  const credsPlat25b = await twilioPlat25b.getCredentials({ workspaceId: 1 });
  check('batch25b twilio resolution: a set platform pair still wins over the workspace pair', () => {
    assert.equal(credsPlat25b.accountSid, 'ACplat25b');
    assert.equal(credsPlat25b.authToken, 'tokPlat25b');
    assert.equal(credsPlat25b.source, 'platform');
  });
  const twilioNone25b = loadTwilio25b({}, emptyDb25b);
  const credsNone25b = await twilioNone25b.getCredentials();
  const credsEmptyWs25b = await twilioNone25b.getCredentials({ workspaceId: 99 });
  const configuredWs25b = await twilioWs25b.isConfigured({ workspaceId: 1 });
  const configuredNone25b = await twilioNone25b.isConfigured();
  check('batch25b twilio dormant: no workspace context (or an unconfigured workspace) stays unconfigured', () => {
    assert.equal(credsNone25b.accountSid, '');
    assert.equal(credsNone25b.authToken, '');
    assert.equal(credsNone25b.source, 'none');
    assert.equal(credsEmptyWs25b.source, 'none');
    assert.equal(configuredWs25b, true, 'isConfigured honors the workspace fallback');
    assert.equal(configuredNone25b, false);
  });
  const chatbotSrc25b = fs.readFileSync(path.join(root, 'server/chatbot.js'), 'utf8');
  const smsOptInSrc25b = fs.readFileSync(path.join(root, 'server/smsOptIn.js'), 'utf8');
  check('batch25b wiring: chatbot owner-notify + smsOptIn read settings via the decrypting reader', () => {
    assert.ok(chatbotSrc25b.includes('sms.readWorkspaceSettings(db)'), 'chatbot uses the decrypting reader');
    assert.ok(smsOptInSrc25b.includes('sms.readWorkspaceSettings(db)'), 'smsOptIn delegates to the decrypting reader');
    assert.ok(!smsOptInSrc25b.includes('SELECT key, value FROM settings'), 'no raw settings read left in smsOptIn');
  });
  emptyDb25b.close();

  // --- Call Tracking client/admin split (Batch 25c) -------------------
  // Ely's correction (2026-10-26): portal clients must NOT configure
  // forwarding. The portal keeps ONE field — their phone number — whose
  // save updates leads.phone and makes that number the forwarding
  // destination; tracking number, forwarding, recording, notify and the
  // button label are admin-only. The site button shows the client's
  // number as text and dials the tracking number when one is assigned.
  const sm25c = load('server/siteModules.js', {
    '../src/pageContentScan': require(path.join(root, 'src/pageContentScan.js')),
    '../src/websiteEngine': require(path.join(root, 'src/websiteEngine.js')),
    './portalContacts': contacts,
    '../src/secretBox': require(path.join(root, 'src/secretBox.js')),
    './membershipStripe': {},
    './shopStripe': {},
  });
  sm25c.ensureTables(db);
  db.prepare("INSERT INTO leads (id, business_name, email, phone) VALUES (2511, 'Fixture Split', 'split@example.invalid', '')").run();
  db.prepare("INSERT INTO leads (id, business_name, email, phone) VALUES (2512, 'Fixture Split Bare', 'split2@example.invalid', '')").run();
  const portal25c = load('server/clientPortal.js', {
    './portalTabs': portalTabs,
    bcryptjs: { hashSync: () => 'fixture' },
    './db': {},
    './mailer': {},
    './stripeClient': { appUrl: () => 'https://example.test' },
    './workspaceDb': {},
    './domain': { withDb: (_ws, fn) => fn(db) },
    './portalContacts': contacts,
    './siteModules': sm25c,
    './shopStripe': {},
    './billing': { effectivePlan: async () => 'standard' },
    './plans': { getPlan: () => ({ entitlements: { siteModules: true, chatbot: false } }) },
  });
  // Admin pre-configures 2511: tracking number + flags the client must
  // not be able to touch from the portal.
  sm25c.updateCallTrackingConfig(db, 2511, {
    display_number: '+16105550199',
    cta_text: 'Call the shop',
    redirect_enabled: true,
    record_calls: true,
    notify_email: false,
  });
  const saved25c = await portal25c.saveCallTrackingConfig(
    1,
    2511,
    {
      phone: '6105550143',
      display_number: '+19999999999',
      redirect_number: '+19999999999',
      redirect_enabled: false,
      record_calls: false,
      notify_email: true,
      cta_text: 'Hacked label',
      twilio_number_sid: 'PNhacked',
    },
    'split@example.invalid'
  );
  check('batch25c portal save: writes leads.phone + redirect destination, ignores every config field', () => {
    assert.equal(saved25c.phone_number, '+16105550143');
    assert.equal(saved25c.tracking_assigned, true);
    assert.equal(db.prepare('SELECT phone FROM leads WHERE id = 2511').get().phone, '+16105550143');
    const cfg = sm25c.getCallTrackingConfig(db, 2511);
    assert.equal(cfg.redirect_number, '+16105550143', 'client number became the forwarding destination');
    assert.equal(cfg.display_number, '+16105550199', 'tracking number untouched');
    assert.equal(cfg.redirect_enabled, true, 'forwarding toggle untouched');
    assert.equal(cfg.record_calls, true, 'recording untouched');
    assert.equal(cfg.notify_email, false, 'notify untouched');
    assert.equal(cfg.cta_text, 'Call the shop', 'button label untouched');
    assert.equal(cfg.twilio_number_sid, '', 'number sid untouched');
  });
  let reject25c = null;
  try {
    await portal25c.saveCallTrackingConfig(1, 2511, { phone: 'call-me-maybe' }, 'split@example.invalid');
  } catch (e) {
    reject25c = e;
  }
  let noPhone25c = null;
  try {
    await portal25c.saveCallTrackingConfig(1, 2511, { display_number: '+16105550000' }, 'split@example.invalid');
  } catch (e) {
    noPhone25c = e;
  }
  check('batch25c portal save: garbage phone and config-only payloads are rejected, nothing written', () => {
    assert.equal(reject25c && reject25c.code, 'VALIDATION');
    assert.equal(noPhone25c && noPhone25c.code, 'VALIDATION');
    assert.equal(db.prepare('SELECT phone FROM leads WHERE id = 2511').get().phone, '+16105550143');
    assert.equal(sm25c.getCallTrackingConfig(db, 2511).display_number, '+16105550199');
  });
  const panel25c = await portal25c.listModuleItems(1, 2511, 'calltracking', 'split@example.invalid');
  check('batch25c portal payload: phone + public display number + read-only calls/billing only, no admin config fields exposed', () => {
    const ct = panel25c.calltracking;
    assert.ok(ct, 'calltracking block present');
    assert.equal(ct.phone_number, '+16105550143');
    assert.equal(ct.tracking_assigned, true);
    assert.equal(ct.display_number, '+16105550199', 'Batch 26b: the public website number is available for the save-as-contact tip');
    assert.ok(Array.isArray(ct.calls));
    assert.ok(ct.billing && typeof ct.billing.answered === 'number');
    for (const k of ['config', 'cta_text', 'redirect_enabled', 'redirect_number', 'record_calls', 'notify_email', 'twilio_number_sid', 'voice_url']) {
      assert.ok(!(k in ct), `portal payload must not expose ${k}`);
    }
  });
  await portal25c.saveCallTrackingConfig(1, 2512, { phone: '+16105550100' }, 'split2@example.invalid');
  const embedSrc25c = fs.readFileSync(path.join(root, 'public/js/module-embed.js'), 'utf8');
  check('batch25c site rendering: button displays and dials the Twilio tracking number; the client number is forward-to only', () => {
    assert.equal(sm25c.MODULE_SCRIPT_VER, 'mod39');
    const pubFull = sm25c.publicCallTrackingPayload(db, 2511);
    assert.equal(pubFull.configured, true);
    assert.equal(pubFull.display_number, '+16105550199', 'button number = the Twilio tracking number (text + tel target)');
    assert.equal(pubFull.display_number_formatted, '(610) 555-0199', 'button text = the formatted tracking number');
    assert.equal(pubFull.tracking_number, '+16105550199');
    assert.ok(!('phone_number' in pubFull), 'public payload never carries the client number');
    const pubBare = sm25c.publicCallTrackingPayload(db, 2512);
    assert.equal(pubBare.configured, true);
    assert.equal(pubBare.tracking_number, '');
    assert.equal(pubBare.display_number, '+16105550100', 'no tracking assigned → fallback shows/dials the client number itself');
    assert.equal(pubBare.display_number_formatted, '(610) 555-0100');
    assert.ok(
      embedSrc25c.includes('ct.display_number_formatted || ct.display_number'),
      'embed renders the tracking number as the button text'
    );
    assert.ok(!embedSrc25c.includes('ct.phone_number'), 'embed never renders a client-number field');
  });
  check('batch25c-fix site rendering: rendered button never contains the redirect number when a tracking number is assigned', () => {
    const pubFull = sm25c.publicCallTrackingPayload(db, 2511);
    const cfg = sm25c.getCallTrackingConfig(db, 2511);
    assert.equal(cfg.redirect_number, '+16105550143', 'fixture: the client number is the forward-to destination');
    // Compose the button exactly as module-embed.js does from the payload.
    const buttonHtml =
      '<a class="bp-mod-call" href="tel:' + pubFull.display_number + '">' +
      '<span class="bp-mod-call-label">' + pubFull.cta_text + '</span>' +
      '<span class="bp-mod-call-number">' + (pubFull.display_number_formatted || pubFull.display_number) + '</span></a>';
    assert.ok(buttonHtml.includes('href="tel:+16105550199"'), 'button dials the tracking number');
    assert.ok(buttonHtml.includes('(610) 555-0199'), 'button text shows the tracking number');
    for (const leak of ['+16105550143', '16105550143', '5550143', '555-0143']) {
      assert.ok(!buttonHtml.includes(leak), `rendered button must not contain the client number (${leak})`);
      assert.ok(!JSON.stringify(pubFull).includes(leak), `public payload must not contain the client number (${leak})`);
    }
  });
  db.prepare(
    "INSERT INTO site_module_embeds (lead_id, module_type, public_token, published) VALUES (2511, 'calltracking', 'tok25c2511', 1)"
  ).run();
  const adminSaved25c = await domain21.adminSaveCallTrackingConfig(1, {
    leadId: 2511,
    redirect_enabled: false,
    record_calls: false,
    notify_email: true,
    cta_text: 'Admin label',
    redirect_number: '+16105550111',
  });
  check('batch25c admin save: full forwarding config still writable from the admin side', () => {
    assert.equal(adminSaved25c.lead_phone, '+16105550143', 'admin sees the client number as the destination');
    const cfg = adminSaved25c.config;
    assert.equal(cfg.redirect_enabled, false);
    assert.equal(cfg.record_calls, false);
    assert.equal(cfg.notify_email, true);
    assert.equal(cfg.cta_text, 'Admin label');
    assert.equal(cfg.redirect_number, '+16105550111', 'admin override of the destination wins');
    assert.equal(cfg.display_number, '+16105550199', 'tracking number preserved');
  });
  const overview25c = await domain21.adminCallsOverview(1);
  check('batch25c admin overview: business carries client number + full config + voice webhook url', () => {
    const biz = overview25c.businesses.find((b) => Number(b.lead_id) === 2511);
    assert.ok(biz, 'business with the module attached is listed');
    assert.equal(biz.lead_phone, '+16105550143');
    assert.equal(biz.config.redirect_number, '+16105550111');
    assert.equal(biz.config.display_number, '+16105550199');
    assert.equal(biz.voice_url, 'https://example.test/api/v1/calls/voice/1/2511');
  });
  const portalSrc25c = fs.readFileSync(path.join(root, 'public/js/portal.js'), 'utf8');
  const appSrc25c = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
  const apiSrc25c = fs.readFileSync(path.join(root, 'public/js/api.js'), 'utf8');
  const domainApiSrc25c = fs.readFileSync(path.join(root, 'server/routes/domainApi.js'), 'utf8');
  check('batch25c wiring: portal panel is phone-only; admin Calls page owns the forwarding form', () => {
    assert.ok(portalSrc25c.includes('calltracking-phone-number'), 'portal keeps the phone field');
    assert.ok(portalSrc25c.includes('btn-calltracking-phone-save'), 'portal keeps the phone save');
    for (const gone of [
      'calltracking-display-number',
      'calltracking-cta-text',
      'calltracking-redirect-enabled',
      'calltracking-redirect-number',
      'calltracking-record-calls',
      'calltracking-notify-email',
      'btn-calltracking-config-save',
      'Using your own Twilio number',
    ]) {
      assert.ok(!portalSrc25c.includes(gone), `portal must not contain ${gone}`);
    }
    assert.ok(appSrc25c.includes('cl-cfg-save') && appSrc25c.includes('adminCallConfigSave'), 'admin form wired');
    assert.ok(apiSrc25c.includes("adminCallConfigSave: (body) => put('/admin-area/calls/config', body)"), 'api helper wired');
    assert.ok(domainApiSrc25c.includes("'/admin-area/calls/config'"), 'admin route registered');
  });

  // --- Call Tracking "New Lead" contact tip (Batch 26b) ----------------
  const panelBare26b = await portal25c.listModuleItems(1, 2512, 'calltracking', 'split2@example.invalid');
  check('batch26b portal payload: display_number appears only when a tracking number is assigned and no admin config leaks', () => {
    assert.equal(panel25c.calltracking.display_number, '+16105550199');
    assert.equal(panel25c.calltracking.tracking_assigned, true);
    assert.ok(!('display_number' in panelBare26b.calltracking), 'unassigned panel omits display_number');
    assert.equal(panelBare26b.calltracking.tracking_assigned, false);
    for (const panel of [panel25c.calltracking, panelBare26b.calltracking]) {
      for (const k of ['config', 'cta_text', 'redirect_enabled', 'redirect_number', 'record_calls', 'notify_email', 'twilio_number_sid', 'voice_url']) {
        assert.ok(!(k in panel), `portal payload must not expose ${k}`);
      }
    }
  });
  check('batch26b portal card + admin tip: highlighted assigned card formats the website number, unassigned card is muted, admin carries the client tip', () => {
    const formattedNumber = panel25c.calltracking.display_number.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, '($1) $2-$3');
    assert.equal(formattedNumber, '(610) 555-0199');
    assert.ok(portalSrc25c.includes('calltracking-new-lead-card'), 'portal renders the New Lead instruction card');
    assert.ok(portalSrc25c.includes('Know when a website lead calls'), 'card heading present');
    assert.ok(portalSrc25c.includes('Save your website number <strong>${esc(websiteNumberDisplay)}</strong>'), 'assigned card names the formatted website number');
    assert.ok(portalSrc25c.includes("your phone will show 'New Lead'"), 'assigned card explains the caller-name payoff');
    assert.ok(portalSrc25c.includes('calltracking-new-lead-card is-muted'), 'unassigned card has the muted treatment');
    assert.ok(
      portalSrc25c.includes("Once your website number is set up here, save it in your phone as 'New Lead' so website calls are easy to spot."),
      'unassigned card carries the muted setup copy'
    );
    assert.ok(portalSrc25c.includes('${leadContactTipHtml}'), 'card is placed in the Call Tracking panel');
    assert.ok(
      appSrc25c.includes("Tip for the client: save this number in their phone as 'New Lead'."),
      'admin business card carries the subtle client tip'
    );
  });

  // --- Site Rentals "Rent to Lead" (Batch 26) -------------------------
  // A rental LINKS a tenant lead to a rented website. While live, the
  // site's call redirect + delivery resolve to the tenant, every
  // capture/call is stamped (website_id, tenant_lead_id, rental_id),
  // and per-lead charges settle through the credits engine — soft:
  // a zero balance flips charges to 'due', never blocks delivery.
  const rentalsState26 = { balance: 100, spends: [], mails: [] };
  const creditsStub26 = {
    spend: async (_ws, amount, opts = {}) => {
      const key = `${opts.reason}|${opts.refType}|${opts.refId}`;
      if (rentalsState26.spends.some((s) => s.key === key)) return { alreadySpent: true };
      const amt = Math.max(0, Math.floor(Number(amount) || 0));
      if (rentalsState26.balance < amt) {
        const e = new Error('Insufficient credits');
        e.code = 'INSUFFICIENT_CREDITS';
        throw e;
      }
      rentalsState26.balance -= amt;
      rentalsState26.spends.push({ key, amount: amt });
      return { spent: amt };
    },
  };
  const rentals26 = load('server/rentals.js', {
    './domain': { withDb: (_ws, fn) => fn(db) },
    './credits': creditsStub26,
    './mailer': {
      sendPlatformMail: async (msg) => {
        rentalsState26.mails.push(msg);
        return { sent: true };
      },
    },
    './stripeClient': { appUrl: () => 'https://example.test' },
    './callNotify': {
      resolveNotifyRecipient: (d, leadId) => {
        const l = d.prepare('SELECT email FROM leads WHERE id = ?').get(Number(leadId));
        return l ? String(l.email || '').trim() : '';
      },
    },
    './siteModules': sm25c,
  });
  const sm26 = load('server/siteModules.js', {
    '../src/pageContentScan': require(path.join(root, 'src/pageContentScan.js')),
    '../src/websiteEngine': require(path.join(root, 'src/websiteEngine.js')),
    './portalContacts': contacts,
    '../src/secretBox': require(path.join(root, 'src/secretBox.js')),
    './membershipStripe': {},
    './shopStripe': {},
    './rentals': rentals26,
  });
  sm26.ensureTables(db);
  rentals26.ensureRentals(db);
  db.prepare("INSERT INTO leads (id, business_name, email, phone, category, city) VALUES (2601, 'Fixture Septic Co', 'owner26@example.invalid', '6105550101', 'Septic Services', 'Reading')").run();
  db.prepare("INSERT INTO leads (id, business_name, email, phone, category, city) VALUES (2602, 'Fixture Renter One', 'tenant26@example.invalid', '6105550111', 'Septic Services', 'Reading')").run();
  db.prepare("INSERT INTO leads (id, business_name, email, phone, category, city) VALUES (2603, 'Fixture Renter Two', 'tenant2-26@example.invalid', '6105550122', 'Roofing', 'Reading')").run();
  db.prepare("INSERT INTO leads (id, business_name, email, phone, category, city) VALUES (2604, 'Fixture Septic Two', 'owner2-26@example.invalid', '6105550144', 'Septic Services', 'Reading')").run();
  db.prepare("INSERT INTO leads (id, business_name, email, phone, category, city) VALUES (2605, 'Fixture Renter Three', 'tenant3-26@example.invalid', '6105550133', 'Septic Services', 'Reading')").run();
  db.prepare("INSERT INTO leads (id, business_name, email, phone, category, city) VALUES (2606, 'Fixture Roof Co', 'owner3-26@example.invalid', '6105550155', 'Roofing', 'Reading')").run();
  db.prepare("INSERT INTO websites (id, lead_id, name, industry, theme, pages, status) VALUES (2601, 2601, 'Reading Septic Pros', 'Septic Services', '{}', '[]', 'published')").run();
  db.prepare("INSERT INTO websites (id, lead_id, name, industry, theme, pages, status) VALUES (2602, 2604, 'Reading Septic Two Site', 'Septic Services', '{}', '[]', 'published')").run();
  db.prepare("INSERT INTO websites (id, lead_id, name, industry, theme, pages, status) VALUES (2604, 2606, 'Reading Roofers', 'Roofing', '{}', '[]', 'published')").run();
  sm26.updateCallTrackingConfig(db, 2601, {
    display_number: '6105550199',
    redirect_number: '+16105550101',
    redirect_enabled: true,
  });
  const chargesFor26 = (rid) =>
    db.prepare('SELECT * FROM site_rental_charges WHERE rental_id = ? ORDER BY id ASC').all(rid);
  const cfgOf26 = (leadId) => sm26.getCallTrackingConfig(db, leadId);

  const createdA26 = await rentals26.createRental(
    1,
    { websiteId: 2601, tenantLeadId: 2602, model: 'per_lead', priceCents: 2500, trialLeads: 2 },
    { createdBy: 'test' }
  );
  const rentalA26 = createdA26.rental.id;
  check('batch26 schema: rentals + charges tables, one-live partial index, stamp columns', () => {
    const tbls = db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index') AND name LIKE '%site_rental%'")
      .all()
      .map((r) => r.name);
    assert.ok(tbls.includes('site_rentals') && tbls.includes('site_rental_charges'));
    assert.ok(tbls.includes('idx_site_rentals_one_live'));
    const evCols = db.prepare('PRAGMA table_info(leadscout_events)').all().map((c) => c.name);
    assert.ok(evCols.includes('website_id') && evCols.includes('tenant_lead_id') && evCols.includes('rental_id'));
    const logCols = db.prepare('PRAGMA table_info(call_logs)').all().map((c) => c.name);
    assert.ok(logCols.includes('rental_id'));
  });
  check('batch26 create: starts in trial; activation forwards calls to the TENANT phone, display number untouched, previous redirect snapshotted', () => {
    assert.equal(createdA26.rental.status, 'trial');
    assert.equal(createdA26.activation.callRouting, 'written');
    const cfg = cfgOf26(2601);
    assert.equal(cfg.redirect_number, '+16105550111', 'forward-TO is the tenant number');
    assert.equal(cfg.display_number, '+16105550199', 'Twilio display number never changes (25c rule)');
    const row = db.prepare('SELECT * FROM site_rentals WHERE id = ?').get(rentalA26);
    assert.equal(row.prev_redirect_number, '+16105550101');
    assert.equal(row.applied_redirect_number, '+16105550111');
  });
  check('batch26 create: activation email "Your site is live" goes to the tenant', () => {
    assert.equal(rentalsState26.mails.length, 1);
    assert.equal(rentalsState26.mails[0].to, 'tenant26@example.invalid');
    assert.equal(rentalsState26.mails[0].subject, 'Your site is live');
  });
  const occupiedErr26 = await rentals26
    .createRental(1, { websiteId: 2601, tenantLeadId: 2603, model: 'per_lead', priceCents: 1000 })
    .then(() => null, (e) => e);
  check('batch26 one live rental per site: second create is a hard RENTAL_SITE_OCCUPIED', () => {
    assert.ok(occupiedErr26);
    assert.equal(occupiedErr26.code, 'RENTAL_SITE_OCCUPIED');
    assert.equal(occupiedErr26.status, 409);
    assert.throws(
      () =>
        db
          .prepare(
            "INSERT INTO site_rentals (website_id, tenant_lead_id, owner_lead_id, model, price_cents, status) VALUES (2601, 2603, 2601, 'flat', 100, 'active')"
          )
          .run(),
      /UNIQUE constraint/
    );
  });
  const conflictErr26 = await rentals26
    .createRental(1, { websiteId: 2602, tenantLeadId: 2605, model: 'per_lead', priceCents: 2000 })
    .then(() => null, (e) => e);
  const createdC26 = await rentals26.createRental(1, {
    websiteId: 2602,
    tenantLeadId: 2605,
    model: 'per_lead',
    priceCents: 2000,
    overrideConflict: true,
  });
  check('batch26 niche+town conflict: warning names the clash, override creates with the warning attached', () => {
    assert.ok(conflictErr26);
    assert.equal(conflictErr26.code, 'RENTAL_CONFLICT');
    assert.equal(conflictErr26.conflicts.length, 1);
    assert.equal(conflictErr26.conflicts[0].website_id, 2601);
    assert.equal(createdC26.warnings.length, 1);
    assert.equal(createdC26.activation.reason, 'no_calltracking_config', 'owner without a tracking config: routing skipped, rental still live');
  });
  await rentals26.endRental(1, createdC26.rental.id, { reason: 'fixture cleanup' });
  check('batch26 delivery resolution: stamp + delivery lead + tenant alert email all point at the tenant while live', () => {
    const stamp = rentals26.resolveStamp(db, 2601);
    assert.equal(stamp.websiteId, 2601);
    assert.equal(stamp.tenantLeadId, 2602);
    assert.equal(stamp.rentalId, rentalA26);
    assert.equal(rentals26.deliveryLeadId(db, 2601), 2602);
    assert.equal(rentals26.tenantAlertEmail(db, 2602), 'tenant26@example.invalid');
  });
  const wholeDollarErr26 = (() => {
    try {
      rentals26.createRentalRow(db, { websiteId: 2602, tenantLeadId: 2605, model: 'per_lead', priceCents: 2550 });
      return null;
    } catch (e) {
      return e;
    }
  })();
  check('batch26 validation: per-lead price must be whole dollars ($1 = 1 credit)', () => {
    assert.ok(wholeDollarErr26);
    assert.equal(wholeDollarErr26.code, 'VALIDATION');
  });

  const capA26 = contacts.captureFromSubmission(db, {
    leadId: 2601,
    submissionId: 26001,
    formId: 2601,
    formName: 'Contact',
    payload: { name: 'Site Visitor One', email: 'visitor1@example.invalid', phone: '6105550201' },
  });
  const capA26dup = contacts.captureFromSubmission(db, {
    leadId: 2601,
    submissionId: 26001,
    formId: 2601,
    formName: 'Contact',
    payload: { name: 'Site Visitor One', email: 'visitor1@example.invalid', phone: '6105550201' },
  });
  const bookA26 = contacts.captureFromBooking(db, {
    leadId: 2601,
    booking: {
      id: 26001,
      customer_name: 'Booker One',
      customer_email: 'booker@example.invalid',
      customer_phone: '6105550202',
      status: 'confirmed',
      starts_at: '2026-11-01 10:00',
    },
    serviceName: 'Septic pumping',
  });
  const estA26 = contacts.captureFromEstimate(db, {
    leadId: 2601,
    request: { id: 26001, name: 'Est One', email: 'est@example.invalid', phone: '6105550203', selections: [] },
  });
  check('batch26 captures stamped: form + booking + estimate events carry website/tenant/rental and open pending charges; re-capture dedupes', () => {
    for (const ev of [capA26, bookA26, estA26]) {
      const row = db.prepare('SELECT website_id, tenant_lead_id, rental_id FROM leadscout_events WHERE id = ?').get(ev.eventId);
      assert.equal(row.website_id, 2601);
      assert.equal(row.tenant_lead_id, 2602);
      assert.equal(row.rental_id, rentalA26);
    }
    assert.equal(capA26dup.deduped, true);
    const charges = chargesFor26(rentalA26);
    assert.equal(charges.length, 3, 'one charge per qualified capture — the deduped re-capture adds none');
    assert.ok(charges.every((c) => c.status === 'pending' && c.source_kind === 'capture'));
  });

  const embed26 = sm26.ensureEmbed(db, 2601, 'chatbot', { workspaceId: 1 });
  // A module sync may have pre-created the row without a public token.
  if (!embed26.public_token) {
    db.prepare("UPDATE site_module_embeds SET public_token = '1_fixturetoken26' WHERE id = ?").run(embed26.id);
    embed26.public_token = '1_fixturetoken26';
  }
  db.prepare('UPDATE site_module_embeds SET embed_enabled = 1, published = 1 WHERE id = ?').run(embed26.id);
  const chatbot26 = load('server/chatbot.js', {
    './rentals': rentals26,
    './siteModules': sm26,
    './smsOptIn': { optInBlock: () => null, businessNameForLead: () => '' },
  });
  const chatCap26 = chatbot26.captureLead(db, embed26.public_token, {
    name: 'Chat Visitor',
    email: 'chatvisitor@example.invalid',
    phone: '6105550204',
    message: 'Do you pump septic tanks?',
  });
  check('batch26 chatbot capture: lead stamped + charged as a chatbot site lead; notify payload delivers to the tenant', () => {
    const row = db
      .prepare('SELECT website_id, tenant_lead_id, rental_id FROM chatbot_leads WHERE id = ?')
      .get(chatCap26.lead.id);
    assert.equal(row.website_id, 2601);
    assert.equal(row.tenant_lead_id, 2602);
    assert.equal(row.rental_id, rentalA26);
    const charge = db
      .prepare("SELECT * FROM site_rental_charges WHERE source_kind = 'chatbot' AND chatbot_lead_id = ?")
      .get(chatCap26.lead.id);
    assert.ok(charge && charge.status === 'pending');
    assert.equal(chatCap26._notify.deliveryEmail, 'tenant26@example.invalid');
    assert.equal(chatCap26._notify.deliveryPhone, '6105550111');
  });

  const settle1_26 = await rentals26.settlePendingCharges(1);
  check('batch26 settle: trial leads consumed first (in order), then credits debit exactly once per lead; rental flips trial → active', () => {
    assert.equal(settle1_26.trialed, 2);
    assert.equal(settle1_26.charged, 2);
    assert.equal(settle1_26.due, 0);
    const charges = chargesFor26(rentalA26);
    assert.deepEqual(charges.map((c) => c.status), ['trial', 'trial', 'charged', 'charged']);
    assert.equal(rentalsState26.spends.length, 2);
    assert.ok(rentalsState26.spends.every((s) => s.amount === 25 && s.key.startsWith('Rental site lead|site_rental_lead|')));
    assert.equal(rentalsState26.balance, 50);
    const row = db.prepare('SELECT status, trial_used FROM site_rentals WHERE id = ?').get(rentalA26);
    assert.equal(row.status, 'active');
    assert.equal(row.trial_used, 2);
  });

  sm26.logCallInitiated(db, 2601, { callSid: 'CA26a', from: '+16105550209', to: '+16105550199', verified: true });
  sm26.upsertCallStatus(
    db,
    2601,
    {
      CallSid: 'CA26a',
      From: '+16105550209',
      To: '+16105550199',
      CallStatus: 'completed',
      DialCallStatus: 'completed',
      DialCallDuration: '30',
    },
    { verified: true }
  );
  const callSettle26 = await rentals26.settleCallCharge(1, 'CA26a');
  check('batch26 counted call (answered ≥15s): call log stamped at log time and billed as a site lead', () => {
    const call = db.prepare("SELECT website_id, tenant_lead_id, rental_id, counted FROM call_logs WHERE call_sid = 'CA26a'").get();
    assert.equal(call.website_id, 2601);
    assert.equal(call.tenant_lead_id, 2602);
    assert.equal(call.rental_id, rentalA26);
    assert.equal(call.counted, 1);
    assert.equal(callSettle26.settled, true);
    const charge = db.prepare("SELECT * FROM site_rental_charges WHERE source_kind = 'call' AND rental_id = ?").get(rentalA26);
    assert.ok(charge && charge.status === 'charged' && charge.credits_debited === 25);
    assert.equal(rentalsState26.balance, 25);
  });

  rentalsState26.balance = 0;
  const capDue26 = contacts.captureFromSubmission(db, {
    leadId: 2601,
    submissionId: 26002,
    formId: 2601,
    formName: 'Contact',
    payload: { name: 'Site Visitor Two', email: 'visitor2@example.invalid', phone: '6105550205' },
  });
  const settle2_26 = await rentals26.settlePendingCharges(1);
  check('batch26 soft cap: at zero balance the capture still lands (delivery never blocked) and the charge flips to due with the amount accruing', () => {
    assert.ok(capDue26.eventId, 'capture succeeded at zero balance');
    assert.equal(settle2_26.due, 1);
    const charge = db
      .prepare('SELECT * FROM site_rental_charges WHERE event_id = ?')
      .get(capDue26.eventId);
    assert.equal(charge.status, 'due');
    assert.equal(charge.amount_due_cents, 2500);
    const counters = rentals26.rentalCounters(db, rentalA26);
    assert.equal(counters.qualified_leads, 6);
    assert.equal(counters.amount_due_cents, 2500);
    assert.equal(counters.charged_credits, 75);
  });

  const createdF26 = await rentals26.createRental(1, {
    websiteId: 2604,
    tenantLeadId: 2603,
    model: 'flat',
    priceCents: 49900,
  });
  const capF26 = contacts.captureFromSubmission(db, {
    leadId: 2606,
    submissionId: 26005,
    formId: 2606,
    formName: 'Contact',
    payload: { name: 'Roof Visitor', email: 'roofvisitor@example.invalid', phone: '6105550206' },
  });
  check('batch26 flat model: captures are stamped + tracked but never charged', () => {
    const row = db.prepare('SELECT website_id, tenant_lead_id, rental_id FROM leadscout_events WHERE id = ?').get(capF26.eventId);
    assert.equal(row.website_id, 2604);
    assert.equal(row.tenant_lead_id, 2603);
    assert.equal(row.rental_id, createdF26.rental.id);
    assert.equal(chargesFor26(createdF26.rental.id).length, 0);
    assert.equal(rentals26.rentalCounters(db, createdF26.rental.id).qualified_leads, 0);
  });

  const historyBeforeSwap26 = rentals26.tenantSiteLeads(db, rentalA26).length;
  const endedA26 = await rentals26.endRental(1, rentalA26, { reason: 'term complete' });
  check('batch26 end: forwarding restored to the owner snapshot, delivery resolution clears, closing summary emailed', () => {
    assert.equal(endedA26.unroute.restored, true);
    assert.equal(cfgOf26(2601).redirect_number, '+16105550101');
    assert.equal(rentals26.resolveStamp(db, 2601).rentalId, null);
    assert.equal(rentals26.deliveryLeadId(db, 2601), 2601);
    const closing = rentalsState26.mails[rentalsState26.mails.length - 1];
    assert.equal(closing.to, 'tenant26@example.invalid');
    assert.ok(closing.subject.startsWith('Your rental of'));
    const view = rentals26.tenantView(db, 2602);
    assert.equal(view.length, 1, 'the old tenant keeps exactly their own rental, read-only');
    assert.equal(view[0].status, 'ended');
    assert.equal(view[0].history.length, historyBeforeSwap26);
    assert.equal(historyBeforeSwap26, 6);
  });

  const createdB26 = await rentals26.createRental(1, {
    websiteId: 2601,
    tenantLeadId: 2603,
    model: 'per_lead',
    priceCents: 1000,
    trialLeads: 0,
  });
  const rentalB26 = createdB26.rental.id;
  const capB26 = contacts.captureFromSubmission(db, {
    leadId: 2601,
    submissionId: 26003,
    formId: 2601,
    formName: 'Contact',
    payload: { name: 'New Tenant Visitor', email: 'visitor3@example.invalid', phone: '6105550207' },
  });
  await rentals26.settlePendingCharges(1);
  check('batch26 tenant swap: new captures stamp the NEW tenant; the old tenant\u2019s frozen history does not move; new tenant\u2019s portal view is isolated', () => {
    assert.equal(createdB26.rental.status, 'active', 'no trial leads → active immediately');
    assert.equal(cfgOf26(2601).redirect_number, '+16105550122');
    const row = db.prepare('SELECT tenant_lead_id, rental_id FROM leadscout_events WHERE id = ?').get(capB26.eventId);
    assert.equal(row.tenant_lead_id, 2603);
    assert.equal(row.rental_id, rentalB26);
    assert.equal(rentals26.tenantSiteLeads(db, rentalA26).length, historyBeforeSwap26, 'old tenant history frozen');
    const charge = db.prepare('SELECT * FROM site_rental_charges WHERE rental_id = ?').get(rentalB26);
    assert.equal(charge.status, 'due', 'zero balance → due at the NEW rental\u2019s $10 price');
    assert.equal(charge.amount_due_cents, 1000);
    const viewB = rentals26.tenantView(db, 2603);
    assert.ok(viewB.length >= 2 && viewB.every((v) => v.tenant_lead_id === 2603));
    assert.equal(rentals26.tenantView(db, 2602).length, 1, 'tenant A never sees tenant B\u2019s rentals');
  });

  const pausedB26 = rentals26.pauseRental(1, rentalB26);
  const capPaused26 = contacts.captureFromSubmission(db, {
    leadId: 2601,
    submissionId: 26004,
    formId: 2601,
    formName: 'Contact',
    payload: { name: 'Paused Visitor', email: 'visitor4@example.invalid', phone: '6105550208' },
  });
  const resumedB26 = rentals26.resumeRental(1, rentalB26);
  check('batch26 pause/resume: pause un-routes and frees the slot (captures go unstamped), resume re-routes to the tenant', () => {
    assert.equal(pausedB26.rental.status, 'paused');
    assert.equal(pausedB26.unroute.restored, true);
    const row = db.prepare('SELECT rental_id FROM leadscout_events WHERE id = ?').get(capPaused26.eventId);
    assert.equal(row.rental_id, null);
    assert.equal(chargesFor26(rentalB26).length, 1, 'no charge accrues while paused');
    assert.equal(resumedB26.rental.status, 'active');
    assert.equal(cfgOf26(2601).redirect_number, '+16105550122');
  });

  sm26.updateCallTrackingConfig(db, 2601, { redirect_number: '+16105550999' });
  const endedB26 = await rentals26.endRental(1, rentalB26, { reason: 'admin moved on' });
  check('batch26 end never stomps an admin-changed redirect', () => {
    assert.equal(endedB26.unroute.restored, false);
    assert.equal(endedB26.unroute.reason, 'redirect_changed_since_activation');
    assert.equal(cfgOf26(2601).redirect_number, '+16105550999');
  });

  db.prepare("INSERT INTO websites (id, lead_id, name, industry, theme, pages, status) VALUES (2511, 2511, 'Fixture Bakery Site', 'Bakery', '{}', '[]', 'published')").run();
  const createdG26 = await rentals26.createRental(1, {
    websiteId: 2511,
    tenantLeadId: 2602,
    model: 'per_lead',
    priceCents: 500,
  });
  const portal26 = load('server/clientPortal.js', {
    './portalTabs': portalTabs,
    bcryptjs: { hashSync: () => 'fixture' },
    './db': {},
    './mailer': {},
    './stripeClient': { appUrl: () => 'https://example.test' },
    './workspaceDb': {},
    './domain': { withDb: (_ws, fn) => fn(db) },
    './portalContacts': contacts,
    './siteModules': sm26,
    './rentals': rentals26,
    './shopStripe': {},
    './billing': { effectivePlan: async () => 'standard' },
    './plans': { getPlan: () => ({ entitlements: { siteModules: true, chatbot: false } }) },
  });
  const portalSave26 = await portal26.saveCallTrackingConfig(
    1,
    2511,
    { phone: '6105550177' },
    'split@example.invalid'
  );
  check('batch26 portal guard: while the owner\u2019s site is rented out, the portal phone save updates leads.phone but cannot stomp the tenant\u2019s forwarding', () => {
    assert.equal(cfgOf26(2511).redirect_number, '+16105550111', 'activation pointed 2511\u2019s forwarding at the tenant');
    assert.equal(portalSave26.rental_active, true);
    assert.equal(db.prepare('SELECT phone FROM leads WHERE id = 2511').get().phone, '+16105550177');
    assert.equal(cfgOf26(2511).redirect_number, '+16105550111', 'portal save left the tenant redirect in place');
  });
  await rentals26.endRental(1, createdG26.rental.id, { reason: 'fixture cleanup' });

  const rentalsSrc26 = fs.readFileSync(path.join(root, 'server/rentals.js'), 'utf8');
  const domainApiSrc26 = fs.readFileSync(path.join(root, 'server/routes/domainApi.js'), 'utf8');
  const portalRouteSrc26 = fs.readFileSync(path.join(root, 'server/routes/portal.js'), 'utf8');
  const mcpSrc26 = fs.readFileSync(path.join(root, 'server/mcp.js'), 'utf8');
  const catalogSrc26 = fs.readFileSync(path.join(root, 'src/mcpCatalog.js'), 'utf8');
  const contactFormsSrc26 = fs.readFileSync(path.join(root, 'server/contactForms.js'), 'utf8');
  const ownerNotifySrc26 = fs.readFileSync(path.join(root, 'server/ownerNotify.js'), 'utf8');
  const callsRouteSrc26 = fs.readFileSync(path.join(root, 'server/routes/calls.js'), 'utf8');
  const modulesPublicSrc26 = fs.readFileSync(path.join(root, 'server/routes/modulesPublic.js'), 'utf8');
  const appSrc26 = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
  const portalJsSrc26 = fs.readFileSync(path.join(root, 'public/js/portal.js'), 'utf8');
  const portalHtmlSrc26 = fs.readFileSync(path.join(root, 'public/portal.html'), 'utf8');
  check('batch26 wiring: staff routes, portal route, MCP parity, delivery seams and both UIs are connected', () => {
    assert.ok(rentalsSrc26.includes('idx_site_rentals_one_live'));
    assert.ok(domainApiSrc26.includes("'/admin-area/rentals'") && domainApiSrc26.includes('rentalsCreate'));
    assert.ok(portalRouteSrc26.includes("'/rentals'") && portalRouteSrc26.includes('getMyRentals'));
    for (const n of ['rentals.list', 'rentals.get', 'rentals.create', 'rentals.end']) {
      assert.ok(mcpSrc26.includes(`'${n}'`) || mcpSrc26.includes(`name: '${n}'`), `mcp def/handler ${n}`);
      assert.ok(catalogSrc26.includes(`name: '${n}'`), `catalog ${n}`);
    }
    assert.ok(contactFormsSrc26.includes('liveRentalForLead'), 'form alerts resolve to the tenant');
    assert.ok(ownerNotifySrc26.includes('rentalRoutable'), 'booking/estimate alerts resolve to the tenant');
    assert.ok(callsRouteSrc26.includes('settleCallCharge'), 'terminal call status settles the rental charge');
    assert.ok(modulesPublicSrc26.includes('fireRentalSettle'), 'booking/estimate routes settle charges');
    assert.ok(appSrc26.includes('pageRentals') && appSrc26.includes('rentalsPreselect'), 'staff Rentals page + entry points');
    assert.ok(portalJsSrc26.includes('loadRentals') && portalJsSrc26.includes('renderRentals'), 'portal tenant view wired');
    assert.ok(portalHtmlSrc26.includes('nav-rentals') && portalHtmlSrc26.includes('sec-rentals'), 'portal Rentals tab present');
  });

  // --- Voicemail greeting + owner email (Batch 26c) -------------------
  // Ely (2026-10-26): an unanswered tracked call plays a greeting with
  // the business name and takes a message; the voicemail is
  // transcribed through the existing billing path and emailed to the
  // owner. Admin-side toggle (voicemail_enabled, default ON); the
  // portal only displays voicemails (marker + transcript).
  const sm26c = load('server/siteModules.js', {
    '../src/pageContentScan': require(path.join(root, 'src/pageContentScan.js')),
    '../src/websiteEngine': require(path.join(root, 'src/websiteEngine.js')),
    './portalContacts': contacts,
    '../src/secretBox': require(path.join(root, 'src/secretBox.js')),
    './membershipStripe': {},
    './shopStripe': {},
  });
  sm26c.ensureTables(db);
  db.prepare("INSERT INTO leads (id, business_name, email) VALUES (2611, 'Fixture Voicemail Biz', 'vm@example.invalid')").run();
  db.prepare("INSERT INTO leads (id, business_name, email) VALUES (2612, 'Fixture Voicemail Off', 'vmoff@example.invalid')").run();
  db.prepare("INSERT INTO leads (id, business_name, email) VALUES (2613, 'Fixture Voicemail Broke', 'vmbroke@example.invalid')").run();
  db.prepare("INSERT INTO leads (id, business_name, email) VALUES (2614, 'Fixture Voicemail Bare', 'vmbare@example.invalid')").run();
  db.prepare("INSERT INTO contact_forms (lead_id, name, notify_email) VALUES (2611, 'Contact form', 'vm-alerts@example.invalid')").run();
  db.prepare("INSERT INTO contact_forms (lead_id, name, notify_email) VALUES (2613, 'Contact form', 'vmbroke-alerts@example.invalid')").run();
  sm26c.updateCallTrackingConfig(db, 2611, {
    display_number: '+16105550199',
    redirect_enabled: true,
    redirect_number: '+16105550100',
    record_calls: false,
  });
  sm26c.updateCallTrackingConfig(db, 2612, {
    display_number: '+16105550199',
    redirect_enabled: true,
    redirect_number: '+16105550100',
    voicemail_enabled: false,
  });
  sm26c.updateCallTrackingConfig(db, 2613, {
    display_number: '+16105550199',
    redirect_enabled: true,
    redirect_number: '+16105550100',
  });

  check('batch26c config: voicemail defaults ON, admin toggle persists both ways', () => {
    assert.equal(sm26c.getCallTrackingConfig(db, 2611).voicemail_enabled, true, 'default on for an existing config');
    assert.equal(sm26c.getCallTrackingConfig(db, 2614).voicemail_enabled, true, 'default on for a fresh config');
    assert.equal(sm26c.getCallTrackingConfig(db, 2612).voicemail_enabled, false, 'explicit off persists');
    sm26c.updateCallTrackingConfig(db, 2612, { voicemail_enabled: true });
    assert.equal(sm26c.getCallTrackingConfig(db, 2612).voicemail_enabled, true, 'admin can turn it back on');
    sm26c.updateCallTrackingConfig(db, 2612, { voicemailEnabled: false });
    assert.equal(sm26c.getCallTrackingConfig(db, 2612).voicemail_enabled, false, 'camelCase alias works');
  });

  const vmTwiml26c = sm26c.buildVoicemailTwiml(sm26c.getCallTrackingConfig(db, 2611), {
    workspaceId: 1,
    leadId: 2611,
    baseUrl: 'https://example.test',
    businessName: 'Fixture Voicemail Biz',
  });
  const vmTwimlBare26c = sm26c.buildVoicemailTwiml(sm26c.getCallTrackingConfig(db, 2611), {
    workspaceId: 1,
    leadId: 2611,
    baseUrl: 'https://example.test',
    businessName: '',
  });
  check('batch26c twiml: greeting names the business, Record posts to the vm-flagged recording webhook', () => {
    assert.ok(vmTwiml26c.includes('<Say>Thanks for calling Fixture Voicemail Biz.'));
    assert.ok(
      vmTwiml26c.includes(
        "We're sorry we missed your call. Please leave your name, number, and a brief message after the tone, and we'll get back to you as soon as we can."
      )
    );
    assert.ok(vmTwiml26c.includes('<Record'));
    assert.ok(vmTwiml26c.includes('maxLength="120"'));
    assert.ok(vmTwiml26c.includes('playBeep="true"'));
    assert.ok(vmTwiml26c.includes('recordingStatusCallback="https://example.test/api/v1/calls/recording/1/2611?vm=1"'));
    assert.ok(vmTwiml26c.includes('action="https://example.test/api/v1/calls/recording/1/2611?vm=1"'));
    assert.ok(!vmTwiml26c.includes('<Dial'), 'voicemail branch never dials');
    assert.ok(vmTwimlBare26c.includes('<Say>Thanks for calling. We\'re sorry we missed your call.'), 'nameless fallback');
  });
  const answeredTwiml26c = sm26c.buildCallTrackingVoiceTwiml(sm26c.getCallTrackingConfig(db, 2611), {
    workspaceId: 1,
    leadId: 2611,
    baseUrl: 'https://example.test',
  });
  check('batch26c twiml: answered-call voice TwiML is unchanged (dial, no greeting, no Record)', () => {
    assert.ok(answeredTwiml26c.includes('<Dial callerId="+16105550199"'));
    assert.ok(answeredTwiml26c.includes('>+16105550100</Dial>'));
    assert.ok(!answeredTwiml26c.includes('missed your call'));
    assert.ok(!answeredTwiml26c.includes('<Record'));
  });

  // Voicemail notify behind the REAL billing path (stub credits/plan/
  // STT, mirroring the batch21 billing rig) + a recording mailer.
  const vmCredit26c = { balance: 5, spends: [] };
  let vmPlan26c = 'standard';
  let vmSttCalls26c = 0;
  const vmBilling26c = load('server/callBilling.js', {
    './domain': { withDb: (_ws, fn) => fn(db) },
    './siteModules': sm26c,
    './credits': {
      getBalance: async () => vmCredit26c.balance,
      spend: async (ws, amount, meta) => {
        if (vmCredit26c.balance < amount) {
          const e = new Error('Not enough credits');
          e.code = 'INSUFFICIENT_CREDITS';
          throw e;
        }
        vmCredit26c.balance -= amount;
        vmCredit26c.spends.push({ amount, ...meta });
        return { balance: vmCredit26c.balance };
      },
    },
    './billing': { effectivePlan: async () => vmPlan26c },
    './twilioClient': {
      transcribeRecording: async () => {
        vmSttCalls26c += 1;
        return { ok: true, text: 'Hi, this is Pat — my sink is leaking, please call me back.' };
      },
    },
  });
  const vmMails26c = [];
  const vmMailer26c = {
    sendPlatformMail: async (msg) => {
      vmMails26c.push(msg);
      return { sent: true };
    },
  };
  const vmCallNotify26c = load('server/callNotify.js', {
    './domain': { withDb: (_ws, fn) => fn(db) },
    './siteModules': sm26c,
    './mailer': vmMailer26c,
    './stripeClient': { appUrl: () => 'https://example.test' },
  });
  const voicemailNotify26c = load('server/voicemailNotify.js', {
    './domain': { withDb: (_ws, fn) => fn(db) },
    './siteModules': sm26c,
    './mailer': vmMailer26c,
    './callBilling': vmBilling26c,
    './callNotify': { resolveNotifyRecipient: vmCallNotify26c.resolveNotifyRecipient },
    './stripeClient': { appUrl: () => 'https://example.test' },
  });

  // Route level: voice → missed Dial action → greeting; recording
  // callback (signed over the FULL url incl. ?vm=1) → store + email.
  const handlers26c = { get: {}, post: {} };
  const fakeRouter26c = {
    get: (p, ...h) => {
      handlers26c.get[p] = h[h.length - 1];
    },
    post: (p, ...h) => {
      handlers26c.post[p] = h[h.length - 1];
    },
    use: () => {},
  };
  const missedCallAlerts26c = [];
  load('server/routes/calls.js', {
    express: { Router: () => fakeRouter26c },
    '../domain': { withDb: (_ws, fn) => fn(db) },
    '../workspaceExists': { assertWorkspaceExists: (id) => Number(id) === 1 },
    '../siteModules': sm26c,
    '../portalContacts': contacts,
    '../twilioClient': {
      getCredentials: async () => ({ accountSid: 'ACtest26c', authToken: 'tok26c' }),
      validateSignature: realTwilio21.validateSignature,
      transcribeRecording: async () => ({ ok: false, reason: 'no_stt_key' }),
      fetchRecordingMedia: async () => ({ configured: false }),
    },
    '../clientPortal': { findById: () => null },
    '../workspace': { getMembership: () => null, findWorkspaceByToken: () => null },
    '../callNotify': {
      notifyCallByEmail: async (ws, leadId, callSid) => {
        missedCallAlerts26c.push(callSid);
        return { sent: true };
      },
    },
    '../voicemailNotify': voicemailNotify26c,
    '../callBilling': {
      settleCallBilling: async () => ({ settled: true }),
      transcribeCallRecording: async () => ({ ok: false, reason: 'route_stub' }),
    },
    '../stripeClient': { appUrl: () => 'https://example.test' },
    '../rateLimit': { rateLimit: () => ((_req, _res, next) => next()) },
  });
  function fakeRes26c() {
    return {
      statusCode: 200,
      body: null,
      status(c) {
        this.statusCode = c;
        return this;
      },
      set() {
        return this;
      },
      type() {
        return this;
      },
      send(b) {
        this.body = b;
        return this;
      },
    };
  }
  const callRoute26c = async (kind, leadId, body, query) => {
    const pathQ = query ? `?${query}` : '';
    const p = `/api/v1/calls/${kind}/1/${leadId}${pathQ}`;
    const r = fakeRes26c();
    await handlers26c.post[`/${kind}/:workspaceId/:leadId`](
      {
        params: { workspaceId: '1', leadId: String(leadId) },
        body,
        query: query ? Object.fromEntries(new URLSearchParams(query)) : {},
        headers: { 'x-twilio-signature': signFor21('https://example.test' + p, body, 'tok26c') },
        originalUrl: p,
      },
      r
    );
    return r;
  };
  const waitFor26c = async (fn, ms = 800) => {
    const start = Date.now();
    while (Date.now() - start < ms) {
      if (fn()) return true;
      await new Promise((r) => setTimeout(r, 10));
    }
    return fn();
  };

  const vmVoiceRes26c = await callRoute26c('voice', 2611, {
    CallSid: 'CAVM26C',
    From: '+16105557777',
    To: '+16105550199',
  });
  check('batch26c route: inbound voice webhook still returns the forwarding Dial (no voicemail yet)', () => {
    assert.equal(vmVoiceRes26c.statusCode, 200);
    assert.ok(String(vmVoiceRes26c.body).includes('<Dial'));
    assert.ok(!String(vmVoiceRes26c.body).includes('missed your call'));
  });
  const vmDialRes26c = await callRoute26c('status', 2611, {
    CallSid: 'CAVM26C',
    From: '+16105557777',
    To: '+16105550199',
    CallStatus: 'in-progress',
    DialCallStatus: 'no-answer',
    DialCallDuration: '0',
  });
  check('batch26c route: unanswered Dial action returns the greeting + Record TwiML', () => {
    assert.equal(vmDialRes26c.statusCode, 200);
    const body = String(vmDialRes26c.body);
    assert.ok(body.includes('<Say>Thanks for calling Fixture Voicemail Biz.'));
    assert.ok(body.includes('<Record'));
    assert.ok(body.includes('recording/1/2611?vm=1'));
    const row = sm26c.getCallLogBySid(db, 'CAVM26C');
    assert.equal(row.status, 'no-answer');
    assert.equal(row.is_voicemail, 0, 'not a voicemail until a message is actually left');
    assert.equal(missedCallAlerts26c.length, 1, 'the missed-call alert still fires as before');
  });
  const vmRecParams26c = {
    CallSid: 'CAVM26C',
    RecordingSid: 'REvm26c',
    RecordingUrl: 'https://api.twilio.com/rec/REvm26c',
    RecordingDuration: '14',
    RecordingStatus: 'completed',
  };
  const vmRecRes26c = await callRoute26c('recording', 2611, vmRecParams26c, 'vm=1');
  await waitFor26c(() => vmMails26c.length >= 1);
  check('batch26c route: vm recording is stored flagged, transcribed per credit rules, emailed once with transcript', () => {
    assert.equal(vmRecRes26c.statusCode, 200, 'signed ?vm=1 callback must validate (full-url signature)');
    const row = sm26c.getCallLogBySid(db, 'CAVM26C');
    assert.equal(row.is_voicemail, 1);
    assert.equal(row.recording_url, 'https://api.twilio.com/rec/REvm26c');
    assert.equal(row.recording_duration, 14);
    assert.equal(row.transcript_status, 'done');
    assert.equal(row.transcription_billed, 1);
    assert.equal(row.voicemail_notify_status, 'sent');
    const spends = vmCredit26c.spends.filter((x) => x.reason === 'Call transcription');
    assert.equal(spends.length, 1, 'exactly one transcription credit');
    assert.equal(spends[0].refId, 'CAVM26C');
    assert.equal(vmMails26c.length, 1, 'exactly one voicemail email');
    const msg = vmMails26c[0];
    assert.equal(msg.to, 'vm-alerts@example.invalid');
    assert.equal(msg.subject, 'New voicemail from +16105557777');
    const text = (msg.paragraphs || []).join('\n') + '\n' + (msg.text || '');
    assert.ok(text.includes('my sink is leaking'), 'email carries the transcript');
    assert.ok(
      text.includes('https://example.test/api/v1/calls/recording-file/1/CAVM26C'),
      'email links the authenticated playback route'
    );
    assert.ok(!text.includes('api.twilio.com/rec'), 'raw Twilio media URL never emailed');
  });
  // The <Record> action post AND the status callback both land in real
  // life — a second identical callback must not re-email or re-bill.
  const vmRecRes2_26c = await callRoute26c('recording', 2611, vmRecParams26c, 'vm=1');
  await new Promise((r) => setTimeout(r, 60));
  check('batch26c route: a duplicate vm recording callback sends nothing twice', () => {
    assert.equal(vmRecRes2_26c.statusCode, 200);
    assert.equal(vmMails26c.length, 1);
    assert.equal(vmCredit26c.spends.filter((x) => x.reason === 'Call transcription').length, 1);
    assert.equal(vmSttCalls26c, 1, 'STT ran once');
  });

  // Answered calls: Dial action completes → empty TwiML, no greeting.
  await callRoute26c('voice', 2611, { CallSid: 'CAANS26C', From: '+16105557777', To: '+16105550199' });
  const ansDialRes26c = await callRoute26c('status', 2611, {
    CallSid: 'CAANS26C',
    From: '+16105557777',
    To: '+16105550199',
    CallStatus: 'completed',
    DialCallStatus: 'completed',
    DialCallDuration: '42',
  });
  check('batch26c route: answered Dial action returns empty TwiML and the call counts as before', () => {
    assert.equal(String(ansDialRes26c.body), '<?xml version="1.0" encoding="UTF-8"?><Response/>');
    const row = sm26c.getCallLogBySid(db, 'CAANS26C');
    assert.equal(row.status, 'completed');
    assert.equal(row.counted, 1);
    assert.equal(row.is_voicemail, 0);
  });

  // Voicemail disabled: unanswered call ends exactly as it did before.
  await callRoute26c('voice', 2612, { CallSid: 'CAOFF26C', From: '+16105557777', To: '+16105550199' });
  const offDialRes26c = await callRoute26c('status', 2612, {
    CallSid: 'CAOFF26C',
    From: '+16105557777',
    To: '+16105550199',
    CallStatus: 'in-progress',
    DialCallStatus: 'busy',
    DialCallDuration: '0',
  });
  check('batch26c route: voicemail_enabled=0 → unanswered call ends with empty TwiML (no greeting)', () => {
    assert.equal(String(offDialRes26c.body), '<?xml version="1.0" encoding="UTF-8"?><Response/>');
    assert.equal(sm26c.getCallLogBySid(db, 'CAOFF26C').is_voicemail, 0);
  });

  // Zero balance: the voicemail is kept and emailed; transcript is
  // skipped by the billing path and the email says so by omission.
  sm26c.logCallInitiated(db, 2613, { callSid: 'CABROKE26C', from: '+16105558888', to: '+16105550199', verified: true });
  sm26c.upsertCallStatus(
    db,
    2613,
    { CallSid: 'CABROKE26C', From: '+16105558888', To: '+16105550199', CallStatus: 'no-answer', DialCallStatus: 'no-answer', DialCallDuration: '0' },
    { verified: true }
  );
  sm26c.storeCallRecording(db, 'CABROKE26C', {
    recordingSid: 'REbroke26c',
    recordingUrl: 'https://api.twilio.com/rec/REbroke26c',
    recordingDuration: '9',
    voicemail: true,
  });
  vmCredit26c.balance = 0;
  const sttBefore26c = vmSttCalls26c;
  const brokeNotify26c = await voicemailNotify26c.notifyVoicemailByEmail(1, 2613, 'CABROKE26C');
  vmCredit26c.balance = 5;
  check('batch26c notify: zero balance still emails the voicemail, transcript skipped, status honest', () => {
    assert.equal(brokeNotify26c.sent, true);
    const row = sm26c.getCallLogBySid(db, 'CABROKE26C');
    assert.equal(row.transcript_status, 'skipped_no_credits');
    assert.equal(row.transcript, '');
    assert.equal(row.voicemail_notify_status, 'sent');
    assert.equal(vmSttCalls26c, sttBefore26c, 'STT never attempted at zero balance');
    const msg = vmMails26c[vmMails26c.length - 1];
    assert.equal(msg.to, 'vmbroke-alerts@example.invalid');
    assert.equal(msg.subject, 'New voicemail from +16105558888');
    const text = (msg.paragraphs || []).join('\n') + '\n' + (msg.text || '');
    assert.ok(!text.includes('Transcript:'), 'no transcript block when transcription was skipped');
    assert.ok(text.includes('recording-file/1/CABROKE26C'), 'playback link still included');
  });

  // Portal payload: the voicemail shows with its flag + transcript.
  const portal26c = load('server/clientPortal.js', {
    './portalTabs': portalTabs,
    bcryptjs: { hashSync: () => 'fixture' },
    './db': {},
    './mailer': {},
    './stripeClient': { appUrl: () => 'https://example.test' },
    './workspaceDb': {},
    './domain': { withDb: (_ws, fn) => fn(db) },
    './portalContacts': contacts,
    './siteModules': sm26c,
    './shopStripe': {},
    './billing': { effectivePlan: async () => 'standard' },
    './plans': { getPlan: () => ({ entitlements: { siteModules: true, chatbot: false } }) },
  });
  const panel26c = await portal26c.listModuleItems(1, 2611, 'calltracking', 'vm@example.invalid');
  const portalSrc26c = fs.readFileSync(path.join(root, 'public/js/portal.js'), 'utf8');
  const appSrc26c = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
  const callsRouteSrc26c = fs.readFileSync(path.join(root, 'server/routes/calls.js'), 'utf8');
  check('batch26c portal: call list marks the voicemail and carries its transcript; admin owns the toggle', () => {
    const vmCall = (panel26c.calltracking.calls || []).find((c) => c.call_sid === 'CAVM26C');
    assert.ok(vmCall, 'voicemail call present in the portal list');
    assert.equal(vmCall.is_voicemail, 1);
    assert.ok(vmCall.transcript.includes('sink is leaking'), 'transcript rides the portal payload');
    assert.ok(portalSrc26c.includes('c.is_voicemail'), 'portal renders a voicemail marker from the flag');
    assert.ok(portalSrc26c.includes('>Voicemail</span>'), 'marker label present');
    assert.ok(appSrc26c.includes('cl-cfg-voicemail'), 'admin forwarding form carries the voicemail toggle');
    assert.ok(appSrc26c.includes('voicemail_enabled: on(\'cl-cfg-voicemail\')'), 'admin save sends the toggle');
    assert.ok(callsRouteSrc26c.includes("req.query"), 'recording route reads the vm marker');
  });

  // --- Twilio number pool + rotating numbers (Batch 26d) ---------------
  // Ely (2026-10-26): staff register purchased Twilio numbers in a pool;
  // each Forwarding setup may check "Rotate numbers" and claim up to 5
  // pool numbers that rotate on the site's call button — all forwarding
  // to the setup's one destination. A pool number serves ONE setup.
  const sm26d = load('server/siteModules.js', {
    '../src/pageContentScan': require(path.join(root, 'src/pageContentScan.js')),
    '../src/websiteEngine': require(path.join(root, 'src/websiteEngine.js')),
    './portalContacts': contacts,
    '../src/secretBox': require(path.join(root, 'src/secretBox.js')),
    './membershipStripe': {},
    './shopStripe': {},
  });
  sm26d.ensureTables(db);
  db.prepare("INSERT INTO leads (id, business_name, email, phone) VALUES (2651, 'Fixture Rotate Alpha', 'rota@example.invalid', '+16105550111')").run();
  db.prepare("INSERT INTO leads (id, business_name, email, phone) VALUES (2652, 'Fixture Rotate Beta', 'rotb@example.invalid', '')").run();
  db.prepare("INSERT INTO leads (id, business_name, email, phone) VALUES (2653, 'Fixture Rotate Gamma', 'rotg@example.invalid', '+16105550111')").run();
  db.prepare("INSERT INTO site_module_embeds (lead_id, module_type, public_token, published) VALUES (2651, 'calltracking', 'tok26d2651', 1)").run();
  db.prepare("INSERT INTO site_module_embeds (lead_id, module_type, public_token, published) VALUES (2652, 'calltracking', 'tok26d2652', 1)").run();
  const ownedPool26d = ['+16105550101', '+16105550102', '+16105550103', '+16105550104', '+16105550105', '+16105550106', '+16105550107'].map(
    (phoneNumber, i) => ({ phoneNumber, sid: `PNpool0${i + 1}`, friendlyName: phoneNumber, voiceUrl: '' })
  );
  const voiceUrlCalls26d = [];
  let poolConfigured26d = true;
  let voiceUrlFailSid26d = '';
  const domain26d = load('server/domain.js', {
    './workspaceDb': { openWorkspaceDb: () => db, acquireWorkspaceDb: () => db, releaseWorkspaceDb: () => {}, leaseCount: () => 1 },
    './billing': { effectivePlan: async () => 'standard' },
    './twilioClient': {
      searchNumbers: async () => ({ configured: false, numbers: [] }),
      purchaseNumber: async () => ({ configured: false }),
      listOwnedNumbers: async () =>
        poolConfigured26d ? { configured: true, numbers: ownedPool26d } : { configured: false, numbers: [] },
      setNumberVoiceUrl: async (args) => {
        voiceUrlCalls26d.push(args);
        if (args.sid === voiceUrlFailSid26d) {
          const e = new Error('Twilio rejected the webhook update');
          e.code = 'TWILIO_ERROR';
          throw e;
        }
        return { configured: true, phoneNumber: '', sid: args.sid, voiceUrl: args.voiceUrl };
      },
    },
    './stripeClient': { appUrl: () => 'https://example.test' },
    './siteModules': sm26d,
  });

  const poolAdd1 = await domain26d.adminAddPoolNumber(1, { phoneNumber: '6105550101', label: 'Alpha main' });
  let foreignErr26d = null;
  try {
    await domain26d.adminAddPoolNumber(1, { phoneNumber: '+442071234567' });
  } catch (e) {
    foreignErr26d = e;
  }
  let garbageErr26d = null;
  try {
    await domain26d.adminAddPoolNumber(1, { phoneNumber: 'call-me-maybe' });
  } catch (e) {
    garbageErr26d = e;
  }
  const poolAddDup = await domain26d.adminAddPoolNumber(1, { phoneNumber: '+16105550101' });
  poolConfigured26d = false;
  const poolAddOff = await domain26d.adminAddPoolNumber(1, { phoneNumber: '+16105550102' });
  poolConfigured26d = true;
  check('batch26d pool add: ownership verified live, E.164 enforced, foreign + garbage rejected, duplicate idempotent', () => {
    assert.equal(poolAdd1.configured, true);
    assert.equal(poolAdd1.number.phone_number, '+16105550101', 'US 10-digit input normalized to E.164');
    assert.equal(poolAdd1.number.twilio_sid, 'PNpool01', 'SID stored from the account listing');
    assert.equal(poolAdd1.number.label, 'Alpha main');
    assert.equal(foreignErr26d && foreignErr26d.code, 'NOT_OWNED', 'a number the account does not own is rejected');
    assert.ok(String(foreignErr26d.message).includes('not on the connected Twilio account'));
    assert.equal(garbageErr26d && garbageErr26d.code, 'VALIDATION');
    assert.equal(poolAddDup.number.already_present, true, 're-adding is a no-op');
    assert.equal(poolAddOff.configured, false, 'no credentials → dormant, nothing written');
    assert.equal(sm26d.listTwilioNumberPool(db, 1).length, 1, 'only the verified number landed');
  });
  for (const n of ['+16105550102', '+16105550103', '+16105550104', '+16105550105', '+16105550106', '+16105550107']) {
    sm26d.addTwilioNumberToPool(db, 1, { phoneNumber: n, twilioSid: `PNpool0${n.slice(-1)}` });
  }
  check('batch26d pool list: every number starts unassigned', () => {
    const pool = sm26d.listTwilioNumberPool(db, 1);
    assert.equal(pool.length, 7);
    assert.ok(pool.every((p) => p.assignment === null));
  });

  const alphaSave26d = await domain26d.adminSaveCallTrackingConfig(1, {
    leadId: 2651,
    display_number: '+16105550101',
    redirect_number: '+16105550100',
    rotate_enabled: true,
    rotation_numbers: ['+16105550102', '+16105550103'],
  });
  check('batch26d rotation save: set persists, flag on, newly assigned numbers get the lead voice webhook', () => {
    assert.equal(alphaSave26d.config.rotate_enabled, true);
    assert.deepEqual(alphaSave26d.config.rotation_numbers, ['+16105550102', '+16105550103']);
    assert.equal(alphaSave26d.config.display_number, '+16105550101');
    const hooked = voiceUrlCalls26d.map((c) => c.sid).sort();
    assert.deepEqual(hooked, ['PNpool01', 'PNpool02', 'PNpool03'], 'primary + both rotation members pointed at Twilio');
    assert.ok(voiceUrlCalls26d.every((c) => c.voiceUrl === 'https://example.test/api/v1/calls/voice/1/2651'));
    assert.ok(alphaSave26d.webhook_results.every((w) => w.ok), 'all webhook updates reported ok');
    const pool = sm26d.listTwilioNumberPool(db, 1);
    assert.equal(pool.find((p) => p.phone_number === '+16105550101').assignment.role, 'primary');
    assert.equal(pool.find((p) => p.phone_number === '+16105550102').assignment.lead_name, 'Fixture Rotate Alpha');
  });

  let rotStealErr26d = null;
  try {
    await domain26d.adminSaveCallTrackingConfig(1, { leadId: 2652, rotate_enabled: true, rotation_numbers: ['+16105550102'] });
  } catch (e) {
    rotStealErr26d = e;
  }
  let primStealErr26d = null;
  try {
    await domain26d.adminSaveCallTrackingConfig(1, { leadId: 2652, display_number: '+16105550103' });
  } catch (e) {
    primStealErr26d = e;
  }
  let primSteal2Err26d = null;
  try {
    await domain26d.adminSaveCallTrackingConfig(1, { leadId: 2652, display_number: '+16105550101' });
  } catch (e) {
    primSteal2Err26d = e;
  }
  check('batch26d exclusivity: a pool number serves one setup — rotation member or primary, claims fail naming the owner', () => {
    assert.equal(rotStealErr26d && rotStealErr26d.code, 'NUMBER_IN_USE');
    assert.ok(String(rotStealErr26d.message).includes('Fixture Rotate Alpha'), 'rotation claim names the owning business');
    assert.equal(primStealErr26d && primStealErr26d.code, 'NUMBER_IN_USE');
    assert.ok(String(primStealErr26d.message).includes('Fixture Rotate Alpha'), 'claiming a rotation member as a primary names the owner');
    assert.equal(primSteal2Err26d && primSteal2Err26d.code, 'NUMBER_IN_USE', 'claiming another setup’s primary fails too');
    assert.deepEqual(sm26d.getCallTrackingConfig(db, 2652).rotation_numbers, [], 'failed saves wrote nothing');
    assert.equal(sm26d.getCallTrackingConfig(db, 2652).display_number, '', 'failed primary claims wrote nothing');
  });

  let tooManyErr26d = null;
  try {
    await domain26d.adminSaveCallTrackingConfig(1, {
      leadId: 2653,
      rotate_enabled: true,
      rotation_numbers: ['+16105550101', '+16105550102', '+16105550103', '+16105550104', '+16105550105', '+16105550106'],
    });
  } catch (e) {
    tooManyErr26d = e;
  }
  let nonPoolErr26d = null;
  try {
    await domain26d.adminSaveCallTrackingConfig(1, { leadId: 2653, rotate_enabled: true, rotation_numbers: ['+16105550999'] });
  } catch (e) {
    nonPoolErr26d = e;
  }
  check('batch26d rotation limits: more than 5 rejected, non-pool members rejected', () => {
    assert.equal(tooManyErr26d && tooManyErr26d.code, 'VALIDATION');
    assert.ok(String(tooManyErr26d.message).includes('5'), 'cap message states the limit');
    assert.equal(nonPoolErr26d && nonPoolErr26d.code, 'VALIDATION');
    assert.ok(String(nonPoolErr26d.message).includes('pool'), 'non-pool message points at the pool');
    assert.deepEqual(sm26d.getCallTrackingConfig(db, 2653).rotation_numbers, [], 'rejected sets wrote nothing');
  });

  const seenRot26d = [];
  for (let i = 0; i < 4; i += 1) seenRot26d.push(sm26d.publicCallTrackingPayload(db, 2651));
  const cfgAlpha26d = sm26d.getCallTrackingConfig(db, 2651);
  const twimlAlpha26d = sm26d.buildCallTrackingVoiceTwiml(cfgAlpha26d, {
    workspaceId: 1,
    leadId: 2651,
    baseUrl: 'https://example.test',
  });
  sm26d.logCallInitiated(db, 2651, { callSid: 'CAROT26D', from: '+16105557777', to: '+16105550103', verified: true });
  check('batch26d rendering: button rotates round-robin through set members only; every member forwards to the one destination', () => {
    assert.deepEqual(
      seenRot26d.map((p) => p.display_number),
      ['+16105550102', '+16105550103', '+16105550102', '+16105550103'],
      'round-robin across page loads, members only'
    );
    assert.ok(seenRot26d.every((p) => p.tracking_number === p.display_number));
    assert.equal(seenRot26d[0].display_number_formatted, '(610) 555-0102');
    for (const p of seenRot26d) {
      assert.ok(!JSON.stringify(p).includes('5550100'), 'payload never leaks the forward-to destination');
    }
    assert.ok(twimlAlpha26d.includes('<Dial callerId="+16105550101"'), 'voice route still presents the tracking identity');
    assert.ok(twimlAlpha26d.includes('>+16105550100</Dial>'), 'dial target is the setup’s single redirect');
    const logged = sm26d.getCallLogBySid(db, 'CAROT26D');
    assert.equal(logged.lead_id, 2651, 'call to a rotation number logs under the setup’s lead');
    assert.equal(logged.to_number, '+16105550103', 'the dialed member is preserved as to_number');
  });

  sm26d.updateCallTrackingConfig(db, 2652, { display_number: '+16105550107' });
  sm26d.setCallTrackingRotation(db, 2652, {
    rotateEnabled: false,
    numbers: ['+16105550104'],
    primaryNumber: '+16105550107',
    workspaceId: 1,
  });
  const offPayload1 = sm26d.publicCallTrackingPayload(db, 2652);
  const offPayload2 = sm26d.publicCallTrackingPayload(db, 2652);
  sm26d.setCallTrackingRotation(db, 2653, { rotateEnabled: true, numbers: [], primaryNumber: '', workspaceId: 1 });
  const emptySetPayload = sm26d.publicCallTrackingPayload(db, 2653);
  check('batch26d rotate off / empty set: exactly the single-number behavior', () => {
    assert.equal(offPayload1.display_number, '+16105550107', 'rotate off shows the primary, not the stored set');
    assert.equal(offPayload2.display_number, '+16105550107', 'no rotation while off');
    assert.equal(emptySetPayload.display_number, '+16105550111', 'rotate on with an empty set falls back as before (client number pre-assignment)');
    assert.equal(emptySetPayload.tracking_number, '');
  });

  let assignedRemoveErr26d = null;
  try {
    sm26d.removeTwilioNumberFromPool(db, 1, { phoneNumber: '+16105550102' });
  } catch (e) {
    assignedRemoveErr26d = e;
  }
  await domain26d.adminSaveCallTrackingConfig(1, {
    leadId: 2651,
    rotate_enabled: true,
    rotation_numbers: ['+16105550103'],
  });
  const betaClaim26d = await domain26d.adminSaveCallTrackingConfig(1, {
    leadId: 2652,
    rotate_enabled: true,
    rotation_numbers: ['+16105550104', '+16105550102'],
  });
  const removedFree26d = sm26d.removeTwilioNumberFromPool(db, 1, { phoneNumber: '+16105550106' });
  check('batch26d freeing: shrinking a set releases its numbers for another setup; pool removal blocked only while assigned', () => {
    assert.equal(assignedRemoveErr26d && assignedRemoveErr26d.code, 'NUMBER_ASSIGNED');
    assert.ok(String(assignedRemoveErr26d.message).includes('Fixture Rotate Alpha'), 'blocked removal names the business');
    assert.deepEqual(betaClaim26d.config.rotation_numbers, ['+16105550104', '+16105550102'], 'freed member claimable by the next setup');
    assert.equal(removedFree26d.removed, true);
    assert.ok(!sm26d.listTwilioNumberPool(db, 1).some((p) => p.phone_number === '+16105550106'));
  });

  voiceUrlFailSid26d = 'PNpool05';
  const gammaSave26d = await domain26d.adminSaveCallTrackingConfig(1, {
    leadId: 2653,
    rotate_enabled: true,
    rotation_numbers: ['+16105550105'],
  });
  voiceUrlFailSid26d = '';
  check('batch26d webhook failure: assignment saves, failure is reported per number, never fatal', () => {
    assert.deepEqual(gammaSave26d.config.rotation_numbers, ['+16105550105'], 'assignment persisted despite the Twilio failure');
    const wr = gammaSave26d.webhook_results.find((w) => w.phone_number === '+16105550105');
    assert.ok(wr, 'webhook result reported for the newly assigned number');
    assert.equal(wr.ok, false);
    assert.ok(String(wr.error).includes('Twilio'));
  });

  const overview26d = await domain26d.adminCallsOverview(1);
  const appSrc26d = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
  const apiSrc26d = fs.readFileSync(path.join(root, 'public/js/api.js'), 'utf8');
  const domainApiSrc26d = fs.readFileSync(path.join(root, 'server/routes/domainApi.js'), 'utf8');
  const portalSrc26d = fs.readFileSync(path.join(root, 'public/js/portal.js'), 'utf8');
  check('batch26d overview + wiring: businesses carry rotation, overview carries the pool, portal untouched', () => {
    const biz = overview26d.businesses.find((b) => Number(b.lead_id) === 2651);
    assert.ok(biz, 'business listed');
    assert.equal(biz.config.rotate_enabled, true);
    assert.deepEqual(biz.config.rotation_numbers, ['+16105550103']);
    assert.ok(Array.isArray(overview26d.pool) && overview26d.pool.length >= 6, 'pool rides the overview');
    assert.ok(appSrc26d.includes('cl-cfg-rotate'), 'admin form carries the Rotate checkbox');
    assert.ok(appSrc26d.includes('cl-pool-add'), 'pool add form wired');
    assert.ok(appSrc26d.includes('adminCallPoolAdd'), 'pool add uses the api helper');
    assert.ok(appSrc26d.includes('rotation_numbers'), 'admin save sends the set');
    assert.ok(!appSrc26d.includes('it shows on their site as the call button'), 'stale display copy removed');
    assert.ok(appSrc26d.includes('never appears on their site'), 'corrected display copy present');
    assert.ok(apiSrc26d.includes("adminCallPoolAdd: (body) => post('/admin-area/calls/pool', body)"), 'api helper wired');
    assert.ok(domainApiSrc26d.includes("'/admin-area/calls/pool'"), 'pool routes registered');
    assert.ok(!portalSrc26d.includes('rotation_numbers') && !portalSrc26d.includes('cl-cfg-rotate'), 'portal never sees rotation config');
  });

  // ── Batch 27: soft deletes — archive + restore for websites ──
  const eng27 = require(path.join(root, 'src/websiteEngine.js'));
  eng27.ensureTables(db);
  check('batch27 schema: websites.archived_at column exists (additive migration)', () => {
    const cols = db.prepare('PRAGMA table_info(websites)').all().map((c) => c.name);
    assert.ok(cols.includes('archived_at'), 'archived_at present');
  });
  db.prepare("INSERT INTO leads (id, business_name, email) VALUES (2701, 'Fixture Archive Alpha', 'arch27@example.invalid')").run();
  const pages27 = JSON.stringify([{ slug: 'index', title: 'Home', sections: [{ type: 'hero', content: { heading: 'Archive Fixture' } }] }]);
  const siteId27 = Number(
    db.prepare('INSERT INTO websites (lead_id, name, theme, pages, status) VALUES (2701, ?, ?, ?, ?)').run(
      'Fixture Archive Site',
      '{}',
      pages27,
      'approved'
    ).lastInsertRowid
  );
  db.prepare('INSERT INTO website_versions (website_id, version_no, pages, theme, note) VALUES (?, 1, ?, ?, ?)').run(siteId27, pages27, '{}', 'v1 fixture');
  db.prepare("INSERT INTO design_jobs (type, title, instructions, lead_id, status, website_id) VALUES ('website', 'Fixture Archive Job', 'Build the fixture site.', 2701, 'delivered', ?)").run(siteId27);
  const exportDir27 = path.join(require(path.join(root, 'src/openPreview.js')).exportRoot(), `site-${siteId27}`);
  fs.mkdirSync(exportDir27, { recursive: true });
  fs.writeFileSync(path.join(exportDir27, 'sentinel.txt'), 'batch27');
  const del27 = eng27.deleteWebsite(db, siteId27);
  check('batch27 archive: delete stamps archived_at and preserves row, versions, design jobs and the export folder', () => {
    assert.equal(del27.archived, true);
    assert.equal(del27.alreadyArchived, false);
    assert.ok(!('removedFolders' in del27), 'soft delete reports no removed folders');
    const row = db.prepare('SELECT * FROM websites WHERE id = ?').get(siteId27);
    assert.ok(row, 'website row still present');
    assert.ok(row.archived_at, 'archived_at is set');
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM website_versions WHERE website_id = ?').get(siteId27).c, 1, 'versions preserved');
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM design_jobs WHERE website_id = ?').get(siteId27).c, 1, 'design jobs preserved (not unlinked)');
    assert.ok(fs.existsSync(path.join(exportDir27, 'sentinel.txt')), 'export folder untouched');
  });
  const domain27 = load('server/domain.js', {
    './workspaceDb': { openWorkspaceDb: () => db, acquireWorkspaceDb: () => db, releaseWorkspaceDb: () => {}, leaseCount: () => 1 },
    '../src/paginate': require(path.join(root, 'src/paginate.js')),
    '../src/websiteEngine': eng27,
    '../src/secretBox': require(path.join(root, 'src/secretBox.js')),
    './portalContacts': contacts,
    './billing': { effectivePlan: async () => 'standard' },
    './stripeClient': { appUrl: () => 'https://example.test' },
    './siteModules': {},
  });
  const listLive27 = domain27.sitesList(1, {});
  const listArchivedOnly27 = domain27.sitesList(1, { archivedOnly: true });
  const archives27 = domain27.sitesArchivedList(1);
  check('batch27 lists: archived site excluded from the normal list, present in archivedOnly + archives list', () => {
    assert.ok(!listLive27.sites.some((s) => Number(s.id) === siteId27), 'hidden from live list');
    assert.ok(listArchivedOnly27.sites.some((s) => Number(s.id) === siteId27), 'archivedOnly shows it');
    const arch = archives27.sites.find((s) => Number(s.id) === siteId27);
    assert.ok(arch, 'archives listing returns the site');
    assert.equal(arch.business_name, 'Fixture Archive Alpha');
    assert.ok(arch.archived_at, 'archives listing carries the archived date');
  });
  check('batch27 portal + forLead: archived site resolves as no site', () => {
    assert.equal(domain27.sitesForLead(1, 2701).site, null, 'sitesForLead hides archived');
    assert.ok(!portal.loadLeadContext(1, 2701).site, 'portal lead context hides archived');
  });
  let exportErr27 = null;
  try {
    await domain27.sitesExport(1, siteId27);
  } catch (e) {
    exportErr27 = e;
  }
  check('batch27 public routes: export of an archived site is refused (SITE_ARCHIVED)', () => {
    assert.ok(exportErr27, 'sitesExport threw');
    assert.equal(exportErr27.code, 'SITE_ARCHIVED');
  });
  const delAgain27 = eng27.deleteWebsite(db, siteId27);
  check('batch27 idempotency: deleting an already-archived site is a no-op that stays archived', () => {
    assert.equal(delAgain27.archived, true);
    assert.equal(delAgain27.alreadyArchived, true);
    assert.ok(db.prepare('SELECT archived_at FROM websites WHERE id = ?').get(siteId27).archived_at);
  });
  const restore27 = eng27.restoreWebsite(db, siteId27);
  check('batch27 restore: clears the flag; site reappears in the normal list + portal with pages intact', () => {
    assert.equal(restore27.restored, true);
    const row = db.prepare('SELECT * FROM websites WHERE id = ?').get(siteId27);
    assert.equal(row.archived_at, null);
    assert.equal(row.pages, pages27, 'pages exactly as before');
    assert.equal(row.status, 'approved', 'pre-archive publish state kept');
    assert.ok(domain27.sitesList(1, {}).sites.some((s) => Number(s.id) === siteId27), 'back in live list');
    assert.ok(!domain27.sitesArchivedList(1).sites.some((s) => Number(s.id) === siteId27), 'gone from archives');
    assert.ok(portal.loadLeadContext(1, 2701).site, 'portal sees the site again');
    assert.equal(domain27.sitesForLead(1, 2701).site.id, siteId27, 'sitesForLead resolves again');
  });
  const restoreAgain27 = eng27.restoreWebsite(db, siteId27);
  check('batch27 idempotency: restoring a non-archived site is a no-op', () => {
    assert.equal(restoreAgain27.restored, false);
    assert.equal(db.prepare('SELECT archived_at FROM websites WHERE id = ?').get(siteId27).archived_at, null);
  });
  db.prepare("INSERT INTO leads (id, business_name, email) VALUES (2702, 'Fixture Destroy Beta', 'dest27@example.invalid')").run();
  const siteId27b = Number(
    db.prepare('INSERT INTO websites (lead_id, name, theme, pages, status) VALUES (2702, ?, ?, ?, ?)').run('Fixture Destroy Site', '{}', pages27, 'draft').lastInsertRowid
  );
  eng27.destroyWebsite(db, siteId27b);
  check('batch27 internal destroy path still permanently removes a site (generate-rebuild cleanup)', () => {
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM websites WHERE id = ?').get(siteId27b).c, 0);
    assert.throws(() => eng27.getWebsite(db, siteId27b), (e) => e.code === 'SITE_NOT_FOUND');
  });
  fs.rmSync(exportDir27, { recursive: true, force: true });
  check('batch27 wiring: staff Archives page, REST routes, preview guard and MCP tools are connected', () => {
    const appSrc = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
    const apiSrc = fs.readFileSync(path.join(root, 'public/js/api.js'), 'utf8');
    const indexHtml = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
    const domainApiSrc = fs.readFileSync(path.join(root, 'server/routes/domainApi.js'), 'utf8');
    const serverSrc = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
    const mcpSrc = fs.readFileSync(path.join(root, 'server/mcp.js'), 'utf8');
    const paritySrc = fs.readFileSync(path.join(root, 'src/mcpParityTools.js'), 'utf8');
    assert.ok(appSrc.includes('pageArchives'), 'staff app has the Archives page');
    assert.ok(appSrc.includes('websiteUnarchive'), 'Archives page restores via the api helper');
    assert.ok(apiSrc.includes("websitesArchived: () => get('/websites/archives')"), 'api helper for archives list');
    assert.ok(apiSrc.includes("websiteUnarchive: (id) => post('/websites/' + id + '/restore', {})"), 'api helper for restore');
    assert.ok(indexHtml.includes('#/archives'), 'nav links to Archives');
    assert.ok(domainApiSrc.includes("'/websites/archives'"), 'archives route registered');
    assert.ok(domainApiSrc.includes("'/websites/:id/restore'"), 'restore route registered');
    assert.ok(serverSrc.includes('blockArchivedPreviews'), 'public preview mount blocks archived sites');
    assert.ok(mcpSrc.includes("'website.unarchive'") || mcpSrc.includes('website.unarchive'), 'hosted MCP exposes unarchive');
    assert.ok(paritySrc.includes("'website.listArchived'"), 'parity MCP exposes the archives list');
  });

  // ---- Review fix 1 (CRITICAL verification): shadow staff account ----
  // The 2026-10-27 code review claimed a seeded staff user
  // (support@bitpype.com) with a default-password fallback
  // (process.env.ADMIN_PASSWORD || 'bitpype-staff') in "server/auth.js".
  // Verified ABSENT: no such file, strings, or fallback anywhere in the
  // tree or git history, and no such user row in production data
  // (existence-only query: 0 'support' users, 1 super admin). These
  // checks pin the safe state so it cannot silently regress.
  check('review1 no default-credential staff seed or password fallback exists in server code', () => {
    const scanDirs = ['server', 'server/routes'];
    const files = [path.join(root, 'server.js')];
    for (const d of scanDirs) {
      for (const f of fs.readdirSync(path.join(root, d))) {
        if (f.endsWith('.js')) files.push(path.join(root, d, f));
      }
    }
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      assert.ok(!src.includes('bitpype-staff'), `${f} must not contain a default staff password`);
      assert.ok(!src.includes('support@bitpype'), `${f} must not seed a built-in staff identity`);
      assert.ok(!src.includes('ADMIN_PASSWORD'), `${f} must not reference an admin password env fallback`);
      // No literal fallback on any password env. Sole documented exception:
      // server/db.js's MYSQL_PASSWORD dev default (DB-connection convenience,
      // not an auth credential — held as a judgment call in the fix report).
      for (const m of src.matchAll(/process\.env\.([A-Z_]*PASSWORD[A-Z_]*)\s*\|\|/g)) {
        assert.ok(f.endsWith('server/db.js') && m[1] === 'MYSQL_PASSWORD', `${f} must not fall back from password env ${m[1]} to a literal`);
      }
    }
  });
  check('review1 bootstrap owner creation is opt-in: requires BOTH bootstrap email and password env', () => {
    const serverSrc = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
    const gate = 'process.env.BOOTSTRAP_EMAIL && process.env.BOOTSTRAP_PASSWORD';
    assert.ok(serverSrc.includes(gate), 'bootstrap block is gated on both env vars');
    assert.ok(serverSrc.indexOf(gate) < serverSrc.indexOf('createUserWithWorkspace({'), 'gate precedes any bootstrap user creation');
  });
  check('review1 login path resolves users only from the users table via bcrypt compare', () => {
    const authSrc = fs.readFileSync(path.join(root, 'server/routes/auth.js'), 'utf8');
    assert.ok(authSrc.includes('findUserByEmail(email)'), 'login looks the user up in the users table');
    assert.ok(authSrc.includes('bcrypt.compare'), 'login verifies with bcrypt against the stored hash');
    assert.ok(!/password\s*===|===\s*password/.test(authSrc.replace('password || ', '')), 'no literal password comparison in the login route');
  });
  const wsMod1 = load('server/workspace.js', {
    './db': { query: async () => [], withConnection: async () => {}, driver: 'sqlite' },
    './settingsKeys': { SETTING_SEEDS: new Map(), PROMPT_SEEDS: [] },
  });
  const seededLookup1 = await wsMod1.findUserByEmail('support@bitpype.com');
  check('review1 user lookup for the alleged seeded identity returns no user (login would 401)', () => {
    assert.equal(seededLookup1, null);
  });

  // ---- Review fix 2: archived-site form delivery ----
  // A soft-deleted (archived) site is hidden in-app, but archiving does
  // NOT tear down its published pages — the public form endpoint kept
  // accepting and delivering submissions (owner email + LeadScout
  // capture) for a site the owner deleted. Delivery must be gated on
  // the website's archived state at send time.
  const mailStateR2 = { sent: [] };
  const mailerStubR2 = {
    sendPlatformMail: async (msg) => { mailStateR2.sent.push(msg); return { sent: true }; },
  };
  const cfR2 = load('server/contactForms.js', {
    './plans': { getPlan: () => ({ id: 'free', entitlements: {} }), normalizePlanId: (v) => v || 'free' },
    './portalContacts': contacts,
    './mailer': mailerStubR2,
    './museRouter': {},
  });
  cfR2.ensureTables(db);
  for (const [id, email] of [[2750, 'r2a@example.invalid'], [2751, 'r2b@example.invalid'], [2752, 'r2c@example.invalid']]) {
    db.prepare('INSERT INTO leads (id, business_name, email) VALUES (?, ?, ?)').run(id, `Fixture R2 ${id}`, email);
  }
  const siteR2 = Number(db.prepare("INSERT INTO websites (lead_id, name, theme, pages, status) VALUES (2750, 'R2 Site', '{}', '[]', 'published')").run().lastInsertRowid);
  const mkFormR2 = (leadId, token) => {
    const info = db.prepare("INSERT INTO contact_forms (lead_id, name, title, notify_email, public_token, published) VALUES (?, 'Contact', 'Contact Us', '', ?, 1)").run(leadId, token);
    db.prepare("INSERT INTO form_fields (form_id, field_key, label, field_type, required) VALUES (?, 'message', 'Message', 'textarea', 0)").run(info.lastInsertRowid);
  };
  mkFormR2(2750, 'tok-r2-a');
  const subR2Live = await cfR2.acceptSubmission(db, { token: 'tok-r2-a', values: { message: 'while live' }, workspaceId: 1, planId: 'free' });
  check('review2 baseline: form on a live site delivers (owner emailed)', () => {
    assert.equal(subR2Live.email && subR2Live.email.sent, true);
    assert.equal(mailStateR2.sent.length, 1);
  });
  db.prepare("UPDATE websites SET archived_at = datetime('now') WHERE id = ?").run(siteR2);
  let subR2ArchivedErr = null;
  try {
    await cfR2.acceptSubmission(db, { token: 'tok-r2-a', values: { message: 'after archive' }, workspaceId: 1, planId: 'free' });
  } catch (e) { subR2ArchivedErr = e; }
  check('review2 archived site: submission is refused at send time and nothing is delivered', () => {
    assert.ok(subR2ArchivedErr, 'submission on an archived site must throw');
    assert.equal(subR2ArchivedErr.code, 'SITE_ARCHIVED');
    assert.equal(mailStateR2.sent.length, 1, 'no owner email after archiving');
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM form_submissions WHERE lead_id = 2750").get().c, 1, 'no second submission stored');
  });
  db.prepare('UPDATE websites SET archived_at = NULL WHERE id = ?').run(siteR2);
  const subR2Restored = await cfR2.acceptSubmission(db, { token: 'tok-r2-a', values: { message: 'after restore' }, workspaceId: 1, planId: 'free' });
  check('review2 restored site: submissions deliver again', () => {
    assert.equal(subR2Restored.email && subR2Restored.email.sent, true);
    assert.equal(mailStateR2.sent.length, 2);
  });
  mkFormR2(2751, 'tok-r2-b');
  const subR2NoSite = await cfR2.acceptSubmission(db, { token: 'tok-r2-b', values: { message: 'no website at all' }, workspaceId: 1, planId: 'free' });
  check('review2 lead with no website: form flow unchanged', () => {
    assert.equal(subR2NoSite.email && subR2NoSite.email.sent, true);
    assert.equal(mailStateR2.sent.length, 3);
  });
  // (Schema note: websites.lead_id is UNIQUE — one website per lead, so
  // there is no mixed live+archived state to preserve.)
  db.prepare("INSERT INTO websites (lead_id, name, theme, pages, status, archived_at) VALUES (2752, 'R2 Archived', '{}', '[]', 'published', datetime('now'))").run();
  mkFormR2(2752, 'tok-r2-c');
  let subR2OtherErr = null;
  try {
    await cfR2.acceptSubmission(db, { token: 'tok-r2-c', values: { message: 'other lead archived' }, workspaceId: 1, planId: 'free' });
  } catch (e) { subR2OtherErr = e; }
  check('review2 gate is per-lead: another lead whose only site is archived is refused too', () => {
    assert.ok(subR2OtherErr && subR2OtherErr.code === 'SITE_ARCHIVED');
    assert.equal(mailStateR2.sent.length, 3);
  });

  // ---- Review fix 3: raw encrypted-secret reads ----
  // Workspace secrets are secretBox-encrypted at rest (enc:v1:). The
  // decrypting readers (domain.getSetting, src/sms.readWorkspaceSettings,
  // outreach.readSettings) are the sanctioned paths — Batch 25b pinned
  // the SMS opt-in + Twilio credential paths. The audit found three
  // remaining raw paths that hand ciphertext (or store plaintext) for
  // SECRET_KEYS: designJobs' flat settings bag feeding the SMTP
  // provider, museAgent's workspace fallback for muse.model_api_key,
  // and admin.pushDefaultsToWorkspaces writing seed secrets unencrypted
  // into both workspace stores.
  const cryptoR3 = require('node:crypto');
  const keyR3 = cryptoR3.randomBytes(32);
  const boxR3 = {
    PREFIX: 'enc:v1:',
    isEncrypted: (v) => typeof v === 'string' && v.startsWith('enc:v1:'),
    encryptValue: (plain) => {
      if (plain == null || plain === '' || String(plain).startsWith('enc:v1:')) return plain;
      const iv = cryptoR3.randomBytes(12);
      const cipher = cryptoR3.createCipheriv('aes-256-gcm', keyR3, iv);
      const body = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
      return 'enc:v1:' + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
    },
    decryptValue: (stored) => {
      if (typeof stored !== 'string' || !stored.startsWith('enc:v1:')) return stored;
      const buf = Buffer.from(stored.slice('enc:v1:'.length), 'base64');
      const decipher = cryptoR3.createDecipheriv('aes-256-gcm', keyR3, buf.subarray(0, 12));
      decipher.setAuthTag(buf.subarray(12, 28));
      return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
    },
    // Mirrors the real secretBox: encryptSetting is SECRET_KEYS-gated.
    encryptSetting: (k, v) => (require(path.join(root, 'server/settingsKeys.js')).SECRET_KEYS.includes(k) ? boxR3.encryptValue(v) : v),
    decryptSetting: (k, v) => boxR3.decryptValue(v),
    hasKey: () => true,
  };
  // Hermetic fixture DBs: the shared suite db holds ciphertext from
  // several throwaway keys, and a bulk decrypt rightly throws on a
  // foreign key's rows — so each path gets a fresh db keyed only by boxR3.
  const freshDbR3 = () => {
    const d = new Database(':memory:');
    d.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
    d.exec('CREATE TABLE leads (id INTEGER PRIMARY KEY, business_name TEXT, email TEXT)');
    d.exec('CREATE TABLE suppression_list (email TEXT, reason TEXT)');
    d.exec('CREATE TABLE campaigns (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, status TEXT)');
    d.exec(
      'CREATE TABLE campaign_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, campaign_id INTEGER, lead_id INTEGER, to_email TEXT, subject TEXT, body TEXT, status TEXT, sent_at TEXT, error TEXT)'
    );
    return d;
  };
  const setRawR3 = (d, k, v) =>
    d.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v);

  // (a) design delivery mail must receive the DECRYPTED smtp.pass.
  const dbDjR3 = freshDbR3();
  setRawR3(dbDjR3, 'automation_paused', '0');
  setRawR3(dbDjR3, 'smtp.host', 'smtp.fixture.invalid');
  setRawR3(dbDjR3, 'smtp.from_email', 'design@fixture.invalid');
  setRawR3(dbDjR3, 'smtp.pass', boxR3.encryptSetting('smtp.pass', 'r3-smtp-plaintext'));
  dbDjR3.prepare('INSERT INTO leads (id, business_name, email) VALUES (?, ?, ?)').run(2760, 'Fixture R3 Design', 'lead-r3@example.invalid');
  let capturedBagR3 = null;
  const djR3 = load('src/designJobs.js', {
    './websiteEngine': { ensureTables: () => {} },
    './pexels': {},
    './defaultDesignInstructions': { DEFAULT_WEBSITE_DESIGN_INSTRUCTIONS: '', defaultWebsiteInstructions: () => '' },
    './secretBox': boxR3,
    './emailRedesign': { ensureTables: () => {} },
    './designLearning': { ensureTables: () => {}, attachLessonsToBrief: () => {}, refreshJobBriefLessons: () => {} },
    './email': {
      getProvider: (settings) => {
        capturedBagR3 = settings;
        return { name: 'capture', send: async () => ({}) };
      },
    },
    './mailjetSender': { assertMailjetSenderActive: async () => {} },
  });
  djR3.ensureTables(dbDjR3);
  const jobR3 = Number(
    dbDjR3.prepare("INSERT INTO design_jobs (lead_id, title, type, status, contact_email, instructions) VALUES (2760, 'R3 Site', 'website', 'waiting_on_client', 'lead-r3@example.invalid', 'Build it')").run().lastInsertRowid
  );
  dbDjR3.prepare('INSERT INTO design_questions (job_id, question, answer, internal) VALUES (?, ?, NULL, 0)').run(jobR3, 'What colors?');
  await djR3.emailQuestions(dbDjR3, jobR3, {});
  check('review3 design mail: SMTP provider receives the decrypted smtp.pass, not ciphertext', () => {
    assert.ok(capturedBagR3, 'provider was constructed');
    assert.equal(capturedBagR3['smtp.pass'], 'r3-smtp-plaintext');
  });

  // (b) museAgent workspace fallback must decrypt muse.model_api_key.
  const dbMuseR3 = freshDbR3();
  setRawR3(dbMuseR3, 'muse.model_api_key', boxR3.encryptSetting('muse.model_api_key', 'r3-muse-plaintext'));
  const museAgentR3 = load('server/museAgent.js', {
    './platform': { getPlatformSetting: async () => '' },
    '../src/defaultDesignInstructions': { defaultWebsiteInstructions: () => '' },
    '../src/secretBox': boxR3,
    // Batch 94: museAgent requires the planner + capability
    // registry at top level; both are dependency-light leaves, so
    // VM loads get the real modules (cf. the apiErrors precedent).
    './siteChatPlanner': require(path.join(root, 'server', 'siteChatPlanner.js')),
    './portalCapabilities': require(path.join(root, 'server', 'portalCapabilities.js')),
  });
  const museCfgR3 = await museAgentR3.resolveMuseConfig(dbMuseR3);
  check('review3 muse agent: workspace fallback returns the decrypted muse.model_api_key', () => {
    assert.equal(museCfgR3.apiKey, 'r3-muse-plaintext');
  });

  // (c) pushDefaultsToWorkspaces must store seed secrets encrypted in
  // BOTH the SQLite settings table and the MySQL workspace_settings row.
  const dbAdminR3 = freshDbR3();
  const mysqlWritesR3 = [];
  const adminR3 = load('server/admin.js', {
    './db': {
      query: async (sql, params) => {
        if (String(sql).includes('FROM workspaces')) return [{ id: 1 }];
        if (String(sql).includes('INSERT INTO workspace_settings')) mysqlWritesR3.push(params);
        return [];
      },
      withConnection: async () => {},
      driver: () => 'sqlite',
    },
    './platform': {
      workspaceSeedFromPlatform: async () => ({ 'ai.api_key': 'r3-ai-plaintext', 'app.name': 'Fixture Co' }),
    },
    './workspace': { createUserWithWorkspace: async () => ({}), slugify: (s) => String(s) },
    './workspaceDb': { openWorkspaceDb: () => dbAdminR3, acquireWorkspaceDb: () => dbAdminR3, releaseWorkspaceDb: () => {}, leaseCount: () => 1 },
    '../src/secretBox': boxR3,
  });
  await adminR3.pushDefaultsToWorkspaces({ force: true, keys: ['ai.api_key', 'app.name'] });
  check('review3 admin seed push: secrets are stored encrypted in both workspace stores', () => {
    const sqliteRow = dbAdminR3.prepare("SELECT value FROM settings WHERE key = 'ai.api_key'").get();
    assert.ok(sqliteRow && boxR3.isEncrypted(sqliteRow.value), 'sqlite value is enc:v1: ciphertext');
    assert.equal(boxR3.decryptSetting('ai.api_key', sqliteRow.value), 'r3-ai-plaintext');
    const mysqlSecret = mysqlWritesR3.find((p) => p && p.key === 'ai.api_key');
    assert.ok(mysqlSecret && boxR3.isEncrypted(mysqlSecret.value), 'mysql value is enc:v1: ciphertext');
    assert.equal(boxR3.decryptSetting('ai.api_key', mysqlSecret.value), 'r3-ai-plaintext');
    const sqlitePlain = dbAdminR3.prepare("SELECT value FROM settings WHERE key = 'app.name'").get();
    assert.equal(sqlitePlain.value, 'Fixture Co', 'non-secret keys still stored plain');
  });

  // ---- Review fix 4: Twilio recording webhook + media fetch ----
  // The recording webhook itself has verified Twilio signatures since
  // Batch 21 (pinned below against regression). The open hole was the
  // media fetch: fetchRecordingMedia took the stored RecordingUrl —
  // a value a webhook post controls — and fetched it WITH the Twilio
  // Basic-auth header, so a hostile URL both leaked the credentials
  // to that host and pulled arbitrary content into playback/transcripts.
  const fetchesR4 = [];
  const loadTwilioR4 = (fetchImpl) => {
    const mod = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(root, 'server/twilioClient.js'), 'utf8'), {
      module: mod, exports: mod.exports,
      require: (name) => {
        if (name === './platform') {
          return { getPlatformSetting: async (k) => ({ 'twilio.account_sid': 'ACr4', 'twilio.auth_token': 'tok-r4' })[k] || '' };
        }
        if (!name.startsWith('.')) return require(name);
        throw new Error('Unexpected dependency: ' + name);
      },
      process: { env: {} }, console, Buffer, URL, URLSearchParams, FormData, Blob,
      fetch: fetchImpl, setTimeout, clearTimeout,
    }, { filename: 'server/twilioClient.js' });
    return mod.exports;
  };
  const twilioR4 = loadTwilioR4(async (url, opts) => {
    fetchesR4.push({ url: String(url), opts });
    return { ok: true, status: 200, headers: { get: () => 'audio/mpeg' }, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
  });
  const ssrfInternalR4 = await twilioR4.fetchRecordingMedia('https://169.254.169.254/latest/meta-data/iam');
  const ssrfHostR4 = await twilioR4.fetchRecordingMedia('https://recordings.evil.example/steal');
  const ssrfUserinfoR4 = await twilioR4.fetchRecordingMedia('https://api.twilio.com@evil.example/x');
  check('review4 media fetch: non-Twilio recording URLs are refused and never fetched (no credential leak)', () => {
    assert.equal(fetchesR4.length, 0, 'no fetch may fire for a non-Twilio URL');
    for (const r of [ssrfInternalR4, ssrfHostR4, ssrfUserinfoR4]) {
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'untrusted_url');
    }
  });
  const goodMediaR4 = await twilioR4.fetchRecordingMedia('https://api.twilio.com/2010-04-01/Accounts/ACr4/Recordings/REr4');
  check('review4 media fetch: a genuine Twilio recording URL still downloads with auth', () => {
    assert.equal(goodMediaR4.ok, true);
    assert.equal(fetchesR4.length, 1);
    assert.ok(fetchesR4[0].url.endsWith('/Recordings/REr4.mp3'));
    assert.ok(String(fetchesR4[0].opts.headers.Authorization || '').startsWith('Basic '));
  });

  // Route-level pin: with credentials configured, a forged (unsigned)
  // recording post is a 403 and stores nothing; a correctly signed one
  // stores the recording.
  const storedR4 = [];
  const handlersR4 = { post: {}, get: {} };
  const fakeRouterR4 = {
    post: (p, ...h) => { handlersR4.post[p] = h[h.length - 1]; },
    get: (p, ...h) => { handlersR4.get[p] = h[h.length - 1]; },
    use: () => {},
  };
  const realTwilioR4 = loadTwilioR4(async () => { throw new Error('no fetch in route test'); });
  load('server/routes/calls.js', {
    express: { Router: () => fakeRouterR4 },
    '../domain': { withDb: (_ws, fn) => fn(db) },
    '../workspaceExists': { assertWorkspaceExists: async (id) => { if (Number(id) !== 1) throw new Error('no ws'); } },
    '../siteModules': {
      upsertCallStatus: () => ({}),
      storeCallRecording: (_db, callSid, rec) => {
        storedR4.push({ callSid, ...rec });
        return { call_sid: callSid, recording_url: rec.recordingUrl, is_voicemail: 0, transcript_status: 'none' };
      },
      setCallTranscript: () => {},
      getCallLogBySid: () => null,
    },
    '../portalContacts': contacts,
    '../twilioClient': {
      getCredentials: async () => ({ accountSid: 'ACr4', authToken: 'tok-r4' }),
      validateSignature: realTwilioR4.validateSignature,
      fetchRecordingMedia: async () => ({ configured: false }),
      transcribeRecording: async () => ({ ok: false, reason: 'stub' }),
    },
    '../clientPortal': { findById: () => null },
    '../workspace': { getMembership: () => null, findWorkspaceByToken: () => null },
    '../callNotify': { notifyCallByEmail: async () => ({ sent: false }) },
    '../callBilling': { settleCallBilling: async () => ({}), transcribeCallRecording: async () => ({ ok: false }) },
    '../stripeClient': { appUrl: () => 'https://example.test' },
    '../rateLimit': { rateLimit: () => ((_req, _res, next) => next()) },
  });
  db.prepare('INSERT INTO leads (id, business_name, email) VALUES (?, ?, ?)').run(2765, 'Fixture R4 Calls', 'r4@example.invalid');
  const fakeResR4 = () => ({
    statusCode: 200, headers: {}, body: null,
    status(c) { this.statusCode = c; return this; },
    set(k, v) { this.headers[k] = v; return this; },
    type() { return this; },
    send(b) { this.body = b; return this; },
    json(o) { this.body = o; return this; },
  });
  const recBodyR4 = { CallSid: 'CAr4', RecordingSid: 'REr4', RecordingUrl: 'https://api.twilio.com/rec/REr4', RecordingDuration: '9', RecordingStatus: 'completed' };
  const recPathR4 = '/api/v1/calls/recording/1/2765';
  const forgedResR4 = fakeResR4();
  await handlersR4.post['/recording/:workspaceId/:leadId'](
    { params: { workspaceId: '1', leadId: '2765' }, body: recBodyR4, headers: {}, originalUrl: recPathR4, query: {} },
    forgedResR4
  );
  check('review4 recording webhook: unsigned/forged post is 403 and stores nothing', () => {
    assert.equal(forgedResR4.statusCode, 403);
    assert.equal(storedR4.length, 0);
  });
  const cryptoR4 = require('node:crypto');
  const signR4 = (url, params, token) => {
    let data = url;
    for (const k of Object.keys(params).sort()) data += k + String(params[k]);
    return cryptoR4.createHmac('sha1', token).update(Buffer.from(data, 'utf-8')).digest('base64');
  };
  const signedResR4 = fakeResR4();
  await handlersR4.post['/recording/:workspaceId/:leadId'](
    {
      params: { workspaceId: '1', leadId: '2765' }, body: recBodyR4,
      headers: { 'x-twilio-signature': signR4('https://example.test' + recPathR4, recBodyR4, 'tok-r4') },
      originalUrl: recPathR4, query: {},
    },
    signedResR4
  );
  check('review4 recording webhook: correctly signed post still stores the recording', () => {
    assert.equal(signedResR4.statusCode, 200);
    assert.equal(storedR4.length, 1);
    assert.equal(storedR4[0].recordingUrl, 'https://api.twilio.com/rec/REr4');
  });

  // ---- Review fix 5: tenant recording playback ----
  // Playback authorized only caller.leadId === call_logs.lead_id (the
  // OWNER). Rental calls are stamped with tenant_lead_id (Batch 26)
  // and delivered to the tenant everywhere else — but the tenant's own
  // portal playback 404'd on their own calls.
  const handlersR5 = { post: {}, get: {} };
  const fakeRouterR5 = {
    post: (p, ...h) => { handlersR5.post[p] = h[h.length - 1]; },
    get: (p, ...h) => { handlersR5.get[p] = h[h.length - 1]; },
    use: () => {},
  };
  const callRowR5 = {
    call_sid: 'CAr5', lead_id: 2770, tenant_lead_id: 2771,
    recording_url: 'https://api.twilio.com/rec/REr5',
  };
  let portalClientR5 = null;
  load('server/routes/calls.js', {
    express: { Router: () => fakeRouterR5 },
    '../domain': { withDb: (_ws, fn) => fn(db) },
    '../workspaceExists': { assertWorkspaceExists: async (id) => { if (Number(id) !== 1) throw new Error('no ws'); } },
    '../siteModules': {
      getCallLogBySid: () => callRowR5,
      upsertCallStatus: () => ({}),
      storeCallRecording: () => null,
      setCallTranscript: () => {},
    },
    '../portalContacts': contacts,
    '../twilioClient': {
      getCredentials: async () => ({ accountSid: 'ACr5', authToken: 'tok-r5' }),
      validateSignature: () => false,
      fetchRecordingMedia: async () => ({ configured: true, ok: true, buffer: Buffer.from('mp3bytes'), contentType: 'audio/mpeg' }),
    },
    '../clientPortal': { findById: async () => portalClientR5 },
    '../workspace': { getMembership: async () => null, findWorkspaceByToken: async () => null },
    '../callNotify': { notifyCallByEmail: async () => ({ sent: false }) },
    '../callBilling': { settleCallBilling: async () => ({}), transcribeCallRecording: async () => ({ ok: false }) },
    '../stripeClient': { appUrl: () => 'https://example.test' },
    '../rateLimit': { rateLimit: () => ((_req, _res, next) => next()) },
  });
  const fakeResR5 = () => ({
    statusCode: 200, headers: {}, body: null,
    status(c) { this.statusCode = c; return this; },
    set(k, v) { this.headers[k] = v; return this; },
    setHeader(k, v) { this.headers[k] = v; return this; },
    type() { return this; },
    send(b) { this.body = b; return this; },
    json(o) { this.body = o; return this; },
  });
  const playR5 = async (leadId) => {
    portalClientR5 = { status: 'active', workspace_id: 1, lead_id: leadId };
    const res = fakeResR5();
    await handlersR5.get['/recording-file/:workspaceId/:callSid'](
      { params: { workspaceId: '1', callSid: 'CAr5' }, headers: {}, portalSession: { clientPortalId: 99 }, session: null },
      res
    );
    return res;
  };
  const tenantPlayR5 = await playR5(2771);
  check('review5 tenant can play a call stamped to them on a rented site', () => {
    assert.equal(tenantPlayR5.statusCode, 200);
    assert.equal(String(tenantPlayR5.body), 'mp3bytes');
  });
  const ownerPlayR5 = await playR5(2770);
  check('review5 owner playback unchanged', () => {
    assert.equal(ownerPlayR5.statusCode, 200);
  });
  const strangerPlayR5 = await playR5(2772);
  check('review5 an unrelated lead still cannot play the recording', () => {
    assert.equal(strangerPlayR5.statusCode, 404);
    assert.equal(strangerPlayR5.body && strangerPlayR5.body.error, 'Recording not found');
  });

  // ---- Review fix 6: duplicate-subscription race ----
  // Two checkout sessions can complete for one user (double submit,
  // two tabs): Stripe creates a subscription for each, and
  // syncSubscription blindly overwrote users.stripe_subscription_id
  // with the last one synced — both stay live at Stripe, the user is
  // double-billed, and one subscription is orphaned from the DB.
  const userRowR6 = {
    id: 42, stripe_customer_id: 'cus_42', stripe_subscription_id: null,
    subscription_status: 'none', subscription_price_id: '', billing_plan: 'free', current_period_end: null,
  };
  const ACTIVE_R6 = new Set(['active', 'trialing', 'past_due']);
  const queryR6 = async (sql, params = {}) => {
    const s = String(sql);
    if (s.includes('UPDATE users SET')) {
      // Honor the conditional (atomic compare-and-swap) form if present:
      // apply only when no DIFFERENT live subscription is tracked.
      if (s.includes('subscription_status NOT IN')) {
        const mayWrite =
          !userRowR6.stripe_subscription_id ||
          userRowR6.stripe_subscription_id === params.subId ||
          !ACTIVE_R6.has(String(userRowR6.subscription_status || ''));
        if (!mayWrite) return { affectedRows: 0 };
      }
      userRowR6.stripe_subscription_id = params.subId;
      userRowR6.subscription_status = params.status;
      userRowR6.subscription_price_id = params.priceId;
      userRowR6.billing_plan = params.plan;
      userRowR6.current_period_end = params.periodEnd;
      return { affectedRows: 1 };
    }
    if (s.includes('FROM users')) return [];
    return [];
  };
  const billingR6 = load('server/billing.js', {
    './db': { query: queryR6, driver: () => 'sqlite' },
    './platform': { getPlatformSetting: async () => '' },
    './plans': {
      PLAN_FREE: 'free', PLAN_STANDARD: 'standard', PLAN_PRO: 'pro', PLAN_PREMIUM: 'premium',
      normalizePlanId: (v) => v || 'free', getPlan: () => ({}), listPlans: () => [],
      isPaidPlan: (p) => ['standard', 'pro', 'premium'].includes(p), maxPlan: (a) => a, publicPlan: (p) => p,
    },
    './stripeClient': {
      getStripe: async () => ({ subscriptions: { retrieve: async () => ({}), update: async () => ({}) } }),
      getPriceIdForPlan: async () => 'price_1', getConfiguredPriceIds: async () => ({}),
      planIdFromPriceId: async () => 'standard', getPublishableKey: () => '', integrationId: () => 'x',
    },
    './credits': { grantFromCheckoutSession: async () => {} },
    './appUrls': { staffUrl: () => 'https://example.test/billing' },
    './referrals': { tryAwardForPaidUser: async () => {} },
  });
  const subR6 = (id, status = 'active') => ({
    id, customer: 'cus_42', status,
    metadata: { user_id: '42', plan: 'standard' },
    items: { data: [{ price: { id: 'price_1' } }] },
    current_period_end: 2000000000,
  });
  await billingR6.syncSubscription(subR6('sub_1'));
  check('review6 first completion syncs normally', () => {
    assert.equal(userRowR6.stripe_subscription_id, 'sub_1');
    assert.equal(userRowR6.subscription_status, 'active');
    assert.equal(userRowR6.billing_plan, 'standard');
  });
  const dupR6 = await billingR6.syncSubscription(subR6('sub_2'));
  check('review6 second completion for a different subscription is a no-op (existing state kept)', () => {
    assert.equal(userRowR6.stripe_subscription_id, 'sub_1', 'tracked subscription must not be overwritten');
    assert.equal(userRowR6.subscription_status, 'active');
    assert.ok(dupR6 && dupR6.duplicate === true, 'the duplicate is reported, not silently applied');
  });
  await billingR6.syncSubscription(subR6('sub_1', 'canceled'));
  check('review6 updates for the tracked subscription still apply (cancellation lands)', () => {
    assert.equal(userRowR6.stripe_subscription_id, 'sub_1');
    assert.equal(userRowR6.subscription_status, 'canceled');
    assert.equal(userRowR6.billing_plan, 'free');
  });
  await billingR6.syncSubscription(subR6('sub_3'));
  check('review6 a new subscription may take over once the tracked one is no longer live', () => {
    assert.equal(userRowR6.stripe_subscription_id, 'sub_3');
    assert.equal(userRowR6.subscription_status, 'active');
  });

  // ---- Review fix 7: shop orders marked paid without payment_status ----
  // checkout.session.completed also fires for async payment methods
  // whose money has not landed (payment_status 'unpaid'); the shop
  // handler flipped the order to 'paid' on the event type alone —
  // the flaw Batch 21b's membership flow avoids by gating on
  // payment_status. Mirrored here.
  const smR7 = load('server/siteModules.js', {
    '../src/pageContentScan': require(path.join(root, 'src/pageContentScan.js')),
  });
  smR7.ensureTables(db);
  db.prepare('INSERT INTO leads (id, business_name, email) VALUES (?, ?, ?)').run(2780, 'Fixture R7 Shop', 'r7@example.invalid');
  const mkOrderR7 = (session) =>
    Number(
      db.prepare(
        "INSERT INTO ecommerce_orders (lead_id, product_id, product_name, amount_cents, currency, status, stripe_session_id) VALUES (2780, NULL, 'Widget', 2500, 'USD', 'pending', ?)"
      ).run(session).lastInsertRowid
    );
  const orderStatusR7 = (id) => db.prepare('SELECT status FROM ecommerce_orders WHERE id = ?').get(id).status;
  const evtR7 = (type, session, paymentStatus) => ({
    type,
    data: { object: { id: session, payment_intent: 'pi_r7', payment_status: paymentStatus, customer_details: { email: 'buyer@example.invalid' } } },
  });
  const orderA7 = mkOrderR7('cs_r7_unpaid');
  const appliedA7 = smR7.applyShopStripeEvent(db, evtR7('checkout.session.completed', 'cs_r7_unpaid', 'unpaid'));
  check('review7 completed-but-unpaid session does NOT mark the order paid', () => {
    assert.equal(appliedA7.status, 'pending');
    assert.equal(orderStatusR7(orderA7), 'pending');
  });
  const appliedA7b = smR7.applyShopStripeEvent(db, evtR7('checkout.session.async_payment_succeeded', 'cs_r7_unpaid', 'paid'));
  check('review7 async payment success settles the order as paid', () => {
    assert.equal(appliedA7b.status, 'paid');
    assert.equal(orderStatusR7(orderA7), 'paid');
  });
  const orderB7 = mkOrderR7('cs_r7_paid');
  const appliedB7 = smR7.applyShopStripeEvent(db, evtR7('checkout.session.completed', 'cs_r7_paid', 'paid'));
  check('review7 completed + payment_status paid marks paid (normal card flow unchanged)', () => {
    assert.equal(appliedB7.status, 'paid');
    assert.equal(orderStatusR7(orderB7), 'paid');
  });
  const orderC7 = mkOrderR7('cs_r7_fail');
  smR7.applyShopStripeEvent(db, evtR7('checkout.session.completed', 'cs_r7_fail', 'unpaid'));
  const appliedC7 = smR7.applyShopStripeEvent(db, evtR7('checkout.session.async_payment_failed', 'cs_r7_fail', 'unpaid'));
  check('review7 unpaid completion followed by async failure ends failed, never paid', () => {
    assert.equal(appliedC7.status, 'failed');
    assert.equal(orderStatusR7(orderC7), 'failed');
  });

  // ---- Review fix 8: shop checkout ignores detach ----
  // detachModule flips the embed to published=0 / embed_enabled=0 and
  // the sync strips it from the site — but createShopCheckoutByToken
  // (and the public shop payload) only checked that the token's row
  // was an ecommerce embed, so a detached shop kept taking orders
  // from anyone holding the token. Gate both on moduleEmbedActive,
  // the same predicate the rest of the module system uses.
  const smR8 = load('server/siteModules.js', {
    '../src/pageContentScan': require(path.join(root, 'src/pageContentScan.js')),
    './shopStripe': { isConfiguredForLead: () => false, resolveForLead: () => { throw Object.assign(new Error('no keys'), { code: 'SHOP_STRIPE_NOT_CONFIGURED' }); } },
  });
  smR8.ensureTables(db);
  db.prepare('INSERT INTO leads (id, business_name, email) VALUES (?, ?, ?)').run(2790, 'Fixture R8 Shop', 'r8@example.invalid');
  db.prepare("INSERT INTO websites (lead_id, name, theme, pages) VALUES (2790, 'R8 Site', '{}', '[]')").run();
  const embR8 = smR8.attachModule(db, 2790, 'ecommerce', { workspaceId: 1, appUrl: 'https://example.test' });
  const tokenR8 = embR8.embed ? embR8.embed.public_token : smR8.getEmbedRow(db, 2790, 'ecommerce').public_token;
  const prodR8 = smR8.createProduct(db, 2790, { name: 'R8 Widget', price_cents: 1200, status: 'published', checkout_url: 'https://pay.example/r8' });
  const coAttachedR8 = await smR8.createShopCheckoutByToken(db, tokenR8, { productId: prodR8.id, returnUrl: 'https://example.test/done' }, {});
  check('review8 attached + published shop: checkout works (external mode fixture)', () => {
    assert.equal(coAttachedR8.mode, 'external');
    assert.equal(coAttachedR8.url, 'https://pay.example/r8');
    assert.ok(smR8.getPublicModuleByToken(db, tokenR8, {}), 'public payload serves while attached');
  });
  smR8.detachModule(db, 2790, 'ecommerce');
  let coDetachedErrR8 = null;
  try {
    await smR8.createShopCheckoutByToken(db, tokenR8, { productId: prodR8.id, returnUrl: 'https://example.test/done' }, {});
  } catch (e) { coDetachedErrR8 = e; }
  let payloadDetachedErrR8 = null;
  try {
    smR8.getPublicModuleByToken(db, tokenR8, {});
  } catch (e) { payloadDetachedErrR8 = e; }
  check('review8 detached shop: checkout refused and public payload no longer serves', () => {
    assert.ok(coDetachedErrR8, 'checkout on a detached shop must throw');
    assert.equal(coDetachedErrR8.code, 'NOT_FOUND');
    assert.ok(payloadDetachedErrR8, 'public payload on a detached shop must throw');
    assert.equal(payloadDetachedErrR8.code, 'NOT_FOUND');
  });
  smR8.attachModule(db, 2790, 'ecommerce', { workspaceId: 1, appUrl: 'https://example.test' });
  const tokenR8b = smR8.getEmbedRow(db, 2790, 'ecommerce').public_token;
  const coReattachedR8 = await smR8.createShopCheckoutByToken(db, tokenR8b, { productId: prodR8.id, returnUrl: 'https://example.test/done' }, {});
  check('review8 re-attached shop: checkout works again', () => {
    assert.equal(coReattachedR8.mode, 'external');
  });

  // ---- Review fix 9: archived sites in public surfaces ----
  // Batch 27 pinned listings/portal/export. Verification of the
  // remaining public surfaces found two still serving an archived
  // site: the public module routes and the public chatbot routes —
  // their embed tokens outlive the site and neither router consulted
  // the website's archived state. (The /site-previews gate itself is
  // pinned below: canonical ws-{ws}-site-{id} folders resolve the
  // right workspace row.)
  const smR9 = load('server/siteModules.js', {
    '../src/pageContentScan': require(path.join(root, 'src/pageContentScan.js')),
    './shopStripe': { isConfiguredForLead: () => false, resolveForLead: () => { throw Object.assign(new Error('no keys'), { code: 'SHOP_STRIPE_NOT_CONFIGURED' }); } },
  });
  smR9.ensureTables(db);
  db.prepare('INSERT INTO leads (id, business_name, email) VALUES (?, ?, ?)').run(2795, 'Fixture R9 Modules', 'r9@example.invalid');
  const siteR9 = Number(db.prepare("INSERT INTO websites (lead_id, name, theme, pages, status) VALUES (2795, 'R9 Site', '{}', '[]', 'published')").run().lastInsertRowid);
  smR9.attachModule(db, 2795, 'faq', { workspaceId: 1, appUrl: 'https://example.test' });
  const tokenR9 = smR9.getEmbedRow(db, 2795, 'faq').public_token;

  // -- preview gate pins (unit level, fixture workspace db)
  const dbPrevR9 = new Database(':memory:');
  dbPrevR9.exec('CREATE TABLE websites (id INTEGER PRIMARY KEY, archived_at TEXT)');
  dbPrevR9.prepare('INSERT INTO websites (id, archived_at) VALUES (5, NULL)').run();
  dbPrevR9.prepare("INSERT INTO websites (id, archived_at) VALUES (6, '2026-10-27 00:00:00')").run();
  const prevSecR9 = load('server/previewSecurity.js', { './workspaceDb': { openWorkspaceDb: () => dbPrevR9, acquireWorkspaceDb: () => dbPrevR9, releaseWorkspaceDb: () => {}, leaseCount: () => 1 } });
  const runGateR9 = (p) => {
    const out = { status: null, body: null, nexted: false };
    prevSecR9.blockArchivedPreviews(
      { path: p },
      {
        status(c) { out.status = c; return this; },
        setHeader() { return this; },
        json(o) { out.body = o; return this; },
        send() { return this; },
      },
      () => { out.nexted = true; }
    );
    return out;
  };
  // Batch 64: the archived answer is 410 SITE_ARCHIVED (the module API's
  // body), and the canonical {id}-{exportSlug} folder shape resolves —
  // Batch 27's end-anchored regex missed it and archived previews served.
  check('review9 preview gate: archived canonical folder 410s, live + non-site paths pass through', () => {
    const bare = runGateR9('/ws-1-site-6/index.html');
    assert.equal(bare.status, 410);
    assert.equal(bare.body && bare.body.code, 'SITE_ARCHIVED');
    assert.equal(runGateR9('/ws-1-site-6-e2ed807be54c21d091/index.html').status, 410);
    assert.equal(runGateR9('/ws-1-site-5/index.html').nexted, true);
    assert.equal(runGateR9('/ws-1-design-9/index.html').nexted, true);
    assert.equal(runGateR9('/something-else/').nexted, true);
  });

  // -- modules router gate
  const stubRouterR9 = () => {
    const routes = { get: {}, post: {}, use: [] };
    return {
      routes,
      get: (p, ...h) => { routes.get[p] = h[h.length - 1]; },
      post: (p, ...h) => { routes.post[p] = h[h.length - 1]; },
      use: (...h) => { routes.use.push(h[h.length - 1]); },
    };
  };
  const fakeResR9 = () => ({
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
    set() { return this; }, setHeader() { return this; }, type() { return this; }, send(b) { this.body = b; return this; },
  });
  const modRouterR9 = stubRouterR9();
  load('server/routes/modulesPublic.js', {
    express: { Router: () => modRouterR9 },
    '../domain': { withDb: (_ws, fn) => fn(db) },
    '../siteModules': smR9,
    '../captcha': { requireCaptcha: () => (_req, _res, next) => next && next(), clientIp: () => '127.0.0.1', getCaptchaConfig: async () => ({}) },
    '../rateLimit': { rateLimit: () => (_req, _res, next) => next && next() },
    '../workspaceExists': { assertWorkspaceExists: async () => {} },
    '../ownerNotify': {},
    '../rentals': { settlePendingCharges: async () => {} },
  });
  const getPayloadR9 = async () => {
    const res = fakeResR9();
    await modRouterR9.routes.get['/:token'](
      { params: { token: tokenR9 }, query: { w: '1' }, body: {}, headers: {}, get: () => '' },
      res
    );
    return res;
  };
  const livePayloadR9 = await getPayloadR9();
  check('review9 modules payload serves while the site is live', () => {
    assert.equal(livePayloadR9.statusCode, 200);
    assert.equal(livePayloadR9.body && livePayloadR9.body.ok, true);
  });
  db.prepare("UPDATE websites SET archived_at = datetime('now') WHERE id = ?").run(siteR9);
  const archivedPayloadR9 = await getPayloadR9();
  check('review9 modules payload refuses once the site is archived', () => {
    assert.equal(archivedPayloadR9.statusCode, 410);
    assert.equal(archivedPayloadR9.body && archivedPayloadR9.body.code, 'SITE_ARCHIVED');
  });

  // -- chatbot router gate (real chatbot.js: the gate lives in
  // getPublicConfigByToken, through which every public chat flow reads)
  const chatRealR9 = load('server/chatbot.js', { './siteModules': smR9 });
  const chatRouterR9 = stubRouterR9();
  load('server/routes/chatbotPublic.js', {
    express: { Router: () => chatRouterR9 },
    '../domain': { withDb: (_ws, fn) => fn(db) },
    '../chatbot': chatRealR9,
    // Batch 138: the public router also requires the voice module —
    // load the real one against the real chatbot (its lazy deps fail
    // soft by design, exactly as in production without a key).
    '../chatbotVoice': load('server/chatbotVoice.js', {
      './chatbot': chatRealR9,
      './siteChatAttachments': {},
    }),
    '../siteModules': smR9,
    '../rateLimit': { rateLimit: () => (_req, _res, next) => next && next() },
    '../workspaceExists': { assertWorkspaceExists: async () => {} },
  });
  smR9.attachModule(db, 2795, 'chatbot', { workspaceId: 1, appUrl: 'https://example.test' });
  const chatTokenR9 = smR9.getEmbedRow(db, 2795, 'chatbot').public_token;
  const chatResR9 = fakeResR9();
  await chatRouterR9.routes.get['/:token'](
    { params: { token: chatTokenR9 }, query: { w: '1' }, body: {}, headers: {}, get: () => '' },
    chatResR9
  );
  check('review9 chatbot public config refuses once the site is archived', () => {
    assert.equal(chatResR9.statusCode, 410);
    assert.equal(chatResR9.body && chatResR9.body.code, 'SITE_ARCHIVED');
  });
  db.prepare('UPDATE websites SET archived_at = NULL WHERE id = ?').run(siteR9);
  const chatResR9b = fakeResR9();
  await chatRouterR9.routes.get['/:token'](
    { params: { token: chatTokenR9 }, query: { w: '1' }, body: {}, headers: {}, get: () => '' },
    chatResR9b
  );
  check('review9 chatbot serves again after restore', () => {
    assert.equal(chatResR9b.statusCode, 200);
    assert.equal(chatResR9b.body && chatResR9b.body.ok, true);
  });

  // ---- Review fix 10: local MCP catalog breakage ----
  // src/mcpCatalog.js advertises 214 tools; src/mcp.js (the local
  // stdio server the desktop app points MCP clients at) refuses to
  // boot when a catalog tool has no run() in TOOLS. The module
  // families (blog/shop/courses/gallery/faq/members/calls/rentals/…)
  // were only ever implemented on the HOSTED server, so the local
  // server died on startup ("MCP catalog tool website.addModule has
  // no run() in mcp.js") and clients fell back to REST.
  const cpR10 = require('node:child_process');
  const osR10 = require('node:os');
  const bootProbeR10 = cpR10.execFileSync(
    process.execPath,
    ['-e', "try { require('./src/mcp.js'); console.log('MCP BOOT OK'); } catch (e) { console.log('MCP BOOT THREW: ' + e.message); } process.exit(0);"],
    {
      cwd: root,
      env: { ...process.env, DB_DRIVER: process.env.REGRESSION_DB_DRIVER || 'sqlite', WS_DB_PATH: path.join(osR10.tmpdir(), `ws-mcp-boot-${Date.now()}.db`) },
      input: '',
      encoding: 'utf8',
      timeout: 30000,
    }
  );
  check('review10 local MCP server boots: every catalog tool resolves to a real handler', () => {
    assert.ok(String(bootProbeR10).includes('MCP BOOT OK'), String(bootProbeR10).slice(0, 300));
  });
  // Functional spot-checks: the parity delegations must really drive
  // server/siteModules, not just exist by name.
  const parityR10 = require(path.join(root, 'src/mcpParityTools.js')).createParityTools({
    db,
    vStr: (v) => (v == null ? '' : String(v)),
    vInt: (v) => Number(v) || 0,
    requireId: (v, n) => { const id = Number(v); if (!id) throw new Error(`${n} is required`); return id; },
    isErr: () => false,
    argError: (m) => new Error(m),
    ensureNotPaused: () => {},
    leadSummary: (x) => x,
    mcpSafeJob: (x) => x,
    logActivity: () => {},
    getSetting: () => '',
    setSetting: () => {},
    runLeadEngine: (fn) => fn(),
    workspaceId: 1,
  });
  db.prepare('INSERT INTO leads (id, business_name, email) VALUES (?, ?, ?)').run(2797, 'Fixture R10 Modules', 'r10@example.invalid');
  const faqCreateR10 = await parityR10['faq.create'].run({ leadId: 2797, question: 'R10 question?', answer: 'R10 answer.', status: 'published' });
  const faqListR10 = await parityR10['faq.list'].run({ leadId: 2797 });
  check('review10 faq.create + faq.list delegate to siteModules for real', () => {
    assert.equal(faqCreateR10.ok, true);
    const items = Array.isArray(faqListR10.data) ? faqListR10.data : faqListR10.data.items;
    assert.ok(items.some((i) => i.question === 'R10 question?'), JSON.stringify(faqListR10.data).slice(0, 200));
  });
  const addModR10 = await parityR10['website.addModule'].run({ leadId: 2797, moduleType: 'blog' });
  const modListR10 = await parityR10['modules.list'].run({ leadId: 2797 });
  check('review10 website.addModule attaches and modules.list reports it', () => {
    assert.equal(addModR10.ok, true);
    assert.ok(addModR10.data && addModR10.data.embed, 'attach returns the embed');
    assert.ok(modListR10 && modListR10.ok === true, 'modules.list runs');
  });

  db.close();console.log(JSON.stringify({passed:results.length,results},null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1});
