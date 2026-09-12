import { writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { OmegaAPI } from "../api.ts";
import { registerOmegaCommand } from "../commands/register.ts";
import { renderCostHtml } from "./html.ts";
import { collectCostReport } from "./report.ts";
import { CostDashboard } from "./view.ts";

export function registerCosts(omega: OmegaAPI): void {
	registerOmegaCommand(omega, "cost", {
		description: "查看当前会话 Token/费用图表，/cost models 查看模型明细，/cost export [文件.html] 导出报表",
		handler: async (args, ctx) => {
			const [action, ...rest] = args.trim().split(/\s+/u).filter(Boolean);
			if (action && action !== "models" && action !== "export") {
				ctx.ui.notify("用法：/cost [models | export [文件.html]]", "warning");
				return;
			}
			try {
				const report = collectCostReport(
					ctx.sessionManager.getEntries(),
					ctx.sessionManager.getBranch(),
					ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
					ctx.getSystemPrompt(),
					ctx.getSystemPromptOptions(),
				);
				if (action === "export") {
					const requested = rest.join(" ").trim();
					if (requested && !requested.toLowerCase().endsWith(".html")) {
						ctx.ui.notify("导出文件必须以 .html 结尾。", "warning");
						return;
					}
					const filename = requested || `omega-cost-${Date.now()}.html`;
					const output = isAbsolute(filename) ? filename : resolve(ctx.cwd, filename);
					await writeFile(output, renderCostHtml(report), { encoding: "utf8", flag: "wx" });
					ctx.ui.notify(`消费报表已导出：${output}`, "info");
					return;
				}
				if (action === "models" || ctx.mode !== "tui" || !ctx.hasUI) {
					const current = report.models.find((model) => model.model === report.currentModel);
					const header = `当前会话 $${report.total.cost.toFixed(4)} · ${report.total.totalTokens.toLocaleString()} tokens`;
					const rows = report.models.map(
						(model) =>
							`${model.model}: ${model.totalTokens.toLocaleString()} tokens · $${model.cost.toFixed(4)} (${model.calls} 次)`,
					);
					const breakdown = current
						? `当前模型：输入 ${current.input} / 输出 ${current.output} / 缓存读 ${current.cacheRead} / 缓存写 ${current.cacheWrite}`
						: "当前模型尚无消费";
					const unknown = report.unattributed.calls
						? `未归因：${report.unattributed.totalTokens} tokens · $${report.unattributed.cost.toFixed(4)}`
						: "";
					ctx.ui.notify(
						[header, breakdown, ...rows, unknown, "来源估算请使用 /cost 图表或 /cost export 查看（非计费归因）"]
							.filter(Boolean)
							.join("\n"),
						"info",
					);
					return;
				}
				await ctx.ui.custom<void>(
					(_tui, theme, keybindings, done) => new CostDashboard(report, theme, keybindings, done),
					{
						overlay: true,
						overlayOptions: { anchor: "center", width: "90%", minWidth: 42, maxHeight: "85%", margin: 1 },
					},
				);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
