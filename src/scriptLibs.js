'use strict';

/* ------------------------------------------------------------------ */
/* Batch 199 — SCRIPT LIBRARY REGISTRY (Module Customization, Pt D1)   */
/*                                                                     */
/* Ely's ask (2026-11-19): "I want it to be able to add 3D js, etc     */
/* to designs as well." Section scripts (src/sectionScripts.js) may    */
/* use libraries, but the agent may NOT supply its own script URLs     */
/* and may NOT inline a library (Three.js minified is ~660 KB — far    */
/* over the section-js cap, and an unpinned URL is a supply-chain      */
/* hole with no QA attribution). Libraries come from THIS registry:    */
/* platform-pinned versions on jsDelivr, SRI-hashed where the         */
/* platform emits the tag itself (classic kind). Adding a library is   */
/* a registry entry + suite update — a platform decision, never an     */
/* agent free choice (spec §5.2).                                      */
/*                                                                     */
/* Entry shape (parity-checked by the batch199 suite — every field     */
/* is mandatory, the Batch 122/188/197 discipline):                     */
/*   id          registry id a section names in `libs`                 */
/*   label       human name                                            */
/*   description what the library is, for the agent surface            */
/*   bestFor     when a design should reach for it                     */
/*   version     platform-pinned version string                        */
/*   url         exact jsDelivr URL (classic: the script file;         */
/*               module: the module entry file)                        */
/*   integrity   SRI sha384 of the pinned file. Emitted on classic     */
/*               <script> tags. Module libs load through an importmap, */
/*               which has no integrity slot in current browsers —     */
/*               the hash is recorded for audit/D2 use and the URL     */
/*               pinning is the v1 control.                            */
/*   kind        'classic' (window global) | 'module' (importmap)      */
/*   global      window global a classic lib defines (the wrapper's    */
/*               lib-missing probe); null for module kind              */
/*   importMap   for module kind: the specifier map merged into the    */
/*               page's single <script type="importmap">; null else    */
/*   bytesGzip   gzipped transfer size of the entry file (perf budget) */
/* ------------------------------------------------------------------ */

const LIBS = [
  {
    id: 'three',
    label: 'Three.js',
    description:
      'WebGL 3D library. Import it from the "three" specifier in a module section script (jsModule:true); addons (OrbitControls, GLTFLoader, …) import from "three/addons/…".',
    bestFor: '3D product viewers, animated hero scenes, WebGL backgrounds and product configurators.',
    version: '0.160.0',
    url: 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js',
    integrity: 'sha384-61S/Nu32S3E5+n+KpCOTb2eRYps6fVKm+9Gz1QBvSePFthb46f063Aa/qe/lykFZ',
    kind: 'module',
    global: null,
    importMap: {
      three: 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js',
      'three/addons/': 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/',
    },
    bytesGzip: 257886,
  },
  {
    id: 'gsap',
    label: 'GSAP',
    description:
      'Animation library (GreenSock). Classic script: the global `window.gsap` is available inside any section script that declares libs:["gsap"].',
    bestFor: 'Scroll-triggered reveals, timeline animation, counters and micro-interactions beyond CSS transitions.',
    version: '3.12.5',
    url: 'https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js',
    integrity: 'sha384-g4NTh/Iv5PPU4xPyhEWqPcwtNXOvdaDI8LLnyYfyNZOjKJeYQyjzQ9X5275eBjpt',
    kind: 'classic',
    global: 'gsap',
    importMap: null,
    bytesGzip: 28059,
  },
];

const BY_ID = new Map(LIBS.map((l) => [l.id, l]));

/** Perf budget for one page's script transfer (spec §7.3). QA warns
 * above WARN and fails above FAIL; numbers live here, in one place. */
const SCRIPT_WARN_BYTES = 1500000;
const SCRIPT_FAIL_BYTES = 3000000;

function getLib(id) {
  return BY_ID.get(String(id || '')) || null;
}

function isLibId(id) {
  return BY_ID.has(String(id || ''));
}

function libIds() {
  return LIBS.map((l) => l.id);
}

/** Hosts the registry loads from — part of the export-QA script
 * allowlist (spec §6/§7.2). Derived from the pinned URLs only. */
function registryHosts() {
  const hosts = new Set();
  for (const l of LIBS) {
    try {
      hosts.add(new URL(l.url).host);
    } catch {
      /* a malformed registry URL is a parity-suite failure */
    }
    if (l.importMap) {
      for (const u of Object.values(l.importMap)) {
        try {
          hosts.add(new URL(u).host);
        } catch {
          /* as above */
        }
      }
    }
  }
  return [...hosts];
}

/**
 * Is a module import specifier resolvable through the registry
 * importmaps? Exact key match, or a prefix match on a key ending in
 * '/' (three/addons/…). Bare URLs and unknown specifiers are not
 * resolvable — a section script may only import what the platform
 * pins (spec §5.2/§6).
 */
function isRegistrySpecifier(spec) {
  const s = String(spec || '');
  if (!s || /^https?:\/\//i.test(s) || s.startsWith('/') || s.startsWith('.')) return false;
  for (const l of LIBS) {
    if (!l.importMap) continue;
    for (const key of Object.keys(l.importMap)) {
      if (key.endsWith('/')) {
        if (s.startsWith(key) && s.length > key.length) return true;
      } else if (s === key) {
        return true;
      }
    }
  }
  return false;
}

/** Agent-facing registry summary (design.templates surface). */
function registrySummary() {
  return LIBS.map((l) => ({
    id: l.id,
    label: l.label,
    description: l.description,
    bestFor: l.bestFor,
    version: l.version,
    kind: l.kind,
    global: l.global,
    importSpecifiers: l.importMap ? Object.keys(l.importMap) : [],
    bytesGzip: l.bytesGzip,
  }));
}

module.exports = {
  LIBS,
  SCRIPT_WARN_BYTES,
  SCRIPT_FAIL_BYTES,
  getLib,
  isLibId,
  libIds,
  registryHosts,
  isRegistrySpecifier,
  registrySummary,
};
