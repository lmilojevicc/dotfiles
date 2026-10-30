import { accessSync, chmodSync, constants, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type ModelIdentity = { provider: string; id: string };
type FavoriteStore = { data: Record<string, unknown>; favorites: string[]; mode?: number };

/**
 * Persisted identity: a JSON tuple, so a slash inside the provider or the ID can never
 * make two catalogue models share one stored favorite. `domain.modelKey` uses it too.
 */
export const favoriteKey = (model: ModelIdentity): string => JSON.stringify([model.provider, model.id]);
/** Pre-tuple on-disk identity. Only unambiguous while no provider name contains a slash. */
export const legacyFavoriteKey = (model: ModelIdentity): string => `${model.provider}/${model.id}`;

const tuple = (entry: string): string | undefined => {
	if (!entry.startsWith("[")) return undefined;
	let value: unknown;
	try { value = JSON.parse(entry); } catch { return undefined; }
	return Array.isArray(value) && value.length === 2 && value.every((part) => typeof part === "string" && part.length)
		? JSON.stringify(value) : undefined;
};

/**
 * Stored entries resolved against the caller's catalogue, keyed by canonical identity and
 * valued by stored order. Tuple entries resolve exactly; a legacy `provider/id` entry (which
 * cannot be split) names every catalogue model whose legacy join equals it. Unresolvable
 * entries are preserved in the file but rank nothing.
 */
export function favoriteIdentities(favorites: readonly string[], models: readonly ModelIdentity[]): Map<string, number> {
	const identities = new Map<string, number>();
	[...new Set(favorites)].forEach((entry, index) => {
		const key = tuple(entry);
		if (key !== undefined) { if (!identities.has(key)) identities.set(key, index); return; }
		for (const model of models) {
			const modelIdentity = favoriteKey(model);
			if (legacyFavoriteKey(model) === entry && !identities.has(modelIdentity)) identities.set(modelIdentity, index);
		}
	});
	return identities;
}

/** Absence is empty; invalid/unreadable stores throw and must never become a write source. */
export function readFavorites(agentDir: string): FavoriteStore {
	const path = join(agentDir, "model-favorites.json");
	let stat;
	try { stat = lstatSync(path); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { data: {}, favorites: [] };
		throw error;
	}
	if (!stat.isFile()) throw new Error("Use a regular model-favorites.json file");
	let data: unknown;
	try { data = JSON.parse(readFileSync(path, "utf8")); }
	catch (error) {
		if (error instanceof SyntaxError) throw new Error("Fix JSON in model-favorites.json");
		throw error;
	}
	if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("model-favorites.json must be an object");
	const root = data as Record<string, unknown>;
	const favorites = Object.hasOwn(root, "favorites") ? root.favorites : [];
	if (!Array.isArray(favorites) || favorites.some((id) => typeof id !== "string" || !id.length)) {
		throw new Error("favorites must be nonempty strings in an array");
	}
	return { data: root, favorites, mode: stat.mode & 0o777 };
}

/** Fresh read + atomic replacement, not a multi-process lock. Only explicit toggles write. */
export function toggleFavorite(model: ModelIdentity, agentDir: string, models: readonly ModelIdentity[] = [model]): string[] {
	const store = readFavorites(agentDir);
	const path = join(agentDir, "model-favorites.json");
	if (store.mode !== undefined) {
		if (!(store.mode & 0o222)) throw new Error("model-favorites.json is read-only");
		accessSync(path, constants.W_OK);
	}
	const key = favoriteKey(model);
	const identities = favoriteIdentities(store.favorites, models);
	let favorites: string[];
	if (identities.has(key)) {
		// Drop only this model. A shared legacy entry also named other catalogue models,
		// which keep their star by being rewritten as unambiguous tuples.
		const legacy = legacyFavoriteKey(model);
		const removed = new Set([key, legacy]);
		favorites = store.favorites.filter((saved) => !removed.has(saved));
		for (const other of models) {
			const otherKey = favoriteKey(other);
			if (otherKey !== key && legacyFavoriteKey(other) === legacy && identities.has(otherKey) &&
				!favorites.includes(otherKey)) favorites.push(otherKey);
		}
	} else favorites = [...store.favorites, key];
	const temporaryPath = `${path}.${process.pid}.${globalThis.crypto.randomUUID()}.tmp`;
	try {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(temporaryPath, `${JSON.stringify({ ...store.data, favorites }, null, "\t")}\n`, { encoding: "utf8", flag: "wx", mode: store.mode ?? 0o666 });
		// Creation is subject to umask; preserve an existing file's exact permissions.
		if (store.mode !== undefined) chmodSync(temporaryPath, store.mode);
		renameSync(temporaryPath, path);
	} catch (error) {
		try { unlinkSync(temporaryPath); } catch { /* Creation may have failed. */ }
		throw error;
	}
	return favorites;
}

export function favoritesError(error: unknown): string {
	const code = (error as NodeJS.ErrnoException)?.code;
	return `Favorites: ${code ? `${code}; check file access` : error instanceof Error ? error.message : "could not save"}`;
}
