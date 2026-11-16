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
 * Palette paths, in order:
 *  1. OpenAI vision (src/ai.js chat(), the workspace's own key/settings)
 *     when the caller passes the workspace db — the model reads the
 *     brochure like a person and reports the BRAND colors (logo/identity
 *     colors, not incidental photo colors). Result carries
 *     palette_source: 'openai'. For image brochures the same call also
 *     returns the logo bounding box (logo_box) for the asset pass.
 *  2. Deterministic histogram below (palette_source: 'histogram').
 *  3. 'pending' when neither yields colors.
 *
 * Brand assets (extractBrochureAssets): the logo plus up to
 * MAX_ASSETS complementing photos/graphics are lifted out of the
 * brochure as image buffers — PDFs via their embedded images (vision
 * classifies logo/photo/graphic/ignore), image brochures via a
 * vision-returned logo crop. The route persists the buffers and points
 * style_guide.logo / style_guide.assets at them. Same never-throw rule.
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
const VISION_MAX_EDGE = 512; // vision calls get at most this many px per side
const OPENAI_TIMEOUT_MS = 20000; // per vision call; the deterministic path is the safety net
const MAX_ASSETS = 6; // complementing assets kept per brochure (logo excluded)
const ASSET_MIN_EDGE = 48; // embedded images smaller than this are junk (bullets, rules, spacers)
const ASSET_MAX_EDGE = 1600; // stored assets are downscaled past this edge
const ASSET_MAX_BYTES = 6 * 1024 * 1024;

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
// PDF embedded images as standalone buffers (shared by the vision palette
// pass and the asset pass). Mirrors the image walk in paletteFromPdfBuffer
// but keeps the pixels instead of histogramming them.
// ---------------------------------------------------------------------------

async function pdfEmbeddedImages(buf) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: true, verbosity: 0 }).promise;
  const OPS = pdfjs.OPS;
  const images = [];
  const pages = Math.min(doc.numPages || 0, PDF_MAX_PAGES);
  for (let p = 1; p <= pages && images.length < PDF_MAX_IMAGES; p++) {
    const page = await doc.getPage(p);
    const opList = await page.getOperatorList();
    for (let i = 0; i < opList.fnArray.length && images.length < PDF_MAX_IMAGES; i++) {
      const fn = opList.fnArray[i];
      const args = opList.argsArray[i] || [];
      if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) {
        try {
          const img =
            typeof args[0] === 'string' ? await new Promise((resolve) => page.objs.get(args[0], resolve)) : args[0];
          if (img && img.data && img.width && img.height) {
            images.push({ data: img.data, width: img.width, height: img.height });
          }
        } catch {
          /* one unreadable image must not sink the rest */
        }
      }
    }
  }
  return images;
}

async function rawImageToPngBuffer(img) {
  const px = img.width * img.height;
  if (!px || !img.data || img.data.length < px) return null;
  const channels = Math.floor(img.data.length / px);
  if (![1, 3, 4].includes(channels)) return null;
  const sharp = require('sharp');
  let buf = await sharp(Buffer.from(img.data), {
    raw: { width: img.width, height: img.height, channels },
  })
    .png()
    .toBuffer();
  if (buf.length > ASSET_MAX_BYTES) {
    buf = await sharp(buf).resize(ASSET_MAX_EDGE, ASSET_MAX_EDGE, { fit: 'inside' }).png().toBuffer();
  }
  return buf;
}

/** Embedded PDF images as PNG buffers with dims, first-seen order kept. */
async function pdfCandidateImages(buf) {
  const raw = await pdfEmbeddedImages(buf);
  const out = [];
  const seen = new Set();
  const crypto = require('crypto');
  for (const img of raw) {
    const hash = crypto.createHash('md5').update(Buffer.from(img.data)).digest('hex');
    if (seen.has(hash)) continue; // same image placed on several pages
    seen.add(hash);
    const buffer = await rawImageToPngBuffer(img).catch(() => null);
    if (buffer) out.push({ buffer, width: img.width, height: img.height });
  }
  return out;
}

