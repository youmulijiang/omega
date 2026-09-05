import { describe, expect, it } from "vitest";
import { diffText, formatTextDiff } from "../src/tools/diff.ts";

describe("diffText", () => {
	it("handles empty and identical texts", () => {
		expect(diffText("", "")).toEqual({ equal: true, addedLines: 0, removedLines: 0, coarse: false, changes: [] });
		expect(diffText("same\n", "same\n")).toMatchObject({ equal: true, addedLines: 0, removedLines: 0 });
	});
	it("reports insertions, removals, replacements and line positions", () => {
		const result = diffText("first\nold\nlast\n", "first\nnew\nextra\nlast\n");
		expect(result).toMatchObject({ equal: false, addedLines: 2, removedLines: 1, coarse: false });
		expect(result.changes).toEqual([
			{ type: "equal", text: "first\n", oldLine: 1, newLine: 1, lineCount: 1 },
			{ type: "removed", text: "old\n", oldLine: 2, newLine: 2, lineCount: 1 },
			{ type: "added", text: "new\nextra\n", oldLine: 3, newLine: 2, lineCount: 2 },
			{ type: "equal", text: "last\n", oldLine: 3, newLine: 4, lineCount: 1 },
		]);
	});
	it("preserves Unicode, blank lines, CRLF and final newline differences", () => {
		for (const [before, after] of [["你好\r\n\r\n", "你好\n\n"], ["last", "last\n"], ["", "\n"], ["a\nb\na\n", "b\na\nb\n"], ["all\n", ""]]) {
			const result = diffText(before, after);
			expect(result.equal).toBe(false);
			expect(result.changes.filter((change) => change.type !== "added").map((change) => change.text).join("")).toBe(before);
			expect(result.changes.filter((change) => change.type !== "removed").map((change) => change.text).join("")).toBe(after);
		}
	});
	it("bounds work for large changes while preserving both inputs", () => {
		const before = "prefix\n" + "old\n".repeat(2100) + "suffix\n";
		const after = "prefix\n" + "new\n".repeat(2100) + "suffix\n";
		const result = diffText(before, after);
		expect(result.coarse).toBe(true);
		expect(result.changes.filter((change) => change.type !== "added").map((change) => change.text).join("")).toBe(before);
		expect(result.changes.filter((change) => change.type !== "removed").map((change) => change.text).join("")).toBe(after);
	});
	it("rejects oversized inputs", () => {
		expect(() => diffText("x".repeat(1_048_577), "")).toThrow("1 MiB");
	});
	it("shows changed lines even after a large unchanged prefix", () => {
		const prefix = "unchanged\n".repeat(4000);
		const text = formatTextDiff(diffText(`${prefix}old`, `${prefix}new\r\n`));
		expect(text).toContain("-old\n\\ No newline at end of file");
		expect(text).toContain("+new\\r");
		expect(text).not.toContain("unchanged");
		expect(formatTextDiff(diffText("same", "same"))).toBe("Texts are identical.");
	});
});
