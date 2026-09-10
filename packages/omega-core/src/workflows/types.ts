import type { TSchema } from "typebox";
import type { ProgrammaticAgentOptions } from "../subagents/runtime.ts";

export interface WorkflowMetaPhase {
	title: string;
	detail?: string;
}

export interface WorkflowPermissions {
	network?: boolean;
	write?: boolean;
	destructive?: boolean;
}

export interface WorkflowMeta {
	name: string;
	description: string;
	whenToUse?: string;
	phases?: WorkflowMetaPhase[];
	permissions?: WorkflowPermissions;
}

export interface WorkflowAgentOptions extends ProgrammaticAgentOptions {
	phase?: string;
	onError?: "throw" | "continue";
}

export interface WorkflowTaskOptions {
	label: string;
	phase?: string;
	timeoutMs?: number;
	onError?: "throw" | "continue";
}

export interface WorkflowTaskContext {
	cwd: string;
	args: unknown;
	meta: WorkflowMeta;
	signal?: AbortSignal;
}

export interface WorkflowTaskExecutor {
	name: string;
	run(input: unknown, context: WorkflowTaskContext): Promise<unknown>;
}

export interface WorkflowAgentRunner {
	run(prompt: string, options?: WorkflowAgentOptions): Promise<unknown>;
}

export interface VerificationResult {
	verdict: "confirmed" | "rejected" | "needs_more_evidence";
	confidence: "high" | "medium" | "low";
	summary: string;
	evidenceChecks: Array<{
		claim: string;
		status: "verified" | "contradicted" | "unverified";
		reason: string;
	}>;
	contradictions: string[];
	missingEvidence: string[];
	retryPrompt?: string;
}

export interface VerifyOptions {
	label: string;
	agentType?: string;
	task: string;
	rubric?: string[];
	model?: string;
	timeoutMs?: number;
}

export interface ExecuteAndVerifyOptions {
	executor: WorkflowAgentOptions & { label: string };
	verifier: VerifyOptions;
	executePhase?: string;
	verifyPhase?: string;
	maxAttempts?: number;
	onRejected?: "return" | "throw";
	onUncertain?: "return" | "retry" | "throw";
}

export interface ExecuteAndVerifyResult {
	ok: boolean;
	candidate: unknown;
	verification: VerificationResult;
	attempts: number;
}

export interface WorkflowNodeEvent {
	type: "agent_start" | "agent_end" | "task_start" | "task_end";
	id: string;
	label: string;
	phase?: string;
	result?: unknown;
	error?: string;
}

export interface WorkflowRunOptions {
	cwd: string;
	args?: unknown;
	agentRunner: WorkflowAgentRunner;
	taskExecutors?: readonly WorkflowTaskExecutor[];
	loadWorkflow?: (name: string) => string | undefined;
	concurrency?: number;
	maxAgents?: number;
	maxDepth?: number;
	tokenBudget?: number | null;
	signal?: AbortSignal;
	onLog?: (message: string) => void;
	onPhase?: (title: string) => void;
	onNodeEvent?: (event: WorkflowNodeEvent) => void;
	internal?: WorkflowInternalOptions;
}

export interface WorkflowRunResult<T = unknown> {
	meta: WorkflowMeta;
	result: T;
	logs: string[];
	phases: string[];
	agentCount: number;
	taskCount: number;
	durationMs: number;
	runId: string;
}

export interface ParsedWorkflow {
	meta: WorkflowMeta;
	body: string;
}

export interface WorkflowInternalOptions {
	shared: WorkflowSharedRuntime;
	depth: number;
	workflowStack: string[];
}

export interface WorkflowSharedRuntime {
	runId: string;
	limiter: <T>(operation: () => Promise<T>) => Promise<T>;
	pending: Set<Promise<unknown>>;
	agentCount: number;
	taskCount: number;
	spent: number;
	nodeSequence: number;
}

export type WorkflowSchema = TSchema;
