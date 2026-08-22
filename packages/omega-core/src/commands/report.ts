import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/**
 * 从 Pi 的消息 content 中提取纯文本。
 *
 * 兼容：
 * - `string`
 * - 类似 OpenAI content-part 数组（只采集 `{ type: "text" }`）
 *
 * @param content - 消息内容。
 * @returns 拼接后的纯文本（无法解析则返回空字符串）。
 */
function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((c): c is { type: "text"; text: string } => c?.type === "text")
			.map((c) => c.text)
			.join("\n");
	}
	return "";
}

/**
 * 基于会话条目生成 Markdown 渗透测试报告。
 *
 * 规则（启发式）：
 * - 用户消息 -> “操作记录”
 * - 助手消息 -> “发现”
 *
 * @param entries - 会话条目（通常来自 `ctx.sessionManager.getBranch()`）。
 * @param target - 测试目标描述。
 * @returns Markdown 格式报告全文。
 */
export function generateReport(entries: SessionEntry[], target: string): string {
	const now = new Date().toISOString().split("T")[0];

	const findings: string[] = [];
	const userInputs: string[] = [];

	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (msg.role === "user") {
			userInputs.push(`- ${extractText(msg.content)}`);
		} else if (msg.role === "assistant") {
			const text = extractText(msg.content).trim();
			if (text) findings.push(text);
		}
	}

	return `# OMEGA 渗透测试报告

**日期：** ${now}  
**目标：** ${target}  
**工具：** OMEGA Network Security Agent  

---

## 执行摘要

本报告由 OMEGA Agent 会话自动生成。

## 测试范围

目标：\`${target}\`

## 操作记录

${userInputs.length > 0 ? userInputs.join("\n") : "- 无记录"}

## 发现

${findings.length > 0 ? findings.map((f, i) => `### 发现 ${i + 1}\n\n${f}`).join("\n\n") : "_本次会话未记录明确发现。_"}

---

## 修复建议

_请根据以上发现补充修复建议。_

---

*由 OMEGA 自动生成 · ${now}*
`;
}
