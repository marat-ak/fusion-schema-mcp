/**
 * SqliteProvider — ONE better-sqlite3 connection: reports.sqlite as MAIN (sqlite-vec vec0 KNN is only
 * reliable on a non-attached DB) + ATTACH schema.sqlite / enrich.sqlite / cache.sqlite / facts.sqlite.
 * Table names are unique across the five files; `t()` returns the `<db>.<table>` qualified name.
 *
 * The public API is async while better-sqlite3 is synchronous: every statement runs under ONE
 * promise mutex, and `tx()` holds that mutex for the whole callback (BEGIN IMMEDIATE … COMMIT).
 * Statements issued from inside the running transaction's async context (AsyncLocalStorage) run
 * directly; anything else queues behind it — so a foreign request can never interleave into an
 * open transaction. Provider-specific overrides use `syncTx()` (better-sqlite3's own transaction
 * wrapper, no awaits inside) for the hot bulk paths.
 */
import fs from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import Database from "better-sqlite3";
import { load as loadVec } from "sqlite-vec";
import { BaseProvider, type RunResult, type TableName } from "../base/provider.js";
import { BaseRegistries } from "../base/registries.js";
import { BaseRules } from "../base/rules.js";
import { BaseColCache } from "../base/colCache.js";
import { SqliteMeta } from "./meta.js";
import { SqliteSchema } from "./schema.js";
import { SqliteCorpus } from "./corpus.js";
import { SqliteLayout } from "./layout.js";
import { SqliteFlex } from "./flex.js";
import { SqliteEnrich } from "./enrich.js";
import { sqlQuote, type SqliteFiles } from "./paths.js";

export interface SqliteConfig {
  provider: "sqlite";
  files: SqliteFiles;
  /** create missing files (compile / provision / tests); default false = every configured file must exist */
  create?: boolean;
  /** bulk-build pragmas (journal OFF, synchronous OFF, big page cache) — compile.ts only */
  build?: boolean;
}

const DB_OF: Record<TableName, string> = {
  tables: "schemadb", columns: "schemadb", pkeys: "schemadb", fkeys: "schemadb", indexes: "schemadb",
  relationships: "schemadb", tables_fts: "schemadb", meta: "schemadb",
  report_queries: "main", report_queries_vec: "main", report_queries_vec_multi: "main",
  table_grain: "main", grain_meta: "main", table_usages: "main", usage_meta: "main",
  table_predicates: "main", pred_meta: "main", table_join_columns: "main",
  layout_patterns: "main", layout_patterns_vec: "main", layout_meta: "main",
  flexfields: "main", adf_extensions: "main",
  enrich_usage: "main", batch_jobs: "main", batch_items: "main", gjob_jobs: "main", gjob_items: "main", gjob_control: "main",
  enrich: "enrichdb", col_vec: "cachedb", table_rules: "factsdb", facts_meta: "factsdb",
};

export class SqliteProvider extends BaseProvider {
  readonly d: Database.Database;
  readonly attached: Set<string> = new Set();
  private stmts = new Map<string, Database.Statement>();
  private lock: Promise<void> = Promise.resolve();
  private als = new AsyncLocalStorage<symbol>();
  private activeTx: symbol | null = null;

  meta: SqliteMeta = new SqliteMeta(this);
  schema: SqliteSchema = new SqliteSchema(this);
  corpus: SqliteCorpus = new SqliteCorpus(this);
  registries: BaseRegistries = new BaseRegistries(this);
  flex: SqliteFlex = new SqliteFlex(this);
  layout: SqliteLayout = new SqliteLayout(this);
  rules: BaseRules = new BaseRules(this);
  enrich: SqliteEnrich = new SqliteEnrich(this);
  colCache: BaseColCache = new BaseColCache(this);

