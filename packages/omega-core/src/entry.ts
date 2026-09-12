import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createOmegaAPI } from "./api.ts";
import { registerBackground } from "./background/index.ts";
import { registerBtw } from "./btw/index.ts";
import { registerChrome } from "./chrome/index.ts";
import { registerCommands } from "./commands/index.ts";
import { registerCosts } from "./costs/index.ts";
import { registerFork } from "./fork/index.ts";
import { registerGoal } from "./goal/index.ts";
import { registerInit } from "./init/index.ts";
import { registerMcp } from "./mcp/index.ts";
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
	registerBackground(omega);
	registerBtw(omega);
	registerTodo(omega);
	registerCommands(omega);
	registerCosts(omega);
	registerFork(omega);
	registerGoal(omega);
	registerInit(omega);
	registerMcp(omega);
	registerMemory(omega);
	registerPermissions(omega);
	registerPrompts(omega);
	registerSubagents(omega);
	registerStudy(omega);
	registerTools(omega);
	registerUi(omega);
	registerWorkflows(omega);
}
