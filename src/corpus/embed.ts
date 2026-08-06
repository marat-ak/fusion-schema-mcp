/**
 * Embedding front — proxies to a worker_thread (embedWorker.ts) so ONNX inference NEVER blocks
 * the main event loop (see the worker header for the failure mode this fixes). The worker is
 * created lazily on first use and restarted automatically if it dies.
 */
import { Worker } from "node:worker_threads";

export const EMBED_DIM = 384;

/** One worker channel = one serialized inference queue. TWO channels exist so that BULK ingest
 *  embedding (hundreds of rows per wave) can never queue-starve an INTERACTIVE query embed —
 *  that starvation is exactly what made findSimilarQueries/findLayoutPattern hit the SDK's 60s
 *  tool timeout during ingest waves. */
function makeChannel() {
  let _worker: Worker | null = null;
  let _seq = 0;
  const _pending = new Map<number, { resolve: (v: Float32Array[]) => void; reject: (e: Error) => void }>();

  function worker(): Worker {
    if (_worker) return _worker;
    _worker = new Worker(new URL("./embedWorker.js", import.meta.url));
    _worker.on("message", (msg: { id: number; vectors?: ArrayBuffer[]; error?: string }) => {
      const p = _pending.get(msg.id);
      if (!p) return;
      _pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error));
      else p.resolve((msg.vectors ?? []).map((b) => new Float32Array(b)));
    });
    _worker.on("error", (e) => {
      for (const p of _pending.values()) p.reject(e instanceof Error ? e : new Error(String(e)));
      _pending.clear();
      _worker = null; // next embed() call spawns a fresh worker
    });
    _worker.on("exit", (code) => {
      if (code !== 0) {
        const err = new Error(`embed worker exited with code ${code}`);
        for (const p of _pending.values()) p.reject(err);
        _pending.clear();
      }
      _worker = null;
    });
    _worker.unref(); // don't keep the process alive because of an idle embedder
    return _worker;
  }

  return async function run(texts: string[]): Promise<Float32Array[]> {
    if (!texts.length) return [];
    const id = ++_seq;
    return new Promise<Float32Array[]>((resolve, reject) => {
      _pending.set(id, { resolve, reject });
      worker().postMessage({ id, texts });
    });
  };
}

/** Interactive channel: query-time embeds (findSimilarQueries, findLayoutPattern, provisioning). */
export const embed = makeChannel();
/** Bulk channel: ingest/enrichment re-embedding — big batches, latency-insensitive. */
export const embedBulk = makeChannel();
