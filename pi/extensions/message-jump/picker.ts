import { DynamicBorder, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, Input, Spacer, Text, matchesKey, truncateToWidth, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";
import { filterMessages, type JumpMessage } from "./messages.ts";

/** Inline /fork-style layout; only the search field owns a text cursor. */
export class MessagePicker extends Container {
	private input: Input;
	private matches: JumpMessage[] = [];
	private selected = 0;
	private visible = 10;
	private closed = false;
	private positions: Map<string, number>;
	private messages: JumpMessage[];
	private tui: TUI;
	private theme: Theme;
	private kb: KeybindingsManager;
	private done: (id: string | undefined) => void;
	constructor(messages: JumpMessage[], tui: TUI, theme: Theme,
		kb: KeybindingsManager, done: (id: string | undefined) => void, query = "") {
		super();
		this.messages = messages; this.tui = tui; this.theme = theme; this.kb = kb; this.done = done;
		this.positions = new Map(messages.map((message, i) => [message.id, i + 1]));
		this.input = new Input({ prompt: " Search: ", placeholder: "type to filter messages", placeholderStyle: (s) => this.theme.fg("muted", s) });
		this.input.setValue(query);
		this.rebuild();
		this.addChild(new Spacer(1));
		this.addChild({ render: (width) => new Text(this.theme.bold("Jump to Message"), 1, 0).render(width), invalidate() {} });
		this.addChild({ render: (width) => new Text(this.theme.fg("muted", "Select a user message to scroll to in the current transcript"), 1, 0).render(width), invalidate() {} });
		this.addChild(this.input);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder((s) => this.theme.fg("border", s)));
		this.addChild(new Spacer(1));
		this.addChild({ render: (width) => this.renderMessages(width), invalidate() {} });
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder((s) => this.theme.fg("border", s)));
	}
	get focused(): boolean { return this.input.focused; }
	set focused(value: boolean) { this.input.focused = value; }
	private rebuild(): void {
		this.matches = filterMessages(this.messages, this.input.getValue());
		this.selected = Math.max(0, this.matches.length - 1);
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
		} else if (this.kb.matches(data, "tui.select.pageUp") || this.kb.matches(data, "tui.select.pageDown")) {
			const delta = this.kb.matches(data, "tui.select.pageUp") ? -this.visible : this.visible;
			this.selected = Math.max(0, Math.min(this.matches.length - 1, this.selected + delta));
		} else {
			const before = this.input.getValue();
			this.input.handleInput(data);
			if (this.input.getValue() !== before) this.rebuild();
		}
		this.tui.requestRender();
	}
	private renderMessages(width: number): string[] {
		if (!this.matches.length) return [this.theme.fg("muted", "  No matching messages")];
		const start = Math.max(0, Math.min(this.selected - Math.floor(this.visible / 2), this.matches.length - this.visible));
		const end = Math.min(start + this.visible, this.matches.length);
		const lines: string[] = [];
		for (let i = start; i < end; i++) {
			const message = this.matches[i];
			const selected = i === this.selected;
			const cursor = selected ? this.theme.fg("accent", "› ") : "  ";
			const prompt = truncateToWidth(`${message.unavailable ? "[unavailable] " : ""}${message.preview}`, Math.max(0, width - 2));
			lines.push(cursor + (selected ? this.theme.bold(prompt) : prompt));
			lines.push(this.theme.fg("muted", `  Message ${this.positions.get(message.id)} of ${this.messages.length}`));
			lines.push("");
		}
		if (start > 0 || end < this.matches.length) lines.push(this.theme.fg("muted", `  (${this.selected + 1}/${this.matches.length})`));
		return lines;
	}
	render(width: number): string[] {
		width = Math.max(1, width);
		// Three rows per message; reserve seven chrome rows, one indicator and four host-footer rows.
		const headerRows = this.children[1].render(width).length + this.children[2].render(width).length;
		this.visible = Math.max(1, Math.min(10, Math.floor(((this.tui.terminal.rows || 24) - headerRows - 12) / 3)));
		return super.render(width).map((line) => truncateToWidth(line, width, ""));
	}
	dispose(): void { this.closed = true; }
}
