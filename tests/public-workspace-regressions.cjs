'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const root=process.env.BITPYPE_TEST_ROOT||path.resolve(__dirname,'..');
const results=[];
function load(file,mocks,env={}){
 const module={exports:{}};
 vm.runInNewContext(fs.readFileSync(path.join(root,file),'utf8'),{
  module,exports:module.exports,require:n=>{if(Object.hasOwn(mocks,n))return mocks[n];if(n==='../apiErrors')return require('../server/apiErrors');if(!n.startsWith('.'))return require(n);throw new Error('Unexpected dependency '+n)},
  process:{env},console:{...console,error(){}},Buffer,URL,URLSearchParams,Date,setTimeout,clearTimeout,
 },{filename:file});return module.exports;
}
function build(file,known=true){
 const routes=[],rates=[];let calls=0,checked=false,authCalls=0;
 const router={};for(const m of ['get','post'])router[m]=(p,...handlers)=>routes.push({m,p,handlers});
 const exists=load('server/workspaceExists.js',{'./db':{query:async(_sql,params)=>{authCalls++;await Promise.resolve();return known&&params.id===1?[{id:1}]:[]}}});
 const guard=async id=>{await exists.assertWorkspaceExists(id);checked=true};
 const domain=new Proxy({}, {get:(_t,name)=>(...args)=>{assert(checked,'domain touched before workspace validation: '+name);calls++;if(name==='withDb')return args[1]({});return {ok:true,leadId:2}}});
 const mocks={express:{Router:()=>router},'../domain':domain,'../siteModules':{
  parseWorkspaceFromToken:t=>Number(String(t).split('_')[0]),
  getPublicModuleByToken:()=>({ok:true,module_type:'photocapture',embed:{lead_id:2},locked:false}),getPublicModuleItem:()=>({ok:true}),getPublicBookingSlots:()=>({slots:[]}),createPublicBookingByToken:()=>({ok:true}),createPublicEstimateRequestByToken:()=>({ok:true}),createShopCheckoutByToken:()=>({ok:true}),createCartCheckoutByToken:()=>({ok:true}),getEmbedRowByToken:()=>({lead_id:2}),listShopOrderItems:()=>[],getShopOrderBySession:()=>({id:1,lead_id:2,status:'paid',product_name:'fixture',amount_cents:100,currency:'USD'}),publicDiscountStamp:s=>(s&&Number(s.discount_amount_cents)>0)?{gross_cents:Number(s.gross_cents)||0,discount_amount_cents:Number(s.discount_amount_cents)||0,net_cents:Number(s.net_cents)||0,currency:String(s.currency||'USD').toUpperCase(),kind:String(s.discount_kind||''),value:Number(s.discount_value)||0,label:String(s.discount_label||''),display:String(s.discount_display||'')}:null,
  membersEmbedByToken:()=>({lead_id:2}),getMemberPageBody:()=>({ok:true}),publicMemberSignup:()=>({ok:true}),publicMemberLogin:()=>({ok:true}),publicMemberLogout:()=>({ok:true}),publicMemberForgot:()=>({embed:{lead_id:2},request:null}),publicMemberReset:()=>({ok:true}),buildMemberResetMail:()=>null,
  createMembershipCheckoutByToken:()=>({ok:true}),joinFreeTierByToken:()=>({ok:true}),
  createPublicDataTableSubmissionByToken:()=>({ok:true,row:{id:1,status:'pending'},mode:'moderated'}),
  createPublicPhotoSubmissionByToken:()=>({embed:{lead_id:2},submission:{id:1},message:'fixture'}),
  validatePhotoSubmissionFields:()=>{},
  resolvePublicQrCode:()=>({leadId:2,code:{},payload:'fixture'}),renderQrCodeImage:async()=>({body:Buffer.from('fixture'),contentType:'image/png'}),
 },'../portalSiteEdits':{applyModuleAssetUpload:async()=>({src:'images/fixture.webp',publicUrl:'images/fixture.webp'})},'../../src/socialMedia':{},'../workspaceExists':{assertWorkspaceExists:guard},
 '../billing':{workspacePlan:async()=> 'free'},'../appUrls':{socialReturnPath:()=>'/app#/social'},
 '../contactForms':{parseWorkspaceFromToken:t=>Number(String(t).split('_')[0]),getPublicFormByToken:()=>({}),acceptSubmission:async()=>({})},
 '../chatbot':{getPublicConfigByToken:()=>({embed:{lead_id:2},settings:{}}),startOrGetSession:()=>({}),publicSession:()=>({}),postVisitorMessage:()=>({}),getSessionHistory:()=>({}),captureLead:()=>({})},
 '../chatbotVoice':{publicVoiceAdvertisement:async()=>({enabled:false}),mintVoiceSession:async()=>({}),relayVoiceToolCall:()=>({result:{ok:true}}),appendVoiceTranscript:()=>({}),readVoiceBubbleImage:()=>({mime:'image/png',buffer:Buffer.from('fixture')})},
 '../newsletter':{subscribeByToken:()=>({added:false,subscriberId:null,message:'fixture'})},
 '../comments':{createPublicComment:()=>({message:'fixture',status:'pending',comment:{id:1},thread:null}),togglePublicLike:()=>({liked:true,count:1,target_type:'page',target_id:'fixture'}),publicLikeState:()=>({item_liked:false,liked_comment_ids:[]})},
 '../captcha':{requireCaptcha:()=>((_q,_s,n)=>n()),getCaptchaConfig:async()=>({}),clientIp:()=> 'fixture'},
 '../rateLimit':{rateLimit:opts=>{rates.push(opts);return (_q,_s,n)=>n()}},
 // Batch 165 finisher: modulesPublic now requires the webinar engine at
 // load (mirrors the production-regressions stub map entries).
 '../webinars':{},
 './webinarsPublic':{makeGateLimit:()=>(_req,_res,next)=>next()},};
 load(file,mocks,{SESSION_SECRET:'synthetic-secret-for-tests'});
 return {routes,rates,counts:()=>({calls,authCalls})};
}
// Batch 165 finisher — coordinator-approved suite adaptation (2026-11-09).
// The six webinar MODULE routes in modulesPublic (GET list / state /
// messages / chat-stream, POST register / messages) are excluded from
// this suite's generic route harness. They cannot satisfy its contract
// and are not meant to: they are session-gated, so 401 without a gate
// session is the CORRECT product behaviour (this harness drives every
// route session-less and expects 200 for a known workspace / 400 for
// malformed IDs); the SSE chat/stream route needs a real req/res pair;
// and unknown embed/gate tokens resolve 404 by design (the Batch 163
// platform-webinar semantics). Their auth/status behaviour is pinned by
// tests/batch165-webinar-module-regressions.cjs (401 without/forged
// session, 403 wrong code, cross-token 404, detached-token 404) and by
// the Batch 165 live proof. Every other route in every file below stays
// fully exercised — the exception is exactly these six routes.
function harnessRoutes(file,routes){
 return routes.filter(r=>r.p!=='/meta/callback'&&!(file.endsWith('modulesPublic.js')&&r.p.startsWith('/webinar/')));
}
async function invoke(b,route,req){
 let status=200,body;const res={status(n){status=n;return this},json(v){body=v;return this},send(v){body=v;return this},redirect(v){body=v;return this},setHeader(){return this}};
 for(const h of route.handlers){let next=false;await h(req,res,()=>{next=true});if(!next)break}
 return {status,body};
}
function request(file,id){
 const req={params:{token:`${id}_fixture`},query:{w:String(id),workspaceId:String(id),date:'2030-01-01',session:'fixture',session_id:'fixture'},body:{w:id,action:'approve',message:'fixture',image:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='},get:()=> 'fixture'};
 if(file.includes('social'))req.params.token='fixture';return req;
}
async function main(){
 for(const file of ['server/routes/modulesPublic.js','server/routes/designPublic.js','server/routes/socialPublic.js','server/routes/formsPublic.js','server/routes/chatbotPublic.js']){
  for(const known of [false,true]){
   const b=build(file,known);
   const routes=harnessRoutes(file,b.routes);
   for(const route of routes){
    const before=b.counts().calls;const r=await invoke(b,route,request(file,1));
    assert.equal(r.status,known?200:404,file+' '+route.m+' '+route.p);
    // Batch 138: the chatbot config route reads the config AND the voice
    // advertisement — two withDb calls, both AFTER workspace validation
    // (the invariant this suite guards is unchanged: unknown workspace
    // still reaches domain zero times).
    const expectedCalls=known?(file.endsWith('chatbotPublic.js')&&route.m==='get'&&route.p==='/:token'?2:1):0;
    assert.equal(b.counts().calls-before,expectedCalls);
   }
   assert(b.rates.some(r=>r.windowMs===60000),'missing public read limiter');
  }
  results.push(file+': unknown workspace never reaches domain; valid workspace preserves routes');
  const b=build(file,true);for(const route of harnessRoutes(file,b.routes)){
   for(const id of [0,-1,1.5,Infinity]){const r=await invoke(b,route,request(file,id));assert.equal(r.status,400);}
  }
  assert.equal(b.counts().calls,0);results.push(file+': malformed workspace IDs never reach domain');
  if(file.endsWith('modulesPublic.js'))results.push(file+': six webinar module routes excluded from the generic harness (session-gated + SSE; pinned by the batch165 suite + live proof)');
 }
 for(const known of [false,true]){
  const b=build('server/routes/socialPublic.js',known);const route=b.routes.find(r=>r.p==='/meta/callback');
  const body=Buffer.from(JSON.stringify({w:1,l:2})).toString('base64url');
  const signature=crypto.createHmac('sha256','synthetic-secret-for-tests').update(body).digest('base64url');
  await invoke(b,route,{query:{code:'fixture',state:body+'.'+signature}});
  assert.equal(b.counts().calls,known?1:0);
 }
 results.push('signed social callback checks workspace existence before domain/OAuth work');
 const b=build('server/routes/socialPublic.js',true);await invoke(b,b.routes.find(r=>r.p==='/meta/callback'),{query:{code:'fixture',state:'bad.signature'}});assert.equal(b.counts().authCalls,0);
 results.push('invalid social state is rejected before workspace lookup');
 let queries=0;const helper=load('server/workspaceExists.js',{'./db':{query:async()=>{queries++;return []}}});
 await assert.rejects(helper.assertWorkspaceExists(999),e=>e.code==='NOT_FOUND');await assert.rejects(helper.assertWorkspaceExists(999),e=>e.code==='NOT_FOUND');assert.equal(queries,1);
 results.push('nonexistent workspaces are negatively cached without tenant database access');
 console.log(JSON.stringify({passed:results.length,results},null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1});
