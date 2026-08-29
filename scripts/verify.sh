#!/usr/bin/env bash
# Boot the server, wait for health, run the live smoke client, then stop. Exit code = smoke result.
set -uo pipefail
cd /mnt/c/Marat/OSaaS/ClaudeShared/oservices/fusion-schema-mcp

node dist/server.js > /tmp/mcp-server.log 2>&1 &
SRV=$!
echo "server pid=$SRV, waiting for health..."

ok=0
for i in $(seq 1 30); do
  if curl -sf http://127.0.0.1:8979/health > /tmp/mcp-health.json 2>/dev/null; then
    ok=1; break
  fi
  sleep 1
done

if [ "$ok" != "1" ]; then
  echo "SERVER DID NOT BECOME HEALTHY"
  echo "--- server log ---"; cat /tmp/mcp-server.log
  kill "$SRV" 2>/dev/null
  exit 1
fi

echo "--- /health ---"; cat /tmp/mcp-health.json; echo
echo "--- smoke ---"
node dist/smoke.js
RC=$?

kill "$SRV" 2>/dev/null
wait "$SRV" 2>/dev/null
echo "--- server log (tail) ---"; tail -n 20 /tmp/mcp-server.log
exit $RC
