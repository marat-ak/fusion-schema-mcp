#!/bin/sh
# Container entrypoint. CATALOG_DB (sqlite | postgres) is REQUIRED — no default, no fallback.
#   sqlite   -> provision.js seeds/upgrades DATA_DIR from SEED_DIR (zips + VERSION) before the server binds.
#   postgres -> straight to the server; nothing SQLite is touched, nothing is written under /app.
# Exec'd by /entry (setup V1): SETUP_URL/SERVICE_ID were already consumed; CATALOG_DB is bootstrap env.
set -e

case "${CATALOG_DB:-}" in
  sqlite)   node /app/dist/provision.js ;;
  postgres) ;;
  *) echo "[entrypoint] CATALOG_DB must be \"sqlite\" or \"postgres\" (got \"${CATALOG_DB:-}\") — required, no default" >&2; exit 1 ;;
esac

exec node /app/dist/server.js
