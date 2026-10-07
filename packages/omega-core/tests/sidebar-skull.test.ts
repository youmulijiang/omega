import { describe, expect, it } from "vitest";
import { renderSkull, skullBrightness } from "../src/ui/sidebar-art.ts";

describe("renderSkull", () => {
	it("renders shaded bone, teeth highlights and bounded lines", () => {
		const lines = renderSkull(44, 17, 0);
		expect(lines).toHaveLength(17);
		for (const line of lines) expect(line).toHaveLength(44);
		const art = lines.join("\n");
		expect(art).toContain("@"); // tooth enamel highlights
		expect(art).toMatch(/[+*#]/); // lit cranium from the density ramp
	});

	it("keeps eye sockets darker than the brow ridge above them", () => {
		const socket = skullBrightness(-0.34, 0, 22, 9, 0);
		const brow = skullBrightness(-0.34, 0.26, 22, 7, 0);
		expect(socket).toBeLessThan(0.1);
		expect(brow).toBeGreaterThan(0.3);
	});

	it("animates the jaw and stays deterministic for a given timestamp", () => {
		const closed = renderSkull(44, 17, 0).join("\n");
		const open = renderSkull(44, 17, 1300).join("\n");
		expect(open).not.toEqual(closed);
		expect(renderSkull(20, 9, 4000)).toEqual(renderSkull(20, 9, 4000));
	});

	it("degenerates safely on tiny canvases", () => {
		const lines = renderSkull(1, 1, 0);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toHaveLength(1);
	});
});
