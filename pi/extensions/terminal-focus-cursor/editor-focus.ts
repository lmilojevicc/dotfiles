import { CURSOR_MARKER, type EditorComponent, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";

export const FOCUS_IN = "\x1b[I";
export const FOCUS_OUT = "\x1b[O";

const PATCHED = Symbol.for("milo.pi.terminal-focus-cursor.patched");
const EDITOR_FACTORY_LAYERS = Symbol.for("milo.pi.editor-factory-layers.v1");
const FOCUS_LAYER_ID = "terminal-focus-cursor";
const INVERSE_VIDEO_SPAN = /\x1b\[7m([\s\S]*?)\x1b\[(?:0|27)m/g;
// pi-tui draws the editor cursor as zero-width APC markers: CURSOR_MARKER (exported from pi-tui) plus
// the FAKE_CURSOR_START/END pair around the cursor grapheme. TuiBase.resolveFakeCursors turns the fake
// cursor into `\x1b[7m`...`\x1b[27m` and extractCursorPosition consumes CURSOR_MARKER *after* the component
// renders, so the blurred branch has to strip all three markers itself.
const FAKE_CURSOR_START = "\x1b_pi:fc\x07";
const FAKE_CURSOR_END = "\x1b_pi:/fc\x07";
const CURSOR_MARKERS = [CURSOR_MARKER, FAKE_CURSOR_START, FAKE_CURSOR_END] as const;

/** Drop every cursor decoration a line carries, keeping the grapheme it wraps. */
function hideCursor(line: string): string {
	let hidden = line;
	for (const marker of CURSOR_MARKERS) hidden = hidden.replaceAll(marker, "");
	return hidden.replace(INVERSE_VIDEO_SPAN, "$1");
}

export type EditorFactory = (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => EditorComponent;

type PatchableEditor = EditorComponent & {
	focused?: boolean;
	dispose?: () => void;
	[PATCHED]?: true;
};

type EditorLayerBuilder = (baseFactory: EditorFactory | undefined) => EditorFactory;
type EditorLayerMetadata = {
	version: 1;
	baseFactory: EditorFactory | undefined;
	layers: Map<string, EditorLayerBuilder>;
};
type LayeredEditorFactory = EditorFactory & {
	[EDITOR_FACTORY_LAYERS]?: unknown;
};

function editorLayerMetadata(factory: EditorFactory | undefined): EditorLayerMetadata | undefined {
	const metadata = (factory as LayeredEditorFactory | undefined)?.[EDITOR_FACTORY_LAYERS];
	if (!metadata || typeof metadata !== "object") return undefined;
	const candidate = metadata as Partial<EditorLayerMetadata>;
	if (candidate.version !== 1 || !(candidate.layers instanceof Map)) return undefined;
	if (candidate.baseFactory !== undefined && typeof candidate.baseFactory !== "function") return undefined;
	for (const [id, layer] of candidate.layers) {
		if (typeof id !== "string" || typeof layer !== "function") return undefined;
	}
	return candidate as EditorLayerMetadata;
}

function installEditorLayer(
	currentFactory: EditorFactory | undefined,
	layerId: string,
	layer: EditorLayerBuilder,
): EditorFactory {
	const currentMetadata = editorLayerMetadata(currentFactory);
	const baseFactory = currentMetadata?.baseFactory ?? currentFactory;
	const layers = new Map(currentMetadata?.layers ?? []);
	layers.set(layerId, layer);

	let rebuiltFactory = baseFactory;
	for (const buildLayer of layers.values()) rebuiltFactory = buildLayer(rebuiltFactory);
	if (!rebuiltFactory) throw new Error("Editor layer did not produce a factory.");
	Object.defineProperty(rebuiltFactory, EDITOR_FACTORY_LAYERS, {
		configurable: true,
		value: { version: 1, baseFactory, layers } satisfies EditorLayerMetadata,
	});
	return rebuiltFactory;
}

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

export const __testing = Object.freeze({ installEditorLayer });

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

	// Pi restores its own cached default editor in resetExtensionUI() and loses in-memory prompt history
	// when a factory builds a fresh one, so the fallback editor is created once per TUI and reused.
	const defaultEditors = new WeakMap<TUI, EditorComponent>();

	const defaultEditorFor = (nextTui: TUI, theme: EditorTheme, keybindings: KeybindingsManager): EditorComponent => {
		const reused = defaultEditors.get(nextTui);
		if (reused) {
			// A reinstalled editor is new to Pi; drop the status indicator of the previous session.
			(reused as PatchableEditor & { setWorkingStatusIndicator?: (indicator: undefined) => void })
				.setWorkingStatusIndicator?.(undefined);
			return reused;
		}
		const created = createDefaultEditor(nextTui, theme, keybindings);
		defaultEditors.set(nextTui, created);
		return created;
	};

	const patchEditor = (nextEditor: PatchableEditor, nextTui: TUI): PatchableEditor => {
		tui = nextTui;
		editor = nextEditor;
		if (nextEditor[PATCHED]) return nextEditor;

		const originalRender = nextEditor.render.bind(nextEditor);
		const originalHandleInput = nextEditor.handleInput.bind(nextEditor);
		const originalDispose = nextEditor.dispose?.bind(nextEditor);

		nextEditor.render = (width: number): string[] => {
			// Host focus controls cursor presentation, not the editor's keyboard ownership.
			const lines = originalRender(width);
			return paneFocused ? lines : lines.map(hideCursor);
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
				const previousFactory = ui.getEditorComponent();
				const focusLayer: EditorLayerBuilder = (baseFactory) =>
					(nextTui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => {
						const nextEditor = baseFactory
							? baseFactory(nextTui, theme, keybindings)
							: defaultEditorFor(nextTui, theme, keybindings);
						return patchEditor(nextEditor as PatchableEditor, nextTui);
					};
				ui.setEditorComponent(installEditorLayer(previousFactory, FOCUS_LAYER_ID, focusLayer));
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
