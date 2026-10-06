import type { Usage } from "@earendil-works/pi-ai";
import type { BuildSystemPromptOptions, SessionEntry } from "@earendil-works/pi-coding-agent";

export interface CostTotals {
	calls: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
}

export interface ModelCost extends CostTotals {
	model: string;
}

export interface SourceEstimate {
	label: string;
	tokens: number;
}

export interface CostReport {
	currentModel: string | undefined;
	models: ModelCost[];
	total: CostTotals;
	unattributed: CostTotals;
	sources: SourceEstimate[];
	branchMessageCount: number;
}

function emptyTotals(): CostTotals {
	return { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
}

function addUsage(totals: CostTotals, usage: Usage): void {
	totals.calls++;
	totals.input += usage.input;
	totals.output += usage.output;
	totals.cacheRead += usage.cacheRead;
	totals.cacheWrite += usage.cacheWrite;
	totals.totalTokens += usage.totalTokens;
	totals.cost += usage.cost.total;
}

/** Text-only heuristic. These estimates are never presented as billed provider tokens. */
export function estimateTextTokens(text: string): number {
	return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}

function contentText(content: string | readonly { type: string; text?: string }[]): string {
	return typeof content === "string"
		? content
		: content
				.filter((part) => part.type === "text")
				.map((part) => part.text ?? "")
				.join("\n");
}

export function collectCostReport(
	allEntries: readonly SessionEntry[],
	branchEntries: readonly SessionEntry[],
	currentModel?: { provider: string; id: string },
	systemPrompt = "",
	promptOptions?: BuildSystemPromptOptions,
): CostReport {
	const modelMap = new Map<string, ModelCost>();
	const total = emptyTotals();
	const unattributed = emptyTotals();
	for (const entry of allEntries) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			const message = entry.message;
			const model = `${message.provider}/${message.model}`;
			let row = modelMap.get(model);
			if (!row) {
				row = { model, ...emptyTotals() };
				modelMap.set(model, row);
			}
			addUsage(row, message.usage);
			addUsage(total, message.usage);
		} else {
			const usage =
				entry.type === "message" && entry.message.role === "toolResult"
					? entry.message.usage
					: entry.type === "compaction" || entry.type === "branch_summary"
						? entry.usage
						: undefined;
			if (usage) {
				addUsage(unattributed, usage);
				addUsage(total, usage);
			}
		}
	}

	const current = currentModel ? `${currentModel.provider}/${currentModel.id}` : undefined;
	if (current && !modelMap.has(current)) modelMap.set(current, { model: current, ...emptyTotals() });
	const models = [...modelMap.values()].sort((a, b) => b.cost - a.cost || b.totalTokens - a.totalTokens);

	const contextText = promptOptions?.contextFiles?.map((file) => `${file.path}\n${file.content}`).join("\n") ?? "";
	const skillsText =
		promptOptions?.skills
			?.filter((skill) => !skill.disableModelInvocation)
			.map((skill) => `${skill.name}\n${skill.description}\n${skill.filePath}`)
			.join("\n") ?? "";
	const estimates = new Map<string, number>([
		[
			"System prompt (rest)",
			Math.max(
				0,
				estimateTextTokens(systemPrompt) - estimateTextTokens(contextText) - estimateTextTokens(skillsText),
			),
		],
		["Project/context info", estimateTextTokens(contextText)],
		["Skill list", estimateTextTokens(skillsText)],
		["User messages", 0],
		["Skill file responses", 0],
		["MCP responses", 0],
		["Other tool responses", 0],
		["Model text output", 0],
	]);
	let branchMessageCount = 0;
	const skillReadIds = new Set<string>();
	for (const entry of branchEntries) {
		if (entry.type === "custom_message") {
			estimates.set(
				"Project/context info",
				(estimates.get("Project/context info") ?? 0) + estimateTextTokens(contentText(entry.content)),
			);
			continue;
		}
		if (entry.type !== "message") continue;
		branchMessageCount++;
		const message = entry.message;
		if (message.role === "user") {
			estimates.set(
				"User messages",
				(estimates.get("User messages") ?? 0) + estimateTextTokens(contentText(message.content)),
			);
		} else if (message.role === "toolResult") {
			const label =
				message.toolName === "mcp"
					? "MCP responses"
					: skillReadIds.has(message.toolCallId)
						? "Skill file responses"
						: "Other tool responses";
			estimates.set(label, (estimates.get(label) ?? 0) + estimateTextTokens(contentText(message.content)));
		} else if (message.role === "assistant") {
			for (const part of message.content) {
				if (part.type !== "toolCall" || part.name !== "read") continue;
				const path = part.arguments.path ?? part.arguments.file_path;
				if (typeof path === "string" && /(?:^|[\\/])SKILL\.md$/iu.test(path)) skillReadIds.add(part.id);
			}
			const content = message.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n");
			estimates.set("Model text output", (estimates.get("Model text output") ?? 0) + estimateTextTokens(content));
		}
	}
	return {
		currentModel: current,
		models,
		total,
		unattributed,
		sources: [...estimates].map(([label, tokens]) => ({ label, tokens })),
		branchMessageCount,
	};
}
