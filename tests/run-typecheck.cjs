'use strict';
// Batch 112 Job 3 — gate type step.
//
// Runs the vendored TypeScript compiler over tsconfig.checkjs.json.
// The config keeps checkJs OFF globally; only the files listed there
// carry `// @ts-check` (the Batch 111 module set + the platform
// facade), so errors are enforced exactly on that scope and nowhere
// else. Annotations only — this step must stay green without any
// logic changes.
//
// tsc resolution: node_modules/typescript if present, else the
// vendored tarball at vendor/typescript-5.9.3.tgz extracted to a
// temp dir (mirrors the vendor/xlsx precedent: the tgz travels with
// the tree but is not installed into node_modules).
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');

function locateTsc() {
  const inModules = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  if (fs.existsSync(inModules)) return inModules;
  const tgz = path.join(root, 'vendor', 'typescript-5.9.3.tgz');
  if (!fs.existsSync(tgz)) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b112-tsc-'));
  execFileSync('tar', ['-xzf', tgz, '-C', dir], { stdio: 'inherit' });
  const extracted = path.join(dir, 'package', 'bin', 'tsc');
  return fs.existsSync(extracted) ? extracted : null;
}

function main() {
  const tsc = locateTsc();
  if (!tsc) {
    console.error('TYPECHECK FAIL: TypeScript compiler not found (node_modules/typescript nor vendor/typescript-5.9.3.tgz)');
    process.exit(1);
  }
  let out = '';
  let code = 0;
  try {
    out = execFileSync(process.execPath, [tsc, '-p', path.join(root, 'tsconfig.checkjs.json')], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (e) {
    code = e.status || 1;
    out = (e.stdout || '') + (e.stderr || '');
  }
  const errors = out.split('\n').filter((l) => /error TS\d+/.test(l));
  if (code !== 0 || errors.length) {
    console.error(`TYPECHECK FAIL: ${errors.length} error(s) in the @ts-check scope`);
    for (const line of errors) console.error('  ' + line);
    process.exit(1);
  }
  const scope = JSON.parse(fs.readFileSync(path.join(root, 'tsconfig.checkjs.json'), 'utf8')).files;
  console.log(`TYPECHECK PASS: ${scope.length} @ts-check files clean (tsc via ${path.relative(root, tsc) || tsc})`);
}

main();
