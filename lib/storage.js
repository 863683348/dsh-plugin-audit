/**
 * dsh-plugin-audit — local JSON storage for the plugin catalog.
 *
 * All state lives in a single data directory (config `dataDir`, default
 * \$DSH_HOME/dsh-plugin-audit or ~/.dsh/dsh-plugin-audit) as three files:
 *   catalog.json  — one record per plugin repo (array, keyed by `repo`)
 *   meta.json     — sync state (last sync, counts, rate-limit residue)
 *   history.json  — rolling star snapshots per repo (trends for later tiers)
 *
 * Writes are atomic (temp file + rename) so a crash never truncates the
 * catalog. Records are upserted; never silently deleted — a vanished repo is
 * marked with `gone: true` so the leaderboard can still explain itself.
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const DATA_VERSION = 1;
export const HISTORY_CAP = 60;

function defaultDataDir() {
  if (process.env.DSH_HOME) return join(process.env.DSH_HOME, "dsh-plugin-audit");
  return join(homedir(), ".dsh", "dsh-plugin-audit");
}

export function normalizeDataDir(dataDir) {
  return dataDir && dataDir.trim().length > 0 ? dataDir : defaultDataDir();
}

export class Storage {
  constructor(dataDir) {
    this.dir = normalizeDataDir(dataDir);
    this.catalogPath = join(this.dir, "catalog.json");
    this.metaPath = join(this.dir, "meta.json");
    this.historyPath = join(this.dir, "history.json");
  }

  ensureDir() {
    mkdirSync(this.dir, { recursive: true });
    return this;
  }

  readJson(path, fallback) {
    try {
      if (!existsSync(path)) return fallback;
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return fallback; // corrupt file → start fresh, never crash the plugin
    }
  }

  writeJson(path, value) {
    this.ensureDir();
    const tmp = path + ".tmp";
    writeFileSync(tmp, JSON.stringify(value, null, 1) + "\n", "utf8");
    renameSync(tmp, path);
  }

  loadCatalog() {
    const raw = this.readJson(this.catalogPath, []);
    return Array.isArray(raw) ? raw : [];
  }

  saveCatalog(records) {
    this.writeJson(this.catalogPath, records);
  }

  loadMeta() {
    return this.readJson(this.metaPath, {
      version: DATA_VERSION,
      lastSyncAt: null,
      lastSyncStatus: null,
      counts: { total: 0, npmFound: 0, curated: 0, gone: 0 },
      rateLimit: null,
    });
  }

  saveMeta(meta) {
    this.writeJson(this.metaPath, meta);
  }

  loadHistory() {
    const raw = this.readJson(this.historyPath, {});
    return typeof raw === "object" && raw !== null ? raw : {};
  }

  /** Record a star snapshot; keeps the most recent HISTORY_CAP per repo. */
  appendStars(repo, stars, date) {
    if (typeof stars !== "number") return;
    const history = this.loadHistory();
    const list = history[repo] ?? [];
    const last = list[list.length - 1];
    if (last && last.date === date && last.stars === stars) return; // idempotent
    list.push({ date, stars });
    if (list.length > HISTORY_CAP) list.splice(0, list.length - HISTORY_CAP);
    history[repo] = list;
    this.writeJson(this.historyPath, history);
  }

  /** Record many star snapshots in a single read/write (full sync sweeps). */
  appendStarsBatch(entries) {
    const history = this.loadHistory();
    let changed = false;
    for (const { repo, stars, date } of entries) {
      if (typeof stars !== "number" || typeof repo !== "string") continue;
      const list = history[repo] ?? [];
      const last = list[list.length - 1];
      if (last && last.date === date && last.stars === stars) continue;
      list.push({ date, stars });
      if (list.length > HISTORY_CAP) list.splice(0, list.length - HISTORY_CAP);
      history[repo] = list;
      changed = true;
    }
    if (changed) this.writeJson(this.historyPath, history);
  }

  /**
   * Upsert records into the catalog. Existing entries keep their old values
   * for any field the fresh record does not carry (never lose data on a
   * failed probe); fresh values win. `onMerged` receives (repo, record).
   */
  mergeRecords(freshRecords, onMerged) {
    const catalog = this.loadCatalog();
    const byRepo = new Map(catalog.map((r) => [r.repo, r]));
    let added = 0;
    let updated = 0;
    for (const fresh of freshRecords) {
      if (!fresh || typeof fresh.repo !== "string" || fresh.repo.length === 0) continue;
      const prev = byRepo.get(fresh.repo);
      if (!prev) {
        byRepo.set(fresh.repo, fresh);
        added += 1;
      } else {
        const merged = { ...prev, ...fresh, npm: fresh.npm !== undefined ? fresh.npm : prev.npm };
        byRepo.set(fresh.repo, merged);
        updated += 1;
      }
      onMerged?.(fresh.repo, byRepo.get(fresh.repo));
    }
    const records = [...byRepo.values()];
    this.saveCatalog(records);
    return { added, updated, total: records.length };
  }

  getSummary() {
    const catalog = this.loadCatalog();
    const meta = this.loadMeta();
    const scored = catalog.filter((r) => r.score && r.score.total !== null).length;
    const withNpm = catalog.filter((r) => r.npm).length;
    const flagged = catalog.filter((r) => (r.flags?.length ?? 0) > 0).length;
    return {
      total: catalog.length,
      scored,
      withNpm,
      flagged,
      curated: catalog.filter((r) => r.curated).length,
      gone: catalog.filter((r) => r.gone).length,
      lastSyncAt: meta.lastSyncAt,
      lastSyncStatus: meta.lastSyncStatus,
      rateLimit: meta.rateLimit,
    };
  }
}
