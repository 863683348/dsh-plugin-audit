import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendScoreSnapshot,
  appendScoreSnapshots,
  movers,
  renderMovers,
  renderTimeline,
  scoreTimeline,
  scoreTrend,
} from "../lib/trend.js";

test("appendScoreSnapshot records and is idempotent per date+score", () => {
  const a = appendScoreSnapshot({ history: {}, repo: "a/one", score: 70, grade: "B", date: "2026-08-01" });
  assert.equal(a.changed, true);
  assert.deepEqual(a.history["a/one"], [{ date: "2026-08-01", score: 70, grade: "B" }]);
  const b = appendScoreSnapshot({ history: a.history, repo: "a/one", score: 70, grade: "B", date: "2026-08-01" });
  assert.equal(b.changed, false, "same date+score is a no-op");
  const c = appendScoreSnapshot({ history: a.history, repo: "a/one", score: 75, grade: "B", date: "2026-08-02" });
  assert.equal(c.history["a/one"].length, 2);
});

test("appendScoreSnapshot cap keeps the newest samples", () => {
  let history = {};
  for (let i = 1; i <= 6; i++) history = appendScoreSnapshot({ history, repo: "a/x", score: i, date: "2026-08-0" + i, cap: 3 }).history;
  assert.equal(history["a/x"].length, 3);
  assert.deepEqual(history["a/x"].map((x) => x.score), [4, 5, 6]);
});

test("appendScoreSnapshot ignores invalid input", () => {
  assert.equal(appendScoreSnapshot({ history: {}, repo: "", score: 10, date: "d" }).changed, false);
  assert.equal(appendScoreSnapshot({ history: {}, repo: "a/x", score: Number.NaN, date: "d" }).changed, false);
  assert.equal(appendScoreSnapshot({ history: {}, repo: "a/x", score: "80", date: "d" }).changed, false);
});

test("appendScoreSnapshots batches a sweep", () => {
  const res = appendScoreSnapshots({
    history: {},
    date: "2026-08-01",
    entries: [
      { repo: "a/one", score: 60, grade: "B" },
      { repo: "a/two", score: 40, grade: "C" },
      { repo: "a/bad", score: null },
    ],
  });
  assert.equal(res.changed, true);
  assert.equal(Object.keys(res.history).length, 2, "invalid entry skipped");
  assert.equal(res.repos, 2);
});

test("scoreTrend reports up/down/flat", () => {
  const up = scoreTrend({ timeline: [{ date: "d1", score: 50 }, { date: "d2", score: 70 }] });
  assert.equal(up.direction, "up");
  assert.equal(up.delta, 20);
  const down = scoreTrend({ timeline: [{ date: "d1", score: 70 }, { date: "d2", score: 40 }] });
  assert.equal(down.direction, "down");
  const flat = scoreTrend({ timeline: [{ date: "d1", score: 50 }, { date: "d2", score: 50 }] });
  assert.equal(flat.direction, "flat");
  const single = scoreTrend({ timeline: [{ date: "d1", score: 50 }] });
  assert.equal(single.direction, "flat");
  assert.equal(single.samples, 1);
  assert.equal(scoreTrend({ timeline: [] }).samples, 0);
});

test("movers ranks gainers and losers within the window", () => {
  const history = {
    "a/up": [{ date: "d1", score: 50 }, { date: "d2", score: 60 }, { date: "d3", score: 80 }],
    "a/down": [{ date: "d1", score: 90 }, { date: "d2", score: 80 }, { date: "d3", score: 60 }],
    "a/steady": [{ date: "d1", score: 70 }, { date: "d2", score: 70 }, { date: "d3", score: 70 }],
    "a/once": [{ date: "d1", score: 10 }],
  };
  const res = movers({ history, window: 3, limit: 5 });
  assert.equal(res.gainers[0].repo, "a/up");
  assert.equal(res.gainers[0].delta, 30);
  assert.equal(res.losers[0].repo, "a/down");
  assert.equal(res.losers[0].delta, -30);
  assert.equal(res.tracked, 3, "single-sample repo excluded");
  assert.ok(!res.losers.some((r) => r.repo === "a/steady"));
});

test("movers respects a shorter window and limit", () => {
  const history = {
    "a/x": [{ date: "d1", score: 10 }, { date: "d2", score: 90 }, { date: "d3", score: 95 }],
    "a/y": [{ date: "d1", score: 10 }, { date: "d2", score: 60 }, { date: "d3", score: 60 }],
  };
  const res = movers({ history, window: 2, limit: 1 });
  assert.equal(res.window, 2);
  assert.equal(res.gainers.length, 1);
  assert.equal(res.gainers[0].repo, "a/x", "last-two-samples delta of 5 vs 0");
});

test("renderTimeline and renderMovers produce markdown", () => {
  const timeline = [{ date: "2026-08-01", score: 60, grade: "B" }, { date: "2026-08-02", score: 72, grade: "B" }];
  const tl = renderTimeline({ repo: "a/one", timeline, trend: scoreTrend({ timeline }) });
  assert.ok(tl.startsWith("# Score history: a/one"));
  assert.ok(tl.includes("Trend: up (+12 over 2 sample(s), 60 -> 72)"));
  assert.ok(tl.includes("| 2026-08-02 | 72 | B |"));
  assert.ok(renderTimeline({ repo: "a/none", timeline: [] }).includes("No score history"));
  const mv = renderMovers({ gainers: [{ repo: "a/up", from: 50, to: 80, delta: 30, samples: 3 }], losers: [], tracked: 1, window: 3 });
  assert.ok(mv.includes("# Score movers (last 3 sample(s), 1 tracked repo(s))"));
  assert.ok(mv.includes("| a/up | +30 | 50 -> 80 | 3 |"));
  assert.ok(mv.includes("- (none)"), "empty losers side rendered");
});

test("scoreTimeline tolerates unknown repos", () => {
  assert.deepEqual(scoreTimeline({ history: {}, repo: "nope" }), []);
  const tl = scoreTimeline({ history: { "a/x": [{ date: "d", score: 5 }] }, repo: "a/x" });
  assert.deepEqual(tl, [{ date: "d", score: 5, grade: null }]);
});
