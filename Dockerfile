# Multi-stage: build TS (+ warm the embedding model), then ship a lean runtime = code + model cache.
# Debian base both stages so the better-sqlite3 native module matches at runtime.
# NO catalog data is baked: the catalog is served from the provider CATALOG_DB names at runtime
# (postgres: DATABASE_URL on stack-db; sqlite: a seed volume at SEED_DIR provisioned into DATA_DIR).
# The container starts through /entry (oservices-setup Config API, module stack.fusion) which execs
# /entrypoint.sh.

# ---- build stage: install deps, build TS, warm the model cache ----
FROM node:22-bookworm AS build
WORKDIR /app

# native build toolchain for better-sqlite3
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json ./
COPY VERSION ./VERSION
COPY src ./src
# tests + the no-SQL-outside-db gate run in THIS stage
# (`docker run --rm -e CATALOG_DB=sqlite <build-image> npm test`, postgres variant in test/fixture.ts)
COPY test ./test
COPY scripts/no-sql-outside-db.sh ./scripts/no-sql-outside-db.sh
# the landed Postgres DDL — the contract suite seeds its throwaway database from it
COPY scripts/pg-import/ddl.sql ./scripts/pg-import/ddl.sql
RUN npm run build
# non-TS corpus assets ride along into dist (tsc copies only .ts): layout-pattern JSONL + fixtures.
# shard-* dirs are curation provenance (experiments, render-check PNGs) — merged into the main
# patterns.jsonl already, so they stay out of the image.
RUN cp -r src/corpus/layoutPatterns dist/corpus/layoutPatterns \
    && rm -rf dist/corpus/layoutPatterns/shard-*

# Warm the bge-small embedding model into node_modules/.cache so the runtime can embed query intents
# (findSimilarQueries) and re-embed during sqlite provisioning, offline.
RUN node -e "import('@xenova/transformers').then(async t=>{const p=await t.pipeline('feature-extraction','Xenova/bge-small-en-v1.5');await p('warm',{pooling:'mean',normalize:true});console.log('bge-small cached');})"

# ---- entry stage: the oservices-setup Config API startup wrapper (setup V1 task 9) ----
# The shared client library arrives as the NAMED build context `oservices-config`
# (devops compose: build.additional_contexts.oservices-config: ../oservices-setup/config;
# standalone: docker build --build-context oservices-config=../oservices-setup/config .).
# entry/go.mod's `replace … => ../config` resolves against this layout (config + entry as siblings).
FROM golang:1.23 AS entry
WORKDIR /src
COPY --from=oservices-config / /src/config
COPY entry /src/entry
# the test suite execs the real entrypoint.sh to prove its CATALOG_DB gate survives (main_test.go)
COPY entrypoint.sh /src/entrypoint.sh
WORKDIR /src/entry
RUN go test ./...
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags "-s -w" -o /entry .

# ---- runtime stage: node + dist + node_modules (model cache). NO seed, NO provider default. ----
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV MCP_PORT=8979
ENV MCP_HOST=0.0.0.0
# CATALOG_DB (sqlite | postgres) is REQUIRED from the deployment — no image default. Per mode:
#   postgres: DATABASE_URL                       (nothing SQLite is touched, no /app/data writes)
#   sqlite:   DATA_DIR + SEED_DIR (seed zips + VERSION on a volume; provisioned by entrypoint.sh)

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
# the embedding-model stamp this build speaks (src/version.ts; PgMeta.verify compares it to meta.seeds)
COPY --from=build /app/VERSION ./VERSION

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

COPY --from=entry /entry /entry

EXPOSE 8979
# /entry (setup V1): wait for stack.fusion on oservices-setup, persist + report, then exec
# /entrypoint.sh (CATALOG_DB gate + sqlite provisioning + node dist/server.js) — unchanged below it.
ENTRYPOINT ["/entry"]
