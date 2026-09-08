import { StringEnum, Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import {
	formatPage,
	getPage,
	listPages,
	resolvePage,
	resolvePageForNavigation,
	setActivePageId,
	textResult,
	withCdp,
} from "./cdp-client.ts";
import {
	activeNetworkCapture,
	type CapturedRequest,
	getCapturedRequestDetail,
	listCapturedRequests,
	startNetworkCapture,
	stopNetworkCapture,
} from "./network.ts";
import { renderScreenshotResult, renderTextResult, renderToolCall, withStatus } from "./render.ts";
import { formatScreenshotText, saveScreenshot, throwIfAborted } from "./screenshot.ts";
import { CHROME_DEVTOOLS_TOOL_NAMES, WEBMCP_TOOL_NAMES } from "./tool-names.ts";
import { executeWebMcpCallTool, executeWebMcpListTool } from "./webmcp/tools.ts";

export const listPagesTool = defineTool({
	name: CHROME_DEVTOOLS_TOOL_NAMES[0],
	label: "Chrome DevTools: List Pages",
	description: "List Chrome tabs/pages from a running Chrome DevTools Protocol endpoint.",
	parameters: Type.Object({}),
	renderCall: renderToolCall("list pages"),
	renderResult: renderTextResult,
	async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
		return withStatus(ctx, "list pages", async () => {
			const pages = await listPages({ sessionOwner: ctx.sessionManager, signal });
			return textResult(JSON.stringify(pages.map(formatPage), null, 2), { pages });
		});
	},
});

export const selectPageTool = defineTool({
	name: CHROME_DEVTOOLS_TOOL_NAMES[1],
	label: "Chrome DevTools: Select Page",
	description: "Select the active Chrome page for later chrome_devtools_* tool calls.",
	parameters: Type.Object({
		pageId: Type.String({ description: "Page id from chrome_devtools_list_pages." }),
	}),
	renderCall: renderToolCall("select page"),
	renderResult: renderTextResult,
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		return withStatus(ctx, "select page", async () => {
			const page = await getPage(params.pageId, { sessionOwner: ctx.sessionManager, signal });
			setActivePageId(ctx.sessionManager, page.id);
			return textResult(`Selected page ${page.id}: ${page.title}\n${page.url}`, {
				page: formatPage(page),
			});
		});
	},
});

export const navigateTool = defineTool({
	name: CHROME_DEVTOOLS_TOOL_NAMES[2],
	label: "Chrome DevTools: Navigate",
	description:
		"Navigate a Chrome page to a URL through Chrome DevTools Protocol, creating a page first if none is available.",
	parameters: Type.Object({
		url: Type.String({ description: "URL to navigate to." }),
		pageId: Type.Optional(Type.String({ description: "Optional page id. Defaults to selected or first page." })),
	}),
	renderCall: renderToolCall("navigate"),
	renderResult: renderTextResult,
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		return withStatus(ctx, "navigate", async () => {
			const { created, page } = await resolvePageForNavigation(params.pageId, {
				sessionOwner: ctx.sessionManager,
				signal,
			});
			const result = await withCdp(page, async (client) => {
				await client.send("Page.enable");
				return client.send("Page.navigate", { url: params.url });
			});

			setActivePageId(ctx.sessionManager, page.id);
			const action = created ? "Created page and navigated" : "Navigated";
			return textResult(`${action} ${page.id} to ${params.url}`, {
				created,
				page: formatPage(page),
				result,
			});
		});
	},
});

