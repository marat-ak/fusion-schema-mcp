import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanSources, hashSql } from "../src/corpus/sources.js";

test("hashSql is stable and text-sensitive", () => {
  assert.equal(hashSql("select 1"), hashSql("select 1"));
  assert.notEqual(hashSql("select 1"), hashSql("select 2"));
});

test("scanSources reads an OTBI file into one record", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "otbi-"));
  fs.writeFileSync(path.join(dir, "SA__T.json"), JSON.stringify({
    subjectArea: "SA", table: "T", logicalColumns: ["A"],
    physicalSqlNamed: "SELECT c1 FROM X", relations: { dbTables: ["X"] },
  }));
  const out = scanSources({ otbiDir: dir, catalogDir: dir + "_none", viewsDir: dir + "_none" });
  assert.equal(out.length, 1);
  assert.equal(out[0].source, "otbi");
  assert.equal(out[0].id, "otbi:SA__T");
  assert.equal(out[0].originalSql, "SELECT c1 FROM X");
  assert.equal(out[0].title, "SA.T");
  assert.equal(out[0].sourceHash, hashSql("SELECT c1 FROM X"));
});
