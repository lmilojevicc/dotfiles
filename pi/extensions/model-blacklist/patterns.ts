/**
 * Model-id pattern parsing: full-string globs with `{a,b}` alternatives and
 * `<5.5`-style version comparisons, plus `3.8+` version thresholds.
 */

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
const PROBLEM_UNCLOSED_BRACE = "an unclosed { (write {opus,sonnet})";
const PROBLEM_STRAY_BRACE = "a } without a matching {";
const PROBLEM_NESTED_BRACE = "nested { } alternatives";
const PROBLEM_MISSING_COMPARISON = "a < or > without a numeric version (write gpt-<6*)";

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
	if (!body.endsWith("+")) {
		const glob = compileGlob(body);
		return "problem" in glob ? glob.problem : undefined;
	}
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
 * inside a threshold prefix. Any other entry is a glob, where `{a,b}` lists
 * alternatives and `<5.5`, `<=5.5`, `>5.5` or `>=5.5` matches the whole version
 * number at that position, so `*claude-{opus,sonnet}-<5.5*` hides
 * `claude-opus-4-8` and `claude-opus-5-high` but keeps `claude-opus-5-10`.
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
	const glob = compileGlob(body);
	if ("problem" in glob) return { pattern, negated, matches: () => false };
	return {
		pattern,
		negated,
		matches: (modelId) => {
			const id = modelId.toLowerCase();
			return glob.alternatives.some((tokens) => matchTokens(tokens, id));
		},
	};
}

type Operator = "<" | "<=" | ">" | ">=";

type Token =
	| { kind: "literal"; text: string }
	| { kind: "star" }
	| { kind: "any" }
	| { kind: "version"; operator: Operator; version: number[] };

const VERSION_AT = /\d+(?:[.-]\d+)*/y;

/** The maximal version run starting at `index`, e.g. `5-5` in `claude-opus-5-5-high`. */
function versionAt(text: string, index: number): string | undefined {
	VERSION_AT.lastIndex = index;
	return VERSION_AT.exec(text)?.[0];
}

function satisfies(version: readonly number[], operator: Operator, bound: readonly number[]): boolean {
	const order = compare(version, bound);
	if (operator === "<") return order < 0;
	if (operator === "<=") return order <= 0;
	if (operator === ">") return order > 0;
	return order >= 0;
}

/**
 * Expand `{a,b}` alternatives into plain glob bodies. `{,*\/}` allows an
 * empty alternative; nesting is rejected to keep patterns readable.
 */
function expandBraces(body: string): string[] | { problem: string } {
	const open = body.indexOf("{");
	const strayClose = body.indexOf("}");
	if (open === -1) return strayClose === -1 ? [body] : { problem: PROBLEM_STRAY_BRACE };
	if (strayClose !== -1 && strayClose < open) return { problem: PROBLEM_STRAY_BRACE };
	const close = body.indexOf("}", open);
	if (close === -1) return { problem: PROBLEM_UNCLOSED_BRACE };
	const inner = body.slice(open + 1, close);
	if (inner.includes("{")) return { problem: PROBLEM_NESTED_BRACE };
	const rest = expandBraces(body.slice(close + 1));
	if (!Array.isArray(rest)) return rest;
	const head = body.slice(0, open);
	return inner.split(",").flatMap((choice) => rest.map((tail) => head + choice + tail));
}

/** Split one brace-free glob body into tokens; `<`, `<=`, `>`, `>=` must precede a version. */
function tokenize(body: string): Token[] | { problem: string } {
	const tokens: Token[] = [];
	const text = body.toLowerCase();
	let index = 0;
	while (index < text.length) {
		const character = text[index]!;
		if (character === "*") {
			tokens.push({ kind: "star" });
			index += 1;
		} else if (character === "?") {
			tokens.push({ kind: "any" });
			index += 1;
		} else if (character === "<" || character === ">") {
			const operator = (text[index + 1] === "=" ? `${character}=` : character) as Operator;
			const version = versionAt(text, index + operator.length);
			if (!version) return { problem: PROBLEM_MISSING_COMPARISON };
			tokens.push({ kind: "version", operator, version: version.split(/[.-]/).map(Number) });
			index += operator.length + version.length;
		} else {
			const last = tokens.at(-1);
			if (last?.kind === "literal") last.text += character;
			else tokens.push({ kind: "literal", text: character });
			index += 1;
		}
	}
	return tokens;
}

function compileGlob(body: string): { alternatives: Token[][] } | { problem: string } {
	const bodies = expandBraces(body);
	if (!Array.isArray(bodies)) return bodies;
	const alternatives: Token[][] = [];
	for (const entry of bodies) {
		const tokens = tokenize(entry);
		if (!Array.isArray(tokens)) return tokens;
		alternatives.push(tokens);
	}
	return { alternatives };
}

const DIGIT = /\d/;

/**
 * Full-string match with backtracking over `*`. A version token reads the
 * whole digit run at its position and never starts mid-number, so `<5.5`
 * sees `5-5` in `claude-opus-5-5-high` rather than a leading `5`.
 */
function matchTokens(tokens: readonly Token[], id: string): boolean {
	const failed = new Set<number>();
	const step = (tokenIndex: number, position: number): boolean => {
		if (tokenIndex === tokens.length) return position === id.length;
		const key = tokenIndex * (id.length + 1) + position;
		if (failed.has(key)) return false;
		const token = tokens[tokenIndex]!;
		let matched = false;
		if (token.kind === "literal") {
			matched = id.startsWith(token.text, position) && step(tokenIndex + 1, position + token.text.length);
		} else if (token.kind === "any") {
			matched = position < id.length && step(tokenIndex + 1, position + 1);
		} else if (token.kind === "star") {
			for (let end = position; end <= id.length && !matched; end += 1) matched = step(tokenIndex + 1, end);
		} else if (position === 0 || !DIGIT.test(id[position - 1]!)) {
			const version = versionAt(id, position);
			matched =
				version !== undefined &&
				satisfies(version.split(/[.-]/).map(Number), token.operator, token.version) &&
				step(tokenIndex + 1, position + version.length);
		}
		if (!matched) failed.add(key);
		return matched;
	};
	return step(0, 0);
}
