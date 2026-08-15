import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createEditorFocus, type EditorFactory, type EditorUI, type Scheduler } from "./editor-focus.ts";
import { createHerdrIngress, type StdinIngress } from "./herdr.ts";
import { createTmuxIngress, type TerminalOutput } from "./tmux.ts";

type Platform = "herdr" | "tmux";

type SelectionContext = {
	mode?: string;
	hasUI: boolean;
};

type TerminalUI = EditorUI & {
	onTerminalInput(listener: (data: string) => { consume: true } | undefined): () => void;
};

export interface TerminalFocusCursorDependencies {
	env: Record<string, string | undefined>;
	stdin: StdinIngress;
	output: TerminalOutput;
	scheduler: Scheduler;
	createDefaultEditor: EditorFactory;
}

export function selectPlatform(ctx: SelectionContext, env: Record<string, string | undefined>): Platform | undefined {
	if (env.HERDR_ENV === "1") return ctx.mode === "tui" ? "herdr" : undefined;
	return ctx.mode === "tui" && ctx.hasUI && env.TMUX ? "tmux" : undefined;
}

function defaultDependencies(): TerminalFocusCursorDependencies {
	return {
		env: process.env,
		stdin: process.stdin,
		output: { write: (data) => process.stdout.write(data) },
		scheduler: {
			setTimeout: (callback, delay) => setTimeout(callback, delay),
			clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
		},
		createDefaultEditor: (tui, theme, keybindings) => new CustomEditor(tui, theme, keybindings),
	};
}

export function createTerminalFocusCursor(
	pi: ExtensionAPI,
	dependencies: TerminalFocusCursorDependencies = defaultDependencies(),
): void {
	const focus = createEditorFocus(dependencies);
	const herdr = createHerdrIngress(focus, dependencies.stdin);
	const tmux = createTmuxIngress(focus, dependencies.stdin, dependencies.output);
	let activePlatform: Platform | undefined;

	const cleanupActivePlatform = (): void => {
		if (activePlatform === "herdr") herdr.cleanup();
		if (activePlatform === "tmux") tmux.cleanup();
		activePlatform = undefined;
	};

	pi.on("session_start", (_event, ctx) => {
		const platform = selectPlatform(ctx, dependencies.env);
		if (activePlatform && activePlatform !== platform) {
			cleanupActivePlatform();
			focus.cleanup();
		}
		if (!platform) {
			focus.cleanup();
			return;
		}

		const ui = ctx.ui as TerminalUI;
		activePlatform = platform;
		if (platform === "herdr") herdr.start(ui);
		else tmux.start(ui);
		focus.install(ui);
	});

	pi.on("session_shutdown", () => {
		cleanupActivePlatform();
		focus.cleanup();
	});
}

export default function terminalFocusCursor(pi: ExtensionAPI): void {
	createTerminalFocusCursor(pi);
}
