// @ts-check
'use strict';

/**
 * Batch 122 — THE SHARED MODULE LAYER (Ely, 2026-11-03).
 *
 * Standing architecture rule, in Ely's terms: modules are
 * INTERDEPENDENT — they share data and content through this one
 * common layer instead of living in silos with hand-built pairwise
 * links, "that way the agent has more flexibility in what it can
 * create, and this goes with all newer modules to be built in."
 *
 * Concretely, EVERY type in siteModules.MODULE_TYPES must appear in
 * SHARE_REGISTRY below, either as:
 *   - a PROVIDER — it declares what it shares: a reader that returns
 *     its PUBLISHED items in the one uniform shape, built on the
 *     type's existing list reader (never a second query path), or
 *   - a NON-PROVIDER — with an explicit one-line reason it shares no
 *     items (interactive/private/config-only module).
 * The batch122 regression suite pins registry ⇔ MODULE_TYPES parity,
 * so a future module type CANNOT ship outside this layer silently:
 * adding a type without a registry entry fails the gate.
 *
 * Consumers read through listSharedItems / listSharedSources only:
 *   - module settings (shared refs — e.g. an event's gallery album),
 *   - the newsletter composer's auto-content blocks,
 *   - the design agent (site census + shared.* tools),
 *   - the portal pickers (shared sources/items API).
 * Batch 124 adds the categories service (server/categories.js) on
 * top of this layer: categories are a provider here, and a category's
 * items resolve through listSharedItemsByCategory — the taxonomy is
 * shared-layer data, not a silo of its own.
 * The agent uses the SAME config the portal edits — no back door.
 *
 * Discipline (Social Feed / Google Reviews precedents): published
 * items only; strictly lead-scoped (a workspace DB is one tenant —
 * no cross-workspace or cross-lead read exists here); a missing,
 * empty or broken source yields NO items and never throws into a
 * consumer, so a public page can never error because a source did.
 *
 * LeadScout (portalContacts) is the identity layer — a different
 * concern; this module never touches it.
 */

const modules = require('./siteModules');

function fail(code, message, status) {
  const err = new Error(message);
  // @ts-ignore - coded errors are the codebase convention
  err.code = code;
  if (status) {
    // @ts-ignore
    err.status = status;
  }
  return err;
}

