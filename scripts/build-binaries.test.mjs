import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const bash = process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash";
function shellPath(path) {
	return process.platform === "win32" ? `/${path[0].toLowerCase()}${path.slice(2).replaceAll("\\", "/")}` : path;
}

test("creates an extractable Omega archive with the Omega release version", () => {
	const testRoot = mkdtempSync(join(repoRoot, ".tmp-omega-binary-build-"));
	const fakeBin = join(testRoot, "bin");
	const output = join(testRoot, "output");
	const outputArgument = shellPath(output);
	const buildPlatform = "linux-x64";
	const buildExecutable = "omega";

	try {
		mkdirSync(fakeBin);
		const fakeBun = join(fakeBin, "bun");
		writeFileSync(
			fakeBun,
			`#!/usr/bin/env bash
set -euo pipefail
outfile=""
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "--outfile" ]]; then
    outfile="$2"
    shift 2
  else
    shift
  fi
done
mkdir -p "$(dirname "$outfile")"
: > "$outfile"
`,
			{ mode: 0o755 },
		);
		chmodSync(fakeBun, 0o755);
		if (process.platform === "win32") {
			const fakeZip = join(fakeBin, "zip");
			writeFileSync(
				fakeZip,
				'#!/usr/bin/env bash\nset -euo pipefail\ntar.exe -a -cf "$2" *\n',
				{ mode: 0o755 },
			);
			chmodSync(fakeZip, 0o755);
			const fakeUnzip = join(fakeBin, "unzip");
			writeFileSync(fakeUnzip, '#!/usr/bin/env bash\nset -euo pipefail\ntar -xf "$2"\n', { mode: 0o755 });
			chmodSync(fakeUnzip, 0o755);
		}

		const result = spawnSync(
			bash,
			[
				"-lc",
				`export PATH="${shellPath(fakeBin)}:$PATH"; exec scripts/build-binaries.sh --skip-install --skip-build --platform "${buildPlatform}" --out "${outputArgument}"`,
			],
			{
				cwd: repoRoot,
				encoding: "utf8",
				env: process.env,
			},
		);

		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		const manifest = JSON.parse(readFileSync(join(output, buildPlatform, "package.json"), "utf8"));
		const omegaPackage = JSON.parse(readFileSync(join(repoRoot, "packages/omega-core/package.json"), "utf8"));
		assert.equal(manifest.version, omegaPackage.version);
		assert.equal(manifest.piConfig?.name, "omega");
		assert.equal(
			readFileSync(join(output, buildPlatform, "README.md"), "utf8"),
			readFileSync(join(repoRoot, "README.md"), "utf8"),
		);
		assert.equal(readFileSync(join(output, buildPlatform, buildExecutable)).length, 0);
	} finally {
		rmSync(testRoot, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
	}
});

test("preserves the configured Omega ICO source", () => {
	const testRoot = mkdtempSync(join(tmpdir(), "omega-icon-"));
	const output = join(testRoot, "omega.ico");
	const source = readFileSync(join(repoRoot, "icon/omega.ico"));

	try {
		const result = spawnSync(
			process.execPath,
			[join(repoRoot, "scripts/create-windows-icon.mjs"), join(repoRoot, "icon/omega.ico"), output],
			{ encoding: "utf8" },
		);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(existsSync(output), true);
		const icon = readFileSync(output);
		assert.equal(icon.readUInt16LE(2), 1);
		assert.deepEqual(icon, source);
		const copiedOutput = join(testRoot, "copied.ico");
		const copyResult = spawnSync(process.execPath, [join(repoRoot, "scripts/create-windows-icon.mjs"), output, copiedOutput], {
			encoding: "utf8",
		});
		assert.equal(copyResult.status, 0, copyResult.stderr);
		assert.deepEqual(readFileSync(copiedOutput), icon);
	} finally {
		rmSync(testRoot, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
	}
});

test("converts the Omega PNG to a multi-size ICO", () => {
	const testRoot = mkdtempSync(join(tmpdir(), "omega-png-icon-"));
	const output = join(testRoot, "omega.ico");

	try {
		const result = spawnSync(
			process.execPath,
			[join(repoRoot, "scripts/create-windows-icon.mjs"), join(repoRoot, "icon/omega.png"), output],
			{ encoding: "utf8" },
		);
		assert.equal(result.status, 0, result.stderr);
		const icon = readFileSync(output);
		assert.equal(icon.readUInt16LE(2), 1);
		assert.equal(icon.readUInt16LE(4), 7);
		assert.equal(icon.readUInt8(6), 16);
		assert.equal(icon.readUInt8(7), 16);
		const firstImageOffset = icon.readUInt32LE(18);
		assert.deepEqual(
			icon.subarray(firstImageOffset, firstImageOffset + 8),
			Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		);
	} finally {
		rmSync(testRoot, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
	}
});
