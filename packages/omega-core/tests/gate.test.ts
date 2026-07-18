import { describe, it, expect } from "vitest";
import { isDangerousCommand } from "../src/permissions/gate.ts";

describe("isDangerousCommand", () => {
  it("识别 nmap 主动扫描", () => {
    expect(isDangerousCommand("nmap -sS 192.168.1.0/24")).toBe(true);
  });

  it("nmap --help 不触发误报", () => {
    expect(isDangerousCommand("nmap --help")).toBe(false);
  });

  it("识别 sqlmap 注入", () => {
    expect(isDangerousCommand("sqlmap -u http://target/login")).toBe(true);
  });

  it("识别 metasploit", () => {
    expect(isDangerousCommand("msfconsole")).toBe(true);
  });

  it("普通命令不触发", () => {
    expect(isDangerousCommand("ls -la")).toBe(false);
    expect(isDangerousCommand("cat /etc/hosts")).toBe(false);
  });
});
