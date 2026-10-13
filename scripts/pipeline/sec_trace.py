#!/usr/bin/env python3
"""OTBI LOGLEVEL-7 trace loader — NAMES ONLY (revised phase 3, user decision 7 of 2026-10-05).

A Session Monitor export (HTML, or the browser's MHTML "save as single file") of an OTBI analysis run at LOGLEVEL 7
shows the physical SQL the BI server sent to the database — with Oracle's data-security grant blocks spliced in:

    EXISTS (SELECT NULL FROM fnd_grants gnt WHERE … cmf.function_id = <id> … gnt.object_id = <id> …
            AND (gnt.instance_set_id = <id> AND <EntityAlias>.<KEY> IN (…)))

This tool turns those blocks into curated rows of scripts/pipeline/p5_security_rules.json `areaPrivileges` (source
`trace`): per (object, privilege) the entity table that carries the block (the FROM item of <EntityAlias>), and the
TABLE.COLUMN the query joins to the entity's key — names only. Predicate text is never stored and never printed:
the evidence is the capture's file name, the number of blocks and the SHA-256 + length of their text.

Three steps (the ids are resolved on the pod through pod-mcp runSql — read-only, ONE statement — by the operator):

  1. python3 sec_trace.py extract <capture.html|.mhtml> --out <dir>
       parses the capture; writes <dir>/blocks.json (the ids per block, the entity alias / table / key and the
       joined TABLE.COLUMNs, block hashes — no predicate text) and <dir>/resolve.sql (the one statement that names
       the ids). <dir> lives under data/security/traces/ (gitignored: the ids are the pod's).
  2. run <dir>/resolve.sql through runSql on the pod the capture came from; save the reply VERBATIM as
       <dir>/resolve.json (the whole JSON, `instance` included).
  3. python3 sec_trace.py load <dir> --area "<subject area | business area | product>" --instances <host[,host…] | *>
         [--rules <p5_security_rules.json>] [--dry-run]
       ids -> names; one row per (object, privilege): {area, object, privilege, source: trace, instances, entity,
       column?, evidence}. Upsert into the rules: a row of the same (area, object) is REPLACED (an inferred row,
       or a trace row naming the same privilege); a trace row of that (area, object) naming ANOTHER privilege
       refuses the load (two traces disagree — the operator decides). --dry-run prints the rows and the plan only.
       Every argument is explicit: no default area, no default instance scope.

A release built from the rules carries the rows (p5_security.sh -> sec_area_privilege, `column` ->
context_column); docs/trace-capture-guide.md says which analyses to capture and how.
"""
from __future__ import annotations

import argparse
import email
import email.policy
import hashlib
import html
import json
import os
import re
import sys
from datetime import date

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_RULES = os.path.join(HERE, "p5_security_rules.json")

BLOCK_START = re.compile(r"EXISTS\s*\(\s*SELECT\s+NULL\s+FROM\s+fnd_grants\s+gnt\s+WHERE\b", re.I)
FUNCTION_ID = re.compile(r"cmf\.function_id\s*=\s*(\d+)", re.I)
OBJECT_ID = re.compile(r"gnt\.object_id\s*=\s*(\d+)", re.I)
INSTANCE_TYPE = re.compile(r"gnt\.instance_type\s*=\s*'([A-Z_]+)'", re.I)
# the instance-set branch: the set id, then the entity alias + key the condition filters (optionally inside TO_CHAR / parens)
SET_BRANCH = re.compile(r"gnt\.instance_set_id\s*=\s*(\d+)\s+AND\s+\(*\s*(?:TO_CHAR\s*\(\s*)?([A-Za-z_][\w$#]*)\.([A-Za-z_][\w$#]*)", re.I)
IDENT = r"[A-Za-z_][\w$#]*"
KEYWORDS = {"AND", "OR", "NOT", "ON", "IN", "IS", "AS", "BY", "SELECT", "FROM", "WHERE", "JOIN", "LEFT", "RIGHT", "INNER", "OUTER",
            "FULL", "CROSS", "UNION", "ALL", "EXISTS", "NULL", "CASE", "WHEN", "THEN", "ELSE", "END", "DISTINCT", "WITH", "ORDER", "GROUP"}


