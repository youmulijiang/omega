import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { McpOAuthCallbackServer, OmegaOAuthProvider, OmegaOAuthStore } from "../src/mcp/oauth.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryStore(): OmegaOAuthStore {
	const directory = mkdtempSync(join(tmpdir(), "omega-mcp-oauth-"));
	temporaryDirectories.push(directory);
	return new OmegaOAuthStore(join(directory, "oauth.json"));
}

describe("OmegaOAuthStore", () => {
	it("round-trips server entries and drops mismatched URLs", async () => {
		const store = temporaryStore();
		await store.saveServer("remote", { serverUrl: "https://example.com/mcp", tokens: undefined });
		expect(await store.loadServer("remote", "https://example.com/mcp")).toMatchObject({
			serverUrl: "https://example.com/mcp",
		});
		// URL binding: a re-pointed server must not see the old credentials.
		expect(await store.loadServer("remote", "https://other.example.com/mcp")).toBeUndefined();
		expect(await store.loadServer("missing", "https://example.com/mcp")).toBeUndefined();
	});

	it("clears stored entries", async () => {
		const store = temporaryStore();
		await store.saveServer("remote", { serverUrl: "https://example.com/mcp" });
		await store.clearServer("remote");
		expect(await store.loadServer("remote", "https://example.com/mcp")).toBeUndefined();
	});
});

describe("OmegaOAuthProvider", () => {
	it("persists tokens and client information through the store", async () => {
		const store = temporaryStore();
		const provider = new OmegaOAuthProvider({
			serverName: "remote",
			serverUrl: "https://example.com/mcp",
			store,
		});
		await provider.saveTokens({
			access_token: "at",
			token_type: "Bearer",
			refresh_token: "rt",
		});
		await provider.saveClientInformation({ client_id: "generated", client_secret: "s" });
		expect(await provider.tokens()).toMatchObject({ access_token: "at", refresh_token: "rt" });
		expect(await provider.clientInformation()).toMatchObject({ client_id: "generated" });
		// Pre-registered clientId is used while no dynamic registration exists.
		const preconfigured = new OmegaOAuthProvider({
			serverName: "other",
			serverUrl: "https://example.com/mcp",
			clientId: "static-id",
			store,
		});
		expect(await preconfigured.clientInformation()).toMatchObject({ client_id: "static-id" });
	});

	it("invalidates tokens without touching client registration", async () => {
		const store = temporaryStore();
		const provider = new OmegaOAuthProvider({
			serverName: "remote",
			serverUrl: "https://example.com/mcp",
			store,
		});
		await provider.saveClientInformation({ client_id: "generated" });
		await provider.saveTokens({ access_token: "at", token_type: "Bearer" });
		await provider.invalidateCredentials("tokens");
		expect(await provider.tokens()).toBeUndefined();
		expect(await provider.clientInformation()).toMatchObject({ client_id: "generated" });
	});

	it("exposes an authorization URL through redirectToAuthorization", async () => {
		const provider = new OmegaOAuthProvider({
			serverName: "remote",
			serverUrl: "https://example.com/mcp",
			store: temporaryStore(),
		});
		const url = new URL("https://auth.example.com/authorize?code=x");
		await expect(provider.redirectToAuthorization(url)).rejects.toThrow(/authorization required/i);
	});
});

describe("McpOAuthCallbackServer", () => {
	it("rejects callbacks with mismatched CSRF state", async () => {
		const server = new McpOAuthCallbackServer();
		const redirectUri = await server.start("expected-state");
		expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
		const pending = server.waitForCallback();
		const { port } = new URL(redirectUri);
		const response = await fetch(`http://127.0.0.1:${port}/callback?code=abc&state=wrong`);
		expect(response.status).toBe(400);
		await expect(pending).rejects.toThrow(/state mismatch/i);
	});

	it("resolves the redirect URL on a valid callback", async () => {
		const server = new McpOAuthCallbackServer();
		const redirectUri = await server.start("expected-state");
		const pending = server.waitForCallback();
		const { port } = new URL(redirectUri);
		const response = await fetch(`http://127.0.0.1:${port}/callback?code=abc&state=expected-state`);
		expect(response.status).toBe(200);
		await expect(pending).resolves.toMatchObject({
			searchParams: expect.objectContaining({}) as unknown,
		});
		const url = await pending;
		expect(url.searchParams.get("code")).toBe("abc");
	});
});
