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
		"OMEGA / COST · 当前会话累计",
		`当前模型: ${report.currentModel ?? "未选择"}`,
		`总计: ${report.total.totalTokens.toLocaleString()} tokens · $${report.total.cost.toFixed(4)} · ${report.total.calls} 次计费记录`,
		"",
		"模型消费 · 供应商 usage / USD",
	];
	const maxModel = Math.max(0, ...report.models.map((model) => model.totalTokens));
	for (const model of report.models) {
		lines.push(
			`${model.model === report.currentModel ? "›" : " "} ${truncateToWidth(model.model, 22, "…").padEnd(22)} ${costBar(model.totalTokens, maxModel, barWidth)} ${model.totalTokens.toLocaleString()} · $${model.cost.toFixed(4)}`,
		);
	}
	if (report.models.length === 0) lines.push("尚无模型调用记录");
	if (report.unattributed.calls > 0)
		lines.push(
			`其他计费（工具/摘要，模型未归因）: ${report.unattributed.totalTokens.toLocaleString()} · $${report.unattributed.cost.toFixed(4)}`,
		);
	const current = report.models.find((model) => model.model === report.currentModel);
	if (current) {
		lines.push("", "当前模型精确用量 · 输入 / 输出 / 缓存读 / 缓存写");
		const dimensions = [
			["输入", current.input],
			["输出", current.output],
			["缓存读", current.cacheRead],
			["缓存写", current.cacheWrite],
		] as const;
		const maxDimension = Math.max(0, ...dimensions.map(([, value]) => value));
		for (const [label, value] of dimensions)
			lines.push(`${label.padEnd(6)} ${costBar(value, maxDimension, barWidth)} ${value.toLocaleString()}`);
	}
	lines.push("", "内容来源 · 当前分支文本粗估（UTF-8 字节 / 4；非计费归因）");
	const maxSource = Math.max(0, ...report.sources.map((source) => source.tokens));
	for (const source of report.sources) {
		lines.push(
			`${source.label.padEnd(12)} ${costBar(source.tokens, maxSource, barWidth)} ~${source.tokens.toLocaleString()}`,
		);
	}
	lines.push("", "提示：/cost models 查看明细；/cost export 导出 HTML；Esc 关闭");
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