def read_bytes(path: str) -> bytes:
    with open(path, "rb") as f:
        return f.read()


def read_json(path: str):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def capture_text(path: str) -> str:
    """The plain text of a Session Monitor export (HTML, or MHTML: its text/html part, transfer-decoded)."""
    raw = read_bytes(path)
    if path.lower().endswith((".mhtml", ".mht")):
        msg = email.message_from_bytes(raw, policy=email.policy.default)
        parts = [p for p in msg.walk() if p.get_content_type() == "text/html"]
        if not parts:
            raise SystemExit(f"{path}: no text/html part in the MHTML archive")
        doc = parts[0].get_content()
    else:
        doc = raw.decode("utf-8", errors="replace")
    doc = re.sub(r"<(script|style)\b.*?</\1>", " ", doc, flags=re.S | re.I)
    return html.unescape(re.sub(r"<[^>]+>", " ", doc))


def closing(text: str, open_pos: int) -> int:
    """The index of the ')' closing the '(' at open_pos (quoted literals skipped); -1 when it never closes."""
    depth, i, n = 0, open_pos, len(text)
    while i < n:
        c = text[i]
        if c == "'":
            j = text.find("'", i + 1)
            while j != -1 and j + 1 < n and text[j + 1] == "'":
                j = text.find("'", j + 2)
            if j == -1:
                return -1
            i = j + 1
            continue
        if c == "(":
            depth += 1
        elif c == ")":
            depth -= 1
            if depth == 0:
                return i
        i += 1
    return -1


def table_of(chunk: str, alias: str) -> str | None:
    """The FROM item an alias names inside one statement (schema prefix dropped); None when absent or ambiguous."""
    found = set()
    for m in re.finditer(rf"(?<![\w$#.])((?:{IDENT}\.)?{IDENT})\s+{re.escape(alias)}(?![\w$#.])", chunk):
        name = m.group(1).split(".")[-1]
        if name.upper() in KEYWORDS or name == alias:
            continue
        found.add(name.upper())
    return found.pop() if len(found) == 1 else None


def joins_of(chunk: str, alias: str, key: str) -> set[str]:
    """Every TABLE.COLUMN the statement equates with <alias>.<key> (outer-join marks allowed)."""
    out = set()
    a, k = re.escape(alias), re.escape(key)
    pats = [rf"({IDENT})\.({IDENT})\s*(?:\(\+\))?\s*=\s*{a}\.{k}(?![\w$#])", rf"(?<![\w$#.]){a}\.{k}\s*(?:\(\+\))?\s*=\s*({IDENT})\.({IDENT})"]
    for p in pats:
        for m in re.finditer(p, chunk):
            other, col = m.group(1), m.group(2)
            if other == alias or other.lower() in ("gnt", "cmf"):
                continue
            t = table_of(chunk, other)
            if t:
                out.add(f"{t}.{col.upper()}")
    return out


