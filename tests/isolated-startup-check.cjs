'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process');
const root=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'bitpype-startup-'));
let output='';
const child=spawn(process.execPath,[path.join(root,'server.js')],{cwd:root,env:{
 PATH:process.env.PATH,HOME:process.env.HOME,NODE_ENV:'production',DB_DRIVER:process.env.REGRESSION_DB_DRIVER||'sqlite',
 ...(process.env.REGRESSION_DB_DRIVER==='mysql'?{MYSQL_HOST:process.env.MYSQL_HOST,MYSQL_PORT:process.env.MYSQL_PORT,MYSQL_USER:process.env.MYSQL_USER,MYSQL_PASSWORD:process.env.MYSQL_PASSWORD,MYSQL_DATABASE:process.env.MYSQL_DATABASE}:{}),
 SQLITE_PATH:path.join(temp,'auth.sqlite'),WORKSPACE_DATA_DIR:path.join(temp,'workspaces'),EXPORT_ROOT:path.join(temp,'exports'),
 SESSION_SECRET:'isolated-synthetic-session-secret-2026',SETTINGS_ENCRYPTION_KEY:Buffer.alloc(32,23).toString('base64'),APP_URL:'https://bitpype.com',CAPTCHA_OPTIONAL:'1',PORT:'31337',
 },stdio:['ignore','pipe','pipe']});
child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
const closed=new Promise(resolve=>child.once('close',(code)=>resolve(code)));
async function main(){
 try{
  let ready=false;
  // Batch 125 finisher: a fresh-MySQL boot on the gate host measures
  // ~10-12s (full platform migrate before listen), which straddled the
  // old 100-poll (~10s) window and flaked the MySQL leg while every
  // assertion passed. 600 polls keeps a hard bound (~60s) with room
  // for loaded-gate boots; no assertion is changed.
  for(let n=0;n<600;n++){
   if(child.exitCode!=null)throw Error('Isolated app exited: '+output);
   try{const r=await fetch('http://127.0.0.1:31337/health',{signal:AbortSignal.timeout(500)});if(r.ok){ready=true;break}}catch{}
   await new Promise(r=>setTimeout(r,100));
  }
  assert(ready,'app did not become ready: '+output);
  for(const url of ['/api/v1/portal/me','/api/v1/jobs','/api/v1/auth/me','/mcp']){
   const r=await fetch('http://127.0.0.1:31337'+url,{headers:{Origin:'null'},signal:AbortSignal.timeout(3000)});assert.equal(r.status,403,url);assert.equal((await r.json()).code,'PREVIEW_ORIGIN_DENIED');
  }
  const publicCaptcha=await fetch('http://127.0.0.1:31337/api/v1/captcha/config',{headers:{Origin:'null'}});assert.equal(publicCaptcha.status,200);assert.equal(publicCaptcha.headers.get('access-control-allow-origin'),'*');
  const publicClaim=await fetch('http://127.0.0.1:31337/api/v1/outreach/public/claim/fixture',{headers:{Origin:'null'}});assert.equal(publicClaim.status,400);assert.equal(publicClaim.headers.get('access-control-allow-origin'),'*');
  assert.equal((await fetch('http://127.0.0.1:31337/favicon.ico')).status,204);
  fs.mkdirSync(path.join(temp,'exports'),{recursive:true});fs.writeFileSync(path.join(temp,'exports','isolated-fixture.html'),'<h1>Fixture</h1>');
  const fallback=await fetch('http://127.0.0.1:31337/site-previews/isolated-fixture.html');assert.equal(fallback.status,200);assert(fallback.headers.get('content-security-policy').includes('sandbox allow-scripts allow-forms;'));
  for(const [url,status]of [['/app',200],['/portal',200],['/api/v1/auth/me',401],['/api/v1/portal/me',401],['/api/v1/captcha/config',200],['/api/v1/website-promo/config',200]]){
   const r=await fetch('http://127.0.0.1:31337'+url,{signal:AbortSignal.timeout(3000)});assert.equal(r.status,status,url);await r.arrayBuffer();
  }
  for(const url of ['/api/v1/modules/public/982341_'+ 'a'.repeat(48),'/api/v1/forms/public/982341_'+'a'.repeat(48),'/api/v1/chat/public/982341_'+'a'.repeat(48),'/api/v1/design/public/form/fixture?w=982341','/api/v1/social/approve/fixture?w=982341']){
   const r=await fetch('http://127.0.0.1:31337'+url,{signal:AbortSignal.timeout(3000)});assert.equal(r.status,404,url);assert.equal((await r.json()).code,'NOT_FOUND');
  }
  assert(!fs.existsSync(path.join(temp,'workspaces','982341')),'invalid request created a workspace directory');
  console.log(JSON.stringify({isolatedStartup:true,publicWorkspaceRejections:5,noTenantFilesCreated:true,restoredFeatureRoutes:true}));
 }finally{child.kill('SIGTERM');await closed;fs.rmSync(temp,{recursive:true,force:true});}
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
