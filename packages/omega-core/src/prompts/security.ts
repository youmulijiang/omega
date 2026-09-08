import { appendPrompts } from "./loader.ts";

/** Compatibility helper; new consumers should use appendPrompt directly. */
export function buildSecurityPrompt(basePrompt: string): string {
	return appendPrompts(basePrompt, ["system", "web-testing"]);
}
