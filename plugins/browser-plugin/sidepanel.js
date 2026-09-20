const HISTORY_KEY_PREFIX = "omegaChatHistory:";
const LEGACY_HISTORY_KEY = "omegaChatHistory";
const CONVOS_KEY = "omegaConversations";
const HISTORY_LIMIT = 200;

// Lucide 风格内联图标（24x24，stroke 继承 currentColor）
const svg = (paths, size = 14) =>
	`<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;

const ICONS = {
	broadcast: svg('<path d="m3 11 18-5v12L3 13v-2z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>', 15),
	new: svg('<path d="M5 12h14"/><path d="M12 5v14"/>'),
	switch: svg('<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>'),
	agents: svg('<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>'),
	export: svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>'),
	help: svg('<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>'),
	clear: svg('<path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/>'),
};

const SLASH_COMMANDS = [
	{ cmd: "/broadcast", icon: ICONS.broadcast, args: "<文本>", desc: "广播信息给运行中的智能体（不打断当前任务）" },
	{ cmd: "/new", icon: ICONS.new, args: "[名称]", desc: "新建 Omega 会话（独立上下文）" },
	{ cmd: "/switch", icon: ICONS.switch, args: "<名称>", desc: "切换到指定会话" },
	{ cmd: "/agents", icon: ICONS.agents, args: "", desc: "列出已连接的智能体" },
	{ cmd: "/export", icon: ICONS.export, args: "", desc: "复制当前会话记录为 Markdown" },
	{ cmd: "/clear", icon: ICONS.clear, args: "", desc: "清空当前会话的聊天记录" },
	{ cmd: "/help", icon: ICONS.help, args: "", desc: "显示命令列表" },
];

const messagesEl = document.getElementById("messages");
const emptyStateEl = document.getElementById("emptyState");
const inputEl = document.getElementById("input");
const sendEl = document.getElementById("send");
const statusEl = document.getElementById("headerTag");
const modelTagEl = document.getElementById("modelTag");
const broadcastBtnEl = document.getElementById("broadcastBtn");
const sessionSelectEl = document.getElementById("sessionSelect");
const newSessionEl = document.getElementById("newSession");
const agentSelectEl = document.getElementById("agentSelect");
const menuBtnEl = document.getElementById("menuBtn");
const sessionBarEl = document.getElementById("sessionBar");
const commandHintEl = document.getElementById("commandHint");

let pendingEl = null;
let agents = [];
let selectedAgentId = null;
let broadcastMode = false;
let conversations = ["默认"];
let activeConversation = "默认";

// ---------------------------------------------------------------------------
// 会话与历史存储
// ---------------------------------------------------------------------------

async function loadConversations() {
	const stored = await chrome.storage.session.get([CONVOS_KEY, LEGACY_HISTORY_KEY]);
	if (Array.isArray(stored[CONVOS_KEY]) && stored[CONVOS_KEY].length > 0) {
		conversations = stored[CONVOS_KEY];
		activeConversation = conversations.includes(activeConversation) ? activeConversation : conversations[0];
	} else {
		if (Array.isArray(stored[LEGACY_HISTORY_KEY])) {
			await chrome.storage.session.set({ [historyKey("默认")]: stored[LEGACY_HISTORY_KEY] });
			await chrome.storage.session.remove(LEGACY_HISTORY_KEY);
		}
		conversations = ["默认"];
		activeConversation = "默认";
	}
}

function historyKey(name) {
	return HISTORY_KEY_PREFIX + name;
}

async function saveConversations() {
	await chrome.storage.session.set({ [CONVOS_KEY]: conversations });
}

async function loadHistory(name) {
	const stored = await chrome.storage.session.get(historyKey(name));
	const history = Array.isArray(stored[historyKey(name)]) ? stored[historyKey(name)] : [];
	for (const entry of history) {
		if (entry?.role) appendBubble(entry.role, entry.text);
	}
	updateEmptyState();
	messagesEl.scrollTop = messagesEl.scrollHeight;
}

async function saveToHistory(name, role, text) {
	const key = historyKey(name);
	const stored = await chrome.storage.session.get(key);
	const history = Array.isArray(stored[key]) ? stored[key] : [];
	history.push({ role, text });
	await chrome.storage.session.set({ [key]: history.slice(-HISTORY_LIMIT) });
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

function appendBubble(role, text) {
	const el = document.createElement("div");
	el.className = `msg ${role}`;
	el.textContent = text;
	messagesEl.appendChild(el);
	messagesEl.scrollTop = messagesEl.scrollHeight;
	return el;
}

function addMessage(role, text, pending = false) {
	if (pendingEl && role === "assistant") {
		pendingEl.remove();
		pendingEl = null;
	}
	const el = appendBubble(role, text);
	if (pending) {
		el.classList.add("pending");
	} else {
		saveToHistory(activeConversation, role, text);
	}
	updateEmptyState();
	updateSendButton();
	return el;
}

function updateEmptyState() {
	emptyStateEl.style.display = messagesEl.children.length === 0 ? "flex" : "none";
}

function showPending(text = "Omega 正在思考…") {
	if (pendingEl) {
		pendingEl.remove();
	}
	pendingEl = addMessage("assistant", text, true);
	updateSendButton();
}

function updateSendButton() {
	const streaming = pendingEl !== null;
	sendEl.innerHTML = streaming
		? '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>'
		: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>';
	sendEl.title = streaming ? "停止当前回合" : "发送";
}

function renderStatusLine(connected) {
	const agent = agents.find((entry) => entry.agentId === selectedAgentId);
	const model = agent?.sessionInfo?.model?.name;
	const sessionId = agent?.sessionInfo?.sessionId ?? activeConversation;
	statusEl.textContent = connected ? `● 已连接 · ${sessionId ?? ""}` : "● 未连接";
	statusEl.classList.toggle("connected", connected);
	modelTagEl.textContent = model ?? "";
}

function renderAgentSelector() {
	agentSelectEl.innerHTML = "";
	if (agents.length === 0) {
		const option = document.createElement("option");
		option.textContent = "（未发现智能体）";
		agentSelectEl.appendChild(option);
		agentSelectEl.disabled = true;
		return;
	}
	agentSelectEl.disabled = false;
	for (const agent of agents) {
		const option = document.createElement("option");
		option.value = agent.agentId;
		const model = agent.sessionInfo?.model?.name;
		option.textContent = model ? `${agent.agentName} · ${model}` : agent.agentName;
		option.selected = agent.selected;
		agentSelectEl.appendChild(option);
	}
}

function renderSessionSelector() {
	sessionSelectEl.innerHTML = "";
	for (const name of conversations) {
		const option = document.createElement("option");
		option.value = name;
		option.textContent = name;
		sessionSelectEl.appendChild(option);
	}
	sessionSelectEl.value = activeConversation;
}

async function switchConversation(name, op) {
	activeConversation = name;
	if (!conversations.includes(name)) {
		conversations.push(name);
		await saveConversations();
	}
	renderSessionSelector();
	pendingEl = null;
	messagesEl.innerHTML = "";
	updateSendButton();
	await loadHistory(name);
	renderStatusLine(true);
	await chrome.runtime.sendMessage({ type: "switch_session", op, name });
}

// ---------------------------------------------------------------------------
// 斜杠命令
// ---------------------------------------------------------------------------

const COMMAND_HINT_MAX = 6;

function updateCommandHint() {
	const value = inputEl.value.trimStart();
	if (!value.startsWith("/") || value.includes(" ")) {
		commandHintEl.style.display = "none";
		return;
	}
	const matches = SLASH_COMMANDS.filter((entry) => entry.cmd.startsWith(value.toLowerCase()));
	if (matches.length === 0) {
		commandHintEl.style.display = "none";
		return;
	}
	commandHintEl.innerHTML = "";
	for (const entry of matches.slice(0, COMMAND_HINT_MAX)) {
		const hint = document.createElement("div");
		hint.className = "hint";
		const icon = document.createElement("span");
		icon.className = "hint-icon";
		icon.innerHTML = entry.icon;
		const code = document.createElement("code");
		code.textContent = entry.cmd;
		const desc = document.createElement("span");
		desc.textContent = entry.args ? `${entry.args} · ${entry.desc}` : entry.desc;
		hint.appendChild(icon);
		hint.appendChild(code);
		hint.appendChild(desc);
		hint.addEventListener("click", () => {
			inputEl.value = `${entry.cmd} `;
			inputEl.focus();
			updateCommandHint();
		});
		commandHintEl.appendChild(hint);
	}
	commandHintEl.style.display = "block";
}

async function handleSlashCommand(raw) {
	const spaceIndex = raw.indexOf(" ");
	const command = (spaceIndex < 0 ? raw : raw.slice(0, spaceIndex)).toLowerCase();
	const argText = spaceIndex < 0 ? "" : raw.slice(spaceIndex + 1).trim();

	switch (command) {
		case "/help":
			addMessage(
				"system",
				SLASH_COMMANDS.map((entry) => `${entry.icon} ${entry.cmd} ${entry.args} — ${entry.desc}`.trim()).join("\n"),
			);
			return;
		case "/export":
			await exportConversation();
			return;
		case "/broadcast":
			if (!argText) {
				addMessage("system", "用法：/broadcast <要广播的文本>");
				return;
			}
			await sendBroadcast(argText);
			return;
		case "/new": {
			const name = argText || nextConversationName();
			await switchConversation(name, "new");
			addMessage("system", `已创建并切换到会话「${name}」。`);
			return;
		}
		case "/switch":
			if (!argText) {
				addMessage("system", `用法：/switch <名称>。现有：${conversations.join("、")}`);
				return;
			}
			if (!conversations.includes(argText)) {
				addMessage("system", `会话「${argText}」不存在。现有：${conversations.join("、")}`);
				return;
			}
			await switchConversation(argText, "switch");
			return;
		case "/clear":
			await clearConversation();
			return;
		case "/agents": {
			if (agents.length === 0) {
				addMessage("system", "当前没有已连接的智能体。");
				return;
			}
			addMessage(
				"system",
				agents
					.map(
						(agent) =>
							`${agent.selected ? "→" : "　"} ${agent.agentName}${agent.sessionInfo?.model ? ` · ${agent.sessionInfo.model.name}` : ""}`,
					)
					.join("\n"),
			);
			return;
		}
		default:
			addMessage("system", `未知命令 ${command}。输入 / 查看可用命令。`);
	}
}

function nextConversationName() {
	let index = conversations.length + 1;
	let name = `会话-${index}`;
	while (conversations.includes(name)) {
		index += 1;
		name = `会话-${index}`;
	}
	return name;
}

async function clearConversation() {
	const key = historyKey(activeConversation);
	await chrome.storage.session.set({ [key]: [] });
	pendingEl = null;
	messagesEl.innerHTML = "";
	updateEmptyState();
	updateSendButton();
	addMessage("system", `已清空会话「${activeConversation}」的聊天记录。`);
}

async function exportConversation() {
	const key = historyKey(activeConversation);
	const stored = await chrome.storage.session.get(key);
	const history = Array.isArray(stored[key]) ? stored[key] : [];
	if (history.length === 0) {
		addMessage("system", `会话「${activeConversation}」还没有可导出的消息。`);
		return;
	}
	const lines = [`# Omega 会话记录：${activeConversation}`, "", `导出时间：${new Date().toLocaleString()}`, ""];
	for (const entry of history) {
		if (entry?.role === "user") lines.push(`**你：**\n\n${entry.text}\n`);
		else if (entry?.role === "assistant") lines.push(`**Omega：**\n\n${entry.text}\n`);
		else if (entry?.role === "broadcast") lines.push(`> 📣 **广播：** ${entry.text}\n`);
	}
	const markdown = lines.join("\n");
	try {
		await navigator.clipboard.writeText(markdown);
		addMessage("system", `已复制会话「${activeConversation}」的 ${history.length} 条消息为 Markdown 到剪贴板。`);
	} catch (error) {
		addMessage("system", `复制到剪贴板失败：${error instanceof Error ? error.message : String(error)}`);
	}
}

