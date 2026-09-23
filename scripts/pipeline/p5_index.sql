-- ============================================================================
-- P5c — pgvector ANN indexes on the searched embedding columns.
--
-- MEASURED on this build (97,802 multi-vectors, 26,204 rows, 384 dims, pgvector
-- 0.8.6, single-threaded build, maintenance_work_mem 1GB):
--
--   index                    build    size    recall@40 (default)   recall@40 (tuned)   ms/probe
--   IVFFlat lists=312         3.2 s  154 MB   61.07 % (probes=1)    99.88 % (probes=50)  0.56 -> 7.55
--   HNSW m=16 efc=64         31.0 s  185 MB   94.71 % (ef=40)      100.00 % (ef=100)     1.37 -> 1.45
--   exact sequential scan       --       --   100 % by definition        --             23.3
--
-- PICK: HNSW. IVFFlat wins the literal build-time comparison (3.2 s vs 31 s), but
-- a release index is built ONCE offline and queried on every tool call: HNSW
-- reaches FULL recall at 1.45 ms where IVFFlat needs probes=50 to get to 99.88 %
-- and costs 7.55 ms doing it. 31 s of build time buys a 16x faster search with no
-- measured loss.
--
-- !! EXACTNESS !! `PgCorpus.knn` is documented as EXACT precisely so its
-- `1 - d²/2` score matches what sqlite-vec returned, and the planner WILL use
-- these indexes. At pgvector's DEFAULT `hnsw.ef_search = 40` recall@10 measured
-- 95.0 %, i.e. one of twenty top-10 results changes. It is 100.0 % at
-- `hnsw.ef_search = 100` for +0.08 ms — but nothing in the serving code sets that
-- GUC, so making the index safe needs `hnsw.ef_search: "100"` added to the
-- PostgresProvider pool's `connection` parameters. Until that lands, these
-- indexes trade 5 % of the top-10 for the latency. See the spec's open decisions.
-- ============================================================================
\set ON_ERROR_STOP on

SET maintenance_work_mem = '1GB';
-- parallel HNSW build needs a shared-memory segment larger than the container's
-- /dev/shm; single-threaded is the difference between 31 s and a hard failure.
SET max_parallel_maintenance_workers = 0;

DROP INDEX IF EXISTS {{V}}.ix_rq_embedding_hnsw;
DROP INDEX IF EXISTS {{V}}.ix_rq_multi_embedding_hnsw;
DROP INDEX IF EXISTS {{V}}.ix_layout_vec_embedding_hnsw;

-- multi-vector KNN: what findSimilarQueries actually searches
CREATE INDEX ix_rq_multi_embedding_hnsw
  ON {{V}}.report_queries_vec_multi USING hnsw (embedding vector_l2_ops);

-- single-vector KNN: the fallback path when a corpus has no multi vectors
CREATE INDEX ix_rq_embedding_hnsw
  ON {{V}}.report_queries USING hnsw (embedding vector_l2_ops);

-- layout-pattern KNN (224 vectors — an index is not needed at this size, it is
-- here so every SEARCHED embedding column is indexed the same way)
CREATE INDEX ix_layout_vec_embedding_hnsw
  ON {{V}}.layout_patterns_vec USING hnsw (embedding vector_l2_ops);

-- NOT indexed: {{V}}.col_vec.vec. It is a column-text embedding CACHE that is
-- only ever read by `WHERE hash IN (...)` (src/db/base/colCache.ts) — no distance
-- query touches it, so a vector index there would be dead weight. Reported rather
-- than silently built or silently skipped.

ANALYZE {{V}}.report_queries_vec_multi;
ANALYZE {{V}}.report_queries;
ANALYZE {{V}}.layout_patterns_vec;

SELECT indexname, pg_size_pretty(pg_relation_size('{{V}}.' || indexname)) AS size
FROM   pg_indexes WHERE schemaname = '{{V}}' AND indexdef LIKE '%hnsw%' ORDER BY 1;
