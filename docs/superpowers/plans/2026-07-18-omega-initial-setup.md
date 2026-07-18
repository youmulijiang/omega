# OMEGA 初始化搭建 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 Pi monorepo 基础上搭建 OMEGA 项目骨架，包含品牌化 TUI、`/report` 命令、危险操作权限门控，以及上游同步基础设施。

**Architecture:** OMEGA 通过 Pi 的扩展系统实现所有定制，核心逻辑集中在新增的 `packages/omega-core/` 包中。对上游文件的修改仅限于 `packages/coding-agent/package.json`（改品牌名和配置目录），所有其他上游文件保持不变，确保频繁 upstream sync 时冲突最小化。

**Tech Stack:** TypeScript (ESM), Pi ExtensionAPI (`@earendil-works/pi-coding-agent`), vitest, Node.js

## Global Constraints

- 所有 TypeScript 使用 ESM (`"type": "module"`)
- 与上游 Pi 包保持相同的 TypeScript 配置规范（参考 `tsconfig.base.json`）
- omega-core 依赖 `@earendil-works/pi-coding-agent` 和 `@earendil-works/pi-tui` 但**不修改它们**
- 每次修改上游文件必须在 `OMEGA-PATCHES.md` 中登记
- 测试使用 vitest，命令：`npm test --workspace=packages/omega-core`

---

## 文件结构总览

```
新建文件：
  packages/omega-core/package.json
  packages/omega-core/tsconfig.json
  packages/omega-core/src/entry.ts
  packages/omega-core/src/branding/header.ts
  packages/omega-core/src/branding/status.ts
  packages/omega-core/src/branding/index.ts
  packages/omega-core/src/prompts/security.ts
  packages/omega-core/src/prompts/index.ts
  packages/omega-core/src/commands/report.ts
  packages/omega-core/src/commands/index.ts
  packages/omega-core/src/permissions/gate.ts
  packages/omega-core/src/permissions/index.ts
  packages/omega-core/tests/report.test.ts
  packages/omega-core/tests/security-prompt.test.ts
  .omega/extensions/omega.ts
  OMEGA-PATCHES.md
  OMEGA-CHANGELOG.md

修改文件：
  packages/coding-agent/package.json   ← PATCH-001（品牌名 + 配置目录）
  package.json                          ← 添加 packages/omega-core 到 workspaces
```

---

## Task 1: Git 上游配置 + 跟踪文件

**Files:**
- Create: `OMEGA-PATCHES.md`
- Create: `OMEGA-CHANGELOG.md`

**Interfaces:**
- Produces: 无代码接口，仅文档和 git remote

- [ ] **Step 1: 添加 upstream remote**

```bash
git remote add upstream https://github.com/earendil-works/pi.git
git fetch upstream
```

预期输出：`remote: Enumerating objects...` 下载对象，最后 `From https://github.com/earendil-works/pi.git * [new branch] main -> upstream/main`

- [ ] **Step 2: 创建 OMEGA-PATCHES.md**

创建文件 `OMEGA-PATCHES.md`，内容如下：

```markdown
# OMEGA Patches

本文件记录所有对上游 Pi 文件的修改。每次 upstream sync 时，需逐条核验。

## 格式

\`\`\`
## [PATCH-XXX] 包名: 改动简述
- 文件: packages/xxx/src/xxx.ts:行号
- 改动: 具体改了什么
- 原因: 为什么必须改上游文件
- 上游同步风险: 低 / 中 / 高
- 上次验证: YYYY-MM-DD @ vX.X.X
\`\`\`

---

<!-- patches will be added below -->
```

- [ ] **Step 3: 创建 OMEGA-CHANGELOG.md**

创建文件 `OMEGA-CHANGELOG.md`，内容如下：

```markdown
# OMEGA Changelog

## [Unreleased]

### Added
- Initial OMEGA project setup based on Pi v0.80.10
- OMEGA TUI branding (header, status line)
- `/report` slash command for pentest report generation
- Security-specific system prompt
- Dangerous operation permission gate
```

- [ ] **Step 4: 提交**

```bash
git add OMEGA-PATCHES.md OMEGA-CHANGELOG.md
git commit -m "chore: add upstream remote and OMEGA tracking files"
```

---

## Task 2: PATCH-001 — coding-agent 品牌化

