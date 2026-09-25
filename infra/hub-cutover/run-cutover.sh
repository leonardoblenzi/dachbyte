#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
STATE_DIR="$INFRA_DIR/.cutover"
BACKUP_DIR="$INFRA_DIR/backups/hub-cutover"
COMPOSE_FILE="$INFRA_DIR/compose.vps.yml"
COMPOSE_ENV="$INFRA_DIR/env/compose.env"
CUTOVER_ENV="$INFRA_DIR/env/hub-cutover.env"
ACTION="${1:-status}"

mkdir -p "$STATE_DIR" "$BACKUP_DIR"
chmod 700 "$STATE_DIR" "$BACKUP_DIR" || true

require_file() { [[ -f "$1" ]] || { echo "[dach-hub:cutover] missing required file: $1" >&2; exit 2; }; }
require_marker() { [[ -f "$STATE_DIR/$1" ]] || { echo "[dach-hub:cutover] missing marker: $1" >&2; exit 2; }; }
mark() { touch "$STATE_DIR/$1"; }

for file in "$COMPOSE_ENV" "$INFRA_DIR/env/postgres.env" "$INFRA_DIR/env/hub-runtime.env" "$INFRA_DIR/env/hub-migrate.env" "$CUTOVER_ENV"; do require_file "$file"; done
env_value() {
  python3 - "$CUTOVER_ENV" "$1" <<'PYENV'
from pathlib import Path
import sys
path=Path(sys.argv[1]); key=sys.argv[2]
for raw in path.read_text().splitlines():
    line=raw.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    k,v=line.split("=",1)
    if k.strip()==key:
        print(v.strip().strip('"').strip("'"))
        break
PYENV
}

CONFIRM_HUB_COMMERCIAL_FREEZE="$(env_value CONFIRM_HUB_COMMERCIAL_FREEZE)"
CONFIRM_OLD_HUB_SCHEDULER_DISABLED="$(env_value CONFIRM_OLD_HUB_SCHEDULER_DISABLED)"
HUB_CUTOVER_PUBLIC_BASE_URL="$(env_value HUB_CUTOVER_PUBLIC_BASE_URL)"

compose() {
  docker compose --env-file "$COMPOSE_ENV" -f "$COMPOSE_FILE" --profile cutover --profile hub-scheduler "$@"
}

asaas() {
  compose run --rm hub-cutover-tools npm run cutover:asaas -- "$@"
}