def extract(path: str, out_dir: str) -> dict:
    text = capture_text(path)
    chunks = re.findall(r"\[\[(.*?)\]\]", text, flags=re.S)
    pairs: dict[tuple[str, str], dict] = {}
    statements = 0
    for chunk in chunks:
        starts = [m for m in BLOCK_START.finditer(chunk)]
        if not starts:
            continue
        statements += 1
        for m in starts:
            open_pos = chunk.index("(", m.start())
            end = closing(chunk, open_pos)
            if end < 0:
                raise SystemExit(f"{path}: a grant block never closes (the capture is cut) — capture the analysis again")
            block = chunk[m.start(): end + 1]
            fid, oid = FUNCTION_ID.search(block), OBJECT_ID.search(block)
            if not fid or not oid:
                raise SystemExit(f"{path}: a grant block without a function id / object id — not a data-security block the loader knows")
            key = (oid.group(1), fid.group(1))
            p = pairs.setdefault(key, {"objectId": key[0], "functionId": key[1], "instanceTypes": set(), "instanceSetIds": set(),
                                        "entities": {}, "blocks": 0, "hash": hashlib.sha256(), "chars": 0, "seen": set()})
            it = INSTANCE_TYPE.search(block)
            if it:
                p["instanceTypes"].add(it.group(1).upper())
            norm = re.sub(r"\s+", " ", block).strip()
            if norm not in p["seen"]:  # the same block repeated in another statement counts once
                p["seen"].add(norm)
                p["blocks"] += 1
                p["hash"].update(norm.encode("utf-8"))
                p["chars"] += len(norm)
            for s in SET_BRANCH.finditer(block):
                set_id, alias, col = s.group(1), s.group(2), s.group(3)
                p["instanceSetIds"].add(set_id)
                if alias.lower() in ("gnt", "urd", "cmf"):
                    continue
                ent = table_of(chunk, alias)
                e = p["entities"].setdefault(f"{alias}.{col.upper()}", {"alias": alias, "key": col.upper(), "tables": set(), "joins": set()})
                if ent:
                    e["tables"].add(ent)
                e["joins"] |= joins_of(chunk, alias, col)
    if not pairs:
        raise SystemExit(f"{path}: no fnd_grants block in the capture — was the analysis run at LOGLEVEL 7 and the physical SQL logged?")
    doc = {
        "capture": os.path.basename(path), "fileSha256": hashlib.sha256(read_bytes(path)).hexdigest(),
        "extractedAt": date.today().isoformat(), "statements": statements,
        "pairs": [{
            "objectId": p["objectId"], "functionId": p["functionId"], "instanceTypes": sorted(p["instanceTypes"]),
            "instanceSetIds": sorted(p["instanceSetIds"]), "blocks": p["blocks"], "blocksSha256": p["hash"].hexdigest(), "blocksChars": p["chars"],
            "entities": [{"alias": e["alias"], "key": e["key"], "tables": sorted(e["tables"]), "joins": sorted(e["joins"])} for e in p["entities"].values()],
        } for p in sorted(pairs.values(), key=lambda x: (x["objectId"], x["functionId"]))],
    }
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, "blocks.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(doc, f, indent=1)
        f.write("\n")
    ids = lambda k: ", ".join(sorted({x for p in doc["pairs"] for x in ([p[k]] if isinstance(p[k], str) else p[k])}, key=int)) or "NULL"
    resolve = (
        "SELECT 'FUNCTION' AS kind, TO_CHAR(function_id) AS id, function_name AS name FROM fnd_form_functions WHERE function_id IN (" + ids("functionId") + ")\n"
        "UNION ALL SELECT 'OBJECT', TO_CHAR(object_id), obj_name FROM fnd_objects WHERE object_id IN (" + ids("objectId") + ")\n"
        "UNION ALL SELECT 'INSTANCE_SET', TO_CHAR(instance_set_id), instance_set_name FROM fnd_object_instance_sets WHERE instance_set_id IN (" + ids("instanceSetIds") + ")\n"
        "ORDER BY 1, 2\n")
    with open(os.path.join(out_dir, "resolve.sql"), "w", encoding="utf-8", newline="\n") as f:
        f.write(resolve)
    return doc


def names_from(reply_path: str) -> tuple[str, dict[str, dict[str, str]]]:
    j = read_json(reply_path)
    rows = j.get("rows")
    if not isinstance(rows, list) or len(rows) != j.get("rowCount") or "rowsInline" in j or "fileId" in j or j.get("truncated"):
        raise SystemExit(f"{reply_path}: not a complete inline runSql reply (rows / rowCount / truncated)")
    if not j.get("instance"):
        raise SystemExit(f"{reply_path}: the reply names no `instance` — save the runSql reply verbatim")
    out: dict[str, dict[str, str]] = {"FUNCTION": {}, "OBJECT": {}, "INSTANCE_SET": {}}
    for r in rows:
        out.setdefault(str(r["KIND"]), {})[str(r["ID"])] = str(r["NAME"])
    return j["instance"], out


