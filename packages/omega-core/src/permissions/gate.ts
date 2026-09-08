import { DEFAULT_PERMISSION_POLICY, evaluateRules } from "./policy.ts";

/** Return the matching built-in policy pattern when a command requires confirmation or is denied. */
export function dangerousCommandReason(command: string): string | undefined {
	const result = evaluateRules(
		command.trim(),
		DEFAULT_PERMISSION_POLICY.bash,
		DEFAULT_PERMISSION_POLICY.defaultPolicy.bash,
	);
	return result.decision === "allow" ? undefined : result.pattern;
}

/** Compatibility helper for callers that only need a binary risky/safe decision. */
export function isDangerousCommand(command: string): boolean {
	return dangerousCommandReason(command) !== undefined;
}