// ---------------------------------------------------------------------------
// 发送
// ---------------------------------------------------------------------------

async function sendBroadcast(text) {
	addMessage("broadcast", `📣 ${text}`);
	const response = await chrome.runtime.sendMessage({ type: "broadcast_send", text });
	if (!response?.ok) {
		addMessage("assistant", "桥接未连接：请确认 Omega 会话正在运行。");
	}
}

async function sendMessage() {
	const text = inputEl.value.trim();
	if (!text) return;
	inputEl.value = "";
	inputEl.style.height = "22px";
	updateCommandHint();

	if (text.startsWith("/")) {
		await handleSlashCommand(text);
		return;
	}
	if (broadcastMode) {
		await sendBroadcast(text);
		return;
	}

	addMessage("user", text);
	const response = await chrome.runtime.sendMessage({ type: "chat_send", text });
	if (!response?.ok) {
		addMessage("assistant", "桥接未连接：请确认 Omega 会话正在运行，且扩展状态为 Connected。");
		return;
	}
	showPending();
}

// ---------------------------------------------------------------------------
// 事件
// ---------------------------------------------------------------------------

async function refreshStatus() {
	try {
		const status = await chrome.runtime.sendMessage({ type: "status" });
		agents = status.agents ?? [];
		selectedAgentId = status.selectedAgentId ?? selectedAgentId;
		const selected = agents.find((agent) => agent.selected);
		const connected = Boolean(selected);
		renderAgentSelector();
		renderStatusLine(connected);
		sendEl.disabled = !connected;
	} catch {
		statusEl.textContent = "● 未连接";
		sendEl.disabled = true;
	}
}

