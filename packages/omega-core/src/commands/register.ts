import type { OmegaAPI } from "../api.ts";

type CommandOptions = Parameters<OmegaAPI["registerCommand"]>[1];

/** Register an Omega-owned command without an autocomplete source tag. */
export function registerOmegaCommand(omega: OmegaAPI, name: string, options: CommandOptions): void {
	const omegaOptions = { ...options, showSourceTag: false };
	omega.registerCommand(name, omegaOptions);
}
