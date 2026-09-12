/**
 * Subagent process runner.
 *
 * Spawns isolated Omega processes and streams results back via callbacks.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { DEFAULT_MAX_BYTES, truncateTail } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import type { AgentConfig } from "./agents.ts";
import { SUBAGENT_STRUCTURED_OUTPUT_SCHEMA_ENV, WORKFLOW_STACK_ENV } from "./protocol.ts";
import { getInheritedProjectTrustArgs, parseInheritedCliArgs, selectInheritedPiArgv } from "./runner-cli.js";
import { processPiJsonLine } from "./runner-events.js";
import {
	emptyUsage,
	getFinalOutput,
	type InitialContext,
	normalizeCompletedResult,
	type SingleResult,
	type SubagentDetails,
	type SubagentSessionDetails,
} from "./types.ts";

const isWindows = process.platform === "win32";
const SIGKILL_TIMEOUT_MS = 500;
const TERMINATION_SETTLE_TIMEOUT_MS = SIGKILL_TIMEOUT_MS + 1000;
const AGENT_END_GRACE_MS = 250;
const SUBAGENT_DEPTH_ENV = "OMEGA_SUBAGENT_DEPTH";
const SUBAGENT_MAX_DEPTH_ENV = "OMEGA_SUBAGENT_MAX_DEPTH";
const SUBAGENT_STACK_ENV = "OMEGA_SUBAGENT_STACK";
const SUBAGENT_PREVENT_CYCLES_ENV = "OMEGA_SUBAGENT_PREVENT_CYCLES";
const SUBAGENT_TEMP_PARENT_SESSION_ENV = "OMEGA_SUBAGENT_TEMP_PARENT_SESSION";
const PI_OFFLINE_ENV = "PI_OFFLINE";
const PERSISTENT_SESSION_EXIT_TIMEOUT_MS = 30_000;
export const DEFAULT_SUBAGENT_RUN_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_JSON_LINE_BYTES = 25 * 1024 * 1024;
const MAX_STDERR_BYTES = DEFAULT_MAX_BYTES;

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

export type SubagentPromptBehavior = "steer" | "follow_up";

export interface SubagentRuntimeControl {
	sendPrompt: (message: string, behavior: SubagentPromptBehavior) => boolean;
	setKeepAlive: (keepAlive: boolean) => void;
}

/** Feed one Omega RPC JSONL record into a programmatic subagent result. */
export function processSubagentJsonLine(line: string, result: SingleResult): boolean {
	return processPiJsonLine(line, result);
}

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

export interface UnexpectedSignalFailure {
	exitCode: number;
	message: string;
}

/** Classify a signal exit that was not initiated by cancellation or a watchdog. */
export function getUnexpectedSignalFailure(
	code: number | null,
	signalName: NodeJS.Signals | null,
	wasAborted: boolean,
	forcedExitCode?: number,
): UnexpectedSignalFailure | null {
	if (code !== null || !signalName || wasAborted || forcedExitCode !== undefined) {
		return null;
	}

	const signalNumber = os.constants.signals[signalName];
	return {
		exitCode: typeof signalNumber === "number" ? 128 + signalNumber : 1,
		message: `Subagent terminated unexpectedly by ${signalName}.`,
	};
}

/**
 * Spawn the current Omega entry point so every child receives Omega's internal
 * modules instead of bypassing them through Pi's bare RPC entry point.
 */
export interface PiSpawnRuntime {
	execPath: string;
	argv: readonly string[];
	execArgv: readonly string[];
}

export function resolvePiSpawn(runtime: PiSpawnRuntime = process): { command: string; prefixArgs: string[] } {
	const isNode = /[\\/]node(?:\.exe)?$/i.test(runtime.execPath);
	const currentScript = runtime.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (isNode && currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		const sourceLoaderArgs = /\.[cm]?tsx?$/i.test(currentScript) ? runtime.execArgv : [];
		return { command: runtime.execPath, prefixArgs: [...sourceLoaderArgs, currentScript, "--mode", "rpc"] };
	}
	if (!isNode) return { command: runtime.execPath, prefixArgs: ["--mode", "rpc"] };
	return { command: "omega", prefixArgs: ["--mode", "rpc"] };
}

