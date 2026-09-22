/**
 * PostgresProvider — the catalog DB on `stack-db`'s `fusion` database (spec 2026-09-16 D13).
 *
 * ONE `postgres` pool (same client + options as the engine's store, `gnimsys-agent-core/src/db/
 * client.ts`). The physical layout is schema-per-version: `meta` (seeds + the single-row
 * `active_version` pointer), `v<YYYY_MM>` (the vendor data of one delivered version) and
 * `customer` (customer-owned rows). The active version is resolved ONCE at open, cached, re-read
 * by `refreshIfMoved()`; `t()` qualifies every table from that cache + the routing map in
 * ./schemas.ts, so no caller — and no base statement — ever names a schema.
 *
 * The provider never creates or repairs anything at connect: `meta.verify()` only READS (active
 * version, seed `ddl_version`/`embedding_model`, table presence, counts) and throws naming the
 * missing piece; `meta.ensureDdl()` (the library migrations) is an explicit call the upgrade job
 * makes. There is no fallback to sqlite, ever.
 *
 * Dialect hooks: `?` placeholders are rewritten to `$n` (string literals, quoted identifiers and
 * `--` / block comments are skipped), transactions are `sql.begin` tracked through an
 * AsyncLocalStorage so nested library calls join the open transaction, vectors bind as
 * `'[…]'` literals (pgvector infers the column type), and identity is `rid` — never a rowid.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import postgres from "postgres";
import { BaseProvider, type RunResult, type TableName } from "../base/provider.js";
import { BaseColCache } from "../base/colCache.js";
import { BaseRegistries } from "../base/registries.js";
import { BasePlsql } from "../base/plsql.js";
import { PgMeta } from "./meta.js";
import { PgSchema } from "./schema.js";
import { PgCorpus } from "./corpus.js";
import { PgLayout } from "./layout.js";
import { PgFlex } from "./flex.js";
import { PgRules } from "./rules.js";
import { PgEnrich } from "./enrich.js";
import { applyLibraryMigrations } from "./migrations.js";
import { CUSTOMER_SCHEMA, META_SCHEMA, physical, readSchema, writeSchemas } from "./schemas.js";

export interface PostgresConfig {
  provider: "postgres";
  /** REQUIRED, no default: postgresql://fusion:<pw>@stack-db:5432/fusion */
  databaseUrl: string;
}

/** int8 (`rid`, COUNT(*), the token counters) and numeric arrive as strings by default, while the
 *  whole API is typed `number`. Every int8 we store fits a JS number; `numeric` has NO column in
 *  this schema — it only ever arrives from SUM()/AVG() over those counters. */
const NUM = (oid: number) => ({ to: oid, from: [oid], serialize: (x: number | bigint) => String(x), parse: (x: string) => Number(x) });
const TYPES = { int8: NUM(20), numeric: NUM(1700) };

/** Pool + per-connection limits. A runtime statement that runs longer than this is a bug, not load:
 *  the heaviest serving statement is an exact 23.7k-row KNN (~30 ms). Bulk COPY runs in the upgrade
 *  job, which sets its own timeout. */
const POOL = { max: 8, connect_timeout: 10, idle_timeout: 10 };
const STATEMENT_TIMEOUT_MS = 120_000;
const IDLE_IN_TX_TIMEOUT_MS = 60_000;
/** v2026_10 ships HNSW indexes on every searched embedding column (scripts/pipeline/p5_index.sql),
 *  and the planner uses them. `PgCorpus.knn` is documented as EXACT — its `1 - d²/2` score must match
 *  what sqlite-vec returned — and at pgvector's default `hnsw.ef_search = 40` recall@10 measured
 *  95.0 % (one top-10 hit in twenty changes). 100 measured 100.0 % recall@10 for +0.08 ms per probe
 *  on the 104k-vector table, so that is the value: the index buys the latency (1.45 ms vs 23 ms
 *  exact) at no measured loss. Set per connection, here, because nothing else in the serving path
 *  sets GUCs. */
const HNSW_EF_SEARCH = "100";

type Sql = postgres.Sql<{}>;

export class PostgresProvider extends BaseProvider {
  private sql!: Sql;
  private als = new AsyncLocalStorage<Sql>();
  private version = "";
  private vectorSchema = "";
  private placeholders = new Map<string, string>();

