/**
 * dsh-plugin-audit — sync engine.
 *
 * Pulls the whole GitHub `dsh-plugin` topic into the local catalog:
 *
 *   1. Page through GET /search/repositories?q=topic:dsh-plugin (100/page),
 *      which already returns the repo metadata we need (stars, pushed_at,
 *      license, archived, topics). The search API is rate-limited hard
 *      (10/min anonymous, 30/min with token) — so we cache everything and
 *      stop early when the rate-limit budget runs low, resuming next time.
 *   2. Probe npm (registry.npmjs.org/<name>) for repos whose short name
 *      looks like a package name, with bounded concurrency.
 *   3. Merge into storage (upsert, keep old values on failure), snapshot
 *      stars into history, and recompute scores.
 *
 * fetchImpl is injectable so tests run fully offline with a fake fetch.
 */
import { Storage } from "./storage.js";
import { scoreRecord, computeStarTrend } from "./scoring.js";
import { runSecurityScan } from "./security.js";
import { fetchKeyFiles, applyScanToRecord } from "./scanner.js";

const GITHUB_API = "https://api.github.com";
const NPM_REGISTRY = "https://registry.npmjs.org";
const TOPIC_QUERY = "topic:dsh-plugin";
const PAGE_SIZE = 100;
const RATE_LIMIT_SAFETY = 5; // stop paging when this many search calls remain
const NPM_CONCURRENCY = 8;
const UA = "dsh-plugin-audit/0.1";

function apiHeaders(token) {
  return {
    accept: "application/vnd.github+json",
    "user-agent": UA,
    ...(token ? { authorization: "Bearer " + token } : {}),
  };
}

/** Repo short name → plausible npm package name (null when clearly not one). */
export function guessPackageName(repoName) {
  if (typeof repoName !== "string") return null;
  const base = repoName.split("/").pop() ?? "";
  const lower = base.toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,213}$/.test(lower)) return null;
  if (/^(_|\.)/.test(lower)) return null; // scoped-only / dotfiles
  return lower;
}

/** Map a GitHub search result item → catalog record. */
export function repoToRecord(item) {
  const license = item.license ? (item.license.spdx_id || item.license.key || null) : null;
  return {
    repo: item.full_name,
    url: item.html_url,
    name: item.name,
    description: item.description ?? "",
    stars: typeof item.stargazers_count === "number" ? item.stargazers_count : null,
    createdAt: item.created_at ?? null,
    updatedAt: item.updated_at ?? null,
    pushedAt: item.pushed_at ?? null,
    archived: item.archived === true,
    license,
    hasReadme: null, // probed lazily in a later tier; docs score treats null as "unknown"
    topics: Array.isArray(item.topics) ? item.topics : [],
    checkedAt: new Date().toISOString(),
  };
}

export function parseRateLimit(headers) {
  const rem = headers?.get?.("x-ratelimit-remaining");
  const reset = headers?.get?.("x-ratelimit-reset");
  if (rem === null || rem === undefined) return null;
  return {
    remaining: Number(rem),
    resetAt: reset ? new Date(Number(reset) * 1000).toISOString() : null,
  };
}

/**
 * Page through the topic. Calls onPage(records, pageInfo) per page so the
 * caller can stream results; stops when exhausted or rate-limited.
 */
export async function* topicPages({ token, fetchImpl = fetch, onPage, maxPages = 50 }) {
  const headers = apiHeaders(token);
  let page = 1;
  while (page <= maxPages) {
    const url = GITHUB_API + "/search/repositories?q=" + encodeURIComponent(TOPIC_QUERY) + "&per_page=" + PAGE_SIZE + "&page=" + page;
    const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(20000) });
    const rate = parseRateLimit(res.headers);
    if (!res.ok) {
      if (res.status === 403 || res.status === 429) {
        throw new Object.assign(new Error("GitHub rate limit or forbidden: HTTP " + res.status), { kind: "rate-limit", rate });
      }
      if (res.status === 422) throw new Error("GitHub search rejected the query (HTTP 422)");
      throw new Error("GitHub search failed: HTTP " + res.status);
    }
    const body = await res.json();
    const items = Array.isArray(body.items) ? body.items : [];
    onPage?.(items.map(repoToRecord), { page, total: body.total_count, rate });
    if (items.length === 0) break;
    if (rate && rate.remaining <= RATE_LIMIT_SAFETY) {
      // pause the sweep; resume on the next sync
      return { stopped: "rate-limit", rate };
    }
    if (page * PAGE_SIZE >= (body.total_count ?? 0)) break;
    page += 1;
  }
  return { stopped: null, rate: null };
}

/** Probe npm for one repo. Returns { exists, name, version, publishedAt, created } or { exists: false }. */
export async function probeNpm(pkg, { fetchImpl = fetch }) {
  if (!pkg) return { exists: false };
  try {
    const res = await fetchImpl(NPM_REGISTRY + "/" + encodeURIComponent(pkg), {
      headers: { "user-agent": UA },
      signal: AbortSignal.timeout(10000),
    });
    if (res.status === 404) return { exists: false };
    if (!res.ok) return { exists: false, error: "HTTP " + res.status };
    const body = await res.json();
    const latest = body["dist-tags"]?.latest;
    const versions = body.versions ?? {};
    const time = body.time ?? {};
    return {
      exists: true,
      name: pkg,
      version: latest ?? null,
      publishedAt: typeof latest === "string" ? (time[latest] ?? time.modified ?? null) : null,
      created: time.created ?? null,
    };
  } catch {
    return { exists: false, error: "probe failed" };
  }
}

