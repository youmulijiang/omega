import type { WorkflowTaskExecutor } from "./types.ts";

const workflowTaskExecutors = new Map<string, WorkflowTaskExecutor>();

function assertExecutorName(name: string): void {
	if (!/^[a-z][a-z0-9_-]{1,63}$/.test(name)) {
		throw new Error(`Invalid workflow task executor name "${name}". Use 2-64 lowercase letters, digits, _ or -.`);
	}
}

/**
 * Registers a host-provided task primitive for the workflow DSL.
 *
 * Task executors run in the Omega host process, so callers should expose narrow,
 * permission-aware operations instead of accepting arbitrary commands.
 */
export function registerWorkflowTaskExecutor(executor: WorkflowTaskExecutor): () => void {
	assertExecutorName(executor.name);
	if (workflowTaskExecutors.has(executor.name)) {
		throw new Error(`Workflow task executor "${executor.name}" is already registered.`);
	}
	workflowTaskExecutors.set(executor.name, executor);
	return () => {
		if (workflowTaskExecutors.get(executor.name) === executor) workflowTaskExecutors.delete(executor.name);
	};
}

export function getWorkflowTaskExecutors(): readonly WorkflowTaskExecutor[] {
	return [...workflowTaskExecutors.values()];
}
