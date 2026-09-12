import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import { formatBashCallHighlighted, highlightBashCommand } from "../src/ui/bash-highlight.ts";
import { loadToolboxConfig } from "../src/ui/toolbox-config.ts";
import { collapseToolboxContent, patchToolBoxFrames, stripBackgroundFills } from "../src/ui/toolbox-frame.ts";
import type { ToolboxTheme } from "../src/ui/toolbox-theme.ts";

const plainTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} satisfies ToolboxTheme;

beforeAll(() => {
	initTheme("dark", false);
	patchToolBoxFrames();
});

function click(width: number, height: number, x: number, y: number): TuiMouseEvent {
	return {
		type: "click",
		button: "left",
		x,
		y,
		screenX: x,
		screenY: y,
		width,
		height,
		shift: false,
		alt: false,
		ctrl: false,
		clickCount: 1,
	};
}

describe("toolbox UI", () => {
	it("highlights command positions, flags, variables, strings, and operators", () => {
		const rendered = highlightBashCommand('FOO=bar rg --glob="*.ts" "$FOO" | wc -l', (token, text) => `<${token}>${text}</${token}>`);
		expect(rendered).toContain("<syntaxVariable>FOO</syntaxVariable>");
		expect(rendered).toContain("<syntaxFunction>rg</syntaxFunction>");
		expect(rendered).toContain("<syntaxType>--glob</syntaxType>");
		expect(rendered).toContain("<syntaxOperator>|</syntaxOperator>");
		expect(rendered).toContain("<syntaxFunction>wc</syntaxFunction>");
	});

	it("preserves a hash embedded in an argument", () => {
		expect(highlightBashCommand("echo value#fragment", (_token, text) => text)).toBe("echo value#fragment");
	});

	it("formats the bash prompt and timeout", () => {
		const theme = { fg: (color: string, text: string) => `[${color}:${text}]`, bold: (text: string) => `*${text}*` };
		expect(formatBashCallHighlighted({ command: "echo ok", timeout: 5 }, theme)).toContain("[muted: (timeout 5s)]");
	});

	it("removes background fills but keeps foreground and reset sequences", () => {
		expect(stripBackgroundFills("\u001b[48;2;1;2;3mA\u001b[42mB\u001b[31mC\u001b[49m")).toBe(
			"AB\u001b[31mC\u001b[49m",
		);
	});

	it("keeps five lines by default and reports the hidden line count", () => {
		const lines = ["one", "two", "three", "four", "five", "six", "seven"];
		expect(collapseToolboxContent(lines, false, plainTheme)).toEqual([
			"one",
			"two",
			"three",
			"four",
			"five",
			expect.stringContaining("2 more lines"),
		]);
	});

	it("shows all toolbox content when expanded", () => {
		const lines = ["one", "two", "three", "four", "five", "six"];
		expect(collapseToolboxContent(lines, true, plainTheme)).toBe(lines);
	});

	it("expands and collapses toolbox content when its body is clicked", () => {
		const component = new ToolExecutionComponent(
			"demo",
			"toolbox-click",
			{},
			{},
			undefined,
			{ requestRender: () => undefined } as never,
			process.cwd(),
		);
		component.updateResult(
			{
				content: [{ type: "text", text: "one\ntwo\nthree\nfour\nfive\nsix\nseven" }],
				isError: false,
			},
			false,
		);

		const width = 80;
		let lines = component.render(width);
		expect(lines.join("\n")).not.toContain("seven");
		expect(component.handleMouse(click(width, lines.length, 2, 2))).toEqual({ handled: true });

		lines = component.render(width);
		expect(lines.join("\n")).toContain("seven");
		expect(component.handleMouse(click(width, lines.length, 2, 2))).toEqual({ handled: true });
		expect(component.render(width).join("\n")).not.toContain("seven");
	});

	it("does not expand when the toolbox border is clicked", () => {
		const component = new ToolExecutionComponent(
			"demo",
			"toolbox-border-click",
			{},
			{},
			undefined,
			{ requestRender: () => undefined } as never,
			process.cwd(),
		);
		component.updateResult(
			{
				content: [{ type: "text", text: "one\ntwo\nthree\nfour\nfive\nsix\nseven" }],
				isError: false,
			},
			false,
		);
		const width = 80;
		const lines = component.render(width);
		expect(component.handleMouse(click(width, lines.length, 2, 1))).toBeUndefined();
		expect(component.render(width).join("\n")).not.toContain("seven");
	});

	it("loads typed settings with defaults for invalid values", () => {
		const directory = mkdtempSync(join(tmpdir(), "omega-toolbox-"));
		const settingsPath = join(directory, "settings.json");
		writeFileSync(settingsPath, JSON.stringify({ toolbox: { enabled: false, highlightBash: "yes" } }));
		expect(loadToolboxConfig(settingsPath)).toEqual({ enabled: false, highlightBash: true, collapseAnchor: true });
	});
});
