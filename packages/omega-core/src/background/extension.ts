import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	Theme,
	ThemeColor,
	ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { formatSize } from "@earendil-works/pi-coding-agent";
import { type KeyId, Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import {
	type BgKillDetails,
	type BgLogsDetails,
	type BgRunDetails,
	type BgStatusDetails,
	type BgTask,
	type BgTaskSnapshot,
	boundedRead,
	DEFAULT_LOG_BYTES,
	deriveCompletionDeliveryGuidance,
	deriveTaskNameFromCommand,
	formatSnapshotList,
	MAX_LOG_BYTES,
	normalizeMaxBytes,
	normalizeTaskName,
	parseBgCommandArgs,
	type StartAttestedPiTaskOptions,
	type StartTaskOptions,
	taskDisplayName,
	truncateChars,
} from "./core/common.ts";
import { type BackgroundTaskExtensionService, installBackgroundTaskExtensionApi } from "./core/extension-api.ts";
import { BackgroundTaskRegistry } from "./core/registry.ts";
import { registerDelegateExtension } from "./delegate-extension.ts";
import { registerFusionExtension } from "./fusion-extension.ts";
import {
	type BackgroundTaskForUi,
	BackgroundTasksManager,
	type TaskManagerResult,
} from "./ui/background-tasks-manager.ts";

/**
 * Project-local Pi background task manager.
 *
 * Scope:
 * - Explicit background shell jobs only: /bg and bg_run spawn commands directly.
 * - No Ctrl+B support for backgrounding an already-running built-in bash tool.
 * - No detached/restart reattachment: live child processes belong to this Pi
 *   extension runtime and are killed on session shutdown/reload.
 */

const STATUS_INTERVAL_MS = 1000;
const COMMAND_PREVIEW_CHARS = 90;
const DISPLAYED_OUTPUT_BYTES = 16 * 1024;
const DISPLAYED_OUTPUT_LINES = 6;
const LIGHT_BLUE_BG = "\x1b[48;2;183;223;255m";
const LIGHT_BLUE_FG = "\x1b[38;2;11;70;110m";
const ANSI_RESET = "\x1b[0m";

function lightBlue(value: string): string {
	return `${LIGHT_BLUE_BG}${LIGHT_BLUE_FG}${value}${ANSI_RESET}`;
}

function textContent(text: string) {
	return [{ type: "text" as const, text }];
}

interface TextToolResult {
	content?: ReadonlyArray<{ type: string; text?: string }>;
}

interface BgToolArgumentRecord {
	readonly command?: unknown;
	readonly name?: unknown;
	readonly description?: unknown;
	readonly isAgent?: unknown;
	readonly timeoutSeconds?: unknown;
	readonly notifyOnCompletion?: unknown;
	readonly triggerOnCompletion?: unknown;
}

interface BgPiAttestedArgumentRecord {
	readonly name?: unknown;
	readonly provider?: unknown;
	readonly model?: unknown;
	readonly prompt?: unknown;
	readonly reportPath?: unknown;
	readonly extraPiArgs?: unknown;
	readonly thinking?: unknown;
	readonly timeoutSeconds?: unknown;
}

function optionalTrimmed(value: string): string | undefined {
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

const BgRunParams = Type.Object({
	name: Type.String({
		description:
			"Short human-readable task name shown in the bg footer dock. Required; use 2-6 words, not the raw command.",
	}),
	command: Type.String({ description: "Shell command to start in the background" }),
	isAgent: Type.Boolean({
		description: "True only for LLM/agent processes; false for ordinary commands.",
	}),
	description: Type.Optional(Type.String({ description: "Optional longer human-readable context for the task" })),
	timeoutSeconds: Type.Optional(
		Type.Number({ description: "Optional timeout; task is failed and killed when exceeded" }),
	),
	notifyOnCompletion: Type.Optional(
		Type.Boolean({
			description:
				"Whether to deliver the durable terminal notification. Default: true; disable only when deliberately taking over completion monitoring.",
		}),
	),
	triggerOnCompletion: Type.Optional(
		Type.Boolean({
			description:
				"Whether that notification should automatically trigger a follow-up agent turn. Default: true for bg_run; requires notifyOnCompletion.",
		}),
	),
});

const BgPiAttestedParams = Type.Object({
	name: Type.String({ description: "Short human-readable name for this attested Pi task." }),
	provider: Type.String({
		description: "Exact Pi provider to launch, for example openai-codex or anthropic.",
	}),
	model: Type.String({ description: "Exact provider-local Pi model id to launch." }),
	prompt: Type.String({ description: "Prompt bytes passed as the single user prompt to Pi." }),
	reportPath: Type.String({
		description: "Relative path, inside the task cwd, that the child Pi run must write as its report.",
	}),
	extraPiArgs: Type.Optional(
		Type.Array(
			Type.String({
				description: "Additional literal Pi argv entries; mode/provider/model/api-key args are rejected.",
			}),
		),
	),
	thinking: Type.Optional(Type.String({ description: "Optional Pi thinking level argument." })),
	timeoutSeconds: Type.Optional(
		Type.Number({ description: "Optional timeout; task is failed and killed when exceeded" }),
	),
});

const BgStatusParams = Type.Object({
	taskId: Type.Optional(
		Type.String({
			description: "Optional task ID or unambiguous prefix. If omitted, all running/recent tasks are returned.",
		}),
	),
});

const BgLogsParams = Type.Object({
	taskId: Type.String({ description: "Task ID or unambiguous prefix" }),
	maxBytes: Type.Optional(
		Type.Number({
			description: `Maximum bytes to return, capped at ${formatSize(MAX_LOG_BYTES)}. Default: ${formatSize(DEFAULT_LOG_BYTES)}.`,
		}),
	),
	tail: Type.Optional(
		Type.Boolean({
			description: "Read the tail of the log when true, head when false. Default: true.",
		}),
	),
});

const BgKillParams = Type.Object({
	taskId: Type.String({ description: "Task ID or unambiguous prefix to stop" }),
});

type BgRunParamsValue = Static<typeof BgRunParams>;
type BgPiAttestedParamsValue = Static<typeof BgPiAttestedParams>;

function renderPlainResult(result: TextToolResult, options: ToolRenderResultOptions, theme: Theme) {
	void options;
	void theme;
	const text = result.content?.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("\n") ?? "";
	return new Text(text, 0, 0);
}

export default function backgroundTasksExtension(pi: ExtensionAPI): void {
	const seenTaskIds = new Set<string>();
	let currentCtx: ExtensionContext | undefined;
	let dockOpen = false;
	let displayedTaskId: string | undefined;
	let displayedOutputRevision = 0;
	let statusInterval: NodeJS.Timeout | undefined;

	const registry = new BackgroundTaskRegistry({
		onChange: () => {
			updateUi();
		},
		sendCompletionNotification: (message, options) => {
			pi.sendMessage(message, options);
		},
		publishTerminal: (task) => {
			eventService.publishTerminal(task);
		},
	});
	const eventService: BackgroundTaskExtensionService = installBackgroundTaskExtensionApi({
		events: pi.events,
		registry,
		getContext: () => currentCtx,
		isShuttingDown: () => registry.isShuttingDown(),
	});

	registerFusionExtension(pi, {
		startManagedTask: async (ctx, options) => {
			currentCtx = ctx;
			return registry.startManagedTask(ctx, options);
		},
		snapshot: (task) => registry.snapshot(task),
		updateManagedTask: (task, state, line) => registry.updateManagedTask(task, state, line),
	});

	registerDelegateExtension(pi, {
		startDelegateTask: async (ctx, options) => {
			currentCtx = ctx;
			return registry.startDelegateTask(ctx, options);
		},
		snapshot: (task) => registry.snapshot(task),
		resolveTask: (idOrPrefix) => registry.resolveTask(idOrPrefix),
		claimFusionUsage: (task) => registry.claimFusionUsage(task),
	});

	function unseenFinishedTasks(): BgTask[] {
		return registry.allTasks().filter((task) => task.status !== "running" && !seenTaskIds.has(task.id));
	}

	function clearFinishedNotices(ctx = currentCtx, taskName?: string): number {
		const normalizedTaskName = normalizeTaskName(taskName);
		const unseen = unseenFinishedTasks().filter(
			(task) => normalizedTaskName === undefined || taskDisplayName(task) === normalizedTaskName,
		);
		for (const task of unseen) seenTaskIds.add(task.id);
		updateUi(ctx);
		return unseen.length;
	}

	function notifyClearFinishedNotices(ctx: ExtensionContext, taskName?: string): void {
		currentCtx = ctx;
		const normalizedTaskName = normalizeTaskName(taskName);
		const cleared = clearFinishedNotices(ctx, normalizedTaskName);
		if (!ctx.hasUI) return;
		ctx.ui.notify(
			cleared > 0
				? normalizedTaskName === undefined
					? `Cleared ${String(cleared)} finished background task notice${cleared === 1 ? "" : "s"}.`
					: `Cleared finished background task notice for ${normalizedTaskName}.`
				: normalizedTaskName === undefined
					? "No finished background task notices to clear."
					: `No finished background task notice found for ${normalizedTaskName}.`,
			cleared > 0 ? "info" : "warning",
		);
	}

	function updateUi(ctx = currentCtx): void {
		if (registry.isShuttingDown() || !ctx) return;
		try {
			if (!ctx.hasUI) return;
			const allTasks = registry.allTasks();
			const running = allTasks.filter((task) => task.status === "running");
			const unseenFailed = allTasks.filter((task) => task.status === "failed" && !seenTaskIds.has(task.id));
			const unseenStopped = allTasks.filter((task) => task.status === "killed" && !seenTaskIds.has(task.id));
			const unseenDone = allTasks.filter((task) => task.status === "completed" && !seenTaskIds.has(task.id));
			const unseenFinishedCount = unseenFailed.length + unseenStopped.length + unseenDone.length;
			const displayedTask = displayedTaskId ? running.find((task) => task.id === displayedTaskId) : undefined;
			if (displayedTaskId && !displayedTask) displayedTaskId = undefined;
			void updateDisplayedOutput(ctx, displayedTask);
			if (running.length === 0 && unseenFinishedCount === 0) {
				ctx.ui.setStatus("background-tasks", undefined);
				return;
			}

			const parts: string[] = [];
			if (running.length > 0) parts.push(`${String(running.length)} running`);
			if (unseenFailed.length > 0) parts.push(`${String(unseenFailed.length)} failed`);
			if (unseenStopped.length > 0) parts.push(`${String(unseenStopped.length)} stopped`);
			if (unseenDone.length > 0) parts.push(`${String(unseenDone.length)} done`);
			const entryHint = dockOpen ? "focused" : `Shift↓${unseenFinishedCount > 0 ? " · /bg:clear" : ""}`;
			const segments = [...parts, entryHint];
			const label = ` bg ${segments.join(" · ")} `;
			ctx.ui.setStatus("background-tasks", lightBlue(label));
		} catch (error) {
			console.error(
				`[background-tasks] UI update failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			currentCtx = undefined;
		}
	}

	async function updateDisplayedOutput(ctx: ExtensionContext, task: BgTask | undefined): Promise<void> {
		const revision = ++displayedOutputRevision;
		if (!task) {
			ctx.ui.setWidget("background-tasks", undefined);
			return;
		}
		try {
			const read = await boundedRead(task.outputAbsPath, DISPLAYED_OUTPUT_BYTES, true);
			if (revision !== displayedOutputRevision || displayedTaskId !== task.id) return;
			const outputLines = read.content.replace(/\r/g, "").split("\n");
			if (outputLines.at(-1) === "") outputLines.pop();
			const visibleLines = outputLines.slice(-DISPLAYED_OUTPUT_LINES);
			ctx.ui.setWidget("background-tasks", [
				lightBlue(` bg output · ${taskDisplayName(task)} · ${task.id} `),
				...(visibleLines.length > 0 ? visibleLines : ["No output yet"]),
			]);
		} catch (error) {
			if (revision !== displayedOutputRevision || displayedTaskId !== task.id) return;
			ctx.ui.setWidget("background-tasks", [
				lightBlue(` bg output · ${taskDisplayName(task)} · ${task.id} `),
				`Output unavailable: ${error instanceof Error ? error.message : String(error)}`,
			]);
		}
	}

	async function startTask(ctx: ExtensionContext, command: string, options: StartTaskOptions = {}): Promise<BgTask> {
		currentCtx = ctx;
		return registry.startTask(ctx, command, options);
	}

	async function startAttestedPiTask(ctx: ExtensionContext, options: StartAttestedPiTaskOptions): Promise<BgTask> {
		currentCtx = ctx;
		return registry.startAttestedPiTask(ctx, options);
	}

	async function openTaskManager(
		ctx: ExtensionCommandContext | ExtensionContext,
		initialTaskId?: string,
	): Promise<void> {
		currentCtx = ctx;
		if (!ctx.hasUI) {
			ctx.ui.notify(
				"Background task manager requires an interactive Pi UI. Use /jobs, /logs, or the bg_status/bg_logs tools in non-interactive mode.",
				"error",
			);
			return;
		}
		dockOpen = true;
		updateUi(ctx);
		try {
			await ctx.ui.custom<TaskManagerResult>(
				(tui, theme, _keybindings, done) => {
					const managerOptions = {
						getTasks: () => registry.allTasks(),
						stopTask: async (task: BackgroundTaskForUi) => {
							await registry.stopTask(registry.resolveTask(task.id), "user");
							updateUi(ctx);
						},
						stopAllRunning: async () => {
							const result = await registry.stopAllRunning("user");
							updateUi(ctx);
							return result;
						},
						rerunTask: async (task: BackgroundTaskForUi) => {
							if (task.fusion !== undefined || task.delegate !== undefined) {
								throw new Error(
									"Only shell-command tasks can be rerun from the dock; relaunch this typed workflow through its owning tool.",
								);
							}
							const rerunOptions: StartTaskOptions = {
								name: taskDisplayName(task),
								isAgent: task.isAgent,
								notifyOnCompletion: true,
								triggerOnCompletion: false,
							};
							if (task.description !== undefined) rerunOptions.description = task.description;
							if (task.timeoutSeconds !== undefined) rerunOptions.timeoutSeconds = task.timeoutSeconds;
							const rerun = await startTask(ctx, task.command, rerunOptions);
							updateUi(ctx);
							return rerun;
						},
						showOutputPath: (task: BackgroundTaskForUi) => {
							ctx.ui.notify(
								`Output path for ${taskDisplayName(task)} (${task.id}):\n${task.outputPath}`,
								"info",
							);
						},
						setDisplayedTask: (task: BackgroundTaskForUi | undefined) => {
							displayedTaskId = task?.id;
							updateUi(ctx);
						},
						isDisplayed: (taskId: string) => displayedTaskId === taskId,
						markSeen: (taskId: string) => {
							seenTaskIds.add(taskId);
							updateUi(ctx);
						},
						markFinishedSeen: (taskIds: string[]) => {
							for (const taskId of taskIds) seenTaskIds.add(taskId);
							updateUi(ctx);
						},
						isSeen: (taskId: string) => seenTaskIds.has(taskId),
					};
					if (initialTaskId)
						return new BackgroundTasksManager(tui, theme, done, {
							...managerOptions,
							initialTaskId,
						});
					return new BackgroundTasksManager(tui, theme, done, managerOptions);
				},
				{
					overlay: true,
					overlayOptions: {
						anchor: "bottom-center",
						width: "96%",
						minWidth: 64,
						maxHeight: "60%",
						margin: { bottom: 1, left: 1, right: 1 },
					},
				},
			);
		} finally {
			dockOpen = false;
			updateUi(ctx);
		}
	}

	pi.registerMessageRenderer<BgTaskSnapshot>("background-task-notification", (message, _options, theme) => {
		const task = message.details;
		const status = task?.status ?? "completed";
		const color: ThemeColor =
			status === "completed"
				? "success"
				: status === "failed"
					? "error"
					: status === "killed"
						? "warning"
						: "accent";
		const id = task?.id ?? "background task";
		const name = task ? taskDisplayName(task) : "Background task";
		const output = task?.outputPath ? `\n${theme.fg("dim", `Output: ${task.outputPath}`)}` : "";
		const error = task?.error ? `\n${theme.fg("error", task.error)}` : "";
		return new Text(
			`${theme.fg(color, `[bg ${status}]`)} ${theme.fg("accent", name)} ${theme.fg("dim", `(${id})`)}${output}${error}`,
			0,
			0,
		);
	});

	pi.on("session_start", async (_event, ctx) => {
		registry.setShuttingDown(false);
		currentCtx = ctx;
		await registry.ensureRuntimeDir(ctx);
		updateUi(ctx);
		if (statusInterval) clearInterval(statusInterval);
		statusInterval = setInterval(() => {
			updateUi();
		}, STATUS_INTERVAL_MS);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		registry.setShuttingDown(true);
		currentCtx = undefined;
		if (statusInterval) {
			clearInterval(statusInterval);
			statusInterval = undefined;
		}
		try {
			const running = registry.allTasks().filter((task) => task.status === "running");
			if (running.length === 0) return;

			const failures: string[] = [];
			await Promise.all(
				running.map(async (task) => {
					try {
						await registry.stopTask(task, "shutdown", "Killed during Pi session shutdown/reload");
					} catch (error) {
						const message = `${task.id}: ${error instanceof Error ? error.message : String(error)}`;
						failures.push(message);
						console.error(`[background-tasks] shutdown cleanup failed for ${message}`);
					}
				}),
			);
			if (failures.length > 0 && ctx.hasUI) {
				ctx.ui.notify(`Background task cleanup failed:\n${failures.join("\n")}`, "error");
			}
		} finally {
			eventService.close();
		}
	});

	pi.registerCommand("bg", {
		description: 'Start a shell command as a tracked background task: /bg [--agent] [--name "Task name"] <command>',
		showSourceTag: false,
		handler: async (args, ctx) => {
			try {
				const parsed = parseBgCommandArgs(args);
				const taskOptions: StartTaskOptions = {
					isAgent: parsed.isAgent,
					notifyOnCompletion: true,
					triggerOnCompletion: false,
				};
				if (parsed.name !== undefined) taskOptions.name = parsed.name;
				const task = await startTask(ctx, parsed.command, taskOptions);
				ctx.ui.notify(
					`Started ${taskDisplayName(task)} (${task.id})\nOutput: ${task.outputPath}\nCommand: ${task.command}`,
					"info",
				);
			} catch (error) {
				ctx.ui.notify(
					`Background task failed to start: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		},
	});

	pi.registerCommand("tasks", {
		description: "Open the Claude-like background task manager UI",
		showSourceTag: false,
		handler: async (args, ctx) => {
			const taskId = optionalTrimmed(args);
			await openTaskManager(ctx, taskId);
		},
	});

	pi.registerCommand("bg:tasks", {
		description: "Open the background task manager UI",
		showSourceTag: false,
		handler: async (args, ctx) => {
			const taskId = optionalTrimmed(args);
			await openTaskManager(ctx, taskId);
		},
	});

	pi.registerCommand("bg:clear", {
		description: "Clear all finished background task footer notices, or one by task name",
		showSourceTag: false,
		getArgumentCompletions: (prefix) => {
			const normalizedPrefix = normalizeTaskName(prefix) ?? "";
			const names = new Set(
				unseenFinishedTasks()
					.map((task) => taskDisplayName(task))
					.filter((name) => name.startsWith(normalizedPrefix)),
			);
			const matches = [...names].slice(0, 20).map((name) => ({ value: name, label: name }));
			return matches.length > 0 ? matches : null;
		},
		handler: (args, ctx) => {
			notifyClearFinishedNotices(ctx, args);
			return Promise.resolve();
		},
	});

	pi.registerShortcut("shift+down" satisfies KeyId, {
		description: "Open focused background task footer dock",
		handler: async (ctx) => {
			await openTaskManager(ctx);
		},
	});

	pi.registerShortcut("ctrl+alt+c" satisfies KeyId, {
		description: "Clear finished background task footer notices (terminal-dependent fallback for /bg:clear)",
		handler: (ctx) => {
			notifyClearFinishedNotices(ctx);
		},
	});

	pi.registerCommand("jobs", {
		description: "List running and recent background tasks",
		showSourceTag: false,
		handler: (_args, ctx) => {
			currentCtx = ctx;
			ctx.ui.notify(formatSnapshotList(registry.allTasks().map((task) => registry.snapshot(task))), "info");
			updateUi(ctx);
			return Promise.resolve();
		},
	});

	pi.registerCommand("logs", {
		description: "Show bounded output from a background task: /logs <id> [maxBytes]",
		showSourceTag: false,
		getArgumentCompletions: (prefix) => {
			const matches = registry
				.allTasks()
				.filter((task) => task.id.startsWith(prefix.trim()))
				.slice(0, 20)
				.map((task) => ({
					value: task.id,
					label: `${task.id} ${taskDisplayName(task)}`,
					description: `${task.status} — ${truncateChars(task.command, 60)}`,
				}));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			try {
				currentCtx = ctx;
				const [id, bytes] = args.trim().split(/\s+/, 2);
				const task = registry.resolveTask(id ?? "");
				const maxBytes = normalizeMaxBytes(Number(bytes), DEFAULT_LOG_BYTES);
				const logs = await registry.getTaskLogs(task, maxBytes, true);
				ctx.ui.notify(logs.text, "info");
			} catch (error) {
				ctx.ui.notify(`Background logs error: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	pi.registerCommand("kill", {
		description: "Stop a running background task: /kill <id>",
		showSourceTag: false,
		getArgumentCompletions: (prefix) => {
			const matches = registry
				.allTasks()
				.filter((task) => task.status === "running" && task.id.startsWith(prefix.trim()))
				.slice(0, 20)
				.map((task) => ({
					value: task.id,
					label: `${task.id} ${taskDisplayName(task)}`,
					description: truncateChars(task.command, 70),
				}));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			try {
				currentCtx = ctx;
				const task = registry.resolveTask(args.trim());
				await registry.stopTask(task, "user");
				ctx.ui.notify(`Killed ${taskDisplayName(task)} (${task.id}). Output: ${task.outputPath}`, "info");
				updateUi(ctx);
			} catch (error) {
				ctx.ui.notify(`Background kill error: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	pi.registerTool<typeof BgRunParams, BgRunDetails>({
		name: "bg_run",
		label: "Background Run",
		description: "Start a named shell command in the background; completion notifies and wakes the agent by default.",
		promptSnippet: "Start a tracked background command",
		promptGuidelines: [
			"Set isAgent true only for LLM/agent processes, false for scripts, tests and servers.",
			"Do not poll or sleep to wait; the default terminal notification starts a follow-up turn.",
		],
		parameters: BgRunParams,
		prepareArguments(args): BgRunParamsValue {
			if (!args || typeof args !== "object") throw new Error("bg_run arguments must be an object");
			const input = args as BgToolArgumentRecord;
			if (typeof input.command !== "string") throw new Error("bg_run requires command string");
			if (typeof input.isAgent !== "boolean") {
				throw new Error(
					"bg_run requires isAgent boolean. Set true only for LLM/agent tasks; set false for scripts, tests, servers, sleeps, and ordinary shell commands.",
				);
			}
			const prepared: BgRunParamsValue = {
				command: input.command,
				name:
					normalizeTaskName(input.name) ??
					normalizeTaskName(input.description) ??
					deriveTaskNameFromCommand(input.command),
				isAgent: input.isAgent,
			};
			if (typeof input.description === "string") prepared.description = input.description;
			if (typeof input.timeoutSeconds === "number") prepared.timeoutSeconds = input.timeoutSeconds;
			if (typeof input.notifyOnCompletion === "boolean") prepared.notifyOnCompletion = input.notifyOnCompletion;
			if (typeof input.triggerOnCompletion === "boolean") prepared.triggerOnCompletion = input.triggerOnCompletion;
			return prepared;
		},
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (typeof params.isAgent !== "boolean") {
				throw new Error(
					"bg_run requires isAgent boolean. Set true only for LLM/agent tasks; set false for scripts, tests, servers, sleeps, and ordinary shell commands.",
				);
			}
			const taskOptions: StartTaskOptions = {
				name: params.name,
				isAgent: params.isAgent,
				notifyOnCompletion: params.notifyOnCompletion ?? true,
				triggerOnCompletion: params.triggerOnCompletion ?? true,
			};
			if (params.description !== undefined) taskOptions.description = params.description;
			if (params.timeoutSeconds !== undefined) taskOptions.timeoutSeconds = params.timeoutSeconds;
			const task = await startTask(ctx, params.command, taskOptions);
			const completionDelivery = deriveCompletionDeliveryGuidance(task.notifyOnCompletion, task.triggerOnCompletion);
			return {
				content: textContent(
					`Started background task ${taskDisplayName(task)} (${task.id})\nStatus: ${task.status}\nPID: ${String(task.pid ?? "unknown")}\nOutput: ${task.outputPath}\n${completionDelivery.text}`,
				),
				details: { task: registry.snapshot(task) },
			};
		},
		renderCall(args, theme) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("bg_run "))}${theme.fg("muted", truncateChars(taskDisplayName(args), COMMAND_PREVIEW_CHARS))}`,
				0,
				0,
			);
		},
		renderResult(result, _options, theme) {
			const { task } = result.details;
			return new Text(
				`${theme.fg("success", "✓ started")} ${theme.fg("accent", taskDisplayName(task))} ${theme.fg("dim", `(${task.id})`)}\n${theme.fg("dim", `Output: ${task.outputPath}`)}`,
				0,
				0,
			);
		},
	});

	pi.registerTool<typeof BgPiAttestedParams, BgRunDetails>({
		name: "bg_run_pi_attested",
		label: "Attested Pi Run",
		description: "Launch one attested Pi child and record verified run evidence.",
		promptSnippet: "Start an attested Pi task",
		promptGuidelines: [
			"Use only for explicitly requested attested evidence; otherwise use bg_run.",
			"Provide provider, model and a relative reportPath; the producer attests the run.",
		],
		parameters: BgPiAttestedParams,
		prepareArguments(args): BgPiAttestedParamsValue {
			if (!args || typeof args !== "object") throw new Error("bg_run_pi_attested arguments must be an object");
			const input = args as BgPiAttestedArgumentRecord;
			if (typeof input.name !== "string") throw new Error("bg_run_pi_attested requires name");
			if (typeof input.provider !== "string") throw new Error("bg_run_pi_attested requires provider");
			if (typeof input.model !== "string") throw new Error("bg_run_pi_attested requires model");
			if (typeof input.prompt !== "string") throw new Error("bg_run_pi_attested requires prompt");
			if (typeof input.reportPath !== "string") throw new Error("bg_run_pi_attested requires reportPath");
			const prepared: BgPiAttestedParamsValue = {
				name: input.name,
				provider: input.provider,
				model: input.model,
				prompt: input.prompt,
				reportPath: input.reportPath,
			};
			if (Array.isArray(input.extraPiArgs)) {
				if (!input.extraPiArgs.every((entry) => typeof entry === "string"))
					throw new Error("bg_run_pi_attested extraPiArgs entries must be strings");
				prepared.extraPiArgs = input.extraPiArgs;
			}
			if (typeof input.thinking === "string") prepared.thinking = input.thinking;
			if (typeof input.timeoutSeconds === "number") prepared.timeoutSeconds = input.timeoutSeconds;
			return prepared;
		},
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const task = await startAttestedPiTask(ctx, params);
			return {
				content: textContent(
					`Started attested Pi task ${taskDisplayName(task)} (${task.id})\nStatus: ${task.status}\nPID: ${String(task.pid ?? "unknown")}\nOutput: ${task.outputPath}\nAttestation: ${task.attestationPath ?? "pending until completion"}`,
				),
				details: { task: registry.snapshot(task) },
			};
		},
		renderCall(args, theme) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("bg_run_pi_attested "))}${theme.fg("muted", truncateChars(args.name, COMMAND_PREVIEW_CHARS))}`,
				0,
				0,
			);
		},
		renderResult(result, _options, theme) {
			const { task } = result.details;
			return new Text(
				`${theme.fg("success", "✓ started")} ${theme.fg("accent", taskDisplayName(task))} ${theme.fg("dim", `(${task.id})`)}\n${theme.fg("dim", `Output: ${task.outputPath}`)}\n${theme.fg("dim", `Attestation: ${task.attestationPath ?? "pending"}`)}`,
				0,
				0,
			);
		},
	});

	pi.registerTool<typeof BgStatusParams, BgStatusDetails>({
		name: "bg_status",
		label: "Background Status",
		description: "Inspect current status for one or all background tasks.",
		promptSnippet: "Inspect background task status",
		promptGuidelines: ["Do not poll; terminal notifications need no status reconfirmation."],
		parameters: BgStatusParams,
		execute(_toolCallId, params) {
			const selected = params.taskId ? [registry.resolveTask(params.taskId)] : registry.allTasks();
			const snapshots = selected.map((task) => registry.snapshot(task));
			return Promise.resolve({
				content: textContent(formatSnapshotList(snapshots)),
				details: { tasks: snapshots },
			});
		},
		renderCall(args, theme) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("bg_status"))}${args.taskId ? ` ${theme.fg("accent", args.taskId)}` : ""}`,
				0,
				0,
			);
		},
		renderResult: renderPlainResult,
	});

	pi.registerTool<typeof BgLogsParams, BgLogsDetails>({
		name: "bg_logs",
		label: "Background Logs",
		description: `Read up to ${formatSize(MAX_LOG_BYTES)} of a background task's output.`,
		promptSnippet: "Read bounded background output",
		promptGuidelines: ["Read logs only when output is needed; do not poll to wait."],
		parameters: BgLogsParams,
		async execute(_toolCallId, params) {
			const task = registry.resolveTask(params.taskId);
			const logs = await registry.getTaskLogs(task, normalizeMaxBytes(params.maxBytes), params.tail ?? true);
			return {
				content: textContent(logs.text),
				details: logs.details,
			};
		},
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("bg_logs "))}${theme.fg("accent", args.taskId)}`, 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			const details = result.details;
			let text = `${theme.fg("accent", taskDisplayName(details.task))} ${theme.fg("dim", `(${details.task.id})`)} ${theme.fg("muted", details.tail ? "tail" : "head")} ${formatSize(details.bytesRead)}`;
			if (details.truncated) text += theme.fg("warning", " (truncated)");
			text += `\n${theme.fg("dim", `Full output: ${details.path}`)}`;
			if (expanded) {
				const output = result.content
					.map((content) => (content.type === "text" ? content.text : "[image content]"))
					.join("\n");
				text += `\n${theme.fg("toolOutput", output.split("\n").slice(0, 30).join("\n"))}`;
			}
			return new Text(text, 0, 0);
		},
	});

	pi.registerTool<typeof BgKillParams, BgKillDetails>({
		name: "bg_kill",
		label: "Background Kill",
		description: "Stop a running background task by ID. Fails loudly if the task is unknown or already finished.",
		promptSnippet: "Stop a running background task by ID",
		promptGuidelines: [
			"Use bg_kill when the user asks to stop a background task or when a bg_run command is no longer needed.",
		],
		parameters: BgKillParams,
		async execute(_toolCallId, params) {
			const task = registry.resolveTask(params.taskId);
			await registry.stopTask(task, "user");
			const message = `Killed background task ${taskDisplayName(task)} (${task.id}). Output: ${task.outputPath}`;
			return {
				content: textContent(message),
				details: { task: registry.snapshot(task), message },
			};
		},
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("bg_kill "))}${theme.fg("accent", args.taskId)}`, 0, 0);
		},
		renderResult(result, _options, theme) {
			const { task } = result.details;
			return new Text(
				`${theme.fg("warning", "■ killed")} ${theme.fg("accent", taskDisplayName(task))} ${theme.fg("dim", `(${task.id})`)}\n${theme.fg("dim", `Output: ${task.outputPath}`)}`,
				0,
				0,
			);
		},
	});
}
