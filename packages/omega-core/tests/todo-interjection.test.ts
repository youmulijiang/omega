import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { OmegaAPI } from "../src/api.ts";
import { TODO_CONTINUE_CURRENT, registerTodo } from "../src/todo/index.ts";

/**
 * 回归：运行中插入语句（steer/followUp）不得被静默丢弃。
 *
 * 此前 todo 的 input 处理器不区分是否处于 streaming：用户在智能体运行期间插入语句时
 * 会弹出「继续当前 / 新建任务」选择窗，选「继续」则原文被替换成固定的继续提示
 * （todoContinuationPrompt），用户补充的信息永远到不了模型；选「新建」则清空整个列表。
 */

interface TodoTool {
	name: string;
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal: undefined,
		onUpdate: undefined,
		ctx: ExtensionContext,
	): Promise<unknown>;
}

type InputHandler = (
	event: { type: "input"; text: string; source: string; streamingBehavior?: "steer" | "followUp" },
	ctx: ExtensionContext,
) => Promise<unknown>;

interface Harness {
	omega: OmegaAPI;
	tool: TodoTool;
	input: InputHandler;
	selectCalls: string[];
}

function createHarness(): Harness {
	let tool: TodoTool | undefined;
	let input: InputHandler | undefined;
	const selectCalls: string[] = [];
	const omega = {
		appendEntry: () => {},
		registerCommand: () => {},
		registerShortcut: () => {},
		registerTool: (registered: TodoTool) => {
			tool = registered;
		},
		on: (event: string, handler: InputHandler) => {
			if (event === "input") input = handler;
			return () => {};
		},
	} as unknown as OmegaAPI;
	registerTodo(omega);
	if (!tool || !input) throw new Error("registerTodo did not register the todo tool and input handler");
	return { omega, tool, input, selectCalls };
}

function createCtx(sessionId: string, selectCalls: string[], choice: string | undefined): ExtensionContext {
	return {
		hasUI: true,
		sessionManager: { getSessionId: () => sessionId },
		ui: {
			notify: () => {},
			select: async (title: string) => {
				selectCalls.push(title);
				return choice;
			},
			setStatus: () => {},
			setWidget: () => {},
			theme: {
				bold: (text: string) => text,
				strikethrough: (text: string) => text,
				fg: (_color: string, text: string) => text,
			},
		},
	} as unknown as ExtensionContext;
}

async function seedTodo(harness: Harness, ctx: ExtensionContext, subject: string): Promise<void> {
	await harness.tool.execute("t1", { action: "create", subject }, undefined, undefined, ctx);
}

describe("todo input handling while the agent is running", () => {
	it("keeps the user's interjected text instead of replacing it with the continuation prompt", async () => {
		const harness = createHarness();
		const ctx = createCtx("interjection", harness.selectCalls, undefined);
		await seedTodo(harness, ctx, "修复登录绕行");

		const result = (await harness.input(
			{ type: "input", text: "其实用 X 方案更好，另外补一个回归测试", source: "interactive", streamingBehavior: "steer" },
			ctx,
		)) as { action: string; text?: string; images?: unknown };

		expect(harness.selectCalls).toEqual([]);
		expect(result.action).toBe("transform");
		expect(result.text).toContain("其实用 X 方案更好，另外补一个回归测试");
		expect(result.text).toContain("修复登录绕行");
		// 不返回 images 时上层沿用原始附件，插入语句携带的图片不会被丢弃。
		expect(result.images).toBeUndefined();
	});

	it("leaves the interjection untouched when there is no todo to continue", async () => {
		const harness = createHarness();
		const ctx = createCtx("no-todo", harness.selectCalls, undefined);

		const result = await harness.input(
			{ type: "input", text: "换个话题", source: "interactive", streamingBehavior: "followUp" },
			ctx,
		);

		expect(result).toEqual({ action: "continue" });
		expect(harness.selectCalls).toEqual([]);
	});

	it("still asks continue-or-new when the agent is idle, without dropping the input", async () => {
		const harness = createHarness();
		const ctx = createCtx("idle", harness.selectCalls, TODO_CONTINUE_CURRENT);
		await seedTodo(harness, ctx, "整理报告");

		const result = (await harness.input(
			{ type: "input", text: "开始新任务", source: "interactive" },
			ctx,
		)) as { action: string; text?: string; images?: unknown };

		expect(harness.selectCalls).toEqual(["Current todo: 整理报告"]);
		expect(result.action).toBe("transform");
		expect(result.text).toContain("整理报告");
		// 选「继续当前 todo」只表示保留 todo，不代表丢弃这次输入。
		expect(result.text).toContain("开始新任务");
		expect(result.images).toBeUndefined();
	});
});