  meta: PgMeta = new PgMeta(this);
  schema: PgSchema = new PgSchema(this);
  corpus: PgCorpus = new PgCorpus(this);
  registries: BaseRegistries = new BaseRegistries(this);
  plsql: BasePlsql = new BasePlsql(this);
  flex: PgFlex = new PgFlex(this);
  layout: PgLayout = new PgLayout(this);
  rules: PgRules = new PgRules(this);
  enrich: PgEnrich = new PgEnrich(this);
  colCache: BaseColCache = new BaseColCache(this);

  private constructor(readonly cfg: PostgresConfig) { super(); }

  static async open(cfg: PostgresConfig): Promise<PostgresProvider> {
    const p = new PostgresProvider(cfg);
    const boot = postgres(cfg.databaseUrl, { ...POOL, max: 1, types: TYPES, onnotice: () => {} });
    try {
      const [ext] = await boot`SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'vector'`;
      if (!ext?.nspname) throw new Error("the `vector` extension is not installed in this database");
      p.vectorSchema = ext.nspname as string;
      p.version = await readActiveVersion(boot);
    } finally {
      await boot.end({ timeout: 5 });
    }
    p.sql = p.pool();
    // §0 (2026-09-18): the serving container BUILDS NOTHING — no DDL, no migration, no rebuild at
    // boot. This is a read-only verification that fails loudly when the database is incomplete.
    await p.meta.verify();
    await p.schema.reloadTableNames();
    return p;
  }

  private pool(): Sql {
    return postgres(this.cfg.databaseUrl, {
      ...POOL,
      types: TYPES,
      onnotice: () => { /* CREATE ... IF NOT EXISTS notices are noise */ },
      connection: {
        // qualification is explicit (t()), so this only backstops ad-hoc SQL and — the load-bearing
        // part — resolves the `vector` type of the pgvector extension.
        search_path: `${this.version}, ${CUSTOMER_SCHEMA}, ${META_SCHEMA}, ${this.vectorSchema}`,
        statement_timeout: STATEMENT_TIMEOUT_MS,
        idle_in_transaction_session_timeout: IDLE_IN_TX_TIMEOUT_MS,
        "hnsw.ef_search": HNSW_EF_SEARCH,
      },
    });
  }

  /** The connection the current async context must use: the open transaction, else the pool. */
  private conn(): Sql { return this.als.getStore() ?? this.sql; }

  // ---- dialect hooks ----------------------------------------------------------------------
  /** `?` → `$n`, skipping '…' literals, "…" identifiers and -- / block comments. */
  private pg(sql: string): string {
    const hit = this.placeholders.get(sql);
    if (hit) return hit;
    let out = "", n = 0;
    for (let i = 0; i < sql.length; i++) {
      const c = sql[i];
      if (c === "'" || c === '"') {
        const q = c; let j = i + 1;
        while (j < sql.length) {
          if (sql[j] === q) { if (sql[j + 1] === q) { j += 2; continue; } break; }
          j++;
        }
        out += sql.slice(i, j + 1); i = j; continue;
      }
      if (c === "-" && sql[i + 1] === "-") {
        const j = sql.indexOf("\n", i);
        const end = j === -1 ? sql.length : j;
        out += sql.slice(i, end); i = end - 1; continue;
      }
      if (c === "/" && sql[i + 1] === "*") {
        const j = sql.indexOf("*/", i + 2);
        const end = j === -1 ? sql.length : j + 2;
        out += sql.slice(i, end); i = end - 1; continue;
      }
      out += c === "?" ? `$${++n}` : c;
    }
    this.placeholders.set(sql, out);
    return out;
  }

