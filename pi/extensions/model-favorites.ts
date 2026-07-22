import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	getAgentDir,
	getSelectListTheme,
	ModelSelectorComponent,
	rawKeyHint,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { modelsAreEqual, type Model } from "@earendil-works/pi-ai";
import { fuzzyFilter, matchesKey, Spacer, Text } from "@earendil-works/pi-tui";

const PATCHED = Symbol.for("milo.pi.model-favorites.patched");
const FAVORITE_KEY = "ctrl+f";
const FAVORITES_PATH = join(getAgentDir(), "model-favorites.json");
const MAX_VISIBLE = 10;
const FAVORITE_MARK = "★";

type ModelItem = {
	provider: string;
	id: string;
	model: Model<any>;
};

type FavoriteStore = {
	favorites?: string[];
};

type MutableModelSelector = {
	allModels: ModelItem[];
	scopedModelItems: ModelItem[];
	activeModels: ModelItem[];
	filteredModels: ModelItem[];
	selectedIndex: number;
	currentModel?: Model<any>;
	scope?: "all" | "scoped";
	searchInput: {
		getValue(): string;
		handleInput(data: string): void;
	};
	listContainer: {
		clear(): void;
		addChild(component: unknown): void;
	};
	errorMessage?: string;
	tui?: { requestRender(): void };
	updateList(): void;
	filterModels(query: string): void;
};

type ModelSelectorPrototype = {
	[PATCHED]?: true;
	loadModels: (this: MutableModelSelector) => Promise<void>;
	sortModels: (this: MutableModelSelector, models: ModelItem[]) => ModelItem[];
	filterModels: (this: MutableModelSelector, query: string) => void;
	updateList: (this: MutableModelSelector) => void;
	handleInput: (this: MutableModelSelector, data: string) => void;
};

/** Cache favorites between keystrokes; invalidated on write. */
let favoritesCache: { ids: string[]; fingerprint: number } | undefined;

function favoritesFingerprint(): number {
	try {
		if (!existsSync(FAVORITES_PATH)) return 0;
		const st = statSync(FAVORITES_PATH);
		return st.mtimeMs + st.size;
	} catch {
		return 0;
	}
}

function readFavorites(): string[] {
	const fp = favoritesFingerprint();
	if (favoritesCache && favoritesCache.fingerprint === fp) return favoritesCache.ids;

	try {
		if (!existsSync(FAVORITES_PATH)) {
			favoritesCache = { ids: [], fingerprint: fp };
			return [];
		}
		const parsed = JSON.parse(readFileSync(FAVORITES_PATH, "utf8")) as FavoriteStore;
		const ids = Array.isArray(parsed.favorites)
			? parsed.favorites.filter((value): value is string => typeof value === "string" && value.length > 0)
			: [];
		favoritesCache = { ids, fingerprint: fp };
		return ids;
	} catch {
		favoritesCache = { ids: [], fingerprint: fp };
		return [];
	}
}

function writeFavorites(favorites: string[]): void {
	mkdirSync(dirname(FAVORITES_PATH), { recursive: true });
	const ids = [...new Set(favorites)];
	writeFileSync(
		FAVORITES_PATH,
		`${JSON.stringify({ favorites: ids } satisfies FavoriteStore, null, "\t")}\n`,
		"utf8",
	);
	favoritesCache = undefined;
}

function fullModelId(model: Pick<Model<any>, "provider" | "id">): string {
	return `${model.provider}/${model.id}`;
}

/**
 * Match upstream getModelSelectorSearchText (not a public export):
 * provider-first ranking so bare ids don't beat provider/id proxies.
 */
function getModelSelectorSearchText(item: {
	id: string;
	provider: string;
	name?: string;
}): string {
	const name = item.name ? ` ${item.name}` : "";
	return `${item.provider} ${item.provider}/${item.id} ${item.provider} ${item.id}${name}`;
}

function favoriteIndexById(): Map<string, number> {
	return new Map(readFavorites().map((id, index) => [id, index]));
}

function isFavoriteIn(model: Model<any> | undefined, favoriteIndex: Map<string, number>): boolean {
	return !!model && favoriteIndex.has(fullModelId(model));
}

