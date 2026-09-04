/**
 * Scenario-agent discovery for Omega subagents.
 *
 * Agent definitions are Markdown files with YAML frontmatter. The Markdown body
 * becomes the child process system prompt. Definitions are loaded in increasing
 * priority: builtins, user scope, then the nearest project scope.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

export const OMEGA_CONFIG_DIR = ".omega";
export const OMEGA_AGENTS_SUBDIR = "agents";

export type AgentScope = "user" | "project" | "both";
export type AgentSource = "builtin" | "user" | "project";
export type SystemPromptMode = "replace" | "append";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	systemPromptMode: SystemPromptMode;
	systemPrompt: string;
	source: AgentSource;
	filePath: string;
}

export interface AgentDiscoveryDiagnostic {
	filePath: string;
	message: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	diagnostics: AgentDiscoveryDiagnostic[];
	projectAgentsDir: string | null;
}

type AgentFrontmatter = {
	name?: unknown;
	description?: unknown;
	tools?: unknown;
	model?: unknown;
	thinking?: unknown;
	systemPromptMode?: unknown;
};

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

const BUILTIN_AGENTS: AgentConfig[] = [
	{
		name: "scout",
		description: "快速定位相关文件、入口、数据流和风险，不修改文件",
		tools: ["read", "grep", "find", "ls"],
		thinking: "low",
		systemPromptMode: "replace",
		systemPrompt:
			"你是代码侦察子智能体。只做事实核查和代码定位，不修改文件。输出相关文件、入口、关键调用链、风险点，以及主智能体下一步应从哪里开始。结论必须附带具体文件路径。",
		source: "builtin",
		filePath: "builtin:scout",
	},
	{
		name: "reviewer",
		description: "审查实现、边界条件、安全风险和验证缺口，不修改文件",
		tools: ["read", "grep", "find", "ls"],
		thinking: "high",
		systemPromptMode: "replace",
		systemPrompt:
			"你是独立代码审查子智能体。核对实现是否满足任务，重点寻找正确性、安全性、并发、错误处理、回归和测试缺口。不要修改文件。按严重程度输出可复现的问题；没有问题时明确说明剩余风险。",
		source: "builtin",
		filePath: "builtin:reviewer",
	},
	{
		name: "worker",
		description: "在明确任务边界内实现代码并运行必要验证",
		tools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
		thinking: "medium",
		systemPromptMode: "replace",
		systemPrompt:
			"你是实现子智能体。严格在给定任务范围内修改代码，先阅读相关实现，再完成最小且完整的改动并运行针对性验证。保留无关改动；遇到会改变功能范围的决策时停止并报告，不要自行扩张任务。",
		source: "builtin",
		filePath: "builtin:worker",
	},
	{
		name: "oracle",
		description: "对方案和假设给出独立第二意见，不修改文件",
		tools: ["read", "grep", "find", "ls"],
		thinking: "high",
		systemPromptMode: "replace",
		systemPrompt:
			"你是只读决策顾问。挑战任务中的假设，识别遗漏、隐含代价和更安全的替代方案。不要修改文件。先给结论，再给支持证据和建议的下一步。",
		source: "builtin",
		filePath: "builtin:oracle",
	},
];

function parseToolList(value: unknown): string[] | undefined {
	if (value === undefined || value === null) return undefined;
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	return raw
		.filter((tool): tool is string => typeof tool === "string")
		.map((tool) => tool.trim())
		.filter(Boolean);
}

function parseAgentFile(filePath: string, source: Exclude<AgentSource, "builtin">): AgentConfig {
	const content = fs.readFileSync(filePath, "utf-8");
	const { frontmatter, body } = parseFrontmatter<AgentFrontmatter>(content);
	if (typeof frontmatter.name !== "string" || !frontmatter.name.trim()) {
		throw new Error("frontmatter.name must be a non-empty string");
	}
	if (typeof frontmatter.description !== "string" || !frontmatter.description.trim()) {
		throw new Error("frontmatter.description must be a non-empty string");
	}
	if (!body.trim()) throw new Error("the Markdown body must contain a system prompt");

	const systemPromptMode = frontmatter.systemPromptMode ?? "replace";
	if (systemPromptMode !== "replace" && systemPromptMode !== "append") {
		throw new Error('frontmatter.systemPromptMode must be "replace" or "append"');
	}

	const thinking = frontmatter.thinking;
	if (thinking !== undefined && (typeof thinking !== "string" || !THINKING_LEVELS.has(thinking))) {
		throw new Error("frontmatter.thinking is invalid");
	}

	return {
		name: frontmatter.name.trim(),
		description: frontmatter.description.trim(),
		tools: parseToolList(frontmatter.tools),
		model: typeof frontmatter.model === "string" && frontmatter.model.trim() ? frontmatter.model.trim() : undefined,
		thinking: thinking as AgentConfig["thinking"],
		systemPromptMode,
		systemPrompt: body.trim(),
		source,
		filePath,
	};
}

function isDirectory(candidate: string): boolean {
	try {
		return fs.statSync(candidate).isDirectory();
	} catch {
		return false;
	}
}

function collectMarkdownFiles(dir: string): string[] {
	if (!isDirectory(dir)) return [];
	const files: string[] = [];
	const visit = (current: string): void => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(current, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
			const entryPath = path.join(current, entry.name);
			if (entry.isDirectory()) visit(entryPath);
			else if ((entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".md")) files.push(entryPath);
		}
	};
	visit(dir);
	return files;
}

function loadAgentsFromDir(
	dir: string,
	source: Exclude<AgentSource, "builtin">,
): { agents: AgentConfig[]; diagnostics: AgentDiscoveryDiagnostic[] } {
	const agents: AgentConfig[] = [];
	const diagnostics: AgentDiscoveryDiagnostic[] = [];
	for (const filePath of collectMarkdownFiles(dir)) {
		try {
			agents.push(parseAgentFile(filePath, source));
		} catch (error) {
			diagnostics.push({ filePath, message: error instanceof Error ? error.message : String(error) });
		}
	}
	return { agents, diagnostics };
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let current = path.resolve(cwd);
	while (true) {
		const candidate = path.join(current, OMEGA_CONFIG_DIR, OMEGA_AGENTS_SUBDIR);
		if (isDirectory(candidate)) return candidate;
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

export function getUserAgentsDir(): string {
	return path.join(os.homedir(), OMEGA_CONFIG_DIR, OMEGA_AGENTS_SUBDIR);
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);
	const userLoaded =
		scope === "project" ? { agents: [], diagnostics: [] } : loadAgentsFromDir(getUserAgentsDir(), "user");
	const projectLoaded =
		scope === "user" || !projectAgentsDir
			? { agents: [], diagnostics: [] }
			: loadAgentsFromDir(projectAgentsDir, "project");

	const agentMap = new Map<string, AgentConfig>();
	for (const agent of BUILTIN_AGENTS) agentMap.set(agent.name, agent);
	for (const agent of userLoaded.agents) agentMap.set(agent.name, agent);
	for (const agent of projectLoaded.agents) agentMap.set(agent.name, agent);

	return {
		agents: Array.from(agentMap.values()),
		diagnostics: [...userLoaded.diagnostics, ...projectLoaded.diagnostics],
		projectAgentsDir,
	};
}

export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	return {
		text: listed.map((agent) => `${agent.name} (${agent.source}): ${agent.description}`).join("; "),
		remaining: agents.length - listed.length,
	};
}
