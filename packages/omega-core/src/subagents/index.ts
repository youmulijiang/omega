import * as path from "node:path";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { OmegaAPI } from "../api.ts";
import { type AgentConfig, type AgentScope, discoverAgents, formatAgentList } from "./agents.ts";
import {
	getFinalOutput,
	getResultOutput,
	isFailedResult,
	mapWithConcurrencyLimit,
	OMEGA_SUBAGENT_DEPTH_ENV,
	runSingleAgent,
	type SubagentResult,
} from "./runner.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const PER_TASK_OUTPUT_CAP = 50 * 1024;

const TaskItem = Type.Object({
	agent: Type.String({ description: "Scenario agent name" }),
	task: Type.String({ description: "Task delegated to this agent" }),
	cwd: Type.Optional(Type.String({ description: "Child working directory" })),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Scenario agent name" }),
	task: Type.String({ description: "Task; use {previous} to insert the prior step output" }),
	cwd: Type.Optional(Type.String({ description: "Child working directory" })),
});

const SubagentParams = Type.Object({
	action: Type.Optional(
		StringEnum(["run", "list"] as const, {
			description: 'Use "list" to inspect available scenario agents. Default: "run".',
		}),
	),
	agent: Type.Optional(Type.String({ description: "Agent name for single mode" })),
	task: Type.Optional(Type.String({ description: "Task for single mode" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Independent tasks executed in parallel" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Sequential tasks with optional {previous} handoff" })),
	agentScope: Type.Optional(
		StringEnum(["user", "project", "both"] as const, {
			description: 'Agent definition scopes. Default: "both"; project overrides user and builtins.',
		}),
	),
	cwd: Type.Optional(Type.String({ description: "Child working directory for single mode" })),
});

interface SubagentDetails {
	mode: "list" | "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SubagentResult[];
}

function truncateOutput(output: string): string {
	const size = Buffer.byteLength(output, "utf8");
	if (size <= PER_TASK_OUTPUT_CAP) return output;
	let end = Math.min(output.length, PER_TASK_OUTPUT_CAP);
	while (Buffer.byteLength(output.slice(0, end), "utf8") > PER_TASK_OUTPUT_CAP) end--;
	return `${output.slice(0, end)}\n\n[Output truncated; ${size - Buffer.byteLength(output.slice(0, end), "utf8")} bytes omitted.]`;
}

function requestedAgentNames(params: {
	agent?: string;
	tasks?: Array<{ agent: string }>;
	chain?: Array<{ agent: string }>;
}): Set<string> {
	const names = new Set<string>();
	if (params.agent) names.add(params.agent);
	for (const task of params.tasks ?? []) names.add(task.agent);
	for (const step of params.chain ?? []) names.add(step.agent);
	return names;
}

async function confirmProjectAgents(
	agents: AgentConfig[],
	names: Set<string>,
	projectAgentsDir: string | null,
	ctx: ExtensionContext,
): Promise<boolean> {
	const selected = Array.from(names)
		.map((name) => agents.find((agent) => agent.name === name))
		.filter((agent): agent is AgentConfig => agent?.source === "project");
	if (selected.length === 0 || ctx.isProjectTrusted()) return true;
	if (!ctx.hasUI) return false;
	return ctx.ui.confirm(
		"Run project-local subagents?",
		`Agents: ${selected.map((agent) => agent.name).join(", ")}\nSource: ${projectAgentsDir ?? "unknown"}\n\nProject agent prompts are repository-controlled.`,
	);
}

