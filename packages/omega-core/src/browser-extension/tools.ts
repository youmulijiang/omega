import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { AgentToolResult, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { bridgeStatus, sendBridgeCommand } from "./bridge.ts";

/**
 * 浏览器分支（浏览器桥接）工具：通过 plugins/browser-plugin 扩展控制
 * 用户日常使用的 Chrome（保留登录态），与 chrome_devtools_* 的 CDP 模式互补。
 */

const TOOL_LABEL = "Browser Bridge";

export function textResult<T>(text: string, details: T): AgentToolResult<T> {
	return {
		content: [{ type: "text", text }],
		details,
	};
}

interface RenderTheme {
	bold(text: string): string;
	fg(color: string, text: string): string;
}

class BridgeTextComponent {
	private text: string;
	private readonly theme?: RenderTheme;

	constructor(text: string, theme?: RenderTheme) {
		this.text = text;
		this.theme = theme;
	}

	invalidate() {
		// Stateless renderer: no cached layout to invalidate.
	}

	render(width: number): string[] {
		if (!this.text.trim()) return [];
		return this.text
			.split(/\r?\n/)
			.map((line) => Array.from(line).slice(0, Math.max(1, width)).join(""))
			.map((line) => (this.theme ? this.theme.fg("toolOutput", line) : line));
	}
}

function renderCall(action: string) {
	return () => new BridgeTextComponent(`${TOOL_LABEL}: ${action}`);
}

function renderResult(result: AgentToolResult<unknown>, options: ToolRenderResultOptions, theme: RenderTheme) {
	if (options.isPartial) return new BridgeTextComponent("Running...", theme);
	if (!options.expanded) return new BridgeTextComponent("", theme);
	const text = result.content.flatMap((content) => (content.type === "text" ? [content.text] : [])).join("\n");
	return new BridgeTextComponent(text, theme);
}

const optionalTabId = {
	tabId: Type.Optional(
		Type.Number({ description: "Optional tab id from browser_ext_list_tabs. Defaults to the active tab." }),
	),
};

export const bridgeStatusTool = defineTool({
	name: "browser_ext_status",
	label: "Browser Bridge: Status",
	description: "Show whether the Chrome extension bridge server is running and whether the extension is connected.",
	parameters: Type.Object({}),
	renderCall: renderCall("status"),
	renderResult,
	async execute() {
		const status = bridgeStatus();
		const lines = [
			`Bridge server: ${status.running ? `running on ws://127.0.0.1:${status.port}` : "not running"}`,
			`Extension: ${status.connected ? `connected (${status.extension ?? "unknown"} v${status.version ?? "?"})` : "not connected"}`,
		];
		if (!status.running) {
			lines.push("Load plugins/browser-plugin in Chrome via chrome://extensions (Load unpacked) to connect.");
		}
		return textResult(lines.join("\n"), status);
	},
});

export const listTabsTool = defineTool({
	name: "browser_ext_list_tabs",
	label: "Browser Bridge: List Tabs",
	description: "List open Chrome tabs through the browser extension bridge (the user's normal Chrome profile).",
	parameters: Type.Object({}),
	renderCall: renderCall("list tabs"),
	renderResult,
	async execute(_toolCallId, _params, signal) {
		const tabs = await sendBridgeCommand("list_tabs", {}, signal);
		return textResult(JSON.stringify(tabs, null, 2), { tabs });
	},
});

export const selectTabTool = defineTool({
	name: "browser_ext_select_tab",
	label: "Browser Bridge: Select Tab",
	description: "Bring a Chrome tab to the foreground through the browser extension bridge.",
	parameters: Type.Object({
		tabId: Type.Number({ description: "Tab id from browser_ext_list_tabs." }),
	}),
	renderCall: renderCall("select tab"),
	renderResult,
	async execute(_toolCallId, params, signal) {
		const tab = await sendBridgeCommand("select_tab", { tabId: params.tabId }, signal);
		return textResult(`Focused tab ${params.tabId}`, { tab });
	},
});

export const navigateTool = defineTool({
	name: "browser_ext_navigate",
	label: "Browser Bridge: Navigate",
	description:
		"Navigate a Chrome tab to a URL (or open a new tab) through the browser extension bridge, in the user's logged-in Chrome session.",
	parameters: Type.Object({
		url: Type.String({ description: "URL to navigate to." }),
		...optionalTabId,
	}),
	renderCall: renderCall("navigate"),
	renderResult,
	async execute(_toolCallId, params, signal) {
		const result = await sendBridgeCommand("navigate", { url: params.url, tabId: params.tabId }, signal);
		return textResult(`Navigated to ${params.url}`, { result });
	},
});

export const evaluateTool = defineTool({
	name: "browser_ext_evaluate",
	label: "Browser Bridge: Evaluate",
	description:
		"Evaluate JavaScript in the page's main world through the browser extension bridge. The result must be JSON-serializable.",
	parameters: Type.Object({
		expression: Type.String({ description: "JavaScript expression to evaluate in the page." }),
		...optionalTabId,
	}),
	renderCall: renderCall("evaluate"),
	renderResult,
	async execute(_toolCallId, params, signal) {
		const value = await sendBridgeCommand("evaluate", { expression: params.expression, tabId: params.tabId }, signal);
		return textResult(JSON.stringify(value, null, 2), { value });
	},
});

export const getContentTool = defineTool({
	name: "browser_ext_get_content",
	label: "Browser Bridge: Get Content",
	description: "Read the title, URL, visible text, and HTML of a Chrome page through the browser extension bridge.",
	parameters: Type.Object({
		...optionalTabId,
		maxLength: Type.Optional(
			Type.Number({ description: "Maximum characters of text/html to return. Defaults to 50000." }),
		),
	}),
	renderCall: renderCall("get content"),
	renderResult,
	async execute(_toolCallId, params, signal) {
		const content = await sendBridgeCommand(
			"get_content",
			{ tabId: params.tabId, maxLength: params.maxLength },
			signal,
		);
		const record = content as { title?: string; url?: string; text?: string } | undefined;
		const summary = record ? `${record.title ?? "(untitled)"}\n${record.url ?? ""}\n\n${record.text ?? ""}` : "";
		return textResult(summary.trim() || JSON.stringify(content, null, 2), { content });
	},
});

export const screenshotTool = defineTool({
	name: "browser_ext_screenshot",
	label: "Browser Bridge: Screenshot",
	description:
		"Capture the visible area of a Chrome tab through the browser extension bridge and save it as a PNG file.",
	parameters: Type.Object({ ...optionalTabId }),
	renderCall: renderCall("screenshot"),
	renderResult,
	async execute(_toolCallId, params, signal) {
		const result = (await sendBridgeCommand("screenshot", { tabId: params.tabId }, signal)) as
			| { dataUrl?: string }
			| undefined;
		const dataUrl = result?.dataUrl;
		if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/png;base64,")) {
			throw new Error("Extension returned no screenshot data");
		}
		const base64 = dataUrl.slice("data:image/png;base64,".length);
		const bytes = Buffer.from(base64, "base64");
		const savedPath = join(tmpdir(), `omega-browser-ext-${Date.now()}.png`);
		await writeFile(savedPath, bytes);
		return textResult(`Saved screenshot to ${savedPath} (${bytes.length} bytes)`, { savedPath, bytes: bytes.length });
	},
});

