#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")"

COMPOSE_ENV="${COMPOSE_ENV:-./env/compose.env}"
BASE=(docker compose --env-file "$COMPOSE_ENV" -f compose.vps.yml)
MIG=(docker compose --env-file "$COMPOSE_ENV" -f compose.vps.yml -f compose.migration.yml)
BACKUP=(docker compose --env-file "$COMPOSE_ENV" -f compose.vps.yml -f compose.backup.yml)

usage() {
  cat <<'TXT'
Usage: ./business-db-ops.sh <command>

Commands:
  provision   Start PostgreSQL and idempotently create Business databases/roles.
  import      Dump the four Neon databases, verify dumps, and restore into EMPTY local databases.
  snapshot    Create a local dump of all four VPS Business databases.
  migrate     Snapshot first, then run Chat/Core/Stock/Price migrations explicitly.
  verify      Validate runtime DB roles and migration marker tables.
  backup      Run the full restic backup job (requires env/backup.env and initialized repository).

The script never performs import + migration + app cutover in one command.
TXT
}

require_file() {
  [[ -f "$1" ]] || { echo "Missing required file: $1" >&2; exit 1; }
}

command="${1:-}"
case "$command" in
  provision)
    require_file ./env/postgres.env
    "${BASE[@]}" up -d postgres
    "${BASE[@]}" --profile ops run --rm postgres-provision
    ;;
  import)
    require_file ./env/postgres.env
    require_file ./env/migration.env
    "${BASE[@]}" up -d postgres
    "${BASE[@]}" --profile ops run --rm postgres-provision
    "${MIG[@]}" --profile migration run --rm business-db-import
    ;;
  snapshot)
    require_file ./env/postgres.env
    require_file ./env/migration.env
    "${BASE[@]}" up -d postgres
    "${MIG[@]}" --profile migration run --rm business-db-snapshot
    ;;
  migrate)
    require_file ./env/postgres.env
    require_file ./env/business-chat-api.env
    require_file ./env/business-core.env
    require_file ./env/business-core-migrate.env
    require_file ./env/business-stock.env
    require_file ./env/business-stock-migrate.env
    require_file ./env/business-price.env
    require_file ./env/business-price-migrate.env
    require_file ./env/migration.env
    "${BASE[@]}" up -d postgres
    "${BASE[@]}" --profile ops run --rm postgres-provision
    "${MIG[@]}" --profile migration run --rm business-db-snapshot
    "${BASE[@]}" --profile ops build business-chat-migrate business-core-migrate business-stock-migrate business-price-migrate
    "${BASE[@]}" --profile ops run --rm business-chat-migrate
    "${BASE[@]}" --profile ops run --rm business-core-migrate
    "${BASE[@]}" --profile ops run --rm business-stock-migrate
    "${BASE[@]}" --profile ops run --rm business-price-migrate
    ;;
  verify)
    require_file ./env/postgres.env
    require_file ./env/migration.env
    "${BASE[@]}" up -d postgres
    "${MIG[@]}" --profile migration run --rm business-db-verify
    ;;
  backup)
    require_file ./env/postgres.env
    require_file ./env/backup.env
    "${BASE[@]}" up -d postgres
    "${BACKUP[@]}" --profile backup run --rm backup
    ;;
  *) usage; [[ -n "$command" ]] && exit 1 || exit 0 ;;
esac
