import { Container } from "@earendil-works/pi-tui";
import { afterEach, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

afterEach(() => vi.unstubAllEnvs());

it("does not show the automatic changelog on Omega TUI startup", () => {
	vi.stubEnv("OMEGA_VERSION", "0.1.0");
	const chatContainer = new Container();
	const mode = {
		startupNoticesShown: false,
		changelogMarkdown: "## [0.1.0] Release notes",
		chatContainer,
	} as unknown as InteractiveMode;
	const showStartupNoticesIfNeeded = (
		InteractiveMode.prototype as unknown as { showStartupNoticesIfNeeded(this: InteractiveMode): void }
	).showStartupNoticesIfNeeded;

	showStartupNoticesIfNeeded.call(mode);
	expect(chatContainer.children).toHaveLength(0);
	expect((mode as unknown as { startupNoticesShown: boolean }).startupNoticesShown).toBe(true);
});