**Files:**
- Modify: `packages/coding-agent/package.json`
- Modify: `OMEGA-PATCHES.md`

**Interfaces:**
- Produces: `omega` CLI 命令；`CONFIG_DIR_NAME = ".omega"`；`APP_NAME = "omega"`

- [ ] **Step 1: 修改 coding-agent/package.json**

在 `packages/coding-agent/package.json` 中做以下修改：

将 `"piConfig"` 部分从：
```json
"piConfig": {
  "configDir": ".pi"
}
```
改为：
```json
"piConfig": {
  "name": "omega",
  "configDir": ".omega"
}
```

将 `"bin"` 从：
```json
"bin": {
  "pi": "dist/cli.js"
}
```
改为：
```json
"bin": {
  "omega": "dist/cli.js"
}
```

- [ ] **Step 2: 登记 PATCH-001**

在 `OMEGA-PATCHES.md` 中 `<!-- patches will be added below -->` 后追加：

```markdown
## [PATCH-001] coding-agent: 品牌名改为 omega，配置目录改为 .omega

- 文件: packages/coding-agent/package.json（piConfig + bin 字段）
- 改动: `piConfig.name: "omega"`, `piConfig.configDir: ".omega"`, `bin: {"omega": "dist/cli.js"}`
- 原因: OMEGA 使用独立配置目录，避免与 pi 配置混用；`omega` 为用户启动命令
- 上游同步风险: 低（仅 JSON 字段，上游极少改动）
- 上次验证: 2026-07-18 @ v0.80.10
```

- [ ] **Step 3: 构建并验证 omega 命令可用**

```bash
cd packages/coding-agent && npm run build
```

构建成功后，`dist/cli.js` 存在。

- [ ] **Step 4: 提交**

```bash
git add packages/coding-agent/package.json OMEGA-PATCHES.md
git commit -m "feat(patch-001): rename to omega, use .omega config dir"
```

---

## Task 3: 创建 packages/omega-core/ 包骨架

**Files:**
- Create: `packages/omega-core/package.json`
- Create: `packages/omega-core/tsconfig.json`
- Create: `packages/omega-core/src/entry.ts`
- Modify: `package.json`（根目录 workspaces）

**Interfaces:**
- Produces:
  - `export default function omegaExtension(pi: ExtensionAPI): void` from `src/entry.ts`

- [ ] **Step 1: 创建 packages/omega-core/package.json**

```json
{
  "name": "@omega/core",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/entry.js",
  "types": "./dist/entry.d.ts",
  "scripts": {
    "clean": "shx rm -rf dist",
    "build": "tsgo -p tsconfig.build.json",
    "test": "vitest --run"
  },
  "dependencies": {
    "@earendil-works/pi-coding-agent": "*"
  },
  "devDependencies": {
    "shx": "*",
    "vitest": "*"
  }
}
```

- [ ] **Step 2: 创建 packages/omega-core/tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"]
}
```

同时创建 `packages/omega-core/tsconfig.build.json`：

```json
{
  "extends": "./tsconfig.json",
  "exclude": ["tests/**/*", "**/*.test.ts"]
}
```

- [ ] **Step 3: 创建 packages/omega-core/src/entry.ts 骨架**

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBranding } from "./branding/index.ts";
import { registerCommands } from "./commands/index.ts";
import { registerPermissions } from "./permissions/index.ts";
import { registerPrompts } from "./prompts/index.ts";

export default function omegaExtension(pi: ExtensionAPI): void {
  registerBranding(pi);
  registerCommands(pi);
  registerPermissions(pi);
  registerPrompts(pi);
}
```

- [ ] **Step 4: 将 omega-core 加入根 workspace**

在根目录 `package.json` 的 `"workspaces"` 数组中追加 `"packages/omega-core"`：

```json
"workspaces": [
  "packages/*",
  "packages/omega-core",
  ...
]
```

注意：`packages/*` glob 已经覆盖了 `packages/omega-core`，但由于 omega-core 目录会新建，需要确认 glob 生效。实际上 `packages/*` 已经足够，无需单独添加。只需确认 `packages/omega-core` 在 `packages/` 目录下即可。

- [ ] **Step 5: 安装依赖**

```bash
npm install
```

- [ ] **Step 6: 提交**

