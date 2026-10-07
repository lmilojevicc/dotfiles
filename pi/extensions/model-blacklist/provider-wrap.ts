import type { AnyModel, Api, Credential, Model, Provider } from "@earendil-works/pi-ai/compat";

/**
 * Process-wide marker. `Symbol.for` survives the module re-evaluation that
 * `/reload` performs, so a wrapper left behind by a previous extension
 * instance can be unwrapped instead of wrapped again.
 */
export const BLACKLIST_MARKER = Symbol.for("pi.model-blacklist.wrapper");

interface MarkedProvider extends Provider {
	[BLACKLIST_MARKER]?: { base: Provider };
}

/** The original provider behind a blacklist wrapper, or the provider itself. */
export function unwrapProvider(provider: Provider): Provider {
	return (provider as MarkedProvider)[BLACKLIST_MARKER]?.base ?? provider;
}

/**
 * Wrap a provider so hidden models disappear from every read path Pi uses:
 * `getModels()`/`getAllModels()` remove them from the catalogue, and
 * `filterModels()`/`filterAllModels()` drop them from credential-filtered
 * availability. Authentication, streaming, discovery, and refresh stay bound
 * to the original provider object.
 */
export function wrapProvider(base: Provider, isBlocked: (model: { id: string }) => boolean): Provider {
	const baseGetModels = base.getModels.bind(base);
	const baseGetAllModels = base.getAllModels?.bind(base);
	const baseFilterModels = base.filterModels?.bind(base);
	const baseFilterAllModels = base.filterAllModels?.bind(base);

	const wrapper: Provider = {
		...base,
		getModels: () => baseGetModels().filter((model) => !isBlocked(model)),
		...(baseGetAllModels
			? { getAllModels: () => (baseGetAllModels() as readonly AnyModel[]).filter((model) => !isBlocked(model)) }
			: {}),
		filterModels: (models: readonly Model<Api>[], credential: Credential | undefined) =>
			(baseFilterModels ? baseFilterModels(models, credential) : models).filter((model) => !isBlocked(model)),
		filterAllModels: (models: readonly AnyModel[], credential: Credential | undefined) =>
			(baseFilterAllModels ? baseFilterAllModels(models, credential) : models).filter((model) => !isBlocked(model)),
	};

	Object.defineProperty(wrapper, BLACKLIST_MARKER, { value: { base }, enumerable: false });
	return wrapper;
}
