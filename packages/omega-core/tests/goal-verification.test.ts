import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerGoalTools } from "../src/goal/tools.ts";
import { GoalRuntime } from "../src/goal/runtime.ts";
import { VerificationUnavailableError, type GoalVerificationResult, type SkepticRunner } from "../src/goal/verifier.ts";
import type { ActiveGoal } from "../src/goal/persistence.ts";

type ToolExecute = (toolCallId: string, params: unknown, signal: undefined, onUpdate: undefined, ctx: ExtensionContext) => Promise<unknown>;

function makeGoal(overrides: Partial<ActiveGoal> = {}): ActiveGoal {
	return {
		id: "goal-test-1",
		text: "Harden the login endpoint against credential stuffing",
		status: "active",
		iteration: 1,
		automaticModelTurns: 0,
		tokensUsed: 0,
		startedAt: Date.now(),
		updatedAt: Date.now(),
		timeUsedSeconds: 0,
		baselineTokens: 0,
		...overrides,
	} as ActiveGoal;
}

function makeCtx(): ExtensionContext {
	return {
		ui: {
			notify: vi.fn(),
			setStatus: vi.fn(),
			setWidget: vi.fn(),
			theme: { fg: (_color: string, text: string) => text },
		},
		mode: "tui",
		hasUI: true,
		cwd: "/tmp/goal-test",
		isIdle: () => true,
		hasPendingMessages: () => false,
		signal: undefined,
	} as unknown as ExtensionContext;
}

interface Harness {
	pi: ExtensionAPI;
	runtime: GoalRuntime;
	tools: Map<string, ToolExecute>;
	ctx: ExtensionContext;
	callComplete: (goalId: string, summary: string) => Promise<{ result: unknown; terminate: boolean | undefined }>;
}

function makeHarness(goal: ActiveGoal, skeptic: SkepticRunner): Harness {
	const tools = new Map<string, ToolExecute>();
	const pi = {
		appendEntry: vi.fn(),
		sendMessage: vi.fn(),
		events: { emit: vi.fn(), on: vi.fn() },
		getActiveTools: vi.fn(() => ["goal_complete", "goal_blocked", "read", "bash"]),
		registerTool: (tool: { name: string }) => tools.set(tool.name, tool.execute as ToolExecute),
	} as unknown as ExtensionAPI;

	const runtime = new GoalRuntime(pi);
	runtime.settings.verification = { enabled: true, maxAttempts: 3, timeoutMs: 5_000 };
	runtime.bindWorkflowSession({});
	runtime.activeGoal = goal;
	expect(runtime.acquireWorkflow()).toBe(true);
	runtime.beginAgentRun(goal.id, "manual");

	registerGoalTools(pi, runtime, { skepticRunner: skeptic });

	return {
		pi,
		runtime,
		tools,
		ctx: makeCtx(),
		async callComplete(goalId, summary) {
			const result = (await tools.get("goal_complete")?.("", { goal_id: goalId, summary }, undefined, undefined, makeCtx())) as {
				terminate?: boolean;
			};
			return { result, terminate: result?.terminate };
		},
	};
}

function notAchieved(overrides: Partial<GoalVerificationResult> = {}): GoalVerificationResult {
	return {
		verdict: "not_achieved",
		summary: "The rate limiter is not wired into the login handler.",
		missingEvidence: ["No test proves repeated logins are throttled."],
		nextActions: ["Add throttling middleware and a regression test."],
		...overrides,
	};
}

