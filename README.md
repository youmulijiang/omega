# Omega

Omega 是基于 [Pi Coding Agent](https://pi.dev) 的可扩展智能体工作台，面向代码工程、授权安全测试和多智能体协作场景。它通过 Pi 的 Extension API 注入统一能力，不修改 Pi 内核。

> 安全测试功能仅用于合法授权的靶场、测试环境和明确授权的目标。

## 特性

- **多智能体协作**：在独立子进程中运行场景 Agent，支持串行、并行和链式任务。
- **Workflow 编排**：使用受限 JavaScript DSL 编排阶段、Agent、任务和独立验证流程。
- **安全测试工作流**：内置 `security-worker`、`websec-tester`、`sec-advisor`、`log-analyst` 和 `osint-analyst`。
- **项目知识与记忆**：支持知识目录、记忆检索，以及项目级上下文和规则。
- **权限与范围控制**：通过 `.omega/agent/permissions.json` 和 `scope.md` 描述工具权限、目标范围与排除项。
- **后台任务与委派**：支持后台运行、任务状态、日志、取消和子进程委派。
- **浏览器与 MCP**：提供 Chrome DevTools 工具和 MCP 工具接入能力。

## 快速开始

### 环境要求

- Node.js `>=22.19.0`
- npm
- Bun（仅打包独立可执行文件时需要）
- 一个已配置的 LLM Provider 凭据（如 `OPENAI_API_KEY`、`ANTHROPIC_API_KEY`）

```bash
npm install --ignore-scripts
npx omega init
```

开发环境启动：

```bash
# Unix
./pi-test.sh

# Windows PowerShell
./omega-test.ps1
```

构建后启动：

```bash
npm run build
node packages/omega-core/dist/cli.js
```

`omega init` 会创建 `.omega/agent` 和 `.omega/workflows`，并生成不会覆盖已有文件的 `AGENTS.md`、`settings.json`、`permissions.json` 与 `scope.md`。使用 `--no-env` 可在调试时清除已知 Provider 和云凭据环境变量：

```bash
./pi-test.sh --no-env
```

## 常用命令

```text
/init                         初始化当前项目的 .omega 配置
/subagent:settings            查看或修改 subagent 开关
/subagent:status              查看 subagent 状态
/workflows                    打开 Workflow 运行状态面板
/workflows list               列出可用 Workflow
/workflows run <prompt>       根据提示词生成并运行一次 Workflow
/workflows run-template <id>  运行已注册 Workflow
/workflows show <id>          查看 Workflow 元数据和源码
/workflows validate <id>      校验 Workflow，不执行
/workflows reload             重新发现 Workflow
/goal                         管理长任务目标
/bg、/tasks、/jobs            管理后台任务
/logs、/kill                  查看日志或取消任务
```

也可以通过 `subagent` 工具运行单个 Agent，或提交 `tasks` / `chain` 执行多个 Agent。详见 [docs/subagents.md](docs/subagents.md) 和 [docs/workflows.md](docs/workflows.md)。

## Agent 与 Workflow

项目级 Agent 放在 `.omega/agents/**/*.md`，用户级 Agent 放在 `~/.omega/agents/**/*.md`；项目定义覆盖同名用户定义和内置定义。Agent Markdown 使用 YAML frontmatter 声明名称、工具白名单、模型和思考级别，正文作为 system prompt。

Workflow 按内置模板、`~/.omega/workflows/**/*.js`、当前项目向上查找得到的最近 `.omega/workflows/**/*.js` 顺序加载，后加载的同名定义覆盖前者。脚本必须声明静态 `meta`，并运行在受限上下文中；文件系统、网络和命令能力应通过明确授权的 Agent 或窄化 task executor 提供。

## 项目结构

```text
packages/omega-core/   Omega 核心扩展、CLI、Agent、Workflow 和工具
packages/coding-agent/ Pi Coding Agent CLI 与 Extension API
packages/agent/        Agent runtime
packages/ai/           多 Provider LLM API
packages/tui/          终端 UI
docs/                  Omega 使用与设计文档
.omega/                项目本地运行数据与配置
```

核心扩展入口是 `packages/omega-core/src/entry.ts`，CLI 启动流程位于 `packages/omega-core/src/cli-runner.ts`。

## 开发

```bash
npm install --ignore-scripts
npm run check          # 格式、Lint、类型和生成文件检查
npm run build          # 构建全部 workspace
npm run build:offline  # 使用已有模型数据构建
./test.sh              # 运行非 e2e 测试
```

仅运行 Omega 测试：

```bash
node node_modules/vitest/dist/cli.js --run packages/omega-core/tests
```

## 打包独立可执行文件

Windows 上打包当前架构（默认 `windows-x64`）：

```powershell
.\scripts\build-windows.ps1
```

打包所有支持的平台，或只打包指定平台：

```powershell
.\scripts\build-all.ps1
.\scripts\build-all.ps1 -Platform windows-arm64
```

```bash
./scripts/build-all.sh
./scripts/build-all.sh --platform linux-x64
```

默认产物位于 `out/`：Windows 为 `omega-windows-<arch>.zip`，Linux 和 macOS 为
`omega-<platform>.tar.gz`。可用 `-OutDir <目录>`（PowerShell）或 `--out <目录>`
（Bash）修改输出目录；依赖和 workspace 已构建时，可组合使用
`-SkipInstall -SkipBuild` 或 `--skip-install --skip-build` 缩短重复打包时间。

Windows 的 `omega.exe` 使用 [`icon/omega.ico`](icon/omega.ico) 作为图标源。
如果该文件实际为 PNG 格式，打包脚本会临时转换为标准多尺寸 ICO；
临时文件不会作为额外文件留在压缩包中。
Linux 和 macOS 的无窗口命令行可执行文件没有嵌入式应用图标。

## 安全边界

Omega 默认继承启动它的用户和进程权限，不提供操作系统级隔离。Workflow DSL 的静态解析和 VM 限制用于缩小脚本能力面，但不能替代容器或沙箱。运行不可信项目时，请先确认项目来源，并根据需要使用容器化方案。

安全测试前必须配置明确的授权范围和排除项，并遵守目标系统的规则。安全问题报告流程见 [SECURITY.md](SECURITY.md)。

## 相关文档

- [Omega Subagents](docs/subagents.md)
- [Omega Workflows](docs/workflows.md)
- [Omega 架构图](docs/omega-architecture.puml)
- [贡献指南](CONTRIBUTING.md)
- [项目开发规则](AGENTS.md)
- [Pi Coding Agent 文档](https://pi.dev/docs/latest)

## 许可证

MIT
