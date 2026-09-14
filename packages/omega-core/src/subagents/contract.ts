/**
 * Parent-facing subagent tool contract.
 *
 * This module owns the wording taught to the parent agent through the tool
 * schema, tool description, and injected system prompt. Keep API semantics here
 * so those surfaces do not drift independently.
 */

import type { AgentConfig } from "./agents.ts";

export interface DelegationGuardSummary {
	currentDepth: number;
	maxDepth: number;
	preventCycles: boolean;
	ancestorAgentStack: string[];
}

interface CallFieldContract {
	name: "agent" | "prompt" | "model" | "cwd" | "initialContext" | "session" | "inactivityTimeout" | "timeout";
	required: boolean;
	schemaDescription: string;
	promptDescription: string;
}

export const CALLS_SCHEMA_DESCRIPTION =
	"One or more subagent calls. A single call and multiple parallel calls use the same shape.";

export const CALL_FIELDS: CallFieldContract[] = [
	{
		name: "agent",
		required: true,
		schemaDescription: "Name of an available agent (must match exactly)",
		promptDescription: "exact available agent name",
	},
	{
		name: "prompt",
		required: true,
		schemaDescription: "Prompt sent verbatim to the subagent for this call",
		promptDescription: "non-empty prompt sent verbatim to the subagent",
	},
	{
		name: "model",
		required: false,
		schemaDescription:
			"Model to use for this call. Overrides the agent file's default model; otherwise the parent session's current model is inherited.",
		promptDescription:
			"optional model override; defaults to the agent's configured model, else the parent session's current model",
	},
	{
		name: "cwd",
		required: false,
		schemaDescription: "Working directory for this subagent process",
		promptDescription: "working directory for this subagent process",
	},
	{
		name: "initialContext",
		required: false,
		schemaDescription:
			"Initial context for a newly-created child conversation: 'empty' (default) or 'parent'. Parent cloning is expensive and carries the parent's authority; prefer empty and pass relevant context deliberately. Existing named sessions ignore this field.",
		promptDescription:
			'"empty" (default) starts without parent history; "parent" clones the parent session snapshot, which is expensive and carries the parent conversation\'s authority; ignored by existing named sessions',
	},
	{
		name: "session",
		required: false,
		schemaDescription:
			"Optional logical handle for a persistent subagent session. Scoped by parent session, effective cwd, and agent name.",
		promptDescription:
			"durable conversation handle scoped by parent session, effective cwd, and agent name; requires a persisted parent Omega session",
	},
	{
		name: "inactivityTimeout",
		required: false,
		schemaDescription:
			"Optional positive integer inactivity timeout in seconds. Overrides the agent default. Resets only when the child emits RPC stdout activity; omitted uses the agent default, or no inactivity timeout.",
		promptDescription:
			"optional inactivity timeout in seconds; overrides the agent default and resets only on child RPC stdout activity",
	},
	{
		name: "timeout",
		required: false,
		schemaDescription:
			"Optional positive integer absolute wall-clock deadline in seconds. Independent of inactivityTimeout. Defaults to 1800 seconds; timed-out processes are terminated and release their queue slot.",
		promptDescription:
			"optional wall-clock deadline in seconds; defaults to 1800, timed-out children are terminated and release their queue slot",
	},
];

export function getCallFieldSchemaDescription(name: CallFieldContract["name"]): string {
	const field = CALL_FIELDS.find((candidate) => candidate.name === name);
	if (!field) throw new Error(`Unknown subagent call field: ${name}`);
	return field.schemaDescription;
}

function formatCallFieldList(): string {
	return CALL_FIELDS.map((field) => {
		const requirement = field.required ? "required" : "optional";
		return `- \`${field.name}\` — ${requirement}: ${field.promptDescription}.`;
	}).join("\n");
}

function formatDelegationRules(): string {
	return [
		"- Interactive tool calls run in the background. Continue parent work after launch; use `subagent_status` to read current answers and `subagent_message` to steer an active task or queue a follow-up turn. While a child runtime is open, settled answers wait there; returning to main delivers all new answers together for synthesis.",
		"- Do not use the same resolved session in more than one concurrent call. Same handle + same agent + same cwd conflicts; same handle + different agent is allowed. If a stale session lock is reported, remove the lock directory only after confirming no subagent is still running.",
		"- Use `session` for multi-turn specialist work; omit it for one-off delegation, when the parent is running with `--no-session`, or from temporary parent-seeded subagent sessions.",
		"- Agent-specific session preference and hint lines are advisory only. The tool creates or continues a persistent session only when a call includes `session`.",
		'- Prefer `initialContext: "empty"` and pass relevant task context deliberately. Parent cloning is exceptional because it is expensive and carries the parent conversation\'s authority.',
	].join("\n");
}

