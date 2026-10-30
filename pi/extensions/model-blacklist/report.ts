import type { CompiledRules } from "./rules.ts";

export interface ApplicationReport {
	/**
	 * Whether Pi's model store could be read, so presence of configured providers
	 * is known. False when the runtime shape is unavailable and nothing is hidden.
	 */
	known: boolean;
	/** Providers present in the store whose models the rules apply to. */
	applied: string[];
	/** Configured providers with no stored provider object. */
	missing: string[];
}

/**
 * Describe what the rules match right now.
 *
 * Provider-scoped rules target exactly their provider; global patterns target
 * every provider that is currently stored. `providerIds` is undefined when the
 * store cannot be read, and then nothing is claimed about presence.
 */
export function describeApplication(rules: CompiledRules, providerIds: readonly string[] | undefined): ApplicationReport {
	if (!providerIds) return { known: false, applied: [], missing: [] };

	const present = new Set(providerIds);
	const applied = rules.providers.filter((providerId) => present.has(providerId));
	const missing = rules.providers.filter((providerId) => !present.has(providerId));
	if (rules.globalPatternCount > 0) {
		const listed = new Set(applied);
		for (const providerId of providerIds) {
			if (listed.has(providerId)) continue;
			applied.push(providerId);
			listed.add(providerId);
		}
	}
	return { known: true, applied, missing };
}

/**
 * The `/model-blacklist` report lines, without the config warnings.
 *
 * A global pattern applies to every stored provider, so listing each of them
 * would bury the interesting lines under the whole catalogue. Providers that
 * only receive the global patterns are collapsed into one line instead.
 */
export function formatReport(rules: CompiledRules, report: ApplicationReport): string[] {
	const lines: string[] = [`Model blacklist: ${rules.patternCount} pattern(s)`];
	const scoped = rules.providers;
	const globalOnly = report.applied.filter((providerId) => !scoped.includes(providerId));
	for (const providerId of report.applied) {
		if (globalOnly.includes(providerId)) continue;
		lines.push(`  ${providerId}: ${rules.patternsFor(providerId).join(", ")}`);
	}
	if (globalOnly.length > 0) lines.push(`  all other providers: ${rules.globalPatterns.join(", ")}`);
	if (report.missing.length > 0) lines.push(`Unknown providers (ignored): ${report.missing.join(", ")}`);
	if (report.known && report.applied.length === 0 && report.missing.length === 0)
		lines.push("No providers configured; no models are hidden");
	return lines;
}
