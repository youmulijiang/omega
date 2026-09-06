import { main } from "@earendil-works/pi-coding-agent";
import omegaExtension from "./entry.ts";
import { formatInitResult, initializeOmegaWorkspace } from "./init/index.ts";

/** Run the coding agent with OMEGA's core functionality statically registered. */
export async function runOmegaCli(args: string[]): Promise<void> {
	process.title = "omega";
	if (args[0] === "init") {
		if (args.length > 1) throw new Error("Usage: omega init");
		console.log(formatInitResult(await initializeOmegaWorkspace(process.cwd())));
		return;
	}

	process.env.PI_CODING_AGENT = "true";
	process.env.AI_AGENT = "pi";
	process.emitWarning = (() => {}) as typeof process.emitWarning;

	await main(args, {
		extensionFactories: [{ name: "omega-core", factory: omegaExtension, hidden: true }],
	});
}
