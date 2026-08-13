"""Zero-GPU mock of an OpenAI /v1 endpoint with vLLM-like continuous batching:
up to --max-num-seqs requests are 'generated' concurrently (each sleeps ~ proportional to max_tokens,
with jitter for variable cost); excess queue. Lets us demo the client flow instantly while real vLLM pulls.
  python mock_server.py --port 8001 --max-num-seqs 32
"""
import asyncio, argparse, random
from aiohttp import web

ap = argparse.ArgumentParser()
ap.add_argument("--port", type=int, default=8001)
ap.add_argument("--max-num-seqs", type=int, default=32)
ap.add_argument("--tok-ms", type=float, default=6.0)   # ms per generated token
A = ap.parse_args()

sem = asyncio.Semaphore(A.max_num_seqs)                 # server-side batch cap (emulates max-num-seqs)

async def models(req):
    return web.json_response({"data": [{"id": "tiny", "object": "model"}]})

async def chat(req):
    body = await req.json()
    toks = int(body.get("max_tokens", 32))
    async with sem:                                    # up to max_num_seqs 'generate' concurrently
        await asyncio.sleep((toks * A.tok_ms + random.uniform(0, 20)) / 1000.0)
    return web.json_response({"choices": [{"message": {"content": '{"ok":true}'}}],
                             "usage": {"completion_tokens": toks}})

app = web.Application()
app.router.add_get("/v1/models", models)
app.router.add_post("/v1/chat/completions", chat)
print(f"mock OpenAI endpoint on http://127.0.0.1:{A.port} (max-num-seqs={A.max_num_seqs})", flush=True)
web.run_app(app, host="127.0.0.1", port=A.port, print=lambda *a: None)
