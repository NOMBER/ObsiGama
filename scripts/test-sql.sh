#!/usr/bin/env bash
# Applies the migrations to a scratch database with a Supabase stub and runs the smoke tests.
# Needs a running Postgres 15+; set PGHOST/PGPORT/PGUSER (superuser) as usual.
set -euo pipefail
cd "$(dirname "$0")/.."
DB=${TEST_DB:-s_platform_test}
psql -v ON_ERROR_STOP=1 -q -d postgres -c "drop database if exists $DB" -c "create database $DB"
psql -v ON_ERROR_STOP=1 -q -d "$DB" -f supabase/tests/stub_supabase.sql
for f in supabase/migrations/*.sql; do psql -v ON_ERROR_STOP=1 -q -d "$DB" -f "$f" >/dev/null; done
psql -v ON_ERROR_STOP=1 -q -d "$DB" -f supabase/tests/smoke.sql
