import { randomBytes } from "node:crypto";
import { basename } from "node:path";
import type { BridgeConnection, BridgeServer } from "./ws-server.ts";
import { startBridgeServer } from "./ws-server.ts";

/**
 * Omega 浏览器桥接：管理桥接服务端与 Chrome 扩展连接，
 * 提供 sendCommand 的请求-响应关联。支持多智能体并行：
 * 每个实例在 9334-9343 中占用一个空闲端口，并以 agentId/agentName 标识自己，
 * 扩展端探测全部端口后由用户选择聊天路由到哪个智能体。
 */

export const DEFAULT_BRIDGE_PORT = 9334;
export const BRIDGE_PORT_RANGE_END = 9343;
const COMMAND_TIMEOUT_MS = 30000;

export interface BridgeCommandResponse {
	ok: boolean;
	result?: unknown;
	error?: string;
}

interface PendingCommand {
	resolve: (response: BridgeCommandResponse) => void;
	timer: ReturnType<typeof setTimeout>;
}

const bridge = {
	server: undefined as BridgeServer | undefined,
	port: DEFAULT_BRIDGE_PORT,
	ownsServer: false,
	connection: undefined as BridgeConnection | undefined,
	hello: undefined as { extension?: string; version?: string } | undefined,
	pending: new Map<number, PendingCommand>(),
	nextId: 1,
	chatHandler: undefined as ((text: string) => void) | undefined,
	statusProvider: undefined as (() => Record<string, unknown>) | undefined,
	switchHandler: undefined as ((action: { op: "new" | "switch"; name: string }) => void) | undefined,
	broadcastHandler: undefined as ((text: string) => void) | undefined,
	stopHandler: undefined as (() => void) | undefined,
	agentId: `agent-${randomBytes(4).toString("hex")}`,
	agentName: process.env.OMEGA_AGENT_NAME || `${basename(process.cwd())}#${process.pid}`,
};

export function resolveBridgePort(): number {
	const raw = process.env.OMEGA_BROWSER_BRIDGE_PORT;
	if (!raw) return DEFAULT_BRIDGE_PORT;
	const parsed = Number(raw);
	return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : DEFAULT_BRIDGE_PORT;
}

export function getBridgeIdentity(): { agentId: string; agentName: string } {
	return { agentId: bridge.agentId, agentName: bridge.agentName };
}

export async function startBridge(): Promise<{ started: boolean; port: number; reason?: string }> {
	if (bridge.server && bridge.ownsServer) {
		return { started: false, port: bridge.port, reason: "already-running" };
	}
	const start = process.env.OMEGA_BROWSER_BRIDGE_PORT
		? [resolveBridgePort()]
		: rangePorts(DEFAULT_BRIDGE_PORT, BRIDGE_PORT_RANGE_END);
	let lastReason: string | undefined;
	for (const port of start) {
		try {
			bridge.server = await startBridgeServer({
				port,
				onConnection: (connection) => attachConnection(connection),
			});
			bridge.port = port;
			bridge.ownsServer = true;
			return { started: true, port };
		} catch (error) {
			lastReason = error instanceof Error ? error.message : String(error);
		}
	}
	bridge.server = undefined;
	bridge.ownsServer = false;
	return { started: false, port: DEFAULT_BRIDGE_PORT, reason: lastReason ?? "no free port" };
}

function rangePorts(start: number, end: number): number[] {
	const ports: number[] = [];
	for (let port = start; port <= end; port += 1) ports.push(port);
	return ports;
}

export async function stopBridge(): Promise<void> {
	const server = bridge.server;
	bridge.server = undefined;
	bridge.ownsServer = false;
	// 主动断开扩展端连接：让扩展立即显示未连接，而不是维持半开 socket。
	bridge.connection?.close();
	detachConnection();
	for (const pending of bridge.pending.values()) {
		clearTimeout(pending.timer);
		pending.resolve({ ok: false, error: "Bridge server stopped" });
	}
	bridge.pending.clear();
	await server?.close();
}

function attachConnection(connection: BridgeConnection) {
	bridge.connection?.close();
	bridge.connection = connection;
	bridge.hello = undefined;
	connection.onText((message) => handleText(connection, message));
	connection.onClose(() => {
		if (bridge.connection === connection) detachConnection();
	});
}

function detachConnection() {
	bridge.connection = undefined;
	bridge.hello = undefined;
}

