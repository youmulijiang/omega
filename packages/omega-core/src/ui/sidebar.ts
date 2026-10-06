import { randomUUID } from "node:crypto";
import type { ExtensionContext, ReadonlyFooterDataProvider, Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	getKeybindings,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { OmegaAPI } from "../api.ts";
import type { BgTaskSnapshot } from "../background/core/common.ts";
import {
	type BackgroundTaskExtensionResponse,
	type BackgroundTaskExtensionTerminal,
	BG_REQUEST_CHANNEL,
	BG_REQUEST_SCHEMA,
	BG_RESPONSE_CHANNEL,
	BG_TERMINAL_CHANNEL,
} from "../background/core/extension-api.ts";
import { registerOmegaCommand } from "../commands/register.ts";
import { type ActiveGoal, loadGoalStateFromSession } from "../goal/persistence.ts";
import { MCP_STATUS_CHANNEL, type McpStatusEntry } from "../mcp/status-events.ts";
import type { SingleResult, SubagentDetails } from "../subagents/types.ts";
import { TODO_STATE_ENTRY } from "../todo/index.ts";
import { cloneTodoState, createTodoState, isTodoState } from "../todo/state.ts";
import type { TodoState } from "../todo/types.ts";
import { renderAttackMap, renderGlobe, renderTerminalScene } from "./sidebar-art.ts";

export type SidebarTab = "status" | "tasks" | "system";
export type SidebarArtMode = "auto" | "globe" | "attack" | "terminal";
export type SidebarPanel = "tabs" | "art";

interface ActiveTool {
	readonly name: string;
	readonly startedAt: number;
}

interface SubagentSummary {
	readonly id: string;
	readonly name: string;
	readonly running: boolean;
}

const TABS: readonly SidebarTab[] = ["status", "tasks", "system"];
const TAB_LABELS: Record<SidebarTab, string> = {
	status: "STATUS",
	tasks: "TASKS",
	system: "SYSTEM",
};
const FRAME_INTERVAL_MS = 125;
/** Terminals emit a burst of size changes while dragging; collapse them into one re-mount. */
const RESIZE_DEBOUNCE_MS = 150;
/** Narrowest usable sidebar; below this the art and labels collapse. */
const MIN_SIDEBAR_WIDTH = 28;
/** Widest auto-sized sidebar, so a huge terminal still leaves room for chat. */
const MAX_SIDEBAR_WIDTH = 60;
/** Share of terminal columns the sidebar aims for before clamping. */
const SIDEBAR_WIDTH_RATIO = 0.3;
/** Assumed terminal width when the real size cannot be read. */
const DEFAULT_TERMINAL_COLUMNS = 120;

/**
 * Sidebar width for a terminal of `columns` columns: proportional to the
 * terminal, clamped to [MIN, MAX], and never more than a third of the screen so
 * the transcript keeps the majority of the width. Unknown or degenerate sizes
 * fall back to a typical wide terminal instead of producing NaN.
 */
export function sidebarWidthForTerminal(columns: number): number {
	const safeColumns = Number.isFinite(columns) && columns > 0 ? Math.floor(columns) : DEFAULT_TERMINAL_COLUMNS;
	const proportional = Math.round(safeColumns * SIDEBAR_WIDTH_RATIO);
	const capped = Math.min(proportional, Math.floor(safeColumns / 3));
	return Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, capped));
}

function fitLine(value: string, width: number): string {
	const safeWidth = Math.max(0, width);
	const clipped = truncateToWidth(value, safeWidth);
	return clipped + " ".repeat(Math.max(0, safeWidth - visibleWidth(clipped)));
}

function formatDuration(milliseconds: number): string {
	const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return seconds < 3_600 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function restoreTodoState(ctx: ExtensionContext): TodoState {
	let state = createTodoState();
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "custom" && entry.customType === TODO_STATE_ENTRY && isTodoState(entry.data)) {
			state = cloneTodoState(entry.data);
			continue;
		}
		if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "todo")
			continue;
		if (isTodoState(entry.message.details)) state = cloneTodoState(entry.message.details);
	}
	return state;
}

function backgroundTasksFromResponse(value: unknown): BgTaskSnapshot[] | undefined {
	if (!isRecord(value) || value.schema_version === undefined || value.ok !== true || !isRecord(value.result)) return;
	const tasks = value.result.tasks;
	return Array.isArray(tasks) ? (tasks as BgTaskSnapshot[]) : undefined;
}

