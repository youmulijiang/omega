import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	initializeKnowledgeDirectory,
	readKnowledgeContent,
	readKnowledgeIndex,
	saveKnowledgeDocument,
	searchKnowledge,
} from "../src/knowledge/index.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryKnowledgeDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "omega-knowledge-"));
	temporaryDirectories.push(directory);
	return directory;
}

describe("knowledge storage", () => {
	it("creates an index without overwriting it", async () => {
		const directory = temporaryKnowledgeDirectory();
		await initializeKnowledgeDirectory(directory);
		await initializeKnowledgeDirectory(directory);

		expect(readFileSync(join(directory, "index.md"), "utf8")).toContain("# Omega Knowledge Index");
	});

	it("saves indexed documents and searches their content", async () => {
		const directory = temporaryKnowledgeDirectory();
		const filename = await saveKnowledgeDocument(
			{
				title: "SQL 注入排查",
				tags: ["渗透测试", "SQLi"],
				summary: "从参数到数据库调用追踪数据流。",
				content: "先定位查询构造点，再验证参数化查询是否覆盖所有分支。",
			},
			directory,
			new Date("2026-09-07T10:00:00.000Z"),
		);

		const index = readFileSync(join(directory, "index.md"), "utf8");
		expect(index).toContain(`[${filename}](./${filename})`);
		expect(index).toContain("SQL 注入排查");
		await expect(readKnowledgeIndex(directory)).resolves.toBe(index);
		await expect(readKnowledgeContent("SQL 注入排查", directory)).resolves.toMatchObject({
			file: filename,
			content: expect.stringContaining("参数化查询"),
		});
		await expect(readKnowledgeContent("../index.md", directory)).resolves.toBeUndefined();
		await expect(searchKnowledge("参数化 SQL", 10, directory)).resolves.toMatchObject([
			{ file: filename, title: "SQL 注入排查" },
		]);
	});
});
