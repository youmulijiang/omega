import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type PermissionDecision = "allow" | "ask" | "deny";
export type PermissionCategory = "tools" | "bash" | "mcp";
export type PermissionLevel = "ask for approval" | "approve for me" | "full access";

export interface PermissionPolicy {
	level: PermissionLevel;
	defaultPolicy: Record<PermissionCategory, PermissionDecision>;
	tools: Record<string, PermissionDecision>;
	bash: Record<string, PermissionDecision>;
	mcp: Record<string, PermissionDecision>;
}

export const DEFAULT_PERMISSION_POLICY: PermissionPolicy = {
	level: "full access",
	defaultPolicy: { tools: "allow", bash: "allow", mcp: "allow" },
	tools: {},
	bash: {
		"rm *": "ask",
		"sudo rm *": "ask",
		"Remove-Item *": "ask",
		"rmdir *": "ask",
		"rd /s *": "ask",
		"del *": "ask",
		"git clean *": "ask",
		"git reset --hard*": "ask",
		"mkfs*": "deny",
		"format *": "deny",
		"dd * of=/dev/*": "deny",
		"shutdown*": "ask",
		"reboot*": "ask",
		"poweroff*": "ask",
		"chmod * 777 *": "ask",
		"nmap *": "ask",
		"sqlmap *": "ask",
		"msfconsole*": "ask",
		"msfvenom*": "ask",
		"hydra *": "ask",
		"aircrack*": "ask",
		"nikto *": "ask",
		"rm --help": "allow",
		"rm --version": "allow",
		"nmap --help": "allow",
		"nmap --version": "allow",
	},
	mcp: {},
};

export interface LoadedPermissionPolicy {
	policy: PermissionPolicy;
	paths: string[];
	warnings: string[];
}

function isDecision(value: unknown): value is PermissionDecision {
	return value === "allow" || value === "ask" || value === "deny";
}

function parseRuleMap(value: unknown, field: string): Record<string, PermissionDecision> {
	if (value === undefined) return {};
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${field} must be an object`);
	}
	const rules: Record<string, PermissionDecision> = {};
	for (const [pattern, decision] of Object.entries(value)) {
		if (!pattern || !isDecision(decision))
			throw new Error(`${field}.${pattern || "<empty>"} must be allow, ask, or deny`);
		rules[pattern] = decision;
	}
	return rules;
}

export function parsePermissionPolicy(value: unknown): Partial<PermissionPolicy> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("permission policy must be an object");
	}
	const raw = value as Record<string, unknown>;
	if (
		raw.level !== undefined &&
		raw.level !== "ask for approval" &&
		raw.level !== "approve for me" &&
		raw.level !== "full access"
	) {
		throw new Error("level must be ask for approval, approve for me, or full access");
	}
	const defaults = parseRuleMap(raw.defaultPolicy, "defaultPolicy");
	return {
		level: raw.level as PermissionLevel | undefined,
		defaultPolicy: defaults as Partial<Record<PermissionCategory, PermissionDecision>> as Record<
			PermissionCategory,
			PermissionDecision
		>,
		tools: parseRuleMap(raw.tools, "tools"),
		bash: parseRuleMap(raw.bash, "bash"),
		mcp: parseRuleMap(raw.mcp, "mcp"),
	};
}

function mergePolicy(base: PermissionPolicy, override: Partial<PermissionPolicy>): PermissionPolicy {
	return {
		level: override.level ?? base.level,
		defaultPolicy: { ...base.defaultPolicy, ...override.defaultPolicy },
		tools: { ...base.tools, ...override.tools },
		bash: { ...base.bash, ...override.bash },
		mcp: { ...base.mcp, ...override.mcp },
	};
}

async function readPolicy(path: string): Promise<{ policy?: Partial<PermissionPolicy>; warning?: string }> {
	try {
		return { policy: parsePermissionPolicy(JSON.parse(await readFile(path, "utf8")) as unknown) };
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
		return { warning: `${path}: ${error instanceof Error ? error.message : String(error)}` };
	}
}

export async function loadPermissionPolicy(cwd: string): Promise<LoadedPermissionPolicy> {
	const candidates = [join(getAgentDir(), "permissions.json"), join(cwd, ".omega", "agent", "permissions.json")];
	let policy = DEFAULT_PERMISSION_POLICY;
	const paths: string[] = [];
	const warnings: string[] = [];
	for (const path of candidates) {
		const loaded = await readPolicy(path);
		if (loaded.policy) {
			policy = mergePolicy(policy, loaded.policy);
			paths.push(path);
		}
		if (loaded.warning) warnings.push(loaded.warning);
	}
	return { policy, paths, warnings };
}

function wildcardRegex(pattern: string): RegExp {
	const escaped = pattern.replace(/[\\^$+?.()|[\]{}]/g, "\\$&").replaceAll("*", ".*");
	return new RegExp(`^${escaped}$`, "iu");
}

export function evaluateRules(
	value: string,
	rules: Record<string, PermissionDecision>,
	fallback: PermissionDecision,
): { decision: PermissionDecision; pattern?: string } {
	let result: { decision: PermissionDecision; pattern?: string } = { decision: fallback };
	for (const [pattern, decision] of Object.entries(rules)) {
		if (wildcardRegex(pattern).test(value)) result = { decision, pattern };
	}
	return result;
}

export function defaultPermissionPolicyJson(): string {
	return `${JSON.stringify(DEFAULT_PERMISSION_POLICY, null, 2)}\n`;
}
