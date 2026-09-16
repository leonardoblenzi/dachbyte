#!/bin/bash
set -euo pipefail
umask 077

for name in CHAT CORE STOCK PRICE; do
  var="TARGET_${name}_DATABASE_URL"
  : "${!var:?${var} required}"
  case "${!var}" in
    *"@postgres:"*|*"@postgres/"*) ;;
    *) echo "${var} must point to the internal postgres service." >&2; exit 1 ;;
  esac
done

BACKUP_ROOT="${MIGRATION_BACKUP_DIR:-/migration-backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
RUN_DIR="${BACKUP_ROOT}/pre-migrate-${STAMP}"
mkdir -p "$RUN_DIR"

for name in CHAT CORE STOCK PRICE; do
  var="TARGET_${name}_DATABASE_URL"
  lower="$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]')"
  dump_file="${RUN_DIR}/${lower}.dump"
  pg_dump --dbname="${!var}" --format=custom --no-owner --no-acl --file="$dump_file"
  pg_restore --list "$dump_file" >/dev/null
  echo "[snapshot] verified: ${lower}.dump"
done
(cd "$RUN_DIR" && sha256sum ./*.dump > SHA256SUMS)

echo "[snapshot] local pre-migration backup completed: ${RUN_DIR}"
