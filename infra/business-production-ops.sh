#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")"

COMPOSE_ENV="${COMPOSE_ENV:-./env/compose.env}"
CUTOVER_ENV="${CUTOVER_ENV:-./env/production-cutover.env}"
VALIDATION_ENV="${VALIDATION_ENV:-./env/production-validation.env}"
BASE=(docker compose --env-file "$COMPOSE_ENV" -f compose.vps.yml)
VALIDATION=(docker compose --env-file "$COMPOSE_ENV" -f compose.vps.yml -f compose.production-validation.yml)
CUTOVER_DIR="./.cutover"
PREPARED_FILE="$CUTOVER_DIR/prepared.env"
ROLLBACK_MANIFEST="$CUTOVER_DIR/rollback-images.tsv"
PREPARED_IMAGES_MANIFEST="$CUTOVER_DIR/prepared-images.tsv"

BUSINESS_SERVICES=(business-portal business-core business-chat business-chat-api business-stock business-price)
HEALTH_SERVICES=(caddy postgres redis business-portal business-core business-chat business-chat-api business-stock business-price)
ROLLBACK_SERVICE_IMAGES=(
  "business-portal|dachbyte/business:local"
  "business-core|dachbyte/core:local"
  "business-chat|dachbyte/chat:local"
  "business-chat-api|dachbyte/chat-api:local"
  "business-stock|dachbyte/stock:local"
)
DEPLOY_IMAGES=(dachbyte/business:local dachbyte/core:local dachbyte/chat:local dachbyte/chat-api:local dachbyte/stock:local)

usage() {
  cat <<'TXT'
Usage: ./business-production-ops.sh <command>

Commands:
  preflight      Validate env/Compose/database state without changing running apps.
  prepare        Snapshot DBs, preserve current images as rollback tags, then build new images.
  status         Show production service/container health.
  public-smoke   Validate canonical + legacy public routes without credentials.
  smoke          Run production-validation.env gate (can include auth/isolation tests).
  cutover        Start prepared images and Caddy. Requires CONFIRM_PRODUCTION_CUTOVER=YES.
  rollback-code  Restore the preserved Docker images only. Requires CONFIRM_PRODUCTION_ROLLBACK=YES.
  show-rollback  Print the preserved image manifest and DB snapshot reminder.

This script never imports databases, runs migrations, publishes desktop releases,
or restores a database automatically.
TXT
}

require_file() {
  [[ -f "$1" ]] || { echo "Missing required file: $1" >&2; exit 1; }
}

get_compose_env_value() {
  local key="$1"
  awk -F= -v key="$key" '$1 == key {sub(/^[^=]*=/, ""); gsub(/^['"'"']|['"'"']$/, ""); print; exit}' "$COMPOSE_ENV"
}