export const clickTool = defineTool({
	name: "browser_ext_click",
	label: "Browser Bridge: Click",
	description:
		"Click the first element matching a CSS selector in a Chrome page through the browser extension bridge.",
	parameters: Type.Object({
		selector: Type.String({ description: "CSS selector of the element to click." }),
		...optionalTabId,
	}),
	renderCall: renderCall("click"),
	renderResult,
	async execute(_toolCallId, params, signal) {
		await sendBridgeCommand("click", { selector: params.selector, tabId: params.tabId }, signal);
		return textResult(`Clicked ${params.selector}`, { selector: params.selector });
	},
});

export const typeTool = defineTool({
	name: "browser_ext_type",
	label: "Browser Bridge: Type",
	description:
		"Set the value of an input or textarea matching a CSS selector and dispatch input/change events, through the browser extension bridge.",
	parameters: Type.Object({
		selector: Type.String({ description: "CSS selector of the input element." }),
		text: Type.String({ description: "Text to set as the element value." }),
		...optionalTabId,
	}),
	renderCall: renderCall("type"),
	renderResult,
	async execute(_toolCallId, params, signal) {
		await sendBridgeCommand("type", { selector: params.selector, text: params.text, tabId: params.tabId }, signal);
		return textResult(`Typed ${params.text.length} characters into ${params.selector}`, {
			selector: params.selector,
		});
	},
});

export const getAuthTool = defineTool({
	name: "browser_ext_get_auth",
	label: "Browser Bridge: Get Auth Context",
	description:
		"Read authentication context (cookies including HttpOnly, document.cookie, localStorage, sessionStorage) for a Chrome tab's origin through the browser extension bridge. Use only in authorized testing environments.",
	parameters: Type.Object({
		...optionalTabId,
		maxCookies: Type.Optional(Type.Number({ description: "Maximum number of cookies to return. Defaults to all." })),
	}),
	renderCall: renderCall("get auth context"),
	renderResult,
	async execute(_toolCallId, params, signal) {
		const auth = await sendBridgeCommand("get_auth", { tabId: params.tabId, maxCookies: params.maxCookies }, signal);
		const record = auth as
			| { url?: string; origin?: string; totalCookies?: number; cookies?: Array<{ name: string }> }
			| undefined;
		const cookieNames = record?.cookies?.map((cookie) => cookie.name).join(", ") ?? "";
		const summary = [
			`URL: ${record?.url ?? "?"}`,
			`Origin: ${record?.origin ?? "?"}`,
			`Cookies (${record?.totalCookies ?? 0}): ${cookieNames}`,
			"Full JSON in details.",
		].join("\n");
		return textResult(summary, { auth });
	},
});
