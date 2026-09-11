import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TodoItem, TodoState } from "./types.ts";

const MAX_WIDGET_LINES = 12;

function renderTask(task: TodoItem, theme: Theme): string {
	if (task.status === "completed") {
		return `${theme.fg("success", "✓ ")}${theme.fg("dim", theme.strikethrough(task.subject))}`;
	}
	if (task.status === "in_progress") {
		return `${theme.fg("warning", "◐ ")}${theme.fg("accent", task.activeForm ?? task.subject)}`;
	}
	return `${theme.fg("dim", "○ ")}${theme.fg("text", task.subject)}`;
}

export function renderTodoLines(state: TodoState, theme: Theme, maxLines = MAX_WIDGET_LINES): string[] {
	const tasks = state.tasks.filter((task) => task.status !== "deleted");
	if (tasks.length === 0) return [];
	const completed = tasks.filter((task) => task.status === "completed").length;
	const ordered = [
		...tasks.filter((task) => task.status === "in_progress"),
		...tasks.filter((task) => task.status === "pending"),
		...tasks.filter((task) => task.status === "completed"),
	];
	const bodyLimit = Math.max(1, maxLines - 1);
	const shown = ordered.slice(0, bodyLimit);
	const lines = [
		theme.fg("accent", theme.bold(`Todos (${completed}/${tasks.length})`)),
		...shown.map((task) => renderTask(task, theme)),
	];
	const hidden = ordered.length - shown.length;
	if (hidden > 0) {
		lines[lines.length - 1] = theme.fg("dim", `… +${hidden + 1} more`);
	}
	return lines;
}

export function updateTodoUI(ctx: ExtensionContext, state: TodoState, visible = true): void {
	if (ctx.hasUI === false) return;
	const tasks = state.tasks.filter((task) => task.status !== "deleted");
	if (tasks.length === 0) {
		ctx.ui.setStatus("omega-todo", undefined);
		ctx.ui.setWidget("omega-todo", undefined);
		return;
	}
	const completed = tasks.filter((task) => task.status === "completed").length;
	ctx.ui.setStatus("omega-todo", ctx.ui.theme.fg("accent", `tasks ${completed}/${tasks.length}`));
	if (!visible) {
		ctx.ui.setWidget("omega-todo", undefined);
		return;
	}
	ctx.ui.setWidget("omega-todo", renderTodoLines(state, ctx.ui.theme), { placement: "aboveEditor" });
}
