import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type CommandOptions = Parameters<ExtensionAPI["registerCommand"]>[1];

/** Register an Omega-owned command without an autocomplete source tag. */
export function registerOmegaCommand(pi: ExtensionAPI, name: string, options: CommandOptions): void {
	const omegaOptions = { ...options, showSourceTag: false };
	pi.registerCommand(name, omegaOptions);
}
