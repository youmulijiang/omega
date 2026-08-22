import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";

/**
 * 渲染 OMEGA 的 TUI Header（ASCII art + tagline）。
 *
 * @param theme - Pi TUI 主题对象，用于着色。
 * @param _width - Header 可用宽度（当前实现不依赖该参数，预留给未来自适应布局）。
 * @returns Header 的多行字符串数组。
 */
function renderOmegaHeader(theme: Theme, _width: number): string[] {
	const accent = (t: string) => theme.fg("accent", t);
	const dim = (t: string) => theme.fg("dim", t);
	const muted = (t: string) => theme.fg("muted", t);

	// OMEGA ASCII art (7 lines)
	const lines = [
		"",
		accent(" ██████╗ ███╗   ███╗███████╗ ██████╗  █████╗ "),
		accent("██╔═══██╗████╗ ████║██╔════╝██╔════╝ ██╔══██╗"),
		accent("██║   ██║██╔████╔██║█████╗  ██║  ███╗███████║"),
		accent("██║   ██║██║╚██╔╝██║██╔══╝  ██║   ██║██╔══██║"),
		accent(" ██████╔╝██║ ╚═╝ ██║███████╗╚██████╔╝██║  ██║"),
		accent(" ╚═════╝ ╚═╝     ╚═╝╚══════╝ ╚═════╝ ╚═╝  ╚═╝"),
		muted("  network security agent") + dim("  [ recon · exploit · report ]"),
		"",
	];

	return lines;
}

/**
 * 在会话开始时为 TUI 模式设置 OMEGA Header。
 *
 * 仅当运行于 `tui` 模式时生效；否则不做任何操作。
 *
 * @param pi - Pi 扩展 API。
 */
export function setupHeader(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		ctx.ui.setHeader((_tui, theme) => ({
			render(width: number): string[] {
				return renderOmegaHeader(theme, width);
			},
			invalidate() {},
		}));
	});
}
