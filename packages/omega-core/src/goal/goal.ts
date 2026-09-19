import type { OmegaAPI } from "../api.ts";
import { registerGoalCommand } from "./command-registration.ts";
import { GoalCommandController } from "./commands.ts";
import { registerGoalLifecycle } from "./lifecycle.ts";
import { GoalRunController } from "./run-protocol.ts";
import { GoalRuntime } from "./runtime.ts";
import { type GoalToolsOptions, registerGoalTools } from "./tools.ts";

interface GoalOptions extends GoalToolsOptions {
	settingsPath?: string;
}

function registerGoalRuntime(pi: OmegaAPI, options: GoalOptions = {}) {
	const runtime = new GoalRuntime(pi);
	const commands = new GoalCommandController(runtime);
	const runController = new GoalRunController(runtime, commands);

	// Keep registration order explicit: managed-run bus listeners exist before tools,
	// command routing, and session lifecycle bind the per-factory runtime.
	runController.register(pi);
	registerGoalTools(pi, runtime, { skepticRunner: options.skepticRunner });
	registerGoalCommand(pi, runtime, commands, options);
	registerGoalLifecycle(pi, runtime, runController, options);
}

/** 注册 Omega Goal 模块：会话级单目标自主推进（/goal）。 */
export function registerGoal(omega: OmegaAPI, options: GoalOptions = {}) {
	registerGoalRuntime(omega, options);
}
