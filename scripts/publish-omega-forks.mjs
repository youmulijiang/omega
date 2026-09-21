#!/usr/bin/env node
/**
 * Publish the Omega fork stack to npm.
 *
 * The repository keeps upstream-identical package names so that
 * `git merge upstream/main` stays conflict-free and npm workspaces keep
 * linking the local packages. The fork identity is applied only to the
 * published artifacts, staged in a temp directory:
 *
 *   packages/coding-agent  ->  @youmulijiang/pi-coding-agent
 *   packages/omega-core    ->  @youmulijiang/omega, whose coding-agent
 *                              dependency is aliased to the fork
 *
 * Usage:
 *   node scripts/publish-omega-forks.mjs [options]
 *
 * Options:
 *   --dry-run     Build the staged packages and report what would be published.
 *   --skip-fork   Do not publish the coding-agent fork (only omega).
 *   --skip-omega  Do not publish omega (only the fork).
 *   --no-build    Reuse existing dist output instead of rebuilding.
 *   --tag <tag>   npm dist-tag. Defaults to "latest".
 *   --help        Show this help.
 *
 * The published omega depends on the fork via an npm alias, so users only ever
 * run `npm install -g @youmulijiang/omega` and get the patched coding agent
 * transparently.
 */

import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FORK_NAME = "@youmulijiang/pi-coding-agent";
const UPSTREAM_CODING_AGENT = "@earendil-works/pi-coding-agent";
const OMEGA_DIR = join(repoRoot, "packages", "omega-core");
const FORK_DIR = join(repoRoot, "packages", "coding-agent");
/** Entries the fork's `files` field publishes. Missing entries are skipped. */
const FORK_ENTRIES = [
	"package.json",
	"README.md",
	"CHANGELOG.md",
	"containerization.md",
	"docs",
	"examples",
	"dist",
	"npm-shrinkwrap.json",
];

function printUsage() {
	console.log(`Usage: node scripts/publish-omega-forks.mjs [options]

Publishes the Omega fork of pi-coding-agent and the omega CLI. The repository
keeps upstream package names; the fork name and the omega dependency alias are
applied only to the published artifacts.

Options:
  --dry-run     Build staged packages and report without publishing.
  --skip-fork   Only publish omega.
  --skip-omega  Only publish the fork.
  --no-build    Reuse existing dist output.
  --tag <tag>   npm dist-tag (default: latest).
  --help        Show this help.
`);
}

function parseArgs(argv) {
	const options = { dryRun: false, skipFork: false, skipOmega: false, build: true, tag: "latest" };
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--dry-run") options.dryRun = true;
		else if (arg === "--skip-fork") options.skipFork = true;
		else if (arg === "--skip-omega") options.skipOmega = true;
		else if (arg === "--no-build") options.build = false;
		else if (arg === "--tag") options.tag = argv[++index] ?? "latest";
		else if (arg === "--help" || arg === "-h") {
			printUsage();
			process.exit(0);
		} else {
			console.error(`Unknown option: ${arg}`);
			printUsage();
			process.exit(1);
		}
	}
	return options;
}

function readPackageJson(directory) {
	return JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
}

function run(command, args, cwd) {
	console.log(`$ ${command} ${args.join(" ")}`);
	const result = spawnSync(command, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
	if (result.status !== 0) {
		throw new Error(`Command failed (${result.status}): ${command} ${args.join(" ")}`);
	}
}

function buildPackage(directory) {
	run("npm", ["run", "build"], directory);
}

/** Copy publishable entries into a staging directory, skipping absent ones. */
function stage(directory, entries) {
	if (!existsSync(join(directory, "dist"))) {
		throw new Error(`Missing ${join(directory, "dist")}; build the workspace before publishing.`);
	}
	const stageDir = mkdtempSync(join(tmpdir(), "omega-publish-"));
	for (const entry of entries) {
		const source = join(directory, entry);
		if (!existsSync(source)) continue;
		cpSync(source, join(stageDir, entry), { recursive: true });
	}
	return stageDir;
}

/** Rewrite the staged package.json and shrinkwrap so the fork name is applied. */
function applyForkIdentity(stageDir, name) {
	const manifestPath = join(stageDir, "package.json");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	manifest.name = name;
	delete manifest.prepublishOnly;
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);

	const shrinkwrapPath = join(stageDir, "npm-shrinkwrap.json");
	if (existsSync(shrinkwrapPath)) {
		const shrinkwrap = JSON.parse(readFileSync(shrinkwrapPath, "utf8"));
		shrinkwrap.name = name;
		if (shrinkwrap.packages?.[""]) shrinkwrap.packages[""].name = name;
		writeFileSync(shrinkwrapPath, `${JSON.stringify(shrinkwrap, null, "\t")}\n`);
	}
	return manifest;
}

/** Point omega's coding-agent dependency at the published fork. */
function applyOmegaAlias(stageDir, forkVersion) {
	const manifestPath = join(stageDir, "package.json");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	if (!manifest.dependencies?.[UPSTREAM_CODING_AGENT]) {
		throw new Error(`${UPSTREAM_CODING_AGENT} is not a dependency of omega-core; alias target unknown.`);
	}
	manifest.dependencies[UPSTREAM_CODING_AGENT] = `npm:${FORK_NAME}@${forkVersion}`;
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
	return manifest;
}

function publish(stageDir, { dryRun, tag }) {
	const args = ["publish", stageDir, "--access", "public", "--tag", tag, "--ignore-scripts"];
	if (dryRun) args.push("--dry-run");
	run("npm", args, repoRoot);
}

function main() {
	const options = parseArgs(process.argv.slice(2));
	const forkManifest = readPackageJson(FORK_DIR);
	const forkVersion = forkManifest.version;
	console.log(`Omega fork publish — version ${forkVersion}${options.dryRun ? " (dry run)" : ""}`);

	const stagedDirectories = [];
	try {
		if (!options.skipFork) {
			if (options.build) buildPackage(FORK_DIR);
			const forkStage = stage(FORK_DIR, FORK_ENTRIES);
			stagedDirectories.push(forkStage);
			applyForkIdentity(forkStage, FORK_NAME);
			publish(forkStage, options);
		}

		if (!options.skipOmega) {
			if (options.build) buildPackage(OMEGA_DIR);
			const omegaStage = stage(OMEGA_DIR, ["package.json", "README.md", "dist"]);
			stagedDirectories.push(omegaStage);
			applyOmegaAlias(omegaStage, forkVersion);
			publish(omegaStage, options);
		}
	} finally {
		for (const directory of stagedDirectories) rmSync(directory, { recursive: true, force: true });
	}

	console.log(options.dryRun ? "Dry run complete." : "Publish complete.");
}

mkdirSync(tmpdir(), { recursive: true });
main();
