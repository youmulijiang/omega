export interface TextChange {
	type: "equal" | "added" | "removed";
	text: string;
	oldLine: number;
	newLine: number;
	lineCount: number;
}

export interface TextDiff {
	equal: boolean;
	addedLines: number;
	removedLines: number;
	/** Large comparisons fall back to replacing the differing middle, without losing text. */
	coarse: boolean;
	changes: TextChange[];
}

/** Exact line comparison, including CRLF/LF and the final newline. Bounded quadratic work. */
export function diffText(before: string, after: string): TextDiff {
	if (Buffer.byteLength(before) > 1_048_576 || Buffer.byteLength(after) > 1_048_576)
		throw new Error("Each diff input must be at most 1 MiB");
	const left = before.match(/[^\n]*\n|[^\n]+$/g) ?? [];
	const right = after.match(/[^\n]*\n|[^\n]+$/g) ?? [];
	const changes: TextChange[] = [];
	let oldLine = 1;
	let newLine = 1;
	let addedLines = 0;
	let removedLines = 0;
	const append = (type: TextChange["type"], text: string): void => {
		const last = changes.at(-1);
		if (last?.type === type) {
			last.text += text;
			last.lineCount++;
		} else changes.push({ type, text, oldLine, newLine, lineCount: 1 });
		if (type !== "added") oldLine++;
		if (type !== "removed") newLine++;
		if (type === "added") addedLines++;
		if (type === "removed") removedLines++;
	};
	let start = 0;
	while (start < left.length && start < right.length && left[start] === right[start]) {
		append("equal", left[start]);
		start++;
	}
	let leftEnd = left.length;
	let rightEnd = right.length;
	while (leftEnd > start && rightEnd > start && left[leftEnd - 1] === right[rightEnd - 1]) {
		leftEnd--;
		rightEnd--;
	}
	const rows = leftEnd - start;
	const columns = rightEnd - start;
	const coarse = (rows + 1) * (columns + 1) > 4_000_000;
	if (coarse) {
		for (let i = start; i < leftEnd; i++) append("removed", left[i]);
		for (let j = start; j < rightEnd; j++) append("added", right[j]);
	} else {
		const width = columns + 1;
		const lengths = new Uint32Array((rows + 1) * width);
		for (let i = rows - 1; i >= 0; i--) {
			for (let j = columns - 1; j >= 0; j--) {
				lengths[i * width + j] =
					left[start + i] === right[start + j]
						? lengths[(i + 1) * width + j + 1] + 1
						: Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
			}
		}
		let i = 0;
		let j = 0;
		while (i < rows || j < columns) {
			if (i < rows && j < columns && left[start + i] === right[start + j]) {
				append("equal", left[start + i]);
				i++;
				j++;
			} else if (i < rows && (j === columns || lengths[(i + 1) * width + j] >= lengths[i * width + j + 1]))
				append("removed", left[start + i++]);
			else append("added", right[start + j++]);
		}
	}
	for (let i = leftEnd; i < left.length; i++) append("equal", left[i]);
	return { equal: before === after, addedLines, removedLines, coarse, changes };
}

/** Human-readable changed lines; unchanged blocks do not consume the preview budget. */
export function formatTextDiff(result: TextDiff): string {
	if (result.equal) return "Texts are identical.";
	const output = [
		`+${result.addedLines} added lines, -${result.removedLines} removed lines${result.coarse ? " (coarse comparison)" : ""}`,
	];
	for (const change of result.changes) {
		if (change.type === "equal") continue;
		output.push(`@@ old line ${change.oldLine}, new line ${change.newLine} @@`);
		const prefix = change.type === "added" ? "+" : "-";
		for (const line of change.text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
			output.push(prefix + line.replace(/\n$/, "").replace(/\r/g, "\\r"));
			if (!line.endsWith("\n")) output.push("\\ No newline at end of file");
		}
	}
	const text = output.join("\n");
	return text.length > 24_000 ? `${text.slice(0, 24_000)}\n[Preview truncated; full changes in details]` : text;
}
