import { describe, expect, it, vi } from "vitest";
import {
	type BackgroundTaskForUi,
	BackgroundTasksManager,
} from "../src/background/ui/background-tasks-manager.ts";

function task(status: BackgroundTaskForUi["status"] = "running"): BackgroundTaskForUi {
	return {
		id: "task-one",
		name: "stream server",
		command: "run-server",
		status,
		outputPath: ".omega/tasks/task-one/output.log",
		outputAbsPath: "D:/tmp/task-one/output.log",
		cwd: "D:/tmp",
		startTime: Date.now(),
		bytesWritten: 0,
		isAgent: false,
		notified: false,
		notifyOnCompletion: true,
		triggerOnCompletion: false,
	};
}

function createManager(tasks: BackgroundTaskForUi[]) {
	let displayedTaskId: string | undefined;
	const setDisplayedTask = vi.fn((selected: BackgroundTaskForUi | undefined) => {
		displayedTaskId = selected?.id;
	});
	const manager = new BackgroundTasksManager(
		{ requestRender: vi.fn() },
		{ fg: (_color, text) => text },
		vi.fn(),
		{
			getTasks: () => tasks,
			stopTask: vi.fn(),
			stopAllRunning: vi.fn(async () => ({ stopped: 0, failures: [] })),
			rerunTask: vi.fn(),
			showOutputPath: vi.fn(),
			setDisplayedTask,
			isDisplayed: (taskId) => displayedTaskId === taskId,
			markSeen: vi.fn(),
			markFinishedSeen: vi.fn(),
			isSeen: () => true,
		},
	);
	return { manager, setDisplayedTask };
}

describe("BackgroundTasksManager output selection", () => {
	it("toggles the selected running task output", () => {
		const running = task();
		const { manager, setDisplayedTask } = createManager([running]);
		try {
			manager.handleInput("s");
			expect(setDisplayedTask).toHaveBeenLastCalledWith(running);
			expect(manager.render(100).join("\n")).toContain("◆");

			manager.handleInput("s");
			expect(setDisplayedTask).toHaveBeenLastCalledWith(undefined);
		} finally {
			manager.dispose();
		}
	});

	it("does not display output from a finished task", () => {
		const { manager, setDisplayedTask } = createManager([task("completed")]);
		try {
			manager.handleInput("s");
			expect(setDisplayedTask).not.toHaveBeenCalled();
			expect(manager.render(100).join("\n")).toContain("only running output can be shown");
		} finally {
			manager.dispose();
		}
	});
});
