#!/bin/sh
# Container entrypoint: self-provision/upgrade the split DBs from the baked seed, then start the MCP.
# provision.js compares /app/seed/VERSION to the on-disk schema.sqlite meta and seeds/refreshes the
# /app/data volume (schema.sqlite + reports.sqlite + cache.sqlite) before the server binds.
set -e

node /app/dist/provision.js

exec node /app/dist/server.js
