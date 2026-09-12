import type { ExtensionContext, ReadonlyFooterDataProvider, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI, TuiMouseEvent } from "@earendil-works/pi-tui";
import { getKeybindings, setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../../coding-agent/src/core/keybindings.ts";
import type { OmegaAPI } from "../src/api.ts";
import { type McpStatusEntry, MCP_STATUS_CHANNEL } from "../src/mcp/status-events.ts";
import { OmegaSidebar, setupSidebar } from "../src/ui/sidebar.ts";
import { renderAsciiGlobe, renderAttackMap, renderTerminalScene, SIDEBAR_CONTINENTS, visibleGlobeLabels } from "../src/ui/sidebar-art.ts";

const plainTheme = {
	fg: (_color: string, value: string) => value,
	bold: (value: string) => value,
} as Theme;

function createFixture(entries: unknown[] = [], side: "left" | "right" = "right") {
	const requestRender = vi.fn();
	let onBranchChange: (() => void) | undefined;
	const unsubscribe = vi.fn();
	const extensionStatuses = new Map([["omega-permissions", "Permissions: full access"]]);
	let focusedComponent: { focused?: boolean } | null = { focused: true };
	const editor = focusedComponent;
	const tui = {
		mode: "fullscreen",
		terminal: { columns: 120, rows: 28 },
		requestRender,
		hasOverlay: () => false,
		getFocusedComponent: () => focusedComponent,
		setFocus: (component: { focused?: boolean } | null) => {
			if (focusedComponent) focusedComponent.focused = false;
			focusedComponent = component;
			if (component) component.focused = true;
		},
	} as unknown as TUI;
	const footer = {
		getGitBranch: () => "main",
		getExtensionStatuses: () => extensionStatuses,
		onBranchChange: (callback: () => void) => {
			onBranchChange = callback;
			return unsubscribe;
		},
	} as unknown as ReadonlyFooterDataProvider;
	const ctx = {
		cwd: "/tmp/omega",
		model: { provider: "demo", id: "model" },
		thinkingLevel: "high",
		isIdle: () => true,
		getContextUsage: () => ({ tokens: 500, contextWindow: 10_000, percent: 5 }),
		sessionManager: { getSessionId: () => "session-1", getBranch: () => entries },
	} as unknown as ExtensionContext;
	let clock = 10_000;
	const sidebar = new OmegaSidebar(tui, plainTheme, footer, ctx, () => clock, 100, side);
	return { sidebar, tui, footer, ctx, extensionStatuses, editor, getFocused: () => focusedComponent, requestRender, unsubscribe, onBranchChange, advance: (ms: number) => (clock += ms) };
}

function click(x: number, y: number): TuiMouseEvent {
	return {
		type: "click",
		button: "left",
		x,
		y,
		screenX: x,
		screenY: y,
		width: 44,
		height: 28,
		shift: false,
		alt: false,
		ctrl: false,
	};
}

describe("Omega sidebar", () => {
	it("registers on/off/width commands and applies the width on remount", async () => {
		const handlers = new Map<string, (...args: unknown[]) => unknown>();
		let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
		const setSidebar = vi.fn();
		const notify = vi.fn();
		const ui = { setSidebar, onTerminalInput: vi.fn(), notify };
		const ctx = { mode: "tui", ui };
		const omega = {
			on: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler),
			registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
				if (name === "sidebar") command = options.handler;
			},
			events: { on: () => () => {}, emit: vi.fn() },
		} as unknown as OmegaAPI;
		setupSidebar(omega);
		handlers.get("session_start")?.({}, ctx);
		expect(setSidebar).toHaveBeenLastCalledWith(expect.any(Function), {
			width: 44,
			side: "right",
			minTerminalWidth: 100,
			minTerminalHeight: 18,
		});
		await command?.("off", ctx);
		expect(setSidebar).toHaveBeenLastCalledWith(undefined);
		await command?.("wight 62", ctx);
		await command?.("on", ctx);
		expect(setSidebar).toHaveBeenLastCalledWith(expect.any(Function), {
			width: 62,
			side: "right",
			minTerminalWidth: 102,
			minTerminalHeight: 18,
		});
		await command?.("left", ctx);
		expect(setSidebar).toHaveBeenLastCalledWith(expect.any(Function), {
			width: 62,
			side: "left",
			minTerminalWidth: 102,
			minTerminalHeight: 18,
		});
		await command?.("width 81", ctx);
		expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("24 to 80"), "error");
	});

	it("renders the three panels, changes tabs by click and keyboard action, and releases its listener", () => {
		const fixture = createFixture();
		const { sidebar } = fixture;
		try {
			const status = sidebar.render(44);
			expect(status.join("\n")).toContain("demo/model");
			expect(status.join("\n")).toContain("Permissions  full access");
			expect(status.join("\n")).toContain("█░");
			expect(status).toHaveLength(28);
			expect(status.every((line) => visibleWidth(line) === 44)).toBe(true);
			expect(sidebar.handleMouse(click(13, 0))).toEqual({ handled: true, render: true });
			expect(sidebar.getSelectedTab()).toBe("tasks");
			sidebar.cycleTab(1);
			expect(sidebar.getSelectedTab()).toBe("system");
			sidebar.focus();
			expect(fixture.getFocused()).toBe(sidebar);
			sidebar.handleInput("\t");
			expect(sidebar.getSelectedTab()).toBe("status");
			sidebar.switchPanel();
			expect(sidebar.getActivePanel()).toBe("art");
			sidebar.handleInput("\t");
			expect(sidebar.getArtMode()).toBe("globe");
			sidebar.handleInput("\t");
			expect(sidebar.getArtMode()).toBe("attack");
			sidebar.handleInput("\t");
			expect(sidebar.getArtMode()).toBe("terminal");
			expect(sidebar.render(44).join("\n")).toContain("TERMINAL SIM");
			sidebar.switchPanel();
			expect(sidebar.getActivePanel()).toBe("tabs");
			sidebar.handleInput("\x1b");
			expect(fixture.getFocused()).toBe(fixture.editor);
			sidebar.selectTab("system");
			expect(sidebar.render(44).join("\n")).toContain("Branch main");
			fixture.onBranchChange?.();
			expect(fixture.requestRender).toHaveBeenCalled();
		} finally {
			sidebar.dispose();
			sidebar.dispose();
		}
		expect(fixture.unsubscribe).toHaveBeenCalledTimes(1);
	});

	it("reads the current permission level from extension status updates", () => {
		const fixture = createFixture();
		try {
			fixture.extensionStatuses.set("omega-permissions", "Permissions: ask for approval");
			expect(fixture.sidebar.render(44).join("\n")).toContain("Permissions  ask for approval");
			fixture.extensionStatuses.set("omega-permissions", "Permissions: approve for me");
			expect(fixture.sidebar.render(44).join("\n")).toContain("Permissions  approve for me");
			expect(fixture.sidebar.render(44).join("\n")).not.toContain("Phase");
		} finally {
			fixture.sidebar.dispose();
		}
	});

	it("renders live MCP states in STATUS and toggles the list by clicking its heading", () => {
		const fixture = createFixture();
		const states: McpStatusEntry[] = [
			{ name: "burp", status: "error", error: "MCP error -32603: Not connected to the server" },
			{ name: "chrome-devtools", status: "connected" },
			{ name: "playwright", status: "connecting" },
		];
		try {
			fixture.sidebar.updateMcpStates(states);
			const expanded = fixture.sidebar.render(44);
			const heading = expanded.findIndex((line) => line.includes("MCP 1/3"));
			expect(heading).toBeGreaterThan(0);
			expect(expanded.join("\n")).toContain("burp");
			expect(expanded.join("\n")).toContain("chrome-devtools Connected");
			expect(expanded.join("\n")).toContain("-32603");
			expect(expanded.every((line) => visibleWidth(line) === 44)).toBe(true);
			expect(fixture.sidebar.handleMouse(click(4, heading))).toEqual({ handled: true, render: true });
			expect(fixture.sidebar.isMcpExpanded()).toBe(false);
			const collapsed = fixture.sidebar.render(44);
			expect(collapsed.join("\n")).toContain("MCP 1/3");
			expect(collapsed.join("\n")).not.toContain("chrome-devtools");
			expect(fixture.sidebar.handleMouse(click(4, collapsed.findIndex((line) => line.includes("MCP 1/3"))))).toEqual({
				handled: true,
				render: true,
			});
			expect(fixture.sidebar.isMcpExpanded()).toBe(true);
		} finally {
			fixture.sidebar.dispose();
		}
	});

	it("receives MCP state snapshots before mount and while the session is running", () => {
		const fixture = createFixture();
		const eventListeners = new Map<string, (value: unknown) => void>();
		const handlers = new Map<string, (...args: unknown[]) => unknown>();
		let mounted: OmegaSidebar | undefined;
		const ui = {
			setSidebar: (factory?: (tui: TUI, theme: Theme, footer: ReadonlyFooterDataProvider) => OmegaSidebar) => {
				mounted?.dispose();
				mounted = factory?.(fixture.tui, plainTheme, fixture.footer);
			},
			onTerminalInput: vi.fn(),
		};
		const ctx = Object.assign(fixture.ctx, { mode: "tui", ui });
		const omega = {
			on: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler),
			registerCommand: vi.fn(),
			events: {
				on: (channel: string, handler: (value: unknown) => void) => {
					eventListeners.set(channel, handler);
					return () => eventListeners.delete(channel);
				},
				emit: (channel: string, value: unknown) => eventListeners.get(channel)?.(value),
			},
		} as unknown as OmegaAPI;
		try {
			setupSidebar(omega);
			omega.events.emit(MCP_STATUS_CHANNEL, [{ name: "burp", status: "error", error: "Not connected" }]);
			handlers.get("session_start")?.({}, ctx);
			expect(mounted?.render(44).join("\n")).toContain("burp Error: Not connected");
			omega.events.emit(MCP_STATUS_CHANNEL, [{ name: "burp", status: "connected" }]);
			expect(mounted?.render(44).join("\n")).toContain("burp Connected");
		} finally {
			mounted?.dispose();
			fixture.sidebar.dispose();
		}
	});

	it("scrolls overflowing MCP details without losing the status summary", () => {
		const fixture = createFixture();
		try {
			fixture.sidebar.updateMcpStates(
				Array.from({ length: 18 }, (_, index): McpStatusEntry => ({ name: `server-${index}`, status: "connected" })),
			);
			const before = fixture.sidebar.render(44);
			expect(before.join("\n")).toContain("server-0");
			expect(before.join("\n")).not.toContain("server-17");
			const heading = before.findIndex((line) => line.includes("MCP 18/18"));
			fixture.sidebar.handleMouse({ ...click(4, heading + 1), type: "wheel", button: "none", wheelDelta: 20 });
			const after = fixture.sidebar.render(44);
			expect(after.join("\n")).toContain("server-17");
			expect(after.join("\n")).toContain("Model  demo/model");
		} finally {
			fixture.sidebar.dispose();
		}
	});

	it("collapses only the animation with Ctrl+O while its panel is focused", () => {
		const previousBindings = getKeybindings();
		setKeybindings(new KeybindingsManager());
		const fixture = createFixture();
		try {
			fixture.sidebar.focus();
			fixture.sidebar.selectPanel("art");
			fixture.sidebar.handleInput("\x0f");
			expect(fixture.sidebar.isArtExpanded()).toBe(false);
			const collapsed = fixture.sidebar.render(44);
			expect(collapsed).toHaveLength(28);
			expect(collapsed.at(-1)).toContain("[+]");
			expect(collapsed.at(-1)).not.toContain("CLOSED");
			expect(collapsed.filter((line) => line.includes("GLOBE · AUTO"))).toHaveLength(1);
			fixture.sidebar.handleInput("\x0f");
			expect(fixture.sidebar.isArtExpanded()).toBe(true);
			expect(fixture.sidebar.render(44).join("\n")).toContain("GLOBE · AUTO");
			expect(fixture.sidebar.render(44).join("\n")).not.toContain("OPEN");
		} finally {
			fixture.sidebar.dispose();
			setKeybindings(previousBindings);
		}
	});

	it("places the border on the chat-facing edge when docked left", () => {
		const fixture = createFixture([], "left");
		try {
			const lines = fixture.sidebar.render(44);
			expect(lines[0]?.endsWith("│")).toBe(true);
			expect(lines[1]?.endsWith("┤")).toBe(true);
			expect(lines.every((line) => visibleWidth(line) === 44)).toBe(true);
			expect(fixture.sidebar.handleMouse(click(12, 0))).toEqual({ handled: true, render: true });
			expect(fixture.sidebar.getSelectedTab()).toBe("tasks");
		} finally {
			fixture.sidebar.dispose();
		}
	});

	it.each(["left", "right"] as const)("toggles the animation with the %s title button", (side) => {
		const fixture = createFixture([], side);
		try {
			const expanded = fixture.sidebar.render(44);
			const titleRow = expanded.findIndex((line) => line.includes("GLOBE · AUTO"));
			const buttonX = side === "left" ? 41 : 42;
			expect(expanded[titleRow]).toContain("[-]");
			expect(fixture.sidebar.handleMouse(click(buttonX, titleRow))).toEqual({ handled: true, render: true });
			expect(fixture.sidebar.isArtExpanded()).toBe(false);
			expect(fixture.sidebar.getArtMode()).toBe("auto");
			const collapsed = fixture.sidebar.render(44);
			expect(collapsed.at(-1)).toContain("[+]");
			expect(fixture.sidebar.handleMouse(click(buttonX, collapsed.length - 1))).toEqual({ handled: true, render: true });
			expect(fixture.sidebar.isArtExpanded()).toBe(true);
			expect(fixture.sidebar.getArtMode()).toBe("auto");
		} finally {
			fixture.sidebar.dispose();
		}
	});

	it("restores goal and todos, switches art with live activity and manual override", () => {
		const fixture = createFixture([
			{
				type: "custom",
				customType: "goal-state",
				data: {
					goal: {
						id: "g1",
						text: "Inspect network",
						status: "active",
						startedAt: 1,
						updatedAt: 1,
						iteration: 1,
						tokensUsed: 0,
						timeUsedSeconds: 0,
						baselineTokens: 0,
					},
				},
			},
			{
				type: "custom",
				customType: "omega-todo-state",
				data: {
					tasks: [
						{ id: 1, subject: "Survey", status: "completed" },
						{ id: 2, subject: "Trace route", status: "in_progress" },
					],
					nextId: 3,
				},
			},
		]);
		const { sidebar } = fixture;
		try {
			sidebar.selectTab("tasks");
			const tasks = sidebar.render(44).join("\n");
			expect(tasks).toContain("Goal   active");
			expect(tasks).toContain("Todo   1/2");
			expect(tasks).toContain("Trace route");
			expect(tasks).toContain("GLOBE");
			sidebar.startTool("call-1", "http_request");
			const attackFrame = sidebar.render(44);
			expect(attackFrame.join("\n")).toContain("SIMULATION");
			expect(sidebar.handleMouse(click(5, attackFrame.findIndex((line) => line.includes("SIMULATION"))))).toEqual({
				handled: true,
				render: true,
			});
			expect(sidebar.getArtMode()).toBe("globe");
			expect(sidebar.render(44).join("\n")).toContain("GLOBE");
			sidebar.cycleArtMode();
			expect(sidebar.render(44).join("\n")).toContain("SIMULATION");
			sidebar.cycleArtMode();
			sidebar.finishTool("call-1");
			sidebar.cycleArtMode();
			expect(sidebar.render(44).join("\n")).toContain("GLOBE");
			fixture.advance(600);
			expect(sidebar.isVisible()).toBe(true);
			sidebar.render(44);
			expect(sidebar.isVisible()).toBe(true);
			(fixture.tui as { mode: string }).mode = "regular";
			expect(sidebar.isVisible()).toBe(false);
		} finally {
			sidebar.dispose();
		}
	});
});

