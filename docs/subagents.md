# Omega Subagents

Omega 的 `subagent` 工具会在独立子进程中运行场景 Agent。每个 Agent 由一个 Markdown 文件定义：YAML frontmatter 描述运行策略，正文作为 system prompt。

## Agent 定义

项目 Agent 放在 `.omega/agents/**/*.md`，用户级 Agent 放在 `~/.omega/agents/**/*.md`。项目定义会覆盖同名用户定义和内置定义。

```markdown
---
name: api-security
description: 审查 API 鉴权、IDOR 和输入校验
tools: [read, grep, find, ls]
model: anthropic/claude-sonnet-4-6
thinking: high
systemPromptMode: replace
---

你是 API 安全审计子智能体。

聚焦认证、授权、IDOR/BOLA、批量赋值和输入校验。只报告有代码证据的问题，输出文件路径、调用链、影响和修复建议。不要修改文件。
```

字段：

- `name`、`description`：必填。
- `tools`：可选工具白名单；空数组表示不允许使用工具，省略表示继承子进程默认工具。
- `model`：可选 `provider/model`；省略时继承父会话模型。
- `thinking`：可选 `off|minimal|low|medium|high|xhigh|max`。
- `systemPromptMode`：`replace` 使用纯场景提示词，`append` 将场景提示词追加到 Omega 默认提示词；默认 `replace`。

## 调用方式

功能开关与状态：

```text
/subagent:settings
/subagent:status
```

设置保存在 Omega 用户目录的 `subagents.json` 中。修改开关后 Omega 会重新加载扩展；禁用时不会注册 `subagent` 工具、自动发现 Agent 或向 system prompt 注入 Agent 列表。显式执行状态或列表命令仍可读取 Agent 定义。

在交互式 TUI 中，只要存在运行中的 subagent，底部状态栏就会显示运行数量和 Agent 名称；任务结束、失败或取消后状态会自动清除。`subagent` 工具输出本身继续支持折叠和展开，workflow 中启动的 subagent 也会同步到相同状态区域。

列出 Agent：

```json
{ "action": "list" }
```

单 Agent：

```json
{ "agent": "api-security", "task": "审查 packages/server 的鉴权边界" }
```

并行 Agent：

```json
{
  "tasks": [
    { "agent": "scout", "task": "定位认证入口" },
    { "agent": "reviewer", "task": "审查当前 diff" }
  ]
}
```

链式 Agent 使用 `{previous}` 传递上一步最终输出：

```json
{
  "chain": [
    { "agent": "scout", "task": "定位相关实现" },
    { "agent": "reviewer", "task": "根据侦察结果审查：{previous}" }
  ]
}
```

内置场景为 `security-worker`、`websec-tester`、`sec-advisor`、`log-analyst` 和 `osint-analyst`。子 Agent 默认不加载父会话历史、项目上下文文件、Skills 或提示词模板；项目级 Agent 在未信任仓库中执行前需要交互确认。

需要用确定性 DSL 编排多个 Agent、宿主任务或“执行者—验证者”安全流程时，参见 [Omega Workflows](./workflows.md)。
