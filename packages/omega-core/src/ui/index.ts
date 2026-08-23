import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PhaseIndicator } from "./phase-indicator.ts";

/**
 * 注册 OMEGA 的自定义 UI 组件。
 *
 * 目前挂载一个编辑器上方的阶段指示器 widget。所有 OMEGA 自定义组件都放在
 * `packages/omega-core/src/ui/` 下，通过消费 `@earendil-works/pi-tui` 的
 * `Component` 原语实现，再经由扩展 `ctx.ui` API 挂到界面上。
 *
 * @param pi - Pi 扩展 API。
 */
export function registerUi(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		ctx.ui.setWidget("omega.phase", (_tui, theme) => new PhaseIndicator(theme), { placement: "aboveEditor" });
	});
}

export type { OmegaPhase } from "./phase-indicator.ts";
export { PhaseIndicator } from "./phase-indicator.ts";
