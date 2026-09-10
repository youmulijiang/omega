import { CustomEditor, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type EditorTheme,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { getDisplayItems, isResultError, isResultSuccess, type SingleResult } from "./types.ts";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

function oneLine(value: string): string {
	return value.replace(/\s+/gu, " ").trim();
}

function formatDuration(milliseconds: number): string {
	if (milliseconds < 10_000) return `${(milliseconds / 1000).toFixed(1)}s`;
	if (milliseconds < 60_000) return `${Math.round(milliseconds / 1000)}s`;
	const minutes = Math.floor(milliseconds / 60_000);
	const seconds = Math.floor((milliseconds % 60_000) / 1000);
	return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
}

function formatTokens(tokens: number): string {
	if (tokens < 1000) return String(tokens);
	if (tokens < 10_000) return `${(tokens / 1000).toFixed(1)}k`;
	return `${Math.round(tokens / 1000)}k`;
}

function padBetween(left: string, right: string, width: number): string {
	const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
	return truncateToWidth(`${left}${" ".repeat(gap)}${right}`, width);
}

function resultKey(result: SingleResult, index: number): string {
	return `${result.callIndex ?? index}:${result.agent}:${result.prompt}`;
}

abstract class LiveSubagentComponent implements Component {
	protected results: readonly SingleResult[] = [];
	protected readonly startedAt = new Map<string, number>();
	protected readonly finishedAt = new Map<string, number>();
	protected frame = 0;
	protected readonly tui: TUI;
	protected readonly theme: Theme;
	private readonly timer: NodeJS.Timeout;

	constructor(tui: TUI, theme: Theme) {
		this.tui = tui;
		this.theme = theme;
		this.timer = setInterval(() => {
			this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
			this.tui.requestRender();
		}, 120);
		this.timer.unref();
	}

	setResults(results: readonly SingleResult[]): void {
		const now = Date.now();
		for (const [index, result] of results.entries()) {
			const key = resultKey(result, index);
			if (!this.startedAt.has(key)) this.startedAt.set(key, now);
			if (result.exitCode !== -1 && !this.finishedAt.has(key)) this.finishedAt.set(key, now);
		}
		this.results = results;
		this.invalidate();
		this.tui.requestRender();
	}

	protected icon(result: SingleResult): string {
		if (result.exitCode === -1) return this.theme.fg("accent", SPINNER_FRAMES[this.frame] ?? "⠋");
		if (isResultError(result)) return this.theme.fg("error", "✗");
		return this.theme.fg("success", "✓");
	}

	protected elapsed(result: SingleResult, index: number): string {
		const key = resultKey(result, index);
		const start = this.startedAt.get(key) ?? Date.now();
		return formatDuration((this.finishedAt.get(key) ?? Date.now()) - start);
	}

	dispose(): void {
		clearInterval(this.timer);
	}

	invalidate(): void {}

	abstract render(width: number): string[];
}

export class SubagentAgentsWidget extends LiveSubagentComponent {
	private selected?: number;

	setSelection(selected: number | undefined): void {
		this.selected = selected;
		this.tui.requestRender();
	}

	render(width: number): string[] {
		if (width <= 0 || this.results.length === 0) return [];
		const lines = [this.theme.fg("dim", "○ Agents")];
		for (const [index, result] of this.results.entries()) {
			const branch = index === this.results.length - 1 ? "└─" : "├─";
			const active = index === this.selected;
			const selection = this.theme.fg(active ? "accent" : "dim", active ? "●" : "○");
			const prompt = truncateToWidth(oneLine(result.prompt) || "working", Math.max(8, width - 34));
			const status = isResultSuccess(result) ? "done" : result.exitCode === -1 ? "working" : "failed";
			const agent = active ? this.theme.fg("accent", this.theme.bold(result.agent)) : this.theme.bold(result.agent);
			const label = `${branch} ${selection} ${this.icon(result)} ${agent}  ${prompt}`;
			lines.push(
				truncateToWidth(`${label}${this.theme.fg("dim", ` · ${status} · ${this.elapsed(result, index)}`)}`, width),
			);
		}
		return lines;
	}
}

export class SubagentFleetWidget extends LiveSubagentComponent {
	private selected?: number;

	setSelection(selected: number | undefined): void {
		this.selected = selected;
		this.tui.requestRender();
	}

	render(width: number): string[] {
		if (width <= 0 || this.results.length === 0) return [];
		const lines = [
			this.theme.fg("dim", "esc to interrupt · ↓ to select · tab to view agent runtime"),
			"",
			`${this.theme.fg(this.selected === undefined ? "accent" : "dim", this.selected === undefined ? "●" : "○")} ${this.theme.bold("main")}`,
		];
		for (const [index, result] of this.results.entries()) {
			const prompt = truncateToWidth(oneLine(result.prompt) || "working", Math.max(8, Math.floor(width * 0.55)));
			const active = index === this.selected;
			const left = `${this.theme.fg(active ? "accent" : "dim", active ? "●" : "○")} ${this.theme.fg(active ? "text" : "muted", result.agent)}  ${prompt}`;
			const tokenText = `${this.elapsed(result, index)} · ↓ ${formatTokens(result.usage.output)} tokens`;
			lines.push(padBetween(left, this.theme.fg("dim", tokenText), width));
		}
		return lines.map((line) => truncateToWidth(line, width));
	}
}

export class SubagentFleetEditor extends CustomEditor {
	private readonly fleetKeybindings: KeybindingsManager;
	private readonly getResults: () => readonly SingleResult[];
	private readonly getFleet: () => SubagentFleetWidget | undefined;
	private readonly activateFleet: () => SubagentFleetWidget | undefined;
	private readonly deactivateFleet: () => void;
	private readonly openSelected: (index: number) => void;
	private selected?: number;

	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		getResults: () => readonly SingleResult[],
		getFleet: () => SubagentFleetWidget | undefined,
		activateFleet: () => SubagentFleetWidget | undefined,
		deactivateFleet: () => void,
		openSelected: (index: number) => void,
	) {
		super(tui, theme, keybindings);
		this.fleetKeybindings = keybindings;
		this.getResults = getResults;
		this.getFleet = getFleet;
		this.activateFleet = activateFleet;
		this.deactivateFleet = deactivateFleet;
		this.openSelected = openSelected;
	}

	override handleInput(data: string): void {
		const results = this.getResults();
		if (this.getText().length === 0 && results.length > 0) {
			if (this.fleetKeybindings.matches(data, "tui.input.tab")) {
				const target = this.selected ?? 0;
				this.selected = target;
				this.getFleet()?.setSelection(target);
				this.openSelected(target);
				return;
			}
			if (this.fleetKeybindings.matches(data, "tui.select.down")) {
				this.selected = this.selected === undefined ? 0 : (this.selected + 1) % results.length;
				const fleet = this.getFleet() ?? this.activateFleet();
				fleet?.setResults(results);
				fleet?.setSelection(this.selected);
				return;
			}
			if (this.selected !== undefined && this.fleetKeybindings.matches(data, "tui.select.up")) {
				if (this.selected === 0) {
					this.selected = undefined;
					this.deactivateFleet();
				} else {
					this.selected--;
					this.getFleet()?.setSelection(this.selected);
				}
				return;
			}
			if (this.selected !== undefined && this.fleetKeybindings.matches(data, "tui.input.submit")) {
				this.openSelected(this.selected);
				return;
			}
			if (this.selected !== undefined && this.fleetKeybindings.matches(data, "tui.select.cancel")) {
				this.selected = undefined;
				this.deactivateFleet();
				return;
			}
		}
		super.handleInput(data);
	}
}

