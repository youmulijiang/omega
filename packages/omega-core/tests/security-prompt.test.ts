import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendPrompt, loadPrompt, registerPrompts, selectContextPrompts } from "../src/prompts/index.ts";
import { buildSecurityPrompt } from "../src/prompts/security.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("buildSecurityPrompt", () => {
  it("在基础 prompt 之后追加安全语境", () => {
    const result = buildSecurityPrompt("base prompt");
    expect(result).toContain("base prompt");
		expect(result).toContain("Web 渗透测试");
  });

  it("包含合规提醒", () => {
    const result = buildSecurityPrompt("");
    expect(result).toContain("授权");
  });

  it("包含报告格式说明", () => {
    const result = buildSecurityPrompt("");
    expect(result).toContain("/report");
  });

	it("从 Markdown 文件加载可复用提示词", () => {
		expect(loadPrompt("system")).toContain("OMEGA Agent");
		expect(loadPrompt("web-testing")).toContain("Web 渗透测试引导");
		expect(loadPrompt("log-analysis")).toContain("安全日志分析引导");
		expect(loadPrompt("approve-for-me")).toContain("批量删除审批不可绕过");
		expect(appendPrompt("base", "approve-for-me")).toMatch(/^base\n\n# OMEGA 权限模式/u);
	});

	it("拒绝通过提示词名称访问模块外文件", () => {
		expect(() => loadPrompt("../system")).toThrow("Invalid prompt name");
	});

	it("包含 Web 渗透测试方法和证据约束", () => {
		const prompt = loadPrompt("web-testing");
		expect(prompt).toContain("请求基线");
		expect(prompt).toContain("攻击面");
		expect(prompt).toContain("对照实验");
		expect(prompt).toContain("IDOR/BOLA");
	});

	it("根据当前任务选择场景提示词", () => {
		expect(selectContextPrompts("请对 https://target.test 进行 Web 渗透测试")).toEqual(["web-testing"]);
		expect(selectContextPrompts("分析 nginx access.log 中的异常访问")).toEqual(["log-analysis"]);
		expect(selectContextPrompts("结合网站漏洞和访问日志调查这次入侵")).toEqual(["web-testing", "log-analysis"]);
		expect(selectContextPrompts("帮我开发一个普通 Web 页面")).toEqual([]);
	});

	it("只追加当前场景所需的提示词并在后续轮次保持场景", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "omega-prompt-context-"));
		temporaryDirectories.push(cwd);
		const handlers = new Map<string, (...args: never[]) => unknown>();
		const pi = { on: (event: string, handler: (...args: never[]) => unknown) => handlers.set(event, handler) } as unknown as ExtensionAPI;
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

		expect(first).toEqual({ systemPrompt: expect.stringContaining("安全日志分析引导") });
		expect((first as { systemPrompt: string }).systemPrompt).not.toContain("Web 渗透测试引导");
		expect(continuation).toEqual({ systemPrompt: expect.stringContaining("安全日志分析引导") });
	});

	it("项目 system.md 覆盖 Omega 内置与场景提示词", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "omega-project-prompt-"));
		temporaryDirectories.push(cwd);
		mkdirSync(join(cwd, ".omega"), { recursive: true });
		writeFileSync(join(cwd, ".omega", "system.md"), "# 项目专属系统提示\n\n按项目上下文开展工作。", "utf8");
		const handlers = new Map<string, (...args: never[]) => unknown>();
		const pi = {
			on: (event: string, handler: (...args: never[]) => unknown) => handlers.set(event, handler),
		} as unknown as ExtensionAPI;
		registerPrompts(pi);

		const result = (await handlers.get("before_agent_start")?.(
			{ prompt: "请对 https://target.test 进行 Web 渗透测试", systemPrompt: "pi base" } as never,
			{ cwd } as never,
		)) as { systemPrompt: string };

		expect(result.systemPrompt).toContain("pi base");
		expect(result.systemPrompt).toContain("项目专属系统提示");
		expect(result.systemPrompt).not.toContain("# OMEGA Agent");
		expect(result.systemPrompt).not.toContain("Web 渗透测试引导");
	});
});