load_cutover_env() {
  require_file "$CUTOVER_ENV"
  require_file "$COMPOSE_ENV"
  # shellcheck disable=SC1090
  set -a; source "$CUTOVER_ENV"; set +a
  : "${PRODUCTION_BASE_URL:?PRODUCTION_BASE_URL is required}"
  if [[ ! "$PRODUCTION_BASE_URL" =~ ^https://[^/]+/?$ ]]; then
    echo "PRODUCTION_BASE_URL must be an HTTPS origin without a path: $PRODUCTION_BASE_URL" >&2
    exit 1
  fi
  PRODUCTION_BASE_URL="${PRODUCTION_BASE_URL%/}"
  if [[ "$PRODUCTION_BASE_URL" == *staging* ]]; then
    echo "Refusing production cutover with a staging hostname: $PRODUCTION_BASE_URL" >&2
    exit 1
  fi

  local compose_site bind_ip
  compose_site="$(get_compose_env_value DACHBYTE_SITE)"
  compose_site="${compose_site%/}"
  bind_ip="$(get_compose_env_value DACHBYTE_BIND_IP)"
  if [[ -z "$compose_site" || "$compose_site" != "$PRODUCTION_BASE_URL" ]]; then
    echo "DACHBYTE_SITE in $COMPOSE_ENV must exactly match PRODUCTION_BASE_URL." >&2
    echo "compose=$compose_site production=$PRODUCTION_BASE_URL" >&2
    exit 1
  fi
  if [[ -z "$bind_ip" || "$bind_ip" == "127.0.0.1" || "$bind_ip" == "localhost" ]]; then
    echo "DACHBYTE_BIND_IP is still local-only ($bind_ip). Configure the production bind before cutover." >&2
    exit 1
  fi
}

require_runtime_envs() {
  local files=(
    ./env/compose.env ./env/postgres.env ./env/hub.env
    ./env/business-portal.env ./env/business-core.env ./env/business-chat.env
    ./env/business-chat-api.env ./env/business-stock.env ./env/business-price.env
  )
  local file
  for file in "${files[@]}"; do require_file "$file"; done
}

compose_config() {
  python3 ./scripts/verify-legacy-routing.py ./Caddyfile
  "${BASE[@]}" config --quiet
  echo "[ok] compose.vps.yml rendered successfully"
  "${BASE[@]}" run --rm --no-deps caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
  echo "[ok] Caddy configuration valid with production environment"
}

status_gate() {
  local failed=0 service cid state health
  for service in "${HEALTH_SERVICES[@]}"; do
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

wait_gate() {
  local deadline=$((SECONDS + ${PRODUCTION_WAIT_SECONDS:-300}))
  until status_gate; do
    if (( SECONDS >= deadline )); then
      echo "Timed out waiting for production services to become healthy." >&2
      return 1
    fi
    echo "Waiting for production health..."
    sleep 5
  done
}

run_validation() {
  require_file "$VALIDATION_ENV"
  "${VALIDATION[@]}" --profile validation run --rm \
    -e VALIDATION_BASE_URL="$PRODUCTION_BASE_URL" \
    "$@" business-production-smoke
}

public_smoke() {
  run_validation \
    -e VALIDATION_RUN_AUTH_TESTS=false \
    -e VALIDATION_REQUIRE_AUTH_TESTS=false \
    -e VALIDATION_REQUIRE_HUB_VERIFY=false \
    -e VALIDATION_REQUIRE_PASSWORD_RESET_CONFIG=false \
    -e VALIDATION_REQUIRE_DESKTOP_RELEASE=false \
    -e VALIDATION_REQUIRE_ISOLATION_TESTS=false
}

preserve_rollback_images() {
  mkdir -p "$CUTOVER_DIR"
  local release_id="${CURRENT_CUTOVER_RELEASE_ID:-${CUTOVER_RELEASE_ID:-$(date -u +%Y%m%dT%H%M%SZ)}}"
  : > "$ROLLBACK_MANIFEST"
  local pair service source base rollback cid image_id
  for pair in "${ROLLBACK_SERVICE_IMAGES[@]}"; do
    IFS='|' read -r service source <<< "$pair"
    cid="$("${BASE[@]}" ps -q "$service")"
    if [[ -z "$cid" ]]; then
      echo "[warn] no running container to preserve for $service"
      continue
    fi
    image_id="$(docker inspect -f '{{.Image}}' "$cid")"
    [[ -n "$image_id" ]] || { echo "Cannot resolve image for $service" >&2; return 1; }
    base="${source%:local}"
    rollback="${base}:rollback-${release_id}"
    docker tag "$image_id" "$rollback"
    printf '%s\t%s\n' "$source" "$rollback" >> "$ROLLBACK_MANIFEST"
    echo "[ok] preserved running $service image as $rollback"
  done

  # Portal and Price intentionally use the same business image. Refuse to prepare
  # an ambiguous rollback if the currently running containers differ.
  local portal_cid price_cid portal_image price_image
  portal_cid="$("${BASE[@]}" ps -q business-portal)"
  price_cid="$("${BASE[@]}" ps -q business-price)"
  if [[ -n "$portal_cid" && -n "$price_cid" ]]; then
    portal_image="$(docker inspect -f '{{.Image}}' "$portal_cid")"
    price_image="$(docker inspect -f '{{.Image}}' "$price_cid")"
    if [[ "$portal_image" != "$price_image" ]]; then
      echo "business-portal and business-price are running different image IDs; rollback would be ambiguous." >&2
      return 1
    fi
  fi

}

record_prepared_images() {
  : > "$PREPARED_IMAGES_MANIFEST"
  local image image_id
  for image in "${DEPLOY_IMAGES[@]}"; do
    image_id="$(docker image inspect -f '{{.Id}}' "$image")"
    [[ -n "$image_id" ]] || { echo "Built image not found: $image" >&2; return 1; }
    printf '%s\t%s\n' "$image" "$image_id" >> "$PREPARED_IMAGES_MANIFEST"
  done
}

verify_prepared_images() {
  require_file "$PREPARED_IMAGES_MANIFEST"
  local image expected current
  while IFS=$'\t' read -r image expected; do
    [[ -n "$image" && -n "$expected" ]] || continue
    current="$(docker image inspect -f '{{.Id}}' "$image")"
    if [[ "$current" != "$expected" ]]; then
      echo "Prepared image changed after validation: $image" >&2
      echo "expected=$expected current=$current" >&2
      return 1
    fi
  done < "$PREPARED_IMAGES_MANIFEST"
}

prepare_cutover() {
  require_runtime_envs
  load_cutover_env
  compose_config
  ./business-db-ops.sh verify
  echo "Creating mandatory pre-cutover database snapshot..."
  ./business-db-ops.sh snapshot
  mkdir -p "$CUTOVER_DIR"
  rm -f "$PREPARED_FILE"
  CURRENT_CUTOVER_RELEASE_ID="${CUTOVER_RELEASE_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
  export CURRENT_CUTOVER_RELEASE_ID
  preserve_rollback_images
  echo "Building new Business images without restarting production..."
  "${BASE[@]}" build "${BUSINESS_SERVICES[@]}"
  record_prepared_images
  printf 'CUTOVER_RELEASE_ID=%q\nPREPARED_AT_UTC=%q\n' "$CURRENT_CUTOVER_RELEASE_ID" "$(date -u +%FT%TZ)" > "$PREPARED_FILE"
  echo "[ok] cutover prepared. No production container was restarted by this command."
  echo "Prepared marker: $PREPARED_FILE"
}

perform_cutover() {
  require_runtime_envs
  load_cutover_env
  require_file "$PREPARED_FILE"
  if [[ "${CONFIRM_PRODUCTION_CUTOVER:-NO}" != "YES" ]]; then
    echo "Cutover blocked. Set CONFIRM_PRODUCTION_CUTOVER=YES in $CUTOVER_ENV." >&2
    exit 1
  fi
  compose_config
  ./business-db-ops.sh verify
  verify_prepared_images
  "${BASE[@]}" up -d --no-build "${BUSINESS_SERVICES[@]}" caddy
  wait_gate
  public_smoke
  echo "[ok] production cutover completed and public smoke passed."
}

rollback_code() {
  load_cutover_env
  require_file "$ROLLBACK_MANIFEST"
  if [[ "${CONFIRM_PRODUCTION_ROLLBACK:-NO}" != "YES" ]]; then
    echo "Rollback blocked. Set CONFIRM_PRODUCTION_ROLLBACK=YES in $CUTOVER_ENV." >&2
    exit 1
  fi
  local source rollback
  while IFS=$'\t' read -r source rollback; do
    [[ -n "$source" && -n "$rollback" ]] || continue
    docker image inspect "$rollback" >/dev/null
    docker tag "$rollback" "$source"
    echo "[ok] restored image tag $source from $rollback"
  done < "$ROLLBACK_MANIFEST"
  "${BASE[@]}" up -d --no-build "${BUSINESS_SERVICES[@]}" caddy
  wait_gate
  public_smoke
  echo "[ok] code/image rollback completed. DATABASE WAS NOT RESTORED."
}

preflight() {
  require_runtime_envs
  load_cutover_env
  compose_config
  ./business-db-ops.sh verify
  echo "[ok] production preflight passed"
}

command="${1:-}"
case "$command" in
  preflight) preflight ;;
  prepare) prepare_cutover ;;
  status) load_cutover_env; status_gate ;;
  public-smoke) load_cutover_env; public_smoke ;;
  smoke) load_cutover_env; run_validation ;;
  cutover) perform_cutover ;;
  rollback-code) rollback_code ;;
  show-rollback)
    [[ -f "$PREPARED_FILE" ]] && cat "$PREPARED_FILE" || true
    [[ -f "$ROLLBACK_MANIFEST" ]] && cat "$ROLLBACK_MANIFEST" || echo "No rollback image manifest."
    [[ -f "$PREPARED_IMAGES_MANIFEST" ]] && cat "$PREPARED_IMAGES_MANIFEST" || echo "No prepared image manifest."
    echo "Database snapshots are stored under infra/backups/migration/."
    ;;
  *) usage; [[ -n "$command" ]] && exit 1 || exit 0 ;;
esac
