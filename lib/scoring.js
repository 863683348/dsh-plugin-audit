/**
 * dsh-plugin-audit — v0.1 scoring model.
 *
 * Every plugin gets a 0-100 health score across four signals:
 *
 *   maintenance (30)  last push recency + star tier (archived → 0 + flag)
 *   docs        (25)  README presence + description depth + license
 *   npm         (30)  npm package exists + publish recency
 *   ecosystem   (15)  presence in the curated awesome list + listing recency
 *
 * A deep static security scan (exfiltration / credential / obfuscation /
 * persistence heuristics — the dsh-plugin-vetting space) is deliberately
 * NOT part of v0.1: scores must stay stable and explainable while the scan
 * pipeline lands. The `flags` array is the contract — a future security
 * tier pushes { kind: "security", severity: "high" } entries there, and any
 * high-severity flag caps the grade at D without rewiring the weights.
 *
 * Everything here is a pure function over plain records → unit-testable.
 */

export const WEIGHTS = { maintenance: 30, docs: 25, npm: 30, ecosystem: 15 };

function daysSince(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return (Date.now() - t) / 86400000;
}

/**
 * Star trend from history snapshots [{date, stars}]. Returns null until at
 * least two snapshots exist with a measurable span. starsPerDay is the raw
 * daily growth rate between the first and last snapshot.
 */
export function computeStarTrend(snapshots) {
  if (!Array.isArray(snapshots) || snapshots.length < 2) return null;
  const list = snapshots
    .filter((s) => typeof s?.stars === "number" && typeof s?.date === "string")
    .sort((a, b) => a.date.localeCompare(b.date));
  if (list.length < 2) return null;
  const first = list[0];
  const last = list[list.length - 1];
  const days = Math.max(1, (Date.parse(last.date) - Date.parse(first.date)) / 86400000);
  if (!Number.isFinite(days)) return null;
  const deltaStars = last.stars - first.stars;
  return {
    firstDate: first.date,
    lastDate: last.date,
    periodDays: Math.round(days),
    deltaStars,
    starsPerDay: deltaStars / days,
  };
}

/** Maintenance signal: recency of last push (0-20) + star tier (0-10). */
export function maintenanceScore(record) {
  if (record.archived === true) return { points: 0, notes: ["repo archived"] };
  const notes = [];
  const sincePush = daysSince(record.pushedAt);
  let points = 0;
  if (sincePush === null) {
    notes.push("last push unknown");
  } else if (sincePush < 30) {
    points = 20; notes.push("pushed within 30 days");
  } else if (sincePush < 90) {
    points = 15; notes.push("pushed within 90 days");
  } else if (sincePush < 180) {
    points = 10; notes.push("pushed within 180 days");
  } else if (sincePush < 365) {
    points = 5; notes.push("no push in the last year");
  } else {
    points = 0; notes.push("dormant — no push for over a year");
  }
  const stars = typeof record.stars === "number" ? record.stars : null;
  if (stars === null) {
    notes.push("stars unknown");
  } else if (stars >= 1000) {
    points += 10; notes.push(stars + " stars");
  } else if (stars >= 500) {
    points += 8; notes.push(stars + " stars");
  } else if (stars >= 100) {
    points += 6; notes.push(stars + " stars");
  } else if (stars >= 10) {
    points += 4; notes.push(stars + " stars");
  } else {
    points += 2; notes.push("under 10 stars");
  }
  // Star trend (needs >=2 sync snapshots): momentum adjusts the signal.
  const trend = record.starTrend ?? null;
  if (trend) {
    if (trend.starsPerDay >= 0.5) { points += 4; notes.push("fast star growth (" + trend.starsPerDay.toFixed(2) + "/day)"); }
    else if (trend.starsPerDay >= 0.1) { points += 2; notes.push("steady star growth"); }
    else if (trend.starsPerDay <= -0.05) { points -= 3; notes.push("star count declining (" + trend.starsPerDay.toFixed(2) + "/day)"); }
    else { notes.push("star count flat"); }
  }
  return { points: Math.max(0, Math.min(30, points)), notes };
}