function padLine(value: string, width: number): string {
	const clipped = truncateToWidth(value, Math.max(1, width), "");
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function assistantLines(result: SingleResult): string[] {
	const lines: string[] = [];
	const items = getDisplayItems(result.messages);
	for (const item of items) {
		if (item.type === "text") lines.push(...item.text.replace(/\r\n?/gu, "\n").split("\n"));
		else lines.push(`→ ${item.name} ${JSON.stringify(item.args)}`);
	}
	if (items.length === 0) lines.push(result.exitCode === -1 ? "(waiting for output…)" : "(no captured output)");
	if (result.errorMessage) lines.push("", `[Error] ${result.errorMessage}`);
	return lines;
}

function thinkingLines(result: SingleResult): string[] {
	const lines: string[] = [];
	for (const message of result.messages) {
		if (message.role !== "assistant") continue;
		for (const part of message.content) {
			if (part.type !== "thinking") continue;
			const thinking = Reflect.get(part, "thinking");
			if (typeof thinking === "string" && thinking.trim()) {
				lines.push(...thinking.replace(/\r\n?/gu, "\n").split("\n"));
			}
		}
	}
	return lines;
}

export class SubagentConversationView implements Component {
	private selected = 0;
	private scrollOffset = 0;
	private thinkingExpanded = false;
	private frame = 0;
	private readonly getResults: () => readonly SingleResult[];
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly done: () => void;
	private readonly onSelectionChange?: (index: number) => void;
	private readonly timer: NodeJS.Timeout;

	constructor(
		getResults: () => readonly SingleResult[],
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		done: () => void,
		initialSelection = 0,
		onSelectionChange?: (index: number) => void,
	) {
		this.getResults = getResults;
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.done = done;
		this.selected = initialSelection;
		this.onSelectionChange = onSelectionChange;
		this.onSelectionChange?.(this.selected);
		this.timer = setInterval(() => {
			this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
			this.tui.requestRender();
		}, 120);
		this.timer.unref();
	}

	render(width: number): string[] {
		const safeWidth = Math.max(40, width);
		const results = this.getResults();
		if (this.selected >= results.length) this.selected = Math.max(0, results.length - 1);
		const result = results[this.selected];
		if (!result) return [this.theme.fg("muted", "No subagent runtime is available.")];
		const innerWidth = safeWidth - 4;
		const state = result.exitCode === -1 ? SPINNER_FRAMES[this.frame] : isResultError(result) ? "✗" : "✓";
		const tokens = result.usage.input + result.usage.output + result.usage.cacheWrite;
		const header = `${state} ${this.theme.bold(result.agent)}  ${oneLine(result.prompt)} · ${formatTokens(tokens)} token`;
		const thoughts = thinkingLines(result);
		const thinkingKey = this.keybindings.getKeys("app.thinking.toggle")[0] ?? "ctrl+t";
		const conversation = ["[User]", result.prompt, ""];
		if (thoughts.length > 0) {
			conversation.push(
				`[Thinking] ${this.thinkingExpanded ? `(${thinkingKey} collapse)` : `(collapsed · ${thinkingKey} expand)`}`,
			);
			if (this.thinkingExpanded) conversation.push(...thoughts);
			conversation.push("");
		}
		conversation.push("[Assistant]", ...assistantLines(result));
		const allConversation = conversation.flatMap((line) => wrapTextWithAnsi(line, innerWidth));
		const overlayRows = Math.max(1, Math.floor((this.tui.terminal?.rows ?? 30) * 0.82));
		const maxBodyLines = Math.max(4, Math.min(22, overlayRows - 9));
		const maximumOffset = Math.max(0, allConversation.length - maxBodyLines);
		this.scrollOffset = Math.min(this.scrollOffset, maximumOffset);
		const body = allConversation.slice(this.scrollOffset, this.scrollOffset + maxBodyLines);
		const currentState = result.exitCode === -1 ? "running" : isResultError(result) ? "failed" : "done";
		const instructions = `${this.keybindings.getKeys("tui.input.tab")[0] ?? "tab"} next agent · ${this.keybindings.getKeys("tui.select.up")[0] ?? "up"}/${this.keybindings.getKeys("tui.select.down")[0] ?? "down"} scroll · ${this.keybindings.getKeys("tui.select.pageUp")[0] ?? "pgup"}/${this.keybindings.getKeys("tui.select.pageDown")[0] ?? "pgdn"} page · ${this.keybindings.getKeys("tui.select.cancel")[0] ?? "esc"} close`;
		const content = [
			header,
			this.theme.fg("dim", `Agent: ● ${(result.callIndex ?? this.selected) + 1} ${result.agent} · ${currentState}`),
			this.theme.fg("border", "─".repeat(innerWidth)),
			...body,
			...Array.from({ length: Math.max(0, maxBodyLines - body.length) }, () => ""),
			this.theme.fg("border", "─".repeat(innerWidth)),
			this.theme.fg("dim", `${allConversation.length} lines · ${instructions}`),
		];
		const title = " Agent runtime ";
		return [
			this.theme.fg("border", `╭${title}${"─".repeat(Math.max(0, safeWidth - visibleWidth(title) - 2))}╮`),
			...content.map(
				(line) => `${this.theme.fg("border", "│ ")}${padLine(line, innerWidth)}${this.theme.fg("border", " │")}`,
			),
			this.theme.fg("border", `╰${"─".repeat(safeWidth - 2)}╯`),
		].map((line) => truncateToWidth(line, safeWidth));
	}

	handleInput(data: string): void {
		const results = this.getResults();
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.done();
			return;
		}
		if (results.length === 0) return;
		if (this.keybindings.matches(data, "tui.input.tab")) {
			this.selected = (this.selected + 1) % results.length;
			this.scrollOffset = 0;
			this.onSelectionChange?.(this.selected);
		} else if (this.keybindings.matches(data, "app.thinking.toggle")) {
			this.thinkingExpanded = !this.thinkingExpanded;
			this.scrollOffset = 0;
		} else if (this.keybindings.matches(data, "tui.select.up")) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
		} else if (this.keybindings.matches(data, "tui.select.down")) {
			this.scrollOffset += 1;
		} else if (this.keybindings.matches(data, "tui.select.pageUp")) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 10);
		} else if (this.keybindings.matches(data, "tui.select.pageDown")) {
			this.scrollOffset += 10;
		}
		this.tui.requestRender();
	}

	dispose(): void {
		clearInterval(this.timer);
	}

	invalidate(): void {}
}
