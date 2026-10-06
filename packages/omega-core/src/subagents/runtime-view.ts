import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import {
	AssistantMessageComponent,
	CustomEditor,
	getMarkdownTheme,
	getSelectListTheme,
	type KeybindingsManager,
	type Theme,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type EditorTheme,
	type Focusable,
	Markdown,
	ScrollView,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { isResultError, isResultSuccess, type SingleResult } from "./types.ts";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
/** Frame rows outside the body: top/bottom borders, header, the two rules, and the footer. */
const FRAME_ROWS = 6;
/** Rows the overlay's own margin keeps clear around the frame. */
const OVERLAY_MARGIN_ROWS = 2;
/** Must match the overlay's `maxHeight` percentage in the view's mount sites. */
const OVERLAY_HEIGHT_RATIO = 0.82;

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

function padLine(value: string, width: number): string {
	const clipped = truncateToWidth(value, Math.max(1, width), "");
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
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
		if (result.exitCode === -1 && result.runtimeState === "idle") return this.theme.fg("accent", "○");
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
			const status = isResultSuccess(result)
				? "done"
				: result.exitCode === -1
					? (result.runtimeState ?? "working")
					: "failed";
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
	private readonly onFocusChange?: (selected: number | undefined) => void;
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
		onFocusChange?: (selected: number | undefined) => void,
	) {
		super(tui, theme, keybindings);
		this.fleetKeybindings = keybindings;
		this.getResults = getResults;
		this.getFleet = getFleet;
		this.activateFleet = activateFleet;
		this.deactivateFleet = deactivateFleet;
		this.openSelected = openSelected;
		this.onFocusChange = onFocusChange;
	}

	private updateSelection(selected: number | undefined): void {
		const focusChanged = (this.selected === undefined) !== (selected === undefined);
		this.selected = selected;
		if (focusChanged) this.onFocusChange?.(selected);
	}

	focusMain(): void {
		this.updateSelection(undefined);
		this.deactivateFleet();
	}

	override handleInput(data: string): void {
		const results = this.getResults();
		if (this.getText().length === 0 && results.length > 0) {
			if (this.fleetKeybindings.matches(data, "tui.input.tab")) {
				const target = this.selected ?? 0;
				this.updateSelection(target);
				this.getFleet()?.setSelection(target);
				this.openSelected(target);
				return;
			}
			if (this.fleetKeybindings.matches(data, "tui.select.down")) {
				this.updateSelection(this.selected === undefined ? 0 : (this.selected + 1) % results.length);
				const fleet = this.getFleet() ?? this.activateFleet();
				fleet?.setResults(results);
				fleet?.setSelection(this.selected);
				return;
			}
			if (this.selected !== undefined && this.fleetKeybindings.matches(data, "tui.select.up")) {
				if (this.selected === 0) {
					this.focusMain();
				} else {
					this.updateSelection(this.selected - 1);
					this.getFleet()?.setSelection(this.selected);
				}
				return;
			}
			if (this.selected !== undefined && this.fleetKeybindings.matches(data, "tui.input.submit")) {
				this.openSelected(this.selected);
				return;
			}
			if (this.selected !== undefined && this.fleetKeybindings.matches(data, "tui.select.cancel")) {
				this.focusMain();
				return;
			}
		}
		super.handleInput(data);
	}
}

type LivePart = NonNullable<SingleResult["liveContent"]>[number];

/** Cheap change signature so the streaming tail only re-renders on real deltas. */
function liveSignature(parts: readonly LivePart[]): string {
	return parts
		.map((part) => {
			if (part.type === "text") return `t${part.text.length}`;
			if (part.type === "thinking") return `k${part.thinking.length}`;
			return `c${part.name}`;
		})
		.join("|");
}

function lastAssistantMessage(messages: readonly Message[]): AssistantMessage | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role === "assistant") return message;
	}
	return undefined;
}

