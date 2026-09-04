import { main } from "@earendil-works/pi-coding-agent";
import omegaExtension from "./entry.ts";

/** Run the coding agent with OMEGA's core functionality statically registered. */
export async function runOmegaCli(args: string[]): Promise<void> {
	process.title = "omega";
	process.env.PI_CODING_AGENT = "true";
	process.env.AI_AGENT = "pi";
	process.emitWarning = (() => {}) as typeof process.emitWarning;

	await main(args, {
		extensionFactories: [{ name: "omega-core", factory: omegaExtension, hidden: true }],
	});
}
