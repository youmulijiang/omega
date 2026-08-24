import { isAbsolute, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { interpolateEnvVars, loadMcpConfig } from "./native-config.ts";
import type { McpConnection, McpReconnectOptions, McpServerConfig, McpServerState } from "./native-types.ts";
import { mcpRequestOptions, resolveMcpTimeoutMs } from "./timeout.ts";
import { OmegaMcpToolCache } from "./tool-cache.ts";

const DEFAULT_RECONNECT: Required<McpReconnectOptions> = {
	enabled: true,
	maxRetries: 5,
	initialDelay: 500,
	maxDelay: 30_000,
	factor: 2,
};
const RECONNECT_BURST_WINDOW_MS = 30_000;
const RECONNECT_BURST_LIMIT = 5;

export interface OmegaMcpManagerOptions {
	toolCache?: OmegaMcpToolCache;
}

function isEnabled(config: McpServerConfig): boolean {
	return config.disabled !== true && config.enabled !== false;
}

function environment(extra: Record<string, string> | undefined): Record<string, string> {
	const inherited = Object.fromEntries(
		Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
	);
	return {
		...inherited,
		...Object.fromEntries(Object.entries(extra ?? {}).map(([key, value]) => [key, interpolateEnvVars(value)])),
	};
}

function interpolateRecord(values: Record<string, string> | undefined): Record<string, string> | undefined {
	if (!values) return undefined;
	return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, interpolateEnvVars(value)]));
}

function isCallToolResult(value: unknown): value is CallToolResult {
	return typeof value === "object" && value !== null && "content" in value && Array.isArray(value.content);
}

function reconnectOptions(config: McpServerConfig): Required<McpReconnectOptions> {
	return { ...DEFAULT_RECONNECT, ...config.reconnect };
}