def rows_of(doc: dict, names: dict[str, dict[str, str]], resolved_on: str, area: str, instances: list[str]) -> tuple[list[dict], list[str]]:
    rows, notes = [], []
    for p in doc["pairs"]:
        obj, priv = names["OBJECT"].get(p["objectId"]), names["FUNCTION"].get(p["functionId"])
        if not obj or not priv:
            raise SystemExit(f"resolve.json does not name object {p['objectId']} / function {p['functionId']} — run resolve.sql on the pod the capture came from")
        tables = sorted({t for e in p["entities"] for t in e["tables"]})
        joins = sorted({j for e in p["entities"] for j in e["joins"]})
        row = {"area": area, "object": obj, "privilege": priv, "source": "trace", "instances": instances}
        if len(tables) == 1:
            row["entity"] = tables[0]
        else:
            notes.append(f"{obj} / {priv}: {'no entity alias resolved' if not tables else 'several entity tables ' + ', '.join(tables)} — the row stays area-level (no entity)")
        if len(joins) == 1:
            row["column"] = joins[0]
        elif joins:
            notes.append(f"{obj} / {priv}: the entity key is joined by {len(joins)} columns ({', '.join(joins)}) — no `column` (one per row)")
        sets = sorted(names["INSTANCE_SET"].get(s, s) for s in p["instanceSetIds"])
        ent = p["entities"][0] if p["entities"] else None
        row["evidence"] = (f"OTBI LOGLEVEL-7 trace {doc['capture']} ({doc['extractedAt']}, ids resolved on {resolved_on}): {p['blocks']} grant block(s) on "
                           f"{obj} / {priv} in {doc['statements']} statement(s)"
                           + (f", entity {row.get('entity', '?')} (alias {ent['alias']}, key {ent['key']})" if ent else "")
                           + (f" joined by {row['column']}" if "column" in row else "")
                           + f"; instance types {'/'.join(p['instanceTypes']) or '?'}, {len(sets)} instance set(s); "
                           f"blocks SHA-256 {p['blocksSha256']}, {p['blocksChars']:,} chars (the trace stays local, untracked; no predicate text here)")
        rows.append(row)
    return rows, notes


# ---- the rules file: upsert rows inside areaPrivileges.rows, every other byte kept ---------------------------------

def scan_array(text: str, start: int) -> tuple[int, list[tuple[int, int]]]:
    """From the '[' at start: (index of the closing ']', [(begin, end) of every top-level element])."""
    depth, i, n, elems, cur = 0, start, len(text), [], None
    while i < n:
        c = text[i]
        if c == '"':
            i += 1
            while text[i] != '"':
                i += 2 if text[i] == "\\" else 1
        elif c in "[{":
            depth += 1
            if depth == 2 and c == "{":
                cur = i
        elif c in "]}":
            if depth == 2 and c == "}" and cur is not None:
                elems.append((cur, i + 1))
                cur = None
            depth -= 1
            if depth == 0:
                return i, elems
        i += 1
    raise SystemExit("the rules file's areaPrivileges.rows array never closes")


def row_text(r: dict) -> str:
    head = {k: r[k] for k in ("area", "object", "privilege", "source", "instances", "entity", "column") if k in r}
    body = json.dumps(head, ensure_ascii=False)[:-1]
    return f"      {body},\n        \"evidence\": {json.dumps(r['evidence'], ensure_ascii=False)} }}"