describe("offline ASCII art", () => {
	it("shows all six continent labels during one revolution", () => {
		const seen = new Set<string>();
		const rendered = new Set<string>();
		for (let step = 0; step < 24; step++) {
			const rotation = (step / 24) * Math.PI * 2;
			for (const label of visibleGlobeLabels(rotation)) seen.add(label);
			const frame = renderAsciiGlobe(42, 14, step * 1_250).join("\n");
			for (const continent of SIDEBAR_CONTINENTS) {
				if (frame.includes(continent.id)) rendered.add(continent.id);
			}
		}
		expect([...seen].sort()).toEqual(SIDEBAR_CONTINENTS.map((continent) => continent.id).sort());
		expect([...rendered].sort()).toEqual(SIDEBAR_CONTINENTS.map((continent) => continent.id).sort());
	});

	it("fits terminal cells and produces deterministic attack frames", () => {
		for (const [width, height] of [
			[42, 12],
			[20, 6],
			[1, 1],
		] as const) {
			const globe = renderAsciiGlobe(width, height, 2_000);
			const attack = renderAttackMap(width, height, 2_000);
			const terminal = renderTerminalScene(width, height, 2_000);
			expect(globe).toHaveLength(height);
			expect(attack).toHaveLength(height);
			expect(terminal).toHaveLength(height);
			expect([...globe, ...attack, ...terminal].every((line) => visibleWidth(line) === width)).toBe(true);
			expect(attack).toEqual(renderAttackMap(width, height, 2_000));
			expect(terminal).toEqual(renderTerminalScene(width, height, 2_000));
		}
		expect(renderAttackMap(42, 12, 2_000)).not.toEqual(renderAttackMap(42, 12, 4_000));
		expect(renderTerminalScene(42, 12, 2_000)).not.toEqual(renderTerminalScene(42, 12, 4_000));
	});

	it("fills the terminal scene with a monochrome hex response and simulated noise", () => {
		const hexFrame = renderTerminalScene(42, 14, 10_500);
		expect(hexFrame.every((line) => line.trim().length > 0)).toBe(true);
		expect(hexFrame.join("\n")).toContain("Address");
		expect(hexFrame.filter((line) => /^[0-9A-F]{8}:/.test(line)).length).toBeGreaterThan(8);
		expect(hexFrame.join("\n")).toContain("ASCII");
		expect(renderTerminalScene(42, 14, 16_800).join("\n")).toContain("[rx]");
	});
});
