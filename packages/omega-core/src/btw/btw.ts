import {
	type Api,
	clampThinkingLevel,
	getSupportedThinkingLevels,
	type Model,
	type ProviderHeaders,
} from "@earendil-works/pi-ai";
import { BorderedLoader, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { OmegaAPI } from "../api.ts";
import { registerOmegaCommand } from "../commands/register.ts";
import { type RunBtwFullscreen, runBtwFullscreen } from "./fullscreen-ui.ts";
import { type BtwCommandMenuResult, type BtwResumeThreadSummary, showBtwCommandMenu } from "./menu.ts";
import {
	type BtwSettings,
	effectiveRememberThinkingLevelChanges,
	parseBtwModelReference,
	readBtwSettings,
	updateBtwSettings,
} from "./settings.ts";
import {
	BTW_THINKING_LEVELS,
	type BtwThinkingLevel,
	type CompleteSimpleFunction,
	completeSideThreadTurn,
	createSideThread,
	type SideQuestionAuth,
	type SideThread,
} from "./side-thread.ts";
import { sanitizeSingleLine } from "./text.ts";
import {
	BtwAnsweringView,
	BtwLogView,
	type BtwThinkingControl,
	BtwTranscriptPager,
	type TranscriptPagerAction,
} from "./transcript-pager.ts";

export {
	BTW_SETTINGS_FILE,
	type BtwSettings,
	type BtwSettingsLoadResult,
	normalizeBtwSettings,
	parseBtwModelReference,
	readBtwSettings,
} from "./settings.ts";
export {
	BTW_THINKING_LEVELS,
	type BtwThinkingLevel,
	buildUserPrompt,
	completeSideQuestion,
} from "./side-thread.ts";
export { sanitizeSingleLine } from "./text.ts";

const MAX_CONTEXT_CHARS = 40_000;

interface LoadBtwThinkingLevelOptions {
	settingsPath?: string;
	warn?: (message: string) => void;
}

type BtwModelRegistry = Pick<ExtensionCommandContext["modelRegistry"], "find" | "getApiKeyAndHeaders">;

type BtwProviderRegistry = Pick<ExtensionCommandContext["modelRegistry"], "getProvider">;

export function createModelRegistryCompleteSimple(modelRegistry: BtwProviderRegistry): CompleteSimpleFunction {
	return async (model, context, options) => {
		const provider = modelRegistry.getProvider(model.provider);
		if (!provider) throw new Error(`No provider registered for model provider: ${model.provider}`);
		return provider.streamSimple(model, context, options).result();
	};
}

interface ResolveBtwModelOptions {
	settings: BtwSettings;
	currentModel: Model<Api> | undefined;
	modelRegistry: BtwModelRegistry;
	warn?: (message: string) => void;
}

export interface ResolvedBtwModel {
	model: Model<Api>;
	auth: SideQuestionAuth;
}

export interface BtwThreadState {
	id: string;
	title?: string;
	thread: SideThread;
	thinkingLevel: BtwThinkingLevel;
	createdAt: number;
	updatedAt: number;
}

export async function resolveBtwModel({
	settings,
	currentModel,
	modelRegistry,
	warn,
}: ResolveBtwModelOptions): Promise<ResolvedBtwModel | undefined> {
	const reportWarning = (message: string) => warn?.(sanitizeSingleLine(message));
	if (settings.model) {
		const fallback = currentModel ? `${currentModel.provider}/${currentModel.id}` : "the current model";
		const reference = parseBtwModelReference(settings.model);
		if (!reference) {
			reportWarning(`Omega BTW model ${settings.model} is invalid; falling back to ${fallback}.`);
			return resolveBtwModel({ settings: {}, currentModel, modelRegistry, warn: reportWarning });
		}
		const configuredModel = modelRegistry.find(reference.provider, reference.modelId);
		if (!configuredModel) {
			reportWarning(`Omega BTW model ${settings.model} was not found; falling back to ${fallback}.`);
		} else {
			const sameAsCurrent =
				configuredModel === currentModel ||
				(configuredModel.provider === currentModel?.provider && configuredModel.id === currentModel.id);
			const fallbackAction = sameAsCurrent
				? "no distinct current model is available"
				: `falling back to ${fallback}`;
			try {
				const auth = await modelRegistry.getApiKeyAndHeaders(configuredModel);
				if (auth.ok && hasRequestAuth(auth)) return { model: configuredModel, auth };
				const reason = auth.ok ? "has no request credentials" : auth.error;
				reportWarning(`Omega BTW model ${settings.model} is unavailable (${reason}); ${fallbackAction}.`);
			} catch (error: unknown) {
				reportWarning(
					`Omega BTW model ${settings.model} credentials failed (${formatError(error)}); ${fallbackAction}.`,
				);
			}
			if (sameAsCurrent) return undefined;
		}
	}

	if (!currentModel) return undefined;
	try {
		const auth = await modelRegistry.getApiKeyAndHeaders(currentModel);
		if (auth.ok && hasRequestAuth(auth)) return { model: currentModel, auth };
	} catch {
		// The caller reports the final lack of an available model.
	}
	return undefined;
}

function hasRequestAuth(auth: SideQuestionAuth): boolean {
	return Boolean(
		auth.apiKey || providerHeadersHaveValue(auth.headers) || (auth.env && Object.keys(auth.env).length > 0),
	);
}

function providerHeadersHaveValue(headers: ProviderHeaders | undefined): boolean {
	return headers !== undefined && Object.values(headers).some((value) => value !== null);
}

export async function loadBtwThinkingLevel(
	currentThinkingLevel: BtwThinkingLevel,
	options: LoadBtwThinkingLevelOptions = {},
): Promise<BtwThinkingLevel> {
	const settings = await readBtwSettings(options.settingsPath);
	if (settings.kind === "missing") return currentThinkingLevel;
	if (settings.kind === "loaded") {
		return settings.settings.thinkingLevel ?? currentThinkingLevel;
	}

	options.warn?.(
		sanitizeSingleLine(
			`Omega BTW settings ignored: ${settings.reason}; expected optional model "provider/model-id", omitted thinkingLevel for Same as main thread or thinkingLevel "${BTW_THINKING_LEVELS.join('" | "')}", and boolean rememberThinkingLevelChanges. Using current Omega thinking level.`,
		),
	);
	return currentThinkingLevel;
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function notifySafely(
	ctx: ExtensionCommandContext,
	message: string,
	level: Parameters<ExtensionCommandContext["ui"]["notify"]>[1],
): void {
	try {
		ctx.ui.notify(sanitizeSingleLine(message), level);
	} catch {
		// Async command continuations may finish after their ExtensionContext is replaced.
	}
}

export interface BtwExtensionDependencies {
	showCommandMenu?: (
		omega: OmegaAPI,
		ctx: ExtensionCommandContext,
		resumeThreads: readonly BtwResumeThreadSummary[],
	) => Promise<BtwCommandMenuResult>;
	loadSettings?: typeof loadSettingsForCommand;
	resolveModel?: typeof resolveBtwModelWithLoader;
	runThread?: typeof runBtwThread;
	runFullscreen?: RunBtwFullscreen;
	runLog?: RunBtwFullscreen;
}

export function registerBtw(omega: OmegaAPI, dependencies: BtwExtensionDependencies = {}): void {
	const showCommandMenu = dependencies.showCommandMenu ?? showCommandMenuForBtw;
	const loadSettings = dependencies.loadSettings ?? loadSettingsForCommand;
	const resolveModel = dependencies.resolveModel ?? resolveBtwModelWithLoader;
	const runThread = dependencies.runThread ?? runBtwThread;
	const runFullscreen = dependencies.runFullscreen ?? runBtwFullscreen;
	const runLog = dependencies.runLog ?? runBtwFullscreen;
	// Pi creates a fresh extension instance after session replacement or reload.
	const resumableThreads = new Map<string, BtwThreadState>();
	let nextThreadNumber = 1;
	const listResumeThreads = (): BtwResumeThreadSummary[] =>
		[...resumableThreads.values()]
			.reverse()
			.filter((state) => state.thread.turns.length > 0 && state.title)
			.sort((first, second) => second.updatedAt - first.updatedAt || second.createdAt - first.createdAt)
			.map((state) => ({
				id: state.id,
				title: state.title ?? "Untitled side thread",
				questionCount: state.thread.turns.length,
			}));
	registerOmegaCommand(omega, "btw", {
		description: "Ask a quick side question without adding it to the main conversation",
		handler: async (args, ctx) => {
			const question = args.trim();
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/btw requires interactive TUI mode", "error");
				return;
			}

			let menuResult: BtwCommandMenuResult = "start";
			if (!question) {
				menuResult = await showCommandMenu(omega, ctx, listResumeThreads());
				if (menuResult === "closed") return;
			}

			const settings = await loadSettings(ctx);
			const sameAsMainThinkingLevel = settings.thinkingLevel === undefined;
			const resolution = await resolveModel(settings, ctx);
			if (resolution.kind === "cancelled") {
				notifySafely(ctx, "Cancelled", "info");
				return;
			}
			if (resolution.kind === "unavailable") {
				notifySafely(ctx, "No available model for /btw", "error");
				return;
			}

			let state = typeof menuResult === "object" ? resumableThreads.get(menuResult.threadId) : undefined;
			if (typeof menuResult === "object" && !state) {
				notifySafely(ctx, "The selected /btw side thread is no longer available", "warning");
				return;
			}
			const startingTurnCount = state?.thread.turns.length ?? 0;

			try {
				await runFullscreen(ctx, (fullscreenCtx) => {
					if (!state) {
						const createdAt = Date.now();
						state = {
							id: `btw-${nextThreadNumber}`,
							thread: createSideThread(),
							thinkingLevel: settings.thinkingLevel ?? omega.getThinkingLevel(),
							createdAt,
							updatedAt: createdAt,
						};
						nextThreadNumber += 1;
					}
					return runThread({
						initialQuestion: question || undefined,
						selected: resolution.selected,
						thinkingLevel: state.thinkingLevel,
						rememberThinkingLevelChanges:
							!sameAsMainThinkingLevel && effectiveRememberThinkingLevelChanges(settings),
						state,
						ctx: fullscreenCtx,
					});
				});
			} finally {
				if (state?.title && state.thread.turns.length > 0) {
					if (state.thread.turns.length > startingTurnCount) {
						resumableThreads.delete(state.id);
					}
					resumableThreads.set(state.id, state);
				}
			}
		},
	});
	registerOmegaCommand(omega, "btw:log", {
		description: "View BTW side-thread conversation history",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/btw:log requires interactive TUI mode", "error");
				return;
			}
			const entries = [...resumableThreads.values()]
				.filter((state) => state.thread.turns.length > 0)
				.sort((first, second) => second.updatedAt - first.updatedAt || second.createdAt - first.createdAt)
				.map((state) => ({
					id: state.id,
					title: state.title ?? "Untitled side thread",
					turns: state.thread.turns,
					updatedAt: state.updatedAt,
				}));
			if (entries.length === 0) {
				notifySafely(ctx, "No BTW conversation history is available.", "info");
				return;
			}
			await runLog(ctx, (logCtx) =>
				logCtx.ui.custom(
					(tui, theme, _keybindings, done) => new BtwLogView(tui, theme, entries, () => done(undefined)),
				),
			);
		},
	});
}

