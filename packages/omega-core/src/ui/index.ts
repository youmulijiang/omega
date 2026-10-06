import type { OmegaAPI } from "../api.ts";
import { setupHeader } from "./header.ts";
import { PhaseIndicator } from "./phase-indicator.ts";
import { setupSidebar } from "./sidebar.ts";
import { setupStatus } from "./status.ts";
import { setupToolbox } from "./toolbox.ts";

export function registerUi(omega: OmegaAPI): void {
	setupToolbox(omega);
	setupHeader(omega);
	setupStatus(omega);
	setupSidebar(omega);

	omega.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		ctx.ui.setWidget("omega.phase", (_tui, theme) => new PhaseIndicator(theme), { placement: "aboveEditor" });
	});
}

export { formatBashCallHighlighted, highlightBashCommand } from "./bash-highlight.ts";
export { setupHeader } from "./header.ts";
export type { OmegaPhase } from "./phase-indicator.ts";
export { PhaseIndicator } from "./phase-indicator.ts";
export { PixelSpinnerStatus, type PixelSpinnerStatusOptions } from "./pixel-spinner.ts";
export { OmegaSidebar, type SidebarArtMode, type SidebarTab, setupSidebar } from "./sidebar.ts";
export {
	renderAsciiGlobe,
	renderAttackMap,
	renderGlobe,
	resolveGlobeRenderer,
	SIDEBAR_CONTINENTS,
} from "./sidebar-art.ts";
export { setupStatus } from "./status.ts";
export { setupToolbox } from "./toolbox.ts";
export { loadToolboxConfig, type ToolboxConfig } from "./toolbox-config.ts";
export { patchToolBoxFrames, stripBackgroundFills } from "./toolbox-frame.ts";
