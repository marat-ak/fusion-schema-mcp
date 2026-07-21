/**
 * Data-model authoring engine (v1: core SQL data models).
 *
 * Turns a DataModelSpec into a valid BI Publisher `.xdmz` archive, and updates an existing one.
 * The generated `_datamodel.xdm` matches the real Fusion schema (root `dataModel` @ ns
 * http://xmlns.oracle.com/oxp/xmlp, `dataProperties`, `dataSets/dataSet/sql`, `output/nodeList/
 * dataStructure/group/element`, plus empty eventTriggers/lexicals/parameters/valueSets/bursting).
 *
 * v1 scope: SQL datasets (one or many), parameters, and the output data structure (one group per
 * dataset, elements from provided columns or a light SELECT-list parse). Web service / PL/SQL /
 * bursting / triggers / links extend the same spec later.
 */
import { zipSync, unzipSync, strToU8, strFromU8 } from "fflate";

// ---- spec -------------------------------------------------------------------------------------

export type DmType = "string" | "integer" | "float" | "number" | "date" | "boolean";

export interface DmColumn {
  name: string;            // XML element/tag name (e.g. INVOICE_ID)
  value?: string;          // source expression/column (defaults to name)
  dataType?: DmType;       // defaults to string
  label?: string;
}
export interface DmDataset {
  name: string;
  sql: string;
  dataSource?: string;     // JDBC connection name; defaults to spec.defaultDataSource
  columns?: DmColumn[];    // output elements; if omitted, parsed from the SELECT list
}
export interface DmParameter {
  name: string;
  dataType?: DmType;       // defaults to string
  defaultValue?: string;
  label?: string;
}
export interface DataModelSpec {
  name: string;
  defaultDataSource?: string;
  description?: string;
  path?: string;                       // catalog path for metadata/security, e.g. /Custom/AI/My.xdm
  rootName?: string;                   // output root tag, default DATA_DS
  datasets: DmDataset[];
  parameters?: DmParameter[];
  properties?: Record<string, string>; // dataProperties overrides
}

// ---- xml helpers ------------------------------------------------------------------------------

const xesc = (s: string) => s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]!));
const cdata = (s: string) => `<![CDATA[${String(s).replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;
const tag = (n: string) => n.replace(/[^A-Za-z0-9_]/g, "_").replace(/^([^A-Za-z_])/, "_$1");

const XSD: Record<DmType, string> = {
  string: "xsd:string", integer: "xsd:integer", float: "xsd:double",
  number: "xsd:double", date: "xsd:date", boolean: "xsd:string",
};

const DEFAULT_PROPS: Record<string, string> = {
  include_parameters: "true",
  include_null_Element: "false",
  include_rowsettag: "false",
  exclude_tags_for_lob: "false",
  xml_tag_case: "upper",
  generate_output_format: "xml",
  sql_monitor_report_generated: "false",
  optimize_query_executions: "false",
};

/** Best-effort column list from a SELECT: aliases after AS, else last identifier / after a dot. */
export function parseSelectColumns(sql: string): DmColumn[] {
  const m = /\bselect\b([\s\S]*?)\bfrom\b/i.exec(sql);
  if (!m) return [];
  const list = m[1];
  // split top-level commas (ignore commas inside parentheses)
  const parts: string[] = [];
  let depth = 0, cur = "";
  for (const ch of list) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) { parts.push(cur); cur = ""; } else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  const cols: DmColumn[] = [];
  const seen = new Set<string>();
  for (let raw of parts) {
    raw = raw.trim().replace(/\s+/g, " ");
    if (!raw || raw === "*") continue;
    const asMatch = /\s+as\s+"?([A-Za-z0-9_]+)"?$/i.exec(raw) || /\s+"?([A-Za-z0-9_]+)"?$/.exec(raw);
    let name = asMatch?.[1] ?? raw;
    if (name.includes(".")) name = name.split(".").pop()!;
    name = tag(name).toUpperCase();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    cols.push({ name, value: name, dataType: "string" });
  }
  return cols;
}

// ---- build _datamodel.xdm ---------------------------------------------------------------------

export function buildXdm(spec: DataModelSpec): string {
  const defDs = spec.defaultDataSource ?? spec.datasets[0]?.dataSource ?? "demo";
  const rootName = spec.rootName ?? "DATA_DS";
  const props = { ...DEFAULT_PROPS, ...(spec.properties ?? {}) };

  const dataProps = Object.entries(props)
    .map(([k, v]) => `      <property name="${xesc(k)}" value="${xesc(v)}"/>`).join("\n");

  const dataSets = spec.datasets.map((d) => {
    const ds = d.dataSource ?? defDs;
    return `      <dataSet name="${xesc(d.name)}" type="complex">\n` +
      `         <sql dataSourceRef="${xesc(ds)}">\n            ${cdata(d.sql.trim())}\n         </sql>\n` +
      `      </dataSet>`;
  }).join("\n");

  const groups = spec.datasets.map((d) => {
    const cols = (d.columns && d.columns.length ? d.columns : parseSelectColumns(d.sql));
    const els = cols.map((c, i) =>
      `               <element name="${xesc(tag(c.name))}" value="${xesc(c.value ?? c.name)}" ` +
      `label="${xesc(c.label ?? c.name)}" dataType="${XSD[c.dataType ?? "string"]}" breakOrder="" fieldOrder="${i + 1}"/>`
    ).join("\n");
    const gname = tag("G_" + d.name);
    return `            <group name="${xesc(gname)}" label="${xesc(gname)}" source="${xesc(d.name)}">\n${els}\n            </group>`;
  }).join("\n");

  const params = (spec.parameters ?? []).map((p) =>
    `      <parameter name="${xesc(p.name)}" defaultValue="${xesc(p.defaultValue ?? "")}" ` +
    `dataType="${XSD[p.dataType ?? "string"]}" rowPlacement="1">\n` +
    `         <input label="${xesc(p.label ?? p.name)}"/>\n      </parameter>`
  ).join("\n");

  const layouts = [
    ...spec.datasets.map((d, i) => `         <layout name="${xesc(d.name)}" left="280px" top="${i * 35}px"/>`),
    `         <layout name="${xesc(rootName)}" left="0px" top="${spec.datasets.length * 35}px"/>`,
  ].join("\n");

  return `<?xml version = '1.0' encoding = 'utf-8'?>
