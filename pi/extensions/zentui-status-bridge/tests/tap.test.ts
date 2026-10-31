import assert from "node:assert/strict";
import test from "node:test";
import type { StatusBridge } from "../bridge.ts";
import { hasStatusTap, installStatusTap, type StatusUi } from "../tap.ts";

function recordingUi() {
	const calls: Array<[string, string | undefined]> = [];
	const ui: StatusUi = {
		setStatus(key, text) {
			calls.push([key, text]);
		},
	};
	return { ui, calls };
}

function recordingBridge(forward: (text: string | undefined) => string | undefined = (text) => text) {
	const seen: Array<[string, string | undefined]> = [];
	const bridge: StatusBridge = {
		handle(key, text) {
			seen.push([key, text]);
			return forward(text);
		},
		clear() {},
		snapshot() {
			return new Map();
		},
	};
	return { bridge, seen };
}

test("every publication passes through the bridge before the host setter", () => {
	const { ui, calls } = recordingUi();
	const { bridge, seen } = recordingBridge((text) => (text === undefined ? undefined : `bridged:${text}`));
	assert.equal(installStatusTap(ui, bridge), "installed");
	ui.setStatus("pi-lens-lsp", "LSP Active: tsserver");
	ui.setStatus("pi-lens-lsp", undefined);
	assert.deepEqual(seen, [
		["pi-lens-lsp", "LSP Active: tsserver"],
		["pi-lens-lsp", undefined],
	]);
	assert.deepEqual(calls, [
		["pi-lens-lsp", "bridged:LSP Active: tsserver"],
		["pi-lens-lsp", undefined],
	]);
	assert.equal(hasStatusTap(ui), true);
});

test("installing twice on the same ui is a no-op", () => {
	const { ui, calls } = recordingUi();
	const { bridge, seen } = recordingBridge();
	assert.equal(installStatusTap(ui, bridge), "installed");
	assert.equal(installStatusTap(ui, bridge), "already");
	ui.setStatus("usage", "38%");
	assert.equal(seen.length, 1);
	assert.deepEqual(calls, [["usage", "38%"]]);
});

test("the tap keeps the receiver the caller used", () => {
	const calls: Array<[unknown, string, string | undefined]> = [];
	const ui: StatusUi & { token: string } = {
		token: "ui",
		setStatus(this: { token: string }, key, text) {
			calls.push([this.token, key, text]);
		},
	};
	const { bridge } = recordingBridge();
	installStatusTap(ui, bridge);
	ui.setStatus("usage", "38%");
	assert.deepEqual(calls, [["ui", "usage", "38%"]]);
});

test("an accessor, a frozen object or a missing method is left alone", () => {
	const accessor = {
		get setStatus() {
			return () => {};
		},
	};
	assert.equal(installStatusTap(accessor as StatusUi, recordingBridge().bridge), "unsupported");

	const frozen = Object.freeze({ setStatus: () => {} }) as StatusUi;
	assert.equal(installStatusTap(frozen, recordingBridge().bridge), "unsupported");

	const locked = {};
	Object.defineProperty(locked, "setStatus", { value: () => {}, writable: false, configurable: false });
	assert.equal(installStatusTap(locked as StatusUi, recordingBridge().bridge), "unsupported");

	assert.equal(installStatusTap({} as StatusUi, recordingBridge().bridge), "unsupported");
});

test("a tap that ends up inside a foreign wrapper is re-installed outside and bridges once", () => {
	const { ui, calls } = recordingUi();
	const { bridge, seen } = recordingBridge((text) => (text === undefined ? undefined : `bridged:${text}`));
	installStatusTap(ui, bridge);

	// Simulate Zentui installing its wrapper afterwards (hiding this key by
	// forwarding `undefined`, which is what its visibility policy does).
	const tap = ui.setStatus;
	const hiding = {
		setStatus(key: string, text: string | undefined) {
			tap(key, key === "hidden-key" ? undefined : text);
		},
	};
	ui.setStatus = hiding.setStatus;
	assert.equal(hasStatusTap(ui), false);
	assert.equal(installStatusTap(ui, bridge), "installed");
	assert.equal(hasStatusTap(ui), true);

	seen.length = 0;
	calls.length = 0;
	ui.setStatus("hidden-key", "LSP Active: tsserver");
	// One bridge call, then the foreign wrapper hides the copy it receives.
	assert.deepEqual(seen, [["hidden-key", "LSP Active: tsserver"]]);
	assert.deepEqual(calls, [["hidden-key", undefined]]);
});

test("the double-bridge guard also holds for a nested publication from a handler", () => {
	const { ui, calls } = recordingUi();
	let nested = false;
	const seen: Array<[string, string | undefined]> = [];
	const bridge: StatusBridge = {
		handle(key, text) {
			seen.push([key, text]);
			if (!nested && text !== undefined) {
				nested = true;
				ui.setStatus(`${key}-nested`, text);
			}
			return text;
		},
		clear() {},
		snapshot() {
			return new Map();
		},
	};
	installStatusTap(ui, bridge);
	ui.setStatus("outer", "value");
	// The re-entrant call is not bridged (it cannot recurse), but it still reaches the host
	// first, because it happens inside the bridge handler before the outer value is forwarded.
	assert.deepEqual(seen, [["outer", "value"]]);
	assert.deepEqual(calls, [
		["outer-nested", "value"],
		["outer", "value"],
	]);
});
