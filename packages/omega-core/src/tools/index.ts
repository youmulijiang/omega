import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { OmegaAPI } from "../api.ts";
import { diffText, formatTextDiff } from "./diff.ts";
import { replayHttp, requestHttp } from "./http.ts";
import { registerKnowledgeSearchTool } from "./knowledge-search.ts";

export type { TextChange, TextDiff } from "./diff.ts";
export { diffText, formatTextDiff } from "./diff.ts";
export type { HttpReplayInput, HttpRequestInput, HttpResponse } from "./http.ts";
export { parseHttpReplay, replayHttp, requestHttp } from "./http.ts";

const httpProperties = {
	url: Type.String({ description: "Full destination URL, including path and query. HTTP or HTTPS only." }),
	method: Type.Optional(Type.String({ description: "Method; defaults to GET, or the captured method for replay." })),
	headers: Type.Optional(Type.Record(Type.String(), Type.Union([Type.String(), Type.Array(Type.String())]))),
	body: Type.Optional(Type.String({ description: "Request body; overrides the captured body for replay." })),
	bodyEncoding: Type.Optional(StringEnum(["utf8", "base64"] as const)),
	responseEncoding: Type.Optional(StringEnum(["utf8", "base64"] as const)),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 300_000 })),
	maxResponseBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_485_760 })),
};

export function registerTools(omega: OmegaAPI): void {
	registerKnowledgeSearchTool(omega);
	omega.registerTool({
		name: "http_request",
		label: "HTTP Request",
		description:
			"Send one HTTP/HTTPS request. Returns status, duplicate response headers, body and timing. No redirects, retries or shared cookies. TLS certificates are verified. Response bytes are not decompressed; use base64 for binary data. Defaults: 30s timeout, 256 KiB response limit. Content-Length is recalculated.",
		parameters: Type.Object(httpProperties),
		async execute(_id, params, signal) {
			const result = await requestHttp(params, signal);
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
		},
	});
	omega.registerTool({
		name: "http_replay",
		label: "HTTP Replay",
		description:
			"Replay a captured HTTP/1.x request against the explicit full url (replaces captured path, query and Host). Preserves method, headers and UTF-8 body unless overridden. Recalculates Content-Length. Not byte-exact replay: folded headers and chunked request bodies are rejected. No redirects or retries. Same response format and limits as http_request.",
		parameters: Type.Object({
			...httpProperties,
			rawRequest: Type.String({ description: "HTTP/1.x request line, headers, blank line, and optional body." }),
		}),
		async execute(_id, params, signal) {
			const result = await replayHttp(params, signal);
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
		},
	});
	omega.registerTool({
		name: "diff",
		label: "Text Diff",
		description:
			"Compare before and after text line by line, including newline differences. Returns added/removed counts and changes with line numbers. Inputs limited to 1 MiB each. Large comparisons may produce a coarse but exact replacement of the differing middle. Output preview is limited to 24000 characters; details contain the complete changes.",
		parameters: Type.Object({ before: Type.String(), after: Type.String() }),
		async execute(_id, params, signal) {
			signal?.throwIfAborted();
			const result = diffText(params.before, params.after);
			return {
				content: [{ type: "text", text: formatTextDiff(result) }],
				details: result,
			};
		},
	});
}
