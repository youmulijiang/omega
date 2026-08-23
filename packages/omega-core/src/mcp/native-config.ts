import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { McpConfigFile, McpServerBase, McpServerConfig } from "./native-types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
	return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}

function parseServer(name: string, value: unknown): McpServerConfig {
	if (!isRecord(value)) throw new Error(`MCP server "${name}" must be an object`);
	const common: McpServerBase = {
		...(typeof value.disabled === "boolean" ? { disabled: value.disabled } : {}),
		...(typeof value.enabled === "boolean" ? { enabled: value.enabled } : {}),
		...(typeof value.timeout === "number" ? { timeout: value.timeout } : {}),
		...(value.auth === "oauth" || value.auth === "none" ? { auth: value.auth } : {}),
	};

	if (typeof value.command === "string" && value.command.trim()) {
		if (
			value.args !== undefined &&
			(!Array.isArray(value.args) || !value.args.every((item) => typeof item === "string"))
		) {
			throw new Error(`MCP server "${name}" args must be a string array`);
		}
		if (value.env !== undefined && !isStringRecord(value.env)) {
			throw new Error(`MCP server "${name}" env must contain string values`);
		}
		return {
			...common,
			type: "stdio",
			command: value.command,
			...(Array.isArray(value.args) ? { args: value.args as string[] } : {}),
			...(isStringRecord(value.env) ? { env: value.env } : {}),
			...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}),
		};
	}

	if (typeof value.url === "string" && value.url.trim()) {
		if (value.headers !== undefined && !isStringRecord(value.headers)) {
			throw new Error(`MCP server "${name}" headers must contain string values`);
		}
		return {
			...common,
			type: value.type === "streamable-http" ? "streamable-http" : "http",
			url: value.url,
			...(isStringRecord(value.headers) ? { headers: value.headers } : {}),
		};
	}

	throw new Error(`MCP server "${name}" requires either command or url`);
}

export function parseMcpConfig(value: unknown): McpConfigFile {
	if (!isRecord(value)) throw new Error("MCP config must be an object");
	const rawServers = value.mcpServers ?? value.servers ?? {};
	if (!isRecord(rawServers)) throw new Error("mcpServers must be an object");
	return {
		mcpServers: Object.fromEntries(
			Object.entries(rawServers).map(([name, server]) => [name, parseServer(name, server)]),
		),
	};
}

function readConfig(filePath: string): McpConfigFile {
	if (!existsSync(filePath)) return { mcpServers: {} };
	try {
		return parseMcpConfig(JSON.parse(readFileSync(filePath, "utf8")) as unknown);
	} catch (error) {
		throw new Error(
			`Failed to read MCP config ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

export function getProjectMcpConfigPath(cwd: string): string {
	return resolve(cwd, ".mcp.json");
}

export function getMcpConfigPaths(cwd: string): string[] {
	return [
		join(homedir(), ".config", "mcp", "mcp.json"),
		join(homedir(), ".omega", "agent", "mcp.json"),
		getProjectMcpConfigPath(cwd),
		resolve(cwd, ".omega", "mcp.json"),
	];
}

export function interpolateEnvVars(value: string, env: NodeJS.ProcessEnv = process.env): string {
	return value
		.replace(/\$\{(\w+)\}/g, (_match, name: string) => env[name] ?? "")
		.replace(/\$env:(\w+)/g, (_match, name: string) => env[name] ?? "")
		.replace(/\{env:(\w+)\}/g, (_match, name: string) => env[name] ?? "");
}

export function loadMcpConfig(cwd: string): McpConfigFile {
	const mcpServers: Record<string, McpServerConfig> = {};
	for (const filePath of getMcpConfigPaths(cwd)) Object.assign(mcpServers, readConfig(filePath).mcpServers);
	return { mcpServers };
}

export function readProjectMcpConfig(cwd: string): McpConfigFile {
	return readConfig(getProjectMcpConfigPath(cwd));
}

export function writeProjectMcpConfig(cwd: string, config: McpConfigFile): string {
	const validated = parseMcpConfig(config);
	const filePath = getProjectMcpConfigPath(cwd);
	mkdirSync(dirname(filePath), { recursive: true });
	const temporaryPath = `${filePath}.${process.pid}.tmp`;
	writeFileSync(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
	renameSync(temporaryPath, filePath);
	return filePath;
}

export function updateProjectServer(cwd: string, name: string, server: McpServerConfig | undefined): string {
	const config = readProjectMcpConfig(cwd);
	if (server) config.mcpServers[name] = server;
	else delete config.mcpServers[name];
	return writeProjectMcpConfig(cwd, config);
}
