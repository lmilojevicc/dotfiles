import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG, isBridgeKey, readBridgeConfig } from "../config.ts";

function withConfig(
	contents: string | undefined,
	run: (path: string, notices: string[]) => void,
): void {
	const root = mkdtempSync(join(tmpdir(), "status-bridge-config-"));
	try {
		const path = join(root, "zentui-status-bridge.json");
		const notices: string[] = [];
		if (contents !== undefined) writeFileSync(path, contents);
		run(path, notices);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

test("a missing file bridges every key, warns nothing and is never created", () => {
	withConfig(undefined, (path, notices) => {
		assert.deepEqual(readBridgeConfig((message) => notices.push(message), path), DEFAULT_CONFIG);
		assert.deepEqual(notices, []);
		assert.equal(existsSync(path), false);
	});
});

test("an empty object is the default configuration", () => {
	withConfig("{}", (path, notices) => {
		assert.deepEqual(readBridgeConfig((message) => notices.push(message), path), DEFAULT_CONFIG);
		assert.deepEqual(notices, []);
	});
});

test("include and exclude are trimmed, deduplicated by use and validated", () => {
	withConfig(
		JSON.stringify({ include: [" pi-lens-lsp ", "usage"], exclude: ["usage"], keyPrefix: "status/" }),
		(path, notices) => {
			assert.deepEqual(readBridgeConfig((message) => notices.push(message), path), {
				...DEFAULT_CONFIG,
				include: ["pi-lens-lsp", "usage"],
				exclude: ["usage"],
				keyPrefix: "status/",
			});
			assert.deepEqual(notices, []);
		},
	);
});

test("invalid entries are reported and skipped without discarding the valid ones", () => {
	withConfig(
		JSON.stringify({ include: ["pi-lens-lsp", "bad key", "", 42], exclude: "usage" }),
		(path, notices) => {
			const config = readBridgeConfig((message) => notices.push(message), path);
			assert.deepEqual(config.include, ["pi-lens-lsp"]);
			assert.deepEqual(config.exclude, []);
			assert.equal(notices.length, 4, notices.join("\n"));
		},
	);
});

test("malformed JSON and a non-object root fall back to the defaults with one warning", () => {
	for (const contents of ["", "{bad", "null", "[]", "true", "42", '"text"']) {
		withConfig(contents, (path, notices) => {
			assert.deepEqual(readBridgeConfig((message) => notices.push(message), path), DEFAULT_CONFIG);
			assert.equal(notices.length, 1, contents);
			assert.ok(notices[0].includes(path));
		});
	}
});

test("keyPrefix rejects whitespace, over-length values and non-strings", () => {
	for (const keyPrefix of ["status bridge", "/ status", 42, "x".repeat(65)]) {
		withConfig(JSON.stringify({ keyPrefix }), (path, notices) => {
			assert.equal(readBridgeConfig((message) => notices.push(message), path).keyPrefix, "");
			assert.equal(notices.length, 1, JSON.stringify(keyPrefix));
		});
	}
	for (const keyPrefix of ["status/", "", "bridge:", "a.b_c-d/e"]) {
		withConfig(JSON.stringify({ keyPrefix }), (path, notices) => {
			assert.equal(readBridgeConfig((message) => notices.push(message), path).keyPrefix, keyPrefix);
			assert.deepEqual(notices, []);
		});
	}
});

test("suppressHostStatus and maxTextLength are validated against their bounds", () => {
	withConfig(JSON.stringify({ suppressHostStatus: false, maxTextLength: 64 }), (path, notices) => {
		assert.deepEqual(readBridgeConfig((message) => notices.push(message), path), {
			...DEFAULT_CONFIG,
			suppressHostStatus: false,
			maxTextLength: 64,
		});
		assert.deepEqual(notices, []);
	});
	for (const [field, value] of [
		["suppressHostStatus", "yes"],
		["maxTextLength", 0],
		["maxTextLength", 257],
		["maxTextLength", 1.5],
		["maxTextLength", "256"],
	] as const) {
		withConfig(JSON.stringify({ [field]: value }), (path, notices) => {
			const config = readBridgeConfig((message) => notices.push(message), path);
			assert.equal(config[field], DEFAULT_CONFIG[field], `${field}=${JSON.stringify(value)}`);
			assert.equal(notices.length, 1);
		});
	}
});

test("a keyPrefix that pushes a key past the protocol limit drops that key with a warning", () => {
	withConfig(
		JSON.stringify({ keyPrefix: "p".repeat(54), include: ["short", "pi-lens-lsp"] }),
		(path, notices) => {
			const config = readBridgeConfig((message) => notices.push(message), path);
			assert.deepEqual(config.include, ["short"]);
			assert.equal(notices.length, 1);
			assert.match(notices[0], /pi-lens-lsp/);
		},
	);
});

test("underscore-prefixed example keys are inert", () => {
	withConfig(
		JSON.stringify({ _examples: { include: ["nope"] }, include: ["usage"] }),
		(path, notices) => {
			assert.deepEqual(readBridgeConfig((message) => notices.push(message), path).include, ["usage"]);
			assert.deepEqual(notices, []);
		},
	);
});

test("isBridgeKey enforces the Zentui key shape", () => {
	for (const key of ["pi-lens-lsp", "usage", "a", "a.b:c/d_e-f", "x".repeat(64)]) {
		assert.equal(isBridgeKey(key), true, key);
	}
	for (const key of ["", "a b", "a\tb", "a/b c", "-lead", "x".repeat(65)]) {
		assert.equal(isBridgeKey(key), false, key);
	}
});