async function showCommandMenuForBtw(
	omega: OmegaAPI,
	ctx: ExtensionCommandContext,
	resumeThreads: readonly BtwResumeThreadSummary[],
): Promise<BtwCommandMenuResult> {
	const currentModel = ctx.model;
	const availableModels = ctx.modelRegistry.getAll();
	const currentThinkingLevel = omega.getThinkingLevel();
	const loaded = await readBtwSettings();
	const settings = loaded.kind === "loaded" ? loaded.settings : {};
	const configured = settings.model ? parseBtwModelReference(settings.model) : undefined;
	const configuredModel = configured
		? availableModels.find((model) => model.provider === configured.provider && model.id === configured.modelId)
		: undefined;
	const model = configuredModel ?? currentModel;
	return showBtwCommandMenu(ctx, {
		currentThinkingLevel,
		availableThinkingLevels: model ? getSupportedThinkingLevels(model) : BTW_THINKING_LEVELS,
		resumeThreads,
	});
}

async function loadSettingsForCommand(ctx: ExtensionCommandContext): Promise<BtwSettings> {
	const settingsResult = await readBtwSettings();
	if (settingsResult.kind === "loaded") return settingsResult.settings;
	if (settingsResult.kind === "invalid") {
		notifySafely(ctx, `Omega BTW settings ignored: ${settingsResult.reason}`, "warning");
	}
	return {};
}

