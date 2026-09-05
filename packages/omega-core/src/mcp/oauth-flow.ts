import { auth, UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OmegaOAuthStore } from "./oauth.ts";
import { AuthorizationRequiredError, McpOAuthCallbackServer, OmegaOAuthProvider } from "./oauth.ts";

export interface OAuthFlowInput {
	serverName: string;
	serverUrl: string;
	clientId?: string;
	clientSecret?: string;
	scope?: string;
	store: OmegaOAuthStore;
	/**
	 * Presents the authorization URL to the user. Interactive flows open or
	 * link the URL; headless flows just surface it in the result.
	 */
	presentUrl: (url: URL) => void | Promise<void>;
}

export interface OAuthFlowOutcome {
	status: "authorized";
}

/**
 * Runs the interactive OAuth 2.1 + PKCE authorization_code flow:
 *
 * 1. Start the loopback callback server (OS-assigned port).
 * 2. `auth()` discovers endpoints (RFC 9728), dynamically registers the
 *    client when no pre-registered ID is configured (RFC 7591), and signals
 *    the browser redirect via `AuthorizationRequiredError`.
 * 3. The user authorizes in the browser; the callback delivers the code.
 * 4. `auth()` exchanges the code for tokens; the provider persists them.
 *
 * Existing refresh tokens are refreshed in step 2 without browser interaction.
 */
export async function runOAuthFlow(input: OAuthFlowInput): Promise<OAuthFlowOutcome> {
	const provider = new OmegaOAuthProvider({
		serverName: input.serverName,
		serverUrl: input.serverUrl,
		clientId: input.clientId,
		clientSecret: input.clientSecret,
		scope: input.scope,
		store: input.store,
	});
	const callback = new McpOAuthCallbackServer();
	try {
		const state = await provider.state();
		const redirectUri = await callback.start(state);
		provider.beginFlow(new URL(redirectUri));

		let authorizationUrl: URL | undefined;
		try {
			const result = await auth(provider, {
				serverUrl: input.serverUrl,
				scope: input.scope,
			});
			if (result === "AUTHORIZED") return { status: "authorized" };
			throw new Error("OAuth flow returned an unexpected result");
		} catch (error) {
			if (error instanceof AuthorizationRequiredError) {
				authorizationUrl = error.authorizationUrl;
			} else if (error instanceof UnauthorizedError) {
				throw error;
			} else {
				throw error;
			}
		}
		if (!authorizationUrl) throw new Error("OAuth flow requires authorization but produced no URL");

		await input.presentUrl(authorizationUrl);
		const redirect = await callback.waitForCallback();
		const code = redirect.searchParams.get("code");
		if (!code) throw new Error("OAuth callback contained no authorization code");

		const result = await auth(provider, {
			serverUrl: input.serverUrl,
			scope: input.scope,
			authorizationCode: code,
		});
		if (result !== "AUTHORIZED") throw new Error("OAuth code exchange failed");
		return { status: "authorized" };
	} finally {
		provider.endFlow();
		callback.cancel();
	}
}
