import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	fuzzyFilter,
	Input,
	type Component,
	type Focusable,
	KeybindingsManager,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

export type ExtensionManagerRow = {
	id: string;
	label: string;
	searchText: string;
	enabled: boolean;
	lock?: "required" | "local-file-package";
};

export type ExtensionManagerResult = "apply" | "cancel";

type Options = {
	rows: readonly ExtensionManagerRow[];
	theme: Pick<Theme, "bold" | "fg">;
	keybindings: KeybindingsManager;
	getHeight: () => number;
	getWidth?: () => number;
	getTerminalHeight?: () => number;
	getEnabled: (row: ExtensionManagerRow) => boolean;
	getStagedCount: () => number;
	onToggle: (row: ExtensionManagerRow) => void;
	onChange: () => void;
	onDone: (result: ExtensionManagerResult) => void;
};

const cleanText = (value: string): string => value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");

export function filterExtensionRows(rows: readonly ExtensionManagerRow[], query: string): ExtensionManagerRow[] {
	if (!query) return [...rows];
	return fuzzyFilter([...rows], query, (row) => cleanText(row.searchText));
}

export function extensionViewport(index: number, length: number, rows: number): { start: number; end: number } {
	const size = Math.max(1, rows);
	const selected = Math.max(0, Math.min(index, length - 1));
	const start = Math.max(0, Math.min(selected - Math.floor(size / 2), length - size));
	return { start, end: Math.min(start + size, length) };
}

/** Searchable, staged toggle list that follows Pi's native picker input and viewport conventions. */
export class ExtensionManagerComponent implements Component, Focusable {
	private readonly options: Options;
	private readonly input = new Input();
	private filtered: ExtensionManagerRow[];
	private selected = 0;
	private pageSize = 1;
	private disposed = false;
	private usable = false;
	private renderedHeight = 0;
	private renderedTerminalWidth: number | undefined;
	private renderedTerminalHeight: number | undefined;
	private _focused = false;

	constructor(options: Options) {
		this.options = options;
		this.filtered = [...options.rows];
	}

	get focused(): boolean { return this._focused; }
	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	getQuery(): string { return this.input.getValue(); }
	getFilteredRows(): readonly ExtensionManagerRow[] { return this.filtered; }
	getSelectedKind(): "extension" | "apply" | "cancel" {
		return this.selected < this.filtered.length ? "extension" : this.selected === this.filtered.length ? "apply" : "cancel";
	}
	getSelectedRow(): ExtensionManagerRow | undefined { return this.filtered[this.selected]; }

	private selectableCount(): number { return this.filtered.length + 2; }

	private move(delta: number, page = false): void {
		const count = this.selectableCount();
		if (page) this.selected = Math.max(0, Math.min(count - 1, this.selected + delta));
		else this.selected = (this.selected + delta + count) % count;
	}

	private activate(): void {
		const row = this.getSelectedRow();
		if (row) {
			this.options.onToggle(row);
			return;
		}
		const result = this.getSelectedKind();
		this.dispose();
		this.options.onDone(result);
	}

	handleInput(data: string): void {
		if (this.disposed) return;
		const kb = this.options.keybindings;
		const usable = this.usable && this.options.getHeight() === this.renderedHeight &&
			this.options.getWidth?.() === this.renderedTerminalWidth &&
			this.options.getTerminalHeight?.() === this.renderedTerminalHeight;
		if (kb.matches(data, "tui.select.cancel")) {
			this.dispose();
			this.options.onDone("cancel");
			return;
		}
		if (!usable) return;

		if (kb.matches(data, "tui.select.up")) this.move(-1);
		else if (kb.matches(data, "tui.select.down")) this.move(1);
		else if (kb.matches(data, "tui.select.pageUp")) this.move(-this.pageSize, true);
		else if (kb.matches(data, "tui.select.pageDown")) this.move(this.pageSize, true);
		else if (kb.matches(data, "tui.select.confirm") || (matchesKey(data, "space") && this.getQuery() === "")) {
			this.activate();
			if (this.disposed) return;
		} else {
			const previous = this.getQuery();
			this.input.handleInput(data);
			if (this.getQuery() !== previous) {
				this.filtered = filterExtensionRows(this.options.rows, this.getQuery());
				this.selected = 0;
			}
		}
		this.invalidate();
		this.options.onChange();
	}