function stripText(v, max = 400) {
  return String(v == null ? '' : v)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** One uniform item shape for everything a module shares. */
function item(sourceType, row, fields) {
  return {
    source_type: sourceType,
    source_id: fields.id != null ? fields.id : row && row.id,
    title: stripText(fields.title, 200),
    description: stripText(fields.description, 400),
    image_url: String(fields.image_url || ''),
    link_url: String(fields.link_url || ''),
    date: String(fields.date || ''),
    meta: fields.meta || {},
  };
}

const MAX_ITEMS = 200;

/* ------------------------------------------------------------------ */
/* The registry — one entry per MODULE_TYPES member.                   */
/* ------------------------------------------------------------------ */

const SHARE_REGISTRY = {
  blog: {
    kind: 'provider',
    read(db, leadId) {
      return modules.listBlogPosts(db, leadId, { includeDrafts: false, limit: MAX_ITEMS }).map((p) =>
        item('blog', p, {
          title: p.title,
          description: p.excerpt || p.body_html,
          image_url: p.cover_image,
          date: p.published_at || p.created_at,
          meta: { slug: p.slug || '' },
        })
      );
    },
  },
  ecommerce: {
    kind: 'provider',
    read(db, leadId) {
      return modules.listProducts(db, leadId, { includeDrafts: false }).map((p) =>
        item('ecommerce', p, {
          title: p.name,
          description: p.description,
          image_url: p.image_url,
          date: p.created_at,
          meta: { slug: p.slug || '', price_cents: p.price_cents || 0, currency: p.currency || 'USD' },
        })
      );
    },
  },
  courses: {
    kind: 'provider',
    read(db, leadId) {
      return modules.listCourses(db, leadId, { includeDrafts: false, withLessons: false }).map((c) =>
        item('courses', c, {
          title: c.title,
          description: c.description,
          image_url: c.cover_image,
          date: c.created_at,
          meta: { slug: c.slug || '' },
        })
      );
    },
  },
  gallery: {
    kind: 'provider',
    // Albums are the addressable items — an album is what consumers
    // link to (e.g. an event's photo gallery); its photos ride along
    // in meta so a consumer can render them without a second read.
    read(db, leadId) {
      return modules.listAlbums(db, leadId, { includeDrafts: false, withImages: true }).map((a) => {
        const images = (Array.isArray(a.images) ? a.images : [])
          .filter((im) => im && im.image_url)
          .map((im) => ({ id: im.id, image_url: im.image_url, caption: im.caption || '' }));
        return item('gallery', a, {
          title: a.title,
          description: a.description,
          image_url: images.length ? images[0].image_url : '',
          date: a.created_at,
          meta: { slug: a.slug || '', image_count: images.length, images: images.slice(0, 48) },
        });
      });
    },
  },
  directory: {
    kind: 'provider',
    read(db, leadId) {
      return modules.listListings(db, leadId, { includeDrafts: false }).map((l) =>
        item('directory', l, {
          title: l.name,
          description: l.description,
          image_url: l.image_url,
          link_url: l.website_url,
          date: l.created_at,
          meta: { slug: l.slug || '', category: l.category || '' },
        })
      );
    },
  },
  faq: {
    kind: 'provider',
    read(db, leadId) {
      return modules.listFaqItems(db, leadId, { includeDrafts: false }).map((f) =>
        item('faq', f, {
          title: f.question,
          description: f.answer_html,
          date: f.created_at,
          meta: { slug: f.slug || '', category: f.category || '' },
        })
      );
    },
  },
  testimonials: {
    kind: 'provider',
    read(db, leadId) {
      return modules.listTestimonials(db, leadId, { includeDrafts: false }).map((t) =>
        item('testimonials', t, {
          title: t.author_name || 'Client',
          description: t.quote,
          image_url: t.image_url,
          date: t.created_at,
          meta: {
            rating: t.rating || null,
            author_title: t.author_title || '',
            author_company: t.author_company || '',
          },
        })
      );
    },
  },
  team: {
    kind: 'provider',
    read(db, leadId) {
      return modules.listTeamMembers(db, leadId, { includeDrafts: false }).map((m) =>
        item('team', m, {
          title: m.name,
          description: m.bio,
          image_url: m.image_url,
          date: m.created_at,
          meta: { slug: m.slug || '', role_title: m.role_title || '' },
        })
      );
    },
  },
  events: {
    kind: 'provider',
    read(db, leadId) {
      return modules.listEvents(db, leadId, { includeDrafts: false }).map((e) =>
        item('events', e, {
          title: e.title,
          description: e.description,
          image_url: e.image_url,
          link_url: e.ticket_url,
          date: e.starts_at,
          meta: { slug: e.slug || '', location: e.location || '', ends_at: e.ends_at || '' },
        })
      );
    },
  },
  bookings: {
    kind: 'provider',
    // Services only — appointments are private customer data and are
    // never shared through this layer.
    read(db, leadId) {
      return modules.listBookingServices(db, leadId, { includeDrafts: false }).map((s) =>
        item('bookings', s, {
          title: s.name,
          description: s.description,
          image_url: s.image_url,
          date: s.created_at,
          meta: {
            slug: s.slug || '',
            duration_minutes: s.duration_minutes || null,
            price_label: s.price_label || '',
          },
        })
      );
    },
  },
  offers: {
    kind: 'provider',
    // listOffers with includeDrafts:false already drops expired
    // offers from public lists — shared items are current offers.
    read(db, leadId) {
      return modules.listOffers(db, leadId, { includeDrafts: false }).map((o) =>
        item('offers', o, {
          title: o.title,
          description: o.description,
          image_url: o.image_url,
          date: o.created_at,
          meta: { slug: o.slug || '', code: o.code || '', expires_at: o.expires_at || '' },
        })
      );
    },
  },
  menu: {
    kind: 'provider',
    read(db, leadId) {
      return modules.listMenuItems(db, leadId, { includeDrafts: false }).map((m) =>
        item('menu', m, {
          title: m.name,
          description: m.description,
          image_url: m.image_url,
          date: m.created_at,
          meta: { price_text: m.price_text || '', category_id: m.category_id || null, tags: m.tags || '' },
        })
      );
    },
  },
  careers: {
    kind: 'provider',
    read(db, leadId) {
      return modules.listCareersPostings(db, leadId, { includeInactive: false }).map((c) =>
        item('careers', c, {
          title: c.title,
          description: c.description,
          date: c.created_at,
          meta: { slug: c.slug || '', location: c.location || '', employment_type: c.employment_type || '' },
        })
      );
    },
  },
  video: {
    kind: 'provider',
    read(db, leadId) {
      return modules.listVideoItems(db, leadId, { includeDrafts: false }).map((v) =>
        item('video', v, {
          title: v.title,
          description: v.description,
          image_url: v.thumbnail_url || v.image_url,
          link_url: v.url,
          date: v.created_at,
          meta: { slug: v.slug || '' },
        })
      );
    },
  },
  socialfeed: {
    kind: 'provider',
    // The Social Feed module's own sources, via its public payload:
    // BitPype-published posts first, then the live Meta feed cache —
    // exactly what the site's feed shows.
    read(db, leadId) {
      const payload = modules.publicSocialFeedPayload(db, leadId);
      const items = payload && Array.isArray(payload.items) ? payload.items : [];
      return items.map((p, i) =>
        item('socialfeed', p, {
          id: p.external_id || String(i),
          title: p.text,
          description: p.text,
          image_url: p.image_url,
          link_url: p.permalink,
          date: p.published_at,
          meta: { network: p.network || '', source: p.source || '' },
        })
      );
    },
  },
  googlereviews: {
    kind: 'provider',
    // Dormant-empty by design: no key / no Place ID / no cache → the
    // payload is null and the source simply has no items.
    read(db, leadId) {
      const payload = modules.publicGoogleReviewsPayload(db, leadId);
      const reviews = payload && Array.isArray(payload.reviews) ? payload.reviews : [];
      return reviews.map((r, i) =>
        item('googlereviews', r, {
          id: String(i),
          title: r.author_name || r.author || 'Google review',
          description: r.text || r.snippet,
          image_url: r.profile_photo_url || r.author_photo || '',
          date: r.time || r.published_at || r.date || '',
          meta: { rating: r.rating || null, business: payload ? payload.name || '' : '' },
        })
      );
    },
  },
  chatbot: {
    kind: 'none',
    reason:
      'Sitewide assistant widget — its knowledge entries answer visitor questions; it publishes no shareable content items.',
  },
  estimate: {
    kind: 'none',
    reason:
      'Interactive calculator config; its requests are private customer data (captured in LeadScout), not content.',
  },
  calltracking: {
    kind: 'none',
    reason: 'Phone-routing config only; call records are private customer data (LeadScout), never shared content.',
  },
  members: {
    kind: 'none',
    reason:
      'Access-control module — tiers gate content and member records are private account data, not shareable items.',
  },
  datatables: {
    kind: 'none',
    reason:
      'Schema-less records with a per-site column layout — no uniform title/image/date shape; Charts already consumes tables through its own dedicated binding.',
  },
  charts: {
    kind: 'none',
    reason: 'A consumer, not a source — charts visualize Data Tables data and hold no content items of their own.',
  },
  newsletter: {
    kind: 'none',
    reason:
      'A consumer and a capture point — the composer draws blocks from other modules through this layer; the signup block itself publishes no items.',
  },
  categories: {
    kind: 'provider',
    // Batch 124 — the shared taxonomy itself is shareable content:
    // a category is an item other modules can draw on (its title,
    // image and how many published items it organizes). The reader
    // lives in server/categories.js (the service that owns the
    // tables); the lazy require keeps the load order acyclic.
    read(db, leadId) {
      return require('./categories')
        .listCategories(db, leadId, { includeDrafts: false, counts: 'published' })
        .map((c) =>
          item('categories', c, {
            title: c.name,
            description: c.description,
            image_url: c.image_url,
            date: c.created_at,
            meta: { slug: c.slug || '', scope: c.scope || '', item_count: c.item_count || 0 },
          })
        );
    },
  },
};

/* ------------------------------------------------------------------ */
/* Uniform reads                                                       */
/* ------------------------------------------------------------------ */

function registryEntry(type) {
  const t = String(type || '')
    .trim()
    .toLowerCase();
  return { type: t, entry: SHARE_REGISTRY[t] || null };
}

/** All items a provider shares for this lead. Never throws — a broken
 *  source reads as an empty source (dormant discipline). */
function readProviderItems(db, leadId, type) {
  const { entry } = registryEntry(type);
  if (!entry || entry.kind !== 'provider') return [];
  try {
    const items = entry.read(db, Number(leadId));
    return (Array.isArray(items) ? items : []).slice(0, MAX_ITEMS);
  } catch (e) {
    console.warn(`[moduleShare] provider ${type} read failed:`, (e && e.message) || e);
    return [];
  }
}

function listSharedItems(db, leadId, sourceType, opts = {}) {
  const { type, entry } = registryEntry(sourceType);
  if (!entry) throw fail('VALIDATION', `Unknown shared source: ${sourceType}`);
  if (entry.kind !== 'provider') {
    throw fail('VALIDATION', `${type} does not share items: ${entry.reason}`);
  }
  const limit = Math.max(1, Math.min(MAX_ITEMS, Number(opts.limit) || 20));
  return readProviderItems(db, leadId, type).slice(0, limit);
}

/** Batch 124 — items-by-category: the read the taxonomy's consumers
 *  use. A category (by id or slug) resolves to the published uniform
 *  items assigned to it, read through the category's OWN scope
 *  provider — assignments are resolved by the categories service,
 *  never by a second query path here. */
function listSharedItemsByCategory(db, leadId, categoryRef, opts = {}) {
  const cats = require('./categories');
  const category = cats.getCategory(db, Number(leadId), categoryRef, {});
  if (!category) throw fail('VALIDATION', `Unknown category: ${categoryRef}`);
  const limit = Math.max(1, Math.min(MAX_ITEMS, Number(opts.limit) || 50));
  return {
    category,
    items: cats.itemsForCategory(db, Number(leadId), category, { limit }),
  };
}

/** Sources overview for pickers + the agent census: every module
 *  type, its registry state, and for providers a live published
 *  count + sample items — all scoped to this one lead. */
function listSharedSources(db, leadId, opts = {}) {
  const sampleLimit = Math.max(0, Math.min(10, Number(opts.sample) != null ? Number(opts.sample) : 3));
  return modules.MODULE_TYPES.map((type) => {
    const { entry } = registryEntry(type);
    const label = (modules.MODULE_META[type] && modules.MODULE_META[type].label) || type;
    if (!entry) return { type, label, kind: 'missing', reason: 'No shared-layer registry entry.' };
    if (entry.kind !== 'provider') return { type, label, kind: 'none', reason: entry.reason };
    const items = readProviderItems(db, leadId, type);
    return { type, label, kind: 'provider', count: items.length, sample: items.slice(0, sampleLimit) };
  });
}

/* ------------------------------------------------------------------ */
/* Shared refs — the generalized consumer link.                        */
/*                                                                     */
/* A ref says "consumer item X draws on provider item Y for role R"    */
/* (e.g. events#12 ← gallery#4 as its 'album'). Any module can hold    */
/* refs; resolution is lazy and dormant-safe: a deleted or             */
/* unpublished provider item resolves to nothing, never an error.      */
/* ------------------------------------------------------------------ */

function ensureTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS module_shared_refs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      consumer_type TEXT NOT NULL,
      consumer_id INTEGER NOT NULL,
      provider_type TEXT NOT NULL,
      provider_id INTEGER NOT NULL,
      role TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(lead_id, consumer_type, consumer_id, provider_type, role)
    );
    CREATE INDEX IF NOT EXISTS idx_module_shared_refs_lead ON module_shared_refs(lead_id);
    CREATE INDEX IF NOT EXISTS idx_module_shared_refs_consumer
      ON module_shared_refs(lead_id, consumer_type, consumer_id);
  `);
}

function cleanRefPart(v, name) {
  const s = String(v == null ? '' : v)
    .trim()
    .toLowerCase();
  if (!s) throw fail('VALIDATION', `${name} is required`);
  return s;
}

function upsertRef(db, lid, { consumerType, consumerId, providerType, providerId, role }) {
  ensureTables(db);
  db.prepare(
    `INSERT INTO module_shared_refs (lead_id, consumer_type, consumer_id, provider_type, provider_id, role)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(lead_id, consumer_type, consumer_id, provider_type, role)
     DO UPDATE SET provider_id = excluded.provider_id, updated_at = datetime('now')`
  ).run(lid, consumerType, consumerId, providerType, providerId, role);
  return getSharedRef(db, lid, {
    consumer_type: consumerType,
    consumer_id: consumerId,
    provider_type: providerType,
    role,
  });
}

function setSharedRef(db, leadId, ref = {}) {
  ensureTables(db);
  const consumerType = cleanRefPart(ref.consumer_type || ref.consumerType, 'consumer_type');
  const providerType = cleanRefPart(ref.provider_type || ref.providerType, 'provider_type');
  if (!modules.MODULE_TYPES.includes(consumerType)) {
    throw fail('VALIDATION', `Unknown consumer module type: ${consumerType}`);
  }
  const { entry } = registryEntry(providerType);
  if (!entry) throw fail('VALIDATION', `Unknown provider module type: ${providerType}`);
  if (entry.kind !== 'provider') {
    throw fail('VALIDATION', `${providerType} does not share items: ${entry.reason}`);
  }
  const consumerId = Number(ref.consumer_id != null ? ref.consumer_id : ref.consumerId);
  const providerId = Number(ref.provider_id != null ? ref.provider_id : ref.providerId);
  if (!Number.isInteger(consumerId) || consumerId <= 0)
    throw fail('VALIDATION', 'consumer_id must be a positive integer');
  if (!Number.isInteger(providerId) || providerId <= 0)
    throw fail('VALIDATION', 'provider_id must be a positive integer');
  const role = String(ref.role == null ? '' : ref.role)
    .trim()
    .toLowerCase()
    .slice(0, 40);
  const lid = Number(leadId);
  // The provider item must exist among what the provider actually
  // shares for THIS lead (published items) — a ref can never point
  // at another lead's content or at a draft.
  const exists = readProviderItems(db, lid, providerType).some((it) => Number(it.source_id) === providerId);
  if (!exists) {
    throw fail('VALIDATION', `No published ${providerType} item #${providerId} exists for this business`);
  }
  return upsertRef(db, lid, { consumerType, consumerId, providerType, providerId, role });
}

