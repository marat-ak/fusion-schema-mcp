"""Flow emulator: proves the client keeps ~CONC requests continuously in flight (sliding window)
vs the current 2000-chunk gather that drains at each boundary. Measures in-flight-over-time.

Usage:
  python flow_client.py --mode sliding --n 300 --conc 32 --url http://127.0.0.1:8000/v1/chat/completions
  python flow_client.py --mode chunked --chunk 50   (emulates the OLD chunk-gather)
"""
import asyncio, aiohttp, time, argparse, random

ap = argparse.ArgumentParser()
ap.add_argument("--mode", choices=["sliding", "chunked", "pool"], default="sliding")
ap.add_argument("--n", type=int, default=300)
ap.add_argument("--conc", type=int, default=32)
ap.add_argument("--chunk", type=int, default=50)
ap.add_argument("--url", default="http://127.0.0.1:8000/v1/chat/completions")
ap.add_argument("--model", default="tiny")
A = ap.parse_args()

inflight = 0
samples = []   # (t, inflight)  sampled on every change
ok = err = 0
t0 = time.time()
def snap():
    samples.append((time.time() - t0, inflight))

async def one(session, sem, i):
    global inflight, ok, err
    async with sem:
        inflight += 1; snap()
        # variable cost so the chunk-drain (straggler stall) is visible
        toks = random.choice([16, 16, 16, 32, 64, 128])
        body = {"model": A.model,
                "messages": [{"role": "user", "content": f"Return a short JSON with id {i}. Pad the answer."}],
                "max_tokens": toks, "temperature": 0.0}
        try:
            async with session.post(A.url, json=body, timeout=aiohttp.ClientTimeout(total=180)) as r:
                await r.read()
                ok += 1 if r.status == 200 else 0
                err += 0 if r.status == 200 else 1
        except Exception:
            err += 1
        inflight -= 1; snap()

async def main():
    sem = asyncio.Semaphore(A.conc)
    async with aiohttp.ClientSession() as s:
        if A.mode == "pool":                                     # WORKER POOL: only CONC coroutines alive
            it = iter(range(A.n))
            async def worker():
                while True:
                    try:
                        i = next(it)
                    except StopIteration:
                        return
                    await one(s, sem, i)
            await asyncio.gather(*[worker() for _ in range(A.conc)])
        else:
            tasks = [one(s, sem, i) for i in range(A.n)]         # creates ALL N coroutines up front
            if A.mode == "chunked":
                for i in range(0, A.n, A.chunk):
                    await asyncio.gather(*tasks[i:i + A.chunk])   # OLD: barrier per chunk
            else:
                await asyncio.gather(*tasks)                      # sliding window (semaphore only)
    report()

def report():
    dur = time.time() - t0
    # bucket in-flight into B time buckets (time-weighted average)
    B = 60
    buckets = [0.0] * B; wsum = [0.0] * B
    for k in range(1, len(samples)):
        (ta, fa), (tb, _) = samples[k - 1], samples[k]
        b = min(B - 1, int(ta / dur * B)) if dur > 0 else 0
        buckets[b] += fa * (tb - ta); wsum[b] += (tb - ta)
    avg = [buckets[i] / wsum[i] if wsum[i] > 0 else 0 for i in range(B)]
    peak = max(f for _, f in samples) if samples else 0
    blocks = " .:-=+*#%@"   # 10 ASCII levels (Windows-console safe)
    spark = "".join(blocks[min(9, int(round(v / max(peak, 1) * 9)))] for v in avg)
    # drain metric: fraction of run time with in-flight < 50% of CONC (GPU starving)
    starve_t = sum(wsum[i] for i in range(B) if avg[i] < A.conc * 0.5)
    print(f"\nMODE={A.mode}  N={A.n}  CONC={A.conc}"
          + (f"  CHUNK={A.chunk}" if A.mode == "chunked" else "")
          + f"  dur={dur:.1f}s  ok={ok} err={err}")
    print(f"in-flight over time (peak {peak}, target {A.conc}):")
    print(f"  |{spark}|")
    print(f"  starved (<50% CONC): {100*starve_t/max(dur,1e-9):.0f}% of run   "
          f"throughput: {A.n/max(dur,1e-9):.1f} req/s")

asyncio.run(main())