  async q<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
    // postgres.js returns a `Result` (an Array subclass carrying count/command/columns). Callers are
    // typed `T[]` and compare rows structurally — hand back a plain array, never the driver object.
    return Array.from(await this.conn().unsafe(this.pg(sql), params as any[], { prepare: true })) as T[];
  }

  async run(sql: string, params: unknown[] = []): Promise<RunResult> {
    const res: any = await this.conn().unsafe(this.pg(sql), params as any[], { prepare: true });
    const returned = res.length ? Number(Object.values(res[0])[0]) : undefined;
    return {
      changes: res.count ?? res.length ?? 0,
      // Postgres has no lastInsertRowid: a caller that needs the new identity asks for it with
      // RETURNING (see PgRules.returning()). Reading it without one is a bug, not a 0.
      get lastInsertRowid(): number {
        if (returned === undefined || Number.isNaN(returned)) {
          throw new Error("lastInsertRowid is unavailable on Postgres — add a RETURNING clause to the statement");
        }
        return returned;
      },
    };
  }

  async exec(sql: string): Promise<void> {
    await this.conn().unsafe(this.pg(sql)).simple();
  }

  async tx<T>(fn: () => Promise<T>): Promise<T> {
    if (this.als.getStore()) return fn(); // nested: join the open transaction
    return this.sql.begin((tx) => this.als.run(tx as unknown as Sql, fn)) as Promise<T>;
  }

  /** Stream rows into `schema.table` with COPY FROM STDIN (text format). */
  async copyIn(schema: string, table: string, cols: string[], rows: Iterable<unknown[]>): Promise<number> {
    let n = 0;
    const chunks = function* () {
      let buf: string[] = [];
      for (const r of rows) {
        buf.push(r.map(copyEnc).join("\t")); n++;
        if (buf.length >= 2000) { yield buf.join("\n") + "\n"; buf = []; }
      }
      if (buf.length) yield buf.join("\n") + "\n";
    };
    const cl = cols.map(ident).join(", ");
    const w = await this.conn().unsafe(`COPY ${ident(schema)}.${ident(table)} (${cl}) FROM STDIN`).writable();
    await pipeline(Readable.from(chunks()), w as any);
    return n;
  }

  vec(v: Float32Array): string { return `[${Array.from(v).join(",")}]`; }

  fromVec(raw: unknown): Float32Array {
    if (typeof raw !== "string") throw new Error(`expected a pgvector literal, got ${typeof raw}`);
    const parts = raw.slice(1, -1).split(",");
    const f = new Float32Array(parts.length);
    for (let i = 0; i < parts.length; i++) f[i] = Number(parts[i]);
    return f;
  }

  // ---- schema qualification ---------------------------------------------------------------
  t(table: TableName): string { return qual(readSchema(table, this.version), physical(table)); }
  /** Every qualified name a WRITE of `table` must hit; [0] is the serving one (D14 dual-write). */
  tw(table: TableName): string[] { return writeSchemas(table, this.version).map((s) => qual(s, physical(table))); }
  /** Bare schema names for COPY / DDL. */
  schemasOf(table: TableName): string[] { return writeSchemas(table, this.version); }
  activeSchema(): string { return this.version; }
  vectorType(): string { return this.vectorSchema; }

  coll(): string { return ' COLLATE "C"'; } // = SQLite's bytewise BINARY ordering
  idCol(): string { return "rid"; }
  idBind(n: number | bigint): number { return Number(n); }

  /** Re-read `meta.active_version`. A moved pointer rebuilds the pool (its search_path carries the
   *  version) and reloads the table-name snapshot. */
  async refreshIfMoved(): Promise<boolean> {
    const v = await readActiveVersion(this.sql);
    if (v === this.version) return false;
    const old = this.sql;
    this.version = v;
    this.placeholders.clear();
    this.sql = this.pool();
    void old.end({ timeout: 5 }).catch(() => { /* in-flight queries finish or time out */ });
    await this.schema.reloadTableNames();
    return true;
  }

  /** Apply the library's own (customer-side) migrations — see ./migrations.ts. */
  async migrate(): Promise<number[]> { return applyLibraryMigrations(this.sql); }

  async close(): Promise<void> { await this.sql.end({ timeout: 5 }); }
}

async function readActiveVersion(sql: Sql): Promise<string> {
  const rows = await sql`SELECT version FROM meta.active_version`;
  const v = rows[0]?.version as string | undefined;
  if (!v) throw new Error("meta.active_version is empty — restore a catalog version before starting (no default version)");
  if (!/^v\d{4}_\d{2}$/.test(v)) throw new Error(`meta.active_version holds an unexpected schema name: ${v}`);
  return v;
}

const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;
const qual = (schema: string, table: string) => `${ident(schema)}.${ident(table)}`;

/** COPY text-format encoder (same escaping as scripts/pg-import/import.mts). */
function copyEnc(v: unknown): string {
  if (v === null || v === undefined) return "\\N";
  if (typeof v === "number" || typeof v === "bigint") return String(v);
  const s = String(v);
  return s.replaceAll("\0", "").replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
}
