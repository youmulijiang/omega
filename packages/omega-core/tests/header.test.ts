import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { expect, it } from "vitest";
import { OmegaHeader } from "../src/ui/header.ts";
import { OMEGA_VERSION } from "../src/version.ts";

it("renders static Omega branding and version within the terminal width", () => {
	const tui = {} as TUI;
	const theme = { fg: (_color: string, value: string) => value } as Theme;
	const header = new OmegaHeader(tui, theme);

	expect(header.render(80).join("\n")).toContain(`omega v${OMEGA_VERSION}`);
	expect(header.render(80).join("\n")).not.toContain("checking");
	expect(header.render(24).every((line) => visibleWidth(line) <= 24)).toBe(true);
});
