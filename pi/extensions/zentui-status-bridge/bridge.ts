import { isBridgeKey, type BridgeConfig } from "./config.ts";

/** Zentui custom-value protocol v1 (`pi-zentui/docs/configuration.md`). */
export const ZENTUI_CAPABILITY_EVENT = "zentui:variable-capability";
export const ZENTUI_VARIABLE_EVENT = "zentui:variable";

export interface BridgeEvents {
	emit(channel: string, data: unknown): void;
}

export interface PublishedStatus {
	targetKey: string;
	text: string | undefined;
}

export interface StatusBridge {
	/**
	 * Bridge one `ctx.ui.setStatus(key, text)` publication.
	 *
	 * Returns the text the host surface should receive: the original text when
	 * Zentui is absent, inactive or not demanding the value, and `undefined`
	 * (host copy removed) once Zentui renders it and `suppressHostStatus` is on.
	 */
	handle(statusKey: string, text: string | undefined): string | undefined;
	/** Remove every value this bridge published (session end or reload). */
	clear(): void;
	snapshot(): ReadonlyMap<string, PublishedStatus>;
}

export function targetKeyFor(statusKey: string, config: BridgeConfig): string | undefined {
	if (!isBridgeKey(statusKey)) return undefined;
	if (config.exclude.includes(statusKey)) return undefined;
	if (config.include.length > 0 && !config.include.includes(statusKey)) return undefined;
	const targetKey = `${config.keyPrefix}${statusKey}`;
	return targetKey.length <= 64 ? targetKey : undefined;
}

export function fitStatusText(text: string, maxTextLength: number): string {
	const flat = text.replace(/[\r\n\t\f\v]+/g, " ").trim();
	if (flat.length <= maxTextLength) return flat;
	return `${flat.slice(0, Math.max(0, maxTextLength - 1))}…`;
}

function probe(
	events: BridgeEvents,
	targetKey: string,
): boolean {
	const capability = { supported: false, active: false, key: targetKey };
	try {
		events.emit(ZENTUI_CAPABILITY_EVENT, capability);
	} catch {
		return false;
	}
	// Zentui answers synchronously by defining `active` on this object. Without
	// Zentui, or without template demand for the key, the host keeps the value.
	return capability.active === true;
}

function publish(events: BridgeEvents, key: string, text: string | undefined): boolean {
	try {
		events.emit(ZENTUI_VARIABLE_EVENT, { key, text });
		return true;
	} catch {
		return false;
	}
}

/**
 * Turn arbitrary extension statuses into Zentui custom values.
 *
 * Every supported extension publishes through `ctx.ui.setStatus`. Zentui
 * renders custom values only from its own event protocol, so this bridge
 * re-publishes each status key under the same (or a prefixed) key and, when
 * Zentui accepted it, removes the host copy so the value renders in the editor
 * border instead of the footer.
 */
export function createStatusBridge(options: {
	events: BridgeEvents;
	getConfig: () => BridgeConfig;
}): StatusBridge {
	const published = new Map<string, PublishedStatus>();

	return {
		handle(statusKey, text) {
			const config = options.getConfig();
			const targetKey = targetKeyFor(statusKey, config);
			if (!targetKey) return text;

			const previous = published.get(statusKey);
			if (!probe(options.events, targetKey)) {
				// No Zentui, or the current template does not demand this key: the
				// host surface keeps (or regains) the status on the next publication.
				published.delete(statusKey);
				return text;
			}

			const nextText =
				text === undefined || text.length === 0 ? undefined : fitStatusText(text, config.maxTextLength);

			if (previous && previous.targetKey !== targetKey) {
				publish(options.events, previous.targetKey, undefined);
				published.delete(statusKey);
			}

			if (published.get(statusKey)?.text !== nextText) {
				if (!publish(options.events, targetKey, nextText)) return text;
				if (nextText === undefined) published.delete(statusKey);
				else published.set(statusKey, { targetKey, text: nextText });
			}

			return config.suppressHostStatus ? undefined : text;
		},
		clear() {
			for (const entry of published.values()) publish(options.events, entry.targetKey, undefined);
			published.clear();
		},
		snapshot() {
			return new Map(published);
		},
	};
}
