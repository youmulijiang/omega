/**
 * Omega Subagents
 *
 * Delegates prompts to specialized subagents, each running as an isolated Omega
 * process. The tool accepts a single `calls` array for both one and many
 * subagent invocations.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import {
	type ExtensionCommandContext,
	type ExtensionContext,
	getAgentDir,
	ProjectTrustStore,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { OmegaAPI } from "../api.ts";
import { registerOmegaCommand } from "../commands/register.ts";
import {
	type AgentConfig,
	discoverAgents,
	discoverAgentsWithStarter,
	MAX_TIMER_SECONDS,
	STARTER_AGENT_NAME,
} from "./agents.ts";
import {
	CALLS_SCHEMA_DESCRIPTION,
	formatAvailableSubagentsPrompt,
	formatSubagentToolDescription,
	formatSubagentUsageErrorExample,
	getCallFieldSchemaDescription,
} from "./contract.ts";
import { formatCallsSummary, writeOutputArtifact } from "./output.ts";
import { renderCall, renderResult, renderRuntimeResults } from "./render.ts";
import {
	mapConcurrent,
	type ParentModel,
	runAgent,
	type SubagentPromptBehavior,
	type SubagentRuntimeControl,
} from "./runner.ts";
import { parseInheritedCliArgs, selectInheritedPiArgv } from "./runner-cli.js";
import {
	SubagentAgentsWidget,
	SubagentConversationView,
	SubagentFleetEditor,
	SubagentFleetWidget,
} from "./runtime-view.ts";
import { acquireSessionLocks, releaseSessionLocks, type SessionLockTarget } from "./session-lock.ts";
import { ensureDefaultSessionDir, getDefaultSessionDirPath } from "./session-paths.ts";
import { getSubagentSettingsPath, readSubagentSettings, writeSubagentSettings } from "./settings.ts";
import {
	DEFAULT_INITIAL_CONTEXT,
	emptyUsage,
	getFinalOutput,
	type InitialContext,
	isResultError,
	isSettledTurnResult,
	type SingleResult,
	type SubagentDetails,
	type SubagentSessionDetails,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

const MAX_CALLS = 8;
const MAX_CONCURRENCY = 4;
const CALLS_HEARTBEAT_MS = 1000;
const SUBAGENT_STATUS_KEY = "omega.subagents";
const SUBAGENT_RESULT_MESSAGE_TYPE = "omega-subagent-runtime-result";
const DEFAULT_MAX_DELEGATION_DEPTH = 3;
const DEFAULT_PREVENT_CYCLE_DELEGATION = true;
export const OMEGA_SUBAGENT_DEPTH_ENV = "OMEGA_SUBAGENT_DEPTH";
const SUBAGENT_MAX_DEPTH_ENV = "OMEGA_SUBAGENT_MAX_DEPTH";
const SUBAGENT_STACK_ENV = "OMEGA_SUBAGENT_STACK";
const SUBAGENT_PREVENT_CYCLES_ENV = "OMEGA_SUBAGENT_PREVENT_CYCLES";
const SUBAGENT_TEMP_PARENT_SESSION_ENV = "OMEGA_SUBAGENT_TEMP_PARENT_SESSION";
const SESSION_ID_NAMESPACE = "omega-subagent/v1";
const SESSION_ID_PREFIX = "subagent.";
const SESSION_HANDLE_MAX_LENGTH = 120;
/** Overlay geometry for the runtime conversation viewer. `maxHeight` must match
 *  `OVERLAY_HEIGHT_RATIO` in runtime-view.ts: the viewer sizes its frame to exactly this height,
 *  because the overlay clips an over-tall frame from the top. */
const SUBAGENT_VIEW_OVERLAY = {
	overlay: true,
	overlayOptions: {
		anchor: "center",
		width: "94%",
		minWidth: 72,
		maxHeight: "82%",
		margin: 1,
	},
} as const;
const inheritedPiArgv = selectInheritedPiArgv(process.argv, process.env);

// ---------------------------------------------------------------------------
// Tool parameter schema
// ---------------------------------------------------------------------------

const CallItem = Type.Object({
	agent: Type.String({
		description: getCallFieldSchemaDescription("agent"),
		minLength: 1,
	}),
	prompt: Type.String({
		description: getCallFieldSchemaDescription("prompt"),
		minLength: 1,
	}),
	model: Type.Optional(
		Type.String({
			description: getCallFieldSchemaDescription("model"),
			minLength: 1,
		}),
	),
	cwd: Type.Optional(
		Type.String({
			description: getCallFieldSchemaDescription("cwd"),
			minLength: 1,
		}),
	),
	initialContext: Type.Optional(
		StringEnum(["empty", "parent"] as const, {
			description: getCallFieldSchemaDescription("initialContext"),
			default: DEFAULT_INITIAL_CONTEXT,
		}),
	),
	session: Type.Optional(
		Type.String({
			description: getCallFieldSchemaDescription("session"),
			minLength: 1,
			maxLength: SESSION_HANDLE_MAX_LENGTH,
		}),
	),
	inactivityTimeout: Type.Optional(
		Type.Integer({
			description: getCallFieldSchemaDescription("inactivityTimeout"),
			minimum: 1,
			maximum: MAX_TIMER_SECONDS,
		}),
	),
	timeout: Type.Optional(
		Type.Integer({
			description: getCallFieldSchemaDescription("timeout"),
			minimum: 1,
			maximum: MAX_TIMER_SECONDS,
		}),
	),
});

const SubagentParams = Type.Object({
	calls: Type.Array(CallItem, {
		description: CALLS_SCHEMA_DESCRIPTION,
		minItems: 1,
		maxItems: MAX_CALLS,
	}),
});

const SubagentMessageParams = Type.Object({
	task: Type.String({ description: "Running subagent task ID, or a unique running agent name", minLength: 1 }),
	message: Type.String({ description: "Message sent to the running subagent", minLength: 1 }),
	behavior: Type.Optional(
		StringEnum(["steer", "follow_up"] as const, {
			description: "steer interrupts the current direction; follow_up queues another turn",
			default: "steer",
		}),
	),
});

