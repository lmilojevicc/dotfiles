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

export type ExtensionLock = "required" | "global-off";
/** Informational, not a lock: an owned package can be toggled while its install is gone. */
export type ExtensionNote = "not-installed";

export type ExtensionManagerRow = {
	id: string;
	label: string;
	searchText: string;
	enabled: boolean;
	lock?: ExtensionLock;
	note?: ExtensionNote;
};

export type ExtensionManagerResult = "save" | "cancel";

type Options = {
	rows: readonly ExtensionManagerRow[];
	theme: Pick<Theme, "bold" | "fg">;
	keybindings: KeybindingsManager;
	getHeight: () => number;
	getWidth?: () => number;
	getTerminalHeight?: () => number;
	/** Scope tabs, for example ["Pi (global)", "BB"]; a single or absent tab renders no tab row. */
	tabs?: readonly string[];
	getEnabled: (row: ExtensionManagerRow, tab: number) => boolean;
	getLock?: (row: ExtensionManagerRow, tab: number) => ExtensionLock | undefined;
	getNote?: (row: ExtensionManagerRow, tab: number) => ExtensionNote | undefined;
	getStagedCount: () => number;
	onToggle: (row: ExtensionManagerRow, tab: number) => void;
	onChange: () => void;
	onDone: (result: ExtensionManagerResult) => void;
};

const SAVE_KEY = "ctrl+s";
const SAVE_HINT = "ctrl+s Save";
const COMPACT_SAVE_HINT = "^S Save";

const cleanText = (value: string): string => value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");

export const lockSuffix = (lock: ExtensionLock | undefined): string =>
	lock === "required" ? " · required" : lock === "global-off" ? " · off globally" : "";

