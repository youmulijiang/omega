import { isAbsolute, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { interpolateEnvVars, loadMcpConfig } from "./native-config.ts";
import type { McpConnection, McpServerConfig, McpServerState } from "./native-types.ts";

const DEFAULT_TIMEOUT_MS = 30_000;

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

export class OmegaMcpManager {
	private readonly cwd: string;
	private readonly connections = new Map<string, McpConnection>();
	private readonly states = new Map<string, McpServerState>();

	constructor(cwd: string) {
		this.cwd = cwd;
	}

	async reload(connect = true): Promise<void> {
		await this.close();
		this.states.clear();
		for (const [name, config] of Object.entries(loadMcpConfig(this.cwd).mcpServers)) {
			this.states.set(name, {
				name,
				config,
				status: isEnabled(config) ? "disconnected" : "disabled",
				tools: [],
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

	async connect(name: string): Promise<McpServerState> {
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
		try {
			const client = new Client({ name: "omega", version: "0.1.0" }, { capabilities: {} });
			const config = state.config;
			const transport =
				"command" in config
					? new StdioClientTransport({
							command: interpolateEnvVars(config.command),
							...(config.args ? { args: config.args.map((value) => interpolateEnvVars(value)) } : {}),
							env: environment(config.env),
							cwd: config.cwd
								? isAbsolute(interpolateEnvVars(config.cwd))
									? interpolateEnvVars(config.cwd)
									: resolve(this.cwd, interpolateEnvVars(config.cwd))
								: this.cwd,
							stderr: "pipe",
						})
					: new StreamableHTTPClientTransport(new URL(interpolateEnvVars(config.url)), {
							requestInit: config.headers ? { headers: interpolateRecord(config.headers) } : undefined,
						});
			await client.connect(transport, { timeout: config.timeout ?? DEFAULT_TIMEOUT_MS });
			const listed = await client.listTools(undefined, { timeout: config.timeout ?? DEFAULT_TIMEOUT_MS });
			state.tools = listed.tools;
			state.status = "connected";
			this.connections.set(name, { client, transport });
			return state;
		} catch (error) {
			state.status = /401|403|unauthorized|oauth/i.test(error instanceof Error ? error.message : String(error))
				? "needs-auth"
				: "error";
			state.error = error instanceof Error ? error.message : String(error);
			throw error;
		}
	}

	async reconnect(name: string): Promise<McpServerState> {
		await this.close(name);
		const state = this.states.get(name);
		if (!state) throw new Error(`Unknown MCP server: ${name}`);
		state.status = isEnabled(state.config) ? "disconnected" : "disabled";
		state.tools = [];
		state.error = undefined;
		return this.connect(name);
	}

	listTools(server?: string): Array<{ server: string; tool: Tool }> {
		return this.getStates()
			.filter((state) => !server || state.name === server)
			.flatMap((state) => state.tools.map((tool) => ({ server: state.name, tool })));
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
		const timeout = this.states.get(server)?.config.timeout ?? DEFAULT_TIMEOUT_MS;
		const result = await connection.client.callTool({ name: tool, arguments: args }, undefined, { timeout, signal });
		if (!isCallToolResult(result))
			throw new Error(`MCP tool "${server}/${tool}" returned an unsupported task result`);
		return result;
	}

	async close(name?: string): Promise<void> {
		const entries: Array<readonly [string, McpConnection | undefined]> = name
			? [[name, this.connections.get(name)] as const]
			: [...this.connections.entries()];
		for (const [serverName, connection] of entries) {
			if (!connection) continue;
			this.connections.delete(serverName);
			await connection.client.close().catch(() => undefined);
		}
	}
}