const SubagentStatusParams = Type.Object({
	task: Type.Optional(Type.String({ description: "Optional task ID or unique agent name" })),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface DelegationDepthConfig {
	currentDepth: number;
	maxDepth: number;
	canDelegate: boolean;
	ancestorAgentStack: string[];
	preventCycles: boolean;
}

interface SessionSnapshotSource {
	getHeader: () => unknown;
	getBranch: () => unknown[];
}

interface NormalizedCall {
	taskId?: string;
	index: number;
	agent: string;
	prompt: string;
	model?: string;
	effectiveCwd: string;
	initialContext: InitialContext;
	sessionHandle?: string;
	session?: SubagentSessionDetails;
	inactivityTimeoutMs?: number;
	timeoutMs?: number;
}

interface NormalizedCallsResult {
	calls?: NormalizedCall[];
	error?: string;
}

interface ExtensionExecutionContext {
	cwd: string;
	sessionManager: SessionSnapshotSource & {
		getSessionId: () => string;
		getSessionDir: () => string;
		getSessionFile: () => string | undefined;
	};
}

function parseInitialContext(raw: unknown): InitialContext | null {
	if (raw === undefined) return DEFAULT_INITIAL_CONTEXT;
	if (typeof raw !== "string") return null;
	const normalized = raw.trim();
	if (normalized === "empty" || normalized === "parent") return normalized;
	return null;
}

function parseOptionalTimeoutMs(raw: unknown): number | null | undefined {
	if (raw === undefined) return undefined;
	if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > MAX_TIMER_SECONDS) return null;
	return raw * 1000;
}

function buildParentSessionSnapshotJsonl(sessionManager: SessionSnapshotSource): string | null {
	const header = sessionManager.getHeader();
	if (!header || typeof header !== "object") return null;

	const branchEntries = sessionManager.getBranch();
	const lines = [JSON.stringify(header)];
	for (const entry of branchEntries) lines.push(JSON.stringify(entry));
	return `${lines.join("\n")}\n`;
}

function parseNonNegativeInt(raw: unknown): number | null {
	if (typeof raw !== "string") return null;
	const trimmed = raw.trim();
	if (!/^\d+$/.test(trimmed)) return null;
	const parsed = Number(trimmed);
	return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseBoolean(raw: unknown): boolean | null {
	if (typeof raw === "boolean") return raw;
	if (typeof raw !== "string") return null;
	const normalized = raw.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) return true;
	if (["0", "false", "no", "off"].includes(normalized)) return false;
	return null;
}

function parseAgentStack(raw: unknown): string[] | null {
	if (raw === undefined) return [];
	if (typeof raw !== "string") return null;
	if (!raw.trim()) return [];

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}

	if (!Array.isArray(parsed)) return null;
	if (!parsed.every((value) => typeof value === "string")) return null;
	return parsed.map((value) => value.trim()).filter((value) => value.length > 0);
}

function getMaxDepthFlagFromArgv(argv: string[]): string | null {
	for (let i = 2; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--subagent-max-depth") {
			return argv[i + 1] ?? "";
		}
		if (arg.startsWith("--subagent-max-depth=")) {
			return arg.slice("--subagent-max-depth=".length);
		}
	}
	return null;
}

export function getProjectTrustOverrideFromArgv(argv: string[]): boolean | null {
	return parseInheritedCliArgs(argv).projectTrustOverride ?? null;
}

function shouldIncludeProjectAgents(cwd: string, contextTrusted: boolean): boolean {
	if (!contextTrusted) return false;

	const trustOverride = getProjectTrustOverrideFromArgv(inheritedPiArgv);
	if (trustOverride !== null) return trustOverride;

	try {
		return new ProjectTrustStore(getAgentDir()).get(cwd) === true;
	} catch (error) {
		console.warn(`[omega-subagent] Could not verify project trust; project agents are disabled: ${String(error)}`);
		return false;
	}
}

function getPreventCyclesFlagFromArgv(argv: string[]): string | boolean | null {
	for (let i = 2; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--subagent-prevent-cycles") {
			const maybeValue = argv[i + 1];
			if (maybeValue !== undefined && !maybeValue.startsWith("--")) {
				return maybeValue;
			}
			return true;
		}
		if (arg === "--no-subagent-prevent-cycles") return false;
		if (arg.startsWith("--subagent-prevent-cycles=")) {
			return arg.slice("--subagent-prevent-cycles=".length);
		}
	}
	return null;
}

function resolveDelegationDepthConfig(omega: OmegaAPI): DelegationDepthConfig {
	const depthRaw = process.env[OMEGA_SUBAGENT_DEPTH_ENV];
	const parsedDepth = parseNonNegativeInt(depthRaw);
	if (depthRaw !== undefined && parsedDepth === null) {
		console.warn(
			`[omega-subagent] Ignoring invalid ${OMEGA_SUBAGENT_DEPTH_ENV}="${depthRaw}". Expected a non-negative integer.`,
		);
	}
	const currentDepth = parsedDepth ?? 0;

	const stackRaw = process.env[SUBAGENT_STACK_ENV];
	const ancestorAgentStack = parseAgentStack(stackRaw);
	if (stackRaw !== undefined && ancestorAgentStack === null) {
		console.warn(
			`[omega-subagent] Ignoring invalid ${SUBAGENT_STACK_ENV} value. Expected a JSON array of agent names.`,
		);
	}

	const envMaxDepthRaw = process.env[SUBAGENT_MAX_DEPTH_ENV];
	const envMaxDepth = parseNonNegativeInt(envMaxDepthRaw);
	if (envMaxDepthRaw !== undefined && envMaxDepth === null) {
		console.warn(
			`[omega-subagent] Ignoring invalid ${SUBAGENT_MAX_DEPTH_ENV}="${envMaxDepthRaw}". Expected a non-negative integer.`,
		);
	}

	const argvFlagRaw = getMaxDepthFlagFromArgv(inheritedPiArgv);
	const argvFlagMaxDepth = argvFlagRaw !== null ? parseNonNegativeInt(argvFlagRaw) : null;
	if (argvFlagRaw !== null && argvFlagMaxDepth === null) {
		console.warn(
			`[omega-subagent] Ignoring invalid --subagent-max-depth value "${argvFlagRaw}". Expected a non-negative integer.`,
		);
	}

	const runtimeFlagValue = omega.getFlag("subagent-max-depth");
	const runtimeFlagMaxDepth = typeof runtimeFlagValue === "string" ? parseNonNegativeInt(runtimeFlagValue) : null;
	if (argvFlagRaw === null && typeof runtimeFlagValue === "string" && runtimeFlagMaxDepth === null) {
		console.warn(
			`[omega-subagent] Ignoring invalid --subagent-max-depth value "${runtimeFlagValue}". Expected a non-negative integer.`,
		);
	}

	const envPreventCyclesRaw = process.env[SUBAGENT_PREVENT_CYCLES_ENV];
	const envPreventCycles = parseBoolean(envPreventCyclesRaw);
	if (envPreventCyclesRaw !== undefined && envPreventCycles === null) {
		console.warn(
			`[omega-subagent] Ignoring invalid ${SUBAGENT_PREVENT_CYCLES_ENV}="${envPreventCyclesRaw}". Expected true/false.`,
		);
	}

	const argvPreventCyclesRaw = getPreventCyclesFlagFromArgv(inheritedPiArgv);
	const argvPreventCycles =
		typeof argvPreventCyclesRaw === "boolean" ? argvPreventCyclesRaw : parseBoolean(argvPreventCyclesRaw);
	if (typeof argvPreventCyclesRaw === "string" && argvPreventCycles === null) {
		console.warn(
			`[omega-subagent] Ignoring invalid --subagent-prevent-cycles value "${argvPreventCyclesRaw}". Expected true/false.`,
		);
	}

	const runtimePreventCyclesRaw = omega.getFlag("subagent-prevent-cycles");
	const runtimePreventCycles = parseBoolean(runtimePreventCyclesRaw);
	if (argvPreventCyclesRaw === null && runtimePreventCyclesRaw !== undefined && runtimePreventCycles === null) {
		console.warn(
			`[omega-subagent] Ignoring invalid --subagent-prevent-cycles value "${String(runtimePreventCyclesRaw)}". Expected true/false.`,
		);
	}

	const flagMaxDepth = argvFlagMaxDepth ?? runtimeFlagMaxDepth;
	const maxDepth = flagMaxDepth ?? envMaxDepth ?? DEFAULT_MAX_DELEGATION_DEPTH;
	const preventCycles =
		argvPreventCycles ?? runtimePreventCycles ?? envPreventCycles ?? DEFAULT_PREVENT_CYCLE_DELEGATION;

	return {
		currentDepth,
		maxDepth,
		canDelegate: currentDepth < maxDepth,
		ancestorAgentStack: ancestorAgentStack ?? [],
		preventCycles,
	};
}

