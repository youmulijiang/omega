import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface ScopeEntry {
	value: string;
	type?: string;
}

export interface ScopeDefinition {
	path: string;
	exists: boolean;
	inclusions: ScopeEntry[];
	exclusions: ScopeEntry[];
}

type ScopeSection = "inclusion" | "exclusions" | undefined;

const TARGET_FIELD_PATTERN = /^(?:command|url|uri|host|hostname|domain|target|address|endpoint|origin|baseurl)$/i;
const URL_PATTERN = /https?:\/\/[^\s"'<>]+/gi;
const IPV4_PATTERN = /\b(?:\d{1,3}\.){3}\d{1,3}(?:\/\d{1,2})?\b/g;
const DOMAIN_PATTERN = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\b/gi;

function normalizeEntry(line: string): string | undefined {
	const match = /^\s*[-*+]\s+(?:\[[ xX]\]\s*)?(.+?)\s*$/.exec(line);
	const value = match?.[1]?.trim().replace(/^`|`$/g, "");
	return value || undefined;
}

function entryKey(entry: ScopeEntry): string {
	return `${entry.type ?? ""}\0${entry.value}`;
}

function uniqueEntries(entries: ScopeEntry[]): ScopeEntry[] {
	const seen = new Set<string>();
	return entries.filter((entry) => {
		const key = entryKey(entry);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function normalizeType(heading: string): string {
	return heading
		.trim()
		.toLowerCase()
		.split(/[\s（(]/, 1)[0];
}

export function parseScopeMarkdown(content: string, path = "scope.md"): ScopeDefinition {
	const inclusions: ScopeEntry[] = [];
	const exclusions: ScopeEntry[] = [];
	let section: ScopeSection;
	let entryType: string | undefined;

	for (const line of content.split(/\r?\n/)) {
		const levelTwoHeading = /^\s*##\s+(.+?)\s*$/.exec(line)?.[1]?.toLowerCase();
		if (levelTwoHeading) {
			section =
				levelTwoHeading === "inclusion" ? "inclusion" : levelTwoHeading === "exclusions" ? "exclusions" : undefined;
			entryType = undefined;
			continue;
		}
		const levelThreeHeading = /^\s*###\s+(.+?)\s*$/.exec(line)?.[1];
		if (levelThreeHeading) {
			entryType = section ? normalizeType(levelThreeHeading) : undefined;
			continue;
		}
		const value = normalizeEntry(line);
		if (!value || !section) continue;
		const entry: ScopeEntry = { value, ...(entryType ? { type: entryType } : {}) };
		if (section === "inclusion") inclusions.push(entry);
		else exclusions.push(entry);
	}

	return { path, exists: true, inclusions: uniqueEntries(inclusions), exclusions: uniqueEntries(exclusions) };
}

export async function loadScope(cwd: string): Promise<ScopeDefinition> {
	const path = join(cwd, ".omega", "agent", "scope.md");
	try {
		return parseScopeMarkdown(await readFile(path, "utf8"), path);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			return { path, exists: false, inclusions: [], exclusions: [] };
		}
		throw error;
	}
}

function validIpv4(value: string): boolean {
	const parts = value.split(".");
	return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function ipv4Number(value: string): number | undefined {
	if (!validIpv4(value)) return undefined;
	return value.split(".").reduce((result, part) => (result * 256 + Number(part)) >>> 0, 0);
}

function cidrContains(cidr: string, candidate: string): boolean {
	const [networkText, prefixText] = cidr.split("/");
	const candidateAddress = candidate.split("/", 1)[0];
	const network = ipv4Number(networkText);
	const address = ipv4Number(candidateAddress);
	const prefix = Number(prefixText);
	if (network === undefined || address === undefined || !Number.isInteger(prefix) || prefix < 0 || prefix > 32)
		return false;
	const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
	return (network & mask) >>> 0 === (address & mask) >>> 0;
}

function targetHostname(target: string): string | undefined {
	try {
		return new URL(target).hostname.toLowerCase();
	} catch {
		return DOMAIN_PATTERN.test(target) ? target.toLowerCase() : undefined;
	} finally {
		DOMAIN_PATTERN.lastIndex = 0;
	}
}

function inferredType(value: string): string {
	if (/^https?:\/\//i.test(value)) return "url";
	if (value.includes("/") && ipv4Number(value.split("/", 1)[0]) !== undefined) return "cidr";
	if (ipv4Number(value) !== undefined) return "ip";
	return "domain";
}

export function scopeEntryMatchesTarget(entry: ScopeEntry, target: string): boolean {
	const type = entry.type ?? inferredType(entry.value);
	const configured = entry.value.trim().toLowerCase();
	const candidate = target.trim().toLowerCase();

	if (type === "cidr") return cidrContains(configured, candidate);
	if (type === "ip") return candidate.split("/", 1)[0] === configured;
	if (type === "url") {
		try {
			const allowed = new URL(configured);
			const requested = new URL(candidate);
			if (allowed.origin !== requested.origin) return false;
			const allowedPath = allowed.pathname.replace(/\/$/, "");
			return !allowedPath || requested.pathname === allowedPath || requested.pathname.startsWith(`${allowedPath}/`);
		} catch {
			return candidate === configured;
		}
	}
	if (type === "domain") {
		const domain = configured.replace(/^\*\./, "").replace(/^\./, "");
		const hostname = targetHostname(candidate);
		return hostname === domain || hostname?.endsWith(`.${domain}`) === true;
	}
	return candidate === configured;
}

export function scopeContainsTarget(entries: ScopeEntry[], target: string): boolean {
	return entries.some((entry) => scopeEntryMatchesTarget(entry, target));
}

function extractFromString(value: string, includeDomains: boolean): string[] {
	const urls = [...value.matchAll(URL_PATTERN)].map((match) => match[0].replace(/[),.;]+$/, ""));
	const urlHosts = new Set(urls.map((url) => new URL(url).hostname.toLowerCase()));
	const targets = [...urls];
	targets.push(
		...[...value.matchAll(IPV4_PATTERN)]
			.map((match) => match[0])
			.filter((candidate) => validIpv4(candidate.split("/", 1)[0]) && !urlHosts.has(candidate.split("/", 1)[0])),
	);
	if (includeDomains) {
		targets.push(
			...[...value.matchAll(DOMAIN_PATTERN)]
				.map((match) => match[0].toLowerCase())
				.filter((candidate) => !urlHosts.has(candidate)),
		);
	}
	URL_PATTERN.lastIndex = 0;
	IPV4_PATTERN.lastIndex = 0;
	DOMAIN_PATTERN.lastIndex = 0;
	return targets;
}

export function extractTargetsFromInput(input: unknown): string[] {
	const targets: string[] = [];
	const visit = (value: unknown, field?: string): void => {
		if (typeof value === "string") {
			targets.push(...extractFromString(value, field === undefined || TARGET_FIELD_PATTERN.test(field)));
			return;
		}
		if (Array.isArray(value)) {
			for (const item of value) visit(item, field);
			return;
		}
		if (typeof value !== "object" || value === null) return;
		for (const [key, item] of Object.entries(value)) visit(item, key);
	};
	visit(input);
	return [...new Set(targets)];
}
