/**
 * OMEGA Plan Extension
 *
 * Read-only exploration mode with plan-then-execute workflow.
 *
 * Features:
 * - /plan command or Ctrl+Alt+P to toggle
 * - /plan:status to view current plan and progress
 * - --plan flag to start in plan mode
 * - Multi-layer bash safety (shell constructs, redirects, pipes, whitelist)
 * - Extracts numbered plan steps from "Plan:" sections
 * - [DONE:n] markers to track step completion during execution
 * - Progress tracking widget during execution
 * - Branch-aware state via session entries
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { OmegaAPI } from "../api.ts";
import { registerOmegaCommand } from "../commands/register.ts";
import {
	applyTodoCompletionToPlan,
	onTodoReplacement,
	replaceTodosFromPlan,
	resolveTodoTaskSwitch,
	syncTodosWithPlan,
	todoContinuationPrompt,
} from "../todo/index.ts";
import { extractPlanSteps } from "./planner.ts";
import { getCompletionStats, markCompletedSteps } from "./progress.ts";
import { checkCommand } from "./safety.ts";
import type { PlanMode, PlanState, PlanStep } from "./types.ts";

const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls"];

export function registerPlanMode(omega: OmegaAPI): void {
	let planMode: PlanMode = "normal";
	let steps: PlanStep[] = [];
	let toolsBeforePlanMode: string[] | undefined;

	// --- Helpers ---

	function persistState(): void {
		omega.appendEntry("omega-plan", { mode: planMode, steps, toolsBeforePlanMode });
	}

	function activatePlanTools(): void {
		toolsBeforePlanMode ??= [...omega.getActiveTools()];
		omega.setActiveTools(PLAN_MODE_TOOLS);
	}

	function restoreTools(): void {
		if (toolsBeforePlanMode) {
			omega.setActiveTools(toolsBeforePlanMode);
			toolsBeforePlanMode = undefined;
		}
	}

	function updateUI(ctx: ExtensionContext): void {
		if (planMode === "execute" && steps.length > 0) {
			const { completed, total } = getCompletionStats(steps);
			ctx.ui.setStatus("omega-plan", ctx.ui.theme.fg("accent", `📋 ${completed}/${total}`));
			// The todo module owns the execution list so manual updates and plan progress share one panel.
			ctx.ui.setWidget("omega-plan-todos", undefined);
		} else if (planMode === "plan") {
			ctx.ui.setStatus("omega-plan", ctx.ui.theme.fg("warning", "⏸ plan"));
			ctx.ui.setWidget("omega-plan-todos", undefined);
		} else {
			ctx.ui.setStatus("omega-plan", undefined);
			ctx.ui.setWidget("omega-plan-todos", undefined);
		}
	}

	function togglePlanMode(ctx: ExtensionContext): void {
		if (planMode === "plan") {
			// Turning off plan mode
			planMode = "normal";
			steps = [];
			restoreTools();
			ctx.ui.notify("Plan mode disabled. Full access restored.");
		} else {
			// Turning on plan mode (from normal or execute)
			planMode = "plan";
			steps = [];
			activatePlanTools();
			ctx.ui.notify(`Plan mode enabled. Tools: ${PLAN_MODE_TOOLS.join(", ")}`);
		}
		persistState();
		updateUI(ctx);
	}

	function startPlanTask(prompt: string, ctx: ExtensionContext): void {
		planMode = "plan";
		steps = [];
		activatePlanTools();
		persistState();
		updateUI(ctx);
		ctx.ui.notify(`Plan mode enabled. Tools: ${PLAN_MODE_TOOLS.join(", ")}`);
		omega.sendUserMessage(prompt);
	}

	onTodoReplacement(omega, (ctx) => {
		planMode = "normal";
		steps = [];
		restoreTools();
		persistState();
		updateUI(ctx);
	});

	// --- CLI flag ---

	omega.registerFlag("plan", {
		description: "Start in plan mode (read-only exploration)",
		type: "boolean",
		default: false,
	});

	// --- Commands ---

	registerOmegaCommand(omega, "plan", {
		description: "Start a task in plan mode, or toggle plan mode without arguments",
		handler: async (args, ctx) => {
			const prompt = args.trim();
			if (prompt) {
				const decision = await resolveTodoTaskSwitch(omega, ctx);
				if (decision.kind === "continue_current") {
					omega.sendUserMessage(todoContinuationPrompt(decision.subject));
					return;
				}
				if (decision.kind === "cancel") return;
				startPlanTask(prompt, ctx);
				return;
			}
			togglePlanMode(ctx);
		},
	});

	registerOmegaCommand(omega, "plan:status", {
		description: "Show current plan and progress",
		handler: async (_args, ctx) => {
			if (steps.length === 0) {
				ctx.ui.notify("No active plan. Use /plan to start.", "info");
				return;
			}
			const list = steps.map((s) => `${s.completed ? "✓" : "○"} ${s.text}`).join("\n");
			ctx.ui.notify(`Plan (${planMode}):\n${list}`, "info");
		},
	});

	// --- Shortcut ---

	omega.registerShortcut("ctrl+alt+p", {
		description: "Toggle plan mode",
		handler: async (ctx) => togglePlanMode(ctx),
	});

	// --- Tool call filter ---

	omega.on("tool_call", async (event) => {
		if (planMode !== "plan") return;

		// Block write/edit tools entirely
		if (event.toolName === "write" || event.toolName === "edit") {
			return {
				block: true,
				reason: "Plan mode active. File modifications blocked. Use /plan to disable.",
			};
		}

		// Bash safety: multi-layer check
		if (event.toolName === "bash") {
			const command = event.input.command as string;
			const result = checkCommand(command);
			if (!result.safe) {
				return { block: true, reason: result.reason };
			}
		}
	});

	// --- Context filter: remove stale Omega plan messages when not in plan mode ---

	omega.on("context", async (event) => {
		if (planMode === "plan") return;
		return {
			messages: event.messages.filter((m) => {
				const msg = m as { customType?: string; role?: string; content?: unknown };
				if (msg.customType === "omega-plan-context") return false;
				if (msg.role !== "user") return true;
				const content = msg.content;
				if (typeof content === "string") {
					return !content.includes("[OMEGA PLAN MODE ACTIVE]");
				}
				if (Array.isArray(content)) {
					return !content.some(
						(c: { type?: string; text?: string }) =>
							c.type === "text" && c.text?.includes("[OMEGA PLAN MODE ACTIVE]"),
					);
				}
				return true;
			}),
		};
	});

	// --- Hidden context injection ---

	omega.on("before_agent_start", async () => {
		if (planMode === "plan") {
			return {
				message: {
					customType: "omega-plan-context",
					content: `[OMEGA PLAN MODE ACTIVE]
You are in plan mode — a read-only exploration mode for safe code analysis.

Restrictions:
- You can only use: read, bash, grep, find, ls
- You CANNOT use: edit, write (file modifications are disabled)
- Bash is restricted to an allowlist of read-only commands

Instructions:
- Analyze the codebase and understand the task
- Ask clarifying questions if needed
- Output a detailed numbered plan under a "Plan:" header

Plan:
1. First step description
2. Second step description
...

Do NOT attempt to make changes — just describe what you would do.`,
					display: false,
				},
			};
		}

		if (planMode === "execute" && steps.length > 0) {
			const remaining = steps.filter((s) => !s.completed);
			const todoList = remaining.map((s) => `${s.step}. ${s.text}`).join("\n");
			return {
				message: {
					customType: "omega-plan-context",
					content: `[OMEGA EXECUTING PLAN — Full tool access enabled]

Remaining steps:
${todoList}

Execute each step in order.
Before starting a step, use the todo tool to mark it in_progress.
After verification, use the todo tool to mark it completed. The legacy [DONE:n] response tag is also supported.`,
					display: false,
				},
			};
		}
	});

	// --- Track progress during execution ---

	omega.on("turn_end", async (event, ctx) => {
		if (planMode !== "execute" || steps.length === 0) return;
		const toolCompleted = applyTodoCompletionToPlan(ctx, steps);
		const msg = event.message;
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) {
			syncTodosWithPlan(omega, ctx, steps, true);
			if (toolCompleted > 0) {
				updateUI(ctx);
				persistState();
			}
			return;
		}

		const text = (msg.content as Array<{ type: string; text?: string }>)
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n");

		const markerCompleted = markCompletedSteps(text, steps);
		syncTodosWithPlan(omega, ctx, steps, true);
		if (markerCompleted + toolCompleted > 0) {
			updateUI(ctx);
			persistState();
		}
	});

	// --- After agent finishes: extract plan or check completion ---

	omega.on("agent_end", async (event, ctx) => {
		// Check if execution is complete
		if (planMode === "execute" && steps.length > 0) {
			const { allDone } = getCompletionStats(steps);
			if (allDone) {
				const completedList = steps.map((s) => `~~${s.text}~~`).join("\n");
				omega.sendMessage(
					{
						customType: "omega-plan-complete",
						content: `**Plan Complete!** ✓\n\n${completedList}`,
						display: true,
					},
					{ triggerTurn: false },
				);
				planMode = "normal";
				steps = [];
				persistState();
				updateUI(ctx);
			}
			return;
		}

		if (planMode !== "plan" || !ctx.hasUI) return;

		// Extract todos from last assistant message
		const messages = event.messages as Array<{
			role: string;
			content?: unknown;
		}>;
		const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant" && Array.isArray(m.content)) as
			| { role: string; content: Array<{ type: string; text?: string }> }
			| undefined;

		if (lastAssistant) {
			const text = lastAssistant.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n");
			const extracted = extractPlanSteps(text);
			if (extracted.length > 0) {
				steps = extracted;
				replaceTodosFromPlan(omega, ctx, steps);
				persistState();
			}
		}

		// Show plan and prompt for next action
		if (steps.length > 0) {
			const list = steps.map((s) => `${s.step}. ☐ ${s.text}`).join("\n");
			omega.sendMessage(
				{
					customType: "omega-plan-todo-list",
					content: `**Plan Steps (${steps.length}):**\n\n${list}`,
					display: true,
				},
				{ triggerTurn: false },
			);
		}

		const choice = await ctx.ui.select("Plan mode — what next?", [
			steps.length > 0 ? "Execute the plan" : "Execute the plan (no steps detected)",
			"Stay in plan mode",
			"Refine the plan",
		]);

		if (choice?.startsWith("Execute")) {
			planMode = steps.length > 0 ? "execute" : "normal";
			restoreTools();
			if (steps.length > 0) syncTodosWithPlan(omega, ctx, steps, true);
			persistState();
			updateUI(ctx);

			const execMsg =
				steps.length > 0 ? `Execute the plan. Start with: ${steps[0].text}` : "Execute the plan you just created.";
			omega.sendMessage(
				{ customType: "omega-plan-execute", content: execMsg, display: true },
				{ triggerTurn: true },
			);
		} else if (choice === "Refine the plan") {
			const refinement = await ctx.ui.editor("Refine the plan:", "");
			if (refinement?.trim()) {
				omega.sendUserMessage(refinement.trim());
			}
		}
	});

	// --- Restore state on session start/resume ---

	omega.on("session_start", async (_event, ctx) => {
		// --plan flag
		if (omega.getFlag("plan") === true) {
			planMode = "plan";
		}

		// Restore from branch entries (branch-aware)
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && (entry as { customType?: string }).customType === "omega-plan") {
				const data = (entry as { data?: PlanState }).data;
				if (data) {
					planMode = data.mode ?? planMode;
					steps = data.steps ?? steps;
					toolsBeforePlanMode = data.toolsBeforePlanMode;
				}
			}
		}

		// On resume in execute mode: rebuild completion from messages after last execute marker
		if (planMode === "execute" && steps.length > 0) {
			const branch = ctx.sessionManager.getBranch() as Array<{
				type: string;
				customType?: string;
				data?: PlanState;
				message?: { role: string; content?: unknown };
			}>;
			let executeIndex = -1;
			for (let i = branch.length - 1; i >= 0; i--) {
				if (
					branch[i].type === "custom" &&
					branch[i].customType === "omega-plan" &&
					branch[i].data?.mode === "execute"
				) {
					executeIndex = i;
					break;
				}
			}

			const relevantEntries = branch.slice(executeIndex + 1);
			const allText = relevantEntries
				.filter((e) => e.type === "message" && e.message?.role === "assistant" && Array.isArray(e.message?.content))
				.flatMap((e) =>
					(e.message!.content as Array<{ type: string; text?: string }>)
						.filter((c) => c.type === "text")
						.map((c) => c.text!),
				)
				.join("\n");

			markCompletedSteps(allText, steps);
		}

		if (planMode === "plan") {
			activatePlanTools();
		}
		updateUI(ctx);
	});
}

export default registerPlanMode;