function makeDetailsFactory(projectAgentsDir: string | null) {
	return (results: SingleResult[], failed = false): SubagentDetails => ({
		kind: "omega-subagent",
		projectAgentsDir,
		results,
		...(failed ? { failed: true as const } : {}),
	});
}

export function resolveCallCwd(defaultCwd: string, rawCwd?: string): string {
	return fs.realpathSync(path.resolve(defaultCwd, rawCwd ?? "."));
}

function normalizeCalls(rawCalls: unknown, defaultCwd: string): NormalizedCallsResult {
	if (!Array.isArray(rawCalls)) {
		return { error: `Invalid subagent parameters: missing calls array.\n${formatSubagentUsageErrorExample()}` };
	}
	if (rawCalls.length === 0) {
		return {
			error: `Invalid subagent parameters: calls must contain at least one call.\n${formatSubagentUsageErrorExample()}`,
		};
	}
	if (rawCalls.length > MAX_CALLS) {
		return { error: `Too many subagent calls (${rawCalls.length}). Max is ${MAX_CALLS}.` };
	}

	const calls: NormalizedCall[] = [];
	for (let index = 0; index < rawCalls.length; index++) {
		const raw = rawCalls[index];
		if (!raw || typeof raw !== "object") {
			return { error: `calls[${index}] must be an object.` };
		}
		const call = raw as Record<string, unknown>;

		if (typeof call.agent !== "string" || call.agent.trim().length === 0) {
			return { error: `calls[${index}].agent must be a non-empty string.` };
		}
		const agent = call.agent.trim();

		if (typeof call.prompt !== "string" || call.prompt.trim().length === 0) {
			return { error: `calls[${index}].prompt must be a non-empty string.` };
		}
		const prompt = call.prompt;

		let model: string | undefined;
		if (call.model !== undefined) {
			if (typeof call.model !== "string") {
				return { error: `calls[${index}].model must be a string when provided.` };
			}
			model = call.model.trim();
			if (!model) {
				return { error: `calls[${index}].model must not be empty when provided.` };
			}
		}

		const initialContext = parseInitialContext(call.initialContext);
		if (!initialContext) {
			return { error: `calls[${index}].initialContext must be "empty" or "parent".` };
		}

		const inactivityTimeoutMs = parseOptionalTimeoutMs(call.inactivityTimeout);
		if (inactivityTimeoutMs === null) {
			return {
				error: `calls[${index}].inactivityTimeout must be an integer between 1 and ${MAX_TIMER_SECONDS} seconds when provided.`,
			};
		}

		const timeoutMs = parseOptionalTimeoutMs(call.timeout);
		if (timeoutMs === null) {
			return {
				error: `calls[${index}].timeout must be an integer between 1 and ${MAX_TIMER_SECONDS} seconds when provided.`,
			};
		}

		let effectiveCwd: string;
		if (call.cwd !== undefined) {
			if (typeof call.cwd !== "string" || call.cwd.trim().length === 0) {
				return { error: `calls[${index}].cwd must be a non-empty string when provided.` };
			}
			effectiveCwd = path.resolve(defaultCwd, call.cwd);
			try {
				if (!fs.statSync(effectiveCwd).isDirectory()) {
					return { error: `calls[${index}].cwd is not a directory: ${effectiveCwd}` };
				}
				effectiveCwd = resolveCallCwd(defaultCwd, call.cwd);
			} catch {
				return { error: `calls[${index}].cwd does not exist or is not accessible: ${effectiveCwd}` };
			}
		} else {
			try {
				effectiveCwd = resolveCallCwd(defaultCwd);
			} catch {
				return { error: `Parent cwd does not exist or is not accessible: ${path.resolve(defaultCwd)}` };
			}
		}

		let sessionHandle: string | undefined;
		if (call.session !== undefined) {
			if (typeof call.session !== "string") {
				return { error: `calls[${index}].session must be a string when provided.` };
			}
			sessionHandle = call.session.trim();
			if (!sessionHandle) {
				return { error: `calls[${index}].session must not be empty when provided.` };
			}
			if (sessionHandle.length > SESSION_HANDLE_MAX_LENGTH) {
				return {
					error: `calls[${index}].session must be at most ${SESSION_HANDLE_MAX_LENGTH} characters.`,
				};
			}
		}

		calls.push({
			index,
			agent,
			prompt,
			model,
			effectiveCwd,
			initialContext,
			sessionHandle,
			inactivityTimeoutMs,
			timeoutMs,
		});
	}

	return { calls };
}

function stableSessionSeed(values: unknown[]): string {
	return JSON.stringify(values);
}