function backgroundTaskFromTerminal(value: unknown): BgTaskSnapshot | undefined {
	if (!isRecord(value) || !isRecord(value.task)) return;
	return value.task as unknown as BgTaskSnapshot;
}

function subagentResults(value: unknown): SingleResult[] | undefined {
	if (!isRecord(value)) return;
	const details = isRecord(value.details) ? value.details : value;
	if (details.kind !== "omega-subagent" || !Array.isArray(details.results)) return;
	return (details as unknown as SubagentDetails).results;
}

export class OmegaSidebar implements Component {
	focused = false;
	/** Invoked when the terminal size changes; the host re-mounts to resize the sidebar. */
	onTerminalResize: ((columns: number, rows: number) => void) | undefined;
	private lastTerminalColumns = 0;
	private lastTerminalRows = 0;
	private previousFocus: Component | null = null;
	private readonly minTerminalWidth: number;
	private readonly side: "left" | "right";
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly footerData: ReadonlyFooterDataProvider;
	private readonly now: () => number;
	private readonly startedAt: number;
	private readonly frameTimer: ReturnType<typeof setInterval>;
	private readonly unsubscribeBranch: () => void;
	private tab: SidebarTab = "status";
	private artMode: SidebarArtMode = "auto";
	private artExpanded = true;
	private activePanel: SidebarPanel = "tabs";
	private lastRenderedAt = 0;
	private artTitleRow = -1;
	private mcpHeaderRow = -1;
	private mcpScrollOffset = 0;
	private mcpMaxScroll = 0;
	private mcpExpanded = true;
	private mcpStates: readonly McpStatusEntry[] = [];
	private artToggleRange: { start: number; end: number } | undefined;
	private tabHitRanges: ReadonlyArray<{ tab: SidebarTab; start: number; end: number }> = [];
	private disposed = false;
	private cwd = "";
	private sessionId = "";
	private model = "none";
	private thinking = "off";
	private idle = true;
	private contextTokens: number | null = null;
	private contextWindow = 0;
	private contextPercent: number | null = null;
	private todos: TodoState = createTodoState();
	private goal: ActiveGoal | undefined;
	private readonly activeTools = new Map<string, ActiveTool>();
	private readonly backgroundTasks = new Map<string, BgTaskSnapshot>();
	private readonly subagents = new Map<string, SubagentSummary>();

	constructor(
		tui: TUI,
		theme: Theme,
		footerData: ReadonlyFooterDataProvider,
		ctx: ExtensionContext,
		now: () => number = Date.now,
		minTerminalWidth = 100,
		side: "left" | "right" = "right",
	) {
		this.tui = tui;
		this.theme = theme;
		this.footerData = footerData;
		this.now = now;
		this.minTerminalWidth = minTerminalWidth;
		this.side = side;
		this.startedAt = now();
		this.updateContext(ctx);
		this.unsubscribeBranch = footerData.onBranchChange(() => this.tui.requestRender());
		this.frameTimer = setInterval(() => {
			if (!this.disposed && this.now() - this.lastRenderedAt < 500) this.tui.requestRender();
		}, FRAME_INTERVAL_MS);
		this.frameTimer.unref?.();
	}

	updateContext(ctx: ExtensionContext): void {
		const sessionId = ctx.sessionManager.getSessionId();
		if (sessionId !== this.sessionId) {
			this.sessionId = sessionId;
			this.restoreActivity(ctx);
		}
		this.cwd = ctx.cwd;
		this.model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";
		this.thinking = ctx.thinkingLevel ?? "off";
		this.idle = ctx.isIdle();
		const usage = ctx.getContextUsage();
		this.contextTokens = usage?.tokens ?? null;
		this.contextWindow = usage?.contextWindow ?? 0;
		this.contextPercent = usage?.percent ?? null;
		this.todos = restoreTodoState(ctx);
		this.goal = loadGoalStateFromSession(ctx).goal;
		this.tui.requestRender();
	}

