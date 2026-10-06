import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OmegaAPI } from "../src/api.ts";
import {
	getWorkflowTaskExecutors,
	getUserWorkflowsDirectory,
	generateWorkflowScript,
	initializeUserWorkflowsDirectory,
	parseWorkflowScript,
	registerWorkflowTaskExecutor,
	registerWorkflows,
	runWorkflow,
	WorkflowService,
} from "../src/workflows/index.ts";
import { WORKFLOW_STACK_ENV } from "../src/subagents/protocol.ts";
import { discoverWorkflows } from "../src/workflows/registry.ts";
import { renderWorkflowMessage, renderWorkflowStatusText } from "../src/workflows/display.ts";
import { WorkflowStatusView } from "../src/workflows/status-view.ts";
import type { VerificationResult, WorkflowAgentRunner } from "../src/workflows/types.ts";

type CommandHandler = Parameters<ExtensionAPI["registerCommand"]>[1]["handler"];
type CommandOptions = Parameters<ExtensionAPI["registerCommand"]>[1];

const temporaryDirectories: string[] = [];

function temporaryProject(): string {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "omega-workflows-test-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("workflow parser", () => {
	it("parses literal metadata and removes its export from the executable body", () => {
		const parsed = parseWorkflowScript(`export const meta = {
  name: 'inspect_project',
  description: 'Inspect a project',
  phases: [{ title: 'Scan' }],
}
phase('Scan')
return 'ok'`);
		expect(parsed.meta).toMatchObject({ name: "inspect_project", phases: [{ title: "Scan" }] });
		expect(parsed.body).not.toContain("export const meta");
	});

	it("normalizes string phase metadata to phase objects", () => {
		const parsed = parseWorkflowScript(
			"export const meta = { name: 'inspect_project', description: 'Inspect', phases: ['Scan'] }; return true",
		);
		expect(parsed.meta.phases).toEqual([{ title: "Scan" }]);
	});

	it("rejects imports and nondeterministic APIs", () => {
		expect(() =>
			parseWorkflowScript(
				"export const meta = { name: 'bad_import', description: 'bad' }; import fs from 'node:fs'; return fs",
			),
		).toThrow("imports are unavailable");
		expect(() =>
			parseWorkflowScript(
				"export const meta = { name: 'bad_random', description: 'bad' }; return Math.random()",
			),
		).toThrow("nondeterministic");
	});

	it("rejects exports left in the executable workflow body", () => {
		expect(() =>
			parseWorkflowScript(`export const meta = { name: 'duplicate_export', description: 'bad' }
export const taskName = 'scan'
return taskName`),
		).toThrow("Only the leading workflow metadata declaration may use export");
	});

	it("rejects host prototype and reflection escape paths", () => {
		expect(() =>
			parseWorkflowScript(
				`export const meta = { name: 'bad_escape', description: 'bad' }
return agent['con' + 'structor']('return process')()`,
			),
		).toThrow("computed property names");
		expect(() =>
			parseWorkflowScript(
				`export const meta = { name: 'bad_reflect', description: 'bad' }
return Object.getPrototypeOf(agent)`,
			),
		).toThrow("Object.getPrototypeOf");
		expect(() =>
			parseWorkflowScript(
				`export const meta = { name: 'bad_destructure', description: 'bad' }
const { constructor: HostFunction } = agent
return HostFunction('return process')()`,
			),
		).toThrow("property constructor");
	});
});

