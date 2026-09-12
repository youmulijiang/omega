import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { OMEGA_VERSION } from "../src/version.ts";

it("uses the Omega package version in the source runtime", () => {
	const omegaPackage = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
		version: string;
	};
	expect(OMEGA_VERSION).toBe(omegaPackage.version);
});
