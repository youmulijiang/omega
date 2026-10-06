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
				if (ctx.hasUI) ctx.ui.notify(`Invalid permission config, ignored: ${warning}`, "warning");
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
				ctx.ui.notify(`Failed to read Scope: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	});

	registerOmegaCommand(omega, "permissions", {
		description: "View or set the permission level: ask for approval | approve for me | full access",
		getArgumentCompletions: (prefix) => {
			const normalizedPrefix = prefix.trimStart().toLowerCase();
			const matches = PERMISSION_LEVELS.filter((level) => level.startsWith(normalizedPrefix));
			return matches.length > 0 ? matches.map((level) => ({ value: level, label: level })) : null;
		},
		handler: async (args, ctx) => {
			let requested = args.trim().toLowerCase();
			if (!requested) {
				const selected = await ctx.ui.select(`Select permission level (current: ${permissionLevel})`, [
					...PERMISSION_LEVELS,
				]);
				if (!selected) return;
				requested = selected;
			}
			if (requested !== "ask for approval" && requested !== "approve for me" && requested !== "full access") {
				ctx.ui.notify(
					"Invalid permission level. Available values: ask for approval, approve for me, full access",
					"error",
				);
				return;
			}
			permissionLevel = requested;
			approvedRequests.clear();
			ctx.ui.setStatus("omega-permissions", `Permissions: ${permissionLevel}`);
			ctx.ui.notify(`Permission level changed to: ${permissionLevel}`, "info");
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
					return { block: true, reason: `Target ${target} is in Scope Exclusions` };
				}
				if (scopeContainsTarget(scope.inclusions, target) || approvedTargets.has(target)) continue;
				if (deniedTargets.has(target)) {
					return { block: true, reason: `Target ${target} is not authorized for this session` };
				}
				if (!ctx.hasUI) {
					deniedTargets.add(target);
					return {
						block: true,
						reason: `Target ${target} is not in Scope Inclusion and cannot be confirmed in non-interactive mode`,
					};
				}
				const approved = await ctx.ui.confirm(
					"OMEGA out-of-scope target confirmation",
					`Target is not in Scope Inclusion:\n\n${target}\n\nConfirm it is authorized and continue testing?`,
				);
				if (!approved) {
					deniedTargets.add(target);
					return { block: true, reason: `User declined testing out-of-scope target ${target}` };
				}
				approvedTargets.add(target);
			}
		}

		const policy = permissionPolicy ?? (await loadPermissionPolicy(ctx.cwd)).policy;
		const toolRule = evaluateRules(event.toolName, policy.tools, policy.defaultPolicy.tools);
		let subject = event.toolName;
		let category = "Tool";
		let isBuiltInBulkRisk = false;
		let resolved: { decision: PermissionDecision; pattern?: string } = toolRule;
		if (event.toolName === "bash") {
			const command =
				typeof event.input === "object" && event.input !== null && "command" in event.input
					? (event.input as { command?: unknown }).command
					: undefined;
			if (typeof command !== "string")
				return { block: true, reason: "bash tool is missing a valid command argument" };
			subject = command;
			category = "Bash command";
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
			category = "MCP operation";
			resolved = evaluateRules(subject, policy.mcp, toolRule.decision);
		}

		// An explicit `deny` rule outranks the permission level: "full access" only
		// suppresses approval prompts, it must not turn a denied operation into an
		// allowed one (that is what the level-independent built-in rules are for).
		if (resolved.decision === "deny") {
			return { block: true, reason: `Permission policy denied ${category}: ${subject}` };
		}
		if (!isBuiltInBulkRisk && permissionLevel === "full access") return undefined;
		if (!isBuiltInBulkRisk && permissionLevel === "approve for me") return undefined;
		if (resolved.decision === "allow") return undefined;
		const approvalKey = `${event.toolName}\0${subject}\0${resolved.pattern ?? "<default>"}`;
		if (approvedRequests.has(approvalKey)) return undefined;

		if (!ctx.hasUI) {
			return {
				block: true,
				reason: `${category} requires user confirmation and was blocked in non-interactive mode`,
			};
		}

		const allowOnce = "Allow this execution only";
		const allowSession = "Allow the same command for this session";
		const choice = await ctx.ui.select(
			`OMEGA permission confirmation\n\nType: ${category}\nRule: ${resolved.pattern ?? "default policy"} → ask\n\nContent:\n${subject}\n\nProceed?`,
			[allowOnce, allowSession, "Deny execution"],
		);

		if (choice !== allowOnce && choice !== allowSession) {
			return { block: true, reason: "User cancelled execution" };
		}
		if (choice === allowSession) approvedRequests.add(approvalKey);

		return undefined;
	});
}