/** Wrap the in-flight RPC deltas as an AssistantMessage so the transcript can stream them in place. */
function liveAssistantMessage(result: SingleResult, parts: readonly LivePart[]): AssistantMessage {
	const template = lastAssistantMessage(result.messages);
	return {
		role: "assistant",
		content: parts.map((part) => {
			if (part.type === "text") return { type: "text" as const, text: part.text };
			if (part.type === "thinking") {
				return { type: "thinking" as const, thinking: part.thinking, thinkingSignature: part.thinkingSignature };
			}
			return { type: "toolCall" as const, id: part.id, name: part.name, arguments: part.arguments };
		}) as AssistantMessage["content"],
		api: template?.api ?? "openai-responses",
		provider: template?.provider ?? "unknown",
		model: template?.model ?? "unknown",
		usage: template?.usage ?? {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: template?.stopReason ?? "stop",
		timestamp: template?.timestamp ?? Date.now(),
	};
}

/** Render one captured child message with the same components the main transcript uses. */
function messageComponents(message: Message, hideThinking: boolean): Component[] {
	if (message.role === "assistant") {
		return [new AssistantMessageComponent(message, hideThinking, getMarkdownTheme(), "Thinking…", 0)];
	}
	if (message.role === "user") {
		return [new UserMessageComponent(messageText(message.content), getMarkdownTheme(), 0)];
	}
	const text = messageText(message.content);
	if (!text) return [];
	return [new Markdown(text, 0, 0, getMarkdownTheme())];
}

/**
 * Transcript of one subagent run.
 *
 * Captured messages are turned into components once and appended as they complete; only the
 * in-flight message is re-rendered as deltas arrive. Rebuilding the whole conversation per frame
 * (what this replaced) both re-parsed every markdown block and produced one "Thinking…" placeholder
 * per completed message.
 */
class SubagentTranscript implements Component {
	private components: Component[] = [];
	private live?: AssistantMessageComponent;
	private liveKey = "";
	private consumed = 0;
	private consumedHead: Message | undefined;
	private consumedPrompts = 0;
	private hideThinking = false;

	setThinkingHidden(hidden: boolean): void {
		if (hidden === this.hideThinking) return;
		this.hideThinking = hidden;
		for (const component of this.components) {
			if (component instanceof AssistantMessageComponent) component.setHideThinkingBlock(hidden);
		}
		this.live?.setHideThinkingBlock(hidden);
	}

	sync(result: SingleResult | undefined): void {
		if (!result) {
			this.reset();
			return;
		}
		this.syncCaptured(result);
		this.syncLive(result);
	}

	/** Drop every built component, e.g. when the viewer switches to a different subagent. */
	reset(): void {
		this.components = [];
		this.live = undefined;
		this.liveKey = "";
		this.consumed = 0;
		this.consumedHead = undefined;
		this.consumedPrompts = 0;
	}

	private syncCaptured(result: SingleResult): void {
		const messages = result.messages;
		const prompts = result.runtimePrompts ?? [];
		// The runner mutates one array in place (push on completion, shift when it truncates the head),
		// so count plus head identity is enough to tell appends from a rewrite.
		const appending =
			this.consumed <= messages.length &&
			(this.consumed === 0 || messages[0] === this.consumedHead) &&
			this.consumedPrompts === prompts.length;
		if (!appending) {
			this.components = [];
			this.rebuild(result);
		} else if (messages.length > this.consumed) {
			// Prompts are unchanged on this path, so only the new messages need components.
			for (let index = this.consumed; index < messages.length; index++) {
				this.components.push(...messageComponents(messages[index]!, this.hideThinking));
			}
		}
		this.consumed = messages.length;
		this.consumedHead = messages[0];
		this.consumedPrompts = prompts.length;
	}

	/** Rebuild every message, interleaving follow-up prompts at their captured positions. */
	private rebuild(result: SingleResult): void {
		const messages = result.messages;
		const prompts = result.runtimePrompts ?? [];
		for (let index = 0; index <= messages.length; index++) {
			for (const prompt of prompts) {
				if (prompt.afterMessageCount !== index) continue;
				this.components.push(new UserMessageComponent(prompt.text, getMarkdownTheme(), 0));
			}
			const message = messages[index];
			if (message) this.components.push(...messageComponents(message, this.hideThinking));
		}
	}

	private syncLive(result: SingleResult): void {
		const parts = result.liveContent;
		if (!parts || parts.length === 0) {
			this.live = undefined;
			this.liveKey = "";
			return;
		}
		const key = liveSignature(parts);
		if (this.live && key === this.liveKey) return;
		this.liveKey = key;
		this.live ??= new AssistantMessageComponent(undefined, this.hideThinking, getMarkdownTheme(), "Thinking…", 0);
		this.live.updateContent(liveAssistantMessage(result, parts), true);
	}

	render(width: number): string[] {
		const lines: string[] = [];
		for (const component of this.components) lines.push(...component.render(width));
		if (this.live) lines.push(...this.live.render(width));
		return lines;
	}

	invalidate(): void {
		for (const component of this.components) component.invalidate();
		this.live?.invalidate();
	}
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(part): part is { type: "text"; text: string } =>
				typeof part === "object" &&
				part !== null &&
				Reflect.get(part, "type") === "text" &&
				typeof Reflect.get(part, "text") === "string",
		)
		.map((part) => part.text)
		.join("");
}

