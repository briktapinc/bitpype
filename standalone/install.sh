#!/usr/bin/env bash
# BitPype — standalone site backup installer (Batch 155).
#
# Installs ONE BitPype site (the real app in single-site mode, seeded
# with one client's workspace) onto this server. Reads its answers
# from SSB_* environment variables when present, prompts for the
# rest on a terminal, and refuses to guess when neither is available.
#
#   SSB_DOMAIN              the site's domain (A record must point here)
#   SSB_ADMIN_EMAIL         owner email (informational; the seeded
#                           portal account keeps its own login)
#   SSB_STRIPE_PUBLISHABLE  owner's Stripe publishable key (optional)
#   SSB_STRIPE_SECRET       owner's Stripe secret key (optional —
#                           the shop cannot take payments without it)
#   SSB_OPENAI_KEY          owner's OpenAI key (chat/voice)
#   SSB_SMTP_HOST/PORT/SECURE/USER/PASS/FROM_EMAIL/FROM_NAME
#   SSB_TURNSTILE_SITE_KEY / SSB_TURNSTILE_SECRET (optional)
#   SSB_GOOGLE_PLACES_KEY   (optional — Google Reviews)
#   SSB_TWILIO_ACCOUNT_SID / SSB_TWILIO_AUTH_TOKEN / SSB_TWILIO_FROM_NUMBER
#
#   SSB_INSTALL_DIR         default /opt/bitpype-site-<slug>
#   SSB_INSTALL_DOCKER=1    allow installing Docker via the official
#                           script when it is missing (stated, opt-in)
#   SSB_DRY_RUN=1           preflight + checksum + wizard + .env +
#                           seed layout, then stop BEFORE Docker
#   SSB_FORCE=1             continue past soft preflight warnings
#
# Demo portal account (Batch 177): when the package's client had no
# BitPype portal account, the seed carries a demo portal account
# (its email is named in the manifest, seed.demoPortalAccount). Its
# shipped password hash is unusable by design; on FIRST install this
# script generates the account's one-time password on this server
# (standalone/set-demo-password.js, inside the app container) and
# prints it exactly once, in the completion summary at the end.
#
# Re-running the installer from a newer backup upgrades app + site
# and PRESERVES the data directory (orders, bookings, submissions
# taken on this install survive).
set -euo pipefail

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DRY_RUN="${SSB_DRY_RUN:-0}"
FORCE="${SSB_FORCE:-0}"

say() { printf '%s\n' "$*"; }
warn() { printf 'installer: %s\n' "$*" >&2; }
fail() {
  printf 'INSTALLER ERROR: %s\n' "$*" >&2
  exit 1
}

[ -f "$PKG_DIR/manifest.json" ] || fail "manifest.json not found in $PKG_DIR — run this from the unpacked backup folder."

PKG_BASE="$(basename "$PKG_DIR")"
SLUG="${PKG_BASE%-standalone-backup}"
INSTALL_DIR="${SSB_INSTALL_DIR:-/opt/bitpype-site-$SLUG}"
DATA_DIR="$INSTALL_DIR/data"

WS_ID="$(sed -n 's/.*"workspaceId": \([0-9][0-9]*\).*/\1/p' "$PKG_DIR/manifest.json" | head -n 1)"
[ -n "$WS_ID" ] || fail "manifest.json does not name a workspaceId — the package is damaged."

