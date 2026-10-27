'use strict';

/**
 * SEO schema builders (Batch 31 — SEO foundations).
 *
 * Pure helpers shared by:
 *  - the renderer/exporter (src/websiteEngine.js) which auto-emits
 *    LocalBusiness + FAQPage JSON-LD on every site, and
 *  - the Batch-22 AI SEO tool (server/seoTool.js), which delegates its
 *    schema assembly here so there is exactly ONE LocalBusiness builder.
 *
 * Honesty rule: a field is emitted ONLY when backed by real data on the
 * lead/site record. Nothing is fabricated — no geo without stored
 * coordinates, no hours without stored hours, no sameAs without stored
 * social links.
 */

function parseJsonLoose(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    const v = JSON.parse(String(value));
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}

function cleanStr(v, cap = 500) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, cap);
}

/** Strip HTML to plain text (FAQ answers ride answer_html in the module). */
function stripHtmlToText(html) {
  return String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

/** Most specific schema.org type justifiable from the business category. */
function schemaTypeFor(category) {
  const c = String(category || '').toLowerCase();
  const map = [
    [/plumb/, 'Plumber'],
    [/electric/, 'Electrician'],
    [/hvac|heating|air conditioning/, 'HVACBusiness'],
    [/roof/, 'RoofingContractor'],
    [/restaurant|cafe|bakery|pizza/, 'Restaurant'],
    [/dent/, 'Dentist'],
    [/lawyer|attorney|law firm/, 'Attorney'],
    [/salon|barber|beauty/, 'HairSalon'],
    [/auto repair|mechanic|car repair/, 'AutoRepair'],
    [/contractor|construction|remodel/, 'GeneralContractor'],
    [/landscap|lawn/, 'LandscapingBusiness'],
    [/real estate|realtor/, 'RealEstateAgent'],
    [/gym|fitness/, 'ExerciseGym'],
    [/vet/, 'VeterinaryCare'],
  ];
  for (const [re, type] of map) if (re.test(c)) return type;
  return 'LocalBusiness';
}

const DAY_NAMES = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const DAY_SCHEMA = {
  mon: 'Monday', monday: 'Monday',
  tue: 'Tuesday', tues: 'Tuesday', tuesday: 'Tuesday',
  wed: 'Wednesday', wednesday: 'Wednesday',
  thu: 'Thursday', thur: 'Thursday', thurs: 'Thursday', thursday: 'Thursday',
  fri: 'Friday', friday: 'Friday',
  sat: 'Saturday', saturday: 'Saturday',
  sun: 'Sunday', sunday: 'Sunday',
};

function dayToSchema(day) {
  const d = String(day || '').trim().toLowerCase().replace(/[^a-z]/g, '');
  if (!d) return null;
  if (DAY_SCHEMA[d]) return DAY_SCHEMA[d];
  const hit = DAY_NAMES.find((n) => n.startsWith(d) || d.startsWith(n.slice(0, 3)));
  return hit ? hit.charAt(0).toUpperCase() + hit.slice(1) : null;
}

/** "9:00 AM" / "9am" / "09:00" / "17:30" → "09:00" / "17:30" (24h), or null. */
function timeTo24h(value) {
  const s = String(value || '').trim().toLowerCase();
  if (!s) return null;
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  if (!Number.isFinite(h) || !Number.isFinite(min) || min > 59) return null;
  if (m[3] === 'pm' && h < 12) h += 12;
  if (m[3] === 'am' && h === 12) h = 0;
  if (h > 23) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/**
 * leads.hours JSON → openingHoursSpecification[].
 * Tolerated shapes: [{day, open, close}], [{day, hours: "9-5"}],
 * ["Mon-Fri 9am-5pm"], {Monday: "9:00-17:00"}, {days:[...], open, close}.
 * Unparseable entries are skipped — never guessed.
 */
function openingHoursSpecification(hoursRaw) {
  const hours = parseJsonLoose(hoursRaw, null);
  const out = [];
  const push = (dayRaw, openRaw, closeRaw) => {
    const day = dayToSchema(dayRaw);
    const opens = timeTo24h(openRaw);
    const closes = timeTo24h(closeRaw);
    if (day && opens && closes) {
      out.push({ '@type': 'OpeningHoursSpecification', dayOfWeek: day, opens, closes });
    }
  };
  const pushRange = (dayRaw, rangeRaw) => {
    const range = String(rangeRaw || '');
    const m = range.match(/(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*[-–—to]+\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i);
    if (m) push(dayRaw, m[1], m[2]);
  };
  const entries = Array.isArray(hours) ? hours : hours && typeof hours === 'object' ? [hours] : [];
  for (const entry of entries) {
    if (typeof entry === 'string') {
      const m = entry.match(/^([a-z]{3,9})[a-z]*\.?\s+(.+)$/i);
      if (m) pushRange(m[1], m[2]);
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    if (Array.isArray(entry.days)) {
      for (const d of entry.days) push(d, entry.open || entry.opens, entry.close || entry.closes);
      continue;
    }
    const day = entry.day || entry.dayOfWeek || entry.name || entry.label;
    if (day && (entry.open || entry.opens || entry.close || entry.closes)) {
      push(day, entry.open || entry.opens, entry.close || entry.closes);
    } else if (day && (entry.hours || entry.time || entry.range)) {
      pushRange(day, entry.hours || entry.time || entry.range);
    } else {
      // {Monday: "9-5"} object-map shape.
      for (const [k, v] of Object.entries(entry)) {
        if (dayToSchema(k)) {
          if (typeof v === 'string') pushRange(k, v);
          else if (v && typeof v === 'object') push(k, v.open || v.opens, v.close || v.closes);
        }
      }
    }
  }
  return out;
}

/** leads.social_links JSON → array of absolute http(s) URLs. */
function socialUrls(socialRaw) {
  const links = parseJsonLoose(socialRaw, []);
  const out = [];
  if (!Array.isArray(links)) return out;
  for (const entry of links) {
    const url =
      typeof entry === 'string'
        ? entry
        : entry && typeof entry === 'object'
          ? entry.url || entry.href || entry.link || ''
          : '';
    const u = String(url || '').trim();
    if (/^https?:\/\//i.test(u) && !out.includes(u)) out.push(u);
  }
  return out;
}

/**
 * Service-area towns from business_facts rows (VERIFIED / OWNER_PROVIDED
 * only — callers pass pre-filtered rows). Accepts comma/semicolon lists
 * or JSON arrays under keys like service_area, service_areas, towns,
 * areas_served, servicearea.
 */
function serviceAreaTowns(factRows) {
  const towns = [];
  const AREA_KEY = /^(service[-_ ]?areas?|areas?[-_ ]?served|towns|coverage[-_ ]?areas?)$/i;
  for (const row of Array.isArray(factRows) ? factRows : []) {
    if (!row || !AREA_KEY.test(String(row.fact_key || '').trim())) continue;
    const parsed = parseJsonLoose(row.value, null);
    let parts;
    if (Array.isArray(parsed)) {
      parts = parsed.map((v) => String(v || ''));
    } else {
      const raw = String(row.value || '');
      if (/[;\n]/.test(raw)) {
        parts = raw.split(/[;\n]+/);
      } else {
        // "Reading, PA, Wyomissing, PA" — commas separate ENTRIES, but
        // each entry itself contains a comma before the state code.
        const pairs = raw.match(/[^,;]+,\s*[A-Z]{2}\b/g);
        parts =
          pairs && pairs.length > 1 ? pairs : raw.split(/,/);
      }
    }
    for (const part of parts) {
      const town = cleanStr(part, 120);
      if (town && !towns.some((t) => t.toLowerCase() === town.toLowerCase())) towns.push(town);
    }
  }
  return towns.slice(0, 40);
}

/**
 * Build the LocalBusiness JSON-LD object from a normalized context:
 * { businessName, category, description, phone, email, url, address,
 *   city, state, postalCode, country, latitude, longitude, hours,
 *   socialLinks, towns, services }
 * Only fields backed by real data are emitted.
 */
function buildLocalBusinessLd(ctx) {
  const c = ctx && typeof ctx === 'object' ? ctx : {};
  const name = cleanStr(c.businessName || c.name, 200);
  if (!name) return null;
  const ld = {
    '@context': 'https://schema.org',
    '@type': schemaTypeFor(c.category),
    name,
  };
  const description = cleanStr(c.description, 600);
  if (description) ld.description = description;
  const phone = cleanStr(c.phone || c.telephone, 60);
  if (phone) ld.telephone = phone;
  const email = cleanStr(c.email, 200);
  if (email && /@/.test(email)) ld.email = email;
  const url = cleanStr(c.url, 500);
  if (url && /^https?:\/\//i.test(url)) ld.url = url;
  const image = cleanStr(c.image, 500);
  if (image) ld.image = image;
  const street = cleanStr(c.address || c.streetAddress, 300);
  const city = cleanStr(c.city, 120);
  const state = cleanStr(c.state, 120);
  const postal = cleanStr(c.postalCode || c.postal_code, 40);
  const country = cleanStr(c.country, 8) || 'US';
  if (street || city || state || postal) {
    const addr = { '@type': 'PostalAddress' };
    if (street) addr.streetAddress = street;
    if (city) addr.addressLocality = city;
    if (state) addr.addressRegion = state;
    if (postal) addr.postalCode = postal;
    if (country) addr.addressCountry = country;
    ld.address = addr;
  }
  const lat = Number(c.latitude);
  const lng = Number(c.longitude);
  if (Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0)) {
    ld.geo = { '@type': 'GeoCoordinates', latitude: lat, longitude: lng };
  }
  const hours = openingHoursSpecification(c.hours);
  if (hours.length) ld.openingHoursSpecification = hours;
  const towns = (Array.isArray(c.towns) ? c.towns : []).map((t) => cleanStr(t, 120)).filter(Boolean);
  if (towns.length) {
    ld.areaServed = towns.map((t) => ({ '@type': 'City', name: t }));
  } else if (city) {
    ld.areaServed = state ? `${city}, ${state}` : city;
  }
  const sameAs = socialUrls(c.socialLinks != null ? c.socialLinks : c.social_links);
  if (sameAs.length) ld.sameAs = sameAs;
  const services = (Array.isArray(c.services) ? c.services : []).map((s) => cleanStr(s, 160)).filter(Boolean);
  if (services.length) ld.knowsAbout = services.slice(0, 12);
  return ld;
}

/**
 * FAQPage JSON-LD from Q&A items. Accepts section items ({q, a}) and
 * faq-module rows ({question, answer_html}).
 */
function buildFaqPageLd(items) {
  const list = (Array.isArray(items) ? items : [])
    .map((it) => {
      if (!it || typeof it !== 'object') return null;
      const q = cleanStr(it.q || it.question || it.title, 500);
      const a = stripHtmlToText(it.a || it.answer || it.answer_html || it.text || '');
      if (!q || !a) return null;
      return {
        '@type': 'Question',
        name: q,
        acceptedAnswer: { '@type': 'Answer', text: a.slice(0, 4000) },
      };
    })
    .filter(Boolean);
  if (!list.length) return null;
  return { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: list };
}

/** Serialize a JSON-LD object for embedding inside a <script> tag. */
function ldJsonScript(ld, marker) {
  if (!ld) return '';
  const json = JSON.stringify(ld, null, 2).replace(/</g, '\\u003c');
  const attr = marker ? ` data-bitpype-seo="${marker}"` : '';
  return `<script type="application/ld+json"${attr}>\n${json}\n</script>`;
}

/**
 * @type values found in ld+json blocks inside a head HTML string. Used
 * for the dedupe rule: an explicit customHead schema wins for its type,
 * so the auto-emitted block for that type is skipped.
 */
function ldJsonTypesIn(headHtml) {
  const types = new Set();
  const re = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(String(headHtml || '')))) {
    try {
      const parsed = JSON.parse(m[1].trim());
      const collect = (node) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) return node.forEach(collect);
        if (node['@type']) {
          const t = node['@type'];
          (Array.isArray(t) ? t : [t]).forEach((x) => types.add(String(x)));
        }
        if (node['@graph']) collect(node['@graph']);
      };
      collect(parsed);
    } catch {
      /* unparseable block — not evidence of a typed schema */
    }
  }
  return types;
}

/** LocalBusiness-family types (for the C4 dedupe rule). */
const LOCAL_BUSINESS_TYPES = new Set([
  'LocalBusiness', 'Plumber', 'Electrician', 'HVACBusiness', 'RoofingContractor', 'Restaurant',
  'Dentist', 'Attorney', 'HairSalon', 'AutoRepair', 'GeneralContractor', 'LandscapingBusiness',
  'RealEstateAgent', 'ExerciseGym', 'VeterinaryCare', 'Organization', 'Store', 'ProfessionalService',
  'HomeAndConstructionBusiness', 'FoodEstablishment', 'HealthAndBeautyBusiness', 'AutomotiveBusiness',
  'LegalService', 'MedicalBusiness', 'LodgingBusiness', 'SportsActivityLocation', 'EntertainmentBusiness',
]);

function hasLocalBusinessType(types) {
  for (const t of types || []) if (LOCAL_BUSINESS_TYPES.has(t)) return true;
  return false;
}

module.exports = {
  parseJsonLoose,
  cleanStr,
  stripHtmlToText,
  schemaTypeFor,
  dayToSchema,
  timeTo24h,
  openingHoursSpecification,
  socialUrls,
  serviceAreaTowns,
  buildLocalBusinessLd,
  buildFaqPageLd,
  ldJsonScript,
  ldJsonTypesIn,
  hasLocalBusinessType,
  LOCAL_BUSINESS_TYPES,
};
