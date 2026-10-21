import type { Provider } from "@earendil-works/pi-ai/compat";
import { unwrapProvider, wrapProvider } from "./provider-wrap.ts";
import type { CompiledRules } from "./rules.ts";

/**
 * The slice of Pi's `ModelRuntime` the hook patches. Every provider
 * registration, from `pi.registerProvider()` or `ctx.modelRegistry`, ends in
 * one of these two methods on the session's single runtime instance.
 */
export interface RuntimeLike {
	registerProvider(providerId: string, config: unknown): void;
	registerNativeProvider(provider: Provider): void;
	getProvider(providerId: string): Provider | undefined;
}

/** State read by the hook on every registration, shared across `/reload`. */
export interface HookState {
	/** Rules from the latest application; the hook is inert until set. */
	rules?: CompiledRules;
	/** Provider ids currently wrapped, so a removed rule can be restored. */
	applied: Set<string>;
}

/** Marks a runtime as hooked so `/reload` does not stack a second patch. */
const HOOK_MARKER = Symbol.for("pi.model-blacklist.registry-hook");

function isTarget(rules: CompiledRules, providerId: string): boolean {
	return rules.globalPatternCount > 0 || rules.providers.includes(providerId);
}

function wrapWith(rules: CompiledRules, provider: Provider): Provider {
	return wrapProvider(provider, (model) => rules.isBlocked(provider.id, model.id));
}

/**
 * Re-apply the blacklist whenever a targeted provider registers again.
 *
 * Providers with a live catalogue (Command Code refreshes in the background
 * after startup) call `registerProvider` after `session_start`, which replaces
 * the wrapper installed there and exposes every hidden model. Pi has no event
 * for registry changes, so the hook patches the runtime instance itself: a
 * native registration is wrapped before it lands, and a config registration is
 * wrapped right after Pi composes it.
 */
export function installRegistryHook(runtime: RuntimeLike, state: HookState): boolean {
	const marked = runtime as RuntimeLike & { [HOOK_MARKER]?: true };
	if (marked[HOOK_MARKER]) return false;

	const registerProvider = runtime.registerProvider.bind(runtime);
	const registerNativeProvider = runtime.registerNativeProvider.bind(runtime);

	runtime.registerNativeProvider = (provider) => {
		const rules = state.rules;
		if (!rules || !isTarget(rules, provider.id) || unwrapProvider(provider) !== provider) {
			registerNativeProvider(provider);
			return;
		}
		registerNativeProvider(wrapWith(rules, provider));
		state.applied.add(provider.id);
	};

	runtime.registerProvider = (providerId, config) => {
		registerProvider(providerId, config);
		const rules = state.rules;
		if (!rules || !isTarget(rules, providerId)) return;
		const current = runtime.getProvider(providerId);
		if (!current || unwrapProvider(current) !== current) return;
		registerNativeProvider(wrapWith(rules, current));
		state.applied.add(providerId);
	};

	Object.defineProperty(marked, HOOK_MARKER, { value: true, enumerable: false });
	return true;
}
