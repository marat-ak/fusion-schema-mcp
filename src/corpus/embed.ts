import { pipeline } from "@xenova/transformers";

export const EMBED_DIM = 384;
let _extractor: any = null;

async function extractor() {
  if (!_extractor) _extractor = await pipeline("feature-extraction", "Xenova/bge-small-en-v1.5");
  return _extractor;
}

export async function embed(texts: string[]): Promise<Float32Array[]> {
  const ex = await extractor();
  const out: Float32Array[] = [];
  for (const t of texts) {
    const res = await ex(t, { pooling: "mean", normalize: true });
    out.push(Float32Array.from(res.data as Float32Array));
  }
  return out;
}
