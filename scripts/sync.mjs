#!/usr/bin/env node
/**
 * Standalone sync runner (outside DSH, for testing and CI).
 *
 * Usage:
 *   node scripts/sync.mjs                     # incremental, token from env
 *   node scripts/sync.mjs --token <gh-token>  # explicit token (30/min limit)
 *   node scripts/sync.mjs --data-dir <dir>    # custom catalog location
 *   node scripts/sync.mjs --no-npm            # skip the npm probe
 */
import { Storage } from "../lib/storage.js";
import { syncTopic } from "../lib/audit.js";

const args = process.argv.slice(2);
const tokenFlag = args.indexOf("--token");
const dirFlag = args.indexOf("--data-dir");
const token = tokenFlag >= 0 ? args[tokenFlag + 1] : (process.env.DSH_GITHUB_TOKEN || process.env.GITHUB_TOKEN || "");
const dataDir = dirFlag >= 0 ? args[dirFlag + 1] : "";
const npmProbe = !args.includes("--no-npm");

const storage = new Storage(dataDir).ensureDir();
console.log("catalog dir: " + storage.dir);
console.log("token: " + (token ? "provided" : "none (anonymous 10 req/min search budget)"));
try {
  const summary = await syncTopic({ storage, token, npmProbe });
  console.log(JSON.stringify(summary, null, 1));
  console.log("done.");
} catch (err) {
  console.error("sync failed:", err.message);
  process.exit(1);
}