describe("workflow generator", () => {
	it("documents the phase metadata shape and accepts string phase shorthand", async () => {
		const prompts: string[] = [];
		const runner: WorkflowAgentRunner = {
			run: async (prompt) => {
				prompts.push(prompt);
				return {
					script:
						"export const meta = { name: 'generated_flow', description: 'Generated workflow', phases: ['Inspect'] }; return true",
				};
			},
		};
		const generated = await generateWorkflowScript("Inspect the project", {
			agentRunner: runner,
			agents: [{ name: "workflow-author", description: "Workflow author" }],
		});
		expect(generated).toMatchObject({ attempts: 1, meta: { phases: [{ title: "Inspect" }] } });
		expect(prompts[0]).toContain("meta.phases must be an array of objects");
	});

	it("repairs an invalid generated script and validates the result before returning it", async () => {
		const prompts: string[] = [];
		const runner: WorkflowAgentRunner = {
			run: async (prompt, options) => {
				prompts.push(prompt);
				expect(options).toMatchObject({ agentType: "workflow-author", label: expect.any(String) });
				return prompts.length === 1
					? {
							script:
								"export const meta = { name: 'generated_flow', description: 'Generated workflow' }; export const taskName = 'scan'; return taskName",
						}
					: {
							script:
								"```js\nexport const meta = { name: 'generated_flow', description: 'Generated workflow' }; return { prompt: args.prompt }\n```",
						};
			},
		};
		const generated = await generateWorkflowScript("Inspect authentication and verify the result", {
			agentRunner: runner,
			agents: [
				{ name: "workflow-author", description: "Workflow author" },
				{ name: "security-worker", description: "Security worker" },
			],
			workflowNames: ["inspect_project"],
		});
		expect(generated).toMatchObject({ meta: { name: "generated_flow" }, attempts: 2 });
		expect(generated.script).not.toContain("```");
		expect(prompts[1]).toContain("Only the leading workflow metadata declaration may use export");
	});
});

describe("workflow engine", () => {
	it("runs the documented phase and sequential agent template", async () => {
		const prompts: string[] = [];
		const runner: WorkflowAgentRunner = {
			run: async (prompt) => {
				prompts.push(prompt);
				return prompts.length === 1 ? "inventory" : `summary:${prompt.split("\n").at(-1)}`;
			},
		};
		const result = await runWorkflow(
			`export const meta = {
  name: 'inspect_project',
  description: 'Inspect a repository and summarize the main modules',
  phases: [{ title: 'Scan' }, { title: 'Analyze' }],
}
phase('Scan')
const inventory = await agent('Inspect the repository structure.', { label: 'repo inventory' })
phase('Analyze')
const summary = await agent('Summarize the main modules from this inventory:\\n' + inventory, { label: 'module summary' })
return { inventory, summary }`,
			{ cwd: process.cwd(), agentRunner: runner },
		);
		expect(result.result).toEqual({ inventory: "inventory", summary: "summary:inventory" });
		expect(result.phases).toEqual(["Scan", "Analyze"]);
		expect(result.agentCount).toBe(2);
	});

	it("supports deterministic task sequencing and nested workflows", async () => {
		const child = `export const meta = { name: 'child_flow', description: 'Child workflow' }
return await task('double', args, { label: 'double child' })`;
		const result = await runWorkflow(
			`export const meta = { name: 'parent_flow', description: 'Parent workflow' }
const first = await task('double', 3, { label: 'double first' })
const second = await workflow('child_flow', first)
return second`,
			{
				cwd: process.cwd(),
				agentRunner: { run: async () => "unused" },
				taskExecutors: [{ name: "double", run: async (input) => Number(input) * 2 }],
				loadWorkflow: (name) => (name === "child_flow" ? child : undefined),
			},
		);
		expect(result.result).toBe(12);
		expect(result.taskCount).toBe(2);
	});

	it("rejects a workflow cycle inherited across a subagent process boundary", async () => {
		const previous = process.env[WORKFLOW_STACK_ENV];
		process.env[WORKFLOW_STACK_ENV] = JSON.stringify(["cycle_flow"]);
		try {
			await expect(
				runWorkflow("export const meta = { name: 'cycle_flow', description: 'Cycle' }; return true", {
					cwd: process.cwd(),
					agentRunner: { run: async () => "unused" },
				}),
			).rejects.toThrow("Workflow cycle detected");
		} finally {
			if (previous === undefined) delete process.env[WORKFLOW_STACK_ENV];
			else process.env[WORKFLOW_STACK_ENV] = previous;
		}
	});

	it("provides an executor-verifier security primitive", async () => {
		const verification: VerificationResult = {
			verdict: "confirmed",
			confidence: "high",
			summary: "Evidence is reproducible.",
			evidenceChecks: [{ claim: "auth bypass", status: "verified", reason: "independent trace" }],
			contradictions: [],
			missingEvidence: [],
		};
		const runner: WorkflowAgentRunner = {
			run: async (_prompt, options) =>
				options?.schema
					? verification
					: { status: "confirmed", evidence: ["HTTP 200 without a session"] },
		};
		const result = await runWorkflow(
			`export const meta = { name: 'checked_test', description: 'Execute and verify' }
return await executeAndVerify('Test the authorized target.', {
  executor: { label: 'execute test', agentType: 'security-worker' },
  verifier: { label: 'verify finding', agentType: 'security-worker', task: 'Verify the auth bypass.' },
})`,
			{ cwd: process.cwd(), agentRunner: runner },
		);
		expect(result.result).toMatchObject({ ok: true, attempts: 1, verification });
		expect(result.agentCount).toBe(2);
	});
});