function getSharedRef(db, leadId, ref = {}) {
  ensureTables(db);
  const row = db
    .prepare(
      `SELECT * FROM module_shared_refs
       WHERE lead_id = ? AND consumer_type = ? AND consumer_id = ? AND provider_type = ? AND role = ?
       LIMIT 1`
    )
    .get(
      Number(leadId),
      String(ref.consumer_type || ref.consumerType || '')
        .trim()
        .toLowerCase(),
      Number(ref.consumer_id != null ? ref.consumer_id : ref.consumerId),
      String(ref.provider_type || ref.providerType || '')
        .trim()
        .toLowerCase(),
      String(ref.role == null ? '' : ref.role)
        .trim()
        .toLowerCase()
    );
  return row || null;
}

function clearSharedRef(db, leadId, ref = {}) {
  ensureTables(db);
  const existing = getSharedRef(db, leadId, ref);
  if (!existing) return { cleared: false };
  db.prepare('DELETE FROM module_shared_refs WHERE id = ? AND lead_id = ?').run(existing.id, Number(leadId));
  return { cleared: true, id: existing.id };
}

/** Remove every ref a consumer item holds (e.g. when it is deleted). */
function clearRefsForConsumer(db, leadId, consumerType, consumerId) {
  ensureTables(db);
  const info = db
    .prepare('DELETE FROM module_shared_refs WHERE lead_id = ? AND consumer_type = ? AND consumer_id = ?')
    .run(
      Number(leadId),
      String(consumerType || '')
        .trim()
        .toLowerCase(),
      Number(consumerId)
    );
  return { cleared: Number(info.changes) || 0 };
}

