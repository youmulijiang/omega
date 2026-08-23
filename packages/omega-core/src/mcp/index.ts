import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import { registerOmegaCommand } from "../commands/register.ts";
import {
	getProjectMcpConfigPath,
	parseMcpConfig,
	readProjectMcpConfig,
	updateProjectServer,
	writeProjectMcpConfig,
} from "./native-config.ts";
import { OmegaMcpManager } from "./native-manager.ts";
import type { McpHttpServer, McpServerState, McpStdioServer } from "./native-types.ts";

type McpAction = "status" | "list_tools" | "call" | "reconnect";

function statusText(states: McpServerState[]): string {
	if (states.length === 0) return "No MCP servers configured. Run /mcp to add one.";
	return states
		.map((state) => {
			const detail = state.status === "connected" ? `${state.tools.length} tools` : state.error;
			return `- ${state.name}: ${state.status}${detail ? ` (${detail})` : ""}`;
		})
		.join("\n");
}

function contentToText(content: ContentBlock): string {
	if (content.type === "text") return content.text;
	if (content.type === "image") return `[image: ${content.mimeType}, ${content.data.length} base64 chars]`;
	if (content.type === "audio") return `[audio: ${content.mimeType}, ${content.data.length} base64 chars]`;
	if (content.type === "resource_link") return `[resource: ${content.name} (${content.uri})]`;
	if (content.type === "resource")
		return "text" in content.resource ? content.resource.text : `[binary resource: ${content.resource.uri}]`;
	return JSON.stringify(content);
}

function parseJsonObject(raw: string | undefined): Record<string, unknown> {
	if (!raw?.trim()) return {};
	const parsed: unknown = JSON.parse(raw);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("MCP arguments must be a JSON object");
	}
	return parsed as Record<string, unknown>;
}

async function addHttpServer(ctx: ExtensionCommandContext, manager: OmegaMcpManager): Promise<void> {
	const name = (await ctx.ui.input("MCP server name"))?.trim();
	if (!name) return;
	const url = (await ctx.ui.input("Streamable HTTP URL", "https://example.com/mcp"))?.trim();
	if (!url) return;
	new URL(url);
	const headerText = await ctx.ui.editor("HTTP headers as JSON (optional)", "{}");
	if (headerText === undefined) return;
	const headers = parseJsonObject(headerText);
	if (!Object.values(headers).every((value) => typeof value === "string"))
		throw new Error("HTTP header values must be strings");
	const server: McpHttpServer = { type: "http", url, headers: headers as Record<string, string> };
	updateProjectServer(ctx.cwd, name, server);
	await manager.reload();
	ctx.ui.notify(`Saved MCP server "${name}" to ${getProjectMcpConfigPath(ctx.cwd)}`, "info");
}

async function addStdioServer(ctx: ExtensionCommandContext, manager: OmegaMcpManager): Promise<void> {
	const name = (await ctx.ui.input("MCP server name"))?.trim();
	if (!name) return;
	const command = (await ctx.ui.input("Command", "npx"))?.trim();
	if (!command) return;
	const argsText = await ctx.ui.editor("Command arguments as JSON", "[]");
	if (argsText === undefined) return;
	const parsed: unknown = JSON.parse(argsText);
	if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) {
		throw new Error("Command arguments must be a JSON string array");
	}
	const server: McpStdioServer = { type: "stdio", command, args: parsed };
	updateProjectServer(ctx.cwd, name, server);
	await manager.reload();
	ctx.ui.notify(`Saved MCP server "${name}" to ${getProjectMcpConfigPath(ctx.cwd)}`, "info");
}

async function manageServer(ctx: ExtensionCommandContext, manager: OmegaMcpManager): Promise<void> {
	const states = manager.getStates();
	if (states.length === 0) {
		ctx.ui.notify("No MCP servers configured", "warning");
		return;
	}
	const selected = await ctx.ui.select(
		"Select MCP server",
		states.map((state) => `${state.name} — ${state.status}`),
	);
	if (!selected) return;
	const name = selected.split(" — ", 1)[0];
	const state = manager.getState(name);
	if (!state) return;
	const action = await ctx.ui.select(`MCP: ${name}`, [
		"Show tools",
		"Reconnect",
		state.status === "disabled" ? "Enable" : "Disable",
		"Remove",
	]);
	if (action === "Show tools") {
		const tools = manager.listTools(name);
		ctx.ui.notify(
			tools.length
				? tools.map((item) => `${item.tool.name}: ${item.tool.description ?? ""}`).join("\n")
				: "No tools available",
			"info",
		);
	} else if (action === "Reconnect") {
		await manager.reconnect(name);
		ctx.ui.notify(`Reconnected ${name}`, "info");
	} else if (action === "Enable" || action === "Disable") {
		updateProjectServer(ctx.cwd, name, { ...state.config, disabled: action === "Disable" });
		await manager.reload();
	} else if (action === "Remove" && (await ctx.ui.confirm("Remove MCP server?", name))) {
		updateProjectServer(ctx.cwd, name, undefined);
		await manager.reload();
	}
}

