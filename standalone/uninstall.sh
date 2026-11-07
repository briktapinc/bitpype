#!/usr/bin/env bash
# BitPype — standalone site uninstaller (Batch 155).
#
# Stops the stack and removes the app, the baked site and the stack
# files from the install dir. The DATA directory (the site's live
# databases + export storage) is KEPT unless --purge is passed;
# --purge removes it only after the install slug is typed back as
# confirmation (or supplied as SSB_PURGE_CONFIRM=<slug> for scripts).
set -euo pipefail

say() { printf '%s\n' "$*"; }
fail() {
  printf 'UNINSTALLER ERROR: %s\n' "$*" >&2
  exit 1
}

PURGE=0
for arg in "$@"; do
  case "$arg" in
    --purge) PURGE=1 ;;
    *) fail "unknown argument: $arg (only --purge is supported)" ;;
  esac
done

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SELF_DIR/docker-compose.yml" ] && [ -f "$SELF_DIR/.env" ]; then
  INSTALL_DIR="$SELF_DIR"
else
  PKG_BASE="$(basename "$SELF_DIR")"
  SLUG="${PKG_BASE%-standalone-backup}"
  INSTALL_DIR="${SSB_INSTALL_DIR:-/opt/bitpype-site-$SLUG}"
fi
DATA_DIR="$INSTALL_DIR/data"
SLUG="$(basename "$INSTALL_DIR" | sed 's/^bitpype-site-//')"

[ -d "$INSTALL_DIR" ] || fail "install dir $INSTALL_DIR does not exist — nothing to uninstall."

if [ -f "$INSTALL_DIR/docker-compose.yml" ] && command -v docker >/dev/null 2>&1; then
  say "Stopping the stack…"
  (cd "$INSTALL_DIR" && docker compose down) || say "docker compose down reported issues — continuing with file removal."
fi

rm -rf "$INSTALL_DIR/app" "$INSTALL_DIR/site"
rm -f "$INSTALL_DIR/docker-compose.yml" "$INSTALL_DIR/Caddyfile" "$INSTALL_DIR/.env" "$INSTALL_DIR/uninstall.sh"

if [ "$PURGE" = "1" ]; then
  CONFIRM="${SSB_PURGE_CONFIRM:-}"
  if [ -z "$CONFIRM" ] && [ -t 0 ]; then
    read -r -p "Type the install slug '$SLUG' to permanently delete ALL site data in $DATA_DIR: " CONFIRM || true
  fi
  [ "$CONFIRM" = "$SLUG" ] || fail "purge not confirmed (expected '$SLUG') — data kept."
  rm -rf "$DATA_DIR"
  rmdir "$INSTALL_DIR" 2>/dev/null || true
  say "Purged: stack, files and ALL data in $DATA_DIR are gone."
else
  say "Uninstalled. Your data is kept at $DATA_DIR — delete that folder manually if you want it gone."
fi