// ---------------------------------------------------------------------------
// Temp file helpers
// ---------------------------------------------------------------------------

function writePromptToTempFile(agentName: string, prompt: string): { dir: string; filePath: string } {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omega-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	try {
		fs.writeFileSync(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
		return { dir: tmpDir, filePath };
	} catch (error) {
		cleanupTempDir(tmpDir);
		throw error;
	}
}

function writeSessionSnapshotToTempFile(agentName: string, sessionJsonl: string): { dir: string; filePath: string } {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omega-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `parent-${safeName}.jsonl`);
	try {
		fs.writeFileSync(filePath, sessionJsonl, { encoding: "utf-8", mode: 0o600 });
		return { dir: tmpDir, filePath };
	} catch (error) {
		cleanupTempDir(tmpDir);
		throw error;
	}
}

function writeStructuredOutputSchemaToTempFile(agentName: string, schema: TSchema): { dir: string; filePath: string } {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omega-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `schema-${safeName}.json`);
	try {
		fs.writeFileSync(filePath, JSON.stringify(schema), { encoding: "utf-8", mode: 0o600 });
		return { dir: tmpDir, filePath };
	} catch (error) {
		cleanupTempDir(tmpDir);
		throw error;
	}
}

function cleanupTempDir(dir: string | null): void {
	if (!dir) return;
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
}

export function rewriteSessionHeaderCwd(sessionJsonl: string, cwd: string): string | null {
	const newlineIndex = sessionJsonl.indexOf("\n");
	const firstLine = newlineIndex === -1 ? sessionJsonl : sessionJsonl.slice(0, newlineIndex);
	if (!firstLine.trim()) return null;

	let header: unknown;
	try {
		header = JSON.parse(firstLine);
	} catch {
		return null;
	}

	if (!header || typeof header !== "object" || (header as { type?: unknown }).type !== "session") {
		return null;
	}

	const updatedHeader = { ...header, cwd };
	const rest = newlineIndex === -1 ? "" : sessionJsonl.slice(newlineIndex + 1);
	return `${JSON.stringify(updatedHeader)}\n${rest}`;
}

// ---------------------------------------------------------------------------
// Build pi CLI arguments
// ---------------------------------------------------------------------------

const inheritedCliArgs = parseInheritedCliArgs(selectInheritedPiArgv(process.argv, process.env));

export interface ParentModel {
	provider: string;
	id: string;
}

function formatParentModel(parentModel: ParentModel | undefined): string | undefined {
	return parentModel ? `${parentModel.provider}/${parentModel.id}` : undefined;
}

export function buildModelArgs(
	callModel: string | undefined,
	agentModel: string | undefined,
	parentModel: ParentModel | undefined,
	fallbackProvider: string | undefined,
	fallbackModel: string | undefined,
): string[] {
	const configuredModel = callModel ?? agentModel;
	if (configuredModel) {
		return [...(fallbackProvider ? ["--provider", fallbackProvider] : []), "--model", configuredModel];
	}

	const inheritedModel = formatParentModel(parentModel);
	if (inheritedModel) return ["--model", inheritedModel];

	return [
		...(fallbackProvider ? ["--provider", fallbackProvider] : []),
		...(fallbackModel ? ["--model", fallbackModel] : []),
	];
}

