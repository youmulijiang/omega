import { lstat, readdir } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

export const MAX_DELETE_FILES_WITHOUT_APPROVAL = 20;

export interface BuiltInRisk {
	decision: "ask" | "deny";
	reason: string;
}

const SYSTEM_ROOT_DELETE_PATTERNS = [
	/(?:^|[;&|]\s*)(?:sudo\s+)?rm\s+(?=[^;&|]*(?:-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r))[^;&|]*(?:\s|^)(?:\/|\/\*|~|~\/\*)\s*(?:$|[;&|])/iu,
	/(?:^|[;&|]\s*)(?:remove-item|del|erase|rd|rmdir)\b[^;&|]*(?:[a-z]:[\\/](?:\*?)?|\\\\[^\\\s]+\\[^\\\s]+\\?)\s*(?:$|[;&|])/iu,
];

const DATABASE_DESTRUCTION_PATTERNS = [
	/\bdrop\s+(?:database|schema)\b/iu,
	/\b(?:flushall|flushdb)\b/iu,
	/\.dropDatabase\s*\(/iu,
	/\b(?:mysql|mariadb|psql|sqlcmd)\b[^\r\n]*(?:\bdrop\s+(?:database|schema)\b)/iu,
];

const DISK_DESTRUCTION_PATTERNS = [
	/(?:^|[;&|]\s*)(?:sudo\s+)?mkfs(?:\.[a-z0-9]+)?\b/iu,
	/(?:^|[;&|]\s*)format(?:\.com)?\s+[a-z]:/iu,
	/(?:^|[;&|]\s*)dd\b[^;&|]*\bof=(?:\/dev\/(?:sd|nvme|hd|vd)|\\\\\.\\PhysicalDrive)/iu,
	/(?:^|[;&|]\s*)(?:diskpart|fdisk|parted)\b/iu,
];

/** Non-configurable deny rules. These always run before user policy and permission level. */
export function evaluateBuiltInDeny(command: string): BuiltInRisk | undefined {
	if (SYSTEM_ROOT_DELETE_PATTERNS.some((pattern) => pattern.test(command))) {
		return { decision: "deny", reason: "内置安全规则禁止删除系统盘或整个文件系统" };
	}
	if (DATABASE_DESTRUCTION_PATTERNS.some((pattern) => pattern.test(command))) {
		return { decision: "deny", reason: "内置安全规则禁止删除数据库或数据库架构" };
	}
	if (DISK_DESTRUCTION_PATTERNS.some((pattern) => pattern.test(command))) {
		return { decision: "deny", reason: "内置安全规则禁止格式化或覆盖磁盘设备" };
	}
	return undefined;
}

function deletionOperands(command: string): string[] {
	const match = /^\s*(?:sudo\s+)?(?:rm|remove-item)\s+(.+)$/iu.exec(command);
	if (!match) return [];
	const tokens = match[1].match(/"[^"]*"|'[^']*'|\S+/gu) ?? [];
	return tokens
		.map((token) => token.replace(/^["']|["']$/gu, ""))
		.filter((token) => token && !token.startsWith("-") && token !== "--");
}

async function countPathFiles(path: string, remaining: number): Promise<number> {
	try {
		const stats = await lstat(path);
		if (!stats.isDirectory()) return 1;
		let count = 0;
		for (const entry of await readdir(path)) {
			count += await countPathFiles(resolve(path, entry), remaining - count);
			if (count > remaining) return count;
		}
		return count;
	} catch {
		return 0;
	}
}

/** Count concrete files below rm/Remove-Item operands, stopping once the safety threshold is exceeded. */
export async function evaluateBulkDeletion(command: string, cwd: string): Promise<BuiltInRisk | undefined> {
	let count = 0;
	for (const operand of deletionOperands(command)) {
		if (operand.includes("*") || operand.includes("?")) {
			return { decision: "ask", reason: "删除命令包含通配符，无法在执行前确定文件数量" };
		}
		const target = isAbsolute(operand) ? operand : resolve(cwd, operand);
		count += await countPathFiles(target, MAX_DELETE_FILES_WITHOUT_APPROVAL - count);
		if (count > MAX_DELETE_FILES_WITHOUT_APPROVAL) {
			return {
				decision: "ask",
				reason: `预计删除 ${String(count)} 个以上文件，超过 ${String(MAX_DELETE_FILES_WITHOUT_APPROVAL)} 个的风控阈值`,
			};
		}
	}
	return undefined;
}
