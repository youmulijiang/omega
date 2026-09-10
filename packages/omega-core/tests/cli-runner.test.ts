import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { mainMock, omegaExtensionMock } = vi.hoisted(() => ({
	mainMock: vi.fn(),
	omegaExtensionMock: vi.fn(),
}));

const { initializeKnowledgeDirectoryMock } = vi.hoisted(() => ({
	initializeKnowledgeDirectoryMock: vi.fn(async () => "knowledge"),
}));

const { initializeUserWorkflowsDirectoryMock } = vi.hoisted(() => ({
	initializeUserWorkflowsDirectoryMock: vi.fn(() => "workflows"),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({ main: mainMock }));
vi.mock("../src/entry.ts", () => ({ default: omegaExtensionMock }));
vi.mock("../src/knowledge/index.ts", () => ({ initializeKnowledgeDirectory: initializeKnowledgeDirectoryMock }));
vi.mock("../src/workflows/registry.ts", () => ({
	initializeUserWorkflowsDirectory: initializeUserWorkflowsDirectoryMock,
}));

import { isOmegaCompatibleExtension, runOmegaCli } from "../src/cli-runner.ts";

const originalTitle = process.title;
const originalPiCodingAgent = process.env.PI_CODING_AGENT;
const originalAiAgent = process.env.AI_AGENT;
const originalEmitWarning = process.emitWarning;
const originalCwd = process.cwd();
const temporaryDirectories: string[] = [];

afterEach(() => {
	process.title = originalTitle;
	process.env.PI_CODING_AGENT = originalPiCodingAgent;
	process.env.AI_AGENT = originalAiAgent;
	process.emitWarning = originalEmitWarning;
	process.chdir(originalCwd);
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
	vi.restoreAllMocks();
	vi.clearAllMocks();
});

describe("runOmegaCli", () => {
	it("starts the coding agent with omega-core as a hidden inline extension", async () => {
		await runOmegaCli(["--offline", "--help"]);

		expect(mainMock).toHaveBeenCalledWith(["--offline", "--help"], {
			extensionFactories: [{ name: "omega-core", factory: omegaExtensionMock, hidden: true }],
			extensionFilter: isOmegaCompatibleExtension,
		});
		expect(process.title).toBe("omega");
		expect(process.env.PI_CODING_AGENT).toBe("true");
		expect(process.env.AI_AGENT).toBe("pi");
		expect(initializeKnowledgeDirectoryMock).toHaveBeenCalledOnce();
		expect(initializeUserWorkflowsDirectoryMock).toHaveBeenCalledOnce();
	});

	it("filters external extensions whose capabilities are built into Omega", () => {
		expect(
			isOmegaCompatibleExtension({
				path: "toolbox",
				resolvedPath: "C:\\Users\\test\\.omega\\agent\\npm\\node_modules\\@andy8647\\pi-toolbox\\index.ts",
			}),
		).toBe(false);
		expect(
			isOmegaCompatibleExtension({
				path: "dynamic-workflows",
				resolvedPath:
					"C:\\Users\\test\\.omega\\agent\\npm\\node_modules\\@quintinshaw\\pi-dynamic-workflows\\dist\\pi-extension.js",
			}),
		).toBe(false);
		expect(
			isOmegaCompatibleExtension({
				path: "dynamic-workflows",
				resolvedPath:
					"/home/test/.omega/agent/npm/node_modules/@quintinshaw/pi-dynamic-workflows/dist/pi-extension.js",
			}),
		).toBe(false);
		expect(
			isOmegaCompatibleExtension({
				path: "other",
				resolvedPath: "/home/test/.omega/agent/npm/node_modules/example-extension/index.ts",
			}),
		).toBe(true);
	});

	it("initializes the current project without starting the coding agent", async () => {
		const workspace = mkdtempSync(join(tmpdir(), "omega-cli-init-"));
		temporaryDirectories.push(workspace);
		process.chdir(workspace);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		await runOmegaCli(["init"]);

		expect(readFileSync(join(workspace, ".omega", "agent", "scope.md"), "utf8")).toContain("# scope.md");
		expect(log).toHaveBeenCalledWith(expect.stringContaining("Omega 工作目录已初始化"));
		expect(mainMock).not.toHaveBeenCalled();
	});
});
