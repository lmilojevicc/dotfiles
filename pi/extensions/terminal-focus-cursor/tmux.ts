import type { EditorFocus } from "./editor-focus.ts";
import { FocusEventScanner } from "./focus-events.ts";
import type { StdinIngress } from "./herdr.ts";

export const ENABLE_FOCUS_EVENTS = "\x1b[?1004h";
export const DISABLE_FOCUS_EVENTS = "\x1b[?1004l";

interface TerminalUI {
	onTerminalInput(listener: (data: string) => { consume: true } | undefined): () => void;
}

export interface TerminalOutput {
	write(data: string): unknown;
}

export interface TmuxIngress {
	start(ui: TerminalUI): void;
	cleanup(): void;
}

/** Observe focus before fullscreen consumes it and balance this integration's DEC mode writes. */
export function createTmuxIngress(focus: EditorFocus, stdin: StdinIngress, output: TerminalOutput): TmuxIngress {
	const scanner = new FocusEventScanner();
	let unsubscribeInput: (() => void) | undefined;
	let rawInputListener: ((data: string | Buffer) => void) | undefined;
	let focusEventsEnabled = false;

	const cleanupListeners = (): void => {
		unsubscribeInput?.();
		unsubscribeInput = undefined;
		if (rawInputListener) stdin.removeListener("data", rawInputListener);
		rawInputListener = undefined;
		scanner.reset();
	};

	return {
		start(ui) {
			if (!focusEventsEnabled) {
				output.write(ENABLE_FOCUS_EVENTS);
				focusEventsEnabled = true;
			}
			cleanupListeners();
			rawInputListener = (data) => {
				for (const focused of scanner.scan(data.toString())) focus.setFocused(focused);
			};
			stdin.prependListener("data", rawInputListener);
			unsubscribeInput = ui.onTerminalInput((data) => focus.handleTerminalInput(data));
		},
		cleanup() {
			cleanupListeners();
			if (focusEventsEnabled) {
				output.write(DISABLE_FOCUS_EVENTS);
				focusEventsEnabled = false;
			}
		},
	};
}
