import type { CostReport } from "./report.ts";

function escapeHtml(value: string): string {
	return value.replace(
		/[&<>"']/g,
		(char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char,
	);
}

function bar(value: number, maximum: number): string {
	const percent = maximum > 0 ? Math.min(100, Math.max(0, (value / maximum) * 100)) : 0;
	return `<div class="track"><div class="fill" style="width:${percent.toFixed(1)}%"></div></div>`;
}

export function renderCostHtml(report: CostReport, generatedAt = new Date()): string {
	const modelMax = Math.max(0, ...report.models.map((model) => model.totalTokens));
	const sourceMax = Math.max(0, ...report.sources.map((source) => source.tokens));
	const modelRows = report.models
		.map(
			(model) =>
				`<tr><td>${escapeHtml(model.model)}</td><td>${model.calls}</td><td>${model.input.toLocaleString()}</td><td>${model.output.toLocaleString()}</td><td>${model.cacheRead.toLocaleString()}</td><td>${model.cacheWrite.toLocaleString()}</td><td>${model.totalTokens.toLocaleString()}${bar(model.totalTokens, modelMax)}</td><td>$${model.cost.toFixed(4)}</td></tr>`,
		)
		.join("\n");
	const sourceRows = report.sources
		.map(
			(source) =>
				`<tr><td>${escapeHtml(source.label)}</td><td>~${source.tokens.toLocaleString()}${bar(source.tokens, sourceMax)}</td></tr>`,
		)
		.join("\n");
	return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Omega Cost Report</title><style>
:root{color-scheme:dark;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;background:#111827;color:#e5e7eb}
body{max-width:1100px;margin:0 auto;padding:32px 20px}h1{color:#67e8f9}h2{margin-top:36px;color:#a5b4fc}
.stats{display:flex;gap:16px;flex-wrap:wrap}.stat{background:#1f2937;padding:16px 22px;border-radius:10px}
.stat strong{display:block;font-size:1.4rem}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:10px;border-bottom:1px solid #374151}th{color:#9ca3af}small{color:#9ca3af}
.scroll{overflow-x:auto}.track{height:7px;margin-top:6px;background:#374151;border-radius:8px;min-width:90px}.fill{height:100%;background:#22d3ee;border-radius:8px}
</style></head><body><h1>OMEGA / COST</h1>
<p>当前会话累计 · 生成时间 ${escapeHtml(generatedAt.toISOString())} · 当前模型 ${escapeHtml(report.currentModel ?? "未选择")}</p>
<div class="stats"><div class="stat">总 Token<strong>${report.total.totalTokens.toLocaleString()}</strong></div><div class="stat">总费用（USD）<strong>$${report.total.cost.toFixed(4)}</strong></div><div class="stat">计费记录<strong>${report.total.calls}</strong></div></div>
<h2>按模型统计（供应商返回的 usage）</h2><div class="scroll"><table><thead><tr><th>模型</th><th>调用</th><th>输入</th><th>输出</th><th>缓存读</th><th>缓存写</th><th>总 Token</th><th>费用 USD</th></tr></thead><tbody>${modelRows || '<tr><td colspan="8">尚无模型调用记录</td></tr>'}</tbody></table></div>
${report.unattributed.calls ? `<p>工具或摘要产生的未归因用量：${report.unattributed.totalTokens.toLocaleString()} Token / $${report.unattributed.cost.toFixed(4)}。此部分计入总计，但未并入任何模型。</p>` : ""}
<h2>内容来源估算</h2><small>仅统计当前分支可见文本；按 UTF-8 字节 / 4 粗估。系统提示词为当前快照，不代表每次调用历史值。类别不可与供应商计费 Token 相加或一一对照；图片、工具 schema、隐式上下文及缓存影响未分摊。</small><div class="scroll"><table><thead><tr><th>来源</th><th>估算文本 Token</th></tr></thead><tbody>${sourceRows}</tbody></table></div>
<p><small>分支消息 ${report.branchMessageCount} 条。费用取会话中记录的供应商用量；不等同最终账单。</small></p></body></html>`;
}
