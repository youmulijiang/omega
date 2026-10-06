// Omega Browser Bridge — MV3 service worker.
// 探测 9334-9343 端口段上的所有 Omega 智能体桥接服务，维持每端口一条 WebSocket；
// 侧边栏聊天/广播/切换会话路由到用户选中的智能体，各智能体的工具命令互不干扰。

const PORT_RANGE_START = 9334;
const PORT_RANGE_END = 9343;
const PROBE_INTERVAL_MS = 5000;
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 10000;
const MAX_TEXT_LENGTH = 50000;
const KEEPALIVE_ALARM = "bridge-connect";
// 心跳：每个已连接端口定期 ping，超过 STALE_AFTER_MS 没有任何回包即判定连接已失效。
// Omega 进程消失、socket 半开等情况下 socket 可能长期停留在 OPEN，只靠 onclose 会
// 误报「已连接」，因此以最近一次收到消息的时间作为存活依据。
const PING_INTERVAL_MS = 5000;
const STALE_AFTER_MS = 15000;

const connections = new Map(); // port -> { socket, generation, agentId, agentName, sessionInfo, timer, lastAttempt, lastSeenAt, lastPingAt, lastError }
let selectedAgentId = null;
let keepaliveTimer = null;
let connectGeneration = 0;
let lastError = "";

chrome.runtime.onInstalled.addListener(bootstrap);
chrome.runtime.onStartup.addListener(bootstrap);
bootstrap();

async function bootstrap() {
	chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
	const stored = await chrome.storage.session.get("omegaSelectedAgent");
	selectedAgentId = stored.omegaSelectedAgent ?? null;
	ensureConnections();
}

chrome.alarms.onAlarm.addListener((alarm) => {
	if (alarm.name !== KEEPALIVE_ALARM) return;
	ensureConnections();
});

chrome.storage.onChanged.addListener((changes, area) => {
	if (area === "session" && changes.omegaSelectedAgent) {
		selectedAgentId = changes.omegaSelectedAgent.newValue ?? null;
	}
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
	switch (message?.type) {
		case "status": {
			ensureConnections();
			sendResponse({
				agents: listAgents(),
				selectedAgentId: resolveSelectedAgentId(),
				lastError,
			});
			return;
		}
		case "select_agent": {
			if (message.agentId && findConnectionByAgentId(message.agentId)) {
				selectedAgentId = message.agentId;
				chrome.storage.session.set({ omegaSelectedAgent: selectedAgentId });
				sendResponse({ ok: true });
			} else {
				sendResponse({ ok: false, error: "Agent not connected" });
			}
			return;
		}
		case "reconnect": {
			ensureConnections(true);
			sendResponse({ ok: true });
			return;
		}
		case "chat_send": {
			const conn = selectedConnection();
			if (!conn) {
				sendResponse({ ok: false, error: "No agent connected" });
				return;
			}
			sendOn(conn, { type: "chat", text: message.text });
			sendResponse({ ok: true });
			return;
		}
		case "broadcast_send": {
			const conn = selectedConnection();
			if (!conn) {
				sendResponse({ ok: false, error: "No agent connected" });
				return;
			}
			sendOn(conn, { type: "broadcast", text: message.text });
			sendResponse({ ok: true });
			return;
		}
		case "stop_agent": {
			const conn = selectedConnection();
			if (!conn) {
				sendResponse({ ok: false, error: "No agent connected" });
				return;
			}
			sendOn(conn, { type: "stop" });
			sendResponse({ ok: true });
			return;
		}
		case "switch_session": {
			const conn = selectedConnection();
			if (!conn) {
				sendResponse({ ok: false, error: "No agent connected" });
				return;
			}
			sendOn(conn, { type: "switch_session", op: message.op, name: message.name });
			sendResponse({ ok: true });
			return;
		}
	}
});

// ---------------------------------------------------------------------------
// 连接管理
// ---------------------------------------------------------------------------

async function loadPort() {
	const stored = await chrome.storage.local.get("omegaBridgePort");
	return normalizePort(stored.omegaBridgePort);
}

function normalizePort(value) {
	const parsed = Number(value);
	if (Number.isInteger(parsed) && parsed > 0 && parsed < 65536) {
		return { start: parsed, end: parsed };
	}
	return { start: PORT_RANGE_START, end: PORT_RANGE_END };
}

