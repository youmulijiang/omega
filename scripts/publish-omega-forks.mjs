#!/usr/bin/env node
/**
 * Publish the Omega fork stack to npm.
 *
 * The repository keeps upstream-identical package names so that
 * `git merge upstream/main` stays conflict-free and npm workspaces keep
 * linking the local packages. The fork identity is applied only to the
 * published artifacts, staged in a temp directory:
 *
 *   packages/ai           ->  @youmulijiang/pi-ai (carries the fork-only OAuth
 *                             token-registry fix in auth/oauth/load.ts)
 *   packages/coding-agent ->  @youmulijiang/pi-coding-agent, whose pi-ai
 *                             dependency is aliased to the fork
 *   packages/omega-core   ->  @youmulijiang/omega, whose coding-agent and
 *                             pi-ai dependencies are aliased to the forks
 *
 * Only the packages in FORK_PACKAGES are aliased. Everything else keeps its
 * official @earendil-works name (pi-mcp, pi-codemode, pi-tui, pi-durable,
 * pi-env, chord, pi-agent-core, pi-telemetry) or third-party name
 * (quickjs-wasi), because those official npm packages are used unmodified.
 *
 * Usage:
 *   node scripts/publish-omega-forks.mjs [options]
 *
 * Options:
 *   --dry-run     Build the staged packages and report what would be published.
 *   --skip-ai     Do not publish the pi-ai fork.
 *   --skip-fork   Do not publish the coding-agent fork.
 *   --skip-omega  Do not publish omega.
 *   --no-build    Reuse existing dist output instead of rebuilding.
 *   --tag <tag>   npm dist-tag. Defaults to "latest".
 *   --help        Show this help.
 *
 * The published omega depends on the forks via npm aliases, so users only ever
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
const AI_NAME = "@youmulijiang/pi-ai";
const UPSTREAM_AI = "@earendil-works/pi-ai";
const OMEGA_DIR = join(repoRoot, "packages", "omega-core");
const FORK_DIR = join(repoRoot, "packages", "coding-agent");
const AI_DIR = join(repoRoot, "packages", "ai");
/**
 * Upstream dependency name -> fork package name. This is the explicit
 * allowlist for alias rewriting: a staged manifest dependency is rewritten to
 * `npm:<fork>@<version>` only when its name appears here. All other
 * @earendil-works dependencies (pi-mcp, pi-codemode, pi-tui, pi-durable,
 * pi-env, chord, pi-agent-core, pi-telemetry) and third-party dependencies
 * (quickjs-wasi, ...) keep their official names and versions.
 */
const FORK_PACKAGES = new Map([
	[UPSTREAM_AI, AI_NAME],
	[UPSTREAM_CODING_AGENT, FORK_NAME],
]);
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
/** Entries the ai package publishes (its `files` field). Missing entries are skipped. */
const AI_ENTRIES = ["package.json", "README.md", "dist"];

function printUsage() {
	console.log(`Usage: node scripts/publish-omega-forks.mjs [options]

Publishes the Omega forks of pi-ai and pi-coding-agent plus the omega CLI, in
that order. The repository keeps upstream package names; the fork names and the
omega dependency aliases are applied only to the published artifacts.

Options:
  --dry-run     Build staged packages and report without publishing.
  --skip-ai     Only publish the coding-agent fork and omega.
  --skip-fork   Only publish pi-ai and omega.
  --skip-omega  Only publish the forks.
  --no-build    Reuse existing dist output.
  --tag <tag>   npm dist-tag (default: latest).
  --help        Show this help.
`);
}

function parseArgs(argv) {
	const options = {
		dryRun: false,
		skipAi: false,
		skipFork: false,
		skipOmega: false,
		build: true,
		tag: "latest",
	};
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--dry-run") options.dryRun = true;
		else if (arg === "--skip-ai") options.skipAi = true;
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

/**
 * Rewrite staged manifest dependencies listed in FORK_PACKAGES to
 * `npm:<fork>@<version>` aliases. Dependencies outside the allowlist are left
 * untouched so official packages stay official in the published artifacts.
 * `required` lists upstream names that must be present (and therefore aliased).
 */
function applyForkDependencyAliases(stageDir, aliasVersions, required = []) {
	const manifestPath = join(stageDir, "package.json");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	for (const upstreamName of required) {
		if (!manifest.dependencies?.[upstreamName]) {
			throw new Error(`${upstreamName} is not a dependency of the staged package; alias target unknown.`);
		}
	}
	for (const [upstreamName, forkName] of FORK_PACKAGES) {
		if (!manifest.dependencies?.[upstreamName]) continue;
		const alias = `npm:${forkName}@${aliasVersions[upstreamName]}`;
		if (manifest.dependencies[upstreamName] !== alias) {
			console.log(`  alias ${upstreamName} -> ${alias}`);
		}
		manifest.dependencies[upstreamName] = alias;
	}
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
	const aiManifest = readPackageJson(AI_DIR);
	const aiVersion = aiManifest.version;
	const forkManifest = readPackageJson(FORK_DIR);
	const forkVersion = forkManifest.version;
	console.log(
		`Omega fork publish — pi-ai ${aiVersion}, pi-coding-agent ${forkVersion}${options.dryRun ? " (dry run)" : ""}`,
	);

	// Fork versions follow the upstream lockstep, so the two forked packages
	// must carry the same version for the aliases to stay coherent.
	if (aiVersion !== forkVersion) {
		throw new Error(`Fork version mismatch: packages/ai is ${aiVersion}, packages/coding-agent is ${forkVersion}.`);
	}

	/** Alias versions keyed by the upstream dependency name being rewritten. */
	const aliasVersions = { [UPSTREAM_AI]: aiVersion, [UPSTREAM_CODING_AGENT]: forkVersion };
	const stagedDirectories = [];
	try {
		if (!options.skipAi) {
			if (options.build) buildPackage(AI_DIR);
			const aiStage = stage(AI_DIR, AI_ENTRIES);
			stagedDirectories.push(aiStage);
			applyForkIdentity(aiStage, AI_NAME);
			publish(aiStage, options);
		}

		if (!options.skipFork) {
			if (options.build) buildPackage(FORK_DIR);
			const forkStage = stage(FORK_DIR, FORK_ENTRIES);
			stagedDirectories.push(forkStage);
			applyForkIdentity(forkStage, FORK_NAME);
			applyForkDependencyAliases(forkStage, aliasVersions, [UPSTREAM_AI]);
			publish(forkStage, options);
		}

		if (!options.skipOmega) {
			if (options.build) buildPackage(OMEGA_DIR);
			const omegaStage = stage(OMEGA_DIR, ["package.json", "README.md", "dist"]);
			stagedDirectories.push(omegaStage);
			applyForkDependencyAliases(omegaStage, aliasVersions, [UPSTREAM_CODING_AGENT, UPSTREAM_AI]);
			publish(omegaStage, options);
		}
	} finally {
		for (const directory of stagedDirectories) rmSync(directory, { recursive: true, force: true });
	}

	console.log(options.dryRun ? "Dry run complete." : "Publish complete.");
}

mkdirSync(tmpdir(), { recursive: true });
main();
