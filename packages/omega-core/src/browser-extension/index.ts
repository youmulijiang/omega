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
import {
	bridgeStatusTool,
	clickTool,
	evaluateTool,
	getAuthTool,
	getContentTool,
	listTabsTool,
	navigateTool,
	screenshotTool,
	selectTabTool,
	typeTool,
} from "./tools.ts";

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

export function registerBrowserExtension(omega: OmegaAPI) {
	setBridgeStatusProvider(() => ({ model: toModelInfo(sessionCtx?.model), sessionId: currentSessionName }));
	setBridgeChatHandler((text) => {
		try {
			const content = `[Chrome 侧边栏] ${text}`;
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
				text: `⚠️ 消息投递失败：${error instanceof Error ? error.message : String(error)}`,
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
				content: [{ type: "text", text: `[浏览器广播] ${text}` }],
				display: true,
			},
			{ triggerTurn: true, deliverAs: busy ? "followUp" : undefined },
		);
		pushBridgeEvent({
			type: "chat_reply",
			text: `广播已送达运行中的智能体${busy ? "（已排队，当前任务完成后生效）" : ""}：${text}`,
			broadcast: true,
		});
	});
	setBridgeStopHandler(() => {
		sessionCtx?.abort();
	});
	omega.registerTool(bridgeStatusTool);
	omega.registerTool(listTabsTool);
	omega.registerTool(selectTabTool);
	omega.registerTool(navigateTool);
	omega.registerTool(evaluateTool);
	omega.registerTool(getContentTool);
	omega.registerTool(screenshotTool);
	omega.registerTool(clickTool);
	omega.registerTool(typeTool);
	omega.registerTool(getAuthTool);

	omega.registerCommand("browser-bridge", {
		description: "Control the Chrome extension bridge for browser control",
		handler: async (args, ctx) => {
			commandCtx = ctx;
			await handleBrowserBridgeCommand(args, ctx);
		},
	});

	omega.on("session_start", async (_event, ctx) => {
		sessionCtx = ctx;
		currentModel = toModelInfo(ctx.model);
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
				text: `⚠️ 智能体执行出错：${message.errorMessage ?? "未知错误（详情见终端）"}`,
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
			text: "会话切换不可用：请先在 Omega 终端运行一次 /browser-bridge 命令，然后重试。",
		});
		return;
	}
	await commandCtx.waitForIdle();
	try {
		await loadSessionRegistry();
		const existing = sessionRegistry[action.name];
		if (action.op === "switch" && !existing) {
			pushBridgeEvent({ type: "chat_reply", text: `会话「${action.name}」不存在。` });
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
		pushBridgeEvent({ type: "chat_reply", text: `已切换到会话「${action.name}」。` });
	} catch (error) {
		pushBridgeEvent({
			type: "chat_reply",
			text: `会话切换失败：${error instanceof Error ? error.message : String(error)}`,
		});
	}
}

async function handleBrowserBridgeCommand(args: string, ctx: ExtensionCommandContext) {
	const command = args.trim().toLowerCase() || "status";
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
		default:
			throw new Error(`Unknown /browser-bridge command: ${args.trim()} (use status, start, or stop)`);
	}
}
