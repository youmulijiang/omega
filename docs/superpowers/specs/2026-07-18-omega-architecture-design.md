# OMEGA 架构设计文档

**日期：** 2026-07-18  
**项目：** OMEGA — 基于 Pi 框架的网络安全专用 Agent  
**上游：** https://github.com/earendil-works/pi.git (v0.80.10)

---

## 1. 项目目标

在 Pi agent harness 之上二次开发，构建一个面向**网络安全**场景的专用 agent CLI，名为 **OMEGA**。

核心要求：
- 用户通过 `omega` 命令启动，TUI 展示 OMEGA 品牌
- 底层功能与 Pi 完全兼容（AI providers、扩展系统、工具调用）
- 可频繁（每周或随上游发版）从 Pi 上游拉取更新，冲突最小化
- 小团队内部分发

---

## 2. 架构方案：扩展包层 + 最小 Patch 原则

OMEGA 的所有定制逻辑集中在新增的 `packages/omega-core/` 包中，利用 Pi 已有的扩展 API 实现，**尽量不改动上游 Pi 包**。

**Pi 扩展系统支持的能力：**
- `pi.registerCommand()` — 自定义斜杠命令
- `pi.registerTool()` / `pi.setActiveTools()` — 自定义 agent 工具
- 自定义 TUI 组件（header、footer、status line、overlay）
- 自定义系统提示词
- 权限门控（对危险操作拦截确认）
- 事件总线

---

## 3. Monorepo 目录结构

```
omega/                          ← 项目根（fork 自 Pi）
├── packages/
│   ├── ai/                     ← Pi 上游，不动
│   ├── agent/                  ← Pi 上游，不动
│   ├── coding-agent/           ← Pi 上游，最多品牌 patch（1-2 处）
│   ├── tui/                    ← Pi 上游，最多颜色/主题 patch
│   ├── orchestrator/           ← Pi 上游，不动
│   │
│   └── omega-core/             ← OMEGA 核心扩展包（新增）
│       ├── package.json        （name: "@omega/core"）
│       ├── src/
│       │   ├── entry.ts        ← omega CLI 入口，注册所有扩展
│       │   ├── branding/       ← OMEGA 主题、颜色、header/footer 组件
│       │   ├── commands/       ← 安全专用斜杠命令
│       │   ├── tools/          ← 注册给 agent 的安全工具
│       │   ├── prompts/        ← 网络安全 system prompt
│       │   └── permissions/    ← 危险操作权限门控
│       └── tests/
│
├── .omega/                     ← OMEGA 全局配置目录（对应 Pi 的 .pi/）
│   └── extensions/             ← 运行时加载 omega-core
│
├── OMEGA-PATCHES.md            ← 核心 patch 登记表
├── OMEGA-CHANGELOG.md          ← OMEGA 版本记录
└── ...（Pi 原有文件保持不变）
```

---

## 4. `omega-core` 内部架构

### 4.1 启动入口 `entry.ts`

```typescript
export default function omegaExtension(pi: ExtensionAPI) {
  registerBranding(pi)      // TUI 品牌
  registerCommands(pi)      // 安全命令
  registerTools(pi)         // 安全工具
  registerPermissions(pi)   // 危险操作门控
  registerPrompts(pi)       // 安全系统提示词
}
```

`omega` CLI 命令通过 `package.json` 的 `bin` 字段暴露，内部调用 coding-agent programmatic API，并将 omega-core 作为默认扩展预加载。

### 4.2 `commands/` — 斜杠命令（初始版本）

| 命令 | 用途 |
|------|------|
| `/report` | 将当前会话输出格式化为渗透测试报告（Markdown） |

后续可扩展：`/recon`、`/cve`、`/scan`、`/payload` 等。

### 4.3 `tools/` — Agent 工具（初始版本）

预留结构，初始版本不注册额外工具，待业务需求明确后逐步添加：
- `network_scan`、`dns_lookup`、`whois_query`、`cve_search`、`hash_identify`、`encode_decode`

### 4.4 `branding/` — TUI 品牌

- 自定义 header：显示 OMEGA 品牌名 + 当前项目/目标
- 自定义 status line：显示当前模式（recon / exploit / report）
- 安全主题配色：深色、高对比度

### 4.5 `permissions/` — 危险操作门控

对高危操作拦截并弹出确认对话框，流程：

```
用户输入 → agent 决策 → [OMEGA 权限门控] → 确认对话框 → 执行
```

### 4.6 `prompts/` — 网络安全系统提示词

预置网络安全语境：安全术语理解、操作合规提醒、报告格式规范。

---

## 5. Git 策略

### Remote 配置

```
origin   → git@github.com:your-org/omega.git   （私有仓库）
upstream → https://github.com/earendil-works/pi.git  （Pi 官方）
```

### 分支结构

```
main              ← OMEGA 稳定分支，团队日常基于此开发
upstream-sync/*   ← 临时分支，专门用于 merge upstream
feat/*            ← 功能开发分支
```

---

## 6. Patch 管理规范

### `OMEGA-PATCHES.md` 记录格式

```markdown
## [PATCH-XXX] 包名: 改动简述

- 文件: packages/xxx/src/xxx.ts:行号
- 改动: 具体改了什么
- 原因: 为什么必须改上游文件
- 上游同步风险: 低 / 中 / 高
- 上次验证: YYYY-MM-DD @ vX.X.X
```

### 代码内标注规范

```typescript
// OMEGA-PATCH: PATCH-XXX - 简述
```

### 目标约束

- OMEGA-PATCHES 长期维持在 **5 条以内**
- 每次上游 sync 冲突解决时间控制在 **10 分钟以内**

---

## 7. 上游同步 SOP

```bash
# 每周或随上游发版执行
git fetch upstream
git checkout -b upstream-sync/vX.X.X
git merge upstream/main

# 冲突处理：优先检查 OMEGA-PATCHES.md 登记的位置
# 对每个冲突文件确认 OMEGA patch 是否仍然有效

# 更新 OMEGA-PATCHES.md 中的"上次验证"日期
git add OMEGA-PATCHES.md
git commit -m "chore: sync upstream vX.X.X, verify patches"

# 合回 main
git checkout main
git merge upstream-sync/vX.X.X
git branch -d upstream-sync/vX.X.X
```

---

## 8. 内部分发策略

- 发布为私有 npm 包（`@omega/core`）至组织内部 registry
- 或直接通过 git 安装：`npm install git+ssh://git@github.com:your-org/omega.git`
- 维护独立的 `OMEGA-CHANGELOG.md`，与 Pi 的 changelog 区分

---

## 9. 决策记录

| 决策 | 原因 |
|------|------|
| 选择扩展包层方案（方案 B）而非深度 fork | 频繁同步需求下冲突面最小，Pi 扩展 API 已足够强大 |
| `omega-core` 作为独立 package 而非直接改 coding-agent | 清晰隔离，上游升级不影响 OMEGA 逻辑 |
| 初始只实现 `/report` 命令 | YAGNI 原则，其他命令待实际业务需求驱动 |
| 使用 `upstream-sync/*` 临时分支隔离 merge | 保护 `main` 分支，团队可 review 冲突解决过程 |
