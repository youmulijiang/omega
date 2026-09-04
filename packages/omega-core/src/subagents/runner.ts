import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentConfig, AgentSource } from "./agents.ts";

const STDERR_LIMIT = 64 * 1024;
export const OMEGA_SUBAGENT_DEPTH_ENV = "OMEGA_SUBAGENT_DEPTH";

export interface SubagentUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface SubagentResult {
	agent: string;
	agentSource: AgentSource | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: SubagentUsage;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
}

export interface DispatchDefaults {
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

export interface RunSingleAgentInput {
	defaultCwd: string;
	dispatchDefaults: DispatchDefaults;
	agents: AgentConfig[];
	agentName: string;
	task: string;
	cwd?: string;
	step?: number;
	signal?: AbortSignal;
	onUpdate?: (result: SubagentResult) => void;
}

function emptyUsage(): SubagentUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function numberValue(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function parseMessageEvent(line: string): Message | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return undefined;
	}
	const event = asRecord(parsed);
	if (event?.type !== "message_end" && event?.type !== "tool_result_end") return undefined;
	const message = asRecord(event.message);
	if (typeof message?.role !== "string" || !Array.isArray(message.content)) return undefined;
	return message as unknown as Message;
}

function updateUsage(result: SubagentResult, message: Message): void {
	if (message.role !== "assistant") return;
	result.usage.turns++;
	const raw = asRecord(message);
	const usage = asRecord(raw?.usage);
	result.usage.input += numberValue(usage?.input);
	result.usage.output += numberValue(usage?.output);
	result.usage.cacheRead += numberValue(usage?.cacheRead);
	result.usage.cacheWrite += numberValue(usage?.cacheWrite);
	result.usage.contextTokens = numberValue(usage?.totalTokens);
	result.usage.cost += numberValue(asRecord(usage?.cost)?.total);
	if (!result.model && typeof raw?.model === "string") result.model = raw.model;
	if (typeof raw?.stopReason === "string") result.stopReason = raw.stopReason;
	if (typeof raw?.errorMessage === "string") result.errorMessage = raw.errorMessage;
}

function boundedAppend(current: string, addition: string): string {
	if (Buffer.byteLength(current, "utf8") >= STDERR_LIMIT) return current;
	const combined = current + addition;
	if (Buffer.byteLength(combined, "utf8") <= STDERR_LIMIT) return combined;
	return Buffer.from(combined, "utf8").subarray(0, STDERR_LIMIT).toString("utf8");
}

async function writeSystemPrompt(agent: AgentConfig): Promise<{ dir: string; filePath: string }> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omega-subagent-"));
	const safeName = agent.name.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(dir, `prompt-${safeName}.md`);
	await fs.promises.writeFile(filePath, agent.systemPrompt, { encoding: "utf-8", mode: 0o600 });
	return { dir, filePath };
}

export function buildChildArgs(
	agent: AgentConfig,
	task: string,
	dispatchDefaults: DispatchDefaults,
	systemPromptPath: string,
): string[] {
	const args = [
		"--mode",
		"json",
		"--print",
		"--no-session",
		"--no-context-files",
		"--no-skills",
		"--no-prompt-templates",
	];
	const model = agent.model ?? dispatchDefaults.model;
	if (model) args.push("--model", model);
	const thinking = agent.thinking ?? (agent.model ? undefined : dispatchDefaults.thinkingLevel);
	if (thinking) args.push("--thinking", thinking);
	if (agent.tools !== undefined) {
		if (agent.tools.length === 0) args.push("--no-tools");
		else args.push("--tools", agent.tools.join(","));
	}
	args.push(agent.systemPromptMode === "append" ? "--append-system-prompt" : "--system-prompt", systemPromptPath);
	args.push(`Task: ${task}`);
	return args;
}

function getOmegaInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const executable = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(executable)) return { command: process.execPath, args };
	return { command: "omega", args };
}

export function getFinalOutput(messages: Message[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "assistant") continue;
		for (const part of message.content) if (part.type === "text") return part.text;
	}
	return "";
}

export function isFailedResult(result: SubagentResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

export function getResultOutput(result: SubagentResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
}

export async function runSingleAgent(input: RunSingleAgentInput): Promise<SubagentResult> {
	const agent = input.agents.find((candidate) => candidate.name === input.agentName);
	if (!agent) {
		const available = input.agents.map((candidate) => candidate.name).join(", ") || "none";
		return {
			agent: input.agentName,
			agentSource: "unknown",
			task: input.task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${input.agentName}". Available agents: ${available}.`,
			usage: emptyUsage(),
			step: input.step,
		};
	}

	const result: SubagentResult = {
		agent: agent.name,
		agentSource: agent.source,
		task: input.task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: emptyUsage(),
		model: agent.model ?? input.dispatchDefaults.model,
		step: input.step,
	};
	const prompt = await writeSystemPrompt(agent);
	try {
		const args = buildChildArgs(agent, input.task, input.dispatchDefaults, prompt.filePath);
		const invocation = getOmegaInvocation(args);
		let aborted = false;
		result.exitCode = await new Promise<number>((resolve) => {
			const child = spawn(invocation.command, invocation.args, {
				cwd: input.cwd ?? input.defaultCwd,
				env: { ...process.env, [OMEGA_SUBAGENT_DEPTH_ENV]: "1" },
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let buffer = "";
			let settled = false;
			let killTimer: ReturnType<typeof setTimeout> | undefined;
			const settle = (code: number): void => {
				if (settled) return;
				settled = true;
				if (killTimer) clearTimeout(killTimer);
				input.signal?.removeEventListener("abort", abortChild);
				resolve(code);
			};
			const processLine = (line: string): void => {
				if (!line.trim()) return;
				const message = parseMessageEvent(line);
				if (!message) return;
				result.messages.push(message);
				updateUsage(result, message);
				input.onUpdate?.(result);
			};
			const abortChild = (): void => {
				aborted = true;
				child.kill("SIGTERM");
				killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
			};
			child.stdout.on("data", (data: Buffer) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) processLine(line);
			});
			child.stderr.on("data", (data: Buffer) => {
				result.stderr = boundedAppend(result.stderr, data.toString());
			});
			child.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				settle(code ?? (aborted ? 1 : 0));
			});
			child.on("error", (error) => {
				result.stderr = boundedAppend(result.stderr, error.message);
				settle(1);
			});
			if (input.signal?.aborted) abortChild();
			else input.signal?.addEventListener("abort", abortChild, { once: true });
		});
		if (aborted) {
			result.stopReason = "aborted";
			result.errorMessage = "Subagent was aborted";
		}
		return result;
	} finally {
		await fs.promises.rm(prompt.dir, { recursive: true, force: true });
	}
}

export async function mapWithConcurrencyLimit<TInput, TOutput>(
	items: TInput[],
	concurrency: number,
	run: (item: TInput, index: number) => Promise<TOutput>,
): Promise<TOutput[]> {
	if (items.length === 0) return [];
	const results = new Array<TOutput>(items.length);
	let nextIndex = 0;
	const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
		while (true) {
			const index = nextIndex++;
			if (index >= items.length) return;
			results[index] = await run(items[index], index);
		}
	});
	await Promise.all(workers);
	return results;
}
