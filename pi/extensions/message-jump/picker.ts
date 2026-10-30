import { copyToClipboard, DynamicBorder, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, Input, Spacer, Text, matchesKey, truncateToWidth, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";
import { filterMessages, type JumpMessage } from "./messages.ts";

/** Inline /fork-style layout; only the search field owns a text cursor. */
export class MessagePicker extends Container {
	private input: Input;
	private matches: JumpMessage[] = [];
	private selected = 0;
	private visible = 10;
	private closed = false;
	private copying = false;
	private copyStatus = "";
	private copyColor: "muted" | "success" | "warning" = "muted";
	onCopy: (text: string) => void | Promise<void> = copyToClipboard;
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
		// Input.setValue keeps the field's own caret where it is, and a fresh Input starts at 0, so a
		// prefilled `/jump words` query would leave the caret before its first character. Insert
		// through the input's typing path instead: the caret then ends up after the query and typing
		// or Backspace refines it instead of prepending to it.
		for (const char of query) this.input.handleInput(char);
		this.rebuild();
		this.addChild(new Spacer(1));
		this.addChild({ render: (width) => new Text(this.theme.bold("Jump to Message"), 1, 0).render(width), invalidate() {} });
		this.addChild({ render: (width) => new Text(this.theme.fg("muted", "Select a user message to scroll to in the current transcript"), 1, 0).render(width), invalidate() {} });
		this.addChild(this.input);
		// Reuse the native spacer row for copy help and feedback without changing the layout height.
		this.addChild({ render: (width) => [truncateToWidth(this.theme.fg(this.copyColor, ` ${this.copyStatus || "Ctrl+Y copy highlighted message"}`), Math.max(1, width), "")], invalidate() {} });
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
	private async copyHighlighted(): Promise<void> {
		if (this.copying) return;
		const item = this.matches[this.selected];
		if (!item) return;
		if (!item.text) {
			this.copyStatus = "Selected message has no text to copy";
			this.copyColor = "warning";
			return;
		}
		this.copying = true;
		this.copyStatus = "Copying message…";
		this.copyColor = "muted";
		try {
			await this.onCopy(item.text);
			if (!this.closed) {
				this.copyStatus = `Copied message ${this.positions.get(item.id)} to clipboard`;
				this.copyColor = "success";
			}
		} catch (error) {
			if (!this.closed) {
				const reason = error instanceof Error ? error.message : String(error);
				this.copyStatus = `Copy failed: ${reason.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")}`;
				this.copyColor = "warning";
			}
		} finally {
			this.copying = false;
			if (!this.closed) this.tui.requestRender();
		}
	}
	private isPaging(data: string): boolean {
		return this.kb.matches(data, "tui.select.pageUp") || this.kb.matches(data, "tui.select.pageDown") ||
			matchesKey(data, "alt+up") || matchesKey(data, "alt+down");
	}
	handleInput(data: string): void {
		if (this.closed) return;
		// Ctrl+Y is reserved for copying, before configurable selector or Input yank bindings.
		if (matchesKey(data, "ctrl+y")) void this.copyHighlighted();
		else if (matchesKey(data, "escape") || this.kb.matches(data, "tui.select.cancel")) this.cancel();
		else if (this.kb.matches(data, "tui.select.confirm")) {
			const item = this.matches[this.selected];
			if (item) this.finish(item.id);
		} else if (this.kb.matches(data, "tui.select.up") || this.kb.matches(data, "tui.select.down")) {
			const delta = this.kb.matches(data, "tui.select.up") ? -1 : 1;
			if (this.matches.length) this.selected = (this.selected + delta + this.matches.length) % this.matches.length;
		} else if (this.isPaging(data)) {
			// PageUp/PageDown belong to the fullscreen viewport in the only supported mode, so paging
			// also has keys neither the viewport nor the search field uses: Alt+Up and Alt+Down.
			const delta = this.kb.matches(data, "tui.select.pageUp") || matchesKey(data, "alt+up") ? -this.visible : this.visible;
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
