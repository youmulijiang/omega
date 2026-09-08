const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");

export interface ToolboxTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

/** Access Pi's live theme used by ToolExecutionComponent. */
export function getToolboxTheme(): ToolboxTheme | undefined {
	return (globalThis as Record<symbol, ToolboxTheme | undefined>)[THEME_KEY];
}
