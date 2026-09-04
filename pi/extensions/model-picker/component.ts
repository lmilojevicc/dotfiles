import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	Input, matchesKey, truncateToWidth, visibleWidth,
	type Component, type Focusable, type KeybindingsManager,
} from "@earendil-works/pi-tui";
import { modelKey, modelLabel, providerCounts, searchModels, searchTier, type PickerModel } from "./domain.ts";

type Options = {
	models: readonly PickerModel[];
	current?: PickerModel;
	scoped: boolean;
	theme: Pick<Theme, "fg" | "bg" | "bold">;
	keybindings: KeybindingsManager;
	getHeight: () => number;
	getWidth?: () => number;
	onChange: () => void;
	onSelect: (model: PickerModel) => void;
	onCancel: () => void;
};

// Registry labels are data, never terminal control sequences or additional lines.
const text = (value: string): string => value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
const windowStart = (index: number, length: number, rows: number): number =>
	Math.max(0, Math.min(index - Math.floor(rows / 2), length - rows));

export class ModelPickerComponent implements Component, Focusable {
	private readonly options: Options;
	private readonly input = new Input();
	private matches: PickerModel[];
	private results: PickerModel[];
	private counts: Map<string, number>;
	private scope: string | undefined;
	private pane: "providers" | "models" = "models";
	private selected = 0;
	private pageSize = 8;
	private disposed = false;
	private usable = false;
	private renderedWidth = 0;
	private renderedHeight = 0;
	private visibleSelection: string | undefined;
	private _focused = false;

	constructor(options: Options) {
		this.options = options;
		this.matches = [...options.models];
		this.results = this.matches;
		this.counts = providerCounts(options.models, this.matches);
		this.selected = Math.max(0, this.results.findIndex((model) => options.current && modelKey(model) === modelKey(options.current)));
	}

	get focused(): boolean { return this._focused; }
	set focused(value: boolean) { this._focused = value; this.input.focused = value; }
	getQuery(): string { return this.input.getValue(); }
	getSelectedModel(): PickerModel | undefined { return this.results[this.selected]; }
	getScope(): string | undefined { return this.scope; }
	getPane(): "providers" | "models" { return this.pane; }

