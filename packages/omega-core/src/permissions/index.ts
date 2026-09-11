import type { OmegaAPI } from "../api.ts";
import { registerOmegaCommand } from "../commands/register.ts";
import { appendPrompt } from "../prompts/index.ts";
import {
	evaluateRules,
	loadPermissionPolicy,
	type PermissionDecision,
	type PermissionLevel,
	type PermissionPolicy,
} from "./policy.ts";
import { evaluateBuiltInDeny, evaluateBulkDeletion } from "./rules/index.ts";
import { extractTargetsFromInput, loadScope, type ScopeDefinition, scopeContainsTarget } from "./scope.ts";

const PERMISSION_LEVELS = ["ask for approval", "approve for me", "full access"] as const;

export function registerPermissions(omega: OmegaAPI): void {
	let scope: ScopeDefinition | undefined;
	let permissionPolicy: PermissionPolicy | undefined;
	let permissionLevel: PermissionLevel = "full access";
	const approvedTargets = new Set<string>();
	const deniedTargets = new Set<string>();
	const approvedRequests = new Set<string>();

	omega.on("session_start", async (_event, ctx) => {
		approvedTargets.clear();
		deniedTargets.clear();
		approvedRequests.clear();
		try {
			scope = await loadScope(ctx.cwd);
			const loadedPolicy = await loadPermissionPolicy(ctx.cwd);
			permissionPolicy = loadedPolicy.policy;
			permissionLevel = loadedPolicy.policy.level;
			for (const warning of loadedPolicy.warnings) {
				if (ctx.hasUI) ctx.ui.notify(`权限配置无效，已忽略：${warning}`, "warning");
			}
			if (scope.exists && ctx.hasUI) {
				ctx.ui.setStatus(
					"omega-scope",
					`Scope ${scope.inclusions.length} inclusion / ${scope.exclusions.length} exclusions`,
				);
			}
			if (ctx.hasUI) ctx.ui.setStatus("omega-permissions", `Permissions: ${permissionLevel}`);
		} catch (error) {
			scope = undefined;
			if (ctx.hasUI)
				ctx.ui.notify(`读取 Scope 失败：${error instanceof Error ? error.message : String(error)}`, "error");
		}
	});

	registerOmegaCommand(omega, "permissions", {
		description: "查看或设置权限等级：ask for approval | approve for me | full access",
		getArgumentCompletions: (prefix) => {
			const normalizedPrefix = prefix.trimStart().toLowerCase();
			const matches = PERMISSION_LEVELS.filter((level) => level.startsWith(normalizedPrefix));
			return matches.length > 0 ? matches.map((level) => ({ value: level, label: level })) : null;
		},
		handler: async (args, ctx) => {
			let requested = args.trim().toLowerCase();
			if (!requested) {
				const selected = await ctx.ui.select(`选择权限等级（当前：${permissionLevel}）`, [...PERMISSION_LEVELS]);
				if (!selected) return;
				requested = selected;
			}
			if (requested !== "ask for approval" && requested !== "approve for me" && requested !== "full access") {
				ctx.ui.notify("无效权限等级。可用值：ask for approval、approve for me、full access", "error");
				return;
			}
			permissionLevel = requested;
			approvedRequests.clear();
			ctx.ui.setStatus("omega-permissions", `Permissions: ${permissionLevel}`);
			ctx.ui.notify(`权限等级已切换为：${permissionLevel}`, "info");
		},
	});

	omega.on("before_agent_start", (event) => {
		if (permissionLevel !== "approve for me") return undefined;
		return {
			systemPrompt: appendPrompt(event.systemPrompt, "approve-for-me"),
		};
	});

	omega.on("session_shutdown", () => {
		scope = undefined;
		permissionPolicy = undefined;
		permissionLevel = "full access";
		approvedTargets.clear();
		deniedTargets.clear();
		approvedRequests.clear();
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

		const policy = permissionPolicy ?? (await loadPermissionPolicy(ctx.cwd)).policy;
		const toolRule = evaluateRules(event.toolName, policy.tools, policy.defaultPolicy.tools);
		let subject = event.toolName;
		let category = "工具";
		let isBuiltInBulkRisk = false;
		let resolved: { decision: PermissionDecision; pattern?: string } = toolRule;
		if (event.toolName === "bash") {
			const command =
				typeof event.input === "object" && event.input !== null && "command" in event.input
					? (event.input as { command?: unknown }).command
					: undefined;
			if (typeof command !== "string") return { block: true, reason: "bash 工具缺少有效的 command 参数" };
			subject = command;
			category = "Bash 命令";
			const builtInDeny = evaluateBuiltInDeny(command);
			if (builtInDeny) return { block: true, reason: builtInDeny.reason };
			const bulkDeletion = await evaluateBulkDeletion(command, ctx.cwd);
			if (bulkDeletion) {
				isBuiltInBulkRisk = true;
				resolved = { decision: "ask", pattern: bulkDeletion.reason };
			} else {
				resolved = evaluateRules(command, policy.bash, toolRule.decision);
			}
		} else if (event.toolName === "mcp") {
			const input =
				typeof event.input === "object" && event.input !== null ? (event.input as Record<string, unknown>) : {};
			const server = typeof input.server === "string" ? input.server : undefined;
			const tool = typeof input.tool === "string" ? input.tool : undefined;
			const action = typeof input.action === "string" ? input.action : "call";
			subject = server ? `${server}${tool ? `:${tool}` : ""}` : `mcp_${action}`;
			category = "MCP 操作";
			resolved = evaluateRules(subject, policy.mcp, toolRule.decision);
		}

		if (!isBuiltInBulkRisk && permissionLevel === "full access") return undefined;
		if (!isBuiltInBulkRisk && permissionLevel === "approve for me" && resolved.decision !== "deny") return undefined;
		if (resolved.decision === "allow") return undefined;
		if (resolved.decision === "deny") {
			return { block: true, reason: `权限策略拒绝${category}：${subject}` };
		}
		const approvalKey = `${event.toolName}\0${subject}\0${resolved.pattern ?? "<default>"}`;
		if (approvedRequests.has(approvalKey)) return undefined;

		if (!ctx.hasUI) {
			return {
				block: true,
				reason: `${category}需要用户确认，非交互模式下已阻止`,
			};
		}

		const allowOnce = "仅允许本次执行";
		const allowSession = "允许本会话中的相同命令";
		const choice = await ctx.ui.select(
			`OMEGA 权限确认\n\n类型：${category}\n规则：${resolved.pattern ?? "默认策略"} → ask\n\n内容：\n${subject}\n\n是否继续执行？`,
			[allowOnce, allowSession, "拒绝执行"],
		);

		if (choice !== allowOnce && choice !== allowSession) {
			return { block: true, reason: "用户取消执行" };
		}
		if (choice === allowSession) approvedRequests.add(approvalKey);

		return undefined;
	});
}
