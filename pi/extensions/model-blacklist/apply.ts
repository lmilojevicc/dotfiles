import type { Provider } from "@earendil-works/pi-ai/compat";
import { unwrapProvider, wrapProvider } from "./provider-wrap.ts";
import type { CompiledRules } from "./rules.ts";

export interface ProviderSource {
	getProvider(providerId: string): Provider | undefined;
	/** Every registered model, used to discover providers for global patterns. */
	getAll(): readonly { provider: string }[];
}

export interface ApplyResult {
	/** Providers filtered by this application. */
	applied: string[];
	/** Providers previously filtered whose models were made visible again. */
	restored: string[];
	/** Configured providers with no registered provider object. */
	missing: string[];
}

/**
 * Apply the compiled rules to a live registry and report what happened.
 *
 * Provider-scoped rules target exactly their provider. Cross-provider patterns
 * target every provider that currently exposes a model. Providers filtered by
 * an earlier application but absent from the current rules are restored to
 * their unwrapped provider, so removing a rule takes effect on the next
 * application instead of leaving a stale wrapper until the process restarts.
 */
export function applyBlacklist(options: {
	registry: ProviderSource;
	rules: CompiledRules;
	/** `pi.registerProvider`, accepting the full native provider form. */
	register: (provider: Provider) => void;
	/** Provider ids filtered by the previous application in this process. */
	previouslyApplied?: readonly string[];
}): ApplyResult {
	const targets = new Set(options.rules.providers);
	if (options.rules.globalPatternCount > 0) {
		for (const model of options.registry.getAll()) targets.add(model.provider);
	}

	const result: ApplyResult = { applied: [], restored: [], missing: [] };
	for (const providerId of options.previouslyApplied ?? []) {
		if (targets.has(providerId)) continue;
		const current = options.registry.getProvider(providerId);
		if (!current) continue;
		const base = unwrapProvider(current);
		if (base === current) continue;
		options.register(base);
		result.restored.push(providerId);
	}

	for (const providerId of targets) {
		const current = options.registry.getProvider(providerId);
		if (!current) {
			result.missing.push(providerId);
			continue;
		}
		const base = unwrapProvider(current);
		options.register(wrapProvider(base, (model) => options.rules.isBlocked(providerId, model.id)));
		result.applied.push(providerId);
	}

	return result;
}
