import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createOmegaAPI } from "./api.ts";
import { registerBackground } from "./background/index.ts";
import { registerBrowserExtension } from "./browser-extension/index.ts";
import { registerBtw } from "./btw/index.ts";
import { registerChrome } from "./chrome/index.ts";
import { registerCommands } from "./commands/index.ts";
import { registerCosts } from "./costs/index.ts";
import { registerFork } from "./fork/index.ts";
import { registerGoal } from "./goal/index.ts";
import { registerInit } from "./init/index.ts";
import { registerMcp } from "./mcp/index.ts";
import { registerSmithery } from "./mcp-smithery/index.ts";
import registerMemory from "./memory/index.ts";
import { registerPermissions } from "./permissions/index.ts";
import { registerPrompts } from "./prompts/index.ts";
import { registerStudy } from "./study/index.ts";
import { registerSubagents } from "./subagents/index.ts";
import { registerTodo } from "./todo/index.ts";
import { registerTools } from "./tools/index.ts";
import { registerUi } from "./ui/index.ts";
import { registerWorkflows } from "./workflows/index.ts";

/**
 * OMEGA 核心扩展入口。
 *
 * pi 是 Pi Coding Agent 注入的微内核 API（ExtensionAPI），此处将其升级为
 * OmegaAPI（超集）后统一传给所有子模块。pi 本身零修改、零侵入。
 */
export default function omegaExtension(pi: ExtensionAPI): void {
	const omega = createOmegaAPI(pi);
	registerChrome(omega);
	registerBrowserExtension(omega);
	registerBackground(omega);
	registerBtw(omega);
	registerTodo(omega);
	registerCommands(omega);
	registerCosts(omega);
	registerFork(omega);
	registerGoal(omega);
	registerInit(omega);
	// 上游内置 MCP（builtin:mcp，见 packages/coding-agent/src/extensions/mcp/）已接管 MCP 能力：
	// /mcp 命令与 `pi mcp add|remove|login` CLI 均由上游提供。Omega 自带的 MCP 客户端
	// （src/mcp）保留源码但默认不再注册；仅在显式设置 OMEGA_LEGACY_MCP=1（或 "true"）
	// 时作为遗留开关重新启用，用于对照排查。
	const legacyMcp = ["1", "true"].includes(process.env.OMEGA_LEGACY_MCP?.trim().toLowerCase() ?? "");
	if (legacyMcp) registerMcp(omega);
	// Smithery 搜索补回：上游内置 MCP 接管连接管理后，保留 Smithery 注册表的
	// “搜索 + 添加”能力（复用 src/mcp 的 smithery 客户端，经 pi.registerMcpServer 注册）。
	registerSmithery(omega);
	registerMemory(omega);
	registerPermissions(omega);
	registerPrompts(omega);
	registerSubagents(omega);
	registerStudy(omega);
	registerTools(omega);
	registerUi(omega);
	registerWorkflows(omega);
}
