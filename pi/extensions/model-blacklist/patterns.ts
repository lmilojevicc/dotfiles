/** Model-id pattern parsing: full-string globs and `3.8+` version thresholds. */

/** Case-insensitive full-string glob matcher. `*` matches any run, `?` one character. */
export function globToRegExp(pattern: string): RegExp {
	let source = "^";
	for (const character of pattern) {
		if (character === "*") source += ".*";
		else if (character === "?") source += ".";
		else source += character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`${source}$`, "i");
}

/** `prefix3.8+`: ids continuing `prefix` with a version at or above `version`. */
interface Threshold {
	prefix: string;
	version: number[];
}

const THRESHOLD = /^(.*?)(\d+(?:[.-]\d+)*)\+$/;
const LEADING_VERSION = /^\d+(?:[.-]\d+)*/;

const PROBLEM_BARE_NEGATION = "a negation without a pattern";
const PROBLEM_MISSING_VERSION = "a trailing + without a numeric version (write gemini-3.8+, not gemini-3.8-flash+)";
const PROBLEM_MISSING_PREFIX = "a version threshold without a model-id prefix (e.g. gemini-3.8+)";

/** The threshold a pattern encodes, or undefined when it is not a version threshold. */
function parseThreshold(pattern: string): Threshold | undefined {
	const match = THRESHOLD.exec(pattern);
	if (!match || match[1] === "") return undefined;
	return { prefix: match[1], version: match[2]!.split(/[.-]/).map(Number) };
}

/** Compare dotted/dashed versions per segment, so 3.10 is newer than 3.9. */
function compare(left: readonly number[], right: readonly number[]): number {
	for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
		const a = left[index] ?? 0;
		const b = right[index] ?? 0;
		if (a !== b) return a < b ? -1 : 1;
	}
	return 0;
}

function versionOf(id: string): number[] | undefined {
	const match = LEADING_VERSION.exec(id);
	return match ? match[0].split(/[.-]/).map(Number) : undefined;
}

/**
 * Why a pattern cannot be used, or undefined when it is valid. A trailing `+`
 * is always a version threshold, so `gemini-3.8-flash+` is rejected at load
 * instead of silently matching nothing. The `+` version is the trailing run of
 * digits the id continues, and the rest must be a model-id prefix.
 */
export function patternProblem(pattern: string): string | undefined {
	if (pattern === "!") return PROBLEM_BARE_NEGATION;
	const body = pattern.startsWith("!") ? pattern.slice(1) : pattern;
	if (!body.endsWith("+")) return undefined;
	const match = THRESHOLD.exec(body);
	if (!match) return PROBLEM_MISSING_VERSION;
	return match[1] === "" ? PROBLEM_MISSING_PREFIX : undefined;
}

/** One configured pattern: a glob or a version threshold, optionally `!`-negated. */
export interface Matcher {
	/** The configured entry, negation and `+` included, for command output. */
	pattern: string;
	/** Whether the entry is `!`-prefixed, so models matching none of these are hidden. */
	negated: boolean;
	/** Whether one model id matches the entry. */
	matches(modelId: string): boolean;
}

/**
 * Compile one configured entry. Thresholds compare the id's leading version
 * numerically, so `gemini-3.8+` matches `gemini-3.8-flash`, `gemini-3.9-pro`
 * and `gemini-4-flash`, but not `gemini-3.7-flash`. Wildcards are literal
 * inside a threshold prefix.
 */
export function parseMatcher(pattern: string): Matcher {
	const negated = pattern.startsWith("!");
	const body = negated ? pattern.slice(1) : pattern;
	const threshold = parseThreshold(body);
	if (threshold) {
		const prefix = threshold.prefix.toLowerCase();
		return {
			pattern,
			negated,
			matches: (modelId) => {
				const id = modelId.toLowerCase();
				if (!id.startsWith(prefix)) return false;
				const version = versionOf(id.slice(prefix.length));
				return version !== undefined && compare(version, threshold.version) >= 0;
			},
		};
	}
	const regex = globToRegExp(body);
	return { pattern, negated, matches: (modelId) => regex.test(modelId) };
}