def upsert(rules_path: str, new_rows: list[dict], dry: bool) -> list[str]:
    text = read_bytes(rules_path).decode("utf-8")
    doc = json.loads(text)
    rows = doc["areaPrivileges"]["rows"]
    a = text.index('"areaPrivileges"')
    b = text.index('"rows"', a)
    open_pos = text.index("[", b)
    close_pos, spans = scan_array(text, open_pos)
    if len(spans) != len(rows):
        raise SystemExit(f"the rules file's areaPrivileges.rows parse disagrees ({len(spans)} spans, {len(rows)} rows) — edit it by hand")
    # every element keeps its own text and the separator that follows it (blank lines between groups survive)
    elems = [[text[s:e], text[e:spans[i + 1][0]] if i + 1 < len(spans) else None] for i, (s, e) in enumerate(spans)]
    head, tail = text[:spans[0][0]], text[spans[-1][1]:]
    indent = text[text.rfind("\n", 0, spans[0][0]) + 1: spans[0][0]]
    plan = []
    for nr in new_rows:
        same = [i for i, r in enumerate(rows) if r.get("area") == nr["area"] and r.get("object") == nr["object"]]
        clash = [rows[i] for i in same if rows[i].get("source") == "trace" and rows[i].get("privilege") != nr["privilege"]]
        if clash:
            raise SystemExit(f"refused: the rules already carry a TRACE row {nr['area']} / {nr['object']} -> {clash[0]['privilege']}, this trace says "
                             f"{nr['privilege']} — two traces disagree; decide by hand")
        if same:
            plan.append(f"replace {nr['area']} / {nr['object']}: " + "; ".join(f"{rows[i].get('privilege')} ({rows[i].get('source')}, entity {rows[i].get('entity', '-')})" for i in same)
                        + f" -> {nr['privilege']} (trace, entity {nr.get('entity', '-')}, column {nr.get('column', '-')})")
            rows[same[0]] = nr
            elems[same[0]][0] = row_text(nr).lstrip()
            for i in sorted(same[1:], reverse=True):
                del rows[i], elems[i]
            elems[-1][1] = None
        else:
            plan.append(f"add {nr['area']} / {nr['object']} -> {nr['privilege']} (trace, entity {nr.get('entity', '-')}, column {nr.get('column', '-')})")
            rows.append(nr)
            elems[-1][1] = ",\n" + indent
            elems.append([row_text(nr).lstrip(), None])
    if not dry:
        out = head + "".join(e + (g or "") for e, g in elems) + tail
        if json.loads(out)["areaPrivileges"]["rows"] != rows:
            raise SystemExit("internal: the rewritten rules do not parse back to the planned rows — nothing written")
        with open(rules_path, "w", encoding="utf-8", newline="\n") as f:
            f.write(out)
    return plan


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    e = sub.add_parser("extract")
    e.add_argument("capture")
    e.add_argument("--out", required=True)
    l = sub.add_parser("load")
    l.add_argument("dir")
    l.add_argument("--area", required=True)
    l.add_argument("--instances", required=True, help="comma-separated pod hosts exactly as runSql reports `instance`, or *")
    l.add_argument("--rules", default=DEFAULT_RULES)
    l.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    if a.cmd == "extract":
        doc = extract(a.capture, a.out)
        print(f"[trace] {doc['capture']}: {doc['statements']} statement(s) with grant blocks, {len(doc['pairs'])} (object, privilege) pair(s) "
              f"-> {a.out}/blocks.json + resolve.sql (run it through runSql on the capture's pod; save the reply as {a.out}/resolve.json)")
        for p in doc["pairs"]:
            ents = "; ".join(f"{e['alias']}.{e['key']} = {','.join(e['tables']) or '?'} joined by {','.join(e['joins']) or '-'}" for e in p["entities"])
            print(f"  object {p['objectId']} / function {p['functionId']}: {p['blocks']} block(s), {'/'.join(p['instanceTypes'])}; {ents or 'no entity alias'}")
        return
    area = a.area.strip()
    instances = [x.strip() for x in a.instances.split(",") if x.strip()]
    if not area or not instances or ("*" in instances and len(instances) > 1):
        raise SystemExit("--area and --instances are required: an area name, and pod hosts or exactly *")
    doc = read_json(os.path.join(a.dir, "blocks.json"))
    resolved_on, names = names_from(os.path.join(a.dir, "resolve.json"))
    rows, notes = rows_of(doc, names, resolved_on, area, instances)
    for r in rows:
        print("[trace] row " + json.dumps({k: v for k, v in r.items() if k != "evidence"}, ensure_ascii=False))
    for n in notes:
        print(f"[trace] note: {n}")
    plan = upsert(a.rules, rows, a.dry_run)
    for p in plan:
        print(f"[trace] {'would ' if a.dry_run else ''}{p}")
    print(f"[trace] {'dry run — nothing written' if a.dry_run else 'written: ' + a.rules + ' (a new release label carries it)'}")


if __name__ == "__main__":
    main()
