import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { PIXEL_SPINNER_FRAMES } from "../ui/pixel-spinner.ts";

export type StudyPhase =
	| "preparing"
	| "authenticating"
	| "analyzing"
	| "parsing"
	| "awaiting_confirmation"
	| "saving"
	| "completed"
	| "failed"
	| "cancelled";

export interface StudyProgressEntry {
	phase: StudyPhase;
	message: string;
	timestamp: number;
}

export interface StudyStatusSnapshot {
	state: "idle" | "running" | "completed" | "failed" | "cancelled";
	focus?: string;
	startedAt?: number;
	finishedAt?: number;
	title?: string;
	summary?: string;
	filename?: string;
	entries: readonly StudyProgressEntry[];
}

type StudyStatusListener = (snapshot: StudyStatusSnapshot) => void;

function oneLine(value: string): string {
	return value.replace(/\s+/gu, " ").trim();
}

/** Observable status retained for the active or most recently finished study task. */
export class StudyStatusTracker {
	private snapshot: StudyStatusSnapshot = { state: "idle", entries: [] };
	private readonly listeners = new Set<StudyStatusListener>();

	getSnapshot(): StudyStatusSnapshot {
		return { ...this.snapshot, entries: [...this.snapshot.entries] };
	}

	subscribe(listener: StudyStatusListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	start(focus: string): void {
		const timestamp = Date.now();
		this.snapshot = {
			state: "running",
			focus: oneLine(focus) || "从当前会话提炼可复用知识",
			startedAt: timestamp,
			entries: [{ phase: "preparing", message: "正在整理学习要求与会话上下文", timestamp }],
		};
		this.publish();
	}

	update(phase: StudyPhase, message: string): void {
		if (this.snapshot.state !== "running") return;
		this.snapshot = {
			...this.snapshot,
			entries: [...this.snapshot.entries, { phase, message, timestamp: Date.now() }],
		};
		this.publish();
	}

	complete(result: { title: string; summary: string; filename: string }): void {
		if (this.snapshot.state !== "running") return;
		const timestamp = Date.now();
		this.snapshot = {
			...this.snapshot,
			state: "completed",
			finishedAt: timestamp,
			title: result.title,
			summary: result.summary,
			filename: result.filename,
			entries: [...this.snapshot.entries, { phase: "completed", message: `学习完成：${result.title}`, timestamp }],
		};
		this.publish();
	}

	fail(message: string): void {
		this.finish("failed", "failed", message);
	}

	cancel(message: string): void {
		this.finish("cancelled", "cancelled", message);
	}

	private finish(state: "failed" | "cancelled", phase: "failed" | "cancelled", message: string): void {
		if (this.snapshot.state !== "running") return;
		const timestamp = Date.now();
		this.snapshot = {
			...this.snapshot,
			state,
			finishedAt: timestamp,
			entries: [...this.snapshot.entries, { phase, message, timestamp }],
		};
		this.publish();
	}

	private publish(): void {
		const snapshot = this.getSnapshot();
		for (const listener of this.listeners) listener(snapshot);
	}
}

function formatElapsed(startedAt: number | undefined, finishedAt: number | undefined): string {
	if (startedAt === undefined) return "0.0s";
	const milliseconds = Math.max(0, (finishedAt ?? Date.now()) - startedAt);
	if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(1)}s`;
	const minutes = Math.floor(milliseconds / 60_000);
	const seconds = Math.floor((milliseconds % 60_000) / 1000);
	return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
}

function padAnsi(value: string, width: number): string {
	const clipped = truncateToWidth(value, Math.max(1, width), "");
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

export function formatStudyStatus(snapshot: StudyStatusSnapshot): string {
	if (snapshot.state === "idle") return "当前没有学习任务记录。";
	const elapsed = formatElapsed(snapshot.startedAt, snapshot.finishedAt);
	const entries = snapshot.entries.map((entry) => `- ${entry.message}`).join("\n");
	return `学习状态：${snapshot.state}\n目标：${snapshot.focus ?? "未指定"}\n耗时：${elapsed}\n\n${entries}`;
}

export class StudyStatusView implements Component {
	private snapshot: StudyStatusSnapshot;
	private frameIndex = 0;
	private readonly unsubscribe: () => void;
	private readonly timer: ReturnType<typeof setInterval>;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly done: () => void;

	constructor(tracker: StudyStatusTracker, tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: () => void) {
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.done = done;
		this.snapshot = tracker.getSnapshot();
		this.unsubscribe = tracker.subscribe((snapshot) => {
			this.snapshot = snapshot;
			this.tui.requestRender();
		});
		this.timer = setInterval(() => {
			if (this.snapshot.state !== "running") return;
			this.frameIndex = (this.frameIndex + 1) % PIXEL_SPINNER_FRAMES.length;
			this.tui.requestRender();
		}, 120);
		this.timer.unref();
	}

	render(width: number): string[] {
		const safeWidth = Math.max(32, width);
		const innerWidth = safeWidth - 4;
		const snapshot = this.snapshot;
		const body: string[] = [];
		const stateIcon =
			snapshot.state === "running"
				? this.theme.fg("accent", PIXEL_SPINNER_FRAMES[this.frameIndex] ?? PIXEL_SPINNER_FRAMES[0])
				: snapshot.state === "completed"
					? this.theme.fg("success", "✓")
					: snapshot.state === "failed"
						? this.theme.fg("error", "✗")
						: snapshot.state === "cancelled"
							? this.theme.fg("warning", "■")
							: this.theme.fg("dim", "○");
		const stateLabel =
			snapshot.state === "running"
				? "AI 正在学习"
				: snapshot.state === "completed"
					? "学习完成"
					: snapshot.state === "failed"
						? "学习失败"
						: snapshot.state === "cancelled"
							? "学习已取消"
							: "暂无学习记录";
		body.push(
			`${stateIcon} ${this.theme.bold(stateLabel)} ${this.theme.fg("dim", `· ${formatElapsed(snapshot.startedAt, snapshot.finishedAt)}`)}`,
		);
		if (snapshot.focus) body.push(this.theme.fg("muted", `目标：${snapshot.focus}`));
		body.push("", this.theme.fg("toolTitle", this.theme.bold("学习过程")));

		if (snapshot.entries.length === 0) {
			body.push(this.theme.fg("muted", "尚未启动 /study。"));
		} else {
			const visibleEntries = snapshot.entries.slice(-10);
			for (const [index, entry] of visibleEntries.entries()) {
				const isLast = index === visibleEntries.length - 1;
				const icon =
					isLast && snapshot.state === "running"
						? this.theme.fg("accent", PIXEL_SPINNER_FRAMES[this.frameIndex] ?? PIXEL_SPINNER_FRAMES[0])
						: entry.phase === "failed"
							? this.theme.fg("error", "✗")
							: entry.phase === "cancelled"
								? this.theme.fg("warning", "■")
								: this.theme.fg("success", "✓");
				const offset = formatElapsed(snapshot.startedAt, entry.timestamp);
				body.push(`${icon} ${entry.message} ${this.theme.fg("dim", `+${offset}`)}`);
			}
		}

		if (snapshot.title || snapshot.summary) {
			body.push("", this.theme.fg("toolTitle", this.theme.bold(snapshot.title ?? "学习结果")));
			if (snapshot.summary) body.push(snapshot.summary);
			if (snapshot.filename) body.push(this.theme.fg("dim", `~/.omega/knowledge/${snapshot.filename}`));
		}

		const cancel = this.keybindings.getKeys("tui.select.cancel")[0] ?? "esc";
		body.push(
			"",
			this.theme.fg("dim", `${cancel} 关闭窗口${snapshot.state === "running" ? " · 后台学习不会停止" : ""}`),
		);
		const title = " AI 学习状态 ";
		const top = this.theme.fg("border", `╭${title}${"─".repeat(Math.max(0, safeWidth - visibleWidth(title) - 2))}╮`);
		const bottom = this.theme.fg("border", `╰${"─".repeat(innerWidth + 2)}╯`);
		return [
			top,
			...body.map(
				(line) => `${this.theme.fg("border", "│ ")}${padAnsi(line, innerWidth)}${this.theme.fg("border", " │")}`,
			),
			bottom,
		].map((line) => truncateToWidth(line, safeWidth));
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.cancel")) this.done();
	}

	invalidate(): void {}

	dispose(): void {
		clearInterval(this.timer);
		this.unsubscribe();
	}
}
