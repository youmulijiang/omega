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
			"系统提示词（其余）",
			Math.max(
				0,
				estimateTextTokens(systemPrompt) - estimateTextTokens(contextText) - estimateTextTokens(skillsText),
			),
		],
		["项目/上下文信息", estimateTextTokens(contextText)],
		["Skill 清单", estimateTextTokens(skillsText)],
		["用户消息", 0],
		["Skill 文件响应", 0],
		["MCP 响应", 0],
		["其他工具响应", 0],
		["模型文本输出", 0],
	]);
	let branchMessageCount = 0;
	const skillReadIds = new Set<string>();
	for (const entry of branchEntries) {
		if (entry.type === "custom_message") {
			estimates.set(
				"项目/上下文信息",
				(estimates.get("项目/上下文信息") ?? 0) + estimateTextTokens(contentText(entry.content)),
			);
			continue;
		}
		if (entry.type !== "message") continue;
		branchMessageCount++;
		const message = entry.message;
		if (message.role === "user") {
			estimates.set("用户消息", (estimates.get("用户消息") ?? 0) + estimateTextTokens(contentText(message.content)));
		} else if (message.role === "toolResult") {
			const label =
				message.toolName === "mcp"
					? "MCP 响应"
					: skillReadIds.has(message.toolCallId)
						? "Skill 文件响应"
						: "其他工具响应";
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
			estimates.set("模型文本输出", (estimates.get("模型文本输出") ?? 0) + estimateTextTokens(content));
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
