import { BaseFlex } from "../base/flex.js";
import type * as T from "../types.js";
import type { SqliteProvider } from "./provider.js";

/** sqlite: `INSERT OR REPLACE` upserts (delete + re-insert on the UNIQUE key). */
export class SqliteFlex extends BaseFlex {
  constructor(protected p: SqliteProvider) { super(p); }

  protected upsertSql(kind: T.FlexKind): string {
    if (kind === "flexfields") {
      return `INSERT OR REPLACE INTO flexfields
        (application_id, flexfield_type, flexfield_code, deployment_status, context_code,
         context_enabled, multirow, translatable, segment_code, column_name, sequence_number,
         segment_name, prompt, display_type, value_set_id, required, segment_enabled, source, loaded_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
    }
    return `INSERT OR REPLACE INTO adf_extensions
        (object_name, table_name, context_column_name, attribute_name, column_name, display_hint, source, loaded_at)
      VALUES (?,?,?,?,?,?,?,?)`;
  }

  protected insertConfigReportSql(): string {
    return `INSERT OR REPLACE INTO adf_extensions
      (object_name, table_name, context_column_name, attribute_name, column_name,
       display_hint, object_display, field_display, source, loaded_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`;
  }
}
