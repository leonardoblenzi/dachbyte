#!/bin/bash
set -euo pipefail
umask 077

: "${POSTGRES_USER:?POSTGRES_USER required}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD required}"

export PGUSER="${POSTGRES_USER}"
export PGPASSWORD="${POSTGRES_PASSWORD}"
export PGDATABASE="${POSTGRES_DB:-postgres}"
export PGPORT="${PGPORT:-5432}"

# When executed by docker-entrypoint-initdb.d, use the local unix socket.
# When executed by the postgres-provision Compose service, connect to postgres.
if [[ -z "${PGHOST:-}" ]]; then
  if [[ -S /var/run/postgresql/.s.PGSQL.${PGPORT} ]]; then
    export PGHOST=/var/run/postgresql
  else
    export PGHOST=postgres
  fi
fi

CHAT_DB="${DACHBYTE_CHAT_DB:-dachbyte_chat}"
CORE_DB="${DACHBYTE_CORE_DB:-dachbyte_core}"
STOCK_DB="${DACHBYTE_STOCK_DB:-dachbyte_stock}"
PRICE_DB="${DACHBYTE_PRICE_DB:-dachbyte_price}"

CHAT_APP_ROLE="${DACHBYTE_CHAT_APP_ROLE:-dachbyte_chat_app}"
CORE_APP_ROLE="${DACHBYTE_CORE_APP_ROLE:-dachbyte_core_app}"
STOCK_MIGRATION_ROLE="${DACHBYTE_STOCK_MIGRATION_ROLE:-dachbyte_stock_migrator}"
STOCK_APP_ROLE="${DACHBYTE_STOCK_APP_ROLE:-dachbyte_stock_app}"
PRICE_MIGRATION_ROLE="${DACHBYTE_PRICE_MIGRATION_ROLE:-dachbyte_price_migrator}"
PRICE_APP_ROLE="${DACHBYTE_PRICE_APP_ROLE:-dachbyte_price_app}"

: "${DACHBYTE_CHAT_APP_DB_PASSWORD:?DACHBYTE_CHAT_APP_DB_PASSWORD required}"
: "${DACHBYTE_CORE_APP_DB_PASSWORD:?DACHBYTE_CORE_APP_DB_PASSWORD required}"
: "${DACHBYTE_STOCK_MIGRATION_DB_PASSWORD:?DACHBYTE_STOCK_MIGRATION_DB_PASSWORD required}"
: "${DACHBYTE_STOCK_APP_DB_PASSWORD:?DACHBYTE_STOCK_APP_DB_PASSWORD required}"
: "${DACHBYTE_PRICE_MIGRATION_DB_PASSWORD:?DACHBYTE_PRICE_MIGRATION_DB_PASSWORD required}"
: "${DACHBYTE_PRICE_APP_DB_PASSWORD:?DACHBYTE_PRICE_APP_DB_PASSWORD required}"

validate_identifier() {
  local value="$1"
  local label="$2"
  if [[ ! "$value" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
    echo "Invalid PostgreSQL identifier for ${label}: ${value}" >&2
    exit 1
  fi
}

for pair in \
  "$CHAT_DB:CHAT_DB" "$CORE_DB:CORE_DB" "$STOCK_DB:STOCK_DB" "$PRICE_DB:PRICE_DB" \
  "$CHAT_APP_ROLE:CHAT_APP_ROLE" "$CORE_APP_ROLE:CORE_APP_ROLE" \
  "$STOCK_MIGRATION_ROLE:STOCK_MIGRATION_ROLE" "$STOCK_APP_ROLE:STOCK_APP_ROLE" \
  "$PRICE_MIGRATION_ROLE:PRICE_MIGRATION_ROLE" "$PRICE_APP_ROLE:PRICE_APP_ROLE"; do
  validate_identifier "${pair%%:*}" "${pair##*:}"
done

ensure_role() {
  local role="$1"
  local password="$2"
  psql --set=ON_ERROR_STOP=1 --set=role_name="$role" --set=role_password="$password" <<'SQL'
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

ensure_database() {
  local database="$1"
  local owner="$2"
  if ! psql --set=ON_ERROR_STOP=1 --tuples-only --no-align \
      --command="SELECT 1 FROM pg_database WHERE datname = '${database}'" | grep -qx '1'; then
    createdb --owner="$owner" "$database"
    echo "[postgres] database created: ${database} (owner=${owner})"
  else
    psql --set=ON_ERROR_STOP=1 --command="ALTER DATABASE \"${database}\" OWNER TO \"${owner}\";"
    echo "[postgres] database already exists: ${database} (owner ensured=${owner})"
  fi
}

ensure_role "$CHAT_APP_ROLE" "$DACHBYTE_CHAT_APP_DB_PASSWORD"
ensure_role "$CORE_APP_ROLE" "$DACHBYTE_CORE_APP_DB_PASSWORD"
ensure_role "$STOCK_MIGRATION_ROLE" "$DACHBYTE_STOCK_MIGRATION_DB_PASSWORD"
ensure_role "$STOCK_APP_ROLE" "$DACHBYTE_STOCK_APP_DB_PASSWORD"
ensure_role "$PRICE_MIGRATION_ROLE" "$DACHBYTE_PRICE_MIGRATION_DB_PASSWORD"
ensure_role "$PRICE_APP_ROLE" "$DACHBYTE_PRICE_APP_DB_PASSWORD"

# Chat owns its database. Core migrations deliberately use the postgres admin role
# because the Core migrator provisions/hardens its separate NOBYPASSRLS app role.
ensure_database "$CHAT_DB" "$CHAT_APP_ROLE"
ensure_database "$CORE_DB" "$POSTGRES_USER"
ensure_database "$STOCK_DB" "$STOCK_MIGRATION_ROLE"
ensure_database "$PRICE_DB" "$PRICE_MIGRATION_ROLE"

psql --set=ON_ERROR_STOP=1 --command="GRANT CONNECT ON DATABASE \"${CORE_DB}\" TO \"${CORE_APP_ROLE}\";"
psql --set=ON_ERROR_STOP=1 --command="GRANT CONNECT ON DATABASE \"${STOCK_DB}\" TO \"${STOCK_APP_ROLE}\";"
psql --set=ON_ERROR_STOP=1 --command="GRANT CONNECT ON DATABASE \"${PRICE_DB}\" TO \"${PRICE_APP_ROLE}\";"

echo "[postgres] Business databases and roles provisioned successfully."
