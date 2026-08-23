/**
 * Core types for plan-mode extension.
 */

export type PlanMode = "normal" | "plan" | "execute";

export interface PlanStep {
	step: number;
	text: string;
	completed: boolean;
}

export interface PlanState {
	mode: PlanMode;
	steps: PlanStep[];
	toolsBeforePlanMode?: string[];
}