async function showMcpPanel(ctx: ExtensionCommandContext, manager: OmegaMcpManager): Promise<void> {
	if (!ctx.hasUI) return;
	const action = await ctx.ui.select(`MCP\n${statusText(manager.getStates())}`, [
		"Manage server",
		"Add HTTP server",
		"Add stdio server",
		"Edit .mcp.json",
		"Reload",
	]);
	if (action === "Manage server") await manageServer(ctx, manager);
	else if (action === "Add HTTP server") await addHttpServer(ctx, manager);
	else if (action === "Add stdio server") await addStdioServer(ctx, manager);
	else if (action === "Edit .mcp.json") {
		const current = readProjectMcpConfig(ctx.cwd);
		const edited = await ctx.ui.editor(getProjectMcpConfigPath(ctx.cwd), JSON.stringify(current, null, 2));
		if (edited !== undefined) {
			writeProjectMcpConfig(ctx.cwd, parseMcpConfig(JSON.parse(edited) as unknown));
			await manager.reload();
		}
	} else if (action === "Reload") await manager.reload();
}

export function registerMcp(pi: ExtensionAPI): void {
	let manager: OmegaMcpManager | undefined;
	let cwd: string | undefined;
	const getManager = async (currentCwd: string): Promise<OmegaMcpManager> => {
		if (!manager || cwd !== currentCwd) {
			await manager?.close();
			manager = new OmegaMcpManager(currentCwd);
			cwd = currentCwd;
			await manager.reload();
		}
		return manager;
	};

	pi.on("session_start", async (_event, ctx) => {
		await getManager(ctx.cwd);
		if (ctx.hasUI) ctx.ui.setStatus("omega-mcp", `MCP ${manager?.listTools().length ?? 0} tools`);
	});
	pi.on("session_shutdown", async () => {
		await manager?.close();
		manager = undefined;
		cwd = undefined;
	});

	registerOmegaCommand(pi, "mcp", {
		description: "Configure MCP servers and inspect their tools",
		getArgumentCompletions: (prefix) =>
			["status", "reload", "tools"]
				.filter((value) => value.startsWith(prefix.trim()))
				.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			try {
				const active = await getManager(ctx.cwd);
				const command = args.trim();
				if (!command) await showMcpPanel(ctx, active);
				else if (command === "status") ctx.ui.notify(statusText(active.getStates()), "info");
				else if (command === "reload") {
					await active.reload();
					ctx.ui.notify("MCP configuration reloaded", "info");
				} else if (command === "tools") {
					const tools = active.listTools();
					ctx.ui.notify(
						tools.length
							? tools.map((item) => `${item.server}/${item.tool.name}`).join("\n")
							: "No MCP tools available",
						"info",
					);
				} else ctx.ui.notify("Usage: /mcp [status|reload|tools]", "warning");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerTool({
		name: "mcp",
		label: "MCP",
		description: "List configured MCP servers/tools, reconnect a server, or call an MCP tool.",
		parameters: Type.Object({
			action: StringEnum(["status", "list_tools", "call", "reconnect"] as const),
			server: Type.Optional(Type.String({ description: "MCP server name" })),
			tool: Type.Optional(Type.String({ description: "Remote MCP tool name" })),
			arguments: Type.Optional(
				Type.Record(Type.String(), Type.Unknown(), { description: "Arguments passed to the remote MCP tool" }),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const active = await getManager(ctx.cwd);
			const action: McpAction = params.action;
			if (action === "status") {
				return {
					content: [{ type: "text", text: statusText(active.getStates()) }],
					details: { states: active.getStates() },
				};
			}
			if (action === "list_tools") {
				const tools = active.listTools(params.server);
				return {
					content: [
						{
							type: "text",
							text: tools.length
								? tools
										.map((item) => `${item.server}/${item.tool.name}: ${item.tool.description ?? ""}`)
										.join("\n")
								: "No MCP tools available.",
						},
					],
					details: { tools },
				};
			}
			if (!params.server) throw new Error(`MCP action "${action}" requires server`);
			if (action === "reconnect") {
				const state = await active.reconnect(params.server);
				return {
					content: [{ type: "text", text: `${state.name}: ${state.status} (${state.tools.length} tools)` }],
					details: { state },
				};
			}
			if (!params.tool) throw new Error("MCP call requires tool");
			const result = await active.callTool(params.server, params.tool, params.arguments ?? {}, signal);
			return {
				content: [
					{
						type: "text",
						text: result.content.map(contentToText).join("\n") || JSON.stringify(result.structuredContent ?? {}),
					},
				],
				details: { server: params.server, tool: params.tool, result },
			};
		},
	});
}

export { loadMcpConfig, parseMcpConfig } from "./native-config.ts";
export { OmegaMcpManager } from "./native-manager.ts";
export type { McpConfigFile, McpServerConfig, McpServerState } from "./native-types.ts";