<dataModel xmlns="http://xmlns.oracle.com/oxp/xmlp" version="2.0" xmlns:xdm="http://xmlns.oracle.com/oxp/xmlp" xmlns:xsd="http://www.w3.org/2001/XMLSchema" defaultDataSourceRef="${xesc(defDs)}">
   <description>
      ${cdata(spec.description ?? "")}
   </description>
   <dataProperties>
${dataProps}
   </dataProperties>
   <dataSets>
${dataSets}
   </dataSets>
   <output rootName="${xesc(rootName)}" uniqueRowName="false">
      <nodeList name="data-structure">
         <dataStructure tagName="${xesc(rootName)}">
${groups}
         </dataStructure>
      </nodeList>
   </output>
   <eventTriggers/>
   <lexicals/>
   <parameters>
${params}
   </parameters>
   <valueSets/>
   <bursting/>
   <validations>
      <validation>N</validation>
   </validations>
   <display>
      <layouts>
${layouts}
      </layouts>
      <groupLinks/>
   </display>
</dataModel>
`;
}

// ---- aux archive entries ----------------------------------------------------------------------

function buildMetadata(spec: DataModelSpec): string {
  const path = spec.path ?? `/Custom/${spec.name}.xdm`;
  const enc = encodeURIComponent(path).replace(/%20/g, "+");
  const e = (k: string, v: string) => `    <entry>\n      <key>${cdata(k)}</key>\n      <value>${cdata(v)}</value>\n    </entry>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<metadata>
  <entries>
${e("bip:DisplayName", spec.name)}
${e("DESCRIPTION", spec.description ?? "")}
${e("propertyMap", "1")}
${e("path", enc)}
  </entries>
</metadata>
`;
}

function buildSecurity(spec: DataModelSpec): string {
  const path = spec.path ?? `/Custom/${spec.name}.xdm`;
  const policy = (role: string, disp: string) =>
    `   <policy rolename="${role}" roleGUID="${role}" roleDisplayName="${disp}">\n` +
    `      <folderPermission>\n` +
    `         <allow path="${xesc(path)}" recursive="false" permissions="oracle.bi.publisher.fullControl,"/>\n` +
    `      </folderPermission>\n   </policy>`;
  return `<?xml version = '1.0' encoding = 'UTF-8'?>
