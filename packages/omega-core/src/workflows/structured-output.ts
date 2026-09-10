import * as fs from "node:fs";
import { type TSchema, Type } from "typebox";
import type { OmegaAPI } from "../api.ts";
import { SUBAGENT_STRUCTURED_OUTPUT_SCHEMA_ENV } from "../subagents/protocol.ts";

function readSchema(filePath: string): TSchema | null {
	try {
		const value: unknown = JSON.parse(fs.readFileSync(filePath, "utf-8"));
		if (!value || typeof value !== "object" || Array.isArray(value)) return null;
		return value as TSchema;
	} catch (error) {
		console.warn(`[omega-workflow] Could not load structured output schema: ${String(error)}`);
		return null;
	}
}

export function registerSubagentStructuredOutput(omega: OmegaAPI): void {
	const schemaPath = process.env[SUBAGENT_STRUCTURED_OUTPUT_SCHEMA_ENV];
	if (!schemaPath) return;
	const schema = readSchema(schemaPath);
	if (!schema) return;

	omega.registerTool({
		name: "structured_output",
		label: "Structured Output",
		description: "Return the final workflow value matching the requested JSON Schema.",
		promptSnippet: "Return a validated structured value as the final action",
		promptGuidelines: [
			"When a workflow requests structured output, call structured_output as your final action.",
			"Do not emit a prose answer after calling structured_output.",
		],
		parameters: Type.Unsafe<Record<string, unknown>>(schema),
		async execute(_toolCallId, params) {
			return {
				content: [{ type: "text" as const, text: "Structured workflow output accepted." }],
				details: params,
				terminate: true,
			};
		},
	});
}
