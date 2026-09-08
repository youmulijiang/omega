import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface ToolboxConfig {
	enabled: boolean;
	highlightBash: boolean;
	collapseAnchor: boolean;
}

const DEFAULT_TOOLBOX_CONFIG: ToolboxConfig = {
	enabled: true,
	highlightBash: true,
	collapseAnchor: true,
};

function configuredBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

/** Load the optional `toolbox` section from the active agent settings. */
export function loadToolboxConfig(settingsPath = join(getAgentDir(), "settings.json")): ToolboxConfig {
	try {
		const settings: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
		const toolbox =
			typeof settings === "object" && settings !== null && "toolbox" in settings
				? (settings as { toolbox?: unknown }).toolbox
				: undefined;
		const values = typeof toolbox === "object" && toolbox !== null ? (toolbox as Record<string, unknown>) : {};
		return {
			enabled: configuredBoolean(values.enabled, DEFAULT_TOOLBOX_CONFIG.enabled),
			highlightBash: configuredBoolean(values.highlightBash, DEFAULT_TOOLBOX_CONFIG.highlightBash),
			collapseAnchor: configuredBoolean(values.collapseAnchor, DEFAULT_TOOLBOX_CONFIG.collapseAnchor),
		};
	} catch {
		return { ...DEFAULT_TOOLBOX_CONFIG };
	}
}
