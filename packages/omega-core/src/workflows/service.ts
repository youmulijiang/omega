import * as path from "node:path";
import type { ParentModel } from "../subagents/runner.ts";
import { ProcessSubagentRuntime, type ProgrammaticAgentEvent } from "../subagents/runtime.ts";
import { isResultSuccess, type SingleResult } from "../subagents/types.ts";
import { runWorkflow } from "./engine.ts";
import { type GeneratedWorkflow, generateWorkflowScript } from "./generator.ts";
import { parseWorkflowScript } from "./parser.ts";
import { discoverWorkflows, getUserWorkflowsDirectory, type WorkflowRegistry } from "./registry.ts";
import { getWorkflowTaskExecutors } from "./task-registry.ts";
import type { WorkflowNodeEvent, WorkflowRunResult } from "./types.ts";

export interface WorkflowExecutionStatus {
	id: string;
	runId?: string;
	name: string;
	state: "running" | "succeeded" | "failed";
	phase?: string;
	runningNodes: number;
	completedNodes: number;
	startedAt: number;
	finishedAt?: number;
	agentCount?: number;
	taskCount?: number;
	result?: unknown;
	error?: string;
	logs: string[];
	nodes: WorkflowExecutionNode[];
}

export interface WorkflowExecutionNode {
	id: string;
	kind: "agent" | "task";
	label: string;
	state: "running" | "succeeded" | "failed";
	phase?: string;
	agentType?: string;
	prompt?: string;
	output?: string;
	error?: string;
}

export interface WorkflowStatusSnapshot {
	active: WorkflowExecutionStatus[];
	last?: WorkflowExecutionStatus;
}

export interface WorkflowServiceOptions {
	userWorkflowsDirectory?: string;
}

export interface ExecuteWorkflowOptions {
	cwd: string;
	includeProjectWorkflows: boolean;
	parentModel?: ParentModel;
	args?: unknown;
	concurrency?: number;
	maxAgents?: number;
	tokenBudget?: number;
	signal?: AbortSignal;
	onStatus?: (status: WorkflowExecutionStatus) => void;
}

export interface GenerateWorkflowOptions {
	cwd: string;
	includeProjectWorkflows: boolean;
	parentModel?: ParentModel;
	signal?: AbortSignal;
}

function cloneStatus(status: WorkflowExecutionStatus): WorkflowExecutionStatus {
	return { ...status, logs: [...status.logs], nodes: status.nodes.map((node) => ({ ...node })) };
}

function formatAgentOutput(result: SingleResult | undefined): string | undefined {
	if (!result) return undefined;
	const lines: string[] = [];
	for (const message of result.messages) {
		if (message.role === "assistant") {
			for (const part of message.content) {
				if (part.type === "text") lines.push(...part.text.replace(/\r\n?/gu, "\n").split("\n"));
				else if (part.type === "toolCall") lines.push(`→ ${part.name} ${JSON.stringify(part.arguments)}`);
			}
		} else if (message.role === "toolResult") {
			const text = message.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n");
			lines.push(`← ${message.toolName}${message.isError ? " [error]" : ""}${text ? `\n${text}` : ""}`);
		}
	}
	if (result.stderr.trim()) lines.push(`[stderr] ${result.stderr.trim()}`);
	const visible = lines.slice(-400).join("\n");
	return visible.length > 100_000 ? `… output truncated …\n${visible.slice(-100_000)}` : visible || undefined;
}

function formatTaskOutput(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
	return text.length > 100_000 ? `… output truncated …\n${text.slice(-100_000)}` : text;
}

function refreshNodeCounts(status: WorkflowExecutionStatus): void {
	status.runningNodes = status.nodes.filter((node) => node.state === "running").length;
	status.completedNodes = status.nodes.length - status.runningNodes;
}

export class WorkflowService {
	private readonly userWorkflowsDirectory: string;
	private readonly registryCache = new Map<string, WorkflowRegistry>();
	private readonly activeRuns = new Map<string, WorkflowExecutionStatus>();
	private readonly listeners = new Set<(status: WorkflowStatusSnapshot) => void>();
	private lastRun?: WorkflowExecutionStatus;
	private sequence = 0;

	constructor(options: WorkflowServiceOptions = {}) {
		this.userWorkflowsDirectory = options.userWorkflowsDirectory ?? getUserWorkflowsDirectory();
	}

	getRegistry(cwd: string, includeProjectWorkflows: boolean): WorkflowRegistry {
		const key = this.registryKey(cwd, includeProjectWorkflows);
		let registry = this.registryCache.get(key);
		if (!registry) {
			registry = discoverWorkflows(cwd, includeProjectWorkflows, this.userWorkflowsDirectory);
			this.registryCache.set(key, registry);
		}
		return registry;
	}

	reload(cwd: string, includeProjectWorkflows: boolean): WorkflowRegistry {
		const key = this.registryKey(cwd, includeProjectWorkflows);
		const registry = discoverWorkflows(cwd, includeProjectWorkflows, this.userWorkflowsDirectory);
		this.registryCache.set(key, registry);
		return registry;
	}

	getStatus(): WorkflowStatusSnapshot {
		return {
			active: [...this.activeRuns.values()].map(cloneStatus),
			...(this.lastRun ? { last: cloneStatus(this.lastRun) } : {}),
		};
	}

