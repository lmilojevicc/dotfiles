import type { Theme } from "@earendil-works/pi-coding-agent";
import { Input, SelectList, matchesKey, truncateToWidth, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";
import { filterMessages, type JumpMessage } from "./messages.ts";

export class MessagePicker {
	private input = new Input({ prompt: "Search: ", placeholder: "full prompt text" });
	private list!: SelectList;
	private matches: JumpMessage[] = [];
	private selected = 0;
	private visible = 8;
	private closed = false;
	private messages: JumpMessage[];
	private tui: TUI;
	private theme: Theme;
	private kb: KeybindingsManager;
	private done: (id: string | undefined) => void;
	constructor(messages: JumpMessage[], tui: TUI, theme: Theme,
		kb: KeybindingsManager, done: (id: string | undefined) => void, query = "") {
		this.messages = messages; this.tui = tui; this.theme = theme; this.kb = kb; this.done = done;
		this.input.setValue(query);
		this.rebuild();
	}
	get focused(): boolean { return this.input.focused; }
	set focused(value: boolean) { this.input.focused = value; }
	private rebuild(): void {
		this.matches = filterMessages(this.messages, this.input.getValue());
		this.selected = Math.max(0, Math.min(this.selected, this.matches.length - 1));
		this.list = new SelectList(this.matches.map((item) => ({ value: item.id,
			label: `${item.unavailable ? "[unavailable] " : ""}${item.preview}` })), this.visible, {
			selectedPrefix: (s) => this.theme.fg("accent", s), selectedText: (s) => this.theme.fg("accent", s),
			description: (s) => this.theme.fg("muted", s), scrollInfo: (s) => this.theme.fg("dim", s), noMatch: (s) => this.theme.fg("warning", s),
		});
		this.list.setSelectedIndex(this.selected);
	}
	cancel(): void { this.finish(undefined); }
	private finish(id: string | undefined): void {
		if (this.closed) return;
		this.closed = true;
		this.done(id);
	}
	handleInput(data: string): void {
		if (this.closed) return;
		if (matchesKey(data, "escape") || this.kb.matches(data, "tui.select.cancel")) this.cancel();
		else if (this.kb.matches(data, "tui.select.confirm")) {
			const item = this.matches[this.selected];
			if (item) this.finish(item.id);
		} else if (this.kb.matches(data, "tui.select.up") || this.kb.matches(data, "tui.select.down")) {
			const delta = this.kb.matches(data, "tui.select.up") ? -1 : 1;
			if (this.matches.length) this.selected = (this.selected + delta + this.matches.length) % this.matches.length;
			this.list.setSelectedIndex(this.selected);
		} else if (this.kb.matches(data, "tui.select.pageUp") || this.kb.matches(data, "tui.select.pageDown")) {
			const delta = this.kb.matches(data, "tui.select.pageUp") ? -this.visible : this.visible;
			this.selected = Math.max(0, Math.min(this.matches.length - 1, this.selected + delta));
			this.list.setSelectedIndex(this.selected);
		} else {
			const before = this.input.getValue();
			this.input.handleInput(data);
			if (this.input.getValue() !== before) { this.selected = 0; this.rebuild(); }
		}
		this.tui.requestRender();
	}
	render(width: number): string[] {
		const visible = Math.max(1, Math.min(8, (this.tui.terminal.rows || 24) - 7));
		if (visible !== this.visible) { this.visible = visible; this.rebuild(); }
		const keys = (action: "tui.select.up" | "tui.select.down" | "tui.select.confirm" | "tui.select.cancel") => this.kb.getKeys(action).join("/") || "unbound";
		const lines = [this.theme.fg("accent", `Jump to user message (${this.matches.length}/${this.messages.length})`),
			...this.input.render(Math.max(1, width)),
			...(this.matches.length ? this.list.render(Math.max(4, width)) : [this.theme.fg("warning", "No matching messages")]),
			this.theme.fg("dim", `${keys("tui.select.up")}/${keys("tui.select.down")} navigate · ${keys("tui.select.confirm")} jump · Esc/${keys("tui.select.cancel")} cancel`)];
		return lines.map((line) => truncateToWidth(line, Math.max(1, width), ""));
	}
	invalidate(): void { this.input.invalidate(); this.list.invalidate(); }
	dispose(): void { this.closed = true; }
}
