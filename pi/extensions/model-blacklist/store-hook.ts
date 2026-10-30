import type { Provider } from "@earendil-works/pi-ai/compat";
import { unwrapProvider, wrapProvider } from "./provider-wrap.ts";
import type { CompiledRules } from "./rules.ts";

/**
 * The slice of pi-ai's `Models` collection (`ModelRuntime.models`) that every
 * composed provider passes through. `providers` and `setProvider` are public
 * fields on the runtime object but private in Pi's types.
 */
export interface ModelStoreLike {
	providers: Map<string, Provider>;
	setProvider(provider: Provider): void;
}

/**
 * The slice of Pi's `ModelRuntime` used here. `models` is where Pi stores the
 * final provider object, after built-in, `models.json`, and extension layers
 * have been composed; `updateModelSnapshot` is its private snapshot rebuild.
 */
export interface RuntimeLike {
	models?: Partial<ModelStoreLike>;
	updateModelSnapshot?(): void;
}

/** State read by the installed hook on every call, shared across `/reload`. */
export interface HookState {
	/** Rules from the latest application; while unset nothing is hidden. */
	rules?: CompiledRules;
}

export type InstallResult = "installed" | "already-installed" | "unsupported";

/** Marks a store as patched so `/reload` does not stack a second wrapper layer. */
const HOOK_MARKER = Symbol.for("pi.model-blacklist.store-hook");

type MarkedStore = ModelStoreLike & { [HOOK_MARKER]?: true };

/**
 * Wrap one provider with the rules current at call time.
 *
 * The predicate closes over `state`, not over a rule set, so a later
 * application (or a cleared state) changes what the existing wrapper hides
 * without replacing it. The base object is unwrapped first so nothing nests.
 */
function wrapFor(state: HookState, provider: Provider): Provider {
	const base = unwrapProvider(provider);
	return wrapProvider(base, (model) => state.rules?.isBlocked(base.id, model.id) ?? false);
}

/** Provider ids currently stored, or undefined when Pi's store is unavailable. */
export function storedProviderIds(runtime: RuntimeLike): string[] | undefined {
	const store = runtime.models;
	if (!store?.providers || !(store.providers instanceof Map)) return undefined;
	return [...store.providers.keys()];
}

/**
 * Filter providers where Pi stores them, after composition.
 *
 * Pi composes a new provider object from the built-in/extension base and the
 * `models.json` overlay, so filtering a provider object itself cannot survive:
 * composition re-adds `models.json` models and loses any marker on the wrapper.
 * Patching `setProvider` — the single funnel every composed provider is written
 * through — filters at the point of storage instead, and wrapping the providers
 * already stored covers the catalogue that exists before `session_start`.
 *
 * Existing entries are overwritten in the `providers` map directly, because
 * `setProvider` also supersedes any in-flight catalogue refresh for that
 * provider and would abort the startup refresh.
 *
 * Returns `"unsupported"` when Pi's runtime shape is unknown, so the caller can
 * report it instead of silently hiding nothing.
 */
export function installStoreHook(runtime: RuntimeLike, state: HookState): InstallResult {
	const store = runtime.models;
	if (!store?.providers || typeof store.setProvider !== "function" || !(store.providers instanceof Map))
		return "unsupported";
	const marked = store as MarkedStore;
	if (marked[HOOK_MARKER]) return "already-installed";

	const setProvider = store.setProvider.bind(store);
	store.setProvider = (provider: Provider): void => {
		setProvider(wrapFor(state, provider));
	};
	for (const [providerId, provider] of store.providers) {
		store.providers.set(providerId, wrapFor(state, provider));
	}

	Object.defineProperty(marked, HOOK_MARKER, { value: true, enumerable: false });
	return "installed";
}
