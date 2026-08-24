import { describe, expect, it } from "vitest";
import { mcpRequestOptions, resolveMcpTimeoutMs } from "../src/mcp/timeout.ts";

describe("MCP timeout", () => {
	it("uses the default, config, and environment override", () => {
		expect(resolveMcpTimeoutMs(undefined, {})).toBe(30_000);
		expect(resolveMcpTimeoutMs(5_000, {})).toBe(5_000);
		expect(resolveMcpTimeoutMs(5_000, { OMEGA_MCP_TIMEOUT_MS: "1200" })).toBe(1_200);
		expect(resolveMcpTimeoutMs(5_000, { OMEGA_MCP_TIMEOUT_MS: "invalid" })).toBe(5_000);
	});

	it("allows zero to disable the SDK request timeout", () => {
		expect(mcpRequestOptions(0)).toEqual({});
		expect(mcpRequestOptions(25)).toEqual({ timeout: 25 });
	});
});
