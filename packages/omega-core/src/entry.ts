import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBranding } from "./branding/index.ts";
import { registerBtw } from "./btw/index.ts";
import { registerCommands } from "./commands/index.ts";
import { registerMcp } from "./mcp/index.ts";
import registerMemory from "./memory/index.ts";
import { registerPermissions } from "./permissions/index.ts";
import { registerPrompts } from "./prompts/index.ts";
import { registerUi } from "./ui/index.ts";

/**
 * OMEGA 核心扩展入口。
 *
 * 在 Pi Coding Agent 启动时注册 OMEGA 的品牌、命令、MCP、权限门控、系统提示词与自定义 UI。
 */
export default function omegaExtension(pi: ExtensionAPI): void {
	registerBranding(pi);
	registerBtw(pi);
	registerCommands(pi);
	registerMcp(pi);
	registerMemory(pi);
	registerPermissions(pi);
	registerPrompts(pi);
	registerUi(pi);
}