# Batch 177: a demo portal account rides in the seed when the client
# had no portal account of their own (null/absent on older packages).
DEMO_EMAIL="$(sed -n 's/.*"demoPortalAccount": *"\([^"]*\)".*/\1/p' "$PKG_DIR/manifest.json" | head -n 1)"

# ---------------------------------------------------------------- wizard
ask() {
  # ask VAR "Prompt" [secret]
  local var="$1" prompt="$2" secret="${3:-0}" current="${!1:-}"
  if [ -n "$current" ]; then return 0; fi
  if [ -t 0 ]; then
    if [ "$secret" = "1" ]; then
      read -r -s -p "$prompt: " current || true
      printf '\n'
    else
      read -r -p "$prompt: " current || true
    fi
    printf -v "$var" '%s' "$current"
  fi
}

ask SSB_DOMAIN "Domain for this site (e.g. www.example.com)"
[ -n "${SSB_DOMAIN:-}" ] || fail "SSB_DOMAIN is required (set it in the environment or run in a terminal to be prompted)."
ask SSB_ADMIN_EMAIL "Owner email (for the summary; optional)"
ask SSB_STRIPE_PUBLISHABLE "Stripe publishable key (optional — needed to take payments)"
ask SSB_STRIPE_SECRET "Stripe secret key (optional — needed to take payments)" 1
ask SSB_OPENAI_KEY "OpenAI API key (optional — needed for chat/voice)" 1
ask SSB_SMTP_HOST "SMTP host (optional — booking/order emails)"

# -------------------------------------------------------------- preflight
say "== BitPype standalone installer =="
say "Package:   $PKG_DIR"
say "Install:   $INSTALL_DIR"
say "Domain:    $SSB_DOMAIN"
say "Workspace: $WS_ID"

if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  case "${ID:-}" in
    ubuntu | debian) say "OS:        ${PRETTY_NAME:-$ID} (ok)" ;;
    *)
      if [ "$FORCE" = "1" ] || [ "$DRY_RUN" = "1" ]; then
        warn "OS '${ID:-unknown}' is not Ubuntu/Debian — continuing because forced/dry-run."
      else
        fail "This installer targets Ubuntu/Debian (found '${ID:-unknown}'). Set SSB_FORCE=1 to try anyway."
      fi
      ;;
  esac
fi

if [ "$(id -u)" != "0" ]; then
  if ! command -v sudo >/dev/null 2>&1; then
    [ "$DRY_RUN" = "1" ] || fail "Run as root or install sudo — the installer writes $INSTALL_DIR and manages Docker."
    warn "not root and no sudo — dry-run only."
  fi
fi

PKG_BYTES="$(du -sb "$PKG_DIR" | cut -f1)"
AVAIL_BYTES="$(df -B1 --output=avail "$PKG_DIR" | tail -n 1 | tr -d ' ')"
if [ -n "$AVAIL_BYTES" ] && [ "$AVAIL_BYTES" -lt $((PKG_BYTES * 2)) ]; then
  [ "$DRY_RUN" = "1" ] || fail "Not enough free disk: need at least twice the package size ($PKG_BYTES bytes)."
  warn "low disk (dry-run, continuing)."
fi

port_busy() {
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && { exec 3>&- 3<&-; return 0; }
  return 1
}
if [ "$DRY_RUN" != "1" ]; then
  for p in 80 443; do
    if port_busy "$p"; then
      warn "port $p is already in use — Caddy will fail to bind unless it is freed (or this is a re-install whose stack is running)."
    fi
  done
fi

DOCKER_OK=0
if command -v docker >/dev/null 2>&1; then
  DOCKER_OK=1
elif [ "${SSB_INSTALL_DOCKER:-0}" = "1" ]; then
  say "Docker is missing. SSB_INSTALL_DOCKER=1 was set, so I will install it via Docker's official script (get.docker.com) — this is the one system-level change the installer makes."
  if [ "$DRY_RUN" != "1" ]; then
    curl -fsSL https://get.docker.com | sh
    command -v docker >/dev/null 2>&1 && DOCKER_OK=1
  else
    warn "dry-run: Docker install skipped."
  fi
else
  warn "Docker is not installed. Install it (https://docs.docker.com/engine/install/) or re-run with SSB_INSTALL_DOCKER=1 to let this installer do it."
fi