describe("goal_complete supervisor verification", () => {
	it("accepts the completion and terminates when the skeptic returns achieved", async () => {
		const skeptic = vi.fn(async () => ({
			verdict: "achieved" as const,
			summary: "Every requirement is proven by re-run tests.",
			missingEvidence: [],
			nextActions: [],
		}));
		const { tools, ctx, callComplete } = makeHarness(makeGoal(), skeptic);

		const { terminate } = await callComplete("goal-test-1", "Rate limiting added and verified by tests.");

		expect(terminate).toBe(true);
		expect(skeptic).toHaveBeenCalledOnce();
		const prompt = skeptic.mock.calls[0][0] as string;
		expect(prompt).toContain("Harden the login endpoint");
		expect(prompt).toContain("Rate limiting added and verified by tests.");
		expect(prompt).toContain("UNTRUSTED");
	});

	it("rejects the completion, keeps the goal active, and reports gaps on not_achieved", async () => {
		const { runtime, tools, callComplete } = makeHarness(makeGoal(), vi.fn(async () => notAchieved()));

		const { result, terminate } = await callComplete("goal-test-1", "Everything is done.");

		expect(terminate).toBeUndefined();
		expect(runtime.activeGoal?.status).toBe("active");
		expect(runtime.activeGoal?.verificationFailures).toBe(1);
		expect(runtime.activeGoal?.verificationGaps?.reason).toBe(notAchieved().summary);
		const text = (result as { content: Array<{ type: string; text?: string }> }).content
			.map((block) => block.text ?? "")
			.join("");
		expect(text).toContain("NOT confirmed");
		expect(text).toContain("rate limiter");
		expect(text).toContain("throttled");
	});

	it("pauses the goal with verification_limit after maxAttempts consecutive rejections", async () => {
		const { runtime, callComplete } = makeHarness(makeGoal(), vi.fn(async () => notAchieved()));

		await callComplete("goal-test-1", "First claim.");
		await callComplete("goal-test-1", "Second claim.");
		const { terminate } = await callComplete("goal-test-1", "Third claim.");

		expect(terminate).toBeUndefined();
		expect(runtime.activeGoal?.status).toBe("paused");
		expect(runtime.activeGoal?.safetyPauseCause).toBe("verification_limit");
		expect(runtime.activeGoal?.verificationFailures).toBe(3);
	});

	it("fails open with a warning when verification cannot run", async () => {
		const skeptic = vi.fn(async () => {
			throw new VerificationUnavailableError("skeptic subprocess never started");
		});
		const { tools, callComplete } = makeHarness(makeGoal(), skeptic);

		const { result, terminate } = await callComplete("goal-test-1", "Claim with no working verifier.");

		expect(terminate).toBe(true);
		const text = (result as { content: Array<{ type: string; text?: string }> }).content
			.map((block) => block.text ?? "")
			.join("");
		expect(text).toContain("Goal complete");
	});

	it("rejects on insufficient_evidence the same as not_achieved", async () => {
		const { runtime, callComplete } = makeHarness(
			makeGoal(),
			vi.fn(async () =>
				notAchieved({
					verdict: "insufficient_evidence",
					summary: "The deployed service state is out of reach.",
					missingEvidence: ["Cannot inspect the deployed rate limiter configuration."],
					nextActions: ["Provide access to the deployment."],
				}),
			),
		);

		await callComplete("goal-test-1", "It works.");

		expect(runtime.activeGoal?.status).toBe("active");
		expect(runtime.activeGoal?.verificationFailures).toBe(1);
	});

	it("includes previous gaps in the verification prompt on the second attempt", async () => {
		const skeptic = vi
			.fn<SkepticRunner>()
			.mockResolvedValueOnce(notAchieved())
			.mockResolvedValueOnce({
				verdict: "achieved",
				summary: "Verified after fixes.",
				missingEvidence: [],
				nextActions: [],
			});
		const { callComplete } = makeHarness(makeGoal(), skeptic);

		await callComplete("goal-test-1", "First claim.");
		await callComplete("goal-test-1", "Second claim.");

		expect(skeptic).toHaveBeenCalledTimes(2);
		const secondPrompt = skeptic.mock.calls[1][0] as string;
		expect(secondPrompt).toContain("rejected this same completion");
		expect(secondPrompt).toContain("throttled");
	});

	it("skips verification during budget wrap-up", async () => {
		const skeptic = vi.fn(async () => notAchieved());
		const goal = makeGoal();
		const harness = makeHarness(goal, skeptic);
		// Mirrors the real budget-limited state: goal stopped, wrap-up delivered.
		harness.runtime.activeGoal = { ...goal, status: "budget_limited" };
		(harness.runtime as unknown as { budgetWrapUp: { goalId: string; delivered: boolean } }).budgetWrapUp = {
			goalId: goal.id,
			delivered: true,
		};

		const { terminate } = await harness.callComplete("goal-test-1", "Wrap-up completion.");

		expect(terminate).toBe(true);
		expect(skeptic).not.toHaveBeenCalled();
	});

	it("skips verification in print mode", async () => {
		const skeptic = vi.fn(async () => notAchieved());
		const harness = makeHarness(makeGoal(), skeptic);
		const ctx = { ...harness.ctx, mode: "print" } as ExtensionContext;

		const result = (await harness.tools.get("goal_complete")?.(
			"",
			{ goal_id: "goal-test-1", summary: "Print-mode completion." },
			undefined,
			undefined,
			ctx,
		)) as { terminate?: boolean };

		expect(result.terminate).toBe(true);
		expect(skeptic).not.toHaveBeenCalled();
	});
});

