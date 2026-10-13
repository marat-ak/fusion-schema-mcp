"""Unit tests of scripts/pipeline/sec_trace.py (the names-only OTBI trace loader) on a SYNTHETIC Session Monitor
capture — made-up ids, made-up instance-set text; no pod data. Run in the CloudBeaver distro:

    wsl -d CloudBeaver -u root -e bash -lc 'cd /mnt/c/.../fusion-schema-mcp && python3 -m unittest test/test_sec_trace.py -v'
"""
import email.policy
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from email.message import EmailMessage

HERE = os.path.dirname(os.path.abspath(__file__))
PIPE = os.path.join(HERE, "..", "scripts", "pipeline")
sys.path.insert(0, PIPE)
import sec_trace  # noqa: E402

MARK = "SYNTHETIC_PREDICATE_TEXT_MARKER"
BLOCK = ("EXISTS (SELECT NULL FROM fnd_grants gnt WHERE exists (select /*+ no_unnest */ null from fnd_compiled_menu_functions cmf "
         "where cmf.function_id = {fid} and cmf.menu_id = gnt.menu_id) AND gnt.object_id = {oid} AND gnt.grant_type = 'ALLOW' "
         "AND gnt.instance_type = 'SET' AND (gnt.instance_set_id = {sid} AND Unit.UNIT_ID IN (SELECT x.unit_id FROM zz_access x "
         "WHERE x.note = '" + MARK + " it''s quoted (' AND x.flag != 'N')))")
SQL = ("SELECT Head.AMOUNT FROM (SELECT Head.AMOUNT FROM ZZ_HEADERS_ALL Head, ZZ_UNITS_V Unit, ZZ_LINES Line "
       "WHERE Head.UNIT_ID = Unit.UNIT_ID AND Line.HEADER_ID(+) = Head.HEADER_ID AND (( (1=1) OR "
       + BLOCK.format(fid=900000000000011, oid=900000000000021, sid=900000000000031) + " OR "
       + BLOCK.format(fid=900000000000011, oid=900000000000021, sid=900000000000032) + "))) V1")
PAGE = ("<html><body><table><tr><td>[2026-10-05] Sending query to database named zz (id: &lt;&lt;1&gt;&gt;): [[\n"
        + SQL.replace("<", "&lt;").replace(">", "&gt;") + "\n]]</td></tr>"
        "<tr><td>Sending query to database named zz: [[\n" + SQL.replace("<", "&lt;").replace(">", "&gt;") + "\n]]</td></tr></table></body></html>")
RESOLVE = {"instance": "pod.example.test", "columns": [{"name": "KIND"}, {"name": "ID"}, {"name": "NAME"}],
           "rows": [{"KIND": "FUNCTION", "ID": "900000000000011", "NAME": "ZZ_VIEW_THING_DATA"},
                    {"KIND": "OBJECT", "ID": "900000000000021", "NAME": "ZZ_UNITS_OBJ"},
                    {"KIND": "INSTANCE_SET", "ID": "900000000000031", "NAME": "ZZUNITSSTD"},
                    {"KIND": "INSTANCE_SET", "ID": "900000000000032", "NAME": "ZZUNITSINTERCO"}],
           "rowCount": 4, "maxRows": 50, "truncated": False, "elapsedMs": 1}
RULES = """{
  "version": "x",
  "areaPrivileges": {
    "_doc": "test",
    "rows": [
      { "area": "Things", "object": "ZZ_UNITS_OBJ", "privilege": "ZZ_OTHER_DATA", "source": "inferred", "instances": ["*"],
        "evidence": "a guess" },

      { "area": "Other", "object": "ZZ_X", "privilege": "ZZ_X_DATA", "source": "trace", "instances": ["*"], "evidence": "kept" }
    ]
  },
  "tail": true
}
"""


