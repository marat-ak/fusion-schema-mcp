#!/usr/bin/env bash
# Run the live smoke client against an already-running server (e.g. the container on 8979).
set -euo pipefail
cd /mnt/c/Marat/OSaaS/ClaudeShared/CloudBeaver/fusion-schema-mcp
export MCP_URL="${MCP_URL:-http://127.0.0.1:8979/mcp}"
node dist/smoke.js
