import type { OmegaAPI } from "../api.ts";
import registerAnthropicAttribution, { type PiExtensionHost } from "./core/anthropic-attribution.ts";
import backgroundTasksExtension from "./extension.ts";

/** Register the vendored background task, delegation, Fusion, and attribution integration. */
export function registerBackground(omega: OmegaAPI): void {
	// The vendored transport declares a deliberately small structural host whose
	// event overload is narrower than ExtensionAPI, although Omega supplies every
	// method it uses. Keep that compatibility cast at this adapter boundary.
	registerAnthropicAttribution(omega as unknown as PiExtensionHost);
	backgroundTasksExtension(omega);
}

export type { BgTask, BgTaskSnapshot, StartTaskOptions } from "./core/common.ts";
export * from "./core/extension-api.ts";
export { BackgroundTaskRegistry } from "./core/registry.ts";
