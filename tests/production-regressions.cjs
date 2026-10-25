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
const results = [];
function check(name, fn) { fn(); results.push(name); }
function load(file, mocks) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, file), 'utf8'), {
    module, exports: module.exports, require: name => {
      if (Object.hasOwn(mocks, name)) return mocks[name];
      if (!name.startsWith('.')) return require(name);
      throw new Error('Unexpected dependency: ' + name);
    }, process: { env: {} }, console, Buffer, URL, Date, setTimeout, clearTimeout,
  }, { filename: file });
  return module.exports;
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
    './domain':{withDb:(_ws,fn)=>fn(db)},'./portalContacts':contacts,
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
    '../captcha':{requireCaptcha:()=>((_req,_res,next)=>next())},'../rateLimit':{rateLimit:()=>((_req,_res,next)=>next())},
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
    '../middleware':{...middleware,requireWorkspace:(_req,_res,next)=>next()},
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
    './domain': { withDb: (_ws, fn) => fn(db) }, './portalContacts': contacts, '../src/designJobs': designJobs,
  });
  assert.equal(portal11.listChangeRequests(1, 102).length, 1);
  assert.throws(() => portal11.listChangeRequests(1, null), (e) => e.code === 'FORBIDDEN');
  const portalRoutes11 = [];
  const portalRouter11 = { use() {} };
  for (const method of ['get', 'post', 'put', 'patch', 'delete']) portalRouter11[method] = (route, ...handlers) => portalRoutes11.push({ method, route, handlers });
  load('server/routes/portal.js', {
    express: { Router: () => portalRouter11 }, '../clientPortal': { ...portal11, findById: async () => ({ id: 7, status: 'active', workspace_id: 1, lead_id: 102 }) },
    '../captcha': { requireCaptcha: () => ((_req, _res, next) => next()) }, '../rateLimit': { rateLimit: () => ((_req, _res, next) => next()) },
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
  assert.equal(Object.keys(sm12.MODULE_META).length, 17, 'module catalog has 17 types');
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
  assert.equal(summary12.modules.length, 17, 'portal summary lists all 17 module types');
  check('batch12 public payloads: token surface filters expired/inactive/draft; portal summary = 17 types', () => {});

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

  db.close();console.log(JSON.stringify({passed:results.length,results},null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1});
