'use strict';

/* ------------------------------------------------------------------ */
/* Batch 199 — SECTION SCRIPTS (Module Customization, Part D1)         */
/*                                                                     */
/* Ely's ask (2026-11-19): "I want it to be able to add 3D js, etc     */
/* to designs as well." Part A (Batch 197) made section LAYOUT custom  */
/* via section.template; Part D1 adds the sibling SCRIPT slot:         */
/*                                                                     */
/*   section.js       — the agent's JavaScript for this section        */
/*   section.libs     — registry library ids it needs (scriptLibs.js)  */
/*   section.jsModule — true when the script is an ES module that      */
/*                      imports registry specifiers (e.g. "three")     */
/*   section.jsExpect — optional CSS selector QA asserts after run     */
/*                                                                     */
/* Storage discipline is Batch 148/188/197: every field exists ONLY    */
/* when set — a section without `js` renders byte-identically to       */
/* before, with no extra attributes or tags. Available on exactly the  */
/* types Part A enables templates for (chrome / html / columns / the   */
/* Family B mounts are fenced for the same recorded reasons), with or  */
/* without a custom template (spec Q3: yes).                           */
/*                                                                     */
/* Execution contract (spec §5.1): scripts are collected per page and  */
/* emitted at BODY END (after theme/page JS, in section order), each   */
/* wrapped so it receives its own section root as `root` / `el` (the   */
/* Custom Code module's contract) inside a per-instance try/catch. A   */
/* script that throws marks its root data-bp-js-error="1" and the      */
/* static design stands; a declared classic library that failed to     */
/* load marks data-bp-js-skipped="lib-missing" and the script never    */
/* runs. Scripts NEVER execute on the platform origin: the engine      */
/* emits nothing for the portal edit canvas / layout editor, and the   */
/* section root stamp (data-bp-sec) is likewise visitor-render only.   */
/* The freestyle-section script ban (SECTION_SCRIPT) is untouched —    */
/* this slot is the sanctioned channel, never <script> in content.     */
/*                                                                     */
/* Validation (spec §7.1) is save-time, on every write path: size      */
/* caps, a syntax check (vm.Script parse — never executed), a small    */
/* static denylist (provenance/attribution rules, named on reject),    */
/* registry membership + kind coherence for libs, and registry-only    */
/* import specifiers for module scripts.                               */
/* ------------------------------------------------------------------ */

const vm = require('node:vm');
const sectionTemplates = require('./sectionTemplates');
const scriptLibs = require('./scriptLibs');

const MAX_SECTION_JS_CHARS = 50000;
const MAX_PAGE_JS_CHARS = 150000;
const MAX_JS_EXPECT_CHARS = 120;

/* --------------------------- accessors --------------------------- */

function jsOf(section) {
  const s = section || {};
  return typeof s.js === 'string' && s.js.trim() ? s.js : '';
}

function hasSectionJs(section) {
  return jsOf(section) !== '';
}

function libsOf(section) {
  const s = section || {};
  return Array.isArray(s.libs) ? s.libs.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : [];
}

function isJsModule(section) {
  return !!(section && section.jsModule === true);
}

function jsExpectOf(section) {
  const s = section || {};
  return typeof s.jsExpect === 'string' && s.jsExpect.trim() ? s.jsExpect.trim() : '';
}

/** The address a section's root carries in visitor renders, and the
 * key its wrapper script resolves it by. Page/section indices are the
 * section's position in the page's rendered section list. */
function secKeyFor(pageIndex, sectionIndex) {
  return `p${Number(pageIndex) || 0}-s${Number(sectionIndex) || 0}`;
}

/* --------------------------- denylist ---------------------------- */
/* Spec §6/§7.1: deliberately small. These are provenance rules —     */
/* they keep every script's behaviour statically attributable and     */
/* QA-observable; runtime QA (export script pass) is the second       */
/* layer. Each reject names its rule.                                 */

