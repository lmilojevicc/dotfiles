import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ModelPickerComponent } from "./component.ts";
import { catalogue, modelLabel, type PickerModel } from "./domain.ts";
import { switchAndSave } from "./persistence.ts";
import { favoritesError, readFavorites, toggleFavorite } from "./favorites.ts";

export default function modelPicker(pi: ExtensionAPI): void {
	let opening = false;
	let generation = 0;
	let cancelPicker: (() => void) | undefined;
	let unsubscribe: (() => void) | undefined;

	const open = async (ctx: ExtensionContext): Promise<void> => {
		if (ctx.mode !== "tui") {
			const message = "/model-picker requires interactive terminal mode";
			if (ctx.hasUI) ctx.ui.notify(message, "warning");
			else throw new Error(message);
			return;
		}
		if (opening) return;
		opening = true;
		const started = generation;
		try {
			const models = catalogue(ctx);
			const agentDir = getAgentDir();
			let favorites: string[] = [], favoriteError: string | undefined;
			try { favorites = readFavorites(agentDir).favorites; }
			catch (error) { favoriteError = favoritesError(error); }
			const selected = await ctx.ui.custom<PickerModel | undefined>((tui, theme, keybindings, done) => {
				cancelPicker = () => done(undefined);
				return new ModelPickerComponent({
					models, current: ctx.model, scoped: ctx.scopedModels.length > 0,
					favorites, favoriteError, onToggleFavorite: (model) => toggleFavorite(model, agentDir),
					theme, keybindings,
					// Reserve vertical inset here, not via host margin: Pi can place a fixed
					// top margin outside a one-row terminal after resize.
					getHeight: () => Math.max(1, Math.min(22, Math.floor(tui.terminal.rows * 0.85), tui.terminal.rows - 2)),
					getWidth: () => tui.terminal.columns,
					getTerminalHeight: () => tui.terminal.rows,
					onChange: () => tui.requestRender(),
					onSelect: done,
					onCancel: () => done(undefined),
				});
			}, { overlay: true, overlayOptions: { width: "95%", maxHeight: "85%", margin: { left: 1, right: 1 }, anchor: "center" } });
			cancelPicker = undefined;
			if (!selected || started !== generation) return;
			const result = await switchAndSave(pi, ctx, selected);
			if (started !== generation) return;
			if (result.status === "saved") {
				ctx.ui.notify(`Switched to ${modelLabel(selected)}; saved global default (project settings may override it)`, "info");
			} else if (result.status === "switched-not-saved") {
				ctx.ui.notify(`Switched to ${modelLabel(selected)}, but global default was NOT saved: ${result.error}`, "error");
			} else if (result.status === "switch-failed") {
				ctx.ui.notify(`Model switch failed; active model may have changed. Global default was NOT saved: ${result.error}`, "error");
			} else ctx.ui.notify(`Model not changed: ${result.error}`, "error");
		} finally {
			cancelPicker = undefined;
			opening = false;
		}
	};

	pi.registerCommand("model-picker", {
		description: "Browse providers and models; switch and save the global default",
		handler: async (_args, ctx) => open(ctx),
	});
	pi.on("session_start", (_event, ctx) => {
		unsubscribe?.();
		// Public event protocol: the sender supplies a synchronous acknowledgement callback.
		// Dispatch directly so host slash submission never clears the editor/paste store.
		unsubscribe = pi.events.on("model-picker:open", (acknowledge: unknown) => {
			if (typeof acknowledge !== "function") return;
			(acknowledge as () => void)();
			const started = generation;
			void open(ctx).catch((error: unknown) => {
				if (started === generation) ctx.ui.notify(`Cannot open model picker: ${error instanceof Error ? error.message : String(error)}`, "error");
			});
		});
	});
	pi.on("session_shutdown", () => {
		generation++;
		unsubscribe?.();
		unsubscribe = undefined;
		cancelPicker?.();
	});
}
