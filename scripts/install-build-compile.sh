#!/usr/bin/env bash
# Install deps, build TS, compile the SQLite catalog. Run in the CloudBeaver WSL distro.
set -euo pipefail
cd /mnt/c/Marat/OSaaS/ClaudeShared/CloudBeaver/fusion-schema-mcp

echo "=== npm install ==="
npm install

echo "=== build (tsc) ==="
npm run build

echo "=== compile catalog ==="
node dist/compile.js

echo "=== catalog file ==="
ls -la catalog.sqlite
echo ALL_DONE
