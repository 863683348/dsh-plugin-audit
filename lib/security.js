/**
 * dsh-plugin-audit — static security heuristics (v0.2).
 *
 * Pure text scanners over the files a plugin ships: package.json install
 * scripts, shell scripts, and JS entry sources. Every rule returns
 * { id, severity, detail } findings; severity ∈ info|medium|high|critical.
 *
 * Design rules:
 *   - Static only, deterministic, no code execution — findings are evidence
 *     for a human reviewer, never a final verdict.
 *   - High/critical findings veto the grade (scoreRecord pushes them into
 *     `flags` → grade D), medium/low/info just lower the trust score.
 *   - Allowlisted domains never fire the network-callback rule.
 *
 * The scanner is deliberately conservative: false negatives are acceptable,
 * false positives erode trust. When in doubt, report with lower severity.
 */

/** Domains a plugin may legitimately talk to without review. */
export const NET_ALLOWLIST = [
  "api.github.com", "raw.githubusercontent.com", "registry.npmjs.org",
  "github.com", "api.deepseek.com", "deepseek.com", "localhost", "127.0.0.1",
  "0.0.0.0", "::1",
];

const SEVERITY_WEIGHT = { critical: 40, high: 20, medium: 8, low: 3, info: 1 };

/** Run a regex over text and return a finding detail or null. */
function find(patterns, text) {
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) return m[0].slice(0, 120);
  }
  return null;
}

