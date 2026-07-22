import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import {
	CustomEditor,
	type AppKeybinding,
	type EditorFactory,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionUIContext,
	type KeybindingsManager,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type Component,
	type EditorComponent,
	type EditorTheme,
	type TUI,
} from "@earendil-works/pi-tui";

const STATUS_KEY = "prefix-keybinds";
const ACTIVE_WIDGET_KEY = "prefix-keybinds.active";
const DEFAULT_PREFIX_KEY = "ctrl+x";
const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_CANCEL_KEYS = ["escape", "ctrl+c"];
const CONFIG_ENV_VAR = "PI_PREFIX_KEYBINDS_CONFIG";
const HELP_KEY = "?";
const VSTACK_MODAL_LOCK_SYMBOL = Symbol.for("vstack.pi.modal-lock");

type NativeActionInfo = {
	description: string;
	defaultKeys: string | string[];
};

type ExtensionAction = "pi.reload" | "pi.peek";
type PrefixAction = AppKeybinding | ExtensionAction;

const NATIVE_ACTIONS = {
	"app.interrupt": { defaultKeys: "escape", description: "Cancel or abort" },
	"app.clear": { defaultKeys: "ctrl+c", description: "Clear editor" },
	"app.exit": { defaultKeys: "ctrl+d", description: "Exit when editor is empty" },
	"app.suspend": { defaultKeys: "ctrl+z", description: "Suspend to background" },
	"app.thinking.cycle": { defaultKeys: "shift+tab", description: "Cycle thinking level" },
	"app.model.cycleForward": { defaultKeys: "ctrl+p", description: "Cycle to next model" },
	"app.model.cycleBackward": { defaultKeys: "shift+ctrl+p", description: "Cycle to previous model" },
	"app.model.select": { defaultKeys: "ctrl+l", description: "Open model selector" },
	"app.tools.expand": { defaultKeys: "ctrl+o", description: "Toggle tool output" },
	"app.thinking.toggle": { defaultKeys: "ctrl+t", description: "Toggle thinking blocks" },
	"app.session.toggleNamedFilter": {
		defaultKeys: "ctrl+n",
		description: "Toggle named session filter",
	},
	"app.editor.external": { defaultKeys: "ctrl+g", description: "Open external editor" },
	"app.message.followUp": { defaultKeys: "alt+enter", description: "Queue follow-up message" },
	"app.message.dequeue": { defaultKeys: "alt+up", description: "Restore queued messages" },
	"app.clipboard.pasteImage": { defaultKeys: "ctrl+v", description: "Paste image from clipboard" },
	"app.session.new": { defaultKeys: [], description: "Start a new session" },
	"app.session.tree": { defaultKeys: [], description: "Open session tree" },
	"app.session.fork": { defaultKeys: [], description: "Fork current session" },
	"app.session.resume": { defaultKeys: [], description: "Resume a session" },
	"app.tree.foldOrUp": {
		defaultKeys: ["ctrl+left", "alt+left"],
		description: "Fold tree branch or move up",
	},
	"app.tree.unfoldOrDown": {
		defaultKeys: ["ctrl+right", "alt+right"],
		description: "Unfold tree branch or move down",
	},
	"app.tree.editLabel": { defaultKeys: "shift+l", description: "Edit tree label" },
	"app.tree.toggleLabelTimestamp": {
		defaultKeys: "shift+t",
		description: "Toggle tree label timestamps",
	},
	"app.session.togglePath": { defaultKeys: "ctrl+p", description: "Toggle session path display" },
	"app.session.toggleSort": { defaultKeys: "ctrl+s", description: "Toggle session sort mode" },
	"app.session.rename": { defaultKeys: "ctrl+r", description: "Rename session" },
	"app.session.delete": { defaultKeys: "ctrl+d", description: "Delete session" },
	"app.session.deleteNoninvasive": {
		defaultKeys: "ctrl+backspace",
		description: "Delete session when query is empty",
	},
	"app.models.save": { defaultKeys: "ctrl+s", description: "Save model selection" },
	"app.models.enableAll": { defaultKeys: "ctrl+a", description: "Enable all models" },
	"app.models.clearAll": { defaultKeys: "ctrl+x", description: "Clear all models" },
	"app.models.toggleProvider": { defaultKeys: "ctrl+p", description: "Toggle all models for provider" },
	"app.models.reorderUp": { defaultKeys: "alt+up", description: "Move model up in order" },
	"app.models.reorderDown": { defaultKeys: "alt+down", description: "Move model down in order" },
	"app.tree.filter.default": { defaultKeys: "ctrl+d", description: "Tree filter: default view" },
	"app.tree.filter.noTools": { defaultKeys: "ctrl+t", description: "Tree filter: hide tool results" },
	"app.tree.filter.userOnly": { defaultKeys: "ctrl+u", description: "Tree filter: user messages only" },
	"app.tree.filter.labeledOnly": { defaultKeys: "ctrl+l", description: "Tree filter: labeled entries only" },
	"app.tree.filter.all": { defaultKeys: "ctrl+a", description: "Tree filter: show all entries" },
	"app.tree.filter.cycleForward": { defaultKeys: "ctrl+o", description: "Tree filter: cycle forward" },
	"app.tree.filter.cycleBackward": { defaultKeys: "shift+ctrl+o", description: "Tree filter: cycle backward" },
} satisfies Record<AppKeybinding, NativeActionInfo>;

