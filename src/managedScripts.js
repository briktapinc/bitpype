'use strict';

const LOADERS = Object.freeze({
  'form-embed.js': 'data-bitpype-form-script',
  'chat-embed.js': 'data-bitpype-chat-script',
  'module-embed.js': 'data-bitpype-module-script',
});

function appBase() {
  // Batch 56: loader script URLs resolve from the canonical public URL
  // (stripeClient.appUrl); the env read remains only as a fallback if the
  // resolver cannot load. The origin validation below is unchanged.
  let raw = '';
  try {
    raw = require('../server/stripeClient').appUrl();
  } catch {
    raw = String(process.env.APP_URL || '');
  }
  try {
    const url = new URL(String(raw || ''));
    return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.origin : '';
  } catch {
    return '';
  }
}

function loaderTag(file) {
  if (!LOADERS[file]) return '';
  return `<script src="${appBase()}/js/${file}" defer ${LOADERS[file]}="1"></script>`;
}

// Caller-supplied markers, attributes and script bodies never confer trust.
function approvedScript(attrs) {
  const match = /(?:^|\s)src\s*=\s*(["'])([^"']*)\1/i.exec(String(attrs || ''));
  if (!match) return '';
  const src = match[2];
  for (const file of Object.keys(LOADERS)) {
    if (src === `/js/${file}` || (appBase() && src === `${appBase()}/js/${file}`)) return loaderTag(file);
  }
  return '';
}

/* ------------------------------------------------------------------ */
/* Batch 149 — canonical managed-script ensure (save-path idempotency) */
/*                                                                     */
/* Every loader family used to carry its own copy of "strip own tag,   */
/* append \n + tag" (ensureModuleEmbedScript / ensureChatEmbedScript  */
/* / ensureFormEmbedScript). The strip left the separator newline      */
/* behind, so each call added one; and when several families share     */
/* one html blob, each ensure removed its own tag from the middle of   */
/* the trailing script cluster and re-appended it at the end — the     */
/* cluster shuffled on every save and separator newlines accumulated   */
/* without bound (the Batch 147 live proof measured the drift; the     */
/* Batch 149 suite reproduces it).                                     */
/*                                                                     */
/* ensureManagedScript is the single replacement: a fixed point for    */
/* ANY interleaving of family ensures over the same blob.              */
/*   1. Every managed tag of every family is collected (verbatim)      */
/*      and removed WITH the separator whitespace of the cluster it    */
/*      sits in — the trailing cluster, or a cluster directly before   */
/*      </body>. A managed tag stranded mid-content is removed bare    */
/*      and relocated into the cluster (the platform owns these tags   */
/*      and their placement). Authored non-managed scripts are never   */
/*      touched.                                                       */
/*   2. The cluster is rebuilt in canonical family order (module,      */
/*      form, chat): the caller's family uses the caller's fresh tag   */
/*      (so ?v= upgrades still propagate on save); sibling families    */
/*      keep their captured verbatim tags. Tags join with a single     */
/*      "\n"; the cluster is appended after the content (trailing      */
/*      newlines trimmed) or inserted as cluster + "\n" before         */
/*      </body> — the historical placements.                           */
/* ------------------------------------------------------------------ */
const FAMILY_ORDER = ['module-embed.js', 'form-embed.js', 'chat-embed.js'];

function managedTagPattern() {
  const attrs = Object.values(LOADERS)
    .map((a) => `\\b${a}\\b`)
    .join('|');
  const files = FAMILY_ORDER.map((f) => f.replace(/\./g, '\\.')).join('|');
  return `<script\\b[^>]*(?:${attrs}|\\/js\\/(?:${files}))[^>]*>\\s*<\\/script>`;
}

function managedFamilyOf(tagText) {
  const t = String(tagText || '');
  for (const file of FAMILY_ORDER) {
    if (t.includes(LOADERS[file]) || t.includes(`/js/${file}`)) return file;
  }
  return null;
}

function ensureManagedScript(html, ownFile, ownTag) {
  let s = String(html || '');
  if (!ownTag) return s;
  const tagRe = managedTagPattern();
  const found = new Map();
  const collect = (tagText) => {
    const fam = managedFamilyOf(tagText);
    if (fam && !found.has(fam)) found.set(fam, tagText);
    return '';
  };

  // 1a. Trailing cluster: managed tags + separators at end-of-blob.
  s = s.replace(new RegExp(`((?:\\s*${tagRe})+)\\s*$`, 'gi'), (whole) => {
    for (const m of whole.matchAll(new RegExp(tagRe, 'gi'))) collect(m[0]);
    return '';
  });
  // 1b. Cluster directly before </body>: strip it (with the separator
  // run that follows it, where the historical insert left its "\n")
  // off the head; the rebuilt cluster is re-inserted below.
  let bodyAt = s.search(/<\/body>/i);
  if (bodyAt >= 0) {
    let head = s.slice(0, bodyAt);
    head = head.replace(new RegExp(`((?:\\s*${tagRe})+)\\s*$`, 'gi'), (whole) => {
      for (const m of whole.matchAll(new RegExp(tagRe, 'gi'))) collect(m[0]);
      return '';
    });
    s = head + s.slice(bodyAt);
    bodyAt = head.length;
  }
  // 1c. Any managed tag stranded mid-content: remove bare, relocate.
  s = s.replace(new RegExp(tagRe, 'gi'), (tagText) => collect(tagText));
  if (bodyAt >= 0) bodyAt = s.search(/<\/body>/i);

  // 2. Rebuild the cluster in canonical family order.
  const parts = [];
  for (const file of FAMILY_ORDER) {
    if (file === ownFile) parts.push(ownTag);
    else if (found.has(file)) parts.push(found.get(file));
  }
  if (!parts.length) parts.push(ownTag);
  const cluster = parts.join('\n');

  if (bodyAt >= 0) {
    return s.slice(0, bodyAt) + cluster + '\n' + s.slice(bodyAt);
  }
  return `${s.replace(/(?:\r?\n)+$/, '')}\n${cluster}`;
}

module.exports = { appBase, loaderTag, approvedScript, ensureManagedScript, LOADERS };
