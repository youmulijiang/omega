const STATUS_LABELS = {
	connected: "Connected",
	reconnecting: "Reconnecting…",
	disconnected: "Disconnected",
	error: "Disconnected",
};

const pillEl = document.getElementById("pill");
const statusTextEl = document.getElementById("statusText");
const agentListEl = document.getElementById("agentList");
const lastErrorEl = document.getElementById("lastError");
const versionEl = document.getElementById("version");
const gearEl = document.getElementById("gear");
const settingsEl = document.getElementById("settings");
const portEl = document.getElementById("port");
const saveEl = document.getElementById("save");

versionEl.textContent = `Version v${chrome.runtime.getManifest().version}`;

function renderStatus(status) {
	const agents = status.agents ?? [];
	const connected = agents.filter((agent) => agent.identified);

	let state;
	if (connected.length > 0) {
		state = "connected";
	} else if (agents.length > 0) {
		state = "reconnecting";
	} else {
		state = "disconnected";
	}
	pillEl.className = `pill ${state}`;
	statusTextEl.textContent = connected.length > 0 ? `Connected ×${connected.length}` : STATUS_LABELS[state];

	agentListEl.innerHTML = "";
	for (const agent of connected) {
		const row = document.createElement("div");
		row.className = agent.selected ? "agent selected" : "agent";
		const marker = document.createElement("span");
		marker.className = "marker";
		marker.textContent = agent.selected ? "✓" : "";
		const name = document.createElement("span");
		name.className = "name";
		name.textContent = agent.agentName;
		const model = document.createElement("span");
		model.className = "model";
		model.textContent = agent.sessionInfo?.model?.name ?? "";
		row.appendChild(marker);
		row.appendChild(name);
		row.appendChild(model);
		row.title = agent.selected ? "当前侧边栏对话的智能体，点击取消选择" : "设为侧边栏对话的默认智能体";
		row.addEventListener("click", async () => {
			await chrome.runtime.sendMessage({ type: "select_agent", agentId: agent.agentId });
			refresh();
		});
		agentListEl.appendChild(row);
	}

	const error = state === "connected" ? "" : status.lastError ?? "";
	lastErrorEl.textContent = error;
	lastErrorEl.style.display = error ? "block" : "none";

	if (document.activeElement !== portEl) {
		const selected = agents.find((agent) => agent.selected) ?? connected[0];
		portEl.placeholder = selected ? `自动（当前 ${selected.port}）` : "自动";
	}
}

async function refresh() {
	const status = await chrome.runtime.sendMessage({ type: "status" });
	renderStatus(status);
}

gearEl.addEventListener("click", () => {
	settingsEl.classList.toggle("open");
	gearEl.classList.toggle("open");
});

document.getElementById("openSidePanel").addEventListener("click", async () => {
	const currentWindow = await chrome.windows.getCurrent();
	await chrome.sidePanel.open({ windowId: currentWindow.id });
	window.close();
});

saveEl.addEventListener("click", async () => {
	const raw = portEl.value.trim();
	if (!raw) {
		await chrome.storage.local.remove("omegaBridgePort");
	} else {
		const port = Number(raw);
		if (!Number.isInteger(port) || port <= 0 || port >= 65536) return;
		await chrome.storage.local.set({ omegaBridgePort: port });
	}
	await chrome.runtime.sendMessage({ type: "reconnect" });
	setTimeout(refresh, 600);
});

refresh();
setInterval(refresh, 1500);