type ModelResolutionOutcome =
	| { kind: "cancelled" }
	| { kind: "unavailable" }
	| { kind: "selected"; selected: ResolvedBtwModel };

async function resolveBtwModelWithLoader(
	settings: BtwSettings,
	ctx: ExtensionCommandContext,
): Promise<ModelResolutionOutcome> {
	return ctx.ui.custom<ModelResolutionOutcome>((tui, theme, _keybindings, done) => {
		const loader = new BorderedLoader(tui, theme, "Resolving /btw model credentials...");
		let settled = false;
		loader.onAbort = () => {
			if (settled) return;
			settled = true;
			done({ kind: "cancelled" });
		};

		resolveBtwModel({
			settings,
			currentModel: ctx.model,
			modelRegistry: ctx.modelRegistry,
			warn: (message) => {
				if (!settled) notifySafely(ctx, message, "warning");
			},
		})
			.then((selected) => {
				if (settled) return;
				settled = true;
				done(selected ? { kind: "selected", selected } : { kind: "unavailable" });
			})
			.catch(() => {
				if (settled) return;
				settled = true;
				done({ kind: "unavailable" });
			});

		return loader;
	});
}

interface RunBtwThreadDependencies {
	ask?: typeof askThreadQuestion;
	interact?: typeof showThreadComposer;
	persistThinkingLevel?: (level: BtwThinkingLevel) => Promise<unknown>;
	now?: () => number;
}

