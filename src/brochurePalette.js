'use strict';

/**
 * Brochure brand-color extraction for the /website-promo lead form.
 *
 * The promo route stores the uploaded brochure file, then calls
 * extractBrochurePalette() and writes the result onto the new lead as the
 * `site.style_guide` business fact — the exact fact the design brief
 * builder reads (src/designJobs.js), in the same shape siteIngest
 * produces ({ primary, secondary, palette: [hex…], fonts, logo, source }).
 * So a palette extracted here flows into design jobs with no further glue.
 *
 * Extraction is best-effort by design: any failure returns
 * { status: 'pending', palette: [] } and NEVER throws — a brochure whose
 * colors cannot be read must not cost the lead.
 *
 * Formats:
 *  - PNG / JPEG / WebP — sampled with sharp (already a dependency).
 *  - PDF — embedded images + vector fill colors via pdfjs-dist (pinned in
 *    the lockfile as officeparser's dependency). Best effort: scanned or
 *    exotic PDFs may yield 'pending'.
 *  - Word (.doc/.docx) — stored by the route, palette stays 'pending'
 *    (no color-bearing image pipeline for Office docs in the tree).
 */

const MAX_COLORS = 5;
const SAMPLE_EDGE = 96; // images are downscaled to at most this many px per side before sampling
const PDF_MAX_PAGES = 3;
const PDF_MAX_IMAGES = 6;
const PDF_FILL_WEIGHT = 600; // one flat fill op ≈ this many pixel samples in the histogram

// ---------------------------------------------------------------------------
// Content sniffing — magic bytes only; the client-declared MIME is never
// trusted on its own (the route cross-checks the two).
// ---------------------------------------------------------------------------

function sniffBrochureType(buf) {
  if (!buf || buf.length < 4) return null;
  if (buf.length >= 5 && buf.toString('latin1', 0, 5) === '%PDF-') {
    return { kind: 'pdf', mimeType: 'application/pdf', ext: '.pdf' };
  }
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { kind: 'png', mimeType: 'image/png', ext: '.png' };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { kind: 'jpeg', mimeType: 'image/jpeg', ext: '.jpg' };
  }
  if (
    buf.length >= 12 &&
    buf.toString('latin1', 0, 4) === 'RIFF' &&
    buf.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return { kind: 'webp', mimeType: 'image/webp', ext: '.webp' };
  }
  // ZIP container — a .docx when the route's declared MIME says Word.
  if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) {
    return { kind: 'docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: '.docx' };
  }
  // OLE compound file — a legacy .doc when the declared MIME says Word.
  if (buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0) {
    return { kind: 'doc', mimeType: 'application/msword', ext: '.doc' };
  }
  return null;
}

// Which sniffed kinds each declared family may legitimately carry. A
// mismatch (e.g. declared PDF, bytes are a PNG) means the content does not
// match its type and the route rejects the file.
const DECLARED_FAMILY_KINDS = {
  pdf: ['pdf'],
  png: ['png'],
  jpeg: ['jpeg'],
  webp: ['webp'],
  word: ['docx', 'doc'],
  generic: ['pdf', 'png', 'jpeg', 'webp', 'docx', 'doc'],
};

function declaredFamily(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.includes('pdf')) return 'pdf';
  if (m.includes('png')) return 'png';
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpeg';
  if (m.includes('webp')) return 'webp';
  if (m.includes('word') || m.includes('openxmlformats')) return 'word';
  return 'generic'; // application/octet-stream etc. — trust the sniffed kind
}

// ---------------------------------------------------------------------------
// Pixel histogram → ranked palette.
// Colors are bucketed to 32 levels/channel, averaged per bucket, then
// ranked by frequency weighted toward saturated mid-tones: brochure brand
// colors are rarely the near-white page background or near-black body text,
// so those only win when the artwork has almost nothing else.
// ---------------------------------------------------------------------------

function createHistogram() {
  return new Map();
}

function addSample(hist, r, g, b, weight) {
  const key = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
  let e = hist.get(key);
  if (!e) {
    e = { n: 0, r: 0, g: 0, b: 0 };
    hist.set(key, e);
  }
  e.n += weight;
  e.r += r * weight;
  e.g += g * weight;
  e.b += b * weight;
}

