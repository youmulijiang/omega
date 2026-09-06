import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface SubagentSettings {
	enabled: boolean;
}

export const DEFAULT_SUBAGENT_SETTINGS: SubagentSettings = { enabled: true };

export function getSubagentSettingsPath(): string {
	return path.join(getAgentDir(), "subagents.json");
}

export function readSubagentSettings(settingsPath = getSubagentSettingsPath()): SubagentSettings {
	try {
		const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as unknown;
		if (!parsed || typeof parsed !== "object") return DEFAULT_SUBAGENT_SETTINGS;
		const enabled = (parsed as Record<string, unknown>).enabled;
		return { enabled: typeof enabled === "boolean" ? enabled : DEFAULT_SUBAGENT_SETTINGS.enabled };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			console.warn(`[omega-subagent] Could not read settings from "${settingsPath}": ${String(error)}`);
		}
		return DEFAULT_SUBAGENT_SETTINGS;
	}
}

export function writeSubagentSettings(settings: SubagentSettings, settingsPath = getSubagentSettingsPath()): void {
	fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
	fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
}
