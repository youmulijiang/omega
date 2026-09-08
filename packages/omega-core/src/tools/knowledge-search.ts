import { Type } from "@earendil-works/pi-ai";
import type { OmegaAPI } from "../api.ts";
import { searchKnowledge } from "../knowledge/index.ts";

export function registerKnowledgeSearchTool(omega: OmegaAPI): void {
	omega.registerTool({
		name: "knowledge_search",
		label: "Knowledge Search",
		description:
			"Search reusable knowledge previously saved by /study in ~/.omega/knowledge. Returns ranked Markdown files and relevant snippets.",
		parameters: Type.Object({
			query: Type.String({ description: "Keywords or concepts to search for." }),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 10 })),
		}),
		async execute(_id, params, signal) {
			signal?.throwIfAborted();
			const matches = await searchKnowledge(params.query, params.limit ?? 10);
			return {
				content: [
					{
						type: "text",
						text:
							matches.length === 0
								? "未找到匹配的知识。"
								: matches
										.map(
											(match) =>
												`## ${match.title}\n\n文件：${match.file}\n相关度：${match.score}\n\n${match.snippet}`,
										)
										.join("\n\n"),
					},
				],
				details: { query: params.query, matches },
			};
		},
	});
}
