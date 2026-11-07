#!/usr/bin/env bash
# One-time: move local dev from SQLite to Postgres on this Mac.
#   bash scripts/setup-local-postgres.sh
# Creates the database from .env's DATABASE_URL, creates the tables, loads the
# data exported from prisma/dev.sqlite, and checks every table's row count.
set -euo pipefail
cd "$(dirname "$0")/.."

say() { printf "\n\033[1m%s\033[0m\n" "$*"; }
fail() { printf "\n\033[31m✗ %s\033[0m\n" "$*"; exit 1; }

# Postgres.app's tools, if installed
[ -d "/Applications/Postgres.app/Contents/Versions/latest/bin" ] && export PATH="/Applications/Postgres.app/Contents/Versions/latest/bin:$PATH"

command -v psql >/dev/null || fail "psql not found. Install Postgres.app (postgresapp.com) or: brew install postgresql@17"

DATABASE_URL="$(grep -E '^DATABASE_URL=' .env | tail -1 | cut -d= -f2-)"
[ -n "$DATABASE_URL" ] || fail "No DATABASE_URL in .env"
export DATABASE_URL
DB_NAME="$(printf '%s' "$DATABASE_URL" | sed -E 's#^.*/([^/?]+)(\?.*)?$#\1#')"
ADMIN_URL="$(printf '%s' "$DATABASE_URL" | sed -E 's#/[^/?]+(\?.*)?$#/postgres#')"

say "1/5  Checking Postgres is running…"
psql "$ADMIN_URL" -Atqc "select 1" >/dev/null 2>&1 || fail "Can't connect with $ADMIN_URL
   Start Postgres (open Postgres.app, or: brew services start postgresql@17).
   If your Postgres user isn't '$(whoami)', change DATABASE_URL in .env (e.g. postgresql://postgres@localhost:5432/$DB_NAME)."
echo "   ✓ connected"

say "2/5  Creating database '$DB_NAME'…"
if psql "$ADMIN_URL" -Atqc "select 1 from pg_database where datname = '$DB_NAME'" | grep -q 1; then
  ROWS="$(psql "$DATABASE_URL" -Atqc "select count(*) from information_schema.tables where table_schema='public' and table_name='Shop'" 2>/dev/null || echo 0)"
  if [ "$ROWS" = "1" ] && [ "$(psql "$DATABASE_URL" -Atqc 'select count(*) from "Shop"')" != "0" ]; then
    fail "'$DB_NAME' already has data — looks like this already ran. Nothing changed. (npm run db:verify-import to check it.)"
  fi
  echo "   ✓ exists (empty)"
else
  psql "$ADMIN_URL" -qc "CREATE DATABASE \"$DB_NAME\"" && echo "   ✓ created"
fi

say "3/5  Creating tables…"
npx prisma generate >/dev/null
npx prisma migrate deploy 2>&1 | grep -E "applied|No pending|Error" || true

say "4/5  Loading your data from prisma/sqlite-export.sql…"
[ -f prisma/sqlite-export.sql ] || fail "prisma/sqlite-export.sql not found"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f prisma/sqlite-export.sql >/dev/null && echo "   ✓ loaded"

say "5/5  Checking every table…"
npm run -s db:verify-import

say "Done. Start the app as usual: shopify app dev"
echo "(You can delete prisma/sqlite-export.sql now — it holds store tokens and customer emails.)"
