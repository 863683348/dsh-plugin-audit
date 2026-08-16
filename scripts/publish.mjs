#!/usr/bin/env node
/**
 * Publish the packed tarball. Requires NPM_TOKEN (automation token).
 *   $env:NPM_TOKEN=... ; node scripts/publish.mjs
 */
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const tgz = readdirSync(join(here, "..")).find((f) => f.endsWith(".tgz"));
if (!tgz) { console.error("no .tgz found — run `npm pack` first"); process.exit(1); }
const token = process.env.NPM_TOKEN;
if (!token) { console.error("NPM_TOKEN is required (create at https://www.npmjs.com/settings/<user>/tokens)"); process.exit(1); }
execFileSync("npm.cmd", ["publish", join(here, "..", tgz), "--//registry.npmjs.org/:_authToken=" + token], { stdio: "inherit" });
console.log("published:", tgz);