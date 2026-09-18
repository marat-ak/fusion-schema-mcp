#!/bin/sh
# Gate: NO SQL and NO driver import outside src/db (the catalog DB-access library).
# Runs first in `npm test` (and CI). Plan: docs/superpowers/plans/2026-09-18-fusion-db-access-library.md §2.1.
#   1. statement gate  — prepare(/exec( with a string literal, or a bare SELECT/INSERT/UPDATE/DELETE
#      keyword, anywhere in src/**/*.ts|*.mts except src/db/ (comment-only lines are skipped;
#      a regex `.exec(xml)` is not a statement).
#   2. driver gate     — imports of better-sqlite3 / sqlite-vec / postgres outside src/db/.
# EXEMPTIONS (explicit, one per line): src/migrate-split.ts — one-shot sqlite-only converter for a
# box still holding the pre-split catalog.sqlite; deleted in step 3 of the plan.
cd "$(dirname "$0")/.." || exit 2
EXEMPT='src/migrate-split.ts'
STMT='\.(prepare|exec)\([[:space:]]*[`"'"'"']|\b(SELECT|INSERT|UPDATE|DELETE)[[:space:]]'
DRV='from[[:space:]]+"(better-sqlite3|sqlite-vec|postgres)"'
hits=$(grep -rn -a -E "$STMT" src --include='*.ts' --include='*.mts' --exclude-dir=db \
  | grep -v -E "^($EXEMPT):" \
  | grep -v -E '^[^:]+:[0-9]+:[[:space:]]*(//|\*|/\*)')
drv=$(grep -rn -a -E "$DRV" src --include='*.ts' --include='*.mts' --exclude-dir=db | grep -v -E "^($EXEMPT):")
n=$(printf '%s' "$hits" | grep -c .); m=$(printf '%s' "$drv" | grep -c .)
echo "[no-sql-outside-db] statement hits outside src/db: $n (exempt: $EXEMPT)"
[ "$n" -gt 0 ] && printf '%s\n' "$hits"
echo "[no-sql-outside-db] driver imports outside src/db: $m"
[ "$m" -gt 0 ] && printf '%s\n' "$drv"
[ "$n" -eq 0 ] && [ "$m" -eq 0 ] && { echo "[no-sql-outside-db] PASS"; exit 0; }
echo "[no-sql-outside-db] FAIL"; exit 1