describe("workflow registry", () => {
	it("includes the workbench-inspired Web hunt as a builtin", () => {
		const root = temporaryProject();
		const registry = discoverWorkflows(root, false, path.join(root, "user-workflows"));
		const definition = registry.definitions.get("workbench_web_hunt");
		expect(definition).toMatchObject({
			source: "builtin",
			description: expect.stringContaining("falsifiable prediction"),
		});
		expect(definition?.script).toContain("preflight.status !== 'ready'");
		expect(definition?.script).toContain("maxAttempts: 1");
	});

	it("stops the workbench Web hunt before network-capable phases when authorization is incomplete", async () => {
		const root = temporaryProject();
		const definition = discoverWorkflows(root, false, path.join(root, "user-workflows")).definitions.get(
			"workbench_web_hunt",
		);
		expect(definition).toBeDefined();
		const prompts: string[] = [];
		const result = await runWorkflow(definition?.script ?? "", {
			cwd: root,
			args: { request: "Assess https://lab.example.test" },
			agentRunner: {
				run: async (prompt) => {
					prompts.push(prompt);
					return {
						status: "offline_only",
						authorizationSource: "",
						inScope: [],
						exclusions: [],
						allowedActions: [],
						prohibitedActions: [],
						maxImpactLevel: "",
						stopConditions: [],
						missing: ["recorded target scope"],
						summary: "Authorization is incomplete.",
					};
				},
			},
		});
		expect(prompts).toHaveLength(1);
		expect(result.phases).toEqual(["Preflight"]);
		expect(result.result).toMatchObject({ ok: false, stage: "preflight" });
	});

	it("places user workflows beside the user agent directory", () => {
		const root = temporaryProject();
		const directory = getUserWorkflowsDirectory(path.join(root, ".omega", "agent"));
		expect(directory).toBe(path.join(root, ".omega", "workflows"));
		expect(initializeUserWorkflowsDirectory(directory)).toBe(directory);
		expect(fs.existsSync(directory)).toBe(true);
	});

	it("loads builtins and lets trusted project workflows override them", () => {
		const root = temporaryProject();
		const userWorkflowsDirectory = path.join(root, "user-workflows");
		fs.mkdirSync(userWorkflowsDirectory);
		const workflowsDirectory = path.join(root, ".omega", "workflows");
		fs.mkdirSync(workflowsDirectory, { recursive: true });
		fs.writeFileSync(
			path.join(workflowsDirectory, "inspect.js"),
			"export const meta = { name: 'inspect_project', description: 'Project override' }; return 'project'",
		);
		const untrusted = discoverWorkflows(root, false, userWorkflowsDirectory);
		const trusted = discoverWorkflows(root, true, userWorkflowsDirectory);
		expect(untrusted.definitions.get("inspect_project")?.source).toBe("builtin");
		expect(trusted.definitions.get("inspect_project")).toMatchObject({
			source: "project",
			description: "Project override",
		});
	});
});

