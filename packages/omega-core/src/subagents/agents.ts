/**
 * Agent discovery and configuration.
 *
 * Agents are Markdown files with YAML frontmatter that define name, description,
 * optional model/tools/session guidance, and a system prompt body.
 *
 * Lookup locations:
 *   - Built-in Omega security agents
 *   - User agents:    ~/.omega/agent/agents/*.md by default
 *   - Project agents: .omega/agents/*.md  (walks up from cwd)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";
export type AgentSource = "builtin" | "user" | "project";
export type SessionPreference = "ephemeral" | "persistent" | "either";
export type SystemPromptMode = "replace" | "append";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	noTools?: boolean;
	model?: string;
	thinking?: string;
	inactivityTimeout?: number;
	sessionPreference?: SessionPreference;
	sessionHint?: string;
	systemPromptMode?: SystemPromptMode;
	systemPrompt: string;
	source: AgentSource;
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

export interface StarterAgentDiscoveryResult {
	discovery: AgentDiscoveryResult;
	createdAgentPath: string | null;
	error?: string;
}

export const STARTER_AGENT_NAME = "explore";
export const STARTER_AGENT_FILE_NAME = "explore.md";

export const MAX_TIMER_SECONDS = Math.floor(2_147_483_647 / 1000);

const STARTER_AGENT_MARKDOWN = `---
name: explore
description: Project exploration and agent design specialist. When no existing built-in or project agent fits the current task, analyzes repository context and creates a reusable project-level agent
tools: read, grep, find, ls, bash, write, edit
thinking: high
sessionPreference: persistent
sessionHint: Use domain-named persistent sessions for the same class of capability gap; after creating an agent, the parent agent uses it in the next subagent call.
systemPromptMode: replace
---

You are the project exploration and agent design specialist. Only when no existing agent clearly matches the task scenario do you create a reusable dedicated agent for the current project.

## Workflow

1. Extract the task domain, deliverable, required tools, permission boundary, and success criteria from the context and prompt passed by the parent agent.
2. Explore the repository read-only; identify the project language, framework, conventions, validation commands, and the concrete files relevant to the domain.
3. Check the available agent list provided by the parent agent first; if an existing agent clearly fits, stop creating and return its exact name and the reason.
4. After confirming a capability gap, create \`.omega/agents/<descriptive-kebab-case-name>.md\` at the nearest project root. Create the directory if it does not exist.
5. Re-read the created file, verify frontmatter and body completeness, then return the exact agent name, path, applicable scenario, and a suggested first prompt.

## Project agent requirements

- The file must contain \`name\`, \`description\`, \`tools\`, \`thinking\`,
  \`sessionPreference\`, and \`systemPromptMode\` frontmatter plus a concrete system prompt body.
- The \`description\` must state the trigger scenario, inputs, and deliverable so the parent agent can route correctly from the description alone.
- Grant only the minimal tool set the task requires; default to read-only for pure analysis and add \`write\` / \`edit\` only when implementation is needed.
- The body should cover responsibilities, project facts, working steps, boundaries, validation, and output format; avoid copying one-off task details.
- The name must not override any existing built-in, user, or project agent; when a name collision is found, choose a new name and never rewrite the existing file.

## Boundaries

- Do not modify any project file except the newly created \`.omega/agents/*.md\`; do not commit code; do not execute the target task itself.
- Do not create agents that serve a single call, duplicate an existing agent, or are described too broadly.
- When the project root cannot be determined reliably, the directory is not writable, or context is insufficient, do not guess; report the blocker.
`;

const BUNDLED_AGENTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "agents");

interface BunEmbeddedFile {
	name: string;
	text(): Promise<string>;
}

interface BunRuntime {
	embeddedFiles?: readonly BunEmbeddedFile[];
	peek<T>(promise: Promise<T>): T | Promise<T>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function parseSessionPreference(raw: unknown, filePath: string): SessionPreference | undefined {
	if (raw === undefined) return undefined;
	if (typeof raw !== "string") {
		console.warn(
			`[omega-subagent] Ignoring invalid sessionPreference field in "${filePath}". Expected "ephemeral", "persistent", or "either".`,
		);
		return undefined;
	}

	const normalized = raw.trim().toLowerCase();
	if (normalized === "ephemeral" || normalized === "persistent" || normalized === "either") {
		return normalized;
	}

	console.warn(
		`[omega-subagent] Ignoring invalid sessionPreference field in "${filePath}". Expected "ephemeral", "persistent", or "either".`,
	);
	return undefined;
}

function parseNoTools(raw: unknown, filePath: string): boolean | undefined {
	if (raw === undefined) return undefined;
	if (typeof raw === "boolean") return raw;
	console.warn(`[omega-subagent] Ignoring invalid noTools field in "${filePath}". Expected true or false.`);
	return undefined;
}

function parsePositiveInteger(raw: unknown, field: string, filePath: string): number | undefined {
	if (raw === undefined) return undefined;
	if (typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0 && raw <= MAX_TIMER_SECONDS) return raw;
	console.warn(
		`[omega-subagent] Ignoring invalid ${field} field in "${filePath}". Expected an integer between 1 and ${MAX_TIMER_SECONDS}.`,
	);
	return undefined;
}

function parseSessionHint(raw: unknown, filePath: string): string | undefined {
	if (raw === undefined) return undefined;
	if (typeof raw !== "string") {
		console.warn(`[omega-subagent] Ignoring invalid sessionHint field in "${filePath}". Expected a string.`);
		return undefined;
	}

	const trimmed = raw.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

export function getUserAgentsDir(): string {
	return path.join(getAgentDir(), "agents");
}

/** Walk up from `cwd` looking for a project-local agents directory. */
function findNearestProjectAgentsDir(cwd: string): string | null {
	let dir = cwd;
	while (true) {
		const candidate = path.join(dir, ".omega", "agents");
		if (isDirectory(candidate)) return candidate;
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/** Parse a single agent markdown file into an AgentConfig. Returns null on skip. */
function parseAgentFile(filePath: string, source: AgentSource, bundledContent?: string): AgentConfig | null {
	let content: string;
	if (bundledContent === undefined) {
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			return null;
		}
	} else {
		content = bundledContent;
	}

	let parsed: { frontmatter: Record<string, unknown>; body: string };
	try {
		parsed = parseFrontmatter<Record<string, unknown>>(content);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.warn(`[omega-subagent] Skipping invalid agent file "${filePath}": ${message}`);
		return null;
	}

	const frontmatter = parsed.frontmatter ?? {};
	const body = parsed.body ?? "";

	const name = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
	const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
	if (!name || !description) return null;

	let tools: string[] | undefined;
	if (typeof frontmatter.tools === "string") {
		const parsedTools = frontmatter.tools
			.split(",")
			.map((t) => t.trim())
			.filter(Boolean);
		if (parsedTools.length > 0) tools = parsedTools;
	} else if (Array.isArray(frontmatter.tools)) {
		const parsedTools = frontmatter.tools
			.filter((t): t is string => typeof t === "string")
			.map((t) => t.trim())
			.filter(Boolean);
		if (parsedTools.length > 0) tools = parsedTools;
	} else if (frontmatter.tools !== undefined) {
		console.warn(
			`[omega-subagent] Ignoring invalid tools field in "${filePath}". Expected a comma-separated string or string array.`,
		);
	}

	const noTools = parseNoTools(frontmatter.noTools, filePath);
	if (noTools === true && tools && tools.length > 0) {
		console.warn(
			`[omega-subagent] Agent file "${filePath}" sets noTools: true and a non-empty tools list. noTools takes precedence.`,
		);
	}

	return {
		name,
		description,
		tools,
		noTools,
		model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
		thinking: typeof frontmatter.thinking === "string" ? frontmatter.thinking : undefined,
		inactivityTimeout: parsePositiveInteger(frontmatter.inactivityTimeout, "inactivityTimeout", filePath),
		sessionPreference: parseSessionPreference(frontmatter.sessionPreference, filePath),
		sessionHint: parseSessionHint(frontmatter.sessionHint, filePath),
		systemPromptMode:
			frontmatter.systemPromptMode === "replace" || frontmatter.systemPromptMode === "append"
				? frontmatter.systemPromptMode
				: "append",
		systemPrompt: body,
		source,
		filePath,
	};
}

/** Load raw assets embedded by `bun build --compile --asset` without async initialization. */
function loadAgentsFromBunExecutable(): AgentConfig[] {
	const bun = (globalThis as typeof globalThis & { Bun?: BunRuntime }).Bun;
	if (!bun?.embeddedFiles) return [];

	const agents: AgentConfig[] = [];
	for (const file of bun.embeddedFiles) {
		const normalizedName = file.name.replaceAll("\\", "/");
		if (!/(?:^|\/)(?:subagents\/)?agents\/[^/]+\.md$/u.test(normalizedName)) continue;
		const content = bun.peek(file.text());
		if (typeof content !== "string") continue;
		const agent = parseAgentFile(file.name, "builtin", content);
		if (agent) agents.push(agent);
	}
	return agents;
}

/** Load all agent definitions from a directory. */
function loadAgentsFromDir(dir: string, source: AgentSource): AgentConfig[] {
	if (!fs.existsSync(dir)) return [];

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	entries.sort((a, b) => a.name.localeCompare(b.name));

	const agents: AgentConfig[] = [];
	for (const entry of entries) {
		const entryPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			agents.push(...loadAgentsFromDir(entryPath, source));
			continue;
		}
		if (!entry.name.endsWith(".md") || (!entry.isFile() && !entry.isSymbolicLink())) continue;

		const agent = parseAgentFile(entryPath, source);
		if (agent) agents.push(agent);
	}
	return agents;
}