```bash
git add packages/omega-core/ package.json package-lock.json
git commit -m "feat: scaffold packages/omega-core extension package"
```

---

## Task 4: OMEGA TUI 品牌化（header + status line）

**Files:**
- Create: `packages/omega-core/src/branding/header.ts`
- Create: `packages/omega-core/src/branding/status.ts`
- Create: `packages/omega-core/src/branding/index.ts`

**Interfaces:**
- Consumes: `ExtensionAPI` from `@earendil-works/pi-coding-agent`
- Produces: `export function registerBranding(pi: ExtensionAPI): void` from `branding/index.ts`

- [ ] **Step 1: 创建 src/branding/header.ts**

```typescript
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";

function renderOmegaHeader(theme: Theme, _width: number): string[] {
  const accent = (t: string) => theme.fg("accent", t);
  const dim = (t: string) => theme.fg("dim", t);
  const muted = (t: string) => theme.fg("muted", t);

  // OMEGA ASCII art (7 lines)
  const lines = [
    "",
    accent(" ██████╗ ███╗   ███╗███████╗ ██████╗  █████╗ "),
    accent("██╔═══██╗████╗ ████║██╔════╝██╔════╝ ██╔══██╗"),
    accent("██║   ██║██╔████╔██║█████╗  ██║  ███╗███████║"),
    accent("██║   ██║██║╚██╔╝██║██╔══╝  ██║   ██║██╔══██║"),
    accent(" ██████╔╝██║ ╚═╝ ██║███████╗╚██████╔╝██║  ██║"),
    accent(" ╚═════╝ ╚═╝     ╚═╝╚══════╝ ╚═════╝ ╚═╝  ╚═╝"),
    muted("  network security agent") + dim("  [ recon · exploit · report ]"),
    "",
  ];

  return lines;
}

export function setupHeader(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    ctx.ui.setHeader((_tui, theme) => ({
      render(width: number): string[] {
        return renderOmegaHeader(theme, width);
      },
      invalidate() {},
    }));
  });
}
```

- [ ] **Step 2: 创建 src/branding/status.ts**

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type OmegaMode = "recon" | "exploit" | "report" | "idle";

const STATUS_KEY = "omega-mode";

function modeLabel(mode: OmegaMode): string {
  const icons: Record<OmegaMode, string> = {
    recon: "◉ recon",
    exploit: "⚡ exploit",
    report: "📋 report",
    idle: "◎ ready",
  };
  return icons[mode];
}

export function setupStatus(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setStatus(STATUS_KEY, modeLabel("idle"));
  });

  pi.on("turn_start", async (_event, ctx) => {
    ctx.ui.setStatus(STATUS_KEY, modeLabel("recon"));
  });

  pi.on("turn_end", async (_event, ctx) => {
    ctx.ui.setStatus(STATUS_KEY, modeLabel("idle"));
  });
}

export function setMode(pi: ExtensionAPI, mode: OmegaMode): void {
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setStatus(STATUS_KEY, modeLabel(mode));
  });
}
```

- [ ] **Step 3: 创建 src/branding/index.ts**

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setupHeader } from "./header.ts";
import { setupStatus } from "./status.ts";

export function registerBranding(pi: ExtensionAPI): void {
  setupHeader(pi);
  setupStatus(pi);
}
```

- [ ] **Step 4: 提交**

```bash
git add packages/omega-core/src/branding/
git commit -m "feat(omega): add OMEGA TUI branding (header + status line)"
```

---

## Task 5: 网络安全系统提示词

**Files:**
- Create: `packages/omega-core/src/prompts/security.ts`
- Create: `packages/omega-core/src/prompts/index.ts`
- Create: `packages/omega-core/tests/security-prompt.test.ts`

**Interfaces:**
- Consumes: `BuildSystemPromptOptions`, `ExtensionAPI` from `@earendil-works/pi-coding-agent`
- Produces: `export function registerPrompts(pi: ExtensionAPI): void` from `prompts/index.ts`
- Produces: `export function buildSecurityPrompt(base: string): string` from `prompts/security.ts`

- [ ] **Step 1: 写失败测试**

创建 `packages/omega-core/tests/security-prompt.test.ts`：

