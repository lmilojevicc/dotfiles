import type { BlacklistConfig } from "./config.ts";

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

export interface CompiledRules {
	/** Provider ids with at least one provider-scoped pattern, in config order. */
	providers: string[];
	/** Number of cross-provider patterns. */
	globalPatternCount: number;
	/** Total number of configured patterns. */
	patternCount: number;
	/** Whether one model id is hidden on one provider. */
	isBlocked(providerId: string, modelId: string): boolean;
	/** The patterns effective for one provider, for command output. */
	patternsFor(providerId: string): string[];
}

/** Compile global and per-provider patterns once per application. */
export function compileRules(config: BlacklistConfig): CompiledRules {
	const globalPatterns = config.global.map((pattern) => ({ pattern, regex: globToRegExp(pattern) }));
	const compiled = new Map<string, { pattern: string; regex: RegExp }[]>();
	const providers: string[] = [];
	for (const [providerId, patterns] of Object.entries(config.providers)) {
		compiled.set(providerId, patterns.map((pattern) => ({ pattern, regex: globToRegExp(pattern) })));
		providers.push(providerId);
	}

	const effective = (providerId: string): { pattern: string; regex: RegExp }[] => [
		...(compiled.get(providerId) ?? []),
		...globalPatterns,
	];

	return {
		providers,
		globalPatternCount: globalPatterns.length,
		patternCount: globalPatterns.length + [...compiled.values()].reduce((count, entries) => count + entries.length, 0),
		isBlocked: (providerId, modelId) => effective(providerId).some(({ regex }) => regex.test(modelId)),
		patternsFor: (providerId) => effective(providerId).map(({ pattern }) => pattern),
	};
}
