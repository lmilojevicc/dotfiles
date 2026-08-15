const FOCUS_IN = "\x1b[I";
const FOCUS_OUT = "\x1b[O";
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/** Finds split/coalesced DEC focus reports while excluding bracketed paste content. */
export class FocusEventScanner {
	private pendingPrefix = "";
	private inPaste = false;

	scan(chunk: string): boolean[] {
		const data = this.pendingPrefix + chunk;
		const changes: boolean[] = [];
		this.pendingPrefix = "";

		let offset = 0;
		while (offset < data.length) {
			const escape = data.indexOf("\x1b", offset);
			if (escape === -1) break;

			const remaining = data.slice(escape);
			if (this.inPaste) {
				if (remaining.startsWith(PASTE_END)) {
					this.inPaste = false;
					offset = escape + PASTE_END.length;
					continue;
				}
				if (PASTE_END.startsWith(remaining)) {
					this.pendingPrefix = remaining;
					break;
				}
				offset = escape + 1;
				continue;
			}

			if (remaining.startsWith(PASTE_START)) {
				this.inPaste = true;
				offset = escape + PASTE_START.length;
				continue;
			}
			if (remaining.startsWith(FOCUS_IN)) {
				changes.push(true);
				offset = escape + FOCUS_IN.length;
				continue;
			}
			if (remaining.startsWith(FOCUS_OUT)) {
				changes.push(false);
				offset = escape + FOCUS_OUT.length;
				continue;
			}

			if ([PASTE_START, FOCUS_IN, FOCUS_OUT].some((sequence) => sequence.startsWith(remaining))) {
				this.pendingPrefix = remaining;
				break;
			}

			offset = escape + 1;
		}

		return changes;
	}

	reset(): void {
		this.pendingPrefix = "";
		this.inPaste = false;
	}
}
