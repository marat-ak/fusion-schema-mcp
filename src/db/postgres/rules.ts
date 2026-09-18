import { BaseRules } from "../base/rules.js";
import type { PostgresProvider } from "./provider.js";

/** Curated table rules are CUSTOMER-canonical (never per version), so the base statements run
 *  unchanged against `customer.table_rules`; only the new id has to be asked for explicitly. */
export class PgRules extends BaseRules {
  constructor(protected p: PostgresProvider) { super(p); }
  protected returning(): string { return " RETURNING id"; }
}
