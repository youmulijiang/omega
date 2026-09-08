import { CdpClient, resolvePage, setActivePageId } from "./cdp-client.ts";
import type { DevToolsPage } from "./runtime.ts";

/**
 * CDP Network 域流量捕获。
 *
 * 每次 start 建立一个长连 CDP 会话（独立于工具调用的一次性连接），
 * 持续消费 Network 事件直到 stop 或会话/浏览器关闭。
 */

export interface CapturedRequest {
	requestId: string;
	url: string;
	method: string;
	resourceType: string;
	/** 请求发出时刻（epoch ms）。 */
	timestamp: number;
	/** 请求头（Network.requestWillBeSent，不含部分运行时注入头）。 */
	requestHeaders: Record<string, string>;
	/** POST 等请求体（base64），超限截断。 */
	requestBody?: { data: string; truncated: boolean };
	/** 请求 Cookie 等额外头（requestWillBeSentExtraInfo）。 */
	requestExtraHeaders?: Record<string, string>;
	response?: {
		status: number;
		statusText: string;
		headers: Record<string, string>;
		/** 响应 Cookie/Set-Cookie 等额外头。 */
		extraHeaders?: Record<string, string>;
		mimeType: string;
		remoteIPAddress?: string;
		/** 响应体（base64）；未取回或不可用时缺省。 */
		body?: { data: string; truncated: boolean };
		bodyError?: string;
	};
	failed?: { errorText: string; canceled: boolean };
	/** 同一 requestId 的重定向链（3xx 时 Chrome 会复用 requestId）。 */
	redirectedFrom?: string;
	websocketFrames?: Array<{ direction: "sent" | "received"; timestamp: number; payload: string; opcode: number }>;
}

export interface NetworkCaptureSummary {
	captureId: string;
	pageId: string;
	pageUrl: string;
	startedAt: number;
	requestCount: number;
	stopped: boolean;
	stoppedReason?: string;
}

interface NetworkCaptureState {
	captureId: string;
	client: CdpClient;
	page: DevToolsPage;
	owner: object;
	startedAt: number;
	stopped: boolean;
	stoppedReason?: string;
	requests: Map<string, CapturedRequest>;
	wsFrames: Map<string, CapturedRequest["websocketFrames"]>;
	disposeListener: () => void;
	disposeClosed: () => void;
}

export const MAX_CAPTURED_REQUESTS = 500;
export const MAX_BODY_BYTES = 1024 * 1024;
const MAX_WS_FRAMES_PER_SOCKET = 200;

const capturesByOwner = new WeakMap<object, NetworkCaptureState>();

export function activeNetworkCapture(owner: object): NetworkCaptureSummary | undefined {
	const state = capturesByOwner.get(owner);
	if (!state) return undefined;
	return summarize(state);
}

function summarize(state: NetworkCaptureState): NetworkCaptureSummary {
	return {
		captureId: state.captureId,
		pageId: state.page.id,
		pageUrl: state.page.url,
		startedAt: state.startedAt,
		requestCount: state.requests.size,
		stopped: state.stopped,
		...(state.stoppedReason ? { stoppedReason: state.stoppedReason } : {}),
	};
}

