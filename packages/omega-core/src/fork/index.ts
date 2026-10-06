/**
 * Omega Fork
 *
 * Provides the /fork:task command and fork tool for isolated task execution.
 * The built-in /fork command remains available for persistent session branching.
 *
 * The child process receives a temporary JSONL snapshot of the current active
 * session branch, then a final user message containing fork-worker instructions
 * and the requested task. It does not modify the system prompt.
 */

import { Type } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { OmegaAPI } from "../api.ts";
import { registerOmegaCommand } from "../commands/register.ts";
import { EFFORT_LEVELS, type ForkConfig, loadConfig } from "./config.ts";
import { aggregateInclusiveCost, formatForkCostStatus } from "./cost.ts";
import { renderForkCall, renderForkResult } from "./render.ts";
import { runFork } from "./runner.ts";
import { getResultSummaryText } from "./runner-events.js";
import {
	emptyUsage,
	type ForkDetails,
	type ForkEffort,
	type ForkEffortSource,
	type ForkEffortState,
	type ForkResult,
	isResultError,
} from "./types.ts";

const ForkParams = Type.Object({
	task: Type.String({
		description:
			"The task for the fork to complete. Specify what to do and where the fork's decision authority ends — it will surface ambiguities back to you rather than resolve them on your behalf. The fork already knows to return dense, concrete output with snippets and relationships; you only need to call out anything task-specific about the return shape.",
	}),
	effort: Type.Optional(
		Type.Unsafe<ForkEffort>({
			type: "string",
			enum: [...EFFORT_LEVELS],
			description:
				"Optional reasoning depth for the fork. Use the lowest effort that can reliably handle the task: fast for quick lookups, simple checks, mechanical edits, or narrow validation; balanced for normal exploration, implementation, and testing; deep for ambiguous debugging, architecture/design decisions, security or concurrency analysis, high-risk reviews, or tasks where subtle mistakes are costly. If unsure, choose balanced.",
		}),
	),
});

interface SessionSnapshotSource {
	getHeader: () => unknown;
	getBranch: () => unknown[];
}

function buildForkSessionSnapshotJsonl(sessionManager: SessionSnapshotSource): string | null {
	const header = sessionManager.getHeader();
	if (!header || typeof header !== "object") return null;

	const branchEntries = sessionManager.getBranch();
	const lines = [JSON.stringify(header)];
	for (const entry of branchEntries) lines.push(JSON.stringify(entry));
	return `${lines.join("\n")}\n`;
}

function makeDetails(results: ForkResult[]): ForkDetails {
	return { results };
}

function resolveEffortState(requestedEffort: unknown, config: ForkConfig): ForkEffortState | undefined {
	const selected = EFFORT_LEVELS.includes(requestedEffort as ForkEffort)
		? (requestedEffort as ForkEffort)
		: config.defaultEffort;
	if (!selected) return undefined;

	const source: ForkEffortSource = requestedEffort === selected ? "tool" : "default";
	const profile = config.effortProfiles?.[selected];
	if (profile) return { selected, source, profile };

	const label = source === "tool" ? "Requested" : "Default";
	return {
		selected,
		source,
		warning: `${label} effort "${selected}" has no configured profile; using child Pi defaults.`,
	};
}

function formatResultContent(result: ForkResult, isError: boolean): string {
	const warning = result.effort?.warning ? `Fork warning: ${result.effort.warning}\n\n` : "";
	const summary = getResultSummaryText(result);
	if (isError) return `${warning}Fork ${result.stopReason || "failed"}: ${summary}`;
	return `${warning}${summary}`;
}

export function resolveModelContextWindow(
	modelRegistry: ExtensionContext["modelRegistry"],
	provider?: string,
	model?: string,
): number | undefined {
	const trimmedProvider = provider?.trim();
	const trimmedModel = model?.trim();
	if (!trimmedModel) return undefined;

	const attempts: Array<[string, string]> = [];
	if (trimmedProvider) {
		attempts.push([trimmedProvider, trimmedModel]);
		if (trimmedModel.startsWith(`${trimmedProvider}/`)) {
			attempts.push([trimmedProvider, trimmedModel.slice(trimmedProvider.length + 1)]);
		}
	} else {
		const slashIndex = trimmedModel.indexOf("/");
		if (slashIndex > 0 && slashIndex < trimmedModel.length - 1) {
			attempts.push([trimmedModel.slice(0, slashIndex), trimmedModel.slice(slashIndex + 1)]);
		}
	}

	for (const [attemptProvider, attemptModel] of attempts) {
		const found = modelRegistry.find(attemptProvider, attemptModel);
		const contextWindow = found?.contextWindow;
		if (typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0) {
			return contextWindow;
		}
	}

	return undefined;
}

