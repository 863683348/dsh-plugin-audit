import test from "node:test";
import assert from "node:assert/strict";
import { applyScanToRecord, pickFiles } from "../lib/scanner.js";

test("applyScanToRecord: detects plugin structure from tree + package.json", () => {
  const record = {};
  const scan = {
    files: [{ path: "package.json", text: JSON.stringify({ name: "x", dsh: { bundle: { patch: "./cordis.patch.yml" } } }) }],
    tree: ["package.json", "cordis.patch.yml", "lib/index.js", "README.md"],
    result: { findings: [], trustScore: 100 },
    hasReadme: true,
  };
  applyScanToRecord(record, scan);
  assert.equal(record.structure.hasBundle, true);
  assert.equal(record.structure.hasPatch, true);
  assert.equal(record.structure.hasEntry, true);
  assert.equal(record.structure.dshEvidence, true);
});

test("applyScanToRecord: repo without plugin files is flagged as non-plugin", () => {
  const record = {};
  const scan = {
    files: [{ path: "package.json", text: JSON.stringify({ name: "x", main: "index.js" }) }],
    tree: ["package.json", "README.md"],
    result: { findings: [], trustScore: 100 },
    hasReadme: true,
  };
  applyScanToRecord(record, scan);
  assert.equal(record.structure.dshEvidence, false);
  assert.equal(record.structure.hasBundle, false);
  assert.equal(record.structure.hasPatch, false);
});

test("pickFiles prioritizes package.json and entries", () => {
  const picked = pickFiles(["README.md", "package.json", "lib/index.js", "scripts/install.sh", "src/other.ts"]);
  assert.ok(picked.includes("package.json"));
  assert.ok(picked.includes("lib/index.js"));
});