function deriveSessionId(
	parentSessionId: string,
	effectiveCwd: string,
	agentName: string,
	sessionHandle: string,
): string {
	const digest = createHash("sha256")
		.update(stableSessionSeed([SESSION_ID_NAMESPACE, parentSessionId, effectiveCwd, agentName, sessionHandle]))
		.digest("hex")
		.slice(0, 16);
	return `${SESSION_ID_PREFIX}${digest}`;
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function formatSessionDisplayName(agentName: string, sessionHandle: string): string {
	return `subagent: ${agentName} · ${oneLine(sessionHandle)}`;
}

function attachSessionIdentities(calls: NormalizedCall[], parentSessionId: string): void {
	for (const call of calls) {
		if (!call.sessionHandle) continue;
		const id = deriveSessionId(parentSessionId, call.effectiveCwd, call.agent, call.sessionHandle);
		call.session = {
			handle: call.sessionHandle,
			id,
			name: formatSessionDisplayName(call.agent, call.sessionHandle),
			cwd: call.effectiveCwd,
			created: false,
			initialContextApplied: null,
		};
	}
}

function getDuplicateSessionError(calls: NormalizedCall[]): string | null {
	const firstById = new Map<string, NormalizedCall>();
	for (const call of calls) {
		if (!call.session) continue;
		const first = firstById.get(call.session.id);
		if (first) {
			return `Invalid subagent calls: calls[${first.index}] and calls[${call.index}] resolve to the same persistent session (${call.session.id}).\nA persistent subagent session can only be used by one call at a time. Use different session handles or combine the prompts.`;
		}
		firstById.set(call.session.id, call);
	}
	return null;
}

function getActiveSessionError(calls: NormalizedCall[], activeSessionIds: Set<string>): string | null {
	for (const call of calls) {
		if (call.session && activeSessionIds.has(call.session.id)) {
			return `Invalid subagent calls: calls[${call.index}] uses persistent session ${call.session.id}, which is already running in another subagent call. Retry after that call finishes.`;
		}
	}
	return null;
}

async function resolveSessionCreationState(calls: NormalizedCall[], sessionDir: string | undefined): Promise<void> {
	const sessionIdsByListKey = new Map<string, Set<string>>();

	for (const call of calls) {
		if (!call.session) continue;
		const key = `${sessionDir ?? ""}\0${call.effectiveCwd}`;
		let ids = sessionIdsByListKey.get(key);
		if (!ids) {
			const sessions = await SessionManager.list(call.effectiveCwd, sessionDir);
			ids = new Set(sessions.map((session) => session.id));
			sessionIdsByListKey.set(key, ids);
		}

		const exists = ids.has(call.session.id);
		call.session.created = !exists;
		call.session.initialContextApplied = exists ? null : call.initialContext;
	}
}

function needsParentSnapshot(calls: NormalizedCall[]): boolean {
	return calls.some((call) => call.initialContext === "parent" && (!call.session || call.session.created));
}

function getPersistentSessionDir(ctx: ExtensionExecutionContext): string | undefined {
	const manager = ctx.sessionManager as unknown as {
		usesDefaultSessionDir?: () => boolean;
	};

	if (typeof manager.usesDefaultSessionDir === "function") {
		return manager.usesDefaultSessionDir() ? undefined : ctx.sessionManager.getSessionDir();
	}

	try {
		const current = path.resolve(ctx.sessionManager.getSessionDir());
		const defaultDir = path.resolve(getDefaultSessionDirPath(ctx.cwd));
		return current === defaultDir ? undefined : ctx.sessionManager.getSessionDir();
	} catch {
		return undefined;
	}
}

function getNamedSessionParentError(calls: NormalizedCall[], ctx: ExtensionExecutionContext): string | null {
	if (!calls.some((call) => call.session)) return null;
	if (parseBoolean(process.env[SUBAGENT_TEMP_PARENT_SESSION_ENV]) === true) {
		return "Named subagent sessions are not available from temporary parent-seeded subagent sessions. Omit `session` or use a named parent subagent session first.";
	}
	if (ctx.sessionManager.getSessionFile()) return null;
	return "Named subagent sessions require a persisted parent Omega session. Omit `session` for ephemeral delegation, or run the parent without --no-session.";
}

function sessionBaseDir(call: NormalizedCall, sessionDir: string | undefined): string {
	return sessionDir ?? ensureDefaultSessionDir(call.effectiveCwd);
}

function getSessionLockTargets(calls: NormalizedCall[], sessionDir: string | undefined): SessionLockTarget[] {
	return calls
		.filter((call) => call.session)
		.map((call) => ({
			sessionId: call.session!.id,
			lockRoot: path.join(sessionBaseDir(call, sessionDir), ".omega-subagent-locks"),
			agent: call.agent,
			handle: call.session!.handle,
			cwd: call.effectiveCwd,
		}));
}

function getCycleViolations(requestedNames: Set<string>, ancestorAgentStack: string[]): string[] {
	if (requestedNames.size === 0 || ancestorAgentStack.length === 0) return [];
	const stackSet = new Set(ancestorAgentStack);
	return Array.from(requestedNames).filter((name) => stackSet.has(name));
}

function makePlaceholderResult(call: NormalizedCall): SingleResult {
	return {
		taskId: call.taskId,
		callIndex: call.index,
		agent: call.agent,
		agentSource: "unknown",
		prompt: call.prompt,
		initialContext: call.initialContext,
		session: call.session,
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: emptyUsage(),
		model: call.model,
	};
}

function updateSubagentFooter(ctx: Pick<ExtensionContext, "ui">, results: readonly SingleResult[] | undefined): void {
	const running = results?.filter((result) => result.exitCode === -1) ?? [];
	if (running.length === 0) {
		ctx.ui.setStatus(SUBAGENT_STATUS_KEY, undefined);
		return;
	}
	const names = running.map((result) => `${result.agent}${result.runtimeState === "idle" ? "(idle)" : ""}`).join(", ");
	ctx.ui.setStatus(
		SUBAGENT_STATUS_KEY,
		ctx.ui.theme.fg("warning", ` subagents ${running.length} running · ${names} `),
	);
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export interface RegisterSubagentsOptions {
	settingsPath?: string;
	/** Test seam: replaces the child-process runner so the run lifecycle can be driven without spawning. */
	runAgent?: typeof runAgent;
}

export function registerSubagents(omega: OmegaAPI, options: RegisterSubagentsOptions = {}): void {
	omega.registerFlag("subagent-max-depth", {
		description: "Maximum allowed subagent delegation depth (default: 3).",
		type: "string",
	});
	omega.registerFlag("subagent-prevent-cycles", {
		description: "Block delegating to agents already in the current delegation stack (default: true).",
		type: "boolean",
	});
	omega.registerFlag("no-subagent-prevent-cycles", {
		description: "Disable subagent delegation cycle prevention.",
		type: "boolean",
	});

	const depthConfig = resolveDelegationDepthConfig(omega);
	const { currentDepth, maxDepth, canDelegate, ancestorAgentStack, preventCycles } = depthConfig;
	const settingsPath = options.settingsPath ?? getSubagentSettingsPath();
	const enabled = readSubagentSettings(settingsPath).enabled;
	const runtimeEnabled = enabled && canDelegate;
	const runAgentImpl = options.runAgent ?? runAgent;
	const activeSessionIds = new Set<string>();
	const activeTasks = new Map<
		string,
		{ agent: string; controller: AbortController; control?: SubagentRuntimeControl }
	>();
	const outputArtifactDirs = new Set<string>();
	const runtimeResults = new Map<string, SingleResult>();
	const deliveredSettlements = new Map<string, string>();
	const pendingSettlements = new Map<
		string,
		{ settlementKey: string; taskId: string; agent: string; output: string }
	>();
	let latestRuntimeResults: readonly SingleResult[] = [];
	/** Task ids published by the run currently on screen; earlier runs must not linger in the UI. */
	const visibleRuntimeTaskIds = new Set<string>();
	let nextTaskId = 1;
	let runtimeViewDepth = 0;
	let selectedRuntimeTaskId: string | undefined;

	const selectRuntimeTask = (taskId: string | undefined): void => {
		selectedRuntimeTaskId = taskId;
		for (const [activeTaskId, task] of activeTasks) {
			task.control?.setKeepAlive(activeTaskId === taskId);
		}
	};

	omega.registerMessageRenderer<{
		kind: "omega-subagent-runtime-result";
		settlements: Array<{ taskId: string; agent: string; output: string }>;
	}>(SUBAGENT_RESULT_MESSAGE_TYPE, (message, _renderOptions, theme) =>
		renderRuntimeResults(
			message.details?.settlements ?? [{ taskId: "subagent", agent: "unknown", output: "Result unavailable." }],
			theme,
		),
	);

	const visibleRuntimeResults = (): readonly SingleResult[] =>
		[...visibleRuntimeTaskIds]
			.map((taskId) => runtimeResults.get(taskId))
			.filter((result): result is SingleResult => result !== undefined);

	/** Forget agents from finished runs; still-running tasks (an overlapping run) stay visible. */
	const pruneFinishedRuntimeTasks = (): void => {
		for (const taskId of [...visibleRuntimeTaskIds]) {
			if (runtimeResults.get(taskId)?.exitCode === -1) continue;
			visibleRuntimeTaskIds.delete(taskId);
		}
		latestRuntimeResults = visibleRuntimeResults();
	};

	const publishRuntimeResults = (results: readonly SingleResult[]): readonly SingleResult[] => {
		for (const result of results) {
			if (!result.taskId) continue;
			runtimeResults.set(result.taskId, result);
			visibleRuntimeTaskIds.add(result.taskId);
		}
		// `runtimeResults` keeps finished runs around for `subagent_status`, but the list the widgets
		// and the viewer render is run-scoped: otherwise a completed agent from an earlier run stays
		// in the panel and reappears next to the agents of the following run.
		latestRuntimeResults = visibleRuntimeResults();
		return latestRuntimeResults;
	};

	const flushPendingSettlements = (): void => {
		if (pendingSettlements.size === 0) return;
		const settlements = [...pendingSettlements.values()];
		pendingSettlements.clear();
		for (const settlement of settlements) {
			deliveredSettlements.set(settlement.taskId, settlement.settlementKey);
		}
		omega.sendMessage(
			{
				customType: SUBAGENT_RESULT_MESSAGE_TYPE,
				content: settlements
					.flatMap((settlement) => [
						`Subagent task ${settlement.taskId} (${settlement.agent}) completed a turn.`,
						"Answer:",
						settlement.output,
					])
					.concat("Synthesize these newly completed subagent results and continue the parent task.")
					.join("\n\n"),
				display: true,
				details: { kind: "omega-subagent-runtime-result", settlements },
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
	};

	const queueSettledRuntimeResults = (results: readonly SingleResult[]): void => {
		for (const result of results) {
			if (!isSettledTurnResult(result)) continue;
			const output = getFinalOutput(result.messages).trim();
			if (!output) continue;
			const settlementKey = createHash("sha256")
				.update(`${result.messages.length}\0${result.runtimePrompts?.length ?? 0}\0${output}`)
				.digest("hex");
			if (deliveredSettlements.get(result.taskId) === settlementKey) continue;
			const pendingKey = `${result.taskId}:${settlementKey}`;
			if (!pendingSettlements.has(pendingKey)) {
				pendingSettlements.set(pendingKey, {
					settlementKey,
					taskId: result.taskId,
					agent: result.agent,
					output,
				});
			}
		}
		if (runtimeViewDepth === 0) flushPendingSettlements();
	};

	const sendTaskMessage = (
		identifier: string,
		message: string,
		behavior: SubagentPromptBehavior,
	): { ok: boolean; message: string } => {
		let resolvedTaskId = identifier;
		let task = activeTasks.get(resolvedTaskId);
		if (!task) {
			const matches = [...activeTasks.entries()].filter(([, item]) => item.agent === identifier);
			if (matches.length > 1) {
				return {
					ok: false,
					message: `Agent ${identifier} has multiple running tasks; specify a task ID: ${matches.map(([id]) => id).join(", ")}`,
				};
			}
			if (matches.length === 1) [resolvedTaskId, task] = matches[0];
		}
		if (!task) return { ok: false, message: `Running subagent task ${identifier} not found.` };
		if (!task.control) return { ok: false, message: `The RPC channel for ${resolvedTaskId} is not ready yet.` };
		if (!task.control.sendPrompt(message, behavior)) {
			return { ok: false, message: `The RPC channel for ${resolvedTaskId} is already closed.` };
		}
		return { ok: true, message: `Message sent to ${resolvedTaskId} (${task.agent}).` };
	};

	omega.registerShortcut("shift+down", {
		description: "Select and view a live subagent session",
		handler: async (ctx) => {
			if (latestRuntimeResults.length === 0) {
				ctx.ui.notify("No subagent run records to view.", "info");
				return;
			}
			runtimeViewDepth++;
			try {
				await ctx.ui.custom<void>(
					(tui, theme, keybindings, done) =>
						new SubagentConversationView(
							() => latestRuntimeResults,
							tui,
							theme,
							keybindings,
							() => {
								selectRuntimeTask(undefined);
								done();
							},
							0,
							(index) => selectRuntimeTask(latestRuntimeResults[index]?.taskId),
							(taskId, prompt) => {
								const sent = sendTaskMessage(taskId, prompt, "follow_up");
								if (!sent.ok) ctx.ui.notify(sent.message, "warning");
							},
						),
					SUBAGENT_VIEW_OVERLAY,
				);
			} finally {
				runtimeViewDepth = Math.max(0, runtimeViewDepth - 1);
				flushPendingSettlements();
			}
		},
	});

	const saveFullOutput = (content: string): string | null => {
		try {
			const artifact = writeOutputArtifact(content);
			outputArtifactDirs.add(artifact.dir);
			return artifact.filePath;
		} catch (error) {
			console.warn(`[omega-subagent] Could not save truncated output: ${String(error)}`);
			return null;
		}
	};

	omega.on("session_shutdown", (_event, ctx) => {
		selectedRuntimeTaskId = undefined;
		for (const task of activeTasks.values()) task.controller.abort();
		activeTasks.clear();
		pendingSettlements.clear();
		runtimeViewDepth = 0;
		updateSubagentFooter(ctx, undefined);
		for (const dir of outputArtifactDirs) {
			try {
				fs.rmSync(dir, { recursive: true, force: true });
			} catch {
				// Best-effort cleanup; the OS temp directory remains the fallback lifecycle.
			}
		}
		outputArtifactDirs.clear();
	});

	let discoveredAgents: AgentConfig[] = [];

	const listSubagents = async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
		const discovery = discoverAgentsWithStarter(ctx.cwd, shouldIncludeProjectAgents(ctx.cwd, ctx.isProjectTrusted()));
		const lines = discovery.discovery.agents.map((agent) => {
			const model = agent.model ? ` · ${agent.model}` : "";
			const session = agent.sessionPreference ? ` · ${agent.sessionPreference}` : "";
			return `${agent.name} [${agent.source}]${model}${session} — ${agent.description}`;
		});
		if (discovery.createdAgentPath) lines.push(`Created starter: ${discovery.createdAgentPath}`);
		if (discovery.error) lines.push(discovery.error);
		ctx.ui.notify(lines.join("\n"), discovery.error ? "warning" : "info");
	};

	registerOmegaCommand(omega, "subagent:list", {
		description: "List currently available Omega subagents",
		handler: listSubagents,
	});

	registerOmegaCommand(omega, "subagent:status", {
		description: "Show the Omega subagents feature status",
		handler: async (_args, ctx) => {
			const discovery = discoverAgents(ctx.cwd, "both", shouldIncludeProjectAgents(ctx.cwd, ctx.isProjectTrusted()));
			const agents = discovery.agents.map((agent) => `${agent.name} [${agent.source}]`).join(", ") || "none";
			const runningTasks =
				[...activeTasks.entries()].map(([id, task]) => `${id} (${task.agent})`).join(", ") || "none";
			ctx.ui.notify(
				[
					`Subagents: ${enabled ? "enabled" : "disabled"}`,
					`Tools: ${runtimeEnabled ? "registered" : "not registered"}`,
					`Delegation depth: ${currentDepth}/${maxDepth}`,
					`Cycle guard: ${preventCycles ? "enabled" : "disabled"}`,
					`Available agents (${discovery.agents.length}): ${agents}`,
					`Running tasks (${activeTasks.size}): ${runningTasks}`,
					`Settings file: ${settingsPath}`,
				].join("\n"),
				"info",
			);
		},
	});

	registerOmegaCommand(omega, "subagents:kill", {
		description: "Kill one or all running Omega subagent tasks",
		handler: async (args, ctx) => {
			const taskId = args.trim();
			if (!taskId) {
				const tasks = [...activeTasks.values()];
				for (const task of tasks) task.controller.abort();
				ctx.ui.notify(
					tasks.length > 0
						? `Requested to kill all ${tasks.length} subagent tasks.`
						: "No running subagent tasks.",
					"info",
				);
				return;
			}

			let resolvedTaskId = taskId;
			let task = activeTasks.get(resolvedTaskId);
			if (!task) {
				const matches = [...activeTasks.entries()].filter(([, item]) => item.agent === taskId);
				if (matches.length === 1) {
					[resolvedTaskId, task] = matches[0];
				} else if (matches.length > 1) {
					ctx.ui.notify(
						`Agent ${taskId} has multiple running tasks; specify a task ID: ${matches.map(([id]) => id).join(", ")}`,
						"warning",
					);
					return;
				}
			}
			if (!task) {
				const available = [...activeTasks.entries()].map(([id, item]) => `${id} (${item.agent})`).join(", ");
				ctx.ui.notify(
					available
						? `Task ${taskId} not found. Running tasks: ${available}`
						: `Task ${taskId} not found; there are no running subagent tasks.`,
					"warning",
				);
				return;
			}

			task.controller.abort();
			ctx.ui.notify(`Requested to kill ${resolvedTaskId} (${task.agent}).`, "info");
		},
	});

	registerOmegaCommand(omega, "subagents:send", {
		description: "Send a coordination message to a running Omega subagent",
		handler: async (args, ctx) => {
			const separator = args.search(/\s/u);
			if (separator < 1 || !args.slice(separator).trim()) {
				ctx.ui.notify("Usage: /subagents:send <task ID or unique agent name> <message>", "warning");
				return;
			}
			const sent = sendTaskMessage(args.slice(0, separator), args.slice(separator).trim(), "steer");
			ctx.ui.notify(sent.message, sent.ok ? "info" : "warning");
		},
	});

	registerOmegaCommand(omega, "subagent:settings", {
		description: "Enable or disable the Omega subagents feature",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/subagent:settings requires an interactive UI.", "warning");
				return;
			}
			const selected = await ctx.ui.select("Subagents settings", ["Enable", "Disable"]);
			if (!selected) return;
			const nextEnabled = selected === "Enable";
			if (nextEnabled === enabled) {
				ctx.ui.notify(`Subagents are already ${enabled ? "enabled" : "disabled"}.`, "info");
				return;
			}
			try {
				writeSubagentSettings({ enabled: nextEnabled }, settingsPath);
				ctx.ui.notify(`Subagents ${nextEnabled ? "enabled" : "disabled"}; reloading the extension.`, "info");
				await ctx.reload();
			} catch (error) {
				ctx.ui.notify(`Failed to save Subagents settings: ${String(error)}`, "error");
			}
		},
	});

	if (runtimeEnabled) {
		// Auto-discover agents on session start.
		omega.on("session_start", async (_event, ctx) => {
			const starterDiscovery = discoverAgentsWithStarter(
				ctx.cwd,
				shouldIncludeProjectAgents(ctx.cwd, ctx.isProjectTrusted()),
			);
			const discovery = starterDiscovery.discovery;
			discoveredAgents = discovery.agents;

			if (ctx.hasUI) {
				if (starterDiscovery.createdAgentPath) {
					ctx.ui.notify(
						`Created starter subagent "${STARTER_AGENT_NAME}" at:\n${starterDiscovery.createdAgentPath}\n\nEdit this file or add more agents in the same directory to customize delegation.`,
						"info",
					);
				} else if (starterDiscovery.error && discoveredAgents.length === 0) {
					ctx.ui.notify(`No subagents found. ${starterDiscovery.error}`, "info");
				}
			}
		});

		// Inject available agents into the system prompt.
		omega.on("before_agent_start", async (event) => {
			if (discoveredAgents.length === 0) return;

			return {
				systemPrompt:
					event.systemPrompt +
					formatAvailableSubagentsPrompt(discoveredAgents, {
						currentDepth,
						maxDepth,
						preventCycles,
						ancestorAgentStack,
					}),
			};
		});

		omega.on("tool_result", (event) => {
			if (event.toolName !== "subagent") return;
			const details = event.details as Partial<SubagentDetails> | undefined;
			if (details?.kind === "omega-subagent" && details.failed === true) {
				return { isError: true };
			}
		});
	}

	// Register the subagent tool.
	if (runtimeEnabled) {
		omega.registerTool({
			name: "subagent_status",
			label: "Subagent Status",
			description: "Read current state and latest responses from background subagent tasks.",
			parameters: SubagentStatusParams,
			async execute(_toolCallId, params) {
				const identifier = params.task?.trim();
				let results = [...runtimeResults.values()];
				if (identifier) {
					const byId = runtimeResults.get(identifier);
					results = byId ? [byId] : results.filter((result) => result.agent === identifier);
				}
				if (results.length === 0) {
					return {
						content: [
							{
								type: "text" as const,
								text: identifier ? `Subagent task ${identifier} not found.` : "No subagent run records.",
							},
						],
						details: { results: [] },
						isError: Boolean(identifier),
					};
				}
				const text = results
					.map((result) => {
						const state =
							result.exitCode === -1
								? (result.runtimeState ?? "running")
								: isResultError(result)
									? "failed"
									: "done";
						const output =
							getFinalOutput(result.messages) ||
							result.liveContent
								?.filter((part) => part.type === "text")
								.map((part) => part.text)
								.join("") ||
							"(no output yet)";
						return `${result.taskId ?? "unknown"} (${result.agent}) [${state}]\n${output}`;
					})
					.join("\n\n");
				return { content: [{ type: "text" as const, text }], details: { results }, isError: false };
			},
		});

		omega.registerTool({
			name: "subagent_message",
			label: "Message Subagent",
			description: "Send a steering or follow-up message to a running background subagent task.",
			parameters: SubagentMessageParams,
			async execute(_toolCallId, params) {
				const sent = sendTaskMessage(params.task.trim(), params.message, params.behavior ?? "steer");
				return {
					content: [{ type: "text" as const, text: sent.message }],
					details: { ok: sent.ok, task: params.task },
					isError: !sent.ok,
				};
			},
		});

		omega.registerTool({
			name: "subagent",
			label: "Subagent",
			description: formatSubagentToolDescription(),
			parameters: SubagentParams,

			async execute(_toolCallId, params, _signal, onUpdate, ctx) {
				let agentsWidget: SubagentAgentsWidget | undefined;
				let fleetWidget: SubagentFleetWidget | undefined;
				let fleetEditor: SubagentFleetEditor | undefined;
				let installedFleetEditor = false;
				let runtimeViewerOpen = false;
				let executionFinished = false;
				const parentModel: ParentModel | undefined = ctx.model
					? { provider: ctx.model.provider, id: ctx.model.id }
					: undefined;
				const starterDiscovery = discoverAgentsWithStarter(
					ctx.cwd,
					shouldIncludeProjectAgents(ctx.cwd, ctx.isProjectTrusted()),
				);
				const discovery = starterDiscovery.discovery;
				const { agents } = discovery;
				const makeDetails = makeDetailsFactory(discovery.projectAgentsDir);

				const normalized = normalizeCalls(params.calls, ctx.cwd);
				if (normalized.error || !normalized.calls) {
					return {
						content: [{ type: "text", text: normalized.error ?? "Invalid subagent parameters." }],
						details: makeDetails([], true),
					};
				}
				const calls = normalized.calls;

				attachSessionIdentities(calls, ctx.sessionManager.getSessionId());

				const duplicateSessionError = getDuplicateSessionError(calls);
				if (duplicateSessionError) {
					return {
						content: [{ type: "text", text: duplicateSessionError }],
						details: makeDetails([], true),
					};
				}

				const parentSessionError = getNamedSessionParentError(calls, ctx as ExtensionExecutionContext);
				if (parentSessionError) {
					return {
						content: [{ type: "text", text: parentSessionError }],
						details: makeDetails([], true),
					};
				}

				const requested = new Set(calls.map((call) => call.agent));

				if (preventCycles) {
					const cycleViolations = getCycleViolations(requested, ancestorAgentStack);
					if (cycleViolations.length > 0) {
						const stackText = ancestorAgentStack.length > 0 ? ancestorAgentStack.join(" -> ") : "(root)";
						return {
							content: [
								{
									type: "text",
									text: `Blocked: delegation cycle detected. Requested agent(s) already in the delegation stack: ${cycleViolations.join(", ")}.
Current stack: ${stackText}

This guard prevents self-recursion and cyclic handoffs (for example A -> B -> A).`,
								},
							],
							details: makeDetails([], true),
						};
					}
				}

				const persistentSessionDir = getPersistentSessionDir(ctx as ExtensionExecutionContext);

				const activeSessionError = getActiveSessionError(calls, activeSessionIds);
				if (activeSessionError) {
					return {
						content: [{ type: "text", text: activeSessionError }],
						details: makeDetails([], true),
					};
				}

				const lockResult = acquireSessionLocks(getSessionLockTargets(calls, persistentSessionDir));
				if (lockResult.error) {
					return {
						content: [{ type: "text", text: lockResult.error }],
						details: makeDetails([], true),
					};
				}

				const reservedSessionIds = calls.map((call) => call.session?.id).filter((id): id is string => Boolean(id));
				for (const id of reservedSessionIds) activeSessionIds.add(id);
				let backgroundStarted = false;

				try {
					try {
						await resolveSessionCreationState(calls, persistentSessionDir);
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						return {
							content: [
								{
									type: "text",
									text: `Failed to inspect existing subagent sessions: ${message}`,
								},
							],
							details: makeDetails([], true),
						};
					}

					let parentSessionSnapshotJsonl: string | undefined;
					if (needsParentSnapshot(calls)) {
						const snapshot = buildParentSessionSnapshotJsonl(ctx.sessionManager);
						if (!snapshot) {
							return {
								content: [
									{
										type: "text",
										text: 'Cannot run subagent calls: failed to snapshot current parent session context for calls requiring initialContext="parent".',
									},
								],
								details: makeDetails([], true),
							};
						}
						parentSessionSnapshotJsonl = snapshot;
					}

					// A new run owns the runtime panel: forget agents from earlier runs so they are not
					// re-rendered next to this run's calls. Tasks that are still running (a background
					// run can overlap this one) stay visible.
					pruneFinishedRuntimeTasks();
					ctx.ui.setWidget(
						"omega.subagents.agents",
						(tui, theme) => {
							agentsWidget = new SubagentAgentsWidget(tui, theme);
							return agentsWidget;
						},
						{ placement: "aboveEditor" },
					);
					const activateFleetWidget = () => {
						if (fleetWidget) return fleetWidget;
						ctx.ui.setWidget(
							"omega.subagents.fleet",
							(tui, theme) => {
								fleetWidget = new SubagentFleetWidget(tui, theme);
								return fleetWidget;
							},
							{ placement: "belowEditor" },
						);
						return fleetWidget;
					};
					const deactivateFleetWidget = () => {
						ctx.ui.setWidget("omega.subagents.fleet", undefined);
						fleetWidget = undefined;
					};
					const restoreFleetEditor = () => {
						if (!installedFleetEditor) return;
						installedFleetEditor = false;
						fleetEditor?.focusMain();
						fleetEditor = undefined;
						ctx.ui.setEditorComponent(undefined);
					};
					const openRuntimeViewer = (initialSelection: number) => {
						if (runtimeViewerOpen) return;
						runtimeViewerOpen = true;
						runtimeViewDepth++;
						void ctx.ui
							.custom<void>(
								(tui, theme, keybindings, done) =>
									new SubagentConversationView(
										() => latestRuntimeResults,
										tui,
										theme,
										keybindings,
										() => {
											selectRuntimeTask(undefined);
											done();
										},
										initialSelection,
										(index) => {
											selectRuntimeTask(latestRuntimeResults[index]?.taskId);
											agentsWidget?.setSelection(index);
											fleetWidget?.setSelection(index);
										},
										(taskId, prompt) => {
											const sent = sendTaskMessage(taskId, prompt, "follow_up");
											if (!sent.ok) ctx.ui.notify(sent.message, "warning");
										},
									),
								SUBAGENT_VIEW_OVERLAY,
							)
							.catch((error) => ctx.ui.notify(`Failed to open the subagent run view: ${String(error)}`, "error"))
							.finally(() => {
								runtimeViewerOpen = false;
								runtimeViewDepth = Math.max(0, runtimeViewDepth - 1);
								fleetEditor?.focusMain();
								flushPendingSettlements();
								if (executionFinished) restoreFleetEditor();
							});
					};
					if (!ctx.ui.getEditorComponent()) {
						ctx.ui.setEditorComponent((tui, theme, keybindings) => {
							fleetEditor = new SubagentFleetEditor(
								tui,
								theme,
								keybindings,
								() => latestRuntimeResults,
								() => fleetWidget,
								activateFleetWidget,
								deactivateFleetWidget,
								openRuntimeViewer,
								(selected) => {
									if (selected !== undefined) {
										selectRuntimeTask(latestRuntimeResults[selected]?.taskId);
										runtimeViewDepth++;
										return;
									}
									selectRuntimeTask(undefined);
									runtimeViewDepth = Math.max(0, runtimeViewDepth - 1);
									flushPendingSettlements();
								},
							);
							return fleetEditor;
						});
						installedFleetEditor = true;
					}
					const updateRuntime = (partial: AgentToolResult<SubagentDetails>) => {
						const currentResults = publishRuntimeResults(partial.details.results);
						queueSettledRuntimeResults(partial.details.results);
						// Settled tasks stay in runtimeResults for the viewer and status tools,
						// but the live Agents widget must not keep listing finished runs.
						agentsWidget?.setResults(currentResults.filter((result) => result.exitCode === -1));
						fleetWidget?.setResults(currentResults);
						updateSubagentFooter(ctx, currentResults);
						onUpdate?.(partial);
					};
					const cleanupRuntime = () => {
						executionFinished = true;
						updateSubagentFooter(ctx, undefined);
						ctx.ui.setWidget("omega.subagents.agents", undefined);
						deactivateFleetWidget();
						if (!runtimeViewerOpen) restoreFleetEditor();
					};
					backgroundStarted = true;
					const backgroundExecution = executeCalls(
						calls,
						parentSessionSnapshotJsonl,
						persistentSessionDir,
						parentModel,
						agents,
						ctx.cwd,
						undefined,
						updateRuntime,
						makeDetails,
					);
					void backgroundExecution
						.then((result) => {
							publishRuntimeResults(result.details.results);
							ctx.ui.notify("Subagent background run finished.", result.details.failed ? "warning" : "info");
						})
						.catch((error) => ctx.ui.notify(`Subagent background run failed: ${String(error)}`, "error"))
						.finally(() => {
							cleanupRuntime();
							for (const id of reservedSessionIds) activeSessionIds.delete(id);
							releaseSessionLocks(lockResult.locks);
						});

					const launched = calls.map(makePlaceholderResult);
					publishRuntimeResults(launched);
					return {
						content: [
							{
								type: "text" as const,
								text: `Started ${launched.length} subagent task(s) in the background: ${launched.map((result) => `${result.taskId} (${result.agent})`).join(", ")}. The main agent can continue with other tasks and coordinate via subagent_message.`,
							},
						],
						details: makeDetails(launched),
					};
				} finally {
					if (!backgroundStarted) {
						for (const id of reservedSessionIds) activeSessionIds.delete(id);
						releaseSessionLocks(lockResult.locks);
					}
				}
			},

			renderCall: (args, theme) => renderCall(args, theme),
			renderResult: (result, { expanded }, theme) => renderResult(result, expanded, theme),
		});
	}

	// -----------------------------------------------------------------------
	// Call execution
	// -----------------------------------------------------------------------

	async function executeCalls(
		calls: NormalizedCall[],
		parentSessionSnapshotJsonl: string | undefined,
		persistentSessionDir: string | undefined,
		parentModel: ParentModel | undefined,
		agents: AgentConfig[],
		defaultCwd: string,
		signal: AbortSignal | undefined,
		onUpdate: ((partial: AgentToolResult<SubagentDetails>) => void) | undefined,
		makeDetails: ReturnType<typeof makeDetailsFactory>,
	) {
		const taskControllers = calls.map((call) => {
			const taskId = `subagent-${nextTaskId++}`;
			const controller = new AbortController();
			call.taskId = taskId;
			activeTasks.set(taskId, { agent: call.agent, controller });
			return { taskId, controller };
		});
		const abortAllTasks = () => {
			for (const task of taskControllers) task.controller.abort();
		};
		if (signal?.aborted) abortAllTasks();
		else signal?.addEventListener("abort", abortAllTasks, { once: true });
		const allResults: SingleResult[] = calls.map(makePlaceholderResult);

		const emitProgress = () => {
			if (!onUpdate) return;
			const running = allResults.filter((r) => r.exitCode === -1).length;
			const done = allResults.filter((r) => r.exitCode !== -1).length;
			try {
				onUpdate({
					content: [
						{
							type: "text",
							text: `Subagents: ${done}/${allResults.length} done, ${running} running...`,
						},
					],
					details: makeDetails([...allResults]),
				});
			} catch (error) {
				console.warn(`[omega-subagent] Progress callback failed: ${String(error)}`);
			}
		};

		let heartbeat: NodeJS.Timeout | undefined;
		if (onUpdate) {
			emitProgress();
			heartbeat = setInterval(() => {
				if (allResults.some((r) => r.exitCode === -1)) emitProgress();
			}, CALLS_HEARTBEAT_MS);
		}

		let results: SingleResult[];
		try {
			results = await mapConcurrent(calls, MAX_CONCURRENCY, async (call, workerIndex) => {
				const taskController = taskControllers[workerIndex];
				let result: SingleResult;
				try {
					result = await runAgentImpl({
						taskId: taskController.taskId,
						cwd: defaultCwd,
						agents,
						callIndex: call.index,
						agentName: call.agent,
						prompt: call.prompt,
						callModel: call.model,
						parentModel,
						callCwd: call.effectiveCwd,
						initialContext: call.initialContext,
						parentSessionSnapshotJsonl,
						session: call.session,
						persistentSessionDir,
						parentDepth: currentDepth,
						parentAgentStack: ancestorAgentStack,
						maxDepth,
						preventCycles,
						inactivityTimeoutMs: call.inactivityTimeoutMs,
						timeoutMs: call.timeoutMs,
						signal: taskController.controller.signal,
						// Idle runtimes are closed as soon as a turn settles; the runtime viewer
						// re-enables keep-alive for whichever task it currently has selected.
						keepAlive: false,
						onControlReady: (control) => {
							const activeTask = activeTasks.get(taskController.taskId);
							if (activeTask) {
								activeTask.control = control;
								control.setKeepAlive(selectedRuntimeTaskId === taskController.taskId);
							}
						},
						onUpdate: (partial) => {
							if (partial.details?.results[0]) {
								allResults[workerIndex] = partial.details.results[0];
								emitProgress();
							}
						},
						makeDetails,
					});
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					result = {
						...makePlaceholderResult(call),
						exitCode: 1,
						stderr: message,
						stopReason: "error",
						errorMessage: message,
						processError: true,
					};
				}
				allResults[workerIndex] = result;
				emitProgress();
				return result;
			});
		} finally {
			if (heartbeat) clearInterval(heartbeat);
			signal?.removeEventListener("abort", abortAllTasks);
			for (const task of taskControllers) {
				// Deleting the entry also drops the only handle that can release keep-alive, so an
				// idle runtime that was selected in the viewer would otherwise keep its process alive
				// forever. Release it first; a still-running task ignores this and is aborted elsewhere.
				activeTasks.get(task.taskId)?.control?.setKeepAlive(false);
				activeTasks.delete(task.taskId);
			}
		}

		const hasErrors = results.some((r) => isResultError(r));
		const summary = formatCallsSummary(results, saveFullOutput);
		return {
			content: [
				{
					type: "text" as const,
					text: summary.text,
				},
			],
			details: makeDetails(results, hasErrors),
		};
	}
}

export type { AgentConfig, AgentScope, AgentSource } from "./agents.ts";
export type { SingleResult as SubagentResult } from "./types.ts";
