import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * OMEGA 在 TUI 状态栏中展示的阶段。
 */
type OmegaMode = "recon" | "exploit" | "report" | "idle";

/**
 * TUI 状态栏条目的 key。
 */
const STATUS_KEY = "omega-mode";

/**
 * 将内部阶段转换为状态栏展示文案。
 *
 * @param mode - OMEGA 阶段。
 * @returns 状态栏展示用的短标签。
 */
function modeLabel(mode: OmegaMode): string {
	const icons: Record<OmegaMode, string> = {
		recon: "◉ recon",
		exploit: "⚡ exploit",
		report: "📋 report",
		idle: "◎ ready",
	};
	return icons[mode];
}

/**
 * 在会话生命周期内维护 OMEGA 的状态栏显示。
 *
 * - `session_start`：初始化为 idle
 * - `turn_start`：进入 recon
 * - `turn_end`：回到 idle
 *
 * @param pi - Pi 扩展 API。
 */
export function setupStatus(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, modeLabel("idle"));
	});

	pi.on("turn_start", async (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, modeLabel("recon"));
	});

	pi.on("turn_end", async (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, modeLabel("idle"));
	});
}
