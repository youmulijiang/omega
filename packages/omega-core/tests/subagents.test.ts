import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { OmegaAPI } from "../src/api.ts";
import { type AgentConfig, discoverAgents } from "../src/subagents/agents.ts";
import { formatAvailableSubagentsPrompt, formatSubagentToolDescription } from "../src/subagents/contract.ts";
import { registerSubagents } from "../src/subagents/index.ts";
import {
	SubagentAgentsWidget,
	SubagentConversationView,
	SubagentFleetEditor,
	SubagentFleetWidget,
} from "../src/subagents/runtime-view.ts";
import {
	buildModelArgs,
	buildPiArgs,
	DEFAULT_SUBAGENT_RUN_TIMEOUT_MS,
	mapConcurrent,
	processSubagentJsonLine,
	resolvePiSpawn,
	resolveRunTimeoutMs,
} from "../src/subagents/runner.ts";
import { readSubagentSettings, writeSubagentSettings } from "../src/subagents/settings.ts";
import { emptyUsage, isResultSuccess, type SingleResult } from "../src/subagents/types.ts";

const temporaryDirectories: string[] = [];

beforeAll(() => initTheme("dark", false));

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
			expect.arrayContaining(["explore", "security-worker", "workflow-author"]),
		);
	});

	it("skips malformed definitions without hiding built-in agents", () => {
		const root = createTemporaryProject();
		const agentsDir = path.join(root, ".omega", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(path.join(agentsDir, "invalid.md"), "---\nname: invalid\n---\nPrompt");
		const discovery = discoverAgents(root, "project");
		expect(discovery.agents.some((agent) => agent.name === "invalid")).toBe(false);
		expect(discovery.agents.some((agent) => agent.name === "security-worker")).toBe(true);
	});

	it("includes a built-in explorer that can author project agents", () => {
		const root = createTemporaryProject();
		const explorer = discoverAgents(root, "project").agents.find((agent) => agent.name === "explore");
		expect(explorer).toMatchObject({
			source: "builtin",
			tools: ["read", "grep", "find", "ls", "bash", "write", "edit"],
			thinking: "high",
		});
		expect(explorer?.systemPrompt).toContain(".omega/agents/");
		expect(explorer?.systemPrompt).toContain("never rewrite the existing file");
	});
});

describe("Omega subagent routing contract", () => {
	it("teaches context-aware specialist selection and the explorer fallback sequence", () => {
		const agents = discoverAgents(createTemporaryProject(), "project").agents;
		const prompt = formatAvailableSubagentsPrompt(agents, {
			currentDepth: 0,
			maxDepth: 3,
			preventCycles: true,
			ancestorAgentStack: [],
		});
		const toolDescription = formatSubagentToolDescription();

		expect(prompt).toContain("Read the current conversation context and the call prompt together");
		expect(prompt).toContain("call `explore` first");
		expect(prompt).toContain("new `subagent` tool call");
		expect(toolDescription).toContain("most specific matching existing agent");
		expect(toolDescription).toContain("subsequent tool call");
	});
});

