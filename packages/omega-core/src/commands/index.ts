import { writeFile } from "node:fs/promises";
import { join } from "path";
import type { OmegaAPI } from "../api.ts";
import { registerPlanMode } from "../plan-mode/index.ts";
import { registerCopyCommand } from "./copy.ts";
import { registerOmegaCommand } from "./register.ts";
import { generateReport } from "./report.ts";

export function registerCommands(omega: OmegaAPI): void {
	registerPlanMode(omega);
	registerCopyCommand(omega);

	registerOmegaCommand(omega, "report", {
		description: "将当前会话整理为 Markdown 渗透测试报告",
		handler: async (args, ctx) => {
			try {
				const target = args.trim() || "未指定目标";
				const entries = ctx.sessionManager.getBranch();
				const report = generateReport(entries, target);

				const filename = `omega-report-${Date.now()}.md`;
				const outputPath = join(process.cwd(), filename);

				await writeFile(outputPath, report, "utf-8");

				ctx.ui.notify(`报告已生成：${filename}`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