export const evaluateTool = defineTool({
	name: CHROME_DEVTOOLS_TOOL_NAMES[3],
	label: "Chrome DevTools: Evaluate",
	description: "Evaluate JavaScript in a Chrome page through Chrome DevTools Protocol.",
	parameters: Type.Object({
		expression: Type.String({ description: "JavaScript expression to evaluate." }),
		pageId: Type.Optional(Type.String({ description: "Optional page id. Defaults to selected or first page." })),
		awaitPromise: Type.Optional(
			Type.Boolean({ description: "Whether to await a returned Promise. Defaults to true." }),
		),
	}),
	renderCall: renderToolCall("evaluate"),
	renderResult: renderTextResult,
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		return withStatus(ctx, "evaluate", async () => {
			const page = await resolvePage(params.pageId, {
				sessionOwner: ctx.sessionManager,
				signal,
			});
			const result = await withCdp(page, (client) =>
				client.send("Runtime.evaluate", {
					expression: params.expression,
					awaitPromise: params.awaitPromise ?? true,
					returnByValue: true,
				}),
			);

			setActivePageId(ctx.sessionManager, page.id);
			return textResult(JSON.stringify(result, null, 2), { page: formatPage(page), result });
		});
	},
});

export const webMcpListToolsTool = defineTool({
	name: WEBMCP_TOOL_NAMES[0],
	label: "Chrome DevTools: List WebMCP Tools (Experimental)",
	description:
		"List bounded page-provided WebMCP tool descriptors from the selected Chrome page through the experimental CDP WebMCP domain. Definitions remain in this tool result and are never registered as dynamic Pi tools.",
	parameters: Type.Object({
		pageId: Type.Optional(
			Type.String({
				description: "Optional page id. Defaults to selected or first page.",
				maxLength: 512,
			}),
		),
	}),
	renderCall: renderToolCall("list WebMCP tools"),
	renderResult: renderTextResult,
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		return withStatus(ctx, "list WebMCP tools", async () => {
			return executeWebMcpListTool(params, signal, ctx);
		});
	},
});

export const webMcpCallTool = defineTool({
	name: WEBMCP_TOOL_NAMES[1],
	label: "Chrome DevTools: Call WebMCP Tool (Experimental)",
	description:
		"Call one previously listed page-provided WebMCP tool after exact page, document, frame, origin, schema, annotation, and session revalidation. Every call requires observable user confirmation and output is bounded to Pi's 50 KB or 2,000-line limit.",
	parameters: Type.Object({
		sessionGeneration: Type.String({
			description: "Session generation token returned by chrome_devtools_webmcp_list_tools.",
			maxLength: 100,
		}),
		pageId: Type.String({ description: "Page id returned by the list tool.", maxLength: 512 }),
		documentId: Type.String({
			description: "Document loader id returned by the list tool.",
			maxLength: 512,
		}),
		frameId: Type.String({ description: "Frame id returned by the list tool.", maxLength: 512 }),
		frameOrigin: Type.String({
			description: "Exact frame origin returned by the list tool.",
			maxLength: 2_048,
		}),
		toolName: Type.String({
			description: "Exact tool name returned by the list tool.",
			maxLength: 512,
		}),
		schemaDigest: Type.String({
			description: "Schema and annotation digest returned by the list tool.",
			minLength: 64,
			maxLength: 64,
			pattern: "^[a-f0-9]{64}$",
		}),
		input: Type.Record(Type.String(), Type.Unknown(), {
			description: "JSON object matching the page-provided input schema.",
		}),
	}),
	renderCall: renderToolCall("call WebMCP tool"),
	renderResult: renderTextResult,
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		return withStatus(ctx, "call WebMCP tool", async () => {
			return executeWebMcpCallTool(params, signal, ctx);
		});
	},
});