function listSharedRefs(db, leadId, filter = {}) {
  ensureTables(db);
  let sql = 'SELECT * FROM module_shared_refs WHERE lead_id = ?';
  const args = /** @type {any[]} */ ([Number(leadId)]);
  if (filter.consumer_type || filter.consumerType) {
    sql += ' AND consumer_type = ?';
    args.push(
      String(filter.consumer_type || filter.consumerType)
        .trim()
        .toLowerCase()
    );
  }
  if (filter.consumer_id != null || filter.consumerId != null) {
    sql += ' AND consumer_id = ?';
    args.push(Number(filter.consumer_id != null ? filter.consumer_id : filter.consumerId));
  }
  if (filter.provider_type || filter.providerType) {
    sql += ' AND provider_type = ?';
    args.push(
      String(filter.provider_type || filter.providerType)
        .trim()
        .toLowerCase()
    );
  }
  sql += ' ORDER BY id ASC';
  return db.prepare(sql).all(...args);
}

/* ------------------------------------------------------------------ */
/* Consumer: an event's gallery album (Ely's motivating example).      */
/* The link lives in module_shared_refs (role 'album'); the events     */
/* table carries it as the virtual field gallery_album_id, which the   */
/* portal editor, the MCP events tools and the design agent all read   */
/* and write through the same paths — no agent-only back door.         */
/* ------------------------------------------------------------------ */