function mergeAgents(...groups: AgentConfig[][]): AgentConfig[] {
	const agentMap = new Map<string, AgentConfig>();
	for (const group of groups) {
		for (const agent of group) agentMap.set(agent.name, agent);
	}
	return Array.from(agentMap.values());
}

function getStarterAgentFileName(attempt: number): string {
	if (attempt === 0) return STARTER_AGENT_FILE_NAME;
	if (attempt === 1) return "explore-starter.md";
	return `explore-starter-${attempt}.md`;
}

function isFileExistsError(err: unknown): boolean {
	return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === "EEXIST";
}

function writeStarterAgentFile(filePath: string): void {
	const fd = fs.openSync(filePath, "wx", 0o600);
	try {
		fs.writeFileSync(fd, STARTER_AGENT_MARKDOWN, { encoding: "utf-8" });
	} finally {
		fs.closeSync(fd);
	}
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Discover all available agents according to the requested scope.
 *
 * Precedence is: user < project.
 */
export function discoverAgents(cwd: string, scope: AgentScope, includeProjectAgents = true): AgentDiscoveryResult {
	const userAgentsDir = getUserAgentsDir();
	const projectAgentsDir = includeProjectAgents ? findNearestProjectAgentsDir(cwd) : null;
	const diskBuiltinAgents = loadAgentsFromDir(BUNDLED_AGENTS_DIR, "builtin");
	const builtinAgents = diskBuiltinAgents.length > 0 ? diskBuiltinAgents : loadAgentsFromBunExecutable();

	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userAgentsDir, "user");
	const projectAgents =
		!includeProjectAgents || scope === "user" || !projectAgentsDir
			? []
			: loadAgentsFromDir(projectAgentsDir, "project");

	if (scope === "user") {
		return { agents: mergeAgents(builtinAgents, userAgents), projectAgentsDir };
	}
	if (scope === "project") {
		return { agents: mergeAgents(builtinAgents, projectAgents), projectAgentsDir };
	}
	return {
		agents: mergeAgents(builtinAgents, userAgents, projectAgents),
		projectAgentsDir,
	};
}

