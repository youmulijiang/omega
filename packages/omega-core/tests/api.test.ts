import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TUI, TuiInputListener, TuiStopOptions } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { createOmegaAPI } from "../src/api.ts";

describe("OmegaAPI TUI click events", () => {
	it("dispatches SGR click events and consumes handled clicks", () => {
		let inputListener: TuiInputListener | undefined;
		const removeInputListener = vi.fn();
		const originalStop = vi.fn((_options?: TuiStopOptions) => {});
		const tui = {
			addInputListener: vi.fn((listener: TuiInputListener) => {
				inputListener = listener;
				return removeInputListener;
			}),
			stop: originalStop,
		} as unknown as TUI;
		const omega = createOmegaAPI({} as ExtensionAPI);
		const handler = vi.fn(() => true);

		omega.registerTuiClick(tui, handler);
		const result = inputListener?.("\x1b[<20;12;7m");

		expect(handler).toHaveBeenCalledWith({
			x: 12,
			y: 7,
			button: "primary",
			shift: true,
			meta: false,
			ctrl: true,
		});
		expect(result).toEqual({ consume: true });

		tui.stop();
		expect(removeInputListener).toHaveBeenCalledOnce();
		expect(originalStop).toHaveBeenCalledOnce();
	});

	it("uses one monkey patch for multiple handlers and supports unsubscribe", () => {
		let inputListener: TuiInputListener | undefined;
		const tui = {
			addInputListener: vi.fn((listener: TuiInputListener) => {
				inputListener = listener;
				return vi.fn();
			}),
			stop: vi.fn(),
		} as unknown as TUI;
		const omega = createOmegaAPI({} as ExtensionAPI);
		const first = vi.fn();
		const second = vi.fn();

		const unsubscribe = omega.registerTuiClick(tui, first);
		omega.registerTuiClick(tui, second);
		unsubscribe();
		inputListener?.("\x1b[<0;2;3m");

		expect(tui.addInputListener).toHaveBeenCalledOnce();
		expect(first).not.toHaveBeenCalled();
		expect(second).toHaveBeenCalledOnce();
	});
});
