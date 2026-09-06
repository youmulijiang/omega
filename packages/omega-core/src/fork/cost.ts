import type { UsageStats } from "./types.ts";

export interface InclusiveCostStats {
	main: UsageStats;
	forks: UsageStats;
	total: UsageStats;
	forkResults: number;
}

function emptyStats(): UsageStats {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		contextTokens: 0,
		turns: 0,
	};
}

function finiteNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function addUsageStats(target: UsageStats, usage: unknown): boolean {
	if (!usage || typeof usage !== "object") return false;

	const raw = usage as Record<string, unknown>;
	const cost =
		typeof raw.cost === "object" && raw.cost !== null
			? finiteNumber((raw.cost as Record<string, unknown>).total)
			: finiteNumber(raw.cost);

	const input = finiteNumber(raw.input);
	const output = finiteNumber(raw.output);
	const cacheRead = finiteNumber(raw.cacheRead);
	const cacheWrite = finiteNumber(raw.cacheWrite);
	const turns = finiteNumber(raw.turns);
	const contextTokens = finiteNumber(raw.contextTokens) || finiteNumber(raw.totalTokens);

	const changed = input || output || cacheRead || cacheWrite || cost || turns || contextTokens;
	if (!changed) return false;

	target.input += input;
	target.output += output;
	target.cacheRead += cacheRead;
	target.cacheWrite += cacheWrite;
	target.cost += cost;
	target.turns += turns;
	target.contextTokens = Math.max(target.contextTokens, contextTokens);
	return true;
}

function addTotals(total: UsageStats, usage: UsageStats): void {
	total.input += usage.input;
	total.output += usage.output;
	total.cacheRead += usage.cacheRead;
	total.cacheWrite += usage.cacheWrite;
	total.cost += usage.cost;
	total.turns += usage.turns;
	total.contextTokens = Math.max(total.contextTokens, usage.contextTokens);
}

function getMessage(entry: unknown): Record<string, unknown> | undefined {
	if (!entry || typeof entry !== "object") return undefined;
	const rawEntry = entry as Record<string, unknown>;
	if (rawEntry.type !== "message") return undefined;
	const message = rawEntry.message;
	return message && typeof message === "object" ? (message as Record<string, unknown>) : undefined;
}

function getForkResults(message: Record<string, unknown>): unknown[] {
	const isToolResult = message.role === "toolResult" && message.toolName === "fork";
	const isCommandResult = message.role === "custom" && message.customType === "omega-fork-result";
	if (!isToolResult && !isCommandResult) return [];
	const details = message.details;
	if (!details || typeof details !== "object") return [];
	const results = (details as Record<string, unknown>).results;
	return Array.isArray(results) ? results : [];
}

export function aggregateInclusiveCost(entries: unknown[]): InclusiveCostStats {
	const stats: InclusiveCostStats = {
		main: emptyStats(),
		forks: emptyStats(),
		total: emptyStats(),
		forkResults: 0,
	};

	for (const entry of entries) {
		const message = getMessage(entry);
		if (!message) continue;

		if (message.role === "assistant") {
			addUsageStats(stats.main, message.usage);
			continue;
		}

		for (const result of getForkResults(message)) {
			if (!result || typeof result !== "object") continue;
			if (addUsageStats(stats.forks, (result as Record<string, unknown>).usage)) {
				stats.forkResults++;
			}
		}
	}

	addTotals(stats.total, stats.main);
	addTotals(stats.total, stats.forks);
	return stats;
}

export function formatForkCostStatus(stats: InclusiveCostStats): string | undefined {
	if (stats.forks.cost <= 0) return undefined;
	return `forks +$${stats.forks.cost.toFixed(3)}`;
}