export function registerSubagents(omega: OmegaAPI): void {
	if (Number.parseInt(process.env[OMEGA_SUBAGENT_DEPTH_ENV] ?? "0", 10) > 0) return;

	omega.registerCommand("subagents", {
		description: "List available Omega scenario subagents",
		handler: async (_args, ctx) => {
			const discovery = discoverAgents(ctx.cwd, "both");
			const lines = discovery.agents.map(
				(agent) =>
					`${agent.name} [${agent.source}] — ${agent.description}${agent.model ? ` (${agent.model})` : ""}`,
			);
			const diagnostics = discovery.diagnostics.map(
				(diagnostic) => `Skipped ${diagnostic.filePath}: ${diagnostic.message}`,
			);
			ctx.ui.notify([...lines, ...diagnostics].join("\n"), diagnostics.length ? "warning" : "info");
		},
	});

	omega.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate work to an isolated Omega child process with a scenario-specific system prompt.",
			"Use action=list to inspect agents. Run modes: single, parallel, or sequential chain with {previous}.",
			`Definitions load from ~/.omega/agents and ${path.join(".omega", "agents")}; project definitions override user and builtins.`,
		].join(" "),
		parameters: SubagentParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "both";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const details = (mode: SubagentDetails["mode"], results: SubagentResult[]): SubagentDetails => ({
				mode,
				agentScope,
				projectAgentsDir: discovery.projectAgentsDir,
				results,
			});

			if ((params.action ?? "run") === "list") {
				const formatted = formatAgentList(discovery.agents, 100);
				const diagnosticText = discovery.diagnostics
					.map((diagnostic) => `\n- skipped ${diagnostic.filePath}: ${diagnostic.message}`)
					.join("");
				return {
					content: [{ type: "text", text: `${formatted.text}${diagnosticText}` }],
					details: details("list", []),
				};
			}

			const hasSingle = Boolean(params.agent && params.task);
			const hasParallel = (params.tasks?.length ?? 0) > 0;
			const hasChain = (params.chain?.length ?? 0) > 0;
			if (Number(hasSingle) + Number(hasParallel) + Number(hasChain) !== 1) {
				return {
					content: [
						{
							type: "text",
							text: `Provide exactly one run mode: agent+task, tasks, or chain. Available: ${formatAgentList(discovery.agents, 100).text}`,
						},
					],
					details: details("single", []),
					isError: true,
				};
			}

			if (
				!(await confirmProjectAgents(
					discovery.agents,
					requestedAgentNames(params),
					discovery.projectAgentsDir,
					ctx,
				))
			) {
				return {
					content: [{ type: "text", text: "Canceled: project-local subagent prompts were not trusted." }],
					details: details(hasChain ? "chain" : hasParallel ? "parallel" : "single", []),
					isError: true,
				};
			}

			const dispatchDefaults = {
				model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
				thinkingLevel: ctx.thinkingLevel,
			};

			if (params.agent && params.task) {
				const result = await runSingleAgent({
					defaultCwd: ctx.cwd,
					dispatchDefaults,
					agents: discovery.agents,
					agentName: params.agent,
					task: params.task,
					cwd: params.cwd,
					signal,
					onUpdate: (current) =>
						onUpdate?.({
							content: [{ type: "text", text: getFinalOutput(current.messages) || "(running...)" }],
							details: details("single", [current]),
						}),
				});
				return {
					content: [{ type: "text", text: getResultOutput(result) }],
					details: details("single", [result]),
					isError: isFailedResult(result),
				};
			}

			if (params.tasks?.length) {
				if (params.tasks.length > MAX_PARALLEL_TASKS) {
					return {
						content: [{ type: "text", text: `Too many parallel tasks. Maximum: ${MAX_PARALLEL_TASKS}.` }],
						details: details("parallel", []),
						isError: true,
					};
				}
				const completed: SubagentResult[] = [];
				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (task) => {
					const result = await runSingleAgent({
						defaultCwd: ctx.cwd,
						dispatchDefaults,
						agents: discovery.agents,
						agentName: task.agent,
						task: task.task,
						cwd: task.cwd,
						signal,
					});
					completed.push(result);
					onUpdate?.({
						content: [
							{ type: "text", text: `Parallel: ${completed.length}/${params.tasks?.length ?? 0} complete` },
						],
						details: details("parallel", [...completed]),
					});
					return result;
				});
				const successCount = results.filter((result) => !isFailedResult(result)).length;
				const summaries = results.map(
					(result) =>
						`### ${result.agent} — ${isFailedResult(result) ? "failed" : "completed"}\n\n${truncateOutput(getResultOutput(result))}`,
				);
				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
						},
					],
					details: details("parallel", results),
					isError: successCount === 0,
				};
			}

			const results: SubagentResult[] = [];
			let previous = "";
			for (let index = 0; index < (params.chain?.length ?? 0); index++) {
				const step = params.chain?.[index];
				if (!step) continue;
				const result = await runSingleAgent({
					defaultCwd: ctx.cwd,
					dispatchDefaults,
					agents: discovery.agents,
					agentName: step.agent,
					task: step.task.replace(/\{previous\}/g, previous),
					cwd: step.cwd,
					step: index + 1,
					signal,
				});
				results.push(result);
				onUpdate?.({
					content: [{ type: "text", text: `Chain: ${results.length}/${params.chain?.length ?? 0} complete` }],
					details: details("chain", [...results]),
				});
				if (isFailedResult(result)) {
					return {
						content: [{ type: "text", text: `Chain stopped at step ${index + 1}: ${getResultOutput(result)}` }],
						details: details("chain", results),
						isError: true,
					};
				}
				previous = getFinalOutput(result.messages);
			}
			return {
				content: [{ type: "text", text: previous || "(no output)" }],
				details: details("chain", results),
			};
		},
	});
}

export type { AgentConfig, AgentScope } from "./agents.ts";
export type { SubagentResult } from "./runner.ts";
