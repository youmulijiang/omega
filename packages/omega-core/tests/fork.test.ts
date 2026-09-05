import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OmegaAPI } from "../src/api.ts";
import { loadConfig } from "../src/fork/config.ts";
import { registerFork } from "../src/fork/index.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

describe("Omega fork registration", () => {
	it("registers /fork as an internal built-in override and exposes the fork tool", () => {
		const commands: Array<{ name: string; overrideBuiltin?: boolean }> = [];
		const tools: string[] = [];
		const omega = {
			on: () => {},
			registerCommand: (name: string, options: { overrideBuiltin?: boolean }) => {
				commands.push({ name, overrideBuiltin: options.overrideBuiltin });
			},
			registerTool: (tool: { name: string }) => tools.push(tool.name),
		} as unknown as OmegaAPI;

		registerFork(omega);

		expect(commands).toContainEqual({ name: "fork", overrideBuiltin: true });
		expect(tools).toContain("fork");
	});

	it("loads project fork settings from .omega/agent/settings.json", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "omega-fork-test-"));
		temporaryDirectories.push(root);
		const settingsDirectory = path.join(root, ".omega", "agent");
		fs.mkdirSync(settingsDirectory, { recursive: true });
		fs.writeFileSync(
			path.join(settingsDirectory, "settings.json"),
			JSON.stringify({ fork: { offline: false, costFooter: false, defaultEffort: "deep" } }),
		);

		expect(loadConfig(root)).toMatchObject({
			offline: false,
			costFooter: false,
			defaultEffort: "deep",
		});
	});
});
