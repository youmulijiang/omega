import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { OAuthClientProvider, OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
	OAuthClientInformationFull,
	OAuthClientInformationMixed,
	OAuthClientMetadata,
	OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;
const STORE_VERSION = 1;

export interface StoredServerEntry {
	serverUrl: string;
	clientInformation?: OAuthClientInformationMixed;
	tokens?: OAuthTokens;
	discoveryState?: OAuthDiscoveryState;
}

interface OAuthStoreDocument {
	version: number;
	servers: Record<string, StoredServerEntry>;
}

function parseStoreDocument(value: unknown): OAuthStoreDocument {
	if (typeof value !== "object" || value === null) return { version: STORE_VERSION, servers: {} };
	const raw = value as { version?: unknown; servers?: unknown };
	if (raw.version !== STORE_VERSION || typeof raw.servers !== "object" || raw.servers === null) {
		return { version: STORE_VERSION, servers: {} };
	}
	const servers: Record<string, StoredServerEntry> = {};
	for (const [name, entry] of Object.entries(raw.servers as Record<string, unknown>)) {
		if (typeof entry !== "object" || entry === null) continue;
		const candidate = entry as {
			serverUrl?: unknown;
			clientInformation?: unknown;
			tokens?: unknown;
			discoveryState?: unknown;
		};
		if (typeof candidate.serverUrl !== "string") continue;
		servers[name] = {
			serverUrl: candidate.serverUrl,
			...(typeof candidate.clientInformation === "object" && candidate.clientInformation !== null
				? { clientInformation: candidate.clientInformation as OAuthClientInformationMixed }
				: {}),
			...(typeof candidate.tokens === "object" && candidate.tokens !== null
				? { tokens: candidate.tokens as OAuthTokens }
				: {}),
			...(typeof candidate.discoveryState === "object" && candidate.discoveryState !== null
				? { discoveryState: candidate.discoveryState as OAuthDiscoveryState }
				: {}),
		};
	}
	return { version: STORE_VERSION, servers };
}

/**
 * Per-server OAuth state persisted under the agent directory. Credentials are
 * bound to the server URL so a renamed or re-pointed server cannot reuse
 * tokens minted for another endpoint. The file is written with mode 0600.
 */
export class OmegaOAuthStore {
	private readonly path: string;
	private mutation = Promise.resolve();

	constructor(path = join(getAgentDir(), "mcp-oauth.json")) {
		this.path = path;
	}

	async loadServer(name: string, serverUrl: string): Promise<StoredServerEntry | undefined> {
		const document = await this.read();
		const entry = document.servers[name];
		return entry?.serverUrl === serverUrl ? entry : undefined;
	}

	saveServer(name: string, entry: StoredServerEntry): Promise<void> {
		return this.enqueue(async () => {
			const document = await this.read();
			document.servers[name] = entry;
			await this.write(document);
		});
	}

	clearServer(name: string): Promise<void> {
		return this.enqueue(async () => {
			const document = await this.read();
			delete document.servers[name];
			await this.write(document);
		});
	}

	private enqueue(operation: () => Promise<void>): Promise<void> {
		const result = this.mutation.then(operation, operation);
		this.mutation = result.catch(() => undefined);
		return result;
	}

	private async read(): Promise<OAuthStoreDocument> {
		try {
			return parseStoreDocument(JSON.parse(await readFile(this.path, "utf8")) as unknown);
		} catch {
			return { version: STORE_VERSION, servers: {} };
		}
	}

	private async write(document: OAuthStoreDocument): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true });
		const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
		try {
			await writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, {
				encoding: "utf8",
				mode: 0o600,
			});
			await rename(temporaryPath, this.path);
		} catch (error) {
			await rm(temporaryPath, { force: true }).catch(() => undefined);
			throw error;
		}
	}
}

/**
 * Loopback callback server for the OAuth authorization_code flow. The OS
 * assigns the port so concurrent flows never collide; binds 127.0.0.1 only.
 */
export class McpOAuthCallbackServer {
	private server: Server | undefined;
	private expectedState: string | undefined;
	private pending: Promise<URL> | undefined;
	private resolvePending: ((url: URL) => void) | undefined;
	private rejectPending: ((error: Error) => void) | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;

