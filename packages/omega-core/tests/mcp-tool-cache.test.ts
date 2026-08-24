import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { McpServerConfig } from "../src/mcp/native-types.ts";
import { OmegaMcpToolCache } from "../src/mcp/tool-cache.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("OmegaMcpToolCache", () => {
	it("persists tools and invalidates them when server configuration changes", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "omega-mcp-tool-cache-"));
		temporaryDirectories.push(cwd);
		const cache = new OmegaMcpToolCache(join(cwd, "cache.json"));
		const config: McpServerConfig = { type: "http", url: "https://example.com/mcp" };
		const tools = [{ name: "search", inputSchema: { type: "object" as const } }];

		await cache.set("docs", config, tools);
		expect(await cache.get("docs", config)).toEqual(tools);
		expect(await cache.get("docs", { ...config, timeout: 1_000 })).toBeUndefined();
	});
});