/** Docs signal: README (0-12) + description depth (0-8) + license (0-5). */
export function docsScore(record) {
  const notes = [];
  let points = 0;
  if (record.hasReadme === true) { points += 12; notes.push("README present"); }
  else if (record.hasReadme === false) { points += 0; notes.push("no README"); }
  else { points += 4; notes.push("README not probed yet"); }
  const desc = (record.description ?? "").trim();
  if (desc.length >= 120) { points += 8; notes.push("detailed description"); }
  else if (desc.length >= 40) { points += 6; notes.push("decent description"); }
  else if (desc.length > 0) { points += 3; notes.push("short description"); }
  else { points += 0; notes.push("no description"); }
  if (record.license) { points += 5; notes.push("license: " + record.license); }
  else { notes.push("no license detected"); }
  return { points: Math.min(25, points), notes };
}

/** npm signal: package exists (0-10) + publish recency (0-14) + weekly downloads (0-6) = 30. */
export function npmScore(record) {
  const notes = [];
  const npm = record.npm;
  if (!npm || npm.exists !== true) {
    notes.push("no npm package found (GitHub-only install still works)");
    return { points: 3, notes };
  }
  let points = 10;
  notes.push("npm package: " + npm.name + "@" + (npm.version ?? "?"));
  const sincePublish = daysSince(npm.publishedAt);
  if (sincePublish === null) {
    notes.push("publish date unknown");
    points += 4;
  } else if (sincePublish < 90) {
    points += 14; notes.push("published within 90 days");
  } else if (sincePublish < 365) {
    points += 10; notes.push("published within a year");
  } else {
    points += 4; notes.push("last publish over a year ago");
  }
  const dl = typeof npm.weeklyDownloads === "number" ? npm.weeklyDownloads : null;
  if (dl === null || dl <= 0) {
    notes.push("no weekly download data");
  } else if (dl >= 1000) {
    points += 6; notes.push("weekly downloads " + dl);
  } else if (dl >= 100) {
    points += 4; notes.push("weekly downloads " + dl);
  } else {
    points += 2; notes.push("weekly downloads " + dl);
  }
  return { points: Math.min(30, points), notes };
}

/** Ecosystem signal: curated listing (0-12) + listing recency (0-3). */
export function ecosystemScore(record) {
  const notes = [];
  let points = 0;
  if (record.curated === true) { points += 12; notes.push("in the curated awesome list"); }
  else { notes.push("not in the curated list"); }
  const sinceAdded = daysSince(record.addedAt);
  if (sinceAdded !== null && sinceAdded < 90) {
    points += 3; notes.push("listed recently");
  }
  return { points: Math.min(15, points), notes };
}

/** Compute the full report card for a record. Pure. */
export function scoreRecord(record) {
  const flags = [];
  if (record.archived === true) flags.push({ kind: "archived", severity: "high", detail: "repository is archived" });
  if (record.gone === true) flags.push({ kind: "gone", severity: "high", detail: "repository returned 404" });
  // Security findings from the static scan (v0.2): high/critical veto the grade.
  for (const f of record.security?.findings ?? []) {
    if (f.severity === "critical" || f.severity === "high") {
      flags.push({ kind: "security", severity: "high", detail: (f.rule ?? "security") + ": " + (f.detail ?? "") });
    }
  }

  const maintenance = maintenanceScore(record);
  const docs = docsScore(record);
  const npm = npmScore(record);
  const ecosystem = ecosystemScore(record);
  const total = maintenance.points + docs.points + npm.points + ecosystem.points;

  const breakdown = {
    maintenance: { weight: WEIGHTS.maintenance, points: maintenance.points, notes: maintenance.notes },
    docs: { weight: WEIGHTS.docs, points: docs.points, notes: docs.notes },
    npm: { weight: WEIGHTS.npm, points: npm.points, notes: npm.notes },
    ecosystem: { weight: WEIGHTS.ecosystem, points: ecosystem.points, notes: ecosystem.notes },
  };

  const hasHighFlag = flags.some((f) => f.severity === "high");
  const grade = hasHighFlag ? "D" : total >= 80 ? "A" : total >= 60 ? "B" : total >= 40 ? "C" : "D";
  return {
    total,
    grade,
    breakdown,
    flags,
    scoredAt: new Date().toISOString(),
    version: 1,
  };
}

export function gradeBadge(grade) {
  return { A: "🛡️", B: "✅", C: "⚠️", D: "🚨" }[grade] ?? "❓";
}
