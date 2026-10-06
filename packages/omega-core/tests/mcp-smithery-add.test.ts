import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME, type McpServerConfig, getAgentDir } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpHttpServer, McpServerConfig as LegacyMcpServerConfig } from "../src/mcp/native-types.ts";
import { type SmitherySearchResult, smitheryConfigName } from "../src/mcp/smithery-registry.ts";
import {
	addServerToMcpJson,
	formatSmitheryChoice,
	resolveSmitheryServer,
	smitheryJsonSnippet,
	smitheryPersistPath,
	toUpstreamServerConfig,
} from "../src/mcp-smithery/smithery-add.ts";

function jsonResponse(value: unknown): Response {
	return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
}

function searchResult(overrides: Partial<SmitherySearchResult> = {}): SmitherySearchResult {
	return {
		id: "1",
		qualifiedName: "acme/search",
		displayName: "Search",
		description: "Search things",
		verified: true,
		useCount: 42,
		suggestedConfig: { type: "stdio", command: "npx", args: ["-y", "@smithery/cli", "run", "@acme/search"] },
		...overrides,
	} as SmitherySearchResult;
}

const tmpDirs: string[] = [];
afterEach(() => {
	for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmpPath(name: string): string {
	const dir = mkdtempSync(join(tmpdir(), "omega-smithery-"));
	tmpDirs.push(dir);
	return join(dir, name);
}

describe("toUpstreamServerConfig", () => {
	it("maps stdio servers and drops empty optional fields", () => {
		const config: LegacyMcpServerConfig = { type: "stdio", command: "npx", args: ["-y", "server"], env: { A: "1" } };
		expect(toUpstreamServerConfig(config)).toEqual({
			type: "stdio",
			command: "npx",
			args: ["-y", "server"],
			env: { A: "1" },
		});
		expect(toUpstreamServerConfig({ type: "stdio", command: "uvx" })).toEqual({ type: "stdio", command: "uvx" });
	});

	it("normalizes HTTP transports to type http and keeps headers", () => {
		const config: LegacyMcpServerConfig = {
			type: "streamable-http",
			url: "https://mcp.example.com",
			headers: { Authorization: "Bearer ${KEY}" },
		};
		expect(toUpstreamServerConfig(config)).toEqual({
			type: "http",
			url: "https://mcp.example.com",
			headers: { Authorization: "Bearer ${KEY}" },
		});
	});

	it("drops legacy-only fields the upstream config does not accept", () => {
		const config = {
			type: "streamable-http",
			url: "https://mcp.example.com",
			disabled: true,
			auth: "oauth",
		} as unknown as LegacyMcpServerConfig;
		expect(toUpstreamServerConfig(config)).toEqual({ type: "http", url: "https://mcp.example.com" });
	});
});

describe("resolveSmitheryServer", () => {
	it("uses the suggested config without Smithery Connect", async () => {
		const resolved = await resolveSmitheryServer(searchResult(), { apiKey: "key", useConnect: false });
		expect(resolved.name).toBe("acme-search");
		expect(resolved.config).toEqual({ type: "stdio", command: "npx", args: ["-y", "@smithery/cli", "run", "@acme/search"] });
		expect(resolved.authorizationUrl).toBeUndefined();
	});

	it("reuses an existing Smithery Connect connection as a proxy server", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(jsonResponse({ namespaces: [{ name: "omega" }] }))
			.mockResolvedValueOnce(
				jsonResponse({ connections: [{ connectionId: "conn-1", mcpUrl: "https://mcp.example.com", name: "Search" }] }),
			);
		const resolved = await resolveSmitheryServer(searchResult({ mcpUrl: "https://mcp.example.com" }), {
			apiKey: "key",
			useConnect: true,
			fetch: fetchMock,
		});
		const config = resolved.config as McpHttpServer;
		expect(config.type).toBe("http");
		expect(config.url).toBe("https://api.smithery.ai/connect/omega/conn-1/mcp");
		expect(config.headers?.Authorization).toBe("Bearer ${SMITHERY_API_KEY}");
		expect(JSON.stringify(resolved.config)).not.toContain("key");
	});

	it("returns the authorization URL when the connection needs sign-in", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(jsonResponse({ namespaces: [] }))
			.mockResolvedValueOnce(jsonResponse({ name: "omega" }))
			.mockResolvedValueOnce(jsonResponse({ connections: [] }))
			.mockResolvedValueOnce(
				jsonResponse({
					connectionId: "conn-2",
					mcpUrl: "https://mcp.example.com",
					name: "Search",
					status: { state: "auth_required", authorizationUrl: "https://auth.example.com/authorize" },
				}),
			);
		const resolved = await resolveSmitheryServer(searchResult({ mcpUrl: "https://mcp.example.com" }), {
			apiKey: "key",
			useConnect: true,
			fetch: fetchMock,
		});
		expect(resolved.authorizationUrl).toBe("https://auth.example.com/authorize");
	});

	it("throws when Smithery reports missing configuration", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(jsonResponse({ namespaces: [{ name: "omega" }] }))
			.mockResolvedValueOnce(jsonResponse({ connections: [] }))
			.mockResolvedValueOnce(
				jsonResponse({
					connectionId: "conn-3",
					mcpUrl: "https://mcp.example.com",
					name: "Search",
					status: { state: "input_required", missing: ["apiKey"] },
				}),
			);
		await expect(
			resolveSmitheryServer(searchResult({ mcpUrl: "https://mcp.example.com" }), {
				apiKey: "key",
				useConnect: true,
				fetch: fetchMock,
			}),
		).rejects.toThrow("Smithery requires additional configuration: apiKey");
	});
});