	render(width: number): string[] {
		this.usable = false;
		this.renderedHeight = Math.max(1, Math.floor(this.options.getHeight()));
		this.renderedTerminalWidth = this.options.getWidth?.();
		this.renderedTerminalHeight = this.options.getTerminalHeight?.();
		if (width <= 0) return [];
		const { theme, keybindings: kb } = this.options;
		const clip = (line: string) => truncateToWidth(line, width, "");
		const height = Math.min(17, this.renderedHeight);
		const cancelKey = kb.getKeys("tui.select.cancel")[0] ?? "unbound";
		const confirmKey = kb.getKeys("tui.select.confirm")[0] ?? "unbound";
		const cancelName = cancelKey === "escape" ? "Esc" : cancelKey;
		const confirmName = confirmKey === "enter" ? "Enter" : confirmKey;
		const primaryHint = `${confirmName} act · ${cancelName} cancel`;
		if (width < 20 || height < 8 || visibleWidth(primaryHint) > width) {
			const lines = [theme.fg("warning", clip("Resize required"))];
			if (height > 1) lines.push(theme.fg("dim", clip(`${cancelName} cancel`)));
			return lines.slice(0, height).map(clip);
		}
		this.usable = true;

		const staged = this.options.getStagedCount();
		const title = staged > 0 ? `Extensions (${staged} staged)` : "Extensions";
		const searchPrefix = theme.fg("muted", "Search: ");
		const search = searchPrefix + this.input.render(Math.max(1, width - visibleWidth(searchPrefix)))[0];
		const bodyRows = Math.min(10, Math.max(1, height - 7), Math.max(1, this.options.rows.length));
		this.pageSize = bodyRows;
		const selectedExtension = this.filtered.length === 0 ? 0 : Math.min(this.selected, this.filtered.length - 1);
		const { start, end } = extensionViewport(selectedExtension, this.filtered.length, bodyRows);
		const up = start > 0 ? `  ↑ ${start} more` : "";
		const down = end < this.filtered.length ? `  ↓ ${this.filtered.length - end} more` : "";
		const lines = [theme.bold(clip(title)), clip(search), theme.fg("borderMuted", clip(up))];

		for (let slot = 0; slot < bodyRows; slot++) {
			const index = start + slot;
			const row = this.filtered[index];
			if (!row) {
				lines.push(slot === 0 ? theme.fg("warning", clip("  No matching extensions")) : "");
				continue;
			}
			const active = index === this.selected;
			const enabled = this.options.getEnabled(row);
			const lock = row.lock === "required" ? " · required" : row.lock === "local-file-package" ? " · unavailable (local file package)" : "";
			const marker = active ? theme.fg("accent", "›") : " ";
			const checkbox = enabled ? theme.fg("success", "[x]") : "[ ]";
			const label = cleanText(row.label) + lock;
			lines.push(clip(`${marker} ${checkbox} ${active ? theme.bold(label) : row.lock ? theme.fg("muted", label) : label}`));
		}
		lines.push(theme.fg("borderMuted", clip(down)));

		const action = (kind: "apply" | "cancel", label: string): string => {
			const active = this.getSelectedKind() === kind;
			return clip(`${active ? theme.fg("accent", "›") : " "} ${active ? theme.bold(label) : label}`);
		};
		lines.push(action("apply", "Apply changes and reload"), action("cancel", "Cancel"));
		const fullHint = `Type search · ↑↓ move · ${primaryHint}`;
		const moveHint = `↑↓ move · ${primaryHint}`;
		const footer = visibleWidth(fullHint) <= width ? fullHint : visibleWidth(moveHint) <= width ? moveHint : primaryHint;
		lines.push(theme.fg("dim", footer));
		return lines.slice(0, height).map(clip);
	}

	invalidate(): void { this.input.invalidate(); }
	dispose(): void {
		this.disposed = true;
		this.focused = false;
	}
}