// ---------------------------------------------------------------------------
// OpenAI vision (primary palette path). Uses the shared AI client
// (src/ai.js): the workspace's own ai.api_key / model settings, the
// client's vision-model resolution, usage logging and budget checks all
// apply. Every failure mode — no key, timeout, provider error, garbage
// response — returns null and the caller falls back to the histogram.
// ---------------------------------------------------------------------------

function withTimeout(promise, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      }
    );
  });
}

async function visionChat(db, parts, { maxTokens, note, leadId }) {
  const ai = require('./ai');
  if (!(await ai.aiConfiguredRouted(db, 'vision'))) return null;
  const call = Promise.resolve()
    .then(() =>
      ai.chat({
        task: 'qa',
        messages: [{ role: 'user', content: parts }],
        maxTokens,
        leadId: leadId || null,
        note,
        db,
      })
    )
    .catch(() => null);
  const res = await withTimeout(call, OPENAI_TIMEOUT_MS);
  return res && res.text ? res.text : null;
}

async function visionDataUrl(buffer) {
  const sharp = require('sharp');
  const out = await sharp(buffer)
    .resize(VISION_MAX_EDGE, VISION_MAX_EDGE, { fit: 'inside' })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 82 })
    .toBuffer();
  return `data:image/jpeg;base64,${out.toString('base64')}`;
}

