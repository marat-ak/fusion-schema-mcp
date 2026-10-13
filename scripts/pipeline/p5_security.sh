#!/usr/bin/env bash
# P5f — fill the data-access security facts of a release schema from the release dictionary + `work`
# (after p5_fill.sql, before p5_index.sql).
#
#   wsl -d CloudBeaver -u root -e bash -lc 'bash /mnt/c/.../scripts/pipeline/p5_security.sh v2027_07'
#
# A step of the chain for the release being BUILT: table_security / table_disallowed /
# sec_area_privilege / table_reference_family / sec_meta come from p5_ddl.sh (ddl.sql ddl_version 10). NEVER run against a
# release that is already built — fusion_dev.v<ver> is immutable after p7_own.sql; a content change (a
# rule, an area-map row, a new policy extract) is a new label through the full chain. One transaction,
# DELETE + INSERT. NAMES ONLY (spec 2026-10-02 §7): no predicate text, no pod id is computed or shipped,
# and nothing of any customer pod (ddl_version 9: the pod export copies are gone — the customer layer
# carries what differs per pod).
# The curated rules (p5_security_rules.json, next to this script) are spliced into the staged SQL
# verbatim; Oracle's seeded policy extract (oracle_datasec_policies.csv, next to this script — a LOCAL,
# gitignored input: instance-set predicate text read from a pod) is staged in stack-db at
# /tmp/p5policy.csv, where the job's psql \copy reads it; only the names its parse yields reach the release.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
V="${1:-}"
[[ "$V" =~ ^v[0-9]{4}_[0-9]{2}$ ]] || { echo "usage: $(basename "$0") <ver>   (v<YYYY_MM>, the label is REQUIRED — a default would target a distributed release)"; exit 2; }
DB="${DB:-fusion_dev}"
RULES="$HERE/p5_security_rules.json"
POLICIES="$HERE/oracle_datasec_policies.csv"
[ -f "$RULES" ] || { echo "[p5f] rules file not found: $RULES"; exit 1; }
[ -f "$POLICIES" ] || { echo "[p5f] Oracle policy extract not found: $POLICIES (a local input, gitignored — see scripts/pipeline/README.md)"; exit 1; }
STAGE=/tmp/pipeline-p5
mkdir -p "$STAGE"
OUT="$STAGE/${V}-security.sql"

sed -e "s/{{V}}/$V/g" -e "/^{{RULES}}\$/{r $RULES" -e 'd' -e '}' "$HERE/p5_security.sql" > "$OUT"
grep -qx '{{RULES}}' "$OUT" && { echo "[p5f] rules were not spliced into $OUT"; exit 1; }
docker cp "$POLICIES" stack-db:/tmp/p5policy.csv >/dev/null
docker cp "$OUT" stack-db:/tmp/p5security.sql >/dev/null
docker exec -i stack-db psql -U postgres -d "$DB" -X -P pager=off -v ON_ERROR_STOP=1 -f /tmp/p5security.sql
echo "[p5f] $V.table_security / table_disallowed / sec_area_privilege / table_reference_family / sec_meta filled (db $DB)"
