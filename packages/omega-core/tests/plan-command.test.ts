import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { registerCommands } from "../src/commands/index.ts";

type CommandHandler = Parameters<ExtensionAPI["registerCommand"]>[1]["handler"];
type BeforeAgentStartHandler = Parameters<ExtensionAPI["on"]>[1];

describe("registerCommands", () => {
	it("registers Omega plan commands", () => {
		const pi = {
			registerCommand: vi.fn(),
			registerFlag: vi.fn(),
			registerShortcut: vi.fn(),
			on: vi.fn(),
		} as unknown as ExtensionAPI;

		registerCommands(pi);

		expect(pi.registerCommand).toHaveBeenCalledWith("plan", expect.objectContaining({ handler: expect.any(Function) }));
		expect(pi.registerCommand).toHaveBeenCalledWith(
			"plan:status",
			expect.objectContaining({ handler: expect.any(Function) }),
		);
	});

	it("activates Omega plan context", async () => {
		const commands = new Map<string, CommandHandler>();
		let beforeAgentStart: BeforeAgentStartHandler | undefined;
		const pi = {
			appendEntry: vi.fn(),
			getActiveTools: vi.fn(() => ["read", "bash", "edit", "write"]),
			registerCommand: (name: string, command: { handler: CommandHandler }) => commands.set(name, command.handler),
			registerFlag: vi.fn(),
			registerShortcut: vi.fn(),
			setActiveTools: vi.fn(),
			on: (event: string, handler: BeforeAgentStartHandler) => {
				if (event === "before_agent_start") beforeAgentStart = handler;
			},
		} as unknown as ExtensionAPI;
		const ctx = {
			sessionManager: { getSessionId: () => "plan-task-test", getBranch: () => [] },
			ui: {
				notify: vi.fn(),
				setStatus: vi.fn(),
				setWidget: vi.fn(),
				theme: { fg: (_color: string, text: string) => text },
			},
		} as Parameters<CommandHandler>[1];

		registerCommands(pi);
		await commands.get("plan")?.("", ctx);
		const result = await beforeAgentStart?.({ type: "before_agent_start" } as never, ctx as never);

		expect(result).toEqual(
			expect.objectContaining({
				message: expect.objectContaining({
					customType: "omega-plan-context",
					content: expect.stringContaining("[OMEGA PLAN MODE ACTIVE]"),
				}),
			}),
		);
	});

	it("starts the supplied prompt as a plan-mode task", async () => {
		const commands = new Map<string, CommandHandler>();
		const sendUserMessage = vi.fn();
		const setActiveTools = vi.fn();
		const appendEntry = vi.fn();
		const pi = {
			appendEntry,
			getActiveTools: vi.fn(() => ["read", "bash", "edit", "write"]),
			registerCommand: (name: string, command: { handler: CommandHandler }) => commands.set(name, command.handler),
			registerFlag: vi.fn(),
			registerShortcut: vi.fn(),
			sendUserMessage,
			setActiveTools,
			on: vi.fn(),
		} as unknown as ExtensionAPI;
		const ctx = {
			sessionManager: { getSessionId: () => "plan-prompt-test", getBranch: () => [] },
			ui: {
				notify: vi.fn(),
				setStatus: vi.fn(),
				setWidget: vi.fn(),
				theme: { fg: (_color: string, text: string) => text },
			},
		} as Parameters<CommandHandler>[1];

		registerCommands(pi);
		await commands.get("plan")?.("  analyze the authentication flow  ", ctx);

		expect(setActiveTools).toHaveBeenCalledWith(["read", "bash", "grep", "find", "ls"]);
		expect(appendEntry).toHaveBeenCalledWith(
			"omega-plan",
			expect.objectContaining({ mode: "plan", steps: [] }),
		);
		expect(sendUserMessage).toHaveBeenCalledWith("analyze the authentication flow");
	});

	it("restores the tools that were active before plan mode", async () => {
		const commands = new Map<string, CommandHandler>();
		const activeTools = ["read", "bash", "edit", "write", "mcp_scan"];
		const setActiveTools = vi.fn();
		const pi = {
			appendEntry: vi.fn(),
			getActiveTools: vi.fn(() => activeTools),
			registerCommand: (name: string, command: { handler: CommandHandler }) => commands.set(name, command.handler),
			registerFlag: vi.fn(),
			registerShortcut: vi.fn(),
			setActiveTools,
			on: vi.fn(),
		} as unknown as ExtensionAPI;
		const ctx = {
			ui: {
				notify: vi.fn(),
				setStatus: vi.fn(),
				setWidget: vi.fn(),
				theme: { fg: (_color: string, text: string) => text },
			},
		} as Parameters<CommandHandler>[1];

		registerCommands(pi);
		await commands.get("plan")?.("", ctx);
		await commands.get("plan")?.("", ctx);

		expect(setActiveTools).toHaveBeenNthCalledWith(1, ["read", "bash", "grep", "find", "ls"]);
		expect(setActiveTools).toHaveBeenNthCalledWith(2, activeTools);
	});
});
