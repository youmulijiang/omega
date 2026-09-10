import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parseWorkflowScript } from "./parser.ts";
import { INSPECT_PROJECT_WORKFLOW, VERIFIED_SECURITY_TEST_WORKFLOW, WORKBENCH_WEB_HUNT_WORKFLOW } from "./templates.ts";

export interface WorkflowDefinition {
	name: string;
	description: string;
	script: string;
	source: "builtin" | "user" | "project";
	filePath?: string;
}

export interface WorkflowRegistry {
	definitions: ReadonlyMap<string, WorkflowDefinition>;
	userWorkflowsDir: string;
	projectWorkflowsDir: string | null;
}

export function getUserWorkflowsDirectory(agentDirectory = getAgentDir()): string {
	const resolvedAgentDirectory = path.resolve(agentDirectory);
	return path.basename(resolvedAgentDirectory) === "agent"
		? path.join(path.dirname(resolvedAgentDirectory), "workflows")
		: path.join(resolvedAgentDirectory, "workflows");
}

export function initializeUserWorkflowsDirectory(directory = getUserWorkflowsDirectory()): string {
	fs.mkdirSync(directory, { recursive: true });
	return directory;
}

function isDirectory(filePath: string): boolean {
	try {
		return fs.statSync(filePath).isDirectory();
	} catch {
		return false;
	}
}

function findProjectWorkflowsDir(cwd: string): string | null {
	let directory = path.resolve(cwd);
	while (true) {
		const candidate = path.join(directory, ".omega", "workflows");
		if (isDirectory(candidate)) return candidate;
		const parent = path.dirname(directory);
		if (parent === directory) return null;
		directory = parent;
	}
}

function readDirectory(directory: string, source: WorkflowDefinition["source"]): WorkflowDefinition[] {
	if (!isDirectory(directory)) return [];
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(directory, { withFileTypes: true });
	} catch {
		return [];
	}
	entries.sort((left, right) => left.name.localeCompare(right.name));
	const definitions: WorkflowDefinition[] = [];
	for (const entry of entries) {
		const entryPath = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			definitions.push(...readDirectory(entryPath, source));
			continue;
		}
		if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
		try {
			const script = fs.readFileSync(entryPath, "utf-8");
			const { meta } = parseWorkflowScript(script);
			definitions.push({
				name: meta.name,
				description: meta.description,
				script,
				source,
				filePath: entryPath,
			});
		} catch (error) {
			console.warn(`[omega-workflow] Skipping invalid workflow "${entryPath}": ${String(error)}`);
		}
	}
	return definitions;
}

function builtinDefinitions(): WorkflowDefinition[] {
	return [INSPECT_PROJECT_WORKFLOW, VERIFIED_SECURITY_TEST_WORKFLOW, WORKBENCH_WEB_HUNT_WORKFLOW].map((script) => {
		const { meta } = parseWorkflowScript(script);
		return { name: meta.name, description: meta.description, script, source: "builtin" };
	});
}

export function discoverWorkflows(
	cwd: string,
	includeProjectWorkflows: boolean,
	userDirectory = getUserWorkflowsDirectory(),
): WorkflowRegistry {
	const projectWorkflowsDir = includeProjectWorkflows ? findProjectWorkflowsDir(cwd) : null;
	const definitions = new Map<string, WorkflowDefinition>();
	for (const definition of builtinDefinitions()) definitions.set(definition.name, definition);
	for (const definition of readDirectory(userDirectory, "user")) definitions.set(definition.name, definition);
	if (projectWorkflowsDir) {
		for (const definition of readDirectory(projectWorkflowsDir, "project")) {
			definitions.set(definition.name, definition);
		}
	}
	return { definitions, userWorkflowsDir: userDirectory, projectWorkflowsDir };
}
