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

  db.close();console.log(JSON.stringify({passed:results.length,results},null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1});
