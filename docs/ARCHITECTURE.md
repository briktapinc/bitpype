# BitPype architecture note (Batches 111–112)

A map for the next builder. Everything here is enforced by the
regression gate or pinned by a suite; if you change a shape named
here, expect a named suite to fail and tell you why.

## Module map

**Platform layer vs workspace layer.** Two data stores, never mix
their handles:

- Platform layer — `server/db.js` is the only facade. Production
  driver is MySQL (`DB_DRIVER=mysql`, compose MySQL 8.0); SQLite is
  the dev/test dialect. All platform SQL goes through
  `query()/migrate()`; SQL is written MySQL-shaped and translated
  for SQLite by the facade. Platform tables are defined in
  `sql/schema.sql` (MySQL) and `sql/schema.sqlite.sql` (SQLite) —
  the two MUST stay schema-identical (same tables, same columns);
  the gate's parity suite diffs them by running real migrations.
- Workspace layer — one SQLite file per workspace, opened via
  `server/domain.js` `withDb(workspaceId, fn)` (better-sqlite3,
  synchronous). Workspace schema self-provisions from
  `src/schema.sql` plus per-module `ensureTables` helpers. Tables
  that exist only here (e.g. `site_screenshots`,
  `campaign_messages` send columns) must never leak into the
  platform schemas — that leak is what the Batch 112 parity fix
  removed.

**Portal (Batch 111 split).** `server/clientPortal.js` is a thin
facade (its export surface is pinned: 138 names) over nine modules:
`portalAccounts`, `portalShared`, `portalSiteEdits`, `portalSocial`,
`portalForms`, `portalModules`, `portalBilling`, `portalLeadScout`,
`portalSiteChat`. Never add logic to the facade; add it to the
owning module and re-export.

**Design-chat agent (Batch 111 split).** `server/museAgent.js`
keeps the two tool loops and re-exports (pinned: 17 names)
`museAgentTools` (tool catalogs), `museAgentCore` (config, budget,
chat plumbing), `museAgentClassifier` and `museAgentPlanner`
(the Batch 98 four-role prompts' builders). The chat turn itself
lives in `portalSiteChat.js` (planner → implementor → critic →
reviewer), with plan/thread/pending/summary stores in
`siteChatPlan`, `siteChatThread`, `siteChatPending`,
`siteChatSummary`, attachments in `siteChatAttachments`.

**Design tokens.** `public/css/tokens.css` is the single source
for the 29 shared tokens. `--radius` and `--cream` deliberately
differ per shell and stay local — do not unify them.

**Icons.** `public/js/moduleIcons.js` is the single source of the
22-glyph module icon map.

## How the gate works

`tests/run-regressions.cjs` is the gate. It runs the full suite
allowlist (100+ suites) TWICE:

1. **SQLite pass** — suites pin `DB_DRIVER=sqlite` with a fresh
   temp platform file each.
2. **MySQL pass** (`--mysql`) — a real MySQL 8.0 server; the
   runner creates a fresh `gate_NNN_<suite>` database per suite.
   Suites honor `REGRESSION_DB_DRIVER`; the one skip-listed suite
   (oauth-token) carries its reason in the runner. Platform-DB
   writes/probes in suites must go through the facade or
   `tests/lib/platformTestDb.cjs` — never a raw better-sqlite3
   handle on the platform file, never SQLite-only SQL through the
   facade. `platform-schema-parity-regressions` runs real
   `migrate()` under both dialects and diffs the results
   (`GATE_REQUIRE_PARITY=1` makes a missing MySQL a hard failure).
   Suites end by event-loop drain; the MySQL pass preloads
   `tests/lib/gatePoolRelease.cjs`, which releases the platform
   pool after sustained quiescence (harness-only; app code never
   calls `db.close()` except through that preload).

**Type step** (`tests/run-typecheck.cjs`, gate-wired): vendored
TypeScript over `tsconfig.checkjs.json`. `checkJs` is off
globally; the 16 Batch 111/facade files carry `// @ts-check` and
must stay at zero errors. Annotations only — no logic changes in
the name of the checker. One checker finding was a real bug
(Batch 99's `effectiveText`); it was fixed in `turnSpecText`, with
the regression at batch98 Part 5 (v).

**Format step** (`tests/run-formatcheck.cjs`, gate-wired):
prettier 3.3.3 with the repo `.prettierrc.json`, enforced ONLY on
the scope list inside that file (files a push creates or fully
rewrites). The rest of the tree is intentionally not reformatted.

**De-flake rules** (learned the hard way, Batch 111 deploy):
assertions about server state must await the action's response,
not the request; fixed sleeps are banned where a condition wait on
the real signal exists (rendered children, response, stable
measurement, `document.fonts.ready`); `waitForFunction` on hash /
layout signals uses `polling: 100` because rAF starves under CPU
contention; swallowed waits (`.catch(() => {})`) before an action
are banned — use the state-check-then-act pattern (Batch 107's
toggle-retry: a retry is allowed only when it is effect-verified).
No blanket retry-until-green, no global timeout inflation.

## Rules for future builders

- **Facade pattern.** Public surfaces are pinned by census
  suites (clientPortal 138, museAgent 17). Add capabilities in the
  owning module; re-export through the facade; expect the census
  to require updating in the same change.
- **Prompt byte-stability.** The design-chat prompts/doctrine
  strings are pinned byte-for-byte by suites (batch111 spot pins,
  batch98/99 prompt checks). Moving prompt code is fine; changing
  a byte of prompt text is a product change, not a refactor.
- **SEC-13 census discipline.** Inline-handler/XSS sink counts
  are pinned by census suites (batch102). Adding a sink means
  updating the census deliberately, never quietly.
- **Dialect discipline.** Any new platform table/column lands in
  BOTH schema files and passes the parity suite; any suite that
  touches the platform DB works on both dialects or is
  skip-listed in the runner with a written reason.
- **One backup.** Deploys keep exactly one release backup tar on
  the server (newest) plus the newest rollback image tag; the
  backup contains the live `.env` and full tenant data — handle
  as secrets-bearing.