export async function startNetworkCapture(
	pageId: string | undefined,
	owner: object,
	signal: AbortSignal | undefined,
): Promise<NetworkCaptureSummary> {
	const existing = capturesByOwner.get(owner);
	if (existing && !existing.stopped) {
		throw new Error(
			`Network capture ${existing.captureId} is already running on page ${existing.page.id}. Call the stop action first.`,
		);
	}

	const page = await resolvePage(pageId, { sessionOwner: owner, signal });
	if (!page.webSocketDebuggerUrl) {
		throw new Error(`Page has no webSocketDebuggerUrl: ${page.id}`);
	}

	const client = await CdpClient.connect(page.webSocketDebuggerUrl, { signal });
	const captureId = `net-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	const state: NetworkCaptureState = {
		captureId,
		client,
		page,
		owner,
		startedAt: Date.now(),
		stopped: false,
		requests: new Map<string, CapturedRequest>(),
		wsFrames: new Map<string, CapturedRequest["websocketFrames"]>(),
		disposeListener: () => undefined,
		disposeClosed: () => undefined,
	};

	const eventSubscription = client.onEvent("*", (method, params) => {
		handleNetworkEvent(state, method, params);
	});
	state.disposeListener = () => eventSubscription.dispose();
	const closedSubscription = client.onClosed((reason) => {
		state.stopped = true;
		state.stoppedReason = reason instanceof Error ? reason.message : "Chrome DevTools WebSocket closed";
	});
	state.disposeClosed = () => closedSubscription.dispose();

	await client.send("Network.enable", {
		maxTotalBufferSize: 8 * MAX_BODY_BYTES,
		maxResourceBufferSize: 2 * MAX_BODY_BYTES,
	});

	capturesByOwner.set(owner, state);
	setActivePageId(owner, page.id);
	return summarize(state);
}

export async function stopNetworkCapture(owner: object): Promise<NetworkCaptureSummary> {
	const state = capturesByOwner.get(owner);
	if (!state) throw new Error("No network capture is running for this session.");
	try {
		await state.client.send("Network.disable", {}, { timeoutMs: 2_000 });
	} catch {
		// 连接可能已断开；尽力而为。
	} finally {
		state.stopped = true;
		state.stoppedReason ??= "stopped by user";
		state.disposeListener();
		state.disposeClosed();
		state.client.close();
	}
	return summarize(state);
}

/** 会话关闭时的静默清理：无捕获或已停止时直接返回，不抛错。 */
export async function stopNetworkCaptureQuiet(owner: object): Promise<void> {
	const state = capturesByOwner.get(owner);
	if (!state || state.stopped) return;
	await stopNetworkCapture(owner).catch(() => undefined);
}

export function listCapturedRequests(
	owner: object,
	filter: { urlPattern?: string; limit?: number } = {},
): CapturedRequest[] {
	const state = capturesByOwner.get(owner);
	if (!state) throw new Error("No network capture exists for this session.");
	const pattern = filter.urlPattern ? new RegExp(escapeRegExp(filter.urlPattern), "i") : undefined;
	const all = [...state.requests.values()]
		.filter((request) => !pattern || pattern.test(request.url))
		.sort((left, right) => left.timestamp - right.timestamp);
	const limit = filter.limit ?? 50;
	return all.slice(Math.max(0, all.length - limit));
}

export async function getCapturedRequestDetail(
	owner: object,
	requestId: string,
	options: { signal?: AbortSignal } = {},
): Promise<CapturedRequest> {
	const state = capturesByOwner.get(owner);
	if (!state) throw new Error("No network capture exists for this session.");
	const request = state.requests.get(requestId);
	if (!request) {
		throw new Error(`Captured request not found: ${requestId}. Use the list action to see captured request ids.`);
	}
	if (request.response && !request.response.body && !request.response.bodyError && !state.stopped) {
		try {
			const result = await state.client.send<{ body: string; base64Encoded: boolean }>(
				"Network.getResponseBody",
				{ requestId },
				{ timeoutMs: 10_000, signal: options.signal },
			);
			const bytes = Buffer.from(result.body, result.base64Encoded ? "base64" : "utf8");
			request.response.body = {
				data: bytes.subarray(0, MAX_BODY_BYTES).toString("base64"),
				truncated: bytes.byteLength > MAX_BODY_BYTES,
			};
		} catch (error) {
			request.response.bodyError = error instanceof Error ? error.message : "Failed to fetch response body";
		}
	}
	return request;
}

function handleNetworkEvent(state: NetworkCaptureState, method: string, params: unknown): void {
	if (!params || typeof params !== "object") return;
	const event = params as Record<string, unknown>;
	switch (method) {
		case "Network.requestWillBeSent": {
			const requestId = stringField(event.requestId);
			if (!requestId) return;
			const request = event.request as Record<string, unknown> | undefined;
			if (!request) return;
			const headers = normalizeHeaders(request.headers);
			const init = event.initiator as Record<string, unknown> | undefined;
			void init;
			const captured: CapturedRequest = {
				requestId,
				url: stringField(request.url) ?? "",
				method: stringField(request.method) ?? "GET",
				resourceType: stringField(event.type) ?? "Other",
				timestamp: typeof event.timestamp === "number" ? event.timestamp * 1000 : Date.now(),
				requestHeaders: headers,
				redirectedFrom: stringField(event.redirectResponse ? undefined : event.redirectFrom),
			};
			const postData = stringField(request.postData);
			if (postData !== undefined) {
				const bytes = Buffer.from(postData, "utf8");
				captured.requestBody = {
					data: bytes.subarray(0, MAX_BODY_BYTES).toString("base64"),
					truncated: bytes.byteLength > MAX_BODY_BYTES,
				};
			}
			// 3xx 重定向复用 requestId：保留旧记录的关键字段作为 redirectedFrom 链。
			const previous = state.requests.get(requestId);
			if (previous && event.redirectResponse) {
				captured.redirectedFrom = previous.url;
				captured.requestExtraHeaders = previous.requestExtraHeaders;
			}
			trimToLimit(state, captured);
			return;
		}
		case "Network.requestWillBeSentExtraInfo": {
			const requestId = stringField(event.requestId);
			if (!requestId) return;
			const captured = state.requests.get(requestId);
			if (!captured) return;
			captured.requestExtraHeaders = normalizeHeaders(event.headers);
			return;
		}
		case "Network.responseReceived": {
			const requestId = stringField(event.requestId);
			if (!requestId) return;
			const captured = state.requests.get(requestId);
			if (!captured) return;
			const response = event.response as Record<string, unknown> | undefined;
			if (!response) return;
			captured.response = {
				status: typeof response.status === "number" ? response.status : 0,
				statusText: stringField(response.statusText) ?? "",
				headers: normalizeHeaders(response.headers),
				mimeType: stringField(response.mimeType) ?? "",
				...(stringField(response.remoteIPAddress)
					? { remoteIPAddress: stringField(response.remoteIPAddress) }
					: {}),
			};
			return;
		}
		case "Network.responseReceivedExtraInfo": {
			const requestId = stringField(event.requestId);
			if (!requestId) return;
			const captured = state.requests.get(requestId);
			if (!captured?.response) return;
			captured.response.extraHeaders = normalizeHeaders(event.headers);
			return;
		}
		case "Network.loadingFailed": {
			const requestId = stringField(event.requestId);
			if (!requestId) return;
			const captured = state.requests.get(requestId);
			if (!captured) return;
			captured.failed = {
				errorText: stringField(event.errorText) ?? "unknown",
				canceled: event.canceled === true,
			};
			return;
		}
		case "Network.loadingFinished": {
			const requestId = stringField(event.requestId);
			if (!requestId) return;
			prefetchResponseBody(state, requestId);
			return;
		}
		case "Network.webSocketCreated": {
			const requestId = stringField(event.requestId);
			if (!requestId) return;
			const url = stringField(event.url) ?? "";
			const captured: CapturedRequest = {
				requestId,
				url,
				method: "GET",
				resourceType: "WebSocket",
				timestamp: typeof event.timestamp === "number" ? event.timestamp * 1000 : Date.now(),
				requestHeaders: {},
				websocketFrames: [],
			};
			trimToLimit(state, captured);
			return;
		}
		case "Network.webSocketFrameSent":
		case "Network.webSocketFrameReceived": {
			const requestId = stringField(event.requestId);
			if (!requestId) return;
			const captured = state.requests.get(requestId);
			if (!captured?.websocketFrames) return;
			const response = event.response as Record<string, unknown> | undefined;
			const payload = stringField(response?.payload) ?? "";
			const opcode = typeof response?.opcode === "number" ? response.opcode : 1;
			if (opcode === 2) {
				// 二进制帧：base64 载荷可能极大，仅记录长度。
				captured.websocketFrames.push({
					direction: method === "Network.webSocketFrameSent" ? "sent" : "received",
					timestamp: typeof event.timestamp === "number" ? event.timestamp * 1000 : Date.now(),
					payload: `[binary ${Buffer.byteLength(payload, "utf8")} bytes]`,
					opcode,
				});
			} else {
				const bytes = Buffer.from(payload, "utf8");
				captured.websocketFrames.push({
					direction: method === "Network.webSocketFrameSent" ? "sent" : "received",
					timestamp: typeof event.timestamp === "number" ? event.timestamp * 1000 : Date.now(),
					payload: bytes.subarray(0, 4096).toString("utf8"),
					opcode,
				});
			}
			if (captured.websocketFrames.length > MAX_WS_FRAMES_PER_SOCKET) {
				captured.websocketFrames.splice(0, captured.websocketFrames.length - MAX_WS_FRAMES_PER_SOCKET);
			}
			return;
		}
		default:
			return;
	}
}

function trimToLimit(state: NetworkCaptureState, captured: CapturedRequest): void {
	state.requests.set(captured.requestId, captured);
	if (state.requests.size > MAX_CAPTURED_REQUESTS) {
		const oldest = [...state.requests.entries()]
			.sort((left, right) => left[1].timestamp - right[1].timestamp)
			.slice(0, state.requests.size - MAX_CAPTURED_REQUESTS);
		for (const [id] of oldest) state.requests.delete(id);
	}
}

/**
 * loadingFinished 后立即预取响应体：Chrome 只在资源仍在缓存窗口内时能返回 body，
 * 页面导航后旧资源的 body 会不可取。预取失败仅记录 bodyError，不中断捕获。
 */
function prefetchResponseBody(state: NetworkCaptureState, requestId: string): void {
	const captured = state.requests.get(requestId);
	if (!captured?.response || captured.response.body || captured.response.bodyError) return;
	// 已捕获的请求可能在预取完成前被上限逐出；届时结果直接丢弃。
	state.client
		.send<{ body: string; base64Encoded: boolean }>("Network.getResponseBody", { requestId }, { timeoutMs: 10_000 })
		.then(
			(result) => {
				const target = state.requests.get(requestId);
				if (!target?.response || target.response.body || target.response.bodyError) return;
				const bytes = Buffer.from(result.body, result.base64Encoded ? "base64" : "utf8");
				target.response.body = {
					data: bytes.subarray(0, MAX_BODY_BYTES).toString("base64"),
					truncated: bytes.byteLength > MAX_BODY_BYTES,
				};
			},
			(error) => {
				const target = state.requests.get(requestId);
				if (!target?.response || target.response.body || target.response.bodyError) return;
				target.response.bodyError = error instanceof Error ? error.message : "Failed to fetch response body";
			},
		);
}

function normalizeHeaders(value: unknown): Record<string, string> {
	const headers: Record<string, string> = {};
	if (!value || typeof value !== "object") return headers;
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		if (typeof entry === "string") headers[key] = entry;
		else if (Array.isArray(entry)) headers[key] = entry.join("; ");
	}
	return headers;
}

function stringField(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function escapeRegExp(value: string): string {
	return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
