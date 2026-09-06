import type { OmegaAPI } from "../api.ts";
import { setupHeader } from "./header.ts";
import { PhaseIndicator } from "./phase-indicator.ts";
import { setupStatus } from "./status.ts";

export function registerUi(omega: OmegaAPI): void {
	setupHeader(omega);
	setupStatus(omega);

	omega.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		ctx.ui.setWidget("omega.phase", (_tui, theme) => new PhaseIndicator(theme), { placement: "aboveEditor" });
	});
}

export { setupHeader } from "./header.ts";
export type { OmegaPhase } from "./phase-indicator.ts";
export { PhaseIndicator } from "./phase-indicator.ts";
export { setupStatus } from "./status.ts";