class TraceLoaderTest(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(prefix="sectrace-")
        self.html = os.path.join(self.d, "capture.html")
        with open(self.html, "w", encoding="utf-8") as f:
            f.write(PAGE)

    def tearDown(self):
        shutil.rmtree(self.d)

    def extract(self, path, name):
        out = os.path.join(self.d, name)
        doc = sec_trace.extract(path, out)
        with open(os.path.join(out, "resolve.json"), "w", encoding="utf-8") as f:
            json.dump(RESOLVE, f)
        return out, doc

    def test_extract_names_entity_and_join_never_the_text(self):
        out, doc = self.extract(self.html, "t1")
        self.assertEqual(doc["statements"], 2)
        self.assertEqual(len(doc["pairs"]), 1)
        p = doc["pairs"][0]
        self.assertEqual((p["objectId"], p["functionId"]), ("900000000000021", "900000000000011"))
        self.assertEqual(p["blocks"], 2, "the same two blocks in two statements count once")
        self.assertEqual(p["instanceSetIds"], ["900000000000031", "900000000000032"])
        self.assertEqual(p["entities"], [{"alias": "Unit", "key": "UNIT_ID", "tables": ["ZZ_UNITS_V"], "joins": ["ZZ_HEADERS_ALL.UNIT_ID"]}])
        for f in ("blocks.json", "resolve.sql"):
            self.assertNotIn(MARK, open(os.path.join(out, f), encoding="utf-8").read(), f"{f} carries predicate text")
        sql = open(os.path.join(out, "resolve.sql"), encoding="utf-8").read()
        for i in ("900000000000011", "900000000000021", "900000000000031", "900000000000032"):
            self.assertIn(i, sql)

    def test_mhtml_equals_html(self):
        msg = EmailMessage(policy=email.policy.default)
        msg["Subject"] = "Session Monitor"
        msg.make_mixed()
        part = EmailMessage(policy=email.policy.default)
        part.set_content(PAGE, subtype="html", cte="quoted-printable")
        msg.attach(part)
        mh = os.path.join(self.d, "capture.mhtml")
        with open(mh, "wb") as f:
            f.write(msg.as_bytes())
        _, a = self.extract(self.html, "h")
        _, b = self.extract(mh, "m")
        self.assertEqual(a["pairs"], b["pairs"])

    def test_load_rows_upsert_refuse_and_identity(self):
        out, doc = self.extract(self.html, "t2")
        rules = os.path.join(self.d, "rules.json")
        with open(rules, "w", encoding="utf-8") as f:
            f.write(RULES)
        inst, names = sec_trace.names_from(os.path.join(out, "resolve.json"))
        rows, notes = sec_trace.rows_of(doc, names, inst, "Things", ["*"])
        self.assertEqual(notes, [])
        self.assertEqual({k: v for k, v in rows[0].items() if k != "evidence"},
                         {"area": "Things", "object": "ZZ_UNITS_OBJ", "privilege": "ZZ_VIEW_THING_DATA", "source": "trace", "instances": ["*"],
                          "entity": "ZZ_UNITS_V", "column": "ZZ_HEADERS_ALL.UNIT_ID"})
        self.assertNotIn(MARK, rows[0]["evidence"])
        self.assertNotIn("900000000000021", rows[0]["evidence"], "no pod id in a curated row")
        # a no-op rewrite keeps every byte (blank lines between groups included)
        self.assertEqual(sec_trace.upsert(rules, [], False), [])
        self.assertEqual(open(rules, encoding="utf-8").read(), RULES)
        # the inferred row of the same (area, object) is replaced; the other rows and the file around them stay
        plan = sec_trace.upsert(rules, rows, False)
        self.assertTrue(plan[0].startswith("replace Things / ZZ_UNITS_OBJ"))
        after = json.load(open(rules, encoding="utf-8"))
        self.assertEqual([r["privilege"] for r in after["areaPrivileges"]["rows"]], ["ZZ_VIEW_THING_DATA", "ZZ_X_DATA"])
        self.assertTrue(after["tail"])
        # a second trace that names another privilege for the same (area, object) is refused
        other = dict(rows[0], privilege="ZZ_MANAGE_THING_DATA")
        with self.assertRaises(SystemExit):
            sec_trace.upsert(rules, [other], False)
        # a new (area, object) is appended
        plan = sec_trace.upsert(rules, [dict(rows[0], area="More")], False)
        self.assertTrue(plan[0].startswith("add More / ZZ_UNITS_OBJ"))
        self.assertEqual(len(json.load(open(rules, encoding="utf-8"))["areaPrivileges"]["rows"]), 3)

    def test_cli_requires_area_and_instances(self):
        out, _ = self.extract(self.html, "t3")
        r = subprocess.run([sys.executable, os.path.join(PIPE, "sec_trace.py"), "load", out, "--instances", "*", "--dry-run"], capture_output=True, text=True)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("--area", r.stderr)


if __name__ == "__main__":
    unittest.main()