```typescript
import { describe, it, expect } from "vitest";
import { buildSecurityPrompt } from "../src/prompts/security.ts";

describe("buildSecurityPrompt", () => {
  it("在基础 prompt 之后追加安全语境", () => {
    const result = buildSecurityPrompt("base prompt");
    expect(result).toContain("base prompt");
    expect(result).toContain("网络安全");
  });

  it("包含合规提醒", () => {
    const result = buildSecurityPrompt("");
    expect(result).toContain("授权");
  });

  it("包含报告格式说明", () => {
    const result = buildSecurityPrompt("");
    expect(result).toContain("/report");
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
npm test --workspace=packages/omega-core
```

预期：`Error: Cannot find module '../src/prompts/security.ts'`

- [ ] **Step 3: 创建 src/prompts/security.ts**

```typescript
export function buildSecurityPrompt(basePrompt: string): string {
  const securityContext = `

## OMEGA 网络安全 Agent 语境

你是 OMEGA，一个专为网络安全工作设计的 AI Agent。你协助完成渗透测试、漏洞分析、安全审计等任务。

### 核心原则

1. **授权优先**：所有操作必须在合法授权范围内进行。在执行主动扫描、漏洞利用前，始终确认用户已获得目标授权。
2. **专业术语**：使用标准安全术语（CVE、CVSS、PoC、C2、pivot、lateral movement 等）。
3. **操作记录**：建议用户记录每个操作步骤，以便生成报告。

### 工作流程阶段

- **Recon（侦察）**：信息收集、端口扫描、服务识别、目录枚举
- **Exploit（利用）**：漏洞验证、权限提升、横向移动
- **Report（报告）**：使用 \`/report\` 命令将当前会话整理为渗透测试报告

### 报告格式

使用 \`/report\` 命令可将当前会话输出格式化为标准 Markdown 渗透测试报告，包含：执行摘要、发现漏洞列表、复现步骤、修复建议。
`;

  return `${basePrompt}${securityContext}`;
}
```

- [ ] **Step 4: 创建 src/prompts/index.ts**

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildSecurityPrompt } from "./security.ts";

export function registerPrompts(pi: ExtensionAPI): void {
  pi.on("before_agent_start", async (event) => {
    return {
      systemPrompt: buildSecurityPrompt(event.systemPrompt),
    };
  });
}
```

- [ ] **Step 5: 运行测试，确认通过**

```bash
npm test --workspace=packages/omega-core
```

预期：`3 tests passed`

- [ ] **Step 6: 提交**

```bash
git add packages/omega-core/src/prompts/ packages/omega-core/tests/security-prompt.test.ts
git commit -m "feat(omega): add network security system prompt"
```

---

## Task 6: /report 斜杠命令

**Files:**
- Create: `packages/omega-core/src/commands/report.ts`
- Create: `packages/omega-core/src/commands/index.ts`
- Create: `packages/omega-core/tests/report.test.ts`

**Interfaces:**
- Consumes: `ExtensionAPI`, `ExtensionCommandContext`, `SessionEntry` from `@earendil-works/pi-coding-agent`
- Produces: `export function registerCommands(pi: ExtensionAPI): void` from `commands/index.ts`
- Produces: `export function generateReport(entries: SessionEntry[], target: string): string` from `commands/report.ts`

- [ ] **Step 1: 写失败测试**

创建 `packages/omega-core/tests/report.test.ts`：

```typescript
import { describe, it, expect } from "vitest";
import { generateReport } from "../src/commands/report.ts";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

const fakeEntries: SessionEntry[] = [
  {
    id: "1",
    type: "message",
    message: { role: "user", content: "扫描目标 192.168.1.1" },
  } as SessionEntry,
  {
    id: "2",
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "发现开放端口 80, 443, 22" }],
    },
  } as SessionEntry,
];

describe("generateReport", () => {
  it("包含报告标题", () => {
    const report = generateReport(fakeEntries, "192.168.1.1");
    expect(report).toContain("# OMEGA 渗透测试报告");
  });

  it("包含目标信息", () => {
    const report = generateReport(fakeEntries, "192.168.1.1");
    expect(report).toContain("192.168.1.1");
  });

  it("包含 agent 发现的内容", () => {
    const report = generateReport(fakeEntries, "192.168.1.1");
    expect(report).toContain("发现开放端口");
  });

  it("空会话生成空发现区块", () => {
    const report = generateReport([], "target");
    expect(report).toContain("## 发现");
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
npm test --workspace=packages/omega-core
```

