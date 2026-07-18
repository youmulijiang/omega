import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildSecurityPrompt } from "./security.ts";

export function registerPrompts(pi: ExtensionAPI): void {
	pi.on("before_agent_start", async (event) => {
		return {
			systemPrompt: buildSecurityPrompt(event.systemPrompt),
		};
	});
}
