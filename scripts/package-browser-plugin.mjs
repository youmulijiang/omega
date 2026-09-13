import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = join(repoRoot, "plugins", "browser-plugin");
const outDir = join(repoRoot, "out", "plugins");
const archivePath = join(outDir, "browser-plugin.zip");

mkdirSync(outDir, { recursive: true });

if (process.platform === "win32") {
	execFileSync(
		"powershell.exe",
		["-NoProfile", "-Command", `Compress-Archive -Path (Join-Path '${sourceDir.replaceAll("'", "''")}' '*') -DestinationPath '${archivePath}' -Force`],
		{ stdio: "inherit" },
	);
} else {
	execFileSync("zip", ["-r", archivePath, "."], { cwd: sourceDir, stdio: "inherit" });
}

console.log(`  ${archivePath}`);
