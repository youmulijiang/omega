import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const bash = process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash";
const tar = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
const shellPath = (path) =>
	process.platform === "win32" ? `/${path[0].toLowerCase()}${path.slice(2).replaceAll("\\", "/")}` : path;

test("build-all.sh keeps the Windows icon in the extracted and archived output", () => {
	const testRoot = mkdtempSync(join(repoRoot, ".tmp-omega-build-all-icon-"));
	const fakeBin = join(testRoot, "bin");
	const output = join(testRoot, "output");
	const platform = "windows-x64";

	try {
		mkdirSync(fakeBin);
		const fakeBun = join(fakeBin, "bun");
		writeFileSync(
			fakeBun,
			`#!/usr/bin/env bash
set -euo pipefail
outfile=""
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "--outfile" ]]; then outfile="$2"; shift 2; else shift; fi
done
mkdir -p "$(dirname "$outfile")"
: > "$outfile"
`,
			{ mode: 0o755 },
		);
		chmodSync(fakeBun, 0o755);
		if (process.platform === "win32") {
			const fakeZip = join(fakeBin, "zip");
			writeFileSync(fakeZip, '#!/usr/bin/env bash\nset -euo pipefail\ntar.exe -a -cf "$2" *\n', { mode: 0o755 });
			chmodSync(fakeZip, 0o755);
			const fakeUnzip = join(fakeBin, "unzip");
			writeFileSync(fakeUnzip, '#!/usr/bin/env bash\nset -euo pipefail\ntar -xf "$2"\n', { mode: 0o755 });
			chmodSync(fakeUnzip, 0o755);
		}

		const result = spawnSync(
			bash,
			[
				"-lc",
				`export PATH="${shellPath(fakeBin)}:$PATH"; exec bash scripts/build-all.sh --skip-install --skip-deps --skip-build --skip-smoke-test --platform "${platform}" --out "${shellPath(output)}"`,
			],
			{ cwd: repoRoot, encoding: "utf8", env: process.env },
		);
		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		assert.equal(existsSync(join(output, platform, "omega.exe")), true);
		assert.deepEqual(
			readFileSync(join(output, platform, "omega.ico")),
			readFileSync(join(repoRoot, "icon/omega.ico")),
		);
		const archiveListing = spawnSync(
			process.platform === "win32" ? tar : "unzip",
			[process.platform === "win32" ? "-tf" : "-Z1", `omega-${platform}.zip`],
			{ cwd: output, encoding: "utf8" },
		);
		assert.equal(archiveListing.status, 0, archiveListing.stderr);
		assert.match(archiveListing.stdout, /(?:^|\/)omega\.ico(?:\r?\n|$)/m);
	} finally {
		rmSync(testRoot, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
	}
});

test("build-all.ps1 keeps the Windows icon in the extracted and archived output", { skip: process.platform !== "win32" }, () => {
	const testRoot = mkdtempSync(join(repoRoot, ".tmp-omega-build-all-ps1-icon-"));
	const output = join(testRoot, "output");
	const platform = "windows-x64";

	try {
		const command = `
function bun {
    $outIndex = [Array]::IndexOf($args, '--outfile')
    if ($outIndex -lt 0) { throw 'Missing --outfile' }
    [System.IO.File]::WriteAllBytes($args[$outIndex + 1], [byte[]]@())
    $global:LASTEXITCODE = 0
}
& '${join(repoRoot, "build/build-all.ps1").replaceAll("'", "''")}' -SkipInstall -SkipDeps -SkipBuild -SkipSmokeTest -Platform ${platform} -OutDir '${output.replaceAll("'", "''")}'
`;
		const result = spawnSync("pwsh", ["-NoProfile", "-Command", command], {
			cwd: repoRoot,
			encoding: "utf8",
			env: process.env,
		});
		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		assert.equal(existsSync(join(output, platform, "omega.exe")), true);
		assert.deepEqual(
			readFileSync(join(output, platform, "omega.ico")),
			readFileSync(join(repoRoot, "icon/omega.ico")),
		);
		const archiveListing = spawnSync(tar, ["-tf", `omega-${platform}.zip`], { cwd: output, encoding: "utf8" });
		assert.equal(archiveListing.status, 0, archiveListing.stderr);
		assert.match(archiveListing.stdout, /(?:^|\/)omega\.ico(?:\r?\n|$)/m);
	} finally {
		rmSync(testRoot, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
	}
});