describe("workflows command", () => {
	it("registers dynamic run, run-template, list, status, validate, show and reload under /workflows", async () => {
		const root = temporaryProject();
		const userWorkflowsDirectory = path.join(root, "user-workflows");
		const projectWorkflowsDirectory = path.join(root, ".omega", "workflows");
		fs.mkdirSync(projectWorkflowsDirectory, { recursive: true });
		fs.writeFileSync(
			path.join(projectWorkflowsDirectory, "echo.js"),
			`export const meta = {
  name: 'echo_flow',
  description: 'Echo workflow arguments',
  phases: [{ title: 'Echo' }],
}
phase('Echo')
return { received: args }`,
		);
		const commands = new Map<string, CommandOptions>();
		const tools: string[] = [];
		const sendMessage = vi.fn();
		const omega = {
			registerCommand: (name: string, command: CommandOptions) => commands.set(name, command),
			registerTool: (tool: { name: string }) => tools.push(tool.name),
			registerMessageRenderer: vi.fn(),
			sendMessage,
			on: vi.fn(),
		} as unknown as OmegaAPI;
		registerWorkflows(omega, { userWorkflowsDirectory });
		expect(tools).toContain("workflow");
		expect(commands.has("workflow")).toBe(false);
		const registration = commands.get("workflows");
		expect(registration).toBeDefined();
		expect(await registration?.getArgumentCompletions?.("r")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ value: "run ", label: "run" }),
				expect.objectContaining({ value: "run-template ", label: "run-template" }),
			]),
		);

		const notify = vi.fn();
		const select = vi.fn();
		const custom = vi.fn().mockResolvedValue(undefined);
		const setStatus = vi.fn();
		const context = {
			cwd: root,
			hasUI: true,
			isProjectTrusted: () => true,
			signal: new AbortController().signal,
			ui: { notify, select, custom, setStatus, theme: { fg: (_color: string, text: string) => text } },
		} as unknown as Parameters<CommandHandler>[1];
		const command = registration?.handler;

		await command?.("list", context);
		expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("echo_flow [project]"), "info");
		expect(notify).not.toHaveBeenLastCalledWith(expect.stringContaining("用户目录:"), "info");
		expect(notify).not.toHaveBeenLastCalledWith(expect.stringContaining("项目目录:"), "info");
		expect(await registration?.getArgumentCompletions?.("run-template e")).toEqual(
			expect.arrayContaining([expect.objectContaining({ value: "run-template echo_flow ", label: "echo_flow" })]),
		);
		expect(await registration?.getArgumentCompletions?.("run inspect authentication")).toBeNull();

		await command?.("", context);
		expect(custom).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ overlay: true }));

		select.mockImplementationOnce(async (_title: string, choices: string[]) =>
			choices.find((choice) => choice.startsWith("echo_flow ")),
		);
		await command?.("show", context);
		expect(select).toHaveBeenCalledWith("Workflows · show", expect.arrayContaining([expect.stringContaining("echo_flow")]));
		expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("return { received: args }"), "info");

		await command?.("validate echo_flow", context);
		expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("Workflow template validated: echo_flow"), "info");

		await command?.('run-template echo_flow {"target":"lab"}', context);
		expect(sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "omega-workflow-result",
				display: true,
				content: expect.stringContaining('"target": "lab"'),
			}),
			{ triggerTurn: false },
		);

		await command?.("status", context);
		expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("echo_flow [succeeded]"), "info");

		const generatedScript =
			"export const meta = { name: 'generated_flow', description: 'Generated workflow' }; return { request: args.prompt }";
		const generate = vi.spyOn(WorkflowService.prototype, "generate").mockResolvedValue({
			script: generatedScript,
			meta: { name: "generated_flow", description: "Generated workflow" },
			attempts: 1,
		});
		await command?.("run inspect authentication and verify findings", context);
		expect(generate).toHaveBeenCalledWith(
			"inspect authentication and verify findings",
			expect.objectContaining({ cwd: root, includeProjectWorkflows: true }),
		);
		expect(sendMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({ content: expect.stringContaining("inspect authentication and verify findings") }),
			{ triggerTurn: false },
		);

		fs.writeFileSync(
			path.join(projectWorkflowsDirectory, "new.js"),
			"export const meta = { name: 'new_flow', description: 'New workflow' }; return true",
		);
		await command?.("reload", context);
		expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("new_flow [project]"), "info");
	});
});

