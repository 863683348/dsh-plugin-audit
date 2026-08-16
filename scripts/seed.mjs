#!/usr/bin/env node
/**
 * Seed the catalog from the local awesome-dsh-plugin checkout.
 *
 * Reads ../awesome-dsh-plugin/data/plugins/*.yml (curated list: url, name,
 * category, description.en/zh) + data/added-dates.json, and writes
 * data/catalog.json with one record per plugin. Live metrics (stars, push,
 * npm, score) are intentionally left null — the seed is an offline scaffold;
 * run `audit_sync` (or scripts/sync.mjs) to fill them in.
 *
 * Usage: node scripts/seed.mjs [--source <dir>] [--out <file>]
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const srcFlag = args.indexOf("--source");
const outFlag = args.indexOf("--out");
const SOURCE = srcFlag >= 0 ? args[srcFlag + 1] : join(HERE, "..", "..", "awesome-dsh-plugin", "data");
const OUT = outFlag >= 0 ? args[outFlag + 1] : join(HERE, "..", "data", "catalog.json");

function unquote(v) {
  if (typeof v !== "string") return v;
  const t = v.trim();
  if (t.startsWith("'") && t.endsWith("'") && t.length >= 2) return t.slice(1, -1).replace(/''/g, "'");
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  return t;
}

/** Parse the flat per-plugin YAML used by awesome-dsh-plugin. */
export function parseEntryYaml(text) {
  const out = { description: {} };
  let desc = false;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^(\s*)([A-Za-z0-9_-]+):(?:\s*(.*))?$/);
    if (!m) continue;
    const indent = m[1].length;
    const key = m[2];
    const val = (m[3] ?? "").trim();
    if (indent === 0) {
      desc = false;
      if (key === "description") { desc = true; continue; }
      if (key === "url" || key === "name" || key === "category") out[key] = unquote(val);
    } else if (desc && indent >= 2 && (key === "en" || key === "zh")) {
      out.description[key] = unquote(val);
    }
  }
  return out;
}

export function repoFromUrl(url) {
  const p = String(url ?? "").replace(/^https?:\/\/github\.com\//, "").replace(/\/+$/, "").split("/");
  return p.slice(0, 2).join("/");
}

export function buildSeed({ pluginsDir, addedDatesPath }) {
  const files = readdirSync(pluginsDir).filter((f) => f.endsWith(".yml"));
  const addedDates = existsSync(addedDatesPath) ? JSON.parse(readFileSync(addedDatesPath, "utf8")) : {};
  const records = [];
  for (const f of files) {
    const entry = parseEntryYaml(readFileSync(join(pluginsDir, f), "utf8"));
    const url = entry.url ?? "";
    if (!url) continue;
    const repo = repoFromUrl(url);
    const name = entry.name ?? repo.split("/").pop() ?? repo;
    const en = entry.description.en ?? "";
    const zh = entry.description.zh ?? "";
    records.push({
      repo,
      url,
      name,
      description: en || zh || "",
      descriptionEn: en || null,
      descriptionZh: zh || null,
      category: entry.category ?? null,
      curated: true,
      addedAt: addedDates[url] ?? null,
      stars: null,
      createdAt: null,
      updatedAt: null,
      pushedAt: null,
      archived: false,
      license: null,
      hasReadme: null,
      topics: [],
      npm: null,
      score: null,
      checkedAt: null,
      gone: false,
    });
  }
  records.sort((a, b) => a.repo.localeCompare(b.repo));
  return records;
}

const records = buildSeed({
  pluginsDir: join(SOURCE, "plugins"),
  addedDatesPath: join(SOURCE, "added-dates.json"),
});
writeFileSync(OUT, JSON.stringify(records, null, 1) + "\n");

// companion meta so a seeded catalog shows as "seeded, not synced"
const metaOut = join(dirname(OUT), "meta.json");
writeFileSync(metaOut, JSON.stringify({
  version: 1,
  lastSyncAt: null,
  lastSyncStatus: "seeded",
  counts: { total: records.length, npmFound: 0, curated: records.length, gone: 0 },
  rateLimit: null,
}, null, 1) + "\n");

console.log("seed: " + records.length + " records -> " + OUT);
const byCat = {};
for (const r of records) byCat[r.category ?? "-"] = (byCat[r.category ?? "-"] ?? 0) + 1;
console.log("categories:", Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + "=" + v).join(", "));
