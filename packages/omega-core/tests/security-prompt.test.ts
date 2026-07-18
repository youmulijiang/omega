import { describe, it, expect } from "vitest";
import { buildSecurityPrompt } from "../src/prompts/security.ts";

describe("buildSecurityPrompt", () => {
  it("在基础 prompt 之后追加安全语境", () => {
    const result = buildSecurityPrompt("base prompt");
    expect(result).toContain("base prompt");
    expect(result).toContain("网络安全");
  });

  it("包含合规提醒", () => {
    const result = buildSecurityPrompt("");
    expect(result).toContain("授权");
  });

  it("包含报告格式说明", () => {
    const result = buildSecurityPrompt("");
    expect(result).toContain("/report");
  });
});
