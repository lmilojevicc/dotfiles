import assert from "node:assert/strict";
import test from "node:test";
import {
	createStatusBridge,
	fitStatusText,
	targetKeyFor,
	ZENTUI_CAPABILITY_EVENT,
	ZENTUI_VARIABLE_EVENT,
} from "../bridge.ts";
import { DEFAULT_CONFIG, type BridgeConfig } from "../config.ts";

interface Emission {
	channel: string;
	data: unknown;
}

/**
 * Minimal Zentui stand-in: answers `zentui:variable-capability` for the keys it
 * is told to demand, exactly like Zentui's `CustomVariables` handler does.
 */
function fakeBus(demanded: string[] | "all" = "all") {
	const emissions: Emission[] = [];
	const bus = {
		emitted: emissions,
		emit(channel: string, data: unknown) {
			emissions.push({ channel, data });
			if (channel !== ZENTUI_CAPABILITY_EVENT) return;
			const capability = data as { key?: string; supported: boolean; active: boolean; version?: number };
			const active =
				demanded === "all" || (capability.key !== undefined && demanded.includes(capability.key));
			capability.supported = active;
			capability.active = active;
			if (active) capability.version = 1;
		},
		variables() {
			return emissions
				.filter((entry) => entry.channel === ZENTUI_VARIABLE_EVENT)
				.map((entry) => entry.data as { key: string; text: string | undefined });
		},
		probes() {
			return emissions.filter((entry) => entry.channel === ZENTUI_CAPABILITY_EVENT);
		},
	};
	return bus;
}

function bridgeWith(bus: ReturnType<typeof fakeBus>, overrides: Partial<BridgeConfig> = {}) {
	let config: BridgeConfig = { ...DEFAULT_CONFIG, ...overrides };
	return {
		bridge: createStatusBridge({ events: bus, getConfig: () => config }),
		setConfig(next: Partial<BridgeConfig>) {
			config = { ...config, ...next };
		},
	};
}

test("an active Zentui receives the value and the host copy is suppressed", () => {
	const bus = fakeBus();
	const { bridge } = bridgeWith(bus);
	assert.equal(bridge.handle("pi-lens-lsp", "LSP Active: tsserver"), undefined);
	assert.deepEqual(bus.variables(), [{ key: "pi-lens-lsp", text: "LSP Active: tsserver" }]);
	assert.deepEqual(bridge.snapshot().get("pi-lens-lsp"), {
		targetKey: "pi-lens-lsp",
		text: "LSP Active: tsserver",
	});
});

test("suppressHostStatus=false keeps the footer copy", () => {
	const bus = fakeBus();
	const { bridge } = bridgeWith(bus, { suppressHostStatus: false });
	assert.equal(bridge.handle("usage", "claude 38% used"), "claude 38% used");
	assert.deepEqual(bus.variables(), [{ key: "usage", text: "claude 38% used" }]);
});

test("an inactive Zentui publishes nothing and the host keeps the status", () => {
	const bus = fakeBus(["other-key"]);
	const { bridge } = bridgeWith(bus);
	assert.equal(bridge.handle("pi-lens-lsp", "LSP Inactive"), "LSP Inactive");
	assert.deepEqual(bus.variables(), []);
	assert.equal(bridge.snapshot().size, 0);
});

test("a value already rendered is not republished, and swallowing still holds", () => {
	const bus = fakeBus();
	const { bridge } = bridgeWith(bus);
	bridge.handle("usage", "claude 38% used");
	assert.equal(bridge.handle("usage", "claude 38% used"), undefined);
	assert.equal(bus.variables().length, 1);
});

test("undefined and empty text publish a removal", () => {
	const bus = fakeBus();
	const { bridge } = bridgeWith(bus);
	bridge.handle("usage", "claude 38% used");
	bridge.handle("usage", undefined);
	bridge.handle("usage", "");
	assert.deepEqual(bus.variables(), [
		{ key: "usage", text: "claude 38% used" },
		{ key: "usage", text: undefined },
	]);
	assert.equal(bridge.snapshot().size, 0);
});

