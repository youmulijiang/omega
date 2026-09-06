import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { OmegaAPI } from "../src/api.ts";
import { type AgentConfig, discoverAgents } from "../src/subagents/agents.ts";
import { registerSubagents } from "../src/subagents/index.ts";
import { buildModelArgs, buildPiArgs, mapConcurrent } from "../src/subagents/runner.ts";
import { readSubagentSettings, writeSubagentSettings } from "../src/subagents/settings.ts";

const temporaryDirectories: string[] = [];

function createTemporaryProject(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "omega-subagents-test-"));
	temporaryDirectories.push(root);
	return root;
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("Omega subagent discovery", () => {
	it("loads nested project agents and lets project definitions override builtins", () => {
		const root = createTemporaryProject();
		const agentsDir = path.join(root, ".omega", "agents", "security");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(
			path.join(agentsDir, "reviewer.md"),
			[
				"---",
				"name: reviewer",
				"description: Review authentication boundaries",
				"tools: [read, grep]",
				"model: anthropic/claude-sonnet",
				"thinking: high",
				"systemPromptMode: append",
				"---",
				"Focus on authentication and authorization failures.",
			].join("\n"),
		);

		const discovery = discoverAgents(path.join(root, "src"), "project");
		const reviewer = discovery.agents.find((agent) => agent.name === "reviewer");
		expect(reviewer).toMatchObject({
			source: "project",
			tools: ["read", "grep"],
			model: "anthropic/claude-sonnet",
			thinking: "high",
			systemPromptMode: "append",
		});
		expect(reviewer?.systemPrompt).toContain("authentication and authorization");
		expect(discovery.agents.map((agent) => agent.name)).toEqual(
			expect.arrayContaining(["log-analyst", "websec-tester", "osint-analyst", "sec-advisor"]),
		);
	});

	it("skips malformed definitions without hiding built-in agents", () => {
		const root = createTemporaryProject();
		const agentsDir = path.join(root, ".omega", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(path.join(agentsDir, "invalid.md"), "---\nname: invalid\n---\nPrompt");
		const discovery = discoverAgents(root, "project");
		expect(discovery.agents.some((agent) => agent.name === "invalid")).toBe(false);
		expect(discovery.agents.some((agent) => agent.name === "log-analyst")).toBe(true);
	});
});

describe("Omega subagent integration", () => {
	it("registers flags, lifecycle handlers, the tool, and the discovery command", () => {
		const root = createTemporaryProject();
		const flags: string[] = [];
		const events: string[] = [];
		const tools: string[] = [];
		const commands: string[] = [];
		const omega = {
			registerFlag: (name: string) => flags.push(name),
			getFlag: () => undefined,
			on: (name: string) => events.push(name),
			registerTool: (tool: { name: string }) => tools.push(tool.name),
			registerCommand: (name: string) => commands.push(name),
		} as unknown as OmegaAPI;
		registerSubagents(omega, { settingsPath: path.join(root, "subagents.json") });
		expect(flags).toEqual(["subagent-max-depth", "subagent-prevent-cycles", "no-subagent-prevent-cycles"]);
		expect(events).toEqual(
			expect.arrayContaining(["session_start", "session_shutdown", "before_agent_start", "tool_result"]),
		);
		expect(tools).toContain("subagent");
		expect(commands).toEqual(expect.arrayContaining(["subagent:list", "subagent:settings", "subagent:status"]));
	});

	it("does not register or advertise the tool when disabled", () => {
		const root = createTemporaryProject();
		const settingsPath = path.join(root, "subagents.json");
		writeSubagentSettings({ enabled: false }, settingsPath);
		const events: string[] = [];
		const tools: string[] = [];
		const commands: string[] = [];
		const omega = {
			registerFlag: () => undefined,
			getFlag: () => undefined,
			on: (name: string) => events.push(name),
			registerTool: (tool: { name: string }) => tools.push(tool.name),
			registerCommand: (name: string) => commands.push(name),
		} as unknown as OmegaAPI;

		registerSubagents(omega, { settingsPath });

		expect(readSubagentSettings(settingsPath)).toEqual({ enabled: false });
		expect(tools).not.toContain("subagent");
		expect(commands).toEqual(expect.arrayContaining(["subagent:settings", "subagent:status"]));
		expect(events).not.toContain("before_agent_start");
	});

	it("persists a settings selection and reloads extensions", async () => {
		const root = createTemporaryProject();
		const settingsPath = path.join(root, "subagents.json");
		const commands = new Map<
			string,
			(args: string, ctx: ExtensionCommandContext) => Promise<void>
		>();
		const omega = {
			registerFlag: () => undefined,
			getFlag: () => undefined,
			on: () => undefined,
			registerTool: () => undefined,
			registerCommand: (
				name: string,
				options: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> },
			) => commands.set(name, options.handler),
		} as unknown as OmegaAPI;
		registerSubagents(omega, { settingsPath });
		let reloads = 0;
		const ctx = {
			hasUI: true,
			ui: {
				select: async () => "禁用",
				notify: () => undefined,
			},
			reload: async () => {
				reloads++;
			},
		} as unknown as ExtensionCommandContext;

		await commands.get("subagent:settings")?.("", ctx);

		expect(readSubagentSettings(settingsPath)).toEqual({ enabled: false });
		expect(reloads).toBe(1);
	});

	it("builds isolated Omega arguments with prompt, model, thinking, and tool policy", () => {
		const agent: AgentConfig = {
			name: "advisor",
			description: "Advice only",
			noTools: true,
			model: "openai/gpt-5",
			thinking: "high",
			systemPromptMode: "replace",
			systemPrompt: "Give advice only.",
			source: "project",
			filePath: "/project/.omega/agents/advisor.md",
		};
		const args = buildPiArgs(agent, "/tmp/advisor.md", "Review the plan", "empty", null, undefined, undefined);
		expect(args).toEqual(
			expect.arrayContaining([
				"--no-session",
				"--no-tools",
				"--model",
				"openai/gpt-5",
				"--thinking",
				"high",
				"--system-prompt",
				"/tmp/advisor.md",
			]),
		);
	});

	it("uses call model before agent and parent model", () => {
		expect(buildModelArgs("openai/call", "openai/agent", { provider: "openai", id: "parent" }, undefined, undefined)).toEqual([
			"--model",
			"openai/call",
		]);
		expect(buildModelArgs(undefined, undefined, { provider: "openai", id: "parent" }, undefined, undefined)).toEqual([
			"--model",
			"openai/parent",
		]);
	});

	it("preserves result order while enforcing bounded concurrency", async () => {
		let active = 0;
		let peak = 0;
		const results = await mapConcurrent([30, 5, 10, 1], 2, async (delay, index) => {
			active++;
			peak = Math.max(peak, active);
			await new Promise((resolve) => setTimeout(resolve, delay));
			active--;
			return index;
		});
		expect(results).toEqual([0, 1, 2, 3]);
		expect(peak).toBe(2);
	});
});
