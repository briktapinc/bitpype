/* Batch 111 (consolidation): the ONE shared source for the curated
   inline-SVG module icon family — one glyph per module type, all
   drawn on the same 24x24 stroke grid (1.8 stroke, round caps/joins,
   currentColor). No emoji, no icon fonts, no external requests.
   Loaded by BOTH shells (portal.html before portal.js, index.html
   before app.js); MODULE_ICON_FALLBACK (building blocks) covers any
   future type without a glyph of its own yet, so a card never
   renders iconless. Before Batch 111 this map lived as two
   byte-identical copies in portal.js and app.js, kept in sync only
   by a test; the glyphs below are byte-for-byte those copies. */
const MODULE_ICON_PATHS = {
  blog: '<path d="M6 3.5h8.5L19 8v12.5H6z"/><path d="M14.5 3.5V8H19"/><path d="M9 12.5h6.5"/><path d="M9 16h6.5"/>',
  ecommerce: '<path d="M5.5 8h13l-1.1 12.5H6.6L5.5 8z"/><path d="M9 10.5V6.5a3 3 0 0 1 6 0v4"/>',
  courses: '<path d="M12 6.2C10.2 4.6 8 4.2 4 4.2v13.6c4 0 6.2.4 8 2 1.8-1.6 4-2 8-2V4.2c-4 0-6.2.4-8 2z"/><path d="M12 6.2v13.6"/>',
  gallery: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M4.5 18l4.7-4.2 3.3 2.8 2.8-2.3 4.2 3.7"/>',
  directory: '<path d="M9.5 6H20"/><path d="M9.5 12H20"/><path d="M9.5 18H20"/><circle cx="4.8" cy="6" r="1.1"/><circle cx="4.8" cy="12" r="1.1"/><circle cx="4.8" cy="18" r="1.1"/>',
  faq: '<circle cx="12" cy="12" r="8.8"/><path d="M9.6 9.4a2.6 2.6 0 1 1 3.4 2.5c-.7.3-1 .8-1 1.6v.4"/><circle cx="12" cy="16.9" r="0.4" fill="currentColor"/>',
  testimonials: '<path d="M4 5h16v10.5H9.5L4 19.5z"/><path d="M8 8.8v3"/><path d="M12 8.8v3"/>',
  team: '<circle cx="9" cy="8" r="3.1"/><path d="M3.6 19.2c.6-3 2.7-4.6 5.4-4.6s4.8 1.6 5.4 4.6"/><path d="M15.8 5.3a3.1 3.1 0 0 1 0 5.7"/><path d="M17.6 14.9c1.6.7 2.6 2.1 2.9 4.3"/>',
  events: '<rect x="3.5" y="5" width="17" height="16" rx="2"/><path d="M3.5 10h17"/><path d="M8 3v4"/><path d="M16 3v4"/><circle cx="12" cy="15.5" r="1.6"/>',
  bookings: '<rect x="3.5" y="5" width="17" height="16" rx="2"/><path d="M3.5 10h17"/><path d="M8 3v4"/><path d="M16 3v4"/><path d="M9.2 15.8l2 2 3.6-3.8"/>',
  chatbot: '<rect x="4" y="8.5" width="16" height="10.5" rx="3"/><path d="M12 8.5V5"/><circle cx="12" cy="3.8" r="1.1"/><circle cx="9" cy="13" r="0.4" fill="currentColor"/><circle cx="15" cy="13" r="0.4" fill="currentColor"/><path d="M9.2 16.2h5.6"/>',
  offers: '<path d="M3.8 3.8H12L20.2 12a2 2 0 0 1 0 2.8l-5.4 5.4a2 2 0 0 1-2.8 0L3.8 12z"/><circle cx="8.2" cy="8.2" r="1.4"/>',
  menu: '<path d="M6 3h12v18l-2-1.4-2 1.4-2-1.4L10 21l-2-1.4L6 21z"/><path d="M9.2 8h5.6"/><path d="M9.2 12h5.6"/>',
  careers: '<rect x="3" y="8" width="18" height="12" rx="2"/><path d="M9 8V6.5A2.5 2.5 0 0 1 11.5 4h1A2.5 2.5 0 0 1 15 6.5V8"/><path d="M3 13h18"/>',
  video: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M10.4 9.4l5.2 2.6-5.2 2.6z" fill="currentColor" stroke="none"/>',
  estimate: '<rect x="6" y="3" width="12" height="18" rx="2"/><path d="M9.2 6.8h5.6"/><circle cx="9.4" cy="11" r="0.4" fill="currentColor"/><circle cx="12" cy="11" r="0.4" fill="currentColor"/><circle cx="14.6" cy="11" r="0.4" fill="currentColor"/><circle cx="9.4" cy="14.4" r="0.4" fill="currentColor"/><circle cx="12" cy="14.4" r="0.4" fill="currentColor"/><circle cx="14.6" cy="14.4" r="0.4" fill="currentColor"/><circle cx="9.4" cy="17.8" r="0.4" fill="currentColor"/><circle cx="12" cy="17.8" r="0.4" fill="currentColor"/><circle cx="14.6" cy="17.8" r="0.4" fill="currentColor"/>',
  socialfeed: '<circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/><path d="M8.6 15.4a4.8 4.8 0 0 1 0-6.8"/><path d="M15.4 8.6a4.8 4.8 0 0 1 0 6.8"/><path d="M6 18a8.8 8.8 0 0 1 0-12"/><path d="M18 6a8.8 8.8 0 0 1 0 12"/>',
  googlereviews: '<path d="M12 3.6l2.5 5.2 5.7.7-4.2 3.9 1.1 5.6L12 16.3l-5.1 2.7 1.1-5.6L3.8 9.5l5.7-.7z"/>',
  calltracking: '<path d="M5.2 3.8h3.6L10.3 8 8.2 9.6a12.5 12.5 0 0 0 6.2 6.2l1.6-2.1 4.3 1.5v3.6a2 2 0 0 1-2.1 2A16.8 16.8 0 0 1 3.2 5.9a2 2 0 0 1 2-2.1z"/>',
  members: '<rect x="4" y="3" width="16" height="18" rx="2"/><circle cx="12" cy="10" r="2.6"/><path d="M7.6 17.8c.8-2.1 2.4-3.2 4.4-3.2s3.6 1.1 4.4 3.2"/>',
  datatables: '<rect x="3.5" y="4" width="17" height="16" rx="1.6"/><path d="M3.5 9.4h17"/><path d="M3.5 14.7h17"/><path d="M9.2 4v16"/><path d="M14.8 4v16"/>',
  charts: '<path d="M4 4v16h16"/><rect x="7.2" y="12" width="2.9" height="8"/><rect x="11.6" y="8.5" width="2.9" height="11.5"/><rect x="16" y="14.5" width="2.9" height="5.5"/>',
  newsletter: '<rect x="3" y="5.5" width="18" height="13" rx="2"/><path d="M3.8 7.2L12 13l8.2-5.8"/>',
  categories: '<circle cx="6.5" cy="5.5" r="1.8"/><circle cx="17.5" cy="10" r="1.8"/><circle cx="17.5" cy="18" r="1.8"/><path d="M6.5 7.3v9.2"/><path d="M6.5 10h9.2"/><path d="M6.5 16.5h9.2"/>',
  photocapture: '<path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h1.2l1.8-2.5h7L17.3 7h1.2A1.5 1.5 0 0 1 20 8.5V18a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18z"/><circle cx="12" cy="13" r="3.4"/>',
  qrcode: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><path d="M13.5 13.5h3.2v3.2h-3.2z"/><path d="M17.3 17.3h3.2v3.2h-3.2z"/><path d="M13.5 20.5h3.2"/>',
  checkout: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M3.5 9.5h17"/><path d="M7 15.2l2.2 2.2 4-4.2"/>',
  comments: '<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5c-1.5 0-3-.4-4.2-1.1L3 20l1.1-5.3A8.5 8.5 0 1 1 21 11.5z"/><path d="M8 10.5h8"/><path d="M8 14h5"/>',
  pricing: '<path d="M3.8 3.8h7.4l9 9a1.6 1.6 0 0 1 0 2.3l-5.1 5.1a1.6 1.6 0 0 1-2.3 0l-9-9z"/><circle cx="8.2" cy="8.2" r="1.7"/>',
  custom_code: '<path d="M8.5 6.5L3.8 12l4.7 5.5"/><path d="M15.5 6.5l4.7 5.5-4.7 5.5"/><path d="M13.4 4.8l-2.8 14.4"/>',
  webinar: '<rect x="3" y="5" width="18" height="13" rx="2"/><path d="M10.3 9.1l4.6 2.4-4.6 2.4z"/>',
};
const MODULE_ICON_FALLBACK = '<rect x="4" y="4" width="7" height="7" rx="1.6"/><rect x="13" y="4" width="7" height="7" rx="1.6"/><rect x="4" y="13" width="7" height="7" rx="1.6"/><rect x="13" y="13" width="7" height="7" rx="1.6"/>';