describe("addServerToMcpJson", () => {
	const config: McpServerConfig = { type: "http", url: "https://mcp.example.com" };

	it("creates the file when missing", () => {
		const path = tmpPath("mcp.json");
		expect(addServerToMcpJson(path, "acme", config)).toBe(false);
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ mcpServers: { acme: config } });
	});

	it("keeps other content and reports replacements", () => {
		const path = tmpPath("mcp.json");
		const first: LegacyMcpServerConfig = { type: "stdio", command: "old" };
		addServerToMcpJson(path, "acme", toUpstreamServerConfig(first));
		addServerToMcpJson(path, "other", { type: "http", url: "https://other.example.com" });
		expect(addServerToMcpJson(path, "acme", config)).toBe(true);
		const parsed = JSON.parse(readFileSync(path, "utf8")) as { mcpServers: Record<string, unknown> };
		expect(parsed.mcpServers.acme).toEqual(config);
		expect(parsed.mcpServers.other).toEqual({ type: "http", url: "https://other.example.com" });
	});
});

describe("smithery helpers", () => {
	it("resolves persistence paths from the config dir and agent dir", () => {
		expect(smitheryPersistPath("project", join("cwd", "sub"))).toBe(join("cwd", "sub", CONFIG_DIR_NAME, "mcp.json"));
		expect(smitheryPersistPath("global")).toBe(join(getAgentDir(), "mcp.json"));
		expect(() => smitheryPersistPath("project")).toThrow("working directory");
	});

	it("renders a pasteable JSON snippet", () => {
		const snippet = smitheryJsonSnippet("acme-search", { type: "http", url: "https://mcp.example.com" });
		expect(JSON.parse(snippet)).toEqual({ mcpServers: { "acme-search": { type: "http", url: "https://mcp.example.com" } } });
	});

	it("formats list choices with verification and usage", () => {
		expect(formatSmitheryChoice(searchResult())).toBe("✓ Search — acme/search (42 uses)");
		expect(formatSmitheryChoice(searchResult({ verified: false, useCount: 0 }))).toBe("Search — acme/search (0 uses)");
		expect(smitheryConfigName("@Acme/Search MCP")).toBe("acme-search-mcp");
	});
});
