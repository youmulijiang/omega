import { keyText, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { getToolboxTheme, type ToolboxTheme } from "./toolbox-theme.ts";

const BACKGROUND_FILL = /\x1b\[48;[0-9;]*m|\x1b\[(?:4[0-7]|10[0-7])m/g;
const ANSI = /\x1b\[[0-9;:?]*[ -/]*[@-~]/g;
const COLLAPSED_CONTENT_LINES = 5;

export function stripBackgroundFills(line: string): string {
	return line.replace(BACKGROUND_FILL, "");
}

function padToWidth(line: string, width: number): string {
	const renderedWidth = visibleWidth(line);
	if (renderedWidth === width) return line;
	return renderedWidth < width ? line + " ".repeat(width - renderedWidth) : truncateToWidth(line, width);
}

function trimBlankEdges(lines: string[]): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && lines[start].replace(ANSI, "").trim() === "") start++;
	while (end > start && lines[end - 1].replace(ANSI, "").trim() === "") end--;
	return start === 0 && end === lines.length ? lines : lines.slice(start, end);
}

function collapseAnchorLine(theme: ToolboxTheme): string | undefined {
	try {
		const keys = keyText("app.tools.expand");
		return keys ? theme.fg("muted", "(") + theme.fg("dim", keys) + theme.fg("muted", " to collapse)") : undefined;
	} catch {
		return undefined;
	}
}

function expandAnchorLine(theme: ToolboxTheme, remainingLines: number): string {
	const prefix = theme.fg("muted", `... (${remainingLines} more ${remainingLines === 1 ? "line" : "lines"}`);
	try {
		const keys = keyText("app.tools.expand");
		return keys ? `${prefix}, ${theme.fg("dim", keys)}${theme.fg("muted", " to expand)")}` : `${prefix})`;
	} catch {
		return `${prefix})`;
	}
}

export function collapseToolboxContent(lines: string[], expanded: boolean, theme: ToolboxTheme): string[] {
	if (expanded || lines.length <= COLLAPSED_CONTENT_LINES) return lines;
	return [...lines.slice(0, COLLAPSED_CONTENT_LINES), expandAnchorLine(theme, lines.length - COLLAPSED_CONTENT_LINES)];
}

function fingerprint(lines: string[]): string {
	return lines.join("\u0000");
}

interface Renderable {
	render(width: number): string[];
}
interface ToolBoxInternals {
	hideComponent: boolean;
	isPartial: boolean;
	expanded: boolean;
	result?: { isError: boolean };
	selfRenderContainer: Renderable;
	contentBox: Renderable;
	contentText: Renderable;
	imageComponents: Renderable[];
	imageSpacers: Renderable[];
	hasRendererDefinition(): boolean;
	getRenderShell(): "default" | "self";
	__omegaFrameCache?: { width: number; fingerprint: string; color: string; expanded: boolean; output: string[] };
}

type ToolBoxPrototype = ToolBoxInternals & {
	render(width: number): string[];
	__omegaToolboxFramed?: boolean;
};

/** Install the rounded, transparent, status-colored frame for every tool renderer. */
export function patchToolBoxFrames(collapseAnchor = true): void {
	const prototype = ToolExecutionComponent.prototype as unknown as ToolBoxPrototype;
	if (prototype.__omegaToolboxFramed) return;
	prototype.__omegaToolboxFramed = true;
	const originalRender = prototype.render;

	prototype.render = function patchedToolBoxRender(this: ToolBoxInternals, width: number): string[] {
		const theme = getToolboxTheme();
		if (!theme) return originalRender.call(this, width);
		try {
			if (this.hideComponent) return [];
			const frameWidth = Math.max(4, width);
			const source = !this.hasRendererDefinition()
				? this.contentText
				: this.getRenderShell() === "self"
					? this.selfRenderContainer
					: this.contentBox;
			const raw = source.render(frameWidth - 2);
			const color = this.isPartial ? "borderMuted" : this.result?.isError ? "error" : "success";
			const contentFingerprint = fingerprint(raw);
			const cacheable = this.imageComponents.length === 0;
			const cache = this.__omegaFrameCache;
			if (
				cacheable &&
				cache?.width === frameWidth &&
				cache.fingerprint === contentFingerprint &&
				cache.color === color &&
				cache.expanded === this.expanded
			)
				return cache.output;

			const content = collapseToolboxContent(trimBlankEdges(raw), this.expanded, theme);
			if (collapseAnchor && this.expanded && content.length > 0) {
				const anchor = collapseAnchorLine(theme);
				if (anchor) content.push(anchor);
			}
			const innerWidth = frameWidth - 2;
			const border = (text: string) => theme.fg(color, text);
			const output: string[] = [""];
			if (content.length > 0) {
				output.push(border(`╭${"─".repeat(innerWidth)}╮`));
				for (const line of content)
					output.push(`${border("│")}${padToWidth(stripBackgroundFills(line), innerWidth)}${border("│")}`);
				output.push(border(`╰${"─".repeat(innerWidth)}╯`));
			}
			for (let index = 0; index < this.imageComponents.length; index++) {
				const spacer = this.imageSpacers[index];
				if (spacer) output.push(...spacer.render(frameWidth));
				const image = this.imageComponents[index];
				if (image) output.push(...image.render(frameWidth));
			}
			if (output.length === 1) return [];
			if (cacheable)
				this.__omegaFrameCache = {
					width: frameWidth,
					fingerprint: contentFingerprint,
					color,
					expanded: this.expanded,
					output,
				};
			return output;
		} catch {
			return originalRender.call(this, width);
		}
	};
}
