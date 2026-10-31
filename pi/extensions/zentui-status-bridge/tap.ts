import type { StatusBridge } from "./bridge.ts";

export const TAP_MARKER: symbol = Symbol.for("pi.zentui-status-bridge.tap");
export const TAP_PREDECESSOR: symbol = Symbol.for("pi.zentui-status-bridge.predecessor");

export type StatusUi = {
	setStatus(key: string, text: string | undefined): void;
};

export type TapResult = "installed" | "already" | "unsupported";

type StatusSetter = (this: unknown, key: string, text: string | undefined) => void;

type TapFunction = StatusSetter & Record<symbol, unknown>;

/**
 * Guards against bridging twice when a tap ends up inside another tap.
 *
 * Zentui installs its own `setStatus` wrapper at `session_start` so it can hide
 * keys by `extensionStatuses.visibility`. To see values a hidden key would lose,
 * this tap must be *outside* Zentui's wrapper. When load order puts it inside,
 * the next event re-installs it outside; the older tap stays in the chain and
 * must then pass through without publishing a second time — Zentui forwards
 * `undefined` for a hidden key, and a second publish would erase the value the
 * outer tap just sent.
 */
let depth = 0;

function isTap(value: unknown): value is TapFunction {
	return typeof value === "function" && (value as TapFunction)[TAP_MARKER] === true;
}

/**
 * Wrap `ui.setStatus` so every extension's publication reaches `bridge` before
 * the host (and Zentui's own wrapper) see it. Idempotent per `ui` object: an
 * already-installed tap returns `"already"`.
 */
export function installStatusTap(ui: StatusUi, bridge: StatusBridge): TapResult {
	const descriptor = Object.getOwnPropertyDescriptor(ui, "setStatus");
	if (
		!descriptor ||
		!("value" in descriptor) ||
		typeof descriptor.value !== "function" ||
		!descriptor.writable ||
		!descriptor.configurable
	) {
		// Accessors, inherited methods, frozen objects and bound lookups are left alone.
		return "unsupported";
	}
	const current = descriptor.value as TapFunction;
	if (isTap(current)) return "already";

	const predecessor = descriptor.value as StatusSetter;
	const tap: TapFunction = function (this: unknown, key: string, text: string | undefined) {
		if (depth > 0) return predecessor.apply(this, [key, text]);
		depth += 1;
		try {
			return predecessor.apply(this, [key, bridge.handle(key, text)]);
		} finally {
			depth -= 1;
		}
	} as TapFunction;
	tap[TAP_MARKER] = true;
	tap[TAP_PREDECESSOR] = predecessor;

	Object.defineProperty(ui, "setStatus", { ...descriptor, value: tap });
	return "installed";
}

/** Whether `ui.setStatus` is currently this extension's tap (re-install detection). */
export function hasStatusTap(ui: StatusUi): boolean {
	return isTap(Object.getOwnPropertyDescriptor(ui, "setStatus")?.value);
}
