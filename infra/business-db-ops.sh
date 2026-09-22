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
  audit-partition-status     Show ML audit-partition cutover state and recent ledger entries.
  audit-partition-preflight  Measure the mandatory cutover gates; does not alter audit data.
  audit-partition-release-preflight  Validate the post-swap legacy release gates; does not alter audit data.
  audit-partition-copy       Create/copy the partitioned shadow table; requires COPY confirmation.
  audit-partition-verify     Compare the legacy table and shadow before a swap.
  audit-partition-swap       Atomically promote the verified shadow; requires SWAP confirmation.
  audit-partition-rollback   Restore the retained legacy table; requires ROLLBACK confirmation.
  audit-partition-release-legacy  Drop the observed legacy table; requires RELEASE_LEGACY confirmation.

The script never performs import + migration + app cutover in one command.
TXT
}

require_file() {
  [[ -f "$1" ]] || { echo "Missing required file: $1" >&2; exit 1; }
}

require_confirmation() {
  local expected="$1"
  if [[ "${AUTH_AUDIT_PARTITION_CONFIRM:-}" != "$expected" ]]; then
    echo "Refusing audit partition operation. Set AUTH_AUDIT_PARTITION_CONFIRM=$expected explicitly." >&2
    exit 1
  fi
}

validate_cutover_args() {
  local argument
  local dry_run_seen=0
  local release_preflight_seen=0
  for argument in "$@"; do
    case "$argument" in
      --dry-run) (( dry_run_seen++ == 0 )) || { echo "--dry-run cannot be repeated." >&2; exit 1; } ;;
      --release-legacy) (( release_preflight_seen++ == 0 )) || { echo "--release-legacy cannot be repeated." >&2; exit 1; } ;;
      *) echo "Only --dry-run and --release-legacy are accepted after an audit-partition command." >&2; exit 1 ;;
    esac
  done
}

run_audit_partition_cutover() {
  local action="$1"
  shift
  validate_cutover_args "$@"
  require_file ./env/seller-ml.env
  local name
  local cutover_env_args=()
  local -a cutover_env_allowlist=(
    AUTH_AUDIT_PARTITION_CONFIRM
    AUTH_AUDIT_PARTITION_BACKUP_RESTORED
    AUTH_AUDIT_PARTITION_ALLOW_NO_BACKUP
    AUTH_AUDIT_PARTITION_MAINTENANCE_WINDOW
    AUTH_AUDIT_PARTITION_CAPACITY_CONFIRMED
    AUTH_AUDIT_PARTITION_AVAILABLE_BYTES
    AUTH_AUDIT_PARTITION_DISK_PATH
    AUTH_AUDIT_PARTITION_ALLOW_DATA_LOSS
  )
  for name in "${cutover_env_allowlist[@]}"; do
    if [[ -v "$name" ]]; then cutover_env_args+=(-e "$name"); fi
  done
  "${BASE[@]}" run --rm --no-deps "${cutover_env_args[@]}" seller-ml-web node apps/seller-ml/scripts/authAuditPartitionCutover.js "$action" "$@"
}

command="${1:-}"
if [[ "$#" -gt 0 ]]; then shift; fi
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
  audit-partition-status)
    run_audit_partition_cutover status "$@"
    ;;
  audit-partition-preflight)
    run_audit_partition_cutover preflight "$@"
    ;;
  audit-partition-release-preflight)
    run_audit_partition_cutover preflight --release-legacy "$@"
    ;;
  audit-partition-copy)
    require_confirmation COPY
    run_audit_partition_cutover copy "$@"
    ;;
  audit-partition-verify)
    run_audit_partition_cutover verify "$@"
    ;;
  audit-partition-swap)
    require_confirmation SWAP
    run_audit_partition_cutover swap "$@"
    ;;
  audit-partition-rollback)
    require_confirmation ROLLBACK
    if [[ "${AUTH_AUDIT_PARTITION_ALLOW_DATA_LOSS:-}" == "YES" ]]; then
      echo "Rollback may discard writes made after the swap because AUTH_AUDIT_PARTITION_ALLOW_DATA_LOSS=YES." >&2
    fi
    run_audit_partition_cutover rollback "$@"
    ;;
  audit-partition-release-legacy)
    require_confirmation RELEASE_LEGACY
    run_audit_partition_cutover release-legacy "$@"
    ;;
  *) usage; [[ -n "$command" ]] && exit 1 || exit 0 ;;
esac