function reconnectDelay(options: Required<McpReconnectOptions>, attempt: number): number {
	return Math.min(options.maxDelay, options.initialDelay * options.factor ** Math.max(0, attempt - 1));
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class OmegaMcpManager {
	private readonly cwd: string;
	private readonly toolCache: OmegaMcpToolCache;
	private readonly connections = new Map<string, McpConnection>();
	private readonly states = new Map<string, McpServerState>();
	private readonly pendingConnections = new Map<string, Promise<McpServerState>>();
	private readonly reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly reconnectHistory = new Map<string, number[]>();
	private epoch = 0;
	private closed = false;

	constructor(cwd: string, options: OmegaMcpManagerOptions = {}) {
		this.cwd = cwd;
		this.toolCache = options.toolCache ?? new OmegaMcpToolCache();
	}

	async reload(connect = true): Promise<void> {
		this.closed = false;
		this.epoch += 1;
		this.cancelReconnects();
		await this.closeConnections();
		this.states.clear();
		for (const [name, config] of Object.entries(loadMcpConfig(this.cwd).mcpServers)) {
			const cachedTools = await this.toolCache.get(name, config).catch(() => undefined);
			this.states.set(name, {
				name,
				config,
				status: isEnabled(config) ? "disconnected" : "disabled",
				tools: cachedTools ?? [],
				...(cachedTools ? { toolSource: "cache" as const } : {}),
				reconnectAttempts: 0,
			});
		}
		if (connect) await this.connectAll();
	}

	getStates(): McpServerState[] {
		return [...this.states.values()].sort((left, right) => left.name.localeCompare(right.name));
	}

	getState(name: string): McpServerState | undefined {
		return this.states.get(name);
	}

	async connectAll(): Promise<void> {
		await Promise.allSettled(
			this.getStates()
				.filter((state) => state.status !== "disabled")
				.map((state) => this.connect(state.name)),
		);
	}

	connect(name: string): Promise<McpServerState> {
		const pending = this.pendingConnections.get(name);
		if (pending) return pending;
		const operation = this.connectOnce(name).finally(() => {
			if (this.pendingConnections.get(name) === operation) this.pendingConnections.delete(name);
		});
		this.pendingConnections.set(name, operation);
		return operation;
	}

	async reconnect(name: string): Promise<McpServerState> {
		this.cancelReconnect(name);
		this.reconnectHistory.delete(name);
		const state = this.states.get(name);
		if (!state) throw new Error(`Unknown MCP server: ${name}`);
		state.reconnectAttempts = 0;
		await this.closeConnection(name);
		state.status = isEnabled(state.config) ? "disconnected" : "disabled";
		state.error = undefined;
		return this.connect(name);
	}

	listTools(server?: string): Array<{ server: string; tool: Tool }> {
		return this.getStates()
			.filter((state) => !server || state.name === server)
			.flatMap((state) => state.tools.map((tool) => ({ server: state.name, tool })))
			.sort((left, right) =>
				left.server === right.server
					? left.tool.name.localeCompare(right.tool.name)
					: left.server.localeCompare(right.server),
			);
	}

	async callTool(
		server: string,
		tool: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<CallToolResult> {
		let connection = this.connections.get(server);
		if (!connection) {
			await this.connect(server);
			connection = this.connections.get(server);
		}
		if (!connection) {
			const state = this.states.get(server);
			throw new Error(state?.error ?? `MCP server "${server}" is not connected`);
		}
		const timeout = resolveMcpTimeoutMs(this.states.get(server)?.config.timeout);
		try {
			const result = await connection.client.callTool(
				{ name: tool, arguments: args },
				undefined,
				mcpRequestOptions(timeout, signal),
			);
			if (!isCallToolResult(result)) {
				throw new Error(`MCP tool "${server}/${tool}" returned an unsupported task result`);
			}
			return result;
		} catch (error) {
			if (!signal?.aborted && /closed|disconnect|network|socket|ECONN/i.test(formatError(error))) {
				this.handleConnectionLoss(server, connection, error);
			}
			throw error;
		}
	}

	async close(name?: string): Promise<void> {
		if (name) {
			this.cancelReconnect(name);
			await this.closeConnection(name);
			return;
		}
		this.closed = true;
		this.epoch += 1;
		this.cancelReconnects();
		await this.closeConnections();
	}

	private async connectOnce(name: string): Promise<McpServerState> {
		const state = this.states.get(name);
		if (!state) throw new Error(`Unknown MCP server: ${name}`);
		if (state.status === "disabled" || state.status === "connected") return state;
		if (state.config.auth === "oauth" && !("headers" in state.config && state.config.headers?.Authorization)) {
			state.status = "needs-auth";
			state.error = "OAuth is configured but no Authorization header is available";
			return state;
		}

		state.status = "connecting";
		state.error = undefined;
		const connectionEpoch = this.epoch;
		let client: Client | undefined;
		try {
			client = new Client(
				{ name: "omega", version: "0.1.0" },
				{
					capabilities: {},
					listChanged: {
						tools: {
							onChanged: (error, tools) => {
								if (error || !tools || this.connections.get(name)?.client !== client) return;
								void this.publishTools(name, state.config, tools);
							},
						},
					},
				},
			);
			const transport = this.createTransport(state.config);
			const timeout = resolveMcpTimeoutMs(state.config.timeout);
			client.onclose = () => {
				const connection = this.connections.get(name);
				if (!connection || connection.client !== client) return;
				this.handleConnectionLoss(name, connection, new Error("Connection closed"));
			};
			client.onerror = (error) => {
				if (this.connections.get(name)?.client === client) state.error = formatError(error);
			};
			await client.connect(transport, mcpRequestOptions(timeout));
			const listed = await client.listTools(undefined, mcpRequestOptions(timeout));
			if (this.closed || connectionEpoch !== this.epoch) {
				await client.close().catch(() => undefined);
				throw new Error(`MCP server "${name}" connection became stale`);
			}
			this.connections.set(name, { client, transport });
			state.status = "connected";
			state.error = undefined;
			state.reconnectAttempts = 0;
			await this.publishTools(name, state.config, listed.tools);
			return state;
		} catch (error) {
			await client?.close().catch(() => undefined);
			const message = formatError(error);
			state.status = /401|403|unauthorized|oauth/i.test(message) ? "needs-auth" : "error";
			state.error = message;
			if (state.status !== "needs-auth") this.scheduleReconnect(name);
			throw error;
		}
	}

	private createTransport(config: McpServerConfig): StdioClientTransport | StreamableHTTPClientTransport {
		if ("command" in config) {
			return new StdioClientTransport({
				command: interpolateEnvVars(config.command),
				...(config.args ? { args: config.args.map((value) => interpolateEnvVars(value)) } : {}),
				env: environment(config.env),
				cwd: config.cwd
					? isAbsolute(interpolateEnvVars(config.cwd))
						? interpolateEnvVars(config.cwd)
						: resolve(this.cwd, interpolateEnvVars(config.cwd))
					: this.cwd,
				stderr: "pipe",
			});
		}
		const reconnect = reconnectOptions(config);
		return new StreamableHTTPClientTransport(new URL(interpolateEnvVars(config.url)), {
			requestInit: config.headers ? { headers: interpolateRecord(config.headers) } : undefined,
			reconnectionOptions: {
				initialReconnectionDelay: reconnect.initialDelay,
				maxReconnectionDelay: reconnect.maxDelay,
				reconnectionDelayGrowFactor: reconnect.factor,
				maxRetries: reconnect.maxRetries,
			},
		});
	}

	private async publishTools(name: string, config: McpServerConfig, tools: Tool[]): Promise<void> {
		const state = this.states.get(name);
		if (!state) return;
		state.tools = [...tools].sort((left, right) => left.name.localeCompare(right.name));
		state.toolSource = "live";
		await this.toolCache.set(name, config, state.tools).catch(() => undefined);
	}

	private handleConnectionLoss(name: string, connection: McpConnection, error: unknown): void {
		if (this.connections.get(name) !== connection) return;
		this.connections.delete(name);
		const state = this.states.get(name);
		if (!state || this.closed || !isEnabled(state.config)) return;
		state.status = "disconnected";
		state.error = formatError(error);
		this.scheduleReconnect(name);
	}

	private scheduleReconnect(name: string): void {
		const state = this.states.get(name);
		if (!state || this.closed || !isEnabled(state.config) || this.reconnectTimers.has(name)) return;
		const options = reconnectOptions(state.config);
		if (!options.enabled) return;
		const now = Date.now();
		const history = (this.reconnectHistory.get(name) ?? []).filter(
			(timestamp) => now - timestamp < RECONNECT_BURST_WINDOW_MS,
		);
		if (history.length >= RECONNECT_BURST_LIMIT) {
			state.status = "error";
			state.error = "Automatic reconnect paused after repeated failures; use /mcp reconnect";
			this.reconnectHistory.set(name, history);
			return;
		}
		const attempt = (state.reconnectAttempts ?? 0) + 1;
		if (attempt > options.maxRetries) {
			state.status = "error";
			state.error = `Automatic reconnect exhausted after ${options.maxRetries} attempts`;
			return;
		}
		state.reconnectAttempts = attempt;
		history.push(now);
		this.reconnectHistory.set(name, history);
		const timer = setTimeout(
			() => {
				this.reconnectTimers.delete(name);
				void this.connect(name).catch(() => undefined);
			},
			reconnectDelay(options, attempt),
		);
		timer.unref?.();
		this.reconnectTimers.set(name, timer);
	}

	private cancelReconnect(name: string): void {
		const timer = this.reconnectTimers.get(name);
		if (timer) clearTimeout(timer);
		this.reconnectTimers.delete(name);
	}

	private cancelReconnects(): void {
		for (const name of this.reconnectTimers.keys()) this.cancelReconnect(name);
	}

	private async closeConnection(name: string): Promise<void> {
		const connection = this.connections.get(name);
		this.connections.delete(name);
		if (connection) await connection.client.close().catch(() => undefined);
	}

	private async closeConnections(): Promise<void> {
		const connections = [...this.connections.values()];
		this.connections.clear();
		await Promise.allSettled(connections.map((connection) => connection.client.close()));
	}
}
