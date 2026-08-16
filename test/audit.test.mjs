import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../lib/storage.js";
import { topicPages, syncTopic, probeNpm, guessPackageName, repoToRecord, listRecords, buildReport } from "../lib/audit.js";

/** Fake fetch: serves topic pages + npm registry, counts calls. */
function fakeFetch(pages, npmMap) {
  const calls = [];
  return async (url, opts) => {
    calls.push(url);
    if (url.includes("api.github.com/search")) {
      for (const p of pages) {
        if (url.includes("&page=" + p.page)) {
          return {
            ok: true, status: 200,
            headers: new Headers({ "x-ratelimit-remaining": String(p.remaining) }),
            json: async () => ({ total_count: p.total, items: p.items }),
          };
        }
      }
      return { ok: false, status: 404, headers: new Headers(), json: async () => ({}) };
    }
    if (url.startsWith("https://registry.npmjs.org/")) {
      const name = decodeURIComponent(url.split("/").pop());
      const entry = npmMap?.[name];
      if (!entry) return { ok: false, status: 404, headers: new Headers(), json: async () => ({}) };
      return { ok: true, status: 200, headers: new Headers(), json: async () => entry };
    }
    return { ok: false, status: 500, headers: new Headers(), json: async () => ({}) };
  };
}

function ghItem(overrides = {}) {
  return {
    full_name: "owner/repo", name: "repo", html_url: "https://github.com/owner/repo",
    description: "a plugin", stargazers_count: 42, created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-15T00:00:00Z", pushed_at: "2026-08-15T00:00:00Z",
    archived: false, license: { spdx_id: "MIT" }, topics: ["dsh-plugin"],
    ...overrides,
  };
}

test("guessPackageName accepts safe names, rejects the rest", () => {
  assert.equal(guessPackageName("dsh-browser"), "dsh-browser");
  assert.equal(guessPackageName("owner/MyPlugin"), "myplugin");
  assert.equal(guessPackageName("owner/URL"), "url");
  assert.equal(guessPackageName("owner/My Plugin"), null);   // space
  assert.equal(guessPackageName("owner/.dot"), null);        // dotfile
  assert.equal(guessPackageName(""), null);
});

test("repoToRecord maps a GitHub item", () => {
  const r = repoToRecord(ghItem());
  assert.equal(r.repo, "owner/repo");
  assert.equal(r.stars, 42);
  assert.equal(r.license, "MIT");
  assert.equal(r.archived, false);
  assert.equal(r.hasReadme, null); // lazy probe in later tier
});

test("topicPages pages through and reports rate limit", async () => {
  const ff = fakeFetch([
    { page: 1, total: 250, remaining: 20, items: [ghItem({ full_name: "a/x" })] },
    { page: 2, total: 250, remaining: 19, items: [ghItem({ full_name: "b/y" })] },
    { page: 3, total: 250, remaining: 18, items: [ghItem({ full_name: "c/z" })] },
  ]);
  const seen = [];
  const gen = topicPages({ fetchImpl: ff, onPage: (records) => seen.push(...records) });
  for await (const _ of gen) {}
  assert.equal(seen.length, 3);
  assert.equal(seen[2].repo, "c/z");
});

test("topicPages stops early when rate budget is low", async () => {
  const ff = fakeFetch([
    { page: 1, total: 999, remaining: 4, items: [ghItem({ full_name: "a/x" })] },
    { page: 2, total: 999, remaining: 3, items: [ghItem({ full_name: "b/y" })] },
  ]);
  const seen = [];
  const gen = topicPages({ fetchImpl: ff, onPage: (records) => seen.push(...records) });
  for await (const _ of gen) {}
  assert.equal(seen.length, 1, "should stop after low remaining");
});

test("probeNpm returns package info and 404 for missing", async () => {
  const ff = fakeFetch([], {
    "dsh-browser": { "dist-tags": { latest: "1.2.3" }, time: { "1.2.3": "2026-08-10T00:00:00Z", created: "2026-08-01T00:00:00Z" }, versions: {} },
  });
  const ok = await probeNpm("dsh-browser", { fetchImpl: ff });
  assert.equal(ok.exists, true);
  assert.equal(ok.version, "1.2.3");
  const missing = await probeNpm("nope", { fetchImpl: ff });
  assert.equal(missing.exists, false);
});

test("syncTopic merges, probes npm, scores, and snapshots stars", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-audit-sync-"));
  try {
    const storage = new Storage(dir).ensureDir();
    const ff = fakeFetch(
      [{ page: 1, total: 2, remaining: 25, items: [
        ghItem({ full_name: "a/dsh-browser", name: "dsh-browser", stargazers_count: 10 }),
        ghItem({ full_name: "b/nope", name: "nope" }),
      ] }],
      { "dsh-browser": { "dist-tags": { latest: "0.9.0" }, time: { "0.9.0": "2026-08-14T00:00:00Z", created: "2026-08-01T00:00:00Z" }, versions: {} } },
    );
    const summary = await syncTopic({ storage, token: "t", fetchImpl: ff, npmProbe: true });
    assert.equal(summary.fetched, 2);
    assert.equal(summary.added, 2);
    assert.equal(summary.npmFound, 1);
    const catalog = storage.loadCatalog();
    assert.equal(catalog.length, 2);
    const br = catalog.find((r) => r.repo === "a/dsh-browser");
    assert.ok(br.score, "scored");
    assert.ok(br.score.total > 0);
    assert.equal(br.npm.exists, true);
    assert.ok(storage.loadHistory()["a/dsh-browser"].length >= 1);
    const meta = storage.loadMeta();
    assert.equal(meta.lastSyncStatus, "ok");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("listRecords sorts and filters", () => {
  const records = [
    { repo: "a/one", stars: 5, score: { total: 80 }, category: "tools" },
    { repo: "b/two", stars: 50, score: { total: 60 }, category: "ui" },
    { repo: "c/three", stars: 15, score: { total: 90 }, category: "tools" },
  ];
  const byScore = listRecords({ records, sort: "score", limit: 10 });
  assert.deepEqual(byScore.map((r) => r.repo), ["c/three", "a/one", "b/two"]);
  const tools = listRecords({ records, sort: "score", category: "tools" });
  assert.deepEqual(tools.map((r) => r.repo), ["c/three", "a/one"]);
  const q = listRecords({ records, sort: "score", query: "three" });
  assert.equal(q.length, 1);
});

test("buildReport renders a readable card", () => {
  const rec = ghItem();
  const r = repoToRecord(rec);
  r.curated = true;
  r.npm = { exists: true, name: "repo", version: "1.0.0" };
  const text = buildReport(r);
  assert.ok(text.includes("owner/repo"));
  assert.ok(text.includes("npm"));
});
