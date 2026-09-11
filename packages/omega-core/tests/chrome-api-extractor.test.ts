import type { OmegaAPI } from "../src/api.ts";
import { describe, expect, it, vi } from "vitest";
import {
	extractApiEndpoints,
	extractApiTool,
	type ApiSource,
	type ObservedApiRequest,
} from "../src/chrome/api-extractor.ts";
import { registerChrome } from "../src/chrome/index.ts";

describe("Chrome API extraction", () => {
	it("classifies API paths and preserves request-building context", () => {
		const sources: ApiSource[] = [
			{
				kind: "script",
				url: "https://app.test/assets/app.js",
				content: [
					'fetch("/api/users?id=7", { method: "POST", body: payload });',
					"axios.patch('v1/users/{userId}', payload);",
					'const sameOrigin = "https://app.test/admin/list?page=2";',
					'const partner = "https://api.partner.test/v2/items/:itemId";',
					'const escaped = "\\/api\\/tokens";',
					'const mime = "application/json";',
					'const asset = "/assets/app.js";',
				].join("\n"),
			},
		];
		const observed: ObservedApiRequest[] = [
			{ method: "GET", source: "network", url: "https://app.test/api/users?id=7" },
		];

		const result = extractApiEndpoints(sources, "https://app.test/dashboard/index", observed, {
			contextChars: 60,
			maxResults: 20,
		});

		expect(result.absolutePaths.map((endpoint) => endpoint.value)).toEqual([
			"/api/users?id=7",
			"/admin/list?page=2",
			"/api/tokens",
		]);
		expect(result.relativePaths.map((endpoint) => endpoint.value)).toEqual(["v1/users/{userId}"]);
		expect(result.absoluteUrls.map((endpoint) => endpoint.value)).toEqual([
			"https://api.partner.test/v2/items/:itemId",
		]);

		const users = result.absolutePaths[0];
		expect(users).toMatchObject({
			line: 1,
			methodHints: ["POST", "GET"],
			occurrenceCount: 2,
			parameterHints: ["id"],
			resolvedUrl: "https://app.test/api/users?id=7",
			sourceKind: "script",
		});
		expect(users?.context).toContain("body: payload");
		expect(result.relativePaths[0]).toMatchObject({
			line: 2,
			methodHints: ["PATCH"],
			parameterHints: ["userId"],
			resolvedUrl: "https://app.test/dashboard/v1/users/%7BuserId%7D",
		});
		expect(result.absoluteUrls[0]?.parameterHints).toEqual(["itemId"]);
		expect(result.summary).toEqual({
			discovered: 5,
			matchedOccurrences: 6,
			resultLimitReached: false,
		});
	});

	it("enforces the unique result limit while still merging duplicates", () => {
		const sources: ApiSource[] = [
			{
				content: 'fetch("/api/one"); fetch("/api/two"); fetch("/api/one");',
				kind: "html",
				url: "https://app.test/",
			},
		];

		const result = extractApiEndpoints(sources, "https://app.test/", [], {
			contextChars: 40,
			maxResults: 1,
		});

		expect(result.absolutePaths).toHaveLength(1);
		expect(result.absolutePaths[0]).toMatchObject({ value: "/api/one", occurrenceCount: 2 });
		expect(result.summary).toEqual({
			discovered: 1,
			matchedOccurrences: 3,
			resultLimitReached: true,
		});
	});

	it("registers the extractor under the Chrome DevTools namespace", () => {
		expect(extractApiTool.name).toBe("chrome_devtools_extract_api");
		const registeredTools: string[] = [];
		const omega = {
			on: vi.fn(),
			registerCommand: vi.fn(),
			registerTool: (tool: { name: string }) => registeredTools.push(tool.name),
		} as unknown as OmegaAPI;

		registerChrome(omega);

		expect(registeredTools).toContain("chrome_devtools_extract_api");
	});
});
