'use strict';
// Explicit allowlist: scripts/ also contains operational scripts and must never be globbed.
const {spawnSync}=require('node:child_process');
const path=require('node:path');
const checks=[
 'content-generation-quality-regressions',
 'site-analytics-regressions','site-analytics-http','site-analytics-browser','site-analytics-portal-browser','knowledge-parser-regressions','ai-edit-await-regressions','ai-improvement-regressions',
 'job-concurrency-regressions','submission-encryption-regressions','oauth-token-regressions',
 'idempotency-regressions','ingestion-bounds-regressions','api-error-regressions',
 'account-link-regressions','account-link-browser-check','upsell-browser-check',
 'preview-security-regressions','preview-browser-check','schedule-regressions',
 'portal-navigation-regressions','portal-usertypes-regressions','google-reviews-regressions','seo-foundations-regressions','blog-static-regressions','blog-post-padding-regressions','claim-hold-regressions','claim-purchased-suppression-regressions','interested-followup-regressions','domain-payment-email-regressions','billing-renewal-regressions','domain-registrant-regressions','domain-dns-link-regressions','domain-dns-step-regressions','seo-base-url-regressions','batch45-deletes-regressions','batch45-pagination-regressions','batch47-hardening-regressions','batch48-mail-provider-regressions','batch49-finance-regressions','production-regressions','public-workspace-regressions',
 'url-safety-regressions','isolated-startup-check','mfa-totp-regressions','gbp-manager-regressions','batch50-menu-regressions','batch52-archives-fix-regressions','batch51-admin-cleanup-regressions','batch53-security-fixes-regressions','batch54-error-copy-regressions','batch55-hygiene-regressions','batch56-no-hardcoded-domains-regressions','batch57-plan-contents-regressions','batch58-landing-regressions','batch59-hostinger-deploy-regressions','batch60-legal-regressions','batch61-signup-plan-welcome-regressions'
];
if(process.argv.includes('--ocr'))checks.push('knowledge-ocr-check');
for(const name of checks){
 const result=spawnSync(process.execPath,['--unhandled-rejections=strict',path.join(__dirname,name+'.cjs')],{
  cwd:path.resolve(__dirname,'..'),env:{...process.env,DB_DRIVER:'sqlite'},stdio:'inherit',timeout:180000
 });
 if(result.error||result.status!==0){console.error('FAILED:',name,result.error?.message||result.status);process.exit(1)}
}
console.log(JSON.stringify({regressionFiles:checks.length,passed:true,syntheticOnly:true}));
