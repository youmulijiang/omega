import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setupHeader } from "./header.ts";
import { setupStatus } from "./status.ts";

export function registerBranding(pi: ExtensionAPI): void {
	setupHeader(pi);
	setupStatus(pi);
}
