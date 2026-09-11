import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

export const PIXEL_SPINNER_FRAMES = ["▖", "▘", "▝", "▗"] as const;
const DEFAULT_PIXEL_SPINNER_INTERVAL_MS = 120;

export interface PixelSpinnerStatusOptions {
	key: string;
	label: string;
	frames?: readonly string[];
	intervalMs?: number;
}

/** Animated pixel spinner rendered in Pi's extension-status footer row. */
export class PixelSpinnerStatus {
	private frameIndex = 0;
	private timer: ReturnType<typeof setInterval> | undefined;
	private readonly ui: Pick<ExtensionUIContext, "setStatus" | "theme">;
	private readonly key: string;
	private readonly label: string;
	private readonly frames: readonly string[];
	private readonly intervalMs: number;

	constructor(ui: Pick<ExtensionUIContext, "setStatus" | "theme">, options: PixelSpinnerStatusOptions) {
		this.ui = ui;
		this.key = options.key;
		this.label = options.label;
		this.frames = options.frames?.length ? options.frames : PIXEL_SPINNER_FRAMES;
		this.intervalMs = options.intervalMs ?? DEFAULT_PIXEL_SPINNER_INTERVAL_MS;
	}

	start(): this {
		if (this.timer) return this;
		this.renderFrame();
		this.timer = setInterval(() => {
			this.frameIndex = (this.frameIndex + 1) % this.frames.length;
			this.renderFrame();
		}, this.intervalMs);
		this.timer.unref();
		return this;
	}

	dispose(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		this.ui.setStatus(this.key, undefined);
	}

	private renderFrame(): void {
		const frame = this.frames[this.frameIndex] ?? PIXEL_SPINNER_FRAMES[0];
		this.ui.setStatus(this.key, `${this.ui.theme.fg("accent", frame)} ${this.ui.theme.fg("dim", this.label)}`);
	}
}
