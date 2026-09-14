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
 *
 * 10 个动作合并为一个编号调度工具：模型用 `number`（1, 2, 3, ...）加该动作
 * 的参数作答，由运行时分发执行，减少工具 JSON Schema 与回答的 token 开销。
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

interface BridgeActionParams {
	tabId?: number;
	url?: string;
	expression?: string;
	maxLength?: number;
	maxCookies?: number;
	selector?: string;
	text?: string;
}

interface BridgeAction {
	name: string;
	summary: string;
	/** Parameter names the caller must provide for this action. */
	required: Array<keyof BridgeActionParams>;
	execute(params: BridgeActionParams, signal: AbortSignal | undefined): Promise<AgentToolResult<unknown>>;
}

const BRIDGE_ACTIONS: BridgeAction[] = [
	{
		name: "status",
		summary: "bridge server and extension connection status",
		required: [],
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
	},
	{
		name: "list_tabs",
		summary: "list open Chrome tabs (the user's normal Chrome profile)",
		required: [],
		async execute(_params, signal) {
			const tabs = await sendBridgeCommand("list_tabs", {}, signal);
			return textResult(JSON.stringify(tabs, null, 2), { tabs });
		},
	},
	{
		name: "select_tab",
		summary: "bring a tab to the foreground",
		required: ["tabId"],
		async execute(params, signal) {
			const tab = await sendBridgeCommand("select_tab", { tabId: params.tabId }, signal);
			return textResult(`Focused tab ${params.tabId}`, { tab });
		},
	},
	{
		name: "navigate",
		summary: "navigate a tab to a URL (or open a new tab) in the logged-in session",
		required: ["url"],
		async execute(params, signal) {
			const result = await sendBridgeCommand("navigate", { url: params.url, tabId: params.tabId }, signal);
			return textResult(`Navigated to ${params.url}`, { result });
		},
	},
	{
		name: "evaluate",
		summary: "evaluate JavaScript in the page's main world (JSON-serializable result)",
		required: ["expression"],
		async execute(params, signal) {
			const value = await sendBridgeCommand(
				"evaluate",
				{ expression: params.expression, tabId: params.tabId },
				signal,
			);
			return textResult(JSON.stringify(value, null, 2), { value });
		},
	},
	{
		name: "get_content",
		summary: "read a page's title, URL, visible text, and HTML (maxLength defaults to 50000)",
		required: [],
		async execute(params, signal) {
			const content = await sendBridgeCommand(
				"get_content",
				{ tabId: params.tabId, maxLength: params.maxLength },
				signal,
			);
			const record = content as { title?: string; url?: string; text?: string } | undefined;
			const summary = record ? `${record.title ?? "(untitled)"}\n${record.url ?? ""}\n\n${record.text ?? ""}` : "";
			return textResult(summary.trim() || JSON.stringify(content, null, 2), { content });
		},
	},
	{
		name: "screenshot",
		summary: "capture the visible area of a tab and save it as a PNG file",
		required: [],
		async execute(params, signal) {
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
			return textResult(`Saved screenshot to ${savedPath} (${bytes.length} bytes)`, {
				savedPath,
				bytes: bytes.length,
			});
		},
	},
	{
		name: "click",
		summary: "click the first element matching a CSS selector",
		required: ["selector"],
		async execute(params, signal) {
			await sendBridgeCommand("click", { selector: params.selector, tabId: params.tabId }, signal);
			return textResult(`Clicked ${params.selector}`, { selector: params.selector });
		},
	},
	{
		name: "type",
		summary: "set the value of an input/textarea matching a CSS selector and dispatch input/change events",
		required: ["selector", "text"],
		async execute(params, signal) {
			const value = params.text ?? "";
			await sendBridgeCommand("type", { selector: params.selector, text: value, tabId: params.tabId }, signal);
			return textResult(`Typed ${value.length} characters into ${params.selector}`, {
				selector: params.selector,
			});
		},
	},
	{
		name: "get_auth",
		summary:
			"read auth context (cookies incl. HttpOnly, document.cookie, localStorage, sessionStorage); authorized testing only",
		required: [],
		async execute(params, signal) {
			const auth = await sendBridgeCommand(
				"get_auth",
				{ tabId: params.tabId, maxCookies: params.maxCookies },
				signal,
			);
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
	},
];

function formatActionList(): string {
	return BRIDGE_ACTIONS.map((action, index) => {
		const params = action.required.length > 0 ? `params: ${action.required.join(", ")}` : "no params";
		return `${index + 1}. ${action.name} (${params}) — ${action.summary}`;
	}).join("\n");
}

export const browserExtTool = defineTool({
	name: "browser_ext",
	label: TOOL_LABEL,
	description:
		"Control the user's Chrome through the browser extension bridge. Answer with `number` (the action's number below) plus only that action's parameters; `tabId` is optional everywhere and defaults to the active tab.\n" +
		`${formatActionList()}\n` +
		'Example: { number: 4, url: "https://example.test" }',
	parameters: Type.Object({
		number: Type.Integer({ minimum: 1, description: "Action number from the list in this tool's description." }),
		tabId: Type.Optional(Type.Number({ description: "Optional tab id; defaults to the active tab." })),
		url: Type.Optional(Type.String({ description: "URL for navigate." })),
		expression: Type.Optional(Type.String({ description: "JavaScript expression for evaluate." })),
		maxLength: Type.Optional(
			Type.Number({ description: "Max characters of text/html for get_content. Defaults to 50000." }),
		),
		maxCookies: Type.Optional(Type.Number({ description: "Max cookies for get_auth. Defaults to all." })),
		selector: Type.Optional(Type.String({ description: "CSS selector for click/type." })),
		text: Type.Optional(Type.String({ description: "Text to set for type." })),
	}),
	renderCall: renderCall("action"),
	renderResult,
	async execute(_toolCallId, params, signal) {
		const action = BRIDGE_ACTIONS[params.number - 1];
		if (!action) {
			return {
				content: [
					{
						type: "text",
						text: `Invalid action number ${params.number}. Valid range: 1-${BRIDGE_ACTIONS.length}.`,
					},
				],
				details: { ok: false as const },
				isError: true,
			};
		}
		const missing = action.required.filter((name) => params[name] === undefined);
		if (missing.length > 0) {
			return {
				content: [
					{
						type: "text",
						text: `Action ${action.name} requires: ${missing.join(", ")}.`,
					},
				],
				details: { ok: false as const },
				isError: true,
			};
		}
		const result = await action.execute(params, signal);
		return result;
	},
});