const EXTENSION_ACTIONS = {
	"pi.reload": { defaultKeys: [], description: "Reload extensions, skills, prompts, and themes" },
	"pi.peek": { defaultKeys: [], description: "Open peek (session scrollback browser)" },
} satisfies Record<ExtensionAction, NativeActionInfo>;

const PREFIX_ACTIONS = {
	...NATIVE_ACTIONS,
	...EXTENSION_ACTIONS,
} satisfies Record<PrefixAction, NativeActionInfo>;

const DEFAULT_BINDINGS: Record<string, PrefixAction> = {
	m: "app.model.select",
	r: "pi.reload",
	n: "app.session.new",
	l: "app.session.resume",
	g: "app.session.tree",
	f: "app.session.fork",
	e: "app.editor.external",
	o: "app.tools.expand",
	t: "app.thinking.toggle",
	p: "pi.peek",
};

const PATCHED = Symbol.for("milo.pi.prefix-keybinds.patched");
const WRAPPED_FACTORY = Symbol.for("milo.pi.prefix-keybinds.wrapped-factory");

type RawBinding =
	| PrefixAction
	| {
			action: PrefixAction;
			label?: string;
			description?: string;
	  }
	| false
	| null
	| undefined;

type RawConfig = {
	prefixKey?: string;
	timeoutMs?: number;
	showHelp?: boolean;
	cancelKeys?: string[];
	replaceDefaults?: boolean;
	bindings?: Record<string, RawBinding>;
};

type ResolvedBinding = {
	key: string;
	label: string;
	description: string;
	action: PrefixAction;
};

type ResolvedConfig = {
	prefixKey: string;
	timeoutMs: number;
	showHelp: boolean;
	cancelKeys: string[];
	bindings: ResolvedBinding[];
	loadedPaths: string[];
};

type MutableConfig = Omit<ResolvedConfig, "bindings" | "loadedPaths"> & {
	bindings: Map<string, ResolvedBinding>;
	loadedPaths: string[];
};

type RuntimeState = {
	cwd: string;
	config: ResolvedConfig;
	warnings: string[];
};

type VstackModalLock = {
	depth: number;
};

type PrefixEditor = EditorComponent & {
	actionHandlers?: Map<AppKeybinding, () => void>;
	dispose?: () => void;
	[PATCHED]?: true;
};

type PrefixEditorFactory = EditorFactory & {
	[WRAPPED_FACTORY]?: { baseFactory?: EditorFactory };
};

let runtimeState: RuntimeState | undefined;
let prefixPaletteOpen = false;

function acquireVstackModalLock(): () => void {
	const host = globalThis as unknown as Record<PropertyKey, unknown>;
	const existing = host[VSTACK_MODAL_LOCK_SYMBOL] as VstackModalLock | undefined;
	const lock = existing && typeof existing.depth === "number" ? existing : { depth: 0 };
	host[VSTACK_MODAL_LOCK_SYMBOL] = lock;
	lock.depth += 1;

	let released = false;
	return () => {
		if (released) return;
		released = true;
		lock.depth = Math.max(0, lock.depth - 1);
	};
}

function isNativeAction(action: string): action is AppKeybinding {
	return Object.prototype.hasOwnProperty.call(NATIVE_ACTIONS, action);
}

