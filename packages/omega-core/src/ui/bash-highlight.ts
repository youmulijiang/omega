import type { ToolboxTheme } from "./toolbox-theme.ts";

interface BashCallArgs {
	command?: string;
	timeout?: number;
}

const SHELL_KEYWORDS = new Set([
	"if",
	"then",
	"else",
	"elif",
	"fi",
	"for",
	"while",
	"until",
	"do",
	"done",
	"case",
	"esac",
	"in",
	"function",
	"select",
	"time",
	"coproc",
	"{",
	"}",
	"!",
]);
const WORD_BREAK = /[\s'"`$|&;<>()#]/;

/** Tokenize and theme a shell command without changing its text. */
export function highlightBashCommand(command: string, color: (token: string, text: string) => string): string {
	const output: string[] = [];
	const push = (text: string, token?: string) => output.push(token && text ? color(token, text) : text);
	let index = 0;
	let expectCommand = true;

	while (index < command.length) {
		const character = command[index];
		if (character === " " || character === "\t") {
			push(character);
			index++;
			continue;
		}
		if (character === "\n") {
			push(character);
			expectCommand = true;
			index++;
			continue;
		}
		if (character === "#" && (index === 0 || /[ \t\n]/.test(command[index - 1]))) {
			const newline = command.indexOf("\n", index);
			const end = newline === -1 ? command.length : newline;
			push(command.slice(index, end), "syntaxComment");
			index = end;
			continue;
		}

		const four = command.slice(index, index + 4);
		if (four === "2>&1" || four === "1>&2") {
			push(four, "syntaxOperator");
			index += 4;
			continue;
		}
		const three = command.slice(index, index + 3);
		if (three === "&>>") {
			push(three, "syntaxOperator");
			index += 3;
			continue;
		}
		const two = command.slice(index, index + 2);
		if (two === "&&" || two === "||") {
			push(two, "syntaxOperator");
			index += 2;
			expectCommand = true;
			continue;
		}
		if ([">>", "2>", ">&", "<&", "&>", "<<"].includes(two)) {
			push(two, "syntaxOperator");
			index += 2;
			continue;
		}
		if (character === "|" || character === ";") {
			push(character, "syntaxOperator");
			index++;
			expectCommand = true;
			continue;
		}
		if (character === ">" || character === "<") {
			push(character, "syntaxOperator");
			index++;
			continue;
		}
		if (character === "&" || character === "(") {
			push(character, "syntaxOperator");
			index++;
			expectCommand = true;
			continue;
		}
		if (character === ")") {
			push(character, "syntaxOperator");
			index++;
			expectCommand = false;
			continue;
		}

		if (character === "'") {
			const quote = command.indexOf("'", index + 1);
			const end = quote === -1 ? command.length : quote + 1;
			push(command.slice(index, end), "syntaxString");
			index = end;
			continue;
		}
		if (character === '"') {
			let end = index + 1;
			while (end < command.length) {
				if (command[end] === "\\") {
					end += 2;
					continue;
				}
				if (command[end] === '"') {
					end++;
					break;
				}
				end++;
			}
			push(command.slice(index, end), "syntaxString");
			index = end;
			continue;
		}
		if (character === "`") {
			const quote = command.indexOf("`", index + 1);
			const end = quote === -1 ? command.length : quote + 1;
			push(command.slice(index, end), "syntaxString");
			index = end;
			continue;
		}
		if (character === "$") {
			const match = /^\$(\([^)]*\)|\{[^}]*\}|[A-Za-z_][A-Za-z0-9_]*|[0-9@#?$!*_-])/.exec(command.slice(index));
			if (match) {
				push(match[0], "syntaxVariable");
				index += match[0].length;
				continue;
			}
			push(character);
			index++;
			continue;
		}

		let end = index;
		while (end < command.length && !WORD_BREAK.test(command[end])) end++;
		if (end === index) {
			push(character);
			index++;
			continue;
		}
		const word = command.slice(index, end);
		index = end;
		if (expectCommand && /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
			const equals = word.indexOf("=");
			push(word.slice(0, equals), "syntaxVariable");
			push("=", "syntaxOperator");
			push(word.slice(equals + 1));
			continue;
		}
		if (expectCommand) {
			push(word, SHELL_KEYWORDS.has(word) ? "syntaxKeyword" : "syntaxFunction");
			expectCommand = false;
			continue;
		}
		if (/^--?[A-Za-z0-9][\w.-]*(=.*)?$/.test(word) && word !== "-") {
			const equals = word.indexOf("=");
			if (equals !== -1) {
				push(word.slice(0, equals), "syntaxType");
				push("=", "syntaxOperator");
				push(word.slice(equals + 1));
			} else push(word, "syntaxType");
			continue;
		}
		if (/^\d+(\.\d+)?$/.test(word)) {
			push(word, "syntaxNumber");
			continue;
		}
		push(word);
	}
	return output.join("");
}

export function formatBashCallHighlighted(args: BashCallArgs, theme: ToolboxTheme): string {
	const command = typeof args.command === "string" ? args.command : "";
	const timeout = typeof args.timeout === "number" ? args.timeout : undefined;
	const suffix = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";
	const prompt = theme.fg("toolTitle", theme.bold("$ "));
	if (!command) return prompt + theme.fg("toolOutput", "...") + suffix;
	try {
		return prompt + highlightBashCommand(command, (token, text) => theme.fg(token, text)) + suffix;
	} catch {
		return prompt + command + suffix;
	}
}