async function ensureConnections(force = false) {
	const range = await loadPort();
	const now = Date.now();
	sweepConnections(now);
	for (let probe = range.start; probe <= range.end; probe += 1) {
		const existing = connections.get(probe);
		const state = existing?.socket?.readyState;
		if (state === WebSocket.OPEN || state === WebSocket.CONNECTING) continue;
		if (existing && now - existing.lastAttempt < PROBE_INTERVAL_MS && !force) continue;
		connectPort(probe, force);
	}
	for (const [probe, conn] of connections) {
		if (probe < range.start || probe > range.end) {
			destroyConnection(probe, conn);
		}
	}
	// 兜底：服务 worker 活跃时快速重试
	if (!keepaliveTimer) {
		keepaliveTimer = setInterval(() => ensureConnections(), PROBE_INTERVAL_MS);
	}
}

// 心跳巡检：向已连接端口发 ping；长时间无回包的连接直接断开，触发重连。
function sweepConnections(now) {
	for (const [probe, conn] of connections) {
		if (conn.socket?.readyState !== WebSocket.OPEN) continue;
		if (now - conn.lastSeenAt > STALE_AFTER_MS) {
			conn.lastError = `No response from ws://127.0.0.1:${probe}`;
			conn.socket.close();
			continue;
		}
		if (now - conn.lastPingAt >= PING_INTERVAL_MS) {
			conn.lastPingAt = now;
			sendOn(conn, { type: "ping" });
		}
	}
}

/** 连接可用 = socket 处于 OPEN 且最近仍收到过消息。 */
function isLive(conn) {
	return conn.socket?.readyState === WebSocket.OPEN && Date.now() - conn.lastSeenAt <= STALE_AFTER_MS;
}

function connectPort(probe, force) {
	const prev = connections.get(probe);
	if (prev?.timer) {
		clearTimeout(prev.timer);
	}
	if (prev?.socket) {
		try {
			prev.socket.close();
		} catch {
			// already closed
		}
	}
	connectGeneration += 1;
	const generation = connectGeneration;
	const conn = {
		socket: null,
		generation,
		agentId: null,
		agentName: null,
		sessionInfo: null,
		timer: null,
		lastAttempt: Date.now(),
		lastSeenAt: Date.now(),
		lastPingAt: 0,
		lastError: "",
	};
	connections.set(probe, conn);

	let ws;
	try {
		ws = new WebSocket(`ws://127.0.0.1:${probe}`);
	} catch (error) {
		conn.lastError = String(error);
		schedulePortReconnect(probe, conn, generation);
		return;
	}
	conn.socket = ws;

	ws.onopen = () => {
		if (generation !== conn.generation) return;
		conn.lastError = "";
		conn.lastSeenAt = Date.now();
		ws.send(JSON.stringify({ type: "hello", extension: "omega-browser-bridge", version: "1.1.0" }));
	};

	ws.onmessage = (event) => {
		if (generation !== conn.generation) return;
		conn.lastSeenAt = Date.now();
		handleMessage(conn, probe, event.data).catch((error) => {
			conn.lastError = String(error);
		});
		forwardPushEvents(conn, event.data);
	};

	ws.onclose = () => {
		if (conn.socket === ws) {
			conn.socket = null;
		}
		if (selectedAgentId && conn.agentId === selectedAgentId) {
			lastError = `Agent ${conn.agentName ?? probe} disconnected`;
		}
		schedulePortReconnect(probe, conn, generation, force);
	};

	ws.onerror = () => {
		if (generation !== conn.generation) return;
		conn.lastError = `Cannot reach ws://127.0.0.1:${probe}`;
	};
}

function schedulePortReconnect(probe, conn, generation, immediate = false) {
	if (generation !== conn.generation) return;
	if (conn.timer) return;
	conn.timer = setTimeout(
		() => {
			conn.timer = null;
			if (connections.get(probe) === conn) {
				connectPort(probe, immediate);
			}
		},
		immediate ? RECONNECT_MIN_MS : Math.min(RECONNECT_MAX_MS, PROBE_INTERVAL_MS),
	);
}

function destroyConnection(probe, conn) {
	if (conn.timer) clearTimeout(conn.timer);
	try {
		conn.socket?.close();
	} catch {
		// already closed
	}
	connections.delete(probe);
}

function findConnectionByAgentId(agentId) {
	for (const conn of connections.values()) {
		if (conn.agentId === agentId && isLive(conn)) return conn;
	}
	return null;
}

function connectedConnections() {
	const result = [];
	for (const conn of connections.values()) {
		if (conn.agentId && isLive(conn)) result.push(conn);
	}
	return result;
}

function resolveSelectedAgentId() {
	const live = connectedConnections();
	if (selectedAgentId && live.some((conn) => conn.agentId === selectedAgentId)) return selectedAgentId;
	if (live.length > 0) {
		selectedAgentId = live[0].agentId;
		return selectedAgentId;
	}
	// 无存活连接时不存在「当前智能体」：保留选择以便重连后恢复，但不对外暴露。
	return undefined;
}

