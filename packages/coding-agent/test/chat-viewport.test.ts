import { Container, Text } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import { renderLayoutFrame } from "../../tui/src/layout.ts";
import { createChatViewport, createChatViewportRoot } from "../src/modes/interactive/chat-viewport.ts";

describe("chat viewport", () => {
	test("defaults the transcript scrollbar to auto and accepts overrides", () => {
		const automatic = createChatViewport({
			document: new Container(),
			pendingMessages: new Container(),
			status: new Container(),
			editor: new Container(),
			footer: new Container(),
		});
		const hidden = createChatViewport({
			document: new Container(),
			pendingMessages: new Container(),
			status: new Container(),
			editor: new Container(),
			footer: new Container(),
			scrollbar: "hidden",
		});

		expect(automatic.transcript.scrollbar).toBe("auto");
		expect(hidden.transcript.scrollbar).toBe("hidden");
	});

	test("allocates and responsively hides a fixed-width sidebar", () => {
		const content = new Text("chat", 0, 0);
		const root = createChatViewportRoot(content, {
			component: new Text("sidebar", 0, 0),
			width: 44,
			side: "right",
			minTerminalWidth: 100,
			minTerminalHeight: 18,
		});

		const visible = renderLayoutFrame(root, 120, 24, () => {});
		const narrow = renderLayoutFrame(root, 99, 24, () => {});
		const short = renderLayoutFrame(root, 120, 17, () => {});

		expect(visible.root.children.map((child) => child.rect.width)).toEqual([76, 44]);
		const left = createChatViewportRoot(content, {
			component: new Text("sidebar", 0, 0),
			width: 44,
			side: "left",
			minTerminalWidth: 100,
			minTerminalHeight: 18,
		});
		expect(renderLayoutFrame(left, 120, 24, () => {}).root.children.map((child) => child.rect.width)).toEqual([
			44, 76,
		]);
		expect(narrow.root.children.map((child) => child.rect.width)).toEqual([99]);
		expect(short.root.children.map((child) => child.rect.width)).toEqual([120]);
		expect(createChatViewportRoot(content)).toBe(content);
	});
});
