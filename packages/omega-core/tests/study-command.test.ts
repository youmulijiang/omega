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
				on: vi.fn(),
				sendMessage: vi.fn(),
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

		await vi.waitFor(() =>
			expect(confirm).toHaveBeenCalledWith("Insufficient context", expect.stringContaining("Proceed with the study")),
		);
		expect(save).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith("Study cancelled", "info");
	});

	it("treats the command prompt as primary study material and saves the distilled result", async () => {
		let handler: CommandHandler | undefined;
		const save = vi.fn(async () => "saved.md");
		const complete = vi.fn(async () =>
			response({
				sufficient: true,
				reason: "材料包含具体方法。",
				title: "参数化查询",
				tags: ["SQL", "安全"],
				summary: "使用参数绑定隔离查询结构与数据。",
				content: "## 方法\n\n使用参数化查询，并验证所有查询分支。",
			}),
		);
		const sendMessage = vi.fn();
		registerStudy(
			{
				on: vi.fn(),
				sendMessage,
				registerCommand: (name: string, options: { handler: CommandHandler }) => {
					if (name === "study") handler = options.handler;
				},
			} as unknown as OmegaAPI,
			{ complete, save },
		);
		const notify = vi.fn();
		await handler?.("参数化查询会将 SQL 结构与用户输入分离", {
			model: { provider: "test", id: "test" },
			modelRegistry: { getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "key" })) },
			sessionManager: { getBranch: () => [] },
			ui: { confirm: vi.fn(), notify },
		} as never);

		await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
		const modelContext = complete.mock.calls[0]?.[1];
		expect(modelContext?.messages[0]?.content).toEqual([
			expect.objectContaining({ text: expect.stringContaining("参数化查询会将 SQL 结构与用户输入分离") }),
		]);
		expect(modelContext?.messages[0]?.content).toEqual([
			expect.objectContaining({ text: expect.stringContaining("<study_request>") }),
		]);
		expect(save).toHaveBeenCalledWith({
			title: "参数化查询",
			tags: ["SQL", "安全"],
			summary: "使用参数绑定隔离查询结构与数据。",
			content: "## 方法\n\n使用参数化查询，并验证所有查询分支。",
		});
		expect(notify).toHaveBeenCalledWith("Knowledge saved: ~/.omega/knowledge/saved.md", "info");
		expect(sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "omega-study-result",
				content: expect.stringContaining("参数化查询"),
				display: true,
			}),
			{ triggerTurn: false },
		);
	});

	it("shows an animated studying status in the footer while learning", async () => {
		vi.useFakeTimers();
		try {
			let handler: CommandHandler | undefined;
			let finishStudy: ((message: AssistantMessage) => void) | undefined;
			const complete = vi.fn(
				async () =>
					await new Promise<AssistantMessage>((resolve) => {
						finishStudy = resolve;
					}),
			);
			registerStudy(
				{
					on: vi.fn(),
					sendMessage: vi.fn(),
					registerCommand: (name: string, options: { handler: CommandHandler }) => {
						if (name === "study") handler = options.handler;
					},
				} as unknown as OmegaAPI,
				{ complete, save: vi.fn(async () => "saved.md") },
			);
			const setStatus = vi.fn();
			const run = handler?.("", {
				mode: "tui",
				model: { provider: "test", id: "test" },
				modelRegistry: { getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "key" })) },
				sessionManager: { getBranch: () => [] },
				ui: {
					confirm: vi.fn(),
					notify: vi.fn(),
					setStatus,
					theme: { fg: (_color: string, text: string) => text },
				},
			} as never);

			expect(setStatus).toHaveBeenCalledWith("omega-study", "▖ studying");
			await run;
			expect(complete).toHaveBeenCalledOnce();
			await vi.advanceTimersByTimeAsync(120);
			expect(setStatus).toHaveBeenLastCalledWith("omega-study", "▘ studying");

			finishStudy?.(
				response({
					sufficient: true,
					reason: "ok",
					title: "T",
					tags: [],
					summary: "S",
					content: "C",
				}),
			);
			await vi.advanceTimersByTimeAsync(0);
			expect(setStatus).toHaveBeenLastCalledWith("omega-study", undefined);
		} finally {
			vi.useRealTimers();
		}
	});

	it("opens /study:status as a live dialog", async () => {
		const commands = new Map<string, CommandHandler>();
		registerStudy({
			on: vi.fn(),
			sendMessage: vi.fn(),
			registerCommand: (name: string, options: { handler: CommandHandler }) =>
				commands.set(name, options.handler),
		} as unknown as OmegaAPI);
		const custom = vi.fn(async () => undefined);

		await commands.get("study:status")?.("", {
			mode: "tui",
			ui: { custom },
		} as never);

		expect(custom).toHaveBeenCalledWith(
			expect.any(Function),
			expect.objectContaining({
				overlay: true,
				overlayOptions: expect.objectContaining({ anchor: "center" }),
			}),
		);
	});

	it("lists the index or a named knowledge document", async () => {
		const commands = new Map<string, CommandHandler>();
		const readIndex = vi.fn(async () => "# Index");
		const readContent = vi.fn(async (name: string) =>
			name === "SQL 注入" ? { file: "sql.md", title: "SQL 注入", content: "# SQL 注入\n\n正文" } : undefined,
		);
		registerStudy(
			{
				on: vi.fn(),
				sendMessage: vi.fn(),
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
		expect(notify).toHaveBeenLastCalledWith("Knowledge base index entry not found: 不存在", "warning");
	});
});
