import { describe, it, expect } from "vitest";
import { dangerousCommandReason, isDangerousCommand } from "../src/permissions/gate.ts";

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

	it("识别常见的破坏性删除和系统命令", () => {
		expect(dangerousCommandReason("rm -rf *")).toBe("rm *");
		expect(isDangerousCommand("sudo rm -fr /var/tmp/data")).toBe(true);
		expect(isDangerousCommand("git clean -fdx")).toBe(true);
		expect(isDangerousCommand("Remove-Item -LiteralPath data -Recurse -Force")).toBe(true);
		expect(isDangerousCommand("rmdir /s /q data")).toBe(true);
		expect(isDangerousCommand("del /s *.log")).toBe(true);
		expect(isDangerousCommand("mkfs.ext4 /dev/sdb1")).toBe(true);
		expect(isDangerousCommand("dd if=image.iso of=/dev/sdb")).toBe(true);
		expect(isDangerousCommand("shutdown -h now")).toBe(true);
	});

	it("所有文件删除需要授权，但帮助命令不触发", () => {
		expect(isDangerousCommand("rm temporary.txt")).toBe(true);
		expect(isDangerousCommand("rm --help")).toBe(false);
		expect(isDangerousCommand("nmap --version")).toBe(false);
	});
});
