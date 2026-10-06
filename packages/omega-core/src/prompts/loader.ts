import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const PROMPT_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

interface BunEmbeddedPrompt {
	name: string;
	text(): Promise<string>;
}

interface BunPromptRuntime {
	embeddedFiles?: readonly BunEmbeddedPrompt[];
	peek<T>(promise: Promise<T>): T | Promise<T>;
}

/** Load one bundled Markdown prompt by its extensionless name. */
export function loadPrompt(name: string): string {
	if (!PROMPT_NAME_PATTERN.test(name)) throw new Error(`Invalid prompt name: ${name}`);
	const path = fileURLToPath(new URL(`./${name}.md`, import.meta.url));
	try {
		return readFileSync(path, "utf8").trim();
	} catch (error) {
		const bun = (globalThis as typeof globalThis & { Bun?: BunPromptRuntime }).Bun;
		const embedded = bun?.embeddedFiles?.find((file) => {
			const normalizedName = file.name.replaceAll("\\", "/");
			return normalizedName.endsWith(`/prompts/${name}.md`) || normalizedName === `prompts/${name}.md`;
		});
		if (!bun || !embedded) throw error;
		const content = bun.peek(embedded.text());
		if (typeof content !== "string") throw error;
		return content.trim();
	}
}

/** Append a bundled Markdown prompt without discarding the existing prompt. */
export function appendPrompt(basePrompt: string, name: string): string {
	const prompt = loadPrompt(name);
	return basePrompt.trimEnd() ? `${basePrompt.trimEnd()}\n\n${prompt}` : prompt;
}

/** Append multiple prompts in order, de-duplicating names. */
export function appendPrompts(basePrompt: string, names: readonly string[]): string {
	let result = basePrompt;
	for (const name of new Set(names)) result = appendPrompt(result, name);
	return result;
}

export interface ProjectSystemPrompt {
	content: string;
	path: string;
}

/**
 * Load a project-owned system prompt. `.omega/system.md` is canonical; the
 * agent-oriented layouts are also recognized for consistency with Omega config.
 */
export async function loadProjectSystemPrompt(cwd: string): Promise<ProjectSystemPrompt | undefined> {
	const candidates = [
		join(cwd, ".omega", "system.md"),
		join(cwd, ".omega", "agent", "system.md"),
		join(cwd, ".omega", "agent", "prompts", "system.md"),
	];
	for (const path of candidates) {
		try {
			return { content: (await readFile(path, "utf8")).trim(), path };
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
			throw error;
		}
	}
	return undefined;
}

/**
 * Load the `.omega/agent/AGENTS.md` that `omega init` writes.
 *
 * Pi discovers AGENTS.md in the agent directory and in the working directory's
 * ancestors, so a project-local `.omega/agent/AGENTS.md` only reaches the model
 * when the agent directory happens to be that exact path. Return undefined in
 * that case: pi has already injected the file, and appending it again would
 * duplicate every instruction.
 */
export async function loadProjectAgentsFile(
	cwd: string,
	agentDirectory: string = getAgentDir(),
): Promise<ProjectSystemPrompt | undefined> {
	const path = join(cwd, ".omega", "agent", "AGENTS.md");
	if (resolve(path) === resolve(join(agentDirectory, "AGENTS.md"))) return undefined;
	try {
		const content = (await readFile(path, "utf8")).trim();
		return content ? { content, path } : undefined;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
}
