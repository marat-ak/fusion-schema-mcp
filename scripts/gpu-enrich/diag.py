"""One-shot HF endpoint diagnostic. Reads env HF_ENDPOINT_URL / HF_TOKEN.
Prints HTTP status + body for: /v1/models, a basic chat, and a json_schema chat.
Isolates 'engine dead' (basic fails) vs 'schema unsupported' (basic ok, schema fails)."""
import json, os, urllib.request, urllib.error

BASE = os.environ["HF_ENDPOINT_URL"].rstrip("/")
TOK = os.environ["HF_TOKEN"]
H = {"Authorization": f"Bearer {TOK}", "Content-Type": "application/json"}


def call(path, body=None, timeout=120):
    url = BASE + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers=H, method="POST" if data else "GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as e:
        return -1, f"{type(e).__name__}: {e}"


print("=== /v1/models ===")
st, body = call("/v1/models", timeout=30)
print("HTTP", st, "\n", body[:500])
model = "unknown"
try:
    model = json.loads(body)["data"][0]["id"]
except Exception:
    pass
print("MODEL =", model)

print("\n=== basic chat (no schema) ===")
st, body = call("/v1/chat/completions", {
    "model": model, "max_tokens": 20, "temperature": 0.1,
    "messages": [{"role": "user", "content": "say hi in 3 words"}]})
print("HTTP", st, "\n", body[:800])

print("\n=== json_schema chat ===")
schema = {"type": "object",
          "properties": {"description": {"type": "string"},
                         "intents": {"type": "array", "items": {"type": "string"}, "minItems": 3}},
          "required": ["description", "intents"]}
st, body = call("/v1/chat/completions", {
    "model": model, "max_tokens": 300, "temperature": 0.1,
    "messages": [{"role": "user", "content": "SELECT invoice_id FROM ap_invoices WHERE org_id=101. "
                                             "Give a description and >=3 intents."}],
    "response_format": {"type": "json_schema",
                        "json_schema": {"name": "t", "schema": schema, "strict": True}}})
print("HTTP", st, "\n", body[:800])
