import type { OmegaAPI } from "../api.ts";
import { buildSecurityPrompt } from "./security.ts";

export function registerPrompts(omega: OmegaAPI): void {
	omega.on("before_agent_start", async (event) => {
		return {
			systemPrompt: buildSecurityPrompt(event.systemPrompt),
		};
	});
}
