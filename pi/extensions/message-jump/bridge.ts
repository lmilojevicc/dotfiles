import { InteractiveMode, VERSION } from "@earendil-works/pi-coding-agent";
import { Container, ScrollView, Spacer, VStack } from "@earendil-works/pi-tui";
import type { JumpMessage } from "./messages.ts";

const KEY = Symbol.for("dotfiles.message-jump.bridge.v1");
const globals = globalThis as unknown as Record<PropertyKey, unknown>;
const containerRender = Container?.prototype?.render;
const contentWidth = ScrollView?.prototype?.getContentWidth;
const scrollTo = ScrollView?.prototype?.scrollTo;
type Component = { render(width: number): string[] };
type Group = Component & { children: Component[] };
type Renderer = { mode: string; terminal: { columns: number }; layoutRoot: unknown; renderNow(): void; requestRender(): void };
type Host = {
	renderer: Renderer; documentContainer: Group; chatContainer: Group; fullscreenLayoutRoot: unknown;
	transcriptScrollView: Component & { children: Component[]; viewportHeight: number; contentHeight: number; scrollTop: number; getContentWidth(width: number): number; scrollTo(row: number, options: { disableFollow: true }): void };
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
	if (!renderer) return "Unsupported transcript layout: renderer required. Update the extension for this host and restart Pi.";
	if (renderer.mode !== "fullscreen") return "Use /settings → TUI mode → fullscreen, then run /jump. Regular mode scrollback belongs to the terminal.";
	const document = host.documentContainer;
	const chat = host.chatContainer;
	const scroll = host.transcriptScrollView;
	const unsupported = (capability: string) => `Unsupported transcript layout: ${capability}. Disable transcript/layout wrappers or update the extension for this host, then restart Pi; /jump will not guess a destination.`;
	if (!document || !chat || document.render !== containerRender || chat.render !== containerRender ||
		!Array.isArray(document.children) || document.children.filter((c) => c === chat).length !== 1 || !Array.isArray(chat.children) ||
		document.children.some((c) => typeof c?.render !== "function") || chat.children.some((c) => typeof c?.render !== "function")) {
		return unsupported("standard document/chat Containers required");
	}
	if (!scroll || !Array.isArray(scroll.children) || scroll.children.length !== 1 || scroll.children[0] !== document ||
		scroll.getContentWidth !== contentWidth || scroll.scrollTo !== scrollTo) return unsupported("single-document ScrollView with native getContentWidth/scrollTo required");
	if (typeof renderer.renderNow !== "function" || typeof renderer.requestRender !== "function") return unsupported("renderer renderNow/requestRender required");
	if (!Number.isSafeInteger(renderer.terminal?.columns) || renderer.terminal.columns < 1) return unsupported("positive integer terminal columns required");
	// This two-child root stretches the transcript across terminal columns. Reject narrower wrappers.
	const root = host.fullscreenLayoutRoot as { children?: Component[]; align?: string; gap?: number; entries?: { component: unknown; visible?: unknown }[] } | undefined;
	if (renderer.layoutRoot !== root || !(host.fullscreenLayoutRoot instanceof VStack) || !root || root.align !== "stretch" || root.gap !== 0 ||
		!Array.isArray(root.children) || root.children.length !== 2 || root.children[0] !== scroll || root.children[1] === scroll || typeof root.children[1]?.render !== "function" ||
		!Array.isArray(root.entries) || root.entries.length !== 2 || !root.entries[0] || !root.entries[1] ||
		root.entries.some((entry, i) => !entry || entry.component !== root.children![i] || entry.visible !== undefined)) {
		return unsupported("terminal-wide stretch VStack with transcript then dock required");
	}
	return undefined;
}