  constructor(readonly cfg: SqliteConfig) {
    super();
    const f = cfg.files;
    if (!cfg.create) {
      for (const [label, p] of Object.entries(f) as [string, string | undefined][]) {
        if (p && !fs.existsSync(p)) {
          throw new Error(
            `${label} DB not found at ${p}. Provision first (node dist/provision.js), or convert a ` +
              `pre-split catalog.sqlite with node dist/migrate-split.js <catalog.sqlite>.`,
          );
        }
      }
    } else {
      for (const p of Object.values(f)) if (p) fs.mkdirSync(path.dirname(p), { recursive: true });
    }
    this.d = new Database(f.reports, { fileMustExist: !cfg.create });
    this.d.pragma("busy_timeout = 10000"); // tolerate a dev script briefly locking a file
    loadVec(this.d);
    this.d.exec(`ATTACH DATABASE '${sqlQuote(f.schema)}' AS schemadb`);
    this.attached.add("schemadb");
    for (const [name, p] of [["enrichdb", f.enrich], ["cachedb", f.cache], ["factsdb", f.facts]] as const) {
      if (!p) continue;
      this.d.exec(`ATTACH DATABASE '${sqlQuote(p)}' AS ${name}`);
      this.attached.add(name);
    }
    if (cfg.build) {
      this.d.pragma("main.journal_mode = OFF");
      this.d.pragma("main.synchronous = OFF");
      this.d.pragma("schemadb.journal_mode = OFF");
      this.d.pragma("schemadb.synchronous = OFF");
      this.d.pragma("temp_store = MEMORY");
      this.d.pragma("cache_size = -200000"); // ~200MB page cache during build
    }
  }

  static async open(cfg: SqliteConfig): Promise<SqliteProvider> {
    const p = new SqliteProvider(cfg);
    await p.meta.ensureDdl();
    await p.schema.reloadTableNames();
    return p;
  }

  // ---- dialect hooks ----
  private stmt(sql: string): Database.Statement {
    let s = this.stmts.get(sql);
    if (!s) { s = this.d.prepare(sql); this.stmts.set(sql, s); }
    return s;
  }

  private guarded<T>(fn: () => T): Promise<T> {
    const tok = this.als.getStore();
    if (tok && tok === this.activeTx) {
      try { return Promise.resolve(fn()); } catch (e) { return Promise.reject(e); }
    }
    return this.withLock(fn);
  }

  private async withLock<T>(fn: () => T | Promise<T>): Promise<T> {
    const prev = this.lock;
    let release!: () => void;
    this.lock = new Promise<void>((r) => (release = r));
    await prev;
    try { return await fn(); } finally { release(); }
  }

  q<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.guarded(() => this.stmt(sql).all(...params) as T[]);
  }

  run(sql: string, params: unknown[] = []): Promise<RunResult> {
    return this.guarded(() => {
      const r = this.stmt(sql).run(...params);
      return { changes: r.changes, lastInsertRowid: Number(r.lastInsertRowid) };
    });
  }

  exec(sql: string): Promise<void> {
    return this.guarded(() => { this.d.exec(sql); });
  }

  tx<T>(fn: () => Promise<T>): Promise<T> {
    const tok = this.als.getStore();
    if (tok && tok === this.activeTx) return fn(); // nested: join the outer transaction
    return this.withLock(async () => {
      const mine = Symbol("tx");
      this.activeTx = mine;
      this.d.exec("BEGIN IMMEDIATE");
      try {
        const r = await this.als.run(mine, fn);
        this.d.exec("COMMIT");
        return r;
      } catch (e) {
        try { this.d.exec("ROLLBACK"); } catch { /* already rolled back */ }
        throw e;
      } finally {
        this.activeTx = null;
      }
    });
  }

  /** Synchronous transaction for provider-internal bulk paths (no awaits inside `fn`). */
  syncTx<T>(fn: () => T): Promise<T> {
    return this.guarded(() => this.d.transaction(fn)());
  }

  vec(v: Float32Array): Buffer { return Buffer.from(v.buffer, v.byteOffset, v.byteLength); }

  fromVec(raw: unknown): Float32Array {
    const blob = raw as Buffer;
    const f = new Float32Array(blob.byteLength / 4);
    Buffer.from(f.buffer, f.byteOffset, f.byteLength).set(blob);
    return f;
  }

  t(table: TableName): string { return `${DB_OF[table]}.${table}`; }
  coll(): string { return ""; } // BINARY is SQLite's default text collation
  idCol(): string { return "rowid"; }
  idBind(n: number | bigint): bigint { return BigInt(n); } // vec0 rejects JS numbers ("Only integers are allowed")

  async close(): Promise<void> {
    await this.withLock(() => { this.stmts.clear(); this.d.close(); });
  }
}
