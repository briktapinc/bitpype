'use strict';
// Explicit allowlist: scripts/ also contains operational scripts and must never be globbed.
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const checks = [
  'content-generation-quality-regressions',
  'site-analytics-regressions',
  'site-analytics-http',
  'site-analytics-browser',
  'site-analytics-portal-browser',
  'knowledge-parser-regressions',
  'ai-edit-await-regressions',
  'ai-improvement-regressions',
  'job-concurrency-regressions',
  'submission-encryption-regressions',
  'oauth-token-regressions',
  'idempotency-regressions',
  'ingestion-bounds-regressions',
  'api-error-regressions',
  'account-link-regressions',
  'account-link-browser-check',
  'upsell-browser-check',
  'preview-security-regressions',
  'preview-browser-check',
  'schedule-regressions',
  'portal-navigation-regressions',
  'portal-usertypes-regressions',
  'google-reviews-regressions',
  'seo-foundations-regressions',
  'blog-static-regressions',
  'blog-post-padding-regressions',
  'claim-hold-regressions',
  'claim-purchased-suppression-regressions',
  'interested-followup-regressions',
  'domain-payment-email-regressions',
  'billing-renewal-regressions',
  'domain-registrant-regressions',
  'domain-dns-link-regressions',
  'domain-dns-step-regressions',
  'seo-base-url-regressions',
  'batch45-deletes-regressions',
  'batch45-pagination-regressions',
  'batch47-hardening-regressions',
  'batch48-mail-provider-regressions',
  'batch49-finance-regressions',
  'production-regressions',
  'public-workspace-regressions',
  'url-safety-regressions',
  'isolated-startup-check',
  'mfa-totp-regressions',
  'gbp-manager-regressions',
  'batch50-menu-regressions',
  'batch52-archives-fix-regressions',
  'batch51-admin-cleanup-regressions',
  'batch53-security-fixes-regressions',
  'batch54-error-copy-regressions',
  'batch55-hygiene-regressions',
  'batch56-no-hardcoded-domains-regressions',
  'batch57-plan-contents-regressions',
  'batch58-landing-regressions',
  'batch59-hostinger-deploy-regressions',
  'batch60-legal-regressions',
  'batch61-signup-plan-welcome-regressions',
  'batch62-token-scope-ai-costs-regressions',
  'batch63-lifecycle-comms-regressions',
  'batch64-preview-archive-gate-regressions',
  'batch65-rentals-delete-regressions',
  'batch66-services-modules-delete-regressions',
  'batch67-preview-gate-hardening-regressions',
  'batch68-hostinger-safety-regressions',
  'batch69-renewal-derivation-regressions',
  'batch70-landing-thankyou-regressions',
  'batch71-mailing-list-regressions',
  'batch72-clear-activity-regressions',
  'batch73-onboarding-regressions',
  'batch74-onboarding-checklist-regressions',
  'batch75-disclaimer-regressions',
  'batch76-missed-call-rescue-regressions',
  'batch77-sms-policy-regressions',
  'batch78-pages-not-popups-regressions',
  'batch79-creator-regressions',
  'batch80-partner-regressions',
  'batch81-lead-page-spacing-regressions',
  'batch82-member-nav-logout-regressions',
  'batch83-official-logo-regressions',
  'batch84-agent-soul-regressions',
  'batch85-lead-delete-attachments-regressions',
  'batch86-logo-lockup-correction-regressions',
  'batch87-branding-settings-regressions',
  'batch88-datatables-regressions',
  'batch89-design-chat-attachments-regressions',
  'batch90-charts-regressions',
  'batch91-module-cards-regressions',
  'batch92-brand-files-regressions',
  'batch93-agentic-chat-regressions',
  'batch94-chat-defaults-regressions',
  'batch96-chat-memory-regressions',
  'batch97-chat-caps-regressions',
  'batch98-planner-implementor-regressions',
  'batch99-critic-reviewer-regressions',
  'batch100-rolling-summary-regressions',
  'batch101-isolation-queue-regressions',
  'batch102-security-regressions',
  'batch103-licensee-regressions',
  'batch104-optimistic-preview-regressions',
  'batch105-portal-shell-regressions',
  'batch106-provider-tracking-regressions',
  'batch107-mobile-overflow-regressions',
  'batch108-card-spacing-regressions',
  'batch109-gatewrap-regressions',
  'batch110-chat-widget-regressions',
  'batch111-consolidation-regressions',
  'batch113-mobile-dropdown-tabs-regressions',
  'batch114-wordpress-plugin-regressions',
  'batch115-catalog-scroll-row-regressions',
  'batch116-external-website-kind-regressions',
  'batch117-wp-design-regressions',
  'batch118-newsletter-regressions',
  'batch119-suspension-regressions',
  'batch120-ai-routing-regressions',
  'batch121-portal-password-set-regressions',
  'batch122-shared-module-layer-regressions',
  'batch123-openrouter-regressions',
  'batch124-categories-regressions',
  'batch125-photocapture-regressions',
  'batch130-item-fallback-regressions',
  'batch131-comments-regressions',
  'batch132-photocapture-file-lifecycle-regressions',
  'batch126-qrcode-generator-regressions',
  'batch127-product-variants-regressions',
  'batch128-checkout-module-regressions',
  'batch129-streamline-regressions',
  'batch134-hunt-fixes-regressions',
  'batch135-spacing-regressions',
  'batch133-universal-detail-regressions',
  'batch142-checkout-nav-cart-regressions',
  'batch141-detail-polish-regressions',
  'batch143-review-fixes-regressions',
  'batch145-external-review-fixes-regressions',
  'batch136-booking-discount-regressions',
  'batch137-chat-qualifying-questions-regressions',
  'batch144-auth-gate-dark-regressions',
  'batch146-logo-ground-regressions',
  'batch147-section-editor-regressions',
  'batch148-section-layout-knobs-regressions',
  'batch149-save-idempotency-regressions',
  'batch152-global-css-script-regressions',
  'batch154-section9-security-regressions',
  'batch138-voice-agent-regressions',
  'batch139-pricing-module-regressions',
  'batch140-industry-default-questions-regressions',
  'batch153-design-types-regressions',
  'batch151-knowledge-sources-regressions',
  'batch155-single-site-backup',
  'batch156-site-fingerprint',
  'batch160-job-lock-atomic-claim',
  'batch157-business-card-regressions',
  'batch158-reviews-social-regressions',
  'batch159-fingerprint-effective-brand',
  'batch161-assistant-chat-regressions',
  'batch162-lead-calling-regressions',
  'batch163-webinars-regressions',
  'batch164-custom-code-module',
  'batch165-webinar-module-regressions',
  'batch166-assistant-mobile-layout-regressions',
  'batch167-chat-redesign-regressions',
  'batch168-review-fixes-regressions',
  'batch169-themes-wizard-regressions',
  'batch170-assistant-usage-tab-regressions',
  'batch171-staff-themes-design-page-regressions',
  'batch172-portal-themes-removal-regressions',
  'batch173-theme-view-build-page-regressions',
  'batch174-design-chat-parity-regressions',
  'batch175-themes-promotion-regressions',
  'batch177-demo-portal-account',
  'batch178-leads-router-regressions',
  'batch179-themes-promotion-regressions',
  'batch180-security-fixes-regressions',
  'batch181-detail-video-regressions',
  'batch182-domain-flow-regressions',
  'batch183-leads-explorer-regressions',
  'batch184-claim-live-domain-regressions',
  'batch185-spacing-enforcement-regressions',
  'batch186-chrome-spacing-regressions',
  'batch187-fullwidth-bands-regressions',
  'batch188-section-variants-foundation-regressions',
  'platform-schema-parity-regressions',
];
if (process.argv.includes('--ocr')) checks.push('knowledge-ocr-check');

