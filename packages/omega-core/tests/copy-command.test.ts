import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { getLastAssistantOutput, registerCopyCommand } from "../src/commands/copy.ts";

type CommandHandler = Parameters<ExtensionAPI["registerCommand"]>[1]["handler"];

function assistantEntry(text: string): SessionEntry {
	return {
		type: "message",
		id: "assistant-entry",
		parentId: null,
		timestamp: "2026-09-06T00:00:00.000Z",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test-model",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop",
			timestamp: 0,
		},
	};
}

describe("Omega /copy command", () => {
	it("extracts the most recent non-empty assistant output", () => {
		const entries = [assistantEntry("older"), assistantEntry("  "), assistantEntry("latest")];

		expect(getLastAssistantOutput(entries)).toBe("latest");
	});

	it("overrides the built-in command, copies the output, and reports success", async () => {
		let handler: CommandHandler | undefined;
		const registerCommand = vi.fn((name: string, options: Parameters<ExtensionAPI["registerCommand"]>[1]) => {
			if (name === "copy") handler = options.handler;
		});
		const copy = vi.fn(async (_text: string) => {});
		const omega = { registerCommand } as unknown as ExtensionAPI;
		const notify = vi.fn();

		registerCopyCommand(omega, copy);
		expect(registerCommand).toHaveBeenCalledWith(
			"copy",
			expect.objectContaining({ overrideBuiltin: true, showSourceTag: false }),
		);

		await handler?.("", {
			sessionManager: { getBranch: () => [assistantEntry("command output")] },
			ui: { notify },
		} as unknown as Parameters<CommandHandler>[1]);

		expect(copy).toHaveBeenCalledWith("command output");
		expect(notify).toHaveBeenCalledWith("Copied successfully", "info");
	});

	it("warns when there is no assistant output", async () => {
		let handler: CommandHandler | undefined;
		const omega = {
			registerCommand: (_name: string, options: Parameters<ExtensionAPI["registerCommand"]>[1]) => {
				handler = options.handler;
			},
		} as unknown as ExtensionAPI;
		const notify = vi.fn();
		const copy = vi.fn(async (_text: string) => {});

		registerCopyCommand(omega, copy);
		await handler?.("", {
			sessionManager: { getBranch: () => [] },
			ui: { notify },
		} as unknown as Parameters<CommandHandler>[1]);

		expect(copy).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith("No assistant output to copy", "warning");
	});
});
