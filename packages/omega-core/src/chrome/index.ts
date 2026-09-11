/**
 * Chrome DevTools 集成，移植自 @narumitw/pi-chrome-devtools 0.53.1（MIT License）。
 * https://github.com/narumiruna/pi-extensions
 *
 * 适配：omega-core 静态注册、.ts 导入后缀、omega-chrome-devtools.json 设置文件。
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { OmegaAPI } from "../api.ts";
import { extractApiTool } from "./api-extractor.ts";
import { shutdownManagedBrowser, startManagedBrowserSession, syncManagedBrowserSettings } from "./browser-manager.ts";
import { showChromeDevtoolsBrowserSettings } from "./browser-settings-menu.ts";
import { setActivePageId } from "./cdp-client.ts";
import {
	availableChromeDevtoolsTools,
	configureChromeDevtoolsToolExposure,
	createChromeDevtoolsLoadTool,
	initializeAvailableChromeDevtoolsTools,
	requireEagerChromeDevtoolsToolExposure,
	setChromeDevtoolsSessionOwner,
	supportsNativeDeferredToolLoading,
} from "./lazy-tools.ts";
import { showChromeDevtoolsMenu, showChromeDevtoolsToolWorkflow } from "./menu.ts";
import { stopNetworkCaptureQuiet } from "./network.ts";
import {
	applyRuntimeBrowserSettings,
	applyRuntimeWebMcpSetting,
	invalidateWebMcpOperations,
	setWebMcpSessionOwner,
	state,
	webMcpEnabled,
} from "./runtime.ts";
import { loadSettings, waitForSettingsWrites } from "./settings.ts";
import {
	allChromeDevtoolsTools,
	buildCommandGuide,
	buildQuickstartMessage,
	buildToolStatusMessage,
	sanitizeChromeDevtoolsDisplay,
	updateChromeDevtoolsTools,
	waitForChromeDevtoolsSettings,
} from "./tool-selector.ts";
import {
	evaluateTool,
	listPagesTool,
	navigateTool,
	networkTool,
	screenshotTool,
	selectPageTool,
	webMcpCallTool,
	webMcpListToolsTool,
} from "./tools.ts";

type CommandAction = "menu" | "help" | "quickstart" | "status" | "settings" | "tools" | "enable" | "disable";
type CommandContext = ExtensionCommandContext;
const STATUS_KEY = "chrome-devtools";
const COMMAND_COMPLETIONS = [
	{ value: "help", label: "help", description: "Show command usage" },
	{ value: "quickstart", label: "quickstart", description: "Show endpoint and launch help" },
	{ value: "status", label: "status", description: "Show tool and settings status" },
	{ value: "settings", label: "settings", description: "Edit browser connection settings" },
	{ value: "tools", label: "tools", description: "Choose available Chrome DevTools tools" },
	{ value: "toggle", label: "toggle", description: "Alias for tools" },
	{ value: "select", label: "select", description: "Compatibility alias for tools" },
	{ value: "enable", label: "enable", description: "Make all Chrome DevTools tools available" },
	{ value: "on", label: "on", description: "Compatibility alias for enable" },
	{ value: "disable", label: "disable", description: "Make all Chrome DevTools tools unavailable" },
	{ value: "off", label: "off", description: "Compatibility alias for disable" },
];
export function registerChrome(omega: OmegaAPI) {
	omega.registerTool(listPagesTool);
	omega.registerTool(selectPageTool);
	omega.registerTool(navigateTool);
	omega.registerTool(evaluateTool);
	omega.registerTool(screenshotTool);
	omega.registerTool(networkTool);
	omega.registerTool(extractApiTool);
	omega.registerTool(webMcpListToolsTool);
	omega.registerTool(webMcpCallTool);
	omega.registerTool(createChromeDevtoolsLoadTool(omega));

	omega.registerCommand("chrome-devtools", {
		description: "Open Chrome DevTools help and tool controls",
		getArgumentCompletions: (prefix) => commandCompletions(prefix),
		handler: async (args, ctx) => {
			setChromeDevtoolsSessionOwner(omega, ctx.sessionManager);
			initializeAvailableChromeDevtoolsTools(omega);
			const generation = state.sessionGeneration;
			await handleChromeDevtoolsCommand(omega, args, ctx, generation);
		},
	});

	omega.on("session_start", async (_event, ctx) => {
		const generation = ++state.sessionGeneration;
		setChromeDevtoolsSessionOwner(omega, ctx.sessionManager);
		initializeAvailableChromeDevtoolsTools(omega);
		setWebMcpSessionOwner(ctx.sessionManager);
		replaceSessionController("Chrome DevTools session replaced");
		invalidateWebMcpOperations(ctx.sessionManager, "Chrome DevTools session replaced");
		state.shuttingDown = false;
		state.settingsNotice = undefined;
		ctx.ui.setStatus(STATUS_KEY, undefined);
		await shutdownManagedBrowser(undefined, {
			cancelLaunch: true,
			owner: ctx.sessionManager,
		});
		startManagedBrowserSession(ctx.sessionManager);
		if (generation !== state.sessionGeneration) return;
		setActivePageId(ctx.sessionManager, undefined);
		state.activePageId = undefined;
		state.lastLaunchAttempt = undefined;
		const projectTrusted = ctx.isProjectTrusted();
		const settings = await loadSettings({ cwd: ctx.cwd, projectTrusted });
		if (generation !== state.sessionGeneration) return;
		applyRuntimeBrowserSettings(settings.effectiveBrowser, settings.paths, projectTrusted);
		syncManagedBrowserSettings(ctx.sessionManager, settings.effectiveBrowser);
		applyRuntimeWebMcpSetting(settings.effectiveWebMcpEnabled, ctx.sessionManager);
		state.settingsNotice = settings.notice;
		for (const warning of settings.warnings) {
			ctx.ui.notify(sanitizeChromeDevtoolsDisplay(warning), "warning");
		}
		if (webMcpEnabled(ctx.sessionManager)) {
			ctx.ui.notify(
				"Experimental WebMCP is enabled. Page-provided tools use the visible browser session and require confirmation for every call.",
				"warning",
			);
		}
		const availableTools =
			settings.kind === "loaded" && settings.settings.tools
				? settings.settings.tools
				: availableChromeDevtoolsTools(omega);
		configureChromeDevtoolsToolExposure(omega, availableTools, ctx.model);
	});

	omega.on("model_select", (event, ctx) => {
		invalidateWebMcpOperations(ctx.sessionManager, "Chrome DevTools model and tool exposure changed");
		if (!supportsNativeDeferredToolLoading(event.model)) {
			requireEagerChromeDevtoolsToolExposure(omega);
		}
	});

	omega.on("session_shutdown", async (_event, ctx) => {
		state.sessionGeneration += 1;
		replaceSessionController("Chrome DevTools session shut down");
		invalidateWebMcpOperations(ctx.sessionManager, "Chrome DevTools session shut down");
		await stopNetworkCaptureQuiet(ctx.sessionManager);
		const browserShutdown = shutdownManagedBrowser(undefined, {
			cancelLaunch: true,
			owner: ctx.sessionManager,
		});
		await waitForChromeDevtoolsSettings();
		await waitForSettingsWrites();
		await browserShutdown;
	});
}

async function handleChromeDevtoolsCommand(pi: ExtensionAPI, args: string, ctx: CommandContext, generation: number) {
	const command = parseCommand(args);
	switch (command) {
		case "menu":
			await showMenu(pi, ctx, generation);
			return;
		case "help":
			requireObservableUi(ctx, "help");
			ctx.ui.notify(buildCommandGuide(ctx.sessionManager), "info");
			return;
		case "quickstart":
			requireObservableUi(ctx, "quickstart");
			ctx.ui.notify(buildQuickstartMessage(ctx.sessionManager), "info");
			return;
		case "status": {
			requireObservableUi(ctx, "status");
			const status = await buildToolStatusMessage(pi, ctx.sessionManager);
			if (generation !== state.sessionGeneration) return;
			ctx.ui.notify(status, "info");
			return;
		}
		case "settings": {
			if (!ctx.hasUI || (ctx.mode !== "tui" && ctx.mode !== "rpc")) {
				throw new Error("/chrome-devtools settings requires TUI or RPC mode");
			}
			if (generation !== state.sessionGeneration) return;
			await showChromeDevtoolsBrowserSettings(pi, ctx, generation);
			return;
		}
		case "tools": {
			if (!ctx.hasUI || (ctx.mode !== "tui" && ctx.mode !== "rpc")) {
				throw new Error("/chrome-devtools tools requires TUI or RPC mode");
			}
			if (generation !== state.sessionGeneration) return;
			await showChromeDevtoolsToolWorkflow(pi, ctx, generation);
			return;
		}
		case "enable":
			await updateChromeDevtoolsTools(pi, ctx, allChromeDevtoolsTools(ctx.sessionManager), "made all available");
			return;
		case "disable":
			await updateChromeDevtoolsTools(pi, ctx, [], "made all unavailable");
			return;
	}

	if (!ctx.hasUI || (ctx.mode !== "tui" && ctx.mode !== "rpc")) {
		throw new Error(`Unknown /chrome-devtools command: ${args.trim()}`);
	}
	ctx.ui.notify(
		`Unknown /chrome-devtools command: ${args.trim()}

${buildCommandGuide(ctx.sessionManager)}`,
		"warning",
	);
}

function requireObservableUi(ctx: CommandContext, route: string) {
	if (!ctx.hasUI || (ctx.mode !== "tui" && ctx.mode !== "rpc")) {
		throw new Error(`/chrome-devtools ${route} requires TUI or RPC mode`);
	}
}

async function showMenu(pi: ExtensionAPI, ctx: CommandContext, generation: number) {
	if (!ctx.hasUI || (ctx.mode !== "tui" && ctx.mode !== "rpc")) {
		throw new Error("/chrome-devtools menu requires TUI or RPC mode; use a direct subcommand");
	}
	if (generation !== state.sessionGeneration) return;
	await showChromeDevtoolsMenu(pi, ctx, generation);
}

function replaceSessionController(reason: string) {
	state.sessionController.abort(new DOMException(reason, "AbortError"));
	state.sessionController = new AbortController();
}

export function parseCommand(args: string): CommandAction | "unknown" {
	const command = args.trim().toLowerCase();
	if (!command) return "menu";
	if (command === "help") return "help";
	if (command === "quickstart") return "quickstart";
	if (command === "status") return "status";
	if (command === "settings") return "settings";
	if (command === "tools" || command === "select" || command === "toggle") return "tools";
	if (command === "enable" || command === "on") return "enable";
	if (command === "disable" || command === "off") return "disable";
	return "unknown";
}

export function commandCompletions(prefix: string) {
	const normalized = prefix.trimStart().toLowerCase();
	if (/\s/.test(normalized)) return null;

	const matches = COMMAND_COMPLETIONS.filter((completion) => completion.value.startsWith(normalized));
	return matches.length > 0 ? matches : null;
}

export {
	formatHostForUrl,
	isLocalDevToolsHost,
	quoteCommandPart,
} from "./browser-manager.ts";
export { CHROME_DEVTOOLS_LOAD_TOOL_NAME } from "./lazy-tools.ts";
export { parseConfiguredPort } from "./runtime.ts";
export {
	hasParentPathSegment,
	isPathInsideRoot,
	resolveScreenshotPath,
	selectAllowedRoot,
} from "./screenshot.ts";
export { normalizeChromeDevtoolsSettings } from "./settings.ts";
export {
	orderedChromeDevtoolsTools,
	sanitizeChromeDevtoolsDisplay,
} from "./tool-selector.ts";