describe("workflow TUI display", () => {
	it("renders collapsed and expanded workflow runtime details", () => {
		const status = {
			id: "workflow.pending.1",
			runId: "workflow.1",
			name: "inspect_auth",
			state: "running" as const,
			phase: "Analyze",
			runningNodes: 1,
			completedNodes: 0,
			startedAt: Date.now(),
			logs: ["analysis started"],
			nodes: [
				{
					id: "subagent.1",
					kind: "agent" as const,
					label: "inspect routes",
					state: "running" as const,
					agentType: "security-worker",
					prompt: "Inspect authentication routes",
					output: "reading routes.ts",
				},
			],
		};
		const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
		expect(renderWorkflowStatusText(status, false, theme)).toContain("Ctrl+O");
		const expanded = renderWorkflowStatusText(status, true, theme);
		expect(expanded).toContain("inspect routes");
		expect(expanded).toContain("reading routes.ts");
	});

	it("wraps completed workflow output in a toolbox frame and prefers its summary", () => {
		const status = {
			id: "workflow.done.1",
			name: "security_review",
			state: "succeeded" as const,
			runningNodes: 0,
			completedNodes: 1,
			startedAt: 1,
			finishedAt: 2,
			logs: [],
			nodes: [],
			result: { request: "irrelevant request", workerOutput: "irrelevant verbose output", summary: "Finding verified." },
		};
		const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
		const rendered = renderWorkflowMessage({ kind: "omega-workflow", status }, false, theme).render(80).join("\n");

		expect(rendered).toContain("╭");
		expect(rendered).toContain("╰");
		expect(rendered).toContain("Finding verified.");
		expect(rendered).not.toContain("irrelevant verbose output");
	});

	it("lets the status box select a running agent and view its output", () => {
		const run = {
			id: "workflow.pending.2",
			name: "parallel_review",
			state: "running" as const,
			runningNodes: 2,
			completedNodes: 0,
			startedAt: Date.now(),
			logs: [],
			nodes: [
				{
					id: "workflow.pending.2:subagent.1",
					kind: "agent" as const,
					label: "first agent",
					state: "running" as const,
					agentType: "security-worker",
					output: "first output",
				},
				{
					id: "workflow.pending.2:subagent.2",
					kind: "agent" as const,
					label: "second agent",
					state: "running" as const,
					agentType: "security-worker",
					output: "second output",
				},
			],
		};
		const service = {
			getStatus: () => ({ active: [run] }),
			subscribe: () => () => undefined,
		} as unknown as WorkflowService;
		const requestRender = vi.fn();
		const done = vi.fn();
		const view = new WorkflowStatusView(
			service,
			{ requestRender } as never,
			{
				fg: (_color: string, text: string) => text,
				bold: (text: string) => text,
			} as never,
			{
				matches: (data: string, action: string) => data === "down" && action === "tui.select.down",
				getKeys: (action: string) => [action],
			} as never,
			done,
		);
		expect(view.render(100).join("\n")).toContain("first output");
		view.handleMouse({
			type: "wheel",
			button: "none",
			x: 1,
			y: 1,
			screenX: 1,
			screenY: 1,
			width: 100,
			height: 30,
			shift: false,
			alt: false,
			ctrl: false,
			wheelDelta: 3,
		});
		expect(view.render(100).join("\n")).toContain("second output");
		expect(requestRender).toHaveBeenCalled();
		view.dispose();
	});
});

describe("workflow task registry", () => {
	it("registers narrow host task primitives and disposes them", async () => {
		const dispose = registerWorkflowTaskExecutor({
			name: "test-double",
			run: async (input) => Number(input) * 2,
		});
		try {
			const executor = getWorkflowTaskExecutors().find((candidate) => candidate.name === "test-double");
			await expect(executor?.run(4, { cwd: process.cwd(), args: undefined, meta: {
				name: "registry_test",
				description: "Registry test",
			} })).resolves.toBe(8);
			expect(() => registerWorkflowTaskExecutor({ name: "test-double", run: async () => undefined })).toThrow(
				"already registered",
			);
		} finally {
			dispose();
		}
		expect(getWorkflowTaskExecutors().some((candidate) => candidate.name === "test-double")).toBe(false);
	});
});
