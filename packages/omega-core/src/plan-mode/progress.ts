/**
 * Progress tracking for plan execution.
 * Parses [DONE:n] markers from LLM output and updates step completion.
 */

import type { PlanStep } from "./types.ts";

/**
 * Extract completed step numbers from [DONE:n] markers in text.
 */
export function extractDoneSteps(message: string): number[] {
	const steps: number[] = [];
	for (const match of message.matchAll(/\[DONE:(\d+)\]/gi)) {
		const step = Number(match[1]);
		if (Number.isFinite(step)) steps.push(step);
	}
	return steps;
}

/**
 * Mark steps as completed based on [DONE:n] markers found in text.
 * Returns the number of steps newly marked as completed.
 */
export function markCompletedSteps(text: string, items: PlanStep[]): number {
	const doneSteps = extractDoneSteps(text);
	let newlyCompleted = 0;
	for (const step of doneSteps) {
		const item = items.find((t) => t.step === step);
		if (item && !item.completed) {
			item.completed = true;
			newlyCompleted++;
		}
	}
	return newlyCompleted;
}

/**
 * Calculate completion stats for a set of plan steps.
 */
export function getCompletionStats(steps: PlanStep[]): {
	completed: number;
	total: number;
	allDone: boolean;
} {
	const completed = steps.filter((s) => s.completed).length;
	return {
		completed,
		total: steps.length,
		allDone: steps.length > 0 && completed === steps.length,
	};
}
