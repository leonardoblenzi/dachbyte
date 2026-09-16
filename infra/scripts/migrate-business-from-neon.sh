#!/bin/bash
set -euo pipefail
umask 077

: "${CONFIRM_BUSINESS_DB_IMPORT:?Set CONFIRM_BUSINESS_DB_IMPORT=YES after reviewing the migration env}"
if [[ "${CONFIRM_BUSINESS_DB_IMPORT}" != "YES" ]]; then
  echo "Import blocked. Set CONFIRM_BUSINESS_DB_IMPORT=YES only for the planned cutover." >&2
  exit 1
fi

for name in CHAT CORE STOCK PRICE; do
  src_var="SOURCE_${name}_DATABASE_URL"
  dst_var="TARGET_${name}_DATABASE_URL"
  : "${!src_var:?${src_var} required}"
  : "${!dst_var:?${dst_var} required}"
  case "${!dst_var}" in
    *"@postgres:"*|*"@postgres/"*) ;;
    *) echo "${dst_var} must point to the internal postgres service, not an external host." >&2; exit 1 ;;
  esac
done

BACKUP_ROOT="${MIGRATION_BACKUP_DIR:-/migration-backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
RUN_DIR="${BACKUP_ROOT}/neon-import-${STAMP}"
mkdir -p "$RUN_DIR"

count_user_relations() {
  local url="$1"
  psql "$url" --set=ON_ERROR_STOP=1 --tuples-only --no-align --command="
    SELECT count(*)
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname !~ '^pg_toast'
      AND c.relkind IN ('r','p','v','m','S','f');
  " | tr -d '[:space:]'
}

echo "[import] 1/3 creating verified Neon dumps in ${RUN_DIR}"
for name in CHAT CORE STOCK PRICE; do
  src_var="SOURCE_${name}_DATABASE_URL"
  lower="$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]')"
  dump_file="${RUN_DIR}/${lower}.dump"
  pg_dump --dbname="${!src_var}" --format=custom --no-owner --no-acl --file="$dump_file"
  pg_restore --list "$dump_file" >/dev/null
  echo "[import] dump verified: ${lower}.dump"
done
(cd "$RUN_DIR" && sha256sum ./*.dump > SHA256SUMS)

if [[ "${ALLOW_NONEMPTY_TARGET:-NO}" != "YES" ]]; then
  echo "[import] 2/3 verifying all local targets are empty"
  for name in CHAT CORE STOCK PRICE; do
    dst_var="TARGET_${name}_DATABASE_URL"
    count="$(count_user_relations "${!dst_var}")"
    if [[ "$count" != "0" ]]; then
      echo "Target ${name} is not empty (${count} user relation(s)). Import aborted before restore." >&2
      echo "Use a fresh database/volume. ALLOW_NONEMPTY_TARGET=YES is reserved for an explicitly reviewed recovery." >&2
      exit 1
    fi
  done
else
  echo "[import] WARNING: ALLOW_NONEMPTY_TARGET=YES; restore may conflict with existing objects."
fi

echo "[import] 3/3 restoring dumps to local PostgreSQL"
for name in CHAT CORE STOCK PRICE; do
  dst_var="TARGET_${name}_DATABASE_URL"
  lower="$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]')"
  dump_file="${RUN_DIR}/${lower}.dump"
  pg_restore --dbname="${!dst_var}" --no-owner --no-acl --exit-on-error --single-transaction "$dump_file"
  echo "[import] restored: ${lower}"
done

cat > "${RUN_DIR}/IMPORT_OK" <<TXT
completed_at_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)
source=Neon PostgreSQL
target=VPS PostgreSQL service postgres
migrations_applied_after_restore=false
TXT

echo "[import] restore completed. Dumps remain at ${RUN_DIR}. Run the explicit migration phase next."
