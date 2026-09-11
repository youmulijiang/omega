import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { OmegaAPI } from "../api.ts";
import { registerOmegaCommand } from "../commands/register.ts";
import { updateTodoUI } from "./render.ts";
import { applyTodoMutation, cloneTodoState, createTodoState, isTodoState } from "./state.ts";
import { type TodoAction, type TodoDetails, type TodoItem, TodoParams, type TodoState } from "./types.ts";

const TODO_STATE_ENTRY = "omega-todo-state";
export const TODO_TOGGLE_SHORTCUT = "alt+o";
export const TODO_CONTINUE_CURRENT = "Continue current todo";
export const TODO_START_NEW = "Start a new todo";
const states = new Map<string, TodoState>();
const hiddenPanels = new Set<string>();
const replacementHandlers = new WeakMap<OmegaAPI, Set<(ctx: ExtensionContext) => void>>();

function sessionId(ctx: ExtensionContext): string {
	return ctx.sessionManager.getSessionId();
}

function getState(ctx: ExtensionContext): TodoState {
	return states.get(sessionId(ctx)) ?? createTodoState();
}

function setState(ctx: ExtensionContext, state: TodoState): void {
	states.set(sessionId(ctx), cloneTodoState(state));
}

function renderState(ctx: ExtensionContext, state: TodoState): void {
	updateTodoUI(ctx, state, !hiddenPanels.has(sessionId(ctx)));
}

function togglePanel(ctx: ExtensionContext): void {
	const id = sessionId(ctx);
	const hidden = hiddenPanels.has(id);
	if (hidden) hiddenPanels.delete(id);
	else hiddenPanels.add(id);
	renderState(ctx, getState(ctx));
	ctx.ui.notify(`Todo panel ${hidden ? "shown" : "hidden"}.`, "info");
}

function restoreState(ctx: ExtensionContext): TodoState {
	let restored = createTodoState();
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "custom" && entry.customType === TODO_STATE_ENTRY && isTodoState(entry.data)) {
			restored = cloneTodoState(entry.data);
			continue;
		}
		if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "todo")
			continue;
		const details = entry.message.details as TodoDetails | undefined;
		if (details && isTodoState(details)) restored = cloneTodoState(details);
	}
	setState(ctx, restored);
	return restored;
}

function commitState(omega: OmegaAPI, ctx: ExtensionContext, state: TodoState): void {
	setState(ctx, state);
	omega.appendEntry(TODO_STATE_ENTRY, cloneTodoState(state));
	renderState(ctx, state);
}

function details(action: TodoAction, state: TodoState, error?: string): TodoDetails {
	return { action, ...cloneTodoState(state), ...(error ? { error } : {}) };
}

function notifyTodoReplacement(omega: OmegaAPI, ctx: ExtensionContext): void {
	for (const handler of replacementHandlers.get(omega) ?? []) handler(ctx);
}

export type TodoTaskSwitchDecision =
	| { kind: "start_new" }
	| { kind: "continue_current"; subject: string }
	| { kind: "cancel" }
	| { kind: "unavailable" };

export function todoContinuationPrompt(subject: string): string {
	return `Continue the current todo before starting another task. Current todo: ${subject}`;
}

export async function resolveTodoTaskSwitch(omega: OmegaAPI, ctx: ExtensionContext): Promise<TodoTaskSwitchDecision> {
	const state = getState(ctx);
	const visible = state.tasks.filter((task) => task.status !== "deleted");
	if (visible.length === 0) return { kind: "start_new" };
	const unfinished = visible.filter((task) => task.status !== "completed");
	if (unfinished.length === 0) {
		notifyTodoReplacement(omega, ctx);
		commitState(omega, ctx, createTodoState());
		return { kind: "start_new" };
	}
	if (!ctx.hasUI) return { kind: "unavailable" };

	const current = unfinished.find((task) => task.status === "in_progress") ?? unfinished[0];
	const choice = await ctx.ui.select(`Current todo: ${current.subject}`, [TODO_CONTINUE_CURRENT, TODO_START_NEW]);
	if (choice === TODO_START_NEW) {
		notifyTodoReplacement(omega, ctx);
		commitState(omega, ctx, createTodoState());
		return { kind: "start_new" };
	}
	if (choice === TODO_CONTINUE_CURRENT) return { kind: "continue_current", subject: current.subject };
	ctx.ui.notify("Task switch cancelled; current todo was kept.", "info");
	return { kind: "cancel" };
}

export function onTodoReplacement(omega: OmegaAPI, handler: (ctx: ExtensionContext) => void): void {
	let handlers = replacementHandlers.get(omega);
	if (!handlers) {
		handlers = new Set();
		replacementHandlers.set(omega, handlers);
	}
	handlers.add(handler);
}

export interface PlanTodoStep {
	step: number;
	text: string;
	completed: boolean;
}

