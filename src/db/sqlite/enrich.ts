import { BaseEnrich, BaseJobs } from "../base/enrich.js";
import type { SqliteProvider } from "./provider.js";

/** sqlite: `INSERT OR REPLACE` for the job-control upserts. */
export class SqliteJobs extends BaseJobs {
  protected batchItemSql(): string { return "INSERT OR REPLACE INTO batch_items (batch_id, custom_id, row_id) VALUES (?,?,?)"; }
  protected gjobSql(): string { return "INSERT OR REPLACE INTO gjob_jobs (name, model, n, submitted_at, status) VALUES (?,?,?,?,?)"; }
  protected gitemSql(): string { return "INSERT OR REPLACE INTO gjob_items (name, idx, row_id) VALUES (?,?,?)"; }
  protected gcontrolSql(): string { return "INSERT OR REPLACE INTO gjob_control (id, active, sources, model, cap, wave, batch_size) VALUES (1,?,?,?,?,?,?)"; }
}

export class SqliteEnrich extends BaseEnrich {
  constructor(protected p: SqliteProvider) { super(p); this.jobs = new SqliteJobs(p); }
}
