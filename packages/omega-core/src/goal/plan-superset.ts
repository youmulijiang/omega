/**
 * Goal-as-plan-superset bridge: a goal run's "Plan:" output becomes tracked
 * plan steps that drive the shared todo panel, and completion flows back from
 * both [DONE:n] markers and todo-tool completions.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { OmegaAPI } from "../api.ts";
import { extractPlanSteps } from "../plan-mode/planner.ts";
import { markCompletedSteps } from "../plan-mode/progress.ts";
import { applyTodoCompletionToPlan, syncTodosWithPlan } from "../todo/index.ts";
import type { ActiveGoal } from "./persistence.ts";

interface AssistantLikeMessage {
	role?: unknown;
	content?: unknown;
}

export function assistantTextOf(message: AssistantLikeMessage | undefined): string {
	if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return "";
	return (message.content as Array<{ type?: unknown; text?: unknown }>)
		.filter((block) => block && block.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string)
		.join("\n");
}

/** Adopt the first "Plan:" section of a goal run as the goal's tracked steps. */
export function adoptGoalPlan(
	omega: OmegaAPI,
	ctx: ExtensionContext,
	goal: ActiveGoal,
	assistantText: string,
): boolean {
	if (goal.planSteps?.length) return false;
	const steps = extractPlanSteps(assistantText);
	if (steps.length === 0) return false;
	goal.planSteps = steps;
	syncTodosWithPlan(omega, ctx, steps, true);
	return true;
}

/** Apply [DONE:n] markers and todo-tool completions to the goal's plan steps. */
export function advanceGoalPlan(
	omega: OmegaAPI,
	ctx: ExtensionContext,
	goal: ActiveGoal,
	assistantText: string,
): number {
	const steps = goal.planSteps;
	if (!steps?.length) return 0;
	const changed = applyTodoCompletionToPlan(ctx, steps) + markCompletedSteps(assistantText, steps);
	if (changed > 0) syncTodosWithPlan(omega, ctx, steps, true);
	return changed;
}