function formatAgentSelectionRules(): string {
	return [
		"- Read the current conversation context and the call prompt together. Infer the task domain, expected deliverable, required tools, permission boundary, and whether repository changes are needed.",
		"- Select the single most specific available agent whose description matches those requirements. Prefer a domain specialist over a generic worker; do not select an agent merely because its tools could perform the task.",
		"- Reuse a relevant project agent when it is tailored to this repository. Otherwise prefer a matching built-in agent.",
		"- If no existing agent has a clear scenario match, call `explore` first. Tell it the unmet task, relevant conversation context, available agent names/descriptions, and require it to create a reusable project agent under `.omega/agents/*.md`.",
		"- After `explore` returns a created agent name, invoke that agent in a new `subagent` tool call. A newly-created agent is discovered only by a subsequent invocation; never place its first call in the same `calls` array as `explore`.",
		"- Do not use `explore` when an existing specialist already fits, and do not create a project agent for a one-off variation that an existing agent can handle safely.",
	].join("\n");
}

export function formatSubagentUsageExample(): string {
	return `Use exactly one top-level \`calls\` array:\n\`\`\`json\n{\n  "calls": [\n    {\n      "agent": "agent-name",\n      "prompt": "Prompt sent verbatim to the subagent",\n      "model": "optional-model",\n      "initialContext": "empty",\n      "session": "optional-logical-handle"\n    }\n  ]\n}\n\`\`\``;
}

export function formatSubagentUsageErrorExample(): string {
	return `Use the current API shape:\n{\n  "calls": [\n    { "agent": "agent-name", "prompt": "Prompt sent verbatim to the subagent" }\n  ]\n}`;
}

function formatSessionPreference(preference: AgentConfig["sessionPreference"]): string {
	switch (preference) {
		case "persistent":
			return "Prefer topic-specific named persistent sessions when context should carry across related calls.";
		case "ephemeral":
			return "Prefer ephemeral calls unless the caller explicitly needs continuation.";
		case "either":
			return "Choose ephemeral or persistent sessions based on the task.";
		default:
			return "";
	}
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

export function formatAgentForPrompt(agent: AgentConfig): string {
	const lines = [`- **${agent.name}** (${agent.source}): ${agent.description}`];
	if (agent.inactivityTimeout) {
		lines.push(`  Inactivity timeout default: ${agent.inactivityTimeout}s (child RPC stdout inactivity).`);
	}
	if (agent.sessionPreference) {
		lines.push(
			`  Session preference: ${agent.sessionPreference} — ${formatSessionPreference(agent.sessionPreference)}`,
		);
	}
	if (agent.sessionHint) {
		lines.push(`  Session hint: ${oneLine(agent.sessionHint)}`);
	}
	return lines.join("\n");
}

export function formatAvailableSubagentsPrompt(agents: AgentConfig[], guards: DelegationGuardSummary): string {
	const agentList = agents.map((agent) => formatAgentForPrompt(agent)).join("\n");
	const stack = guards.ancestorAgentStack.length > 0 ? guards.ancestorAgentStack.join(" -> ") : "(root)";

	return `\n\n## Available Subagents

The following subagents are available via the \`subagent\` tool:

${agentList}

Agent source labels are informational. Project agents come from this repository and can override user agents with the same name.

### How to call the subagent tool

${formatSubagentUsageExample()}

Each call runs as a non-blocking background runtime in an isolated Omega process. Multiple calls may run concurrently.

### Agent selection

${formatAgentSelectionRules()}

Fields:
${formatCallFieldList()}

Rules:
${formatDelegationRules()}

### Runtime delegation guards

- Max depth: current depth ${guards.currentDepth}, max depth ${guards.maxDepth}
- Cycle prevention: ${guards.preventCycles ? "enabled" : "disabled"}
- Current delegation stack: ${stack}
`;
}

export function formatSubagentToolDescription(): string {
	return [
		"Launch specialized subagents as non-blocking background tasks in isolated Omega processes.",
		"Use exactly one top-level `calls` array for both one and many invocations.",
		"Each call requires `agent` and `prompt`; `prompt` is sent verbatim.",
		"Choose agents from the conversation context and prompt: use the most specific matching existing agent; if none fits, call `explore` to create a project agent, then invoke the new agent in a subsequent tool call.",
		'Prefer initialContext: "empty" and pass relevant context deliberately.',
		"",
		"Field details, selection rules, and session semantics are documented in the system prompt's Available Subagents section.",
		"Task IDs return immediately; use subagent_status to read answers and subagent_message to coordinate with active tasks.",
	].join("\n");
}
