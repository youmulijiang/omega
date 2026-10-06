import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";

/**
 * OMEGA 渗透测试阶段。用于在编辑器上方的 widget 中提示当前工作阶段。
 */
export type OmegaPhase = "recon" | "exploit" | "report";

const PHASE_LABELS: Record<OmegaPhase, string> = {
	recon: "Recon",
	exploit: "Exploit",
	report: "Report",
};

/**
 * 单行的阶段指示器组件。
 *
 * 这是一个标准的 pi-tui `Component`：`render(width)` 返回不超过 `width` 的行数组，
 * `invalidate()` 清空缓存以便下次强制重绘。OMEGA 的自定义 UI 组件都应遵循该接口。
 */
export class PhaseIndicator implements Component {
	private phase: OmegaPhase;
	private readonly theme: Theme;
	private readonly showPhase: boolean;

	constructor(theme: Theme, phase: OmegaPhase = "recon", showPhase = false) {
		this.theme = theme;
		this.phase = phase;
		this.showPhase = showPhase;
	}

	/**
	 * 更新当前阶段。
	 *
	 * @param phase - 新的工作阶段。
	 */
	setPhase(phase: OmegaPhase): void {
		this.phase = phase;
	}

	/**
	 * 返回当前阶段。
	 */
	getPhase(): OmegaPhase {
		return this.phase;
	}

	render(width: number): string[] {
		const accent = (t: string) => this.theme.fg("accent", t);
		const dim = (t: string) => this.theme.fg("dim", t);
		const line = this.showPhase ? `${dim("OMEGA")} ${accent("▸")} ${accent(PHASE_LABELS[this.phase])}` : dim("OMEGA");
		return [truncateToWidth(line, width)];
	}

	invalidate(): void {}
}
