'use strict';
/**
 * Batch 111 (consolidation step 4) — test bridge for the monolith
 * split. Older suites were written against server/clientPortal.js
 * and server/museAgent.js as single files: they read the source,
 * slice function bodies out of it, substring-pin doctrine text, or
 * eval the whole file in a vm with stubbed requires.
 *
 * The split moved those bodies VERBATIM into focused modules
 * (motion proven byte-for-byte). This helper reassembles the
 * single-scope source those suites expect: each split file's body
 * (generated prologue — 'use strict', header comment, require
 * lines — and its trailing module.exports stripped), in the
 * original file order, plus a shorthand exports block rebuilt from
 * the facade's pick list (the original exports were shorthand).
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

function bodyOf(src) {
  const lines = src.split('\n');
  let i = 0;
  // Phase A: 'use strict', blanks and the generated header comment —
  // everything before the first require or code line.
  while (i < lines.length) {
    const l = lines[i];
    if (l.trim() === '' || l === "'use strict';" || l.startsWith('/*') || l.startsWith(' *') || l.startsWith('//')) { i += 1; continue; }
    break;
  }
  // Phase B: the require block (+ blanks, + facade destructure
  // lines). Anything after — including doc comments that led the
  // original region — is body.
  while (i < lines.length) {
    const l = lines[i];
    if (l.trim() === '' || /^const .* = require\(/.test(l) || /^const \{[^}]*\} = [A-Za-z_$][\w$]*;$/.test(l)) { i += 1; continue; }
    break;
  }
  let text = lines.slice(i).join('\n');
  const expAt = text.lastIndexOf('\nmodule.exports = {');
  if (expAt > -1) text = text.slice(0, expAt + 1);
  return text.replace(/\s+$/, '');
}
function facadeNames(facadeSrc) {
  const s = facadeSrc.indexOf('module.exports = {');
  const e = facadeSrc.indexOf('};', s);
  const names = [];
  for (const line of facadeSrc.slice(s, e).replace(/\/\/[^\n]*/g, '').split('\n')) {
    const m = line.match(/^ {2}([A-Za-z_$][\w$]*)\s*[:,]?\s*$/ ) || line.match(/^ {2}([A-Za-z_$][\w$]*): /);
    if (m) names.push(m[1]);
  }
  return names;
}
const CP_HEADER = "'use strict';\n\n/**\n * Client portal — end-customer identity (separate from staff workspace users).\n * Linked by contact email on leads / design jobs / social campaigns.\n */\n\nconst crypto = require('crypto');\nconst fs = require('fs');\nconst path = require('path');\nconst bcrypt = require('bcryptjs');\nconst { query, driver } = require('./db');\nconst portalTabs = require('./portalTabs');\nconst { sendPlatformMail } = require('./mailer');\nconst { appUrl } = require('./stripeClient');\nconst { openWorkspaceDb, dataRoot } = require('./workspaceDb');\n";
const MA_HEADER = "'use strict';\n\n/**\n * Meta Muse Model API agent loop for Hands-off mode.\n * OpenAI-compatible chat/completions + tools → server/mcp.js callTool (workspace scope).\n */\n\nconst platform = require('./platform');\nconst crypto = require('node:crypto');\nconst { defaultWebsiteInstructions } = require('../src/defaultDesignInstructions');\n// Batch 94: the PLANNER module owns the defaults doctrine +\n// convergence policy as data (server/siteChatPlanner.js), and the\n// capability registry (server/portalCapabilities.js) derives what\n// the agent may claim it can do from the tools it actually has.\n// Prompts below CONSUME both — they keep no private copies, so\n// the four-role rebuild can lift the policy without the prompts.\nconst chatPlanner = require('./siteChatPlanner');\nconst { portalCapabilityText } = require('./portalCapabilities');\n";

function assemble(parts, facadeFile, header) {
  const bodies = parts.map((f) => bodyOf(read('server/' + f)));
  const names = facadeNames(read('server/' + facadeFile));
  return header + '\n' + bodies.join('\n') + '\nmodule.exports = {\n' + names.map((n) => '  ' + n + ',').join('\n') + '\n};\n';
}

function clientPortalSource() {
  return assemble(
    ['portalAccounts.js', 'portalShared.js', 'portalSiteEdits.js', 'portalSocial.js', 'portalForms.js', 'portalModules.js', 'portalBilling.js', 'portalLeadScout.js', 'portalSiteChat.js'],
    'clientPortal.js', CP_HEADER
  );
}
function museAgentSource() {
  return assemble(
    ['museAgentTools.js', 'museAgentCore.js', 'museAgentClassifier.js', 'museAgentPlanner.js', 'museAgent.js'],
    'museAgent.js', MA_HEADER
  );
}

module.exports = { clientPortalSource, museAgentSource, bodyOf };
