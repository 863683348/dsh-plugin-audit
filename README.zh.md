# dsh-plugin-audit — DSH 插件生态体检

把 GitHub 的 `dsh-plugin` 主题变成 DeepSeek Harness **本地、可打分的插件目录**。
每个插件按四个信号获得 0–100 健康分，Web UI 里有榜单，Agent 工具能回答
*"这些插件里哪些值得装？"*。

| 信号 | 权重 | 衡量内容 |
| --- | --- | --- |
| 维护活跃度 | 30 | 最近 push 时间 + star 档位 + **star 趋势**（archived → 0 分并 🚨 标记） |
| 文档质量 | 25 | README 有无 + 描述完整度 + 许可证 |
| npm | 30 | npm 包是否存在 + 发布活跃度 |
| 生态 | 15 | 是否被精选列表收录 + 收录时间 |

评级：**A 🛡️（80+）** · **B ✅（60+）** · **C ⚠️（40+）** · **D 🚨（<40 或命中高危标记）**。
评分是对普通记录对象的纯函数——完全可解释（每一项扣分都带证据说明）。

**安全（v0.2）是"否决权"，不是权重：** `audit_scan` 静态扫描插件的
package.json 安装脚本、shell 脚本与入口源码，检测远程代码执行、编码命令、
rc 持久化、混淆、向非白名单域名外传数据。高危/严重发现进入 `flags` 契约
→ **直接封顶 D 级**，无论其他信号多健康。每条发现都带证据；扫描器刻意保守。

## 功能

| 功能 | 状态 |
| --- | --- |
| `audit_sync` — 全量同步 topic、探测 npm、重算评分（增量、限流感知） | ✅ 稳定 |
| `audit_top` — 按分数/star/最新/名称排行，支持分类过滤 | ✅ 稳定 |
| `audit_plugin` — 单插件完整报告卡（含证据） | ✅ 稳定 |
| `audit_scan` — 单插件静态安全扫描（文件 → 发现 → 否决） | ✅ 稳定（v0.2） |
| star 趋势进入维护信号（基于滚动历史快照） | ✅ 稳定（v0.2） |
| `auditSummary` 会话投影 + 输入框上方榜单面板 | 🧪 实验性 |
| 定时同步（schedule 服务存在时） | 🧪 防护式启用 |
| 从 awesome-dsh-plugin 生成种子目录（1018 个插件） | ✅ 稳定 |

## 工作原理

- 单个 Cordis 插件：主机面（`lib/index.js`）注册工具 + 投影 + 可选定时；
  浏览器面（`lib/client.js`）渲染面板；`cordis.patch.yml` 挂载组合行。
- 同步拉取 `GET /search/repositories?q=topic:dsh-plugin`（每页 100 条），以有界并发探测
  `registry.npmjs.org/<name>`，再 upsert 进 JSON 目录。限流感知：搜索预算不足时提前停止，
  下次继续；失败的探测保留旧值。
- 存储：`dataDir`（默认 `$DSH_HOME/dsh-plugin-audit` 或 `~/.dsh/dsh-plugin-audit`）下的
  `catalog.json` + `meta.json` + `history.json`（star 历史快照，为趋势打分预留）。
- 所有写入原子化（临时文件 + 重命名）；文件损坏时回退为空而不是崩溃。

## 安装

本包声明了 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`，走 DSH 官方插件管理：

```bash
# 本地路径安装
dsh plugin --profile <profile> add /path/to/dsh-audit

# 或发布到 npm 后
dsh plugin --profile <profile> add dsh-audit
```

重启 DSH。`audit_*` 工具全局注册；Web profile 上输入框上方会出现榜单面板。

### 首次同步

给 Agent 一个 GitHub Token（搜索 API 30 次/分钟 vs 匿名 10 次），让它执行 `audit_sync`，
或配置：

- `dataDir` — 目录位置（空 = 默认）
- `githubToken` — 或环境变量 `DSH_GITHUB_TOKEN` / `GITHUB_TOKEN`
- `syncIntervalHours` — 定时同步间隔（0 关闭；需要 schedule 服务）
- `npmProbe` — 是否探测 npm（默认 true）

### 独立运行（不依赖 DSH，测试/CI 用）

```bash
node scripts/seed.mjs                       # 从 awesome 列表检出目录生成 data/catalog.json
node scripts/sync.mjs --token <gh-token>    # 真实同步，无需 DSH
node --test test/                           # 跑测试
```

## 开发说明

- 测试完全离线（注入假 `fetch`）——`node --test test/` 不需要网络。
- 数据模型：每个仓库一条记录（`repo`、`stars`、`pushedAt`、`license`、
  `archived`、`npm`、`curated`、`addedAt`、`score`、`flags` …）。见 `lib/audit.js`
  的 `repoToRecord` 和 `lib/scoring.js`。
- `flags` 数组是安全分层（v0.2）的扩展契约。

## 路线图

- v0.3 — 开放数据导出（JSON），供其他市场引用评分
- v0.4 — 每个插件的申诉/评论通道
- v0.5 — 批量扫描调度（每次同步自动扫描 star 前 N）+ 传递依赖信号

## License

MIT