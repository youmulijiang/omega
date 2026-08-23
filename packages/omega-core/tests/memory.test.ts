import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	_clearQmdStatusCaches,
	_resetExecFileForTest,
	_setExecFileForTest,
	getQmdSearchTimeoutMs,
	qmdCollectionInstructions,
	resolveMemoryDir,
	runQmdSearch,
} from "../src/memory/index.ts";

afterEach(() => {
	_resetExecFileForTest();
	_clearQmdStatusCaches();
});

describe("Omega memory configuration", () => {
	it("stores memory under the Omega config directory by default", () => {
		expect(resolveMemoryDir({ HOME: "/home/tester" })).toBe(path.join("/home/tester", ".omega", "agent", "memory"));
	});

	it("honors OMEGA_MEMORY_DIR", () => {
		expect(resolveMemoryDir({ OMEGA_MEMORY_DIR: "/custom/memory", HOME: "/home/tester" })).toBe(
			"/custom/memory",
		);
	});

	it("uses Omega's qmd search timeout setting", () => {
		expect(getQmdSearchTimeoutMs({ OMEGA_MEMORY_QMD_SEARCH_TIMEOUT_MS: "1234" })).toBe(1234);
	});

	it("documents the omega-memory qmd collection", () => {
		expect(qmdCollectionInstructions()).toContain("qmd collection omega-memory");
		expect(qmdCollectionInstructions()).not.toContain("pi-memory");
	});

	it("searches the omega-memory qmd collection", async () => {
		const execFile = vi.fn(
			(
				_file: string | URL,
				_args: readonly string[],
				_options: object,
				callback: (error: Error | null, stdout: string, stderr: string) => void,
			) => {
				callback(null, "[]", "");
				return undefined;
			},
		);
		_setExecFileForTest(execFile as unknown as Parameters<typeof _setExecFileForTest>[0]);

		await runQmdSearch("keyword", "target", 5);

		expect(execFile).toHaveBeenCalledWith(
			"qmd",
			["search", "--json", "-c", "omega-memory", "-n", "5", "target"],
			expect.objectContaining({ timeout: 60_000 }),
			expect.any(Function),
		);
	});
});
