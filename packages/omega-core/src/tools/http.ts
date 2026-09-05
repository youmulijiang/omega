import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

export interface HttpRequestInput {
	url: string;
	method?: string;
	headers?: Record<string, string | string[]>;
	body?: string;
	bodyEncoding?: "utf8" | "base64";
	responseEncoding?: "utf8" | "base64";
	timeoutMs?: number;
	maxResponseBytes?: number;
}

export interface HttpReplayInput extends HttpRequestInput {
	rawRequest: string;
}

export interface HttpResponse {
	url: string;
	method: string;
	status: number;
	statusText: string;
	headers: Array<{ name: string; value: string }>;
	body: string;
	bodyEncoding: "utf8" | "base64";
	/** Bytes retained, before encoding. No content decompression is performed. */
	bodyBytes: number;
	truncated: boolean;
	durationMs: number;
}

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** One HTTP/1.1 request, without redirects, retries, or a shared cookie jar. */
export async function requestHttp(input: HttpRequestInput, signal?: AbortSignal): Promise<HttpResponse> {
	signal?.throwIfAborted();
	const url = new URL(input.url);
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only HTTP and HTTPS URLs are supported");
	if (url.username || url.password) throw new Error("Use an Authorization header instead of URL credentials");
	url.hash = "";
	const method = input.method ?? "GET";
	if (!TOKEN.test(method) || /^CONNECT$/i.test(method)) throw new Error("Unsupported HTTP method");
	const timeoutMs = input.timeoutMs ?? 30_000;
	const maxResponseBytes = input.maxResponseBytes ?? 262_144;
	if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000)
		throw new Error("timeoutMs must be an integer between 1 and 300000");
	if (!Number.isInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 10_485_760)
		throw new Error("maxResponseBytes must be an integer between 1 and 10485760");
	if (input.bodyEncoding !== undefined && input.bodyEncoding !== "utf8" && input.bodyEncoding !== "base64")
		throw new Error("Invalid bodyEncoding");
	const bodyEncoding = input.responseEncoding ?? "utf8";
	if (bodyEncoding !== "utf8" && bodyEncoding !== "base64") throw new Error("Invalid responseEncoding");
	if (input.body !== undefined && input.body.length > 13_981_016) throw new Error("Request body exceeds 10 MiB");
	const body = input.body === undefined ? undefined : Buffer.from(input.body, input.bodyEncoding ?? "utf8");
	if (body && body.length > 10_485_760) throw new Error("Request body exceeds 10 MiB");
	if (input.bodyEncoding === "base64" && body !== undefined && body.toString("base64") !== input.body)
		throw new Error("body must be canonical Base64");
	const headers: Record<string, string | string[]> = Object.create(null);
	for (const [name, value] of Object.entries(input.headers ?? {})) {
		const key = name.toLowerCase();
		if (!TOKEN.test(name) || (Array.isArray(value) ? value : [value]).some((item) => /[\r\n]/.test(item)))
			throw new Error(`Invalid HTTP header: ${name}`);
		if (key === "transfer-encoding") throw new Error("Transfer-Encoding is unsupported; provide a decoded body");
		if (key === "content-length") continue;
		headers[key] = value;
	}
	headers.host ??= url.host;
	headers["accept-encoding"] ??= "identity";
	if (body !== undefined) headers["content-length"] = String(body.length);
	const started = performance.now();
	return new Promise<HttpResponse>((resolve, reject) => {
		const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
			url,
			{
				method,
				headers,
				signal,
				agent: false,
			},
			(response) => {
				const chunks: Buffer[] = [];
				let size = 0;
				const finish = (truncated: boolean): void => {
					clearTimeout(timer);
					const responseHeaders: HttpResponse["headers"] = [];
					for (let i = 0; i < response.rawHeaders.length; i += 2)
						responseHeaders.push({ name: response.rawHeaders[i], value: response.rawHeaders[i + 1] });
					resolve({
						url: url.href,
						method,
						status: response.statusCode ?? 0,
						statusText: response.statusMessage ?? "",
						headers: responseHeaders,
						body: Buffer.concat(chunks).toString(bodyEncoding),
						bodyEncoding,
						bodyBytes: size,
						truncated,
						durationMs: Math.round(performance.now() - started),
					});
				};
				response.on("data", (chunk: Buffer) => {
					const remaining = maxResponseBytes - size;
					const retained = chunk.subarray(0, remaining);
					chunks.push(retained);
					size += retained.length;
					if (chunk.length > remaining) {
						finish(true);
						response.destroy();
					}
				});
				response.on("end", () => finish(false));
				response.on("error", (error: Error) => {
					clearTimeout(timer);
					reject(error);
				});
			},
		);
		const timer = setTimeout(
			() => request.destroy(new Error(`HTTP request timed out after ${timeoutMs}ms`)),
			timeoutMs,
		);
		request.on("error", (error: Error) => {
			clearTimeout(timer);
			reject(error);
		});
		request.on("upgrade", (_response, socket) => {
			clearTimeout(timer);
			socket.destroy();
			reject(new Error("HTTP protocol upgrades are unsupported"));
		});
		request.end(body);
	});
}

/** Parse a captured HTTP/1.x message. The explicit URL replaces its request target. */
export function parseHttpReplay(input: HttpReplayInput): HttpRequestInput {
	const separator = /\r?\n\r?\n/.exec(input.rawRequest);
	if (!separator || separator.index === undefined) throw new Error("rawRequest requires a blank line after headers");
	const lines = input.rawRequest.slice(0, separator.index).split(/\r?\n/);
	const requestLine = /^([^\s]+) ([^\s]+) HTTP\/1\.[01]$/.exec(lines.shift() ?? "");
	if (!requestLine || !TOKEN.test(requestLine[1])) throw new Error("Invalid HTTP/1.x request line");
	const headers: Record<string, string | string[]> = Object.create(null);
	for (const line of lines) {
		const colon = line.indexOf(":");
		const name = line.slice(0, colon);
		if (colon < 1 || !TOKEN.test(name)) throw new Error("Invalid or folded HTTP header");
		const key = name.toLowerCase();
		const value = line.slice(colon + 1).trim();
		if (key === "transfer-encoding") throw new Error("Chunked raw requests are unsupported; provide a decoded body");
		// Routing and framing are regenerated for the explicit destination and body.
		if (key === "host" || key === "content-length") continue;
		const previous = headers[key];
		headers[key] = previous === undefined ? value : [...(Array.isArray(previous) ? previous : [previous]), value];
	}
	for (const [name, value] of Object.entries(input.headers ?? {})) headers[name.toLowerCase()] = value;
	return {
		...input,
		method: input.method ?? requestLine[1],
		headers,
		body: input.body ?? input.rawRequest.slice(separator.index + separator[0].length),
		bodyEncoding: input.body === undefined ? "utf8" : input.bodyEncoding,
	};
}

export async function replayHttp(input: HttpReplayInput, signal?: AbortSignal): Promise<HttpResponse> {
	return requestHttp(parseHttpReplay(input), signal);
}
