import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { patternProblem } from "./patterns.ts";

/** Provider-scoped and cross-provider model-id patterns. */
export interface BlacklistConfig {
	/** Provider id to the patterns hidden on that provider. A `!`-prefixed pattern hides what it does not match. */
	providers: Record<string, string[]>;
	/** Patterns hidden on every provider. */
	global: string[];
}

export const EMPTY_CONFIG: BlacklistConfig = { providers: {}, global: [] };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate one patterns array. Invalid entries are reported and skipped; a
 * malformed container discards the whole array so a typo cannot hide nothing
 * while looking configured.
 */
function readPatterns(value: unknown, where: string, report: (detail: string) => void): string[] | undefined {
	if (value === undefined) return [];
	if (!Array.isArray(value)) {
		report(`"${where}" must be an array of model-id patterns; ignored`);
		return undefined;
	}
	const patterns: string[] = [];
	for (const entry of value) {
		if (typeof entry !== "string") {
			report(`"${where}" entries must be strings; skipped ${JSON.stringify(entry)}`);
			continue;
		}
		const pattern = entry.trim();
		if (!pattern) {
			report(`"${where}" contains an empty pattern; skipped`);
			continue;
		}
		// A lone negation would compile to a gate matching nothing, silently
		// hiding every model instead of the intended none, and a miswritten
		// `3.8-flash+` threshold would silently match nothing. Both are rejected
		// here so the session starts with a warning instead of a wrong surface.
		const problem = patternProblem(pattern);
		if (problem) {
			report(`"${where}" contains ${problem}; skipped`);
			continue;
		}
		patterns.push(pattern);
	}
	return patterns;
}

/**
 * Read the effective config on each application. The file is never created or
 * repaired here; a missing file means nothing is hidden. Malformed JSON or a
 * non-object root discards the file and warns once. Keys starting with "_" are
 * inert, so the checked-in file can carry examples next to the live rules.
 * A leading `!` negates a pattern: it hides every model the glob does not
 * match. The glob itself is never escaped, so `!` always negates. A trailing
 * `+` makes the pattern a version threshold, e.g. `gemini-3.8+`.
 */
export function readBlacklistConfig(
	warn: (message: string) => void,
	path: string = join(getAgentDir(), "model-blacklist.json"),
): BlacklistConfig {
	const report = (detail: string): void => warn(`Model blacklist config ${path}: ${detail}`);

	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			const reason = (error as NodeJS.ErrnoException).code ?? (error instanceof Error ? error.message : "cannot read");
			report(`${reason}; no models are hidden`);
		}
		return EMPTY_CONFIG;
	}

	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		report("invalid JSON; no models are hidden");
		return EMPTY_CONFIG;
	}
	if (!isRecord(value)) {
		report("expected a JSON object; no models are hidden");
		return EMPTY_CONFIG;
	}

	const global = readPatterns(value.global, "global", report) ?? [];
	const providers: Record<string, string[]> = {};
	const rawProviders = value.providers;
	if (rawProviders !== undefined) {
		if (!isRecord(rawProviders)) {
			report('"providers" must be an object; ignored');
		} else {
			for (const [providerId, patternsValue] of Object.entries(rawProviders)) {
				if (providerId.startsWith("_")) continue;
				const id = providerId.trim();
				if (!id) {
					report("empty provider id; skipped");
					continue;
				}
				const patterns = readPatterns(patternsValue, `providers.${id}`, report);
				if (patterns && patterns.length > 0) providers[id] = patterns;
			}
		}
	}
	return { providers, global };
}
