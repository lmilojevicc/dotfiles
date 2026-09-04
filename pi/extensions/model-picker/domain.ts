import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { fuzzyFilter } from "@earendil-works/pi-tui";

export type PickerModel = Model<Api>;
export const modelKey = (model: Pick<PickerModel, "provider" | "id">): string =>
	JSON.stringify([model.provider, model.id]);
export const modelLabel = (model: Pick<PickerModel, "provider" | "id">): string =>
	`${model.provider}/${model.id}`;

/** A nonempty session scope is a constraint, not an ordering preference. */
export function catalogue(ctx: Pick<ExtensionContext, "scopedModels" | "modelRegistry">): PickerModel[] {
	const models = ctx.scopedModels.length
		? ctx.scopedModels.map(({ model }) => model)
		: ctx.modelRegistry.getAvailable();
	return [...new Map(models.map((model) => [modelKey(model), model])).values()];
}

const normalize = (value: string): string => value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
export function searchTier(model: PickerModel, query: string): number {
	const needle = normalize(query);
	const fields = [model.id, modelLabel(model), model.name, model.provider].map(normalize);
	if (!needle) return 2;
	if (fields.some((field) => field === needle)) return 0;
	if (fields.some((field) => field.includes(needle))) return 1;
	return 2;
}

export function searchModels(models: readonly PickerModel[], query: string): PickerModel[] {
	if (!query.trim()) return [...models];
	// Include punctuation-insensitive exact/substring matches even when raw fuzzy matching misses.
	const fuzzy = fuzzyFilter([...models], query, (model) => `${modelLabel(model)} ${model.name}`);
	const matches = new Map(fuzzy.map((model) => [modelKey(model), model]));
	for (const model of models) if (searchTier(model, query) < 2) matches.set(modelKey(model), model);
	return [...matches.values()].sort((a, b) => searchTier(a, query) - searchTier(b, query));
}

export function providerCounts(models: readonly PickerModel[], matches: readonly PickerModel[]): Map<string, number> {
	const counts = new Map([...new Set(models.map((model) => model.provider))].sort().map((provider) => [provider, 0]));
	for (const model of matches) counts.set(model.provider, (counts.get(model.provider) ?? 0) + 1);
	return counts;
}