/**
 * Discover user/project agents, creating a starter user agent when none exist.
 *
 * This intentionally has no marker file: if a user deletes every agent, the
 * starter will be recreated on the next discovery that needs runnable agents.
 * Existing files are never overwritten.
 */
export function discoverAgentsWithStarter(cwd: string, includeProjectAgents: boolean): StarterAgentDiscoveryResult {
	const initial = discoverAgents(cwd, "both", includeProjectAgents);
	if (initial.agents.some((agent) => agent.source !== "builtin")) {
		return { discovery: initial, createdAgentPath: null };
	}

	const userAgentsDir = getUserAgentsDir();

	try {
		fs.mkdirSync(userAgentsDir, { recursive: true });

		for (let attempt = 0; attempt < 100; attempt++) {
			const latest = attempt === 0 ? initial : discoverAgents(cwd, "both", includeProjectAgents);
			if (latest.agents.some((agent) => agent.source !== "builtin")) {
				return { discovery: latest, createdAgentPath: null };
			}

			const filePath = path.join(userAgentsDir, getStarterAgentFileName(attempt));
			try {
				writeStarterAgentFile(filePath);
				return {
					discovery: discoverAgents(cwd, "both", includeProjectAgents),
					createdAgentPath: filePath,
				};
			} catch (err) {
				if (isFileExistsError(err)) continue;
				throw err;
			}
		}

		return {
			discovery: initial,
			createdAgentPath: null,
			error: `Could not find an unused starter agent filename in ${userAgentsDir}.`,
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			discovery: initial,
			createdAgentPath: null,
			error: `Could not create starter agent in ${userAgentsDir}: ${message}`,
		};
	}
}
