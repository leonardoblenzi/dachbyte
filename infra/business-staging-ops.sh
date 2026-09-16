#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")"

COMPOSE_ENV="${COMPOSE_ENV:-./env/compose.env}"
BASE=(docker compose --env-file "$COMPOSE_ENV" -f compose.vps.yml)
VALIDATION=(docker compose --env-file "$COMPOSE_ENV" -f compose.vps.yml -f compose.staging-validation.yml)

usage() {
  cat <<'TXT'
Usage: ./business-staging-ops.sh <command>

Commands:
  up            Build/start the Business staging services using compose.vps.yml.
  wait          Wait until the Business staging services are healthy.
  config        Validate Compose rendering and Caddy configuration.
  status        Show Business/Postgres/Redis/Caddy container health.
  db            Run the Business database/role verification gate.
  public-smoke  Test internal health + public canonical/legacy routes without credentials.
  smoke         Run the full staging gate (requires env/staging-validation.env credentials).
  all           Run config + status + db + full smoke.

Only the `up` command builds/starts staging containers. The validation commands do not
import, migrate, restart, or cut over production traffic.
TXT
}

require_file() {
  [[ -f "$1" ]] || { echo "Missing required file: $1" >&2; exit 1; }
}

require_runtime_envs() {
  local files=(
    ./env/compose.env
    ./env/postgres.env
    ./env/hub.env
    ./env/business-portal.env
    ./env/business-core.env
    ./env/business-chat.env
    ./env/business-chat-api.env
    ./env/business-stock.env
    ./env/business-price.env
  )
  local file
  for file in "${files[@]}"; do require_file "$file"; done
}

up_staging() {
  require_runtime_envs
  "${BASE[@]}" config --quiet
  "${BASE[@]}" up -d --build \
    postgres redis \
    business-portal business-core business-chat business-chat-api business-stock business-price \
    caddy
}

wait_gate() {
  local deadline=$((SECONDS + ${STAGING_WAIT_SECONDS:-300}))
  until status_gate; do
    if (( SECONDS >= deadline )); then
      echo "Timed out waiting for staging services to become healthy." >&2
      return 1
    fi
    echo "Waiting for staging health..."
    sleep 5
  done
}

compose_config() {
  python3 ./scripts/verify-legacy-routing.py ./Caddyfile
  "${BASE[@]}" config --quiet
  echo "[ok] compose.vps.yml rendered successfully"

  # Validate the exact Caddyfile mounted by the running edge container.
  "${BASE[@]}" exec -T caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
  echo "[ok] Caddy configuration valid"
}

status_gate() {
  local services=(caddy postgres redis business-portal business-core business-chat business-chat-api business-stock business-price)
  local failed=0
  local service cid state health
  for service in "${services[@]}"; do
    cid="$("${BASE[@]}" ps -q "$service")"
    if [[ -z "$cid" ]]; then
      echo "[fail] $service is not running" >&2
      failed=1
      continue
    fi
    state="$(docker inspect -f '{{.State.Status}}' "$cid")"
    health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}' "$cid")"
    if [[ "$state" != "running" || "$health" == "unhealthy" || "$health" == "starting" ]]; then
      echo "[fail] $service state=$state health=$health" >&2
      failed=1
    else
      echo "[ok] $service state=$state health=$health"
    fi
  done
  [[ "$failed" -eq 0 ]]
}

run_validation() {
  require_file ./env/staging-validation.env
  "${VALIDATION[@]}" --profile validation run --rm "$@" business-staging-smoke
}

command="${1:-}"
case "$command" in
  up)
    up_staging
    ;;
  wait)
    wait_gate
    ;;
  config)
    compose_config
    ;;
  status)
    status_gate
    ;;
  db)
    ./business-db-ops.sh verify
    ;;
  public-smoke)
    run_validation -e STAGING_RUN_AUTH_TESTS=false -e STAGING_REQUIRE_AUTH_TESTS=false -e STAGING_REQUIRE_HUB_VERIFY=false -e STAGING_REQUIRE_DESKTOP_RELEASE=false
    ;;
  smoke)
    run_validation
    ;;
  all)
    compose_config
    status_gate
    ./business-db-ops.sh verify
    run_validation
    ;;
  *)
    usage
    [[ -n "$command" ]] && exit 1 || exit 0
    ;;
esac
