import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const bash = process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash";
const platform =
	process.platform === "win32"
		? `windows-${process.arch}`
		: process.platform === "darwin"
			? `darwin-${process.arch}`
			: `linux-${process.arch}`;
const executableName = process.platform === "win32" ? "omega.exe" : "omega";

function shellPath(path) {
	return process.platform === "win32" ? `/${path[0].toLowerCase()}${path.slice(2).replaceAll("\\", "/")}` : path;
}

test("creates an extractable Omega archive with the Omega release version", () => {
	const testRoot = mkdtempSync(join(repoRoot, ".tmp-omega-binary-build-"));
	const fakeBin = join(testRoot, "bin");
	const output = join(testRoot, "output");
	const outputArgument = shellPath(output);

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
				`export PATH="${shellPath(fakeBin)}:$PATH"; exec scripts/build-binaries.sh --skip-install --skip-deps --skip-build --platform "${platform}" --out "${outputArgument}"`,
			],
			{
				cwd: repoRoot,
				encoding: "utf8",
				env: process.env,
			},
		);

		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		const manifest = JSON.parse(readFileSync(join(output, platform, "package.json"), "utf8"));
		const omegaPackage = JSON.parse(readFileSync(join(repoRoot, "packages/omega-core/package.json"), "utf8"));
		assert.equal(manifest.version, omegaPackage.version);
		assert.equal(manifest.piConfig?.name, "omega");
		assert.equal(readFileSync(join(output, platform, executableName)).length, 0);
	} finally {
		rmSync(testRoot, { force: true, recursive: true });
	}
});
