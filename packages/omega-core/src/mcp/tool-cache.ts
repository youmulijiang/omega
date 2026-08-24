import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { McpServerConfig } from "./native-types.ts";

const CACHE_VERSION = 1;
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface ToolCacheEntry {
	configHash: string;
	expiresAt: number;
	tools: Tool[];
}

interface ToolCacheDocument {
	version: number;
	servers: Record<string, ToolCacheEntry>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stableValue);
	if (!isRecord(value)) return value;
	return Object.fromEntries(
		Object.keys(value)
			.sort()
			.map((key) => [key, stableValue(value[key])]),
	);
}

function configHash(config: McpServerConfig): string {
	return createHash("sha256")
		.update(JSON.stringify(stableValue(config)))
		.digest("hex");
}

function isTool(value: unknown): value is Tool {
	return isRecord(value) && typeof value.name === "string" && isRecord(value.inputSchema);
}

function parseDocument(value: unknown): ToolCacheDocument {
	if (!isRecord(value) || value.version !== CACHE_VERSION || !isRecord(value.servers)) {
		return { version: CACHE_VERSION, servers: {} };
	}
	const servers: Record<string, ToolCacheEntry> = {};
	for (const [name, entry] of Object.entries(value.servers)) {
		if (
			isRecord(entry) &&
			typeof entry.configHash === "string" &&
			typeof entry.expiresAt === "number" &&
			Array.isArray(entry.tools) &&
			entry.tools.every(isTool)
		) {
			servers[name] = {
				configHash: entry.configHash,
				expiresAt: entry.expiresAt,
				tools: entry.tools,
			};
		}
	}
	return { version: CACHE_VERSION, servers };
}

export class OmegaMcpToolCache {
	private readonly path: string;
	private mutation = Promise.resolve();

	constructor(path = join(getAgentDir(), "mcp-tools-cache.json")) {
		this.path = path;
	}

	async get(server: string, config: McpServerConfig): Promise<Tool[] | undefined> {
		await this.mutation;
		const document = await this.read();
		const entry = document.servers[server];
		if (!entry || entry.expiresAt <= Date.now() || entry.configHash !== configHash(config)) return undefined;
		return entry.tools;
	}

	set(server: string, config: McpServerConfig, tools: Tool[]): Promise<void> {
		return this.enqueue(async () => {
			const document = await this.read();
			document.servers[server] = {
				configHash: configHash(config),
				expiresAt: Date.now() + CACHE_TTL_MS,
				tools,
			};
			await this.write(document);
		});
	}

	delete(server: string): Promise<void> {
		return this.enqueue(async () => {
			const document = await this.read();
			delete document.servers[server];
			await this.write(document);
		});
	}

	private enqueue(operation: () => Promise<void>): Promise<void> {
		const result = this.mutation.then(operation, operation);
		this.mutation = result.catch(() => undefined);
		return result;
	}

	private async read(): Promise<ToolCacheDocument> {
		try {
			return parseDocument(JSON.parse(await readFile(this.path, "utf8")) as unknown);
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") {
				return { version: CACHE_VERSION, servers: {} };
			}
			return { version: CACHE_VERSION, servers: {} };
		}
	}

	private async write(document: ToolCacheDocument): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true });
		const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
		try {
			await writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
			await rename(temporaryPath, this.path);
		} catch (error) {
			await rm(temporaryPath, { force: true }).catch(() => undefined);
			throw error;
		}
	}
}