/** The only private seam: observe mount and user rendering, preserving host calls exactly once. */
export function installBridge(owner: symbol, version = VERSION): Bridge {
	const failed = (error: string): Bridge => ({ error: () => error, unavailable: () => error, jump: () => error, release() {} });
	// Version is diagnostic only: compatible upgrades are admitted by capabilities and observed layout.
	const prototype = InteractiveMode?.prototype as unknown as Prototype | undefined;
	if (!prototype || typeof prototype.mountInteractiveTui !== "function" || typeof prototype.addMessageToChat !== "function") {
		return failed(`Unsupported Pi interactive capabilities (${version}): callable mountInteractiveTui and addMessageToChat required. Update the extension for this host and restart Pi.`);
	}
	if (typeof Container !== "function" || typeof ScrollView !== "function" || typeof Spacer !== "function" || typeof VStack !== "function" ||
		typeof containerRender !== "function" || typeof contentWidth !== "function" || typeof scrollTo !== "function") {
		return failed(`Unsupported Pi TUI capabilities (${version}): native Container.render, ScrollView.getContentWidth/scrollTo, Spacer and VStack required. Repair Pi/TUI or update the extension, then restart Pi.`);
	}
	let record = globals[KEY] as RecordState | undefined;
	if (record) {
		if (record.prototype !== prototype || !intact(record)) return failed("Conflicting /jump bridge wrapper. Restart Pi without the conflicting extension.");
		if (!record.released) return failed("Another /jump extension runtime already owns this process. Load message-jump only once.");
		record.owner = owner;
		record.released = false;
	} else {
		const state: RecordState = {
			prototype, originalMount: prototype.mountInteractiveTui, originalAdd: prototype.addMessageToChat,
			mount: undefined!, add: undefined!, owner, released: false, targets: new WeakMap(),
		};
		state.mount = function (...args) {
			const result = state.originalMount.apply(this, args);
			const [tui, components] = args;
			if (state.host && state.host !== this) state.error = "Multiple interactive instances are unsupported. Restart Pi with one interactive session.";
			// Mount iterates components; dock component count is not part of transcript measurement.
			else if (tui !== this.renderer || !Array.isArray(components) || components[0] !== this.documentContainer || components.filter((c) => c === this.documentContainer).length !== 1 || components.some((c) => typeof c?.render !== "function")) state.error = "Unsupported Pi mount shape: renderer and document-first component array required. Use the standard interactive layout or update the extension, then restart Pi.";
			else state.host = this;
			return result;
		};
		state.add = function (...args) {
			const [message] = args;
			const chat = this.chatContainer;
			const before = this === state.host && message?.role === "user" && Array.isArray(chat?.children) ? new Set(chat.children) : undefined;
			const result = state.originalAdd.apply(this, args);
			if (before && chat === this.chatContainer && Array.isArray(chat.children)) {
				const added = chat.children.filter((child) => !before.has(child) && !(child instanceof Spacer));
				// Skills can render two components. The first is the beginning of that prompt.
				if (added.length && typeof added[0]?.render === "function") state.targets.set(message, added[0]);
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
				const metricsError = (): string | undefined => {
					const { viewportHeight, contentHeight, scrollTop } = host.transcriptScrollView;
					if (![viewportHeight, contentHeight, scrollTop].every((n) => Number.isSafeInteger(n) && n >= 0) || scrollTop > Math.max(0, contentHeight - viewportHeight)) {
						return "Invalid transcript scroll metrics. Use the standard layout or update the extension for this host, then restart Pi.";
					}
					return viewportHeight < 1 ? "Transcript viewport has no visible rows. Enlarge the terminal and retry /jump." : undefined;
				};
				const metrics = metricsError();
				if (metrics) return metrics;
				const width = host.transcriptScrollView.getContentWidth(host.renderer.terminal.columns);
				if (!Number.isSafeInteger(width) || width < 1 || width > host.renderer.terminal.columns) return "Unsupported transcript width. Use the standard layout, enlarge the terminal or update the extension for this host, then retry /jump.";
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
				if (!Number.isSafeInteger(row) || row < 0) return "Invalid transcript row measurement. Use the standard layout and retry /jump.";
				const afterMetrics = metricsError();
				if (afterMetrics) return afterMetrics;
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