function selectedConnection() {
	const selected = resolveSelectedAgentId();
	if (!selected) return null;
	return findConnectionByAgentId(selected);
}

function listAgents() {
	const selected = resolveSelectedAgentId();
	const result = [];
	for (const [probe, conn] of connections) {
		if (!isLive(conn)) continue;
		result.push({
			port: probe,
			agentId: conn.agentId ?? `port-${probe}`,
			agentName: conn.agentName ?? `port ${probe}`,
			identified: Boolean(conn.agentId),
			sessionInfo: conn.sessionInfo,
			selected: selected !== null && conn.agentId === selected,
		});
	}
	return result.sort((a, b) => a.port - b.port);
}

function sendOn(conn, payload) {
	if (conn.socket?.readyState === WebSocket.OPEN) {
		conn.socket.send(JSON.stringify(payload));
	}
}

// ---------------------------------------------------------------------------
// 消息处理
// ---------------------------------------------------------------------------

async function handleMessage(conn, probe, raw) {
	let request;
	try {
		request = JSON.parse(raw);
	} catch {
		return;
	}
	if (request.type !== "command" || typeof request.id !== "number") return;

	let response;
	try {
		const result = await dispatch(request.tool, request.params ?? {});
		response = { type: "response", id: request.id, ok: true, result };
	} catch (error) {
		response = {
			type: "response",
			id: request.id,
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
	sendOn(conn, response);
}

function forwardPushEvents(conn, raw) {
	let event;
	try {
		event = JSON.parse(raw);
	} catch {
		return;
	}
	if (event?.type === "agent_info") {
		conn.agentId = event.agentId;
		conn.agentName = event.agentName;
		return;
	}
	if (event?.type === "session_info") {
		conn.sessionInfo = { model: event.model ?? null, sessionId: event.sessionId ?? null };
	}
	if (event?.type === "chat_reply" || event?.type === "session_info") {
		const selected = resolveSelectedAgentId();
		// 只有选中智能体的回复进入侧边栏聊天流；其余智能体的会话状态更新照常同步。
		if (event.type === "chat_reply" && conn.agentId && conn.agentId !== selected) return;
		chrome.runtime.sendMessage({ type: event.type, agentId: conn.agentId, ...event }).catch(() => {
			// No side panel open; ignore.
		});
	}
}

// ---------------------------------------------------------------------------
// 浏览器命令（每个智能体各自的连接独立执行）
// ---------------------------------------------------------------------------

async function dispatch(tool, params) {
	switch (tool) {
		case "ping":
			return { pong: true };
		case "list_tabs":
			return listTabs();
		case "select_tab":
			return selectTab(Number(params.tabId));
		case "navigate":
			return navigate(params);
		case "evaluate":
			return evaluate(await resolveTabId(params), String(params.expression));
		case "get_content":
			return getContent(await resolveTabId(params), params);
		case "screenshot":
			return screenshot(await resolveTabId(params));
		case "click":
			return click(await resolveTabId(params), String(params.selector));
		case "type":
			return type(await resolveTabId(params), String(params.selector), String(params.text));
		case "get_auth":
			return getAuth(await resolveTabId(params), params);
		default:
			throw new Error(`Unknown tool: ${tool}`);
	}
}

async function resolveTabId(params) {
	if (params.tabId !== undefined && params.tabId !== null) return Number(params.tabId);
	const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
	if (!tab?.id) throw new Error("No active tab in the current window");
	return tab.id;
}

function tabToResult(tab) {
	return { tabId: tab.id, title: tab.title, url: tab.url, active: tab.active, windowId: tab.windowId };
}

async function listTabs() {
	const tabs = await chrome.tabs.query({});
	return tabs.filter((tab) => typeof tab.id === "number").map(tabToResult);
}

async function selectTab(tabId) {
	const tab = await chrome.tabs.update(tabId, { active: true });
	if (!tab) throw new Error(`Tab not found: ${tabId}`);
	return tabToResult(tab);
}

async function navigate(params) {
	const url = String(params.url ?? "");
	if (!url) throw new Error("url is required");
	if (params.tabId === undefined || params.tabId === null) {
		const tab = await chrome.tabs.create({ url, active: true });
		return { created: true, ...tabToResult(tab) };
	}
	const tab = await chrome.tabs.update(Number(params.tabId), { url });
	if (!tab) throw new Error(`Tab not found: ${params.tabId}`);
	return { created: false, ...tabToResult(tab) };
}

async function evaluate(tabId, expression) {
	const [injection] = await chrome.scripting.executeScript({
		target: { tabId },
		world: "MAIN",
		func: (expr) => {
			try {
				const value = eval(expr);
				return { ok: true, value: JSON.parse(JSON.stringify(value ?? null)) };
			} catch (error) {
				return { ok: false, error: String(error) };
			}
		},
		args: [expression],
	});
	const outcome = injection?.result;
	if (!outcome) throw new Error(`Script returned no result for tab ${tabId}`);
	if (!outcome.ok) throw new Error(outcome.error);
	return outcome.value;
}

async function getContent(tabId, params) {
	const maxLength = Number.isFinite(Number(params.maxLength)) ? Number(params.maxLength) : MAX_TEXT_LENGTH;
	const [injection] = await chrome.scripting.executeScript({
		target: { tabId },
		func: (limit) => ({
			title: document.title,
			url: location.href,
			text: (document.body?.innerText ?? "").slice(0, limit),
			html: (document.documentElement?.outerHTML ?? "").slice(0, limit),
		}),
		args: [maxLength],
	});
	const content = injection?.result;
	if (!content) throw new Error(`Script returned no result for tab ${tabId}`);
	return content;
}

async function screenshot(tabId) {
	const tab = await chrome.tabs.get(tabId);
	if (!tab.id) throw new Error(`Tab not found: ${tabId}`);
	const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
	return { dataUrl };
}

async function click(tabId, selector) {
	const [injection] = await chrome.scripting.executeScript({
		target: { tabId },
		world: "MAIN",
		func: (sel) => {
			const element = document.querySelector(sel);
			if (!element) return { ok: false, error: `Element not found: ${sel}` };
			element.scrollIntoView({ block: "center" });
			element.click();
			return { ok: true };
		},
		args: [selector],
	});
	const outcome = injection?.result;
	if (!outcome) throw new Error(`Script returned no result for tab ${tabId}`);
	if (!outcome.ok) throw new Error(outcome.error);
	return { clicked: selector };
}

async function type(tabId, selector, text) {
	const [injection] = await chrome.scripting.executeScript({
		target: { tabId },
		world: "MAIN",
		func: (sel, value) => {
			const element = document.querySelector(sel);
			if (!element) return { ok: false, error: `Element not found: ${sel}` };
			element.scrollIntoView({ block: "center" });
			element.focus();
			const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set ??
				Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
			if (setter) {
				setter.call(element, value);
			} else {
				element.value = value;
			}
			element.dispatchEvent(new Event("input", { bubbles: true }));
			element.dispatchEvent(new Event("change", { bubbles: true }));
			return { ok: true };
		},
		args: [selector, text],
	});
	const outcome = injection?.result;
	if (!outcome) throw new Error(`Script returned no result for tab ${tabId}`);
	if (!outcome.ok) throw new Error(outcome.error);
	return { typed: selector, length: text.length };
}

async function getAuth(tabId, params) {
	const tab = await chrome.tabs.get(tabId);
	const url = tab.url ?? "";
	const target = new URL(url);

	const cookies = await chrome.cookies.getAll({ url });
	const limited = params.maxCookies ? cookies.slice(0, Number(params.maxCookies)) : cookies;

	const [injection] = await chrome.scripting.executeScript({
		target: { tabId },
		func: () => {
			const collect = (storage) => {
				const entries = {};
				for (let i = 0; i < storage.length; i += 1) {
					const key = storage.key(i);
					entries[key] = storage.getItem(key);
				}
				return entries;
			};
			let localStorageDump = {};
			let sessionStorageDump = {};
			try {
				localStorageDump = collect(window.localStorage);
			} catch (error) {
				localStorageDump = { error: String(error) };
			}
			try {
				sessionStorageDump = collect(window.sessionStorage);
			} catch (error) {
				sessionStorageDump = { error: String(error) };
			}
			return { documentCookie: document.cookie, localStorage: localStorageDump, sessionStorage: sessionStorageDump };
		},
	});
	const storage = injection?.result ?? {};

	return {
		tabId,
		url,
		origin: target.origin,
		cookies: limited.map((cookie) => ({
			name: cookie.name,
			value: cookie.value,
			domain: cookie.domain,
			path: cookie.path,
			httpOnly: cookie.httpOnly,
			secure: cookie.secure,
			sameSite: cookie.sameSite,
			expirationDate: cookie.expirationDate,
		})),
		totalCookies: cookies.length,
		documentCookie: storage.documentCookie ?? "",
		localStorage: storage.localStorage ?? {},
		sessionStorage: storage.sessionStorage ?? {},
	};
}
