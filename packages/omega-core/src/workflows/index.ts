import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { OmegaAPI } from "../api.ts";
import { registerOmegaCommand } from "../commands/register.ts";
import {
	renderWorkflowMessage,
	renderWorkflowResult,
	WORKFLOW_MESSAGE_TYPE,
	type WorkflowDisplayDetails,
} from "./display.ts";
import { parseWorkflowScript } from "./parser.ts";
import type { WorkflowDefinition, WorkflowRegistry } from "./registry.ts";
import { type WorkflowExecutionStatus, WorkflowService } from "./service.ts";
import { WorkflowStatusView } from "./status-view.ts";
import { registerSubagentStructuredOutput } from "./structured-output.ts";

const WORKFLOW_STATUS_KEY = "omega.workflow";
const SUBAGENT_STATUS_KEY = "omega.subagents";

export interface RegisterWorkflowsOptions {
	userWorkflowsDirectory?: string;
}

const WorkflowParams = Type.Object({
	script: Type.Optional(Type.String({ description: "Raw deterministic JavaScript workflow script" })),
	name: Type.Optional(Type.String({ description: "Registered workflow name" })),
	args: Type.Optional(Type.Unknown({ description: "JSON-compatible workflow input" })),
	concurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 16 })),
	maxAgents: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
	tokenBudget: Type.Optional(Type.Integer({ minimum: 1 })),
});

const COMMAND_HELP = [
	"/workflows run <prompt>                 根据提示词生成并运行工作流",
	"/workflows run-template <name|id> [JSON args]  运行指定工作流模板",
	"/workflows list                         列出工作流模板",
	"/workflows status                       显示活动和最近一次运行状态",
	"/workflows validate <name|file.js>      解析并校验模板，不执行",
	"/workflows show <name|id>               展示模板内容，不执行",
	"/workflows reload                       重新发现工作流模板",
].join("\n");

const COMMAND_CHOICES = [
	{ action: "run", label: "run — 根据提示生成并运行", description: "动态生成、校验并执行工作流" },
	{
		action: "run-template",
		label: "run-template — 运行工作流模板",
		description: "运行已注册工作流，可继续选择模板",
	},
	{ action: "list", label: "list — 列出工作流模板", description: "列出名称、来源和描述" },
	{ action: "status", label: "status — 查看运行状态", description: "查看活动运行和最近一次结果" },
	{ action: "validate", label: "validate — 校验工作流模板", description: "解析和校验，不执行" },
	{ action: "show", label: "show — 查看工作流模板", description: "展示模板源码，不执行" },
	{ action: "reload", label: "reload — 重新发现模板", description: "刷新用户和项目工作流缓存" },
] as const;

interface WorkflowArgumentCompletion {
	value: string;
	label: string;
	description?: string;
}

