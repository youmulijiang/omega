import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBranding } from "./branding/index.ts";
import { registerCommands } from "./commands/index.ts";
import { registerPermissions } from "./permissions/index.ts";
import { registerPrompts } from "./prompts/index.ts";

export default function omegaExtension(pi: ExtensionAPI): void {
	registerBranding(pi);
	registerCommands(pi);
	registerPermissions(pi);
	registerPrompts(pi);
}
