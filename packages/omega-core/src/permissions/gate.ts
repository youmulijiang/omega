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

export function isDangerousCommand(cmd: string): boolean {
	return DANGEROUS_PATTERNS.some((pattern) => pattern.test(cmd));
}
