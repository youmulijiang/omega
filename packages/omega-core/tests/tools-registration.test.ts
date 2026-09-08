import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { OmegaAPI } from "../src/api.ts";
import { registerTools } from "../src/tools/index.ts";

describe("registerTools", () => {
	it("registers executable HTTP and diff tools", async () => {
		const tools: ToolDefinition[] = [];
		registerTools({ registerTool: (tool: ToolDefinition) => tools.push(tool) } as unknown as OmegaAPI);
		expect(tools.map((tool) => tool.name)).toEqual(["knowledge_search", "http_request", "http_replay", "diff"]);
		const context = {} as ExtensionContext;
		const diff = tools.find((tool) => tool.name === "diff")!;
		const result = await diff.execute("diff-1", { before: "old\n", after: "new\n" }, undefined, undefined, context);
		expect(result.details).toMatchObject({ equal: false, addedLines: 1, removedLines: 1 });
		expect(result.content).toEqual([{ type: "text", text: expect.stringContaining("+new") }]);
		for (const tool of tools) {
			await expect(tool.execute("cancelled", { url: "http://127.0.0.1", rawRequest: "GET / HTTP/1.1\r\n\r\n", before: "", after: "" }, AbortSignal.abort(), undefined, context)).rejects.toThrow();
		}
	});
});
