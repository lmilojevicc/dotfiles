import {
	InteractiveMode,
	VERSION,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";

export const DEFAULT_READER_WIDTH = 110;
export const READER_STATE_ENTRY = "dotfiles.reader-mode";
export const SUPPORTED_PI_VERSION = "0.84.2";
const PATCH_KEY = Symbol.for("dotfiles.reader-mode.layout-patch.v1");
const LATE_INSTALL_WARNING_TITLE = "Reader mode needs a TUI remount";
const LATE_INSTALL_WARNING_MESSAGE =
	"Automatic remounting is unsafe in Pi 0.84.2. Restart Pi or switch TUI mode in /settings, then rerun the desired /reader command.";

type ReaderState = {
	enabled: boolean;
	width: number;
};

type RenderComponent = {
	render(width: number): string[];
};

type Renderer = {
	addChild(component: unknown): void;
	requestRender?: () => void;
	terminal?: { columns?: unknown };
};

type InteractiveModeInstance = {
	version?: unknown;
};

type InteractiveModePrototype = {
	init: (...args: unknown[]) => Promise<void>;
	mountInteractiveTui: (
		this: InteractiveModeInstance,
		tui: Renderer,
		components: unknown[],
	) => void;
	switchTuiMode: (...args: unknown[]) => unknown;
};

type ComponentPatch = {
	component: RenderComponent;
	originalRender: RenderComponent["render"];
	patchedRender: RenderComponent["render"];
};

type PatchRecord = {
	prototype: InteractiveModePrototype;
	originalMount: InteractiveModePrototype["mountInteractiveTui"];
	patchedMount: InteractiveModePrototype["mountInteractiveTui"];
	components: Map<RenderComponent, ComponentPatch>;
	state: ReaderState;
	owner: symbol;
	ownerReleased: boolean;
	mountedInstance?: InteractiveModeInstance;
	latestRenderer?: Renderer;
	layoutObserved: boolean;
	disabled: boolean;
	error?: string;
};

type DisabledRecord = {
	disabled: true;
	error: string;
};

type InstallResult =
	| { ok: true; record: PatchRecord }
	| { ok: false; error: string; tombstoned?: true };

const patchRegistry = globalThis as unknown as Record<PropertyKey, unknown>;

function defaultState(): ReaderState {
	return { enabled: false, width: DEFAULT_READER_WIDTH };
}

function isPositiveWidth(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function parseStoredState(data: unknown): ReaderState | undefined {
	if (typeof data !== "object" || data === null) return undefined;
	const candidate = data as Partial<ReaderState>;
	if (typeof candidate.enabled !== "boolean" || !isPositiveWidth(candidate.width)) return undefined;
	return { enabled: candidate.enabled, width: candidate.width };
}

export function restoreReaderState(entries: readonly SessionEntry[]): ReaderState {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type !== "custom" || entry.customType !== READER_STATE_ENTRY) continue;
		return parseStoredState(entry.data) ?? defaultState();
	}
	return defaultState();
}

export type ReaderCommandResult =
	| { ok: true; state: ReaderState }
	| { ok: false; error: string };

/** Empty toggles, on/off set the mode, and a positive integer sets width and enables it. */
export function parseReaderCommand(args: string, current: ReaderState): ReaderCommandResult {
	const value = args.trim().toLowerCase();
	if (value === "") return { ok: true, state: { ...current, enabled: !current.enabled } };
	if (value === "on") return { ok: true, state: { ...current, enabled: true } };
	if (value === "off") return { ok: true, state: { ...current, enabled: false } };
	if (/^[1-9]\d*$/.test(value)) {
		const width = Number(value);
		if (isPositiveWidth(width)) return { ok: true, state: { enabled: true, width } };
	}
	return {
		ok: false,
		error: "Usage: /reader [on|off|<positive integer width>]",
	};
}

function isRenderComponent(value: unknown): value is RenderComponent {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as RenderComponent).render === "function"
	);
}

function failLayout(record: PatchRecord, message: string): void {
	record.state = defaultState();
	record.error = `Reader mode disabled: ${message}`;
}

const LEADING_PROMPT_MARKERS = /^(?:(?:\x1b\]|\x9d)133;[ABC](?:;[^\x07\x1b\x9c]*)?(?:\x07|\x1b\\|\x9c))+/;

