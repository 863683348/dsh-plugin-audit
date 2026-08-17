# dsh-plugin-audit — 插件生态体检（Plugin Health Audit for DSH）

Turn the GitHub `dsh-plugin` topic into a **local, scored plugin catalog** for DeepSeek Harness.
Every plugin gets a 0–100 health score across four signals, a leaderboard in the web UI,
and agent tools that answer *"which plugins are worth installing?"*.

| Signal | Weight | What it measures |
| --- | --- | --- |
| Maintenance | 30 | last push recency + star tier + **star trend** (archived → 0 + 🚨 flag) |
| Docs | 25 | README presence + description depth + license |
| npm | 30 | npm package exists + publish recency + **weekly downloads (v0.3)** |
| Ecosystem | 15 | presence in the curated awesome list + listing recency |

Grades: **A 🛡️ (80+)** · **B ✅ (60+)** · **C ⚠️ (40+)** · **D 🚨 (<40 or any high flag)**.
Scores are pure functions over plain records — fully explainable (every deduction carries a note).

**v0.3:** npm signal now includes a weekly-downloads tier (exists 10 + publish recency 14 + weekly downloads 6).

**v0.4 (真插件校验 / topic-tag farming filter):** deep scan now verifies a repo is actually a DSH plugin — presence of `cordis.patch.yml`, `dsh.bundle` in package.json, or a plugin entry file. Repos with none of these are flagged `not-plugin` (medium) and **capped at grade C**, no matter how healthy they look. The npm probe also detects whether the published package declares `dsh.bundle` (installable via `dsh plugin add`). This filters the ~half of the topic that is old projects or tag farming.

**Security (v0.2) is a veto, not a weight:** `audit_scan` static-scans a
plugin's package.json install scripts, shell scripts, and entry sources for
remote-code-execution, encoded commands, rc persistence, obfuscation, and
exfiltration to non-allowlisted hosts. High/critical findings land in the
`flags` contract → **grade D**, no matter how healthy the other signals look.
Each finding carries evidence; the scanner is deliberately conservative.

## Features

| Feature | Status |
| --- | --- |
| `audit_sync` — sweep the topic, probe npm, re-score (incremental, rate-limit aware) | ✅ stable |
| `audit_top` — leaderboard by score / stars / newest / name, category filter | ✅ stable |
| `audit_plugin` — full report card with evidence notes | ✅ stable |
| `audit_scan` — per-plugin static security scan (files → findings → veto) | ✅ stable (v0.2) |
| Star trend in maintenance signal (from rolling history snapshots) | ✅ stable (v0.2) |
| `auditSummary` session projection + composer-dock leaderboard | 🧪 experimental (loader-format client bundle) |
| Optional periodic sync (schedule service) | 🧪 guarded |
| Seed catalog from the awesome-dsh-plugin list (1018 plugins) | ✅ stable |

## How it works

- One Cordis plugin: host face (`lib/index.js`) registers tools + projection + optional schedule;
  browser face (`lib/client.js`) renders the dock; `cordis.patch.yml` mounts the row.
- Sync pulls `GET /search/repositories?q=topic:dsh-plugin` (100/page), probes
  `registry.npmjs.org/<name>` with bounded concurrency, then upserts into a JSON
  catalog. Rate-limit-aware: stops early when the search budget runs low and
  resumes next time; failed probes keep the previous values.
- Storage: `dataDir` (default `$DSH_HOME/dsh-plugin-audit` or `~/.dsh/dsh-plugin-audit`):
  `catalog.json` + `meta.json` + `history.json` (rolling star snapshots for future trend tiers).
- All writes are atomic (temp + rename); corrupt files fall back to empty instead of crashing.

## Install

The package declares `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`, so it goes
through DSH's official plugin management:

```bash
# from a local checkout
dsh plugin --profile <profile> add /path/to/dsh-audit

# or after publishing to npm
dsh plugin --profile <profile> add dsh-audit
```

Restart DSH. The `audit_*` tools are registered host-wide; the leaderboard dock appears
in the web UI on a web profile.

### First sync

Give the agent a GitHub token (search API: 30 req/min vs 10 anonymous) and ask it to
`audit_sync`, or configure it:

- `dataDir` — catalog location (empty = default)
- `githubToken` — or env `DSH_GITHUB_TOKEN` / `GITHUB_TOKEN`
- `syncIntervalHours` — periodic sync (0 disables; requires schedule service)
- `npmProbe` — probe npm registry (default true)

### Standalone (outside DSH, for testing / CI)

```bash
node scripts/seed.mjs                       # build data/catalog.json from the awesome list checkout
node scripts/sync.mjs --token <gh-token>    # real sync, no DSH needed
node --test test/                           # run tests
```

## Development notes

- Tests are fully offline (fake `fetch` injected) — `node --test test/` needs no network.
- Data model: one catalog record per repo (`repo`, `stars`, `pushedAt`, `license`,
  `archived`, `npm`, `curated`, `addedAt`, `score`, `flags`, …). See `lib/audit.js`
  `repoToRecord` and `lib/scoring.js`.
- The `flags` array is the extension contract for the security tier (v0.2).

## Roadmap

- v0.3 — open data export (JSON) so other marketplaces can cite the scores
- v0.4 — appeal/comments channel per plugin
- v0.5 — batch scan scheduling (scan the top-N by stars on each sync) + transitive-dependency signals

## License

MIT