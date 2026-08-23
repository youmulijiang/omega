/**
 * Bash command safety checking for plan mode.
 * Determines whether a command is read-only (safe) or destructive (blocked).
 *
 * Three layers of protection:
 * 1. Shell construct blocking — prevents injection via ;, &, `, newlines
 * 2. Redirect blocking — prevents file writes via >, >>
 * 3. Whitelist + blacklist — allows known-safe commands, blocks known-destructive ones
 * 4. Pipe safety — blocks unsafe pipe targets (| rm, | sudo, etc.)
 */

// === Layer 1: Shell construct blocking ===

/** Block dangerous shell constructs (but allow pipes for safe command chaining) */
const UNSAFE_SHELL_CHARS = /[;&`\n]/;

// === Layer 2: Redirect blocking ===

const REDIRECT_PATTERN = />{1,2}/;

// === Layer 3: Pipe safety ===

const UNSAFE_PIPE_PATTERNS: RegExp[] = [
	/\|\s*rm\b/,
	/\|\s*xargs.*rm\b/,
	/\|\s*sudo\b/,
	/\|\s*chmod\b/,
	/\|\s*chown\b/,
	/\|\s*mv\b/,
	/\|\s*cp\b/,
	/\|\s*wget\b/,
	/\|\s*curl\b/,
];

function hasUnsafePipe(command: string): boolean {
	return UNSAFE_PIPE_PATTERNS.some((p) => p.test(command));
}

// === Layer 4: Whitelist & blacklist ===

const DESTRUCTIVE_PATTERNS: RegExp[] = [
	// File system modification
	/\brm\b/,
	/\brmdir\b/,
	/\bmv\b/,
	/\bcp\b/,
	/\bmkdir\b/,
	/\btouch\b/,
	/\bchmod\b/,
	/\bchown\b/,
	/\bchgrp\b/,
	/\bln\b/,
	/\btee\b/,
	/\btruncate\b/,
	/\bdd\b/,
	/\bshred\b/,
	// Package managers (install/uninstall/update)
	/\bnpm\s+(install|uninstall|update|ci|link|publish)\b/,
	/\byarn\s+(add|remove|install|publish)\b/,
	/\bpnpm\s+(add|remove|install|publish)\b/,
	/\bpip\s+(install|uninstall)\b/,
	/\bapt(-get)?\s+(install|remove|purge|update|upgrade)\b/,
	/\bbrew\s+(install|uninstall|upgrade)\b/,
	// Git write operations
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)\b/,
	// System
	/\bsudo\b/,
	/\bsu\b/,
	/\bkill\b/,
	/\bpkill\b/,
	/\bkillall\b/,
	/\breboot\b/,
	/\bshutdown\b/,
	/\bsystemctl\s+(start|stop|restart|enable|disable)\b/,
	/\bservice\s+\S+\s+(start|stop|restart)\b/,
	// Editors
	/\b(vim?|nano|emacs|code|subl)\b/,
];

const SAFE_PATTERNS: RegExp[] = [
	// File inspection
	/^\s*cat\b/,
	/^\s*head\b/,
	/^\s*tail\b/,
	/^\s*less\b/,
	/^\s*more\b/,
	// Search & find
	/^\s*grep\b/,
	/^\s*rg\b/,
	/^\s*fd\b/,
	/^\s*find\b/,
	// Directory listing
	/^\s*ls\b/,
	/^\s*pwd\b/,
	/^\s*tree\b/,
	/^\s*eza\b/,
	// Text processing (read-only)
	/^\s*echo\b/,
	/^\s*printf\b/,
	/^\s*wc\b/,
	/^\s*sort\b/,
	/^\s*uniq\b/,
	/^\s*diff\b/,
	/^\s*jq\b/,
	/^\s*sed\s+-n\b/,
	/^\s*awk\b/,
	/^\s*cut\b/,
	/^\s*tr\b/,
	/^\s*xargs\b/,
	/^\s*column\b/,
	// File metadata
	/^\s*file\b/,
	/^\s*stat\b/,
	/^\s*du\b/,
	/^\s*df\b/,
	// System info
	/^\s*which\b/,
	/^\s*whereis\b/,
	/^\s*type\b/,
	/^\s*env\b/,
	/^\s*printenv\b/,
	/^\s*uname\b/,
	/^\s*whoami\b/,
	/^\s*id\b/,
	/^\s*date\b/,
	/^\s*cal\b/,
	/^\s*uptime\b/,
	// Process (read-only)
	/^\s*ps\b/,
	/^\s*top\b/,
	/^\s*htop\b/,
	/^\s*free\b/,
	// Git read-only
	/^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get)\b/,
	/^\s*git\s+ls-/,
	// Package info (read-only)
	/^\s*npm\s+(list|ls|view|info|search|outdated|audit)\b/,
	/^\s*yarn\s+(list|info|why|audit)\b/,
	/^\s*node\s+--version\b/,
	/^\s*python\s+--version\b/,
	// Network (read-only)
	/^\s*curl\b/,
	/^\s*wget\s+-O\s*-\b/,
	// Code display
	/^\s*bat\b/,
];

/**
 * Normalize command: strip line continuations and collapse newlines.
 */
function normalizeCommand(command: string): string {
	return command
		.trim()
		.replace(/\\\n\s*/g, "")
		.replace(/\n\s*/g, " ");
}

/**
 * Check whether a bash command is safe (read-only) for plan mode.
 *
 * Returns an object with `safe` boolean and optional `reason` string.
 */
export function checkCommand(command: string): {
	safe: boolean;
	reason?: string;
} {
	// Layer 1: Shell construct blocking — check RAW command before normalization
	if (UNSAFE_SHELL_CHARS.test(command)) {
		return {
			safe: false,
			reason: "Plan mode: shell constructs (;, &, `, newlines) are not allowed.",
		};
	}

	const cmd = normalizeCommand(command);

	// Layer 2: Redirect blocking
	if (REDIRECT_PATTERN.test(cmd)) {
		return {
			safe: false,
			reason: "Plan mode: file redirects (>, >>) are not allowed.",
		};
	}

	// Layer 3: Pipe safety
	if (hasUnsafePipe(cmd)) {
		return {
			safe: false,
			reason: "Plan mode: unsafe pipe target detected.",
		};
	}

	// Layer 4: Whitelist — explicitly safe
	if (SAFE_PATTERNS.some((p) => p.test(cmd))) {
		return { safe: true };
	}

	// Layer 4: Blacklist — explicitly destructive
	if (DESTRUCTIVE_PATTERNS.some((p) => p.test(cmd))) {
		return {
			safe: false,
			reason: `Plan mode: command blocked (destructive). Use /plan to disable.\nBlocked: ${command}`,
		};
	}

	// Unknown command — blocked by default (could add AI review here later)
	return {
		safe: false,
		reason: `Plan mode: command not in allowlist. Use /plan to disable.\nBlocked: ${command}`,
	};
}

/**
 * Simple boolean check for backwards compatibility.
 */
export function isSafeCommand(command: string): boolean {
	return checkCommand(command).safe;
}
