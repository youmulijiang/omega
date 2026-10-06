import type { OmegaAPI } from "../api.ts";
import { appendPrompts, loadProjectAgentsFile, loadProjectSystemPrompt } from "./loader.ts";

export { appendPrompt, appendPrompts, loadProjectAgentsFile, loadProjectSystemPrompt, loadPrompt } from "./loader.ts";

export type ContextPromptName = "web-testing" | "log-analysis";

const WEB_SUBJECT = /(?:\bweb\b|网站|网页|应用|接口|\bapi\b|https?:\/\/)/iu;
const WEB_SECURITY_INTENT = /(?:渗透|安全测试|漏洞|扫描|攻防|红队|pentest|recon|xss|sqli?|ssrf|idor|csrf|越权|注入)/iu;
const LOG_SUBJECT = /(?:日志|告警|审计记录|事件记录|access\.log|error\.log|syslog|event log|\bsiem\b|\blogs?\b)/iu;
const LOG_ANALYSIS_INTENT = /(?:分析|排查|调查|溯源|研判|异常|入侵|事件响应|取证|analy|investigat|incident|forensic)/iu;

/** Select scenario prompts from the current user request. */
export function selectContextPrompts(userPrompt: string): ContextPromptName[] {
	const selected: ContextPromptName[] = [];
	if (WEB_SUBJECT.test(userPrompt) && WEB_SECURITY_INTENT.test(userPrompt)) selected.push("web-testing");
	if (LOG_SUBJECT.test(userPrompt) && LOG_ANALYSIS_INTENT.test(userPrompt)) selected.push("log-analysis");
	return selected;
}

export function registerPrompts(omega: OmegaAPI): void {
	let activeContextPrompts: ContextPromptName[] = [];
	omega.on("session_start", () => {
		activeContextPrompts = [];
	});
	omega.on("before_agent_start", async (event, ctx) => {
		// Pi wraps the AGENTS.md files it discovers in this exact element, so a
		// project-local file injected here reads to the model like any other.
		const agentsFile = await loadProjectAgentsFile(ctx.cwd);
		const withAgentsFile = (systemPrompt: string): string =>
			agentsFile
				? `${systemPrompt.trimEnd()}\n\n<project_instructions path="${agentsFile.path}">\n${agentsFile.content}\n</project_instructions>`
				: systemPrompt;

		const projectPrompt = await loadProjectSystemPrompt(ctx.cwd);
		if (projectPrompt) {
			return {
				systemPrompt: withAgentsFile(
					projectPrompt.content
						? `${event.systemPrompt.trimEnd()}\n\n${projectPrompt.content}`
						: event.systemPrompt,
				),
			};
		}
		const selected = selectContextPrompts(event.prompt);
		if (selected.length > 0) activeContextPrompts = selected;
		return {
			systemPrompt: withAgentsFile(appendPrompts(event.systemPrompt, ["system", ...activeContextPrompts])),
		};
	});
}
