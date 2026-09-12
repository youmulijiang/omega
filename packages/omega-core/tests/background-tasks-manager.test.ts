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

function wheel(delta: number) {
	return {
		type: "wheel" as const,
		button: "none" as const,
		x: 1,
		y: 1,
		screenX: 1,
		screenY: 1,
		width: 100,
		height: 20,
		shift: false,
		alt: false,
		ctrl: false,
		wheelDelta: delta,
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
	it("moves the task selection with the mouse wheel", () => {
		const first = task();
		const second = { ...task(), id: "task-two", name: "second task", startTime: first.startTime - 1 };
		const { manager } = createManager([first, second]);
		try {
			expect(manager.render(100).join("\n")).toContain("›    stream server");
			expect(manager.handleMouse(wheel(3))).toEqual({ handled: true });
			expect(manager.render(100).join("\n")).toContain("›    second task");
		} finally {
			manager.dispose();
		}
	});

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
