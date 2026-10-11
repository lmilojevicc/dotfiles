import { InteractiveMode, VERSION } from "@earendil-works/pi-coding-agent";
import { Container, ScrollView, Spacer, VStack } from "@earendil-works/pi-tui";
import type { JumpMessage } from "./messages.ts";

// These releases share the observed mount, message identity and fullscreen width contract.
export const SUPPORTED_PI_VERSIONS = ["1.0.4", "1.1.0"] as const;
const supportedVersion = (version: string): boolean => SUPPORTED_PI_VERSIONS.some((supported) => supported === version);
const KEY = Symbol.for("dotfiles.message-jump.bridge.v1");
const globals = globalThis as unknown as Record<PropertyKey, unknown>;
const containerRender = Container.prototype.render;
const contentWidth = ScrollView.prototype.getContentWidth;
const scrollTo = ScrollView.prototype.scrollTo;
type Component = { render(width: number): string[] };
type Group = Component & { children: Component[] };
type Renderer = { mode: string; terminal: { columns: number }; layoutRoot: unknown; renderNow(): void; requestRender(): void };
type Host = {
	version: string; renderer: Renderer; documentContainer: Group; chatContainer: Group; fullscreenLayoutRoot: unknown;
	transcriptScrollView: Component & { children: Component[]; viewportHeight: number; getContentWidth(width: number): number; scrollTo(row: number, options: { disableFollow: true }): void };
};
type Method = (this: Host, ...args: any[]) => any;
type Prototype = { mountInteractiveTui: Method; addMessageToChat: Method };
type RecordState = {
	prototype: Prototype; originalMount: Method; mount: Method; originalAdd: Method; add: Method;
	owner: symbol; released: boolean; host?: Host; targets: WeakMap<object, Component>; error?: string;
};
export type Bridge = { error(): string | undefined; unavailable(item: JumpMessage): string | undefined; jump(item: JumpMessage): string | undefined; release(quit: boolean): void };

function intact(record: RecordState): boolean {
	return record.prototype.mountInteractiveTui === record.mount && record.prototype.addMessageToChat === record.add;
}
function restore(record: RecordState): void {
	if (record.prototype.mountInteractiveTui === record.mount) record.prototype.mountInteractiveTui = record.originalMount;
	if (record.prototype.addMessageToChat === record.add) record.prototype.addMessageToChat = record.originalAdd;
	if (globals[KEY] === record) delete globals[KEY];
}
function layoutError(host: Host): string | undefined {
	const renderer = host.renderer;
	if (renderer?.mode !== "fullscreen") return "Use /settings → TUI mode → fullscreen, then run /jump. Regular mode scrollback belongs to the terminal.";
	const document = host.documentContainer;
	const chat = host.chatContainer;
	const scroll = host.transcriptScrollView;
	// The supported root stretches its transcript across terminal columns. Reject narrower wrappers.
	const root = host.fullscreenLayoutRoot as { children?: Component[]; align?: string; gap?: number; entries?: { component: unknown; visible?: unknown }[] } | undefined;
	if (!supportedVersion(host.version) || !document || !chat || !scroll ||
		document.render !== containerRender || chat.render !== containerRender ||
		!Array.isArray(document.children) || document.children.filter((c) => c === chat).length !== 1 ||
		!Array.isArray(chat.children) || scroll.children?.length !== 1 || scroll.children[0] !== document ||
		scroll.getContentWidth !== contentWidth || scroll.scrollTo !== scrollTo ||
		typeof renderer.renderNow !== "function" || typeof renderer.requestRender !== "function" ||
		renderer.layoutRoot !== root || !(host.fullscreenLayoutRoot instanceof VStack) || !root || root.align !== "stretch" || root.gap !== 0 ||
		root.children?.length !== 2 || root.children[0] !== scroll || root.entries?.length !== 2 ||
		root.entries[0].component !== scroll || root.entries.some((entry) => entry.visible !== undefined) || !Number.isSafeInteger(renderer.terminal?.columns) || renderer.terminal.columns < 1) {
		return "Unsupported transcript layout. Disable transcript/layout wrappers and restart a supported Pi build; /jump will not guess a destination.";
	}
	return undefined;
}

