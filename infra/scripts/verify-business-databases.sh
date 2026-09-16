#!/bin/bash
set -euo pipefail

check_runtime() {
  local label="$1"
  local url="$2"
  local marker="$3"

  echo "[verify] ${label}"
  local user safe marker_ok
  user="$(psql "$url" --set=ON_ERROR_STOP=1 --tuples-only --no-align --command='SELECT current_user' | tr -d '[:space:]')"
  safe="$(psql "$url" --set=ON_ERROR_STOP=1 --tuples-only --no-align --command="SELECT (NOT rolsuper AND NOT rolbypassrls) FROM pg_roles WHERE rolname=current_user" | tr -d '[:space:]')"
  marker_ok="$(psql "$url" --set=ON_ERROR_STOP=1 --tuples-only --no-align --command="SELECT to_regclass('${marker}') IS NOT NULL" | tr -d '[:space:]')"

  [[ "$safe" == "t" ]] || { echo "[verify] FAIL ${label}: runtime role ${user} is SUPERUSER/BYPASSRLS or could not be validated." >&2; exit 1; }
  [[ "$marker_ok" == "t" ]] || { echo "[verify] FAIL ${label}: migration marker ${marker} not found/visible." >&2; exit 1; }
  echo "[verify] OK ${label}: user=${user}, role_safe=true, marker=${marker}"
}

: "${RUNTIME_CHAT_DATABASE_URL:?RUNTIME_CHAT_DATABASE_URL required}"
: "${RUNTIME_CORE_DATABASE_URL:?RUNTIME_CORE_DATABASE_URL required}"
: "${RUNTIME_STOCK_DATABASE_URL:?RUNTIME_STOCK_DATABASE_URL required}"
: "${RUNTIME_PRICE_DATABASE_URL:?RUNTIME_PRICE_DATABASE_URL required}"

check_runtime chat "$RUNTIME_CHAT_DATABASE_URL" "schema_migrations"
check_runtime core "$RUNTIME_CORE_DATABASE_URL" "volt_core.migrations"
check_runtime stock "$RUNTIME_STOCK_DATABASE_URL" "schema_migrations"
check_runtime price "$RUNTIME_PRICE_DATABASE_URL" "volt_price.migrations"

echo "[verify] Business runtime database connections are safe and migration markers are visible."