	/**
	 * Starts the listener and resolves with the redirect URI to advertise.
	 */
	start(expectedState: string): Promise<string> {
		if (this.server) return Promise.reject(new Error("Callback server already started"));
		let resolveUri: (uri: string) => void;
		let rejectUri: (error: Error) => void;
		const redirectUri = new Promise<string>((resolve, reject) => {
			resolveUri = resolve;
			rejectUri = reject;
		});
		const server = createServer((request, response) => {
			this.handle(request, response);
		});
		this.server = server;
		server.once("error", (error) => {
			this.stop();
			rejectUri(error instanceof Error ? error : new Error(String(error)));
		});
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				this.stop();
				rejectUri(new Error("Failed to bind loopback callback server"));
				return;
			}
			this.expectedState = expectedState;
			this.pending = new Promise<URL>((resolve, reject) => {
				this.resolvePending = resolve;
				this.rejectPending = reject;
			});
			// A rejection can fire from the HTTP handler before any caller
			// awaits waitForCallback(); swallow it here so Node never sees an
			// unhandled rejection. waitForCallback() re-exposes the same promise.
			this.pending.catch(() => undefined);
			this.timer = setTimeout(() => {
				this.fail(new Error("OAuth callback timed out after 5 minutes"));
			}, CALLBACK_TIMEOUT_MS);
			this.timer.unref?.();
			resolveUri(`http://127.0.0.1:${address.port}/callback`);
		});
		return redirectUri;
	}

	/**
	 * Resolves with the redirect URL the browser was sent to (containing the
	 * authorization code), or rejects on timeout / error / cancel.
	 */
	waitForCallback(): Promise<URL> {
		if (!this.pending) return Promise.reject(new Error("No pending OAuth callback flow"));
		return this.pending;
	}

	cancel(): void {
		this.fail(new Error("OAuth callback cancelled"));
	}

	private handle(request: IncomingMessage, response: ServerResponse): void {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		const finish = (status: number, title: string, detail?: string) => {
			response.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
			response.end(
				`<html><body style="font-family:system-ui;padding:3em"><h1>${title}</h1>${detail ? `<p>${detail}</p>` : ""}<p>You can close this tab and return to the terminal.</p></body></html>`,
			);
		};
		if (url.pathname !== "/callback") {
			finish(404, "Not found");
			return;
		}
		const error = url.searchParams.get("error");
		if (error) {
			finish(400, "Authorization failed", `${error}: ${url.searchParams.get("error_description") ?? ""}`);
			this.fail(new Error(`Authorization failed: ${error}`));
			return;
		}
		const code = url.searchParams.get("code");
		const state = url.searchParams.get("state");
		if (!code) {
			finish(400, "Invalid callback", "Missing authorization code");
			this.fail(new Error("OAuth callback missing authorization code"));
			return;
		}
		if (state !== this.expectedState) {
			finish(400, "Invalid state", "CSRF state mismatch");
			this.fail(new Error("OAuth callback state mismatch"));
			return;
		}
		finish(200, "Authorized", "Authorization complete.");
		const resolve = this.resolvePending;
		this.stop();
		resolve?.(url);
	}

	private fail(error: Error): void {
		const reject = this.rejectPending;
		this.stop();
		reject?.(error);
	}

	private stop(): void {
		clearTimeout(this.timer);
		this.timer = undefined;
		this.pending = undefined;
		this.resolvePending = undefined;
		this.rejectPending = undefined;
		this.expectedState = undefined;
		if (this.server) {
			this.server.close();
			this.server = undefined;
		}
	}
}

export interface OmegaOAuthProviderConfig {
	serverName: string;
	serverUrl: string;
	clientId?: string;
	clientSecret?: string;
	scope?: string;
	store: OmegaOAuthStore;
}

/**
 * `OAuthClientProvider` implementation backed by {@link OmegaOAuthStore}. One
 * instance per server: transient flow state (redirect URL, code verifier) is
 * flow-local; durable state (client registration, tokens, discovery) persists
 * through the store.
 */
