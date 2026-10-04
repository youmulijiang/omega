import type { Model } from "../src/types.ts";

// Keep protocol regressions for this delisted model independent of live catalog updates.
export const OPENCODE_GO_KIMI_K26_MODEL: Model<"openai-completions"> = {
	id: "kimi-k2.6",
	name: "Kimi K2.6",
	api: "openai-completions",
	provider: "opencode-go",
	baseUrl: "https://opencode.ai/zen/go/v1",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0.95, output: 4, cacheRead: 0.16, cacheWrite: 0 },
	contextWindow: 262144,
	maxTokens: 65536,
	thinkingLevelMap: { minimal: null, low: null, medium: null },
	compat: {
		supportsStore: false,
		supportsDeveloperRole: false,
		supportsReasoningEffort: false,
		maxTokensField: "max_tokens",
		thinkingFormat: "deepseek",
		supportsLongCacheRetention: false,
	},
};