/** Keep semantic prompt markers anchored and reservation rows exactly empty. */
export function addVisualMargin(line: string, prefix: string): string {
	if (line === "") return line;
	const markers = line.match(LEADING_PROMPT_MARKERS)?.[0] ?? "";
	return markers + prefix + line.slice(markers.length);
}

function rendererWidth(record: PatchRecord, fallback: number): number {
	const columns = record.latestRenderer?.terminal?.columns;
	return isPositiveWidth(columns) ? columns : fallback;
}

function patchComponent(record: PatchRecord, component: RenderComponent): void {
	const existing = record.components.get(component);
	if (existing) {
		if (component.render !== existing.patchedRender) {
			failLayout(record, "another extension replaced a patched root component renderer");
		}
		return;
	}

	const originalRender = component.render;
	const patchedRender = function renderReaderColumn(this: RenderComponent, width: number): string[] {
		const availableWidth = Math.max(1, Math.floor(width));
		const terminalWidth = rendererWidth(record, availableWidth);
		if (!record.state.enabled || terminalWidth <= record.state.width) {
			return originalRender.call(this, width);
		}
		const contentWidth = record.state.width;
		const leftMargin = Math.floor((terminalWidth - contentWidth) / 2);
		const prefix = " ".repeat(leftMargin);
		return originalRender.call(this, contentWidth).map((line) => addVisualMargin(line, prefix));
	};

	component.render = patchedRender;
	record.components.set(component, { component, originalRender, patchedRender });
}

function restorePatch(record: PatchRecord): void {
	for (const patch of record.components.values()) {
		if (patch.component.render === patch.patchedRender) patch.component.render = patch.originalRender;
	}
	record.components.clear();
	if (record.prototype.mountInteractiveTui === record.patchedMount) {
		record.prototype.mountInteractiveTui = record.originalMount;
	}
	if (patchRegistry[PATCH_KEY] === record) delete patchRegistry[PATCH_KEY];
}

function disablePatch(record: PatchRecord): void {
	const error = "Reader mode disabled: only one InteractiveMode instance is supported per process";
	record.disabled = true;
	record.error = error;
	record.state = defaultState();
	restorePatch(record);
	patchRegistry[PATCH_KEY] = Object.freeze({ disabled: true, error } satisfies DisabledRecord);
}

export function installReaderPatch(owner: symbol, piVersion: string = VERSION): InstallResult {
	if (piVersion !== SUPPORTED_PI_VERSION) {
		return {
			ok: false,
			error: `Reader mode disabled: Pi ${piVersion} is unsupported; expected ${SUPPORTED_PI_VERSION}`,
		};
	}

	const prototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;
	const existing = patchRegistry[PATCH_KEY] as PatchRecord | DisabledRecord | undefined;
	if (existing) {
		if (!("prototype" in existing)) {
			return { ok: false, error: existing.error, tombstoned: true };
		}
		if (existing.prototype !== prototype || prototype.mountInteractiveTui !== existing.patchedMount) {
			return { ok: false, error: "Reader mode disabled: conflicting global layout patch detected" };
		}
		if (existing.ownerReleased) {
			existing.owner = owner;
			existing.ownerReleased = false;
		}
		return { ok: true, record: existing };
	}

	if (
		typeof prototype.init !== "function" ||
		typeof prototype.mountInteractiveTui !== "function" ||
		prototype.mountInteractiveTui.length !== 2 ||
		typeof prototype.switchTuiMode !== "function"
	) {
		return {
			ok: false,
			error: "Reader mode disabled: Pi interactive layout internals no longer match the guarded 0.84.2 seam",
		};
	}

	const originalMount = prototype.mountInteractiveTui;
	const record: PatchRecord = {
		prototype,
		originalMount,
		patchedMount: undefined as unknown as PatchRecord["patchedMount"],
		components: new Map(),
		state: defaultState(),
		owner,
		ownerReleased: false,
		layoutObserved: false,
		disabled: false,
	};
	const patchedMount: PatchRecord["patchedMount"] = function mountReaderMode(
		this: InteractiveModeInstance,
		tui: Renderer,
		components: unknown[],
	): void {
		if (record.mountedInstance && record.mountedInstance !== this) {
			disablePatch(record);
			originalMount.call(this, tui, components);
			return;
		}
		if (
			this.version !== SUPPORTED_PI_VERSION ||
			!Array.isArray(components) ||
			components.length !== 7 ||
			!components.every(isRenderComponent) ||
			typeof tui?.addChild !== "function"
		) {
			failLayout(record, "Pi interactive layout internals no longer match the guarded 0.84.2 seam");
			originalMount.call(this, tui, components);
			return;
		}

		record.mountedInstance = this;
		record.layoutObserved = true;
		record.latestRenderer = tui;
		for (const component of components) patchComponent(record, component);
		originalMount.call(this, tui, components);
	};
	record.patchedMount = patchedMount;
	prototype.mountInteractiveTui = patchedMount;
	patchRegistry[PATCH_KEY] = record;
	return { ok: true, record };
}

