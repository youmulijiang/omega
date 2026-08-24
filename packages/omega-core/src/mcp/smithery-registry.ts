import type { McpServerConfig } from "./native-types.ts";
import { withTimeoutSignal } from "./timeout.ts";

const DEFAULT_SMITHERY_REGISTRY_URL = "https://api.smithery.ai";
const SMITHERY_TIMEOUT_MS = 10_000;

interface SmitheryRegistryEntry {
	id?: string;
	qualifiedName?: string;
	namespace?: string;
	slug?: string;
	displayName?: string;
	description?: string;
	verified?: boolean;
	useCount?: number;
}

interface SmitheryConnectionDefinition {
	type?: "http" | "stdio";
	deploymentUrl?: string;
	configSchema?: { properties?: Record<string, unknown> };
}

interface SmitheryServerDetails extends SmitheryRegistryEntry {
	remote?: boolean;
	deploymentUrl?: string;
	connections?: SmitheryConnectionDefinition[];
}

export interface SmitherySearchResult {
	id: string;
	qualifiedName: string;
	displayName: string;
	description: string;
	verified: boolean;
	useCount: number;
	mcpUrl?: string;
	suggestedConfig: McpServerConfig;
}

export interface SmitheryRegistryOptions {
	apiKey: string;
	baseUrl?: string;
	fetch?: typeof fetch;
	limit?: number;
	signal?: AbortSignal;
}

export class SmitheryRegistryError extends Error {
	readonly status: number;

	constructor(message: string, status: number) {
		super(message);
		this.name = "SmitheryRegistryError";
		this.status = status;
	}
}

function registryBaseUrl(options: SmitheryRegistryOptions): string {
	return (options.baseUrl ?? process.env.SMITHERY_REGISTRY_URL ?? DEFAULT_SMITHERY_REGISTRY_URL).replace(/\/+$/, "");
}

async function registryJson<T>(path: string, options: SmitheryRegistryOptions): Promise<T | undefined> {
	const response = await (options.fetch ?? fetch)(`${registryBaseUrl(options)}${path}`, {
		headers: { Authorization: `Bearer ${options.apiKey}` },
		signal: withTimeoutSignal(SMITHERY_TIMEOUT_MS, options.signal),
	});
	if (response.status === 404) return undefined;
	if (!response.ok) {
		throw new SmitheryRegistryError(
			`Smithery registry request failed with status ${response.status}`,
			response.status,
		);
	}
	return (await response.json()) as T;
}

function qualifiedName(entry: SmitheryRegistryEntry): string | undefined {
	const value =
		entry.qualifiedName ?? (entry.namespace && entry.slug ? `${entry.namespace}/${entry.slug}` : undefined);
	return value?.replace(/^@/, "");
}

function suggestedConfig(
	name: string,
	details: SmitheryServerDetails,
): {
	mcpUrl?: string;
	config: McpServerConfig;
} {
	const http = details.connections?.find((connection) => connection.type === "http" && connection.deploymentUrl);
	const mcpUrl = http?.deploymentUrl ?? details.deploymentUrl;
	if (mcpUrl && Object.keys(http?.configSchema?.properties ?? {}).length === 0) {
		return { mcpUrl, config: { type: "streamable-http", url: mcpUrl } };
	}
	return {
		...(mcpUrl ? { mcpUrl } : {}),
		config: {
			type: "stdio",
			command: "npx",
			args: ["-y", "@smithery/cli", "run", `@${name}`, "--config", "{}"],
		},
	};
}

export async function searchSmitheryRegistry(
	query: string,
	options: SmitheryRegistryOptions,
): Promise<SmitherySearchResult[]> {
	const trimmed = query.trim();
	if (!trimmed) return [];
	const limit = Math.max(1, Math.min(20, Math.trunc(options.limit ?? 10)));
	const list = await registryJson<{ servers?: SmitheryRegistryEntry[] }>(
		`/servers?q=${encodeURIComponent(trimmed)}&pageSize=${limit}`,
		options,
	);
	const results: SmitherySearchResult[] = [];
	for (const entry of list?.servers ?? []) {
		const name = qualifiedName(entry);
		if (!name) continue;
		const details =
			(await registryJson<SmitheryServerDetails>(`/servers/${encodeURIComponent(name)}`, options)) ?? entry;
		const suggested = suggestedConfig(name, details);
		results.push({
			id: entry.id ?? name,
			qualifiedName: name,
			displayName: details.displayName ?? entry.displayName ?? name,
			description: details.description ?? entry.description ?? "No description",
			verified: entry.verified === true,
			useCount: entry.useCount ?? 0,
			...(suggested.mcpUrl ? { mcpUrl: suggested.mcpUrl } : {}),
			suggestedConfig: suggested.config,
		});
	}
	return results;
}

export function smitheryConfigName(qualified: string): string {
	return qualified
		.toLowerCase()
		.replace(/^@/, "")
		.replace(/\//g, "-")
		.replace(/[^a-z0-9_.-]+/g, "-")
		.replace(/^-+|-+$/g, "");
}