预期：`Error: Cannot find module '../src/commands/report.ts'`

- [ ] **Step 3: 创建 src/commands/report.ts**

```typescript
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c): c is { type: "text"; text: string } => c?.type === "text")
      .map((c) => c.text)
      .join("\n");
  }
  return "";
}

export function generateReport(entries: SessionEntry[], target: string): string {
  const now = new Date().toISOString().split("T")[0];

  const findings: string[] = [];
  const userInputs: string[] = [];

  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const msg = entry.message;
    if (msg.role === "user") {
      userInputs.push(`- ${extractText(msg.content)}`);
    } else if (msg.role === "assistant") {
      const text = extractText(msg.content).trim();
      if (text) findings.push(text);
    }
  }

  return `# OMEGA 渗透测试报告

**日期：** ${now}  
**目标：** ${target}  
**工具：** OMEGA Network Security Agent  

---

## 执行摘要

本报告由 OMEGA Agent 会话自动生成。

## 测试范围

目标：\`${target}\`

## 操作记录

${userInputs.length > 0 ? userInputs.join("\n") : "- 无记录"}

## 发现

${findings.length > 0 ? findings.map((f, i) => `### 发现 ${i + 1}\n\n${f}`).join("\n\n") : "_本次会话未记录明确发现。_"}

---

## 修复建议

_请根据以上发现补充修复建议。_

---

*由 OMEGA 自动生成 · ${now}*
`;
}
```

- [ ] **Step 4: 创建 src/commands/index.ts**

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { generateReport } from "./report.ts";
import { writeFileSync } from "fs";
import { join } from "path";

export function registerCommands(pi: ExtensionAPI): void {
  pi.registerCommand("report", {
    description: "将当前会话整理为 Markdown 渗透测试报告",
    handler: async (args, ctx) => {
      const target = args.trim() || "未指定目标";
      const entries = ctx.sessionManager.getBranch();
      const report = generateReport(entries, target);

      const filename = `omega-report-${Date.now()}.md`;
      const outputPath = join(process.cwd(), filename);

      writeFileSync(outputPath, report, "utf-8");

      ctx.ui.notify(`报告已生成：${filename}`, "success");
    },
  });
}
```

- [ ] **Step 5: 运行测试，确认通过**

```bash
npm test --workspace=packages/omega-core
```

预期：`4 tests passed`

- [ ] **Step 6: 提交**

```bash
git add packages/omega-core/src/commands/ packages/omega-core/tests/report.test.ts
git commit -m "feat(omega): add /report command for pentest report generation"
```

---

## Task 7: 危险操作权限门控

**Files:**
- Create: `packages/omega-core/src/permissions/gate.ts`
- Create: `packages/omega-core/src/permissions/index.ts`

**Interfaces:**
- Consumes: `ExtensionAPI` from `@earendil-works/pi-coding-agent`
- Produces: `export function registerPermissions(pi: ExtensionAPI): void` from `permissions/index.ts`
- Produces: `export function isDangerousCommand(cmd: string): boolean` from `permissions/gate.ts`

- [ ] **Step 1: 写失败测试**

在 `packages/omega-core/tests/report.test.ts` 末尾追加（或新建 `tests/gate.test.ts`）：

创建 `packages/omega-core/tests/gate.test.ts`：

```typescript
import { describe, it, expect } from "vitest";
import { isDangerousCommand } from "../src/permissions/gate.ts";

