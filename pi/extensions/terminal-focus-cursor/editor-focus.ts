import type { EditorComponent, EditorTheme, TUI } from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";

export const FOCUS_IN = "\x1b[I";
export const FOCUS_OUT = "\x1b[O";

const PATCHED = Symbol.for("milo.pi.terminal-focus-cursor.patched");
const WRAPPED_FACTORY = Symbol.for("milo.pi.terminal-focus-cursor.wrapped-factory");
const INVERSE_VIDEO_SPAN = /\x1b\[7m([\s\S]*?)\x1b\[(?:0|27)m/g;

export type EditorFactory = (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => EditorComponent;

type PatchableEditor = EditorComponent & {
	focused?: boolean;
	dispose?: () => void;
	[PATCHED]?: true;
};

type WrappedEditorFactory = EditorFactory & {
	[WRAPPED_FACTORY]?: { baseFactory: EditorFactory | undefined };
};

export interface EditorUI {
	getEditorComponent(): EditorFactory | undefined;
	setEditorComponent(factory: EditorFactory): void;
}

export interface Scheduler {
	setTimeout(callback: () => void, delay: number): unknown;
	clearTimeout(handle: unknown): void;
}

interface EditorFocusDependencies {
	createDefaultEditor: EditorFactory;
	scheduler: Scheduler;
}

export interface EditorFocus {
	setFocused(focused: boolean): void;
	handleTerminalInput(data: string): { consume: true } | undefined;
	install(ui: EditorUI): void;
	cleanup(): void;
}

export function isFocusEvent(data: string): boolean {
	return data === FOCUS_IN || data === FOCUS_OUT;
}

export function createEditorFocus({ createDefaultEditor, scheduler }: EditorFocusDependencies): EditorFocus {
	let paneFocused = true;
	let tui: TUI | undefined;
	let editor: PatchableEditor | undefined;
	let installTimer: unknown;

	const setFocused = (focused: boolean): void => {
		if (paneFocused === focused) return;
		paneFocused = focused;
		editor?.invalidate?.();
		tui?.requestRender();
	};

	const patchEditor = (nextEditor: PatchableEditor, nextTui: TUI): PatchableEditor => {
		tui = nextTui;
		editor = nextEditor;
		if (nextEditor[PATCHED]) return nextEditor;

		const originalRender = nextEditor.render.bind(nextEditor);
		const originalHandleInput = nextEditor.handleInput.bind(nextEditor);
		const originalDispose = nextEditor.dispose?.bind(nextEditor);

		nextEditor.render = (width: number): string[] => {
			const previousFocused = nextEditor.focused;
			if (!paneFocused && previousFocused !== undefined) nextEditor.focused = false;

			try {
				const lines = originalRender(width);
				return paneFocused
					? lines
					: lines.map((line) => line.replace(INVERSE_VIDEO_SPAN, "$1"));
			} finally {
				if (previousFocused !== undefined) nextEditor.focused = previousFocused;
			}
		};

		nextEditor.handleInput = (data: string): void => {
			if (isFocusEvent(data)) {
				setFocused(data === FOCUS_IN);
				return;
			}
			originalHandleInput(data);
		};

		nextEditor.dispose = () => {
			if (editor === nextEditor) editor = undefined;
			originalDispose?.();
		};

		nextEditor[PATCHED] = true;
		return nextEditor;
	};

	return {
		setFocused,
		handleTerminalInput(data) {
			if (!isFocusEvent(data)) return undefined;
			setFocused(data === FOCUS_IN);
			return { consume: true };
		},
		install(ui) {
			if (installTimer !== undefined) scheduler.clearTimeout(installTimer);
			installTimer = scheduler.setTimeout(() => {
				installTimer = undefined;
				const previousFactory = ui.getEditorComponent() as WrappedEditorFactory | undefined;
				const baseFactory = previousFactory?.[WRAPPED_FACTORY]?.baseFactory ?? previousFactory;
				const focusCursorFactory = ((nextTui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => {
					const nextEditor = baseFactory
						? baseFactory(nextTui, theme, keybindings)
						: createDefaultEditor(nextTui, theme, keybindings);
					return patchEditor(nextEditor as PatchableEditor, nextTui);
				}) as WrappedEditorFactory;
				focusCursorFactory[WRAPPED_FACTORY] = { baseFactory };
				ui.setEditorComponent(focusCursorFactory);
			}, 0);
		},
		cleanup() {
			if (installTimer !== undefined) scheduler.clearTimeout(installTimer);
			installTimer = undefined;
			editor = undefined;
			tui = undefined;
		},
	};
}
