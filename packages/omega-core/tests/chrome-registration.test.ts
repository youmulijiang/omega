import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import omegaExtension from "../src/entry.ts";

vi.mock("../src/btw/transcript-pager.ts", () => ({
	BtwAnsweringView: class {},
	BtwTranscriptPager: class {},
}));

function createApiStub() {
	const tools: Array<{ name: string }> = [];
	const commands: Array<{ name: string }> = [];
	const handlers: Record<string, unknown[]> = {};
	return {
		pi: {
			appendEntry: vi.fn(),
			events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
			on: (event: string, handler: unknown) => {
				handlers[event] ??= [];
				handlers[event].push(handler);
			},
			registerCommand: (name: string, _options: unknown) => commands.push({ name }),
			registerFlag: vi.fn(),
			getFlag: vi.fn(),
			registerShortcut: vi.fn(),
			registerMessageRenderer: vi.fn(),
			registerProvider: vi.fn(),
			registerTool: (tool: { name: string }) => tools.push(tool),
			registerSettingsItems: vi.fn(() => vi.fn()),
			sendMessage: vi.fn(),
			getActiveTools: () => ["read", "bash"],
			setActiveTools: vi.fn(),
		} as unknown as ExtensionAPI,
		commands,
		handlers,
		tools,
	};
}

describe("chrome devtools module registration", () => {
	it("registers the chrome_devtools_* tools and /chrome-devtools command", () => {
		const { pi, tools, commands, handlers } = createApiStub();
		omegaExtension(pi);
		const names = tools.map((tool) => tool.name);
		expect(names).toEqual(
			expect.arrayContaining([
				"chrome_devtools_list_pages",
				"chrome_devtools_select_page",
				"chrome_devtools_navigate",
				"chrome_devtools_evaluate",
				"chrome_devtools_screenshot",
				"chrome_devtools_network",
				"chrome_devtools_webmcp_list_tools",
				"chrome_devtools_webmcp_call_tool",
				"chrome_devtools_load",
			]),
		);
		expect(commands.map((command) => command.name)).toContain("chrome-devtools");
		expect(Object.keys(handlers)).toEqual(
			expect.arrayContaining(["session_start", "model_select", "session_shutdown"]),
		);
	});
});
