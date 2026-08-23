import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { updateProjectServer } from "../src/mcp/native-config.ts";
import { OmegaMcpManager } from "../src/mcp/native-manager.ts";

const temporaryDirectories: string[] = [];
const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-mcp-server.mjs");

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("OmegaMcpManager", () => {
	it("connects to a stdio MCP server and calls a discovered tool", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "omega-mcp-manager-"));
		temporaryDirectories.push(cwd);
		updateProjectServer(cwd, "fixture", {
			type: "stdio",
			command: process.execPath,
			args: [fixturePath],
		});
		const manager = new OmegaMcpManager(cwd);

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
});