function parseJsonObject(text) {
  if (!text || typeof text !== 'string') return null;
  const cleaned = text.replace(/```(?:json)?/gi, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(cleaned.slice(start, end + 1));
    return obj && typeof obj === 'object' ? obj : null;
  } catch {
    return null;
  }
}

function normalizeHexColor(v) {
  if (typeof v !== 'string') return null;
  const m = v.trim().match(/^#?([0-9a-f]{6})$/i);
  return m ? `#${m[1].toLowerCase()}` : null;
}

function hexToRgb(hex) {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

/** Exact + near-duplicate suppression, order preserved. */
function dedupeColors(list) {
  const out = [];
  for (const hex of list) {
    if (!hex) continue;
    const [r, g, b] = hexToRgb(hex);
    const nearDup = out.some((o) => {
      const [or, og, ob] = hexToRgb(o);
      return Math.abs(or - r) + Math.abs(og - g) + Math.abs(ob - b) < 60;
    });
    if (!nearDup) out.push(hex);
  }
  return out;
}

/**
 * Validate a logo bounding box in 0–1000 normalized coordinates.
 * Returns the clamped box, or null when the box is unusable (inverted,
 * degenerate, or covering nearly the whole page — not a logo).
 */
function validateLogoBox(box) {
  if (!box || typeof box !== 'object') return null;
  const nums = ['x_min', 'y_min', 'x_max', 'y_max'].map((k) => Number(box[k]));
  if (nums.some((n) => !Number.isFinite(n))) return null;
  const clamp = (n) => Math.max(0, Math.min(1000, n));
  const [xMin, yMin, xMax, yMax] = nums.map(clamp);
  const w = xMax - xMin;
  const h = yMax - yMin;
  if (w < 20 || h < 20) return null; // under 2% of an edge — a speck, not a logo
  if ((w * h) / 1000000 > 0.92) return null; // the whole page is not a crop
  return { x_min: xMin, y_min: yMin, x_max: xMax, y_max: yMax };
}

function parseVisionPalette(text) {
  const obj = parseJsonObject(text);
  if (!obj) return null;
  const ordered = dedupeColors([
    normalizeHexColor(obj.primary),
    normalizeHexColor(obj.secondary),
    ...(Array.isArray(obj.palette) ? obj.palette.map(normalizeHexColor) : []),
  ]).slice(0, MAX_COLORS);
  if (!ordered.length) return null;
  return {
    palette: ordered,
    primary: ordered[0] || null,
    secondary: ordered[1] || null,
    logoBox: validateLogoBox(obj.logo_box),
  };
}

const PALETTE_PROMPT_IMAGE = [
  'You are extracting the brand identity colors of a small business from its brochure image.',
  'Focus on the LOGO and brand identity elements (logo, headings, brand color blocks, signage).',
  'Ignore incidental colors from stock photography, product/food photos, skin tones, and the white page background.',
  'Respond with ONLY a JSON object, no other text:',
  '{"primary":"#rrggbb","secondary":"#rrggbb","palette":["#rrggbb"],"logo_box":{"x_min":0,"y_min":0,"x_max":0,"y_max":0}}',
  'palette holds 3 to 5 hex colors, most important brand color first, including primary and secondary.',
  'logo_box is the bounding box of the business logo in 0-1000 normalized coordinates, or null when no logo is visible.',
].join(' ');

const PALETTE_PROMPT_PDF = [
  'You are extracting the brand identity colors of a small business from images pulled out of its brochure PDF.',
  'Focus on logos and brand identity elements. Ignore incidental colors from stock photography, product/food photos, and white backgrounds.',
  'Respond with ONLY a JSON object, no other text:',
  '{"primary":"#rrggbb","secondary":"#rrggbb","palette":["#rrggbb"]}',
  'palette holds 3 to 5 hex colors, most important brand color first, including primary and secondary.',
].join(' ');

async function paletteFromOpenAI(buf, kind, opts) {
  const db = opts && opts.db;
  if (!db) return null;
  let images;
  if (kind === 'pdf') {
    const candidates = await pdfCandidateImages(buf).catch(() => []);
    images = candidates
      .slice()
      .sort((a, b) => b.width * b.height - a.width * a.height)
      .slice(0, 2)
      .map((c) => c.buffer);
  } else {
    images = [buf];
  }
  if (!images.length) return null;
  const parts = [{ type: 'text', text: kind === 'pdf' ? PALETTE_PROMPT_PDF : PALETTE_PROMPT_IMAGE }];
  for (const buffer of images) {
    parts.push({ type: 'image_url', image_url: { url: await visionDataUrl(buffer), detail: 'low' } });
  }
  const text = await visionChat(db, parts, {
    maxTokens: 400,
    note: 'website-promo brochure brand colors (vision)',
    leadId: opts.leadId,
  });
  if (!text) return null;
  return parseVisionPalette(text);
}

// ---------------------------------------------------------------------------
// Brand assets: logo + complementing photos/graphics lifted from the
// brochure. Returns image BUFFERS with metadata; persisting them (and
// pointing style_guide at the stored files) is the route's job, matching
// how saveBrochure owns the brochure file itself. Never throws.
// ---------------------------------------------------------------------------

const CLASSIFY_PROMPT = [
  'You are sorting images extracted from a business brochure for reuse on its website.',
  'Classify each image as exactly one of: "logo" (the business logo or brand mark),',
  '"photo" (a real photograph of the business, its products, people, or premises),',
  '"graphic" (an illustration, icon, badge, or decorative brand graphic), or',
  '"ignore" (blank, filler, stock clipart, QR code, map screenshot, or unusable).',
  'Respond with ONLY a JSON object, no other text:',
  '{"images":[{"index":1,"type":"logo","label":"short 2-5 word label"}],"logo_index":1}',
  'index is the 1-based image number announced before each image; logo_index is the index of the logo, or null.',
].join(' ');

const CLASSIFY_TYPES = new Set(['logo', 'photo', 'graphic', 'ignore']);

function parseClassification(text, count) {
  const obj = parseJsonObject(text);
  if (!obj || !Array.isArray(obj.images)) return null;
  const out = new Array(count).fill(null);
  for (const item of obj.images) {
    const idx = Number(item && item.index) - 1;
    if (!Number.isInteger(idx) || idx < 0 || idx >= count) continue;
    const type = CLASSIFY_TYPES.has(item.type) ? item.type : 'ignore';
    const label = String((item && item.label) || '').trim().slice(0, 60);
    out[idx] = { type, label };
  }
  // logo_index is a tiebreak/hint: honor it when nothing was typed logo.
  if (!out.some((c) => c && c.type === 'logo')) {
    const li = Number(obj.logo_index) - 1;
    if (Number.isInteger(li) && li >= 0 && li < count) {
      out[li] = { type: 'logo', label: (out[li] && out[li].label) || 'Logo' };
    }
  }
  // At most one logo: later duplicates are demoted to graphics.
  let seenLogo = false;
  for (let i = 0; i < out.length; i++) {
    if (out[i] && out[i].type === 'logo') {
      if (seenLogo) out[i] = { type: 'graphic', label: out[i].label || 'Brand graphic' };
      seenLogo = true;
    }
  }
  return out;
}

async function classifyCandidateImages(candidates, opts) {
  const db = opts && opts.db;
  if (!db) return null;
  const parts = [{ type: 'text', text: CLASSIFY_PROMPT }];
  for (let i = 0; i < candidates.length; i++) {
    parts.push({ type: 'text', text: `Image ${i + 1}` });
    parts.push({ type: 'image_url', image_url: { url: await visionDataUrl(candidates[i].buffer), detail: 'low' } });
  }
  const text = await visionChat(db, parts, {
    maxTokens: 600,
    note: 'website-promo brochure image classification',
    leadId: opts.leadId,
  });
  if (!text) return null;
  return parseClassification(text, candidates.length);
}

/** Blank / near-solid images (blank scans, color swatches) are junk assets. */
async function imageLooksBlank(buffer) {
  try {
    const sharp = require('sharp');
    const stats = await sharp(buffer).stats();
    return stats.channels.slice(0, 3).every((c) => (c.stdev || 0) < 2);
  } catch {
    return false;
  }
}

async function assetsFromPdf(buf, opts) {
  const candidates = [];
  for (const c of await pdfCandidateImages(buf)) {
    if (c.width < ASSET_MIN_EDGE || c.height < ASSET_MIN_EDGE) continue; // bullets, rules, spacers
    if (await imageLooksBlank(c.buffer)) continue;
    candidates.push(c);
  }
  if (!candidates.length) return { logo: null, assets: [] };
  const classes = await classifyCandidateImages(candidates, opts).catch(() => null);
  let logo = null;
  const assets = [];
  candidates.forEach((c, i) => {
    const cls = classes && classes[i];
    const type = cls ? cls.type : 'graphic'; // no vision → keep as unlabeled brand material, never guess a logo
    if (type === 'ignore') return;
    if (type === 'logo' && !logo) {
      logo = {
        buffer: c.buffer,
        ext: '.png',
        mimeType: 'image/png',
        kind: 'logo',
        label: (cls && cls.label) || 'Logo',
        source: 'pdf-embed',
      };
      return;
    }
    if (assets.length < MAX_ASSETS) {
      assets.push({
        buffer: c.buffer,
        ext: '.png',
        mimeType: 'image/png',
        kind: type,
        label: (cls && cls.label) || (type === 'photo' ? 'Brochure photo' : 'Brochure graphic'),
        source: 'pdf-embed',
      });
    }
  });
  return { logo, assets };
}

const LOGO_BOX_PROMPT = [
  'Find the business logo in this brochure image.',
  'Respond with ONLY a JSON object, no other text:',
  '{"logo_box":{"x_min":0,"y_min":0,"x_max":0,"y_max":0}}',
  'Coordinates are normalized to 0-1000. Use null for logo_box when no logo is visible.',
].join(' ');

async function logoBoxFromVision(buf, opts) {
  const db = opts && opts.db;
  if (!db) return null;
  const parts = [
    { type: 'text', text: LOGO_BOX_PROMPT },
    { type: 'image_url', image_url: { url: await visionDataUrl(buf), detail: 'low' } },
  ];
  const text = await visionChat(db, parts, {
    maxTokens: 200,
    note: 'website-promo brochure logo locate (vision)',
    leadId: opts.leadId,
  });
  if (!text) return null;
  const obj = parseJsonObject(text);
  return obj ? validateLogoBox(obj.logo_box) : null;
}

async function assetsFromImage(buf, opts) {
  // opts.logoBox: a validated box from the palette vision call, null when
  // that call already established there is no logo, undefined when the
  // palette came from the deterministic path (ask vision directly).
  let box = opts.logoBox;
  if (box === undefined) {
    box = await logoBoxFromVision(buf, opts).catch(() => null);
  }
  if (!box) return { logo: null, assets: [] };
  const sharp = require('sharp');
  const meta = await sharp(buf).metadata();
  if (!meta.width || !meta.height) return { logo: null, assets: [] };
  const left = Math.round((box.x_min / 1000) * meta.width);
  const top = Math.round((box.y_min / 1000) * meta.height);
  const width = Math.max(1, Math.round(((box.x_max - box.x_min) / 1000) * meta.width));
  const height = Math.max(1, Math.round(((box.y_max - box.y_min) / 1000) * meta.height));
  if (width < 8 || height < 8 || left + width > meta.width || top + height > meta.height) {
    return { logo: null, assets: [] };
  }
  const cropped = await sharp(buf).extract({ left, top, width, height }).png().toBuffer();
  return {
    logo: { buffer: cropped, ext: '.png', mimeType: 'image/png', kind: 'logo', label: 'Logo', source: 'vision-crop' },
    assets: [],
  };
}

/**
 * Lift the logo + complementing brand assets out of a brochure.
 * @param {Buffer} buf brochure bytes
 * @param {string} kind sniffed kind from sniffBrochureType()
 * @param {{db?:object, leadId?:number, logoBox?:object|null}} [opts]
 * @returns {Promise<{logo:object|null, assets:object[]}>} buffers + metadata; never throws
 */
async function extractBrochureAssets(buf, kind, opts = {}) {
  try {
    if (kind === 'pdf') return await assetsFromPdf(buf, opts);
    if (kind === 'png' || kind === 'jpeg' || kind === 'webp') return await assetsFromImage(buf, opts);
    return { logo: null, assets: [] };
  } catch {
    return { logo: null, assets: [] };
  }
}

// ---------------------------------------------------------------------------

/**
 * @param {Buffer} buf brochure bytes
 * @param {string} kind sniffed kind from sniffBrochureType()
 * @param {{db?:object, leadId?:number}} [opts] workspace db enables the OpenAI vision path
 * @returns {Promise<{status:'extracted'|'pending', palette:string[], primary:string|null, secondary:string|null, palette_source:'openai'|'histogram'|'pending', logo_box?:object|null}>}
 */
async function extractBrochurePalette(buf, kind, opts = {}) {
  const pending = { status: 'pending', palette: [], primary: null, secondary: null, palette_source: 'pending' };
  try {
    if (kind !== 'png' && kind !== 'jpeg' && kind !== 'webp' && kind !== 'pdf') return pending;

    // Primary path: OpenAI vision on the workspace's own AI settings.
    if (opts.db) {
      const aiResult = await paletteFromOpenAI(buf, kind, opts).catch(() => null);
      if (aiResult) {
        const out = {
          status: 'extracted',
          palette: aiResult.palette,
          primary: aiResult.primary,
          secondary: aiResult.secondary,
          palette_source: 'openai',
        };
        // The image-brochure vision call also locates the logo; hand the
        // box to the asset pass so it does not need a second call. null
        // means "vision looked, no logo" — distinct from "not asked".
        if (kind !== 'pdf') out.logo_box = aiResult.logoBox || null;
        return out;
      }
    }

    // Fallback: deterministic histogram.
    const palette = kind === 'pdf' ? await paletteFromPdfBuffer(buf) : await paletteFromImageBuffer(buf);
    if (!palette.length) return pending;
    return {
      status: 'extracted',
      palette,
      primary: palette[0] || null,
      secondary: palette[1] || null,
      palette_source: 'histogram',
    };
  } catch {
    return pending;
  }
}

module.exports = {
  sniffBrochureType,
  declaredFamily,
  DECLARED_FAMILY_KINDS,
  extractBrochurePalette,
  extractBrochureAssets,
  paletteFromImageBuffer,
  paletteFromPdfBuffer,
  // internals exported for unit tests
  parseVisionPalette,
  parseClassification,
  validateLogoBox,
  normalizeHexColor,
  pdfCandidateImages,
};