function isPrefixAction(action: string): action is PrefixAction {
	return Object.prototype.hasOwnProperty.call(PREFIX_ACTIONS, action);
}

function prefixActionIds(): PrefixAction[] {
	return Object.keys(PREFIX_ACTIONS) as PrefixAction[];
}

function bindingFromAction(key: string, action: PrefixAction): ResolvedBinding {
	return {
		key,
		label: key,
		description: PREFIX_ACTIONS[action].description,
		action,
	};
}

function defaultMutableConfig(): MutableConfig {
	return {
		prefixKey: DEFAULT_PREFIX_KEY,
		timeoutMs: DEFAULT_TIMEOUT_MS,
		showHelp: true,
		cancelKeys: [...DEFAULT_CANCEL_KEYS],
		loadedPaths: [],
		bindings: new Map(Object.entries(DEFAULT_BINDINGS).map(([key, action]) => [key, bindingFromAction(key, action)])),
	};
}

function resolvedFromMutable(config: MutableConfig): ResolvedConfig {
	return {
		prefixKey: config.prefixKey,
		timeoutMs: config.timeoutMs,
		showHelp: config.showHelp,
		cancelKeys: config.cancelKeys,
		loadedPaths: config.loadedPaths,
		bindings: [...config.bindings.values()],
	};
}

function defaultResolvedConfig(): ResolvedConfig {
	return resolvedFromMutable(defaultMutableConfig());
}

function parseJsonConfig(text: string): RawConfig {
	return JSON.parse(text) as RawConfig;
}

function globalConfigPath(): string {
	return join(homedir(), ".pi", "agent", "prefix-keybinds.json");
}

function projectConfigPath(cwd: string): string {
	return join(cwd, ".pi", "prefix-keybinds.json");
}

function configPaths(cwd: string): string[] {
	const paths = [globalConfigPath(), projectConfigPath(cwd)];
	const envPath = process.env[CONFIG_ENV_VAR];
	if (envPath) paths.push(isAbsolute(envPath) ? envPath : resolve(cwd, envPath));

	return [...new Set(paths)];
}

function configWritePath(cwd: string, loadedPaths: string[]): string {
	const envPath = process.env[CONFIG_ENV_VAR];
	if (envPath) return isAbsolute(envPath) ? envPath : resolve(cwd, envPath);

	const projectPath = projectConfigPath(cwd);
	if (existsSync(projectPath)) return projectPath;

	return loadedPaths.at(-1) ?? globalConfigPath();
}

