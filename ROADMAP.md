# dsh-audit 路线图（Roadmap）

> 基线：**v0.4.0**（已发布 npm / 已挂 vertical-toolkits profile）
> 范围：接下来 5 个版本 **v0.5.0 → v0.9.0**
> 规划原则：评分与扫描逻辑保持纯函数可单测；网络与存储分层（catalog/scanner/scoring/storage）；每个 minor 交付 1–2 个可独立验证的能力。

## 版本总览

| 版本 | 主题 | 关键交付 |
|---|---|---|
| v0.5.0 | 历史与升降榜 | `audit_history` 评分时间线 + 涨幅/跌幅榜（movers） |
| v0.6.0 | 供应链与克隆检测 | 依赖树风险扫描 + 同源/克隆仓库聚类 |
| v0.7.0 | 分类榜与报告导出 | 分类 top-N / 新晋榜 + 全量报告导出（md/json） |
| v0.8.0 | Web 榜单增强 | 榜单筛选/搜索/详情页 + 评分权重可配置 |
| v0.9.0 | 多源融合 | awesome + FindHarness + npm + GitHub 融合评分 + 私有目录模式 |

## v0.5.0（下一个版本）— 历史与升降榜

### 新增能力
- **评分快照持久化**：`audit_sync` 完成后把每个插件的评分写入插件数据目录的 `scores.json`（与 `history.json` 星标快照并列，原子写入），每仓库保留最近 120 个样本。
- **`audit_history` 工具**：输出指定插件的评分时间线（时间/分数/等级）与趋势方向；支持 `movers` 模式列出涨幅/跌幅最大的插件（跨全部仓库、限定窗口）。

### 实现位置
- `lib/trend.js`（新增）：快照追加、解析、趋势与 movers 纯函数
- `lib/index.js`：注册 `audit_history`；`audit_sync` 追加快照

### 验收标准
- [ ] `node --check` 通过；新增单测 ≥ 6 个（快照追加/截断、趋势方向、movers 排序与窗口、空数据）
- [ ] 原有 7 个测试文件全绿
- [ ] README 更新（新工具 `audit_history` 与 scores.json 说明）
- [ ] vertical-toolkits dump-config 正常

## v0.6.0 — 供应链与克隆检测

- 依赖树风险扫描：读取插件 package.json 依赖 → 未维护/高版本区间/已知问题标记
- 克隆/同源聚类：README 与描述指纹相似度聚类，识别 tag farming 批量仓库

## v0.7.0 — 分类榜与报告导出

- `audit_top` 增加分类榜与新晋榜（近 N 天首次上榜）
- `audit_report`：全量目录与评分导出（Markdown + JSON）

## v0.8.0 — Web 榜单增强

- 榜单页筛选（分类/等级/风险标记）、搜索与插件详情页
- 评分权重可配置（YAML 覆盖四维权重）

## v0.9.0 — 多源融合

- 融合 awesome 列表、FindHarness、npm 元数据与 GitHub 信号
- 私有目录模式：不依赖公共 topic 的企业内网目录审计

## 发布节奏

每个版本走完整 dsh-factory 流程：本地验证 → npm publish → GitHub topic → awesome PR。
