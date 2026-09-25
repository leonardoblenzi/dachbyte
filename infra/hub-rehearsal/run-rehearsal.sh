#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$INFRA_DIR/compose.vps.yml"
COMPOSE_ENV="$INFRA_DIR/env/compose.env"
ACTION="${1:-prepare}"
# A rehearsal must never share container names, networks or volumes with the
# active dachbyte-staging Compose project.
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-dachbyte-hub-rehearsal}"

compose() {
  docker compose --project-name "$COMPOSE_PROJECT_NAME" --env-file "$COMPOSE_ENV" -f "$COMPOSE_FILE" --profile rehearsal "$@"
}

require_file() {
  if [[ ! -f "$1" ]]; then
    echo "[dach-hub:rehearsal] missing required file: $1" >&2
    exit 2
  fi
}

for file in \
  "$COMPOSE_ENV" \
  "$INFRA_DIR/env/postgres.env" \
  "$INFRA_DIR/env/hub-rehearsal-db.env" \
  "$INFRA_DIR/env/hub-rehearsal-migrate.env" \
  "$INFRA_DIR/env/hub-rehearsal-compare.env" \
  "$INFRA_DIR/env/hub-rehearsal-runtime.env"; do
  require_file "$file"
done

if [[ "$ACTION" == "destroy" ]]; then
  compose stop hub-rehearsal-web >/dev/null 2>&1 || true
  compose rm -f hub-rehearsal-web >/dev/null 2>&1 || true
  compose run --rm -e HUB_REHEARSAL_ACTION=destroy hub-rehearsal-db
  echo "[dach-hub:rehearsal] rehearsal environment removed; backup files were preserved."
  exit 0
fi

if [[ "$ACTION" != "prepare" ]]; then
  echo "Usage: $0 [prepare|destroy]" >&2
  exit 2
fi

mkdir -p "$INFRA_DIR/backups/hub-rehearsal"

echo "[1/6] Dump + SHA-256 + restore into isolated rehearsal database"
compose run --rm hub-rehearsal-db

echo "[2/6] Migration plan against rehearsal target"
compose run --rm hub-rehearsal-migrate npm run db:migrate:plan

echo "[3/6] Apply any safe pending migrations against rehearsal target"
compose run --rm hub-rehearsal-migrate npm run db:migrate

echo "[4/6] Source x target database comparison"
set +e
compose run --rm hub-rehearsal-compare | tee "$INFRA_DIR/backups/hub-rehearsal/compare-latest.json"
COMPARE_STATUS=${PIPESTATUS[0]}
set -e
if [[ $COMPARE_STATUS -ne 0 ]]; then
  echo "[dach-hub:rehearsal] comparison reported divergence; web runtime will NOT be started." >&2
  exit $COMPARE_STATUS
fi

echo "[5/6] Start isolated Hub web on loopback only"
compose up -d hub-rehearsal-web

PORT="${HUB_REHEARSAL_BIND_PORT:-18787}"
echo "[6/6] Health check"
for attempt in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${PORT}/healthz" >/dev/null; then
    echo "[dach-hub:rehearsal] healthz OK"
    break
  fi
  if [[ $attempt -eq 30 ]]; then
    echo "[dach-hub:rehearsal] healthz did not become ready" >&2
    exit 1
  fi
  sleep 2
done

cat <<EOF2

Rehearsal ready and isolated from Caddy/Gateway/Asaas production.
Local VPS endpoint: http://127.0.0.1:${PORT}

From your workstation use an SSH tunnel, for example:
  ssh -L ${PORT}:127.0.0.1:${PORT} <user>@<vps>

Then open:
  http://127.0.0.1:${PORT}/ops-portal

Do not point DACH consumers or the Asaas production webhook at this rehearsal service.
To destroy only the temporary DB/runtime later:
  bash infra/hub-rehearsal/run-rehearsal.sh destroy
EOF2
