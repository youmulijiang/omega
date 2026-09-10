import type { Message } from "@earendil-works/pi-ai";
import type { SingleResult } from "./types.ts";

export function hasAttributedToolError(
	result: Pick<SingleResult, "stopReason" | "errorMessage" | "pendingToolError">,
): boolean;
export function processPiEvent(event: unknown, result: SingleResult): boolean;
export function processPiJsonLine(line: string, result: SingleResult): boolean;
export function getFinalAssistantText(messages: Message[]): string;
export function getProcessErrorText(result: SingleResult): string;
export function getResultSummaryText(result: SingleResult): string;
