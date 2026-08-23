import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerPermissions } from "../src/permissions/index.ts";
import {
	extractTargetsFromInput,
	parseScopeMarkdown,
	scopeContainsTarget,
} from "../src/permissions/scope.ts";

type EventHandler = (...args: never[]) => unknown;

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const SCOPE_CONTENT = [
	"# scope.md",
	"project: omega",
	"",
	"## Inclusion",
	"",
	"- 10.0.0.0/24",
	"",
	"### url",
	"",
	"- https://example.com",
	"",
	"## Exclusions",
	"",
	"### domain",
	"",
	"- admin.example.com",
].join("\n");

describe("scope permissions", () => {
	it("parses Inclusion, Exclusions, metadata, and supplemental level-three types", () => {
		const scope = parseScopeMarkdown(SCOPE_CONTENT);

		expect(scope.inclusions).toEqual([
			{ value: "10.0.0.0/24" },
			{ value: "https://example.com", type: "url" },
		]);
		expect(scope.exclusions).toEqual([{ value: "admin.example.com", type: "domain" }]);
	});

	it("matches CIDR, URL path, and domain scopes", () => {
		const scope = parseScopeMarkdown(SCOPE_CONTENT);

		expect(scopeContainsTarget(scope.inclusions, "10.0.0.42")).toBe(true);
		expect(scopeContainsTarget(scope.inclusions, "10.0.1.42")).toBe(false);
		expect(scopeContainsTarget(scope.inclusions, "https://example.com/api")).toBe(true);
		expect(scopeContainsTarget(scope.exclusions, "https://sub.admin.example.com/login")).toBe(true);
	});

	it("extracts network targets without treating ordinary file paths as domains", () => {
		expect(extractTargetsFromInput({ command: "nmap 10.0.0.8 unknown.test" })).toEqual(["10.0.0.8", "unknown.test"]);
		expect(extractTargetsFromInput({ path: ".omega/agent/scope.md" })).toEqual([]);
		expect(extractTargetsFromInput({ url: "https://example.com/api" })).toEqual(["https://example.com/api"]);
	});

	it("only prompts for targets outside Inclusion and caches the decision", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "omega-scope-"));
		temporaryDirectories.push(cwd);
		const agentDirectory = join(cwd, ".omega", "agent");
		mkdirSync(agentDirectory, { recursive: true });
		writeFileSync(join(agentDirectory, "scope.md"), SCOPE_CONTENT, "utf8");

		const handlers = new Map<string, EventHandler>();
		const pi = {
			on: (event: string, handler: EventHandler) => handlers.set(event, handler),
		} as unknown as ExtensionAPI;
		const confirm = vi.fn().mockResolvedValue(true);
		const ctx = {
			cwd,
			hasUI: true,
			ui: { confirm, notify: vi.fn(), select: vi.fn(), setStatus: vi.fn() },
		};
		registerPermissions(pi);

		await handlers.get("session_start")?.({ type: "session_start" } as never, ctx as never);
		const included = await handlers.get("tool_call")?.(
			{ type: "tool_call", toolName: "mcp", input: { url: "https://example.com/api" } } as never,
			ctx as never,
		);
		const unknownFirst = await handlers.get("tool_call")?.(
			{ type: "tool_call", toolName: "mcp", input: { url: "https://outside.test" } } as never,
			ctx as never,
		);
		const unknownAgain = await handlers.get("tool_call")?.(
			{ type: "tool_call", toolName: "mcp", input: { url: "https://outside.test" } } as never,
			ctx as never,
		);
		const excluded = await handlers.get("tool_call")?.(
			{ type: "tool_call", toolName: "mcp", input: { url: "https://admin.example.com" } } as never,
			ctx as never,
		);

		expect(included).toBeUndefined();
		expect(unknownFirst).toBeUndefined();
		expect(unknownAgain).toBeUndefined();
		expect(confirm).toHaveBeenCalledTimes(1);
		expect(confirm).toHaveBeenCalledWith("OMEGA Scope 范围外目标确认", expect.stringContaining("outside.test"));
		expect(excluded).toEqual(expect.objectContaining({ block: true, reason: expect.stringContaining("Exclusions") }));
	});

	it("blocks an out-of-scope target when the user rejects it", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "omega-scope-reject-"));
		temporaryDirectories.push(cwd);
		const agentDirectory = join(cwd, ".omega", "agent");
		mkdirSync(agentDirectory, { recursive: true });
		writeFileSync(join(agentDirectory, "scope.md"), SCOPE_CONTENT, "utf8");

		const handlers = new Map<string, EventHandler>();
		const pi = { on: (event: string, handler: EventHandler) => handlers.set(event, handler) } as unknown as ExtensionAPI;
		const ctx = {
			cwd,
			hasUI: true,
			ui: { confirm: vi.fn().mockResolvedValue(false), notify: vi.fn(), setStatus: vi.fn() },
		};
		registerPermissions(pi);
		await handlers.get("session_start")?.({ type: "session_start" } as never, ctx as never);

		const result = await handlers.get("tool_call")?.(
			{ type: "tool_call", toolName: "mcp", input: { target: "outside.test" } } as never,
			ctx as never,
		);

		expect(result).toEqual(expect.objectContaining({ block: true, reason: expect.stringContaining("用户拒绝") }));
	});
});
