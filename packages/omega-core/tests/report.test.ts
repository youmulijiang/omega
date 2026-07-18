import { describe, it, expect } from "vitest";
import { generateReport } from "../src/commands/report.ts";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

const fakeEntries: SessionEntry[] = [
  {
    id: "1",
    type: "message",
    message: { role: "user", content: "扫描目标 192.168.1.1" },
  } as SessionEntry,
  {
    id: "2",
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "发现开放端口 80, 443, 22" }],
    },
  } as SessionEntry,
];

describe("generateReport", () => {
  it("包含报告标题", () => {
    const report = generateReport(fakeEntries, "192.168.1.1");
    expect(report).toContain("# OMEGA 渗透测试报告");
  });

  it("包含目标信息", () => {
    const report = generateReport(fakeEntries, "192.168.1.1");
    expect(report).toContain("192.168.1.1");
  });

  it("包含 agent 发现的内容", () => {
    const report = generateReport(fakeEntries, "192.168.1.1");
    expect(report).toContain("发现开放端口");
  });

  it("空会话生成空发现区块", () => {
    const report = generateReport([], "target");
    expect(report).toContain("## 发现");
  });
});
