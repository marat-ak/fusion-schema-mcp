"""Isolate strict-json_schema (guided decode) overhead: send the SAME real prompts sequentially
WITH the schema vs WITHOUT, compare tok/s. Reuses the client's real SCHEMA + build_messages."""
import sys, json, time, os, urllib.request
sys.path.insert(0, ".")                            # run from /work (the mounted run folder)
from enrich_client import SCHEMA, build_messages   # real schema + prompt builder

BASE = os.environ["HF_ENDPOINT_URL"].rstrip("/") + "/v1/chat/completions"
H = {"Authorization": "Bearer " + os.environ["HF_TOKEN"], "Content-Type": "application/json"}
MODEL = os.environ.get("MODEL_NAME", "Qwen/Qwen3-Coder-30B-A3B-Instruct")
units = [json.loads(l) for l in open("enrich_input.view.w0.jsonl")][:4]


def call(u, use_schema):
    body = {"model": MODEL, "messages": build_messages(u), "max_tokens": 3000, "temperature": 0.1}
    if use_schema:
        body["response_format"] = {"type": "json_schema", "json_schema": {"name": "e", "schema": SCHEMA, "strict": True}}
    t = time.time()
    req = urllib.request.Request(BASE, data=json.dumps(body).encode(), headers=H, method="POST")
    r = json.load(urllib.request.urlopen(req, timeout=600))
    return time.time() - t, r.get("usage", {}).get("completion_tokens", 0)


for label, us in [("WITH json_schema", True), ("NO schema     ", False)]:
    dts, cts = [], []
    for u in units:
        dt, ct = call(u, us); dts.append(dt); cts.append(ct)
    print(f"{label}: {len(units)} reqs seq | {sum(dts)/len(dts):.1f}s/req | {sum(cts)} out-tok | {sum(cts)/sum(dts):.1f} tok/s")
