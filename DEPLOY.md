> **⚠ SUPERSEDED (Batch 143, 2026-11-05) — DO NOT FOLLOW THIS CHECKLIST.**
> This document describes the one-off October 2026 audit port, including a
> code-only tar backup step that predates tenant-data backups. Production
> deploys run through the per-batch finisher scripts
> (`~/workspace/website-scout/deploy-batchNNN-finish.sh`) with the
> data-inclusive release backup (`make-release-backup.sh`) taken FIRST.
> Kept for history only.

# Deploy checklist — audit port (prepared 2026-10-23, NOT yet deployed)

Repo state: `baseline` commit = production source exactly as pulled from
the VPS. Each `port N` commit is one audit fix adapted to production's
evolved code. 35 files changed, ~870 insertions / ~470 deletions total.

## Before deploying

1. **Back up the server tree** (the port was built against a read-only
   pull; the live tree may have moved since):
   `tar czf /root/ws-backup-$(date +%F).tar.gz -C /root website-scout-web`
   Also re-pull and diff against this repo's baseline commit — if the
   live tree changed, the patches must be re-checked against the delta.
2. **Tag the current image for rollback:**
   `docker tag bitpype:mobile-r50-20261022 bitpype:rollback-pre-port`
3. **Set the encryption key** (port 6 is inert without it — safe but
   plaintext). Generate once and store it in Ely's password manager;
   losing it means stored secrets must be re-entered:
   `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
   Add `SETTINGS_ENCRYPTION_KEY=<value>` to the app service environment
   in docker-compose.yml (or the .env it reads).

## Deploy

4. Sync the changed files (list: `git diff --name-only <baseline>..HEAD`
   in this repo) to `/root/website-scout-web`, preserving the tree layout.
   Do not sync `DEPLOY.md` / `.git` / test scratch files.
5. Rebuild + run prod's own test stage first:
   `docker build --target test -t bitpype:port-test .` (runs
   tests/run-regressions.cjs inside the image, where Chromium exists —
   the browser checks can run there, unlike on the Muse VM).
6. `docker compose up -d --build app` and watch the boot log for
   `[platform] encrypted N plaintext secret(s) at rest` (port 6 working)
   and a clean `[db] schema ready`.

## Post-deploy smoke (5 minutes)

7. MCP tools/list: **211 entries, 211 unique** (was 210/209);
   `fonts.list` appears once; `design.delete` and `website.checkLive`
   present.
8. Delete the smoke-test residue: `design.delete` id 17, then lead 366.
9. Send a test design-question email and reply to it: the subject must
   carry `ref:<token>`; a reply from a different From address must NOT
   record an answer (port 1).
10. Settings → set a secret (e.g. re-save the AI key): the DB value
    should start with `enc:v1:` and the app keeps working (port 6).
11. Open the portal: leads list, websites list, job creation with a
    deliberately broken payload JSON (should show the new error, port 8).

## Rollback

`docker tag bitpype:rollback-pre-port bitpype:mobile-r50-20261022` +
restore the backed-up tree + `docker compose up -d`. Note: if port 6
encrypted secrets in the DB and you roll back the CODE, the old code
will read `enc:v1:` values as literal secrets and integrations using
them will fail until keys are re-entered (or the new code is restored).
Decide the rollback window accordingly.

## Behavior changes Ely should know about

- `mail.imap.auto_submit` now defaults OFF for new workspaces (existing
  workspaces keep their stored value). Inbound client email must come
  from the job's contact address and carry the `ref:` token — replies
  from other addresses are ignored (logged as sender_mismatch).
- `ai.base_url` must be https and public (localhost only with
  ALLOW_LOCAL_AI=1). Affects ai.js + image generation.
- Super-admin promote/demote in the portal now asks for confirmation.
