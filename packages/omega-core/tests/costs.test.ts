import type { Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { renderCostHtml } from "../src/costs/html.ts";
import { collectCostReport } from "../src/costs/report.ts";
import { renderCostDashboard } from "../src/costs/view.ts";

function usage(input: number, output: number, cost: number): Usage {
	return {
		input,
		output,
		cacheRead: 2,
		cacheWrite: 1,
		totalTokens: input + output + 3,
		cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

function assistant(id: string, model: string, result: Usage): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-01-01T00:00:00Z",
		message: {
			role: "assistant",
			api: "openai-completions",
			provider: "test",
			model,
			content: [{ type: "text", text: "answer" }],
			usage: result,
			stopReason: "stop",
			timestamp: 0,
		},
	};
}

describe("cost report", () => {
	it("groups exact billed usage by assistant model and keeps summary usage unattributed", () => {
		const entries: SessionEntry[] = [
			assistant("a", "one", usage(10, 5, 0.02)),
			assistant("b", "two", usage(4, 3, 0.01)),
			{
				type: "compaction", id: "c", parentId: "b", timestamp: "2026-01-01T00:00:00Z",
				summary: "summary", firstKeptEntryId: "a", tokensBefore: 20, usage: usage(6, 2, 0.005),
			},
		];
		const report = collectCostReport(entries, entries, { provider: "test", id: "two" });
		expect(report.models.map((model) => model.model)).toEqual(["test/one", "test/two"]);
		expect(report.models[0]?.totalTokens).toBe(18);
		expect(report.unattributed.totalTokens).toBe(11);
		expect(report.total.totalTokens).toBe(39);
		expect(report.total.cost).toBeCloseTo(0.035);
	});

	it("labels MCP separately and reports the current prompt as an estimate", () => {
		const entries: SessionEntry[] = [{
			type: "message", id: "m", parentId: null, timestamp: "2026-01-01T00:00:00Z",
			message: { role: "toolResult", toolCallId: "x", toolName: "mcp", content: [{ type: "text", text: "MCP DATA" }], isError: false, timestamp: 0 },
		}];
		const report = collectCostReport(entries, entries, { provider: "test", id: "new" }, "system prompt");
		expect(report.models[0]?.calls).toBe(0);
		expect(report.sources.find((source) => source.label === "MCP responses")?.tokens).toBeGreaterThan(0);
		expect(report.sources.find((source) => source.label === "System prompt (rest)")?.tokens).toBeGreaterThan(0);
		expect(report.total.totalTokens).toBe(0);
	});

	it("classifies a read SKILL.md response as Skill content", () => {
		const request = assistant("a", "one", usage(1, 1, 0));
		if (request.type !== "message" || request.message.role !== "assistant") throw new Error("Invalid fixture");
		request.message.content.push({ type: "toolCall", id: "read-skill", name: "read", arguments: { path: "C:/skills/demo/SKILL.md" } });
		const result: SessionEntry = {
			type: "message", id: "b", parentId: "a", timestamp: "2026-01-01T00:00:00Z",
			message: { role: "toolResult", toolCallId: "read-skill", toolName: "read", content: [{ type: "text", text: "Skill instructions" }], isError: false, timestamp: 0 },
		};
		const report = collectCostReport([request, result], [request, result]);
		expect(report.sources.find((source) => source.label === "Skill file responses")?.tokens).toBeGreaterThan(0);
		expect(report.sources.find((source) => source.label === "Other tool responses")?.tokens).toBe(0);
	});

	it("renders within terminal width and escapes model names in HTML", () => {
		const report = collectCostReport([assistant("a", "<script>alert(1)</script>", usage(10, 5, 0.02))], [], { provider: "test", id: "other" });
		for (const width of [8, 42, 80]) {
			expect(renderCostDashboard(report, width).every((line) => visibleWidth(line) <= width)).toBe(true);
		}
		const html = renderCostHtml(report, new Date("2026-01-01T00:00:00Z"));
		expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
		expect(html).not.toContain("<script>");
		expect(html).toContain("不可与供应商计费 Token 相加");
	});
});
