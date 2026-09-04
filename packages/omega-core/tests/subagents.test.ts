import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OmegaAPI } from "../src/api.ts";
import { type AgentConfig, discoverAgents } from "../src/subagents/agents.ts";
import { registerSubagents } from "../src/subagents/index.ts";
import { buildChildArgs } from "../src/subagents/runner.ts";

const temporaryDirectories: string[] = [];

function createTemporaryProject(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "omega-subagents-test-"));
	temporaryDirectories.push(root);
	return root;
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

describe("Omega subagent discovery", () => {
	it("loads nested project scenario prompts and overrides builtins by name", () => {
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
			expect.arrayContaining(["scout", "reviewer", "worker", "oracle"]),
		);
	});

	it("reports an invalid scenario without hiding valid agents", () => {
		const root = createTemporaryProject();
		const agentsDir = path.join(root, ".omega", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(path.join(agentsDir, "invalid.md"), "---\nname: invalid\n---\nPrompt");

		const discovery = discoverAgents(root, "project");

		expect(discovery.diagnostics).toHaveLength(1);
		expect(discovery.diagnostics[0].message).toContain("description");
		expect(discovery.agents.some((agent) => agent.name === "scout")).toBe(true);
	});
});

describe("Omega subagent launch arguments", () => {
	it("registers the subagent tool and discovery command", () => {
		const tools: string[] = [];
		const commands: string[] = [];
		const omega = {
			registerTool: (tool: { name: string }) => tools.push(tool.name),
			registerCommand: (name: string) => commands.push(name),
		} as unknown as OmegaAPI;

		registerSubagents(omega);

		expect(tools).toContain("subagent");
		expect(commands).toContain("subagents");
	});

	it("applies the selected scenario prompt, model, thinking, and explicit no-tool policy", () => {
		const agent: AgentConfig = {
			name: "advisor",
			description: "Advice only",
			tools: [],
			model: "openai/gpt-5",
			thinking: "high",
			systemPromptMode: "replace",
			systemPrompt: "Give advice only.",
			source: "project",
			filePath: "/project/.omega/agents/advisor.md",
		};

		const args = buildChildArgs(
			agent,
			"Review the plan",
			{ model: "anthropic/default", thinkingLevel: "low" },
			"/tmp/advisor.md",
		);

		expect(args).toEqual(
			expect.arrayContaining([
				"--no-session",
				"--no-context-files",
				"--no-tools",
				"--model",
				"openai/gpt-5",
				"--thinking",
				"high",
				"--system-prompt",
				"/tmp/advisor.md",
				"Task: Review the plan",
			]),
		);
	});
});
