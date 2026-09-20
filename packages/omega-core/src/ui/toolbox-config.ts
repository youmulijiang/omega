import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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

/** Persist one `toolbox` field into the agent settings file, preserving other settings. */
export function saveToolboxConfigField(
	field: keyof ToolboxConfig,
	value: boolean,
	settingsPath = join(getAgentDir(), "settings.json"),
): void {
	let settings: Record<string, unknown> = {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
		if (typeof parsed === "object" && parsed !== null) {
			settings = parsed as Record<string, unknown>;
		}
	} catch {
		// Missing or invalid file: start a fresh settings object.
	}
	const toolbox =
		typeof settings.toolbox === "object" && settings.toolbox !== null
			? { ...(settings.toolbox as Record<string, unknown>) }
			: {};
	toolbox[field] = value;
	settings.toolbox = toolbox;
	mkdirSync(dirname(settingsPath), { recursive: true });
	writeFileSync(settingsPath, `${JSON.stringify(settings, null, "\t")}\n`, "utf8");
}
