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
			on: vi.fn(),
			registerCommand: (name: string) => commands.push(name),
			registerFlag: vi.fn(),
			registerShortcut: vi.fn(),
			registerTool: (tool: { name: string }) => tools.push(tool.name),
		} as unknown as ExtensionAPI;

		omegaExtension(pi);

		expect(tools).toEqual(
			expect.arrayContaining([
				"mcp",
				"memory_write",
				"scratchpad",
				"memory_read",
				"memory_forget",
				"memory_restore",
				"memory_search",
				"memory_status",
			]),
		);
		expect(commands).toContain("btw");
	});
});
