'use strict';

/**
 * Batch 84 — the BitPype Agent SOUL.md, served to the client portal.
 *
 * The document lives as ONE source file next to this module
 * (server/agent-soul.md) so it can be updated in a single place. The
 * portal "Agent SOUL.md" page renders it for reading and offers the
 * raw markdown for copy/download — both serve this exact source.
 *
 * Rendering: the codebase has no markdown library, and the document
 * is ours and static, so a small subset renderer suffices — headings
 * (#–###), horizontal rules, bullet/numbered lists, paragraphs, and
 * inline `code`, **bold**, _italic_. Every character is HTML-escaped
 * BEFORE any formatting is applied, and code spans are extracted
 * before bold/italic so their contents are never re-interpreted.
 */

const fs = require('node:fs');
const path = require('node:path');

const SOUL_PATH = path.join(__dirname, 'agent-soul.md');
const DOWNLOAD_FILENAME = 'SOUL.md';

let cache = null;

/** { markdown, html } for the shipped document (read once, cached). */
function loadSoul() {
  if (!cache) {
    const markdown = fs.readFileSync(SOUL_PATH, 'utf8');
    cache = { markdown, html: renderSoulHtml(markdown) };
  }
  return cache;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Inline formatting on already-escaped text. */
function renderInline(escaped) {
  const codes = [];
  let t = String(escaped).replace(/`([^`]+)`/g, (_m, code) => {
    codes.push(code);
    return `\u0000${codes.length - 1}\u0000`;
  });
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/_([^_]+)_/g, '<em>$1</em>');
  t = t.replace(/\u0000(\d+)\u0000/g, (_m, i) => `<code>${codes[Number(i)]}</code>`);
  return t;
}

const RE_HEADING = /^(#{1,3})\s+(.*)$/;
const RE_HR = /^-{3,}\s*$/;
const RE_UL = /^-\s+(.*)$/;
const RE_OL = /^\d+\.\s+(.*)$/;

function renderSoulHtml(md) {
  const lines = String(md).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;
  const isBlockStart = (l) => RE_HEADING.test(l) || RE_HR.test(l) || RE_UL.test(l) || RE_OL.test(l);
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      i++;
      continue;
    }
    const h = line.match(RE_HEADING);
    if (h) {
      const level = h[1].length;
      out.push(`<h${level}>${renderInline(escapeHtml(h[2]))}</h${level}>`);
      i++;
      continue;
    }
    if (RE_HR.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }
    if (RE_UL.test(line)) {
      const items = [];
      while (i < lines.length && RE_UL.test(lines[i])) {
        items.push(lines[i].match(RE_UL)[1]);
        i++;
      }
      out.push('<ul>' + items.map((it) => `<li>${renderInline(escapeHtml(it))}</li>`).join('') + '</ul>');
      continue;
    }
    if (RE_OL.test(line)) {
      const items = [];
      while (i < lines.length && RE_OL.test(lines[i])) {
        items.push(lines[i].match(RE_OL)[1]);
        i++;
      }
      out.push('<ol>' + items.map((it) => `<li>${renderInline(escapeHtml(it))}</li>`).join('') + '</ol>');
      continue;
    }
    const para = [line];
    i++;
    while (i < lines.length && lines[i].trim() !== '' && !isBlockStart(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    out.push(`<p>${renderInline(escapeHtml(para.join(' ')))}</p>`);
  }
  return out.join('\n');
}

module.exports = { SOUL_PATH, DOWNLOAD_FILENAME, loadSoul, renderSoulHtml, escapeHtml };
