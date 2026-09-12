import { type Component, getKeybindings, Markdown, setKeybindings, Text, type TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionSidebarOptions } from "../src/core/extensions/types.ts";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import type { Theme } from "../src/modes/interactive/theme/theme.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

type SidebarFactory = (
	tui: TUI,
	theme: Theme,
	footerData: ReadonlyFooterDataProvider,
) => Component & { dispose?(): void };

interface SidebarHarness {
	customSidebar?: Component & { dispose?(): void };
	customSidebarOptions: Required<ExtensionSidebarOptions>;
	chatViewportRoot: Component;
	fullscreenLayoutRoot?: Component;
	renderer: TUI;
	ui: TUI;
	footerDataProvider: ReadonlyFooterDataProvider;
}

describe("interactive sidebar lifecycle", () => {
	it("shows configured sidebar shortcuts only in the existing /hotkeys command", () => {
		expect(BUILTIN_SLASH_COMMANDS.map((command) => command.name)).toContain("hotkeys");
		expect(BUILTIN_SLASH_COMMANDS.map((command) => command.name)).not.toContain("hotkey");
		const previousBindings = getKeybindings();
		initTheme("dark");
		setKeybindings(new KeybindingsManager({ "app.sidebar.focus": "f8" }));
		const children: Component[] = [];
		const hotkeyMethods = InteractiveMode.prototype as unknown as {
			handleHotkeysCommand(this: object): void;
			getAppKeyDisplay: (action: string) => string;
			getEditorKeyDisplay: (action: string) => string;
		};
		const context = {
			chatContainer: { addChild: (child: Component) => children.push(child) },
			session: { extensionRunner: { getShortcuts: () => new Map() } },
			keybindings: { getEffectiveConfig: () => ({}) },
			ui: { requestRender: vi.fn() },
			getMarkdownThemeWithSettings: () => ({}),
			getAppKeyDisplay: hotkeyMethods.getAppKeyDisplay,
			getEditorKeyDisplay: hotkeyMethods.getEditorKeyDisplay,
		};
		try {
			hotkeyMethods.handleHotkeysCommand.call(context);
			const markdown = children.find((child) => child instanceof Markdown) as Markdown | undefined;
			const content = (markdown as unknown as { text: string }).text;
			expect(content).toContain("**Sidebar (fullscreen)**");
			expect(content).toContain("`F8` | Focus sidebar / return to editor");
			expect(content).toContain("Expand / collapse animation");
		} finally {
			setKeybindings(previousBindings);
		}
	});

	it("exposes configurable navigation bindings", () => {
		const defaults = new KeybindingsManager();
		expect(defaults.getKeys("app.sidebar.previousTab")).toEqual(["ctrl+alt+h"]);
		expect(defaults.getKeys("app.sidebar.nextTab")).toEqual(["ctrl+alt+l"]);
		expect(defaults.getKeys("app.sidebar.focus")).toEqual(["f6"]);
		expect(defaults.getKeys("app.sidebar.switchPanel")).toEqual(["f7"]);
		expect(defaults.getKeys("app.sidebar.toggleArt")).toEqual(["ctrl+o"]);
		const customized = new KeybindingsManager({ "app.sidebar.nextTab": "ctrl+alt+n" });
		expect(customized.getKeys("app.sidebar.nextTab")).toEqual(["ctrl+alt+n"]);
	});

	it("rebuilds the fullscreen layout and disposes each replaced component once", () => {
		const requestRender = vi.fn();
		const setLayoutRoot = vi.fn();
		const renderer = {
			mode: "fullscreen",
			[Symbol.for("@earendil-works/pi-tui/viewport")]: true,
			setLayoutRoot,
			requestRender,
		} as unknown as TUI;
		const context = Object.assign(Object.create(InteractiveMode.prototype), {
			customSidebar: undefined,
			customSidebarOptions: { width: 44, side: "right", minTerminalWidth: 100, minTerminalHeight: 18 },
			chatViewportRoot: new Text("chat", 0, 0),
			fullscreenLayoutRoot: undefined,
			renderer,
			ui: renderer,
			footerDataProvider: { getGitBranch: () => "main" },
		}) as SidebarHarness;
		const { setExtensionSidebar } = InteractiveMode.prototype as unknown as {
			setExtensionSidebar(
				this: SidebarHarness,
				factory: SidebarFactory | undefined,
				options?: ExtensionSidebarOptions,
			): void;
		};
		const firstDispose = vi.fn();
		const secondDispose = vi.fn();

		setExtensionSidebar.call(context, () => ({
			render: () => ["first"],
			invalidate: () => {},
			dispose: firstDispose,
		}));
		expect(setLayoutRoot).toHaveBeenCalledWith(context.fullscreenLayoutRoot);
		setExtensionSidebar.call(
			context,
			() => ({ render: () => ["second"], invalidate: () => {}, dispose: secondDispose }),
			{ width: 40, side: "left", minTerminalWidth: 90, minTerminalHeight: 20 },
		);
		expect(firstDispose).toHaveBeenCalledTimes(1);
		expect(context.customSidebarOptions).toEqual({
			width: 40,
			side: "left",
			minTerminalWidth: 90,
			minTerminalHeight: 20,
		});
		setExtensionSidebar.call(context, undefined);
		setExtensionSidebar.call(context, undefined);
		expect(secondDispose).toHaveBeenCalledTimes(1);
		expect(context.fullscreenLayoutRoot).toBe(context.chatViewportRoot);
		expect(requestRender).toHaveBeenCalledTimes(4);
	});
});