const DENYLIST = [
  {
    re: /\beval\s*\(/,
    code: 'SECTION_JS_DENIED',
    message: 'eval() is not allowed in section scripts — write the logic directly.',
  },
  {
    re: /\bFunction\s*\(/,
    code: 'SECTION_JS_DENIED',
    message: 'the Function constructor is not allowed in section scripts — write the logic directly.',
  },
  {
    re: /document\s*\.\s*write\s*\(/,
    code: 'SECTION_JS_DENIED',
    message: 'document.write() is not allowed in section scripts — build DOM nodes instead.',
  },
  {
    re: /document\s*\.\s*cookie\b/,
    code: 'SECTION_JS_DENIED',
    message: 'document.cookie access is not allowed in section scripts.',
  },
  {
    re: /createElement\s*\(\s*(['"])script\1/i,
    code: 'SECTION_JS_DENIED',
    message:
      'dynamic script injection is not allowed in section scripts — declare libraries via libs (registry) instead.',
  },
  {
    re: /\/api\/v1\//,
    code: 'SECTION_JS_DENIED',
    message: 'section scripts may not reference platform API paths (/api/v1/…).',
  },
  {
    re: /<\/script/i,
    code: 'SECTION_JS_DENIED',
    message: 'section scripts may not contain "</script" sequences.',
  },
];

function denylistHits(code) {
  const hits = [];
  for (const rule of DENYLIST) {
    if (rule.re.test(code)) hits.push(rule);
  }
  // Dynamic import(): only registry specifier literals are allowed
  // (spec §6). A non-literal specifier is unverifiable → denied.
  const dynRe = /\bimport\s*\(\s*(['"])([^'"]*)\1\s*\)/g;
  let m;
  while ((m = dynRe.exec(code))) {
    if (!scriptLibs.isRegistrySpecifier(m[2])) {
      hits.push({
        code: 'SECTION_JS_DENIED',
        message: `dynamic import("${m[2]}") is not allowed — only registry specifiers (${registrySpecifierList()}) may be imported.`,
      });
    }
  }
  if (/\bimport\s*\(\s*[^'")\s]/.test(code)) {
    hits.push({
      code: 'SECTION_JS_DENIED',
      message: 'dynamic import() must name a registry specifier as a string literal.',
    });
  }
  return hits;
}

function registrySpecifierList() {
  const out = [];
  for (const l of scriptLibs.LIBS) {
    if (l.importMap) out.push(...Object.keys(l.importMap));
  }
  return out.join(', ') || 'none';
}

/* --------------------- module import splitting ------------------- */
/* Module scripts are wrapped (root/el binding + try/catch), so      */
/* their top-level import declarations are hoisted OUT of the         */
/* wrapper and emitted verbatim above it (imports hoist in modules    */
/* anyway — spec §5.1). The splitter is deliberately conservative:    */
/* imports must sit at the top of the file (after blank/comment       */
/* lines), one statement per declaration, terminated by its           */
/* specifier line. Anything else import-shaped in the body is a       */
/* save-time reject with guidance, never a mangled emit.              */

function splitModuleImports(code) {
  const lines = String(code || '').split('\n');
  const imports = [];
  let i = 0;
  // Skip leading blank / comment lines (they stay with the imports
  // block — comments above imports are emitted above the wrapper).
  const lead = [];
  while (i < lines.length) {
    const line = lines[i];
    const t = line.trim();
    if (t === '' || t.startsWith('//')) {
      lead.push(line);
      i += 1;
      continue;
    }
    if (/^\/\*/.test(t)) {
      // Block comment: consume to the closing marker.
      let j = i;
      let closed = false;
      while (j < lines.length) {
        lead.push(lines[j]);
        if (lines[j].includes('*/')) {
          closed = true;
          j += 1;
          break;
        }
        j += 1;
      }
      if (!closed) return { ok: false, message: 'unterminated block comment at the top of the module script.' };
      i = j;
      continue;
    }
    break;
  }
  while (i < lines.length) {
    const t = lines[i].trim();
    if (t === '') {
      i += 1;
      continue;
    }
    if (!/^import\b/.test(t) || /^import\s*\(/.test(t)) break;
    // Accumulate the declaration until its specifier line lands.
    let stmt = lines[i];
    let j = i;
    const done = (s) =>
      /from\s*(['"])[^'"]*\1\s*;?\s*$/.test(s.trim()) || /^\s*import\s*(['"])[^'"]*\1\s*;?\s*$/.test(s.trim());
    while (!done(stmt) && j - i < 12) {
      j += 1;
      if (j >= lines.length) break;
      stmt += '\n' + lines[j];
    }
    if (!done(stmt)) {
      return {
        ok: false,
        message: `could not parse the import statement starting at line ${i + 1} — keep imports simple: one per statement, ending with the from "…" specifier.`,
      };
    }
    const specMatch = stmt.match(/(['"])([^'"]+)\1\s*;?\s*$/);
    imports.push({ text: stmt, spec: specMatch ? specMatch[2] : '' });
    i = j + 1;
  }
  const body = lines.slice(i).join('\n');
  // Import/export declarations anywhere else are rejects (a leftover
  // import inside the wrapper would be a browser SyntaxError).
  const bodyLines = body.split('\n');
  for (let k = 0; k < bodyLines.length; k += 1) {
    const t = bodyLines[k].trim();
    if (/^export\b/.test(t)) {
      return {
        ok: false,
        message: `export declarations are not allowed in section scripts (line ${i + k + 1}) — a section script is a leaf; nothing imports it.`,
      };
    }
    if (/^import\b/.test(t) && !/^import\s*\(/.test(t)) {
      return {
        ok: false,
        message: `import declarations must sit at the very top of a module section script (line ${i + k + 1}) — move it above all other code.`,
      };
    }
  }
  return { ok: true, imports, lead, body };
}

/* --------------------------- validation -------------------------- */

function syntaxProblem(code, isModule) {
  if (!isModule) {
    try {
      new vm.Script(code);
      return null;
    } catch (e) {
      return `syntax error: ${e.message}`;
    }
  }
  const split = splitModuleImports(code);
  if (!split.ok) return split.message;
  // Parse the body as an async function body (top-level await is
  // legal in modules); the hoisted imports are shape-checked by the
  // splitter and their specifiers by validateSectionScript.
  try {
    new vm.Script(`(async () => {\n${split.body}\n})();`);
    return null;
  } catch (e) {
    return `syntax error in the module body: ${e.message}`;
  }
}

/**
 * Validate one section's script fields. Returns problems [{ code,
 * message }] — empty when the section carries no script fields or a
 * fully valid set. Mirrors sectionTemplates.validateTemplate's role
 * for the save paths.
 */
function validateSectionScript(section) {
  const problems = [];
  const s = section && typeof section === 'object' ? section : {};
  const hasJs = 'js' in s && s.js != null;
  const hasLibs = 'libs' in s && s.libs != null;
  const hasModule = 'jsModule' in s && s.jsModule != null;
  const hasExpect = 'jsExpect' in s && s.jsExpect != null;
  if (!hasJs && !hasLibs && !hasModule && !hasExpect) return problems;

  if (!sectionTemplates.isTemplateEnabled(s.type)) {
    problems.push({
      code: 'SCRIPT_NOT_AVAILABLE',
      message: `section scripts are not offered for "${s.type}" sections in v1: ${sectionTemplates.templateDisabledReason(s.type)}`,
    });
    return problems;
  }
  if (!hasJs) {
    problems.push({
      code: 'INVALID_SECTION_JS',
      message:
        'libs / jsModule / jsExpect have no effect without a section script — set js, or remove them (omit all four for the standard section).',
    });
    return problems;
  }
  if (typeof s.js !== 'string' || !s.js.trim()) {
    problems.push({
      code: 'INVALID_SECTION_JS',
      message: 'js must be a non-empty JavaScript string or absent (omit it for a script-free section).',
    });
    return problems;
  }
  const code = s.js;
  if (code.length > MAX_SECTION_JS_CHARS) {
    problems.push({
      code: 'SECTION_JS_TOO_LONG',
      message: `section script is ${code.length} characters — the limit is ${MAX_SECTION_JS_CHARS}.`,
    });
  }
  for (const hit of denylistHits(code)) {
    problems.push({ code: hit.code, message: hit.message });
  }

  // libs: registry membership + shape.
  const libs = [];
  if (hasLibs) {
    if (!Array.isArray(s.libs) || !s.libs.length || s.libs.some((x) => typeof x !== 'string' || !x.trim())) {
      problems.push({
        code: 'INVALID_LIBS',
        message: `libs must be a non-empty array of registry library ids (${scriptLibs.libIds().join(', ')}) or absent.`,
      });
    } else {
      for (const raw of s.libs) {
        const id = raw.trim();
        if (!scriptLibs.isLibId(id)) {
          problems.push({
            code: 'UNKNOWN_LIB',
            message: `unknown library "${id}" — the registry offers: ${scriptLibs.libIds().join(', ')}. Libraries are platform-pinned; agent-chosen URLs are not allowed.`,
          });
        } else if (libs.includes(id)) {
          problems.push({ code: 'INVALID_LIBS', message: `library "${id}" is declared twice in libs.` });
        } else {
          libs.push(id);
        }
      }
    }
  }

  // jsModule shape + kind coherence.
  let isModule = false;
  if (hasModule) {
    if (s.jsModule !== true) {
      problems.push({
        code: 'INVALID_JS_MODULE',
        message: 'jsModule must be exactly true or absent (omit it for a classic script).',
      });
    } else {
      isModule = true;
    }
  }
  const moduleLibs = libs.filter((id) => scriptLibs.getLib(id) && scriptLibs.getLib(id).kind === 'module');
  const classicLibs = libs.filter((id) => scriptLibs.getLib(id) && scriptLibs.getLib(id).kind === 'classic');
  if (!isModule && moduleLibs.length) {
    problems.push({
      code: 'LIB_KIND_MISMATCH',
      message: `"${moduleLibs[0]}" is a module library — set jsModule:true and import it (e.g. import * as THREE from "three"). A classic script may only declare classic libraries (${
        classicLibs
          .concat(['gsap'])
          .filter((v, ix, a) => a.indexOf(v) === ix)
          .join(', ') || 'gsap'
      }).`,
    });
  }
  if (isModule && !moduleLibs.length) {
    problems.push({
      code: 'MODULE_LIB_REQUIRED',
      message:
        'jsModule:true requires at least one module library in libs (e.g. "three") — a module script with nothing to import should be a classic script (omit jsModule).',
    });
  }

  // jsExpect shape.
  if (hasExpect) {
    if (typeof s.jsExpect !== 'string' || !s.jsExpect.trim()) {
      problems.push({
        code: 'INVALID_JS_EXPECT',
        message: 'jsExpect must be a non-empty CSS selector string or absent.',
      });
    } else if (s.jsExpect.trim().length > MAX_JS_EXPECT_CHARS || /[<>]/.test(s.jsExpect)) {
      problems.push({
        code: 'INVALID_JS_EXPECT',
        message: `jsExpect must be a single CSS selector of at most ${MAX_JS_EXPECT_CHARS} characters, without angle brackets.`,
      });
    }
  }

  // Static import specifiers (module scripts): registry-only AND
  // declared — the importmap only carries declared libs' specifiers.
  if (isModule) {
    const split = splitModuleImports(code);
    if (!split.ok) {
      problems.push({ code: 'SECTION_JS_SYNTAX', message: split.message });
    } else {
      for (const imp of split.imports) {
        if (!scriptLibs.isRegistrySpecifier(imp.spec)) {
          problems.push({
            code: 'IMPORT_NOT_REGISTRY',
            message: `import "${imp.spec}" is not a registry specifier — section scripts may only import: ${registrySpecifierList()}.`,
          });
          continue;
        }
        const owner = scriptLibs.LIBS.find(
          (l) =>
            l.importMap &&
            Object.keys(l.importMap).some((k) => (k.endsWith('/') ? imp.spec.startsWith(k) : imp.spec === k))
        );
        if (owner && !libs.includes(owner.id)) {
          problems.push({
            code: 'IMPORT_NOT_DECLARED',
            message: `import "${imp.spec}" belongs to library "${owner.id}" — declare it in libs (libs: [${libs
              .concat(owner.id)
              .map((x) => `"${x}"`)
              .join(', ')}]) so its importmap ships with the page.`,
          });
        }
      }
    }
  }

  // Syntax (last — the specific problems above are more actionable).
  if (!problems.length) {
    const syn = syntaxProblem(code, isModule);
    if (syn) problems.push({ code: 'SECTION_JS_SYNTAX', message: syn });
  }
  return problems;
}

/* --------------------------- emission ---------------------------- */
/* Builders used by src/websiteEngine.js. Everything here is         */
/* platform-generated markup around the agent's code: the code       */
/* itself passes the same breakout escaping as sanitizeJs (the       */
/* engine's helper is not importable without a cycle, so the one     */
/* replace is mirrored here).                                        */

function escapeScriptBreakouts(code) {
  return String(code == null ? '' : code).replace(/<\/script/gi, '<\\/script');
}

function typeSlug(section) {
  return (
    String((section && section.type) || 'custom')
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '')
      .slice(0, 40) || 'custom'
  );
}

function classicLibGuard(libs) {
  const probes = libs
    .map((id) => scriptLibs.getLib(id))
    .filter((l) => l && l.kind === 'classic' && l.global)
    .map((l) => `typeof window.${l.global} === 'undefined'`);
  if (!probes.length) return '';
  return `if (${probes.join(' || ')}) { root.setAttribute('data-bp-js-skipped', 'lib-missing'); return; }\n`;
}

function wrapClassicScript(section, key) {
  const type = typeSlug(section);
  const body =
    `(function () {\nvar root = document.querySelector('[data-bp-sec="${key}"]');\nvar el = root;\nif (!root) return;\n` +
    classicLibGuard(libsOf(section)) +
    `try {\n${escapeScriptBreakouts(jsOf(section))}\n} catch (e) {\nroot.setAttribute('data-bp-js-error', '1');\nconsole.warn('[section-js] ${type} failed:', e);\n}\n})();`;
  return `<script data-ws-section-js="1" data-ws-section-type="${type}" data-bp-sec-ref="${key}">${body}</script>`;
}

function wrapModuleScript(section, key) {
  const type = typeSlug(section);
  const split = splitModuleImports(jsOf(section));
  if (!split.ok) throw new Error(split.message);
  const imports = split.imports.map((i) => i.text).join('\n');
  const body =
    (imports ? `${imports}\n` : '') +
    `(async function () {\nvar root = document.querySelector('[data-bp-sec="${key}"]');\nvar el = root;\nif (!root) return;\n` +
    classicLibGuard(libsOf(section)) +
    `try {\n${escapeScriptBreakouts(split.body)}\n} catch (e) {\nroot.setAttribute('data-bp-js-error', '1');\nconsole.warn('[section-js] ${type} failed:', e);\n}\n})();`;
  return `<script type="module" data-ws-section-js="1" data-ws-section-type="${type}" data-bp-sec-ref="${key}">${body}</script>`;
}

/** One section's body-end tag. Throws on an unparseable stored
 * script — the engine catches and emits nothing (the static design
 * stands; save-time validation is the real gate). */
function sectionScriptTag(section, key) {
  return isJsModule(section) ? wrapModuleScript(section, key) : wrapClassicScript(section, key);
}

/**
 * Head tags for a set of declared library ids: classic libs as SRI
 * script tags (an onerror stamps data-bp-lib-error on <html> for QA
 * attribution), module libs merged into ONE importmap. Deterministic
 * order (registry order) so renders are stable.
 */
function libHeadTags(libIds) {
  const wanted = new Set((libIds || []).map((x) => String(x)));
  const classic = [];
  const importMap = {};
  for (const lib of scriptLibs.LIBS) {
    if (!wanted.has(lib.id)) continue;
    if (lib.kind === 'classic') {
      classic.push(
        `<script src="${lib.url}" integrity="${lib.integrity}" crossorigin="anonymous" data-bp-lib="${lib.id}" onerror="document.documentElement.setAttribute('data-bp-lib-error','${lib.id}')"></script>`
      );
    } else if (lib.importMap) {
      for (const k of Object.keys(lib.importMap).sort()) importMap[k] = lib.importMap[k];
    }
  }
  const tags = [];
  if (Object.keys(importMap).length) {
    // Batch 201: the importmap JSON must carry the spec's top-level
    // "imports" wrapper — {"imports": { "three": "…", … }}. Batch 199
    // emitted the bare specifier map ({"three": "…"}), which is not a
    // valid importmap: browsers reject it and every module script
    // importing 'three' failed with "Failed to resolve module
    // specifier" (proven in the Victoria redesign test, 2026-11-20).
    tags.push(`<script type="importmap" data-bp-importmap="1">${JSON.stringify({ imports: importMap })}</script>`);
  }
  tags.push(...classic);
  return tags.join('\n');
}

/**
 * Collect a page's section scripts: { head, body, count, libIds }.
 * Sections are addressed by their rendered index (secKeyFor). Pages
 * without scripts return empty strings — the engine then emits
 * exactly what it emitted before Batch 199.
 */
function collectPageScripts(page, pageIndex) {
  const sections = page && Array.isArray(page.sections) ? page.sections : [];
  const bodyTags = [];
  const libIds = [];
  sections.forEach((section, si) => {
    if (!section || !hasSectionJs(section)) return;
    for (const id of libsOf(section)) {
      if (!libIds.includes(id)) libIds.push(id);
    }
    try {
      bodyTags.push(sectionScriptTag(section, secKeyFor(pageIndex, si)));
    } catch {
      /* a stored script that no longer parses emits nothing — the
       * section's static design stands (save validation + export QA
       * are where this is surfaced). */
    }
  });
  if (!bodyTags.length) return { head: '', body: '', count: 0, libIds: [] };
  return { head: libHeadTags(libIds), body: bodyTags.join('\n'), count: bodyTags.length, libIds };
}

/** Total stored section-js chars on one page (per-page cap, §7.3). */
function pageJsChars(sections) {
  let total = 0;
  for (const s of Array.isArray(sections) ? sections : []) {
    if (s && typeof s.js === 'string') total += s.js.length;
  }
  return total;
}

/** Agent-facing summary of the script slot (design.templates). */
function scriptsSummary() {
  return {
    maxChars: MAX_SECTION_JS_CHARS,
    maxPageChars: MAX_PAGE_JS_CHARS,
    fields: ['js', 'libs', 'jsModule', 'jsExpect'],
    libs: scriptLibs.registrySummary(),
    rules: [
      'Set section.js on the same section types that offer templates (templates:true); it works with or without section.template.',
      'root and el inside the script both name the section root element; the script runs at body end, after theme/page JS.',
      'Declare every library in section.libs — libraries are platform-pinned registry entries; agent-chosen script URLs and inlined libraries are rejected.',
      'Module scripts (jsModule:true) put all imports at the very top and may only import registry specifiers of declared libs (e.g. "three", "three/addons/…").',
      'A throwing script degrades to the static design (never a broken page); export QA fails on script errors, missing libraries, off-registry script hosts, or a missing jsExpect target.',
      'Progressive enhancement is mandatory: the page must be complete with scripts blocked. Forbidden: eval/Function, document.write, document.cookie, dynamic script injection, /api/v1/ references.',
    ],
  };
}

module.exports = {
  MAX_SECTION_JS_CHARS,
  MAX_PAGE_JS_CHARS,
  MAX_JS_EXPECT_CHARS,
  jsOf,
  hasSectionJs,
  libsOf,
  isJsModule,
  jsExpectOf,
  secKeyFor,
  splitModuleImports,
  validateSectionScript,
  sectionScriptTag,
  libHeadTags,
  collectPageScripts,
  pageJsChars,
  scriptsSummary,
};