const EVENT_GALLERY_ROLE = 'album';

function assertAlbumExists(db, leadId, albumId) {
  const album = modules.getAlbum(db, Number(leadId), Number(albumId), { withImages: false });
  if (!album) throw fail('VALIDATION', `Gallery album #${albumId} does not exist for this business`);
  return album;
}

/** Called from siteModules create/update when data carries
 *  gallery_album_id (key present = intent; empty = clear). */
function applyEventGallery(db, leadId, eventId, rawValue) {
  const lid = Number(leadId);
  const evId = Number(eventId);
  const albumId = rawValue == null || rawValue === '' ? 0 : Number(rawValue);
  if (Number.isNaN(albumId)) throw fail('VALIDATION', 'gallery_album_id must be a gallery album id');
  if (!albumId) {
    clearSharedRef(db, lid, {
      consumer_type: 'events',
      consumer_id: evId,
      provider_type: 'gallery',
      role: EVENT_GALLERY_ROLE,
    });
    return { gallery_album_id: null };
  }
  if (!Number.isInteger(albumId) || albumId <= 0) {
    throw fail('VALIDATION', 'gallery_album_id must be a gallery album id');
  }
  // The album must belong to this lead (draft albums may be linked
  // ahead of publishing — resolution stays dormant until the album
  // is published, exactly like the rest of the layer).
  assertAlbumExists(db, lid, albumId);
  upsertRef(db, lid, {
    consumerType: 'events',
    consumerId: evId,
    providerType: 'gallery',
    providerId: albumId,
    role: EVENT_GALLERY_ROLE,
  });
  return { gallery_album_id: albumId };
}

