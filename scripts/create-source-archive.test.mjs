import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const bash = process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash";

test("reports the Omega package version for a mismatched Omega release tag", () => {
	const packageResult = spawnSync("git", ["show", "HEAD:packages/omega-core/package.json"], { encoding: "utf8" });
	assert.equal(packageResult.status, 0, packageResult.stderr);
	const { version } = JSON.parse(packageResult.stdout);
	const result = spawnSync(
		bash,
		[
			"scripts/create-source-archive.sh",
			"--version",
			"9.9.9",
			"--ref",
			"HEAD",
			"--version-package",
			"packages/omega-core/package.json",
			"--out",
			"unused.tar.gz",
		],
		{ encoding: "utf8" },
	);

	assert.equal(result.status, 1);
	assert.equal(result.stderr.trim(), `Version 9.9.9 does not match package version ${version} at HEAD`);
});
