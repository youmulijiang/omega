import type { McpConnectionStatus } from "./native-types.ts";

export const MCP_STATUS_CHANNEL = "omega:mcp:status";

export interface McpStatusEntry {
	readonly name: string;
	readonly status: McpConnectionStatus;
	readonly error?: string;
}
