import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { formatMcpFooterStatus } from "../src/mcp/index.ts";
import { updateProjectServer } from "../src/mcp/native-config.ts";
import { OmegaMcpManager } from "../src/mcp/native-manager.ts";
import { OmegaMcpToolCache } from "../src/mcp/tool-cache.ts";

const temporaryDirectories: string[] = [];
const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-mcp-server.mjs");

// Isolate the test from user-level MCP configs (~/.config/mcp/mcp.json and
// ~/.omega/agent/mcp.json): loadMcpConfig merges them into every reload(), so
// real servers on the host would be spawned and make these tests time out.
const isolatedHome = mkdtempSync(join(tmpdir(), "omega-mcp-home-"));
temporaryDirectories.push(isolatedHome);
process.env.USERPROFILE = isolatedHome;
process.env.HOME = isolatedHome;

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) {
		// Windows keeps handles open briefly after a spawned MCP server exits;
		// retry so a timed-out child cannot fail cleanup with EPERM.
		for (let attempt = 0; attempt < 10; attempt++) {
			try {
				rmSync(directory, { recursive: true, force: true });
				break;
			} catch (error) {
				if (attempt === 9) throw error;
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
		}
	}
});

async function waitFor(check: () => boolean, timeout = 2_000): Promise<void> {
	const deadline = Date.now() + timeout;
	while (!check()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for MCP state");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

describe("OmegaMcpManager", () => {
	it("counts only tools from currently connected MCP servers in the footer", () => {
		const config = { type: "stdio" as const, command: "fixture" };
		const tool = { name: "echo", inputSchema: { type: "object" as const } };
		expect(
			formatMcpFooterStatus([
				{ name: "live", config, status: "connected", tools: [tool] },
				{ name: "cached", config, status: "error", tools: [tool, tool], toolSource: "cache" },
				{ name: "disabled", config, status: "disabled", tools: [tool], toolSource: "cache" },
			]),
		).toBe("MCP 1/3 servers · 1 tool");
	});

	it("connects to a stdio MCP server and calls a discovered tool", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "omega-mcp-manager-"));
		temporaryDirectories.push(cwd);
		updateProjectServer(cwd, "fixture", {
			type: "stdio",
			command: process.execPath,
			args: [fixturePath],
		});
		const cache = new OmegaMcpToolCache(join(cwd, "tool-cache.json"));
		const manager = new OmegaMcpManager(cwd, { toolCache: cache });

		try {
			await manager.reload(false);
			const state = await manager.connect("fixture");
			expect(state.status).toBe("connected");
			expect(manager.listTools("fixture").map(item => item.tool.name)).toEqual(["echo"]);

			const result = await manager.callTool("fixture", "echo", { text: "omega" });
			expect(result.content).toContainEqual({ type: "text", text: "echo:omega" });
		} finally {
			await manager.close();
		}
	});

	it("uses cached tools while a server is disconnected", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "omega-mcp-cache-"));
		temporaryDirectories.push(cwd);
		updateProjectServer(cwd, "fixture", {
			type: "stdio",
			command: process.execPath,
			args: [fixturePath],
		});
		const cache = new OmegaMcpToolCache(join(cwd, "tool-cache.json"));
		const manager = new OmegaMcpManager(cwd, { toolCache: cache });

		try {
			await manager.reload();
			await manager.reload(false);
			const state = manager.getStates()[0];
			expect(state).toMatchObject({ status: "disconnected", toolSource: "cache" });
			expect(manager.listTools("fixture").map((item) => item.tool.name)).toEqual(["echo"]);
		} finally {
			await manager.close();
		}
	});

	it("applies the configured timeout to tool calls", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "omega-mcp-timeout-"));
		temporaryDirectories.push(cwd);
		updateProjectServer(cwd, "fixture", {
			type: "stdio",
			command: process.execPath,
			args: [fixturePath],
			timeout: 50,
			reconnect: { enabled: false },
		});
		const manager = new OmegaMcpManager(cwd, {
			toolCache: new OmegaMcpToolCache(join(cwd, "tool-cache.json")),
		});

		try {
			await manager.reload();
			await expect(manager.callTool("fixture", "hang", {})).rejects.toThrow(/timed out/i);
		} finally {
			await manager.close();
		}
	});

	it("reconnects after an unexpected transport close", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "omega-mcp-reconnect-"));
		temporaryDirectories.push(cwd);
		const marker = join(cwd, "restart-marker");
		const counter = join(cwd, "launch-counter");
		updateProjectServer(cwd, "fixture", {
			type: "stdio",
			command: process.execPath,
			args: [fixturePath],
			env: { OMEGA_MCP_RESTART_MARKER: marker, OMEGA_MCP_LAUNCH_COUNTER: counter },
			reconnect: { initialDelay: 10, maxDelay: 20, maxRetries: 3 },
		});
		const manager = new OmegaMcpManager(cwd, {
			toolCache: new OmegaMcpToolCache(join(cwd, "tool-cache.json")),
		});

		try {
			await manager.reload();
			await waitFor(() => existsSync(counter) && Number(readFileSync(counter, "utf8")) >= 2);
			await waitFor(() => manager.getStates()[0]?.status === "connected");
			const result = await manager.callTool("fixture", "echo", { text: "reconnected" });
			expect(result.content).toContainEqual({ type: "text", text: "echo:reconnected" });
		} finally {
			await manager.close();
		}
	});
});
