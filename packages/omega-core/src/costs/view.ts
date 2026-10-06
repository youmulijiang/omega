import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { CostReport } from "./report.ts";

export function costBar(value: number, maximum: number, width: number): string {
	const cells = Math.max(0, Math.floor(width));
	const filled = maximum > 0 ? Math.round((Math.max(0, value) / maximum) * cells) : 0;
	return "█".repeat(Math.min(cells, filled)) + "░".repeat(Math.max(0, cells - filled));
}

function frameLine(text: string, width: number): string {
	const innerWidth = Math.max(0, width - 4);
	const clipped = truncateToWidth(text, innerWidth, "");
	return `│ ${clipped}${" ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)))} │`;
}

export function renderCostDashboard(report: CostReport, width: number): string[] {
	const safeWidth = Math.max(8, width);
	const innerWidth = safeWidth - 4;
	const barWidth = Math.max(0, Math.min(24, innerWidth - 33));
	const lines: string[] = [
		"OMEGA / COST · Current session totals",
		`Current model: ${report.currentModel ?? "none selected"}`,
		`Total: ${report.total.totalTokens.toLocaleString()} tokens · $${report.total.cost.toFixed(4)} · ${report.total.calls} billed entries`,
		"",
		"Model usage · provider usage / USD",
	];
	const maxModel = Math.max(0, ...report.models.map((model) => model.totalTokens));
	for (const model of report.models) {
		lines.push(
			`${model.model === report.currentModel ? "›" : " "} ${truncateToWidth(model.model, 22, "…").padEnd(22)} ${costBar(model.totalTokens, maxModel, barWidth)} ${model.totalTokens.toLocaleString()} · $${model.cost.toFixed(4)}`,
		);
	}
	if (report.models.length === 0) lines.push("No model calls recorded yet");
	if (report.unattributed.calls > 0)
		lines.push(
			`Other billing (tools/summaries, unattributed to a model): ${report.unattributed.totalTokens.toLocaleString()} · $${report.unattributed.cost.toFixed(4)}`,
		);
	const current = report.models.find((model) => model.model === report.currentModel);
	if (current) {
		lines.push("", "Current model exact usage · input / output / cache read / cache write");
		const dimensions = [
			["Input", current.input],
			["Output", current.output],
			["Cache read", current.cacheRead],
			["Cache write", current.cacheWrite],
		] as const;
		const maxDimension = Math.max(0, ...dimensions.map(([, value]) => value));
		for (const [label, value] of dimensions)
			lines.push(`${label.padEnd(6)} ${costBar(value, maxDimension, barWidth)} ${value.toLocaleString()}`);
	}
	lines.push("", "Content sources · rough estimate of current branch text (UTF-8 bytes / 4; non-billed attribution)");
	const maxSource = Math.max(0, ...report.sources.map((source) => source.tokens));
	for (const source of report.sources) {
		lines.push(
			`${source.label.padEnd(12)} ${costBar(source.tokens, maxSource, barWidth)} ~${source.tokens.toLocaleString()}`,
		);
	}
	lines.push("", "Tip: /cost models for details; /cost export for HTML; Esc to close");
	const top = `╭${"─".repeat(safeWidth - 2)}╮`;
	const bottom = `╰${"─".repeat(safeWidth - 2)}╯`;
	return [top, ...lines.map((line) => frameLine(line, safeWidth)), bottom].map((line) =>
		truncateToWidth(line, safeWidth, ""),
	);
}

export class CostDashboard implements Component {
	private readonly report: CostReport;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly done: () => void;

	constructor(report: CostReport, theme: Theme, keybindings: KeybindingsManager, done: () => void) {
		this.report = report;
		this.theme = theme;
		this.keybindings = keybindings;
		this.done = done;
	}

	render(width: number): string[] {
		return renderCostDashboard(this.report, width).map((line) => this.theme.fg("text", line));
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.cancel")) this.done();
	}

	invalidate(): void {}
}
