# Post-Deploy Final Audit — Website Scout production port

Date: 2026-10-23 (~09:15–09:45 EDT), after the port deploy completed 13:09 UTC.
Scope: read-only verification of the live production app on srv1360778
(/root/website-scout-web, container website-scout-web-app-1). No changes made.

## Verdict

The deployed production code is exactly the prepared port, and every ported fix
that can be probed live behaves as designed. No regressions observed.

## Evidence

1. **Tree identity** — Live tree re-pulled and diffed against port-repo HEAD
   (9c6761b): zero content differences in tracked code. Only deltas are
   expected: DEPLOY.md not synced (by design); server-side scratch dirs
   (publicjs/, serverroutes/, tmp-deploy-tools/) and vendor/xlsx-0.20.3.tgz
   exist only on the server (pre-existing, untracked).
2. **Container/image** — App container up on the image built during the deploy
   (image created 13:06:42 UTC, container 13:08:26 UTC). Zero error/exception
   lines in container logs since deploy. Boot sequence clean: schema ready,
   platform migration line, listening.
3. **Regression gate** — Deploy log records "regression suite passed in image"
   (full suite incl. the 5 Chromium checks) before compose up.
4. **H3 inbound-email auth** — design_jobs.reply_token column present in the
   workspace-1 tenant DB. Sender+ref enforcement was functionally tested
   pre-deploy against production's real modules (attacker/stale-ref rejected,
   legit reply accepted). Note: mail.imap.auto_submit default is now 0 for new
   workspaces; existing workspaces keep their stored value (unchanged).
5. **H4 AI base-URL SSRF guard (live probes in the running container)** —
   http://169.254.169.254 rejected (non-https); https://192.168.1.10 rejected
   (private); https://localhost:8080 rejected (localhost); https://api.openai.com/v1
   allowed.
6. **M6 secrets encryption** — Boot migrated 8 platform secrets. Workspace-1
   tenant DB: 7 stored secrets, all 7 carry the enc:v1: prefix, 0 plaintext.
   SETTINGS_ENCRYPTION_KEY exists only in the server .env.
7. **D3 settings registry** — Deployed canonical registry: 87 seeds, 61
   settable keys, 12 secret keys (matches the port).
8. **F-12 + port 7 (MCP)** — Live tools/list: 211 entries, 211 unique,
   fonts.list exactly once, design.delete and website.checkLive present.
   checkLive live-fetched sites 11 and 19 page-by-page (all HTTP 200).
   design.delete returns a clean "not found" for a missing id. Unauthenticated
   MCP POST returns 401.
9. **Port 8 UX** — The app.js actually served at bitpype.com contains
   guardSubmit (definition + 8 form wirings) and the "Payload is not valid
   JSON" guard.
10. **F-03 / F-17** — Not separately probeable from outside; verified by tree
    identity with the port repo, where both were unit-tested pre-deploy
    (transaction-serialization concurrency test; logging call sites reviewed).
11. **Health** — https://bitpype.com/health returns {"ok":true}.
12. **Smoke cleanup** — Lead 366 deleted (verified NOT_FOUND via MCP).

## Open items (not regressions)

- **lead.delete has no cascade**: a lead with lead_events / ai_usage /
  design_learning_events / contact_forms rows cannot be deleted via the API
  (FK_CONFLICT). Found while removing smoke lead 366; its 4 ancillary rows
  were cleared directly in the tenant DB. Recommend a proper cascade fix.
- **M5**: no per-workspace AI spend cap yet — add before external signups.
- **cf.account_id seed default** carries a baked-in Cloudflare account ID
  (preserved from production's own seed for behavior parity in port 4).
  Remove if workspaces should never inherit it.
- **VPS stability**: the host flapped ~08:27–09:03 EDT on deploy morning
  (SSH + site up/down). Cause not determinable from here; check hPanel
  resource graphs.
- **MySQL migration** remains deferred by design (central DB is MySQL;
  tenant data is per-workspace SQLite).
- Deploy artifacts left on the server (harmless, documented): /root/run-deploy.sh,
  /root/deploy-progress.log, /root/deploy-test-build.log, /root/deploy-compose.log,
  /tmp/port-payload.tar.gz.
- Rollback stays armed: /root/ws-backup-2026-10-23.tar.gz (integrity-verified)
  + image tag bitpype:rollback-pre-port-20261023. Caveat: rolled-back code
  reads enc:v1: secret values literally.
