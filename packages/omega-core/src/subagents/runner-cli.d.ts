export interface InheritedCliArgs {
	extensionArgs: string[];
	alwaysProxy: string[];
	fallbackProvider?: string;
	fallbackModel?: string;
	fallbackThinking?: string;
	fallbackTools?: string;
	fallbackNoTools: boolean;
	sessionDir?: string;
	projectTrustOverride?: boolean;
}

export function getInheritedProjectTrustArgs(
	projectTrustOverride: boolean | undefined,
	inheritProjectApproval: boolean,
): string[];

export function selectInheritedPiArgv(argv: string[], env: NodeJS.ProcessEnv): string[];

export function parseInheritedCliArgs(argv: string[]): InheritedCliArgs;
