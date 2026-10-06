import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, type McpServerConfig } from "@earendil-works/pi-coding-agent";
import type { McpServerConfig as LegacyMcpServerConfig } from "../mcp/native-types.ts";
import {
	createSmitheryConnection,
	findSmitheryConnection,
	resolveSmitheryNamespace,
	smitheryProxyConfig,
} from "../mcp/smithery-connect.ts";
import { type SmitherySearchResult, smitheryConfigName } from "../mcp/smithery-registry.ts";

/**
 * Smithery "search + add" support for the upstream builtin MCP
 * (packages/coding-agent/src/extensions/mcp/). The omega legacy MCP client stays retired; this
 * module only reuses src/mcp's Smithery registry/connect clients and hands the resulting server
 * config to `pi.registerMcpServer()` or an upstream `mcp.json`.
 */

/** Label for the result list of `/smithery <query>`. */
export function formatSmitheryChoice(result: SmitherySearchResult): string {
	return `${result.verified ? "✓ " : ""}${result.displayName} — ${result.qualifiedName} (${result.useCount} uses)`;
}

/** Map an omega legacy MCP config onto the config shape the upstream builtin MCP accepts. */
export function toUpstreamServerConfig(config: LegacyMcpServerConfig): McpServerConfig {
	if ("command" in config) {
		return {
			type: "stdio",
			command: config.command,
			...(config.args && config.args.length > 0 ? { args: config.args } : {}),
			...(config.env && Object.keys(config.env).length > 0 ? { env: config.env } : {}),
			...(config.cwd ? { cwd: config.cwd } : {}),
		};
	}
	return {
		type: "http",
		url: config.url,
		...(config.headers && Object.keys(config.headers).length > 0 ? { headers: config.headers } : {}),
	};
}

export interface ResolvedSmitheryServer {
	name: string;
	config: McpServerConfig;
	/** OAuth authorization URL when Smithery reports the connection needs sign-in. */
	authorizationUrl?: string;
}

/**
 * Build the upstream server config for a Smithery search result. With `useConnect` and a remote
 * deployment URL, the server is reached through a Smithery Connect proxy connection instead.
 */
export async function resolveSmitheryServer(
	selected: SmitherySearchResult,
	options: { apiKey: string; useConnect: boolean; fetch?: typeof fetch; signal?: AbortSignal },
): Promise<ResolvedSmitheryServer> {
	const name = smitheryConfigName(selected.qualifiedName);
	if (!options.useConnect || !selected.mcpUrl) {
		return { name, config: toUpstreamServerConfig(selected.suggestedConfig) };
	}
	const connectOptions = { fetch: options.fetch, signal: options.signal };
	const namespace = await resolveSmitheryNamespace(options.apiKey, connectOptions);
	const connection =
		(await findSmitheryConnection(options.apiKey, namespace, selected.mcpUrl, connectOptions)) ??
		(await createSmitheryConnection(
			options.apiKey,
			namespace,
			selected.mcpUrl,
			selected.displayName,
			connectOptions,
		));
	if (connection.status?.state === "input_required") {
		throw new Error(
			`Smithery requires additional configuration: ${connection.status.missing?.join(", ") || "open Smithery to configure the connection"}`,
		);
	}
	if (connection.status?.state === "error") {
		throw new Error(connection.status.message ?? "Smithery connection failed");
	}
	return {
		name,
		config: toUpstreamServerConfig(smitheryProxyConfig(namespace, connection.connectionId)),
		...(connection.status?.state === "auth_required" && connection.status.authorizationUrl
			? { authorizationUrl: connection.status.authorizationUrl }
			: {}),
	};
}

/**
 * Merge a server into an upstream `mcp.json`, creating the file when missing. Existing content is
 * kept. Returns true when an entry with the same name was replaced.
 */
export function addServerToMcpJson(path: string, name: string, config: McpServerConfig): boolean {
	let parsed: Record<string, unknown> = {};
	if (existsSync(path)) {
		const text = readFileSync(path, "utf8");
		const value: unknown = text.trim() ? JSON.parse(text) : {};
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			throw new Error(`${path}: expected a JSON object with an "mcpServers" object`);
		}
		parsed = value as Record<string, unknown>;
	}
	const existing = parsed.mcpServers;
	const servers: Record<string, unknown> =
		typeof existing === "object" && existing !== null && !Array.isArray(existing) ? { ...existing } : {};
	const replaced = servers[name] !== undefined;
	servers[name] = config;
	parsed.mcpServers = servers;
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`);
	return replaced;
}

/** Path of the upstream `mcp.json` for a persistence scope. */
export function smitheryPersistPath(scope: "project" | "global", cwd?: string): string {
	if (scope === "project") {
		if (!cwd) throw new Error("Project persistence needs the session working directory");
		return join(cwd, CONFIG_DIR_NAME, "mcp.json");
	}
	return join(getAgentDir(), "mcp.json");
}

/** JSON snippet the user can paste into an `mcp.json` to persist the server manually. */
export function smitheryJsonSnippet(name: string, config: McpServerConfig): string {
	return JSON.stringify({ mcpServers: { [name]: config } }, null, 2);
}
