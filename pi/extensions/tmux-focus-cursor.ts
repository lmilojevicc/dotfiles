import { CustomEditor, type EditorFactory, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { EditorComponent, EditorTheme, TUI } from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";

const ENABLE_FOCUS_EVENTS = "\x1b[?1004h";
const DISABLE_FOCUS_EVENTS = "\x1b[?1004l";
const FOCUS_IN = "\x1b[I";
const FOCUS_OUT = "\x1b[O";

const PATCHED = Symbol.for("milo.pi.tmux-focus-cursor.patched");
const WRAPPED_FACTORY = Symbol.for("milo.pi.tmux-focus-cursor.wrapped-factory");

type PatchableEditor = EditorComponent & {
	focused?: boolean;
	dispose?: () => void;
	[PATCHED]?: true;
};

type WrappedEditorFactory = EditorFactory & {
	[WRAPPED_FACTORY]?: { baseFactory: EditorFactory | undefined };
};

interface FocusState {
	paneFocused: boolean;
	tui?: TUI;
	editor?: PatchableEditor;
}

// Pi's built-in editor renders the fake cursor with SGR inverse video. Some
// extension editors use 27m to end inverse video instead of a full 0m reset.
const INVERSE_VIDEO_SPAN = /\x1b\[7m([\s\S]*?)\x1b\[(?:0|27)m/g;

function isFocusEvent(data: string): boolean {
	return data === FOCUS_IN || data === FOCUS_OUT;
}

function setPaneFocused(state: FocusState, focused: boolean): void {
	if (state.paneFocused === focused) return;
	state.paneFocused = focused;
	state.editor?.invalidate?.();
	state.tui?.requestRender();
}

function withoutFakeCursor(lines: string[]): string[] {
	return lines.map((line) => line.replace(INVERSE_VIDEO_SPAN, "$1"));
}

function patchEditor(editor: PatchableEditor, tui: TUI, state: FocusState): PatchableEditor {
	state.tui = tui;
	state.editor = editor;

	if (editor[PATCHED]) return editor;

	const originalRender = editor.render.bind(editor);
	const originalHandleInput = editor.handleInput.bind(editor);
	const originalDispose = editor.dispose?.bind(editor);

	editor.render = (width: number): string[] => {
		const previousFocused = editor.focused;

		if (!state.paneFocused && previousFocused !== undefined) {
			editor.focused = false;
		}

		try {
			const lines = originalRender(width);
			return state.paneFocused ? lines : withoutFakeCursor(lines);
		} finally {
			if (previousFocused !== undefined) {
				editor.focused = previousFocused;
			}
		}
	};

	editor.handleInput = (data: string): void => {
		if (isFocusEvent(data)) {
			setPaneFocused(state, data === FOCUS_IN);
			return;
		}

		originalHandleInput(data);
	};

	editor.dispose = () => {
		if (state.editor === editor) {
			state.editor = undefined;
		}
		originalDispose?.();
	};

	editor[PATCHED] = true;
	return editor;
}

export default function (pi: ExtensionAPI) {
	const state: FocusState = { paneFocused: true };
	let unsubscribeInput: (() => void) | undefined;
	let focusEventsEnabled = false;

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI || !process.env.TMUX) return;

		process.stdout.write(ENABLE_FOCUS_EVENTS);
		focusEventsEnabled = true;

		unsubscribeInput?.();
		unsubscribeInput = ctx.ui.onTerminalInput((data) => {
			if (!isFocusEvent(data)) return undefined;

			setPaneFocused(state, data === FOCUS_IN);
			return { consume: true };
		});

		// Defer so UI/theme/editor extensions that run during session_start can
		// install first; then patch whatever editor factory is currently active.
		setTimeout(() => {
			const previousFactory = ctx.ui.getEditorComponent() as WrappedEditorFactory | undefined;
			const baseFactory = previousFactory?.[WRAPPED_FACTORY]?.baseFactory ?? previousFactory;

			const focusCursorFactory = ((tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => {
				const editor = baseFactory
					? baseFactory(tui, theme, keybindings)
					: new CustomEditor(tui, theme, keybindings);

				return patchEditor(editor as PatchableEditor, tui, state);
			}) as WrappedEditorFactory;

			focusCursorFactory[WRAPPED_FACTORY] = { baseFactory };
			ctx.ui.setEditorComponent(focusCursorFactory);
		}, 0);
	});

	pi.on("session_shutdown", () => {
		unsubscribeInput?.();
		unsubscribeInput = undefined;
		state.editor = undefined;
		state.tui = undefined;

		if (focusEventsEnabled) {
			process.stdout.write(DISABLE_FOCUS_EVENTS);
			focusEventsEnabled = false;
		}
	});
}
