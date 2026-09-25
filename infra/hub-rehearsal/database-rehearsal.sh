#!/bin/bash
set -euo pipefail
umask 077

: "${POSTGRES_USER:?POSTGRES_USER required}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD required}"
: "${CONFIRM_HUB_REHEARSAL_RESET:?CONFIRM_HUB_REHEARSAL_RESET required}"

ACTION="${HUB_REHEARSAL_ACTION:-prepare}"
TARGET_DB="${DACHBYTE_HUB_REHEARSAL_DB:-dachbyte_hub_rehearsal}"
SNAPSHOT_DB="${DACHBYTE_HUB_REHEARSAL_SNAPSHOT_DB:-dachbyte_hub_source_rehearsal}"
MIGRATOR_ROLE="${DACHBYTE_HUB_REHEARSAL_MIGRATION_ROLE:-dachbyte_hub_rehearsal_migrator}"
APP_ROLE="${DACHBYTE_HUB_REHEARSAL_APP_ROLE:-dachbyte_hub_rehearsal_app}"
MIGRATOR_PASSWORD="${DACHBYTE_HUB_REHEARSAL_MIGRATION_DB_PASSWORD:-}"
APP_PASSWORD="${DACHBYTE_HUB_REHEARSAL_APP_DB_PASSWORD:-}"
BACKUP_DIR="${HUB_REHEARSAL_BACKUP_DIR:-/backups}"

if [[ "${CONFIRM_HUB_REHEARSAL_RESET}" != "YES" ]]; then
  echo "[dach-hub:rehearsal] CONFIRM_HUB_REHEARSAL_RESET=YES required" >&2
  exit 2
fi
for database in "$TARGET_DB" "$SNAPSHOT_DB"; do
  if [[ ! "$database" =~ ^[A-Za-z_][A-Za-z0-9_]*_rehearsal$ ]]; then
    echo "[dach-hub:rehearsal] every temporary database must end in _rehearsal: $database" >&2
    exit 2
  fi
  if [[ "$database" == "dachbyte_hub" ]]; then
    echo "[dach-hub:rehearsal] refusing production database name" >&2
    exit 2
  fi
done
if [[ "$TARGET_DB" == "$SNAPSHOT_DB" ]]; then
  echo "[dach-hub:rehearsal] snapshot and target databases must differ" >&2
  exit 2
