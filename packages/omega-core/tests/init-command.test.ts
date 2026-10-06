import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initializeOmegaWorkspace, registerInit } from "../src/init/index.ts";

type CommandHandler = Parameters<ExtensionAPI["registerCommand"]>[1]["handler"];

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryWorkspace(): string {
	const workspace = mkdtempSync(join(tmpdir(), "omega-init-"));
	temporaryDirectories.push(workspace);
	return workspace;
}

describe("Omega init command", () => {
	it("creates the .omega/agent workspace layout", async () => {
		const workspace = temporaryWorkspace();

		const result = await initializeOmegaWorkspace(workspace);

		expect(result.directories).toEqual([join(".omega", "agent"), join(".omega", "workflows")]);
		expect(result.created).toEqual([
			join(".omega", "agent", "AGENTS.md"),
			join(".omega", "agent", "settings.json"),
			join(".omega", "agent", "permissions.json"),
			join(".omega", "agent", "scope.md"),
		]);
		expect(readFileSync(join(workspace, ".omega", "agent", "AGENTS.md"), "utf8")).toContain(
			"Omega Agent Instructions",
		);
		expect(existsSync(join(workspace, ".omega", "workflows"))).toBe(true);
		expect(JSON.parse(readFileSync(join(workspace, ".omega", "agent", "settings.json"), "utf8"))).toEqual({
			collapseChangelog: true,
		});
		expect(JSON.parse(readFileSync(join(workspace, ".omega", "agent", "permissions.json"), "utf8"))).toMatchObject({
			level: "full access",
			defaultPolicy: { bash: "allow", mcp: "allow", tools: "allow" },
			bash: { "rm *": "ask", "mkfs*": "deny" },
		});
		const scope = readFileSync(join(workspace, ".omega", "agent", "scope.md"), "utf8");
		expect(scope).toContain("## Inclusion");
		expect(scope).toContain("### url");
		expect(scope).toContain("### domain");
	});

	it("does not overwrite existing files", async () => {
		const workspace = temporaryWorkspace();
		await initializeOmegaWorkspace(workspace);
		const agentsPath = join(workspace, ".omega", "agent", "AGENTS.md");
		writeFileSync(agentsPath, "custom instructions", "utf8");

		const result = await initializeOmegaWorkspace(workspace);

		expect(result.created).toEqual([]);
		expect(result.existing).toHaveLength(4);
		expect(readFileSync(agentsPath, "utf8")).toBe("custom instructions");
	});

	it("registers /init and initializes ctx.cwd", async () => {
		const workspace = temporaryWorkspace();
		const commands = new Map<string, CommandHandler>();
		const notify = vi.fn();
		const pi = {
			registerCommand: (name: string, command: { handler: CommandHandler }) => commands.set(name, command.handler),
			registerFlag: vi.fn(),
			registerShortcut: vi.fn(),
			on: vi.fn(),
		} as unknown as ExtensionAPI;
		registerInit(pi);

		await commands.get("init")?.("", { cwd: workspace, ui: { notify } } as Parameters<CommandHandler>[1]);

		expect(readFileSync(join(workspace, ".omega", "agent", "scope.md"), "utf8")).toContain("# scope.md");
		expect(existsSync(join(workspace, ".omega", "workflows"))).toBe(true);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Omega workspace initialized"), "info");
	});
});
