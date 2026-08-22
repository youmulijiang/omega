import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setupHeader } from "./header.ts";
import { setupStatus } from "./status.ts";

/**
 * 注册 OMEGA 的 UI 品牌化能力（Header / Status 等）。
 *
 * @param pi - Pi 扩展 API。
 */
export function registerBranding(pi: ExtensionAPI): void {
	setupHeader(pi);
	setupStatus(pi);
}
