/**
 * dsh-plugin-audit — key-file fetcher for one repo (v0.2).
 *
 * Fetches a bounded set of files that matter for a static security scan:
 *   - package.json (install scripts)
 *   - shell scripts (scripts/ and root *.sh)
 *   - JS entry sources (lib/index.js, src/index.js, index.js, ...)
 *   - README presence (feeds the docs signal)
 *
 * Cost: 1 tree call + up to 6 contents calls per plugin. Never downloads the
 * whole repository. Errors are never fabricated: a failed fetch returns
 * { files: [], hasReadme: null } so the caller can keep the previous state.
 */

const GITHUB_API = "https://api.github.com";
const UA = "dsh-plugin-audit/0.2";

const MAX_FILES = 6;

function headers(token) {
  return {
    accept: "application/vnd.github+json",
    "user-agent": UA,
    ...(token ? { authorization: "Bearer " + token } : {}),
  };
}

const ENTRY_CANDIDATES = [
  "lib/index.js", "src/index.js", "index.js", "plugin.js", "src/plugin.js",
  "lib/client.js", "src/index.ts", "lib/index.ts", "index.ts",
];

/** Pick which tree paths to fetch; prefer roots, cap by MAX_FILES. */
export function pickFiles(treePaths) {
  const out = [];
  const shells = [];
  const entries = [];
  let pkg = null;
  for (const p of treePaths) {
    if (p === "package.json") { pkg = p; continue; }
    if (/package\.json$/.test(p) && p.split("/").length === 2 && !pkg) { pkg = p; continue; }
    if (/\.(sh|bash|zsh)$/.test(p)) { shells.push(p); continue; }
    if (ENTRY_CANDIDATES.includes(p)) { entries.push(p); continue; }
    if (/^scripts\//.test(p) && /\.[a-z]+$/.test(p) && shells.length < 3) { shells.push(p); continue; }
  }
  if (pkg) out.push(pkg);
  out.push(...entries.slice(0, 3));
  out.push(...shells.slice(0, 3));
  return out.slice(0, MAX_FILES);
}

/**
 * Fetch the key files of one repo. Returns { files, hasReadme, tree }.
 * hasReadme is true/false when the tree was readable, null otherwise.
 */
export async function fetchKeyFiles(repo, { token, fetchImpl = fetch }) {
  try {
    const treeRes = await fetchImpl(GITHUB_API + "/repos/" + repo + "/git/trees/HEAD?recursive=1", {
      headers: headers(token),
      signal: AbortSignal.timeout(20000),
    });
    if (!treeRes.ok) return { files: [], hasReadme: null, tree: null, error: "tree HTTP " + treeRes.status };
    const body = await treeRes.json();
    const paths = (body.tree ?? []).filter((t) => t.type === "blob").map((t) => t.path);
    const hasReadme = paths.some((p) => /^readme(\.md|\.txt|\.rst)?$/i.test(p.split("/").pop() ?? ""));
    const targets = pickFiles(paths);
    const files = [];
    for (const p of targets) {
      const res = await fetchImpl(GITHUB_API + "/repos/" + repo + "/contents/" + encodeURIComponent(p), {
        headers: { ...headers(token), accept: "application/vnd.github.raw" },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) continue;
      const text = await res.text();
      if (text && text.length < 512 * 1024) files.push({ path: p, text });
    }
    return { files, hasReadme, tree: paths };
  } catch (err) {
    return { files: [], hasReadme: null, tree: null, error: String(err?.message ?? err) };
  }
}

/** Merge a scan result into a catalog record (mutates and returns it). */
export function applyScanToRecord(record, scan) {
  if (!record) return record;
  record.security = {
    scannedAt: new Date().toISOString(),
    filesScanned: scan.files.map((f) => f.path),
    findings: scan.result.findings,
    trustScore: scan.result.trustScore,
  };
  if (scan.hasReadme !== null) record.hasReadme = scan.hasReadme;
  return record;
}