function sortWithFavorites(items: ModelItem[], currentModel?: Model<any>): ModelItem[] {
	const favoriteIndex = favoriteIndexById();
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

function reorderSelectorModels(selector: MutableModelSelector): void {
	selector.allModels = sortWithFavorites(selector.allModels, selector.currentModel);
	selector.scopedModelItems = sortWithFavorites(selector.scopedModelItems, selector.currentModel);
	selector.activeModels = selector.scope === "scoped" ? selector.scopedModelItems : selector.allModels;
}

function selectPreferredModel(selector: MutableModelSelector, preferredModelId?: string): void {
	const favoriteIndex = favoriteIndexById();

	if (preferredModelId) {
		const preferredIndex = selector.filteredModels.findIndex(
			(item) => fullModelId(item.model) === preferredModelId,
		);
		if (preferredIndex >= 0) {
			selector.selectedIndex = preferredIndex;
			return;
		}
	}

	const currentFavoriteIndex = selector.filteredModels.findIndex(
		(item) =>
			modelsAreEqual(selector.currentModel, item.model) && isFavoriteIn(item.model, favoriteIndex),
	);
	if (currentFavoriteIndex >= 0) {
		selector.selectedIndex = currentFavoriteIndex;
		return;
	}

	const firstFavoriteIndex = selector.filteredModels.findIndex((item) =>
		isFavoriteIn(item.model, favoriteIndex),
	);
	if (firstFavoriteIndex >= 0) {
		selector.selectedIndex = firstFavoriteIndex;
		return;
	}

	const currentIndex = selector.filteredModels.findIndex((item) =>
		modelsAreEqual(selector.currentModel, item.model),
	);
	selector.selectedIndex = currentIndex >= 0 ? currentIndex : 0;
}

function restoreSelection(selector: MutableModelSelector, previousId?: string): void {
	if (previousId) {
		const idx = selector.filteredModels.findIndex((item) => fullModelId(item.model) === previousId);
		if (idx >= 0) {
			selector.selectedIndex = idx;
			return;
		}
	}
	selector.selectedIndex = Math.min(
		selector.selectedIndex,
		Math.max(0, selector.filteredModels.length - 1),
	);
}

function toggleFavorite(model: Model<any>): boolean {
	const id = fullModelId(model);
	const favorites = readFavorites();
	const index = favorites.indexOf(id);
	if (index >= 0) {
		writeFavorites([...favorites.slice(0, index), ...favorites.slice(index + 1)]);
		return false;
	}

	writeFavorites([...favorites, id]);
	return true;
}

function listTheme() {
	return getSelectListTheme();
}

function addSectionHeader(selector: MutableModelSelector, label: string): void {
	const t = listTheme();
	selector.listContainer.addChild(new Text(t.description(`  ${label}`), 0, 0));
}

function renderModelLine(
	selector: MutableModelSelector,
	item: ModelItem,
	index: number,
	favoriteIndex: Map<string, number>,
): void {
	const t = listTheme();
	const selected = index === selector.selectedIndex;
	const current = modelsAreEqual(selector.currentModel, item.model);
	const favorite = isFavoriteIn(item.model, favoriteIndex);

	const prefix = selected ? t.selectedPrefix("→ ") : "  ";
	const modelText = selected ? t.selectedText(item.id) : item.id;
	const providerBadge = t.description(`[${item.provider}]`);
	const favMark = favorite ? (selected ? t.selectedText(` ${FAVORITE_MARK}`) : t.description(` ${FAVORITE_MARK}`)) : "";
	const check = current ? (selected ? t.selectedText(" ✓") : t.description(" ✓")) : "";

	selector.listContainer.addChild(
		new Text(`${prefix}${modelText} ${providerBadge}${favMark}${check}`, 0, 0),
	);
}

/**
 * Sticky section headers based on full filtered list + window overlap.
 * Model windowing stays maxVisible=10 (headers are extra rows, consistent).
 */
function renderFavoriteAwareList(selector: MutableModelSelector): void {
	selector.listContainer.clear();
	const t = listTheme();
	const favoriteIndexByModelId = favoriteIndexById();
	const models = selector.filteredModels;
	const favoriteCount = models.filter((item) => isFavoriteIn(item.model, favoriteIndexByModelId)).length;

	const startIndex = Math.max(
		0,
		Math.min(selector.selectedIndex - Math.floor(MAX_VISIBLE / 2), models.length - MAX_VISIBLE),
	);
	const endIndex = Math.min(startIndex + MAX_VISIBLE, models.length);

	if (models.length > 0 && favoriteCount === 0) {
		selector.listContainer.addChild(
			new Text(t.description(`  ${rawKeyHint(FAVORITE_KEY, "favorite")} highlighted model`), 0, 0),
		);
	}

	// Sticky favorites header when window overlaps favorite region (indices 0..favoriteCount-1 after sort)
	const windowOverlapsFavorites = favoriteCount > 0 && startIndex < favoriteCount;
	if (windowOverlapsFavorites) {
		addSectionHeader(selector, `Favorite models (${favoriteCount})`);
	}

	// Show "All models" once when the window includes non-favorite rows after favorites.
	let needsAllHeader = favoriteCount > 0 && favoriteCount < models.length && endIndex > favoriteCount;
	let renderedAllHeader = false;

	for (let index = startIndex; index < endIndex; index++) {
		const item = models[index];
		if (!item) continue;

		const favorite = isFavoriteIn(item.model, favoriteIndexByModelId);
		if (!favorite && needsAllHeader && !renderedAllHeader) {
			addSectionHeader(selector, "All models");
			renderedAllHeader = true;
		}

		renderModelLine(selector, item, index, favoriteIndexByModelId);
	}

	if (startIndex > 0 || endIndex < models.length) {
		selector.listContainer.addChild(
			new Text(t.scrollInfo(`  (${selector.selectedIndex + 1}/${models.length})`), 0, 0),
		);
	}

	if (selector.errorMessage) {
		// SelectListTheme has no error token; keep readable with description styling.
		for (const line of selector.errorMessage.split("\n")) {
			selector.listContainer.addChild(new Text(t.description(line), 0, 0));
		}
		return;
	}

	if (models.length === 0) {
		selector.listContainer.addChild(new Text(t.noMatch("  No matching models"), 0, 0));
		return;
	}

	const selected = models[selector.selectedIndex];
	if (!selected) return;
	const favoriteAction = isFavoriteIn(selected.model, favoriteIndexByModelId)
		? "remove favorite"
		: "add favorite";
	selector.listContainer.addChild(new Spacer(1));
	selector.listContainer.addChild(
		new Text(t.description(`  Model Name: ${selected.model.name}`), 0, 0),
	);
	selector.listContainer.addChild(
		new Text(t.description(`  ${rawKeyHint(FAVORITE_KEY, favoriteAction)}`), 0, 0),
	);
}

function patchModelSelector(): void {
	const proto = ModelSelectorComponent.prototype as unknown as ModelSelectorPrototype;
	if (proto[PATCHED]) return;

	const originalLoadModels = proto.loadModels;
	const originalHandleInput = proto.handleInput;

	proto.loadModels = async function loadModelsWithFavorites(this: MutableModelSelector): Promise<void> {
		await originalLoadModels.call(this);
		reorderSelectorModels(this);
		this.filteredModels = this.activeModels;
		selectPreferredModel(this);
	};

	proto.sortModels = function sortModelsWithFavorites(
		this: MutableModelSelector,
		models: ModelItem[],
	): ModelItem[] {
		return sortWithFavorites(models, this.currentModel);
	};

	proto.filterModels = function filterModelsWithFavorites(
		this: MutableModelSelector,
		query: string,
	): void {
		const previousId =
			this.filteredModels[this.selectedIndex] !== undefined
				? fullModelId(this.filteredModels[this.selectedIndex]!.model)
				: undefined;

		reorderSelectorModels(this);
		const sortedActiveModels = this.activeModels;

		this.filteredModels = query
			? fuzzyFilter(sortedActiveModels, query, ({ id, provider, model }) =>
					getModelSelectorSearchText({ id, provider, name: model.name }),
				)
			: sortedActiveModels;

		restoreSelection(this, previousId);
		this.updateList();
	};

	proto.updateList = function updateListWithFavorites(this: MutableModelSelector): void {
		renderFavoriteAwareList(this);
	};

	proto.handleInput = function handleInputWithFavorites(this: MutableModelSelector, data: string): void {
		if (matchesKey(data, FAVORITE_KEY) || data === "\x06") {
			const item = this.filteredModels[this.selectedIndex];
			if (!item) return;
			const id = fullModelId(item.model);
			toggleFavorite(item.model);
			reorderSelectorModels(this);
			this.filterModels(this.searchInput.getValue());
			selectPreferredModel(this, id);
			this.updateList();
			this.tui?.requestRender();
			return;
		}

		originalHandleInput.call(this, data);
	};

	proto[PATCHED] = true;
}

function formatFavorites(): string {
	const favorites = readFavorites();
	if (favorites.length === 0) {
		return "No favorite models yet. Open /model and press Ctrl+F on a model.";
	}
	return favorites.map((id, index) => `${index + 1}. ${id}`).join("\n");
}

function registerFavoritesCommand(pi: ExtensionAPI): void {
	pi.registerCommand("model-favorites", {
		description:
			"List, add, remove, or clear favorite models for /model. Usage: /model-favorites [list|clear|add <provider/model>|remove <provider/model>|toggle <provider/model>]",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const [action = "list", ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const ref = rest.join(" ");

			if (action === "list") {
				ctx.ui.notify(formatFavorites(), "info");
				return;
			}

			if (action === "clear") {
				writeFavorites([]);
				ctx.ui.notify("model-favorites: cleared favorite models", "info");
				return;
			}

			if (!["add", "remove", "toggle"].includes(action)) {
				ctx.ui.notify("model-favorites: expected list, clear, add, remove, or toggle", "warning");
				return;
			}

			const slash = ref.indexOf("/");
			if (slash <= 0 || slash === ref.length - 1) {
				ctx.ui.notify("model-favorites: expected a provider/model id", "warning");
				return;
			}
			const provider = ref.slice(0, slash);
			const id = ref.slice(slash + 1);

			const model = ctx.modelRegistry.find(provider, id);
			if (!model) {
				ctx.ui.notify(`model-favorites: unknown model ${ref}`, "warning");
				return;
			}

			const fullId = fullModelId(model);
			const favorites = readFavorites();
			const exists = favorites.includes(fullId);

			if (action === "remove" || (action === "toggle" && exists)) {
				writeFavorites(favorites.filter((favorite) => favorite !== fullId));
				ctx.ui.notify(`model-favorites: removed ${fullId}`, "info");
				return;
			}

			if (!exists) writeFavorites([...favorites, fullId]);
			ctx.ui.notify(`model-favorites: added ${fullId}`, "info");
		},
	});
}

export default function modelFavoritesExtension(pi: ExtensionAPI): void {
	patchModelSelector();
	registerFavoritesCommand(pi);
}
