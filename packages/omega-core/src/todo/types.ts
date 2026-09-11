import { StringEnum, Type } from "@earendil-works/pi-ai";

export type TodoStatus = "pending" | "in_progress" | "completed" | "deleted";
export type TodoAction = "create" | "update" | "list" | "delete" | "clear";

export interface TodoItem {
	id: number;
	subject: string;
	status: TodoStatus;
	activeForm?: string;
	planStep?: number;
}

export interface TodoState {
	tasks: TodoItem[];
	nextId: number;
}

export interface TodoDetails extends TodoState {
	action: TodoAction;
	error?: string;
}

export const TodoParams = Type.Object({
	action: StringEnum(["create", "update", "list", "delete", "clear"] as const, {
		description: "Operation to perform on the current session's task list",
	}),
	id: Type.Optional(Type.Integer({ minimum: 1, description: "Task id; required for update and delete" })),
	subject: Type.Optional(Type.String({ description: "Short task description; required for create" })),
	status: Type.Optional(
		StringEnum(["pending", "in_progress", "completed"] as const, {
			description: "New task status for update, or an optional list filter",
		}),
	),
	activeForm: Type.Optional(
		Type.String({ description: "Present-continuous label displayed while the task is in progress" }),
	),
});

export interface TodoMutationParams {
	id?: number;
	subject?: string;
	status?: Exclude<TodoStatus, "deleted">;
	activeForm?: string;
}
