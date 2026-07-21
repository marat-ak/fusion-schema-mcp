# Data-model authoring MCP tools

Complete set of MCP tools that let an agent **create or modify any BI Publisher data model**
(`.xdmz` / `_datamodel.xdm`) — every structural combination found in the live Fusion catalog.

Grounded in two things:
- the real `_datamodel.xdm` schema (datasets, data structure, links, parameters, LOVs, triggers,
  bursting, properties);
- the feature-catalog analysis of the customer catalog (dominant features: SQL datasets, event
  triggers, bursting, parameters, multi-dataset + links, grouping, LOV/cascading LOV, plus non-SQL
  datasets: web service / file / OLAP / view-object).

## Two tools, spec-driven

There are exactly **two** MCP tools. Each takes a full/partial **`DataModelSpec`** (JSON the agent
composes) and returns a **downloadable `.xdmz`** (base64) plus a summary + validation report.

| Tool | Input | Output |
|---|---|---|
| `createDataModel({ spec })` | a `DataModelSpec` | `{ xdmzBase64, fileName, summary, validation }` |
| `updateDataModel({ base, spec? , patch? })` | a base + changes | `{ xdmzBase64, fileName, summary, validation }` |

`base` for update is any of — the same call handles all three:
- `xdmzBase64` — a user-uploaded data model, or
- `corpusPath` — an archive already stored by the poller (`objects/...`), or
- `reportAbsolutePath` — pulled live from the Fusion catalog (via the poller's download creds).

Update applies either a **full `spec`** (replace) or a **`patch`** (targeted change, e.g. just one
dataset's SQL or one added parameter), then re-renders — preserving everything not mentioned.

**The tool groups below are NOT separate tools — they define the `DataModelSpec` schema.** Every
feature (datasets, structure, links, params, LOVs, triggers, bursting, properties) is a field the
agent fills. Coverage of "every combination" = completeness of this one schema.

```
DataModelSpec = {
  name, defaultDataSource?,
  dataSources?:  [...],           // §1
  datasets:      [ Dataset ],     // §2  (typed union: sql|plsql|webservice|http|file|olap|vo|analysis|xml)
  dataStructure?: { groups },     // §3  (auto-derived from a single SQL dataset if omitted)
  links?:        [ Link ],        // §4
  parameters?:   [ Parameter ],   // §5
  lovs?:         [ Lov ],         // §6
  triggers?:     [ EventTrigger ],// §7
  bursting?:     Bursting,        // §8
  flexfields?:   [ Flexfield ],   // §9
  properties?:   { ... },         // §10
}
```

Validation (§11) runs inside both tools before returning, grounded by the existing fusion-schema
tools; a spec with unresolved tables/columns/params comes back with `validation.errors` set.

## 1. Data sources

| Tool | Purpose |
|---|---|
| `listDataSources({modelId})` | available connection names (JDBC/WS/Essbase/HTTP/file) |
| `addDataSource({modelId, name, type, ref})` | register a source (`jdbc`,`ws`,`http`,`file`,`essbase`) |
| `setDefaultDataSource({modelId, name})` | default JDBC for new datasets |

Fusion default is the application JDBC — most datasets just reference it by name.

## 2. Datasets (one tool per source type — cover every dataset kind)

| Tool | Dataset type |
|---|---|
| `addSqlDataset({modelId, name, dataSource, sql, group?})` | physical SQL (`<sql>`) |
| `addPlsqlDataset({modelId, name, dataSource, refCursorCall})` | PL/SQL ref-cursor / procedure |
| `addWebServiceDataset({modelId, name, dataSource, service, operation, soapRequest, xpath?})` | `<webService>` (SOAP) |
| `addHttpDataset({modelId, name, url, method, params?})` | HTTP/REST feed |
| `addFileDataset({modelId, name, kind, source, columns})` | CSV / fixed-width / Excel |
| `addOlapDataset({modelId, name, dataSource, kind, query})` | MDX / Essbase / OLAP |
| `addViewObjectDataset({modelId, name, voFullPath, params?})` | Fusion ADF View Object |
| `addAnalysisDataset({modelId, name, otbiPath})` | OTBI BI-Analysis (logical) |
| `addXmlDataset({modelId, name, source})` | XML / CLOB-XML file |
| **modifiers** | |
| `setDatasetSql({modelId, dataset, sql})` | replace a SQL dataset's query (highest-value edit) |
| `setDatasetDataSource({modelId, dataset, name})` | repoint connection |
| `renameDataset` / `removeDataset({modelId, dataset})` | |

A multi-dataset model = call `add*Dataset` N times (types may be mixed: SQL + WS + VO in one model).

## 3. Data structure (the output XML shape)

| Tool | Purpose |
|---|---|
| `setDataStructure({modelId, groups})` | declarative full structure in one shot |
| `addGroup({modelId, name, source, breakBy?})` | a `<group>` bound to a dataset/parent |
| `nestGroup({modelId, child, parent})` | master-detail nesting (structural hierarchy) |
| `addElement({modelId, group, name, value, dataType, label?, xmlTag?})` | a column/field |
| `addGroupAggregate({modelId, group, fn, of, name})` | group total (`sum/count/avg/min/max`) |
| `addGlobalElement({modelId, name, fn, of})` | report-level aggregate/formula |
| `setElementProps` / `removeElement` / `removeGroup` | |

## 4. Dataset links & relations (multi-dataset master-detail)

| Tool | Purpose |
|---|---|
| `linkDatasets({modelId, masterDataset, masterElement, detailDataset, bindParam})` | element-level link (detail SQL bind driven by master row) |
| `addGroupLink({modelId, parentGroup, childGroup, on})` | group-level relation |
| `removeLink({modelId, linkId})` | |

## 5. Parameters

| Tool | Purpose |
|---|---|
| `addParameter({modelId, name, dataType, defaultValue?, kind, multi?, lov?})` | `kind`: `text\|date\|menu\|search` |
| `setParameterLov({modelId, param, lovId})` | attach an LOV to a menu param |
| `setParameterDefault` / `reorderParameters` / `removeParameter` | |
| `bindParameterToDataset({modelId, param, dataset})` | ensure `:bind` / `&lexical` usage is declared |

Bind (`:p`) vs lexical (`&p`) is determined by how the SQL references it; `validateBindLexical`
keeps declarations and references in sync.

## 6. LOVs / value sets

| Tool | Purpose |
|---|---|
| `addSqlLov({modelId, name, dataSource, sql, displayCol, valueCol})` | query-driven list of values |
| `addFixedLov({modelId, name, values})` | static list |
| `setCascadingLov({modelId, lovId, dependsOnParams})` | dependent LOV (bind params in the LOV SQL) |
| `removeLov({modelId, lovId})` | |

## 7. Event triggers

| Tool | Purpose |
|---|---|
| `addEventTrigger({modelId, event, language, ref, params?})` | `event`: `beforeData\|afterData\|schedule\|beforeReport`; `language`: `plsql\|java` |
| `reorderTriggers` / `removeTrigger({modelId, triggerId})` | |

PL/SQL triggers reference `package.function`; the single most common non-SQL feature in the catalog.

## 8. Bursting

| Tool | Purpose |
|---|---|
| `setBursting({modelId, dataSource, burstQuery, splitBy, deliverBy, channels})` | burst query returns KEY + delivery columns |
| `removeBursting({modelId})` | |

## 9. Fusion flexfields (advanced, Fusion-specific)

| Tool | Purpose |
|---|---|
| `registerFlexfield({modelId, kind, application, code, dataset})` | KFF/DFF expansion in a dataset |

## 10. Global properties / sample

| Tool | Purpose |
|---|---|
| `setProperty({modelId, key, value})` | scalable mode, XML tag case, include-empty-tags, DB fetch size, SQL monitor, etc. |
| `setSampleData({modelId, xml})` | sample XML for downstream layout design |

## 11. Validation & grounding (reuse the fusion-schema MCP)

| Tool | Purpose |
|---|---|
| `validateDataModel({modelId})` | structural: every element→dataset column, links resolve, params declared |
| `validateDatasetSql({modelId, dataset})` | ground tables/columns via `validateTable`/`getColumns`/`getRelatedTables` |
| `validateBindLexical({modelId})` | declared params vs `:bind`/`&lexical` refs across all datasets |
| `validateLinks({modelId})` | master/detail element existence + type compatibility |

## Coverage matrix (analyzer feature → tool)

| Catalog feature | Tool(s) |
|---|---|
| `dm.sqlDataset` | `addSqlDataset` / `setDatasetSql` |
| `dm.plsqlDataset` | `addPlsqlDataset` |
| `dm.nonSqlDataset` (web service / file / OLAP / VO) | `addWebServiceDataset` / `addHttpDataset` / `addFileDataset` / `addOlapDataset` / `addViewObjectDataset` |
| `dm.multiDataset` | repeated `add*Dataset` |
| `dm.datasetLinks` | `linkDatasets` / `addGroupLink` |
| `dm.grouping` | `addGroup` / `nestGroup` / `addGroupAggregate` |
| `dm.parameters`, `dm.bindParams`, `dm.lexicalParams` | `addParameter` / `bindParameterToDataset` |
| `dm.lovParameters`, `dm.cascadingLov` | `addSqlLov` / `addFixedLov` / `setCascadingLov` |
| `dm.eventTriggers`, `dm.plsqlTriggers` | `addEventTrigger` |
| `dm.bursting` | `setBursting` |
| CLOB/XML | `addXmlDataset` / `setProperty` |

## Minimal create paths

- **Simplest** (one SQL dataset): `createDataModel` → `addSqlDataset` → `renderDataModel`.
- **Typical Fusion report DM**: `createDataModel` → `addSqlDataset` ×N → `linkDatasets` →
  `addGroup`/`nestGroup` → `addParameter` + `addSqlLov`/`setCascadingLov` → `addEventTrigger` →
  `setBursting` → `validateDataModel` → `renderDataModel`.
- **Modify existing**: `loadDataModel` → `inspect` → targeted `set*`/`add*`/`remove*` →
  `validate` → `render`.