function resultText(value: unknown): string {
	if (value === undefined) return "(no result)";
	return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function splitFirst(value: string): { first: string; rest: string } {
	const trimmed = value.trim();
	if (!trimmed) return { first: "", rest: "" };
	const separator = trimmed.search(/\s/u);
	return separator < 0
		? { first: trimmed, rest: "" }
		: { first: trimmed.slice(0, separator), rest: trimmed.slice(separator).trim() };
}

function completeWorkflowArguments(
	argumentPrefix: string,
	definitions: readonly WorkflowDefinition[],
): WorkflowArgumentCompletion[] | null {
	const prefix = argumentPrefix.trimStart();
	if (!prefix.includes(" ")) {
		const matches = COMMAND_CHOICES.filter((choice) => choice.action.startsWith(prefix)).map((choice) => ({
			value: ["run", "run-template", "show", "validate"].includes(choice.action)
				? `${choice.action} `
				: choice.action,
			label: choice.action,
			description: choice.description,
		}));
		return matches.length > 0 ? matches : null;
	}

	const match = /^(run-template|show|validate)\s+(\S*)$/u.exec(prefix);
	if (!match) return null;
	const action = match[1];
	const namePrefix = match[2] ?? "";
	const matches = definitions
		.filter((definition) => definition.name.startsWith(namePrefix))
		.sort((left, right) => left.name.localeCompare(right.name))
		.map((definition) => ({
			value: `${action} ${definition.name}${action === "run-template" ? " " : ""}`,
			label: definition.name,
			description: `[${definition.source}] ${definition.description}`,
		}));
	return matches.length > 0 ? matches : null;
}

function formatDefinition(definition: WorkflowDefinition): string {
	const location = definition.filePath ? ` · ${definition.filePath}` : "";
	return `${definition.name} [${definition.source}]${location} — ${definition.description}`;
}

function formatWorkflowChoice(definition: WorkflowDefinition): string {
	return `${definition.name} [${definition.source}] — ${definition.description}`;
}

function formatRegistry(registry: WorkflowRegistry): string {
	const definitions = [...registry.definitions.values()].sort((left, right) => left.name.localeCompare(right.name));
	return definitions.length > 0 ? definitions.map(formatWorkflowChoice).join("\n") : "未发现 workflow 模板。";
}

function formatRunStatus(status: WorkflowExecutionStatus): string {
	const identifier = status.runId ?? status.id;
	const elapsed = (status.finishedAt ?? Date.now()) - status.startedAt;
	return [
		`${status.name} [${status.state}]`,
		`ID: ${identifier}`,
		`阶段: ${status.phase ?? "未设置"}`,
		`节点: ${status.completedNodes} 已完成 / ${status.runningNodes} 运行中`,
		`Agent: ${status.agentCount ?? "-"} · Task: ${status.taskCount ?? "-"}`,
		`耗时: ${elapsed}ms`,
		...(status.error ? [`错误: ${status.error}`] : []),
	].join("\n");
}

function updateWorkflowFooter(ctx: ExtensionContext, status: WorkflowExecutionStatus | undefined): void {
	if (!status || status.state !== "running") {
		ctx.ui.setStatus(WORKFLOW_STATUS_KEY, undefined);
		ctx.ui.setStatus(SUBAGENT_STATUS_KEY, undefined);
		return;
	}
	ctx.ui.setStatus(
		WORKFLOW_STATUS_KEY,
		ctx.ui.theme.fg(
			"accent",
			` workflow ${status.name} · ${status.completedNodes}/${status.nodes.length} done · ${status.runningNodes} running `,
		),
	);
	const runningAgents = status.nodes.filter((node) => node.kind === "agent" && node.state === "running");
	ctx.ui.setStatus(
		SUBAGENT_STATUS_KEY,
		runningAgents.length > 0
			? ctx.ui.theme.fg(
					"warning",
					` subagents ${runningAgents.length} running · ${runningAgents.map((node) => node.label).join(", ")} `,
				)
			: undefined,
	);
}

async function showWorkflowStatusPanel(ctx: ExtensionCommandContext, service: WorkflowService): Promise<void> {
	if (!ctx.hasUI) {
		const snapshot = service.getStatus();
		const runs = [...snapshot.active, ...(snapshot.last ? [snapshot.last] : [])];
		ctx.ui.notify(runs.map(formatRunStatus).join("\n\n") || "当前没有 workflow 运行记录。", "info");
		return;
	}
	await ctx.ui.custom<void>(
		(tui, theme, keybindings, done) => new WorkflowStatusView(service, tui, theme, keybindings, () => done()),
		{
			overlay: true,
			overlayOptions: {
				anchor: "center",
				width: "92%",
				minWidth: 64,
				maxHeight: "75%",
				margin: 1,
			},
		},
	);
}

function parentModel(ctx: ExtensionCommandContext): { provider: string; id: string } | undefined {
	return ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;
}

function resolveValidationTarget(
	target: string,
	registry: WorkflowRegistry,
	cwd: string,
): { script: string; source: string } {
	const definition = registry.definitions.get(target);
	if (definition) return { script: definition.script, source: formatDefinition(definition) };
	const filePath = path.resolve(cwd, target);
	const stat = fs.statSync(filePath);
	if (!stat.isFile()) throw new Error(`Workflow validation target is not a file: ${filePath}`);
	return { script: fs.readFileSync(filePath, "utf8"), source: filePath };
}

async function selectWorkflowName(
	action: "run-template" | "show" | "validate",
	ctx: ExtensionCommandContext,
	registry: WorkflowRegistry,
): Promise<string | undefined> {
	if (!ctx.hasUI) return undefined;
	const definitions = [...registry.definitions.values()].sort((left, right) => left.name.localeCompare(right.name));
	const choices = definitions.map(formatWorkflowChoice);
	const selected = await ctx.ui.select(`Workflows · ${action}`, choices);
	if (!selected) return undefined;
	return definitions[choices.indexOf(selected)]?.name;
}

async function handleWorkflowsCommand(
	args: string,
	ctx: ExtensionCommandContext,
	service: WorkflowService,
	onCompleted?: (status: WorkflowExecutionStatus) => void,
): Promise<void> {
	const { first: action, rest } = splitFirst(args);
	const includeProjectWorkflows = ctx.isProjectTrusted();
	if (!action) {
		await showWorkflowStatusPanel(ctx, service);
		return;
	}

	switch (action.toLowerCase()) {
		case "list": {
			if (rest) throw new Error("Usage: /workflows list");
			ctx.ui.notify(formatRegistry(service.getRegistry(ctx.cwd, includeProjectWorkflows)), "info");
			return;
		}
		case "reload": {
			if (rest) throw new Error("Usage: /workflows reload");
			const registry = service.reload(ctx.cwd, includeProjectWorkflows);
			ctx.ui.notify(`Workflows 已重新加载。\n${formatRegistry(registry)}`, "info");
			return;
		}
		case "status": {
			if (rest) throw new Error("Usage: /workflows status");
			const status = service.getStatus();
			const sections = status.active.map((run) => `活动运行\n${formatRunStatus(run)}`);
			if (status.last) sections.push(`最近运行\n${formatRunStatus(status.last)}`);
			ctx.ui.notify(sections.join("\n\n") || "当前没有 workflow 运行记录。", "info");
			return;
		}
		case "show": {
			const registry = service.getRegistry(ctx.cwd, includeProjectWorkflows);
			const name = rest.trim() || (await selectWorkflowName("show", ctx, registry));
			if (!name) {
				if (!ctx.hasUI) throw new Error("Usage: /workflows show <name|id>");
				return;
			}
			const definition = registry.definitions.get(name);
			if (!definition) throw new Error(`Unknown workflow: ${name}.`);
			ctx.ui.notify(`${formatDefinition(definition)}\n\n${definition.script}`, "info");
			return;
		}
		case "validate": {
			const registry = service.getRegistry(ctx.cwd, includeProjectWorkflows);
			const target = rest.trim() || (await selectWorkflowName("validate", ctx, registry));
			if (!target) {
				if (!ctx.hasUI) throw new Error("Usage: /workflows validate <name|file.js>");
				return;
			}
			const selected = resolveValidationTarget(target, registry, ctx.cwd);
			const { meta } = parseWorkflowScript(selected.script);
			ctx.ui.notify(
				[
					`Workflow 模板校验通过: ${meta.name}`,
					`来源: ${selected.source}`,
					`描述: ${meta.description}`,
					`阶段: ${meta.phases?.map((phase) => phase.title).join(" -> ") || "未声明"}`,
				].join("\n"),
				"info",
			);
			return;
		}
		case "run-template": {
			let { first: name, rest: rawArguments } = splitFirst(rest);
			const registry = service.getRegistry(ctx.cwd, includeProjectWorkflows);
			if (!name) {
				name = (await selectWorkflowName("run-template", ctx, registry)) ?? "";
				rawArguments = "";
			}
			if (!name) {
				if (!ctx.hasUI) throw new Error("Usage: /workflows run-template <name|id> [JSON args]");
				return;
			}
			const definition = registry.definitions.get(name);
			if (!definition) throw new Error(`Unknown workflow: ${name}.`);
			const workflowArguments: unknown = rawArguments ? JSON.parse(rawArguments) : undefined;
			const result = await service.execute(definition.script, {
				cwd: ctx.cwd,
				includeProjectWorkflows,
				parentModel: parentModel(ctx),
				args: workflowArguments,
				signal: ctx.signal,
				onStatus: (status) => updateWorkflowFooter(ctx, status),
			});
			const completed = service.getStatus().last;
			if (completed) onCompleted?.(completed);
			if (!ctx.hasUI || !completed || !onCompleted) {
				ctx.ui.notify(`Workflow ${result.meta.name} 已完成。\n\n${resultText(result.result)}`, "info");
			}
			return;
		}
		case "run": {
			let prompt = rest.trim();
			if (!prompt && ctx.hasUI) {
				prompt = (await ctx.ui.input("Workflow prompt", "描述需要编排和执行的任务"))?.trim() ?? "";
			}
			if (!prompt) throw new Error("Usage: /workflows run <prompt>");
			ctx.ui.notify("正在根据提示词生成并校验 workflow 脚本…", "info");
			const generated = await service.generate(prompt, {
				cwd: ctx.cwd,
				includeProjectWorkflows,
				parentModel: parentModel(ctx),
				signal: ctx.signal,
			});
			ctx.ui.notify(`Workflow 脚本已生成并校验: ${generated.meta.name}（生成 ${generated.attempts} 次）`, "info");
			const result = await service.execute(generated.script, {
				cwd: ctx.cwd,
				includeProjectWorkflows,
				parentModel: parentModel(ctx),
				args: { prompt },
				signal: ctx.signal,
				onStatus: (status) => updateWorkflowFooter(ctx, status),
			});
			const completed = service.getStatus().last;
			if (completed) onCompleted?.(completed);
			if (!ctx.hasUI || !completed || !onCompleted) {
				ctx.ui.notify(`Workflow ${result.meta.name} 已完成。\n\n${resultText(result.result)}`, "info");
			}
			return;
		}
		default:
			throw new Error(`Unknown workflows command: ${action}.\n\n${COMMAND_HELP}`);
	}
}

export function registerWorkflows(omega: OmegaAPI, options: RegisterWorkflowsOptions = {}): void {
	registerSubagentStructuredOutput(omega);
	const service = new WorkflowService({ userWorkflowsDirectory: options.userWorkflowsDirectory });
	let completionContext: { cwd: string; includeProjectWorkflows: boolean } | undefined;
	const rememberContext = (ctx: ExtensionCommandContext) => {
		completionContext = { cwd: ctx.cwd, includeProjectWorkflows: ctx.isProjectTrusted() };
	};
	omega.on("session_start", (_event, ctx) => {
		completionContext = { cwd: ctx.cwd, includeProjectWorkflows: ctx.isProjectTrusted() };
	});
	omega.on("session_shutdown", (_event, ctx) => updateWorkflowFooter(ctx, undefined));

	omega.registerMessageRenderer<WorkflowDisplayDetails>(WORKFLOW_MESSAGE_TYPE, (message, renderOptions, theme) =>
		renderWorkflowMessage(message.details, renderOptions.expanded, theme),
	);

	const publishCompleted = (status: WorkflowExecutionStatus) => {
		omega.sendMessage(
			{
				customType: WORKFLOW_MESSAGE_TYPE,
				content: `Workflow ${status.name} ${status.state}.${status.result === undefined ? "" : `\n\nResult:\n${resultText(status.result)}`}`,
				display: true,
				details: { kind: "omega-workflow", status } satisfies WorkflowDisplayDetails,
			},
			{ triggerTurn: false },
		);
	};

	registerOmegaCommand(omega, "workflows", {
		description: "查看状态，或运行、列出、校验和管理 Omega workflows",
		getArgumentCompletions: (prefix) => {
			const context = completionContext;
			const definitions = context
				? [...service.getRegistry(context.cwd, context.includeProjectWorkflows).definitions.values()]
				: [];
			return completeWorkflowArguments(prefix, definitions);
		},
		handler: async (args, ctx) => {
			try {
				rememberContext(ctx);
				await handleWorkflowsCommand(args, ctx, service, publishCompleted);
			} catch (error) {
				ctx.ui.notify(`Workflows 命令失败：${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	omega.registerTool({
		name: "workflow",
		label: "Workflow",
		description:
			"Run a deterministic security workflow. Supply exactly one of script or name. Available DSL globals: agent, task, workflow, parallel, pipeline, phase, verify, executeAndVerify, log, args, cwd, process.cwd(), and budget.",
		promptSnippet: "Orchestrate multi-step security work with independent verification",
		promptGuidelines: [
			"Use workflow for multi-step, parallel, or executor-verifier security work; use ordinary tools for a single simple operation.",
			"Workflow scripts must start with export const meta = { name, description } and contain plain JavaScript, not Markdown fences.",
			"Use agentType to select a named Omega subagent. Use executeAndVerify when one agent performs a security test and another independently validates it.",
			"Use JSON Schema in agent options for machine-readable findings.",
			"Workflow scripts cannot import modules or directly access the filesystem or network.",
		],
		parameters: WorkflowParams,
		renderCall: (params, theme) =>
			new Text(
				theme.fg("toolTitle", theme.bold("workflow ")) +
					theme.fg("accent", params.name ?? (params.script ? "dynamic script" : "preparing")),
				0,
				0,
			),
		renderResult: (toolResult, { expanded }, theme) =>
			renderWorkflowResult(toolResult.details as WorkflowDisplayDetails | undefined, expanded, theme),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const hasScript = params.script !== undefined;
			const hasName = params.name !== undefined;
			if (hasScript === hasName) throw new Error("Provide exactly one of script or name.");

			const includeProjectWorkflows = ctx.isProjectTrusted();
			completionContext = { cwd: ctx.cwd, includeProjectWorkflows };
			const registry = service.getRegistry(ctx.cwd, includeProjectWorkflows);
			const selected = params.name ? registry.definitions.get(params.name) : undefined;
			if (params.name && !selected) {
				throw new Error(
					`Unknown workflow "${params.name}". Available: ${[...registry.definitions.keys()].join(", ")}.`,
				);
			}
			const script = params.script ?? selected!.script;
			const result = await service.execute(script, {
				cwd: ctx.cwd,
				includeProjectWorkflows,
				parentModel: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
				args: params.args,
				concurrency: params.concurrency,
				maxAgents: params.maxAgents,
				tokenBudget: params.tokenBudget,
				signal,
				onStatus: (status) => {
					updateWorkflowFooter(ctx, status);
					onUpdate?.({
						content: [
							{
								type: "text",
								text: `Workflow ${status.name}: ${status.completedNodes} completed, ${status.runningNodes} running${status.phase ? ` · ${status.phase}` : ""}`,
							},
						],
						details: { kind: "omega-workflow", status } satisfies WorkflowDisplayDetails,
					});
				},
			});
			return {
				content: [
					{
						type: "text" as const,
						text: `Workflow ${result.meta.name} completed with ${result.agentCount} agent(s) and ${result.taskCount} task(s).\n\n${resultText(result.result)}`,
					},
				],
				details: {
					kind: "omega-workflow",
					status:
						service.getStatus().last ??
						({
							id: result.runId,
							runId: result.runId,
							name: result.meta.name,
							state: "succeeded",
							runningNodes: 0,
							completedNodes: result.agentCount + result.taskCount,
							startedAt: Date.now() - result.durationMs,
							finishedAt: Date.now(),
							agentCount: result.agentCount,
							taskCount: result.taskCount,
							result: result.result,
							logs: result.logs,
							nodes: [],
						} satisfies WorkflowExecutionStatus),
				} satisfies WorkflowDisplayDetails,
			};
		},
	});
}

export { runWorkflow } from "./engine.ts";
export { generateWorkflowScript } from "./generator.ts";
export { parseWorkflowScript } from "./parser.ts";
export {
	discoverWorkflows,
	getUserWorkflowsDirectory,
	initializeUserWorkflowsDirectory,
} from "./registry.ts";
export { WorkflowService } from "./service.ts";
export { getWorkflowTaskExecutors, registerWorkflowTaskExecutor } from "./task-registry.ts";
export type * from "./types.ts";