	restoreActivity(ctx: ExtensionContext): void {
		this.activeTools.clear();
		this.backgroundTasks.clear();
		this.subagents.clear();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
			const details = entry.message.details;
			const results = subagentResults(details);
			if (results) this.updateSubagents(results);
			if (!isRecord(details)) continue;
			if (isRecord(details.task)) this.updateBackgroundTasks([details.task as unknown as BgTaskSnapshot]);
			if (Array.isArray(details.tasks)) this.updateBackgroundTasks(details.tasks as BgTaskSnapshot[]);
		}
	}

	setTurnActive(active: boolean): void {
		this.idle = !active;
		this.tui.requestRender();
	}

	startTool(toolCallId: string, name: string, startedAt = this.now()): void {
		this.activeTools.set(toolCallId, { name, startedAt });
		this.tui.requestRender();
	}

	finishTool(toolCallId: string): void {
		this.activeTools.delete(toolCallId);
		this.tui.requestRender();
	}

	updateBackgroundTasks(tasks: readonly BgTaskSnapshot[]): void {
		for (const task of tasks) this.backgroundTasks.set(task.id, task);
		this.tui.requestRender();
	}

	updateSubagents(results: readonly SingleResult[]): void {
		for (const result of results) {
			const id = result.taskId ?? result.agent;
			this.subagents.set(id, { id, name: result.agent, running: result.exitCode === -1 });
		}
		this.tui.requestRender();
	}

	selectTab(tab: SidebarTab): void {
		this.tab = tab;
		this.tui.requestRender();
	}

	cycleTab(direction: -1 | 1): void {
		const current = TABS.indexOf(this.tab);
		this.selectTab(TABS[(current + direction + TABS.length) % TABS.length]!);
	}

	cycleArtMode(): void {
		const modes: readonly SidebarArtMode[] = ["auto", "globe", "attack", "terminal"];
		this.artMode = modes[(modes.indexOf(this.artMode) + 1) % modes.length]!;
		this.tui.requestRender();
	}

	getSelectedTab(): SidebarTab {
		return this.tab;
	}

	getArtMode(): SidebarArtMode {
		return this.artMode;
	}

	updateMcpStates(states: readonly McpStatusEntry[]): void {
		this.mcpStates = states;
		this.mcpScrollOffset = 0;
		this.tui.requestRender();
	}

	isMcpExpanded(): boolean {
		return this.mcpExpanded;
	}

	setMcpExpanded(expanded: boolean): void {
		this.mcpExpanded = expanded;
		this.tui.requestRender();
	}

	setArtMode(mode: SidebarArtMode): void {
		this.artMode = mode;
		this.tui.requestRender();
	}

	isArtExpanded(): boolean {
		return this.artExpanded;
	}

	setArtExpanded(expanded: boolean): void {
		this.artExpanded = expanded;
		this.tui.requestRender();
	}

	toggleArtExpanded(): void {
		this.setArtExpanded(!this.artExpanded);
	}

	getActivePanel(): SidebarPanel {
		return this.activePanel;
	}

	selectPanel(panel: SidebarPanel): void {
		this.activePanel = panel;
		this.tui.requestRender();
	}

	switchPanel(): void {
		this.selectPanel(this.activePanel === "tabs" ? "art" : "tabs");
	}

	focus(): void {
		if (!this.isVisible() || this.tui.hasOverlay()) return;
		const focusableTui = this.tui as TUI & { getFocusedComponent(): Component | null };
		const current = focusableTui.getFocusedComponent();
		if (current === this) return;
		this.previousFocus = current;
		this.tui.setFocus(this);
		this.tui.requestRender();
	}

	blur(): void {
		if (!this.focused) return;
		this.tui.setFocus(this.previousFocus);
		this.previousFocus = null;
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		const bindings = getKeybindings();
		if (this.activePanel === "art" && bindings.matches(data, "app.sidebar.toggleArt")) {
			this.toggleArtExpanded();
		} else if (bindings.matches(data, "tui.input.tab")) {
			if (this.activePanel === "tabs") this.cycleTab(1);
			else this.cycleArtMode();
		} else if (bindings.matches(data, "tui.select.cancel")) this.blur();
	}

	isVisible(): boolean {
		return (
			!this.disposed &&
			this.tui.mode === "fullscreen" &&
			this.tui.terminal.columns >= this.minTerminalWidth &&
			this.tui.terminal.rows >= 18
		);
	}

	/**
	 * The host allocates a fixed width at mount time, so a terminal resize only
	 * takes effect after a re-mount. Report size changes from render, where the
	 * current terminal dimensions are authoritative.
	 */
	private detectTerminalResize(): void {
		const columns = this.tui.terminal.columns;
		const rows = this.tui.terminal.rows;
		if (columns === this.lastTerminalColumns && rows === this.lastTerminalRows) return;
		this.lastTerminalColumns = columns;
		this.lastTerminalRows = rows;
		this.onTerminalResize?.(columns, rows);
	}

	private hasLiveActivity(): boolean {
		return (
			this.activeTools.size > 0 ||
			[...this.backgroundTasks.values()].some((task) => task.status === "running") ||
			[...this.subagents.values()].some((agent) => agent.running)
		);
	}

	private effectiveArtMode(): Exclude<SidebarArtMode, "auto"> {
		if (this.artMode !== "auto") return this.artMode;
		return this.hasLiveActivity() ? "attack" : "globe";
	}

	private statusSummaryLines(now: number): string[] {
		const activeTool = [...this.activeTools.values()][0];
		const permissionLevel =
			this.footerData
				.getExtensionStatuses()
				.get("omega-permissions")
				?.replace(/^Permissions:\s*/, "") ?? "loading";
		const usage =
			this.contextPercent === null
				? "unknown"
				: `${this.contextPercent.toFixed(1)}% (${this.contextTokens ?? "?"}/${this.contextWindow})`;
		return [
			this.theme.fg("accent", this.idle ? "● READY" : "● ACTIVE"),
			`Model  ${this.model}`,
			`Think  ${this.thinking}`,
			`Permissions  ${permissionLevel}`,
			`Ctx    ${usage}`,
			`       ${this.contextBar()}`,
			activeTool ? `Tool   ${activeTool.name} ${formatDuration(now - activeTool.startedAt)}` : "Tool   none",
		];
	}

	private mcpLines(width: number): string[] {
		if (!this.mcpExpanded) return [];
		if (this.mcpStates.length === 0) return [this.theme.fg("muted", "  No servers configured")];
		const lines: string[] = [];
		for (const state of this.mcpStates) {
			const name = truncateToWidth(state.name, Math.max(3, Math.floor(width / 2)));
			const prefix = `  ● ${name} `;
			const label =
				state.status === "connected"
					? "Connected"
					: state.status === "needs-auth"
						? "Authentication required"
						: state.status.charAt(0).toUpperCase() + state.status.slice(1);
			const detail = state.error ? `${label}: ${state.error}` : label;
			const wrapped = wrapTextWithAnsi(detail, Math.max(1, width - visibleWidth(prefix)));
			const color =
				state.status === "connected"
					? "success"
					: state.status === "error" || state.status === "needs-auth"
						? "error"
						: "muted";
			lines.push(
				`${this.theme.fg(color, "  ●")} ${this.theme.bold(name)} ${this.theme.fg("muted", wrapped[0] ?? "")}`,
			);
			for (const continuation of wrapped.slice(1)) lines.push(`    ${this.theme.fg("muted", continuation)}`);
		}
		return lines;
	}

	private contextBar(): string {
		const percent = Math.max(0, Math.min(100, this.contextPercent ?? 0));
		const pixels = Math.round((percent / 100) * 20 * 8);
		const full = Math.floor(pixels / 8);
		const partial = pixels % 8;
		const fragments = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];
		const filled = "█".repeat(full) + (partial ? fragments[partial] : "");
		const empty = "░".repeat(20 - full - (partial ? 1 : 0));
		return this.theme.fg("accent", filled) + this.theme.fg("dim", empty);
	}

	private taskLines(): string[] {
		const visibleTodos = this.todos.tasks.filter((task) => task.status !== "deleted");
		const completed = visibleTodos.filter((task) => task.status === "completed").length;
		const runningBackground = [...this.backgroundTasks.values()].filter((task) => task.status === "running");
		const runningAgents = [...this.subagents.values()].filter((agent) => agent.running);
		const lines = [
			this.goal ? `Goal   ${this.goal.status}` : "Goal   none",
			this.goal ? `  ${this.goal.text}` : "",
			`Todo   ${completed}/${visibleTodos.length}`,
		];
		for (const task of visibleTodos.filter((item) => item.status !== "completed").slice(0, 3)) {
			lines.push(`${task.status === "in_progress" ? ">" : "-"} ${task.subject}`);
		}
		lines.push(`Agents ${runningAgents.length}`, ...runningAgents.slice(0, 2).map((agent) => `  ${agent.name}`));
		lines.push(
			`BG     ${runningBackground.length}`,
			...runningBackground.slice(0, 2).map((task) => `  ${task.name ?? task.id}`),
		);
		return lines.filter((line, index) => line.length > 0 || index !== 1);
	}

	private systemLines(now: number): string[] {
		return [
			`CWD    ${this.cwd}`,
			`Branch ${this.footerData.getGitBranch() ?? "none"}`,
			`Term   ${this.tui.terminal.columns}x${this.tui.terminal.rows}`,
			"Mode   fullscreen",
			`OS     ${process.platform}/${process.arch}`,
			`Uptime ${formatDuration(now - this.startedAt)}`,
		];
	}

	private panelLines(now: number): string[] {
		switch (this.tab) {
			case "status":
				return this.statusSummaryLines(now);
			case "tasks":
				return this.taskLines();
			case "system":
				return this.systemLines(now);
		}
	}

	private framed(value: string, width: number): string {
		if (width <= 0) return "";
		const border = this.theme.fg("border", "│");
		return this.side === "left" ? fitLine(value, width - 1) + border : border + fitLine(value, width - 1);
	}

	private divider(width: number): string {
		const line = "─".repeat(Math.max(0, width - 1));
		return this.theme.fg("border", this.side === "left" ? `${line}┤` : `├${line}`);
	}

	render(width: number): string[] {
		this.detectTerminalResize();
		const safeWidth = Math.max(1, Math.floor(width));
		const height = Math.max(1, this.tui.terminal.rows);
		const innerWidth = Math.max(0, safeWidth - 1);
		const now = this.now();
		this.lastRenderedAt = now;
		const panel = this.panelLines(now);
		const mcpDetails = this.tab === "status" ? this.mcpLines(innerWidth) : [];
		const panelRows = panel.length + (this.tab === "status" ? 1 + mcpDetails.length : 0);
		const upperHeight = this.artExpanded
			? Math.max(6, Math.min(height - 6, Math.max(Math.floor(height * 0.4), panelRows + 2)))
			: height - 2;
		const contentHeight = Math.max(0, upperHeight - 2);
		const artHeight = this.artExpanded ? Math.max(0, height - upperHeight - 2) : 0;
		const selected = (tab: SidebarTab) =>
			tab === this.tab
				? this.theme.fg("accent", this.theme.bold(`[${TAB_LABELS[tab]}]`))
				: this.theme.fg("muted", ` ${TAB_LABELS[tab]} `);
		let tabOffset = this.side === "left" ? 0 : 1;
		const tabTexts = TABS.map((tab) => {
			const label = selected(tab);
			const start = tabOffset;
			tabOffset += visibleWidth(label) + 1;
			return { tab, label, start, end: tabOffset };
		});
		this.tabHitRanges = tabTexts;
		const lines = [
			this.framed(
				`${this.focused && this.activePanel === "tabs" ? this.theme.fg("accent", ">") : " "}${tabTexts.map(({ label }) => label).join(" ")}`,
				safeWidth,
			),
		];
		lines.push(this.divider(safeWidth));

		this.mcpHeaderRow = this.tab === "status" ? lines.length + panel.length : -1;
		const mcpVisibleRows = Math.max(0, contentHeight - panel.length - (this.tab === "status" ? 1 : 0));
		this.mcpMaxScroll = Math.max(0, mcpDetails.length - mcpVisibleRows);
		this.mcpScrollOffset = Math.min(this.mcpScrollOffset, this.mcpMaxScroll);
		const visiblePanel =
			this.tab === "status"
				? [
						...panel,
						this.theme.fg(
							"accent",
							`${this.mcpExpanded ? "▼" : "▶"} MCP ${this.mcpStates.filter((state) => state.status === "connected").length}/${this.mcpStates.length}`,
						),
						...mcpDetails.slice(this.mcpScrollOffset, this.mcpScrollOffset + mcpVisibleRows),
					]
				: panel;
		for (let row = 0; row < contentHeight; row++) lines.push(this.framed(visiblePanel[row] ?? "", safeWidth));
		lines.push(this.divider(safeWidth));

		const effectiveMode = this.effectiveArtMode();
		this.artTitleRow = lines.length;
		const artTitle = `${this.focused && this.activePanel === "art" ? this.theme.fg("accent", ">") : " "}${this.theme.fg("muted", `${effectiveMode === "globe" ? "GLOBE" : effectiveMode === "attack" ? "SIMULATION" : "TERMINAL SIM"} · ${this.artMode.toUpperCase()}`)}`;
		const canToggleByMouse = innerWidth >= 3;
		this.artToggleRange = canToggleByMouse
			? {
					start: this.side === "left" ? safeWidth - 4 : safeWidth - 3,
					end: this.side === "left" ? safeWidth - 1 : safeWidth,
				}
			: undefined;
		lines.push(
			this.framed(
				canToggleByMouse
					? fitLine(artTitle, innerWidth - 3) + this.theme.fg("muted", this.artExpanded ? "[-]" : "[+]")
					: artTitle,
				safeWidth,
			),
		);
		const art = !this.artExpanded
			? []
			: effectiveMode === "globe"
				? renderGlobe(innerWidth, artHeight, now)
				: effectiveMode === "attack"
					? renderAttackMap(innerWidth, artHeight, now)
					: renderTerminalScene(innerWidth, artHeight, now);
		for (const line of art) {
			const colored = effectiveMode === "terminal" ? line : this.theme.fg("accent", line);
			lines.push(this.framed(colored, safeWidth));
		}
		return lines.slice(0, height);
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (
			event.type === "wheel" &&
			this.tab === "status" &&
			event.y > this.mcpHeaderRow &&
			event.y < this.artTitleRow
		) {
			this.mcpScrollOffset = Math.max(
				0,
				Math.min(this.mcpMaxScroll, this.mcpScrollOffset + (event.wheelDelta ?? 0)),
			);
			this.tui.requestRender();
			return { handled: true, render: true };
		}
		if (event.type !== "click" || event.button !== "left") return;
		if (event.y === 0 && event.x >= 0) {
			const hit = this.tabHitRanges.find(({ start, end }) => event.x >= start && event.x < end);
			if (hit) {
				this.selectPanel("tabs");
				this.selectTab(hit.tab);
				return { handled: true, render: true };
			}
		}
		if (event.y === this.mcpHeaderRow) {
			this.setMcpExpanded(!this.mcpExpanded);
			return { handled: true, render: true };
		}
		if (event.y === this.artTitleRow) {
			this.selectPanel("art");
			if (this.artToggleRange && event.x >= this.artToggleRange.start && event.x < this.artToggleRange.end) {
				this.toggleArtExpanded();
				return { handled: true, render: true };
			}
			this.cycleArtMode();
			return { handled: true, render: true };
		}
		return;
	}

	invalidate(): void {}

	dispose(): void {
		if (this.disposed) return;
		this.blur();
		this.disposed = true;
		clearInterval(this.frameTimer);
		this.unsubscribeBranch();
	}
}

