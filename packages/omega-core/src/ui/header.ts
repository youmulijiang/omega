import type { Theme } from "@earendil-works/pi-coding-agent";
import { type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import type { OmegaAPI } from "../api.ts";
import { OMEGA_VERSION } from "../version.ts";

const LOGO = [
	" ██████╗ ███╗   ███╗███████╗ ██████╗  █████╗ ",
	"██╔═══██╗████╗ ████║██╔════╝██╔════╝ ██╔══██╗",
	"██║   ██║██╔████╔██║█████╗  ██║  ███╗███████║",
	"██║   ██║██║╚██╔╝██║██╔══╝  ██║   ██║██╔══██║",
	" ██████╔╝██║ ╚═╝ ██║███████╗╚██████╔╝██║  ██║",
	" ╚═════╝ ╚═╝     ╚═╝╚══════╝ ╚═════╝ ╚═╝  ╚═╝",
];
/** Static Omega branding shown after the built-in startup sequence finishes. */
export class OmegaHeader {
	private readonly theme: Theme;

	constructor(_tui: TUI, theme: Theme) {
		this.theme = theme;
	}

	render(width: number): string[] {
		const clip = (value: string) => truncateToWidth(value, Math.max(0, width));
		return [
			"",
			...LOGO.map((line) => clip(this.theme.fg("accent", line))),
			clip(this.theme.fg("dim", `omega v${OMEGA_VERSION}`)),
			"",
		];
	}

	invalidate(): void {}
}

/** Install the OMEGA header when an interactive TUI session starts. */
export function setupHeader(omega: OmegaAPI): void {
	omega.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setHeader((tui, theme) => new OmegaHeader(tui, theme));
	});
}
