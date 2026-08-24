import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export interface McpReconnectOptions {
	enabled?: boolean;
	maxRetries?: number;
	initialDelay?: number;
	maxDelay?: number;
	factor?: number;
}

export interface McpServerBase {
	disabled?: boolean;
	enabled?: boolean;
	timeout?: number;
	auth?: "oauth" | "none";
	reconnect?: McpReconnectOptions;
}

export interface McpStdioServer extends McpServerBase {
	type?: "stdio";
	command: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
}

export interface McpHttpServer extends McpServerBase {
	type?: "http" | "streamable-http";
	url: string;
	headers?: Record<string, string>;
}

export type McpServerConfig = McpStdioServer | McpHttpServer;

export interface McpConfigFile {
	mcpServers: Record<string, McpServerConfig>;
}

export type McpConnectionStatus = "disconnected" | "connecting" | "connected" | "disabled" | "needs-auth" | "error";

export interface McpServerState {
	name: string;
	config: McpServerConfig;
	status: McpConnectionStatus;
	tools: Tool[];
	toolSource?: "live" | "cache";
	reconnectAttempts?: number;
	error?: string;
}

export interface McpConnection {
	client: Client;
	transport: Transport;
}
