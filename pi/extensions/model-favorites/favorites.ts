import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const FAVORITES_BASENAME = "model-favorites.json";
const PATCHED = Symbol.for("milo.pi.model-favorites.patched");

type FavoriteStore = {
	favorites?: string[];
};

export type ModelIdentity = {
	provider: string;
	id: string;
};

export type ModelItem<TModel extends ModelIdentity = ModelIdentity> = {
	provider: string;
	id: string;
	model: TModel;
};

const favoritesCache = new Map<string, { ids: string[]; fingerprint: number }>();

function favoritesPath(agentDir: string): string {
	return join(agentDir, FAVORITES_BASENAME);
}

function favoritesFingerprint(path: string): number {
	try {
		if (!existsSync(path)) return 0;
		const st = statSync(path);
		return st.mtimeMs + st.size;
	} catch {
		return 0;
	}
}

export function readFavorites(agentDir: string): string[] {
	const path = favoritesPath(agentDir);
	const fingerprint = favoritesFingerprint(path);
	const cached = favoritesCache.get(path);
	if (cached?.fingerprint === fingerprint) return cached.ids;

	try {
		if (!existsSync(path)) {
			favoritesCache.set(path, { ids: [], fingerprint });
			return [];
		}
		const parsed = JSON.parse(readFileSync(path, "utf8")) as FavoriteStore;
		const ids = Array.isArray(parsed.favorites)
			? parsed.favorites.filter((value): value is string => typeof value === "string" && value.length > 0)
			: [];
		favoritesCache.set(path, { ids, fingerprint });
		return ids;
	} catch {
		favoritesCache.set(path, { ids: [], fingerprint });
		return [];
	}
}

function writeFavorites(favorites: string[], agentDir: string): void {
	const path = favoritesPath(agentDir);
	mkdirSync(dirname(path), { recursive: true });
	const ids = [...new Set(favorites)];
	writeFileSync(
		path,
		`${JSON.stringify({ favorites: ids } satisfies FavoriteStore, null, "\t")}\n`,
		"utf8",
	);
	favoritesCache.delete(path);
}

export function fullModelId(model: ModelIdentity): string {
	return `${model.provider}/${model.id}`;
}

function modelsAreEqual(a: ModelIdentity | undefined, b: ModelIdentity | undefined): boolean {
	return !!a && !!b && a.provider === b.provider && a.id === b.id;
}

export function sortWithFavorites<TModel extends ModelIdentity>(
	items: ModelItem<TModel>[],
	currentModel: ModelIdentity | undefined,
	favorites: readonly string[],
): ModelItem<TModel>[] {
	const favoriteIndex = new Map(favorites.map((id, index) => [id, index]));
	return [...items].sort((a, b) => {
		const aFavoriteIndex = favoriteIndex.get(fullModelId(a.model));
		const bFavoriteIndex = favoriteIndex.get(fullModelId(b.model));

		if (aFavoriteIndex !== undefined || bFavoriteIndex !== undefined) {
			if (aFavoriteIndex === undefined) return 1;
			if (bFavoriteIndex === undefined) return -1;
			return aFavoriteIndex - bFavoriteIndex;
		}

		const aIsCurrent = modelsAreEqual(currentModel, a.model);
		const bIsCurrent = modelsAreEqual(currentModel, b.model);
		if (aIsCurrent && !bIsCurrent) return -1;
		if (!aIsCurrent && bIsCurrent) return 1;

		const providerOrder = a.provider.localeCompare(b.provider);
		return providerOrder !== 0 ? providerOrder : a.id.localeCompare(b.id);
	});
}

export function toggleFavorite(model: ModelIdentity, agentDir: string): boolean {
	const id = fullModelId(model);
	const favorites = readFavorites(agentDir);
	const index = favorites.indexOf(id);
	if (index >= 0) {
		writeFavorites([...favorites.slice(0, index), ...favorites.slice(index + 1)], agentDir);
		return false;
	}

	writeFavorites([...favorites, id], agentDir);
	return true;
}

export function applyPrototypePatchOnce(target: object, apply: () => void): boolean {
	const patchTarget = target as { [PATCHED]?: true };
	if (patchTarget[PATCHED]) return false;
	apply();
	patchTarget[PATCHED] = true;
	return true;
}