export type BtwThreadResult = { kind: "closed" };

type BtwThreadThinkingControl = Omit<BtwThinkingControl, "keybindings">;

interface BtwThreadSteeringControl {
	questions: readonly string[];
	submit: (question: string) => void;
	thinking: BtwThreadThinkingControl;
}

interface RunBtwThreadOptions {
	initialQuestion?: string;
	selected: ResolvedBtwModel;
	thinkingLevel: BtwThinkingLevel;
	rememberThinkingLevelChanges?: boolean;
	settingsPath?: string;
	state?: BtwThreadState;
	ctx: ExtensionCommandContext;
	dependencies?: RunBtwThreadDependencies;
}

export async function runBtwThread({
	initialQuestion,
	selected,
	thinkingLevel,
	rememberThinkingLevelChanges = false,
	settingsPath,
	state,
	ctx,
	dependencies = {},
}: RunBtwThreadOptions): Promise<BtwThreadResult> {
	const ask = dependencies.ask ?? askThreadQuestion;
	const interact = dependencies.interact ?? showThreadComposer;
	const persistThinkingLevel =
		dependencies.persistThinkingLevel ??
		((level: BtwThinkingLevel) => updateBtwSettings({ thinkingLevel: level }, { settingsPath }));
	const now = dependencies.now ?? Date.now;
	const thread = state?.thread ?? createSideThread();
	const thinkingLevels = getSupportedThinkingLevels(selected.model);
	const pendingWrites = new Set<Promise<void>>();
	const steeringQuestions: string[] = [];
	let activeThinkingLevel = clampThinkingLevel(selected.model, state?.thinkingLevel ?? thinkingLevel);
	if (state) state.thinkingLevel = activeThinkingLevel;
	let pendingQuestion = initialQuestion;
	let composerDraft: string | undefined;
	const createThinkingControl = (): BtwThreadThinkingControl => ({
		level: activeThinkingLevel,
		levels: thinkingLevels,
		onChange: (level) => {
			if (!thinkingLevels.includes(level)) return;
			activeThinkingLevel = level;
			if (state) state.thinkingLevel = level;
			if (!rememberThinkingLevelChanges) return;
			let write!: Promise<void>;
			write = Promise.resolve()
				.then(() => persistThinkingLevel(level))
				.then(() => undefined)
				.catch((error: unknown) => {
					notifySafely(
						ctx,
						`Thinking level changed to ${level}, but could not be remembered in omega-btw.json: ${formatError(error)}`,
						"warning",
					);
				})
				.finally(() => pendingWrites.delete(write));
			pendingWrites.add(write);
		},
	});

	try {
		while (true) {
			if (!pendingQuestion) {
				const action = await interact(thread, thread.turns.length > 0, ctx, composerDraft, createThinkingControl());
				if (action.kind === "close") return { kind: "closed" };
				composerDraft = undefined;
				pendingQuestion = action.question;
			}

			const result = await ask(thread, pendingQuestion, selected, activeThinkingLevel, ctx, {
				questions: steeringQuestions,
				submit: (question) => steeringQuestions.push(question),
				thinking: createThinkingControl(),
			});
			if (result.kind === "aborted") {
				notifySafely(ctx, "Cancelled", "info");
				return { kind: "closed" };
			}
			if (result.kind === "error") {
				thread.turns.push({
					kind: "error",
					question: pendingQuestion,
					answer: result.message,
				});
			}
			if (state) {
				state.title ||= sanitizeSingleLine(pendingQuestion) || "Untitled side thread";
				state.updatedAt = now();
			}

			pendingQuestion = steeringQuestions.shift();
		}
	} finally {
		await Promise.allSettled([...pendingWrites]);
	}
}

