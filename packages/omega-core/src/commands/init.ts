import { mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

const INITIAL_FILES = {
	"AGENTS.md": [
		"# Omega Agent Instructions",
		"",
		"Describe project-specific goals, constraints, conventions, and authorization boundaries here.",
		"",
	].join("\n"),
	"settings.json": `${JSON.stringify({ collapseChangelog: true }, null, 2)}\n`,
	"scope.md": [
		"# scope.md",
		"",
		"metadata",
		"",
		"## Inclusion",
		"",
		"- 10.0.0.0/24",
		"",
		"### url",
		"",
		"- https://example.com",
		"",
		"## Exclusions",
		"",
		"### domain",
		"",
		"- admin.example.com",
		"",
	].join("\n"),
} as const;

export interface InitWorkspaceResult {
	root: string;
	created: string[];
	existing: string[];
}

/** Create the project-local Omega layout without overwriting existing files. */
export async function initializeOmegaWorkspace(cwd: string): Promise<InitWorkspaceResult> {
	const root = join(cwd, ".omega");
	const agentDirectory = join(root, "agent");
	await mkdir(agentDirectory, { recursive: true });

	const created: string[] = [];
	const existing: string[] = [];
	for (const [name, content] of Object.entries(INITIAL_FILES)) {
		const filePath = join(agentDirectory, name);
		try {
			await writeFile(filePath, content, { encoding: "utf8", flag: "wx" });
			created.push(relative(cwd, filePath));
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "EEXIST") {
				existing.push(relative(cwd, filePath));
				continue;
			}
			throw error;
		}
	}

	return { root, created, existing };
}