# ---------------------------------------------------- checksum verification
say "Verifying package checksums…"
if command -v node >/dev/null 2>&1; then
  MANIFEST="$PKG_DIR/manifest.json" PKG_DIR="$PKG_DIR" node <<'NODEEOF'
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const manifest = JSON.parse(fs.readFileSync(process.env.MANIFEST, 'utf8'));
const files = manifest.files || {};
let bad = 0;
for (const [rel, want] of Object.entries(files)) {
  const abs = path.join(process.env.PKG_DIR, rel);
  if (!fs.existsSync(abs)) {
    console.error('missing file: ' + rel);
    bad++;
    continue;
  }
  const got = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
  if (got !== want) {
    console.error('checksum mismatch: ' + rel);
    bad++;
  }
}
if (bad) {
  console.error(`checksum verification failed for ${bad} file(s) — refusing to install a damaged package.`);
  process.exit(1);
}
console.log(`checksums ok (${Object.keys(files).length} files)`);
NODEEOF
else
  warn "node not found on the host — checksum verification skipped (the app container verifies nothing at runtime; install node or verify the archive sha256 you received)."
fi

# ------------------------------------------------------------------- .env
mkdir -p "$INSTALL_DIR" "$DATA_DIR/workspaces" "$DATA_DIR/exports"
ENV_FILE="$INSTALL_DIR/.env"

keep_existing() {
  # keep_existing KEY — echo the value already in .env, if any
  if [ -f "$ENV_FILE" ]; then
    sed -n "s/^$1=//p" "$ENV_FILE" | head -n 1
  fi
}

SESSION_SECRET_VAL="$(keep_existing SESSION_SECRET)"
if [ -z "$SESSION_SECRET_VAL" ]; then
  SESSION_SECRET_VAL="$(head -c 48 /dev/urandom | od -An -tx1 | tr -d ' \n')"
fi
SETTINGS_KEY_VAL="$(keep_existing SETTINGS_ENCRYPTION_KEY)"
if [ -z "$SETTINGS_KEY_VAL" ]; then
  SETTINGS_KEY_VAL="$(head -c 32 /dev/urandom | base64 | tr -d '\n')"
fi

# Batch 180 (L17): every SSB_* answer is written into .env UNQUOTED
# below, so a value carrying a newline would inject whole extra .env
# lines (overriding keys written earlier), and a double quote would
# corrupt the value as the env parser reads it. Strip CR/LF and
# double quotes from every SSB_* value before it is written.
for _ssb_var in SSB_DOMAIN SSB_ADMIN_EMAIL SSB_STRIPE_PUBLISHABLE SSB_STRIPE_SECRET \
  SSB_STRIPE_WEBHOOK_SECRET SSB_OPENAI_KEY SSB_SMTP_HOST SSB_SMTP_PORT SSB_SMTP_SECURE \
  SSB_SMTP_USER SSB_SMTP_PASS SSB_SMTP_FROM_EMAIL SSB_SMTP_FROM_NAME \
  SSB_TURNSTILE_SITE_KEY SSB_TURNSTILE_SECRET SSB_GOOGLE_PLACES_KEY \
  SSB_TWILIO_ACCOUNT_SID SSB_TWILIO_AUTH_TOKEN SSB_TWILIO_FROM_NUMBER; do
  _ssb_val="${!_ssb_var:-}"
  _ssb_val="${_ssb_val//$'\r'/}"
  _ssb_val="${_ssb_val//$'\n'/}"
  _ssb_val="${_ssb_val//\"/}"
  printf -v "$_ssb_var" '%s' "$_ssb_val"
done
unset _ssb_var _ssb_val