async function askThreadQuestion(
	thread: SideThread,
	question: string,
	selected: ResolvedBtwModel,
	thinkingLevel: BtwThinkingLevel,
	ctx: ExtensionCommandContext,
	steering: BtwThreadSteeringControl,
) {
	return ctx.ui.custom<Awaited<ReturnType<typeof completeSideThreadTurn>>>((tui, theme, keybindings, done) => {
		let settled = false;
		const view = new BtwAnsweringView(
			tui,
			theme,
			thread.turns,
			question,
			() => {
				if (settled) return;
				settled = true;
				done({ kind: "aborted" });
			},
			thinkingLevel,
			{
				steering: {
					questions: steering.questions,
					onSubmit: steering.submit,
					thinking: { ...steering.thinking, keybindings },
				},
			},
		);
		completeSideThreadTurn({
			thread,
			question,
			model: selected.model,
			thinkingLevel,
			auth: selected.auth,
			signal: view.signal,
			completeSimple: createModelRegistryCompleteSimple(ctx.modelRegistry),
		}).then((result) => {
			if (settled) return;
			settled = true;
			view.finish();
			done(result);
		});
		return view;
	});
}

async function showThreadComposer(
	thread: SideThread,
	startAtBottom: boolean,
	ctx: ExtensionCommandContext,
	initialQuestion: string | undefined,
	thinking: BtwThreadThinkingControl,
): Promise<TranscriptPagerAction> {
	return ctx.ui.custom<TranscriptPagerAction>(
		(tui, theme, keybindings, done) =>
			new BtwTranscriptPager(tui, theme, thread.turns, done, {
				startAtBottom,
				initialQuestion,
				thinking: { ...thinking, keybindings },
			}),
	);
}

type MessageContentBlock = {
	type?: string;
	text?: string;
	name?: string;
	arguments?: unknown;
	result?: unknown;
};

type SessionMessage = {
	role?: string;
	content?: unknown;
	stopReason?: string;
};

type SessionEntry = {
	type: string;
	message?: SessionMessage;
};

/** Shared conversation projection used by /study; BTW itself never calls this. */
export function buildConversationContext(entries: readonly SessionEntry[]): string {
	const sections: string[] = [];
	for (const entry of entries) {
		if (entry.type !== "message" || !entry.message?.role) continue;
		const role = entry.message.role;
		if (role !== "user" && role !== "assistant") continue;
		const contentLines = extractContentLines(entry.message.content);
		if (contentLines.length === 0) continue;
		const label = role === "user" ? "User" : "Assistant";
		const status =
			entry.message.stopReason && entry.message.stopReason !== "stop" ? ` (${entry.message.stopReason})` : "";
		sections.push(`${label}${status}: ${contentLines.join("\n")}`);
	}
	return truncateFromStart(sections.join("\n\n"), MAX_CONTEXT_CHARS);
}

function extractContentLines(content: unknown): string[] {
	if (typeof content === "string") return [content.trim()].filter(Boolean);
	if (!Array.isArray(content)) return [];
	const lines: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const block = part as MessageContentBlock;
		if (block.type === "text" && typeof block.text === "string") lines.push(block.text.trim());
		else if (block.type === "toolCall" && typeof block.name === "string") {
			lines.push(`Tool call: ${block.name}(${formatJson(block.arguments)})`);
		} else if (block.type === "toolResult" && typeof block.name === "string") {
			lines.push(`Tool result from ${block.name}: ${formatJson(block.result)}`);
		}
	}
	return lines.filter(Boolean);
}

function formatJson(value: unknown): string {
	if (value === undefined) return "";
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function truncateFromStart(text: string, maxChars: number): string {
	return text.length <= maxChars
		? text
		: `[Earlier context omitted; showing the last ${maxChars} characters.]\n${text.slice(-maxChars)}`;
}