fi
for value in "$MIGRATOR_ROLE" "$APP_ROLE"; do
  if [[ ! "$value" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
    echo "[dach-hub:rehearsal] invalid role name: $value" >&2
    exit 2
  fi
done
if [[ -z "$MIGRATOR_PASSWORD" || -z "$APP_PASSWORD" ]]; then
  echo "[dach-hub:rehearsal] rehearsal role passwords required" >&2
  exit 2
fi

export PGHOST="${PGHOST:-postgres}"
export PGPORT="${PGPORT:-5432}"
export PGUSER="$POSTGRES_USER"
export PGPASSWORD="$POSTGRES_PASSWORD"
export PGDATABASE="${POSTGRES_DB:-postgres}"

admin_psql() {
  psql --set=ON_ERROR_STOP=1 "$@"
}

ensure_role() {
  local role="$1"
  local password="$2"
  admin_psql --set=role_name="$role" --set=role_password="$password" <<'SQL'
SELECT format(
  'CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD %L',
  :'role_name', :'role_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'role_name')
\gexec
SELECT format(
  'ALTER ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD %L',
  :'role_name', :'role_password'
)
\gexec
SQL
}

reset_database() {
  local database="$1"
  admin_psql --set=db_name="$database" <<'SQL'
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname = :'db_name' AND pid <> pg_backend_pid();
SELECT format('DROP DATABASE IF EXISTS %I', :'db_name') \gexec
SQL
  createdb --owner="$MIGRATOR_ROLE" "$database"
  admin_psql --command="REVOKE CONNECT, TEMPORARY ON DATABASE \"${database}\" FROM PUBLIC;"
  admin_psql --command="GRANT CONNECT ON DATABASE \"${database}\" TO \"${APP_ROLE}\";"
}

apply_runtime_grants() {
  local database="$1"
  PGDATABASE="$database" admin_psql \
    --set=hub_migrator="$MIGRATOR_ROLE" \
    --set=hub_app="$APP_ROLE" <<'SQL'
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

destroy_database() {
  local database="$1"
  admin_psql --set=db_name="$database" <<'SQL'
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname = :'db_name' AND pid <> pg_backend_pid();
SELECT format('DROP DATABASE IF EXISTS %I', :'db_name') \gexec
SQL
}

if [[ "$ACTION" == "destroy" ]]; then
  echo "[dach-hub:rehearsal] destroying temporary databases only"
  destroy_database "$TARGET_DB"
  destroy_database "$SNAPSHOT_DB"
  echo "[dach-hub:rehearsal] temporary databases removed"
  exit 0
fi

if [[ "$ACTION" != "prepare" ]]; then
  echo "[dach-hub:rehearsal] unsupported action: $ACTION" >&2
  exit 2
fi
: "${SOURCE_DATABASE_URL:?SOURCE_DATABASE_URL required for prepare}"

if [[ "$SOURCE_DATABASE_URL" == *"pooler"* ]]; then
  echo "[dach-hub:rehearsal] warning: source URL looks like a pooler; prefer the direct PostgreSQL endpoint for pg_dump" >&2
fi

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR" || true
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DUMP_FILE="$BACKUP_DIR/dach-hub-rehearsal-${STAMP}.dump"
SHA_FILE="${DUMP_FILE}.sha256"

SOURCE_DB_NAME="$(psql "$SOURCE_DATABASE_URL" --set=ON_ERROR_STOP=1 --tuples-only --no-align --command='SELECT current_database()')"
echo "[dach-hub:rehearsal] source database: ${SOURCE_DB_NAME}"
echo "[dach-hub:rehearsal] creating consistent custom-format dump"
pg_dump --format=custom --no-owner --no-privileges "$SOURCE_DATABASE_URL" --file "$DUMP_FILE"
sha256sum "$DUMP_FILE" | tee "$SHA_FILE"

ensure_role "$MIGRATOR_ROLE" "$MIGRATOR_PASSWORD"
ensure_role "$APP_ROLE" "$APP_PASSWORD"

for database in "$SNAPSHOT_DB" "$TARGET_DB"; do
  echo "[dach-hub:rehearsal] restoring dump into temporary database: $database"
  reset_database "$database"
  PGUSER="$MIGRATOR_ROLE" \
  PGPASSWORD="$MIGRATOR_PASSWORD" \
  PGDATABASE="$database" \
    pg_restore --exit-on-error --no-owner --no-privileges --dbname="$database" "$DUMP_FILE"
  apply_runtime_grants "$database"
  PGDATABASE="$database" admin_psql --command="ANALYZE;"
done

{
  echo "HUB_REHEARSAL_DUMP_FILE=$DUMP_FILE"
  echo "HUB_REHEARSAL_DUMP_SHA_FILE=$SHA_FILE"
  echo "HUB_REHEARSAL_SOURCE_DATABASE=$SOURCE_DB_NAME"
  echo "HUB_REHEARSAL_SNAPSHOT_DATABASE=$SNAPSHOT_DB"
  echo "HUB_REHEARSAL_TARGET_DATABASE=$TARGET_DB"
  echo "HUB_REHEARSAL_PREPARED_AT=$STAMP"
} > "$BACKUP_DIR/latest.env"
chmod 600 "$BACKUP_DIR/latest.env" || true

echo "[dach-hub:rehearsal] restore complete into snapshot + migration target; dump and SHA-256 are under $BACKUP_DIR"
