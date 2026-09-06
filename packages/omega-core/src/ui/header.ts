import type { Theme } from "@earendil-works/pi-coding-agent";
import type { OmegaAPI } from "../api.ts";

/** Render the OMEGA ASCII-art header using the active TUI theme. */
function renderOmegaHeader(theme: Theme, _width: number): string[] {
	const accent = (text: string) => theme.fg("accent", text);

	return [
		"",
		accent(" ██████╗ ███╗   ███╗███████╗ ██████╗  █████╗ "),
		accent("██╔═══██╗████╗ ████║██╔════╝██╔════╝ ██╔══██╗"),
		accent("██║   ██║██╔████╔██║█████╗  ██║  ███╗███████║"),
		accent("██║   ██║██║╚██╔╝██║██╔══╝  ██║   ██║██╔══██║"),
		accent(" ██████╔╝██║ ╚═╝ ██║███████╗╚██████╔╝██║  ██║"),
		accent(" ╚═════╝ ╚═╝     ╚═╝╚══════╝ ╚═════╝ ╚═╝  ╚═╝"),
		"",
	];
}

/** Install the OMEGA header when an interactive TUI session starts. */
export function setupHeader(omega: OmegaAPI): void {
	omega.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		ctx.ui.setHeader((_tui, theme) => ({
			render: (width) => renderOmegaHeader(theme, width),
			invalidate() {},
		}));
	});
}
