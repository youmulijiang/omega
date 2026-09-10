import type { ExtensionCommandContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { defineMenu, type MenuContext, type RunMenuResult, runMenu } from "@narumitw/pi-tui-kit";
import {
	type BtwSettings,
	type BtwSettingsPatch,
	btwSettingsPath,
	effectiveRememberThinkingLevelChanges,
	readBtwSettings,
	type UpdateBtwSettingsOptions,
	updateBtwSettings,
} from "./settings.ts";
import { BTW_THINKING_LEVELS, type BtwThinkingLevel } from "./side-thread.ts";
import { sanitizeSingleLine } from "./text.ts";

interface BtwMenuState {
	kind: "valid" | "invalid";
	settings: BtwSettings;
	reason?: string;
}

export interface BtwResumeThreadSummary {
	id: string;
	title: string;
	questionCount: number;
}

export interface ShowBtwCommandMenuOptions {
	currentThinkingLevel: BtwThinkingLevel;
	availableThinkingLevels: readonly BtwThinkingLevel[];
	resumeThreads?: readonly BtwResumeThreadSummary[];
	settingsPath?: string;
	readSettings?: typeof readBtwSettings;
	updateSettings?: (patch: BtwSettingsPatch, options: UpdateBtwSettingsOptions) => Promise<BtwSettings>;
}

export type BtwCommandMenuResult = "start" | "closed" | { kind: "resume"; threadId: string };

type BtwMenuScreen = "main" | "resume" | "settings" | "invalid";
type BtwMenuAction = "start" | "resume" | "set-thinking" | "set-remember";
const SAME_AS_MAIN_THREAD = "Same as main thread";
export async function showBtwCommandMenu(
	ctx: ExtensionCommandContext,
	options: ShowBtwCommandMenuOptions,
): Promise<BtwCommandMenuResult> {
	if (ctx.mode !== "tui") return "closed";
	if (ctx.signal?.aborted) return "closed";
	const settingsPath = options.settingsPath ?? btwSettingsPath();
	const readSettings = options.readSettings ?? readBtwSettings;
	const updateSettings = options.updateSettings ?? updateBtwSettings;
	const levels =
		options.availableThinkingLevels.length > 0
			? [...options.availableThinkingLevels]
			: (["off"] satisfies BtwThinkingLevel[]);
	const displaySettingsPath = sanitizeSingleLine(settingsPath);
	const resumeThreads = options.resumeThreads ?? [];
	let startSelected = false;
	let resumedThreadId: string | undefined;

	const loadState = async (): Promise<BtwMenuState> => {
		const loaded = await readSettings(settingsPath);
		if (loaded.kind === "invalid") {
			return { kind: "invalid", settings: {}, reason: loaded.reason };
		}
		return { kind: "valid", settings: loaded.kind === "loaded" ? loaded.settings : {} };
	};
	const currentMainThinkingLevel = clampToAvailableThinkingLevel(options.currentThinkingLevel, levels);
	const displayThinkingLevel = (settings: BtwSettings): string =>
		settings.thinkingLevel === undefined
			? SAME_AS_MAIN_THREAD
			: clampToAvailableThinkingLevel(settings.thinkingLevel, levels);
	const displayThinkingSummary = (settings: BtwSettings): string =>
		settings.thinkingLevel === undefined
			? `${SAME_AS_MAIN_THREAD} (currently ${currentMainThinkingLevel})`
			: displayThinkingLevel(settings);
	const displayRememberSummary = (settings: BtwSettings): string => {
		const value = effectiveRememberThinkingLevelChanges(settings) ? "On" : "Off";
		return settings.thinkingLevel === undefined ? `${value} (fixed levels only)` : value;
	};

	const menu = defineMenu<BtwMenuState, BtwMenuScreen, BtwMenuAction, MenuContext>({
		start: "main",
		screens: {
			main: ({ state }) => ({
				kind: "actions",
				title: "Omega BTW",
				lines: [
					`Thinking: ${displayThinkingSummary(state.settings)} · Remember changes: ${displayRememberSummary(state.settings)}`,
				],
				items: [
					{
						id: "start",
						label: "Start side thread",
						description: "Open an empty side thread",
						action: "start",
					},
					...(resumeThreads.length > 0
						? [
								{
									id: "resume" as const,
									label: "Resume side thread",
									description: "Continue an in-memory side thread",
									to: "resume" as const,
								},
							]
						: []),
					{
						id: "settings",
						label: "Settings",
						description: "Choose Omega BTW thinking level and fixed-level shortcut memory",
						to: state.kind === "invalid" ? "invalid" : "settings",
					},
				],
				hint: "close",
			}),
			resume: () => ({
				kind: "choice",
				title: "Resume BTW side thread",
				enableSearch: true,
				items: resumeThreads.map((thread) => ({
					id: thread.id,
					label: thread.title,
					description: `${thread.questionCount} ${thread.questionCount === 1 ? "question" : "questions"}`,
				})),
				action: "resume",
				viewportSize: 10,
				hint: "back",
			}),
			settings: ({ state }) => ({
				kind: "settings",
				title: "Omega BTW Settings",
				lines: [`User settings · ${displaySettingsPath}`],
				items: [
					{
						id: "thinkingLevel",
						label: "Thinking level",
						description: `Set the starting level for future Omega BTW side threads. Currently ${currentMainThinkingLevel}.`,
						currentValue: displayThinkingLevel(state.settings),
						values: [SAME_AS_MAIN_THREAD, ...levels],
						action: "set-thinking",
					},
					{
						id: "rememberThinkingLevelChanges",
						label: "Remember thinking level changes",
						description: "Save shortcut changes for fixed thinking levels to omega-btw.json.",
						currentValue: effectiveRememberThinkingLevelChanges(state.settings) ? "On" : "Off",
						values: ["On", "Off"],
						action: "set-remember",
					},
				],
			}),
			invalid: ({ state }) => ({
				kind: "detail",
				title: "Omega BTW Settings · Read only",
				lines: [
					`Invalid settings file. Fix ${displaySettingsPath} before saving.`,
					sanitizeSingleLine(state.reason ?? "The settings file is invalid."),
				],
				hint: "back",
			}),
		},
		actions: {
			start: async () => {
				startSelected = true;
				return { kind: "close" };
			},
			resume: async ({ itemId }: { itemId: string }) => {
				if (!resumeThreads.some((thread) => thread.id === itemId)) {
					return { kind: "rejected" } as const;
				}
				resumedThreadId = itemId;
				return { kind: "close" } as const;
			},
			"set-thinking": async ({ value, signal }) => {
				if (!value) return { kind: "rejected" };
				const patch =
					value === SAME_AS_MAIN_THREAD
						? ({ thinkingLevel: undefined } satisfies BtwSettingsPatch)
						: levels.includes(value as BtwThinkingLevel)
							? ({ thinkingLevel: value as BtwThinkingLevel } satisfies BtwSettingsPatch)
							: undefined;
				if (!patch) return { kind: "rejected" };
				try {
					await updateSettings(patch, { settingsPath, signal });
					if (signal.aborted) return { kind: "rejected" };
					notifySafely(ctx, `Omega BTW thinking level: ${value}.`, "info");
					return { kind: "stay" };
				} catch (error) {
					if (!signal.aborted) notifySaveFailure(ctx, error);
					return { kind: "rejected" };
				}
			},
			"set-remember": async ({ value, signal }) => {
				if (value !== "On" && value !== "Off") return { kind: "rejected" };
				try {
					await updateSettings({ rememberThinkingLevelChanges: value === "On" }, { settingsPath, signal });
					if (signal.aborted) return { kind: "rejected" };
					notifySafely(ctx, `Remember thinking level changes: ${value}.`, "info");
					return { kind: "stay" };
				} catch (error) {
					if (!signal.aborted) notifySaveFailure(ctx, error);
					return { kind: "rejected" };
				}
			},
		},
	});

	const result = await runBtwMenuPreservingEditor(ctx, (menuContext) =>
		runMenu(menuContext, menu, { getState: loadState }),
	);
	if (result.kind !== "closed" || result.reason !== "close") return "closed";
	if (resumedThreadId) return { kind: "resume", threadId: resumedThreadId };
	return startSelected ? "start" : "closed";
}

export async function runBtwMenuPreservingEditor(
	ctx: ExtensionCommandContext,
	run: (menuContext: MenuContext) => Promise<RunMenuResult>,
): Promise<RunMenuResult> {
	let liveEditorText = ctx.ui.getEditorText();
	let completed = false;
	const ui = new Proxy(ctx.ui, {
		get(target, property) {
			if (property === "custom") {
				return <Value>(
					factory: (
						tui: TUI,
						theme: Theme,
						keybindings: KeybindingsManager,
						done: (result: Value) => void,
					) => Component,
					customOptions?: Parameters<ExtensionCommandContext["ui"]["custom"]>[1],
				) =>
					target.custom<Value>(
						(tui, theme, keybindings, done) =>
							factory(tui, theme, keybindings, (value) => {
								try {
									liveEditorText = target.getEditorText();
								} catch {
									// Keep completion finite if session replacement invalidates the editor context.
								}
								completed = true;
								done(value);
							}),
						customOptions,
					);
			}
			const value = Reflect.get(target, property, target) as unknown;
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	const result = await run({ mode: ctx.mode, hasUI: ctx.hasUI, ui });
	if (result.kind !== "stale" && completed) {
		try {
			if (ctx.ui.getEditorText() !== liveEditorText) ctx.ui.setEditorText(liveEditorText);
		} catch {
			// A replaced context owns a different editor and must not receive stale restoration.
		}
	}
	return result;
}

function clampToAvailableThinkingLevel(
	requested: BtwThinkingLevel,
	available: readonly BtwThinkingLevel[],
): BtwThinkingLevel {
	if (available.includes(requested)) return requested;
	const requestedIndex = BTW_THINKING_LEVELS.indexOf(requested);
	for (let index = requestedIndex; index < BTW_THINKING_LEVELS.length; index += 1) {
		const candidate = BTW_THINKING_LEVELS[index];
		if (candidate && available.includes(candidate)) return candidate;
	}
	for (let index = requestedIndex - 1; index >= 0; index -= 1) {
		const candidate = BTW_THINKING_LEVELS[index];
		if (candidate && available.includes(candidate)) return candidate;
	}
	return available[0] ?? "off";
}

function notifySaveFailure(ctx: ExtensionCommandContext, error: unknown): void {
	notifySafely(
		ctx,
		`Omega BTW settings were not saved; the previous value remains active: ${formatError(error)}`,
		"error",
	);
}

function notifySafely(
	ctx: ExtensionCommandContext,
	message: string,
	level: Parameters<ExtensionCommandContext["ui"]["notify"]>[1],
): void {
	try {
		ctx.ui.notify(sanitizeSingleLine(message), level);
	} catch {
		// A completed save remains valid if its command context was replaced before notification.
	}
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
