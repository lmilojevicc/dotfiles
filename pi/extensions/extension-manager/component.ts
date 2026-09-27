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

export type ExtensionManagerResult = "save" | "cancel";

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
	getSelectedRow(): ExtensionManagerRow | undefined { return this.filtered[this.selected]; }

	private move(delta: number, page = false): void {
		const count = this.filtered.length;
		if (count === 0) return;
		if (page) this.selected = Math.max(0, Math.min(count - 1, this.selected + delta));
		else this.selected = (this.selected + delta + count) % count;
	}

	private activate(): void {
		const row = this.getSelectedRow();
		if (row) this.options.onToggle(row);
	}

	handleInput(data: string): void {
		if (this.disposed) return;
		const kb = this.options.keybindings;
		const usable = this.usable && this.options.getHeight() === this.renderedHeight &&
			this.options.getWidth?.() === this.renderedTerminalWidth &&
			this.options.getTerminalHeight?.() === this.renderedTerminalHeight;
		if (usable && matchesKey(data, "s")) {
			this.dispose();
			this.options.onDone("save");
			return;
		}
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
		const height = Math.min(19, this.renderedHeight);
		const clip = (line: string, size = width) => truncateToWidth(line, Math.max(0, size), "");
		const fill = (line: string, size: number) => {
			const value = clip(line, size);
			return value + " ".repeat(Math.max(0, size - visibleWidth(value)));
		};
		const cancelKey = kb.getKeys("tui.select.cancel")[0] ?? "unbound";
		const confirmKey = kb.getKeys("tui.select.confirm")[0] ?? "unbound";
		const cancelName = cancelKey === "escape" ? "Esc" : cancelKey;
		const confirmName = confirmKey === "enter" ? "Enter" : confirmKey;
		const compactHint = `s Save · ${cancelName} cancel`;
		const actionHint = `s Save · ${confirmName} toggle · ${cancelName} cancel`;
		const contentWidth = Math.max(0, width - 4);
		const bordered = (line: string) => theme.fg("border", "│") + " " + fill(line, contentWidth) + " " + theme.fg("border", "│");
		if (width < 24 || height < 10 || visibleWidth(compactHint) > contentWidth) {
			if (width >= 4 && height >= 3) {
				const lines = [
					theme.fg("border", `╭${"─".repeat(width - 2)}╮`),
					bordered(theme.fg("warning", clip("Resize required", contentWidth))),
				];
				if (height >= 4) lines.push(bordered(theme.fg("dim", clip(`${cancelName} cancel`, contentWidth))));
				lines.push(theme.fg("border", `╰${"─".repeat(width - 2)}╯`));
				return lines.map((line) => clip(line));
			}
			const lines = [theme.fg("warning", clip("Resize required"))];
			if (height > 1) lines.push(theme.fg("dim", clip(`${cancelName} cancel`)));
			return lines.slice(0, height).map((line) => clip(line));
		}
		this.usable = true;

		const staged = this.options.getStagedCount();
		const title = staged > 0 ? `Extensions (${staged} staged)` : "Extensions";
		const searchPrefix = theme.fg("muted", "Search: ");
		const search = searchPrefix + this.input.render(Math.max(1, contentWidth - visibleWidth(searchPrefix)))[0];
		const bodyRows = Math.min(10, Math.max(1, height - 7), Math.max(1, this.options.rows.length));
		this.pageSize = bodyRows;
		const selectedExtension = this.filtered.length === 0 ? 0 : Math.min(this.selected, this.filtered.length - 1);
		const { start, end } = extensionViewport(selectedExtension, this.filtered.length, bodyRows);
		const up = start > 0 ? `  ↑ ${start} more` : "";
		const down = end < this.filtered.length ? `  ↓ ${this.filtered.length - end} more` : "";
		const lines = [
			theme.fg("border", `╭${"─".repeat(width - 2)}╮`),
			bordered(theme.bold(clip(title, contentWidth))),
			bordered(clip(search, contentWidth)),
			bordered(theme.fg("borderMuted", clip(up, contentWidth))),
		];

		for (let slot = 0; slot < bodyRows; slot++) {
			const index = start + slot;
			const row = this.filtered[index];
			if (!row) {
				lines.push(bordered(slot === 0 ? theme.fg("warning", clip("  No matching extensions", contentWidth)) : ""));
				continue;
			}
			const active = index === this.selected;
			const enabled = this.options.getEnabled(row);
			const lock = row.lock === "required" ? " · required" : row.lock === "local-file-package" ? " · unavailable (local file package)" : "";
			const marker = active ? theme.fg("accent", "›") : " ";
			const checkbox = enabled ? theme.fg("success", "[x]") : "[ ]";
			const label = cleanText(row.label) + lock;
			lines.push(bordered(clip(`${marker} ${checkbox} ${active ? theme.bold(label) : row.lock ? theme.fg("muted", label) : label}`, contentWidth)));
		}
		lines.push(bordered(theme.fg("borderMuted", clip(down, contentWidth))));

		const fullHint = `s Save · Type search · ↑↓ move · ${confirmName} toggle · ${cancelName} cancel`;
		const moveHint = `s Save · ↑↓ move · ${confirmName} toggle · ${cancelName} cancel`;
		const footer = visibleWidth(fullHint) <= contentWidth ? fullHint : visibleWidth(moveHint) <= contentWidth ? moveHint : visibleWidth(actionHint) <= contentWidth ? actionHint : compactHint;
		lines.push(bordered(theme.fg("dim", footer)));
		lines.push(theme.fg("border", `╰${"─".repeat(width - 2)}╯`));
		return lines.slice(0, height).map((line) => clip(line));
	}

	invalidate(): void { this.input.invalidate(); }
	dispose(): void {
		this.disposed = true;
		this.focused = false;
	}
}