function eventGalleryAlbumId(db, leadId, eventId) {
  try {
    const ref = getSharedRef(db, leadId, {
      consumer_type: 'events',
      consumer_id: eventId,
      provider_type: 'gallery',
      role: EVENT_GALLERY_ROLE,
    });
    return ref ? Number(ref.provider_id) : null;
  } catch {
    return null;
  }
}

/** Public resolution for the event detail payload: the linked
 *  album's photos, or null (render nothing) when there is no link,
 *  the album is a draft, or it has no photos. Never throws. */
function resolveEventGallery(db, leadId, event) {
  try {
    if (!event || event.id == null) return null;
    const albumId = eventGalleryAlbumId(db, leadId, event.id);
    if (!albumId) return null;
    const album = modules.getAlbum(db, Number(leadId), albumId, { withImages: true });
    if (!album || album.status !== 'published') return null;
    const images = (Array.isArray(album.images) ? album.images : [])
      .filter((im) => im && im.image_url)
      .map((im) => ({ id: im.id, image_url: im.image_url, caption: im.caption || '' }));
    if (!images.length) return null;
    return { album_id: album.id, album_title: album.title || '', album_slug: album.slug || '', images };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Consumer: newsletter auto-content blocks.                           */
/* Resolved at compose/preview time from the layer and rendered to     */
/* email-safe HTML; the newsletter engine freezes the resolved HTML    */
/* into the preview token, so what is previewed is what is sent.       */
/* An empty source produces NO block and a plain note — never an       */
/* error (composer honesty, Social Feed preview precedent).            */
/* ------------------------------------------------------------------ */

const NEWSLETTER_BLOCK_HEADINGS = {
  socialfeed: 'Latest posts',
  events: 'Upcoming events',
  offers: 'Current offers',
  blog: 'From the blog',
};

function newsletterBlockItems(db, leadId, source, limit) {
  let items = readProviderItems(db, leadId, source).slice(0, limit);
  if (source === 'events') {
    // "Upcoming" means today or later; undated events stay (the
    // events reader already sorts dated-first, undated last).
    const today = new Date().toISOString().slice(0, 10);
    items = items.filter((it) => !it.date || String(it.date).slice(0, 10) >= today);
  }
  return items;
}

function renderNewsletterBlocks(db, leadId, blocks) {
  const report = [];
  const parts = [];
  for (const block of Array.isArray(blocks) ? blocks : []) {
    const source = String((block && block.source) || '')
      .trim()
      .toLowerCase();
    const { entry } = registryEntry(source);
    const label = (modules.MODULE_META[source] && modules.MODULE_META[source].label) || source || 'content';
    if (!entry || entry.kind !== 'provider') {
      report.push({ source, included: false, count: 0, note: `${label} can't be included in a newsletter.` });
      continue;
    }
    const limit = Math.max(1, Math.min(10, Number(block.limit) || 5));
    const items = newsletterBlockItems(db, leadId, source, limit);
    if (!items.length) {
      report.push({
        source,
        included: false,
        count: 0,
        note: `No ${label.toLowerCase()} to include right now — this block was left out.`,
      });
      continue;
    }
    const heading = NEWSLETTER_BLOCK_HEADINGS[source] || label;
    const rows = items
      .map((it) => {
        const img = it.image_url
          ? `<img src="${esc(it.image_url)}" alt="" width="120" style="display:block;max-width:120px;height:auto;border-radius:6px;margin:0 0 6px" />`
          : '';
        const dateLine = it.date
          ? `<br /><span style="color:#777;font-size:13px">${esc(String(it.date).slice(0, 10))}</span>`
          : '';
        const desc = it.description ? `<br /><span style="color:#444">${esc(it.description.slice(0, 220))}</span>` : '';
        const titleHtml = it.link_url
          ? `<a href="${esc(it.link_url)}" style="color:#0f5c5c">${esc(it.title)}</a>`
          : esc(it.title);
        return `<p style="margin:0 0 14px">${img}<strong>${titleHtml}</strong>${dateLine}${desc}</p>`;
      })
      .join('');
    parts.push(
      `<div style="margin:26px 0 6px"><h3 style="margin:0 0 10px;font-size:17px">${esc(heading)}</h3>${rows}</div>`
    );
    report.push({
      source,
      included: true,
      count: items.length,
      note: `Included ${items.length} ${label.toLowerCase()} item${items.length === 1 ? '' : 's'}.`,
    });
  }
  return { html: parts.join(''), report };
}

module.exports = {
  SHARE_REGISTRY,
  ensureTables,
  listSharedSources,
  listSharedItems,
  listSharedItemsByCategory,
  readProviderItems,
  setSharedRef,
  getSharedRef,
  clearSharedRef,
  clearRefsForConsumer,
  listSharedRefs,
  applyEventGallery,
  assertAlbumExists,
  eventGalleryAlbumId,
  resolveEventGallery,
  renderNewsletterBlocks,
  EVENT_GALLERY_ROLE,
};