sendEl.addEventListener("click", () => {
	if (pendingEl) {
		stopAgent();
		return;
	}
	sendMessage();
});

async function stopAgent() {
	const response = await chrome.runtime.sendMessage({ type: "stop_agent" });
	if (response?.ok) {
		if (pendingEl) {
			pendingEl.remove();
			pendingEl = null;
		}
		addMessage("system", "已请求停止当前回合。");
	}
}
inputEl.addEventListener("keydown", (event) => {
	if (event.key === "Enter" && !event.shiftKey) {
		event.preventDefault();
		sendMessage();
	}
});
inputEl.addEventListener("input", () => {
	inputEl.style.height = "22px";
	inputEl.style.height = `${Math.min(inputEl.scrollHeight, 120)}px`;
	updateCommandHint();
});

broadcastBtnEl.addEventListener("click", () => {
	broadcastMode = !broadcastMode;
	broadcastBtnEl.className = broadcastMode ? "active" : "";
	inputEl.placeholder = broadcastMode
		? "广播模式：信息将注入运行中的智能体"
		: "询问任何事，/ 使用命令";
});

menuBtnEl.addEventListener("click", () => {
	sessionBarEl.classList.toggle("open");
});

agentSelectEl.addEventListener("change", async () => {
	const response = await chrome.runtime.sendMessage({ type: "select_agent", agentId: agentSelectEl.value });
	if (response?.ok) {
		selectedAgentId = agentSelectEl.value;
		refreshStatus();
	} else {
		refreshStatus();
	}
});

