import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { OmegaAPI } from "../src/api.ts";
import {
	applyTodoCompletionToPlan,
	onTodoReplacement,
	registerTodo,
	replaceTodosFromPlan,
	resolveTodoTaskSwitch,
	syncTodosWithPlan,
	TODO_CONTINUE_CURRENT,
	TODO_START_NEW,
	TODO_TOGGLE_SHORTCUT,
} from "../src/todo/index.ts";
import { applyTodoMutation, createTodoState } from "../src/todo/state.ts";
import { renderTodoLines } from "../src/todo/render.ts";

type RegisteredTool = Parameters<ExtensionAPI["registerTool"]>[0];
type CommandHandler = Parameters<ExtensionAPI["registerCommand"]>[1]["handler"];
type ShortcutHandler = Parameters<ExtensionAPI["registerShortcut"]>[1]["handler"];

const theme = {
	bold: (text: string) => text,
	strikethrough: (text: string) => text,
	fg: (_color: string, text: string) => text,
} as Theme;

describe("todo state", () => {
	it("creates tasks, keeps one active task, and records completion", () => {
		let state = applyTodoMutation(createTodoState(), "create", { subject: "Inspect routes" }).state;
		state = applyTodoMutation(state, "create", { subject: "Write regression test" }).state;
		state = applyTodoMutation(state, "update", { id: 1, status: "in_progress", activeForm: "Inspecting routes" }).state;
		state = applyTodoMutation(state, "update", { id: 2, status: "in_progress" }).state;
		state = applyTodoMutation(state, "update", { id: 2, status: "completed" }).state;

		expect(state.tasks).toEqual([
			expect.objectContaining({ id: 1, status: "pending" }),
			expect.objectContaining({ id: 2, status: "completed" }),
		]);
	});

	it("does not mutate state when an update is invalid", () => {
		const state = applyTodoMutation(createTodoState(), "create", { subject: "Inspect routes" }).state;
		const result = applyTodoMutation(state, "update", { id: 99, status: "completed" });

		expect(result.error).toBe("#99 not found");
		expect(result.state).toEqual(state);
	});
});

describe("todo display", () => {
	it("renders progress, active work, pending work, and completed work", () => {
		const lines = renderTodoLines(
			{
				nextId: 4,
				tasks: [
					{ id: 1, subject: "Inspect routes", status: "completed" },
					{ id: 2, subject: "Write tests", activeForm: "Writing tests", status: "in_progress" },
					{ id: 3, subject: "Run checks", status: "pending" },
				],
			},
			theme,
		);

		expect(lines.join("\n")).toContain("Todos (1/3)");
		expect(lines.join("\n")).toContain("◐ Writing tests");
		expect(lines.join("\n")).toContain("○ Run checks");
		expect(lines.join("\n")).toContain("✓ Inspect routes");
	});
});

