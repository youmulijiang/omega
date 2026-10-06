import { writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { OmegaAPI } from "../api.ts";
import { registerOmegaCommand } from "../commands/register.ts";
import { renderCostHtml } from "./html.ts";
import { collectCostReport } from "./report.ts";
import { CostDashboard } from "./view.ts";

export function registerCosts(omega: OmegaAPI): void {
	registerOmegaCommand(omega, "cost", {
		description: "View token/cost charts for the current session; /cost models for per-model details; /cost export [file.html] to export a report",
		handler: async (args, ctx) => {
			const [action, ...rest] = args.trim().split(/\s+/u).filter(Boolean);
			if (action && action !== "models" && action !== "export") {
				ctx.ui.notify("Usage: /cost [models | export [file.html]]", "warning");
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
						ctx.ui.notify("The export file must end with .html.", "warning");
						return;
					}
					const filename = requested || `omega-cost-${Date.now()}.html`;
					const output = isAbsolute(filename) ? filename : resolve(ctx.cwd, filename);
					await writeFile(output, renderCostHtml(report), { encoding: "utf8", flag: "wx" });
					ctx.ui.notify(`Cost report exported: ${output}`, "info");
					return;
				}
				if (action === "models" || ctx.mode !== "tui" || !ctx.hasUI) {
					const current = report.models.find((model) => model.model === report.currentModel);
					const header = `Current session $${report.total.cost.toFixed(4)} · ${report.total.totalTokens.toLocaleString()} tokens`;
					const rows = report.models.map(
						(model) =>
							`${model.model}: ${model.totalTokens.toLocaleString()} tokens · $${model.cost.toFixed(4)} (${model.calls} calls)`,
					);
					const breakdown = current
						? `Current model - input ${current.input} / output ${current.output} / cache read ${current.cacheRead} / cache write ${current.cacheWrite}`
						: "No usage recorded for the current model yet";
					const unknown = report.unattributed.calls
						? `Unattributed: ${report.unattributed.totalTokens} tokens · $${report.unattributed.cost.toFixed(4)}`
						: "";
					ctx.ui.notify(
						[header, breakdown, ...rows, unknown, "For source estimates use the /cost chart or /cost export (non-billed attribution)"]
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
