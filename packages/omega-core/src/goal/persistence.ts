import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isNonNegativeFiniteNumber, nonNegativeFiniteNumber, normalizeTokenBudget } from "./accounting.ts";
import type { GoalStatus } from "./prompts.ts";
import { type GoalWait, normalizeGoalWait } from "./wait.ts";

const GOAL_STATE_ENTRY_TYPE = "goal-state";
const LEGACY_GOALS_STATE_ENTRY_TYPE = "goals-state";
const STATE_FILE = join(getAgentDir(), "pi-goal-state.json");

export type SafetyPauseCause = "continuation_limit" | "no_progress" | "verification_limit";

export interface VerificationRejection {
	reason: string;
	missingEvidence: string[];
	nextActions?: string[];
}

export interface ActiveGoal {
	id: string;
	text: string;
	status: GoalStatus;
	startedAt: number;
	updatedAt: number;
	iteration: number;
	tokenBudget?: number;
	tokensUsed: number;
	timeUsedSeconds: number;
	baselineTokens: number;
	activeStartedAt?: number;
	automaticModelTurns: number;
	toolFreeRepeatCount: number;
	lastToolFreeOutputFingerprint?: string;
	safetyPauseCause?: SafetyPauseCause;
	safetyResetPending?: boolean;
	waiting?: GoalWait;
	/** Consecutive supervisor verdicts of not_achieved/insufficient_evidence for the current goal instance. */
	verificationFailures?: number;
	/** Structured gaps from the last rejected goal_complete verdict, replayed into continuation prompts. */
	verificationGaps?: VerificationRejection;
	/** Numbered plan steps extracted from assistant "Plan:" output (plan-superset progress tracking). */
	planSteps?: PlanStep[];
}

export interface PlanStep {
	step: number;
	text: string;
	completed: boolean;
}

export interface GoalStateEntryData {
	goal: ActiveGoal | null;
}

export interface LegacyQueueState {
	reason: "canonical-queue" | "legacy-goals";
	retainedGoals: number;
}

export interface LoadedGoalState {
	goal: ActiveGoal | undefined;
	legacyQueueState: LegacyQueueState | undefined;
	source: "none" | "canonical" | "legacy-goals";
}

interface SessionEntry {
	type?: string;
	customType?: string;
	data?: unknown;
}

interface SessionContext {
	sessionManager?: {
		getBranch?: () => SessionEntry[];
		getEntries?: () => SessionEntry[];
	};
}

export function serializeGoalState(goal: ActiveGoal | undefined): GoalStateEntryData {
	return { goal: goal ?? null };
}

export function loadGoalStateFromSession(ctx: SessionContext): LoadedGoalState {
	const entries = ctx.sessionManager?.getBranch?.() ?? ctx.sessionManager?.getEntries?.() ?? [];
	const canonicalEntry = entries
		.filter((entry) => entry.type === "custom" && entry.customType === GOAL_STATE_ENTRY_TYPE)
		.pop();
	if (canonicalEntry) return loadCanonicalGoalState(canonicalEntry.data);

	const legacyEntry = entries
		.filter((entry) => entry.type === "custom" && entry.customType === LEGACY_GOALS_STATE_ENTRY_TYPE)
		.pop();
	return legacyEntry ? loadLegacyGoalsState(legacyEntry.data) : emptyGoalState("none");
}

function loadCanonicalGoalState(data: unknown): LoadedGoalState {
	if (!isRecord(data)) return emptyGoalState("canonical");
	const rawGoal = data.goal;
	if (rawGoal !== null && !isGoal(rawGoal)) return emptyGoalState("canonical");
	const rawQueue = Object.hasOwn(data, "queue") ? data.queue : undefined;
	if (rawQueue !== undefined && (!Array.isArray(rawQueue) || !rawQueue.every(isQueueGoal))) {
		return emptyGoalState("canonical");
	}
	const pendingAction = Object.hasOwn(data, "pendingAction")
		? normalizeCanonicalPendingAction(data.pendingAction)
		: undefined;
	if (Object.hasOwn(data, "pendingAction") && !pendingAction) return emptyGoalState("canonical");
	const hasQueueFields = rawQueue !== undefined || pendingAction !== undefined;
	if (hasQueueFields || (isGoal(rawGoal) && rawGoal.status === "queued")) {
		return legacyQueueState("canonical", {
			reason: "canonical-queue",
			retainedGoals: countCanonicalLegacyGoals(rawGoal, rawQueue, pendingAction),
		});
	}

	let goal = rawGoal === null ? undefined : normalizeLoadedGoal(rawGoal);
	if (goal?.status === "complete") goal = undefined;
	return { goal, legacyQueueState: undefined, source: "canonical" };
}