<security>
${policy("BIAuthor", "BI Author Role")}
${policy("BIAdministrator", "BI Administrator Role")}
</security>
`;
}

/** Minimal sample.xml so layout tools have a shape to bind to (empty element values). */
function buildSample(spec: DataModelSpec): string {
  const rootName = spec.rootName ?? "DATA_DS";
  const groups = spec.datasets.map((d) => {
    const cols = (d.columns && d.columns.length ? d.columns : parseSelectColumns(d.sql));
    const gname = tag("G_" + d.name);
    const els = cols.map((c) => `<${tag(c.name)}></${tag(c.name)}>`).join("");
    return `<${gname}>${els}</${gname}>`;
  }).join("");
  return `<?xml version = '1.0' encoding = 'utf-8'?>\n<${rootName}>${groups}</${rootName}>\n`;
}

// ---- zip / unzip ------------------------------------------------------------------------------

export function buildXdmz(spec: DataModelSpec): Uint8Array {
  const files: Record<string, Uint8Array> = {
    "_datamodel.xdm": strToU8(buildXdm(spec)),
    "sample.xml": strToU8(buildSample(spec)),
    "~metadata.meta": strToU8(buildMetadata(spec)),
    "~security.sec": strToU8(buildSecurity(spec)),
  };
  return zipSync(files, { level: 6 });
}

export function unzipXdmz(bytes: Uint8Array): Record<string, Uint8Array> {
  return unzipSync(bytes);
}

// ---- update -----------------------------------------------------------------------------------

export interface DmPatch {
  setDatasetSql?: { dataset: string; sql: string }[];
  setDefaultDataSource?: string;
  addParameters?: DmParameter[];
  rename?: string;
}

/** Replace a named dataset's SQL inside an existing _datamodel.xdm string. */
export function replaceDatasetSql(xdm: string, dataset: string, sql: string): { xml: string; found: boolean } {
  const re = new RegExp(`(<dataSet\\b[^>]*\\bname="${dataset.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*>[\\s\\S]*?<sql\\b[^>]*>)([\\s\\S]*?)(</sql>)`, "i");
  let found = false;
  const xml = xdm.replace(re, (_m, pre, _body, post) => { found = true; return `${pre}\n            ${cdata(sql.trim())}\n         ${post}`; });
  return { xml, found };
}

/** Apply a targeted patch to an existing .xdmz, preserving all other archive entries. */
export function updateXdmzWithPatch(baseBytes: Uint8Array, patch: DmPatch): { bytes: Uint8Array; applied: string[]; warnings: string[] } {
  const entries = unzipSync(baseBytes);
  const key = Object.keys(entries).find((n) => n.toLowerCase().endsWith("_datamodel.xdm"));
  if (!key) throw new Error("base is not a data model archive (no _datamodel.xdm)");
  let xdm = strFromU8(entries[key]);
  const applied: string[] = [], warnings: string[] = [];

  for (const s of patch.setDatasetSql ?? []) {
    const r = replaceDatasetSql(xdm, s.dataset, s.sql);
    if (r.found) { xdm = r.xml; applied.push(`setDatasetSql:${s.dataset}`); }
    else warnings.push(`dataset not found: ${s.dataset}`);
  }
  if (patch.setDefaultDataSource) {
    xdm = xdm.replace(/(<dataModel\b[^>]*\bdefaultDataSourceRef=")[^"]*(")/i, `$1${xesc(patch.setDefaultDataSource)}$2`);
    applied.push("setDefaultDataSource");
  }
  if (patch.addParameters?.length) {
    const params = patch.addParameters.map((p) =>
      `      <parameter name="${xesc(p.name)}" defaultValue="${xesc(p.defaultValue ?? "")}" dataType="${XSD[p.dataType ?? "string"]}" rowPlacement="1">\n         <input label="${xesc(p.label ?? p.name)}"/>\n      </parameter>`).join("\n");
    if (/<parameters\s*\/>/i.test(xdm)) xdm = xdm.replace(/<parameters\s*\/>/i, `<parameters>\n${params}\n   </parameters>`);
    else xdm = xdm.replace(/(<parameters>)/i, `$1\n${params}`);
    applied.push(`addParameters:${patch.addParameters.length}`);
  }

  entries[key] = strToU8(xdm);
  return { bytes: zipSync(entries, { level: 6 }), applied, warnings };
}

/** Rebuild a .xdmz from a full spec but keep the base archive's aux entries (sample/security). */
export function updateXdmzWithSpec(baseBytes: Uint8Array, spec: DataModelSpec): Uint8Array {
  const entries = unzipSync(baseBytes);
  const key = Object.keys(entries).find((n) => n.toLowerCase().endsWith("_datamodel.xdm")) ?? "_datamodel.xdm";
  entries[key] = strToU8(buildXdm(spec));
  entries["~metadata.meta"] = strToU8(buildMetadata(spec));
  entries["sample.xml"] = strToU8(buildSample(spec));
  return zipSync(entries, { level: 6 });
}