export class OmegaOAuthProvider implements OAuthClientProvider {
	private readonly config: OmegaOAuthProviderConfig;
	private flowRedirectUrl: URL | undefined;
	private flowCodeVerifier: string | undefined;

	constructor(config: OmegaOAuthProviderConfig) {
		this.config = config;
	}

	/** Called by the transport; the interactive flow sets it via beginFlow(). */
	get redirectUrl(): URL | undefined {
		return this.flowRedirectUrl;
	}

	get clientMetadata(): OAuthClientMetadata {
		return {
			client_name: "Omega MCP Client",
			...(this.config.scope ? { scope: this.config.scope } : {}),
			redirect_uris: [],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: this.config.clientSecret ? "client_secret_basic" : "none",
		};
	}

	state(): Promise<string> {
		return Promise.resolve(randomBytes(16).toString("hex"));
	}

	private async stored(): Promise<StoredServerEntry | undefined> {
		return this.config.store.loadServer(this.config.serverName, this.config.serverUrl);
	}

	async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
		const stored = await this.stored();
		if (stored?.clientInformation) return stored.clientInformation;
		if (this.config.clientId) {
			return {
				client_id: this.config.clientId,
				...(this.config.clientSecret ? { client_secret: this.config.clientSecret } : {}),
			};
		}
		return undefined;
	}

	async saveClientInformation(clientInformation: OAuthClientInformationFull): Promise<void> {
		const stored = (await this.stored()) ?? { serverUrl: this.config.serverUrl };
		await this.config.store.saveServer(this.config.serverName, { ...stored, clientInformation });
	}

	async tokens(): Promise<OAuthTokens | undefined> {
		const stored = await this.stored();
		return stored?.tokens;
	}

	async saveTokens(tokens: OAuthTokens): Promise<void> {
		const stored = (await this.stored()) ?? { serverUrl: this.config.serverUrl };
		await this.config.store.saveServer(this.config.serverName, { ...stored, tokens });
	}

	async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
		throw new AuthorizationRequiredError(authorizationUrl);
	}

	async saveCodeVerifier(codeVerifier: string): Promise<void> {
		this.flowCodeVerifier = codeVerifier;
	}

	async codeVerifier(): Promise<string> {
		if (!this.flowCodeVerifier) throw new Error("No OAuth code verifier in flight");
		return this.flowCodeVerifier;
	}

	async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
		const stored = await this.stored();
		return stored?.discoveryState;
	}

	async saveDiscoveryState(discoveryState: OAuthDiscoveryState): Promise<void> {
		const stored = (await this.stored()) ?? { serverUrl: this.config.serverUrl };
		await this.config.store.saveServer(this.config.serverName, { ...stored, discoveryState });
	}

	async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
		if (scope === "verifier") {
			this.flowCodeVerifier = undefined;
			return;
		}
		if (scope === "all") {
			await this.config.store.clearServer(this.config.serverName);
			this.flowCodeVerifier = undefined;
			return;
		}
		const stored = await this.stored();
		if (!stored) return;
		if (scope === "tokens")
			await this.config.store.saveServer(this.config.serverName, { ...stored, tokens: undefined });
		else if (scope === "client") {
			await this.config.store.saveServer(this.config.serverName, { ...stored, clientInformation: undefined });
		} else if (scope === "discovery") {
			await this.config.store.saveServer(this.config.serverName, { ...stored, discoveryState: undefined });
		}
	}

	beginFlow(redirectUrl: URL): void {
		this.flowRedirectUrl = redirectUrl;
	}

	endFlow(): void {
		this.flowRedirectUrl = undefined;
		this.flowCodeVerifier = undefined;
	}
}

/**
 * Thrown by {@link OmegaOAuthProvider.redirectToAuthorization} so the caller
 * can surface the authorization URL instead of navigating a browser itself.
 */
export class AuthorizationRequiredError extends Error {
	readonly authorizationUrl: URL;

	constructor(authorizationUrl: URL) {
		super(`OAuth authorization required: ${authorizationUrl.toString()}`);
		this.name = "AuthorizationRequiredError";
		this.authorizationUrl = authorizationUrl;
	}
}
