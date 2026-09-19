# Catalog release pipeline — emulation scripts

Dev-only. Builds the `work` schema in `fusion_dev` and runs the full raw→release pipeline with
`v2026_09` as an ORACLE in place of sqlglot / the LLM / the embedder. Validates the control flow —
queue queries, the sweep loop, view dependency ordering — without spending money or hours.

Spec: `docs/superpowers/specs/2026-09-19-catalog-release-pipeline.md` (parent repo).

## Run order

| file | step |
|---|---|
| `w0.sql`         | build `work` acquisition tables from `raw` |
| `s1_norm_fix.sql`| `norm_sql` + `bip_id`; verifies 6,389/6,389 bip ids |
| `s1_units.sql`   | S1 mint units + unit_ref |
| `s1_fix_dec.sql` | `dec_xml`; decode + trim view SQL |
| `s2_canon.sql`   | S2 canonicalize (otbi only) + aliases |
| `s3_parse.sql`   | S3 facts from oracle + `active_unit` view + exclusions |
| `s4s5_rounds.sql`| S4 grounding + S5 enrich, sweep loop to fixpoint |
| `s6s7.sql`       | S6 embeddings, S7 relationships |
| `s8s10.sql`      | S8 assemble `v2026_10`, S9 registries, S10 index + gate |

```bash
wsl -d CloudBeaver -u root -e bash -lc \
  'docker cp <file>.sql stack-db:/tmp/ && docker exec stack-db psql -U postgres -d fusion_dev -f /tmp/<file>.sql'
```

## Invariants

- Writes ONLY to `work` and `v2026_10`. `raw` and `v2026_09` are read-only inputs.
- `s2_canon.sql` inserts non-otbi rows into `canonical_unit`; they are removed afterwards
  (see the spec's defect #3). Re-running it needs that cleanup repeated, or the INSERT dropped.
- Re-running any script is safe: every INSERT is `NOT EXISTS` / `ON CONFLICT DO NOTHING` guarded.