export class SubagentConversationView implements Component, Focusable {
	private readonly getResults: () => readonly SingleResult[];
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly done: () => void;
	private readonly onSelectionChange?: (index: number) => void;
	private readonly onSubmit?: (taskId: string, prompt: string) => void | Promise<void>;
	private readonly editor: CustomEditor;
	private readonly transcript: SubagentTranscript;
	private readonly scrollView: ScrollView;
	/** Last viewport the overlay allotted; the body is clamped to it so follow-end can work. */
	private bodyRows = 20;
	private contentLineCount = 0;
	private selected = 0;
	private thinkingHidden = false;
	private frame = 0;
	private isFocused = false;
	private finished = false;
	private readonly timer: NodeJS.Timeout;

	constructor(
		getResults: () => readonly SingleResult[],
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		done: () => void,
		initialSelection = 0,
		onSelectionChange?: (index: number) => void,
		onSubmit?: (taskId: string, prompt: string) => void | Promise<void>,
	) {
		this.getResults = getResults;
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.done = done;
		this.selected = initialSelection;
		this.onSelectionChange = onSelectionChange;
		this.onSubmit = onSubmit;
		this.transcript = new SubagentTranscript();
		// follow "end" is what makes the view track the conversation the way the main chat does.
		// Inside an overlay no layout engine paints a scrollbar, so the footer carries the position.
		this.scrollView = new ScrollView(this.transcript, { follow: "end" });
		this.editor = new CustomEditor(
			tui,
			{ borderColor: (text) => theme.fg("border", text), selectList: getSelectListTheme() },
			keybindings,
			{ paddingX: 1 },
		);
		this.editor.onSubmit = (text) => {
			const prompt = text.trim();
			const result = this.getResults()[this.selected];
			if (!prompt || !result?.taskId || !this.onSubmit) return;
			this.editor.addToHistory(prompt);
			this.editor.setText("");
			void Promise.resolve(this.onSubmit(result.taskId, prompt)).catch(() => undefined);
		};
		this.onSelectionChange?.(this.selected);
		this.sync();
		this.timer = setInterval(() => {
			this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
			this.sync();
			this.tui.requestRender();
		}, 120);
		this.timer.unref();
	}

	get focused(): boolean {
		return this.isFocused;
	}

	set focused(value: boolean) {
		this.isFocused = value;
		this.editor.focused = value;
	}

