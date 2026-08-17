import test from "node:test";
import assert from "node:assert/strict";
import { probeNpm } from "../lib/audit.js";

test("probeNpm: carries weekly downloads from the downloads API", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes("/downloads/point/last-week/")) {
      return { ok: true, json: async () => ({ downloads: 2345 }) };
    }
    return {
      status: 200, ok: true,
      json: async () => ({ "dist-tags": { latest: "1.2.3" }, versions: { "1.2.3": {} }, time: { "1.2.3": "2026-08-01T00:00:00Z", created: "2026-01-01T00:00:00Z" } }),
    };
  };
  const out = await probeNpm("some-pkg", { fetchImpl });
  assert.equal(out.exists, true);
  assert.equal(out.version, "1.2.3");
  assert.equal(out.weeklyDownloads, 2345);
  assert.ok(calls.some((u) => u.includes("/downloads/point/last-week/some-pkg")));
});

test("probeNpm: 404 package has no downloads", async () => {
  const fetchImpl = async () => ({ status: 404, ok: false });
  const out = await probeNpm("ghost-pkg", { fetchImpl });
  assert.equal(out.exists, false);
});
