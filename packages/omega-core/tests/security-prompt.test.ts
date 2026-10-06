import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	appendPrompt,
	loadProjectAgentsFile,
	loadPrompt,
	registerPrompts,
	selectContextPrompts,
} from "../src/prompts/index.ts";
import { buildSecurityPrompt } from "../src/prompts/security.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("buildSecurityPrompt", () => {
  it("appends the security context after the base prompt", () => {
    const result = buildSecurityPrompt("base prompt");
    expect(result).toContain("base prompt");
		expect(result).toContain("Web Penetration Testing");
  });

  it("keeps the authorization reminder", () => {
    const result = buildSecurityPrompt("");
    expect(result).toContain("authorized");
  });

  it("keeps the report format hint", () => {
    const result = buildSecurityPrompt("");
    expect(result).toContain("/report");
  });

  it("keeps the output-location restriction and task boundary", () => {
    const prompt = loadPrompt("system");
    expect(prompt).toContain(".omega/resource/");
    expect(prompt).toContain(".omega/resource/scripts/");
    expect(prompt).toContain("do not expand the task scope");
  });

	it("loads reusable prompts from Markdown files", () => {
		expect(loadPrompt("system")).toContain("OMEGA Agent");
		expect(loadPrompt("web-testing")).toContain("Web Penetration Testing Guidance");
		expect(loadPrompt("log-analysis")).toContain("Security Log Analysis Guidance");
		expect(loadPrompt("approve-for-me")).toContain("bulk-delete approval");
		expect(appendPrompt("base", "approve-for-me")).toMatch(/^base\n\n# OMEGA permission mode/u);
	});

	it("rejects prompt names that escape the prompts directory", () => {
		expect(() => loadPrompt("../system")).toThrow("Invalid prompt name");
	});

	it("keeps web penetration testing methods and evidence constraints", () => {
		const prompt = loadPrompt("web-testing");
		expect(prompt).toContain("request baseline");
		expect(prompt).toContain("attack surface");
		expect(prompt).toContain("controlled experiments");
		expect(prompt).toContain("IDOR/BOLA");
	});

	it("selects scenario prompts from the current task", () => {
		expect(selectContextPrompts("请对 https://target.test 进行 Web 渗透测试")).toEqual(["web-testing"]);
		expect(selectContextPrompts("分析 nginx access.log 中的异常访问")).toEqual(["log-analysis"]);
		expect(selectContextPrompts("结合网站漏洞和访问日志调查这次入侵")).toEqual(["web-testing", "log-analysis"]);
		expect(selectContextPrompts("帮我开发一个普通 Web 页面")).toEqual([]);
	});

	it("appends only the prompts needed by the current scenario and keeps it across turns", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "omega-prompt-context-"));
		temporaryDirectories.push(cwd);
		const handlers = new Map<string, (...args: never[]) => unknown>();
		const pi = {
			on: (event: string, handler: (...args: never[]) => unknown) => handlers.set(event, handler),
			registerTool: () => undefined,
		} as unknown as ExtensionAPI;
		registerPrompts(pi);
		await handlers.get("session_start")?.({ type: "session_start" } as never, {} as never);

		const first = await handlers.get("before_agent_start")?.(
			{ prompt: "分析这份安全日志中的异常", systemPrompt: "base" } as never,
			{ cwd } as never,
		);
		const continuation = await handlers.get("before_agent_start")?.(
			{ prompt: "继续", systemPrompt: "base" } as never,
			{ cwd } as never,
		);

		expect(first).toEqual({ systemPrompt: expect.stringContaining("Security Log Analysis Guidance") });
		expect((first as { systemPrompt: string }).systemPrompt).not.toContain("Web Penetration Testing Guidance");
		expect(continuation).toEqual({ systemPrompt: expect.stringContaining("Security Log Analysis Guidance") });
	});

	it("a project system.md overrides the Omega built-in and scenario prompts", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "omega-project-prompt-"));
		temporaryDirectories.push(cwd);
		mkdirSync(join(cwd, ".omega"), { recursive: true });
		writeFileSync(join(cwd, ".omega", "system.md"), "# 项目专属系统提示\n\n按项目上下文开展工作。", "utf8");
		const handlers = new Map<string, (...args: never[]) => unknown>();
		const pi = {
			on: (event: string, handler: (...args: never[]) => unknown) => handlers.set(event, handler),
			registerTool: () => undefined,
		} as unknown as ExtensionAPI;
		registerPrompts(pi);

		const result = (await handlers.get("before_agent_start")?.(
			{ prompt: "请对 https://target.test 进行 Web 渗透测试", systemPrompt: "pi base" } as never,
			{ cwd } as never,
		)) as { systemPrompt: string };

		expect(result.systemPrompt).toContain("pi base");
		expect(result.systemPrompt).toContain("项目专属系统提示");
		expect(result.systemPrompt).not.toContain("# OMEGA Agent");
		expect(result.systemPrompt).not.toContain("Web Penetration Testing Guidance");
	});
});

