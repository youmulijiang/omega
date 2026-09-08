import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { OmegaAPI } from "../api.ts";
import { formatBashCallHighlighted } from "./bash-highlight.ts";
import { loadToolboxConfig } from "./toolbox-config.ts";
import { patchToolBoxFrames } from "./toolbox-frame.ts";

interface BashRenderState {
	startedAt?: number;
	endedAt?: number;
	callText?: Text;
}

function registerHighlightedBash(omega: OmegaAPI, cwd: string): void {
	const definition = createBashToolDefinition(cwd);
	omega.registerTool({
		...definition,
		renderCall(args, theme, context) {
			const state = context.state as BashRenderState;
			if (context.executionStarted && state.startedAt === undefined) {
				state.startedAt = Date.now();
				state.endedAt = undefined;
			}
			const text = state.callText ?? new Text("", 0, 0);
			state.callText = text;
			text.setText(formatBashCallHighlighted(args, theme));
			return text;
		},
	});
}

/** Register the UI behavior ported from @andy8647/pi-toolbox. */
export function setupToolbox(omega: OmegaAPI): void {
	const config = loadToolboxConfig();
	if (!config.enabled) return;
	patchToolBoxFrames(config.collapseAnchor);
	if (config.highlightBash) registerHighlightedBash(omega, process.cwd());
}
