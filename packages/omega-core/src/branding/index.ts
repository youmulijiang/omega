import type { OmegaAPI } from "../api.ts";
import { setupHeader } from "./header.ts";
import { setupStatus } from "./status.ts";

export function registerBranding(omega: OmegaAPI): void {
	setupHeader(omega);
	setupStatus(omega);
}
