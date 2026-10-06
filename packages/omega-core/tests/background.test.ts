import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OmegaAPI } from "../src/api.ts";
import { registerBackground } from "../src/background/index.ts";
import { resolveAnthropicAttributionExtensionPath } from "../src/background/core/anthropic-attribution-path.ts";
import { resolveDelegateChildExtensionPath } from "../src/background/core/delegate/launch.ts";
import {
	BackgroundTaskRegistry,
	type CompletionNotificationMessage,
	type CompletionNotificationOptions,
} from "../src/background/core/registry.ts";
import { resolveFusionChildExtensionPath } from "../src/background/core/fusion/pi-child.ts";

type CommandHandler = Parameters<ExtensionAPI["registerCommand"]>[1]["handler"];

const temporaryDirectories: string[] = [];

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("Omega background integration", () => {
	it("registers the upstream task, delegate and Fusion surfaces", () => {
		const tools: string[] = [];
		const commands: Array<{ name: string; showSourceTag?: boolean }> = [];
		const listeners = new Map<string, (value: unknown) => void>();
		const pi = {
			appendEntry: vi.fn(),
			events: {
				emit: vi.fn(),
				on: (channel: string, listener: (value: unknown) => void) => {
					listeners.set(channel, listener);
					return () => listeners.delete(channel);
				},
			},
			on: vi.fn(),
			registerCommand: (name: string, options: { showSourceTag?: boolean }) =>
				commands.push({ name, showSourceTag: options.showSourceTag }),
			registerMessageRenderer: vi.fn(),
			registerProvider: vi.fn(),
			registerShortcut: vi.fn(),
			registerTool: (tool: { name: string }) => tools.push(tool.name),
			sendMessage: vi.fn(),
		} as unknown as ExtensionAPI;

		registerBackground(pi as unknown as OmegaAPI);

		expect(tools).toEqual([
			"fusion_reason",
			"fusion_investigate",
			"fusion_research",
			"fusion_validate",
			"bg_delegate",
			"bg_result",
			"bg_run",
			"bg_run_pi_attested",
			"bg_status",
			"bg_logs",
			"bg_kill",
		]);
		expect(commands.map((command) => command.name).sort()).toEqual([
			"bg",
			"bg:claude-cache",
			"bg:clear",
			"bg:fusion",
			"bg:fusion-models",
			"bg:jobs",
			"bg:kill",
			"bg:logs",
			"bg:tasks",
		]);
		expect(commands.every((command) => command.showSourceTag === false)).toBe(true);
		expect(listeners.has("pi-background-tasks:request:v1")).toBe(true);
		expect(pi.registerProvider).toHaveBeenCalledWith("anthropic", expect.objectContaining({ api: "anthropic-messages" }));
	});

	it("resolves all vendored child extension entrypoints", () => {
		for (const path of [
			resolveAnthropicAttributionExtensionPath(),
			resolveDelegateChildExtensionPath(),
			resolveFusionChildExtensionPath(),
		]) {
			expect(path).toContain(join("background", "extensions"));
			expect(path.endsWith(".ts")).toBe(true);
		}
	});

	it("keeps background tool guidance short and fixes delegate capability to inspect", () => {
		const tools: Array<{
			name: string;
			parameters?: { properties?: Record<string, unknown> };
			promptGuidelines?: string[];
		}> = [];
		const pi = {
			appendEntry: vi.fn(),
			events: { emit: vi.fn(), on: vi.fn(() => () => undefined) },
			on: vi.fn(),
			registerCommand: vi.fn(),
			registerMessageRenderer: vi.fn(),
			registerProvider: vi.fn(),
			registerShortcut: vi.fn(),
			registerTool: (tool: (typeof tools)[number]) => tools.push(tool),
			sendMessage: vi.fn(),
		} as unknown as ExtensionAPI;
		registerBackground(pi as unknown as OmegaAPI);
		const delegate = tools.find((tool) => tool.name === "bg_delegate");
		const run = tools.find((tool) => tool.name === "bg_run");
		expect(delegate?.parameters?.properties).not.toHaveProperty("capability");
		expect(delegate?.parameters?.properties).not.toHaveProperty("autoDeliver");
		expect(delegate?.promptGuidelines).toHaveLength(2);
		expect(run?.promptGuidelines).toHaveLength(2);
	});

	it("clears one finished notice by task name and all notices when omitted", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "omega-background-clear-"));
		temporaryDirectories.push(cwd);
		const commands = new Map<string, CommandHandler>();
		const notify = vi.fn();
		const sendMessage = vi.fn();
		const pi = {
			appendEntry: vi.fn(),
			events: { emit: vi.fn(), on: vi.fn(() => () => undefined) },
			on: vi.fn(),
			registerCommand: (name: string, options: { handler: CommandHandler }) => commands.set(name, options.handler),
			registerMessageRenderer: vi.fn(),
			registerProvider: vi.fn(),
			registerShortcut: vi.fn(),
			registerTool: vi.fn(),
			sendMessage,
		} as unknown as ExtensionAPI;
		registerBackground(pi as unknown as OmegaAPI);
		const context = {
			cwd,
			hasUI: true,
			modelRegistry: { getAll: () => [] },
			ui: { notify, setStatus: vi.fn(), setWidget: vi.fn() },
		} as unknown as Parameters<CommandHandler>[1];
		const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("")}`;

		await commands.get("bg")?.(`--name "alpha task" ${command}`, context);
		await commands.get("bg")?.(`--name "beta task" ${command}`, context);
		await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));

		await commands.get("bg:clear")?.("alpha task", context);
		expect(notify).toHaveBeenLastCalledWith("Cleared finished background task notice for alpha task.", "info");

		await commands.get("bg:clear")?.("", context);
		expect(notify).toHaveBeenLastCalledWith("Cleared 1 finished background task notice.", "info");
	});

	it("runs a shell task, stores Omega artifacts, and returns bounded logs", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "omega-background-"));
		temporaryDirectories.push(cwd);
		const notifications: Array<{
			message: CompletionNotificationMessage;
			options: CompletionNotificationOptions;
		}> = [];
		const terminals: unknown[] = [];
		const registry = new BackgroundTaskRegistry({
			makeTaskId: () => "task-one",
			sendCompletionNotification: (message, options) => notifications.push({ message, options }),
			publishTerminal: (task) => terminals.push(task),
		});
		const context = { cwd, sessionId: "test-session", modelRegistry: { getAll: () => [] } };
		const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("process.stdout.write('omega-output')")}`;
		const task = await registry.startTask(context, command, {
			name: "test task",
			notifyOnCompletion: true,
			triggerOnCompletion: true,
		});
		await new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error("background test task did not finish")), 5000);
			const poll = (): void => {
				if (task.status !== "running") {
					clearTimeout(timeout);
					resolve();
				} else setTimeout(poll, 10);
			};
			poll();
		});

		expect(task.status).toBe("completed");
		expect(task.outputPath).toContain(join(".omega", "tasks"));
		expect((await registry.getTaskLogs(task, 5, true)).text).toContain("utput");
		expect(await readFile(task.metadataAbsPath, "utf8")).toContain('"status": "completed"');
		expect(notifications).toHaveLength(1);
		expect(notifications[0]?.options).toEqual({ deliverAs: "followUp", triggerTurn: true });
		expect(notifications[0]?.message.content).toContain("<guidance>Terminal state is durable;");
		expect(notifications[0]?.message.content).not.toContain("<summary>");
		expect(terminals).toHaveLength(1);
	});
});
