import type { OmegaAPI } from "../api.ts";
import { PhaseIndicator } from "./phase-indicator.ts";

export function registerUi(omega: OmegaAPI): void {
	omega.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		ctx.ui.setWidget("omega.phase", (_tui, theme) => new PhaseIndicator(theme), { placement: "aboveEditor" });
	});
}

export type { OmegaPhase } from "./phase-indicator.ts";
export { PhaseIndicator } from "./phase-indicator.ts";
