#!/bin/bash
set -euo pipefail
umask 077
: "${PGHOST:?PGHOST required}"
: "${PGUSER:?PGUSER required}"
: "${PGPASSWORD:?PGPASSWORD required}"
: "${RESTIC_REPOSITORY:?RESTIC_REPOSITORY required}"
: "${RESTIC_PASSWORD:?RESTIC_PASSWORD required}"
# restic repository initialization is an explicit one-time operation.
restic snapshots >/dev/null
backup_dir=$(mktemp -d /tmp/dachbyte-backup.XXXXXX)
trap 'rm -r -- "$backup_dir"' EXIT
pg_dumpall --globals-only > "$backup_dir/globals.sql"
psql -d postgres -At -c "SELECT datname FROM pg_database WHERE NOT datistemplate AND datname <> 'postgres' ORDER BY datname" > "$backup_dir/databases.txt"
number=0
while IFS= read -r database; do
  number=$((number + 1))
  pg_dump --dbname="$database" --format=custom --create --file="$backup_dir/$number.dump"
  pg_restore --list "$backup_dir/$number.dump" >/dev/null
done < "$backup_dir/databases.txt"
restic backup --tag dachbyte "$backup_dir" /uploads /ml-results
restic check
# Retention/pruning is intentionally a separate operational command.
