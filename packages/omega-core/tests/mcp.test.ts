import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { registerMcp } from "../src/mcp/index.ts";

describe("registerMcp", () => {
	it("registers the /mcp command and MCP proxy tool", () => {
		const commands: string[] = [];
		const tools: string[] = [];
		const pi = {
			events: { emit: vi.fn(), on: vi.fn() },
			getActiveTools: vi.fn(() => []),
			getAllTools: vi.fn(() => []),
			on: vi.fn(),
			registerCommand: (name: string) => commands.push(name),
			registerFlag: vi.fn(),
			registerTool: (tool: { name: string }) => tools.push(tool.name),
			setActiveTools: vi.fn(),
		} as unknown as ExtensionAPI;

		registerMcp(pi);

		expect(commands).toContain("mcp");
		expect(tools).toContain("mcp");
	});
});
