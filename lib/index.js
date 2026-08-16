/**
 * dsh-plugin-audit — host face.
 *
 * A Cordis plugin that turns the GitHub `dsh-plugin` topic into a local,
 * scored plugin catalog for DeepSeek Harness:
 *
 *   - audit_sync    sweep the topic, probe npm, re-score everything
 *   - audit_top     leaderboard rows (by score / stars / newest / name)
 *   - audit_plugin  full report card for one plugin
 *   - auditSummary  session projection feeding the web leaderboard panel
 *   - optional      periodic sync via the schedule service when present
 *
 * The model can call the tools to answer "which plugins are worth
 * installing?"; the web client renders the projection in the composer dock.
 *
 * @module dsh-plugin-audit
 */
import z from "@deepseek-ai/schemastery";
import { z as zod } from "zod";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { Storage } from "./storage.js";
import { syncTopic, listRecords, buildReport, scanPlugin } from "./audit.js";
import { gradeBadge } from "./scoring.js";

/** Cordis plugin name (registered with the loader). */
const name = "audit";

/** Services this plugin must resolve before it applies. */
const inject = ["tools"];

/** Composition-row configuration. */
const Config = z.object({
  /** Catalog directory; empty means $DSH_HOME/dsh-plugin-audit or ~/.dsh/dsh-plugin-audit. */
  dataDir: z.string().default(""),
  /** GitHub token for the search API (rate limit 30/min vs 10/min). Env fallback DSH_GITHUB_TOKEN. */
  githubToken: z.string().default(""),
  /** Auto-sync interval in hours (0 disables; requires the schedule service). */
  syncIntervalHours: z.number().default(12),
  /** Probe npm registry for matching package names. */
  npmProbe: z.boolean().default(true),
  /** Safety cap on the catalog size. */
  maxCatalogEntries: z.number().default(5000),
});

function resolveToken(config) {
  return config.githubToken || process.env.DSH_GITHUB_TOKEN || "";
}

function storageFor(config) {
  return new Storage(config.dataDir).ensureDir();
}

/** Summary payload pushed to the projection and session log after a sync. */
function syncEvent(summary) {
  return { kind: "summary", data: summary };
}

