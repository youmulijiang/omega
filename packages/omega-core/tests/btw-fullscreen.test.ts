import type {
	ExtensionCommandContext,
	KeybindingsManager,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { runBtwFullscreen, type BtwFullscreenTuiFactory } from "../src/btw/fullscreen-ui.ts";

describe("runBtwFullscreen", () => {
	it("restores the main editor before rendering the parent TUI", async () => {
		const events: string[] = [];
		let mainEditorRestored = false;
		const parent = {
			stop: () => events.push("parent.stop"),
			start: () => events.push("parent.start"),
			renderNow: () => events.push(mainEditorRestored ? "parent.render.restored" : "parent.render.stale"),
		} as unknown as TUI;
		const fullscreen = {
			start: () => events.push("fullscreen.start"),
			stop: () => events.push("fullscreen.stop"),
		} as unknown as ReturnType<BtwFullscreenTuiFactory>;
		const theme = {
			fg: (_color: string, text: string) => text,
		} as unknown as Theme;
		const keybindings = {} as KeybindingsManager;
		const ui = {
			getEditorText: () => "draft",
			setEditorText: () => undefined,
			custom: <T>(
				factory: (
					tui: TUI,
					theme: Theme,
					keybindings: KeybindingsManager,
					done: (value: T) => void,
				) => Component,
			): Promise<T> =>
				new Promise<T>((resolve) => {
					void factory(parent, theme, keybindings, (value) => {
						events.push("main-editor.restore");
						mainEditorRestored = true;
						resolve(value);
					});
				}),
		} as unknown as ExtensionCommandContext["ui"];
		const ctx = { ui } as ExtensionCommandContext;

		await expect(
			runBtwFullscreen(ctx, async () => {
				events.push("run");
				return "complete";
			}, { createTui: () => fullscreen }),
		).resolves.toBe("complete");
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(events).toEqual([
			"parent.stop",
			"fullscreen.start",
			"run",
			"fullscreen.stop",
			"parent.start",
			"main-editor.restore",
			"parent.render.restored",
		]);
	});
});
