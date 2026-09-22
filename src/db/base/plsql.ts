import type { PlsqlApi } from "../provider.js";
import type * as T from "../types.js";
import type { BaseProvider } from "./provider.js";

/** LIKE pattern for one token: `_` and `%` are wildcards in LIKE, so they are escaped. */
function like(token: string): string {
  return "%" + token.toUpperCase().replace(/[\\%_]/g, (c) => "\\" + c) + "%";
}

/**
 * PL/SQL API inventory — pipeline-built (scripts/pipeline/p3_calls.* → p5_plsql.sql), never at boot.
 * Portable SQL: both providers run it unchanged. Names are stored upper-cased; callers pass tokens as
 * typed and the LIKE side upper-cases them here.
 */
export class BasePlsql implements PlsqlApi {
  constructor(protected p: BaseProvider) {}

  private static API_COLS = "package_name, function_name, api_class, module, module_source, in_dictionary, statements, units, reports, titles, by_source, arg_counts, found_in, top_tables, top_modules, samples";

  async forTable(table: string, limit: number): Promise<T.PlsqlApiForTable[]> {
    return this.p.q<T.PlsqlApiForTable>(
      `SELECT ${BasePlsql.API_COLS.split(", ").map((c) => "a." + c).join(", ")}, t.statements AS table_statements, t.share
       FROM ${this.p.t("plsql_api_tables")} t JOIN ${this.p.t("plsql_api")} a USING (package_name, function_name)
       WHERE t.table_name = ?
       ORDER BY t.statements DESC, t.share DESC, a.package_name${this.p.coll()}, a.function_name${this.p.coll()} LIMIT ?`,
      [table, limit]);
  }

  async search(tokens: string[], limit: number): Promise<T.PlsqlApiRow[]> {
    if (!tokens.length) return [];
    const where = tokens.map(() => `(package_name || '.' || function_name) LIKE ? ESCAPE '\\'`).join(" AND ");
    return this.p.q<T.PlsqlApiRow>(
      `SELECT ${BasePlsql.API_COLS} FROM ${this.p.t("plsql_api")} WHERE ${where}
       ORDER BY statements DESC, package_name${this.p.coll()}, function_name${this.p.coll()} LIMIT ?`,
      [...tokens.map(like), limit]);
  }

  async apisOfPackage(pkg: string, limit: number): Promise<T.PlsqlApiRow[]> {
    return this.p.q<T.PlsqlApiRow>(
      `SELECT ${BasePlsql.API_COLS} FROM ${this.p.t("plsql_api")} WHERE package_name = ?
       ORDER BY statements DESC, function_name${this.p.coll()} LIMIT ?`, [pkg, limit]);
  }

  async package(pkg: string): Promise<T.PlsqlPackageRow | null> {
    const rows = await this.p.q<T.PlsqlPackageRow>(
      `SELECT package_name, api_class, in_dictionary, module, module_source, functions, statements FROM ${this.p.t("plsql_packages")} WHERE package_name = ?`, [pkg]);
    return rows[0] ?? null;
  }

  async packagesLike(tokens: string[], limit: number): Promise<T.PlsqlPackageRow[]> {
    if (!tokens.length) return [];
    const where = tokens.map(() => `package_name LIKE ? ESCAPE '\\'`).join(" AND ");
    return this.p.q<T.PlsqlPackageRow>(
      `SELECT package_name, api_class, in_dictionary, module, module_source, functions, statements FROM ${this.p.t("plsql_packages")}
       WHERE ${where} ORDER BY statements DESC, package_name${this.p.coll()} LIMIT ?`, [...tokens.map(like), limit]);
  }

  async counts(): Promise<{ packages: number; apis: number; apiTables: number }> {
    const [p, a, t] = await Promise.all([
      this.p.q<{ c: number }>(`SELECT COUNT(*) c FROM ${this.p.t("plsql_packages")}`),
      this.p.q<{ c: number }>(`SELECT COUNT(*) c FROM ${this.p.t("plsql_api")}`),
      this.p.q<{ c: number }>(`SELECT COUNT(*) c FROM ${this.p.t("plsql_api_tables")}`),
    ]);
    return { packages: Number(p[0]?.c ?? 0), apis: Number(a[0]?.c ?? 0), apiTables: Number(t[0]?.c ?? 0) };
  }

  async version(): Promise<string | null> {
    const rows = await this.p.q<{ v: string }>(`SELECT v FROM ${this.p.t("plsql_meta")} WHERE k='version'`);
    return rows[0]?.v ?? null;
  }

  async replaceAll(pkgs: T.PlsqlPackageRow[], apis: T.PlsqlApiRow[], apiTables: T.PlsqlApiTableRow[], version: string) {
    await this.p.tx(async () => {
      await this.p.exec(`DELETE FROM ${this.p.t("plsql_api_tables")}; DELETE FROM ${this.p.t("plsql_api")}; DELETE FROM ${this.p.t("plsql_packages")}; DELETE FROM ${this.p.t("plsql_meta")};`);
      for (const r of pkgs) {
        await this.p.run(`INSERT INTO ${this.p.t("plsql_packages")} (package_name, api_class, in_dictionary, module, module_source, functions, statements) VALUES (?,?,?,?,?,?,?)`,
          [r.package_name, r.api_class, r.in_dictionary, r.module, r.module_source, r.functions, r.statements]);
      }
      for (const r of apis) {
        await this.p.run(`INSERT INTO ${this.p.t("plsql_api")} (${BasePlsql.API_COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [r.package_name, r.function_name, r.api_class, r.module, r.module_source, r.in_dictionary, r.statements, r.units, r.reports, r.titles,
           r.by_source, r.arg_counts, r.found_in, r.top_tables, r.top_modules, r.samples]);
      }
      for (const r of apiTables) {
        await this.p.run(`INSERT INTO ${this.p.t("plsql_api_tables")} (package_name, function_name, table_name, statements, share) VALUES (?,?,?,?,?)`,
          [r.package_name, r.function_name, r.table_name, r.statements, r.share]);
      }
      await this.p.run(`INSERT INTO ${this.p.t("plsql_meta")} (k, v) VALUES ('version', ?)`, [version]);
    });
    return { packages: pkgs.length, apis: apis.length, apiTables: apiTables.length };
  }
}
