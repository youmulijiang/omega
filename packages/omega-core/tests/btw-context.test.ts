import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { runBtwThread } from "../src/btw/btw.ts";
import { buildSideThreadSystemPrompt, completeSideThreadTurn, createSideThread } from "../src/btw/side-thread.ts";

/**
 * 回归：/btw 侧线问答必须继承主会话上下文。
 *
 * 此前侧线只发送自己的 turn 历史，系统提示还明确写着
 * "Do not rely on or request the main conversation context."，
 * 于是 /btw 看不到主会话里正在讨论的文件、报错和结论。
 */

vi.mock("../src/btw/transcript-pager.ts", () => ({
	BtwAnsweringView: class {
		signal = undefined;
		finish() {}
	},
	BtwTranscriptPager: class {},
}));

const ASSISTANT_MESSAGE = {
	role: "assistant",
	content: [{ type: "text", text: "ok" }],
	stopReason: "stop",
} as unknown as AssistantMessage;

/**
 * pi-ai 的 normalizeContext() 把 systemPrompt 折叠成首条 system 消息，
 * 因此 provider 收到的 context 没有 systemPrompt 字段。
 */
function firstSystemText(context: Context): string {
	const message = context.messages[0] as { role?: string; content?: unknown } | undefined;
	if (message?.role !== "system") return "";
	return typeof message.content === "string" ? message.content : JSON.stringify(message.content);
}

describe("buildSideThreadSystemPrompt", () => {
	it("embeds the main conversation as read-only context", () => {
		const prompt = buildSideThreadSystemPrompt("User: 修复登录\n\nAssistant: 已定位到 auth.ts");
		expect(prompt).toContain("<main_conversation>");
		expect(prompt).toContain("auth.ts");
		expect(prompt).not.toContain("Do not rely on or request the main conversation context");
	});

	it("falls back to the isolated prompt when there is no context", () => {
		for (const empty of [undefined, "", "   "]) {
			const prompt = buildSideThreadSystemPrompt(empty);
			expect(prompt).not.toContain("<main_conversation>");
		}
	});
});

describe("completeSideThreadTurn", () => {
	it("sends the main conversation to the side model", async () => {
		const contexts: Context[] = [];
		await completeSideThreadTurn({
			thread: createSideThread(),
			model: { provider: "test", id: "side" } as Model<Api>,
			question: "这段代码为什么会抛错？",
			thinkingLevel: "off",
			auth: { apiKey: "test-key" },
			mainContext: "User: 看下 packages/omega-core/src/todo/index.ts\n\nAssistant: 已读",
			completeSimple: async (_model, context) => {
				contexts.push(context);
				return ASSISTANT_MESSAGE;
			},
		});

		expect(contexts).toHaveLength(1);
		expect(contexts[0].systemPrompt).toContain("packages/omega-core/src/todo/index.ts");
		expect(contexts[0].systemPrompt).toContain("<main_conversation>");
	});
});

describe("runBtwThread", () => {
	it("projects the session branch into the side model request", async () => {
		const contexts: Context[] = [];
		const ctx = {
			modelRegistry: {
				getProvider: () => ({
					streamSimple: (_model: unknown, context: Context) => ({
						result: async () => {
							contexts.push(context);
							return ASSISTANT_MESSAGE;
						},
					}),
				}),
			},
			sessionManager: {
				getBranch: () => [
					{ type: "message", message: { role: "user", content: [{ type: "text", text: "修复 btw 上下文" }] } },
					{
						type: "message",
						message: { role: "assistant", content: [{ type: "text", text: "正在读 side-thread.ts" }] },
					},
				],
			},
			ui: {
				custom: (factory: (...args: never[]) => unknown) =>
					new Promise((resolve) => {
						factory({} as never, {} as never, {} as never, resolve as never);
					}),
			},
		} as unknown as ExtensionCommandContext;

		await runBtwThread({
			initialQuestion: "为什么没上下文？",
			selected: { model: { provider: "test", id: "side" } as Model<Api>, auth: { apiKey: "test-key" } },
			thinkingLevel: "off",
			ctx,
			dependencies: { interact: async () => ({ kind: "close" as const }) },
		});

		expect(contexts).toHaveLength(1);
		expect(firstSystemText(contexts[0])).toContain("修复 btw 上下文");
		expect(firstSystemText(contexts[0])).toContain("正在读 side-thread.ts");
	});
});
