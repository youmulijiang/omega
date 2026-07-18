const DANGEROUS_PATTERNS: RegExp[] = [
	/\bnmap\b.*-s[SATUV]/i, // nmap 主动扫描
	/\bnmap\b/i, // 任意 nmap
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
