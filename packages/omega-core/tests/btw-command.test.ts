import type { Api, Model } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { registerBtw } from "../src/btw/index.ts";

vi.mock("../src/btw/transcript-pager.ts", () => ({
	BtwAnsweringView: class {},
	BtwTranscriptPager: class {},
}));

type CommandHandler = Parameters<ExtensionAPI["registerCommand"]>[1]["handler"];

describe("registerBtw", () => {
	it("registers /btw and runs a direct side question", async () => {
		let handler: CommandHandler | undefined;
		const pi = {
			getThinkingLevel: () => "off",
			registerCommand: (name: string, command: { handler: CommandHandler }) => {
				if (name === "btw") handler = command.handler;
			},
		} as unknown as ExtensionAPI;
		const model = { provider: "test", id: "side-model" } as Model<Api>;
		const ctx = {
			mode: "tui",
			sessionManager: { getBranch: () => [] },
			ui: { notify: vi.fn() },
		} as unknown as ExtensionCommandContext;
		const runThread = vi.fn(async () => ({ kind: "closed" as const }));

		registerBtw(pi, {
			loadSettings: async () => ({}),
			resolveModel: async () => ({
				kind: "selected",
				selected: { model, auth: { apiKey: "test-key" } },
			}),
			runFullscreen: async (commandContext, run) => run(commandContext),
			runThread,
		});

		expect(handler).toBeTypeOf("function");
		await handler?.("what changed?", ctx);

		expect(runThread).toHaveBeenCalledOnce();
		expect(runThread).toHaveBeenCalledWith(
			expect.objectContaining({
				initialQuestion: "what changed?",
				selected: { model, auth: { apiKey: "test-key" } },
				thinkingLevel: "off",
			}),
		);
	});
});
