import type { OmegaAPI } from "../api.ts";

type OmegaMode = "recon" | "exploit" | "report" | "idle";

const STATUS_KEY = "omega-mode";

function modeLabel(mode: OmegaMode): string {
	const icons: Record<OmegaMode, string> = {
		recon: "◉ recon",
		exploit: "⚡ exploit",
		report: "📋 report",
		idle: "◎ ready",
	};
	return icons[mode];
}

/** Keep the OMEGA footer status synchronized with the session lifecycle. */
export function setupStatus(omega: OmegaAPI): void {
	omega.on("session_start", async (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, modeLabel("idle"));
	});

	omega.on("turn_start", async (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, modeLabel("recon"));
	});

	omega.on("turn_end", async (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, modeLabel("idle"));
	});
}
