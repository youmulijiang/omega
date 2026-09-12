import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, expect, it, vi } from "vitest";
import { StartupHeader } from "../src/modes/interactive/components/startup-header.ts";

afterEach(() => vi.useRealTimers());

it("types onboarding only after the built-in header is rendered and spins while checking", async () => {
	vi.useFakeTimers();
	const requestRender = vi.fn();
	const header = new StartupHeader(
		{ requestRender } as unknown as TUI,
		"compact",
		"expanded",
		"> omega boot",
		(value) => value,
		false,
	);
	vi.advanceTimersByTime(500);
	expect(header.render(80).join("\n")).toContain("[|] checking");
	expect(header.render(80).join("\n")).not.toContain("> omega boot");
	vi.advanceTimersByTime(70);
	expect(header.render(80).join("\n")).toContain("> ");
	expect(header.render(80).join("\n")).toContain("[-] checking");
	header.setExpanded(true);
	expect(header.render(80).join("\n")).toContain("expanded");
	vi.advanceTimersByTime(1000);
	await header.whenComplete();
	expect(header.isComplete).toBe(true);
	expect(header.render(80).join("\n")).toContain("> omega boot");
	expect(header.render(80).join("\n")).toContain("[ok] checking complete");
	const renders = requestRender.mock.calls.length;
	vi.advanceTimersByTime(1000);
	expect(requestRender).toHaveBeenCalledTimes(renders);
});

it("cleans up its timer when disposed", () => {
	vi.useFakeTimers();
	const requestRender = vi.fn();
	const header = new StartupHeader(
		{ requestRender } as unknown as TUI,
		"compact",
		"expanded",
		"> omega boot",
		(value) => value,
		false,
	);
	header.render(80);
	header.dispose();
	vi.advanceTimersByTime(1000);
	expect(requestRender).not.toHaveBeenCalled();
});
