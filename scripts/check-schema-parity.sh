#!/usr/bin/env bash
# Schema parity check: the generated Drizzle migrations and the hand-maintained
# reference DDL (docs/architecture/schema.sql) must produce structurally
# identical databases.
#
# Applies packages/db/migrations/*.sql (filename order — drizzle's 4-digit
# prefixes make lexical = journal order) and the reference schema to two fresh
# databases in a disposable postgres:16 container, then diffs
# `pg_dump --schema-only --no-owner` output. pg_dump 16.14+ emits
# per-invocation \restrict/\unrestrict nonce lines; those are stripped before
# diffing. SQL is piped over stdin (no `docker cp`) so the script works
# unchanged in Git Bash on Windows, where MSYS mangles /container/paths.
#
# Usage: bash scripts/check-schema-parity.sh
#   MIGRATIONS_DIR and REF_SCHEMA can be overridden via env (used by the
#   negative self-test; defaults are the repo paths).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATIONS_DIR="${MIGRATIONS_DIR:-$ROOT/packages/db/migrations}"
REF_SCHEMA="${REF_SCHEMA:-$ROOT/docs/architecture/schema.sql}"

CONTAINER="schema_parity_$$_$RANDOM"
WORKDIR="$(mktemp -d)"

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

# $1 = database name; SQL on stdin
psql_db() {
  docker exec -i "$CONTAINER" psql -U postgres -d "$1" -v ON_ERROR_STOP=1 -q
}

# $1 = database name; filtered schema dump on stdout
dump_db() {
  docker exec "$CONTAINER" pg_dump --schema-only --no-owner -U postgres "$1" |
    grep -vE '^\\(un)?restrict'
}

echo "Starting disposable postgres:16 container ($CONTAINER)..."
docker run --rm -d --name "$CONTAINER" -e POSTGRES_PASSWORD=x postgres:16 >/dev/null

ready=0
for _ in $(seq 1 60); do
  if docker exec "$CONTAINER" pg_isready -U postgres -q 2>/dev/null &&
    docker exec "$CONTAINER" psql -U postgres -qAt -c 'select 1' >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [ "$ready" != 1 ]; then
  echo "ERROR: postgres did not become ready within 60s" >&2
  exit 1
fi
# The image's init sequence restarts the server once; make sure it survived.
sleep 1
docker exec "$CONTAINER" psql -U postgres -qAt -c 'select 1' >/dev/null

docker exec "$CONTAINER" psql -U postgres -q -c 'CREATE DATABASE mig' -c 'CREATE DATABASE ref'

shopt -s nullglob
migrations=("$MIGRATIONS_DIR"/*.sql)
shopt -u nullglob
if [ "${#migrations[@]}" -eq 0 ]; then
  echo "ERROR: no .sql migrations found in $MIGRATIONS_DIR" >&2
  exit 1
fi

echo "Applying ${#migrations[@]} migration(s) to database 'mig'..."
for f in "${migrations[@]}"; do
  echo "  $(basename "$f")"
  psql_db mig <"$f"
done

echo "Applying $(basename "$REF_SCHEMA") to database 'ref'..."
psql_db ref <"$REF_SCHEMA"

dump_db mig >"$WORKDIR/mig.sql"
dump_db ref >"$WORKDIR/ref.sql"

if diff -u "$WORKDIR/mig.sql" "$WORKDIR/ref.sql" >"$WORKDIR/parity.diff"; then
  echo "OK: migrations and reference schema are structurally identical."
else
  echo "FAIL: schema parity broken (migrations vs $(basename "$REF_SCHEMA")):" >&2
  cat "$WORKDIR/parity.diff" >&2
  exit 1
fi
