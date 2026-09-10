import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type {
	WorkflowExecutionNode,
	WorkflowExecutionStatus,
	WorkflowService,
	WorkflowStatusSnapshot,
} from "./service.ts";

interface SelectableAgent {
	run: WorkflowExecutionStatus;
	node: WorkflowExecutionNode;
}

function padAnsi(value: string, width: number): string {
	const clipped = truncateToWidth(value, Math.max(1, width), "");
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function runsFromSnapshot(snapshot: WorkflowStatusSnapshot): WorkflowExecutionStatus[] {
	const runs = [...snapshot.active];
	if (snapshot.last && !runs.some((run) => run.id === snapshot.last?.id)) runs.push(snapshot.last);
	return runs;
}

function selectableAgents(snapshot: WorkflowStatusSnapshot): SelectableAgent[] {
	return runsFromSnapshot(snapshot).flatMap((run) =>
		run.nodes.filter((node) => node.kind === "agent").map((node) => ({ run, node })),
	);
}

function statusIcon(state: WorkflowExecutionNode["state"]): string {
	if (state === "running") return "●";
	if (state === "succeeded") return "✓";
	return "✗";
}

function outputLines(node: WorkflowExecutionNode, limit: number): string[] {
	if (node.output) return node.output.replace(/\r\n?/gu, "\n").split("\n").slice(-limit);
	if (node.error) return [node.error];
	return [node.state === "running" ? "(running, no output yet)" : "(no captured output)"];
}

export class WorkflowStatusView implements Component {
	private snapshot: WorkflowStatusSnapshot;
	private selectedId?: string;
	private readonly unsubscribe: () => void;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly done: () => void;

	constructor(service: WorkflowService, tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: () => void) {
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.done = done;
		this.snapshot = service.getStatus();
		this.selectedId = selectableAgents(this.snapshot)[0]?.node.id;
		this.unsubscribe = service.subscribe((snapshot) => {
			this.snapshot = snapshot;
			this.ensureSelection();
			this.tui.requestRender();
		});
	}

	render(width: number): string[] {
		const safeWidth = Math.max(8, width);
		const inner = safeWidth - 4;
		const agents = selectableAgents(this.snapshot);
		const selected = agents.find((entry) => entry.node.id === this.selectedId) ?? agents[0];
		const body: string[] = [];
		const runs = runsFromSnapshot(this.snapshot);
		if (runs.length === 0) {
			body.push(this.theme.fg("muted", "当前没有 workflow 运行记录。"));
		} else {
			for (const run of runs) {
				const color = run.state === "running" ? "warning" : run.state === "failed" ? "error" : "success";
				body.push(
					`${this.theme.fg(color, run.state === "running" ? "●" : run.state === "failed" ? "✗" : "✓")} ${this.theme.fg("accent", run.name)} ${this.theme.fg("dim", `${run.phase ?? "unphased"} · ${run.completedNodes}/${run.nodes.length} done`)}`,
				);
				for (const node of run.nodes.filter((candidate) => candidate.kind === "agent")) {
					const active = node.id === selected?.node.id;
					const row = `${active ? "›" : " "} ${statusIcon(node.state)} ${node.label} ${this.theme.fg("dim", `[${node.agentType ?? "agent"}]`)}`;
					body.push(active ? this.theme.fg("accent", this.theme.bold(row)) : row);
				}
			}
		}
		body.push("");
		if (selected) {
			body.push(this.theme.fg("toolTitle", this.theme.bold(`Agent output · ${selected.node.label}`)));
			body.push(
				this.theme.fg(
					"dim",
					`${selected.run.name} · ${selected.node.agentType ?? "agent"} · ${selected.node.state}`,
				),
			);
			if (selected.node.prompt)
				body.push(this.theme.fg("muted", `Prompt: ${selected.node.prompt.replace(/\s+/gu, " ").trim()}`));
			body.push(...outputLines(selected.node, 14).map((line) => this.theme.fg("toolOutput", line)));
		} else {
			body.push(this.theme.fg("muted", "当前 workflow 尚未启动 agent。"));
		}
		const up = this.keybindings.getKeys("tui.select.up")[0] ?? "up";
		const down = this.keybindings.getKeys("tui.select.down")[0] ?? "down";
		const cancel = this.keybindings.getKeys("tui.select.cancel")[0] ?? "esc";
		body.push("", this.theme.fg("dim", `${up}/${down} 选择 Agent · ${cancel} 关闭`));
		const title = " Workflow runtime ";
		const top = this.theme.fg("border", `╭${title}${"─".repeat(Math.max(0, safeWidth - visibleWidth(title) - 2))}╮`);
		const bottom = this.theme.fg("border", `╰${"─".repeat(inner + 2)}╯`);
		return [
			top,
			...body.map(
				(line) => `${this.theme.fg("border", "│ ")}${padAnsi(line, inner)}${this.theme.fg("border", " │")}`,
			),
			bottom,
		].map((line) => truncateToWidth(line, safeWidth));
	}

	handleInput(data: string): void {
		const agents = selectableAgents(this.snapshot);
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.done();
			return;
		}
		if (agents.length === 0) return;
		const current = Math.max(
			0,
			agents.findIndex((entry) => entry.node.id === this.selectedId),
		);
		if (this.keybindings.matches(data, "tui.select.up")) {
			this.selectedId = agents[(current - 1 + agents.length) % agents.length]?.node.id;
			this.tui.requestRender();
		}
		if (this.keybindings.matches(data, "tui.select.down")) {
			this.selectedId = agents[(current + 1) % agents.length]?.node.id;
			this.tui.requestRender();
		}
	}

	invalidate(): void {}

	dispose(): void {
		this.unsubscribe();
	}

	private ensureSelection(): void {
		const agents = selectableAgents(this.snapshot);
		if (!agents.some((entry) => entry.node.id === this.selectedId)) this.selectedId = agents[0]?.node.id;
	}
}
