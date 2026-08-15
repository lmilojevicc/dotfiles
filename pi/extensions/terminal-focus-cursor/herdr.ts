import type { EditorFocus } from "./editor-focus.ts";
import { FocusEventScanner } from "./focus-events.ts";

interface TerminalUI {
	onTerminalInput(listener: (data: string) => { consume: true } | undefined): () => void;
}

export interface StdinIngress {
	prependListener(event: "data", listener: (data: string | Buffer) => void): unknown;
	removeListener(event: "data", listener: (data: string | Buffer) => void): unknown;
}

export interface HerdrIngress {
	start(ui: TerminalUI): void;
	cleanup(): void;
}

/** Observe stdin before fullscreen consumes focus reports; herdr owns DEC mode. */
export function createHerdrIngress(focus: EditorFocus, stdin: StdinIngress): HerdrIngress {
	const scanner = new FocusEventScanner();
	let unsubscribeInput: (() => void) | undefined;
	let rawInputListener: ((data: string | Buffer) => void) | undefined;

	const cleanupListeners = (): void => {
		unsubscribeInput?.();
		unsubscribeInput = undefined;
		if (rawInputListener) stdin.removeListener("data", rawInputListener);
		rawInputListener = undefined;
		scanner.reset();
	};

	return {
		start(ui) {
			cleanupListeners();
			rawInputListener = (data) => {
				for (const focused of scanner.scan(data.toString())) focus.setFocused(focused);
			};
			stdin.prependListener("data", rawInputListener);
			unsubscribeInput = ui.onTerminalInput((data) => focus.handleTerminalInput(data));
		},
		cleanup: cleanupListeners,
	};
}