describe("Omega subagent integration", () => {
	it("renders live agent and fleet widgets around the editor", () => {
		const result: SingleResult = {
			callIndex: 0,
			agent: "security-worker",
			agentSource: "builtin",
			prompt: "Inspect authentication routes",
			initialContext: "empty",
			exitCode: -1,
			messages: [],
			stderr: "",
			usage: { ...emptyUsage(), output: 141 },
		};
		const tui = { requestRender: () => undefined, terminal: { rows: 24 } } as never;
		const theme = {
			fg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		} as never;
		const agents = new SubagentAgentsWidget(tui, theme);
		const fleet = new SubagentFleetWidget(tui, theme);
		agents.setResults([result]);
		fleet.setResults([result]);
		expect(agents.render(100).join("\n")).toContain("○ Agents");
		expect(agents.render(100).join("\n")).toContain("Inspect authentication routes");
		const fleetText = fleet.render(100).join("\n");
		expect(fleetText).toContain("● main");
		expect(fleetText).toContain("↓ 141 tokens");
		const second = {
			...result,
			callIndex: 1,
			prompt: "Verify the finding",
			messages: [
				{
					role: "assistant" as const,
					content: [
						{ type: "thinking" as const, thinking: "private reasoning trace", thinkingSignature: "" },
						{ type: "text" as const, text: "verified final result" },
					],
					api: "anthropic-messages" as const,
					provider: "test",
					model: "test",
					usage: emptyUsage(),
					stopReason: "stop" as const,
					timestamp: Date.now(),
				},
			],
			usage: emptyUsage(),
		};
		let treeSelection = -1;
		const viewer = new SubagentConversationView(
			() => [result, second],
			tui,
			theme,
			{
				matches: (data: string, action: string) =>
					(data === "down" && action === "tui.select.down") ||
					(data === "tab" && action === "tui.input.tab") ||
					(data === "ctrl+t" && action === "app.thinking.toggle"),
				getKeys: (action: string) => [action],
			} as never,
			() => undefined,
			0,
			(index) => {
				treeSelection = index;
				agents.setSelection(index);
			},
		);
		expect(treeSelection).toBe(0);
		expect(viewer.render(100).join("\n")).toContain("Inspect authentication routes");
		expect(viewer.render(100).at(-1)).toContain("╰");
		expect(
			viewer.handleMouse({
				type: "wheel",
				button: "none",
				x: 1,
				y: 4,
				screenX: 1,
				screenY: 4,
				width: 100,
				height: 30,
				shift: false,
				alt: false,
				ctrl: false,
				wheelDelta: 3,
			}),
		).toEqual({ handled: true });
		expect(viewer.render(100).join("\n")).toContain("Inspect authentication routes");
		viewer.handleInput("tab");
		expect(treeSelection).toBe(1);
		expect(viewer.render(100).join("\n")).toContain("Verify the finding");
		expect(viewer.render(100).join("\n")).toContain("verified final result");
		expect(viewer.render(100).join("\n")).not.toContain("private reasoning trace");
		viewer.handleInput("ctrl+t");
		expect(viewer.render(100).join("\n")).toContain("private reasoning trace");
		expect(viewer.render(100).join("\n")).toContain("verified final result");
		viewer.handleInput("tab");
		expect(viewer.render(100).join("\n")).toContain("Inspect authentication routes");
		let opened = -1;
		let fleetActive = false;
		const focusTransitions: Array<number | undefined> = [];
		const fleetEditor = new SubagentFleetEditor(
			tui,
			{} as never,
			{
				matches: (data: string, action: string) =>
					(data === "down" && action === "tui.select.down") ||
					(data === "enter" && action === "tui.input.submit") ||
					(data === "tab" && action === "tui.input.tab"),
			} as never,
			() => [result, second],
			() => (fleetActive ? fleet : undefined),
			() => {
				fleetActive = true;
				return fleet;
			},
			() => {
				fleetActive = false;
			},
			(index) => {
				opened = index;
			},
			(selected) => focusTransitions.push(selected),
		);
		expect(fleetActive).toBe(false);
		fleetEditor.handleInput("down");
		expect(fleetActive).toBe(true);
		expect(fleet.render(100).join("\n")).toContain("● security-worker");
		fleetEditor.handleInput("enter");
		expect(opened).toBe(0);
		opened = -1;
		fleetEditor.handleInput("tab");
		expect(opened).toBe(0);
		fleetEditor.focusMain();
		expect(focusTransitions).toEqual([0, undefined]);
		expect(fleetActive).toBe(false);
		agents.dispose();
		fleet.dispose();
		viewer.dispose();
	});

	it("submits a follow-up prompt from the runtime conversation editor", () => {
		const result: SingleResult = {
			taskId: "subagent-7",
			callIndex: 0,
			agent: "reviewer",
			agentSource: "builtin",
			prompt: "Initial review",
			initialContext: "empty",
			exitCode: -1,
			messages: [],
			stderr: "",
			usage: emptyUsage(),
		};
		const tui = { requestRender: () => undefined, terminal: { rows: 24 } } as never;
		const theme = {
			fg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		} as never;
		const keybindings = {
			matches: (data: string, action: string) =>
				(data === "enter" && action === "tui.input.submit") ||
				(data === "escape" && action === "tui.select.cancel"),
			getKeys: (action: string) => [action],
		} as never;
		const submitted: Array<{ taskId: string; prompt: string }> = [];
		const viewer = new SubagentConversationView(
			() => [result],
			tui,
			theme,
			keybindings,
			() => undefined,
			0,
			undefined,
			(taskId, prompt) => submitted.push({ taskId, prompt }),
		);
		for (const character of "继续检查授权边界") viewer.handleInput(character);
		expect(viewer.render(240).join("\n")).toContain("return main & summarize");
		viewer.handleInput("\r");
		expect(submitted).toEqual([{ taskId: "subagent-7", prompt: "继续检查授权边界" }]);
		viewer.dispose();
	});

	it("registers flags, lifecycle handlers, the tool, and the discovery command", () => {
		const root = createTemporaryProject();
		const flags: string[] = [];
		const events: string[] = [];
		const tools: string[] = [];
		const commands: string[] = [];
		const shortcuts: string[] = [];
		const messageRenderers: string[] = [];
		const omega = {
			registerFlag: (name: string) => flags.push(name),
			registerShortcut: (shortcut: string) => shortcuts.push(shortcut),
			getFlag: () => undefined,
			on: (name: string) => events.push(name),
			registerTool: (tool: { name: string }) => tools.push(tool.name),
			registerCommand: (name: string) => commands.push(name),
			registerMessageRenderer: (name: string) => messageRenderers.push(name),
		} as unknown as OmegaAPI;
		registerSubagents(omega, { settingsPath: path.join(root, "subagents.json") });
		expect(flags).toEqual(["subagent-max-depth", "subagent-prevent-cycles", "no-subagent-prevent-cycles"]);
		expect(events).toEqual(
			expect.arrayContaining(["session_start", "session_shutdown", "before_agent_start", "tool_result"]),
		);
		expect(tools).toEqual(expect.arrayContaining(["subagent", "subagent_message", "subagent_status"]));
		expect(shortcuts).toContain("shift+down");
		expect(messageRenderers).toContain("omega-subagent-runtime-result");
		expect(commands).toEqual(
			expect.arrayContaining([
				"subagent:list",
				"subagent:settings",
				"subagent:status",
				"subagents:kill",
				"subagents:send",
			]),
		);
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
			registerShortcut: () => undefined,
			getFlag: () => undefined,
			on: (name: string) => events.push(name),
			registerTool: (tool: { name: string }) => tools.push(tool.name),
			registerCommand: (name: string) => commands.push(name),
			registerMessageRenderer: () => undefined,
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
			registerShortcut: () => undefined,
			getFlag: () => undefined,
			on: () => undefined,
			registerTool: () => undefined,
			registerCommand: (
				name: string,
				options: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> },
			) => commands.set(name, options.handler),
			registerMessageRenderer: () => undefined,
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

	it("preserves the source loader when spawning a TypeScript Omega child", () => {
		const sourceCli = path.resolve("packages/omega-core/src/cli.ts");
		expect(
			resolvePiSpawn({
				execPath: "C:\\nodejs\\node.exe",
				argv: ["C:\\nodejs\\node.exe", sourceCli],
				execArgv: ["--import", "file:///workspace/node_modules/tsx/dist/loader.mjs"],
			}),
		).toEqual({
			command: "C:\\nodejs\\node.exe",
			prefixArgs: [
				"--import",
				"file:///workspace/node_modules/tsx/dist/loader.mjs",
				sourceCli,
				"--mode",
				"rpc",
			],
		});
	});

	it("does not copy parent Node flags into a built JavaScript child", () => {
		const builtCli = path.resolve("packages/omega-core/dist/cli.js");
		expect(
			resolvePiSpawn({
				execPath: "C:\\nodejs\\node.exe",
				argv: ["C:\\nodejs\\node.exe", builtCli],
				execArgv: ["--inspect"],
			}),
		).toEqual({ command: "C:\\nodejs\\node.exe", prefixArgs: [builtCli, "--mode", "rpc"] });
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

	it("keeps the terminating structured output tool available for no-tools agents", () => {
		const agent: AgentConfig = {
			name: "verifier",
			description: "Structured verifier",
			noTools: true,
			systemPrompt: "Verify evidence.",
			source: "project",
			filePath: "/project/.omega/agents/verifier.md",
		};
		const args = buildPiArgs(
			agent,
			null,
			"Verify",
			"empty",
			null,
			undefined,
			undefined,
			undefined,
			undefined,
			true,
			["structured_output"],
		);
		expect(args).toEqual(expect.arrayContaining(["--tools", "structured_output"]));
		expect(args).not.toContain("--no-tools");
	});

	it("captures a terminating structured_output call as semantic completion", () => {
		const result: SingleResult = {
			agent: "verifier",
			agentSource: "project",
			prompt: "Verify",
			initialContext: "empty",
			exitCode: 0,
			messages: [],
			stderr: "",
			usage: emptyUsage(),
		};
		const message = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "structured-1",
					name: "structured_output",
					arguments: { verdict: "confirmed" },
				},
			],
		};
		processSubagentJsonLine(JSON.stringify({ type: "message_end", message }), result);
		processSubagentJsonLine(JSON.stringify({ type: "agent_end", messages: [message] }), result);
		expect(result.structuredOutput).toEqual({ verdict: "confirmed" });
		expect(isResultSuccess(result)).toBe(true);
	});

	it("assembles assistant streaming deltas for the runtime TUI", () => {
		const result: SingleResult = {
			agent: "reviewer",
			agentSource: "builtin",
			prompt: "Review",
			initialContext: "empty",
			exitCode: -1,
			messages: [],
			stderr: "",
			usage: emptyUsage(),
		};
		processSubagentJsonLine(
			JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "start" } }),
			result,
		);
		processSubagentJsonLine(
			JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } }),
			result,
		);
		processSubagentJsonLine(
			JSON.stringify({
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "实时回答" },
			}),
			result,
		);
		expect(result.liveContent).toEqual([{ type: "text", text: "实时回答" }]);
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

	it("applies a finite default wall-clock timeout unless the call overrides it", () => {
		expect(resolveRunTimeoutMs(undefined)).toBe(DEFAULT_SUBAGENT_RUN_TIMEOUT_MS);
		expect(resolveRunTimeoutMs(12_000)).toBe(12_000);
	});
});
