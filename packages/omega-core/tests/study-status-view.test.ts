import { describe, expect, it, vi } from "vitest";
import { StudyStatusTracker, StudyStatusView } from "../src/study/status-view.ts";

describe("StudyStatusView", () => {
	it("renders live AI learning stages and the final knowledge summary", () => {
		const tracker = new StudyStatusTracker();
		tracker.start("分析参数化查询");
		tracker.update("analyzing", "AI is analyzing the material and distilling reusable knowledge (test-model)");
		const requestRender = vi.fn();
		const view = new StudyStatusView(
			tracker,
			{ requestRender } as never,
			{
				fg: (_color: string, text: string) => text,
				bold: (text: string) => text,
			} as never,
			{
				getKeys: () => ["esc"],
				matches: () => false,
			} as never,
			vi.fn(),
		);

		try {
			expect(view.render(80).join("\n")).toContain("AI is studying");
			expect(view.render(80).join("\n")).toContain("AI is analyzing the material");

			tracker.complete({
				title: "参数化查询",
				summary: "使用参数绑定隔离查询结构与数据。",
				filename: "parameterized-query.md",
			});
			const completed = view.render(80).join("\n");
			expect(requestRender).toHaveBeenCalled();
			expect(completed).toContain("Study complete");
			expect(completed).toContain("参数化查询");
			expect(completed).toContain("parameterized-query.md");
		} finally {
			view.dispose();
		}
	});
});
