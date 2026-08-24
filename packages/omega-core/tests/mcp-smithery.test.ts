import { describe, expect, it, vi } from "vitest";
import {
	createSmitheryConnection,
	resolveSmitheryNamespace,
	smitheryProxyConfig,
} from "../src/mcp/smithery-connect.ts";
import { searchSmitheryRegistry, smitheryConfigName } from "../src/mcp/smithery-registry.ts";

function jsonResponse(value: unknown): Response {
	return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
}

describe("Smithery integration", () => {
	it("searches the registry and produces a direct HTTP configuration", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				jsonResponse({ servers: [{ id: "1", qualifiedName: "acme/search", displayName: "Search", verified: true }] }),
			)
			.mockResolvedValueOnce(
				jsonResponse({
					qualifiedName: "acme/search",
					connections: [{ type: "http", deploymentUrl: "https://mcp.example.com", configSchema: { properties: {} } }],
				}),
			);

		const result = await searchSmitheryRegistry("search", {
			apiKey: "test-key",
			baseUrl: "https://registry.test",
			fetch: fetchMock,
		});

		expect(result[0]).toMatchObject({
			qualifiedName: "acme/search",
			mcpUrl: "https://mcp.example.com",
			suggestedConfig: { type: "streamable-http", url: "https://mcp.example.com" },
		});
		expect(fetchMock.mock.calls[0]?.[0]).toBe("https://registry.test/servers?q=search&pageSize=10");
	});

	it("creates a managed connection without persisting the API key", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(jsonResponse({ namespaces: [{ name: "omega" }] }))
			.mockResolvedValueOnce(
				jsonResponse({ connectionId: "conn-1", mcpUrl: "https://mcp.example.com", name: "Search" }),
			);
		const options = { baseUrl: "https://api.test", fetch: fetchMock };

		const namespace = await resolveSmitheryNamespace("secret", options);
		const connection = await createSmitheryConnection("secret", namespace, "https://mcp.example.com", "Search", options);
		const config = smitheryProxyConfig(namespace, connection.connectionId);

		expect(namespace).toBe("omega");
		expect(fetchMock.mock.calls[1]?.[1]?.body).toBe(
			JSON.stringify({ mcpUrl: "https://mcp.example.com", name: "Search" }),
		);
		expect(config.headers?.Authorization).toBe("Bearer ${SMITHERY_API_KEY}");
		expect(JSON.stringify(config)).not.toContain("secret");
		expect(smitheryConfigName("@Acme/Search MCP")).toBe("acme-search-mcp");
	});
});
