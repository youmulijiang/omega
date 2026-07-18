import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type OmegaMode = "recon" | "exploit" | "report" | "idle";

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

export function setupStatus(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, modeLabel("idle"));
	});

	pi.on("turn_start", async (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, modeLabel("recon"));
	});

	pi.on("turn_end", async (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, modeLabel("idle"));
	});
}

export function setMode(pi: ExtensionAPI, mode: OmegaMode): void {
	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, modeLabel(mode));
	});
}
