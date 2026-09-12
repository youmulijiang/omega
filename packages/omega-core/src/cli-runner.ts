import { type Extension, main } from "@earendil-works/pi-coding-agent";
import omegaExtension from "./entry.ts";
import { formatInitResult, initializeOmegaWorkspace } from "./init/index.ts";
import { initializeKnowledgeDirectory } from "./knowledge/index.ts";
import { OMEGA_VERSION } from "./version.ts";
import { initializeUserWorkflowsDirectory } from "./workflows/registry.ts";

const EXTERNAL_TOOLBOX_PATH = /(?:^|\/)node_modules\/@andy8647\/pi-toolbox(?:\/|$)/i;
const EXTERNAL_DYNAMIC_WORKFLOWS_PATH = /(?:^|\/)node_modules\/@quintinshaw\/pi-dynamic-workflows(?:\/|$)/i;

/** These external extension capabilities are built into Omega and must not be loaded twice. */
export function isOmegaCompatibleExtension(extension: Pick<Extension, "path" | "resolvedPath">): boolean {
	const path = (extension.resolvedPath || extension.path).replaceAll("\\", "/");
	return !EXTERNAL_TOOLBOX_PATH.test(path) && !EXTERNAL_DYNAMIC_WORKFLOWS_PATH.test(path);
}

/** Run the coding agent with OMEGA's core functionality statically registered. */
export async function runOmegaCli(args: string[]): Promise<void> {
	process.title = "omega";
	initializeUserWorkflowsDirectory();
	await initializeKnowledgeDirectory();
	if (args[0] === "init") {
		if (args.length > 1) throw new Error("Usage: omega init");
		console.log(formatInitResult(await initializeOmegaWorkspace(process.cwd())));
		return;
	}

	process.env.PI_CODING_AGENT = "true";
	process.env.OMEGA_VERSION = OMEGA_VERSION;
	process.env.AI_AGENT = "pi";
	process.emitWarning = (() => {}) as typeof process.emitWarning;

	await main(args, {
		extensionFactories: [{ name: "omega-core", factory: omegaExtension, hidden: true }],
		extensionFilter: isOmegaCompatibleExtension,
	});
}
