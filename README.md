# Fusion Schema MCP Server

Standalone **HTTP MCP server** that grounds a Fusion-SQL agent against the Oracle **Fusion**
schema catalog. The models already know most Oracle ERP names (from EBS on-prem), but Fusion
Cloud ≠ EBS — so these tools **validate and correct** the objects/columns the agent thinks it
knows, and surface **real join paths** (declared FKs + mined relationships).

**Scope:** grounding only. No SQL parsing, no SQL execution/validation (that needs a live
Oracle DB — later round). No agent, no CloudBeaver UI (later rounds).

## Tools

| Tool | Purpose |
|---|---|
| `searchTables(query, limit?)` | FTS over name + description + module; discovery by description |
| `getTable(name)` | metadata: type, module, description, primary key, column count |
| `getColumns(table)` | columns with type/size/nullable/description/PK flag |
| `validateTable(name)` | exists? + fuzzy "did-you-mean" (EBS→Fusion drift) |
| `validateColumns(table, columns[])` | per-column exists + suggestions |
| `getIndexes(table)` | indexes with ordered columns + uniqueness |
| `getRelatedTables(table)` | declared FKs + mined relationships, tagged + confidence = join paths |

## Data

`data/` holds the source metadata (copied from `../../Bip/DB_SCHEMA` via
`scripts/copy-data.sh`): `META_TABLES/COLUMNS/INDEXES/PKEYS/FKEYS.csv` +
`mined_relationships.json`. The compile step filters junk table rows to `TABLE`/`VIEW` and
builds the split seed DBs `schema.sqlite` + `reports.sqlite` (FTS5 + lookup indexes).

## Build & run (CloudBeaver WSL distro)

All commands run inside the `CloudBeaver` WSL distro. Scripts avoid PowerShell→wsl quoting.

```bash
# 1. copy source data into ./data (once)
bash scripts/copy-data.sh

# 2. install deps, build TS, compile schema.sqlite + reports.sqlite
bash scripts/install-build-compile.sh

# 3. boot + live smoke test (starts server, runs a real MCP client, asserts acceptance criteria)
bash scripts/verify.sh
```

### Docker (the shipping form)

```bash
docker compose build
docker compose up -d
curl http://localhost:8979/health
```

The multi-stage image compiles the catalog at build time and ships only `dist/` + the zipped
seed DBs under `/app/seed/` (the 250MB CSVs are dropped from the runtime image). On start,
`entrypoint.sh` runs `provision.js`, which unpacks/upgrades `schema.sqlite` + `reports.sqlite` +
`cache.sqlite` in the `DATA_DIR` volume. A pre-split single `catalog.sqlite` is converted once
with `node dist/migrate-split.js <catalog.sqlite> --schema <dir>/schema.sqlite --reports <dir>/reports.sqlite`.

## Connecting an agent

Point any MCP client at the Streamable-HTTP endpoint:

```
http://<host>:8979/mcp
```

e.g. Claude Agent SDK / Codex SDK `mcpServers` config, or the MCP inspector.

## Env

| Var | Default | Meaning |
|---|---|---|
| `MCP_PORT` | `8979` | HTTP port |
| `MCP_HOST` | `0.0.0.0` | bind host |
| `DATA_DIR` | `/app/data` (image) / `./data` (checkout) | dir holding the split DBs; also the source CSV/JSON dir for the compile step |
| `SCHEMA_DB` | `<DATA_DIR>/schema.sqlite` | schema tables (tables/columns/keys/relationships/meta) |
| `REPORTS_DB` | `<DATA_DIR>/reports.sqlite` | report corpus (report_queries + fts + vec) |
| `CACHE_DB` | `<DATA_DIR>/cache.sqlite` | column-search embedding cache |
| `SEED_DIR` | `/app/seed` | baked seed zips + VERSION read by `provision.js` |
| `MCP_URL` | `http://127.0.0.1:8979/mcp` | smoke-client target |
