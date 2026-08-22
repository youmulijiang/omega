/**
 * 高危命令的启发式匹配规则。
 *
 * 该列表用于“门控确认”而不是严格检测：
 * - 命中后会触发用户确认
 * - 未命中不代表一定安全
 */
const DANGEROUS_PATTERNS: RegExp[] = [
	/\bnmap\b\s+(?!--)\S/i, // nmap with scan flags or target (excludes bare nmap and --help/--version)
	/\bsqlmap\b/i, // SQL 注入
	/\bmsf(console|venom)\b/i, // Metasploit
	/\bhydra\b/i, // 暴力破解
	/\baircrack\b/i, // 无线破解
	/\bjohn(\s+the\s+ripper)?\b/i, // 密码破解
	/\bhashcat\b/i, // 哈希破解
	/\bburpsuite\b/i, // Burp Suite
	/\bnikto\b/i, // Web 扫描
];

/**
 * 判断一段命令字符串是否疑似高危安全操作。
 *
 * @param cmd - 命令行字符串。
 * @returns 若命中启发式规则则返回 true。
 */
export function isDangerousCommand(cmd: string): boolean {
	return DANGEROUS_PATTERNS.some((pattern) => pattern.test(cmd));
}