/** Run one full sync sweep. Returns a summary the caller can log/render. */
export async function syncTopic({ storage, token, fetchImpl = fetch, npmProbe = true, onProgress }) {
  const startedAt = new Date().toISOString();
  const fresh = [];
  const npmNames = [];
  let rate = null;
  let stopped = null;

  const gen = topicPages({ token, fetchImpl, onPage: (records) => fresh.push(...records) });
  for await (const _ of gen) { /* pages are streamed via onPage */ }

  const npmFound = [];
  if (npmProbe) {
    const candidates = fresh.map((r) => ({ repo: r.repo, pkg: guessPackageName(r.repo) })).filter((c) => c.pkg);
    for (let i = 0; i < candidates.length; i += NPM_CONCURRENCY) {
      const batch = candidates.slice(i, i + NPM_CONCURRENCY);
      const results = await Promise.all(batch.map((c) => probeNpm(c.pkg, { fetchImpl })));
      batch.forEach((c, j) => {
        const probe = results[j];
        if (probe.exists) {
          npmFound.push(c.pkg);
          const rec = fresh.find((r) => r.repo === c.repo);
          if (rec) rec.npm = { name: c.pkg, version: probe.version, publishedAt: probe.publishedAt, created: probe.created, exists: true };
        }
      });
      onProgress?.(Math.min(i + batch.length, candidates.length), candidates.length);
    }
  }

  // Snapshot stars in one write, then attach trends before scoring.
  storage.appendStarsBatch(fresh.map((rec) => ({ repo: rec.repo, stars: rec.stars, date: startedAt.slice(0, 10) })));
  const history = storage.loadHistory();
  for (const rec of fresh) {
    rec.starTrend = computeStarTrend(history[rec.repo]);
    rec.score = scoreRecord(rec);
  }

  const merged = storage.mergeRecords(fresh);
  const meta = storage.loadMeta();
  meta.lastSyncAt = startedAt;
  meta.lastSyncStatus = stopped ? "partial" : "ok";
  meta.counts = { total: merged.total, npmFound: npmFound.length, curated: storage.getSummary().curated, gone: storage.getSummary().gone };
  meta.rateLimit = rate;
  storage.saveMeta(meta);

  return {
    startedAt,
    stopped,
    rate,
    fetched: fresh.length,
    added: merged.added,
    updated: merged.updated,
    total: merged.total,
    npmFound: npmFound.length,
  };
}

/** Query helpers over the catalog. */
export function listRecords({ records, sort = "score", category, query, limit = 50, offset = 0 }) {
  let rows = records.slice();
  if (category) rows = rows.filter((r) => (r.category ?? "") === category);
  if (query) {
    const q = query.toLowerCase();
    rows = rows.filter((r) => (r.repo + " " + (r.description ?? "") + " " + (r.name ?? "")).toLowerCase().includes(q));
  }
  const sorters = {
    score: (a, b) => (b.score?.total ?? -1) - (a.score?.total ?? -1),
    stars: (a, b) => (b.stars ?? -1) - (a.stars ?? -1),
    new: (a, b) => (b.checkedAt ?? b.addedAt ?? "").localeCompare(a.checkedAt ?? a.addedAt ?? ""),
    name: (a, b) => (a.repo ?? "").localeCompare(b.repo ?? ""),
  };
  rows.sort(sorters[sort] ?? sorters.score);
  return rows.slice(offset, offset + limit);
}

/** Build a human-readable report card for one plugin. */
export function buildReport(record) {
  if (!record || typeof record !== "object") return "plugin record missing";
  const score = record.score;
  const head = record.repo + " — " + (score ? score.grade + " (" + score.total + "/100)" : "not scored yet");
  const lines = [head, record.url ?? ""];
  if (record.description) lines.push(record.description);
  lines.push("stars=" + (record.stars ?? "?") + " pushed=" + (record.pushedAt ?? "?") + " archived=" + (record.archived ? "yes" : "no") + " license=" + (record.license ?? "none"));
  lines.push("npm=" + (record.npm?.exists ? record.npm.name + "@" + (record.npm.version ?? "?") : "none") + " curated=" + (record.curated ? "yes" : "no") + " category=" + (record.category ?? "-"));
  if (score) {
    for (const [key, sig] of Object.entries(score.breakdown)) {
      lines.push("  " + key.padEnd(12) + sig.points + "/" + sig.weight + "  " + sig.notes.join("; "));
    }
    for (const f of score.flags ?? []) lines.push("  ⚑ " + f.kind + ": " + (f.detail ?? ""));
  }
  if (record.security) {
    lines.push("security: trust " + record.security.trustScore + "/100, scanned " + record.security.filesScanned.length + " file(s), " + record.security.findings.length + " finding(s)");
    for (const f of record.security.findings) lines.push("  ⚑ " + f.severity + " " + f.rule + ": " + f.detail);
  }
  return lines.join("\n");
}

/**
 * Deep-scan ONE plugin: fetch key files, run static heuristics, persist the
 * findings on the record (security + hasReadme), and re-score it.
 */
export async function scanPlugin(storage, repo, { token, fetchImpl = fetch } = {}) {
  const records = storage.loadCatalog();
  const record = records.find((r) => r.repo === repo) ?? records.find((r) => r.name === repo);
  if (!record) return { found: false, repo };
  const scan = await fetchKeyFiles(record.repo, { token, fetchImpl });
  const result = runSecurityScan(scan.files);
  applyScanToRecord(record, { ...scan, result });
  record.score = scoreRecord(record);
  storage.mergeRecords([record]);
  return {
    found: true,
    repo: record.repo,
    filesScanned: scan.files.map((f) => f.path),
    hasReadme: scan.hasReadme,
    findings: result.findings,
    trustScore: result.trustScore,
    grade: record.score.grade,
    total: record.score.total,
    error: scan.error ?? null,
  };
}
