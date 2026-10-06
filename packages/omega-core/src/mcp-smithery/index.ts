import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { OmegaAPI } from "../api.ts";
import { registerOmegaCommand } from "../commands/register.ts";
import { type SmitherySearchResult, searchSmitheryRegistry } from "../mcp/smithery-registry.ts";
import type { ResolvedSmitheryServer } from "./smithery-add.ts";
import {
	addServerToMcpJson,
	formatSmitheryChoice,
	resolveSmitheryServer,
	smitheryJsonSnippet,
	smitheryPersistPath,
} from "./smithery-add.ts";

const SMITHERY_USAGE = "Usage: /smithery <query> — search the Smithery registry and add an MCP server.";

async function searchResults(
	ctx: ExtensionCommandContext,
	apiKey: string,
	query: string,
): Promise<SmitherySearchResult[]> {
	ctx.ui.setWorkingMessage("Searching Smithery...");
	try {
		return await searchSmitheryRegistry(query, { apiKey, signal: ctx.signal });
	} finally {
		ctx.ui.setWorkingMessage();
	}
}

/**
 * `/smithery <query>`: search the Smithery registry and hand the picked server to the upstream
 * builtin MCP. Registration is session-scoped via `pi.registerMcpServer()`; persistence writes an
 * upstream `mcp.json` (project `.omega/mcp.json` or the global agent `mcp.json`).
 */
export function registerSmithery(omega: OmegaAPI): void {
	registerOmegaCommand(omega, "smithery", {
		description: "Search the Smithery registry and add an MCP server",
		handler: async (args, ctx) => {
			try {
				const apiKey = process.env.SMITHERY_API_KEY?.trim();
				if (!apiKey) {
					ctx.ui.notify("Set SMITHERY_API_KEY before using Smithery integration", "error");
					return;
				}
				const query = args.trim();
				if (!query) {
					ctx.ui.notify(SMITHERY_USAGE, "warning");
					return;
				}
				const results = await searchResults(ctx, apiKey, query);
				if (results.length === 0) {
					ctx.ui.notify("No Smithery MCP servers found", "warning");
					return;
				}
				const choices = results.map(formatSmitheryChoice);
				const selectedLabel = await ctx.ui.select("Select a Smithery MCP server", choices);
				const selected = results[choices.indexOf(selectedLabel ?? "")];
				if (!selected) return;

				const useConnect =
					selected.mcpUrl !== undefined && (await ctx.ui.confirm("Use Smithery Connect?", selected.description));
				ctx.ui.setWorkingMessage("Resolving Smithery server...");
				let resolved: ResolvedSmitheryServer;
				try {
					resolved = await resolveSmitheryServer(selected, { apiKey, useConnect, signal: ctx.signal });
				} finally {
					ctx.ui.setWorkingMessage();
				}

				const sessionLabel = "This session only";
				const projectLabel = `Save to this project (${smitheryPersistPath("project", ctx.cwd)})`;
				const globalLabel = `Save globally (${smitheryPersistPath("global")})`;
				const target = await ctx.ui.select(`Add MCP server "${resolved.name}"`, [
					sessionLabel,
					projectLabel,
					globalLabel,
				]);
				if (!target) return;

				let persisted: string | undefined;
				if (target === projectLabel || target === globalLabel) {
					const path = smitheryPersistPath(target === projectLabel ? "project" : "global", ctx.cwd);
					const replaced = addServerToMcpJson(path, resolved.name, resolved.config);
					persisted = path;
					ctx.ui.notify(
						`${replaced ? "Updated" : "Added"} MCP server "${resolved.name}" in ${path}. Run /reload to apply it.`,
						"info",
					);
				}

				// Session registration through the upstream builtin MCP. Older builds without
				// registerMcpServer degrade to the persist-or-snippet flow below.
				const register = (omega as Partial<Pick<OmegaAPI, "registerMcpServer">>).registerMcpServer;
				if (typeof register === "function") {
					try {
						register.call(omega, resolved.name, resolved.config);
					} catch (error) {
						ctx.ui.notify(
							`Session registration failed: ${error instanceof Error ? error.message : String(error)}`,
							"warning",
						);
					}
				}

				if (resolved.authorizationUrl) {
					ctx.ui.notify(
						`Complete OAuth authorization for "${resolved.name}", then sign in with /mcp:\n${resolved.authorizationUrl}`,
						"warning",
					);
					return;
				}
				if (!persisted) {
					ctx.ui.notify(
						`Registered "${resolved.name}" for this session. To persist it, add this to an mcp.json:\n${smitheryJsonSnippet(resolved.name, resolved.config)}`,
						"info",
					);
				}
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
