import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isDangerousCommand } from "./gate.ts";

export function registerPermissions(pi: ExtensionAPI): void {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;

		const command = event.input.command as string;

		if (!isDangerousCommand(command)) return undefined;

		if (!ctx.hasUI) {
			return {
				block: true,
				reason: "高危安全操作在非交互模式下被阻止（需要用户确认）",
			};
		}

		const choice = await ctx.ui.select(
			`⚠️  OMEGA 安全门控\n\n检测到高危操作：\n\n  ${command}\n\n请确认已获得目标授权，是否继续？`,
			["✅ 已授权，继续执行", "❌ 取消"],
		);

		if (choice !== "✅ 已授权，继续执行") {
			return { block: true, reason: "用户取消执行" };
		}

		return undefined;
	});
}