export const screenshotTool = defineTool({
	name: CHROME_DEVTOOLS_TOOL_NAMES[4],
	label: "Chrome DevTools: Screenshot",
	description: "Capture a PNG screenshot from a Chrome page through Chrome DevTools Protocol.",
	parameters: Type.Object({
		pageId: Type.Optional(Type.String({ description: "Optional page id. Defaults to selected or first page." })),
		fullPage: Type.Optional(Type.Boolean({ description: "Capture the full document, not just the viewport." })),
		savePath: Type.Optional(
			Type.String({
				description:
					"Screenshot is always saved as a PNG file. Optional output path; omitted defaults to a unique temp file. Relative paths resolve from the current working directory. A single leading @ is stripped to match Pi file-mention paths. Existing regular files are replaced.",
			}),
		),
	}),
	renderCall: renderToolCall("screenshot"),
	renderResult: renderScreenshotResult,
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		return withStatus(ctx, "screenshot", async () => {
			const page = await resolvePage(params.pageId, {
				sessionOwner: ctx.sessionManager,
				signal,
			});
			const result = await withCdp(page, async (client) => {
				throwIfAborted(signal);
				await client.send("Page.enable");

				if (!params.fullPage) {
					return client.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
				}

				const metrics = await client.send<{
					contentSize: { x: number; y: number; width: number; height: number };
				}>("Page.getLayoutMetrics");

				throwIfAborted(signal);
				return client.send<{ data: string }>("Page.captureScreenshot", {
					captureBeyondViewport: true,
					format: "png",
					clip: {
						x: metrics.contentSize.x,
						y: metrics.contentSize.y,
						width: metrics.contentSize.width,
						height: metrics.contentSize.height,
						scale: 1,
					},
				});
			});

			setActivePageId(ctx.sessionManager, page.id);
			const savedScreenshot = await saveScreenshot(result.data, params.savePath, ctx.cwd, signal);
			return {
				content: [
					{
						type: "text",
						text: formatScreenshotText(page, savedScreenshot),
					},
					{ type: "image", data: result.data, mimeType: "image/png" },
				],
				details: {
					page: formatPage(page),
					bytes: savedScreenshot.bytes,
					savedPath: savedScreenshot.savedPath,
					isDefaultPath: savedScreenshot.isDefaultPath,
				},
			};
		});
	},
});

export const networkTool = defineTool({
	name: "chrome_devtools_network",
	label: "Chrome DevTools: Network Capture",
	description:
		"Capture HTTP/HTTPS and WebSocket traffic from a Chrome page through the CDP Network domain. Actions: start (begin capturing), list (view captured requests), get (fetch one request with response body), status (capture state), stop (end capture). Requests, headers (including cookies), request/response bodies, and WebSocket frames are recorded; navigation does not stop a running capture.",
	parameters: Type.Object({
		action: StringEnum(["start", "list", "get", "status", "stop"] as const, {
			description: "Capture operation to perform.",
		}),
		pageId: Type.Optional(
			Type.String({
				description: "Optional page id. Defaults to selected or first page. Only used by start.",
			}),
		),
		urlPattern: Type.Optional(
			Type.String({
				description: "Optional substring filter for list, matched case-insensitively against URLs.",
			}),
		),
		limit: Type.Optional(
			Type.Integer({
				description: "Maximum requests to return in list. Defaults to 50.",
				minimum: 1,
				maximum: 500,
			}),
		),
		requestId: Type.Optional(Type.String({ description: "Captured request id, required by the get action." })),
	}),
	renderCall: renderToolCall("network capture"),
	renderResult: renderTextResult,
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		return withStatus(ctx, "network capture", async () => {
			switch (params.action) {
				case "start": {
					const summary = await startNetworkCapture(params.pageId, ctx.sessionManager, signal);
					return textResult(
						[
							`Network capture ${summary.captureId} started on page ${summary.pageId}.`,
							`Page: ${summary.pageUrl}`,
							'Interact with the page or run chrome_devtools_navigate; then use action "list" to view captured traffic.',
						].join("\n"),
						summary,
					);
				}
				case "list": {
					const requests = listCapturedRequests(ctx.sessionManager, {
						...(params.urlPattern ? { urlPattern: params.urlPattern } : {}),
						...(params.limit ? { limit: params.limit } : {}),
					});
					const summary = activeNetworkCapture(ctx.sessionManager);
					const lines = requests.map((request) => {
						const status = request.response
							? `${request.response.status}`
							: request.failed
								? `FAIL(${request.failed.errorText})`
								: "pending";
						const wsTag = request.websocketFrames ? ` [ws x${request.websocketFrames.length}]` : "";
						return `${request.requestId} ${request.method} ${status} ${request.resourceType} ${request.url}${wsTag}`;
					});
					return textResult(
						[
							summary
								? `Capture ${summary.captureId}: ${summary.requestCount} requests recorded${summary.stopped ? ` (stopped: ${summary.stoppedReason})` : ""}.`
								: 'No capture found for this session; run action "start" first.',
							...(lines.length > 0
								? lines
								: ["No requests matched. Navigate or interact with the page, then list again."]),
						].join("\n"),
						{ requests: requests.map(summarizeRequest), count: requests.length },
					);
				}
				case "get": {
					if (!params.requestId) {
						throw new Error("The get action requires the requestId parameter.");
					}
					const request = await getCapturedRequestDetail(ctx.sessionManager, params.requestId, {
						signal,
					});
					return textResult(formatCapturedRequest(request), request);
				}
				case "status": {
					const summary = activeNetworkCapture(ctx.sessionManager);
					if (!summary) {
						return textResult("No network capture exists for this session.", { running: false });
					}
					return textResult(
						[
							`Capture: ${summary.captureId}`,
							`Page: ${summary.pageId} ${summary.pageUrl}`,
							`Requests recorded: ${summary.requestCount}`,
							summary.stopped ? `Stopped: ${summary.stoppedReason ?? "unknown"}` : "Running",
						].join("\n"),
						{ ...summary, running: !summary.stopped },
					);
				}
				case "stop": {
					const summary = await stopNetworkCapture(ctx.sessionManager);
					return textResult(
						`Network capture ${summary.captureId} stopped. ${summary.requestCount} requests recorded. Use action "list" or "get" to inspect them.`,
						summary,
					);
				}
			}
		});
	},
});