export const noteSuffix = (note: ExtensionNote | undefined): string =>
	note === "not-installed" ? " · not installed" : "";

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
	private tab = 0;
	private disposed = false;
	private usable = false;
	private confirmingDiscard = false;
	private discardSelected = false;
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
	getTabIndex(): number { return this.tab; }
	getTabLabel(): string | undefined { return this.options.tabs?.[this.tab]; }
	getTabCount(): number { return this.options.tabs?.length ?? 0; }

	private move(delta: number, page = false): void {
		const count = this.filtered.length;
		if (count === 0) return;
		if (page) this.selected = Math.max(0, Math.min(count - 1, this.selected + delta));
		else this.selected = (this.selected + delta + count) % count;
	}

	private switchTab(delta: number): void {
		const count = this.getTabCount();
		if (count < 2) return;
		this.tab = (this.tab + delta + count) % count;
	}

	private lockFor(row: ExtensionManagerRow): ExtensionLock | undefined {
		return this.options.getLock ? this.options.getLock(row, this.tab) : row.lock;
	}

	private noteFor(row: ExtensionManagerRow): ExtensionNote | undefined {
		return this.options.getNote ? this.options.getNote(row, this.tab) : row.note;
	}

	private activate(): void {
		const row = this.getSelectedRow();
		if (row) this.options.onToggle(row, this.tab);
	}

	private save(): void {
		this.dispose();
		this.options.onDone("save");
	}

	handleInput(data: string): void {
		if (this.disposed) return;
		const kb = this.options.keybindings;
		const usable = this.usable && this.options.getHeight() === this.renderedHeight &&
			this.options.getWidth?.() === this.renderedTerminalWidth &&
			this.options.getTerminalHeight?.() === this.renderedTerminalHeight;
		if (this.confirmingDiscard) {
			if (kb.matches(data, "tui.select.cancel")) {
				this.confirmingDiscard = false;
				this.discardSelected = false;
			} else if (usable && (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.pageUp"))) {
				this.discardSelected = false;
			} else if (usable && (kb.matches(data, "tui.select.down") || kb.matches(data, "tui.select.pageDown"))) {
				this.discardSelected = true;
			} else if (usable && kb.matches(data, "tui.select.confirm")) {
				if (this.discardSelected) {
					this.dispose();
					this.options.onDone("cancel");
					return;
				}
				this.confirmingDiscard = false;
			}
			this.invalidate();
			this.options.onChange();
			return;
		}
		if (usable && matchesKey(data, SAVE_KEY)) {
			this.save();
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			if (this.options.getStagedCount() === 0) {
				this.dispose();
				this.options.onDone("cancel");
			} else {
				this.confirmingDiscard = true;
				this.discardSelected = false;
				this.invalidate();
				this.options.onChange();
			}
			return;
		}
		if (!usable) return;

		// Tab switches scope, matching Pi's native `pi config` scope key. Shift+Tab is the
		// reverse direction; both only change the view, never staged state.
		if (matchesKey(data, "shift+tab")) {
			this.switchTab(-1);
			this.invalidate();
			this.options.onChange();
			return;
		}
		if (kb.matches(data, "tui.input.tab") || matchesKey(data, "tab")) {
			this.switchTab(1);
			this.invalidate();
			this.options.onChange();
			return;
		}

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
		const tabRows = this.getTabCount() > 1 ? 1 : 0;
		const compactHint = tabRows ? `${COMPACT_SAVE_HINT} · Tab · ${cancelName}` : `${COMPACT_SAVE_HINT} · ${cancelName} cancel`;
		const actionHint = tabRows
			? `${SAVE_HINT} · Tab scope · ${confirmName} toggle · ${cancelName} cancel`
			: `${SAVE_HINT} · ${confirmName} toggle · ${cancelName} cancel`;
		const contentWidth = Math.max(0, width - 4);
		const bordered = (line: string) => theme.fg("border", "│") + " " + fill(line, contentWidth) + " " + theme.fg("border", "│");
		if (this.confirmingDiscard) {
			if (width < 21 || height < 5) {
				const text = [`Discard? Resize required`, `${cancelName} keep editing`];
				return text.slice(0, height).map((line) => theme.fg("warning", clip(line)));
			}
			this.usable = true;
			const lines = [
				theme.fg("border", `╭${"─".repeat(width - 2)}╮`),
				bordered(theme.fg("warning", `Discard ${this.options.getStagedCount()} staged change${this.options.getStagedCount() === 1 ? "" : "s"}?`)),
				bordered(this.discardSelected ? "  Keep editing" : theme.fg("accent", "› Keep editing")),
				bordered(this.discardSelected ? theme.fg("accent", "› Discard changes") : "  Discard changes"),
			];
			if (height >= 6) lines.push(bordered(theme.fg("dim", `${confirmName} choose · ${cancelName} keep`)));
			lines.push(theme.fg("border", `╰${"─".repeat(width - 2)}╯`));
			return lines.map((line) => clip(line));
		}
		if (width < 24 || height < 10 + tabRows || visibleWidth(compactHint) > contentWidth) {
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
		const bodyRows = Math.min(10, Math.max(1, height - 7 - tabRows), Math.max(1, this.options.rows.length));
		this.pageSize = bodyRows;
		const selectedExtension = this.filtered.length === 0 ? 0 : Math.min(this.selected, this.filtered.length - 1);
		const { start, end } = extensionViewport(selectedExtension, this.filtered.length, bodyRows);
		const up = start > 0 ? `  ↑ ${start} more` : "";
		const down = end < this.filtered.length ? `  ↓ ${this.filtered.length - end} more` : "";
		const lines = [
			theme.fg("border", `╭${"─".repeat(width - 2)}╮`),
			bordered(theme.bold(clip(title, contentWidth))),
		];
		if (tabRows > 0) {
			const separator = theme.fg("borderMuted", " │ ");
			const tabs = (this.options.tabs ?? []).map((label, index) =>
				index === this.tab ? theme.bold(theme.fg("accent", label)) : theme.fg("muted", label));
			lines.push(bordered(clip(tabs.join(separator), contentWidth)));
		}
		lines.push(bordered(clip(search, contentWidth)));
		lines.push(bordered(theme.fg("borderMuted", clip(up, contentWidth))));

		for (let slot = 0; slot < bodyRows; slot++) {
			const index = start + slot;
			const row = this.filtered[index];
			if (!row) {
				lines.push(bordered(slot === 0 ? theme.fg("warning", clip("  No matching extensions", contentWidth)) : ""));
				continue;
			}
			const active = index === this.selected;
			const enabled = this.options.getEnabled(row, this.tab);
			const lock = this.lockFor(row);
			const marker = active ? theme.fg("accent", "›") : " ";
			const checkbox = enabled ? theme.fg("success", "[x]") : "[ ]";
			const label = cleanText(row.label) + lockSuffix(lock) + (lock ? "" : noteSuffix(this.noteFor(row)));
			lines.push(bordered(clip(`${marker} ${checkbox} ${active ? theme.bold(label) : lock ? theme.fg("muted", label) : label}`, contentWidth)));
		}
		lines.push(bordered(theme.fg("borderMuted", clip(down, contentWidth))));

		const fullHint = tabRows
			? `${SAVE_HINT} · Type search · ↑↓ move · Tab scope · ${confirmName} toggle · ${cancelName} cancel`
			: `${SAVE_HINT} · Type search · ↑↓ move · ${confirmName} toggle · ${cancelName} cancel`;
		const moveHint = tabRows
			? `${SAVE_HINT} · ↑↓ move · Tab scope · ${confirmName} toggle · ${cancelName} cancel`
			: `${SAVE_HINT} · ↑↓ move · ${confirmName} toggle · ${cancelName} cancel`;
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