function toHex(r, g, b) {
  const c = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

function paletteFromHistogram(hist) {
  const cands = [];
  let total = 0;
  for (const e of hist.values()) {
    total += e.n;
    const r = e.r / e.n;
    const g = e.g / e.n;
    const b = e.b / e.n;
    const mx = Math.max(r, g, b) / 255;
    const mn = Math.min(r, g, b) / 255;
    const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    const sat = mx === 0 ? 0 : (mx - mn) / mx;
    cands.push({ r, g, b, n: e.n, luma, sat });
  }
  if (!cands.length) return [];

  // Primary pool: saturated mid-tones (brand colors). Fall back to every
  // non-extreme bucket when the artwork is nearly monochrome.
  let pool = cands.filter((c) => c.sat >= 0.16 && c.luma >= 0.05 && c.luma <= 0.95);
  const poolWeight = pool.reduce((s, c) => s + c.n, 0);
  if (!pool.length || poolWeight < total * 0.01) {
    pool = cands.filter((c) => c.luma >= 0.04 && c.luma <= 0.96);
  }
  pool.sort((a, b) => b.n * (0.35 + b.sat) - (a.n * (0.35 + a.sat)));

  const picked = [];
  for (const c of pool) {
    if (picked.length >= MAX_COLORS) break;
    const nearDup = picked.some((p) => Math.abs(p.r - c.r) + Math.abs(p.g - c.g) + Math.abs(p.b - c.b) < 84);
    if (!nearDup) picked.push(c);
  }
  return picked.map((c) => toHex(c.r, c.g, c.b));
}

// ---------------------------------------------------------------------------
// Image sampling (sharp).
// ---------------------------------------------------------------------------

async function sampleImageBuffer(buf, hist) {
  const sharp = require('sharp');
  const { data, info } = await sharp(buf)
    .resize(SAMPLE_EDGE, SAMPLE_EDGE, { fit: 'inside' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const ch = info.channels; // 4 after ensureAlpha
  for (let i = 0; i + ch <= data.length; i += ch) {
    if (data[i + 3] < 128) continue; // transparent — not a brand surface
    addSample(hist, data[i], data[i + 1], data[i + 2], 1);
  }
}

async function paletteFromImageBuffer(buf) {
  const hist = createHistogram();
  await sampleImageBuffer(buf, hist);
  return paletteFromHistogram(hist);
}

// ---------------------------------------------------------------------------
// PDF sampling (pdfjs-dist): embedded images + flat vector fills.
// ---------------------------------------------------------------------------

function addRawPixels(hist, data, width, height) {
  const px = width * height;
  if (!px || !data || data.length < px) return;
  const bpp = Math.floor(data.length / px);
  if (bpp < 3) return; // grayscale / 1bpp masks carry no brand color here
  const step = Math.max(1, Math.floor(px / 20000)); // cap ~20k samples per image
  for (let p = 0; p < px; p += step) {
    const i = p * bpp;
    addSample(hist, data[i], data[i + 1], data[i + 2], 1);
  }
}

async function paletteFromPdfBuffer(buf) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: true, verbosity: 0 }).promise;
  const hist = createHistogram();
  const OPS = pdfjs.OPS;
  let imagesSeen = 0;

  const pages = Math.min(doc.numPages || 0, PDF_MAX_PAGES);
  for (let p = 1; p <= pages; p++) {
    const page = await doc.getPage(p);
    const opList = await page.getOperatorList();
    for (let i = 0; i < opList.fnArray.length; i++) {
      const fn = opList.fnArray[i];
      const args = opList.argsArray[i] || [];
      if (fn === OPS.setFillRGBColor || fn === OPS.setStrokeRGBColor) {
        // v6 passes a '#rrggbb' string; older shapes pass [r,g,b] 0..1 floats.
        const a = args[0];
        if (typeof a === 'string' && /^#[0-9a-f]{6}$/i.test(a)) {
          addSample(hist, parseInt(a.slice(1, 3), 16), parseInt(a.slice(3, 5), 16), parseInt(a.slice(5, 7), 16), PDF_FILL_WEIGHT);
        } else if (Array.isArray(a) && a.length >= 3) {
          addSample(hist, a[0] * 255, a[1] * 255, a[2] * 255, PDF_FILL_WEIGHT);
        }
      } else if ((fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) && imagesSeen < PDF_MAX_IMAGES) {
        imagesSeen++;
        try {
          const img =
            typeof args[0] === 'string' ? await new Promise((resolve) => page.objs.get(args[0], resolve)) : args[0];
          if (img && img.data) addRawPixels(hist, img.data, img.width, img.height);
        } catch {
          /* one unreadable image must not sink the rest */
        }
      }
    }
  }
  return paletteFromHistogram(hist);
}

// ---------------------------------------------------------------------------

/**
 * @param {Buffer} buf brochure bytes
 * @param {string} kind sniffed kind from sniffBrochureType()
 * @returns {Promise<{status:'extracted'|'pending', palette:string[], primary:string|null, secondary:string|null}>}
 */
async function extractBrochurePalette(buf, kind) {
  try {
    let palette = [];
    if (kind === 'png' || kind === 'jpeg' || kind === 'webp') {
      palette = await paletteFromImageBuffer(buf);
    } else if (kind === 'pdf') {
      palette = await paletteFromPdfBuffer(buf);
    } else {
      return { status: 'pending', palette: [], primary: null, secondary: null };
    }
    if (!palette.length) return { status: 'pending', palette: [], primary: null, secondary: null };
    return { status: 'extracted', palette, primary: palette[0] || null, secondary: palette[1] || null };
  } catch {
    return { status: 'pending', palette: [], primary: null, secondary: null };
  }
}

module.exports = {
  sniffBrochureType,
  declaredFamily,
  DECLARED_FAMILY_KINDS,
  extractBrochurePalette,
  paletteFromImageBuffer,
  paletteFromPdfBuffer,
};
