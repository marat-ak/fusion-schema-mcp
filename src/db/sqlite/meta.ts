import { BaseMeta } from "../base/meta.js";
import type { SqliteProvider } from "./provider.js";
import { DDL_SCHEMA, DDL_REPORTS, DDL_ENRICH, DDL_CACHE, DDL_FACTS, DDL_SCHEMA_INDEXES } from "./ddl.js";

export class SqliteMeta extends BaseMeta {
  constructor(protected p: SqliteProvider) { super(p); }

  /** Every CREATE ... IF NOT EXISTS block of the five files; WAL for the three write-heavy side files. */
  async ensureDdl(): Promise<void> {
    const d = this.p.d;
    d.exec(DDL_SCHEMA);
    d.exec(DDL_REPORTS);
    for (const [name, ddl] of [["enrichdb", DDL_ENRICH], ["cachedb", DDL_CACHE], ["factsdb", DDL_FACTS]] as const) {
      if (!this.p.attached.has(name)) continue;
      if (!this.p.cfg.build) d.pragma(`${name}.journal_mode = WAL`);
      d.exec(ddl);
    }
  }

  async ensureIndexes(): Promise<void> {
    this.p.d.exec(DDL_SCHEMA_INDEXES);
  }

  /** End of a bulk build: back to a normal journal, compact, gather planner stats. */
  async finalizeBuild(): Promise<void> {
    const d = this.p.d;
    d.pragma("main.journal_mode = DELETE");
    d.pragma("schemadb.journal_mode = DELETE");
    d.exec("VACUUM");
    d.exec("VACUUM schemadb");
    d.exec("ANALYZE");
  }
}
