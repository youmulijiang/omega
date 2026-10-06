import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { OmegaAPI } from "../api.ts";
import {
	bridgeStatus,
	pushBridgeEvent,
	resolveBridgePort,
	setBridgeBroadcastHandler,
	setBridgeChatHandler,
	setBridgeStatusProvider,
	setBridgeStopHandler,
	setBridgeSwitchSessionHandler,
	startBridge,
	stopBridge,
} from "./bridge.ts";
import { browserExtTool } from "./tools.ts";

const STATUS_KEY = "browser-bridge";
const SESSION_REGISTRY_FILE = join(homedir(), ".omega", "browser-bridge-sessions.json");

interface ModelInfo {
	id: string;
	name: string;
	provider: string;
}

interface SessionRegistry {
	[name: string]: string;
}

let currentModel: ModelInfo | undefined;
let sessionCtx: ExtensionContext | undefined;
/** 最近一次命令上下文：会话切换（newSession/switchSession）只在命令上下文可用。 */
let commandCtx: ExtensionCommandContext | undefined;
/** 当前侧边栏会话名称（对应 Omega 会话文件映射）。 */
let currentSessionName: string | undefined;
const sessionRegistry: SessionRegistry = {};

function toModelInfo(model: { id: string; name: string; provider: string } | undefined): ModelInfo | undefined {
	return model ? { id: model.id, name: model.name, provider: String(model.provider) } : undefined;
}

function sessionInfoEvent() {
	return { type: "session_info" as const, model: currentModel, sessionId: currentSessionName };
}

async function loadSessionRegistry(): Promise<void> {
	if (Object.keys(sessionRegistry).length > 0) return;
	try {
		const raw = await readFile(SESSION_REGISTRY_FILE, "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed === "object" && parsed !== null) {
			for (const [name, file] of Object.entries(parsed as Record<string, unknown>)) {
				if (typeof file === "string") sessionRegistry[name] = file;
			}
		}
	} catch {
		// 首次使用，注册表为空
	}
}

async function saveSessionRegistry(): Promise<void> {
	await mkdir(dirname(SESSION_REGISTRY_FILE), { recursive: true });
	await writeFile(SESSION_REGISTRY_FILE, JSON.stringify(sessionRegistry, null, "\t"), "utf8");
}

/** 反查会话文件名对应的注册名称（用于重启后恢复侧边栏会话名）。 */
function findSessionName(file: string | undefined): string | undefined {
	if (!file) return undefined;
	for (const [name, registered] of Object.entries(sessionRegistry)) {
		if (registered === file) return name;
	}
	return undefined;
}

export function registerBrowserExtension(omega: OmegaAPI) {
	setBridgeStatusProvider(() => ({ model: toModelInfo(sessionCtx?.model), sessionId: currentSessionName }));
	setBridgeChatHandler((text) => {
		try {
			const content = `[Chrome sidebar] ${text}`;
			const busy = sessionCtx ? !sessionCtx.isIdle() : false;
			if (busy) {
				omega.sendUserMessage(content, { deliverAs: "followUp" });
				pushBridgeEvent({ type: "chat_reply", queued: true });
				return;
			}
			omega.sendUserMessage(content);
		} catch (error) {
			pushBridgeEvent({
				type: "chat_reply",
				text: `⚠️ Message delivery failed: ${error instanceof Error ? error.message : String(error)}`,
			});
		}
	});
	setBridgeSwitchSessionHandler((action) => {
		void handleBridgeSessionSwitch(action);
	});
	setBridgeBroadcastHandler((text) => {
		const busy = sessionCtx ? !sessionCtx.isIdle() : false;
		omega.sendMessage(
			{
				customType: "browser-bridge-broadcast",
				content: [{ type: "text", text: `[Browser broadcast] ${text}` }],
				display: true,
			},
			{ triggerTurn: true, deliverAs: busy ? "followUp" : undefined },
		);
		pushBridgeEvent({
			type: "chat_reply",
			text: `Broadcast delivered to the running agent${busy ? " (queued; takes effect after the current task finishes)" : ""}: ${text}`,
			broadcast: true,
		});
	});
	setBridgeStopHandler(() => {
		sessionCtx?.abort();
	});
	omega.registerTool(browserExtTool);

	omega.registerCommand("browser-bridge", {
		description: "Control the Chrome extension bridge (status/start/stop/name)",
		showSourceTag: false,
		handler: async (args, ctx) => {
			commandCtx = ctx;
			await handleBrowserBridgeCommand(args, ctx);
		},
	});

	omega.on("session_start", async (_event, ctx) => {
		sessionCtx = ctx;
		currentModel = toModelInfo(ctx.model);
		await loadSessionRegistry();
		currentSessionName = findSessionName(ctx.sessionManager.getSessionFile());
		pushBridgeEvent(sessionInfoEvent());
		const outcome = await startBridge();
		if (outcome.started) {
			ctx.ui.setStatus(STATUS_KEY, `listening on ws://127.0.0.1:${outcome.port}`);
			return;
		}
		if (outcome.reason === "already-running") return;
		ctx.ui.setStatus(STATUS_KEY, `failed to start: ${outcome.reason}`);
	});

	omega.on("message_end", (event) => {
		const message = event.message as
			| { role?: string; content?: unknown; stopReason?: string; errorMessage?: string }
			| undefined;
		if (!message || message.role !== "assistant") return;
		if (message.stopReason === "error") {
			pushBridgeEvent({
				type: "chat_reply",
				text: `⚠️ Agent execution error: ${message.errorMessage ?? "unknown error (see terminal for details)"}`,
			});
			return;
		}
		const text = extractAssistantText(message.content);
		if (text) pushBridgeEvent({ type: "chat_reply", text });
	});

	omega.on("model_select", (event) => {
		currentModel = toModelInfo(event.model);
		pushBridgeEvent(sessionInfoEvent());
	});

	omega.on("agent_end", () => {
		pushBridgeEvent({ type: "chat_reply", done: true });
	});

	omega.on("session_shutdown", async (_event, ctx) => {
		setBridgeChatHandler(undefined);
		setBridgeStatusProvider(undefined);
		setBridgeSwitchSessionHandler(undefined);
		setBridgeBroadcastHandler(undefined);
		setBridgeStopHandler(undefined);
		sessionCtx = undefined;
		commandCtx = undefined;
		currentSessionName = undefined;
		await stopBridge();
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}

function extractAssistantText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (typeof block === "object" && block !== null && (block as { type?: string }).type === "text") {
			const text = (block as { text?: unknown }).text;
			if (typeof text === "string" && text.trim()) parts.push(text);
		}
	}
	return parts.join("\n").trim();
}

