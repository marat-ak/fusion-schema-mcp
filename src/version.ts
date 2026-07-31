/**
 * Version triple that stamps the compiled/provisioned DBs and drives provision.ts upgrade decisions.
 * Sourced from a repo-root `VERSION` file (JSON), overridable per-key by env.
 *
 *   schema    — bump when the schema.sqlite table shape / catalog contents change → full replace.
 *   queries   — bump when the seeded otbi/view corpus changes → refresh those rows (keep bip-report).
 *   embedding — identifies the embedding model + dim + pipeline; bump forces a full re-embed + vec
 *               rebuild and wipes the column-cache. e.g. "bge-small-en-v1.5-384".
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

export interface Versions {
  schema: string;
  queries: string;
  embedding: string;
}

const DEFAULTS: Versions = { schema: "1", queries: "1", embedding: "bge-small-en-v1.5-384" };

/** Read the VERSION file (explicit path > $VERSION_FILE > repo-root VERSION), env keys override. */
export function readVersionFile(file?: string): Versions {
  const tried = [file, process.env.VERSION_FILE, path.join(ROOT, "VERSION"), path.join(ROOT, "..", "VERSION")]
    .filter((p): p is string => !!p);
  let v: Partial<Versions> = {};
  for (const p of tried) {
    try {
      v = JSON.parse(fs.readFileSync(p, "utf8")) as Partial<Versions>;
      break;
    } catch {
      /* try next candidate */
    }
  }
  return {
    schema: process.env.SCHEMA_VERSION ?? v.schema ?? DEFAULTS.schema,
    queries: process.env.QUERIES_VERSION ?? v.queries ?? DEFAULTS.queries,
    embedding: process.env.EMBEDDING_VERSION ?? v.embedding ?? DEFAULTS.embedding,
  };
}
