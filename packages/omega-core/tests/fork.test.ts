import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../coding-agent/src/core/session-manager.ts";
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
	it("keeps the built-in /fork available, registers /fork:task, and exposes the fork tool", () => {
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

		expect(commands).toContainEqual({ name: "fork:task", overrideBuiltin: undefined });
		expect(commands).not.toContainEqual(expect.objectContaining({ name: "fork" }));
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

	it("creates a persistent session that can be discovered by /resume", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "omega-fork-session-test-"));
		temporaryDirectories.push(root);
		const sessionDirectory = path.join(root, "sessions");
		const session = SessionManager.create(root, sessionDirectory);
		session.appendMessage({ role: "user", content: "original task", timestamp: Date.now() });
		const leafId = session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "original response" }],
			api: "anthropic-messages",
			provider: "test",
			model: "test",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
		const sourceFile = session.getSessionFile();

		const forkedFile = session.createBranchedSession(leafId);

		expect(forkedFile).toBeDefined();
		expect(forkedFile).not.toBe(sourceFile);
		expect(fs.existsSync(forkedFile!)).toBe(true);
		const sessions = await SessionManager.list(root, sessionDirectory);
		expect(sessions.map((item) => item.path)).toEqual(expect.arrayContaining([sourceFile, forkedFile]));
		const forked = sessions.find((item) => item.path === forkedFile);
		expect(forked?.parentSessionPath).toBe(sourceFile);
	});
});