describe("isDangerousCommand", () => {
  it("识别 nmap 主动扫描", () => {
    expect(isDangerousCommand("nmap -sS 192.168.1.0/24")).toBe(true);
  });

  it("识别 sqlmap 注入", () => {
    expect(isDangerousCommand("sqlmap -u http://target/login")).toBe(true);
  });

  it("识别 metasploit", () => {
    expect(isDangerousCommand("msfconsole")).toBe(true);
  });

  it("普通命令不触发", () => {
    expect(isDangerousCommand("ls -la")).toBe(false);
    expect(isDangerousCommand("cat /etc/hosts")).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
npm test --workspace=packages/omega-core
```

预期：`Error: Cannot find module '../src/permissions/gate.ts'`

- [ ] **Step 3: 创建 src/permissions/gate.ts**

```typescript
const DANGEROUS_PATTERNS: RegExp[] = [
  /\bnmap\b.*-s[SATUV]/i,          // nmap 主动扫描
  /\bnmap\b/i,                      // 任意 nmap
  /\bsqlmap\b/i,                    // SQL 注入
  /\bmsf(console|venom)\b/i,        // Metasploit
  /\bhydra\b/i,                     // 暴力破解
  /\baircrack\b/i,                  // 无线破解
  /\bjohn(\s+the\s+ripper)?\b/i,    // 密码破解
  /\bhashcat\b/i,                   // 哈希破解
  /\bburpsuite\b/i,                 // Burp Suite
  /\bnikto\b/i,                     // Web 扫描
];

export function isDangerousCommand(cmd: string): boolean {
  return DANGEROUS_PATTERNS.some((pattern) => pattern.test(cmd));
}
```

- [ ] **Step 4: 创建 src/permissions/index.ts**

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isDangerousCommand } from "./gate.ts";

export function registerPermissions(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return undefined;

    const command = event.input.command as string;

    if (!isDangerousCommand(command)) return undefined;

    if (!ctx.hasUI) {
      return {
        block: true,
        reason: "高危安全操作在非交互模式下被阻止（需要用户确认）",
      };
    }

    const choice = await ctx.ui.select(
      `⚠️  OMEGA 安全门控\n\n检测到高危操作：\n\n  ${command}\n\n请确认已获得目标授权，是否继续？`,
      ["✅ 已授权，继续执行", "❌ 取消"],
    );

    if (choice !== "✅ 已授权，继续执行") {
      return { block: true, reason: "用户取消执行" };
    }

    return undefined;
  });
}
```

- [ ] **Step 5: 运行所有测试，确认通过**

```bash
npm test --workspace=packages/omega-core
```

预期：`7 tests passed`（security-prompt: 3 + report: 4 + gate: 4 = 11，视实际数量）

- [ ] **Step 6: 提交**

```bash
git add packages/omega-core/src/permissions/ packages/omega-core/tests/gate.test.ts
git commit -m "feat(omega): add dangerous operation permission gate"
```

---

## Task 8: 接入 .omega/extensions/ 并端到端验证

**Files:**
- Create: `.omega/extensions/omega.ts`

**Interfaces:**
- Consumes: `omegaExtension` from `@omega/core`
- Produces: OMEGA Agent 完整可运行实例

- [ ] **Step 1: 创建 .omega/extensions/omega.ts**

```typescript
import omegaExtension from "@omega/core";
export default omegaExtension;
```

- [ ] **Step 2: 构建所有包**

```bash
npm run build
```

预期：所有包构建成功，无错误。

- [ ] **Step 3: 端到端手动验证**

```bash
node packages/coding-agent/dist/cli.js
```

验证清单：
- [ ] TUI 启动后顶部显示 OMEGA ASCII art header
- [ ] 底部 status line 显示 `◎ ready`
- [ ] 输入 `/report 192.168.1.1` 后，工作目录生成 `omega-report-*.md` 文件
- [ ] 文件包含 `# OMEGA 渗透测试报告` 和目标 `192.168.1.1`
- [ ] 在提示词中询问 agent 自己是谁，回答中包含安全相关语境
- [ ] 输入 `nmap -sS 192.168.1.1`（bash 工具调用）时，弹出权限确认对话框

- [ ] **Step 4: 提交最终状态**

```bash
git add .omega/
git commit -m "feat(omega): wire omega-core extension via .omega/extensions"
```

---

## 自检结果

- **Spec 覆盖：** Git 策略(Task 1) ✓、PATCH-001(Task 2) ✓、omega-core 骨架(Task 3) ✓、品牌化(Task 4) ✓、系统提示词(Task 5) ✓、/report(Task 6) ✓、权限门控(Task 7) ✓、接入(Task 8) ✓
- **Placeholder 扫描：** 无 TBD/TODO
- **类型一致性：** `generateReport(entries: SessionEntry[], target: string): string` 在 Task 6 Step 3 定义，在 Step 4 消费，签名一致；`isDangerousCommand(cmd: string): boolean` 在 Task 7 Step 3 定义，在 Step 4 消费，签名一致
- **OMEGA-PATCHES.md 目标：** 仅 1 条 patch（PATCH-001），远低于 5 条上限
