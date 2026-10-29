'use strict';
/**
 * navGroups.js — staff sidebar structure (Batch 50).
 *
 * The sidebar in public/index.html is static HTML (anchors carry the
 * icons + labels); THIS module is the single source of truth for how
 * those anchors group into collapsible submenus. app.js uses it to
 * drive expand/collapse state; tests/batch50-menu-regressions.cjs
 * asserts the config and the HTML never drift apart (every sidebar
 * route appears exactly once across NAV_TOP_LEVEL + NAV_GROUPS).
 *
 * Daily drivers stay top-level (NAV_TOP_LEVEL). Everything else lives
 * in a collapsible group (NAV_GROUPS, in display order; item order
 * inside a group preserves the pre-Batch-50 flat order).
 *
 * Expansion semantics (navResolveExpanded): a stored per-group choice
 * is respected, EXCEPT the group containing the current route always
 * expands on navigation — the active item is never hidden.
 */
const NAV_TOP_LEVEL = ['dashboard', 'leads', 'websites'];

const NAV_GROUPS = [
  { id: 'work', label: 'Work', items: ['archives', 'design', 'outreach', 'pipeline'] },
  { id: 'domains-calls', label: 'Domains & Calls', items: ['domains', 'calls'] },
  {
    id: 'site-tools',
    label: 'Site tools',
    items: [
      'forms',
      'leadscout',
      'bookings',
      'shop',
      'memberships',
      'seo',
      'rentals',
      'modules',
      'courses',
      'social',
      'analytics',
    ],
  },
  {
    id: 'money',
    label: 'Money',
    items: [
      'billing',
      'finance',
    ],
  },
  { id: 'system', label: 'System', items: ['jobs', 'mcp', 'settings', 'admin'] },
];

/** Group id containing `route`, or null for top-level/unknown routes. */
function navGroupForRoute(route) {
  if (!route) return null;
  for (const g of NAV_GROUPS) {
    if (g.items.includes(route)) return g.id;
  }
  return null;
}

/**
 * Resolve the expansion map for a navigation: start from the stored
 * per-group choices, then force the current route's group open.
 * Pure — returns a new object, never mutates `stored`.
 */
function navResolveExpanded(route, stored) {
  const out = { ...(stored || {}) };
  const g = navGroupForRoute(route);
  if (g) out[g] = true;
  return out;
}

const NavGroups = { NAV_TOP_LEVEL, NAV_GROUPS, navGroupForRoute, navResolveExpanded };
if (typeof window !== 'undefined') window.NavGroups = NavGroups;
if (typeof module !== 'undefined' && module.exports) module.exports = NavGroups;