	render(width: number): string[] {
		const safeWidth = Math.max(40, width);
		this.sync();
		const innerWidth = safeWidth - 4;
		const editorLines = this.onSubmit ? this.editor.render(innerWidth) : [];
		// The overlay keeps the first `maxHeight` rows of whatever the component returns, so an
		// over-tall frame silently loses its bottom border. Size the frame to exactly the rows the
		// overlay allots (its maxHeight, itself clamped by the margin) and let the scroll view take
		// the remainder.
		const rows = this.tui.terminal?.rows ?? 30;
		const allotted = Math.max(1, Math.min(Math.floor(rows * OVERLAY_HEIGHT_RATIO), rows - OVERLAY_MARGIN_ROWS));
		const chrome = FRAME_ROWS + (this.onSubmit ? 1 + editorLines.length : 0);
		this.bodyRows = Math.max(1, allotted - chrome);
		const contentLines = this.scrollView.render(innerWidth);
		this.contentLineCount = contentLines.length;
		// Nothing else lays this scroll view out inside an overlay, so feed it the viewport here;
		// that is what clamps scrollTop to the tail and makes follow-end scroll with the conversation.
		this.scrollView.updateLayout(contentLines.length, this.bodyRows, () => this.tui.requestRender());
		const body = contentLines.slice(this.scrollView.scrollTop, this.scrollView.scrollTop + this.bodyRows);
		const content = [
			this.renderHeader(innerWidth),
			this.theme.fg("border", "─".repeat(innerWidth)),
			...body,
			...Array.from({ length: Math.max(0, this.bodyRows - body.length) }, () => ""),
			this.theme.fg("border", "─".repeat(innerWidth)),
			this.renderFooter(innerWidth),
			...(this.onSubmit
				? [this.theme.fg("dim", "Send a follow-up prompt to the current subagent:"), ...editorLines]
				: []),
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

	/** Keep the transcript in step with the runner; cheap enough to poll on every frame. */
	private sync(): void {
		const results = this.getResults();
		if (results.length > 0 && this.selected >= results.length) this.selected = results.length - 1;
		this.transcript.sync(results[this.selected]);
	}

	private currentResult(): SingleResult | undefined {
		const results = this.getResults();
		if (results.length === 0) return undefined;
		return results[Math.min(this.selected, results.length - 1)];
	}

	private select(index: number): void {
		const results = this.getResults();
		if (results.length === 0) return;
		this.selected = ((index % results.length) + results.length) % results.length;
		this.transcript.reset();
		this.sync();
		this.scrollView.scrollToEnd();
		this.onSelectionChange?.(this.selected);
		this.tui.requestRender();
	}

	private renderHeader(width: number): string {
		const result = this.currentResult();
		if (!result) return truncateToWidth(this.theme.fg("muted", "No subagent runtime is available."), width);
		const icon =
			result.exitCode === -1
				? result.runtimeState === "idle"
					? this.theme.fg("accent", "○")
					: this.theme.fg("accent", SPINNER_FRAMES[this.frame] ?? "⠋")
				: isResultError(result)
					? this.theme.fg("error", "✗")
					: this.theme.fg("success", "✓");
		const state =
			result.exitCode === -1 ? (result.runtimeState ?? "running") : isResultError(result) ? "failed" : "done";
		const tokens = result.usage.input + result.usage.output + result.usage.cacheWrite;
		const right = `${formatTokens(tokens)} tokens · ${state}`;
		const left = `${icon} ${this.theme.bold(result.agent)}  ${oneLine(result.prompt) || "working"}`;
		return padBetween(
			truncateToWidth(left, Math.max(1, width - visibleWidth(right) - 2)),
			this.theme.fg("dim", right),
			width,
		);
	}

	private renderFooter(width: number): string {
		const results = this.getResults();
		const result = results[this.selected];
		const thinkingKey = this.keybindings.getKeys("app.thinking.toggle")[0] ?? "ctrl+t";
		// No scrollbar is painted inside an overlay, so surface the scroll position here.
		const position =
			this.contentLineCount > this.bodyRows
				? `${this.scrollView.scrollTop + 1}-${Math.min(this.contentLineCount, this.scrollView.scrollTop + this.bodyRows)}/${this.contentLineCount}`
				: undefined;
		const hints = [
			`${(result?.callIndex ?? this.selected) + 1}/${results.length}`,
			`${result?.usage.turns ?? 0} turns`,
			...(position === undefined ? [] : [position]),
			`${this.keybindings.getKeys("tui.input.tab")[0] ?? "tab"} next agent`,
			`${thinkingKey} ${this.thinkingHidden ? "show" : "hide"} thinking`,
			`${this.keybindings.getKeys("tui.select.cancel")[0] ?? "esc"} return`,
		];
		return truncateToWidth(this.theme.fg("dim", hints.join(" · ")), width);
	}

	handleInput(data: string): void {
		if (this.finished) return;
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.finished = true;
			this.done();
			return;
		}
		if (this.editor.getText().length > 0) {
			this.editor.handleInput(data);
			this.tui.requestRender();
			return;
		}
		if (this.getResults().length === 0) return;
		if (this.keybindings.matches(data, "tui.input.tab")) {
			this.select(this.selected + 1);
			return;
		}
		if (this.keybindings.matches(data, "app.thinking.toggle")) {
			this.thinkingHidden = !this.thinkingHidden;
			this.transcript.setThinkingHidden(this.thinkingHidden);
			this.tui.requestRender();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.pageUp")) {
			this.scrollView.scrollBy(-Math.max(1, this.bodyRows));
			this.tui.requestRender();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.pageDown")) {
			this.scrollView.scrollBy(Math.max(1, this.bodyRows));
			this.tui.requestRender();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.up")) {
			this.scrollView.scrollBy(-1);
			this.tui.requestRender();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.down")) {
			this.scrollView.scrollBy(1);
			this.tui.requestRender();
			return;
		}
		if (this.onSubmit) this.editor.handleInput(data);
		this.tui.requestRender();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "wheel" || !event.wheelDelta) return undefined;
		return { handled: true, render: this.scrollView.scrollBy(event.wheelDelta < 0 ? -1 : 1) !== 0 };
	}

	dispose(): void {
		clearInterval(this.timer);
	}

	invalidate(): void {
		this.scrollView.invalidate();
	}
}
