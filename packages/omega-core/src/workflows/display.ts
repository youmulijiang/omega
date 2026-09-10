import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { WorkflowExecutionNode, WorkflowExecutionStatus } from "./service.ts";

export const WORKFLOW_MESSAGE_TYPE = "omega-workflow-result";

export interface WorkflowDisplayDetails {
	kind: "omega-workflow";
	status: WorkflowExecutionStatus;
}

function stateIcon(state: WorkflowExecutionStatus["state"] | WorkflowExecutionNode["state"]): string {
	if (state === "running") return "●";
	if (state === "succeeded") return "✓";
	return "✗";
}

function oneLine(value: string): string {
	return value.replace(/\s+/gu, " ").trim();
}

function shorten(value: string, max: number): string {
	const text = oneLine(value);
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function outputTail(output: string, limit: number): string[] {
	const lines = output.replace(/\r\n?/gu, "\n").split("\n");
	return lines.slice(-limit);
}

function resultSummary(result: unknown): string | undefined {
	if (result === undefined) return undefined;
	if (typeof result === "string") return result;
	if (typeof result === "object" && result !== null) {
		const summary = Reflect.get(result, "summary");
		if (typeof summary === "string" && summary.trim()) return summary;
	}
	try {
		return JSON.stringify(result);
	} catch {
		return String(result);
	}
}

function padLine(value: string, width: number): string {
	const clipped = truncateToWidth(value, width, "");
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

class WorkflowToolboxFrame implements Component {
	private readonly content: Text;
	private readonly color: "error" | "success" | "warning";
	private readonly theme: Pick<Theme, "fg">;

	constructor(content: Text, color: "error" | "success" | "warning", theme: Pick<Theme, "fg">) {
		this.content = content;
		this.color = color;
		this.theme = theme;
	}

	render(width: number): string[] {
		const frameWidth = Math.max(4, width);
		const innerWidth = frameWidth - 2;
		const border = (value: string) => this.theme.fg(this.color, value);
		return [
			"",
			border(`╭${"─".repeat(innerWidth)}╮`),
			...this.content.render(innerWidth).map((line) => `${border("│")}${padLine(line, innerWidth)}${border("│")}`),
			border(`╰${"─".repeat(innerWidth)}╯`),
		];
	}

	invalidate(): void {
		this.content.invalidate();
	}
}

export function renderWorkflowStatusText(
	status: WorkflowExecutionStatus,
	expanded: boolean,
	theme: Pick<Theme, "fg" | "bold">,
): string {
	const stateColor = status.state === "failed" ? "error" : status.state === "succeeded" ? "success" : "warning";
	const elapsed = (status.finishedAt ?? Date.now()) - status.startedAt;
	const lines = [
		`${theme.fg(stateColor, stateIcon(status.state))} ${theme.fg("toolTitle", theme.bold(`Workflow: ${status.name}`))} ${theme.fg("dim", `[${status.state}]`)}`,
		`  ${theme.fg("muted", `phase ${status.phase ?? "unphased"} · ${status.completedNodes}/${status.nodes.length} done · ${status.runningNodes} running · ${elapsed}ms`)}`,
	];
	const visibleNodes = expanded ? status.nodes : status.nodes.slice(-4);
	for (const node of visibleNodes) {
		const color = node.state === "failed" ? "error" : node.state === "succeeded" ? "success" : "warning";
		const type = node.kind === "agent" && node.agentType ? `agent:${node.agentType}` : node.kind;
		lines.push(
			`  ${theme.fg(color, stateIcon(node.state))} ${theme.fg("accent", shorten(node.label, 48))} ${theme.fg("dim", `[${type}]${node.phase ? ` · ${node.phase}` : ""}`)}`,
		);
		if (expanded) {
			if (node.prompt) lines.push(`    ${theme.fg("muted", `prompt: ${shorten(node.prompt, 120)}`)}`);
			if (node.output) {
				for (const line of outputTail(node.output, 16)) lines.push(`    ${theme.fg("toolOutput", line)}`);
			} else if (node.state === "running") {
				lines.push(`    ${theme.fg("muted", "(running, no output yet)")}`);
			}
			if (node.error) lines.push(`    ${theme.fg("error", node.error)}`);
		}
	}
	const summary = resultSummary(status.result);
	if (summary) {
		lines.push(
			"",
			`${theme.fg("muted", "Result:")} ${theme.fg("toolOutput", shorten(summary, expanded ? 480 : 180))}`,
		);
	}
	if (!expanded && status.nodes.length > visibleNodes.length) {
		lines.push(`  ${theme.fg("muted", `… ${status.nodes.length - visibleNodes.length} earlier nodes`)}`);
	}
	if (expanded && status.logs.length > 0) {
		lines.push("", theme.fg("muted", "  Recent logs:"));
		for (const log of status.logs.slice(-5)) lines.push(`  ${theme.fg("toolOutput", log)}`);
	}
	if (!expanded) lines.push(theme.fg("muted", "  Ctrl+O 展开运行详情"));
	return lines.join("\n");
}

export function renderWorkflowResult(
	details: WorkflowDisplayDetails | undefined,
	expanded: boolean,
	theme: Pick<Theme, "fg" | "bold">,
): Text {
	if (!details || details.kind !== "omega-workflow") return new Text("Workflow status unavailable", 0, 0);
	return new Text(renderWorkflowStatusText(details.status, expanded, theme), 0, 0);
}

export function renderWorkflowMessage(
	details: WorkflowDisplayDetails | undefined,
	expanded: boolean,
	theme: Pick<Theme, "fg" | "bold">,
): Component {
	const content = renderWorkflowResult(details, expanded, theme);
	const color =
		details?.status.state === "failed" ? "error" : details?.status.state === "running" ? "warning" : "success";
	return new WorkflowToolboxFrame(content, color, theme);
}
