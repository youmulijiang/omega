import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import omegaExtension from "../src/entry.ts";

vi.mock("../src/btw/transcript-pager.ts", () => ({
	BtwAnsweringView: class {},
	BtwTranscriptPager: class {},
}));

describe("omegaExtension", () => {
	it("registers the Omega memory tools", () => {
		const tools: string[] = [];
		const commands: string[] = [];
		const pi = {
			appendEntry: vi.fn(),
			events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
			on: vi.fn(),
			registerCommand: (name: string) => commands.push(name),
			registerFlag: vi.fn(),
			getFlag: vi.fn(),
			registerShortcut: vi.fn(),
			registerMessageRenderer: vi.fn(),
			registerProvider: vi.fn(),
			registerTool: (tool: { name: string }) => tools.push(tool.name),
			registerSettingsItems: vi.fn(() => vi.fn()),
			sendMessage: vi.fn(),
		} as unknown as ExtensionAPI;

		omegaExtension(pi);

		expect(tools).toEqual(
			expect.arrayContaining([
				"bg_run",
				"bg_status",
				"bg_logs",
				"bg_kill",
				"bg_delegate",
				"bg_result",
				"fusion_reason",
				"fusion_investigate",
				"fusion_research",
				"fusion_validate",
				"http_request",
				"http_replay",
				"diff",
				"knowledge_search",
				"mcp",
				"memory_write",
				"scratchpad",
				"memory_read",
				"memory_forget",
				"memory_restore",
				"memory_search",
				"memory_status",
				"todo",
			]),
		);
		expect(commands).toContain("btw");
		expect(commands).toContain("study");
		expect(commands).toContain("study:list");
		expect(commands).toContain("todos");
	});
});