/** Network exfiltration: suspicious domains outside the allowlist. */
export function scanNetworkUrls(text, path) {
  const findings = [];
  const re = /(?:fetch\(\s*["']|https?:\/\/)([a-zA-Z0-9.-]+\.[a-z]{2,})(?:[\/"']|\s)/g;
  let m;
  const seen = new Set();
  while ((m = re.exec(text)) !== null) {
    const host = m[1].toLowerCase();
    if (NET_ALLOWLIST.some((d) => host === d || host.endsWith("." + d))) continue;
    if (seen.has(host)) continue;
    seen.add(host);
    findings.push({
      rule: "net-callback",
      severity: host.includes("telegram") || host.includes("t.me") || host.includes("discord") ? "high" : "medium",
      detail: "network call to non-allowlisted host: " + host + " (" + path + ")",
    });
  }
  return findings;
}

/** package.json install scripts + shell lines. */
export function scanManifest(text, path = "package.json") {
  const findings = [];
  let pkg = null;
  try {
    pkg = JSON.parse(text);
  } catch {
    findings.push({ rule: "manifest-invalid", severity: "medium", detail: "package.json is not valid JSON (" + path + ")" });
    return findings;
  }
  const scripts = pkg?.scripts ?? {};
  const installish = Object.entries(scripts).filter(([k]) =>
    /^(preinstall|install|postinstall|prepare|prepublish|prepublishOnly|postinstall)$/i.test(k));
  for (const [k, body] of installish) {
    if (typeof body !== "string" || body.length === 0) continue;
    const s = body;
    if (find([/(?:curl|wget)[^;|&]*\|\s*(?:ba)?sh\b/i], s)) {
      findings.push({ rule: "pipe-remote-to-shell", severity: "critical", detail: k + " pipes a remote fetch into a shell: " + s.slice(0, 100) });
    }
    if (find([/curl[^;|&]*(?:-o|-O|--output)\s+[^;|&]+[;|&]\s*[^;|&]*sh\b/i, /wget[^;|&]*(?:-O|--output-document)\s+[^;|&]+[;|&]\s*[^;|&]*sh\b/i], s)) {
      findings.push({ rule: "download-then-exec", severity: "high", detail: k + " downloads then executes: " + s.slice(0, 100) });
    }
    if (find([/base64\s*-d[^;|&]*\|\s*(?:ba)?sh\b/i, /powershell[^;|&]*(?:-enc|\s-e\s)/i, /-e\s+[A-Za-z0-9+/=]{40,}/i], s)) {
      findings.push({ rule: "encoded-command", severity: "critical", detail: k + " decodes an encoded command: " + s.slice(0, 100) });
    }
    if (find([/\beval\b/i, /\bsh\s+-c\b/i], s)) {
      findings.push({ rule: "eval-in-script", severity: "high", detail: k + " evaluates a command string: " + s.slice(0, 100) });
    }
    if (find([/~\/\.(?:bashrc|zshrc|profile|bash_profile|zprofile)/i, /\.bashrc|\/\.zshrc/], s)) {
      findings.push({ rule: "rc-persistence", severity: "critical", detail: k + " writes to a shell rc file (persistence): " + s.slice(0, 100) });
    }
    if (find([/\bchmod\s+[+]?x\b/], s)) {
      findings.push({ rule: "chmod-exec", severity: "medium", detail: k + " chmods a file executable: " + s.slice(0, 100) });
    }
    findings.push({ rule: "install-script", severity: "medium", detail: k + " runs code at install time: " + s.slice(0, 100) });
  }
  return findings;
}

/** Shell scripts: persistence, remote exec, obfuscation. */
export function scanShell(text, path) {
  const findings = [];
  if (find([/(?:curl|wget)[^;|&]*\|\s*(?:ba)?sh\b/i], text)) {
    findings.push({ rule: "pipe-remote-to-shell", severity: "critical", detail: "pipes a remote fetch into a shell (" + path + ")" });
  }
  if (find([/base64\s*-d[^;|&]*\|\s*(?:ba)?sh\b/i, /-e\s+[A-Za-z0-9+/=]{40,}/i, /powershell[^;|&]*(?:-enc|\s-e\s)/i], text)) {
    findings.push({ rule: "encoded-command", severity: "critical", detail: "decodes an encoded command (" + path + ")" });
  }
  if (find([/~\/\.(?:bashrc|zshrc|profile|bash_profile|zprofile)/i], text)) {
    findings.push({ rule: "rc-persistence", severity: "critical", detail: "writes to a shell rc file (" + path + ")" });
  }
  if (find([/\beval\b/i, /\bsh\s+-c\b/i], text)) {
    findings.push({ rule: "eval-in-script", severity: "high", detail: "evaluates a command string (" + path + ")" });
  }
  const urls = scanNetworkUrls(text, path);
  findings.push(...urls);
  return findings;
}

/** JS sources: dynamic code, child processes, env exfiltration, obfuscation. */
export function scanSource(text, path) {
  const findings = [];
  if (find([/\beval\s*\(/i], text)) {
    findings.push({ rule: "eval", severity: "high", detail: "eval() in source (" + path + ")" });
  }
  if (find([/new\s+Function\s*\(/i, /Function\s*\(\s*["']/i], text)) {
    findings.push({ rule: "dynamic-code", severity: "medium", detail: "dynamic code construction (" + path + ")" });
  }
  if (find([/(?:child_process\.(?:exec|execSync|spawn|spawnSync))|(?:require\(["']child_process["']\))/i], text)) {
    findings.push({ rule: "child-process", severity: "medium", detail: "spawns child processes (" + path + ")" });
  }
  if (find([/atob\s*\([^)]{80,}/i, /fromCharCode\([^)]{200,}/i, /[A-Za-z0-9+/=]{200,}/i], text)) {
    findings.push({ rule: "obfuscation", severity: "medium", detail: "possible obfuscated blob (" + path + ")" });
  }
  const urls = scanNetworkUrls(text, path);
  findings.push(...urls);
  const envRead = /process\.env\s*\[/.test(text) || /process\.env\.[A-Za-z_]+/.test(text);
  const exfil = urls.some((f) => f.severity === "high" || f.severity === "medium");
  if (envRead && exfil) {
    findings.push({ rule: "env-exfil", severity: "high", detail: "reads process.env and sends data to a non-allowlisted host (" + path + ")" });
  }
  if (envRead && !exfil) {
    findings.push({ rule: "env-read", severity: "info", detail: "reads process.env (" + path + ")" });
  }
  return findings;
}

/** Run every scanner over a set of files; produce findings + a trust score. */
export function runSecurityScan(files) {
  const findings = [];
  for (const file of files) {
    const { path, text } = file;
    if (!text) continue;
    if (/package\.json$/.test(path)) findings.push(...scanManifest(text, path));
    else if (/\.(sh|bash|zsh)$/.test(path) || path.startsWith("scripts/")) findings.push(...scanShell(text, path));
    else if (/\.(js|cjs|mjs|ts|mts|cts)$/.test(path)) findings.push(...scanSource(text, path));
    else findings.push(...scanNetworkUrls(text, path));
  }
  const seen = new Set();
  const unique = findings.filter((f) => {
    const k = f.rule + "|" + f.severity + "|" + f.detail;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const order = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  unique.sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9));
  const trustScore = Math.max(0, 100 - unique.reduce((acc, f) => acc + (SEVERITY_WEIGHT[f.severity] ?? 1), 0));
  return { findings: unique, trustScore };
}

/** True when any finding would veto the grade. */
export function hasVetoFinding(findings) {
  return findings.some((f) => f.severity === "critical" || f.severity === "high");
}
