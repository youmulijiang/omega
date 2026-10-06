import type {
	Api,
	AssistantMessage,
	Context,
	Message,
	Model,
	ProviderHeaders,
	SimpleStreamOptions,
	UserMessage,
} from "@earendil-works/pi-ai";

export const BTW_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type BtwThinkingLevel = (typeof BTW_THINKING_LEVELS)[number];

export interface SideQuestionAuth {
	apiKey?: string;
	headers?: ProviderHeaders;
	env?: Record<string, string>;
}

export type CompleteSimpleFunction = <TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
) => Promise<AssistantMessage>;

export type SideThreadTurn =
	| {
			kind: "answered";
			question: string;
			answer: string;
			response: AssistantMessage;
	  }
	| {
			kind: "error";
			question: string;
			answer: string;
	  };

export interface SideThread {
	turns: SideThreadTurn[];
}

export function createSideThread(): SideThread {
	return { turns: [] };
}

export function buildSideThreadMessages(thread: SideThread, question: string): Message[] {
	const answeredTurns = thread.turns.filter(
		(turn): turn is Extract<SideThreadTurn, { kind: "answered" }> => turn.kind === "answered",
	);
	const messages: Message[] = [];

	if (answeredTurns.length === 0) {
		messages.push(createUserMessage(buildUserPrompt(question)));
		return messages;
	}

	const [first, ...rest] = answeredTurns;
	messages.push(createUserMessage(buildUserPrompt(first.question)), first.response);
	for (const turn of rest) {
		messages.push(createUserMessage(buildFollowUpPrompt(turn.question)), turn.response);
	}
	messages.push(createUserMessage(buildFollowUpPrompt(question)));
	return messages;
}

export interface CompleteSideThreadTurnOptions {
	thread: SideThread;
	model: Model<Api>;
	question: string;
	thinkingLevel: BtwThinkingLevel;
	auth: SideQuestionAuth;
	/** 主会话的只读投影；提供后侧线问答据此作答（见 buildSideThreadSystemPrompt）。 */
	mainContext?: string;
	signal?: AbortSignal;
	completeSimple: CompleteSimpleFunction;
}

export type CompleteSideThreadTurnResult =
	| { kind: "answered"; response: AssistantMessage; answer: string }
	| { kind: "aborted" }
	| { kind: "error"; message: string };

export async function completeSideThreadTurn({
	thread,
	model,
	question,
	thinkingLevel,
	auth,
	mainContext,
	signal,
	completeSimple,
}: CompleteSideThreadTurnOptions): Promise<CompleteSideThreadTurnResult> {
	if (signal?.aborted) return { kind: "aborted" };
	try {
		const response = await completeSimple(
			model,
			{
				systemPrompt: buildSideThreadSystemPrompt(mainContext),
				messages: buildSideThreadMessages(thread, question),
			},
			buildStreamOptions(auth, thinkingLevel, signal),
		);
		if (signal?.aborted || response?.stopReason === "aborted") return { kind: "aborted" };
		if (!isAssistantMessage(response)) {
			return { kind: "error", message: "The side model returned a malformed response." };
		}
		if (response.stopReason === "error") {
			return {
				kind: "error",
				message: response.errorMessage ?? "The side model returned an error.",
			};
		}

		const answer = extractAssistantText(response) || "No response received.";
		thread.turns.push({ kind: "answered", question, answer, response });
		return { kind: "answered", response, answer };
	} catch (error: unknown) {
		if (signal?.aborted) return { kind: "aborted" };
		return { kind: "error", message: formatError(error) };
	}
}

export interface CompleteSideQuestionOptions {
	model: Model<Api>;
	question: string;
	thinkingLevel: BtwThinkingLevel;
	auth: SideQuestionAuth;
	/** 主会话的只读投影；提供后侧线问答据此作答（见 buildSideThreadSystemPrompt）。 */
	mainContext?: string;
	signal?: AbortSignal;
	completeSimple: CompleteSimpleFunction;
}

export async function completeSideQuestion({
	model,
	question,
	thinkingLevel,
	auth,
	mainContext,
	signal,
	completeSimple,
}: CompleteSideQuestionOptions): Promise<AssistantMessage> {
	return completeSimple(
		model,
		{
			systemPrompt: buildSideThreadSystemPrompt(mainContext),
			messages: [createUserMessage(buildUserPrompt(question))],
		},
		buildStreamOptions(auth, thinkingLevel, signal),
	);
}

export function extractAssistantText(response: AssistantMessage): string {
	return response.content
		.filter(
			(content): content is { type: "text"; text: string } =>
				content !== null &&
				typeof content === "object" &&
				content.type === "text" &&
				typeof content.text === "string",
		)
		.map((content) => content.text)
		.join("\n")
		.trim();
}

function isAssistantMessage(value: unknown): value is AssistantMessage {
	if (value === null || typeof value !== "object") return false;
	const candidate = value as Partial<AssistantMessage>;
	return (
		candidate.role === "assistant" && Array.isArray(candidate.content) && typeof candidate.stopReason === "string"
	);
}

export function buildUserPrompt(question: string): string {
	return [
		"Answer this side question without modifying the main conversation.",
		"",
		"<side_question>",
		question,
		"</side_question>",
	].join("\n");
}

export function buildFollowUpPrompt(question: string): string {
	return ["Continue the same side conversation.", "", "<side_question>", question, "</side_question>"].join("\n");
}

function createUserMessage(text: string): UserMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};
}

function buildStreamOptions(
	auth: SideQuestionAuth,
	thinkingLevel: BtwThinkingLevel,
	signal?: AbortSignal,
): SimpleStreamOptions {
	const options: SimpleStreamOptions = {
		apiKey: auth.apiKey,
		headers: auth.headers,
		env: auth.env,
		signal,
	};
	if (thinkingLevel !== "off") options.reasoning = thinkingLevel;
	return options;
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

const SYSTEM_PROMPT = `You answer quick side questions for a coding-agent user.

Answer the user's side question directly and concisely. Do not claim to have changed files, run tools, or affected the main task.`;

/**
 * 侧线问答的系统提示。主会话上下文以只读块附加：侧线据此作答，但既不写入
 * 主会话，也不改动它。没有上下文时退化为纯隔离问答。
 */
export function buildSideThreadSystemPrompt(mainContext?: string): string {
	if (!mainContext?.trim()) return SYSTEM_PROMPT;
	return [
		SYSTEM_PROMPT,
		"",
		"The main conversation so far is included below as read-only context. Ground your answer in it when relevant.",
		"Never claim to have modified it, and do not add your answer to it.",
		"<main_conversation>",
		mainContext,
		"</main_conversation>",
	].join("\n");
}