async function handleBridgeSessionSwitch(action: { op: "new" | "switch"; name: string }) {
	if (!commandCtx) {
		pushBridgeEvent({
			type: "chat_reply",
			text: "Session switching unavailable: run the /browser-bridge command once in the Omega terminal first, then retry.",
		});
		return;
	}
	await commandCtx.waitForIdle();
	try {
		await loadSessionRegistry();
		const existing = sessionRegistry[action.name];
		if (action.op === "switch" && !existing) {
			pushBridgeEvent({ type: "chat_reply", text: `Session "${action.name}" does not exist.` });
			return;
		}
		if (existing) {
			await commandCtx.switchSession(existing, {
				withSession: async (newCtx) => {
					commandCtx = newCtx;
				},
			});
		} else {
			await commandCtx.newSession({
				withSession: async (newCtx) => {
					commandCtx = newCtx;
					const file = newCtx.sessionManager.getSessionFile();
					if (file) sessionRegistry[action.name] = file;
					await saveSessionRegistry();
				},
			});
		}
		currentSessionName = action.name;
		sessionCtx = commandCtx;
		currentModel = toModelInfo(commandCtx.model);
		pushBridgeEvent(sessionInfoEvent());
		pushBridgeEvent({ type: "chat_reply", text: `Switched to session "${action.name}".` });
	} catch (error) {
		pushBridgeEvent({
			type: "chat_reply",
			text: `Session switch failed: ${error instanceof Error ? error.message : String(error)}`,
		});
	}
}

async function handleBrowserBridgeCommand(args: string, ctx: ExtensionCommandContext) {
	const trimmed = args.trim();
	const spaceIndex = trimmed.indexOf(" ");
	const command = (spaceIndex < 0 ? trimmed : trimmed.slice(0, spaceIndex)).toLowerCase() || "status";
	const commandArgs = spaceIndex < 0 ? "" : trimmed.slice(spaceIndex + 1).trim();
	switch (command) {
		case "status": {
			const status = bridgeStatus();
			ctx.ui.notify(
				status.running
					? `Browser bridge listening on ws://127.0.0.1:${status.port}; extension ${status.connected ? "connected" : "NOT connected"}.`
					: `Browser bridge not running (default port ${resolveBridgePort()}).`,
				status.connected ? "info" : "warning",
			);
			return;
		}
		case "start": {
			const outcome = await startBridge();
			ctx.ui.notify(
				outcome.started
					? `Browser bridge listening on ws://127.0.0.1:${outcome.port}.`
					: `Browser bridge not started: ${outcome.reason ?? "unknown reason"}.`,
				outcome.started ? "info" : "warning",
			);
			return;
		}
		case "stop": {
			await stopBridge();
			ctx.ui.notify("Browser bridge stopped.", "info");
			return;
		}
		case "name": {
			await handleBrowserBridgeName(commandArgs, ctx);
			return;
		}
		default:
			throw new Error(`Unknown /browser-bridge command: ${trimmed} (use status, start, stop, or name <name>)`);
	}
}

/**
 * 命名浏览器插件会话：名称写入会话注册表并推送到扩展侧边栏头部，
 * 侧边栏随后可用 /switch <名称> 切回该会话。
 */
async function handleBrowserBridgeName(name: string, ctx: ExtensionCommandContext) {
	if (!name) {
		ctx.ui.notify(
			currentSessionName
				? `Browser plugin session name: ${currentSessionName}`
				: "Browser plugin session is unnamed. Use /browser-bridge name <name> to name it.",
			currentSessionName ? "info" : "warning",
		);
		return;
	}
	currentSessionName = name;
	const file = ctx.sessionManager.getSessionFile();
	if (file) {
		await loadSessionRegistry();
		sessionRegistry[name] = file;
		await saveSessionRegistry();
	}
	pushBridgeEvent(sessionInfoEvent());
	ctx.ui.notify(`Browser plugin session named "${name}".`, "info");
}
