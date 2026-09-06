import { mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { OmegaAPI } from "../api.ts";
import { registerOmegaCommand } from "../commands/register.ts";

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

export function formatInitResult(result: InitWorkspaceResult): string {
	const lines = [`Omega 工作目录已初始化：${result.root}`];
	if (result.created.length > 0) lines.push(`已创建：\n${result.created.map((path) => `- ${path}`).join("\n")}`);
	if (result.existing.length > 0) {
		lines.push(`已存在，未覆盖：\n${result.existing.map((path) => `- ${path}`).join("\n")}`);
	}
	return lines.join("\n\n");
}

/** Register the interactive `/init` command. */
export function registerInit(omega: OmegaAPI): void {
	registerOmegaCommand(omega, "init", {
		description: "初始化当前工作目录的 .omega/agent 配置",
		handler: async (_args, ctx) => {
			try {
				ctx.ui.notify(formatInitResult(await initializeOmegaWorkspace(ctx.cwd)), "info");
			} catch (error) {
				ctx.ui.notify(`初始化失败：${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}