	subscribe(listener: (status: WorkflowStatusSnapshot) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notifyListeners(): void {
		const snapshot = this.getStatus();
		for (const listener of this.listeners) {
			try {
				listener(snapshot);
			} catch (error) {
				console.warn(`[omega-workflow] Status listener failed: ${String(error)}`);
			}
		}
	}

	async generate(prompt: string, options: GenerateWorkflowOptions): Promise<GeneratedWorkflow> {
		const registry = this.getRegistry(options.cwd, options.includeProjectWorkflows);
		const runtime = new ProcessSubagentRuntime({
			cwd: options.cwd,
			includeProjectAgents: options.includeProjectWorkflows,
			parentModel: options.parentModel,
			signal: options.signal,
		});
		const author = runtime.listAgents().find((agent) => agent.name === "workflow-author");
		if (!author) throw new Error("Required workflow-author subagent is not available.");
		if (author.noTools !== true) {
			throw new Error("workflow-author must declare noTools: true before it can generate executable workflows.");
		}
		return generateWorkflowScript(prompt, {
			agentRunner: runtime,
			agents: runtime.listAgents().map((agent) => ({ name: agent.name, description: agent.description })),
			workflowNames: [...registry.definitions.keys()],
			taskNames: getWorkflowTaskExecutors().map((executor) => executor.name),
			signal: options.signal,
		});
	}

	async execute(script: string, options: ExecuteWorkflowOptions): Promise<WorkflowRunResult> {
		const { meta } = parseWorkflowScript(script);
		const status: WorkflowExecutionStatus = {
			id: `workflow.pending.${Date.now()}.${++this.sequence}`,
			name: meta.name,
			state: "running",
			runningNodes: 0,
			completedNodes: 0,
			startedAt: Date.now(),
			logs: [],
			nodes: [],
		};
		this.activeRuns.set(status.id, status);
		const emitStatus = () => {
			options.onStatus?.(cloneStatus(status));
			this.notifyListeners();
		};
		const onAgentEvent = (event: ProgrammaticAgentEvent) => {
			const nodeId = `${status.id}:${event.id}`;
			let node = status.nodes.find((candidate) => candidate.id === nodeId);
			if (!node) {
				node = {
					id: nodeId,
					kind: "agent",
					label: event.label,
					state: "running",
					agentType: event.agentType,
					prompt: event.prompt,
					phase: event.phase,
				};
				status.nodes.push(node);
			}
			if (event.result) node.output = formatAgentOutput(event.result);
			if (event.type === "end") {
				node.state = !event.error && event.result && isResultSuccess(event.result) ? "succeeded" : "failed";
				node.error = event.error ?? event.result?.errorMessage;
			}
			refreshNodeCounts(status);
			emitStatus();
		};
		const onNodeEvent = (event: WorkflowNodeEvent) => {
			if (event.type !== "task_start" && event.type !== "task_end") return;
			let node = status.nodes.find((candidate) => candidate.id === event.id);
			if (!node) {
				node = { id: event.id, kind: "task", label: event.label, state: "running", phase: event.phase };
				status.nodes.push(node);
			}
			if (event.type === "task_end") {
				node.state = event.error ? "failed" : "succeeded";
				node.error = event.error;
				node.output = formatTaskOutput(event.result);
			}
			refreshNodeCounts(status);
			emitStatus();
		};
		const registry = this.getRegistry(options.cwd, options.includeProjectWorkflows);
		const runtime = new ProcessSubagentRuntime({
			cwd: options.cwd,
			includeProjectAgents: options.includeProjectWorkflows,
			parentModel: options.parentModel,
			signal: options.signal,
			onEvent: onAgentEvent,
		});
		emitStatus();

		try {
			const result = await runWorkflow(script, {
				cwd: options.cwd,
				args: options.args,
				agentRunner: runtime,
				taskExecutors: getWorkflowTaskExecutors(),
				loadWorkflow: (name) => registry.definitions.get(name)?.script,
				concurrency: options.concurrency,
				maxAgents: options.maxAgents,
				tokenBudget: options.tokenBudget,
				signal: options.signal,
				onPhase: (title) => {
					status.phase = title;
					emitStatus();
				},
				onLog: (message) => {
					status.logs.push(message);
					emitStatus();
				},
				onNodeEvent,
			});
			status.runId = result.runId;
			status.state = "succeeded";
			status.runningNodes = 0;
			status.finishedAt = Date.now();
			status.agentCount = result.agentCount;
			status.taskCount = result.taskCount;
			status.result = result.result;
			emitStatus();
			return result;
		} catch (error) {
			status.state = "failed";
			status.runningNodes = 0;
			status.finishedAt = Date.now();
			status.error = error instanceof Error ? error.message : String(error);
			emitStatus();
			throw error;
		} finally {
			this.activeRuns.delete(status.id);
			this.lastRun = cloneStatus(status);
			this.notifyListeners();
		}
	}

	private registryKey(cwd: string, includeProjectWorkflows: boolean): string {
		return `${path.resolve(cwd)}\u0000${includeProjectWorkflows ? "trusted" : "untrusted"}`;
	}
}
