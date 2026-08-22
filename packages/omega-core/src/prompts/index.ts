import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildSecurityPrompt } from "./security.ts";

/**
 * 注册 OMEGA 的提示词增强：在 agent 启动前注入网络安全工作语境。
 *
 * @param pi - Pi 扩展 API。
 */
export function registerPrompts(pi: ExtensionAPI): void {
	pi.on("before_agent_start", async (event) => {
		return {
			systemPrompt: buildSecurityPrompt(event.systemPrompt),
		};
	});
}