test("keys outside include, inside exclude, or invalid pass through without a probe", () => {
	const bus = fakeBus();
	const { bridge } = bridgeWith(bus, { include: ["pi-lens-lsp"] });
	assert.equal(bridge.handle("usage", "38%"), "38%");
	assert.equal(bridge.handle("pi-lens lsp", "38%"), "38%");
	assert.equal(bridge.handle("", "38%"), "38%");
	assert.equal(bridge.handle("x".repeat(65), "38%"), "38%");
	assert.deepEqual(bus.probes(), []);

	const excluded = bridgeWith(bus, { exclude: ["pi-lens-lsp"] });
	assert.equal(excluded.bridge.handle("pi-lens-lsp", "LSP Inactive"), "LSP Inactive");
	assert.deepEqual(bus.probes(), []);
});

test("keyPrefix renames the published key and drops the previous one when it changes", () => {
	const bus = fakeBus("all");
	const { bridge, setConfig } = bridgeWith(bus);
	bridge.handle("pi-lens-lsp", "LSP Inactive");
	setConfig({ keyPrefix: "status/" });
	assert.equal(bridge.handle("pi-lens-lsp", "LSP Inactive"), undefined);
	assert.deepEqual(bus.variables(), [
		{ key: "pi-lens-lsp", text: "LSP Inactive" },
		{ key: "pi-lens-lsp", text: undefined },
		{ key: "status/pi-lens-lsp", text: "LSP Inactive" },
	]);
	assert.equal(bridge.snapshot().get("pi-lens-lsp")?.targetKey, "status/pi-lens-lsp");
});

test("multi-line and over-long status text is flattened and truncated to the protocol bound", () => {
	const bus = fakeBus();
	const { bridge } = bridgeWith(bus);
	bridge.handle("usage", "line one\nline two\tend");
	assert.deepEqual(bus.variables(), [{ key: "usage", text: "line one line two end" }]);

	const long = "x".repeat(400);
	bridge.handle("other", long);
	const published = bus.variables().at(-1);
	assert.equal(published?.text?.length, 256);
	assert.ok(published?.text?.endsWith("…"));
});

test("clear removes every published key exactly once", () => {
	const bus = fakeBus();
	const { bridge } = bridgeWith(bus);
	bridge.handle("a", "one");
	bridge.handle("b", "two");
	bus.emitted.length = 0;
	bridge.clear();
	assert.deepEqual(bus.variables(), [
		{ key: "a", text: undefined },
		{ key: "b", text: undefined },
	]);
	assert.equal(bridge.snapshot().size, 0);
	bridge.clear();
	assert.deepEqual(bus.variables().length, 2);
});

test("a throwing bus leaves the host copy in place", () => {
	const bus = fakeBus();
	const bridge = createStatusBridge({
		events: {
			emit(channel, data) {
				if (channel === ZENTUI_VARIABLE_EVENT) throw new Error("bus down");
				bus.emit(channel, data);
			},
		},
		getConfig: () => ({ ...DEFAULT_CONFIG }),
	});
	// The probe answers "active", the publish throws: the host keeps the status.
	assert.equal(bridge.handle("usage", "38%"), "38%");
	assert.equal(bridge.snapshot().size, 0);
});

test("targetKeyFor and fitStatusText are pure lookups", () => {
	const config: BridgeConfig = { ...DEFAULT_CONFIG, keyPrefix: "status/", include: ["usage"] };
	assert.equal(targetKeyFor("usage", config), "status/usage");
	assert.equal(targetKeyFor("other", config), undefined);
	assert.equal(fitStatusText("short", 256), "short");
	assert.equal(fitStatusText("  padded  ", 256), "padded");
	assert.equal(fitStatusText("abcdef", 4), "abc…");
});
