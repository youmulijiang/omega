import type { SessionEntry } from "@earendil-works/pi-coding-agent";

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