function emptyFailedResult(task: string, message: string): ForkResult {
	return {
		task,
		exitCode: 1,
		messages: [],
		stderr: message,
		usage: emptyUsage(),
		stopReason: "error",
		errorMessage: message,
	};
}

const FORK_COST_STATUS_KEY = "fork-cost";

function updateForkCostStatus(ctx: ExtensionContext): void {
	if (!loadConfig(ctx.cwd).costFooter) {
		ctx.ui.setStatus(FORK_COST_STATUS_KEY, undefined);
		return;
	}

	const stats = aggregateInclusiveCost(ctx.sessionManager.getEntries());
	const status = formatForkCostStatus(stats);
	ctx.ui.setStatus(FORK_COST_STATUS_KEY, status ? ctx.ui.theme.fg("dim", status) : undefined);
}

async function executeFork(
	task: string,
	ctx: ExtensionContext,
	signal?: AbortSignal,
	onUpdate?: Parameters<typeof runFork>[0]["onUpdate"],
	requestedEffort?: ForkEffort,
): Promise<ForkResult> {
	const config = loadConfig(ctx.cwd);
	const effort = resolveEffortState(requestedEffort, config);
	const snapshot = buildForkSessionSnapshotJsonl(ctx.sessionManager);
	if (!snapshot) {
		const result = emptyFailedResult(task, "Cannot fork: failed to snapshot current session context.");
		if (effort) result.effort = effort;
		return result;
	}

	return runFork({
		cwd: ctx.cwd,
		task,
		forkSessionSnapshotJsonl: snapshot,
		extensions: config.extensions,
		environment: config.environment,
		offline: config.offline,
		signal,
		onUpdate,
		makeDetails,
		effort,
		resolveContextWindow: (provider, model) => resolveModelContextWindow(ctx.modelRegistry, provider, model),
	});
}

async function resolveCommandTask(args: string, ctx: ExtensionCommandContext): Promise<string | undefined> {
	const task = args.trim();
	if (task) return task;
	if (!ctx.hasUI) {
		ctx.ui.notify("Usage: /fork:task <task>", "warning");
		return undefined;
	}
	return (await ctx.ui.input("Fork task", "Describe the focused task"))?.trim() || undefined;
}

export function registerFork(omega: OmegaAPI): void {
	omega.on("session_start", async (_event, ctx) => {
		updateForkCostStatus(ctx);
	});

	omega.on("turn_end", async (_event, ctx) => {
		updateForkCostStatus(ctx);
	});

	omega.on("session_tree", async (_event, ctx) => {
		updateForkCostStatus(ctx);
	});

	omega.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setStatus(FORK_COST_STATUS_KEY, undefined);
	});

	registerOmegaCommand(omega, "fork:task", {
		description: "Run a focused task in a separate Omega subprocess",
		handler: async (args, ctx) => {
			const task = await resolveCommandTask(args, ctx);
			if (!task) return;

			ctx.ui.setStatus(FORK_COST_STATUS_KEY, ctx.ui.theme.fg("dim", "fork running"));
			try {
				const result = await executeFork(task, ctx, ctx.signal, (update) => {
					const current = update.details.results[0];
					const turns = current?.usage.turns ?? 0;
					ctx.ui.setStatus(FORK_COST_STATUS_KEY, ctx.ui.theme.fg("dim", `fork running · ${turns} turns`));
				});
				const isError = isResultError(result);
				omega.sendMessage(
					{
						customType: "omega-fork-result",
						content: formatResultContent(result, isError),
						display: true,
						details: makeDetails([result]),
					},
					{ triggerTurn: false },
				);
				if (isError) ctx.ui.notify("Fork failed", "error");
			} finally {
				updateForkCostStatus(ctx);
			}
		},
	});

	omega.registerTool({
		name: "fork",
		label: "Fork",
		description:
			"Spawn a fork of yourself to handle a focused task independently. Use it to offload context-heavy work such as exploration, implementation, testing, review, or option analysis. Forks return dense, concrete findings and can be assigned an effort level matching the task's required reasoning depth.",
		parameters: ForkParams,
		renderCall: renderForkCall,
		renderResult: renderForkResult,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const result = await executeFork(params.task, ctx, signal, onUpdate, params.effort);

			if (isResultError(result)) {
				return {
					content: [
						{
							type: "text" as const,
							text: formatResultContent(result, true),
						},
					],
					details: makeDetails([result]),
					isError: true,
				};
			}

			return {
				content: [{ type: "text" as const, text: formatResultContent(result, false) }],
				details: makeDetails([result]),
			};
		},
	});
}
