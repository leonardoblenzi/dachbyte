#!/bin/bash
set -euo pipefail
umask 077

: "${POSTGRES_USER:?POSTGRES_USER required}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD required}"

ACTION="${HUB_CUTOVER_ACTION:-snapshot}"
TARGET_DB="${DACHBYTE_HUB_DB:-dachbyte_hub}"
MIGRATOR_ROLE="${DACHBYTE_HUB_MIGRATION_ROLE:-dachbyte_hub_migrator}"
APP_ROLE="${DACHBYTE_HUB_APP_ROLE:-dachbyte_hub_app}"
BACKUP_DIR="${HUB_CUTOVER_BACKUP_DIR:-/backups}"
STATE_DIR="${HUB_CUTOVER_STATE_DIR:-/cutover-state}"

if [[ "$TARGET_DB" != "dachbyte_hub" ]]; then
  echo "[dach-hub:cutover-db] refusing target database other than dachbyte_hub: $TARGET_DB" >&2
  exit 2
fi
for role in "$MIGRATOR_ROLE" "$APP_ROLE"; do
  if [[ ! "$role" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
    echo "[dach-hub:cutover-db] invalid role: $role" >&2
    exit 2
  fi
done

export PGHOST="${PGHOST:-postgres}"
export PGPORT="${PGPORT:-5432}"
export PGUSER="$POSTGRES_USER"
export PGPASSWORD="$POSTGRES_PASSWORD"
export PGDATABASE="${POSTGRES_DB:-postgres}"

admin_psql() { psql --set=ON_ERROR_STOP=1 "$@"; }
require_state() {
  local marker="$1"
  if [[ ! -f "$STATE_DIR/$marker" ]]; then
    echo "[dach-hub:cutover-db] missing cutover marker: $marker" >&2
    exit 2
  fi
}

apply_runtime_grants() {
  PGDATABASE="$TARGET_DB" admin_psql --set=hub_migrator="$MIGRATOR_ROLE" --set=hub_app="$APP_ROLE" <<'SQL'
REVOKE ALL ON SCHEMA public FROM PUBLIC;
SELECT format('GRANT USAGE ON SCHEMA public TO %I', :'hub_app') \gexec
SELECT format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I', :'hub_app') \gexec
SELECT format('GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO %I', :'hub_app') \gexec
SELECT format('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO %I', :'hub_app') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', :'hub_migrator', :'hub_app') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO %I', :'hub_migrator', :'hub_app') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO %I', :'hub_migrator', :'hub_app') \gexec
SQL
}

if [[ "$ACTION" == "snapshot" ]]; then
  : "${SOURCE_DATABASE_URL:?SOURCE_DATABASE_URL required}"
  if [[ "${CONFIRM_HUB_FINAL_SNAPSHOT:-NO}" != "YES" ]]; then
    echo "[dach-hub:cutover-db] CONFIRM_HUB_FINAL_SNAPSHOT=YES required" >&2
    exit 2
  fi
  require_state "commercial-freeze.confirmed"
  require_state "old-scheduler-disabled.confirmed"
  require_state "asaas-queue-paused.confirmed"

  mkdir -p "$BACKUP_DIR" "$STATE_DIR"
  chmod 700 "$BACKUP_DIR" "$STATE_DIR" || true
  STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
  DUMP_FILE="$BACKUP_DIR/dach-hub-final-${STAMP}.dump"
  SHA_FILE="${DUMP_FILE}.sha256"
  SOURCE_DB_NAME="$(psql "$SOURCE_DATABASE_URL" --set=ON_ERROR_STOP=1 --tuples-only --no-align --command='SELECT current_database()')"

  echo "[dach-hub:cutover-db] creating final consistent dump from source database: $SOURCE_DB_NAME"
  pg_dump --format=custom --no-owner --no-privileges "$SOURCE_DATABASE_URL" --file "$DUMP_FILE"
  sha256sum "$DUMP_FILE" | tee "$SHA_FILE"
  {
    echo "HUB_CUTOVER_DUMP_FILE=$DUMP_FILE"
    echo "HUB_CUTOVER_DUMP_SHA_FILE=$SHA_FILE"
    echo "HUB_CUTOVER_SOURCE_DATABASE=$SOURCE_DB_NAME"
    echo "HUB_CUTOVER_SNAPSHOT_AT=$STAMP"
  } > "$BACKUP_DIR/latest.env"
  chmod 600 "$BACKUP_DIR/latest.env" "$SHA_FILE" || true
  touch "$STATE_DIR/final-snapshot.confirmed"
  echo "[dach-hub:cutover-db] final snapshot ready: $DUMP_FILE"
  exit 0
fi

if [[ "$ACTION" == "restore" ]]; then
  if [[ "${CONFIRM_HUB_PRODUCTION_RESTORE:-NO}" != "YES" ]]; then
    echo "[dach-hub:cutover-db] CONFIRM_HUB_PRODUCTION_RESTORE=YES required" >&2
    exit 2
  fi
  for marker in commercial-freeze.confirmed old-scheduler-disabled.confirmed asaas-queue-paused.confirmed final-snapshot.confirmed; do
    require_state "$marker"
  done
  if [[ ! -f "$BACKUP_DIR/latest.env" ]]; then
    echo "[dach-hub:cutover-db] latest.env not found" >&2
    exit 2
  fi
  # shellcheck disable=SC1090
  source "$BACKUP_DIR/latest.env"
  : "${HUB_CUTOVER_DUMP_FILE:?dump file missing from latest.env}"
  : "${HUB_CUTOVER_DUMP_SHA_FILE:?sha file missing from latest.env}"
  [[ -f "$HUB_CUTOVER_DUMP_FILE" && -f "$HUB_CUTOVER_DUMP_SHA_FILE" ]] || {
    echo "[dach-hub:cutover-db] dump or sha file missing" >&2; exit 2;
  }
  (cd "$(dirname "$HUB_CUTOVER_DUMP_FILE")" && sha256sum --check "$(basename "$HUB_CUTOVER_DUMP_SHA_FILE")")

  admin_psql --set=db_name="$TARGET_DB" <<'SQL'
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname = :'db_name' AND pid <> pg_backend_pid();
SELECT format('DROP DATABASE IF EXISTS %I', :'db_name') \gexec
SQL
  createdb --owner="$MIGRATOR_ROLE" "$TARGET_DB"
  admin_psql --command="REVOKE CONNECT, TEMPORARY ON DATABASE \"${TARGET_DB}\" FROM PUBLIC;"
  admin_psql --command="GRANT CONNECT ON DATABASE \"${TARGET_DB}\" TO \"${APP_ROLE}\";"

  echo "[dach-hub:cutover-db] restoring final dump into $TARGET_DB"
  pg_restore --exit-on-error --no-owner --no-privileges --role="$MIGRATOR_ROLE" --dbname="$TARGET_DB" "$HUB_CUTOVER_DUMP_FILE"
  apply_runtime_grants
  PGDATABASE="$TARGET_DB" admin_psql --command="ANALYZE;"
  touch "$STATE_DIR/database-restored.confirmed"
  echo "[dach-hub:cutover-db] production target restored. Scheduler/webhook remain gated by cutover state."
  exit 0
fi

echo "[dach-hub:cutover-db] unsupported action: $ACTION" >&2
exit 2
