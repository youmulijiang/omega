import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { renderAsciiGlobe, renderGlobe, resolveGlobeRenderer } from "../src/ui/sidebar-art.ts";

describe("sidebar globe terminal support", () => {
	it.each([
		[{ WT_SESSION: "session" }, "win32", "braille"],
		[{ TERM_PROGRAM: "vscode" }, "win32", "braille"],
		[{ TERM: "xterm-256color", LANG: "en_US.UTF-8" }, "linux", "braille"],
		[{ TERM: "screen", LC_CTYPE: "UTF-8" }, "linux", "braille"],
		[{ TERM: "dumb", LANG: "en_US.UTF-8" }, "linux", "ascii"],
		[{ TERM: "linux", LANG: "en_US.UTF-8" }, "linux", "ascii"],
		[{ TERM_PROGRAM: "vscode", LC_ALL: "C", LANG: "en_US.UTF-8" }, "linux", "ascii"],
		[{}, "win32", "ascii"],
		[{}, "linux", "ascii"],
		[{ OMEGA_GLOBE_RENDERER: "ascii", WT_SESSION: "session" }, "win32", "ascii"],
		[{ OMEGA_GLOBE_RENDERER: "braille", TERM: "dumb" }, "linux", "braille"],
	] as const)("selects the renderer from %j on %s", (env, platform, expected) => {
		expect(resolveGlobeRenderer(env, platform)).toBe(expected);
	});
});

describe("sidebar globe rendering", () => {
	it.each([[42, 14], [20, 6], [1, 1], [1, 12], [40, 1]])("fits %i by %i terminal cells in both modes", (width, height) => {
		for (const renderer of ["ascii", "braille"] as const) {
			const frame = renderGlobe(width, height, 2_000, renderer);
			expect(frame).toHaveLength(height);
			expect(frame.every((line) => visibleWidth(line) === width)).toBe(true);
			if (renderer === "ascii") expect(frame.join("\n")).toMatch(/^[\x20-\x7e\n]*$/);
		}
	});

	it("renders dot patterns, rotates the surface and repeats after a full revolution", () => {
		const frame = renderGlobe(42, 14, 0, "braille");
		expect(frame.join("\n")).toMatch(/[\u2801-\u28ff]/);
		expect(frame).not.toEqual(renderGlobe(42, 14, 7_500, "braille"));
		expect(frame).toEqual(renderGlobe(42, 14, 30_000, "braille"));
		expect(renderGlobe(42, 14, 0, "ascii")).toEqual(renderAsciiGlobe(42, 14, 0));
	});

	it("keeps illumination toward the upper left and does not paint beyond the limb", () => {
		const width = 42;
		const height = 14;
		const totals = [0, 0];
		const radiusY = (height - 0.5) / 2;
		for (let step = 0; step < 12; step++) {
			const frame = renderGlobe(width, height, step * 2_500, "braille");
			for (let y = 0; y < height; y++) {
				for (let x = 0; x < width; x++) {
					const dots = frame[y]!.charCodeAt(x) - 0x2800;
					if (dots <= 0 || dots > 255) continue;
					for (const [dx, dy, mask] of [[0, 0, 1], [0, 1, 2], [0, 2, 4], [1, 0, 8], [1, 1, 16], [1, 2, 32], [0, 3, 64], [1, 3, 128]]) {
						if (!(dots & mask!)) continue;
						const nx = (x + (dx! + 0.5) / 2 - width / 2) / (radiusY * 2);
						const ny = (height / 2 - y - (dy! + 0.5) / 4) / radiusY;
						expect(nx * nx + ny * ny).toBeLessThanOrEqual(1);
						if (nx < 0 && ny > 0) totals[0]!++;
						if (nx > 0 && ny < 0) totals[1]!++;
					}
				}
			}
		}
		expect(totals[0]).toBeGreaterThan(totals[1]! * 1.3);
	});
});
