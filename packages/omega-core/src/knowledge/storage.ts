import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const KNOWLEDGE_INDEX_HEADER = `# Omega Knowledge Index

此文件由 Omega 自动维护，用于索引通过 \`/study\` 保存的知识。

| 标题 | 文件 | 标签 | 摘要 | 更新时间 |
| --- | --- | --- | --- | --- |
`;

export interface KnowledgeDocument {
	title: string;
	tags: string[];
	summary: string;
	content: string;
}

export interface KnowledgeSearchMatch {
	file: string;
	title: string;
	score: number;
	snippet: string;
}

export interface KnowledgeContent {
	file: string;
	title: string;
	content: string;
}

export function getKnowledgeDirectory(home = homedir()): string {
	return join(home, ".omega", "knowledge");
}

export async function initializeKnowledgeDirectory(directory = getKnowledgeDirectory()): Promise<string> {
	await mkdir(directory, { recursive: true });
	const indexPath = join(directory, "index.md");
	try {
		await writeFile(indexPath, KNOWLEDGE_INDEX_HEADER, { encoding: "utf8", flag: "wx" });
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
	}
	return directory;
}

export async function readKnowledgeIndex(directory = getKnowledgeDirectory()): Promise<string> {
	await initializeKnowledgeDirectory(directory);
	return readFile(join(directory, "index.md"), "utf8");
}

function slugify(title: string): string {
	const slug = title
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[^\p{Letter}\p{Number}]+/gu, "-")
		.replace(/^-+|-+$/gu, "")
		.slice(0, 64);
	return slug || "knowledge";
}

function escapeTableCell(value: string): string {
	return value
		.replace(/\|/gu, "\\|")
		.replace(/[\r\n]+/gu, " ")
		.trim();
}

export async function saveKnowledgeDocument(
	document: KnowledgeDocument,
	directory = getKnowledgeDirectory(),
	now = new Date(),
): Promise<string> {
	await initializeKnowledgeDirectory(directory);
	const timestamp = now.toISOString().replace(/[:.]/gu, "-");
	const filename = `${timestamp}-${slugify(document.title)}.md`;
	const updatedAt = now.toISOString();
	const body = [
		`# ${document.title.trim()}`,
		"",
		`- 更新时间：${updatedAt}`,
		`- 标签：${document.tags.join(", ") || "未分类"}`,
		"",
		"## 摘要",
		"",
		document.summary.trim(),
		"",
		"## 经验",
		"",
		document.content.trim(),
		"",
	].join("\n");
	await writeFile(join(directory, filename), body, { encoding: "utf8", flag: "wx" });

	const indexPath = join(directory, "index.md");
	const index = await readFile(indexPath, "utf8");
	const row = `| ${escapeTableCell(document.title)} | [${filename}](./${filename}) | ${escapeTableCell(document.tags.join(", ") || "未分类")} | ${escapeTableCell(document.summary)} | ${updatedAt} |\n`;
	await writeFile(indexPath, `${index.trimEnd()}\n${row}`, "utf8");
	return filename;
}

function extractTitle(content: string, fallback: string): string {
	return /^#\s+(.+)$/mu.exec(content)?.[1]?.trim() || fallback;
}

export async function readKnowledgeContent(
	name: string,
	directory = getKnowledgeDirectory(),
): Promise<KnowledgeContent | undefined> {
	await initializeKnowledgeDirectory(directory);
	const query = name.trim().toLocaleLowerCase();
	if (!query) return undefined;
	if (query === "index" || query === "index.md") {
		return { file: "index.md", title: "Omega Knowledge Index", content: await readKnowledgeIndex(directory) };
	}

	const filenames = (await readdir(directory)).filter((file) => file.endsWith(".md") && file !== "index.md");
	const documents = await Promise.all(
		filenames.map(async (file) => {
			const content = await readFile(join(directory, file), "utf8");
			return { file, title: extractTitle(content, file), content };
		}),
	);
	const exact = documents.find(
		(document) =>
			document.file.toLocaleLowerCase() === query ||
			document.file.replace(/\.md$/u, "").toLocaleLowerCase() === query ||
			document.title.toLocaleLowerCase() === query,
	);
	if (exact) return exact;

	const partial = documents.filter(
		(document) =>
			document.file.toLocaleLowerCase().includes(query) || document.title.toLocaleLowerCase().includes(query),
	);
	return partial.length === 1 ? partial[0] : undefined;
}

function createSnippet(content: string, terms: readonly string[]): string {
	const normalized = content.replace(/\s+/gu, " ").trim();
	const firstPosition = terms.reduce((best, term) => {
		const position = normalized.toLocaleLowerCase().indexOf(term);
		return position >= 0 && (best < 0 || position < best) ? position : best;
	}, -1);
	const start = Math.max(0, firstPosition < 0 ? 0 : firstPosition - 80);
	return `${start > 0 ? "…" : ""}${normalized.slice(start, start + 320)}${start + 320 < normalized.length ? "…" : ""}`;
}

export async function searchKnowledge(
	query: string,
	limit = 10,
	directory = getKnowledgeDirectory(),
): Promise<KnowledgeSearchMatch[]> {
	await initializeKnowledgeDirectory(directory);
	const terms = query
		.toLocaleLowerCase()
		.split(/\s+/u)
		.map((term) => term.trim())
		.filter(Boolean);
	if (terms.length === 0) return [];

	const filenames = (await readdir(directory)).filter((name) => name.endsWith(".md") && name !== "index.md");
	const matches = await Promise.all(
		filenames.map(async (file): Promise<KnowledgeSearchMatch | undefined> => {
			const content = await readFile(join(directory, file), "utf8");
			const title = extractTitle(content, file);
			const haystack = content.toLocaleLowerCase();
			const titleText = title.toLocaleLowerCase();
			let score = 0;
			for (const term of terms) {
				if (titleText.includes(term)) score += 10;
				let position = haystack.indexOf(term);
				while (position >= 0) {
					score += 1;
					position = haystack.indexOf(term, position + term.length);
				}
			}
			return score > 0 ? { file, title, score, snippet: createSnippet(content, terms) } : undefined;
		}),
	);
	return matches
		.filter((match): match is KnowledgeSearchMatch => match !== undefined)
		.sort((left, right) => right.score - left.score || left.title.localeCompare(right.title))
		.slice(0, limit);
}
