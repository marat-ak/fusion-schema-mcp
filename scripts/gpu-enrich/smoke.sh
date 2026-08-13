#!/bin/bash
# Go/no-go for an HF Inference Endpoint (vLLM) BEFORE spending on the full run.
# Proves: endpoint reachable, token valid, and json_schema strict is actually enforced by the server.
# Run in WSL:
#   export HF_ENDPOINT_URL=https://xxxx.endpoints.huggingface.cloud   # safe to share; NOT secret
#   export HF_TOKEN=hf_xxxxxxxx                                       # secret; keep in the shell only
#   bash smoke.sh
set -u
: "${HF_ENDPOINT_URL:?set HF_ENDPOINT_URL}"
: "${HF_TOKEN:?set HF_TOKEN}"
BASE="${HF_ENDPOINT_URL%/}"
AUTH="Authorization: Bearer $HF_TOKEN"

echo "=== [1/3] wait for endpoint (scale-from-zero / init can take a few min) ==="
MODEL=""
for t in $(seq 1 60); do   # up to ~10 min
  MODEL=$(curl -s -m 15 -H "$AUTH" "$BASE/v1/models" \
          | python3 -c "import sys,json;print(json.load(sys.stdin)['data'][0]['id'])" 2>/dev/null) && [ -n "$MODEL" ] && break
  echo "  not ready yet ($t)…"; sleep 10
done
[ -n "$MODEL" ] || { echo "FAIL: /v1/models never returned a model (token wrong? endpoint failed to start? check the HF endpoint logs)"; exit 1; }
echo "  model = $MODEL"

echo "=== [2/3] chat/completions with json_schema strict ==="
REQ=$(python3 - "$MODEL" <<'PY'
import json, sys
schema = {"type": "object",
          "properties": {"description": {"type": "string"},
                         "intents": {"type": "array", "items": {"type": "string"}, "minItems": 3}},
          "required": ["description", "intents"]}
print(json.dumps({
    "model": sys.argv[1], "max_tokens": 400, "temperature": 0.1,
    "messages": [
        {"role": "system", "content": "You document SQL. Return ONE JSON object per the enforced schema."},
        {"role": "user", "content": "SELECT invoice_id, invoice_amount FROM ap_invoices_all WHERE org_id = 101 "
                                    "AND payment_status_flag = 'Y'. Give a business description and >=3 intents."}],
    "response_format": {"type": "json_schema",
                        "json_schema": {"name": "t", "schema": schema, "strict": True}}}))
PY
)
RESP=$(curl -s -m 120 -H "$AUTH" -H "Content-Type: application/json" -d "$REQ" "$BASE/v1/chat/completions") || {
  echo "FAIL: chat/completions request errored"; exit 1; }

echo "=== [3/3] validate the returned JSON obeys the schema ==="
echo "$RESP" | python3 - <<'PY' || { echo; echo "SMOKE FAIL — json_schema NOT enforced (or server error above). Do NOT launch the run."; exit 1; }
import sys, json
r = json.load(sys.stdin)
if "choices" not in r:
    print("  server payload:", json.dumps(r)[:400]); raise SystemExit(1)
txt = r["choices"][0]["message"]["content"]
o = json.loads(txt)                                   # must be valid JSON
assert isinstance(o.get("description"), str) and o["description"], "description missing/empty"
assert isinstance(o.get("intents"), list) and len(o["intents"]) >= 3, "intents < 3 (strict not honored)"
print("  OK — strict schema honored.")
print("  sample:", json.dumps(o, ensure_ascii=False)[:240])
PY
echo
echo "SMOKE PASS — endpoint + auth + json_schema all good. Safe to launch the waves."
