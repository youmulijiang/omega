import { afterEach, describe, expect, it, vi } from "vitest";

const { mainMock, omegaExtensionMock } = vi.hoisted(() => ({
	mainMock: vi.fn(),
	omegaExtensionMock: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({ main: mainMock }));
vi.mock("../src/entry.ts", () => ({ default: omegaExtensionMock }));

import { runOmegaCli } from "../src/cli-runner.ts";

const originalTitle = process.title;
const originalPiCodingAgent = process.env.PI_CODING_AGENT;
const originalAiAgent = process.env.AI_AGENT;
const originalEmitWarning = process.emitWarning;

afterEach(() => {
	process.title = originalTitle;
	process.env.PI_CODING_AGENT = originalPiCodingAgent;
	process.env.AI_AGENT = originalAiAgent;
	process.emitWarning = originalEmitWarning;
	vi.clearAllMocks();
});

describe("runOmegaCli", () => {
	it("starts the coding agent with omega-core as a hidden inline extension", async () => {
		await runOmegaCli(["--offline", "--help"]);

		expect(mainMock).toHaveBeenCalledWith(["--offline", "--help"], {
			extensionFactories: [{ name: "omega-core", factory: omegaExtensionMock, hidden: true }],
		});
		expect(process.title).toBe("omega");
		expect(process.env.PI_CODING_AGENT).toBe("true");
		expect(process.env.AI_AGENT).toBe("pi");
	});
});