function summarizeRequest(request: CapturedRequest) {
	return {
		requestId: request.requestId,
		method: request.method,
		url: request.url,
		status: request.response?.status,
		resourceType: request.resourceType,
		failed: request.failed?.errorText,
		websocketFrameCount: request.websocketFrames?.length,
	};
}

function formatCapturedRequest(request: CapturedRequest): string {
	const lines = [
		`${request.method} ${request.url}`,
		`Request id: ${request.requestId}`,
		`Resource type: ${request.resourceType}`,
	];
	if (request.redirectedFrom) lines.push(`Redirected from: ${request.redirectedFrom}`);
	lines.push("Request headers:");
	for (const [key, value] of Object.entries({
		...request.requestHeaders,
		...request.requestExtraHeaders,
	})) {
		lines.push(`  ${key}: ${value}`);
	}
	if (request.requestBody) {
		const decoded = Buffer.from(request.requestBody.data, "base64").toString("utf8");
		lines.push(`Request body${request.requestBody.truncated ? " (truncated)" : ""}: ${decoded.slice(0, 4000)}`);
	}
	if (request.response) {
		lines.push(
			"",
			`Response: ${request.response.status} ${request.response.statusText}`,
			`MIME type: ${request.response.mimeType}`,
			...(request.response.remoteIPAddress ? [`Remote IP: ${request.response.remoteIPAddress}`] : []),
		);
		lines.push("Response headers:");
		for (const [key, value] of Object.entries({
			...request.response.headers,
			...request.response.extraHeaders,
		})) {
			lines.push(`  ${key}: ${value}`);
		}
		if (request.response.body) {
			const decoded = Buffer.from(request.response.body.data, "base64").toString("utf8");
			lines.push(
				`Response body${request.response.body.truncated ? " (truncated)" : ""} (first 4000 chars):`,
				decoded.slice(0, 4000),
			);
		} else if (request.response.bodyError) {
			lines.push(`Response body unavailable: ${request.response.bodyError}`);
		} else {
			lines.push("Response body: not fetched yet (run get again while capture is active)");
		}
	}
	if (request.failed) {
		lines.push("", `Failed: ${request.failed.errorText}${request.failed.canceled ? " (canceled)" : ""}`);
	}
	if (request.websocketFrames && request.websocketFrames.length > 0) {
		lines.push("", `WebSocket frames (${request.websocketFrames.length}):`);
		for (const frame of request.websocketFrames.slice(-20)) {
			lines.push(`  [${frame.direction}] ${frame.payload.slice(0, 500)}`);
		}
	}
	return lines.join("\n");
}