/** Cordis plugin body: register tools, projection, and optional schedule. */
function apply(ctx, config) {
  const storage = storageFor(config);
  const token = resolveToken(config);

  ctx.tools.register(defineTool({
    name: "audit_sync",
    description: "Sweep the GitHub dsh-plugin topic into the local plugin catalog: fetch repo metadata (stars, last push, license, archived), probe npm for matching package names, recompute health scores, and snapshot stars. Use this first, then audit_top / audit_plugin. Requires network; GitHub search is rate-limited (a token raises 10/min to 30/min) so runs are incremental and stop early when the budget runs low.",
    parameters: {
      force: {
        type: "boolean",
        description: "Re-fetch every page even if a recent sync exists (default reuses cached catalog when a sync finished less than an hour ago).",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        required: true,
        properties: {
          fetched: { type: "integer", required: true },
          added: { type: "integer", required: true },
          updated: { type: "integer", required: true },
          total: { type: "integer", required: true },
          npmFound: { type: "integer", required: true },
          stopped: { type: "string" },
          rateRemaining: { type: "integer" },
          startedAt: { type: "string", required: true },
        },
      },
      render: (_args, value) => {
        const head = "audit sync: " + value.total + " plugins in catalog (" + value.added + " new, " + value.updated + " refreshed, " + value.npmFound + " on npm)";
        const lines = [head];
        if (value.stopped) lines.push("stopped early: " + value.stopped + " (resume with another audit_sync)");
        if (value.rateRemaining !== undefined) lines.push("GitHub rate remaining: " + value.rateRemaining);
        lines.push("started " + value.startedAt);
        return [{ type: "text", text: lines.join("\n") }];
      },
    },
    execute: async (args, exec) => {
      const meta = storage.loadMeta();
      const fresh = !args.force && meta.lastSyncAt && Date.now() - Date.parse(meta.lastSyncAt) < 3600000;
      if (fresh) {
        const s = storage.getSummary();
        return { fetched: 0, added: 0, updated: 0, total: s.total, npmFound: s.withNpm, stopped: "recent-sync", startedAt: meta.lastSyncAt };
      }
      const summary = await syncTopic({ storage, token, npmProbe: config.npmProbe });
      exec.agent?.session?.append?.("audit/sync", syncEvent(summary));
      return {
        fetched: summary.fetched,
        added: summary.added,
        updated: summary.updated,
        total: summary.total,
        npmFound: summary.npmFound,
        stopped: summary.stopped ?? undefined,
        rateRemaining: summary.rate?.remaining,
        startedAt: summary.startedAt,
      };
    },
    presentCall: (args) => ({ card: "generic", title: "Audit sync", kind: "other", rawInput: args }),
  }));

  ctx.tools.register(defineTool({
    name: "audit_top",
    description: "Leaderboard over the local plugin catalog: top plugins by health score, stars, newest, or name, with optional category filter. If nothing is scored yet, run audit_sync first.",
    parameters: {
      sort: {
        type: "string",
        enum: ["score", "stars", "new", "name"],
        description: "Sort key (default score).",
      },
      category: { type: "string", description: "Optional category filter, e.g. 'tools' or 'ui'." },
      limit: { type: "integer", description: "Rows to return (default 10, max 50)." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        required: true,
        properties: {
          rows: {
            type: "array",
            required: true,
            items: {
              type: "object",
              properties: {
                repo: { type: "string", required: true },
                grade: { type: "string" },
                score: { type: "integer" },
                stars: { type: "integer" },
                category: { type: "string" },
                curated: { type: "boolean" },
                npm: { type: "boolean" },
              },
            },
          },
          total: { type: "integer", required: true },
        },
      },
      render: (_args, value) => {
        const lines = ["Top " + value.rows.length + " of " + value.total + " plugins:"];
        for (const r of value.rows) {
          lines.push("  " + (r.grade ? gradeBadge(r.grade) + " " + r.grade + " " + String(r.score).padStart(3) : "  ?   ") + "  " + r.repo + "  " + (r.stars ?? "?") + "★" + (r.curated ? " curated" : "") + (r.npm ? " npm" : "") + (r.category ? " [" + r.category + "]" : ""));
        }
        return [{ type: "text", text: lines.join("\n") }];
      },
    },
    execute: (args) => {
      const records = storage.loadCatalog();
      const rows = listRecords({
        records,
        sort: args.sort ?? "score",
        category: args.category,
        limit: Math.min(args.limit ?? 10, 50),
      }).map((r) => ({
        repo: r.repo,
        grade: r.score?.grade,
        score: r.score?.total ?? null,
        stars: r.stars ?? null,
        category: r.category ?? null,
        curated: r.curated === true,
        npm: r.npm?.exists === true,
      }));
      return { rows, total: records.length };
    },
    presentCall: (args) => ({ card: "generic", title: "Audit top: " + (args.sort ?? "score"), kind: "other", rawInput: args }),
  }));

  ctx.tools.register(defineTool({
    name: "audit_plugin",
    description: "Full health report card for one plugin (owner/name). Shows the score breakdown (maintenance / docs / npm / ecosystem), flags, npm status, and curated listing.",
    parameters: {
      repo: { type: "string", description: "GitHub repo in owner/name form, or the plugin's short name to search.", required: true },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        required: true,
        properties: {
          found: { type: "boolean", required: true },
          repo: { type: "string" },
          report: { type: "string" },
        },
      },
      render: (_args, value) => (value.found
        ? [{ type: "text", text: value.report }]
        : [{ type: "text", text: "plugin not found in catalog: " + (value.repo ?? "?") + " (run audit_sync first)" }]),
    },
    execute: (args) => {
      const q = (args.repo ?? "").trim();
      const records = storage.loadCatalog();
      const rec = records.find((r) => r.repo === q)
        ?? records.find((r) => r.name === q)
        ?? records.find((r) => r.repo.toLowerCase().endsWith("/" + q.toLowerCase()));
      if (!rec) return { found: false, repo: q };
      return { found: true, repo: rec.repo, report: buildReport(rec) };
    },
    presentCall: (args) => ({ card: "generic", title: "Audit: " + args.repo, kind: "other", rawInput: args }),
  }));

  ctx.tools.register(defineTool({
    name: "audit_scan",
    description: "Deep-scan ONE plugin for security: fetch its package.json, shell scripts, and entry sources from GitHub, run static heuristics (remote code execution, encoded commands, rc persistence, obfuscation, exfiltration to non-allowlisted hosts), persist the findings, and re-score. High/critical findings veto the grade to D. Run audit_sync first so the plugin exists in the catalog.",
    parameters: {
      repo: {
        type: "string",
        required: true,
        description: "GitHub repo (owner/name) or the plugin's short name to scan.",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        required: true,
        properties: {
          found: { type: "boolean", required: true },
          repo: { type: "string" },
          filesScanned: { type: "array", items: { type: "string" } },
          trustScore: { type: "integer" },
          grade: { type: "string" },
          findings: { type: "array", items: { type: "string" } },
        },
      },
      render: (_args, value) => {
        if (!value.found) return [{ type: "text", text: "plugin not found in catalog: " + (value.repo ?? "?") + " (run audit_sync first)" }];
        const lines = ["scan " + value.repo + " — trust " + value.trustScore + "/100, grade " + value.grade];
        lines.push("files: " + ((value.filesScanned ?? []).join(", ") || "none"));
        for (const f of value.findings ?? []) lines.push("  ⚑ " + f);
        if ((value.findings ?? []).length === 0) lines.push("  no findings — clean (static scan only, not a guarantee)");
        return [{ type: "text", text: lines.join("\n") }];
      },
    },
    execute: async (args, exec) => {
      const out = await scanPlugin(storage, (args.repo ?? "").trim(), { token });
      exec.agent?.session?.append?.("audit/scan", { repo: out.repo, trustScore: out.trustScore, grade: out.grade });
      return {
        found: out.found,
        repo: out.repo,
        filesScanned: out.filesScanned ?? [],
        trustScore: out.trustScore ?? null,
        grade: out.grade ?? null,
        findings: (out.findings ?? []).map((f) => f.severity + " " + f.rule + ": " + f.detail),
      };
    },
    presentCall: (args) => ({ card: "generic", title: "Audit scan: " + args.repo, kind: "other", rawInput: args }),
  }));

  // Session projection: the catalog summary for the web leaderboard panel.
  ctx.inject(["sessionProjections"], (projectionCtx) => {
    projectionCtx.sessionProjections.register({
      key: "auditSummary",
      schema: zod.union([
        zod.object({
          total: zod.number(),
          scored: zod.number(),
          withNpm: zod.number(),
          flagged: zod.number(),
          lastSyncAt: zod.string().nullable(),
          top: zod.array(zod.object({
            repo: zod.string(),
            grade: zod.string().nullable(),
            score: zod.number().nullable(),
            stars: zod.number().nullable(),
            category: zod.string().nullable(),
          })),
        }),
        zod.null(),
      ]),
      init: () => summarize(storage),
      apply: (state, event) => {
        if (event.type === "audit/sync") return summarize(storage);
        return state;
      },
      view: (state) => state,
      stateVersion: 1,
    });
  });

  // Optional periodic sync. The schedule service may not be mounted on every
  // profile, so guard it: auto-sync is a convenience, never a hard dependency.
  if (config.syncIntervalHours > 0 && typeof ctx.schedule?.setInterval === "function") {
    const ms = config.syncIntervalHours * 3600000;
    ctx.effect(() => ctx.schedule.setInterval(() => {
      syncTopic({ storage, token, npmProbe: config.npmProbe }).catch((err) => {
        console.error("[dsh-plugin-audit] scheduled sync failed:", err);
      });
    }, ms), "audit.sync-schedule()");
  }
}

/** Summarize the catalog for the projection (top 5 by score). */
function summarize(storage) {
  const summary = storage.getSummary();
  const records = storage.loadCatalog();
  const top = listRecords({ records, sort: "score", limit: 5 }).map((r) => ({
    repo: r.repo,
    grade: r.score?.grade ?? null,
    score: r.score?.total ?? null,
    stars: r.stars ?? null,
    category: r.category ?? null,
  }));
  return { ...summary, top };
}

export { Config, apply, inject, name };