function handleText(connection: BridgeConnection, message: string) {
	let parsed: unknown;
	try {
		parsed = JSON.parse(message);
	} catch {
		return;
	}
	if (typeof parsed !== "object" || parsed === null) return;
	const record = parsed as Record<string, unknown>;
	if (record.type === "hello") {
		if (bridge.connection === connection) {
			bridge.hello = {
				extension: typeof record.extension === "string" ? record.extension : undefined,
				version: typeof record.version === "string" ? record.version : undefined,
			};
		}
		connection.sendText(JSON.stringify({ type: "agent_info", ...getBridgeIdentity() }));
		const status = bridge.statusProvider?.();
		if (status) {
			connection.sendText(JSON.stringify({ type: "session_info", ...status }));
		}
		return;
	}
	if (record.type === "ping") {
		// 扩展端心跳：回 pong 证明桥接进程仍然存活（用于识别半开连接）。
		connection.sendText(JSON.stringify({ type: "pong" }));
		return;
	}
	if (record.type === "chat" && typeof record.text === "string" && record.text.trim()) {
		bridge.chatHandler?.(record.text.trim());
		return;
	}
	if (record.type === "switch_session" && typeof record.name === "string" && record.name.trim()) {
		const op = record.op === "switch" ? "switch" : "new";
		bridge.switchHandler?.({ op, name: record.name.trim() });
		return;
	}
	if (record.type === "broadcast" && typeof record.text === "string" && record.text.trim()) {
		bridge.broadcastHandler?.(record.text.trim());
		return;
	}
	if (record.type === "stop") {
		bridge.stopHandler?.();
		return;
	}
	if (record.type === "response" && typeof record.id === "number") {
		const pending = bridge.pending.get(record.id);
		if (!pending) return;
		bridge.pending.delete(record.id);
		clearTimeout(pending.timer);
		pending.resolve({
			ok: record.ok === true,
			result: record.result,
			error: typeof record.error === "string" ? record.error : undefined,
		});
	}
}

export function isBridgeConnected(): boolean {
	return bridge.connection !== undefined;
}

/** 注册侧边栏聊天回调：收到扩展侧用户消息时触发。 */
export function setBridgeChatHandler(handler: ((text: string) => void) | undefined): void {
	bridge.chatHandler = handler;
}

/** 注册会话状态提供者：扩展连接握手时推送 session_info（如当前模型）。 */
export function setBridgeStatusProvider(provider: (() => Record<string, unknown>) | undefined): void {
	bridge.statusProvider = provider;
}

/** 注册会话切换回调：侧边栏请求新建/切换 Omega 会话时触发。 */
export function setBridgeSwitchSessionHandler(
	handler: ((action: { op: "new" | "switch"; name: string }) => void) | undefined,
): void {
	bridge.switchHandler = handler;
}

/** 注册广播回调：侧边栏向运行中的智能体广播信息时触发。 */
export function setBridgeBroadcastHandler(handler: ((text: string) => void) | undefined): void {
	bridge.broadcastHandler = handler;
}

/** 注册停止回调：侧边栏请求中断当前回合时触发。 */
export function setBridgeStopHandler(handler: (() => void) | undefined): void {
	bridge.stopHandler = handler;
}

/** 向扩展主动推送事件（如智能体回复），用于侧边栏聊天。 */
export function pushBridgeEvent(event: Record<string, unknown>): void {
	bridge.connection?.sendText(JSON.stringify(event));
}

export function bridgeStatus(): {
	running: boolean;
	port: number;
	connected: boolean;
	extension?: string;
	version?: string;
} {
	return {
		running: bridge.ownsServer,
		port: bridge.port,
		connected: isBridgeConnected(),
		extension: bridge.hello?.extension,
		version: bridge.hello?.version,
	};
}

export async function sendBridgeCommand(
	tool: string,
	params: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<unknown> {
	const connection = bridge.connection;
	if (!connection) {
		throw new Error(
			`Browser extension is not connected. Load plugins/browser-plugin in Chrome (chrome://extensions -> Load unpacked) and keep the bridge running on ws://127.0.0.1:${bridge.port}.`,
		);
	}
	const id = bridge.nextId;
	bridge.nextId += 1;
	const response = new Promise<BridgeCommandResponse>((resolve) => {
		const timer = setTimeout(() => {
			bridge.pending.delete(id);
			resolve({ ok: false, error: `Bridge command timed out after ${COMMAND_TIMEOUT_MS}ms: ${tool}` });
		}, COMMAND_TIMEOUT_MS);
		bridge.pending.set(id, { resolve, timer });
		signal?.addEventListener("abort", () => {
			if (!bridge.pending.has(id)) return;
			bridge.pending.delete(id);
			clearTimeout(timer);
			resolve({ ok: false, error: "Aborted" });
		});
		connection.sendText(JSON.stringify({ type: "command", id, tool, params }));
	});
	const outcome = await response;
	if (!outcome.ok) throw new Error(outcome.error ?? `Bridge command failed: ${tool}`);
	return outcome.result;
}
