import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { OmegaAPI } from "../src/api.ts";
import { parseStudyResult, registerStudy } from "../src/study/index.ts";

type CommandHandler = Parameters<ExtensionAPI["registerCommand"]>[1]["handler"];

function response(result: object): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: JSON.stringify(result) }],
		stopReason: "stop",
		timestamp: Date.now(),
		api: "openai-completions",
		provider: "test",
		model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
}

describe("/study", () => {
	it("parses fenced structured output", () => {
		expect(
			parseStudyResult(
				'```json\n{"sufficient":true,"reason":"ok","title":"T","tags":[],"summary":"S","content":"C"}\n```',
			),
		).toMatchObject({ sufficient: true, title: "T" });
	});

	it("asks before saving when context is insufficient", async () => {
		let handler: CommandHandler | undefined;
		const save = vi.fn(async () => "saved.md");
		const complete = vi.fn(async () =>
			response({
				sufficient: false,
				reason: "只有一个问题，没有分析结果。",
				title: "有限经验",
				tags: ["分析"],
				summary: "现有信息有限。",
				content: "需要补充证据。",
			}),
		);
		registerStudy(
			{
				registerCommand: (name: string, options: { handler: CommandHandler }) => {
					if (name === "study") handler = options.handler;
				},
			} as unknown as OmegaAPI,
			{ complete, save },
		);
		const confirm = vi.fn(async () => false);
		const notify = vi.fn();
		await handler?.("注入分析", {
			model: { provider: "test", id: "test" },
			modelRegistry: { getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "key" })) },
			sessionManager: { getBranch: () => [] },
			ui: { confirm, notify },
		} as never);

		expect(confirm).toHaveBeenCalledWith("上下文不足", expect.stringContaining("是否仍然进行学习"));
		expect(save).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith("已取消学习", "info");
	});

	it("lists the index or a named knowledge document", async () => {
		const commands = new Map<string, CommandHandler>();
		const readIndex = vi.fn(async () => "# Index");
		const readContent = vi.fn(async (name: string) =>
			name === "SQL 注入" ? { file: "sql.md", title: "SQL 注入", content: "# SQL 注入\n\n正文" } : undefined,
		);
		registerStudy(
			{
				registerCommand: (name: string, options: { handler: CommandHandler }) =>
					commands.set(name, options.handler),
			} as unknown as OmegaAPI,
			{ readIndex, readContent },
		);
		const notify = vi.fn();
		const ctx = { ui: { notify } } as never;

		await commands.get("study:list")?.("", ctx);
		expect(notify).toHaveBeenLastCalledWith("# Index", "info");
		await commands.get("study:list")?.("SQL 注入", ctx);
		expect(notify).toHaveBeenLastCalledWith("# SQL 注入\n\n正文", "info");
		await commands.get("study:list")?.("不存在", ctx);
		expect(notify).toHaveBeenLastCalledWith("未找到知识库索引项：不存在", "warning");
	});
});
