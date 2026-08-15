import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	fuzzyFilter,
	Input,
	truncateToWidth,
	visibleWidth,
	type Component,
	type Focusable,
	type KeybindingsManager,
} from "@earendil-works/pi-tui";

const MAX_VISIBLE = 10;

export type ModelPickerEntry = {
	id: string;
	name?: string;
};

type ModelPickerOptions = {
	entries: readonly ModelPickerEntry[];
	configuredId?: string;
	defaultId?: string;
	theme: Pick<Theme, "bg" | "bold" | "fg">;
	keybindings: KeybindingsManager;
	onSelect: (id: string) => void;
	onCancel: () => void;
	onChange: () => void;
};

export class ModelPickerComponent implements Component, Focusable {
	private readonly entries: readonly ModelPickerEntry[];
	private readonly configuredId?: string;
	private readonly defaultId?: string;
	private readonly theme: ModelPickerOptions["theme"];
	private readonly keybindings: KeybindingsManager;
	private readonly onSelect: (id: string) => void;
	private readonly onCancel: () => void;
	private readonly onChange: () => void;
	private readonly searchInput = new Input();
	private filtered: readonly ModelPickerEntry[];
	private selectedIndex: number;
	private _focused = false;

	constructor(options: ModelPickerOptions) {
		this.entries = options.entries;
		this.configuredId = options.configuredId;
		this.defaultId = options.defaultId;
		this.theme = options.theme;
		this.keybindings = options.keybindings;
		this.onSelect = options.onSelect;
		this.onCancel = options.onCancel;
		this.onChange = options.onChange;
		this.filtered = this.entries;
		const initialId = this.configuredId ?? this.defaultId;
		const initialIndex = initialId ? this.entries.findIndex(({ id }) => id === initialId) : -1;
		this.selectedIndex = initialIndex >= 0 ? initialIndex : 0;
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	getQuery(): string {
		return this.searchInput.getValue();
	}

	getSelectedId(): string | undefined {
		return this.filtered[this.selectedIndex]?.id;
	}

	getFilteredIds(): string[] {
		return this.filtered.map(({ id }) => id);
	}

	getVisibleIds(): string[] {
		const { start, end } = this.visibleRange();
		return this.filtered.slice(start, end).map(({ id }) => id);
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.up")) {
			this.moveSelection(-1);
		} else if (this.keybindings.matches(data, "tui.select.down")) {
			this.moveSelection(1);
		} else if (this.keybindings.matches(data, "tui.select.pageUp")) {
			this.movePage(-MAX_VISIBLE);
		} else if (this.keybindings.matches(data, "tui.select.pageDown")) {
			this.movePage(MAX_VISIBLE);
		} else if (this.keybindings.matches(data, "tui.select.confirm")) {
			const selected = this.filtered[this.selectedIndex];
			if (selected) this.onSelect(selected.id);
			return;
		} else if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.onCancel();
			return;
		} else {
			const previousQuery = this.searchInput.getValue();
			this.searchInput.handleInput(data);
			const query = this.searchInput.getValue();
			if (query !== previousQuery) this.filter(query);
		}
		this.onChange();
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const lines = [
			truncateToWidth(this.theme.fg("accent", this.theme.bold("Session auto-rename model")), safeWidth, ""),
		];
		const searchPrefix = this.theme.fg("muted", "Search: ");
		const prefixWidth = visibleWidth(searchPrefix);
		if (safeWidth > prefixWidth) {
			const [inputLine = ""] = this.searchInput.render(Math.max(1, safeWidth - prefixWidth));
			lines.push(truncateToWidth(searchPrefix + inputLine, safeWidth, ""));
		} else {
			const [inputLine = ""] = this.searchInput.render(safeWidth);
			lines.push(truncateToWidth(inputLine, safeWidth, ""));
		}

		if (this.filtered.length === 0) {
			lines.push(truncateToWidth(this.theme.fg("warning", "  No matching models"), safeWidth, ""));
		} else {
			const { start, end } = this.visibleRange();
			for (let index = start; index < end; index += 1) {
				const entry = this.filtered[index];
				if (!entry) continue;
				const selected = index === this.selectedIndex;
				const displayName = entry.name && entry.name !== entry.id.split("/").at(-1)
					? ` — ${entry.name}`
					: "";
				const marker = entry.id === this.configuredId
					? " [configured]"
					: entry.id === this.defaultId
						? " [default]"
						: "";
				const text = `${selected ? "→ " : "  "}${entry.id}${displayName}${marker}`;
				const styled = selected
					? this.theme.bg("selectedBg", this.theme.fg("accent", text))
					: marker
						? this.theme.fg("success", text)
						: text;
				lines.push(truncateToWidth(styled, safeWidth, ""));
			}
			if (start > 0 || end < this.filtered.length) {
				lines.push(truncateToWidth(
					this.theme.fg("dim", `  (${this.selectedIndex + 1}/${this.filtered.length})`),
					safeWidth,
					"",
				));
			}
		}
		lines.push(truncateToWidth(this.theme.fg("dim", "↑↓ navigate • enter select • esc cancel"), safeWidth, ""));
		return lines;
	}

	invalidate(): void {
		this.searchInput.invalidate();
	}

	private filter(query: string): void {
		this.filtered = query
			? fuzzyFilter([...this.entries], query, ({ id, name }) => `${id} ${name ?? ""}`)
			: this.entries;
		this.selectedIndex = query ? 0 : Math.min(this.selectedIndex, Math.max(0, this.filtered.length - 1));
	}

	private moveSelection(offset: number): void {
		if (this.filtered.length === 0) return;
		const next = (this.selectedIndex + offset) % this.filtered.length;
		this.selectedIndex = next < 0 ? next + this.filtered.length : next;
	}

	private movePage(offset: number): void {
		if (this.filtered.length === 0) return;
		this.selectedIndex = Math.max(0, Math.min(this.selectedIndex + offset, this.filtered.length - 1));
	}

	private visibleRange(): { start: number; end: number } {
		const start = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(MAX_VISIBLE / 2), this.filtered.length - MAX_VISIBLE),
		);
		return { start, end: Math.min(start + MAX_VISIBLE, this.filtered.length) };
	}
}
