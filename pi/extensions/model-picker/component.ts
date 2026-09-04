import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	Input, matchesKey, truncateToWidth, visibleWidth,
	type Component, type Focusable, type KeybindingsManager,
} from "@earendil-works/pi-tui";
import { modelKey, modelLabel, orderModels, providerCounts, searchModels, searchTier, type PickerModel } from "./domain.ts";
import { favoriteKey, favoritesError } from "./favorites.ts";

type PickerScope = { kind: "all" } | { kind: "favorites" } | { kind: "provider"; provider: string };
const scopeLabel = (scope: PickerScope): string =>
	scope.kind === "provider" ? scope.provider : scope.kind === "favorites" ? "Favorites" : "All";

type Options = {
	models: readonly PickerModel[];
	current?: PickerModel;
	scoped: boolean;
	favorites?: readonly string[];
	favoriteError?: string;
	onToggleFavorite?: (model: PickerModel) => readonly string[];
	theme: Pick<Theme, "fg" | "bg" | "bold">;
	keybindings: KeybindingsManager;
	/** Available overlay height, after host insets/caps. render(width) owns layout width. */
	getHeight: () => number;
	/** Raw terminal dimensions, used only to reject input before a resize repaint. */
	getWidth?: () => number;
	getTerminalHeight?: () => number;
	onChange: () => void;
	onSelect: (model: PickerModel) => void;
	onCancel: () => void;
};

// Registry labels are data, never terminal control sequences or additional lines.
const text = (value: string): string => value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
// Retain the viewport, moving only enough to reveal selection or clamp a resized/tail page.
const windowStart = (offset: number, index: number, length: number, rows: number): number => {
	const start = Math.max(0, Math.min(offset, length - rows));
	return index < start ? index : index >= start + rows ? index - rows + 1 : start;
};

export class ModelPickerComponent implements Component, Focusable {
	private readonly options: Options;
	private readonly input = new Input();
	private matches: PickerModel[];
	private results: PickerModel[];
	private counts: Map<string, number>;
	private scope: PickerScope = { kind: "all" };
	private readonly scopes: PickerScope[];
	private pane: "providers" | "models" = "models";
	private selected = 0;
	private pageSize = 8;
	private disposed = false;
	private usable = false;
	private renderedTerminalWidth: number | undefined;
	private renderedTerminalHeight: number | undefined;
	private renderedHeight = 0;
	private resultOffset = 0;
	private providerOffset = 0;
	private visibleSelection: string | undefined;
	private _focused = false;
	private favorites: readonly string[];
	private favoriteError: string | undefined;

	constructor(options: Options) {
		this.options = options;
		this.favorites = options.favorites ?? [];
		this.favoriteError = options.favoriteError;
		this.matches = orderModels(options.models, this.favorites, options.current);
		this.results = this.matches;
		this.counts = providerCounts(options.models, this.matches);
		this.scopes = [this.scope, { kind: "favorites" }, ...[...this.counts.keys()].map((provider): PickerScope => ({ kind: "provider", provider }))];
		const currentIndex = this.results.findIndex((model) => options.current && modelKey(model) === modelKey(options.current));
		const favoriteIndex = this.results.findIndex((model) => this.isFavorite(model));
		this.selected = currentIndex >= 0 && this.isFavorite(this.results[currentIndex]) ? currentIndex :
			favoriteIndex >= 0 ? favoriteIndex : Math.max(0, currentIndex);
	}

	private isFavorite(model: PickerModel): boolean { return this.favorites.includes(favoriteKey(model)); }

	get focused(): boolean { return this._focused; }
	set focused(value: boolean) { this._focused = value; this.input.focused = value; }
	getQuery(): string { return this.input.getValue(); }
	getSelectedModel(): PickerModel | undefined { return this.results[this.selected]; }
	getScope(): PickerScope { return this.scope; }
	getPane(): "providers" | "models" { return this.pane; }

