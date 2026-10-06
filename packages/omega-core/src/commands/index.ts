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
		description: "Compile the current session into a Markdown penetration test report",
		handler: async (args, ctx) => {
			try {
				const target = args.trim() || "unspecified target";
				const entries = ctx.sessionManager.getBranch();
				const report = generateReport(entries, target);

				const filename = `omega-report-${Date.now()}.md`;
				const outputPath = join(process.cwd(), filename);

				await writeFile(outputPath, report, "utf-8");

				ctx.ui.notify(`Report generated: ${filename}`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