{
  printf 'BITPYPE_SINGLE_SITE=1\n'
  printf 'NODE_ENV=production\n'
  printf 'APP_URL=https://%s\n' "$SSB_DOMAIN"
  printf 'SSB_DOMAIN=%s\n' "$SSB_DOMAIN"
  printf 'SESSION_SECRET=%s\n' "$SESSION_SECRET_VAL"
  printf 'SETTINGS_ENCRYPTION_KEY=%s\n' "$SETTINGS_KEY_VAL"
  printf 'SSB_ADMIN_EMAIL=%s\n' "${SSB_ADMIN_EMAIL:-}"
  printf 'SSB_STRIPE_PUBLISHABLE=%s\n' "${SSB_STRIPE_PUBLISHABLE:-}"
  printf 'SSB_STRIPE_SECRET=%s\n' "${SSB_STRIPE_SECRET:-}"
  printf 'SSB_STRIPE_WEBHOOK_SECRET=%s\n' "${SSB_STRIPE_WEBHOOK_SECRET:-}"
  printf 'SSB_OPENAI_KEY=%s\n' "${SSB_OPENAI_KEY:-}"
  printf 'SSB_SMTP_HOST=%s\n' "${SSB_SMTP_HOST:-}"
  printf 'SSB_SMTP_PORT=%s\n' "${SSB_SMTP_PORT:-587}"
  printf 'SSB_SMTP_SECURE=%s\n' "${SSB_SMTP_SECURE:-0}"
  printf 'SSB_SMTP_USER=%s\n' "${SSB_SMTP_USER:-}"
  printf 'SSB_SMTP_PASS=%s\n' "${SSB_SMTP_PASS:-}"
  printf 'SSB_SMTP_FROM_EMAIL=%s\n' "${SSB_SMTP_FROM_EMAIL:-}"
  printf 'SSB_SMTP_FROM_NAME=%s\n' "${SSB_SMTP_FROM_NAME:-}"
  printf 'SSB_TURNSTILE_SITE_KEY=%s\n' "${SSB_TURNSTILE_SITE_KEY:-}"
  printf 'SSB_TURNSTILE_SECRET=%s\n' "${SSB_TURNSTILE_SECRET:-}"
  printf 'SSB_GOOGLE_PLACES_KEY=%s\n' "${SSB_GOOGLE_PLACES_KEY:-}"
  printf 'SSB_TWILIO_ACCOUNT_SID=%s\n' "${SSB_TWILIO_ACCOUNT_SID:-}"
  printf 'SSB_TWILIO_AUTH_TOKEN=%s\n' "${SSB_TWILIO_AUTH_TOKEN:-}"
  printf 'SSB_TWILIO_FROM_NUMBER=%s\n' "${SSB_TWILIO_FROM_NUMBER:-}"
} >"$ENV_FILE"
chmod 600 "$ENV_FILE"
say "Wrote $ENV_FILE (mode 600; secrets are never printed)."

# ------------------------------------------------------------ seed import
# First install: lay the seed databases + export storage into the
# data dir. Upgrade: the data dir is the site's live business data —
# it is never overwritten; only app/ + site/ are replaced.
FRESH_PLATFORM=0
if [ ! -f "$DATA_DIR/platform.sqlite" ]; then
  cp "$PKG_DIR/seed/platform.sqlite" "$DATA_DIR/platform.sqlite"
  FRESH_PLATFORM=1
  say "Seeded platform database."
else
  say "Existing platform database kept (upgrade — seed not re-applied)."
fi
if [ "$FRESH_PLATFORM" = "1" ] && [ -n "$DEMO_EMAIL" ]; then
  # The marker lives in the data dir: it survives until the demo
  # password has actually been set (end of this install), so a
  # failed attempt is retried by simply re-running the installer,
  # and an upgrade never resets a password the owner already has.
  touch "$DATA_DIR/.demo-password-pending"
  say "This package's client has no portal account of their own, so the seed carries a demo portal account ($DEMO_EMAIL). Its one-time password is generated on this server and shown once, in the summary at the end of this install."
fi
if [ ! -f "$DATA_DIR/workspaces/$WS_ID/websitescout.db" ]; then
  mkdir -p "$DATA_DIR/workspaces/$WS_ID"
  cp "$PKG_DIR/seed/tenant.sqlite" "$DATA_DIR/workspaces/$WS_ID/websitescout.db"
  say "Seeded workspace database."
else
  say "Existing workspace database kept (upgrade — orders/bookings/submissions preserved)."
fi
if [ -d "$PKG_DIR/seed/exports" ]; then
  cp -r "$PKG_DIR/seed/exports/." "$DATA_DIR/exports/" 2>/dev/null || true
fi