	handleInput(data: string): void {
		if (this.disposed) return;
		const kb = this.options.keybindings;
		// Never navigate or save an invisible layout; Escape remains available to leave.
		if (!this.usable || this.options.getHeight() !== this.renderedHeight ||
			(this.options.getWidth && this.options.getWidth() !== this.renderedWidth)) {
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
		else {
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
		this.matches = searchModels(this.options.models, this.getQuery());
		this.counts = providerCounts(this.options.models, this.matches);
		this.results = this.scope === undefined ? this.matches : this.matches.filter((model) => model.provider === this.scope);
		const index = previous ? this.results.findIndex((model) => modelKey(model) === modelKey(previous)) : -1;
		// Keep identity while navigating scopes; a stronger search tier wins over a weak old highlight.
		this.selected = index >= 0 && (!queryChanged || searchTier(this.results[index], this.getQuery()) === searchTier(this.results[0], this.getQuery()))
			? index : 0;
	}

	private move(delta: number, page = false): void {
		const providers = [undefined, ...this.counts.keys()];
		const length = this.pane === "providers" ? providers.length : this.results.length;
		if (!length) return;
		const current = this.pane === "providers" ? providers.indexOf(this.scope) : this.selected;
		const next = page ? Math.max(0, Math.min(length - 1, current + delta)) : (current + delta + length) % length;
		if (this.pane === "providers") {
			this.scope = providers[next];
			this.filter(false);
		} else this.selected = next;
	}

	render(width: number): string[] {
		this.usable = false;
		this.renderedWidth = width;
		this.renderedHeight = this.options.getHeight();
		this.visibleSelection = undefined;
		if (width <= 0) return [];
		const height = Math.max(1, Math.floor(this.options.getHeight()));
		const { theme, keybindings: kb } = this.options;
		const clip = (line: string, size = width) => truncateToWidth(line, size, "");
		const scope = text(this.scope ?? "All");
		const count = this.results.length;
		const title = theme.fg("accent", theme.bold(`Model picker · ${scope} (${count})`));
		const searchPrefix = width > 12 ? theme.fg("muted", "Search: ") : "";
		const search = clip(searchPrefix + this.input.render(Math.max(1, width - visibleWidth(searchPrefix)))[0]);
		const detailed = height >= 8;
		const twoPane = width >= 64 && height >= 8;
		const header = width < 64
			? `${this.options.scoped ? "[session] " : ""}${scope} · ${this.pane === "providers" ? "Providers" : "Models"} · Tab`
			: `> ${this.pane === "providers" ? "Providers" : "Models"} · ${count} ${this.getQuery().trim() ? "matches" : "models"} · ${scope}${this.options.scoped ? " · session scope" : ""}`;
		const confirmKey = kb.getKeys("tui.select.confirm")[0] ?? "unbound";
		const cancelKey = kb.getKeys("tui.select.cancel")[0] ?? "unbound";
		const cancelHint = `${cancelKey === "escape" ? "Esc" : cancelKey} ${this.getQuery() ? "clear" : "close"}`;
		const confirmHint = `${confirmKey === "enter" ? "Enter" : confirmKey} ${this.pane === "providers" ? "back" : "save"}`;
		const footerCandidates = [
			`${kb.getKeys("tui.select.up")[0] ?? "unbound"}/${kb.getKeys("tui.select.down")[0] ?? "unbound"} · Tab pane · ${confirmKey} ${this.pane === "providers" ? "models" : "switch + save"} · ${cancelHint} · * current`,
			`Tab · ${confirmKey} ${this.pane === "providers" ? "models" : "save"} · ${cancelHint}`,
			`${confirmHint} ${cancelHint}`,
		];
		const footer = footerCandidates.find((hint) => visibleWidth(hint) <= width);
		const footerLines = footer ? [footer] : [confirmHint, cancelHint];
		if (width < 20 || height < 3 + footerLines.length || footerLines.some((line) => visibleWidth(line) > width)) {
			return [theme.fg("warning", clip("Resize required")), ...(height > 1 ? [theme.fg("dim", clip(`${cancelKey === "escape" ? "Esc" : cancelKey} close`))] : [])];
		}
		this.usable = true;
		const lines: string[] = [];
		if (height >= 4 + footerLines.length) lines.push(title);
		lines.push(theme.fg("muted", header));
		lines.push(search);
		const reserved = footerLines.length + (detailed ? 2 : 0);
		const itemRows = twoPane ? Math.max(count, this.counts.size + 1) : this.pane === "providers" ? this.counts.size + 1 : count;
		const rows = Math.max(1, Math.min(12, height - lines.length - reserved, itemRows));
		this.pageSize = rows;
		const providers = [undefined, ...this.counts.keys()];
		const providerIndex = providers.indexOf(this.scope);
		const providerStart = windowStart(providerIndex, providers.length, rows);
		const resultStart = windowStart(this.selected, this.results.length, rows);
		const providerWidth = twoPane ? Math.min(26, Math.floor(width / 3)) : width;
		const providerLine = (index: number): string => {
			if (index >= providers.length) return "";
			const provider = providers[index];
			const active = provider === this.scope;
			const suffix = ` (${provider === undefined ? this.matches.length : this.counts.get(provider)})`;
			const label = clip(`${active ? "> " : "  "}${text(provider ?? "All")}`, Math.max(0, providerWidth - visibleWidth(suffix))) + suffix;
			return active ? theme.fg("accent", label) : theme.fg("muted", label);
		};
		const modelLine = (index: number, size: number): string => {
			const model = this.results[index];
			if (!model) return index === 0 ? theme.fg("warning", this.options.models.length ? "No matching models" : "No models available") : "";
			const current = this.options.current && modelKey(model) === modelKey(this.options.current);
			const label = clip(`${index === this.selected ? ">" : " "}${current ? "*" : " "} ${text(modelLabel(model))}`, size);
			return index === this.selected && this.pane === "models"
				? theme.bg("selectedBg", theme.fg("accent", label)) : current ? theme.fg("success", label) : label;
		};
		for (let row = 0; row < rows; row++) {
			if (twoPane) {
				const left = clip(providerLine(providerStart + row), providerWidth);
				lines.push(left + " ".repeat(Math.max(0, providerWidth - visibleWidth(left))) + theme.fg("borderMuted", " │ ") + modelLine(resultStart + row, width - providerWidth - 3));
			} else lines.push(this.pane === "providers" ? providerLine(providerStart + row) : modelLine(resultStart + row, width));
		}
		if (detailed) {
			const model = this.getSelectedModel();
			lines.push(theme.fg("muted", model ? `${this.selected + 1}/${count} · ${text(model.name)} · ${model.contextWindow.toLocaleString("en-US")} context · ${model.maxTokens.toLocaleString("en-US")} output` : "Change provider or search to browse models"));
			lines.push(theme.fg("dim", model ? `${model.reasoning ? "Reasoning · " : ""}${model.input.join(" + ")} · $${model.cost.input} in / $${model.cost.output} out per 1M tokens${model.cost.tiers?.length ? " (base rates; tiered)" : ""}` : "Available catalogue only; configure providers with /login or models.json"));
		}
		lines.push(...footerLines.map((line) => theme.fg("dim", line)));
		if (this.pane === "models" && this.getSelectedModel()) this.visibleSelection = modelKey(this.getSelectedModel()!);
		return lines.slice(0, height).map((line) => clip(line));
	}

	invalidate(): void { this.input.invalidate(); }
	dispose(): void { this.disposed = true; this.focused = false; }
}
