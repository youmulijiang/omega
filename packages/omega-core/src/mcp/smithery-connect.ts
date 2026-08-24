import type { McpHttpServer } from "./native-types.ts";
import { withTimeoutSignal } from "./timeout.ts";

const DEFAULT_SMITHERY_API_URL = "https://api.smithery.ai";
const SMITHERY_TIMEOUT_MS = 10_000;

export interface SmitheryConnectionStatus {
	state: string;
	authorizationUrl?: string;
	missing?: string[];
	message?: string;
}

export interface SmitheryConnection {
	connectionId: string;
	mcpUrl: string;
	name: string;
	status?: SmitheryConnectionStatus;
	createdAt?: string;
}

export interface SmitheryConnectOptions {
	baseUrl?: string;
	fetch?: typeof fetch;
	signal?: AbortSignal;
}

export class SmitheryConnectError extends Error {
	readonly status: number;

	constructor(message: string, status: number) {
		super(message);
		this.name = "SmitheryConnectError";
		this.status = status;
	}
}

function baseUrl(options: SmitheryConnectOptions): string {
	return (options.baseUrl ?? process.env.SMITHERY_API_URL ?? DEFAULT_SMITHERY_API_URL).replace(/\/+$/, "");
}

function headers(apiKey: string): Headers {
	const result = new Headers({ Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" });
	return result;
}

async function requestJson<T>(
	apiKey: string,
	path: string,
	options: SmitheryConnectOptions,
	init: RequestInit = {},
): Promise<T> {
	const response = await (options.fetch ?? fetch)(`${baseUrl(options)}${path}`, {
		...init,
		headers: headers(apiKey),
		signal: withTimeoutSignal(SMITHERY_TIMEOUT_MS, options.signal),
	});
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new SmitheryConnectError(
			`Smithery request failed: ${response.status} ${response.statusText}${body ? `: ${body}` : ""}`,
			response.status,
		);
	}
	return (await response.json()) as T;
}

export async function resolveSmitheryNamespace(apiKey: string, options: SmitheryConnectOptions = {}): Promise<string> {
	const listed = await requestJson<{ namespaces?: Array<{ name: string }> }>(apiKey, "/namespaces", options);
	const existing = listed.namespaces?.[0]?.name;
	if (existing) return existing;
	const created = await requestJson<{ name: string }>(apiKey, "/namespaces", options, { method: "POST" });
	if (!created.name) throw new SmitheryConnectError("Smithery returned an empty namespace", 0);
	return created.name;
}

export async function findSmitheryConnection(
	apiKey: string,
	namespace: string,
	mcpUrl: string,
	options: SmitheryConnectOptions = {},
): Promise<SmitheryConnection | undefined> {
	const path = `/connect/${encodeURIComponent(namespace)}?mcpUrl=${encodeURIComponent(mcpUrl)}`;
	const result = await requestJson<{ connections?: SmitheryConnection[] }>(apiKey, path, options);
	return result.connections?.[0];
}

export function createSmitheryConnection(
	apiKey: string,
	namespace: string,
	mcpUrl: string,
	name: string,
	options: SmitheryConnectOptions = {},
): Promise<SmitheryConnection> {
	return requestJson<SmitheryConnection>(apiKey, `/connect/${encodeURIComponent(namespace)}`, options, {
		method: "POST",
		body: JSON.stringify({ mcpUrl, name }),
	});
}

export function smitheryProxyConfig(namespace: string, connectionId: string): McpHttpServer {
	return {
		type: "streamable-http",
		url: `${(process.env.SMITHERY_API_URL ?? DEFAULT_SMITHERY_API_URL).replace(/\/+$/, "")}/connect/${encodeURIComponent(namespace)}/${encodeURIComponent(connectionId)}/mcp`,
		headers: { Authorization: "Bearer $" + "{SMITHERY_API_KEY}" },
	};
}
