# Legacy Electron desktop app — ARCHIVED (Batch 55, 2026-10-29)

This directory holds the **legacy Electron desktop application** that used to
share this repository with the production web app, plus the root-level
duplicate engines and stale snapshots that drifted alongside it. It was moved
here — not deleted — by Batch 55, following the 2026-10-29 expert review
(finding C-1: "Two applications in one repo, with divergent duplicate
engines").

## Why

The production web app (`server.js` + `server/` + `src/` + `public/`) is what
Docker builds and what bitpype.com runs. The files that were at the repo root
were a second, older application: an Electron shell (`main.js`, `preload.js`,
`renderer/`), its IPC handlers (`src/ipc/`), its database layer (`src/db.js`),
and **second copies of engines that also live in `server/` / `src/`** —
`domain.js`, `siteModules.js`, `clientPortal.js`, `websiteEngine.js`,
`designJobs.js`, `clientMcp.js`, `mcp.js`, `mcpCatalog.js`, … Every duplicate
pair had diverged, so a patch, grep, or security review could land on — or
read from — the wrong copy. `server.js.tmp/` was a stale snapshot directory
tracked in git.

## How the set was chosen (proof, not vibes)

A file was archived only if it met BOTH tests:

1. **Not reachable** from the production entrypoint's require graph
   (a recursive walk of relative `require()`s from `server.js` — 141 files,
   zero unresolved), and
2. **Not referenced** by the Docker build (the Dockerfile COPY list is
   explicit: `server.js`, `server/`, `src/`, `sql/`, `public/`, `scripts/`,
   `vendor/`, package files), the regression tests, or repo tooling —
   including string/spawn-by-path references, which a require walk cannot
   see.

A regression test (`tests/batch55-hygiene-regressions.cjs`) re-walks the
require graph on every run and fails if any production file resolves into
this archive, or if a root-level duplicate of a `server/`/`src/` module name
reappears outside it.

## Deliberately NOT archived

- `src/mcp.js`, `src/mcpCatalog.js`, `src/mcpParityTools.js` — the stdio MCP
  family is still referenced by repo tooling (`scripts/smoke-design-learning.js`
  reads `src/mcp.js`; scripts require the catalog/parity modules).
- `src/mcpHttp.js` — spawned by path from `src/mcpRemote.js` (live).
- `deploy/` — the live release/verification tooling.
- `tmp-upload/` — scratch files; not part of either app, left for the owner
  to judge.
- Root docs (`README.md`, `DEPLOY.md`, `CONTRACT.md`, `PATCHES.md`,
  `POST-DEPLOY-AUDIT.md`) — documentation, left in place.

## Resurrecting the desktop app

Everything kept its relative structure, so restoring is mechanical:

```sh
# from the repo root — move a file (or the whole tree) back
git mv archive/legacy-electron/main.js ./main.js
git mv archive/legacy-electron/renderer ./renderer
git mv archive/legacy-electron/src/ipc ./src/ipc
# (repeat for the engines you need), or dig any single file out of history:
git log --follow -- archive/legacy-electron/domain.js
```

Note the archived desktop code was already drifting before it was archived
(e.g. the root `clientPortal.js` requires a `./db` that only exists as
`src/db.js` — also archived here). Treat resurrection as a port, not a
switch-flip.
