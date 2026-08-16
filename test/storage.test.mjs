import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../lib/storage.js";

function freshStorage() {
  const dir = mkdtempSync(join(tmpdir(), "dsh-audit-test-"));
  const storage = new Storage(dir).ensureDir();
  return { storage, dir };
}

test("catalog roundtrip: merge adds and updates, never drops old fields", () => {
  const { storage, dir } = freshStorage();
  try {
    const first = storage.mergeRecords([{ repo: "a/b", stars: 1, npm: null }]);
    assert.equal(first.added, 1);
    const second = storage.mergeRecords([{ repo: "a/b", stars: 5 }]); // npm absent on purpose
    assert.equal(second.added, 0);
    assert.equal(second.updated, 1);
    const rec = storage.loadCatalog()[0];
    assert.equal(rec.stars, 5);        // fresh wins
    assert.equal(rec.npm, null);       // old value preserved
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("meta roundtrip and getSummary counts", () => {
  const { storage, dir } = freshStorage();
  try {
    storage.mergeRecords([
      { repo: "a/b", stars: 1, curated: true, npm: { exists: true } },
      { repo: "c/d", stars: 2, curated: false, npm: null },
      { repo: "e/f", stars: 3, curated: true, npm: null, gone: true },
    ]);
    const meta = storage.loadMeta();
    meta.lastSyncAt = "2026-08-16T00:00:00Z";
    storage.saveMeta(meta);
    const s = storage.getSummary();
    assert.equal(s.total, 3);
    assert.equal(s.curated, 2);
    assert.equal(s.gone, 1);
    assert.equal(s.lastSyncAt, "2026-08-16T00:00:00Z");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("star history is capped and idempotent", () => {
  const { storage, dir } = freshStorage();
  try {
    for (let i = 0; i < 100; i++) storage.appendStars("a/b", i, "2026-08-" + String((i % 28) + 1).padStart(2, "0"));
    const hist = storage.loadHistory();
    assert.ok(hist["a/b"].length <= 60);
    const before = storage.loadHistory()["a/b"].length;
    storage.appendStars("a/b", hist["a/b"][hist["a/b"].length - 1].stars, hist["a/b"][hist["a/b"].length - 1].date);
    assert.equal(storage.loadHistory()["a/b"].length, before); // no duplicate
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("corrupt catalog falls back to empty instead of crashing", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-audit-corrupt-"));
  try {
    const storage = new Storage(dir).ensureDir();
    storage.writeJson(storage.catalogPath, "{not json");
    assert.deepEqual(storage.loadCatalog(), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("default data dir falls back to ~/.dsh when DSH_HOME unset", () => {
  const old = process.env.DSH_HOME;
  delete process.env.DSH_HOME;
  try {
    const storage = new Storage("");
    assert.ok(storage.dir.includes(".dsh"));
  } finally {
    if (old !== undefined) process.env.DSH_HOME = old;
  }
});
