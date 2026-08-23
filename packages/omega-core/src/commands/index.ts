import { writeFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "path";
import { registerPlanMode } from "../plan-mode/index.ts";
import { initializeOmegaWorkspace } from "./init.ts";
import { generateReport } from "./report.ts";

/**
 * 注册 OMEGA 提供的命令，包括 `/init`、`/plan`、`/plan:status` 和 `/report`。
 *
 * `/report` 会将当前会话分支整理为 Markdown 渗透测试报告并写入当前工作目录。
 *
 * @param pi - Pi 扩展 API。
 */
export function registerCommands(pi: ExtensionAPI): void {
	registerPlanMode(pi);

	pi.registerCommand("init", {
		description: "初始化当前工作目录的 .omega/agent 配置",
		handler: async (_args, ctx) => {
			try {
				const result = await initializeOmegaWorkspace(ctx.cwd);
				const lines = [`Omega 工作目录已初始化：${result.root}`];
				if (result.created.length > 0)
					lines.push(`已创建：\n${result.created.map((path) => `- ${path}`).join("\n")}`);
				if (result.existing.length > 0) {
					lines.push(`已存在，未覆盖：\n${result.existing.map((path) => `- ${path}`).join("\n")}`);
				}
				ctx.ui.notify(lines.join("\n\n"), "info");
			} catch (error) {
				ctx.ui.notify(`初始化失败：${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

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
