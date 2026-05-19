import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	getAgentDir,
	ModelSelectorComponent,
	rawKeyHint,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { fuzzyFilter, matchesKey, Spacer, Text } from "@earendil-works/pi-tui";

const PATCHED = Symbol.for("milo.pi.model-favorites.patched");
const FAVORITE_KEY = "ctrl+f";
const FAVORITES_PATH = join(getAgentDir(), "model-favorites.json");

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

function readFavorites(): string[] {
	try {
		if (!existsSync(FAVORITES_PATH)) return [];
		const parsed = JSON.parse(readFileSync(FAVORITES_PATH, "utf8")) as FavoriteStore;
		return Array.isArray(parsed.favorites)
			? parsed.favorites.filter((value): value is string => typeof value === "string" && value.length > 0)
			: [];
	} catch {
		return [];
	}
}

function writeFavorites(favorites: string[]): void {
	mkdirSync(dirname(FAVORITES_PATH), { recursive: true });
	writeFileSync(
		FAVORITES_PATH,
		`${JSON.stringify({ favorites: [...new Set(favorites)] } satisfies FavoriteStore, null, "\t")}\n`,
		"utf8",
	);
}

function fullModelId(model: Pick<Model<any>, "provider" | "id">): string {
	return `${model.provider}/${model.id}`;
}

function sameModel(a: Model<any> | undefined, b: Model<any> | undefined): boolean {
	return !!a && !!b && a.provider === b.provider && a.id === b.id;
}

function parseFullModelId(value: string): { provider: string; id: string } | undefined {
	const trimmed = value.trim();
	const slash = trimmed.indexOf("/");
	if (slash <= 0 || slash === trimmed.length - 1) return undefined;
	return { provider: trimmed.slice(0, slash), id: trimmed.slice(slash + 1) };
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

		const aIsCurrent = sameModel(currentModel, a.model);
		const bIsCurrent = sameModel(currentModel, b.model);
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
		const preferredIndex = selector.filteredModels.findIndex((item) => fullModelId(item.model) === preferredModelId);
		if (preferredIndex >= 0) {
			selector.selectedIndex = preferredIndex;
			return;
		}
	}

	const currentFavoriteIndex = selector.filteredModels.findIndex(
		(item) => sameModel(selector.currentModel, item.model) && isFavoriteIn(item.model, favoriteIndex),
	);
	if (currentFavoriteIndex >= 0) {
		selector.selectedIndex = currentFavoriteIndex;
		return;
	}

	const firstFavoriteIndex = selector.filteredModels.findIndex((item) => isFavoriteIn(item.model, favoriteIndex));
	if (firstFavoriteIndex >= 0) {
		selector.selectedIndex = firstFavoriteIndex;
		return;
	}

	const currentIndex = selector.filteredModels.findIndex((item) => sameModel(selector.currentModel, item.model));
	selector.selectedIndex = currentIndex >= 0 ? currentIndex : 0;
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

function style(code: number, closeCode: number, text: string): string {
	return `\x1b[${code}m${text}\x1b[${closeCode}m`;
}

function bold(text: string): string {
	return style(1, 22, text);
}

function dim(text: string): string {
	return style(2, 22, text);
}

function accent(text: string): string {
	return style(36, 39, text);
}

function success(text: string): string {
	return style(32, 39, text);
}

function error(text: string): string {
	return style(31, 39, text);
}

function addSectionHeader(selector: MutableModelSelector, label: string): void {
	selector.listContainer.addChild(new Text(dim(`  ${label}`), 0, 0));
}

function renderModelLine(
	selector: MutableModelSelector,
	item: ModelItem,
	index: number,
	favoriteIndex: Map<string, number>,
): void {
	const selected = index === selector.selectedIndex;
	const current = sameModel(selector.currentModel, item.model);
	const prefix = selected ? accent("→ ") : "  ";
	const modelText = selected ? accent(item.id) : item.id;
	const providerBadge = dim(`[${item.provider}]`);
	const currentMark = current ? success(" ✓") : "";
	selector.listContainer.addChild(new Text(`${prefix}${modelText} ${providerBadge}${currentMark}`, 0, 0));
}

