import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";

function renderOmegaHeader(theme: Theme, _width: number): string[] {
	const accent = (t: string) => theme.fg("accent", t);
	const dim = (t: string) => theme.fg("dim", t);
	const muted = (t: string) => theme.fg("muted", t);

	// OMEGA ASCII art (7 lines)
	const lines = [
		"",
		accent(" ██████╗ ███╗   ███╗███████╗ ██████╗  █████╗ "),
		accent("██╔═══██╗████╗ ████║██╔════╝██╔════╝ ██╔══██╗"),
		accent("██║   ██║██╔████╔██║█████╗  ██║  ███╗███████║"),
		accent("██║   ██║██║╚██╔╝██║██╔══╝  ██║   ██║██╔══██║"),
		accent(" ██████╔╝██║ ╚═╝ ██║███████╗╚██████╔╝██║  ██║"),
		accent(" ╚═════╝ ╚═╝     ╚═╝╚══════╝ ╚═════╝ ╚═╝  ╚═╝"),
		muted("  network security agent") + dim("  [ recon · exploit · report ]"),
		"",
	];

	return lines;
}

export function setupHeader(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		ctx.ui.setHeader((_tui, theme) => ({
			render(width: number): string[] {
				return renderOmegaHeader(theme, width);
			},
			invalidate() {},
		}));
	});
}
