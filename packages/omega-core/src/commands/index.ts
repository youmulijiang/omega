import { writeFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "path";
import { generateReport } from "./report.ts";

export function registerCommands(pi: ExtensionAPI): void {
	pi.registerCommand("report", {
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
