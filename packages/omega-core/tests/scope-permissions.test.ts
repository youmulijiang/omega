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
type CommandHandler = Parameters<ExtensionAPI["registerCommand"]>[1]["handler"];

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
			registerCommand: vi.fn(),
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
		const pi = {
			on: (event: string, handler: EventHandler) => handlers.set(event, handler),
			registerCommand: vi.fn(),
		} as unknown as ExtensionAPI;
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

	it("asks before destructive deletion and only remembers an exact command for the session", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "omega-dangerous-command-"));
		temporaryDirectories.push(cwd);
		const agentDirectory = join(cwd, ".omega", "agent");
		mkdirSync(agentDirectory, { recursive: true });
		writeFileSync(join(agentDirectory, "permissions.json"), JSON.stringify({ level: "ask for approval" }), "utf8");
		const handlers = new Map<string, EventHandler>();
		const pi = {
			on: (event: string, handler: EventHandler) => handlers.set(event, handler),
			registerCommand: vi.fn(),
		} as unknown as ExtensionAPI;
		const select = vi.fn().mockResolvedValueOnce("允许本会话中的相同命令").mockResolvedValueOnce("拒绝执行");
		const ctx = {
			cwd,
			hasUI: true,
			ui: { confirm: vi.fn(), notify: vi.fn(), select, setStatus: vi.fn() },
		};
		registerPermissions(pi);
		await handlers.get("session_start")?.({ type: "session_start" } as never, ctx as never);

		const first = await handlers.get("tool_call")?.(
			{ type: "tool_call", toolName: "bash", input: { command: "rm -rf *" } } as never,
			ctx as never,
		);
		const repeated = await handlers.get("tool_call")?.(
			{ type: "tool_call", toolName: "bash", input: { command: "rm -rf *" } } as never,
			ctx as never,
		);
		const different = await handlers.get("tool_call")?.(
			{ type: "tool_call", toolName: "bash", input: { command: "rm -rf ./generated" } } as never,
			ctx as never,
		);

		expect(first).toBeUndefined();
		expect(repeated).toBeUndefined();
		expect(different).toEqual({ block: true, reason: "用户取消执行" });
		expect(select).toHaveBeenCalledTimes(2);
		expect(select).toHaveBeenNthCalledWith(
			1,
			expect.stringContaining("删除命令包含通配符"),
			["仅允许本次执行", "允许本会话中的相同命令", "拒绝执行"],
		);
	});

	it("loads project JSON rules with last-match overrides", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "omega-permission-policy-"));
		temporaryDirectories.push(cwd);
		const agentDirectory = join(cwd, ".omega", "agent");
		mkdirSync(agentDirectory, { recursive: true });
		writeFileSync(
			join(agentDirectory, "permissions.json"),
			JSON.stringify({ level: "ask for approval", bash: { "rm *": "allow", "echo forbidden": "deny", "curl *": "ask" } }),
			"utf8",
		);
		const handlers = new Map<string, EventHandler>();
		const pi = {
			on: (event: string, handler: EventHandler) => handlers.set(event, handler),
			registerCommand: vi.fn(),
		} as unknown as ExtensionAPI;
		const select = vi.fn().mockResolvedValue("仅允许本次执行");
		const ctx = {
			cwd,
			hasUI: true,
			ui: { confirm: vi.fn(), notify: vi.fn(), select, setStatus: vi.fn() },
		};
		registerPermissions(pi);
		await handlers.get("session_start")?.({ type: "session_start" } as never, ctx as never);

		const allowed = await handlers.get("tool_call")?.(
			{ type: "tool_call", toolName: "bash", input: { command: "rm temporary.txt" } } as never,
			ctx as never,
		);
		const denied = await handlers.get("tool_call")?.(
			{ type: "tool_call", toolName: "bash", input: { command: "echo forbidden" } } as never,
			ctx as never,
		);
		const asked = await handlers.get("tool_call")?.(
			{ type: "tool_call", toolName: "bash", input: { command: "curl https://example.test" } } as never,
			ctx as never,
		);

		expect(allowed).toBeUndefined();
		expect(denied).toEqual(expect.objectContaining({ block: true, reason: expect.stringContaining("权限策略拒绝") }));
		expect(asked).toBeUndefined();
		expect(select).toHaveBeenCalledOnce();
	});

	it("never allows built-in catastrophic operations even in full access", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "omega-hard-deny-"));
		temporaryDirectories.push(cwd);
		const handlers = new Map<string, EventHandler>();
		const pi = {
			on: (event: string, handler: EventHandler) => handlers.set(event, handler),
			registerCommand: vi.fn(),
		} as unknown as ExtensionAPI;
		const ctx = {
			cwd,
			hasUI: true,
			ui: { confirm: vi.fn(), notify: vi.fn(), select: vi.fn(), setStatus: vi.fn() },
		};
		registerPermissions(pi);
		await handlers.get("session_start")?.({ type: "session_start" } as never, ctx as never);

		const filesystem = await handlers.get("tool_call")?.(
			{ type: "tool_call", toolName: "bash", input: { command: "rm -rf /" } } as never,
			ctx as never,
		);
		const database = await handlers.get("tool_call")?.(
			{ type: "tool_call", toolName: "bash", input: { command: "psql -c 'DROP DATABASE production'" } } as never,
			ctx as never,
		);

		expect(filesystem).toEqual(expect.objectContaining({ block: true, reason: expect.stringContaining("整个文件系统") }));
		expect(database).toEqual(expect.objectContaining({ block: true, reason: expect.stringContaining("数据库") }));
	});

	it("switches permission levels with /permissions", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "omega-permission-level-"));
		temporaryDirectories.push(cwd);
		const handlers = new Map<string, EventHandler>();
		const commands = new Map<string, CommandHandler>();
		const pi = {
			on: (event: string, handler: EventHandler) => handlers.set(event, handler),
			registerCommand: (name: string, command: { handler: CommandHandler }) => commands.set(name, command.handler),
		} as unknown as ExtensionAPI;
		const select = vi.fn().mockResolvedValue("仅允许本次执行");
		const notify = vi.fn();
		const ctx = {
			cwd,
			hasUI: true,
			ui: { confirm: vi.fn(), notify, select, setStatus: vi.fn() },
		};
		registerPermissions(pi);
		await handlers.get("session_start")?.({ type: "session_start" } as never, ctx as never);

		await commands.get("permissions")?.("ask for approval", ctx as Parameters<CommandHandler>[1]);
		await handlers.get("tool_call")?.(
			{ type: "tool_call", toolName: "bash", input: { command: "nmap target.test" } } as never,
			ctx as never,
		);
		await commands.get("permissions")?.("approve for me", ctx as Parameters<CommandHandler>[1]);
		await handlers.get("tool_call")?.(
			{ type: "tool_call", toolName: "bash", input: { command: "nmap another.test" } } as never,
			ctx as never,
		);

		expect(select).toHaveBeenCalledOnce();
		expect(notify).toHaveBeenCalledWith("权限等级已切换为：approve for me", "info");
	});

	it("selects a permission level when /permissions has no arguments", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "omega-permission-select-"));
		temporaryDirectories.push(cwd);
		const handlers = new Map<string, EventHandler>();
		const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
		const pi = {
			on: (event: string, handler: EventHandler) => handlers.set(event, handler),
			registerCommand: (name: string, command: Parameters<ExtensionAPI["registerCommand"]>[1]) =>
				commands.set(name, command),
		} as unknown as ExtensionAPI;
		const select = vi.fn().mockResolvedValue("ask for approval");
		const notify = vi.fn();
		const setStatus = vi.fn();
		const ctx = {
			cwd,
			hasUI: true,
			ui: { confirm: vi.fn(), notify, select, setStatus },
		};
		registerPermissions(pi);
		await handlers.get("session_start")?.({ type: "session_start" } as never, ctx as never);

		await commands.get("permissions")?.handler("", ctx as Parameters<CommandHandler>[1]);
		const allCompletions = await commands.get("permissions")?.getArgumentCompletions?.("");
		const approveCompletions = await commands.get("permissions")?.getArgumentCompletions?.("app");

		expect(select).toHaveBeenCalledWith("选择权限等级（当前：full access）", [
			"ask for approval",
			"approve for me",
			"full access",
		]);
		expect(allCompletions).toEqual([
			{ value: "ask for approval", label: "ask for approval" },
			{ value: "approve for me", label: "approve for me" },
			{ value: "full access", label: "full access" },
		]);
		expect(approveCompletions).toEqual([{ value: "approve for me", label: "approve for me" }]);
		expect(setStatus).toHaveBeenLastCalledWith("omega-permissions", "Permissions: ask for approval");
		expect(notify).toHaveBeenCalledWith("权限等级已切换为：ask for approval", "info");
	});

	it("forces approval when deleting more than twenty files", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "omega-bulk-delete-"));
		temporaryDirectories.push(cwd);
		const target = join(cwd, "generated");
		mkdirSync(target);
		for (let index = 0; index < 21; index += 1) writeFileSync(join(target, `${String(index)}.txt`), "x");
		const handlers = new Map<string, EventHandler>();
		const pi = {
			on: (event: string, handler: EventHandler) => handlers.set(event, handler),
			registerCommand: vi.fn(),
		} as unknown as ExtensionAPI;
		const select = vi.fn().mockResolvedValue("拒绝执行");
		const ctx = {
			cwd,
			hasUI: true,
			ui: { confirm: vi.fn(), notify: vi.fn(), select, setStatus: vi.fn() },
		};
		registerPermissions(pi);
		await handlers.get("session_start")?.({ type: "session_start" } as never, ctx as never);

		const result = await handlers.get("tool_call")?.(
			{ type: "tool_call", toolName: "bash", input: { command: "rm -rf generated" } } as never,
			ctx as never,
		);

		expect(result).toEqual({ block: true, reason: "用户取消执行" });
		expect(select).toHaveBeenCalledWith(expect.stringContaining("超过 20 个"), expect.any(Array));
	});
});