export function buildPiArgs(
	agent: AgentConfig,
	systemPromptPath: string | null,
	_prompt: string,
	initialContext: InitialContext,
	parentSessionPath: string | null,
	session: SubagentSessionDetails | undefined,
	persistentSessionDir: string | undefined,
	callModel?: string,
	parentModel?: ParentModel,
	inheritProjectApproval = true,
	requiredTools: string[] = [],
): string[] {
	const projectTrustArgs = getInheritedProjectTrustArgs(inheritedCliArgs.projectTrustOverride, inheritProjectApproval);
	const args: string[] = [...inheritedCliArgs.extensionArgs, ...inheritedCliArgs.alwaysProxy, ...projectTrustArgs];

	if (session && persistentSessionDir && !inheritedCliArgs.sessionDir) {
		args.push("--session-dir", persistentSessionDir);
	}

	if (session) {
		if (session.created && initialContext === "parent") {
			if (parentSessionPath) args.push("--fork", parentSessionPath);
		}
		args.push("--session-id", session.id);
		if (session.created) args.push("--name", session.name);
	} else if (initialContext === "parent") {
		if (parentSessionPath) args.push("--session", parentSessionPath);
	} else {
		args.push("--no-session");
	}

	args.push(
		...buildModelArgs(
			callModel,
			agent.model,
			parentModel,
			inheritedCliArgs.fallbackProvider,
			inheritedCliArgs.fallbackModel,
		),
	);

	const thinking = agent.thinking ?? inheritedCliArgs.fallbackThinking;
	if (thinking) args.push("--thinking", thinking);

	if (agent.noTools === true) {
		if (requiredTools.length > 0) args.push("--tools", [...new Set(requiredTools)].join(","));
		else args.push("--no-tools");
	} else if (agent.tools && agent.tools.length > 0) {
		args.push("--tools", [...new Set([...agent.tools, ...requiredTools])].join(","));
	} else if (agent.tools === undefined) {
		if (inheritedCliArgs.fallbackTools !== undefined) {
			const fallbackTools = inheritedCliArgs.fallbackTools
				.split(",")
				.map((tool: string) => tool.trim())
				.filter(Boolean);
			args.push("--tools", [...new Set([...fallbackTools, ...requiredTools])].join(","));
		} else if (inheritedCliArgs.fallbackNoTools) {
			if (requiredTools.length > 0) args.push("--tools", [...new Set(requiredTools)].join(","));
			else args.push("--no-tools");
		}
	}

	if (systemPromptPath) {
		args.push(agent.systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt", systemPromptPath);
	}
	return args;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RunAgentOptions {
	/** Parent-visible runtime task identifier. */
	taskId?: string;
	/** Fallback working directory when the call doesn't specify one. */
	cwd: string;
	/** All available agent configs. */
	agents: AgentConfig[];
	/** Original call index in the tool invocation. */
	callIndex: number;
	/** Name of the agent to run. */
	agentName: string;
	/** Prompt sent verbatim to the subagent. */
	prompt: string;
	/** Per-call model override. */
	callModel?: string;
	/** Parent session model captured when the tool invocation started. */
	parentModel?: ParentModel;
	/** Effective working directory for this process. */
	callCwd?: string;
	/** Initial context for newly-created child conversations. */
	initialContext: InitialContext;
	/** Serialized parent session snapshot, used when initialContext is "parent". */
	parentSessionSnapshotJsonl?: string;
	/** Optional named persistent subagent session. */
	session?: SubagentSessionDetails;
	/** Optional persistent session directory inherited from the parent runtime. */
	persistentSessionDir?: string;
	/** Current delegation depth of the caller process. */
	parentDepth: number;
	/** Delegation stack from the caller process (ancestor agent names). */
	parentAgentStack: string[];
	/** Maximum allowed delegation depth to propagate to child processes. */
	maxDepth: number;
	/** Whether cycle prevention should be enforced in child processes. */
	preventCycles: boolean;
	/** Optional per-call inactivity timeout. Overrides the agent default. */
	inactivityTimeoutMs?: number;
	/** Optional exceptional wall-clock deadline for the child run. */
	timeoutMs?: number;
	/** Optional JSON Schema exposed to the child as a terminating structured_output tool. */
	structuredOutputSchema?: TSchema;
	/** Workflow ancestry propagated to a child that may invoke the workflow tool. */
	workflowStack?: string[];
	/** Abort signal for cancellation. */
	signal?: AbortSignal;
	/** Keep the RPC child alive after it becomes idle so the runtime can accept more prompts. */
	keepAlive?: boolean;
	/** Receive a writable control channel once the child RPC process is ready. */
	onControlReady?: (control: SubagentRuntimeControl) => void;
	/** Streaming update callback. */
	onUpdate?: OnUpdateCallback;
	/** Factory to wrap results into SubagentDetails. */
	makeDetails: (results: SingleResult[]) => SubagentDetails;
}

/**
 * Spawn a single subagent process and collect its results.
 *
 * Returns a SingleResult even on failure (exitCode > 0, stderr populated).
 */
export function isSameWorkingDirectory(left: string, right: string): boolean {
	return fs.realpathSync(left) === fs.realpathSync(right);
}

export function resolveInactivityTimeoutMs(
	callInactivityTimeoutMs: number | undefined,
	agentTimeoutSeconds: number | undefined,
): number | undefined {
	return callInactivityTimeoutMs ?? (agentTimeoutSeconds === undefined ? undefined : agentTimeoutSeconds * 1000);
}

export function resolveRunTimeoutMs(callTimeoutMs: number | undefined): number {
	return callTimeoutMs ?? DEFAULT_SUBAGENT_RUN_TIMEOUT_MS;
}

export async function runAgent(opts: RunAgentOptions): Promise<SingleResult> {
	const {
		taskId,
		cwd,
		agents,
		callIndex,
		agentName,
		prompt,
		callModel,
		parentModel,
		callCwd,
		initialContext,
		parentSessionSnapshotJsonl,
		session,
		persistentSessionDir,
		parentDepth,
		parentAgentStack,
		maxDepth,
		preventCycles,
		inactivityTimeoutMs: callInactivityTimeoutMs,
		timeoutMs,
		structuredOutputSchema,
		workflowStack,
		signal,
		keepAlive = false,
		onControlReady,
		onUpdate,
		makeDetails,
	} = opts;

	const agent = agents.find((a) => a.name === agentName);
	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			taskId,
			callIndex,
			agent: agentName,
			agentSource: "unknown",
			prompt,
			initialContext,
			session,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: emptyUsage(),
			stopReason: "error",
			errorMessage: `Unknown agent: "${agentName}". Available agents: ${available}.`,
		};
	}

	const needsParentSnapshot = initialContext === "parent" && (!session || session.created);
	if (needsParentSnapshot && (!parentSessionSnapshotJsonl || !parentSessionSnapshotJsonl.trim())) {
		const message = 'Cannot run with initialContext="parent": missing parent session snapshot context.';
		return {
			taskId,
			callIndex,
			agent: agentName,
			agentSource: agent.source,
			prompt,
			initialContext,
			session,
			exitCode: 1,
			messages: [],
			stderr: message,
			usage: emptyUsage(),
			model: callModel ?? agent.model,
			stopReason: "error",
			errorMessage: message,
		};
	}

	const inactivityTimeoutMs = resolveInactivityTimeoutMs(callInactivityTimeoutMs, agent.inactivityTimeout);
	const runTimeoutMs = resolveRunTimeoutMs(timeoutMs);

	const result: SingleResult = {
		taskId,
		callIndex,
		agent: agentName,
		agentSource: agent.source,
		prompt,
		initialContext,
		session,
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: emptyUsage(),
		model: callModel ?? agent.model,
	};

	if (signal?.aborted) {
		return normalizeCompletedResult(result, true);
	}

	const emitUpdate = () => {
		onUpdate?.({
			content: [
				{
					type: "text",
					text: getFinalOutput(result.messages) || "(running...)",
				},
			],
			details: makeDetails([result]),
		});
	};

	let wasAborted = false;
	// Write system prompt to temp file if needed.
	let promptTmpDir: string | null = null;
	let promptTmpPath: string | null = null;
	let parentSessionTmpDir: string | null = null;
	let parentSessionTmpPath: string | null = null;
	let structuredOutputSchemaTmpDir: string | null = null;
	let structuredOutputSchemaTmpPath: string | null = null;

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = writePromptToTempFile(agent.name, agent.systemPrompt);
			promptTmpDir = tmp.dir;
			promptTmpPath = tmp.filePath;
		}

		// Write parent session snapshot if this call needs one.
		if (needsParentSnapshot && parentSessionSnapshotJsonl) {
			const snapshotCwd = path.resolve(callCwd ?? cwd);
			const snapshotJsonl =
				rewriteSessionHeaderCwd(parentSessionSnapshotJsonl, snapshotCwd) ?? parentSessionSnapshotJsonl;
			const tmp = writeSessionSnapshotToTempFile(agent.name, snapshotJsonl);
			parentSessionTmpDir = tmp.dir;
			parentSessionTmpPath = tmp.filePath;
		}

		if (structuredOutputSchema) {
			const tmp = writeStructuredOutputSchemaToTempFile(agent.name, structuredOutputSchema);
			structuredOutputSchemaTmpDir = tmp.dir;
			structuredOutputSchemaTmpPath = tmp.filePath;
		}

		const piArgs = buildPiArgs(
			agent,
			promptTmpPath,
			prompt,
			initialContext,
			parentSessionTmpPath,
			session,
			persistentSessionDir,
			callModel,
			parentModel,
			isSameWorkingDirectory(callCwd ?? cwd, cwd),
			structuredOutputSchema ? ["structured_output"] : [],
		);

		const exitCode = await new Promise<number>((resolve) => {
			const nextDepth = Math.max(0, Math.floor(parentDepth)) + 1;
			const propagatedMaxDepth = Math.max(0, Math.floor(maxDepth));
			const propagatedStack = [...parentAgentStack, agentName];
			const { command, prefixArgs } = resolvePiSpawn();
			const proc = spawn(command, [...prefixArgs, ...piArgs], {
				cwd: callCwd ?? cwd,
				shell: false,
				detached: !isWindows,
				stdio: ["pipe", "pipe", "pipe"],
				env: {
					...process.env,
					[SUBAGENT_STRUCTURED_OUTPUT_SCHEMA_ENV]: structuredOutputSchemaTmpPath ?? "",
					[WORKFLOW_STACK_ENV]: workflowStack
						? JSON.stringify(workflowStack)
						: (process.env[WORKFLOW_STACK_ENV] ?? ""),
					[SUBAGENT_DEPTH_ENV]: String(nextDepth),
					[SUBAGENT_MAX_DEPTH_ENV]: String(propagatedMaxDepth),
					[SUBAGENT_STACK_ENV]: JSON.stringify(propagatedStack),
					[SUBAGENT_PREVENT_CYCLES_ENV]: preventCycles ? "1" : "0",
					[SUBAGENT_TEMP_PARENT_SESSION_ENV]: !session && initialContext === "parent" ? "1" : "0",
					[PI_OFFLINE_ENV]: "1",
				},
			});

			proc.stdin.on("error", () => {
				/* ignore broken pipe on fast exits */
			});
			const writeRpcCommand = (command: Record<string, unknown>): boolean => {
				if (proc.stdin.destroyed || !proc.stdin.writable) return false;
				proc.stdin.write(`${JSON.stringify(command)}\n`);
				return true;
			};
			// RPC preserves prompt bytes exactly. Print-mode stdin trims leading and
			// trailing whitespace, while argv reinterprets leading "-" and "@".
			result.runtimeState = "running";
			writeRpcCommand({ type: "prompt", message: prompt });

			let buffer = "";
			const stdoutDecoder = new StringDecoder("utf8");
			const stderrDecoder = new StringDecoder("utf8");
			let didClose = false;
			let settled = false;
			let abortHandler: (() => void) | undefined;
			let semanticCompletionTimer: NodeJS.Timeout | undefined;
			let persistentSessionExitTimer: NodeJS.Timeout | undefined;
			let inactivityTimeoutTimer: NodeJS.Timeout | undefined;
			let runTimeoutTimer: NodeJS.Timeout | undefined;
			let rpcHandledTimer: NodeJS.Timeout | undefined;
			let sigkillTimer: NodeJS.Timeout | undefined;
			let terminationSettleTimer: NodeJS.Timeout | undefined;
			let terminationStarted = false;
			let forcedExitCode: number | undefined;
			let keepAliveAfterSettlement = keepAlive;

			const appendStderr = (text: string) => {
				const combined = `${result.stderr}${text}`;
				const truncation = truncateTail(combined, {
					maxBytes: MAX_STDERR_BYTES,
					maxLines: Number.MAX_SAFE_INTEGER,
				});
				result.stderr = truncation.content;
				if (truncation.truncated) result.stderrTruncated = true;
			};

			const clearSemanticCompletionTimer = () => {
				if (semanticCompletionTimer) {
					clearTimeout(semanticCompletionTimer);
					semanticCompletionTimer = undefined;
				}
			};

			const clearPersistentSessionExitTimer = () => {
				if (persistentSessionExitTimer) {
					clearTimeout(persistentSessionExitTimer);
					persistentSessionExitTimer = undefined;
				}
			};

			const clearInactivityTimeoutTimer = () => {
				if (inactivityTimeoutTimer) {
					clearTimeout(inactivityTimeoutTimer);
					inactivityTimeoutTimer = undefined;
				}
			};

			const clearRunTimeoutTimer = () => {
				if (runTimeoutTimer) {
					clearTimeout(runTimeoutTimer);
					runTimeoutTimer = undefined;
				}
			};

			const clearRunWatchdogs = () => {
				clearInactivityTimeoutTimer();
				clearRunTimeoutTimer();
			};

			const resetRunTimeout = () => {
				clearRunTimeoutTimer();
				runTimeoutTimer = setTimeout(() => {
					if (didClose || settled) return;
					const timeoutSeconds = runTimeoutMs / 1000;
					failAndTerminate(`Subagent exceeded its ${timeoutSeconds}s run timeout and was removed from the queue.`);
				}, runTimeoutMs);
				runTimeoutTimer.unref();
			};

			const clearRpcHandledTimer = () => {
				if (rpcHandledTimer) {
					clearTimeout(rpcHandledTimer);
					rpcHandledTimer = undefined;
				}
			};

			const isProcessGroupAlive = () => {
				if (isWindows || proc.pid === undefined) return false;
				try {
					process.kill(-proc.pid, 0);
					return true;
				} catch {
					return false;
				}
			};

			const signalProcessTree = (signalName: NodeJS.Signals) => {
				if (proc.pid === undefined) return;
				try {
					// Detached Unix children lead their own process group. A negative PID
					// signals Omega and every descendant that has not deliberately escaped.
					process.kill(-proc.pid, signalName);
				} catch {
					try {
						proc.kill(signalName);
					} catch {
						// The process may already have exited between checks.
					}
				}
			};

			const terminateChild = () => {
				if (terminationStarted) return;
				terminationStarted = true;
				clearRunWatchdogs();

				if (isWindows) {
					if (proc.pid !== undefined) {
						const killer = spawn("taskkill", ["/T", "/F", "/PID", String(proc.pid)], {
							stdio: "ignore",
						});
						killer.once("error", (error) => {
							recordProcessFailure(`Could not start Windows taskkill: ${error.message}`);
							try {
								proc.kill();
							} catch {
								// The process may already have exited between checks.
							}
						});
						killer.unref();
					}
				} else {
					signalProcessTree("SIGTERM");
					sigkillTimer = setTimeout(() => {
						signalProcessTree("SIGKILL");
					}, SIGKILL_TIMEOUT_MS);
				}

				terminationSettleTimer = setTimeout(() => {
					if (settled) return;
					proc.stdout.removeListener("data", onStdoutData);
					proc.stderr.removeListener("data", onStderrData);
					if (forcedExitCode === undefined) forcedExitCode = wasAborted ? 130 : 1;
					finish(forcedExitCode);
				}, TERMINATION_SETTLE_TIMEOUT_MS);
			};

			const recordProcessFailure = (message: string) => {
				if (!result.processError) {
					result.processError = true;
					result.stopReason = "error";
					result.errorMessage = message;
				}
				if (!result.stderr.includes(message)) {
					appendStderr(`${result.stderr ? "\n" : ""}${message}`);
				}
				forcedExitCode = 1;
			};

			const failAndTerminate = (message: string) => {
				recordProcessFailure(message);
				terminateChild();
			};

			const resetInactivityTimeout = () => {
				if (
					inactivityTimeoutMs === undefined ||
					result.sawAgentSettled ||
					didClose ||
					settled ||
					terminationStarted
				)
					return;
				clearInactivityTimeoutTimer();
				inactivityTimeoutTimer = setTimeout(() => {
					if (didClose || settled || terminationStarted) return;
					const timeoutSeconds = inactivityTimeoutMs / 1000;
					failAndTerminate(
						`Subagent produced no child RPC stdout activity for ${timeoutSeconds}s and exceeded its inactivity timeout.`,
					);
				}, inactivityTimeoutMs);
				inactivityTimeoutTimer.unref();
			};

			resetInactivityTimeout();

			resetRunTimeout();

			const finish = (code: number) => {
				if (settled) return;
				settled = true;
				clearSemanticCompletionTimer();
				clearPersistentSessionExitTimer();
				clearRunWatchdogs();
				clearRpcHandledTimer();
				if (sigkillTimer) clearTimeout(sigkillTimer);
				if (terminationSettleTimer) clearTimeout(terminationSettleTimer);
				if (signal && abortHandler) {
					signal.removeEventListener("abort", abortHandler);
				}
				resolve(forcedExitCode ?? code);
			};

			const flushLine = (line: string) => {
				if (Buffer.byteLength(line, "utf8") > MAX_JSON_LINE_BYTES) {
					failAndTerminate(`Subagent emitted a JSON event larger than ${MAX_JSON_LINE_BYTES} bytes.`);
					return;
				}
				let event: unknown;
				try {
					event = JSON.parse(line);
				} catch {
					event = undefined;
				}
				const rpcEvent =
					event && typeof event === "object" ? (event as { id?: unknown; type?: unknown }) : undefined;
				if (rpcEvent?.type === "extension_ui_request" && typeof rpcEvent.id === "string") {
					proc.stdin.write(
						`${JSON.stringify({
							type: "extension_ui_response",
							id: rpcEvent.id,
							cancelled: true,
						})}\n`,
					);
				}

				if (processPiJsonLine(line, result)) emitUpdate();
				if (result.sawAgentStart) clearRpcHandledTimer();
				if (result.rpcPromptIdle && !result.sawAgentStart && !result.sawAgentSettled) {
					result.handledWithoutAgent = true;
					result.sawAgentSettled = true;
				}
				if (result.rpcPromptAccepted && !result.sawAgentStart && !result.sawAgentSettled && !rpcHandledTimer) {
					rpcHandledTimer = setTimeout(() => {
						if (result.sawAgentStart || result.sawAgentSettled || settled) return;
						proc.stdin.write(
							`${JSON.stringify({
								type: "get_state",
								id: "omega-subagent-prompt-state",
							})}\n`,
						);
					}, AGENT_END_GRACE_MS);
				}
				maybeFinishFromSettlement();
			};

			const flushBufferedLines = (text: string) => {
				for (const line of text.split(/\r?\n/)) {
					if (line.trim()) flushLine(line);
				}
			};

			const closeIdleRuntime = () => {
				if (result.runtimeState !== "idle" || didClose || settled || terminationStarted) return;
				if (!proc.stdin.destroyed) proc.stdin.end();
				if (session) {
					if (!persistentSessionExitTimer) {
						persistentSessionExitTimer = setTimeout(() => {
							if (didClose || settled || !result.sawAgentSettled) return;
							failAndTerminate(
								`Named subagent session did not exit within ${PERSISTENT_SESSION_EXIT_TIMEOUT_MS}ms after settling; terminated to avoid hanging.`,
							);
						}, PERSISTENT_SESSION_EXIT_TIMEOUT_MS);
						persistentSessionExitTimer.unref();
					}
					return;
				}
				clearSemanticCompletionTimer();
				semanticCompletionTimer = setTimeout(() => {
					if (didClose || settled || !result.sawAgentSettled) return;
					if (buffer.trim()) {
						flushBufferedLines(buffer);
						buffer = "";
					}
					proc.stdout.removeListener("data", onStdoutData);
					proc.stderr.removeListener("data", onStderrData);
					forcedExitCode = 0;
					terminateChild();
				}, AGENT_END_GRACE_MS);
				semanticCompletionTimer.unref();
			};

			onControlReady?.({
				sendPrompt: (message, behavior) => {
					const trimmed = message.trim();
					if (!trimmed) return false;
					result.runtimePrompts ??= [];
					result.runtimePrompts.push({ text: message, afterMessageCount: result.messages.length });
					result.sawAgentStart = false;
					result.sawAgentEnd = false;
					result.sawAgentSettled = false;
					result.rpcPromptAccepted = false;
					result.rpcPromptIdle = false;
					result.handledWithoutAgent = false;
					result.runtimeState = "running";
					const sent = writeRpcCommand({ type: behavior, message });
					if (sent) {
						resetInactivityTimeout();
						resetRunTimeout();
						emitUpdate();
					}
					return sent;
				},
				setKeepAlive: (nextKeepAlive) => {
					keepAliveAfterSettlement = nextKeepAlive;
					if (!nextKeepAlive) closeIdleRuntime();
				},
			});

			const maybeFinishFromSettlement = () => {
				if (!result.sawAgentSettled || didClose || settled) return;
				clearInactivityTimeoutTimer();
				clearRunTimeoutTimer();
				result.runtimeState = "idle";
				if (keepAliveAfterSettlement) emitUpdate();
				else closeIdleRuntime();
			};

			const onStdoutData = (chunk: Buffer) => {
				resetInactivityTimeout();
				buffer += stdoutDecoder.write(chunk);
				const lines = buffer.split(/\r?\n/);
				buffer = lines.pop() || "";
				for (const line of lines) flushLine(line);
				if (Buffer.byteLength(buffer, "utf8") > MAX_JSON_LINE_BYTES) {
					flushLine(buffer);
					buffer = "";
				}
			};

			const onStderrData = (chunk: Buffer) => {
				appendStderr(stderrDecoder.write(chunk));
			};

			proc.stdout.on("data", onStdoutData);
			proc.stderr.on("data", onStderrData);

			proc.on("close", (code, signalName) => {
				didClose = true;
				result.runtimeState = undefined;
				buffer += stdoutDecoder.end();
				const stderrRemainder = stderrDecoder.end();
				if (stderrRemainder) appendStderr(stderrRemainder);
				if (buffer.trim()) flushBufferedLines(buffer);

				const signalFailure = getUnexpectedSignalFailure(code, signalName, wasAborted, forcedExitCode);
				if (signalFailure && !settled) {
					recordProcessFailure(signalFailure.message);
					forcedExitCode = signalFailure.exitCode;
					terminateChild();
				}

				if (terminationStarted && !isWindows && isProcessGroupAlive()) {
					return;
				}
				finish(code ?? signalFailure?.exitCode ?? 1);
			});

			proc.on("error", (err) => {
				recordProcessFailure(err.message);
				finish(1);
			});

			// Abort handling.
			if (signal) {
				abortHandler = () => {
					if (didClose || settled) return;
					wasAborted = true;
					terminateChild();
				};
				if (signal.aborted) abortHandler();
				else signal.addEventListener("abort", abortHandler, { once: true });
			}
		});

		result.exitCode = exitCode;
		return normalizeCompletedResult(result, wasAborted);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		result.exitCode = 1;
		result.processError = true;
		result.stopReason = "error";
		result.errorMessage = message;
		if (!result.stderr.trim()) result.stderr = message;
		return normalizeCompletedResult(result, wasAborted);
	} finally {
		cleanupTempDir(promptTmpDir);
		cleanupTempDir(parentSessionTmpDir);
		cleanupTempDir(structuredOutputSchemaTmpDir);
	}
}

// ---------------------------------------------------------------------------
// Concurrency helper
// ---------------------------------------------------------------------------

/**
 * Map over items with a bounded number of concurrent workers.
 */
export async function mapConcurrent<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;

	const worker = async () => {
		while (true) {
			const i = nextIndex++;
			if (i >= items.length) return;
			results[i] = await fn(items[i], i);
		}
	};

	await Promise.all(Array.from({ length: limit }, () => worker()));
	return results;
}
