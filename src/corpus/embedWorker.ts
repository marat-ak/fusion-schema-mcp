/**
 * Embedding worker — bge-small ONNX inference runs HERE, off the main event loop.
 * The main thread (embed.ts) posts {id, texts}; we reply {id, vectors} with the Float32Array
 * buffers transferred. Model loads once, lazily, inside the worker.
 * WHY: transformer inference is CPU-bound; on the main thread it froze the HTTP server for
 * seconds-to-minutes (during OTBI ingest waves), which made /mcp initialize time out and the
 * Agent SDK mark fusion-schema "offline" for the WHOLE session.
 */
import { parentPort } from "node:worker_threads";
import { pipeline } from "@xenova/transformers";

let _extractor: any = null;
async function extractor() {
  if (!_extractor) _extractor = await pipeline("feature-extraction", "Xenova/bge-small-en-v1.5");
  return _extractor;
}

parentPort!.on("message", async (msg: { id: number; texts: string[] }) => {
  try {
    const ex = await extractor();
    const out: ArrayBuffer[] = [];
    for (const t of msg.texts) {
      const res = await ex(t, { pooling: "mean", normalize: true });
      out.push(Float32Array.from(res.data as Float32Array).buffer);
    }
    parentPort!.postMessage({ id: msg.id, vectors: out }, out);
  } catch (e: any) {
    parentPort!.postMessage({ id: msg.id, error: String(e?.message ?? e) });
  }
});