rm -rf "$INSTALL_DIR/app" "$INSTALL_DIR/site"
cp -r "$PKG_DIR/app" "$INSTALL_DIR/app"
cp -r "$PKG_DIR/site" "$INSTALL_DIR/site"
cp "$PKG_DIR/docker-compose.yml" "$INSTALL_DIR/docker-compose.yml"
cp "$PKG_DIR/Caddyfile" "$INSTALL_DIR/Caddyfile"
cp "$PKG_DIR/uninstall.sh" "$INSTALL_DIR/uninstall.sh" 2>/dev/null || true
chmod +x "$INSTALL_DIR/uninstall.sh" 2>/dev/null || true
if [ "$(id -u)" = "0" ]; then
  chown -R 1000:1000 "$DATA_DIR" || true
fi

# ------------------------------------------------------------- dry-run end
if [ "$DRY_RUN" = "1" ]; then
  say ""
  say "DRY RUN complete — preflight, checksums, wizard answers, .env and the seed layout are in place at $INSTALL_DIR."
  say "Stopped BEFORE Docker: no containers were started and nothing is serving yet."
  if [ -n "$DEMO_EMAIL" ]; then
    say "Demo portal account: $DEMO_EMAIL — its one-time password is generated and shown at the end of the real (non-dry-run) install."
  fi
  exit 0
fi

[ "$DOCKER_OK" = "1" ] || fail "Docker is unavailable — install it or re-run with SSB_INSTALL_DOCKER=1, then run this installer again."

# ------------------------------------------------------------------- start
say "Starting the stack (first run builds the app image — this can take a few minutes)…"
(cd "$INSTALL_DIR" && docker compose up -d --build)

