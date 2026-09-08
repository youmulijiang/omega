import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { formatMcpServerList, registerMcp } from "../src/mcp/index.ts";
import type { McpServerState } from "../src/mcp/native-types.ts";

describe("registerMcp", () => {
	it("registers the MCP commands and proxy tool", () => {
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
		expect(commands).toContain("mcp:list");
		expect(commands).toContain("mcp:status");
		expect(tools).toContain("mcp");
	});

	it("formats configured servers with authentication and tool information", () => {
		const states: McpServerState[] = [
			{
				name: "fetch",
				config: { type: "stdio", command: "uvx", args: ["mcp-server-fetch"] },
				status: "connected",
				tools: [{ name: "fetch", inputSchema: { type: "object" } }],
			},
			{
				name: "remote",
				config: { type: "http", url: "https://example.com/mcp", auth: "oauth" },
				status: "needs-auth",
				tools: [],
			},
			{
				name: "private",
				config: {
					type: "http",
					url: "https://example.com/private-mcp",
					headers: { authorization: "Bearer secret" },
				},
				status: "connected",
				tools: [{ name: "search", inputSchema: { type: "object" } }],
			},
		];

		expect(formatMcpServerList(states)).toBe(
			[
				"• fetch\n   • Auth: Unsupported\n   • Tools: fetch",
				"• remote\n   • Auth: OAuth (authentication required)\n   • Tools: None",
				"• private\n   • Auth: HTTP header\n   • Tools: search",
			].join("\n\n"),
		);
	});
});