/** Register the Omega fullscreen sidebar and keep it synchronized with extension events. */
export function setupSidebar(omega: OmegaAPI): void {
	let sidebar: OmegaSidebar | undefined;
	let enabled = true;
	/** Fixed width from `/sidebar width <n>`; undefined auto-sizes to the terminal. */
	let manualWidth: number | undefined;
	/** Width baked into the current fullscreen layout; drives resize re-mounts. */
	let mountedWidth = 0;
	/** Terminal width last reported by the mounted sidebar; authoritative over process.stdout. */
	let observedColumns: number | undefined;
	let resizeTimer: ReturnType<typeof setTimeout> | undefined;
	let side: "left" | "right" = "right";
	let currentContext: ExtensionContext | undefined;
	let latestMcpStates: readonly McpStatusEntry[] = [];
	let backgroundRequestId: string | undefined;
	let unsubscribeBackgroundResponse: (() => void) | undefined;
	let unsubscribeBackgroundTerminal: (() => void) | undefined;
	omega.events.on(MCP_STATUS_CHANNEL, (value) => {
		if (!Array.isArray(value)) return;
		latestMcpStates = value as McpStatusEntry[];
		sidebar?.updateMcpStates(latestMcpStates);
	});

	const subscribeBackground = () => {
		unsubscribeBackgroundResponse?.();
		unsubscribeBackgroundTerminal?.();
		unsubscribeBackgroundResponse = omega.events.on(BG_RESPONSE_CHANNEL, (value) => {
			const response = value as BackgroundTaskExtensionResponse;
			if (!backgroundRequestId || response.request_id !== backgroundRequestId) return;
			backgroundRequestId = undefined;
			const tasks = backgroundTasksFromResponse(value);
			if (tasks) sidebar?.updateBackgroundTasks(tasks);
		});
		unsubscribeBackgroundTerminal = omega.events.on(BG_TERMINAL_CHANNEL, (value) => {
			const terminal = value as BackgroundTaskExtensionTerminal;
			const task = backgroundTaskFromTerminal(terminal);
			if (task) sidebar?.updateBackgroundTasks([task]);
		});
	};

	const refresh = (ctx: ExtensionContext) => sidebar?.updateContext(ctx);

	/** Columns of the controlling terminal; the host exposes no size API to extensions. */
	const terminalColumns = () => process.stdout.columns ?? DEFAULT_TERMINAL_COLUMNS;
	const widthFor = (columns: number) => manualWidth ?? sidebarWidthForTerminal(columns);

	/**
	 * The host bakes the sidebar width into the fullscreen layout when mounting, so
	 * an adaptive width only takes effect after a re-mount. Terminals emit a burst
	 * of size changes while dragging, hence the debounce; a re-mount is skipped
	 * when the derived width is unchanged, which also stops mount loops.
	 */
	const scheduleResize = (columns: number) => {
		observedColumns = columns;
		if (manualWidth !== undefined) return;
		if (sidebarWidthForTerminal(columns) === mountedWidth) return;
		if (resizeTimer) clearTimeout(resizeTimer);
		resizeTimer = setTimeout(() => {
			resizeTimer = undefined;
			if (currentContext && manualWidth === undefined && observedColumns !== undefined) {
				mount(currentContext, observedColumns);
			}
		}, RESIZE_DEBOUNCE_MS);
	};

	const mount = (ctx: ExtensionContext, columns: number = observedColumns ?? terminalColumns()) => {
		currentContext = ctx;
		// The sidebar API is an Omega fork addition; stock npm pi builds lack it,
		// so skip mounting instead of throwing during startup.
		const setSidebar = (ctx.ui as Partial<Pick<ExtensionContext["ui"], "setSidebar">>).setSidebar;
		if (typeof setSidebar !== "function") {
			sidebar = undefined;
			return;
		}
		if (!enabled) {
			setSidebar.call(ctx.ui, undefined);
			sidebar = undefined;
			return;
		}
		const width = widthFor(columns);
		const minTerminalWidth = Math.max(90, width + 40);
		mountedWidth = width;
		const focused = sidebar?.focused ?? false;
		const selectedTab = sidebar?.getSelectedTab() ?? "status";
		const selectedPanel = sidebar?.getActivePanel() ?? "tabs";
		const selectedArtMode = sidebar?.getArtMode() ?? "auto";
		const artExpanded = sidebar?.isArtExpanded() ?? true;
		const mcpExpanded = sidebar?.isMcpExpanded() ?? true;
		sidebar?.blur();
		setSidebar.call(
			ctx.ui,
			(tui, theme, footerData) => {
				sidebar = new OmegaSidebar(tui, theme, footerData, ctx, Date.now, minTerminalWidth, side);
				sidebar.onTerminalResize = (columns) => scheduleResize(columns);
				sidebar.selectTab(selectedTab);
				sidebar.selectPanel(selectedPanel);
				sidebar.setArtMode(selectedArtMode);
				sidebar.setArtExpanded(artExpanded);
				sidebar.setMcpExpanded(mcpExpanded);
				sidebar.updateMcpStates(latestMcpStates);
				if (focused) sidebar.focus();
				return sidebar;
			},
			{ width, side, minTerminalWidth, minTerminalHeight: 18 },
		);
	};

	registerOmegaCommand(omega, "sidebar", {
		description: "Control sidebar: /sidebar on|off|left|right|width <columns|auto>",
		handler: async (args, ctx) => {
			const [action, value, ...extra] = args.trim().toLowerCase().split(/\s+/);
			if (action === "on" && !value) enabled = true;
			else if (action === "off" && !value) enabled = false;
			else if ((action === "left" || action === "right") && !value) side = action;
			else if ((action === "width" || action === "wight") && value && !extra.length) {
				if (value === "auto") {
					manualWidth = undefined;
				} else {
					const requested = Number(value);
					if (!Number.isInteger(requested) || requested < 24 || requested > 80) {
						ctx.ui.notify('Sidebar width must be an integer from 24 to 80, or "auto".', "error");
						return;
					}
					manualWidth = requested;
				}
			} else if (action && action !== "width" && action !== "wight") {
				ctx.ui.notify("Usage: /sidebar on|off|left|right|width <24-80|auto>", "error");
				return;
			}
			if (currentContext && ctx.mode === "tui") mount(currentContext);
			const widthLabel = manualWidth === undefined ? "auto" : String(manualWidth);
			ctx.ui.notify(
				`Sidebar ${enabled ? "on" : "off"} on the ${side}, width ${widthLabel}. F6 focuses; F7 switches panels; Tab cycles; Ctrl+O toggles animation.`,
				"info",
			);
		},
	});

	omega.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		subscribeBackground();
		mount(ctx);
		ctx.ui.onTerminalInput((data) => {
			if (!sidebar?.isVisible()) {
				sidebar?.blur();
				return undefined;
			}
			const keybindings = getKeybindings();
			if (keybindings.matches(data, "app.sidebar.focus")) {
				if (sidebar.focused) sidebar.blur();
				else sidebar.focus();
				return { consume: true };
			}
			if (sidebar.focused && keybindings.matches(data, "app.sidebar.switchPanel")) {
				sidebar.switchPanel();
				return { consume: true };
			}
			if (keybindings.matches(data, "app.sidebar.previousTab")) {
				sidebar?.cycleTab(-1);
				return { consume: true };
			}
			if (keybindings.matches(data, "app.sidebar.nextTab")) {
				sidebar?.cycleTab(1);
				return { consume: true };
			}
			return undefined;
		});

		backgroundRequestId = randomUUID();
		omega.events.emit(BG_REQUEST_CHANNEL, {
			schema_version: BG_REQUEST_SCHEMA,
			request_id: backgroundRequestId,
			operation: "status",
			payload: {},
		});
	});

	omega.on("session_tree", (_event, ctx) => {
		sidebar?.restoreActivity(ctx);
		refresh(ctx);
	});
	omega.on("session_info_changed", (_event, ctx) => refresh(ctx));
	omega.on("turn_start", (_event, ctx) => {
		sidebar?.updateContext(ctx);
		sidebar?.setTurnActive(true);
	});
	omega.on("turn_end", (_event, ctx) => {
		sidebar?.updateContext(ctx);
		sidebar?.setTurnActive(false);
	});
	omega.on("tool_execution_start", (event, ctx) => {
		sidebar?.updateContext(ctx);
		sidebar?.startTool(event.toolCallId, event.toolName);
	});
	omega.on("tool_execution_update", (event) => {
		const results = subagentResults(event.partialResult);
		if (results) sidebar?.updateSubagents(results);
	});
	omega.on("tool_execution_end", (event, ctx) => {
		sidebar?.finishTool(event.toolCallId);
		sidebar?.updateContext(ctx);
		const details = isRecord(event.result) ? event.result.details : undefined;
		const results = subagentResults(details);
		if (results) sidebar?.updateSubagents(results);
		if (isRecord(details) && isRecord(details.task)) {
			sidebar?.updateBackgroundTasks([details.task as unknown as BgTaskSnapshot]);
		}
	});
	omega.on("tool_result", (_event, ctx) => refresh(ctx));
	omega.on("session_shutdown", () => {
		sidebar = undefined;
		currentContext = undefined;
		latestMcpStates = [];
		backgroundRequestId = undefined;
		observedColumns = undefined;
		if (resizeTimer) clearTimeout(resizeTimer);
		resizeTimer = undefined;
		unsubscribeBackgroundResponse?.();
		unsubscribeBackgroundTerminal?.();
		unsubscribeBackgroundResponse = undefined;
		unsubscribeBackgroundTerminal = undefined;
	});
}