function countCanonicalLegacyGoals(
	goal: unknown,
	queue: ActiveGoal[] | undefined,
	pendingAction: { kind: string } | undefined,
) {
	let count = isGoal(goal) && goal.status !== "complete" ? 1 : 0;
	count += (queue ?? []).filter((queuedGoal) => queuedGoal.status !== "complete").length;
	if (pendingAction?.kind === "prioritize") count += 1;
	return count;
}

function normalizeCanonicalPendingAction(value: unknown): { kind: string } | undefined {
	if (!isRecord(value)) return undefined;
	if (value.kind === "prioritize" && validObjective(value.objective)) return { kind: "prioritize" };
	if (
		value.kind === "advance" &&
		typeof value.goalId === "string" &&
		value.goalId.trim() &&
		(value.reason === "complete" || value.reason === "skip") &&
		validObjective(value.completedText)
	) {
		return { kind: "advance" };
	}
	return undefined;
}

function loadLegacyGoalsState(data: unknown): LoadedGoalState {
	if (!isRecord(data)) return emptyGoalState("legacy-goals");
	let rawGoals: ActiveGoal[];
	if (Array.isArray(data.goals)) {
		if (!data.goals.every(isGoal)) return emptyGoalState("legacy-goals");
		rawGoals = data.goals.filter((goal) => goal.status !== "complete");
	} else if (isGoal(data.goal) && data.goal.status !== "complete") {
		rawGoals = [data.goal];
	} else {
		rawGoals = [];
	}
	const pendingAction = normalizeLegacyPendingPrioritize(data.pendingUnshift);
	if (rawGoals.length === 1 && rawGoals[0]?.status !== "queued" && pendingAction === undefined) {
		return {
			goal: normalizeLoadedGoal(rawGoals[0]),
			legacyQueueState: undefined,
			source: "legacy-goals",
		};
	}
	if (rawGoals.length === 0 && pendingAction === undefined) return emptyGoalState("legacy-goals");
	return legacyQueueState("legacy-goals", {
		reason: "legacy-goals",
		retainedGoals: rawGoals.length + (pendingAction ? 1 : 0),
	});
}

function normalizeLegacyPendingPrioritize(value: unknown): { objective: string } | undefined {
	if (!isRecord(value) || !validObjective(value.objective)) return undefined;
	return { objective: value.objective };
}

function validObjective(value: unknown): value is string {
	return typeof value === "string" && Boolean(value.trim()) && value.length <= 4_000;
}

export function normalizeLoadedGoal(goal: ActiveGoal): ActiveGoal {
	const now = Date.now();
	const waiting = goal.status === "active" ? normalizeGoalWait(goal.waiting) : undefined;
	return {
		...goal,
		startedAt: isNonNegativeFiniteNumber(goal.startedAt) ? goal.startedAt : now,
		updatedAt: isNonNegativeFiniteNumber(goal.updatedAt) ? goal.updatedAt : now,
		iteration: Math.max(0, Math.floor(nonNegativeFiniteNumber(goal.iteration))),
		tokenBudget: normalizeTokenBudget(goal.tokenBudget),
		tokensUsed: nonNegativeFiniteNumber(goal.tokensUsed),
		timeUsedSeconds: nonNegativeFiniteNumber(goal.timeUsedSeconds),
		baselineTokens: nonNegativeFiniteNumber(goal.baselineTokens),
		activeStartedAt: goal.status === "active" && !waiting ? now : undefined,
		automaticModelTurns: normalizeSafetyCounter(goal.automaticModelTurns),
		toolFreeRepeatCount: normalizeSafetyCounter(goal.toolFreeRepeatCount),
		lastToolFreeOutputFingerprint: normalizeOutputFingerprint(goal.lastToolFreeOutputFingerprint),
		safetyPauseCause: normalizeSafetyPauseCause(goal.safetyPauseCause),
		safetyResetPending: goal.safetyResetPending === true ? true : undefined,
		verificationFailures: normalizeSafetyCounter(goal.verificationFailures),
		verificationGaps: normalizeVerificationRejection(goal.verificationGaps),
		planSteps: normalizePlanSteps(goal.planSteps),
		waiting,
	};
}