/** The only private seam: observe mount and user rendering, preserving host calls exactly once. */
export function installBridge(owner: symbol, version = VERSION): Bridge {
	const failed = (error: string): Bridge => ({ error: () => error, unavailable: () => error, jump: () => error, release() {} });
	if (!supportedVersion(version)) return failed(`Unsupported Pi ${version}. /jump requires Pi ${SUPPORTED_PI_VERSIONS.join(" or ")} fullscreen; update this extension's bridge before using other versions.`);
	const prototype = InteractiveMode.prototype as unknown as Prototype;
	let record = globals[KEY] as RecordState | undefined;
	if (record) {
		if (record.prototype !== prototype || !intact(record)) return failed("Conflicting /jump bridge wrapper. Restart Pi without the conflicting extension.");
		if (!record.released) return failed("Another /jump extension runtime already owns this process. Load message-jump only once.");
		record.owner = owner;
		record.released = false;
	} else {
		if (typeof prototype.mountInteractiveTui !== "function" || prototype.mountInteractiveTui.length !== 2 ||
			typeof prototype.addMessageToChat !== "function" || prototype.addMessageToChat.length !== 2) {
			return failed("Supported Pi interactive internals do not match /jump's guarded bridge. Restart with a supported Pi build.");
		}
		const state: RecordState = {
			prototype, originalMount: prototype.mountInteractiveTui, originalAdd: prototype.addMessageToChat,
			mount: undefined!, add: undefined!, owner, released: false, targets: new WeakMap(),
		};
		state.mount = function (tui, components) {
			const result = state.originalMount.call(this, tui, components);
			if (state.host && state.host !== this) state.error = "Multiple interactive instances are unsupported. Restart Pi with one interactive session.";
			else if (!supportedVersion(this.version) || tui !== this.renderer || !Array.isArray(components) || components.length !== 7 || components[0] !== this.documentContainer || components.some((c) => typeof c?.render !== "function")) state.error = "Unsupported Pi mount shape. Restart a supported Pi build with the standard interactive layout.";
			else state.host = this;
			return result;
		};
		state.add = function (message, options) {
			const chat = this.chatContainer;
			const before = this === state.host && message?.role === "user" && Array.isArray(chat?.children) ? new Set(chat.children) : undefined;
			const result = state.originalAdd.call(this, message, options);
			if (before && chat === this.chatContainer && Array.isArray(chat.children)) {
				const added = chat.children.filter((child) => !before.has(child) && !(child instanceof Spacer));
				// Skills can render two components. The first is the beginning of that prompt.
				if (added.length && typeof added[0].render === "function") state.targets.set(message, added[0]);
			}
			return result;
		};
		prototype.mountInteractiveTui = state.mount;
		prototype.addMessageToChat = state.add;
		globals[KEY] = state;
		record = state;
	}
	const state = record;
	const error = (): string | undefined => {
		if (state.owner !== owner || state.released) return "This /jump runtime is no longer active. Run /jump in the current session.";
		if (state.error) return state.error;
		if (!intact(state)) return "Another extension replaced /jump's bridge. Restart Pi without the conflicting wrapper.";
		if (!state.host) return "No observed transcript mount. Restart Pi with message-jump loaded at startup (a first /reload is insufficient).";
		return layoutError(state.host);
	};
	const unavailable = (item: JumpMessage): string | undefined => {
		const failure = error();
		if (failure) return failure;
		const target = state.targets.get(item.message);
		return target && state.host!.chatContainer.children.filter((child) => child === target).length === 1 ? undefined :
			"Not rendered: this prompt may be compacted away, empty/image-only, or loaded before /jump observed it. Select another prompt; /jump never rebuilds history.";
	};
	return {
		error, unavailable,
		jump(item) {
			const failure = unavailable(item);
			if (failure) return failure;
			const host = state.host!;
			try {
				// Refresh viewport metrics before clamping (resize and live output may change them).
				host.renderer.renderNow();
				const afterRender = unavailable(item);
				if (afterRender) return afterRender;
				if (host.transcriptScrollView.viewportHeight < 1) return "Transcript viewport has no visible rows. Enlarge the terminal and retry /jump.";
				const width = host.transcriptScrollView.getContentWidth(host.renderer.terminal.columns);
				if (!Number.isSafeInteger(width) || width < 1) return "Unsupported transcript width. Enlarge the terminal and retry /jump.";
				const target = state.targets.get(item.message)!;
				let row = 0;
				for (const child of host.documentContainer.children) {
					if (child === host.chatContainer) break;
					row += child.render(width).length;
				}
				for (const child of host.chatContainer.children) {
					if (child === target) break;
					row += child.render(width).length;
				}
				const afterMeasurement = unavailable(item);
				if (afterMeasurement) return afterMeasurement;
				host.transcriptScrollView.scrollTo(row, { disableFollow: true });
				host.renderer.requestRender();
				return undefined;
			} catch {
				return "Transcript measurement failed. Restart Pi with the standard layout and retry /jump.";
			}
		},
		release(quit) {
			if (state.owner !== owner || state.released) return;
			if (quit) { restore(state); state.targets = new WeakMap(); state.host = undefined; }
			else state.released = true; // Read-only capture survives reload/session replacement; no timers or UI hooks.
		},
	};
}