	handleInput(data: string): void {
		if (this.disposed) return;
		const kb = this.options.keybindings;
		// Never navigate or save an invisible layout; Escape remains available to leave.
		if (!this.usable || this.options.getHeight() !== this.renderedHeight ||
			this.options.getWidth?.() !== this.renderedTerminalWidth ||
			this.options.getTerminalHeight?.() !== this.renderedTerminalHeight) {
			if (kb.matches(data, "tui.select.cancel")) {
				this.dispose();
				this.options.onCancel();
			}
			return;
		}
		if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
			this.pane = this.pane === "models" ? "providers" : "models";
		} else if (kb.matches(data, "tui.select.cancel")) {
			if (this.getQuery()) {
				this.input.setValue("");
				this.filter(true);
			} else {
				this.dispose();
				this.options.onCancel();
				return;
			}
		} else if (kb.matches(data, "tui.select.confirm")) {
			if (this.pane === "providers") this.pane = "models";
			else {
				const model = this.getSelectedModel();
				if (model && this.visibleSelection === modelKey(model)) {
					this.dispose();
					this.options.onSelect(model);
					return;
				}
			}
		} else if (kb.matches(data, "tui.select.up")) this.move(-1);
		else if (kb.matches(data, "tui.select.down")) this.move(1);
		else if (kb.matches(data, "tui.select.pageUp")) this.move(-this.pageSize, true);
		else if (kb.matches(data, "tui.select.pageDown")) this.move(this.pageSize, true);
		else if (matchesKey(data, "ctrl+f")) {
			const model = this.getSelectedModel();
			if (this.pane === "models" && model && this.visibleSelection === modelKey(model) && this.options.onToggleFavorite) {
				try {
					this.favorites = this.options.onToggleFavorite(model);
					this.favoriteError = undefined;
					// Refresh membership only. Re-ranking is reserved for query/scope changes or reopen.
					if (this.scope.kind === "favorites") {
						this.results = this.matches.filter((item) => this.isFavorite(item));
						const index = this.results.findIndex((item) => modelKey(item) === modelKey(model));
						this.selected = index >= 0 ? index : Math.max(0, Math.min(this.selected, this.results.length - 1));
					}
					this.visibleSelection = undefined;
				} catch (error) { this.favoriteError = favoritesError(error); }
			}
		} else {
			const previous = this.getQuery();
			// Left/right, home/end, deletion and printable input stay with Pi's Input.
			this.input.handleInput(data);
			if (previous !== this.getQuery()) this.filter(true);
		}
		this.invalidate();
		this.options.onChange();
	}

	private filter(queryChanged: boolean): void {
		const previous = this.getSelectedModel();
		this.matches = searchModels(orderModels(this.options.models, this.favorites, this.options.current), this.getQuery(), this.favorites);
		this.counts = providerCounts(this.options.models, this.matches);
		const scope = this.scope;
		this.results = scope.kind === "all" ? this.matches : this.matches.filter((model) =>
			scope.kind === "favorites" ? this.isFavorite(model) : model.provider === scope.provider);
		const index = previous ? this.results.findIndex((model) => modelKey(model) === modelKey(previous)) : -1;
		// Keep identity while navigating scopes; a stronger search tier wins over a weak old highlight.
		this.selected = index >= 0 && (!queryChanged || searchTier(this.results[index], this.getQuery()) === searchTier(this.results[0], this.getQuery()))
			? index : 0;
		this.resultOffset = 0;
		this.visibleSelection = undefined;
	}

	private move(delta: number, page = false): void {
		const providers = this.scopes;
		const length = this.pane === "providers" ? providers.length : this.results.length;
		if (!length) return;
		const current = this.pane === "providers" ? providers.indexOf(this.scope) : this.selected;
		const next = page ? Math.max(0, Math.min(length - 1, current + delta)) : (current + delta + length) % length;
		if (this.pane === "providers" && next !== current) {
			this.scope = providers[next];
			this.filter(false);
		} else if (this.pane === "models") this.selected = next;
	}

	render(width: number): string[] {
		this.usable = false;
		// Overlay width is not terminal width. Guard stale input against raw terminal dimensions.
		this.renderedTerminalWidth = this.options.getWidth?.();
		this.renderedTerminalHeight = this.options.getTerminalHeight?.();
		this.renderedHeight = this.options.getHeight();
		this.visibleSelection = undefined;
		if (width <= 0) return [];
		const height = Math.max(1, Math.min(22, Math.floor(this.renderedHeight)));
		const { theme, keybindings: kb } = this.options;
		const clip = (line: string, size = width) => truncateToWidth(line, Math.max(0, size), "");
		const fill = (line: string, size: number) => {
			const value = clip(line, size);
			return value + " ".repeat(Math.max(0, size - visibleWidth(value)));
		};
		const confirmKey = kb.getKeys("tui.select.confirm")[0] ?? "unbound";
		const cancelKey = kb.getKeys("tui.select.cancel")[0] ?? "unbound";
		const cancelHint = `${cancelKey === "escape" ? "Esc" : cancelKey} ${this.getQuery() ? "clear" : "close"}`;
		const confirmHint = `${confirmKey === "enter" ? "Enter" : confirmKey} ${this.pane === "providers" ? "back" : "save"}`;
		const framed = width >= 24 && height >= 9;
		const contentWidth = width - (framed ? 4 : 0);
		const twoPane = width >= 64 && height >= 8;
		const footerBudget = framed && height >= 10 ? 2 : 1;
		// Pack whole hints, with primary actions first; never truncate a binding or its action.
		const footerLines = visibleWidth(`${confirmHint} · ${cancelHint}`) <= contentWidth
			? [`${confirmHint} · ${cancelHint}`]
			: visibleWidth(`${confirmHint} ${cancelHint}`) <= contentWidth
				? [`${confirmHint} ${cancelHint}`] : [confirmHint, cancelHint];
		const hints = ["Tab pane"];
		if (this.options.onToggleFavorite && this.pane === "models" &&
			!(["up", "down", "pageUp", "pageDown", "confirm", "cancel"] as const).some((action) => kb.matches("\x06", `tui.select.${action}`))) hints.push("Ctrl+F favorite");
		for (const hint of hints) {
			const next = `${footerLines.at(-1)} · ${hint}`;
			if (visibleWidth(next) <= contentWidth) footerLines[footerLines.length - 1] = next;
			else if (footerLines.length < footerBudget && visibleWidth(hint) <= contentWidth) footerLines.push(hint);
		}
		const overhead = 2 + footerLines.length + (framed ? 4 : 0);
		if (width < 20 || height < overhead + 1 || footerLines.some((line) => visibleWidth(line) > contentWidth)) {
			return [theme.fg("warning", clip("Resize required")), ...(height > 1 ? [theme.fg("dim", clip(`${cancelKey === "escape" ? "Esc" : cancelKey} close`))] : [])];
		}
		this.usable = true;
		const session = this.options.scoped ? " [session]" : "";
		const heading = clip(twoPane || this.pane === "providers" ? "Model picker" : text(scopeLabel(this.scope)),
			contentWidth - visibleWidth(session) - (framed ? 2 : 0)) + session;
		const title = (framed ? theme.fg("accent", "● ") : "") + theme.bold(heading);
		const compactError = !!this.favoriteError && (!framed || contentWidth < 60);
		const searchPrefix = compactError ? theme.fg("warning", "Favorites error: ") : theme.fg("muted", "Search: ");
		const search = searchPrefix + this.input.render(Math.max(1, contentWidth - visibleWidth(searchPrefix)))[0];
		const bordered = (line: string) => theme.fg("border", "│") + " " + fill(line, contentWidth) + " " + theme.fg("border", "│");
		const lines: string[] = [];
		if (framed) lines.push(theme.fg("border", `╭${"─".repeat(width - 2)}╮`));
		const header = title + (this.favoriteError && !compactError ? theme.fg("warning", ` · ${text(this.favoriteError)}`) : "");
		lines.push(framed ? bordered(header) : clip(header), framed ? bordered(search) : clip(search));
		// Catalogue-based height is stable even when Favorites empties or counts change.
		const rows = Math.max(1, Math.min(12, height - overhead, Math.max(this.options.models.length, this.scopes.length)));
		this.pageSize = rows;
		const providers = this.scopes;
		this.providerOffset = windowStart(this.providerOffset, providers.indexOf(this.scope), providers.length, rows);
		this.resultOffset = windowStart(this.resultOffset, this.selected, this.results.length, rows);
		const providerWidth = twoPane ? Math.min(26, Math.floor(contentWidth / 3)) : contentWidth;
		const rule = (top: boolean) => {
			if (!twoPane) return theme.fg("border", `├${"─".repeat(width - 2)}┤`);
			const left = providerWidth + 2, right = width - left - 3;
			return theme.fg("border", "├") + theme.fg(!top && this.pane === "providers" ? "borderAccent" : "border", "─".repeat(left)) +
				theme.fg("borderMuted", top ? "┬" : "┴") + theme.fg(!top && this.pane === "models" ? "borderAccent" : "border", "─".repeat(right)) + theme.fg("border", "┤");
		};
		if (framed) lines.push(rule(true));
		const providerLine = (index: number): string => {
			if (index >= providers.length) return "";
			const provider = providers[index];
			const active = provider === this.scope;
			const count = provider.kind === "all" ? this.matches.length : provider.kind === "favorites"
				? this.matches.filter((model) => this.isFavorite(model)).length : this.counts.get(provider.provider);
			const suffix = ` (${count})`;
			const label = clip(`${active ? "❯ " : "  "}${text(scopeLabel(provider))}`, providerWidth - visibleWidth(suffix)) + suffix;
			return active ? theme.fg("accent", theme.bold(label)) : theme.fg("muted", label);
		};
		const modelLine = (index: number, size: number): string => {
			const model = this.results[index];
			if (!model) return index === 0 ? clip(theme.fg("warning", this.scope.kind === "favorites" && !this.options.models.some((item) => this.isFavorite(item))
				? "No favorites yet" : this.options.models.length ? "No matching models" : "No models available"), size) : "";
			const current = this.options.current && modelKey(model) === modelKey(this.options.current);
			const active = index === this.selected && this.pane === "models";
			const label = text(this.scope.kind === "provider" ? model.id : modelLabel(model));
			return clip((active ? theme.fg("accent", "❯") : " ") + ` ${this.isFavorite(model) ? "★" : " "}${current ? "*" : " "} ` +
				(active ? theme.bold(label) : current ? theme.fg("success", label) : label), size);
		};
		for (let row = 0; row < rows; row++) {
			const body = twoPane
				? fill(providerLine(this.providerOffset + row), providerWidth) + theme.fg("borderMuted", " │ ") + modelLine(this.resultOffset + row, contentWidth - providerWidth - 3)
				: this.pane === "providers" ? providerLine(this.providerOffset + row) : modelLine(this.resultOffset + row, contentWidth);
			lines.push(framed ? bordered(body) : clip(body));
		}
		if (framed) lines.push(rule(false));
		lines.push(...footerLines.map((line) => framed ? bordered(theme.fg("dim", line)) : theme.fg("dim", line)));
		if (framed) lines.push(theme.fg("border", `╰${"─".repeat(width - 2)}╯`));
		if (this.pane === "models" && this.getSelectedModel()) this.visibleSelection = modelKey(this.getSelectedModel()!);
		return lines.map((line) => clip(line));
	}

	invalidate(): void { this.input.invalidate(); }
	dispose(): void { this.disposed = true; this.focused = false; }
}
