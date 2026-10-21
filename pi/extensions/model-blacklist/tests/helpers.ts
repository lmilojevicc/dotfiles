import type { AnyModel, Provider } from "@earendil-works/pi-ai/compat";
import type { RuntimeLike } from "../registry-hook.ts";

/** Minimal model; wrapping only reads `id` and `provider`. */
export function model(id: string, provider = "test", type = "chat"): AnyModel {
	return { id, provider, type, name: id, api: "test-api", baseUrl: "http://example.invalid", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1, maxTokens: 1, reasoning: false } as unknown as AnyModel;
}

export interface FakeProviderOptions {
	/** Extra non-chat models reported by `getAllModels`. */
	allModels?: AnyModel[];
	/** Base credential-specific policy, applied before the blacklist wrapper. */
	filter?: (id: string) => boolean;
	filterAll?: (id: string) => boolean;
	withGetAllModels?: boolean;
}

/** Plain provider object shaped like the ones `composeModelProvider` returns. */
export function fakeProvider(id: string, chatIds: string[], options: FakeProviderOptions = {}): Provider {
	const chat = chatIds.map((chatId) => model(chatId, id));
	const all = [...chat, ...(options.allModels ?? [])];
	const provider = {
		id,
		name: id,
		baseUrl: "http://example.invalid",
		auth: { apiKey: { name: "test", check: async () => ({ type: "api_key", source: "test" }), resolve: async () => ({ auth: { apiKey: "test" }, source: "test" }) } },
		getModels: () => chat,
		...(options.withGetAllModels === false ? {} : { getAllModels: () => all }),
		...(options.filter ? { filterModels: (models: readonly AnyModel[]) => models.filter((entry) => options.filter!(entry.id)) } : {}),
		...(options.filterAll ? { filterAllModels: (models: readonly AnyModel[]) => models.filter((entry) => options.filterAll!(entry.id)) } : {}),
		stream: () => {
			throw new Error("not used in tests");
		},
		streamSimple: () => {
			throw new Error("not used in tests");
		},
	};
	return provider as unknown as Provider;
}

export function ids(models: readonly { id: string }[]): string[] {
	return models.map((entry) => entry.id);
}

/**
 * Mirrors `ModelRuntime`: a config registration composes a fresh provider and
 * drops any native one, replacing a wrapper installed earlier.
 */
export function fakeRuntime(): RuntimeLike & { providers: Map<string, Provider> } {
	const providers = new Map<string, Provider>();
	return {
		providers,
		registerProvider: (providerId, config) => {
			providers.set(providerId, fakeProvider(providerId, (config as { models: string[] }).models));
		},
		registerNativeProvider: (provider) => {
			providers.set(provider.id, provider);
		},
		getProvider: (providerId) => providers.get(providerId),
	};
}
