#!/usr/bin/env bash
# Copy the Fusion DB_SCHEMA source files into the project's data/ dir.
set -euo pipefail
SRC=/mnt/c/Marat/OSaaS/ClaudeShared/Bip/DB_SCHEMA
DST=/mnt/c/Marat/OSaaS/ClaudeShared/oservices/fusion-schema-mcp/data
mkdir -p "$DST"
cp -f "$SRC"/*.csv "$SRC"/*.json "$SRC"/*.md "$DST"/
echo COPY_DONE
ls -la "$DST"
