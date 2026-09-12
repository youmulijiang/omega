import { Text, type TUI } from "@earendil-works/pi-tui";

const SPINNER_FRAMES = ["|", "/", "-", "\\"];

/** Expandable built-in startup header with a non-blocking typewriter onboarding line. */
export class StartupHeader extends Text {
	private characters = 0;
	private spinnerFrame = 0;
	private expanded: boolean;
	private timer: ReturnType<typeof setInterval> | undefined;
	private started = false;
	private finished = false;
	private readonly complete: Promise<void>;
	private resolveComplete: () => void = () => {};
	private readonly tui: TUI;
	private readonly collapsedPrefix: string;
	private readonly expandedPrefix: string;
	private readonly onboarding: string;
	private readonly dim: (value: string) => string;

	constructor(
		tui: TUI,
		collapsedPrefix: string,
		expandedPrefix: string,
		onboarding: string,
		dim: (value: string) => string,
		expanded: boolean,
	) {
		super("", 1, 0);
		this.tui = tui;
		this.collapsedPrefix = collapsedPrefix;
		this.expandedPrefix = expandedPrefix;
		this.onboarding = onboarding;
		this.dim = dim;
		this.expanded = expanded;
		this.complete = new Promise<void>((resolve) => {
			this.resolveComplete = resolve;
		});
		this.updateText();
	}

	get isComplete(): boolean {
		return this.finished;
	}

	whenComplete(): Promise<void> {
		return this.complete;
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateText();
	}

	override render(width: number): string[] {
		if (!this.started && !this.finished) {
			this.started = true;
			this.timer = setInterval(() => {
				this.characters = Math.min(this.onboarding.length, this.characters + 1);
				this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_FRAMES.length;
				this.updateText();
				if (this.characters === this.onboarding.length) this.finish();
				this.tui.requestRender();
			}, 35);
			this.timer.unref();
		}
		return super.render(width);
	}

	dispose(): void {
		this.finish();
	}

	private finish(): void {
		if (this.finished) return;
		this.finished = true;
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		this.updateText();
		this.resolveComplete();
	}

	private updateText(): void {
		const prefix = this.expanded ? this.expandedPrefix : this.collapsedPrefix;
		const lines = this.onboarding.slice(0, this.characters).split("\n");
		const fixedLines = this.onboarding.split("\n").map((_, index) => lines[index] ?? "");
		const checking = this.finished ? "[ok] checking complete" : `[${SPINNER_FRAMES[this.spinnerFrame]}] checking`;
		this.setText(`${prefix}\n\n${this.dim(`${fixedLines.join("\n")}\n${checking}`)}`);
	}
}
