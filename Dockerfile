# Multi-stage: build TS, compile the split seed DBs, then ship a lean self-provisioning runtime.
# Debian base both stages so the better-sqlite3 native module matches at runtime.

# ---- build stage: install deps, build TS, compile CSV -> schema.sqlite + reports.sqlite seed ----
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
RUN npm run build
# non-TS corpus assets ride along into dist (tsc copies only .ts): layout-pattern JSONL + fixtures.
# shard-* dirs are curation provenance (experiments, render-check PNGs) — merged into the main
# patterns.jsonl already, so they stay out of the image.
RUN cp -r src/corpus/layoutPatterns dist/corpus/layoutPatterns \
    && rm -rf dist/corpus/layoutPatterns/shard-*

# Warm the bge-small embedding model into node_modules/.cache so the runtime can embed query intents
# (findSimilarQueries) and re-embed during provisioning, offline.
RUN node -e "import('@xenova/transformers').then(async t=>{const p=await t.pipeline('feature-extraction','Xenova/bge-small-en-v1.5');await p('warm',{pooling:'mean',normalize:true});console.log('bge-small cached');})"

# Compile the seed DBs from the DB_SCHEMA CSVs (data/ must be present in the build context; the
# report corpus is EMPTY in CI because data/enrich.sqlite is .dockerignored — that is expected, the
# real corpus is populated at runtime by the poller /ingest or restored via migrate-split). Then zip
# the seeds so provision.js can unpack them into the /app/data volume on first start.
COPY data ./data
RUN npm run compile && node dist/zip-seed.js

# ---- runtime stage: node + dist + node_modules (model cache) + baked seed; DBs live on a volume ----
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV MCP_PORT=8979
ENV MCP_HOST=0.0.0.0
ENV DATA_DIR=/app/data
ENV SEED_DIR=/app/seed

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

# Baked, versioned seed — NOT under /app/data (the volume mount would mask it).
COPY --from=build /app/schema.sqlite.zip /app/seed/schema.sqlite.zip
COPY --from=build /app/reports.sqlite.zip /app/seed/reports.sqlite.zip
COPY --from=build /app/VERSION /app/seed/VERSION

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8979
# entrypoint self-provisions the /app/data volume from /app/seed, then starts the server.
ENTRYPOINT ["/entrypoint.sh"]
