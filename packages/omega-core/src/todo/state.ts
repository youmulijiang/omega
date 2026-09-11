import type { TodoAction, TodoItem, TodoMutationParams, TodoState } from "./types.ts";

export interface TodoMutationResult {
	state: TodoState;
	message: string;
	error?: string;
}

export function createTodoState(): TodoState {
	return { tasks: [], nextId: 1 };
}

export function cloneTodoState(state: TodoState): TodoState {
	return { tasks: state.tasks.map((task) => ({ ...task })), nextId: state.nextId };
}

function errorResult(state: TodoState, message: string): TodoMutationResult {
	return { state: cloneTodoState(state), message: `Error: ${message}`, error: message };
}

function activateOnly(tasks: TodoItem[], id: number): TodoItem[] {
	return tasks.map((task) => {
		if (task.id === id || task.status !== "in_progress") return task;
		return { ...task, status: "pending" };
	});
}

export function applyTodoMutation(
	state: TodoState,
	action: TodoAction,
	params: TodoMutationParams,
): TodoMutationResult {
	const current = cloneTodoState(state);
	switch (action) {
		case "create": {
			const subject = params.subject?.trim();
			if (!subject) return errorResult(current, "subject is required for create");
			const task: TodoItem = { id: current.nextId, subject, status: "pending" };
			if (params.activeForm?.trim()) task.activeForm = params.activeForm.trim();
			return {
				state: { tasks: [...current.tasks, task], nextId: current.nextId + 1 },
				message: `Created #${task.id}: ${task.subject}`,
			};
		}
		case "update": {
			if (params.id === undefined) return errorResult(current, "id is required for update");
			const index = current.tasks.findIndex((task) => task.id === params.id && task.status !== "deleted");
			if (index < 0) return errorResult(current, `#${params.id} not found`);
			if (params.subject === undefined && params.status === undefined && params.activeForm === undefined) {
				return errorResult(current, "update requires subject, status, or activeForm");
			}
			if (params.subject !== undefined && !params.subject.trim()) {
				return errorResult(current, "subject cannot be empty");
			}
			const task = { ...current.tasks[index] };
			if (params.subject !== undefined) task.subject = params.subject.trim();
			if (params.status !== undefined) task.status = params.status;
			if (params.activeForm !== undefined) {
				const activeForm = params.activeForm.trim();
				if (activeForm) task.activeForm = activeForm;
				else delete task.activeForm;
			}
			let tasks = [...current.tasks];
			tasks[index] = task;
			if (task.status === "in_progress") tasks = activateOnly(tasks, task.id);
			return { state: { tasks, nextId: current.nextId }, message: `Updated #${task.id} to ${task.status}` };
		}
		case "delete": {
			if (params.id === undefined) return errorResult(current, "id is required for delete");
			const index = current.tasks.findIndex((task) => task.id === params.id && task.status !== "deleted");
			if (index < 0) return errorResult(current, `#${params.id} not found`);
			const task = { ...current.tasks[index], status: "deleted" as const };
			const tasks = [...current.tasks];
			tasks[index] = task;
			return { state: { tasks, nextId: current.nextId }, message: `Deleted #${task.id}: ${task.subject}` };
		}
		case "clear": {
			const count = current.tasks.filter((task) => task.status !== "deleted").length;
			return { state: createTodoState(), message: `Cleared ${count} task${count === 1 ? "" : "s"}` };
		}
		case "list":
			return { state: current, message: formatTodoText(current, params.status) };
	}
}

export function formatTodoText(state: TodoState, status?: TodoMutationParams["status"]): string {
	const visible = state.tasks.filter((task) => task.status !== "deleted" && (!status || task.status === status));
	if (visible.length === 0) return status ? `No ${status} tasks` : "No todos yet";
	return visible
		.map((task) => {
			const glyph = task.status === "completed" ? "✓" : task.status === "in_progress" ? "◐" : "○";
			const label = task.status === "in_progress" && task.activeForm ? task.activeForm : task.subject;
			return `${glyph} #${task.id} ${label} (${task.status})`;
		})
		.join("\n");
}

export function isTodoState(value: unknown): value is TodoState {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<TodoState>;
	if (!Number.isInteger(candidate.nextId) || !Array.isArray(candidate.tasks)) return false;
	return candidate.tasks.every(
		(task) =>
			task !== null &&
			typeof task === "object" &&
			Number.isInteger((task as TodoItem).id) &&
			typeof (task as TodoItem).subject === "string" &&
			["pending", "in_progress", "completed", "deleted"].includes((task as TodoItem).status),
	);
}