sessionSelectEl.addEventListener("change", () => {
	if (sessionSelectEl.value !== activeConversation) {
		switchConversation(sessionSelectEl.value, "switch");
	}
});

newSessionEl.addEventListener("click", () => {
	switchConversation(nextConversationName(), "new");
});

chrome.runtime.onMessage.addListener((message) => {
	if (message?.type === "session_info") {
		if ((!selectedAgentId || message.agentId === selectedAgentId) && message.model?.name) {
			renderStatusLine(Boolean(selectedAgentId));
		}
		refreshStatus();
		return;
	}
	if (message?.type !== "chat_reply") return;
	if (message.queued) {
		showPending("已排队：Omega 正在处理其他任务，完成后自动回复。");
		return;
	}
	if (typeof message.text === "string" && message.text) {
		addMessage(message.broadcast ? "broadcast" : "assistant", message.broadcast ? `📣 ${message.text}` : message.text);
	}
	if (message.done) {
		if (pendingEl) {
			pendingEl.remove();
			pendingEl = null;
			addMessage("assistant", "（本轮无文本输出）");
		}
		updateSendButton();
	}
});

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

async function init() {
	updateSendButton();
	await loadConversations();
	renderSessionSelector();
	await loadHistory(activeConversation);
	updateEmptyState();
	refreshStatus();
}

init();
setInterval(refreshStatus, 2000);
