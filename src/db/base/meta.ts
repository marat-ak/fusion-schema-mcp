import type { MetaApi } from "../provider.js";
import type { Versions } from "../types.js";
import type { BaseProvider } from "./provider.js";

/** `meta` k/v table (version stamps + the /health counters written at compile time). */
export class BaseMeta implements MetaApi {
  constructor(protected p: BaseProvider) {}

  async versions(): Promise<Versions | null> {
    const rows = await this.p.q<{ key: string; value: string }>(
      `SELECT key, value FROM ${this.p.t("meta")} WHERE key IN ('schema_version','queries_version','embedding_version')`,
    );
    const m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    if (m.schema_version == null && m.queries_version == null && m.embedding_version == null) return null;
    return { schema: m.schema_version ?? "", queries: m.queries_version ?? "", embedding: m.embedding_version ?? "" };
  }

  async set(key: string, value: string): Promise<void> {
    await this.p.run(
      `INSERT INTO ${this.p.t("meta")} (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      [key, value],
    );
  }

  async setVersions(v: Versions): Promise<void> {
    await this.set("schema_version", v.schema);
    await this.set("queries_version", v.queries);
    await this.set("embedding_version", v.embedding);
  }

  async stats(): Promise<Record<string, string>> {
    const rows = await this.p.q<{ key: string; value: string }>(`SELECT key, value FROM ${this.p.t("meta")}`);
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  activeVersion(): string { return ""; }

  /** DDL is provider-owned (the base has no portable CREATE for vec/fts tables). */
  async ensureDdl(): Promise<void> { throw new Error("ensureDdl: provider must implement"); }
  async ensureIndexes(): Promise<void> { throw new Error("ensureIndexes: provider must implement"); }
  async finalizeBuild(): Promise<void> { /* no-op unless the provider has a bulk-build mode */ }
}
