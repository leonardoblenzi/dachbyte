#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
HUB_ENV="$INFRA_DIR/env/hub.env"
STATE_DIR="$INFRA_DIR/.cutover"
ACTION="${1:-new}"
NEW_URL="${HUB_CUTOVER_PUBLIC_BASE_URL:-https://hub.dachbyte.tech}"
BACKUP="$STATE_DIR/hub.env.before-cutover"

mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR" || true
[[ -f "$HUB_ENV" ]] || { echo "[dach-hub:consumers] missing $HUB_ENV" >&2; exit 2; }

consumer_services=(
  gateway
  seller-ml-web seller-ml-worker
  seller-magalu-web seller-magalu-worker
  seller-shopee seller-madeira seller-tracking seller-log seller-leader
  ads-api ads-worker
  business-portal business-core business-stock business-chat business-price business-chat-api
)

compose() {
  docker compose --env-file "$INFRA_DIR/env/compose.env" -f "$INFRA_DIR/compose.vps.yml" "$@"
}

replace_base_url() {
  local value="$1"
  python3 - "$HUB_ENV" "$value" <<'PY'
from pathlib import Path
import sys
p=Path(sys.argv[1]); value=sys.argv[2]
s=p.read_text()
lines=s.splitlines()
found=False
out=[]
for line in lines:
    if line.startswith("HUB_BASE_URL="):
        out.append(f"HUB_BASE_URL={value}"); found=True
    else:
        out.append(line)
if not found: out.append(f"HUB_BASE_URL={value}")
p.write_text("\n".join(out)+"\n")
PY
}

if [[ "$ACTION" == "new" ]]; then
  if [[ ! -f "$BACKUP" ]]; then
    cp "$HUB_ENV" "$BACKUP"
    chmod 600 "$BACKUP" || true
  fi
  replace_base_url "$NEW_URL"
  compose up -d --no-deps --force-recreate "${consumer_services[@]}"
  touch "$STATE_DIR/consumers-switched.confirmed"
  touch "$STATE_DIR/external-writes-possible.confirmed"
  echo "[dach-hub:consumers] consumers now use $NEW_URL"
  exit 0
fi

if [[ "$ACTION" == "old" ]]; then
  if [[ -f "$STATE_DIR/external-writes-possible.confirmed" ]]; then
    echo "[dach-hub:consumers] automatic rollback refused: new Hub may already contain newer writes." >&2
    echo "Freeze and reconcile VPS data before any return to the previous Hub." >&2
    exit 3
  fi
  [[ -f "$BACKUP" ]] || { echo "[dach-hub:consumers] backup $BACKUP not found" >&2; exit 2; }
  cp "$BACKUP" "$HUB_ENV"
  chmod 600 "$HUB_ENV" || true
  compose up -d --no-deps --force-recreate "${consumer_services[@]}"
  echo "[dach-hub:consumers] pre-cutover hub.env restored"
  exit 0
fi

echo "Usage: $0 [new|old]" >&2
exit 2
