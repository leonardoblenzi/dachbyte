#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"

COMPOSE_ENV="${COMPOSE_ENV:-./env/compose.env}"
BASE=(docker compose --env-file "$COMPOSE_ENV" -f compose.vps.yml)
SINCE="${LEGACY_LOG_SINCE:-168h}"

usage() {
  cat <<'TXT'
Usage: ./business-legacy-ops.sh <command>

Commands:
  verify              Static-check canonical/legacy Caddy route contracts.
  report              Summarize legacy route hits from Caddy access logs.
  api-retirement-gate Fail while any legacy API hit exists in the selected log window.

Environment:
  LEGACY_LOG_SINCE=168h   docker-log window used by report/gate.

The API retirement gate is evidence, not an automatic removal command. Log retention
must cover the whole observation window before legacy APIs are deleted.
TXT
}

caddy_container() {
  local cid
  cid="$("${BASE[@]}" ps -q caddy)"
  [[ -n "$cid" ]] || { echo "Caddy container is not running." >&2; exit 1; }
  printf '%s\n' "$cid"
}

report() {
  local cid
  cid="$(caddy_container)"
  docker logs --since "$SINCE" "$cid" 2>&1 | python3 ./scripts/legacy-route-report.py
}

api_gate() {
  local cid
  cid="$(caddy_container)"
  docker logs --since "$SINCE" "$cid" 2>&1 | python3 ./scripts/legacy-route-report.py --fail-on-api-hits
}

case "${1:-}" in
  verify)
    python3 ./scripts/verify-legacy-routing.py ./Caddyfile
    ;;
  report)
    report
    ;;
  api-retirement-gate)
    api_gate
    ;;
  *)
    usage
    [[ -n "${1:-}" ]] && exit 1 || exit 0
    ;;
esac