describe("project AGENTS.md", () => {
	const scaffoldAgentsFile = (cwd: string, agentDirectory = join(cwd, ".omega", "agent")): void => {
		mkdirSync(agentDirectory, { recursive: true });
		writeFileSync(join(agentDirectory, "AGENTS.md"), "# 授权边界\n\n本项目仅授权测试 10.0.0.0/24。", "utf8");
	};

	it("injects the .omega/agent/AGENTS.md that omega init writes", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "omega-agents-file-"));
		temporaryDirectories.push(cwd);
		scaffoldAgentsFile(cwd);
		const handlers = new Map<string, (...args: never[]) => unknown>();
		const pi = {
			on: (event: string, handler: (...args: never[]) => unknown) => handlers.set(event, handler),
			registerTool: () => undefined,
		} as unknown as ExtensionAPI;
		registerPrompts(pi);

		const result = (await handlers.get("before_agent_start")?.(
			{ prompt: "介绍一下当前项目", systemPrompt: "pi base" } as never,
			{ cwd } as never,
		)) as { systemPrompt: string };

		expect(result.systemPrompt).toContain("pi base");
		expect(result.systemPrompt).toContain("<project_instructions path=");
		expect(result.systemPrompt).toContain("授权边界");
		expect(result.systemPrompt).toContain("10.0.0.0/24");
	});

	it("also reaches the model when a project system.md overrides the built-in prompt", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "omega-agents-with-system-"));
		temporaryDirectories.push(cwd);
		scaffoldAgentsFile(cwd);
		mkdirSync(join(cwd, ".omega"), { recursive: true });
		writeFileSync(join(cwd, ".omega", "system.md"), "# 项目专属系统提示", "utf8");
		const handlers = new Map<string, (...args: never[]) => unknown>();
		const pi = {
			on: (event: string, handler: (...args: never[]) => unknown) => handlers.set(event, handler),
			registerTool: () => undefined,
		} as unknown as ExtensionAPI;
		registerPrompts(pi);

		const result = (await handlers.get("before_agent_start")?.(
			{ prompt: "介绍一下当前项目", systemPrompt: "pi base" } as never,
			{ cwd } as never,
		)) as { systemPrompt: string };

		expect(result.systemPrompt).toContain("# 项目专属系统提示");
		expect(result.systemPrompt).toContain("授权边界");
		expect(result.systemPrompt).not.toContain("# OMEGA Agent");
	});

	it("skips the file when pi already loads it from the agent directory", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "omega-agents-dedupe-"));
		temporaryDirectories.push(cwd);
		const agentDirectory = join(cwd, ".omega", "agent");
		scaffoldAgentsFile(cwd, agentDirectory);

		// A foreign agent directory is not the project one, so Omega must inject the file.
		expect(await loadProjectAgentsFile(cwd, join(cwd, "elsewhere"))).toEqual(
			expect.objectContaining({ content: expect.stringContaining("授权边界") }),
		);
		// `omega-test.sh` points the agent directory at the project one; pi injects it there.
		expect(await loadProjectAgentsFile(cwd, agentDirectory)).toBeUndefined();
	});

	it("ignores a missing or empty file", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "omega-agents-empty-"));
		temporaryDirectories.push(cwd);
		expect(await loadProjectAgentsFile(cwd, join(cwd, "elsewhere"))).toBeUndefined();

		scaffoldAgentsFile(cwd);
		writeFileSync(join(cwd, ".omega", "agent", "AGENTS.md"), "   \n\n", "utf8");
		expect(await loadProjectAgentsFile(cwd, join(cwd, "elsewhere"))).toBeUndefined();
	});
});
