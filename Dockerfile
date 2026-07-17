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

# compile the catalog from the CSV/JSON data (data/ provided via build context)
COPY data ./data
RUN node dist/compile.js && ls -la catalog.sqlite

# ---- runtime stage: node + dist + node_modules + catalog.sqlite only (CSVs dropped) ----
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV MCP_PORT=8979
ENV MCP_HOST=0.0.0.0

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/catalog.sqlite ./catalog.sqlite

EXPOSE 8979
CMD ["node", "dist/server.js"]