# ------------------------------------------------- Stripe webhook (best effort)
if [ -n "${SSB_STRIPE_SECRET:-}" ] && command -v curl >/dev/null 2>&1; then
  say "Registering the Stripe webhook endpoint…"
  # Batch 168 (external review F14): subscribe to the FULL set the
  # unified payments handler consumes — shop checkout/PI events AND
  # the membership subscription/invoice lifecycle. The bare URL is
  # correct for a clone: the app resolves its sole workspace for
  # the bare path in single-site mode.
  WEBHOOK_JSON="$(curl -s -u "${SSB_STRIPE_SECRET}:" \
    -d "url=https://${SSB_DOMAIN}/api/v1/payments/webhook" \
    -d "enabled_events[]=checkout.session.completed" \
    -d "enabled_events[]=checkout.session.expired" \
    -d "enabled_events[]=checkout.session.async_payment_succeeded" \
    -d "enabled_events[]=checkout.session.async_payment_failed" \
    -d "enabled_events[]=payment_intent.succeeded" \
    -d "enabled_events[]=payment_intent.payment_failed" \
    -d "enabled_events[]=charge.refunded" \
    -d "enabled_events[]=customer.subscription.created" \
    -d "enabled_events[]=customer.subscription.updated" \
    -d "enabled_events[]=customer.subscription.deleted" \
    -d "enabled_events[]=invoice.paid" \
    -d "enabled_events[]=invoice.payment_failed" \
    https://api.stripe.com/v1/webhook_endpoints || true)"
  WHSEC="$(printf '%s' "$WEBHOOK_JSON" | sed -n 's/.*"secret": *"\([^"]*\)".*/\1/p' | head -n 1)"
  if [ -n "$WHSEC" ]; then
    printf 'SSB_STRIPE_WEBHOOK_SECRET=%s\n' "$WHSEC" >>"$ENV_FILE"
    say "Stripe webhook registered; its signing secret was appended to .env — restarting the app so it takes effect."
    (cd "$INSTALL_DIR" && docker compose up -d app)
  else
    warn "Stripe did not return a webhook secret. Register it manually: Stripe Dashboard → Developers → Webhooks → Add endpoint https://${SSB_DOMAIN}/api/v1/payments/webhook (events: checkout.session.completed, checkout.session.expired, checkout.session.async_payment_succeeded, checkout.session.async_payment_failed, payment_intent.succeeded, payment_intent.payment_failed, charge.refunded, customer.subscription.created, customer.subscription.updated, customer.subscription.deleted, invoice.paid, invoice.payment_failed), then put the signing secret in $ENV_FILE as SSB_STRIPE_WEBHOOK_SECRET and re-run this installer."
  fi
fi

# ---------------------------------------------------------------- self-test
say "Self-test…"
HEALTH_OK=0
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:3000/health" >/dev/null 2>&1; then
    HEALTH_OK=1
    break
  fi
  sleep 2
done
[ "$HEALTH_OK" = "1" ] || warn "the app did not answer /health on 127.0.0.1:3000 yet — check 'docker compose logs app' in $INSTALL_DIR."
if curl -fsS "https://${SSB_DOMAIN}/" >/dev/null 2>&1; then
  say "https://${SSB_DOMAIN}/ answers."
else
  warn "https://${SSB_DOMAIN}/ does not answer yet — confirm the domain's A record points at this server; Caddy issues the certificate once DNS resolves here."
fi
if [ -n "${SSB_STRIPE_SECRET:-}" ]; then
  if curl -fsS -u "${SSB_STRIPE_SECRET}:" https://api.stripe.com/v1/balance >/dev/null 2>&1; then
    say "Stripe key validated."
  else
    warn "Stripe rejected the supplied secret key — payments stay unconfigured until a valid key is in .env (then re-run the installer)."
  fi
fi
if [ -n "${SSB_OPENAI_KEY:-}" ]; then
  if curl -fsS -H "Authorization: Bearer ${SSB_OPENAI_KEY}" https://api.openai.com/v1/models >/dev/null 2>&1; then
    say "OpenAI key validated."
  else
    warn "OpenAI rejected the supplied key — chat/voice stay unconfigured until a valid key is in .env."
  fi
fi

# ------------------------------------------- demo portal password (Batch 177)
# Runs only while the first-install marker exists. The password is
# generated inside the app container, captured into this shell
# variable, and printed exactly once — in the summary below. It is
# never written to .env, a log, or any file by this installer.
DEMO_PASSWORD=""
if [ -n "$DEMO_EMAIL" ] && [ -f "$DATA_DIR/.demo-password-pending" ]; then
  say "Generating the demo portal account's one-time password…"
  DEMO_PASSWORD="$((cd "$INSTALL_DIR" && docker compose exec -T app node /app/standalone/set-demo-password.js "$DEMO_EMAIL" 2>/dev/null) | tr -d '\r\n')"
  if [ -n "$DEMO_PASSWORD" ]; then
    rm -f "$DATA_DIR/.demo-password-pending"
  else
    warn "the demo portal password could not be set. Re-run this installer to try again, or set it manually and note the password it prints:  (cd $INSTALL_DIR && docker compose exec app node /app/standalone/set-demo-password.js $DEMO_EMAIL)"
  fi
fi

# ------------------------------------------------------------------ summary
say ""
say "============================================================"
say "Your site is installed."
say "  Website:  https://${SSB_DOMAIN}/"
if [ -n "$DEMO_PASSWORD" ]; then
  say "  Portal:   https://${SSB_DOMAIN}/portal"
  say "            This client had no portal account, so a demo account was created:"
  say "              Email:    $DEMO_EMAIL"
  say "              Password: $DEMO_PASSWORD  (one-time — shown only here)"
  say "            Log in with it and CHANGE the password right away."
elif [ -n "$DEMO_EMAIL" ]; then
  say "  Portal:   https://${SSB_DOMAIN}/portal   (demo account: $DEMO_EMAIL — log in with the one-time password shown when this site was first installed)"
else
  say "  Portal:   https://${SSB_DOMAIN}/portal   (log in with the portal account from your BitPype site)"
fi
say "  Data:     $DATA_DIR"
say "  Back up your data with:  tar -czf site-data-backup.tgz -C $INSTALL_DIR data"
say "  Uninstall: $INSTALL_DIR/uninstall.sh   (keeps $DATA_DIR unless --purge)"
say "============================================================"