export function replaceTodosFromPlan(omega: OmegaAPI, ctx: ExtensionContext, steps: PlanTodoStep[]): void {
	const tasks: TodoItem[] = steps.map((step) => ({
		id: step.step,
		subject: step.text,
		status: step.completed ? "completed" : "pending",
		planStep: step.step,
	}));
	const nextId = Math.max(0, ...tasks.map((task) => task.id)) + 1;
	commitState(omega, ctx, { tasks, nextId });
}

export function syncTodosWithPlan(
	omega: OmegaAPI,
	ctx: ExtensionContext,
	steps: PlanTodoStep[],
	executing: boolean,
): void {
	if (steps.length === 0) {
		replaceTodosFromPlan(omega, ctx, steps);
		return;
	}
	const state = cloneTodoState(getState(ctx));
	const planTasks = state.tasks.filter((task) => task.planStep !== undefined && task.status !== "deleted");
	if (planTasks.length === 0) {
		replaceTodosFromPlan(omega, ctx, steps);
		if (executing) syncTodosWithPlan(omega, ctx, steps, true);
		return;
	}
	const nextStep = steps.find((step) => !step.completed)?.step;
	for (const task of state.tasks) {
		if (executing && task.planStep === undefined && task.status === "in_progress") task.status = "pending";
	}
	for (const task of planTasks) {
		const step = steps.find((candidate) => candidate.step === task.planStep);
		if (!step) continue;
		task.subject = step.text;
		task.status = step.completed ? "completed" : executing && task.planStep === nextStep ? "in_progress" : "pending";
	}
	commitState(omega, ctx, state);
}

export function applyTodoCompletionToPlan(ctx: ExtensionContext, steps: PlanTodoStep[]): number {
	const state = getState(ctx);
	let completed = 0;
	for (const step of steps) {
		const task = state.tasks.find(
			(candidate) => candidate.planStep === step.step && candidate.status === "completed",
		);
		if (task && !step.completed) {
			step.completed = true;
			completed++;
		}
	}
	return completed;
}

export function registerTodo(omega: OmegaAPI): void {
	omega.registerTool({
		name: "todo",
		label: "Todo",
		description:
			"Create and track execution tasks in the visible todo panel. Use create for steps, update to set pending/in_progress/completed, list to inspect, delete to remove one, and clear to reset the list.",
		promptSnippet: "Create and update a visible task list for multi-step execution tracking",
		promptGuidelines: [
			"Use todo for work with multiple concrete steps. Mark exactly one task in_progress before doing it, and mark it completed immediately after verification.",
			"Do not mark incomplete or failing work completed. Keep concise imperative subjects and use activeForm for the current activity.",
		],
		parameters: TodoParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			signal?.throwIfAborted();
			const result = applyTodoMutation(getState(ctx), params.action, params);
			if (!result.error && params.action !== "list") commitState(omega, ctx, result.state);
			const state = result.error ? getState(ctx) : result.state;
			return {
				content: [{ type: "text", text: result.message }],
				details: details(params.action, state, result.error),
			};
		},
		renderCall(args, theme) {
			const suffix = args.id !== undefined ? ` #${args.id}` : args.subject ? ` ${args.subject}` : "";
			return new Text(
				theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", `${args.action}${suffix}`),
				0,
				0,
			);
		},
		renderResult(result, _options, theme) {
			const item = result.content.find((content) => content.type === "text");
			const message = item?.type === "text" ? item.text : "";
			const resultDetails = result.details as TodoDetails | undefined;
			return new Text(theme.fg(resultDetails?.error ? "error" : "muted", message), 0, 0);
		},
	});

	registerOmegaCommand(omega, "todos", {
		description: "Show or hide the todo execution panel",
		handler: async (_args, ctx) => {
			togglePanel(ctx);
		},
	});
	omega.registerShortcut(TODO_TOGGLE_SHORTCUT, {
		description: "Show or hide the todo execution panel",
		handler: async (ctx) => togglePanel(ctx),
	});

	omega.on("input", async (event, ctx) => {
		if (event.source === "extension") return { action: "continue" };
		const decision = await resolveTodoTaskSwitch(omega, ctx);
		if (decision.kind === "continue_current") {
			return {
				action: "transform",
				text: todoContinuationPrompt(decision.subject),
				images: [],
			};
		}
		return decision.kind === "cancel" ? { action: "handled" } : { action: "continue" };
	});

	const restore = async (_event: unknown, ctx: ExtensionContext): Promise<void> => {
		renderState(ctx, restoreState(ctx));
	};
	omega.on("session_start", restore);
	omega.on("session_tree", restore);
}

export { renderTodoLines, updateTodoUI } from "./render.ts";
export { applyTodoMutation, createTodoState, formatTodoText } from "./state.ts";
export type { TodoAction, TodoDetails, TodoItem, TodoState, TodoStatus } from "./types.ts";
