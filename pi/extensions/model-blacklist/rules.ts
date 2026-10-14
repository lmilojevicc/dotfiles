import type { BlacklistConfig } from "./config.ts";
import { parseMatcher, type Matcher } from "./patterns.ts";

export { globToRegExp } from "./patterns.ts";

/**
 * A provider's entries are two halves, composed like `grep -v`. Plain patterns
 * hide what they match. `!`-prefixed patterns act as a gate, hiding every model
 * that matches none of them. Plain patterns win over the gate, so
 * `["!gpt-6*", "gpt-6-sol"]` shows the GPT-6 family minus `gpt-6-sol`, and a
 * provider with no `!` entry is untouched by the gate.
 */
function hides(entries: readonly Matcher[], modelId: string): boolean {
	if (entries.some((entry) => !entry.negated && entry.matches(modelId))) return true;
	const gate = entries.filter((entry) => entry.negated);
	return gate.length > 0 && !gate.some((entry) => entry.matches(modelId));
}

export interface CompiledRules {
	/** Provider ids with at least one provider-scoped pattern, in config order. */
	providers: string[];
	/** Number of cross-provider patterns. */
	globalPatternCount: number;
	/** Total number of configured patterns, negations and thresholds included. */
	patternCount: number;
	/** Whether one model id is hidden on one provider. */
	isBlocked(providerId: string, modelId: string): boolean;
	/** The patterns effective for one provider, for command output. */
	patternsFor(providerId: string): string[];
}

/** Compile global and per-provider patterns once per application. */
export function compileRules(config: BlacklistConfig): CompiledRules {
	const globalPatterns = config.global.map(parseMatcher);
	const compiled = new Map<string, Matcher[]>();
	const providers: string[] = [];
	for (const [providerId, patterns] of Object.entries(config.providers)) {
		compiled.set(providerId, patterns.map(parseMatcher));
		providers.push(providerId);
	}

	const effective = (providerId: string): Matcher[] => [...(compiled.get(providerId) ?? []), ...globalPatterns];

	return {
		providers,
		globalPatternCount: globalPatterns.length,
		patternCount: globalPatterns.length + [...compiled.values()].reduce((count, entries) => count + entries.length, 0),
		isBlocked: (providerId, modelId) => hides(effective(providerId), modelId),
		patternsFor: (providerId) => effective(providerId).map(({ pattern }) => pattern),
	};
}
