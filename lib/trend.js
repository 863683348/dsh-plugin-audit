/**
 * dsh-plugin-audit — pure score-history helpers (v0.5.0).
 *
 * Score snapshots live in the plugin's data directory (scores.json, one
 * timeline per repo) next to the star history. Everything here is pure and
 * unit-testable in isolation: no fs, no network, no DSH imports.
 */

export const SCORE_HISTORY_CAP = 120;

/** Append one score snapshot for a repo (idempotent for the same date+score). */
export function appendScoreSnapshot({ history = {}, repo, score, grade = null, date, cap = SCORE_HISTORY_CAP } = {}) {
  if (typeof repo !== "string" || repo.length === 0) return { history, changed: false };
  if (typeof score !== "number" || !Number.isFinite(score)) return { history, changed: false };
  const list = Array.isArray(history[repo]) ? [...history[repo]] : [];
  const last = list[list.length - 1];
  if (last && last.date === date && last.score === score) return { history, changed: false };
  list.push({ date, score, grade: grade ?? null });
  const limit = Math.max(1, Math.floor(cap) || SCORE_HISTORY_CAP);
  if (list.length > limit) list.splice(0, list.length - limit);
  return { history: { ...history, [repo]: list }, changed: true };
}

/** Append many snapshots in one pass (a full sync sweep). */
export function appendScoreSnapshots({ history = {}, entries = [], date, cap = SCORE_HISTORY_CAP } = {}) {
  let next = history;
  let changed = false;
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry) continue;
    const res = appendScoreSnapshot({ history: next, repo: entry.repo, score: entry.score, grade: entry.grade, date, cap });
    if (res.changed) { next = res.history; changed = true; }
  }
  return { history: next, changed, repos: Object.keys(next).length };
}

/** Timeline for one repo, oldest first. */
export function scoreTimeline({ history = {}, repo } = {}) {
  const list = Array.isArray(history[repo]) ? history[repo] : [];
  return list.map((x) => ({ date: x.date, score: x.score, grade: x.grade ?? null }));
}

/** Direction over a timeline (first vs last sample). */
export function scoreTrend({ timeline = [] } = {}) {
  const list = Array.isArray(timeline) ? timeline : [];
  if (list.length === 0) return { direction: "flat", delta: 0, samples: 0, from: null, to: null };
  const from = list[0].score;
  const to = list[list.length - 1].score;
  const delta = Math.round((to - from) * 100) / 100;
  const direction = list.length < 2 ? "flat" : delta > 0.5 ? "up" : delta < -0.5 ? "down" : "flat";
  return { direction, delta, samples: list.length, from, to };
}

/** Biggest movers over the last `window` samples of every repo. */
export function movers({ history = {}, window: win = 3, limit = 10, minSamples = 2 } = {}) {
  const span = Math.max(2, Math.floor(win) || 3);
  const rows = [];
  for (const [repo, list] of Object.entries(history)) {
    if (!Array.isArray(list) || list.length < Math.max(2, minSamples)) continue;
    const slice = list.slice(-span);
    const from = slice[0].score;
    const to = slice[slice.length - 1].score;
    const delta = Math.round((to - from) * 100) / 100;
    rows.push({ repo, from, to, delta, samples: slice.length, date: slice[slice.length - 1].date ?? null, grade: slice[slice.length - 1].grade ?? null });
  }
  const max = Math.max(1, Math.floor(limit) || 10);
  const gainers = rows.filter((r) => r.delta > 0).sort((a, b) => b.delta - a.delta || a.repo.localeCompare(b.repo)).slice(0, max);
  const losers = rows.filter((r) => r.delta < 0).sort((a, b) => a.delta - b.delta || a.repo.localeCompare(b.repo)).slice(0, max);
  const tracked = rows.length;
  return { gainers, losers, tracked, window: span };
}

function signed(n) {
  return (n > 0 ? "+" : "") + n;
}

/** Markdown timeline for one repo. */
export function renderTimeline({ repo = "", timeline = [], trend = null } = {}) {
  if (!Array.isArray(timeline) || timeline.length === 0) return "No score history for " + (repo || "(none)") + " yet — run audit_sync to record snapshots.";
  const t = trend ?? scoreTrend({ timeline });
  const lines = [
    "# Score history: " + repo,
    "",
    "Trend: " + t.direction + " (" + signed(t.delta) + " over " + t.samples + " sample(s), " + t.from + " -> " + t.to + ")",
    "",
    "| Date | Score | Grade |",
    "|------|-------|-------|",
    ...timeline.map((x) => "| " + x.date + " | " + x.score + " | " + (x.grade ?? "-") + " |"),
  ];
  return lines.join("\n");
}

/** Markdown gainers/losers table. */
export function renderMovers({ gainers = [], losers = [], tracked = 0, window: win = 3 } = {}) {
  const table = (rows, sign) => {
    if (rows.length === 0) return ["- (none)"];
    return ["| Repo | " + (sign > 0 ? "Gain" : "Drop") + " | From -> To | Samples |", "|------|------|-----------|---------|", ...rows.map((r) => "| " + r.repo + " | " + signed(r.delta) + " | " + r.from + " -> " + r.to + " | " + r.samples + " |")];
  };
  const lines = [
    "# Score movers (last " + win + " sample(s), " + tracked + " tracked repo(s))",
    "",
    "## Gainers",
    ...table(gainers, 1),
    "",
    "## Losers",
    ...table(losers, -1),
  ];
  return lines.join("\n");
}
