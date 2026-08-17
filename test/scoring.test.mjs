import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreRecord, maintenanceScore, docsScore, npmScore, ecosystemScore, WEIGHTS, gradeBadge } from "../lib/scoring.js";

const now = Date.now();
const iso = (daysAgo) => new Date(now - daysAgo * 86400000).toISOString();

function rec(overrides = {}) {
  return {
    repo: "a/b", url: "https://github.com/a/b", name: "b", description: "x",
    stars: 100, createdAt: iso(200), updatedAt: iso(10), pushedAt: iso(10),
    archived: false, license: "MIT", hasReadme: true, curated: true,
    addedAt: iso(20), npm: { exists: true, name: "b", version: "1.0.0", publishedAt: iso(5) },
    ...overrides,
  };
}

test("healthy plugin scores high and grades A", () => {
  const s = scoreRecord(rec());
  assert.ok(s.total >= 80, "total " + s.total);
  assert.equal(s.grade, "A");
  assert.equal(s.breakdown.maintenance.points + s.breakdown.docs.points + s.breakdown.npm.points + s.breakdown.ecosystem.points, s.total);
});

test("archived plugin is flagged high and capped at grade D", () => {
  const s = scoreRecord(rec({ archived: true }));
  assert.equal(s.grade, "D");
  assert.ok(s.flags.some((f) => f.kind === "archived" && f.severity === "high"));
});

test("maintenance signal: dormant repo loses points", () => {
  const fresh = maintenanceScore(rec({ pushedAt: iso(10) })).points;
  const dormant = maintenanceScore(rec({ pushedAt: iso(400) })).points;
  assert.ok(dormant < fresh);
});

test("maintenance signal: archived always 0", () => {
  assert.equal(maintenanceScore(rec({ archived: true, pushedAt: iso(1), stars: 5000 })).points, 0);
});

test("npm signal: missing package gives small base, existing gives more", () => {
  const none = npmScore(rec({ npm: null }));
  const has = npmScore(rec({ npm: { exists: true, name: "b", version: "1", publishedAt: iso(5) } }));
  assert.ok(has.points > none.points);
});

test("docs signal: no readme + no license loses points", () => {
  const good = docsScore(rec({ hasReadme: true, license: "MIT", description: "a".repeat(150) })).points;
  const poor = docsScore(rec({ hasReadme: false, license: null, description: "" })).points;
  assert.equal(good, 25);
  assert.ok(poor < good);
});

test("ecosystem signal: curated listing adds points", () => {
  const curated = ecosystemScore(rec({ curated: true, addedAt: iso(10) })).points;
  const plain = ecosystemScore(rec({ curated: false, addedAt: null })).points;
  assert.equal(curated, 15);
  assert.equal(plain, 0);
});

test("weights sum to 100 and gradeBadge maps every grade", () => {
  assert.equal(Object.values(WEIGHTS).reduce((a, b) => a + b, 0), 100);
  for (const g of ["A", "B", "C", "D"]) assert.ok(gradeBadge(g).length > 0);
  assert.equal(gradeBadge("X"), "❓");
});

test("npm signal: weekly downloads add tier points (v0.3)", () => {
  const hot = npmScore(rec({ npm: { exists: true, name: "b", version: "1", publishedAt: iso(5), weeklyDownloads: 1500 } }));
  assert.equal(hot.points, 30); // 10 + 14 + 6
  const warm = npmScore(rec({ npm: { exists: true, name: "b", version: "1", publishedAt: iso(5), weeklyDownloads: 500 } }));
  assert.equal(warm.points, 28); // 10 + 14 + 4
  const cold = npmScore(rec({ npm: { exists: true, name: "b", version: "1", publishedAt: iso(5), weeklyDownloads: 0 } }));
  assert.equal(cold.points, 24); // 10 + 14 + 0
  assert.ok(hot.notes.some((n) => n.includes("weekly downloads 1500")));
});
