const DEFAULT_MCP_TIMEOUT_MS = 30_000;
const MCP_TIMEOUT_ENV = "OMEGA_MCP_TIMEOUT_MS";

export function resolveMcpTimeoutMs(configTimeout?: number, env: NodeJS.ProcessEnv = process.env): number {
	const raw = env[MCP_TIMEOUT_ENV]?.trim();
	if (raw) {
		const value = Number(raw);
		if (Number.isFinite(value) && value >= 0) return value;
	}
	return configTimeout ?? DEFAULT_MCP_TIMEOUT_MS;
}

export function mcpRequestOptions(timeout: number, signal?: AbortSignal): { timeout?: number; signal?: AbortSignal } {
	return {
		...(timeout > 0 ? { timeout } : {}),
		...(signal ? { signal } : {}),
	};
}

export function withTimeoutSignal(timeout: number, signal?: AbortSignal): AbortSignal | undefined {
	if (timeout <= 0) return signal;
	const timeoutSignal = AbortSignal.timeout(timeout);
	return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}
