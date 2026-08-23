import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	getProjectMcpConfigPath,
	interpolateEnvVars,
	parseMcpConfig,
	readProjectMcpConfig,
	updateProjectServer,
} from "../src/mcp/native-config.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Omega MCP config", () => {
	it("accepts pi-mcp-adapter compatible stdio and HTTP entries", () => {
		const config = parseMcpConfig({
			mcpServers: {
				local: { command: "node", args: ["server.js"], env: { TOKEN: "test" } },
				remote: { url: "https://example.com/mcp", headers: { Authorization: "Bearer test" } },
			},
		});

		expect(config.mcpServers.local).toMatchObject({ type: "stdio", command: "node" });
		expect(config.mcpServers.remote).toMatchObject({ type: "http", url: "https://example.com/mcp" });
	});

	it("writes project configuration atomically and can remove a server", () => {
		const cwd = mkdtempSync(join(tmpdir(), "omega-mcp-"));
		temporaryDirectories.push(cwd);

		updateProjectServer(cwd, "docs", { type: "http", url: "https://example.com/mcp" });
		expect(readProjectMcpConfig(cwd).mcpServers.docs).toMatchObject({ url: "https://example.com/mcp" });
		expect(JSON.parse(readFileSync(getProjectMcpConfigPath(cwd), "utf8"))).toHaveProperty("mcpServers.docs");

		updateProjectServer(cwd, "docs", undefined);
		expect(readProjectMcpConfig(cwd).mcpServers).toEqual({});
	});

	it("rejects malformed tool configuration", () => {
		expect(() => parseMcpConfig({ mcpServers: { broken: { command: "node", args: "server.js" } } })).toThrow(
			"args must be a string array",
		);
	});

	it("expands the environment formats accepted by pi-mcp-adapter", () => {
		expect(interpolateEnvVars("${TOKEN}:$env:TOKEN:{env:TOKEN}", { TOKEN: "secret" })).toBe(
			"secret:secret:secret",
		);
	});
});