function renderFavoriteAwareList(selector: MutableModelSelector): void {
	selector.listContainer.clear();
	const favoriteIndexByModelId = favoriteIndexById();

	const maxVisible = 10;
	const favoriteCount = selector.filteredModels.filter((item) => isFavoriteIn(item.model, favoriteIndexByModelId)).length;
	const startIndex = Math.max(
		0,
		Math.min(selector.selectedIndex - Math.floor(maxVisible / 2), selector.filteredModels.length - maxVisible),
	);
	const endIndex = Math.min(startIndex + maxVisible, selector.filteredModels.length);
	let renderedFavoritesHeader = false;
	let renderedAllHeader = false;

	if (selector.filteredModels.length > 0 && favoriteCount === 0) {
		selector.listContainer.addChild(new Text(dim(`  ${rawKeyHint(FAVORITE_KEY, "favorite")} highlighted model`), 0, 0));
	}

	for (let index = startIndex; index < endIndex; index++) {
		const item = selector.filteredModels[index];
		if (!item) continue;

		const favorite = isFavoriteIn(item.model, favoriteIndexByModelId);
		if (favorite && !renderedFavoritesHeader) {
			addSectionHeader(selector, `Favorite models (${favoriteCount})`);
			renderedFavoritesHeader = true;
		}
		if (!favorite && favoriteCount > 0 && !renderedAllHeader) {
			addSectionHeader(selector, "All models");
			renderedAllHeader = true;
		}

		renderModelLine(selector, item, index, favoriteIndexByModelId);
	}

	if (startIndex > 0 || endIndex < selector.filteredModels.length) {
		selector.listContainer.addChild(
			new Text(dim(`  (${selector.selectedIndex + 1}/${selector.filteredModels.length})`), 0, 0),
		);
	}

	if (selector.errorMessage) {
		for (const line of selector.errorMessage.split("\n")) {
			selector.listContainer.addChild(new Text(error(line), 0, 0));
		}
		return;
	}

	if (selector.filteredModels.length === 0) {
		selector.listContainer.addChild(new Text(dim("  No matching models"), 0, 0));
		return;
	}

	const selected = selector.filteredModels[selector.selectedIndex];
	if (!selected) return;
	const favoriteAction = isFavoriteIn(selected.model, favoriteIndexByModelId) ? "remove favorite" : "add favorite";
	selector.listContainer.addChild(new Spacer(1));
	selector.listContainer.addChild(new Text(dim(`  Model Name: ${selected.model.name}`), 0, 0));
	selector.listContainer.addChild(new Text(dim(`  ${rawKeyHint(FAVORITE_KEY, favoriteAction)}`), 0, 0));
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

	proto.sortModels = function sortModelsWithFavorites(this: MutableModelSelector, models: ModelItem[]): ModelItem[] {
		return sortWithFavorites(models, this.currentModel);
	};

	proto.filterModels = function filterModelsWithFavorites(this: MutableModelSelector, query: string): void {
		reorderSelectorModels(this);
		const sortedActiveModels = this.activeModels;
		this.filteredModels = query
			? fuzzyFilter(sortedActiveModels, query, ({ id, provider }) => `${id} ${provider} ${provider}/${id} ${provider} ${id}`)
			: sortedActiveModels;
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredModels.length - 1));
		this.updateList();
	};

	proto.updateList = function updateListWithFavorites(this: MutableModelSelector): void {
		renderFavoriteAwareList(this);
	};

	proto.handleInput = function handleInputWithFavorites(this: MutableModelSelector, data: string): void {
		if (matchesKey(data, FAVORITE_KEY) || data === "\x06") {
			const item = this.filteredModels[this.selectedIndex];
			if (!item) return;
			toggleFavorite(item.model);
			reorderSelectorModels(this);
			this.filterModels(this.searchInput.getValue());
			selectPreferredModel(this, fullModelId(item.model));
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
	if (favorites.length === 0) return "No favorite models yet. Open /model and press Ctrl+F on a model.";
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

			const parsed = parseFullModelId(ref);
			if (!parsed) {
				ctx.ui.notify("model-favorites: expected a provider/model id", "warning");
				return;
			}

			const model = ctx.modelRegistry.find(parsed.provider, parsed.id);
			if (!model) {
				ctx.ui.notify(`model-favorites: unknown model ${ref}`, "warning");
				return;
			}

			const id = fullModelId(model);
			const favorites = readFavorites();
			const exists = favorites.includes(id);

			if (action === "remove" || (action === "toggle" && exists)) {
				writeFavorites(favorites.filter((favorite) => favorite !== id));
				ctx.ui.notify(`model-favorites: removed ${id}`, "info");
				return;
			}

			if (!exists) writeFavorites([...favorites, id]);
			ctx.ui.notify(`model-favorites: added ${id}`, "info");
		},
	});
}

export default function modelFavoritesExtension(pi: ExtensionAPI): void {
	patchModelSelector();
	registerFavoritesCommand(pi);
}
