#!/usr/bin/env bash
# Install deps, build TS, compile the SQLite catalog. Run in the CloudBeaver WSL distro.
set -euo pipefail
cd /mnt/c/Marat/OSaaS/ClaudeShared/oservices/fusion-schema-mcp

echo "=== npm install ==="
npm install

echo "=== build (tsc) ==="
npm run build

echo "=== compile catalog ==="
node dist/compile.js

echo "=== seed files ==="
ls -la schema.sqlite reports.sqlite
echo ALL_DONE
