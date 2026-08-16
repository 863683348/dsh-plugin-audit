/**
 * dsh-plugin-audit — browser face: a leaderboard dock above the composer,
 * rendered from the `auditSummary` session projection.
 *
 * Mirrors the loader format emitted by in-repo client bundles
 * (window.__ModuleLoader__.load with a CommonJS factory), served via the
 * client-modules roster (/plugins/<id>/client.js) on web profiles. React is
 * resolved through the app's module table; no JSX, no bundler, no TS.
 */
window.__ModuleLoader__.load({
  id: "dsh-plugin-audit/client",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var react = require("react");

    var cssId = "dsh-plugin-audit/client";
    var css = [
      ".dspa-dock{box-sizing:border-box;width:100%;max-width:calc(var(--dsh-composer-card-max-width) - 4 * var(--dsh-composer-dock-inset));margin:0 auto;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-specific-tip);border-radius:12px;padding:8px 12px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary)}",
      ".dspa-head{font-weight:500;margin-bottom:4px;color:var(--dsw-alias-label-secondary)}",
      ".dspa-row{display:flex;gap:6px;align-items:baseline;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".dspa-repo{overflow:hidden;text-overflow:ellipsis;flex:1}",
      ".dspa-meta{color:var(--dsw-alias-label-caption);font-size:11px}",
      ".dspa-empty{color:var(--dsw-alias-label-caption)}",
      ".dspa-badge{font-weight:600}",
    ].join("");
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=\"" + cssId + "\"]") === null) {
      var tag = document.createElement("style");
      tag.dataset.plugin = "dsh-plugin-audit";
      tag.dataset.pluginCss = cssId;
      tag.textContent = css;
      document.head.appendChild(tag);
    }

    var BADGE = { A: "🛡️", B: "✅", C: "⚠️", D: "🚨" };

    function fmtDate(iso) {
      if (!iso) return "never";
      try { return new Date(iso).toLocaleString(); } catch { return String(iso); }
    }

    /** Leaderboard dock: catalog summary + top scored plugins. */
    function AuditPanel(props) {
      var useProjection = props.useProjection;
      var projection = useProjection("auditSummary");
      if (projection == null) {
        return react.createElement("div", { className: "dspa-dock", "data-audit-panel": true },
          react.createElement("div", { className: "dspa-empty" }, "Plugin audit: catalog unavailable."));
      }
      var rows = [];
      if (projection.total === 0) {
        rows.push(react.createElement("div", { key: "empty", className: "dspa-empty" },
          "插件体检：目录为空 — 让 Agent 运行 audit_sync 同步 GitHub dsh-plugin 生态。"));
      } else {
        var top = (projection.top || []).map(function (r) {
          return react.createElement("div", { key: r.repo, className: "dspa-row" },
            react.createElement("span", { className: "dspa-badge" }, r.grade ? (BADGE[r.grade] || "❓") + " " + r.grade : "? "),
            react.createElement("span", { className: "dspa-repo" }, r.repo),
            react.createElement("span", { className: "dspa-meta" }, (r.score != null ? r.score + "/100" : "") + (r.stars != null ? " · " + r.stars + "★" : "") + (r.category ? " · " + r.category : "")));
        });
        rows.push(react.createElement("div", { key: "counts", className: "dspa-meta" },
          projection.total + " 插件 · " + projection.scored + " 已评分 · " + projection.withNpm + " 有 npm 包 · " + projection.flagged + " 带警示 · 上次同步 " + fmtDate(projection.lastSyncAt)));
        rows = rows.concat(top);
      }
      return react.createElement("div", { className: "dspa-dock", "data-audit-panel": true },
        react.createElement("div", { className: "dspa-head" }, "🩺 DSH 插件体检"),
        rows);
    }

    /** Browser plugin body: register the dock entry into the composer dock. */
    function apply(ctx) {
      ctx.slots.inject("conversation.input.dock", function () {
        return ctx.slots.register({
          name: "conversation.input.dock",
          id: "audit-leaderboard",
          order: 40,
        }, AuditPanel);
      });
    }

    exports.name = "audit-ui";
    exports.apply = apply;
    exports.inject = ["@deepseek-ai/dsh-client-runtime"];
    return module.exports;
  },
});