function readRawConfigs(cwd: string, warnings: string[]): Array<{ path: string; config: RawConfig }> {
	const configs: Array<{ path: string; config: RawConfig }> = [];

	for (const path of configPaths(cwd)) {
		if (!existsSync(path)) continue;

		try {
			configs.push({ path, config: parseJsonConfig(readFileSync(path, "utf8")) });
		} catch (error) {
			warnings.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	return configs;
}

function applyRawConfig(config: MutableConfig, raw: RawConfig, source: string, warnings: string[]) {
	if (typeof raw.prefixKey === "string" && raw.prefixKey.trim().length > 0) {
		config.prefixKey = raw.prefixKey.trim();
	}

	if (typeof raw.timeoutMs === "number" && Number.isFinite(raw.timeoutMs) && raw.timeoutMs > 0) {
		config.timeoutMs = raw.timeoutMs;
	}

	if (typeof raw.showHelp === "boolean") {
		config.showHelp = raw.showHelp;
	}

	if (Array.isArray(raw.cancelKeys) && raw.cancelKeys.every((key) => typeof key === "string")) {
		config.cancelKeys = raw.cancelKeys.filter((key) => key.trim().length > 0).map((key) => key.trim());
	}

	if (raw.replaceDefaults === true) {
		config.bindings.clear();
	}

	if (!raw.bindings || typeof raw.bindings !== "object" || Array.isArray(raw.bindings)) return;

	for (const [key, rawBinding] of Object.entries(raw.bindings)) {
		const normalizedKey = key.trim();
		if (!normalizedKey) {
			warnings.push(`${source}: ignored an empty binding key`);
			continue;
		}

		if (rawBinding === false || rawBinding === null || rawBinding === undefined) {
			config.bindings.delete(normalizedKey);
			continue;
		}

		const action = typeof rawBinding === "string" ? rawBinding : rawBinding.action;
		if (!isPrefixAction(action)) {
			warnings.push(`${source}: ignored ${normalizedKey} -> ${String(action)} because it is not a supported prefix action`);
			continue;
		}

		const label = typeof rawBinding === "string" ? normalizedKey : rawBinding.label?.trim() || normalizedKey;
		const description =
			typeof rawBinding === "string"
				? PREFIX_ACTIONS[action].description
				: rawBinding.description?.trim() || PREFIX_ACTIONS[action].description;

		config.bindings.set(normalizedKey, { key: normalizedKey, label, description, action });
	}
}

function loadConfig(cwd: string): { config: ResolvedConfig; warnings: string[] } {
	const warnings: string[] = [];
	const mutable = defaultMutableConfig();

	for (const { path, config } of readRawConfigs(cwd, warnings)) {
		mutable.loadedPaths.push(path);
		applyRawConfig(mutable, config, path, warnings);
	}

	return { warnings, config: resolvedFromMutable(mutable) };
}

function loadState(cwd: string): RuntimeState {
	const { config, warnings } = loadConfig(cwd);
	return { cwd, config, warnings };
}

function ensureState(cwd: string): RuntimeState {
	// Always re-read config so edits to prefix-keybinds.json apply without restarting Pi.
	// Keep last cwd for callers that only care about path; warnings only on path change.
	const next = loadState(cwd);
	if (!runtimeState || runtimeState.cwd !== cwd) {
		runtimeState = next;
		return runtimeState;
	}
	runtimeState = { ...next, warnings: [] };
	return runtimeState;
}

function rawConfigFromResolved(config: ResolvedConfig): RawConfig {
	const bindings: Record<string, RawBinding> = {};
	for (const binding of config.bindings) {
		const nativeDescription = PREFIX_ACTIONS[binding.action].description;
		bindings[binding.key] =
			binding.label === binding.key && binding.description === nativeDescription
				? binding.action
				: {
						action: binding.action,
						label: binding.label,
						description: binding.description,
					};
	}

	return {
		prefixKey: config.prefixKey,
		timeoutMs: config.timeoutMs,
		showHelp: config.showHelp,
		cancelKeys: config.cancelKeys,
		replaceDefaults: true,
		bindings,
	};
}

function persistConfig(cwd: string, config: ResolvedConfig): string {
	const path = configWritePath(cwd, config.loadedPaths);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(rawConfigFromResolved(config), null, 2)}\n`);
	runtimeState = { cwd, config: { ...config, loadedPaths: [path] }, warnings: [] };
	return path;
}

function withBinding(config: ResolvedConfig, key: string, action: PrefixAction): ResolvedConfig {
	const normalizedKey = key.trim();
	const binding = bindingFromAction(normalizedKey, action);
	const bindings = [...config.bindings];
	const existingIndex = bindings.findIndex((candidate) => candidate.key === normalizedKey);
	if (existingIndex >= 0) bindings[existingIndex] = binding;
	else bindings.push(binding);
	return { ...config, bindings };
}

function withoutBinding(config: ResolvedConfig, key: string): ResolvedConfig {
	return { ...config, bindings: config.bindings.filter((binding) => binding.key !== key) };
}

function formatMapping(binding: ResolvedBinding): string {
	return `${binding.key} → ${binding.action} — ${binding.description}`;
}

function formatAction(action: PrefixAction): string {
	return `${action} — ${PREFIX_ACTIONS[action].description}`;
}

function parseFormattedAction(value: string | undefined): PrefixAction | undefined {
	const action = value?.split(" — ")[0]?.trim();
	return action && isPrefixAction(action) ? action : undefined;
}

function parseFormattedMappingKey(value: string | undefined): string | undefined {
	return value?.split(" → ")[0]?.trim() || undefined;
}

class PrefixCommandPaletteComponent implements Component {
	private selected = 0;

	constructor(
		private readonly done: (binding: ResolvedBinding | undefined) => void,
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly config: ResolvedConfig,
	) {}

	invalidate(): void {}

	private terminalRows(): number {
		const tuiRows = (this.tui as TUI & { terminal?: { rows?: number } }).terminal?.rows;
		const rows = Number(tuiRows ?? process.stdout.rows ?? 30);
		return Number.isFinite(rows) && rows > 0 ? rows : 30;
	}

	private maxVisibleRows(): number {
		return Math.max(1, Math.min(12, this.config.bindings.length, this.terminalRows() - 8));
	}

	private requestRender(): void {
		this.tui.requestRender();
	}

	private moveSelected(delta: number): void {
		const max = Math.max(0, this.config.bindings.length - 1);
		this.selected = Math.max(0, Math.min(max, this.selected + delta));
		this.requestRender();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.done(undefined);
			return;
		}

		if (matchesKey(data, "return") || matchesKey(data, "enter")) {
			this.done(this.config.bindings[this.selected]);
			return;
		}

		if (matchesKey(data, "up")) {
			this.moveSelected(-1);
			return;
		}

		if (matchesKey(data, "down")) {
			this.moveSelected(1);
			return;
		}

		if (matchesKey(data, "pageUp")) {
			this.moveSelected(-this.maxVisibleRows());
			return;
		}

		if (matchesKey(data, "pageDown")) {
			this.moveSelected(this.maxVisibleRows());
			return;
		}

		const direct = this.config.bindings.find((binding) => matchesConfiguredKey(data, binding.key));
		if (direct) this.done(direct);
	}

	render(width: number): string[] {
		const renderWidth = Math.max(48, Math.min(96, width));
		const frameInner = Math.max(10, renderWidth - 2);
		const paddingX = 2;
		const inner = Math.max(1, frameInner - paddingX * 2);
		const theme = this.theme;
		const border = (value: string) => theme.fg("borderAccent", value);
		const accent = (value: string) => theme.fg("accent", value);
		const dim = (value: string) => theme.fg("dim", value);
		const muted = (value: string) => theme.fg("muted", value);
		const fixed = (value = "", rowWidth = inner) => {
			const safe = value.replace(/[\r\n\t]+/g, " ");
			const clipped = truncateToWidth(safe, rowWidth, "…");
			return clipped + " ".repeat(Math.max(0, rowWidth - visibleWidth(clipped)));
		};
		const row = (value = "", selected = false) => {
			const body = fixed(value);
			const rendered = selected ? theme.bg("selectedBg", body) : body;
			return `${border("┃")}${" ".repeat(paddingX)}${rendered}${" ".repeat(paddingX)}${border("┃")}`;
		};
		const divider = () => row(muted("━".repeat(inner)));
		const title = ` Prefix help ${this.config.prefixKey} `;
		const titleFill = Math.max(1, frameInner - visibleWidth(title));
		const top = `${border("┏")}${accent(title)}${border("━".repeat(titleFill))}${border("┓")}`;
		const bottom = border(`┗${"━".repeat(frameInner)}┛`);
		const maxVisible = this.maxVisibleRows();
		const start = Math.max(
			0,
			Math.min(this.selected - Math.floor(maxVisible / 2), this.config.bindings.length - maxVisible),
		);
		const end = Math.min(start + maxVisible, this.config.bindings.length);

		const lines = [top, row(`${this.config.bindings.length} mapped command(s)`), divider()];
		for (let index = start; index < end; index += 1) {
			const binding = this.config.bindings[index];
			if (!binding) continue;
			const selected = index === this.selected;
			const marker = selected ? "›" : " ";
			const key = accent(binding.key.padEnd(8));
			const action = dim(binding.action);
			const text = `${marker} ${key} ${binding.description} — ${action}`;
			lines.push(row(selected ? theme.bold(text) : text, selected));
		}

		if (this.config.bindings.length > maxVisible) {
			lines.push(row(dim(`${this.selected + 1}/${this.config.bindings.length}`)));
		}

		lines.push(divider());
		lines.push(row(`${accent("↑/↓")} choose  ${accent("enter")} run  ${accent("esc")} close  ${accent("mapped key")} run`));
		lines.push(bottom);
		return lines;
	}
}

async function showPrefixCommandPalette(
	ui: ExtensionUIContext,
	config: ResolvedConfig,
	onSelect?: (binding: ResolvedBinding) => void,
) {
	if (config.bindings.length === 0) {
		ui.notify("No prefix keybindings configured", "warning");
		return;
	}

	if (prefixPaletteOpen) return;

	prefixPaletteOpen = true;
	const releaseModalLock = acquireVstackModalLock();
	try {
		const selected = await ui.custom<ResolvedBinding | undefined>(
			(tui, theme, _keybindings, done) => new PrefixCommandPaletteComponent(done, tui, theme, config),
			{
				overlay: true,
				overlayOptions: {
					anchor: "center",
					width: 84,
					minWidth: 48,
					maxHeight: "90%",
				},
			},
		);
		if (selected && onSelect) onSelect(selected);
	} finally {
		prefixPaletteOpen = false;
		releaseModalLock();
	}
}

async function showNativeActionsModal(ui: ExtensionUIContext) {
	await ui.select("Pi/prefix actions", prefixActionIds().map(formatAction));
}

function notifyConfigSaved(ctx: ExtensionCommandContext, path: string) {
	ctx.ui.notify(`Saved prefix keybindings to ${path}`, "info");
}

async function chooseNativeAction(ctx: ExtensionCommandContext): Promise<PrefixAction | undefined> {
	return parseFormattedAction(await ctx.ui.select("Choose Pi/prefix action", prefixActionIds().map(formatAction)));
}

async function configurePrefix(ctx: ExtensionCommandContext) {
	const state = ensureState(ctx.cwd);
	const nextPrefix = (await ctx.ui.input("Prefix key", `Current: ${state.config.prefixKey}`))?.trim();
	if (!nextPrefix) return;

	const nextConfig = { ...state.config, prefixKey: nextPrefix };
	const path = persistConfig(ctx.cwd, nextConfig);
	notifyConfigSaved(ctx, path);
}

async function configureSetBinding(ctx: ExtensionCommandContext, keyArg?: string, actionArg?: string) {
	const state = ensureState(ctx.cwd);
	const key = keyArg?.trim() || (await ctx.ui.input("Key after prefix", "m, alt+m, ctrl+p, ..."))?.trim();
	if (!key) return;

	if (key === HELP_KEY) {
		ctx.ui.notify(`${state.config.prefixKey} ${HELP_KEY} is reserved for prefix help`, "warning");
		return;
	}

	const action = actionArg && isPrefixAction(actionArg) ? actionArg : await chooseNativeAction(ctx);
	if (!action) return;

	const nextConfig = withBinding(state.config, key, action);
	const path = persistConfig(ctx.cwd, nextConfig);
	notifyConfigSaved(ctx, path);
}

async function configureRemoveBinding(ctx: ExtensionCommandContext, keyArg?: string) {
	const state = ensureState(ctx.cwd);
	const key =
		keyArg?.trim() ||
		parseFormattedMappingKey(await ctx.ui.select("Remove mapping", state.config.bindings.map(formatMapping)));
	if (!key) return;

	const nextConfig = withoutBinding(state.config, key);
	const path = persistConfig(ctx.cwd, nextConfig);
	notifyConfigSaved(ctx, path);
}

async function configureReset(ctx: ExtensionCommandContext) {
	const confirmed = await ctx.ui.confirm("Reset prefix keybindings", "Replace your prefix keybindings with the defaults?");
	if (!confirmed) return;

	const nextConfig = { ...defaultResolvedConfig(), loadedPaths: ensureState(ctx.cwd).config.loadedPaths };
	const path = persistConfig(ctx.cwd, nextConfig);
	notifyConfigSaved(ctx, path);
}

async function configureWizard(ctx: ExtensionCommandContext) {
	const choice = await ctx.ui.select("Configure prefix keybindings", [
		"Show mappings",
		"Set prefix key",
		"Add/update mapping",
		"Remove mapping",
		"List actions",
		"Reset defaults",
	]);

	switch (choice) {
		case "Show mappings":
			await showPrefixCommandPalette(ctx.ui, ensureState(ctx.cwd).config);
			break;
		case "Set prefix key":
			await configurePrefix(ctx);
			break;
		case "Add/update mapping":
			await configureSetBinding(ctx);
			break;
		case "Remove mapping":
			await configureRemoveBinding(ctx);
			break;
		case "List actions":
			await showNativeActionsModal(ctx.ui);
			break;
		case "Reset defaults":
			await configureReset(ctx);
			break;
	}
}

async function handlePrefixCommand(args: string, ctx: ExtensionCommandContext) {
	const [subcommand = "show", ...rest] = args.trim().split(/\s+/).filter(Boolean);
	const state = ensureState(ctx.cwd);

	switch (subcommand) {
		case "show":
		case "list":
		case "help":
			await showPrefixCommandPalette(ctx.ui, state.config);
			break;
		case "config":
		case "configure":
			await configureWizard(ctx);
			break;
		case "actions":
			await showNativeActionsModal(ctx.ui);
			break;
		case "prefix":
			if (rest[0]) {
				const path = persistConfig(ctx.cwd, { ...state.config, prefixKey: rest[0] });
				notifyConfigSaved(ctx, path);
			} else {
				await configurePrefix(ctx);
			}
			break;
		case "set":
			await configureSetBinding(ctx, rest[0], rest[1]);
			break;
		case "unset":
		case "remove":
			await configureRemoveBinding(ctx, rest[0]);
			break;
		case "reset":
			await configureReset(ctx);
			break;
		default:
			ctx.ui.notify(
				"Usage: /prefix-keybinds [show|config|actions|prefix <key>|set <key> <action>|unset <key>|reset]",
				"warning",
			);
	}
}

function commandCompletions(prefix: string) {
	const args = prefix.trimStart().split(/\s+/);
	if (args.length <= 1) {
		const commands = ["show", "config", "actions", "prefix", "set", "unset", "reset"];
		return commands
			.filter((command) => command.startsWith(args[0] ?? ""))
			.map((command) => ({ value: command, label: command }));
	}

	if (args[0] === "set" && args.length >= 3) {
		const actionPrefix = args.at(-1) ?? "";
		return prefixActionIds()
			.filter((action) => action.startsWith(actionPrefix))
			.map((action) => ({ value: action, label: action }));
	}

	return null;
}

function hintText(ui: ExtensionUIContext, config: ResolvedConfig): string {
	const prefix = ui.theme.fg("accent", config.prefixKey);
	if (!config.showHelp) return `${prefix} prefix`;

	const hints = [
		`${ui.theme.fg("accent", HELP_KEY)} help`,
		...config.bindings.map((binding) => `${ui.theme.fg("accent", binding.label)} ${binding.description}`),
	].join(ui.theme.fg("muted", " · "));
	return `${prefix} prefix: ${hints}`;
}

function activeWidgetLines(ui: ExtensionUIContext, config: ResolvedConfig): string[] {
	const accent = (value: string) => ui.theme.fg("accent", value);
	const dim = (value: string) => ui.theme.fg("dim", value);
	const muted = (value: string) => ui.theme.fg("muted", value);
	const visibleBindings = config.bindings.slice(0, 8);
	const mappings = visibleBindings
		.map((binding) => `${accent(binding.label)} ${binding.description}`)
		.join(muted(" · "));
	const overflow = config.bindings.length > visibleBindings.length ? muted(` · +${config.bindings.length - visibleBindings.length}`) : "";

	return [
		`${accent("PREFIX ACTIVE")} ${dim("(")}${accent(config.prefixKey)}${dim(")")} ${muted("— waiting for next key")}`,
		`${accent(HELP_KEY)} help${muted(" · ")}${mappings}${overflow}${muted(" · esc cancel")}`,
	];
}

function showPrefixActiveState(ui: ExtensionUIContext, config: ResolvedConfig) {
	ui.setStatus(STATUS_KEY, hintText(ui, config));
	ui.setWidget(ACTIVE_WIDGET_KEY, activeWidgetLines(ui, config), { placement: "belowEditor" });
}

function clearPrefixActiveState(ui: ExtensionUIContext) {
	ui.setStatus(STATUS_KEY, undefined);
	ui.setWidget(ACTIVE_WIDGET_KEY, undefined);
}

function matchesConfiguredKey(data: string, key: string): boolean {
	if (data === key || matchesKey(data, key)) return true;
	// Letter bindings: terminals usually send a bare character ("p"), while configs
	// sometimes use "P" or users press Shift. Compare case-insensitively for single letters.
	const normalizedKey = key.trim();
	if (normalizedKey.length === 1 && data.length === 1) {
		return data.toLowerCase() === normalizedKey.toLowerCase();
	}
	return false;
}

function patchWithPrefix(
	editor: PrefixEditor,
	ui: ExtensionUIContext,
	getConfig: () => ResolvedConfig,
): PrefixEditor {
	if (editor[PATCHED]) return editor;

	const originalHandleInput = editor.handleInput.bind(editor);
	const originalDispose = editor.dispose?.bind(editor);
	let prefixActive = false;
	let timeout: ReturnType<typeof setTimeout> | undefined;

	const clearPrefix = () => {
		prefixActive = false;
		if (timeout) clearTimeout(timeout);
		timeout = undefined;
		clearPrefixActiveState(ui);
	};

	const activatePrefix = (config: ResolvedConfig) => {
		prefixActive = true;
		showPrefixActiveState(ui, config);
		if (timeout) clearTimeout(timeout);
		timeout = setTimeout(clearPrefix, config.timeoutMs);
	};

	const SLASH_ACTIONS: Partial<Record<ExtensionAction, { command: string; notify?: string }>> = {
		"pi.reload": { command: "/reload", notify: "Reloading pi resources..." },
		"pi.peek": { command: "/peek" },
	};

	const runBinding = (binding: ResolvedBinding) => {
		const slash = binding.action in SLASH_ACTIONS
			? SLASH_ACTIONS[binding.action as ExtensionAction]
			: undefined;
		if (slash) {
			const submit = editor.onSubmit;
			if (!submit) {
				ui.setEditorText(slash.command);
				ui.notify(`Inserted ${slash.command}; press Enter to run it`, "warning");
				return;
			}

			if (slash.notify) ui.notify(slash.notify, "info");
			void submit(slash.command);
			return;
		}

		const handler = editor.actionHandlers?.get(binding.action as AppKeybinding);
		if (!handler) {
			ui.notify(`${binding.action} is not available in this context`, "warning");
			return;
		}
		handler();
	};

	editor.handleInput = (data: string) => {
		const config = getConfig();

		if (prefixActive) {
			if (config.cancelKeys.some((key) => matchesConfiguredKey(data, key))) {
				clearPrefix();
				return;
			}

			if (matchesConfiguredKey(data, HELP_KEY)) {
				clearPrefix();
				void showPrefixCommandPalette(ui, config, runBinding).catch((error) => {
					ui.notify(error instanceof Error ? error.message : String(error), "error");
				});
				return;
			}

			const binding = config.bindings.find((candidate) => matchesConfiguredKey(data, candidate.key));
			clearPrefix();

			if (binding) {
				runBinding(binding);
				return;
			}

			const pressed = data.length === 1 && data >= " " ? data : data.replace(/\x1b/g, "esc");
			const available = config.bindings.map((b) => b.key).join(", ") || "(none)";
			ui.notify(
				`Unknown key after prefix ${config.prefixKey}: ${JSON.stringify(pressed)}. Bound: ${available}`,
				"warning",
			);
			return;
		}

		if (matchesConfiguredKey(data, config.prefixKey)) {
			activatePrefix(config);
			return;
		}

		originalHandleInput(data);
	};

	editor.dispose = () => {
		clearPrefix();
		originalDispose?.();
	};

	editor[PATCHED] = true;
	return editor;
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("prefix-keybinds", {
		description: "Show or configure prefix keybindings",
		getArgumentCompletions: commandCompletions,
		handler: handlePrefixCommand,
	});

	pi.registerCommand("prefix-keybinds-config", {
		description: "Configure prefix keybindings interactively",
		handler: async (_args, ctx) => configureWizard(ctx),
	});

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;

		runtimeState = loadState(ctx.cwd);
		for (const warning of runtimeState.warnings) {
			ctx.ui.notify(`prefix-keybinds config: ${warning}`, "warning");
		}

		// Defer so UI/theme extensions that install an editor during session_start
		// (for example pi-zentui) run first; then wrap whatever editor is active.
		setTimeout(() => {
			const previousFactory = ctx.ui.getEditorComponent() as PrefixEditorFactory | undefined;
			const baseFactory = previousFactory?.[WRAPPED_FACTORY]?.baseFactory ?? previousFactory;

			const prefixFactory = ((tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => {
				const editor = baseFactory ? baseFactory(tui, theme, keybindings) : new CustomEditor(tui, theme, keybindings);
				return patchWithPrefix(editor as PrefixEditor, ctx.ui, () => ensureState(ctx.cwd).config);
			}) as PrefixEditorFactory;
			prefixFactory[WRAPPED_FACTORY] = { baseFactory };

			ctx.ui.setEditorComponent(prefixFactory);
		}, 0);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		clearPrefixActiveState(ctx.ui);
	});
}
