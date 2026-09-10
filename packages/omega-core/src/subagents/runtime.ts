/** Programmatic process-backed subagent runtime shared by workflow callers. */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";
import { Check } from "typebox/value";
import { type AgentConfig, discoverAgents } from "./agents.ts";
import { type ParentModel, runAgent } from "./runner.ts";
import { getFinalOutput, isResultSuccess, type SingleResult, type SubagentDetails } from "./types.ts";

const DEFAULT_MAX_DEPTH = 3;
const DEPTH_ENV = "OMEGA_SUBAGENT_DEPTH";
const MAX_DEPTH_ENV = "OMEGA_SUBAGENT_MAX_DEPTH";
const STACK_ENV = "OMEGA_SUBAGENT_STACK";
const PREVENT_CYCLES_ENV = "OMEGA_SUBAGENT_PREVENT_CYCLES";

export interface ProgrammaticAgentOptions {
	label?: string;
	agentType?: string;
	phase?: string;
	model?: string;
	schema?: TSchema;
	cwd?: string;
	timeoutMs?: number;
	retries?: number;
	signal?: AbortSignal;
	/** @internal Workflow ancestry propagated across the Omega process boundary. */
	workflowStack?: string[];
}

export interface ProgrammaticAgentEvent {
	type: "start" | "update" | "end";
	id: string;
	label: string;
	agentType: string;
	prompt: string;
	phase?: string;
	result?: SingleResult;
	error?: string;
}

export interface ProcessSubagentRuntimeOptions {
	cwd: string;
	includeProjectAgents: boolean;
	parentModel?: ParentModel;
	defaultAgentType?: string;
	signal?: AbortSignal;
	onEvent?: (event: ProgrammaticAgentEvent) => void;
}

export class SubagentExecutionError extends Error {
	readonly code: "DEPTH_EXCEEDED" | "CYCLE_DETECTED" | "EXECUTION_FAILED" | "SCHEMA_INVALID";
	readonly result?: SingleResult;

	constructor(code: SubagentExecutionError["code"], message: string, result?: SingleResult) {
		super(message);
		this.name = "SubagentExecutionError";
		this.code = code;
		this.result = result;
	}
}

function parseNonNegativeInteger(raw: string | undefined, fallback: number): number {
	if (raw !== undefined && /^\d+$/.test(raw.trim())) {
		const value = Number(raw);
		if (Number.isSafeInteger(value)) return value;
	}
	return fallback;
}

function parseStack(raw: string | undefined): string[] {
	if (!raw) return [];
	try {
		const value: unknown = JSON.parse(raw);
		if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
	} catch {
		// Invalid inherited state is treated as an empty stack, matching the tool adapter.
	}
	return [];
}

function parsePreventCycles(raw: string | undefined): boolean {
	if (raw === undefined) return true;
	return !["0", "false", "no", "off"].includes(raw.trim().toLowerCase());
}

function errorText(result: SingleResult): string {
	return result.errorMessage?.trim() || result.stderr.trim() || `Subagent ${result.agent} failed.`;
}

export class ProcessSubagentRuntime {
	private readonly agents: AgentConfig[];
	private readonly projectAgentsDir: string | null;
	private readonly cwd: string;
	private readonly parentModel?: ParentModel;
	private readonly defaultAgentType: string;
	private readonly signal?: AbortSignal;
	private readonly onEvent?: (event: ProgrammaticAgentEvent) => void;
	private readonly parentDepth: number;
	private readonly maxDepth: number;
	private readonly parentAgentStack: string[];
	private readonly preventCycles: boolean;
	private callIndex = 0;

	constructor(options: ProcessSubagentRuntimeOptions) {
		const discovery = discoverAgents(options.cwd, "both", options.includeProjectAgents);
		this.agents = discovery.agents;
		this.projectAgentsDir = discovery.projectAgentsDir;
		this.cwd = options.cwd;
		this.parentModel = options.parentModel;
		this.defaultAgentType = options.defaultAgentType ?? "security-worker";
		this.signal = options.signal;
		this.onEvent = options.onEvent;
		this.parentDepth = parseNonNegativeInteger(process.env[DEPTH_ENV], 0);
		this.maxDepth = parseNonNegativeInteger(process.env[MAX_DEPTH_ENV], DEFAULT_MAX_DEPTH);
		this.parentAgentStack = parseStack(process.env[STACK_ENV]);
		this.preventCycles = parsePreventCycles(process.env[PREVENT_CYCLES_ENV]);
	}

	listAgents(): readonly AgentConfig[] {
		return this.agents;
	}

	async run(prompt: string, options: ProgrammaticAgentOptions = {}): Promise<unknown> {
		const agentType = options.agentType?.trim() || this.defaultAgentType;
		const label = options.label?.trim() || agentType;
		if (this.parentDepth >= this.maxDepth) {
			throw new SubagentExecutionError(
				"DEPTH_EXCEEDED",
				`Subagent delegation depth ${this.parentDepth}/${this.maxDepth} is exhausted.`,
			);
		}
		if (this.preventCycles && this.parentAgentStack.includes(agentType)) {
			throw new SubagentExecutionError(
				"CYCLE_DETECTED",
				`Subagent cycle detected for ${agentType}: ${[...this.parentAgentStack, agentType].join(" -> ")}.`,
			);
		}

		const effectivePrompt = options.schema
			? [
					prompt,
					"Final output contract:",
					"- Call structured_output as your final action.",
					"- Its arguments are the return value consumed by the workflow.",
					"- Do not return prose instead of calling structured_output.",
				].join("\n\n")
			: prompt;
		const callIndex = this.callIndex++;
		const id = `subagent.${callIndex + 1}`;
		this.onEvent?.({ type: "start", id, label, agentType, prompt, phase: options.phase });
		let result: SingleResult;
		try {
			result = await runAgent({
				cwd: this.cwd,
				agents: this.agents,
				callIndex,
				agentName: agentType,
				prompt: effectivePrompt,
				callModel: options.model,
				parentModel: this.parentModel,
				callCwd: options.cwd,
				initialContext: "empty",
				parentDepth: this.parentDepth,
				parentAgentStack: this.parentAgentStack,
				maxDepth: this.maxDepth,
				preventCycles: this.preventCycles,
				timeoutMs: options.timeoutMs,
				structuredOutputSchema: options.schema,
				workflowStack: options.workflowStack,
				signal: options.signal ?? this.signal,
				onUpdate: (partial: AgentToolResult<SubagentDetails>) => {
					const update = partial.details.results[0];
					if (update)
						this.onEvent?.({
							type: "update",
							id,
							label,
							agentType,
							prompt,
							phase: options.phase,
							result: update,
						});
				},
				makeDetails: (results) => ({
					kind: "omega-subagent",
					projectAgentsDir: this.projectAgentsDir,
					results,
				}),
			});
		} catch (error) {
			this.onEvent?.({
				type: "end",
				id,
				label,
				agentType,
				prompt,
				phase: options.phase,
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
		this.onEvent?.({ type: "end", id, label, agentType, prompt, phase: options.phase, result });

		if (!isResultSuccess(result)) {
			throw new SubagentExecutionError("EXECUTION_FAILED", errorText(result), result);
		}
		if (options.schema) {
			if (result.structuredOutput === undefined || !Check(options.schema, result.structuredOutput)) {
				throw new SubagentExecutionError(
					"SCHEMA_INVALID",
					`Subagent ${agentType} did not return output matching the requested schema.`,
					result,
				);
			}
			return result.structuredOutput;
		}
		return getFinalOutput(result.messages);
	}
}
