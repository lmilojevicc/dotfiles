import { accessSync, chmodSync, constants, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type ModelIdentity = { provider: string; id: string };
type FavoriteStore = { data: Record<string, unknown>; favorites: string[]; mode?: number };

// Legacy on-disk identity; never split it (model IDs can contain slashes).
export const favoriteKey = (model: ModelIdentity): string => `${model.provider}/${model.id}`;

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
export function toggleFavorite(model: ModelIdentity, agentDir: string): string[] {
	const store = readFavorites(agentDir);
	const path = join(agentDir, "model-favorites.json");
	if (store.mode !== undefined) {
		if (!(store.mode & 0o222)) throw new Error("model-favorites.json is read-only");
		accessSync(path, constants.W_OK);
	}
	const id = favoriteKey(model);
	const favorites = store.favorites.includes(id) ? store.favorites.filter((saved) => saved !== id) : [...store.favorites, id];
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
