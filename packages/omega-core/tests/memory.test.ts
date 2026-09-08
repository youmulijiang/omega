import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	_clearQmdStatusCaches,
	_resetExecFileForTest,
	_resetBaseDir,
	_setExecFileForTest,
	_setBaseDir,
	clearMemoryContents,
	formatMemoryContents,
	formatMemoryStatus,
	getQmdSearchTimeoutMs,
	qmdCollectionInstructions,
	resolveMemoryDir,
	runQmdSearch,
	default as registerMemory,
} from "../src/memory/index.ts";

type CommandHandler = Parameters<ExtensionAPI["registerCommand"]>[1]["handler"];

afterEach(() => {
	_resetExecFileForTest();
	_clearQmdStatusCaches();
	_resetBaseDir();
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

describe("Omega /memory command", () => {
	it("shows long-term memory contents", () => {
		const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "omega-memory-show-"));
		_setBaseDir(baseDir);
		fs.mkdirSync(baseDir, { recursive: true });
		fs.writeFileSync(path.join(baseDir, "MEMORY.md"), "remember this", "utf8");

		expect(formatMemoryContents()).toBe("remember this");
	});

	it("reports memory inventory, previews, and daily logs", () => {
		const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "omega-memory-status-"));
		_setBaseDir(baseDir);
		fs.mkdirSync(path.join(baseDir, "daily"), { recursive: true });
		fs.writeFileSync(path.join(baseDir, "MEMORY.md"), "remember this", "utf8");
		fs.writeFileSync(path.join(baseDir, "SCRATCHPAD.md"), "- [ ] pending", "utf8");
		fs.writeFileSync(path.join(baseDir, "daily", "2026-09-07.md"), "daily note", "utf8");

		const output = formatMemoryStatus();

		expect(output).toContain("remember this");
		expect(output).toContain("pending");
		expect(output).toContain("2026-09-07.md");
	});

	it("clears memory, scratchpad, daily logs, and recovery records", () => {
		const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "omega-memory-clear-"));
		_setBaseDir(baseDir);
		fs.mkdirSync(path.join(baseDir, "daily"), { recursive: true });
		fs.mkdirSync(path.join(baseDir, "recovery"), { recursive: true });
		for (const relativePath of ["MEMORY.md", "SCRATCHPAD.md", "daily/2026-09-07.md", "recovery/item.json"]) {
			fs.writeFileSync(path.join(baseDir, relativePath), "content", "utf8");
		}

		expect(clearMemoryContents()).toEqual({ memoryFiles: 3, recoveryFiles: 1 });
		expect(fs.readdirSync(path.join(baseDir, "daily"))).toEqual([]);
		expect(fs.readdirSync(path.join(baseDir, "recovery"))).toEqual([]);
		expect(fs.existsSync(path.join(baseDir, "MEMORY.md"))).toBe(false);
	});

	it("registers show, status, and clear subcommands", async () => {
		const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "omega-memory-command-"));
		_setBaseDir(baseDir);
		fs.writeFileSync(path.join(baseDir, "MEMORY.md"), "remember this", "utf8");
		let handler: CommandHandler | undefined;
		const registerCommand = vi.fn((name: string, options: Parameters<ExtensionAPI["registerCommand"]>[1]) => {
			if (name === "memory") handler = options.handler;
		});
		registerMemory({ registerCommand, on: vi.fn(), registerTool: vi.fn() } as never);
		const notify = vi.fn();

		await handler?.("show", { ui: { notify } } as never);
		await handler?.("status", { ui: { notify } } as never);

		expect(registerCommand).toHaveBeenCalledWith(
			"memory",
			expect.objectContaining({ description: expect.stringContaining("show|status|clear"), showSourceTag: false }),
		);
		expect(notify).toHaveBeenNthCalledWith(1, "remember this", "info");
		expect(notify).toHaveBeenNthCalledWith(2, expect.stringContaining("# Memory status"), "info");
	});
});