describe("todo extension", () => {
	it("registers the tool and command, persists mutations, and refreshes the panel", async () => {
		let tool: RegisteredTool | undefined;
		let command: CommandHandler | undefined;
		let shortcut: ShortcutHandler | undefined;
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>();
		const appendEntry = vi.fn();
		const setWidget = vi.fn();
		const pi = {
			appendEntry,
			registerTool: (candidate: RegisteredTool) => {
				tool = candidate;
			},
			registerCommand: (_name: string, options: { handler: CommandHandler }) => {
				command = options.handler;
			},
			registerShortcut: (key: string, options: { handler: ShortcutHandler }) => {
				expect(key).toBe(TODO_TOGGLE_SHORTCUT);
				shortcut = options.handler;
			},
			on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) => handlers.set(event, handler),
		} as unknown as OmegaAPI;
		const ctx = {
			hasUI: true,
			mode: "tui",
			sessionManager: { getSessionId: () => "todo-test", getBranch: () => [] },
			ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget, theme },
		} as unknown as ExtensionContext;

		registerTodo(pi);
		expect(tool?.name).toBe("todo");
		await handlers.get("session_start")?.({}, ctx);
		const result = await tool?.execute(
			"call-1",
			{ action: "create", subject: "Inspect routes" },
			undefined,
			undefined,
			ctx,
		);

		expect(result?.details).toMatchObject({ tasks: [{ subject: "Inspect routes", status: "pending" }] });
		expect(appendEntry).toHaveBeenCalledWith("omega-todo-state", expect.objectContaining({ nextId: 2 }));
		expect(setWidget).toHaveBeenLastCalledWith("omega-todo", expect.arrayContaining(["Todos (0/1)"]), {
			placement: "aboveEditor",
		});

		await command?.("", ctx as never);
		expect(setWidget).toHaveBeenLastCalledWith("omega-todo", undefined);
		expect(ctx.ui.notify).toHaveBeenLastCalledWith("Todo panel hidden.", "info");
		await tool?.execute("call-hidden", { action: "create", subject: "Run checks" }, undefined, undefined, ctx);
		expect(setWidget).toHaveBeenLastCalledWith("omega-todo", undefined);

		await shortcut?.(ctx as never);
		expect(setWidget).toHaveBeenLastCalledWith("omega-todo", expect.arrayContaining(["Todos (0/2)"]), {
			placement: "aboveEditor",
		});
		expect(ctx.ui.notify).toHaveBeenLastCalledWith("Todo panel shown.", "info");
	});

	it("imports plan steps and reflects tool-driven completion back into plan progress", async () => {
		let tool: RegisteredTool | undefined;
		const pi = {
			appendEntry: vi.fn(),
			registerTool: (candidate: RegisteredTool) => {
				tool = candidate;
			},
			registerCommand: vi.fn(),
			registerShortcut: vi.fn(),
			on: vi.fn(),
		} as unknown as OmegaAPI;
		const ctx = {
			hasUI: true,
			mode: "tui",
			sessionManager: { getSessionId: () => "todo-plan-test", getBranch: () => [] },
			ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn(), theme },
		} as unknown as ExtensionContext;
		const steps = [
			{ step: 1, text: "Inspect routes", completed: false },
			{ step: 2, text: "Write tests", completed: false },
		];

		registerTodo(pi);
		replaceTodosFromPlan(pi, ctx, steps);
		syncTodosWithPlan(pi, ctx, steps, true);
		await tool?.execute("call-2", { action: "update", id: 1, status: "completed" }, undefined, undefined, ctx);

		expect(applyTodoCompletionToPlan(ctx, steps)).toBe(1);
		expect(steps[0].completed).toBe(true);
		syncTodosWithPlan(pi, ctx, steps, true);
		const list = await tool?.execute("call-3", { action: "list" }, undefined, undefined, ctx);
		expect(list?.details).toMatchObject({
			tasks: [
				{ id: 1, status: "completed", planStep: 1 },
				{ id: 2, status: "in_progress", planStep: 2 },
			],
		});
	});

	it("asks before replacing unfinished work and clears both todo and plan state for a new task", async () => {
		let tool: RegisteredTool | undefined;
		const planReplacement = vi.fn();
		const select = vi.fn().mockResolvedValue(TODO_START_NEW);
		const appendEntry = vi.fn();
		const pi = {
			appendEntry,
			registerTool: (candidate: RegisteredTool) => {
				tool = candidate;
			},
			registerCommand: vi.fn(),
			registerShortcut: vi.fn(),
			on: vi.fn(),
		} as unknown as OmegaAPI;
		const ctx = {
			hasUI: true,
			mode: "tui",
			sessionManager: { getSessionId: () => "todo-switch-test", getBranch: () => [] },
			ui: { notify: vi.fn(), select, setStatus: vi.fn(), setWidget: vi.fn(), theme },
		} as unknown as ExtensionContext;

		registerTodo(pi);
		onTodoReplacement(pi, planReplacement);
		await tool?.execute("create-old", { action: "create", subject: "Finish old task" }, undefined, undefined, ctx);
		await tool?.execute("start-old", { action: "update", id: 1, status: "in_progress" }, undefined, undefined, ctx);
		const decision = await resolveTodoTaskSwitch(pi, ctx);

		expect(select).toHaveBeenCalledWith("Current todo: Finish old task", [TODO_CONTINUE_CURRENT, TODO_START_NEW]);
		expect(decision).toEqual({ kind: "start_new" });
		expect(planReplacement).toHaveBeenCalledWith(ctx);
		expect(appendEntry).toHaveBeenLastCalledWith("omega-todo-state", { tasks: [], nextId: 1 });
	});

	it("keeps the current todo when the user chooses to continue it", async () => {
		let tool: RegisteredTool | undefined;
		const pi = {
			appendEntry: vi.fn(),
			registerTool: (candidate: RegisteredTool) => {
				tool = candidate;
			},
			registerCommand: vi.fn(),
			registerShortcut: vi.fn(),
			on: vi.fn(),
		} as unknown as OmegaAPI;
		const ctx = {
			hasUI: true,
			mode: "tui",
			sessionManager: { getSessionId: () => "todo-continue-test", getBranch: () => [] },
			ui: {
				notify: vi.fn(),
				select: vi.fn().mockResolvedValue(TODO_CONTINUE_CURRENT),
				setStatus: vi.fn(),
				setWidget: vi.fn(),
				theme,
			},
		} as unknown as ExtensionContext;

		registerTodo(pi);
		await tool?.execute("create-current", { action: "create", subject: "Finish current task" }, undefined, undefined, ctx);
		const decision = await resolveTodoTaskSwitch(pi, ctx);

		expect(decision).toEqual({ kind: "continue_current", subject: "Finish current task" });
	});

	it("does not intercept ordinary input while a todo is unfinished", () => {
		const registered: string[] = [];
		const pi = {
			appendEntry: vi.fn(),
			registerTool: vi.fn(),
			registerCommand: vi.fn(),
			registerShortcut: vi.fn(),
			on: (event: string) => registered.push(event),
		} as unknown as OmegaAPI;

		registerTodo(pi);

		expect(registered).not.toContain("input");
	});
});
