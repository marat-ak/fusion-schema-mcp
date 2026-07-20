# Multi-stage: build TS + compile catalog, then ship a lean runtime with only the SQLite catalog.
# Debian base both stages so the better-sqlite3 native module matches at runtime.

# ---- build stage: install deps, build TS, compile CSV -> catalog.sqlite ----
FROM node:22-bookworm AS build
WORKDIR /app

# native build toolchain for better-sqlite3
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Warm the bge-small embedding model into node_modules/.cache so the runtime can embed
# query intents (findSimilarQueries) offline. The catalog itself is NOT compiled in-image
# anymore (109K rows is slow to embed in-build) — it is mounted from the host at runtime
# (see docker-compose volume: ./catalog.sqlite -> /app/catalog.sqlite).
RUN node -e "import('@xenova/transformers').then(async t=>{const p=await t.pipeline('feature-extraction','Xenova/bge-small-en-v1.5');await p('warm',{pooling:'mean',normalize:true});console.log('bge-small cached');})"

# ---- runtime stage: node + dist + node_modules (with model cache); catalog is mounted ----
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV MCP_PORT=8979
ENV MCP_HOST=0.0.0.0

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

EXPOSE 8979
CMD ["node", "dist/server.js"]