// ---------------------------------------------------------------------
// Batch 112 — dual-dialect gate.
// Default mode is the historical one: every suite runs with
// DB_DRIVER=sqlite (suites pin a fresh temp platform file each).
// `--mysql` runs the SAME allowlist against a real MySQL-compatible
// server — production's platform dialect. Suites select the dialect
// through REGRESSION_DB_DRIVER (default 'sqlite'), and each suite
// gets a FRESH MySQL database, the exact analogue of the fresh temp
// sqlite file the harnesses pin today. Connection settings come from
// GATE_MYSQL_HOST / GATE_MYSQL_PORT / GATE_MYSQL_USER /
// GATE_MYSQL_PASSWORD (defaults: 127.0.0.1:3306 scout/gate-scout);
// the user must be able to CREATE/DROP databases on the gate server
// (the gate server is a throwaway container, never production).
// REGRESSION_CONTINUE=1 is an exploration aid that runs every suite
// and collects all failures; the canonical gate leaves it unset —
// first failure aborts, fail-closed. REGRESSION_ONLY=a,b restricts
// the run to named suites (local iteration only).
// ---------------------------------------------------------------------
const MYSQL_MODE = process.argv.includes('--mysql');
const CONTINUE = process.env.REGRESSION_CONTINUE === '1';
const ONLY = (process.env.REGRESSION_ONLY || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Suites excluded from the MySQL pass, each with its reason. Any
// suite NOT listed here must pass on MySQL; a failure aborts the
// gate. Keep this map empty unless a harness is dialect-bound by
// construction — behavioural coverage belongs on both dialects.
const MYSQL_SKIP = {
  'oauth-token-regressions':
    'harness is bound to the platform SQLite file by construction: it opens SQLITE_PATH directly with better-sqlite3 for storage assertions, evaluates mcpOAuth in a VM sandbox whose env is pinned to sqlite, and boots its child server with a pinned sqlite env. Token-policy behaviour through the facade is covered on MySQL by the full-server suites (batch102-security, mfa-totp, batch62-token-scope).',
};

const GATE_MYSQL = {
  host: process.env.GATE_MYSQL_HOST || '127.0.0.1',
  port: Number(process.env.GATE_MYSQL_PORT || 3306),
  user: process.env.GATE_MYSQL_USER || 'scout',
  password: process.env.GATE_MYSQL_PASSWORD || 'gate-scout',
};

async function resetMysqlDatabase(name) {
  const mysql = require('mysql2/promise');
  const conn = await mysql.createConnection({
    host: GATE_MYSQL.host,
    port: GATE_MYSQL.port,
    user: GATE_MYSQL.user,
    password: GATE_MYSQL.password,
  });
  try {
    await conn.query(`DROP DATABASE IF EXISTS \`${name}\``);
    await conn.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  } finally {
    await conn.end();
  }
}

(async () => {
  const failures = [];
  const skipped = [];
  let ran = 0;
  for (const [idx, name] of checks.entries()) {
    if (ONLY.length && !ONLY.includes(name)) continue;
    if (MYSQL_MODE && MYSQL_SKIP[name]) {
      skipped.push(name);
      console.log(`SKIP (mysql pass): ${name} — ${MYSQL_SKIP[name]}`);
      continue;
    }
    let env;
    if (MYSQL_MODE) {
      const dbName = 'gate_' + String(idx).padStart(3, '0') + '_' + name.replace(/[^a-z0-9]+/gi, '_').slice(0, 40);
      await resetMysqlDatabase(dbName);
      env = {
        ...process.env,
        REGRESSION_DB_DRIVER: 'mysql',
        DB_DRIVER: 'mysql',
        MYSQL_HOST: GATE_MYSQL.host,
        MYSQL_PORT: String(GATE_MYSQL.port),
        MYSQL_USER: GATE_MYSQL.user,
        MYSQL_PASSWORD: GATE_MYSQL.password,
        MYSQL_DATABASE: dbName,
        // Propagate the pool-release preload into every node process a
        // suite spawns (seed children, fixture servers): a grandchild
        // that opens the platform pool would otherwise never exit and
        // hang its parent's spawnSync. The preload self-arms only under
        // REGRESSION_DB_DRIVER=mysql and never releases while a process
        // holds real work handles (a listening server included).
        NODE_OPTIONS: (
          (process.env.NODE_OPTIONS || '') +
          ' --require ' +
          path.join(__dirname, 'lib', 'gatePoolRelease.cjs')
        ).trim(),
      };
    } else {
      env = { ...process.env, DB_DRIVER: 'sqlite', REGRESSION_DB_DRIVER: 'sqlite' };
    }
    ran++;
    // MySQL pass only: the pool-release preload reaches suite
    // processes (and their node children) via NODE_OPTIONS in the
    // spawn env above — see tests/lib/gatePoolRelease.cjs. SQLite
    // mode is untouched.
    const args = ['--unhandled-rejections=strict', path.join(__dirname, name + '.cjs')];
    const result = spawnSync(process.execPath, args, {
      cwd: path.resolve(__dirname, '..'),
      env,
      stdio: 'inherit',
      timeout: MYSQL_MODE ? 300000 : 180000,
    });
    if (result.error || result.status !== 0) {
      console.error('FAILED:', name, result.error?.message || result.status);
      failures.push(name);
      if (!CONTINUE) process.exit(1);
    }
  }
  console.log(
    JSON.stringify({
      regressionFiles: checks.length,
      ran,
      passed: failures.length === 0,
      driver: MYSQL_MODE ? 'mysql' : 'sqlite',
      skipped,
      failures,
      syntheticOnly: true,
    })
  );
  process.exit(failures.length ? 1 : 0);
})().catch((e) => {
  console.error('RUNNER ERROR:', (e && e.message) || e);
  process.exit(1);
});
