import { copyToClipboard, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { OmegaAPI } from "../api.ts";
import { registerOmegaCommand } from "./register.ts";

export function getLastAssistantOutput(entries: readonly SessionEntry[]): string | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type !== "message" || entry.message.role !== "assistant") continue;

		const text = entry.message.content
			.filter((content) => content.type === "text")
			.map((content) => content.text)
			.join("")
			.trim();
		if (text) return text;
	}

	return undefined;
}

export function registerCopyCommand(omega: OmegaAPI, copy: (text: string) => Promise<void> = copyToClipboard): void {
	registerOmegaCommand(omega, "copy", {
		description: "Copy the last assistant output to the clipboard",
		overrideBuiltin: true,
		handler: async (_args, ctx) => {
			const text = getLastAssistantOutput(ctx.sessionManager.getBranch());
			if (!text) {
				ctx.ui.notify("No assistant output to copy", "warning");
				return;
			}

			try {
				await copy(text);
				ctx.ui.notify("Copied successfully", "info");
			} catch (error) {
				ctx.ui.notify(`Failed to copy: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}
