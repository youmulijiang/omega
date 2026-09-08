import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatBashCallHighlighted, highlightBashCommand } from "../src/ui/bash-highlight.ts";
import { loadToolboxConfig } from "../src/ui/toolbox-config.ts";
import { stripBackgroundFills } from "../src/ui/toolbox-frame.ts";

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

	it("loads typed settings with defaults for invalid values", () => {
		const directory = mkdtempSync(join(tmpdir(), "omega-toolbox-"));
		const settingsPath = join(directory, "settings.json");
		writeFileSync(settingsPath, JSON.stringify({ toolbox: { enabled: false, highlightBash: "yes" } }));
		expect(loadToolboxConfig(settingsPath)).toEqual({ enabled: false, highlightBash: true, collapseAnchor: true });
	});
});
