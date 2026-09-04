import type { OmegaAPI } from "../api.ts";
import { isDangerousCommand } from "./gate.ts";
import { extractTargetsFromInput, loadScope, type ScopeDefinition, scopeContainsTarget } from "./scope.ts";

export function registerPermissions(omega: OmegaAPI): void {
	let scope: ScopeDefinition | undefined;
	const approvedTargets = new Set<string>();
	const deniedTargets = new Set<string>();

	omega.on("session_start", async (_event, ctx) => {
		approvedTargets.clear();
		deniedTargets.clear();
		try {
			scope = await loadScope(ctx.cwd);
			if (scope.exists && ctx.hasUI) {
				ctx.ui.setStatus(
					"omega-scope",
					`Scope ${scope.inclusions.length} inclusion / ${scope.exclusions.length} exclusions`,
				);
			}
		} catch (error) {
			scope = undefined;
			if (ctx.hasUI)
				ctx.ui.notify(`读取 Scope 失败：${error instanceof Error ? error.message : String(error)}`, "error");
		}
	});

	omega.on("session_shutdown", () => {
		scope = undefined;
		approvedTargets.clear();
		deniedTargets.clear();
	});

	omega.on("tool_call", async (event, ctx) => {
		if (scope?.exists) {
			for (const target of extractTargetsFromInput(event.input)) {
				if (scopeContainsTarget(scope.exclusions, target)) {
					return { block: true, reason: `目标 ${target} 位于 Scope Exclusions 中` };
				}
				if (scopeContainsTarget(scope.inclusions, target) || approvedTargets.has(target)) continue;
				if (deniedTargets.has(target)) {
					return { block: true, reason: `目标 ${target} 未获得本次会话授权` };
				}
				if (!ctx.hasUI) {
					deniedTargets.add(target);
					return { block: true, reason: `目标 ${target} 不在 Scope Inclusion 中，非交互模式无法确认授权` };
				}
				const approved = await ctx.ui.confirm(
					"OMEGA Scope 范围外目标确认",
					`目标不在 Scope Inclusion 中：\n\n${target}\n\n是否确认已获得授权并继续测试？`,
				);
				if (!approved) {
					deniedTargets.add(target);
					return { block: true, reason: `用户拒绝测试 Scope 范围外目标 ${target}` };
				}
				approvedTargets.add(target);
			}
		}

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