function notifyFailure(ctx: ExtensionContext, message: string): void {
	if (ctx.hasUI) ctx.ui.notify(message, "error");
}

function ownerError(record: PatchRecord, owner: symbol): string | undefined {
	if (record.disabled) return record.error;
	return record.owner === owner && !record.ownerReleased
		? undefined
		: "Reader mode disabled: this extension runtime no longer owns the interactive session";
}

function render(record: PatchRecord): void {
	record.latestRenderer?.requestRender?.();
}

function describe(state: ReaderState): string {
	return state.enabled
		? `Reader mode on (${state.width} columns)`
		: `Reader mode off (${state.width} columns retained)`;
}

export default function readerModeExtension(pi: ExtensionAPI): void {
	const owner = Symbol("reader-mode-extension-owner");
	const installation = installReaderPatch(owner);
	let tombstoneNotified = false;
	const notifyTombstone = (ctx: ExtensionContext, error: string): void => {
		if (tombstoneNotified || !ctx.hasUI) return;
		tombstoneNotified = true;
		notifyFailure(ctx, error);
	};

	pi.registerCommand("reader", {
		description: "Toggle reader mode or set its maximum width",
		handler: async (args, ctx) => {
			if (!installation.ok) {
				if (installation.tombstoned) notifyTombstone(ctx, installation.error);
				else notifyFailure(ctx, installation.error);
				return;
			}
			const record = installation.record;
			const ownershipFailure = ownerError(record, owner);
			if (ownershipFailure) {
				if (record.disabled) notifyTombstone(ctx, ownershipFailure);
				else notifyFailure(ctx, ownershipFailure);
				return;
			}
			if (record.error) {
				notifyFailure(ctx, record.error);
				return;
			}
			const result = parseReaderCommand(args, record.state);
			if (!result.ok) {
				notifyFailure(ctx, result.error);
				return;
			}
			if (!record.layoutObserved) {
				// Before the mount seam has been observed, state is still the disabled default.
				// "off" is therefore an idempotent no-op; enabling requires a real host remount.
				if (!result.state.enabled || ctx.mode !== "tui" || !ctx.hasUI) return;
				await ctx.ui.confirm(LATE_INSTALL_WARNING_TITLE, LATE_INSTALL_WARNING_MESSAGE, { timeout: 15_000 });
				return;
			}
			record.state = result.state;
			pi.appendEntry(READER_STATE_ENTRY, result.state);
			render(record);
			ctx.ui.notify(describe(result.state), "info");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		if (!installation.ok) {
			if (installation.tombstoned) notifyTombstone(ctx, installation.error);
			return;
		}
		const record = installation.record;
		if (record.disabled) {
			notifyTombstone(ctx, record.error!);
			return;
		}
		if (record.owner !== owner) return;
		record.ownerReleased = false;
		if (record.error) {
			notifyFailure(ctx, record.error);
			return;
		}
		if (!record.layoutObserved) return;
		record.state = restoreReaderState(ctx.sessionManager.getBranch());
		render(record);
	});

	pi.on("session_shutdown", (event, ctx) => {
		if (!installation.ok) {
			if (installation.tombstoned) notifyTombstone(ctx, installation.error);
			return;
		}
		const record = installation.record;
		if (record.disabled) {
			notifyTombstone(ctx, record.error!);
			return;
		}
		if (record.owner !== owner) return;
		record.state = defaultState();
		render(record);
		// Pi reuses the mounted component tree while reloading/replacing sessions. Keep an
		// inert patch then and release it only to the next extension runtime; on final quit
		// the methods can be restored safely.
		if (event.reason === "quit") restorePatch(record);
		else record.ownerReleased = true;
	});
}