function normalizeVerificationRejection(value: unknown): VerificationRejection | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.reason !== "string" || !value.reason.trim()) return undefined;
	if (!Array.isArray(value.missingEvidence) || !value.missingEvidence.every((item) => typeof item === "string")) {
		return undefined;
	}
	const nextActions = Array.isArray(value.nextActions)
		? value.nextActions.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, 32)
		: undefined;
	return {
		reason: value.reason,
		missingEvidence: value.missingEvidence.filter((item) => item.trim()).slice(0, 32),
		...(nextActions?.length ? { nextActions } : {}),
	};
}

function normalizePlanSteps(value: unknown): PlanStep[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const steps: PlanStep[] = [];
	for (const item of value) {
		if (!isRecord(item)) continue;
		if (typeof item.text !== "string" || !item.text.trim()) continue;
		const step = typeof item.step === "number" && Number.isSafeInteger(item.step) ? item.step : steps.length + 1;
		steps.push({ step, text: item.text.slice(0, 200), completed: item.completed === true });
	}
	return steps.length > 0 ? steps.slice(0, 50) : undefined;
}

function normalizeSafetyCounter(value: unknown) {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function normalizeOutputFingerprint(value: unknown) {
	return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value) ? value : undefined;
}

function normalizeSafetyPauseCause(value: unknown): SafetyPauseCause | undefined {
	return value === "continuation_limit" || value === "no_progress" || value === "verification_limit"
		? value
		: undefined;
}

export function clearLegacyPersistedGoal(cwd: string) {
	if (!existsSync(STATE_FILE)) return;
	const goals = readState();
	delete goals[cwd];
	mkdirSync(dirname(STATE_FILE), { recursive: true });
	writeFileSync(STATE_FILE, `${JSON.stringify(goals, null, 2)}\n`);
}

function readState(): Record<string, unknown> {
	if (!existsSync(STATE_FILE)) return {};
	try {
		const parsed = JSON.parse(readFileSync(STATE_FILE, "utf8")) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

function isGoal(value: unknown): value is ActiveGoal {
	if (!isRecord(value)) return false;
	return (
		typeof value.id === "string" &&
		Boolean(value.id) &&
		value.id === value.id.trim() &&
		validObjective(value.text) &&
		["active", "queued", "paused", "blocked", "usage_limited", "budget_limited", "complete"].includes(
			String(value.status),
		) &&
		typeof value.startedAt === "number" &&
		typeof value.updatedAt === "number" &&
		typeof value.iteration === "number" &&
		typeof value.tokensUsed === "number" &&
		typeof value.timeUsedSeconds === "number" &&
		typeof value.baselineTokens === "number" &&
		(value.activeStartedAt === undefined || typeof value.activeStartedAt === "number") &&
		(value.safetyResetPending === undefined || typeof value.safetyResetPending === "boolean")
	);
}

function isQueueGoal(value: unknown): value is ActiveGoal {
	return isGoal(value) && value.status !== "complete";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emptyGoalState(source: LoadedGoalState["source"]): LoadedGoalState {
	return {
		goal: undefined,
		legacyQueueState: undefined,
		source,
	};
}

function legacyQueueState(source: LoadedGoalState["source"], legacyQueue: LegacyQueueState): LoadedGoalState {
	return {
		goal: undefined,
		legacyQueueState: legacyQueue,
		source,
	};
}
