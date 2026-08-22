import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBranding } from "./branding/index.ts";
import { registerCommands } from "./commands/index.ts";
import { registerPermissions } from "./permissions/index.ts";
import { registerPrompts } from "./prompts/index.ts";

/**
 * OMEGA 核心扩展入口。
 *
 * 在 Pi Coding Agent 启动时注册 OMEGA 的 branding、命令、权限门控与系统提示词增强。
 */
export default function omegaExtension(pi: ExtensionAPI): void {
	registerBranding(pi);
	registerCommands(pi);
	registerPermissions(pi);
	registerPrompts(pi);
}