case "$ACTION" in
  status)
    echo "[dach-hub:cutover] state directory: $STATE_DIR"
    find "$STATE_DIR" -maxdepth 1 -type f -printf '%f\n' 2>/dev/null | sort || true
    echo
    compose ps || true
    ;;

  preflight)
    require_file "$INFRA_DIR/backups/hub-rehearsal/compare-latest.json"
    grep -Eq '"ok"[[:space:]]*:[[:space:]]*true' "$INFRA_DIR/backups/hub-rehearsal/compare-latest.json" || {
      echo "[dach-hub:cutover] rehearsal comparison is not OK" >&2; exit 2;
    }
    if compose ps --status running --services | grep -qx 'hub-scheduler'; then
      echo "[dach-hub:cutover] new hub-scheduler is already running before cutover" >&2; exit 2;
    fi
    compose config -q
    compose run --rm --no-deps caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
    asaas status > "$STATE_DIR/asaas-webhook-preflight.json"
    chmod 600 "$STATE_DIR/asaas-webhook-preflight.json" || true
    mark preflight.confirmed
    echo "[dach-hub:cutover] preflight OK. No production data was changed."
    ;;

  confirm-freeze)
    require_marker preflight.confirmed
    [[ "${CONFIRM_HUB_COMMERCIAL_FREEZE:-NO}" == "YES" ]] || { echo "CONFIRM_HUB_COMMERCIAL_FREEZE=YES required" >&2; exit 2; }
    mark commercial-freeze.confirmed
    echo "[dach-hub:cutover] commercial mutation freeze recorded."
    ;;

  confirm-old-scheduler-disabled)
    require_marker commercial-freeze.confirmed
    [[ "${CONFIRM_OLD_HUB_SCHEDULER_DISABLED:-NO}" == "YES" ]] || { echo "CONFIRM_OLD_HUB_SCHEDULER_DISABLED=YES required" >&2; exit 2; }
    mark old-scheduler-disabled.confirmed
    echo "[dach-hub:cutover] previous scheduler disablement recorded."
    ;;

  pause-webhook)
    require_marker old-scheduler-disabled.confirmed
    asaas status > "$STATE_DIR/asaas-webhook-before.json"
    chmod 644 "$STATE_DIR/asaas-webhook-before.json" || true
    asaas pause > "$STATE_DIR/asaas-webhook-paused.json"
    grep -Eq '"interrupted"[[:space:]]*:[[:space:]]*true' "$STATE_DIR/asaas-webhook-paused.json" || {
      echo "[dach-hub:cutover] Asaas queue was not confirmed interrupted" >&2; exit 2;
    }
    mark asaas-queue-paused.confirmed
    echo "[dach-hub:cutover] Asaas queue interrupted; events may accumulate while final snapshot is taken."
    ;;

  snapshot)
    require_marker asaas-queue-paused.confirmed
    compose run --rm -e HUB_CUTOVER_ACTION=snapshot hub-cutover-db
    ;;

  restore)
    require_marker final-snapshot.confirmed
    compose run --rm -e HUB_CUTOVER_ACTION=restore hub-cutover-db
    ;;

  migrate)
    require_marker database-restored.confirmed
    compose run --rm hub-migrate npm run db:migrate:plan
    compose run --rm hub-migrate npm run db:migrate
    mark migrations-applied.confirmed
    ;;

  compare)
    require_marker migrations-applied.confirmed
    set +e
    compose run --rm hub-cutover-compare | tee "$BACKUP_DIR/compare-final.json"
    status=${PIPESTATUS[0]}
    set -e
    if [[ $status -ne 0 ]]; then
      echo "[dach-hub:cutover] live source x target divergence detected. Repeat snapshot/restore; do not continue." >&2
      exit $status
    fi
    mark final-compare.confirmed
    ;;

  start-web)
    require_marker final-compare.confirmed
    compose up -d hub-web
    ;;

  validate-internal)
    require_marker final-compare.confirmed
    for attempt in $(seq 1 30); do
      if compose exec -T hub-web node -e "fetch('http://127.0.0.1:8787/healthz').then(async r=>{const j=await r.json();process.exit(r.status===200&&j.ok===true?0:1)}).catch(()=>process.exit(1))"; then
        mark web-internal-healthy.confirmed
        echo "[dach-hub:cutover] internal hub-web health OK"
        exit 0
      fi
      sleep 2
    done
    echo "[dach-hub:cutover] internal health failed" >&2
    exit 1
    ;;

  reload-caddy)
    require_marker web-internal-healthy.confirmed
    compose exec -T caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
    compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
    mark caddy-reloaded.confirmed
    ;;

  public-smoke)
    require_marker caddy-reloaded.confirmed
    compose run --rm hub-cutover-tools npm run cutover:smoke | tee "$STATE_DIR/public-smoke.json"
    mark public-smoke.confirmed
    ;;

  point-webhook)
    require_marker public-smoke.confirmed
    require_marker asaas-queue-paused.confirmed
    asaas point-new > "$STATE_DIR/asaas-webhook-pointed.json"
    grep -Fq 'hub.dachbyte.tech/v1/public/webhooks/payment' "$STATE_DIR/asaas-webhook-pointed.json" || {
      echo "[dach-hub:cutover] Asaas webhook URL change was not confirmed" >&2; exit 2;
    }
    mark webhook-pointed.confirmed
    ;;

  start-scheduler)
    require_marker public-smoke.confirmed
    require_marker old-scheduler-disabled.confirmed
    compose up -d hub-scheduler
    mark scheduler-started.confirmed
    mark external-writes-possible.confirmed
    echo "[dach-hub:cutover] new scheduler started. Automatic failback to the old database is no longer safe."
    ;;

  switch-consumers)
    require_marker public-smoke.confirmed
    HUB_CUTOVER_PUBLIC_BASE_URL="${HUB_CUTOVER_PUBLIC_BASE_URL:-https://hub.dachbyte.tech}" bash "$SCRIPT_DIR/switch-consumers.sh" new
    mark external-writes-possible.confirmed
    ;;

  resume-webhook)
    require_marker webhook-pointed.confirmed
    require_marker public-smoke.confirmed
    asaas resume > "$STATE_DIR/asaas-webhook-resumed.json"
    grep -Eq '"interrupted"[[:space:]]*:[[:space:]]*false' "$STATE_DIR/asaas-webhook-resumed.json" || {
      echo "[dach-hub:cutover] webhook queue resume not confirmed" >&2; exit 2;
    }
    mark webhook-resumed.confirmed
    mark external-writes-possible.confirmed
    echo "[dach-hub:cutover] Asaas queue resumed on the new Hub. Failback now requires data reconciliation."
    ;;

  complete)
    for marker in public-smoke.confirmed scheduler-started.confirmed consumers-switched.confirmed webhook-resumed.confirmed; do require_marker "$marker"; done
    mark cutover-complete.confirmed
    echo "[dach-hub:cutover] cutover marked complete. Keep previous Worker/database for observation only; do not fail back without reconciliation."
    ;;

  rollback-early)
    if [[ -f "$STATE_DIR/external-writes-possible.confirmed" ]]; then
      echo "[dach-hub:cutover] early rollback refused: the new Hub may already contain writes not present in the previous database." >&2
      echo "Freeze, export/reconcile VPS changes and follow the late-rollback runbook." >&2
      exit 3
    fi
    if [[ -f "$STATE_DIR/asaas-queue-paused.confirmed" ]]; then
      asaas restore-old > "$STATE_DIR/asaas-webhook-restored-old.json"
    fi
    compose stop hub-scheduler hub-web >/dev/null 2>&1 || true
    echo "[dach-hub:cutover] new Hub stopped before external write producers were switched; Asaas was restored when applicable."
    echo "Re-enable the previous scheduler manually if it had been disabled."
    ;;

  *)
    echo "Usage: $0 {status|preflight|confirm-freeze|confirm-old-scheduler-disabled|pause-webhook|snapshot|restore|migrate|compare|start-web|validate-internal|reload-caddy|public-smoke|point-webhook|start-scheduler|switch-consumers|resume-webhook|complete|rollback-early}" >&2
    exit 2
    ;;
esac
