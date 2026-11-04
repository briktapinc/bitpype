'use strict';
// Batch 112 Job 4 — gate format step.
//
// The codebase predates enforced formatting (100+ files would not
// pass a repo-wide prettier check, and reformatting them is
// explicitly out of scope). This step therefore enforces the
// repo's own .prettierrc style ONLY on the files this push owns
// outright — the new gate tooling — so new drift stops here
// without rewriting history. Files are added to SCOPE only when a
// push creates or fully rewrites them.
//
// Prettier resolution mirrors run-typecheck.cjs: node_modules
// first, else the vendored tarball vendor/prettier-3.3.3.tgz.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');

const SCOPE = [
  'tests/run-regressions.cjs',
  'tests/run-typecheck.cjs',
  'tests/run-formatcheck.cjs',
  'tests/lib/schemaDump.cjs',
  'tests/lib/platformTestDb.cjs',
  'tests/lib/gatePoolRelease.cjs',
  'tests/platform-schema-parity-regressions.cjs',
  'server/wpPlugin.js',
  'server/routes/wordpressPublic.js',
  'tests/batch114-wordpress-plugin-regressions.cjs',
  'tests/batch115-catalog-scroll-row-regressions.cjs',
  'tests/batch116-external-website-kind-regressions.cjs',
  'server/wpDesignOps.js',
  'server/wpDesign.js',
  'server/wpDesignChat.js',
  'tests/batch117-wp-design-regressions.cjs',
  'server/newsletter.js',
  'server/routes/newsletterPublic.js',
  'tests/batch118-newsletter-regressions.cjs',
  'server/subscriptionSuspension.js',
  'tests/batch119-suspension-regressions.cjs',
  'server/aiRouting.js',
  'tests/batch120-ai-routing-regressions.cjs',
  'server/portalPassword.js',
  'tests/batch121-portal-password-set-regressions.cjs',
  'server/moduleShare.js',
  'tests/batch122-shared-module-layer-regressions.cjs',
  'tests/batch123-openrouter-regressions.cjs',
  'server/categories.js',
  'tests/batch124-categories-regressions.cjs',
  'tests/batch125-photocapture-regressions.cjs',
  'tests/batch130-item-fallback-regressions.cjs',
  'tests/batch132-photocapture-file-lifecycle-regressions.cjs',
  'tests/batch126-qrcode-generator-regressions.cjs',
  'tests/batch127-product-variants-regressions.cjs',
  'tests/batch128-checkout-module-regressions.cjs',
  'server/paymentsConfig.js',
  'server/routes/paymentsWebhook.js',
  'tests/batch129-streamline-regressions.cjs',
  'tests/batch134-hunt-fixes-regressions.cjs',
  'server/spacingQa.js',
  'tests/batch135-spacing-regressions.cjs',
  'tests/batch133-universal-detail-regressions.cjs',
  'tsconfig.checkjs.json',
];

function locatePrettier() {
  const inModules = path.join(root, 'node_modules', 'prettier', 'bin', 'prettier.cjs');
  if (fs.existsSync(inModules)) return inModules;
  const tgz = path.join(root, 'vendor', 'prettier-3.3.3.tgz');
  if (!fs.existsSync(tgz)) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b112-prettier-'));
  execFileSync('tar', ['-xzf', tgz, '-C', dir], { stdio: 'inherit' });
  const extracted = path.join(dir, 'package', 'bin', 'prettier.cjs');
  return fs.existsSync(extracted) ? extracted : null;
}

function main() {
  const missing = SCOPE.filter((f) => !fs.existsSync(path.join(root, f)));
  if (missing.length) {
    console.error('FORMATCHECK FAIL: scope files missing: ' + missing.join(', '));
    process.exit(1);
  }
  const prettier = locatePrettier();
  if (!prettier) {
    console.error('FORMATCHECK FAIL: prettier not found (node_modules/prettier nor vendor/prettier-3.3.3.tgz)');
    process.exit(1);
  }
  let out = '';
  let code = 0;
  try {
    out = execFileSync(process.execPath, [prettier, '--check', ...SCOPE], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (e) {
    code = e.status || 1;
    out = (e.stdout || '') + (e.stderr || '');
  }
  if (code !== 0) {
    console.error('FORMATCHECK FAIL: files not in repo prettier style:');
    console.error(out.trim());
    process.exit(1);
  }
  console.log(`FORMATCHECK PASS: ${SCOPE.length} owned files in repo style (prettier 3.3.3)`);
}

main();
