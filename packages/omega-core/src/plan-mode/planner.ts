/**
 * Plan extraction from LLM output.
 * Extracts numbered plan steps from assistant messages.
 */

import type { PlanStep } from "./types.ts";

/**
 * Clean step text by removing markdown formatting and normalizing.
 */
export function cleanStepText(text: string): string {
	let cleaned = text
		.replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1") // Remove bold/italic
		.replace(/`([^`]+)`/g, "$1") // Remove inline code
		.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // Remove links, keep text
		.replace(/\s+/g, " ")
		.trim();

	if (cleaned.length > 0) {
		cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
	}
	if (cleaned.length > 60) {
		cleaned = `${cleaned.slice(0, 57)}...`;
	}
	return cleaned;
}

/**
 * Extract plan steps from LLM output text.
 *
 * Supports multiple plan header formats:
 * - "Plan:" / "## Plan" / "### Plan" / "**Plan:**"
 *
 * Supports both numbered (1. 2. 3.) and unordered (- ) lists.
 * Filters out steps that are too short (< 5 chars before cleaning).
 */
export function extractPlanSteps(message: string): PlanStep[] {
	const items: PlanStep[] = [];

	// Match various "Plan:" header formats
	// Handles: Plan:, ## Plan:, **Plan:**, ### Plan:
	const headerMatch = message.match(/(?:^|\n)\s*(?:#{1,3}\s+)?\*{0,2}Plan\*{0,2}\s*[:：]\s*\*{0,2}\s*\n/i);
	if (!headerMatch) return items;

	const startIndex = message.indexOf(headerMatch[0]) + headerMatch[0].length;
	const planSection = message.slice(startIndex);

	// Try numbered list first: "1. text" or "1) text"
	// Match entire line after number, then clean markdown separately
	const numberedPattern = /^\s*(\d+)[.)]\s+(.+)/gm;
	for (const match of planSection.matchAll(numberedPattern)) {
		const raw = match[2].trim();
		if (raw.length < 5) continue;
		const cleaned = cleanStepText(raw);
		if (cleaned.length > 3) {
			items.push({ step: items.length + 1, text: cleaned, completed: false });
		}
	}

	// If no numbered items, try unordered list: "- text" or "* text"
	if (items.length === 0) {
		const unorderedPattern = /^\s*[-*]\s+\*{0,2}([^*\n]+)/gm;
		for (const match of planSection.matchAll(unorderedPattern)) {
			const raw = match[1]
				.trim()
				.replace(/\*{1,2}$/, "")
				.trim();
			if (raw.length < 5) continue;
			// Stop if we hit a non-list line (blank line followed by non-list content)
			const cleaned = cleanStepText(raw);
			if (cleaned.length > 3) {
				items.push({ step: items.length + 1, text: cleaned, completed: false });
			}
		}
	}

	return items;
}