describe("buildContinuePrompt verification replay", () => {
	it("replays gaps into the continuation prompt", async () => {
		const { buildContinuePrompt } = await import("../src/goal/prompts.ts");
		const prompt = buildContinuePrompt(
			{
				id: "goal-test-1",
				text: "Harden the login endpoint",
				status: "active",
				iteration: 2,
				tokensUsed: 0,
				startedAt: Date.now(),
				updatedAt: Date.now(),
				timeUsedSeconds: 0,
				baselineTokens: 0,
				verificationGaps: {
					reason: "Rate limiter missing.",
					missingEvidence: ["No throttling test."],
					nextActions: ["Add a throttling test."],
				},
			},
			"marker-1",
		);
		expect(prompt).toContain("goal_verification_gaps");
		expect(prompt).toContain("Rate limiter missing.");
		expect(prompt).toContain("throttling test");
	});

	it("renders plan progress and plan block", async () => {
		const { buildContinuePrompt } = await import("../src/goal/prompts.ts");
		const prompt = buildContinuePrompt(
			{
				id: "goal-test-1",
				text: "Harden the login endpoint",
				status: "active",
				iteration: 2,
				tokensUsed: 0,
				startedAt: Date.now(),
				updatedAt: Date.now(),
				timeUsedSeconds: 0,
				baselineTokens: 0,
				planSteps: [
					{ step: 1, text: "Add rate limiter", completed: true },
					{ step: 2, text: "Add test", completed: false },
				],
			},
			"marker-1",
		);
		expect(prompt).toContain("goal_plan");
		expect(prompt).toContain("[DONE] 1. Add rate limiter");
		expect(prompt).toContain("[PENDING] 2. Add test");
	});
});

describe("goal plan superset", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it("extracts a Plan: section into goal.planSteps", async () => {
		const { extractPlanSteps } = await import("../src/plan-mode/planner.ts");
		const steps = extractPlanSteps(
			"Working on it.\n\nPlan:\n1. Add rate limiting middleware\n2. Add regression tests\n3. Verify manually",
		);
		expect(steps).toHaveLength(3);
		expect(steps[0].text).toBe("Add rate limiting middleware");
		expect(steps.every((step) => !step.completed)).toBe(true);
	});

	it("marks steps completed from [DONE:n] markers", async () => {
		const { markCompletedSteps } = await import("../src/plan-mode/progress.ts");
		const steps = [
			{ step: 1, text: "Add rate limiting middleware", completed: false },
			{ step: 2, text: "Add regression tests", completed: false },
		];
		const changed = markCompletedSteps("Finished step one [DONE:1], continuing.", steps);
		expect(changed).toBe(1);
		expect(steps[0].completed).toBe(true);
		expect(steps[1].completed).toBe(false);
	});
});

describe("formatStatus verification display", () => {
	it("shows verification progress for a paused verification_limit goal", async () => {
		const { formatStatus } = await import("../src/goal/runtime.ts");
		const goal = makeGoal({
			status: "paused",
			safetyPauseCause: "verification_limit",
			verificationFailures: 3,
			planSteps: [
				{ step: 1, text: "a", completed: true },
				{ step: 2, text: "b", completed: false },
			],
		});
		expect(formatStatus(goal)).toContain("verification rejected 3 completion claims");
		expect(formatStatus(goal)).toContain("📋 1/2");
	});
});
